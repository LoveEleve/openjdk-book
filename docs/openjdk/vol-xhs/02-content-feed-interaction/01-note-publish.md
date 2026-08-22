# 笔记发布流程

> 对应目录：`vol-xhs/02-content-feed-interaction/`
> 目标问题：为什么“发布一篇笔记”在 `my-xhs` 里不是一次简单的内容插库，而是一条同时涉及敏感词审核、草稿状态、事件记录、本地消息表和 Feed 扩散的链？

## 一句话困惑

从产品界面看，发笔记好像是整个内容域里最直观的动作之一：

- 用户写标题和正文
- 上传几张图片
- 点“发布”
- 别人就能看到

如果只看数据库，也很容易把它想成一次简单的 `INSERT t_note`。

但一旦把这个动作放回真实系统里，就会立刻出现几个不能被“一条插入语句”覆盖的问题：

- 发布前要不要先做敏感词检测？如果检测失败，应该在内容入库前挡掉还是发布后补审？
- 草稿和已发布状态之间是不是同一条链？
- 发布成功之后，别人之所以能在 Feed 里看到这篇笔记，是因为内容服务自己直接推给别人，还是靠另一条扩散链？
- 如果 Feed 推送失败，笔记本身还算不算发布成功？

这说明“发布笔记”在当前系统里并不是一个单点写库动作，而是一条把**内容真相**和**内容分发**拆开的链。真正要讲清楚的，不是 controller 收了哪些字段，而是：**什么时候笔记在内容域里算真正发布，什么时候它又开始进入别人的世界。**

## 一句话答案

在 `my-xhs` 里，笔记发布的本体动作发生在内容域：先做 DFA 敏感词检测，再把 `Note` 以“已发布 + 审核通过”的状态写入数据库；但“别人能不能看到”则要靠事务提交后的本地消息表和 `FEED_TOPIC` 扩散链继续推进。也就是说，发布不是一件事，而是“内容成立”和“内容分发”两件事的串联。

## 先建立最小心智模型

先把当前实现里的笔记发布压成两层：

```text
内容本体层
  笔记对象是否被正式创建、处于什么状态

分发扩散层
  这篇笔记何时进入 Feed、如何被别的域感知
```

这两层看起来前后相连，但并不是同一条事务。

- 内容本体层负责回答：数据库里现在有没有这篇笔记，它是不是已发布。
- 分发扩散层负责回答：别的用户什么时候能在 Feed 或其他读路径里看见它。

只要先把这两层拆开，后面很多设计取舍就都顺了。

## 先推演第一个最直觉的失败方案：先插库，再异步查敏感词，不合格再改状态

这是很多内容系统一开始最容易采用的方案。

### 为什么这个方案很诱人

因为它很像“高性能优先”的写法：

- 用户点发布后先快速写入数据库
- 后面异步跑审核
- 不合格再下架或改成审核失败

这样前台发布响应会很快，后台审核也看起来能独立扩展。

### 它在当前实现里为什么不成立

它会先坏在“内容一旦入库为已发布，就已经有机会被别的链路看见”。

`NoteService.publishNote()` 的注释在 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:76` 到 `:81` 已经写明当前策略：

- 先做 DFA 敏感词检测
- DFA 通过后直接发布
- 当前版本不经过人工审核队列

也就是说，当前实现根本不是“先放进去再慢慢查”，而是**审核通过后才允许内容进入已发布状态。**

如果改成先插库、后审核，那么内容可能在审核结果回来之前就已经：

- 被详情接口查到
- 被批量详情接口带进 Feed 聚合
- 被本地消息表和 `FEED_TOPIC` 送进扩散链

一旦走到这里，再回头说“这篇内容其实不该发”，你就已经不是在挡发布，而是在补救已经扩散出去的脏内容。

## 再推演第二个失败方案：内容一发布成功，就同步推送给 Feed，失败就整单回滚

为了避免“内容已发布但别人还看不到”的问题，另一个自然想法是：那就在发布事务里直接把 Feed 推送也做掉，推不成功就连笔记一起回滚。

### 为什么这个方案也很诱人

因为它很符合直觉：

- 发布成功就应该立刻推给别人
- 推送失败说明发布链没闭环
- 那就干脆整个动作一起失败

### 它为什么在当前系统里同样不合适

这会把“内容本体成立”错误地和“分发链每一跳都同步成功”绑死。

而 `my-xhs` 当前明显不这么做。`NoteService.publishNote()` 在事务里：

1. 先插入 `t_note`
2. 再写本地消息表
3. 事务提交后才 `asyncSend` 到 `FEED_TOPIC`

对应代码见：

- 笔记入库：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:92` 到 `:99`
- 事件记录：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:101` 到 `:105`
- 本地消息表：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:107` 到 `:124`
- 事务提交后异步推送 Feed：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:126` 到 `:153`

这说明当前系统做了一个很明确的切割：**内容发布本体先要在内容域里成立，Feed 分发随后再尽力推进。**

如果把 Feed 推送也塞回同步事务，一旦消息系统或下游有短暂抖动，内容本体会被无辜拖死。从当前实现把 Feed 推送放到 `afterCommit` 且失败只留补偿锚点、不回滚 `t_note` 的选择来看，系统并不接受这个代价。

## 第一步：发布前先经过限流和 DFA 敏感词检测，而不是写入后再慢慢补救

`NoteController.publishNote()` 在 `my-xhs-content/src/main/java/com/myxhs/content/controller/NoteController.java:34` 到 `:49` 暴露了发布入口，并明确说"发布前自动进行 DFA 敏感词检测"。

但 DFA 并不是发布入口的唯一门禁。同一个方法上还叠加了 `@RateLimit(windowSeconds = 60, maxRequests = 5, perUser = true)`——同一用户 1 分钟内最多发布 5 篇。这意味着当前发布链的入口拦截不是单层，而是"限流 → 敏感词 → 入库"三层串联。限流不是优化项，而是发布链的正式组成部分：它和 DFA 一样，都在内容入库之前起作用。

真正的检测在 `NoteService.checkSensitiveWords()`，被 `publishNote()` 在第一步调用，见 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:88` 到 `:90`。

### 为什么这里用 DFA，而不是简单数据库关键字匹配

`DFAFilter` 的类注释在 `my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:20` 到 `:29` 已经把原理讲透：

- Trie 树构建一次
- 匹配是 `O(n)`
- 文本预处理会去除空格、特殊字符、做全角转半角，防止绕过

这说明当前实现里的敏感词检测不是“查一张违禁词表”，而是一条高频文本检测链。

### 动态词库和多实例一致性怎么处理

`DFAFilter` 不只读 classpath 词库，还会读 Redis 动态词库，并通过 Redis Pub/Sub 广播重建 Trie，见：

- 读 Redis 动态词库：`my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:128` 到 `:149`
- 收到更新通知后重建：`my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:72` 到 `:95`

这说明审核前置不仅是“本机内存判断”，而是已经考虑了多实例一致性。

## 第二步：当前发布链把“已发布”和“审核通过”在同一刻落定

`Note` 实体本身已经预留了两套状态：

- `status`：草稿 / 审核中 / 已发布 / 已下架，见 `my-xhs-content/src/main/java/com/myxhs/content/entity/Note.java:44`
- `auditStatus`：待审核 / 通过 / 拒绝，见 `my-xhs-content/src/main/java/com/myxhs/content/entity/Note.java:47`

这说明模型层并不是不知道“审核”这件事存在。

但当前 `publishNote()` 的真实策略是：

- DFA 通过后
- 直接把 `status` 设成已发布
- 同时把 `auditStatus` 设成已通过

对应代码见 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:92` 到 `:96`。

也就是说，当前实现还没有真正引入“人工审核中”这个异步阶段，而是采用：

```text
自动规则审核通过
→ 立即视为正式发布
```

这是一个很重要的实现边界：当前系统支持审核语义，但发布主链实际仍是“自动审核即发布”。

## 第三步：草稿和正式发布不是同一条状态路径

很多系统会把草稿也塞进“发布”逻辑里统一处理，但当前实现明显没有这么做。

### 草稿保存链

`saveDraft()` 在 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:159` 到 `:178` 中：

- 不做敏感词检测
- `status=草稿`
- `auditStatus=待审核`
- 不触发 Feed 推送

### 草稿发布链

而 `publishDraft()` 又是另一条链，代码在 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:410` 附近（由 grep 定位可见），它会在草稿基础上真正进入发布路径，并补本地消息与 Feed 推送。

这说明当前系统把：

- “先写一份未完成内容”
- “让这份内容进入公共可见世界”

明确拆成了两步。草稿不是发布失败后的残留态，而是发布链前的一个独立停靠点。

## 第四步：当前发布事务里真正保证原子性的，是“内容本体 + 本地消息表”，不是“内容本体 + Feed 推送”

这是当前实现里最关键的边界之一。

### 同事务写入了什么

`publishNote()` 在本地事务里至少做了三件事：

1. 插入 `t_note`
2. 记录 `NoteEvent`
3. 插入内容域自己的 `LocalMessage`

这说明当前事务真正要保证的是：**只要内容正式发布了，就必须同时留下后续可补发、可追踪的分发依据。**

### 为什么本地消息表比“当场发成功”更重要

如果只异步发 MQ 而不落本地消息表，那么发布成功和 Feed 推送之间就会存在一个纯内存空窗：

- 笔记已经发布
- 但进程在发 MQ 前挂了
- 没有任何地方记得“这篇已发布笔记还没扩散”

当前实现通过 `LocalMessage` 明确拒绝这种状态。也就是说，**它要的不是“现在一定发成功”，而是“现在发不成功也得留下补发锚点”。**

## 第五步：Feed 扩散发生在事务提交之后，说明“别人看见”比“内容成立”晚一拍

`TransactionSynchronizationManager.registerSynchronization(... afterCommit())` 在 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:126` 到 `:153` 中，把 Feed 推送放到了事务提交后。

这条设计有两个非常关键的含义：

### 1. 内容本体先成立，扩散再继续推进

这说明在当前系统里，“发布成功”的第一判断是：内容域内部事实已经成立，而不是“所有下游都已同步完成”。

### 2. Feed 推送失败不回滚笔记本体

`asyncSend` 失败时，只记日志并等待补偿，不会把刚写进去的 `t_note` 回滚掉。

所以“用户发布成功”与“别的用户已经在 Feed 里看见”在时序上天然不是同一个瞬间，而是前后两拍。

## 第六步：内容发布链为什么还要记 NoteEvent

`recordNoteEvent()` 在发布成功后立即记录一个 `PUBLISH` 事件，见 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:101` 到 `:105`。

而 `NoteEvent` 实体本身也把用途说得很清楚：`my-xhs-content/src/main/java/com/myxhs/content/entity/NoteEvent.java:12` 到 `:16` 明确说明，这是一条 append-only 的笔记状态事件流水，用来记录发布/审核时点，帮助后面区分“内容发布少了”还是“内容分发坏了”。

这说明当前系统还在额外追踪一个问题：

```text
内容本体什么时候被正式发布
```

这条时间线和 Feed 扩散、评论互动、推荐召回其实不是一回事。记录这个事件，是为了把“内容本体的诞生时刻”从后续扩散和互动里单独拎出来。

这在后面做“发布少了”还是“分发坏了”的归因时会非常重要。

但这里有一个很关键的工程边界：`recordNoteEvent()` 内部对写入失败做了 try-catch，失败时只记 error 日志，**不会阻塞发布主流程**（见 `my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:650` 到 `:666`，注释明确写着“写入失败仅告警不阻塞发布主流程”）。这是一个刻意的取舍：可观测性增强不能破坏核心链路。笔记发布成功的判断依据是 `t_note` 和 `LocalMessage` 已经写入，而不是 `NoteEvent` 也写入成功。如果把 NoteEvent 写入失败也变成回滚条件，那么一次事件流水表的抖动就会直接拖垮发布链——当前实现明确拒绝了这个代价。

## 真实故障案例：为什么“笔记已发布，但 Feed 没推到”比“发布失败”更危险

当前发布链里最危险的失败，不一定是接口直接报错，而是内容链一半成功、一半掉队。

### 现象

用户发布成功，接口返回了 `noteId`，数据库里也能查到笔记；但过了一段时间，关注他的人并没有在 Feed 里看到这篇内容。

这时从用户视角看，是“我明明发成功了，为什么没人看到”；从系统视角看，则是“内容真相已成立，但扩散真相没跟上”。

### 根因

根因不是 `t_note` 写失败，而是发布链被拆成了两层：

- 内容域先落本体
- 事务提交后再通过 `FEED_TOPIC` 推送

只要后一层没有推进成功，就会出现这类“半成功”状态。

### 修复

当前实现围绕这个风险做了两层保护：

1. 本地消息表与内容本体同事务写入
2. `asyncSend` 失败不回滚内容，而是留给补偿任务重推

这第二层不是一句空话。`FeedMessageRetryJob` 在 `my-xhs-content/src/main/java/com/myxhs/content/job/FeedMessageRetryJob.java:18` 到 `:31` 里明确把自己定义成两类补偿：

- 扫描 `status=0` 的本地消息，重新投递 MQ
- 扫描 `push_status in (0,1)` 但 Feed 推送未完成的消息，继续补推

对应的重发逻辑分别在 `my-xhs-content/src/main/java/com/myxhs/content/job/FeedMessageRetryJob.java:56` 到 `:110` 和 `:113` 到 `:196`。这说明当前实现不是“发失败就记个日志”，而是真的给“内容已成立但分发未完成”准备了一条后续收敛链。

### 验证

验证这类问题，不能只看 `/publish` 返回 200，而要看：

- `t_note` 是否写入且状态正确
- `LocalMessage` 是否存在并处于待发送/已发送状态
- `FEED_TOPIC` 是否真正被投递
- 下游 Feed 是否最终感知到了这篇笔记

### 余波

这个案例说明，**内容发布链真正难的不是把一篇内容写进库，而是让“内容已成立”和“内容已进入别人的世界”之间，不至于因为链路断点永久分裂。**

## 这一篇先收束成一张总图

```text
发布请求
  → DFA 敏感词检测
  → Note 状态设为已发布 + 审核通过
  → 同事务写入 t_note + NoteEvent + LocalMessage
  → afterCommit 触发 FEED_TOPIC asyncSend
  → 下游 Feed / 推荐 / 其他读链继续感知

草稿请求
  → 保存为草稿
  → 不做敏感词检测
  → 不触发 Feed 扩散
```

这里最重要的不是记住接口，而是三条判断：

1. 当前“发布”本质上是自动审核通过后直接进入已发布状态，不经过人工审核队列。
2. 内容本体成立和 Feed 扩散成功是两件事，时序上天然前后分离。
3. 草稿不是发布失败残留态，而是正式发布链前的独立停靠点。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 发布入口与限流：`my-xhs-content/src/main/java/com/myxhs/content/controller/NoteController.java:34`（`@RateLimit` 5/user/60s）
- 内容实体状态模型：`my-xhs-content/src/main/java/com/myxhs/content/entity/Note.java:44`
- 发布链主流程：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:76`
- NoteEvent 发布时点流水：`my-xhs-content/src/main/java/com/myxhs/content/entity/NoteEvent.java:12`
- NoteEvent 写入失败不阻塞发布：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:650` 到 `:666`
- DFA 敏感词过滤器与动态词库：`my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:20`、`my-xhs-content/src/main/java/com/myxhs/content/filter/DFAFilter.java:72`
- 本地消息表与 afterCommit Feed 推送：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:107`、`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:126`
- Feed 推送补发任务：`my-xhs-content/src/main/java/com/myxhs/content/job/FeedMessageRetryJob.java:18`
- 草稿保存与草稿发布链：`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:159`、`my-xhs-content/src/main/java/com/myxhs/content/service/NoteService.java:404`、`my-xhs-content/src/main/java/com/myxhs/content/controller/NoteController.java:127`
- 批量详情接口（Feed 场景优化）：`my-xhs-content/src/main/java/com/myxhs/content/controller/NoteController.java:99`
- 远程 MQ / 文件存储部署事实：`my-xhs-content/src/main/resources/application.yml:118`、`my-xhs-content/src/main/resources/application.yml:125`

## 边界清单

- 本篇讨论的是“当前实现里的笔记发布主链”，不展开评论发布、互动、推荐消费等后续内容扩散细节。
- 当前实现支持审核状态字段，但发布主链实际上是“DFA 通过即自动发布”；不能把它误写成已经存在完整人工审核系统。
- `LocalMessage` 的补发任务和 Feed 消费侧细节在本文只点到为止，后续在异步/失败专题中继续展开。
- 本篇主要讨论图文/视频笔记发布，不展开文件存储服务内部实现和上传安全策略。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么笔记发布不是一次简单插库，而是一条“内容成立 + 扩散推进”分层链。
- 为什么当前系统把 DFA 审核放在入库前，而不是发布后补救。
- 为什么草稿、正式发布、Feed 扩散在当前实现里是三种不同语义，不应该混写成一个动作。

但它还没进入下一步更核心的内容消费链：这些已发布内容，怎样在 Feed 流里沿着推拉混合模式被别的用户看见，又怎样在分页、游标和未读语义里保持一致。

所以下一篇应该进入 `02-feed-flow.md`，去回答**Feed 为什么不是简单时间线，而是一条推拉混合、带游标分页和跨域聚合的分发链**。
