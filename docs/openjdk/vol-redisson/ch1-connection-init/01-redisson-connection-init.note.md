# vol-redisson R-1 Redisson 主类与连接管理 — note

## 本篇主张

- `Redisson.create(config)` 不是"创建一个客户端"，而是 **Config → ConnectionManager → ServiceManager → CommandAsyncExecutor** 四层初始化链路。
- `ServiceManager` 是中央工厂，创建 EventLoopGroup、LockRenewalScheduler、ElementsSubscribeService、ConnectionEventsHub、IdleConnectionWatcher 等全部子系统。
- `Config`（`config/Config.java:47`）含 5 种服务器模式，各自对应不同的 ConnectionManager 实现。
- `CommandAsyncService` 读写分离（readAsync 走 slave / writeAsync 走 master），带重试配置。
- `ElementsSubscribeService` 管理 PubSub 订阅自动重连，`DNSMonitor` 定期解析 DNS 做主从切换。

## 本篇边界

- 不展开 `CommandAsyncService` 的异步执行模型细节（R-4 覆盖）。
- 不展开 RLock 的 Watchdog 续期（R-2 覆盖）。

## 下篇桥接

- R-4 命令执行流水线将展开 `CommandAsyncService` 的异步执行模型和 Lua 脚本执行。
ENDOFFILE