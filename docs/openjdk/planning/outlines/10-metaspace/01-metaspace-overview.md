# 01. Metaspace 全景 — PermGen 的继任者

> 🔴 Deep | 9 KP 中的 3 个核心机制
> 读者处境: `-XX:MaxPermSize=256m` 在 Java 8 消失了——类元数据去哪了？Metaspace——native memory，不在 Java heap——由 OS 直接管理。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/10-metaspace/01 已按真实源码成文~105 行,本大纲为规划期产物,机制描述以文章为准):
> - **"四层 Metaspace → MetaspaceArena → ChunkManager → VirtualSpaceList" 中 MetaspaceArena 是 JDK15+ 名字**: jdk11u 对应层=**ClassLoaderMetaspace**(metaspace.hpp:237,per CLD,含 **两个 SpaceManager** _vsm/_class_vsm :256-257,allocate :1572 按 mdtype 分流)+**SpaceManager**(spaceManager.hpp:43);真实链=L1 Metaspace::allocate(metaspace.cpp:1366-1414: mdtype 分流 :1378→loader_data->metaspace_non_null()->allocate :1386→失败 satisfy_failed_metadata_allocation(触发 GC 重试,注释"prevent premature expansion") :1396→OOM report→**zero 初始化** :1413)/L2 ClassLoaderMetaspace/L3 SpaceManager::allocate_work(spaceManager.cpp:429-448: current_chunk()->allocate :441→grow_and_allocate :173,**humongous 不设为当前 chunk** :204-210 注释)/L4 ChunkManager(chunkManager.hpp:44)+VirtualSpaceList::get_new_chunk(virtualSpaceList.cpp:341: current_virtual_space->get_chunk_vs→expand)
> - **"8 种大小分级 Specialized(1KB)→Humongous(>4MB)" 错**: jdk11u 是 **4 类**(metaspaceCommon.hpp:95-101 ChunkIndex): Specialized=128 words(:36)/Small=512 words(:39,class 256 :38)/Medium=8K words(:41,class 4K :40)/Humongous(>Medium);class 与 non-class 大小不同(:134-149)
> - **"MetaspaceSize ~20MB" 错(JDK8 旧值)**: jdk11u 默认=ScaleForWordSize(4*M)=4M*13/10≈**5.2MB**(globals.hpp:41 ScaleForWordSize 定义/:97);语义注释=**GC 触发阈值**("Initial threshold (in bytes) at which a garbage collection is done to reduce Metaspace usage" :1816-1819)非"高水位";MaxMetaspaceSize 默认 max_uintx(:1821);CompressedClassSpaceSize 1G(range 1M-3G,:1825)
> - **阈值机制**: _capacity_until_GC(metaspace.cpp:71 volatile)+inc_capacity_until_GC(:142)+MetaspaceGC::compute_new_size(:235 自适应,MinMetaspaceFreeRatio/MaxMetaspaceFreeRatio);Metaspace 的"GC"=借 Full GC safepoint 做 class unloading(ClassLoaderDataGraph::do_unloading,07-05 讲过),归还 native memory 本身不需要 GC
> - **class space**: 建立=Metaspace::allocate_metaspace_compressed_klass_ptrs(metaspace.cpp:1074+,断言 UseCompressedClassPointers);独立地址范围→narrowKlass decode=base+(index<<shift),shift=0 时一次 add
> - **"metaspace.hpp:50-150 / metaspace.cpp:100-400/400-600/500-700" 全部漂移**: Metaspace 类在 metaspace.hpp:94(AllStatic)/ClassLoaderMetaspace :237;metaspace.cpp 1872 行
> - 悬念指向 02-chunk-metablock-allocation.md(标题 "02. Chunk/Metablock——~500B 的 Klass 怎么在 Chunk 中快速分配")✓

### 1. 为什么换？— PermGen 的三个致命缺陷

场景: Java 7——部署了 50 个 Web App——每个 Spring 加载 ~5000 个类——PermGen 256MB→`java.lang.OutOfMemoryError: PermGen space`——Full GC 也回收不了多少——因为类还没卸载。唯一的解法: 重启 JVM 或增大 PermGen。但 PermGen 在 Java heap 中——增大 PermGen = 减小 heap——tradeoff 永远被动。

**PermGen 的缺陷**:
- 在 Java heap 中——受 `-XX:MaxPermSize` 上限——调不好→OOM
- GC 回收类只在 Full GC——CMS/G1 的 concurrent phase 不能回收 PermGen——必须 stop-the-world Full GC
- 类元数据大小不可预测——Spring/dynamic proxy/JVMTI agent——在运行时创造新类——无法提前知道需要多大 PermGen

**Metaspace 的答案** (`metaspace.hpp:50-150`):
- Native memory (C heap, mmap 管理)——不在 Java heap——不受 GC heap 限制
- ClassLoader 卸载时——OS 直接回收 native memory——不需要 Full GC
- `-XX:MaxMetaspaceSize` 默认无限制——操作系统有多少 free memory 就能用多少——但 `-XX:CompressedClassSpaceSize=1G` 有限制 (narrow klass pointer 范围)
- [C++: MetaspaceObj——`Klass`/`Method`/`ConstantPool`/`Symbol`/`MethodData`/`ConstMethod`——全部在 Metaspace。没有 markOop 头——不需要 GC 扫描——对象布局比 Java OOP 简单——只有数据+zero header]

### 2. Metaspace 四层架构

**Metaspace → Arena → ChunkManager → VirtualSpaceList** (`metaspace.cpp:100-400`):
- Layer 1 — Metaspace (全局入口): `Metaspace::allocate(ClassLoaderData*, size, MetaspaceObj::Type)`→根据 type 选择正确的分配策略→进入 Arena
- Layer 2 — MetaspaceArena (per ClassLoaderData): 从 ChunkManager 取 Chunk→内部 Metablock bump-pointer。per-CL 隔离——ClassLoader A 的 Klass 不影响 B
- Layer 3 — ChunkManager (全局): free Chunk 缓存。8 种大小分级——`Specialized(1KB)`→`Humongous(>4MB)`。优先从 cache 取——没有→通知 VirtualSpaceList commit 新空间
- Layer 4 — VirtualSpaceList / VirtualSpaceNode: mmap reserve (不消耗物理内存)→按需 commit (真正分配物理页)→Node 全部回收→release 还给 OS
- [C++: 四层的原因——每层有不同的生命周期和责任。Arena 是 per-CL 的——方便 ClassLoader GC。ChunkManager 是全局的——缓存 free Chunk——避免频繁 commit/uncommit。VirtualSpaceList 是全局的——管理 mmap——最底层。四层从 "哪个 ClassLoader?" 到 "需要多少虚拟内存?" 逐层向下委托]

**ClassLoaderData 与 Metaspace 的生命周期** (`metaspace.cpp:400-600`):
- ClassLoader 加载→创建 `ClassLoaderData`→`Metaspace::allocate(CLD, size, ...)`→CLD->metaspace_arena()->allocate(...)
- ClassLoader 卸载→`ClassLoaderDataGraph::do_unloading()`→找出濒死 CLD→`ClassLoaderData::unload()`→遍历该 CLD 加载的所有 Klass/Method→归还其 Metaspace 分配→ChunkManager→全部归还后→标记 Node 可 release
- [C++: `ClassLoaderDataGraph::do_unloading()`——遍历 CLD 链表——检查每个 CLD 的 `_keep_alive` (Java ClassLoader 的 JNI weak ref)——如果被回收→CLD 标记为 dead→后续清理: `Metaspace::deallocate()`→ChunkManager::return_chunk→VirtualSpaceList::retire→OS release]
- 不像 PermGen 需要 Full GC——native memory 回收在 `ClassLoaderDataGraph::do_unloading` 中——不需要独立的 GC 事件

### 3. Settings + GC 交互

**关键参数** (`metaspaceCommon.hpp:30-80`):
- `MetaspaceSize` (初始 high-water): ~20MB。Metaspace usage 超过此值→trigger GC + class unloading→`MetaspaceGC::compute_new_size()` 计算新的 high-water (自适应)
- `MaxMetaspaceSize`: 绝对上限——默认无限。到达→OutOfMemoryError: Metaspace
- `CompressedClassSpaceSize`: narrow Klass pointer 范围——默认 1GB。存 `InstanceKlass`/`ArrayKlass` 等 Klass 对象——包含 vtable/itable/field layout——通常几百 KB 到几 MB——足够
- [C++: CompressedClassSpace——独立虚拟地址范围——`_narrow_klass._base` + `_shift`=0。所有 Klass* 的 compressed 形式 (narrowKlass=32-bit index)→decode: `(Klass*)(base + (index << shift))`。分开的原因: Klass 和普通 MetaspaceObj (Method/ConstantPool/Symbol) 有不同的访问模式——narrow klass 需要快速 decode——独立地址范围让 base 固定——shift=0——decode 只做 `add base`
- `MinMetaspaceFreeRatio` / `MaxMetaspaceFreeRatio`: GC 后 Metaspace 的空闲比例——太小→增大 high-water；太大→缩小 high-water

**GC 触发** (`metaspace.cpp:500-700`):
- `MetaspaceGC::compute_new_size()`: 在 Full GC 的 safepoint 中调用——查看当前 Metaspace usage→如果 > `_capacity_until_GC`→trigger `_expand_lock`→设置新的 high-water→下次达到→再 GC
- [C++: Metaspace GC 不等同于 Java heap GC——但共享 safepoint。Full GC 同时扫描 heap (young+old) + Metaspace cleanup——因为都在 safepoint。`MetaspaceGC::_capacity_until_GC` 初始 = `MetaspaceSize`≈20MB——然后 GC 后自适应——快速增长到 ~200MB]

---

### 核心悬念

**"PermGen 没了——Metaspace 在 native memory 中——ClassLoader 卸载时自动归还 OS——不需要 Full GC。"** — 但 Metaspace GC 仍在 Full GC safepoint 中触发——不是独立的回收事件。CompressedClassSpace 独立于普通 Metaspace——给 Klass 专属快速 decode 地址。下一个: Chunk + Metablock——~500B 的 Klass 怎么在 Chunk 中快速分配。

> → [02-chunk-metablock-allocation.md](02-chunk-metablock-allocation.md)
