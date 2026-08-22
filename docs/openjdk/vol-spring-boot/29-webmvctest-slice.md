# 为什么 `@WebMvcTest` 不是“少加载几个 Bean”：它如何重建一条只面向 MVC 的测试装配路径

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接 `23-test-autoconfiguration.md` 的测试总论，进入第一个测试切片细化篇：`@WebMvcTest`。重点放在 `WebMvcTestContextBootstrapper`、`@OverrideAutoConfiguration(enabled = false)`、`WebMvcTypeExcludeFilter`、组件扫描白名单、`@AutoConfigureMockMvc` 与 `@MockBean` 的协作关系。本文不重复 `vol-spring` 中 MockMvc、DispatcherServlet、参数解析和异常处理底层原理，而聚焦 Boot 如何把 MVC 测试上下文裁剪成一条窄而自洽的装配路径。

## 为什么 `@WebMvcTest` 能让 Controller 测试不启动数据库，却仍然保留一整套 MVC 能力

一个典型的 Controller 测试可能只需要：

- Controller
- ControllerAdvice
- 参数绑定
- 校验
- 消息转换器
- MockMvc

但完整的 `@SpringBootTest` 往往还会带来：

- DataSource
- Redis
- CacheManager
- 事务管理器
- 消息中间件
- 业务层全部 Bean

这些设施对 Controller 的路由、参数解析和响应断言并不是必要条件。

所以 Boot 提供了：

```java
@WebMvcTest(MyController.class)
class MyControllerTest {
}
```

用户看到的是：

- 测试启动更快
- 上下文更小
- MVC 能力仍然存在

但源码层面真正发生的是：

- **Boot 从测试启动入口开始切换 bootstrapper，关闭全量自动配置，安装 MVC 类型排除器，再显式补回 MVC 与 MockMvc 所需自动配置。**

第一层问题是：**切片测试不是“完整上下文减去数据库”，而是从入口开始就选择另一条装配路径。**

第二层问题是：**MVC 切片不能只保留 Controller，还必须保留一组 MVC 协作者。**

例如：

- `ControllerAdvice`
- `JsonComponent`
- `Converter`
- `Filter`
- `HandlerInterceptor`
- `HttpMessageConverter`
- `WebMvcConfigurer`

如果只保留 Controller，测试环境会过度简化，测试结果也不再代表真实 MVC 行为。

第三层问题是：**切片上下文还要能够接入测试替身，否则 Controller 依赖的 service 仍然会把完整业务世界拉进来。**

因此，本文真正要回答的问题不是“`@WebMvcTest` 有什么用”，而是：

**为什么 Boot 必须把 `@WebMvcTest` 设计成一条独立的 MVC 测试装配路径，通过 bootstrapper、自动配置裁剪、类型过滤、MockMvc 自动配置和 mock 替换共同重建一个窄而自洽的 Web 测试上下文。**

## 先看失败方案：为什么不能只排除 DataSource、不能只扫描 Controller、也不能用完整上下文硬测所有 MVC 行为

### 失败方案一：在 `@SpringBootTest` 上排除数据库自动配置就够了

不够。

因为 Controller 测试不只是不需要数据库，还可能不需要：

- Redis
- Cache
- 事务
- 消息系统
- 业务服务实现

逐个排除会让测试类承担越来越多基础设施知识，最终变成另一套手工切片系统。

### 失败方案二：只扫描 `@Controller`，其他组件全部不要

也不成立。

Controller 的真实 MVC 行为依赖很多协作者：

- advice
- converter
- resolver
- interceptor
- filter
- validator

所以 Web 切片必须是“限定范围的白名单”，而不是“只留下 Controller”。

### 失败方案三：所有 Controller 测试都启动完整应用，最接近生产所以最可靠

这会把测试目标混在一起：

- Controller 路由失败
- JSON 转换失败
- 数据库连接失败
- Redis 配置失败

最终测试失败时，根因边界反而更模糊。

`@WebMvcTest` 的价值不是替代集成测试，而是让 MVC 层验证有一个低噪音、窄边界的专用环境。

## `@WebMvcTest` 的最小总图

```text
@WebMvcTest
   -> WebMvcTestContextBootstrapper
   -> disable full auto-configuration
   -> WebMvcTypeExcludeFilter
   -> import MVC + MockMvc auto-configuration
   -> optionally replace collaborators with mocks
   -> focused MVC test context
```

```text
[测试入口]
@WebMvcTest

   ->

[启动器]
WebMvcTestContextBootstrapper

   ->

[自动配置边界]
OverrideAutoConfiguration(false) + ImportAutoConfiguration

   ->

[组件过滤]
WebMvcTypeExcludeFilter

   ->

[测试设施]
AutoConfigureWebMvc + AutoConfigureMockMvc

   ->

[协作者替身]
@MockBean / MockitoPostProcessor
```

## 一、`@WebMvcTest` 首先改变的是测试启动入口，而不是扫描规则

`@WebMvcTest` 的关键不只是它有哪些属性，而是它在元注解层面直接指定了：

- `@BootstrapWith(WebMvcTestContextBootstrapper.class)`
- `@ExtendWith(SpringExtension.class)`

这意味着 Web MVC 测试从测试框架 bootstrap 阶段就走了专门路径，而不是先按 `@SpringBootTest` 启动后再临时删 Bean。

这一步很重要，因为切片边界越早建立，越不会产生大量无关定义和自动配置副作用。

本地 `WebMvcTestContextBootstrapper` 还会在测试上下文构建阶段处理 web environment，并使用 `SpringBootContextLoader` 作为默认 ContextLoader；这说明切片路径不仅改变组件过滤，也改变了测试上下文的构建入口。

## 二、为什么 `OverrideAutoConfiguration(false)` 是切片成立的关键

`@WebMvcTest` 还明确声明：

```java
@OverrideAutoConfiguration(enabled = false)
```

这并不意味着所有自动配置都被禁用。

它表达的是：

- 不要自动加载完整 Boot 自动配置集合
- 后续由切片自己的 `@ImportAutoConfiguration`、`@AutoConfigureWebMvc`、`@AutoConfigureMockMvc` 精确补回所需能力

也就是说，切片不是“完全没有自动配置”，而是：

- **从全量自动配置切换为受控自动配置。**

更准确地说，`@ImportAutoConfiguration` 负责把切片声明的自动配置集合引入，`@AutoConfigureWebMvc` 和 `@AutoConfigureMockMvc` 又各自补充 MVC 与 MockMvc 设施；因此 `OverrideAutoConfiguration(false)` 本身只是关闭默认全量自动配置开关，不是单独完成切片装配。

## 三、`WebMvcTypeExcludeFilter`：切片真正裁剪的是组件发现范围

只关闭全量自动配置仍然不够，因为应用自己的组件扫描仍可能把大量业务 Bean 拉进来。

所以 `@WebMvcTest` 还声明：

```java
@TypeExcludeFilters(WebMvcTypeExcludeFilter.class)
```

这个过滤器的目标不是简单地排除所有非 Controller 类，而是保留 MVC 测试真正需要的类型集合。

源码中的默认 include 集合包括 `ControllerAdvice`、`JsonComponent`、`WebMvcConfigurer`、`WebMvcRegistrations`、Servlet `Filter`、`HandlerMethodArgumentResolver`、`HttpMessageConverter`、`ErrorAttributes`、`Converter`、`GenericConverter`、`HandlerInterceptor` 等；如果没有显式 `controllers`，还会加入 `Controller`，如果指定了 controllers，则由显式 controller 集合参与组件包含。

也就是说，它不是一个模糊的“Web 类型过滤器”，而是一份有明确白名单语义的切片组件边界：

- `@Controller`
- `@ControllerAdvice`
- `@JsonComponent`
- `Converter`
- `Filter`
- `HandlerInterceptor`
- `HandlerMethodArgumentResolver`
- `HttpMessageConverter`
- `WebMvcConfigurer`
- `WebMvcRegistrations`

这解释了为什么 `@WebMvcTest` 既不会启动完整业务层，又不会退化成只有 Controller 的空壳环境。

## 四、为什么 `@AutoConfigureWebMvc` 和 `@AutoConfigureMockMvc` 必须同时存在

一个 MVC 测试至少需要两类能力：

### MVC 运行基础设施

- HandlerMapping
- HandlerAdapter
- 参数解析
- 消息转换
- 异常处理
- 校验与格式化

这由 `@AutoConfigureWebMvc` 相关路径负责。

### 测试请求执行设施

- MockMvc
- filter 注册
- builder customizer
- 可选 HtmlUnit / Selenium / MockMvcTester

这由 `@AutoConfigureMockMvc` 相关路径负责。

所以 `@WebMvcTest` 不是只“打开 MockMvc”，也不是只“打开 MVC”，而是把两层一起接起来：

- MVC 是被测运行环境
- MockMvc 是测试驱动入口

## 五、为什么 `@MockBean` 是 Web 切片的自然搭档

Controller 通常依赖 service：

```java
@RestController
class OrderController {
    private final OrderService orderService;
}
```

如果不提供 `OrderService`，Controller 无法创建。

如果提供真实 `OrderService`，它又可能继续拉入：

- DataSource
- Redis
- 事务
- 其他业务依赖

所以切片测试需要一个中间方案：

- Controller 保留真实实现
- service 依赖替换为 mock

这就是 `@MockBean` 的位置。

它并不只是 Mockito 的本地变量，而是通过 `MockitoPostProcessor` 进入 Spring 容器，在 BeanFactory 阶段执行替换或新增：

- 有匹配 Bean：替换
- 没有匹配 Bean：新增

因此，`@MockBean` 让切片上下文保持窄边界，同时让被测 Controller 仍然能够完成依赖注入。

## 六、为什么 `controllers` 和过滤器属性会影响测试边界

`@WebMvcTest` 支持：

- 指定 `controllers`
- `useDefaultFilters`
- `includeFilters`
- `excludeFilters`
- `excludeAutoConfiguration`

这些属性说明切片并不是固定死的黑盒。

用户可以在默认 MVC 切片上继续收窄或扩展：

- 只测指定 Controller
- 引入额外 converter
- 排除某个默认配置
- 增加测试专属组件

这使 `@WebMvcTest` 既有稳定默认边界，又保留了必要的测试定制空间。

## 七、最小源码证据：入口、裁剪、Mock 和 MockMvc 确实是四段协作链

`@WebMvcTest` 的核心元注解可以压缩为：

```java
@BootstrapWith(WebMvcTestContextBootstrapper.class)
@OverrideAutoConfiguration(enabled = false)
@TypeExcludeFilters(WebMvcTypeExcludeFilter.class)
@AutoConfigureWebMvc
@AutoConfigureMockMvc
@ImportAutoConfiguration
public @interface WebMvcTest {
}
```

来源：`spring-boot-test-autoconfigure/.../WebMvcTest.java:101-108`。

`@AutoConfigureMockMvc` 本身通过：

```java
@ImportAutoConfiguration
@PropertyMapping("spring.test.mockmvc")
public @interface AutoConfigureMockMvc {
}
```

进入测试自动配置。

而 `MockMvcAutoConfiguration` 受 Servlet Web 条件约束，并导入：

- `MockMvcConfiguration`
- `MockMvcTesterConfiguration`

这证明：

- Web MVC 切片不是普通测试上下文
- 它从 bootstrap 阶段就切换路径
- 它关闭全量自动配置，再精确导入 MVC / MockMvc 设施
- 类型过滤器负责控制组件边界
- MockBean 再对切片上下文做协作者替换

## 八、为什么 `@WebMvcTest` 不能替代 `@SpringBootTest`

两者的验证目标不同：

### `@WebMvcTest`

验证：

- 请求映射
- 参数绑定
- 校验错误
- JSON 输入输出
- ControllerAdvice
- MVC 层过滤器与拦截器

### `@SpringBootTest`

验证：

- 完整自动配置
- 多层 Bean 协作
- 数据库、Redis、事务等真实基础设施
- 更接近真实应用启动与运行

所以正确关系不是：

- 一个是旧写法
- 一个是新写法

而是：

- 一个是窄边界 MVC 测试
- 一个是完整应用集成测试

## 九、几个最容易错的判断

### 1. `@WebMvcTest` 只是 `@SpringBootTest` 少加载数据库

不完整。

它从 bootstrapper、自动配置策略和组件过滤阶段就走了独立路径。

### 2. `@WebMvcTest` 只保留 Controller

不成立。

它还会保留 advice、converter、filter、interceptor、resolver、configurer 等 MVC 协作者。

### 3. `@OverrideAutoConfiguration(false)` 意味着 MVC 自动配置也完全关闭

不成立。

它关闭的是全量自动配置，切片随后通过专门注解精确导入所需配置。

### 4. `@MockBean` 只是把 mock 放进测试类字段

不成立。

它会通过 `MockitoPostProcessor` 改写 Spring ApplicationContext 的 Bean 定义或注册结果。

### 5. Controller 测试都应该使用 `@WebMvcTest`

不成立。

如果要验证完整应用装配、真实数据库协作或跨层行为，仍需要 `@SpringBootTest` 或其他更重测试路径。

## 收网：`@WebMvcTest` 统一的不是“少启动一些 Bean”，而是“按 MVC 验证目标重建一条自洽测试装配路径”

现在可以回到开头的问题：为什么 `@WebMvcTest` 能让 Controller 测试不启动数据库，却仍然保留一整套 MVC 能力？

因为真实发生的不是简单删 Bean，而是一条切片装配链：

```text
@WebMvcTest
   -> WebMvcTestContextBootstrapper
   -> disable full auto-configuration
   -> WebMvcTypeExcludeFilter limits component scan
   -> AutoConfigureWebMvc + AutoConfigureMockMvc
   -> @MockBean replaces collaborators
   -> focused MVC test context
```

所以这篇真正该带走的结论不是“`@WebMvcTest` 启动更快”，而是：

**Boot 通过专用 bootstrapper、受控自动配置、MVC 类型过滤器、MockMvc 自动配置和测试替身改写，共同重建了一条只面向 MVC 验证目标的窄装配路径；因此，`@WebMvcTest` 不是完整应用上下文的缩水版，而是一个边界明确、能力自洽的测试应用世界。**