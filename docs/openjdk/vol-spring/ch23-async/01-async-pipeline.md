# `@Async` 到底怎么切线程：Spring 如何把注解、AOP 代理、TaskExecutor 和异常出口串成一条异步主线

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring `@Async` 主线：`@EnableAsync` 如何通过导入配置注册 `AsyncAnnotationBeanPostProcessor`，BPP 如何在 Bean 初始化后创建 AOP 代理，代理又如何选择 `TaskExecutor`、提交任务并处理不同返回值和异常。TaskExecutor 抽象本身已在前文展开，`@Scheduled` 的调度语义会在下一篇继续展开。

## 为什么 `@Async` 看起来只是一个注解，真正运行时却要经过六层链路

到前面为止，这卷已经把 `TaskExecutor` 和 `BeanPostProcessor` 两条基础主线分别立住了：

- `TaskExecutor` 统一“任务交给谁执行”的协议
- BPP 统一“容器在哪个生命周期阶段允许扩展切入”

现在把 `@Async` 放进来，就会出现一个非常典型的 Spring 组合问题：

- 一个方法上写了 `@Async`
- 调用它时为什么会切到另一个线程
- 这个方法又到底被谁拦截、交给哪个执行器、异常最后去了哪里

如果只从使用层看，`@Async` 很容易被讲成：

- 给方法加个注解
- Spring 自动换个线程执行

这个说法虽然描述了结果，却把整条最值得学习的主线全部折叠掉了。

第一层问题是：**`@Async` 不直接执行异步，它首先只是一个需要被 BPP 识别的声明信号。**

也就是说，方法上写了 `@Async` 并不会改变 Java 方法本身的调用语义。

真正改变调用语义的，是后续发生的：

- BPP 识别方法
- 创建 Advisor
- 生成代理
- 外部调用经过代理拦截

第二层问题是：**异步不是“换线程”这么简单，还要选择执行器、适配返回值并定义异常出口。**

不同返回类型会走不同提交路径：

- `void`
- `Future`
- `ListenableFuture`
- `CompletableFuture`

而异常也不会统一回到调用方：

- 有 Future，调用方可以通过结果对象观察失败
- `void` 方法没有结果句柄，只能走 `AsyncUncaughtExceptionHandler`

第三层问题是：**`@Async` 的代理边界决定了哪些调用会异步、哪些调用会绕过异步。**

外部通过代理调用时，异步拦截才能发生；同一个类内部用 `this.method()` 调用时，通常不会经过代理。

因此，本文真正要回答的问题不是“`@Async` 怎么使用”，而是：

**为什么 `@Async` 必须被实现成“配置导入 → BPP → AOP 代理 → 执行器选择 → 异步提交 → 返回值与异常处理”的完整运行时链路？**

## 先看失败方案：为什么不能让注解自己切线程、所有调用都异步、异常统一丢回调用方

### 失败方案一：扫描到 `@Async` 后直接在线程里调用方法

这看起来很直接：

- 反射找到方法
- 调用时创建线程
- 在线程里执行目标方法

但这个方案会绕开 Spring 已经建立的容器能力：

- Bean 生命周期和代理体系
- 执行器注入与替换
- 方法拦截排序
- 返回值与异常统一处理

它还无法自然处理：

- 目标对象的其他 AOP advisor
- `@Async("executorName")` 的执行器限定
- Spring Boot 提供的默认线程池

所以 `@Async` 不能只是运行时反射工具，而必须接入 Spring AOP 和 BPP 主线。

### 失败方案二：只要有 TaskExecutor，所有方法调用都异步

这会直接破坏同步方法和调用方的语义。

`@Async` 的作用域应该是：

- 只有声明了异步语义的方法被拦截
- 没有注解的方法仍按普通调用执行

因此 Spring 需要先通过 advisor 判断当前 Bean 是否真的包含可异步方法，而不是把整个 Bean 或整个调用链都异步化。

### 失败方案三：所有异步异常都重新抛回调用线程

对 `void` 方法来说，这个方案根本不可行：

- 调用线程已经返回
- 异步线程里的异常没有同步调用栈可返回

如果强行抛回，最终只会变成线程池日志里的静默异常，调用方仍然不知道任务失败。

所以 Spring 必须根据返回值类型区分异常出口，而不是假设所有异步调用都能同步观察结果。

## `@Async` 主线的最小总图

```text
@EnableAsync
   -> AsyncConfigurationSelector
   -> ProxyAsyncConfiguration
   -> AsyncAnnotationBeanPostProcessor
   -> AOP proxy after initialization
   -> AsyncExecutionInterceptor
   -> determineAsyncExecutor
   -> doSubmit
   -> Future result or AsyncUncaughtExceptionHandler
```

这条链可以拆成六层：

- **启用入口**：`@EnableAsync` 导入异步配置
- **处理器注册**：注册 `AsyncAnnotationBeanPostProcessor`
- **代理创建**：初始化后识别 `@Async` 并创建 advisor/proxy
- **调用拦截**：代理拦截外部方法调用
- **执行器提交**：选择 executor 并封装 Callable
- **结果与异常**：按返回类型处理结果，按异常类型选择出口

## 一、`@EnableAsync`：它不是开关变量，而是把异步 BPP 接回容器注册体系

`@EnableAsync` 最重要的事情不是保存一个 enabled 标志，而是通过 `@Import(AsyncConfigurationSelector)` 把异步配置导入定义世界。

默认 proxy 模式会导入 `ProxyAsyncConfiguration`，其中注册 `AsyncAnnotationBeanPostProcessor`。

这说明 `@EnableAsync` 的真正作用是：

- 把异步能力作为一个基础设施 BPP 注册进容器
- 让后续 Bean 创建时，异步方法可以被识别和代理

它并不在注解所在类上直接修改方法，也不在调用时临时扫描整个容器。

而是沿着前面 `refresh()` 的主线：

- Step 5 解析配置并注册定义
- Step 6 注册 BPP
- Step 11 创建 Bean 时由 BPP 参与实例后处理

因此，`@EnableAsync` 的核心不是“打开异步”，而是：

**把异步方法处理器安装进 Bean 生命周期和 AOP 代理体系。**

## 二、`AsyncAnnotationBeanPostProcessor`：异步代理是在初始化后形成的

`AsyncAnnotationBeanPostProcessor` 继承异步 advisor 的处理体系，在 Bean 初始化后检查当前类型是否存在 `@Async` 方法。

如果没有符合条件的方法，Bean 保持原样；如果有，处理器创建 `AsyncAnnotationAdvisor`，其 advice 是 `AnnotationAsyncExecutionInterceptor`，随后通过 `ProxyFactory` 生成代理。

这条路径和上一章 BPP 全景直接接上：

- `postProcessAfterInitialization`
- 判断 Bean 是否适合代理
- 添加 advisor
- 返回代理对象

为什么不是在实例化前就切线程？

因为 `@Async` 需要代理的是一个已经完成依赖填充和初始化的 Bean；异步发生在之后的外部调用阶段，而不是对象创建阶段。

这也和配置类 CGLIB 增强形成对照：

- 配置类增强要拦截类内部 `this.@BeanMethod()` 调用
- `@Async` 主要拦截外部调用者通过代理发起的方法调用

因此，`@Async` 依赖的是 AOP 代理调用边界，而不是配置类式的内部方法重写。

## 三、`AsyncExecutionInterceptor`：一次异步调用至少有三步

当外部调用进入代理后，`AsyncExecutionInterceptor.invoke()` 首先调用 `determineAsyncExecutor(...)` 选择执行器。

执行器选择通常有两条主要路径：

- `@Async("emailExecutor")` 指定限定名称，按 BeanFactory 中的 Executor Bean 查找
- 未指定名称，尝试获取默认 TaskExecutor

如果指定名称找不到或类型不匹配，调用无法正常提交。

如果没有指定名称，Spring 会优先寻找默认执行器；框架层在找不到时可以退回 `SimpleAsyncTaskExecutor`，但这不是 Spring Boot 的线程池自动配置。Boot 的默认生产执行器来自 Boot 自动配置创建的 `ThreadPoolTaskExecutor`。

确定执行器之后，拦截器会把原始方法调用封装成 `Callable`：

- 真正的 `invocation.proceed()` 在异步线程中执行
- 当前调用线程不再同步等待目标方法
- 任务最终通过 `doSubmit(...)` 进入不同返回值分支

因此一次异步调用的核心链是：

```text
选择执行器
   -> 封装原调用
   -> 提交任务
```

## 四、返回值类型改变的是结果观察协议，不是是否异步

`@Async` 方法仍然会异步执行，但返回类型决定调用方如何观察完成和失败。

### `void`

调用方没有 Future 句柄，异步线程里的异常不能回到调用线程，因此走 `AsyncUncaughtExceptionHandler`。

### `Future`

任务通过执行器提交后，调用方拿到 Future，可以通过 `get()` 等方式等待并观察异常。

### `ListenableFuture`

结果可以通过回调监听完成或失败。

### `CompletableFuture`

结果通过 CompletableFuture 链式组合和异常阶段观察。

如果返回类型不在 Spring 支持的这些路径中，`doSubmit(...)` 会抛出 `IllegalArgumentException`。因此，返回类型不是 API 表面选择，而是异步结果协议的一部分。

## 五、异常处理：`void` 异步方法必须有独立的错误出口

异步方法抛异常时，调用线程通常已经返回，因此异常无法像同步调用那样沿当前栈直接抛回。

Spring 会根据返回类型区分：

- Future 类型：异常进入 Future 结果，调用方可以观察
- 非 Future，尤其是 void：交给 `AsyncUncaughtExceptionHandler`

默认处理器主要记录错误日志，应用可以通过 `AsyncConfigurer` 自定义异常处理，例如：

- 告警
- 记录数据库
- 发送消息
- 触发重试

这条边界非常重要：

- `@Async void` 如果没有正确配置异常处理器，失败可能不会被业务调用方感知
- “调用返回成功”只代表任务提交成功，不代表异步业务已经成功完成

## 六、代理边界：为什么同类内部调用通常不会触发 `@Async`

`@Async` 的核心是代理拦截。

因此，外部对象通过代理调用：

```text
controller -> asyncServiceProxy.sendEmail()
```

会进入 `AsyncExecutionInterceptor`。

但同一个类内部直接调用：

```text
this.sendEmail()
```

通常不会经过代理，而是普通 Java 调用，仍然同步执行。

这不是 `@Async` 随机失效，而是 Spring AOP 代理边界的直接结果：

- 代理只能拦截经过代理对象的调用
- `this` 指向目标对象本身，不会重新绕回代理

因此设计异步服务时，必须把异步方法放在可被外部代理调用的边界上，而不能依赖同类内部自调用触发异步。

## 七、这篇为什么必须同时依赖 BPP、AOP 和 TaskExecutor

`@Async` 不是单一机制，它正好把前面三条主线接到了一起：

- BPP：决定什么时候识别并创建异步代理
- AOP：决定外部方法调用如何被拦截
- TaskExecutor：决定异步任务在哪个执行策略中运行

如果缺少其中任何一条：

- 没有 BPP，就不会自动创建代理
- 没有 AOP，就没有稳定的调用拦截边界
- 没有 TaskExecutor，就没有任务提交执行策略

所以 `@Async` 是一个很好的跨域桥接案例：

**注解声明只是入口，真正的异步语义来自 BPP、代理和执行器三条主线的组合。**

## 八、几个最容易错的判断

### 1. `@Async` 注解本身会创建新线程

不成立。

它只是声明信号，真正创建代理和提交任务的是 BPP、拦截器和 TaskExecutor。

### 2. `@EnableAsync` 让所有方法都异步

不成立。

只有被异步 advisor 识别的 `@Async` 方法才会进入代理异步路径。

### 3. 同一个类里 `this.asyncMethod()` 也会异步

通常不成立。

这种调用绕过代理，通常仍是同步执行。

### 4. `@Async void` 抛出的异常会回到调用方

不成立。

void 没有结果句柄，异常需要通过 `AsyncUncaughtExceptionHandler` 处理。

### 5. Spring Framework 默认一定使用线程池

不成立。

Framework 层可退回 `SimpleAsyncTaskExecutor`；Spring Boot 的默认线程池来自 Boot 自动配置，两者不能混为一谈。

## 收网：`@Async` 统一的不是“开一个线程”，而是“注解意图如何经过代理进入可配置的异步执行协议”

现在可以回到开头的问题：为什么 `@Async` 看起来只是一个注解，实际却需要这么长的调用链？

因为它真正要解决的不是“方法怎么换线程”，而是：

- 配置如何注册异步基础设施
- BPP 如何识别并代理 Bean
- 代理如何拦截外部调用
- 执行器如何被选择
- 方法调用如何被封装并提交
- 返回值和异常如何被观察

所以 Spring 的异步主线可以压缩成：

```text
@EnableAsync
   -> AsyncAnnotationBeanPostProcessor
   -> AOP proxy
   -> AsyncExecutionInterceptor
   -> determineAsyncExecutor
   -> doSubmit
   -> Future or AsyncUncaughtExceptionHandler
```

因此，这篇真正该带走的结论不是“Spring 有个 `@Async` 注解”，而是：

**Spring 把异步问题从“某个方法怎么切线程”提升成了“声明式注解如何经过容器 BPP、AOP 代理、执行器选择和结果异常协议，最终变成一条可替换的异步执行主线”。**

这也留下了下一篇最自然的问题：既然 `@Async` 已经把“任务交给谁执行”这条线接起来了，那么 `@Scheduled` 又如何把 cron、fixedDelay、fixedRate 这些时间语义接到 TaskScheduler 和容器生命周期上？

下一篇进入 Spring 的 `@Scheduled` 主线。