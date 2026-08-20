# 17. CPU 报警时，为什么不能一上来把所有信息都 dump 出来？——thread 证据递进排查路径

> 基于 `arthas` 当前命令实现与前面 AR-2 / AR-3 / AR-4 机制篇讨论；本文聚焦线上 CPU/阻塞故障的证据递进路径，不重复展开各命令的完整源码机制。
> **前置依赖**：知道如何通过 Arthas attach 进入目标 JVM；源码机制见 [09 —— Arthas 为什么拿不到一张现成的线程总表？](../03-thread-lock/01-thread-enumeration.md)、[10 —— `%CPU` 为什么不是直接读出来的？](../03-thread-lock/02-cpu-sampling.md)、[11 —— CPU 最忙的线程，为什么未必是真堵点？](../03-thread-lock/03-blocking-deadlock.md)。
> → **后续**：[18 —— 线上代码为什么和本地不一样？](../07-class-bytecode/01-class-bytecode-practice.md)：从线程证据进入类、字节码与方法行为排查。
> 关联域：Thread、Dashboard、JVM/Memory、ByteKit、OGNL。

## 先看一个线上现场：CPU 报警时，为什么第一步不是打开所有命令

场景：4 核机器 CPU 报警，服务还活着，但响应开始变慢。此时最容易做错的事，不是少执行一条命令，而是一下子把所有线程、锁、栈、类和方法都打开。

全量深度采集可能得到更多信息，但也会带来更高成本、更大的输出和更多噪声。更糟的是，它会先把几类本来应该分开的故障混在一起：CPU 热点、锁堵点、JVM 内部线程、内存压力、类版本问题都会同时出现，最终让你在第一步就丢失排查方向。生产排查更稳的做法是逐级收敛：

```text
先用低成本视图找候选
  → 再对少数线程看完整栈
    → 根据 STATE 分流到锁、死锁或运行时资源
      → 最后才对明确目标使用 jad / trace / watch
```

本篇真正要回答的是：**为什么生产排查必须先缩小证据范围，再逐步提高观测强度？**

## 先排除两个错误直觉

### 一上来全量 dump

如果 CPU 报警就同时 dump 所有线程、锁、栈和字节码，工具本身会先付出高成本，结果也容易被大量无关信息淹没。更合理的是先筛选候选，再深挖少数目标。

### 把所有异常混成一个问题

CPU 热点、锁堵点、死锁、JVM 内部线程、内存压力和业务方法慢不是同一类问题。它们需要不同证据和不同工具。把 `thread -n`、`thread -b`、`jvm`、`memory`、`trace`、`watch` 当成可互换命令，会让排查路径失去方向。

关键设计（斜体）：*诊断工具不应一次性把所有观测强度打满，而应让每一步输出成为下一步的证据。*[模式: 证据递进 + 成本控制]

## 第一步：先用 `thread -n 3` 判断谁在忙

```text
thread -n 3
```

`ViewRenderUtil.drawThreadInfo()`（`ViewRenderUtil.java:109-126`）渲染线程表，关键字段包括：

```text
ID NAME GROUP PRIORITY STATE %CPU DELTA_TIME TIME INTERRUPTED DAEMON
```

- `TIME`：累计 CPU 时间；
- `DELTA_TIME`：采样窗口内新增的 CPU 时间；
- `%CPU`：窗口平均 CPU 占用的近似值；
- `STATE`：线程当前状态。

`ThreadCommand.process()`（`ThreadCommand.java:116-128`）把显式 `-n` 分流到 `processTopBusyThreads()`。`-n 3` 的意义不是只保留三个线程，而是把后续昂贵的栈和锁查询候选压缩到三个。

关键设计（斜体）：*第一步只做热点排序，不急着解释根因。*[模式: 先筛选、后深挖]

## 为什么 `thread -n 3` 会等待

`ThreadMXBean.getThreadCpuTime(id)` 返回累计 CPU 时间，没有瞬时百分比字段。Arthas 必须先建立基线，再等待窗口，再计算差值：

```text
第一次：记录累计 CPU 基线
  → 等待 sampleInterval
第二次：读取新累计值
  → delta / 墙钟窗口
  → 排序
```

默认间隔是 `200ms`（`ThreadCommand.java:51-55`），计算和排序由 `ThreadSampler.java:116-150` 完成。因此等待是算法需要，不是终端卡住。

必须保留当前实现边界：`thread -n` 两次调用会重新构造 ThreadVO，而 ThreadSampler 历史 map 使用 ThreadVO 对象身份作为 key；实际结果可能退化为以第二次累计 CPU 时间为主的排序，不能把每次输出无条件理解成严格窗口差值。

## 第二步：用 `thread <id>` 把候选变成栈证据

从 Top N 选择一个真实业务线程：

```text
thread <id>
```

`ThreadCommand.process()` 传入线程 id 时走 `processThread()`，通过 `ThreadMXBean.getThreadInfo(long[], lockedMonitors, lockedSynchronizers)` 取得深度详情。

此时开始回答“它为什么在这里”：

1. 栈顶是否停在业务方法；
2. 是否卡在数据库、连接池、HTTP 客户端或锁；
3. 状态是 `RUNNABLE`、`BLOCKED`、`WAITING` 还是 `TIMED_WAITING`。

如果栈顶是业务热点，下一步可以用 `jad` 看运行时代码、用 `trace` 下钻方法内部耗时，或用 `watch` 看参数、返回值与异常；如果栈显示等待锁，转到 `thread -b`。

## 第三步：根据 STATE 分流

接口大量超时时，可以执行：

```text
thread --state BLOCKED
thread --state WAITING
```

`processAllThreads()` 会先枚举线程、统计所有状态，再按 `--state` 保留展示集合（`ThreadCommand.java:131-159`）。状态是分流证据，不是根因：

- `BLOCKED`：通常表示等待进入 synchronized monitor；
- `WAITING`：可能等待通知、队列、连接池资源或其他同步条件；
- `TIMED_WAITING`：可能是带超时的等待或睡眠。

`WAITING` 不自动等于线程池耗尽，`BLOCKED` 也不自动等于死锁。必须结合栈和锁拥有关系判断。

关键设计（斜体）：*线程状态负责决定下一条证据路径，不负责替你完成根因判定。*[模式: 状态证据 + 条件分支]

## 第四步：锁问题走 `thread -b`，死锁怀疑再看 `DEADLOCK-COUNT`

如果线程大量堆在等待状态：

```text
thread -b
```

它调用 `ThreadUtil.findMostBlockingLock()`，通过全量深度 dump：

1. 从 `getLockInfo()` 统计每把锁当前等待线程数；
2. 从 locked monitors 和 synchronizers 找当前持有者；
3. 选择等待人数最多且确实有持有者的锁；
4. 输出持锁线程和完整栈。

持锁帧会追加：

```text
<---- but blocks N other threads!
```

`thread -b` 找的是争用热力，不是死锁证明。一个慢持锁线程可以堵住几十个线程，却不构成循环等待。

真正怀疑死锁时，再看 `jvm` 的 `DEADLOCK-COUNT`。它来自 `ThreadMXBean.findDeadlockedThreads()`（`JvmCommand.java:184-200`），检测 A 等 B、B 等 A 这样的循环等待。

```text
thread -b          → 哪把锁堵住最多线程
DEADLOCK-COUNT     → 是否存在循环等待环
```

## 第五步：业务线程不忙但机器 CPU 高，转向内部线程和运行时面板

如果 `thread -n 3` 里的业务线程都不忙，但机器 CPU 仍然很高，热点可能来自 GC、编译器或其他 JVM 内部线程。

可以适当拉长观察窗口：

```text
thread -i 1000 -n 3
```

`ThreadSampler` 会尝试通过 HotSpotThreadMBean 获取内部线程 CPU 时间（`ThreadSampler.java:157-181`）。内部线程在显示模型中使用 id `-1`，名字可能类似 `GC Thread#0`、`C2 CompilerThread0`。

必须保留两个边界：

- 这依赖 HotSpot 内部接口，失败后会关闭该能力，不让主命令崩溃；
- ThreadSampler 使用 ThreadVO 对象身份作为历史 key，内部线程每次重建 VO，CPU delta 可能不是严格窗口差值。

内部线程行是运行时活动值得关注的证据，不是完美精确账本。此时可以转到 Dashboard 看持续趋势，转到 `memory` / `jvm` 看 GC、内存和运行时背景。

## 第六步：业务栈暴露代码问题后，才进入 `jad` / `trace` / `watch`

当栈已经把范围缩到明确的业务类和方法，才提高观测强度：

```text
jad com.example.Service
sc -d com.example.Service
sm com.example.Service
trace com.example.Service doBiz
watch com.example.Service doBiz
```

- `jad`：运行时实际加载的类和方法代码是什么；
- `sc` / `sm`：类、方法、类加载器和签名边界是什么；
- `trace`：方法内部调用链和耗时分布在哪里；
- `watch`：参数、返回值、异常和条件表达式是什么。

真正的顺序是：

```text
先有线程和栈证据
  → 再锁定目标类/方法
    → 最后才做字节码或方法级观察
```

没有先缩小目标就对全应用做 trace/watch/retransform，会同时放大开销、输出噪声和业务干扰。

## 一条证据递进路径

```text
CPU 高 / 接口变慢
  → thread -n 3
    → thread <id>
      → 看 STATE 和调用栈
        → BLOCKED/WAITING：thread -b
          → 怀疑循环等待：jvm DEADLOCK-COUNT
        → 内部线程热点：dashboard / memory / jvm
        → 业务方法热点：jad / sc / sm / trace / watch
```

这不是必须机械照抄的命令表，而是一条“证据触发下一种观测”的路径：先从全体线程缩到少数候选，再从候选进入具体栈，最后由状态和栈决定走锁、死锁、内部线程、内存、类字节码或方法行为。

## 收网：先缩小证据范围，再选择观测强度

把这条路径压成一句话，就是：

**线上 CPU 或阻塞故障发生时，Arthas 不应该一上来 dump 所有线程、锁、栈和字节码，而应该先用 `thread -n 3` 找候选，再用 `thread <id>` 看因果栈，根据 STATE 分流到 `thread -b`、`DEADLOCK-COUNT`、Dashboard、memory、jvm 或内部线程路径，最后才对明确目标使用 `jad`、`trace`、`watch`。**

到这里为止，主线其实只发生了四件事：

- `thread -n 3` 负责便宜筛选，不负责完整解释；
- `thread <id>` 把统计候选升级为调用栈证据；
- 锁、死锁、内部线程和业务方法是不同分支，不能混成一个问题；
- 高成本工具必须建立在明确目标之上。

这也解释了为什么生产排查需要一条路径，而不是一张命令清单：**每一步的输出都在缩小下一步的搜索空间，同时限制诊断工具本身对业务 JVM 的额外干扰。**

跨层标注：[AR-3 Thread——ThreadVO、CPU 双采样、状态与锁统计]；[AR-4 Dashboard——GC 与运行时趋势]；[AR-2 ByteKit——jad/trace/watch 的类与方法级下钻]；[AR-5 OGNL——watch 条件与结果表达式]

本篇解决的是“线上 CPU/阻塞故障如何逐步缩小证据范围，再选择对应观测工具”。下一篇继续从线程证据进入另一个问题：**运行时加载的类和字节码到底是哪一版，为什么本地源码和线上执行结果可能不一样？**

**→ 下一篇：类加载与运行时字节码排查。**
