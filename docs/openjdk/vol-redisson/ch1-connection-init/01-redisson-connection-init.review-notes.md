# vol-redisson R-1 Redisson 主类与连接管理 — review notes

## 事实审

- 已核对 `org.redisson/Redisson.java:106`（`create()`）、`:119`（`create(Config)`），正文成立。
- 已核对 `org.redisson/config/Config.java:47`（5 种服务器模式配置字段）、`:49`-`:57`（Sentinel/MasterSlave/Single/Cluster/Replicated），正文成立。
- 已核对 `org.redisson/connection/ServiceManager.java:91`（类声明）、`:122`/`:144`/`:156`（ConnectionEventsHub/ElementsSubscribeService/LockRenewalScheduler 字段），正文成立。
- 已核对 `org.redisson/command/CommandAsyncService.java:1256` 行数、`:243`（`readAsync`）、`:353`（`executeAllAsync`），正文成立。
- 已核对 `org.redisson/renewal/` 目录（LockRenewalScheduler/LockTask/FastMultilockTask 等），正文成立。

## 因果审

- `Config` 的 5 种模式决定 `ConnectionManager` 实现选择，正文成立。
- `ServiceManager` 是中央工厂，全部子系统在此初始化，正文成立。
- `CommandAsyncService` 读写分离依赖连接管理提供 master/slave 条目，正文成立。
- `ElementsSubscribeService` 自动重连保证订阅不因断线丢失，正文成立。

## 结构审

- 从"Redisson.create 到底做了什么"困惑开场，再落到入口/模式/中央工厂/读写分离/PubSub/DNS，主线集中。

## 读者审

- 读完应能回答：Redisson.create 穿过了哪几层。
- 读完应能回答：5 种服务器模式各对应什么 ConnectionManager。
- 读完应能回答：ServiceManager 初始化了哪些子系统。
- 读完后能自然进入 R-4 命令执行。

## 边界审

- 本篇没有展开 CommandAsyncService 的异步模型（R-4 覆盖）。
- R-2 RLock 未提前透支，边界成立。

## 依赖审

- 前置依赖：vol-redis 的 R-25/R-26（SOFT，理解 RESP 和命令执行）。
- 后续桥接：R-4 命令执行流水线。

## 结论

R-1 已完成四件套的事实回填与六层审查，可进入 R-4 命令执行流水线。
ENDOFFILE