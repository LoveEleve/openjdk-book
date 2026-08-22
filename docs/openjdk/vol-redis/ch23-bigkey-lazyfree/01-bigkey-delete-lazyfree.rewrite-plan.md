# 篇：01 大 key 删除与 lazyfree 异步释放

- 域：`R-20 大 key 删除与 lazyfree 异步释放`
- 卷：`vol-redis`
- 目标：回答 DEL 为什么要同步删除、UNLINK 怎么异步释放、lazyfree 覆盖哪些场景。

## 前置依赖

- HARD：已读 `R-3 Dict`（dictDelete 遍历）、`R-5 List`（quicklist 释放）、`R-28 内存淘汰`（lazyfree-lazy-eviction）。

## 读者问题

1. `DEL` 删除大 key 为什么阻塞？
2. `UNLINK` 怎么做异步释放？
3. `lazyfree-lazy-user-del` / `lazyfree-lazy-server-del` / `lazyfree-lazy-expire` / `lazyfree-lazy-eviction` 覆盖哪些场景？

## 主结论

`DEL`（`dictDelete`）同步遍历数据结构释放元素，元素多时阻塞主线程。`UNLINK` 用 `dbAsyncDelete` 把释放任务交给 `bio` 后台线程，主线程只删除 dict 中的引用。

## 结构设计

1. 困惑开场：为什么 DEL 删大 key 会卡
2. sync delete 与 async delete
3. dbAsyncDelete 与 bio 后台线程
4. lazyfree 四类配置覆盖的场景
5. 收网与下篇桥接 R-21

## 必须回填的源码锚点

- `src/db.c:417` `dbAsyncDelete()`（异步删除）
- `src/lazyfree.c:13` `lazyfreeFreeObject()`
- `src/lazyfree.c:23` `lazyfreeFreeDatabase()`
- `src/config.c:3060` `lazyfree-lazy-eviction`
- `src/server.h:2033` `lazyfree_lazy_eviction`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
