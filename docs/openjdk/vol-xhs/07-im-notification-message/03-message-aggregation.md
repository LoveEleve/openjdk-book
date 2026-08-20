# 通知聚合与未读计数

> 对应目录：`vol-xhs/07-im-notification-message/`
> 目标问题：为什么通知系统不能每来一条事件就原样插一条通知、顺手把红点加一？`my-xhs` 当前为什么要把通知聚合、未读计数和对账修复拆成独立收敛链？

## 一句话困惑

上一章已经把 SSE 通知主链立住了：

- 上游事件进入 `NOTIFICATION_TOPIC`
- 通知服务消费事件
- 在线用户通过 SSE 立即感知

但这还没有回答一个更难的问题：**当同类事件不断打进来时，通知列表和未读红点到底怎样收敛，才不会一边刷屏、一边失真？**

如果只用最直觉的方式处理通知：

- 每来一条事件就插一条记录
- 每来一条事件就把未读数 +1
- 用户已读时再 -1

实现当然简单，但很快就会遇到两个现实问题：

1. 同类通知会刷屏，用户体验很差。
2. 未读数和通知列表并不是一回事，它们各自都有独立的并发边界和故障恢复问题。

也就是说，这一篇真正要讲的，不是“SSE 再推了一条消息”，而是：**通知内容和未读数怎样被当前系统分别收敛，最后又怎样重新对齐。**

## 一句话答案

当前 `my-xhs` 把通知聚合和未读计数拆成了两条并行收敛链：通知列表通过 `NotificationAggregator` 把同一用户、同一类型、同一目标在窗口内合成一条主通知；未读数则由 `UnreadCountService` 在 Redis 里单独维护总数和分类计数，再由 `UnreadReconcileJob` 用数据库对账修复。也就是说，通知系统维护的不是“一张通知表”，而是“通知内容视图 + 未读数视图”两套状态。

## 先建立最小心智模型

先把当前通知收敛链压成最小图：

```text
上游业务事件
  → NotificationEventConsumer 幂等消费
    → NotificationAggregator 先决定是否聚合
      → NotificationService 再决定未读数是否增加
        → UnreadCountService 维护 Redis 视图
          → UnreadReconcileJob 兜底修复
```

这张图里最重要的判断是：**通知内容和未读计数在当前实现里是两条并行视图，而不是同一个字段的不同名字。**

## 先推演第一个最直觉的失败方案：每条事件原样落一条通知，永不聚合

这是最容易想到的通知模型。

### 为什么这个方案很诱人

因为它简单而且“准确”：

- 谁点了赞就插一条
- 谁评了论就插一条
- 谁关注了你就插一条

从事件到记录几乎是 1:1 对应，看起来最不容易丢信息。

### 它会先坏在哪里

它会先坏在“通知是给人看的，不只是给系统留档的”。

如果某个用户在短时间内连续点赞同一篇笔记 10 次，系统若毫无聚合地插 10 条通知：

- 列表会迅速刷屏
- 红点会被成片抬高
- 用户感知到的不是“有人在跟你互动”，而是“系统在疯狂刷消息”

从当前实现先做聚合、再决定是否新增通知主记录的路径来看，系统并不接受这个代价，所以它在通知本体落库之前就先做聚合。

## 再推演第二个失败方案：通知聚合以后，未读数就等于通知条数

即使接受了“通知需要聚合”，另一个也很自然的误解是：聚合之后剩多少条通知，未读红点就等于多少。

### 为什么这个方案也很诱人

因为它看起来统一：

- 通知条数就是用户看到的提醒数
- 未读数就是列表里 `is_read=0` 的 count

逻辑上似乎很干净。

### 它为什么在当前实现里不成立

它会先坏在“聚合更新”和“新增通知”不是同一种事件上。

`NotificationService.processEvent()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:61` 到 `:69` 已经把这件事讲透了：

- 如果这次事件生成了一条新通知 → 未读数 +1
- 如果这次事件只是把已有主通知聚合更新了 → 未读数不再增加

也就是说，当前系统的未读数不是“通知表条数的镜像”，而是另一套业务语义：

```text
用户是否需要被再次提醒
```

这也是为什么通知聚合和未读计数必须拆成两条链来讲。

## 第一步：通知聚合先决定“这次事件该不该变成新通知”

`NotificationAggregator` 的注释在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationAggregator.java:24` 到 `:39` 中，已经把设计说明得非常清楚：

- 同一用户、同一类型、同一目标，在窗口内合并
- 第一条通知直接插入
- 后续通知只更新主通知
- 被聚合的通知本身不再单独写 DB

这说明当前实现对通知的理解不是“每个事件一条通知”，而是：**每一批语义相近的事件，最终只需要有一个对用户可见的主通知。**

### 当前聚合窗口到底是什么

`NotificationAggregator` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationAggregator.java:27` 到 `:34` 里说的是“同一天时间窗口”；实现里 `getAggregateWindow()` 又把 TTL 设置成“当天剩余秒数”，见 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationAggregator.java:50` 到 `:56`。

也就是说，当前实现不是一个固定 5 分钟滑窗，而是按自然日对齐的聚合锁存活时间。对用户来说，这意味着同一天里同类型、同目标的互动会被持续折叠进同一条主通知。

## 第二步：聚合不是简单查一下有没有旧记录，而是先拿 Redis 窗口锁再决定走哪条路径

聚合器最重要的实现不在 SQL，而在 Redis 窗口锁。

`processWithAggregate()` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationAggregator.java:104` 到 `:198` 中：

1. 先构造聚合 key：`userId:type:targetId`
2. 用 Lua 脚本原子做 `SETNX + 写入主通知 ID`
3. 如果是窗口内第一条，就 `INSERT`
4. 如果窗口内已有主通知，就原子递增聚合计数并更新标题

这说明聚合链不是“先查数据库，再 decide update/insert”，而是：

```text
Redis 先裁定这是一个新窗口还是旧窗口
DB 再按这个结果落通知内容
```

### 为什么这里一定要先用 Redis

因为如果直接在数据库里“查一下有没有聚合主通知”，并发下很容易两个线程都觉得自己是第一条，最后插出两条本该合并的通知。

当前实现通过 Redis 窗口锁先把“谁有资格成为窗口内第一条”收窄掉，再让数据库跟着收敛。

## 第三步：通知内容视图和未读数视图在当前实现里是两套状态机

这是整篇最重要的地方。

### 通知内容视图关心什么

通知内容视图关心的是：

- 列表里到底显示哪几条通知
- 每条通知的标题、内容、发送者、目标对象是什么
- 某条通知是否是聚合后的主通知
- `aggregateCount` 当前是多少

这些信息主要落在：

- `Notification` 实体，见 `my-xhs-notification/src/main/java/com/myxhs/notification/entity/Notification.java:20` 到 `:63`
- `NotificationAggregator`
- `NotificationMapper.incrementAggregateCount()` / `updateAggregateTitle()`，见 `my-xhs-notification/src/main/java/com/myxhs/notification/mapper/NotificationMapper.java:42` 到 `:61`

### 未读数视图关心什么

未读数视图关心的是另一件事：

- 现在总共有多少未读
- 每种类型各有多少未读
- 标记已读后如何原子减少
- Redis 漂移了以后怎么修回来

这些逻辑被专门放在 `UnreadCountService`，见 `my-xhs-notification/src/main/java/com/myxhs/notification/service/UnreadCountService.java:15` 到 `:23`。

这里还要把两层真相关系说清楚：

- 通知内容视图的真相最终落在 `t_notification` 和 `aggregateCount` 这些数据库字段
- 未读数视图为了高频读写先驻留在 Redis，再由 `UnreadReconcileJob` 用数据库未读行数把它拉回真相

当前实现甚至把总未读和分类未读拆成两套 Redis 结构：

- 总未读：String
- 分类未读：Hash

这说明未读数不是“顺手 count 一下”，而是一份明确设计过的独立视图。

## 第四步：为什么未读数必须独立维护，而不是每次查列表时实时 count

如果只从正确性出发，当然可以每次查列表时实时 `count(*) where is_read=0`。

但当前实现并不想这么做，因为未读数在产品里是高频、小粒度、强感知的状态：

- 首页角标要查
- 通知页面要查
- SSE 推送时还要增量告诉前端红点变化

这类状态如果每次都去扫表，成本很高，也很难和聚合更新保持细粒度联动。

所以 `UnreadCountService` 选择：

- 新通知到达时 `INCR`
- 已读时 `DECR`
- 按类型重置时用 Lua 原子减总数再清零分类数

对应代码见：

- 增加未读：`my-xhs-notification/src/main/java/com/myxhs/notification/service/UnreadCountService.java:90` 到 `:98`
- 减少未读：`my-xhs-notification/src/main/java/com/myxhs/notification/service/UnreadCountService.java:100` 到 `:113`
- 按类型重置：`my-xhs-notification/src/main/java/com/myxhs/notification/service/UnreadCountService.java:123` 到 `:131`

这说明未读数在当前实现里更像一个缓存化状态机，而不是列表查询副产物。

## 第五步：已读不是“把某条通知改成 is_read=1”这么简单

`NotificationMapper` 虽然提供了：

- `markAsRead()`
- `markAllReadByType()`
- `markAllAsRead()`

见 `my-xhs-notification/src/main/java/com/myxhs/notification/mapper/NotificationMapper.java:13` 到 `:32`。

但 `NotificationService` 并没有把已读当作单表 update 结束，而是：

- 改通知表状态
- 再同步调 `UnreadCountService` 把 Redis 里的总未读和分类未读一起收敛

见 `my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:118` 到 `:155`。

也就是说，在当前实现里，“已读”其实是通知内容视图和未读数视图的双重状态推进。

## 第六步：对账任务承认 Redis 视图和 DB 真相会漂移

`UnreadReconcileJob` 在 `my-xhs-notification/src/main/java/com/myxhs/notification/job/UnreadReconcileJob.java:17` 到 `:31` 中，非常诚实地承认了三类漂移来源：

- Redis 主从切换丢 INCR/DECR
- 并发标记已读极端漏减
- 系统异常导致 INCR 成功但 DB 写入失败

也就是说，当前实现并不假装“Redis 计数永远准确”，而是明确准备了一条：

```text
Redis 视图先承载高频读写
DB 再作为最终对账基准把它拉回正确状态
```

### 为什么这里是以 DB 为准修 Redis

这和优惠券、库存那类“Redis 实时权威”很不一样。

通知未读数最终要和“哪些通知行确实还是未读”对齐，所以 `UnreadReconcileJob` 以 DB COUNT 为准修 Redis，见 `my-xhs-notification/src/main/java/com/myxhs/notification/job/UnreadReconcileJob.java:90` 到 `:101`。

这说明当前系统对不同视图的权威性判断并不一样：

- 通知内容表是真相
- Redis 未读数是高频投影视图

这条分工还带来一个重要的工程边界：对账任务修复的不是所有通知问题，而主要是“数据库未读行数”和 Redis 未读视图之间的数值漂移。它不能自动修复：

- 聚合窗口判断错误导致的重复主通知；
- SSE 已经推送但客户端没有正确处理；
- Redis Pub/Sub 丢失造成的在线即时提醒缺席；
- 通知模板渲染错误或上游事件本身字段缺失。

也就是说，`UnreadReconcileJob` 解决的是**计数视图漂移**，不是整个通知系统的通用回放器。通知内容、未读计数和在线推送三条链仍然需要分别验证，不能因为对账任务存在，就把通知链写成“最终自动修复所有问题”。

## 真实故障案例：为什么通知系统最危险的错误，不是多出一条聚合消息，而是红点和列表开始说不同的话

通知聚合链最容易被低估的故障，不在于“标题多显示了一个人名”，而在于两个用户最敏感的反馈源——通知列表和红点——开始分裂。

### 现象

用户可能看到：

- 列表里明明有新的聚合通知，但红点没加
- 红点已经归零，列表里却还有一堆未读
- 跨实例 SSE 已经把未读数推过去了，但页面刷新后又回到旧值

### 根因

根因通常不是某一条 SQL，而是：

- 聚合链判断“是否新增通知”和“是否只更新主通知”
- 未读计数链判断“是否应该 +1 / -1 / reset”
- SSE 只是把当前视图推给前端

只要这三条链中有一条慢了、错了或漂移了，用户感知就会立刻出现冲突。

### 修复

当前实现的修法不是试图把所有动作塞回一个事务，而是：

1. 通知聚合先决定“新增还是合并”
2. 未读数服务独立维护 Redis 视图
3. `UnreadReconcileJob` 定时用 DB 把 Redis 拉回真相

### 验证

验证这类问题，不能只测一条通知有没有推到，而要同时看：

- 通知表是否新增/聚合正确
- `aggregateCount` 是否按预期递增
- Redis 总未读和分类未读是否同步变化
- 对账任务能否把漂移修回来

### 余波

这个案例说明，**通知系统真正难的不是“合并一条消息”，而是“让消息列表和红点这两份用户感知视图长期保持同一世界”。**

## 这一篇先收束成一张总图

```text
业务事件
  → NotificationEventConsumer 幂等消费
    → NotificationAggregator 判断新增 / 聚合更新
      → Notification 表形成内容视图
        → UnreadCountService 维护 Redis 未读视图
          → 已读操作双向收敛
            → UnreadReconcileJob 定期以 DB 修 Redis
```

这里最重要的不是背表名，而是三条判断：

1. 通知聚合和未读计数在当前实现里是两条并行收敛链，不是同一个字段的不同视图。
2. 聚合链关注“用户该看到几条通知”，未读链关注“用户现在还剩几次需要被提醒的机会”。
3. 当前系统不假设 Redis 未读视图永远正确，而是明确用对账任务把它拉回数据库真相。

## 证据清单

这篇的关键判断主要由以下证据托底：

- NotificationAggregator 聚合窗口与 SETNX：`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationAggregator.java:24`、`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationAggregator.java:68`
- 聚合计数原子递增与标题更新：`my-xhs-notification/src/main/java/com/myxhs/notification/mapper/NotificationMapper.java:42`
- Notification 实体的聚合字段：`my-xhs-notification/src/main/java/com/myxhs/notification/entity/Notification.java:47`
- NotificationService 在新增/聚合更新时区别处理未读数：`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:47`
- UnreadCountService 独立视图：`my-xhs-notification/src/main/java/com/myxhs/notification/service/UnreadCountService.java:15`
- 已读入口与已读链联动未读数：`my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:103`、`my-xhs-notification/src/main/java/com/myxhs/notification/controller/NotificationController.java:115`、`my-xhs-notification/src/main/java/com/myxhs/notification/service/NotificationService.java:118`
- 未读对账修复：`my-xhs-notification/src/main/java/com/myxhs/notification/job/UnreadReconcileJob.java:17`

## 边界清单

- 本篇聚焦通知聚合和未读计数收敛，不展开 SSE 推送链与跨实例路由实现，这已在上一章建立。
- 当前聚合窗口、模板缓存 TTL 和对账频率都属于实现参数，不应误写成业务绝对常量。
- 本篇默认通知内容已经被 NotificationService 渲染完成，不再重复展开模板渲染细节。
- 这里讨论的是通知聚合，不等于 IM 会话聚合；两者虽然都叫“消息”，但语义完全不同。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么通知系统不能只靠“每事件一条通知 + count(*) 未读”工作下去。
- 为什么聚合通知和未读红点在当前实现里必须拆成两条独立收敛链。
- 为什么 Redis 未读数视图不是绝对真相，而必须定期对账修回数据库。

到这里，`07-im-notification-message` 目录已经把即时会话、SSE 推送和通知聚合三条主线分开了：

- IM 负责双边实时会话与在线路由
- SSE 通知负责事件到用户感知的在线提醒
- 聚合与未读计数负责把提醒视图长期收敛成用户可理解的通知系统

下一步如果继续沿基础设施和感知层深挖，最自然的是进入 `08-gateway-security-observability`，因为入口门禁、签名、限流和观测正是这些链路共同依赖的横切基座。