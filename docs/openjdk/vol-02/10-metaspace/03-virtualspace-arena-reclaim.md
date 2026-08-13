# 03. VirtualSpace 与归还 — chunk 从哪来又到哪去

> **前置依赖**:[10-metaspace/02 — Chunk/Metablock 分配](openjdk/vol-02/10-metaspace/02-chunk-metablock-allocation.md):领取 chunk 失败时下沉的 VirtualSpaceList 在这里展开;[09-memory-core/02 — VirtualSpace](openjdk/vol-02/09-memory-core/02-virtualspace.md):VirtualSpaceNode 的内核就是那一篇的 reserve/commit 三段;[10-metaspace/01 — Metaspace 全景](openjdk/vol-02/10-metaspace/01-metaspace-overview.md):四层架构的 L4;[07-classfile-classloader/05 — ClassLoader](openjdk/vol-02/07-classfile-classloader/05-classloader-hierarchy.md):CLD 卸载触发整条归还链
> → **后续**:域 11 CDS(类数据共享: archive→shared spaces 的完整实现,第 5 批)
> 关联域: 09-memory-core(虚拟内存)、10-metaspace(元数据)、11-cds、17-threads(CLD 生命周期)

## chunk 用完了,虚拟内存从哪来、又去哪

02 篇的两级分配停在"缓存 miss 才下沉 VirtualSpaceList"——这一篇把后半段补齐: 当前 Node 的已提交区怎么扩展、ClassLoader 卸载后整条归还链怎么走(切碎 → 摘除 → munmap 还给 OS),以及 10 域的收官彩蛋——CDS 怎么让多进程共享同一份类元数据。

## 1. VirtualSpaceNode: 一个 mmap 区域的管家

### 结构: 09-02 的 VirtualSpace 是内核

`VirtualSpaceNode`(virtualSpaceNode.hpp:42)管一个 mmap 区域: `_rs`(ReservedSpace,09-02 的 reserve)+ `_virtual_space`(09-02 的 VirtualSpace 三段提交)。`initialize`(virtualSpaceNode.cpp:500-526)做两件事: 断言 base/size 对齐到 `Metaspace::commit_alignment()`(:506-508,保证按同一粒度扩展),然后 `virtual_space()->initialize_with_granularity(_rs, pre_committed_size, commit_alignment)`(:516)——09-02 的三段初始化,special 的 Node 整块预提交。

### expand: 先查未提交区,再 commit

`expand_by`(virtualSpaceNode.cpp:467-493,截取核心,逐字):

```cpp
// virtualSpaceNode.cpp:467-493(截取核心,逐字)
bool VirtualSpaceNode::expand_by(size_t min_words, size_t preferred_words) {
  size_t min_bytes = min_words * BytesPerWord;
  size_t preferred_bytes = preferred_words * BytesPerWord;

  size_t uncommitted = virtual_space()->reserved_size() - virtual_space()->actual_committed_size();

  if (uncommitted < min_bytes) {
    return false;
  }

  size_t commit = MIN2(preferred_bytes, uncommitted);
  bool result = virtual_space()->expand_by(commit, false);
  ...
  return result;
}
```

先算未提交区(:472-474),不够直接失败;够则 `virtual_space()->expand_by(commit)`(:478)——**09-02 的 VirtualSpace 按段提交**。之后 `get_chunk_vs`(:494)→ `take_from_committed`(:369)从已提交区切出 chunk(需要时先切 padding chunk,对齐填充)。

## 2. 归还链: retire → purge → release

流传的"Node retire = uncommit + release 还给 OS"把三步压成一步了——真实链路是**三步,各有各的时机**:

### 第一步: retire —— 切碎归还

`VirtualSpaceNode::retire`(virtualSpaceNode.cpp:560-583)的触发时机是**当前 Node 空间用尽、要换新 Node 时**: `VirtualSpaceList::retire_current_virtual_space`(virtualSpaceList.cpp:141-147)在 create_new_virtual_space 前调它(:298-300 注释 "retire current node")。它把 Node 剩余的空闲区**从大到小切成标准 chunk,全部还给 ChunkManager**(从 Medium 到 Specialized 逐级,:564-578),结束时断言 `free_words_in_vs() == 0`(:582)——Node 里再没有空闲区。注意 retire **不碰虚拟内存**: 它只是把"剩余空间"变成"ChunkManager 手里的 chunk"。

### 第二步: purge —— 空 Node 摘除

`VirtualSpaceList::purge`(virtualSpaceList.cpp:74-125,**必须在 safepoint**,:75)遍历 Node 链表,把 **container_count()==0(没有任何 chunk 在库)且不是当前 Node** 的节点(:91)从链表摘除(:99-106),调 `Node::purge`——把 Node 里残留的 free chunk 从 ChunkManager 摘除(:75-88,remove_chunk+remove_sentinel)——然后 `delete vsl`(:109)。

### 第三步: release —— 还给 OS

`delete vsl` 触发析构(~VirtualSpaceNode,virtualSpaceNode.cpp:282-291): **`_rs.release()`(:283)**——09-02 讲过的 ReservedSpace::release(算回 noaccess prefix,munmap 整个区域)。到这一步,虚拟地址才真正还给 OS。

### 触发时机: CLD 卸载的 safepoint

整条链的扳机在 `ClassLoaderDataGraph::purge`(classLoaderData.cpp:1455-1472,截取核心,逐字):

```cpp
// classLoaderData.cpp:1455-1473(截取核心,逐字)
void ClassLoaderDataGraph::purge() {
  assert(SafepointSynchronize::is_at_safepoint(), "must be at safepoint!");
  ClassLoaderData* list = _unloading;
  _unloading = NULL;
  ClassLoaderData* next = list;
  bool classes_unloaded = false;
  while (next != NULL) {
    ClassLoaderData* purge_me = next;
    next = purge_me->next();
    delete purge_me;
    classes_unloaded = true;
  }
  if (classes_unloaded) {
    Metaspace::purge();
    set_metaspace_oom(false);
  }
}
```

safepoint 里 delete 死 CLD(:1466)→ 有卸载就 `Metaspace::purge()`(:1470)→ 两个空间的 VirtualSpaceList::purge(metaspace.cpp:1478-1487)——于是空 Node 被批量回收。**"等下次 GC 的 safepoint 批量 retire"的说法,准确说是"批量 purge"——retire 早已在归还时发生。**

**关键设计 (斜体)**: *三步归还把"释放"的决策点分开: retire 在归还现场把空间变成可复用 chunk(立即);purge 在 safepoint 检查"整个 Node 空了吗"(批量);release 在析构把地址还给 OS(最后)。每步都只做自己该做的,而"safepoint 才 purge"保证了链表操作不被并发打扰。*

## 3. 回收全景

把 10 域前两篇拼起来,一条 ClassLoader 的元数据一生是:

1. **分配**: Metaspace::allocate → ClassLoaderMetaspace → SpaceManager 当前 chunk bump;chunk 不够 → ChunkManager free list;缓存空 → VirtualSpaceList::get_new_chunk → 当前 Node 已提交区切;提交区不够 → expand_by commit 新页;Node 空间用尽 → 新 mmap;
2. **回收**: CLD 卸载(07-05 的 do_unloading)→ SpaceManager 的 chunk 整组归还 ChunkManager(retire 把 Node 剩余切碎)→ 下一次 safepoint 的 ClassLoaderDataGraph::purge 检查空 Node → 摘除 → munmap。

Metaspace 与 PermGen 的本质差别在这里落地: **回收跟着 ClassLoader 走,不欠 Full GC 的账**。

## 4. CDS: 跨进程共享的类元数据

最后一个话题,概要带过(细节在 11 域): **CDS(Class Data Sharing)**让多 JVM 进程共享同一份核心类元数据。dump 阶段(`MetaspaceShared::preload_and_dump`,metaspaceShared.cpp:1632)把启动时加载的核心类序列化进 archive;load 阶段(`initialize_shared_spaces`,:2100 → `map_shared_spaces`,:2034)把 archive **mmap 进预保留的共享地址**——这些类跳过 ClassFileParser 的解析(07-01 讲过: 解析器是慢路径,archive 是快路径,`shared objects file`)。`MAP_SHARED` 让多进程共享同一物理页,读时共享、redefine 时 COW。

## 核心悬念

10 域收官: 归还链三步到齐——retire 在归还现场把剩余区切碎给 ChunkManager、purge 在 safepoint 批量摘除空 Node、release 在析构把虚拟地址还给 OS,扳机是 CLD 卸载的 ClassLoaderDataGraph::purge;Metaspace 的回收完全跟着 ClassLoader 走。CDS 用 mmap 共享让 1000+ 核心类跨进程秒加载——archive 怎么生成、怎么校验、怎么映射到预保留地址,那是域 11 CDS 的事。

> → 域 11 CDS(第 5 批)
