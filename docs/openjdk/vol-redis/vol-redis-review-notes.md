# vol-redis 卷级六层审查笔记

> 审查基线：Redis 7.4.2 源码；正文 30 篇（R-1~R-32），目录 ch1~ch30；对照卷 vol-hikaricp / vol-druid。
> 审查日期：2026-08-21

## 结论

卷级审查完成。30 篇正文锚点全量扫描，250 个唯一 `file:line` 引用逐一核对，全部指向存在的源码行。发现并修正 2 处行号偏差、1 处过时机制描述。卷级推荐阅读顺序按 8 层规划执行。

## 1️⃣ 事实审

- 扫描 30 篇正文，共 250 个唯一 `file:line` 引用。
- 全部引用对应源码文件存在，行号均在文件范围内。
- 抽查发现并修正：
  1. **R-4 SDS**：`_sdsMakeRoomFor` 的 `if (type == SDS_TYPE_5)` 升级逻辑，实际 `sds.c:244`（初稿误为 245-246，v6-review 曾误改 238-239，卷级总审最终确认为 244）。
  2. **R-7 Set**：`setTypeMaybeConvert()` 实际 `t_set.c:40`（初稿误为 :37 空行）。
  3. **R-8 持久化**：AOF Rewrite 机制描述过时（6.x pipe 模型），7.x Multi-part AOF 已改为 `openNewIncrAofForAppend`（`aof.c:771`）接 incremental 文件。
- 仓库事实：107 个 .c + 68 个 .h，intset.c 560 行，ae.c 493 行（规划初稿数字已修正）。

## 2️⃣ 因果审

跨篇链路成立：

- R-1 redisObject（类型-编码开关）→ R-4 SDS → R-3 Dict → R-5 List → R-6 ZSet → R-7 Set → R-10 Stream，数据结构层递进
- R-2 事件驱动（aeMain）→ R-25 缓冲区 → R-26 命令执行全流程 → R-27 Lua
- R-28 内存淘汰（S←R-1/R-23）→ R-29 键空间 → R-30 阻塞 → R-31 PubSub → R-32 ACL
- R-8 持久化 → R-9 复制 → R-14 Sentinel → R-15 Cluster → R-19~R-24 排障
- 单篇内"困惑→朴素→顿悟→分层→收网→桥接"主线全部成立

## 3️⃣ 结构审

30 篇按 8 层组织（A 数据结构 / B 事件驱动 / C 命令基础 / D 经典混淆 / E 持久化复制 / F 高可用 / G 生产排障 / H 高级特性），物理目录 ch1~ch30，与推荐阅读顺序一致。每篇均含 4 件套（正文 + rewrite-plan + note + review-notes）。

## 4️⃣ 读者审

- 阅读顺序无前置悖论，依赖链单向无回环。
- R-28 内存淘汰与 R-23 过期删除的易混淆对，正文已在两篇中互相提示。
- 每篇"读完应能回答"的读者问题均有答案。

## 5️⃣ 边界审

- 淘汰清单（module.c、Lua 脚本引擎、CLI/网络传输层等）与正文边界清晰。
- 暂缓候选（spring-boot-starter-data-redis / Lettuce / Jedis 等 Java 集成层）在 README 标注明确。
- 生产排障层（R-19~R-24）正式纳入，非候选，覆盖面试重难点。

## 6️⃣ 依赖审

- 依赖方向为数据结构 → 事件 → 命令 → 混淆补深 → 持久化 → 高可用 → 排障 → 高级特性，无回环。
- 与 vol-hikaricp / vol-druid 正交：Redis 是内存 KV 服务器，连接池是 JDBC 层资源管理，无交叉引用。
- 方法论适配（C 语言）：锚点格式 `src/xxx.c:line`，无 MCP 索引，用 grep + 行号核对，已贯穿全程。

## 修正记录

1. R-4 SDS：升级逻辑行号 `sds.c:244`（经卷级总审最终确认）
2. R-7 Set：`setTypeMaybeConvert` 行号 `t_set.c:40`
3. R-8 持久化：AOF Rewrite 机制从 6.x pipe 模型修正为 7.x Multi-part AOF

## 验证记录

- 正文锚点全量扫描：250 个唯一引用，坏引用 0（2 处行号 + 1 处机制描述已修正后复核通过）
- Redis 源码版本 7.4.2，107 .c + 68 .h
- 该目录无独立 lint/typecheck；以锚点全量验证 + 单篇六层审查 + 卷级六层审查作为等价校验
