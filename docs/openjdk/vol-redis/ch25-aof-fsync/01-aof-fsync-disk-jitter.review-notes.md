# vol-redis R-22 AOF fsync 与磁盘抖动 — review notes

## 事实审
- `aof.c:1045` flushAppendOnlyFile ✅ `aof.c:1117` aofWrite ✅ `server.h:1788` aof_buf ✅ `aof.c:905` aof_background_fsync ✅

## 因果审
- always 每条命令 fsync 慢 ✅
- everysec bio 异步 fsync 最多丢 1s ✅
- write() 在磁盘慢时阻塞 ✅

## 结构审
- 三策略/阻塞/rewrite 主线集中 ✅

## 读者审
- 读完能回答：everysec 为什么丢 1s ✅

## 边界审
- 不展开 aof_buf 细节 ✅

## 依赖审
- 前置 R-8，后续 R-23 ✅

## 结论
R-22 通过六层审查。
