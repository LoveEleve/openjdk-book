# 03. SoftReference 什么时候被清除？— Reference Processing

> 🔴 Deep | 5 KP 中的引用生命周期
> 读者处境: `SoftReference<byte[]> ref = new SoftReference<>(new byte[100MB])`——内存紧张时 GC 可以清它。WeakReference 在下次 GC 就被清。PhantomReference 在对象被回收后才 enqueue——用于 clean up native resource。

### 1. "四种引用——四条生命线"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"四条链表" 半对**: 真实=DiscoveredList(referenceProcessor.hpp:61-84)只存 **head 指针+长度**,链接走 **Reference 对象自身的 discovered 字段**串链(load_ptrs :269-286,add_to_discovered_list cpp:1050-1073);四列表是**一个连续数组的四段**(cpp:123-126 weak/final/phantom 指向 soft 数组偏移),每段 _max_num_queues 槽
> - **"process_discovered_references (referenceProcessor.cpp:200-800) 4 个 while 循环" 简化**: 真实=四阶段任务(referenceProcessor.cpp:201-261): 停用 discovery :213/同步 soft clock :223/统计 :225-228/**RefPhase1** process_soft_ref_reconsider(:232,:795-837)/update_soft_ref_master_clock :236/**RefPhase2** process_soft_weak_final_refs(:240,:839-915)/**RefPhase3** process_final_keep_alive(:245,:917+)/**RefPhase4** process_phantom_refs(:250,:956+);每阶段 work 函数: :348-377/:379-423/:425-450/:452-481
> - **"四阶段 discover/enqueue/process/verify" 编造**: 真实四阶段=软引用重审/清理/复活/phantom(见上);"verify"只是 DEBUG 断言
> - **Phase2 三态**(process_soft_weak_final_refs_work :379-423): referent NULL→remove;活→remove+make_referent_alive;死→clear_referent+enqueue(软/弱 do_enqueue=true,final false :885/:895/:905)
> - **Phase3 复活机制**: 所有 final 引用 make_referent_alive(:433)+set_next_raw 自环标记非活跃(:436-437)+enqueue(:439)——复活必须在 Phase4 phantom 之前(顺序硬约束)
> - **发现机制(大纲漏,重要)**: instanceRefKlass.inline.hpp try_discover(:64-90: ref_discoverer()/referent 未标记 is_gc_marked 才尝试)+discover_reference(cpp:1146-1239: 开关 :1148/final 已入队跳过 :1152/发现策略 ReferenceBased vs ReferentBased :1157-1163/:1212-1226/referent 强可达不发现 :1165-1172/**软引用当场 policy 裁决** :1173-1184/已发现跳过 :1191-1210/add_to_discovered_list :1234)
> - **SoftRef 策略(大纲"1ms×heap MB=存活 256ms"简化)**: 真实=interval(clock-timestamp,距上次访问)<= max_interval 保留(referencePolicy.cpp:69+);_max_interval=heap×policy(LRUMaxHeapPolicy :69)或 heap_free_at_last_gc/M×policy(LRUCurrentHeapPolicy :38);**server 模式默认 LRUMaxHeapPolicy**(referenceProcessor.cpp:60-64);SoftRefLRUPolicyMSPerMB=1000(globals.hpp:1852)——"访问间隔容忍度"非绝对存活时间;SoftReference timestamp 实例字段+clock 静态字段(javaClasses.cpp:3560)

场景: Java 有 Soft/Weak/Phantom/Final 四种引用类型——GC 需要有序处理它们：Soft 被 memory pressure 触发→Weak 在 marking 后清理→Final 可能复活对象→Phantom 在 reclaim 后 enqueue。

**ReferenceProcessor 的核心字段** (`referenceProcessor.hpp:80-250`):
```
_discoveredSoftRefs, _discoveredWeakRefs,
_discoveredFinalRefs, _discoveredPhantomRefs
→ 四条链表——每 GC cycle 内处理顺序: Soft→Weak→Final→Phantom
```
- 源码: `referenceProcessor.hpp:80-250` 字段 + `referenceProcessor.cpp:200-800` process_discovered_references
- 关键设计: 顺序不能变——Finalizer 可能复活对象(`obj = this`)—如果在 Phantom 之后处理→复活的对象已被回收→dangling Phantom reference
- [C++: `process_discovered_references` 用 4 个 while 循环遍历四条链表——每条循环内 check if reference is alive(weak pointer `JNIHandles::resolve`)。对于 dead ref→`ref->clear()`→`ref->enqueue()`。处理顺序: Soft→Weak→Final→Phantom 是静态顺序——每个类型的处理逻辑不同(Soft 需要 LRU check)

**四阶段处理** (`referenceProcessor.cpp:400-700`):
```
Phase 1: discover — 从 oop 链表发现可处理的引用
Phase 2: enqueue — 在 marking 后清理引用
Phase 3: process — GC 期间的实际清理(soft 可能 skip if enough memory)
Phase 4: verify — DEBUG verify list integrity
```
- 关键设计: SoftRefLRUPolicyMSPerMB——1ms×heap MB=soft ref max age。heap=256MB→soft ref 在 memory pressure 下存活 256ms。`java -XX:SoftRefLRUPolicyMSPerMB=0`→立即清理(等同 Weak)

### 2. "OopStorage — 引用存储在哪"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/03 已按真实源码成文):
> - **"OopStorage 存储 discovered refs" 编造(重要)**: JDK11 的 ReferenceProcessor **不碰 OopStorage**(grep 零命中)——discovered 链=Reference 对象自身字段;OopStorage 用于 **JNI handles(27-jni/01 已讲)/StringTable 等**,与引用处理无关
> - **discovered 存储真相**: 对象 discovered 字段(head 存 DiscoveredList)+add_as_head 头插(cpp:1050-1073);G1 双 ReferenceProcessor(_ref_processor_cm/_ref_processor_stw,g1CollectedHeap.cpp:1009-1106);发现时机=并发标记遍历(closure ref_discoverer→try_discover);处理在 STW 阶段树 "Reference Processing"
> - **悬念指向** ✓(04-workgang-taskqueue;04 标题="4 个 GC worker 怎么平分扫描任务？— WorkGang + TaskQueue")

场景: discovered refs 需要存在 GC 可访问的位置——OopStorage.

**OopStorage 并发存储** (`oopStorage.hpp:40-120`):
```cpp
class OopStorage {
  // 块分配(无锁): each GC thread 分配 private block→填 oop→link to global
  struct Block { oop _data[BlockSize]; };
  // 并发 iteration (for GC processing)
  void oops_do(OopClosure* cl); // GC 遍历所有 stored oop
};
```
- 源码: `oopStorage.hpp:40-120` + `oopStorage.cpp:allocation/iteration`
- 关键设计: block 分配无锁——每个 thread 持有自己的 active block→full→swap to global→分配新 block。iteration 是并发安全的——新 block 插在头部(linked list)——已有 block 不动

---

### 核心悬念

**"ReferenceProcessor 按 Soft→Weak→Final→Phantom 四阶段有序处理引用。SoftRef 在 memory pressure 下 LRU 清理(SoftRefLRUPolicyMSPerMB)。Phantom 在对象回收后用于 clean up native资源。"** — 但 GC workers 怎么平分扫描任务？下一篇: WorkGang + TaskQueue。

> → [04-workgang-taskqueue.md](04-workgang-taskqueue.md)
