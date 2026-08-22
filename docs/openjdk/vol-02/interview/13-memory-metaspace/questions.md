# 13 · 内存分配、Metaspace 与 CDS 内存模型：深度题目

## 1. JVM 为什么要先造“地基”，再造第一个 Java 对象？

在第一条 Java 字节码执行之前，JVM 已经需要 heap、well-known klass、primitive mirrors、符号表和一批 canonical 对象。为什么 HotSpot 必须把 `create_heap`、`genesis`、`javaClasses_init`、`universe_post_init` 拆成多段，而不是一次性全部造完？

回答必须覆盖：

- heap substrate、类宇宙、镜像和普通对象分配协议的依赖顺序；
- `Universe::create_heap` 与 `CollectedHeap::initialize` 解决的不是同一层问题；
- minimal class universe 与 fully initialized Java world 的区别；
- 为什么启动期很多“对象一样的东西”其实是 metadata 或 sentinel，而不是普通 Java heap 对象；
- 启动顺序如何避免循环依赖与半初始化对象泄露。

追问：如果把 primitive mirrors、well-known klass、空 `Class[]`、OOME 预分配都归到同一阶段，会在哪个依赖点先打结？

源码入口：`share/memory/universe.cpp:694`、`share/memory/universe.cpp:760`、`share/memory/universe.cpp:860`、`share/memory/universe.cpp:1013`。

## 2. 为什么 VirtualSpace 一定要把“占坑”和“付款”分开？

HotSpot 明明可以在需要内存时直接 `mmap` 一块可用空间，为什么还要先 reserve 大片地址，再按需 commit？这套模式解决的核心矛盾是什么？

回答必须覆盖：

- 地址连续性、对齐、扩张方向和后续子分配器的稳定预期；
- reserve/commit 与物理页消耗、虚拟地址消耗的区别；
- 为什么某些子系统更在意“地址先固定”，而不是“字节先到手”；
- 当前 node 扩张失败后为什么可能 retire 再建新 node；
- CDS/class space/CodeCache/Metaspace 与普通 Arena 在地址策略上的共同点与差别。

追问：如果 VirtualSpace 每次都现取现用，会先坏在地址碎片、固定基址假设，还是共享/压缩指针语义？

源码入口：`share/memory/virtualspace.cpp:255`、`share/memory/virtualspace.cpp:844`、`share/memory/metaspace/virtualSpaceList.cpp:289`。

## 3. Arena 为什么不是“VM 版 malloc 封装”？

Arena/ResourceArea 为什么要用 chunk + bump pointer + 作用域整体回收，而不是对每个小对象调用一次 `AllocateHeap`？

回答必须覆盖：

- 短命对象与长期元数据的生命周期差异；
- Arena 的快路径为什么几乎不需要每对象释放；
- `ResourceMark`/作用域结束回收如何替代细粒度 free；
- 为什么 Arena 适合 parser、编译器和临时结构，却不适合 `InstanceKlass`、`Method`、`ConstantPool` 这类随 loader 长寿的对象；
- Arena chunk 最终仍来自 OS/native 分配，这与 NMT/NMT 报告如何对应。

追问：如果把 Metaspace 直接改成 Arena，每个类加载器卸载时会在哪个维度丢失信息？如果 parser 把半成品元数据都直接放 Metaspace，又会在哪个失败路径变得很难回滚？

源码入口：`share/memory/allocation.hpp:511`、`share/memory/resourceArea.hpp:39`、`share/memory/arena.cpp:132`。

## 4. Metaspace 解决的核心到底是“堆外扩容”，还是“按 ClassLoaderData 分仓”？

很多介绍把 Metaspace 简化成“PermGen 搬到堆外”。这个说法为什么不够？它真正改变的核心边界是什么？

回答必须覆盖：

- native memory 解决容量与地址空间压力；
- `ClassLoaderData`/`ClassLoaderMetaspace` 解决生命周期边界；
- `Metaspace::allocate` 为什么按 class/non-class 分流；
- `ClassLoaderMetaspace`、`SpaceManager`、`ChunkManager`、`VirtualSpaceList` 的层次关系；
- 为什么“元数据住在 native memory”仍然不能绕开 GC/safepoint 决定卸载时机。

追问：如果只是把 PermGen 调大，为什么动态代理/热部署问题仍然存在？如果做成全局 native 大池而不按 CLD 分仓，又会在哪一步失去整批回收能力？

源码入口：`share/memory/metaspace.cpp:1366`、`share/memory/metaspace.hpp:237`、`share/memory/metaspace/spaceManager.cpp:401`、`share/memory/metaspace/chunkManager.hpp:43`。

## 5. 为什么 Metaspace 分配失败时要去找 GC？

既然 Metaspace 已经在 native memory 里，为什么 `Metaspace::allocate` 失败后不只是继续扩 native 空间，而是要触发一次以 `_metadata_GC_threshold` 为原因码的 GC/VM operation？

回答必须覆盖：

- “native memory 不在 Java heap”与“类卸载判定仍依赖全局可达性”不是矛盾；
- `satisfy_failed_metadata_allocation` 借的是 GC 的一致性时机，不是 Java heap 字节本身；
- class unloading 为什么必须在 safepoint/GC 这样的全局一致窗口确认；
- `MetaspaceSize` 与 `MaxMetaspaceSize` 的含义区别；
- 为什么 tracking threshold 和真正绝对上限不是同一个参数。

追问：如果 Metaspace allocation failure 时永远只扩 native 空间，不先试 GC，会失去哪种控制能力？如果运行时允许把 tracking level 从 summary 升到 detail，为什么 Metaspace 却不能在同样的“以后再说”思路下补历史卸载判断？

源码入口：`share/memory/metaspace.cpp:1387`、`share/gc/shared/collectedHeap.cpp:257`、`share/runtime/globals.hpp:1816`、`share/runtime/globals.hpp:1821`。

## 6. CompressedOops/CompressedClassPointers 为什么本质上是“地址编码协议”，不是“省内存开关”？

为什么压缩普通对象指针和压缩类指针都严重依赖地址范围、base、shift 和独立 class space？它们首先在解决什么问题？

回答必须覆盖：

- narrowOop/narrowKlass 的 decode 公式和对齐前提；
- class space 单独 reserve 的意义；
- CDS/shared space 与 `narrow_klass_base` 的关系；
- 为什么 class metadata 与 non-class metadata 不能随意混放；
- 地址不满足约束时为什么不是“多做几次位运算”就完事，而可能直接改变布局与可共享假设。

追问：如果 class space 不独立，而是和普通 metadata 混杂增长，会先破坏编码简化、共享映射，还是 decode 成本与范围判断？

源码入口：`share/memory/metaspace.cpp:1015`、`share/memory/metaspace.cpp:1074`、`share/runtime/globals.hpp:1825`、`share/oops/klass.hpp:54`。

## 7. CDS 的内存模型为什么和 Metaspace/VirtualSpace 是同一种哲学，而不是另一套系统？

CDS 看起来在写归档文件，Metaspace/VirtualSpace 看起来在做内存管理。为什么它们本质上都在围绕“地址先稳定、语义后接线”的同一种思路？

回答必须覆盖：

- dump 端为什么先 freeze，再 compact，再写 `rw/ro/mc/md`；
- load 端为什么要求同址映射与后续接线；
- 为什么 shared archive 不是对象序列化，而是页属性明确的内存镜像；
- CDS 与 compressed klass base/class space 的相互约束；
- 哪些状态能被固化进镜像，哪些状态必须在当前进程恢复。

追问：如果把 CDS 改成普通对象序列化文件，它与 Metaspace 的地址/页权限假设会在哪一步分道扬镳？

源码入口：`share/memory/metaspaceShared.cpp:1333`、`share/memory/metaspaceShared.cpp:1454`、`share/memory/filemap.hpp:36`、`share/memory/metaspaceShared.cpp:2033`。
