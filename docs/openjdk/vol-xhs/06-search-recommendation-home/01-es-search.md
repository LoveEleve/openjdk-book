# Elasticsearch 全文搜索

> 对应目录：`vol-xhs/06-search-recommendation-home/`
> 目标问题：为什么 `my-xhs` 的搜索不是“把商品和笔记表多查几次”就能完成，而必须引入 Elasticsearch 独立索引视图？当前搜索链到底怎样把关键词、筛选、排序、深分页、高亮和热搜记录接在一起？

## 一句话困惑

搜索在产品层面看起来很简单：用户输入关键词，系统返回一些笔记或商品。

但一旦把这个动作落回代码，就会马上碰到几个数据库查询很难优雅同时满足的问题：

- 标题和正文、商品名和类目筛选怎么同时做全文匹配？
- 排序既要支持相关性，又要支持时间、热度、价格，怎么兼顾？
- 用户翻到很深的页时，为什么不能继续用 `pageNum + offset`？
- 搜索结果里为什么要高亮，而不是只返回原文？
- 搜索动作为什么还会顺手影响热搜窗口和搜索历史？

所以这篇真正要回答的不是“ES 配置在哪”，而是：**为什么搜索在当前系统里已经不是数据库读路径的附属功能，而是一条有自己索引视图、分页语义和行为副作用的独立读链。**

## 一句话答案

在 `my-xhs` 里，搜索不是拿业务库做模糊查询，而是先把内容和商品投影成 Elasticsearch 索引视图，再由搜索服务在索引上完成关键词匹配、过滤、排序、Search After 深分页和高亮，同时把“用户搜了什么”继续扩散到搜索历史与热搜窗口。也就是说，搜索本身已经是一条“检索视图 + 行为记录”双重读链。

## 先建立最小心智模型

先把当前搜索链压成两层：

```text
索引视图层
  note_index / product_index / suggest_index

查询编排层
  keyword + filter + sort + searchAfter + highlight
  + 搜索历史 / 热搜记录副作用
```

这张图里最重要的判断是：**用户搜索时查的不是业务主表，而是 ES 索引视图。**

`my-xhs-search/src/main/resources/application.yml:93` 到 `:121` 已经把这件事写得很清楚：

- ES 地址指向 `21.130.247.89:19200`
- note 搜索用 `note_index`
- product 搜索用 `product_index`
- suggest 用 `suggest_index`

也就是说，系统从一开始就没打算把搜索当作 MySQL 的别名接口。

## 先推演第一个最直觉的失败方案：直接在业务库上做模糊查询

这是最常见、也最容易低估成本的方案。

### 为什么这个方案很诱人

因为从表面看，搜索好像只是“多加一个 `LIKE '%keyword%'`”：

- 搜笔记，就查 `title` 和 `content`
- 搜商品，就查 `name`
- 分页照常 `offset + limit`

对小体量数据来说，这种实现一开始甚至还能跑起来。

### 它会先坏在哪里

它会先坏在“全文检索不是简单过滤”的地方。

当前搜索服务明确支持：

- 关键词全文匹配
- 分类/价格筛选
- 多维排序
- 高亮
- 深分页

`NoteSearchService` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:57` 到 `:65` 把这套组合写得非常清楚；`ProductSearchService` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:50` 到 `:59` 也同样如此。

如果全压在数据库上：

- `title/content` 的分词、权重、多字段匹配会很勉强
- 相关性排序几乎没法优雅实现
- 深分页性能会随着 offset 增长快速恶化
- 高亮只能靠应用层二次拼装

这说明搜索在这里不是“多查一次表”，而是**另一种读模型。**

## 再推演第二个失败方案：用 ES 做浅分页，然后照常用 pageNum/offset 翻到底

即使接受了 ES，也很容易继续沿用数据库分页直觉：

- 第 1 页 `from=0,size=20`
- 第 100 页 `from=1980,size=20`
- 第 1000 页再继续偏移

### 为什么这个方案也很诱人

因为它和普通分页最接近，前后端都很好理解。

### 它为什么在当前实现里被主动放弃

`SearchController` 和两个搜索服务都明确写了使用 `Search After`：

- 笔记搜索：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:42` 到 `:45`
- 商品搜索：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:63` 到 `:66`

服务层里：

- `NoteSearchService` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:91` 到 `:95` 使用 `searchAfter`
- `ProductSearchService` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:80` 到 `:84` 使用 `searchAfter`

这说明系统并不把搜索页当普通分页，而是把它当成“基于排序游标继续往后走”的检索链。

### 为什么必须这样做

因为深分页真正难的不是“能不能翻到后面”，而是“后面还能不能保持性能和排序稳定”。

当前实现把这件事抽到了 `AbstractSearchService`：

- `serializeSearchAfter()` 负责把 ES 返回的排序值正确序列化，见 `my-xhs-search/src/main/java/com/myxhs/search/service/AbstractSearchService.java:29` 到 `:46`
- `parseSearchAfter()` 负责把下一页游标准确还原成 `FieldValue` 列表，见 `my-xhs-search/src/main/java/com/myxhs/search/service/AbstractSearchService.java:61` 到 `:87`

这说明搜索分页在这里已经不是 UI 层小问题，而是一个会影响检索正确性的数据结构问题。

## 第一步：搜索服务真正面对的是索引视图，不是业务主表

当前搜索服务的第一层职责，是站在 ES 索引前，而不是站在订单、商品、内容主表前。

### note 搜索视图

`NoteSearchService` 直接拿 `note_index` 作为索引入口，见 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:47`。

它的查询语义是：

- `multi_match` 搜 `title^3 + content`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:128` 到 `:133`
- 只过滤已发布笔记 `status=2`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:139` 到 `:140`

这里最重要的不是语法细节，而是它说明：**搜索视图已经把业务对象预处理成了适合检索的形态。**

### product 搜索视图

`ProductSearchService` 则把商品搜索建立在 `product_index` 上，见 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:41`。

它支持：

- 商品名关键词匹配，见 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:114` 到 `:122`
- 分类筛选，见 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:127` 到 `:130`
- 价格区间筛选，见 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:132` 到 `:143`
- 只搜上架商品，见 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:124` 到 `:125`

这进一步说明，商品搜索并不是去 product 服务本地查库，而是在独立索引视图上做“搜索版商品读模型”。

## 第二步：搜索请求不仅在查结果，还在顺手写行为轨迹

当前搜索链很容易被误看成纯 GET 读接口，但它其实带着明显的行为副作用。

### 搜索时自动记录热搜窗口

`SearchController.searchNotes()` 和 `searchProducts()` 都会在真正执行搜索前，先把关键词交给 `hotSearchService.recordSearchKeyword(...)`，见：

- 笔记搜索：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:52` 到 `:58`
- 商品搜索：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:73` 到 `:79`

这说明搜索请求不是“查完即止”，而是会反过来影响“别人之后会看到什么热搜词”。

从工程角度看，这里也出现了一个很容易被低估的边界：**搜索接口明面上是 GET/查询动作，系统内部却在同一条请求里附带了行为写入。** 这意味着搜索链既要守检索正确性，又要守热搜/历史副作用的稳定性；一旦行为记录超时或失败，理想策略也不是把搜索结果一起打崩，而是允许“读成功、行为侧副作用降级”。当前 `recordSearchKeyword()` 就是按这个思路设计的：写热搜失败只记 warn，不影响主搜索结果返回，见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:149` 到 `:176`。

### 搜索历史当前有直接证据的是笔记搜索链

`NoteSearchService` 在 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:75` 到 `:78` 里，还会把搜索关键词记入搜索历史；对应的 Redis 写入则在 `recordSearchHistory()` 中通过 Lua 原子完成，见 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:225` 到 `:254`。

这说明当前搜索链除了查询结果，还至少会生成两类行为副产品：

- 热搜统计（笔记和商品搜索都直接触发）
- 搜索历史（当前有直接源码证据的是笔记搜索链）

这让搜索变成了一条“读 + 行为记录”的复合链路，而不只是纯查询接口。

## 第三步：排序不是附属能力，而是检索语义的一部分

在数据库分页里，排序常常只是 `ORDER BY` 的一个补充项；但在当前搜索实现里，排序本身就是检索语义。

### note 搜索排序

`NoteSearchService.applySorting()` 支持：

- `relevance`
- `time`
- `hot`

对应实现见 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:145` 到 `:162`。

也就是说，搜索结果并不只有“查到了哪些文档”，还取决于你当前是想看：

- 最相关的
- 最新的
- 最热的

### product 搜索排序

`ProductSearchService.applyProductSorting()` 支持：

- `relevance`
- `price_asc`
- `price_desc`
- `sales`

见 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:149` 到 `:168`。

这说明商品搜索同样不是“命中就完”，而是在检索层已经把商品浏览意图拆成了多种排序路径。

## 第四步：高亮说明搜索结果不是原始对象回传，而是“为检索场景加工过的结果”

当前搜索服务都显式开启了高亮：

- 笔记高亮 `title + content`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:97` 到 `:102`
- 商品高亮 `name`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:86` 到 `:88`

随后又在结果组装时，把高亮字段单独映射到返回对象里：

- 笔记：`my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:194` 到 `:203`
- 商品：`my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:202` 到 `:208`

这说明 ES 搜索结果不是把原始对象原封不动吐给前端，而是：

```text
命中文档
  + 排序语义
  + 高亮加工
  = 搜索结果对象
```

这进一步证明它已经是独立读模型，而不是表查询的简单替身。

## 第五步：Search After 为什么是这条链里最容易被低估的正确性细节

当前实现里有一个非常典型、也非常“像真实系统”的修复点：Search After 序列化。

`AbstractSearchService` 注释在 `my-xhs-search/src/main/java/com/myxhs/search/service/AbstractSearchService.java:30` 到 `:37` 已经把问题写得很清楚：如果直接序列化 ES 的 `FieldValue` 对象，会把整个对象结构序列化出去，而不是排序实际值，导致下一页解析时不匹配，翻页结果为空。

这个细节的重要性在于：它说明搜索链最容易出错的地方，不一定是 ES 查不出来，而是**看起来第一页正常，第二页开始悄悄不对。**

也就是说，Search After 在当前实现里不是“高级优化”，而是保证深分页正确性的关键协议。

从工程问题视角看，这还意味着搜索结果的正确性并不只受 ES 查询语句影响，还受三层额外约束：

1. **前端/网关 URL 编码**：`searchAfter` 一旦被二次序列化或错误编码，后端即使逻辑正确也会翻页空；
2. **排序字段语义**：排序一旦引入 `_id` 这类不适合当前链路的字段，跨 shard 就可能直接报 `all shards failed`；
3. **行为副作用隔离**：即使热搜/历史记录失败，主搜索结果也不应被一并拖垮。

所以搜索链真正难的，不只是“ES 会不会用”，而是：**检索协议、排序协议和行为副作用必须同时各守住自己的边界，用户才会感知到一条稳定的搜索链。**

## 真实故障案例：为什么 `_id` 排序和错误的 Search After 序列化会让“搜索能查出来”这件事在翻页时突然失真

当前搜索链里最典型的真实问题，不是“ES 不可用”，而是“第一页正常、翻页突然坏掉”。

### 现象

用户输入关键词，第一页能看到结果；但往后翻页时，要么返回空，要么 ES 报出类似 `all shards failed` 的错误，整个搜索体验像是“只有第一页存在”。

### 根因

根因不是单一的网络或权限问题，而是检索协议细节出错：

- 用 `_id` 参与排序会触发 `all shards failed` 风险
- Search After 如果没有正确序列化/反序列化排序值，后续页就无法按相同排序上下文继续查

当前代码已经把第二个问题明确修进了 `AbstractSearchService`；交接文档和历史修复也已经记录过 `_id` 排序导致搜索异常的问题。

### 修复

当前实现围绕这个问题做了两层收口：

1. 排序基于业务字段（如 `noteId`、`spuId`）而不是 `_id`
2. Search After 只序列化排序实际值，不序列化 `FieldValue` 包装对象

### 验证

验证这种问题，不能只看第一页是否有数据，而要看：

- 第二页是否仍能稳定返回结果
- `searchAfter` 是否能正确带回
- 不同排序模式下的分页是否都成立

### 余波

这个案例说明，**搜索系统最危险的错误，往往不是直接 500，而是‘第一页正常所以大家都以为没问题’，直到真正翻深页时才暴露协议层的错位。**

## 这一篇先收束成一张总图

```text
用户输入关键词
  → SearchController
    → 记录热搜窗口 / 搜索历史
    → ES 查询 note_index 或 product_index
       - keyword
       - filter
       - sort
       - searchAfter
       - highlight
    → 组装搜索结果 VO
    → 返回结果 + 下一页游标
```

这里最重要的不是记住 ES API，而是三条判断：

1. 搜索在当前系统里已经是独立索引视图，不是业务库查询的附属接口。
2. 搜索请求除了读结果，还会顺手写热搜和历史，因此它是一条读写混合的行为链。
3. 深分页正确性不靠 `pageNum`，而靠排序语义和 `Search After` 协议一起成立。

## 证据清单

这篇的关键判断主要由以下证据托底：

- 搜索入口与热搜记录：`my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:41`
- ES 索引配置：`my-xhs-search/src/main/resources/application.yml:93`
- 笔记搜索查询策略：`my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:57`
- 商品搜索查询策略：`my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:50`
- Search After 序列化/解析修复：`my-xhs-search/src/main/java/com/myxhs/search/service/AbstractSearchService.java:29`
- 搜索历史 Lua 原子记录（当前直接证据在笔记搜索链）：`my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:225`
- 高亮结果回填：`my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:194`、`my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:202`
- 远程 ES 部署事实：`docs/FINAL-HANDOFF.md:197`

## 边界清单

- 本篇聚焦 ES 全文搜索链，不展开推荐召回、热搜计算和首页聚合，这些在后续篇章单独展开。
- 当前描述的索引视图基于现有配置和搜索服务实现，不等于本文已经完成了索引构建链的全程实证；增量/全量建索逻辑会在后续篇章补上。
- 搜索请求会写热搜和历史，这里只把它作为行为副作用指出，不把整套热搜算法细节放到本篇展开。
- `ai-app`、`ai-mcp`、`ai-tools` 不进入本篇分析线。

## 这篇解决了什么，还留下什么问题

这篇先解决了三个问题：

- 为什么搜索在 `my-xhs` 里不是数据库模糊查询升级版，而是独立索引视图读链。
- 为什么关键词、筛选、排序、高亮和 Search After 必须一起成立，搜索结果才真的可信。
- 为什么搜索请求虽然表面是 GET，但其实还在顺手生产热搜和搜索历史行为。

但它还没进入另外两块和搜索同样重要的流量入口：

- 推荐为什么不是简单热门榜，而是另一条召回/排序链
- 首页聚合为什么会把搜索、内容、用户和通知重新拼在一起

所以下一篇应该进入 `02-recommend-pipeline.md`，去回答**推荐链如何从用户行为和内容特征里继续召回与排序，而不是只靠搜索关键词**。
