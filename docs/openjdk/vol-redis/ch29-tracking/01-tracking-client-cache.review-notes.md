# vol-redis R-17 tracking — review notes

## 事实审
- `tracking.c:164` enableTracking ✅ `:201` trackingRememberKeys ✅ `:353` trackingInvalidateKey ✅ `:319` trackingRememberKeyToBroadcast ✅ `:456` trackingInvalidateKeysOnFlush ✅

## 因果审
- tracking 记录 key → 修改时推送失效 ✅

## 结构审
- 开启/记录/失效 主线集中 ✅

## 读者审
- 读完能回答：tracking 怎么减少客户端缓存轮询 ✅

## 依赖审
- 前置 R-2，后续 R-18 ✅

## 结论
R-17 通过六层审查。
