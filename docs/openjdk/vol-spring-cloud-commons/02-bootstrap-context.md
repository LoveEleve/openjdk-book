# 为什么 `bootstrap.yml` 能在 `application.yml` 之前生效：Bootstrap 上下文如何把配置中心注入 Boot 的 Environment

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第二篇，也是主干层的第一篇。重点放在 `BootstrapApplicationListener`、`BootstrapImportSelector`、`PropertySourceLocator`、`PropertySourceBootstrapConfiguration` 以及 bootstrap 上下文与普通 `ApplicationContext` 的关系。理解这条链之后，才能明白配置中心（Nacos / Apollo）的配置为什么能在应用的 `application.yml` 之前被加载。下一篇将进入 `@RefreshScope` 配置热刷新。

## 为什么配置中心的配置，不需要在 `application.yml` 里写地址

大多数人第一次接触 Spring Cloud 配置中心时，都会有一个很自然的疑问：

- 配置中心的地址本身也是配置
- 但如果它写在 `application.yml` 里，那应用启动时，要等到 `application.yml` 解析后才能知道配置中心在哪
- 但配置中心的功能恰恰是在 `application.yml` 解析之前就把配置注入

这看起来像是一个“先有鸡还是先有蛋”的问题。

Spring Cloud 的解法是：

- 再引入一个更早的引导上下文

引导上下文先启动，负责加载：

- 配置中心的地址
- 加密密钥
- 其他必须在普通配置之前知道的信息

然后引导上下文把这些信息写入 Environment，再让普通上下文继续加载。

**第一层问题是：Bootstrap 上下文不是冗余设计，而是“先有配置中心地址，才能加载配置中心内容”这个时序问题的必然产物。**

**第二层问题是：`BootstrapApplicationListener` 是 Bootstrap 上下文的入口，它比普通自动配置早一个阶段执行。**

**第三层问题是：`PropertySourceLocator` 是配置中心接入 Boot 的标准化接口。**

## 先看失败方案：为什么不能把配置中心地址写死在 `application.yml`、不能把配置中心地址硬编码、也不能在 `application.yml` 解析后再去拉配置中心

### 失败方案一：配置中心地址写在 `application.yml` 里

这会导致一个循环依赖：

- 要加载 `application.yml`，需要配置中心启动
- 要启动配置中心，需要 `application.yml` 里的地址

只有特殊场景可以通过 `spring.config.import` 解决，但配置中心的地址本身仍然需要提前知道。

### 失败方案二：把配置中心地址硬编码在应用代码里

这虽然能解决时序问题，但代价是：

- 不同环境要改代码
- 无法通过配置中心动态切换
- 配置中心地址本身变成不可管理的大配置

### 失败方案三：在 `application.yml` 解析后再异步拉取配置中心

这会导致应用先以“无配置”状态启动，然后才拿到配置中心的内容，可能造成：

- Bean 创建时配置尚未就绪
- 自动配置条件判断基于不完整的环境
- 应用启动完成后配置才生效，产生明显的“配置闪变”

## Bootstrap 上下文的最小总图

```text
SpringApplication starting
   -> BootstrapApplicationListener
   -> create bootstrap context
   -> PropertySourceLocator loads config from remote
   -> PropertySourceBootstrapConfiguration applies
   -> bootstrap PropertySources added to Environment
   -> main context loads with these sources
```

```text
[启动阶段]
SpringApplication 启动事件

   ->

[引导入口]
BootstrapApplicationListener

   ->

[引导上下文]
独立 ApplicationContext 加载 bootstrap 配置

   ->

[配置中心桥]
PropertySourceLocator

   ->

[属性源注入]
PropertySourceBootstrapConfiguration

   ->

[主上下文]
普通 ApplicationContext 启动时已拥有远程配置源
```

## 一、`BootstrapApplicationListener`：它比普通自动配置早一个阶段介入

`BootstrapApplicationListener` 监听 SpringApplication 的 `ApplicationEnvironmentPreparedEvent` 事件。

这个事件在 `application.yml` 加载完成后触发，但比 `createApplicationContext()` 和 `refresh()` 要早。

但要注意，bootstrap 不是默认开启的。`BootstrapApplicationListener.onApplicationEvent()` 方法会先检查 `bootstrapEnabled(environment)` 条件，确认当前是否已启用 bootstrap 上下文；只有通过 `spring.cloud.bootstrap.enabled=true` 或引入 `spring-cloud-starter-bootstrap` 后，才会进入 bootstrap 创建逻辑。

也就是说：

- `application.yml` 先加载
- `BootstrapApplicationListener` 再触发
- 引导上下文启动
- 配置中心被调用
- 远程配置作为新 PropertySource 加入 Environment
- 然后主上下文才开始创建和刷新

所以 bootstrap 配置的生效时间是在主上下文装配之前。

## 二、引导上下文是独立的 ApplicationContext

`BootstrapApplicationListener` 不是在主上下文里加几个 Bean，而是通过 `SpringApplicationBuilder` 创建一个全新的 `SpringApplication` 实例，并启动它：

```java
SpringApplicationBuilder builder = new SpringApplicationBuilder()
    .bannerMode(Mode.OFF)
    .environment(bootstrapEnvironment)
    .registerShutdownHook(false)
    .logStartupInfo(false)
    .web(WebApplicationType.NONE);
```

这个引导上下文负责：

- 加载 `bootstrap.yml` / `bootstrap.properties`
- 注册 `PropertySourceLocator` Bean
- 调用 `PropertySourceLocator` 获取远程配置

引导上下文完成后，把远程配置转成 `PropertySource` 添加到主上下文的 `Environment` 中，然后引导上下文就不再参与后续流程。

这种设计意味着：

- 引导上下文和主上下文是隔离的
- 引导上下文只负责“拉配置”
- 拉完即弃

## 三、`PropertySourceLocator`：配置中心接入 Boot 的标准化接口

`PropertySourceLocator` 是整个配置中心集成最核心的抽象：

```java
public interface PropertySourceLocator {
    PropertySource<?> locate(Environment environment);
}
```

实现类通过 `locate()` 方法返回一个 `PropertySource`，这个 PropertySource 会被添加到主上下文的 `Environment` 中。

Nacos 的 `NacosPropertySourceLocator`、Apollo 的 `ConfigPropertySourceLocator` 都是这个接口的实现。

这意味着：

- 任何配置中心，只要实现 `PropertySourceLocator`
- 就能通过 bootstrap 机制自动注入到 Boot 应用

## 四、`PropertySourceBootstrapConfiguration`：把 locator 的结果装进 Environment

`PropertySourceLocator` 只是返回 `PropertySource`，真正把它装进主上下文 Environment 的是：

- `PropertySourceBootstrapConfiguration`

它实现了 `ApplicationContextInitializer<ConfigurableApplicationContext>` 和 `ApplicationListener<ContextRefreshedEvent>`，在引导上下文刷新后通过 `doInitialize()` 方法遍历所有 `PropertySourceLocator` Bean，依次调用 `locateCollection()`，把返回的 `PropertySource` 集合按顺序插入主上下文的 `Environment` 中：

```java
private void doInitialize(ConfigurableApplicationContext applicationContext) {
    for (PropertySourceLocator locator : this.propertySourceLocators) {
        Collection<PropertySource<?>> source = locator.locateCollection(environment);
        // ... wrap into BootstrapPropertySource and insert
    }
    insertPropertySources(propertySources, composite);
    reinitializeLoggingSystem(environment);
    setLogLevels(applicationContext, environment);
    handleProfiles(environment);
}
```

`doInitialize()` 还会同时处理日志系统重新初始化、日志级别设置和 profile 处理，这说明 bootstrap 配置注入后 Environment 已经发生了结构性变化，需要同步更新日志和 profile 状态。

也就是说：

- locator 负责“拿到配置”
- `PropertySourceBootstrapConfiguration` 负责“装进去”，并同步更新日志和 profile

## 五、为什么这篇文章必须先于 `@RefreshScope`

`@RefreshScope` 解决的是“配置中心变更后，运行时 Bean 怎么重建”。

而 bootstrap 上下文解决的是“配置中心还没通过 PropertySource 注入时，应用怎么知道配置中心地址”。

前者是运行时刷新，后者是启动时注入。

如果不先理解：

- 配置中心怎么在启动时进入 Environment

就无法理解：

- 配置中心变更后，怎么通过 `RefreshScope` 刷新 Environment 里的 PropertySource

所以：

- Bootstrap 上下文是 `@RefreshScope` 的前置
- `@RefreshScope` 是 Bootstrap 的运行时扩展

## 六、几个最容易错的判断

### 1. `bootstrap.yml` 是 Cloud 专属配置，Boot 不需要

不准确。

Bootstrap 上下文是 Spring Cloud 引入的机制，且**不是默认开启的**，需要 `spring.cloud.bootstrap.enabled=true` 或 `spring-cloud-starter-bootstrap` 显式打开。

### 2. 引导上下文和主上下文是父子关系

不成立。

两者是独立的 `ApplicationContext`，引导上下文拉完配置后就被丢弃，不是父子关系。

### 3. `PropertySourceLocator` 只返回一个 PropertySource

通常不是。

`CompositePropertySource` 可以包含多个子 `PropertySource`，实现类可以返回多个配置源。

### 4. 没有 bootstrap，配置中心也能工作

不成立。

没有 bootstrap，配置中心的地址本身无法提前注入，配置中心无法在 `application.yml` 加载之前生效。

### 5. 引导上下文失败不影响主上下文

不成立。

引导上下文加载失败，通常会导致应用启动失败，因为必要的配置源没有被注入。

## 收网

现在可以回到开头的问题：为什么 `bootstrap.yml` 能在 `application.yml` 之前生效？

因为 Bootstrap 上下文是独立于主上下文提前启动的 ApplicationContext，它通过 `BootstrapApplicationListener` 在 `ApplicationEnvironmentPreparedEvent` 阶段介入，调用 `PropertySourceLocator` 获取远程配置，再通过 `PropertySourceBootstrapConfiguration` 注入主上下文。

所以这篇真正该带走的结论不是“bootstrap.yml 是另一个配置文件”，而是：

**Bootstrap 上下文是 Spring Cloud 为配置中心接入而设计的提前启动机制：它创建独立引导上下文，调用 `PropertySourceLocator` 获取远程配置，再通过 `PropertySourceBootstrapConfiguration` 注入主上下文的 Environment；因此，配置中心的配置才能在 `application.yml` 之后、普通 Bean 创建之前就进入应用。**

下一篇进入 `@RefreshScope` 配置热刷新。