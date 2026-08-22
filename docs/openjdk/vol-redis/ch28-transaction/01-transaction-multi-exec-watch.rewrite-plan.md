# 篇：01 事务：MULTI/EXEC/WATCH

- 域：`R-16 事务（MULTI/EXEC/WATCH）`
- 卷：`vol-redis`
- 目标：回答 MULTI/EXEC 怎么入队执行，WATCH 乐观锁怎么工作。

## 前置依赖

- HARD：已读 `R-26 命令执行全流程`（processCommand 中 CLIENT_MULTI 入队）。

## 读者问题

1. MULTI 之后的命令怎么入队？
2. EXEC 怎么顺序执行？
3. WATCH 乐观锁怎么检查 key 是否被修改？

## 主结论

`MULTI`（`multi.c:91`）设置 `CLIENT_MULTI` 标志。`processCommand` 中，`CLIENT_MULTI` 且非 EXEC/DISCARD 的命令进入 `c->mstate.commands` 队列不执行。`EXEC`（`multi.c:127`）检查 WATCH 后顺序执行队列。`WATCH`（`multi.c:452`）把 key 加入 `db->watched_keys`，EXEC 前检查是否被修改。

## 必须回填的源码锚点

- `src/multi.c:91` `multiCommand()`
- `src/multi.c:127` `execCommand()`
- `src/multi.c:279` `watchForKey()`
- `src/multi.c:452` `watchCommand()`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
