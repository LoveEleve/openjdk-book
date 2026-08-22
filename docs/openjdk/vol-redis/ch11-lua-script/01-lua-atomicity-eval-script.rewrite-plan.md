# 篇：01 Lua 脚本原子性：EVAL/EVALSHA、SCRIPT KILL 与集群限制

- 域：`R-27 Lua 脚本原子性`
- 卷：`vol-redis`
- 目标：回答 Lua 脚本在 Redis 里为什么是"原子"的，这个"原子"到底指什么，以及集群模式下的额外限制。

## 前置依赖

- HARD：已读 `R-26 命令执行全流程`（知道 call 执行命令）、`R-15 Cluster`（知道 slot 和重定向）。

## 读者问题

1. Lua 脚本在 Redis 里为什么是"原子"的？
2. 这个"原子"不等同于 ACID 的原子——为什么 SCRIPT KILL 有时不能终止脚本？
3. `lua-time-limit` 超时后脚本会怎样？
4. 集群模式下脚本为什么不能跨 slot 访问 key？
5. `redis.replicate_commands()` 解决什么问题？

## 主结论

Lua 脚本的"原子性"是指单线程保证的**不被打断的连续执行**，不是 ACID 的"回滚所有修改"。`script.c:329` `scriptKill()` 明确拒绝已经写过数据的脚本——`SCRIPT_WRITE_DIRTY` 标记一旦设置，只能等脚本执行完或 `SHUTDOWN NOSAVE`。

集群模式下，所有 key 必须在同一个 slot，否则报 `CROSSSLOT` 错误。

## 结构设计

1. 困惑开场：Lua 的原子性到底指什么
2. `evalGenericCommand` EVAL 入口
3. `scriptPrepareForRun` 单线程保证
4. `SCRIPT KILL` 与 `SCRIPT_WRITE_DIRTY` 边界
5. `lua-time-limit` 超时机制
6. 集群模式：CROSSSLOT / TRYAGAIN / SCRIPT_FLAG_NO_CLUSTER
7. EVAL vs EVALSHA vs FCALL
8. `redis.replicate_commands()` 复制模式
9. 失败路径
10. 收网与下篇桥接 R-28 内存淘汰

## 必须回填的源码锚点

- `src/eval.c:545` `evalGenericCommand()`（EVAL 入口）
- `src/script.c:170` `scriptPrepareForRun()`（单线程检查）
- `src/script.c:329` `scriptKill()`（终止逻辑）
- `src/script.c:292` `scriptResetRun()`（清理）
- `src/config.c:3201` `lua-time-limit`（默认 5000ms）
- `src/cluster.c:956` `getNodeByQuery()`（集群 key 检查）
- `src/cluster.c:1181` `clusterRedirectClient()`（CROSSSLOT/TRYAGAIN/MOVED）
- `src/script.c:179` `SCRIPT_FLAG_NO_CLUSTER` 检查
- `src/eval.c:609` `luaCallFunction()`（脚本执行）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
