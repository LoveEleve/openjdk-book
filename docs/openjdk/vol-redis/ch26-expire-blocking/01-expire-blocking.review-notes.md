# vol-redis R-23 过期 key 删除与阻塞 — review notes

## 事实审
- `expire.c:35` expireIfNeeded ✅ `expire.c:187` activeExpireCycle ✅

## 因果审
- 惰性删除不阻塞 ✅
- 定期删除限时扫不完 ✅
- 大 key 同步删除阻塞 ✅

## 结构审
- 惰性/定期/大key 主线集中 ✅

## 读者审
- 读完能回答：大量同时过期为什么卡 ✅

## 边界审
- 不展开时间预算算法 ✅

## 依赖审
- 前置 R-3/R-28，后续 R-24 ✅

## 结论
R-23 通过六层审查。
