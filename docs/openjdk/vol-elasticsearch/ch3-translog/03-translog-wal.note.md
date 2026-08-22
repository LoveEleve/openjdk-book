# vol-elasticsearch E-3 Translog — note

## 本篇主张

- Translog（1941 行）是 ES 的 WAL，`Translog.add()`（L575）先写日志再写 Lucene。
- Checkpoint 文件记录 globalCheckpoint 和 minTranslogGeneration。
- flush 时 `createNewTranslog()` 封闭当前 generation，创建新 generation。
- `Translog.newSnapshot()`（L657）创建快照用于 peer recovery。

## 下篇桥接

- E-1a Engine 写入路径。
ENDOFFILE