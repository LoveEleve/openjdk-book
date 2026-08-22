# 为什么 Health 和 Metrics 不只是 Actuator 的两个端点：它们怎样分别承担“可用性判断”和“运行态量化”

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接前一篇 Actuator 端点体系，继续进入最核心的两个能力源域：Health 与 Metrics。重点放在 `HealthIndicator` / `HealthContributor`、`LivenessStateHealthIndicator` / `ReadinessStateHealthIndicator`、`MeterBinder`、Metrics 采集与端点暴露之间的关系。本文不追求把每个具体指标或每个健康检查实现逐个列完，而是先回答：为什么 Health 和 Metrics 在 Actuator 里不是两个“看起来都很像监控”的端点，而是两种根本不同的生产语义。下一篇将继续进入测试自动配置或更细的 Actuator 深化主题。

## 为什么一个应用既需要 Health，又需要 Metrics，它们看起来都像“监控”，却不能混成一回事

只要做过一点生产运维，就会发现一个非常常见但又非常容易被混淆的现象：

- 运维会问：应用现在健康吗？
- 也会问：应用现在的 QPS、延迟、内存、GC、连接池利用率是多少？

很多团队一开始会把这两类问题都归进一个很模糊的词：

- 监控

但如果不把它们拆开，后面几乎所有可观测性讨论都会越来越乱。

因为这两类问题本质上不是同一个问题：

- Health 更关心：这个应用现在能不能继续被认为“可用”或“可服务”
- Metrics 更关心：这个应用当前运行得怎么样、负载多大、资源消耗如何、趋势怎样

也就是说：

- Health 更偏判断语义
- Metrics 更偏量化语义

Boot 在 Actuator 里同时提供两者，不是因为“端点越多越好”，而是因为：

- **生产系统同时需要判断型信息和量化型信息。**

第一层问题是：**Health 回答的是“当前可不可以被信任地继续服务”，Metrics 回答的是“当前系统以什么状态在运行”。**

例如一个数据库连接池指标可能显示：

- 活跃连接数 70
- 最大连接数 100

这很有价值，但它本身并不直接等价于：

- 应用健康或不健康

反过来，一个 health 检查可能给出：

- 数据库 DOWN

这会直接影响流量与告警判断，但它又不会自然替代：

- 连接数变化趋势
- 请求延迟分布
- GC 次数

也就是说，Health 和 Metrics 不是同一信息不同展示方式，而是：

- **不同语义层的运行事实。**

第二层问题是：**Actuator 不是简单暴露两个端点，而是分别围绕两套能力源模型组织它们。**

对 Health 来说，核心能力源是：

- `HealthIndicator`
- `HealthContributor`
- Availability state 相关指标源

对 Metrics 来说，核心能力源是：

- `MeterBinder`
- Micrometer meter registry
- 各类 JVM / HTTP / 数据源 / 自定义指标绑定器

也就是说，Health 和 Metrics 虽然都通过 Actuator 暴露，但它们在内部世界里并不是同一套扩展模型。

第三层问题是：**Health 与 Metrics 最终会在运维决策上协作，但它们不能互相替代。**

例如：

- Health 可用于 readiness / liveness / 是否摘流量
- Metrics 可用于容量规划、报警阈值、趋势观察、瓶颈定位

如果把 Metrics 当成 Health 来用，系统就会过度依赖阈值猜测“是否健康”；
如果把 Health 当成 Metrics 来用，系统就只能得到少量 yes/no 风格结论，却失去运行趋势感知。

因此，本文真正要回答的问题不是“Actuator 里为什么既有 health 又有 metrics”，而是：

**为什么对 Boot 来说，必须把 Health 和 Metrics 分别建立在判断型能力源与量化型能力源之上，再通过 Actuator 统一暴露出去，应用在生产里才真正既可被判断是否可用，又可被量化观察其运行态。**

## 先看失败方案：为什么不能只保留 Health、不能只保留 Metrics、也不能把 Readiness/Liveness 混进普通业务健康检查里

### 失败方案一：只要有 Health 端点就够了，Metrics 没那么重要

这是最常见的低估之一。

因为从值班和探针角度看，Health 的确非常显眼：

- UP / DOWN
- ready / not ready

它直接决定：

- 流量要不要进来
- 告警要不要触发

但只靠 Health，运维系统会立刻失去大量关键能力：

- 不知道延迟和吞吐趋势
- 不知道内存、GC、线程池、连接池资源曲线
- 不知道一个系统是“正在恶化”还是“已经彻底坏掉”

也就是说，Health 很重要，但它更像结果判断，不足以承担完整运行态观察。

### 失败方案二：有 Metrics 就够了，Health 只是对 Metrics 粗糙求和

这同样不成立。

因为 Metrics 再丰富，本质上也大多只是：

- 数值
- 分布
- 趋势
- 计数器 / 计时器 / gauge

它们不天然给出：

- 是否应该继续接流量
- 当前实例是否 ready
- 业务依赖是否已经不可用

如果只靠 Metrics 来猜 Health，系统就不得不：

- 自己定义大量阈值规则
- 自己推断哪些指标组合代表健康、哪些代表不健康

这会把“判断语义”重新散落到运维脚本和告警平台里。

### 失败方案三：Readiness/Liveness 就写进普通 HealthIndicator 里糊在一起就行

这也是很容易出现的混法。

因为 Availability 本身和 Health 本来就有关系，于是很容易觉得：

- 反正都叫健康
- 那就都塞进 health 世界里一起算

但如果完全混在一起，就会模糊掉：

- 一般依赖健康（DB / Redis / Disk）
- 应用生命周期状态（Liveness / Readiness）

这两者虽然最终都会参与“可服务性判断”，但它们的来源和语义并不完全一样。

也就是说，Boot 需要的是：

- Availability 状态模型保持独立
- Health 端点再把这些状态作为重要能力源之一消费

而不是从一开始就把所有东西揉成一个平面化的“健康值”。

## Health / Metrics 的最小总图

如果把这两条能力源主线先压缩成最小模型，它可以写成下面这样：

```text
internal runtime facts
   -> Health path: indicators/contributors -> health endpoint
   -> Metrics path: meter binders/registry -> metrics endpoint
```

如果再换一种更适合理解职责的拆法，它可以分成下面六层：

```text
[状态与资源事实]
依赖状态 / JVM / HTTP / 连接池 / Availability / 自定义业务信号

   ->

[Health 能力源]
HealthIndicator / HealthContributor / Availability-derived indicators

   ->

[Metrics 能力源]
MeterBinder / registry / meters

   ->

[Actuator 统一端点模型]
health / metrics endpoint

   ->

[外部消费]
probe / dashboard / alert / tracing-adjacent analysis

   ->

[生产决策]
可不可用判断 + 运行态趋势观察
```

这张图最重要的价值，不是背类名，而是把六个问题分开：

### 一、状态与资源事实

回答：Health 和 Metrics 最初都在观察哪些内部事实？

### 二、Health 能力源

回答：为什么 Health 不是一个总布尔值，而是由一组 indicator / contributor 提供内容？

### 三、Metrics 能力源

回答：为什么 Metrics 不是硬编码在端点里，而是由 binder 与 registry 持续供给？

### 四、Actuator 统一端点模型

回答：为什么它们最后都通过 Actuator 暴露，却仍然保持不同语义？

### 五、外部消费

回答：谁来消费 Health，谁来消费 Metrics？

### 六、生产决策

回答：为什么这两者必须同时存在，才能支撑完整生产判断？

## 一、Health 首先不是“一个 UP/DOWN 值”，而是一组内部状态贡献者被聚合后的判断结果

很多人第一次看 Health 端点时，最容易形成的印象就是：

- 最后不就是一个 status 吗

这个印象对最终输出是对的，但对内部结构是错的。

因为 Health 在 Boot 里首先不是：

- 一个固定布尔值

而是：

- **多种内部状态贡献源的聚合结果。**

也就是说，数据库健康、磁盘健康、Redis 健康、应用 Availability 状态等，都可以作为健康能力源进入 Actuator 健康体系。

这也是为什么 Boot 不只是提供一个 `HealthEndpoint`，还同时定义：

- `HealthIndicator`
- `HealthContributor`

它们的意义就在于：

- 把不同来源的健康事实先结构化地喂给端点系统

## 二、为什么 `ApplicationAvailability` 不能替代 Health，但又会成为 Health 的重要能力源

前一篇已经讲过，`ApplicationAvailability` 建模的是：

- LivenessState
- ReadinessState

这很容易让人误会：

- 那有了 Availability，是不是就不用讲 Health 了？

并不是。

更准确的关系是：

- Availability 解决的是应用生命周期与流量语义
- Health 解决的是更广义的运行可用性聚合

也就是说，Availability 更像：

- 特定维度的正式状态模型

而 Health 更像：

- 把多种状态与依赖事实聚合成最终健康结论的端点系统

所以 Availability 不是 Health 的替代品，而是：

- **Health 体系中的高价值能力源之一。**

这一点在本地源码里非常直接：

- `LivenessStateHealthIndicator` 依赖 `ApplicationAvailability`
- 并把 `LivenessState.CORRECT` 映射为 `Status.UP`、`LivenessState.BROKEN` 映射为 `Status.DOWN`
- `ReadinessStateHealthIndicator` 则把 `ReadinessState.ACCEPTING_TRAFFIC` 映射为 `Status.UP`、`ReadinessState.REFUSING_TRAFFIC` 映射为 `Status.OUT_OF_SERVICE`

也就是说，Availability 状态并没有绕开 Health，而是被 Health 端点体系显式消费。

## 三、Metrics 首先不是“几个数字端点”，而是一条持续采集与注册的量化事实链

和 Health 一样，Metrics 也常常被表面现象遮住。

很多用户只看到：

- `/actuator/metrics`

于是很容易以为：

- 它不过是把一些数字列出来

但从内部机制看，Metrics 真正的重点不是 endpoint，而是：

- **一条持续供给数值事实的采集链。**

也就是说，Metrics 之所以能暴露 JVM、HTTP、连接池、缓存、线程池等指标，不是因为 endpoint 自己知道这些信息，而是因为：

- `MeterBinder` 等能力源不断把指标注册进 registry

而本地文档与自动配置约定也把这条关系说得很直白：

- 只要 Spring 管理的 `MeterRegistry` 可用，`MeterBinder` beans 默认会被自动绑定进去

最终 `/actuator/metrics` 只是：

- 对这条采集链结果的一个查询入口

## 四、为什么 `MeterBinder` 对 Metrics 的地位，类似 `HealthIndicator` 对 Health 的地位

这一点必须单独钉死。

因为很多人会把：

- HealthIndicator
- MeterBinder

看成只是两种零散扩展接口。

更准确的理解应该是：

- `HealthIndicator` 是 Health 世界的内容源接口
- `MeterBinder` 是 Metrics 世界的内容源接口

也就是说，它们都不是 endpoint 本身，而是 endpoint 的事实输入层。

这正是 Actuator 真正像“子系统”的地方：

- 不是端点自己承载全部逻辑
- 而是先有能力源模型，再统一组织成端点输出

## 五、为什么 Health 更像“可不可继续信任这个实例”，Metrics 更像“这个实例现在正怎么运行”

只要把 Health 和 Metrics 的内部结构都立住，下一步最重要的就是把它们的语义边界彻底分开。

### Health 更关心什么

- 外部依赖是否可达
- 当前实例是否 ready
- 当前实例是否 still alive
- 现在是不是应该继续接流量

### Metrics 更关心什么

- 当前吞吐
- 当前延迟
- 当前 GC / heap / thread / pool 使用情况
- 这些数值是否在持续恶化或变化

也就是说，Health 给你的更像：

- 判断结果

而 Metrics 给你的更像：

- 连续观测数据

这也解释了为什么健康检查和指标图表在生产系统里往往一起看，但绝不能混用。

## 六、为什么外部系统消费 Health 和 Metrics 的方式天然不同

一旦语义边界分开，外部消费方式也就自然不同了。

### Health 的消费者常常是

- liveness probe
- readiness probe
- 自动摘流量 / 恢复流量逻辑
- 更直接的可用性报警

### Metrics 的消费者常常是

- Dashboard
- 时序数据库
- 指标平台
- SLO / 阈值告警系统
- 容量规划与趋势分析

也就是说，Health 更像：

- 对“现在该怎么判断”的输入

而 Metrics 更像：

- 对“过去和现在怎么分析”的输入

这再次说明，虽然它们都属于可观测性，但不是同一种可观测性。

## 七、最小源码证据：这两条能力源链确实不是“两个端点”，而是“贡献者模型 + 端点暴露”的协同结果

如果只讲到这里，读者仍然可能会觉得：

- 这是不是只是把端点含义讲得更细一点
- 源码里有没有直接证据说明 Health / Metrics 真有不同的能力源模型

先看 Availability 和 Health 的桥：

- `LivenessStateHealthIndicator` 依赖 `ApplicationAvailability`
- `ReadinessStateHealthIndicator` 依赖 `ApplicationAvailability`

这证明：

- Health 端点不是自己凭空知道应用是否存活或就绪
- 它在消费前一篇已经建立好的 Availability 状态模型
- Availability 状态先是内部模型，再被健康端点消费

如果再往 Health 聚合方向看一步，也要意识到：Health 不是某个 indicator 直接暴露成 URL，而是先把不同 `HealthIndicator` / `HealthContributor` 的结果组织进统一健康体系，再由 health endpoint 统一暴露。

再看 Metrics 这边的抽象路径：

- 指标不是 endpoint 自己现场采样
- 而是由 `MeterBinder` 等能力源先注册到 registry，再由端点查询和暴露

本地源码里，`MetricsAutoConfiguration` 相关路径正是围绕 `MeterRegistry` 这类资源锚点展开，而后续不同 export auto-configuration（Prometheus、JMX、OTLP 等）也是在 `MetricsAutoConfiguration` 之后继续把 registry 往外部系统桥接。

这说明两件事：

- Health 有自己的能力源模型
- Metrics 也有自己的能力源模型

它们最终虽然都进入 Actuator 端点体系，但并不是“一个监控接口两种展示方式”，而是：

- **两套不同生产语义通过同一 Actuator 体系被统一暴露。**

## 八、为什么这篇适合作为 Actuator 之后的深化篇

看到这里，最值得回收的一个问题就是：

- 为什么不把 Health / Metrics 全塞进上一篇 Actuator 总论里讲完？

因为上一篇解决的是：

- Actuator 为什么是独立运维端点子系统

而这一篇解决的是：

- 这个子系统里最重要的两类能力源，为什么本质上不是一回事

也就是说：

- 上一篇建立了端点体系
- 这一篇开始拆最核心的内容源语义

只有这样，读者才不会把 `/actuator/health` 和 `/actuator/metrics` 继续当成“两个差不多的监控接口”。

## 九、几个最容易错的判断

### 1. Health 和 Metrics 本质上都是监控，只是一个文字版、一个数字版

不成立。

Health 更偏判断语义，Metrics 更偏量化语义，它们解决的问题根本不同。

### 2. `ApplicationAvailability` 已经有 Liveness / Readiness 了，所以 Health 没那么重要

不成立。

Availability 是内部状态模型，Health 是更广义的健康聚合与端点暴露体系。

### 3. `/actuator/metrics` 里的指标主要是 endpoint 现场算出来的

不成立。

指标的核心来源是 `MeterBinder` 和 registry，不是 endpoint 临时拼装。

### 4. `HealthIndicator` 和 `MeterBinder` 只是一些方便扩展的接口，没有体系价值

不成立。

它们分别是 Health 和 Metrics 世界的内容源接口，是 Actuator 子系统真正可扩展的基础。

### 5. 有了 Health，就可以靠阈值推断 Metrics；有了 Metrics，也可以大致替代 Health

不成立。

它们在生产决策上会协同，但谁都不能替代谁。

## 收网：Boot 统一的不是“两个常用监控端点”，而是“把判断型状态与量化型运行事实分别组织成可被同一运维体系消费的两条能力源主线”

现在可以回到开头的问题：为什么 Health 和 Metrics 看起来都像监控，却不能混成一回事？

因为真实发生的不是“同一类监控信息的两种展示方式”，而是两条不同的能力源链：

```text
Health：依赖状态 / Availability / 健康贡献者
   -> 健康聚合
   -> 可用性判断

Metrics：MeterBinder / registry / 数值采集
   -> 指标端点
   -> 运行态量化观察
```

所以这篇真正该带走的结论不是“Actuator 里有 health 和 metrics 两个重要端点”，而是：

**Boot 把 Health 建模成面向可用性判断的状态聚合链，把 Metrics 建模成面向运行态量化的数值采集链，再通过同一套 Actuator 端点体系把它们统一暴露给探针、看板和告警系统；因此，生产系统既能回答‘现在能不能信任这个实例’，也能回答‘它现在是怎样运行的’。**