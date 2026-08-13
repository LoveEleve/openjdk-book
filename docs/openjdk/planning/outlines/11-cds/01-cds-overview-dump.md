# 01. CDS 全景 + Dump — 序列化 1000+ 核心类到 archive

> 🔴 Deep | 8 KP 中的 4 个核心机制
> 读者处境: `-Xshare:dump`——JVM 启动、加载核心类、dump 成 `.jsa` 文件——下次启动跳过类解析——秒加载。

> ⚠️ 写作期修正(2026-08-13, vol-02/11-cds/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"magic 0xF00BAAA2" 错**: 真实 **0xF00BABA2**(filemap.hpp:37);validate_header(filemap.cpp:1397)=header->validate(magic/版本/CRC)+check_shared_paths_misc_info;validate_shared_path_table(:480)在**映射后**才做(注释 "this is done later",:1310-1311)
> - **"5 个 space mc/rw/ro/md/od" 错**: od 是旧版;JDK11 region 枚举(metaspaceShared.hpp:66-85)=**mc/rw/ro/md 4 核心 + string×2 + open archive×2 = 8 槽位**(实证 dump 用了 6 个: mc/rw/ro/md/st0/oa0)
> - **"link_and_serialize" 不存在(编造)**: 真实=link_and_cleanup_shared_classes(preload_and_dump :1680)+VM_PopulateDumpSharedSpace::doit(:1333-1410: Metaspace::freeze 冻结→收集类→rewrite_nofast_bytecodes_and_calculate_fingerprints(08-04 nofast 落地)→combine_shared_dictionaries→remove_unshareable_in_classes(实证 Removing java_mirror)→ArchiveCompactor::initialize+copy_and_compact(压实+重定位)→dump_symbols/dump_java_heap_objects→relocate_well_known_klasses)
> - **行号漂**: preload_and_dump :1632(大纲 200-600 错);preload_classes :1699(ClassLoaderExt::load_one_class 逐类加载,非大纲的"SystemDictionary::load_shared_class");ClassListParser :46 构造/:78 parse_one_line(只做行解析:# 注释/tab 归一/切分,不碰 SymbolTable)
> - **序列化本质(大纲"逐个对象递归写"半对)**: 是 compaction——对象搬连续内存+指针改相对偏移,一次完成
> - **默认归档路径**: SharedArchiveFile 缺省时 = os::jvm_path 推导的 JVM 同目录 classes.jsa(arguments.cpp:3510-3529),非"jre/lib/server"
> - **实证**: 08-cds-demo.txt + 08-cds-dump-full.txt(dump 归档 1211 类含 1151 instance;jsa 11.9MB;6 空间区;启动 class+load 356 个 shared objects file;narrow_klass_base=0x0000000800000000 与归档基址重合=指针免修复;堆配置校验)


### 1. CDS 是什么 — 为什么能加速启动？

场景: JVM 启动加载 1000+ 核心类 (Object/String/Class/ArrayList/HashMap/...)。每个类: 读 .class→ClassFileParser→Verifier→InstanceKlass→Metaspace。1000 次 ClassFileParser = 启动时间的 40%。**CDS 把这些 Klass 存到文件——下次 mmap 直接当内存读——全部跳过。**

**Dump 流程** (`metaspaceShared.cpp:200-600`):
- `-Xshare:dump`: JVM 启动→加载 classlist 指定的核心类→`MetaspaceShared::preload_and_dump(TRAPS)`
- Step 1: `ClassListParser::parse_classlist(classlist_file)`→读取 ~2000 个类名
- Step 2: `SystemDictionary::load_shared_class(...)`→逐类加载→ClassFileParser→InstanceKlass→存到 Metaspace
- Step 3: `MetaspaceShared::link_and_serialize()`→遍历所有已加载 Klass→`MetaspaceShared::serialize(klass, writer)`→写 C++ 对象的内存内容到 archive buffer
- Step 4: `MetaspaceShared::relocate_pointers()`→修正 Klass 内部的指针 (Method*/ConstantPool*/Symbol*)——从绝对地址改为 archive 内的 offset——因为 mmap 后的 base 地址不同
- Step 5: `FileMapInfo::write_archive(file, buffer, size)`→写 `.jsa` 文件——header+regions table+data
- [C++: Serialize——不是 C++ 的 memcpy——是 deep copy。`Klass::serialize(writer)`→`writer->write(klass, sizeof(InstanceKlass))`→然后遍历 klass 内部的所有引用→serialize 每个被引用对象→递归。结果: 一个 Klass 的完整对象树被序列为连续字节]

**classlist** (`classListParser.cpp:50-150`):
- `classlist` 文件格式: 每行一个类名——`java/lang/Object`, `java/lang/String`, `java/lang/Class`, ...
- `ClassListParser::parse_one_line()`: 读下一行→trim→`SymbolTable::new_symbol`→加 SystemDictionary 预加载列表
- [C++: classlist 的作用——dump mode 时 JVM 启动只加载 classlist 中的类 (不加载全部 rt.jar/modules)——因为这些是要 dump 的核心类。load mode 时——mmap archive 后——这些类已就绪——不再加载]

### 2. FileMap — .jsa 文件格式

**FileMapHeader** (`filemap.hpp:50-120`):
- `_magic` (4B): `0xF00BAAA2` (CDS magic)
- `_version` (4B): CDS archive version——JVM build 不匹配→验证失败
- `_crc` (4B): header 的 CRC——检测文件损坏
- `_space[MetaspaceShared::n_regions]`: 每个 space (mc/rw/ro/md/od) 的 `_addr/_used/_mapped_base`——mmap 后的实际地址
- [C++: regions——archive 分为 5 个 space: mc(MiscCode——C2 adapter)/rw(ReadWrite——Method metadata)/ro(ReadOnly——SymbolTable)/md(MiscData——profiling data)/od(OptionalData——optional region)。每个有独立的 base+size。mmap 时分别 mapping 到对应的 Metaspace 预留地址]

**validate_archive** (`filemap.cpp:100-200`):
- `FileMapInfo::validate_header()`: magic→version→CRC
- `FileMapInfo::validate_shared_path_table()`: classpath CRC 检查——dump 时和 load 时的 classpath 必须一致——否则 archive 中的类引用可能指向错误的 classfile

---

### 核心悬念

**"`-Xshare:dump`→JVM 启动→加载 2000 个核心类→序列化全部 Klass+Method+ConstantPool→写 `.jsa`→下次启动→mmap→秒过 ClassFileParser。"** — 每个 Klass 的内部指针被 relocate 为 archive offset——mmap 后自动指向正确的 Metaspace 地址。下一个: Load 端——mmap 后怎么在 SystemDictionary 中找共享类。

> → [02-cds-load-shared.md](02-cds-load-shared.md)
