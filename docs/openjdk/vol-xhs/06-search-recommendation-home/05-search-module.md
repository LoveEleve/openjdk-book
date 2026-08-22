# search：索引视图、推荐与热搜的读模型中心

> 对应模块：`my-xhs-search`
> 目标问题：search 这个服务除了 ES 查询，还真正承担了哪些业务和系统职责？

## 一句话答案

`my-xhs-search` 不是单一搜索接口，而是整个发现页读模型中心：它一边管理 ES 搜索、Search After、高亮、搜索历史和热搜，一边管理推荐召回、排序、行为回流和榜单副作用，真正持有的是“发现流量入口该怎么看世界”的那套索引与规则视图。

## 1. 业务：它负责的不是主数据，而是发现入口的读模型

search 回答的不是“笔记和商品本体是什么”，而是：

- 当用户输入关键词时，哪些内容/商品最值得被看到
- 当用户没有明确输入时，哪些内容最值得被推荐
- 当前正在变热的词是什么
- 用户自己的搜索历史和建议词是什么

这决定了它的业务定位天然是视图层，而不是主数据域。

## 2. 微服务：它和 content / product / home 的边界是“视图生产”和“页面消费”

### 2.1 与 content / product 的边界

search 不拥有笔记和商品主数据，它消费并投影这些主数据，形成：

- `note_index`
- `product_index`
- `suggest_index`

见 `my-xhs-search/src/main/resources/application.yml:93`。

### 2.2 与 home 的边界

search 负责把搜索、推荐、热搜这类“发现结果”组织好；home 再把这些结果和作者信息、计数、互动状态拼成页面级 VO。也就是说，search 更像发现读模型中心，home 更像页面编排层。

## 3. 分布式：它靠索引投影、异步补偿和协议化分页维持正确性

### 3.1 搜索查的是 ES 投影视图，不是业务主表

- 笔记搜索直接查 `note_index`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:47`
- 商品搜索直接查 `product_index`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/ProductSearchService.java:41`

### 3.2 深分页靠 Search After 协议，而不是 offset 直觉

Search After 的真正难点不在“语法会不会写”，而在“排序值如何稳定序列化并跨请求传回下一页”。这一层已经被单独收在 `AbstractSearchService`，见 `my-xhs-search/src/main/java/com/myxhs/search/service/AbstractSearchService.java:29`。

### 3.3 索引一致性靠增量同步和补偿收尾

search 不是实时写 ES 的单点强一致系统。它依赖消息和任务把内容/商品变化继续投影到索引，再用补偿任务兜底。这也是为什么之前需要修复 `IncrementalIndexSyncJob` 中 `SPOP` 非原子的问题：多实例补偿会重复处理同一批增量键。

## 4. 工程：这个模块最重的是“读协议”而不是 Controller 数量

### 4.1 搜索链是读 + 行为副作用复合链

搜索请求除了返回结果，还会：

- 记录热搜关键词，见 `my-xhs-search/src/main/java/com/myxhs/search/controller/SearchController.java:52`
- 记录搜索历史，见 `my-xhs-search/src/main/java/com/myxhs/search/service/NoteSearchService.java:225`

这意味着 search 的工程难点不是“查 ES”，而是“主读结果不能被副作用失败拖垮”。

### 4.2 推荐链已经是规则化多路召回 Pipeline

`RecommendService` 不是热门榜接口，而是五路召回 + 粗排 + 精排 + 重排，见 `my-xhs-search/src/main/java/com/myxhs/search/service/RecommendService.java:22`。

### 4.3 热搜链是实时信号系统，不是单表计数器

热搜同时维护：

- Redis 分钟桶和实时榜
- MySQL 快照历史
- 反作弊 Lua
- 人工置顶/屏蔽

见 `my-xhs-search/src/main/java/com/myxhs/search/service/HotSearchService.java:31`。

## 5. Bug：这轮重扫继续确认的真实问题

### 5.1 增量索引补偿原来有跨实例重复处理窗口

`IncrementalIndexSyncJob` 旧实现先随机取成员、再单独 remove，两个动作不原子，多实例同时补偿时会重复消费同一批待同步键。现在已经修成 Redis 原子 `pop()`。

### 5.2 推荐精排里的“用户偏好”维度原来名义存在、实际失效

`RecommendService.getUserPreferenceScore()` 旧实现里错误地用 `noteId` 去拼 `recommend:user_tags:*` key，而且最终无论查到什么都固定返回 `0.5`。结果是精排虽然写着“四维加权”，但用户偏好这一维实际没有参与排序。

现在已经改成：用 `userId` 读取 `RedisKeyConstants.RECOMMEND_USER_TAGS + userId`，再按 `item.category` 取标签权重，让用户偏好真正进入精排。

### 5.3 Search After 正确性取决于排序值协议，不只是 ES 可用性

如果排序字段选错、排序值序列化错、或者前端把 `searchAfter` 再包一层错误编码，第一页仍然可能看起来完全正常，但第二页开始就空结果或 `all shards failed`。这类问题的危险性在于：它不是“彻底坏掉”，而是“翻页时才暴露”。

## 6. 真实故障案例：为什么索引补偿任务会在多实例下悄悄重复执行

### 现象

ES 看上去没有宕，主搜索也还能用，但索引补偿任务在多实例部署时会重复处理同一批待同步键：日志里能看到同一对象被重复补写，ES 侧出现不必要的重复更新，补偿吞吐下降。

### 根因

问题不在业务映射，而在任务取数协议。旧实现是“先从集合里拿一批成员，再单独 remove”；多实例同时跑时，两个实例可以先后拿到同一批成员，再各自尝试删除，于是补偿动作重复。

### 修复前

- 读取待补偿成员
- JVM 暂存结果
- 再单独删除 Redis 集合成员

这意味着读取和删除之间存在并发窗口。

### 修复后

- 直接使用 Redis 原子 `pop()`
- 谁弹出谁处理
- 多实例之间不再共享那段未删除窗口

### 余波

这个故障说明 search 这种“看起来偏读”的服务，一旦带有补偿任务、消息消费和索引维护，就同样会踩到典型的分布式并发坑。问题不一定出在查询本身，也可能出在“后台怎样把索引视图慢慢追上来”。

## 证据清单

- ES 搜索主文：`docs/openjdk/vol-xhs/06-search-recommendation-home/01-es-search.md:1`
- 推荐主文：`docs/openjdk/vol-xhs/06-search-recommendation-home/02-recommend-pipeline.md:1`
- 热搜主文：`docs/openjdk/vol-xhs/06-search-recommendation-home/03-hot-search.md:1`
- 增量补偿修复点：`my-xhs-search/src/main/java/com/myxhs/search/job/IncrementalIndexSyncJob.java:1`
