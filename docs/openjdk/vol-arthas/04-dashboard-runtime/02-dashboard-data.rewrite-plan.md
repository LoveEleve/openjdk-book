# 02-dashboard-data 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“Dashboard 数据聚合 / Tomcat HTTP 桥”重构成一篇围绕“Dashboard 为什么不是新的监控系统，而是把多种已有数据源按统一快照模型拼成一屏”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- 线程与 CPU 从哪来
- 内存从哪来
- GC 从哪来
- Runtime 从哪来
- Tomcat 从哪来
- 最后再讲 DashboardView 怎么画

这种按数据块平铺的来源说明文。

更好的统一问题是：

**Dashboard 一屏上同时显示线程、CPU、内存、GC、运行时和 Tomcat，为什么 Arthas 没有再造一套“Dashboard 专用监控系统”，而是把已有命令、JMX、HotSpot MBean 和 HTTP 接口结果重新拼成一个会按 tick 更新的快照模型？**

这样本篇就不再是“每块数据从哪来”的罗列，而会被收束成一条更硬的数据管线：

- Dashboard 是聚合器，不是新数据源
- 不同数据块的口径并不相同：有的是差值窗口，有的是累计值，有的是当前环境事实
- Tomcat 区域甚至不走 JVM 内直接调用，而是走本机 HTTP 桥
- 所有来源最后都要落进同一个 `DashboardModel` 快照，交给视图层统一渲染

## 2. 读者困惑

- 为什么 Dashboard 明明显示了这么多块数据，却没有一个“Dashboard 专用采集器”？
- 为什么线程 CPU 区域和 GC 区域的数字口径看起来都在刷新，内部算法却不一样？
- 为什么内存区直接复用 `memory` 命令的数据源？
- 为什么同一个 JVM 里的 Tomcat 信息，Arthas 还要走 `localhost:8006` 这样的 HTTP 接口？
- 为什么有些区域拿到的是窗口差值，有些区域拿到的却是累计值或环境快照？

## 3. 一句话顿悟

**Dashboard 本身不是新的监控数据源，而是一个会按 tick 重新组装快照的聚合器：线程/CPU 复用 `ThreadUtil + ThreadSampler`，内存复用 `MemoryCommand`，GC 和 Runtime 直接读取 MXBean，Tomcat 通过本机 HTTP stats 接口补充；这些来源口径并不相同，但都会被统一装进一份新的 `DashboardModel`，交给视图层重新绘制。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码实现讨论
- 聚焦 Dashboard 的数据来源与聚合边界
- 不重复展开上一篇的 Timer / 生命周期引擎；这里只把 tick 当作上游驱动
- 不把下一篇 `memory/jvm` 命令的完整输出边界提前讲透；这里只聚焦 Dashboard 共享哪些数据源、不共享哪些消费语义
- 这里讲的是 Arthas 当前 dashboard 数据聚合模型，不等于所有 JVM 面板工具都采用同样的数据源与口径

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经抓到“Dashboard 是聚合器，不是新监控系统”这个关键边界
- 线程/CPU、内存、GC、Runtime、Tomcat 数据源的关键锚点都在
- 已经注意到 CPU 区域和 GC 区域口径不同
- Tomcat HTTP 桥和 `SumRateCounter` 的边界也已经提到

### 5.2 必须修复的问题

- 当前骨架仍偏“数据来源说明文”，主问题还不够集中
- 失败方案推演不够厚：为什么不新造一套 Dashboard 采集器、为什么不能把所有区域都做成同一种窗口算法、为什么同 JVM 内 Tomcat 还要走 HTTP，都还没打透
- Tomcat 区域的 HTTP 桥和 `SumRateCounter` 很有设计感，但目前像附加细节，还没完全收回到“统一快照模型 + 异构数据源”主线
- 渲染部分虽然提到了终端尺寸与降级，但还没很好地回扣“所有来源最终必须装进同一个 DashboardModel”这个收网点

## 6. 重写策略

本篇不按数据块罗列推进，而按更强的问题链组织：

1. 先建立冲突：一张 dashboard 面板为什么不是一个全新监控系统
2. 先排除几个错误直觉：
   - 为 dashboard 单独重写所有采集器
   - 所有区域都统一用窗口差值算法
   - 同 JVM 内 Tomcat 直接调类就行，不需要 HTTP 桥
3. 再给总图：线程/CPU、内存、GC、Runtime、Tomcat 这几类来源怎样被统一装入 `DashboardModel`
4. 然后分层拆：
   - 线程/CPU 复用 `ThreadSampler`
   - 内存复用 `MemoryCommand`
   - GC / Runtime 直接走 MXBean
   - Tomcat 通过 HTTP stats + `SumRateCounter`
   - 最后统一进入 `DashboardView`
5. 最后收束成“异构来源 + 统一快照模型”的设计哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——为什么一张面板看起来像一个系统，源码里却没有“Dashboard 专用监控子系统”

目标：建立真实困惑，而不是直接列数据块。

要回答：

- 用户看到的是一张面板
- 但源码里并没有一个“大而全的 DashboardCollector”
- 本篇真正要追的是“为什么 Arthas 选择聚合已有数据源，而不是重造一套采集器”

预估字数：900-1100

### 第二节：先排除几个错误直觉——重造采集器、统一窗口算法、Tomcat 直接调类

目标：做失败方案推演。

要回答：

- 为什么不该为 Dashboard 重新实现线程、内存、GC 采集逻辑
- 为什么并非所有区域都应该做成“窗口差值”
- 为什么同 JVM 内的 Tomcat 数据仍然值得走 HTTP 协议桥
- 真正需要的是：异构来源，统一模型

预估字数：1400-1700

### 第三节：第一层——线程与 CPU：为什么 Dashboard 只是复用 `ThreadUtil + ThreadSampler`

目标：把线程区写成“共享采样器状态的聚合视图”。

要回答：

- `DashboardTimerTask` 为什么持有自己的 `ThreadSampler`
- 每 tick 只做一次 `ThreadUtil.getThreads() + threadSampler.sample(threads)`
- 为什么这和 `thread -n` 的单次命令路径不完全相同
- ThreadVO 身份匹配的实现边界为什么会被原样带进 Dashboard

证据锚点：

- `DashboardCommand.java:218-225`
- `DashboardCommand.java:238-243`
- `ThreadUtil.getThreads()` / `ThreadSampler.sample()`

预估字数：1700-2100

### 第四节：第二层——内存为什么直接复用 `MemoryCommand.memoryInfo()`

目标：把内存区写成“共享命令数据源，不共享命令输出”的例子。

要回答：

- `DashboardCommand.java:244-245` 为什么直接调 `MemoryCommand.memoryInfo()`
- 这个方法内部汇总了哪些来源：heap、non-heap、memory pool、buffer pool
- 为什么复用查询方法能防止 Dashboard 和 `memory` 命令口径漂移

证据锚点：

- `DashboardCommand.java:244-245`
- `MemoryCommand.java:42+`

预估字数：1300-1600

### 第五节：第三层——GC 和 Runtime 为什么不是窗口差值，而是累计值与环境快照

目标：把不同指标口径的差异写清楚。

要回答：

- `addGcInfo()` 为什么直接读 `GarbageCollectorMXBean` 的累计 count/time
- `addRuntimeInfo()` 为什么是当前环境事实与 uptime 快照
- 为什么 CPU 用差值，GC 和 Runtime 却不需要统一成同一种窗口算法
- Dashboard 的统一不在“算法一致”，而在“都被装进同一个快照模型”

证据锚点：

- `DashboardCommand.java:135-157`
- `DashboardView.java:89-124`

预估字数：1700-2100

### 第六节：第四层——为什么 Tomcat 在同一个 JVM 内还要走 HTTP 桥

目标：把 Tomcat 区域写成“协议适配 + 静默降级”的设计解法。

要回答：

- 为什么先探测 `http://localhost:8006`
- 为什么 connector stats / threadpool 要通过两个 HTTP 路径读取
- 为什么 Tomcat 区域不存在或失败时，Dashboard 不该整体失败
- 这条桥的意义是什么：解耦版本依赖、隔离失败面、维持主面板可用

证据锚点：

- `DashboardCommand.java:159-216`
- `NetUtils.request("http://localhost:8006")`

预估字数：1800-2200

### 第七节：第五层——为什么 Tomcat QPS 是差值速率，而 RT 却不是同一种窗口口径

目标：把 Tomcat 区域内部口径差异写清楚。

要回答：

- `SumRateCounter` 如何把累计 requestCount / errorCount / bytes 变成速率
- 为什么第一次 update 只是建立 previous
- 为什么 RT 当前实现是 `processingTime / requestCount`
- 为什么这说明 Dashboard 各块数据源口径并不强求统一，只要边界说清楚

证据锚点：

- `DashboardCommand.java:50-53`
- `DashboardCommand.java:181-190`
- `core/util/metrics/SumRateCounter.java:3-38`

预估字数：1600-2000

### 第八节：第六层——为什么所有来源最终都要装进一份新的 `DashboardModel`

目标：把渲染前的统一收束讲清楚。

要回答：

- 为什么各来源最后都进入 `DashboardModel`
- `DashboardView.draw()` 为什么按终端尺寸再做布局
- Tomcat 区域为什么可以整体缺席而不是拖垮全局布局
- 统一快照模型怎样把“异构数据源”变成“同一屏可读面板”

证据锚点：

- `DashboardView.java:23-70`
- `DashboardView.java:100-110`

预估字数：1500-1800

### 第九节：收网——Dashboard 不是新的监控系统，而是异构来源上的统一快照聚合器

目标：把全文收成一句话并桥接下一篇。

必须点名：

- 线程/CPU 复用
- 内存命令复用
- GC / Runtime MXBean
- Tomcat HTTP 桥
- `DashboardModel` 统一快照
- 下一篇命令与面板的复用边界

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 为 Dashboard 重造一套线程/内存/GC 采集器
2. 把所有数据块都强行统一成窗口差值口径
3. Tomcat 在同 JVM 内就直接调内部类，不需要协议桥
4. Tomcat 区域失败时让整个 Dashboard 一起失败
5. 直接在视图层临时取数据，而不是先组装统一快照模型

## 9. 本篇必须明确澄清的误解

1. Dashboard 不是新的监控系统，而是聚合器
2. 统一面板不等于统一指标口径
3. 线程 CPU 区域和 GC 区域的数字算法本来就不同
4. Tomcat 区域通过 HTTP stats 进来，不代表 Dashboard 与 JVM 内其他区域脱节
5. `DashboardModel` 是统一快照模型，不是某个来源自己的原始对象
6. Tomcat 缺席是可选能力缺失，不应拖垮基础面板

## 10. 证据清单（正文托底）

- `DashboardCommand.java:218-225`
- `DashboardCommand.java:238-245`
- `MemoryCommand.java:42+`
- `DashboardCommand.java:135-157`
- `DashboardView.java:89-124`
- `DashboardCommand.java:159-216`
- `DashboardCommand.java:50-53`
- `DashboardCommand.java:181-190`
- `core/util/metrics/SumRateCounter.java:3-38`
- `DashboardView.java:23-70`
- `DashboardView.java:100-110`

## 11. 字数预算

- 目标正文总字数：`9000-12000`
- 叙述性正文目标：`6000+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么 Dashboard 不是新监控系统，而是聚合器”
3. 是否至少展开了 4 个失败方案
4. 是否把线程/CPU、内存、GC、Runtime、Tomcat 统一到同一条异构来源聚合链上
5. 是否明确把命令与面板的复用边界留给下一篇
6. 是否完成 `file:line` 重核与边界声明
