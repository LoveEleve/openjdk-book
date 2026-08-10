# PROMPT: 请撰写 13-JVM-Reference-Finalizer.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**"一条 `discovered` 字段的三重身份" — ReferenceHandler + FinalizerThread 的 C++/Java 双层引用处理流水线**

### 核心故事线（禁止做源码翻译机！）

前十二篇文章已经覆盖了线程全生命周期 [05-06]、VMThread [07]、WorkerThread [08]、10 个 JavaThread [09]、NonJavaThread [10]、AttachListener [11]、ServiceThread [12]。在 [09] 的 jstack 输出中，你第一次见到了 `"Reference Handler"`（#2）和 `"Finalizer"`（#3）——它们是 `create_vm()` 中**隐式创建**的两条 JavaThread，daemon=true，优先级极端（MAX_PRIORITY 和 NORM_PRIORITY）。

现在要回答一个面试级的问题：**`new WeakReference(obj, queue)` 之后到底发生了什么？obj 被 GC 回收 → WeakReference 入队 → queue.remove() 解除阻塞——这中间经历了一条跨越**两个语言边界**（C++ → Java → 用户代码）的完整流水线。**

这条流水线最精妙的设计不是一个"线程处理一件事"，而是 **一个 `discovered` 字段在三个不同阶段的三种不同身份**——GC 阶段的 discovered 链表节点、pending 阶段的单向链表节点、入队阶段被重置为 null——这个字段是 C++ 层和 Java 层之间唯一的"交接点"。

**本文的核心叙事线**是一条从"对象被 GC 标记为垃圾"到"用户代码收到通知"的完整追溯链：

1. **为什么需要 ReferenceHandler？为什么不是 GC 线程直接入队？**— [10] 中你知道 GC 线程是 NonJavaThread——不能执行 Java 层代码。但 `ReferenceQueue.enqueue(ref)` 需要访问 Java 堆上的 `ReferenceQueue` 对象。所以需要一个 **JavaThread** 作为中介：GC（C++）→ pending list（C++ 写）→ ReferenceHandler（JavaThread 读）→ ReferenceQueue（Java）。这是 C++/Java 双语言协作的经典模式。

2. **★ 为什么 Finalizer 不走 ReferenceHandler？**— Finalizer 继承 `FinalReference<Object>`（是 Reference 的子类），但它**不走 ReferenceQueue**。它用自己独立的 `unfinalized` 双向链表 + 独立的 `FinalizerThread`。为什么？因为 Finalizer 需要保活对象直到 `finalize()` 执行完毕——普通的 Reference 在 GC 发现 referent 已死后就可以清理，但 Finalizer 必须**先执行 finalize()、再清理 referent**。这个时序差异导致它需要独立的处理通道。

3. **★★★ GC 如何"发现" Reference？— ReferenceProcessor 的 4 种类型处理顺序**：Soft → Weak → Final → Phantom。这不是随机排序——每种类型有完全不同的存活判定规则：
   - **SoftReference**：有 LRU 时钟策略——`SoftRefLRUPolicyMSPerMB`（默认 1000ms/MB）——堆内存越紧张，SoftReference 存活时间越短
   - **WeakReference**：referent 只要没有强引用就死
   - **FinalReference**：referent 即使死了也要先保活运行 finalize()，然后再死
   - **PhantomReference**：referent 死了立即入队，但 `get()` 永远返回 null——它是"资源释放哨兵"不是"对象访问代理"

4. **★ `discovered` 字段的三重身份**— 这是全文最精妙的数据结构设计：
   ```
   阶段 1 (GC discovered): discovered = 下一个被 GC 发现的 Reference (GC 线程写, 无锁)
   阶段 2 (Pending):        discovered = pending list 中的下一个节点 (C++→Java 交接, 有 ProcessPendingListLock)
   阶段 3 (Enqueued):       discovered = null (重置, 由 ReferenceHandler 做)
   ```
   同一个字段，三种语义，零额外内存开销。C++ 层通过 `discovered` 字段的偏移量直接访问 Java 对象的内存——这是 JVM 内部才有的"特权"。

5. **★ Finalizer 的 `unfinalized` 双向链表**— `Finalizer.register(finalizee)` 由 JVM 解释器在对象创建时调用。每个有 `finalize()` 方法的对象在 new 的时候就被**提前注册**到这条链表中——而不是等到 GC 发现它死了再说。GC 发现 Finalizer 的 referent 已死后，从 `unfinalized` 链表中移除并加入 FinalizerThread 的 queue。

6. **★★ 为什么 Finalizer 的内存屏障这么特殊？**— Finalizer 的 `finalize()` 方法执行完毕后，对象需要**再次**经过 GC 才能真正被回收。这意味着一个有 `finalize()` 的对象至少需要**两次 GC** 才能被回收——第一次 GC 发现它死了，把它交给 Finalizer；第二次 GC 在 finalize() 执行后才真正回收它。

7. **ReferenceHandler 是 MAX_PRIORITY（最高优先级）**— 为什么？因为 Cleaner（如 DirectByteBuffer 的 Cleaner）走 ReferenceHandler 的 `processPendingReferences()` 路径。如果 ReferenceHandler 被低优先级任务阻塞 → DirectByteBuffer 的堆外内存不能及时释放 → Native OOM。MAX_PRIORITY 确保 Cleaner 立即执行。

8. **ReferenceHandler 和 FinalizerThread 的隐式创建**— 和 ServiceThread 的 `create_vm()` 显式创建不同，ReferenceHandler 在 `Reference.java` 的 `<clinit>` 静态初始化块中创建，FinalizerThread 在 `Finalizer.java` 的 `<clinit>` 中创建——这两个类的初始化时机由 JVM 控制：**在 `create_vm()` 中通过 native 方法触发类加载**。

### 禁止行为

- ❌ 把 Reference 的 4 种类型写成 "Soft=内存敏感, Weak=弱引用, ..." 的字典——这是 JDK 文档，不是源码分析
- ❌ 忽略 `discovered` 字段的三重身份——这是 C++ 和 Java 之间唯一的零拷贝交接点
- ❌ 忽略 ReferenceHandler 和 FinalizerThread 为什么是两条独立线程——为什么不能合并？为什么 Finalizer 不走 ReferenceHandler？
- ❌ 忽略 4 种引用类型的处理顺序——Soft→Weak→Final→Phantom 是有原因的（Soft 需要 LRU 评估存活，Phantom 最后处理因为不需要保活 referent）
- ❌ 忽略 Cleaner 的特殊路径——Cleaner 不走 ReferenceQueue，直接调用 `clean()` ——这是 DirectByteBuffer 堆外内存释放的唯一通道
- ❌ 忽略 Finalizer 的"两次 GC"问题——对象需要两轮 GC 才能被回收，这是 finalize() 的性能代价
- ❌ 不画三层流水线的全链路图——GC discovered → pending list → ReferenceHandler → ReferenceQueue → 用户代码

### 要求行为

- ✅ **★ GC → pending list 的全链路**：`ReferenceProcessor::discover_reference()` → `process_discovered_references()` → `add_to_pending_list()` → `pending_list_head` 的链表操作 → 为什么用头插法（CAS 原子操作）
- ✅ **★ Native 方法桥梁**：`getAndClearReferencePendingList()` 如何原子取走 pending list → JNI 如何暴露 `discovered` 字段偏移量 → Java 层如何遍历
- ✅ **★ ReferenceHandler 主循环深度走读**：`processPendingReferences()` 的每步——waitForPendingList → getAndClear → 遍历 → Cleaner.clean() / queue.enqueue()
- ✅ **★ FinalizerThread 独立通道**：`Finalizer.register()` → `unfinalized` 链表 → GC 发现 → 移入 FinalizerThread queue → `FinalizerThread.run()` → `finalize()`
- ✅ **★ 4 种引用类型的存活判定差异**：SoftRefPolicy(clock) vs Weak(no ref) vs Final(must run finalize) vs Phantom(always dead, get()=null)
- ✅ **★ 三层流水线完整时序图**：GC → pending → ReferenceHandler → Queue → User
- ✅ GDB 验证：`info threads` 看 ReferenceHandler(#2) + FinalizerThread(#3)、`p ReferenceProcessor::_pending_list_head` 看链表、`p Finalizer::unfinalized` 看双向链表、验证 MAX_PRIORITY
- ✅ 交叉引用 [09 §3.1-3.2] ReferenceHandler + FinalizerThread 创建入口 + [06] JavaThread 生命周期 + [10] NonJavaThread 对比（为什么 GC 线程不能做）

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 默认 mixed mode（Tiered Compilation 开启）
- 64 位 Linux x86
- ★ ReferenceHandler 在 `Reference.java` `<clinit>` 中创建，FinalizerThread 在 `Finalizer.java` `<clinit>` 中创建——这两次类加载由 `create_vm()` 中的 VM 初始化代码触发
- ★ ReferenceHandler = MAX_PRIORITY(10)，FinalizerThread = NORM_PRIORITY(5)
- ★ 两个线程都是 daemon=true
- ★ G1 下 ReferenceProcessor 在 Remark pause 中调用 `process_discovered_references()`（STW），不同 GC 的实现位置不同——本文以 G1 为例，但核心算法是所有 GC 共享的

## 三、聚焦源文件

> ★★★ **读码顺序铁律**（违反必翻车）:
> 1. 先读 `Reference.java` — 理解 `ReferenceHandler` 内部类 + `processPendingReferences()` 主循环 + 三个 native 方法
> 2. 再读 `referenceProcessor.hpp` — 理解 `ReferenceProcessor` + `DiscoveredList` + 4 种类型的处理阶段
> 3. 再读 `referenceProcessor.cpp` — 理解 `discover_reference()` + `process_discovered_references()` + `add_to_pending_list()` — **这是 C++ 层的核心**
> 4. 再读 `Finalizer.java` — 理解 `FinalizerThread` + `unfinalized` 双向链表 + `register()` — 为什么 Fork 了 ReferenceHandler
> 5. 再读 `jni.cpp` — 理解三个 native 方法的 JNI 实现 → `JVM_GetAndClearReferencePendingList` 等
> 6. ★ 最后理解 `discovered` 字段的三重身份 + `pending_list_head` 原子操作 — 这是全文设计精髓

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `Reference.java` | `src/java.base/share/classes/java/lang/ref/Reference.java` | `ReferenceHandler`(~190), `processPendingReferences()`(~236), `getAndClearReferencePendingList()`(~221) | ★★★ Java 层核心 — ReferenceHandler 主循环 + native 桥梁 |
| 2 | `referenceProcessor.hpp` | `src/hotspot/share/gc/shared/referenceProcessor.hpp` | `ReferenceProcessor`, `DiscoveredList` | ★★ C++ 层核心 — discover + process + pending 管理 |
| 3 | `referenceProcessor.cpp` | `src/hotspot/share/gc/shared/referenceProcessor.cpp` | `discover_reference()`, `process_discovered_references()`, `add_to_pending_list()` | ★★★ C++ 层核心实现 — 4 种类型处理全流程 |
| 4 | `Finalizer.java` | `src/java.base/share/classes/java/lang/ref/Finalizer.java` | `FinalizerThread`, `unfinalized` 双向链表, `register()` | ★★ Finalizer 独立通道 — 双向链表 + 独立线程 |
| 5 | `jni.cpp` | `src/hotspot/share/prims/jni.cpp` | `JVM_GetAndClearReferencePendingList()`, `JVM_HasReferencePendingList()`, `JVM_WaitForReferencePendingList()` | ★ Native 方法实现 — C++/Java 交接桥梁 |
| 6 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | `create_vm()` 中触发 `Reference.class`/`Finalizer.class` 初始化的路径 | ★ 隐式创建时机 — 类加载触发线程创建 |
| 7 | `referencePolicy.hpp` | `src/hotspot/share/gc/shared/referencePolicy.hpp` | `SoftRefPolicy`, `SoftRefLRUPolicyMSPerMB` | ★ SoftReference 的 LRU 时钟策略 |
| 8 | `interpreterRuntime.cpp` | `src/hotspot/share/interpreter/interpreterRuntime.cpp` | `InterpreterRuntime::register_finalizer()` | ★ Finalizer.register() 的 VM hook — 对象创建时触发 |
| 9 | `oop.inline.hpp` | `src/hotspot/share/oops/oop.inline.hpp` | `oopDesc::obj_field_put()`, `obj_field()` | C++ 层如何读写 Java 对象的 discovered 字段 |
| 10 | `mutexLocker.cpp` | `src/hotspot/share/runtime/mutexLocker.cpp` | 搜索 `ReferencePending` 或 `Finalizer` 相关锁 | 并发保护锁（注意：锁名可能因版本而异，需搜索确认） |

## 四、必须深度走读的核心概念

### 4.1 ★★★ 三层引用处理流水线 — 全文核心

```
┌─★★★ Layer 1: GC 线程 (C++) ─────────────────────────────────────────────────┐
│                                                                              │
│  GC 并发标记阶段:                                                             │
│    ReferenceProcessor::discover_reference(obj, type):                        │
│      → 判断 referent 是否存活 (被强引用持有)                                   │
│      → 如果存活 → 什么都不做 (referent 还活着, 不需要处理)                      │
│      → 如果已死 → 将 Reference 加入对应类型的 DiscoveredList                  │
│        (Soft→_discoveredSoftRefs, Weak→_discoveredWeakRefs, ...)             │
│                                                                              │
│  GC remark/cleanup 阶段:                                                      │
│    ReferenceProcessor::process_discovered_references():                      │
│      → 遍历 4 种 DiscoveredList, 按序处理:                                    │
│                                                                              │
│        Phase 1 (SoftReference):                                              │
│          → SoftRefPolicy::should_clear_reference() — LRU 时钟判断              │
│          → 若 clock < interval → 暂不清除 (保留 SoftReference)                │
│          → 若 clock ≥ interval → 清除 referent → 加入 pending_list           │
│                                                                              │
│        Phase 2 (WeakReference):                                              │
│          → 只要 referent 没有强引用 → 直接清除 + 加入 pending_list              │
│                                                                              │
│        Phase 3 (FinalReference):                                             │
│          → referent 已死 → 但不加入 pending_list！                             │
│          → 而是: keep_alive(referent) → 保留对象直到 finalize() 完成            │
│          → Finalizer 从 unfinalized 链表移到 FinalizerThread queue            │
│                                                                              │
│        Phase 4 (PhantomReference):                                           │
│          → referent 已死 → 加入 pending_list                                  │
│          → 但 PhantomReference.get() 永远返回 null — 不暴露 referent            │
│                                                                              │
│    所有准备好入队的 Reference → ReferenceProcessor::add_to_pending_list():     │
│      → 头插法: ref.discovered = _pending_list_head                           │
│      → CAS: _pending_list_head = ref                                          │
│      → notify ReferenceHandler 线程                                           │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                      ↓
                        pending_list (C++ 维护的单向链表)
                                      ↓
┌─★★★ Layer 2: ReferenceHandler (JavaThread) ──────────────────────────────────┐
│                                                                              │
│  ReferenceHandler.run() → processPendingReferences():                         │
│                                                                              │
│    ① waitForReferencePendingList():                                          │
│       → native 阻塞等待 → 等效于 park() 在 pending_list 上                     │
│       → 被 GC 线程通知后返回                                                   │
│                                                                              │
│    ② synchronized(processPendingLock) {                                       │
│         pendingList = getAndClearReferencePendingList();  // ★ 原子取走全部      │
│         // 内部: _pending_list_head 的 CAS = NULL → 返回旧值                   │
│       }                                                                       │
│                                                                              │
│    ③ while (pendingList != null) {                                            │
│         ref = pendingList;                                                    │
│         pendingList = ref.discovered;  // ★ discovered = 链表 next 指针         │
│         ref.discovered = null;          // ★ 重置为第三阶段身份 (inactive)       │
│                                                                              │
│         if (ref instanceof Cleaner):                                          │
│           ((Cleaner)ref).clean();       // ★ 直接执行！不走 ReferenceQueue       │
│           // Cleaner = DirectByteBuffer 的堆外内存释放 → 必须立即执行             │
│         else:                                                                 │
│           ReferenceQueue q = ref.queue;                                      │
│           if (q != NULL) q.enqueue(ref);  // ★ 加入用户可见的 ReferenceQueue    │
│       }                                                                       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                      ↓
                        ReferenceQueue (Java 队列)
                                      ↓
┌─★★★ Layer 3: 用户代码 (Java) ────────────────────────────────────────────────┐
│                                                                              │
│  new Thread(() -> {                                                          │
│    Reference<?> ref = queue.remove();  // 阻塞等待                            │
│    // ref.get() → null (referent 已被 GC 回收)                               │
│    // 执行用户清理逻辑 (如关闭文件、释放连接)                                   │
│  }).start();                                                                 │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**★★★ 追问：为什么要有三层，不是两层？**

```
为什么不让 GC 直接入队到 ReferenceQueue？
  → GC 线程是 NonJavaThread → 不能执行 Java 代码
  → ReferenceQueue.enqueue() 是 Java 方法 → 需要 JavaThread 身份

为什么不让 ReferenceHandler 做 GC 的 discovered 管理？
  → GC 的并发标记阶段不能有 JavaThread 参与 (safepoint)
  → ReferenceHandler 在 safepoint 期间被阻塞 (它是 JavaThread)

所以三层分工:
  Layer 1 (C++/GC):    并发判断 referent 存活 + 无锁头插法构建链表
  Layer 2 (Java/RefHandler): 跨语言桥梁 — 原子取链表 → Java 对象操作
  Layer 3 (User):      应用层逻辑 — 处理关联资源的清理
```

### 4.2 ★★ `discovered` 字段的三重身份 — 全文设计精髓

```
同一个 Reference.discovered 字段, 在三个阶段有三种语义:

┌─────────────────────────────────────────────────────────────────────┐
│ 阶段 1: GC Discovered 阶段                                           │
│   身份: GC 维护的 DiscoveredList 链表指针                              │
│   写入者: GC 线程 (discover_reference → 追加到对应类型的 DiscoveredList)  │
│   读取者: GC 线程 (process_discovered_references → 遍历链表)           │
│   并发: 无锁 (GC 阶段单线程处理, 不存在并发写入)                         │
│                                                                     │
│   discovered → 下一个被发现的 Reference (或 null = 链表尾)             │
│   C++ 通过 oopDesc::obj_field_put(ref, discovered_offset, next) 写入  │
└─────────────────────────────────────────────────────────────────────┘
                            ↓ add_to_pending_list()
                            ↓ ref.discovered = _pending_list_head
                            ↓ _pending_list_head = ref (CAS)
┌─────────────────────────────────────────────────────────────────────┐
│ 阶段 2: Pending 阶段                                                 │
│   身份: pending list 单向链表指针                                     │
│   写入者: GC 线程 (add_to_pending_list — 头插法)                      │
│   读取者: ReferenceHandler 线程 (processPendingReferences — 遍历链表)  │
│   并发: 有 ProcessPendingListLock 保护 CAS 交接                       │
│                                                                     │
│   discovered → pending list 中的下一个 Reference (或 null = 链表尾)     │
│   ★ 这是 C++ 和 Java 之间唯一的交接点 — 零拷贝                          │
└─────────────────────────────────────────────────────────────────────┘
                            ↓ getAndClearReferencePendingList()
                            ↓ CAS: _pending_list_head = NULL (返回旧值)
                            ↓ ref.discovered 被 ReferenceHandler 读取
                            ↓ ref.discovered = null (重置)
┌─────────────────────────────────────────────────────────────────────┐
│ 阶段 3: Inactive 阶段                                                │
│   身份: null (已重置)                                                │
│   写入者: ReferenceHandler (ref.discovered = null)                   │
│   读取者: 无 (GC 不再接触这个 Reference)                               │
│                                                                     │
│   discovered = null → Reference 处于 inactive 状态                   │
│   ★ 这是 "Reference 已处理完毕" 的标记                                │
└─────────────────────────────────────────────────────────────────────┘
```

**❓ 追问：为什么不用独立的 `_pending_next` 字段，而是复用 `discovered`？**

因为 Reference 对象的内存布局已经很紧凑（`referent` + `queue` + `next` + `discovered` = 4 个引用字段）。如果再加一个 `_pending_next` → 每个 Reference 多一个引用大小的开销 → 百万 Reference 多 8MB 内存。复用 `discovered` 是因为两个链表**在时间上不重叠**：GC discovered 链表在 `add_to_pending_list()` 之前全部处理完毕，pending 链表在 ReferenceHandler 处理前独占。

### 4.3 ★ 为什么 4 种类型按 Soft → Weak → Final → Phantom 顺序处理？

```
处理顺序不是随机的 — 每种类型有不同的存活判定:

① SoftReference:  先处理 — 因为 "是否存活" 取决于堆内存压力
    → SoftRefPolicy::should_clear_reference(clock):
      clock += interval_per_ref;  // interval = SoftRefLRUPolicyMSPerMB * MaxHeap / 1024
      → if (clock < interval) → keep_alive (暂时不杀)
      → if (clock >= interval) → clear (内存压力大 → 杀)
    → 先处理 Soft 是因为它们的存活判定需要时钟递增

② WeakReference:  直接处理 — 只要没有强引用就杀
    → if (没有强引用持有 referent) → clear + pending
    → 没有时钟逻辑 → 最快

③ FinalReference: 特殊处理 — referent 即使死了也要先保活
    → Referent 已死 → 但 keep_alive(referent) 直到 finalize()
    → Finalizer 从 unfinalized 链表移除 → 加入 FinalizerThread queue
    → ★ 不加入 pending_list → 不走 ReferenceHandler!

④ PhantomReference:  最后处理 — referent 已死，get() 永远 null
    → clear + pending
    → PhantomReference 作用: 资源释放哨兵 — "当对象被回收时通知我"
    → 排在最后是因为它对 referent 没有任何保活需求 (referent 在 Soft 阶段就被清除了)
```

### 4.4 ★★ Finalizer 的独立通道 — 为什么不能和 ReferenceHandler 合并？

```
ReferenceHandler 处理流程:
  pendingList → ReferenceHandler → Cleaner.clean() 或 queue.enqueue()
                ↓
         用户代码收到通知 → 执行清理

Finalizer 处理流程:
  对象创建 → InterpreterRuntime::register_finalizer()
           → Finalizer.register() → unfinalized 双向链表 (new 时预先注册!)
           ↓
  GC 发现 referent 已死:
    → Finalizer 从 unfinalized 链表移除
    → 加入 FinalizerThread 的 ReferenceQueue
    → FinalizerThread.remove() 阻塞等待
    → 取出 Finalizer → finalize() → 清除 referent
    → ★ 对象需要第二次 GC 才能被真正回收!

为什么 Finalizer 不走 ReferenceHandler?
  ① 时序不同: ReferenceHandler 处理"已经死了的"对象; Finalizer 需要"先复活再死"
  ② 保活语义: Finalizer 必须在 finalize() 执行完之前保活 referent
  ③ 遍历结构不同: ReferenceHandler 遍历 pending_list; FinalizerThread 阻塞在 ReferenceQueue 上
  ④ 优先级不同: ReferenceHandler=MAX_PRIORITY (Cleaner 必须立即执行)
                FinalizerThread=NORM_PRIORITY (finalize() 可以慢)
```

### 4.5 ★ Cleaner 的特殊路径 — 为什么直接 clean() 而不是入队？

```java
// Reference.java:236-270 — processPendingReferences() 中:
while (pendingList != null) {
    Reference<Object> ref = pendingList;
    pendingList = ref.discovered;
    ref.discovered = null;

    if (ref instanceof Cleaner) {        // ★ Cleaner 特殊判断
        ((Cleaner)ref).clean();           // ★ 直接执行！不走 ReferenceQueue
        // 通知 NIO 的 DirectByteBuffer 堆外内存已被释放
    } else {
        ReferenceQueue<?> q = ref.queue;
        if (q != ReferenceQueue.NULL) q.enqueue(ref);  // 正常路径: 入队
    }
}
```

**为什么 Cleaner 直接执行？**
- Cleaner 是 `DirectByteBuffer` 释放堆外内存的唯一路径
- 如果 Cleaner 先入队再等用户 `queue.remove()` → 用户可能在处理别的 → 堆外内存长时间不释放 → Native OOM
- `DirectByteBuffer` 的 `Deallocator` 在 `clean()` 中调用 `Unsafe.freeMemory()` — 这是 native 操作，必须及时

**为什么 ReferenceHandler = MAX_PRIORITY？** 直接原因就是 Cleaner — 不能让 Cleaner 被低优先级任务阻塞。

### 4.6 ★ Finalizer 的"两次 GC" 问题

```
第一次 GC:
  对象被标记为垃圾 → GC 发现它有 finalize() 方法
  → 不回收对象 → 把 Finalizer 加入 FinalizerThread queue
  → FinalizerThread.finalize() 执行
  → 此时对象从 unfinalized 链表移除，只被 Finalizer 引用

第二次 GC:
  对象再次被 GC 扫描 → referent 已无强引用 (finalize() 已执行完)
  → 这次真的回收对象

性能代价:
  - 有 finalize() 的对象至少多活一次 GC 周期
  - 如果 finalize() 中把对象重新赋值给某个 static 字段 → "复活" → 永不回收
  - 这就是为什么 Java 9 废弃 finalize()、推荐 Cleaner 的原因
```

### 4.7 ★ ReferenceHandler 与 FinalizerThread 的隐式创建

```
和 ServiceThread [12] 的 create_vm() 显式创建不同：
  ServiceThread:    create_vm() → ServiceThread::initialize() — 显式
  ReferenceHandler: create_vm() → (搜索: 谁先访问了 Reference.class?) → <clinit> → new ReferenceHandler() — 隐式
  FinalizerThread:  create_vm() → (搜索: 谁先访问了 Finalizer.class?) → <clinit> → new FinalizerThread() — 隐式

关键搜索路径 (AI 需要做的):
  → grep -rn "Reference.class\|Finalizer.class" src/hotspot/share/runtime/thread.cpp
  → 找到触发类加载的具体代码 (如 SystemDictionary::initialize() 或 Universe::genesis())
  → 确认 <clinit> 的调用时机: 是在 VMThread 之前还是之后？
  → 为什么 jstack 中 ReferenceHandler 是 #2、Finalizer 是 #3？
    答案: 它们是最早创建的 JavaThread（仅次于 main 线程 #1），因为类加载在 create_vm() 早期触发
```

## 五、文章结构

```
§〇 源文件清单（跨 java.base + hotspot/share/gc + hotspot/share/prims）
  → 搜索不到时回退到 source_index/ 索引

§一 Reference 体系全景 — Discovery → Pending → Enqueue 三层流水线
  ★ 开头即贴 jstack 输出 "Reference Handler" #2 + "Finalizer" #3
  ❓ new WeakReference(obj, queue) → obj 被 GC → queue.remove() — 中间发生了什么？
  1.1 三条处理通道: ReferenceHandler(通用) vs FinalizerThread(终结器) vs Cleaner(直接执行)
  1.2 ★ Three-layer pipeline 架构图
  1.3 ★ Why three layers, not two? — GC(非JavaThread) → ReferenceHandler(JavaThread) → User
  1.4 ReferenceHandler 和 FinalizerThread 的隐式创建 — static initializer vs create_vm()

§二 ★★★ GC 层的 Reference 处理 (referenceProcessor.cpp)
  ❓ 4 种类型为什么按 Soft→Weak→Final→Phantom 顺序处理？
  ❓ SoftReference 的 clock 机制 — SoftRefLRUPolicyMSPerMB 如何控制存活？
  2.1 ReferenceProcessor::discover_reference() — GC 如何发现 Reference
  2.2 ReferenceProcessor::process_discovered_references() — 4 阶段处理算法
  2.3 ★ add_to_pending_list() — 头插法 + CAS 原子操作
  2.4 ★ SoftRefPolicy::should_clear_reference() — LRU 时钟判定
  2.5 ★ 4 种类型的存活判定差异 — Soft(clock) vs Weak(ref) vs Final(keep_alive) vs Phantom(null)

§三 ★★★ Java 层的 ReferenceHandler + Cleaner (Reference.java)
  ❓ 为什么 Cleaner 不经过 ReferenceQueue ？
  ❓ 为什么 ReferenceHandler 是 MAX_PRIORITY？
  ❓ discovered 字段为什么能复用？
  3.1 processPendingReferences() 主循环逐行走读
  3.2 ★ getAndClearReferencePendingList() — JNI 原子的 C++→Java 交接
  3.3 ★ Cleaner 的特殊路径 — DirectByteBuffer 堆外内存释放的唯一通道
  3.4 ★ discovered 字段的三重身份 — 零内存额外开销的数据结构复用
  3.5 为什么 ReferenceHandler 是系统最高优先级线程

§四 ★★ Finalizer 的独立通道 (Finalizer.java)
  ❓ 为什么 Finalizer 不走 ReferenceHandler？
  ❓ 为什么 finalize() 需要两次 GC？
  4.1 Finalizer.register() — new 时预先注册到 unfinalized 双向链表
  4.2 InterpreterRuntime::register_finalizer() — JVM 在对象创建时的 hook
  4.3 GC 如何发现 Finalizer — unlink from unfinalized → move to FinalizerThread
  4.4 FinalizerThread.run() — wait/notify + finalize() 执行
  4.5 ★ "两次 GC" 的完整生命周期 — 第一次保活 finalize() → 第二次真正回收

§五 ★ 对比线: ReferenceHandler vs FinalizerThread vs ServiceThread vs AttachListener
  ❓ 四个都是 JavaThread，都是 daemon — 为什么设计如此不同？
  5.1 创建时机对比: 隐式(static init) vs 显式(create_vm) vs 按需(SignalDispatcher)
  5.2 优先级对比: MAX(10) vs NORM(5) vs NearMax(9) vs NearMax(9)
  5.3 任务模型对比: 通知消费 vs 终结器 vs 5条件等待 vs 串行命令
  5.4 死亡后果对比 — 为什么 ReferenceHandler crash 比 FinalizerThread crash 更致命

§六 GDB 验证 + 可证伪断言（≥10 条 GDB + ≥5 条断言）

  断言 1: (gdb) info threads | grep "Reference Handler" → 预期: prio=10, daemon
  断言 2: (gdb) info threads | grep "Finalizer" → 预期: prio=5, daemon
  断言 3: (gdb) p ReferenceProcessor::_pending_list_head → 预期: 0x0 (空闲时)；★ 字段名需从 referenceProcessor.hpp 确认
  断言 4: (gdb) p 'java.lang.ref.Finalizer'::unfinalized → 预期: null 或双向链表头；★ 需确认 GDB 中 JVM 对 static 字段的命名方式
  断言 5: 在 Reference.java processPendingReferences() 入口打断点 → (gdb) p pendingList → 预期: 显示链表（当有 Reference 待处理时）
  断言 6: (gdb) break InterpreterRuntime::register_finalizer → (gdb) bt → 预期: 调用栈来自对象创建路径 (new 或 clone)
  断言 7: (gdb) break ReferenceProcessor::add_to_pending_list → (gdb) bt → 预期: 调用栈来自 GC remark/cleanup 阶段
  断言 8: 在 ReferenceHandler 线程中打断点 → (gdb) thread <id> → (gdb) p java_lang_Thread::priority(threadObj()) → 预期: 10 (MAX_PRIORITY)
  断言 9: java -XX:+PrintReferenceGC -Xlog:gc+ref=debug -jar MyApp → 预期: Soft/Weak/Final/Phantom reference 处理日志
  断言 10: java -XX:SoftRefLRUPolicyMSPerMB=0 -jar MyApp → 预期: SoftReference 立即被清除（将 per-MB 参数设为 0 使 clock 立即超时）

  可证伪断言 1: ReferenceHandler crash → pending list 无限增长 → Cleaner 不执行 → Native OOM
  可证伪断言 2: FinalizerThread crash → unfinalized 链表中的对象永远不被 finalize → 内存泄漏
  可证伪断言 3: discovered 字段在阶段1和阶段2从不重叠 — 验证: 加断言在两个阶段的边界
  可证伪断言 4: Cleaner 的 clean() 在 MAX_PRIORITY 线程中执行 — 性能优于入队再出队的方案
  可证伪断言 5: 有 finalize() 的对象至少经历 2 次 GC 才被回收 — 验证: GC log 中同一个对象出现两次
```

## 六、写作要求

1. **★ 三层流水线是全文灵魂**：referenceProcessor.cpp → jni.cpp → Reference.java → Finalizer.java — 每层都要解释"为什么这一层不能和另一层合并"
2. **★ `discovered` 三重身份**：用三阶段图展示同一个字段的语义切换，追问"为什么不用独立字段"
3. **★ 4 种类型的处理顺序**：Soft→Weak→Final→Phantom — 每种类型的存活判定差异、排序理由
4. **★ Cleaner 的特殊路径**：直接执行 clean() vs 入队 — 为什么是 MAX_PRIORITY 的根因
5. **★ Finalizer 的两次 GC**：finalize() 的保活语义 → 为什么废弃 finalize() — 性能分析
6. **对比线**：ReferenceHandler vs FinalizerThread vs ServiceThread vs AttachListener — 四线程对比全景
7. **GDB 验证**：≥10 条，每条含命令 + 预期值；可证伪断言 ≥5 条
8. **交叉引用**：[09 §3.1-3.2] 创建入口 + [06] 生命周期 + [10] NonJavaThread 对比 + [12] ServiceThread 对比

## 七、输出格式

- Markdown 文件，命名为 `13-JVM-Reference-Finalizer.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 [09][12] + 关联 [06][10] + 阅读收益）
