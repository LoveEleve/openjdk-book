# 01-os 01 平台探测 — 篇级写作依赖与理解路径

## 节点

- `id`: `openjdk.01-os.01-platform-detection`
- `title`: JVM 怎么知道自己跑在容器里？— 平台探测
- `status`: `rewrite-ready`
- `version`: `jdk11u / HotSpot / Linux / x86_64`

## 依赖分类

### HARD

- 卷 0 `java` 命令：读者需要知道 JVM 是由本地 HotSpot 进程承载的，而不是把 `java` 启动器本身当成全部 JVM。

### SOFT

- 05 CPU Primitives：用于解释 cpuid/feature bitmask 与原子能力，但本文只需提供最小背景。
- 03 Arguments & Flags：用于解释探测结果如何进入 JVM flags 与后续初始化，但本文不展开参数解析。
- 25 GC Framework：用于说明 active processor count/内存限制的下游消费，不提前讲 GC 实现。
- 32 JFR：用于说明时间源与采样时间轴的消费，不提前讲 JFR 事件模型。

### NAV

- 02 虚拟内存：本文结束后进入“JVM 如何向 OS 要内存”。
- 17 Threads / 24 Frame & Stack：后续解释线程数、栈和运行时消费探测结果。

### CONSUMES

- 本篇消费 Linux `uname`、x86 `cpuid`、cgroup v1/v2、NUMA/libnuma 的平台输入。

## 一句话困惑

宿主机有 96 核、64GB，但容器只有 2 核、2GB；JVM 在启动时如何知道自己真正能用什么？

## 一句话顿悟

平台探测不是打印环境信息，而是把内核、CPU、虚拟化、cgroup 和 NUMA 的原始输入翻译成 GC、JIT、堆和时间系统可以共享的稳定状态。

## 理解路径

1. 先用“宿主机资源被误当成容器资源”的事故建立必要性。
2. 把平台探测收束成四类输入：地盘/CPU/可用 CPU/可用内存。
3. 先解释原始输入为什么不能直接反复使用，再展示内部状态化。
4. 依次拆内核/虚拟化、CPU、processor count/cgroup quota、memory cgroup/NUMA。
5. 每层都回答：朴素方案是什么、为何不够、HotSpot 翻译成什么状态、下游谁消费。
6. 结尾收回“看清脚下”，桥接到虚拟内存。

## 失败方案

- 只看宿主机，不看 cgroup：线程和堆按错误资源规模膨胀。
- 每次现读 cgroup：频繁文件读取把观测开销带入热路径。
- 每次临时判断 CPU 能力：能力判断分散且不一致。
- 始终保留内核版本字符串：调用方重复解析、比较规则分散。

## 正文交付清单

- [ ] 代码块逐段从 jdk11u 重新截取
- [ ] 章节删除代码后仍能复述主线
- [ ] 版本/平台边界明确
- [ ] 至少三处失败方案展开
- [ ] 误解清单至少三项
- [ ] 篇末桥接到 `02-virtual-memory`
