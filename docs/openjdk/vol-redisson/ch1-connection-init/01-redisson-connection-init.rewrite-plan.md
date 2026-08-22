# 篇：01 Redisson 主类与连接管理：Config → ConnectionManager → ServiceManager

- 域：`R-1 Redisson 主类与连接管理`
- 卷：`vol-redisson`
- 目标：回答 Redisson 怎么从 Config 配置初始化到可用的 Redis 客户端。

## 前置依赖

- HARD：已读 `vol-redis` 的 R-25 缓冲区体系 / R-26 命令执行全流程（知道 RESP 协议和 Redis 命令执行）。
- SOFT：了解 Netty 的基本概念。

## 读者问题

1. `Redisson.create(config)` 到可用的 `RedissonClient` 之间穿过了哪些门？
2. `Config` 的 5 种服务器模式（Single/MasterSlave/Sentinel/Cluster/Replicated）各怎么连接？
3. `ServiceManager` 中央工厂初始化了什么？
4. `CommandAsyncService` 怎么实现读写分离？
5. `DNSMonitor` 怎么切换主从？
6. Redisson 的 PubSub 通信（`ElementsSubscribeService`）怎么自动重连？

## 主结论

`Redisson.create(config)` 不是"创建了一个客户端"，而是 **Config → ConnectionManager → ServiceManager → CommandAsyncExecutor** 的四层初始化链路。`ServiceManager` 是中央工厂，创建 EventLoopGroup、Timer、LockRenewalScheduler、ElementsSubscribeService 等全部子系统。

## 结构设计

1. 困惑开场：Redisson.create 到底做了什么
2. Config 的 5 种服务器模式
3. ConnectionManager.create() 选择实现
4. ServiceManager 中央工厂
5. CommandAsyncService 读写分离
6. ElementsSubscribeService PubSub 自动重连
7. DNSMonitor 主从切换
8. 失败路径
9. 收网与下篇桥接 R-4 命令执行

## 必须回填的源码锚点

- `org.redisson.Redisson.java:1532` 行（总入口）
- `org.redisson.config.Config.java:1351` 行（5 种模式）
- `org.redisson.connection.ServiceManager.java:804` 行（中央工厂）
- `org.redisson.command.CommandAsyncService.java:1256` 行（读写分离）
- `org.redisson.connection.DNSMonitor.java`（DNS 切换）
- `org.redisson` `ElementsSubscribeService.java`（PubSub 重连）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
ENDOFFILE