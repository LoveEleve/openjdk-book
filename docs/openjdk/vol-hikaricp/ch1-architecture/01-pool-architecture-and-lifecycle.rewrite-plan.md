# HikariCP Ch1-01 连接池核心架构 — 正文写作规划

## 文章定位

- 写作卷：`vol-hikaricp`
- 章节：Ch1 Architecture
- 篇：01 一个连接池为什么会变成一条连接生命史管理链
- 对应主题：`H-1 连接池核心架构`
- 文章类型：主干总入口篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者需要知道 JDBC 连接池的基本目的：避免每次请求都新建/销毁物理连接。
- 读者不需要先懂 HikariCP 内部类，但需要接受“连接池不仅是一个集合，更是连接对象的一整条生命史管理系统”。

### SOFT

- `vol-springboot` 会讲 `DataSourceAutoConfiguration` 如何把 HikariCP 装起来；本卷不重讲 Boot 自动装配，只在需要时说明入口如何接到池内部。
- 后续篇目会再展开 `ConcurrentBag`、借出、归还、驱逐、HouseKeeper、泄漏检测、指标监控等专题。

### NAV

- Ch1-02：获取流程
- Ch1-03：归还与驱逐
- Ch2：ConcurrentBag 无锁并发设计

## 一句话困惑

为什么 HikariCP 看起来只是“配一堆参数，然后拿个 `DataSource.getConnection()`”，但源码里却要围着 `HikariConfig`、`HikariDataSource`、`HikariPool`、HouseKeeper、keepalive、maxLifetime、fastPath` 搭出一整套结构？

## 一句话顿悟

HikariCP 不是“把连接放进一个池子里”这么简单，而是：**把 JDBC 连接从配置、创建、借出、归还、校验、驱逐到退场，组织成一条高性能、可控、可观测的连接生命史。**

## 读者理解路径

1. 从“连接池为什么不是一个 List/Queue”切入。
2. 建立最小总图：`HikariConfig -> HikariDataSource -> HikariPool -> PoolEntry lifecycle`。
3. 解释 `HikariConfig` 为什么不是普通配置类，而是后续一切策略的源头。
4. 解释 `HikariDataSource` 为什么不是薄薄的 DataSource 壳，而是对池的入口与生命周期封装。
5. 解释 `HikariPool` 为什么才是真正的运行时中心。
6. 最后把 HouseKeeper、maxLifetime、keepalive、fail-fast、sealing 等东西都收回“连接生命史管理链”这一个总概念里。

## 失败方案推演

### 失败方案一：连接池就是一个存放 JDBC Connection 的容器

这是最自然的直觉。

因为从外部 API 看，连接池好像就是：
- 里面有一堆连接
- 需要时拿一个
- 用完再放回去

这个理解的问题在于，它只能描述“有个存储容器”，却解释不了：
- 连接什么时候创建
- 配置什么时候被冻结
- 借出前要不要验证
- 用久了什么时候该被淘汰
- 空闲时什么时候该被保活
- 整个池失败时为什么会 fail-fast

也就是说，连接池真正复杂的地方从来不在“放在哪儿”，而在“这一生如何被管理”。

### 失败方案二：`HikariDataSource` 就是 `DataSource` 的一个薄包装

外部使用者接触最多的是 `HikariDataSource`，很容易因此形成一个印象：
- 配置写进去
- DataSource 交给应用
- 池的事情大概都隐藏起来了

这个理解不够。因为在 HikariCP 里，`HikariDataSource` 不是只做转发，它还承担：
- 初始化入口
- 池实例持有
- 生命周期边界
- 运行时访问门面

也就是说，它不是“看起来像 DataSource 的壳”，而是应用与池内部结构之间的入口层。

### 失败方案三：性能优化点是零散技巧，不构成主线

HikariCP 很容易让人被很多“优化小技巧”吸引：
- `fastPathPool`
- `ThreadLocal`
- `AtomicIntegerFieldUpdater`
- `aliveBypassWindow`
- `maxLifetime` 随机抖动

如果把这些都看成离散技巧，就会失去一个更重要的认知：
- 这些技巧不是散落的微优化
- 它们是围绕同一条连接生命史主线做的系统化优化

## 必须澄清的误解

1. 连接池不是“存连接的集合”，而是连接生命史管理系统。
2. `HikariConfig` 不是普通配置类，它定义了池后续的运行策略边界。
3. `HikariDataSource` 不是薄包装，而是应用与池的入口层。
4. `HikariPool` 才是真正的运行时中心。
5. 各种优化点不是碎片，而是在服务同一条连接生命史主线。

## 文章结构与字数预算

1. 困惑开场：为什么连接池不是一个容器（800-1000 字）
2. 最小总图：Config -> DataSource -> Pool -> Connection lifecycle（1200-1500 字）
3. `HikariConfig`：策略源头与边界定义（1400-1800 字）
4. `HikariDataSource`：入口层与生命周期封装（1600-2200 字）
5. `HikariPool`：运行时中心（1800-2400 字）
6. 为什么 HouseKeeper/maxLifetime/keepalive/fail-fast/sealing 都属于同一条主线（1600-2200 字）
7. 收网总结：HikariCP 真正管理的是连接生命史（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `com/zaxxer/hikari/HikariConfig.java`
- `com/zaxxer/hikari/HikariDataSource.java`
- `com/zaxxer/hikari/pool/HikariPool.java`
- 与 fail-fast / sealing / fastPathPool / HouseKeeper / keepalive / maxLifetime 相关的关键方法锚点

## 版本边界

- 当前分析对象：HikariCP `7.0.2`
- 本篇聚焦当前版本主干，不回退到老版本实现差异，除非确有必要说明
- 不混入 Spring Boot 自动装配细节作为主叙事

## 与其他篇的边界

### 本篇要讲清

- HikariCP 的总骨架是什么
- 三个核心类各自负责什么
- 为什么这是一条连接生命史主线

### 本篇不深讲

- ConcurrentBag 细节
- getConnection 完整借出流程
- close()/归还/驱逐细节
- metrics/JMX/leak detection 细节

这些交给后续专题。

## 写作后检查

- [ ] 开篇不是类名介绍，而是“为什么连接池不是容器”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“DataSource 只是壳”的误解
- [ ] 总图明确区分：配置、入口、运行时中心、连接生命史
- [ ] 不把优化点写成碎片技巧清单
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
