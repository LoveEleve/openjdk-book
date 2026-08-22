# 为什么 LoadBalancer 和 CircuitBreaker 需要指标接入：Commons 可观测性如何与 Micrometer 协作

> 本文基于 Spring Cloud 2025.0 + Spring Boot 3.5.x + Spring Framework 6.2.x 与本机可用相关源码。本文是 `vol-spring-cloud-commons` 的第十二篇，也是最后一篇。重点放在 `MicrometerStatsLoadBalancerLifecycle`、`LoadBalancerTags`、`ObservedCircuitBreaker`、`CircuitBreakerObservation`、`HeartbeatMonitor`，以及它们如何把 Commons 的负载均衡和断路器能力接入 Micrometer 观测体系。本篇完成后，Commons 主干层、集成层、生产层和补深层已全部覆盖。

## 为什么负载均衡的指标不能只靠日志，还需要 Micrometer 接入

前几篇已经讲了 LoadBalancer 如何选实例、CircuitBreaker 如何保护调用。

但如果这些能力没有指标，运维系统面临的问题是：

- 负载均衡的效果如何？选实例的分布是否均匀
- 断路器触发了多少次？
- 熔断后 fallback 执行了多少次？

日志只能回答“某个时刻发生了什么”，指标才能回答“一段时间的趋势和分布”。

**第一层问题是：`MicrometerStatsLoadBalancerLifecycle` 把 LoadBalancer 的每次选实例结果记录为 Micrometer 指标。**

**第二层问题是：`ObservedCircuitBreaker` 把断路器的调用和 fallback 行为包装成 Observation。**

**第三层问题是：`HeartbeatMonitor` 把服务发现的心跳健康接入指标系统。**

## 一、`MicrometerStatsLoadBalancerLifecycle`：LoadBalancer 指标采集

`MicrometerStatsLoadBalancerLifecycle` 实现 `LoadBalancerLifecycle` 接口，在每次 loadbalancer 执行后记录指标：

- 活跃请求数（`loadbalancer.requests.active` gauge）
- 丢弃请求数（`loadbalancer.requests.discard` counter）
- 加上 `LoadBalancerTags` 附加的服务名、实例 ID 等维度

`LoadBalancerTags` 把服务名、实例 ID 等维度作为标签附加到指标上。

`LoadBalancerStatsAutoConfiguration` 在 `MeterRegistry` Bean 存在时，创建 `MicrometerStatsLoadBalancerLifecycle`：

```java
@Bean
@ConditionalOnBean(MeterRegistry.class)
public MicrometerStatsLoadBalancerLifecycle micrometerStatsLifecycle(MeterRegistry meterRegistry, ...) {
    return new MicrometerStatsLoadBalancerLifecycle(meterRegistry, loadBalancerFactory);
}
```

来源：`spring-cloud-loadbalancer/.../config/LoadBalancerStatsAutoConfiguration.java:41-46`。

## 二、`ObservedCircuitBreaker`：断路器 Observation

`ObservedCircuitBreaker` 把 `CircuitBreaker.run()` 的调用包装成 Micrometer Observation。它实现 `CircuitBreaker`，wrap 真实 delegate：

```java
public class ObservedCircuitBreaker implements CircuitBreaker {

    private final CircuitBreaker delegate;
    private final ObservationRegistry observationRegistry;

    public <T> T run(Supplier<T> toRun, Function<Throwable, T> fallback) {
        return this.delegate.run(
            new ObservedSupplier<>(this.customConvention,
                new CircuitBreakerObservationContext(SUPPLIER),
                "circuit-breaker", this.observationRegistry, toRun),
            new ObservedFunction<>(this.customConvention,
                new CircuitBreakerObservationContext(FUNCTION),
                "circuit-breaker fallback", this.observationRegistry, fallback));
    }
}
```

来源：`spring-cloud-commons/.../circuitbreaker/observation/ObservedCircuitBreaker.java:32-66`。

- 每次调用时，创建 `CircuitBreakerObservationContext`
- 通过 `ObservedSupplier` / `ObservedFunction` 包装监听
- 记录调用成功/失败
- 记录 fallback 执行情况

## 三、`HeartbeatMonitor` 与 `DiscoveryClient` 健康指标

`HeartbeatMonitor` 是一个通用的状态变更检测器，通过 `AtomicReference` 和 `compareAndSet` 判断最后一次心跳值是否发生变化：

```java
public class HeartbeatMonitor {
    private AtomicReference<Object> latestHeartbeat = new AtomicReference<>();

    public boolean update(Object value) {
        Object last = this.latestHeartbeat.get();
        if (value != null && !value.equals(last)) {
            return this.latestHeartbeat.compareAndSet(last, value);
        }
        return false;
    }
}
```

来源：`spring-cloud-commons/.../discovery/event/HeartbeatMonitor.java:27-42`。

它可以被用在服务发现心跳场景中，记录注册中心状态是否发生变化，但它本身是通用的，不绑定具体心跳来源。

## 四、为什么这篇要放在所有主干层和生产层之后

可观测性接线是 Commons 的“最后一公里”：

- 主干层负责能力
- 生产层负责暴露（Actuator）
- 可观测性负责量化（指标 / Observation）

如果前面没有讲清楚 LoadBalancer 和 CircuitBreaker，就无法理解“指标和 Observation 是从哪里来的”。

## 五、几个最容易错的判断

### 1. LoadBalancer 的指标只需要日志就能排查

不成立。

日志只能看到单次事件，指标才能看到趋势和分布。

### 2. `MicrometerStatsLoadBalancerLifecycle` 是默认装配的

不完整。

需要 classpath 上存在 Micrometer 和相关依赖时才生效。

### 3. `ObservedCircuitBreaker` 是新的断路器实现

不成立。

它是 `CircuitBreaker` 的装饰器，把调用包装成 Observation。

### 4. 可观测性接线只对 Actuator 有用

不完整。

Micrometer 指标可以导出到 Prometheus、Graphite、Datadog 等外部系统。

## 收网

现在可以回到开头的问题：为什么负载均衡的指标不能只靠日志，还需要 Micrometer 接入？

因为 `MicrometerStatsLoadBalancerLifecycle` 把 LoadBalancer 选实例结果变为指标，`ObservedCircuitBreaker` 把断路器调用包装成 Observation，`HeartbeatMonitor` 把服务发现心跳接入指标系统；三者共同把 Commons 的运行状态变成可量化的观测数据。

所以这篇真正该带走的结论不是“Commons 有指标”，而是：

**Commons 通过 `MicrometerStatsLoadBalancerLifecycle`、`ObservedCircuitBreaker` 和 `HeartbeatMonitor` 把负载均衡、断路器和心跳行为接入 Micrometer 观测体系，让 Commons 能力的运行状态不再是黑盒，而是可指标、可观测、可告警的量化数据。**

---

**卷尾：`vol-spring-cloud-commons` 至此完成。共 12 篇，覆盖总开篇、主干层（Bootstrap / @RefreshScope / DiscoveryClient / ServiceRegistry / @LoadBalanced / ReactorLoadBalancer / ServiceInstanceListSupplier 扩展策略）、集成层（NamedContextFactory）、生产层（RefreshEndpoint / DiscoveryClientHealthIndicator）、断路器抽象和可观测性接线。下一篇进入 `vol-spring-cloud-alibaba`。**