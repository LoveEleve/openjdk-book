# 01. JFR 全景与事件模型 — 三物件、事件生命周期

> **前置依赖**: [11-thread-threadlocal/02 — ThreadLocal](../11-thread-threadlocal/02-threadlocal.md)(线程本地缓冲)、[13-atomic/01 — 原子与 CAS](../13-atomic/01-atomicinteger-cas.md)(无锁写入)
> → **后续**: [02-custom-event-annotation.md](02-custom-event-annotation.md)
> 关联: 内部卷 32-jfr(native 录制引擎);[34-jmx/02 — ObjectName 与注册](../34-jmx/02-objectname-register.md)(平台 MBean 注册)

## JFR 是什么

前 17 个域把 JVM 的机制讲完了——这一篇开始生产可观测性的收官: JFR(Java Flight Recorder),JDK 自带的事件录制框架。

## 1. "JFR 是什么?" — 低开销可观测性

### 1.1 与传统工具的区别

| 工具 | 方式 | 特点 |
|------|------|------|
| jstack | 快照 | 某个时刻的线程栈,无历史 |
| profiler | 采样 | 定期取样,有开销、需 agent |
| **JFR** | **事件录制** | 事件驱动、环形缓冲、事后分析 |

三物件: `FlightRecorder`(全局录制器)+ `Recording`(录制会话)+ `Event`(事件)。

### 1.2 特点

- 事件驱动(非采样轮询)——事件发生才写
- 环形缓冲——内存有界,溢出覆盖旧数据
- 飞行记录——录制结束后持久化到文件分析

面试"JFR 与 jmap 区别": 事件流 vs 快照——JFR 是一段窗口的持续事件,快照只是某一刻。

关键设计(斜体):*"JFR = 事件的持续录制 + 事后分析"——与 jstack(快照)/profiler(采样)互补。面试"JFR 与 jmap 区别": 事件流 vs 快照;生产: jcmd JFR.start 工具开启录制。*

## 2. "FlightRecorder 与 Recording" — 录制器与会话

### 2.1 职责划分

- **FlightRecorder** = 引擎(全局单例门面): `getFlightRecorder()`(`FlightRecorder.java:176`)获取实例;`register(Class)`(`:133`)把事件类注册给 JVM(内部转发 `MetadataRepository.getInstance().register`(`:139`))
- **Recording** = 会话(一段可配置的录制窗口): `start()`(`Recording.java:168`)、`close()`(`:341`)、`getDuration()`(`:571`)、`setDestination(Path)`(`:462`,写文件)

### 2.2 会话模型

多个会话可并存(不同配置),每个会话独立采集事件;`getDuration` 到点自动结束,`setDestination` 指定落盘路径。

面试"Recording 是什么": 一段可配置的录制窗口——start/close 界定生命周期。

关键设计(斜体):*"FlightRecorder=引擎,Recording=会话"——多个会话可并存(不同配置)。面试"Recording 是什么": 一段可配置的录制窗口;生产: jcmd JFR.start duration=60s → 会话自动结束写文件。*

## 3. "Event 的生命周期" — begin/end/commit

### 3.1 三步提交

```java
// Event.java:121-122(截取,逐字)
    final public void commit() {
    }
```

事件基类 `jdk/jfr/Event.java` 的关键方法:

| 方法 | 锚点 | 作用 |
|------|------|------|
| `begin()` | `:102` | 标记开始(空实现,注入后取 start 时间戳) |
| `end()` | `:110` | 标记结束(空实现,注入后取 end 时间戳) |
| `commit()` | `:121` | **提交写入**(默认空实现,注入后才有行为) |
| `isEnabled()` | `:131` | 至少一个录制运行且 enabled 设置开启(空实现返回 false) |
| `shouldCommit()` | `:144` | 阈值判断(enabled 开启且时长在阈值内——所有运行录制的最小阈值) |
| `set(int,Object)` | `:169` | 按索引写字段值(空实现) |

典型模式: `event.begin(); ...; event.end(); event.commit();`;或调 begin 后直接 `commit()`——未调 end 时 commit 自动补 end(`Event.java:118-120` Javadoc)。

> 注: 事件基类在 jdk.jfr 模块;java.base 的 `jdk/internal/event/Event.java` 是另一套内部事件辅助,两者不同。

### 3.2 两级判断

`isEnabled()`(事件开启?)→ `shouldCommit()`(阈值内?)→ `commit()`——两级判断都过了才真正写。

面试"自定义事件怎么写": 继承 Event + 字段 + commit 提交;业务埋点: 字段加 @Label,commit 提交。

关键设计(斜体):*"begin/end/commit"是事件计时与写入的三步——commit 前的 isEnabled/shouldCommit 让**未开启事件零开销**(只读标志)。面试"自定义事件怎么写": 继承 Event + 字段 + commit;生产: 业务埋点: 继承 Event,字段加 @Label,commit 提交。*

## 4. "事件的成本设计" — 为什么 JFR 快

### 4.1 惰性启用

事件未启用 → commit 是 **no-op**(`Event.java:121` 默认空实现,如上逐字块;注入后才有行为)——未启用事件只读一个标志,近乎零成本。

### 4.2 启用后

- **无锁/无分配**: 事件写入环形缓冲(线程本地缓冲避免竞争,内部卷 32-jfr)
- **字节码注入**: 事件类的 commit 在启用时被字节码注入改写(注入由 `jdk/jfr/internal/EventInstrumentation` 实现)——编译期形态即优化

面试"JFR 为什么开销低": 惰性启用 + 环形缓冲 + 无锁写入。

### 4.3 JFR vs 日志

日志字符串拼接有成本(格式化/IO);JFR 是结构化二进制 + 启用控制——未启用零成本,启用后低开销。

关键设计(斜体):*"未启用零成本 + 启用后低开销"是 JFR 的核心设计——判断前置(shouldCommit)在写入前。面试"JFR vs 日志": 日志字符串拼接有成本,JFR 结构化二进制 + 启用控制。*

跨层标注: [内部卷 32-jfr——事件提交的 native 路径与环形缓冲;域 13 原子——无锁写入的并发基础;域 11 线程——线程本地缓冲的归属]

## 核心悬念

事件怎么写?——**注解体系**让事件带元数据。@Label/@Description/@Timestamp/@Period 各控制什么?EventType 的字段怎么描述?——下一篇: 自定义事件与注解。

> → [02-custom-event-annotation.md](02-custom-event-annotation.md)