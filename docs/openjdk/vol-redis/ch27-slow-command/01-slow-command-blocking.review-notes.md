# vol-redis R-24 慢命令阻塞与 IO 多线程边界 — review notes

## 事实审
- `db.c:864` keysCommand ✅ `dict.c:1369` dictScan ✅ `server.c:3184` lookupCommandLogic ✅ `config.c:3149` io-threads 默认 1 ✅

## 因果审
- KEYS 全表遍历阻塞 ✅
- EVAL 死循环 + WRITE_DIRTY 只能 SHUTDOWN ✅
- IO 多线程只读写作不解决命令执行 ✅

## 结构审
- KEYS/大集合/EVAL/IO边界 主线集中 ✅

## 读者审
- 读完能回答：IO 多线程为什么解决不了慢命令 ✅

## 边界审
- 不展开 dictScan 算法 ✅

## 依赖审
- 前置 R-2/R-27，后续 R-16 ✅

## 结论
R-24 通过六层审查。生产排障层（R-19~R-24）全部完成。
