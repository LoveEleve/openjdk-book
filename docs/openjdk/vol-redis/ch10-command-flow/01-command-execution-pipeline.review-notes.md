# vol-redis R-26 命令执行全流程 — review notes

## 事实审

- 已核对 `src/networking.c:2559`（`processInputBuffer()` 解析阶段），正文成立。
- 已核对 `src/networking.c:2501`（`processCommandAndResetClient()`），正文成立。
- 已核对 `src/server.c:3884`（`processCommand()` 检查阶段），正文成立。
- 已核对 `src/server.c:3200`（`lookupCommand()` 命令表查询），正文成立。
- 已核对 `src/server.c:3524`（`call()` 执行阶段），正文成立。
- 已核对 `src/server.c:1637`（`beforeSleep()` 传播阶段），正文成立。
- 已核对 `src/aof.c:1117`（`aofWrite()` AOF 落盘），正文成立。
- 已核对 `src/networking.c:4357`（`handleClientsWithPendingReadsUsingThreads()`）、`:4393`（`handleClientsWithPendingWritesUsingThreads()`），正文成立。

## 因果审

- 六步流水线（读→解析→检查→执行→响应→传播）是命令处理的主骨架，正文成立。
- `processCommand` 的每类检查都有具体源码入口，正文成立。
- `call` 中慢命令阻塞主线程是主要阻塞点，正文成立。
- `beforeSleep` 是 AOF 落盘和复制传播的统一出口，正文成立。

## 结构审

- 从"一次 SET 穿过几道门"困惑开场，再落到六步流水线每步的职责，主线集中。

## 读者审

- 读完应能回答：命令执行六步流水线是哪六步。
- 读完应能回答：processCommand 做了哪些检查。
- 读完应能回答：call 中慢命令为什么阻塞主线程。
- 读完后能自然进入 R-27 Lua 脚本。

## 边界审

- 本篇没有展开 querybuf 的详细结构（R-25 覆盖）。
- R-27 Lua 脚本未提前透支，边界成立。

## 依赖审

- 前置依赖：R-2 事件驱动（HARD）、R-25 缓冲区体系（HARD）。
- 后续桥接：R-27 Lua 脚本原子性。

## 结论

R-26 已完成四件套的事实回填与六层审查，可进入 R-27 Lua 脚本原子性。
