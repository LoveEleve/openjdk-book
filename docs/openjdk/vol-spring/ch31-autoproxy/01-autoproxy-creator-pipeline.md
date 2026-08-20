# 谁来决定“这个 Bean 需要被代理”：`AbstractAutoProxyCreator` 的自动代理模板与三种匹配策略

> 本文基于 Spring Framework 6.x 当前源码。本文只讲 Spring AOP 自动代理主线：`AbstractAutoProxyCreator.wrapIfNecessary(...)` 如何在 Bean 生命周期中决定一个 Bean 是否需要被代理，`getAdvicesAndAdvisorsForBean(...)` 这个模板方法如何被子类用不同策略覆写，以及 `BeanNameAutoProxyCreator`、`DefaultAdvisorAutoProxyCreator`、`AspectJAwareAdvisorAutoProxyCreator` 三种实现分别用哪种匹配规则来决定哪些 advisor 进入当前 Bean 的代理链。Pointcut 表达式语法将在后续专题展开。

## 为什么有些 Bean 会自动被代理，有些不会，而开发者并没有在每个 Bean 上写“请代理我”

前面几篇已经把 AOP 的各个零件讲清楚了：

- 代理工厂决定用 JDK 还是 CGLIB
- 代理拦截后进入 `ReflectiveMethodInvocation.proceed()`
- `@AspectJ` 注解类被解析成 Advisor，pointcut 表达式被编译

但这里还有一个更根本的问题没有回答：**谁来决定当前这个 Bean 到底需不需要被代理？**

`@Async` 的 Bean 需要代理，`@Transactional` 的 Bean 需要代理，`@AspectJ` 匹配的 Bean 需要代理。但并不是所有 Bean 都满足这些条件。

如果每个 Bean 都默认被代理，容器启动效率和内存占用会迅速失控。所以必须有一个机制，在 Bean 创建完成后，决定“这个 Bean 是否要进入代理世界”。

第一层问题是：**代理决策的默认入口是 `postProcessAfterInitialization`，而不是 `postProcessBeforeInstantiation`。**

之所以不是实例化前，是因为默认路径下代理需要目标对象已经完成初始化和依赖注入；代理要包裹的是一个已经具备完整能力的 Bean，而不是一个刚出生的壳子。所以普通 AOP 代理的入口是初始化后。

但 `postProcessBeforeInstantiation` 在一种特殊场景下也会创建代理：当存在自定义 `TargetSource` 时，它会提前创建代理。这个路径不是默认路径，但必须是整个自动代理骨架的一部分，不能忽略。

第二层问题是：**不是所有自动代理子类都用同一套匹配规则。**

`AbstractAutoProxyCreator` 是一个模板方法，真正决定“哪些 advisor 该进当前 Bean 的链”的逻辑，由子类在 `getAdvicesAndAdvisorsForBean(...)` 中实现。不同的子类用不同的策略：

- `BeanNameAutoProxyCreator` 按 Bean 名称通配符匹配，不需要 pointcut
- `DefaultAdvisorAutoProxyCreator` 遍历所有 Advisor，用 pointcut 匹配
- `AspectJAwareAdvisorAutoProxyCreator` 在 Default 基础上增加 @Aspect 排序和切面自身跳过

第三层问题是：**`wrapIfNecessary` 有三个调用入口，分布在 Bean 生命周期的不同阶段。**

最常用的入口是 `postProcessAfterInitialization`，但循环依赖场景下，`getEarlyBeanReference` 也会提前触发代理创建。如果 `postProcessBeforeInstantiation` 阶段有自定义 `TargetSource`，也会在那里创建代理。三个入口确保：无论 Bean 在哪个阶段被引用，返回的都是代理而非原始对象。

因此，本文真正要回答的问题不是“自动代理怎么配置”，而是：

**Spring 如何用 `AbstractAutoProxyCreator.wrapIfNecessary` 这个模板方法，在 Bean 生命周期中统一决策“是否需要代理”，并通过子类覆写 `getAdvicesAndAdvisorsForBean` 来支持三种不同的匹配策略？**

## 先看失败方案：为什么不能所有 Bean 都默认代理、在 Bean 实例化前就决定要不要代理、让匹配策略写死在框架里

### 失败方案一：所有 Bean 都默认创建代理

如果每个 Bean 都默认被代理，确实不需要决策逻辑了。但代价是：

- 不需要 AOP 的 Bean 也会被代理，造成大量不必要的代理对象和字节码生成
- 启动时间和内存占用都会显著上升

所以 Spring 必须有一个明确的决策入口，只在需要代理时才创建代理。

### 失败方案二：在 Bean 实例化前就决定是否要代理

代理决策如果放在实例化前，目标对象还没有完成依赖注入和初始化，代理包裹的是一个不完整的 Bean。更关键的是，当时还不知道哪些 advisor 和 pointcut 会匹配这个 Bean。

所以自动代理的决策必须放在初始化后，`postProcessAfterInitialization` 是最自然的入口。

### 失败方案三：匹配策略写死在框架里，不支持子类覆写

如果匹配策略固定，就无法同时支持 `@AspectJ`、`@Async`、`@Transactional` 这些不同来源的 advisor 的匹配需求。

Spring 的做法是：`wrapIfNecessary` 作为模板方法固定骨架，`getAdvicesAndAdvisorsForBean` 作为可覆写的策略方法，让不同子类决定如何收集匹配的 advisor。

## 自动代理的最小总图

```text
Bean initialized
   -> postProcessAfterInitialization
   -> wrapIfNecessary(bean, beanName)
   -> isInfrastructureClass? skip
   -> shouldSkip? skip
   -> getAdvicesAndAdvisorsForBean
   -> empty? return bean
   -> non-empty? createProxy
   -> proxy returned
```

## 一、`AbstractAutoProxyCreator.wrapIfNecessary(...)`：自动代理的模板方法

`wrapIfNecessary` 是自动代理的核心决策入口。它大致做这几件事：

1. 检查是否是基础设施类，是则跳过，不代理
2. 检查 `shouldSkip`，是则跳过
3. 调用 `getAdvicesAndAdvisorsForBean(...)`（子类覆写），获取当前 Bean 适用的 advisor
4. 如果返回空，则标记当前 Bean 不需要代理，直接返回原始 Bean
5. 如果返回非空，创建代理，返回代理对象

这个模板方法固定了“哪些步骤先执行、哪些步骤后执行”，而“如何获取 advisor”留给子类自由实现。这也是 `@Async`、`@Transactional`、`@AspectJ` 这些不同 AOP 能力能够共享同一条自动代理骨架的原因。

## 二、`shouldSkip`：为什么 `@Aspect` 类自己不需要被代理

`shouldSkip` 的默认实现返回 false。但 `AspectJAwareAdvisorAutoProxyCreator` 覆写了它，让 `@Aspect` 类自身不被代理。

因为 `@Aspect` 类是一个声明源，不是被拦截的目标。如果它也被代理，就会造成不必要的 AOP 包装。

## 三、`getAdvicesAndAdvisorsForBean(...)`：三种子类实现三种匹配策略

`AbstractAutoProxyCreator` 把这个方法留给子类覆写，不同的子类实现决定了不同的匹配方式。匹配会分两级进行：`getAdvicesAndAdvisorsForBean` 阶段主要做类级粗筛，方法级精匹配则发生在后续构建 proxy advice 链时。

### `BeanNameAutoProxyCreator`

按 Bean 名称通配符匹配，不涉及 pointcut。它通常用于旧版 XML 配置，或者已知名称的 Bean 逐一指定。

它不需要 pointcut，因为匹配规则就是“名字是否匹配给定的模式”。

### `DefaultAdvisorAutoProxyCreator`

遍历容器中所有 Advisor，先通过 pointcut 的类级粗筛（`getClassFilter().matches(targetClass)`）判断当前 Bean 整体是否可能匹配；类级通过后，在后续构建代理 advice 链时再逐方法精匹配（`getMethodMatcher().matches(method, targetClass)`）。这是最通用的实现，`@Transactional` 的 advisor 就是通过这种方式匹配的。

### `AspectJAwareAdvisorAutoProxyCreator`

在 `DefaultAdvisorAutoProxyCreator` 的基础上，增加 `@Aspect` Advisor 的排序和 `@Aspect` 类自身跳过。

排序按 `DeclarationOrder` 进行，确保 `@Aspect` 类中的 advice 按声明顺序进入链。

更重要的是，现代注解驱动应用实际注册的是它的子类：`AnnotationAwareAspectJAutoProxyCreator`。`@EnableAspectJAutoProxy` 默认注册的就是这个实例，它继承了 `AspectJAwareAdvisorAutoProxyCreator` 的 `@Aspect` 支持，因此 Spring Boot 里真正负责 `@AspectJ` 自动代理的，是这个子类而不是父类本身。

## 四、`isInfrastructureClass`：基础设施类为什么不需要被代理

`isInfrastructureClass` 检查当前 Bean 的类型是否是 AOP 基础设施的一部分（如 `Advisor`、`Advice`、`Pointcut`、`AopInfrastructureBean` 等）。如果判断为是，`wrapIfNecessary` 直接返回原始 Bean，不创建代理。

这样做的原因是：基础设施类本身是 AOP 系统的组成部分，而不是被 AOP 增强的目标。如果它们也被代理，会造成无限循环或非预期的增强。

## 五、`wrapIfNecessary` 的三个调用入口

`wrapIfNecessary` 在三个地方被调用，对应 Bean 生命周期的三个阶段：

1. `postProcessBeforeInstantiation`：只有在有自定义 `TargetSource` 时才会创建代理，通常不触发
2. `postProcessAfterInitialization`：最常用的入口，Bean 初始化完成后调用，决定是否要包装成代理
3. `getEarlyBeanReference`：循环依赖场景下，提前暴露代理而非原始对象，并把原始 Bean 记录到早期引用集合，避免初始化后重复包装

三个入口确保：只要当前 Bean 被判定需要代理，无论它在哪个阶段被引用，返回的都是代理而非原始对象。

## 六、为什么 `createProxy` 不在这里详细展开

`createProxy(...)` 会创建 `ProxyFactory`，设置目标对象和拦截器，然后调用 `getProxy(...)`，最终进入 `DefaultAopProxyFactory.createAopProxy(...)` 的决策过程。这部分已在上一篇代理机制中详细讲过，这里不再重复。

## 七、几个最容易错的判断

### 1. 所有 Bean 在初始化后都会自动被代理

不成立。

只有被 `getAdvicesAndAdvisorsForBean` 返回非空 advisor 列表的 Bean 才会被代理，否则原始 Bean 保持原样。

### 2. 匹配策略只发生在 `@AspectJ` 层面

不成立。

`AbstractAutoProxyCreator` 是一个模板方法，不同的子类通过 `getAdvicesAndAdvisorsForBean` 实现不同的匹配策略。

### 3. `@Aspect` 类本身也会被代理

不成立。

`shouldSkip` 会让 `@Aspect` 类自身跳过代理。

### 4. 代理决策只能在初始化后入口发生

不完整。

循环依赖时 `getEarlyBeanReference` 也会触发代理创建，三个入口覆盖了 Bean 生命周期的不同阶段。

### 5. `AbstractAutoProxyCreator` 只有一个子类

不成立。

它有多个子类，包括 `BeanNameAutoProxyCreator`、`DefaultAdvisorAutoProxyCreator`、`AspectJAwareAdvisorAutoProxyCreator`，各自实现不同的匹配策略。

## 收网：`AbstractAutoProxyCreator` 统一的不是“怎么创建代理”，而是“在 Bean 生命周期的哪个阶段、按什么规则，决定是否需要创建代理”

现在可以回到开头的问题：为什么有些 Bean 会自动被代理，有些不会？

因为 Spring 在 `AbstractAutoProxyCreator.wrapIfNecessary` 中建立了统一的决策模板：

- 基础设施类跳过
- `@Aspect` 类自身跳过
- 子类通过 `getAdvicesAndAdvisorsForBean` 决定哪些 advisor 匹配当前 Bean
- 匹配结果为空时返回原始 Bean，非空时创建代理

因此，这篇真正该带走的结论是：

**Spring 把自动代理问题从“给哪些 Bean 创建代理”提升成了“以 `wrapIfNecessary` 为模板方法，让不同子类按不同策略匹配 advisor，统一在 Bean 生命周期后阶段创建代理”的容器级决策协议。**

这也留下了下一篇最自然的问题：既然自动代理骨架已经立住了，那 pointcut 表达式本身——`execution`、`within`、`this`、`target`、`args`、`@annotation`——在 AspectJ 的 `PointcutParser` 中到底是怎么被编译、求值并参与匹配的？

下一篇进入 Spring 的 Pointcut 表达式主线。