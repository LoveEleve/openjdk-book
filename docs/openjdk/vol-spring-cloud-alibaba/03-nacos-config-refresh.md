# 为什么 Nacos 配置变更后，应用不需要重启：`NacosConfigRefreshEventListener` 如何触发 RefreshEvent

> 本文基于 Spring Cloud Alibaba 2025.0.0.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-alibaba` 的第三篇，承接前一篇 Nacos 配置加载。重点放在 `NacosConfigRefreshEventListener`、`RefreshBehavior`、`SmartConfigurationPropertiesRebinder`，以及它们如何与 Commons 的 `@RefreshScope` / `ContextRefresher` 协作。下一篇将进入 Nacos 服务发现与注册。

## 为什么 Nacos 配置中心推送变更后，应用能自动刷新

Commons 卷已经讲过 `@RefreshScope` 和 `ContextRefresher.refresh()`。

但 Commons 的 `ContextRefresher.refresh()` 需要被外部触发。Nacos 配置中心推送变更后，谁负责触发这个刷新？

Nacos 的答案是：

- `NacosConfigRefreshEventListener`

**第一层问题是：`NacosConfigRefreshEventListener` 监听 Nacos 配置变更，发布 `RefreshEvent`，由 Commons 继续触发刷新链。**

**第二层问题是：`RefreshBehavior` 控制刷新行为：是全部刷新还是只刷新指定 Bean。**

**第三层问题是：`SmartConfigurationPropertiesRebinder` 重新绑定 `@ConfigurationProperties` Bean。**

## 一、`NacosConfigRefreshEventListener`：配置变更的监听入口

`NacosConfigRefreshEventListener` 监听 Nacos 配置中心的配置变更事件。

从本地源码看，它实现 `SmartApplicationListener`，只关心 `NacosConfigRefreshEvent`：

```java
public class NacosConfigRefreshEventListener implements SmartApplicationListener, ApplicationContextAware {

    @Override
    public boolean supportsEventType(Class<? extends ApplicationEvent> eventType) {
        return NacosConfigRefreshEvent.class.isAssignableFrom(eventType);
    }

    @Override
    public void onApplicationEvent(ApplicationEvent event) {
        applicationContext.publishEvent(new RefreshEvent(event.getSource(), null, "Refresh Nacos config"));
    }
}
```

也就是说，Nacos 侧并不直接调用 `ContextRefresher.refresh()`，而是：

- 收到 `NacosConfigRefreshEvent`
- 转发成 Commons 世界的 `RefreshEvent`
- 再由 Commons 的刷新链去调用 `ContextRefresher.refresh()`

## 二、`RefreshBehavior`：控制刷新粒度

`RefreshBehavior` 决定刷新行为：

- `SPECIFIC_BEAN`：只刷新发生变更的配置对应的 Bean
- `ALL_BEANS`：重新绑定所有 `@ConfigurationProperties` Bean

`spring.cloud.nacos.config.refresh-behavior` 控制这个行为。

## 三、`SmartConfigurationPropertiesRebinder`：重新绑定

`SmartConfigurationPropertiesRebinder` 是 `ConfigurationPropertiesRebinder` 的增强版：

- 监听 `EnvironmentChangeEvent`
- 根据 `spring.cloud.nacos.config.refresh-behavior` 选择策略
- `ALL_BEANS` 时调用父类 `rebind()`
- `SPECIFIC_BEAN` 时根据变更 key 前缀筛选对应的 `@ConfigurationProperties` Bean

本地源码的关键逻辑是：

```java
@Override
public void onApplicationEvent(EnvironmentChangeEvent event) {
    if (this.applicationContext.equals(event.getSource())
            || event.getKeys().equals(event.getSource())) {
        switch (refreshBehavior) {
        case SPECIFIC_BEAN -> rebindSpecificBean(event);
        default -> rebind();
        }
    }
}
```

它并不是替代 Commons 的 `ConfigurationPropertiesRebinder`，而是在其基础上增加“按变更 key 精确重绑”的能力。

## 四、为什么这篇必须紧跟 Nacos 配置加载

前一篇讲的是“配置怎么在启动时进入 Environment”。

这一篇讲的是“配置变更后，Environment 已更新，Bean 怎么刷新”。

两者是配置中心集成的两个阶段：

- 启动时注入
- 运行时刷新

## 五、几个最容易错的判断

### 1. Nacos 配置变更是直接应用刷新，不需要经过 Commons

不成立。

`NacosConfigRefreshEventListener` 最终触发的是 Commons 的 `ContextRefresher.refresh()` 和 `@RefreshScope`。

### 2. `RefreshBehavior` 是 Nacos 独有的

不完整。

`RefreshBehavior` 控制刷新策略，但最终执行还是通过 Commons 的 `ConfigurationPropertiesRebinder`。

### 3. `SmartConfigurationPropertiesRebinder` 和 `ConfigurationPropertiesRebinder` 没关系

不成立。

`SmartConfigurationPropertiesRebinder` 是 `ConfigurationPropertiesRebinder` 的增强版，提供了 `SPECIFIC_BEAN` 能力。

## 收网

现在可以回到开头的问题：为什么 Nacos 配置变更后，应用不需要重启？

因为 `NacosConfigRefreshEventListener` 监听 Nacos 配置变更，发布 `NacosConfigRefreshEvent`，最终触发 Commons 的 `@RefreshScope` 和 `ConfigurationPropertiesRebinder`；`RefreshBehavior` 控制刷新粒度，`SmartConfigurationPropertiesRebinder` 重新绑定 `@ConfigurationProperties` Bean。

所以这篇真正该带走的结论不是“Nacos 配置会自动刷新”，而是：

**Nacos 通过 `NacosConfigRefreshEventListener` 监听配置变更，触发 Commons 的 `RefreshEvent` 和 `@RefreshScope` 刷新链；`RefreshBehavior` 控制全部或局部刷新，`SmartConfigurationPropertiesRebinder` 重新绑定配置属性；因此，Nacos 配置变更后，应用不需要重启就能拿到新配置。**

下一篇进入 Nacos 服务发现与注册。