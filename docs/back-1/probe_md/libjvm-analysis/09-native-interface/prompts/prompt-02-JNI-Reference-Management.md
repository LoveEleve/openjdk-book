# PROMPT: 请撰写 02-JNI-Reference-Management.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**JNI 引用管理 — LocalRef 的 block 链表、GlobalRef 的 OopStorage、以及它们如何成为 GC Root**

### 核心故事线（禁止做源码翻译机！）

[01-ThreadState-NativeTransition] 把线程状态转换和 safepoint 交互拆解清楚了——读者现在知道一个 JNI 调用怎么穿越 `_thread_in_native` ↔ `_thread_in_vm` 边界。但下一个关键问题立刻浮现：**"穿越边界时，我怎么把 Java 对象的引用安全地传过去？"**

LocalRef 和 GlobalRef 是这个问题的答案。但它们的实现远不止"一个指针"那么简单：
- LocalRef 为什么不会泄漏？是 GC 自动回收还是 native 返回时手动清理？
- GlobalRef 存在堆外的什么地方？GC 扫描 root set 时怎么找到它？
- Weak GlobalRef 的 `jweak` 本质上是什么类型？和 `jobject` 有什么区别？

**本文是 09 阶段的"JNI 数据面"文档**：[01] 讲的是控制面（线程状态怎么切换），本文讲的是数据面（Java 对象引用怎么安全传递）。两者合在一起才构成完整的 JNI 边界穿越模型。

### 核心叙事线

1. **★ 为什么 LocalRef 用 block 链表（而不是 malloc 每个 ref）？** — 三个深度设计决策：(a) **线程本地无锁**——每个 JavaThread 有自己的 `_active_handles` block 链表，分配时完全无锁；(b) **栈式生命周期**——`_top` 只增不减，释放时整条链一次性回收；(c) **PushLocalFrame/PopLocalFrame** 用 `_pop_frame_link` 实现 checkpoint 回滚——不是真的释放内存，是把 `_top` 回滚到之前值。追问：**每个 block 为什么刚好 32 个 slot？** 32 × 8 字节（oop* in 64-bit）= 256 字节 = 4 个 cache line（x86 L1 cache line = 64 字节）。追问：**JNIHandleBlock 本身多大？字段布局是什么？** `_handles[32]` 只是数据数组——block 对象还有 `_top`、`_next`、`_pop_frame_link`、`_free_list`、`_last`、`_allocate_before_rebuild` 等字段，总大小约 300 字节。

2. **★★★ GlobalRef 与 OopStorage 的对接 — GC Root 的诞生** — 全文最核心的技术点。`make_global()`（`jniHandles.cpp:101`）调用 `global_handles()->allocate()`，在 OopStorage 中分配一个 `oop*` 槽位。OopStorage 内部：Block 数组（每个 Block 含 `_data[entries_per_block]` + `_allocated_bitmask`）+ CAS 分配 bitmap slot + ActiveArray 做 RCU 无锁读。GC 的 `process_roots()`（`genCollectedHeap.cpp:782`）中显式调用 `JNIHandles::oops_do(strong_roots)`（L811）→ 遍历 `_global_handles` OopStorage → 标记为 GC root。追问：**为什么 `make_global` 断言 `!current_thread_in_native()`？**（`jniHandles.cpp:103`）因为操作 OopStorage 必须在 VM 中——safepoint 期间 GC 可能正在遍历 OopStorage。追溯调用链：`jni_NewGlobalRef`（`jni.cpp`，`JNI_ENTRY` 宏）→ `ThreadInVMfromNative` ctor → `_thread_in_vm`(6) → `make_global` → `current_thread_in_native()` 返回 false ✓。追问：**为什么还有 `assert(!is_gc_active())`？**（`jniHandles.cpp:102`）GC 期间新增 root 会破坏 GC 一致性——GC 标记阶段不能新增活对象引用。

3. **★★ LocalRef 的自动释放与 GC Root 双重身份** — `JNIHandleBlock::allocate_block()` 三级分配池：`JavaThread::_free_handle_block`（线程本地，无锁）→ `JNIHandleBlock::_block_free_list`（全局，`JNIHandleBlockFreeList_lock` 保护）→ `new JNIHandleBlock()`。每个 block 32 slot，`_top` 指向下一个空闲位。追问：**LocalRef 什么时候被 GC 扫描？** `Thread::oops_do()`（`thread.cpp:961`）→ `active_handles()->oops_do(f)`。`JavaThread::oops_do()`（`thread.cpp:3042`）首行即调用 `Thread::oops_do()`。**JNIHandleBlock::oops_do()**（`jniHandles.cpp:473`）遍历 `_next` 链 + `_pop_frame_link` 链——所以 PushLocalFrame 嵌套的所有 frame 的所有 block 都被扫描。追问：**DestroyLocalRef 和 DeleteLocalRef 的区别？** `destroy_local()`（`jniHandles.inline.hpp:97`）只写 `oop_store(ptr, NULL)`——设为 NULL，让 GC 跳过。但 **slot 不会被复用**——`_top` 继续向前推，`allocate_handle()` 总是分配 `_handles[_top++]`，不扫描空闲 slot。真正的复用只发生在 PopLocalFrame 回滚 `_top` 时。追问：**长时间运行的 native 循环中每次都 NewLocalRef → 65535 上限 → OOM。这个上限在哪检查？** 不在 JNIHandleBlock 中——JNI 规范层在每次 `NewLocalRef` 时检查计数器，需验证源码位置。

4. **★ Weak GlobalRef 的标签编码 — `jweak = oop* + 1`** — `jweak` 不是新类型。`is_jweak(handle)`（`jniHandles.inline.hpp:34`）检查 `(uintptr_t)(handle) & 1 != 0`——最低位是 tag 位。`make_weak_global()`（`jniHandles.cpp:127`）分配 `weak_global_handles()->allocate()` 得到 `oop* ptr`，然后 `res = (jobject)((char*)ptr + weak_tag_value)`——地址 + 1。解码：`jweak_ptr(handle)`（`jniHandles.inline.hpp:45`）= `(char*)handle - 1`。追问：**为什么能用最低位做 tag？** oop* 地址对齐到至少 4 字节（32-bit）或 8 字节（64-bit）——最低位永远是 0——可以安全复用。追问：**强 GlobalRef 和 Weak GlobalRef 用不同的 OopStorage 实例吗？** 是——`_global_handles` vs `_weak_global_handles`。但这只决定 GC 扫描时走 `oops_do`（强）还是 `weak_oops_do`（弱）。释放时：`destroy_global()` → `global_handles()->release()`；`destroy_weak_global()` → `weak_global_handles()->release()`——不同实例，但 `release()` 逻辑相同。

5. **★ JNI 引用在 GC Root Set 中的位置 — genCollectedHeap::process_roots() 的 10 类 GC root** — `genCollectedHeap.cpp:782-850` 列出完整的 GC root set。`JNIHandles::oops_do(strong_roots)` 在 L810-812，和 `Threads::oops_do`（线程栈）、`Universe::oops_do`（Universe 静态字段）、`ObjectSynchronizer::oops_do`（monitor）、`SystemDictionary::oops_do`（已加载类）并列。追问：**G1 的 GC root scanning 也走这条路吗？** G1 有自己的 `G1RootProcessor::process_java_roots()`，但内部同样调用 `JNIHandles::oops_do()`——底层遍历接口一致。追问：**LocalRef 在 GC root set 的哪个位置？** 不在 `process_roots()` 中——LocalRef 通过 `Thread::oops_do()` → `active_handles()->oops_do()` 扫描，这是线程栈扫描的一部分，不是独立的 root 类别。

6. **★★★ OopStorage 的无锁设计 — CAS 分配 + ActiveArray RCU 读取 + 双锁分离** — OopStorage 的三个层级：(a) `Block::allocate()`（`oopStorage.cpp:302`）用 CAS 循环在 `_allocated_bitmask`（uintx, 64位）上竞争 slot——无锁；(b) `ActiveArray` 用 `obtain_active_array()`（`oopStorage.cpp:523`）做 RCU 式引用计数读——**不需要锁**！GC iterator 通过 `increment_refcount()` + `load_acquire` 安全持有 array 指针；(c) `replace_active_array()`（`oopStorage.cpp:502`）扩容时用 `SingleWriterSynchronizer` 等所有读者退出临界区再释放旧 array。追问：**为什么 GC 遍历 OopStorage 时不需要 `_active_mutex`？** `_active_mutex` 只在扩容时替换 `_active_array` 指针时使用——GC 遍历通过引用计数机制（不是锁！）持有只读视图。追问：**`_allocation_mutex` 和 `_active_mutex` 的 rank 关系？** 构造函数 L734 assert `_active_mutex->rank() < _allocation_mutex->rank()`——rank 低的锁必须先获取（避免死锁），这意味着扩容操作（需要两把锁）的锁序是 _active_mutex → _allocation_mutex。

7. **★ `jni.cpp` 中 JNI 函数注册表 — 302 个 JNI 函数如何映射到内部实现** — `jni.cpp` 底部的 `JNINativeInterface_` 结构体（约 L3700-3900）将所有 JNI API 函数映射到内部实现：`jni_NewGlobalRef`、`jni_DeleteGlobalRef`、`jni_PushLocalFrame`、`jni_PopLocalFrame` 等。每个函数通过 `JNI_ENTRY` → `ThreadInVMfromNative` 进入 VM，然后调用 `jniHandles.cpp` / `oopStorage.cpp` 的实现。追问：**有没有不走 `ThreadInVMfromNative` 的 JNI 函数？** `JNI_LEAF` 宏——用于纯计算型函数（如 `GetVersion`），不涉及 JVM 内部状态，不加 `ThreadInVMfromNative`。追问：**`jni_DeleteLocalRef` 调用的是 `destroy_local()` 还是 `destroy_global()`？** `destroy_local()`（`jniHandles.inline.hpp:97`）——只写 NULL，不释放 OopStorage entry。

### 禁止行为

- ❌ 把 `make_global()` 全文贴出来逐行翻译——这是源码翻译机
- ❌ 把 OopStorage 的 `allocate()`/`release()` 全文贴出来——只引用关键 CAS 循环和 bitmap 逻辑
- ❌ 把 JNI 规范中 LocalRef/GlobalRef 的定义复述一遍——本文不是 JNI API 教程
- ❌ 忽略 OopStorage 的 RCU 引用计数机制——"GC 遍历不需要锁"是 OopStorage 最精妙的设计
- ❌ 忽略 `jweak` 的最低 bit 标签编码——`weak_tag_value=1` 是整个 weak ref 机制的基石
- ❌ 不画 JNIHandleBlock 的完整字段布局图（含 `_handles[32]`、`_top`、`_next`、`_pop_frame_link`、`_free_list`）
- ❌ 不画 OopStorage 的 `_allocated_bitmask` CAS 分配时序——必须展示多线程竞争时 CAS 的 retry 路径
- ❌ 不验证源码行号——所有行号必须对照实际源码确认
- ❌ 不引用 [01]——`current_thread_in_native()` 断言是 [01]§二 的直接应用
- ❌ 忽略"隐藏读者"分析——VMThread/GC thread 是 OopStorage 状态的隐藏读者（无锁读）

### 要求行为

- ✅ **★ `make_global()` 逐行分析**（`jniHandles.cpp:101-124`）— 每行解释"为什么"：为什么 `assert(!gc_active)`、为什么 `assert(!in_native)`、为什么 `NativeAccess<>::oop_store` 不能换成 `*ptr = obj()`、为什么 `allocate()` 可能返回 NULL
- ✅ **★ `make_weak_global()` 对比分析**（`jniHandles.cpp:127-148`）— 和 `make_global()` 的 5 个差异点：不同的 OopStorage、不同的 `NativeAccess` decorator（`ON_PHANTOM_OOP_REF`）、`weak_tag_value` 地址偏移、不同的 `release()` 目标
- ✅ **★ OopStorage 的 `Block::allocate()` CAS 循环分析**（`oopStorage.cpp:302-315`）— 逐行解释 CAS 的初始 read → cmpxchg → 失败重试循环 + 为什么 bitmap 是 uintx（一次覆盖 64 slot）+ `count_trailing_zeros` 找空闲位
- ✅ **★ `JNIHandleBlock::oops_do()` 遍历逻辑分析**（`jniHandles.cpp:473-498`）— 解释双重链遍历：`_next` 链（同 frame 的 block 链）+ `_pop_frame_link` 链（嵌套 PushLocalFrame）+ `if (value != NULL && is_in_reserved(value))` 过滤
- ✅ **★ `Thread::oops_do()` → `JavaThread::oops_do()` GC root 扫描路径**— 确认 LocalRef 确实被当 GC root 扫描（`thread.cpp:961-963` + `thread.cpp:3042-3047`）
- ✅ **★ GC root set 全景表**（≥10 类 root）— 标注每类 root 在 `genCollectedHeap::process_roots()` 中的位置（行号）和对应的 OopStorage/OopClosure
- ✅ **★ `is_jweak()` 标签编码详解**— `weak_tag_value=1`, `weak_tag_mask=1` 的定义 + 为什么选 bit 0（对齐保证）+ `jweak_ptr()` 解码
- ✅ **★ GDB 可证伪断言 ≥10 条**— 含具体 GDB 命令和预期值

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心函数（已验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `jniHandles.hpp` | `src/hotspot/share/runtime/jniHandles.hpp` | runtime | `JNIHandleBlock` 类（字段：`_handles[32]`、`_top`、`_next`、`_pop_frame_link`、`_free_list`）、`JNIHandles` 类（工厂方法声明） | ★★★ 结构定义 + 工厂接口 |
| 2 | `jniHandles.cpp` | `src/hotspot/share/runtime/jniHandles.cpp` | runtime | `make_global()`(:101)、`make_weak_global()`(:127)、`destroy_global()`(:170)、`destroy_weak_global()`(:180)、`allocate_block()`(:384)、`release_block()`(:428)、`current_thread_in_native()`(:336)、`JNIHandleBlock::oops_do()`(:473)、`JNIHandleBlock::allocate_handle()`(:501) | ★★★ 全部创建/销毁/遍历逻辑 |
| 3 | `jniHandles.inline.hpp` | `src/hotspot/share/runtime/jniHandles.inline.hpp` | runtime | `destroy_local()`(:97)、`is_jweak()`(:34)、`jweak_ptr()`(:45)、`jobject_ptr()`(:40)、`resolve_impl()`(:52) | ★★★ inline 热路径——tag 编码 + 解析 + local 销毁 |
| 4 | `oopStorage.hpp` | `src/hotspot/share/gc/shared/oopStorage.hpp` | gc/shared | `OopStorage` 类、`Block`、`ActiveArray`、`EntryStatus` enum(:92-96)、`ParState` 模板 | ★★★ GlobalRef 底层容器——API 声明 |
| 5 | `oopStorage.cpp` | `src/hotspot/share/gc/shared/oopStorage.cpp` | gc/shared | `Block::allocate()`(:302)、`Block::new_block()`(:317)、`release()`(:676)、`OopStorage()` 构造函数(:721)、`obtain_active_array()`(:523)、`replace_active_array()`(:502) | ★★ CAS 分配 + Block 生命周期 + RCU |
| 6 | `oopStorage.inline.hpp` | `src/hotspot/share/gc/shared/oopStorage.inline.hpp` | gc/shared | `weak_oops_do()`(:392)、`oops_do()`(:382)、`iterate_safepoint()`(:377)、`oop_fn()`(:244)、`skip_null_fn()`(:291) | ★★ GC root scanning 遍历接口 |
| 7 | `jni.cpp` | `src/hotspot/share/prims/jni.cpp` | prims | `jni_NewGlobalRef`(:about L3990)、`jni_DeleteGlobalRef`、`jni_PushLocalFrame`、`jni_PopLocalFrame`、`JNINativeInterface_` 函数表(:L3700+) | ★★ JNI API → 内部实现映射 |
| 8 | `genCollectedHeap.cpp` | `src/hotspot/share/gc/shared/genCollectedHeap.cpp` | gc/shared | `process_roots()`(:782)—`JNIHandles::oops_do(strong_roots)`(:811) | ★★ GC root set 全景 |
| 9 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | runtime | `Thread::oops_do()`(:961)—`active_handles()->oops_do()`(:963)、`JavaThread::oops_do()`(:3042)—调用 `Thread::oops_do()`(:3047) | ★★ LocalRef 作为 GC root 的扫描入口 |
| 10 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | runtime | `_active_handles`、`_free_handle_block`、`active_handles()`(:513)、`set_active_handles()` | ★★ LocalRef block 链在线程对象中的挂载 + 三级分配池的 thread-local cache |

**跨模块说明**：本文跨 `runtime/`（JNIHandleBlock、线程 oops_do）、`gc/shared/`（OopStorage、GC root set）、`prims/`（JNI API 入口），是 09 阶段跨模块特征最显著的文档之一。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。禁止贴整段函数。

### 4.1 ★★★ JNIHandleBlock — 线程本地的无锁栈式分配器

```
问题：
  ① _handles[32] 为什么刚好 32？
     线索: jniHandles.hpp 的 block_size_in_oops 常量定义
     答案方向: 32 × 8 = 256 字节 = 4 × 64 字节（x86 L1 cache line）。
     数字选择的权衡：太小 → block 链太长（alloc/free 开销增加）；太大 → 浪费内存
     （大部分 JNI 方法 ≤10 个 LocalRef）。32 是经验和缓存的平衡点。
     追问: 如果改成 64 会怎样？128 呢？— 从 cache utilization 和内存浪费角度论证。

  ② _top/_next/_pop_frame_link 三个指针的分工？
     线索: jniHandles.hpp JNIHandleBlock 字段定义
     答案方向: _top: 当前 block 的空闲 slot 索引（0~31），分配 `_handles[_top++] = ref`
     _next: 下一个 block（同 frame 内 block 链），遍历从 _active_handles 开始沿此链走
     _pop_frame_link: 上一个 frame 的 block 链起点，PushLocalFrame 时被设置
     ★ 关键: _next 和 _pop_frame_link 是正交的两个链表维度——_next 是水平方向（同 frame
     内 block 溢出链），_pop_frame_link 是垂直方向（嵌套 frame 栈）。

  ③ PushLocalFrame/PopLocalFrame 的 _pop_frame_link 怎么实现 checkpoint 回滚？
     线索: jni.cpp 中 jni_PushLocalFrame / jni_PopLocalFrame + jniHandles.cpp allocate_block
     答案方向: PushLocalFrame(capacity): 保存当前 block → 新 block → _pop_frame_link 指旧块
     PopLocalFrame(result): 回滚 _top 到 frame 初值 → _pop_frame_link 恢复。
     追问: 如果 capacity > 32（一个 block 的槽数）怎么办？→ 分配多个 block 的链。
     追问: PopLocalFrame 释放内存吗？— 不释放，只回滚 _top。GC 遍历时通过 _pop_frame_link
     仍然能扫描到上层 frame 的 block。

  ④ allocate_block() 的三级分配池：
     线索: jniHandles.cpp:384-425 allocate_block()
     答案方向: (1) JavaThread::_free_handle_block — 线程本地，完全无锁。优先取。
     (2) JNIHandleBlock::_block_free_list — 全局链表，JNIHandleBlockFreeList_lock 保护。
     (3) new JNIHandleBlock() — 最慢但保证有。block->_top = 0。
     ★ 隐藏读者: GC thread 在 safepoint 中扫描 _active_handles 链——不参与分配/释放路径。

  ⑤ DeleteLocalRef 为什么不等同于 free()？
     线索: jniHandles.inline.hpp:97-102 destroy_local()
     答案方向: destroy_local() 只做 `NativeAccess<>::oop_store(jobject_ptr(handle), (oop)NULL)`
     — 只写 NULL。GC 的 JNIHandleBlock::oops_do() 看到 NULL → 跳过（`if (value != NULL)`）。
     但 slot 不会被复用——_top 继续向前推，allocate_handle() 分配 _handles[_top++]。
     ★ 反例分析: 如果 DeleteLocalRef 真正 free 了 slot 并被复用——GC 可能通过旧的 jobject
     （另一个线程持有？但 LocalRef 是线程本地的...）访问到错误的对象。所以"只写 NULL 不释放"
     是安全性的保证。
```

### 4.2 ★★★ make_global() — GlobalRef 的诞生（逐行分析动机）

```
问题：
  ① make_global() 的 4 个断言逐行分析：
     线索: jniHandles.cpp:101-124
     L102: assert(!Universe::heap()->is_gc_active())
       为什么 GC 期间不能新增 root？
       → GC 标记阶段已确定 root set，此时新增引用 → 新对象可能不会被标记（因为标记已过）
       → 被错误回收。这是 GC 一致性的硬约束。
     L103: assert(!current_thread_in_native())
       为什么 native 中不能操作 JVM 内部数据结构？
       → [01]§二: 线程必须在 _thread_in_vm 中才能安全操作 JVM 内部结构。
       且 OopStorage 的 allocate() 虽然用 CAS，但 native 中调用会导致 safepoint 无法正确处理此线程。
     L109: assert(oopDesc::is_oop(obj()), "not an oop")
       纯防御——传入的不是有效 oop → 崩溃。
     L113: assert(*ptr == NULL, "invariant")
       新分配的 OopStorage slot 必须是 NULL——确保没有复用未清理的旧值。

  ② NativeAccess<>::oop_store(ptr, obj()) 为什么不直接用 *ptr = obj()？
     线索: oopAccess.hpp / access.hpp 的 NativeAccess 定义
     答案方向: NativeAccess<> 默认包含 AS_RAW 语义——绕过 GC barrier。
     在 OopStorage 中写入 oop 不需要 GC barrier（OopStorage 是 GC root，不是堆内对象）。
     直接用 *ptr = obj() 在某些平台（AArch64）上缺少必要的 memory order 保证。
     Make_weak_global 用 NativeAccess<ON_PHANTOM_OOP_REF>——额外的 phantom ref 标记。

  ③ allocate() 返回 NULL 的两种处理策略:
     线索: jniHandles.cpp:90-98 report_handle_allocation_failure()
     答案方向: AllocFailStrategy::EXIT_OOM → vm_exit_out_of_memory → JVM 致命退出
     AllocFailStrategy::RETURN_NULL → make_global 返回 NULL → JNI 层 jni_NewGlobalRef 返回 NULL
     → 根据 JNI 规范，NewGlobalRef 返回 NULL 表示 OOM → Java 层抛 OutOfMemoryError。
     追问: OopStorage 什么时候 allocate() 返回 NULL？— Block::new_block() 的内存分配失败
     （new 操作符抛 std::bad_alloc 或返回 NULL，取决于平台）。

  ④ make_global() 和 make_weak_global() 的 5 个精确差异：
     线索: jniHandles.cpp:101 vs :127
     差异1: 不同 OopStorage — global_handles() vs weak_global_handles()
     差异2: NativeAccess decorator — 默认 vs ON_PHANTOM_OOP_REF
     差异3: 返回值编码 — 强: `(jobject)ptr`；弱: `(jobject)((char*)ptr + weak_tag_value)`
     差异4: GC 扫描时 — 强: JNIHandles::oops_do() → oops_do(cl)；
            弱: JNIHandles::weak_oops_do(is_alive, cl) → weak_oops_do()
     差异5: destroy 时 — 强: destroy_global() → assert(!is_jweak) → global_handles()->release()；
            弱: destroy_weak_global() → assert(is_jweak) → weak_global_handles()->release()
```

### 4.3 ★★★ OopStorage 的无锁并发设计 — CAS + RCU + 双锁分离

```
问题：
  ① Block::allocate() 的 CAS 循环 — 逐行解析:
     线索: oopStorage.cpp:302-315
     答案方向: ① load _allocated_bitmask → ② count_trailing_zeros(~allocated) 找空闲位
     → ③ new_value = allocated | bitmask_for_index(i) → ④ CAS(&bitmask, allocated, new_value)
     → ⑤ 成功 → 返回 get_pointer(i)；失败 → 重试（读最新 allocated）。
     bitmap 是 uintx（64位），一次 CAS 覆盖 block 内最多 64 个 slot 的分配竞争。
     追问: 为什么不用锁？— safepoint 期间可能仍有 allocate 调用（如 weak ref 处理），
     锁在 safepoint 中可能导致死锁。CAS 是 lock-free，safepoint 安全。

  ② ActiveArray 的 RCU 式读取 — 为什么 GC 遍历不需要锁:
     线索: oopStorage.cpp:523-528 obtain_active_array()
     答案方向: obtain_active_array() → load_acquire(&_active_array) → increment_refcount()。
     GC iterator（ParState）持有 ActiveArray 的引用计数——即使扩容替换了指针，旧 array 仍然有效
     （refcount > 0）。relinquish_block_array() 递减 refcount → 如果到零 → delete。
     ★ 关键: 这不是 _active_mutex 锁——是引用计数 + acquire/release 内存序的 lock-free RCU。
     追问: _active_mutex 什么时候用？— 只在 replace_active_array() 中获取，保护扩容/缩容的
     原子性。历史原因——和 `_allocation_mutex` 一起形成两把锁的层次结构。

  ③ replace_active_array() 的 SingleWriterSynchronizer — 怎么等所有读者退出？
     线索: oopStorage.cpp:502-516
     答案方向: ① 设 _active_array = new_array（release_store）→ ② _protect_active.synchronize()
     → 阻塞直到所有 obtain_active_array() 中的 CriticalSection 退出 → ③ 旧 array 的
     refcount 只剩自己的那份 → 安全释放。
     追问: 为什么不用 GlobalCounter？— 注释明确说明：allocate() 可能在 GlobalCounter
     临界区内被调用（如 StringTable 插入时），使用 GlobalCounter 会导致死锁。
```

### 4.4 ★★ GC Root Scanning — JNI Handles 在 root set 中的位置

```
问题：
  ① genCollectedHeap::process_roots() 中 JNIHandles 的确切位置：
     线索: genCollectedHeap.cpp:782-850
     答案方向: JNIHandles::oops_do(strong_roots) 在 L811，和下列 root 并列：
     L797: ClassLoaderDataGraph（类加载器元数据）
     L804: Threads::possibly_parallel_oops_do（所有线程栈 + LocalRef）
     L807: Universe::oops_do（Universe 静态字段）
     L828: SystemDictionary::oops_do（已加载类）
     ★ 追问: 为什么 Threads::oops_do 和 JNIHandles::oops_do 是分开的？— 因为
     LocalRef（线程栈内）和 GlobalRef（OopStorage 内）存储位置不同——GC 需要分开扫描。

  ② JNIHandleBlock::oops_do() 的双重链表遍历逻辑：
     线索: jniHandles.cpp:473-498
     答案方向: 外层循环 current_chain = this → current_chain = current_chain->pop_frame_link()
     内层循环 current = current_chain → current = current->_next
     对每个 current: for index 0.._top: oop value = _handles[index]; 
     if value != NULL && heap->is_in_reserved(value) → f->do_oop(root)
     ★ 追问: 为什么需要 is_in_reserved() 检查？— _handles 中可能有非 oop 的值（如
     _free_list 指针、未初始化 slot），必须区分。只有指向 Java 堆的才是真正的 oop。

  ③ 强 GlobalRef vs Weak GlobalRef 在 GC 中的分流:
     线索: oopStorage.inline.hpp:382 oops_do() vs :392 weak_oops_do()
     答案方向: oops_do(cl) → iterate_safepoint(oop_fn(cl)) — 无条件 apply
     weak_oops_do(cl) → iterate_safepoint(skip_null_fn(oop_fn(cl))) — 跳过 NULL
     weak_oops_do(is_alive, cl) → iterate_safepoint(if_alive_fn(is_alive, oop_fn(cl)))
     — 先判断是否还活着。不活 → GC 自动清 NULL → 下次 weak_oops_do 的 skip_null_fn 跳过。
     ★ 隐藏读者: skip_null_fn — 它不单独做任何事。它包装 oop_fn，在调用前检查值是否为 NULL。

  ④ G1 GC 也走 JNIHandles::oops_do() 吗？
     线索: 搜索 G1RootProcessor::process_java_roots() 的实现
     答案方向: G1 有自己的 root processor，但同样调用 JNIHandles::oops_do(strong_roots)。
     底层遍历 OopStorage 的接口是统一的——不管 GenCollectedHeap、G1、Parallel 还是 Shenandoah，
     都通过 JNIHandles::oops_do() → OopStorage::oops_do() 扫描 GlobalRef。
     追问: 那为什么本文用 genCollectedHeap 而不是 g1CollectedHeap 做例子？— G1 的
     process_java_roots 内部引用更多 g1 特定逻辑，genCollectedHeap 的 process_roots 更清晰
     展示 root set 的完整清单（L797-L828 逐行列出）。
```

### 4.5 ★★ `jweak` 的标签编码 — 最低 bit 的妙用

```
问题：
  ① is_jweak() 的精确实现：
     线索: jniHandles.inline.hpp:34-38
     答案方向: STATIC_ASSERT(weak_tag_size == 1); STATIC_ASSERT(weak_tag_value == 1);
     return (reinterpret_cast<uintptr_t>(handle) & weak_tag_mask) != 0;
     — 检查最低 bit。如果 bit 0 == 1 → 是 jweak；bit 0 == 0 → 是 jobject。
     追问: 为什么选 bit 0 而不是 bit 63（高位）？— oop* 地址对齐保证 bit 0-2（32bit 4字节对齐）
     或 bit 0-3（64bit 8字节对齐）永远为 0。bit 0 是最简单、最不干扰的标记位。
     追问: 如果 JVM 跑在 32-bit 上呢？— 32-bit 上 oop* 也是 4 字节对齐，bit 0-1 始终为 0——同样安全。

  ② jweak_ptr() 怎么解码？
     线索: jniHandles.inline.hpp:45-48
     答案方向: char* ptr = (char*)(handle) - weak_tag_value → (oop*)(ptr)
     即 handle - 1 → 去掉 tag → 得到真正的 oop* 地址。
     追问: 为什么不直接用 (oop*)((uintptr_t)handle & ~1) 清除 bit？—
     两种方式等价。`-1` 在 tag 位置不为 0 时等同于 `& ~1`，但 `-1` 更直接表达"去掉 tag"的语义。

  ③ make_weak_global() 怎么设置 tag？
     线索: jniHandles.cpp:139-140
     答案方向: oop *ptr = weak_global_handles()->allocate() → 获取真正的 oop* 地址
     → char *tptr = (char*)(ptr) + weak_tag_value → (jobject)(tptr)
     — 在 oop* 地址上加 1（设置 bit 0 = 1）。
     追问: 这个 tag 是否影响 GC 遍历？— 不影响。GC 通过 OopStorage 的 Block 内 _data 数组
     直接访问 oop*（不经 jweak_ptr 解码），不关心 tag。tag 只在 JNI API 层面有意义。
```

### 4.6 ★★ LocalRef 的自动释放 — 在状态转换链中的精确位置

```
问题：
  ① LocalRef block 链在什么时候被释放（不是什么时候被 GC 扫描）？
     线索: JavaCallWrapper dtor、pop_jni_handle_block、release_block
     答案方向: ★ 这是一个需要从源码验证的问题。不像"native 返回时释放"那么简单。
     JavaCallWrapper::~JavaCallWrapper() 中调用了 set_active_handles(旧 handles 指针)
     → 恢复上一个 Java 调用帧的 handle block 链。
     push_jni_handle_block/pop_jni_handle_block 管理 block 链的压栈/出栈。
     追问: 如果不在 JavaCallWrapper 中，而是在纯 JNI 调用中——LocalRef 谁释放？
     → JNI_END 宏不直接释放 LocalRef——真正的释放发生在线程回到 native 后、下次进入 VM 前？
     需要 trace pop_jni_handle_block 的完整调用链。

  ② allocate_handle() 的分配逻辑 — _top 只增不减的含义：
     线索: jniHandles.cpp:501+ allocate_handle()
     答案方向: _handles[_top] = obj; _top++; return &_handles[_top-1];
     从不扫描空闲 slot——即使有 100 个被 DeleteLocalRef 设为 NULL 的 slot，_top 也不回退。
     追问: 那"复用"什么时候发生？— (a) PopLocalFrame 回滚 _top；(b) block 被 release_block
     释放后重新 allocate_block，_top 重置为 0。

  ③ _free_handle_block 线程本地缓存的生命周期：
     线索: thread.hpp _free_handle_block 字段
     答案方向: release_block 把不再需要的 block 放入 _free_handle_block。
     下次 allocate_block 优先从此取——热 block 缓存（TLAB 式思想）。
     线程退出时，_free_handle_block 链归还到全局 _block_free_list。
```

### 4.7 ★ jni.cpp 中的 JNI 函数注册 — 和 [01] 线程状态的接口

```
问题：
  ① jni_NewGlobalRef 的完整调用栈（从 JNI API 到 make_global）：
     线索: jni.cpp JNINativeInterface_ 函数表 → jni_NewGlobalRef 实现
     答案方向: JNI_ENTRY → ThreadInVMfromNative ctor → _thread_in_vm(6)
     → jni_NewGlobalRef 函数体 → JNIHandles::resolve() 把 jobject 转成 oop
     → Handle 包装 → JNIHandles::make_global(Handle, RET_NULL)
     → JNI_END → ThreadInVMfromNative dtor → _thread_in_native(4)
     ★ [01] 连接点: ThreadInVMfromNative ctor 调 trans_from_native → transition_from_native
     → poll——保证进入 VM 前确认无 safepoint 在进行。

  ② JNI_LEAF 函数和普通 JNI_ENTRY 函数的区别：
     线索: jni.cpp 中 JNI_LEAF 函数（如 GetVersion、GetJavaVM）
     答案方向: JNI_LEAF 不构造 ThreadInVMfromNative——线程不进入 _thread_in_vm，
     不能安全操作 JVM 内部数据结构。只能做纯计算或返回常量。
     追问: JNI_LEAF 函数中调 make_global 会怎样？— assert(!current_thread_in_native()) 失败→crash。

  ③ jni_DeleteLocalRef → destroy_local() 的调用链：
     线索: jni.cpp jni_DeleteLocalRef → jniHandles.inline.hpp destroy_local
     答案方向: jni_DeleteLocalRef 通过 JNI_ENTRY 进入 VM → 参数校验 → destroy_local(handle)
     → oop_store(ptr, NULL)。注意：不释放 block 内存——只是把 slot 标为 NULL。
     追问: jni_DeleteGlobalRef 的路径呢？— 同样 JNI_ENTRY → destroy_global(handle)
     → oop_store(ptr, NULL) → global_handles()->release(ptr) — 这里真的释放了 OopStorage entry！
     destroy_global 和 destroy_local 的本质差异：前者释放 OopStorage slot，后者只写 NULL。
```

## 五、文章结构

```
§〇 源文件清单（跨 runtime + gc/shared + prims，标注模块归属）

§一 ★ JNIHandleBlock 结构 — 线程本地的无锁栈式分配器
  ❓ 为什么用 block 链表而不是 vector/google::dense_hash_map？
  1.1 JNIHandleBlock 完整字段布局（ASCII art）：_handles[32] + _top + _next +
      _pop_frame_link + _free_list + _last + _allocate_before_rebuild
  1.2 allocate_block() 三级分配池（jniHandles.cpp:384-425）— thread-local → global → new
  1.3 allocate_handle() — _top 只增不减 + 不扫描空闲 slot 的设计动机
  1.4 PushLocalFrame/PopLocalFrame 的 _pop_frame_link checkpoint（含 capacity > 32 场景）
  1.5 LocalRef 在 Thread 对象中的挂载点：_active_handles + _free_handle_block 字段

§二 ★★★ make_global() — GlobalRef 的 4 断言 + OopStorage 对接（衔接 [06-GC]）
  ❓ jobject 到底是个什么类型？指针还是句柄？
  ❓ 为什么 make_global 有两个断言（!gc_active + !in_native）？
  2.1 make_global() 源码逐行（jniHandles.cpp:101-124）— 每行动机分析
  2.2 make_weak_global() 对比分析（jniHandles.cpp:127-148）— 5 个差异点
  2.3 OopStorage 内部结构：Block._data[] + _allocated_bitmask + ActiveArray
  2.4 Block::allocate() CAS 循环逐行（oopStorage.cpp:302-315）— count_trailing_zeros 找空闲位
  2.5 destroy_global/destroy_weak_global — 强 vs 弱的释放差异

§三 ★★★ OopStorage 的无锁并发 — CAS + RCU + 双锁分离
  ❓ 为什么 CAS 而不是锁？safepoint 期间 allocate 会死锁吗？
  ❓ GC 遍历 OopStorage 时真的不需要锁吗？（验证 obtain_active_array 不是锁）
  3.1 ActiveArray 引用计数机制（oopStorage.cpp:523-528）— load_acquire + increment_refcount
  3.2 replace_active_array() 的 SingleWriterSynchronizer（oopStorage.cpp:502-516）
  3.3 _allocation_mutex vs _active_mutex 的 rank 层级（构造函数 :734-735 assert）
  3.4 release() 与 _deferred_updates — 延迟释放机制（oopStorage.cpp:676-682）

§四 ★★ GC Root Scanning 中的 JNI Handles（衔接 [06-GC]）
  ❓ GC 怎么知道 GlobalRef 指向了哪个对象？
  ❓ LocalRef 在 GC root set 的哪个位置？
  4.1 GC root set 全景表（≥10 类 root，genCollectedHeap.cpp:797-828 逐行标注）
  4.2 JNIHandles::oops_do(strong_roots) → OopStorage::oops_do() → iterate_safepoint() 完整调用链
  4.3 JNIHandleBlock::oops_do() 双重链表遍历（jniHandles.cpp:473-498）— _next + _pop_frame_link
  4.4 强 vs 弱 GlobalRef 的分流：oops_do vs weak_oops_do(is_alive) + skip_null_fn
  4.5 ★ 隐藏读者分析：GC thread 无锁读 active_handles + OopStorage Block[] + bitmap

§五 ★★ jweak 标签编码 — is_jweak() 的 bit 0 技巧（jniHandles.inline.hpp:34-48）
  ❓ 为什么选 bit 0 而不是更高位或单独字段？
  5.1 is_jweak() 实现 — STATIC_ASSERT weak_tag_size == 1
  5.2 jweak_ptr() 解码 — `(char*)handle - weak_tag_value`
  5.3 make_weak_global() 中 tag 设置 — `(char*)ptr + weak_tag_value`
  5.4 为什么 GC 遍历不受 tag 影响 — OopStorage._data[] 存的是原始 oop*，不经 jweak_ptr 解码

§六 ★ LocalRef vs GlobalRef vs WeakGlobalRef 三元对比
  ❓ DeleteGlobalRef 是立即释放还是标记释放？
  6.1 三种引用完整对比表（≥12 维度）：创建函数:行号、存储位置、分配方式、
      锁需求、GC root 类型、GC 扫描入口:行号、释放函数:行号、释放语义、slot 复用、
      生命周期、内存开销、JNI 规范上限
  6.2 生命周期自动机（Mermaid）：每种引用的状态转换
  6.3 面试陷阱集：
      - NewGlobalRef 返回的 jobject 能在 native 方法返回后继续使用吗？→ 能但不 Delete → 内存泄漏
      - DeleteLocalRef 后 jobject 还能用吗？→ 不能——slot 可能被后续 NewLocalRef 覆盖（但不会被复用）
      - 65535 个 LocalRef 上限在哪个层面检查？→ JNI 规范层，不在 JNIHandleBlock 中

§七 ★ 和 [01] 的交叉验证
  7.1 current_thread_in_native() 断言的完整调用栈（从 JNI_ENTRY → ThreadInVMfromNative → make_global）
  7.2 make_global() 的 !is_gc_active() 断言 — safepoint 期间创建 GlobalRef 的危害
  7.3 Thread::oops_do() 在 safepoint 中的调用时机 — GC root scanning 阶段的精确位置
  7.4 [01]§二 transition_from_native → poll 和本文 destroy_local 的时间线关系

§八 GDB 验证 + 可证伪断言（≥12 条）
  断言 1: JNIHandleBlock._top 从 0 增长到 32 的完整过程
    (gdb) break JNIHandleBlock::allocate_handle; p this->_top; c  # 多次观察 _top++
  断言 2: block 链表结构 — _next 链遍历
    (gdb) p *(JNIHandleBlock*)thread->_active_handles; p *((JNIHandleBlock*)...)->_next
  断言 3: PushLocalFrame/PopLocalFrame 前后 _top 和 _pop_frame_link 变化
  断言 4: make_global() → global_handles()->allocate() — oop* 地址范围（应在 OopStorage Block 内）
    (gdb) p ptr; p/x (uintptr_t)ptr; # 检查是否在 OopStorage 预期的地址范围
  断言 5: OopStorage Block._allocated_bitmask 在分配/释放时的 CAS 变化验证
    (gdb) break OopStorage::Block::allocate; p/x this->_allocated_bitmask; next; p/x this->_allocated_bitmask
  断言 6: GC 期间 JNIHandles::oops_do() 的完整调用栈（断点 JNIHandleBlock::oops_do）
  断言 7: Weak GlobalRef 在 GC 后被自动清 NULL — `p *(oop**)handle` before/after GC
  断言 8: DeleteGlobalRef 后 OopStorage release() → Block::release_entries() 的 bitmap 更新
  断言 9: is_jweak() 验证 — (uintptr_t)jweak_handle & 1 == 1
  断言 10: destroy_local() — slot 内容变 NULL 但 _top 不变
    (gdb) p block->_handles[n]; p block->_top; # n < _top; 执行 DeleteLocalRef;
    p block->_handles[n]  # 应为 NULL; p block->_top  # 应该不变
  断言 11: make_global() 的 current_thread_in_native() 断言验证
    (gdb) break JNIHandles::make_global; p JavaThread::current()->thread_state()  # 应为 _thread_in_vm(6)
  断言 12: JNIHandleBlock::oops_do() 双重链遍历 — 验证 _next 和 _pop_frame_link 都被遍历
    (gdb) break JNIHandleBlock::oops_do; 检查 current_chain 和 current 的遍历路径

  可证伪断言 1: 如果 make_global 在 _thread_in_native 中被调用 → assert(!current_thread_in_native()) 崩溃
  可证伪断言 2: 如果 make_global 在 GC 期间被调用 → assert(!is_gc_active()) 崩溃
  可证伪断言 3: 如果 DeleteLocalRef 后不 NewLocalRef（不分配新 block），slot 不会被覆盖
  可证伪断言 4: NewWeakGlobalRef → GC → weak ref 被清 NULL → is_global_weak_cleared() 返回 true
  可证伪断言 5: OopStorage Block::allocate() 的 CAS 在 bitmap 已满时永远不会成功（无限循环）
```

## 六、写作要求

**最关键的一条**：以 [01] 的写作风格为参考——以"❓ 为什么..."开头，先建立设计动机，再用源码做证据。本文是 [01] 的"数据面"，必须保持一致性。

1. **★ `make_global()` 逐行分析是全文第一个核心交付物**：`jniHandles.cpp:101-124`，每行必须回答"为什么这个断言存在""为什么这个调用不能简化"。这不是翻译——是设计决策的回溯。

2. **★ OopStorage 的 CAS 分配 + RCU 读取是全文第二个核心交付物**：`Block::allocate()` 的 CAS 循环（`oopStorage.cpp:302-315`）必须逐行走读。追问"如果 CAS 一直失败怎么办"→ bitmap 满时死循环（这是设计意图——等待其他线程 release slot）。

3. **★ `jweak` 的标签编码是本文的独特贡献**：`weak_tag_value = 1`，为什么用 bit 0？为什么 oop* 地址的最低位永远是 0？这个设计在其他代码中不明显——是本文"挖出来"的概念。

4. **★ "隐藏读者"分析是 JVM 源码分析的核心能力**：GC thread 无锁读 `_active_handles` 链和 OopStorage Block[]；VMThread 无锁读 `_thread_state`。标注每个隐藏读者的"在哪读""读什么""为什么不加锁"。

5. **★ 和 [01] 的交叉引用必须精确到节**：[01]§二 transition_from_native、[01]§四.1 JNI 上/下行路径、[01]§一.3 JavaThreadState 枚举——`current_thread_in_native()` 断言直接依赖这些概念。

6. **★ GDB 验证必须可执行**：每条断言给出具体的 GDB 命令和预期输出。不可执行的伪断点无效。

7. **★ 生命周期 Mermaid 图**：GlobalRef: create → [rooted in OopStorage] → DeleteGlobalRef → [released]。LocalRef: create → [in block, GC scanned] → PopLocalFrame / frame exit → [block released]。Weak GlobalRef: create → [in weak OopStorage] → GC → is_alive? → [cleared / still alive]。

## 七、输出格式

- Markdown 文件，命名为 `02-JNI-Reference-Management.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/09-native-interface/`
- 元信息头（标准环境 + 源文件清单 + 前置 [09-01][06-GC] + 阅读收益 + "09 阶段数据面，阅读顺序第二"的说明）
