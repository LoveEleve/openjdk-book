# 为什么只配置几个 `spring.datasource.*` 属性，Boot 就能把连接池、`DataSource` 和 JDBC 基础设施一起装起来

> 本文基于 Spring Boot 3.5.x 与 Spring Framework 6.2.x 当前源码。本文承接前面 Web 与消息转换主线，进入第一个核心数据访问自动配置域：DataSource / JDBC。重点放在 `DataSourceAutoConfiguration`、`DataSourceProperties`、连接池选择、嵌入式数据库分支、`JdbcTemplateAutoConfiguration` 与事务管理器自动配置之间的协作关系。本文不重复 `vol-spring` 中 JDBC API、事务拦截器和 `DataSource` 抽象原理，而聚焦 Boot 如何把这些 Framework 能力装配成默认可用的数据访问环境。下一篇将进入 Redis 自动配置。

## 为什么只写几个属性，Boot 就知道该用哪个连接池、怎么创建 DataSource、还要不要顺手配 JdbcTemplate

一个典型的 Boot JDBC 应用，配置可能只有这样几行：

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/demo
    username: app
    password: secret
```

然后应用里就可以直接注入：

- `DataSource`
- `JdbcTemplate`
- `NamedParameterJdbcTemplate`
- 事务管理器

这件事看起来像是：

- Boot 读了几个属性
- 然后顺手 new 了几个对象

但如果把这条链真正拆开，里面至少包含几个需要协调的决策：

- 当前 classpath 上有哪些 JDBC 驱动
- 当前是否已经有用户自己的 `DataSource`
- 应该选 HikariCP、Dbcp2 还是 Oracle UCP
- URL、用户名、密码怎样绑定成类型安全配置对象
- 没有外部数据库时，是否可以走嵌入式数据库分支
- `JdbcTemplate` 是否应该跟着已有 `DataSource` 自动创建
- 事务管理器是否应该继续围绕同一个数据源装配

也就是说，用户看到的是：

- “配置几个属性，数据库就能用了”

源码层面真实发生的是：

- **Boot 把外部配置、类路径事实、连接池实现、DataSource 创建、JDBC 模板和事务基础设施组织成了一条有条件的默认装配链。**

第一层问题是：**DataSource 自动配置首先要解决的不是“new 哪个连接池”，而是“当前应用有没有资格进入 JDBC 数据源装配路径”。**

如果没有 JDBC API 或相关必要类，Boot 不应该继续展开数据源配置。

如果用户已经自己定义了 `DataSource`，Boot 默认配置也不应该强行再创建一个。

所以数据源自动配置从一开始就同时依赖：

- 类路径条件
- 用户 Bean 条件
- 配置属性
- 连接池实现条件

第二层问题是：**连接池选择不是业务代码应该承担的决策，而是 Boot 根据 classpath、显式类型属性和具体配置分支做出的默认装配决策。**

用户通常只关心：

- 连接池参数怎么配
- 数据库连接是否可用

而不希望每个项目都重复判断：

- Hikari 是否存在
- Dbcp2 是否存在
- 哪种实现优先
- 如何把统一 properties 转成具体连接池对象

这正是 Boot 自动配置层应该收口的地方。

第三层问题是：**`DataSource` 出现以后，`JdbcTemplate` 和事务管理器是否自动出现，并不是两个互不相关的便利功能，而是围绕同一个数据源继续展开的后续装配链。**

如果 `JdbcTemplate` 使用了另一个数据源，或者事务管理器没有绑定到应用真正使用的连接池，默认体验就会变成隐患。

所以 Boot 需要保证：

- DataSource 是后续 JDBC 基础设施的共同依赖
- `JdbcTemplate` 和事务管理器尽量围绕同一个数据源协同装配

因此，本文真正要回答的问题不是“Boot 怎么自动配数据库”，而是：

**为什么对 Boot 来说，DataSource 自动配置必须先根据应用事实选择数据源与连接池，再让 `JdbcTemplate`、命名参数模板和事务管理器围绕同一数据源继续展开，才能形成一套默认可用且允许用户接管的 JDBC 运行环境。**

## 先看失败方案：为什么不能只读属性、不能把 Hikari 写死、也不能让 JDBC 基础设施各自选择数据源

### 失败方案一：读取 `spring.datasource.url` 后直接 new 一个 DataSource

这是最容易想到的做法。

因为从最小场景看，好像只需要：

- 读 url
- 读 username
- 读 password
- 创建数据源

但真实配置远不止这几个字段：

- 驱动类名
- 连接池类型
- 连接超时
- 初始化大小
- 最大连接数
- 验证查询
- 数据源名称
- 特定连接池属性

如果每个自动配置都自己从 Environment 逐个取字符串，配置绑定、类型转换、默认值和校验都会重新散落。

所以 Boot 首先需要一个结构化配置对象，而不是在自动配置方法里手工拼接属性。

### 失败方案二：Boot 永远写死使用 HikariCP

HikariCP 是 Boot 默认路径里最常见的连接池，但“默认常见”不等于“框架只能支持这一种”。

如果把 Hikari 写死，Boot 会失去：

- Dbcp2 支持
- Oracle UCP 支持
- 用户按 classpath 和依赖选择实现的能力

更重要的是，Boot 的自动配置模型本来就是：

- 根据类路径事实选择候选
- 默认优先常见实现
- 允许用户通过依赖和配置改变路径

所以连接池选择必须被放在条件装配层，而不是硬编码在业务入口里。

### 失败方案三：`JdbcTemplate`、事务管理器各自随便找一个 DataSource

这会造成非常隐蔽的问题：

- 查询走数据源 A
- 事务管理器绑定数据源 B
- 代码看起来都能启动
- 但事务边界和实际 SQL 执行不在同一资源上

因此，Boot 的 JDBC 自动配置不能把这些设施当成互不相干的 Bean，而应把 `DataSource` 作为共同装配锚点。

## DataSource / JDBC 自动配置的最小总图

如果把这条装配链先压缩成最小模型，它可以写成下面这样：

```text
JDBC driver / pool on classpath
   -> DataSourceProperties binding
   -> DataSourceAutoConfiguration
   -> Hikari/Dbcp2/UCP DataSource
   -> JdbcTemplateAutoConfiguration
   -> DataSourceTransactionManagerAutoConfiguration
```

如果再换一种更适合理解职责的拆法，它可以分成下面六层：

```text
[类路径前提]
JDBC API + driver + pool implementation

   ->

[配置对象]
DataSourceProperties

   ->

[数据源选择]
DataSourceAutoConfiguration

   ->

[连接池落地]
Hikari / Dbcp2 / Oracle UCP

   ->

[JDBC 访问设施]
JdbcTemplate / NamedParameterJdbcTemplate

   ->

[事务设施]
DataSourceTransactionManager
```

这张图最重要的价值，不是背配置类名，而是把六个问题分开：

### 一、类路径前提

回答：为什么当前应用具备进入 JDBC 自动配置的基础？

### 二、配置对象

回答：`spring.datasource.*` 怎样变成一个可消费的强类型对象？

### 三、数据源选择

回答：谁根据条件判断是否创建默认 DataSource？

### 四、连接池落地

回答：为什么默认常常是 Hikari，但又不是只能 Hikari？

### 五、JDBC 访问设施

回答：为什么 DataSource 出现后，`JdbcTemplate` 能自动跟上？

### 六、事务设施

回答：事务管理器怎样围绕同一个 DataSource 继续装配？

## 一、DataSource 自动配置先判断“这是不是一条可以进入 JDBC 世界的路径”

回到最外层，`DataSourceAutoConfiguration` 并不是无条件创建数据源。

它首先要确认几个基础事实：

- JDBC 相关类是否存在
- 是否已经有用户自己的 `DataSource` 或 `XADataSource`
- 是否存在 R2DBC `ConnectionFactory`，从而决定是否避开这条 JDBC 默认路径
- 是否应进入嵌入式数据库或 pooled DataSource 分支

这说明 DataSource 自动配置的第一职责不是“选择 Hikari”，而是：

- **决定当前应用是否应该进入默认数据源装配路径。**

这和前面条件体系篇完全一致：

- starter 提供 classpath 前提
- 条件系统读取当前事实
- 自动配置决定命中还是退让

## 二、`DataSourceProperties`：先把外部数据源配置收口成类型安全对象

前面 `@ConfigurationProperties` 篇已经讲过，Boot 不喜欢在自动配置方法里到处写：

- `environment.getProperty("spring.datasource.url")`
- `environment.getProperty("spring.datasource.username")`

数据源自动配置正是这套设计的典型消费者。

`DataSourceProperties` 负责承载：

- url
- username
- password
- driverClassName
- name
- type
- 初始化相关属性

也就是说，Boot 先把：

- `spring.datasource.*`

绑定成：

- 一个结构化 properties 对象

后面的连接池选择和数据源创建才有稳定输入。

这一步特别重要，因为它把：

- 外部配置读取
- 类型转换
- 默认值
- 驱动推断

从具体连接池创建逻辑里分离出来了。

## 三、为什么默认常常是 HikariCP：不是硬编码偏好，而是条件排序后的默认路径

在最常见的 Boot JDBC 应用里，最终看到的 DataSource 往往是：

- `HikariDataSource`

这并不意味着 Boot 的 DataSource 抽象只支持 Hikari。

更准确地说，Boot 会先通过 `DataSourceBuilder.findType(...)` 找到可用的数据源类型，再由具体配置分支上的条件决定哪条路径成立：

- HikariCP
- Dbcp2
- Oracle UCP
- 以及显式指定的其它类型

具体分支还会结合 `@ConditionalOnClass`、`@ConditionalOnMissingBean` 和 `spring.datasource.type` 判断。例如当前 Hikari 分支在 Hikari 类存在、没有用户 DataSource 且 `spring.datasource.type` 未指定或明确为 Hikari 时才匹配。

Hikari 之所以常成为默认路径，首先是因为默认依赖组合通常带入它，并且具体分支把它作为缺省类型处理；这比笼统说“Boot 内部偏好 Hikari”更准确。

但这仍然属于：

- **默认条件路径**

而不是无法替换的硬编码事实。

## 四、为什么 DataSource 创建必须通过统一 properties 对象，而不是每个连接池自己重新读配置

如果 Hikari、Dbcp2、UCP 各自直接读取 Environment，会出现三个问题：

- 每个实现重复解析同一组 `spring.datasource.*`
- 不同连接池对默认值和转换的处理容易分叉
- 用户切换连接池时，配置语义会变得不稳定

Boot 更合理的做法是：

- 先由 `DataSourceProperties` 统一承载公共配置
- 再由具体连接池分支把公共配置应用到自己的 DataSource 类型

也就是说：

- 公共配置语义在 properties 层统一
- 连接池专有参数在具体实现层扩展

这让 Boot 可以同时做到：

- 切换连接池不必重写所有公共配置
- 各连接池仍然可以保留自己的专属调优项

## 五、为什么 `JdbcTemplate` 是 DataSource 自动配置之后的自然延伸

只要 DataSource 已经作为默认基础设施成立，接下来最自然的一个问题就是：

- 为什么还要让用户自己 new `JdbcTemplate`

`JdbcTemplate` 的核心依赖非常明确：

- 一个可用的 `DataSource`

所以 `JdbcTemplateAutoConfiguration` 可以把 DataSource 当成前置条件：

- 有 DataSource 才继续
- 用户没有自己定义 JdbcTemplate 才提供默认实现

这体现了 Boot 自动配置的一种典型层级结构：

```text
DataSource
   -> JdbcTemplate
   -> NamedParameterJdbcTemplate
```

也就是说，Boot 不是把所有 Bean 平铺出来，而是：

- **围绕基础设施锚点逐层展开后续默认能力。**

## 六、为什么事务管理器必须和 DataSource 保持同一资源语义

JDBC 应用里最危险的错误之一，不是没有事务管理器，而是：

- 事务管理器和实际执行 SQL 的 DataSource 不是同一个资源

Boot 的事务自动配置正是在解决这类默认装配问题。

当 DataSource 已经成立后，`DataSourceTransactionManagerAutoConfiguration` 可以围绕它创建对应的：

- `DataSourceTransactionManager`

在默认单数据源场景下：

- `JdbcTemplate` 使用这个 DataSource
- 自动创建的事务管理器也绑定这个 DataSource
- `@Transactional` 才能和实际 JDBC 操作落在同一资源语义上

但这不是对所有多数据源应用的绝对保证；一旦存在多个 DataSource，Boot 会要求单候选条件成立，或者由用户显式提供事务管理器与相应的资源绑定。

前面 `vol-spring` 已经讲过 `@Transactional` 的 AOP 链路；Boot 这一篇补的是：

- **那个事务管理器默认从哪里来，以及它为什么和 DataSource 成套出现。**

## 七、嵌入式数据库为什么是另一条分支，而不是外部数据库配置的简化版

Boot JDBC 自动配置还必须面对一种特殊情况：

- 用户没有提供外部 JDBC URL
- 但 classpath 上有 H2、HSQL 或 Derby 这类嵌入式数据库

这时 Boot 可以走嵌入式数据库分支，推断并创建一个嵌入式 DataSource。

这和外部数据库路径的区别在于：

- 外部路径通常依赖用户提供 URL 或可推断的驱动信息
- 嵌入式路径可以根据 classpath 上的数据库实现建立默认连接配置

也就是说，Boot 的 DataSource 自动配置不只是：

- “读取外部 URL 再创建连接池”

它还包含：

- **在特定类路径事实下，为开发和测试提供嵌入式数据库默认路径。**

## 八、最小源码证据：DataSource、JdbcTemplate 和事务管理器确实是逐层自动配置

如果只讲概念，读者仍然可能会觉得：

- 这是不是把几个常见类名串成了故事
- 源码里有没有直接证据说明它们按依赖链逐层装配

先看 `DataSourceAutoConfiguration` 的入口条件：

```java
@AutoConfiguration(before = SqlInitializationAutoConfiguration.class)
@ConditionalOnClass({ DataSource.class, EmbeddedDatabaseType.class })
@ConditionalOnMissingBean(type = "io.r2dbc.spi.ConnectionFactory")
@EnableConfigurationProperties(DataSourceProperties.class)
@Import({ DataSourcePoolMetadataProvidersConfiguration.class,
        DataSourceCheckpointRestoreConfiguration.class })
public class DataSourceAutoConfiguration {

    @Configuration(proxyBeanMethods = false)
    @Conditional(EmbeddedDatabaseCondition.class)
    @ConditionalOnMissingBean({ DataSource.class, XADataSource.class })
    @Import(EmbeddedDataSourceConfiguration.class)
    static class EmbeddedDatabaseConfiguration {
    }

    @Configuration(proxyBeanMethods = false)
    @Conditional(PooledDataSourceCondition.class)
    @ConditionalOnMissingBean({ DataSource.class, XADataSource.class })
    @Import({ DataSourceConfiguration.Hikari.class, DataSourceConfiguration.Dbcp2.class,
            DataSourceConfiguration.OracleUcp.class, DataSourceConfiguration.Generic.class })
    static class PooledDataSourceConfiguration {
    }
```

这段代码证明了第一层事实：

- 数据源自动配置依赖 JDBC 相关类路径事实
- 它会把 `DataSourceProperties` 接入配置绑定体系
- 它把嵌入式数据库与 pooled DataSource 拆成两个内部配置分支
- 两个分支都会在存在用户 `DataSource` 或 `XADataSource` 时退让
- 它还明确规定了存在 R2DBC `ConnectionFactory` 时不进入这条 JDBC 默认 DataSource 路径

这里的语义不是“JDBC 与 R2DBC 永远不能共存”，而是“这个 JDBC 默认自动配置在检测到 R2DBC 连接工厂时主动退让”。

再看 `JdbcTemplateAutoConfiguration` 的典型入口：

```java
@AutoConfiguration(after = DataSourceAutoConfiguration.class)
@ConditionalOnClass({ JdbcTemplate.class, Transactional.class })
@ConditionalOnSingleCandidate(DataSource.class)
@EnableConfigurationProperties(JdbcProperties.class)
@Import({ DatabaseInitializationDependencyConfigurer.class,
        JdbcTemplateConfiguration.class })
public class JdbcTemplateAutoConfiguration {
```

最后看事务管理器自动配置的核心条件：

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

这些入口共同证明：

- DataSource 是 JDBC 默认设施的基础锚点
- `JdbcTemplate` 在 DataSource 成立后再按单候选条件继续装配
- 事务管理器自动配置也依赖单候选 DataSource 与“没有用户自定义 TransactionManager”这两个边界
- 当前默认事务管理器实现路径甚至可能是 `JdbcTransactionManager`，并不只是抽象地“new 一个 DataSourceTransactionManager`”

也就是说，Boot 的真实结构不是：

- “几个数据库 Bean 一起随机出现”

而是：

- **先有 DataSource，再按条件向 JdbcTemplate 和事务基础设施逐层展开。**

## 九、为什么这篇必须放在 Web 与消息转换之后，而不是直接先讲数据库

看到这里，最值得回收的一个问题就是：

- 为什么要先讲 Web、容器、DispatcherServlet 和消息转换，再讲 DataSource？

因为这能让读者看清 Boot 自动配置的两种典型落地形态：

### Web 侧

- starter 提供 Web 依赖
- 条件判断应用类型
- 容器、DispatcherServlet、MVC、消息转换器协同装配

### 数据侧

- starter 提供 JDBC/连接池/驱动依赖
- 条件判断 DataSource 路径
- DataSource、JdbcTemplate、事务管理器逐层装配

两条链的基础设施不同，但装配哲学相同：

- 类路径事实先成立
- properties 对象承载配置
- 条件系统决定命中或退让
- 后续基础设施围绕前置锚点展开

所以 DataSource 篇不是突然切换到另一套世界，而是把 Boot 自动装配模式迁移到数据访问领域。

## 十、几个最容易错的判断

### 1. Boot 配了 `spring.datasource.url`，就一定会创建 DataSource

不成立。

还要满足 JDBC 类路径、连接池或嵌入式数据库条件，并且用户没有提供冲突的 DataSource。

### 2. Boot 默认只支持 HikariCP

不成立。

Hikari 常是默认路径，但 Boot 同时保留 Dbcp2、Oracle UCP 等连接池配置分支。

### 3. `DataSourceProperties` 就是连接池本身

不成立。

它是外部数据源配置的强类型载体，真正的连接池 DataSource 由具体连接池配置类创建。

### 4. `JdbcTemplate` 和事务管理器可以各自随便选 DataSource

不成立。

它们应围绕同一个 DataSource 资源语义展开，否则事务和 SQL 执行可能不在同一资源上。

### 5. 有了 DataSource，就必然有 JdbcTemplate

不完整。

`JdbcTemplate` 还会受类路径、单候选 DataSource、用户自定义 Bean 等条件约束。

### 6. Boot 的 DataSource 自动配置只是替你读几个字符串

不成立。

它还负责连接池选择、嵌入式数据库分支、模板设施、事务设施和默认退让边界。

## 收网：Boot 统一的不是“替你 new 一个连接池”，而是“围绕 DataSource 建立一条可配置、可替换、可继续展开的 JDBC 基础设施链”

现在可以回到开头的问题：为什么只配置几个 `spring.datasource.*` 属性，Boot 就能把连接池、`DataSource` 和 JDBC 基础设施一起装起来？

因为真实发生的是一条逐层装配链：

```text
JDBC driver / pool / embedded database
   -> DataSourceProperties
   -> DataSourceAutoConfiguration
   -> concrete DataSource / connection pool
   -> JdbcTemplate / NamedParameterJdbcTemplate
   -> DataSourceTransactionManager
```

所以这篇真正该带走的结论不是“Boot 会自动配置数据库”，而是：

**Boot 先把外部数据源配置绑定成 `DataSourceProperties`，再根据类路径和用户定义选择具体连接池与 DataSource，最后让 `JdbcTemplate` 和事务管理器围绕同一个数据源逐层展开；因此，数据库默认体验不是几个 Bean 的偶然组合，而是一条有条件、有资源一致性约束的 JDBC 自动配置链。**

下一篇进入 Redis 自动配置：既然 DataSource 已经展示了“基础设施锚点 -> 后续客户端与事务能力”的装配模式，那 Boot 又是怎样在 Lettuce/Jedis、同步/响应式和 RedisTemplate 之间做同样的条件选择与默认装配。