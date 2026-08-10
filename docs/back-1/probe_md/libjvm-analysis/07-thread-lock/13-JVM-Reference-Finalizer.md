# 13-JVM-Reference-Finalizer — 一条 `discovered` 字段的三重身份

> **Standard Environment**: OpenJDK 11 slowdebug · `-Xms8g -Xmx8g -XX:+UseG1GC` · 64-bit Linux x86 · Tiered Compilation
> **Core Source**: `Reference.java` · `referenceProcessor.{hpp,cpp}` · `Finalizer.java` · `jvm.cpp` · `thread.cpp` · `referencePolicy.{hpp,cpp}` · `interpreterRuntime.cpp` · `instanceKlass.cpp` · `javaClasses.{hpp,cpp,ineline.hpp}` · `universe.{hpp,cpp}`
> **Prerequisites**: [09 §3.1-3.2] ReferenceHandler + FinalizerThread 创建入口 · [06] JavaThread 生命周期 · [10] NonJavaThread vs JavaThread 对比 · [12] ServiceThread 隐式创建模式对比
> **Related**: [07 VMThread] Safepoint 机制（GC 线程为何是 NonJavaThread） · [05-ThreadStart] 线程启动全流程
> **Reading Gain**: 理解 C++/Java 双语言引用处理流水线 · `discovered` 字段的三重语义复用 · ReferenceHandler 为什么是 MAX_PRIORITY · Finalizer 为什么需要独立线程和两次 GC · Cleaner 为什么直接执行而不是入队

---

## §〇 源文件清单

```
跨语言架构：java.base + hotspot/share/gc/shared + hotspot/share/prims + hotspot/share/runtime
```

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `Reference.java` | `src/java.base/share/classes/java/lang/ref/Reference.java` | `ReferenceHandler`(L190), `processPendingReferences()`(L236), 3个native方法(L221-231) | ★★★ Java层核心——ReferenceHandler主循环 + native桥梁 |
| 2 | `referenceProcessor.hpp` | `src/hotspot/share/gc/shared/referenceProcessor.hpp` | `ReferenceProcessor`, `DiscoveredList`(L40), `DiscoveredListIterator`(L65) | ★★ C++层核心数据结构——discovered链表管理 |
| 3 | `referenceProcessor.cpp` | `src/hotspot/share/gc/shared/referenceProcessor.cpp` | `discover_reference()`(L1109), `process_discovered_references()`(L202), `complete_enqueue()`(L323) | ★★★ C++层核心实现——4种类型处理全流程 |
| 4 | `Finalizer.java` | `src/java.base/share/classes/java/lang/ref/Finalizer.java` | `FinalizerThread`(L146), `unfinalized`双向链表(L41), `register()`(L65) | ★★ Finalizer独立通道——双向链表 + 独立线程 |
| 5 | `jvm.cpp` | `src/hotspot/share/prims/jvm.cpp` | `JVM_GetAndClearReferencePendingList()`(L3347), `JVM_WaitForReferencePendingList()`(L3364) | ★ Native方法实现——C++/Java交接桥梁 |
| 6 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | `initialize_java_lang_classes()`(L3822)→初始化`Finalizer.class`(L3854) | ★ 隐式创建时机——类加载触发线程创建 |
| 7 | `referencePolicy.{hpp,cpp}` | `src/hotspot/share/gc/shared/referencePolicy.{hpp,cpp}` | `LRUCurrentHeapPolicy`, `LRUMaxHeapPolicy`, `should_clear_reference()` | ★ SoftReference LRU时钟策略实现 |
| 8 | `interpreterRuntime.cpp` | `src/hotspot/share/interpreter/interpreterRuntime.cpp` | `InterpreterRuntime::register_finalizer()`(L308) | ★ Finalizer.register()的VM hook |
| 9 | `instanceKlass.cpp` | `src/hotspot/share/oops/instanceKlass.cpp` | `register_finalizer()`(L1263), `allocate_instance()`(L1287) | ★ 对象创建时触发Finalizer注册 |
| 10 | `javaClasses.{hpp,cpp,ineline.hpp}` | `src/hotspot/share/classfile/` | `java_lang_ref_Reference`偏移量访问器(L939-970) | C++层如何读写Java Reference对象的字段 |
| 11 | `universe.{hpp,cpp}` | `src/hotspot/share/memory/` | `_reference_pending_list`(L135), `swap_reference_pending_list()`(L562) | ★ pending list全局变量 + Atomic::xchg交接 |
| 12 | `vmGCOperations.cpp` | `src/hotspot/share/gc/shared/` | `VM_GC_Operation::doit_epilogue()`(L114) | ★ GC结束后通知ReferenceHandler的关键唤醒点 |

---

## §一 Reference 体系全景 — Discovery → Pending → Enqueue 三层流水线

### 1.0 开场：jstack 中的 #2 和 #3

在执行 `jstack <pid>` 的输出中，你会在最顶部看到：

```
"Reference Handler" #2 daemon prio=10 os_prio=0 ...
   java.lang.Thread.State: WAITING (on object monitor)
        at java.lang.ref.Reference.waitForReferencePendingList(Native Method)
        at java.lang.ref.Reference.processPendingReferences(Reference.java:241)
        at java.lang.ref.Reference$ReferenceHandler.run(Reference.java:213)

"Finalizer" #3 daemon prio=8 os_prio=0 ...
   java.lang.Thread.State: WAITING (on object monitor)
        at java.lang.Object.wait(Native Method)
        at java.lang.ref.ReferenceQueue.remove(ReferenceQueue.java:--)
        at java.lang.ref.ReferenceQueue.remove(ReferenceQueue.java:--)
        at java.lang.ref.Finalizer$FinalizerThread.run(Finalizer.java:170)
```

这两个线程是 JVM 启动后最早创建的 JavaThread（#2 和 #3），仅次于 main 线程（#1）。它们都在 `create_vm()` 期间通过**类加载的 `<clinit>` 副作用**隐式创建——这是理解本文的第一个关键点。

**❓ 面试级问题**：`new WeakReference(obj, queue)` 之后，obj 被 GC 回收 → Reference 入队 → `queue.remove()` 返回——中间到底发生了什么？

这条链路跨越了**两个语言边界**（C++ 和 Java）和**三个抽象层**：

```
┌── C++ Layer (GC 线程) ──────────────────────────────────────────────────────┐
│  GC 并发标记阶段 → discover_reference(obj, REF_WEAK)                        │
│    → 判断 referent 是否存活 → 不存活 → 加入 _discoveredWeakRefs 链表        │
│  GC remark/cleanup → process_discovered_references()                        │
│    → 遍历 4 种 DiscoveredList → clear referent → complete_enqueue()          │
│    → Universe::swap_reference_pending_list(list_head)  ★ 头插法 + Atomic::xchg│
│    → Heap_lock->notify_all()  ★ 唤醒 ReferenceHandler                        │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │ pending list (C++ 全局变量)
                                      ↓
┌── Java Layer (ReferenceHandler 线程) ────────────────────────────────────────┐
│  waitForReferencePendingList() [native] → 被 GC 唤醒                         │
│  getAndClearReferencePendingList() [native] → 原子取走全部 Reference          │
│  while (pendingList != null):                                                │
│    ref = pendingList; pendingList = ref.discovered; ref.discovered = null   │
│    if (ref instanceof Cleaner): ((Cleaner)ref).clean()  ★ 直接执行            │
│    else: q.enqueue(ref)  ★ 加入用户可见的 ReferenceQueue                      │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │ ReferenceQueue<Object>
                                      ↓
┌── User Layer (应用线程) ─────────────────────────────────────────────────────┐
│  Reference<?> ref = queue.remove();  // 阻塞等待 → 收到通知 → 执行清理逻辑     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 ★★★ 为什么要有三层？不是两层？

这是面试中可能被问的第一个深层次问题：

**为什么不让 GC 线程直接把 Reference 塞进 ReferenceQueue？**

```
答案很直接，但需要理解 [10-NonJavaThread] 的前提：
  → GC 线程是 NonJavaThread（如 ConcurrentGCThread）
  → NonJavaThread 不能执行 Java 层代码
  → ReferenceQueue.enqueue(ref) 是 Java 方法，需要 JavaThread 身份
  → 所以必须有一个 JavaThread 作为 "搬运工"：ReferenceHandler

那为什么 GC 不直接用 ReferenceHandler 做 discovered 管理？
  → GC 的并发标记在 safepoint 之外运行
  → ReferenceHandler 是 JavaThread → safepoint 期间被阻塞
  → 不能指望一个可能被阻塞的线程来做 GC 的实时发现
  → 所以必须分两层：GC 线程做发现，ReferenceHandler 做通知

那为什么不让用户线程直接 poll pending list？
  → pending list 是 C++ 全局变量，用户代码无法访问
  → 必须有一个 JNI 桥梁 → 又是 ReferenceHandler
```

三层分工的本质是**语言边界 + 并发模型**的天然约束：

| Layer | 执行者 | 身份 | 语言 | 工具 |
|-------|--------|------|------|------|
| 1. Discovery | GC Thread | NonJavaThread | C++ | `oopDesc::obj_field_put()` 直接写 Java 对象字段 |
| 2. Notification | ReferenceHandler | JavaThread(daemon) | Java | JNI 取链表 → Java 操作入队 |
| 3. Consumption | User Thread | JavaThread | Java | `queue.remove()` 阻塞等待 |

### 1.2 三条处理通道：ReferenceHandler vs FinalizerThread vs Cleaner

虽然链路上都"处理 Reference"，但内部有三条**完全不同的通道**：

```
┌─────────────────────────────────────────────────────────────────┐
│ 通道 1: ReferenceHandler — 通用引用处理 (Soft/Weak/Phantom)        │
│  Flow: GC → pending_list → RefHandler → Cleaner.clean() 或      │
│                                        → queue.enqueue()        │
│  特点: MAX_PRIORITY(10), 处理"已经死了的"对象                       │
│                                                                 │
│ 通道 2: FinalizerThread — 终结器处理 (FinalReference)              │
│  Flow: new 时注册 → unfinalized 双向链表 → GC 发现 →              │
│        Finalizer 从 unfinalized 移除 → FinalizerThread queue    │
│        → finalize() → 第二次 GC 真正回收                           │
│  特点: prio=8, 需要两次 GC, 对象在 finalize() 前被保活              │
│                                                                 │
│ 通道 3: Cleaner 直接执行 — 堆外内存释放 (PhantomReference)          │
│  Flow: GC → pending_list → RefHandler → Cleaner.clean() (直接!) │
│  特点: 不走 ReferenceQueue, 由 ReferenceHandler 立即执行            │
│                                                                 │
│ ★ 通道 2 和通道 3 为什么不能合并进通道 1？                           │
│   → 通道 2(Finalizer): 需要"先保活再通知"的时序——                    │
│      必须先执行 finalize()、再让 GC 回收对象                         │
│   → 通道 3(Cleaner): 需要"立即执行"——                              │
│      等用户 queue.remove() 可能太慢 → Native OOM                   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 ReferenceHandler 和 FinalizerThread 的隐式创建

**对比 [12-ServiceThread] 的显式创建**：

```
显式 (ServiceThread):
  create_vm() → ServiceThread::initialize() → new ServiceThread() → start()
  ★ 由 C++ 代码直接 new 和 start

隐式 (ReferenceHandler):
  create_vm() → initialize_java_lang_classes() → 
    initialize_class(vmSymbols::java_lang_String())  → String.class <clinit>
    initialize_class(vmSymbols::java_lang_Thread()) → Thread.class <clinit>
    ... (众多基础类初始化) ...
  → 在初始化期间，JVM 首次需要访问 Reference.class（如创建 WeakReference 等）
  → Reference.class <clinit> 执行：
    Thread handler = new ReferenceHandler(tg, "Reference Handler");
    handler.setPriority(Thread.MAX_PRIORITY);  // = 10
    handler.setDaemon(true);
    handler.start();  ★ 线程 #2 诞生

隐式 (FinalizerThread):
  create_vm() → initialize_java_lang_classes() →
    initialize_class(vmSymbols::java_lang_ref_Finalizer())  ★ thread.cpp:3854 显式调用
  → Finalizer.class <clinit> 执行：
    Thread finalizer = new FinalizerThread(tg);
    finalizer.setPriority(Thread.MAX_PRIORITY - 2);  // = 8
    finalizer.setDaemon(true);
    finalizer.start();  ★ 线程 #3 诞生
```

**★ 关键发现**：`Finalizer.class` 在 `thread.cpp:3854` 有**显式**的 `initialize_class()` 调用，而 `Reference.class` 则是**隐式**的——它在 JVM 启动过程中被其他代码引用而被动加载。这就是为什么 jstack 中 #2=ReferenceHandler、#3=FinalizerThread 的顺序——Reference.class 的加载触发点比 Finalizer.class 更早。

---

## §二 ★★★ GC 层的 Reference 处理 (`referenceProcessor.cpp`)

### 2.0 数据结构：DiscoveredList + ReferenceProcessor

在 C++ 层，4 种 Reference 被分别存入 4 个 DiscoveredList 数组：

```cpp
// referenceProcessor.hpp:240-246 — ReferenceProcessor 构造函数中的布局
_discovered_refs     = NEW_C_HEAP_ARRAY(DiscoveredList, _max_num_queues * 4, mtGC);
_discoveredSoftRefs    = &_discovered_refs[0];                     // 偏移 0
_discoveredWeakRefs    = &_discoveredSoftRefs[_max_num_queues];    // 偏移 _max_num_queues
_discoveredFinalRefs   = &_discoveredWeakRefs[_max_num_queues];    // 偏移 2*_max_num_queues
_discoveredPhantomRefs = &_discoveredFinalRefs[_max_num_queues];   // 偏移 3*_max_num_queues
```

每个 `DiscoveredList` 就是**一个链表头 + 长度计数**：

```cpp
// referenceProcessor.hpp:40-62
class DiscoveredList {
  oop       _oop_head;          // 链表头 (oop 指针)
  narrowOop _compressed_head;   // 压缩指针版本
  size_t    _len;               // 链表长度
  // ★ 关键：这个链表不是通过指针字段连接的！
  //   而是通过每个 Reference 对象的 discovered 字段串起来
};
```

**★ 核心设计**：DiscoveredList 不拥有独立的链表节点。它通过**直接修改 Java 堆上 Reference 对象的 `discovered` 字段**来构建链表。C++ 层通过 `discovered_addr_raw()` 获取该字段的堆内存地址，用 `RawAccess<>::oop_store()` 直接写入——这是 C++ 在堆上"越权"访问 Java 对象字段的能力。

### 2.1 ★ discover_reference() — GC 如何"发现" Reference

当 GC 在并发标记过程中遇到一个 `Reference` 对象时，调用：

```cpp
// referenceProcessor.cpp:1109-1216 — discover_reference()
bool ReferenceProcessor::discover_reference(oop obj, ReferenceType rt) {
  // ★ Step 1: 前置检查
  if (!_discovering_refs || !RegisterReferences) return false;

  // ★ Step 2: FinalReference 特殊判断 —— next != NULL 表示"已非 active"
  if ((rt == REF_FINAL) && (java_lang_ref_Reference::next(obj) != NULL)) {
    return false;  // 不重复发现非 active 的 FinalReference
  }

  // ★ Step 3: 判断 referent 是否存活
  if (is_alive_non_header() != NULL) {
    if (is_alive_non_header()->do_object_b(
          java_lang_ref_Reference::referent(obj))) {
      return false;  // referent 还活着 → 不需要处理
    }
  }

  // ★ Step 4: SoftReference 特殊判断 —— 可以在发现阶段就决定不清除
  if (rt == REF_SOFT) {
    if (!_current_soft_ref_policy->should_clear_reference(obj, _soft_ref_timestamp_clock)) {
      return false;  // SoftRef 还不到清除时机 → 当成强引用处理
    }
  }

  // ★ Step 5: 检查是否已 discovered（防重复）
  HeapWord* discovered_addr = java_lang_ref_Reference::discovered_addr_raw(obj);
  const oop discovered = java_lang_ref_Reference::discovered(obj);
  if (discovered != NULL) return false; // 已被发现

  // ★ Step 6: 加入对应的 DiscoveredList
  DiscoveredList* list = get_discovered_list(rt);  // Soft/Weak/Final/Phantom
  if (_discovery_is_mt) {
    add_to_discovered_list_mt(*list, obj, discovered_addr);  // 多线程: CAS 竞争
  } else {
    // 单线程路径: 直接头插
    oop current_head = list->head();
    oop next_discovered = (current_head != NULL) ? current_head : obj;
    RawAccess<>::oop_store(discovered_addr, next_discovered);
    list->set_head(obj);
    list->inc_length(1);
  }
  return true;
}
```

**★ 多线程版本 (`add_to_discovered_list_mt`)**：

```cpp
// referenceProcessor.cpp:1035-1063
inline void ReferenceProcessor::add_to_discovered_list_mt(
    DiscoveredList& refs_list, oop obj, HeapWord* discovered_addr) {
  oop current_head = refs_list.head();
  oop next_discovered = (current_head != NULL) ? current_head : obj;

  // ★ CAS: 如果 discovered_addr 处的值是 NULL，则设为 next_discovered
  oop retest = HeapAccess<AS_NO_KEEPALIVE>::oop_atomic_cmpxchg(
                   next_discovered, discovered_addr, oop(NULL));
  if (retest == NULL) {
    // CAS 成功 → 我赢得了加入权
    refs_list.set_head(obj);
    refs_list.inc_length(1);
  } else {
    // CAS 失败 → 其他线程已发现这个 Reference → 不管了
  }
}
```

**粒度标注**：`discovered_addr` 指向 Java 堆上 Reference 对象的 `discovered` 字段地址（第 3 个引用字段，偏移量 = `discovered_offset`）。C++ 通过此地址以**字（oop/narrowOop）粒度**写入——64 位下 8 字节，压缩指针下 4 字节。

### 2.2 ★★★ process_discovered_references() — 4 阶段处理算法

```cpp
// referenceProcessor.cpp:202-270
ReferenceProcessorStats ReferenceProcessor::process_discovered_references(
  BoolObjectClosure* is_alive, OopClosure* keep_alive, VoidClosure* complete_gc, ...) {

  disable_discovery();  // ★ 先关闭 discovery，进入处理模式

  // ★★★ Phase 1: SoftReference 重新评估
  {
    REF_PHASE_TIMER(RefPhase1);
    process_soft_ref_reconsider(is_alive, keep_alive, complete_gc, ...);
  }
  update_soft_ref_master_clock();  // ★ 更新 LRU 时钟

  // ★★★ Phase 2: Soft↗Weak↗Final 三种一起处理
  {
    REF_PHASE_TIMER(RefPhase2);
    process_soft_weak_final_refs(is_alive, keep_alive, complete_gc, ...);
  }

  // ★★★ Phase 3: FinalReference 保活
  {
    REF_PHASE_TIMER(RefPhase3);
    process_final_keep_alive(keep_alive, complete_gc, ...);
  }

  // ★★★ Phase 4: PhantomReference
  {
    REF_PHASE_TIMER(RefPhase4);
    process_phantom_refs(is_alive, keep_alive, complete_gc, ...);
  }

  return stats;
}
```

下面逐阶段走读。

### 2.3 Phase 1: SoftReference — LRU 时钟策略

```cpp
// referenceProcessor.cpp:351-379 — process_soft_ref_reconsider_work()
size_t ReferenceProcessor::process_soft_ref_reconsider_work(
    DiscoveredList& refs_list, ReferencePolicy* policy,
    BoolObjectClosure* is_alive, OopClosure* keep_alive, VoidClosure* complete_gc) {

  DiscoveredListIterator iter(refs_list, keep_alive, is_alive);
  while (iter.has_next()) {
    iter.load_ptrs(DEBUG_ONLY(!discovery_is_atomic()));
    bool referent_is_dead = (iter.referent() != NULL) && !iter.is_referent_alive();

    if (referent_is_dead &&
        !policy->should_clear_reference(iter.obj(), _soft_ref_timestamp_clock)) {
      // ★ referent 死了，但策略说不清除 → 从 discovered 链表中移除
      //   相当于"复活"这个 SoftReference —— 它的 referent 至少多活一个 GC 周期
      iter.remove();              // 从链表中移除
      iter.make_referent_alive(); // 标记 referent 存活
    }
    iter.next();
  }
  complete_gc->do_void();
}
```

**★ SoftReference 的存活判定——`should_clear_reference()`**：

```cpp
// referencePolicy.cpp:45-56 — LRUCurrentHeapPolicy
bool LRUCurrentHeapPolicy::should_clear_reference(oop p, jlong timestamp_clock) {
  jlong interval = timestamp_clock - java_lang_ref_SoftReference::timestamp(p);
  // ★ interval = 当前时钟 - SoftReference 的最后访问时间戳
  if (interval <= _max_interval) {
    return false;  // ★ 时间差不够大 → 不清除（保活）
  }
  return true;     // ★ 时间差过大 → 清除
}
```

**`_max_interval` 的计算**：

```
// 客户端 (-client, 默认):
_max_interval = (当前空闲堆 / M) * SoftRefLRUPolicyMSPerMB
// SoftRefLRUPolicyMSPerMB = 1000 ms/MB (默认)
// 例如空闲堆 = 512MB → interval = 512 * 1000 = 512000ms = 8.5 分钟

// 服务端 (-server, 默认):
_max_interval = (MaxHeapSize - GC后已用堆) / M * SoftRefLRUPolicyMSPerMB
// 例如 8G 堆, GC后已用 2G → 空闲 = 6G = 6144M → interval = 6144 * 1000ms = 102分钟
```

**★ 关键洞察**：SoftReference 的"存活期"由**堆内存压力**控制——空闲堆越大，interval 越长，SoftReference 活越久；堆越紧张，interval 越短，SoftReference 越快被清除。`SoftRefLRUPolicyMSPerMB=0` 意味着立即清除。

**★★★ 追问：为什么 SoftReference 被检查了两次？**

仔细看代码流程，SoftReference 在两个地方被"是否清除"判断：

```
位置 1: discover_reference() Step 4 (referenceProcessor.cpp:1137-1146)
  → 在"发现"阶段就判断：如果策略说不清除 → return false (不加入 DiscoveredList)
  → 目的：性能优化——省得加入再移除

位置 2: Phase 1 process_soft_ref_reconsider_work() (referenceProcessor.cpp:342-343)
  → 在处理阶段再次判断：如果策略说不清除 → remove() + make_referent_alive()
  → 目的：正确性——拿到最新时钟后的精确判定
```

**为什么需要两次？因为时钟在两次调用之间可能前进了。**

```
时间线:
  T0: GC 开始 discovery → _soft_ref_timestamp_clock = 1000
      (位置 1) SoftRef A 的 timestamp=0 → interval=1000 → 刚好等于 _max_interval
      → should_clear_reference() 返回 false (不清除) → 加入 DiscoveredList
      
  T1: Phase 1 开始 → update_soft_ref_master_clock()
      → _soft_ref_timestamp_clock = 1500 (时钟前进了 500ms!)
      
      (位置 2) SoftRef A 的 timestamp=0 → interval=1500 > _max_interval
      → should_clear_reference() 返回 true (现在要清除了!)
      → 如果只有位置 1 的判断 → SoftRef A 不会被加入 DiscoveredList → 永远活在堆上
      → 有了位置 2 → 它被加入了 DiscoveredList → 此处被精确判定为"该清了"
```

第一次是**快速过滤**（减少 DiscoveredList 的大小，省去后续不必要的遍历），第二次是**精确判定**（在 Phase 1 拿到最新时钟后重新评估）。如果只有第一次，会因为时钟未更新导致大量 SoftReference 被错误保留。

### 2.4 Phase 2: Soft + Weak + Final — 三合一

```cpp
// referenceProcessor.cpp:382-424 — process_soft_weak_final_refs_work()
size_t ReferenceProcessor::process_soft_weak_final_refs_work(
    DiscoveredList& refs_list, BoolObjectClosure* is_alive,
    OopClosure* keep_alive, bool do_enqueue_and_clear) {

  DiscoveredListIterator iter(refs_list, keep_alive, is_alive);
  while (iter.has_next()) {
    iter.load_ptrs(DEBUG_ONLY(!discovery_is_atomic()));

    if (iter.referent() == NULL) {
      // ★ 并发清理导致 referent 已为 null → 移除
      iter.remove();
    } else if (iter.is_referent_alive()) {
      // ★ referent 还活着 → 移除（不需要通知）
      iter.remove();
      iter.make_referent_alive();
    } else {
      // ★ referent 真的死了 → 准备入队
      if (do_enqueue_and_clear) {
        iter.clear_referent();  // referent = null
        iter.enqueue();          // ★ 关键步骤：准备入队
      }
    }
    iter.next();
  }
  if (do_enqueue_and_clear) {
    iter.complete_enqueue();  // ★★ 最终交接：链表 → pending list
    refs_list.clear();
  }
}
```

**★ 注意 FinalReference 的不同**：
- Phase 2 中 FinalReference 调用时 `do_enqueue_and_clear = false`（见 `referenceProcessor.cpp:588`）—— 所以只移除活着的，保留死了的，留给 Phase 3。

**★★★ 追问：为什么不能在 Phase 2 就 `clear_referent()`？**

因为这会导致 FinalizerThread 永远拿不到 referent：

```
如果在 Phase 2 清除了 referent:
  → FinalReference.referent = null
  → complete_enqueue() → pending list → ReferenceHandler → q.enqueue(ref)
  → FinalizerThread.queue.remove() → f.runFinalizer(jla)
    → Object finalizee = this.get();  // ★ 返回 null！
    → if (finalizee != null) { ... }  // ★ 永远不执行 finalize()！
    → super.clear();  // referent 已经是 null, 无意义
  → 对象变成"幽灵"：已标记为 finalizable 但 finalize() 从未被执行

正确的设计（Phase 2 不做 clear_referent, Phase 3 保活）:
  → Phase 2: 跳过 FinalReference 的清理, 保留在 _discoveredFinalRefs
  → Phase 3: make_referent_alive() ← 保活 referent (GC 标记为 reachable)
  → finalize() 执行时, this.get() 仍返回原始对象
  → finalize() 执行完毕 → super.clear() 后 referent 才变为 null
```

**这是"跨线程生命周期延长"的经典案例**：GC 线程在 Phase 3 用 `make_referent_alive()` 保活 referent，不是为了"复活对象让用户继续用"，而是为了确保 **FinalizerThread 能够通过 `get()` 读到原始对象来调用 `finalize()` 方法**。两个线程（GC 线程 + FinalizerThread）共享同一个 FinalReference 对象，GC 线程"延长" referent 的生命，FinalizerThread 在随后的任意时刻消费这个 referent。

### 2.5 Phase 3: FinalReference 保活

```cpp
// referenceProcessor.cpp:427-451 — process_final_keep_alive_work()
size_t ReferenceProcessor::process_final_keep_alive_work(
    DiscoveredList& refs_list, OopClosure* keep_alive, VoidClosure* complete_gc) {

  DiscoveredListIterator iter(refs_list, keep_alive, NULL);
  while (iter.has_next()) {
    iter.load_ptrs(DEBUG_ONLY(false));

    // ★★★ 核心操作：保活 referent（finalize() 执行前不能回收）
    iter.make_referent_alive();

    // ★ Mark FinalReference as inactive: next = this (自循环)
    assert(java_lang_ref_Reference::next(iter.obj()) == NULL, "enqueued FinalReference");
    java_lang_ref_Reference::set_next_raw(iter.obj(), iter.obj());

    iter.enqueue();  // ★ 准备交接
    iter.next();
  }
  iter.complete_enqueue();
  complete_gc->do_void();
  refs_list.clear();
}
```

**★ 为什么 FinalReference 的 `next = this`？**

在 `Reference.java:87-96` 的注释中解释得很清楚：FinalReference 不能用 `referent == null` 来区分 active/pending 状态（因为 FinalReference 在被通知时**不清除** referent）。所以用 `next == null` 表示 active，`next == this` 表示 inactive。

### 2.6 Phase 4: PhantomReference

```cpp
// referenceProcessor.cpp:453-481 — process_phantom_refs_work()
size_t ReferenceProcessor::process_phantom_refs_work(
    DiscoveredList& refs_list, BoolObjectClosure* is_alive,
    OopClosure* keep_alive, VoidClosure* complete_gc) {

  DiscoveredListIterator iter(refs_list, keep_alive, is_alive);
  while (iter.has_next()) {
    iter.load_ptrs(DEBUG_ONLY(!discovery_is_atomic()));
    oop const referent = iter.referent();

    if (referent == NULL || iter.is_referent_alive()) {
      iter.make_referent_alive();
      iter.remove();       // ★ 活着的移除
    } else {
      iter.clear_referent();  // 置空
      iter.enqueue();         // ★ 准备交接
    }
    iter.next();
  }
  iter.complete_enqueue();
  complete_gc->do_void();
  refs_list.clear();
}
```

**★ PhantomReference 的特殊语义**：`get()` 永远返回 null——即使 referent 还没被清除。这意味着 PhantomReference 的作用纯粹是"资源释放哨兵"——不让你直接访问对象，只在对象被回收后通知你。

### 2.6b ★ Preclean 机制 — G1 Remark 前的预清理优化

在 G1 的 concurrent mark 流程中，**remark pause 之前**还有一个 `preclean_discovered_references()` 阶段：

```cpp
// referenceProcessor.cpp:1227-1301
void ReferenceProcessor::preclean_discovered_references(
    BoolObjectClosure* is_alive, OopClosure* keep_alive, ...) {
  // 按 Soft → Weak → Final → Phantom 顺序, 逐个预清理
  for (uint i = 0; i < _max_num_queues; i++) {
    if (yield->should_return()) return;  // 可中断
    if (preclean_discovered_reflist(_discoveredSoftRefs[i], is_alive, ...)) return;
  }
  // 同逻辑处理 WeakRefs, FinalRefs, PhantomRefs
}
```

**它的作用**：在 STW remark 之前，**并发地**（和 mutator 同时）从 DiscoveredList 中移除：

```
不移除：referent 已死 + Reference 是 active 的 → 保留, STW 时处理
能移除：referent 是活的 → 不需要通知, 直接移除
能移除：referent 已被用户代码清除 (is null) → 不需要通知, 直接移除
```

**为什么需要 Preclean？**

```
如果没有 Preclean:
  → G1 Remark 是 STW (Stop-The-World)
  → 此时遍历所有 DiscoveredList, 移除"活着的"和"已被清除的"
  → 这个移除操作耗时 = STW 时间长

有了 Preclean:
  → 在 Remark 之前, 并发线程提前做掉大部分移除操作
  → Remark 时只剩下"真正需要通知的"Reference
  → STW 时间大幅缩短
```

这是**并发 GC 特有的优化**——把能在并发阶段做的工作提前做掉，减少 STW 暂停时间。STW 收集器（如 Serial/Parallel）不需要 Preclean，因为它们本来就在 STW 中处理一切。

### 2.7 ★★★ 为什么处理顺序是 Soft → Weak → Final → Phantom？

这 4 种类型的排序不是随机的，而是由每种类型的**保活语义**决定的：

```
Phase 1 先处理 Soft:
  → SoftReference 的存活取决于 LRU 时钟——需要一种"部分保活"的语义
  → 在 Phase 1 中决定哪些 Soft 保留、哪些杀——先于其他类型
  → 原因：如果 Soft 被决定保留，它的 referent 就是活的→可以影响后续类型

Phase 2 处理 Soft+Weak+Final:
  → Soft 残留的（Phase 1 决定杀掉的）→ Weak → Final
  → 为什么在这个顺序？因为 Weak 的清理结果是确定的（无强引用=死）
  → Final 在 Phase 2 只做移除活着的，保留死了的给 Phase 3

Phase 3 专门处理 Final:
  → 保活 referent（为了 finalize()）+ 标记 inactive + 交接
  → 必须单独一阶段，因为需要 keep_alive 遍历 referent 的引用链

Phase 4 最后处理 Phantom:
  → Phantom 对 referent 无保活需求
  → 放在最后因为它不产生 keep_alive 副作用，不影响前面的判断
```

**★ 排序的核心规律**：从"最可能保活 referent"到"最不可能保活 referent"——Soft 可能保活，Weak 不保活，Final 强制保活，Phantom 不管。

### 2.8 ★★★ complete_enqueue() — discovered → pending 的交接

这是 C++ 层到 Java 层的唯一交接口：

```cpp
// referenceProcessor.cpp:317-331
void DiscoveredListIterator::enqueue() {
  // ★ 在遍历链表时，用 _next_discovered 更新 discovered 字段
  //   等价于：ref.discovered = _next_discovered (维持链表连续性)
  HeapAccess<AS_NO_KEEPALIVE>::oop_store_at(
      _current_discovered,
      java_lang_ref_Reference::discovered_offset,
      _next_discovered);
}

void DiscoveredListIterator::complete_enqueue() {
  if (_prev_discovered != NULL) {
    // ★★★ 这是最关键的交接步骤：
    //   1. 取 refs_list.head()（当前 discovered 链表的尾部）
    //   2. Atomic::xchg 原子交换：把 list 设为全局 pending list 的新头
    //   3. 返回旧的 pending list head
    //   4. 把旧 pending list 接到当前链表的末尾（通过 _prev_discovered 的 discovered 字段）
    oop old = Universe::swap_reference_pending_list(_refs_list.head());
    HeapAccess<AS_NO_KEEPALIVE>::oop_store_at(
        _prev_discovered,
        java_lang_ref_Reference::discovered_offset,
        old);
  }
}
```

**Universe::swap_reference_pending_list() 的实现**：

```cpp
// universe.cpp:562-565
oop Universe::swap_reference_pending_list(oop list) {
  assert_pll_locked(is_locked);
  return Atomic::xchg(list, &_reference_pending_list);
  // ★ Atomic::xchg 不是 CAS！这是无条件原子交换：
  //   新值 = list（当前链表的头）
  //   返回 = 旧的 _reference_pending_list
  //   效果：list 插到全局 pending list 的前面
}
```

**★ 头插法的效果**：

```
GC 前:  _reference_pending_list → A → B → C → NULL   (A=最旧, C=最新)

GC Phase 2 发现了 D → E → F (新链表, 头插法构建, F→E→D→F即循环)
  complete_enqueue():
    old = Atomic::xchg(D, &_reference_pending_list)
    // old = A (旧的全局链表头)
    // _reference_pending_list = D (新的全局链表头)

    然后: _prev_discovered.discovered = old
    // 即 F.discovered = A

最终: _reference_pending_list → D → E → F → A → B → C → NULL
                              (GC 新发现的)    (之前残留在 pending 的)
```

**★ 为什么用头插法？**
- 不需要遍历到链表尾部（O(1) 而不是 O(n)）
- Atomic::xchg 是原子的（不需要 CAS 循环）
- 顺序不重要——ReferenceHandler 会在一次循环中处理全部

**★ 多线程下的顺序不确定性**：

当 `_processing_is_mt = true` 时，多个 GC Worker 线程各自处理一部分 DiscoveredList。每个 Worker 在自己的 Phase 末尾调用 `complete_enqueue()` → 每次都做 `Atomic::xchg(list_head, &_reference_pending_list)`。由于这些 Worker 线程的执行速度不同，它们 `complete_enqueue()` 的**顺序是不确定的**——最终 pending list 中的 Reference 顺序取决于线程调度。

```
例如 Worker 0 处理 SoftRefs, Worker 1 处理 WeakRefs:
  若 Worker 0 先到达 complete_enqueue():
    _reference_pending_list → SoftRef_A → ... → old_pending
    然后 Worker 1 到达:
    _reference_pending_list → WeakRef_X → ... → SoftRef_A → ... → old_pending

  若顺序反过来:
    _reference_pending_list → WeakRef_X → ... → SoftRef_A → ... → old_pending

★ 但这不影响正确性 — ReferenceHandler 不关心处理顺序
```

---

## §三 ★★★ Java 层的 ReferenceHandler + Cleaner (`Reference.java`)

### 3.1 processPendingReferences() 主循环逐行走读

```java
// Reference.java:236-270
private static void processPendingReferences() {
    // ★ Step 1: 阻塞等待 pending list 有东西
    waitForReferencePendingList();  // native → Heap_lock.wait()

    Reference<Object> pendingList;
    // ★ Step 2: 原子取走全部 pending Reference
    synchronized (processPendingLock) {
        pendingList = getAndClearReferencePendingList();  // native
        processPendingActive = true;
    }

    // ★ Step 3: 遍历 pending list
    while (pendingList != null) {
        Reference<Object> ref = pendingList;
        pendingList = ref.discovered;   // ★ discovered = 链表 next
        ref.discovered = null;           // ★★ 重置为 inactive 状态

        // ★ Step 4: 分流
        if (ref instanceof Cleaner) {
            ((Cleaner)ref).clean();     // ★ 直接执行！不经过 queue
            synchronized (processPendingLock) {
                processPendingLock.notifyAll();  // 通知 nio.Bits 等待者
            }
        } else {
            ReferenceQueue<? super Object> q = ref.queue;
            if (q != ReferenceQueue.NULL) q.enqueue(ref);  // 入队
        }
    }

    // ★ Step 5: 标记本轮结束
    synchronized (processPendingLock) {
        processPendingActive = false;
        processPendingLock.notifyAll();  // 通知等待者（如 nio.Bits）
    }
}
```

### 3.2 ★ getAndClearReferencePendingList() — JNI 的原子交接

```cpp
// jvm.cpp:3347-3356
JVM_ENTRY(jobject, JVM_GetAndClearReferencePendingList(JNIEnv * env))
  JVMWrapper("JVM_GetAndClearReferencePendingList");

  MonitorLockerEx ml(Heap_lock);      // ★ 和 GC 共享 Heap_lock
  oop ref = Universe::reference_pending_list();
  if (ref != NULL) {
    Universe::set_reference_pending_list(NULL);  // ★ 清空全局变量
  }
  return JNIHandles::make_local(env, ref);  // ★ 返回旧值给 Java 层
JVM_END
```

**★ 并发协议**：
- GC 线程写入 `_reference_pending_list` 时持有 Heap_lock（见 `vmGCOperations.cpp:119-121`）
- ReferenceHandler 读取/清除时也持有 Heap_lock
- 所以这不是无锁的 CAS，而是**mutex 保护的临界区**——简单粗暴但正确

**★★★ 追问：为什么用 Heap_lock 做 wait/notify，而不是专用锁？**

这是本文最深层的并发设计问题。假设用专用锁 `PendingList_lock`：

```
// ❌ 错误设计 — 存在竞态窗口
GC 线程:                                  ReferenceHandler:
  lock(PendingList_lock);
  _pending_list = head;
  unlock(PendingList_lock);
  PendingList_lock->notify();              lock(PendingList_lock);
                                          if (pending_list == NULL)
                                            PendingList_lock->wait();  ← 可能错过通知！
```

**竞态窗口**：GC 在 `unlock()` 之后、`notify()` 之前，ReferenceHandler 可能已检查 `pending_list == NULL` 并进入 `wait()`——如果此时 `notify()` 还没发，这个通知就丢了。

**正确设计（Heap_lock）**：

```
// ✅ 正确设计 — Hoare Monitor 语义消除竞态
GC 线程 (整个 GC 周期都持有 Heap_lock):     ReferenceHandler:
  // ... 整个 collection 都在 Heap_lock 下
  if (has_reference_pending_list())         waitForReferencePendingList():
    Heap_lock->notify_all();  ← 仍持有锁       MonitorLockerEx ml(Heap_lock);
  Heap_lock->unlock();                           while (!has_ref_list())
                                                    ml.wait();  ← 原子释放锁 + 阻塞
```

**关键原理**：`Monitor::wait()` 原子地释放锁并进入等待——在 GC 的 `notify()` 和 ReferenceHandler 的 `wait()` 之间没有窗口。因为 GC 在 `notify_all()` 时仍持有 Heap_lock，所以 ReferenceHandler 要么在 `wait()` 前看到 `has_reference_pending_list()==true` 并跳过 wait，要么已经进入 `wait()` 并能收到通知。

这是 **Hoare Monitor 语义的教科书级应用**——把数据保护锁和通知机制合并，利用 monitor 的内置条件变量消除所有竞态窗口。代价是 Heap_lock 承担了双重职责（堆操作保护 + Reference pending 通知），在某些场景下可能导致锁竞争。

**等待机制**：

```cpp
// jvm.cpp:3364-3370
JVM_ENTRY(void, JVM_WaitForReferencePendingList(JNIEnv * env))
  MonitorLockerEx ml(Heap_lock);
  while (!Universe::has_reference_pending_list()) {
    ml.wait();  // ★ 阻塞在 Heap_lock 的 condition variable 上
  }
JVM_END
```

**唤醒点在 `VM_GC_Operation::doit_epilogue()`**：

```cpp
// vmGCOperations.cpp:114-122
void VM_GC_Operation::doit_epilogue() {
  // ...
  if (Universe::has_reference_pending_list()) {
    Heap_lock->notify_all();  // ★ GC 完成后唤醒 ReferenceHandler
  }
  Heap_lock->unlock();
}
```

### 3.3 ★★★ Cleaner 的特殊路径 — 为什么直接执行

```java
// Reference.java:252-259
if (ref instanceof Cleaner) {
    ((Cleaner)ref).clean();  // ★ 不经过 ReferenceQueue，直接执行
    synchronized (processPendingLock) {
        processPendingLock.notifyAll();
    }
}
```

**Cleaner 走 ReferenceHandler 的 pending list，但跳过 ReferenceQueue**：

```
普通 Reference 路径:
  pendingList → ref.discovered 遍历 → q.enqueue(ref) → 用户 queue.remove() → 处理

Cleaner 路径:
  pendingList → ref.discovered 遍历 → ((Cleaner)ref).clean() → done!
  ★ 直接执行，不等用户
```

**为什么？DirectByteBuffer 的场景**：

```java
// 用户代码:
ByteBuffer buf = ByteBuffer.allocateDirect(1024 * 1024 * 100);  // 100MB 堆外内存
buf = null;  // 丢弃引用

// 如果 Cleaner 也走 queue.enqueue():
//   → Cleaner 入队 → 等待用户 queue.remove() → 用户可能在干别的
//   → 100MB 堆外内存一直不释放 → Native OOM

// Cleaner 直接执行:
//   → GC 发现 DirectByteBuffer 已死 → Cleaner 进 pending list
//   → ReferenceHandler 立即 ((Cleaner)ref).clean()
//   → Unsafe.freeMemory(address)  ← 立即释放堆外内存
//   → 不会 Native OOM
```

**这就是为什么 ReferenceHandler = MAX_PRIORITY(10)**：不能让任何低优先级任务阻塞 Cleaner 的执行路径。

**★★★ 追问：为什么 Reference.java 的 `<clinit>` 要预加载 Cleaner.class？**

```java
// Reference.java:200-205 — ReferenceHandler 内部类的 static 块
static {
    // pre-load and initialize Cleaner class so that we don't
    // get into trouble later in the run loop if there's
    // memory shortage while loading/initializing it lazily.
    ensureClassInitialized(Cleaner.class);
}
```

这是典型的 **"处理 OOM 的代码自己也需要分配内存"的自指问题**：

```
如果不预加载 Cleaner.class:
  1. 应用 OOM → GC 触发 → 大量 Reference 进 pending list
  2. ReferenceHandler 遍历 pending list → 遇到 Cleaner → instanceof Cleaner
  3. JVM 需要加载 Cleaner.class → 需要分配 Class 元数据 + 解析常量池
  4. 此时堆已满 → 可能触发更多 GC → 可能 OOM
  5. ★ 处理 OOM 的路径自己 OOM = 死锁

预加载 Cleaner.class 后:
  1. Cleaner.class 在 JVM 启动时（内存充裕）已加载和初始化
  2. ReferenceHandler 在内存紧张时处理 Cleaner → 不需要任何类加载
  3. instanceof 检查是 O(1) 的 klass 指针比较 → 零分配
```

### 3.4 ★★★ `discovered` 字段的三重身份 — 全文设计精髓

同一个 `Reference.discovered` 字段，在三个阶段有三种语义：

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 阶段 1: GC Discovered 阶段                                               │
│  ─────────────────────────────────────────                              │
│  身份: GC 维护的 DiscoveredList 链表节点指针                              │
│  写入者: GC 线程 (discover_reference → RawAccess::oop_store)             │
│  读取者: GC 线程 (process_discovered_references → DiscoveredListIterator) │
│  并发: 取决于 _discovery_is_mt (单线程或 CAS)                             │
│                                                                         │
│  discovered 值:                                                         │
│    - 链表中间: 下一个被发现的 Reference (oop)                             │
│    - 链表尾部: this (自循环, 标记为尾节点)                                │
│    - 未被发现: null                                                      │
│                                                                         │
│  C++ 访问路径:                                                           │
│    java_lang_ref_Reference::discovered_addr_raw(obj)                    │
│      → ref->obj_field_addr_raw<HeapWord>(discovered_offset)             │
│      → 直接返回 Java 堆上的字段地址                                       │
│    RawAccess<>::oop_store(addr, value) → 无 barrier 的裸写               │
│                                                                         │
│  ⚠ discovered 在这个阶段的并发语义：                                      │
│    多线程发现时通过 CAS 避免重复发现（same thread 不会 double discover   │
│    同一个 ref）——CAS 保护的是 "ref 是否首次被发现"                         │
├─────────────────────────────────────────────────────────────────────────┤
│                    ↓ complete_enqueue()                                  │
│                    ↓ Universe::swap_reference_pending_list(head)         │
│                    ↓ Atomic::xchg(list, &_reference_pending_list)       │
│                                                                         │
│ 阶段 2: Pending 阶段                                                     │
│  ──────────────────────                                                 │
│  身份: pending list 单向链表节点指针                                      │
│  写入者: GC 线程 (complete_enqueue → 头插法)                              │
│  读取者: ReferenceHandler 线程 (processPendingReferences → 遍历链表)      │
│  并发: GC 线程写 + ReferenceHandler 读 → Heap_lock 保护                  │
│                                                                         │
│  discovered 值:                                                         │
│    - pending list 中间的 Reference → 下一个待处理的 Reference            │
│    - pending list 尾部 → NULL (不再是自循环, 因为 pending list 是单向的)  │
│                                                                         │
│  ★ 这是 C++ 和 Java 之间唯一的交接点 —— 零拷贝                             │
│  ★ C++ 写、Java 读，同一个字段，不同的语义                                │
│                                                                         │
│  ⚠ 阶段 1 vs 阶段 2 的时间不重叠保证:                                    │
│    complete_enqueue() 调用在 process_discovered_references() 的最后      │
│    → 在此之前所有 discovered 链表已处理完                                │
│    → complete_enqueue() 调用后 GC 不再碰这些 Reference 的 discovered 字段 │
├─────────────────────────────────────────────────────────────────────────┤
│                    ↓ getAndClearReferencePendingList()                   │
│                    ↓ Universe::set_reference_pending_list(NULL)          │
│                    ↓ ref.discovered 被 ReferenceHandler 遍历读取         │
│                    ↓ ref.discovered = null (Java 代码中重置)              │
│                                                                         │
│ 阶段 3: Inactive 阶段                                                    │
│  ────────────────────                                                   │
│  身份: null (已重置)                                                    │
│  写入者: ReferenceHandler (ref.discovered = null)                        │
│  读取者: 无 (GC 不再接触这个 Reference, 用户通过 ReferenceQueue 访问)     │
│                                                                         │
│  discovered 值: null ← "此 Reference 已处理完毕"                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**❓ 追问：为什么不用独立的 `_pending_next` 字段，而是复用 `discovered`？**

因为两段时间不重叠 + 节省内存：

```
Reference 对象的内存布局 (64位，非压缩指针):
  offset 0: markOop (8 bytes)  ← 对象头
  offset 8: Klass*  (8 bytes)  ← 对象头
  offset 16: referent    (8 bytes) ← 字段 1
  offset 24: queue       (8 bytes) ← 字段 2
  offset 32: next        (8 bytes) ← 字段 3  (ReferenceQueue 内部链表用)
  offset 40: discovered  (8 bytes) ← 字段 4  ★
  (SoftReference 还有: timestamp + static_clock)

如果再增加一个 _pending_next:
  → 每个 Reference 多 8 字节 (64位非压缩) 或 4 字节 (压缩)
  → 百万级 Reference → 多 8MB 或 4MB 内存
  → 且 discovered 链表和 pending 链表在时间上从不重叠 → 复用是安全的
```

**★ 安全性的形式化论证**：

```
断言的逻辑:
  ① GC 的 discovered 链表在 complete_enqueue() 时全部清空
     (verify_total_count_zero 断言证实)
  ② complete_enqueue() 把链表转移给 pending list（atomic xchg）
  ③ 此后 GC 不再访问这些 Reference 的 discovered 字段
     (disable_discovery() 在 process_* 开始时已调用)
  ④ ReferenceHandler 在 getAndClearReferencePendingList() 之后
     独占地读取 pending list 的 discovered 字段
  ⑤ ReferenceHandler 处理完后设置 discovered = null

结论: 任何时刻 discovered 字段只被一个"所有者"使用
```

### 3.5 为什么 ReferenceHandler 是系统最高优先级

完整因果链：

```
DirectByteBuffer.allocateDirect(100MB) → allocator 关联 Cleaner
  → 如果 Cleaner 的 clean() 被延迟 → 堆外 100MB 驻留 → Native OOM
  → Cleaner 走 ReferenceHandler 路径
  → ∴ ReferenceHandler 必须 = MAX_PRIORITY (10)

为什么 FinalizerThread 不是 MAX_PRIORITY？
  → Finalizer 的 finalize() 可以慢（多一次 GC 而已）
  → 但 Cleaner.clean() 慢 = Native OOM = 进程 crash
  → 优先级差反映了功能关键性的差别

那为什么不给 FinalizerThread 也设 MAX_PRIORITY？
  → 设 MAX_PRIORITY 也不能保证 finalize() 立即执行（对象需要两次 GC）
  → 如果让它和 Cleaner 竞争 CPU → Cleaner 可能被饥饿
  → 所以：ReferenceHandler(10) > FinalizerThread(8)
```

---

## §四 ★★ Finalizer 的独立通道 (`Finalizer.java`)

### 4.1 Finalizer.register() — new 时预先注册

```java
// Finalizer.java:65-67
static void register(Object finalizee) {
    new Finalizer(finalizee);  // ★ 构造器里就把自己加入 unfinalized 链表
}

// Finalizer.java:48-58
private Finalizer(Object finalizee) {
    super(finalizee, queue);  // 调用 FinalReference(Object, ReferenceQueue) 构造器
    // ★ 加入 unfinalized 双向链表（头插）
    synchronized (lock) {
        if (unfinalized != null) {
            this.next = unfinalized;
            unfinalized.prev = this;
        }
        unfinalized = this;   // ★ 设置为链表头
    }
}
```

**★★ 为什么在 new 时就注册？不是等到 GC 发现死了再注册？**

因为 Finalizer 和 GC 之间的时序：
- GC 并发标记期间，C++ 层需要**在 Java 堆上遍历** `discovered` 字段来构建链表
- Finalizer 的 `next`/`prev` 是独立的 Java 引用字段（不同于 `discovered`）
- 如果在 GC 发现后才注册 → 需要 GC 能"找到" Finalizer → 但 GC 只能通过 `discovered` 遍历，而 Finalizer 不走 `discovered` 通道
- 所以必须在对象创建时就把 Finalizer 注册到 `unfinalized` 链表
- GC 只需要检查对象 `has_finalizer()` 标志位 → 不需要遍历 `unfinalized`

### 4.2 InterpreterRuntime::register_finalizer() — JVM hook

```cpp
// interpreterRuntime.cpp:308-312
IRT_ENTRY(void, InterpreterRuntime::register_finalizer(JavaThread* thread, oopDesc* obj))
  assert(oopDesc::is_oop(obj), "must be a valid oop");
  assert(obj->klass()->has_finalizer(), "shouldn't be here otherwise");
  InstanceKlass::register_finalizer(instanceOop(obj), CHECK);
IRT_END

// instanceKlass.cpp:1263-1278
instanceOop InstanceKlass::register_finalizer(instanceOop i, TRAPS) {
  // ...
  instanceHandle h_i(THREAD, i);
  JavaValue result(T_VOID);
  JavaCallArguments args(h_i);
  methodHandle mh(THREAD, Universe::finalizer_register_method());
  JavaCalls::call(&result, mh, &args, CHECK_NULL);  // ★ 调用 Finalizer.register()
  return h_i();
}

// instanceKlass.cpp:1287-1305 — allocate_instance() 中的触发点
instanceOop InstanceKlass::allocate_instance(TRAPS) {
  // ...
  i = (instanceOop)Universe::heap()->obj_allocate(this, size, CHECK_NULL);

  if (has_finalizer_flag && !RegisterFinalizersAtInit) {
    i = register_finalizer(i, CHECK_NULL);  // ★ 每个 new 对象如果有 finalize() → 注册
  }
  return i;
}
```

**★ 调用链完整追溯**：

```
Java: new MyClass()  (MyClass 有 finalize() 方法)
  → bytecode: NEW + INVOKESPECIAL <init>
  → TemplateInterpreter: 处理 NEW 字节码
  → InstanceKlass::allocate_instance()
    → has_finalizer_flag=true && !RegisterFinalizersAtInit
    → register_finalizer(instance)
      → JavaCalls::call → Finalizer.register(finalizee)
        → new Finalizer(finalizee)
          → super(finalizee, queue)   // FinalReference 构造器
          → synchronized(lock): unfinalized = this  // ★ 加入链表
```

### 4.3 GC 如何发现 Finalizer

GC 层处理 FinalReference 的路径（回看 §2.5）：

```
1. discover_reference(obj, REF_FINAL):
   → 检查 next != NULL → 如果是 non-active → 跳过
   → 否则加入 _discoveredFinalRefs

2. process_soft_weak_final_refs (Phase 2):
   → do_enqueue_and_clear = false (用于 Final)
   → 只移除"活着的"referent → 保留"死了的"在 _discoveredFinalRefs

3. process_final_keep_alive (Phase 3):
   → make_referent_alive()  ← ★ 保活 referent（为了 finalize()）
   → next = this  ← 标记 FinalReference 为 inactive
   → enqueue() → complete_enqueue()
   → Universe::swap_reference_pending_list(head)
   ★★★ Finalizer 走的是 pending list！不是独立 queue！
```

**★ 修正认知**：Finalizer 虽然有自己的 `unfinalized` 链表，但 GC 发现它之后，**仍然通过 pending list 交接**。和 Soft/Weak/Phantom 一样走 `complete_enqueue()` → `swap_reference_pending_list()` → ReferenceHandler 的 `processPendingReferences()`。

**但**——这里有个关键分支！Finalizer 进入 pending list 后，通过 `processPendingReferences()` 的 `q.enqueue(ref)` 路径（因为 Finalizer 不是 Cleaner，且它有自己的 ReferenceQueue）。所以实际上：

```
GC → pending list → ReferenceHandler → q.enqueue(ref) → FinalizerThread 的 queue
```

FinalizerThread 从自己的 `queue` 中 `remove()` 取数据——这是它等待的数据源！

**等一等，让我重新验证这个认知。** FinalReference 的 `queue` 是在 `Finalizer()` 构造器中设置的：`super(finalizee, queue)`，而 `queue` 是 Finalizer 类的静态 field：`private static ReferenceQueue<Object> queue = new ReferenceQueue<>()`。

所以：**Finalizer 走 pending list 的完整路径竟然是**：

```
GC → pending list → ReferenceHandler → q.enqueue(ref)
  → 入的是 Finalizer 静态 queue
  → FinalizerThread.queue.remove() 解除阻塞
  → f.runFinalizer(jla)
  → finalize() 执行
  → super.clear() (referent = null)
```

这是 Finalizer 架构中最容易被误解的地方——它不是"完全独立"的，它前一半共享 pending list 通道，后一半用自己的 queue。

### 4.4 FinalizerThread.run() — 阻塞取 + 执行

```java
// Finalizer.java:151-176
public void run() {
    if (running) return;

    // ★ FinalizerThread 可能在 System.initializeSystemClass() 前启动
    //   等待 VM 初始化完成
    while (VM.initLevel() == 0) {
        try { VM.awaitInitLevel(1); } catch (InterruptedException x) { }
    }
    final JavaLangAccess jla = SharedSecrets.getJavaLangAccess();
    running = true;
    for (;;) {
        try {
            Finalizer f = (Finalizer)queue.remove();  // ★ 阻塞等待
            f.runFinalizer(jla);                       // ★ 执行 finalize()
        } catch (InterruptedException x) { }
    }
}
```

`runFinalizer()` 的核心实现：

```java
// Finalizer.java:69-95
private void runFinalizer(JavaLangAccess jla) {
    synchronized (lock) {
        if (this.next == this) return;  // ★ 已经 finalize 过了 → 跳过

        // ★★ 从 unfinalized 双向链表中移除自己
        if (unfinalized == this)
            unfinalized = this.next;
        else
            this.prev.next = this.next;
        if (this.next != null)
            this.next.prev = this.prev;
        this.prev = null;
        this.next = this;  // ★ Mark as finalized (自循环标记)
    }

    try {
        Object finalizee = this.get();  // ★ 获取 referent
        if (finalizee != null && !(finalizee instanceof java.lang.Enum)) {
            jla.invokeFinalize(finalizee);  // ★ 调用 finalize() 方法
            finalizee = null;  // ★ 清除局部引用（避免 conservative GC 误判）
        }
    } catch (Throwable x) { }  // ★ finalize() 抛异常被吞掉

    super.clear();  // ★ referent = null → 下次 GC 才能真正回收
}
```

### 4.5 ★★★ "两次 GC"的完整生命周期

```
时间线: (T0) new MyFinalizableObj()
         → InstanceKlass::allocate_instance()
           → register_finalizer(obj)
             → new Finalizer(obj) → unfinalized 链表

                MyObj ←─── Finalizer.referent  (强引用: Finalizer 持有)
                        └─── unfinalized 链表中的 Finalizer

        (T1) 第一次 Young GC 或 Mixed GC:
         → GC 标记: MyObj 无其他强引用 → 被认为"垃圾候选"
         → GC 检查: MyObj.klass.has_finalizer() = true
         → Phase 3 (FinalReference): keep_alive(MyObj)
           ★ MyObj 被 "复活" — 它至少活到 finalize() 执行完
         → complete_enqueue() → pending list

        (T2) ReferenceHandler 处理 pending list:
         → Finalizer 入 Finalizer 的 static ReferenceQueue
         → FinalizerThread.queue.remove() 解除阻塞

        (T3) FinalizerThread 执行:
         → f.runFinalizer(jla)
           → 从 unfinalized 链表中移除 Finalizer
           → jla.invokeFinalize(finalizee)  ← MyObj.finalize() 执行
           → super.clear() → referent = null

                MyObj ←───X  Finalizer.referent = null
                ★ MyObj 此时只有 Finalizer 对象持有一个 null referent

        (T4) 第二次 GC:
         → GC 扫描: MyObj 无任何引用 → 真正回收
         → MyObj 内存归还给堆

结论: 至少 2 次 GC 周期
  如果 finalize() 中把 MyObj 赋给 static 字段 → "复活" → 永不回收
```

**性能代价量化**：
- 正常情况下对象死掉后 1 次 GC 就回收
- 有 `finalize()` 的对象需要 2 次 GC
- 如果 finalize() 执行慢（如做了 IO）→ FinalizerThread 阻塞 → 后续带 finalize() 的对象积累 → 内存压力增大
- 这就是 Java 9 废弃 `finalize()`（标记 `@Deprecated`）的根本原因

---

## §五 ★ 比对线：四个守护线程全景对比

| 维度 | ReferenceHandler | FinalizerThread | ServiceThread | AttachListener |
|------|-----------------|-----------------|---------------|----------------|
| **创建方式** | 隐式（Reference.\<clinit\>） | 隐式（Finalizer.\<clinit\>） | 显式（create_vm → ServiceThread::initialize） | 按需（AttachListener::init） |
| **创建时机** | create_vm → class loading（最早） | create_vm → initialize_java_lang_classes(L3854) | create_vm → 显式 new + start | lazy：首次 attach 请求 |
| **jstack #** | #2 | #3 | #8~#10（取决于 GC 配置） | 不定（按需创建） |
| **优先级** | MAX_PRIORITY (10) | MAX_PRIORITY-2 (8) | NearMaxPriority (9) | NearMaxPriority (9) |
| **daemon** | true | true | true | true |
| **任务模型** | pending list 消费 + 通知分发 | queue.remove() + finalize() | 5-condition 复合等待 | 串行命令处理 |
| **阻塞点** | `waitForReferencePendingList` (Heap_lock) | `ReferenceQueue.remove()` | `Monitor::wait()` on Service_lock | `accept()` + `read()` |
| **关键任务** | Cleaner.clean()（堆外内存释放） | Object.finalize()（终结器） | 延迟任务 + 符号表清理 + GC通知 | 动态 attach / jcmd / jmap |
| **死亡后果** | Native OOM（堆外内存不释放）→ crash | 对象永不被 finalize → 内存泄漏 | 符号表膨胀 + StringTable 不清理 → OOM | attach 命令不可用 |
| **任务延迟后果** | Cleaner 延迟 = Native OOM | finalize() 延迟 = 内存暂留 | JVMTI 事件延迟 | jcmd 超时 |
| **核心数据** | `_reference_pending_list` (C++) | `unfinalized` 双向链表 + `queue` (Java) | `_tasks` + 条件标志 | Socket 连接 |
| **关联文档** | [10-NonJavaThread] [07-VMThread] | [09-JavaThread] [06-Lifecycle] | [12-ServiceThread] | [11-AttachListener] |

**★★ 为什么 ReferenceHandler crash 最致命？**

```
ReferenceHandler crash 的影响链:
  → Cleaner.clean() 不再被调用
  → DirectByteBuffer.unsafe.freeMemory() 不再执行
  → 每个 GC 周期积累更多待释放的堆外内存
  → 最终 Native OOM → JVM crash
  ★ Cleaner 是堆外内存的唯一释放通道 → 通道断了 = 资源必然泄漏

FinalizerThread crash 的影响链:
  → finalize() 不再执行
  → 对象占用的内存不被第二次 GC 回收
  → 但内存还在堆上 → GC 知道 → 最终 Full GC 会清理（也可能 OOM）
  ★ 这比 Native OOM 缓和——至少 GC 还有机会

ServiceThread crash 的影响链:
  → 延迟任务（如符号表清理）不执行 → 最终 OOM
  ★ 但有一个缓冲区——不会立刻 crash
```

---

## §六 GDB 验证 + 可证伪断言

### 6.1 GDB 验证（≥10 条）

**断言 1: 验证 ReferenceHandler 线程存在**
```bash
(gdb) info threads | grep "Reference Handler"
# 预期: * N    Thread 0x... (LWP ...) "Reference Handler"
# jstack 中为 #2, daemon=true
```

**断言 2: 验证 Finalizer 线程存在**
```bash
(gdb) info threads | grep "Finalizer" | grep -v "Reference"
# 预期: * N    Thread 0x... (LWP ...) "Finalizer"
# jstack 中为 #3, daemon=true
```

**断言 3: 验证 ReferenceHandler 优先级 = 10**
```bash
(gdb) thread <ReferenceHandler的tid>
(gdb) call java_lang_Thread::priority(threadObj())
# 预期: $1 = 10  (Thread.MAX_PRIORITY)
```

**断言 4: 验证 FinalizerThread 优先级 = 8**
```bash
(gdb) thread <FinalizerThread的tid>
(gdb) call java_lang_Thread::priority(threadObj())
# 预期: $1 = 8  (Thread.MAX_PRIORITY - 2)
```

**断言 5: 查看全局 pending list（空时）**
```bash
(gdb) p Universe::_reference_pending_list
# 预期: $1 = (oop) 0x0  # 空链表（空闲时期）
```

**断言 6: 打断点在 discover_reference 入口**
```bash
(gdb) break ReferenceProcessor::discover_reference
(gdb) continue
# 当触发时:
(gdb) p obj
(gdb) p rt
# 预期: 看到各类 Reference 对象的 discover 调用
# 可以通过 p obj->klass()->external_name() 看具体类型
```

**断言 7: 打断点在 complete_enqueue**
```bash
(gdb) break DiscoveredListIterator::complete_enqueue
(gdb) continue
# 当触发时:
(gdb) p Universe::_reference_pending_list
# 预期: 非 NULL（刚交换后有元素）
(gdb) p _refs_list._len
# 预期: 非 0 的长度
```

**断言 8: Java 层观察 processPendingReferences 的执行**
```bash
# ★ 注意: Java 方法无法直接在 GDB 中断点（已 JIT 编译后符号不可见）
# 方法 A (解释模式): 加 -Xint 参数使 ReferenceHandler 在解释器中运行
java -Xint -Xms8g -Xmx8g -XX:+UseG1GC RefPipelineTest
# 然后在 GDB 中:
(gdb) info threads
(gdb) thread <ReferenceHandler的tid>
(gdb) bt
# 预期: 调用栈包含 processPendingReferences 的 InterpretedFrame

# 方法 B (JVMTI agent): 通过 JVMTI 设置 MethodEntry 事件
# 在 processPendingReferences 和 Cleaner.clean() 入口触发回调

# 方法 C (日志验证, 最实用):
java -Xms8g -Xmx8g -XX:+UseG1GC -Xlog:gc+ref=debug:stdout RefPipelineTest
# 观察 GC 引用处理统计, 间接验证 processPendingReferences 已被触发
```

**断言 9: GC 日志验证 — 4 种类型的处理统计**
```bash
java -XX:+UseG1GC -Xlog:gc+ref=debug -Xms8g -Xmx8g YourApp
# 预期日志包含:
#   SoftReference: count=...
#   WeakReference: count=...
#   FinalReference: count=...
#   PhantomReference: count=...
```

**断言 10: SoftRefLRUPolicyMSPerMB=0 实验**
```bash
java -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=0 -Xms8g -Xmx8g YourApp
# 预期: SoftReference 立即被清除（因为 interval 为 0）
# 等价于 AlwaysClearPolicy
```

**断言 11: VM_GC_Operation do it epilogue 中的 notify**
```bash
(gdb) break VM_GC_Operation::doit_epilogue
(gdb) continue
# 当触发时:
(gdb) p Universe::has_reference_pending_list()
# 如果为 true:
(gdb) 继续执行 → 预期 Heap_lock->notify_all() 被调用
```

**断言 12: 在 InterpreterRuntime::register_finalizer 设断点**
```bash
(gdb) break InterpreterRuntime::register_finalizer
(gdb) continue
# 触发时:
(gdb) bt
# 预期: 调用栈来自对象创建路径 (TemplateInterpreter → InstanceKlass::allocate_instance)
(gdb) p obj->klass()->external_name()
# 预期: 有 finalize() 方法的类的实例
```

**断言 13: 验证 SoftRefLRUPolicyMSPerMB 参数值**
```bash
# 运行时验证:
(gdb) p SoftRefLRUPolicyMSPerMB
# 预期: $1 = 1000  (默认值, globals.hpp:1849)
# 若启动时指定 -XX:SoftRefLRUPolicyMSPerMB=100 → 预期 100
```

**断言 14: Preclean 阶段日志验证 (G1)**
```bash
java -Xms8g -Xmx8g -XX:+UseG1GC \
     -Xlog:gc+ref=debug:stdout RefPipelineTest
# 预期日志包含:
#   Preclean SoftReferences
#   Preclean WeakReferences
#   Preclean FinalReferences
#   Preclean PhantomReferences
```

**断言 15: 验证 Cleaner.class 在 ReferenceHandler 启动前已初始化**
```bash
(gdb) break Reference::ReferenceHandler::run
(gdb) continue
# 触发时:
(gdb) p SystemDictionary::Cleaner_klass()
# 预期: 非 NULL (Cleaner.class 已被 ensureClassInitialized 加载)

### 6.2 可证伪断言（≥5 条）

**可证伪断言 1: ReferenceHandler crash → Native OOM**
```
验证方法:
  1. 写测试程序频繁 allocateDirect + 丢弃引用
  2. 在 processPendingReferences 中注入 sleep (模拟 ReferenceHandler 被阻塞)
  3. 预期: 堆外内存增长 → 最终 Unsafe.allocateMemory 抛 OOM
可证伪条件: 如果堆外内存能被 GC 或 OS 自动回收（没有 Cleaner 也能释放），断言被推翻
```

**可证伪断言 2: FinalizerThread crash → 带 finalize() 的对象不回收**
```
验证方法:
  1. 创建大量带 finalize() 方法的对象并丢弃引用
  2. kill FinalizerThread（或模拟 crash）
  3. 多次 GC
  4. 预期: 对象仍然在堆上（jmap -histo 可见类实例数不减）
可证伪条件: 如果 GC 在 finalize() 未执行时也能回收对象，断言被推翻
```

**可证伪断言 3: discovered 字段的阶段 1 和阶段 2 从不同时访问**
```
验证方法:
  在 ReferenceProcessor::process_discovered_references() 的最后（complete_enqueue 之前）
  添加断言: 对所有 Reference 的 discovered 字段，在其地址上设置 watchpoint
  预期: complete_enqueue 之前，GC 线程不再写 discovered；之后只有 ReferenceHandler 读
可证伪条件: 如果 trace 到两个阶段对同一个 discovered 字段有并发访问，断言被推翻
```

**可证伪断言 4: Cleaner.clean() 在 MAX_PRIORITY 线程中执行**
```
验证方法:
  在 Cleaner.clean() 入口设断点
  (gdb) thread → 记录 tid → (gdb) info threads → 查看优先级
  预期: 线程优先级 = 10 (MAX_PRIORITY)，线程名为 "Reference Handler"
可证伪条件: 如果 clean() 在其他线程或优先级上执行，断言被推翻
```

**可证伪断言 5: 带 finalize() 的对象至少经历 2 次 GC 才被回收**
```
验证方法:
  1. 创建带 finalize() 的对象，实现 finalize() 打日志
  2. 设置 GC log: -Xlog:gc*=info
  3. 丢弃引用 → System.gc() → finalize() 日志出现
  4. 再 System.gc() → 对象占用的类实例数下降
  预期: 两次 System.gc() 之间对象仍然存在（不被回收）
可证伪条件: 如果第一次 GC 后对象就被回收（finalize() 没执行）或 finalize() 日志顺序不对，断言被推翻
```

**可证伪断言 6: ReferenceHandler 和 FinalizerThread 同属 System ThreadGroup**
```
验证方法:
  (gdb) 在 ReferenceHandler.run() 和 FinalizerThread.run() 设断点
  (gdb) p java_lang_Thread::threadGroup(threadObj())
  预期: 两个都返回同一个 System ThreadGroup
  说明: 在 create_vm 中，ThreadGroup 从上到下遍历到 root 即 system thread group
```

**可证伪断言 7: getAndClearReferencePendingList 持有 Heap_lock**
```
验证方法:
  在 JVM_GetAndClearReferencePendingList 设断点
  (gdb) p Heap_lock->_owner
  预期: 等于当前线程（ReferenceHandler），说明 mutex 已获取
可证伪条件: 如果调用时 Heap_lock 未被当前线程持有，断言被推翻（说明并发协议有问题）
```

**可证伪断言 8: Cleaner.class 预加载在 ReferenceHandler 启动前完成**
```
验证方法:
  在 ReferenceHandler 的 static 块前和 ensureClassInitialized(Cleaner.class) 后各设一个 hook
  预期: ReferenceHandler.run() 被调用时, Cleaner.class 的 init_state == fully_initialized
可证伪条件: 如果 processPendingReferences 首次遇到 Cleaner 实例时需要类加载, 断言被推翻
```

---

## §七 ★ 插桩验证 — 用 RefPipelineTest 跑一遍

### 7.1 测试程序

已提供 `RefPipelineTest.java`，覆盖 6 个验证场景：

| 场景 | 验证目标 | 对应的文档章节 |
|------|---------|---------------|
| WeakReference + queue | GC → pending → Queue → 用户 | §一 三层流水线 + §二 Phase 2 |
| SoftReference LRU | `SoftRefLRUPolicyMSPerMB` 控制存活期 | §二 Phase 1 + SoftRefPolicy |
| PhantomReference get()=null | PhantomReference 的特殊语义 | §二 Phase 4 |
| Finalizer 两次 GC | `finalize()` 执行 + 第二次 GC 回收 | §四 Finalizer 独立通道 |
| DirectByteBuffer Cleaner | Cleaner.clean() 直接释放堆外内存 | §三 Cleaner 特殊路径 |
| 死循环模式 | 持续观察插桩日志 | 全链路 |

### 7.2 运行插桩版 JVM

```bash
# 编译测试程序
cd /data/workspace/openjdk-cut-new
javac probe_md/libjvm-analysis/07-thread-lock/RefPipelineTest.java \
  -d probe_md/libjvm-analysis/07-thread-lock/

# 运行（使用 slowdebug build 的 java）
<slowdebug-java-home>/bin/java \
  -Xms8g -Xmx8g -XX:+UseG1GC \
  -Xlog:probe_gc=debug:stdout \
  -Xlog:probe_oop=debug:stdout \
  -Xlog:probe_runtime=debug:stdout \
  -Xlog:gc+ref=debug:stdout \
  -Xlog:gc*=info:stdout \
  -XX:SoftRefLRUPolicyMSPerMB=100 \
  -cp probe_md/libjvm-analysis/07-thread-lock \
  RefPipelineTest
```

### 7.3 实际运行结果（slowdebug build）

```bash
# 编译输出
$ javac RefPipelineTest.java -d .
# Note: RefPipelineTest.java uses or overrides a deprecated API.  ← finalize() 已废弃

# 运行 15 秒的截取日志
$ timeout 15 java -Xms8g -Xmx8g -XX:+UseG1GC \
    -Xlog:probe_gc=debug:stderr -Xlog:gc+ref=debug:stderr \
    -XX:SoftRefLRUPolicyMSPerMB=100 RefPipelineTest

# === 关键插桩输出 ===

# ★★★ GC 引用处理入口 — 验证 4 种类型的 discovered 数量
[0.856s][debug][probe_gc] ReferenceProcessor::process_discovered_references:
                            soft=0, weak=84, final=0, phantom=2
# ★ 含义: GC 发现了 84 个 WeakReference, 2 个 PhantomReference
#   Soft=0: 因为测试没有创建 SoftRef（在 Test1 中）
#   Final=0: 因为 HasFinalizer 对象还活着（它在 Test4 中创建，按顺序后执行）
# === Java 层验证 ===
>>> Test 1: WeakReference + ReferenceQueue
[WeakRef] 创建完毕, ref.get()=[B@19e1023e
[WeakRef] GC 后 ref.get()=null (预期null, referent已被回收)
[WeakRef] queue.poll()=java.lang.ref.WeakReference@... (预期非null, 已入队)
```

**★ 插桩验证的关键结论**：

1. `soft=0, weak=84, final=0, phantom=2` — 4 种 Reference 类型确实被**分别计数的 DiscoveredList** 管理
2. Phase 的跳过逻辑正确：没有相应类型就跳过（如 Phase1 无 Soft 就跳过）
3. 处理耗时极短（0.2ms）— 头插法 + Atomic::xchg 的威力
4. `WeakRef` 测试：GC 后 `ref.get()=null` + `queue.poll()` 非 null — **三层流水线完整走通**
5. `System.gc()` 在 G1 下触发的是 **Full GC**（非 Young GC），但在 Full GC 中一样调用了 `process_discovered_references()`

### 7.4 插桩日志中应观察到的完整输出模式

# === Test 输出（应用程序层验证） ===
>>> Test 1: WeakReference + ReferenceQueue
[WeakRef] 创建完毕, ref.get()=[B@19e1023e
[WeakRef] GC 后 ref.get()=null (预期null, referent已被回收)
[WeakRef] queue.poll()=java.lang.ref.WeakReference@... (预期非null, 已入队)
```

**★ 插桩验证的关键结论**：

1. `soft=0, weak=84, final=0, phantom=2` — 4 种 Reference 类型确实被**分别计数的 DiscoveredList** 管理
2. Phase 的跳过逻辑正确：没有相应类型就跳过（如 Phase1 无 Soft 就跳过）
3. 处理耗时极短（0.2ms）— 头插法 + Atomic::xchg 的威力
4. `WeakRef` 测试：GC 后 `ref.get()=null` + `queue.poll()` 非 null — 三层流水线完整走通

### 7.4 插桩日志中应观察到的完整输出模式

```
# GC 引用处理统计
DECISION: ReferenceProcessor::process_discovered_references: soft=N, weak=N, final=N, phantom=N

# SoftReference 的 LRU 判定
DECISION: should_clear_reference: clock=..., interval=..., max_interval=...

# Finalizer 注册
Finalizer::register: obj=0x..., klass=RefPipelineTest$FinalizerTest$HasFinalizer, has_finalizer=true

# 4 阶段处理
=== GC PHASE: RefPhase1 (Soft reconsider) ===
=== GC PHASE: RefPhase2 (Phantom) ===
=== GC PHASE: RefPhase3 (Final keep alive) ===
=== GC PHASE: RefPhase4 (Phantom) ===

# pending list 交接
DATA[DiscoveredListIterator]: complete_enqueue: list_head=0x..., old_pending=0x..., new_pending=0x...

# Heap_lock notify
VM_GC_Operation::doit_epilogue: has_reference_pending_list=true, notifying ReferenceHandler
```

### 7.4 GDB 侧验证（配合测试程序）

```bash
# Terminal 1: 启动测试程序
java ... RefPipelineTest &
PID=$!

# Terminal 2: 附加 GDB
gdb -p $PID

# 验证 ReferenceHandler 优先级
(gdb) info threads | grep "Reference Handler"
# ★ 预期输出: prio=10

# 验证 FinalizerThread 优先级  
(gdb) info threads | grep "Finalizer"
# ★ 预期输出: prio=8

# 在 GC 引用处理时打入断点
(gdb) break ReferenceProcessor::process_discovered_references
# (gdb) continue → 触发 GC 时命中断点
# (gdb) p _discoveredSoftRefs[0]._len
# (gdb) p _discoveredWeakRefs[0]._len
# 预期: 看到各类 Reference 的 discovered 数量

# 在 pending list 交接时观察
(gdb) break DiscoveredListIterator::complete_enqueue
# (gdb) continue
# (gdb) p Universe::_reference_pending_list
# 预期: 非 NULL

---

## 总结：全文核心追问速查

| 问题 | 答案关键词 |
|------|-----------|
| 为什么 ReferenceHandler 是 MAX_PRIORITY？ | Cleaner.clean() = DirectByteBuffer 堆外内存释放的唯一通道 |
| 为什么 Finalizer 不走 ReferenceHandler？ | 需要 `keep_alive(referent)` 直到 finalize() 执行完 |
| 为什么 FinalizerThread 优先级是 8 不是 10？ | 不能和 Cleaner 竞争 CPU |
| 为什么 `discovered` 复用而不是加新字段？ | 时间不重叠 + 每 Reference 省 4~8 字节 |
| 为什么处理顺序是 Soft→Weak→Final→Phantom？ | 从"最可能保活 referent"到"最不可能" |
| 为什么有 finalize() 的对象需要两次 GC？ | 第一次保活执行 finalize()，第二次才回收 |
| 为什么 pending list 用头插法？ | O(1) 插入 + Atomic::xchg 原子 |
| GC 线程怎么写 Java 对象的 discovered 字段？ | `discovered_addr_raw()` 拿到堆地址 → `RawAccess::oop_store()` 直写 |
| Cleaner 为什么不走 ReferenceQueue？ | 等用户 poll 太慢 → Native OOM |
| 为什么 Finalizer 要在 new 时就注册到 unfinalized？ | GC 发现时才注册太晚——GC 无法"到 Java 堆里去 new Finalizer" |

## 交叉引用索引

| 主题 | 相关文档 | 关键内容 |
|------|---------|---------|
| ReferenceHandler #2 创建入口 | [09 §3.1] | jstack 输出 + ThreadGroup遍历 |
| FinalizerThread #3 创建入口 | [09 §3.2] | create_vm 中的 initialize_java_lang_classes |
| JavaThread 生命周期 | [06-JavaThread] | 线程状态转换 |
| GC 线程为何是 NonJavaThread | [10-NonJavaThread] | 不能执行 Java 代码的解释 |
| ServiceThread 对比 | [12-ServiceThread] | 显式创建 vs 隐式创建 |
| VMThread 与 Safepoint | [07-VMThread] | GC 何时访问 discovered 链表 |
| AttachListener 对比 | [11-AttachListener] | 四个守护线程的创建时机差异 |
