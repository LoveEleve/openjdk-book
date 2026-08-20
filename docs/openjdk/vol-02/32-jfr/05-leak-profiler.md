# 05. JFR 怎么找到内存泄漏的 GC Root?— Old Object Sampling

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):事件与检查点通道;[32-jfr/03 — JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling](openjdk/vol-02/32-jfr/03-periodic-sampling.md):栈轨迹 id 化;[20-vm-operations/01 — "帮我做 GC"——VM_Operation 从提交到执行](openjdk/vol-02/20-vm-operations/01-vm-operation.md):safepoint 操作(PathToGcRootsOperation)
> → **后续**:[32-jfr/06 — JNI 接口与字节码插桩](06-jni-instrumentation.md)
> 关联域: 25-gc(弱引用根处理)、20-vmops、17-threads

`jdk.OldObjectSample` 事件回答的是另一个问题: **这个对象为什么还活着?** 普通分配事件只能告诉你"它什么时候被分配"，却解释不了"为什么直到现在还没死"。JFR 的泄漏剖析把这两件事拼起来: 先在分配路径上保留少量**最有价值的老对象样本**，再在 safepoint 里从这些样本**反追到一条 GC root 链**，最后把样本和链一起写进文件。

本篇要回答的核心问题:

1. 采样是在哪里挂钩的——每次分配都采吗?
2. 为什么能从样本反推到 GC root——谁在 safepoint 里遍历整堆?
3. 这条 root 链最后怎么写进 `.jfr`?

答案会反复落到一句话:**Old Object Sampling 不是“持续跟踪全部对象”，而是“分配时保留 top-N 候选样本，发事件时再在 safepoint 里做一次受限的 root-path 搜索”。**

---

## 1. 开场困惑——"潜在内存泄漏"怎么定位

JFR 里的 `jdk.OldObjectSample` 事件(metadata.xml:579-586, description "A potential memory leak")不是简单的分配日志。它回答的是: **为什么这个对象直到现在还活着?**

如果 `memory-leak-detection-cutoff=0ns`,JFR 只保留样本对象本身,不去追踪 root 链;JMC 里你只能看到"某个对象样本还活着"。而一旦 cutoff > 0,事件发出时会附带**从 GC root 到该对象的一条引用链**。

这决定了它不可能像普通事件那样"分配时立即写完"。root 链需要在 **safepoint** 里做整堆搜索,所以采样与追踪是两步分离的。

---

## 2. 两个朴素方案为什么都不对

### 方案一: 每次分配都完整记录一条 root 链

最直观的做法是: 每分配一个对象,立刻从它反追到 GC root 并落盘。问题在于这几乎等价于"每次分配都做一次小型 heap walk"——开销大到无法接受。JFR 的目标是低开销,不可能在热点分配路径上做 root 搜索。

### 方案二: 只保留分配事件,不做 root 搜索

另一种极端是只记"谁分配了对象"。这能告诉你分配栈,但解释不了"为什么对象没死"。泄漏问题的关键不是分配时刻,而是**当前的可达性**——到底是谁还引用着它。没有 root 链,只能猜。

正确方案是折中: **分配时先筛出少量最可疑的样本**,把 root 搜索推迟到需要发事件时再在 safepoint 里做。

---

## 3. 采样侧——TLAB 补充钩子 + 优先级队列

### 不是每次分配都采

**触发粒度不是"每 N 字节"**——是**每次 TLAB 补充/大对象分配**。分配路径上 `AllocTracer::send_allocation_outside_tlab/in_new_tlab` 的第一行就是 `JFR_ONLY(JfrAllocationTracer tracer(...))`;`MemAllocator` 只在 TLAB refill 或堆外分配时发这个事件。链路是:

`JfrAllocationTracer` → `LeakProfiler::sample` → `ObjectSampler::sample`

`ObjectSampler::sample`(objectSampler.cpp:138-153)的关键点:

```cpp
// objectSampler.cpp:138-153(截取核心,逐字)
void ObjectSampler::sample(HeapWord* obj, size_t allocated, JavaThread* thread) {
  assert(thread != NULL, "invariant");
  assert(is_created(), "invariant");
  const traceid thread_id = get_thread_id(thread);
  if (thread_id == 0) {
    return;
  }
  RecordStackTrace rst(thread);
  JfrTryLock tryLock(&_lock);
  if (!tryLock.has_lock()) {
    log_trace(jfr, oldobject, sampling)("Skipping old object sample due to lock contention");
    return;
  }
  instance().add(obj, allocated, thread_id, thread);
}
```

**非阻塞**是第一个关键点: `JfrTryLock` 拿不到锁直接跳过本次采样,不阻塞分配线程。JFR 宁可漏掉个别样本,也不让热点分配停下来排队。

### span 语义 + top-N 队列

真正的决策在 `add`(:155-199):

- **span 语义**: `span = _total_allocated - _priority_queue->total()`——也就是"距上次入队样本的分配增量"。它近似衡量这个分配点自上次采样以来“吃掉了多少堆”。
- **优先级队列**: 只保留 top-N(默认 **256**,`old_object_queue_size`,jfrOptionSet.cpp:173)最大 span 的样本。
- **队满 quick reject**: 队满时先看最小 span；如果 `peek->span() > span` 直接丢弃,省掉队列维护与样本字段设置。
- **reuse 复用**: 否则 pop 掉最小样本,复用样本对象存新条目。

这个设计的本质是: **不是采“所有大对象”，而是采“最可能代表长期占堆趋势的那 256 个点”**。

### 与 GC 的整合

`ObjectSampler::oops_do`(:227-246)把样本当弱引用处理——对象死掉就 `set_dead`,`scavenge` 时移除并把 span 转给前驱样本(:201-225)。也就是说,样本不会因为被 JFR 记录而强行保活。

### 启用与支持边界

`LeakProfiler::start(sample_count)`(leakProfiler.cpp:41-77)启用采样器: sample_count 由配置侧经 JNI 入口传入,对应 `old_object_queue_size`(jfrJniMethod.cpp:109);ZGC/Shenandoah 明确不支持(:53-62);通过 **VM 操作** `StartOperation` 在 safepoint 安装采样器(:68)。

---

## 4. 追踪侧——safepoint 里的 BFS,满队列时 DFS

事件发出时(`EventEmitter::emit`,eventEmitter.cpp:55-70):

- **cutoff ≤ 0** → 只发样本,不追链;
- **cutoff > 0** → 执行 `PathToGcRootsOperation`(VM 操作)在 **safepoint** 内运行。

`PathToGcRootsOperation::doit()`(pathToGcRootsOperation.cpp:81-124)的关键骨架:

```cpp
// pathToGcRootsOperation.cpp:81-124(截取核心,逐字)
void PathToGcRootsOperation::doit() {
  assert(SafepointSynchronize::is_at_safepoint(), "invariant");
  ...
  BitSet mark_bits(heap_region);
  const size_t edge_queue_reservation_size = edge_queue_memory_reservation(heap_region);
  EdgeQueue edge_queue(edge_queue_reservation_size, edge_queue_memory_commit_size(edge_queue_reservation_size));
  if (!(mark_bits.initialize() && edge_queue.initialize())) {
    log_warning(jfr)("Unable to allocate memory for root chain processing");
    return;
  }
  ...
  BFSClosure bfs(&edge_queue, _edge_store, &mark_bits);
  RootSetClosure<BFSClosure> roots(&bfs);
  GranularTimer::start(_cutoff_ticks, 1000000);
  roots.process();
  if (edge_queue.is_full()) {
    DFSClosure::find_leaks_from_root_set(_edge_store, &mark_bits);
  } else {
    bfs.process();
  }
  ...
```

关键设计:

1. **BitSet 防循环**——每个遍历过的对象在 `mark_bits` 标记,再次遇到跳过;
2. **EdgeQueue 预留内存**——初始预留 `MAX2(堆/20, 32MB)`，commit 块=预留/10；
3. **BFS 优先**——最短路径更易理解;
4. **EdgeQueue 满 → DFS 兜底**——“mark roots first to avoid walking sideways over roots”；
5. **DFS 深度上限 5000**(`max_dfs_depth`,dfsClosure.cpp:41)——超深引用图截断;
6. **初始化失败降级**——直接只写样本、无链(flat samples);
7. **根类型是两维枚举**(`rootType.hpp`): `System` (universe/JNI handles/threads/monitors/...) × `Type` (栈变量/局部 JNI handle/全局 JNI handle/handle 区)。

这一步之所以必须在 safepoint 里做,就是为了在遍历整堆引用图时不被 mutator 并发改图打断。

---

## 5. 序列化侧——样本与 chain 落盘

`ObjectSampleCheckpoint::write`(objectSampleCheckpoint.cpp:398-409)分两步:

1. `write_sample_blobs` —— 写样本自身的类型信息 blob;
2. `edge_store->iterate(ObjectSampleWriter)` —— 把每条引用链按边序列化。

`jdk.OldObjectSample` 事件(metadata.xml:579-586)的字段就是结果: `allocationTime` / `lastKnownHeapUsage` / `object` / `arrayElements` / `root`。其中 `root` 的类型三件套(description/system/type)对应 metadata 的 `OldObjectGcRoot` 复合类型(:1083-1095)——reader 据此渲染 JMC 的“泄漏路径”视图。

所以这套机制是三段串起来的:

- 分配路径上筛样本(top-256);
- safepoint 里从样本反追一条 root 链;
- 序列化时把样本和链一起写进 `OldObjectSample` 事件。

---

## 6. 误解澄清与收网

1. **是不是每次分配都做 root 搜索?** 不是。分配时只筛样本,root 搜索只在发事件且 cutoff > 0 时做。
2. **是不是每次分配都采样?** 不是。采样挂在 TLAB refill / 大对象分配路径上,不是每个对象分配都进来。
3. **样本会不会因为被 JFR 记录就强行保活?** 不会。样本按弱引用处理,对象死掉就从采样器里移除。
4. **root 搜索只用 BFS 吗?** 不是。默认 BFS,但 EdgeQueue 满就退到 DFS 兜底。
5. **ZGC/Shenandoah 支持吗?** 11u 里不支持,`LeakProfiler::start` 直接拒绝。

把这一篇压成三句话:

- **采样侧**: TLAB refill 钩子 + span 优先级队列,只保留 top-256 候选样本。
- **追踪侧**: safepoint 里的 `PathToGcRootsOperation`,BitSet 防循环、BFS 优先、满队列时 DFS 兜底。
- **序列化侧**: 样本与 root 链一起写进 `OldObjectSample`,reader 用 root 的 system/type 还原泄漏路径。

32 域的核心引擎、元数据、采样、二进制、泄漏剖析都拆完了——还剩入口层: JFR 的 JNI 接口与字节码插桩。下一篇: JNI 接口与字节码插桩。

> → [32-jfr/06 — JNI 接口与字节码插桩](06-jni-instrumentation.md)