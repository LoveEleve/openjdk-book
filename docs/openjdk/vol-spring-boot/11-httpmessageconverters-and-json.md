# 为什么 Boot Web 应用几乎天生就会收发 JSON：`HttpMessageConverters` 与消息转换默认体验

> 本文基于 Spring Boot 3.5.x 与 Spring Framework 6.2.x 当前源码。本文承接前一篇 `DispatcherServlet` 注册与默认映射，继续进入 Web 默认体验中用户感知最强的一环：请求体与响应体为什么能在不手工配置的情况下，自然完成对象和 JSON 之间的转换。重点放在 `HttpMessageConvertersAutoConfiguration`、Jackson 相关自动配置、`HttpMessageConverters` 聚合对象，以及它们怎样和 Spring MVC 的参数解析与返回值处理链接起来。下一篇将继续进入 DataSource / JDBC 自动配置。

## 为什么什么都没配，`@RequestBody` 和 `@ResponseBody` 却好像天生就会工作

只要做过 Spring Boot Web 开发，几乎都会习惯一种非常强烈的默认体验：

- Controller 里写一个 `@RequestBody`
- 客户端发来 JSON
- 方法参数就自动变成 Java 对象

反过来：

- 返回一个普通对象
- 再加上 `@ResponseBody` 或直接用 `@RestController`
- 返回值就自动变成 JSON

这件事熟悉到很容易让人误以为：

- Spring MVC 天生就会 JSON
- Boot 只是顺手帮你开了一下开关

但如果认真退回到没有 Boot 自动装配的世界，这其实远不是“顺手开关”那么简单。

因为要让“对象 <-> JSON”默认工作起来，至少要同时解决：

- classpath 上有没有 JSON 相关实现
- 该把哪些 `HttpMessageConverter` 放进 MVC 链
- 默认 `ObjectMapper` 用什么配置
- 用户自己加的 converter、模块、customizer 应该怎样参与
- 这些默认能力怎样和参数解析、返回值处理正确衔接

也就是说，用户感知到的是：

- “Boot Web 默认会 JSON”

但源码层面真实发生的是：

- **JSON 相关依赖、默认 `ObjectMapper`、消息转换器列表和 MVC 读写链路已经被协同装配成一套默认消息转换环境。**

第一层问题是：**`@RequestBody` / `@ResponseBody` 能工作，不是因为 Controller 注解自己会 JSON，而是因为 MVC 背后已经有一套可用的消息转换器链。**

前面 `vol-spring` 已经讲过：

- 参数解析器链会在合适位置把请求体交给消息转换器
- 返回值处理链也会在合适位置把对象交给消息转换器写回响应

也就是说，JSON 体验并不直接长在注解上，而是依赖：

- `HttpMessageConverter` 列表已经准备好

第二层问题是：**Boot 不能只盯着 Jackson 单个类，而必须把“默认消息转换环境”作为整体装起来。**

而且这套自动配置本身也不只服务 JSON：它还会组织 String 等通用 `HttpMessageConverter`，并通过条件排除 Reactive Web 应用。因此本篇虽然以 JSON 为主线，但不能把 `HttpMessageConvertersAutoConfiguration` 简化成“Jackson 自动配置的另一层名字”。

如果只做一件事：

- 容器里多一个 `ObjectMapper`

那远远不够。

因为 MVC 还需要知道：

- 哪个 converter 支持读 JSON
- 哪个 converter 支持写 JSON
- 它们在整个 converter 列表里的顺序是什么
- 用户自定义 converter 和默认 converter 怎样共存

所以 Boot 解决的不是“给你一个 Jackson”，而是：

- **把 JSON 能力接进 MVC 消息转换体系。**

第三层问题是：**Boot 的默认 JSON 体验不仅要可用，还必须允许用户渐进式接管。**

这一点和前几篇的主线完全一致。

如果 Boot 把 JSON 行为完全写死：

- 日期格式
- 序列化特性
- 自定义模块
- converter 顺序

都不允许用户干预

那它很快就会从“默认方便”变成“默认阻碍”。

所以 Boot 必须维持一个平衡：

- 默认先给你一套够用的 JSON 转换链
- 但用户仍然可以通过 customizer、module、converter 或显式 Bean 去接管细节

因此，本文真正要回答的问题不是“Boot 默认用 Jackson”，而是：

**为什么对 Boot 来说，必须把 JSON 相关依赖、`ObjectMapper`、`HttpMessageConverter` 列表和 MVC 读写链路统一组织成一套默认消息转换环境，并让这套环境始终保持可扩展、可覆盖、可退让。**

## 先看失败方案：为什么不能只 new 一个 `ObjectMapper`、不能只把单个 converter 塞进容器、也不能把 JSON 行为完全写死

### 失败方案一：只要容器里有一个 `ObjectMapper`，JSON 默认体验就算配好了

这是最容易出现的错觉。

因为用户最容易感知到的 JSON 核心对象就是：

- `ObjectMapper`

但它只是 JSON 世界的一部分，不是 MVC 消息转换环境的全部。

即便已经有 `ObjectMapper`，如果没有：

- 把它包进合适的 `HttpMessageConverter`
- 再把 converter 列表接进 MVC 读写链

那么：

- `@RequestBody` 仍然不会自动读 JSON
- `@ResponseBody` 也不会自动写 JSON

也就是说，`ObjectMapper` 是必要条件，但不是完整结果。

### 失败方案二：只注册一个 JSON converter，其他消息转换问题以后再说

这个方案比只看 `ObjectMapper` 更进一步，但仍然不够。

因为真实 Web 应用面对的消息体并不只有 JSON：

- String
- byte[]
- Resource
- form data
- XML（在某些技术栈里）
- 以及 JSON

如果 Boot 只盯一个 JSON converter，就很容易破坏整体消息转换链的协调：

- 顺序不清楚
- 其它默认 converter 怎么共存不清楚
- MVC 最终选择哪个 converter 的行为也会变得难以预测

所以 Boot 需要的不是“单个 JSON converter”，而是：

- **一整套可排序、可扩展、可整体消费的 converter 列表。**

### 失败方案三：默认 JSON 行为全部写死，不给用户任何调优空间

这会立刻毁掉 Boot 在真实项目中的可用性。

因为用户非常常见的需求就是：

- 我接受默认 JSON 链
- 但我想微调对象映射行为

例如：

- 注册自定义 Jackson module
- 改日期格式
- 改 null 处理
- 改某些序列化/反序列化特性
- 增减 converter

如果 Boot 不留扩展口，用户就只能：

- 整套退出默认 JSON 体验
- 自己接管全部 MVC 消息转换配置

这显然和 Boot 一贯的“默认成立，用户渐进式接管”相违背。

## 消息转换默认体验的最小总图

如果把这条链先压缩成最小模型，它可以写成下面这样：

```text
starter-web
   -> json libraries on classpath
   -> Jackson/ObjectMapper auto-config
   -> HttpMessageConverters auto-config
   -> MVC read/write pipeline can consume converters
   -> @RequestBody / @ResponseBody JSON works by default
```

如果再换一种更适合理解层级的拆法，它可以分成下面五层：

```text
[依赖前提]
JSON 相关依赖进入 classpath

   ->

[映射核心]
ObjectMapper / Gson / Jsonb / builder / customizers / modules

   ->

[转换器聚合]
HttpMessageConverters

   ->

[MVC 接线]
参数解析 / 返回值处理消费 converter 列表

   ->

[默认体验]
@RequestBody / @ResponseBody / RestController 开箱可用
```

这张图最重要的价值，不是背配置类名，而是把五个问题分开：

### 一、依赖前提

回答：为什么 starter 一引入，JSON 默认体验 suddenly 有了成立前提？

### 二、映射核心

回答：谁负责把默认 `ObjectMapper` 及其定制链组织起来？

### 三、转换器聚合

回答：谁负责把各种 converter 收口成一套可整体消费的消息转换列表？

### 四、MVC 接线

回答：这些 converter 怎样进入 MVC 读写链，而不是只作为孤立 Bean 存在？

### 五、默认体验

回答：为什么最终用户会感知成“Controller 天生会 JSON”？

## 一、Web starter 先改变的是 JSON 相关类路径事实，而不是直接让 MVC 会 JSON

上一篇已经讲过 starter 的本质：

- 它先改变 classpath 事实

所以回到 JSON 场景，第一步不能直接问：

- 为什么 `@RequestBody` 会反序列化 JSON

而应该先问：

- 为什么 Boot 现在有资格把 JSON 相关能力接进 MVC

以最常见的 Web 路径来说，`spring-boot-starter-web` 会带来：

- `spring-boot-starter-json`
- MVC 所需的 Web 依赖

这意味着：

- Jackson 相关类在 classpath 上可见
- JSON 相关自动配置条件有机会成立
- MVC 读写链现在终于有可能获得 JSON converter

也就是说，starter 到这里做的仍然不是“直接完成 JSON 转换”，而是：

- **先让 JSON 默认体验具备成立前提。**

## 二、为什么 Boot 必须先把 `ObjectMapper` 及其定制链组织起来

只要 JSON 相关依赖已经在 classpath 上，下一步最重要的问题就是：

- 默认到底要用哪个 JSON 映射核心

在当前最常见的 Servlet MVC 路径里，答案通常是：

- Jackson `ObjectMapper`

但这不是消息转换自动配置对所有环境的唯一可能实现；Boot 也保留 Gson、Jsonb 等分支，具体哪一支成立仍由类路径和对应条件决定。

Boot 关心的不是“有没有一个 mapper”这么粗的事实，而是：

- 默认 mapper 怎样创建
- builder 怎样参与
- 用户自定义 module 怎样参与
- customizer 怎样影响最终 mapper

也就是说，Boot 在这里解决的不是“选一个 JSON 库完事”，而是：

- **先把默认对象映射核心及其扩展链组织起来。**

只有这样，后面消息转换器用到的才不是一个裸对象，而是一套可定制的默认映射环境。

## 三、`HttpMessageConverters`：Boot 不是只放几个 converter，而是先把它们收口成一个整体对象

这是理解 Boot JSON 默认体验时最容易被忽视的一步。

很多人会自然地以为：

- MVC 自己会去容器里找一堆 converter
- Boot 只是把若干 converter Bean 提供出来

但 Boot 这里更进一步做了一层统一封装：

- `HttpMessageConverters`

它的重要性不在于“多了一个包装类”，而在于：

- Boot 需要把默认 converter、自定义 converter 以及顺序规则先组织成一个整体
- 后续再由不同 Web 场景去消费这个整体结果

也就是说，Boot 在这里解决的不是“某个 converter 是否存在”，而是：

- **整个消息转换列表怎样被统一建模。**

但要把边界说清楚：`HttpMessageConverters` 这个对象本身主要负责聚合和排序 converter；它并不单独完成 MVC 接线。真正把这组 converter 放入 Spring MVC 配置链，还需要 `WebMvcAutoConfiguration` 等后续适配逻辑。

这一步特别关键，因为一旦没有这个整体对象，后续顺序、自定义替换和默认列表合并都会变得更散。

## 四、为什么 MVC 最终会“天然”拿到这些 converter：因为 Boot 把默认消息转换环境接回了 MVC 读写链

前面 `vol-spring` 已经讲过：

- `@RequestBody` 最终会走读方向消息转换器
- `@ResponseBody` 最终会走写方向消息转换器

所以这里真正要问的问题不是：

- converter 有没有被创建

而是：

- 它们怎样进入 MVC 的参数解析和返回值处理链

Boot 给出的答案并不是：

- Controller 自己去找 JSON 库

而是：

- 通过 Web MVC 自动配置，把 converter 列表接回 Spring MVC 已有的读写主线

也就是说，用户最后感知到的“Controller 天生会 JSON”，真正原因不是注解魔法，而是：

- **消息转换环境已经被正确接线进 MVC。**

## 五、为什么用户感知到的默认体验常常是“开箱即用”，而不是“好多 converter 已存在”

站在源码视角，我们可以把这条链拆成很多层：

- starter
- Jackson 自动配置
- converter 自动配置
- MVC 接线

但站在用户视角，最后感知到的往往只有一句话：

- “对象和 JSON 默认就能互转”

这种压缩感恰恰说明 Boot 做对了。

因为它并没有让用户暴露在：

- converter 顺序细节
- builder / mapper / module 的组装细节
- MVC 参数解析和返回值处理的底层接线细节

而是把这些中间层都组织成了：

- 一个稳定、默认成立的消息转换体验

也就是说，Boot 在这里追求的并不是“让用户知道内部有多少层”，而是：

- **让这些层协同后表现成自然默认值。**

## 六、为什么这条默认体验必须始终允许用户渐进式接管，而不是只给一个黑盒 JSON 栈

和前面几篇一样，真正考验 Boot 设计的，不是默认值能不能成立，而是：

- 当用户要改一点点时，会不会被迫推翻整条默认链

在 JSON 场景下，这一点尤其常见。

用户经常只想做很小的改动，例如：

- 增加一个 module
- 调整某个序列化特性
- 替换某个 converter
- 影响默认 `ObjectMapper`

如果每次都必须退出整个 Boot 默认链，用户体验会非常差。

所以 Boot 这里同样追求：

- 默认链先成立
- 但用户可以通过 customizer、module、显式 converter Bean 等方式按层接管

也就是说，Boot 提供的不是“写死的 JSON 黑盒”，而是：

- **默认可用、用户可渐进式介入的消息转换环境。**

## 七、最小源码证据：这条链确实不是“有个 Jackson 依赖”那么简单，而是“mapper + converters + MVC 接线”的协同结果

如果只讲到这里，读者仍然可能会觉得：

- 这是不是只是对现象的合理拆解
- 源码里有没有更直接的证据说明 Boot 真在组织“整体消息转换环境”

先看 `HttpMessageConvertersAutoConfiguration` 的关键入口：

```java
@AutoConfiguration(after = { GsonAutoConfiguration.class, JacksonAutoConfiguration.class, JsonbAutoConfiguration.class })
@ConditionalOnClass(HttpMessageConverter.class)
@Conditional(NotReactiveWebApplicationCondition.class)
@Import({ JacksonHttpMessageConvertersConfiguration.class, GsonHttpMessageConvertersConfiguration.class,
        JsonbHttpMessageConvertersConfiguration.class })
public class HttpMessageConvertersAutoConfiguration {
```

以及它对整体对象的定义：

```java
@Bean
@ConditionalOnMissingBean
public HttpMessageConverters messageConverters(ObjectProvider<HttpMessageConverter<?>> converters) {
    return new HttpMessageConverters(converters.orderedStream().toList());
}
```

这两段代码至少证明了三件事：

- Boot 并不是只盯 Jackson，而是先围绕 `HttpMessageConverter` 这层抽象组织消息转换环境
- JSON 相关 converter 配置是按 Jackson、Gson、Jsonb 等分支分别导入，再统一收口
- 最终 Boot 明确提供了一个 `HttpMessageConverters` 整体对象，而不是只让若干 converter 零散漂在容器里

同时，源码上的 `@Conditional(NotReactiveWebApplicationCondition.class)` 也证明了这条自动配置主线有明确应用类型边界；来源：`HttpMessageConvertersAutoConfiguration.java:60-65`。

还要注意：`messageConverters(...)` 返回的是聚合对象，不是 MVC 配置链本身。后续 `WebMvcAutoConfiguration` 会把这组 converter 接到 MVC 的消息转换配置中。

再结合前面 Web MVC 自动装配篇已经立住的结论：

- MVC 读写链最终会消费这些 converter

就可以把整条链闭起来：

- classpath 前提成立
- JSON 映射核心成立
- converter 列表成立
- MVC 读写链消费它们
- `@RequestBody` / `@ResponseBody` 默认体验成立

也就是说，Boot Web 的 JSON 世界并不是：

- “因为有 Jackson，所以它自然就会工作”

而是：

- **因为 Boot 把 JSON 映射核心、converter 列表和 MVC 读写链协同装起来，所以它才自然工作。**

## 八、为什么这篇必须放在 DataSource / Redis 等数据自动配置之前

看到这里，最值得回收的一个问题就是：

- 为什么先讲消息转换器，而不是直接讲数据源、Redis 这些更常见的业务依赖？

因为对一个 Web 应用来说，用户最直接感知到的自动装配结果之一就是：

- 请求体能自动读 JSON
- 返回值能自动写 JSON

而这条链又紧挨着前面刚讲完的：

- `DispatcherServlet` 默认请求入口

也就是说，顺序上：

- 先有默认请求入口
- 再有入口之后的默认消息转换体验
- 再进入数据源、Redis、事务、缓存等后端设施

整个 Boot Web 应用的默认体验就会更自然地从“接请求”推进到“处理请求”再推进到“连接基础设施”。

## 九、几个最容易错的判断

### 1. Boot Web 默认会 JSON，本质上就是因为 classpath 上有 Jackson

不完整。

Jackson 只是前提之一，真正让默认体验成立的是 mapper、converter 列表和 MVC 读写链的协同装配。

### 2. `HttpMessageConvertersAutoConfiguration` 只是放几个 converter Bean，没有整体机制价值

不成立。

它的重要价值就在于把 converter 列表统一收口成 `HttpMessageConverters` 这种整体对象。

### 3. 只要有 `ObjectMapper`，`@RequestBody` / `@ResponseBody` 自然就会工作

不成立。

还必须有合适的 `HttpMessageConverter`，并让 MVC 读写链真正消费它。

### 4. Boot 的默认 JSON 体验一旦成立，就很难再改

不成立。

Boot 仍然维持的是默认成立、用户可渐进式接管，而不是封闭黑盒。

### 5. 这篇讲的只是 JSON 细节，不属于 Boot 自动装配主线

不成立。

消息转换默认体验是 Boot Web 应用最核心、最直接的默认装配结果之一，正好体现了“依赖前提 -> 自动配置 -> MVC 接线 -> 默认体验”这条主线。

## 收网：Boot 统一的不是“默认挑一个 JSON 库”，而是“把请求体/响应体消息转换环境整体装起来”

现在可以回到开头的问题：为什么 Boot Web 应用几乎天生就会收发 JSON？

因为真实发生的不是“因为 classpath 上有 Jackson 所以自然会 JSON”，而是一条协同装配链：

```text
web starter
   -> JSON 相关依赖进入 classpath
   -> ObjectMapper / Gson / Jsonb / builder / customizers 按条件组织起来
   -> HttpMessageConverters 统一收口 converter 列表
   -> MVC 参数解析与返回值处理消费这套列表
   -> @RequestBody / @ResponseBody 默认 JSON 体验成立
```

所以这篇真正该带走的结论不是“Boot 默认帮你配了 Jackson”，而是：

**Boot 先把 JSON 依赖前提带进来，再把映射核心、converter 列表和 MVC 读写链统一组织成一套默认消息转换环境；因此，用户感知到的不是某个 JSON bean 的存在，而是请求体和响应体的对象转换已经成为 Boot Web 应用的自然默认能力。**

下一篇进入 DataSource / JDBC 自动配置：既然 Web 请求入口和消息转换环境都已经立住，那一个典型业务应用最核心的后端设施——数据源、连接池和 `JdbcTemplate`——又是怎样被 Boot 默认装起来的。