# 域 09: Memory 核心 — 知识规划

> 源码路径: hotspot/share/memory/ (allocation, universe, heap, virtualspace, arena, guardedMemory, iterator, memRegion, oopFactory, resourceArea) | 源码量: ~34 文件 / ~12,269 行 | 中型域
> 拆 3 篇

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| universe.hpp.cpp | **Universe — JVM 全局堆初始化**: _collectedHeap/_heap/_non_oop_bits, Universe::genesis 初始化全局 Klass (Object/Class/String), GC heap 创建 | High |
| heap.hpp.cpp | **CollectedHeap — GC 堆抽象基类**: gc_cause/total_collections/allocate_new_tlab/collect/object_iterate, GC 堆的公共接口 | High |
| virtualspace.hpp.cpp | **VirtualSpace — 虚拟地址空间管理**: ReservedSpace (reserve) + CommittedSpace (commit), low/high/lower/higher/middle, 区域分割管理 | High |
| allocation.hpp.inline.hpp.cpp | **Allocation — 对象分配**: AllocateHeap/ReallocateHeap/FreeHeap (C++ heap for VM), AllocateHeap 的 NMT tracking, size alignment | High |
| arena.hpp.cpp | **Arena — Chunk-based 分配器**: Chunk (固定大小) + Arena (free list), Amalloc/Afree, 快速小块分配, Chunk 链管理 | High |
| resourceArea.hpp.inline.hpp.cpp | **ResourceArea — 临时分配器**: ResourceMark (mark/release), 快速回滚, 嵌套 resource mark, 栈式生命周期 | High |
| guardedMemory.hpp.cpp | **GuardedMemory — 调试内存保护**: canary 前后 padding (0xDEADBEEF), buffer overflow 检测, wrapped malloc | Medium |
| oopFactory.hpp.cpp | **OopFactory — OOP 工厂**: new_instance/new_array/new_symbol/new_method, 创建各类 OOP 对象的入口 | Medium |
| memRegion.hpp | **MemRegion — 内存区域**: start/end/contains/intersection——内存区间的基本抽象 | Low |
| iterator.hpp.inline.hpp.cpp | **OopClosure + ObjectClosure — GC 遍历**: do_oop/do_object, GC 遍历的迭代器接口 | Medium |

*10 个知识点*

## 02 聚合

### P1 — 系统级共识 (≥5 文件)
| KP | 出现文件 |
|----|---------|
| Universe + Heap 全局堆 | universe.*, heap.*, virtualspace.*, allocation.*, resourceArea.* |

### P2 — 局部重要 (2-4 文件)
| KP | 出现文件 |
|----|---------|
| VirtualSpace 虚拟内存 | virtualspace.*, universe.* |
| Arena/ResourceArea 分配器 | arena.*, resourceArea.*, allocation.* |
| GuardedMemory 调试 | guardedMemory.*, allocation.* |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (2 KP)
| KP | 为什么🔴 |
|----|---------|
| Universe — 全局 Klass 预分配 | JVM 启动时 Genesis 预创建 Object/String/Class 的 InstanceKlass——不需要等第一次 new——直接已经可用。GC heap 的选择 (G1/Serial/Parallel) 在此决定 |
| VirtualSpace — reserve+commit 三级 | ReservedSpace (high/low, 只 reserve) + CommittedSpace (commit 部分区域) + 分割管理 (split into lower+middle+higher)——Metaspace/CodeCache 的基础 |

### 🟡 Working — 有设计但非核心 (4 KP)
| KP | 说明 |
|----|------|
| Arena + ResourceArea | Chunk alloc + mark/release 栈分配器 |
| Allocation (VM C++ heap) | NMT tracked C++ heap |
| GuardedMemory | canary debug 保护 |
| OopFactory | OOP 创建工厂 |

### 🟢 Surface — 了解即可 (4 KP)
| KP | 说明 |
|----|------|
| MemRegion | 基本区间抽象 |
| Iterator (GC closure) | 遍历接口 |

## 04 聚类 — 教学顺序与文章拆分

### 教学顺序

```
1. Universe + Heap — 全局堆是什么 (A)
2. VirtualSpace — 怎么管理虚拟内存 (A 的底层)
3. Allocation + Arena/ResourceArea + GuardedMemory — VM 自己的分配器
```

### 文章拆分建议

3 篇:

- **01-universe-heap.md** — Universe + Heap + OopFactory
- **02-virtualspace.md** — VirtualSpace + MemRegion + iterator
- **03-arena-resourcearea-allocation.md** — Arena + ResourceArea + Allocation + GuardedMemory
