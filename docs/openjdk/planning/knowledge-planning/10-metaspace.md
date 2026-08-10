# 域 10: Metaspace — 知识规划

> 源码路径: hotspot/share/memory/metaspace/ + memory/metaspace* | 源码量: ~48 文件 / ~13,300 行 | 大型域
> 拆 3-4 篇

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| metaspace.hpp.cpp | **Metaspace — 全局入口**: Metaspace::allocate/resize/deallocate, ClassLoaderMetaspace per-CL, 与 VirtualSpace/ChunkManager 的接口 | High |
| metaspaceCommon.hpp.cpp | **Metaspace 公共**: MetaspaceObj, Metablock, alignment, commit/uncommit granularity, settings (MaxMetaspaceSize 等) | High |
| virtualSpaceList.hpp.cpp + virtualSpaceNode.hpp.cpp | **VirtualSpaceList — 虚拟空间链表**: VirtualSpaceNode (1个 mmap 区域, free/top/used), VirtualSpaceList (多个 Node 的链表, 从 CommittedVirtualSpace 取空间) | High |
| chunkManager.hpp.cpp | **ChunkManager — Chunk 分配器**: Chunk (Metachunk, 固定大小), ChunkManager (free list + Chunk allocation), Chunk header 编码 | High |
| metablock.hpp + blockFreelist.hpp.cpp | **Metablock + BlockFreelist — 小块分配器**: Metablock (任意大小, 在 Chunk 内), BlockFreelist (free Chunk 内部的空闲块链表) | High |
| metaspaceArena.hpp.cpp | **MetaspaceArena — 每 CLD 的分配区**: MetaspaceArena (per ClassLoaderData), 从 ChunkManager 取 Chunk, 内部用 Metablock 分配 | High |
| spaceManager.hpp.cpp | **SpaceManager — 空间管理器**: 管理一组 Chunk, 分配/释放/扩展, Chunk 的碎片回收 | High |
| metaspaceShared.hpp.cpp | **MetaspaceShared — CDS 共享**: 共享类元数据归档, dump/load 共享 archive, 跨 JVM 进程共享 Metaspace | Medium |
| metaspaceTracer.hpp.cpp + metaspaceCounters.hpp.cpp | **Metaspace 追踪**: JFR/PerfData/JMX 统计, chunk allocation/free/commit/uncommit 计数器 | Low |

*9 个知识点*

## 02 聚合

### P1 — 系统级共识 (≥5 文件)
| KP | 出现文件 |
|----|---------|
| Metaspace 分配 (allocate/deallocate/commit) | metaspace.*, metaspaceArena.*, chunkManager.*, virtualSpaceNode.*, spaceManager.* |
| Chunk + Metablock 两级分配 | chunkManager.*, metablock.*, metaspaceArena.*, blockFreelist.*, spaceManager.* |

### P2 — 局部重要 (2-4 文件)
| KP | 出现文件 |
|----|---------|
| VirtualSpaceList + VirtualSpaceNode | virtualSpaceList.*, virtualSpaceNode.*, metaspace.* |
| MetaspaceShared (CDS) | metaspaceShared.*, metaspace.*, chunkManager.* |
| Metaspace settings + GC | metaspaceCommon.*, metaspace.*, metaspaceCounters.* |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (3 KP)
| KP | 为什么🔴 |
|----|---------|
| Chunk + Metablock 两级分配 | Chunk (固定大小, ~4KB/64KB) 从 VirtualSpace commit——大粒度。Metablock (任意大小, ~10-200B) 在 Chunk 内 bump-pointer——小粒度。Klass 分配 ~500B→走 Metablock。Method 元数据 ~2KB→需要多 Chunk。两级避免了为每个 Klass 调 mmap |
| VirtualSpaceList → ChunkManager → MetaspaceArena 三层 | ClassLoader 卸载时——释放 Chunk→还给 ChunkManager→如果 VirtualSpaceNode 中所有 Chunk 都归还——uncommit VirtualSpace→还给 OS。三层回收: Arena 层标记 free→ChunkManager 缓存→VirtualSpace 回收 |
| MetaspaceSettings — MaxMetaspaceSize + GCThreshold | `-XX:MaxMetaspaceSize` 默认无限制——类加载过多→CompressedClassSpace 满→OOM。`-XX:MetaspaceSize` (初始 high-water)——达到→GC (Full GC with class unloading) |

### 🟡 Working — 有设计但非核心 (3 KP)
| KP | 说明 |
|----|------|
| MetaspaceShared (CDS) | 共享 archive——启动加速 |
| MetaspaceArena per-CLD | 每 ClassLoader 隔离分配空间 |
| MetaspaceCounters/Tracer | 统计/追踪 |

## 04 聚类 — 教学顺序与文章拆分

### 教学顺序

```
1. Metaspace 全景 — 什么是 Metaspace, 为什么需要, 整体架构
2. Chunk + Metablock 两级分配
3. VirtualSpaceList → ChunkManager → Arena 三层回收
4. 辅助 — CDS + GC + settings
```

### 文章拆分建议

3 篇（~48文件/13K行）:

- **01-metaspace-overview.md** — Metaspace 全景 + settings + GC
- **02-chunk-metablock-allocation.md** — ChunkManager + Metablock + BlockFreelist
- **03-virtualspace-arena-reclaim.md** — VirtualSpaceList/VirtualSpaceNode + MetaspaceArena + CDS
