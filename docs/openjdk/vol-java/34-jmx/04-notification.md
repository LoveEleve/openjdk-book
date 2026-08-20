# 通知机制：为什么 JMX 不只会拉属性，还内建了一条从 MBean 主动推送变化的事件通道

> 本文基于 JDK 11 `Notification`、`NotificationBroadcasterSupport`、`Monitor` 及 `CounterMonitor/GaugeMonitor/StringMonitor`。本文聚焦事件载体、监听器注册/删除、过滤与分发线程模型；远程连接器放到下一篇。本文讨论的是 JDK 11 JMX 本地通知通道机制，不把这里的监听器管理方式、默认分发线程模型和 monitor/timer 的组织形式外推成所有事件系统都必须遵守的统一规范。
> **前置依赖**：[JMX 架构全景](01-jmx-architecture.md)、[线程生命周期](../11-thread-threadlocal/01-thread-lifecycle.md)
> **后续**：[JMX 远程与工具](05-remote-tools.md)

## 先看一个很容易被忽略的问题：如果管理端总是靠轮询，很多“刚刚发生的变化”就会天然丢失时机

前面几篇一直在讲属性、操作和查询，很容易让人形成一种印象：JMX 就是一个“管理端定期来读状态”的模型。这个模型当然重要，但它只擅长回答“现在值是多少”，不擅长回答“刚才发生了一个什么变化”。

如果你关心的是：

- 某个阈值刚刚被突破；
- 某个配置对象刚刚发生切换；
- 某次 GC 刚刚完成；
- 某个运行时资源刚刚进入异常状态；

那么单纯靠轮询往往不是最好的表达方式。管理端要么轮询太慢，错过时间点；要么轮询太频繁，成本高而且噪声大。

这也就是 JMX 为什么除了“拉属性”之外，还专门内建了一套“推通知”的模型。`Notification` 并不是顺手补的消息对象，而是 JMX 管理协议里的第二条通道：当 MBean 认为某件事值得主动告知外部时，它可以自己发出一个正式事件，让监听者被动接收。

所以这一篇真正要讲的，不是“有个通知类可以用”，而是：**JMX 怎样把变化事件做成一条可订阅、可过滤、可同步或异步分发的事件通道。**

## 一、为什么 `Notification` 是最小事件契约：JMX 推送的不是任意对象，而是正式事件

### 先看它至少包含什么

JDK 11 里，`Notification` 定义在 `Notification.java:57`，继承自 `EventObject`。它的核心字段包括：

- `sequenceNumber`：`Notification.java:144`
- `timeStamp`：`150`
- `userData`：`157`

最常见构造器则在：

- `Notification(String type, Object source, long sequenceNumber)`：`Notification.java:183`
- 其中会设置 `sequenceNumber`：`187`
- 并默认打上当前 `timeStamp`：`188`

这已经足够说明，Notification 不是“随手丢个对象出去”，而是一种正式事件载体。

### 为什么 `type/source/sequenceNumber` 是它的最小骨架

哪怕不看所有重载构造器，最小 Notification 也已经把三个问题固定下来了：

- **type**：这到底是哪一类事件；
- **source**：它是谁发出来的；
- **sequenceNumber**：同一来源的事件先后顺序如何区分。

再加上时间戳和 `userData`，这个事件就不仅能说“发生了某事”，还能带上时序和附加上下文。

所以 JMX 推送模型并不是“回调某个监听器方法”这么简单，它先要求所有变化先被压成统一事件契约。没有这层统一，远程端和本地端都很难稳定理解通知语义。

## 二、为什么 `NotificationBroadcasterSupport` 要把监听器表、过滤和分发放在同一个类里：它管的不是“存几个回调”，而是一整套订阅协议

### 先看它维护了什么

JDK 11 里，`NotificationBroadcasterSupport` 定义在 `NotificationBroadcasterSupport.java:62`。核心方法和结构包括：

- `addNotificationListener(...)`：`175`
- `removeNotificationListener(...)`：`186` / `196`
- `sendNotification(...)`：`227`
- `ListenerInfo`：`279`
- 监听器表字段：`327`
- 实际使用 `CopyOnWriteArrayList`：`328`

这里最值得注意的不是“它有个列表”，而是它把一次完整订阅关系收束成了 `ListenerInfo`：

- listener
- filter
- handback

这三者不是可有可无的附加参数，而是同一个订阅单元的三个部分。

### 为什么监听器表选 `CopyOnWriteArrayList`

Notification 机制面对的典型场景是：

- 注册/删除监听器相对少；
- 发通知时遍历监听器相对多。

这正是 `CopyOnWriteArrayList` 最擅长的模式：读多写少。监听器遍历时可以拿到稳定快照，不必为每次发送都重锁整个列表；而写入虽然要复制，但频率通常远低于通知分发次数。

所以这里的数据结构选择本身就在表达 JMX 通知模型的工程假设：**监听关系变化相对稀疏，事件分发相对频繁。**

## 三、为什么 `sendNotification` 不是“循环回调一下监听器”那么简单：它先做服务端过滤，再决定如何分发

### 先看发送链路里真正发生了什么

旧稿已经抓到了最关键的发送片段：

- `sendNotification(...)`：`NotificationBroadcasterSupport.java:227`
- 遍历监听器：`235`
- `filter.isNotificationEnabled(...)`：过滤判断发生在发送前
- 满足条件后 `executor.execute(new SendNotifJob(...))`：`248`
- `SendNotifJob`：`344`

这条链路说明，通知发送并不是“有一个事件就盲目通知所有监听器”。它先在发送端做一轮过滤：

- filter 为 null，表示默认接收；
- filter 存在时，先问它这个 Notification 对当前订阅是否有效；
- 只有启用的监听器才真正进入执行器分发路径。

### 为什么 filter 是服务端预过滤，而不是客户端自己再判断

如果每个监听器都必须先收到所有通知，再自己决定要不要处理，那么发送端会做大量无意义回调，远程场景下还会平白放大传输与处理成本。filter 的价值就在于：**订阅关系里直接声明“我只对哪些通知感兴趣”，由发送端在分发前先裁掉无关回调。**

这让 Notification 机制不是“广播后全靠监听器自己扛”，而是一条有预过滤能力的事件通道。

## 四、为什么通知默认不是后台异步线程，而是发送线程自己跑回调：线程模型是这套机制最容易踩坑的地方

### 先看默认 executor 的位置

JDK 11 里：

- 构造时 executor 选择在 `NotificationBroadcasterSupport.java:155`
- 默认 executor 定义在 `334`
- 真正提交分发任务在 `248`

旧稿已经抓到了最关键的事实：默认 executor 本质上就是一个 DirectExecutor，它不是把工作扔给后台线程池，而是直接在当前线程执行 `run()`。

### 为什么这个默认值很重要

这意味着：如果你没有显式给 `NotificationBroadcasterSupport` 注入自定义 `Executor`，那么谁调用了 `sendNotification(...)`，谁就会顺手把所有监听器回调跑完。

这个默认值带来两个直接后果：

- 好处是简单、少线程切换、少额外调度；
- 代价是监听器一旦慢、阻塞或抛出复杂异常，发送线程的体验会直接被拖累。

所以通知机制的线程模型不能被想当然地当成“天然异步”。JMX 这里的设计更保守：**默认同步，按需异步。** 只有当你明确注入一个 executor，这条通道才真正和发送线程解耦。

## 五、为什么 `filter`、`handback`、remove 精确匹配一起才构成完整订阅协议

### `handback` 不是多余参数，而是订阅上下文的一部分

很多人第一次看 `handback` 会觉得它只是“顺手带个对象”。但如果从订阅协议角度看，它的角色非常明确：**注册时给出去，回调时原样拿回来。**

这让同一个监听器即使订阅多个来源、多类通知，也能在回调时通过 handback 恢复出当初注册这条订阅时绑定的上下文。

所以 handback 不是事件数据本身，而是订阅关系自己的上下文。

### 为什么 remove 不是只看 listener

旧稿已经抓到 `ListenerInfo` 的相等规则与 remove 语义：删除时并不是“同一个 listener 就行”，而是要按 listener / filter / handback 的组合精确匹配。找不到对应订阅，就会抛 `ListenerNotFoundException`。

这说明在 JMX 看来，一次完整订阅不是“我加了一个 listener”，而是“我加了一条 listener + filter + handback 的订阅记录”。

### 为什么重复注册会导致重复投递

因为底层列表允许同一 listener 以相同或不同组合重复添加。JMX 不会自动帮你去重，它尊重订阅记录本身。所以如果你在应用生命周期里多次 add 却不对应 remove，后果不是“后面的覆盖前面的”，而是同一通知会被重复投递多次。

这也是通知机制最常见的工程坑之一：**订阅本身也是资源，需要成对管理。**

## 六、为什么 monitor/timer 不是通知体系外的独立玩具：它们本质上是通知通道上的内建高层构件

### 先看 `Monitor` 站在什么位置

JDK 11 里：

- `Monitor` 定义在 `Monitor.java:75`
- 它直接 `extends NotificationBroadcasterSupport`：`76`
- 默认 `granularityPeriod` 在 `135`
- 共享 `ScheduledExecutorService` 在 `177`

具体三种监视器类是：

- `CounterMonitor`：`CounterMonitor.java:79`
- `GaugeMonitor`：`GaugeMonitor.java:87`
- `StringMonitor`：`StringMonitor.java:59`

这组继承关系非常重要，因为它直接证明：monitor 并不是另一套通知系统，它本质上还是在发 Notification，只不过在通知之前，先加了一层“定期采样 + 条件判断”。

### 为什么这说明 JMX 的推送模型既能手写事件，也能内建阈值告警

monitor 这一层解决的是一种非常典型的管理需求：不是每次属性变化都发通知，而是定期采样某个值，只有在越过阈值、进入区间或满足字符串条件时才触发通知。

所以它等于在基础通知通道上又搭了一层高层告警语义：

- 轮询采样；
- 条件判定；
- 满足条件后发 Notification。

Timer 也是这一思路：不是业务自己随时决定发，而是由时间调度触发通知。它们都说明通知通道不仅能承载手写事件，也能承载 JMX 自带的监控骨架。

## 七、五个最容易混掉的边界：Notification 不是随手回调对象，BroadcasterSupport 不是监听器列表工具，filter 不是客户端自觉，默认分发不是天然异步，monitor 也不是独立体系

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`Notification` 不是“随手丢个对象给监听器”的临时回调载体。它真正承担的是正式事件契约：类型、来源、序号、时间戳和用户数据都要被明确压进一个标准结构里，远程端和本地端才能稳定理解它。

第二，`NotificationBroadcasterSupport` 也不是简单帮你存监听器列表的小工具。它同时托管的是订阅记录、服务端过滤、执行器分发和删除匹配语义；少看任何一层，都会把通知机制误解成“for 循环回调一下”。

第三，`filter` 更不是监听器收到事件后再自己决定要不要处理的自觉动作。JMX 的设计是让发送端在分发前先裁掉不匹配订阅，从而减少无效回调和远程噪声，这才是服务端过滤真正值钱的地方。

第四，通知默认也不是天然异步。没有显式 executor 时，发送线程自己就会把回调跑完；这意味着监听器慢、阻塞或抛复杂异常时，首先被拖住的不是后台线程，而是当前发通知的那个线程。

第五，monitor/timer 更不是通知体系外另起一套机制。它们本质上仍然是在这条 Notification 通道上工作，只不过前面再加了一层“定期采样 + 条件判断”或“按时间触发”的高层语义。

把这五条边界记稳，通知机制这一篇就不会重新塌回“JMX 里还有个回调 API”这种表面印象。它真正想讲的是：JMX 在属性拉取模型之外，又明确补了一条可描述事件、可管理订阅、可控制分发线程的正式推送通道。

## 收网：JMX 的通知机制真正补上的，是在“拉属性”之外再建一条“推变化”的正式事件通道

现在可以把整篇压成一条主线：

- `Notification` 把变化包装成正式事件契约；
- `NotificationBroadcasterSupport` 维护 listener/filter/handback 这套完整订阅关系；
- `sendNotification` 先做服务端过滤，再交由 executor 分发；
- 默认线程模型是发送线程同步执行，不是天然异步；
- remove 精确匹配和 handback 一起构成完整订阅协议；
- monitor/timer 则是在通知通道之上继续搭出的内建高层构件。

所以理解 JMX Notification 的正确角度，不是“有个回调 API 可以用”，而是：**JMX 在属性拉取模型之外，又正式建立了一条可描述事件、可管理订阅、可控制线程模型的推送通道。** 一旦这条通道成立，阈值告警、状态变化、GC 通知、远程管理事件才真正有了统一出口。

下一篇自然就会把这条本地管理与通知模型进一步推出 JVM 进程边界：一旦管理端不在同一个进程里，`JMXConnectorServer`、RMI 和远程代理怎样把本地 MBeanServer 变成可远程调用的管理入口，这就是 `05-remote-tools.md` 要接着回答的问题。
