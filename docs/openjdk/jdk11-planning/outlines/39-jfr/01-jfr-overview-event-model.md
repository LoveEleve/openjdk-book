# 01. JFR 全景与事件模型 — 三物件、事件生命周期

> 🔴 Deep | 域 39 JFR 第 1 篇(巨型域 6 篇之一)| Layer 4
> 读者处境: 面试"JFR 是什么/事件怎么工作"——录制器、录制、事件三物件与生命周期。

### 1. "JFR 是什么？" — 低开销可观测性

场景: 线上 JVM 行为分析——JFR 与传统 profiling 的区别

- **JFR**(Java Flight Recorder): JDK 自带的事件录制框架——**低开销**(设计目标 <1% 性能影响)
- 三物件: `FlightRecorder`(全局录制器)+ `Recording`(录制会话)+ `Event`(事件)
- 特点: 事件驱动(非采样轮询)、环形缓冲、飞行记录(事后分析)
- 关键设计 (斜体): *"JFR = 事件的持续录制 + 事后分析"——与 jstack(快照)/profiler(采样)互补;面试"JFR 与 jmap 区别"——事件流 vs 快照*
- [关联: 内部卷 32-jfr(native 录制引擎);工具: jcmd JFR.start(域 25)]

### 2. "FlightRecorder 与 Recording" — 录制器与会话

场景: 开启 JFR——谁管什么?

- `FlightRecorder.java:176` `getFlightRecorder()` — 单例门面
- `FlightRecorder.java:133` `register(Class)` — 注册事件类(事件被 JVM 认识)
- `Recording.java:168` `start()`/`close()`(341)— **会话生命周期**(录制窗口)
- `Recording.java:571` `getDuration`/`462` `setDestination`(写文件)
- 关键设计 (斜体): *"FlightRecorder=引擎,Recording=会话"——多个会话可并存(不同配置);面试"Recording 是什么"——一段可配置的录制窗口*
- 生产: jcmd JFR.start duration=60s → 会话自动结束写文件

### 3. "Event 的生命周期" — begin/end/commit

场景: 自定义事件怎么计时并提交?

- `jdk/jfr/Event.java:102` `begin()` / `110` `end()` — 标记时间窗口(start/end 时间戳)(注: 事件基类在 jdk.jfr 模块,与 java.base 的 jdk/internal/event/Event.java 是两套,后者是内部事件辅助)
- `Event.java:121` `commit()` — **提交写入**(最终动作,内部分派到录制器)
- `Event.java:131` `isEnabled()` / `144` `shouldCommit()` — **两级判断**(事件是否开启/阈值内才提交)——性能设计
- 典型模式: `event.begin(); ...; event.end(); event.commit();`(或 `event.commit()` 自动 begin/end)
- 关键设计 (斜体): *"begin/end/commit"是事件计时与写入的三步——commit 前的 isEnabled/shouldCommit 让**未开启事件零开销**(只读标志);面试"自定义事件怎么写"——继承 Event + 字段 + commit*
- 生产: 业务埋点: 继承 Event,字段加 @Label,commit 提交
- [关联: 内部卷 32-jfr(事件提交的 native 路径)]

### 4. "事件的成本设计" — 为什么 JFR 快

场景: 每秒百万事件——JFR 怎么撑住?

- 惰性: 事件未启用 → commit 是 no-op(Event.java:121 默认空实现,注入后才有行为)
- 无锁/无分配: 事件写入环形缓冲(内部卷 32),线程本地缓冲避免竞争
- 字节码注入: 事件类的 commit 由 ASM 改写(域 39 第 3 篇)——编译期形态即优化
- 关键设计 (斜体): *"未启用零成本 + 启用后低开销"是 JFR 的核心设计——判断前置(shouldCommit)在写入前;面试"JFR 为什么开销低"——惰性启用 + 环形缓冲 + 无锁写入*
- 面试: "JFR vs 日志"——日志字符串拼接有成本,JFR 结构化二进制+启用控制

---

### 核心悬念

事件怎么写?——**注解体系**让事件带元数据。@Label/@Description/@Timestamp/@Period 各控制什么?EventType 的字段怎么描述?——下一篇: 自定义事件与注解。

> → [02-custom-event-annotation.md](02-custom-event-annotation.md)
