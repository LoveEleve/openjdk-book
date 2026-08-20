# 04-thread-practice 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“thread 命令口诀”重构成一篇围绕“线上 CPU/阻塞故障如何逐步缩小证据范围，再选择栈、锁、内存、类字节码和方法观察工具”的生产排查路径文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- 先执行 `thread -n 3`
- 再执行 `thread <id>`
- 再看 BLOCKED/WAITING
- 再执行 `thread -b`
- 最后看 DEADLOCK-COUNT

这种命令清单式实战文章。

更好的统一问题是：

**线上 CPU 报警或接口超时发生时，为什么不能一上来就打开所有诊断命令，而要先用低成本线程视图缩小问题空间，再按证据选择 CPU、栈、锁、Dashboard、内存、类字节码和方法观察工具？**

这样本篇就不再是“thread 命令使用说明”，而会被收束成一条故障证据链：

- 先判断是忙还是堵
- 再从全体线程缩到少数候选
- 再从候选线程进入具体栈
- 根据栈和状态决定走锁、内存、内部线程、类字节码还是方法级观察
- 每一步都避免过早使用高成本工具

## 2. 读者困惑

- CPU 报警时，为什么第一步不是直接 dump 所有线程和锁？
- `thread -n 3` 和 `thread <id>` 分别解决什么问题？
- 什么时候应该看 BLOCKED/WAITING，什么时候应该看 `thread -b`？
- 为什么业务线程不忙但机器 CPU 仍然高时，要怀疑 JVM 内部线程？
- 为什么 `jad`、`trace`、`watch`、`dashboard`、`memory`、`jvm` 不是一组可以随便互换的命令？

## 3. 一句话顿悟

**线上排查不是把所有诊断信息一次性打满，而是按“低成本定位 → 少数线程深挖 → 按证据分流”的顺序逐步缩小问题空间：先用 `thread -n` 找窗口热点，再用 `thread <id>` 看栈和状态，遇到阻塞转 `thread -b`，怀疑循环等待再看 `DEADLOCK-COUNT`，若热点来自内部线程或运行时资源，再切到 Dashboard、memory、jvm、jad、trace、watch 等对应工具。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前命令实现与前面 AR-3 / AR-4 / AR-2 机制篇讨论
- 聚焦生产排查路径与证据分流，不重复展开每个命令的完整源码机制
- 这里的“1 分钟”是排查节奏示例，不是所有故障都能在固定时间内定位
- 不把 `thread -n` 的当前实现边界写成严格精确的 CPU 窗口保证
- 不把 `thread -b` 的争用热点结果写成死锁确诊

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经有明确的线上 CPU 报警场景
- 命令顺序基本合理：热点、栈、状态、锁、死锁、内部线程
- 已经提醒了 ThreadVO 身份 key 和内部线程精度边界
- 能把 AR-2 / AR-3 / AR-4 / AR-5 的工具串起来

### 5.2 必须修复的问题

- 当前仍然偏“命令口诀”，缺少为什么按这个顺序排查的冲突推演
- 没有把“先低成本筛选，再高成本深挖”的总原则贯穿每一步
- `thread -n`、`thread <id>`、`thread -b`、`jvm` 的证据边界还可以更明确
- `jad`、`trace`、`watch`、Dashboard、memory 等后续工具目前像命令堆叠，需要改成“由栈和状态证据触发的分流节点”

## 6. 重写策略

本篇不按命令列表推进，而按真实故障决策链组织：

1. 先建立事故：CPU 飙高或接口超时，但不能直接把所有数据都 dump 出来
2. 先排除两个错误直觉：
   - 一上来全量深度采集
   - 把 CPU 热点、锁堵点、内存压力和方法慢混成一个问题
3. 再给总图：低成本线程排序 → 少数线程栈 → 状态分流 → 锁/死锁/内部线程/运行时资源/方法行为
4. 然后分层拆：
   - `thread -n 3` 为什么是第一步
   - `thread <id>` 如何把统计候选变成具体调用栈
   - BLOCKED/WAITING 如何触发锁诊断
   - 内部线程和运行时资源如何触发 Dashboard/memory/jvm
   - 业务栈如何触发 jad/trace/watch
5. 最后收束成“先缩小证据范围，再选择观测强度”的生产排查哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——CPU 报警时，为什么第一步不是打开所有命令

目标：建立生产压力与证据成本冲突。

要回答：

- 4 核机器 CPU 报警、服务仍活着但响应变慢的现场
- 全量 dump / 全量锁查询为什么可能太重
- 本篇要建立的是一条证据递进路径，而不是命令清单

预估字数：900-1100

### 第二节：第一步——先用 `thread -n 3` 判断“谁在忙”

目标：把 TopN 写成低成本候选筛选。

要回答：

- 输出里的 TIME / DELTA_TIME / %CPU / STATE 各是什么意思
- `processTopBusyThreads()` 为什么先排序再深挖
- 为什么 `-n 3` 是控制候选集成本的选择
- 当前 ThreadVO 身份 key 边界意味着什么

证据锚点：

- `ViewRenderUtil.java:109-126`
- `ThreadCommand.java:116-128,184-197`
- `ThreadSampler.java:116-150`

预估字数：1700-2100

### 第三节：第二步——用 `thread <id>` 把统计候选变成具体调用栈

目标：把单线程深度查看写成证据升级。

要回答：

- 为什么先有候选线程，再读完整 ThreadInfo
- 栈顶业务、数据库/连接池/HTTP、锁等待分别意味着什么
- 为什么 `thread <id>` 不是重新开始，而是把统计结果转换成因果线索

证据锚点：

- `ThreadCommand.processThread()` 路径
- `ThreadMXBean.getThreadInfo(...)`

预估字数：1400-1700

### 第四节：第三步——根据 STATE 分流：BLOCKED/WAITING 不是同一种问题

目标：把状态过滤写成决策分支。

要回答：

- `BLOCKED`、`WAITING`、`TIMED_WAITING` 各自只能说明什么
- 为什么 `WAITING` 不自动等于线程池耗尽
- `processAllThreads()` 为什么先统计全体状态再过滤
- 状态证据如何决定下一步走 `thread -b` 或其他命令

证据锚点：

- `ThreadCommand.java:131-159`
- Thread.State 语义

预估字数：1500-1800

### 第五节：第四步——锁问题走 `thread -b`，死锁怀疑再看 `DEADLOCK-COUNT`

目标：把锁与死锁分流写清。

要回答：

- `thread -b` 为什么做全量深度 dump
- 等待表/持有者表如何定位最热争用锁
- 为什么 `thread -b` 不是死锁证明
- 为什么 `jvm` 的 `DEADLOCK-COUNT` 才看循环等待

证据锚点：

- `ThreadUtil.findMostBlockingLock()`
- `ThreadCommand.java:175-181`
- `JvmCommand.java:184-200`

预估字数：1600-2000

### 第六节：第五步——业务线程不忙但机器 CPU 高，转向 JVM 内部线程与运行时面板

目标：把内部线程场景连接到 Dashboard/memory/jvm。

要回答：

- 为什么 GC、编译器等内部线程可能不出现在普通业务线程热点里
- `HotspotThreadMBean` 能补什么视野，以及精度边界
- 为什么可以转到 Dashboard、memory、jvm 看 GC、内存、运行时和线程背景

证据锚点：

- `ThreadSampler.java:157-181`
- Dashboard / `memory` / `jvm` 已完成文章桥接

预估字数：1400-1700

### 第七节：第六步——业务栈暴露代码问题后，才进入 jad / trace / watch

目标：把 AR-2 工具写成证据触发的下钻，而不是命令堆。

要回答：

- 栈顶是业务热点时，为什么先看 `jad` / `sc` / `sm` 的运行时类与字节码
- 需要方法内部耗时时走 `trace`
- 需要参数、返回值、异常与条件时走 `watch`
- 这些工具都应该建立在前面已经缩小目标的基础上

证据锚点：

- `jad` / `sc` / `sm` / `trace` / `watch` 已完成文章桥接

预估字数：1500-1800

### 第八节：收网——先缩小证据范围，再选择观测强度

目标：把整篇压成一条可执行决策链并桥接下一篇。

必须点名：

- `thread -n 3`
- `thread <id>`
- `--state`
- `thread -b`
- `jvm DEADLOCK-COUNT`
- Dashboard / memory / jvm
- jad / trace / watch
- 下一篇类与字节码排查

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. CPU 报警一上来就全量 dump 所有线程、锁和栈
2. 把 CPU 热点直接当成锁堵点
3. 把所有 BLOCKED/WAITING 都叫死锁
4. 看到业务线程不忙就排除 JVM 内部线程
5. 没有先确定目标方法就直接对全应用做 trace/watch/retransform

## 9. 本篇必须明确澄清的误解

1. `thread -n 3` 是候选筛选，不是完整因果解释
2. `thread <id>` 是从统计到栈证据的升级，不是另一套热点算法
3. STATE 只能给出等待/阻塞类别，不能直接给出根因
4. `thread -b` 找争用热点，`DEADLOCK-COUNT` 看循环等待
5. 内部线程数值要保留 HotSpot 能力与 ThreadVO key 的实现边界
6. `jad` / `trace` / `watch` 应在目标已缩小后使用，否则观测成本和干扰都会放大

## 10. 证据清单（正文托底）

- `view/ViewRenderUtil.java:109-126`
- `monitor200/ThreadCommand.java:116-128,131-159,184-219`
- `ThreadSampler.java:116-150,157-181`
- `ThreadUtil.findMostBlockingLock()`
- `JvmCommand.java:184-200`
- 前置 AR-2 / AR-4 / AR-5 文章桥接

## 11. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么生产排查必须逐步缩小证据范围”
3. 是否至少展开了 4 个失败方案
4. 是否把 thread / lock / deadlock / runtime / bytecode / method observation 统一到同一条证据分流链上
5. 是否明确保留当前实现精度和成本边界
6. 是否完成 `file:line` 重核与边界声明
