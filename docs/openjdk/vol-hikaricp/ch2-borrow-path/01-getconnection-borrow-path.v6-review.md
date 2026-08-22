# 01-getconnection-borrow-path 深度审查（v6）

## 一、结论

这一版已经从“借出只是 borrow()”的旧理解，明显提升到“借出是一条候选 → 过门 → 代理交付”的完整链路说明。

核心优点已经成立：

- 借出链的主线清楚
- `HikariDataSource` / `HikariPool` / `ConcurrentBag` 的分工清楚
- 驱逐门、活性门、旁路窗口、代理交付门的顺序清楚
- 关键源码锚点已完成抽查

但从方法论的严格标准看，这篇和 Ch1 一样，仍然属于**达标但还可继续收束**的版本，而不是最稳定的终稿。

## 二、源码锚点核验

本次抽查通过的关键锚点包括：

- `HikariDataSource.java:46`
- `HikariDataSource.java:47`
- `HikariDataSource.java:92`
- `HikariDataSource.java:98`
- `HikariDataSource.java:105`
- `HikariDataSource.java:112`
- `HikariPool.java:140`
- `HikariPool.java:142`
- `HikariPool.java:152`
- `HikariPool.java:154`
- `HikariPool.java:155`
- `HikariPool.java:166`
- `HikariPool.java:171`
- `HikariPool.java:174`
- `HikariPool.java:179`
- `HikariPool.java:184`
- `HikariPool.java:191`
- `HikariPool.java:62`
- `ConcurrentBag.java:132`
- `ConcurrentBag.java:140`
- `ConcurrentBag.java:145`
- `ConcurrentBag.java:160`
- `PoolBase.java:157`
- `PoolBase.java:160`

说明：本轮 review 中发现过一处 `ConcurrentBag.java:157` 的锚点偏差，已修正为 `ConcurrentBag.java:160` 附近的 handoff 路径。

## 三、六层深审

### 1. 主题层

优点：

- 标题与正文核心问题一致：`getConnection()` 不是取对象，而是穿门
- 三个直觉方案都围绕“为什么 borrow() 不是终点”服务同一主线
- 最终一句话顿悟和收网结论保持一致

问题：

- 借出链的“规则门”和“实现细节”有时仍交织在一起，尤其在 `ConcurrentBag` 与“交付前动作”部分

建议：

- 后续如果继续收束，应更早地区分“借出规则”与“借出实现细节”

### 2. 结构层

优点：

- 已具备完整骨架：困惑 → 方案 → 顿悟 → 总图 → 分层拆解 → 失败路径 → 收网桥接
- 分层拆解围绕借出链顺序展开，阅读顺序正确

问题：

- 当前二级节和三级节数量仍偏多，存在“讲透了，但切得太碎”的现象
- 某些节的边界仍可继续压实，尤其是“交付前动作”和“最终交付门”此前混在一起，现在虽已修正，但整体仍偏密

建议：

- 后续卷写作时，提前规划节边界，减少事后补丁式分节

### 3. 事实层

优点：

- `fastPathPool/final` 与 `pool/volatile` 的关系在 Ch1 已校正，这篇继承时未再引入硬错误
- handoff 路径锚点已修正
- `aliveBypassWindowMs`、`isConnectionDead()`、`beginRequest()`、`createProxyConnection()` 的行号说明基本可靠

风险点：

- `ProxyConnection` / `ProxyLeakTaskFactory` 的进一步展开如果后续再加，一定要继续核行号

### 4. 解释层

优点：

- 已经不只是翻源码，而是在回答“为什么这一步必须存在”
- `suspendResumeLock` 被解释成“池状态门”，这是对的
- `ConcurrentBag.borrow()` 的三段路径被解释成成本排序，而不是只是代码顺序，这一点很好

问题：

- 少数解释仍然偏总结，例如“失败路径最怕的不是报错，而是状态收口失败”，结论正确，但还能再多绑一层源码动作来支撑

建议：

- 后续如果继续打磨，可在“失败收口”上再加一小段源码链说明

### 5. 失败路径层

优点：

- 已经覆盖池状态、驱逐、活性、旁路窗口、代理交付、超时解释六类不同故障面
- 失败路径不再只是“报错类型列表”，而是进入控制点级别

问题：

- 第 5 条“代理交付失败后没收口”在当前正文里已经补充说明：这是设计约束的反面镜像，不是在指认现成源码 bug。这个补充是必要的，但仍然说明这一条和其他 5 条相比，源码直观度略弱

建议：

- 保留这一条，但在后续卷中尽量让所有失败路径都能更直接地贴到源码动作

### 6. 成文层

优点：

- 已具备较稳定的“先打碎直觉，再重建机制”的 vol-02 式节奏
- 收网能把全篇主线重新拉回“borrow() 不是终点，代理交付才是终点”

问题：

- 全文已经达到 600+ 行，但某些段落仍能看出“为了深补而加厚”的痕迹
- 这不算错误，但距离真正“天然成文”的状态还有一点距离

## 四、与方法论对照

### 已达标项

- 困惑开场成立
- 三个直觉方案成立
- 一句话顿悟成立
- 总图存在
- 行数达标（600+）
- 失败路径达到 6 条
- 关键锚点抽查通过
- 收网与下篇桥接存在

### 未完全理想项

- 结构仍偏碎
- 二级节/三级节数量偏多
- 少数解释段仍可再绑源码动作

## 五、最终评级

评级：**B+（可作为 vol-hikaricp Ch2 的当前达标稿）**

解释：

- 已明显超过旧版 403 行的“讲过程但还不够层层过门”的版本
- 已可以作为后续 Ch3 的写作样板
- 但距离 vol-02 那种“结构天然、节边界非常稳”的 A 档终稿，还有最后一轮收束空间

## 六、下一步建议

1. 不建议继续在 Ch2 上做无止境的小修小补
2. 先把同样方法论用于 Ch3，让“借出链 → 归还链”成对落地
3. 等 Ch1-Ch3 都稳定后，再统一做一轮节名、层级和结构收束
