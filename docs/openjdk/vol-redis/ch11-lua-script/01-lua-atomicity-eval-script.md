# Lua 的"原子性"到底指什么

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十一篇，回答 Lua 脚本的原子性边界、SCRIPT KILL 的限制和集群模式下的额外约束。

## 为什么"Lua 脚本是原子的"这个理解会把原子性读浅

很多人面试时回答"Lua 脚本是原子的"，然后就被追问"那为什么 SCRIPT KILL 有时不能终止脚本？"

"Lua 脚本是原子的"这句话对了一半——Redis 单线程模型保证脚本执行期间没有其他命令交错，这叫"不被打断的连续执行"。但这不是 ACID 里"失败就回滚所有修改"那种原子——如果脚本已经写了数据，**Redis 无法撤销那些修改**。

## 一、单线程保证：`scriptPrepareForRun`

`scriptPrepareForRun()`（`src/script.c:170`）第一行就 `serverAssert(!curr_run_ctx)`——同一时刻只有一个脚本在运行。

`curr_run_ctx` 是全局变量，脚本执行期间非空，其他命令（包括其他 EVAL）在 `processCommand` 中等待，直到脚本结束。

## 二、SCRIPT KILL 与 SCRIPT_WRITE_DIRTY 边界

`scriptKill()`（`src/script.c:329`）有明确的拒绝条件：

```c
if (curr_run_ctx->flags & SCRIPT_WRITE_DIRTY) {
    addReplyError(c, "-UNKILLABLE Sorry the script already executed write commands
            against the dataset. You can either wait the script termination
            or kill the server in a hard way using the SHUTDOWN NOSAVE command.");
    return;
}
```

**脚本一旦写过数据就无法 SCRIPT KILL**，只能等它执行完，或者 `SHUTDOWN NOSAVE` 暴力停机。因为 Redis 没有 undo log，写过的数据无法撤销。

如果脚本超时但还没写过数据，`SCRIPT KILL` 可以终止。如果脚本写过了，`SCRIPT KILL` 返回 `UNKILLABLE`。

## 三、`lua-time-limit` 超时机制

`lua-time-limit`（`src/config.c:3201`，`busy-reply-threshold`，默认 5000ms）超时后 Redis 不会自动终止脚本，而是记录日志 + 开始响应 `SCRIPT KILL`/`FUNCTION KILL` 请求。

超时但没写过的脚本可用 `SCRIPT KILL` 终止；超时且写过的无法终止，只能 `SHUTDOWN NOSAVE`。

## 四、集群模式：CROSSSLOT / TRYAGAIN / SCRIPT_FLAG_NO_CLUSTER

集群模式下，脚本的 key 受 `getNodeByQuery()`（`src/cluster.c:956`）检查：

1. **CROSSSLOT**（`cluster.c:1181`）：脚本内所有 KEYS 必须落在同一个 hash slot，否则报 `-CROSSSLOT Keys in request don't hash to the same slot`
2. **TRYAGAIN**：slot 迁移期间（MIGRATING/IMPORTING），脚本访问跨多个 key 返回 `-TRYAGAIN`
3. **MOVED/ASK**：脚本访问的 slot 不在本节点，正常重定向

`SCRIPT_FLAG_NO_CLUSTER`（`script.c:179`-`183`）标记的脚本在集群模式下直接拒绝："Can not run script on cluster, 'no-cluster' flag is set."

## 五、EVAL vs EVALSHA vs FCALL

`evalGenericCommand(c, evalsha)`（`src/eval.c:545`）的第二个参数 `evalsha` 区分 EVAL 和 EVALSHA：

- **EVAL**（`evalsha=0`）：发送脚本正文，`luaCreateFunction` 注册到 `lctx.lua_scripts` 字典
- **EVALSHA**（`evalsha=1`）：发送 SHA1 摘要，在 `lctx.lua_scripts` 中查找，找不到返回 `NOSCRIPT` 错误，客户端退化为 EVAL 重试
- **FCALL**：Redis 7.0 Functions 的调用方式，与 EVAL 类似但通过 `functions.c` 管理

脚本缓存是 LRU 的（`lctx.lua_scripts_lru_list`），`SCRIPT FLUSH` 清除全部缓存。

## 六、`redis.replicate_commands()` 复制模式

默认模式下，整个 Lua 脚本作为一个整体复制到从节点/AOF。如果脚本中包含随机命令（`TIME`、`SRANDMEMBER`、`SPOP`），主从之间可能不一致。

`redis.replicate_commands()` 切换到**逐命令复制模式**，让 Redis 只复制脚本产生的写命令，而不是脚本本身，从而避免随机性问题。

## 七、失败路径

### 1. 脚本超时写过的数据无法回滚

`SCRIPT_KILL` 拒绝 `SCRIPT_WRITE_DIRTY` 的脚本，只能 `SHUTDOWN NOSAVE`。

### 2. 未使用 `replicate_commands()` 时随机命令不一致

默认脚本级复制模式下，`TIME` 等随机命令在主从执行时返回不同值，导致主从不一致。

### 3. EVALSHA 脚本被 LRU 淘汰

`SCRIPT FLUSH` 或 LRU 淘汰后，`EVALSHA` 返回 `NOSCRIPT` 错误，客户端退化为 `EVAL`。

### 4. 集群 CROSSSLOT

脚本访问两个不同 slot 的 key，`-CROSSSLOT` 拒绝，必须用 `{hash_tag}` 强制同 slot。

## 到这里，R-27 真正立住的是"Lua 原子性 vs ACID 原子性"

如果只看表面，"Lua 脚本是原子的"被读成"Lua 脚本像数据库事务一样可靠"。

更稳的理解方式应该是：

1. 单线程保证不打断（`scriptPrepareForRun` 的 `serverAssert(!curr_run_ctx)`）
2. 但无法回滚（`SCRIPT_WRITE_DIRTY` 阻止 `SCRIPT KILL`）
3. `lua-time-limit` 超时不自动终止，只允许外部请求终止
4. 集群模式下 KEYS 必须在同一 slot，否则 CROSSSLOT
5. `redis.replicate_commands()` 解决随机命令的复制问题

## 下篇桥接

R-28 内存淘汰策略将展开 8 种淘汰策略、近似 LRU、LFU 对数计数与衰减。
