# 13. 一张面板为什么不等于一套新监控系统？——Dashboard 的数据来源、HTTP 桥与统一快照模型

> 基于 `arthas` 当前源码实现讨论；本文聚焦 Dashboard 的数据来源与聚合边界，不重复展开上一章 Timer / 生命周期引擎，也不把下一篇 `memory/jvm` 命令的复用边界提前写成本篇主线。
> **前置依赖**：[12 —— Dashboard 为什么不是一个 `while(true)`？](../04-dashboard-runtime/01-dashboard-engine.md)：知道 Dashboard 已经是一条会话级、固定节拍的刷新链。
> → **后续**：AR-4 第三篇——`memory` / `jvm` 命令与 Dashboard 的复用边界。
> 关联域：ThreadSampler、MemoryCommand、JMX MXBean、Tomcat HTTP stats。
> 本篇所有源码锚点均已回对，不靠猜。

## 先看一个最容易被误解的现象：一张面板看起来像一个系统，源码里却没有“Dashboard 专用监控子系统”

场景：用户眼里，Dashboard 一屏同时出现了：

- 线程与 CPU；
- 内存；
- GC；
- 运行时环境；
- Tomcat connector / thread pool。

看起来就像 Arthas 专门为 Dashboard 造了一套“大而全”的监控引擎：

```text
dashboard
  → 一个专门的 DashboardCollector
    → 统一收集所有指标
      → 一次性吐给视图层
```

但源码里根本没有这样一个“Dashboard 专用监控系统”。真正发生的事情更克制：**Dashboard 本身主要是聚合器，不是新的数据源。**

它每次 tick 做的不是“重新发明一套监控逻辑”，而是：

```text
ThreadUtil / ThreadSampler → 线程与 CPU
MemoryCommand              → 内存
GarbageCollectorMXBean     → GC
RuntimeMXBean / System     → 运行时
localhost:8006 HTTP        → Tomcat stats
          ↓
     DashboardModel
          ↓
     DashboardView
```

所以本篇真正要回答的不是：

> 面板里每一块数据从哪来？

而是：

> **Dashboard 一屏上同时显示线程、CPU、内存、GC、运行时和 Tomcat，为什么 Arthas 没有再造一套“Dashboard 专用监控系统”，而是把已有命令、JMX、HotSpot MBean 和 HTTP 接口结果重新拼成一个会按 tick 更新的快照模型？**

这张图里最重要的一刀就是：

```text
来源可以异构
模型必须统一
```

后面所有细节，都围绕这条边界展开。

---

## 一、先排除几个最直觉、也最容易把 Dashboard 做成一团复制粘贴的方案

### 1.1 错觉一：既然要做一张面板，就干脆为它重写一套专用采集器

最直觉的设计当然是：

- 线程区专门写一套 DashboardThreadCollector；
- 内存区再写一套 DashboardMemoryCollector；
- GC、Runtime、Tomcat 也各写一套专门逻辑；
- 最后统一塞进面板。

这样做的短期好处是“代码都集中在 Dashboard 目录里”，但长期代价非常重：

- `thread` 命令修了 bug，Dashboard 线程区可能没跟着修；
- `memory` 命令口径变了，Dashboard 内存区可能漂移；
- 同一种指标在命令和面板里出现两种解释；
- 维护者开始同时维护“命令实现版”和“Dashboard 实现版”两套真相。

所以 Arthas 这里做的不是“把 Dashboard 变成另一个系统”，而是：**尽量复用已有的数据来源，只让 Dashboard 负责调度和组合。**

### 1.2 错觉二：既然都在一张面板上，所有指标口径就应该统一成同一种窗口算法

第二个很自然的想法是：

> 既然 dashboard 每 5 秒刷一次，那每一块数据都应该是统一的“最近 5 秒窗口值”。

这在视觉上很诱人，但在语义上并不成立。因为不同来源天生回答的是不同问题：

- 线程 CPU 适合做窗口差值；
- GC 的 `count/time` 本来就是累计计数和累计耗时；
- Runtime 很多字段是环境事实快照；
- Tomcat QPS 可以由累计请求数做差值，但 RT 当前实现又不是同一种窗口算法。

所以 Dashboard 的统一，不在于强行把所有指标改成同一算法，而在于：**让不同口径的来源都能被放进一份统一快照模型，并且明确各自边界。**

### 1.3 错觉三：Tomcat 就在同一个 JVM 里，直接调内部类就行，没必要走 HTTP

Tomcat 区域最容易让人产生第三个误解：

> 既然 Tomcat 和 Arthas 在同一个 JVM 里，直接调 Tomcat 内部 Java API 不就好了？

看起来省事，但这会把 Dashboard 和具体 Tomcat 版本、内部类结构、类加载边界更深地绑死在一起。Arthas 更克制的做法是：如果 Tomcat 暴露了本机统计接口，就把它当成另一个“已有协议来源”，走 HTTP 适配。

这说明 Dashboard 关注的不是“是不是同 JVM”，而是“有没有一个足够稳定、足够解耦的读取入口”。

---

## 二、第一层：线程与 CPU 为什么只是复用 `ThreadUtil + ThreadSampler`

### 2.1 Dashboard 没有重新发明线程采样，它只复用已有线程快照链

`DashboardTimerTask` 在构造时创建自己的 `ThreadSampler`（`DashboardCommand.java:218-225`），而不是每次 tick 都 new 一个。每次 tick 只做：

```java
List<ThreadVO> threads = ThreadUtil.getThreads();
dashboardModel.setThreads(threadSampler.sample(threads));
```

对应 `DashboardCommand.java:238-243`。

这条路径说明两件事：

- 线程是谁，仍由上一章的 `ThreadUtil.getThreads()` 提供；
- 线程刚才多忙，仍由前一篇的 `ThreadSampler` 提供。

也就是说，Dashboard 线程区不是一套新算法，而是把前两篇已经建立好的线程诊断链拉进了周期性刷新场景。

### 2.2 为什么 Dashboard 的线程区和 `thread -n` 又不完全一样

虽然复用的是同一个采样器，但 Dashboard 的意图和一次性 `thread -n` 还是不同：

- `thread -n` 是一次命令内的短窗口双采样；
- Dashboard 则让同一个 `ThreadSampler` 跨 tick 保留状态，试图用面板节拍形成连续窗口。

这说明 Dashboard 不是在复制 `thread -n`，而是在复用它的采样能力，并把它塞进自己的 tick 语义里。

### 2.3 为什么 ThreadVO 身份匹配的边界会原样被带进 Dashboard

这里还有一个必须诚实保留的实现边界：Dashboard 每次 tick 都重新 `ThreadUtil.getThreads()`，产生的是新的 `ThreadVO` 列表；而 `ThreadSampler` 的历史 map 又是以对象身份作 key。

所以，Dashboard 复用的不只是算法收益，也把实现边界一起带进来了：普通线程与内部线程的窗口差值能否严格匹配，取决于调用方是否复用同一批对象。

关键设计（斜体）：*Dashboard 复用的是采样器状态，而不是重新定义线程采样语义。*[模式: 状态复用 + 聚合器] 聚合器的职责是把现有能力拼起来，同时也必须继承它们的口径与边界。

---

## 三、第二层：内存为什么直接复用 `MemoryCommand.memoryInfo()`

### 3.1 Dashboard 不需要第二套内存采集器

`DashboardCommand.java:244-245` 直接调用 `MemoryCommand.memoryInfo()`。这件事看起来平淡，实际上非常重要：Dashboard 没有为内存区域重造一套实现。

`MemoryCommand.memoryInfo()`（`MemoryCommand.java:42` 起）内部会：

- 枚举 `MemoryPoolMXBean`；
- 读取 `MemoryMXBean` 的 heap / non-heap；
- 组织成 `MemoryEntryVO`；
- 再补充 BufferPool 等堆外缓冲信息。

这说明 Dashboard 内存区和 `memory` 命令之间，并不存在两套口径竞争，而是：

```text
同一套查询方法
  → 在命令里画成 memory 输出
  → 在 Dashboard 里塞进 DashboardModel
```

关键设计（斜体）：*命令与面板可以拥有不同消费形态，但尽量不要拥有不同数据源实现。*[模式: 共享查询方法 + 多出口模型]

### 3.2 为什么这比“复制一份查询逻辑到 Dashboard”更重要

因为一旦复用：

- 修 `memory` 命令的口径 bug，Dashboard 内存区一起修；
- 新增一个 BufferPool 字段，两边一起生效；
- 数据源语义天然一致。

所以 Dashboard 的价值不是“拥有自己的一套内存采集器”，而是“让已有数据源在另一种消费形态里被重用”。

---

## 四、第三层：为什么 GC 和 Runtime 不是窗口差值，而是累计值与环境快照

### 4.1 GC 区域回答的不是“刚才这 5 秒发生了几次 GC”

`addGcInfo()` 在 `DashboardCommand.java:148-157`：

1. 读 `ManagementFactory.getGarbageCollectorMXBeans()`；
2. 遍历每个 `GarbageCollectorMXBean`；
3. 取 collector 名称、`getCollectionCount()`、`getCollectionTime()`；
4. 组装 `GcInfoVO`。

这里的 `count/time` 是 MXBean 提供的**累计值**。Dashboard 并没有像线程 CPU 那样，在这里另做两次差值。

这说明 GC 区域的语义是：

```text
告诉你每个 collector 到现在为止发生过多少次、花过多少时间
```

而不是：“严格等于最近这个 Dashboard tick 窗口里的 GC 事件次数”。

### 4.2 Runtime 区域更明显是“环境事实快照”

`addRuntimeInfo()` 在 `DashboardCommand.java:135-146`，组合：

- `os.name`、`os.version`
- `java.version`、`java.home`
- `OperatingSystemMXBean.getSystemLoadAverage()`
- `Runtime.availableProcessors()`
- `RuntimeMXBean.getUptime()`
- 当前时间戳

这里有的像环境事实，有的像累计 uptime，有的像当前系统负载。它们本来就不属于同一种窗口差值模型。

### 4.3 为什么 Dashboard 的统一不在“算法统一”，而在“快照统一”

这正是本篇最容易讲糊的地方：面板一起刷新，不等于所有指标算法都一样。

- 线程 CPU 区域：窗口差值；
- GC 区域：累计计数和累计耗时；
- Runtime 区域：环境与当前快照。

它们能放在一张面板上，不是因为公式被统一了，而是因为：**它们都被组织进了同一个 `DashboardModel` 快照，供同一次 tick 渲染。**

关键设计（斜体）：*Dashboard 统一的是“什么时候把哪些数据装进同一份快照”，不是“所有指标都必须按同一种数学口径计算”。*[模式: 异构口径 + 统一快照]

---

## 五、第四层：为什么 Tomcat 在同一个 JVM 内还要走 HTTP 桥

### 5.1 Tomcat 区域最能暴露 Dashboard 的“聚合器”本质

`addTomcatInfo()` 在 `DashboardCommand.java:159-216`。它做的第一步不是调用某个 Tomcat Java 类，而是先探测：

```java
NetUtils.request("http://localhost:8006")
```

如果失败，方法直接 return（`:159-163`），Tomcat 区域消失，但 Dashboard 其他区域不受影响。

这一步已经把 Tomcat 区域的定位说得很清楚：**它是一个可选增强来源，不是整个 Dashboard 的生死依赖。**

### 5.2 为什么同 JVM 内仍值得走 HTTP 协议桥

探测成功后，Dashboard 再请求两个路径：

- `/connector/threadpool`
- `/connector/stats`

然后把 JSON 解析成对象（`DashboardCommand.java:167-179`）。

这里最值得停一下的问题是：Tomcat 明明就在同一个 JVM 里，为什么还要走 HTTP？

答案恰好说明 Dashboard 是聚合器：它追求的不是“所有来源都必须直接调用 JVM 内对象”，而是“能不能通过一个足够稳定、足够解耦的协议入口拿到我要的统计”。

如果直接绑到 Tomcat 内部类：

- 版本耦合会更深；
- 类加载边界更难控；
- 区域失败时也更难优雅降级。

而 HTTP 桥的好处是：

- 协议边界清楚；
- Tomcat 不在或接口不可达时，直接隐藏这块区域；
- 主面板线程、内存、GC、Runtime 仍然可用。

关键设计（斜体）：*即使在同一个 JVM 里，只要一个子系统已经暴露出足够稳定的协议接口，Dashboard 也可以把它当成“外部数据源”来解耦读取。*[模式: HTTP 适配器 + 静默降级]

---

## 六、第五层：为什么 Tomcat QPS 是差值速率，而 RT 却不是同一种窗口口径

### 6.1 `SumRateCounter` 解决的是“累计数怎么变成速率”

Dashboard 为四类 Tomcat 累计值维护了 `SumRateCounter`（`DashboardCommand.java:50-53`）：

- request count
- error count
- received bytes
- sent bytes

每次 connector stats 返回后，在 `DashboardCommand.java:181-190` 更新这些计数器，再读取：

- QPS
- error rate
- bytes rate

`core/util/metrics/SumRateCounter.java:3-38` 说明了这条逻辑：第一次 update 只记 previous，之后才用 `value - previous` 计算增量并送进 RateCounter。

所以 QPS 的真实来源不是“Tomcat 直接给了一个 QPS 字段”，而是：

```text
Tomcat 暴露累计 requestCount
  → Arthas 本地做差值 / 速率换算
```

### 6.2 为什么 RT 当前实现不是同一套窗口算法

源码在 `DashboardCommand.java:186-190` 直接算：

```java
double rt = processingTime / (double) requestCount;
```

也就是说：

- QPS、错误率、字节速率：差值速率模型；
- RT：直接用当前返回的累计 `processingTime / requestCount`。

这说明 Dashboard 并不强求 Tomcat 区域内部也要统一成一个窗口口径。相反，它会根据当前拿到的来源字段，选择最合适的计算方式，并把边界留在代码里。

关键设计（斜体）：*同一块面板里也允许存在不同口径的子指标，只要来源和解释都明确。*[模式: 来源一致，口径可异]

---

## 七、第六层：为什么所有来源最终都要装进一份新的 `DashboardModel`

### 7.1 真正统一它们的，不是算法，而是模型边界

不管来源来自：

- `ThreadUtil + ThreadSampler`
- `MemoryCommand`
- `GarbageCollectorMXBean`
- `RuntimeMXBean`
- `localhost:8006` HTTP stats

这些数据最终都要进入一份新的 `DashboardModel`。这才是 Dashboard 真正的统一点：**异构来源，共享一份会随 tick 替换的模型边界。**

### 7.2 `DashboardView` 为什么按终端尺寸重新布局，而不是让数据源自己管展示

`DashboardView.draw()` 在 `DashboardView.java:23-70`：

1. 先读 `process.width()` / `process.height()`；
2. 上半区给线程表；
3. 下半区再切成 memory+GC 与 runtime+Tomcat；
4. 终端矮时采用保底高度；
5. Tomcat 区域不存在时，用 runtime 单独占区。

这说明视图层并不是“附着在某个数据源上”的，而是拿着统一模型，按当前终端条件重新排版。

### 7.3 为什么 Tomcat 缺席时不该拖垮整个布局

`DashboardView.java:100-110` 里，Tomcat 是否出现由 `tomcatInfoTable == null` 决定。Tomcat 接口不可用时，布局会自然退化成只有 runtime 区域，而不是空白或报错整屏。

这再次证明了聚合器思路：**某一块增强来源缺失，不应该拖垮整份快照，也不应该把视图搞崩。**

关键设计（斜体）：*所有异构来源最终都必须被收束到一份新的 `DashboardModel`，这样视图层才能在终端尺寸、区域缺席和布局降级之间保持一致。*[模式: 统一快照模型 + 视图降级]

---

## 收网：Dashboard 不是新的监控系统，而是异构来源上的统一快照聚合器

现在把整条链收成一张图：

```text
已有来源：
  ThreadUtil / ThreadSampler  → 线程与 CPU
  MemoryCommand               → 内存
  GC / Runtime MXBean         → GC 与运行时
  Tomcat HTTP stats           → connector 与 thread pool
            ↓
      DashboardModel
            ↓
      DashboardView
```

把这张图压成一句话，就是：

**Dashboard 不是新的监控系统，而是一条会按 tick 重新组装快照的聚合链：它尽量复用已有命令和现成协议，把线程/CPU、内存、GC、Runtime、Tomcat 这些异构来源重新装进一份统一的 `DashboardModel`，再交给视图层按当前终端状态绘制出来。**

到这里为止，主线其实只发生了四件事：

- Dashboard 不是专用采集器，而是复用已有来源的聚合器；
- 统一面板不等于统一指标口径；
- Tomcat 区域通过 HTTP 桥接入，是为了协议解耦与静默降级；
- 所有异构来源最后都要收束到同一份 `DashboardModel` 快照边界。

这也解释了为什么一张面板看起来像一个系统，源码里却没有“Dashboard 专用监控子系统”：**Arthas 选择的不是重造所有数据源，而是尽量把已有来源按 tick 拼成一份统一快照。**

跨层标注：[AR-3 ThreadSampler——线程 CPU 的窗口差值来源]；[MemoryCommand——命令与面板共享查询方法]；[JMX MXBean——GC 与 Runtime 的累计值 / 当前环境快照]；[HTTP 适配器——Tomcat 通过本机 stats 协议接入]；[DashboardModel——异构来源到统一视图模型的边界]

本篇解决的是“为什么 Dashboard 不是新监控系统，而是异构来源上的统一快照聚合器”。下一篇继续进入更细的边界：**`memory`、`jvm` 等命令的完整数据块，为什么没有整块复制到 Dashboard，而是选择共享部分数据源、分开组织消费形态？**

**→ 下一篇：memory/jvm 命令与 Dashboard 的复用边界。**
