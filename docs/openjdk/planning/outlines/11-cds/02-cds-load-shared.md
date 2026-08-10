# 02. Load — mmap archive → shared spaces → 类就绪

> 🔴 Deep | 8 KP 中的 3 个核心机制
> 读者处境: JVM 第二次启动——`-Xshare:on`→mmap `classes.jsa`→Metaspace 预置区映射到 archive→SystemDictionary 查 shared 类→跳过 ClassFileParser。

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
