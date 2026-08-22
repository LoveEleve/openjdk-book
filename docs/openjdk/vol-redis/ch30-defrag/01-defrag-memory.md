# 内存碎片整理：activeDefragCycle

> 本文基于 Redis 7.4.2 当前源码。回答内存碎片整理机制。

## 一、内存碎片

Redis 用 Jemalloc 分配内存，长期运行后申请/释放不匹配产生碎片。`INFO memory` 的 `mem_fragmentation_ratio` 反映碎片率。

## 二、activeDefragCycle

`activeDefragCycle()`（`defrag.c:1256`）在 `serverCron` 中执行，按 `hz` 频率每次处理一部分 dict entry：

1. 遍历 dict 的 entry
2. 调 `je_get_defrag_hint()`（`defrag.c:32`）判断指针是否可整理
3. 可整理则重新分配（`je_malloc_usable_size` 比较），释放旧指针
4. 更新 dict 的 entry 指针

## 三、配置

`activedefrag yes` 启用，`active-defrag-threshold-lower` 默认 10（碎片率超过 1.1 时触发），`active-defrag-cycle-min` 默认 25%。

## 四、收网

`activeDefragCycle` 在 `serverCron` 中逐步整理碎片，用 `je_get_defrag_hint` 判断，避免一次性全量扫描。

## 下篇桥接

卷级收尾。
