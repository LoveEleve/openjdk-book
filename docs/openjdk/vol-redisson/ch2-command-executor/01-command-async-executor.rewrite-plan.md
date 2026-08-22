# 篇：01 命令执行流水线：CommandAsyncService 异步执行模型

- 域：`R-4 命令执行流水线`
- 卷：`vol-redisson`
- 目标：回答 CommandAsyncService 怎么通过 Netty 连接池发送 RESP 命令并异步返回结果。

## 前置依赖

- HARD：已读 `R-1 Redisson 主类与连接管理`（知道 ServiceManager 和 CommandAsyncService 的初始化）。

## 读者问题

1. `RFuture<V>` 怎么从 Netty 的异步模型映射到调用方？
2. `readAsync` 和 `writeAsync` 怎么路由到不同节点？
3. Lua 脚本怎么通过 `evalWriteAsync` 执行？
4. 命令重试怎么实现？

## 主结论

`CommandAsyncService` 通过 Netty 的 `ChannelFuture` 把 RESP 命令写入连接池，`RFuture` 包装 Netty 的 `Promise` 异步返回。`readAsync` 路由到 slave，`writeAsync` 路由到 master。

## 必须回填的源码锚点

- `org.redisson/command/CommandAsyncService.java:243` `readAsync` 入口
- `org.redisson/command/CommandAsyncService.java` `writeAsync` 入口
- `org.redisson/command/CommandAsyncService.java` `evalWriteAsync` / `evalReadAsync`
- `org.redisson/command/CommandAsyncExecutor.java` 接口

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
ENDOFFILE