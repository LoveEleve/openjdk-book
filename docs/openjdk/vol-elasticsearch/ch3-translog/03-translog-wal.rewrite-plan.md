# 篇：03 Translog：WAL 写入日志与崩溃恢复

- 域：`E-3 Translog—WAL 写入日志`
- 卷：`vol-elasticsearch`
- 目标：回答 Translog 作为 WAL 怎么保证数据不丢。

## 前置依赖

- HARD：已读 `E-1a Engine 写入路径`（知道 Engine 写入时调 Translog.add）。

## 读者问题

1. Translog.add() 写什么？写到哪里？
2. Checkpoint 文件怎么记录 globalCheckpoint？
3. Generation 轮转：flush 时怎么封闭旧 generation、创建新 generation？
4. Translog.newSnapshot() 怎么用于 peer recovery？

## 主结论

Translog（1941 行）是 ES 的 WAL（Write-Ahead Log）。`Translog.add()`（L575）把操作写入 `TranslogWriter`（`FileChannel.force(false)`）。`Translog.newSnapshot()`（L657）创建快照用于 peer recovery。flush 时 `createNewTranslog()` 封闭当前 generation，创建新 generation。

## 必须回填的源码锚点

- `index/translog/Translog.java:88` 类声明
- `index/translog/Translog.java:575` `Translog.add()`
- `index/translog/Translog.java:657` `Translog.newSnapshot()`
- `index/translog/TranslogWriter.java` 写入器
- `index/translog/TranslogDeletionPolicy.java` 删除策略

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE