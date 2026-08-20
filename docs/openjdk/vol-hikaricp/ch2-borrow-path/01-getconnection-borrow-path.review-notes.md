# HikariCP Ch2-01 连接获取完整流程 — review notes

## 第一轮：事实审

### 目标
核对：
- `HikariDataSource.getConnection()`、`HikariPool.getConnection()`、`ConcurrentBag.borrow()`、代理交付链的角色归属是否准确
- `file:line` 引用是否真实存在
- 是否把“借出链”讲得超出源码可支撑范围

### 当前需核对的关键锚点
- `HikariDataSource.getConnection()`
- `HikariPool.getConnection()`
- `ConcurrentBag.borrow()`
- `PoolEntry.createProxyConnection(...)`
- 与 `aliveBypassWindow`、evicted 判断、beginRequest 相关的关键方法锚点

### 初步判断
- 当前主线与 H-3 规划一致：入口层 -> 池中心 -> 候选获取 -> 判断 -> 代理交付
- 没有把 `borrow()` 误写成借出终点，这一点是对的
- 当前最大事实风险在于：`alive / evict / beginRequest / proxy` 这段后半链还没有被方法级压实

## 第二轮：因果审

### 目标
检查正文里所有“为什么 getConnection 不是简单取对象”“为什么候选不等于可交付”这类判断，是否由源码结构支撑。

### 当前因果链
1. `HikariDataSource.getConnection()` 决定进入的是快路径还是惰性初始化路径
2. `HikariPool.getConnection()` 是借出链的编排中心
3. `ConcurrentBag.borrow()` 解决的是候选获取，不是最终交付
4. alive / evict 检查是借出链里的安全门
5. 代理连接保证控制权不在交付时丢失

### 当前风险
- 目前结构判断是对的，但如果不补足后半链锚点，`alive / evict / proxy` 会更像合理推断而不是实现事实
- `beginRequest` 若正文里没有真正落到实现点，最好保持轻描淡写，不要说得像借出链的绝对核心步骤

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 借出链拆解 -> 收网”的方法论，而不是退化成方法调用流水账。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `HikariDataSource.getConnection()`
5. `HikariPool.getConnection()`
6. `suspendResumeLock`
7. `ConcurrentBag.borrow()`
8. alive / evict
9. 代理交付
10. 收网总结
11. 下篇桥接

### 当前结构优点
- 没有退化成“方法挨个解释”
- 先立“借出链”，再看方法角色
- 代理交付被放在链尾单独立住，这是对的

### 当前结构风险
- `suspendResumeLock` 和 `ConcurrentBag.borrow()` 两节如果后续补源码时处理不好，容易显得过细而打断主线节奏
- 后半段 alive / evict / proxy 的权重必须压实，否则整篇会出现前重后轻

## 第四轮：读者审

### 目标
检查读者是否能从“getConnection=取对象”切到“借出链”这个更深层视角。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么 getConnection 不是简单出队
- 为什么 borrow 只是候选阶段
- 为什么代理交付才是真正借出完成

### 当前读者风险
- 如果后半段方法级锚点不够，读者会理解结构，但仍可能对“借出链到底有没有这么多门”缺乏把握
- `aliveBypassWindow`、`beginRequest` 这类细节如果后续补得不当，会抬高认知负担

## 第五轮：边界审

### 目标
检查本篇是否提前透支归还/驱逐、ConcurrentBag 全量设计、指标监控等后续专题。

### 当前边界控制
本篇明确不深讲：
- 归还与驱逐完整后半段
- ConcurrentBag 全量并发设计
- Metrics / leak detection / JMX

### 当前边界风险
- 如果为了讲借出链而把 `ConcurrentBag` 的并发设计讲太深，会吃掉后续专篇
- 如果为了讲活性检查把驱逐链提前讲满，会吃掉下一篇归还/驱逐专题

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 依赖 Ch1 已立住 `HikariConfig -> HikariDataSource -> HikariPool` 主骨架
- 本篇自然承接到借出链

### 后续桥接
- 当前桥接到“连接归还与连接驱逐”是合理的：借出链立住之后，后半段自然就是归还和驱逐

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
- 当前正文仍偏结构解释
- 后续收口时必须补足借出后半链的关键锚点，防止整篇停留在概念层

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“候选连接 -> 可交付连接”的转变是否有足够硬的实现托底。本轮补强后，这个缺口已经被明显压实：
- `HikariPool.getConnection() / getConnection(long)`: `HikariPool.java:140`、`HikariPool.java:152`
- `ConcurrentBag.borrow(...)`: `ConcurrentBag.java:132`
- ThreadLocal / sharedList / handoffQueue 三段借出路径：`ConcurrentBag.java:134`、`148`、`163`
- alive/evict 安全门：`HikariPool.java:62`、`166`
- `beginRequest()` 与代理交付：`HikariPool.java:174`、`179`

这让整篇的主论断——“借出链是在把池内候选对象转成可安全交付代理连接”——不再只是结构框架，而有了完整的方法级支撑。

## 建议的下一步

1. 以当前稿为准收口 Ch2-01
2. 进入连接归还与连接驱逐
3. 继续延续一次性深审方式
