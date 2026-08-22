# 为什么配置中心变更后，应用不需要重启：`@RefreshScope` 如何销毁旧 Bean 并重建新 Bean

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第三篇，承接前一篇 Bootstrap 上下文。重点放在 `RefreshScope`、`RefreshScopeBeanPostProcessor`、`ContextRefresher`、`ConfigurationPropertiesRebinder`，以及它们如何与 Bootstrap 配置注入协作。下一篇将进入 `DiscoveryClient` 服务发现抽象。

## 为什么配置中心改了配置，应用不需要重启，Bean 却能自动拿到新值

前面已经讲过，Bootstrap 上下文能把配置中心的 PropertySource 注入主环境。

但配置中心不会只启动时加载一次。它还会在运行中推送变更。

那么问题来了：

- 配置中心推送了新值
- Environment 里的 PropertySource 已经更新了
- 但已经创建好的 Bean 不会自动感知 Environment 变化

例如：

```java
@Value("${order.timeout}")
private int timeout;
```

在 Bean 创建时，`timeout` 已经被注入。Environment 变了，它也不会变。

要解决这个问题，Spring Cloud 引入了一个专门的 scope：

- `@RefreshScope`

**第一层问题是：普通 Bean 只在创建时读取一次配置，重新绑定需要 Scope 机制介入。**

**第二层问题是：`@RefreshScope` 不是自动刷新，而是销毁旧 Bean 再重建新 Bean。**

**第三层问题是：`ContextRefresher.refresh()` 是整条刷新链的入口，`ConfigurationPropertiesRebinder` 负责重新绑定 `@ConfigurationProperties` Bean。**

## 先看失败方案：为什么不能重新读取 Environment、不能靠 `@Value` 动态刷新、也不能重启应用

### 失败方案一：每个 Bean 自己定时重新读取 Environment

这会让每个 Bean 承担：

- 自己监听配置变更
- 自己决定哪些字段需要刷新
- 自己处理并发和线程安全问题

这会导致配置刷新逻辑散落在应用中，不可能统一维护。

### 失败方案二：`@Value` 天然支持动态刷新

`@Value` 只在 Bean 实例化时注入一次，不会自动感知 Environment 变化。

要让 `@Value` 拿到新值，必须让 Bean 重新创建。

### 失败方案三：配置变更就重启应用

这当然能解决问题，但代价是：

- 重启期间服务不可用
- 多个实例同时重启会造成资源浪费
- 配置频繁变更时，重启成本不可接受

所以需要一种机制，让 Bean 在配置变更后自动重建。

## `@RefreshScope` 的最小总图

```text
config center pushes new values
   -> Environment PropertySource updated
   -> ContextRefresher.refresh()
   -> RefreshScope destroys cached beans
   -> next time bean is requested, new instance created
   -> ConfigurationPropertiesRebinder re-binds @ConfigurationProperties
```

```text
[配置变更]
配置中心推送新值

   ->

[刷新入口]
ContextRefresher.refresh()

   ->

[Scope 销毁]
RefreshScope 清除已缓存的 Bean 实例

   ->

[Bean 重建]
下次请求时重新创建 Bean，注入新值

   ->

[Properties 重绑定]
ConfigurationPropertiesRebinder 重新绑定
```

## 一、`@RefreshScope` 的本质：它是一个 Scope

`@RefreshScope` 不是 Spring 默认的 singleton / prototype，而是一个自定义 Scope：

- `RefreshScope`

`RefreshScope` 继承 `GenericScope`，它的核心行为是：

- 在第一次请求时创建 Bean 并缓存
- 在 `refreshAll()` 被调用时，调用 `super.destroy()` 清除缓存
- 下一次请求时，创建新的 Bean 实例

来源：`spring-cloud-context/.../context/scope/refresh/RefreshScope.java:69,166-167`。

这意味着：

- singleton 生命周期内，Bean 不会被自动刷新
- `@RefreshScope` 的 Bean，在 refresh 触发后，下一次被依赖注入或方法调用时，才会拿到新实例

## 二、`ContextRefresher.refresh()`：刷新链的入口

`ContextRefresher.refresh()` 是整条刷新链的入口方法，源码里它拆成了两层：

```java
public synchronized Set<String> refresh() {
    Set<String> keys = refreshEnvironment();
    this.scope.refreshAll();
    return keys;
}

public synchronized Set<String> refreshEnvironment() {
    Map<String, Object> before = extract(this.context.getEnvironment().getPropertySources());
    updateEnvironment();
    Set<String> keys = changes(before, extract(this.context.getEnvironment().getPropertySources())).keySet();
    this.context.publishEvent(new EnvironmentChangeEvent(this.context, keys));
    return keys;
}
```

来源：`spring-cloud-context/.../context/refresh/ContextRefresher.java:92-104`。

它的核心步骤是：

1. `refreshEnvironment()` 记录刷新前的 Environment 快照
2. `updateEnvironment()`（abstract，子类实现）重新加载配置源（如 ConfigData）
3. 对比前后差异，得到变更键集合
4. 发布 `EnvironmentChangeEvent`
5. 回到 `refresh()`，调用 `RefreshScope.refreshAll()` 清除所有已缓存的 Bean 实例

## 三、`ConfigurationPropertiesRebinder`：重新绑定 `@ConfigurationProperties`

`@RefreshScope` 负责销毁和重建普通 Bean，但 `@ConfigurationProperties` 的绑定逻辑不是通过 Scope 重建实现的。

`@ConfigurationProperties` Bean 的重新绑定由 `ConfigurationPropertiesRebinder` 负责。

它自身就是 `@Component`，并实现 `ApplicationListener<EnvironmentChangeEvent>`：

```java
@Component
public class ConfigurationPropertiesRebinder
        implements ApplicationContextAware, ApplicationListener<EnvironmentChangeEvent> {
    // 监听 EnvironmentChangeEvent 后，遍历 @ConfigurationProperties Bean 重新绑定
}
```

也就是说，`@RefreshScope` 和 `ConfigurationPropertiesRebinder` 协作完成配置热刷新：

- `@RefreshScope` 负责普通 Bean（`@Value` + 自定义 scope）
- `ConfigurationPropertiesRebinder` 负责 `@ConfigurationProperties` Bean

## 四、`RefreshEndpoint`：把刷新暴露为 Actuator 端点

`ContextRefresher.refresh()` 通常不会自动触发，而是通过 Actuator 端点暴露：

- `POST /actuator/refresh`

`RefreshEndpoint` 调用 `ContextRefresher.refresh()`，返回变更的配置键列表。

这意味着：

- 配置中心推送变更后，通过 webhook 调用 `/actuator/refresh`
- 或者 Nacos 等配置中心自动触发 `RefreshEvent`
- 然后 `RefreshScope` 和 `ConfigurationPropertiesRebinder` 协作完成热刷新

## 五、为什么这篇必须在 Bootstrap 上下文之后

Bootstrap 上下文解决的是“配置中心怎么在启动时注入 Environment”。

`@RefreshScope` 解决的是“配置中心变更后，Environment 已更新，但 Bean 怎么重建”。

如果不先理解：

- Bootstrap 把 PropertySource 装进 Environment

就无法理解：

- `updateEnvironment()` 重新加载了哪些 PropertySource
- 刷新前后对比的是哪些配置源

所以：

- Bootstrap 上下文是配置注入
- `@RefreshScope` 是配置注入后的运行时重建

## 六、几个最容易错的判断

### 1. `@RefreshScope` 会自动侦测配置变更并刷新

不成立。

它需要 `ContextRefresher.refresh()` 被触发，通常是 Nacos 等配置中心通过 `RefreshEvent` 调用。

### 2. `@RefreshScope` 的 Bean 是实时无感刷新的

不准确。

`@RefreshScope` 是销毁旧 Bean 后，下次被请求时再创建新 Bean。如果 Bean 已经注入到其他 singleton 中，那么 singleton 持有的引用不会自动刷新。

### 3. `@ConfigurationProperties` 自动参与 `@RefreshScope` 刷新

不成立。

`@ConfigurationProperties` 的重绑定由 `ConfigurationPropertiesRebinder` 完成，不是通过 `@RefreshScope` 的 Scope 机制。

### 4. `ContextRefresher.refresh()` 只刷新 `@RefreshScope` Bean

不完整。

它还会发布 `EnvironmentChangeEvent`，触发 `ConfigurationPropertiesRebinder` 和其他监听器。

### 5. 配置刷新不需要考虑 `@RefreshScope` 和普通 Bean 的边界

不成立。

只有 `@RefreshScope` 标注的 Bean 会被销毁重建，普通 singleton 不受影响，这是设计上刻意的边界。

## 收网

现在可以回到开头的问题：为什么配置中心改了配置，应用不需要重启，Bean 却能自动拿到新值？

因为 Spring Cloud 通过 `@RefreshScope` 自定义 Scope 机制，在 `ContextRefresher.refresh()` 被触发后，销毁已缓存的 Bean 实例，并在下一次请求时创建新 Bean；同时 `ConfigurationPropertiesRebinder` 负责重新绑定 `@ConfigurationProperties` Bean。

所以这篇真正该带走的结论不是“配置变了，Bean 自己就更新了”，而是：

**`@RefreshScope` 通过 Scope 级的 Bean 缓存管理，在 `ContextRefresher.refresh()` 触发后销毁旧 Bean 并重建新 Bean；`ConfigurationPropertiesRebinder` 监听 `EnvironmentChangeEvent` 重新绑定 `@ConfigurationProperties`。两者协作，让配置中心变更后，应用不需要重启就能拿到新值。**

下一篇进入 `DiscoveryClient` 服务发现抽象。