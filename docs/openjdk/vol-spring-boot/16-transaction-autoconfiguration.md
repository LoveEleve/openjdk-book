# 为什么只要用了 JDBC 并加上 `@Transactional`，Boot 往往就会把事务管理器默认接好

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接前一篇缓存自动配置，继续回到 Boot 原生基础设施主线：事务自动配置。重点放在 `TransactionAutoConfiguration`、`DataSourceTransactionManagerAutoConfiguration`、`TransactionManagerCustomizationAutoConfiguration`、`PlatformTransactionManager` 的默认装配边界，以及它们怎样和前面 `vol-spring` 中已经讲过的 `@Transactional` AOP 主线接起来。本文不重复事务传播、回滚规则与拦截器执行细节，而聚焦 Boot 如何把事务基础设施默认装起来。下一篇将继续进入 FailureAnalyzer 或 ConfigData 等生产层主题。

## 为什么很多项目只要有 DataSource，再写上 `@Transactional`，事务看起来就自然工作了

只要做过最常见的 Spring Boot JDBC 或 MyBatis 项目，几乎都会见过这样一种体验：

- DataSource 已经存在
- service 方法上加一个 `@Transactional`
- 数据库操作就像自然拥有了事务边界

这件事如果从用户视角看，很容易被理解成：

- Spring Framework 自己当然会处理事务
- Boot 不过是顺手把一个事务管理器 bean 补上

这个理解方向没错，但过于扁平。

因为真正要让 `@Transactional` 在 Boot 应用里默认成立，至少要协调几件事：

- 当前 classpath 上有没有事务相关核心类
- 当前有没有一个单候选 `DataSource`
- 用户是否已经显式定义了自己的 `TransactionManager`
- 默认事务管理器该围绕哪个资源创建
- 后续事务自定义器怎样继续调整这个默认 manager

也就是说，用户看到的是：

- “写个注解，事务就能用了”

源码层面真实发生的是：

- **Boot 把资源锚点、事务管理器创建、缺失 Bean 条件和后续定制入口组织成了一条默认事务基础设施装配链。**

第一层问题是：**Boot 事务自动配置首先要解决的，不是 `@Transactional` 怎么执行，而是“这个应用到底有没有一条默认事务管理器装配路径”。**

前面 `vol-spring` 已经讲过：

- `@Transactional` 真正依赖的是 `PlatformTransactionManager`
- AOP 拦截器链只负责在调用时去找并使用事务管理器

也就是说，如果没有一个真实可用的事务管理器资源锚点：

- `@Transactional` 的 Framework 主线就没有后端可落

第二层问题是：**Boot 默认事务路径必须围绕已有资源锚点展开，而不能和具体数据库访问资源脱节。**

在最常见的 JDBC 场景里，这个资源锚点就是：

- `DataSource`

所以 Boot 这里真正要判断的不是：

- “能不能随便造一个事务管理器”

而是：

- **围绕哪个单候选资源创建最合理的默认 `PlatformTransactionManager`。**

第三层问题是：**Boot 自动事务装配不仅要默认成立，还要允许用户继续接管或细调 manager。**

真实项目里经常出现：

- 默认事务管理器已经够用了
- 但我还想加一点定制

例如：

- 默认超时
- rollback-on-commit-failure
- 全局行为开关

如果 Boot 的事务自动配置只会“粗暴给一个 manager”，而不提供继续定制和退让边界，那它很快就会从默认便利变成又一个必须重写的黑盒。

因此，本文真正要回答的问题不是“Boot 怎么支持事务”，而是：

**为什么对 Boot 来说，必须先围绕已有资源锚点判断默认事务路径，再通过 `PlatformTransactionManager` 自动装配、缺失 Bean 退让和定制器链把事务基础设施接回 `@Transactional` 的 Framework 主线，整个事务默认体验才能真正成立。**

## 先看失败方案：为什么不能只要 classpath 上有事务包就随便给一个 manager、不能让事务管理器和资源锚点脱节、也不能把定制能力留给用户整套重写

### 失败方案一：只要 classpath 上有事务相关类，就随便创建一个 `PlatformTransactionManager`

这是最容易出现的粗暴想法。

因为从表面看，`@Transactional` 只要最终能找到一个 `PlatformTransactionManager` 就够了。

但真正的问题不是：

- 有没有一个叫事务管理器的 bean

而是：

- 它绑定的是哪个资源
- 它和当前应用实际的数据访问路径是不是一致

如果不围绕真实资源锚点创建 manager，就会出现：

- 注解在
- manager 也在
- 但它和实际 JDBC 操作不是同一资源语义

这会让“事务默认可用”变成危险的假象。

### 失败方案二：JDBC 模板走一个 DataSource，事务管理器随便挑另一个资源

这和前一篇 DataSource / JDBC 自动配置形成了完全对称的失败路径。

如果：

- `JdbcTemplate` 用的是资源 A
- 事务管理器绑定的是资源 B

那用户很可能会看到：

- 代码能启动
- 查询也能执行
- 但 `@Transactional` 的边界和真正 SQL 执行不在同一资源上

所以 Boot 的事务默认路径绝不能和 DataSource 自动配置脱节，而必须围绕：

- 同一个资源锚点继续展开

### 失败方案三：默认 manager 如果不够，就让用户整套自己重写

这会让 Boot 自动配置失去很大一部分价值。

因为很多项目并不是要完全替换事务管理器，而只是想：

- 在默认路径上做一点定制

如果 Boot 不提供这种渐进式能力，用户的唯一选择就会变成：

- 要么完全吃默认
- 要么整套自己声明事务管理器 Bean

这和前面几篇已经建立的装配哲学都相违背。

所以 Boot 在事务域里同样需要：

- **默认成立 + 用户可接管 + 中间可细调。**

## 事务自动配置的最小总图

如果把这条装配链先压缩成最小模型，它可以写成下面这样：

```text
DataSource on classpath and in context
   -> DataSourceTransactionManagerAutoConfiguration
   -> PlatformTransactionManager
   -> TransactionAutoConfiguration hooks @Transactional infrastructure
   -> transactional calls get a real backend manager
```

如果再换一种更适合理解职责的拆法，它可以分成下面五层：

```text
[资源锚点]
DataSource / other transaction resources

   ->

[默认 manager 装配]
DataSourceTransactionManagerAutoConfiguration

   ->

[定制与退让]
ConditionalOnMissingBean + TransactionManagerCustomizers

   ->

[Framework 主线接回]
TransactionAutoConfiguration / @EnableTransactionManagement path

   ->

[默认体验]
@Transactional 在 Boot 应用里真正有后端可用
```

这张图最重要的价值，不是背类名，而是把五个问题分开：

### 一、资源锚点

回答：事务管理器为什么不能脱离真实资源独立存在？

### 二、默认 manager 装配

回答：谁负责围绕 DataSource 创建默认事务管理器？

### 三、定制与退让

回答：为什么 Boot 既要自动创建 manager，又要允许用户覆盖和细调？

### 四、Framework 主线接回

回答：Boot 的 manager 如何接回 `@Transactional` 的 Framework 执行主线？

### 五、默认体验

回答：为什么用户最后感知到的是“注解自然生效了”？

## 一、事务自动配置先判断“这条默认 manager 路径有没有资源锚点可依附”

回到最外层，Boot 事务自动配置不是无条件创建一个 manager。

它首先要判断几个基础事实：

- 当前 classpath 上有没有事务相关核心类
- 当前资源锚点（最常见的是 `DataSource`）是否存在
- 当前是否只有一个合理资源候选
- 用户是否已经自己提供了事务管理器

这说明事务自动配置的第一职责不是“把 `@Transactional` 打开”，而是：

- **判断有没有一条可信的默认 manager 装配路径。**

这也再次说明，Boot 事务自动配置并不替代 Framework 事务主线，它只是先把：

- 那个 Framework 主线要依赖的资源后端

准备好。

## 二、`DataSourceTransactionManagerAutoConfiguration`：围绕 JDBC 资源锚点继续展开的默认 manager 路径

在最常见的 JDBC 场景里，真正关键的自动配置就是：

- `DataSourceTransactionManagerAutoConfiguration`

它的重要性不在于“名字很长”，而在于它明确表达了：

- 事务默认路径不是凭空创建
- 它是围绕 DataSource 这类 JDBC 资源锚点继续展开的

也就是说，Boot 在这里做的不是：

- 任意提供一个 `PlatformTransactionManager`

而是：

- **把 JDBC 世界里的默认事务后端落在 DataSource 资源上。**

这一点和前一篇 DataSource / JDBC 自动配置形成了非常紧密的闭环。

## 三、为什么默认路径常常落成 `JdbcTransactionManager` / `DataSourceTransactionManager`

在很多读者的印象里，Boot JDBC 事务默认管理器常被简单记成：

- `DataSourceTransactionManager`

但当前源码路径里，还存在一个很关键的现实边界：

- 默认创建逻辑会读取 `spring.dao.exceptiontranslation.enabled`
- 该值为 `true` 时返回 `JdbcTransactionManager`
- 否则才返回 `DataSourceTransactionManager`

也就是说，读者不能把这条自动配置机械理解成：

- 永远 new 某一个固定实现

更准确的说法应该是：

- Boot 先围绕 DataSource 建立 JDBC 事务 manager 路径
- 具体落点在当前源码中可能是 `JdbcTransactionManager` 或 `DataSourceTransactionManager`

这一步很重要，因为它能避免把“事务自动配置”讲成死代码模板，而是看成：

- **围绕 JDBC 资源锚点的一条具体实现路径。**

## 四、为什么单候选 DataSource 条件非常关键：这条默认路径不是给多资源歧义场景兜底的

如果当前应用里有多个 DataSource，而 Boot 仍然强行自动创建一个默认事务管理器，就很容易把歧义隐藏起来。

这会让用户误以为：

- 注解已经有默认事务后端

但真实问题却是：

- 到底该绑定哪个 DataSource

所以事务默认路径必须非常克制地要求：

- 当前资源锚点是单候选的

这也是为什么相关自动配置会在：

- `@ConditionalOnSingleCandidate(DataSource.class)`

这条边界上非常谨慎。

也就是说，Boot 在事务域的策略不是：

- 有 DataSource 就随便配一个 manager

而是：

- **只有当默认选择不再含糊时，才继续自动装配。**

## 五、为什么 `TransactionManagerCustomizers` 很重要：用户常常不是要替换，而是要微调

前面已经说过，真实项目里很多需求并不是：

- 我完全不要 Boot 默认事务路径

而是：

- 默认 manager 基本够用
- 但我还想微调一点行为

这时 `TransactionManagerCustomizationAutoConfiguration` 和 `TransactionManagerCustomizers` 这一层就非常关键。

它的价值在于：

- Boot 不要求用户一上来就整套替换 manager
- 而是允许用户在默认装配结果之上做一些精细调整

也就是说，事务自动配置的真实结构不是：

- “要么框架默认，要么用户全重写”

而是：

- **默认 manager 先成立，再通过 customizer 链继续被塑形。**

这和前面 JSON、缓存、连接池那些基础设施篇的设计哲学完全一致。

## 六、为什么 `TransactionAutoConfiguration` 的价值不在“再造一个 manager”，而在“把默认 manager 接回 Framework 事务主线”

只看 `DataSourceTransactionManagerAutoConfiguration`，用户可能会以为事务自动配置的全部任务就是：

- 提供一个事务管理器 Bean

这还不够。

因为真正让 `@Transactional` 运转的，不只是 manager 存在，而是：

- Framework 事务主线已经打开
- 注解驱动的拦截链已经成立
- 默认 manager 能被这一整条链找到和消费

这里还要把 `TransactionAutoConfiguration` 的真实职责说准：它不是再造一个 JDBC manager，而是围绕“已有 transaction manager”补上 Boot 层接线，例如：

- 在存在单候选 `PlatformTransactionManager` 时提供 `TransactionTemplate`
- 在存在 `TransactionManager` 且用户未显式提供 `AbstractTransactionManagementConfiguration` 时，通过 `@EnableTransactionManagement` 打开事务管理主线
- 在响应式路径下，围绕单候选 `ReactiveTransactionManager` 提供 `TransactionalOperator`

也就是说，`TransactionAutoConfiguration` 的价值不在于“再造一个 manager”，而在于：

- **把 Boot 默认 manager 路径和 Framework 的事务执行主线接回去。**

前面 `vol-spring` 讲的是：

- 事务注解如何进入 AOP 链
- 事务拦截器怎样调用 `PlatformTransactionManager`

这一篇补上的则是：

- 那个默认 manager 在 Boot 应用里为什么会自然存在
- Boot 又是怎样把事务模板、注解驱动和默认 manager 放进同一应用上下文语境里

## 七、为什么用户感知到的是“注解自然生效了”，而不是“容器里多了一个 manager bean”

站在源码视角，Boot 这里做了很多层工作：

- DataSource 已经成立
- 单候选条件判断
- manager 自动装配
- customizer 继续调整
- Framework 事务主线接回

但站在用户视角，最后感知到的通常只有一句话：

- `@Transactional` 真的开始工作了

这恰恰说明 Boot 做对了。

因为它并没有让用户暴露在：

- manager 具体实现选择
- 资源单候选判断
- manager 定制器链
- AOP 主线与 manager 绑定细节

而是把这些层协同后压缩成了：

- 一个稳定的默认事务体验

也就是说，Boot 在这里追求的并不是“让用户知道内部有多少层”，而是：

- **让这些层协同后表现成事务注解的自然默认能力。**

## 八、最小源码证据：这条链确实是“资源锚点 -> 默认 manager -> Framework 主线接回”逐层成立

如果只讲到这里，读者仍然可能会觉得：

- 这是不是又把几个事务类名串成了故事
- 源码里有没有直接证据说明 Boot 真在围绕资源锚点装配 manager

先看 `DataSourceTransactionManagerAutoConfiguration` 的关键入口：

```java
@AutoConfiguration(before = TransactionAutoConfiguration.class,
        after = { DataSourceAutoConfiguration.class, TransactionManagerCustomizationAutoConfiguration.class })
@ConditionalOnClass({ DataSource.class, JdbcTemplate.class, TransactionManager.class })
@AutoConfigureOrder(Ordered.LOWEST_PRECEDENCE)
public class DataSourceTransactionManagerAutoConfiguration {

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnSingleCandidate(DataSource.class)
    static class JdbcTransactionManagerConfiguration {

        @Bean
        @ConditionalOnMissingBean(TransactionManager.class)
        DataSourceTransactionManager transactionManager(Environment environment, DataSource dataSource,
                ObjectProvider<TransactionManagerCustomizers> transactionManagerCustomizers) {
```

这段代码至少证明了四件事：

- JDBC 事务 manager 自动配置要建立在 DataSource 自动配置之后
- 它要求单候选 `DataSource`
- 它只会在用户没有自己定义 `TransactionManager` 时继续默认路径
- 它会把 customizer 链继续接进默认 manager 创建过程

再结合 `TransactionAutoConfiguration` 的真实结构：

```java
@AutoConfiguration
@ConditionalOnClass(PlatformTransactionManager.class)
public class TransactionAutoConfiguration {

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnSingleCandidate(PlatformTransactionManager.class)
    public static class TransactionTemplateConfiguration {

        @Bean
        @ConditionalOnMissingBean(TransactionOperations.class)
        public TransactionTemplate transactionTemplate(PlatformTransactionManager transactionManager) {
            return new TransactionTemplate(transactionManager);
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnBean(TransactionManager.class)
    @ConditionalOnMissingBean(AbstractTransactionManagementConfiguration.class)
    public static class EnableTransactionManagementConfiguration {
```

就可以把整条链闭起来：

- 资源锚点先成立
- 默认 manager 按条件装配
- `TransactionAutoConfiguration` 再补上 `TransactionTemplate` 和 `@EnableTransactionManagement` 这类 Boot 层接线
- Framework 事务主线再消费这个 manager
- `@Transactional` 最终拥有真实后端

也就是说，Boot 的事务自动配置真实结构并不是：

- “因为写了注解，所以 Spring 自然会有事务”

而是：

- **先有资源锚点，再有默认事务 manager，再由 Framework 事务主线把它消费掉。**

## 九、为什么这篇适合放在缓存之后，而不是更前面单独抽出来

看到这里，最值得回收的一个问题就是：

- 为什么把事务自动配置放在缓存之后讲，而不是更早？

因为到这里为止，读者已经看过 Boot 在多个基础设施域里的同一种装配哲学：

- DataSource / JDBC：资源锚点 -> 模板设施 -> 事务资源语义
- Redis：连接工厂 -> 模板设施 -> 客户端路径
- Cache：实现路径 -> `CacheManager` -> Framework 缓存主线

现在再看事务篇，读者会更容易意识到：

- Boot 并不是为每个基础设施发明一套全新哲学
- 它是在不断复用同一模式：
  - 先立资源锚点
  - 再让后续设施围绕它展开
  - 再把这批设施接回 Framework 既有抽象主线

所以事务篇放在这里，不是单独跳出一条新链，而是：

- 把同一自动装配哲学迁移到事务基础设施域

## 十、几个最容易错的判断

### 1. 只要类路径里有事务相关包，Boot 就会随便给一个事务管理器

不成立。

还要满足资源锚点存在、单候选资源、用户未自定义 manager 等边界。

### 2. JDBC 事务自动配置永远只会创建 `DataSourceTransactionManager`

不完整。

当前源码路径下，默认 manager 实现选择还可能落到 `JdbcTransactionManager`。

### 3. 有了 `DataSource`，就天然说明事务自动配置一定能成立

不成立。

还要满足单候选 DataSource、类路径条件和缺失用户自定义 `TransactionManager` 等条件。

### 4. 事务自动配置最重要的只是提供一个 manager bean

不完整。

它更深的价值是把默认 manager 路径和 Framework 的 `@Transactional` 主线重新接回去。

### 5. 如果默认事务管理器不够用，用户只能整套自己重写

不成立。

Boot 还提供了 customizer 路径，允许在默认 manager 基础上做渐进式调整。

## 收网：Boot 统一的不是“帮你多造一个事务 bean”，而是“围绕资源锚点把默认事务后端接回 `@Transactional` 主线”

现在可以回到开头的问题：为什么只要用了 JDBC 并加上 `@Transactional`，Boot 往往就会把事务管理器默认接好？

因为真实发生的是一条逐层装配链：

```text
DataSource 成立
   -> DataSourceTransactionManagerAutoConfiguration
   -> 默认 JDBC transaction manager
   -> TransactionAutoConfiguration / Framework 事务主线接回
   -> @Transactional 真正拥有后端
```

所以这篇真正该带走的结论不是“Boot 自动配置了事务”，而是：

**Boot 先围绕单候选资源锚点建立默认事务 manager 路径，再通过缺失 Bean 条件和 customizer 链完成可退让、可微调的 manager 装配，最后把这条路径接回 `@Transactional` 的 Framework 主线；因此，事务默认体验不是注解自己会工作，而是 Boot 为 Framework 事务主线准备好了真实后端。**