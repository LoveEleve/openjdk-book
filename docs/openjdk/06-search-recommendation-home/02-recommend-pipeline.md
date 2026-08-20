# 推荐 Pipeline

> 对应目录：`vol-xhs/06-search-recommendation-home/`
> 目标问题：为什么推荐不是“热门内容换个接口”这么简单？`my-xhs` 当前的推荐链到底怎样从用户行为、关注关系、内容标签和热门池里召回候选，再把它们一路收敛成最终 Feed？

## 一句话困惑

搜索和推荐在产品界面上经常靠得很近，但它们解决的根本不是同一个问题。

- 搜索回答的是：**你明确输入了什么，我就按关键词帮你找。**
- 推荐回答的是：**你没明确输入，但系统仍然要猜你此刻最可能想看什么。**

这意味着推荐天然要处理一种更困难的场景：用户没有明确 query，系统却必须自己决定“从哪里找候选、按什么排序、怎样去重、怎样避免刷屏和单一品类连刷”。

如果把推荐理解成“把热门榜拿出来返回”，它很快就会遇到解释不了的问题：

- 为什么老用户和新用户的推荐应该不一样？
- 为什么同一个用户今天和明天的结果应该变化？
- 为什么推荐要同时读 Redis、MySQL、行为表和内容特征表？
- 为什么推荐服务自己也在往 MQ 上写行为事件？

所以这篇真正要讲清楚的，不是“推荐接口在哪”，而是：**当前 `my-xhs` 的推荐链到底怎样把多路候选召回、加权排序和重排去重串成一条完整的 Pipeline。**

## 一句话答案

在 `my-xhs` 里，推荐不是单一热门榜，而是一条四层 Pipeline：先用 Item-CF、内容标签、关注流、热门池和地理位置五路并行召回候选，再做粗排、精排和重排，最后把结果变成 Feed 返回；同时用户行为又会继续被写回，反过来影响下一轮推荐。这说明推荐不是一个查询接口，而是一条“召回 + 排序 + 行为反馈”闭环链。

## 先建立最小心智模型

先把当前推荐链压成一张最小图：

```text
用户行为 / 内容特征 / 关注关系 / 热门池 / 地理位置
  → 多路召回候选
    → 粗排
      → 精排
        → 重排
          → 推荐 Feed
            → 用户新行为再次回流
```

这个图最重要的结论是：**推荐不是一步算分，而是逐层筛和逐层收敛。**

`RecommendService` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:22` 到 `:31` 的类注释里，已经非常清楚地把当前设计写成了“四层推荐架构”：

- 召回
- 粗排
- 精排
- 重排

也就是说，系统自己已经把推荐明确建模成一条多段流水线，而不是一段查询函数。

## 先推演第一个最直觉的失败方案：把推荐当成热门榜接口

这是最容易想象、也最容易低估复杂度的简化方案。

### 为什么这个方案很诱人

因为它几乎不需要“理解用户”：

- 全站热度最高的内容拿出来
- 按热度倒序返回
- 所有人都看同一份榜单

实现简单、成本低、结果还看起来不至于太差。

### 它会先坏在哪里

它会先坏在“推荐结果没有用户差异”这件事上。

一旦系统只返回热门内容，就很难解释：

- 用户明明刚连续点赞某个领域内容，为什么推荐仍然和所有人一样？
- 冷启动用户和深度活跃用户，为什么 Feed 没区别？
- 关注流为什么还要存在，内容标签为什么还要存在，行为上报为什么还要存在？

当前 `RecommendService` 明确没有把推荐等同于热门榜。它在 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:217` 到 `:261` 中做多路并行召回，而不是只读热门池。

也就是说，热门只是候选来源之一，不是推荐本身。

## 再推演第二个失败方案：只做一轮召回，不做后续排序与重排

即使接受了“推荐不是热门榜”，另一个也很自然的误解是：那就多路召回一下，把候选合并去重直接返回。

### 为什么这个方案也很诱人

因为它已经比热门榜进了一步：

- 召回来源变多了
- 候选集看起来也个性化了
- 好像已经足够“像推荐”

### 它真正会先坏在哪里

它会先坏在“候选很多，但结果顺序仍然不可信”。

候选召回解决的是：

```text
可能看什么
```

而不是：

```text
此刻最该先看什么
```

如果没有粗排、精排和重排：

- Item-CF 候选可能和热门候选混在一起，没有统一可比性
- 同类目内容可能连续刷屏
- 已读内容可能继续重复出现
- 跟随内容和热门内容的相对优先级没人裁决

`RecommendService` 正是因为承认这个问题，才把召回后面又拆成三层：

- 粗排 `roughRank()`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:297` 到 `:316`
- 精排 `fineRank()`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:318` 到 `:354`
- 重排 `reRank()`，虽然本文后面不逐行展开，但它明确承担去重和打散职责

这说明当前实现非常明确：**多路召回只是开始，排序收敛才决定推荐结果能不能真正用。**

## 第一步：召回层为什么一定要并行、多路、异构

当前推荐链最重的第一步是召回层。

`RecommendService.multiRecall()` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:217` 到 `:261` 中，把所有 `RecallStrategy` 并发执行，并设置统一超时降级。

这说明系统承认两件事：

1. 单一路径不够覆盖不同用户场景。
2. 某一路召回失败，不应该把整条推荐链拖死。

### 当前真实存在的 5 路召回

从代码里可以确认当前确实存在 5 路召回：

1. `ItemCFRecallStrategy`
2. `ContentRecallStrategy`
3. `FollowingRecallStrategy`
4. `HotRecallStrategy`
5. `GeoRecallStrategy`

它们在 `my-xhs-search/src/main/java/com/myxhs/search/recommend/` 下都各自有独立实现，并通过 `name()` 返回不同来源标识。

### Item-CF：拿用户最近正向交互过的内容去找相似内容

`ItemCFRecallStrategy` 在 `my-xhs-search/src/main/java/com/myxhs/search/recommend/ItemCFRecallStrategy.java:16` 到 `:27` 已经把思路写穿：

- 用户最近的点赞、收藏、长停留，作为正向交互集合
- 对每个笔记去 Redis 相似矩阵找相似内容
- 再把相似度累加排序

这里的关键不是协同过滤理论，而是它说明：**推荐可以直接建立在“你最近明显喜欢过什么”之上。**

### Content：拿用户兴趣标签去匹配内容标签

`ContentRecallStrategy` 在 `my-xhs-search/src/main/java/com/myxhs/search/recommend/ContentRecallStrategy.java:15` 到 `:23` 中，明确把自己定义成“基于标签匹配”的召回。

它会：

- 从 Redis 取用户兴趣标签 Hash，见 `my-xhs-search/src/main/java/com/myxhs/search/recommend/ContentRecallStrategy.java:36` 到 `:38`
- 选权重最高的标签
- 再去 `t_item_feature` 表里找标签相近内容，见 `my-xhs-search/src/main/java/com/myxhs/search/recommend/ContentRecallStrategy.java:61` 到 `:63`

这说明当前推荐链并不是纯行为协同过滤，而已经把“内容特征”纳入召回来源。

### Following：关注关系驱动的最新内容召回

`FollowingRecallStrategy` 在 `my-xhs-search/src/main/java/com/myxhs/search/recommend/FollowingRecallStrategy.java:15` 到 `:23` 中，把自己定义成“你关注的人发了什么”。

它直接读取 `recommend:following:latest:{userId}` 这个 ZSet，见 `my-xhs-search/src/main/java/com/myxhs/search/recommend/FollowingRecallStrategy.java:35` 到 `:37`。

这条路的意义在于：**推荐不只在猜你喜欢什么，也在承接社交关系本来就该给你的内容。**

### Hot：兜底热门池，不让推荐空掉

`HotRecallStrategy` 很短，但意义非常大。它在 `my-xhs-search/src/main/java/com/myxhs/search/recommend/HotRecallStrategy.java:15` 到 `:23` 中明确写了：热门召回是兜底策略，也是冷启动用户的主要来源。

这说明当前实现很现实：个性化召回可能为空，但推荐链不能空。

### Geo：位置相关内容和冷启动降级兜底

`GeoRecallStrategy` 在 `my-xhs-search/src/main/java/com/myxhs/search/recommend/GeoRecallStrategy.java:14` 到 `:21` 中，把自己定义成“同城内容”召回；同时又在 `:20` 明确写了：位置未知时降级为高质量热门内容。

这意味着当前推荐链不仅有多路召回，还有**某一路自己内部的降级链**。

## 第二步：粗排先把不同来源的候选拉到同一张分数尺子上

召回层得到的是一组异构候选。此时最大的问题是：

- Item-CF 的相似度
- 内容标签匹配分
- 关注流的新鲜度
- 热门池的热度
- 地理召回的近邻性

它们原本根本不是同一单位，不能直接拿来比大小。

这就是粗排存在的意义。

`RecommendService.roughRank()` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:297` 到 `:316` 中，把候选分数统一乘上来源权重，再截到 Top 100。

也就是说，粗排不是在做最终推荐，而是在做第一轮归一化：

```text
先把“不同来源看起来都像分数”的东西
拉到一把可以比较的尺子上
```

这也是为什么 `SOURCE_WEIGHT` 在当前实现里非常关键：它不是简单常量，而是在替当前还没有上线的更复杂学习排序做规则化近似。

## 第三步：精排把“来源分”继续融合成更像最终结果的排序

粗排之后，系统还没有直接返回，而是继续进入 `fineRank()`。

`RecommendService.fineRank()` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:320` 到 `:347` 中，把分数拆成四维：

- 来源权重
- 用户偏好
- 内容质量
- 时效衰减

然后再线性加权融合。

这一步最重要的不是公式本身，而是：**当前实现已经承认“单一召回分”不够代表最终推荐质量。**

也就是说：

- Item-CF 命中了，不代表一定排最前
- 热门内容热度高，也不代表比用户偏好更重要
- 内容质量和新鲜度，都要一起进入最终排序

精排在这里就是在做“候选可返回性”的第二次收敛。

## 第四步：重排不再问“它分高不高”，而问“它们放在一起像不像一个正常 Feed”

当前推荐链最后一层叫 `reRank()`，注释已经明确写了两件事：

- 已读过滤（HyperLogLog）
- 品类打散（同品类不超过 2 个连续）

这说明重排层关心的已经不是单条内容值不值得推荐，而是：

```text
一整屏内容放在一起
像不像一个正常可刷的 Feed
```

这是推荐系统里很重要的一个思维转折：排序并不在精排结束，真正到用户眼前前，还得再做“列表级约束”。

## 第五步：推荐链不是只消费行为，它还会反过来生产行为

推荐和搜索有一点很像：它们都不是纯读链。

`RecommendService.reportBehavior()` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:159` 到 `:213` 中，明确把用户行为继续写回系统：

- 正常路径：发 `RECOMMEND_BEHAVIOR_TOPIC`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:187` 到 `:188`
- MQ 失败时降级同步写 `t_user_behavior`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:198` 到 `:210`

这说明推荐链天然有闭环结构：

```text
推荐结果被用户看到
→ 用户产生行为
→ 行为回流
→ 下一轮推荐再使用这些行为
```

而且这条“再使用”在当前代码里是有直接落点的：

- `ItemCFRecallStrategy` 会从 `t_user_behavior` 里取用户最近正向交互内容，见 `my-xhs-search/src/main/java/com/myxhs/search/recommend/ItemCFRecallStrategy.java:40` 到 `:43` 以及 `:86` 到 `:93`
- `ContentRecallStrategy` 会从 Redis 里的 `recommend:user:tags:{userId}` 读取兴趣标签，见 `my-xhs-search/src/main/java/com/myxhs/search/recommend/ContentRecallStrategy.java:17` 到 `:19` 和 `:36` 到 `:42`

也就是说，推荐不是一次查询，而是一条已在当前实现里打通了“行为回流 → 下一轮召回输入”的自反馈链。

## 第六步：冷启动不是特殊分支，而是当前实现内置的第一等场景

当前推荐链还很诚实地面对了一个现实：有些用户根本没有历史行为。

`RecommendService.getRecommendFeed()` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:89` 到 `:99` 中，先判断是否冷启动。

冷启动时，系统并不会假装“个性化照常可做”，而是明确走 `coldStartRecall()`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:264` 到 `:295`。

当前冷启动策略是：

- 热门 60%
- 地理 30%
- 去重合并

这说明当前推荐链已经内建一个非常现实的判断：**不是所有用户都值得走完整个个性化召回链。**

## 真实故障案例：为什么推荐链最危险的错误，不是某一路召回空了，而是所有候选都被当成同一类分数直接混排

推荐链里最容易被低估的风险，不在“某一路召回失败”，而在“多路候选合起来之后，没有经过正确收敛就直接返回”。

### 现象

如果系统只做多路召回、不做粗排/精排/重排，那么表面上看也能返回一份候选列表。但用户会很快感受到：

- 某一类来源的内容异常霸榜
- 同类内容连续刷屏
- 刚看过的内容又被推回来
- 热门内容和个性内容的先后顺序很随机

### 根因

根因在于，召回层解决的是“找得到”，不是“排得对”。

不同来源的候选天然就不是同一把尺子：

- 相似度分
- 热门分
- 关注流新鲜度
- 内容标签匹配分
- 地理近邻分

如果系统把它们当成同一类数字直接混排，推荐结果看起来就会“像有很多来源”，但用户体验会迅速崩掉。

### 修复

当前实现围绕这个风险做了三层收敛：

1. 粗排先按来源权重拉齐
2. 精排再融合用户偏好、质量和时效
3. 重排最后做列表级约束

### 验证

验证这类问题，不能只看“接口有没有返回结果”，而要看：

- 不同来源的内容是否都能进入候选集
- 重排后是否存在明显重复或单一品类连刷
- 冷启动和活跃用户的结果是否出现可解释差异

### 余波

这个案例说明，**推荐系统真正难的从来不是“能不能召回”，而是“多路召回之后，谁先谁后到底凭什么”。** 当前实现虽然还是规则化 Pipeline，但已经在认真解决这个问题。

## 这一篇先收束成一张总图

```text
用户行为 / 标签 / 关注 / 热门 / 位置
  → 5 路召回候选
    → 粗排（来源权重）
      → 精排（偏好 + 质量 + 时效）
        → 重排（已读过滤 + 品类打散）
          → 推荐 Feed
            → 新行为再次回流系统
```

这里最重要的不是背 5 路召回名字，而是三条判断：

1. 当前推荐已经不是“热门榜换个接口”，而是一条明确的多路召回 Pipeline。
2. 召回解决“找得到”，排序解决“排得对”，重排解决“刷起来像不像一个正常 Feed”。
3. 推荐不是纯读链，它天然会把用户新行为再反向写回系统，形成自反馈闭环。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 四层推荐架构总览：`my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:22`
- 多路并行召回：`my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:217`
- Item-CF 召回：`my-xhs-search/src/main/java/com/myxhs/search/recommend/ItemCFRecallStrategy.java:16`
- 内容标签召回：`my-xhs-search/src/main/java/com/myxhs/search/recommend/ContentRecallStrategy.java:15`
- 关注召回：`my-xhs-search/src/main/java/com/myxhs/search/recommend/FollowingRecallStrategy.java:15`
- 热门召回：`my-xhs-search/src/main/java/com/myxhs/search/recommend/HotRecallStrategy.java:15`
- 地理召回与降级：`my-xhs-search/src/main/java/com/myxhs/search/recommend/GeoRecallStrategy.java:14`
- 冷启动召回：`my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:264`
- 粗排：`my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:297`
- 精排：`my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:320`
- 行为回流与其后续消费：`my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:159`、`my-xhs-search/src/main/java/com/myxhs/search/recommend/ItemCFRecallStrategy.java:40`、`my-xhs-search/src/main/java/com/myxhs/search/recommend/ContentRecallStrategy.java:36`
- 推荐配置：`my-xhs-search/src/main/resources/application.yml:137`

## 边界清单

- 本篇讨论的是当前规则化推荐 Pipeline，不把它误写成已经接入成熟 ML 排序服务的系统。
- `RecommendService` 注释里写了 5 路召回，但“候选 ≈300 条”“精排取 50”“最终 20 条”更多属于当前实现参数与策略，不是业务绝对常量。
- 当前推荐链对地理位置、关注流和内容标签的依赖，都可能因为上游数据缺失而降级；本文重点是解释 Pipeline 结构，不展开每一路数据生产链的全部细节。
- 本篇不展开热搜算法本身，热搜会在后续专题里单独说明。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么推荐不是热门榜的别名，而是一条明确的多路召回 + 排序 + 重排流水线。
- 为什么当前推荐链必须同时结合用户行为、内容特征、社交关系和热门池，才能给出可用结果。
- 为什么推荐接口不是纯读取，而天然带着行为回流和闭环更新的副作用。

但它还没进入同样属于流量入口、却更偏“公共意图信号”的那块能力：热搜到底怎样统计、衰减、置顶和反作弊，才不会被少数高频请求轻易污染。

所以下一篇应该进入 `03-hot-search.md`，去回答**热搜如何从普通搜索行为里提炼出全局公共榜单，以及这个榜单怎样避免被刷穿**。
