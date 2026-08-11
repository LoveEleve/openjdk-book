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
| A1 | JITWatch 启动 | ✅ 已验: JDK21 + Xvfb 界面渲染(a1-jitwatch.png),GLX 回退软件渲染 | 窗口出现,可导入 hotspot.log | 篇 4 |
| A2 | GCViewer 启动 | ✅ 已验: 打开 13MB gc.log 图表渲染(a2-gcviewer.png) | 图表渲染 | 篇 3 |
| A3 | VisualVM 启动 | ✅ 已验: --jdkhome 指定 JDK21,界面渲染(a3-visualvm.png) | 窗口 + 本地 JVM 列表 | 篇 3/6 |
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
| B1.1 | 三种触发方式 | jcmd JFR.start / JMC 向导 / `-XX:StartFlightRecording` | 截图 ×3 → screenshots | 32 |
| B1.2 | 90 类事件按域归档 | `jfr print --events <e> rec-demo.jfr` 按 KP05 索引抽取代表事件 | commands/jfr-events-<域>.txt ×30 | 全部 |
| B1.3 | **-Xint 解释器实证** | `java -Xint Demo` + 录 JFR | commands/jfr-xint-executionsample.txt(state=INTERPRETED) | 08 |
| B1.4 | 关键页签截图 | JMC 打开 rec-demo.jfr,截 Overview/Threads/LockInstances/VMOperation/Tlab/Event Browser/Flame Graph/GC | screenshots/01-jmc-*.png ×8 | 25/17/19/20/09/32 |
| B1.5 | Automated Analysis | JMC 自动分析页截图(74 规则实际触发) | screenshots/01-jmc-automatedanalysis.png | 32 |
| B1.6 | 实时连接+控制台 | A4 复用,截图 | screenshots/01-jmc-console.png | 33 |
| B1.7 | AP 两种写者对照 | A7 产物,对比 JDK JFR 事件集差异(**v4 更新: 标注 jfrsync 该 .so 构建缺陷,写作用"独立 JFR 输出实证"(ap-target.jfr)**) | commands/ap-jfr-events.txt(AP 事件清单) | 32 |
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
| B3.2 | MAT 四板斧 | 命令行 + GUI: Overview/Histogram/Dominator/Leak Suspects | screenshots/03-mat-*.png + commands/mat-leak.txt | 37/06 |
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
| B4.4 | JITWatch 导入 | A1 复用,hotspot.log → Compilations/Inlining 页截图 | screenshots/04-jitwatch-*.png ×2 | 13/15/16 |
| B4.5 | Arthas 对照 | `trace` 输出(字节码插桩视角) | commands/arthas-trace.txt | 28/47 |

### B5 篇 5 — SA(jhsdb)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B5.1 | hsdb 对象头 | `jhsdb hsdb --pid` GUI → 找 Demo 对象 Inspect(mark word/klass) | screenshots/05-hsdb-inspect.png | 06/46 |
| B5.2 | hsdb 堆/类/栈 | Object Histogram / Heap 浏览 / 线程栈 | screenshots/05-hsdb-*.png ×3 | 09/07/24 |
| B5.3 | clhsdb 命令 | `universe`/`inspect <addr>`/`class <name>` | commands/clhsdb-*.txt ×3 | 09/06 |
| B5.4 | jsnap 全量 | `jhsdb jsnap --all --pid` 完整输出 | commands/jsnap-all.txt(含 sun.rt._sync_*) | 38/19 |
| B5.5 | SA 三件套对照 | jhsdb jmap/jstack/jinfo vs jmap/jstack/jcmd | commands/jhsdb-vs-jdk.txt | 46/03 |

### B6 篇 6 — JMX/火焰图(jconsole/perf/FlameGraph)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B6.1 | jconsole 六面板 | `jconsole <pid>` → Overview/Memory/Threads/Classes/MBeans/VM | screenshots/06-jconsole-*.png ×2(MBeans+Memory) | 33 |
| B6.2 | MBean 树全量 | 导出 Threading/Memory/GarbageCollector 属性 | commands/jconsole-mbean.txt | 33 |
| B6.3 | perf 全链路 | `perf record -g` → `perf script` → stackcollapse → flamegraph.html | logs/perf.data + screenshots/06-flamegraph.png | 18/32 |
| B6.4 | JMC MBean 浏览器对照 | A5 复用 | screenshots/06-jmc-mbean.png | 33 |
| B6.5 | Arthas 对照 | `dashboard`/`jvm` 输出 | commands/arthas-jvm.txt | 33 |

### B7 篇 7 — 模块/镜像(jimage/jlink/jdeps)

| # | 任务 | 命令/操作 | 产出 → 归档 | 对应域 |
|---|---|---|---|---|
| B7.1 | jimage 三连 | `list/info/extract`(java.base 样例) | commands/jimage-*.txt ×3 | 41 |
| B7.2 | jlink 最小运行时 | `--add-modules java.base,java.logging` + 大小对比 | commands/jlink.txt + screenshots/07-jlink.png | 41/40 |
| B7.3 | jdeps/jdeprscan | 对 math-game.jar 分析 | commands/jdeps.txt + commands/jdeprscan.txt | 07/48 |
| B7.4 | java --list-modules 对照 | 运行期 vs 镜像期 | commands/java-list-modules.txt | 40/41 |

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
