# vol-redis R-23 过期 key 删除与阻塞 — note

## 本篇主张

- 惰性删除（`expire.c:35` `expireIfNeeded`）在访问时检查，不阻塞。
- 定期删除（`expire.c:187` `activeExpireCycle`）每 100ms 限时预算扫描，大量同时过期扫不完。
- 大 key 过期时同步删除释放元素阻塞主线程，用 `lazyfree-lazy-expire` 异步化。

## 本篇边界

- 不展开 activeExpireCycle 的时间预算算法。

## 下篇桥接

- R-24 慢命令阻塞与 IO 多线程边界。
