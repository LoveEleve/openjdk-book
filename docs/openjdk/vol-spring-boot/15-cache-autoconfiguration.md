# 为什么只加 `@EnableCaching` 和一点点依赖，Boot 就能把 `CacheManager` 默认装起来

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接前面 Redis 与 Redisson 主线，回到 Boot 原生基础设施自动配置：缓存。重点放在 `CacheAutoConfiguration`、`CacheType`、`CacheManager` 选择、`CacheProperties`、以及 Redis/Caffeine/Simple 等典型分支的成立条件。本文不重复 `vol-spring` 中 `@Cacheable`、`CacheInterceptor`、AOP 切面原理，而聚焦 Boot 如何把缓存基础设施默认装起来。下一篇将继续进入事务自动配置或 FailureAnalyzer / ConfigData 等生产层域。

## 为什么很多项目只写了 `@EnableCaching`，再加一点依赖，就突然拥有了一个默认可用的缓存世界

只要做过 Spring Boot 业务应用，几乎都会见过一种非常常见的现象：

- 类上加一个 `@EnableCaching`
- 方法上加一个 `@Cacheable`
- 再引一点 Redis 或 Caffeine 相关依赖
- 缓存竟然就开始工作了

这件事如果只从使用体验看，很容易被理解成：

- Boot 只是顺手给你 new 了一个 `CacheManager`

但只要认真拆开这条链，就会发现里面至少有几组必须协调的决策：

- 当前应用到底有没有开启缓存能力
- classpath 上到底有哪些缓存实现
- 应该选 `Simple`、`Caffeine`、`Redis` 还是其他类型
- 用户是否已经自己定义了 `CacheManager`
- 统一的缓存配置怎样绑定成结构化 properties
- 选中的 `CacheManager` 怎样与前面 `@Cacheable` 那条 Framework 主线真正接上

也就是说，用户看到的是：

- “写个注解，缓存就能用了”

源码层面真实发生的是：

- **Boot 把缓存类型选择、外部配置绑定、`CacheManager` 创建和 Framework 缓存拦截主线组织成了一条有条件的默认装配链。**

第一层问题是：**缓存自动配置首先要解决的不是“new 哪个 `CacheManager`”，而是“当前应用应该走哪条缓存实现路径”。**

因为缓存和前面 DataSource、Redis 一样，不是一个唯一实现世界。

当前应用可能：

- 没有任何外部缓存依赖
- 只有本地内存缓存实现
- 使用 Redis 作为分布式缓存
- 甚至用户已经显式定义了自己的 `CacheManager`

所以 Boot 一开始必须做的，不是创建某个具体对象，而是：

- **先决定缓存实现路径。**

这里还要先把边界说准：`CacheConfigurationImportSelector` 会把所有 `CacheType` 对应配置类都导入进来，但真正哪一条成立，不是 selector 当场拍板，而是后续由每个分支上的 `CacheCondition`、类路径条件和缺失 Bean 条件继续筛选。

第二层问题是：**`CacheManager` 不是一个孤立 bean，它是 Framework 缓存抽象落地的资源锚点。**

前面 `vol-spring` 已经讲过：

- `@Cacheable` 最终会进入缓存拦截器链
- 拦截器真正依赖的是缓存抽象

这意味着 Boot 自动配置这里的任务不是“让缓存注解看起来存在”，而是：

- 让 `@Cacheable` 真正拥有一个可以落地执行的 `CacheManager`

也就是说，缓存自动配置和 `@Cacheable` 的关系，正像：

- DataSource 自动配置和 `JdbcTemplate` 的关系
- Redis 自动配置和 `RedisTemplate` 的关系

第三层问题是：**Boot 的缓存默认体验必须允许用户逐层接管，而不是一旦选了默认 `CacheManager` 就封死入口。**

真实项目里非常常见的需求是：

- 默认先给我一个能跑的 `CacheManager`
- 但具体缓存名、TTL、序列化、本地/远程实现，我还要进一步调

如果 Boot 不给这种渐进式接管空间，缓存默认体验就会很快退化成：

- 要么完全吃默认
- 要么整套退出 Boot 缓存自动配置世界

因此，本文真正要回答的问题不是“Boot 怎么自动配缓存”，而是：

**为什么对 Boot 来说，必须先把缓存实现路径判断清楚，再围绕统一的 `CacheProperties` 和 `CacheManager` 抽象提供默认落地，并始终保留用户覆盖与扩展的空间，Framework 的 `@Cacheable` 主线才能真正拥有稳定的默认运行环境。**

## 先看失败方案：为什么不能只要有 `@EnableCaching` 就随便 new 一个 `CacheManager`、不能把 Redis 直接写死成唯一缓存后端、也不能让缓存实现选择散落到业务代码里

### 失败方案一：只要类上有 `@EnableCaching`，Boot 就直接随便给一个 `CacheManager`

这是最容易产生的错觉。

因为从用户角度看，启用缓存好像就差一个“底层实现对象”。

但真正的问题不是：

- 有没有一个叫 `CacheManager` 的 bean

而是：

- 这个应用到底应该走哪种缓存实现
- 它和 classpath / 外部配置 / 用户自定义 bean 是什么关系

如果只为了让缓存注解先能跑，就随便给一个默认 `CacheManager`，很可能会导致：

- 应用明明已经引了 Redis，却仍然走本地缓存
- 用户明明希望本地缓存，却被远程缓存默认接管
- 同一项目不同环境的缓存路径不可预测

所以 Boot 不可能只凭“开启缓存”这一件事就草率给出实现。

### 失败方案二：现代项目都用 Redis，Boot 直接把 Redis 写死成默认缓存实现就好

这个判断在很多生产项目里很有诱惑力，因为：

- Redis 确实是常见缓存后端

但它仍然不成立。

因为在 Boot 世界里，缓存并不是只有一种落地：

- 本地开发环境可能只想要 `Simple` 或 `Caffeine`
- 一些服务根本没引 Redis
- 用户也可能显式指定别的缓存实现

如果把 Redis 写死，Boot 会直接失去：

- 本地缓存的默认路径
- 多实现条件装配的灵活性
- 用户通过 classpath 与配置决定路径的能力

所以缓存实现选择必须像前面的基础设施一样，仍然留在条件装配层。

### 失败方案三：每个业务模块自己决定该 new 哪种缓存实现

这会迅速让缓存世界碎掉。

因为一旦缓存实现选择下沉到业务模块：

- 每个模块可能自己选 `CacheManager`
- TTL、序列化、cache names 等公共语义会失去统一
- `@Cacheable` 会退化成看似统一、实则后端不统一的注解

Boot 的价值恰恰在于：

- **先把缓存基础设施在应用层统一收口。**

## 缓存自动配置的最小总图

如果把这条装配链先压缩成最小模型，它可以写成下面这样：

```text
@EnableCaching + cache libs on classpath
   -> CacheProperties binding
   -> CacheAutoConfiguration
   -> choose CacheType
   -> create CacheManager
   -> @Cacheable gets a real backend
```

如果再换一种更适合理解职责的拆法，它可以分成下面六层：

```text
[能力开关]
@EnableCaching

   ->

[类路径与配置事实]
cache implementation libs + CacheProperties

   ->

[路径判断]
CacheType / conditions / user beans

   ->

[资源锚点]
CacheManager

   ->

[具体实现]
Simple / Caffeine / Redis / ...

   ->

[Framework 落地]
@Cacheable / CacheInterceptor 真正拥有后端
```

这张图最重要的价值，不是背配置类名，而是把六个问题分开：

### 一、能力开关

回答：缓存能力到底怎样被应用显式打开？

### 二、类路径与配置事实

回答：Boot 判断缓存路径时到底读哪些事实？

### 三、路径判断

回答：谁决定当前走哪种缓存实现？

### 四、资源锚点

回答：为什么 `CacheManager` 是缓存自动配置的核心落点？

### 五、具体实现

回答：Redis / Caffeine / Simple 这些路径怎样各自成立？

### 六、Framework 落地

回答：为什么只有 `CacheManager` 真正成立以后，`@Cacheable` 才算拥有可执行后端？

## 一、缓存自动配置先判断“这是不是一条可以进入 Boot 缓存基础设施世界的路径”

回到最外层，`CacheAutoConfiguration` 并不是无条件创建一个 `CacheManager`。

它首先要确认几个基础事实：

- Spring 缓存抽象相关类是否存在
- 当前用户是否已经定义了自己的 `CacheManager`
- classpath 上到底有哪些缓存实现可选
- 用户是否通过 properties 显式指定了缓存类型

这说明缓存自动配置的第一职责不是“先选 Redis”，而是：

- **先决定当前应用是否、以及应当以哪条路径进入默认缓存装配链。**

## 二、`CacheProperties`：先把缓存公共配置收口成统一的外部配置对象

和前面 DataSource / Redis 一样，Boot 不希望把缓存相关配置散落在自动配置代码里逐项读取。

`CacheProperties` 负责统一承载：

- cache type
- cache names
- Redis / Caffeine / Simple 等分支配置的公共或子配置部分

也就是说，Boot 会先把：

- `spring.cache.*`

绑定成：

- 一个结构化的 properties 对象

后面的缓存路径判断和 `CacheManager` 创建才有稳定输入。

这一步特别关键，因为它让：

- 类型选择
- 默认 cache names
- 特定实现的细节配置

都能先围绕同一个配置模型组织起来。

## 三、为什么 `CacheType` 很重要：缓存自动配置真正先做的是“选实现路径”

很多人会把缓存自动配置理解成：

- 反正最后就是给一个 `CacheManager`

但更准确地说，`CacheManager` 只是最终资源锚点，真正最先发生的决策是：

- 当前走哪种缓存实现路径

这正是 `CacheType` 存在的意义。

因为在 Boot 世界里，缓存不是单实现问题，而是多分支条件选择问题。

也就是说，Boot 先要判断：

- 用户是否显式指定 `spring.cache.type`
- 如果没指定，当前是否允许走“automatic cache type”路径
- classpath 上有哪些实现可用
- 当前有没有用户自己的缓存 bean 应该让默认路径退让

然后才会进入：

- 具体 `CacheManager` 的创建

这里还要说准优先级：在当前源码里，`CacheCondition` 会先尝试绑定 `spring.cache.type`；只有当它没有显式绑定时，分支配置才会以“automatic cache type”语义继续参与匹配。

所以 `CacheType` 不是一个装饰性枚举，而是：

- **缓存自动配置从“事实判断”走向“具体实现”的分叉点。**

## 四、为什么 `CacheManager` 是整条链的资源锚点，而不是某个具体缓存实现类

在 Spring 缓存抽象里，真正被 `@Cacheable` 主线消费的不是：

- `RedisCacheManager` 本身
- `CaffeineCacheManager` 本身

而是更高层的：

- `CacheManager`

这意味着 Boot 自动配置在这里最核心的落点，不是某个实现名，而是：

- 当前应用最终有没有一个可用的 `CacheManager`

只有这个锚点成立，前面 `vol-spring` 讲过的缓存拦截主线才算真正有了后端。

所以 Boot 在缓存域里的真实任务不是：

- “挑一种缓存库就结束”

而是：

- **根据路径判断，最终稳定落到一个 `CacheManager` 抽象。**

## 五、为什么 Redis、Caffeine、Simple 等路径必须被看成平行分支，而不是附加特性

只要 `CacheType` 这层判断已经立住，就必须进一步把不同实现路径看成：

- 平行分支

而不是某种“主实现 + 附加插件”。

例如：

### Redis 路径

更偏远程分布式缓存场景，通常会围绕 Redis 相关依赖、`RedisConnectionFactory` 和 RedisCache 配置继续展开。源码上这条路径还要求：

- `RedisConnectionFactory` 类存在
- 容器里已经有 `RedisConnectionFactory` bean
- 用户还没有自己定义 `CacheManager`
- `CacheCondition` 允许 `REDIS` 路径成立

### Caffeine 路径

更偏本地高性能缓存场景，通常不依赖外部基础设施。

### Simple 路径

更像最小默认实现或开发期兜底路径。

这三条路径的共同点在于：

- 最终都要落成 `CacheManager`

但它们的成立前提、运行代价、序列化语义和生产适用场景明显不同。

所以 Boot 必须把这些路径当成：

- **并列候选实现**

而不是在一个大配置类里顺手补几个可选选项。

## 六、为什么用户感知到的是“缓存注解能工作了”，而不是“某个 CacheManager bean 出现了”

站在源码视角，Boot 做了很多层工作：

- 读 `spring.cache.*`
- 判断 `CacheType`
- 选择具体实现
- 创建 `CacheManager`

但站在用户视角，最后感知到的通常只有一句话：

- `@Cacheable` 真的开始工作了

这恰恰说明 Boot 做对了。

因为它并没有把用户暴露在：

- 实现分支判断
- `CacheManager` 构造细节
- 各缓存实现的基础 bean 组装顺序

而是把这些层协同后压缩成了：

- 一个稳定的默认缓存体验

也就是说，Boot 在这里追求的并不是“让用户知道自己配了哪几层”，而是：

- **让多层自动配置最后表现成一句简单的“缓存能用了”。**

## 七、为什么这条默认体验必须始终允许用户接管，而不是只给一个黑盒 `CacheManager`

和前面 DataSource / Redis / Web 一样，真正考验 Boot 设计的，不是默认值能不能成立，而是：

- 当用户想改一点时，会不会被迫退出整条默认链

在缓存场景下，这一点非常常见。

用户常常只想改：

- cache names
- TTL
- null value 行为
- serialization
- 本地/远程实现路径
- 某个自定义 `CacheManager`

如果每次都必须完全推翻 Boot 默认缓存链，用户体验会非常差。

所以 Boot 这里同样追求：

- 默认链先成立
- 但用户可以通过 properties、显式 `CacheManager`、特定实现自定义 bean 等方式按层接管

也就是说，Boot 提供的不是：

- 写死的缓存黑盒

而是：

- **默认可用、用户可渐进式介入的缓存基础设施。**

## 八、最小源码证据：这条链确实是“properties -> type choice -> CacheManager”逐层成立

如果只讲到这里，读者仍然可能会觉得：

- 这是不是又把几个常见类名串成了故事
- 源码里有没有直接证据说明 Boot 真是先选路径，再建 `CacheManager`

先看 `CacheAutoConfiguration` 的核心入口：

```java
@AutoConfiguration(after = { CouchbaseDataAutoConfiguration.class, HazelcastAutoConfiguration.class,
        HibernateJpaAutoConfiguration.class, RedisAutoConfiguration.class })
@ConditionalOnClass(CacheManager.class)
@ConditionalOnBean(CacheAspectSupport.class)
@ConditionalOnMissingBean(value = CacheManager.class, name = "cacheResolver")
@EnableConfigurationProperties(CacheProperties.class)
@Import({ CacheConfigurationImportSelector.class, CacheManagerEntityManagerFactoryDependsOnPostProcessor.class })
public class CacheAutoConfiguration {
```

这段代码至少证明了三件事：

- Boot 确实围绕 `CacheManager` 抽象组织自动配置
- 它要求 Spring 缓存主线已经被打开（`CacheAspectSupport` 存在）
- 它只会在用户没有自己提供 `CacheManager` / `cacheResolver` 时继续默认路径

这里还要把 `CacheAspectSupport` 说得更准：它不是“随便一个缓存类”，而是 Spring Framework 缓存拦截主线已经进入容器世界的信号；也正因为有这个条件，Boot 才不是孤立地配缓存实现，而是在给 `@EnableCaching` 之后的 Framework 缓存链补后端。

再看 `CacheConfigurationImportSelector` 的真实行为：

```java
@Override
public String[] selectImports(AnnotationMetadata importingClassMetadata) {
    CacheType[] types = CacheType.values();
    String[] imports = new String[types.length];
    for (int i = 0; i < types.length; i++) {
        imports[i] = CacheConfigurations.getConfigurationClass(types[i]);
    }
    return imports;
}
```

以及 `CacheCondition` 的关键判断：

```java
BindResult<CacheType> specified = Binder.get(environment).bind("spring.cache.type", CacheType.class);
if (!specified.isBound()) {
    return ConditionOutcome.match(message.because("automatic cache type"));
}
CacheType required = CacheConfigurations.getType(sourceClass);
if (specified.get() == required) {
    return ConditionOutcome.match(message.because(specified.get() + " cache type"));
}
```

这两段代码共同说明：

- selector 会把所有 `CacheType` 对应的配置类都导入
- 但真正哪条路径成立，要继续交给每个分支上的 `CacheCondition`
- `spring.cache.type` 一旦显式指定，就优先于自动推断
- 没指定时，才允许具体分支以“automatic cache type”语义继续匹配

也就是说，Boot 在缓存域里真实做的不是：

- “看到 `@EnableCaching` 就 new 一个 manager”

而是：

- **先绑定 `CacheProperties`，再导入全部候选分支，再用 `CacheCondition` 和类路径/缺失 Bean 条件筛出真正的 `CacheManager` 路径。**

## 九、为什么这篇应该放在 Redis 与 Redisson之后，而不是更前面

看到这里，最值得回收的一个问题就是：

- 为什么缓存自动配置不更早讲？

因为缓存恰好是一个会和前面 Redis 域、甚至 Redisson 域发生强耦合的基础设施：

- RedisCache 可能依赖前面 Redis 基础连接设施
- 某些生产项目里的缓存方案和 Redisson 也会形成组合使用

也就是说，把缓存放在 Redis / Redisson 之后，读者更容易看清：

- 缓存不是又一条孤立主线
- 它会复用前面已经建立好的部分基础设施世界

而如果把它放得太早，读者很容易只把它看成：

- `@Cacheable` 的一个方便补丁

而不是 Boot 原生基础设施链的一部分。

## 十、几个最容易错的判断

### 1. 只要有 `@EnableCaching`，Boot 就一定会随便给一个 `CacheManager`

不成立。

还要满足缓存抽象类路径、缓存主线已启用、用户未自定义 `CacheManager` 或 `cacheResolver` 等边界。

### 2. Boot 缓存自动配置本质上就是默认走 Redis

不成立。

Redis 只是一个常见分支，Boot 还会根据 classpath 与配置在 `Simple`、`Caffeine`、`Redis` 等路径间选择。

### 3. `CacheProperties` 只是给 `@Cacheable` 多读几个字符串

不成立。

它是缓存实现路径选择与具体 manager 配置的统一外部配置载体。

### 4. `CacheManager` 只是某个缓存实现的附属 bean，没有抽象层价值

不成立。

它正是 Framework 缓存拦截主线真正依赖的资源锚点。

### 5. Boot 缓存一旦默认成立，用户就很难再改

不成立。

Boot 仍然维持的是默认成立、用户可渐进式接管，而不是封闭黑盒。

## 收网：Boot 统一的不是“帮你挑一个缓存实现”，而是“围绕 `CacheManager` 把缓存实现路径、配置事实和 Framework 主线接成一条默认基础设施链”

现在可以回到开头的问题：为什么只加 `@EnableCaching` 和一点点依赖，Boot 就能把 `CacheManager` 默认装起来？

因为真实发生的是一条逐层装配链：

```text
@EnableCaching + cache libs on classpath
   -> CacheProperties
   -> CacheAutoConfiguration
   -> CacheType / 条件分支选择
   -> concrete CacheManager
   -> @Cacheable 真正拥有后端
```

所以这篇真正该带走的结论不是“Boot 会自动配缓存”，而是：

**Boot 先把缓存相关外部配置绑定成 `CacheProperties`，再根据 classpath、用户自定义 bean 与 `CacheType` 选择具体实现分支，最后让 `CacheManager` 成为 Framework 缓存主线的统一资源锚点；因此，缓存默认体验不是注解魔法，而是一条有条件、有路径分叉、且允许用户接管的缓存基础设施自动配置链。**