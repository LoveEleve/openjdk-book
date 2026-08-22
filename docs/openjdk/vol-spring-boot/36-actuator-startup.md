# 为什么 `/actuator/startup` 不是把启动日志再打一遍：`ApplicationStartup` 如何把启动时序变成可诊断数据

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接前一篇 `conditions / configprops / mappings` 诊断闭环，进入 Actuator 启动观测端点：`startup`。重点放在 `ApplicationStartup`、`BufferingApplicationStartup`、`StartupStep`，以及 `startup` 端点如何把启动阶段埋点暴露出来。本文不重复 `vol-spring` 中启动阶段或事件监听原理，而聚焦 Boot 怎样把启动过程变成可查询的时序诊断数据。下一篇将进入 `threaddump / heapdump` 事故排查端点。

## 为什么应用启动快慢，往往需要“时序数据”而不是“一行总结日志”

很多工程师理解“应用启动慢”，第一反应都是：

- 看日志里的启动耗时
- 或者看 `Started Application in ... seconds`

但一旦要真正定位“枪在哪里”，这种总结日志往往不够。

因为你需要知道的不是：

- 总耗时是多少

而是：

- 每个启动阶段各花了多久
- 哪个阶段是明显瓶颈
- 瓶颈发生在环境准备、Bean 创建还是 WebServer 启动阶段

这种问题如果只靠日志，会非常难排查。

Boot 的 `startup` 端点正是在这里出现的。

**第一层问题是：启动过程不是一个“总耗时”，而是一串有顺序、有耗时、有层次的埋点步骤。**

**第二层问题是：Boot 不能只给一个总结数字，而要把启动过程建模成可暴露的时序数据。**

**第三层问题是：`BufferingApplicationStartup` 的价值在于“自动记录能力”，`startup` 端点则承担“把记录暴露出来”的职责。**

因此，本文真正要回答的问题不是“应用启动花了多久”，而是：

**为什么对 Boot 来说，必须把启动过程建模成可记录、可缓存、可查询的 `StartupStep` 时序数据，再通过 `startup` 端点暴露出来；这样启动优化才不只是看总结数字，而是能按阶段定位瓶颈。**

## 先看失败方案：为什么不能只看启动总结日志、不能在启动期手工埋点、也不能让埋点导致启动额外开销

### 失败方案一：启动优化只看 `Started ... in x seconds`

这是最直接的方案，但最没有诊断价值。

因为它只回答：

- 总耗时多少

不回答：

- 哪个阶段慢
- 哪个阶段是瓶颈
- 瓶颈是否可以避免

所以它只适合“确认慢”，不适合“定位慢”。

### 失败方案二：在业务代码里手工给启动阶段打点

如果 Boot 不提供统一能力，团队只能自己手写：

- 启动阶段耗时记录
- 阶段标记
- 缓存这些记录

这会把启动观测逻辑散落到业务代码，而且很难和：

- Spring 容器阶段
- Bean 创建阶段
- WebServer 启动阶段

真正对齐。

所以 Boot 需要一个统一的启动埋点模型。

### 失败方案三：让启动埋点长期开启，影响启动性能

如果埋点一直全量记录，启动开销会明显增加。

所以正确设计应该是：

- 需要诊断时开启缓冲
- 不需要时用轻量实现
- `startup` 端点读取当前缓冲的数据

也就是说，Boot 需要在“观测能力”和“启动性能”之间选平衡。

## `startup` 的最小总图

```text
application startup phases
   -> StartupStep created and recorded
   -> BufferingApplicationStartup stores them
   -> /actuator/startup reads buffered steps
```

```text
[启动过程]
SpringApplication.run / refresh / web server

   ->

[埋点模型]
StartupStep / StartupStep.Tags

   ->

[记录器]
ApplicationStartup / BufferingApplicationStartup

   ->

[暴露端点]
/actuator/startup

   ->

[诊断价值]
按阶段定位启动瓶颈
```

## 一、`ApplicationStartup` 是什么：它不是一个端点，而是容器启动阶段的分析模型

很多人在遇到 `startup` 端点前，第一个会看到的其实是：

- `ApplicationStartup`

这个名字容易让人误会成“一个启动配置类”。

但实际上它是 Spring 框架对“启动过程怎样被分析”的抽象：

- 启动过程中，框架创建 `StartupStep`
- 每个步骤携带名称、耗时、标签
- `ApplicationStartup` 决定这些步骤是否被记录、如何记录

也就是说，它首先是一种：

- **启动阶段分析模型**

而不是端点本身。

## 二、为什么默认常用 `BufferingApplicationStartup`：它在“记录”和“性能”之间做取舍

Spring 提供了多种 `ApplicationStartup` 实现，其中最常见的是：

- `BufferingApplicationStartup`

它的核心特征是可以：

- 缓存最近的启动步骤
- 按容量保留
- 避免无限记录导致内存膨胀

这意味着：

- 记录能力默认存在
- 但不会无限制积累
- 容量和观测需求之间取得平衡

所以它不是“把所有启动细节永久保存”，而是：

- **缓冲最近的启动时序。**

源码里 `BufferingApplicationStartup` 通过 `ConcurrentLinkedQueue<TimelineEvent>` 存储步骤，`capacity` 控制上限，`drainBufferedTimeline()` 允许排空缓冲，`addFilter()` 支持只记录相关步骤；`StartupEndpoint` 的 `@ReadOperation` 走 `getBufferedTimeline()`，`@WriteOperation` 走 `drainBufferedTimeline()`。

## 三、`StartupStep`：启动过程的最小诊断单元

真正被记录的不是笼统的“启动中”，而是一系列：

- `StartupStep`

每个步骤通常包含：

- 名称
- 时间
- 耗时
- 标签（Tags）

例如：

- 环境准备
- BeanFactory 刷新
- Bean 初始化
- WebServer 创建

都以独立 step 形式存在。

这意味着消费者可以从整体时序中挑出：

- 某个阶段耗时
- 某个 Bean 创建耗时
- 某个前置环节是否成为瓶颈

## 四、为什么 `startup` 端点的价值不是“再看一遍启动日志”，而是“查询启动时序数据”

启动日志是：

- 一次性输出

而 `startup` 端点是：

- 可查询的缓冲数据

这两者不是同一件事。

启动日志适合：

- 事后看启动过程发生了什么

`startup` 端点适合：

- 在应用运行中随时查询当前启动步骤
- 甚至配合 launch 参数触发一次新的启动记录
- 把步骤数据交给日志、指标或外部系统

所以它更接近：

- **启动阶段的可观测端点**

而不是日志的另一种形式。

## 五、为什么它和 `LoggingSystem`、`ConfigData`、`FailureAnalyzer` 不在同一层

启动观测在 Boot 里是一个独立能力。

- `LoggingSystem`：解决日志输出
- `ConfigData`：解决配置装载
- `FailureAnalyzer`：解决启动失败诊断
- `startup` 端点：解决启动过程时序可观测

它们对启动认知的作用不同：

- 日志和配置告诉我们“启动怎么跑”
- startup 告诉我们“启动各阶段花多久”
- failure analyzer 告诉我们“启动失败为什么失败”

所以这篇的定位是给启动观测补上“时序数据”这一维。

## 六、最小源码证据：这条链确实是“StartupStep -> ApplicationStartup/BufferingApplicationStartup -> startup endpoint”

从源码模型看，`StartupEndpoint` 直接依赖 `BufferingApplicationStartup`：

```java
@Endpoint(id = "startup")
public class StartupEndpoint {

    private final BufferingApplicationStartup applicationStartup;

    @ReadOperation
    public StartupDescriptor startupSnapshot() {
        StartupTimeline startupTimeline = this.applicationStartup.getBufferedTimeline();
        return new StartupDescriptor(startupTimeline);
    }

    @WriteOperation
    public StartupDescriptor startup() {
        StartupTimeline startupTimeline = this.applicationStartup.drainBufferedTimeline();
        return new StartupDescriptor(startupTimeline);
    }
}
```

`StartupEndpointAutoConfiguration` 要求 `ApplicationStartup` 必须是 `BufferingApplicationStartup` 类型，否则端点不会生效。这证明：

- `startup` 端点的数据来源不是日志，而是 `BufferingApplicationStartup` 的缓冲步骤
- `@ReadOperation` 和 `@WriteOperation` 分别对应“查看缓冲”和“排空并查看”两种语义

所以 `startup` 端点和健康、指标、诊断不同，它回答的是：

- 启动这个动作本身如何被量化和分析

## 七、为什么这篇适合放在 `conditions / configprops / mappings` 之后

在 Actuator 规划里，`startup` 放在：

- 自动配置诊断闭环之后
- 事故排查端点之前

这个顺序是合理的：

- `conditions / configprops / mappings` 回答“自动配置装成了什么”
- `startup` 回答“启动过程怎么走了”
- `threaddump / heapdump` 回答“运行事故怎么查看”

也就是：

- 配置诊断 → 启动观测 → 运行事故

是一个从“离线装配分析”到“启动过程分析”再到“运行时状态分析”的合理递进。

## 八、几个最容易错的判断

### 1. `startup` 端点只是把启动日志再打一遍

不成立。

它是把启动阶段建模成 `StartupStep` 时序数据后可查询的端点。

### 2. `ApplicationStartup` 就是一个启动配置类

不成立。

它是 Spring 对启动过程如何被分析的抽象模型。

### 3. `BufferingApplicationStartup` 应该永久记录所有启动步骤

不成立。

它会按容量缓冲，避免无限累积。

### 4. 启动优化的关键只是总耗时

不完整。

真正有价值的是按阶段定位瓶颈，而 startup 端点能把启动过程拆成可查询的步骤。

### 5. `startup` 和 `loggers` 或日志系统是同一个主题

不成立。

日志系统解决输出，startup 解决启动时序可观测，职责不同。

## 收网：`startup` 统一的不是“启动耗时统计”，而是“把启动过程建模成可查询的时序诊断数据”

现在可以回到开头的问题：为什么应用启动快慢，往往需要“时序数据”而不是“一行总结日志”？

因为它真正要回答的不是：

- 总耗时是多少

而是：

- 哪个启动阶段慢
- 为什么慢
- 瓶颈能否被定位

而 Boot 通过：

```text
StartupStep
   -> ApplicationStartup / BufferingApplicationStartup
   -> /actuator/startup
```

把启动过程变成了可查询的时序数据。

所以这篇真正该带走的结论不是“Boot 能统计启动时长”，而是：

**Boot 把启动过程建模为 `StartupStep` 时序，通过 `ApplicationStartup` / `BufferingApplicationStartup` 记录，再用 `startup` 端点暴露；因此，启动优化不再只是看总结数字，而是可以按阶段定位瓶颈的启动观测能力。**