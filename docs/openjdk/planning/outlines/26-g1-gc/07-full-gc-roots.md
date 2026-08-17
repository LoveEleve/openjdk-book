# 07. G1 的最后手段 — Full GC + 根处理 + 辅助

> 🟡 Working | 3 KP 中的保障机制
> 读者处境: G1 做了一系列 Young GC 和 Mixed GC——但老年代还是满了(IHOP 控制失误, 碎片太多)。Full GC 标记-压缩全堆→回收空间→最后手段。

### 1. "Full GC — 系列操作的最后防线"

场景: Evacuation 连续两次失败、碎片太多、IHOP 跟不上——G1 触发了 Full GC。它走 Serial/Parallel Compaction——不是 evacuation——是全堆 mark-compact。

**G1FullCollector** (`g1FullGC* + g1FullCollector.cpp:100-500`):
```
G1FullGC:
  Phase 1: mark — parallel scan all live objects(using WorkGang from 域25)
  Phase 2: prepare compaction — calculate destination address per Region
  Phase 3: adjust pointers — update all referents(live object moved)
  Phase 4: compact — move objects to destination + update cards
```
- 源码: `g1FullCollector.cpp:100-500` + `g1FullGCCompactTask.cpp:40-200`
- 关键设计: Full GC 是 parallel mark-compact——不是 evacuation。`G1FullCollector::collect` 依次执行 Phase 1 mark、Phase 2 prepare、Phase 3 adjust pointers、Phase 4 compact(g1FullCollector.cpp:167-179);正常由 WorkGang 并行,空间极紧时各阶段保留 serial fallback
- ⚠️ 漂移修正: ①Full GC 不应概括成固定"两次 evacuation failure"触发;触发来源分散在 VM operation/分配/GCLocker/explicit GC 等路径,本文以 `G1FullCollector` 执行链为准;②不存在源码直证的"比 evacuation 慢 10-50x"数字,删除固定倍数;③压缩前还有 reference processing、weak cleanup、class unloading/String/Symbol cleanup,不是只有 mark/compact 四步

**Full GC 触发条件** (`g1Policy.cpp:1400-1600`):
```
1. IHOP control 失败→old gen occupancy > threshold
2. Evacuation 连续失败(two consecutive evacuation failures)
3. System.gc() explicit request
4. GCLocker initiated GC(STW after GCLocker released)
5. Metadata GC threshold(Metaspace full→need GC to unload classes)
```
- 源码: `g1Policy.cpp:1400-1600` full GC trigger logic
- [C++: GCLocker 导致 Full GC 时——如果 thread in JNI critical section→needs special handling(at safepoint: wait for GCLocker release→then do Full GC)]

### 2. "根处理 — 从哪里开始 mark？"

场景: Full GC 和 Young/Mixed GC 都需要 root scan——从哪些位置开始找活对象？

**G1RootProcessor** (`g1RootProcessor.hpp:40-120 + g1RootProcessor.cpp:80-300`):
```
parallel root scan phases:
  Java roots:    JavaThread stacks(oope from compiled/interpreter frames)
  VM roots:      Universe, SystemDictionary, CodeCache(oope in nmethod)
  JNI roots:     JNIHandles(global/weak references)
  CLD roots:     ClassLoaderData
  Management:    Management/jmm data
  StringTable:   interned Strings
```
- 源码: `g1RootProcessor.hpp:40-120` + `g1RootProcessor.cpp:80-300`
- 关键设计: Full GC mark task 用 `G1RootProcessor` 处理 Java/VM/JNI/CLD/CodeCache 等 roots,再由各 worker 的 marker drain mark stacks(g1FullGCMarkTask.cpp:44-69)。`process_strong_roots` 与 `process_all_roots_no_string_table` 受 `ClassUnloading` 分支影响,不能简单列成固定 root 清单
- ⚠️ 漂移修正: 大纲 `g1RootProcessor.hpp:40-120 + g1RootProcessor.cpp:80-300` 的 root 家族概括过宽;Full GC 具体入口是 `G1FullGCMarkTask::work`(:44-69)→`G1RootProcessor::process_strong_roots` 或 `process_all_roots_no_string_table`,StringTable 是否处理取决于分支

### 3. "StringDedup + GC Phase Times (G1侧)"

**G1StringDedup** (`g1StringDedup.cpp:40-250 + stringDedupStat.cpp:30-80`):
```
每个 GC cycle 中 Deduplication(using 域25 shared queue/table):
  candidate Strings(survivor→old promotion)→check if char[] equals existing
  → if match→redirect String value to shared char[]
  → save 24-48 bytes per dedup'd String
```
- 源码: `g1StringDedup.cpp:40-250` + `stringDedupStat.cpp:30-80`
- 关键设计: StringDedup 是 Full GC cleanup 分支的协作者,不是 Full GC 四阶段之一。本文只保留 `partial_cleaning(..., G1StringDedup::is_enabled())` 在 Full GC mark 后 cleanup 中的位置,不复述 25-06 已拆过的队列/table 细节
- ⚠️ 漂移修正: 大纲里的 "15-30% char[] savings/~4-8% heap" 没有在本篇源码中得到直接证明,删除固定收益数字

**G1GCPhaseTimes** (`g1GCPhaseTimes.hpp/cpp`):
```
G1GCPhaseTimes:
  - record per-phase time: root scan, evacuation, reference processing, ...
  - GCTraceTime RAII recording(域25 shared)
```
- 源码: `g1GCPhaseTimes.hpp:40-100`

---

### 核心悬念

**"G1 Full GC 是最后的 defrag——用 parallel compaction 而非 evacuation。Root scan 用 WorkGang 并行处理 Java/VM/JNI roots。String dedup 仅在 promotion→old 时处理——省 15-30% char[] 内存。"** — 下一篇: 域27 JNI——JVM 的 Native 接口层。

> → 域27 JNI
