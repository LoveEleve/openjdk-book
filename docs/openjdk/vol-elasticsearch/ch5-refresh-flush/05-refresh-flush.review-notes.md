# vol-elasticsearch E-1b refresh/flush — review notes

## 事实审
- `index/engine/Engine.java:1109` 抽象 refresh() ✅
- `index/engine/InternalEngine.java:2016` maybeRefresh() ✅
- `index/engine/InternalEngine.java:2173` flush() ✅
- `index/engine/InternalEngine.java:454` internalReaderManager.maybeRefreshBlocking() ✅
- `index/engine/InternalEngine.java:138` indexWriter 字段 ✅

## 因果审
- refresh 打开新 IndexReader 使数据可见 ✅
- flush 三步（refresh + commit + newTranslog）保证持久化 ✅
- NRT = refresh 可见性 + Translog 恢复 ✅

## 结构审
- 从"为什么写入后要等 1 秒才能搜到"困惑开场到 refresh/flush/NRT 主线集中 ✅

## 读者审
- 读完能回答：refresh 和 flush 的区别 ✅

## 依赖审
- 前置 E-1a，后续 E-5 ✅

## 结论
E-1b 通过六层审查。
ENDOFFILE