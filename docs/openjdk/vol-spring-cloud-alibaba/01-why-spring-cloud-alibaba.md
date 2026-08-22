# 为什么有了 Spring Cloud Commons，还要 Spring Cloud Alibaba：从抽象定义到具体实现

> 本文基于 Spring Cloud Alibaba 2025.0.0.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-alibaba` 的总开篇，承接 `vol-spring-cloud-commons`。接下来会进入 Nacos Config、Nacos Discovery、Sentinel、Seata、RocketMQ Stream 等具体集成主线。本卷只讲 spring-cloud-alibaba 集成层（自动配置/注解支持/透传机制），不重复 Nacos / Sentinel / Seata / RocketMQ 本身源码。

## 为什么 Commons 已经定义了抽象，还需要 Alibaba 再实现一遍

前一卷已经讲清楚了 Spring Cloud Commons 的核心价值：

- `DiscoveryClient` 是服务发现契约
- `ServiceRegistry` 是注册契约
- `PropertySourceLocator` 是配置注入契约
- `CircuitBreaker` 是断路器契约
- `ReactorServiceInstanceLoadBalancer` 是负载均衡契约

但契约只是接口。它不能凭空工作。

要让一个真实应用跑起来，需要有人把这些接口实现：

- `NacosDiscoveryClient` 实现 `DiscoveryClient`
- `NacosServiceRegistry` 实现 `ServiceRegistry`
- `NacosPropertySourceLocator` 实现 `PropertySourceLocator`
- `SentinelCircuitBreakerFactory` 实现 `CircuitBreakerFactory`
- `NacosLoadBalancer` 实现 `ReactorServiceInstanceLoadBalancer`

Spring Cloud Alibaba 就是这些实现的集合。

**第一层问题是：Commons 定义契约，Alibaba 把契约落到 Nacos / Sentinel / Seata / RocketMQ 四类中间件上。**

**第二层问题是：Alibaba 不只是“实现接口”，还负责自动配置、注解支持和透传机制。**

**第三层问题是：Commons 的 `NamedContextFactory` 为每个服务隔离配置，Alibaba 利用这个机制为每个服务独立配置 Nacos / Sentinel 行为。**

## 本卷边界

本卷只覆盖 spring-cloud-alibaba 集成层，不重复中间件本身源码：

- **Nacos**（注册中心/配置中心）—— 独立学习 nacos 仓库源码
- **Sentinel**（限流框架）—— 独立学习 sentinel 仓库源码
- **Seata**（分布式事务）—— 独立学习 seata 仓库源码
- **RocketMQ**（消息队列）—— 独立学习 rocketmq 仓库源码

spring-cloud-alibaba 做的是：把这些中间件集成到 Spring Cloud 生态。

## 与 Commons 的桥接

| Alibaba 实现 | Commons 抽象 | 篇目 |
|---|---|---|
| `NacosPropertySourceLocator` | `PropertySourceLocator`（C-1） | 总开篇后第一篇 |
| `NacosConfigRefreshEventListener` | `@RefreshScope`（C-2） | 配置刷新篇 |
| `NacosDiscoveryClient` | `DiscoveryClient`（B-3） | 服务发现篇 |
| `NacosServiceRegistry` | `ServiceRegistry`（B-4） | 服务注册篇 |
| `NacosLoadBalancer` | `ReactorServiceInstanceLoadBalancer`（B-6） | 负载均衡篇 |
| `SentinelCircuitBreakerFactory` | `CircuitBreakerFactory`（E-1） | Sentinel 集成篇 |

## 本卷路线

按修复版规划，Alibaba 卷共 10 篇：

- A-1 总开篇（本篇）
- B-1 Nacos 配置加载
- B-2 Nacos 配置动态刷新
- B-3 Nacos 服务发现与注册
- B-4 Sentinel 三路限流
- B-5 Seata 三路透传 XID
- B-6 NacosLoadBalancer 权重负载均衡
- C-1 Sentinel 数据源与断路器
- D-1 Nacos 容错/心跳/优雅关闭
- D-2 RocketMQ Stream Binder

## 几个最容易错的判断

### 1. Alibaba 就是 Nacos

不成立。

Alibaba 包含 Nacos、Sentinel、Seata、RocketMQ 四类中间件的集成，Nacos 只是其中之一。

### 2. 学 Alibaba 等于学 Nacos 源码

不成立。

本卷只讲集成层，Nacos 本身源码应单独学习。

### 3. Alibaba 和 Commons 是竞争关系

不成立。

Commons 定义抽象，Alibaba 实现抽象，两者的关系是标准和实现。

### 4. Alibaba 的配置刷新和 `@RefreshScope` 无关

不成立。

Alibaba 通过 `NacosConfigRefreshEventListener` 触发 `RefreshEvent`，进而触发 `@RefreshScope` 刷新。

## 收网

现在可以回到开头的问题：为什么有了 Commons，还要 Alibaba？

因为 Commons 定义契约，Alibaba 把契约落到 Nacos / Sentinel / Seata / RocketMQ 四类中间件上，包括自动配置、注解支持和透传机制。

所以这篇真正该带走的结论不是“Alibaba 是另一个 Spring Cloud”，而是：

**Spring Cloud Alibaba 是 Spring Cloud Commons 抽象在阿里中间件生态上的具体实现层：它通过自动配置和注解支持，把 `PropertySourceLocator`、`DiscoveryClient`、`ServiceRegistry`、`CircuitBreakerFactory`、`ReactorServiceInstanceLoadBalancer` 等契约落到 Nacos、Sentinel、Seata 和 RocketMQ 上，让 Commons 的分布式协作抽象在真实中间件中可运行。**

下一篇进入 Nacos 配置加载：`NacosPropertySourceLocator`。