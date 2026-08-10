# 01. CDS 全景 + Dump — 序列化 1000+ 核心类到 archive

> 🔴 Deep | 8 KP 中的 4 个核心机制
> 读者处境: `-Xshare:dump`——JVM 启动、加载核心类、dump 成 `.jsa` 文件——下次启动跳过类解析——秒加载。

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
