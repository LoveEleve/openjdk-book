# 为什么打开一个属性，Boot 就能让部分执行路径切到虚拟线程：虚拟线程自动配置如何进入应用装配链

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接前一篇 WebFlux 自动配置，进入 Boot 3.2+ 的补深层主题：虚拟线程。重点放在 `spring.threads.virtual.enabled`、`Threading`、`OnThreadingCondition`、TaskExecutor / TaskScheduler 默认路径，以及 Servlet 容器线程模型切换的边界。本文不重复 JDK 虚拟线程调度器与 carrier thread 原理，而聚焦 Boot 如何根据 JDK 与属性事实把虚拟线程接入应用默认执行设施。下一篇可继续进入 AOT / Native Image 或 Elasticsearch 自动配置。

## 为什么只打开一个配置属性，应用里某些线程池行为就可能发生根本变化

在支持虚拟线程的 JDK 与 Spring Boot 版本里，很多项目只需要配置：

```properties
spring.threads.virtual.enabled=true
```

然后应用中某些默认执行路径就可能发生变化：

- TaskExecutor 不再使用传统平台线程池路径
- TaskScheduler 的线程创建策略发生变化
- Servlet 容器处理请求的线程模型可能发生变化
- 某些默认条件会根据当前 JDK 是否支持虚拟线程重新判断

这件事如果只从配置体验看，很容易被理解成：

- Boot 把所有 `ThreadPoolExecutor` 换成了虚拟线程

但这个理解太粗。

因为真实装配里至少要回答：

- 当前 JDK 是否真的支持虚拟线程
- 用户是否显式打开了 Boot 虚拟线程开关
- 当前默认执行器是否允许切换
- 某个组件是平台线程模型、虚拟线程模型，还是自己维护线程池
- Tomcat、TaskExecutor、TaskScheduler 等不同设施是否都遵循同一切换规则

也就是说，用户看到的是：

- “打开一个属性，默认线程模型变了”

源码层面真实发生的是：

- **Boot 把 JDK 能力事实、用户配置和不同执行设施的默认装配条件统一纳入虚拟线程判断链。**

第一层问题是：**虚拟线程支持不是一个普通默认值，而是运行时与 JDK 能力共同决定的条件路径。**

如果 JDK 本身不支持虚拟线程，Boot 不能因为配置写了 `true` 就假装切换成功。

第二层问题是：**虚拟线程不是把所有线程池参数机械替换，而是改变线程创建模型。**

传统线程池关心：

- core pool size
- max pool size
- queue capacity
- keep alive

虚拟线程路径很多时候关注的是：

- 每个任务是否创建独立虚拟线程
- 调度器如何承载执行
- 某些传统池化参数是否仍然有意义

所以 Boot 不能简单把平台线程池的所有配置原样套到虚拟线程路径。

第三层问题是：**Boot 必须允许用户显式开关，而不能根据 JDK 支持情况自动偷偷切换。**

因为线程模型变化会影响：

- 并发度
- 阻塞调用成本
- 线程局部状态使用方式
- 监控和排障习惯
- 第三方组件兼容性

因此，Boot 需要的是：

- JDK 能力满足
- 用户属性明确打开
- 具体自动配置分支允许切换

而不是“只要 JDK 新就自动换”。

所以本文真正要回答的问题不是“Boot 支持虚拟线程吗”，而是：

**为什么对 Boot 来说，虚拟线程必须被建模成一条由 JDK 能力、用户开关和具体执行设施条件共同决定的自动配置分支，而不是一次对全局线程池类型的机械替换。**

## 先看失败方案：为什么不能 JDK 支持就自动切换、不能把所有线程池都粗暴替换、也不能假设所有第三方组件都会自动虚拟线程化

### 失败方案一：只要 JDK 支持虚拟线程，Boot 就默认全部切换

这是最容易想到的方案。

但线程模型变化是有行为影响的，不能只根据“能力存在”就默默改变应用语义。

用户可能：

- 仍然依赖平台线程池的容量控制
- 依赖线程池队列做背压
- 依赖平台线程名与监控习惯
- 使用尚未适配虚拟线程的第三方组件

所以 Boot 必须让用户显式打开，而不是只根据 JDK 版本自动切换。

### 失败方案二：把所有 `ThreadPoolExecutor` 都替换成虚拟线程执行器

这也不准确。

因为应用中存在很多不同线程设施：

- TaskExecutor
- TaskScheduler
- Servlet 容器工作线程
- 用户自己声明的 Executor
- 第三方组件内部线程池

Boot 自动配置只能影响自己负责的默认设施，不能凭空重写用户和第三方的线程模型。

也就是说，`spring.threads.virtual.enabled=true` 并不等于：

- 应用里的每一条线程都会变成虚拟线程

### 失败方案三：虚拟线程路径仍然套用所有传统线程池参数

虚拟线程和传统平台线程池的资源模型不同。

如果 Boot 只是机械复用：

- core size
- max size
- queue capacity

很容易让配置语义变得虚假或误导。

所以虚拟线程自动配置必须明确哪些配置仍然有效，哪些配置在当前执行模型下被弱化或不再是核心控制点。

## 虚拟线程自动配置的最小总图

如果把这条链先压缩成最小模型，它可以写成下面这样：

```text
JDK supports virtual threads
   + spring.threads.virtual.enabled=true
   -> OnThreadingCondition matches
   -> Boot default executor/scheduler/container customizations choose virtual-thread path
   -> selected execution facilities use virtual threads
```

如果再换一种更适合理解职责的拆法，它可以分成下面五层：

```text
[能力前提]
JDK virtual thread support

   ->

[用户开关]
spring.threads.virtual.enabled

   ->

[条件系统]
Threading / OnThreadingCondition

   ->

[默认设施]
TaskExecutor / TaskScheduler / web server customizers

   ->

[运行结果]
部分 Boot 管理的执行路径切换线程模型
```

这张图最重要的价值，不是背属性名，而是把五个问题分开：

### 一、能力前提

回答：当前 JDK 是否具备虚拟线程能力？

### 二、用户开关

回答：用户是否明确要求启用？

### 三、条件系统

回答：自动配置如何把这两个事实翻译成命中结果？

### 四、默认设施

回答：哪些 Boot 管理的执行路径真正会消费这个结果？

### 五、运行结果

回答：为什么最终只是“部分路径切换”，而不是全应用线程魔法替换？

## 一、Boot 先把虚拟线程能力建模成 `Threading` 事实，而不是把属性散落到各个自动配置类

回到最外层，虚拟线程支持最重要的第一步不是：

- 创建一个虚拟线程 executor

而是：

- 把当前应用线程模型事实统一表达出来

这就是 `Threading` 与 `OnThreadingCondition` 这类条件入口的价值。

本地源码里的 `Threading.VIRTUAL.isActive(environment)` 明确要求两个条件同时成立：

- `spring.threads.virtual.enabled=true`
- 当前 Java 版本不低于 21

`Threading.PLATFORM` 则是虚拟线程路径不 active 时成立。

也就是说，Boot 不需要让每个自动配置类自己重复读取：

- JDK 版本
- 虚拟线程开关

而是把这件事收口成条件系统可以消费的事实。

## 二、为什么 `spring.threads.virtual.enabled` 必须是显式开关

虚拟线程最大的价值之一，是降低大量阻塞任务的线程承载成本。

但这不等于任何应用、任何线程路径都应该自动切换。

Boot 让用户显式写：

```properties
spring.threads.virtual.enabled=true
```

本质上是在要求用户明确表达：

- 我知道当前应用要切换到虚拟线程相关默认路径
- 我接受它对执行模型、资源控制和排障方式带来的变化

这比“JDK 新了就偷偷切换”更符合应用装配系统的设计原则：

- 能力存在不等于默认启用
- 用户意图仍然是自动配置的重要事实

## 三、为什么 TaskExecutor / TaskScheduler 是最自然的虚拟线程接入点

前面 `vol-spring` 已经讲过：

- `TaskExecutor` 是 Spring 异步执行抽象
- `TaskScheduler` 是 Spring 调度抽象

Boot 在这里做的，就是把默认实现与参数配置装起来。

所以虚拟线程支持最自然的接入点也是：

- 默认 TaskExecutor
- 默认 TaskScheduler

本地 TaskExecutor 配置就明确分成两条 bean 分支：

- `@ConditionalOnThreading(Threading.VIRTUAL)` 时创建 `SimpleAsyncTaskExecutor`
- `@ConditionalOnThreading(Threading.PLATFORM)` 时创建 `ThreadPoolTaskExecutor`

并且虚拟线程路径的 builder 会调用 `virtualThreads(true)`；传统线程池的 core/max/queue 等属性在虚拟线程路径下不再是同一组有效控制项。

这两条路径都属于 Boot 自己明确负责的执行设施，能够在条件成立时选择不同线程创建模型。

但这并不意味着：

- 用户自己声明的 executor 会被 Boot 强行替换

更准确的理解是：

- Boot 只调整自己提供的默认设施
- 用户显式定义仍然具有优先权

## 四、为什么 Web 容器的虚拟线程支持必须单独看，而不能和 TaskExecutor 混成一件事

Servlet 容器也有自己的请求执行线程模型。

但它和 Spring TaskExecutor 并不是同一个抽象：

- TaskExecutor 负责 Spring 任务提交
- Tomcat / Jetty / Undertow 负责 Web 请求承载

所以即使两者都可能使用虚拟线程，也不能简单说：

- Boot 换了一个全局 executor，所以 Web 容器也自动换了

更准确的理解是：

- 不同设施有各自的 customizer / 条件路径
- 当前 Boot 源码已经为 Tomcat、Jetty、Undertow 提供了对应的虚拟线程 WebServer customizer
- 它们是否切换，要看具体容器实现、类路径和 Boot 版本支持

这正是为什么虚拟线程篇不能只写一个“默认线程池切换”故事，而必须把不同执行设施分层。

## 五、为什么用户最终感知到的不是“所有线程变了”，而是“某些默认执行路径的承载成本降低了”

站在源码视角，Boot 这里会涉及：

- JDK 能力判断
- 属性绑定
- 条件匹配
- executor / scheduler / server customizer

但站在用户视角，最后感知到的通常是：

- 同样的阻塞任务可以承载更多并发
- 默认异步执行路径的线程模型发生变化
- 某些 Web 请求处理路径不再依赖传统平台线程池容量

这并不意味着应用中所有线程都被神奇替换，而是：

- **Boot 管理的默认设施，在条件成立时选择了不同线程承载模型。**

## 六、为什么虚拟线程不会自动解决所有并发问题

虚拟线程降低的是线程承载成本，不等于自动消除所有瓶颈。

应用仍然可能受限于：

- 数据库连接池大小
- 下游服务吞吐
- 锁竞争
- CPU 计算能力
- 阻塞调用本身的外部资源容量

所以即使启用了虚拟线程，也不能直接推导出：

- 连接池也应该无限增大
- 所有请求都能无限并发
- 业务一定会变快

Boot 的自动配置只负责把线程模型接进默认设施，不负责替应用解决所有资源容量问题。

## 七、最小源码证据：这条链确实是“Threading 条件 -> 默认设施分支”，不是全局线程替换

如果只讲到这里，读者仍然可能会觉得：

- 这是不是只是 JDK 虚拟线程的宣传式描述
- 源码里有没有直接证据说明 Boot 真把它做成条件自动配置

先看条件入口：

```java
VIRTUAL {
    @Override
    public boolean isActive(Environment environment) {
        return environment.getProperty("spring.threads.virtual.enabled", boolean.class, false)
                && JavaVersion.getJavaVersion().isEqualOrNewerThan(JavaVersion.TWENTY_ONE);
    }
}
```

来源：`spring-boot-autoconfigure/src/main/java/org/springframework/boot/autoconfigure/thread/Threading.java:41-51`。

自动配置再通过 `@ConditionalOnThreading` 选择平台或虚拟线程路径。

这证明第一层事实：

- 虚拟线程支持是条件系统的一部分，而不是某个全局替换开关
- 属性为 true 但 JDK 小于 21 时，`Threading.VIRTUAL` 仍不会 active

再看默认 TaskExecutor 路径：

```java
@Bean(APPLICATION_TASK_EXECUTOR_BEAN_NAME)
@ConditionalOnThreading(Threading.VIRTUAL)
SimpleAsyncTaskExecutor applicationTaskExecutorVirtualThreads(SimpleAsyncTaskExecutorBuilder builder) {
    return builder.build();
}

@Bean(APPLICATION_TASK_EXECUTOR_BEAN_NAME)
@ConditionalOnThreading(Threading.PLATFORM)
ThreadPoolTaskExecutor applicationTaskExecutor(ThreadPoolTaskExecutorBuilder builder) {
    return builder.build();
}
```

来源：`TaskExecutorConfigurations.java:60-70`。

这些设施分别决定自己是否消费线程模型条件。

这证明第二层事实：

- 不同执行设施有自己的接入边界
- Boot 只影响自己管理的默认设施
- 用户显式定义和第三方内部线程池不会被自动魔改

也就是说，Boot 的真实结构不是：

- “打开属性，所有线程立刻变成虚拟线程”

而是：

- **线程能力与用户意图先进入条件系统，再由具体自动配置分支选择是否切换自己的默认执行设施。**

## 八、为什么这篇适合作为 WebFlux 之后的补深层主线

看到这里，最值得回收的一个问题就是：

- 为什么虚拟线程放在 WebFlux 之后？

因为 WebFlux 和虚拟线程代表两种不同的并发模型讨论：

- WebFlux 侧重响应式非阻塞处理链
- 虚拟线程侧重以更低承载成本运行大量线程任务

两者都在解决并发承载问题，但不是同一种模型，也不能简单互相替代。

把它们连续放在一起，读者更容易看清：

- Boot 如何根据应用和设施事实选择执行模型
- 响应式并不等于虚拟线程
- 虚拟线程也不等于所有阻塞代码自动变快

## 九、几个最容易错的判断

### 1. JDK 支持虚拟线程后，Boot 就会默认全部切换

不成立。

通常还需要用户显式打开相关属性，并且具体自动配置分支支持这条路径。

### 2. `spring.threads.virtual.enabled=true` 会把应用中所有线程都变成虚拟线程

不成立。

它主要影响 Boot 管理的默认执行设施，用户和第三方自己创建的线程池不在自动替换范围内。

### 3. 虚拟线程启用后，连接池大小也应该无限增大

不成立。

线程承载成本下降，不等于数据库、下游服务或 CPU 资源容量无限增加。

### 4. Web 容器线程与 Spring TaskExecutor 是同一个线程池

不成立。

它们属于不同抽象和不同自动配置路径，是否支持虚拟线程也需要分别判断。

### 5. WebFlux 和虚拟线程是同一种并发模型

不成立。

WebFlux 以响应式非阻塞链为核心，虚拟线程以低成本线程承载为核心，两者可以讨论协作，但不能混为一谈。

## 收网：Boot 统一的不是“把全应用线程换掉”，而是“把虚拟线程能力纳入具体默认执行设施的条件装配路径”

现在可以回到开头的问题：为什么只打开一个属性，Boot 就可能让部分执行路径切到虚拟线程？

因为真实发生的不是全局线程魔法，而是一条条件装配链：

```text
JDK supports virtual threads
   + spring.threads.virtual.enabled=true
   -> Threading / OnThreadingCondition
   -> TaskExecutor / TaskScheduler / WebServer 等具体分支判断
   -> Boot 管理的部分默认设施切换线程模型
```

所以这篇真正该带走的结论不是“Boot 支持虚拟线程”，而是：

**Boot 把 JDK 能力、用户显式开关和具体执行设施条件统一纳入 `Threading` / `OnThreadingCondition` 判断，再由 TaskExecutor、TaskScheduler 或 WebServer 等各自的自动配置路径决定是否切换；因此，虚拟线程是具体默认执行设施的条件装配分支，而不是对整个应用线程世界的机械替换。**