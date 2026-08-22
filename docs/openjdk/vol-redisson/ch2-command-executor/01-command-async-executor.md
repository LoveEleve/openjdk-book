# 03. CommandAsyncService 怎么把 Java 命令变成 RESP 请求发出去

> **前置依赖**: R-1(ServiceManager 创建 CommandAsyncService)、vol-redis R-26(命令执行全流程)
> → **后续**: R-2 RLock(tryLockInnerAsync 的 evalWriteSyncedNoRetryAsync)
> 关联域: R-5 RMap(commandExecutor 被 Redisson 构造函数传入)

## 困惑：Java 调用 Redisson 的 `getBucket("k").get()`，Redis 那边收到的是什么？

直觉上，`RBucket.get()` 应该是发一个 `GET key` 命令，等 Redis 返回结果，反序列化成 Java 对象。

但问题在于：`GET key` 发给谁？主节点还是从节点？如果主节点正好在故障转移，是重试还是抛异常？如果 client 配置了集群模式，`key` 对应的 slot 在哪个节点？

## 为什么不行：直接 new 一个连接发命令

最简单的方案：`new Socket(host, 6379)` → 发 `GET key\r\n` → 读 `+OK\r\n` → 返回。

但这个方案在 Redisson 的架构面前立刻卡住：

1. 连接池管理：`new Socket` 每次建立 TCP 连接，开销大 → 需要连接池
2. 读写分离：读命令走 slave 分摊压力，写命令必须走 master → 需要区分 read/write
3. 重试：连接断开后自动重试 → 需要重试机制
4. 异步：`get()` 阻塞等待，但 Redisson 还要支持回调 → 需要异步模型

## 总图：命令执行的三层路由

```
API 调用 (getBucket("k").get())
  → readAsync/writeAsync(bool readOnlyMode)
    → async(NodeSource, command, params)
      → 算 slot → 取连接 → 编码 RESP → 发送 → 解码 → 重试
```

## 分层拆解

### 1. readAsync / writeAsync：一个布尔参数决定读写分离

`command/CommandAsyncService.java:243`：

```java
public <T, R> RFuture<R> readAsync(RedisClient client, MasterSlaveEntry entry, ...) {
    return async(true, new NodeSource(entry, client), codec, command, params, false, false);
}
```

`command/CommandAsyncService.java:433`：

```java
public <T, R> RFuture<R> writeAsync(MasterSlaveEntry entry, ...) {
    return async(false, new NodeSource(entry), codec, command, params, false, false);
}
```

第一个参数 `true=read` / `false=write`。`async()` 内部根据这个参数决定 `MasterSlaveEntry` 选 `redisReadClient` 还是 `redisWriteClient`。

### 2. NodeSource：三种路由方式

`NodeSource` 有三种构造形式，决定 `async()` 怎么取连接：

- `new NodeSource(entry, client)`：显式指定 entry 和 client，用于已知连接
- `new NodeSource(slot, client)`：按 key 算 slot（`connectionManager.calcSlot(name)`），cluster 模式下按 slot 路由到对应节点
- `new NodeSource(entry)`：仅指定 entry，从 entry 取 master 或 slave 连接

### 3. async() 核心流程

1. `RedisCommandsUtils.getCommandSlot(command, params)` —— 算 key 的 slot
2. 从 `NodeSource` 对应 `MasterSlaveEntry` 拿 `redisReadClient`（read=true）或 `redisWriteClient`（false）
3. 用 `codec` 编码参数成 RESP 字节
4. 通过 Netty 连接 async() 发出去，返回 `CompletableFuture`
5. `CompletableFutureWrapper` 包装成 `RFuture<T>`

### 4. RFuture：get() 同步阻塞 vs whenComplete 异步回调

`CommandAsyncService.java:181`：

```java
public <V> V get(RFuture<V> future) {
    try { return future.toCompletableFuture().get(); }
    catch (InterruptedException | ExecutionException e) { ... }
}
```

`RFuture<V>` 本质是 `CompletableFuture<V>` 的包装。`get()` 阻塞等待，`whenComplete((res, e) -> ...)` 异步回调。

### 5. executeAllAsync：广播到所有 slave

`command/CommandAsyncService.java:353`：

```java
public <R> List<CompletableFuture<R>> executeAllAsync(MasterSlaveEntry entry, ...) {
```

遍历 entry 的 slave 集合，每个发一条命令，返回结果列表。用于"所有从库预热缓存"或"全量一致性"场景。

### 6. readRandomAsync：shuffle 后重试

`command/CommandAsyncService.java:263`：

```java
public <T, R> RFuture<R> readRandomAsync(...) {
    List<RedisClient> nodes = connectionManager.getEntrySet().stream()
        .map(e -> e.getClient()).collect(Collectors.toList());
    Collections.shuffle(nodes);
    retryReadRandomAsync(codec, command, mainPromise, nodes, params);
}
```

shuffle 打乱节点顺序，`retryReadRandomAsync` 依次尝试。用于 `RANDOMKEY` 等不关心落在哪个节点的命令。

## 收网

`CommandAsyncService` 是 Redisson 所有命令的最终出口。`readAsync(true)/writeAsync(false)` 决定读写分离，`NodeSource` 三种路由决定派发节点，`async()` 编码→发送→解码→重试。`RFuture` = `CompletableFuture` 包装，同步 `get()` 或异步 `whenComplete()`。

## 下篇

R-2 RLock 分布式锁。
ENDOFFILE