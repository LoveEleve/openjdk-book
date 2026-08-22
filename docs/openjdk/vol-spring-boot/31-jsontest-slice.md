# 为什么 `@JsonTest` 不需要启动 Web 和数据库，却能把 JSON 序列化测试准备好

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接 `@WebMvcTest` 与 `@MockBean` 测试细化篇，进入 JSON 测试切片：`@JsonTest`。重点放在 `JsonTestContextBootstrapper`、`JsonTypeExcludeFilter`、JSON 相关 `@ImportAutoConfiguration`、`JacksonTester` / Gson tester，以及测试上下文如何只保留 JSON 验证所需的最小装配范围。本文不重复 `vol-spring` 与 Web 篇中的消息转换器底层原理，而聚焦 Boot 如何把 JSON 测试独立成一条切片路径。

## 为什么测试一个 JSON 序列化结果，却不应该启动整个 MVC、数据库和缓存世界

一个典型 JSON 测试可能只关心：

- 一个 DTO 序列化后的字段
- 一个 JSON 反序列化后的对象
- Jackson module 是否生效
- 日期、枚举、null、嵌套对象的 JSON 表达

它通常并不需要：

- Servlet 容器
- DispatcherServlet
- Controller
- DataSource
- Redis
- TransactionManager

如果所有 JSON 测试都用 `@SpringBootTest`：

- 启动成本会明显放大
- 与 JSON 无关的自动配置会引入噪音
- 数据库、Redis 等外部依赖可能让纯序列化测试失败
- 测试失败时很难判断是 JSON 逻辑还是外围基础设施问题

所以 Boot 提供了：

```java
@JsonTest
class OrderJsonTest {
}
```

用户看到的是：

- JSON tester 自动可用
- `ObjectMapper` 默认配置仍然存在
- 上下文很轻

源码层面真实发生的是：

- **Boot 从测试 bootstrap 阶段切换路径，关闭全量自动配置，安装 JSON 类型过滤器，再只导入 JSON 测试所需自动配置。**

第一层问题是：**JSON 测试切片不是“少启动一点 Spring”，而是把 JSON 验证目标单独建模成一个测试应用世界。**

第二层问题是：**JSON 测试需要保留映射核心和相关 module，却不需要把 MVC 请求链或业务组件全部带进来。**

第三层问题是：**JSON tester 不是普通工具对象，而是 Boot 测试上下文自动装配结果的一部分。**

因此，本文真正要回答的问题不是“`@JsonTest` 怎么用”，而是：

**为什么 Boot 必须通过专用 bootstrapper、JSON 类型过滤器和受控自动配置，把 JSON 映射核心与测试断言工具单独装起来，形成一个不依赖 Web/数据库的窄测试上下文。**

## 先看失败方案：为什么不能用完整应用测试、不能只 new `ObjectMapper`、也不能只过滤掉 Controller

### 失败方案一：所有 JSON 测试都使用 `@SpringBootTest`

这会把 JSON 测试拖进完整应用装配成本：

- MVC
- 数据库
- Redis
- 事务
- 外部客户端

测试目标明明只是 JSON，却被外围依赖影响。

### 失败方案二：测试里手工 new `ObjectMapper`

这会导致测试使用的 mapper 和生产使用的 mapper 不一致：

- Boot customizer 没有被应用
- Jackson module 没有被注册
- 日期、命名、枚举等默认策略可能不同

所以 JSON 测试需要的是：

- **生产默认 JSON 配置的受控测试版本**

而不是一个完全脱离容器的裸 `ObjectMapper`。

### 失败方案三：只排除 Controller，其他生产 Bean 全部照常扫描

这仍然会把数据库、缓存、业务服务和外部客户端拉进来。

JSON 切片真正需要的是：

- JSON 相关配置和 module
- JSON tester
- 被测试的 JSON 组件

而不是把生产组件扫描范围保留成默认状态。

## `@JsonTest` 的最小总图

```text
@JsonTest
   -> JsonTestContextBootstrapper
   -> disable full auto-configuration
   -> JsonTypeExcludeFilter
   -> import JSON auto-configuration
   -> JacksonTester / GsonTester / JsonbTester
   -> focused JSON test context
```

```text
[测试入口]
@JsonTest

   ->

[启动器]
JsonTestContextBootstrapper

   ->

[自动配置边界]
OverrideAutoConfiguration(false) + ImportAutoConfiguration

   ->

[类型过滤]
JsonTypeExcludeFilter

   ->

[JSON 设施]
Jackson / Gson / Jsonb + ObjectMapper / tester
```

## 一、`@JsonTest` 首先改变的是测试上下文 bootstrapper

`@JsonTest` 并不是普通的元注解组合，它明确指定：

- `JsonTestContextBootstrapper`
- `SpringExtension`

这意味着 JSON 测试从 TestContext 构建阶段就进入专用路径，而不是启动完整 Boot 上下文后再把 Web/DB 排除。

这一步很重要，因为 JSON 切片越早建立，越能避免无关自动配置和业务 Bean 进入测试世界。

当前 `JsonTestContextBootstrapper` 继承 `SpringBootTestContextBootstrapper`，说明它复用 Boot 测试上下文的总体构建能力，但通过 `JsonTest` 自己的过滤器和自动配置元注解改变测试目标。

## 二、为什么 `OverrideAutoConfiguration(false)` 仍然需要 `ImportAutoConfiguration` 精确补回 JSON 能力

和 `@WebMvcTest` 一样，`@JsonTest` 也会关闭全量自动配置。

但这不意味着 JSON 自动配置全部消失。

它会通过 `@ImportAutoConfiguration` 精确引入与 JSON 测试相关的配置：

- Jackson 自动配置
- Gson / Jsonb 路径（如果相关类存在）
- JSON tester 自动配置
- JSON 组件与 module 支持

也就是说，切片的逻辑是：

- 关掉全量
- 精确恢复 JSON 所需部分

## 三、`JsonTypeExcludeFilter`：JSON 切片真正裁剪的是组件类型范围

JSON 测试不需要扫描所有应用组件。

它更关注：

- `@JsonComponent`
- Jackson `Module`
- JSON serializer / deserializer
- 测试明确指定的组件

所以 `JsonTypeExcludeFilter` 的作用不是简单“排除所有业务 Bean”，而是：

- 默认保留 `@JsonComponent`
- Jackson 可用时保留 `Module`
- 过滤 Controller、Service、Repository 等无关组件
- 允许用户通过 include/exclude 属性继续调整

这份白名单语义和 `WebMvcTypeExcludeFilter` 不同，说明不同测试切片不是共用一套模糊过滤器，而是各自定义自己的组件边界。

这让 JSON 测试上下文既不会为空，也不会膨胀成完整应用。

## 四、为什么 `JacksonTester` 不是脱离生产配置的独立 JSON 工具

`JacksonTester` 的价值不只是提供几个断言方法。

它通常会使用测试上下文中已经准备好的：

- `ObjectMapper`
- Jackson module
- Boot JSON customizer

本地 `JsonTestersAutoConfiguration` 的 Jackson 分支会在 `ObjectMapper` 存在时创建 prototype `FactoryBean<JacksonTester<?>>`，由 `JsonMarshalTestersBeanPostProcessor` 负责把测试字段接入这套 tester 工厂；Gson / Jsonb 也有对应的条件分支。

这样测试验证的 JSON 行为，才更接近应用真正运行时的 JSON 行为。

如果测试手工 new 一个 ObjectMapper，再用它做断言，测试可能验证的是：

- 测试自己的 mapper 配置

而不是：

- Boot 应用真正使用的 mapper 配置

所以 JSON tester 应该被理解成：

- **测试上下文中的 JSON 访问与断言设施。**

## 五、为什么 `@JsonTest` 不等于“只支持 Jackson”

当前 Boot JSON 测试路径可能根据 classpath 支持：

- Jackson
- Gson
- Jsonb

但这不意味着所有 tester 会同时创建。

具体路径仍然依赖：

- 相关库是否存在
- 对应自动配置是否成立
- 用户是否自定义了 mapper/tester

所以 `@JsonTest` 统一的是：

- JSON 测试切片模型

而不是：

- 把所有 JSON 库强行塞进一个测试上下文

## 六、为什么 JSON 切片不能替代 Web MVC 测试

`@JsonTest` 只验证 JSON 映射行为，不验证：

- Controller 路由
- 参数解析器链
- `@RequestBody` / `@ResponseBody` 接线
- HandlerInterceptor
- ExceptionResolver
- MockMvc 请求执行

如果要验证 JSON 在 HTTP 请求链中如何工作，应使用：

- `@WebMvcTest`
- 或 `@SpringBootTest + @AutoConfigureMockMvc`

这说明测试切片的边界必须尊重验证目标，而不是把所有 Web 相关能力都混进 JSON 测试。

## 七、最小源码证据：这条链确实是“专用 bootstrapper + 类型过滤 + JSON 自动配置”的切片路径

`@JsonTest` 的关键元注解可以概括为：

```java
@BootstrapWith(JsonTestContextBootstrapper.class)
@OverrideAutoConfiguration(enabled = false)
@TypeExcludeFilters(JsonTypeExcludeFilter.class)
@AutoConfigureCache
@AutoConfigureJsonTesters
@ImportAutoConfiguration
public @interface JsonTest {
}
```

来源：`spring-boot-test-autoconfigure/src/main/java/org/springframework/boot/test/autoconfigure/json/JsonTest.java:71-82`。

`JsonTestersAutoConfiguration` 又通过：

- `@ConditionalOnBooleanProperty("spring.test.jsontesters.enabled")`
- AssertJ 类路径条件
- `ObjectMapper` / `Gson` / `Jsonb` 各自的条件分支

创建对应 tester 的 prototype `FactoryBean`。

这证明：

- JSON 测试从 bootstrap 阶段就切换路径
- 全量自动配置被关闭
- 类型过滤器负责 JSON 切片边界
- JSON 所需自动配置由 `ImportAutoConfiguration` 精确恢复

再结合 JSON tester 自动配置，就可以把完整链路闭起来：

- JSON 映射核心进入上下文
- 相关 module 与 customizer 进入上下文
- tester 使用容器中的映射核心
- Controller、数据库、Redis 等无关世界不进入测试目标范围

## 八、为什么这篇适合作为 `@WebMvcTest` 之后的测试切片细化

前一篇 `@WebMvcTest` 讲的是：

- 请求进入 MVC 后的 Web 层测试世界

这一篇 `@JsonTest` 讲的是：

- JSON 映射本身的测试世界

两者都处理 JSON，但边界不同：

- `@WebMvcTest` 验证 JSON 如何接进 HTTP/MVC 链
- `@JsonTest` 验证对象如何独立转换成 JSON、JSON 如何独立转换成对象

把这两篇连续放在一起，读者才能真正理解测试切片不是“少加载”，而是：

- 按验证目标选择不同装配边界

## 九、几个最容易错的判断

### 1. `@JsonTest` 就是 `@SpringBootTest` 排除 Web

不成立。

它从 bootstrap、自动配置导入和类型过滤阶段就走独立切片路径。

### 2. JSON 测试手工 new `ObjectMapper` 最简单，也最接近真实

不一定。

手工 mapper 可能绕开 Boot 的 customizer、module 和默认配置，反而和生产行为不一致。

### 3. `@JsonTest` 只适合 Jackson

不成立。

具体 JSON 库和 tester 路径依赖 classpath 与对应条件。

### 4. `@JsonTest` 可以验证 `@RequestBody` 的完整行为

不成立。

它验证 JSON 映射，不验证 Controller、MVC 参数解析和 HTTP 请求链。

### 5. JSON 切片不需要任何 Spring 上下文

不成立。

它需要上下文提供 mapper、module、customizer 和 tester 设施，但会裁掉无关生产世界。

## 收网：`@JsonTest` 统一的不是“怎么断言 JSON”，而是“怎样用接近生产的 JSON 配置重建一个最小测试世界”

现在可以回到开头的问题：为什么 `@JsonTest` 不需要启动 Web 和数据库，却能把 JSON 序列化测试准备好？

因为真实发生的不是简单关闭几个模块，而是一条切片装配链：

```text
@JsonTest
   -> JsonTestContextBootstrapper
   -> disable full auto-configuration
   -> JsonTypeExcludeFilter
   -> import JSON auto-configuration
   -> ObjectMapper / module / tester
   -> focused JSON test context
```

所以这篇真正该带走的结论不是“`@JsonTest` 更轻量”，而是：

**Boot 通过专用 bootstrapper、全量自动配置关闭、JSON 类型过滤器和受控 JSON 自动配置导入，重建了一个使用接近生产 JSON 映射配置、但不携带 Web/数据库/业务组件噪音的窄测试上下文；因此，`@JsonTest` 是按验证目标组织出来的 JSON 应用测试世界，而不是完整应用上下文的简单裁剪。**