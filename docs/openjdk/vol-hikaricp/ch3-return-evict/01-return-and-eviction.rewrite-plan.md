# HikariCP Ch3-01 连接归还与连接驱逐 — 正文写作规划

## 文章定位

- 写作卷：`vol-hikaricp`
- 章节：Ch3 Return & Eviction
- 篇：01 连接用完之后，为什么不是简单 close，而是一条归还与驱逐链
- 对应主题：`H-4 连接归还与连接驱逐`
- 文章类型：连接生命史后半段主线篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch1-01，知道 HikariCP 是一条连接生命史管理链。
- 读者应已读过 Ch2-01，知道借出链的终点不是裸连接，而是代理连接。

### SOFT

- 后续会有 `ConcurrentBag` 专篇、HouseKeeper 专篇、泄漏检测/JMX/指标专篇；本篇先把“归还”和“驱逐”这条后半链主线立住。

### NAV

- Ch4：ConcurrentBag 无锁并发设计
- Ch5：连接生命周期管理 / HouseKeeper

## 一句话困惑

为什么调用方看到的只是 `connection.close()`，但在 HikariCP 里，这个 `close` 既不等于真正关闭物理连接，也不等于简单放回池里，而是一整条“状态重置、异常判断、归还或驱逐”的后半链？

## 一句话顿悟

HikariCP 的连接归还不是“把连接塞回池子”，而是：**先判断这条连接是否还配继续活着，再决定它是被重置后归还，还是被标记驱逐并在后续路径上真正关闭。**

## 读者理解路径

1. 从“为什么 `close()` 不等于关闭物理连接”切入。
2. 建立最小总图：`ProxyConnection.close() -> cleanup / rollback / reset -> recycle or evict -> bag requite or close`。
3. 解释代理连接为什么是归还链入口。
4. 解释状态重置为什么不是附属动作，而是安全复用的前提。
5. 解释 `checkException()` 为什么是驱逐决策中心。
6. 最后收束：归还链是在决定这条连接“继续活”还是“退出生命史”。

## 失败方案推演

### 失败方案一：`close()` 就是关闭底层物理连接

这符合普通 JDBC 直觉，但在连接池里是错的。因为如果每次 close 都真关连接，前面的借出链就失去意义了。

### 失败方案二：归还就是把连接直接放回池里

这会忽略：
- 未提交事务回滚
- 脏状态重置
- 连接是否已经失效
- 是否已经该被驱逐

所以“放回去”只是可能结果，不是归还链的全部。

### 失败方案三：异常驱逐是边角逻辑

实际上驱逐决策决定的是：
- 这条连接还能不能继续被复用
- 当前异常是不是连接级故障
- 池后续会不会继续把坏连接交给别的调用方

所以它不是尾巴，而是后半链的核心判断点。

## 必须澄清的误解

1. `ProxyConnection.close()` 不是物理关闭连接，而是归还链入口。
2. 归还前的 rollback / reset 不是附属细节，而是安全复用前提。
3. `checkException()` 决定的是连接是否还能继续活着。
4. 归还与驱逐不是两条平行线，而是同一条生命史后半段的两种分支。
5. 本篇讲的是连接后半链，不是泄漏检测或后台维护主线。

## 文章结构与字数预算

1. 困惑开场：为什么 close 不等于真正关闭（800-1000 字）
2. 最小总图：close -> cleanup -> reset -> recycle/evict（1200-1500 字）
3. `ProxyConnection.close()`：为什么它是后半链入口（1600-2200 字）
4. rollback / dirtyBits / reset：为什么归还前必须清状态（1800-2400 字）
5. `checkException()`：为什么异常会改变连接命运（1800-2400 字）
6. recycle / requite / close：继续活还是退出（1600-2200 字）
7. 收网总结：后半链在决定连接生命史的去留（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `ProxyConnection.close()`
- `ProxyConnection.checkException()`
- `PoolBase.resetConnectionState()`
- `PoolEntry.recycle()`
- `ConcurrentBag.requite()`
- 与 SQLState / ERROR_STATES / ERROR_CODES / SQLExceptionOverride 相关锚点

## 版本边界

- 当前分析对象：HikariCP `7.0.2`
- 本篇只讲归还/驱逐主线
- 不混入泄漏检测、JMX、metrics 的完整后续话题

## 与其他篇的边界

### 本篇要讲清

- 连接用完之后怎样决定“继续活”还是“退出”
- 状态清理为什么是归还链前提
- 异常驱逐为什么是生命史判断点

### 本篇不深讲

- ConcurrentBag 完整并发设计
- HouseKeeper / maxLifetime / keepalive 后台维护
- leak detection / metrics / JMX

## 写作后检查

- [ ] 开篇不是 JDBC 常识，而是“为什么 close 不等于关闭”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“归还就是放回池子”的误解
- [ ] 总图明确区分：归还前清理、异常判断、继续活/退出分支
- [ ] 不把本篇写成 close() 方法注释展开
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
