# 篇：01 内存碎片整理 defrag

- 域：`R-18 内存碎片整理 defrag`
- 卷：`vol-redis`
- 目标：回答 activeDefragCycle 怎么在 serverCron 中整理内存碎片。

## 前置依赖

- HARD：已读 `R-2 事件驱动`（知道 serverCron 中 activeDefragCycle）。

## 读者问题

1. 内存碎片怎么产生的？
2. `activeDefragCycle` 怎么工作？
3. Jemalloc 的 `je_get_defrag_hint` 怎么帮助判断碎片？

## 主结论

`activeDefragCycle()`（`defrag.c:1256`）在 `serverCron` 中按 `hz` 频率执行，遍历 dict 的 entry，用 `je_get_defrag_hint()`（`defrag.c:42`）判断是否碎片化，是则重新分配后释放旧内存。

## 必须回填的源码锚点

- `src/defrag.c:1256` `activeDefragCycle()`
- `src/defrag.c:32` `je_get_defrag_hint()`
- `src/defrag.c:42` `je_get_defrag_hint(ptr)` 调用

## note / review 约束

- note 只记主张、边界、卷级桥接。
- review 覆盖事实、因果、结构、读者、边界、依赖六层。
