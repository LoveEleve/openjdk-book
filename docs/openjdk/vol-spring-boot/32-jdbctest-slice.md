# 为什么 `@JdbcTest` 不启动完整应用，却能让 JDBC 测试天然拥有数据源和回滚边界

> 本文基于 Spring Boot 3.5.x、Spring Framework 6.2.x 与本机可用相关源码。本文承接 `@JsonTest` 测试切片，进入与 JDBC/MyBatis 场景更相关的 `@JdbcTest`。重点放在 `JdbcTestContextBootstrapper`、`JdbcTypeExcludeFilter`、JDBC 自动配置导入、嵌入式数据库替换、事务回滚和 `JdbcTemplate` 测试设施。本文不重复 `vol-spring` 中 JDBC Template 与事务执行原理，而聚焦 Boot 如何把数据库测试裁剪成一条窄而自洽的测试装配路径。

## 为什么一个 JDBC 测试不需要启动 Web、Redis 和完整业务层，却仍然能直接拿到 DataSource 和 JdbcTemplate

一个典型 JDBC 测试通常只关心：

- SQL 是否正确
- RowMapper 是否正确
- DAO 是否正确
- 事务边界是否正确
- 查询结果和参数绑定是否正确

它通常不需要：

- Servlet 容器
- Controller
- Redis
- Cache
- 消息系统
- 完整业务服务层

如果所有测试都使用 `@SpringBootTest`，测试就会背上大量无关成本。

而 `@JdbcTest` 的使用体验是：

```java
@JdbcTest
class OrderRepositoryTest {
}
```

`@JdbcTest` 的元注解本身就包含：

- `@OverrideAutoConfiguration(enabled = false)`
- `@TypeExcludeFilters(JdbcTypeExcludeFilter.class)`
- `@Transactional`
- `@AutoConfigureJdbc`
- `@AutoConfigureTestDatabase`
- `@ImportAutoConfiguration`

应用上下文里却通常已经有：

- `DataSource`
- `JdbcTemplate`
- JDBC 相关自动配置
- 测试事务与回滚边界

这不是简单“少启动几个 Bean”，而是：

- **Boot 从测试入口开始选择 JDBC 专属装配路径，只恢复数据库访问所需的自动配置，并把测试事务接进上下文生命周期。**

## 先看失败方案：为什么不能用完整应用测试、不能只手工 new JdbcTemplate、也不能只替换数据库而忽略事务边界

### 失败方案一：所有 JDBC 测试都启动完整应用

这会让一个 SQL 测试受到：

- Web 配置
- Redis 配置
- Cache 配置
- 外部客户端
- 业务 Bean

的干扰。

测试失败时也很难判断到底是：

- SQL 错了
- DataSource 配错
- 其他自动配置启动失败

### 失败方案二：测试里手工 new DataSource 和 JdbcTemplate

这样虽然能执行 SQL，但测试和生产装配路径可能不一致：

- 连接池配置不同
- 转换器不同
- Boot 的初始化配置没有参与
- 测试事务没有接入 Spring TestContext

所以 JDBC 切片应该尽量复用 Boot 的数据库基础设施自动配置，而不是把它完全搬到测试代码里。

### 失败方案三：只替换成嵌入式数据库，不建立事务回滚边界

如果每个测试方法都直接写入数据库，而没有事务回滚：

- 测试之间会互相污染
- 执行顺序会影响结果
- 清理逻辑会散落到测试代码

因此 `@JdbcTest` 的关键不只是“给一个 H2”，还包括：

- **把测试方法放进可回滚事务语义。**

## `@JdbcTest` 的最小总图

```text
@JdbcTest
   -> JdbcTestContextBootstrapper
   -> disable full auto-configuration
   -> JdbcTypeExcludeFilter
   -> import JDBC auto-configuration
   -> optional embedded database replacement
   -> test transaction and rollback
   -> focused JDBC test context
```

```text
[测试入口]
@JdbcTest

   ->

[测试启动器]
JdbcTestContextBootstrapper

   ->

[组件裁剪]
JdbcTypeExcludeFilter

   ->

[JDBC 自动配置]
DataSource / JdbcTemplate / transaction infrastructure

   ->

[数据库策略]
embedded replacement or configured DataSource

   ->

[测试生命周期]
transaction rollback after test
```

## 一、`@JdbcTest` 首先改变的是测试上下文 bootstrapper

和 `@WebMvcTest`、`@JsonTest` 一样，`@JdbcTest` 不是普通配置注解。

它会使用专用的：

- `JdbcTestContextBootstrapper`

这意味着 JDBC 测试从 TestContext 构建阶段就进入专用路径，而不是先启动完整应用，再尝试删除无关 Bean。

切片越早建立边界，越能避免：

- Web 自动配置
- 业务组件扫描
- Redis / Cache 等无关基础设施

进入测试上下文。

## 二、为什么 JDBC 切片需要关闭全量自动配置，再精确导入数据访问能力

`@JdbcTest` 的设计不是：

- 让所有自动配置照常运行
- 然后依赖测试代码不去使用无关 Bean

而是先关闭全量自动配置，再通过 `@AutoConfigureJdbc`、`@AutoConfigureTestDatabase` 与 `@ImportAutoConfiguration` 恢复 JDBC 测试真正需要的路径：

- DataSource 自动配置
- JdbcTemplate 自动配置
- 事务相关自动配置
- SQL 初始化等必要能力

这样做的价值是：

- 测试启动更快
- 外部依赖更少
- 测试边界更清晰
- 数据库访问路径仍然尽量接近生产 Boot 装配

## 三、`JdbcTypeExcludeFilter`：数据库切片真正裁剪的是组件扫描范围

JDBC 测试并不需要扫描整个业务应用。

它更关注：

- JDBC 相关组件
- Repository 或 DAO 相关类型
- `JdbcTemplate` 依赖的必要配置
- 用户显式导入的测试配置

而 Controller、Web handler、业务服务、消息消费者等组件通常不属于 JDBC 切片默认范围。

因此 `JdbcTypeExcludeFilter` 的作用不是简单“排除 Web”，而是：

- **为 JDBC 数据访问验证建立组件白名单和自动配置边界。**

## 四、为什么嵌入式数据库替换是测试便利，而不是 JDBC 切片的全部语义

很多 JDBC 切片测试会默认使用嵌入式数据库，因为它：

- 启动快
- 无需外部服务
- 适合测试隔离

但这不等于 `@JdbcTest` 永远只能使用嵌入式数据库。

测试还可能通过：

- 显式 DataSource
- `@AutoConfigureTestDatabase(replace = NONE)`
- 测试属性
- Testcontainers / 外部数据库

切换数据库策略。

所以嵌入式数据库更准确的定位是：

- **Boot 为 JDBC 测试提供的默认替换策略之一。**

而不是：

- `@JdbcTest` 的唯一数据库模型。

## 五、为什么测试事务和回滚是 `@JdbcTest` 的核心体验

JDBC 测试经常会执行写操作：

- insert
- update
- delete

如果这些操作不自动回滚，测试之间很容易污染。

`@JdbcTest` 通过元注解直接声明了 `@Transactional`，再由 Spring TestContext 的事务测试监听器负责测试方法级事务生命周期；默认测试事务通常会在测试完成后回滚。

这意味着测试可以：

- 在方法内写入数据
- 断言查询结果
- 测试结束后由框架清理状态

因此，测试事务不是一个附加便利，而是：

- **JDBC 切片保持可重复执行和隔离性的核心机制。**

## 六、为什么 `@JdbcTest` 仍然保留 Boot 的 DataSource / JdbcTemplate 装配语义

如果 JDBC 切片完全手工创建 DataSource 和 JdbcTemplate，测试可能会偏离生产：

- 生产使用 Hikari，测试使用完全不同对象
- 生产属性绑定和测试属性绑定不一致
- 生产事务管理器和测试事务管理器行为不同

因此 `@JdbcTest` 的合理目标不是：

- 模拟一个完全简化的 JDBC 世界

而是：

- **裁掉无关应用能力，但尽量保留 JDBC 基础设施的 Boot 装配语义。**

这样测试验证的是：

- 在 Boot 默认 JDBC 装配下，DAO / SQL 是否正确

而不是只验证：

- 手工 new 的 JdbcTemplate 能否执行 SQL。

## 七、最小源码证据：`@JdbcTest` 确实是专用 bootstrapper、过滤器、自动配置与数据库替换的协作链

`@JdbcTest` 的源码结构可以概括为：

```java
@BootstrapWith(JdbcTestContextBootstrapper.class)
@OverrideAutoConfiguration(enabled = false)
@TypeExcludeFilters(JdbcTypeExcludeFilter.class)
@Transactional
@AutoConfigureCache
@AutoConfigureJdbc
@AutoConfigureTestDatabase
@ImportAutoConfiguration
public @interface JdbcTest {
}
```

来源：`spring-boot-test-autoconfigure/src/main/java/org/springframework/boot/test/autoconfigure/jdbc/JdbcTest.java:69-82`。

`@AutoConfigureTestDatabase` 默认使用 `Replace.NON_TEST`，并允许 `ANY`、`AUTO_CONFIGURED`、`NONE` 等替换策略；因此“默认嵌入式数据库”需要结合实际 classpath、DataSource 类型和替换策略理解，不能写成无条件保证。

这证明：

- JDBC 测试从 bootstrap 阶段就切换路径
- 全量自动配置被关闭
- `JdbcTypeExcludeFilter` 负责组件边界
- `AutoConfigureTestDatabase` 负责默认数据库替换策略
- JDBC 相关自动配置由 `ImportAutoConfiguration` 精确恢复

再结合 Spring TestContext 的事务监听器，可以把完整链路闭起来：

- JDBC 基础设施进入上下文
- 数据库策略被确定
- 测试方法获得事务边界
- 测试结束后回滚数据库变更

## 八、为什么 `@JdbcTest` 不等于 `@DataJpaTest`

两者都属于数据访问切片，但验证目标不同。

### `@JdbcTest`

更关注：

- `JdbcTemplate`
- SQL
- RowMapper
- JDBC DAO
- 数据源与事务基础设施

### `@DataJpaTest`

更关注：

- Entity
- EntityManager
- JPA repository
- Hibernate 映射
- JPA 查询

如果项目使用 MyBatis、MyBatis-Plus 或直接 JDBC，`@JdbcTest` 的思路通常比 `@DataJpaTest` 更接近真实验证目标；但 MyBatis-Plus 自己仍可能需要额外测试配置和切片集成。

## 九、几个最容易错的判断

### 1. `@JdbcTest` 就是启动一个 H2 数据库

不完整。

它还负责 JDBC 自动配置裁剪、DataSource / JdbcTemplate 装配与测试事务边界。

### 2. `@JdbcTest` 永远只能使用嵌入式数据库

不成立。

可以通过测试数据库替换策略、显式 DataSource 或外部测试基础设施改变路径。

### 3. JDBC 测试里手工 new JdbcTemplate 就和 `@JdbcTest` 一样

不成立。

手工对象可能绕开 Boot 的配置绑定、连接池、事务和自动配置语义。

### 4. 测试方法执行完后数据库一定保留变更

通常不应这样假设。

JDBC 切片的典型设计是通过测试事务支持在测试结束后回滚；具体行为仍取决于测试事务配置与测试写法。

### 5. `@JdbcTest` 和 `@DataJpaTest` 只是名字不同

不成立。

两者对应不同数据访问抽象和不同测试目标。

## 收网：`@JdbcTest` 统一的不是“替你起一个内存数据库”，而是“按 JDBC 验证目标重建一条带事务隔离的窄数据访问装配路径”

现在可以回到开头的问题：为什么 `@JdbcTest` 不启动完整应用，却能让 JDBC 测试天然拥有 DataSource 和回滚边界？

因为真实发生的是一条切片装配链：

```text
@JdbcTest
   -> JdbcTestContextBootstrapper
   -> disable full auto-configuration
   -> JdbcTypeExcludeFilter
   -> import JDBC auto-configuration
   -> embedded/external database strategy
   -> test transaction rollback
   -> focused JDBC test context
```

所以这篇真正该带走的结论不是“`@JdbcTest` 自带 H2”，而是：

**Boot 通过专用 bootstrapper、JDBC 类型过滤器、受控自动配置、数据库替换策略和测试事务回滚，共同重建了一条只面向 JDBC 验证目标的窄数据访问路径；因此，`@JdbcTest` 的核心不是内存数据库，而是让 SQL/DAO 测试在接近 Boot JDBC 装配语义的同时保持隔离、快速和可重复。**