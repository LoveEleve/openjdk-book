# RESP3 客户端缓存失效推送

> 本文基于 Redis 7.4.2 当前源码。回答客户端缓存 tracking 机制。

## 一、enableTracking

`enableTracking()`（`tracking.c:164`）开启客户端的 tracking 模式。客户端读取 key 后，`trackingRememberKeys()`（`:201`）记录该客户端读取的全部 key。

## 二、trackingInvalidateKey

`trackingInvalidateKey()`（`tracking.c:353`）在 key 被修改时遍历所有 tracking 该 key 的客户端，推送 `invalidate` 消息。客户端收到后失效本地缓存。

## 三、BCAST 模式

`CLIENT TRACKING on BCAST PREFIX foo:*` 按前缀广播。`trackingRememberKeyToBroadcast()`（`:319`）记录前缀与 key 的映射。`INVALIDATE` 消息在 `beforeSleep` 中批量发送（`trackingCachePendingInvalidation`）。

## 四、收网

`tracking` 是 RESP3 的新特性，让服务端在 key 被修改时推送失效消息，客户端无需 TTL 轮询。

## 下篇桥接

R-18 内存碎片整理 defrag。
