# BLPOP 怎么做到"有数据就返回，没数据就等"

> 本文基于 Redis 7.4.2 当前源码。本文是 `vol-redis` 的第十四篇，回答 BLPOP/BRPOP 的阻塞等待与唤醒机制。

## 为什么"BLPOP 就是轮询"这个理解会把阻塞命令读浅

很多人第一次看 BLPOP，觉得它就是在循环里 `LPOP`，没数据就 sleep 一下再试。

但 Redis 的 BLPOP 不是轮询——它是 **事件驱动的注册/唤醒**：客户端发出 BLPOP 后，如果 key 没有数据，客户端被标记为阻塞，挂到 `db->blocking_keys` 上，然后**完全不占用 CPU**。另一个客户端 `LPUSH` 数据时，通过 `signalKeyAsReady` 把被阻塞的客户端标记为就绪，下一次 `beforeSleep` 时唤醒它处理数据。

## 一、blockForKeys：注册阻塞客户端

`blockForKeys()`（`src/blocked.c:359`）：

```c
void blockForKeys(client *c, int btype, robj **keys, int numkeys,
                  mstime_t timeout, int unblock_on_nokey) {
    c->bstate.timeout = timeout;
    c->flags |= CLIENT_BLOCKED;
    // 把 key 加入 db->blocking_keys（key -> client 列表）
}
```

BLPOP 执行后如果 key 无数据，调用 `blockForKeys` 把客户端标记为 `CLIENT_BLOCKED`，并注册到 `db->blocking_keys`（`redisDb.blocking_keys`，`src/server.h:972`）。客户端进入阻塞状态，不再参与事件循环处理。

## 二、signalKeyAsReady：数据到达时唤醒

另一个客户端 `LPUSH key value` 时，`pushGenericCommand` → `listTypePush` 之后，会调 `signalKeyAsReady(db, key, OBJ_LIST)` 检查是否有客户端在等这个 key。

`signalKeyAsReady()`（`src/blocked.c:542`）内部调 `signalKeyAsReadyLogic()`（`src/blocked.c:447`）：如果 `db->blocking_keys` 中有客户端在等这个 key，把 key 加入 `db->ready_keys`（`src/server.h`），标记为"就绪"。

注意：这里只是**标记 ready**，不是直接唤醒客户端。真正的处理在 `beforeSleep`。

## 三、handleClientsBlockedOnKeys：beforeSleep 中处理唤醒

`beforeSleep()`（`src/server.c:1637`）调用 `handleClientsBlockedOnKeys()`（`src/blocked.c:306`）：

```c
void handleClientsBlockedOnKeys(void) {
    // 遍历 db->ready_keys
    // 对每个就绪 key，找出等它的客户端
    // 执行（如 LPOP），满足条件的 unblock 客户端
}
```

这一步在 `beforeSleep` 中执行，因为此时主线程刚从 sleep 中醒来，还没进入命令处理循环。`handleClientsBlockedOnKeys` 从 `ready_keys` 中取出就绪 key，检查对应客户端，如果数据满足（如 List 有元素），执行 pop 操作并把结果写入客户端输出缓冲，然后解除阻塞。

## 四、超时处理：processUnblockedClients

如果 `BLPOP key 10` 的 10 秒内没有任何数据到达，`blocked.c` 中设置 `c->bstate.timeout`（`blockForKeys`），`clientsCron`（`serverCron` 每 100ms 执行）检查超时客户端，超时的返回 nil 并解除阻塞。

`processUnblockedClients()`（`src/blocked.c:105`）处理被解除阻塞的客户端，恢复命令执行。

## 五、失败路径

### 1. 多个客户端等同一个 key

多个客户端同时 BLPOP 同一个 key，`signalKeyAsReady` 只标记 key 就绪，`handleClientsBlockedOnKeys` 中按 FIFO 顺序处理，只有一个客户端能拿到数据。

### 2. 超时客户端数据被抢

`BLPOP key 10` 在 9 秒时有数据到达，但处理慢；另一个 `LPOP` 先把数据取走。此时 `handleClientsBlockedOnKeys` 发现 key 没数据，客户端继续阻塞或超时。

### 3. 阻塞期间客户端断开

客户端 BLPOP 后断开，`freeClient` 时从 `blocking_keys` 移除，不泄漏。

## 到这里，R-30 真正立住的是"事件驱动的注册/唤醒链"

如果只看表面，BLPOP 被读成"轮询等待"。

更稳的理解方式应该是：

1. `blockForKeys` 注册：客户端挂到 `db->blocking_keys`，标记 CLIENT_BLOCKED
2. `signalKeyAsReady` 标记就绪：数据到达时把 key 加入 `ready_keys`
3. `handleClientsBlockedOnKeys` 处理：`beforeSleep` 中从 `ready_keys` 取 key，执行 pop，解除阻塞
4. 超时：`clientsCron` 检查 timeout，超时返回 nil

## 下篇桥接

R-31 发布订阅将展开 PUB/SUB 的频道组广播、消息丢失原因、与 Stream/List 的对比。
