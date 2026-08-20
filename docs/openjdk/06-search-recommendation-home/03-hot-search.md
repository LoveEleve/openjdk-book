# 热搜滑动窗口

> 对应目录：`vol-xhs/06-search-recommendation-home/`
> 目标问题：热搜为什么不是把搜索词简单计数后排个序就行？`my-xhs` 当前为什么要引入分钟桶、指数衰减、人工置顶/屏蔽、反作弊和快照持久化？

## 一句话困惑

热搜在产品界面上看起来很简单：

- 用户搜了什么
- 系统把搜得最多的词排出来
- 前台展示一个 Top 榜单

如果只看这层表象，最自然的实现方式似乎是：

```text
keyword -> count++ -> order by count desc
```

但一旦把这件事放进真实系统，会立刻遇到几个不能靠“总次数排序”解决的问题：

- 10 天前被刷爆的词，为什么今天还要一直挂在榜首？
- 同一个用户 1 秒钟连点 20 次搜索，为什么不该把榜单直接冲穿？
- 一个垃圾词或测试词，为什么需要人工置顶/屏蔽能力？
- 当前榜单给前台展示是一回事，历史某一天的榜单快照又是另一回事。

所以这篇真正要讲的不是“热搜接口在哪”，而是：**为什么热搜在 `my-xhs` 里已经不是一个简单计数器，而是一条“实时统计 + 时间衰减 + 反作弊 + 快照沉淀”的独立榜单链。**

## 一句话答案

当前 `my-xhs` 的热搜不是“累计总搜索次数”，而是一个滑动窗口实时榜：搜索行为先写入按分钟拆分的 Redis 桶，再由定时任务用指数衰减公式汇总成当前热度，同时叠加用户/IP 反作弊、人工置顶/屏蔽和 MySQL 历史快照。也就是说，它衡量的不是“历史上谁总量最多”，而是“最近一段时间里谁正在变热”。

## 先建立最小心智模型

先把当前热搜链压成一张最小图：

```text
用户搜索关键词
  → 分钟桶记录
    → 反作弊过滤
      → 定时汇总热度
        → 实时榜单 ZSet
          → 人工置顶/屏蔽修正
            → MySQL 快照沉淀
```

这里最重要的判断是：**热搜并不是直接从搜索接口返回值里顺手数出来的，而是有自己的一条状态推进链。**

`HotSearchService` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:31` 到 `:44` 的类注释里，已经把这条链直接写明了：

1. 记录搜索词到滑动窗口分钟桶
2. 定时计算热度（指数衰减）
3. 获取热搜榜 Top 50（含人工置顶/屏蔽）
4. 快照持久化到 MySQL

也就是说，当前实现不是“热搜榜是搜索接口的副产物”，而是“搜索行为只是热搜服务的输入”。

## 先推演第一个最直觉的失败方案：按累计总搜索次数排榜

这是最容易想到的做法。

### 为什么这个方案很诱人

因为它简单、稳定、很好解释：

- 某个词被搜了 1000 次
- 另一个词被搜了 500 次
- 前者排前面

一张数据库表甚至一个 Redis Hash 就足够跑通。

### 它会先坏在哪里

它会先坏在“热搜想表达的其实不是历史总量，而是当前热度”。

如果完全按累计总次数排：

- 一个一周前突然爆火但今天没人再搜的词，仍然可能霸榜
- 一个刚刚起来的新热词，会长期打不过历史累计量很高的旧词
- 榜单会越来越像历史荣誉榜，而不是“现在大家在搜什么”

当前实现之所以引入滑动窗口，就是为了主动拒绝这种静态总量视角。

## 再推演第二个失败方案：虽然按分钟计数，但不做反作弊和人工修正

即使接受了“热搜要看最近窗口”，还有一个很常见的误区：只要按分钟桶记数，再定时汇总就够了。

### 为什么这个方案也很诱人

因为它已经比累计总量进了一步：

- 时间维度有了
- 热词能更快上下浮动
- 实现复杂度也可控

### 它真正会先坏在哪里

它会先坏在“榜单可操纵”和“榜单不可运营”这两个地方。

如果没有反作弊：

- 同一个用户反复搜同一个词
- 同一个 IP 短时间反复刷

榜单很容易被放大出虚假热度。

如果没有人工修正：

- 运营想临时置顶一个重点活动词
- 想屏蔽一个垃圾词、测试词或脏数据词

系统也完全无能为力。

所以当前实现里的热搜服务，不只是“统计器”，还是“实时榜单治理器”。

## 第一步：搜索行为先进入分钟桶，而不是直接写榜单

`SearchController` 已经证明搜索请求会调用热搜记录逻辑：

- 笔记搜索：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:52` 到 `:58`
- 商品搜索：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:73` 到 `:79`
- 前端也可以主动调用 `/hot/record`，见 `my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:149` 到 `:159`

但这些入口都不会直接改实时榜单。真正的记录逻辑在 `HotSearchService.recordSearchKeyword()`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:127` 到 `:177`。

### 为什么先写分钟桶

当前实现不是把关键词直接写进一个全局排行，而是写入：

```text
search:window:{yyyyMMddHHmm} -> { keyword: count }
```

对应说明写在 `HotSearchService` 注释里，见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:40` 到 `:44`。

这意味着系统先把搜索行为切成一堆“每分钟的局部切片”，而不是直接更新总榜。这样后面做时间衰减时，才知道“这个 count 是 1 分钟前的，还是 50 分钟前的”。

这里还有一个容易悬空的配置细节：分钟桶 TTL 当前是 2 小时，而热度计算窗口默认只看最近 60 分钟，见 `my-xhs-search/src/main/resources/application.yml:129` 到 `:135` 和 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:166` 到 `:167`。这说明系统不是只保留“刚刚好的一小时数据”，而是额外留出一段缓冲时间，容纳定时任务漂移、手工补录或观察窗口内的重复计算，而不会因为桶刚过 60 分钟就立刻消失。

也就是说，分钟桶真正保留下来的是：

```text
不仅搜了多少次
还保留了这些次数发生在什么时候
```

## 第二步：反作弊不是外部兜底，而是写桶前的原子前置门禁

`HotSearchService` 对热搜统计的另一个重要设计，是把反作弊直接写进同一个 Lua 脚本里。

`RECORD_SCRIPT` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:80` 到 `:125` 里，原子做了四件事：

1. 检查是否命中屏蔽词
2. 先检查 IP 限频
3. 再检查用户维度同词限频
4. 最后才写入分钟桶

这条顺序非常关键。它说明反作弊不是“后面发现异常了再清理”，而是：

**先判断这次搜索有没有资格被计入热度，再决定要不要写桶。**

### 当前反作弊到底限制了什么

从配置和 Lua 参数能看出，当前至少有两道门：

- 用户维度：同一用户同一词在一段 TTL 内只计一次，TTL 由 `search.hot.antispam.user-ttl-seconds` 配置，见 `my-xhs-search/src/main/resources/application.yml:133` 到 `:135`
- IP 维度：同一 IP 每分钟搜索次数有上限，见同一配置块

这说明热搜当前既防“同一个人反复刷一个词”，也防“同一个出口 IP 短时打爆统计”。

## 第三步：真正的榜单热度不是 count，而是带时间衰减的 score

分钟桶只是在存原始行为，真正的热搜分数要靠定时任务去计算。

`calculateHotSearch()` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:181` 到 `:211` 里按固定周期重算热度；真正的汇总逻辑在 `doCalculateHotSearch()`。

### 当前热度公式是什么

类注释已经写明：

```text
Score = Σ(count × e^(-λ×Δt))
```

对应实现也很直白：

- 遍历最近 `windowMinutes` 个分钟桶，见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:218` 到 `:240`
- 对第 `i` 分钟前的桶计算 `decay = exp(-lambda * i)`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:249`
- 把每个词的原始计数乘上衰减权重累计成 score，见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:251` 到 `:257`

这说明热搜当前衡量的不是“累计多少次”，而是：

```text
最近这段时间里
按离现在越近权重越高
这个词到底有多热
```

这正是热搜和“历史总搜索榜”之间最根本的差别。

## 第四步：实时榜单要支持原子切换，不能在重算窗口暴露空榜

热度算完以后，系统还没有直接结束。

`HotSearchService` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:278` 到 `:285` 中，没有直接 `DELETE` 原榜再写新榜，而是：

1. 先写临时 ZSet
2. 再 `RENAME` 成正式实时榜 Key

这说明当前实现还专门照顾了一个很细的实时体验问题：

- 如果先删旧榜再写新榜，中间会有空窗
- 用户此刻读榜单时，可能看到空榜或半榜

所以热搜服务不仅在做“热度计算”，还在保护“榜单切换对读请求是原子的”。

## 第五步：人工置顶和屏蔽说明热搜是运营榜，不只是统计榜

光有算法还不够，当前实现还明确给运营留了手工修正入口。

### 管理端接口

`SearchController` 暴露了：

- `/hot/pin` 置顶，见 `my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:161` 到 `:172`
- `/hot/block` 屏蔽，见 `my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:187` 到 `:198`

而且它们都要求 `X-Admin-Call`。

### 服务层语义

`HotSearchService` 里也专门保留了：

- `pinKeyword()`
- `unpinKeyword()`
- `blockKeyword()`
- `unblockKeyword()`

相关位置见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:442` 到 `:468`。

这里还要点破一个很容易误解的实现细节：置顶词并不是直接改热度分，而是在展示时被插到榜单最前面。`getHotSearchList()` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:336` 到 `:359` 中，先取置顶 Set，再按顺序把它们塞进结果列表，并给它们打上 `pinned=true`、`tag="置顶"`；这些词的 `score` 在当前实现里甚至直接填 `0.0`。这说明“置顶”本质上是展示层修正，而不是热度计算本身的一部分。

这说明热搜榜在当前系统里从来都不是“算法产物唯一真相”，而是一份算法榜单 + 运营修正的混合结果。

## 第六步：快照持久化说明热搜不仅有“现在”，还要回答“那天发生了什么”

热搜如果只存在 Redis 实时榜里，就只能回答“现在最热的是什么”。

但当前实现还会把榜单快照写进 MySQL：

- 先检查 `t_hot_search_snapshot` 是否存在，见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:297` 到 `:305`
- 再删除同一分钟已有快照，写入新的 rank、score、search_count、snapshot_time，见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:307` 到 `:327`

同时，`/hot/snapshot` 接口允许按日期查历史快照，见 `my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:213` 到 `:219`。

这说明当前热搜榜有两层时间语义：

- Redis ZSet：回答“现在热不热”
- MySQL 快照：回答“那天那个时刻热过什么”

也就是说，热搜已经不只是实时榜单，而是带历史留痕的公共意图信号系统。

## 真实故障案例：为什么热搜最危险的错误，不是算分公式错一点，而是榜单被刷词或空窗期污染

热搜系统最容易被低估的，不是公式，而是榜单作为“公共信号”一旦不可信，影响会立刻外显。

### 现象

如果系统：

- 不做用户/IP 反作弊
- 不支持屏蔽脏词
- 重算时先删榜再写榜

那么用户会看到两类非常明显的问题：

1. 某个词被少数人高频刷上去，占据榜首
2. 某一瞬间榜单突然空掉或排序跳变异常

### 根因

根因并不在“热度公式用了哪一个衰减函数”，而在榜单治理本身：

- 输入是否可信
- 榜单切换是否原子
- 是否允许人工修正

这些如果没守住，再漂亮的衰减公式也只是在给脏输入做精密加工。

### 修复

当前实现围绕这个风险布了三层保护：

1. Lua 原子反作弊 + 分钟桶写入
2. 临时 ZSet + `RENAME` 原子切换榜单
3. 置顶/屏蔽人工修正能力

### 验证

验证热搜是否可靠，不能只看 `/hot` 接口有数据，而要看：

- 高频重复搜索是否被限频挡住
- 被屏蔽的词是否仍进入分钟桶或榜单
- 重算窗口中是否出现空榜
- 快照查询是否和当时榜单语义一致

### 余波

这个案例说明，**热搜真正难的不是“统计次数”，而是让一个公共榜单既实时、又可控、还不容易被刷穿。**

## 这一篇先收束成一张总图

```text
搜索行为
  → Lua 原子过滤（屏蔽词 / IP限频 / 用户限频）
    → 分钟桶 Hash 记录
      → 定时任务按窗口遍历
        → 指数衰减算分
          → 实时榜单 ZSet
            → 人工置顶 / 屏蔽修正
              → MySQL 快照沉淀
```

这里最重要的不是背参数，而是三条判断：

1. 热搜当前衡量的不是历史总量，而是最近窗口内按时间衰减后的正在变热。
2. 热搜榜是公共意图信号，因此它必须先治理输入，再谈排序公式。
3. 当前实现里的热搜不是纯 Redis 临时榜，而是“实时榜单 + 历史快照”双层结构。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 热搜服务总体职责：`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:31`
- 滑动窗口分钟桶设计：`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:40`
- 反作弊 Lua + 记录搜索词：`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:80`、`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:127`
- 热搜配置参数：`my-xhs-search/src/main/resources/application.yml:129`
- 定时计算热度与衰减：`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:181`、`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:249`
- 实时榜单原子切换：`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:278`
- 快照持久化：`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:295`
- 榜单展示层置顶插入：`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:336`
- 管理端置顶/屏蔽接口与服务层修正：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:161`、`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:187`、`my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:442`
- 历史快照查询入口：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:213`

## 边界清单

- 本篇讨论的是当前热搜榜链路，不展开推荐排序和搜索索引构建，这些分别属于前后篇章。
- 当前快照表是否存在是运行时边界：代码已做好存在性检查，但并不意味着所有环境都一定建好了 `t_hot_search_snapshot`。
- 当前热搜统计依赖搜索行为输入，不代表所有流量入口都会自动进入热搜；手工上报只是补充入口。
- 这里讲的是热搜公共榜单，不展开搜索历史的个人视角逻辑。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么热搜不是简单总计数，而是滑动窗口 + 时间衰减后的“正在变热”信号。
- 为什么热搜榜要同时考虑反作弊、人工修正和原子榜单切换，而不是只盯着公式。
- 为什么当前实现里热搜既有 Redis 实时榜，也有 MySQL 历史快照。

但它还没进入流量入口组里最后一个同样关键的问题：首页聚合为什么会把内容、商品、通知、购物车、用户资料这些下游重新拼成一个 BFF 层，以及这个聚合层如何处理超时、降级和并发调用。

所以下一篇应该进入 `04-home-bff.md`，去回答**首页 BFF 为什么不是一个薄转发层，而是一层主动管理聚合、降级与返回形态的页面编排层**。
