# Metaspace（元空间）— 文章大纲

> vol-03 · 域 16 · 🔴 A | 拓扑排序 #16
> 依赖：Heap/Universe + GC Framework（Metaspace 在类加载触发 GC 时才释放已卸载类的元数据）
>
> **→ 从 Heap**：对象分配在堆上（TLAB bump pointer），但类的元数据——`Klass`、`ConstantPool`、`Method`——存在哪？不是在堆里，是在 Metaspace。JDK8 用来替代 PermGen 的答案。

## 叙事计划

**开篇场景**：JDK7 的 PermGen 溢出是每个 Java 开发者的噩梦——`-XX:MaxPermSize=256m` 设小了就 `OOM: PermGen space`。JDK8 用 Metaspace 替换了 PermGen：类元数据不再占用 Java 堆，而是从 native 内存中分配——`-XX:MaxMetaspaceSize` 可以设得很大，因为 native 内存只受操作系统限制。

**第一层：Metaspace 架构——VirtualSpace + ChunkManager**

`Metaspace` 管理两块空间：`_class_space`（压缩类空间——如果 `UseCompressedClassPointers`，类元数据存在固定地址范围内）和 `_non_class_space`（方法、常量池等其他元数据）。每块由 `VirtualSpaceNode` 按需从操作系统 `reserve + commit` 内存。

`ChunkManager` 管理空闲块：分配时从 free list 取合适的 chunk，释放时归还。三种 chunk 大小：`SpecializedChunk`（<1KB）、`SmallChunk`（1-64KB）、`MediumChunk`（64KB-4MB）。大分配（>4MB）直接 `mmap` 不经过 ChunkManager。

**第二层：Metablock——分配的最小单位**

`Metablock` 是 `Metachunk` 内的分配单元。`Klass`、`ConstantPool`、`Method` 对象都在 Metaspace 中分配 Metablock。`SpaceManager` 在每个 ClassLoader 上追踪已分配的空间——类卸载时该 ClassLoader 相关的所有 Metablock 一起释放。

**第三层：类卸载——什么时候 Metaspace 能回收**

当 ClassLoader 变成不可达时，该 ClassLoader 加载的所有类可以卸载。`MetaspaceGC::compute_new_size()` 决定是否需要触发 GC 来回收 Metaspace。阈值由 `MaxMetaspaceSize` 和 `CompressedClassSpaceSize` 控制——超出阈值触发 `_metadata_GC_clear_soft_refs`。

**第四层：压缩类空间——为什么单独一块**

`CompressedClassSpace` 是 Metaspace 中的特殊区域——所有 Klass 对象分配在这里，地址范围固定。压缩类指针（`narrowKlass`）就是用相对于这块空间起始地址的 32 位偏移来编码 64 位 Klass 指针——不需要 base 加法，直接 `narrowKlass << shift`。

**设计权衡**

一、native 内存 vs 堆内存储。Metaspace 不占 Java 堆——GC 不扫描它。代价是类卸载需要显式的 Metaspace GC，不像堆内对象那样自动回收。默认无上限（`MaxMetaspaceSize` 未设置时），可能导致 native OOM。

二、ChunkManager vs 裸 mmap。free list 管理减少碎片，但需要维护内部元数据。大分配绕过 ChunkManager 直接 mmap——避免管理开销。

## 核心悬念

**JDK8 怎么解决 PermGen 溢出——把类元数据从 Java 堆搬到 native 内存，用 VirtualSpace + ChunkManager 按需分配、用类卸载回收？**

## 预估

1 篇，4 层递进，预估 1800-2400 行。

**→ 下一域**：类的 Klass 数据、方法表、常量池都存好了——但类名字符串 `"java/lang/String"` 被内部化在哪里？`String.intern()` 返回的字符串存在哪个内存区域？SymbolTable/StringTable 篇见。
