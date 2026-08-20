# Druid Ch2-01 连接池维护体系 — 正文写作规划

## 文章定位

- 写作卷：`vol-druid`
- 章节：Ch2 Maintenance
- 篇：01 为什么 `shrink()` 不是“定时清一清”，而是 Druid 池长期运行的后台维护中心
- 对应主题：`D-5 连接池维护体系`
- 文章类型：后台维护主线篇
- 正文状态：未开始

## 前置依赖

### HARD
- 读者应已读过 D-1，知道 `DruidDataSource` 的池本体由 `connections[maxActive]` 固定数组 + `notEmpty`/`empty` 双 Condition 构成。
- 读者应已读过 `vol-hikaricp` 的 HouseKeeper 篇，知道连接池都有后台维护，但 Druid 的维护方式不同。

### SOFT
- 后续的 Filter/StatFilter 篇会用到 shrink 和 removeAbandoned 的概念，但本篇先立住 Druid 自己的维护体系。

### NAV
- Ch3：Filter 拦截链体系
- Ch4：StatFilter SQL 监控

## 一句话困惑
为什么 `shrink()` 一个方法就能撑起 Druid 池的“空闲驱逐、keepAlive、fatalError 处理、数组紧凑化”四件事，而 HikariCP 要拆成 HouseKeeper / maxLifetime / keepalive / idleTimeout 多个独立任务？

## 一句话顿悟
Druid 的 `shrink()` 不是“一个清理方法”，而是 Druid 池维护主线的执行中心——它把 `fatalError` 处理、空闲驱逐、`keepAlive` 检测、数组紧凑化压进同一个扫描循环，用 `checkTime` 和 `keepAlive` 两个布尔参数控制分支。

## 读者理解路径
1. 从“为什么需要一个方法管四件事”切入。
2. 建立最小总图：`DestroyTask.run() -> shrink(checkTime, keepAlive) -> 四阶段扫描 -> compact`。
3. 解释 `shrink()` 的四个阶段：fatalError 处理、idle timeout 驱逐、keepAlive 检测、数组紧凑化。
4. 解释 `DestroyTask` / `CreateConnectionTask` 的任务分工。
5. 解释 `removeAbandoned()` 的强制回收路径。
6. 最后收束：Druid 维护体系是“一个方法 + 两个定时任务”的轻量后台，和 HikariCP 的 `HouseKeeper` 不同。

## 失败方案推演
### 失败方案一：`shrink()` 就是驱逐空闲连接
错。它同时处理 fatalError 和 keepAlive。

### 失败方案二：Druid 维护和 HikariCP HouseKeeper 一样
HikariCP 的 HouseKeeper 是 `scheduleWithFixedDelay(new HouseKeeper(), 100L, 30s, MILLISECONDS)`，所有决策都在 run() 里一次完成。
Druid 的 DestroyTask 每 `timeBetweenEvictionRunsMillis` 执行一次 `shrink(true, keepAlive)`，但 `CreateConnectionTask` 由另一个 `createScheduler` 管理。
所以 Druid 是两个后台线路，不是一条。

### 失败方案三：`removeAbandoned()` 是 shrink 的一部分
`removeAbandoned()` 虽然也在 DestroyTask 里被调用，但它和 `shrink()` 不是同一件事：shrink 管池内未借出的连接，removeAbandoned 管借出去但超时未归还的连接。

## 必须澄清的误解
1. `shrink()` 一个方法管四件事，不是“一个清理方法”。
2. Druid 维护是“DestroyTask + CreateConnectionTask”两个后台线路，不是 HouseKeeper 一个。
3. `removeAbandoned()` 和 `shrink()` 管的是不同范围的连接。
4. 本篇只讲维护体系，不把 Filter/StatFilter 提前拉进来。

## 文章结构与字数预算
1. 困惑开场：为什么 Druid 把维护压进一个方法（800-1000 字）
2. 最小总图：DestroyTask -> shrink() 四阶段 -> CreateConnectionTask（1200-1500 字）
3. `shrink()` 四阶段拆解（2200-3000 字）
4. `DestroyTask` / `CreateConnectionTask` 分工（1800-2400 字）
5. `removeAbandoned()` 强制回收路径（1200-1800 字）
6. Druid vs HikariCP 后台维护模型对比（1200-1800 字）
7. 收网总结：Druid 维护是“一个方法 + 两个定时任务”的轻量后台（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单
写作时须重新 grep，不能直接抄规划行号：
- `DruidDataSource.java` 的 `shrink()` 三重载：约 3061/3065/3069
- `DruidDataSource.java` 的 `DestroyTask` 内部类
- `DruidDataSource.java` 的 `CreateConnectionTask` 内部类
- `DruidDataSource.java` 的 `removeAbandoned()` 方法
- `DruidDataSource.java` 的 `timeBetweenEvictionRunsMillis` 字段

## 版本边界
- 当前分析对象：Druid `1.2.27`
- 只讲后台维护体系，不提前透支 Filter/StatFilter/解析器

## 写作后检查
- [ ] 开篇不是方法清单，而是“为什么一个方法管四件事”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“Druid 维护=HikariCP HouseKeeper”的误解
- [ ] 总图明确区分：fatalError、idle、keepAlive、compact
- [ ] 不把 removeAbandoned 和 shrink 写成一件事
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证