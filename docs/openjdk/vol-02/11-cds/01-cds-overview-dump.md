# 01. 启动时怎么让核心类秒加载？— CDS 全景与 Dump

> **前置依赖**:[44-class-verification/02 — VerificationType 类型系统](openjdk/vol-02/44-class-verification/02-verification-type.md):第 4 批收官,第 5 批从 VM 核心开始;[08-interpreter/04 — LinkResolver + Rewriter](openjdk/vol-02/08-interpreter/04-linkresolver-rewriter.md):CDS dump 里的字节码重写与 01 篇的 nofast 机制同源;[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):被 CDS 跳过的解析流程
> → **后续**:[11-cds/02 — mmap archive → shared spaces → 类就绪](02-cds-load-shared.md):mmap 之后共享类怎么进 SystemDictionary
> 关联域: 08-interpreter(字节码重写)、06-oops(Klass 结构)、10-metaspace(归档区域)、17-threads(VM 线程)

## 启动的重复劳动: 每次解析同一批类

JVM 每次启动都要加载 1000+ 核心类: 读 .class → ClassFileParser → Verifier → 生成 InstanceKlass → 链接。这批类的**解析结果每次启动都一模一样**——CDS(Class Data Sharing)的主意是把它们算一次、存进文件、以后直接映射: `-Xshare:dump` 生成 `.jsa` 归档,之后启动 `mmap` 它,核心类从 "shared objects file" 里直接取,跳过解析。这一篇拆 Dump 端: 归档里存什么、按什么布局、序列化到底做了什么。

[实证:] Temurin 11(08-cds-demo.txt,完整 dump 输出 08-cds-dump-full.txt): `-Xshare:dump` 归档了 **1211 个类**(Number of classes 1211,含 1151 个 instance class),生成 11.9MB 的 `cds.jsa`,输出 6 个实际使用的空间区;用这个 jsa 启动,`-Xlog:cds,class+load` 显示启动实际用到 **356 个类**、source 是 "shared objects file"——ClassFileParser 被绕过了。同时加载端打印归档创建时的**堆配置校验**(narrow_klass_base/narrow_oop 必须与 dump 时一致,否则归档作废)。

## 1. 全景: dump 与 load 是两条独立的启动路径

### 触发与入口

`-Xshare:dump` 让 JVM 走**归档模式**: 正常启动流程推进到一定阶段后转去 `MetaspaceShared::preload_and_dump`(metaspaceShared.cpp:1632),而不是进入业务代码。`-Xshare:on/auto/off` 控制 load 端行为(02 篇)。归档文件位置由 `-XX:SharedArchiveFile` 指定;默认路径由 `os::jvm_path` 推导 = **JVM 所在目录下的 classes.jsa**(arguments.cpp:3510-3529)。

### dump 流程: 不是"序列化",是"压实 + 重定位"

`preload_and_dump`(:1632-1697)的骨架:

1. 确定 classlist 路径(SharedClassListFile 或发行版自带的 `lib/classlist`);
2. `preload_classes`(:1699,ClassListParser)按清单加载类;
3. **`link_and_cleanup_shared_classes`**——大纲写的 "link_and_serialize" 不存在,真实是链接+清理漏网类(:1680);
4. `SystemDictionaryShared::finalize_verification_constraints`(:1691,44 域验证约束的归档化);
5. `VM_PopulateDumpSharedSpace op` 交给 **VM 线程**执行(:1694)。

重头戏在 `VM_PopulateDumpSharedSpace::doit`(metaspaceShared.cpp:1333-1410):

```cpp
// metaspaceShared.cpp:1333-1341(截取核心,逐字)
void VM_PopulateDumpSharedSpace::doit() {
  // We should no longer allocate anything from the metaspace, so that:
  //
  // (1) Metaspace::allocate might trigger GC if we have run out of
  //     committed metaspace, but we can't GC because we're running
  //     in the VM thread.
  // (2) ArchiveCompactor needs to work with a stable set of MetaspaceObjs.
  Metaspace::freeze();
```

**`Metaspace::freeze()` 冻结元空间**(此后不再分配——要压实必须保证对象集稳定)。随后: 收集所有已加载类(`ClassLoaderDataGraph::loaded_classes_do`)→ **`rewrite_nofast_bytecodes_and_calculate_fingerprints`**(:550,把字节码恢复成 nofast 形态——08-04 拆过的 `_nofast_*` 在此落地) → `combine_shared_dictionaries`(平台/系统字典并入引导字典) → **`remove_java_mirror_in_classes`**(:501,剥离每个 Klass 的 java_mirror,08-cds-dump-full.txt 的 "Removing java_mirror ... done" 就是它)与 **`remove_unshareable_in_classes`**(:489,remove_unshareable_info 剥离其余不可共享信息)——两个独立函数别混淆 → **`ArchiveCompactor::initialize + copy_and_compact`**(核心动作,下一节) → `dump_symbols`/`dump_java_heap_objects`(Symbol 与字符串/堆对象) → `relocate_well_known_klasses`。

**关键设计 (斜体)**: *"序列化 C++ 对象"在这里不是逐个对象递归写(大纲的描述),而是 **compaction**: 把 Metaspace 里散布的对象搬到一块连续内存,同时把对象内部指针从"绝对地址"改成"相对归档基址的偏移"。搬运与重定位一次完成——`ArchiveCompactor::copy_and_compact`。*

## 2. 归档布局: 6 个实际使用的空间区

### region 表: 不是 5 个,是 8 个槽位

大纲说 "5 个 space: mc/rw/ro/md/od"——**错**: `od`(OptionalData)是旧版;JDK 11 的 region 枚举(metaspaceShared.hpp:70-84,截取核心,逐字):

```cpp
// metaspaceShared.hpp:66-85(截取核心,逐字)
  enum {
    // core archive spaces
    mc = 0,  // miscellaneous code for method trampolines
    rw = 1,  // read-write shared space in the heap
    ro = 2,  // read-only shared space in the heap
    md = 3,  // miscellaneous data for initializing tables, etc.
    num_core_spaces = 4, // number of non-string regions

    num_non_heap_spaces = 4,

    // mapped java heap regions
    first_string = md + 1, // index of first string region
    max_strings = 2, // max number of string regions in string space
    last_string = first_string + max_strings - 1,
    first_open_archive_heap_region = first_string + max_strings,
    max_open_archive_heap_region = 2,

    last_valid_region = first_open_archive_heap_region + max_open_archive_heap_region - 1,
    n_regions =  last_valid_region + 1 // total number of regions
  };
```

**4 个核心空间(mc/rw/ro/md)+ 2 个字符串区 + 2 个 open archive 堆区 = 8 个槽位**。实证的 dump 输出恰好印证(08-cds-demo.txt):

```
mc  space:      8128 [  0.1% of total] out of      8192 bytes [ 99.2% used] at 0x0000000800000000
rw  space:   3971752 [ 33.4% of total] out of   3973120 bytes [100.0% used] at 0x0000000800002000
ro  space:   7159592 [ 60.3% of total] out of   7159808 bytes [100.0% used] at 0x00000008003cc000
md  space:      2560 [  0.0% of total] out of      4096 bytes [ 62.5% used] at 0x0000000800aa0000
st0 space:    442368 [  3.7% of total] out of    442368 bytes [100.0% used] at 0x00000007bfe00000
oa0 space:    290816 [  2.4% of total] out of    290816 bytes [100.0% used] at 0x00000007bfc00000
total    :  11875216 [100.0% of total] out of  11878400 bytes [100.0% used]
```

本次 dump 用了 6 个(两个字符串区用了一个、两个 open archive 区用了一个)。**rw 与 ro 占 93%**——`ro` 是只读元数据(Symbol 等),`rw` 是加载后要写的部分。地址从 `0x0000000800000000` 起——**mmap 的固定基址**,这是指针重定位的前提(下一节)。

**关键设计 (斜体)**: *为什么要分 rw/ro?归档映射后,ro 区可以只读映射(页级保护,防篡改、可共享),rw 区允许写(如方法入口地址等加载时才确定的内容)。mc 是可执行代码(方法 trampoline)。字符串与 open archive 区进 Java 堆——它们是堆对象,与元数据分开管理。*

## 3. 文件格式: magic、版本、路径表

### 头与校验

归档文件的头部(filemap.hpp:37 注释,截取核心,逐字):

```cpp
// filemap.hpp:36-42(截取核心,逐字)
//  header: dump of archive instance plus versioning info, datestamp, etc.
//   [magic # = 0xF00BABA2]
//  ... padding to align on page-boundary
//  read-write space
//  read-only space
//  misc data (block offset table, string table, symbols, dictionary, etc.)
//  tag(666)
```

大纲写的 magic "0xF00BAAA2" 少了一个 B——真实是 **0xF00BABA2**。加载端 `validate_header`(filemap.cpp:1397)先做 `_header->validate()`(magic/版本/CRC 等)+ `check_shared_paths_misc_info` 的路径信息校验;**映射之后**还有 `validate_shared_path_table`(filemap.cpp:480,源码注释 "this is done later, because the table is in the RW",:1310-1311)校验 **classpath 表**——dump 时与 load 时的类路径必须一致,否则归档里类的来源可能对不上。**堆配置校验**(实证里的 narrow_klass_base/narrow_oop)——压缩指针参数与 dump 时不同,整个归档的指针重定位就失效,归档直接作废。

### 指针重定位: 为什么地址能固定

压缩 klass 指针与归档基址的"重合"是**主动设计**: dump 时 `Universe::set_narrow_klass_base((address)_shared_rs.base())`(metaspaceShared.cpp:305)把窄指针基址**设成共享区基址**——于是归档里任意对象的地址 = narrow_klass_base + 窄指针值,指针按这个地址计算;load 时在同一地址 mmap,只读区指针**原样有效**、无需现场修复(rw 区仍有少量加载期 patch,02 篇)。这就是实证里 `narrow_klass_base = 0x0000000800000000` 与 "Allocated shared space ... at 0x0000000800000000" 一致的原因。如果 load 时压缩指针参数不匹配,地址空间对不上 → 校验失败。

## 4. classlist: dump 加载什么

classlist 文件每行一个类名(发行版自带,位于 `lib/classlist`;dump 时实际归档 1211 个类,含清单外被依赖的类)。`ClassListParser`(classListParser.cpp:46 构造、:78 parse_one_line)逐行读取: `#` 注释跳过、tab/换行归一为空格、切分出类名(:78-110)——**它只做行解析,不碰 SymbolTable/类加载**;真正的加载在下面的 `ClassLoaderExt::load_one_class`。`preload_classes`(metaspaceShared.cpp:1699 起,截取核心,逐字):

```cpp
// metaspaceShared.cpp:1699-1705(截取核心,逐字)
int MetaspaceShared::preload_classes(const char* class_list_path, TRAPS) {
  ClassListParser parser(class_list_path);
  int class_count = 0;

    while (parser.parse_one_line()) {
      Klass* klass = ClassLoaderExt::load_one_class(&parser, THREAD);
```

逐类经 `ClassLoaderExt::load_one_class` 走正常类加载流程(ClassFileParser→验证→链接)变成 InstanceKlass——**dump 模式复用完整的加载管线,只是把产物留下**;找不到的类打 "Preload Warning" 后继续(:1705-1710)。清单外被依赖的类(如接口的父接口)也会被加载(`link_and_cleanup_shared_classes` 补链,:1680)。

## 核心悬念

Dump 端拆完了: `-Xshare:dump` → preload_and_dump(预加载+链接清理)→ VM 线程上的 `VM_PopulateDumpSharedSpace::doit`(冻结元空间、nofast 重写、去除不可共享信息、**ArchiveCompactor 压实+重定位**、符号与字符串归档);产物是 8 槽位布局(实际用 6 个)的 jsa 文件,头带 magic(0xF00BABA2)/版本/CRC/路径表,堆配置与 dump 时必须一致;classlist 驱动预加载。核心思想一句话: **把"解析结果"变成"可映射的内存镜像",指针靠固定基址免修复**。

但 dump 只是把镜像写好——下一次启动,`mmap` 之后这些类怎么进入 SystemDictionary、怎么做到"看起来像刚解析过"?那是 Load 端的事: 映射、校验、字典登记、字符串/堆对象恢复。

> → [11-cds/02 — mmap archive → shared spaces → 类就绪](02-cds-load-shared.md)
