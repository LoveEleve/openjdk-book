# vol-redis R-16 事务 — note

## 本篇主张

- MULTI（`multi.c:91`）标记 CLIENT_MULTI，命令入队不执行。
- EXEC（`multi.c:127`）顺序执行队列，命令失败不回滚。
- WATCH（`multi.c:452`）→ `watchForKey`（`multi.c:279`）乐观锁，key 被修改后 EXEC 返回 nil。
- 无隔离性（EXEC 中看到中间状态），无回滚（失败命令保留）。

## 下篇桥接

- R-17 客户端缓存 tracking。
