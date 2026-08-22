# vol-redis R-20 大 key 删除与 lazyfree — review notes

## 事实审
- `db.c:417` dbAsyncDelete ✅ `dbGenericDelete` 同步版本 ✅ `lazyfree.c:13` lazyfreeFreeObject ✅ `lazyfree.c:23` lazyfreeFreeDatabase ✅ `config.c:3060` lazyfree-lazy-eviction ✅ `server.h:2033` lazyfree_lazy_eviction ✅ `lazyfree.c:201` emptyDbAsync ✅

## 因果审
- DEL 遍历数据 suil释放元素，大 key 阻塞 ✅
- UNLINK 取消引用 + bio 后台释放，主线程立即返回 ✅
- lazyfree 四类配置覆盖不同删除场景 ✅

## 结构审
- 从"DEL 为什么卡"到 DEL/UNLINK/配置，主线集中 ✅

## 读者审
- 读完能回答：UNLINK 和 DEL 的区别 ✅

## 边界审
- 不展开 bio 线程池 ✅

## 依赖审
- 前置 R-3/R-5/R-28，后续 R-21 ✅

## 结论
R-20 通过六层审查。
