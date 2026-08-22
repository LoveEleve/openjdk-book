# 篇：01 过期 key 删除与阻塞边界

- 域：`R-23 过期 key 删除与阻塞边界`
- 卷：`vol-redis`
- 目标：回答惰性删除 + 定期删除怎么工作，大量 key 同时过期为什么可能阻塞。

## 前置依赖

- HARD：已读 `R-3 Dict`（dictGetRandomKeys）、`R-28 内存淘汰`（与过期删除的混淆）。

## 读者问题

1. 惰性删除（`expireIfNeeded`）和定期删除（`activeExpireCycle`）怎么分工？
2. 大量 key 同时过期为什么可能阻塞？
3. 大 key 过期时怎么阻塞主线程？

## 主结论

惰性删除（`expire.c:35` `expireIfNeeded`）在 key 被访问时检查，**不阻塞**。定期删除（`activeExpireCycle`，`expire.c:187`）在 `serverCron` 中每 100ms 执行，限定时间预算，**大量 key 同时过期时可能扫不完**。大 key 在惰性删除时同步释放元素，**阻塞主线程**。

## 必须回填的源码锚点

- `src/expire.c:35` `expireIfNeeded()`（惰性删除）
- `src/expire.c:187` `activeExpireCycle()`（定期删除）

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
