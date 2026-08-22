# 篇：01 命令执行全流程：从 readQueryFromClient 到 addReply

- 域：`R-26 命令执行全流程`
- 卷：`vol-redis`
- 目标：回答一次 `SET key value` 从网络读到响应返回，中间穿过哪几道门。

## 前置依赖

- HARD：已读 `R-2 事件驱动`（知道 aeMain 循环）、`R-25 缓冲区体系`（知道 querybuf 和 buf/reply）。

## 读者问题

1. `readQueryFromClient` 怎么把数据读进 `querybuf`？
2. `processInputBuffer` 怎么从 `querybuf` 解析出完整命令？
3. `processCommand` 做了哪些前置检查（ACL/过期/淘汰/WATCH/集群）？
4. `call()` 做了什么（慢日志/统计/传播）？
5. `addReply` 怎么写入 `buf` 和 `reply` 链表？
6. `beforeSleep` 中的 AOF 落盘和复制传播是怎么触发的？

## 主结论

一次命令执行不是"收到就执行"这么简单，而是 **读 → 解析 → 检查 → 执行 → 响应 → 传播** 六步流水线。

`readQueryFromClient` → `processInputBuffer` → `processCommand` → `call` → `addReply` → `beforeSleep`（AOF落盘+复制传播+IO写）。

## 结构设计

1. 困惑开场：一次 SET 穿过几道门
2. 读阶段：`readQueryFromClient` → `querybuf`
3. 解析阶段：`processInputBuffer` → `processMultibulkBuffer` / `processInlineBuffer`
4. 检查阶段：`processCommand`（ACL/maxmemory/过期/WATCH/集群）
5. 执行阶段：`call()` → `c->cmd->proc(c)`（慢日志/统计）
6. 响应阶段：`addReply` → `buf` / `reply`
7. 传播阶段：`beforeSleep`（AOF落盘+复制传播+IO写）
8. 失败路径
9. 收网与下篇桥接 R-27 Lua 脚本

## 必须回填的源码锚点

- `src/networking.c` `readQueryFromClient()`（读阶段）
- `src/networking.c:2559` `processInputBuffer()`（解析阶段）
- `src/networking.c:2501` `processCommandAndResetClient()`
- `src/server.c:3884` `processCommand()`（检查阶段）
- `src/server.c:3200` `lookupCommand()`（命令表查询）
- `src/server.c:3524` `call()`（执行+传播）
- `src/networking.c` `addReply()`（响应）
- `src/server.c:1637` `beforeSleep()`（AOF落盘+复制传播+IO写）
- `src/aof.c:1117` `aofWrite()`（AOF落盘）
- `src/networking.c:4357` `handleClientsWithPendingReadsUsingThreads()`
- `src/networking.c:4393` `handleClientsWithPendingWritesUsingThreads()`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
