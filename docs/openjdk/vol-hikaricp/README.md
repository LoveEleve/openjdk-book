# 卷 HikariCP · 连接池内部实现源码分析

> 本卷当前聚焦 **HikariCP 7.0.2** 的内部实现主线。写作目标不是把 HikariCP 源码按包翻译一遍，而是把“连接生命史 -> 并发协作 -> 后台维护 -> 诊断与可观测”组织成一卷可连续阅读、可迁移到真实项目与线上问题判断的源码书。

## 当前卷级状态

当前已经完成：
- **主干层**：5 篇
- **诊断与可观测层**：4 篇

也就是说：
- **HikariCP 主干卷第一阶段** 已经阶段性完结
- 当前还未补的，主要是：
  - 卷级导读 / 总图整理
  - 如有需要，再补 `Spring Boot ↔ HikariCP` 集成桥专题

## 一、主干层（当前已完成）

### Ch1 Architecture
- [01. 为什么 HikariCP 不是“存连接的池子”，而是一条连接生命史管理链](ch1-architecture/01-pool-architecture-and-lifecycle.md)

回答：
- 为什么连接池不是容器，而是连接生命史管理系统
- `HikariConfig -> HikariDataSource -> HikariPool` 三层骨架各负责什么

### Ch2 Borrow Path
- [01. 一次 `getConnection()` 到底穿过了哪些门：HikariCP 的借出主线](ch2-borrow-path/01-getconnection-borrow-path.md)

回答：
- borrow 成功为什么还不等于能交付
- 候选连接怎样经过验证与代理交付变成可安全使用连接

### Ch3 Return & Eviction
- [01. 为什么 HikariCP 里的 `close()` 不等于关闭连接，而是在决定这条连接还能不能继续活着](ch3-return-evict/01-return-and-eviction.md)

回答：
- `close()` 为什么是后半链入口
- 状态重置、异常驱逐、recycle/requite 如何决定连接命运

### Ch4 ConcurrentBag
- [01. 为什么 HikariCP 不直接用队列，而要自己做一个 `ConcurrentBag`](ch4-concurrentbag/01-lock-free-bag-design.md)

回答：
- 为什么池存储层不是普通容器，而是借还协作协议
- ThreadLocal / sharedList / handoffQueue 为什么要三层并存

### Ch5 Lifecycle & HouseKeeper
- [01. 为什么连接归还之后，生命史还没结束：HikariCP 的后台维护与生命周期控制](ch5-lifecycle-housekeeper/01-lifecycle-and-housekeeper.md)

回答：
- 连接在池里继续活着时，为什么还要 keepalive、maxLifetime、idleTimeout、HouseKeeper
- 为什么 HouseKeeper 是连接余生管理者

## 二、诊断与可观测层（当前已完成）

### Ch6 Validation
- [01. 为什么 borrow 成功了，连接却还不能立刻交给调用方：HikariCP 的连接验证主线](ch6-validation/01-connection-validation-path.md)

回答：
- 驱逐、alive、bypass、beginRequest、代理交付为什么共同构成可交付性判断链

### Ch7 Leak Detection
- [01. 为什么一条借出去太久不还的连接，HikariCP 还能把你揪出来](ch7-leak-detection/01-leak-detection-path.md)

回答：
- 借出埋点、归还取消、超时告警为什么是一条借出后的诊断生命史

### Ch8 JMX
- [01. 为什么连接池不能是黑箱：HikariCP 的 JMX 与运行时控制面](ch8-jmx/01-jmx-and-runtime-control.md)

回答：
- `HikariPoolMXBean` / `HikariConfigMXBean` 如何分别暴露状态视角与配置视角
- sealing 为什么和运行时管理并不冲突

### Ch9 Metrics
- [01. 为什么 HikariCP 还要单独做一套 metrics：连接生命史的持续观测面](ch9-metrics/01-metrics-observation-system.md)

回答：
- 为什么 metrics 不是日志和 JMX 的重复
- 为什么要量化连接生命史的关键阶段

## 推荐阅读顺序

如果是第一次系统学习 HikariCP，建议顺序：

1. `Ch1` 总骨架
2. `Ch2` 借出链
3. `Ch3` 归还 / 驱逐链
4. `Ch4` ConcurrentBag
5. `Ch5` 生命周期 / HouseKeeper
6. `Ch6` 连接验证
7. `Ch7` 泄漏检测
8. `Ch8` JMX
9. `Ch9` metrics

这个顺序的好处是：
- 先把连接生命史主线立住
- 再把并发存储层压实
- 最后补诊断、控制和持续观测三层

## 这卷现在已经能回答什么

到目前为止，这一卷已经能回答：
- HikariCP 为什么不是一个“装连接的池子”，而是一条连接生命史链
- 连接怎样被借出、怎样被归还、怎样被继续活着或退出
- 池存储层为什么是协作协议而不是普通容器
- 后台如何持续管理连接余生
- 候选连接怎样被验证为可交付连接
- 借出去不还的连接怎样被追出来
- 连接池怎样在运行时被观察和控制
- 连接生命史怎样被持续量化成可观测信号

也就是说：
- **HikariCP 主干卷第一阶段已成立**
- **下一步可以选择继续做卷级导读 / 总图整理，或按需补 Spring Boot 集成桥专题**