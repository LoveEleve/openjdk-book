# 02. jcmd VM.native_memory summary 怎么生成？— NMT 报告

> 🟡 Working | 2 KP 中的报告系统
> 读者处境: `jcmd <pid> VM.native_memory summary` → 输出按 ~30 分类的 native memory 使用——每分类显示 reserved+committed。`VM.native_memory detail` 显示 per-call-site break down。

> ⚠️ 写作期修正(2026-08-14, vol-02/34-nmt/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"MemReporter::report_site()" 编造**: 真实函数=MemDetailReporter::report_malloc_sites(memReporter.cpp:228-249,by_size 降序,显示单位内 0 跳过)/report_virtual_memory_allocation_sites(:251-275)/report_virtual_memory_region(:289-337,整段 committed 标 "reserved and committed",子段与主栈相同不重复打印 :310-319);detail 报告=summary+report_virtual_memory_map("Virtual memory map:" :278-287)+report_detail("Details:" :219-226)(memReporter.hpp:136-140)
> - **"MemBaseline::diff(current)" 编造(重要)**: MemBaseline **没有 diff 方法**(只有三快照+分配点链表+排序);diff 在 **reporter 层**: MemSummaryDiffReporter::report_diff(memReporter.cpp:339-365,每类 当前值 vs 基线值,差值非零打 " %+ld" 带符号 :367-388/:405-420);MemDetailDiffReporter::report_diff(:626-630)=summary diff+diff_malloc_sites+diff_virtual_memory_sites,**双链归并**(两表按 (site,type) 排序游标逐对比较 :632-661;MEMFLAGS 变=旧释放+新分配 :705-716)
> - **"if (diff > threshold) → potential leak" 编造**: **无任何泄漏阈值判定**——diff 只报增量,人工看
> - **行号漂移**: memReporter.hpp 241 行(MemReporterBase :40-90/MemSummaryReporter :95-120/MemDetailReporter :125-153/MemSummaryDiffReporter :160+/MemDetailDiffReporter);memReporter.cpp **772 行**非 50-300;memBaseline.cpp **328 行**非 50-250;nmtDCmd.cpp **216 行**非 40-150
> - **"~30 分类" 错**: 20 类(01 篇已回填);mtThreadStack 跳过并入 Thread 类(report :112-113 + report_summary_of_type :127-137: Thread 并栈/NMT 并 tracking overhead)
> - **缺机制(重要)**: ①报告入口=MemTracker::report(memTracker.cpp:209-225)→每次新建**临时 MemBaseline**(NMTDCmd::report :174-185,报告完即弃);**持久基线只有一份** MemTracker::_baseline(memTracker.hpp:312),`VM.native_memory baseline` 写它;②baseline 采集=baseline_summary 三快照(MallocMemorySummary/VirtualMemorySummary/MetaspaceSnapshot :147-152)+类计数(ClassLoaderDataGraph::num_instance_classes :186-187);detail 才 walk MallocSiteTable(忽略空 site :97-109)+虚拟内存区域**聚合 per-site**(aggregate_virtual_memory_allocation_sites :210-231);排序 by_address/by_size/by_site/by_site_and_type(memBaseline.hpp:53-58,惰性重排 :270-302);③NMTDCmd 8 选项(nmtDCmd.cpp:34-68: summary/detail/baseline/summary.diff/detail.diff/shutdown/statistics+scale 默认 "KB" :58),选项至多一个不指定默认 summary(:94-114),off→"Native memory tracking is not enabled"/minimal→"has been shutdown"(:79-85),query_lock 串行化(:117),baseline 成功输出 "Baseline succeeded";④注册=Management::init(management.cpp:143,AttachAPI/MBean/Internal 三源),命令名 "VM.native_memory"(nmtDCmd.hpp:51);⑤**scale**: DCmd 默认 KB;PrintNMTStatistics final_report 用 scale=1 原始字节(memTracker.cpp:195-207)——实证无 KB 后缀的证据
> - **实证**: 34-nmt-tracking-demo.txt(summary 报告与 report_summary_of_type 逐行对照: Total/malloc/mmap/arena/tracking overhead 行;detail 段对照 Virtual memory map+Details+4 帧归属段);jcmd-VM.native_memory.txt(未启用 "Native memory tracking is not enabled" = execute 第一行);**diff 真实输出素材缺失(jcmd attach 本容器不可用,自 attach 被 JDK 禁止 "Can not attach to current VM")** → diff 形态按 print_malloc_diff/print_virtual_memory_diff 格式代码布局推导,正文已注明
> - **悬念指向错**: 大纲"→ 域35 Diagnostic Commands"过期——按 writing-order 34→36,正确 36-attach/01(AttachListener+Socket IPC,jcmd 通道)
> - **01 篇衔接**: 快照区 copy_to 的 ThreadCritical(mallocTracker.hpp:168-177)、make_adjustment、metaspace 报告(MetaspaceUtils,10 域)

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
