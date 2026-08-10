# 01. JConsole 怎么知道 Eden 用了多少？— MemoryService + MemoryPool

> 🔴 Deep | 1 KP 中的内存管理
> 读者处境: JConsole 显示 heap curve——Eden 当前 200MB、Survivor 10MB、Old 300MB。这些数据来自 MemoryService——每次 GC 后更新。

### 1. "MemoryPool — ~10 个池"

场景: JVM 启动后 MemoryService 创建所有 MemoryPool→每个 pool 追踪 usage/peak/collection。

**MemoryPool 列表** (`services/memoryPool.hpp:40-120 + memoryService.cpp:50-150`):
```
Eden Pool       — Young generation eden space
Survivor Pool   — Young generation survivor space
Old Pool        — Old/tenured generation space
Metaspace Pool  — Metadata (loaded classes)
CodeCache Pool  — JIT compiled code
Compressed Class Space — compressed class pointers
```
- 源码: `memoryPool.hpp:40-120` 类型 + `memoryService.cpp:50-150` pool tracking
- 关键设计: 每个 pool 有 `MemoryUsage(init/used/committed/max)`——used 在每次 GC 后 update→Jconsole polling via JMX→query pool→get usage→display graph。非 GC 期间 used 值可能过时(但 Jconsole 定期 refresh)
- [C++: `MemoryPool::record_peak_memory_usage()` → track highest  usage since JVM start。`CollectionUsage` 记录最后一次 GC 后的使用情况—`after_gc()` 被 MemoryManager 在 GC 后调用]

### 2. "MemoryManager — G1/ZGC/Parallel 各一个"

**MemoryManager** (`services/memoryManager.hpp:40-100`):
```
G1 Young Gen Manager      → manages Eden+Survivor pool
G1 Old Gen Manager        → manages Old pool
Metaspace Manager          → manages Metaspace pool
CodeCache Manager          → manages CodeCache pool
```
- 源码: `memoryManager.hpp:40-100` + `memoryService.cpp:manager creation`
- 关键设计: 每个 GC 有自己的 MemoryManager——G1 有两个(Young+Old)，ZGC 可能只有一个。MemoryManager 的 `gc_begin()/gc_end()` 由 safepoint 间调用——记录 GC 时间、收集次数、各 pool 使用变化

---

### 核心悬念

**"MemoryService 管理 ~10 个 MemoryPool(Eden/Survivor/Old/Metaspace/CodeCache)——每次 GC 后 update usage。JConsole polling via JMX→getUsed→display graph。"** — 下一篇: JMM 接口。

> → [02-jmm-interface.md](02-jmm-interface.md)
