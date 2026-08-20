# 03-blocking-deadlock 重写规划

> 状态：重写前大纲
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“thread -b / 死锁检测”重构成一篇围绕“CPU 热点不等于堵点，Arthas 又怎样用一次全量深度快照把‘等待最多的锁’与‘真正的死锁环’区分开”的机制文

## 1. 选题判断

这篇值得独立成篇，但不能继续写成：

- `dumpAllThreads()` 做什么
- 两张 Map 怎么建
- 怎么选 mostBlockingLock
- `findDeadlockedThreads()` 又是什么

这种按算法步骤顺排的说明文。

更好的统一问题是：

**接口全超时、线程表里全是 `BLOCKED/WAITING` 时，为什么 CPU 排名前几的线程未必是真堵点？Arthas 又怎样用一次全量深度快照，把“当前最热的争用锁”和“真正的死锁环”区分开？**

这样本篇就不再是“锁统计实现导览”，而会被收束成一条更硬的锁诊断链：

- CPU 热点与锁堵点是两类不同问题
- `thread -b` 不是死锁检测，而是争用热点筛选
- `dumpAllThreads()` 给的是一次深度快照
- 等待关系与持有关系必须拆成两张视图
- `findDeadlockedThreads()` 才是死锁环确认工具

## 2. 读者困惑

- 为什么线程都卡住时，`thread -n` 看到的 CPU 热点不一定是真正堵路点？
- `thread -b` 到底在找什么，为什么它不等于“找死锁线程”？
- 为什么要一次性 `dumpAllThreads()`，而不是沿用上一章的轻量快照？
- 为什么算法要同时维护“谁在等”和“谁在持有”两张表？
- 为什么 `findDeadlockedThreads()` 和 `thread -b` 不是同一个问题？

## 3. 一句话顿悟

**当问题从“谁最忙”切换成“谁把路堵住了”，Arthas 就不能再靠轻量 CPU 快照，而必须做一次全量深度线程 dump：把每个线程正在等哪把锁、又持有哪把锁分别记录下来，再找出“等待人数最多且当前确实有持有者”的那个争用热点；而真正的死锁确认，则必须交给 `findDeadlockedThreads()` 这种专门检测循环等待的 API。**

## 4. 版本边界

正文开头必须明确：

- 基于 `arthas` 当前源码与 `ThreadMXBean` / `ThreadInfo` 行为讨论
- 聚焦 `thread -b` 的锁争用热点筛选与 `findDeadlockedThreads()` 的死锁确认边界
- 不把 ObjectMonitor、AQS 内部实现展开成主线；这里只把它们当作 `ThreadInfo` 暴露出来的锁拥有关系
- 这里讲的是 Arthas 当前一次性快照诊断策略，不等于长期在线锁画像或 async-profiler 的 lock 事件模型

## 5. 旧稿主要问题

### 5.1 已有优点

- 已经抓到“CPU 热点不一定是阻塞根因”这个核心冲突
- `dumpAllThreads()`、等待表/持有者表、mostBlockingLock 选择条件、`findDeadlockedThreads()` 的边界都在
- 已经强调 `thread -b` 是定位工具，不是死锁环证明工具
- 对复杂度和全量 dump 成本也有提醒

### 5.2 必须修复的问题

- 当前骨架仍偏“算法说明文”，冲突感还不够强
- 失败方案推演不够厚：为什么不能只看 CPU 热点、为什么不能只统计等待人数不看持有者、为什么不能把所有“卡住”都叫死锁，还没打透
- `identityHashCode` 的边界虽然提到了，但还没完全收回到“快照身份标签而不是永久锁 ID”这个主线
- 最后的收网还可以更明确地压成“争用热点筛选”和“死锁环确认”两阶段锁诊断链

## 6. 重写策略

本篇不按算法实现顺序平铺，而按更强的问题链组织：

1. 先建立冲突：线程都卡住时，CPU 热点未必是真堵点
2. 先排除几个错误直觉：
   - 只看最忙线程就够了
   - 只统计等待人数，不看持有者
   - 所有 BLOCKED/WAITING 都可以叫死锁
3. 再给总图：全量深度 dump → 等待表 / 持有者表 → 热点争用锁 → 持锁线程定位 → 死锁 API 补确认
4. 然后分层拆：
   - 为什么 `thread -b` 必须走一次深度快照
   - 为什么等待关系和持有关系要拆成两张表
   - 为什么选择逻辑必须同时满足“等待人数最多 + 当前确实有人持有”
   - 为什么 `identityHashCode` 只是快照期身份标签
   - 为什么 `findDeadlockedThreads()` 是确诊，而不是同一算法的一部分
5. 最后收束成“线索扫描 + 精确判定”的两阶段锁诊断哲学

## 7. 结构大纲（按理解路径）

### 第一节：事故开场——线程都卡住了，为什么最忙线程未必是真堵点

目标：建立真实困惑，而不是直接从 `dumpAllThreads()` 讲起。

要回答：

- 接口全超时、线程表全是 `BLOCKED/WAITING` 的现场
- CPU 最忙线程可能只是一个症状，不一定是造成大面积排队的原因
- 本篇真正要追的是“哪把锁堵住了最多线程”

预估字数：900-1100

### 第二节：先排除几个错误直觉——只看 CPU 热点、只看等待人数、把所有卡住都叫死锁

目标：做失败方案推演。

要回答：

- 为什么锁堵点和 CPU 热点不是同一个问题
- 为什么只统计“谁在等”而不看“谁在持有”会给出假热点
- 为什么很多线程都卡住，不等于一定存在循环死锁
- 真正需要的是：争用热点筛选 + 死锁环确认

预估字数：1400-1700

### 第三节：第一层——为什么 `thread -b` 必须走一次全量深度快照

目标：把 `dumpAllThreads()` 写成问题解法，而不是 API 介绍。

要回答：

- 为什么上一章的轻量线程快照不够用
- `dumpAllThreads()` 一次拿到的是什么：线程栈、等待锁、已持有 monitor / synchronizer
- 为什么这条路径很重，但又必须专门为阻塞诊断存在

证据锚点：

- `core/util/ThreadUtil.java:99-101`
- `threadMXBean.dumpAllThreads(...)`

预估字数：1500-1800

### 第四节：第二层——为什么等待关系和持有关系必须拆成两张表

目标：把两张 Map 写成冲突解法。

要回答：

- `blockCountPerLock` 统计的是什么
- `ownerThreadPerLock` 记录的是什么
- 为什么等待关系来自 `getLockInfo()`，持有关系来自 `getLockedMonitors()` / `getLockedSynchronizers()`
- 为什么“谁在等”和“谁在持有”不能混成一个视图

证据锚点：

- `ThreadUtil.java:103-136`

预估字数：1800-2200

### 第五节：第三层——为什么热点争用锁必须同时满足“等待人数最多”与“当前确实有人持有”

目标：把选择逻辑写成主冲突解法。

要回答：

- `mostBlockingLock` 选择条件的两个维度是什么
- 为什么没有持有者的等待锁不应被当成“最堵路线程”的答案
- `EMPTY_INFO` 为什么不是错误，而是“当前这次快照没找到合格争用热点”
- 这一步真正筛出的是什么：最值得先看的争用线索

证据锚点：

- `ThreadUtil.java:138-152`
- `ThreadCommand.java:175-181`

预估字数：1700-2100

### 第六节：第四层——为什么 `identityHashCode` 只是快照期身份标签，而不是永久锁 ID

目标：把 `identityHashCode` 的边界写清楚。

要回答：

- 为什么这里必须按对象身份，而不是 `equals()`
- 为什么等待者看到的 `LockInfo` 能和持有者看到的 `MonitorInfo/LockInfo` 对上
- 为什么这个 identity 只服务于本次快照，不应被误解为持久全局锁编号

证据锚点：

- `LockInfo.getIdentityHashCode()` 使用点

预估字数：1200-1500

### 第七节：第五层——为什么 `thread -b` 是线索扫描，而 `findDeadlockedThreads()` 才是确诊工具

目标：把争用热点与死锁环判定彻底拆开。

要回答：

- `jvm` 命令里的 `DEADLOCK-COUNT` 是怎么来的
- `findDeadlockedThreads()` 关注的是什么：循环等待
- 为什么一个慢持锁线程可以堵住很多线程，但根本不构成死锁
- 为什么真正死锁确认不能只靠“最多等待人数”推断

证据锚点：

- `JvmCommand.java:184-200`
- `threads.findDeadlockedThreads()`

预估字数：1700-2100

### 第八节：收网——锁诊断不是一个动作，而是“热点争用筛选 + 死锁环确认”两阶段链

目标：把全文收成一句话并桥接下一篇。

必须点名：

- 全量深度快照
- 等待表 / 持有者表
- 最热争用锁筛选
- `identityHashCode` 快照身份标签
- 死锁 API 确认环
- 下一篇 Dashboard 复用这些数据

预估字数：800-1000

## 8. 必须展开的失败方案

至少要展开以下失败方案：

1. 只看 CPU 热点，不看锁争用
2. 只统计等待人数，不检查当前持有者
3. 把所有 `BLOCKED/WAITING` 线程都当成死锁
4. 把 `identityHashCode` 当成跨时间稳定的永久锁 ID
5. 在普通线程列表路径里默认执行全量 `dumpAllThreads()`

## 9. 本篇必须明确澄清的误解

1. `thread -b` 不是死锁检测命令
2. `dumpAllThreads()` 给的是一次深度快照，不是轻量实时视图
3. 等待锁人数多，不等于当前一定存在有效持有者
4. `identityHashCode` 是快照期身份标签，不是业务锁 ID
5. `findDeadlockedThreads()` 关注的是循环等待，而不是争用热度
6. 争用热点筛选和死锁环确认是两阶段工具，不是同一个结论

## 10. 证据清单（正文托底）

- `core/util/ThreadUtil.java:92-159`
- `ThreadUtil.java:99-101`
- `ThreadUtil.java:103-136`
- `ThreadUtil.java:138-152`
- `ThreadUtil.java:166-266`
- `ThreadCommand.java:175-181`
- `JvmCommand.java:184-200`
- `threads.findDeadlockedThreads()`

## 11. 字数预算

- 目标正文总字数：`8500-11000`
- 叙述性正文目标：`5500+`

## 12. 完成后必须通过的检查

1. 删除代码后，主线是否仍然成立
2. 是否清楚回答了“为什么 CPU 热点不等于锁堵点”
3. 是否至少展开了 4 个失败方案
4. 是否把 `thread -b` 和 `findDeadlockedThreads()` 统一到“线索扫描 + 精确判定”的两阶段锁诊断链上
5. 是否明确把 Dashboard 复用留给下一篇
6. 是否完成 `file:line` 重核与边界声明
