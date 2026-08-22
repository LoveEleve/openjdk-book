# vol-elasticsearch E-16 分布式搜索协调 — review notes

## 事实审
- `action/search/TransportSearchAction.java:114` class TransportSearchAction ✅
- `action/search/TransportSearchAction.java:1069` executeSearch() ✅
- `action/search/AbstractSearchAsyncAction.java:67` 协调基类 ✅
- `action/search/AbstractSearchAsyncAction.java:205` start() 入口 ✅
- `action/search/SearchPhaseController.java:66` 合并器 ✅
- `action/search/SearchPhaseController.java:165` TopDocs.merge ✅

## 因果审
- TransportSearchAction 确定目标分片，启动协调 ✅
- AbstractSearchAsyncAction 广播到各分片并收集结果 ✅
- SearchPhaseController 合并各分片 TopDocs 取全局 top N ✅

## 结构审
- 从"搜索请求发到任意节点结果怎么合并"困惑开场到 TransportSearchAction/AbstractSearchAsyncAction/SearchPhaseController 主线集中 ✅

## 读者审
- 读完能回答：协调节点怎么把分片结果合并 ✅

## 依赖审
- 前置 E-4/E-2a，后续 E-17 ✅

## 结论
E-16 通过六层审查。
ENDOFFILE