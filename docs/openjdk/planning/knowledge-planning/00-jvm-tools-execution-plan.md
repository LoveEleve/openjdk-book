# 域 00 工具探索实操执行计划 v1

> 2026-08-11 | 依据: KP v5(`00-jvm-tools.md` 01-09 节)+ REVIEW v1/v2/v3(`00-jvm-tools-review*.md`)+ 7 篇大纲
> 目标: 把规划产出的全部观测面(19 工具/29 页签/50 命令/170 事件/74 规则/43 域)落地为**写作素材**,按 `materials/` 归档,就绪度表(KP 09)全绿
> 纪律: 一次只做一个任务 → 自查 → 合格 → 下一项(深审档案 13 类)

---

## 一、目标与产出定义

**核心原则**: 每个任务产出 = 命令输出/截图 + 对应 JVM 域标注 → 直接可进文章。

**素材归档目录**(`outlines/00-jvm-tools/materials/`):

```
materials/
├── screenshots/      # 截图: NN-tool-topic.png(如 01-jmc-lockinstances.png)
├── commands/         # 命令输出: tool-command.txt(如 jcmd-VM.flags.txt)
├── jfr-recordings/   # 录制/转储(rec-demo.jfr 等,已入库)
├── logs/             # gc.log/hotspot.log 等原始日志
└── INDEX.md          # 素材索引: 域 → 素材文件(素材入库时更新)
```

**素材标注规范**: 每个素材文件名 + INDEX.md 记录 `域号/工具/命令/日期`。

---

## 二、环境前置(已就绪,2026-08-11 实测)

| 组件 | 位置 | 状态 |
|---|---|---|
| JDK 17(TencentKona) | `/opt/codev/TencentKona` | ✅ 14 工具全装 |
| JDK 21 | `/opt/codev/TencentKona-21.0.12.b1` | ✅ JMC 必需 |
| JMC 9.1.2 | `/opt/jmc/.../jmc`(jmc.ini 已指 JDK21) | ✅ 运行于 Xvfb :99 |
| Xvfb + 截图 | `Xvfb :99` + Shot.java(Java Robot) | ✅ |
| 生态工具 | MAT/VisualVM/JITWatch/GCViewer/FlameGraph/perf | ✅ 已装(启动验证见 A 组) |
| 采样目标 | `Demo.java`(CPU+分配+多线程,120s 寿命)/math-game | ✅ |
| 素材基底 | rec-demo.jfr(90 类事件)/probe.jfr/heap.hprof | ✅ 已入库 |

---

## 三、A 组 — 基础设施验证(8 项,先于 B 组)

> 目的: 生态工具全部"实测可用"后才开始采集,避免素材半途失败(深审 #6)

| # | 任务 | 状态(2026-08-11 实测) | 通过标准 | 关联 |
|---|---|---|---|---|
| A1 | JITWatch 启动 | ✅ 启动/界面已验(a1-jitwatch.png);**"导入 hotspot.log"归 B4.4**(v5 审计标注) | 窗口出现,可导入 hotspot.log | 篇 4 |
| A2 | GCViewer 启动 | ✅ 已验: 打开 13MB gc.log 图表渲染(a2-gcviewer.png) | 图表渲染 | 篇 3 |
| A3 | VisualVM 启动 | ✅ 界面渲染(a3-visualvm.png);**"本地 JVM 列表"归 B3.5 确认**(v5 审计标注) | 窗口 + 本地 JVM 列表 | 篇 3/6 |
| A4 | JMC 实时连接 | 🟡 数据面已验(ManagementAgent.start_local + JMX 26 MBean);GUI 截图待 B1.6 交互 | 控制台 CPU/堆曲线动 | 篇 1/6 |
| A5 | JMC MBean 浏览器 | 🟡 数据面已验(MBean 树 26 个,素材已存 INDEX);GUI 待交互 | 树可见 | 篇 6 |
| A6 | JMC JOverflow | 🟡 无独立主类(OSGi bundle),验证归 B3.5 交互;heap.hprof 可分析已验(MAT) | 泄漏分析报告 | 篇 3 |
| A7 | async-profiler 录 JFR | ✅ **双模式**: ① 独立 JFR(JDK17/21): ap-target.jfr(ExecutionSample 6282 条)② jfrsync 合并(JDK21): ap21-sync.jfr(JDK 全量+AP 采样一个文件)——jfrsync 值必须是合法 JFR 配置路径 | 生成 .jfr,JMC 可打开 | 篇 1/KP08 |
| A8 | perf 权限 | ✅ 已验: paranoid=2,record 56718 样本 + perf→stackcollapse→flamegraph 全链路打通 | 采样成功 | 篇 6 |

**A 组完成定义**: 8 项全通过或记录明确降级理由;`materials/INDEX.md` 建好。

---

## 四、B 组 — 7 篇素材采集(按大纲顺序)

### B1 篇 1 — JFR/JMC(170 事件 + 29 页签 + 74 规则)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B1.1 | 三种触发方式 | jcmd JFR.start / JMC 向导 / `-XX:StartFlightRecording` | 截图 ×3 → screenshots(jcmd/-XX 文本已做;向导 GUI→附录 G1) | 32 |
| B1.2 | 90 类事件按域归档 | `jfr print --events <e> rec-demo.jfr` 按 KP05 索引抽取代表事件 | commands/jfr-events-<域>.txt ×30 | 全部 |
| B1.3 | **-Xint 解释器实证** | `java -Xint Demo` + 录 JFR | commands/jfr-xint-executionsample.txt(state=INTERPRETED) | 08 |
| B1.4 | 关键页签截图 | JMC 打开 rec-demo.jfr,截 Overview/Threads/LockInstances/VMOperation/Tlab/Event Browser/Flame Graph/GC | screenshots/01-jmc-*.png ×8 | 25/17/19/20/09/32 |
| B1.5 | Automated Analysis | JMC 自动分析页截图(74 规则实际触发) | screenshots/01-jmc-automatedanalysis.png | 32 |
| B1.6 | 实时连接+控制台 | A4 数据面已验证(ManagementAgent.start_local+26 MBean);GUI 截图→附录 G2 | screenshots/01-jmc-console.png | 33 |
| B1.7 | AP 两种写者对照 | A7 产物(**v5 审计修正: 双模式均已打通**——独立 ap-target.jfr + jfrsync 合并 ap21-sync.jfr),对比 JDK JFR 事件集差异 | commands/ap-jfr-events.txt(AP 事件清单,已入库 ap21-sync.jfr) | 32 |
| B1.8 | 锁事件触发 | 多线程抢锁 demo 录 JFR(JavaMonitorEnter/Inflate 实测) | commands/jfr-monitor.txt | 19 |
| B1.9 | **default vs profile 对比**(v4 新增) | 同 demo 同 30s,分别 default/profile 录制 → 事件计数对比表 | commands/jfr-default-vs-profile.txt | 18/25/32 |

### B2 篇 2 — jcmd(50 子命令)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B2.1 | 50 命令全量输出 | `jcmd <pid> <cmd>` 逐条 | commands/jcmd-<cmd>.txt ×50 | 35 |
| B2.2 | 10 组典型输出精读 | VM.flags/GC.heap_info/Thread.print/VM.events/VM.metaspace/VM.log/VM.class_hierarchy/Compiler.codecache/VM.native_memory/VM.cds | commands/jcmd-<cmd>-annotated.txt(加解读) | 03/25/17/20/10/04/07/16/34/11 |
| B2.3 | jstat 12 选项 | `jstat -<opt> <pid> 1000 3` 全选项 | commands/jstat-<opt>.txt ×12 | 25/13/38 |
| B2.4 | Arthas 对照 | `arthas` 连接 math-game: thread/vmoption 输出 | commands/arthas-thread.txt | 17/03 |

### B3 篇 3 — 内存工具(jmap/MAT/GCViewer/VisualVM/JOverflow)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B3.1 | jmap 四路 | `-histo:live/-dump:live/-clstats/-finalizerinfo` | commands/jmap-*.txt ×4 | 37/06/07 |
| B3.2 | MAT 四板斧 | 命令行(headless ParseHeapDump)本环境先做;GUI 四视图→附录 G3 | screenshots/03-mat-*.png + commands/mat-leak.txt | 37/06 |
| B3.3 | OOM 场景 | `-XX:+HeapDumpOnOutOfMemoryError` 小堆 demo | commands/oom.log + heap.hprof | 37 |
| B3.4 | GCViewer | `-Xlog:gc` 开 gc.log → GCViewer 解析 | logs/gc.log + screenshots/03-gcviewer.png | 25/26 |
| B3.5 | VisualVM/JOverflow | A3/A6 截图 | screenshots/03-*.png | 33/25/37 |
| B3.6 | Arthas 对照 | `memory`/`dashboard` 输出 | commands/arthas-memory.txt | 09/33 |

### B4 篇 4 — JIT/字节码(javap/JITWatch/LogCompilation)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B4.1 | javap 全量 | `javap -c -p` + `javap -v`(Demo/ArrayList.grow) | commands/javap-<class>.txt ×2 | 44/07/08 |
| B4.2 | LogCompilation | busy demo + `-XX:+LogCompilation` 跑 2 分钟 | logs/hotspot.log + 文本分析(compile/inline 条目) | 13 |
| B4.3 | CompilerInlining 触发 | 从 B4.2 日志提取 inline 决策 + JFR CompilerInlining 事件 | commands/jit-inlining.txt | 15 |
| B4.4 | JITWatch 导入 | A1 启动已验证;hotspot.log 文本分析(B4.2/3)为本环境产出;Compilations/Inlining 截图→附录 G4 | screenshots/04-jitwatch-*.png ×2 | 13/15/16 |
| B4.5 | Arthas 对照 | `trace` 输出(字节码插桩视角) | commands/arthas-trace.txt | 28/47 |

### B5 篇 5 — SA(jhsdb)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B5.1 | hsdb 对象头 | clhsdb `inspect` 文本(B5.3 覆盖)为本环境产出;hsdb GUI Inspect(mark word/klass)→附录 G5 | screenshots/05-hsdb-inspect.png | 06/46 |
| B5.2 | hsdb 堆/类/栈 | clhsdb 文本覆盖;GUI 三视图(Object Histogram/Heap/线程栈)→附录 G6 | screenshots/05-hsdb-*.png ×3 | 09/07/24 |
| B5.3 | clhsdb 命令 | `universe`/`inspect <addr>`/`class <name>` | commands/clhsdb-*.txt ×3 | 09/06 |
| B5.4 | jsnap 全量 | `jhsdb jsnap --all --pid` 完整输出 | commands/jsnap-all.txt(含 sun.rt._sync_*) | 38/19 |
| B5.5 | SA 三件套对照 | jhsdb jmap/jstack/jinfo vs jmap/jstack/jcmd | commands/jhsdb-vs-jdk.txt | 46/03 |

### B6 篇 6 — JMX/火焰图(jconsole/perf/FlameGraph)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B6.1 | jconsole 六面板 | jconsole 无 CLI,本环境跳过;Memory/MBeans 截图→附录 G7 | screenshots/06-jconsole-*.png ×2(MBeans+Memory) | 33 |
| B6.2 | MBean 树全量 | 导出 Threading/Memory/GarbageCollector 属性 | commands/jconsole-mbean.txt | 33 |
| B6.3 | perf 全链路 | `perf record -g` → `perf script` → stackcollapse → flamegraph.html | **✅ 已由 A8 完成(2026-08-11)**: perf.data/stacks/folded/perf-flamegraph.html 已归档——不再重复执行 | 18/32 |
| B6.4 | JMC MBean 浏览器对照 | A5 已导 26 MBean 文本树;GUI 截图→附录 G8 | screenshots/06-jmc-mbean.png | 33 |
| B6.5 | Arthas 对照 | `dashboard`/`jvm` 输出 | commands/arthas-jvm.txt | 33 |

### B7 篇 7 — 模块/镜像(jimage/jlink/jdeps)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B7.1 | jimage 三连 | `list/info/extract`(java.base 样例) | commands/jimage-*.txt ×3 | 41 |
| B7.2 | jlink 最小运行时 | 文本为主(命令+运行时大小对比);运行截图可选(终端 `./bin/java -version` 输出即可) | commands/jlink.txt(+可选 screenshots/07-jlink.png) | 41/40 |
| B7.3 | jdeps/jdeprscan | 对 math-game.jar 分析 | commands/jdeps.txt + commands/jdeprscan.txt | 07/48 |
| B7.4 | java --list-modules 对照 | 运行期 vs 镜像期 | commands/java-list-modules.txt | 40/41 |

---

## 附录 G — GUI 任务手册(本环境无显示器降级,由用户于 Ubuntu 桌面手工执行)

> 本环境(容器/Xvfb)无法高效操作 GUI,以下 8 项改为**用户在 Ubuntu 桌面上手工执行**;产出截图按 `NN-tool-topic.png` 命名归档到 `materials/screenshots/`,并在 INDEX.md 登记。
> **通用前置**: ① JDK 17+(JMC 实测 17 会 UnsupportedClassVersionError,建议 JDK 21 LTS,并把 `jmc.ini` 的 `-vm` 指向该 JDK);② 中文字体 `sudo apt install fonts-noto-cjk`;③ Wayland 下 Swing 窗口异常 → 登录会话选 "Ubuntu on Xorg",或 `export _JAVA_AWT_WM_NONREPARENTING=1`;④ 所有工具均为 Java Swing 程序,桌面环境直接启动即可,无需任何 Xvfb/Robot 技巧。
> **采样目标**: 复用 `/data/tmp/opencode/Demo.java`(CPU+分配+多线程,600s 寿命)或自建简单多线程 demo。

### G1 B1.1-JMC 录制向导(截图 ×1)
- **干什么**: 展示 JFR 第三种开启方式——JMC GUI 向导(前两种 `-XX:StartFlightRecording` / `jcmd JFR.start` 为文本任务,本环境已完成)。
- **操作**:
  1. `jcmd <pid> ManagementAgent.start_local` 启动 JMX 代理 → 打开 JMC → 左侧 JVM Browser 双击目标 JVM(或 File→Connect 输入 `host:7091`)
  2. 右键该 JVM → **Start Flight Recording…**(录制向导)
  3. 向导页: 选配置模板(Continuous/Profiling)→ 时长(如 30s)→ 录制文件名 → Finish
  4. 录制结束右键 → **Save to file**;在向导弹出时截图
- **产出**: `materials/screenshots/01-jmc-wizard.png`

### G2 B1.6-JMC 实时控制台(截图 ×1)
- **干什么**: 展示 JMC 连接运行中 JVM 的实时监控(CPU/堆/线程/GC 曲线),域 33 JMX 素材(数据面 A4 已验证)。
- **操作**:
  1. 目标 JVM 启动参数: `-Dcom.sun.management.jmxremote -Dcom.sun.management.jmxremote.port=7091 -Dcom.sun.management.jmxremote.authenticate=false -Dcom.sun.management.jmxremote.ssl=false`(仅本机调试可只 `jcmd <pid> ManagementAgent.start_local`)
  2. JMC → JVM Browser 双击进程(本地自动发现);远程 File → Connect 输入 `host:7091`
  3. 自动打开实时 **Overview** 页签,待 CPU/堆曲线动起来后截图
- **产出**: `materials/screenshots/01-jmc-console.png`

### G3 B3.2-MAT 四视图(截图 ×4)
- **干什么**: 展示 MAT 核心四视图,域 37/06。文本版可先在终端跑 headless: `$MAT_HOME/ParseHeapDump.sh heap.hprof org.eclipse.mat.api:suspects org.eclipse.mat.api:top_components` 出报告。
- **操作**:
  1. 拿 heap dump: `jcmd <pid> GC.heap_dump /path/heap.hprof`(或 `jmap -dump:format=b,file=heap.hprof <pid>`)
  2. 启动 MAT: `$MAT_HOME/MemoryAnalyzer`(JDK 17+;新版需 21)
  3. File → Open Heap Dump → 选 heap.hprof
  4. 依次打开并截图: ① **Overview**(初始概览+内存报表向导)② **Histogram**(类 × 对象数 × Shallow Heap/Retained Heap)③ **Dominator Tree**(支配树,最大保留对象链)④ **Leak Suspects Report**(一键泄漏嫌疑报告)
- **产出**: `materials/screenshots/03-mat-overview.png` / `03-mat-histogram.png` / `03-mat-dominator.png` / `03-mat-leak.png`

### G4 B4.4-JITWatch 导入(截图 ×2)
- **干什么**: 可视化 JIT 产物: Compilations 页(编译列表)+ Inlining 页(inline 决策),域 13/15/16。
- **操作**:
  1. 生成日志: 目标程序加 `-XX:+UnlockDiagnosticVMOptions -XX:+LogCompilation` 跑 1-2 分钟 → 得到 hotspot.log
  2. 启动: `java -jar jitwatch-ui.jar`(JDK 17+;桌面有 GPU 原生渲染,本环境是软件渲染)
  3. **必须先配 Sandbox**: Config → Sandbox → 选 JDK 目录,否则编译视图为空
  4. 点 **Open Log** 选 hotspot.log → 解析完成后 View → Compilations 截图、View → Inlining 截图
- **产出**: `materials/screenshots/04-jitwatch-compilations.png` / `04-jitwatch-inlining.png`

### G5 B5.1-hsdb 对象头 Inspect(截图 ×1)
- **干什么**: SA 可视化查看堆对象布局: mark word/klass 指针/字段值,域 06/46(对象头是本书重要章节素材)。
- **操作**:
  1. 目标进程运行中: `jhsdb hsdb --pid <pid>`(JDK9+;分析崩溃转储用 `--core <core> --exe <java>`)
  2. 菜单 **Tools → Object Histogram** → 找 Demo 的类(如 `Demo$BusyTask`)→ 双击某个对象 → 弹出 **Inspect** 窗口: `_mark`(8 字节 mark word,含锁状态/年龄/hash)、`_klass`(类型指针)、各字段值
  3. 截图 Inspect 窗口
- **产出**: `materials/screenshots/05-hsdb-inspect.png`

### G6 B5.2-hsdb 堆/类/栈(截图 ×3)
- **干什么**: hsdb 三视图: Object Histogram(对象统计)/ 堆分区浏览 / 线程栈,域 09/07/24(文本版已由 clhsdb B5.3 覆盖)。
- **操作**:
  1. `jhsdb hsdb --pid <pid>`
  2. Tools → **Object Histogram** 截图(类级对象统计)
  3. Windows → Console 输入 `universe` 查看堆分区(Eden/Survivor/Old/新老代边界)截图
  4. Tools → **Threads** 截图(线程栈列表)
- **产出**: `materials/screenshots/05-hsdb-histogram.png` / `05-hsdb-universe.png` / `05-hsdb-threads.png`

### G7 B6.1-jconsole 六面板(截图 ×2)
- **干什么**: JDK 自带经典监控工具,域 33(数据面 MBean 树 26 个已归档在 INDEX.md)。
- **操作**:
  1. 目标 JVM 开 JMX(同 G2)或本机直接 `jconsole <pid>`(本地进程会自动列出)
  2. 截图 **Memory** 页签(堆/非堆曲线)+ **MBeans** 页签(树: 展开 java.lang:Memory / Threading / GarbageCollector)各一张;Overview/Threads/Classes/VM Summary 按需补
- **产出**: `materials/screenshots/06-jconsole-memory.png` / `06-jconsole-mbean.png`

### G8 B6.4-JMC MBean 浏览器(截图 ×1)
- **干什么**: JMC 的 MBean Browser 与 jconsole 对照,域 33(A5 已导 26 个 MBean 文本树,此截图仅作书内对照图)。
- **操作**:
  1. JMC 连接目标 JVM(同 G2)
  2. **Window → Show View → MBean Browser**(或右键 JVM → MBean Browser)
  3. 展开 `java.lang:Memory / Threading / GarbageCollector` 等节点,截图
- **产出**: `materials/screenshots/06-jmc-mbean.png`

> B7.2 jlink 的截图可选: 主要产出是文本(命令 + 运行时大小对比);若想配图,`./bin/java -version` 终端输出截图即可,无需 GUI。

---

## 五、C 组 — 就绪度闭环

| # | 任务 | 方法 |
|---|---|---|
| C1 | 43 域逐域核对 | 按 KP 09 表,每域确认 ✅/🟡/🔴/✗,🟡→✅ 才算完 |
| C2 | ✗ 域确认 | 05/29/30/31/45 五域复核"无工具途径"结论(引用 REVIEW v1/v2) |
| C3 | INDEX.md 全量 | materials/INDEX.md 按域索引所有素材文件,供写作检索 |

---

## 六、D 组 — 归档与交接

| # | 任务 | 产出 |
|---|---|---|
| D1 | KP 09 就绪度表更新 | 43 域全绿(或标注剩余 🔴 及原因) |
| D2 | HANDOFF 更新 | 实操状态 + 素材位置 + 遗留项 |
| D3 | 写作入口确认 | 阶段 A(32-jfr → 28-jvmti → 24-frame → 18-safepoint → 36-attach)素材齐备检查 |

---

## 七、完成定义(DoD)与纪律

**每个任务 DoD**: 产出文件存在 + 域标注正确 + INDEX.md 有登记 + 无"待确认"标记。

**纪律**(深审档案):
1. 一次只做一个任务 → 自查 → 合格 → 下一项
2. 工具输出必须实测,不许凭记忆写命令(#6)
3. 素材标注: 工具/命令/输出/对应域 四要素
4. 截图命名规范 `NN-tool-topic.png`,命令输出 `tool-command.txt`
5. 引用行号/文件名必须 grep 验证(#2 文字锚)

---

## 八、风险与回退

| 风险 | 回退 |
|---|---|
| perf 无权限(容器) | 记录结论,perf 视角改用 async-profiler 顶替(内核面缺失标注) |
| JITWatch/hsdis 依赖缺失 | 用 LogCompilation 文本分析兜底(篇 4 已备) |
| JMC 页签打开超时(113MB 录制) | 用小录制(rec.jfr)或按时间范围加载 |
| 部分事件未触发(默认配置关闭) | `-XX:StartFlightRecording:settings=profile` 或 `jfr configure` 开事件;标注"JDK17 默认关闭" |
| jfrsync 值误传非配置(报 NoSuchFileException) | 已解决: 值必须为 JFR 配置路径/名(ap21-sync.jfr 实证) |

---

## 九、执行顺序总览

```
A(8 项,半天)→ B1→B2→B3→B4→B5→B6→B7(每篇 1-2 小时)→ C(半天)→ D(半天)
总计: 3-4 天(每任务产出即入库,随时可中断恢复)
```
