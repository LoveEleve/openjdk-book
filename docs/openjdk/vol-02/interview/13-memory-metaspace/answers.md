# 13 · 内存分配、Metaspace 与 CDS 内存模型：专家答案锚点

## 1. JVM 启动时先解决“依赖顺序”，再解决“对象存在”

`Universe` 的价值不是存单例，而是把启动早期的依赖顺序钉死：先选 collector、构造 heap object、初始化 heap substrate，再建立最小类宇宙、修镜像、最后才进入普通对象分配与 fully initialized 世界。这个阶段链可以从 `share/memory/universe.cpp:694`、`:760`、`:860`、`:1013` 进入。`Universe::create_heap` 与 `CollectedHeap::initialize` 分别解决“选谁”和“怎么 reserve/initialize 地址空间与内部结构”，不能混成一步。

这条链说明：很多“像对象一样”的东西在早期其实不是普通 Java heap 对象，而是 metaspace metadata、镜像占位、sentinel 或预分配异常对象。若要求“一次性全造完”，最先会在 well-known klass、primitive mirrors、`Object[]` klass 与 `<clinit>`/mirror fixup 的依赖上打结。

## 2. VirtualSpace 的哲学是先拿到地址控制权，再按需为字节付款

reserve/commit 分离首先不是为了省内存，而是为了提前锁定地址范围、增长方向、对齐关系和后续切块边界。对于 Metaspace、CodeCache、CDS、compressed class space 这类依赖地址稳定或编码简化的系统，“地址先确定”比“字节先到手”更重要。基础 `VirtualSpace` 路径可以从 `share/memory/virtualspace.cpp:255` 与 `:844` 看起，Metaspace 上层如何复用这套模式则可从 `share/memory/metaspace/virtualSpaceList.cpp:289` 进入。

当前 node 能扩就扩，扩不动再 retire 并挂新 node；这让子分配器维持稳定假设，而不是每次分配都面对一片新的随机地址。若把这层做成现取现用的 `mmap`，最先坏掉的通常不是单次分配本身，而是压缩指针、共享映射和连续布局等更高层协议。

## 3. Arena 的本质是“按作用域回收”，不是“更快的 malloc”

Arena 适合 parser、编译器和 VM 内短命临时结构，因为它把生命周期边界交给 scope/mark，而不是交给每个对象的单独 free。chunk + bump pointer 让快路径几乎退化成指针推进；`ResourceMark` 结束时整批回收则把释放成本压缩到一次。入口可从 `share/memory/allocation.hpp:511`、`share/memory/resourceArea.hpp:39` 和 `share/memory/arena.cpp:132` 进入。

这也解释了为什么 `InstanceKlass`、`Method`、`ConstantPool` 不能留在 Arena：它们的生命周期跟随类/loader，而不是当前 parser 或编译阶段的作用域。反过来，如果把 parser 的半成品直接放进 Metaspace，则一旦 class format 或 verification 失败，回滚与 ownership 边界会迅速复杂化。

## 4. Metaspace 的核心变化是“物理地址外移 + 生命周期按 CLD 分仓”

“PermGen 挪到堆外”只说对了一半。真正的变化有两层：

1. metadata 不再与普通 Java heap 抢同一块预算；
2. metadata 的拥有者从“全局堆上的一批对象”变成“某个 ClassLoaderData 名下的 `ClassLoaderMetaspace` 仓库”。

`Metaspace::allocate`（`share/memory/metaspace.cpp:1366`）按 class/non-class 分流；`ClassLoaderMetaspace`（`share/memory/metaspace.hpp:237`）再把请求交给 `SpaceManager`；`SpaceManager` 从 `share/memory/metaspace/spaceManager.cpp:401` 一带先走当前 chunk bump allocate、本地 freelist 复用，再走全局 `ChunkManager`（`share/memory/metaspace/chunkManager.hpp:43`），最后才由 `VirtualSpaceList` 去 commit 或 reserve 新地址空间。这说明 Metaspace 真正的执行模型是多层分仓与复用，而不是一个“巨大全局堆外池子”。

## 5. Metaspace 找 GC，是为了借 class unloading 的判定时机

Metaspace allocation failure 后调用 `Universe::heap()->satisfy_failed_metadata_allocation(...)`，不是因为 Java heap 的字节会直接拿来装 metadata，而是因为只有 GC/safepoint 能给出“哪些 ClassLoaderData 已经死了，可以整仓归还 metadata”的全局一致时刻。对应失败路径从 `share/memory/metaspace.cpp:1387` 进入，GC 侧承接在 `share/gc/shared/collectedHeap.cpp:257`；阈值和上限参数分别在 `share/runtime/globals.hpp:1816` 与 `:1821`。

所以 `_metadata_GC_threshold` 代表的是：先试一次借 GC 回收 class loader 相关 metadata，再决定是否继续扩 native 空间。`MetaspaceSize` 因而是“触发一次 GC 尝试的阈值”，不是绝对上限；真正的硬上限由 `MaxMetaspaceSize` 控制。若永远只扩 native 空间、不先试 GC，就会丧失对元数据泄漏、loader 囤积和无意义扩张的约束能力。

## 6. 压缩指针首先是地址编码协议，其次才是省空间

无论是 `narrowOop` 还是 `narrowKlass`，本质都是“用 base + shift + 对齐冗余位”压缩地址编码。是否省空间只是表面结果；真正的前提是地址必须落在可编码、可快速 decode 的范围内。

这就是为什么 HotSpot 要单独 reserve compressed class space，并让 class metadata 与 non-class metadata 分离增长。相关逻辑可从 `share/memory/metaspace.cpp:1015`、`:1074` 和 `share/runtime/globals.hpp:1825` 进入；`Klass` 作为被压缩编码目标之一的边界可从 `share/oops/klass.hpp:54` 理解。它服务的是 `narrowKlass` 的编码/解码简化，以及和 CDS/shared space 的基址关系。若 class space 与其他 metadata 混杂增长，最先受损的往往是 base/shift 假设与共享映射协同，而不只是“多几字节”这么简单。

## 7. CDS 与 Metaspace/VirtualSpace 共享同一种地址优先哲学

CDS dump/load 看似是归档机制，实则延续了同一种内存模型哲学。dump 端可从 `share/memory/metaspaceShared.cpp:1333` 和 `:1454` 进入，归档头布局从 `share/memory/filemap.hpp:36` 看起，load 端同址映射要求可从 `share/memory/metaspaceShared.cpp:2033` 进入：

- dump 端先 freeze 对象集合，再 compact/rewrite/relocate，按 `rw/ro/mc/md` 组织页面语义；
- load 端要求同址映射，再把当前进程相关的 vtable、method entry、mirror 和 runtime state 接回来；
- 能固化的是“与具体进程无关的稳定内存形态”，不能固化的是“当前进程才知道的运行期接头”。

因此 CDS 不是普通对象序列化，而是未来希望被原样 mmap 并重新接线的内存镜像。这与 VirtualSpace、class space、compressed klass base 的思路一致：先稳定地址与布局，再把当前进程必须知道的语义补回去。

## 评分锚点

- **合格**：能说清 Universe/VirtualSpace/Arena/Metaspace/CompressedOops/CDS 各自的职责。
- **良好**：能说出 reserve/commit、per-CLD ownership、metadata allocation failure → GC 的因果链。
- **专家级**：能用“地址先稳定、生命周期按 owner 分仓、运行期再补语义”这一条主线，把启动、Metaspace、压缩指针和 CDS 内存模型贯通起来。
