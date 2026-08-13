# 03. VirtualSpaceList + CDS — 底层虚拟内存与类数据共享

> 🔴 Deep | 9 KP 中的 2 个核心机制
> 读者处境: ChunkManager 的 Chunk 从哪来？VirtualSpaceList。ClassLoader 卸载后 Chunk 归还——整个 Node 回收——还给 OS。加上 CDS——多 JVM 共享同一份 Klass 元数据。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/10-metaspace/03 已按真实源码成文~105 行,本大纲为规划期产物,机制描述以文章为准;标题按内容改为 "VirtualSpace 与归还"):
> - **"retire: Node 所有 Chunk 已归还→os::uncommit_memory+os::release_memory 还给 OS" 错(机制错位)**: 归还链是三步,各有时机——**retire**(virtualSpaceNode.cpp:560-583)=把 Node 剩余空闲区**从大到小切成标准 chunk 全还给 ChunkManager**(Medium→Specialized 逐级 :564-578,断言 free_words==0 :582),**不碰虚拟内存**;触发时机=**换新 Node 前 retire_current_virtual_space**(virtualSpaceList.cpp:141-147,create_new_virtual_space 前 :298-300 注释 "retire current node")非"最后一个 chunk 归还后";**purge**(virtualSpaceList.cpp:74-125,**必须 safepoint** :75,container_count()==0 且非当前 Node :91→摘除链表→Node::purge 摘 chunk(remove_chunk+remove_sentinel :75-88)→delete vsl :109);**release**=~VirtualSpaceNode(virtualSpaceNode.cpp:282-291)**_rs.release()**(:283,09-02 的 ReservedSpace::release)munmap 还给 OS
> - **扳机**: ClassLoaderDataGraph::purge(classLoaderData.cpp:1455-1473,safepoint,delete 死 CLD :1466→**Metaspace::purge()** :1470→两空间 VirtualSpaceList::purge(metaspace.cpp:1478-1487);"等下次 GC safepoint 批量 retire"准确说是"批量 **purge**"
> - **expand_by**(virtualSpaceNode.cpp:467-493): 先算 uncommitted(:472-474 不够返回 false)→commit=MIN2(preferred,uncommitted)→virtual_space()->expand_by(:478,09-02 的三段);initialize(:500-526)断言对齐 commit_alignment(:506-508)+initialize_with_granularity(:516,special Node 整块预提交 :511);get_chunk_vs(:494)→take_from_committed(:369,padding chunk :76)
> - **"Node 默认大小 _reserve_size(1MB)" 未验证**: 实际 VirtualSpaceSize/预留按需(create_new_virtual_space virtualSpaceList.cpp:306);大纲"小 Node 因为 ClassLoader 可能很快卸载"为规划推理
> - **CDS(概要,细节 11 域)**: preload_and_dump(metaspaceShared.cpp:1632)/initialize_shared_spaces(:2100)/map_shared_spaces(:2034);"metaspaceShared.cpp:200-500/700-1000" 行号漂移(文件 2184 行)
> - **第 3 轮 REVIEW 补充**: CDS 映射默认**只读**(_read_only,filemap.cpp:902-905,JVMTI can_modify_any_class 才放宽 :891-905)——"redefine 时 COW"为推测已删;Metaspace::commit_alignment 默认=page_size(metaspace.cpp:1248)
> - 悬念指向域 11 CDS(第 5 批,archive 生成/校验/映射)✓

### 1. VirtualSpaceNode — mmap reserve + 按需 commit

场景: ChunkManager cache 全空——需要 4KB SmallChunk→`VirtualSpaceList::get_new_chunk(4096)`→当前 Node 的 committed 区域有空→扩展→切出 4KB Chunk。

**VirtualSpaceNode** (`virtualSpaceNode.hpp.cpp`):
- `_reserved`: `ReservedSpace`——mmap MAP_NORESERVE 预留——不消耗物理内存
- `_committed`: 已 commit 的区域——`_free_committed_words` = committed 中未分配部分——ChunkManager 可以从这里切
- `_used_words`: 已分配给 Chunk 的部分——这些 Chunk 当前在 ChunkManager (free) 或 MetaspaceArena (used)
- [C++: Node 的 grow 策略——`expand_by(word_size)`→如果 free committed 不够→`os::commit_memory(low, new_commit_size)`→扩展 committed 区域→为新 Chunk 提供空间。commit 粒度由 `_commit_alignment` (默认 64KB) 决定]

**retire 条件** (`virtualSpaceNode.cpp:200-350`):
- `retire()`: Node 中所有 Chunk 已归还 ChunkManager→`_used_words == 0`→不再需要 Node→`os::uncommit_memory(_low, _committed)`→释放物理页→`os::release_memory(_low, _reserved)`→释放虚拟地址→还给 OS
- [C++: retire 在 ChunkManager::return_chunk 的检查中触发——当最后一个 Chunk 归还后——ChunkManager 遍历 VirtualSpaceList 的 Node 链表——找到对应的 Node——如果 `_used_words==0`→标记 retire。延迟: 不立即 retire——等下一次 GC 的 safepoint——批量 retire 多个 Node]

**VirtualSpaceList** (`virtualSpaceList.hpp.cpp`):
- `_current_virtual_space`: 当前活跃 Node——alloc 从这个 Node commit
- `_virtual_space_list`: 全部 Node 链表——包含退役中的 Node (等待 retire)
- `create_new_virtual_space_node(word_size)`: 当前 Node 无法扩展 (reserved 用尽)→`ReservedSpace(size)`→新 mmap reserve→创建新 Node
- [C++: Node 的默认大小——`_reserve_size` (默认 1MB, 最小 64KB)。小 Node——因为 ClassLoader 可能在分配几个 Klass 后就被卸载——大 Node 浪费 reserved 地址空间]

### 2. CDS + MetaspaceShared — 跨进程类共享

场景: JVM 第一次启动→dump CDS archive (`classes.jsa`)——包含已加载的 1000+ 核心类的 Klass/Method/ConstantPool——序列化为二进制。第二次启动→mmap `classes.jsa`→直接映射到 Metaspace 虚拟地址——跳过 ClassFileParser 解析——类"瞬间就绪"。

**Dump 阶段** (`metaspaceShared.cpp:200-500`):
- `MetaspaceShared::preload_and_dump(TRAPS)`: JVM 启动→`-Xshare:dump`→遍历 SystemDictionary 中的所有已加载核心类→`MetaspaceShared::link_and_serialize()`→把它们的 MetaspaceObj 序列化为 archive 的 chunk format
- [C++: 序列化——不是复制 C++ 对象——是 deep copy 每个 Klass→Method→ConstantPool 的完整内存内容→包含所有指针→`MetaspaceShared::relocate_pointers()` 修正指针为 archive 中的偏移。写 `.jsa` 文件——`os::write(fd, archive_start, archive_size)`]

**Load 阶段** (`metaspaceShared.cpp:700-1000`):
- `MetaspaceShared::initialize_shared_spaces()`: 启动时→`FileMapInfo::open()`→检查 `.jsa` 的 CRC/timestamp→如果有效→`mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0)`→map archive 到 Metaspace 地址空间
- `MetaspaceShared::map_shared_spaces()`: map 到 `MetaspaceShared::_shared_rs` 的 reserved 区域——在 JVM 初始化的 Universe::genesis 之后——地址空间已预分配
- [C++: `MAP_SHARED`——多 JVM 进程共享同一物理页——节省 RAM。不是每个 JVM 有一份 Klass 副本——是操作系统 page cache 中的同一份物理页——读时共享——修改 (class redefine) 时 COW (copy-on-write)]
- AppCDS (Java 10+): 应用类也可以加入 sharing——`-XX:SharedArchiveFile=app-cds.jsa -Xshare:dump -XX:+UseAppCDS`

---

### 核心悬念

**"ClassLoader 卸载→ChunkManager 缓存→VirtualSpaceNode retire→OS uncommit+release——完整虚拟地址回收。"** — Metaspace 不像 PermGen——native memory 回收不需要 JVM heap GC。CDS share 让多 JVM 共享 Klass 元数据——启动时 mmap→跳过 ClassFileParser——1000+ 核心类秒加载。域 10 完成。Group 4 结束。

> → domain 11: [CDS — Class Data Sharing: FileMap→archive→shared spaces 的完整实现](../11-cds/01-filemap-archive.md)
