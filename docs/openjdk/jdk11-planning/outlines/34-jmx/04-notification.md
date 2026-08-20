# 04. 通知机制 — Notification 结构、并发分发、monitor/timer

> 🟡 Working | 域 34 JMX 第 4 篇(巨型域 6 篇之四)| Layer 4
> 读者处境: 生产告警/变更通知——JMX 的推送机制怎么工作,谁分发、怎么保证安全。

### 1. "Notification 是什么？" — 事件载体

场景: MBean 状态变化——怎么告诉监听者?

- `Notification.java:397` — 结构: `type`(字符串类别)+ `source` + `sequenceNumber`(183 构造)+ timeStamp(304)+ userData
- 继承: AttributeChangeNotification(属性变更专用,含新旧值)
- 语义: **推送模型**(MBean 主动发,监听者被动收)——与查询(拉)互补
- 关键设计 (斜体): *"通知 = 事件三要素(type/source/sequence)"——type 分类、source 定位、sequence 排序;面试"JMX 推送 vs 拉取"——通知推送,属性轮询拉取*
- 生产: 告警(阈值触发)、变更同步、GC 通知(GarbageCollectionNotificationInfo)

### 2. "NotificationBroadcasterSupport" — 分发器

场景: `sendNotification(n)` — 通知怎么到监听者手里?

- `NotificationBroadcasterSupport.java:175` `addNotificationListener` — **注册监听器**(ListenerInfo 包 listener+filter+handback)
- `NotificationBroadcasterSupport.java:328` — `listenerList = new CopyOnWriteArrayList<>()` — **并发安全监听器表**(域 10)
- `sendNotification`(227)→ `notifyListeners`(235)→ **executor.execute(new SendNotifJob(...))**(248)— **异步分发**
- `334` — defaultExecutor(默认同步,可注入 Executor 异步)
- 关键设计 (斜体): *"CopyOnWrite 监听表 + Executor 分发"是事件框架的标准工程形态——读多写少(域 10)+ 异步解耦;面试"通知分发线程模型"——默认调用线程,可 Executor 异步*
- [关联: 域 10 CopyOnWriteArrayList(监听器表并发基础)、域 14 线程池(Executor 分发线程)]
- 面试: "filter 干什么"——ListenerInfo 里的 NotificationFilter 预过滤(减少无谓回调)

### 3. "监听器注册与去重" — 协议

场景: 注册监听器的完整契约

- `addNotificationListener(listener, filter, handback)`(175): 一个监听器可带 filter + handback(回调附加数据)
- 重复注册: 同 listener 同 filter 重复添加会抛 IllegalArgumentException(避免重复通知)
- `removeNotificationListener`(MBeanServer:489)
- 关键设计 (斜体): *"listener + filter + handback 三件套"是通知订阅的标准接口——filter 服务端过滤,handback 回调上下文;面试"手back 是什么"——回调时原样传回的数据*
- 生产: 订阅管理(启动 add/关闭 remove)防泄漏(与域 03 监听器泄漏同思想)

### 4. "monitor 与 timer" — 内建监视器

场景: 想"定时检查属性超阈值"——JMX 内建方案

- `javax/management/monitor/` — **CounterMonitor**(79,计数超阈值)/GaugeMonitor(区间)/StringMonitor(字符串匹配)——**轮询采样**(默认周期)+ 阈值通知
- `javax/management/timer/` — Timer(定时触发通知)
- 关键设计 (斜体): *"内建监视器 = 轮询 + 阈值判定 + 通知"——老式但标准的告警雏形;面试"JMX 怎么告警"——monitor 或自定义通知;现代生产用外部监控(域外)*
- 生产: 现代系统直接暴露指标(域 34 第 6 篇),monitor 已边缘化

---

### 核心悬念

本地机制通了——**跨进程怎么管理**?JConsole 连接远程 JVM 的通道:`JMXConnectorServer` + RMI 协议适配。远程代理怎么"翻译"本地调用?——下一篇: JMX 远程与工具。

> → [05-remote-tools.md](05-remote-tools.md)
