# 为什么 Nacos 的配置能在 `application.yml` 之后、Bean 创建之前就进入 Environment：`NacosPropertySourceLocator` 如何实现 PropertySourceLocator

> 本文基于 Spring Cloud Alibaba 2025.0.0.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-alibaba` 的第二篇，承接前一篇总开篇。重点放在 `NacosPropertySourceLocator`、`NacosPropertySourceBuilder`、`NacosPropertySourceRepository`、`NacosConfigDataLoader`，以及它们如何把 Nacos 配置中心接入 Bootstrap 上下文。下一篇将进入 Nacos 配置动态刷新。

## 为什么 Nacos 配置不需要在 `application.yml` 里写具体配置项

Commons 卷已经讲过 Bootstrap 上下文和 `PropertySourceLocator`。

Nacos 的 `NacosPropertySourceLocator` 实现了 `PropertySourceLocator`，在 Bootstrap 阶段被调用，从 Nacos 拉取配置并注入 Environment。

**第一层问题是：`NacosPropertySourceLocator` 是 Commons `PropertySourceLocator` 在 Nacos 上的实现。**

**第二层问题是：`NacosPropertySourceBuilder` 负责把 Nacos 的配置字符串解析成 Spring 的 PropertySource。**

**第三层问题是：`NacosConfigDataLoader` 是 Boot 2.4+ ConfigData 路径的 Nacos 实现。**

## 一、`NacosPropertySourceLocator`：配置加载的入口

`NacosPropertySourceLocator` 实现 `PropertySourceLocator`，在 Bootstrap 上下文中被调用：

```java
public class NacosPropertySourceLocator implements PropertySourceLocator {

    @Override
    public PropertySource<?> locate(Environment environment) {
        // 从 Nacos 拉取配置
        // 按优先级加载：默认 → 带后缀 .yml → profile
        // 返回 CompositePropertySource
    }
}
```

`locate()` 按优先级加载：

- 默认 dataId（`${spring.application.name}`）
- 带后缀的 dataId（`${spring.application.name}.yml`）
- profile 配置（`${spring.application.name}-dev.yml`）

返回的 `CompositePropertySource` 包含多个子 PropertySource，优先级高的排在前面。

## 二、`NacosPropertySourceBuilder`：配置字符串转 PropertySource

`NacosPropertySourceBuilder.build()` 解析 Nacos 返回的配置内容，根据配置的格式（properties / yaml / json）转换为 Spring 的 `PropertySource` 对象。

## 三、`NacosConfigDataLoader`：Boot 2.4+ ConfigData 路径

在 Boot 2.4+ 版本中，Bootstrap 上下文不再是唯一入口。`NacosConfigDataLoader` 实现 `ConfigDataLoader`，让 Nacos 配置也能通过 ConfigData 路径加载。

`NacosConfigDataLocationResolver` 接在 ConfigData 链中，解析 `nacos:` 前缀的配置位置。

## 四、快照管理：`NacosSnapshotConfigManager`

`NacosSnapshotConfigManager` 负责本地快照管理：

- 拉取 Nacos 配置后，保存本地快照
- 当 Nacos 不可用时，使用快照
- 快照的目录和策略由配置控制

## 五、为什么这篇必须紧跟总开篇

总开篇讲清楚了 Alibaba 和 Commons 的关系。

`NacosPropertySourceLocator` 是 Commons `PropertySourceLocator` 的第一个 Alibaba 实现。不先理解 Commons 的 Bootstrap 和 `PropertySourceLocator`，就无法理解 Nacos 配置为什么在启动早期就能注入。

## 六、几个最容易错的判断

### 1. `NacosPropertySourceLocator` 直接返回 Nacos 的原始配置字符串

不成立。

它通过 `NacosPropertySourceBuilder` 把配置字符串解析成 Spring 的 `PropertySource`。

### 2. Nacos 配置加载只需要 `NacosPropertySourceLocator` 就够了

不完整。

Boot 2.4+ 还可以通过 `NacosConfigDataLoader` 从 ConfigData 路径加载。

### 3. 快照管理是可有可无的

不成立。

当 Nacos 不可用时，快照是应用启动的唯一配置来源。

## 收网

现在可以回到开头的问题：为什么 Nacos 配置不需要在 `application.yml` 里写具体配置项？

因为 `NacosPropertySourceLocator` 在 Bootstrap 阶段被调用，从 Nacos 拉取配置，通过 `NacosPropertySourceBuilder` 解析成 `PropertySource`，再注入 Environment；`NacosConfigDataLoader` 提供 Boot 2.4+ ConfigData 路径，`NacosSnapshotConfigManager` 管理本地快照。

所以这篇真正该带走的结论不是“Nacos 配置会自动加载”，而是：

**`NacosPropertySourceLocator` 实现 Commons 的 `PropertySourceLocator` 契约，在 Bootstrap 阶段从 Nacos 拉取配置并注入 Environment；`NacosPropertySourceBuilder` 负责解析，`NacosSnapshotConfigManager` 负责快照，`NacosConfigDataLoader` 提供 ConfigData 接入路径。**

下一篇进入 Nacos 配置动态刷新。