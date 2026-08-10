# prompt-02 — Leak Profiler: 对象泄漏检测全链路

---

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1 — Old Gen 逐步增长直到 Full GC**  
线上应用运行两周后，old gen 使用率从 60% 缓慢攀升到 92%，触发连续 Full GC。运维通过 `jcmd <pid> JFR.start settings=profile` 开启 OldObjectSample。JFR 录制 10 分钟后 dump，在 JMC 中看到 `HashMap$Node` 对象累计引用链 > 12GB。根路径显示 `ThreadLocal` → `HashMap` → 数百万 entry，揭示出 ThreadLocal 未清理的业务 bug。

**场景 2 — 短生命周期大对象泄漏**  
一个每秒处理 10K 请求的 Web 应用，每次请求创建 64KB buffer。JFR OldObjectSample 的 `allocationSize` 字段揭示 95% 的已采样对象 > 60KB 且年龄 > 30 分钟。但 jmap histo 显示 `byte[]` 类仅有数千存活实例——说明大多数 buffer 正被 GC 回收。问题定位于：buffer 赋给了一个跨请求复用的业务对象中的 volatile 字段，引用链被 JFR BFS 遍历捕获为"长生命周期引用路径"。

**场景 3 — BCI 插桩导致启动延迟**  
应用启用 JFR OldObjectSample 后，启动时间从 3 秒增加到 15 秒。JFR `cpu=ClassLoader` 采样显示 `jfr_on_class_file_load_hook` 回调消耗大量 CPU。根因：`retransform_classes()` 通过 JVMTI RetransformClasses 为每 1 个加载的类触发 ClassFileLoadHook 事件→JFR BCI 引擎重写字节码→大量类被强制 re-parse。解决方案：缩小 OldObjectSample 的 excluded-classes 白名单。

---

## §一 Task + Narrative + Beginner Callouts

### Task
分析 JFR Leak Profiler 的完整 C++ 实现管道：
1. **ObjectSampler** — 如何用阈值进行对象采样（分配字节数/时间/数量）
2. **SampleList** — 采样对象的双向链表管理（free_list + in_use_list）
3. **BFS Closure** — 从 GCRoot 到采样对象的广度优先引用链构建
4. **EventEmitter** — 把构建的引用链序列化为 OldObjectSample 事件
5. **BCI Instrumentation** — ClassFileLoadHook → 字节码改写 → `LeakProfiler::sample()` 调用点插入

### Narrative
"一个字节数组从 -> 分配到 `LeakProfiler::sample()` 采样 -> ObjectSampler 选择保留 -> safepoint 时 BFS 搜索 -> GCRoot 引用链 -> EventEmitter 写出为 OldObjectSample 事件 -> JMC 可视化"

### 7 个 Beginner Callout

> **Callout 1 — OldObjectSample 不是 memory profiler**  
OldObjectSample 选择性地保留一些已分配对象的引用，并在未来某个时间点报告它们的 GC root 路径。它不跟踪每个 byte 的分配——它采样对象子集。这意味着"找不到泄漏路径"的原因是：这个对象恰好没被选中为样本。

> **Callout 2 — Safepoint 依赖**  
整个引用链搜索（BFS closure）在 safepoint 中执行——因为需要遍历 GC root（线程栈/静态字段/JNI handles/klass）。这意味着 VM 在 BFS 搜索期间暂停所有 Java 线程。EdgeQueue 内存管理就是为了尽可能缩短此暂停而设计的：虚拟内存按需提交 + 5% 堆预留。

> **Callout 3 — BFS vs DFS**  
BFS 用于主要搜索，DFS 作为 BFS 内存不足时的回退。原因是：BFS 发现离根更近的路径（对用户更相关），DFS 需要更少内存。GranularTimer 控制两个阶段的超时。

> **Callout 4 — BCI 不是必须的**  
OldObjectSample 有两种触发方式：(a) allocation site BCI 插桩→每次分配后检查是否达到采样阈值 (b) ObjectSampler 的通用分配路径（不用 BCI）。BCI 只在 `settings=profile` 下启用，提供更细粒度的分配站点信息但引入性能/复杂度开销。

> **Callout 5 — SamplePriorityQueue 为什么重要**  
ObjectSampler 使用优先级队列而非简单 FIFO 来选择采样对象。队列按 `allocationSize × age` 排序——大的旧对象更可能泄漏，优先级更高。这确保了 JFR 的有限样本集中在最有泄漏嫌疑的对象上。

> **Callout 6 — ZGC / Shenandoah 限制**  
`LeakProfiler::start():51-61` 显式拒绝在 ZGC 和 Shenandoah 上运行。原因是这些并发 GC 的弱引用生命周期语义与 ObjectSampler 的 `jweak` 跟踪模型冲突——对象可能在被采样后、被搜索前被并发 GC 释放，导致引用链不完整。这是 JDK-8237861 的已知限制。

> **Callout 7 — OldObjectSample 与 GC 的协作**  
`LeakProfiler::oops_do()` 在 safepoint 期间被 GC 调用 (`SafepointSynchronize::is_at_safepoint()` 守卫)。ObjectSampler 遍历其 `_in_use_list` 的所有样本，GC 通过 `is_alive` closure 检查每个样本对象是否仍存活。已死亡的样本放入 `_free_list` 供重用。

---

## §二 Standard Environment

### Source Roots
```
src/hotspot/share/jfr/leakprofiler/          — LeakProfiler, ObjectSampler, SampleList
src/hotspot/share/jfr/leakprofiler/chains/   — BFSClosure, DFSClosure, PathToGcRootsOperation
src/hotspot/share/jfr/leakprofiler/checkpoint/ — EventEmitter, ObjectSampleCheckpoint
src/hotspot/share/jfr/leakprofiler/sampling/ — ObjectSample, SamplePriorityQueue
src/hotspot/share/jfr/instrumentation/       — JfrJvmtiAgent, ClassFileLoadHook
```
**BUILD_LIBRARY**: make/hotspot/lib/CompileJvm.gmk:153 BUILD_LIBJVM

### 构建命令
```bash
bash configure --with-debug-level=slowdebug --with-jfr
make jdk
```

### Binary Path
```
build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so
```

### Syscall 速查表
| Syscall | man 章节 | 用途 |
|---------|:-------:|------|
| mmap(2) | man 2 mmap | EdgeQueue 虚拟内存预留 (5% heap) |
| mprotect(2) | man 2 mprotect | EdgeQueue commit/decommit |
| madvise(2) | man 2 madvise | MADV_DONTNEED 释放已遍历的 frontier 页面 |
| sched_yield(2) | man 2 sched_yield | GranularTimer 超时循环中的自旋 yield |
| get_alloc_ticks(2) | nan | JfrTicks::now() 阈值判断 |

### 全局状态表
| 变量 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `agent` (static) | JfrJvmtiAgent* | jfrJvmtiAgent.cpp:43 | BCI agent 单例 |
| `jfr_jvmti_env` (static) | jvmtiEnv* | jfrJvmtiAgent.cpp:44 | JVMTI 环境句柄 |
| `_priority_queue` | SamplePriorityQueue* | objectSampler.hpp:48 | 优先级排序的采样队列 |
| `_list` | SampleList* | objectSampler.hpp:49 | 双向链表 (free + in-use) |
| `_threshold` | size_t | objectSampler.hpp:52 | 当前采样阈值 (字节) |
| `_total_allocated` | size_t | objectSampler.hpp:51 | 累计分配字节数 |
| `_last_sweep` | JfrTicks | objectSampler.hpp:50 | 上次 scavenge 的时间戳 |
| `_edge_store` | EdgeStore* | pathToGcRootsOperation.hpp:37 | BFS 遍历的边存储 |
| `_cutoff_ticks` | int64_t | pathToGcRootsOperation.hpp:38 | 活动时间截止 (排除新对象) |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| leakProfiler.hpp/cpp | .../leakprofiler/ | 47/124 | `LeakProfiler` (AllStatic) | 对外门面：start/stop/emit_events/oops_do/sample |
| objectSampler.hpp/cpp | .../leakprofiler/sampling/ | 89/ | `ObjectSampler` (CHeapObj) | 采样引擎：add/scavenge/acquire/release |
| sampleList.hpp/cpp | .../leakprofiler/sampling/ | 64/ | `SampleList` (JfrCHeapObj) | ObjectSample 双向链表管理 (free+in-use) |
| objectSample.hpp | .../leakprofiler/sampling/ | | `ObjectSample` | 单个采样对象：jobject + 分配信息 + 线程 ID |
| samplePriorityQueue.hpp/cpp | .../sampling/ | | `SamplePriorityQueue` | 按 allocationSize×age 排序的优先级队列 |
| bfsClosure.hpp/cpp | .../leakprofiler/chains/ | 73/ | `BFSClosure` (BasicOopIterateClosure) | BFS 广度优先遍历 + DFS fallback |
| dfsClosure.hpp/cpp | .../leakprofiler/chains/ | | `DFSClosure` | DFS 回退遍历 (BFS 内存不够时) |
| pathToGcRootsOperation.hpp/cpp | .../chains/ | 46/81+ | `PathToGcRootsOperation` | SafepointOperation 编排 BFS/DFS |
| edge.hpp/cpp | .../chains/ | | `Edge` | 引用链中的一条边 (parent → child) |
| edgeStore.hpp/cpp | .../chains/ | | `EdgeStore` | Edge 对象池 (pre-allocated array) |
| edgeQueue.hpp/cpp | .../chains/ | | `EdgeQueue` | BFS 遍历队列 (虚拟内存管理) |
| rootSetClosure.hpp/cpp | .../chains/ | | `RootSetClosure` | 遍历所有 GC root |
| objectSampleMarker.hpp/cpp | .../chains/ | | `ObjectSampleMarker` | 标记"哪些对象是 sampled" (MarkBitMap) |
| eventEmitter.hpp/cpp | .../checkpoint/ | 58/ | `EventEmitter` (CHeapObj) | OldObjectSample + OldObjectGcRoot 事件写出 |
| jfrJvmtiAgent.hpp/cpp | .../instrumentation/ | 41/ | `JfrJvmtiAgent` (JfrCHeapObj) | BCI agent: ClassFileLoadHook 注册 |
| granularTimer.hpp | .../leakprofiler/utilities/ | | `GranularTimer` | 细粒度超时控制 (每 N 个对象检查截止时间) |
| startOperation.hpp/cpp | .../leakprofiler/ | | `StartOperation` | VM_Operation 子类：在 safepoint 创建 ObjectSampler |
| stopOperation.hpp/cpp | .../leakprofiler/ | | `StopOperation` | VM_Operation 子类：在 safepoint 销毁 ObjectSampler |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 ObjectSampler 阈值采样
① ObjectSampler 如何决定是否采样一个分配？`_threshold` 的计算逻辑是什么 (`_total_allocated / _size`)？为什么用 `allocationSize ≤ _threshold` 而非 `≥`？（说明：采样阈值初始为 total_alloc / queue_size，每次分配后调整——大的 queue_size 使阈值更小，更多对象被采样）

② **Counterfactual**: 如果不用优先级队列而使用固定间隔（每 1000 次分配采样一次）？→ 短生命周期对象（如临时字符串）会耗尽样本槽位，真正的泄漏候选（大的长生命周期对象）永远不被采样。优先级队列按 `allocationSize × age_weight` 排序，确保珍贵的内存用于追踪最可能的泄漏。

③ `ObjectSampler::scavenge()` 什么时候触发？为什么使用 `last_sweep` 和 GranularTimer 控制频率而不是每 N 次分配执行一次？

### 4.2 SampleList 的双链表 + 对象缓存
① `SampleList` 为什么维护 `_free_list` 和 `_in_use_list` 两条链表？`populate_cache()` 如何预分配 `ObjectSample` 对象？`_cache_size` 参数的作用是什么？

② `ObjectSample::reset()` 和 `SampleList::reuse()` 的差异是什么？为什么 `release()` 不改动 `jweak` 引用？（GC 会在 safepoint 期间访问 `_in_use_list` 中的所有 jweak——在 release 之前修改 jweak 会破坏 GC 遍历）

③ **Counterfactual**: 如果 SampleList 用 CHeapObj new/delete 动态分配而非缓存？→ 每次采样触发 malloc（锁竞争 + 4KB 页分配开销），在分配高速路径（每秒 10K 次分配）中不可接受。缓存将 new/delete 调用的频率降低到样本数量（而非采样次数）。

### 4.3 BFS 引用链搜索
① `BFSClosure::process()` 如何编排 BFS 遍历？`process_root_set()` → `process_queue()` 的完整流程是什么？`_current_frontier_level` 和 `_next_frontier_idx`/`_prev_frontier_idx` 三个 frontier 指针的语义？

② BFS 的 `frontier` 机制如何限制内存使用？`step_frontier()` 何时调用 `madvise(MADV_DONTNEED)` 释放已遍历的页面？为什么每个 frontier 是一个按需提交的虚拟内存页？

③ `_use_dfs` 标志何时为 true？`dfs_fallback()` 在什么条件下被触发？DFS fallback 的边界条件 (`_dfs_fallback_idx = _edge_queue->bottom()`) 是什么？

④ **Counterfactual**: 如果只用 BFS 无 DFS fallback？→ 深度超 10 层的对象图会耗尽 EdgeQueue 的虚拟内存预留（5% heap = 400MB for 8GB heap），BFS 遍历中断。DFS 回退用栈深度交换内存宽度，确保大型对象图（如 Spring IoC 容器）仍能完成搜索。

### 4.4 EdgeQueue 虚拟内存管理
① `edge_queue_memory_reservation(MemRegion)` 为什么预留 5% 堆大小但最少 32MB？这个比例是怎么确定的？为什么用虚拟内存而非 CHeapObj？

② `edge_queue_memory_commit_size()` 按 10:1 的比例提交内存——为什么不是 1:1？`commit` 语义对应什么系统调用 (mmap MAP_ANONYMOUS + mprotect PROT_READ|PROT_WRITE)？

③ **Counterfactual**: 如果 EdgeQueue 全在 safepoint 前预提交所有预留给 CHeapObj？→ 8GB 堆预提交 400MB 会导致 swap 风暴 + 页面回收延迟。按需提交只消耗 40MB（10:1比率），剩余页面从未被触及，OS 不分配物理内存。

### 4.5 GranularTimer 超时控制
① `GranularTimer` 如何实现细粒度超时？为什么用 `JfrTicks::now()` 而非 `os::elapsed_counter()`？每次迭代后检查还是每 N 次迭代后检查一次？

② 为什么 BFS 和 DFS 都需要独立的 GranularTimer？safepoint 中的时间预算如何分配？（BFS 大块时间 → DFS 小块时间 → write_events 小块时间）

③ **Counterfactual**: 如果无超时控制，直接跑完整个 BFS？→ 在 safepoint 中运行 BFS 搜索 50M 对象图会导致 safepoint 暂停 > 10 秒——超过 `UnlockDiagnosticVMOptions -XX:+SafepointTimeout` 阈值，触发 `hs_err` dump。GranularTimer 确保每个对象被报告前有一个"不报告的截止"，保证 safepoint 可控。

### 4.6 EventEmitter 事件序列化
① `EventEmitter::write_event(ObjectSample*, EdgeStore*)` 如何构建 OldObjectSample 事件的字段？`ObjectSampleCheckpoint` 在序列化中的角色是什么？

② `emit_all` vs `!emit_all`（仅 cutoff_ticks 前的对象）的分支逻辑是什么？为什么 `cutoff_ticks` 用于排除"太新"的对象？（新对象可能只存活了几微秒，其引用链无意义）

③ **Counterfactual**: 如果不用 ObjectSampleCheckpoint 预处理而直接在 write_event 中构建？→ 每个事件都重复解析相同的线程名/类名/方法名（字符串表查找 + hash 重计算），ObjectSampleCheckpoint 用 JfrCheckpointWriter 缓存这些常量引用，后续事件直接引用预分配的 traceid。

### 4.7 BCI 字节码改写
① `jfr_on_class_file_load_hook()` (jfrJvmtiAgent.cpp:78) 如何 intercept 类的第一次加载？`retransform_classes(JNIEnv*, jobjectArray, TRAPS)` 如何为已经加载的类注册 hook？

② BCI 改写引擎如何插入对 `LeakProfiler::sample()` 的调用？在每个 `new`/`newarray`/`anewarray` 字节码后插入什么？`update_class_file_load_hook_event(JVMTI_EVENT_CLASS_FILE_LOAD_HOOK)` 如何注册全局回调？

③ **Counterfactual**: 如果不用 JVMTI RetransformClasses 而只 hook ClassFileLoadHook 的首次加载？→ 已加载的类的 `new` 调用不被采样——JFR 只看到 BCI 注册后加载的类。在运行时启动 JFR 意味着 Bootstrap 类（String, HashMap 等）的分配不被跟踪。RetransformClasses 通过 JVMTI 要求 VM 重新提交类的字节码，触发 ClassFileLoadHook 管道。

### 4.8 ObjectSampler 与 GC 协作
① `LeakProfiler::oops_do(BoolObjectClosure*, OopClosure*)` 为什么仅在 safepoint 期间被 GC 调用？`ObjectSampler::oops_do()` 如何遍历 `_in_use_list`？每个 `ObjectSample::object()` 的 jweak 如何处理 is_alive 检查？

② `scavenge()` 与 `remove_dead()` 的区别是什么？为什么 `_dead_samples` 标志需要延迟清理？（GC 的 is_alive closure 可能在不持有 sampler lock 的情况下访问 sample list——延迟清理避免并发修改破坏 GC 的遍历）

③ **Counterfactual**: 如果 ObjectSampler 用强引用而非 jweak？→ 被采样对象永远不被 GC——即使它其实已经被应用抛弃。jweak 允许 GC 自然回收被采样的对象：GC 通过 is_alive closure 检查→发现已死亡→从 _in_use_list 移到 _free_list→样本槽位腾出给新对象。

### 4.9 ObjectSampler 生命周期管理
① `ObjectSampler::create(size_t)` → `StartOperation` (VM_Operation) → safepoint → 构造为什么需要在 safepoint 中执行？`acquire()`/`release()` 的读写锁模式如何工作？

② `LeakProfiler::start(int sample_count)` → sample_count 参数如何传递到 ObjectSampler 的 `_threshold`？为什么 sample_count==0 禁用 leak profiler？（`LeakProfiler::start():47-49`）

③ **Counterfactual**: 如果 ObjectSampler 内存分配用 Arena 而非 CHeapObj？→ Arena 从 ResourceMark 中 allocate，ResourceMark 生命周期绑定到 Java 方法调用。ObjectSampler 跨多个 Java 方法调用存活（可能在一次 safepoint 中分配，在 30 分钟后的另一次 safepoint 中销毁）——需要用 CHeapObj 全局堆分配避开 ResourceMark 生命周期限制。

---

## §五 Article Structure

### 建议文档章节结构

```
§〇 Production Scenario
    3 个真实场景 + 三步诊断 + Counterfactual

§一 Leak Profiler 全景架构
    LeakProfiler 门面 → ObjectSampler → BFS Chains → EventEmitter → JMC 的五步管道
    Mermaid 流程图：5 lane (Allocator / Sampler / GC / Safepoint / Event System)

§二 Source Files Table + Standard Environment
    (见 §三 和 §二)

§三 ObjectSampler 采样引擎源码走读
    3.1 SamplePriorityQueue — 按 size×age 排序的优先级队列
    3.2 SampleList — 双链表 (free + in-use) 的对象缓存
    3.3 ObjectSampler::add() — 阈值判断 + scavenge 调度
    3.4 acquire()/release() — 读写锁模式 (非 safepoint 排他访问)

§四 BFS 引用链搜索全链路
    4.1 EdgeQueue — 虚拟内存管理的 BFS 队列 (reservation 5% heap → commit 10:1)
    4.2 RootSetClosure — 遍历所有 GC root
    4.3 BFSClosure::process() — frontier 机制 + step_frontier() + madvise
    4.4 DFSClosure — BFS 内存不足时的回退
    4.5 ObjectSampleMarker — BitMap 标记 sampled objects
    4.6 GranularTimer — 细粒度超时控制
    4.7 Edge / EdgeStore — Edge 对象池

§五 从 BFS 边到 OldObjectSample 事件
    5.1 PathToGcRootsOperation::doit() — safepoint 操作编排
    5.2 EventEmitter::write_event() — OldObjectSample + OldObjectGcRoot
    5.3 ObjectSampleCheckpoint — 常量引用预分配

§六 BCI 字节码插桩
    6.1 JfrJvmtiAgent 创建与销毁
    6.2 ClassFileLoadHook 回调 (jfr_on_class_file_load_hook)
    6.3 RetransformClasses — 重新提交已加载类的字节码
    6.4 BCI 改写: new 字节码后的 AllocationSampler 检查

§七 ObjectSampler 与 GC 的协作
    7.1 is_alive closure + oops_do 遍历
    7.2 remove_dead() + _dead_samples 延迟清理
    7.3 jweak 弱引用语义与并发 GC 的限制 (ZGC/Shenandoah 排除)

§八 Counterfactual 对比表
    (至少 6 个反事实，含量化论断)

§九 边缘场景
    9.1 BFS DFS fallback 触发时的内存消耗
    9.2 RetransformClasses 超时 (ClassFileLoadHook 耗时过大导致应用类加载暂停)
    9.3 SampleList 满时的采样丢弃策略

§十 GDB 断点验证
    (见 §十)

§十一 "不要写成→应该写成" 对照表
    (≥8 行)

§十二 Cross-Reference
```

---

## §六 Writing Requirements

### "不要写成→应该写成" 对照表 (≥8 行)

| 不要写成 | 应该写成 |
|---------|---------|
| "ObjectSampler 用 SampleList 保存采样的对象" | "ObjectSampler 用 SampleList (JfrDoublyLinkedList\<ObjectSample\>) 作为 `_in_use_list` 保存被选中的采样对象。`_free_list` 预分配 `_cache_size` 个 ObjectSample 对象用于快速分配。`_in_use_list:_free_list` 双重链表使 GC 遍历 in-use 对象与新采样 add 操作完全解耦" (见 sampleList.hpp:36-37) |
| "BFS 搜索在 safepoint 中运行" | "BFS 搜索在 safepoint 中运行，因为需要遍历 GC root (线程栈/静态字段/JNI handles)，这些数据结构在 Java 线程运行期间可能被修改。但 BFS 的内存消耗被 frontier 机制限制——每层 frontier 是一个按需 madvise(MADV_DONTNEED) 回收的虚拟内存页，确保暂停时间可控" (见 pathToGcRootsOperation.cpp:59-69, bfsClosure.hpp:42-44) |
| "SamplePriorityQueue 按大小排序" | "SamplePriorityQueue 按 allocationSize × age_weight 计算 priority 排序。不在 `add()` 时立即重排——每次 `scavenge()` 触发一次 rebuild，purge 已死亡样本并重新排序剩余样本。`_priority_queue` 的内部实现是 binary heap push/pop" |
| "JfrJvmtiAgent 用 ClassFileLoadHook 修改字节码" | "JfrJvmtiAgent 通过 `update_class_file_load_hook_event(JVMTI_ENABLE)` 注册 ClassFileLoadHook 回调，在每次类加载时触发 `jfr_on_class_file_load_hook()`。回调函数检查类是否属于 excluded-classes 列表，若不在，则调用 BCI 改写引擎在每个 new/newarray/anewarray 字节码后插入对 `LeakProfiler::sample()` 的调用" (见 jfrJvmtiAgent.cpp:67-68) |
| "EventEmitter 写出 OldObjectSample 事件" | "EventEmitter::write_event() 为每个被采样的对象生成两个事件：OldObjectSample (对象信息: allocationTime/allocationSize/stackTrace/thread) 和 OldObjectGcRoot (引用链: 每个 root 的快照)。ObjectSampleCheckpoint 预写入所有常量子串(类名/方法名/签名)为 traceid，在 write_event() 阶段直接用 traceid 引用而非每次重复查找" |
| "oops_do 用于 GC 标记" | "LeakProfiler::oops_do(is_alive, f) 在 safepoint 期间被 GC 调用。GC 通过 is_alive closure 检查 ObjectSampler 的 _in_use_list 中每个 jweak 是否仍存活。存活的 jweak 的 OopClosure 被执行（GC 能够更新被移动的对象的引用地址）。已死亡的样本立即标记为 _dead_samples=true 供后续 scavenge() 回收（非当前 safepoint——延迟清理避免并发修改 GC 的遍历）" (见 leakProfiler.cpp:104-110) |
| "GranularTimer 控制遍历时间" | "GranularTimer 每经过 `_counter_granularity` 次遍历迭代检查一次 `JfrTicks::now()` 对比 `_deadline`。如果截止时间已过，设置 `_finished=true`。BFS 的 GranularTimer deadline 基于 safepoint 开始时的 tick + configure 的超时。DFC fallback 有独立的更小 granularity Timer（每 100 个对象检查一次而非每个 frontier 结束）" |
| "EdgeQueue 用 mmap 管理内存" | "EdgeQueue 的构造函数调用 mmap(2) 预留 `MAX2(heap_region.byte_size() / 20, 32*M)` 的虚拟地址空间。初始只提交 1:10 的物理内存（通过 mprotect(2) 设置 PROT_READ\|PROT_WRITE）。BFS 的 frontier 前移触发新 page 的 mprotect commit，脱离的旧 frontier 调用 madvise(MADV_DONTNEED) 释放——这是牺牲物理内存灵活切换 CPU 分配策略（commit→walk→uncommit）" (见 pathToGcRootsOperation.cpp:59-69) |

---

## §七 Output Format

1. 文档标题格式：`# 02-Leak-Profiler — 对象泄漏检测全链路`
2. 所有技术断言标注精确 `file:line`
3. Mermaid 序列图：5 lane（Allocator → Sampler → GC → Safepoint → Event System）
4. 13 个 Counterfactual 用 `> **Counterfactual** —` 块引用格式嵌入对应讨论位置
5. §四 每小节包含一个"关键设计决策"子节，回答 WHY
6. §十 GDB 断点覆盖所有核心子系统

---

## §八 Prohibited（≥8）

1. **不要**把 BFS 写成纯算法描述（BFS 是什么/how it works）——必须解释 frontier 内存管理背后的工程设计
2. **不要**把 ObjectSampler 写成简单的 `vector<ObjectSample>` — 必须分析双层链表 (free + in-use) 的并发设计
3. **不要**把 BCI 写成"它修改字节码"就结束 — 必须追踪 JVMTI_SET_EVENT_NOTIFICATION_MODE → ClassFileLoadHook 的完整调用链
4. **不要**省略 SamplePriorityQueue 的排序语义 (allocationSize × age) 和 rebuild 触发条件
5. **不要**把 EventEmitter 写成"它生成 OldObjectSample 事件" — 必须区分 ObjectSampleCheckpoint (预分配) vs write_event (运行时序列化) 的两阶段设计
6. **不要**遗漏 ZGC/Shenandoah 在 LeakProfiler::start() 中显式排除的设计原因
7. **不要**忽略 GranularTimer 的超时控制与 safepointTimeout 的交互
8. **不要**把 oops_do 写成普通的 GC 清理遍历 — 必须分析 is_alive closure 的 jweak 生命周期语义
9. **不要**遗漏 EdgeStore 对象池的预分配设计 (避免 safepoint 中 malloc)
10. **不要**省略 retransform_classes 对已加载类的重新激活管道的性能影响

---

## §九 Required（≥8）

1. **必须**包含完整的 LeakProfiler::start() 到 EventEmitter::write_event() 的源码走读（至少 5 步，每步含 file:line）
2. **必须**包含 BFSClosure::process() 的 frontier 内存管理流程图（Mermaid）
3. **必须**展示 ObjectSampler::add() 的阈值计算逻辑 (total_alloc / size → threshold)
4. **必须**展示 BCI ClassFileLoadHook 注册 → 回调 → 字节码改写的完整管道
5. **必须**展示 EdgeQueue 的 reservation/commit 虚拟内存调用的精确参数和系统调用
6. **必须**包含 ObjectSampler::acquire()/release() 的读写锁语义
7. **必须**包含至少 13 个 Counterfactual（对应 §四 的问题组）
8. **必须**在 §八 集中列出 Counterfactual 对比表（含量化论断）
9. **必须**包含"不要写成→应该写成"对照表 ≥8 行
10. **必须**展示 PathToGcRootsOperation 如何编排 BFS/DFS/EventEmitter 的全 safepoint 操作

---

## §十 GDB Verification（≥7 assertions）

1. **LeakProfiler 状态检查**  
`(gdb) p LeakProfiler::is_running()`  
→ 预期返回 false (未启动时)

2. **ObjectSampler singleton**  
`(gdb) p ObjectSampler::sampler()`  
→ 预期返回 NULL (未创建时)

3. **SampleList 双链表大小**  
`(gdb) p ObjectSampler::sampler()->_list->_free_list._count`  
`(gdb) p ObjectSampler::sampler()->_list->_in_use_list._count`  
→ 验证 free_list + in_use_list >= _limit

4. **BFS EdgeQueue 内存消耗**  
`(gdb) p edge_queue.reserved_size() / 1024`  
`(gdb) p edge_queue.live_set() / 1024`  
→ live_set() ≈ reserved_size() / 10 (初始 commit 比 1:10)

5. **ObjectSampler threshold 值**  
`(gdb) p ObjectSampler::sampler()->_threshold`  
→ 一个 > 0 的 size_t 值，在 add() 后变化

6. **JfrJvmtiAgent 创建验证**  
`(gdb) p agent`  (static variable in jfrJvmtiAgent.cpp:43)  
→ 预期非 NULL (JFR BCI enabled)

7. **JVMTI ClassFileLoadHook 注册**  
`(gdb) p (int)jfr_jvmti_env`  
→ 预期非 NULL (jvmti 环境已获取)

8. **GranularTimer deadline**  
`(gdb) b GranularTimer::is_finished`  
→ 在 BFS closure 运行期间，这个断点会多次命中 (frontier 间检查)

9. **EventEmitter 完整路径**  
`(gdb) b EventEmitter::write_event`  
→ 在 safepoint 后命中，验证 `sample` 和 `edge_store` 参数

---

## §十一 与 README 和同组 prompt 的连续性

- **README 对齐**: 本文档覆盖 README §一 的 "Leak Profiler (47 files, ~8K lines)" + instrumentation/ (4 files, 1957 lines)
- **Prompt 间**:
  - prompt-00 Recorder Engine → 本文档中 ObjectSampler 的 `_edge_store` 通过 `JfrChunkWriter` 写入 chunk
  - prompt-01 Event System → 本文档中的 EventEmitter::write_event() 通过 `JfrThreadLocal::native_writer()` 提交事件，与 prompt-01 的 EventWriterHost 接口对齐
  - Cross-reference: 文档末尾包含对 00 和 01 的导航链接
- **libjvm-analysis 重叠**: `07-thread-lock/15-JVM-JFR-Sampling.md` 为互补——旧文覆盖 SamplingThread 线程管理，本文覆盖 ObjectSampler BFS + BCI
