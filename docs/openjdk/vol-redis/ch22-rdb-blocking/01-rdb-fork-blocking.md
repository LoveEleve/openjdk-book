# SAVE 和 BGSAVE 为什么都会卡

> 本文基于 Redis 7.4.2 当前源码。本文是排障层第一篇，回答 RDB 持久化的阻塞问题。

## 一、SAVE 全程阻塞

`rdbSave()`（`src/rdb.c:1593`）在主线程调用 `rdbSaveRio()`（`:1452`）序列化全部数据到文件。期间主线程无法处理任何命令。生产环境禁用 `SAVE`。

## 二、BGSAVE fork 阻塞

`rdbSaveBackground()`（`src/rdb.c:1636`）调 `redisFork(CHILD_TYPE_RDB)`（`:1653`）创建子进程。fork 在主线程调用，**复制父进程的页表**——实例内存越大，页表越大，fork 越慢。10GB 实例的 fork 可能耗时数十毫秒，期间主线程暂停。

## 三、COW 内存放大

fork 后子进程与主进程共享内存页。主进程继续处理写命令，修改的页被复制（COW），峰值内存可能达到正常的两倍。

## 四、失败路径

- `SAVE` 在大实例上阻塞数秒，禁止生产使用
- fork 耗时与实例内存正相关，`BGSAVE` 在百 GB 实例上可能阻塞秒级
- COW 峰值叠加，可能触发 `maxmemory` 淘汰

## 收网

`SAVE` 阻塞主线程全程，`BGSAVE` 阻塞主线程 fork 阶段，子进程 `rdbSaveRio` 在后台执行。`redisFork` 复制页表的耗时是大实例的瓶颈。

## 下篇桥接

R-20 大 key 删除与 lazyfree 同步释放。
