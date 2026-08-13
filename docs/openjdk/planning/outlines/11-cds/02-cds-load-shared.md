# 02. Load — mmap archive → shared spaces → 类就绪

> 🔴 Deep | 8 KP 中的 3 个核心机制
> 读者处境: JVM 第二次启动——`-Xshare:on`→mmap `classes.jsa`→Metaspace 预置区映射到 archive→SystemDictionary 查 shared 类→跳过 ClassFileParser。

> ⚠️ 写作期修正(2026-08-13, vol-02/11-cds/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"initialize_shared_spaces :700-1000" 错**: 真实在 **:2100**(universe.cpp:729 调用,装配);**映射**在 `MetaspaceShared::initialize_runtime_shared_and_meta_spaces`(metaspaceShared.cpp:216,metaspace.cpp:1305 调用);`mapinfo->initialize() && map_shared_spaces(mapinfo)` 在 :229
> - **"Step 1: FileMapInfo::current_info()->validate()" 不存在**: 真实链=FileMapInfo::initialize(filemap.cpp:1313)→open_for_read(:617)→init_from_file(:524,magic :537-543/version :545-550/jvm_ident :561-574/CRC :576-584/截断 :602-608)→validate_header(:1397)→_header->validate(:1359,ObjectAlignment/CompactStrings/验证设置 :1384-1392)+check_shared_paths_misc_info(:1401)
> - **"FileMapInfo::map_regions()" 不存在(编造)**: 真实=`MetaspaceShared::map_shared_spaces`(metaspaceShared.cpp:2034): 先 reserve_shared_memory(filemap.cpp:869,整块 ReservedSpace 防覆盖 code cache)→逐区 map_region(filemap.cpp:891,目标地址 region_addr 从头读出)→映射后 validate_shared_path_table(:2058,RW 区,注释 "this is done later")
> - **"MAP_SHARED" 错**: Linux 实现 os::pd_map_memory(os_linux.cpp:6129)**flags=MAP_PRIVATE**(:6133)+addr 非空时 MAP_FIXED(:6145-6146);跨进程共享页来自 file-backed 页缓存,非 MAP_SHARED 语义
> - **"Step 3: map_shared_spaces 成功后 UseSharedSpaces=true" 方向反**: flag 由 -Xshare 参数先定(arguments.cpp:2781-2801: on→Require=true/auto/off;默认 UseSharedSpaces=true RequireSharedSpaces=false=auto 行为);失败统一走 fail_continue(filemap.cpp:102: 日志+UseSharedSpaces=false+close,:124-126),RequireSharedSpaces 时改 fail 退出(:114-115)
> - **"find_or_load_shared_class :50-250" 行号漂**: 实际 **:480**;AppCDS 拦截点在 JVM_FindLoadedClass(jvm.cpp:999,由 BuiltinClassLoader.loadClassOrNull→findLoadedClass(BuiltinClassLoader.java:593)触发);引导加载路走 SystemDictionary::load_shared_class(systemDictionary.cpp:1165,ik 版 :1270: 可见性 :1183→super/interfaces 重解析 :1292-1318→CFLH :1320→restore_unshareable_info :1347)
> - **"shared dictionary 在 CompactHashtable 中" 错**: 共享字典=`SharedDictionary : public Dictionary`(systemDictionaryShared.hpp:162,链表桶,运行期可增 UNREGISTERED 条目);CompactHashtable 只管符号/字符串两表
> - **"is_sharing_possible(class_loader)" 签名错**: 真实 `is_sharing_possible(ClassLoaderData*)`(:334,NULL/system/platform loader)
> - **"CompactHashtable::lookup(Symbol* key)" 签名错**: 真实 `lookup(const N* name, unsigned int hash, int len)`(compactHashtable.inline.hpp:59-91);桶项 u4 位打包(高 2 位类型/低 30 位偏移,compactHashtable.hpp:140-147),VALUE_ONLY 单条目桶只 4B、REGULAR 存 (hash,offset) 8B
> - **"mmap 后 _base_address 被设为实际映射地址" 错(把结果当原因)**: `_base_address` 是 **dump 时写死的 shared_rs()->base()**(compactHashtable.cpp:147),load 由 serialize 原样读回;有效前提=同址映射(第 3 节)
> - **缺机制(大纲无)**: ①类激活链 restore_unshareable_info(instanceKlass.cpp:2345: set_package→Klass::restore(mirror 恢复 klass.cpp:508,raw archived mirror :545-554)→Method::restore(method.cpp:1152→link_method :1077,assert entry==_i2i_entry :1082)→ConstantPool::restore(constantPool.cpp:328,resolved_references));②mc 区 trampoline: dump 时 unlink_method(method.cpp:977,:985-986 设 entry_for_cds_method)→load 时 method_entry 宏重写(templateInterpreterGenerator.cpp:186-189,update_cds_entry_table abstractInterpreter.cpp:214);adapter 走 _adapter_trampoline 运行期填(:1015-1031 注释,:1142-1148);③C++ vtable 克隆: clone_cpp_vtables(:745),dump 清零(:751)load 现拷 libjvm.so vtable(CppVtableCloner :667-681);④验证: 共享类 link_class 跳过 verify/rewrite 改 check_verification_constraints(instanceKlass.cpp:805-807,systemDictionaryShared.cpp:911-941);dump 端记录点在 verificationType.cpp:97-103;⑤init_state 不继承: remove_unshareable_info 重置 allocated(instanceKlass.cpp:2293-2297),load 端 add_to_hierarchy 设回 loaded;⑥自定义加载器: lookup_from_stream(:585,(name,size,crc32) 三元组)+acquire_class_for_current_thread(:628);⑦堆区: map_heap_regions→G1 alloc_archive_regions(filemap.cpp:1140),oop 编码不一致→relocation delta(filemap.cpp:1042-1058)+oopmap patch(:1188),窄 klass 编码不一致→弃用(:1021-1025);⑧子图恢复: VM.initializeFromArchive(VM.java:426)→JVM_InitializeFromArchive(jvm.cpp:3617)→HeapShared::initialize_from_archived_subgraph(heapShared.cpp:271)
> - **悬念指向错**: 大纲 →`../12-ci/01-ci-overview.md` 文件不存在;实际第一篇 = **12-ci/01-ci-overview-mirror.md**(ciObject 镜像体系)
> - **实证**: 11-cds-load-demo.txt(默认归档落 lib/server/classes.jsa;加载 cds 日志 校验+relocation delta=0+Trying to map heap data;坏 magic 降级;on 模式退出;classpath mismatch+class+path 详情;Xmx1g 触发 incompatible oop encoding 重定位 delta=-28991029248;AppCDS 下 T 应用类 source: shared objects file)

### 1. mmap archive — 从文件到 Metaspace

场景: JVM 启动→Universe::genesis→`MetaspaceShared::initialize_shared_spaces()`→`FileMapInfo::open()`→读 `.jsa`→验证 magic/version/CRC→`mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0)`→物理页映射到 Metaspace 预留地址。

**initialize_shared_spaces** (`metaspaceShared.cpp:700-1000`):
- Step 1: `FileMapInfo::current_info()->validate()`→检查 magic/version/CRC/classpath——不一致→`UseSharedSpaces=false`
- Step 2: `FileMapInfo::map_regions()`→遍历 5 个 space region→`mmap(aligned_base, region_size, PROT_READ, MAP_SHARED|MAP_FIXED, fd, file_offset)`——MAP_FIXED 强制映射到预留地址
- [C++: MAP_FIXED——必须映射到预留地址——因为 Klass 内部指针已 relocate 为 archive 内 offset——如果 mmap 到不同地址——所有指针 invalid。预留地址来自 `MetaspaceShared::_shared_rs` reserved space——在 Universe::genesis 中预分配]
- Step 3: `MetaspaceShared::map_shared_spaces()`→成功后→`UseSharedSpaces=true`→后续类加载走共享路径
- [C++: MAP_SHARED——多 JVM 进程共享同一物理页——MMU 映射到各自的虚拟地址——但物理页相同。节省 RAM——5 个 JVM 进程只需要一份 20MB Klass 元数据——vs 5×20MB=100MB]

### 2. SystemDictionaryShared — 共享类查找

**load_shared_class** (`systemDictionaryShared.cpp:50-250`):
- `SystemDictionaryShared::find_or_load_shared_class(Symbol* name, Handle class_loader, TRAPS)`: 先查 archive 中的 shared dictionary→如果有→返回映射后的 Klass*
- [C++: shared dictionary——在 CompactHashtable 中——key=Symbol*→value=Klass*。archive 中 Klass* 是 archive 内 offset——mmap 后→转换为实际 Klass*→`Klass* klass = (Klass*)(archive_base + offset)`。一步 deref]
- 验证: `SystemDictionaryShared::is_sharing_possible(class_loader)`→Bootstrap/Patform/App loader 的 shared class 可以——自定义 loader 的不能
- 如果 shared class 不存在→fallback 到普通类加载: `ClassLoader::load_classfile()->ClassFileParser→InstanceKlass`

### 3. CompactHashtable — mmap-ready 哈希表

**CompactHashtable** (`compactHashtable.hpp.cpp`):
- SymbolTable/StringTable 的共享版本——在 archive 中序列化为 offset-based 格式
- `CompactHashtable::lookup(Symbol* key)`: `int index = key->hash() % _bucket_count`→`u4 entry = _buckets[index]`——如果 entry 不为 0→`Symbol* value = (Symbol*)(_base_address + entry)`——O(1) lookup on mmap'd memory
- [C++: CompactHashtable 的关键——所有指针都是 archive base 的相对 offset——不是绝对地址。mmap 后——`_base_address` 被设为 archive 的实际映射地址——所有 lookup 自动通过 `base + offset` 转换。没有"更正"阶段——mmap 后直接可用]
- [C++: compact 格式——bucket count=2^N, entry format=4B offset (u4)。每个 entry 是 `key_hash` + `value_offset`(指向 Symbol 内容)。对比完整 HashTable: 标准格式每个 entry 有 pointer(8B)+next pointer(8B)→compact 每个 entry 只有 4B+4B→节省 50%]

---

### 核心悬念

**"CDS 让 JVM 启动跳过 2000 次 ClassFileParser 调用——全部核心类 mmap 后直接当内存读——CompactHashtable 在 mmap 上 O(1) 查找——无需初始化。"** — MAP_SHARED 让多 JVM 进程共享物理页——5 个 JVM 只需要 1 份 Klass 元数据。AppCDS (Java 10+) 允许应用类也共享。域 11 完成——Group 4 内存子系统全部结束。

> → domain 12: [Compiler Interface (ci) — JIT 编译器怎么看到 Java 类的元数据？ciKlass/ciMethod/ciField](../12-ci/01-ci-overview.md)
