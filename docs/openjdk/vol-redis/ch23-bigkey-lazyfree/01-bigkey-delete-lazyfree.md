# DEL 删大 key 为什么卡，UNLINK 怎么解决

> 本文基于 Redis 7.4.2 当前源码。排障层第二篇，回答大 key 删除的阻塞问题。

## 一、DEL 同步删除

`DEL` 调用 `dbAsyncDelete` 的同步版本 `dbGenericDelete`（`db.c`），对 dict 中每个 entry 调 `dictFreeKey` / `dictFreeVal` 释放内存。大 key（如百万元素的 List/ZSet）遍历释放所有元素，阻塞主线程。

## 二、UNLINK 异步删除

`UNLINK` 调用 `dbAsyncDelete()`（`db.c:417`），只从 dict 中取消引用，把释放任务交给 `bio` 后台线程，主线程立即返回。`lazyfreeFreeObject()`（`lazyfree.c:13`）在后台线程中调 `decrRefCount` 释放。

## 三、lazyfree 配置

`lazyfree-lazy-eviction`（`config.c:3060`）：淘汰时异步释放
`lazyfree-lazy-expire`：过期 key 删除时异步释放
`lazyfree-lazy-server-del`：服务端内部删除时异步释放
`lazyfree-lazy-user-del`：`UNLINK` 默认走异步

## 四、失败路径

- `lazyfree_objects` 累计太多来不及释放，`lazyfreeFreeObject` 在 bio 线程排队
- `FLUSHALL ASYNC` 调 `emptyDbAsync`（`lazyfree.c:201`），清空整个库

## 收网

`DEL` 同步阻塞，`UNLINK` 异步释放。`lazyfree` 系列配置覆盖淘汰/过期/服务端删除/用户删除四种场景。

## 下篇桥接

R-21 复制 backlog 溢出与全量重同步。
