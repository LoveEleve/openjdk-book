# vol-redis R-20 大 key 删除与 lazyfree — note

## 本篇主张

- `DEL`（`dbGenericDelete`）同步遍历释放元素，大 key 阻塞主线程。
- `UNLINK` 调 `dbAsyncDelete`（`db.c:417`）只取消引用，把释放交给 bio 后台线程（`lazyfreeFreeObject`，`lazyfree.c:13`）。
- lazyfree 四类配置覆盖：淘汰（evict）、过期（expire）、服务端删除（server-del）、用户删除（user-del/UNLINK）。

## 本篇边界

- 不展开 bio 线程池的完整实现。

## 下篇桥接

- R-21 复制 backlog 溢出与全量重同步。
