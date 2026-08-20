# 为什么 `@AspectJ` 注解类能变成 AOP 拦截链：Spring 如何把 `@Aspect`、`@Before`、`@Around` 解析并注册成 Advisor

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 `@AspectJ` 解析主线：`ReflectiveAspectJAdvisorFactory` 如何把 `@Aspect` 类中的注解方法解析成 `Advisor` 和 `AspectJExpressionPointcut`，`AspectJExpressionPointcut` 又如何编译 pointcut 表达式并对每个 Bean 的每个方法执行匹配，以及 `@Before`、`@Around`、`@After`、`@AfterReturning`、`@AfterThrowing` 最终被包装成哪些 advice 实现进入 proceed 链。自动代理筛选将在下一篇继续展开。

## 为什么 `@Aspect` 类能自动变成拦截器，而不需要手动注册 Advisor

前面两篇已经把 AOP 代理机制和 advice 链执行讲清楚了：

- 代理工厂决定用 JDK 还是 CGLIB
- 代理拦截后进入 `ReflectiveMethodInvocation.proceed()`
- 不同 advice 通过适配器进入同一条链

但至今还有一个问题没回答：**这些 advisor 到底是从哪来的？**

如果再看 `@Async` 或 `@Transactional`，它们各自的 advisor 是通过 `@EnableAsync` 或 `@EnableTransactionManagement` 注册的 BPP 或拦截器产生的。

但 `@AspectJ` 不一样：你只要写一个 `@Aspect` 类，里面再写几个 `@Before`、`@Around` 方法，Spring 就会自动发现、解析并注册成 advisor。

第一层问题是：**`@Aspect` 类首先是一个普通 Bean，但它的 `@Before`、`@Around` 方法不是普通方法，而是需要被翻译成 advisor 的声明源。**

也就是说，Spring 不会把你写的 `@Aspect` 类当成一个普通的 service 或 component 来创建实例，而是会：

- 先把它当作普通 Bean 创建
- 再通过专门的 `ReflectiveAspectJAdvisorFactory` 扫描所有方法
- 对每个带注解的方法，提取 pointcut 表达式并创建 Pointcut 和 Advice 对象
- 最后包装成 Advisor

第二层问题是：**每个 advisor 内部都包含一个 pointcut 表达式，它决定了“哪些 Bean 的哪些方法该被拦截”。**

`@Aspect` 类本身只定义了“拦截逻辑是什么”，而 pointcut 表达式定义了“拦截谁”。这两个东西必须被绑定在一起：

- `AspectJExpressionPointcut` 编译 pointcut 表达式
- 在 `ReflectiveAspectJAdvisorFactory` 中，pointcut 和 advice 方法被包装成 `InstantiationModelAwarePointcutAdvisorImpl`

第三层问题是：**advisor 是按类型共享的，但匹配是按每个 Bean 逐方法执行的。**

所有 `@Aspect` 生成的 advisor 进入一个全局的候选 advisor 列表。每个 Bean 创建时，`AbstractAutoProxyCreator` 遍历这个列表，对每个 advisor 询问：你的 pointcut 是否匹配当前 Bean 的当前方法？匹配才加入该 Bean 的专属 advice 链。

因此，本文真正要回答的问题不是“`@Aspect` 注解怎么用”，而是：

**Spring 如何把 `@Aspect` 类方法解析成 Pointcut + Advice 的 Advisor，再通过 pointcut 逐方法匹配，最终让这些 advisor 进入 AOP 代理链？**

## 先看失败方案：为什么不能把 `@Aspect` 方法直接当拦截器、不对 pointcut 做编译、让所有 Bean 共享同一套 advice

### 失败方案一：`@Aspect` 方法直接当拦截器，每遇到一个方法就反射调用它

这看起来最直接：

- 扫描到 `@Aspect` 类
- 找到 `@Before` 方法
- 每当有方法调用时，先反射调用这个方法

但问题在于，`@Aspect` 方法本身并不知道它应该拦截哪些方法。`@Before("execution(...)")` 里的 pointcut 表达式才是真正的拦截条件。如果只反射调用方法而跳过 pointcut 匹配，就会把所有方法都拦截一遍。

所以 `@Aspect` 方法不能直接当拦截器，必须和 pointcut 一起打包成 advisor。

### 失败方案二：pointcut 表达式不编译，每次匹配时重新解析字符串

如果每次匹配都不编译，直接解析字符串，每次匹配都会产生一次解析开销。

Spring 的选择是：在 `AspectJExpressionPointcut` 创建时，把 pointcut 表达式编译成 AspectJ 的 `PointcutExpression` 对象。后续匹配时直接调用 `PointcutExpression.evaluate(...)`，不再重复解析。

### 失败方案三：所有 `@Aspect` 生成的 advisor 自动对所有 Bean 生效

如果 advisor 不经过 pointcut 匹配，直接对所有 Bean 生效，就会出现拦截范围失控。

因此 Spring 的做法是：advisor 先全局缓存，然后在每个 Bean 创建时，通过 pointcut 逐方法匹配，只把匹配的 advisor 加入该 Bean 的 advice 链。

## `@AspectJ` 解析的最小总图

```text
@Aspect @Component class
   -> BeanFactoryAspectJAdvisorsBuilder.buildAspectJAdvisors
   -> ReflectiveAspectJAdvisorFactory.getAdvisors
   -> 遍历方法: findAspectJAnnotationOnMethod
   -> AspectJExpressionPointcut compile
   -> InstantiationModelAwarePointcutAdvisorImpl
   -> candidateAdvisors 全局缓存
   -> 每个 Bean 创建: pointcut matches method -> 匹配的 advisor 加入链
```

## 一、`ReflectiveAspectJAdvisorFactory.getAdvisors(...)`：从 `@Aspect` 类到 Advisor 列表的转换入口

`getAdvisors(...)` 是 `@AspectJ` 解析的起点。

它大致做以下几件事：

1. 验证当前类确实是 `@Aspect`
2. 遍历 `@Aspect` 类的所有非 @Pointcut 方法
3. 对每个方法，调用 `findAspectJAnnotationOnMethod` 提取注解
4. 通过 `getPointcut(...)` 提取 pointcut 表达式并编译
5. 创建 `InstantiationModelAwarePointcutAdvisorImpl` 打包成 advisor

这个转换过程的关键是：**方法实现 + pointcut 表达式 + 注解类型**三者被绑定在一起。注解类型决定 advice 形态（Before / Around / AfterReturning / AfterThrowing / After），pointcut 表达式决定拦截范围，方法体决定执行逻辑。

这里还要解释一下类名里的 `InstantiationModelAware`：它表示这个 advisor 知道自己对应的 aspect 实例来自哪种实例化模型。aspect 默认是一个单例 Bean，但也可以配置成 per-target、per-this，即每个被代理目标或每个当前对象一份。`InstantiationModelAwarePointcutAdvisorImpl` 把这个模型信息一起保存在 advisor 里，这样它在选择合适的 aspect 实例形态时才有依据，而不是把所有 aspect 都当单例处理。

## 二、几种注解分别被包装成什么 advice 实现

`@AspectJ` 的注解最终被包装成几类 advice 实现，这里先要破除一个理想化印象：不是“五种注解 → 五种对应 advice 类”。其中三类注解最终都以 `MethodInterceptor` 形态进入链，区别只在于各自拦截体内部的逻辑：

| 注解 | 包装成 | 实现接口 |
|------|--------|---------|
| `@Before` | `AspectJMethodBeforeAdvice` | `MethodBeforeAdvice` |
| `@After` | `AspectJAfterAdvice` | `MethodInterceptor`（try/finally） |
| `@AfterReturning` | `AspectJAfterReturningAdvice` | `AfterReturningAdvice` |
| `@AfterThrowing` | `AspectJAfterThrowingAdvice` | `MethodInterceptor`（异常时调用） |
| `@Around` | `AspectJAroundAdvice` | `MethodInterceptor` |

特别注意 `@AfterThrowing`：它实现的是 `MethodInterceptor`，而不是 `AfterReturningAdvice`。异常后置只发生在 catch 分支里，和正常返回链路完全分开。

`@After` 虽然是 finally 语义，但它在 Spring 里同样被实现为 `MethodInterceptor`：try { proceed() } finally { afterLogic() }。所以它和 `@AfterReturning`、`@AfterThrowing` 不是同一层。

`@Around` 直接作为 `MethodInterceptor` 进入链，它包裹整个 proceed。

这样，`@AspectJ` 的全部注解最终都进入上一篇建立的 `ReflectiveMethodInvocation.proceed()` 链，只是不同注解在链上的形态（MethodInterceptor、MethodBeforeAdvice、AfterReturningAdvice）和行为不同。

## 三、`AspectJExpressionPointcut`：pointcut 表达式编译与匹配

`AspectJExpressionPointcut` 是 pointcut 语义的核心。

在 advisor 创建时，它做两件事：

1. 编译：`setExpression(expression)` 调用 AspectJ 的 `PointcutParser.parsePointcutExpression(...)`，将字符串表达式编译成 `PointcutExpression` 对象
2. 匹配：`matches(Method, Class)` 通过 `PointcutExpression.evaluate(...)` 判断当前方法是否匹配

匹配发生在每个 Bean 的创建过程中，而不是在 advisor 创建时一次性算完。

而且匹配不是单层的。`Pointcut` 本质上是“类过滤器 + 方法匹配器”的组合：先走类级粗筛 `matches(Class)`（或 `getClassFilter().matches(...)`），判断这个类整体是否值得进入候选；类级通过后，才逐方法调用 `getMethodMatcher().matches(method, targetClass)` 精匹配。这样大部分不匹配的类在第一步就被过滤掉，不必对每个方法都做表达式求值。

这就是为什么 `AspectJExpressionPointcut` 不能只是字符串等于判断，而必须用 AspectJ 的表达式编译器。

## 四、`@Aspect` 生成的 advisor 是全局共享的，但匹配是 per-Bean 的

`@AspectJ` 的 advisor 不是为每个 Bean 单独创建的，而是对所有 @Aspect 类解析一次，生成 `candidateAdvisors` 列表，全局缓存。

缓存的实际位置在 `BeanFactoryAspectJAdvisorsBuilder` 中，它按 aspect bean 名称缓存已构建的 advisor 列表，避免重复解析。`AnnotationAwareAspectJAutoProxyCreator` 在 `findCandidateAdvisors()` 中调用这个 builder 来获取缓存中或新解析的 advisor 集合。

每个 Bean 创建时，`AbstractAutoProxyCreator` 调用 `findEligibleAdvisors(beanClass, beanName)`：

- 遍历所有 candidate advisors
- 对每个 advisor 的 pointcut 调用 `matches(method, targetClass)`
- 匹配的 advisor 加入当前 Bean 的专属 advice 链
- 不匹配的 advisor 跳过

这样，同一个 `@Aspect` 的 `@Before` 方法，可能对某些 Bean 生效，对其他 Bean 不生效，完全由 pointcut 表达式决定。

## 五、`@Before` 和 `@Around` 的具体形态差异

`@Before` 被包装成 `AspectJMethodBeforeAdvice`，实现 `MethodBeforeAdvice`。在 proceed 链中，它先执行 before 逻辑，再调用 `proceed()` 继续。

`@Around` 被包装成 `AspectJAroundAdvice`，实现 `MethodInterceptor`。它直接包裹整个 proceed，在 proceed 前后都可以执行代码。

所以：

- `@Before` 不进 around 层，只在前置阶段执行
- `@Around` 包裹整个 proceed，属于 around 层

两者的 advisor 形态相同，但 advice 实现不同，进入 proceed 链后的行为也不同。

## 六、`@After` 为什么是 MethodInterceptor 而不是 AfterReturningAdvice

`@After` 的语义是 finally——无论方法正常返回还是抛异常，after 逻辑都要执行。

如果把它包装成 `AfterReturningAdvice`，它只能在正常返回时执行，无法在异常时介入。

所以 Spring 把 `@After` 实现为 `AspectJAfterAdvice`，这是一个 `MethodInterceptor`：

```java
try { invocation.proceed(); }
finally { afterLogic(); }
```

这样它就能同时覆盖正常返回和异常两种情况。

这也解释了为什么 `@AspectJ` 的几种注解不能简单对应上一篇的四类适配器。`@After` 虽然名字像“后置”，但它走的是 around 链路，不是 afterReturning 链路。

## 七、几个最容易错的判断

### 1. `@Aspect` 类本身就是一个运行时拦截器

不成立。

它只是一个声明源，`ReflectiveAspectJAdvisorFactory` 负责解析它并生成 Advisor，实际拦截由 Advisor 中的 advice 和 pointcut 完成。

### 2. `@AspectJ` 的 pointcut 表达式在每次匹配时重新解析

不成立。

表达式在 `AspectJExpressionPointcut` 创建时编译一次，后续匹配使用编译后的 `PointcutExpression`。

### 3. 所有 `@Aspect` 生成的 advisor 对每个 Bean 都生效

不成立。

advisor 是全局共享的，但匹配是按每个 Bean 每个方法逐次执行的，只有匹配的 advisor 才进入该 Bean 的 advice 链。

### 4. `@After` 和 `@AfterReturning` 是同一层语义，只是触发条件不同

不成立。

`@After` 是 finally 语义，走 `MethodInterceptor`（around 式）；`@AfterReturning` 走 `AfterReturningAdvice`，只在正常返回时执行。

### 5. `@Around` 和 `@Before` 的 advisor 形态不同

不成立。

两者都是 `InstantiationModelAwarePointcutAdvisorImpl`，差异在于内部的 advice 实现不同，从而在 proceed 链上的行为不同。

## 收网：`@AspectJ` 统一的不是“注解怎样拦截方法”，而是“注解类如何被解析成 Pointcut + Advice 的 Advisor，再通过逐方法匹配进入 AOP 代理链”

现在可以回到开头的问题：为什么 `@Aspect` 类能自动变成拦截器？

因为 Spring 用了：

- `ReflectiveAspectJAdvisorFactory` 解析注解方法
- `AspectJExpressionPointcut` 编译 pointcut 表达式
- `InstantiationModelAwarePointcutAdvisorImpl` 打包成 advisor
- 全局缓存 advisor，每个 Bean 创建时逐方法匹配

因此，这篇真正该带走的结论是：

**Spring 把 `@AspectJ` 问题从“几个注解怎么拦截方法”提升成了“注解类如何被解析成 Pointcut + Advice 的 Advisor，再通过全局缓存和逐方法匹配进入 AOP 代理链”的完整解析流水线。**

这也留下了下一篇最自然的问题：既然 `@AspectJ` 的 advisor 已经被注册到全局候选列表，那 `AbstractAutoProxyCreator` 在 Bean 创建时到底是怎么筛选出哪些 advisor 该进当前 Bean 的链，哪些不该进，以及如何控制代理创建冒泡的？

下一篇进入 Spring 的 `AbstractAutoProxyCreator` 自动代理主线。