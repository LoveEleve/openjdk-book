# 05. JFR 怎么找到内存泄漏的 GC root？— Leak Profiler

> 🟡 Working | 2 KP 中的泄漏分析
> 读者处境: JFR 启用 Old Object Sampling——每 N 次 TLAB 分配→采样一个 old object→trace path to GC root→record as `jdk.OldObjectSample` event。

### 1. "OldObjectSample — 泄漏路径"

场景: 10GB heap, 每分钟 1000 次 TLAB 分配→每 1000 次采一次 old object→每 GC cycle ~1-10 个 old object samples→检查 GC root path 找到泄漏。

**Old Object Sampling** (`jfr/leakprofiler/sampling/objectSampler.cpp:40-250`):
```
ObjectSampler:
  every N_th TLAB allocation:
    → pick object from Old gen
    → ObjectSampler::sample(obj)
      → find path to GC root (DFS from obj through reference graph)
      → chain = [obj→field→holder_obj→...→GC root]
      → record EventOldObjectSample(obj, chain)
```
- 源码: `jfr/leakprofiler/sampling/objectSampler.cpp:40-250` + `jfr/leakprofiler/chains/`
- 关键设计: 采样率 = 1/N TLAB 分配(可通过 `-XX:OldObjectSampleInterval=N` 调整)。Pathfinding 在 safepoint 间做(保护一致性)——safepoint 结束时采样线程安全的
- [C++: pathfinding 从旧对象开始 DFS——沿 reference chain 直到 GC root(thread stack, static field, JNI global)。chain 存储为 `ObjectSampleCheckpoint`: [class_id+field_offset] 对——每跳跃约 8 bytes。最终 chain 长度 ~3-10 hops = ~50 bytes]

### 2. "chains/ + checkpoint/"

**Leak chain storage** (`jfr/leakprofiler/chains/pathToGcRootsOperation.cpp:40-300`):
```
Path to GC root:
  [obj_class, obj_size] → [field_name, field_offset] → [holder_obj] → ... → [GC root_class]
  encoded as compact chain of {class_id, field_offset} pairs
  → JfrCheckpointWriter serializes chain to chunk
```
- 源码: `jfr/leakprofiler/chains/pathToGcRootsOperation.cpp:40-300` + `jfr/leakprofiler/checkpoint/`

---

### 核心悬念

**"OldObjectSample 每 N 次 TLAB 分配采一个老对象→DFS trace path to GC root→record chain as {class_id,field_offset} 对。"** — 下一篇: JNI + Instrumentation + DCmd。

> → [06-jni-instrumentation.md](06-jni-instrumentation.md)
