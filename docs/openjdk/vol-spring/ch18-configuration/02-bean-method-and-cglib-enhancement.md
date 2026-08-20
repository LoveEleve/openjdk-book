# 为什么 `@Bean` 方法彼此调用不会不断 new 新对象：Spring 如何用方法级定义与 CGLIB 增强守住配置类单例语义

> 本文基于 Spring Framework 6.x 当前源码。本文只讲配置类处理主线里的第三层展开：为什么 `@Bean` 方法不能被当成普通 Java 方法直接看待，为什么 `ConfigurationClassBeanDefinitionReader` 必须先把它们注册成方法级 BeanDefinition，为什么 `@Configuration(proxyBeanMethods=true)` 又必须再引入 `ConfigurationClassEnhancer` 和 `BeanMethodInterceptor`，才能守住“配置类内部方法调用仍返回同一个容器 Bean”的语义。事件机制、`ImportAware` 和 FactoryBean 纵深会在后续篇章继续展开。

## 为什么 `@Bean` 看起来只是一个方法，Spring 却要把它拆成定义注册 + CGLIB 增强两条主线

上一篇已经把配置类解析主线立住了。

我们已经知道：

- `ConfigurationClassPostProcessor` 在 `refresh()` Step 5 被拉起
- `ConfigurationClassParser` 会通过 `@ComponentScan`、`@Import` 等入口递归扩张定义世界
- 配置类处理的结果不是实例，而是一批还要继续落回容器的定义

看到这里，自然就会进入一个更具体的问题：

- 那配置类里的 `@Bean` 方法，最后到底是怎么变成真正 Bean 的？

如果只从 Java 语言表面看，`@Bean` 很容易被理解成这样：

- 这就是一个普通方法
- 返回一个对象
- Spring 以后调用它就完了

这个理解在最浅层当然有点像事实，但对 Spring 真正的容器语义来说远远不够。

因为对容器而言，`@Bean` 方法背后至少同时有两层完全不同的问题。

第一层问题是：**一个方法声明，如何在定义世界里先被登记成 BeanDefinition。**

也就是说，Spring 首先要回答的不是：

- 这个方法现在怎么执行

而是：

- 这个方法声明出来的 Bean，怎样先变成容器能理解的定义蓝图

这一步如果不先成立，后面 `getBean("dataSource")` 这种调用根本没有稳定的容器入口可走。

第二层问题是：**配置类内部方法调用并不等于普通 Java this 调用。**

这也是很多人第一次真正深看 `@Bean` 主线时最容易被震住的地方。

例如：

```java
@Configuration
class AppConfig {
    @Bean
    DataSource dataSource() { ... }

    @Bean
    TransactionManager txManager() {
        return new TxManager(dataSource());
    }
}
```

如果按普通 Java 直觉理解，`txManager()` 里面调用 `dataSource()` 就是一次普通方法调用，于是看起来会发生：

- 每次都重新执行一次 `dataSource()`
- 每次都 new 出一个新对象

但 Spring 的默认单例语义显然不允许这个结论成立。

所以对容器来说，真正的问题不是“方法能不能执行”，而是：

- **配置类内部方法互调时，如何让它们仍然回到容器单例世界，而不是退化成普通 Java 调用世界。**

第三层问题是：**`@Bean` 的行为不是统一一刀切，它本身还要继续分成不同创建路径。**

例如：

- `static @Bean` 方法
- 实例级 `@Bean` 方法
- 带 `@Scope` / Scoped Proxy 的方法级 Bean

这说明 Spring 真正要组织的不是“调用某个方法返回对象”，而是：

- **如何把方法级定义翻译成容器世界里不同的创建路径和生命周期策略。**

因此，本文真正要回答的问题不是“`@Bean` 方法是怎么工作的”，而是：

**为什么对 Spring 来说，`@Bean` 必须先被建模成方法级 BeanDefinition，再通过 CGLIB 增强把配置类内部调用重新拉回容器世界，才能守住默认单例语义？**

## 先看失败方案：为什么不能把 `@Bean` 当普通方法、也不能只注册定义不做代理

理解 `@Bean` 主线，最好的方式不是先背 CGLIB 回调，而是先看几种特别自然、但一放到配置类语义里就会迅速失效的朴素方案。

### 失败方案一：`@Bean` 就是普通工厂方法，容器需要时直接调一下就行

这是最符合表面直觉的方案。

因为从语法上看，`@Bean` 确实很像：

- 一个普通方法
- 返回一个普通对象

如果 Spring 面对的只是“按名字绑定一个方法工厂”，这个理解几乎已经足够。

但问题在于，容器最终要管理的不是这个方法本身，而是：

- 这个方法声明出来的 Bean 定义
- 它的名字、作用域、初始化/销毁方法、autowireCandidate、条件语义

也就是说，在真正执行方法之前，Spring 首先必须把它变成定义世界里的一张标准蓝图。

所以 `@Bean` 首先不是“方法调用问题”，而是：

- **方法声明如何先进入 BeanDefinition 世界的问题。**

### 失败方案二：那就把 `@Bean` 注册成 BeanDefinition，后面调用时按普通 Java 方法执行就行

如果意识到“先有定义”是必须的，第二种自然思路就会是：

- 好，那就把 `@Bean` 方法注册成 BeanDefinition
- 需要实例时再普通调用这个方法

这个方案比前一个更接近 Spring 真相，但它仍然不够。

因为只要配置类内部存在方法互调，普通 Java 调用就会立刻把 Spring 的容器语义撕开：

- `txManager()` 里直接调 `dataSource()`
- 就会变成一次普通 `this.dataSource()`
- 根本绕开 `BeanFactory.getBean("dataSource")`

结果就是：

- 容器外的单例世界在说“这个 Bean 只有一份”
- 配置类内部的方法调用世界却在说“我每次都再执行一次工厂方法”

也就是说，如果没有额外桥接，Spring 容器内部会同时存在两套互相冲突的世界观：

- 容器世界：按 BeanDefinition 和 singleton 语义管理对象
- 普通 Java 方法世界：按方法调用语义直接执行

Spring 显然不能接受这个撕裂，所以它必须继续引入下一层机制，把配置类内部调用重新拉回容器世界。

### 失败方案三：只要方法互调时手工查一下缓存，不需要增强整类

还有一种很容易让人觉得“够聪明”的朴素方案：

- `@Bean` 方法调用时，先看看容器里有没有
- 没有再执行方法
- 这样似乎就不用整个配置类都做 CGLIB 增强了

这个思路的问题在于，它低估了配置类内部调用的本质：

- 容器并不是在外部统一调度每次方法调用
- 真正绕开的恰恰是 `this.beanMethod()` 这种普通 Java 调用本身

也就是说，Spring 真正要拦住的不是“工厂逻辑”，而是：

- **配置类实例上的方法分派。**

如果不增强配置类本身，那么方法之间的互调根本没有机会被容器截获。

所以 Spring 最终不能只做“定义注册 + 工厂调用”，它必须：

- **把配置类实例本身变成一个可拦截的增强子类。**

这就是 `ConfigurationClassEnhancer` 必须出现的根本原因。

## Spring `@Bean` 主线的最小总图

如果把这条主线先压缩成最小模型，它可以写成下面这样：

```text
configuration class parsed
   -> bean methods collected
   -> bean method definitions registered
   -> full configuration classes enhanced
   -> internal @Bean method call intercepted
   -> bean fetched from container instead of plain Java call
```

如果再换一种更容易理解的拆法，这条链可以分成四段职责：

```text
[方法级定义落地]
ConfigurationClassBeanDefinitionReader

   ->

[配置类增强入口]
ConfigurationClassPostProcessor.enhanceConfigurationClasses

   ->

[增强实现]
ConfigurationClassEnhancer / EnhancedConfiguration

   ->

[方法调用桥接]
BeanMethodInterceptor / BeanFactoryAwareMethodInterceptor
```

这张图最重要的价值，不是让读者记住类名，而是先把四个问题分开：

### 一、方法级定义落地

回答：`@Bean` 方法到底怎样先变成 BeanDefinition，而不是直接被执行？

### 二、配置类增强入口

回答：为什么配置类在定义世界处理完之后，还要被统一检查并增强？

### 三、增强实现

回答：为什么必须生成 CGLIB 子类，而不是给原始配置类打点补丁？

### 四、方法调用桥接

回答：配置类内部 `this.beanMethod()` 为什么最终会重新回到容器 `getBean(...)` 语义上？

只要先把这四层职责分开，`@Bean` 就不再像“多了一种写 Bean 的语法”。

## 一、`ConfigurationClassBeanDefinitionReader`：`@Bean` 方法首先不是执行体，而是方法级 BeanDefinition 来源

只要先从定义世界看，`@Bean` 最容易被讲错的一点就是：

- 大家太快就去关注“方法怎么执行”

但对容器来说，第一步根本还不是执行，而是：

- 先把 `@Bean` 方法转成一张容器能理解的定义蓝图

这就是 `ConfigurationClassBeanDefinitionReader` 的位置。

它最关键的价值，不是“把解析结果写回 registry”这么表面，而是：

**把配置类世界里方法级声明重新落回 BeanDefinition 世界。**

也就是说，经过前两篇：

- `ConfigurationClassPostProcessor` 先拉起 Step 5
- `ConfigurationClassParser` 再递归扩张配置候选世界

到这里，Spring 才真正开始回答：

- 这些配置类里提取出来的 `@Bean` 方法，如何正式成为容器定义输入

这一步特别重要，因为它再次证明：

- Spring 处理 `@Bean` 时，优先级先落在“定义建模”而不是“方法调用”上

也就是说，`@Bean` 方法在这一阶段还不是可执行行为，而是：

- 一个未来会怎样创建对象的定义来源

## 二、为什么 `static @Bean` 和实例级 `@Bean` 必须分成两条创建路径

只要继续往方法级定义里看，Spring 很快就会面对一个特别现实的问题：

- 所有 `@Bean` 方法真的是同一种吗？

答案显然不是。

因为至少从创建路径看，它们就已经分成两类：

### 1. `static @Bean`

这种方法不依赖配置类实例本身。

也就是说，容器在未来创建这个 Bean 时，不必先拿到配置类对象，再去调方法。

它更接近：

- 一条可以直接按静态工厂方法理解的创建路径

### 2. 实例级 `@Bean`

这种方法则完全不同。

它意味着容器未来创建这个 Bean 时，必须先：

- 拿到配置类实例
- 再在这个实例上调用目标 `@Bean` 方法

这说明 `@Bean` 不是一个统一工厂模型，而是：

- **方法声明相同，但后续创建路径可能不同。**

也正因为如此，Spring 在定义阶段就必须把这种差异编码进 `ConfigurationClassBeanDefinition`：

- 有的记录成静态创建路径
- 有的记录成 `factoryBeanName + factoryMethodName` 路径

所以这里真正建模的，不只是“这个方法会产出一个 Bean”，而是：

- **这个 Bean 以后到底通过哪条工厂路径进入实例世界。**

## 三、为什么 full 配置类必须增强：不增强就守不住 `@Bean` 的单例语义

只要进入实例级 `@Bean` 方法世界，最核心的问题就来了：

- 配置类内部方法互调怎么办？

这是 `ConfigurationClassEnhancer` 存在的真正背景。

因为只要配置类是 full 模式，Spring 就默认承诺了一层很强的语义：

- 配置类里的 `@Bean` 方法互相引用时，仍应回到容器世界，遵守单例语义

也就是说，在下面这种代码里：

```java
@Bean
DataSource dataSource() { ... }

@Bean
TransactionManager txManager() {
    return new TxManager(dataSource());
}
```

Spring 要守住的不是“方法能跑”，而是：

- `txManager()` 里面那次 `dataSource()` 调用，不应该重新 new 一个 DataSource
- 它应该重新回到容器里，拿到同一份单例 Bean

这说明 Spring 在这里必须做一件普通 Java 语义做不到的事：

- **拦截配置类实例上的方法分派。**

也正因为如此，它不能只处理 BeanDefinition，还必须继续增强配置类本身。

所以 CGLIB 在这里不是“顺手代理一下”，而是：

- **守住 `@Bean` 方法单例语义的核心机制。**

## 四、`ConfigurationClassEnhancer`：Spring 不是增强方法，而是在重写“配置类实例如何响应 `@Bean` 方法调用”

只要明确了增强的必要性，下一步最关键的理解就不是“Spring 用了 CGLIB”，而是：

- 它到底增强了什么？

更准确地说，Spring 在这里不是仅仅给某个方法加一个 advice，而是在：

- 生成配置类的 CGLIB 子类
- 让这个子类在 `@Bean` 方法调用时拥有容器感知能力

这一步特别重要，因为它说明 Spring 真正重写的不是“业务逻辑”，而是：

- **配置类实例对 `@Bean` 方法的分派语义。**

也就是说，在增强前：

- `this.dataSource()` 只是普通 Java 方法调用

在增强后：

- 同一个调用机会先进入 Spring 的拦截器逻辑
- 再由 Spring 判断：这是容器调用，还是配置类内部用户式调用

这说明 `ConfigurationClassEnhancer` 的位置极其关键。

它站在定义世界与实例世界之间，做的其实是一件非常特殊的桥接工作：

- 定义阶段已经把 `@Bean` 方法注册成了 BeanDefinition
- 现在实例阶段还要让配置类实例上的方法调用重新指回这些定义

所以它不是一般意义上的 AOP 代理，而更像：

- **配置类语义和容器单例语义之间的桥接增强器。**

## 五、`BeanMethodInterceptor`：Spring 真正判断的不是“方法该不该执行”，而是“这次调用是容器创建，还是用户引用”

只要进入增强后的配置类，最关键的逻辑就落在 `BeanMethodInterceptor` 上。

它最容易被误解成：

- 拦截 `@Bean` 方法
- 然后总是从容器返回 Bean

这个理解不够准确。

因为 Spring 真正要回答的不是“方法还能不能跑”，而是：

- **这次调用到底是谁在发起。**

这点特别关键。

因为配置类里的同一个 `@Bean` 方法，至少会遇到两类完全不同的调用场景：

### 1. 容器自己在正式创建这个 Bean

这时候 Spring 不能直接 short-circuit 到 `getBean()`，否则 Bean 永远没法真正出生。

所以此时真正该发生的是：

- 执行真实方法体
- 真正创建目标实例

### 2. 配置类内部或其他用户路径再次调用这个 `@Bean` 方法

这时候如果再执行真实方法体，就会破坏容器单例语义。

所以此时真正该发生的是：

- 回到 BeanFactory
- 取已经注册/正在管理的那个 Bean

也就是说，`BeanMethodInterceptor` 真正分流的，不是“要不要方法增强”，而是：

- **容器创建路径 vs 用户引用路径。**

这就是它最像 Spring 的地方。

因为它不是只关心“方法调用本身”，而是在关心：

- 这次方法调用在容器生命周期里处于什么角色

## 六、为什么 `BeanFactoryAwareMethodInterceptor` 和 `$$beanFactory` 字段注入不是细节，而是增强子类重新接回容器世界的关键桥

只要讲到 `BeanMethodInterceptor`，另一个很自然的问题就会冒出来：

- 增强后的配置类子类，怎么拿到 BeanFactory？

这就是 `BeanFactoryAwareMethodInterceptor` 和 `$$beanFactory` 字段存在的原因。

这一步如果讲浅了，很容易被理解成：

- 哦，就是增强类里塞了个字段

但它真正的重要性在于：

- **增强子类要想把方法调用重新导回容器，自己就必须先连回容器。**

也就是说，Spring 在这里做的不是普通代理对象那种“包一个方法拦截器”而已，而是：

- 通过标记接口 `EnhancedConfiguration`
- 通过 `BeanFactoryAware` 回调
- 再通过增强类里的 `$$beanFactory` 存储点

把“配置类实例”重新接回了 BeanFactory 世界。

这说明 CGLIB 增强在这里不是装饰，而是：

- **方法分派世界和容器世界重新打通的桥。**

没有这个桥，`BeanMethodInterceptor` 就算知道这次该回容器取 Bean，也根本无从下手。

## 七、为什么这条主线必须放在 `@ComponentScan` / `@Import` 之后，而不是被当作 `@Bean` 注解小技巧来讲

看到这里，最值得回收的一个问题就是：

- 为什么 `@Bean` 与配置类增强不能只是一个注解专题？

因为它根本不是在讲“方法怎么写”，而是在承接前两篇定义世界扩张主线的落地问题。

前一篇已经把：

- `@Configuration`
- `@ComponentScan`
- `@Import`
- `DeferredImportSelector`
- `ImportStack`

这些扩张定义世界的入口讲清楚了。

但那些篇章还只是在回答：

- 定义世界怎么继续长大

到了这一篇，问题才真正落地成：

- 这些解析结果怎样变成方法级 BeanDefinition
- 实例级 `@Bean` 方法又怎样在运行时继续守住容器单例语义

也就是说，这篇站的位置很关键：

- 它既属于定义世界的落地
- 又开始触碰实例世界里的方法调用桥接

所以它不能只是“注解语法解释”，而是：

- **配置类处理主线从定义扩张走向实例语义兑现的关键桥段。**

## 八、几个最容易错的判断

### 1. `@Bean` 方法就是普通工厂方法，Spring 需要时调一下就行

不成立。

它首先会被建模成方法级 BeanDefinition，而不是直接当普通 Java 调用处理。

### 2. 只要 `@Bean` 已经注册成 BeanDefinition，就不需要再增强配置类了

不成立。

不增强的话，配置类内部方法互调仍然是普通 Java 调用，会直接绕开容器单例语义。

### 3. `ConfigurationClassEnhancer` 只是普通 AOP 代理的一种

不完整。

它真正解决的是配置类实例上的 `@Bean` 方法分派怎样重新接回容器世界，而不只是“包一层代理”。

### 4. `BeanMethodInterceptor` 只是拦截后统一 `getBean()`

不成立。

它首先要区分“容器正在创建这个 Bean”还是“用户路径在引用这个 Bean”，两条路径的处理完全不同。

### 5. `static @Bean` 和实例级 `@Bean` 只是语法差异

不成立。

它们在定义世界里就已经对应不同创建路径，后续实例化主线也会走不同分支。

## 收网：Spring 要统一的从来不是“怎么执行一个 `@Bean` 方法”，而是“方法级定义如何先进入容器，再通过增强守住容器语义”

现在可以回到开头那个问题：为什么 `@Bean` 看起来只是方法级配置，Spring 却要拆出定义注册和 CGLIB 增强两条主线？

因为对 Spring 这种 IoC 容器来说，它真正要面对的不是“一个方法怎么返回对象”，而是：

- 这个方法声明的 Bean 如何先进入定义世界
- 静态方法和实例方法如何走不同创建路径
- 配置类内部方法互调时如何不退化成普通 Java 调用
- 增强子类如何重新接回 BeanFactory 世界

所以 Spring 的答案不是把 `@Bean` 当作普通工厂方法，而是建立一条完整桥接链：

```text
ConfigurationClassBeanDefinitionReader
   -> @Bean 方法级定义落地

ConfigurationClassPostProcessor.enhanceConfigurationClasses
   -> full 配置类增强入口

ConfigurationClassEnhancer
   -> CGLIB 子类生成 + BeanFactoryAware 桥接

BeanMethodInterceptor
   -> 容器创建路径 vs 用户引用路径分流
```

因此，这篇真正该带走的结论不是“Spring 会代理 `@Configuration`”，而是：

**Spring 把 `@Bean` 问题从“怎么执行方法”提升成了“方法级定义如何先进入容器，再通过配置类增强把普通 Java 方法调用重新拉回容器单例世界”的容器级协议。**

这也留下了下一篇最自然的问题：既然配置类主线已经通过 `@Configuration`、`@ComponentScan`、`@Import`、`@Bean` 把定义世界扩张、落地并守住实例语义了，那接下来真正把“某个定义到底要不要存在”这件事继续往前推的，就是条件装配体系本体：

- `@Conditional`
- `ConditionEvaluator`
- `Condition` / `ConfigurationCondition`
- 为什么 Boot 的 `@ConditionalOnClass`、`@ConditionalOnBean` 都会回到这套机制

下一篇进入 Spring 的 `@Conditional` 条件装配主线。