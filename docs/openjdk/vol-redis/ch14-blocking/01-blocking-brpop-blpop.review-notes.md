# vol-redis R-30 阻塞命令 — review notes

## 事实审

- 已核对 `src/blocked.c:359`（`blockForKeys()` 注册阻塞客户端），正文成立。
- 已核对 `src/blocked.c:447`（`signalKeyAsReadyLogic()` 唤醒逻辑核心），正文成立。
- 已核对 `src/blocked.c:542`（`signalKeyAsReady()` 公开入口），正文成立。
- 已核对 `src/blocked.c:306`（`handleClientsBlockedOnKeys()` 处理唤醒），正文成立。
- 已核对 `src/blocked.c:105`（`processUnblockedClients()` 超时恢复），正文成立。
- 已核对 `src/server.h:972`（`redisDb.blocking_keys`），正文成立。
- 已核对 `src/server.c:1637`（`beforeSleep` 中 `handleClientsBlockedOnKeys`），正文成立。

## 因果审

- `blockForKeys` 注册挂起客户端到 blocking_keys，标记 CLIENT_BLOCKED，正文成立。
- `signalKeyAsReady` 数据到达时标记 ready_keys，不直接唤醒，正文成立。
- `handleClientsBlockedOnKeys` 在 beforeSleep 中处理 ready_keys，执行 pop 并解除阻塞，正文成立。
- 超时由 clientsCron 检查 bstate.timeout，正文成立。

## 结构审

- 从"BLPOP 怎么做到有数据就返回没数据就等"困惑开场，再落到注册/唤醒/处理/超时四步，主线集中。

## 读者审

- 读完应能回答：BLPOP 挂起后为什么不占 CPU。
- 读完应能回答：signalKeyAsReady 和 handleClientsBlockedOnKeys 的分工。
- 读完应能回答：超时后客户端怎么恢复。
- 读完后能自然进入 R-31 发布订阅。

## 边界审

- 本篇没有展开 BLMOVE、XREAD BLOCK 等所有阻塞命令的实现。
- R-31 发布订阅未提前透支，边界成立。

## 依赖审

- 前置依赖：R-2 事件驱动（HARD）、R-5 List（HARD）。
- 后续桥接：R-31 发布订阅。

## 结论

R-30 已完成四件套的事实回填与六层审查，可进入 R-31 发布订阅。
