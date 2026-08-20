# HikariCP Ch1-01 连接池核心架构 — review notes

## 第一轮：事实审

### 目标
核对：
- `HikariConfig`、`HikariDataSource`、`HikariPool` 的角色归属是否准确
- `file:line` 引用是否真实存在
- 是否把“连接生命史”说得超出源码可支撑范围

### 当前需核对的关键锚点
- `com/zaxxer/hikari/HikariConfig.java`
- `com/zaxxer/hikari/HikariDataSource.java`
- `com/zaxxer/hikari/pool/HikariPool.java`
- 与 fail-fast / sealing / fastPathPool / HouseKeeper / keepalive / maxLifetime 相关关键方法锚点

### 初步判断
- 当前主线与 H-1 规划一致：`HikariConfig -> HikariDataSource -> HikariPool -> connection lifecycle`
- 没有把 HikariCP 写成参数说明书，这是对的
- 当前最大事实风险在于：正文虽然已经立住“连接生命史”主概念，但还没有把几处关键方法压到方法级锚点

## 第二轮：因果审

### 目标
检查正文中所有“为什么它不是容器、而是生命史管理链”这类判断，是否由源码结构支撑。

### 当前因果链
1. `HikariConfig` 是策略源头，不只是配置 Bean
2. `HikariDataSource` 是应用进入池世界的入口，不是薄壳
3. `HikariPool` 是运行时中心
4. HouseKeeper、maxLifetime、keepalive、fail-fast、sealing 都是同一条连接生命史上的控制节点

### 当前风险
- 方向是对的，但像 `fastPathPool`、sealing、fail-fast 这些点如果没有方法级锚点支撑，容易显得像“合理解释”而不是“当前源码事实”
- `HikariDataSource` 这一节尤其容易被写成经验判断，需要方法入口托底

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 主骨架拆解 -> 收网”的方法论，而不是退化成类图说明。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `HikariConfig`
5. `HikariDataSource`
6. `HikariPool`
7. HouseKeeper/maxLifetime/keepalive/fail-fast/sealing 回收
8. 收网总结
9. 下篇桥接

### 当前结构优点
- 没有退化成类名清单
- “连接生命史”是单一主概念，结构很稳
- 后半段把零散优化点回收成同一条主线，是对的

### 当前结构风险
- 后半段控制点如果后续补源码时不够具体，容易看起来像“优化点串烧”
- `HikariDataSource` 一节如果不压实入口角色，容易被读者再次误读成壳

## 第四轮：读者审

### 目标
检查读者是否能从“连接池=容器”切到“连接生命史管理链”这个更深层视角。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么连接池不是静态容器
- 为什么 HikariCP 关心的是连接这一生如何被管理
- 为什么各种看似零散的优化点都属于同一条主线

### 当前读者风险
- 如果没有少量方法级锚点，读者会认同主概念，却未必能落到真实实现
- `HikariDataSource` 的入口层角色需要再压实一点，不然还是容易被看成薄壳

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续借出/归还/监控专题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- ConcurrentBag 细节
- getConnection 完整借出流程
- close()/归还/驱逐细节
- metrics/JMX/leak detection 细节

### 当前边界风险
- 如果为了压实主线而过早把 getConnection()/close() 讲太多，会吃掉后续借还专题
- 如果为了显得完整而把 metrics/JMX 讲太多，会吃掉后续诊断层

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 只要求读者知道 JDBC 连接池的表层目的
- 不依赖 `vol-springboot` 必须先写完，但和 Boot 的边界已经清楚

### 后续桥接
- 当前桥接到“连接获取完整流程”是合理的：主骨架立住后，下一步自然是沿生命史进入借出链

## 机械检查

### 禁用词
当前首稿主线中未明显使用以下禁用词：
- 此处不再赘述
- 不再展开
- 类似地
- 同理
- 依此类推
- 篇幅所限
- 显然
- 容易看出
- 细节读者自行阅读源码

### 代码块角色检查
- 当前正文以结构解释为主
- 后续收口时必须补关键方法锚点，防止“生命史主线”停留在概念层

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“主骨架三层是否有足够方法级锚点”。本轮补强后，这个缺口已经被明显压实：
- `HikariConfig` 的关键策略字段 + `seal()` / `checkIfSealed()`
- `HikariDataSource(HikariConfig)` 构造路径 + 惰性 `getConnection()` + `fastPathPool`
- `HikariPool` 的类定义、`checkFailFast()`、`HouseKeeper`、`createPoolEntry()`

这让“连接生命史主骨架”不再只是角色级抽象，而有了明确的实现入口支撑。

## 建议的下一步

1. 以当前稿为准收口 Ch1-01
2. 进入连接获取完整流程
3. 继续延续一次性深审方式
