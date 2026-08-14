# 01. jobject 在 JVM 内部怎么存的?— JNI Handle 系统

> **前置依赖**:[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):JNI_CreateJavaVM 与函数表在启动序列里点亮;[17-threads/01 — JVM 里有多少种线程?— Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):JavaThread 的"线程行李"里挂着本地引用块;[06-oops/01 — 对象头 — 一个 word,五种身份](openjdk/vol-02/06-oops/01-markoop-oopdesc.md):被引用的 oop 在 GC 里会移动
> → **后续**:[27-jni/02 — JNI GetIntField 正常 200 cycles → 怎么做到 30 cycles?— JNI Fast Path](02-jni-fast-path.md)
> 关联域: 25-gc(根集处理与弱引用清除)、09-memory-core(VM 内部的 Handle/HandleMark 是另一套引用)、31-unsafe(裸 oop 通道)

## native 方法拿到的是什么

Java 调 native 方法,参数里的 `jobject` 是什么?直觉是"对象的指针"——但 GC 会移动对象(年轻代复制,Full GC 还会压缩),如果 jobject 是裸 oop 指针,一次 GC 后它就悬空了。所以 JNI 规定: **jobject 是间接引用(handle)——指向一个存放 oop 的槽**。GC 移动对象时更新槽里的 oop,handle 本身不变。这篇拆三层: 生命最短的本地引用(local)、跨调用持久的全局引用(global)、可被 GC 清理的弱全局引用(weak)——它们底层各是什么、怎么分配、怎么失效。

## 1. 本地引用: 线程行李里的一块块"便签纸"

### 存放: JavaThread 的 active_handles 链

每个 JavaThread 挂着一串 `JNIHandleBlock`(jniHandles.hpp:132 起,线程字段 `_active_handles`,thread.hpp:301/513)。`JNIHandles::make_local`(jniHandles.cpp:52-61)往当前线程的块里塞一个槽:

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

注意两个断言: ① `is_oop`——只收合法的 oop;② `!current_thread_in_native()`——**创建本地引用的代码必须已离开 native 状态**(JNI 函数入口的 `ThreadInVMfromNative` 已做状态转换,17-04 的通道)。null 直接返回 NULL——**jobject 的 null 规范化**(下文 resolve 的注释 "Construction of jobjects canonicalize a null value into a null jobject",jniHandles.inline.hpp:61-62)。

`JNIHandleBlock` 是一块定长"便签纸"(jniHandles.hpp:136-160):

```cpp
// jniHandles.hpp:136-160(截取核心,逐字)
  enum SomeConstants {
    block_size_in_oops  = 32                    // Number of handles per handle block
  };

  oop             _handles[block_size_in_oops]; // The handles
  int             _top;                         // Index of next unused handle
  JNIHandleBlock* _next;                        // Link to next block

  // The following instance variables are only used by the first block in a chain.
  // Having two types of blocks complicates the code and the space overhead in negligible.
  JNIHandleBlock* _last;                        // Last block in use
  JNIHandleBlock* _pop_frame_link;              // Block to restore on PopLocalFrame call
  oop*            _free_list;                   // Handle free list
  int             _allocate_before_rebuild;     // Number of blocks to allocate before rebuilding free list
```

每块 32 个槽;满了链下一块(`_next`);`_top` 是已用计数。`allocate_handle`(jniHandles.cpp:481-546)按四段顺序找空位: ①`_last` 块的末尾槽;②**free list**(被 `DeleteLocalRef` 清空的槽串成的单链表,槽内嵌 next 指针:`_free_list = (oop*) *_free_list`,:521);③`_last->_next` 的未用块;④都不行就**重建 free list 或追加新块**(:532-545)。重建有启发式(rebuild_free_list,:548-575): 扫全链,把 `_handles[i]==NULL` 的槽收进 free list;若空闲槽不到一半,按缺额算出"再分配几个块后才重建"(`_allocate_before_rebuild`),避免每次都全链扫描。

### 失效: 不是"pop",是"清零 _top"

大纲式的想象是"native 返回时把本地引用弹出栈"——真实机制更朴素: **native 方法返回时,解释器与编译代码都把 active_handles 块的 `_top` 直接清零**(块内容留着,下次分配覆盖):

```cpp
// templateInterpreterGenerator_x86.cpp:1163-1166(截取核心,逐字)
  // reset handle block
  __ movptr(t, Address(thread, JavaThread::active_handles_offset()));
  __ movl(Address(t, JNIHandleBlock::top_offset_in_bytes()), (int32_t)NULL_WORD);
```

编译代码的 native wrapper 同样处理(sharedRuntime_x86_64.cpp:2652-2656,注释 "reset handle block";critical native 例外)。效果: 一次 native 调用里的所有本地引用整体失效——块里的旧值变成垃圾,GC 的 `oops_do`(jniHandles.cpp:453-478)只遍历 `_top` 以内的槽,所以旧值也不会被当成根。**JNI 规范"本地引用在 native 返回后无效"就是这样一行 movl 实现的**——比逐个释放快一个量级。

**参数也是本地引用**: 实证里 `GetObjectRefType` 对"从 Java 传进来的 jobject"返回 `JNILocalRefType`([实证:](planning/outlines/00-jvm-tools/materials/commands/27-jni-handles-demo.txt));实现上共享的 native 调用代码(编译代码的 native wrapper 与解释器的签名处理器,templateInterpreterGenerator_x86.cpp:932-947)把**参数帧里 oop 槽的地址**当作 handle 传给 native(sharedRuntime_x86_64.cpp:1157-1180,注释 "An oop arg. Must pass a handle not the oop itself"),GC 靠 oop map 更新那个槽(`is_frame_handle` 专门识别栈上的引用,jniHandles.cpp:270-278)——所以参数引用在调用结束、帧失效后自然作废,也解释了为什么不能把参数当 global handle 传回给 `DeleteGlobalRef`(那是另一套存储,会崩)。

### Push/Pop: 显式的帧边界

`PushLocalFrame`/`PopLocalFrame`(jni.cpp:746-783)是显式版本: Push 时 `new_handles->set_pop_frame_link(old_handles); thread->set_active_handles(new_handles)`(:753-757)——旧块挂到新块的 `_pop_frame_link`;Pop 时把结果先解析成 VM 内部 `Handle`(防 GC),恢复旧块,把旧块整链 `release_block` 回池(:766-782)。`_pop_frame_link` 这个字段的存在就是为它准备的。

## 2. 全局引用与弱全局引用: OopStorage 里的两个仓库

本地引用随线程走、随调用失效;跨调用持久的引用要另找存放处——**OopStorage**。`JNIHandles::initialize`(jniHandles.cpp:203-210)建两个仓库:

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

`make_global`(jniHandles.cpp:101-122)就是"仓库里要一块、写上 oop、返回地址":

```cpp
// jniHandles.cpp:101-122(截取核心,逐字)
jobject JNIHandles::make_global(Handle obj, AllocFailType alloc_failmode) {
  assert(!Universe::heap()->is_gc_active(), "can't extend the root set during GC");
  assert(!current_thread_in_native(), "must not be in native");
  jobject res = NULL;
  if (!obj.is_null()) {
    // ignore null handles
    assert(oopDesc::is_oop(obj()), "not an oop");
    oop* ptr = global_handles()->allocate();
    // Return NULL on allocation failure.
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

`jni_NewGlobalRef`(jni.cpp:788-799)先 `resolve` 输入再 `make_global`;`DeleteGlobalRef` 走 `destroy_global`(jniHandles.cpp:168-175): 先把槽写 NULL(让对象可能被回收),再 `global_handles()->release(ptr)` 归还条目。两个断言有讲究: **GC 进行中不能扩根集**,**必须已离开 native 状态**。

### jweak: 地址 +1 就是"弱"的标记

`make_weak_global`(jniHandles.cpp:125-146)几乎一样,两个差异——写入用 `NativeAccess<ON_PHANTOM_OOP_REF>`(phantom 语义,GC 不强引用它),以及返回前**给地址加 1**:

```cpp
// jniHandles.cpp:132-145(截取核心,逐字)
    oop* ptr = weak_global_handles()->allocate();
    // Return NULL on allocation failure.
    if (ptr != NULL) {
      assert(*ptr == NULL, "invariant");
      NativeAccess<ON_PHANTOM_OOP_REF>::oop_store(ptr, obj());
      char* tptr = reinterpret_cast<char*>(ptr) + weak_tag_value;
      res = reinterpret_cast<jobject>(tptr);
    } else {
      report_handle_allocation_failure(alloc_failmode, "weak global");
    }
```

`weak_tag_size = 1`、`weak_tag_alignment = 2`、`weak_tag_value = 1`(jniHandles.hpp:63-66): 仓库条目按 2 字节对齐、低位恒 0,最低位正好空出来做标记。于是 `is_jweak(handle)` 就是一次位测试(inline.hpp:34-38): `(uintptr_t)handle & 1`。[实证:](planning/outlines/00-jvm-tools/materials/commands/27-jni-handles-demo.txt) `NewWeakGlobalRef -> 0x7f99144bbf81, lsb=1`——真实地址低位就是 1;而 `GetObjectRefType` 返回 3(`JNIWeakGlobalRefType`)。**弱全局引用的"弱"不靠单独的数据结构,靠一个 tag 位 + phantom 读写通道**: GC 的 WeakProcessor 阶段(weakProcessor.cpp:37,`JNIHandles::weak_oops_do`)遍历仓库,`is_alive` 为 false 的条目直接写 NULL([实证:] 27-jni-handles-demo.txt: global 删除 + `System.gc()` 后 `NewLocalRef(weak)` 返回 null,对象被清)。

### 仓库本身: OopStorage

OopStorage(gc/shared/oopStorage.hpp:37-73 的注释是设计总纲)管理"堆外指向堆内对象的引用集合",内部是一组 Block,每块含 `oop[]` + 使用位图(`_allocated_bitmask`,oopStorage.cpp:208)。`allocate`(:410-477)持 `_allocation_mutex` 从 `_allocation_list` 头块取条目,没有可用块就新建并把块挂进 `_active_array`(GC 并行遍历用,`expand_active_array` 可扩容),满块从分配列表摘除;`release`(:675-683)无锁,只查块位图清位。**两种并发协议**(头注释 :68-73): GC 的并发迭代(Concurrent Iteration Protocol)与分配(Allocation Protocol)互不长期阻塞——全局引用能被大量并发创建而不会成为 GC 的瓶颈。

## 3. resolve: 无锁地读槽

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

要点: ① **解引用无锁**——读一个普通槽不需要锁,因为"槽是 GC 可见的根": GC 移动对象时负责更新槽(年轻代复制时遍历根),读方总能看到最新值;② 普通 jobject 的槽**永不 null**(null 已规范化为 null jobject),所以断言;jweak 走 `ON_PHANTOM_OOP_REF` 通道,返回可能 null(被 GC 清了);③ **必须已离开 native 状态**——`assert(!current_thread_in_native())`(:55): 在 native 状态下读堆可能和 GC 竞争,所以 JNI 函数入口的 `ThreadInVMfromNative` 先做状态转换,`resolve` 才安全。

## 核心悬念

三层引用拆完: 本地引用是线程行李里 32 槽一块的便签纸(`_top` 清零整体失效,参数引用是帧内 oop 槽的地址);全局引用是 OopStorage 仓库里持久条目(显式 delete);弱全局引用靠"地址 +1"的 tag 位与 phantom 读写,由 GC 的 WeakProcessor 清 NULL——[实证](planning/outlines/00-jvm-tools/materials/commands/27-jni-handles-demo.txt)里 `jweak` 地址低位为 1、删掉全局引用后弱引用自动清空,一清二楚。SIGQUIT 转储末尾的 "JNI global refs: N, weak refs: M" 就是这两个仓库的当前水位(jniHandles.cpp:305-307)。

但 Handle 系统只是 JNI 的"数据面"——每次 `GetIntField` 都走完整 JNI 调用(函数表查 env、状态转换、resolve),约 200 cycles;`GetIntField` 读一个整型字段本该是 10 cycles 的活。下一篇: 快路径怎么把 200 cycles 压到 30?

> → [27-jni/02 — JNI GetIntField 正常 200 cycles → 怎么做到 30 cycles?— JNI Fast Path](02-jni-fast-path.md)
