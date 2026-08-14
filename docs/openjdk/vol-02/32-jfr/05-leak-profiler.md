# 05. JFR 怎么找到内存泄漏的 GC Root?— Old Object Sampling

> **前置依赖**:[32-jfr/01 — JFR 怎么在每个线程上采集事件?— Recorder Engine](openjdk/vol-02/32-jfr/01-recorder-engine.md):事件与检查点通道;[32-jfr/03 — JFR 怎么 10ms 采一次全部线程栈?— Periodic Sampling](openjdk/vol-02/32-jfr/03-periodic-sampling.md):栈轨迹 id 化;[20-vm-operations/01 — "帮我做 GC"——VM_Operation 从提交到执行](openjdk/vol-02/20-vm-operations/01-vm-operation.md):safepoint 操作(PathToGcRootsOperation)
> → **后续**:[32-jfr/06 — JNI 接口与字节码插桩](06-jni-instrumentation.md)
> 关联域: 25-gc(弱引用根处理)、20-vmops、17-threads

## "潜在内存泄漏"怎么定位

`jdk.OldObjectSample` 事件(metadata.xml:579-586,description "A potential memory leak")回答"这个对象为什么还活着"——JMC 里显示的不只是样本,还有**从 GC root 到该对象的一条引用链**。这篇拆三段的完整机制: 采样侧(谁在分配时采样、怎么保留下有价值的样本)、追踪侧(在 safepoint 里怎么从样本反追到 root)、序列化侧(chain 怎么写进文件)。

## 1. 采样侧: TLAB 分配钩子 + 优先级队列

**触发粒度不是"每 N 字节"**——是**每次 TLAB 补充/大对象分配**。分配路径上 `AllocTracer::send_allocation_outside_tlab/in_new_tlab`(allocTracer.cpp:35/:45)第一行就是 `JFR_ONLY(JfrAllocationTracer tracer(...))`;`MemAllocator` 只在 TLAB refill 或堆外分配时发这个事件(memAllocator.cpp:239-247)。链路: `JfrAllocationTracer` → `LeakProfiler::sample`(排除隐藏线程,:112-122)→ `ObjectSampler::sample`:

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
  // try enter critical section
  JfrTryLock tryLock(&_lock);
  if (!tryLock.has_lock()) {
    log_trace(jfr, oldobject, sampling)("Skipping old object sample due to lock contention");
    return;
  }
  instance().add(obj, allocated, thread_id, thread);
}
```

**非阻塞**: `JfrTryLock` 拿不到锁直接跳过本次采样("Skipping old object sample due to lock contention")——不阻塞分配线程;`RecordStackTrace`(:120-136)按事件配置决定要不要为本次分配记录分配栈。真正的决策在 `add`(:155-199):

- **span 语义**: `span = _total_allocated - _priority_queue->total()`(:167)——**"距上次入队样本的分配增量"**(累计分配减去已入队样本的总 span),衡量"这个分配点吃掉了多少堆";
- **优先级队列**: 保持 top-N(默认 **256**,`old_object_queue_size`,jfrOptionSet.cpp:173)最大 span 的样本;队满时 `peek()`(最小 span)→ **quick reject**(`peek->span() > span` 直接丢弃,:171-175)——**避免昂贵的栈记录+入队**;否则 pop+**reuse** 复用样本对象(:176);
- **GC 集成**: `ObjectSampler::oops_do`(:227-246)把样本当弱引用处理——对象死掉就 `set_dead`,`scavenge` 时移除并把 span 转给前驱样本(:201-225)。

**启用**: `LeakProfiler::start(sample_count)`(leakProfiler.cpp:41-77)——sample_count 来自 `old_object_queue_size`(jfrJniMethod.cpp:109);ZGC/Shenandoah 明确不支持(:53-62);通过 **VM 操作** `StartOperation` 在 safepoint 安装采样器(:68)。

## 2. 追踪侧: safepoint 里的 BFS,满队列时 DFS

录制停止/检查点时,`PathToGcRootsOperation`(VM 操作)在 **safepoint** 内运行(pathToGcRootsOperation.cpp:81-131):

```cpp
// pathToGcRootsOperation.cpp:81-124(截取核心,逐字)
void PathToGcRootsOperation::doit() {
  assert(SafepointSynchronize::is_at_safepoint(), "invariant");
  ...
  const MemRegion heap_region = Universe::heap()->reserved_region();
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
    // Pathological case where roots don't fit in queue
    // Do a depth-first search, but mark roots first
    // to avoid walking sideways over roots
    DFSClosure::find_leaks_from_root_set(_edge_store, &mark_bits);
  } else {
    bfs.process();
  }
  ...
```

关键设计: ①**BitSet 防循环**——每个遍历过的对象在 `mark_bits` 标记,再次遇到跳过(:85-87);②**EdgeQueue 内存**——初始预留 `MAX2(堆/20, 32MB)`(注释 "5% of the heap OR at least 32 Mb",:59-63),commit 块=预留/10(:65-69,"Commit ratio: 1:10");③**BFS 优先**——最短路径更易理解;④**EdgeQueue 满 → DFS 兜底**(:117-124,"mark roots first to avoid walking sideways over roots");⑤**DFS 深度上限 5000**(`max_dfs_depth`,dfsClosure.cpp:41)——超深引用图截断;⑥**初始化失败降级**——直接"write out the existing samples, flat, without chains"(:95-98);⑦根的类型是**两维枚举**(rootType.hpp: `System`: universe/JNI handles/threads/monitors/... × `Type`: 栈变量/局部 JNI handle/全局 JNI handle/handle 区)。

## 3. 序列化侧: 样本与 chain 落盘

`ObjectSampleCheckpoint::write`(objectSampleCheckpoint.cpp:398-409)两步: ①`write_sample_blobs`(样本自身的类型信息 blob);②`edge_store->iterate(ObjectSampleWriter)`——把每条引用链按边序列化。`jdk.OldObjectSample` 事件(metadata.xml:579-586)的字段就是结果: `allocationTime`/`lastKnownHeapUsage`/`object`(样本对象)/`arrayElements`/`root`(GC root)。root 的类型三件套(description/system/type)对应 metadata 的 `OldObjectGcRoot` 复合类型(:1083-1095)——reader 据此渲染 JMC 的"泄漏路径"视图。默认配置里该事件由 `memory-leak-detection-enabled` 控制(default.jfc:433-438)。

## 核心悬念

泄漏剖析拆完: 采样侧是 TLAB refill 钩子(AllocTracer→LeakProfiler→ObjectSampler,JfrTryLock 非阻塞)+ span 优先级队列(quick reject 保 top-256);追踪侧是 safepoint 里的 `PathToGcRootsOperation`(BitSet 防循环、EdgeQueue 按堆 5%/32M 预留、BFS 优先满时 DFS 兜底、5000 深度上限、失败降级 flat);序列化侧把 chain 写进 `OldObjectSample` 事件(root 的 system/type 两维)。[实证](planning/outlines/00-jvm-tools/materials/commands/32-jfr-leakprofiler-demo.txt)里源码链逐段对上。

32 域的核心引擎、元数据、采样、二进制、泄漏剖析都拆完了——还剩**入口层**: JFR 的 JNI 接口(Java 侧 jdk.jfr.internal.JVM 的 native 方法)与字节码插桩(用户事件类的 instrumentation,EventClassBuilder 的兄弟)。下一篇: JNI 接口与字节码插桩。

> → [32-jfr/06 — JNI 接口与字节码插桩](06-jni-instrumentation.md)
