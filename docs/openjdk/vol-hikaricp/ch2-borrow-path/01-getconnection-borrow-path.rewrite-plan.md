# HikariCP Ch2-01 连接获取完整流程 — 正文写作规划

## 文章定位

- 写作卷：`vol-hikaricp`
- 章节：Ch2 Borrow Path
- 篇：01 一次 `getConnection()` 到底穿过了哪些状态门槛
- 对应主题：`H-3 连接获取完整流程`
- 文章类型：借出主线篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch1-01，知道 HikariCP 不是连接容器，而是一条连接生命史管理链。
- 读者应知道 `HikariConfig -> HikariDataSource -> HikariPool` 三层骨架，以及 `HikariPool` 是真正的运行时中心。

### SOFT

- `ConcurrentBag` 会在后续单独深挖，本篇先把它作为“借出存储层”的一段结构来看。
- 归还与驱逐在下一篇再深讲，本篇主要把借出路径跑通。

### NAV

- Ch2-02：连接归还与连接驱逐
- Ch3：ConcurrentBag 无锁并发设计

## 一句话困惑

表面上看，`DataSource.getConnection()` 只是一个方法调用；但在 HikariCP 里，这一次调用为什么会一路穿过挂起锁、Bag 借出、连接存活判断、代理创建等多道门槛？

## 一句话顿悟

HikariCP 的 `getConnection()` 从来不是“从池里拿一个对象”这么简单，而是：**把一个候选连接从“池内可用状态”一路推进成“当前调用方可安全使用的代理连接”的完整借出链。**

## 读者理解路径

1. 从“为什么 getConnection 不是简单出队”切入。
2. 建立最小总图：`HikariDataSource.getConnection() -> HikariPool.getConnection() -> suspendResumeLock -> ConcurrentBag.borrow() -> alive/evict check -> proxy`。
3. 解释为什么挂起锁是借出链的第一道门。
4. 解释为什么借出不是直接返回 `PoolEntry`，而是要经过健康与驱逐判断。
5. 解释为什么最终交给调用方的不是底层连接，而是代理连接。
6. 最后收束：借出链本质上是在把“池内对象”变成“当前调用者可安全拿走的连接”。

## 失败方案推演

### 失败方案一：getConnection 就是从池里拿一个连接出来

这是最自然的直觉，因为从外部 API 看就是：
- 调一下 `getConnection()`
- 返回一个连接

问题在于，这种说法完全看不见借出链里真正重要的判断：
- 池现在是不是处于可借出状态
- 这个连接是不是刚好应该被驱逐
- 这个连接是不是需要做活性检查
- 返回给调用方的到底是底层连接，还是代理对象

也就是说，“拿出来”只是结果，不是过程。

### 失败方案二：只要 `ConcurrentBag.borrow()` 成功，连接就一定能用

这是一种更细一点、但依然不够的理解。

因为借出路径并不是“Bag 借到就结束”。在 HikariCP 里，借到只是开始，后面还有：
- evicted 判断
- 活性判断
- beginRequest（可选）
- 代理对象创建

所以 Bag 解决的是“有没有候选对象”，不是“这个对象现在能不能安全交给调用方”。

### 失败方案三：返回的是原始 JDBC Connection

这个误解也很常见，因为业务代码看到的就是一个 `Connection`。

但 HikariCP 返回的并不是裸连接，而是代理连接。只有这样，后面 close、状态重置、异常驱逐等逻辑才能重新回到池体系里。

## 必须澄清的误解

1. `getConnection()` 不是简单出队，而是一条完整借出链。
2. `ConcurrentBag.borrow()` 解决的是候选对象获取，不等于连接已经可安全交付。
3. 活性检查和驱逐判断不是附属细节，而是借出路径中的安全门。
4. 调用方拿到的是代理连接，不是底层裸连接。
5. 本篇讲的是借出链，不是归还/驱逐的完整后半段。

## 文章结构与字数预算

1. 困惑开场：为什么 getConnection 不是简单取对象（800-1000 字）
2. 最小总图：入口 -> 候选 -> 判断 -> 代理交付（1200-1500 字）
3. `HikariDataSource.getConnection()`：入口层（1200-1600 字）
4. `HikariPool.getConnection()`：借出链中心（1800-2400 字）
5. `ConcurrentBag.borrow()` 在这里到底解决什么（1600-2200 字）
6. alive / evict / proxy：为什么借到不等于可交付（1800-2400 字）
7. 收网总结：借出链是在把池内对象变成当前调用者的安全连接（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `com/zaxxer/hikari/HikariDataSource.java` (`getConnection()`)
- `com/zaxxer/hikari/pool/HikariPool.java` (`getConnection()`)
- `com/zaxxer/hikari/util/ConcurrentBag.java` (`borrow()`)
- `PoolEntry.createProxyConnection(...)`
- 与 `aliveBypassWindow`、evicted 判断、beginRequest 相关的关键方法锚点

## 版本边界

- 当前分析对象：HikariCP `7.0.2`
- 本篇只讲借出链
- 不混入归还、驱逐、metrics/JMX 完整细节

## 与其他篇的边界

### 本篇要讲清

- getConnection 的完整借出主线
- 候选连接如何经过判断成为可交付连接
- 为什么最终一定要交付代理连接

### 本篇不深讲

- 归还与驱逐完整后半段
- ConcurrentBag 全量并发设计
- Metrics / leak detection / JMX

## 写作后检查

- [ ] 开篇不是 API 描述，而是“为什么 getConnection 不是简单取对象”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“borrow 成功就能用”的误解
- [ ] 总图明确区分：入口、候选、判断、代理交付
- [ ] 不把本篇写成方法调用清单
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
