# `proceed()` 到底是怎么让 advice 逐个执行的：Spring AOP 委托式责任链与四类 advice 的越界推进

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring AOP advice 链执行主线：`ReflectiveMethodInvocation.proceed()` 为什么是委托式责任链而非简单循环，`MethodBeforeAdvice`、`AfterReturningAdvice`、`ThrowsAdvice` 又是如何被适配成 `MethodInterceptor` 进入同一条链，以及 around / before / afterReturning / throws 的推进顺序到底由什么决定。链尾 `invokeJoinpoint()` 是终止符，不属于 advice。

## 为什么 `proceed()` 一调用，后面五个 advice 就能按顺序逐个执行

前面 AOP 代理篇留下了一个很自然的悬念：

- `JdkDynamicAopProxy.invoke(...)` 最后调用 `invocation.proceed()`
- CGLIB 的 `DynamicAdvisedInterceptor.intercept(...)` 最后也调用 `invocation.proceed()`

那么 `proceed()` 到底做了什么？

如果只看名字，很多读者会猜想：

- 大概是循环遍历 advice 列表
- 一个个调用过去

这个直觉一半对，但另一半恰恰是这篇最关键的认知分界线。

因为 Spring AOP 的 `proceed()` 不是循环，而是委托式责任链：每个 advice 都拿到“剩余链”的引用（也就是 invocation），自己决定接着往下传，还是在这里停住。递归只是把这个委托模型在 Java 调用栈上实现出来的形态，真正让“前后两个阶段”成立的是委托，不是递归本身。

第一层问题是：**普通的线性调用只能在方法执行前插一段逻辑，无法在方法返回后继续做事；委托式责任链则让每个 advice 同时拥有“调用前”和“调用后”两个阶段。**

假设 advice 链上有三个拦截器，如果只是 for 循环顺序调用，每个 advice 只能在方法执行前插一段逻辑，无法在方法返回后继续做事。

而 `@Transactional`、`@Around` 这类 advices 恰恰需要在：

- 目标方法执行前做前置处理
- 目标方法执行完做提交或后置处理

要做到这一点，就必须让每个 advice 在“继续往下传”之前和之后都能拿到控制权；委托式 proceed 正是这种控制权的传递方式。

第二层问题是：**`proceed()` 的推进不是自动的，它依赖每个 advice 主动调用一次 `invocation.proceed()`。**

也就是说，链的推进并非链式注册器自己从前往后跑，而是：

- 调用方进入第一个 advice
- advice 执行前置逻辑
- advice 调用 `proceed()`
- 进入第二个 advice
- 第二 advice 再调用 `proceed()`
- 直到最后一个 advice 也调用 `proceed()`
- 此时才真正调用目标方法

如果某个 advice 不调用 `proceed()`，链就会停在这里，后面的 advice 和目标方法都不会执行。

这正是 `@Cacheable` 命中缓存时的行为：它不调用 `proceed()`，直接把缓存结果返回。

第三层问题是：**Before / AfterReturning / Throws 并不是链上独立接口，而是被适配成 `MethodInterceptor` 后进入同一条链。**

这意味着：

- `MethodInterceptor` 是链上的通用入口
- `MethodBeforeAdvice`、`AfterReturningAdvice`、`ThrowsAdvice` 通过各自的适配器包装成 `MethodInterceptor`
- 最终统一走 `interceptor.invoke(this)`

因此，advice 先后顺序并不是“几类接口的抽象层次顺序”，而是它们在 proceed 委托展开时被调用的实际执行顺序。

需要先厘清一个名词边界：Spring 里通常说“五类 advice”，指的是 `@AspectJ` 的 `@Before` / `@After` / `@AfterReturning` / `@AfterThrowing` / `@Around`。而本篇讨论的程序式链上，实际进入的 advice 类型是四类（Around / Before / AfterReturning / Throws），链尾的 `invokeJoinpoint()` 是终止符，不属于 advice。`@After`（final）这类 finally 语义会在第三十五篇 `@AspectJ` 解析里再展开；这里先说清它和本篇四种适配器的区别。

因此，本文真正要回答的问题不是“四类 advice 的顺序表是什么”，而是：

**为什么 Spring AOP 必须用委托式 proceed 让 advice 链可推进、可短路，并让各 advice 统一适配成 MethodInterceptor 才能保持一致的执行语义？**

## 先看失败方案：为什么不能只用循环、自动推进、让五种 advice 各走各的调用方式

### 失败方案一：用 for 循环顺序遍历 advice 并调用

这看起来最直接：

- 拿到 advice 数组
- 从第一个到最后一个循环调用
- 每个 advice 处理自己的逻辑

但问题在于，循环调用无法表达“方法执行完成之后”的后置阶段。

`AfterReturningAdvice` 必须在目标方法返回后才执行，`Around` advice 也要在方法返回后继续做清理或提交。循环从第一个走到最后一个，最后把目标方法调用一次，之后就结束了，无法再回到前面的 advice 做后置处理。

因此循环无法满足环绕型 advice 的双阶段执行需求。

### 失败方案二：链自动从前往后推进，每个 advice 不用主动调 proceed

如果每个 advice 都只是“注册到链上，由链自动顺序调用”，那么“短路”语义就没法表达。

`@Cacheable` 命中缓存时，链需要在缓存逻辑结束后不再调用后面的 advice，也不再调用目标方法。这就要求每个 advice 自己决定是否继续传下去，而不是统一从前往后自动推进。

所以 `proceed()` 必须由 advice 主动调用，才能把链的控制权交给每个 advice 自己。

### 失败方案三：Before、Around、AfterReturning、Throws 各自实现独立的调用方式

如果每种 advice 都用自己的接口和调用规则，链上就会出现多种调用模式，增加框架复杂度。

Spring 统一的做法是：

- 只有 `MethodInterceptor.invoke(this)` 是链上的统一入口
- Before / AfterReturning / Throws 通过适配器包装成 `MethodInterceptor`
- 最终都在 `proceed()` 委托里按同一套规则执行

这里还要补一个容易忽略的事实：链上的每个元素不一定是裸 `MethodInterceptor`。当 pointcut 是动态匹配时的，链元素是 `InterceptorAndDynamicMethodMatcher` 这样的“拦截器 + 本次匹配结果”组合。`proceed()` 取到这种组合后，会先判断本次匹配是否通过；不通过时直接 `proceed()` 跳过该元素，而不是进入它的 advice。所以“链上都是 MethodInterceptor”只能描述静态 pointcut 的情况，动态匹配下链元素是多一层的。

## Advice 链执行的最小总图

```text
invocation.proceed()
   -> currentInterceptorIndex++
   -> interceptor.invoke(this)
   -> advice does pre-logic
   -> advice calls invocation.proceed() (or short-circuits)
   -> ... until chain end
   -> invokeJoinpoint() -> method.invoke(target, args)
   -> unwind: post logic / afterReturning / throws
```

## 一、`ReflectiveMethodInvocation.proceed()`：递归而非循环，才是责任链的核心

`proceed()` 用 `currentInterceptorIndex` 作为推进指针：

- 初始为 -1
- 每次 `proceed()` 调用时，index 先加 1
- 如果 index 已指向最后一项，说明链已到末尾，直接调用目标方法

关键在于：

- `++currentInterceptorIndex` 取出当前 advice
- 调用 `interceptor.invoke(this)`
- advice 内部如果要继续链，就再调用一次 `invocation.proceed()`

当最后一个 advice 也调用了 `proceed()`，此时 `currentInterceptorIndex` 已到达链尾，于是执行 `invokeJoinpoint()`，真正调用目标方法。

如果在某个 advice 内部遇到符合短路条件的情况，它不再调用 `proceed()`，链就在这里停住，直接返回结果。

## 二、为什么递归能同时支持“前置阶段”和“后置阶段”

用递归的根本原因，在于每个 advice 在递归展开时天然拥有两个环绕窗口：

- 调用 `proceed()` 之前：可以做前置逻辑
- 调用 `proceed()` 之后、方法返回时：可以做后置逻辑

对 `TransactionInterceptor` 来说：

- proceed 前：开启事务
- proceed 后：提交事务
- 异常时：回滚事务

如果只有循环，advice 只能在前置阶段得以执行，后置阶段无从表达。

因此递归是让 around 类 advice 同时拥有前后窗口的唯一自然实现。

## 三、`currentInterceptorIndex` 推进：链如何记录“当前处理到哪”

推进指针的关键在于：

- `proceed()` 每次先 `++currentInterceptorIndex`
- 取出当前 advice
- 当前 advice 通过 `invoke(this)` 收到 invocation
- advice 再调 `proceed()` 时，index 继续增加

所以这个委托天然是嵌套展开的，advice 之间通过 invocation 延续上下文和顺序。

当 index 到达链尾时，`proceed()` 直接调用 `invokeJoinpoint()`，不再继续取 advice。

这里还有一个必须点出的边界：`currentInterceptorIndex` 是当前 invocation 实例上的可变状态。这意味着同一个 `ReflectiveMethodInvocation` 实例在一次递归内推进，不能被多个线程同时 proceed。一旦链要被并行处理，就需要每个线程持有各自独立的 invocation 实例。普通 Spring AOP 每次方法调用都新建 invocation，所以这个约束通常不会暴露，但它决定了链上的状态不能跨线程共享。

## 四、为什么链尾的 `invokeJoinpoint()` 是“终止符”

`invokeJoinpoint()` 是链的终点：

- 调用 `AopUtils.invokeJoinpointUsingReflection(target, method, arguments)`
- 真正执行目标方法
- 得到返回值，逐层回溯

严谨地说，链上的每个 interceptor 都调用 `proceed()`，最终都会走到 `invokeJoinpoint()`。

所以 `invokeJoinpoint()` 不是链上的一个 advice，而是递归展开到最深处时的真实调用点。

## 五、程序式四类 advice 如何进入同一条链

Spring 把程序式 advice 统一适配成 `MethodInterceptor` 后进入链：

### MethodInterceptor（Around）

- 直接就是链上的 `MethodInterceptor`
- 自己决定前置、后置和是否调用 `proceed()`

### MethodBeforeAdvice

通过 `MethodBeforeAdviceInterceptor` 包装：

```text
invoke -> advice.before(...) -> mi.proceed()
```

所以它先做 before 逻辑，再继续链。

### AfterReturningAdvice

通过 `AfterReturningAdviceInterceptor` 包装：

```text
invoke -> mi.proceed() -> afterReturning(retVal, ...)
```

所以它先继续链，目标方法返回成功后才执行 afterReturning。

### ThrowsAdvice

通过 `ThrowsAdviceInterceptor` 包装：

```text
invoke -> try { mi.proceed() } catch (Throwable) { afterThrowing(...) }
```

所以它只有目标方法抛异常时才介入。

这些适配器让不同 advice 类型都能统一按 `interceptor.invoke(this)` 的方式进入同一个 proceed 递归，而不用为每种类型各自开辟一条调用链。

## 六、为什么“执行顺序表”不是几类接口的抽象层次，而是委托展开时的调用时刻

很多人第一次看到 advice 顺序表，容易误以为这是某种接口优先级的体现。

真实语义并不是这样。

因为链上只有统一入口 `MethodInterceptor.invoke(this)`，Before / AfterReturning / Throws 都已经变成了这个入口里的某个适配器。它们的先后：

- 由它们在 advice 链里的顺序决定
- 更准确地说，由 `proceed()` 委托展开时，各自在什么时候调用 `proceed()` 决定

比如：

- `MethodBeforeAdviceInterceptor` 先做 before，再 proceed
- `AfterReturningAdviceInterceptor` 先 proceed，再在返回后做 afterReturning

所以执行顺序不是抽象层级的排序，而是每个适配器在委托线上的相对位置。

## 七、一个 advice 不调 proceed 会发生什么

这是最容易踩的坑，也是最能说明 proceed 语义的例子。

如果某个 advice 在某种条件下不调用 `proceed()`：

- 后面的 advice 不会执行
- 目标方法不会执行
- invocation 直接返回该 advice 的结果

典型例子：

- `@Cacheable` 命中缓存时，不调用 `proceed()`，直接返回缓存结果
- 这样后续所有 advice 和目标方法都被跳过

这就是 proceed 递归的“短路”能力。

因此，链的推进不是一个自动遍历，而是每一个 advice 都在决定“是否继续”。

## 八、几个最容易错的判断

### 1. proceed() 就是用循环把 advice 都调一遍

不成立。

它是委托式责任链推进，让每个 advice 同时拥有前置和后置两个阶段。

### 2. 链会自动从前往后推进，不用 advice 主动调 proceed

不成立。

advice 必须主动调用 `invocation.proceed()`，否则链会在该处停住。

### 3. Before、AfterReturning、Throws 是链上的独立接口

不成立。

它们通过各自适配器包装成 `MethodInterceptor`，统一进入同一条链。

### 4. advice 顺序是接口抽象层次的先后

不成立。

真实顺序是它们在 proceed 委托展开时调用 proceed 的相对位置。

### 5. `invokeJoinpoint()` 是链上的最后一个 advice

不成立。

它是委托最深处真正调用目标方法的终止符，不属于 advice；`@AspectJ` 里常见的“五类 advice”是另一套注解语义，不能与本篇程序式四类适配器混为一谈。

## 收网：Spring 要统一的不是“几类 advice 的接口层级”，而是“委托式 proceed 下的统一责任链执行语义”

现在可以回到开头的问题：为什么 `proceed()` 一调用，四类 advice 加上链尾终止符就能按顺序执行？

因为 Spring AOP 用了：

- 委托式 `ReflectiveMethodInvocation.proceed()`
- 统一的 `MethodInterceptor` 入口
- 把 Before / AfterReturning / Throws 适配成相同的拦截器

这条链上每个 advice 都有前后两个阶段，也都有短路权。因此 advice 的执行顺序，本质上是由每个 advice 在委托线上“何时调用 proceed()”决定的。

因此，这篇真正该带走的结论不是“背一张顺序表”，而是：

**Spring 把 advice 执行问题从“先调谁后调谁”提升成了“委托式 proceed 让每个 advice 都能前置、后置、短路、抛异常的完整责任链语义”。**

这也就解释了 `@Transactional` 为什么在 proceed 前开事务、proceed 后提交、异常时回滚，也解释了 `@Cacheable` 为什么命中缓存时能直接短路整条链。

这也留下了下一篇最自然的问题：既然 advice 链已经能由 `MethodInterceptor` 统一推进，那 `@AspectJ` 里的 `@Before`、`@After`、`@Around`、`@AfterThrowing` 又是怎样被解析、转换并注册成 advisor，最终进入这条链的？

下一篇进入 Spring 的 `@AspectJ` 解析主线。