# `@Scheduled` 的定时任务到底是怎样被注册、调度和取消的：Spring 如何把 cron、fixedDelay 和 fixedRate 组织成一条调度主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring `@Scheduled` 主线：`@EnableScheduling` 如何通过 `SchedulingConfiguration` 注册 `ScheduledAnnotationBeanPostProcessor`，为什么扫描和注册定时任务要等到 `SmartInitializingSingleton` 而不是创建 Bean 时顺手做，三种调度策略怎么对应不同的 `TaskScheduler` 方法，以及 `ScheduledTaskRegistrar` 如何在容器关闭时取消所有活跃任务。`@Async` 与 `@Scheduled` 的组合、TaskScheduler 与 TaskExecutor 的家族关系已在前面篇中展开。

## 为什么 `@Scheduled` 不是“启动一个定时器”这么简单

前面 `@Async` 篇已经展示了 Spring 如何把注解、BPP、AOP 代理和执行器串成一条异步主线。

`@Scheduled` 看起来和 `@Async` 很像：

- 都是方法级注解
- 都通过 BPP 注册
- 都需要一个执行器

但两者实际上有非常关键的区别：

- `@Async` 依赖于外部调用触发，通过代理拦截执行
- `@Scheduled` 是容器主动按时间策略拉起方法，不需要外部调用者

这意味着 `@Scheduled` 的注册时机、执行方式和生命周期管理，都和 `@Async` 完全不同。

第一层问题是：**定时任务的注册时机，天然比 `@Async` 晚。**

`@Scheduled` 方法只有在 Bean 创建完成后才能被扫描，但注册任务还需要一个 `TaskScheduler` 就绪。如果像 `@Async` BPP 一样在 `postProcessAfterInitialization` 里直接注册，很可能遇到 TaskScheduler 还没创建。因此 Spring 把实际注册推迟到 `SmartInitializingSingleton.afterSingletonsInstantiated()`，确保所有单例 Bean 都已就绪。

第二层问题是：**三种调度策略，对应三种不同的底层定时器方法。**

- `cron` 使用 `CronTrigger` 表达式
- `fixedRate` 对应 `scheduleAtFixedRate`
- `fixedDelay` 对应 `scheduleWithFixedDelay`

如果这三种策略用同一个注册方法处理，上层语义会混乱。Spring 在 `ScheduledTaskRegistrar` 中分别维护列表，再按策略交给 `TaskScheduler` 的不同方法。

第三层问题是：**定时任务需要更完整的生命周期管理。**

`@Async` 方法执行完就可以结束，但 `@Scheduled` 任务是长期存在的后台线程。

容器关闭时，必须主动取消所有 `ScheduledTask`，否则非守护线程可能阻止 JVM 退出。`ScheduledAnnotationBeanPostProcessor` 同时实现了 `DestructionAwareBeanPostProcessor` 和 `DisposableBean`，在容器销毁时由 `ScheduledTaskRegistrar` 遍历所有活跃任务并取消。

因此，本文真正要回答的问题不是“`@Scheduled` 注解怎么用”，而是：

**为什么 `@Scheduled` 必须被实现成“BPP 采集 + 延迟注册 + 策略分发 + 生命周期管理”的完整调度主线？**

## 先看失败方案：为什么不能“创建 Bean 时顺手注册定时任务”“cron 和 fixedRate 用同一个方法”“不跟踪任务对象”

### 失败方案一：`postProcessAfterInitialization` 时直接注册定时任务

这看起来最直接：

- 扫描到 `@Scheduled` 方法
- 立即创建定时任务并提交给 `TaskScheduler`

但此时 `TaskScheduler` 可能尚未创建——它本身也是一个 Bean，不一定在该 BPP 处理时已经实例化。如果此时直接注册，后续 `TaskScheduler` 创建后，任务会被遗漏。

因此 Spring 选择在 `afterSingletonsInstantiated()` 时注册，确保所有单例都已创建。

### 失败方案二：cron、fixedDelay、fixedRate 用同一个注册方法

如果只用一个注册方法，`ScheduledTaskRegistrar` 就无法区分策略，也无法针对不同策略调用 `TaskScheduler` 的不同方法。

Spring 把它们分开，让 `registrar` 分别维护列表，最后再分别调用 `scheduleCronTask`、`scheduleFixedRateTask` 和 `scheduleFixedDelayTask`。

### 失败方案三：任务提交后不跟踪，关闭时靠线程池自己退出

如果只提交任务而不保留 `ScheduledTask` 或 `ScheduledFuture` 引用，容器关闭时无法主动取消定时任务，只能依赖线程池的 `shutdown`。

但非守护线程可能阻止 JVM 退出，导致进程不能正常关闭。Spring 通过 `ScheduledTaskRegistrar.scheduledTasks` 集合跟踪所有活跃任务，关闭时逐个取消。

## `@Scheduled` 主线的最小总图

```text
@EnableScheduling
   -> SchedulingConfiguration
   -> ScheduledAnnotationBeanPostProcessor
   -> postProcessAfterInitialization (scan methods)
   -> afterSingletonsInstantiated (register tasks)
   -> ScheduledTaskRegistrar
   -> scheduleCronTask / scheduleFixedRateTask / scheduleFixedDelayTask
   -> ScheduledTask tracking
   -> destroy: cancel all tasks
```

## 一、`@EnableScheduling`：与 `@EnableAsync` 共享相同导入模式

`@EnableScheduling` 同样通过 `@Import(SchedulingConfiguration.class)` 导入配置，注册 `ScheduledAnnotationBeanPostProcessor`。

所以它和 `@EnableAsync` 的启动入口结构相同，但下游完全不同：

- `@EnableAsync` 导出的 BPP 在初始化后创建代理
- `@EnableScheduling` 导出的 BPP 在初始化后采集方法，再在单例全部就绪后注册任务

相同的是：两者都通过 `@Import` 把基础设施引入容器，而不是在注解所在类上直接修改行为。

## 二、`ScheduledAnnotationBeanPostProcessor`：采集和注册是两阶段，不是一次完成

这个 BPP 在 `postProcessAfterInitialization` 中做了第一件事：

- 扫描当前 Bean 的 `@Scheduled` 方法
- 创建 `ScheduledMethodRunnable` 和对应的 `CronTask` / `IntervalTask`
- 把任务暂存到 `ScheduledTaskRegistrar` 的列表中

但此时 `TaskScheduler` 可能还没组建，所以任务不会立即被调度。

真正的注册发生在 `afterSingletonsInstantiated()`：

- 获取或决议 `TaskScheduler`
- 让 `ScheduledTaskRegistrar` 执行调度
- 如果尚未设置任何 scheduler，Registrar 会使用 `Executors.newSingleThreadScheduledExecutor()` 兜底

这种两阶段设计的原因是：

- 采集阶段不需要 TaskScheduler，可以尽早收集方法
- 注册阶段依赖 TaskScheduler，必须等所有单例就绪

## 三、三种调度策略对应三种不同的定时器模型

`@Scheduled` 支持三种互斥的调度策略，Spring 通过 `ScheduledTaskRegistrar` 分别管理。

### cron

基于 `CronExpression` 的日历语义，适合日报、周报等固定时间点触发。

`ScheduledTaskRegistrar` 调用 `taskScheduler.schedule(runnable, new CronTrigger(cron))`。

### fixedDelay

上次执行完成后，等待固定延迟再启动下一次执行。适合防堆积的后台处理任务。

`ScheduledTaskRegistrar` 调用 `taskScheduler.scheduleWithFixedDelay(runnable, delay)`。

### fixedRate

上次执行开始后，经过固定间隔再启动下一次执行。如果上次执行时间超过间隔，等待当前任务完成后立即执行下一次。

`ScheduledTaskRegistrar` 调用 `taskScheduler.scheduleAtFixedRate(runnable, rate)`。

如果三种策略同时设置，`processScheduledTask` 会抛出 `IllegalArgumentException`。

### initialDelay

所有策略都支持 `initialDelay`，在首次执行前等待指定的延迟时间。

## 四、`ScheduledTaskRegistrar`：不只是注册，还负责任务生命周期的跟踪与取消

`ScheduledTaskRegistrar` 在 BPP 构造时创建，贯穿容器生命周期。

它主要承担三件事：

1. 暂存任务
2. 在 `TaskScheduler` 就绪后统一调度
3. 在容器关闭时取消所有任务

暂存阶段：

- 如果 `taskScheduler == null`，任务被加入 `cronTasks` / `fixedDelayTasks` / `fixedRateTasks` 列表和 `unresolvedTasks` 映射
- 注册阶段：`scheduleTasks()` 遍历所有暂存列表，重新调用 `scheduleCronTask` / `scheduleFixedRateTask` / `scheduleFixedDelayTask` 方法
- 此时 `taskScheduler` 已就绪，任务被真正调度，返回 `ScheduledTask` 对象

取消阶段：

- 容器关闭时，`ScheduledAnnotationBeanPostProcessor.destroy()` 调用 `registrar.destroy()`
- `registrar.destroy()` 遍历 `scheduledTasks` 集合，逐个调用 `task.cancel(false)`
- 如果使用了 Registrar 创建的本地执行器，它也会被关闭

## 五、`ScheduledTask`：让容器可以跟踪和取消每个活跃任务

`ScheduledTask` 包装了 `ScheduledFuture`，让容器可以在关闭时取消定时任务。

如果没有 `ScheduledTask`：

- 任务提交后，只有线程池内部持有引用
- 容器关闭时，无法感知哪些任务还在运行
- 非守护线程可能阻止 JVM 退出

因此 `ScheduledTask` 不是冗余设计，而是定时任务生命周期管理的核心。

## 六、为什么这篇必须放在 `@Async` 之后

`@Scheduled` 和 `@Async` 共享了很多机制：

- 都通过 `@Enable*` 导入配置
- 都通过 BPP 发现方法
- 都依赖执行器

但 `@Scheduled` 的注册时机、任务生命周期和取消策略与 `@Async` 不同。把这篇文章放在 `@Async` 之后，可以让读者先理解 BPP + 执行器的通用模式，再理解定时任务独立的延迟注册和生命周期管理。

## 七、几个最容易错的判断

### 1. `@Scheduled` 方法在 Bean 创建时就直接注册到定时器

不成立。

采集和注册是两阶段，真正调度发生在 `afterSingletonsInstantiated()`。

### 2. cron、fixedDelay、fixedRate 可以同时设置

不成立。

三者互斥，同时设置会抛出异常。

### 3. `fixedRate` 如果任务执行时间超过间隔，会并发执行

不成立。

`scheduleAtFixedRate` 会在任务完成后立即执行下一次，不会堆积。

### 4. 容器关闭时，定时任务会自动随线程池退出

不成立。

Spring 需要主动取消 `ScheduledTask`，否则非守护线程可能阻止 JVM 退出。

### 5. `ScheduledTaskRegistrar` 在每次调度时都会重新创建

不成立。

它在 BPP 构造时创建，贯穿容器生命周期，同时承担暂存、调度和取消。

## 收网：`@Scheduled` 统一的不是“定时执行方法”，而是“cron、fixedDelay、fixedRate 如何经过 BPP 和 Registrar 进入 TaskScheduler，并在容器关闭时统一取消”

现在可以回到开头的问题：为什么 `@Scheduled` 看起来只是一个定时注解，Spring 却要拆出采集、延迟注册、策略分发和生命周期管理？

因为它真正要解决的不是“定期执行一个方法”，而是：

- 注解方法如何被采集
- 任务如何等到 TaskScheduler 就绪后再注册
- 三种调度策略如何对应不同的定时器方法
- 容器关闭时，定时任务如何被统一取消

所以 Spring 的调度主线可以压缩成：

```text
@EnableScheduling
   -> ScheduledAnnotationBeanPostProcessor
   -> postProcessAfterInitialization (scan)
   -> afterSingletonsInstantiated (register)
   -> ScheduledTaskRegistrar
   -> scheduleCronTask / scheduleFixedRateTask / scheduleFixedDelayTask
   -> ScheduledTask tracking
   -> destroy: cancel all tasks
```

因此，这篇真正该带走的结论不是“Spring 支持 `@Scheduled`”，而是：

**Spring 把定时任务问题从“一个方法怎么定期执行”提升成了“注解方法采集、延迟注册、三种调度策略分发和任务生命周期管理”的容器级调度主线。**

这也留下了下一篇最自然的问题：既然 `@Async` 和 `@Scheduled` 都已经把“谁执行、什么时候执行”立住了，那 `@Cacheable` 又是如何把方法返回值缓存起来，在后续调用中跳过执行、直接返回缓存结果的？

下一篇进入 Spring 的 `@Cacheable` 缓存抽象主线。