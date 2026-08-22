# 为什么 `/actuator/conditions`、`/actuator/configprops`、`/actuator/mappings` 不是三个独立信息端点：它们如何构成 Boot 自动配置诊断的最小闭环

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接前一篇 `loggers` 端点，继续进入 Actuator 自动配置诊断核心端点组：`conditions`、`configprops`、`mappings`。重点放在 `ConditionsReportEndpoint`、`ConfigurationPropertiesReportEndpoint`、`MappingsEndpoint` 各自回答的问题，以及三者为什么合在一起才能构成 Boot 自动配置诊断的最小闭环。下一篇将继续进入 `startup` 端点与启动观测。

## 为什么三个端点合在一起看，才能回答“Boot 自动配置到底装了什么、绑定了什么、跑出了什么”

很多人单独看某个端点时，只能回答一部分问题：

- 看 `conditions` 会知道“自动配置为什么没装”
- 看 `configprops` 会知道“配置绑定成了什么值”
- 看 `mappings` 会知道“Web 路由最终是什么”

但生产里真正要回答的往往是：

- 为什么这个自动配置没生效
- 配置值为什么没有按预期绑定
- 为什么 Controller 的 URL 不是预期的路径

这三个问题，任何单独一个端点都回答不完整。

**第一层问题是：`conditions` 回答的是“自动配置为什么命中或未命中”，但它不能回答“最终绑定了什么”。**

**第二层问题是：`configprops` 回答的是“配置绑定结果是什么”，但它不能回答“为什么这个配置没被读到”。**

**第三层问题是：`mappings` 回答的是“Web 路由最终是什么”，但它不能回答“为什么 Controller 没有映射到预期路径”。**

也就是说，这三个端点不是并列的三个信息工具，而是：

- **Boot 自动配置诊断的因果闭环。**

## 先看失败方案：为什么不能只看 `--debug` 日志、不能只看 `configprops`、不能只盯着 `mappings`

### 失败方案一：条件诊断靠 `--debug` 日志就够了

`--debug` 日志能打印条件评估结果，所以很多人以为：

- 要看自动配置为什么没装，看日志就行

但这个方案只能回答“conditions”这一环。

它无法回答：

- 如果条件命中了，那么 properties 最终绑定成了什么
- 如果真的绑定了，那么 Web 路由最终注册成了什么

也就是说，日志再详细，也只是把“conditions”这一环暴露出来。

### 失败方案二：`configprops` 已经覆盖了自动配置诊断

`configprops` 只暴露：

- 配置绑定结果

它不能回答：

- 这个配置对象背后的自动配置类条件是否命中
- 这个配置对象是否已经真正注册成 Bean
- 配置对象最终是否影响到了 Web 路由

所以只看 `configprops`，只能看到“绑定层”，不能看到“条件层”和“运行层”。

### 失败方案三：`mappings` 已经是最重要的端点

`mappings` 只暴露：

- Web 路由最终结果

它不能回答：

- 某个路由背后的 Handler 为什么没出现
- 绑定到该 Handler 的 properties 为什么变成这样
- 某个自动配置为什么根本没让它注册

所以看 `mappings` 只能看到“结果”，看不到“为什么是结果”。

## 三个端点的最小总图

```text
自动配置候选 + 条件
   -> /actuator/conditions   : 谁命中 / 谁没命中 / 为什么
自动配置绑定的 properties
   -> /actuator/configprops  : 绑定成什么值 / 有没有绑定失败
自动配置生成的 Web 入口
   -> /actuator/mappings     : 哪个 URL 对应哪个 handler
```

```text
[条件层]
conditions

   ->

[绑定层]
configprops

   ->

[运行层]
mappings
```

## 一、`conditions`：回答“自动配置为什么命中或未命中”

`conditions` 端点主要暴露自动配置条件的评估结果。

它回答的是：

- 某个自动配置类是否命中
- 某个条件是否成立
- 未命中时，是哪个条件不满足

它本质上把 SQL-like 的条件日志变成了结构化诊断。

从源码实现看，`ConditionsReportEndpoint` 的数据源是 `ConditionEvaluationReport.get(beanFactory)`，它把条件评估结果按配置类分组为 match / negative 两类并暴露。也就是说，它没有发明新裁决机制，而是把裁决结果对外可见。

但它是“为什么层”：

- 它告诉你为什么这个东西装 / 没装
- 不告诉你装好后绑定了什么

## 二、`configprops`：回答“配置绑定成了什么”

`configprops` 端点主要暴露 `@ConfigurationProperties` 的绑定结果。

它回答的是：

- 某个 properties 类绑定了哪些属性
- 某些属性最终绑定成什么值
- 有没有绑定失败或覆盖

从源码实现看，`ConfigurationPropertiesReportEndpoint` 会从 `ApplicationContext` 中收集所有 `@ConfigurationProperties` Bean 的绑定结果，包括名称、属性值（经过 sanitizer 处理）和绑定来源，然后序列化输出。

它是“绑定层”：

- 把配置从字符串变成对象后的最终状态暴露出来
- 不告诉你这些属性对应的自动配置条件是否命中

## 三、`mappings`：回答“Web 路由最终是什么”

`mappings` 端点主要暴露 Spring MVC（或 WebFlux）的 handler mapping 结果。

它回答的是：

- 当前有哪些 Web 路由
- 每个 URL 对应哪个 controller method
- 路由的参数、请求方法、produces/consumes 等信息

从源码实现看，`MappingsEndpoint` 从 `ApplicationContext` 中收集所有 `HandlerMapping` 实例，并向每个 `HandlerMapping` 查询其已注册的映射明细，然后统一聚合输出。

它是“运行层”：

- 把自动配置 + 绑定结果最终在 Web 世界里的样子暴露出来
- 不告诉你为什么这个路由能出现或不能出现

## 四、为什么这三个端点必须放在一起，才能构成闭环

### conditions 回答“为什么会有这个能力”

它站在自动配置候选进入容器之前，解释条件系统如何裁决。

### configprops 回答“这个能力的配置是什么”

它站在 properties 绑定层，解释配置对象最终状态。

### mappings 回答“这个能力最终运行成什么”

它站在 Web 运行层，解释路由和 handler 的最终映射。

一条完整的自动配置问题链路是：

```text
为什么这个能力出现 / 不出现  -> conditions
这个能力绑定成什么配置         -> configprops
这个能力最终以什么 Web 形态存在 -> mappings
```

所以它们不是「三个端点」，而是：

- **自动配置问题从条件到绑定再到运行的因果链。**

这里也要说清楚：这个“闭环”是诊断用法上的闭环，不是三者在内部相互依赖；每个端点都是独立暴露数据，但排障时应该按这条因果链串联使用，而不是只依赖其中某一个端点。`conditions` 不解释 Web 路由为什么 404，`mappings` 也不解释配置为什么没读到；它们各自只承担自己那一层，但合起来才能覆盖完整的自动配置诊断场景。

## 五、为什么这篇要强调“闭环”而不是“三个端点各写一篇”

如果只写单端点介绍，很容易变成：

- `conditions` 怎么用
- `configprops` 怎么用
- `mappings` 怎么用

三个独立用法说明。

但生产排障里，用户通常先发现问题，再顺着因果链排查：

- 接口 404 → 看 mappings
- mappings 没有这个路由 → 看 conditions 确认自动配置
- conditions 命中了但值不对 → 看 configprops

这是一条连续的诊断路径。

如果把它拆成三个孤立说明，读者很容易只记住“有这三个端点”，却记不住“怎么用它定位一个自动配置问题”。

所以这篇的定位是：

- **把三个端点放到一条诊断闭环里讲**
- 让读者知道每个端点各自承担哪一环

## 六、为什么这篇应该作为 Actuator 详细规划的独立一篇

在已冻结的 Actuator 规划里，你是支持的：

- `health / metrics / info / loggers / conditions / configprops / mappings / heapdump / threaddump / startup`

都是核心端点。

而且 `conditions / configprops / mappings` 这三个不仅重要，还共享同一个大问题：

- Boot 自动配置到底装了什么、配成了什么、跑成了什么

所以它们值得作为「自动配置诊断闭环」单独成篇，而不是塞进端点总论里一笔带过。

## 七、最小源码证据：三个端点各自读取不同数据源，但共同构成诊断闭环

`conditions` 的数据源是 `ConditionEvaluationReport.get(beanFactory)`，`ConditionsReportEndpoint` 位于 `spring-boot-actuator-autoconfigure/.../condition/ConditionsReportEndpoint.java`，它将条件评估结果按配置类分组为 match / negative 两类暴露。

`configprops` 的数据源是 `ApplicationContext` 中所有 `@ConfigurationProperties` Bean 的绑定结果，`ConfigurationPropertiesReportEndpoint` 位于 `spring-boot-actuator/.../context/properties/ConfigurationPropertiesReportEndpoint.java`。

`mappings` 的数据源是 `ApplicationContext` 中的 `HandlerMapping` 实例，`MappingsEndpoint` 位于 `spring-boot-actuator/.../web/mappings/MappingsEndpoint.java`，它会遍历每个 `HandlerMapping` 收集已注册的映射明细。

三者各自读取不同数据源，各自有独立的端点实现和自动配置入口；但排障时按 conditions → configprops → mappings 这条因果链串联使用，才能覆盖完整的自动配置诊断场景。

## 八、几个最容易错的判断

### 1. `conditions` 只是 `--debug` 日志的翻版

不成立。

它是一种结构化的自动配置条件评估入口，可以按类排查。

### 2. `configprops` 已经覆盖了自动配置诊断

不成立。

它只覆盖绑定层，不覆盖条件层与 Web 运行层。

### 3. `mappings` 是最重要的一个端点

不完整。

它只覆盖 Web 路由结果，无法解释“为什么这个路由没出现”。

### 4. 这三个端点可以不讲闭环关系，分别列一列就行

不成立。

生产排障是顺因果链走的，三个端点必须放在一起讲。

### 5. Boot 自动配置诊断只看一个端点就够

不成立。

完整的自动配置诊断是 conditions → configprops → mappings 的三段式闭环。

## 九、收网：`conditions / configprops / mappings` 统一的不是三个信息端点，而是 Boot 自动配置问题从条件到绑定再到运行的诊断闭环

现在可以回到开头的问题：为什么三个端点合在一起看，才能回答“Boot 自动配置到底装了什么、绑定了什么、跑出了什么”？

因为它们各自只承担一个环节：

- `conditions`：自动配置为什么命中 / 未命中
- `configprops`：配置绑定成了什么
- `mappings`：Web 路由最终是什么

把它们放在一起，才构成一条完整的自动配置诊断链：

```text
为什么有这个能力   -> conditions
这个能力配成了什么  -> configprops
这个能力跑成了什么  -> mappings
```

所以这篇真正该带走的结论不是「记住了三个端点」，而是：

**`conditions`、`configprops`、`mappings` 分别站在自动配置的条件层、绑定层和运行层，构成从「为什么装」到「绑定成什么」再到「跑成什么」的诊断闭环；它们是同一类生产问题被拆成三段后的三个入口，而不是三个互相独立的信息端点。**