# 02. jcmd VM.native_memory summary 怎么生成？— NMT 报告

> 🟡 Working | 2 KP 中的报告系统
> 读者处境: `jcmd <pid> VM.native_memory summary` → 输出按 ~30 分类的 native memory 使用——每分类显示 reserved+committed。`VM.native_memory detail` 显示 per-call-site break down。

### 1. "MemReporter — 格式化输出"

场景: MemTracker → MemReporter → query MallocSiteTable + VirtualMemoryTracker → format per-category summary → output to stream。

**MemReporter** (`services/memReporter.hpp:40-120 + memReporter.cpp:50-300`):
```
MemSummaryReporter:
  for each MEMFLAGS category(mtGC/mtCode/mtThread...):
    → query MallocTracker: total malloc(size+count) for this category
    → query VirtualMemoryTracker: total reserved+committed
    → format: "[category_name]: reserved=N KB, committed=N KB"

MemDetailReporter:
  for each category:
    → query MallocSiteTable: per-call-site(count+size) → print call stack + usage
    → query VirtualMemoryTracker: per-call-site breakdown
```
- 源码: `services/memReporter.hpp:40-120` + `memReporter.cpp:50-300`
- 关键设计: summary vs detail——summary 只显示 per-category 总计(不显示 call-site)，detail 显示 per-call-site 含 call-stack frame。Detail overhead更高(每个 malloc 抓栈→需 NMT=detail level)
- [C++: MemReporter 用 `outputStream*` 参数——可输出到 jcmd response 或 file。`MemDetailReporter::report_site()` iterate MallocSiteTable(packed allocation site hash entries)→print call stack via `NativeCallStack::print_on(stream)`]

### 2. "MemBaseline — 对比两次 snapshot"

场景: 应用启动后→baseline→运行→diff→发现"baseline后 mtThread 增长了 50MB"→memory leak detected。

**MemBaseline** (`services/memBaseline.hpp:40-120 + memBaseline.cpp:50-250`):
```
MemBaseline::baseline():
  → snapshot all current MallocSiteTable + VirtualMemoryTracking
  → store as baseline state

MemBaseline::diff(current):
  → for each category: current.usage - baseline.usage
  → for each call-site: current.count/size - baseline.count/size
  → if (diff > threshold) → report as potential leak
```
- 源码: `services/memBaseline.hpp:40-120` + `memBaseline.cpp:50-250`

### 3. "DCmd + MEMFLAGS ~30 分类"

场景: `jcmd <pid> VM.native_memory summary scale=KB` → DCmd→MemTracker→MemReporter→formatted output。

**NMT DCmd** (`services/nmtDCmd.hpp:40-80 + nmtDCmd.cpp:40-150`):
```
VM.native_memory:
  summary: MemSummaryReporter(output)
  detail:  MemDetailReporter(output, scale=KB/MB/GB)
  baseline: snapshot current
  summary.diff: diff vs baseline
  detail.diff: per-call-site diff vs baseline
```
- 源码: `services/nmtDCmd.hpp:40-80` + `nmtDCmd.cpp:40-150`
**MEMFLAGS** (`services/nmtCommon.hpp:30-80`):
```
mtGC, mtCode, mtThread, mtInternal, mtClass, mtNMT, mtTracing,
mtCompiler, mtTest, mtLogging, mtArguments, mtSafepoint... ~30 类
```

---

### 核心悬念

**"MemReporter 从 MallocSiteTable+VirtualMemoryTracker 聚合 per-category usage。MemBaseline→diff 对比前后 snapshot 发现 memory leak。"** — 下一篇: 域35 Diagnostic Commands。

> → 域35 Diagnostic Commands
