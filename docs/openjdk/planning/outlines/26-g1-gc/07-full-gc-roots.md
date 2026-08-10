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
- 关键设计: Full GC 是 serial/parallel compaction——不是 evacuation。所有 Region 作为连续 block 处理——无 per-Region RS scan——直接遍历。compact 后所有 Region 连续→Humongous 被 compacted→碎片被清除
- 关键设计: 两次连续 evacuation 失败→说明 heap fragmentation 严重(even short-lived objects can't be evacuated)→trigger Full GC 做 defrag。Full GC 比 evacuation 慢 10-50x but ensures completion
- [C++: compaction 用 `G1FullGCCompactionPoint`——每个 compaction point 处理一组 Region。Parallel workers process compaction points independently→global destination heap address 用 Atomic::add offset 确保 non-overlapping]

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
- 关键设计: root scan 用 WorkGang parallel——每 worker 独立处理部分 roots。Java roots 最耗时(per-thread stack walk)→每 thread 分配不同 worker→均匀分配。JNI global refs 从 `global_jni_handles` 遍历

### 3. "StringDedup + GC Phase Times (G1侧)"

**G1StringDedup** (`g1StringDedup.cpp:40-250 + stringDedupStat.cpp:30-80`):
```
每个 GC cycle 中 Deduplication(using 域25 shared queue/table):
  candidate Strings(survivor→old promotion)→check if char[] equals existing
  → if match→redirect String value to shared char[]
  → save 24-48 bytes per dedup'd String
```
- 源码: `g1StringDedup.cpp:40-250` + `stringDedupStat.cpp:30-80`
- 关键设计: 只在 survivor→old promotion 时处理(Young Objects rapidly die→不值得做 dedup)。dedup 率 ~15-30% char[] savings in typical server apps(~4-8% total heap)
- [C++: String dedup 用 `G1StringDedupQueue` 存 candidate Strings——push during GC→`G1StringDedupTable` hash table 存 dedup'd strings。table resize 用 rehash(doubling)。每个 entry 通过 `oopStorage` 存 oop(域25基础)]

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
