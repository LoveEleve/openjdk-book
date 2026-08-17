# 02. jcmd VM.native_memory summary 怎么生成?— NMT 报告

> **前置依赖**:[34-nmt/01 — 每次 malloc 怎么被追踪到 call-site?— NMT 追踪系统](01-tracking.md):MallocHeader 记账、MallocSiteTable 与虚拟内存区域链表是报告的数据源
> → **后续**:[36-attach/01 — jcmd 怎么连接到运行中的 JVM?— AttachListener + Socket IPC](openjdk/vol-02/36-attach/01-attach-listener.md):jcmd 就是走 attach 通道把命令送进 VM 的
> 关联域: 35-dcmd(DCmd 框架)、38-perfdata(另一条观测通道)

## 数据都在账本里,怎么变成报告树

01 篇把每次 `os::malloc`/mmap 都记进了三类账本: 按类别的计数器快照(MallocMemorySnapshot/VirtualMemorySnapshot)、detail 级别的 call-site 表(MallocSiteTable)与虚拟内存区域链表。这篇回答两件事: **报告是怎么生成的**——从账本到 `jcmd VM.native_memory summary` 那棵缩进树;以及 **baseline/diff 怎么定位泄漏**——两次快照怎么对比。核心答案是三层: 报告前先拍一个**快照**(MemBaseline),快照交给**报告器**(MemReporter)排版,入口是 **DCmd**(NMTDCmd)——而快照与追踪数据分离,是这套设计的关键。

## 1. 快照: 每次报告都用一张新拍的"照片"

报告的入口是 `MemTracker::report`(memTracker.cpp:209-225): 先建一个 `MemBaseline`,`baseline.baseline(summary_only)` 拍快照,再按级别选 MemSummaryReporter/MemDetailReporter。拍快照这件事在 MemBaseline::baseline(memBaseline.cpp:183-203):

```cpp
// memBaseline.cpp:147-152(截取核心,逐字)
bool MemBaseline::baseline_summary() {
  MallocMemorySummary::snapshot(&_malloc_memory_snapshot);
  VirtualMemorySummary::snapshot(&_virtual_memory_snapshot);
  MetaspaceSnapshot::snapshot(_metaspace_snapshot);
  return true;
}
```

`baseline_summary` 把**三个快照区拷进 MemBaseline 自己的成员**——malloc 计数器、虚拟内存计数、Metaspace 用量(01 篇说过快照区是静态区,`copy_to` 用 ThreadCritical 保证拷贝中 chunk 不被调整);外加 `ClassLoaderDataGraph::num_instance_classes/num_array_classes`(:186-187)记类数。summary 级别的基线到此为止;detail 级别(NMT_detail)才继续 `baseline_allocation_sites`(:154-181): walk 整张 MallocSiteTable(忽略 size 为 0 的空 site,:97-109)拷进排序链表,**再 walk 虚拟内存区域链表并按"调用栈+类型"聚合成 per-site 的 reserved/committed**(aggregate_virtual_memory_allocation_sites :210-231)。排序方式四种(memBaseline.hpp:53-58): by_address/by_size/by_site/by_site_and_type,report 时按需重排(malloc_sites 惰性排序 :270-302)。

*关键设计: 报告器只读快照,不碰追踪数据结构*——采集在 `MemTracker::query_lock`(DCmd 层,见 §4)内一次性完成(快照拷贝本身受 ThreadCritical 保护,mallocTracker.hpp:172,防止拷贝中 arena chunk 被调整),report 阶段纯读——报告线程安全,且对分配路径的干扰只在采集快照的那一瞬间。**持久基线只有一份**(`MemTracker::_baseline`,memTracker.hpp:312),`VM.native_memory baseline` 命令写它;而每次普通报告(`VM.native_memory summary`)都新建临时 baseline,报告完即弃(NMTDCmd::report :174-185)——"照片"用完就删。

## 2. summary 报告: 一行一个类别,与实证逐行对照

`MemSummaryReporter::report`(memReporter.cpp:95-119)的输出结构:

```cpp
// memReporter.cpp:95-119(截取核心,逐字)
void MemSummaryReporter::report() {
  const char* scale = current_scale();
  outputStream* out = output();
  size_t total_reserved_amount = _malloc_snapshot->total() +
    _vm_snapshot->total_reserved();
  size_t total_committed_amount = _malloc_snapshot->total() +
    _vm_snapshot->total_committed();

  // Overall total
  out->print_cr("\nNative Memory Tracking:\n");
  out->print("Total: ");
  print_total(total_reserved_amount, total_committed_amount);
  out->print("\n");

  // Summary by memory type
  for (int index = 0; index < mt_number_of_types; index ++) {
    MEMFLAGS flag = NMTUtil::index_to_flag(index);
    // thread stack is reported as part of thread category
    if (flag == mtThreadStack) continue;
    MallocMemory* malloc_memory = _malloc_snapshot->by_type(flag);
    VirtualMemory* virtual_memory = _vm_snapshot->by_type(flag);

    report_summary_of_type(flag, malloc_memory, virtual_memory);
  }
}
```

**Total = malloc 总量 + 虚拟内存 reserved/committed**(`MallocMemorySnapshot::total` 含 arena 与 tracking header,mallocTracker.cpp:35-42);然后**逐 20 类输出**(mtThreadStack 被跳过——它并入 Thread 类)。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/34-nmt-tracking-demo.txt) 的输出与这段代码逐行对应: "Total: reserved=18058807559, committed=1165695239";"Java Heap (reserved=..., committed=...)" 来自 `print_total`;每一类的子行由 `report_summary_of_type`(:121-190)按数据存在性决定: malloc 行 `(malloc=343389 #3287)`(print_malloc_line :70-74),虚拟内存行 `(mmap: reserved=.., committed=..)`(:76-80),arena 行 `(arena=19632 #34)`(:82-86),NMT 类再追加 `(tracking overhead=263488)`(:177-180)。

`report_summary_of_type` 里有两个**跨类别汇总**(:127-137): mtThread 类要把 mtThreadStack 的 reserved/committed 加进来("Count thread's native stack in Thread category"),mtNMT 类要把 tracking overhead(所有 MallocHeader 的累计)加进来;mtClass 类额外输出类计数(instance/array,:146-151)与 Metadata 详情(report_metadata :192-217,来自 MetaspaceUtils——10 域 Metaspace 的 used/free/waste 在这里上报告)。**不足一个显示单位的类别不输出**(`amount_in_current_scale(reserved_amount) > 0`,:139)——所以报告里 20 类不一定全出现:[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/34-nmt-tracking-demo.txt) 的退出报告恰好 **18 类**(mtThreadStack 并入 Thread、mtTest 全程无分配)。

## 3. detail 报告: summary + 虚拟内存地图 + 逐调用点

`MemDetailReporter::report`(memReporter.hpp:136-140)在 summary 之上追加两段:

```cpp
// memReporter.hpp:136-140(截取核心,逐字)
  virtual void report() {
    MemSummaryReporter::report();
    report_virtual_memory_map();
    report_detail();
  }
```

`report_virtual_memory_map`(memReporter.cpp:278-287)打出 "Virtual memory map:"——**按地址序**遍历 ReservedMemoryRegion。`report_virtual_memory_region`(:289-337)的排版规则: 区域整段 committed 则标 "reserved and committed",否则标 "reserved",后接 "for <类别名>" 与 "from" 调用栈(4 帧);其下的 committed 子段每个单独一行(缩进,\t + "committed")——[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/34-nmt-tracking-demo.txt)里 "reserved 16001269760 for Java Heap from [ReservedHeapSpace::try_reserve_heap...]" 与 "committed 1000341504 from [G1PageBasedVirtualSpace::commit_preferred_pages...]" 的成对输出正是这段代码。整段 committed 且子段栈与主栈相同就不重复打印(:310-319,注释 "One region spanning the entire reserved region...Don't print this regions")。

`report_detail`(:219-226)打出 "Details:" 后接两节。`report_malloc_sites`(:228-249)按**大小降序**遍历 call-site(基线里是 by_size 序),**显示单位内 size 为 0 的跳过**(:237),其余: 栈 print_on + `(malloc=N type=Class #count)`——[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/34-nmt-tracking-demo.txt)里 "Details:" 之后的 `(malloc=16 type=Internal #1)` 归属段,每段 4 帧栈。`report_virtual_memory_allocation_sites`(:251-275)同理输出 per-callsite 的 reserved/committed。

## 4. baseline/diff: 快照对比与 DCmd 入口

入口是 `NMTDCmd`(nmtDCmd.hpp:38-74,命令名 "VM.native_memory",:51;注册在 Management::init,management.cpp:143,AttachAPI/MBean/Internal 三源)。**8 个选项**(nmtDCmd.cpp:34-68): summary/detail/baseline/summary.diff/detail.diff/shutdown/statistics + scale(默认 **"KB"**,:58)。execute(:76-161)先做状态检查:

```cpp
// nmtDCmd.cpp:76-85(截取核心,逐字)
void NMTDCmd::execute(DCmdSource source, TRAPS) {
  // Check NMT state
  //  native memory tracking has to be on
  if (MemTracker::tracking_level() == NMT_off) {
    output()->print_cr("Native memory tracking is not enabled");
    return;
  } else if (MemTracker::tracking_level() == NMT_minimal) {
     output()->print_cr("Native memory tracking has been shutdown");
     return;
  }
```

"Native memory tracking is not enabled"——正是 [实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/jcmd-VM.native_memory.txt) 里未开启时 `jcmd <pid> VM.native_memory` 的第一行。之后: scale 合法校验(:87-92);**选项至多一个**(:94-114,nopt>1 报错,不指定则默认 summary);`MutexLocker(MemTracker::query_lock())` 串行化所有 NMT 查询(:117)——与 §1 的快照采集配套。选项分派: summary/detail → `report`(新建临时 baseline → MemSummaryReporter/MemDetailReporter);**baseline → 写持久基线**(:126-132,成功后输出 "Baseline succeeded");summary.diff/detail.diff → `report_diff`(:187-204,持久基线 + 新拍快照);shutdown → `MemTracker::shutdown`(:150-152,降到 minimal,呼应 01 篇的"只降不升");statistics → `MemTracker::tuning_statistics`(:153-156,MallocSiteTable 调优统计)。

**diff 的机制在 reporter 层,不在 MemBaseline**——MemBaseline 只有快照,没有 diff 方法。`MemSummaryDiffReporter::report_diff`(memReporter.cpp:339-365)对每个类别: 当前值 vs 基线值,**差值非零才打 " %+ld"**(带符号,print_malloc_diff :367-388/print_virtual_memory_diff :405-420)——所以输出形如 `reserved=1200KB +200KB, committed=1100KB +100KB`,而 "malloc=16 #1 +1" 表示这次新增 1 次分配。`MemDetailDiffReporter::report_diff`(:626-630)在 summary diff 之上对两张 call-site 表做**双链归并**(diff_malloc_sites :632-661): 两表都按 (site,type) 排序,游标逐对比较——栈相同则 diff 同一 site、只在旧表则 "旧分配被释放"、只在新表则 "新分配点";site 的 MEMFLAGS 变了就拆成"释放旧的+分配新的"(:705-716)。**没有任何泄漏阈值判断**——diff 只报告增量,人工看数字;这也与素材 jcmd-VM.native_memory-annotated.txt 的用途说明一致(排查泄漏是"对比两次输出")。

*关键设计: 报告与追踪分离,追踪只记账、报告只排版*;基线对比因此极其廉价——持久基线是 01 篇账本的一份拷贝,`summary.diff` 只需再拍一张新快照做差。唯一注意事项: **scale**。DCmd 默认 KB;而 `PrintNMTStatistics` 的退出报告走 `MemTracker::final_report`(memTracker.cpp:195-207),用 `report(level == NMT_summary, output, 1)`——**scale=1 即原始字节**,所以 [实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/34-nmt-tracking-demo.txt) 的 PrintNMTStatistics 输出没有 KB/MB 后缀。diff 的真实输出素材暂缺(jcmd attach 在本容器不可用),上面 "reserved=.. +..KB" 形态是按 `print_malloc_diff` 的格式代码推导的布局。

## 核心悬念

报告链路拆完: 每次 `VM.native_memory` 都在 query_lock 内拍一张三快照+分配点的 MemBaseline 照片,MemSummaryReporter 逐 20 类排版(Thread 并栈、NMT 并 overhead、Class 并 metadata),MemDetailReporter 加虚拟内存地图与逐调用点归属(与 [实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/34-nmt-tracking-demo.txt) 逐行对应);基线是唯一持久快照,summary.diff/detail.diff 用新照片与它做带符号的逐项对比(双链归并,无阈值);入口 NMTDCmd 的 8 选项在 Attach/MBean/Internal 三源注册。剩下的疑问不在 NMT 内部: **jcmd 的命令是怎么送进 JVM 的**?——"VM.native_memory" 这个字符串从本地 jcmd 进程出发,经由 attach socket 到达目标 JVM 的 Attach Listener 线程,再转给 DCmd 框架执行。下一篇: AttachListener 与 Socket IPC。

> → [36-attach/01 — jcmd 怎么连接到运行中的 JVM?— AttachListener + Socket IPC](openjdk/vol-02/36-attach/01-attach-listener.md)
