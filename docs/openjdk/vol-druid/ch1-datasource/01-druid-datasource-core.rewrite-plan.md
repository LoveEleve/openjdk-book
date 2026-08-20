# Druid Ch1-01 DruidDataSource 连接池核心 — 正文写作规划

## 文章定位

- 写作卷：`vol-druid`
- 章节：Ch1 Pool Core
- 篇：01 为什么 Druid 不能只是“一个 HikariCP 的国产替代”
- 对应主题：`D-1 DruidDataSource 连接池核心`
- 文章类型：骨架总入口篇
- 正文状态：未开始

## 前置依赖

### HARD

- 读者应已读过 `vol-hikaricp` 的借出链、归还链，或至少知道连接池“借还不是一次性容器，而是生命史管理”的核心认知。
- 读者不需要先懂 Druid 内部类，但需要接受一个前提：Druid 不是“多带监控的 HikariCP”，它内部模型和 HikariCP 有本质不同。

### SOFT

- `vol-druid` 后续会展开：维护体系、Filter 链、StatFilter、WallFilter、SQL 解析器、Boot 集成。本篇只立住池本体。

### NAV

- Ch1-02：连接池维护体系（shrink / DestroyTask / removeAbandoned）
- Ch2：Filter 拦截链体系

## 一句话困惑

为什么同样是 JDBC 连接池，Druid 在借出/归还时的内部模型不是线程本地 + CAS 无锁查找，而是一把 `ReentrantLock` + 两个 `Condition` + 固定数组 + 阻塞等待？

## 一句话顿悟

Druid 不是“封装得比 HikariCP 多”，而是它选择了完全不同的池内并发模型：**`notEmpty`/`empty` 两个 Condition 承担的，不是“加快借还”，而是让“借不到时阻塞、生产者补充时唤醒、超时统一出异常”成为一套受控协议。**

## 读者理解路径

1. 从“如果用 HikariCP 的理解去看 Druid，会在哪几个点上卡住”切入。
2. 建立最小总图：`init() -> connections[maxActive] -> getConnectionInternal() -> pollLast/notEmpty -> borrow`。
3. 解释 `DruidDataSource` / `DruidAbstractDataSource` / `DruidConnectionHolder` 三层结构。
4. 解释 `init()` 为什么是“配置对象变成运行池”的转折点。
5. 解释 `getConnectionInternal()` 在池空、等待、超时、致命错误时各走哪条路径。
6. 最后收束：Druid 的池本体模型，和 HikariCP 的借还链是两套不同的协议。

## 失败方案推演

### 失败方案一：Druid 就是 HikariCP + 监控

这是最常犯的理解。它会把读者带到“差异只是外挂”的误区里。

实际上两层都不同：
- 池内并发模型不同（Lock+Condition vs ConcurrentBag）
- 拦截模型不同（Filter 链 vs 无拦截器代理）

如果只把它当“HikariCP 加监控”，后续 Filter / StatFilter / WallFilter 全都会理解错方向。

### 失败方案二：`init()` 只是配置校验

`init()` 在 HikariCP 里相对轻，因为 HikariPool 构造时就会走到 fail-fast；但在 Druid 里它是“配置对象到运行池”的完整转折点，涉及：
- 驱动加载
- Filter 初始化
- initialSize 预建
- 三线程启动
- initedLatch 同步等待

所以它不只是校验，而是装配启动。

### 失败方案三：池空时的 wait/signal 只是普通 Object 等待

这个理解会漏掉 Druid 真正的设计点：
- `notEmpty` / `empty` 两个 Condition 是配套协议
- 池空等待、生产者补充、超时放弃、discard 重试，都在这套协议里被限死

如果把 wait/signal 当普通 wait/notify 理解，`maxWaitThreadCount`、`createDirect`、`onFatalError` 这些都会变成谜题。

## 必须澄清的误解

1. Druid 不是 HikariCP 的增强版，而是另一种池内并发模型。
2. `init()` 是从“配置对象”到“运行池”的完整转折点。
3. `notEmpty`/`empty` 不是普通 wait/notify，而是借-补-超时协议。
4. `DruidConnectionHolder` / `DruidPooledConnection` 不是同一层级。
5. 本篇只讲池本体，不把 Filter/Stat/Wall 提前拉进来。

## 文章结构与字数预算

1. 困惑开场：为什么不能用 HikariCP 的模型理解 Druid（800-1000 字）
2. 最小总图：init → 数组 → 借出/归还（1200-1500 字）
3. `DruidDataSource` / `DruidAbstractDataSource` / `DruidConnectionHolder` 分层（1600-2200 字）
4. `init()`：配置对象到运行池的转折点（1800-2400 字）
5. `getConnectionInternal()`：池空/等待/超时/致命错误路径（1800-2400 字）
6. 为什么 `notEmpty`/`empty` 是一套受控协议（1200-1800 字）
7. 收网总结：Druid 池本体是一套独立模型（800-1000 字）

目标叙述性正文：9500-12500 字；代码块不计入目标。

## 证据清单

写作时须重新 grep，不能直接抄规划行号：

- `/data/workspace/source-code/code/spring/druid/core/src/main/java/com/alibaba/druid/pool/DruidDataSource.java`
  - `init()`：约 659
  - `getConnectionInternal(long)`：约 1543
  - `connections = new DruidConnectionHolder[maxActive]`：约 772
  - `recycle(DruidPooledConnection)`：约 1894
  - `shrink()` 三重载：约 3061/3065/3069
- `DruidConnectionHolder.java`
  - `class DruidConnectionHolder`：约 46
  - 持有哪些连接状态与重置字段
- `DruidPooledConnection.java`
  - `class DruidPooledConnection`：约 43
  - 与 holder 的关系

## 版本边界

- 当前分析对象：Druid `1.2.27`
- 聚焦当前 `DruidDataSource` 池本体
- 不混入 HikariCP 作为主叙事，只作为对照引入

## 与其他篇的边界

### 本篇要讲清

- Druid 池本体三层结构与 HikariCP 的差异
- `init()` 的完整启动转折
- `getConnectionInternal()` 的借出主路径

### 本篇不深讲

- shrink / DestroyTask / removeAbandoned 维护体系
- Filter / StatFilter / WallFilter
- SQL 解析器
- Boot 集成

## 写作后检查

- [ ] 开篇不是类名介绍，而是“为什么不能拿 HikariCP 模型硬套 Druid”的困惑
- [ ] 至少 2 个失败方案，且有一个专门针对“Druid=HikariCP+监控”的误解
- [ ] 总图明确区分：配置 → 池数组 → 借出 → 归还
- [ ] 不把 notEmpty/empty 写成普通 wait/notify
- [ ] 删除代码后主线仍成立
- [ ] 所有 `file:line` 写作时重新 grep 验证
- [ ] 一次性深审收口覆盖事实/因果/结构/读者/边界/依赖