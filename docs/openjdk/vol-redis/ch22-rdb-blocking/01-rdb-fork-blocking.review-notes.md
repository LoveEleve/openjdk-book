# vol-redis R-19 RDB 阻塞与 fork 陷阱 — review notes

## 事实审
- `rdb.c:1593` rdbSave ✅ `rdb.c:1636` rdbSaveBackground ✅ `rdb.c:1653` redisFork ✅ `rdb.c:1452` rdbSaveRio ✅

## 因果审
- SAVE 主线程序列化全程阻塞 ✅
- BGSAVE fork 复制页表，耗时与内存正相关 ✅
- COW 峰值翻倍 ✅

## 结构审
- 从"为什么 BGSAVE 也卡"困惑开场到 SAVE/BGSAVE/COW，主线集中 ✅

## 读者审
- 读完能回答：为什么大实例 fork 慢 ✅

## 边界审
- 不展开 RDB 文件格式 ✅

## 依赖审
- 前置 R-8，后续 R-20 ✅

## 结论
R-19 通过六层审查。
