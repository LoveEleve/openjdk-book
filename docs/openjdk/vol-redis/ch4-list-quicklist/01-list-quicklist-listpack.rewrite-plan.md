# 篇：01 List 数据结构：从 ziplist 到 listpack 的迁移与 quicklist 分页设计

- 域：`R-5 List/quicklist`
- 卷：`vol-redis`
- 目标：回答 List 为什么从 ziplist 迁移到 listpack，以及 quicklist 如何做分页式存储与 LZF 压缩。

## 前置依赖

- HARD：已读 `R-1 redisObject`，知道 `encoding=QUICKLIST` 时 List 底层是 quicklist。

## 读者问题

1. List 有 3 种编码历史（ziplist → quicklist(listpack)），为什么？
2. ziplist 的连锁更新是什么？为什么 listpack 消除了它？
3. quicklist 的 `fill` 和 `compress` 参数控制什么？
4. LZF 压缩在 quicklist 里怎么用？什么时候压缩、什么时候解压？
5. listpack 的 entry 编码格式是什么？

## 主结论

Redis List 的编码演进是一个"连环升级"：ziplist（紧凑但连锁更新问题）→ quicklist（双向链表+ziplist分页，缓解连锁更新）→ 7.0 全面迁移到 **listpack**（彻底消除连锁更新，每 entry 自包含长度）。

`quicklistNode` 是存储单元，`container=PACKED` 时 `entry` 指向 listpack；`container=PLAIN` 时指向原始数据。`encoding=RAW/LZF` 决定是否压缩。

## 结构设计

1. 困惑开场：为什么一个 List 要换三次编码
2. ziplist 布局与连锁更新问题
3. listpack 的编解码：每 entry 自包含长度，无连锁更新
4. quicklist 结构：quicklistNode + listpack 分页
5. fill 参数与节点分裂/合并
6. compress 参数与 LZF 压缩策略
7. t_list.c 命令入口
8. 失败路径
9. 收网与下篇桥接 R-6 ZSet

## 必须回填的源码锚点

- `src/quicklist.h:47`-`:59` `quicklistNode` 结构体（prev/next/entry/sz/count/encoding/container/recompress）
- `src/quicklist.h:99`-`:108` `quicklist` 结构体（head/tail/count/len/fill/compress）
- `src/quicklist.h:66` `quicklistLZF` 结构体（sz + compressed）
- `src/quicklist.c:127` `quicklistCreate()`
- `src/quicklist.c:557` `__quicklistCreateNode()` 创建节点
- `src/quicklist.c:583` `quicklistPushHead()` 头部插入
- `src/quicklist.c:611` `quicklistPushTail()` 尾部插入
- `src/listpack.c:84` `lpGetTotalBytes` / `lpGetNumElements` header 格式
- `src/listpack.c` `lpNew()` 创建 listpack
- `src/listpack.c` `lpFirst()` / `lpNext()` 遍历
- `src/ziplist.c:16` ziplist 布局注释
- `src/t_list.c:493` `lpushCommand()`
- `src/t_list.c:856` `lrangeCommand()`

## 必须引用的测试/证据

- `tests/unit/type/list.tcl`

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
- 所有 `file:line` 以写作时重新核对后的真实行号为准。
