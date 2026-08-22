# 篇：01 客户端缓存 tracking

- 域：`R-17 客户端缓存 tracking`
- 卷：`vol-redis`
- 目标：回答 RESP3 的客户端缓存失效推送机制。

## 前置依赖

- HARD：已读 `R-2 事件驱动`（知道 beforeSleep）。

## 读者问题

1. `CLIENT TRACKING on` 怎么工作？
2. 服务端怎么知道 key 被哪些客户端缓存了？
3. BCAST 模式怎么按前缀广播？

## 主结论

`enableTracking`（`tracking.c:164`）开启客户端 tracking。`trackingRememberKeys`（`:201`）在命令执行后记录客户端读取的 key。`trackingInvalidateKey`（`:353`）在 key 被修改时推送 `invalidate` 消息给缓存了该 key 的客户端。

## 必须回填的源码锚点

- `src/tracking.c:164` `enableTracking()`
- `src/tracking.c:201` `trackingRememberKeys()`
- `src/tracking.c:353` `trackingInvalidateKey()`
- `src/tracking.c:456` `trackingInvalidateKeysOnFlush()`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
