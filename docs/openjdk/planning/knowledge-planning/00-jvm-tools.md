# 域 00: JVM 工具层 — 知识规划(探索前置域)

> 性质: 🟢 工具探索域(非源码分析)——先用工具"看见" JVM 内部,为 01-48 域文章写作积累实证素材
> 定位: openjdk-book 的 48 个实现域之前的前置域——"先工具,后文章"(方法论场景驱动)
> 工具来源: JDK bin/(本机 TencentKona JDK 17 已装)+ JMC/JITWatch/MAT 等生态工具
> 提取日期: 2026-08-10 | **v2 修订: 2026-08-11(实测校准)** | **v3 修订: 2026-08-11(48 域覆盖矩阵全量核对,见 `00-jvm-tools-review.md`)** | **v4 修订: 2026-08-11(JFR 事件契约级,见 `00-jvm-tools-review-v2.md`)** | **v5 修订: 2026-08-11(字段级+工具侧对照+素材就绪度,见 `00-jvm-tools-review-v3.md`)** | **v6 修订: 2026-08-11(配置契约+AP 实测,见 `00-jvm-tools-review-v4.md`)**
> 产出: 工具清单 + 探索任务,每任务关联 1-N 个实现域
>
> **v6 修订要点**(2026-08-11):
> 1. **配置契约层**(10 节): default 82/profile 83 事件开启;threshold 差异决定素材量(SafepointBegin default 10ms vs profile 0ms 等)——采集策略: 写精细事件文章必须 settings=profile
> 2. **async-profiler 4.4 实测**: **独立 JFR 输出打通**(`ap-target.jfr`,ExecutionSample 6282 条,已被 jfr CLI 解析)——"两种写者"实证达成;jfrsync 模式打通: jfrsync=<jfc 路径> 一个文件两种来源(ap21-sync.jfr)
> 3. **素材新增**: merged.jfr(161MB)/merged2.jfr(127MB)/ap-flame.html/ap-target.jfr 入库
>
> **v5 修订要点**(2026-08-11):
> 1. **素材目录规范**: `outlines/00-jvm-tools/materials/` = screenshots/(截图)+ commands/(命令输出)+ jfr-recordings/(录制/堆转储,rec-demo.jfr/probe.jfr/heap.hprof 已入库)
> 2. **三张"命令→域"表并列**(07 节): JMC 29 页签 / jcmd 50 子命令 / Arthas 命令映射
> 3. **async-profiler JFR 输出对照**(08 节): AP 写 15 个 JDK 事件+自定义 MethodTrace = JDK 170 事件的子集——"两种写者"格式兼容实证
> 4. **43 域素材就绪度表**(09 节): ✅17 域就绪 / 🟡半就绪 / 🔴空——实操按表补缺
> 5. **事件字段级契约**(抽查 5 个): SafepointBegin.duration/GCPhasePause.GCId/Compilation.compileId/ExecutionSample.state/JavaMonitorEnter.monitorClass——写作引用字段名
>
> **v4 修订要点**(2026-08-11,JFR 事件契约级核对):
> 1. **新增"170 JFR 事件 × 48 域"索引表**(见 05 节)——写作素材的最细粒度检索入口: 写哪个域,查哪个事件
> 2. **新增 JMC 自动分析规则清单(74 条)**(见 06 节)——"Automated Analysis"黑盒打开,规则→事件→域链条
> 3. **域 29 MethodHandles 修正**: 证实无 JFR 事件(170 中无 MethodHandle*)——域 29 降为 ✗ 无事件面
> 4. **8 个新事件素材入口**: CompilerInlining(域15)、BiasedLock*×3(域19)、OldObjectSample(域37)、ExecuteVMOperation(域20)、Safepoint*×5(域18)、Container*(域01)
> 5. **域 08 确认**: ExecutionSample.state 字段实证(可区分解释/编译)
> 6. **写作素材预标注**: SafepointBegin 2710 条/ExecuteVMOperation 2709 条/GCPhaseParallel 229万条(rec-demo.jfr 实测,可直接引用)
>
> **v3 修订要点**(2026-08-11,依据 `00-jvm-tools-review.md` 全量核对):
> 1. **工具 15→19**: 补 jimage/jlink(域 41)、jdeps/jdeprscan(域 07/48)、jmod——均实测存在
> 2. **JMC 29 页签映射**: 规划"六面板"实为 29 个分析页签(插件实证),12 个页签直接对应写作域(LockInstances→19、VMOperation→20、Tlab→09、MemoryLeak→37 等),详见 01 表 JMC 行
> 3. **关联域 18→43**(30 直接 + 13 间接): 新增 20-vm-operations、22-deoptimization、38-perfdata、41-zip-jimage、04-logging、43-nio-net 等
> 4. **补 jcmd 子命令**: VM.events(域 20)、VM.log(域 04)、VM.cds(域 11)、VM.metaspace(域 10)——实测 50 子命令
> 5. **补 jsnap**: `jhsdb jsnap --all` 直接读 PerfData 计数器(域 38,实测含 sun.rt._sync_* 锁计数=域 19 实证)
> 6. **无直接观测工具域(5 个)**: 05-cpu-primitives、29-method-handles、30-jvm-entry-points、31-unsafe、45-math——走源码分析
> 7. **生态工具状态更新**: MAT/JITWatch/VisualVM/GCViewer/perf/FlameGraph 均已下载安装 ✅
>
> **v2 修订要点**(2026-08-11 实测后校准):
> 1. **补 `jfr` CLI**(JDK 11+ 自带): 无头环境素材提取主力,已实测提取 90 类事件/热点方法/GC 时序
> 2. **JMC 功能补全**: 除时间线外还有自带火焰图/热力图/依赖视图/MBean 浏览器/JOverflow 泄漏分析/实时连接
> 3. **jfr2flame 事实修正**: 交接文档声称"async-profiler jfr2flame ✅(Arthas 仓库 converter)"——Arthas 仓库嵌入的 async-profiler **仅含 3 个 .so,未带 converter.jar/profiler.sh**(async-profiler 官方 release 才有 converter)。对照工具改为 JMC 自带 Flame Graph 视图 + async-profiler 原生 JFR 输出

## 01 逐源提取 (工具 → 用途 → 关联域)

> 状态列: ✅ = 2026-08-11 本机实测存在(含安装完成)| 🔲 = 规划中(本机未装,实操前需下载/安装)

| Source (工具) | 状态 | Inferred Usage (用途) | 关联实现域 |
|------------|:--:|-------------------|------------|
| jcmd(JDK bin/) | ✅ | **万能诊断入口**: `jcmd <pid> help` 列全部子命令(实测 50 个);`JFR.start/dump`(录制)、`VM.flags`(标志)、`GC.heap_info`(堆)、`GC.class_histogram`(类直方图)、`Thread.print`(线程栈)、`Compiler.codecache/codelist`(JIT 代码缓存)、`VM.class_hierarchy`(继承树)、`GC.heap_dump`、**`VM.events`(编译/VM 操作事件)、`VM.log`(Logging 配置)、`VM.cds`、`VM.metaspace`、`VM.native_memory`(NMT)** | 35-dcmd、03-flags、25-gc、32-jfr、20-vm-ops、04-logging、11-cds、10-metaspace、34-nmt |
| jfr(JDK bin/) | ✅ | **JFR 文件 CLI 解析**: `jfr summary`(事件类型/计数)、`jfr print --events`(按事件过滤输出)、`jfr metadata`(事件元数据)、`jfr configure`(生成 .jfc)——无头环境素材提取主力,与 JMC 读取同一文件;可提取 **jdk.Deoptimization(域 22)/jdk.SafepointBegin(域 18)/G1*(域 26)** 等事件(实测 875 条 Deopt) | 32-jfr、22-deopt、18-safepoint、26-g1 |
| JMC + JFR(生态) | ✅ | **录制+可视化**: **29 个分析页签**(插件实证,见下方映射表)——GC/堆/TLAB/线程/锁实例/VM 操作/编译/代码缓存/IO/类加载/异常/内存泄漏/方法热点/事件浏览器/自动分析 + **火焰图/热力图/依赖视图**;另有实时连接控制台(CPU/堆/线程曲线)+ MBean 浏览器 + JOverflow + JMX 告警;与 async-profiler 的 JFR 输出对照 | 32-jfr、25-gc、26-g1、09-memory、10-metaspace、17-threads、19-sync、20-vm-ops、13-jit、16-code-cache、37-heap-dumper、07-classfile、43-nio-net、33-jmx、06-oops、11-cds |
| jstat(JDK) | ✅ | **统计监视**: `-gcutil`(各代使用率)、`-compiler`(JIT 编译统计)、`-class`(类加载)、`-gcnew/-gcold`(分代明细)——底层读 PerfData(域 38) | 25-gc、13-jit、38-perfdata |
| jmap(JDK) | ✅ | **堆转储**: `-histo`(对象直方图)、`-dump`(hprof 文件)、`-clstats`(类加载器统计)、`-finalizerinfo` | 37-heap-dumper、06-oops、07-classfile |
| jhsdb(JDK) | ✅ | **SA 套件**: `hsdb`(GUI: 堆/栈/对象布局)、`clhsdb`(命令行)、`jmap/jstack/jinfo`(SA 版)、**`jsnap --all`(PerfData 计数器,实测含 sun.rt._sync_* 锁计数=域 19 实证)**——**直接看 JVM 内部数据结构**(Klass/对象头) | 46-sa-postmortem、06-oops、09-memory、38-perfdata、19-sync、03-flags |
| jstack(JDK) | ✅ | **线程栈**: 与 Arthas `thread`/async-profiler 火焰图对照(三种视图) | 17-threads、24-frame |
| jimage(JDK bin/) | ✅ | **模块镜像查看**: `jimage list modules`(实测列出 java.base 内容)、`jimage extract` | 41-zip-jimage、07-classfile |
| jlink(JDK bin/) | ✅ | **自定义运行时组装**: `jlink --add-modules`(裁剪 JDK 镜像) | 41-zip-jimage、40-launcher |
| jdeps/jdeprscan(JDK bin/) | ✅ | **模块依赖分析**: `jdeps`(包/模块依赖图)、`jdeprscan`(废弃 API 扫描) | 07-classfile、48-utilities |
| JITWatch(生态) | ✅ 已装 | **JIT 可视化**: 编译/内联/去优化日志(LogCompilation);与 async-profiler `[inlined]` 帧互相印证(`/opt/tools/jitwatch-ui.jar`) | 13-jit、14-c1、15-c2、22-deopt |
| javap(JDK) | ✅ | **字节码反汇编**: `-c/-v` 看指令/常量池/StackMapTable——BytecodeRewriter 改写对象的实证 | 44-verification、08-interpreter |
| MAT(生态) | ✅ 已装 | **堆分析**: 支配树/泄漏嫌疑/直方图——.hprof 主分析器(`/opt/tools/MAT/`,命令行实测跑通) | 37-heap-dumper、06-oops |
| VisualVM(生态) | ✅ 已装 | **轻量可视**: 堆/CPU/线程 + 插件(与 Arthas dashboard 对照)(`/opt/tools/visualvm_2110/`) | 33-jmx、25-gc |
| GCeasy/GCViewer(生态) | ✅ 已装 | **gc.log 解析**: 停顿/吞吐统计(`gcviewer-1.37.jar`) | 25-gc、26-g1 |
| jconsole(JDK) | ✅ | **JMX 浏览**: MBean 树/属性——与 Arthas `jvm`/dashboard 的 MXBean 对照(JMC 自带 MBean 浏览器可替代) | 33-jmx |
| FlameGraph 脚本(生态) | ✅ 已装 | **火焰图生成原理**: stackcollapse+flamegraph 脚本——理解聚合语义(`/opt/tools/FlameGraph/`) | 32-jfr |
| perf(系统) | ✅ 已装 | **内核采样**: async-profiler 底层——直接看内核视角的采样(yum 已装 6.6.119) | 18-safepoint、01-os、42-core-native |

*19 个知识点(工具,15 → v3 补 jimage/jlink/jdeps/jdeprscan/jmod)*

### JMC 29 分析页签 → JVM 域映射(v3 新增,插件盘点实证)

| 页签 | 内容 | 对应域 |
|---|---|---|
| ThreadsPage | 线程状态时间线 | 17 |
| ThreadDumpsPage | 线程转储聚合 | 17、24 |
| LockInstancesPage | 锁实例持有/等待 | **19** |
| VMOperationPage | VM 操作(GC 外 STW) | **20** |
| TlabPage | TLAB 分配统计 | 09、25 |
| MemoryLeakPage | 泄漏分析(OldObjectSample) | 37 |
| HeapPage | 堆使用 | 09、25 |
| GarbageCollectionsPage/GCSummaryPage/GCConfigurationPage | GC 事件/摘要/配置 | 25、26 |
| CompilationsPage/CodeCachePage | 编译/代码缓存 | 13、16 |
| MethodProfilingPage | 方法热点(解释/编译区分) | 32、08、24 |
| ExceptionsPage | 异常统计 | 17、21 |
| ClassLoadingPage | 类加载 | 07 |
| EventBrowserPage | 全事件流 | 32 |
| FileIOPage/SocketIOPage | IO | **43** |
| NativeLibraryPage/AgentsPage | 原生库/JVMTI agent | 27、28、47 |
| ConstantPoolsPage/DistinctItemsPage | 事件常量池/去重 | 32、07 |
| ProcessesPage | 进程信息 | 36、48 |
| RecordingPage/JVMInformationPage/JavaApplicationPage/SystemPage | 录制/JVM/应用/系统信息 | 32、48、01 |
| EnvironmentVariablesPage/SystemPropertiesPage | 环境变量/系统属性 | 03 |

---

## 02 聚合 — 按"探索 JVM 的哪个内部"分组

### P1 — 探索主线(5 组核心 + v3 新增 2 组)

| 组 | 工具 | 探索目标(JVM 内部) | 关联域 |
|----|------|------|------|
| 时间维度 | JMC/JFR、jcmd JFR、jfr CLI | 事件流/GC/分配的时间线(CLI 可无头提取) | 32 |
| 命令维度 | jcmd、jps、jstat | 诊断命令框架 | 35、03、25 |
| 空间维度 | jmap、MAT、VisualVM、GCeasy | 堆结构/对象布局 | 37、06、25 |
| 代码维度 | JITWatch、javap | JIT 编译/字节码 | 13-15、44 |
| 内部维度 | jhsdb、jconsole | SA 数据结构/JMX | 46、33 |
| **锁与 STW 维度(v3)** | JMC LockInstancesPage/VMOperationPage、jsnap | 锁实例/VM 操作(域 19/20 现成素材) | 19、20 |
| **模块与镜像维度(v3)** | jimage、jlink、jdeps | 模块镜像/依赖图(域 41/07) | 41、07 |

### P2 — 对照验证组

| 对照 | 工具对 | 目的 |
|----|------|------|
| 线程三视图 | jstack / Arthas thread / async-profiler 火焰图 | 同一天线程三种呈现 |
| JFR 双读者 | JMC / jfr CLI(JMC 桌面版读取)+ async-profiler JFR 输出 | 同一格式多个解析器(注: Arthas 仓库未带 jfr2flame converter.jar,官方 release 才有;本机用 JMC 自带 Flame Graph 视图对照) |
| 采样双引擎 | perf / async-profiler | 内核 vs 用户态 |
| MXBean 双消费 | jconsole / Arthas dashboard(JMC 自带 MBean 浏览器为第三消费方) | 同一 JMX 多个消费方 |
| **锁观察两层(v3)** | jsnap sun.rt._sync_* / async-profiler lockTracer / Arthas thread -b | PerfData 计数 vs 采样 vs 命令(域 19) |
| **VM 操作三来源(v3)** | jcmd VM.events / JMC VMOperationPage / JFR ExecuteVMOperation | 同一 VM 操作三种视图(域 20) |

### P3 — 支撑

| 工具 | 说明 |
|----|------|
| jps/jstatd | 进程发现/远程统计 |
| jdb/jshell | 调试/REPL(按需) |
| jmod/jdeprscan | 模块打包/废弃 API 扫描(v3) |

---

## 03 深度分类 (探索价值)

### 🔴 必探索 (与写作阶段 A 对齐)

| 工具 | 为什么 |
|------|------|
| JMC/JFR | 域 32 写作的第一手素材——先录再看再写;**29 页签=19 个域素材入口** |
| jcmd | 域 35 写作入口;万能命令(50 子命令);VM.events 覆盖域 20 |
| jhsdb | 域 46 实证——直接"看"对象/堆;jsnap 覆盖域 38/19 |
| JITWatch | 域 13-15 实证——编译/内联可视化 |
| **jimage/jlink(v3)** | 域 41 唯一工具素材——模块镜像结构实证 |

### 🟡 常用

| 工具 | 为什么 |
|------|------|
| jmap | 堆转储/直方图(域 37/06) |
| MAT | 堆分析:支配树/泄漏嫌疑(域 37/06) |
| jstack | 线程栈——与 Arthas thread/火焰图三视图对照(域 17/24) |
| jstat | GC 统计快照(域 25;底层=PerfData 域 38) |
| jconsole | JMX 实证(域 33) |
| javap | 字节码实证(域 44) |
| jdeps(v3) | 模块依赖实证(域 07/48) |

### 🟢 了解

| 工具 | 说明 |
|----|------|
| GCeasy/GCViewer | gc.log 解析(域 25/26) |
| VisualVM | 轻量可视化(域 33/25) |
| FlameGraph 脚本 | 聚合原理 |
| perf | 内核层(与 async-profiler 重复) |

### ✗ 无直接观测工具的域(v3 新增)

> 05-cpu-primitives、29-method-handles、30-jvm-entry-points、31-unsafe、45-math——工具层无法直接"看见",写作走源码分析(详见 `00-jvm-tools-review.md` 矩阵)

---

## 04 聚类 — 探索顺序与文章拆分

> 探索主线: 从"黑盒录制"到"白盒查看"——JFR 全貌 → 命令入口 → 堆/内存 → JIT/字节码 → SA 内部 → 模块/镜像。

### 依赖图

```
01 JMC/JFR                    ← 无前置(最直观入口;jfr CLI 同步提取素材)
  ├─ 02 jcmd                  ← 依赖 01 (命令行录 JFR)
  ├─ 03 堆/内存工具            ← 依赖 01 (JFR 有堆概览)
  ├─ 04 JIT/字节码工具         ← 无前置
  ├─ 05 SA 工具(jhsdb)        ← 依赖 01-03 (先看全景再钻内部)
  ├─ 06 JMX/对照              ← 依赖 02 (jcmd 启 JMX)
  └─ 07 模块/镜像工具(v3)     ← 无前置
```

### 教学顺序

```
01 JMC/JFR 录制可视化(先看全景;jfr CLI 无头提取)
  → 02 jcmd 万能命令(命令行入口)
    → 03 jmap/MAT 堆分析(空间维度)
      → 04 JITWatch/javap(代码维度)
        → 05 jhsdb SA(内部维度,最深)
          → 06 jconsole JMX + 对照总结
            → 07 jimage/jlink(模块维度,收尾)
```

### 文章拆分 (7 篇大纲, v3 新增篇 7)

| # | 大纲文件 | 主题 | 覆盖工具 | 关联域 |
|:--:|------|------|------|------|
| 1 | 01-jfr-jmc.md | JFR 录制与 JMC 可视化(29 页签) | JMC/JFR/jcmd JFR/jfr CLI | 32、25、26、17、19、20、09、13、16、43、37 |
| 2 | 02-jcmd.md | jcmd 万能诊断命令(50 子命令) | jcmd/jps/jstat | 35、03、25、20、04、10、11、34 |
| 3 | 03-memory-tools.md | 堆分析与对象 | jmap/MAT/VisualVM/GCeasy/JOverflow | 37、06、25 |
| 4 | 04-jit-bytecode-tools.md | JIT 与字节码查看 | JITWatch/javap | 13-15、44 |
| 5 | 05-sa-tools.md | SA 内部查看(含 jsnap) | jhsdb(hsdb/clhsdb/jsnap) | 46、06、09、38、19 |
| 6 | 06-jmx-flamegraph.md | JMX 与火焰图对照 | jconsole/JMC MBean 浏览器/FlameGraph/perf | 33、18、32 |
| 7 | 07-module-image-tools.md | 模块与镜像工具(v3 新增) | jimage/jlink/jdeps/jdeprscan | 41、07、48 |

### 每篇固定结构 (v5 适配)

```
# NN. 悬念标题 — 工具与探索目标
> 🟢 工具域 | 工具: xxx | 关联 JVM 域: NN
> 读者处境: 一句话
### 1. "怎么用" — 命令/操作
[操作步骤 + 典型输出解读]
### 2. "看见了什么" — JVM 内部对应
[工具输出 ↔ JVM 机制映射,写文章时的素材]
### 3. "对照" — 与已学工具/实现域
[与 Arthas/async-profiler 对照;写作时如何引用]
```

### 与写作阶段的关系

| 工具域篇 | 反哺的写作域 | 素材形态 |
|:--:|------|------|
| 01-jfr-jmc | 32-jfr、19-sync、20-vm-ops、43-nio-net | 事件列表/GC 时间线实录 + LockInstances/VMOperation/Tlab 页签截图 |
| 02-jcmd | 35-dcmd、03-flags、04-logging | 子命令清单(实测 50 个)/输出样例/VM.log 配置 |
| 03-memory-tools | 37、06-oops | 直方图/支配树样例 |
| 04-jit-bytecode-tools | 13-15、44 | 内联日志/字节码样例 |
| 05-sa-tools | 46、09、38-perfdata、19-sync | 对象布局截图 + jsnap 计数器 |
| 06-jmx-flamegraph | 33、18 | MBean 树/采样对照 |
| 07-module-image(v3) | 41、07、48 | 镜像结构/依赖图样例 |

---

## 05 写作素材索引 — 170 JFR 事件 × 48 域(v4 新增,实测)

> 来源: `jfr metadata` 实测导出 170 个 jdk.* 事件(2026-08-11)
> 用法: 写某域文章时,先查本表拿事件名 → `jfr print --events jdk.<Event> rec.jfr` 取真实数据 → 引文
> ★ = rec-demo.jfr 实测有数据(可直接引用数字)

| 域 | 事件数 | 代表事件(★=实测有数据) |
|---|---|---|
| 01-OS | 13 | CPULoad★、SystemProcess★、ContainerCPUUsage★、OSInformation、CPUInformation、PhysicalMemory、VirtualizationInformation、Container*(5)、InitialEnvironmentVariable★ |
| 03-Flags | 16 | BooleanFlag★、IntFlag★、LongFlag★、StringFlag★、DoubleFlag★、Unsigned*★、*FlagChanged(7)、ActiveSetting★、InitialSystemProperty★ |
| 06-OOPs | 2 | ObjectCount、ObjectCountAfterGC |
| 07-ClassFile | 12 | ClassLoad、ClassDefine、ClassUnload、ClassLoaderStatistics★、ModuleExport★、ModuleRequire★、StringTableStatistics、SymbolTableStatistics、LoaderConstraintsTableStatistics、PlaceholderTableStatistics、ProtectionDomainCacheTableStatistics、ClassLoadingStatistics★ |
| 08-Interpreter | 1 | ExecutionSample★(state=STATE_INTERPRETED 实证) |
| 09-Memory | 6 | ObjectAllocationSample★、AllocationRequiringGC★、ThreadAllocationStatistics★(351)、ObjectAllocationInNewTLAB、ObjectAllocationOutsideTLAB、DirectBufferStatistics★ |
| 10-Metaspace | 5 | MetaspaceSummary★、MetaspaceChunkFreeListSummary★、MetaspaceAllocationFailure、MetaspaceGCThreshold、MetaspaceOOM |
| 13-JIT | 6 | Compilation、CompilerPhase、CompilerConfiguration、CompilerStatistics★、CompilationFailure、JITRestart |
| 15-C2 | 1 | CompilerInlining(v4 新增) |
| 16-CodeCache | 6 | CodeCacheStatistics★、CodeCacheConfiguration、CodeCacheFull、CodeSweeperConfiguration、CodeSweeperStatistics、SweepCodeCache |
| 17-Threads | 8 | ThreadSleep★、ThreadCPULoad★、JavaThreadStatistics★、ThreadAllocationStatistics★、ThreadStart、ThreadEnd、ThreadPark、ThreadContextSwitchRate★ |
| 18-Safepoint | 5 | **SafepointBegin★(2710)、SafepointEnd、SafepointCleanup、SafepointCleanupTask、SafepointStateSynchronization** |
| 19-Sync | 7 | JavaMonitorEnter、JavaMonitorInflate、JavaMonitorWait、BiasedLockClassRevocation、BiasedLockRevocation、BiasedLockSelfRevocation、SyncOnValueBasedClass |
| 20-VM-Ops | 2 | **ExecuteVMOperation★(2709)、SystemGC** |
| 21-Shared-Runtime | 3 | ExceptionStatistics★、JavaErrorThrow、JavaExceptionThrow |
| 22-Deopt | 1 | Deoptimization★(probe 实测 875) |
| 24-Frame | 3 | ExecutionSample★、NativeMethodSample、ReservedStackActivation |
| 25-GC-Framework | 16 | **GCPhaseParallel★(229万)、GCPhasePause★、GCHeapSummary★、GarbageCollection★、GCPhaseConcurrent★、GCPhasePauseLevel1-4★、GCReferenceStatistics★、TenuringDistribution★、GCConfiguration、GCHeapConfiguration、GCLocker、GCSurvivorConfiguration、GCTLABConfiguration、YoungGenerationConfiguration** |
| 26-G1/收集器 | 19 | G1GarbageCollection★、G1HeapSummary★、G1MMU★、G1EvacuationYoung/Old★、G1AdaptiveIHOP★、EvacuationInformation★、PromoteObject*PLAB★(306万)、YoungGarbageCollection★、G1BasicIHOP★、OldGarbageCollection、EvacuationFailed、PromotionFailed、ConcurrentModeFailure、PSHeapSummary、ParallelOldGarbageCollection、Shenandoah*(3)、Z*(9) |
| 27-JNI | 1 | NativeLibrary★ |
| 28-JVMTI | 3 | ClassRedefinition、RedefineClasses、RetransformClasses |
| 29-MethodHandles | **0** | **证实无 JFR 面(v4 修正)** |
| 32-JFR | 5 | ActiveRecording、ActiveSetting★、DumpReason、DataLoss、Flush |
| 37-HeapDump | 2 | HeapDump、OldObjectSample★ |
| 40-Launcher | 2 | ProcessStart、InitialEnvironmentVariable★ |
| 42-Core-Native | 3 | NativeMethodSample、X509Certificate、X509Validation |
| 43-NIO-Net | 8 | FileForce、FileRead、FileWrite、SocketRead、SocketWrite、NetworkUtilization、TLSHandshake、DirectBufferStatistics★ |
| 48-Utilities | 5 | JVMInformation、Shutdown、SecurityPropertyModification、SecurityProviderService、Deserialization |

**无事件域(12 个,均另有非 JFR 观测面)**: 04-logging(jcmd VM.log)、05-cpu-primitives(✗)、11-cds(jcmd VM.cds)、12-ci(间接)、14-c1(Compilation 层数)、23-stub(JMC CodeCachePage)、29-method-handles(✗)、30-entry-points(✗)、31-unsafe(✗)、34-nmt(jcmd VM.native_memory)、45-math(✗)、46-sa(jhsdb)

---

## 06 JMC 自动分析规则清单(74 条,v4 新增,实测)

> 来源: `flightrecorder.rules.jdk` 插件 services 清单(2026-08-11 实测)
> 用法: 写作时引用"规则→事件→域"链条——规则名即 JVM 健康维度清单

| 规则主题 | 规则(节选) | 对应域 |
|---|---|---|
| GC | GcPauseRatio、LongGcPause、HighGc、FullGc、SystemGc、GcFreedRatio、GcInvertedParallelism、GcLocker、GcPauseTarget、GcStall、IncreasingLiveSet、DiscouragedGcOptions | 25、26 |
| VM | VMOperation、ApplicationHalts、ContextSwitch | 20、17 |
| 锁 | BiasedLockingRevocation、BiasedLockingRevocationPause | 19 |
| 内存 | AllocationByClass、AllocationByThread、TlabAllocationRatio、HeapContent、HeapInspection、CompressedOops、MetaspaceOom、IncreasingMetaspaceLiveSet、StringDeduplication | 9、10、6、25 |
| 类 | ClassLoading、ClassLeaking、DynamicallyLoadedAgents、MultipleAgents | 7、28、47 |
| JIT | CodeCache、MethodProfiling、StackDepthSetting、DebugNonSafepoints、CompareCpu | 13、16、32 |
| IO | FileRead、FileWrite、FileForce、SocketRead、SocketWrite | 43 |
| 配置/安全 | PasswordsInArguments、PasswordsInEnvironment、PasswordsInSystemProperties、DuplicateFlags、OptionsCheck、DiscouragedVmOptions、VerifyNone、ManagementAgent、ProcessStarted、ManyRunningProcesses、LowOnPhysicalMemory | 48、33、3 |
| JFR/其他 | DumpReason、BufferLost、FlightRecordingSupport、RecordingSettings、FinalizersRun、AutoBoxing、Error、FatalError、Exception、JfrPeriodicEventsFix、DMSIncident、HeapDump | 32、21、37 |

**共 74 条**(上表为按主题分组节选)。

---

## 07 三张"命令→域"表并列(v5 新增)

> JMC 29 页签(01 节)/ jcmd 50 子命令(01 节)/ **Arthas 命令映射(本节)**——三个工具面的同一映射

| Arthas 命令 | JVM 域 | 对照素材 |
|---|---|---|
| thread / thread -b | 17-threads、19-sync | jstack/JMC ThreadsPage/LockInstancesPage 三对照 |
| dashboard | 33-jmx、09-memory | jconsole/JMC 实时控制台 |
| jvm | 33-jmx | MBean 树清单 |
| vmoption | 03-flags | jcmd VM.flags/VM.set_flag |
| memory | 09-memory | jmap -histo/JMC HeapPage |
| heapdump | 37-heap-dumper | jmap -dump/jcmd GC.heap_dump/MAT |
| profiler | 32-jfr、18-safepoint | async-profiler/JFR/火焰图 |
| sc / jad / dump-class | 07-classfile、08-interpreter | javap -v(同字节码面) |
| trace / watch | 28-jvmti、47-instrumentation | JVMTI 事件面(字节码插桩) |
| monitor | 19-sync、21-runtime | JavaMonitorEnter 事件 |
| ognl | 31-unsafe(间接) | 表达式引擎(无域直接对应) |
| logger / sysprop / sysenv | 04-logging、03-flags | jcmd VM.log/VM.system_properties |
| redefine / retransform | 28-jvmti、47-instrumentation | ClassRedefinition 事件 |

---

## 08 async-profiler JFR 输出 vs JDK 事件(v5 新增,"两种写者"实证)

> 来源: async-profiler 源码 jfrMetadata.cpp(2026-08-11 实测)

**async-profiler 写的 JDK 事件(15 个)**: ExecutionSample / GCHeapSummary / ThreadPark / JavaMonitorEnter / ObjectAllocationInNewTLAB / ObjectAllocationOutsideTLAB / CPULoad / CPUInformation / OSInformation / JVMInformation / ActiveRecording / ActiveSetting / InitialSystemProperty / NativeLibrary + **自定义 jdk.MethodTrace**

**结论**:
- AP 用 JDK 事件名写入(15/170 子集)→ JMC/JFR CLI 可直接读 AP 输出 = 域 32 格式契约的跨实现实证
- AP 不写 GC/编译/safepoint 事件(JDK 专属);JDK 不写 MethodTrace(AP 专属)——**两写者互补**
- 写作素材: "同一 .jfr 文件,两种写者,多种读者"——域 32 格式契约文章的标准开场

---

## 09 43 域素材就绪度(v5 新增,实操补缺依据)

> ✅ 就绪 = 已有实测输出可直接引用 | 🟡 半就绪 = 有数据待补全 | 🔴 空 = 无实测素材 | ✗ = 无途径(源码分析)
> **v7 更新(2026-08-11,执行计划 C 组闭环)**: 48 域逐域核对表见 `00-jvm-tools-readiness.md`——✅ 32 / 🟡 9 / 🔴 2 / ✗ 5;B 组 38 任务全部执行完毕(GUI 8 项降级至附录 G)

| 状态 | 域 | 已有素材 | 待补(阶段) |
|---|---|---|---|
| ✅ 就绪(32) | 01/03/04/06/07/08/09/10/11/13/14/15/16/17/18/19/20/22/24/25/26/32/33/34/35/36/37/38/39/41/46/48 | rec-demo.jfr 90 类事件(SafepointBegin 2710、ExecuteVMOperation 2709、GCPhaseParallel 229万)+ jcmd 49 子命令全量 + jstat 12 + jsnap + clhsdb/jhsdb + javap + LogCompilation(609 任务)+ inline 4122 事件 + jmap/MAT/OOM + MBean 全属性 + jimage/jlink/jdeps + default-vs-profile 对比 + perf 全链路 | 详见 `00-jvm-tools-readiness.md` |
| 🟡 半就绪(9) | 02/21/23/27/28/40/43/44/47 | JITWatch/VM.info/dynlibs/arthas trace/jlink/IO 页截图/javap -v | GUI 截图(附录 G4/G5/G7)或特定场景(ClassRedefinition 等) |
| 🔴 空(2) | 12/42 | 无 CLI 面 | 源码分析 + JFR CompilerPhase 间接观察 |
| ✗ 无途径(5) | 05/29/30/31/45 | - | 源码分析(已定,REVIEW v1/v2 复核) |

**素材目录**(v7): `outlines/00-jvm-tools/materials/` = screenshots/(21 张)+ commands/(130+ 文件)+ jfr-recordings/(10 个)+ logs/(gc.log 13MB + hotspot.log 2.2MB);`INDEX.md` 全量登记

**执行计划**(v7): `00-jvm-tools-execution-plan.md`——A 基础设施验证(8 项全通过)/ B 七篇素材采集(**38 任务全部完成**,8 项 GUI 降级见附录 G)/ C 就绪度闭环(完成,见 `00-jvm-tools-readiness.md`)/ D 归档交接

---

## 10 JFR 配置契约(default vs profile)(v4 新增,素材采集策略依据)

> 来源: `/opt/codev/TencentKona/lib/jfr/default.jfc` + `profile.jfc`(2026-08-11 实测)

**事件开启数**: default 82 个 / profile 83 个(profile ⊇ default,独有: CompilationFailure、JavaMonitorInflate、PromoteObjectInNewPLAB、PromoteObjectOutsidePLAB)

**threshold/period 差异表(决定素材量!)**:

| 事件 | default | profile | 影响域 |
|---|---|---|---|
| SafepointBegin | threshold **10ms** | 0ms | 18(default 漏掉绝大多数 safepoint) |
| JavaMonitorEnter | threshold 20ms | 10ms | 19 |
| ThreadSleep/ThreadPark | threshold 20ms | 10ms | 17 |
| ExecutionSample | 间隔 20ms | 10ms | 24/32(采样密度差一倍) |

**采集策略**:
1. 写 safepoint/锁/IO/采样文章 → **必须 `settings=profile`**(default 的 threshold 系统性漏数据)
2. default = 生产低开销持续录制(<1%);profile = 诊断期精细采样
3. 素材: "同 30 秒,default 录 X 条 vs profile 录 Y 条" = 域 18/25 现成对比实证
