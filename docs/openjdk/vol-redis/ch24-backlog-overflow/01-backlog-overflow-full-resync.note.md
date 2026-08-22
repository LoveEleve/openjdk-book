# vol-redis R-21 backlog 溢出与全量风暴 — note

## 本篇主张

- `repl_backlog`（`replication.c:102`）是环形缓冲，`repl_backlog_size`（`server.h:1880`）默认 1MB。
- backlog 最旧数据被新数据覆盖后，从节点 offset 不在缓冲内，PSYNC 退化为全量。
- 多从节点同时退化全量造成复制风暴。

## 本篇边界

- 不展开 `client-output-buffer-limit replica` 的完整交互。

## 下篇桥接

- R-22 AOF fsync 与磁盘抖动。
