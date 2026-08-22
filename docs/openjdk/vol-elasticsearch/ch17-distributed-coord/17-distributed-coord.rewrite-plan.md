# 篇：17 分布式搜索协调

- 域：`E-16 分布式搜索协调`
- 卷：`vol-elasticsearch`
- 目标：回答协调节点怎么广播和合并分片结果。

## 前置依赖
- HARD：已读 `E-4 Routing`（分片路由）、`E-2a Search 查询阶段`。

## 读者问题
1. TransportSearchAction 怎么入口？
2. AbstractSearchAsyncAction 怎么广播？
3. SearchPhaseController 怎么合并 TopDocs？

## 主结论
搜索协调 = TransportSearchAction 确定目标分片 → AbstractSearchAsyncAction 广播 → SearchPhaseController 用 TopDocs.merge 合并各分片 top N。

## 结构设计
1. 困惑开场：请求发到任意节点结果怎么合并
2. 搜索协调总图
3. 各协调类分层

## 必须回填的源码锚点
- `action/search/TransportSearchAction.java:114` + `:1069`
- `action/search/AbstractSearchAsyncAction.java:67` + `:205`
- `action/search/SearchPhaseController.java:66` + `:165`

## note / review 约束
- 四件套标准格式。
