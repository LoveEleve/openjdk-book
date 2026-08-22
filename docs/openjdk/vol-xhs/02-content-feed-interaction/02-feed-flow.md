# Feed 流分发

> 对应目录：`vol-xhs/02-content-feed-interaction/`
> 目标问题：用户为什么能在首页看到关注的人发的内容？`my-xhs` 的 Feed 为什么不是简单时间线查询，而是一条推拉混合、带游标分页、两层聚合和未读联动的分发链？

## 一句话困惑

笔记发布完成之后，内容还只是“存在于内容域”。用户真正感知到内容流动，是在首页 Feed 里刷到它的时候。

如果只用最直觉的方式理解 Feed，很容易把它想成：

- 按发布时间倒序查关注用户的所有笔记
- 前端每次分页继续查下一页
- 列表里顺手带上作者信息和点赞数

但在 `my-xhs` 当前实现里，Feed 远比这个复杂：

- 它不是单一拉模式，也不是全量推模式，而是推拉混合
- 它不是按 `pageNum/offset` 翻页，而是按时间戳 score 做游标分页
- 它不是拿到笔记 ID 就返回，而是要再经过两层聚合
- 它甚至会把未读通知数一起拼到同一个页面结果里

这说明 Feed 不是“内容列表查询”，而是一条专门的**内容分发与页面聚合链**。

## 一句话答案

当前 `my-xhs` 的 Feed 流不是简单按作者时间线拉取，而是用“普通用户推收件箱、大 V 走发件箱拉取”的推拉混合模型，把 noteId 先沉到 Redis，再由 `home` 服务按游标分页取出 ID，最后分两层并行聚合笔记详情、作者、计数、点赞状态和未读数。也就是说，Feed 先是一个分发问题，后才是一个展示问题。

## 先建立最小心智模型

先把当前 Feed 链压成一张最小图：

```text
内容发布
  → 普通作者：推到粉丝 inbox
  → 大V作者：写到自己的 outbox

首页读取
  → inbox + 大V outbox
    → 合并排序
      → 游标分页
        → 两层聚合笔记视图
          → 返回 Feed + unreadCount
```

这里最重要的判断是：**Feed 不是“查内容表”，而是“先拿分发结果，再补展示视图”。**

`FeedService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:37` 到 `:40` 的注释里，已经把当前模型说得非常清楚：

- 普通用户发笔记 → 推送到粉丝收件箱
- 大V发笔记 → 写入自己的发件箱
- 读取 Feed → 收件箱 + 关注的大V发件箱 → 合并排序 → 游标分页

而推送侧的真实实现也存在于 `FeedPushConsumer`：`my-xhs-home/src/main/java/com/myxhs/home/consumer/FeedPushConsumer.java:25` 到 `:31` 明确写着“普通用户走推模式、大V走拉模式”，并在 `:97` 到 `:105` 中把大V内容写入发件箱、在 `:136` 到 `:224` 中把普通作者内容批量推到粉丝 inbox。也就是说，这套推拉混合并不只是读路径自述，而是发布后的真实分发逻辑。

所以 Feed 的第一层真相不是“所有关注人的笔记”，而是“这些笔记已经按当前分发策略被组织成什么样的收件箱/发件箱结构”。

## 先推演第一个最直觉的失败方案：所有作者都统一走拉模式

这是最容易想到的方案。

### 为什么这个方案很诱人

因为它简单：

- 用户打开 Feed 时
- 直接查关注的所有作者
- 按时间倒序拉他们最近发布的内容

实现上甚至不一定要额外的 Redis inbox/outbox 结构。

### 它会先坏在哪里

它会先坏在“大V作者”的读取成本上。

如果一个用户关注了很多高频作者，每次打开首页都要实时拉所有人最新内容，再合并排序，这条读链会越来越重。

当前实现之所以引入 `big-v-threshold`，就是明确承认：并不是所有作者都适合用同一种分发策略。配置里写了大V阈值，见 `my-xhs-home/src/main/resources/application.yml:137` 到 `:145`。

这说明系统不是在追求“模型纯粹”，而是在按作者影响力选择推还是拉。

## 再推演第二个失败方案：所有作者都统一走推模式

既然纯拉不行，另一个极端就是全推：每个作者发笔记时，把 noteId 直接推到所有粉丝的收件箱里。

### 为什么这个方案也很诱人

因为读路径会变轻：

- 用户读 Feed 时只查自己的 inbox
- 不用实时去拉别人发件箱
- 首页延迟会更可控

### 它为什么在当前实现里同样不成立

它会先坏在“大V写扩散”上。

`FeedPushConsumer` 的实现（grep 已显示）明确区分了：大V不走给所有粉丝逐个推 inbox，而是写自己的 outbox；普通作者才推粉丝收件箱。这说明系统已经承认：当粉丝规模很大时，写扩散本身会成为灾难。

所以当前实现最终选的不是推或拉其一，而是：

```text
普通作者 → 推
大V作者 → 拉
```

也就是推拉混合模型。

## 第一步：Redis 里的 inbox / outbox 才是当前 Feed 的分发底座

`RedisKeyConstants` 已经把这两个结构写死：

- `FEED_INBOX`：`myxhs:feed:inbox:{userId}`，见 `my-xhs-common/src/main/java/com/myxhs/common/constants/RedisKeyConstants.java:183`
- `FEED_OUTBOX`：`myxhs:feed:outbox:{userId}`，见 `my-xhs-common/src/main/java/com/myxhs/common/constants/RedisKeyConstants.java:186`

这说明当前 Feed 不是逻辑概念，而是有明确 Redis 形态的。

### inbox 代表什么

它代表“已经被推到这个用户眼前的候选内容集合”。

### outbox 代表什么

它代表“大V作者自己的最近内容时间线，粉丝读时再实时拉进来”。

这说明 Feed 分发在当前实现里先被压成了 Redis 层的两种容器，而不是每次读时临时拼接所有原始内容数据。

## 第二步：读 Feed 时先拿 noteId，再做视图聚合

`FeedService.getFollowFeed()` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:63` 到 `:130` 中，第一步根本没有查详情，而是先拿一组 noteId：

1. 从 inbox ZSet 拉，见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:80` 到 `:88`
2. 再去大V outbox 拉，见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:90` 到 `:91`
3. 然后合并排序，见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:93` 到 `:95`

这说明当前实现里的 Feed 阅读路径，第一阶段只是“分发结果读取”，还没有进入内容详情视图。

也就是说：

```text
先决定这页有哪些 noteId
再决定这些 noteId 要怎样显示
```

这和简单时间线查询有本质区别。

## 第三步：游标分页不是 UI 细节，而是 Feed 正确性的核心协议

当前 Feed 不用 `pageNum/offset`，而是用 score 游标。

`FeedService` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:67` 到 `:75` 接收 `lastScore`，在 `:81` 到 `:88` 用 `reverseRangeByScoreWithScores` 拉窗口内容。

### 为什么必须用 score 游标

因为 Feed 本质上不是一个稳定表分页，而是一条不断变化的时间流。只要新内容在用户翻页期间还在持续写入：

- 用 offset 会很容易跳过或重复看到内容
- 用 score 开区间则更容易沿着“上一页最后一条的时间点”继续往下走

### 当前实现还专门修过这一点

`FeedService` 注释里已经记录了一个典型 bug：

- `reverseRangeByScoreWithScores` 的 min/max 参数颠倒，导致 inbox 恒空，见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:83` 到 `:86`
- 多取一条判断 `hasMore`，修复尾页取满时误报，见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:86` 到 `:107`

这说明游标分页在当前实现里不是理论美化，而是已经影响过线上/运行态正确性的核心协议。

## 第四步：当前 Feed 聚合是两层，而不是“一次把所有下游都查完”

`aggregateFeed()` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:133` 到 `:266` 中，把 Feed 页面的展示拆成两层：

### 第 1 层并行：先补笔记本体、点赞状态、未读通知数

- 笔记详情：`notesFuture`
- 点赞状态：`likesFuture`
- 未读数：`unreadFuture`

对应代码见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:144` 到 `:176`。

### 第 2 层再依赖 note → author 关系补作者和计数

- 作者信息：`usersFuture`
- 计数：`countersFuture`

见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:205` 到 `:226`。

也就是说，Feed 聚合不是“把所有下游全并起来就完了”，而是按依赖顺序拆层。当前实现很明确地承认：有些数据要等上一层拿到 note 以后，才能继续查。

## 第五步：Feed 页面为什么要顺手拼未读通知数

这一步特别能说明 BFF 的思维。

当前 Feed 聚合里，`NotificationFeignClient.getUnreadCount()` 会在第一层就一起查，见 `my-xhs-home/src/main/java/com/myxhs/home/feign/NotificationFeignClient.java:18` 到 `:22` 和 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:163` 到 `:176`。

这说明在页面语义上，首页 Feed 不是“只看内容流”，而是“内容 + 当前注意力提示”的复合入口。

系统并没有要求前端再多打一枪通知服务，而是直接把这个页面级需求在 BFF 层完成。这再次证明：当前 Feed 返回值不是原始内容列表，而是首页场景的复合视图。

## 第六步：大V判定和 outbox 拉取，说明 Feed 不是单纯内容分发，而是流量成本控制

`pullBigVOutbox()` 在 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:300` 到 `:344` 里，会先获取当前用户关注的大V列表，再通过 Pipeline 一次性查询他们的 outbox。

而 `getFollowingBigVIds()` 又在 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:347` 到 `:360` 中，按粉丝规模筛出大V。

这说明“谁走推模式、谁走拉模式”并不是抽象设计，而是已经成为完整分发链的一部分。推送侧的 `FeedPushConsumer.checkBigV()` 也会在发布时判断作者是否大V，见 `my-xhs-home/src/main/java/com/myxhs/home/consumer/FeedPushConsumer.java:227` 到 `:257`；读侧的 `FeedService.getFollowingBigVIds()` 则在读取时按同样语义筛大V发件箱，见 `my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:347` 到 `:360`。Feed 不是单纯在读内容，而是在读：

- 这篇内容属于哪个作者类型
- 这个作者应该以什么分发成本进入这个用户的首页

换句话说，当前 Feed 已经把内容分发和流量成本控制绑在了一起。

## 真实故障案例：为什么 Feed 最危险的错误，不是某篇笔记没进来，而是分页协议和收件箱语义一起失真

Feed 链最容易被低估的，不是“少一篇内容”，而是“系统以为自己在发时间线，结果分页协议和 inbox 读取已经错位”。

### 现象

一个典型现象是：

- 用户明明已经有收件箱数据
- 但首页 Feed 却一直空，或者 `hasMore` 一直不对

这类问题比“某篇笔记少了”更危险，因为它说明：

- 不是单条内容分发失败
- 而是整条 Feed 读取语义出了问题

### 根因

当前实现历史上就明确修过两类这类问题：

1. `reverseRangeByScoreWithScores` 参数顺序颠倒，导致收件箱区间永远取不到东西
2. `hasMore` 用尾页取满的经验判断，导致误报

这说明 Feed 最关键的不是“有 Redis 就能读出来”，而是 score 区间、开闭边界、分页协议和收件箱语义必须一起正确。

### 修复

当前修法就是：

- 用正确的 score 区间 `[0, minScore]`
- 多取一条专门判断 `hasMore`
- 脏成员解析失败时跳过，而不是整页 500

### 验证

验证 Feed 是否正确，不能只看第一页是不是有内容，而要同时看：

- 下一页 cursor 是否可持续使用
- 尾页 `hasMore` 是否准确
- inbox/outbox 合并后顺序是否稳定
- 脏数据是否只影响单条而不是整页

### 余波

这个案例说明，**Feed 流最难的不是“发了没发”，而是“这条流在分页、排序和聚合后，是否还像一条真正连续的内容时间线”。**

## 补偿层：Feed 推送失败后的两条收敛路径

前面讲了 Feed 推送发生在事务提交之后，那如果推送本身失败了怎么办？当前实现准备了两条独立的补偿路径，都由 `FeedMessageRetryJob` 驱动，见 `my-xhs-content/src/main/java/com/myxhs/content/job/FeedMessageRetryJob.java:18` 到 `:31`。

### 路径一：MQ 投递失败的重发

`LocalMessageMapper.selectPending()` 扫描 `status=0`（MQ 未发送成功）且 `retry_count < maxRetry` 的消息，重新投递到 `FEED_TOPIC`。这条路径解决的是“笔记已发布、本地消息表已写入、但 MQ 异步发送失败”的场景。

投递成功后通过乐观锁 `markSent()`（`WHERE status=0`）把状态改为 1，防止并发重复投递。超过重试上限的消息通过 `incrementRetry()` 标记为死信（`status=3`），不再重试。注意 `incrementRetry()` 内部用 `retry_count + 1` 做比较，这是为了避免 MySQL UPDATE 中 CASE 引用旧值导致的 off-by-one 问题，见 `my-xhs-content/src/main/java/com/myxhs/content/mapper/LocalMessageMapper.java:40` 到 `:43`。

### 路径二：Feed 推送未完成的补推

`LocalMessageMapper.selectPendingPush()` 扫描 `status=1`（MQ 已发送）但 `push_status in (0,1)`（Feed 推送未完成）的消息，继续补推。这条路径解决的是“MQ 投递成功了，但下游消费者处理 inbox 写入时部分失败”的场景。

这里有一个关键的工程细节：补偿任务使用 `updatePushStatus()` 而不是 `updatePushProgress()`。代码注释明确写着“避免补偿任务覆盖 Consumer 的推送进度”，见 `my-xhs-content/src/main/java/com/myxhs/content/mapper/LocalMessageMapper.java:78` 到 `:81`。这是因为消费者在批量推送粉丝 inbox 时会通过 `push_cursor` 记录推进位置，如果补偿任务也写 cursor，就可能把消费者已经推到第 500 个粉丝的进度覆盖回 0——两条路径必须各写各的字段。

这说明当前 Feed 推送不是“发完就算”，而是“发完还要确认推完，推不完还要继续补”。

## 这一篇先收束成一张总图

```text
内容发布
  → 普通作者推粉丝 inbox
  → 大V写自己 outbox

用户读 Feed
  → inbox + 大V outbox
  → 合并排序
  → score 游标分页
  → 第1层并行：笔记详情 + 点赞状态 + 未读数
  → 第2层并行：作者信息 + 计数
  → 返回首页 FeedVO
```

这里最重要的不是记住 Redis Key，而是三条判断：

1. 当前 Feed 不是简单时间线查询，而是推拉混合分发链。
2. Feed 先解决“这一页该有哪些内容”，再解决“这些内容怎样展示”。
3. 游标分页、两层聚合和未读联动共同决定了它不是普通列表接口，而是首页级内容分发入口。

## 证据清单

这篇的关键判断主要由以下证据托底：

- FeedService 推拉混合模型总览：`my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:28`
- FeedPushConsumer 推送侧推拉混合实现：`my-xhs-home/src/main/java/com/myxhs/home/consumer/FeedPushConsumer.java:22`
- inbox/outbox Redis Key：`my-xhs-common/src/main/java/com/myxhs/common/constants/RedisKeyConstants.java:181`
- Feed 入口与 score 游标：`my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:63`
- 大V阈值配置：`my-xhs-home/src/main/resources/application.yml:137`
- 两层聚合：`my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:133`
- 未读通知数联动：`my-xhs-home/src/main/java/com/myxhs/home/feign/NotificationFeignClient.java:18`、`my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:163`
- 大V outbox 拉取与 Pipeline：`my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:300`
- 参数顺序与 hasMore 修复点：`my-xhs-home/src/main/java/com/myxhs/home/service/FeedService.java:83`
- inbox/outbox 清理与裁剪：`my-xhs-home/src/main/java/com/myxhs/home/job/FeedCleanupJob.java:15`
- 测试写 inbox/outbox 的开发接口：`my-xhs-home/src/main/java/com/myxhs/home/controller/FeedTestController.java:29`
- Feed 推送补偿任务（两条路径）：`my-xhs-content/src/main/java/com/myxhs/content/job/FeedMessageRetryJob.java:18`
- 本地消息表乐观锁与 off-by-one 防护：`my-xhs-content/src/main/java/com/myxhs/content/mapper/LocalMessageMapper.java:29`、`my-xhs-content/src/main/java/com/myxhs/content/mapper/LocalMessageMapper.java:40`
- pushStatus 与 pushProgress 分离防覆盖：`my-xhs-content/src/main/java/com/myxhs/content/mapper/LocalMessageMapper.java:78`

## 边界清单

- 本篇聚焦 Feed 分发和首页读取语义，不展开 FeedPushConsumer、NoteDeleteConsumer、清理任务等更底层推送与回收机制，它们属于后续更深的运行时分发专题。补偿层（FeedMessageRetryJob 的两条路径）已在本篇补充，因为它直接影响"Feed 推送最终是否收敛"。
- 当前实现里，大V阈值、收件箱保留天数和大小属于配置参数，不应误写成业务绝对常量。
- 未读通知数被拼进 Feed 返回值，是页面场景设计选择，不等于通知服务从属于 Feed 服务。
- 本篇主要讨论内容流，不展开评论、收藏、关注等互动动作如何回流影响 Feed 排序，这些会在互动专题继续展开。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么当前 Feed 不是纯拉模式或纯推模式，而是按作者类型走推拉混合。
- 为什么 Feed 不是简单内容列表查询，而是先分发、再游标分页、再两层聚合的链。
- 为什么未读数、点赞状态、作者信息和计数都能被拼回同一个首页结果里。

但它还没进入内容域里另一块同样重要的动作链：点赞、收藏、评论、分享这些互动行为怎样从单次动作变成计数、通知和后续分发的输入。

所以下一篇应该进入 `03-interaction.md`，去回答**互动行为为什么不是对单条内容的局部修改，而是会继续扩散到计数、通知和推荐的事件链**。
