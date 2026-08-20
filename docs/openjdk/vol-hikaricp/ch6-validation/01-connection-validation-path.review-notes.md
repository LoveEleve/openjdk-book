# HikariCP Ch6-01 连接验证机制 — review notes

## 第一轮：事实审

### 目标
核对：
- `aliveBypassWindow`、`isConnectionDead()`、`beginRequest()`、代理交付的角色归属是否准确
- `file:line` 引用是否真实存在
- 是否把“连接验证”写成超出源码可支撑的绝对安全策略

### 当前需核对的关键锚点
- `HikariPool.getConnection(long)` 中：
  - `aliveBypassWindowMs`
  - `isMarkedEvicted()`
  - `isConnectionDead(...)`
  - `beginRequest()`
  - `createProxyConnection(...)`
- `PoolBase.isConnectionDead()`
- 相关配置：`validationTimeout` / `connectionTestQuery` / JDBC4 `isValid()`

### 初步判断
- 当前主线与 Ch6 规划一致：borrow 候选 -> 过筛 -> 代理交付
- 没有把验证写成“顺手 ping 一下”，这是对的
- 当前最大事实风险在于：`PoolBase.isConnectionDead()` 还没有被压到方法级实现，alive / bypass / beginRequest 目前仍有一部分停留在 HikariPool 侧表述

## 第二轮：因果审

### 目标
检查正文中所有“为什么候选连接还要继续过筛”“为什么 bypass 不是偷懒”这类判断，是否由源码结构支撑。

### 当前因果链
1. borrow 成功只是候选阶段
2. 驱逐状态和活性状态共同决定是否还能交付
3. bypass 窗口是性能与正确性之间的平衡策略
4. `beginRequest()` 是交付前的最后一道请求边界动作
5. 代理交付让池的控制权在交付后仍然延续

### 当前风险
- `beginRequest()` 的价值现在写得比较稳，但正式收口时要继续克制，不要把它夸成比 alive/evict 更核心的节点
- `aliveBypassWindow` 很容易被误读成性能技巧，后续要确保它和“高频借出路径上的成本平衡”始终绑在一起

## 第三轮：结构审

### 目标
检查结构是否遵守“困惑 -> 失败方案 -> 总图 -> 过筛逻辑拆解 -> 收网”的方法论，而不是退化成校验参数解释。

### 当前结构评价
当前结构是：
1. 困惑开场
2. 失败方案
3. 最小总图
4. 驱逐判断
5. alive / bypass
6. `PoolBase.isConnectionDead()`
7. `beginRequest()`
8. 代理交付
9. 收网总结
10. 下篇桥接

### 当前结构优点
- 没有退化成参数说明书
- “候选 -> 过筛 -> 交付”这条结构非常清楚
- 和前后篇（借出链、归还链、HouseKeeper）衔接自然

### 当前结构风险
- `PoolBase.isConnectionDead()` 这一节如果后续不补足方法级实现，整篇最核心的“验证落点”会显得偏抽象
- `aliveBypassWindow`、`beginRequest()`、代理交付三者的轻重关系需要继续稳定，避免后半段失衡

## 第四轮：读者审

### 目标
检查读者是否能从“借前做个检查”切到“可交付性判断链”这个视角。

### 当前读者收益
读完后，读者至少应能回答：
- 为什么 borrow 成功不等于能交付
- 为什么验证不是附属 ping，而是借出安全门
- 为什么最终必须交付代理连接

### 当前读者风险
- 如果缺少 `PoolBase.isConnectionDead()` 的硬锚点，读者会接受整体框架，但会觉得关键一刀落点不够硬
- 若后续补太多 JDBC4/isValid/testQuery 细节，又容易重新滑成配置手册

## 第五轮：边界审

### 目标
检查本篇是否提前透支 keepalive/HouseKeeper、泄漏检测、metrics/JMX 等后续专题。

### 当前边界控制
本篇明确不深讲：
- HouseKeeper keepalive 后台维护
- leak detection
- metrics / JMX

### 当前边界风险
- 如果为了讲 alive 检查而把 keepalive 背景带太多，会重新吃掉 Ch5
- 如果为了讲交付边界而把 proxy/close 讲太多，会重新吃掉归还链

## 第六轮：依赖审

### 目标
检查前置依赖与后续桥接是否清楚。

### 前置依赖
- 强依赖 Ch2 借出链
- 强依赖 Ch3 归还/驱逐链
- 强依赖 Ch5 生命周期后台维护

### 后续桥接
- 当前桥接到“连接泄漏检测”是合理的：可交付性判断讲完后，下一步自然是“交出去以后迟迟不还怎么办”

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
- 后续收口时必须补 `PoolBase.isConnectionDead()` 的方法级锚点，防止“验证落点”停留在概念层

## 当前结论

这篇已经完成一次性深审收口，当前主问题已从“结构是否成立”收敛为“验证落点是否有足够方法级锚点”。本轮补强后，这个缺口已经被明显压实：
- `PoolBase.isConnectionDead(...)`: `PoolBase.java:157`
- `networkTimeout` 设置与恢复：`PoolBase.java:160`、`177`
- JDBC4 `isValid()` 路径：`PoolBase.java:164`
- `connectionTestQuery` 路径：`PoolBase.java:168`、`173`

这让“连接验证是在做可交付性判断”这条主论断，不再只是借出链上的概念延伸，而有了真正的验证落点支撑。

## 建议的下一步

1. 以当前稿为准收口 Ch6-01
2. 进入连接泄漏检测
3. 继续延续一次性深审方式
