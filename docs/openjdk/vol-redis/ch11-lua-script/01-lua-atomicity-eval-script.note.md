# vol-redis R-27 Lua 脚本原子性 — note

## 本篇主张

- Lua 脚本的"原子性"是指单线程保证的**不被打断的连续执行**（`scriptPrepareForRun` 的 `serverAssert(!curr_run_ctx)`）。
- 不是 ACID 的"回滚所有修改"——`SCRIPT_WRITE_DIRTY` 标记一旦设置，只能等脚本执行完或 `SHUTDOWN NOSAVE`。
- `lua-time-limit`（默认 5000ms）超时不自动终止脚本，只允许外部请求终止。
- 集群模式下 KEYS 必须在同一 slot，否则 CROSSSLOT；`SCRIPT_FLAG_NO_CLUSTER` 标记的脚本在集群模式下直接拒绝。
- `redis.replicate_commands()` 切换到逐命令复制模式，解决随机命令不一致问题。

## 本篇边界

- 不展开 Functions（FCALL）的完整实现。
- 不展开 Lua 脚本的调试器细节。

## 下篇桥接

- R-28 内存淘汰策略将展开 8 种淘汰策略、近似 LRU、LFU 对数计数与衰减。
