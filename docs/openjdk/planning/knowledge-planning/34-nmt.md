# 域 34: NMT — 知识规划

> 源码: services/memTracker.* + nmtCommon.* + nmtDCmd.* + virtualMemoryTracker.* + mallocTracker.* + mallocSiteTable.* + memBaseline.* + memReporter.* | ~18文件 | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| services/memTracker.hpp/cpp | **MemTracker — NMT 总控**: initialize/report/baseline/shutdown, tracking level(off/summary/detail), NMT_TrackingLevel, per-thread allocation tracking | High |
| services/virtualMemoryTracker.hpp/cpp | **VirtualMemoryTracker**: track virtual memory(mmapped/committed/reserved), per-call-site allocation record(VirtualMemoryAllocationSite), reserve/commit/uncommit/release operations | High |
| services/mallocTracker.hpp/cpp + mallocSiteTable.hpp/cpp | **MallocTracker + MallocSiteTable**: per-call-site malloc tracking(pointer→size+site), MallocSiteTable(hash table: allocation site→count+size), MallocHeader(嵌入 allocated memory 追踪) | High |
| services/nmtCommon.hpp/cpp | **NMT Common**: MEMFLAGS(mtGC/mtCode/mtThread/mtInternal等 ~30 categories), NMT_TrackingLevel 枚举 | Medium |
| services/memBaseline.hpp/cpp | **MemBaseline**: baseline snapshot(compare two NMT reports), before/after analysis for leak detection | Medium |
| services/memReporter.hpp/cpp | **MemReporter**: format NMT report(summary/detail/diff), per-category/call-site output | Medium |
| services/nmtDCmd.hpp/cpp | **NMT DCmd**: jcmd VM.native_memory summary/detail/baseline/diff | Medium |

*7 知识点*

## 02 聚合 — P1/P2

### P1
| KP | 出现文件 |
|----|---------|
| MemTracker + malloc tracking | memTracker.*, mallocTracker.*, mallocSiteTable.*, nmtCommon.* |

### P2
| KP | 出现文件 |
|----|---------|
| VirtualMemory Tracker | virtualMemoryTracker.*, memTracker.* |
| NMT Reporting | memBaseline.*, memReporter.*, nmtDCmd.* |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| MemTracker + MallocTracker 全栈追踪 | NMT 的核心——每次 malloc(os::malloc)嵌入 MallocHeader(含pointer+size+allocation site)→MallocSiteTable hash 按 call-site 聚合(count+total size)。VirtualMemoryTracker 记录每次 mmap/munmap→同 call-site 聚合。MemTracker 在 VM 启动时可选(启动参数 `-XX:NativeMemoryTracking=summary/detail`)，overhead ~3-5% |

### 🟡 Working (2 KP)
| KP | 说明 |
|----|------|
| MemBaseline + Diff | 拍 snapshot→compare baseline→analyze leak(两次 report diff) |
| MemReporter + DCmd | format report text + jcmd VM.native_memory |

### 🟢 Surface (1 KP)
| KP | 说明 |
|----|------|
| NMT Common types | MEMFLAGS ~30 categories |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | NMT 追踪系统 | "每次 malloc 怎么被追踪到 call-site？MallocHeader 怎么嵌入？" |
| 2 | NMT 报告与对比 | "jcmd VM.native_memory summary 怎么生成？基线对比怎么查到泄漏？" |
