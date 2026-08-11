# 域 00: JVM 工具层 — 全视角提问验证

> 19 知识点(工具,2026-08-11 v3 补 jimage/jlink/jdeps/jdeprscan/jmod)/ 7 篇大纲 | 覆盖 19 工具 + 探索任务 | 关联 43 个实现域(30 直接 + 13 间接)
> 验证方法: 逐题检查 7 篇大纲是否覆盖该视角的关注点
> v2 修订: 工具数 14→15(补 jfr CLI);关联域 15→18(与 KP 01 表逐项核对: 35/03/25/32/37/06/46/09/17/24/13/14/15/22/44/08/33/26)
> v3 修订: 工具数 15→19;关联域 18→43(48 域覆盖矩阵,见 `00-jvm-tools-review.md`);新增篇 7(模块/镜像);JMC 六面板→29 页签
> v4 修订: JFR 事件契约级核对(见 `00-jvm-tools-review-v2.md`)——170 事件索引表(KP 05 节)+ 74 条规则(KP 06 节);域 29 证实无 JFR 面;新增 8 事件素材入口

**大纲文件对照**:

| 篇 | 文件 | 覆盖范围 |
|:--:|------|------|
| 1 | `01-jfr-jmc.md` | JFR 三种触发/JMC 29 页签/时间线 vs 快照 |
| 2 | `02-jcmd.md` | 50 子命令/典型输出/DCmd vs Arthas |
| 3 | `03-memory-tools.md` | jmap 三路/MAT 四板斧/GC 可视化 |
| 4 | `04-jit-bytecode-tools.md` | javap 反汇编/JITWatch 内联/三视角 |
| 5 | `05-sa-tools.md` | SA 架构/hsdb 三任务/jsnap PerfData |
| 6 | `06-jmx-flamegraph.md` | jconsole MBean 树/perf 三层/perf 火焰图原理 |
| 7 | `07-module-image-tools.md` | jimage 镜像/jlink 组装/jdeps 依赖图(v3 新增) |

---

## 维度 1: 新手探索者 (第一次用 JVM 工具)

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| N1 | 第一次录 JFR 用什么命令? | ✅ 篇 1 §1 — jcmd JFR.start |
| N1b | 没有 GUI 怎么读 JFR? | ✅ 篇 1 §1 — jfr CLI(summary/print/metadata) |
| N2 | jcmd 有哪些子命令?怎么列? | ✅ 篇 2 §1 — jcmd help(实测 50 个) |
| N3 | 堆转储怎么拿?第一眼看什么? | ✅ 篇 3 §1 — jmap -histo 先行 |
| N4 | 字节码怎么看? | ✅ 篇 4 §1 — javap -c/-v |
| N5 | JDK 镜像里有什么?怎么拆? | ✅ 篇 7 §1 — jimage list/extract(v3) |
| N6 | JMC 打开 JFR 先看哪页? | ✅ 篇 1 §2 — 29 页签按域分组(v3) |

## 维度 2: 生产排查工程师

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| P1 | CPU 高三种工具怎么组合? | ✅ 篇 1 §3 — jstack/Arthas/JFR 三视图 |
| P2 | 线上堆分析的安全姿势? | ✅ 篇 3 §3 — histo 先行+低峰 dump |
| P3 | 内存泄漏怎么定位? | ✅ 篇 3 §2 — MAT 支配树/泄漏嫌疑 + JMC MemoryLeakPage |
| P4 | 编译日志怎么开?有开销吗? | ✅ 篇 4 §2 — LogCompilation 本地用 |
| P5 | 锁竞争怎么看? | ✅ 篇 1 §2 — JMC LockInstancesPage + jsnap sun.rt._sync_*(v3) |
| P6 | VM 停顿除了 GC 还有谁? | ✅ 篇 2 §1 — jcmd VM.events/VMOperationPage(v3) |
| P7 | 生产镜像瘦身怎么做? | ✅ 篇 7 §2 — jdeps → jlink 闭环(v3) |

## 维度 3: 面试者 (讲"我用工具看过 JVM")

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| I1 | "JFR 和 jstack 的区别?" | ✅ 篇 1 §2 — 事件流 vs 快照 |
| I2 | "火焰图 [inlined] 帧哪来的?" | ✅ 篇 4 §2 — JITWatch+async-profiler 互证 |
| I3 | "SA 能干什么 jmap 不能干的?" | ✅ 篇 5 §1 — 直接读内存/对象头 |
| I4 | "perf 和 JFR 什么关系?" | ✅ 篇 6 §2 — 内核 vs JVM 内采样 |

## 维度 4: 源码学习者 (工具→实现域过渡)

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| S1 | jcmd 的子命令对应 JVM 的什么? | ✅ 篇 2 §1 — DiagnosticCommand(域 35) |
| S2 | JMC 解析的 JFR 是谁写的? | ✅ 篇 1 §2 — async-profiler 也写(AP-5) |
| S3 | hsdb 和 vmStructs 什么关系? | ✅ 篇 5 §2 — 同目标两条路 |
| S4 | 火焰图聚合的本质? | ✅ 篇 6 §3 — stackcollapse+ Trie(AP-5) |
| S5 | PerfData 计数器谁写的? | ✅ 篇 5 §1 — jsnap --all(域 38,PerfData 域)(v3) |
| S6 | VM 操作事件从哪看? | ✅ 篇 2 §1 — VM.events + JFR ExecuteVMOperation(域 20)(v3) |
| S7 | 镜像格式与 JAR 什么区别? | ✅ 篇 7 §1 — jimage 常驻内存 vs JAR 打包(域 41)(v3) |

## 维度 5: 文章写作者 (素材采集)

| # | 问题 | 大纲覆盖? |
|:--:|------|:--:|
| W1 | 域 32 的写作素材从哪来? | ✅ 篇 1 — 事件列表/时间线实录 |
| W2 | 域 06 的对象头素材? | ✅ 篇 5 §2 — hsdb Inspect |
| W3 | 域 13-15 的编译素材? | ✅ 篇 4 — JITWatch 日志 |
| W4 | 域 33 的接口清单素材? | ✅ 篇 6 §1 — jconsole MBean 树 |
| W5 | 域 19 锁的素材? | ✅ 篇 1 §2 + 篇 5 §1 — LockInstancesPage + jsnap 锁计数(v3) |
| W6 | 域 20 VM 操作素材? | ✅ 篇 2 §1 — VM.events 输出样例(v3) |
| W7 | 域 41 镜像素材? | ✅ 篇 7 — jimage list 输出样例(v3) |
| W8 | 域 43 IO 素材? | ✅ 篇 1 §2 — FileIOPage/SocketIOPage(v3) |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 新手探索者 | 6 | 6 | ✅ |
| 生产排查工程师 | 7 | 7 | ✅ |
| 面试者 | 4 | 4 | ✅ |
| 源码学习者 | 7 | 7 | ✅ |
| 文章写作者 | 8 | 8 | ✅ |
| **合计** | **32** | **32** | **✅ 全覆盖** |

---

## 覆盖检查

- 19 工具全部在 7 篇大纲中落地(每个工具都有"怎么用+看见什么+对照")✅
- 5 身份视角 ✅(32 问,含"文章写作者"——工具域专属身份)
- 关联实现域: 30 直接 + 13 间接 = 43 个域 ✅(48 域覆盖矩阵见 `00-jvm-tools-review.md`;5 域无直接观测工具: 05/29/30/31/45)
- 与已学工具对照: Arthas(thread/dashboard/vmoption/命令框架/lock)、async-profiler(AP-2/3/5)全覆盖 ✅
- 工具状态标注 ✅(19 工具全部本机就绪: JDK 14 + 生态 5 已安装;JMC 29 页签实证)
