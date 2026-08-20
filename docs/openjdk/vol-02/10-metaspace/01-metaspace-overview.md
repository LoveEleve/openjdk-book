# 01. Metaspace 全景：类元数据为什么搬出堆，还依然离不开 GC

> 前置阅读：[02-VirtualSpace：为什么 HotSpot 总把“占坑”和“付款”分开](../09-memory-core/02-virtualspace.md)
> 相关篇章：[01-Universe + Heap：VM 启动时先搭什么台子](../09-memory-core/01-universe-heap.md)、[01-ClassFileParser：为什么 parser 要先接管半成品元数据](../07-classfile-classloader/01-classfile-parser.md)、[02-Klass 层次：`Klass*` 为什么是统一类型入口](../06-oops/02-klass-hierarchy.md)
> 版本边界：`OpenJDK 11u / HotSpot / Linux / x86_64`

## 这篇真正要回答的问题

上一章讲完 Arena、ResourceArea 与 `AllocateHeap` 之后，马上会遇到一个更尖锐的问题：`InstanceKlass`、`Method`、`ConstantPool`、`ConstMethod` 这些真正跟“类”一起活很久的元数据，本来就不适合放进按作用域整批回收的 Arena；可它们为什么也不继续住在 Java heap 里，而要专门搬进一个叫 Metaspace 的 native memory 世界？

如果只记一句“Java 8 把 PermGen 改成了 Metaspace”，这件事几乎等于没理解。真正的困惑至少有两个。第一，**类元数据搬出堆，解决的到底是容量问题，还是生命周期问题？** 第二，**既然它已经在 native memory 里了，为什么分配失败时 HotSpot 还要去触发一次 GC？**

这篇文章要收拢的主线就是：**Metaspace 不只是把类元数据挪到堆外，而是把它们的释放边界从“跟着整个 Java heap 回收”改成了“跟着 ClassLoaderData 成批生灭”；而 GC 之所以还要参与，不是因为元数据又搬回了堆里，而是因为只有 GC/safepoint 才能证明哪个 class loader 已经死了，可以整批归还它那一仓元数据。**

## 如果只把 PermGen “调大一点”，为什么问题并没有解决

先从最朴素的方案推起。

第一种方案，是继续把类元数据留在 heap 里，只是把 PermGen 调大。这个方案最直觉，也最像很多线上事故的第一反应：`OutOfMemoryError: PermGen space`，那就把 `-XX:MaxPermSize` 再拧大一点。但它没有碰到问题根部。类元数据和普通 Java 对象继续抢同一块预算，你给 PermGen 多一点，heap 就少一点；你给 heap 多一点，类元数据就更容易顶满。动态代理、反射生成类、容器热部署这类场景最麻烦，因为你在部署前根本不知道这轮运行会生出多少类。

第二种方案，是把元数据挪到 native memory，但仍然做成一个全局大池。这样确实缓解了“和 Java heap 抢预算”的问题，却没有解决释放边界的问题。类元数据不是“谁都能单独 free 的小对象集合”，而是天然按 class loader 成批相关联：一个 loader 活着，它定义的 `Klass`、`Method`、常量池、注解元数据就都得跟着活；一个 loader 死了，它那整套仓库最好能一次性归还。如果只有一个全局大池，你仍然要回答“哪些 metadata 还能留，哪些已经可以清”的问题，最后还是会被对象所有权和回收边界拖住。

第三种方案，是既然已经是 native memory，那就彻底和 GC 脱钩。这个想法也很诱人：堆归 GC 管，metaspace 归自己管，各过各的。但类卸载不是一个纯粹的 native 内存问题，而是一个可达性证明问题。HotSpot 只有在 safepoint/GC 这样的全局一致时刻，才能确认某个 `ClassLoaderData` 再也不会被 Java 世界引用，然后才敢把它整仓 metaspace 交还出去。所以“native memory”只意味着元数据的物理住址不在 Java heap；它并不意味着 HotSpot 可以绕开 GC 直接拍板哪些类该死。

这三个失败方案推到最后，会逼出两个设计要求。第一，元数据的物理存储要从 Java heap 预算中独立出来。第二，元数据的释放边界不能按单个对象，而要按 `ClassLoaderData` 这种更高层的拥有者来切。Metaspace 就是沿着这两个要求长出来的。

## Metaspace 的关键变化，不是地址，而是所有权边界

从 VM 启动顺序就能看出 Metaspace 在体系里的位置。`universe_init()` 过程中会调用 `Metaspace::global_initialize()`，见 `share/memory/universe.cpp:694`。也就是说，在类真正大规模装载之前，HotSpot 就先把这块“类元数据的地盘”搭起来了。

但如果顺着源码再往前走，你会发现 Metaspace 真正要守住的不是一个“大池子”，而是一套分层的所有权链。分配入口是 `Metaspace::allocate()`；它先把这次请求按 `MetaspaceObj::Type` 分成 `ClassType` 或 `NonClassType`，再把请求交给当前 `ClassLoaderData` 持有的 `ClassLoaderMetaspace`，见 `share/memory/metaspace.cpp:1366`。这一步已经把“谁来拥有这块元数据”写进了路径本身：不是全局 Metaspace 直接塞你一块，而是“你这个 class loader 名下的 metaspace”给你分。

这个边界变化非常重要，因为它解释了为什么 Metaspace 不是“堆外版 PermGen”。PermGen 的主要困境之一，是类元数据住在与普通对象同一个大回收体系里；Metaspace 则把元数据的物理存储放到 native memory，把逻辑所有权挂到 `ClassLoaderData`。这样一来，回收时真正的动作就不再是“在 heap 里把一堆 metadata 对象逐个清掉”，而是“如果某个 loader 已死，把它名下那批 chunks 整批归还”。

所以记住这一节最重要的一句话：**native memory 解决的是容量与地址空间；`ClassLoaderData` 分仓解决的是生命周期边界。** 这两个动作缺一不可。

## `Metaspace::allocate`：为什么明明是 native memory，失败时还要去找 GC

理解 Metaspace 最容易卡住的地方，就是 `Metaspace::allocate()` 失败后的那次 GC。先看它的主流程。

`Metaspace::allocate()` 先根据 `MetaspaceObj::Type` 选择 `ClassType` 或 `NonClassType`，见 `share/memory/metaspace.cpp:1379`；然后调用 `loader_data->metaspace_non_null()->allocate(word_size, mdtype)`，见 `share/memory/metaspace.cpp:1382`。如果这一层已经拿到空间，最后还会把结果按 word 全部清零，见 `share/memory/metaspace.cpp:1410`。也就是说，对调用方来说，Metaspace 的最表层承诺很像普通分配器：给定大小和类型，尽量给你一块已清零的 metadata 空间。

真正关键在失败路径。`ClassLoaderMetaspace` 分配不到时，`Metaspace::allocate()` 不会立刻报 OOM，而是转头去调用 `Universe::heap()->satisfy_failed_metadata_allocation(...)`，见 `share/memory/metaspace.cpp:1387` 到 `share/memory/metaspace.cpp:1392`。这一步经常被误解成“metaspace 还是在依赖 Java heap”。其实不是。HotSpot 借的不是 heap 空间本身，而是 heap 那边那套“发起一次全局回收、顺带做 class unloading”的能力。

`CollectedHeap::satisfy_failed_metadata_allocation()` 的实现把这件事写得很直白。它会先重试一次当前 loader 的 metaspace 分配；还不行，就构造一个 `VM_CollectForMetadataAllocation`，原因码明确就是 `GCCause::_metadata_GC_threshold`，然后让 `VMThread::execute(&op)` 跑一次 VM operation，见 `share/gc/shared/collectedHeap.cpp:257` 到 `share/gc/shared/collectedHeap.cpp:311`。换句话说，**这次 GC 的目的不是“从 Java heap 挤点字节给 metaspace”，而是“创造一个安全时机，看看能不能卸掉一批 class loader，把它们的 metadata 整批归还，同时避免过早继续扩张 metaspace”。**

这一点在 `Metaspace::allocate()` 自己的注释里也有侧证：失败后去 GC 是为了 “prevent premature expansion of the metaspace”，见 `share/memory/metaspace.cpp:1389` 到 `share/memory/metaspace.cpp:1391`。也就是说，HotSpot 先试着回收死掉的拥有者，再考虑继续扩大 native 领地。只有这两条路都走不通，最后才会抛 `OutOfMemoryError: Metaspace` 或 `Compressed class space`，见 `share/memory/metaspace.cpp:1396` 到 `share/memory/metaspace.cpp:1458`。

所以这条失败路径回答了全文第二个大问题：**GC 参与 metaspace，不是因为 metadata 在 heap 里，而是因为 class unloading 的判定必须借一次全局一致时刻完成。**

## `ClassLoaderMetaspace`：真正的拥有者为什么是 `ClassLoaderData`

再往下一层，Metaspace 的真正“分仓”结构是 `ClassLoaderMetaspace`。这个类在 `share/memory/metaspace.hpp:237` 定义，名字已经把它的归属说得很直白：它管理的是“某个 class loader 那一部分 metaspace”。

它内部最关键的不是一个指针，而是两个 `SpaceManager`：`_vsm` 和 `_class_vsm`，见 `share/memory/metaspace.hpp:260` 到 `share/memory/metaspace.hpp:267`。前者负责 non-class metadata，后者负责 class metadata。`get_space_manager()` 会按 `mdtype == ClassType ? class_vsm() : vsm()` 分流。也就是说，即便在同一个 class loader 名下，`Klass` 这类 class metadata 与 `Method`、`ConstantPool` 这类 non-class metadata 也不是混在一条执行链里分配的。

这层分仓为什么重要？因为它把“哪个 loader 拥有这批元数据”变成了一个结构性事实。你不是在一个全局表里给 metadata 打标签说“这块可能属于 A”；你是一开始就把 A 的 metadata 放进 A 的 `ClassLoaderMetaspace`。这样 class unloading 到来时，HotSpot 处理的自然就不是“一堆散落在全局池里的 metadata 对象”，而是“某个 CLD 名下整个 metaspace 仓库”。

到这里可以先记一个路标：**Metaspace 的核心不是一个全局 allocator，而是一组 per-CLD allocator。** 后面的 `SpaceManager`、`ChunkManager`、`VirtualSpaceList` 都是在为这条所有权链服务。

## `SpaceManager`：JDK 11u 真正的执行层，不是 `MetaspaceArena`

很多资料会把 metaspace 的执行层写成 `MetaspaceArena`。这个说法放到新版本也许还能勉强沟通，但在 OpenJDK 11u 里，真正工作的名字不是它，而是 `SpaceManager`。这一点如果不先纠正，整篇文章后面都会被错误术语带偏。

`SpaceManager::allocate()` 先把用户请求调到符合 metaspace 对齐与最小块要求的 `raw_word_size`，见 `share/memory/metaspace/spaceManager.hpp:208` 到 `share/memory/metaspace/spaceManager.hpp:219` 和 `share/memory/metaspace/spaceManager.cpp:401` 到 `share/memory/metaspace/spaceManager.cpp:403`。然后它先看 per-manager 的 `BlockFreelist`：如果这个 freelist 已经够“胖”，就尝试从回收的小块里直接拿一块，见 `share/memory/metaspace/spaceManager.cpp:404` 到 `share/memory/metaspace/spaceManager.cpp:421`。拿不到，才进入 `allocate_work()`。

`allocate_work()` 的骨架就更清楚了：先试当前 chunk 的 bump allocate，也就是 `current_chunk()->allocate(word_size)`；当前 chunk 放不下，才调用 `grow_and_allocate()`，见 `share/memory/metaspace/spaceManager.cpp:429` 到 `share/memory/metaspace/spaceManager.cpp:449`。这条路径和 Arena 那一篇有一点神似：快路径靠当前块内推进指针，慢路径才去扩张后备存储。但 metaspace 和 Arena 的语义完全不同。Arena 面向的是“短命对象整批丢弃”；`SpaceManager` 面向的是“跟着一个 class loader 活很久的 metadata”，所以它还要考虑 chunk 复用、小块回收、不同规格 chunk 的切换。

`grow_and_allocate()` 里有一个很值得写出来的细节：如果新拿到的是 humongous chunk，而且当前已经有一个正常 current chunk，它通常不会把这个 humongous chunk 设成新的 current chunk，见 `share/memory/metaspace/spaceManager.cpp:203` 到 `share/memory/metaspace/spaceManager.cpp:212`。原因很直接：超大 chunk 往往只是为了这一次超大分配准备的，如果把它抢成 current，反而会过早退休一块原本还很好用的常规 chunk。这个判断能让读者看到 metaspace 的执行层并不是“有空间就塞”，而是在尽量保护后续普通分配的局部性。

还有一个容易被忽略但很关键的动作，是 `retire_current_chunk()`。当前 chunk 退休时，如果尾部还剩下一段不小于 `SmallBlocks::small_block_min_size()` 的空余，它会把这段余料切出来，回收到 per-manager freelist，见 `share/memory/metaspace/spaceManager.cpp:372` 到 `share/memory/metaspace/spaceManager.cpp:380`。这说明 metaspace 的执行面并不是“chunk 内只增不减”；它允许一个 class loader 自己把退休 chunk 尾部的碎块捡回来复用。

所以如果只记结论，这一节要留下的是：**JDK 11u 的 metaspace 执行层是 `SpaceManager`，它做的事情是“当前 chunk bump + 退休尾料回收到本地 freelist + 不够再换新 chunk”，而不是后世术语里的 `MetaspaceArena`。**

## `ChunkManager` + `VirtualSpaceList`：native memory 也不是每次都重新 `mmap`

如果 `SpaceManager` 当前 chunk 不够，它会去 `get_new_chunk()`。这一层先向全局 `ChunkManager` 要 free chunk，见 `share/memory/metaspace/spaceManager.cpp:383` 到 `share/memory/metaspace/spaceManager.cpp:389`。`ChunkManager` 本身维护的是按规格分层的全局空闲 chunk 池：specialized、small、medium，以及单独的 humongous dictionary，见 `share/memory/metaspace/chunkManager.hpp:43` 到 `share/memory/metaspace/chunkManager.hpp:67`。这说明 metaspace 也和 Arena 一样，会尽量复用已归还的标准块，而不是每次都重新向 OS 申请。

如果 `ChunkManager` 里也没有合适的块，流程才继续落到 `VirtualSpaceList::get_new_chunk()`，见 `share/memory/metaspace/virtualSpaceList.hpp:104` 与 `share/memory/metaspace/virtualSpaceList.cpp:341`。这时它先问当前 `VirtualSpaceNode`：你自己还能不能切出这个 chunk？也就是 `current_virtual_space()->get_chunk_vs(chunk_word_size)`，见 `share/memory/metaspace/virtualSpaceList.cpp:343` 到 `share/memory/metaspace/virtualSpaceList.cpp:347`。当前 node 能给，就直接切；给不了，再按最小需要与偏好粒度计算这次至少该 commit 多少空间，然后 `expand_by()`，见 `share/memory/metaspace/virtualSpaceList.cpp:353` 到 `share/memory/metaspace/virtualSpaceList.cpp:365`。

`expand_by()` 又把上一章 `VirtualSpace` 的 reserve/commit 分离思想原封不动带了进来。它先尝试在当前 `VirtualSpaceNode` 上额外 commit 一段，见 `share/memory/metaspace/virtualSpaceList.cpp:289` 到 `share/memory/metaspace/virtualSpaceList.cpp:297`。只有当前 node 真的扩不动了，才 `retire_current_virtual_space()`，再 reserve 一个新的 `VirtualSpaceNode` 挂到链表尾，见 `share/memory/metaspace/virtualSpaceList.cpp:298` 到 `share/memory/metaspace/virtualSpaceList.cpp:318`。`VirtualSpaceList(size_t word_size)` 和 `VirtualSpaceList(ReservedSpace rs)` 这两个构造函数也把 class/non-class 两种起步方式区分开了，见 `share/memory/metaspace/virtualSpaceList.cpp:150` 与 `share/memory/metaspace/virtualSpaceList.cpp:164`。

这条链路说明一个常被忽略的事实：**Metaspace 虽然在 native memory 里，但它并不是“每次分配都直接 `mmap` 一把”。真正的层次是：先看当前 chunk，再看全局 free chunks，再看当前 virtual space 能不能 commit，再不行才 reserve 新的 virtual space。**

## 为什么要分 class space 与 non-class space

Metaspace 还有一个经常被说糊的结构：class space 与 non-class space。很多介绍会把它简化成“类相关的放一边，别的放另一边”。这话不算错，但还没说到为什么。

在 OpenJDK 11u 里，class space 这条线只有在 `UseCompressedClassPointers` 打开时才成立，见 `share/memory/metaspace.hpp:223` 到 `share/memory/metaspace.hpp:230`。默认的 `CompressedClassSpaceSize` 是 1G，见 `share/runtime/globals.hpp:1825`。启动时，HotSpot 会单独 reserve 这块 compressed class space，再调用 `set_narrow_klass_base_and_shift()` 计算 `narrow_klass_base` 和 `narrow_klass_shift`，见 `share/memory/metaspace.cpp:1074` 到 `share/memory/metaspace.cpp:1196` 以及 `share/memory/metaspace.cpp:1015` 到 `share/memory/metaspace.cpp:1054`。

这段逻辑真正服务的不是“分类更清楚”，而是 `narrowKlass` 的解码成本。如果 class space 和 CDS 共享空间的地址关系足够友好，HotSpot 可以把 `Universe::narrow_klass_shift` 设成 0，见 `share/memory/metaspace.cpp:1049` 到 `share/memory/metaspace.cpp:1053`。这样 decode 一个压缩 klass 指针时，路径会更简单。换句话说，**class space 独立成一个地址范围，首先是在服务 compressed class pointers 的编码/解码约束；“把 Klass 和别的 metadata 分开放”只是这个约束带来的组织结果。**

这也顺手纠正了两个误解。第一，不是所有 metadata 都在 compressed class space 里；只有 class metadata 走这条通道，普通 `Method`、`ConstantPool` 等 non-class metadata 仍走另一边。第二，class space 的存在不是 metaspace 的普遍真理，而是 `UseCompressedClassPointers` 语境下的特定结构。

## `MetaspaceSize` 不是容量上限，而是“先试一次 GC”的阈值

最后还要把 metaspace 和 GC 的关系再钉严一层。很多资料会把 `MetaspaceSize` 讲成“metaspace 初始大小”或者“高水位”。这些说法都不精确。

`globals.hpp` 里的注释写得很清楚：`MetaspaceSize` 是 “Initial threshold (in bytes) at which a garbage collection is done to reduce Metaspace usage)”，见 `share/runtime/globals.hpp:1816` 到 `share/runtime/globals.hpp:1818`。也就是说，它首先是一个**触发 GC 的阈值**。在 64 位上，这个默认值还会经过 `ScaleForWordSize(4*M)` 放大，也就是 `x * 13 / 10` 再按 heap word 对齐，见 `share/runtime/globals.hpp:40` 到 `share/runtime/globals.hpp:43`。

Metaspace 内部真正盯着这个阈值跑的是 `_capacity_until_GC`。VM 初始化期间它先被拉到 `MaxMetaspaceSize`，因为那时还不能 GC，见 `share/memory/metaspace.cpp:184` 到 `share/memory/metaspace.cpp:188`；初始化完成后再重置成 `MAX2(MetaspaceUtils::committed_bytes(), MetaspaceSize)`，见 `share/memory/metaspace.cpp:190` 到 `share/memory/metaspace.cpp:193`。后面每轮 GC 结束，`MetaspaceGC::compute_new_size()` 会根据 `MinMetaspaceFreeRatio` / `MaxMetaspaceFreeRatio` 算出新的 `_capacity_until_GC`，见 `share/memory/metaspace.cpp:235` 到 `share/memory/metaspace.cpp:299`。

这套机制最值得纠正的误解是：“Metaspace 也会 GC，所以它和 heap 一样有自己一套独立回收器。”并不是。更准确的说法是：**Metaspace 有自己的占用阈值与扩缩策略，但真正负责创造 class unloading 机会的，仍然是 heap 那边触发出来的 GC/safepoint。** Metaspace 自己管理的是 native 虚拟空间、chunk 与阈值；GC 管的是“现在是不是到了一个可以证明某些 CLD 已死的时刻”。

## 把整条链收回来

到这里，可以把整条理解链收回来了。

PermGen 的问题，从来不只是“默认值小”，而是类元数据既和 Java heap 抢预算，又没有一个足够自然的释放边界。Metaspace 的第一步，是把 metadata 的物理住址迁到 native memory，让容量与地址空间脱离 Java heap 预算；第二步，是把 ownership 绑到 `ClassLoaderData`，通过 `ClassLoaderMetaspace` 让元数据天然按 loader 分仓。分配时，请求从 `Metaspace::allocate()` 进入，先按 class / non-class 分流，再交给该 CLD 名下的 `SpaceManager`；`SpaceManager` 在当前 chunk 与本地 freelist 里消化日常请求，不够时去全局 `ChunkManager` 借 chunk，再不行才落到 `VirtualSpaceList` 的 commit / reserve 扩张链上。

GC 之所以仍然出现在这张图里，不是因为 metadata 又变回 heap 对象了，而是因为只有 GC/safepoint 才能证明哪个 class loader 已死，从而触发那一整仓 metadata 的回收。native memory 解决的是“住哪儿”；class unloading 解决的是“什么时候整批归还”；两者之间的桥，就是 metadata allocation failure 时那次带着 `_metadata_GC_threshold` 原因码的 VM operation。

## 最后把常见误解一次说清

Metaspace 不是“PermGen 挪到堆外”这么简单；它真正改变的是元数据的所有权与释放边界。native memory 也不意味着和 GC 无关；GC 仍然负责提供 class unloading 的判定时机。`MetaspaceSize` 不是当前 metaspace 的绝对上限，而是“先试一次 GC”的初始阈值，见 `share/runtime/globals.hpp:1816`。真正的绝对上限是 `MaxMetaspaceSize`，见 `share/runtime/globals.hpp:1821`。也不是所有 metadata 都在 compressed class space 里；那块空间只服务 class metadata 和压缩 klass 指针语义，见 `share/memory/metaspace.cpp:1074`。最后，OpenJDK 11u 这里真正工作的执行层名字是 `SpaceManager`，不是后续版本资料里常见的 `MetaspaceArena`。

把这些误解剥掉之后，Metaspace 全景最该留下的结论只有一句：**它不是在回答“类元数据该放哪块内存”这么窄的问题，而是在回答“类元数据该按谁的生命周期成批存在、又该由谁来宣布它们可以整批离场”。**

> → [10-metaspace/02 — Chunk/Metablock 分配](02-chunk-metablock-allocation.md)
