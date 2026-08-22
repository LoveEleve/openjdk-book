# vol-redisson R-4 命令执行流水线 — note

## 本篇主张

- `CommandAsyncService` 是 Redisson 所有读写操作的最终出口，通过 Netty 连接池发送 RESP 命令。
- `readAsync`（`:243`）路由到 slave，`writeAsync` 路由到 master，`executeAllAsync`（`:353`）在全部 slave 上执行。
- `RFuture` 包装 Netty `Promise`，异步回调或同步阻塞。
- `evalWriteAsync` / `evalReadAsync` 执行 Lua 脚本，`retryAttempts`（默认 3）控制重试。

## 下篇桥接

- R-2 RLock 分布式锁 + Watchdog 批量续期。
ENDOFFILE