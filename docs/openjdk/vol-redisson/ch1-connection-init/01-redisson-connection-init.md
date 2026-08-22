# 01. Redisson.create(config) 怎么从 Config 变成可用的分布式客户端

> **前置依赖**: vol-redis R-25(缓冲区、RESP)、R-26(命令执行全流程)——知道 Redisson 底层走的是 RESP 协议。
> → **后续**: R-4 CommandAsyncService(命令执行流水线)
> 关联域: R-2 RLock(LockRenewalScheduler 在 ServiceManager 中注册)、R-3 Codec(Config 的序列化设置)

## 困惑：Redisson.create(config) 不就是 new 一个客户端吗？

`RedissonClient client = Redisson.create(config);` 然后 `client.getBucket("k").get()` 就能拿到数据。看起来就是"new 一个客户端，然后拿数据"。

但问题在于，如果它只是"new 一个客户端"，那以下问题就解释不了：

- `Config` 里为什么同时躺着 5 套模式配置，不能只放一套？
- 为什么 `Redisson.create(config)` 只用了一行 `new Redisson(config)`，但真正的初始化却发生在别处？
- 为什么调用 `getBucket` 时，第一次命令有可感知的延迟，后续没有？

## 为什么不行：把 Config 当成"一个配置"

直觉是把 Config 当成普通配置 Bean：

```java
Config config = new Config();
config.setAddress("redis://127.0.0.1:6379");
RedissonClient client = Redisson.create(config);
```

但这个方案在 `config/Config.java:47` 的结构面前立刻卡住：

```java
public class Config {
    private SentinelServersConfig sentinelServersConfig;  // 哨兵模式
    private MasterSlaveServersConfig masterSlaveServersConfig;  // 主从模式
    private SingleServerConfig singleServerConfig;  // 单节点模式
    private ClusterServersConfig clusterServersConfig;  // 集群模式
    private ReplicatedServersConfig replicatedServersConfig;  // 云复制模式
}
```

5 套模式配置同时存在，且**只允许其中一套非空**。如果只当成"一个配置对象"，就解释不了：

- `config.useSingleServer()` 和 `config.useClusterServers()` 为什么不能同时调用
- `Redisson.create(config)` 内部怎么判断到底用哪套
- 不同模式为什么要生成不同的 `ConnectionManager` 实现

## 总图：四层装配链

```
Config(5 套模式)
  → ConnectionManager.create() instanceof 工厂
    → ServiceManager 中央工厂(EventLoopGroup + 6 子系统)
      → CommandAsyncExecutor(读写分离命令执行)
```

## 分层拆解

### 1. Redisson 构造函数：四件事

`Redisson.java:77-86`：

```java
connectionManager = ConnectionManager.create(configCopy);
commandExecutor = connectionManager.createCommandExecutor(objectBuilder, ...);
evictionScheduler = new EvictionScheduler(commandExecutor);
writeBehindService = new WriteBehindService(commandExecutor);
connectionManager.getServiceManager().register(new LockRenewalScheduler(commandExecutor));
```

注意：`ConnectionManager.create()` 里 `!configCopy.isLazyInitialization()` 默认 `false`（SingleServerConfig 下 `isLazyInitialization` 默认 `true`），所以**构造函数里不建立连接**。真正连接发生在第一次执行命令时。

### 2. ConnectionManager.create()：instanceof 工厂

`connection/ConnectionManager.java:89`：

```java
static ConnectionManager create(Config configCopy) {
    BaseConfig<?> cfg = ConfigSupport.getConfig(configCopy);
    ConnectionManager cm = null;
    if (cfg instanceof MasterSlaveServersConfig)     cm = new MasterSlaveConnectionManager(...);
    else if (cfg instanceof SingleServerConfig)      cm = new SingleConnectionManager(...);
    else if (cfg instanceof SentinelServersConfig)   cm = new SentinelConnectionManager(...);
    else if (cfg instanceof ClusterServersConfig)    cm = new ClusterConnectionManager(...);
    else if (cfg instanceof ReplicatedServersConfig) cm = new ReplicatedConnectionManager(...);
    if (cm == null) throw new IllegalArgumentException("server(s) address(es) not defined!");
    if (!configCopy.isLazyInitialization()) cm.connect();
    return cm;
}
```

`ConfigSupport.getConfig(configCopy)` 从 5 套配置中取出唯一生效的那一套。如果 5 套全空，抛 `IllegalArgumentException`。`cm.connect()` 只在非惰性初始化模式下执行。

### 3. ServiceManager：EPOLL/KQUEUE/NIO/IO_URING 四路传输

`connection/ServiceManager.java:158` 构造函数：

```java
if (cfg.getTransportMode() == TransportMode.EPOLL)
    group = new EpollEventLoopGroup(cfg.getNettyThreads(), ...);
else if (cfg.getTransportMode() == TransportMode.KQUEUE)
    group = new KQueueEventLoopGroup(cfg.getNettyThreads(), ...);
else if (cfg.getTransportMode() == TransportMode.IO_URING)
    group = createIOUringGroup(cfg);  // Quarkus 专用
else
    group = new NioEventLoopGroup(cfg.getNettyThreads(), ...);
```

UDS 检查（`ServiceManager.java:162-169`）：只有 `EPOLL` / `KQUEUE` 支持 UDS，否则抛异常。

`ServiceManager.java:122-156` 的字段包括 `ConnectionEventsHub`、`ElementsSubscribeService`、`CommandAsyncService`、`LockRenewalScheduler`、`HashedWheelTimer`、`IdleConnectionWatcher`。其中 `ElementsSubscribeService` 管理 PubSub 订阅，`LockRenewalScheduler` 是 RLock 续期的基础。

### 4. CommandAsyncService 读写分离

`command/CommandAsyncService.java:243`：

```java
public <T, R> RFuture<R> readAsync(RedisClient client, MasterSlaveEntry entry, ...) {
    return async(true, new NodeSource(entry, client), codec, command, params, false, false);
}
```

`writeAsync`（`:433`）唯一区别是 `async(false, ...)`。`true` = 读走 slave，`false` = 写走 master。

## 收网

`Redisson.create(config)` 四层装配链：`Config` 模式选择 → `ConnectionManager.create()` instanceof 工厂 → `ServiceManager` 四路 EventLoopGroup 初始化 → `CommandAsyncExecutor` 读写分离。**惰性连接**：`SingleServerConfig` 下 `isLazyInitialization` 默认 `true`，首次连接在第一次执行命令时触发，不在构造函数中。

## 下篇

R-4 命令执行流水线：`async()` 方法的 `NodeSource` 三种路由、`RFuture` 的 `CompletableFuture` 包装。
ENDOFFILE