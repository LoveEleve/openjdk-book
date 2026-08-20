# 10-metaspace/01-metaspace-overview 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 HotSpot 为什么要把类元数据从堆里的 PermGen 挪到 native metaspace，以及 JDK 11u 里 metaspace 真正按什么层次工作

## 1. 选题判断

现稿已经覆盖了 PermGen、四层架构、class/non-class space、阈值与 GC，但叙事仍偏“概念总览卡片”：先抛结论，再按组件列点，读者能记住几个名词，却不一定真正回答两个核心困惑：

1. **类元数据为什么不能继续住在 Java heap 里？**
2. **Metaspace 明明在 native memory，为什么分配失败时还要去触发一次 GC？**

如果这两个困惑没有被打穿，读者会把 metaspace 误解成“只是把 PermGen 换了个地址”，或者误解成“native memory 所以和 GC 再无关系”。

## 2. 一句话顿悟

**Metaspace 的核心变化不是“把类元数据挪出堆”这么简单，而是把生命周期边界从“跟着整个 Java heap 回收”改成“跟着 ClassLoaderData 成批生灭”。native memory 解决的是容量与地址空间问题；ClassLoader 卸载解决的是释放边界问题；而 GC 仍然要参与，是因为只有 GC/safepoint 才能证明“哪个 ClassLoader 已经死了，可以整批归还这片 metaspace”。**

## 3. 总图

```text
Metadata allocation request
  │
  ├─ Metaspace::allocate
  │    ├─ 按 MetaspaceObj::Type 分成 class / non-class
  │    ├─ 先找当前 CLD 的 ClassLoaderMetaspace
  │    └─ 失败时请求 heap 做 metadata GC 重试
  │
  ├─ ClassLoaderMetaspace
  │    ├─ _class_vsm   (Klass 等 class metadata)
  │    └─ _vsm         (Method/CP/Symbol 等 non-class metadata)
  │
  ├─ SpaceManager
  │    ├─ 当前 chunk 内 bump allocate
  │    ├─ 不够则 grow_and_allocate
  │    └─ 小块回收到 per-manager freelist
  │
  ├─ ChunkManager
  │    ├─ 全局 free chunks
  │    ├─ small / medium / specialized / humongous
  │    └─ split / coalesce / return_chunk_list
  │
  └─ VirtualSpaceList / VirtualSpaceNode
       ├─ reserve 新虚拟空间
       ├─ commit 扩张当前 node
       └─ class space 与 non-class space 分开管理
```

## 4. 结构大纲与字数预算

### 第一节：开场事故——为什么 PermGen 不是“调大一点就行”

目标约 1200 字。

- 从 `OutOfMemoryError: PermGen space`、动态代理/反射/热部署说起
- 解释 PermGen 真正的问题不是“默认值太小”，而是类元数据和 Java heap 抢同一块预算
- 引出 metaspace 的两个目标：从 heap 预算解绑；把释放边界绑到 class loader 生命周期

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：

1. 继续把类元数据放 heap，只是调大上限
2. 挪到 native memory，但仍做成一个全局大池
3. 挪到 native memory 后完全不理 GC

要落出的结论：
- 只换地址，不换生命周期边界，问题并没有消失
- 只有“按 CLD 分仓 + 卸载时整批归还”才真正改变回收模型
- native memory 不等于不需要 GC；GC 仍负责证明谁死了

### 第三节：Metaspace::allocate——为什么 native 分配失败时还会去找 GC

目标约 1900 字。

- `Metaspace::allocate` 的入口职责
- `MetaspaceObj::Type` -> `MetadataType` 分成 ClassType / NonClassType
- 先向 `loader_data->metaspace_non_null()->allocate()` 申请
- 失败后 `Universe::heap()->satisfy_failed_metadata_allocation()`
- 成功后 zero initialize
- 纠偏：“触发 GC”不是因为 metadata 在 heap 里，而是为了 class unloading 与避免过早扩张 metaspace

### 第四节：ClassLoaderMetaspace——为什么 metaspace 的真正所有者不是全局，而是 CLD

目标约 1800 字。

- `ClassLoaderMetaspace` per `ClassLoaderData`
- `_vsm` 与 `_class_vsm` 两个 `SpaceManager`
- 这才是“类卸载时整批释放”的关键结构
- 把“跟 class loader 生灭”讲清楚，而不是只说“每个 ClassLoader 一套”

### 第五节：SpaceManager——当前 chunk bump，碎块回收到本地 freelist

目标约 1900 字。

- `allocate()` 先看 per-manager `BlockFreelist`
- `allocate_work()` 先试 `current_chunk()->allocate`
- 不够就 `grow_and_allocate`
- `retire_current_chunk()` 会把剩余小块回收到 freelist
- humongous chunk 为什么不设为 current
- 纠偏：JDK 11u 不是 `MetaspaceArena` 术语；执行面是 `SpaceManager`

### 第六节：ChunkManager + VirtualSpaceList——native memory 不等于每次都重新 mmap

目标约 1800 字。

- `ChunkManager` 管全局 free chunks，不同规格分层
- miss 时 `VirtualSpaceList::get_new_chunk`
- 先试当前 `VirtualSpaceNode::get_chunk_vs`
- 不够则 `expand_by`，commit 当前 node；还不够再 reserve 新 node
- 把这层和 `09-memory-core/02-virtualspace.md` 接上：reserve / commit 在 metaspace 里再次出现

### 第七节：为什么要分 class space 与 non-class space

目标约 1700 字。

- `UseCompressedClassPointers` 下才有 class space
- `CompressedClassSpaceSize` 默认 1G
- `set_narrow_klass_base_and_shift()` 为什么想尽量做到 shift=0
- 解释“独立地址范围”服务的是 narrowKlass 解码，而不是简单分类好看
- 纠偏：不是所有 metadata 都在 compressed class space 里

### 第八节：Metaspace 的“GC 阈值”到底是什么意思

目标约 1700 字。

- `MetaspaceSize` 的语义是 initial threshold，不是当前容量上限
- `MaxMetaspaceSize` 是绝对上限
- metadata allocation failure 走 `GCCause::_metadata_GC_threshold`
- 解释“Metaspace 也会 GC”这句话为什么容易误导：真正回收的是死掉的 CLD 及其 metadata，不是像 heap 那样扫描对象图后原地压缩一块 native arena

### 第九节：误解澄清与收网

目标约 1200 字。

至少回答：
1. Metaspace 是否只是“PermGen 挪到堆外”
2. native memory 是否意味着和 GC 无关
3. `MetaspaceSize` 是否等于当前 metaspace 大小上限
4. 所有 metadata 是否都在 compressed class space
5. JDK 11u 是否已经使用 `MetaspaceArena`
6. class unloading 是否等于“逐对象 free metadata”

## 5. 失败方案必须写进正文

1. 继续把类元数据留在 heap，只是调大 PermGen/阈值
2. 挪到 native memory，但做成全局共享大池
3. 挪到 native memory 后认为不再需要 GC 配合

## 6. 证据清单

- `share/memory/universe.cpp:694`：`Metaspace::global_initialize()` 启动入口
- `share/memory/metaspace.cpp:1366-1413`：`Metaspace::allocate`
- `share/gc/shared/collectedHeap.cpp:257-329`：failed metadata allocation -> VM_CollectForMetadataAllocation
- `share/memory/metaspace.hpp:237-303`：`ClassLoaderMetaspace` 与 `_vsm/_class_vsm`
- `share/memory/metaspace/spaceManager.hpp:176-195,208-219`：`get_new_chunk` / `allocate_work` / `grow_and_allocate` / allocation word sizing
- `share/memory/metaspace/spaceManager.cpp:173-220,322-452`：grow / humongous / freelist / allocate path
- `share/memory/metaspace/chunkManager.hpp:43-157`：global free chunk manager
- `share/memory/metaspace/virtualSpaceList.hpp:99-138`：virtual space list APIs
- `share/memory/metaspace/virtualSpaceList.cpp:190-223,267-370`：create node / expand / get_new_chunk
- `share/memory/metaspace.cpp:1015-1054`：narrow klass base + shift
- `share/memory/metaspace.cpp:1074-1233`：compressed class space reservation and initialization
- `share/runtime/globals.hpp:1816-1828`：`MetaspaceSize` / `MaxMetaspaceSize` / `CompressedClassSpaceSize`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇讲“全景与层次”，不深挖 chunk 内 block 复用细节；那是下一篇 `02-chunk-metablock-allocation.md`
- JDK 11u 的执行层术语是 `ClassLoaderMetaspace + SpaceManager`，不要误写成 JDK 15+ 的 `MetaspaceArena`
- class space 只在 `UseCompressedClassPointers` 语境下成立
- GC 参与 metadata allocation failure 的根本原因是帮助 class unloading 与阈值控制，不是因为 metadata 仍在 Java heap 中

## 8. 完成后 review

- 删除代码后，能否复述“native memory 解决容量；CLD 分仓解决生命周期；GC 负责证明谁死了”
- 是否明确纠正了 `MetaspaceArena`、`MetaspaceSize`、`class space`、`native memory 不需要 GC` 等误解
- 是否把 `Metaspace::allocate -> CLD -> SpaceManager -> ChunkManager -> VirtualSpaceList` 讲成一条理解链，而不是组件名词表
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
