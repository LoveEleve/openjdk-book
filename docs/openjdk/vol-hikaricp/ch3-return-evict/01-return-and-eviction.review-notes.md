# HikariCP Ch3-01 连接归还与连接驱逐 — review notes

## 第一轮：事实审

### 目标
核对：
- `ProxyConnection.close()`、`checkException()`、`resetConnectionState()`、`PoolEntry.recycle()`、`ConcurrentBag.requite()` 的角色归属是否准确
- `file:line` 引用是否真实存在
- 是否把“连接命运判断”说得超出源码可支撑范围

### 当前需核对的关键锚点
- `ProxyConnection.close()`
- `ProxyConnection.checkException()`
- `PoolBase.resetConnectionState()`
- `PoolEntry.recycle()`
- `ConcurrentBag.requite()`
- 与 SQLState / ERROR_STATES / ERROR_CODES / SQLExceptionOverride 相关锚点

### 初步判断
- 当前主线与 H-4 规划一致：`close -> cleanup -> reset -> recycle/evict`
- 没有把 `close()` 误写成直接关闭物理连接，这一点是对的
- 当前最大事实风险在于：`dirtyBits`、异常驱逐链、`requite()` 等还没有被方法级压实

## 第二轮：因果审

### 目标
检查正文中所有“为什么归还前一定要清状态”“为什么异常会改变连接命运”这类判断，是否由源码结构支撑。

### 当前因果链
1. `ProxyConnection.close()` 是后半链入口，不是物理关闭终点
2. rollback / reset 不是附属清理，而是安全复用前提
3. `checkException()` 会把异常上升成连接命运判断
4. `recycle()` / `requite()` 代表继续活的分支
5. 驱逐代表退出分支

### 当前风险
- 这些判断方向是对的，但如果没有 `ProxyConnection` / `PoolBase` / `PoolEntry` 的方法级锚点，容易显得像“池化常识”而不是当前实现
- `dirtyBits` 是本篇很关键的亮点，如果锚点不够，会削弱“后半链既讲正确性也讲性能”的说服力

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 后半链拆解 -> 收网”的方法论，而不是退化成 close() 细节说明。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. `ProxyConnection.close()`
5. 归还前清理
6. `dirtyBits`
7. `checkException()`
8. `recycle()` / `requite()`
9. 驱逐分支
10. 收网总结
11. 下篇桥接

### 当前结构优点
- 没有退化成 API 注释展开
- “连接命运判断”作为总概念很稳
- 借出链与归还链形成明显前后呼应

### 当前结构风险
- 如果后续补源码时 `checkException()` 一节不够具体，驱逐分支会显得比归还分支弱
- `dirtyBits` 若只讲概念、不落实现，读者会认可设计意义但抓不住具体机制

## 第四轮：读者审

### 目标
检查读者是否能从“close=放回池子”切到“close 是连接命运判断入口”的更深层视角。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么 close 不等于关物理连接
- 为什么归还前一定要 reset/rollback/清状态
- 为什么异常驱逐是后半链的核心判断点
- 为什么归还和驱逐是同一条链的两个分支

### 当前读者风险
- 如果没有方法级锚点，读者会接受后半链框架，但仍可能觉得“这和别的连接池大概差不多”
- `dirtyBits` / `checkException()` 这两节最容易在没有源码压实时变成概念总结

## 第五轮：边界审

### 目标
检查本篇是否提前透支 ConcurrentBag 专题、泄漏检测专题、HouseKeeper 专题，或是否漏掉本篇必须收住的边界。

### 当前边界控制
本篇明确不深讲：
- ConcurrentBag 完整并发设计
- HouseKeeper / maxLifetime / keepalive
- metrics / leak detection / JMX

### 当前边界风险
- 如果为了说明归还链而把 `ConcurrentBag` 讲太多，会吃掉下一篇
- 如果为了说明异常驱逐而把生命周期和后台维护讲满，会吃掉 HouseKeeper 专题

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 依赖 Ch1 已立住总骨架
- 依赖 Ch2 已立住借出链

### 后续桥接
- 当前桥接到 `ConcurrentBag` 是合理的：借出链和归还链都讲完之后，下一步自然就是池内存储层怎么工作

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
- 后续收口时必须补 `ProxyConnection` / `PoolBase` / `PoolEntry` / `ConcurrentBag` 的关键方法锚点

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“后半链是否有足够方法级锚点”。本轮补强后，这个缺口已经被明显压实：
- `ProxyConnection.close()`: `ProxyConnection.java:240`
- `dirtyBits` 字段与 reset 触发点：`ProxyConnection.java:57`、`254`
- `PoolBase.resetConnectionState(...)`: `PoolBase.java:213`
- `ProxyConnection.checkException(...)`: `ProxyConnection.java:151`
- `PoolEntry.recycle()` / `createProxyConnection(...)`: `PoolEntry.java:77`、`99`
- `ConcurrentBag.requite()`: `ConcurrentBag.java:187`

这让“后半链在决定连接命运”这条主论断，不再只是结构框架，而有了完整的方法级托底。

## 建议的下一步

1. 以当前稿为准收口 Ch3-01
2. 进入 ConcurrentBag 无锁并发设计
3. 继续延续一次性深审方式
