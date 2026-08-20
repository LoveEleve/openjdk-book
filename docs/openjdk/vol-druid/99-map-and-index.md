# Druid 卷总图 / 总索引

## 一、池本体主图

```text
DruidDataSource.init()
  -> connections[maxActive]
    -> getConnectionInternal()
      -> 借出前/空闲时验证
        -> DruidPooledConnection
          -> JDBC 操作穿过 FilterChain
            -> recycle()
              -> testOnReturn
                -> connections[]
                  -> DestroyTask -> shrink()
```

对应正文：

- 初始化、数组与借出：`D-1`
- 维护扫描、驱逐、keep-alive、补连接：`D-5`
- 借出/空闲/归还验证：`D-7`
- Filter 链及连接关闭：`D-2`
- PreparedStatement 连接内复用：`D-8`

## 二、SQL 扩展主图

```text
JDBC 操作
  -> FilterChainImpl
    -> StatFilter -> executeBefore/After -> 参数化 -> 统计
    -> WallFilter -> WallProvider.check()
      -> Parser -> AST -> WallCheckVisitor -> violations
```

对应正文：

- Filter 链骨架：`D-2`
- SQL 监控：`D-3`
- SQL 安全：`D-4`
- Parser、AST、Visitor、dialect：`D-6`

## 三、Boot 装配桥

```text
spring.datasource.type
  -> DruidDataSourceAutoConfigure
    -> DruidDataSourceWrapper
      -> @ConfigurationProperties
        -> afterPropertiesSet()
          -> init()

Web application + enabled=true
  -> StatViewServletRegistrationBean
  -> WebStatFilterRegistrationBean
```

对应正文：`D-9`。自动装配并非只由 `@ConditionalOnClass` 决定，还受 DataSource 类型、自动装配顺序、缺失 Bean 和 Web/属性条件共同约束。

## 四、推荐阅读顺序

`D-1 → D-5 → D-7 → D-2 → D-8 → D-3 → D-4 → D-6 → D-9`

这是按规划的 A/B/C/D/E 五层排列，不是对物理目录的重命名。

## 五、按问题查找

| 问题 | 先读 |
|---|---|
| Druid 池为什么不是普通容器 | `D-1` |
| 空闲连接、坏连接、泄漏连接如何处理 | `D-5`、`D-7` |
| JDBC 操作如何被拦截 | `D-2` |
| SQL 如何统计和合并 | `D-3` |
| SQL 注入如何按结构检查 | `D-4`、`D-6` |
| PreparedStatement 为什么不能全局复用 | `D-8` |
| Spring Boot 如何创建并初始化 Druid | `D-9`、`D-1` |

## 六、对照 HikariCP

- HikariCP 重点是连接生命史、`ConcurrentBag`、HouseKeeper、诊断与可观测。
- Druid 重点是固定数组 + Lock/Condition、维护扫描、Filter 链、SQL 解析/统计/安全和 Boot 装配。
- 两卷共享“连接不是静态容器，而是生命周期系统”的抽象，但不应把一个项目的并发或验证实现套到另一个项目。