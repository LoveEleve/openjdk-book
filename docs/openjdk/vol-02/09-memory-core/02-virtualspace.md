# 02. VirtualSpace：为什么 HotSpot 总把“占坑”和“付款”分开

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论。本文聚焦 `ReservedSpace` / `ReservedHeapSpace` / `VirtualSpace` 与 Linux `mmap`/`mprotect` 的对应关系，说明 HotSpot 如何把稳定地址、物理页承诺和上层对象分配严格拆层。
> **前置依赖**：[01 — Universe 与 CollectedHeap](01-universe-heap.md)：G1 `initialize()` 里 `Reserve the maximum` 的上层语义在这里展开；[01-os/02 — 虚拟内存](../01-os/02-virtual-memory.md)：reserve/commit 的 OS 概念基础；[16-code-cache/01 — CodeBlob 与 CodeHeap](../16-code-cache/01-codeblob-heap.md)：CodeCache 用的是 `CodeHeap`，这篇会专门与 `VirtualSpace` 对照
> → **后续**：[03 — Arena / ResourceArea](03-arena-resourcearea-allocation.md)
> 关联域：01-os、09-memory-core、10-metaspace、16-code-cache

## 占 32GB 的坑，为什么不等于用了 32GB 内存

把 JVM 配成：

```text
-Xmx32g
```

很多人第一反应是：启动时就“吃掉”了 32GB 内存。

但从操作系统和 HotSpot 的角度看，这里面至少有两件不同的事：

1. **占住一段稳定虚拟地址区间**——别人不能再来抢这块地址
2. **让这块区间里的某些页真正可读写**——也就是开始为它们付出物理页/内核记账成本

这就是 reserve 与 commit 的根本差别。

如果 HotSpot 不把这两件事拆开，就会立刻碰上两类相反的问题：

- 一次 commit 到底：启动时物理内存和预留开销太重
- 只 reserve 不记 committed boundary：上层 allocator 和 GC 根本不知道哪些页已经可用

而且，光把 reserve/commit 拆开还不够。JVM 还要同时处理：

- 地址必须保持稳定，压缩 oop 编码才能成立
- 某些堆模式下，需要在 heap base 前插入 noaccess prefix 做 implicit null checks 的护栏
- 普通页与大页混用时，提交粒度并不统一
- Metaspace、Java heap、CodeCache 虽然都要“先占坑后付款”，但上层管理器并不是同一个

所以本文真正的问题是：

**为什么 HotSpot 不直接“一次 commit 到底”，而要把稳定地址区间、堆专用前缀、逐步 commit/uncommit 和对象分配分成几层？`ReservedSpace`、`ReservedHeapSpace`、`VirtualSpace` 各自到底在协调哪一层边界？**

先把全篇主线画出来：

```text
Linux VM primitives
  │
  ├─ reserve : mmap(PROT_NONE, MAP_NORESERVE)
  ├─ commit  : mmap(MAP_FIXED, PROT_READ|PROT_WRITE)
  ├─ uncommit: mmap(MAP_FIXED, PROT_NONE|MAP_NORESERVE)
  └─ protect : mprotect
  │
  ├─ ReservedSpace
  │    ├─ 拿到稳定保留区间
  │    └─ 负责对齐与特殊保留策略
  │
  ├─ ReservedHeapSpace
  │    ├─ 在堆语义上叠加 compressed-oops base 规则
  │    └─ 可选 noaccess prefix 作为隐式 null 检查护栏
  │
  ├─ VirtualSpace
  │    ├─ 在同一保留区间内管理 committed waterline
  │    ├─ lower/middle/upper 三种提交粒度
  │    └─ expand_by / shrink_by 维持连续 committed 区间
  │
  └─ higher layers
       ├─ Metaspace: VirtualSpaceList / VirtualSpaceNode
       ├─ G1 heap   : ReservedHeapSpace + region mappers
       ├─ CodeCache : ReservedCodeSpace + CodeHeap
       └─ Object allocation: CollectedHeap / MemAllocator / TLAB
```

一句话先记住：

**`ReservedSpace` 解决“这段地址归我了”，`ReservedHeapSpace` 解决“堆在这段地址上还要满足压缩 oop 的额外约束”，`VirtualSpace` 解决“在已经归我的地址里，哪些页此刻真的可用”；真正的对象分配发生在更高层的 `CollectedHeap` / `MemAllocator`。**

---

## 一、三个看似更简单的方案，为什么都不够

### 1.1 一次性 commit 到底

最直觉的想法就是：

```text
JVM 既然知道最大堆 32GB
  → 启动时直接都映射成可读写
```

这当然简单，但会把最大堆的物理页承诺、页表、可能的预触页成本全压到启动时。对大堆或大页模式，这会直接把“留着以后可能会用”的地址空间变成“现在就得准备好”的资源请求。

HotSpot 想要的是：

```text
先稳定拿到整个地址区间
以后按需要一点点把它变成真正可用的页
```

### 1.2 只 reserve，不维护 committed boundary

另一个极端是：

```text
reserve 成功后就算“有了这块内存”
上层随便往里分配对象
```

这立刻会让 GC 和 allocator 失去最基本的边界信息：

- 哪些页已经 commit，可以安全写入
- 哪些页还是 `PROT_NONE`，一碰就该 fault
- 当前 committed waterline 到哪
- 扩容与缩容时哪些范围可以 OS commit/uncommit

所以 reserve 与 commit 不能只在 OS 层分开，VM 自己也必须维护 committed 的逻辑边界。

### 1.3 用同一套 `VirtualSpace` 叙事解释所有内存子系统

第三个常见误区是看到 `VirtualSpace` 就把它套到所有内存对象上：

- Java heap
- Metaspace
- CodeCache
- 甚至对象分配路径

这会把不同层次的抽象混掉。

更准确的分层是：

```text
Metaspace 直接使用经典 VirtualSpaceList/VirtualSpaceNode
G1 heap    使用 ReservedHeapSpace + region mappers/HeapRegionManager
CodeCache  使用 ReservedCodeSpace + CodeHeap
Object new 使用 CollectedHeap / MemAllocator / TLAB
```

它们确实都建立在“保留地址空间”之上，但上层管理者不是同一个。不能把 `VirtualSpace` 的“三段”拿去解释 CodeCache 的三个 `CodeHeap`，也不能把 G1 region expansion 讲成 classic `VirtualSpace::expand_by` 的直接应用。

---

## 二、ReservedSpace：先拿到稳定地址，再谈其它

### 2.1 `ReservedSpace::initialize` 的第一职责是建立“稳定的地址区间”

`ReservedSpace::initialize` 在 `virtualspace.cpp:120-232` 中的第一层约束是：

- `size` 必须按 `vm_allocation_granularity` 对齐
- `alignment` 也必须按该 granularity 对齐
- `alignment` 还必须是 2 的幂
- 最后 `alignment = MAX2(alignment, os::vm_page_size())`

这里第一件值得澄清的事是：在 Linux 上，`vm_allocation_granularity()` 就是 page size，而不是某些文章里流传的“至少 64K”。64K 只是源码注释里对“很多 OS 在大块 reserve 时通常给出更高对齐”的经验观察，不是这里的契约。

### 2.2 misaligned fallback 不是“循环重试”，而是“一次 over-reserve + trim”

`ReservedSpace::initialize` 的普通路径会乐观地假设 OS 也许已经返回足够对齐的基址。只有发现基址真的不对齐时，才：

1. 释放刚才那段 reserve
2. 把 `size` 向上对齐到 `alignment`
3. 调 `os::reserve_memory_aligned(size, alignment, fd)`

这里最常见的误解是“HotSpot 最多重试 10 次直到对齐”。那种最多 10 次的循环属于 Linux 的 **requested-address attempt path**，不是通用的 alignment fallback。

真正的通用对齐 helper `reserve_memory_aligned` 在 `os_posix.cpp:287-340` 中干的是：

```text
多 reserve 一段（size + alignment）
  → 在内部找一个对齐点
  → 释放头尾多余部分
```

也就是一次 deterministic over-reserve-and-trim，不是循环反复试运气。

### 2.3 special path 说明 reserve 有时已经隐含“全程 committed”

`ReservedSpace::initialize` 里还有 `special` 分支：当请求 large pages 且 OS 不能安全支持后续按需 commit 时，HotSpot 会走 `reserve_memory_special()`。

在这条路径上，保留与提交实际上被合并了：保留下来的大页区域被视为已经 committed/pinned。后面的 `VirtualSpace` 逻辑也会把这种空间当作 `_special`，只调整 high waterline，不再去做普通 `commit_memory()`/`uncommit_memory()` 系统调用。

这说明“先 reserve 再按需 commit”虽然是主流叙事，但不能写成绝对规律。large page / special reservation 是重要例外。

---

## 三、Linux reserve/commit/uncommit：同一地址，只切换映射状态

### 3.1 reserve：`PROT_NONE + MAP_NORESERVE`

Linux 上 reserve 的根动作不是“分到一块物理内存”，而是：

```cpp
mmap(requested_addr, bytes, PROT_NONE,
     MAP_PRIVATE | MAP_NORESERVE | MAP_ANONYMOUS, ...)
```

`PROT_NONE` 的注释特别重要：HotSpot 故意让 reserved/uncommitted 页一碰就 fault，避免某些情况下误访问“未提交但恰好被 swap/backing 容忍”的隐蔽错误。

`MAP_NORESERVE` 则意味着：这是一块近乎“免费占坑”的虚拟地址保留，不要求立刻为所有页做完整的 swap/物理记账。

### 3.2 commit：不是换地址，而是在原地址上重映射成可读写

Linux commit 的实现是再一次 `mmap`，但这次用：

```cpp
MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS
PROT_READ | PROT_WRITE [| PROT_EXEC]
```

关键是 `MAP_FIXED`：commit 发生在**同一地址区间**上。它改变的是这段地址当前的 protection/backing 状态，而不是让 JVM 重新得到另一块地址。

### 3.3 uncommit：也是在原地址上把页打回 `PROT_NONE`

Linux uncommit 同样是再一次 `mmap` 到同一地址，但把 protection 与 reserve 语义改回：

```cpp
PROT_NONE
MAP_FIXED | MAP_NORESERVE | MAP_ANONYMOUS
```

所以 reserve、commit、uncommit 不是三块不同地址的迁移，而是：

```text
同一虚拟地址区间
  在 PROT_NONE / 可读写 两种映射状态之间往返
```

这就是为什么上层可以长期记住一段稳定地址区间，只维护 committed waterline 就够了。

### 3.4 `protect_memory` 才是 `mprotect`

另一个容易混的点是把 uncommit 和 `mprotect(PROT_NONE)` 混为一谈。Linux 上 HotSpot 的 `protect_memory` 确实走 `mprotect`；但普通 uncommit 并不是单纯改 protection，它是把这一段重新映射成 `PROT_NONE + MAP_NORESERVE` 的匿名映射。

这也是为什么 reserve/commit/uncommit 的语义比“改权限”更强：它们同时在操纵 backing 和 protection。

---

## 四、ReservedHeapSpace：为什么堆要在 reserve 之上再加 noaccess prefix

### 4.1 堆在地址上还有压缩 oop 的特殊约束

普通 `ReservedSpace` 只关心“我是否拿到一段稳定且对齐的地址区间”。但堆还多一个非常 JVM-specific 的问题：压缩 oop 的编码基址和隐式空指针检查。

因此 `ReservedHeapSpace` 在 reserve 之上又叠了一层堆专用语义。

### 4.2 `compressed_oop_base()` 不是简单等于 `_base`

`ReservedHeapSpace` 暴露：

```cpp
char* compressed_oop_base() { return _base - _noaccess_prefix; }
```

也就是说，堆的“真正压缩基址”与当前可用 heap base 之间，可能隔着一段 `_noaccess_prefix`。

这条前缀的用途不是“对齐浪费”，而是：**让靠近压缩 oop base 的解引用在 null/小偏移情况下可靠 fault。**

### 4.3 noaccess prefix 的大小不是固定一页，也不是任意 leftovers

`noaccess_prefix_size(alignment)` 在 `virtualspace.cpp:297-298` 中定义为：

```text
lcm(page_size, alignment)
```

所以它不是固定 4KB / 64KB，也不是“多余前缀恰好剩多少就用多少”。它是按页大小与对齐要求算出的最小公倍数。

### 4.4 它只在 compressed oops 的某些摆放模式下出现

这条 prefix 不是任何 `ReservedHeapSpace` 都有。真正触发 `establish_noaccess_prefix()` 的是那些 non-zero compressed-oop base / disjoint 模式，也就是堆布局与 `OopEncodingHeapMax` 关系要求 VM 在 heap base 前保留一段受保护区域。

如果平台或配置条件不允许利用这段保护区做 implicit null checks，HotSpot 还会显式关闭 `Universe::narrow_oop_use_implicit_null_checks()`。

所以必须收紧一句话：**noaccess prefix 是压缩 oop 与隐式空指针检查的护栏，不是普通 reserve/heap 初始化的通用前缀。**

---

## 五、VirtualSpace：三段不是用途，而是提交粒度

### 5.1 `VirtualSpace` 只做一件事：在已 reserve 的区间上逐步 commit/uncommit

类注释已经把 `VirtualSpace` 定位得很清楚：

```text
committing a previously reserved address range in smaller chunks
```

它不是“管理一整块堆的逻辑用途布局”，也不是“对象分配器”。它负责的是：

```text
给定一段已经保留好的地址
  → 哪些前缀页目前 committed
  → 现在要不要继续向前扩 committed waterline
  → 现在要不要从尾部回收 committed waterline
```

### 5.2 lower / middle / upper 三段是 commit granularity zones

`initialize_with_granularity()` 里：

- lower 和 upper 对齐是 `vm_page_size()`
- middle 对齐是 `max_commit_granularity`

边界则由“起点向上对齐到 middle 粒度”和“终点向下对齐到 middle 粒度”决定。

这说明三段的本质是：

```text
两头的普通页碎边
  +
中间大页粒度主体
```

它们不是：

- eden / old / survivor
- profiled / non-profiled / non-method
- object / metadata / code

所以把 “VirtualSpace 三段” 写成“用途分区”是完全错位的。

### 5.3 committed 区间必须从低地址开始连续生长

`actual_committed_size()` 的断言已经把这个隐含协议写死了：

- 如果 upper 有 committed，lower 和 middle 必须都完整提交到边界
- 如果 middle 只提交了一部分，upper 必须为 0
- 如果 lower 还没满，中间和上段都不能有 committed

这说明 `VirtualSpace` 不允许从中间打洞。它维护的是：

```text
从 low_boundary 开始的一段连续 committed 前缀
```

### 5.4 `expand_by` / `shrink_by` 的顺序正是为这条连续性服务

`expand_by()` 提交顺序是：

```text
lower -> middle -> upper
```

`shrink_by()` 回收顺序则是：

```text
upper -> middle -> lower
```

这让 committed 区间始终保持为一段从低地址往高地址推进/回退的连续区间，而不是在中间挖洞。

对大页来说，这也避免了把本来可整体提交的大页区域切碎。

### 5.5 `special` 路径只是移动水位线，不做普通 commit/uncommit 系统调用

对 special reservation，`VirtualSpace` 的 expand/shrink 只是调整 `_high` 或对应 high-water marks，不会走常规 `commit_memory()` / `uncommit_memory()`。因为对这种空间来说，地址区间在 reserve 时就已经被整体 pinned/committed 了。

这再次提醒：**reserve/commit 分离是主流模型，但不是所有 reservation 模式都按需 commit。**

---

## 六、谁真正用 VirtualSpace，谁没有用

### 6.1 Metaspace 是 classic `VirtualSpace` 的直接用户

这是最清楚的一类：`VirtualSpaceList` / `VirtualSpaceNode` 直接把 `ReservedSpace` 和 `VirtualSpace` 嵌在一起，用来管理 metaspace 增长。

也就是说，Metaspace 的这层叙事几乎可以直接套用本文的 reserve -> commit 框架。

### 6.2 G1 heap 不是 classic `VirtualSpace` 的直接用户

G1 的堆初始化虽然首先通过 `Universe::reserve_heap()` 拿到 `ReservedSpace`，但后续 heap expansion/commit 不是通过 classic `VirtualSpace::expand_by` 来做，而是交给：

- `G1RegionToSpaceMapper`
- `HeapRegionManager`

来按 region 粒度管理。

换句话说，G1 当然也依赖 reserve/commit 语义，但它的上层管理器已经不是 `VirtualSpace` 这套 API，而是 region/mappers 世界。

### 6.3 CodeCache 也不是 VirtualSpace 三段

CodeCache 初始化路径里：

- 先 reserve `ReservedCodeSpace`
- 再切成三块 `ReservedSpace`
- 分别喂给三个 `CodeHeap`

所以 CodeCache 的“三块”是三个 `CodeHeap` 实例，不是一个 `VirtualSpace` 的 lower/middle/upper 三段。把这两套“三分法”混在一起，是这一篇最需要避免的误导之一。

### 6.4 `MemRegion` 只是区间身份证，不是分配/提交器

`MemRegion` 只有：

- `HeapWord* _start`
- `size_t _word_size`

它是轻量区间描述对象，按值传递，负责表达“这段地址是哪一段”。它既不是 reserve manager，也不是 commit manager，更不是某种 heap/region 的父类抽象。

所以不要把 `MemRegion`、`VirtualSpace`、`CodeHeap`、`HeapRegionManager` 混作“内存块管理器”的同类项。

---

## 七、对象分配在更高层：为什么 reserve/commit 不是 `new Object()`

### 7.1 `CollectedHeap` 只在更高一层消费 committed heap

`CollectedHeap` 暴露的核心接口包括：

- `allocate_new_tlab`
- `mem_allocate`
- `collect`
- `object_iterate`

这说明它关心的是：

```text
线程本地分配缓冲
单对象分配
GC 动作
对象遍历
```

而不是地址空间 reserve/commit 细节本身。

### 7.2 TLAB miss 不一定会 refill 一个新 TLAB

`MemAllocator::allocate_inside_tlab_slow()` 很明确：如果当前 TLAB 剩余空间比 `refill_waste_limit()` 还大，就保留这个 TLAB，直接返回 `NULL`，让调用方走 outside-TLAB 分配。

所以“TLAB miss 就换一个新 TLAB”太粗。真实路径是：

```text
TLAB fast path miss
  → 先看保留剩余空间是否更划算
  → 不划算才真正申请新 TLAB
  → 否则直接 outside-TLAB
```

### 7.3 `MemAllocator::finish()` 说明对象发布顺序和 reserve/commit 已经是两层问题

对象真正变成“可被并发世界看见”的时刻，在 `finish()`：

- 先填 mark / body
- 再发布 `Klass*`

这说明对象分配路径的关注点已经完全是对象头、并发可见性和 GC 解析顺序，而不是 reserve/commit 本身。reserve/commit 只是让这块地址可用，真正把它变成对象，是更高层 allocator 协议的工作。

### 7.4 `oopFactory` 是 convenience layer，不是底层 heap allocator

`oopFactory` 负责：

- 找对 `Klass`
- 调相应 `allocate()` / `new_objArray()` 之类入口

但它并不决定：

- 走 TLAB 还是 outside-TLAB
- 何时触发 collector `mem_allocate`
- 如何初始化对象头

因此不能把 `oopFactory` 误写成“JVM 分配对象的底层实现”。

---

## 八、误解澄清：八个最容易写过头的判断

1. **Linux 上 granularity 是否固定 64K？** 不是。OpenJDK 11u 在 Linux 上的 `vm_allocation_granularity` 就是 page size。
2. **`reserve_memory_aligned` 是否循环重试直到对齐？** 不是。它走一次 over-reserve + trim；循环重试属于别的 exact-address 路径。
3. **noaccess prefix 是否总存在，或只是对齐出来的浪费空间？** 都不是。它只在某些 compressed-oops 布局下出现，语义是隐式空指针检查护栏。
4. **commit/uncommit 是否会改变地址？** 不会。它们在同一地址区间上切换 backing/protection 状态。
5. **VirtualSpace 三段是否代表三种用途分区？** 不是。它们代表三种 commit granularity 区域。
6. **G1 heap 是否通过 classic `VirtualSpace` 扩容？** 不是直接这样讲。G1 走 `ReservedHeapSpace` + region mappers / `HeapRegionManager`。
7. **CodeCache 是否也用 `VirtualSpace` 三段？** 不是。CodeCache 用 `ReservedCodeSpace` 切成多个 `CodeHeap`。
8. **TLAB miss 是否必然申请新 TLAB？** 不是。剩余空间过大时，会保留当前 TLAB，直接 outside-TLAB。

---

## 九、收网：VirtualSpace 的本质，是把“稳定地址”和“可用页”分离

回到开头的问题：为什么 HotSpot 总把“占坑”和“付款”分开？

因为 JVM 需要同时满足几件看似冲突的事：

```text
地址要稳定
物理页承诺要渐进
压缩 oop 还要满足基址/护栏要求
不同子系统又不共享同一个上层管理器
```

所以它把问题拆成三层：

```text
ReservedSpace
  → 我先拿到这段地址

ReservedHeapSpace
  → 这段地址如果拿来当堆，还要满足 compressed-oops/null-check 规则

VirtualSpace
  → 在已经拿到的地址里，我怎样逐步 commit/uncommit，而不打洞
```

三句话收束全文：

- **reserve/commit 的分离，让 HotSpot 可以先稳定拥有一段地址，再按需要逐步支付物理页成本。**
- **`ReservedHeapSpace` 和 noaccess prefix 说明 heap 在地址空间层面还有自己的压缩 oop 语义，不能简单等同于普通 reserve 区间。**
- **经典 `VirtualSpace` 是 Metaspace 的直接工具，但 Java heap 和 CodeCache 只是共享底层 reserve/commit 思想，不共享同一个上层管理器。**

下一篇从“地址空间层”往上切回“VM 自己的 C++ 对象如何分配”：Arena 与 ResourceArea 如何用 chunk + 栈式生命周期取代通用 malloc/free。

> → [03 — Arena / ResourceArea](03-arena-resourcearea-allocation.md)
