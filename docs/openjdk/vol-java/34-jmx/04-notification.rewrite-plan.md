# 34-jmx/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Notification`、`NotificationBroadcasterSupport`、`Monitor` 及 `CounterMonitor/GaugeMonitor/StringMonitor`。本文聚焦事件载体、监听器注册/删除、过滤与分发线程模型；远程连接器放到下一篇。
> 目标：把“通知机制”改写成一篇围绕“JMX 不只是一个属性拉取模型，它还内建了一条从 MBean 主动把变化推给监听者的事件通道；真正关键的问题不是发个对象，而是怎样描述事件、怎样管理订阅、以及默认在哪个线程里把通知送出去”展开的机制文章。

## 1. 读者困惑

- JMX 除了轮询属性，为什么还需要 Notification 这一套推送机制？
- 一个通知到底包含哪些最小信息，为什么 `type/source/sequenceNumber` 是核心三件套？
- `NotificationBroadcasterSupport` 为什么用 CopyOnWriteArrayList 存监听器，而不是普通锁保护列表？
- 通知默认是异步的吗，还是发通知的线程自己把监听器回调跑完？
- `filter`、`handback`、monitor/timer 各自解决什么问题？

## 2. 一句话顿悟

**JMX 的通知模型本质上是在“拉属性”之外再补一条“推事件”的通道。`Notification` 负责把一次变化包装成可分类、可排序、可携带附加数据的事件；`NotificationBroadcasterSupport` 负责维护监听器订阅表、先做服务器端过滤，再决定在当前线程还是注入的 Executor 中分发回调。monitor/timer 则是在这条通道之上提供轮询阈值触发和定时通知。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 `Notification` 三要素、`NotificationBroadcasterSupport` 的 CopyOnWriteArrayList、filter/handback、默认 executor 和 monitor/timer。
- 已指出默认分发线程模型是同步执行，这个细节很关键。
- 已把 monitor 放回“轮询 + 阈值 + 通知”的模型，而不是孤立组件。

### 必须重写

- 旧稿偏术语分块，需要先立住总问题：JMX 为什么不仅要拉，还要推。
- `Notification`、监听表、过滤、执行器要统一到“事件通道”主线上。
- handback 和 remove 规则要讲成订阅协议的一部分，不只是 API 参数说明。
- monitor/timer 要作为通知通道上的高级使用方式，不宜单独变成小百科。

## 4. 理解路径

### 第一节：从“为什么光有属性轮询还不够”开场

先立住总问题：轮询适合读状态，但不适合表达“现在刚发生了一个变化”。通知解决的是主动推送变化事件。

### 第二节：Notification 为什么是最小事件载体

证据：
- `Notification.java:57`
- `Notification.java:144/150/157`
- `Notification.java:183/187/188`

主线：
- `type/source/sequenceNumber` 是最小识别单元；
- `timeStamp/userData` 提供时序和附加数据；
- 说明通知是正式事件协议，不是随便回调一个对象。

### 第三节：为什么 `NotificationBroadcasterSupport` 是“订阅表 + 过滤 + 分发”三合一

证据：
- `NotificationBroadcasterSupport.java:62`
- `NotificationBroadcasterSupport.java:175/183/186/196`
- `NotificationBroadcasterSupport.java:227/235/248`
- `NotificationBroadcasterSupport.java:279/327/328/334/344`

主线：
- CopyOnWriteArrayList 适合读多写少的监听器表。
- `sendNotification` 先做 filter 预过滤，再提交执行器分发。
- `ListenerInfo` 把 listener/filter/handback 三件套捆成订阅单元。

### 第四节：通知默认为什么不是后台线程模型，而是发送线程直接执行

证据：
- `NotificationBroadcasterSupport.java:155/334/344`

主线：
- 默认 executor 是 DirectExecutor，本质上 `run()` 直接在当前线程执行。
- 只有显式注入 Executor 才变成异步解耦。
- 这解释了为什么监听器慢、阻塞或抛异常会直接影响发送线程体验。

### 第五节：`filter` / `handback` / remove 规则为什么构成完整订阅协议

证据：
- `NotificationBroadcasterSupport.java:183/201/279/296/310`
- 旧稿中的 `MBeanServer.java:489` 线索

主线：
- filter 负责服务端预过滤，减少无效回调；
- handback 是注册时绑定、回调时原样返还的上下文；
- remove 依赖 listener/filter/handback 精确匹配，重复注册会导致重复投递。

### 第六节：monitor/timer 为什么是通知通道上的内建高层构件

证据：
- `Monitor.java:75/76/135/177`
- `CounterMonitor.java:79`
- `GaugeMonitor.java:87`
- `StringMonitor.java:59`

主线：
- Monitor 通过定期采样 + 阈值判断，最终仍然是发 Notification。
- Timer 则用时间调度发通知。
- 它们说明通知通道不是只给业务手写事件用的，也是 JMX 自己的告警骨架。

## 5. 失败方案清单

1. 用高频轮询替代本来适合通知推送的变化事件。
2. 误以为通知默认异步，不考虑发送线程被监听器阻塞。
3. 重复注册同一 listener/filter/handback，导致重复投递。
4. 忽略 filter，让所有监听器都接收所有通知。
5. 把 monitor/timer 当成独立机制，不看它们本质上仍在发 Notification。

## 6. 误解清单

1. Notification 只是个普通 POJO，字段含义无关紧要。
2. `NotificationBroadcasterSupport` 只是帮忙存一下监听器列表。
3. handback 是一次性回调参数，不属于订阅关系的一部分。
4. remove listener 只看 listener 本身，filter/handback 不影响匹配。
5. monitor 比通知更“底层”。

## 7. 证据清单

- `Notification.java:57/144/150/157/183/187/188`
- `NotificationBroadcasterSupport.java:62/155/175/183/186/196/227/235/248/279/327/328/334/344`
- `Monitor.java:75/76/135/177`
- `CounterMonitor.java:79`
- `GaugeMonitor.java:87`
- `StringMonitor.java:59`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇只讲本地通知分发与内建监视器，不展开远程连接器如何传送通知。
- monitor/timer 只建立机制认知，不展开所有配置项。
- 不把 CopyOnWriteArrayList 原理扩展成并发集合专题。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 JMX 不只拉还要推 → Notification 的最小事件契约是什么 → BroadcasterSupport 如何管理订阅、过滤和分发 → 默认为什么在发送线程执行 → handback/remove 为何属于订阅协议 → monitor/timer 为什么是通知通道上的高层构件”。
- 必须把通知讲成‘JMX 事件通道’，而不是 API 清单。
- 必须自然引到 `05-remote-tools.md`。
