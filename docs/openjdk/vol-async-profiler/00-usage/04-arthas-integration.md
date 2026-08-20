# 04. 先分清谁负责全景，谁负责下钻 —— 与 Arthas 的衔接与生产场景

> **前置依赖**：已经了解 async-profiler 的常见事件、输出格式和火焰图读法
> → **后续**：进入 AP-1~AP-6 主干，开始看 attach、参数、采样和输出的源码实现
>
> 场景：你既会用 Arthas 的 `profiler` 命令，也会直接跑 `asprof`，但线上排查时很容易把它们看成两套平行能力；如果不先分清谁负责 native 采样内核、谁负责交互式命令入口，就会在工具选择、失败定位和排查顺序上不断绕路。
>
> 本篇集成边界已回对 async-profiler 正式交接文档、async-profiler 官方文档与 Arthas 已完成卷的 profiler 相关文章。这里讲的是工具分工与使用层工作流，不重讲主干机制细节；但会明确守住一个关键边界：Arthas 的 `profiler` 命令不是另一套采样引擎，它最终仍然要落到 async-profiler 的 native 能力面上。

## 先把真正的困惑摆出来：为什么 Arthas profiler 和 `asprof` 看起来像两套工具，却不是两套内核

很多人第一次同时接触 Arthas 和 async-profiler 时，都会形成一个很自然的错觉：一边是 Arthas 里的 `profiler` 命令，一边是直接运行的 `asprof`，两边都能出 flame graph、都能看 CPU 热点、都能谈事件和持续时间，于是看起来像两套平行能力。

这个直觉恰恰是最该先纠正的。它们真正的关系不是并列竞争，而是上下层分工。Arthas 提供的是交互式 Java 命令入口，负责让你在一个熟悉的运维控制台里发起 profiler 动作；async-profiler 提供的才是真正的 native 采样内核，负责 attach、事件选择、栈采集、输出格式以及和 Linux/JVM 边界打交道。

如果不先把这件事钉死，后面就很容易出现几类典型误判。

第一类误判，是把某个能力归错层。比如某次采样在容器里跑不起来，就很容易下意识觉得“Arthas profiler 有问题”；但真正失败的往往不是 Arthas 命令层，而是 async-profiler 在底层 attach、库路径、`perf_event_open`、`fdtransfer` 或命名空间边界上没过。

第二类误判，是工具选择顺序错了。很多人会一上来就想用 Arthas 的 `watch`、`trace` 或 `tt` 直接盯住方法现场，仿佛信息越细越好。可在线上，越细的观察通常也意味着越高的侵入性、更重的插桩和更高的误判成本。如果一开始连“热点大概在哪一片区域”都没定位清楚，就直接下钻，常常会把自己埋进局部细节里。

第三类误判，是把“命令入口更友好”误当成“底层要求被抹掉了”。Arthas 的确把入口做得更像一个友好的 Java 运维命令，但这并不会消除 native 采样器对系统边界的真实要求。集成层能遮蔽命令复杂度，遮不掉内核权限、attach 条件、库装载和容器隔离。

所以本篇真正要回答的问题不是“Arthas 和 async-profiler 哪个更好”，而是：它们到底各自负责哪一层，以及线上为什么常常要先全景采样、再交互式下钻。

可以先把关系压成一张图：

```text
Arthas profiler 命令
  → Java 命令层包装 / execute 字符串协议
    → async-profiler native 参数解析与采样内核
      → CPU / alloc / lock / wall / JFR / flamegraph

线上排查
  → 先用 async-profiler 做低侵入全景采样
    → 再用 Arthas watch / trace / tt / thread -b 下钻局部
```

*关键设计（斜体）：* *Arthas profiler 和 `asprof` 的真正关系不是“两套都能采样”，而是“外层交互入口 + 内层 native 引擎”：Arthas 负责把操作入口做得更像 Java 运维控制台，async-profiler 负责真正的采样、格式和系统边界。*[模式: 外层控制台 + 内层引擎]

先记住这一句总领：Arthas 和 async-profiler 的关系，更像“控制台”和“发动机”，而不是两台平行发动机。后面所有分工、排查顺序和失败定位，都围绕这个判断展开。

## 第一层：Arthas 负责命令层包装，async-profiler 才是 native 采样内核

当前交接文档已经把边界写得很清楚：Arthas 的 AR-6 只覆盖 `ProfilerCommand -> AsyncProfiler.execute()` 这一层 Java 命令包装，而 `vol-async-profiler` 研究的是 native 采样引擎本体（`HANDOFF.md:201-202`）。这句话的意义非常大，因为它把“工具体验层”和“采样实现层”直接拆开了。

也就是说，Arthas 的价值主要体现在：

- 你在一个熟悉的 Java 诊断控制台里发命令；
- 这些命令和其他 Arthas 能力一起工作；
- 用户不用每次都离开会话去想 `asprof` 的 CLI 细节。

而 async-profiler 的价值则在于：

- 真正 attach 到目标 JVM；
- 选择事件与采样引擎；
- 采样 Java / JIT / native / kernel 栈；
- 把结果导成 HTML、JFR、OTLP 或文本格式；
- 与 Linux 权限、`perf_event_open`、命名空间、库路径等底层边界打交道。

所以如果只从用户体验层面看，Arthas 像是在“提供 profiler”；但从真实架构层面看，它提供的是 profiler 的交互式入口，而不是 profiler 的 native 内核。

这个区别之所以重要，是因为它会直接影响你怎么理解“谁造成了某个限制”。如果某条命令语法更友好、交互更顺，那是 Arthas 命令层的价值；如果某个事件能不能采、容器里能不能拿到 perf、attach 为什么失败，那更多属于 async-profiler native 能力面的边界，而不是 Arthas 能否“包装得更漂亮”的问题。

所以第一层结论非常简单，但必须先立住：Arthas profiler 不是另一套采样器，它只是另一套入口。

## 第二层：为什么线上最稳的顺序往往是“先全景采样，再局部下钻”

把工具分工讲清之后，最重要的其实是排查策略。线上最常见、也最稳的组合拳，往往不是二选一，而是前后接力：先用 async-profiler 做低侵入全景采样，回答“热点大概在哪”；再用 Arthas 的 `watch`、`trace`、`tt`、`thread -b` 等命令深入某个方法、某段锁竞争或某次调用现场。

这条顺序之所以自然，不是经验偏好，而是因为两边擅长的根本不是一件事。

async-profiler 擅长的是统计采样：它更适合长时间、低成本地看整个系统里哪些路径最热，覆盖 Java、JIT、native，甚至内核栈。你得到的是一张“热区地图”。它特别适合先回答“CPU 大头到底在哪一块”“锁等待大概集中在哪一类路径”“壁钟阻塞主要卡在哪几片区域”。

Arthas 更擅长的是交互式解释：它适合盯某个具体方法、某次调用、某类线程阻塞关系，去看参数、返回值、异常或单次路径。你得到的更像是一副“放大镜”。它特别适合在热点区域已经收敛之后，再去回答“这几个参数为什么会这样”“这次调用到底慢在哪一步”“哪个线程在阻塞谁”。

这两种能力如果顺序颠倒，就会出问题。最典型的失败方案，就是一上来就对全系统做方法级观察，仿佛越细越好。线上现实往往正相反：一开始你对热点还没有地图，直接全靠 `watch/trace` 下钻，既容易带来更高成本，也容易盯错点。你得到的是很多局部细节，却不一定知道它们是否真的代表全局主要矛盾。

所以“先全景、再下钻”并不是教条，而是一种风险控制策略：先用低侵入统计收敛范围，再用高信息密度工具解释局部。

*关键设计（斜体）：* *线上排查最稳的顺序不是“先看最细”，而是“先用低侵入统计收敛范围，再用高信息密度命令解释局部”；async-profiler 和 Arthas 的组合价值，就建立在这条先后顺序上。*[模式: 先采样定位，再交互式解释]

## 第三层：同一类问题，在两边的最佳姿势为什么往往不同

如果把最常见的几类问题并排看，这种分工会更直观。

### CPU 高：先让 async-profiler 画热区，再让 Arthas 解释具体局部

CPU 高的时候，async-profiler 通常先出 CPU flame graph 或 collapsed 结果，快速告诉你大头在哪几条调用路径上。这一步最适合做全景定位。

而 Arthas 更适合在热点已经收敛后，再去看具体线程、具体方法调用链、甚至特定方法的参数和返回值。也就是说，前者先回答“哪片区域热”，后者再回答“这片区域为什么热”。

### 内存涨：先看 alloc 热点，再决定要不要继续对象级观察

内存问题也是类似。async-profiler 先看 alloc 热点，帮助你收敛“到底是哪些分配路径在放大内存压力”；Arthas 再结合 `heapdump`、表达式能力或其他对象观察方式，进一步解释那些热点路径背后的对象语义。

也就是说，一个擅长先找“分配大头在哪”，另一个擅长后看“这些对象到底是什么、为什么会留住”。

### 锁竞争：一个给分布，一个看阻塞关系

锁竞争时，async-profiler 更适合先给出竞争热点的统计分布：哪类锁、哪条路径、哪片代码区域最值得优先盯。Arthas 的 `thread -b` 则更适合再看阻塞关系本身：谁被谁卡住、当前线程图景是什么。

这两步若顺序反过来，就很容易一开始陷在个别线程现场里，却还不知道这是不是系统性的主要热点。

### 阻塞 / 慢请求：一个给全局画像，一个给方法现场

壁钟阻塞、慢请求这类问题也一样。async-profiler 的 wall 事件先给的是“全局阻塞画像”：系统里大概哪些路径在耗费大量壁钟时间。Arthas 的 `trace`、`watch` 则更适合把其中某个局部方法现场掰开看清。

所以真正该记住的，不是某个命令对照表，而是“统计采样”和“方法观察”本来就是两种不同武器：一个擅长先定位，一个擅长再解释。

## 第四层：为什么容器、权限和 attach 失败最能暴露两层边界

如果说本地开发环境里，Arthas 和 async-profiler 的边界有时还不那么刺眼，那么一到容器、权限和 attach 场景，它们的分工会立刻变得非常清楚。

async-profiler 官方容器文档已经明确指出：Docker 默认可能限制 `perf_event_open`，常见退路包括放开 seccomp、使用 `fdtransfer`，或者退到 `ctimer`（`docs/ProfilingInContainer.md:17-24`）。这一类问题的本质从来不是“Arthas 命令写得对不对”，而是 native 采样器能不能在当前系统边界里真正拿到所需能力。

这意味着很多“Arthas profiler 跑不起来”的问题，真正该检查的不是 Arthas 命令层，而是这些更底层的条件：

- 目标 JVM 与工具是否处在可 attach 的 PID namespace；
- 目标容器是否能访问 `libasyncProfiler.so`；
- 主机或容器是否允许 `perf_event_open`；
- 是否需要 `fdtransfer` 这类权限桥；
- 是否该退到 `ctimer` 或其他退路。

这里必须打掉一个很常见的误解：集成层越友好，并不等于底层要求越少。Arthas 可以把命令入口包装得更顺手，但它不会也不可能抹掉 async-profiler 对 Linux/JVM 系统边界的真实要求。它遮蔽的是命令复杂度，不是系统条件。

所以如果某次集成失败，只盯着 Arthas 命令层看，通常只会在最外层绕圈子。真正该回到的，是 async-profiler native 能力面的系统边界。

## 收网：先分清谁负责全景，谁负责下钻

如果把整篇话压成一句话，Arthas profiler 和 `asprof` 的真正关系不是“两套平行工具”，而是“交互式命令入口”和“native 采样内核”的上下层分工。也正因为如此，线上最稳的策略通常不是二选一，而是先让 async-profiler 低侵入地给你一张热区地图，再让 Arthas 进入局部现场做解释。

```text
Arthas profiler 命令
  → Java 命令层包装 / execute 字符串协议
    → async-profiler native 参数解析与采样内核
      → CPU / alloc / lock / wall / JFR / flamegraph

线上排查
  → 先用 async-profiler 做低侵入全景采样
    → 再用 Arthas watch / trace / tt / thread -b 下钻局部
```

到这里，主线只发生了三件事。

第一，Arthas profiler 不是另一套 native 采样器，它只是更友好的 Java 命令入口；真正的采样、输出和系统边界都仍然属于 async-profiler。

第二，线上最稳的排查顺序通常是“先全景、再下钻”：先用低侵入统计收敛范围，再用高信息密度命令解释局部。

第三，容器、权限、attach、`perf_event_open` 这类失败点，最能说明集成层只能遮蔽命令复杂度，遮不掉 native 采样器对系统边界的真实要求。

*关键设计（斜体）：* *在生产场景里，真正该先分清的不是“我更熟哪套命令”，而是“谁负责画热区地图，谁负责拿放大镜解释局部”；Arthas 与 async-profiler 的组合价值，正建立在这条分工线上。*[模式: 上下层分工 + 先全景后下钻]

**本篇的一句话困惑**：Arthas 的 `profiler` 命令和直接运行 `asprof`，为什么看起来像两套工具，却又总在同一类问题上出现？

**本篇的一句话顿悟**：因为 Arthas 提供的是交互式命令入口，async-profiler 提供的才是真正的 native 采样内核；最稳的线上姿势通常是先用 async-profiler 定位全景，再用 Arthas 解释局部现场。

下一组正式进入 AP-1 启动与 attach：从 `main.cpp` 和参数协议开始，真正走进 async-profiler native 内核。

[跨层标注：Arthas Java 命令层；async-profiler native 采样内核；`execute` 字符串协议；Linux/容器权限边界；线上排查策略；先全景后下钻]
