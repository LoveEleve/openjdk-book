# vol-redis R-17 客户端缓存 tracking — note

## 本篇主张

- `enableTracking`（`tracking.c:164`）开启客户端 tracking，`trackingRememberKeys`（`:201`）记录读取的 key。
- `trackingInvalidateKey`（`:353`）key 被修改时推送 `invalidate` 消息。
- BCAST 模式按前缀广播（`trackingRememberKeyToBroadcast`，`:319`）。

## 下篇桥接

- R-18 内存碎片整理 defrag。
