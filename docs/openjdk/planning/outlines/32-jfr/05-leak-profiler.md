# 05. JFR 怎么找到内存泄漏的 GC Root？ — Old Object Sampling

> 🟡 Working | 采样 + priority queue + BFS/DFS chain trace
> 读者处境: JFR 启用 Old Object Sampling——在 TLAB 分配时每 N 字节采样一个 Old 代对象→trace reference chain 到 GC root→record `jdk.OldObjectSample` event→JMC 展示泄漏路径。

### 1. "ObjectSampler — 采样+优先级队列"

场景: Application 每秒 1000 次 TLAB 分配→每 `sample_interval` 字节采样一次→object 放入 priority queue(按 span=分配字节数排序)→保留 top-N 最大分配跨度。

**ObjectSampler::add** (`sampling/objectSampler.cpp:155-200`):
```
ObjectSampler::add(obj, allocated, thread_id):
  → _total_allocated += allocated // 累计总分配字节
  → span = _total_allocated - priority_queue.total()
  → 如果 queue 已满 (_size 个样本):
       peek = queue.peek() // 最小 span 样本
       if peek->span() > span: return (quick reject)
       否则: pop + reuse(old_sample) → 替换
  → 新 sample: set_thread_id(thread_id) + record_stacktrace(thread)
  → queue.add(sample) // 按 span 排序优先级
[C++: sampling/objectSampler.cpp:280行——priority queue 保持 top-N 分配跨度最大对象(最可能泄漏)]
```
- 源码: `sampling/objectSampler.cpp:138-153` (sample 入口→tryLock) + `sampling/objectSampler.cpp:155-200` (add → priority queue 插入)

- 关键设计: **quick reject** — 新采样对象的 span < 当前最小优先级样本→直接丢弃——避免昂贵的 stack trace recording + queue 操作。**tryLock 非阻塞** — `JfrTryLock` 而不是 `MutexLocker`——如果锁竞争跳过本次采样(而不是阻塞 application thread) → JFR 开销最小化(~1% CPU)。

### 2. "Path to GC Root — BFS/DFS trace"

场景: old object 采样结束 → safepoint → `PathToGcRootsOperation` → BFS/DFS 从对象沿 reference field 追溯到 GC root → 记录 chain。

**PathToGcRootsOperation** (`chains/pathToGcRootsOperation.cpp:40-100`):
```
PathToGcRootsOperation::doit():
  → 标记所有采样对象(在 bitset 中置位)
  → BFS from each sample: traverse reference fields:
       edge = {from_obj, to_obj, field_offset} → EdgeStore::add(edge)
  → BFS/DFS 持续直到 hits GC root(stop):
       • root类型: JNI global / thread stack / static field / system class / monitor
  → 反向 chain: [GC root_class] ← ... ← [holder_obj] ← [obj_class, field_offset] ← [sample_obj]
  → checkpoint_writer → serialize chain as compact record(class_id+field_offset pairs)
[C++: chains/——edgeQueue/edgeStore/bitset/bfsClosure/dfsClosure 构成路径追踪引擎]
```
- 源码: `chains/pathToGcRootsOperation.cpp:40-100` (doit → 路径追踪) + `chains/dfsClosure.cpp:40-120` (DFS 遍历) + `checkpoint/objectSampleCheckpoint.cpp:40-100` (chain 序列化)

- 关键设计: **BFS 优先 — DFS 后备** — default 用 BFS (line 112-123 `BFSClosure`) 找最短路径→更短的 chain 更易理解泄漏。如果 EdgeQueue 满(full)→fallback to DFS (`DFSClosure::find_leaks_from_root_set`, line 121)——DFS 内存开销小(只需存当前 path)但可能找更长路径。**bitset 防循环** — 每个 traversed object 在 BitSet 中标记→再次遇到跳过。**max_depth=5000** (`dfsClosure.cpp:41`) — DFS 深度超过 5000→在当前深度停止——防止在深度堆引用图中 infinite path。**EdgeQueue 内存管理** — 初始预留堆大小的 5% 或 至少 32MB(`edge_queue_memory_reservation`, line 60)——commit ratio 1:10(每次 commit 预留的 1/10)。**Root 类型** — `rootType.hpp:31-56`: System enum(_universe / _global_jni_handles / _threads / _object_synchronizer / _system_dictionary / _class_loader_data / _management / _jvmti / _code_cache / _string_table / _aot) + Type enum(_stack_variable / _local_jni_handle / _global_jni_handle / _handle_area)——两种维度交叉确定 root 分类。

### 3. "Chain 序列化 — 紧凑存储"

场景: BFS 找到 path: `Thread-1 → MyCache → ArrayList[5] → LeakedEntry`——chain 编码为 `[(ArrayList,elementData), (MyCache,cache), (Thread,stack)]`。

**ObjectSampleCheckpoint** (`checkpoint/objectSampleCheckpoint.cpp:40-120`):
```
ObjectSampleCheckpoint::write(chain):
  → for each edge in chain[0..n-1]:
       write LE(edge.from_class_id)  // 当前对象的 class ID
       write LE(edge.field_offset)   // 引用字段在对象中的偏移
  → last edge: write LE(root_type)   // GC root 类型(1=JNI global, 2=thread, 3=static, ...)
  → total: ~ (chain_len * 8) bytes  // class_id(4) + field_offset(4) per edge
[C++: checkpoint/objectSampleCheckpoint.cpp——chain 用 LE(Little Endian) 紧凑编码——单 edge 4+4=8 bytes]
```
- 源码: `checkpoint/objectSampleCheckpoint.cpp:40-80` (write chain) + `checkpoint/objectSampleWriter.cpp:30-80` (event 记录)

- 关键设计: **safepoint 内执行** — `PathToGcRootsOperation::doit()` 在 safepoint 中 (`assert(is_at_safepoint)`, line 82)——heap 一致但 STW 时间与堆大小+采样数成正比。**DFS depth 限制 5000** — 超深引用图(如 10000 层的 linked list)→DFS 在第 5000 层停止——不记录完整 chain(截断)。**EdgeQueue 满时的降级策略** — 如果 roots 放不进 edge queue(shallow heap→fewer roots fit)→DFS 只标记 roots 不走 sideways——在降级模式下仍然可以发现泄漏路径。

---

### 核心悬念

**"OldObjectSample: TLAB 分配→sampling(interval)→priority queue(keep top-N span)→tryLock 非阻塞(trace stack)→safepoint→BFS/DFS path To GC root(bitset 防循环)→chains 紧凑编码(class_id+field_offset,~8B/edge)→JMC 展示泄漏路径。"** — 下一篇: JNI Interface + Bytecode Instrumentation + DCmd。

> → [06-jni-instrumentation.md](06-jni-instrumentation.md)
