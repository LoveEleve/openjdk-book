# 01. Metaspace 全景 — PermGen 的继任者

> **前置依赖**:[09-memory-core/02 — VirtualSpace](openjdk/vol-02/09-memory-core/02-virtualspace.md):Metaspace 的虚拟空间底层就是那一篇的 reserve/commit;[09-memory-core/01 — Universe](openjdk/vol-02/09-memory-core/01-universe-heap.md):universe_init 里调 `Metaspace::global_initialize`(universe.cpp:694)开启本域;[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):解析出的 InstanceKlass 等元数据住在这里;[06-oops/02 — Klass 层次](openjdk/vol-02/06-oops/02-klass-hierarchy.md):Klass 继承 MetaspaceObj
> → **后续**:[10-metaspace/02 — Chunk/Metablock 分配](02-chunk-metablock-allocation.md)(~500B 的 Klass 怎么在 Chunk 里快速分配)
> 关联域: 06-oops(对象模型)、07-classfile(类加载)、09-memory-core(内存管理)、17-threads(ClassLoaderData 生命周期)

## PermGen 没了,类元数据住哪

Java 7 时代,类元数据(Klass/Method/ConstantPool/Symbol)住在堆里的 **PermGen**(永久代),`-XX:MaxPermSize=256m` 是部署多应用时的老大难: 类元数据占堆、回收只在 Full GC、动态代理/反射产生的类大小无法预测——OOM 是家常便饭。Java 8 起 PermGen 退役,元数据搬进 **Metaspace**: native memory,不受 GC 堆限制,ClassLoader 卸载时直接归还。这一篇是 10 域全景: 四层架构(jdk11u 的真实名字)、两个世界(class 空间与 non-class 空间)、以及阈值与 GC 的互动。

## 1. 为什么换: PermGen 的三个缺陷

- **住在 Java heap 里**: 受 `-XX:MaxPermSize` 上限,调大 PermGen 就是调小 heap——两者此消彼长,部署多 WebApp 时永远被动;
- **回收只在 Full GC**: CMS/G1 的并发阶段碰不了 PermGen——类元数据的清理必须等 stop-the-world 的 Full GC;
- **大小不可预测**: Spring 容器、动态代理、JVMTI agent 在运行时创造新类——规划期无法知道需要多大 PermGen。

Metaspace 的回答: 元数据改住 **native memory**(mmap 管理,09-02 的地基);ClassLoader 卸载时**直接归还给 OS,不需要等 Full GC**;`-XX:MaxMetaspaceSize` 默认无上限(globals.hpp:1821,`max_uintx`);唯一有硬上限的是 **`CompressedClassSpaceSize` 默认 1G**(globals.hpp:1825)——压缩类指针的地址范围。MetaspaceObj 家族(Klass/Method/ConstantPool/Symbol/ConstMethod,06-02 讲过)全部住这里,没有 mark word、不需要 GC 扫描——布局比堆对象简单得多。

## 2. 四层架构: jdk11u 的真实名字

流传的四层"Metaspace → MetaspaceArena → ChunkManager → VirtualSpaceList"里,**MetaspaceArena 是 JDK 15+ 的名字**,jdk11u 对应层是 **ClassLoaderMetaspace + SpaceManager**。真实链条:

### L1: Metaspace::allocate —— 全局入口

`Metaspace::allocate`(metaspace.cpp:1366-1411,截取核心,逐字):

```cpp
// metaspace.cpp:1366-1414(截取核心,逐字)
MetaWord* Metaspace::allocate(ClassLoaderData* loader_data, size_t word_size,
                              MetaspaceObj::Type type, TRAPS) {
  ...
  MetadataType mdtype = (type == MetaspaceObj::ClassType) ? ClassType : NonClassType;

  // Try to allocate metadata.
  MetaWord* result = loader_data->metaspace_non_null()->allocate(word_size, mdtype);

  if (result == NULL) {
    tracer()->report_metaspace_allocation_failure(loader_data, word_size, type, mdtype);

    // Allocation failed.
    if (is_init_completed()) {
      // Only start a GC if the bootstrapping has completed.
      // Try to clean out some heap memory and retry. This can prevent premature
      // expansion of the metaspace.
      result = Universe::heap()->satisfy_failed_metadata_allocation(loader_data, word_size, mdtype);
    }
  }
  ...
  // Zero initialize.
  Copy::fill_to_words((HeapWord*)result, word_size, 0);

  return result;
}
```

两步: 先按类型分到 **class 空间或 non-class 空间**(`mdtype`,:1378),交给当前 ClassLoader 的 `metaspace_non_null()`(:1386);失败则 `satisfy_failed_metadata_allocation`(:1396)——**发起 VM_CollectForMetadataAllocation 触发一次 GC 腾出可卸载的类再重试**(collectedHeap.cpp:257-324,`GCCause::_metadata_GC_threshold`,注释: 避免过早扩张 Metaspace);再失败才 OOM。最后 **zero 初始化**(:1413)。

### L2: ClassLoaderMetaspace —— 每个 ClassLoader 一套

`ClassLoaderMetaspace`(metaspace.hpp:237,per ClassLoaderData)的关键是**两个 SpaceManager**(metaspace.hpp:256-257,截取核心,逐字):

```cpp
// metaspace.hpp:256-268(截取核心,逐字)
  metaspace::SpaceManager* _vsm;
  metaspace::SpaceManager* _class_vsm;
  ...
  metaspace::SpaceManager* get_space_manager(Metaspace::MetadataType mdtype) {
    assert(mdtype != Metaspace::MetadataTypeCount, "MetadaTypeCount can't be used as mdtype");
    return mdtype == Metaspace::ClassType ? class_vsm() : vsm();
  }
```

类元数据(Klass 们)与普通元数据(Method/ConstantPool/Symbol 们)各一个 SpaceManager,隔离分配。`allocate`(:1572)按 mdtype 分流——"ClassLoader A 的分配不影响 B"的隔离就在这里。

### L3: SpaceManager —— 当前 chunk 里 bump

`SpaceManager::allocate_work`(spaceManager.cpp:429-448): 先看当前 chunk 有没有空间(`current_chunk()->allocate(word_size)`,:441),不够就 `grow_and_allocate`(:444)——向 ChunkManager 要一个新 chunk(:173 起),加进在用列表;**humongous chunk(超大)不设为当前 chunk**(:204-210 注释: 它只服务这一次大分配,设为当前会过早退役一个好 chunk)。

### L4: ChunkManager + VirtualSpaceList —— 缓存与 mmap

`ChunkManager`(chunkManager.hpp:44)全局缓存空闲 chunk;缓存 miss 时 `VirtualSpaceList::get_new_chunk`(virtualSpaceList.cpp:341): 先问当前 VirtualSpaceNode(`get_chunk_vs`),不够就 **expand 提交更多**(09-02 的 VirtualSpace!)——每个 `VirtualSpaceNode` 就是一个 mmap 区域(内含 09-02 的 `_virtual_space`)。Node 全部用完才 reserve 新的。

**关键设计 (斜体)**: *四层是"生命周期"的分层: ClassLoaderMetaspace/SpaceManager 跟着 ClassLoader 生灭(卸载即整块归还),ChunkManager 全局缓存(避免频繁 commit/uncommit),VirtualSpaceList 管 mmap 生命周期(最底层)。分配请求从"哪个 ClassLoader"一路问到"需要多少虚拟内存"。*

## 3. 两个世界: class space 与 non-class space

普通 Metaspace 与压缩类空间是**两个独立的虚拟地址范围**。class space 的建立走 `Metaspace::allocate_metaspace_compressed_klass_ptrs`(metaspace.cpp:1074+,断言 UseCompressedClassPointers 等),上限 `CompressedClassSpaceSize` 默认 **1G**(globals.hpp:1825)。分开的理由: Klass 指针要快速 decode 成 narrowKlass——**独立地址范围让 base 固定,默认配置下(无 CDS、class space ≤4G)shift=0,decode 就是一次 `add base`**(shift 的选择在 metaspace.cpp:1017-1053,超出 4G 才退回 LogKlassAlignmentInBytes);而普通元数据(Method/ConstantPool)访问模式不同,不必享受这个待遇。这与 09-02 压缩 oops 的堆保护页是同一套"压缩指针"思想的延伸——那边压 oop,这边压 Klass。

## 4. 阈值与 GC: Metaspace 也会"GC"

- **`MetaspaceSize`**: 默认 `ScaleForWordSize(4*M)`(globals.hpp:97)——ScaleForWordSize 是 `x*13/10`(globals.hpp:41,压缩 oops 时),即**约 5.2MB**(流传的"20MB"是 JDK 8 旧值)。它的语义注释写得很清楚: "Initial threshold (in bytes) at which a garbage collection is done to reduce Metaspace usage"(globals.hpp:1816-1819)——**触发 GC 的阈值**,不是"高水位";
- **`_capacity_until_GC`**(metaspace.cpp:71): 实际的阈值计数器,Metaspace 用量逼近它时 `inc_capacity_until_GC` 抬高并请求 GC;GC 后 `MetaspaceGC::compute_new_size`(:235)按剩余比例**自适应调整**(MinMetaspaceFreeRatio/MaxMetaspaceFreeRatio 控方向);
- **`MaxMetaspaceSize`**: 绝对上限,默认无限(:1821),到了就 `OutOfMemoryError: Metaspace`。

注意 Metaspace 的"GC"不是独立回收事件: 它借 Full GC 的 safepoint 做 class unloading(ClassLoaderDataGraph::do_unloading,07-05 讲过)——**卸载归还 native memory 本身不需要 GC,GC 只是顺带发现"哪些 ClassLoader 死了"**。

## 核心悬念

全景到齐: PermGen 的三个缺陷(占堆/只 Full GC 回收/不可预测)催生了 Metaspace;jdk11u 的四层是 Metaspace::allocate(按类型分流、失败触发 GC 重试、zero 初始化)→ ClassLoaderMetaspace(per CLD,两个 SpaceManager 隔离 class/non-class)→ SpaceManager(当前 chunk bump,humongous 不设当前)→ ChunkManager/VirtualSpaceList(全局缓存 + mmap 生命周期);class space 独立 1G 上限让 narrowKlass 解码就是一次 add;MetaspaceSize 默认 5.2MB 是 GC 阈值不是水位。但有一个问题被留到最后: SpaceManager 的"当前 chunk"——chunk 内部到底怎么给一个 ~500 字节的 Klass 分配空间?空闲块怎么复用?下一篇: Chunk 与 Metablock——元数据分配的执行面。

> → [10-metaspace/02 — Chunk/Metablock 分配](02-chunk-metablock-allocation.md)
