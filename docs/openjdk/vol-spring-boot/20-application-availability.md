# 为什么 Boot 不把“应用活着”只理解成进程还在：`ApplicationAvailability` 如何把 Liveness / Readiness 提升成应用状态模型

> 本文基于 Spring Boot 3.5.x 与 Spring Framework 6.2.x 当前源码。本文承接前一篇日志系统自动配置，继续进入生产层下一篇：`ApplicationAvailability`。重点放在 `ApplicationAvailability`、`AvailabilityState`、`LivenessState`、`ReadinessState`、`AvailabilityChangeEvent` 以及它们和启动生命周期、云原生探针、Actuator 健康端点之间的关系。本文不把重点放在某个单独 endpoint，而是回答：为什么 Boot 要把“存活”和“就绪”提升成一套独立的应用运行状态模型。下一篇将继续进入 Actuator 主体端点体系或 Metrics / Health 深化主线。

## 为什么进程没挂、端口也还在监听，Boot 却仍然要区分“活着”和“准备好接流量”

只要做过一点生产环境运维，就会很快遇到一个看似简单、但实际上非常关键的问题：

- 一个应用进程还在
- JVM 也还没退出
- 端口甚至还能连通
- 但它到底算不算“可用”？

这个问题在单机开发时常常不明显，但一旦进入：

- Kubernetes
- 自动重启
- 流量摘除
- 灰度发布
- 滚动升级

这样的运行环境，差别就会立刻变得巨大。

因为生产里真正需要回答的，往往不是一句粗糙的：

- 应用是不是还活着

而是两句不同的话：

- 它是不是还“活着”
- 它是不是已经“准备好接流量”

这两者不是同一个问题。

Boot 正是从这里开始，把“应用运行状态”从一个模糊判断，提升成一套独立模型。

第一层问题是：**进程存活不等于应用健康，更不等于应用已经准备好对外服务。**

例如一个应用可能：

- 进程还在
- 端口也已打开
- 但核心依赖尚未建立
- 初始化任务尚未完成
- 某些后台恢复流程尚未结束

这时如果外部系统只根据“端口还在”就继续打流量，就可能直接把请求打到一个：

- 技术上还活着
- 业务上却还没准备好的实例

也就是说，Boot 这里面对的不是“监控更细一点”，而是：

- **应用运行状态本来就至少有两个层次。**

第二层问题是：**这种状态不能只靠某个健康检查接口临时拼出来，而必须被建模成应用生命周期中的正式状态。**

如果没有统一状态模型，外部系统就只能：

- 猜应用当前阶段
- 从日志里推断是否 ready
- 从某个零散指标里反推是否还活着

这会让“存活”和“就绪”变成一堆经验规则，而不是框架级语义。

所以 Boot 需要的不是：

- 多做一个检查接口

而是：

- **在应用内部先建立明确的 Availability 状态模型。**

第三层问题是：**`ApplicationAvailability` 的价值不只是给探针用，而是把应用运行状态和 Spring 事件、Actuator、启动主线接起来。**

也就是说，Boot 并不是只想满足：

- liveness probe
- readiness probe

它真正要做的是：

- 应用内部状态可以显式改变
- 状态变更可以通过事件传播
- 外部暴露层可以消费这些状态
- 运行时与启动时都能统一理解状态变化

这说明 `ApplicationAvailability` 不是一个小工具，而是：

- **Boot 生产运行模型的一部分。**

因此，本文真正要回答的问题不是“Boot 支持 liveness/readiness 吗”，而是：

**为什么对 Boot 来说，必须把存活与就绪建模成独立的 Availability 状态，并通过 `ApplicationAvailability`、`AvailabilityChangeEvent` 和启动生命周期把这些状态统一组织起来，应用在云原生运行环境里才真正具备可感知、可编排、可流量控制的状态语义。**

## 先看失败方案：为什么不能把“活着”简化成进程存在、不能把“就绪”临时写成某个判断、也不能只靠 Actuator endpoint 反推应用状态

### 失败方案一：只要 JVM 进程还在，就说明应用活着也可用了

这是最粗糙也最危险的判断。

因为进程存在最多只能说明：

- JVM 还没退出

却不能说明：

- 应用内部核心逻辑还在正常运行
- 外部依赖是否已经失效
- 应用是否仍适合继续接流量

更关键的是，“可用”本身就不是单一状态。

所以把“进程活着”直接等同于“应用可用”，在生产里几乎一定会失真。

### 失败方案二：就绪状态临时在某个 Controller 或健康检查里现算就行

这比只看进程要进了一步，但仍然不够。

因为如果“ready 不 ready”只是某个 endpoint 里现算出来的结果，就会出现：

- 状态语义散落在不同地方
- 启动过程中的状态变化没有统一事件
- 外部系统读到的是结果，但内部系统没有统一状态模型可依赖

也就是说，readiness 不应该只是：

- 一个 endpoint 的返回值

而应该是：

- **应用内部已存在并可传播的正式状态。**

### 失败方案三：反正 Actuator 有 health endpoint，状态模型不需要单独存在

这是很容易混淆的一点。

Actuator 当然可以暴露应用状态，但“暴露”不是“建模”。

如果没有 `ApplicationAvailability` 这种内部状态模型，Actuator 端点本身就只能：

- 即席拼装结果
- 或从别处侧面推断状态

这会让：

- 内部生命周期
- 状态变更事件
- 外部 probe 暴露

三者之间缺少统一语义来源。

所以 Boot 不能只停在“有个 endpoint”，而必须先建立：

- **应用内部的 Availability 状态模型。**

## ApplicationAvailability 的最小总图

如果把这条状态链先压缩成最小模型，它可以写成下面这样：

```text
application lifecycle changes
   -> AvailabilityChangeEvent
   -> ApplicationAvailability holds current state
   -> liveness/readiness can be queried and exposed
```

如果再换一种更适合理解职责的拆法，它可以分成下面五层：

```text
[内部状态模型]
AvailabilityState / LivenessState / ReadinessState

   ->

[状态存储与查询]
ApplicationAvailability

   ->

[状态变更机制]
AvailabilityChangeEvent

   ->

[启动与运行期时序]
Application events / lifecycle transitions

   ->

[外部消费]
Actuator / probes / orchestration systems
```

这张图最重要的价值，不是背类名，而是把五个问题分开：

### 一、内部状态模型

回答：为什么 Boot 要把 liveness/readiness 先定义成状态类型？

### 二、状态存储与查询

回答：为什么应用里需要一个统一的 `ApplicationAvailability` 查询入口？

### 三、状态变更机制

回答：为什么状态变化要通过事件传播，而不是每次现算？

### 四、启动与运行期时序

回答：这些状态什么时候切换，为什么和生命周期紧密相关？

### 五、外部消费

回答：为什么外部 probe、Actuator、编排系统只是消费者，而不是状态源头？

## 一、`ApplicationAvailability` 先解决的不是“怎么暴露 endpoint”，而是“应用内部到底有哪些正式状态”

回到最外层，很多人第一次听到 liveness/readiness 时，天然会先想到：

- 健康检查接口
- K8s probe

但 Boot 更早解决的其实不是暴露，而是建模。

也就是说，它首先回答的不是：

- 外面怎么查这个状态

而是：

- **应用内部到底有没有一套可被统一理解的状态类型。**

只有这一步先成立，后面：

- 事件传播
- Actuator 暴露
- probe 消费

才不会变成不同地方各写各的状态语义。

## 二、为什么 Boot 要把 `LivenessState` 和 `ReadinessState` 分开，而不是统一成一个 health 概念

这一点是整篇最该被钉死的边界。

如果只用一个统一 `health` 概念，很多真实场景都会被抹平：

- 应用进程仍然正常运转
- 但数据库初始化任务还没完成
- 这时它可能仍然“活着”，却还“不该接流量”

反过来，也可能出现：

- 就绪状态曾经是 ready
- 但后续某种故障已让应用不再适合接请求
- yet 进程本身仍然没有死掉

所以：

- liveness 回答“这个应用是不是还处在可继续运行的生命状态”
- readiness 回答“这个应用是不是已经准备好接服务流量”

这两个问题天然不是一个问题。

也就是说，Boot 在这里不是把状态拆细一点，而是在承认：

- **应用运行语义本来就至少有两个不同维度。**

## 三、为什么状态变化必须通过 `AvailabilityChangeEvent` 传播，而不是靠外部系统每次现算

只要状态模型已经建立，下一步最关键的问题就是：

- 状态怎么变？

Boot 的答案不是：

- 外部系统每次自己去猜
- 每个 endpoint 每次现场判断

而是：

- 通过 `AvailabilityChangeEvent` 显式传播状态变化

这一步非常关键，因为它意味着：

- 状态改变本身成为应用内部可观察事件
- 其他组件可以围绕状态变化做联动
- 外部暴露层也不必自行定义状态含义

源码上的关键结构也很直接：

```java
public class AvailabilityChangeEvent<S extends AvailabilityState> extends PayloadApplicationEvent<S> {

    public S getState() {
        return getPayload();
    }

    public static <S extends AvailabilityState> void publish(ApplicationContext context, S state) {
        publish(context, context, state);
    }

    public static <S extends AvailabilityState> void publish(ApplicationEventPublisher publisher, Object source,
            S state) {
        publisher.publishEvent(new AvailabilityChangeEvent<>(source, state));
    }
}
```

这说明 Availability 状态变化不是隐藏在某个实现细节里的内部标记，而是明确通过 Spring 事件系统发布的。

也就是说，Boot 不是把状态当成“一个静态字段”，而是当成：

- **生命周期中会变化、且应被传播的正式事件。**

## 四、为什么 `ApplicationAvailability` 比单纯的 event listener 更重要：它让状态不仅能变，还能被稳定查询

如果只有事件，没有统一查询入口，也会很快出现问题。

因为很多时候，调用方关心的并不是：

- 某个状态曾经什么时候变化过

而是：

- 现在的 liveness 是什么
- 现在的 readiness 是什么

这就是 `ApplicationAvailability` 存在的价值。

它不是单纯替代事件，而是提供：

- **应用当前 Availability 状态的统一查询视图。**

本地源码里，真正默认落地这个抽象的是：

```java
@AutoConfiguration
public class ApplicationAvailabilityAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(ApplicationAvailability.class)
    public ApplicationAvailabilityBean applicationAvailability() {
        return new ApplicationAvailabilityBean();
    }
}
```

而 `ApplicationAvailabilityBean` 本身的机制也很直接：

- 它实现 `ApplicationAvailability`
- 同时实现 `ApplicationListener<AvailabilityChangeEvent<?>>`
- 内部用一个 `ConcurrentHashMap` 保存各类 AvailabilityState 的最新事件
- `getState(...)` / `getLastChangeEvent(...)` 则提供当前查询视图

也就是说，Boot 在这里把状态系统分成了两层：

- 变化靠事件传播
- 当前值靠 `ApplicationAvailability` 查询

这样：

- 启动主线可以推动状态变化
- Actuator / probe / 业务内部组件可以稳定消费当前状态

## 五、为什么这套状态模型和启动生命周期天然耦合

只要继续往下看，就会发现 Availability 状态并不是一个和生命周期无关的独立小工具。

它和应用启动 / 运行 / 失败之间天然有很强的时序关系。

例如最直观的场景就是：

- 应用刚启动时，不该一上来就被视为 ready
- 关键初始化完成之后，才更合理地切到 readiness ready
- 某些运行时故障或停机阶段，又可能推动状态再次变化

本地测试还给出了两个很关键的默认事实：

- 在没有任何事件发布前，`ApplicationAvailabilityBean` 的 liveness 默认被视为 `BROKEN`
- 在没有任何事件发布前，readiness 默认被视为 `REFUSING_TRAFFIC`

这说明 Availability 的价值不只是“提供两个枚举”，而是：

- **让启动和运行时阶段变化，可以在状态模型中被明确表达。**

这也是为什么它和前面 `SpringApplication.run()`、FailureAnalyzer、日志系统这些生产层主题是天然相连的。

## 六、为什么用户最终感知到的不是“多了几个状态类”，而是“这个应用终于能被编排系统正确理解”

站在源码视角，我们当然可以把这条链拆成很多层：

- state 类型
- event
- availability 查询
- 外部暴露

但站在生产使用者角度，真正重要的通常只有一句话：

- 现在外部系统终于能更准确地知道这个应用到底是活着、准备好、还是不该再接流量

这恰恰说明 Boot 在这里做对了。

因为它并没有让用户直接暴露在：

- 事件类怎么发
- availability 怎么实现
- 当前状态怎样存储

这些机制细节里，而是把它们压缩成了：

- 一个可被运维系统、探针和运行平台共同理解的应用状态模型

也就是说，Boot 在这里追求的不是“多几个状态 API”，而是：

- **让应用运行状态成为可被编排和自动化消费的正式语义。**

## 七、最小源码证据：这条链确实是“状态类型 -> 变化事件 -> 当前状态查询 -> 外部消费”的独立运行状态模型

如果只讲到这里，读者仍然可能会觉得：

- 这是不是只是对云原生探针概念的框架包装
- 源码里有没有直接证据说明 Boot 真把它做成了一套内部状态模型

先看默认实现这层：

- `ApplicationAvailabilityAutoConfiguration` 会在缺失 `ApplicationAvailability` 时注册 `ApplicationAvailabilityBean`
- `ApplicationAvailabilityBean` 通过监听 `AvailabilityChangeEvent<?>` 来维护当前状态视图

再看外部消费桥：

- `LivenessStateHealthIndicator` 直接依赖 `ApplicationAvailability`
- `ReadinessStateHealthIndicator` 也直接依赖 `ApplicationAvailability`
- 它们分别把 `LivenessState.CORRECT/BROKEN` 和 `ReadinessState.ACCEPTING_TRAFFIC/REFUSING_TRAFFIC` 映射成 Actuator health 状态

这说明第一层事实：

- Boot 先在应用内部建立了状态模型和状态变更机制

第二层事实则是：

- Actuator、probe、编排系统并不是状态源
- 它们消费的是 Boot 应用内部已经建好的 Availability 语义

也就是说，Boot 在这里的真实结构不是：

- “给 K8s 多加了两个检查项”

而是：

- **先在应用内部建立 Availability 状态模型，再让外部系统消费它。**

## 八、为什么这篇适合作为日志系统之后的生产层下一篇

看到这里，最值得回收的一个问题就是：

- 为什么日志之后立刻讲 `ApplicationAvailability`？

因为这两篇刚好分别代表了生产层的两个方向：

### 日志系统解决的是

- 启动和运行时信息怎样尽早可见

### ApplicationAvailability 解决的是

- 应用运行状态怎样被统一建模并可被外部编排系统消费

也就是说，顺序上：

- 先让应用尽早“可见”
- 再让应用尽早“可被正确判断状态”

这正好把生产层从“输出能力”推进到“运行状态语义”。

## 九、几个最容易错的判断

### 1. 只要进程没挂，应用就算活着也 ready 了

不成立。

liveness 和 readiness 回答的是两个不同问题，不能都简化成进程是否存在。

### 2. readiness 只是某个 health endpoint 的一个字段，不需要单独建模

不成立。

如果没有统一的内部状态模型，它就只能是零散输出结果，而不是框架级运行语义。

### 3. `ApplicationAvailability` 只是给 Kubernetes 用的小工具

不成立。

它本质上是 Boot 应用运行状态模型的一部分，K8s 只是其中一个重要消费者。

### 4. `AvailabilityChangeEvent` 只是事件通知的小细节，没有主线价值

不成立。

它承担的是状态变化如何被显式传播的核心机制。

### 5. 这篇和前面的启动、日志、FailureAnalyzer 主线关系不大

不成立。

它们共同构成的恰恰是：Boot 如何让应用在启动、失败、运行中都更可见、更可判断、更可编排。

## 收网：Boot 统一的不是“多暴露两个健康检查字段”，而是“把应用运行状态提升成可被内部主线和外部系统共同消费的正式语义”

现在可以回到开头的问题：为什么 Boot 不把“应用活着”只理解成进程还在，而要单独建模 `Liveness` / `Readiness`？

因为真实发生的不是“多加了两个探针名词”，而是一条状态模型链：

```text
启动与运行生命周期
   -> AvailabilityChangeEvent
   -> ApplicationAvailability 持有当前状态
   -> Liveness / Readiness 成为正式运行语义
   -> Actuator / probe / 编排系统消费这些状态
```

所以这篇真正该带走的结论不是“Boot 支持 liveness/readiness”，而是：

**Boot 先把应用运行状态建模成 `ApplicationAvailability`、`AvailabilityState` 和 `AvailabilityChangeEvent` 这套内部语义，再让 Actuator 和编排系统去消费它；因此，应用状态不再只是进程层面的粗糙判断，而是一个可传播、可查询、可编排的正式运行模型。**