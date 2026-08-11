# 03. 堆里到底有什么 — jmap 与 MAT 堆分析

> 🟢 工具域 | 工具: jmap/MAT/VisualVM/GCeasy/JMC JOverflow | 关联 JVM 域: 37-heap-dumper、06-oops、25-gc
> 读者处境: 你要写堆转储(域 37)和对象模型(域 06)的文章——先亲手导出堆、看对象、找泄漏。
> 修订: 2026-08-11 v2——补 JMC JOverflow(本机已装);MAT/VisualVM/GCeasy 标注待装

### 1. "导出堆的三条路" — jmap 与 jcmd

场景: 拿到 .hprof,后面才有的分析。

- `jmap -dump:live,format=b,file=heap.hprof <pid>`: 经典转储(live=只存活对象)
- `jcmd <pid> GC.heap_dump -all heap.hprof`: DCmd 转储(与 jmap 同底层)
- `jmap -histo:live <pid>`: 直方图(不落盘,直接看类计数/大小)——最快的第一眼
- 触发时机: JVM 内存溢出自动转储(`-XX:+HeapDumpOnOutOfMemoryError`)
- [Java: 转储格式 = hprof 二进制(域 37);jmap 是 SA/attach 的客户端]

关键设计: **histo 先行,转储随后**: 线上先 `-histo` 看大类(毫秒级),确认再 `-dump` 全量(会停顿)——"快筛慢定"是堆分析的标准节奏。

### 2. "MAT 的四板斧" — 分析主流程(✅ 已装: /opt/tools/MAT/)

场景: heap.hprof 打开,怎么找泄漏?

- **Overview**: 总览(占用 Top 对象/类加载器)
- **Histogram**: 对象直方图(类/实例数/浅堆/深堆)——域 06 素材(对象头/引用链)
- **Dominator Tree**: 支配树——**"谁持有这堆对象"的答案**(域 06 的 GC 根/引用分析)
- **Leak Suspects**: 自动泄漏嫌疑报告(线程栈+对象链)
- **命令行实测**: `ParseHeapDump.sh <dump> org.eclipse.mat.api:suspects`(需 PATH 含 JDK21 + DISPLAY)——2026-08-11 已跑通生成 heap_Leak_Suspects.zip
- **JMC 替代(✅ 已装)**: JMC 自带 **JOverflow**(org.openjdk.jmc.joverflow)+ **MemoryLeakPage**(JFR 侧 OldObjectSample)——两个免安装替代
- [Java: MAT 解析 hprof → 对象图 → 支配树计算;深堆(Retained)是"释放后能回收多少"]

关键设计: **支配树 = 泄漏定位器**: Histogram 告诉你"什么多",支配树告诉你"为什么多"(哪个根持有)——写作域 06/37 时,MAT 的支配树是"引用链/可达性"最直观的实证。

### 3. "GC 与可视化对照"

- `GCeasy`/`GCViewer`(✅ 已装: gcviewer-1.37.jar): 上传 gc.log → 停顿/吞吐/各代曲线——域 25/26 素材
- `VisualVM`(✅ 已装: /opt/tools/visualvm_2110/): 轻量(堆曲线/CPU/线程)+ 插件——与 Arthas dashboard(AR-4)的 UI 对照
- 对照: Arthas `memory`(内存池快照,AR-0 篇 5)vs jmap(直方图)vs MAT(深堆)——**三个层次**: 概览/统计/分析

生产注意: 全量 dump 会 STW(域 18 相关)——选低峰期;生产优先 `jmap -histo` + `jcmd GC.heap_info`,必要时才 `-dump:live`。

---

跨域桥: 堆结构 = 写作域 09/25;对象头 = 域 06;转储格式 = 域 37;内存池 = Arthas AR-4 篇 3;OOM 场景 = Arthas AR-0 篇 5。
