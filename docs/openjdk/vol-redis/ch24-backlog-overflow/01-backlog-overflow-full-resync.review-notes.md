# vol-redis R-21 backlog 溢出与全量风暴 — review notes

## 事实审
- `replication.c:102` createReplicationBacklog ✅ `replication.c:104` repl_backlog zmalloc ✅ `server.h:1880` repl_backlog_size ✅

## 因果审
- backlog 环形缓冲覆盖旧数据 → 从节点 offset 失效 → 退化全量 ✅
- 多从节点同时退化 → 复制风暴 ✅

## 结构审
- 环形缓冲/覆盖/风暴主线集中 ✅

## 读者审
- 读完能回答：为什么 backlog 太小导致全量 ✅

## 边界审
- 不展开 replica 输出缓冲限制完整交互 ✅

## 依赖审
- 前置 R-9，后续 R-22 ✅

## 结论
R-21 通过六层审查。
