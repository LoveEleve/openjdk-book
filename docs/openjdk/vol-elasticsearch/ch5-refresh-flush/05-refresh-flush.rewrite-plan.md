# 篇：05 refresh/flush：ES 的近实时可见性与持久化

- 域：`E-1b refresh/flush 与可见性`
- 卷：`vol-elasticsearch`
- 目标：回答 refresh 怎么让新数据可见、flush 怎么保证持久化。

## 前置依赖

- HARD：已读 `E-1a Engine 写入路径`（知道写入先到 Lucene buffer 再到 Translog）。

## 读者问题

1. refresh 做了什么？为什么默认 1s？
2. flush 做了什么？为什么默认 30min 或 512MB？
3. refresh 和 flush 的区别是什么？
4. NRT（Near-Real-Time）搜索是怎么实现的？

## 主结论

**refresh**（`Engine.java:1109` 抽象定义，`InternalEngine.java:2016` `maybeRefresh`）→ `ReferenceManager.maybeRefresh()` → 打开新 `IndexReader`，使新 segment 可见。**flush**（`InternalEngine.java:2173`）→ ①refresh ②Lucene `IndexWriter.commit()`(fsync) ③`Translog.createNewTranslog()` 新 generation。NRT 搜索 = refresh 让新数据近实时可见（默认 1s），但未 fsync 的数据由 Translog 保证 crash-safe。

## 必须回填的源码锚点

- `index/engine/Engine.java:1109` 抽象 `refresh()`
- `index/engine/InternalEngine.java:2016` `maybeRefresh()`
- `index/engine/InternalEngine.java:2173` `flush()`
- `index/engine/InternalEngine.java:454` `internalReaderManager.maybeRefreshBlocking()`
- `index/engine/InternalEngine.java:138` `indexWriter` 字段

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE