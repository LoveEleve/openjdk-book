# 04. 通知机制 — Notification 结构、并发分发、monitor/timer

> **前置依赖**: [34-jmx/01 — JMX 架构全景](01-jmx-architecture.md)(注册与查询)、[11-thread-threadlocal/01 — 线程生命周期](../11-thread-threadlocal/01-thread-lifecycle.md)(线程模型基础)
> → **后续**: [34-jmx/05 — JMX 远程与工具](05-remote-tools.md)
> 关联: 并发集合(CopyOnWriteArrayList);域 11 线程(分发线程模型)

## MBean 变化怎么告诉别人

查询是"拉"——应用轮询属性;通知是"推"——MBean 主动广播变化,监听者被动接收。这一篇讲事件载体 `Notification` 的结构、分发器 `NotificationBroadcasterSupport` 的并发实现与线程模型、监听器的订阅协议,以及内建监视器 monitor/timer。

## 1. "Notification 是什么" — 事件载体

`Notification`(`javax/management/Notification.java`,397 行)是事件载体,三要素 + 两个附加:

| 字段 | 源码 | 作用 |
|------|------|------|
| `type` | 构造入参(`:183`) | 字符串类别(如 `"jmx.mbean.info.changed"`) |
| `source` | 构造入参(`:183`) | 事件来源(哪个 MBean) |
| `sequenceNumber` | 字段 `:144` | 序号(排序/去重) |
| `timeStamp` | 字段 `:150` | 时间戳(`getTimeStamp`,`:304`) |
| `userData` | 字段 `:157` | 附加数据 |

(`Notification extends EventObject`(`:57`)——source 由 EventObject 提供。)

构造(`Notification.java:183-186`):

```java
// Notification.java:183-186(截取,逐字)
    public Notification(String type, Object source, long sequenceNumber) {
```

语义: **推送模型**(MBean 主动发,监听者被动收),与属性查询(拉)互补。生产用途: 告警(阈值触发)、变更同步、GC 通知(`GarbageCollectionNotificationInfo`)。

面试"JMX 推送 vs 拉取": 通知推送(MBean 主动),属性轮询拉取(应用主动)——两者互补。

关键设计(斜体):*"通知 = 事件三要素(type/source/sequence)"——type 分类、source 定位、sequence 排序。面试"JMX 推送 vs 拉取": 通知推送,属性轮询拉取;生产: 告警/变更同步/GC 通知。*

## 2. "NotificationBroadcasterSupport" — 分发器

### 2.1 监听表: CopyOnWriteArrayList

`NotificationBroadcasterSupport`(`javax/management/NotificationBroadcasterSupport.java`,367 行)用 **CopyOnWriteArrayList** 存监听器:

```java
// NotificationBroadcasterSupport.java:327-328(逐字)
    private List<ListenerInfo> listenerList =
        new CopyOnWriteArrayList<ListenerInfo>();
```

元素是 `ListenerInfo`(`:279-290`): `listener` + `filter` + `handback` 三字段。读多写少 → CopyOnWrite(写时复制)。

### 2.2 sendNotification: filter 预过滤 + 分发

`sendNotification`(`:227-251`)的核心:

```java
// NotificationBroadcasterSupport.java:235-250(截取,逐字)
        for (ListenerInfo li : listenerList) {
            try {
                enabled = li.filter == null ||
                    li.filter.isNotificationEnabled(notification);
            } catch (Exception e) {
                ...
                continue;
            }

            if (enabled) {
                executor.execute(new SendNotifJob(notification, li));
            }
        }
```

- **filter 预过滤**(`:237-238`): 每个监听器可带 filter,不匹配的直接跳过——减少无谓回调
- **executor.execute**(`:248`): 分发交给 `SendNotifJob`(`:344-363`,run 里 `handleNotification` → `listener.handleNotification(notif, handback)`)
- **线程模型**: 默认 `defaultExecutor`(`:334-339`)是 DirectExecutor——**在调用线程同步执行**(r.run());构造时注入 `Executor` 后变异步

面试"通知分发线程模型": 默认调用线程同步执行,可注入 Executor 异步解耦;面试"filter 干什么": 服务端预过滤,减少无谓回调。

关键设计(斜体):*"CopyOnWrite 监听表 + Executor 分发"是事件框架的标准工程形态——读多写少 + 异步解耦。面试"通知分发线程模型": 默认调用线程,可 Executor 异步;面试"filter 干什么": ListenerInfo 里的 NotificationFilter 预过滤。*

## 3. "监听器注册与去重" — 协议

### 3.1 三件套注册

`addNotificationListener(listener, filter, handback)`(`:175-184`): `listenerList.add(new ListenerInfo(listener, filter, handback))`(`:183`)。

两个要点:

- **listener 为 null** 抛 `IllegalArgumentException`(`:179-181`)
- **重复添加不抛异常**——CopyOnWriteArrayList 允许重复条目,同一监听器会收到多次通知。不要重复注册(容易踩的坑: 重复注册导致通知重复投递)

`removeNotificationListener`(`:186-194`): 按 `ListenerInfo.equals` 精确匹配(listener+filter+handback 全等,`:300-301`)删除,找不到抛 `ListenerNotFoundException`。MBeanServer 层的对应方法在 `MBeanServer.java:489`。

### 3.2 filter 与 handback

- **filter**: 服务端预过滤(`isNotificationEnabled`,`:238`)
- **handback**: 注册时给的"回调上下文"对象——通知送达时**原样传回**(`handleNotification` 的第三参,`:273-276`),监听器用它区分订阅场景

面试"handback 是什么": 回调时原样传回的数据(订阅上下文);生产: 订阅管理(启动 add/关闭 remove)防泄漏。

关键设计(斜体):*"listener + filter + handback 三件套"是通知订阅的标准接口——filter 服务端过滤,handback 回调上下文。面试"handback 是什么": 回调时原样传回的数据;生产: 订阅管理防泄漏(重复注册会导致重复投递)。*

## 4. "monitor 与 timer" — 内建监视器

### 4.1 三个监视器

`javax/management/monitor/` 包提供**轮询采样 + 阈值判定 + 通知**的监视器:

| 监视器 | 源码 | 语义 |
|--------|------|------|
| `CounterMonitor` | `:79` | 计数超阈值 |
| `GaugeMonitor` | `:87` | 区间判定(上下界) |
| `StringMonitor` | `:59` | 字符串匹配 |

轮询由 `Monitor` 基类驱动(`Monitor.java:75`,注意它**继承 NotificationBroadcasterSupport**——`:76`,监视器的通知能力来自分发器),内部用共享的 `ScheduledExecutorService` 按周期调度采样任务(`:177`/`:712-716`),粒度 `granularityPeriod`(默认 10 秒,`:624` 注释)。`javax/management/timer/` 的 `Timer` 则提供定时触发通知。

### 4.2 现代替代

老式但标准的告警雏形——现代生产直接用外部监控系统采集指标(暴露指标 + 外部拉取),monitor 已边缘化。

面试"JMX 怎么告警": monitor 或自定义通知;现代方案是外部监控系统采集。

关键设计(斜体):*"内建监视器 = 轮询 + 阈值判定 + 通知"——老式但标准的告警雏形。面试"JMX 怎么告警": monitor 或自定义通知;现代生产用外部监控系统直接采集指标,monitor 已边缘化。*

跨层标注: [并发集合——CopyOnWriteArrayList(写时复制,读多写少)是监听器表的并发基础;域 11 线程——分发线程模型(调用线程 vs Executor 线程)]

## 核心悬念

本地机制通了——**跨进程怎么管理**?JConsole 连接远程 JVM 的通道: `JMXConnectorServer` + RMI 协议适配。远程代理怎么"翻译"本地调用?——下一篇: JMX 远程与工具。

> → [34-jmx/05 — JMX 远程与工具](05-remote-tools.md)
