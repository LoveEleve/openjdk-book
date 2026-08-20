# 20. OOM 前兆出现时，为什么不能第一时间 heapdump？——JVM 与内存的风险递进排查路径

> 基于 `arthas` 当前命令实现与前面 AR-3 / AR-4 机制篇讨论；本文聚焦线上 JVM / 内存 / GC 异常的排查决策路径，不重复展开各命令的完整源码机制。
> **前置依赖**：[14 —— 同一批 JVM 数据，为什么 Arthas 要做成三种命令？](../04-dashboard-runtime/03-jvm-memory-commands.md)：知道 Dashboard、`memory` 和 `jvm` 分别承担趋势、专项和全景消费。
> → **后续**：[21 —— 对象状态不对，和 CPU 热点不清，为什么不能用同一把工具？](../05-ognl-expression/03-ognl-profiler-practice.md)：把 JVM/内存排查继续接到对象观察与采样观察的分流路径上。
> 关联域：Dashboard、JMX Memory/GC/Runtime、heapdump、logger、vmoption。

## 先看一个最危险的线上现场：服务还活着，但内存和 GC 都开始恶化

场景：接口整体变慢，GC 频繁，heap 持续上涨。你此时最容易做错的事，不是少看一个字段，而是直接执行最重的动作：

```text
heapdump --live /tmp/heap.hprof
```

heapdump 当然可能最终需要，但在问题类型还没确认时就先做，会带来额外暂停、IO 和磁盘压力。线上排查更稳的路径应该是逐级升级：

```text
先用 Dashboard 看趋势
  → 用 memory 拆内存结构
    → 用 jvm 补全 JVM 管理背景
      → 核对 logger / sysprop / sysenv / vmoption
        → 选低峰期执行 heapdump
```

本篇真正要回答的不是“有哪些内存命令”，而是：

**为什么线上 JVM 内存排查必须先用低风险证据确认问题类型，再逐步升级到高成本动作？**

---

## 一、先排除几个最直觉、也最容易扩大事故的方案

### 1. OOM 前兆一出现就立即 heapdump

heapdump 会遍历堆并写出 hprof，可能造成明显暂停、IO 和磁盘压力。如果当前问题其实来自 non-heap、DirectBuffer、文件描述符或锁等待，堆转储不仅不能直接回答根因，还可能进一步增加线上压力。

所以第一步应该先确认：

```text
到底是 heap、non-heap、BufferPool、GC 能力，还是别的运行时问题
```

### 2. 只看 Dashboard 的 heap 总量

Dashboard 适合发现趋势，但 heap 总量不能回答：

- 是哪个 MemoryPool 在涨；
- 是 used、committed 还是 max 在变化；
- 是否其实是 non-heap 或 BufferPool 先出问题。

只看一个总数，很容易把不同类型的内存压力混成“堆快满了”。

### 3. 直接开 DEBUG 或修改 vmoption

日志级别和 VM 参数修改都可能改变业务运行条件：

- DEBUG 会增加日志 IO、CPU 和磁盘压力；
- vmoption 可能影响 GC、编译、日志或内存行为；
- 不记录原值和恢复动作，排查结束后容易留下长期副作用。

它们是配置核对或临时改变观测条件的分支，不是默认的第一步。

关键设计（斜体）：*生产排查不是命令越重越快得到答案，而是先获得低风险证据，再决定是否支付高成本。*[模式: 风险递进 + 证据分流]

## 二、第一层：先用 Dashboard 看趋势和全貌

先执行：

```text
dashboard
```

Dashboard 是周期性快照，默认每 5 秒刷新一次，也可以调整：

```text
dashboard -i 2000
dashboard -n 10
```

- `-i 2000`：2 秒刷新一次；
- `-n 10`：刷新 10 次后结束；
- Ctrl-C 或 q：退出面板。

面板适合先回答：

- heap/non-heap 是否持续上涨；
- GC 次数和累计耗时是否异常；
- 线程和 CPU 是否同时恶化；
- 系统负载、JVM uptime、Tomcat 指标是否一起变化。

Dashboard 的价值是建立趋势背景，不是替你完成内存根因分析。用完要退出，否则 Timer、线程枚举和内存/GC 读取会继续发生。

关键设计（斜体）：*Dashboard 先回答“问题是否持续、范围是否扩大”，而不是直接回答“具体是哪一个对象泄漏”。*[模式: 趋势入口 + 低风险观察]

## 三、第二层：`memory` 把“内存涨了”拆成可行动的问题

当 Dashboard 显示 heap 或内存趋势异常，再执行：

```text
memory
```

`MemoryCommand` 在 `monitor200/MemoryCommand.java:30` 声明，核心 `memoryInfo()` 从 `MemoryCommand.java:42` 开始：

- 枚举 `MemoryPoolMXBean`；
- 读取 heap `MemoryMXBean`；
- 按 HEAP / NON-HEAP 分组；
- 追加每个内存池的 used / committed / max；
- 追加 BufferPool 的 used / total capacity。

这一步的关键不是多看几个数字，而是把总量问题拆成结构问题：

- `used`：当前实际使用；
- `committed`：JVM 已准备好的可用空间；
- `max`：允许上限。

例如：

- committed 很大但 used 不高，说明 JVM 已经扩容过，但当前并未全部占用；
- used 接近 max，才更接近当前池的容量压力；
- heap 正常但 non-heap 或 BufferPool 持续上涨，就不该只盯 heap dump。

关键设计（斜体）：*memory 的作用不是把 Dashboard 数字放大，而是把总量拆回 pool、non-heap 和 BufferPool 这些可行动结构。*[模式: MXBean 聚合 + 分层视图]

## 四、第三层：`jvm` 补齐 GC、类加载、线程和配置背景

当内存结构已经出现异常，执行：

```text
jvm
```

`JvmCommand` 在 `monitor200/JvmCommand.java:24` 声明，并在 `JvmCommand.java:39-200` 组织多个一次性数据块：

1. RUNTIME：启动时间、版本、启动参数和 classpath；
2. CLASS-LOADING：已加载、累计加载、卸载类数；
3. COMPILATION：编译器和累计编译时间；
4. GARBAGE-COLLECTORS：各 GC 的 count/time；
5. MEMORY-MANAGERS：内存管理器与内存池关系；
6. MEMORY：heap/non-heap 和 pending finalization；
7. OPERATING-SYSTEM：OS、架构、处理器和负载；
8. THREAD：线程数、daemon、peak、started 和 DEADLOCK-COUNT；
9. FILE-DESCRIPTOR：最大/当前打开文件描述符。

`DEADLOCK-COUNT` 来自 `ThreadMXBean.findDeadlockedThreads()`（`JvmCommand.java:193-200`），和 `thread -b` 的争用热点不是同一指标。

这里的作用是补背景：

- 类加载数持续增加，可能提示动态类生成或卸载异常；
- GC 时间和次数持续恶化，说明回收压力需要结合内存池判断；
- 文件描述符增长，根因可能在连接或文件资源，而不是 heap；
- DEADLOCK-COUNT 非零，应回到线程栈和锁图。

关键设计（斜体）：*jvm 不是 Dashboard 的实时版，而是一次性补齐 JVM 管理面的背景快照。*[模式: 全景盘点 + 证据补全]

## 五、第四层：logger、sysprop、sysenv、vmoption 是配置核对与高风险改变分支

### logger：临时增加观测，不是永久改变运行策略

线上偶发问题缺少日志时，可以查看或临时调整：

```text
logger
logger --name ROOT --level DEBUG
```

`logger` 直接操作 Logback/Log4j2 等运行时日志实现，不需要重启重新读取配置。但 DEBUG 会增加 IO、CPU 和磁盘压力，现场采集完成后应立即恢复原级别。

### sysprop 与 sysenv：先确认 JVM 实际拿到的配置

```text
sysprop
sysenv
```

- `sysprop`：Java System Properties；
- `sysenv`：进程环境变量。

它们回答的是“当前 JVM 实际以什么配置运行”，而不是磁盘上的配置文件打算写什么。

### vmoption：可以在线改，不等于可以随便改

```text
vmoption
```

`vmoption` 面向 HotSpot 诊断参数，例如部分 GC、编译和日志相关选项。某些参数可以在线修改，但是否立即生效、影响范围有多大，取决于具体参数语义。

在修改前必须：

1. 记录原值；
2. 确认参数的运行时影响；
3. 规划恢复动作；
4. 评估是否会改变故障现场。

关键设计（斜体）：*配置命令既能增加证据，也能改变被观察系统，所以它们必须带着恢复纪律使用。*[模式: 运行时核对 + 可逆变更]

## 六、第五层：heapdump 为什么必须是确认问题后的最后升级

### heapdump 解决的是对象级问题，不是所有内存问题

当 `memory` 显示 heap used 持续接近 max，并且 GC 后仍不下降，才更有理由考虑：

```text
heapdump --live /tmp/heap.hprof
```

heapdump 适合回答对象级问题：

- 哪些对象占据了大量堆空间；
- 哪些引用链阻止对象回收；
- 泄漏对象是否集中在某个业务结构。

但如果异常在 non-heap、BufferPool、文件描述符或锁等待，heapdump 不会自动给出对应答案。

### 为什么 `--live` 不是无暂停保证

`--live` 只筛选仍然存活的对象，并不意味着操作轻量或没有暂停。堆遍历、hprof 写出和后续磁盘 IO 仍然可能对线上造成明显影响。

因此生产顺序应是：

```text
Dashboard 看趋势
  → memory 确认 pool / non-heap / BufferPool
    → jvm 补 GC / 类加载 / 线程 / fd 背景
      → 选择低峰期与磁盘空间
        → heapdump
```

关键设计（斜体）：*heapdump 是在问题类型已经收敛之后，用更高成本换取对象级证据的最后升级。*[模式: 高成本诊断 + 离线分析]

## 七、根据证据分流，而不是机械执行命令清单

```text
Dashboard 趋势异常
  → memory 拆 heap/non-heap/pool/buffer
    → jvm 补 GC、线程、类加载、fd、deadlock
      → 配置不明：logger / sysprop / sysenv / vmoption
        → heap used 接近 max 且 GC 后不降：低峰期 heapdump
```

其他分支也要保留：

- CPU 高但内存正常：回 `thread -n` / profiler；
- BLOCKED/WAITING 多：回 `thread -b`；
- DEADLOCK-COUNT 非零：回线程栈和锁图；
- non-heap/BufferPool 异常：优先继续做 `memory` 细拆，而不是直接 heapdump；
- 业务方法行为异常：从线程和栈证据进入 `jad`、`trace`、`watch`。

这条路径的核心是：每一个命令都由前一个命令提供证据，不是看到异常就把所有工具全部打开。

## 收网：先低风险证据，后高成本动作

把整条路径压成一句话，就是：

**线上 OOM 前兆或 GC 频繁出现时，先用 Dashboard 看趋势，再用 `memory` 拆内存结构，用 `jvm` 补 JVM 管理背景，必要时核对并谨慎调整日志与 VM 配置，最后在确认问题类型并选好窗口后执行 heapdump；每一步都先控制诊断成本，再扩大证据范围。**

到这里为止，主线其实只发生了四件事：

- Dashboard 负责趋势入口；
- `memory` 负责内存结构；
- `jvm` 负责完整背景；
- heapdump 是高成本、需要窗口和恢复纪律的最后升级。

这也解释了为什么生产内存排查不能写成一串固定命令：**真正稳定的是风险递进原则，而不是任何环境都必须执行相同的命令顺序。**

跨层标注：[AR-4 Dashboard——周期性趋势与运行时快照]；[JMX——Memory/GC/Runtime/Thread MXBean]；[OpenJDK Heap Dumper——hprof 导出与离线分析]；[AR-3 Thread——CPU、状态和锁定位]；[运行时配置——logger/sysprop/sysenv/vmoption 的核对与可逆变更]

本篇解决的是“线上 JVM 内存或 GC 异常时，为什么要按风险和证据逐级升级观测”。下一步继续沿生产实践扩展时，应把这条路径与类、字节码、方法现场和 profiler 组合起来，而不是把所有命令并列堆在一起。

**→ 后续：继续补齐 Arthas 其他生产诊断能力。**
