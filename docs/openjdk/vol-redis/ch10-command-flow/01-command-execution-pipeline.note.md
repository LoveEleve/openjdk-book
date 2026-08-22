# vol-redis R-26 命令执行全流程 — note

## 本篇主张

- 一次命令执行不是"收到就执行"，而是 **读 → 解析 → 检查 → 执行 → 响应 → 传播** 六步流水线。
- `readQueryFromClient` 读入 `querybuf`，`processInputBuffer` 解析成 `argv`，`processCommand` 做 ACL/maxmemory/过期/WATCH/集群检查，`call` 执行 + 统计 + 慢日志，`addReply` 写缓冲，`beforeSleep` 落盘 AOF + 复制传播 + IO 写。
- 检查阶段每一步失败都不执行命令，直接返回错误。

## 本篇边界

- 不展开 querybuf 输出缓冲的详细结构（R-25 覆盖）。
- 不展开 EVAL 脚本在 call 中的特殊路径（R-27 覆盖）。

## 下篇桥接

- R-27 Lua 脚本原子性将展开 EVAL/EVALSHA 与脚本执行的特殊路径。
