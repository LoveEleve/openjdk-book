# vol-redis R-27 Lua 脚本原子性 — review notes

## 事实审

- 已核对 `src/eval.c:545`（`evalGenericCommand()` EVAL 统一入口），正文成立。
- 已核对 `src/script.c:170`（`scriptPrepareForRun()` 单线程检查 `serverAssert(!curr_run_ctx)`），正文成立。
- 已核对 `src/script.c:329`（`scriptKill()` `SCRIPT_WRITE_DIRTY` 拒绝逻辑），正文成立。
- 已核对 `src/script.c:292`（`scriptResetRun()` 清理），正文成立。
- 已核对 `src/config.c:3201`（`lua-time-limit` `busy-reply-threshold` 默认 5000ms），正文成立。
- 已核对 `src/cluster.c:956`（`getNodeByQuery()` 集群 key 检查），正文成立。
- 已核对 `src/cluster.c:1181`（`clusterRedirectClient()` CROSSSLOT/TRYAGAIN/MOVED），正文成立。
- 已核对 `src/script.c:179`-`183`（`SCRIPT_FLAG_NO_CLUSTER` 检查），正文成立。
- 已核对 `src/eval.c:609`（`luaCallFunction()` 脚本执行），正文成立。

## 因果审

- 单线程 `serverAssert(!curr_run_ctx)` 保证不打断，正文成立。
- `SCRIPT_WRITE_DIRTY` 阻止 SCRIPT KILL，因为无 undo log，正文成立。
- `lua-time-limit` 超时不自动终止，只允许外部请求终止，正文成立。
- 集群 CROSSSLOT 限制因 `getNodeByQuery` 检查所有 key 的 slot，正文成立。
- `replicate_commands()` 解决随机命令复制一致性，正文成立。

## 结构审

- 从"原子性到底指什么"困惑开场，再落到单线程保证、SCRIPT KILL 边界、超时机制、集群限制、EVAL/EVALSHA/FCALL、复制模式，主线集中。

## 读者审

- 读完应能回答：Lua 的"原子性"到底是什么。
- 读完应能回答：为什么 SCRIPT KILL 有时不能终止脚本。
- 读完应能回答：集群模式下脚本为什么不能跨 slot。
- 读完后能自然进入 R-28 内存淘汰。

## 边界审

- 本篇没有展开 Functions（FCALL）的完整实现。
- R-28 内存淘汰未提前透支，边界成立。

## 依赖审

- 前置依赖：R-26 命令执行全流程（HARD）、R-15 Cluster（SOFT）。
- 后续桥接：R-28 内存淘汰策略。

## 结论

R-27 已完成四件套的事实回填与六层审查，可进入 R-28 内存淘汰策略。
