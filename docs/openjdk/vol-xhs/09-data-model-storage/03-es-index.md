# 03 ES Index：为什么这套索引不是“把 MySQL 数据同步到 Elasticsearch”这么简单

到 `09-data-model-storage/` 的第三篇，读者最容易带着的一个误解是：前面已经写了 MySQL 分片、Redis 状态平面，那么 Elasticsearch 大概只是另一个“把业务数据搬一份过去做搜索”的存储层，结构应该很直白。

`my-xhs` 恰恰不是这样。它的 ES 索引链真正难的地方，从来不是“有没有索引”或“Client 怎么写”，而是**哪些字段该进入索引、索引更新是走实时增量还是离线重建、Canal / MQ / Consumer / ES 版本控制之间的时序关系怎样收口、以及搜索 API 在读取索引时怎么避免被排序、分页和版本域这些细节反咬一口。** 如果只把它写成“MySQL → Canal → MQ → ES”，那顶多是画出了一条总线，却没有解释这条总线为什么经常在最危险的地方出问题。

前面的材料其实已经不断暴露这套复杂度。搜索服务起码经历过两类典型故障：一类是读路径故障，比如 `_id` 排序导致 `all shards failed`、Search After 整体序列化导致翻页空结果；另一类是写路径故障，比如 Canal 因 JDK 17 不兼容而“服务在跑但不下发事件”，以及更细的版本域 / 补全字段 / 计数覆盖问题。也就是说，`my-xhs` 的 ES 从一开始就不是“索引建了就好”，而是一整条需要被持续校正的**读写双链路**。

所以本篇真正要回答的，不是“ES 索引有哪些”，而是三句话：第一，搜索服务到底把哪些业务对象投影成 `note_index`、`product_index`、`suggest_index` 这类查询视图；第二，这些视图为什么不能被误当成权威真相，只能被理解成 MySQL 主数据的读优化投影；第三，MySQL、Canal、MQ、Consumer、ES、Search API 之间为什么会在排序、分页、版本和补偿上不断出现细碎但致命的故障。

## 先给结论：`my-xhs` 的 ES 索引是“面向查询的投影视图”，不是业务真相副本

先别急着看 Client 代码，先把本篇最重要的人话答案钉住：`my-xhs` 的 Elasticsearch 不是拿来保存业务真相的第二数据库，而是拿来承接查询模式的投影视图。

这句话在项目里至少有三层含义。

第一，索引字段是按查询需求组织的，而不是按原始表结构逐列镜像。`note_index` 和 `product_index` 服务的，都是全文搜索、高亮、排序、过滤、Suggestion 这些查询模式；它们不需要也不适合携带一切原始关系字段。第二，索引更新虽然追求及时，但本质上仍是**增量同步 + 全量重建兜底**的最终一致性链，而不是 MySQL 的同步事务影子。第三，搜索 API 的读取结果也不应被误当成业务真相，因为它们天然可能滞后、字段投影不全、排序依赖 ES 语义、分页依赖 Search After 游标。

一旦把 ES 当成“真相副本”，后面很多细节都会被写错。你会误以为 Canal 一更新、ES 就一定立刻一致；误以为索引文档字段缺一点只是显示问题；误以为 Search After 只是“另一种分页”；误以为 `_id` 拿来做稳定排序天然没问题。`my-xhs` 的真实修复记录恰恰说明这些直觉全都会出事。`

## 直觉方案为什么不够：把索引当镜像、把增量当实时、把分页当普通页码都会踩坑

### 失败方案一：索引只是 MySQL 的镜像表

这是最常见的误解。既然搜索服务要查笔记和商品，那就把 `t_note`、`t_spu`、`t_sku`、分类、价格、计数等字段同步进 ES，做一份比较宽的 JSON 文档，后续搜索都打它。这样讲当然不算错，但它忽略了一个关键事实：**索引文档的形状是按搜索体验裁剪的，不是按业务表结构自然导出的。**

比如 `NoteSearchService` 的查询只关心 title、content、coverImage、计数、createdAt 这些能支持全文搜索、高亮和排序的字段；而 `ProductSearchService` 关注的则是 name、categoryId、categoryName、brandName、price、sales、image 等能支持筛选与多维排序的投影字段。索引文档不是为了“把一整行业务对象搬过去”，而是为了把前台查询真正会用到的字段组织成更适合检索的视图。`my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:80` `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:69`

一旦忘掉这一点，你就会在很多地方做出错误判断。比如看到索引里缺少某个业务字段，就以为同步链坏了；看到某个宽表字段是补全算出来的，又以为这只是显示层问题。其实对索引来说，**字段选择本身就是设计的一部分**。不是每个业务字段都该进索引，也不是每个索引字段都天然等价于某个主表列。

### 失败方案二：Canal 增量同步 = 实时强一致

第二个误解更危险：既然项目已经有 Canal、RocketMQ 和 Search Consumer，那索引自然就是近实时、近乎同步的。真实世界里，这种写法最容易把文章带偏。

`docs/canal-issue.md` 已经给了一个非常典型的反例：Canal 1.1.7 配 JDK 17 时，binlog decoder 会“服务在跑但不下发事件”。这类故障最难排，不是因为 Canal 完全挂了，而是因为表面上进程是活的，真正的数据通路却断了。修复动作不是重写业务代码，而是把 Canal 切回 Kona JDK 8，重新对齐 note/product/inventory 三个实例的位点。`docs/canal-issue.md:8`

这件事说明一条很重要的原则：**MySQL → Canal → MQ → ES** 这条链天然是异步最终一致，不仅会有正常延迟，还会有中间环节“看起来活着、实际上没同步”的失败模式。文章如果直接把 Canal 增量同步写成“数据实时进 ES”，就是在把 L0/L1 的拓扑写成 L2 的强口气。

### 失败方案三：ES 搜索分页就是换个写法的页码分页

第三个误解发生在读路径。很多人看到 Search API 暴露 `searchAfter`，会下意识把它理解成“比 pageNo / pageSize 更高级一点的分页参数”。但在 `my-xhs` 里，Search After 不是换皮页码，而是**深分页能否继续正确工作的前提条件**。

Search After 的核心要求是：服务端排序值必须稳定、可序列化、客户端必须原样带回游标值。如果把它当成普通页码，你就很容易在排序和序列化两个层面踩坑。而 `my-xhs` 的搜索服务已经踩过这两个坑：一是用 `_id` 参与排序导致 `all shards failed`，二是把 Search After 的 `FieldValue` 直接整体序列化，结果翻页空结果。这两次修复都被明确记在交接和搜索服务修复记录里。`docs/HANDOFF.md:65` `docs/FINAL-HANDOFF.md:42`

这说明本篇不能把 ES 只讲成数据同步链，也必须把 Search API 自己怎样读取索引、怎样被 ES 语义反过来约束写进去。

## 先画总图：`my-xhs` 的 ES 读写链到底长什么样

先把整条链用文字图立住：

```text
主数据真相层
  MySQL（note / product / inventory 等业务表）

增量写链
  MySQL binlog
    -> Canal instance（note / product / inventory）
    -> RocketMQ topic
    -> NoteIndexSyncConsumer / ProductIndexSyncConsumer
    -> 失败文档进入 IncrementalIndexSyncJob 补偿集合
    -> ES 19200
       - note_index
       - product_index
       - suggest_index

全量兜底链
  IndexRebuildJob / rebuild 配置（凌晨 4 点）
    -> 扫主数据源
    -> 重建索引文档
    -> 覆盖式校正 ES 投影

读路径
  NoteSearchService
    -> multi_match(title^3, content)
    -> filter(status)
    -> sort(relevance/time/hot)
    -> search_after
    -> highlight(title/content)

  ProductSearchService
    -> match(name)
    -> filter(status/categoryId/price range)
    -> sort(relevance/price/sales)
    -> search_after
    -> highlight(name)
```

这张图里最重要的不是组件名字，而是两条基本纪律。

第一，**索引不是业务真相，MySQL 才是。** ES 只承接投影与查询优化。第二，**读链和写链各有自己的失败模式。** 写链会在 Canal、MQ、Consumer、补偿、版本域上出问题；读链会在排序、分页、高亮、编码和 ES 自身规则上出问题。只讲一边都不够。

## 读路径这一侧：`note_index` 和 `product_index` 真正服务的不是存储，而是查询模式

### `note_index`：title 与 content 被重新组织成全文检索视图

`NoteSearchService` 的注释已经把查询策略写得很清楚：它不是“按主表字段随便搜一搜”，而是明确围绕全文搜索体验组织查询。

- `multi_match` 只搜 `title^3` 和 `content`
- filter 只取已发布笔记（当前代码里是 `status=2`）
- 排序支持 relevance / time / hot
- 深分页依赖 Search After
- 高亮只针对 title / content

`my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:57`

这条链最重要的启示，不是实现上用了 `multi_match`，而是 `note_index` 的文档结构本身就已经被搜索场景重组过了。标题权重更高，内容权重更低；highlight 只关心展示字段；返回 VO 里也只保留前台搜索结果真正需要的那几个投影字段。它不是“ES 存了 MySQL 笔记表”，而是“ES 存了前台发现页 / 搜索页想看到的笔记视图”。

### `product_index`：分类、价格、销量这些字段不是附带，而是排序与过滤的主语

商品搜索则更能体现“索引按查询模式建模”的特点。`ProductSearchService` 的查询里，全文只打 `name`；但真正决定用户搜索体验的，往往是分类过滤、价格区间过滤，以及 `price_asc`、`price_desc`、`sales` 这些排序选项。也就是说，`product_index` 不是拿来“存商品详情”的，而是拿来承接“搜索场景中会被筛、会被排、会被高亮”的字段组合。`my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:50`

这也是为什么正文不能把索引设计写成“字段同步”。一旦价格、分类名、品牌名、销量这些补全字段出错，对搜索来说就不是显示毛刺，而是排序 / 过滤语义直接跑偏。

## Search After 为什么必须单独讲：它是这套搜索 API 正常分页的结构前提

如果只看 `searchNotes()` 和 `searchProducts()`，读者很容易把 `searchAfter` 当成一个实现细节。但在 `my-xhs` 里，它其实是搜索 API 是否可用的核心结构件。

两条服务都采用了同一种模式：服务端一次多取 `size + 1` 条数据，用最后一条 `sort values` 序列化成 `searchAfter` 游标带回客户端；下一页请求再把这串游标带回来，继续从上一次排序边界之后向前推进。`my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:80` `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:69`

这套模式一旦被误当成页码，就会马上掉进两个坑。

第一，排序键必须稳定且可跨 shard 比较。历史上 `search` 服务正是因为使用了 `_id` 作为 tiebreaker，才触发了 `all shards failed`。这个修复已经在交接材料中明说：移除 `_id` tiebreaker。`docs/HANDOFF.md:65`

第二，游标值必须按 ES 的 `FieldValue` 语义序列化，而不是随便把对象整体 JSON 化。历史修复也明确记了：`Search After FieldValue` 直接整体序列化会让翻页空掉，后来补了 `serializeSearchAfter`。`docs/FINAL-HANDOFF.md:43`

这意味着 Search After 在这里不是一种“可有可无的优化”，而是读路径自己的一条状态协定：**索引排序规则、返回游标格式和下一页请求参数必须严格同构。**

## 写路径这一侧：Canal、MQ、Consumer 和重建任务共同决定索引最终长什么样

### 增量同步链为什么不能写成一句“Canal 同步到 ES”

交接材料和 Canal 故障文档已经把最容易犯错的口径暴露得很清楚：如果你把索引更新写成一句“Canal 把 MySQL 同步到 ES”，那在 `my-xhs` 里几乎肯定会误导读者。

因为真实链条至少有四段：MySQL binlog → Canal instance → RocketMQ → Search 侧消费 / 索引同步逻辑 → ES。这不是字面上的苛求，而是每一段都可能单独出问题。

`docs/canal-issue.md` 那次故障就是最好的说明：Canal 进程没有明显挂掉，但因为 JDK 17 不兼容，binlog decoder 静默罢工，于是 note / product / inventory 三条索引链一起“看起来有同步组件，实际上没有事件流动”。修完后才恢复到“UPDATE 10 秒内 ES 可见”的状态。`docs/canal-issue.md:10`

所以更严谨的写法应该是：Canal 提供的是 ES 增量投影链的前半段，而不是“同步已完成”的保证。真正决定索引里最终文档长什么样的，还要看 MQ 是否投递、Consumer 是否成功消费、Consumer 在构造文档时有没有补全字段、是否触发补偿或重建。

### 全量重建为什么是兜底，不是多余任务

`my-xhs-search` 的 `application.yml` 里明确保留了 `search.rebuild.batch-size=500` 和凌晨 4 点的 cron 配置，这本身就是一种非常清楚的信号：作者从来没有把增量链当成“永不漂移”的真理，而是默认需要全量重建来做周期性校正。`my-xhs-search/src/main/resources/application.yml:126`

这条设计的意义非常大。因为增量链只要出现一次 Canal 延迟、MQ 堵塞、Consumer 补全失败、字段覆盖错误、版本冲突，ES 投影就会慢慢偏离 MySQL 真相。如果没有全量重建，偏差只能靠人工纠错或单条补偿去慢慢修；而定时 rebuild 的意义，就是定期让“查询视图”回到“主数据当前应有的样子”。

这也解释了为什么项目历史材料经常把 `IndexRebuildJob` 写成“凌晨 4 点全量兜底”。它不是浪费资源的重复工作，而是对异步投影链天然漂移风险的承认。

这里还可以再往前走一步：`IndexRebuildJob` 在代码上并不是“再跑一遍同步逻辑”这么简单，而是在主动维护一套**权威真相 → 投影视图**的收敛纪律。它至少显式处理了三类工程问题：

1. **断点续传**：用 Redis 记录 `lastNoteId/lastSpuId`，中断后继续，见 `my-xhs-search/src/main/java/com/myxhs/search/job/IndexRebuildJob.java:156` 到 `:187`；
2. **分布式互斥**：用 Redisson 锁保证多实例只有一个全量重建在跑，见 `my-xhs-search/src/main/java/com/myxhs/search/job/IndexRebuildJob.java:79` 到 `:98`；
3. **源表/文档构建一致性**：重建时不直接接受半成品文档，而是显式检查源表可用、跨库读取和文档构建是否完整，失败就中断本批次，而不是把“半正确视图”继续写进 ES。

这说明全量重建在当前实现里不是一个“补丁脚本”，而是索引系统承认自己永远可能偏离真相后，专门保留的**视图重放器**。它和事务系统里的补偿任务非常像：都不是在重新制造真相，而是在用权威源把衍生视图重新拉回正确轨道。

## 真实故障案例一：`_id` 排序导致 `all shards failed`，暴露的是“能排序”不等于“适合做跨 shard 稳定排序”

按照本卷方法论，每篇都要有真实故障案例。对 ES 索引这篇来说，第一个最适合的案例就是 `_id` 排序导致的 `all shards failed`。

这个故障的特别之处在于，它不是索引没同步，也不是 ES 挂了，而是读路径在排序语义上踩了 ES 自己的规则边界。历史交接材料把它记录得非常明确：`search` 服务曾因 `_id` 排序触发 `all shards failed`，后续修复是移除 `_id` tiebreaker。`docs/HANDOFF.md:67`

这类故障非常值得写进正文，因为它逼出了一个很多人默认不会单独讲的事实：**不是所有看起来稳定唯一的字段，都适合拿来做跨 shard 排序兜底。** 在分布式检索系统里，“唯一”与“可排序、可比较、语义稳定”是两回事。

用方法论的五段式收它：

- 现象：搜索请求直接报 `all shards failed`
- 根因：排序链路中使用 `_id` 作为 tiebreaker，触发 ES 分片级排序问题
- 修复：移除 `_id` tiebreaker，改为更稳定的业务字段排序组合
- 验证：交接材料已记录该问题修复完成
- 余波：以后任何 Search After / 多字段排序设计，都要先考虑跨 shard 排序语义，而不是只看字段是否唯一

## 真实故障案例二：Search After 序列化错误，暴露的是“分页状态”本身也是协议的一部分

第二个特别值得保留的故障，是 Search After 的 `FieldValue` 序列化问题。历史修复记录写得很直接：`Search After FieldValue` 整体序列化会导致翻页空，后来新增了 `serializeSearchAfter`。`docs/FINAL-HANDOFF.md:43`

这件事之所以值得单独讲，不是因为它技术上多复杂，而是因为它把一个常常被忽略的事实暴露出来：**分页状态本身也是前后端 / 前后页之间的一部分协议。** 如果服务端对 Search After 的 `sort values` 编码方式不稳定，客户端哪怕原样带回了“某个字符串”，下一页也可能完全失效。

所以这类问题不能简单写成“翻页 bug 已修”。更准确的理解是：索引读取链不只依赖索引文档本身，还依赖一套稳定的分页状态协议，而这套协议一旦错了，索引即使完全正确也没法被正常翻页读取。

## 证据清单：本篇关键结论分别站在哪一层

L0 源码静态证据：

- `NoteSearchService` 明确围绕 `note_index` 组织 `multi_match`、filter、排序、Search After 与 highlight。`my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:57`
- `ProductSearchService` 明确围绕 `product_index` 组织分类、价格、销量等过滤与排序逻辑。`my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:50`
- 搜索服务配置中显式存在 `note_index`、`product_index`、`suggest_index` 以及 rebuild batch/cron 参数。`my-xhs-search/src/main/resources/application.yml:109`
- 搜索域当前可直接核到的索引写链组件并不抽象：`NoteIndexSyncConsumer`、`ProductIndexSyncConsumer`、`IncrementalIndexSyncJob`、`IndexRebuildJob` 都在仓库内真实存在。`my-xhs-search/src/main/java/com/myxhs/search/consumer/NoteIndexSyncConsumer.java:58` `my-xhs-search/src/main/java/com/myxhs/search/consumer/ProductIndexSyncConsumer.java:56` `my-xhs-search/src/main/java/com/myxhs/search/job/IncrementalIndexSyncJob.java:55` `my-xhs-search/src/main/java/com/myxhs/search/job/IndexRebuildJob.java:49`
- `NoteSearchService` 自身就包含了“搜索历史写 Redis Lua 脚本”这类读链辅助状态逻辑，说明搜索域并不是单纯 ES client 包一层。`my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:225`

L1 框架 / 语义证据：

- Search After 不是页码分页，要求排序值稳定、可序列化并由客户端原样携回；否则即使索引本身正确也会在读链上失效。
- ES 排序字段能否跨 shard 稳定工作，是读路径语义的一部分；字段“唯一”并不等价于“适合排序兜底”。
- 增量投影链与全量重建链共存，说明系统默认接受“ES 是最终一致的查询视图，而不是同步真相”。

L2 运行态证据：

- `docs/canal-issue.md` 已确认 Canal 因 JDK 17 不兼容导致索引同步链失效，修完后 MySQL UPDATE 10 秒内 ES 可见。`docs/canal-issue.md:10`
- `FINAL-HANDOFF.md` 已记录 Canal 增量同步（UPDATE/软删）验证通过，说明 ES 增量写链曾在运行态打 through。`docs/FINAL-HANDOFF.md:222`
- `FINAL-HANDOFF.md` 也已记录 Search After 翻页 3 页无重复，说明修复后的分页协议曾通过端到端验证。`docs/FINAL-HANDOFF.md:232`
- `HANDOFF.md` 已记录 `_id` 排序与 Search After 序列化两类搜索故障均已修复。`docs/HANDOFF.md:65`

## 边界清单：哪些话现在能说，哪些还不能写满

第一，当前可以明确写出搜索索引是 `note_index` / `product_index` / `suggest_index` 这类面向查询的投影视图，但不能把它写成“索引文档字段已经等价覆盖全部业务真相”。ES 在这里是读优化视图，不是主数据真相库。

第二，当前可以明确写出 Canal + MQ + Consumer + Rebuild 共同构成索引更新链，但不能直接写成“当前环境里增量索引链一定实时在线”。历史验证确实通过过，但那是带时间戳的运行态事实；当前此刻并没有再次现场复验。

第三，当前可以明确写出 Search After 修复后曾做到 3 页无重复，但不能把它写成“任意排序组合都已经永远安全”。分页协议的正确性仍依赖排序字段选择与序列化实现，不是一次修复后永久免疫。

第四，当前可以明确写出 `_id` tiebreaker 和 Search After 序列化都曾引发真实故障，但不能因此把 ES 整体写成“不稳定组件”。更准确的说法是：ES 读写链的边界比单库查询复杂，必须持续用排序、分页、版本与补偿纪律去约束。

## 收网：这篇 ES Index 真正建立了什么

到这里可以回收开头的问题了。`my-xhs` 的 ES 索引不是“把 MySQL 数据搬一份过去”的平移工程，而是一套围绕查询模式建模、围绕异步投影收口、围绕排序 / 分页协议长期校正的搜索视图系统。它真正复杂的地方，不在 Client API 本身，而在于：哪些字段应该进视图、哪些字段不该假装是真相、哪条增量链可能静默失效、哪种排序会让跨 shard 直接崩掉、哪种分页协议错误会让读路径空转。

从业务逻辑视角看，它守住的是前台搜索、推荐与发现体验需要的查询投影；从工程视角看，它把 ES Java Client、Canal、MQ、Consumer、Redis 搜索历史与 rebuild 任务织成了一张复杂但可解释的读写网；从分布式视角看，它明确承认了索引最终一致、分页状态协议与跨 shard 排序这些天然边界；从微服务视角看，它也把 search 服务和主数据服务之间的关系钉成了“投影读取者”，而不是“第二真相库”。

更重要的是，本篇把一个特别容易被忽略的事实钉住了：**在搜索系统里，真正危险的从来不是“没建索引”，而是“索引链看起来都在，结果排序、分页、版本和补偿默默把读写语义做错了”。**

下一篇如果继续沿 `09-data-model-storage/` 推进，最自然的顺序就是进入 `docs/openjdk/vol-xhs/09-data-model-storage/04-mq-topology.md`，把前面交易链、索引同步、通知和事务消息里反复出现的 Topic / 消费组 / 幂等与死信拓扑统一收束。