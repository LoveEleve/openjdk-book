# vol-redis R-30 阻塞命令 — note

## 本篇主张

- BLPOP 不是轮询，而是 **事件驱动的注册/唤醒链**：`blockForKeys` 注册 → `signalKeyAsReady` 标记就绪 → `handleClientsBlockedOnKeys` 在 `beforeSleep` 中处理。
- `blockForKeys` 把客户端挂到 `db->blocking_keys`，标记 `CLIENT_BLOCKED`，不占 CPU。
- `signalKeyAsReady` 在数据到达时把 key 加入 `db->ready_keys`，不直接唤醒客户端。
- `handleClientsBlockedOnKeys` 在 `beforeSleep` 中从 `ready_keys` 取 key，执行 pop 并解除阻塞。
- 超时由 `clientsCron` 检查 `c->bstate.timeout`，超时返回 nil。

## 本篇边界

- 不展开所有阻塞命令（BLMOVE、XREAD BLOCK 等）的完整实现。
- 不展开 `processUnblockedClients` 的恢复路径细节。

## 下篇桥接

- R-31 发布订阅将展开 PUB/SUB 的频道组广播、消息丢失原因、与 Stream/List 的对比。
