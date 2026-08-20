# HikariCP Ch4-01 ConcurrentBag 无锁并发设计 — 正文写作规划

## 文章定位

- 写作卷：`vol-hikaricp`
- 章节：Ch4 ConcurrentBag
- 篇：01 ConcurrentBag 为什么不是容器，而是借还协作协议
- 对应主题：`H-2 ConcurrentBag 无锁并发设计`
- 文章类型：存储层并发主线篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 Ch1-01，知道 HikariCP 的主骨架是 `HikariConfig -> HikariDataSource -> HikariPool -> connection lifecycle`。
- 读者应已读过 Ch2-01 和 Ch3-01，知道连接的借出与归还/驱逐都已经立成前后半链。

### SOFT

- HouseKeeper、泄漏检测、JMX、指标监控等后续篇目会继续复用 ConcurrentBag 的状态模型，但本篇先专注 Bag 自己的并发协作协议。

### NAV

- Ch5：连接生命周期管理 / HouseKeeper
- Ch6：连接验证 / 泄漏检测 / JMX / 指标监控（后续篇）

## 一句话困惑

为什么 HikariCP 不直接用一个普通阻塞队列或同步池结构来存连接，而要搞出 `ConcurrentBag` 这样一套看起来既不像 Queue、也不像传统对象池的并发结构？

## 一句话顿悟

`ConcurrentBag` 真正要解决的不是“把对象放在哪”，而是：**在高并发下，如何让借、还、等待、局部命中、线程间移交这些动作协同起来，同时尽量减少全局竞争。**

## 读者理解路径

1. 从“为什么普通队列不够用”切入。
2. 建立最小总图：`ThreadLocal fast path -> sharedList scan -> handoffQueue wait/transfer`。
3. 解释它为什么叫 Bag 而不是 Queue/Pool。
4. 解释 `borrow()`、`requite()`、`reserve()`、`unreserve()` 四类动作对应的状态转换。
5. 解释本地缓存、共享扫描、线程间移交这三层为什么要并存。
6. 最后收束：ConcurrentBag 不是集合类，而是一套借还协作协议。

## 失败方案推演

### 失败方案一：直接用 `BlockingQueue<Connection>` 不就够了

这是最自然的直觉。因为连接池听起来很像：
- 生产者放连接
- 消费者拿连接
- 队列不就是最顺手的模型吗？

问题在于，HikariCP 关心的不是“有没有地方放对象”，而是：
- 常用线程能不能先命中自己最近归还的对象
- 借不到时能不能快速扫到别人刚放回来的对象
- 线程在等待和新对象补充之间怎么协作
- 不同路径下的争用是否会太高

普通阻塞队列能表达“排队”，却很难同时表达这种多层次的协作意图。

### 失败方案二：Bag 只是一个快一点的容器

这也是容易低估的地方。

如果把 `ConcurrentBag` 只看成“比普通集合快一点的池子”，就会看不到它真正的协议性：
- 借的时候先去哪找
- 还的时候优先唤醒谁
- 某个对象怎样从 `NOT_IN_USE` 变成 `IN_USE`
- 为什么还有 `RESERVED` / `REMOVED` 这些状态

也就是说，ConcurrentBag 不是被动存储，而是主动参与借还协作的状态机结构。

### 失败方案三：ThreadLocal 就是一个缓存优化，核心还在共享列表
n
这个理解只抓住了一部分事实。

ThreadLocal 的确是快路径，但如果把它看成“可有可无的小缓存”，会低估 HikariCP 的整体策略：
- 先尽量局部命中
- 命不中再共享扫描
- 再不行才进入线程间等待与 handoff

所以 ThreadLocal、本地缓存、共享列表、handoffQueue 不是彼此独立的优化点，而是同一条并发协作链上的不同层次。

## 必须澄清的误解

1. `ConcurrentBag` 不是普通容器，而是连接借还协作协议。
2. 它的核心问题不是“放哪”，而是“高并发下怎么借、还、等、移交”。
3. ThreadLocal 不是附属缓存，而是快路径的一部分。
4. 共享列表不是全局真相，handoffQueue 也不是简单等待队列，它们都在协议里扮演角色。
5. 本篇讲的是存储层并发协作，不是重新讲借出/归还主线。

## 文章结构与字数预算

1. 困惑开场：为什么不能直接用 BlockingQueue（800-1000 字）
2. 最小总图：本地命中 -> 共享扫描 -> handoff 移交（1200-1500 字）
3. `ConcurrentBag` 的角色：为什么它是协议而不是容器（1600-2200 字）
4. `borrow()`：三层查找与等待逻辑（1800-2400 字）
5. `requite()` / `reserve()` / `unreserve()`：状态转换与归还协作（1800-2400 字）
6. 为什么这套结构能减少争用（1400-2000 字）
7. 收网总结：Bag 真正管理的是借还协作，而不是对象存放（800-1000 字）

目标叙述性正文：10000-13000 字；代码块不计入目标。

## 证据清单

写作时必须重新逐条验证：

- `com/zaxxer/hikari/util/ConcurrentBag.java`
- `IConcurrentBagEntry` 状态定义
- `borrow()`
- `requite()`
- `reserve()` / `unreserve()`
- `ThreadLocal` 本地缓存
- `sharedList`
- `handoffQueue`

## 版本边界

- 当前分析对象：HikariCP `7.0.2`
- 本篇聚焦当前 `ConcurrentBag` 实现
- 不混入通用并发集合教材

## 与其他篇的边界

### 本篇要讲清

- 为什么 HikariCP 要自己做一套 Bag 结构
- 借还协作协议是怎么成立的
- 为什么这套协议能支撑连接生命史的并发路径

### 本篇不深讲

- HouseKeeper 维护逻辑
- metrics/JMX/leak detection
- 驱逐策略细节

## 写作后检查

- [ ] 开篇不是并发术语介绍，而是“为什么 BlockingQueue 不够”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“Bag 只是快一点容器”的误解
- [ ] 总图明确区分：本地命中、共享扫描、handoff 等待
- [ ] 不把本篇写成 `ConcurrentBag` API 说明书
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 通过一次性深审收口
