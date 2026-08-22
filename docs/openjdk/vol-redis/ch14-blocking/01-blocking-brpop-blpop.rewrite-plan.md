# 篇：01 阻塞命令：BLPOP/BRPOP 的 wait 与 wakeup 机制

- 域：`R-30 阻塞命令`
- 卷：`vol-redis`
- 目标：回答 BLPOP 发出后客户端怎么挂起、另一个客户端 LPUSH 时怎么唤醒、超时后怎么恢复。

## 前置依赖

- HARD：已读 `R-2 事件驱动`（知道 `beforeSleep` 中 `handleClientsBlockedOnKeys`）、`R-5 List`（BLPOP 的操作对象）。

## 读者问题

1. `BLPOP key timeout` 发出后，客户端怎么"挂起"的？
2. 另一个客户端 LPUSH 时，挂起的客户端怎么被"唤醒"的？
3. 超时后怎么恢复，返回 nil？
4. `blocking_keys` 和 `ready_keys` 各管什么？

## 主结论

BLPOP 的阻塞不是"轮询等待"，而是 **`blockForKeys` 注册 → `signalKeyAsReady` 唤醒 → `handleClientsBlockedOnKeys` 在 `beforeSleep` 中处理** 的三步唤醒链。

## 结构设计

1. 困惑开场：BLPOP 怎么做到"有数据就返回，没数据就等"
2. `blockForKeys`：注册阻塞客户端到 `db->blocking_keys`
3. `signalKeyAsReady`：数据到达时唤醒
4. `handleClientsBlockedOnKeys`：`beforeSleep` 中处理唤醒
5. 超时处理：`processUnblockedClients` 中的超时检查
6. 失败路径
7. 收网与下篇桥接

## 必须回填的源码锚点

- `src/blocked.c:359` `blockForKeys()`（注册阻塞客户端）
- `src/blocked.c:447` `signalKeyAsReadyLogic()`（唤醒逻辑核心）
- `src/blocked.c:542` `signalKeyAsReady()`（公开入口）
- `src/blocked.c:306` `handleClientsBlockedOnKeys()`（处理唤醒）
- `src/blocked.c:105` `processUnblockedClients()`（超时恢复）
- `src/server.h:968` `redisDb.blocking_keys` / `ready_keys`
- `src/server.c:1637` `beforeSleep` 中调用 `handleClientsBlockedOnKeys`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
