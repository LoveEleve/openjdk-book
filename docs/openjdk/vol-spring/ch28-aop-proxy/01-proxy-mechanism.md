# Spring 为什么有时用 JDK Proxy、有时用 CGLIB：`DefaultAopProxyFactory` 的双轨决策与统一调用链

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring AOP 代理机制第一层：`DefaultAopProxyFactory.createAopProxy(...)` 如何在 JDK 动态代理和 CGLIB 子类代理之间做决策，`JdkDynamicAopProxy.invoke(...)` 与 `CglibAopProxy.DynamicAdvisedInterceptor.intercept(...)` 两条入口在拦截后为什么又都汇入同一个 `ReflectiveMethodInvocation` advice 链。Advice 链的具体执行顺序会在下一篇展开。

## 为什么 Spring 的代理有时基于接口、有时基于子类，而调用方却感受不到差别

前面 `@Async`、`@Cacheable`、事务这些主线反复提到同一件事：

- 方法调用会被 AOP 代理拦截

但很多读者会在某一步突然发现一个容易混淆的事实：

- 有些代理是 JDK 动态代理
- 有些代理是 CGLIB 子类代理

如果只从业务代码表面看，调用方通常感觉不到这个差别，因为两者最后都会被透明代理。

但一旦出现：

- 某个类没有接口
- 某个方法不是 public
- 某个类是 final
- Spring Boot 默认配置了 `proxy-target-class=true`

这些差异就会立刻影响实际行为。

第一层问题是：**代理方式不是随便选的，而是由 `DefaultAopProxyFactory` 按一套明确规则决定。**

这些规则至少要考虑：

- 是否强制使用 CGLIB
- 是否开启优化模式
- 目标类有没有用户提供的接口
- 目标类本身是否是接口或代理类

第二层问题是：**JDK Proxy 和 CGLIB 不只是实现不同，它们的拦截能力边界也不同。**

- JDK Proxy 要求目标实现接口
- CGLIB 通过生成子类实现，能代理无接口类，但无法覆写 final 方法

这直接决定了 Spring 行为边界：

- 非 public 方法为什么事务会失效
- final 方法为什么不能被代理
- private 方法为什么完全不会进代理

第三层问题是：**两种代理入口不同，但进入 advice 链之后完全共享同一套执行机制。**

也就是说：

- `JdkDynamicAopProxy.invoke(...)` 是 JDK 入口
- `CglibAopProxy.DynamicAdvisedInterceptor.intercept(...)` 是 CGLIB 入口

但两者最终都构造 `ReflectiveMethodInvocation`，由它推进整个 advice 链。

因此，本文真正要回答的问题不是“什么是 JDK/CGLIB 代理”，而是：

**为什么 Spring 必须同时保留两条代理技术，并通过统一调用链让不同代理产生一致结果，同时又要接受两类代理各自的拦截边界？**

## 先看失败方案：为什么不能只用 JDK Proxy、只用 CGLIB、或者让两种代理各维护一套调用链

### 失败方案一：只用 JDK 动态代理

JDK 代理是 Java 标准库能力，不引入第三方依赖，看起来更轻量。

但如果只用 JDK 代理，它立刻就遇到一个硬限制：

- 只能代理实现接口的目标

对于很多内部类、无接口 Service，会出现一个很尴尬的局面：

- 想让它的方法被增强
- 但它根本没有接口可挂

所以 Spring 不能只用 JDK 代理。

### 失败方案二：只用 CGLIB

CGLIB 能代理无接口类，看起来更强大。

但 CGLIB 也有边界：

- 代理创建时需生成子类字节码，有一定额外开销
- final 方法不可覆写
- 大量使用类代理会放大字节码生成开销

同时它也改变了 Spring 的默认依赖边界。所以 Spring 不能把 CGLIB 作为唯一代理方式，而是把它作为有接口场景之外的补充路径。

### 失败方案三：两种代理各写一套完整调用链，互不共享

如果每种代理都从头实现拦截、advice 执行和 joinpoint 推进，结果会是：

- 同样的 advice 逻辑在两套实现里出现重复
- JDK 和 CGLIB 上的行为容易出现细微差异
- 增加后续维护成本

Spring 选择的做法是：

- 两条入口各自承担“拦截进入”
- 入口之后统一交给 `ReflectiveMethodInvocation.proceed()` 推进

这样尽最大可能保证同一套 advice 在两类代理上行为一致。

## Spring AOP 代理机制的最小总图

```text
ProxyFactory.getProxy()
   -> DefaultAopProxyFactory.createAopProxy(config)
   -> JDK Proxy branch (has interfaces)
   -> CGLIB branch (no interface / forced / optimize)
   -> JdkDynamicAopProxy.invoke  /  CglibAopProxy.DynamicAdvisedInterceptor.intercept
   -> both build ReflectiveMethodInvocation
   -> proceed() advice chain
```

## 一、`DefaultAopProxyFactory.createAopProxy(...)`：一条决策树决定代理实现

`createAopProxy(config)` 是代理技术选择的唯一入口。

决策过程实际是两步，不能压成一层平铺：

第一步，判断是否进入 CGLIB 分支：

- 如果 `isProxyTargetClass()` 或 `isOptimize()` 或没有用户提供的接口，则进入 CGLIB 分支
- 否则走 JDK 代理

第二步，在 CGLIB 分支内，再次判断：

- 如果目标类本身就是接口，或已经是代理类，或属于 lambda 类，则退回 JDK 代理
- 否则使用 CGLIB

这里特别需要区分两个容易混淆的概念：

- `isOptimize()` 语义是“允许 Spring 自主选择被认为最优的方式”，进入 CGLIB 分支是当前实现的一个副作用，不是它的设计意图
- `isProxyTargetClass()` 是强制使用 CGLIB，只有当目标类形态不允许时才退回 JDK

因此两个标记都倾向于 CGLIB，只是强制程度不同。

还要注意 `hasNoUserSuppliedProxyInterfaces` 的判断：它不是简单问“有没有接口”，而是看用户是否真正提供了有意义的代理接口。当代理接口为空、或只有 Spring 内部的 `SpringProxy` 标记接口时，会被判断为“没有用户提供的接口”，从而进入 CGLIB 分支。这表明该条件关心的是“用户意图”，而不是“是否挂了一堆被自动加上的接口”。

如果我们把这一步讲成“有接口就走 JDK”，就会漏掉一个大前提：Spring 内部也会自动添加目前这些标记接口，真正的决策依据是“用户提供的、有实际代理语义的接口集合”。

Spring Boot 默认设置 `spring.aop.proxy-target-class=true`，所以大多数 Spring Boot 应用的 Service 都走 CGLIB 路径。

## 二、JDK 代理分支：`JdkDynamicAopProxy` 如何成为 InvocationHandler

当走到 JDK 分支时，`JdkDynamicAopProxy` 实现 `InvocationHandler`：

- `getProxy()` 通过 `Proxy.newProxyInstance(classLoader, proxiedInterfaces, this)` 创建代理
- 每次方法调用都进入 `invoke(proxy, method, args)`

`invoke()` 内部大体是：

1. 处理 `exposeProxy`：当配置暴露代理时，把当前代理放入 `AopContext` 的 ThreadLocal，这样目标对象内部的 `this.method()` 调用如果显式使用 `AopContext.currentProxy()` 也能回到代理上
2. 获取当前方法的拦截器 / advice 链
3. 链为空时直接反射调用目标方法
4. 链非空时构造 `ReflectiveMethodInvocation` 并 `proceed()`

JDK 代理的优势是：

- 不依赖第三方字节码库
- 更适合有接口的场景

这里补充一个关键边界：`exposeProxy` 不是让“所有内部调用都被拦截”，而是给“目标类内部通过 `AopContext.currentProxy()` 显式转回代理”的方式提供支撑。没有这个机制，`this.method()` 天然指向目标对象本身，根本不会绕回代理。

## 三、CGLIB 分支：`CglibAopProxy.DynamicAdvisedInterceptor` 如何拦截子类调用

当走到 CGLIB 分支时，`CglibAopProxy` 使用 CGLIB Enhancer 生成目标类的子类：

- `setSuperclass(proxySuperClass)` 让子类继承目标类
- 通过回调数组和 `ProxyCallbackFilter` 按方法分发回调
- 核心回调之一是 `DynamicAdvisedInterceptor`，实现 CGLIB 的 `MethodInterceptor`

当子类重写的方法被调用时，进入 `intercept(obj, method, args, proxy)`：

1. 获取 advice 链
2. 链为空时 `AopUtils.invokeJoinpointUsingReflection(target, method, args)` 直接反射调用原始方法
3. 链非空时构造 `ReflectiveMethodInvocation` 并 `proceed()`

这里要注意：

- 空链时选择反射调用原始方法，是为了绕过增强子类字节码，避免空转开销
- 非空链时 `ReflectiveMethodInvocation` 内部同样用反射调用 joinpoint

## 四、为什么两条入口最终会汇入同一个 `ReflectiveMethodInvocation`

不管走 JDK 还是 CGLIB，真正驱动 advice 链执行的，都是同一个对象：

- `ReflectiveMethodInvocation`

它的职责是：

- 保存 proxy、target、method、args、targetClass 和 advice chain
- 通过 `proceed()` 逐个推进 advice
- 链结束或首个无拦截动作时调用真正的方法执行

这样做最大的好处是：

- 一个 `@Transactional` advice 在 JDK 代理和 CGLIB 代理上执行行为完全一致
- 两种代理只是“如何进入调用链”不同，“进入后怎么执行”完全共享

所以 Spring AOP 用统一的 `ReflectiveMethodInvocation` 实现了代理无关的 advice 执行模型。

## 五、为什么 CGLIB 无法代理 final / private / static 方法

CGLIB 通过生成子类来覆写方法，因此受 Java 覆写规则限制：

- final 方法不可覆写
- private 方法不会被子类通过方法分派调用，不会进入拦截
- static 方法属于类本身

因此这些方法调用时不会经过 `DynamicAdvisedInterceptor`。

这也是很多事务失效场景“非 public 方法”的根源：

- 即使配置了 CGLIB 代理
- private / final 方法仍然直接调用目标类版本

但这里不能只把根因归给 CGLIB。更根本的是代理调用边界：Spring AOP 只能拦截“经过代理对象的方法调用”。非 public 方法虽然部分能被子类覆写，但它们的调用入口天然脆弱——要么只被同类内部自调用绕过代理，要么受 final / private 的覆写限制。所以“非 public 方法事务失效”本质是“代理边界 + Java 覆写规则”共同作用的结果，而不是单个技术缺陷。

## 六、为什么 Spring Boot 默认走 CGLIB

`spring.aop.proxy-target-class=true` 让绝大多数 Spring Boot 应用的 Service 走 CGLIB 路径。

CGLIB 的优势在于：

- 不需要目标类强行实现接口
- 更符合现代 Spring 应用的类结构

但代价是：

- 需要生成子类字节码
- final 方法无法代理
- 启动阶段有额外开销

也就是说，CGLIB 更强大，但并不是没有边界。

## 七、几个最容易错的判断

### 1. JDK 代理比 CGLIB 更高级

不成立。

两者只是适用场景不同，JDK 需要接口，CGLIB 通过子类实现，各有边界。

### 2. 有接口时 Spring 一定会走 JDK 代理

不成立。

如果 `proxyTargetClass=true` 或开启 optimize，仍会优先 CGLIB，仅在目标类形态不允许时退回 JDK。

### 3. CGLIB 能代理所有方法

不成立。

final、private、static 方法受覆写规则限制，不会被拦截。

### 4. JDK 和 CGLIB 的调用链完全独立

不成立。

入口不同，但 `ReflectiveMethodInvocation.proceed()` 的 advice 链执行完全共享。

### 5. `isOptimize()` 表示优化成 JDK 代理

不成立。

它的设计意图是“允许 Spring 自主选择被认为最优的代理方式”，进入 CGLIB 分支是当前实现的结果，而不是它的语义目的。

## 收网：Spring 要统一的不是“选一种代理技术”，而是“让不同代理入口共享同一套 advice 执行协议”

现在可以回到开头的问题：为什么 Spring 有时用 JDK Proxy、有时用 CGLIB，调用方却感受不到差别？

因为 Spring 面对的是两类互相补充的代理技术，各自有边界：

- JDK 需要接口，依赖标准库
- CGLIB 生成子类，但无法代理 final 方法

Spring 用 `DefaultAopProxyFactory` 做决策，再让两条入口统一进入 `ReflectiveMethodInvocation`：

```text
DefaultAopProxyFactory
   -> JDK Proxy / CGLIB 分支
   -> JdkDynamicAopProxy.invoke       /  DynamicAdvisedInterceptor.intercept
   -> ReflectiveMethodInvocation
   -> advice chain proceed
```

因此，这篇真正该带走的结论不是“Spring 支持两种代理”，而是：

**Spring 把代理技术选择从“目标类形态问题”提升成了“由工厂决策、并由统一调用链执行”的 AOP 入口协议，同时把两种代理的边界显式暴露给使用者。**

这也留下了下一篇最自然的问题：既然两种代理已经能进入同一条 `ReflectiveMethodInvocation` 调用链，那这条链上的 `Before`、`After`、`Throws`、`Around` advice 到底是按什么顺序、怎样逐个推进的？

下一篇进入 Spring 的 Advice 链执行主线。