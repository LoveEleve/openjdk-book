# 10-metaspace/03-virtualspace-arena-reclaim 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 metaspace 里 chunk 的真实来源、VirtualSpaceNode 的扩张与退役，以及为什么归还给 OS 不是“node 用完就立刻 unmap”这么简单

## 1. 选题判断

现稿已经覆盖了 `VirtualSpaceNode`、expand、retire、purge、release，以及 CLD 卸载触发链，但叙事仍偏“后台清理步骤说明书”：一个步骤一小节，读者容易知道有三个动作，却不一定真正理解它们为什么必须拆开。

真正的读者困惑是：

**当前 metaspace node 不够用了，为什么 HotSpot 不直接新建一个 node；而当一个 node 看起来“空了”时，为什么又不立刻 `munmap` 还给 OS？`retire`、`purge`、析构 `release` 到底分别在解决什么约束？**

如果这个困惑没打穿，读者会把 metaspace 的归还链误解成“空间不够时扩、GC 时收”，看不到 chunk 复用、链表稳定性和 safepoint 约束为什么把释放拆成了多步。

## 2. 一句话顿悟

**Metaspace 的回收故意拆成三层粒度：node 内剩余 committed 空间先在现场被 `retire` 切成标准 chunk 回到 `ChunkManager`，这是“把 node 内部可复用空间先回收到 metaspace 自己手里”；只有等到 safepoint，`VirtualSpaceList::purge` 才检查“这个 node 现在是不是一个 chunk 都不背了”，并把空 node 从链表摘掉；最后 node 析构时 `ReservedSpace::release` 才真正把整段虚拟地址还给 OS。不是不能一步做完，而是一步做完会把 chunk 复用、链表并发稳定性和 OS 级回收这三种约束搅在一起。**

## 3. 总图

```text
metadata allocation needs more space
  │
  ├─ VirtualSpaceList::expand_by
  │    ├─ 先试 current node commit 更多页
  │    └─ 失败则 retire current node -> create new node
  │
  ├─ VirtualSpaceNode::retire
  │    ├─ 把 node 剩余 committed 空间切成标准 chunks
  │    └─ return_single_chunk -> ChunkManager freelists/dictionary
  │
  ├─ class unloading at safepoint
  │    └─ ClassLoaderDataGraph::purge -> Metaspace::purge
  │
  ├─ VirtualSpaceList::purge
  │    ├─ 只处理 container_count == 0 的非 current node
  │    ├─ unlink node from list
  │    └─ node->purge() 把残留 free chunks 从 ChunkManager 摘除
  │
  └─ ~VirtualSpaceNode
       └─ ReservedSpace::release -> munmap back to OS
```

## 4. 结构大纲与字数预算

### 第一节：开场事故——为什么 node 不够用时不能只会“再 mmap 一块”

目标约 1200 字。

- 从 `SpaceManager`/`ChunkManager` 都吃不到 chunk 说起
- 提出两个直觉方案：不够就直接新建 node；空了就立刻 `munmap`
- 引出真实困难：node 里还剩 committed 空间、空闲 chunk 还在全局 freelist 里、链表遍历还可能无锁进行

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：
1. 当前 node 不够时，总是直接新建 node
2. node 里一旦没有在用分配，就立刻 unmap
3. safepoint 时只看 CLD 死亡，不先清理 freelist 上的 chunk

要落出的结论：
- 不先吃完当前 node，会白白浪费 committed 空间
- 不先把 freelist 上 chunk 从 node 身上摘干净，就不能安全判断 node 真空了
- unmap 必须晚于链表摘除与 chunk 摘除

### 第三节：VirtualSpaceNode——一个 metaspace mmap 区域的现场管家

目标约 1700 字。

- `_rs` + `_virtual_space` + `_top` + `_container_count`
- `initialize()`：对齐约束、预提交 special reserved space、occupancy map
- `free_words_in_vs()` 的语义：当前 node 自己还能切多少已提交空间
- 纠偏：node 不是抽象概念，就是一块具体 reserved/committed 虚拟空间的 owner

### 第四节：expand——为什么先试 commit，再考虑换 node

目标约 1900 字。

- `VirtualSpaceNode::expand_by` 先看 uncommitted
- `VirtualSpaceList::expand_by` 先问 `MetaspaceGC::can_expand/allowed_expansion`
- 当前 node commit 成功则继续使用
- 失败时才 `retire_current_virtual_space()` 然后 `create_new_virtual_space()`
- 纠偏：metaspace 扩张优先级是 commit 当前 node > reserve 新 node

### 第五节：retire——为什么它做的是“切碎归还”，不是“还给 OS”

目标约 2200 字。

- `VirtualSpaceNode::retire` 从 Medium 到 Specialized 逐级切块
- 每块 `return_single_chunk()` 回到 `ChunkManager`
- `free_words_in_vs() == 0` 只表示 node 自己不再保留未切分空闲区
- 纠偏：retire 只把 node 内剩余 committed 空间转成 metaspace 可复用 chunk，不触碰 `ReservedSpace::release`

### 第六节：purge——为什么必须等 safepoint，且只处理非 current 的空 node

目标约 2200 字。

- `ClassLoaderDataGraph::purge()` 的触发链
- `Metaspace::purge()` -> `VirtualSpaceList::purge()`
- `container_count()==0 && vsl != current_virtual_space()` 这两个条件
- `VirtualSpaceNode::purge()` 把 node 内残留 free chunks 从 `ChunkManager` 摘除
- 解释 safepoint 的必要性：list unlink 与无锁 contains/iterate 约束

### 第七节：release——真正把地址还给 OS 的动作为什么要最后发生

目标约 1500 字。

- node 析构才会走 `ReservedSpace::release`
- 这一步才是 OS 视角的释放
- 前面的 retire/purge 都只是 metaspace 内部重整
- 纠偏：metaspace 内部“回收”与 OS 级“release”不是一回事

### 第八节：把整条来源与归还链收拢

目标约 1400 字。

- chunk 来源：current node committed -> commit more -> new node reserve
- chunk 去向：in-use -> freelist -> purge unlink -> release
- 把 10 域前三篇串起来：分配粒度、node 粒度、OS 粒度

### 第九节：误解澄清与收网

目标约 1200 字。

至少回答：
1. node 不够时是否总是直接新建 node
2. retire 是否等于 release 给 OS
3. purge 是否只是“删链表节点”
4. 当前 node 是否也会被 purge
5. 归还给 ChunkManager 与归还给 OS 是否同一件事
6. CLD 卸载后是否立刻 unmap 对应 node

## 5. 失败方案必须写进正文

1. 当前 node 不够时，总是直接新建 node
2. node 一空就立刻 `munmap`
3. safepoint 时不摘 freelist 上 chunks，只看 node 表面状态

## 6. 证据清单

- `share/memory/metaspace/virtualSpaceNode.hpp:42-149`：node 关键字段与职责
- `share/memory/metaspace/virtualSpaceNode.cpp:302-303`：`free_words_in_vs`
- `share/memory/metaspace/virtualSpaceNode.cpp:307-364`：padding chunks
- `share/memory/metaspace/virtualSpaceNode.cpp:369-463`：`take_from_committed`
- `share/memory/metaspace/virtualSpaceNode.cpp:467-531`：`expand_by` / `initialize`
- `share/memory/metaspace/virtualSpaceNode.cpp:560-583`：`retire`
- `share/memory/metaspace/virtualSpaceNode.cpp:75-89`：`purge`
- `share/memory/metaspace/virtualSpaceList.cpp:74-118`：`VirtualSpaceList::purge`
- `share/memory/metaspace/virtualSpaceList.cpp:139-148`：`retire_current_virtual_space`
- `share/memory/metaspace/virtualSpaceList.cpp:267-320`：`expand_by`
- `share/memory/metaspace/chunkManager.cpp:623-649`：`return_chunk_list`
- `share/classfile/classLoaderData.cpp:1457-1472`：`ClassLoaderDataGraph::purge`
- `share/memory/metaspace.cpp:1478-1488`：`Metaspace::purge`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇讲 metaspace 非共享区的来源与归还链；CDS 只做点到为止的过渡，不展开 archive 格式和映射细节
- class space 只支持一个 `VirtualSpace`，正文不要把 non-class 的多 node 扩张路径无差别套到 class space
- retire / purge / release 必须严格区分粒度：metaspace 内部 chunk 复用、链表摘除、OS 级地址释放
- `container_count` 的语义是 node 里还背着多少 chunk，不等于“有没有剩余 committed 空间”

## 8. 完成后 review

- 删除代码后，能否复述“先 commit 当前 node、再 retire 剩余区、safepoint purge 空 node、析构 release 给 OS”
- 是否纠正了“retire=unmap”“GC 时一把梭全还 OS”“node 用完就直接丢掉”等误解
- 是否把 chunk 复用、链表稳定性、OS 释放三种约束真正分开讲清楚
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
