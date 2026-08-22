# 篇：01 RDB 持久化阻塞与 fork 陷阱

- 域：`R-19 RDB 持久化阻塞与 fork 陷阱`
- 卷：`vol-redis`
- 目标：回答 SAVE 为什么全程阻塞、BGSAVE 的 fork 为什么可能阻塞、COW 如何放大内存。

## 前置依赖

- HARD：已读 `R-8 持久化`（知道 rdbSave / rdbSaveBackground）。

## 读者问题

1. `SAVE` 命令为什么阻塞所有客户端？
2. `BGSAVE` 的 fork 为什么在大实例上耗时？
3. COW（Copy-On-Write）怎么放大内存峰值？
4. 为什么大 key 会让 fork 更慢？

## 主结论

`SAVE`（`rdb.c:1593`）在主线程调 `rdbSaveRio` 序列化全部数据，期间阻塞所有命令。`BGSAVE`（`rdb.c:1636`）fork 子进程后 `rdbSave` 在子进程执行，主进程可继续服务，但 **fork 本身在主线程执行**——实例内存越大，fork 复制页表越慢，阻塞越久。

## 结构设计

1. 困惑开场：为什么 BGSAVE 也会卡
2. SAVE 全程阻塞
3. BGSAVE fork 的页表复制
4. COW 内存放大
5. 失败路径
6. 收网与下篇桥接 R-20

## 必须回填的源码锚点

- `src/rdb.c:1593` `rdbSave()`（SAVE 阻塞）
- `src/rdb.c:1636` `rdbSaveBackground()`（BGSAVE fork）
- `src/rdb.c:1653` `redisFork(CHILD_TYPE_RDB)`
- `src/rdb.c:1452` `rdbSaveRio()`（子进程序列化）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
