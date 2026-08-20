# 01. jobject 在 JVM 内部怎么存的?— JNI Handle 系统

> **前置依赖**:[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):JNI_CreateJavaVM 与函数表在启动序列里点亮;[17-threads/01 — JVM 里有多少种线程?— Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):JavaThread 的"线程行李"里挂着本地引用块;[06-oops/01 — 对象头 — 一个 word,五种身份](openjdk/vol-02/06-oops/01-markoop-oopdesc.md):被引用的 oop 在 GC 里会移动
> → **后续**:[27-jni/02 — JNI GetIntField 正常 200 cycles → 怎么做到 30 cycles?— JNI Fast Path](02-jni-fast-path.md)
> 关联域: 25-gc(根集处理与弱引用清除)、09-memory-core(VM 内部的 Handle/HandleMark 是另一套引用)、31-unsafe(裸 oop 通道)

native 代码里拿到的 `jobject` 看起来像一个指针。但 GC 会移动对象——年轻代复制、Full GC 压缩——如果 jobject 是裸 oop 指针，一次 GC 后它就悬空了。那 jobject 到底是什么？为什么 JNI 把引用分成本地、全局、弱全局三种，而不是一套存储加三种权限？

本篇要回答的核心问题:

1. jobject 到底是对象的地址还是间接引用？
2. 本地引用、全局引用、弱全局引用是不是同一套存储的三种模式？
3. 本地引用在 native 返回后自动失效——这个"自动"是怎么实现的？

答案会反复落到一句话:**jobject 是间接引用（handle），指向一个存放 oop 的槽。GC 移动对象时更新槽里的 oop，handle 本身不变。三层引用底层使用了两套完全不同的存储，不是一套存储的三种模式。**

---

## 1. 开场困惑——"jobject 不可能是裸 oop 指针"

如果 jobject 是裸 oop 指针，那么下面这段 JNI 代码在 GC 前后就会出现问题:

```c
jobject ref = (*env)->GetObjectArrayElement(env, arr, 0);
// 此时 GC 可能发生，对象被移动
// 如果 ref 是裸 oop，现在它指向旧地址，已经悬空
```

G1 的年轻代 GC 做 evacuation 时会把活对象从 CSet 复制到幸存区，Full GC 还会压缩整个堆的布局。任何一个暂停都可能让对象的物理地址改变。所以 JVM 必须保证:native 代码持有的"引用"在 GC 后仍然有效——而这个保证不能靠"告诉 native 代码地址变了"来实现，因为 C 代码没有统一的"地址更新回调"。

JVM 的解决方案是: **jobject 不是 oop 地址，而是指向一个存放 oop 的槽的地址。** GC 移动对象时，由 GC 遍历所有根（包括这些槽），把槽里的 oop 更新为新地址。jobject 本身不变，变的是槽里的内容。

但这只是"总体方案"，往下有更具体的差异: 不同生命周期的引用存到了不同的地方。本地引用存在线程本地的 JNIHandleBlock 链里，靠 `_top` 清零整体失效；全局和弱全局引用存在全局的 OopStorage 仓库里，靠显式 API 分配/释放。它们不是同一套存储的三种模式。

---

## 2. 两个朴素方案为什么都不对

### 方案一:jobject = 裸 oop 指针

直觉上，既然 native 代码要通过指针操作对象，那把对象地址直接给 native 就是最直接的方式。但这在 GC 移动对象后就失效了。

JVM 的 GC 确实会遍历根来更新引用——但"遍历根"的前提是 JVM 知道所有根在哪。如果 jobject 直接就是裸 oop，那 native 代码可能把它存在局部变量、寄存器、甚至堆上，GC 在 STW 时无法枚举所有 native 的"根"位置。只有把引用放进 JVM 管理的槽（handle），GC 才能可靠地找到并更新它。

所以间接引用不是"额外开销"，而是"让 GC 可追踪"的必要设计。

### 方案二:本地引用逐个释放

另一个直觉是:既然本地引用有 `DeleteLocalRef` 函数，那每次分配一个引用、native 返回前逐个释放。但 JNI 规范的"本地引用在 native 返回后自动失效"意味着绝大多数 native 方法根本不需要显式释放——JVM 在 native 返回时**整体重置**了 `_top` 指针，比逐个释放快一个量级。如果每个 native 方法都要逐个调用 `DeleteLocalRef`，JNI 的性能负担会翻几倍。

---

## 3. 本地引用——线程行李里的 JNIHandleBlock 链

### 存放:每线程一个 handle 块链

`JavaThread` 挂着一串 `JNIHandleBlock`(thread 字段 `_active_handles`)。每个块的结构(jniHandles.hpp:132-151):

```cpp
// jniHandles.hpp:136-151(截取核心,逐字)
enum SomeConstants {
  block_size_in_oops  = 32                    // Number of handles per handle block
};

oop             _handles[block_size_in_oops]; // The handles
int             _top;                         // Index of next unused handle
JNIHandleBlock* _next;                        // Link to next block

// The following instance variables are only used by the first block in a chain.
JNIHandleBlock* _last;                        // Last block in use
JNIHandleBlock* _pop_frame_link;              // Block to restore on PopLocalFrame call
oop*            _free_list;                   // Handle free list
int             _allocate_before_rebuild;     // Number of blocks to allocate before rebuilding free list
```

每块 32 个 oop 槽，`_top` 是已用计数。`_last`、`_pop_frame_link`、`_free_list`、`_allocate_before_rebuild` 只在链首块被使用——字段在所有块里都存在，但链尾块不用（源码注释说，为避免两套块类型增加代码复杂度，空间开销可忽略）。

### 分配:四段优先级

`JNIHandles::make_local`(jniHandles.cpp:52-61)把 oop 塞进当前线程的块链:

```cpp
// jniHandles.cpp:52-61(截取核心,逐字)
jobject JNIHandles::make_local(oop obj) {
  if (obj == NULL) {
    return NULL;                // ignore null handles
  } else {
    Thread* thread = Thread::current();
    assert(oopDesc::is_oop(obj), "not an oop");
    assert(!current_thread_in_native(), "must not be in native");
    return thread->active_handles()->allocate_handle(obj);
  }
}
```

null 输入直接返回 null——`jobject` 的 null 规范化（resolve_impl 注释说"Construction of jobjects canonicalize a null value into a null jobject"，jniHandles.inline.hpp:61-62）。两个断言:只收合法 oop；调用者必须已离开 native 状态。

`allocate_handle`(jniHandles.cpp:481-546)按四段优先级找空位:

1. **`_last` 块的末尾槽**（:512-516）：`_last->_top < block_size_in_oops` 时，`&(_last->_handles)[_last->_top++]` 直接取用。这是最热路径——大多数方法只用几个本地引用，一个块就够了，`_last` 就是链首块。
2. **free list**（:519-524）：`rebuild_free_list` 扫描全链时把被清空（`*handle == NULL`）的槽串成的单链表（`DeleteLocalRef` 只负责写 NULL，串链动作发生在 rebuild 时），取用时 `_free_list = (oop*) *_free_list` 出链。这是"删了又建"时的复用路径。
3. **`_last->_next` 未用块**（:526-530）：已有后续块但还没用上，`_last = _last->_next` 后递归重试。
4. **重建 free list 或追加新块**（:532-545）：`_allocate_before_rebuild == 0` 时全链扫描重建 free list（`rebuild_free_list`）；否则追加一个新块并把 `_allocate_before_rebuild` 减一。

`rebuild_free_list`(jniHandles.cpp:548-575)扫描全链，把 `_handles[i] == NULL` 的槽串成 free list，然后按空闲比例计算 `_allocate_before_rebuild`:

```cpp
// jniHandles.cpp:566-574(截取核心,逐字)
// Heuristic: if more than half of the handles are free we rebuild next time
// as well, otherwise we append a corresponding number of new blocks before
// attempting a free list rebuild again.
int total = blocks * block_size_in_oops;
int extra = total - 2*free;
if (extra > 0) {
  _allocate_before_rebuild = (extra + block_size_in_oops - 1) / block_size_in_oops;
}
```

启发式:如果空闲槽超过一半，下一次直接建 free list 就好；否则计算出缺额，换算成"再分配几个块后重建 free list"，避免每次都全链扫描。

### 失效:整体重置 _top，不是逐个释放

native 方法返回时，解释器和编译代码不逐个释放 handle，而是直接把 `_top` 清零:

```cpp
// templateInterpreterGenerator_x86.cpp:1164-1166(截取核心,逐字)
// reset handle block
__ movptr(t, Address(thread, JavaThread::active_handles_offset()));
__ movl(Address(t, JNIHandleBlock::top_offset_in_bytes()), (int32_t)NULL_WORD);
```

编译代码的 native wrapper 同样处理（sharedRuntime_x86_64.cpp:2652-2655，reset handle block，且仅在 `is_critical_native` 为假时执行——critical native 跳过 reset）。效果: 一次 native 调用里的所有本地引用整体失效——块里的旧 oop 变成垃圾，GC 的 `oops_do`(jniHandles.cpp:453-478)只遍历 `_top` 以内的槽，所以旧值也不会被当成根。**JNI 规范"本地引用在 native 返回后无效"就是这样一行 movl 实现的**——比逐个释放快一个量级。

### 参数也是本地引用

Java 传给 native 的参数如果是 oop 类型，传递的不是裸 oop 而是 handle。编译代码的 native wrapper 走 `object_move`(sharedRuntime_x86_64.cpp:1157-1228,注释 "An oop arg. Must pass a handle not the oop itself")，把参数槽的地址当作 handle 传过去。解释器经签名处理器 `pass_object`(interpreterRT_x86_64.cpp:214-292)用 `lea` 取参数槽地址。GC 靠 oop map 识别这些栈上的引用槽，在 GC 时更新它们。所以参数 handle 在调用结束、帧失效后自然作废，解释了为什么不能把参数当全局 handle 传给 `DeleteGlobalRef`。

### Push/Pop:显式的帧边界

`PushLocalFrame`(jni.cpp:742-761)和 `PopLocalFrame`(jni.cpp:764-785)是显式版本:

- Push: `new_handles->set_pop_frame_link(old_handles); thread->set_active_handles(new_handles)`——旧块挂到新块的 `_pop_frame_link`。
- Pop: 把结果先解析成 VM 内部 `Handle` 防 GC，恢复旧块，把旧块整链 `release_block` 回池。

`_pop_frame_link` 这个字段（jniHandles.hpp:148）就是为它准备的。

---

## 4. 全局与弱全局引用——OopStorage 仓库

本地引用随线程走、随调用失效。跨调用持久的引用需要另找存放处——**OopStorage**。`JNIHandles::initialize`(jniHandles.cpp:203-210)建两个仓库:

```cpp
// jniHandles.cpp:203-210(截取核心,逐字)
void JNIHandles::initialize() {
  _global_handles = new OopStorage("JNI Global",
                                   JNIGlobalAlloc_lock,
                                   JNIGlobalActive_lock);
  _weak_global_handles = new OopStorage("JNI Weak",
                                        JNIWeakAlloc_lock,
                                        JNIWeakActive_lock);
}
```

### 全局引用:显式分配/释放

`make_global`(jniHandles.cpp:101-122)从 OopStorage 仓库里要一块，写入 oop，返回地址:

```cpp
// jniHandles.cpp:101-122(截取核心,逐字)
jobject JNIHandles::make_global(Handle obj, AllocFailType alloc_failmode) {
  assert(!Universe::heap()->is_gc_active(), "can't extend the root set during GC");
  assert(!current_thread_in_native(), "must not be in native");
  jobject res = NULL;
  if (!obj.is_null()) {
    assert(oopDesc::is_oop(obj()), "not an oop");
    oop* ptr = global_handles()->allocate();
    if (ptr != NULL) {
      assert(*ptr == NULL, "invariant");
      NativeAccess<>::oop_store(ptr, obj());
      res = reinterpret_cast<jobject>(ptr);
    } else {
      report_handle_allocation_failure(alloc_failmode, "global");
    }
  }
  ...
```

两个断言:GC 进行中不能扩根集；必须已离开 native 状态。

`destroy_global`(jniHandles.cpp:168-175):先把槽写 NULL，再 `global_handles()->release(ptr)` 归还条目。

### 弱全局引用:地址 +1 的 tag 位

`make_weak_global`(jniHandles.cpp:125-146)几乎一样，但两个差异:

- 写入用 `NativeAccess<ON_PHANTOM_OOP_REF>`——phantom 语义，GC 不强引用它；
- 返回前**给地址加 1**:

```cpp
// jniHandles.cpp:132-145(截取核心,逐字)
oop* ptr = weak_global_handles()->allocate();
if (ptr != NULL) {
  assert(*ptr == NULL, "invariant");
  NativeAccess<ON_PHANTOM_OOP_REF>::oop_store(ptr, obj());
  char* tptr = reinterpret_cast<char*>(ptr) + weak_tag_value;
  res = reinterpret_cast<jobject>(tptr);
}
```

`weak_tag_size = 1`、`weak_tag_alignment = 2`、`weak_tag_value = 1`(jniHandles.hpp:63-66): OopStorage 条目按 2 字节对齐，低位恒 0，最低位正好空出来做标记。于是 `is_jweak(handle)` 就是一次位测试(jniHandles.inline.hpp:34-38): `(uintptr_t)handle & 1`。**弱全局引用的"弱"不靠单独的数据结构，靠一个 tag 位 + phantom 读写通道**。GC 的 `weak_oops_do` 遍历仓库，`is_alive` 为 false 的条目直接写 NULL。

### OopStorage 仓库结构

OopStorage(gc/shared/oopStorage.hpp:37-73 的注释是设计总纲)管理"堆外指向堆内对象的引用集合"，内部是一组 Block，每块含 `oop[]` + 使用位图(`_allocated_bitmask`)。`allocate`(oopStorage.cpp:410-477)持 `_allocation_mutex` 从 `_allocation_list` 头块取条目，没有可用块就新建；`release`(oopStorage.cpp:675-682)无锁——位图用 CAS 原子清位，变空的块进延迟清理列表，由后续 allocate 顺带处理。两种并发协议（头注释:68-73）:GC 的并发迭代与分配互不长期阻塞。

---

## 5. resolve——无锁读槽

JNI 函数拿到 jobject 后第一步都是 `JNIHandles::resolve`(jniHandles.inline.hpp:68-74)→ `resolve_impl`(:52-66):

```cpp
// jniHandles.inline.hpp:52-66(截取核心,逐字)
template <DecoratorSet decorators, bool external_guard>
inline oop JNIHandles::resolve_impl(jobject handle) {
  assert(handle != NULL, "precondition");
  assert(!current_thread_in_native(), "must not be in native");
  oop result;
  if (is_jweak(handle)) {       // Unlikely
    result = NativeAccess<ON_PHANTOM_OOP_REF|decorators>::oop_load(jweak_ptr(handle));
  } else {
    result = NativeAccess<decorators>::oop_load(jobject_ptr(handle));
    // Construction of jobjects canonicalize a null value into a null
    // jobject, so for non-jweak the pointee should never be null.
    assert(external_guard || result != NULL, "Invalid JNI handle");
  }
  return result;
}
```

要点:

- **解引用无锁**——读一个普通槽不需要锁，因为"槽是 GC 可见的根":GC 移动对象时负责更新槽，读方总能看到最新值。
- 普通 jobject 的槽**永不 null**(null 已规范化为 null jobject)，所以断言。
- jweak 走 `ON_PHANTOM_OOP_REF` 通道，返回可能 null（被 GC 清了）。
- **必须已离开 native 状态**——`assert(!current_thread_in_native())`:在 native 状态下读堆可能和 GC 竞争，所以 JNI 函数入口的 `ThreadInVMfromNative` 先做状态转换，`resolve` 才安全。

---

## 6. 误解澄清与收网

1. **jobject 是否可以当作裸 oop 指针使用？** 不能。jobject 是间接引用（handle），指向一个存放 oop 的槽。GC 移动对象时更新槽，handle 本身不变。裸 oop 会在 GC 后悬空。
2. **本地引用失效是否逐个释放？** 不是。native 返回时解释器/编译代码直接把 `_top` 清零，比逐个 `DeleteLocalRef` 快一个量级。
3. **全局引用和弱全局引用是否同一套存储？** 不是。两个独立的 OopStorage 仓库，一个管 JNI Global，一个管 JNI Weak。
4. **jweak 是否有独立的数据结构？** 没有。jweak 和普通 jobject 共享同一套 OopStorage 仓库，区别仅在于地址 +1 的 tag 位和 phantom 写入/读取通道。
5. **resolve 是否加锁？** 不加锁。槽是 GC 可见的根，GC 移动对象时负责更新槽，读方无锁总能读到最新值。

把这一篇压成三句话:

- **jobject 是间接引用**，指向一个 GC 可追踪的 oop 槽，不是裸 oop 指针。
- **本地引用存于线程本地的 JNIHandleBlock 链**，32 槽一块，靠 `_top` 清零整体失效；参数也是本地引用，靠 oop map 在 GC 时更新。
- **全局/弱全局引用存于 OopStorage 仓库**，全局引用显式分配/释放，弱全局引用靠地址 +1 tag 位 + phantom 通道实现弱语义，GC 的 WeakProcessor 清 NULL。

Handle 系统只是 JNI 的"数据面"——每次 `GetIntField` 都走完整 JNI 调用（经 JNIEnv 函数表间接调用、状态转换、resolve），约 200 cycles；而 `GetIntField` 读一个整型字段本该是 10 cycles 的活。下一篇:快路径怎么把 200 cycles 压到 30？

> → [27-jni/02 — JNI GetIntField 正常 200 cycles → 怎么做到 30 cycles?— JNI Fast Path](02-jni-fast-path.md)