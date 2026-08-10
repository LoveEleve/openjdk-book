# 27 — 内存管理剩余 — libjvm.so (memory/)

## §〇 概述

补充分析 memory/ 中 83 文件（~27K 行）里尚未深度覆盖的内存分配器内部机制。

**源码路径**：`src/hotspot/share/memory/`

### BUILD_LIBRARY

属于 libjvm.so 内部编译：
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

---

## §一 已覆盖 vs 待覆盖

```
memory/ (83 files, ~27K lines)

✅ 已覆盖（libjvm-analysis 深入文档）:
  metaspace.cpp/hpp (2,045+496)     → 01-jvm-startup (高层架构)
  universe.cpp/hpp (1,609+559)      → 01-jvm-startup (Universe init)
  metaspaceShared (2,190+259)       → 部分在 CDS 文档
  TLAB allocation                   → 03-object-model/06-TLAB-Detail.md

⏳ 待覆盖 — Phase 27 目标:
  virtualspace.cpp/hpp           1580+241  虚拟空间（ReservedSpace→VirtualSpace→CommittedRegion）
  arena.cpp/hpp                   525+256  Arena 分配器（chunk链+Amalloc+Afree）
  resourceArea.cpp/hpp/inline      89+264  ResourceArea（thread-local Mark+Nest）
  allocation.cpp/hpp/inline       297+577  分配框架（ARENA_OBJ/C_HEAP_OBJ 宏）
  metaspace/virtualSpaceList     475+169  VirtualSpace 链表管理
  metaspace/virtualSpaceNode     662+167  VirtualSpace 节点
  metaspace/chunkManager         732+224  Metachunk 分配/回收
  metaspace/spaceManager         540+234  Block-level 分配器
  metaspace/blockFreelist        109+93   空闲块链表
  metaspace/smallBlocks           62+89   小对象块管理
  metaspace/metachunk            175+173  Metachunk 生命周期
  binaryTreeDictionary.hpp/inline 395+1036 二叉树字典（CMS 空闲列表）
  freeList.hpp/inline            176+330  空闲链表
  metaspace/occupancyMap         135+243  占位图
  metaspace/metaDebug            63+47    调试支持
  metaspace/metaspaceStatistics  276+188 统计收集
  guardedMemory                  81+323   内存保护检测
```

---

## §二 文档拆分规划

| 编号 | 标题 | 源文件数 | 源码行数 | 状态 |
|:---:|------|:---:|:---:|:---:|
| 00 | VirtualSpace Layer | 4 | ~3,300 | 待开始 |
| 01 | Arena & ResourceArea | 5 | ~1,800 | 待开始 |
| 02 | Metaspace Internals | 8 | ~3,400 | 待开始 |

### doc-00: VirtualSpace Layer

virtualspace.cpp/hpp + metaspace/virtualSpaceList + metaspace/virtualSpaceNode

**关键问题**：
- ReservedSpace::initialize() 的 mmap(MAP_NORESERVE) 提交/保留分离
- VirtualSpace::expand_by() 的分段提交
- VirtualSpaceNode 的 commit/uncommit 粒度控制
- VirtualSpaceList::get_new_chunk() 的扩容策略

### doc-01: Arena & ResourceArea

arena.cpp/hpp + resourceArea.cpp/hpp/inline + allocation.cpp/hpp/inline

**关键问题**：
- Arena::grow() 的 chunk 链表追加 + 1KB 首次分配
- Amalloc() vs Amalloc_4() 的对齐语义
- ResourceArea::allocate_bytes() 的 thread-local 快速路径
- ResourceMark 嵌套：Mark→allocate→~ResourceMark→rollback
- ARENA_OBJ/C_HEAP_OBJ/NEW_RESOURCE_ARRAY 宏的分配器选择

### doc-02: Metaspace Internals

metaspace/chunkManager + spaceManager + blockFreelist + smallBlocks + metachunk + binaryTreeDictionary + freeList + occupancyMap

**关键问题**：
- ChunkManager 的 Specialized/Small/Medium 三级 Metachunk 池
- SpaceManager 的 block-level 分配（二分搜索 + 空闲列表）
- BlockFreelist + SmallBlocks 的局部缓存
- BinaryTreeDictionary 的 best-fit 搜索（CMS 历史遗留）
- FreeList 的 lock-free concurrent access
- MetaChunk 的分配/返还生命周期

---

## §三 旧文档重叠

- `libjvm-analysis/01-jvm-startup/03-Metaspace.md` — Metaspace 高层初始化
- `libjvm-analysis/03-object-model/06-TLAB-Detail.md` — TLAB 快速分配
- 新文档覆盖内存分配器内部实现（commit 粒度、分配器链、块管理），旧引用互补

---

## §四 待完成

- [x] 遍历 memory/ 确认遗漏文件
- [x] BUILD_LIBRARY 确认
- [ ] 写 prompt（并行 3 篇）
- [ ] 新会话生成文档
- [ ] Review
