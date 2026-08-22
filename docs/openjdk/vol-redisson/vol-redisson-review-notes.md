# vol-redisson 卷级六层审查笔记

> 审查基线：Redisson main 分支（latest）源码；正文 7 篇（R-1~R-7），目录 ch1~ch7；对照卷 vol-redis。
> 审查日期：2026-08-21

## 结论

卷级审查完成。7 篇正文锚点全量验证，19 个唯一 `Class.java:line` 引用逐一核对，全部指向存在的源码行。发现并修正 2 处：R-2 的 Lua 锁脚本内容（经典版→源码合并分支版）、R-3 的 Codec 实现数量（7 种→实际 5 种）。

## 1️⃣ 事实审

- 扫描 7 篇正文，共 19 个唯一锚点，全部通过验证。
- 行数说明（Redisson 1532 / Config 1351 / ServiceManager 804 / CommandAsyncService 1256 / RedissonLock 600 / RedissonMap 1967）与文件实际行数全部一致。
- 发现并修正：
  1. **R-2 RLock Lua 锁脚本**：正文初稿用经典版（`hset` + 独立 `hincrby` 双分支），实际 `RedissonLock.java:217-227` 是合并分支（`exists==0 || hexists==1` 单分支直接 `hincrby`）。已修正正文 + note + review-notes。
  2. **R-3 Codec 实现数量**：规划文档列 7 种（含 FSTCodec/MarshallingCodec），当前 main 分支源码实际只含 5 种（JsonJackson/Kryo5/SnappyCodecV2/LZ4CodecV2/SerializationCodec）。已修正正文。

## 2️⃣ 因果审

- R-1 Config 模式 → ConnectionManager → ServiceManager → CommandAsyncExecutor 四层递进 ✅
- R-2 Lua 原子加锁 → Watchdog 续期 → AsyncChunkProcessor 批量续期 ✅
- R-4 readAsync 走 slave / writeAsync 走 master 读写分离 ✅
- R-5 LocalCachedMap 写操作 invalidate 近缓存 ✅

## 3️⃣ 结构审

7 篇按"核心（R-1/4/2/3）+ 扩展（R-5/6/7）"组织，每篇四件套齐全，主线集中。

## 4️⃣ 读者审

- R-1 读完能回答四层初始化链路 ✅
- R-2 读完能回答 RLock 加锁 Lua 脚本实际逻辑 ✅（修正后）
- R-3 读完能回答 Codec 的实际内置实现 ✅（修正后）

## 5️⃣ 边界审

- 淘汰清单（api 801 接口、响应式、MapReduce、框架集成等）边界清晰 ✅

## 6️⃣ 依赖审

```
R-1 → R-4 → R-2 → R-3 → R-5 → R-6 → R-7
```
单向无回环。与 vol-redis 互补（服务器 vs 客户端），RLock 脚本语义复用 vol-redis R-27。

## 修正记录

1. R-2 RLock Lua 锁脚本内容（合并分支版）
2. R-3 Codec 实现数量（5 种，删除不存在 FST/Marshalling）

## 验证记录

- 锚点全量验证：19 个唯一引用，坏引用 0（2 处修正后复核通过）
- 行数说明与源码一致
