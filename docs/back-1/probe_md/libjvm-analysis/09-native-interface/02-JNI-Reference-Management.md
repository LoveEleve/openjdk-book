# 02-JNI-Reference-Management — JNI 引用管理：LocalRef 的 block 链表、GlobalRef 的 OopStorage、以及它们如何成为 GC Root

> **元信息**
> - 标准环境：OpenJDK 11 slowdebug build，`-Xms8g -Xmx8g -XX:+UseG1GC`，64 位 Linux x86
> - 模块跨越：`runtime/`（JNIHandleBlock、线程 oops_do）+ `gc/shared/`（OopStorage、GC root set）+ `prims/`（JNI API 入口）
> - 前置文档：[09-01 ThreadState-NativeTransition]（控制面）、[06-GC]（GC root set 概念）
> - 地位：09 阶段数据面，阅读顺序第二
> - 阅读收益：理解 JNI 引用的完整生命周期——从创建、GC root 注册、到释放——三者的存储结构和无锁并发设计

---

### ★ 为什么先学控制面再学数据面

[09-01] 讲了线程状态转换——**什么时候**能安全访问 VM 对象（"能不能"的问题）。本文讲 JNI 引用——这些对象**以什么形式存在**于 JNI 层（"在哪、怎么管"的问题）。两者缺一不可：

- **状态对了但引用管理错了** → `_thread_in_vm` 中安全创建了 handle，但没 DeleteGlobalRef → OopStorage 内存泄漏，`_allocation_count` 持续增长 → 最终 OOM。
- **引用管理对了但状态不对** → `_thread_in_native` 中用 jobject 解析出 oop，GC 正在移动对象 → 读野指针 → 崩溃（`make_global` 的 `current_thread_in_native()` 断言就是防这个——详见 §七.1）。

换句话说，01 讲的是 JNI 的**控制面**（control plane：状态机决定能不能做），本文讲的是**数据面**（data plane：引用在内存中的物理存在形式和 GC 可见性）。两篇读完，才算完整理解了一句 "为什么 native 代码中的 jobject 不会凭空失效"——因为控制面保证线程在正确状态下访问引用，数据面保证引用本身不会在不该消失时消失。

---

## §〇 源文件清单

| # | 文件 | 路径 | 模块 | 核心行号 | 本文角色 |
|---|------|------|------|---------|---------|
| 1 | `jniHandles.hpp` | `src/hotspot/share/runtime/jniHandles.hpp` | runtime | L35-126 (JNIHandles类), L132-205 (JNIHandleBlock类) | ★★★ 结构定义 + weak_tag 常量 |
| 2 | `jniHandles.cpp` | `src/hotspot/share/runtime/jniHandles.cpp` | runtime | L101-124 (make_global), L127-148 (make_weak_global), L170-187 (destroy), L190-192 (oops_do global), L384-425 (allocate_block), L428-470 (release_block), L473-498 (oops_do local), L501-566 (allocate_handle) | ★★★ 全部创建/销毁/GC扫描逻辑 |
| 3 | `jniHandles.inline.hpp` | `src/hotspot/share/runtime/jniHandles.inline.hpp` | runtime | L34-38 (is_jweak), L45-49 (jweak_ptr), L97-102 (destroy_local), L52-66 (resolve_impl) | ★★★ inline 热路径 — tag 编码 + 解析 + local 销毁 |
| 4 | `oopStorage.hpp` | `src/hotspot/share/gc/shared/oopStorage.hpp` | gc/shared | L92-96 (EntryStatus), L174-257 (Block/ActiveArray/内部类) | ★★★ GlobalRef 底层容器 API |
| 5 | `oopStorage.cpp` | `src/hotspot/share/gc/shared/oopStorage.cpp` | gc/shared | L202,204 (section_size/count), L302-315 (Block::allocate CAS), L502-516 (replace_active_array), L523-528 (obtain_active_array), L676-683 (release), L721-740 (OopStorage ctor) | ★★ CAS 分配 + RCU + 双锁 rank |
| 6 | `oopStorage.inline.hpp` | `src/hotspot/share/gc/shared/oopStorage.inline.hpp` | gc/shared | L382-384 (oops_do), L392-399 (weak_oops_do), L356-379 (iterate_impl) | ★★ GC root scanning 遍历接口 |
| 7 | `genCollectedHeap.cpp` | `src/hotspot/share/gc/shared/genCollectedHeap.cpp` | gc/shared | L782-850 (process_roots), L811 (JNIHandles::oops_do) | ★★ GC root set 全景 |
| 8 | `g1RootProcessor.cpp` | `src/hotspot/share/gc/g1/g1RootProcessor.cpp` | gc/g1 | L224-243 (process_java_roots), L246-301 (process_vm_roots: L261 JNIHandles::oops_do) | ★★ G1 root scanning 分层结构 |
| 9 | `jni.cpp` | `src/hotspot/share/prims/jni.cpp` | prims | JNI_ENTRY/JNI_LEAF 宏, jni_NewGlobalRef / jni_PushLocalFrame 等 ~L3700+ | ★★ JNI API → 内部实现映射 |
| 10 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | runtime | L961-964 (Thread::oops_do), L3042-3047 (JavaThread::oops_do) | ★★ LocalRef 作为 GC root 的扫描入口 |
| 11 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | runtime | L301-304 (_active_handles / _free_handle_block), L513-516 (访问器) | ★★ LocalRef block 链在线程中的挂载点 |
| 12 | `javaCalls.cpp` | `src/hotspot/share/runtime/javaCalls.cpp` | runtime | L56-118 (JavaCallWrapper ctor), L121-153 (JavaCallWrapper dtor) | ★ LocalRef 在 Java↔Native 往返中的完整生命周期 |
| 13 | `jfrDcmds.cpp` | `src/hotspot/share/jfr/dcmd/jfrDcmds.cpp` | jfr | L59-69 (push_jni_handle_block), L75-85 (pop_jni_handle_block) | ★ Push/Pop 的通用模式参考 |
| 14 | `compileBroker.cpp` | `src/hotspot/share/compiler/compileBroker.cpp` | compiler | L2425-2451 (CompileBroker push/pop) | ★ Push/Pop 的编译器使用参考 |
| 15 | `count_trailing_zeros.hpp` | `src/hotspot/share/utilities/count_trailing_zeros.hpp` | utilities | L43-47 (__builtin_ctzl → 找最低位1的位置) | ★ Block::allocate() CAS 的核心 helper |

---

## §一 ★ JNIHandleBlock 结构 — 线程本地的无锁栈式分配器

### ❓ 为什么用 block 链表而不是 vector 或 malloc 每个 ref？

三个深度设计决策：

**① 线程本地无锁** — 每个 JavaThread 有自己的 `_active_handles` block 链表（`thread.hpp:301`），`allocate_handle()` 全程无锁。在 JNI 调用频繁的场景（如 native 方法中的循环），每毫秒可能产生数千个 LocalRef——如果每次加互斥锁，开销是灾难性的。

**② 栈式生命周期** — `_top` 只增不减（除 PopLocalFrame 回滚）。`DeleteLocalRef` 只把 slot 写 NULL——不释放内存、不复用 slot。真正的复用发生在 PopLocalFrame 回滚 `_top` 时，或整个 block 被 `release_block` 回收。这保证了简单性：slot 索引一旦分配就永远有效（在当前 frame 内），不存在 use-after-free 的危险。

**③ PushLocalFrame/PopLocalFrame 用 `_pop_frame_link` 实现 checkpoint 回滚** — 不是真的释放内存，是把 `_top` 回滚到之前值。回滚后，旧的 `_top` 以下的 slot 被新分配的 LocalRef 覆盖。

### 1.1 JNIHandleBlock 完整字段布局（`jniHandles.hpp:132-205`）

```
JNIHandleBlock (CHeapObj<mtInternal>), ~300 字节
★ 偏移为示意值——实际取决于编译器对齐和 CHeapObj 基类。用 pahole 或 GDB offset_of 确认。
┌──────────────────────────────────────────────────────────────────┐
│  _handles[32]         0x00-~0x100  oop[32]  256B   数据数组      │
│  _top                 ~0x100       int       4B     下一个空位索引│
│  _next                ~0x108       JNIHandleBlock*  8B  水平链表  │
│  _last                ~0x110       JNIHandleBlock*  8B  最后块    │
│  _pop_frame_link      ~0x118       JNIHandleBlock*  8B  垂直链表  │
│  _free_list           ~0x120       oop*       8B    空闲槽位链表   │
│  _allocate_before_rebuild  ~0x128  int   4B    重建阈值           │
│  _planned_capacity    ~0x130       size_t    8B    计划容量        │
│  (debug only: _block_list_link, _block_list, _blocks_allocated)   │
└──────────────────────────────────────────────────────────────────┘
```

关键字段语义区分：

- **`_next`**：同 frame 内 block 溢出链（水平方向）。当 `_top == 32` 时，新 `allocate_block()` 创建的 block 通过 `_next` 链接。
- **`_pop_frame_link`**：嵌套 frame 链（垂直方向）。PushLocalFrame 时，新 block 的 `_pop_frame_link` 指向旧 block。GC 遍历时沿此链扫描所有嵌套 frame。
- **`_free_list`**：DeleteLocalRef 写 NULL 后，`rebuild_free_list()` 扫描所有 `_handles[]` → 收集 NULL slot → 用侵入式链表串联。下次 `allocate_handle()` 优先从此取。

### ❓ 每个 block 为什么刚好 32 个 slot？

```cpp
// jniHandles.hpp:138
enum SomeConstants {
  block_size_in_oops = 32  // Number of handles per handle block
};
```

`32 × 8 字节(oop*) = 256 字节 = 4 × 64 字节(x86 L1 cache line)`。这个数字的选择是工程经验：

- **太小**（如 8）：block 链太长，分配/释放 block 的开销（`allocate_block()` 需加锁取全局 `_block_free_list`）比例增大
- **太大**（如 128）：大部分 JNI 方法只有 ≤10 个 LocalRef → 浪费内存
- **32 是平衡点**：既保证 cache-line 友好（正好 4 条 cache line），又足够大部分 JNI 方法使用

> 如果改为 64 → 512 字节(8 cache line)。大部分方法只用到前 10 个 slot → 50+ slot 浪费 → 每个 block 浪费 400+ 字节。如果 JVM 有 100 个 JavaThread → 额外浪费 ~40KB。
>
> 如果改为 8 → 32 字节(0.5 cache line)。每次 `_top` 到达 8 就需新 block → block 分配频率 4 倍 → `JNIHandleBlockFreeList_lock` 竞争 4 倍。

### 1.2 `allocate_block()` 三级分配池（`jniHandles.cpp:384-425`）

```
JNIHandleBlock::allocate_block(Thread* thread)

  ┌─────────────────────────────────────────────────────────┐
  │ 第一级: JavaThread::_free_handle_block                  │
  │   线程本地缓存，完全无锁。priority = Thread::current()    │
  │   thread->free_handle_block() → block = freelist_head   │
  │   thread->set_free_handle_block(block->_next)           │
  ├─────────────────────────────────────────────────────────┤
  │ 第二级: JNIHandleBlock::_block_free_list (全局)         │
  │   JNIHandleBlockFreeList_lock 保护                      │
  │   block = _block_free_list;                             │
  │   _block_free_list = _block_free_list->_next;           │
  ├─────────────────────────────────────────────────────────┤
  │ 第三级: new JNIHandleBlock()                            │
  │   最慢但保证有。_top = 0, _next = NULL                   │
  │   _blocks_allocated++; block->zap();                    │
  └─────────────────────────────────────────────────────────┘
```

死锁预防注释（`jniHandles.cpp:394-397`）：
```cpp
// locking with safepoint checking introduces a potential deadlock:
// - we would hold JNIHandleBlockFreeList_lock and then Threads_lock
// - another would hold Threads_lock (jni_AttachCurrentThread) and then
//   JNIHandleBlockFreeList_lock (JNIHandleBlock::allocate_block)
MutexLockerEx ml(JNIHandleBlockFreeList_lock,
                 Mutex::_no_safepoint_check_flag);
```

用 `_no_safepoint_check_flag` 打破死锁环路，因为 **safepoint 检查会尝试获取 `Threads_lock`**。

### 1.3 `allocate_handle()` — `_top` 只增不减 + 不扫描空闲 slot（`jniHandles.cpp:501-566`）

完整分配到释放的决策树：

```cpp
allocate_handle(oop obj):
① 如果 _top == 0 → 这是首次分配或进入 native 时 zapped
   → 清除后续所有 block → _free_list = NULL → _last = this → zap()

② 尝试最后一block: if (_last->_top < 32)
   → 分配 _handles[_last->_top++] = obj → return ★ 热路径

③ 尝试 freelist: if (_free_list != NULL)
   → 从侵入式链表取头部 → return ★ 复用 DeleteLocalRef 的 slot

④ 尝试跟随: if (_last->_next != NULL)
   → _last = _last->_next → retry②

⑤ 需要空间:
   → if (_allocate_before_rebuild == 0)
        → rebuild_free_list() → 扫描所有 block 收集 NULL slot
     else
        → allocate_block() → 挂载到 _last->_next → _allocate_before_rebuild--

⑥ retry②
```

关键设计后果：**`DeleteLocalRef` 只写 NULL（`jniHandles.inline.hpp:97-102`，L100 `oop_store(ptr, NULL)`），不回收 slot**。只有 `rebuild_free_list()` 时才收集 NULL slot 到 `_free_list`。但 `_top` 仍然不减小——即使 slot 被复用，`_top` 也保持历史峰值。真正的减小只发生在 **PopLocalFrame 回滚** 或 **block 被整体释放**。

### 1.4 PushLocalFrame/PopLocalFrame — `_pop_frame_link` checkpoint（参考 `jfrDcmds.cpp:59-85` 的通用模式）

```cpp
// push (jfrDcmds.cpp:59-68)
JNIHandleBlock* prev_handles = thread->active_handles();
JNIHandleBlock* entry_handles = JNIHandleBlock::allocate_block(thread);
entry_handles->set_pop_frame_link(prev_handles);  // ← 关键：垂直链接
thread->set_active_handles(entry_handles);

// pop (jfrDcmds.cpp:75-84)
JNIHandleBlock* entry_handles = thread->active_handles();
JNIHandleBlock* prev_handles = entry_handles->pop_frame_link(); // ← 恢复
thread->set_active_handles(prev_handles);
entry_handles->set_pop_frame_link(NULL);
JNIHandleBlock::release_block(entry_handles, thread);
```

如果 `capacity > 32`：PushLocalFrame 可以分配 `capacity/32` 个 block 的链（设置 `_planned_capacity`），但 `_pop_frame_link` 只指向链的第一个 block——GC 通过 `_next` 遍历链内所有 block。

### 1.5 LocalRef 在 Thread 对象中的挂载点（`thread.hpp:301-304,513-516`）

```cpp
// thread.hpp:301-304
JNIHandleBlock* _active_handles;    // 当前活跃的 block 链
JNIHandleBlock* _free_handle_block; // 线程本地空闲 block 缓存

JNIHandleBlock* active_handles() const    { return _active_handles; }
void set_active_handles(JNIHandleBlock*)  { _active_handles = block; }
```

**生命周期视角**（`javaCalls.cpp`）：

- **ctor**（L56-118）：L67 `allocate_block(thread)` 分配新 block，L93 `_handles = _thread->active_handles()` 保存旧指针，L104 `_thread->set_active_handles(new_handles)` 安装新 block
- **dtor**（L121-153）：L127 `_old_handles = _thread->active_handles()` 取当前 block 链，L128 `_thread->set_active_handles(_handles)` 恢复 ctor 保存的旧链，L152 `JNIHandleBlock::release_block(_old_handles, _thread)` 将当前链归还线程本地 `_free_handle_block` 缓存

---

## §二 ★★★ `make_global()` — GlobalRef 的 4 断言 + OopStorage 对接

### ❓ `jobject` 到底是个什么类型？指针还是句柄？

`jobject` 在 C 中是 `jobject`（`jni.h` 定义为 `_jobject*`），在 C++ 中是 `_jobject*`。在 HotSpot 实现中，**`jobject` 直接就是 `oop*`（指向堆中 oop 对象的指针的指针）**。`JNIHandles::resolve(handle)` → `NativeAccess<>::oop_load(jobject_ptr(handle))` → 读取 `oop*` 指向的内容 → 得到 `oop`。

因此：
- **LocalRef** 的 `jobject` = `&_handles[index]`（JNIHandleBlock 数组中的一个 slot 地址）
- **GlobalRef** 的 `jobject` = OopStorage 分配的 `oop*` 指针
- **Weak GlobalRef (jweak)** 的 `jobject` = OopStorage `oop*` 地址 + 1（最低 bit 设 1 标记）

### 2.1 `make_global()` 源码逐行分析（`jniHandles.cpp:101-124`）

```cpp
101: jobject JNIHandles::make_global(Handle obj, AllocFailType alloc_failmode) {
```

| 行号 | 代码 | 为什么 |
|------|------|--------|
| 102 | `assert(!Universe::heap()->is_gc_active(), "can't extend the root set during GC")` | GC 标记阶段已确定 root set。此时新增 root → 新对象可能不被标记 → 被错误回收。这是 **GC 一致性的硬约束**。 |
| 103 | `assert(!current_thread_in_native(), "must not be in native")` | [01]§二：线程必须在 `_thread_in_vm(6)` 中才能安全操作 JVM 内部结构。OopStorage 的 `allocate()` 虽用 CAS 无锁，但 native 中调用 → safepoint 无法正确处理此线程 → assert 保护。 |
| 107 | `if (!obj.is_null()) {` | 允许 NULL handle（JNI 规范允许）。 |
| 109 | `assert(oopDesc::is_oop(obj()), "not an oop")` | 纯防御——传入的不是合法 oop → 崩溃。 |
| 110 | `oop *ptr = global_handles()->allocate()` | ★ 核心操作：在 `_global_handles` OopStorage 中分配一个 `oop*` 槽位。`allocate()` 内部走 Block::allocate() 的 CAS 循环（见 §三）。 |
| 112 | `if (ptr != NULL) {` | OopStorage::allocate() 在内存不足时返回 NULL。 |
| 113 | `assert(*ptr == NULL, "invariant")` | 新分配的 OopStorage slot 必须是 NULL——确保没有复用未清理的旧值。 |
| 114 | `NativeAccess<>::oop_store(ptr, obj())` | ★ 写入 oop。为什么不用 `*ptr = obj()`？`NativeAccess<>` 默认 AS_RAW 语义——绕过 GC barrier。OopStorage 是 GC root 容器（不是堆内对象），不需要 barrier。但用 `NativeAccess<>` 提供跨平台的 memory order 保证（特别是 AArch64）。 |
| 115 | `res = reinterpret_cast<jobject>(ptr)` | `jobject` 就是 `oop*`（经 `reinterpret_cast` 强转）。GlobalRef 没有 tag 位编码（和 jweak 不同）。 |
| 117 | `report_handle_allocation_failure(...)` | 根据策略：`EXIT_OOM` → `vm_exit_out_of_memory`（JVM 致命退出）；`RETURN_NULL` → 返回 NULL → Java 层 `OutOfMemoryError`。 |

### 2.2 `make_weak_global()` 对比分析（`jniHandles.cpp:127-148`）

5 个精确差异：

| 维度 | `make_global` (强) | `make_weak_global` (弱) |
|------|-------------------|------------------------|
| **OopStorage** | `global_handles()` (L110) | `weak_global_handles()` (L134) |
| **NativeAccess decorator** | `NativeAccess<>` (L114) | `NativeAccess<ON_PHANTOM_OOP_REF>` (L138) |
| **返回值编码** | `(jobject)ptr` — 直接地址 (L115) | `(jobject)((char*)ptr + weak_tag_value)` — 地址+1 (L139-140) |
| **GC 扫描** | `JNIHandles::oops_do(f)` → `oops_do(cl)` 无条件遍历 | `JNIHandles::weak_oops_do(is_alive, f)` → `weak_oops_do()` 先判活再遍历 |
| **destroy 验证** | `assert(!is_jweak)` → `global_handles()->release()` (L172,175) | `assert(is_jweak)` → `jweak_ptr()` 解码 → `weak_global_handles()->release()` (L182-185) |

`ON_PHANTOM_OOP_REF` decorator 告诉 GC barrier 系统这个引用是"幽灵引用"——GC 可能异步清 NULL。这在 weak ref 被 GC 清除时很重要：GC 需要知道这个 slot 可以被安全清空（不触发 barrier）。

### 2.2a ★ 在看 GC 怎么遍历这些引用之前——OopStorage 如何无锁管理 slot

`make_global()` 调用 `global_handles()->allocate()` 获取一个 `oop*` 槽位（L110），`destroy_global()` 调用 `global_handles()->release(ptr)` 归还（L175）。但这里有一个必须先回答的问题：**如果 GC 正在并发扫描这个 OopStorage，同时另一个线程在执行 allocate/release，怎么保证 GC 看到的 slot 状态是一致的？**

答案是 OopStorage 的 **CAS 无锁分配 + RCU 引用计数** 双机制。在看 GC 怎么遍历这些引用（§四）之前，需要先理解 OopStorage 本身如何在无锁条件下管理这些 slot——否则 §四 的 "GC 通过引用计数持有只读视图" 会被误解为 "OopStorage 内部有读写锁"。

### 2.3 OopStorage 内部结构速览

```
JNIHandles::_global_handles → OopStorage("JNI Global")
  ┌─────────────────┐
  │ _active_array   │ → ActiveArray(size=8 → 扩容到 N)
  │                 │    ┌───┬───┬───┬───┬───┬───┬───┬───┐
  │                 │    │ B0│ B1│ B2│...│   │   │   │   │
  │                 │    └───┴───┴───┴───┴───┴───┴───┴───┘
  │ _allocation_list│    双向链表:B0↔B1↔B2↔...
  │ _deferred_updates│    延迟释放链表
  │ _allocation_mutex│    分配锁 (Mutex)
  │ _active_mutex   │    扩容锁 (Mutex)
  │ _allocation_count│    已分配条目计数
  │ _protect_active │    SingleWriterSynchronizer (RCU)
  └─────────────────┘

Block:
  ┌─────────────────────────────────────────────────────┐
  │ _data[]         entries_per_block 个 oop* (64-bit)   │
  │ _allocated_bitmask  uintx (64-bit) 位图              │
  │ _owner          OopStorage*                          │
  │ _memory         void* (原始内存块)                     │
  │ _active_index   在 ActiveArray 中的索引               │
  │ _allocation_list_entry  双向链表节点                   │
  │ _deferred_updates_next  延迟释放链表                   │
  │ _release_refcount  release 操作引用计数                │
  └─────────────────────────────────────────────────────┘
```

Block 的 `_data` 数组大小由两个常量决定（`oopStorage.cpp:202,204`）：`section_size = BytesPerWord`（=8）、`section_count = BytesPerWord`（=8）。乘积 = 64 个 oop*（512 字节数据）——源码中没有叫 `entries_per_block` 的命名常量（只有 `STATIC_ASSERT(section_size * section_count == ARRAY_SIZE(_data))` 验证）。`_allocated_bitmask` 是 `uintx`（64-bit），每一位对应一个 slot——正好用一个机器字表示 64 个 slot 的分配状态。

### 2.4 `Block::allocate()` CAS 循环逐行（`oopStorage.cpp:302-315`）

```cpp
302: oop* OopStorage::Block::allocate() {
303:   // Use CAS loop because release may change bitmask outside of lock.
304:   uintx allocated = allocated_bitmask();       // ① 读当前位图
305:   while (true) {
306:     assert(!is_full_bitmask(allocated), "attempt to allocate from full block");
307:     unsigned index = count_trailing_zeros(~allocated);  // ② 找空闲位
308:     uintx new_value = allocated | bitmask_for_index(index);  // ③ 构建新位图
309:     uintx fetched = Atomic::cmpxchg(new_value, &_allocated_bitmask, allocated);
310:     if (fetched == allocated) {
311:       return get_pointer(index);  // ④ CAS 成功 → 返回 slot 指针
312:     }
313:     allocated = fetched;          // ⑤ CAS 失败 → 重试
314:   }
315: }
```

**逐行动机**：
- L304：初始读——不需要 barrier，因为 CAS 的 memory order 已足够
- L306：断言——如果 bitmap 全 1（64 个 slot 全满），不应该进入此函数。调用方应在选择 block 时已跳过满块
- L307：`count_trailing_zeros(~allocated)` → `__builtin_ctzl(~allocated)` → 找出最低位的 0 的位置（第一个空闲 slot 索引）。这是 O(1) 操作（CPU 的 `TZCNT` 指令）
- L308-309：CAS cmpxchg——如果 `_allocated_bitmask` 还是 `allocated`（没有被其他线程修改），则原子设置为 `new_value`；否则返回当前值
- L313：CAS 失败 → `allocated = fetched`（用最新值重试）→ 典型的 CAS retry loop

**为什么 CAS 而不是锁？** safepoint 期间可能仍有 allocate 调用（如 weak ref 处理），锁在 safepoint 中可能导致死锁。CAS 是 lock-free，safepoint 安全。

---

## §三 ★★★ OopStorage 的无锁并发 — CAS + RCU + 双锁分离

### ❓ GC 遍历 OopStorage 时真的不需要锁吗？

**答案：是的。GC 通过引用计数机制（不是锁！）持有只读视图。** 这是 OopStorage 最精妙的设计。

### 3.1 ActiveArray 引用计数机制（`oopStorage.cpp:145-148,523-528`）

```cpp
// ActiveArray 字段:
//   Block*    _blocks[];   // 动态数组
//   size_t    _size;       // 数组容量
//   size_t    _block_count; // 实际 block 数
//   mutable int _refcount; // ★ 引用计数

// 获取引用（读者侧）:
OopStorage::ActiveArray* OopStorage::obtain_active_array() const {
  SingleWriterSynchronizer::CriticalSection cs(&_protect_active);  // 进入临界区
  ActiveArray* result = OrderAccess::load_acquire(&_active_array); // acquire 读
  result->increment_refcount();  // refcount + 1 (Atomic::add)
  return result;                 // 安全返回——即使扩容替换了指针，旧 array 仍有效
}

// 增加引用计数:
void OopStorage::ActiveArray::increment_refcount() const {
  int new_value = Atomic::add(1, &_refcount);  // 原子 +1
  assert(new_value >= 1, "negative refcount %d", new_value - 1);
}
```

**读者状态机**：
```
obtain_active_array()
  → load_acquire(&_active_array)        // 读到当前 array 指针
  → increment_refcount()                // 增加引用 → 禁止删除
  → 安全遍历 blocks[]
  → decrement_refcount()                // refcount 归零 → 可以删除
  → relinquish_block_array()
```

**为什么这不是锁？** `increment_refcount()` 只是 `Atomic::add(1, &_refcount)`——无阻塞、无等待、无 mutex。它是典型的 **RCU (Read-Copy-Update)** 实现——读者只增加计数，写入者等待所有读者退出后再释放旧数据。

### 3.2 `replace_active_array()` — SingleWriterSynchronizer（`oopStorage.cpp:502-516`）

```cpp
void OopStorage::replace_active_array(ActiveArray* new_array) {
  new_array->increment_refcount();                    // 写者自己的引用
  OrderAccess::release_store(&_active_array, new_array); // ★ 原子替换指针
  _protect_active.synchronize();                      // ★ 等所有读者退出
  // 所有 obtain_active_array() 的 CriticalSection 已退出
  // 旧 array 的额外 refcount 已被读者释放 → 只剩写者的那份 → 安全
}
```

关键步骤：
1. **release_store**：确保 new_array 的初始化在指针替换之前完成（防止读者看到半初始化的 array）
2. **`_protect_active.synchronize()`**：阻塞直到所有在 `obtain_active_array()` 的 `CriticalSection` 中的读者退出
3. 注释明确说明不能用 `GlobalCounter`——因为 `allocate()` 可能在 `GlobalCounter` 临界区内被调用（如 StringTable 插入时），会导致死锁

### 3.3 `_allocation_mutex` vs `_active_mutex` 的 rank 层级（`oopStorage.cpp:734-735`）

```cpp
assert(_active_mutex->rank() < _allocation_mutex->rank(),
       "%s: active_mutex must have lower rank than allocation_mutex", _name);
```

HotSpot 使用 **锁排序** 防止死锁：rank 低的锁必须先获取。这意味着：
- 扩容操作（需要两把锁）的锁序：先 `_active_mutex`（低 rank）→ 后 `_allocation_mutex`（高 rank）
- `_active_mutex` 只在 `replace_active_array()` 中使用（扩容/缩容）
- `_allocation_mutex` 在 `allocate()` 的 block 选择/dedup 逻辑中使用——但不保护 Block::allocate() 本身的 CAS

### 3.4 `release()` — 不是简单释放（`oopStorage.cpp:676-683`）

```cpp
void OopStorage::release(const oop* ptr) {
  check_release_entry(ptr);                              // assert(*ptr == NULL)
  Block* block = find_block_or_null(ptr);
  assert(block != NULL, "%s: invalid release " PTR_FORMAT, name(), p2i(ptr));
  block->release_entries(block->bitmask_for_entry(ptr), &_deferred_updates);
  Atomic::dec(&_allocation_count);
}
```

`release_entries()` 实际操作：
1. 用 CAS 清除 `_allocated_bitmask` 中对应位
2. 将 block 加入 `_deferred_updates` 链表
3. block 的释放延迟到 safepoint 期间或下次 `allocate()` → `reduce_deferred_updates()` 时

**设计原因**：block 只有在其所有 entry 都释放后才安全删除。延迟更新允许批量处理，避免每次 `release()` 都检查 block 是否可删除。

---

## §四 ★★ GC Root Scanning 中的 JNI Handles

### ❓ GC 怎么知道 GlobalRef 指向了哪个对象？

GC 在 safepoint 中调用 `genCollectedHeap::process_roots()` → 遍历所有 root set → 对每个 root 调用 `do_oop(root)`。GlobalRef 作为独立的 root 类别被扫描（`genCollectedHeap.cpp:811`）。

### 4.1 GC root set 全景表（`genCollectedHeap.cpp:782-850`）

> **环境说明**：以下以 Serial/CMS 的 `genCollectedHeap::process_roots()` 为例展示 GC root 分类概念。G1 将 root 分为 `process_java_roots` + `process_vm_roots` 两阶段（`JNIHandles::oops_do()` 在后者中，`g1RootProcessor.cpp:260-262`），底层遍历接口统一。G1 分层细节见 §4.5。

| 行号 | Root 类别 | 扫描入口 | 存储位置 |
|------|---------|---------|---------|
| L797 | ClassLoaderDataGraph | `ClassLoaderDataGraph::roots_cld_do()` | CLD 图 |
| L804 | Threads（线程栈 + LocalRef） | `Threads::possibly_parallel_oops_do()` | Thread 对象 + JNIHandleBlock 链 |
| L807 | Universe 静态字段 | `Universe::oops_do(strong_roots)` | Universe 静态区 |
| **L811** | **★ JNI GlobalRef (强)** | **`JNIHandles::oops_do(strong_roots)`** | **OopStorage `_global_handles`** |
| L815 | ObjectSynchronizer (monitor) | `ObjectSynchronizer::oops_do(strong_roots)` | ObjectMonitor 链 |
| L818 | Management | `Management::oops_do(strong_roots)` | 管理数据 |
| L821 | JVMTI | `JvmtiExport::oops_do(strong_roots)` | JVMTI 持有引用 |
| L824 | AOT (可选) | `AOTLoader::oops_do(strong_roots)` | AOT 缓存 |
| L828 | SystemDictionary (已加载类) | `SystemDictionary::oops_do(strong_roots)` | Dictionary |
| L832-849 | CodeCache | `CodeCache::scavenge_root_nmethods_do()` / `blobs_do()` | CodeBlob |

### 4.2 `JNIHandles::oops_do()` → OopStorage 遍历（`jniHandles.cpp:190-192`）

```cpp
// jniHandles.cpp:190-192
void JNIHandles::oops_do(OopClosure *f) {
  global_handles()->oops_do(f);  // 委托给 OopStorage
}

// jniHandles.cpp:195-202 (弱引用版)
void JNIHandles::weak_oops_do(BoolObjectClosure *is_alive, OopClosure *f) {
  weak_global_handles()->weak_oops_do(is_alive, f);  // 先判活再遍历
}
```

OopStorage 的 `oops_do()`/`weak_oops_do()`（`oopStorage.inline.hpp:382-399`）：
```cpp
// 强引用：无条件遍历所有 slot
void OopStorage::oops_do(Closure* cl) {
  iterate_safepoint(oop_fn(cl));  // L383
}

// 弱引用（简单版）：跳过 NULL slot
void OopStorage::weak_oops_do(Closure* cl) {
  iterate_safepoint(skip_null_fn(oop_fn(cl)));  // L393
}

// 弱引用（完整版）：先判活 → 不活 → 自动清 NULL
void OopStorage::weak_oops_do(IsAliveClosure* is_alive, Closure* cl) {
  iterate_safepoint(if_alive_fn(is_alive, oop_fn(cl)));  // L398
}
```

`iterate_safepoint()` → `iterate_impl()`（`oopStorage.inline.hpp:356-368`）遍历 `_active_array`→ 遍历每个 `Block` → 对每个 `_data[i]` 应用传入的 functor。

### 4.3 `JNIHandleBlock::oops_do()` — LocalRef 双重链表遍历（`jniHandles.cpp:473-498`）

```cpp
void JNIHandleBlock::oops_do(OopClosure *f) {
  JNIHandleBlock *current_chain = this;          // 从当前 block 开始
  while (current_chain != NULL) {
    // ★ 水平遍历：沿 _next 走同 frame 的所有 block
    for (JNIHandleBlock *current = current_chain; current != NULL;
         current = current->_next) {
      assert(current == current_chain || current->pop_frame_link() == NULL,
             "only blocks first in chain should have pop frame link set");
      // ★ 遍历当前 block 的所有活跃 slot (0.._top)
      for (int index = 0; index < current->_top; index++) {
        oop *root = &(current->_handles)[index];
        oop value = *root;
        // 只遍历堆指针——跳过 DeleteLocalRef 写 NULL 的 slot
        if (value != NULL && Universe::heap()->is_in_reserved(value)) {
          f->do_oop(root);  // ★ GC 标记此引用为活
        }
      }
      // 如果当前 block 没满 → 停止水平遍历
      if (current->_top < block_size_in_oops) {
        break;
      }
    }
    // ★ 垂直遍历：沿 _pop_frame_link 走到上一个 frame
    current_chain = current_chain->pop_frame_link();
  }
}
```

**双重链表维度**：
```
thread->_active_handles → Block_a (_top=32) → Block_b (_top=16, _next=NULL)
                               ↑
                               │ _pop_frame_link (PushLocalFrame)
                               │
                          Block_c (_top=8)
                               ↑
                               │ _pop_frame_link
                               │
                          Block_d (_top=5)

oops_do() 遍历顺序：Block_a→Block_b→Block_c→Block_d
```

**为什么需要 `is_in_reserved()` 检查？** `_handles[]` 中可能存在非 oop 的值——`_free_list` 侵入式链表指针存储在 `_handles[]` 中（`rebuild_free_list()` 时用 `*handle = (oop)_free_list` 存储链表链接）。必须区分。

### 4.4 强 vs 弱 GlobalRef 的 GC 分流

```
                  ┌─ is_alive? ────→ 是 → f->do_oop(root)  ← 保持
                  │                 → 否 → *root = NULL      ← GC 自动清除
                  │
weak_oops_do ─────┤
                  │
   (无 is_alive) ─┴── skip_null_fn → 跳过 NULL slot → f->do_oop(root)
```

隐藏读者分析：
- **GC thread**（在 safepoint 中）：无锁读 `_active_array` + 遍历 Block 的 `_data[]`。通过 `obtain_active_array()` 的引用计数保证安全——即使扩容替换了 `_active_array`，GC 持有的旧 array 仍然有效（refcount > 0）。
- **VMThread**：不直接读 OopStorage 数据。但作为 safepoint 的协调者，VMThread 确保所有 JavaThread 停在 safepoint 后才启动 GC。

### 4.5 G1 也走 `JNIHandles::oops_do()` 吗？

**是的，但分层不同。** G1 把 root 分成"java roots"和"vm roots"两个阶段（`g1RootProcessor.cpp`）：

- **`process_java_roots()`**（`g1RootProcessor.cpp:224-243`）处理 `ClassLoaderDataGraph::roots_cld_do()` + `Threads::possibly_parallel_oops_do()`（线程栈 + LocalRef）
- **`process_vm_roots()`**（`g1RootProcessor.cpp:246-301`）处理 `JNIHandles::oops_do(strong_roots)`（`g1RootProcessor.cpp:260-262`）+ `Universe::oops_do()` + `SystemDictionary::oops_do()` 等

G1 分层是因为它需要在线程栈扫描完毕后设 barrier（等待所有 worker 完成 strong CLD/nmethod 扫描），然后才开始 weak root 处理。而 genCollectedHeap 的 `process_roots()` 在一个平坦函数中顺序扫描所有 root——性能模型不同，但**底层遍历 OopStorage 的接口是统一的**——不管是 G1、Parallel、Serial 还是 Shenandoah，都通过 `JNIHandles::oops_do()` → `OopStorage::oops_do()` 扫描 GlobalRef。

LocalRef 的扫描路径在 G1 中同样走 `Threads::possibly_parallel_oops_do()` → `JavaThread::oops_do()` → `Thread::oops_do()` → `active_handles()->oops_do(f)`。

---

## §五 ★★ `jweak` 标签编码 — `is_jweak()` 的 bit 0 技巧

### ❓ 为什么选 bit 0 而不是更高位或单独字段？

**答案：因为 oop* 地址天然对齐，bit 0 永远是 0——可以安全复用为 tag 位。**

### 5.1 `is_jweak()` 实现（`jniHandles.inline.hpp:34-38`）

```cpp
// jniHandles.hpp:63-66 — 常量定义
static const uintptr_t weak_tag_size = 1;
static const uintptr_t weak_tag_alignment = (1u << weak_tag_size);  // 2
static const uintptr_t weak_tag_mask = weak_tag_alignment - 1;      // 1
static const int weak_tag_value = 1;

// jniHandles.inline.hpp:34-38
inline bool JNIHandles::is_jweak(jobject handle) {
  STATIC_ASSERT(weak_tag_size == 1);
  STATIC_ASSERT(weak_tag_value == 1);
  return (reinterpret_cast<uintptr_t>(handle) & weak_tag_mask) != 0;
}
```

**编码**：`jweak = (jobject)((char*)oop_ptr + 1)` → 最低 bit = 1
**解码**：`oop_ptr = (char*)jweak - 1` → 去掉 tag

### 5.2 为什么 bit 0 安全？

```
64-bit oop* 地址: 0x00007f8a_1234_5670  (16 进制)
                                   ↑ bit 3..0 = 0 (8 字节对齐)
32-bit oop* 地址: 0x1234_5670
                       ↑ bit 1..0 = 0 (4 字节对齐)
```

`oop*` 指针在 64-bit 平台上对齐到 8 字节 → bit 0-2 永远为 0；32-bit 平台上对齐到 4 字节 → bit 0-1 永远为 0。所以 bit 0 在所有平台上都是空闲的。

### 5.3 `jweak_ptr()` 解码（`jniHandles.inline.hpp:45-49`）

```cpp
inline oop* JNIHandles::jweak_ptr(jobject handle) {
  assert(is_jweak(handle), "precondition");
  char* ptr = reinterpret_cast<char*>(handle) - weak_tag_value;  // handle - 1
  return reinterpret_cast<oop*>(ptr);
}
```

### 5.4 为什么 GC 遍历不受 tag 影响？

GC 遍历走的是 `OopStorage::iterate_safepoint()` → 直接访问 `Block._data[]`。`_data[]` 存储的是原始 `oop*` 地址（**不经 jweak_ptr 解码**）。tag 只在 JNI API 层面有意义——用于 `is_jweak()` 判断和 `resolve_impl()` 的分流：

```cpp
// jniHandles.inline.hpp:52-66 (resolve_impl)
if (is_jweak(handle)) {
  result = NativeAccess<ON_PHANTOM_OOP_REF|decorators>::oop_load(jweak_ptr(handle));
} else {
  result = NativeAccess<decorators>::oop_load(jobject_ptr(handle));
}
```

---

## §六 ★ LocalRef vs GlobalRef vs WeakGlobalRef 三元对比

### 6.1 三种引用完整对比表（≥12 维度）

| 维度 | LocalRef | GlobalRef (强) | Weak GlobalRef |
|------|----------|---------------|----------------|
| **创建函数** | `make_local(oop)` | `make_global(Handle)` | `make_weak_global(Handle)` |
| **创建行号** | `jniHandles.cpp:52` | `jniHandles.cpp:101` | `jniHandles.cpp:127` |
| **存储位置** | `JNIHandleBlock._handles[32]` | OopStorage `_global_handles` Block._data[] | OopStorage `_weak_global_handles` Block._data[] |
| **分配方式** | 线程本地 `_top++` (无锁) | `OopStorage::allocate()` → CAS 竞争 bitmap | 同 GlobalRef |
| **锁需求** | 无锁 | CAS + `_allocation_mutex`(block选择) | CAS + `_allocation_mutex`(block选择) |
| **GC root 类型** | 强 root（通过线程 oops_do） | 强 root | 弱 root（需 is_alive 判定） |
| **GC 扫描入口** | `Thread::oops_do()` → `active_handles()->oops_do()` (`thread.cpp:963`) | `JNIHandles::oops_do(strong_roots)` (`genCollectedHeap.cpp:811`) | `JNIHandles::weak_oops_do(is_alive, f)` |
| **释放函数** | `destroy_local(handle)` | `destroy_global(handle)` | `destroy_weak_global(handle)` |
| **释放语义** | 只写 NULL（不释放 slot） | 写 NULL + `OopStorage::release(ptr)` | 写 NULL + `weak_global_handles()->release(ptr)` |
| **slot 复用** | `_free_list` 侵入式链表 或 PopLocalFrame 回滚 | OopStorage release → CAS 清除 bit → block 可能被删除 | 同 GlobalRef |
| **生命周期** | ≤ 当前 frame | 直到 `DeleteGlobalRef` | 直到 `DeleteWeakGlobalRef` 或 GC 清除 |
| **自动释放** | PopLocalFrame / frame exit / JavaCallWrapper dtor | 无（必须手动 Delete） | 无（必须手动 Delete；GC 可自动清 NULL） |
| **JNI 规范上限** | 65535 (JNI 规范层检查) | 无硬上限 | 无硬上限 |
| **内存开销** | block 结构 ~300B + 256B 数据/block | OopStorage block ~512B 数据 + 管理员数据 | 同 GlobalRef |
| **jobject 编码** | 直接 `oop*` 地址 | 直接 `oop*` 地址 | `oop*` 地址 + 1（bit 0=1 tag） |

### 6.2 生命周期状态机

**LocalRef**：
```
[创建] make_local(obj)
  → allocate_handle() → _handles[_top++] = obj
    → [存活在 block 中，GC 扫描]
      → DeleteLocalRef | PopLocalFrame | frame exit
        → slot=NULL (不释放 block) | 回滚 _top | release_block
```

**GlobalRef**：
```
[创建] make_global(obj)
  → global_handles()->allocate() → CAS 获取 slot
    → NativeAccess<>::oop_store(ptr, obj)
      → [作为 GC root 存活在 OopStorage 中]
        → DeleteGlobalRef
          → oop_store(NULL) → global_handles()->release(ptr)
            → CAS 清除 bit → block 加入 _deferred_updates
```

**Weak GlobalRef**：
```
[创建] make_weak_global(obj)
  → weak_global_handles()->allocate() → CAS 获取 slot
    → oop_store(ptr, obj) → (jobject)(ptr + 1)  ← 加 tag
      → [作为弱 root 存活]
        → GC 发生 → is_alive? → 是 → 保留
                            → 否 → GC 自动 *ptr = NULL
        → DeleteWeakGlobalRef → release(ptr)
```

### 6.3 面试陷阱集

**陷阱 1**：`NewGlobalRef` 返回的 jobject 能在 native 方法返回后继续使用吗？
→ **能**——这正是 GlobalRef 的意义（跨调用生命周期）。但不 `DeleteGlobalRef` → **OopStorage 内存泄漏** → `_allocation_count` 持续增长 → 最终 OOM。

**陷阱 2**：`DeleteLocalRef` 后 jobject 还能用吗？
→ **不能**——slot 已被写 NULL。虽然 slot 不会被复用（`_top` 不变），但 `resolve()` 会读到 NULL → assert 失败或返回 NULL。后续 `NewLocalRef` 可能覆盖此 slot（如果 `rebuild_free_list()` 重新收集了它）。

**陷阱 3**：65535 个 LocalRef 上限在哪检查？
→ **不在 JNIHandleBlock 中**。`JNIHandleBlock::allocate_handle()` 没有硬上限检查——理论上可以无限分配 block 链。65535 是 **JNI 规范层**的限制（`jni_EnsureLocalCapacity()` → `check_jni_local_capacity()`），在 `jni.cpp` 的 `JNI_ENTRY` wrapper 中检查。

**陷阱 4**：长时间运行的 native 循环中每次 `NewLocalRef` → 真的会 OOM 吗？
→ **会**。`_top` 只增不减，最终触发 `rebuild_free_list()` → 但 free list 也被耗空 → 不断分配新 block → 内存无限增长。正确的做法是 `PushLocalFrame` / `PopLocalFrame` 定期回收。

---

## §七 ★ 和 [01] 的交叉验证

### 7.1 `current_thread_in_native()` 断言的完整调用栈

```
JNI API 调用 (如 NewGlobalRef)
  → JNI_ENTRY 宏 → ThreadInVMfromNative ctor
    → transition_from_native → [01]§二 的状态转换
      → _thread_in_vm(6) + poll safepoint
        → jni_NewGlobalRef()
          → JNIHandles::make_global(Handle, AllocFailType)
            → assert(!current_thread_in_native()) ← ★ [01] 的直接应用
```

`current_thread_in_native()` 实现（`jniHandles.cpp:336-340`）：
```cpp
bool JNIHandles::current_thread_in_native() {
  Thread *thread = Thread::current();
  return (thread->is_Java_thread() &&
          JavaThread::current()->thread_state() == _thread_in_native);
}
```

### 7.2 `!is_gc_active()` 断言 — safepoint 期间创建 GlobalRef 的危害

```
时间线:
  T1: VMThread 发起 safepoint → 所有 JavaThread → _thread_blocked
  T2: GC 开始 → 确定 root set → 开始标记
  T3: 某线程（在 native 中）被唤醒 → 调用 make_global()
  T4: assert(!is_gc_active()) → ★ 崩溃！在 GC 标记期间新增 root
      → 新对象可能不在已标记集 → 被错误回收
```

### 7.3 `Thread::oops_do()` 在 safepoint 中的调用时机

```
GC safepoint 时间线:
  ① VMThread: SafepointSynchronize::begin() → 所有线程停住
  ② GC: process_roots() → Threads::oops_do() → 扫描所有线程栈 + LocalRef
     genCollectedHeap::process_roots() L804
  ③ GC: process_roots() → JNIHandles::oops_do() → 扫描 GlobalRef
     genCollectedHeap::process_roots() L811
  ④ GC: 标记阶段
  ⑤ GC: 回收阶段
  ⑥ SafepointSynchronize::end() → 线程继续
```

### 7.4 `transition_from_native` → poll 和 `destroy_local` 的时间线关系

```
Thread A (in native, _thread_in_native):
  ① 调用 DeleteLocalRef → JNI_ENTRY → ThreadInVMfromNative
     → _thread_in_vm(6) → poll safepoint ✓
  ② destroy_local(handle) → oop_store(ptr, NULL)
  ③ JNI_END → _thread_in_native(4)

GC safepoint (during ①→③):
  VMThread: 等待所有线程 → Thread A 在 _thread_in_vm 中 → 已在 safepoint ✓
  GC: Thread::oops_do(A) → active_handles()->oops_do()
     → slot 已被写 NULL (步骤②) → is_in_reserved(NULL) → 跳过
     → 正确！被 Delete 的 LocalRef 不被标记
```

---

## §八 GDB 验证 + 可证伪断言（≥12 条）

### 断言 1：JNIHandleBlock._top 从 0 增长
```gdb
(gdb) break JNIHandleBlock::allocate_handle
(gdb) commands
> silent
> p this->_top
> c
> end
# 多次 continue → 观察 _top: 0 → 1 → 2 → ... → 31 → 0 (新 block) → ...
```

### 断言 2：block 链表结构 — _next 链遍历
```gdb
(gdb) p *(JNIHandleBlock*)thread->_active_handles
# 输出 _top, _next, _pop_frame_link
(gdb) p *((JNIHandleBlock*)thread->_active_handles)->_next
# 若 _next != NULL → 查看下一个 block
```

### 断言 3：PushLocalFrame / PopLocalFrame 前后变化
```gdb
(gdb) p thread->_active_handles            # Push 前
(gdb) p thread->_active_handles->_top      # 应为当前值
# 执行 PushLocalFrame
(gdb) p thread->_active_handles            # 新的 block 地址
(gdb) p thread->_active_handles->_pop_frame_link  # 应等于 Push 前的 block
# 执行 PopLocalFrame
(gdb) p thread->_active_handles            # 恢复为 Push 前的地址
```

### 断言 4：`make_global()` → `global_handles()->allocate()` — oop* 地址在 OopStorage Block 内
```gdb
(gdb) break jniHandles.cpp:115             # after ptr assigned, before reinterpret_cast
(gdb) commands
> silent
> p ptr                                    # 应落在 OopStorage Block._data[] 范围内
> p/x *(oop**)ptr                          # 查看写入的 oop
> c
> end
```
> 注：`ptr` 在 L110 `allocate()` 返回后才存在——不能在函数入口断点访问此局部变量。

### 断言 5：OopStorage Block._allocated_bitmask CAS 变化
```gdb
# 断在 CAS 成功路径 (L311)，避免在 while(true) 循环内 next 不可控
(gdb) break oopStorage.cpp:311            # CAS succeeded
(gdb) commands
> silent
> p/x this->_allocated_bitmask            # 应比进入前多了对应位
> c
> end
```

### 断言 6：GC 期间 `JNIHandleBlock::oops_do()` 的调用栈
```gdb
(gdb) break JNIHandleBlock::oops_do
(gdb) bt
# 应看到: JNIHandleBlock::oops_do → Thread::oops_do → JavaThread::oops_do
#         → Threads::possibly_parallel_oops_do → process_roots
```

### 断言 7：Weak GlobalRef GC 后自动清 NULL
```gdb
(gdb) p handle                           # jweak (地址 + 1)
(gdb) p/x (uintptr_t)handle & 1          # 应为 1 (is_jweak)
(gdb) p *(oop**)((char*)handle - 1)      # GC 前: 有效 oop 地址
# 触发 GC
(gdb) p *(oop**)((char*)handle - 1)      # GC 后: 0x0 (已清除)
```

### 断言 8：`DeleteGlobalRef` 后 `OopStorage::release()` 的 bitmap 变化
```gdb
(gdb) break OopStorage::release
(gdb) commands
> silent
> p ptr
> next                              # release_entries 执行
> p/x block->_allocated_bitmask     # 对应位应被清除
> c
> end
```

### 断言 9：`is_jweak()` 验证
```gdb
(gdb) p weak_handle                            # jweak
(gdb) p/x (uintptr_t)weak_handle & 1           # 应为 1
(gdb) p global_handle                          # 强 GlobalRef
(gdb) p/x (uintptr_t)global_handle & 1         # 应为 0
```

### 断言 10：`destroy_local()` — slot 变 NULL 但 `_top` 不变
```gdb
(gdb) p block->_handles[n]         # n < _top
(gdb) p block->_top                 # 记下当前值
# 执行 DeleteLocalRef(该 handle)
(gdb) p block->_handles[n]         # 应为 NULL (0x0)
(gdb) p block->_top                 # 应该不变
```

### 断言 11：`make_global()` 的 `current_thread_in_native()` 验证
```gdb
(gdb) break JNIHandles::make_global
(gdb) commands
> silent
> p JavaThread::current()->thread_state()
> # 应为 _thread_in_vm (6)
> c
> end
```

### 断言 12：`JNIHandleBlock::oops_do()` 双重链遍历
```gdb
(gdb) break JNIHandleBlock::oops_do
(gdb) commands
> silent
> p current_chain               # 当前 frame 的第一个 block
> p current_chain->_pop_frame_link  # 上一 frame（若有 PushLocalFrame）
> # 继续执行 → 验证 current_chain 沿 _pop_frame_link 更新
> c
> end
```

### 可证伪断言

1. **如果 `make_global` 在 `_thread_in_native` 中被调用** → `assert(!current_thread_in_native())` 崩溃
2. **如果 `make_global` 在 GC 期间被调用** → `assert(!is_gc_active())` 崩溃
3. **如果 `DeleteLocalRef` 后不 NewLocalRef（在同一 frame 中），slot 不会被覆盖** → GDB 验证 `_handles[n]` 保持 NULL
4. **`NewWeakGlobalRef` → GC → weak ref 被清 NULL** → `is_global_weak_cleared(jweak)` 返回 true
5. **`OopStorage::Block::allocate()` 的 CAS 在 bitmap 已满时永远不会成功** → 死循环（设计意图——等待其他线程 release slot）
6. **`resolve_impl(jweak_handle)` 读到的 oop 和 `jweak_ptr(handle)` 解码一致** → GDB 对比 `jweak_ptr(handle)` 和手动 `(char*)handle - 1`
7. **`PopLocalFrame` 后 `release_block` → block 进入 `_free_handle_block` 线程本地缓存** → GDB 验证 `thread->free_handle_block()` 非 NULL
8. **不同线程的 `_active_handles` 链完全不共享** → 每个 JavaThread 有独立的 `_active_handles` 指针
```

---

## 文档版本

- **v1.1** — 修复：G1 root 分层路径修正（process_java_roots → process_vm_roots）、GDB 断点行号精度、jobject 拼写、字段偏移示意标注；新增 JavaCallWrapper dtor 完整源码验证（javaCalls.cpp:121-153）、g1RootProcessor.cpp 源文件清单、section_size/section_count 定义行号
