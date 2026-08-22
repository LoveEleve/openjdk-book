# MULTI/EXEC/WATCH：Redis 的乐观锁事务

> 本文基于 Redis 7.4.2 当前源码。回答 Redis 事务的入队执行与 WATCH 乐观锁。

## 一、MULTI：命令入队

`multiCommand()`（`multi.c:91`）把客户端标记为 `CLIENT_MULTI`。此后 `processCommand` 中，非 EXEC/DISCARD/WATCH 的命令调用 `queueMultiCommand` 加入 `c->mstate.commands` 队列，**不执行**，只返回 `+QUEUED`。

## 二、EXEC：顺序执行

`execCommand()`（`multi.c:127`）检查 WATCH 后，从 `c->mstate.commands` 取队列，顺序执行。任一命令失败不中断后续命令（无回滚）。

## 三、WATCH：乐观锁

`watchForKey()`（`multi.c:279`）把 key 加入 `db->watched_keys`（key → client 列表）。`processCommand` 中命令执行后调 `touchWatchedKey`，把被修改的 key 记入 `c->dirty_cas`。EXEC 时如果 `dirty_cas != 0`，事务返回 `nil`，不执行。

## 四、失败路径

- EXEC 中途命令失败：不回滚，已执行命令保留
- WATCH 的 key 被其他客户端修改：EXEC 返回 `*0`（nil），不执行
- 无隔离性：EXEC 中的命令看到中间状态

## 收网

`MULTI` 入队 → `EXEC` 顺序执行（无回滚）→ `WATCH` 乐观锁防止并发修改。排障重难点：无回滚 + 无隔离性，符合"易混淆"主题。

## 下篇桥接

R-17 客户端缓存 tracking。
