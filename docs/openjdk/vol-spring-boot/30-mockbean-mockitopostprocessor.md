# 为什么 `@MockBean` 不只是创建 Mockito 对象：它如何在测试上下文里替换或新增 Bean

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接前一篇 `@WebMvcTest` 测试切片，进入测试替身细化篇：`@MockBean` / `MockitoPostProcessor`。重点放在 mock 定义解析、按类型或名称替换 Bean、没有原 Bean 时新增 Bean、测试字段注入、重置策略，以及这些动作如何发生在 Spring TestContext 与 BeanFactory 装配阶段。需要注意：当前 Spring Boot 3.4+ 已将 `@MockBean` 标记为 deprecated，推荐迁移到 Spring Framework 的 `@MockitoBean`；本文仍然分析 Boot 现有机制，因为大量既有项目和测试仍在使用它。

## 为什么 `@MockBean` 看起来只是一个注解，却能让整个测试上下文里的依赖关系发生变化

Controller 测试经常有这样的结构：

```java
@WebMvcTest(OrderController.class)
class OrderControllerTest {

    @MockBean
    private OrderService orderService;
}
```

用户期望的结果很直观：

- `OrderController` 仍然使用 Spring 容器管理
- 但它依赖的 `OrderService` 不再是真实实现
- 测试可以直接控制 mock 的返回值
- 数据库、Redis、远程服务等真实依赖不会被拉起来

如果只从 Mockito 角度看，似乎只是：

- 创建一个 mock
- 注入到测试字段

但这无法解释最关键的事实：

- Controller 里的依赖注入为什么也拿到同一个 mock
- 如果原来已经有一个同类型 Bean，为什么它会被替换
- 如果原来没有这个 Bean，为什么 mock 还能进入 ApplicationContext
- mock 为什么会在测试结束后按策略重置

也就是说，`@MockBean` 真正改写的不是一个测试字段，而是：

- **整个 Spring 测试上下文中的 Bean 装配关系。**

第一层问题是：**Mockito mock 对象只有进入 ApplicationContext，才能替换生产 Bean 的依赖关系。**

如果 mock 只存在于测试类字段里：

- Controller 仍然会从容器拿真实 service
- 测试字段和被测对象使用的不是同一个依赖
- mock 配置无法影响容器内其他 Bean

所以 `@MockBean` 必须同时完成：

- 测试字段注入
- ApplicationContext Bean 注册或替换

第二层问题是：**替换和新增是两个不同的装配分支。**

如果容器里已有匹配 Bean，应该：

- 保留原 Bean 名称语义
- 替换其 BeanDefinition 或注册结果

如果容器里没有匹配 Bean，应该：

- 生成一个 Bean 名称
- 将 mock 注册成新 Bean

这也是为什么 `@MockBean` 不能只是一个普通 `BeanPostProcessor`：

- 它需要在 Bean 实例创建前改写定义或注册路径

第三层问题是：**mock 的生命周期必须和测试上下文生命周期绑定。**

如果 mock 只创建不管理：

- 多个测试方法之间可能互相污染
- 调用记录和 stubbing 会泄露
- context cache 与 mock 状态可能不一致

所以 `@MockBean` 还需要处理：

- reset 策略
- 字段注入
- 上下文关闭
- 测试实例生命周期

因此，本文真正要回答的问题不是“`@MockBean` 怎么写”，而是：

**为什么对 Boot 测试来说，`@MockBean` 必须通过 `MockitoPostProcessor` 进入 BeanFactory 装配阶段，在已有 Bean 上执行替换、在缺失 Bean 时执行新增，并把测试字段注入和 mock 重置纳入测试上下文生命周期，测试替身才真正能改变被测应用的依赖图。**

## 先看失败方案：为什么不能只把 mock 放在字段里、不能只用普通 `@Bean`、也不能等 Bean 创建后再替换

### 失败方案一：只在测试字段上创建 Mockito mock

这是最容易想到的方案：

```java
@Mock
private OrderService orderService;
```

它能让测试代码拿到 mock，但不会自动改变 Spring 容器里的依赖注入关系。

结果就是：

- 测试字段是 mock
- Controller 里的 `OrderService` 仍可能是真实 Bean

这两个对象不一致，测试就失去了控制力。

### 失败方案二：在测试配置里手写一个 `@Bean` 返回 mock

这比字段 mock 更进一步，但仍然有很多重复工作：

- 需要自己写配置类
- 自己决定 Bean 名称
- 自己处理已有 Bean 冲突
- 自己处理测试字段注入
- 自己处理 reset 生命周期

而且当目标 Bean 已经由自动配置创建时，普通 `@Bean` 还可能遇到：

- BeanDefinition 覆盖限制
- 类型歧义
- 名称不一致

所以 Boot 需要把“mock 进入上下文”做成一条正式测试装配路径。

### 失败方案三：等目标 Bean 创建完成后，再用后处理器把它替换成 mock

这个时机太晚。

因为目标 Bean 可能已经：

- 注入了真实依赖
- 执行了初始化逻辑
- 被其他 Bean 缓存引用
- 创建了不应该启动的外部资源

所以 mock 替换必须尽量发生在 Bean 实例化和依赖注入之前的 BeanFactory 阶段。

## `@MockBean` 的最小总图

```text
@MockBean annotation
   -> DefinitionsParser extracts mock definitions
   -> MockitoPostProcessor receives definitions
   -> BeanDefinitionRegistry replace or register
   -> mock instance created and registered
   -> test field injected
   -> reset after test according to MockReset
```

```text
[声明入口]
@MockBean(type/name/field)

   ->

[定义解析]
MockitoBeans / DefinitionsParser

   ->

[容器改写]
MockitoPostProcessor as BeanFactoryPostProcessor

   ->

[替换或新增]
existing bean replaced / missing bean added

   ->

[测试生命周期]
field injection + reset + context integration
```

## 一、`@MockBean` 首先声明的是“我要修改测试上下文中的某个 Bean”

`@MockBean` 的核心语义不是：

- 在测试类里生成一个 mock

而是：

- 在 Spring `ApplicationContext` 中注册或替换一个 mock Bean

源码注释明确区分两种情况：

- 按类型注册时，如果存在唯一匹配 Bean，则替换
- 如果没有已有 Bean，则新增一个
- 按名称注册时，可以精确定位要替换的 Bean

这一步说明 `@MockBean` 从一开始就是：

- **Bean 装配声明**

而不是普通 Mockito 变量声明。

## 二、为什么 `MockitoPostProcessor` 必须同时是 BeanFactoryPostProcessor 与 BeanPostProcessor

这是本篇最关键的源码边界。

`MockitoPostProcessor` 实现了：

- `BeanFactoryPostProcessor`
- `InstantiationAwareBeanPostProcessor`
- `BeanClassLoaderAware`
- `BeanFactoryAware`

其中：

### BeanFactoryPostProcessor 部分

负责在 Bean 实例化前：

- 解析 mock definitions
- 检查现有 Bean
- 替换或注册 BeanDefinition
- 把 mock 纳入 BeanFactory

### InstantiationAwareBeanPostProcessor 部分

负责参与 mock 对象相关的实例化后处理；测试类字段的实际注入还由 `MockitoTestExecutionListener` 调用 `MockitoPostProcessor.inject(...)` 完成，不能把字段注入全部归给 BeanPostProcessor 本身。

也就是说，`MockitoPostProcessor` 不是单一后处理器，而是：

- **以 BeanFactory 定义改写为核心，并与测试执行监听器协作完成字段注入和生命周期处理。**

源码中它还会在 `postProcessProperties(...)` 期间扫描字段，并通过 `beanFactory.getBean(beanName, field.getType())` 将容器中的同一个 mock 注入目标字段；因此字段注入确实和容器 Bean 共享实例，但执行职责不应全部归给测试执行监听器。

## 三、已有 Bean 如何被替换：`@MockBean` 不是简单新增同类型 Bean

如果容器里已经存在一个匹配 Bean，直接再新增一个同类型 mock 会产生：

- 注入歧义
- `NoUniqueBeanDefinitionException`
- 原 Bean 仍然被其他对象引用

所以 Boot 的 mock 机制必须识别已有 Bean，并执行替换语义。

这也是 `@MockBean(name = "...")` 有价值的原因：

- 按类型替换适合单候选场景
- 按名称替换适合多个同类型 Bean 的精确目标

如果字段上存在 `@Qualifier`，它也能帮助选择正确的替换目标。

## 四、缺失 Bean 如何被新增：切片测试不需要先有真实 Service Bean

在 `@WebMvcTest` 中，业务 service 往往被组件过滤器排除。

这时如果测试声明：

```java
@MockBean
private OrderService orderService;
```

容器里可能根本不存在 `OrderService` Bean。

`MockitoPostProcessor` 必须在这种情况下：

- 创建 mock
- 生成 Bean 名称
- 注册一个新的 Bean
- 让 Controller 的依赖注入找到它

这正是“替换”和“新增”两条路径必须同时存在的原因。

## 五、为什么测试字段也必须注入同一个 mock

测试代码通常需要配置 mock：

```java
when(orderService.find(...)).thenReturn(...);
```

而 Controller 又必须使用同一个 mock。

因此 `@MockBean` 的字段模式必须同时保证：

- mock 注册到 ApplicationContext
- 同一个 mock 注入测试字段

如果这两个对象不是同一个实例，测试会出现非常隐蔽的错误：

- 测试字段配置了行为
- 被测 Bean 使用另一个未配置的 mock

所以字段注入不是便利附加，而是 `@MockBean` 正确性的组成部分。

## 六、为什么 reset 策略属于测试上下文生命周期，而不是 Mockito 细节

`@MockBean` 支持 `MockReset`，默认策略是测试方法之后重置。

这意味着 Boot 需要把 reset 动作接入测试生命周期：

- 每个测试方法执行前后
- 按配置重置 mock
- 避免调用记录和 stubbing 泄漏到下一个测试

如果只创建 mock 而不接入生命周期，测试之间会出现顺序依赖：

- 单独运行通过
- 全量运行失败

所以 reset 策略本质上是：

- **测试上下文隔离机制的一部分。**

当前实现里，reset 并不是 `MockitoPostProcessor` 在每个测试方法后自行完成，而是由 `ResetMocksTestExecutionListener` 在测试生命周期的 before/after 阶段查找带有 `MockReset` 元数据的 mock 并执行重置。

## 七、最小源码证据：这条链确实是“定义解析 -> BeanFactory 改写 -> 替换/新增”的上下文级机制

`@MockBean` 的源码注释已经明确说明：

- 已有唯一匹配 Bean 会被替换
- 没有已有 Bean 会新增
- 字段模式下 mock 还会注入字段
- 默认 `MockReset.AFTER` 会在每个测试方法后重置

再看 `MockitoPostProcessor` 的核心声明：

```java
public class MockitoPostProcessor implements InstantiationAwareBeanPostProcessor,
        BeanClassLoaderAware, BeanFactoryAware, BeanFactoryPostProcessor, Ordered {
```

以及它在 BeanFactory 阶段处理定义：

```java
@Override
public void postProcessBeanFactory(ConfigurableListableBeanFactory beanFactory) throws BeansException {
    Assert.isTrue(beanFactory instanceof BeanDefinitionRegistry,
            "'beanFactory' must be a ConfigurableListableBeanFactory");
    postProcessBeanFactory(beanFactory, (BeanDefinitionRegistry) beanFactory);
}
```

这证明：

- `@MockBean` 不是测试方法里的局部 mock
- 它通过 `MockitoPostProcessor` 进入 BeanFactory / BeanDefinitionRegistry
- 目标 Bean 的替换或新增发生在容器装配阶段
- 后续再由实例化后处理与测试生命周期完成字段和 reset 协作

## 八、为什么 `@MockBean` 当前需要关注迁移边界

当前 Spring Boot 3.4+ 已将 `@MockBean` 标记为 deprecated，推荐迁移到 Spring Framework 的：

- `@MockitoBean`

这不改变本文对既有 Boot 机制的分析价值，因为大量历史项目仍然使用 `@MockBean`。

但新代码不应忽略这个版本边界：

- 旧机制理解仍然必要
- 新项目需要根据 Spring Boot / Framework 版本选择推荐 API

## 九、几个最容易错的判断

### 1. `@MockBean` 只是 `@Mock` 的 Spring 版本

不完整。

它会进入 ApplicationContext，替换或新增 Bean，并参与测试字段注入与生命周期管理。

### 2. `@MockBean` 只能替换已有 Bean

不成立。

如果没有已有匹配 Bean，它会新增 mock Bean。

### 3. `@MockBean` 等测试开始后再替换 Bean 也一样

不成立。

它需要在 BeanFactory 装配阶段改写定义，避免真实 Bean 先实例化并拉起外部资源。

### 4. 测试字段和容器里的 mock 不是同一个对象也没关系

不成立。

字段和容器必须共享同一个 mock 实例，测试配置的 stubbing 才会影响被测 Bean。

### 5. `@MockBean` 永远是新项目推荐写法

不准确。

Spring Boot 3.4+ 已将它标记为 deprecated，新代码应关注 Spring Framework 的 `@MockitoBean`。

## 收网：`@MockBean` 统一的不是“怎么创建一个 mock”，而是“怎样把测试替身正式改写进 Spring 应用上下文”

现在可以回到开头的问题：为什么 `@MockBean` 不只是创建 Mockito 对象，却能让整个测试上下文里的依赖关系发生变化？

因为真实发生的是一条上下文改写链：

```text
@MockBean
   -> mock definition parsing
   -> MockitoPostProcessor
   -> BeanDefinition replace or register
   -> same mock injected into test field and application beans
   -> reset according to test lifecycle
```

所以这篇真正该带走的结论不是“`@MockBean` 很方便”，而是：

**Boot 把 Mockito mock 提升成了测试上下文装配的一等输入：它在 BeanFactory 阶段替换或新增 Bean，再把同一个 mock 注入测试字段并纳入 reset 生命周期；因此，测试替身真正改变的是应用依赖图，而不是测试类里的一个局部变量。**