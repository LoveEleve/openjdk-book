# HikariCP Ch5-01 连接生命周期管理 / HouseKeeper — review notes

## 第一轮：事实审

### 目标
核对：
- `maxLifetime`、`keepaliveTime`、`idleTimeout`、HouseKeeper 的角色归属是否准确
- `file:line` 引用是否真实存在
- 是否把“后台维护”写成超出源码可支撑的绝对控制逻辑

### 当前需核对的关键锚点
- `HikariPool.createPoolEntry()`
- `MaxLifetimeTask`
- `KeepaliveTask`
- `HouseKeeper`
- `fillPool()`
- 与 `housekeepingPeriodMs`、时钟回拨检测、idleTimeout 淘汰相关关键方法锚点

### 初步判断
- 当前主线与 Ch5 规划一致：归还之后的连接余生 -> 后台维护 -> 退场/补充
- 没有把这篇写成参数手册，这是对的
- 当前最大事实风险在于：HouseKeeper、maxLifetime、keepalive 等还没有方法级硬锚点压实，正文目前更多是结构性概括

## 第二轮：因果审

### 目标
检查正文中所有“为什么连接归还后生命史还没结束”“为什么 HouseKeeper 是余生管理者”这类判断，是否由源码结构支撑。

### 当前因果链
1. 归还之后，连接还会继续在池里活着
2. `maxLifetime` 决定连接不能无限活着
3. `keepaliveTime` 说明空闲连接仍在池的管理范围内
4. `idleTimeout` 和 `maxLifetime` 都在判断“值不值得继续活”
5. HouseKeeper 是后台控制面执行者，而不是普通定时线程

### 当前风险
- 这些判断方向是对的，但如果没有 `createPoolEntry()`、`HouseKeeper.run()`、定时任务类的硬锚点，容易显得像参数级总结
- “时钟回拨”与“雪崩抖动”这两类解释很值钱，但也最容易在没有源码支持时写得过实

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 生命周期后台维护拆解 -> 收网”的方法论，而不是退化成参数说明书。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `maxLifetime`
5. `keepaliveTime`
6. `idleTimeout`
7. HouseKeeper
8. 时钟回拨 / fillPool / 后台控制面
9. 收网总结
10. 下篇桥接

### 当前结构优点
- 没有退化成配置项说明表
- 先立“连接余生”，再讲后台维护策略
- 和借出/归还两篇形成了完整前中后生命史呼应

### 当前结构风险
- `maxLifetime`、`keepaliveTime`、`idleTimeout` 三节如果后续补源码时写得太散，会让 HouseKeeper 这一节重心变弱
- HouseKeeper 若不压到方法级锚点，读者会接受“后台管理者”这个概念，但不一定能落到实现

## 第四轮：读者审

### 目标
检查读者是否能从“几个时间参数”切到“连接余生管理”这个视角。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么借还讲完以后连接生命史还没结束
- 为什么 `maxLifetime` / `keepaliveTime` / `idleTimeout` 不是独立参数，而是同一条后台维护主线
- 为什么 HouseKeeper 不是普通定时任务

### 当前读者风险
- 如果没有方法级锚点，读者可能会把这篇重新读成“参数解释高级版”
- 时钟回拨和抖动策略如果讲太快太深，也会增加认知门槛

## 第五轮：边界审

### 目标
检查本篇是否提前透支后续验证/泄漏/JMX/指标专题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- metrics/JMX 细节
- leak detection 细节
- 借出/归还完整链（前文已讲）

### 当前边界风险
- 如果为了讲 keepalive 而把连接验证链讲太多，会吃掉后续验证专题
- 如果为了讲后台维护而把指标/JMX 带太多，会吃掉后续诊断层

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 强依赖 Ch1 总骨架
- 强依赖 Ch2 借出链
- 强依赖 Ch3 归还/驱逐链
- 强依赖 Ch4 ConcurrentBag 存储层协作

### 后续桥接
- 当前桥接到验证 / 泄漏检测 / JMX / 指标监控是合理的：连接余生讲完后，下一步自然是“这条生命史怎么被验证、观察和控制”

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
- 当前正文仍以结构解释为主
- 后续收口时必须补 `createPoolEntry()`、`HouseKeeper`、寿命任务类的关键锚点，防止它停留在参数层

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“后台维护链是否有足够方法级锚点”。本轮补强后，这个缺口已经被明显压实：
- `createPoolEntry()`：`HikariPool.java:485`
- `MaxLifetimeTask` 调度：`HikariPool.java:493`、`495`
- `KeepaliveTask` 调度：`HikariPool.java:498`、`501`、`503`
- HouseKeeper 调度与周期：`HikariPool.java:63`、`118`
- `HouseKeeper.run()`：`HikariPool.java:793`、`799`
- 时钟回拨 / 前跳告警 / idleTimeout / fillPool：`HikariPool.java:816`、`823`、`830`、`845`
- `fillPool(...)` 本体：`HikariPool.java:525`

这让“连接余生主线”不再只是参数级说明，而有了完整的后台维护实现托底。

## 建议的下一步

1. 以当前稿为准收口 Ch5-01
2. 进入连接验证 / 泄漏检测 / JMX / 指标监控
3. 继续延续一次性深审方式
