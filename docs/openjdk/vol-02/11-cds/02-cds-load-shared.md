# 02. mmap 之后共享类怎么进 SystemDictionary？— mmap archive → shared spaces → 类就绪

> **前置依赖**:[11-cds/01 — 启动时怎么让核心类秒加载？— CDS 全景与 Dump](01-cds-overview-dump.md):dump 产物是"压实 + 重定位"后的内存镜像,这一篇拆怎么把它装回去;[07-classfile-classloader/04 — SystemDictionary — 类的"全球电话号码本"](openjdk/vol-02/07-classfile-classloader/04-system-dictionary.md):共享类最终要登记进的字典结构;[08-interpreter/04 — 符号引用怎么变成直接引用？— LinkResolver + Rewriter](openjdk/vol-02/08-interpreter/04-linkresolver-rewriter.md):归档字节码是 nofast 形态,load 端不重写;[44-class-verification/01 — 恶意字节码怎么被拦下？— ClassVerifier 类型检查引擎](openjdk/vol-02/44-class-verification/01-verifier.md):44 域埋下的验证约束在 load 端兑现;[09-memory-core/01 — Universe + CollectedHeap — JVM 的"宇宙大爆炸"](openjdk/vol-02/09-memory-core/01-universe-heap.md):initialize_shared_spaces 的调用点在 Universe::genesis
> → **后续**:[12-ci/01 — ciObject 镜像体系 — JIT 怎么看到 Java 类？](openjdk/vol-02/12-ci/01-ci-overview-mirror.md):JIT 编译器怎么消费这些共享元数据
> 关联域: 10-metaspace(压缩类空间与 CDS 相邻)、06-oops(Klass/Method 结构恢复)、17-threads(类加载锁)

## 第二次启动: 类从"共享对象文件"里来

同一个 JDK,`-Xshare:dump` 生成了归档(01 篇),第二次启动时它就在那里。`java -version` 的版本行末尾多了一个后缀 "sharing"——意味着这次启动真的用上了归档;`-Xlog:class+load` 里 `java.lang.Object` 的 source 是 **"shared objects file"**,而不是 `jrt:/java.base`——ClassFileParser 被绕过了。但"绕过解析"只是结果,问题是: **mmap 之后,这些类凭什么"看起来像刚解析过"?** 这一篇拆 Load 端,按启动时序走: 参数与校验(能不能用)→ 映射(放到哪)→ 装配(怎么解释)→ 加载(怎么进字典)→ 恢复(怎么激活)。

## 1. 入口与参数: -Xshare:on/auto/off 的语义

归档加载的开关在参数阶段就定了。`UseSharedSpaces` 默认 **true**、`RequireSharedSpaces` 默认 **false**(globals.hpp:2484/2491)——即默认是 **auto** 行为: 归档能用就用,不能用就静默回退。命令行显式指定三态(arguments.cpp:2781-2801):

- `-Xshare:on` → `UseSharedSpaces=true` + `RequireSharedSpaces=true`(:2781-2786)——**必须**用上,失败就退出;
- `-Xshare:auto` → true + RequireSharedSpaces=false(:2789-2793)——失败回退;
- `-Xshare:off` → UseSharedSpaces=false(:2797-2801)。

`RequireSharedSpaces` 是"必须成功"与"失败可回退"的全部区别,下面每一道校验的门都用它决定是退出还是关共享继续跑。另外两个前置约束: 压缩指针必须开(UseCompressedOops/UseCompressedClassPointers 都要求,arguments.cpp:3501-3503)——窄指针是 01 篇指针重定位的数学基础;归档路径缺省由 `os::jvm_path` 推导,拼上 `classes.jsa`(arguments.cpp:3510-3524)。[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/11-cds-load-demo.txt) 无 `-XX:SharedArchiveFile` 时 dump 产物落在 **`lib/server/classes.jsa`**(jvm_path 解析到 lib/server 目录)。

启动链走到内存子系统时,`Metaspace::global_initialize`(metaspace.cpp:1294)按 UseSharedSpaces 分流(:1300-1305)→ `MetaspaceShared::initialize_runtime_shared_and_meta_spaces`(metaspaceShared.cpp:216)。真正的动作在 :229 一行: `mapinfo->initialize() && map_shared_spaces(mapinfo)`——**先校验、后映射**,两步都不行就进 else 分支断言"归档未关且共享已关"。后面三节拆这两步。

## 2. 第一道门: 打开与校验——这份归档我能不能用

打开一个 11MB 的文件之前要先想清楚: 这份归档是另一台机器、另一个 build 上 dump 的,当前进程到底能不能用?**能提前做的校验必须在映射之前完成**——因为映射是 MAP_FIXED,直接覆盖预留地址,映射完再发现不对就晚了(classpath 表坐在 RW 区里,只能等映射完再验,见本节的"三次校验")。

`FileMapInfo::initialize`(filemap.cpp:1313)依次做: ① 检查 JVMTI 早阶段 ClassFileLoadHook——钩子存在意味着系统类可能被替换,禁用 CDS(:1316-1323);② `open_for_read`(:617,`os::open` O_RDONLY);③ `init_from_file`(:524)读 `FileMapHeader` 整块并逐项核对;④ `validate_header`(:1397)做第二层校验。`init_from_file` 的核对项: magic、版本、JVM 标识、CRC:

```cpp
// filemap.cpp:537-543(截取核心,逐字)
  unsigned int expected_magic = CDS_ARCHIVE_MAGIC; // is_static ? CDS_ARCHIVE_MAGIC : CDS_DYNAMIC_ARCHIVE_MAGIC;
  if (_header->_magic != expected_magic) {
    log_info(cds)("_magic expected: 0x%08x", expected_magic);
    log_info(cds)("         actual: 0x%08x", _header->_magic);
    FileMapInfo::fail_continue("The shared archive file has a bad magic number.");
    return false;
  }
```

[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/11-cds-load-demo.txt) 把归档前 4 字节改成 0,启动即报 `_magic expected: 0xf00baba2 / actual: 0x00000000 / UseSharedSpaces: The shared archive file has a bad magic number.`——auto 模式下一行日志后继续启动(版本行少了 "sharing");`-Xshare:on` 则是另一个极端(素材里以"归档不存在"触发): `An error has occurred while processing the shared archive file. / Error occurred during initialization of VM / Unable to use shared archive.`,进程直接退出。

其余核对项: `_version` 与 CURRENT_CDS_ARCHIVE_VERSION(:545-550);`_jvm_ident` 字符串——**不同 build 的 libjvm.so 不共享**,否则常量池布局、符号表格式全对不上(:561-574);`VerifySharedSpaces` 开启时 `_header->compute_crc()` 校验头部 CRC(:576-584);最后按头里记录的最后一个 region 偏移检查文件是否被截断(:602-608)。

第二层 `validate_header`(:1397)调用 `_header->validate()`(filemap.cpp:1359): `ObjectAlignmentInBytes` 必须一致(:1360)、`CompactStrings` 设置必须一致(:1366)、**验证设置不能比 dump 时更严**(:1384-1392,归档类当时通过的是宽松验证,44 域的"验证约束延迟化"是配套)——再加 `ClassLoader::check_shared_paths_misc_info` 对路径信息串(:1401)。

**关键设计 (斜体)**: *归档的校验是分三次做的——头部现在做(init_from_file + validate_header)、每个 region 的 CRC 在映射时做(map_region 里 `verify_region_checksum`,filemap.cpp:919)、classpath 表在 RW 区映射后做(`validate_shared_path_table`,filemap.cpp:480,源码注释明说 "this is done later, because the table is in the RW")。原因很朴素: 校验对象坐在不同的位置,读得到的时候才校。所有"可恢复错误"汇到一个出口 `fail_continue`(filemap.cpp:102): 打一行日志、`UseSharedSpaces = false`、close 文件(:124-126);`RequireSharedSpaces` 为 true 时它在同一点改走 `fail` 直接退出(:114-115)——三处校验共用这一个开关,*这就是第一节说的"全部区别"的落点*。*

## 3. 第二道门: mmap——必须落在"原来"的地址

校验通过后,`map_shared_spaces`(metaspaceShared.cpp:2034)把 4 个核心空间(mc/rw/ro/md)映射进进程。这里没有"读文件解析"的余地——**一个字节都不能换位置**:

```cpp
// metaspaceShared.cpp:2052-2074(截取核心,逐字)
  // Map each shared region
  if ((mc_base = mapinfo->map_region(mc, &mc_top)) != NULL &&
      (rw_base = mapinfo->map_region(rw, &rw_top)) != NULL &&
      (ro_base = mapinfo->map_region(ro, &ro_top)) != NULL &&
      (md_base = mapinfo->map_region(md, &md_top)) != NULL &&
      (image_alignment == (size_t)os::vm_allocation_granularity()) &&
      mapinfo->validate_shared_path_table()) {
    // Success -- set up MetaspaceObj::_shared_metaspace_{base,top} for
    // fast checking in MetaspaceShared::is_in_shared_metaspace() and
    // MetaspaceObj::is_shared().
    //
    // We require that mc->rw->ro->md to be laid out consecutively, with no
    // gaps between them. That way, we can ensure that the OS won't be able to
    // allocate any new memory spaces inside _shared_metaspace_{base,top}, which
    // would mess up the simple comparision in MetaspaceShared::is_in_shared_metaspace().
    assert(mc_base < ro_base && mc_base < rw_base && mc_base < md_base, "must be");
    assert(md_top  > ro_top  && md_top  > rw_top  && md_top  > mc_top , "must be");
    assert(mc_top == rw_base, "must be");
    assert(rw_top == ro_base, "must be");
    assert(ro_top == md_base, "must be");

    MetaspaceObj::set_shared_metaspace_range((void*)mc_base, (void*)md_top);
    return true;
```

细节: 映射前先 `reserve_shared_memory`(filemap.cpp:869)以 `core_spaces_size` 在归档记录的首地址预留整块 ReservedSpace——注释说得很直白: *先留位,否则 mmap 会盖掉别的预留内存(比如 code cache)*。然后逐个 `map_region`(filemap.cpp:891): 目标地址 `region_addr(i)` 从归档头读出,`size` 按页对齐,权限来自 dump 时写下的属性(metaspaceShared.cpp:1458-1461: mc=RW+可执行、rw=RW、ro=只读、md=RW)。真正的系统调用在平台层:

```cpp
// os_linux.cpp:6129-6150(截取核心,逐字)
char* os::pd_map_memory(int fd, const char* file_name, size_t file_offset,
                        char *addr, size_t bytes, bool read_only,
                        bool allow_exec) {
  int prot;
  int flags = MAP_PRIVATE;

  if (read_only) {
    prot = PROT_READ;
  } else {
    prot = PROT_READ | PROT_WRITE;
  }

  if (allow_exec) {
    prot |= PROT_EXEC;
  }

  if (addr != NULL) {
    flags |= MAP_FIXED;
  }

  char* mapped_address = (char*)mmap(addr, (size_t)bytes, prot, flags,
                                     fd, file_offset);
```

[C++:] 这里要纠正一个直觉: 用的是 **MAP_PRIVATE 不是 MAP_SHARED**。多进程共享同一份物理页,靠的是 file-backed mmap 的**页缓存**——所有进程读同一个文件页,OS 只缓存一份;MAP_SHARED 与 MAP_PRIVATE 的区别只在写传播语义(共享映射回写文件,私有映射**写时复制**——所以只读区(ro)才是纯共享,可写的 rw/mc 一旦被加载期 patch 写脏,该页就 COW 成进程私有)。**MAP_FIXED**(addr 非空时,:6145-6146)把文件页钉死在 requested_addr,配合先行的整块预留(见上),保证不会盖到其他预留内存——它本身不报错(目标地址被占用时是静默替换),所以 map_region 还要用 `base != requested_addr` 兜底检查(filemap.cpp:908-911)。

**关键设计 (斜体)**: *为什么必须同址?01 篇的压实把所有内部指针从"绝对地址"改成了"距归档基址的偏移"——dump 时 `Universe::set_narrow_klass_base(_shared_rs.base())` 让窄指针与归档基址重合(metaspaceShared.cpp:305)。因此只要 load 端在同一地址映射,ro 区指针原样有效、零修正;rw 区仍有少量**加载期 patch**——方法入口 trampoline 与适配器槽在运行期才填(第 6 节),这正是 01 篇留给 02 篇的尾巴;代价是这段地址空间在启动时必须真空——被别的预留(堆、code cache)占了就映射失败,auto 模式回退,on 模式退出(:2088-2092)。*

映射成功后还有两件收尾: ① 压缩类空间紧贴 CDS 之上分配(`Metaspace::allocate_metaspace_compressed_klass_ptrs(cds_end, cds_address)`,metaspaceShared.cpp:238,布局见 10-03 域)并设 `narrow_klass_range`(:243);② `map_heap_regions`(:241 → filemap.cpp:1096)——把字符串区(st0)和 open archive 区(oa0)映射进 **G1 堆**: `map_heap_data` 在堆里 `alloc_archive_regions` 划出归档区(filemap.cpp:1140)再 mmap 数据。JDK11 的堆区允许搬家: oop 编码不一致时按 `runtime_heap_end - dumptime_heap_end` 算 relocation delta(filemap.cpp:1042-1058),由 oopmap 在加载期修补(`patch_archived_heap_embedded_pointers`,filemap.cpp:1188);[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/11-cds-load-demo.txt) 同配置启动打印 `relocation delta = 0 bytes`,`-Xmx1g` 启动打印 `incompatible oop encoding mode` + `delta = -28991029248 bytes`,归档照用。**压缩类指针(narrow klass)**编码不一致则整段堆数据弃用(filemap.cpp:1021-1025)。

## 4. 第三道门: initialize_shared_spaces——装配"杂项数据"

映射只把字节放到了地址上;"这些字节怎么解释"还差一批数据要装配: **vtable 内容**(函数地址是运行期才知道的)、共享字典桶数组的定位(长度/条目数藏在 RW 区数据里)、well-known 类指针、符号/字符串表、java 类字段偏移。装配发生在 `Universe::genesis` 里(universe.cpp:722-741,UseSharedSpaces 分支先 `MetaspaceShared::initialize_shared_spaces()` 再 `StringTable::create_table()`),函数在 metaspaceShared.cpp:2100,按顺序:

1. 从头部读回 `_cds_i2i_entry_code_buffers`(mc 区里解释器入口 trampoline 缓冲的地址)与 `_core_spaces_size`(:2102-2104);
2. **`clone_cpp_vtables`**(:2106)——归档里的 Metadata 对象(InstanceKlass/Method/ConstantPool 等 8 类,`CPP_VTABLE_PATCH_TYPES_DO`,:591-599)的 C++ vtable 指针在 dump 时被指向 md 区里的"克隆表"(`patch_cpp_vtable_pointers`,:771),克隆内容写盘前由 `zero_cpp_vtable_clones_for_writing` 清零(:751);load 时把**当前 libjvm.so 的真实 vtable 现拷进去**(`CppVtableCloner::clone_vtable`,:667-681,memcpy 在 :680)。原因: libjvm.so 可能被加载到不同基址,vtable 里的函数地址跨进程会变,所以 vtable 内容不能进归档;
3. **共享字典**: 从 RW 区的 `read_only_tables_start` 读出长度与条目数,直接 cast 成 `HashtableBucket` 数组交给 SystemDictionary(:2110-2117)——字典整个在归档里,零解析;
4. `HeapShared::read_archived_subgraph_infos`(:2127)读堆对象子图记录;
5. **`serialize(&rc)`**(:2133,ReadClosure 在 :1957)——一段带 tag 校验的流式读取,结构在 `MetaspaceShared::serialize`(:400-432): 先核对 sizeof(Method/ConstMethod/ConstantPool/Symbol...) 等结构体尺寸(:405-412),再读 well-known 类(`Universe::serialize`,universe.cpp:249 起,如 `_objectArrayKlassObj`)、常用名字签名(`vmSymbols::serialize`)、**两个 CompactHashtable**(SymbolTable/StringTable,见第 7 节)、java 类字段偏移(`JavaClasses::serialize_offsets`,如 java_lang_String 的 value 字段 offset),最后 tag 666 收尾(:431)。任何 tag 不匹配 → 归档作废;
6. `SymbolTable::create_table()`(:2136)建动态符号表;`patch_archived_heap_embedded_pointers`(:2138)按 delta 修正堆对象内嵌 oop;`close()`(:2141)关文件——此后归档文件不再被访问,内存里已全部就位。

```cpp
// metaspaceShared.cpp:2105-2117(截取核心,逐字)
  char* buffer = mapinfo->misc_data_patching_start();
  clone_cpp_vtables((intptr_t*)buffer);

  // The rest of the data is now stored in the RW region
  buffer = mapinfo->read_only_tables_start();
  int sharedDictionaryLen = *(intptr_t*)buffer;
  buffer += sizeof(intptr_t);
  int number_of_entries = *(intptr_t*)buffer;
  buffer += sizeof(intptr_t);
  SystemDictionary::set_shared_dictionary((HashtableBucket<mtClass>*)buffer,
                                          sharedDictionaryLen,
                                          number_of_entries);
```

**关键设计 (斜体)**: *两段式初始化——"纯字节"的部分(mmap 区)映射完直接可用;"带地址/带代码"的部分(vtable 克隆、字典指针、well-known 类)靠 serialize 流装配。tag 机制保证 dump/load 两端对同一批 C++ 结构体的 sizeof 完全一致,不一致(跨 build)当场失败,而不是跑起来才崩。*

## 5. 类加载: 三条路进字典

装配完成,字典和符号表都活了。现在 `Class.forName("java.lang.Object")` 或加载一个应用类,共享类是怎么从"归档里的 InstanceKlass"变成"SystemDictionary 里的活类"的?取决于发起者,有三条路。

**路 1(引导加载器)**: `SystemDictionary::load_instance_class`(systemDictionary.cpp:1403)在解析前先查共享字典(:1463-1470)→ `load_shared_class(name, loader)`(:1165)→ `find_shared_class`(:1147,按 hash 进桶遍历 `Dictionary::find_shared_class`,dictionary.cpp:361,无锁——表是静态的)→ 仅当是 **boot 类且 loader 为 NULL** 才继续(:1169-1173),否则返回 NULL 走普通解析。

**路 2(AppCDS 快路径,Platform/App 加载器)**: JDK 侧 `BuiltinClassLoader.loadClassOrNull`(BuiltinClassLoader.java:590)先 `findLoadedClass(cn)`(:593)→ native `JVM_FindLoadedClass`(jvm.cpp:962)。注意这个 native 不只是"查已加载": 查不到时(:996-1000)调用 `SystemDictionaryShared::find_or_load_shared_class`——**既查共享字典又当场加载**。注释(:471-478)明说这是对 findLoadedClass 的拦截: 省掉 classfile 解码 + 父加载器委托。函数本身(骨架见下): 三重门(UseSharedSpaces + 归档含 platform/app 类 + 加载器是 system/platform,:483-490)→ 先查加载器自己的字典防重复(:515-519)→ `load_shared_class_for_builtin_loader`(:530): 在共享字典里 `find_class_for_builtin_loader`(:534 → systemDictionaryShared.cpp:991,桶遍历)→ 检查归档类的 `is_shared_app_class`/`is_shared_platform_class` 与当前加载器匹配(:538-541)→ `load_shared_class(ik, ...)`(:544)→ `define_instance_class` 登记(:523)。

```cpp
// systemDictionaryShared.cpp:480-528(截取核心,逐字)
InstanceKlass* SystemDictionaryShared::find_or_load_shared_class(
                 Symbol* name, Handle class_loader, TRAPS) {
  InstanceKlass* k = NULL;
  if (UseSharedSpaces) {
    if (!FileMapInfo::current_info()->header()->has_platform_or_app_classes()) {
      return NULL;
    }

    if (shared_dictionary() != NULL &&
        (SystemDictionary::is_system_class_loader(class_loader()) ||
         SystemDictionary::is_platform_class_loader(class_loader()))) {
      // Fix for 4474172; see evaluation for more details
      class_loader = Handle(
        THREAD, java_lang_ClassLoader::non_reflection_class_loader(class_loader()));
      ClassLoaderData *loader_data = register_loader(class_loader);
      Dictionary* dictionary = loader_data->dictionary();

      unsigned int d_hash = dictionary->compute_hash(name);

      bool DoObjectLock = true;
      ...
      {
        MutexLocker mu(SystemDictionary_lock, THREAD);
        Klass* check = find_class(d_hash, name, dictionary);
        if (check != NULL) {
          return InstanceKlass::cast(check);
        }
      }

      k = load_shared_class_for_builtin_loader(name, class_loader, THREAD);
      if (k != NULL) {
        define_instance_class(k, CHECK_NULL);
      }
    }
  }
  return k;
}
```

**路 3(自定义加载器)**: `defineClass` 走 `SystemDictionary::parse_stream` 时调 `lookup_from_stream`(systemDictionary.cpp:1072 → systemDictionaryShared.cpp:585): 只处理非 builtin 加载器(:596-601);共享字典里没有名字匹配就直接放弃(:607-610);有则按 **(类名, classfile 长度, crc32)** 三元组精确匹配 UNREGISTERED 条目(:612-616)——自定义加载器无法用类名保证身份,用字节指纹;命中后 `acquire_class_for_current_thread`(:628)在 `SharedDictionary_lock` 下认领(防多线程重复加载,已认领返回 NULL,:637-646),再走 `load_shared_class`。

**关键设计 (斜体)**: *共享字典是 `SharedDictionary : public Dictionary`(systemDictionaryShared.hpp:162)——可链式增长的 Hashtable,不是第 7 节的 CompactHashtable。原因: dump 端要往里逐类插条目并挂每类的附加信息(验证约束、id、classpath 索引、crc,`SharedDictionaryEntry`,:113 起),运行端则只读遍历。boot 类查找无锁,因为表头在归档里就是静态的——"查共享类"与"查符号/字符串"用两套表结构,正是这个原因。*

## 6. 激活: restore_unshareable_info——"看起来像刚解析过"

拿到归档里的 `InstanceKlass*` 只是第一步: 它的 java_mirror 是 NULL(dump 时 `remove_java_mirror` 剥离了,但镜像对象本身若可归档会以 "raw archived mirror" 存进开放归档区),方法入口指向 mc 区 trampoline,常量池的 resolved_references 数组要重建。要真正"就绪",`load_shared_class(ik, ...)`(systemDictionary.cpp:1270)还要过四关:

1. **可见性** `is_shared_class_visible`(:1183): 归档类的 `shared_classpath_index < 0` 表示留给自定义加载器,builtin 加载器不得用(:1191-1199);模块被 patch 过的类不能共享(:1226-1228);模块 location 必须与 dump 时一致(:1236-1241);
2. **超类/接口重解析**: 逐个 `resolve_super_or_fail` 且**必须与归档里的同一个对象**(:1292-1318)——ik 的布局依赖超类布局,超类变了就不能用(注释 :1285-1290);
3. **CFLH**: `KlassFactory::check_shared_class_file_load_hook`(:1320),钩子改过类就弃用归档版;
4. **`restore_unshareable_info`**(:1347,加锁执行):

```cpp
// systemDictionary.cpp:1328-1348(截取核心,逐字)
    // Adjust methods to recover missing data.  They need addresses for
    // interpreter entry points and their default native method address
    // must be reset.

    // Updating methods must be done under a lock so multiple
    // threads don't update these in parallel
    //
    // Shared classes are all currently loaded by either the bootstrap or
    // internal parallel class loaders, so this will never cause a deadlock
    // on a custom class loader lock.

    ClassLoaderData* loader_data = ClassLoaderData::class_loader_data(class_loader());
    {
      HandleMark hm(THREAD);
      Handle lockObject = compute_loader_lock_object(class_loader, THREAD);
      check_loader_lock_contention(lockObject, THREAD);
      ObjectLocker ol(lockObject, THREAD, true);
      // prohibited package check assumes all classes loaded from archive call
      // restore_unshareable_info which calls ik->set_package()
      ik->restore_unshareable_info(loader_data, protection_domain, CHECK_NULL);
    }
```

`InstanceKlass::restore_unshareable_info`(instanceKlass.cpp:2345)的动作: `set_package`(:2350)→ `Klass::restore_unshareable_info`(klass.cpp:508: 恢复 class_loader_data;若 `has_raw_archived_mirror` 且开放归档区已映射,从归档恢复 java_lang.Class 对象,klass.cpp:545-554,否则新建 mirror,:565-568)→ 逐个 `Method::restore_unshareable_info`(method.cpp:1152 → `link_method` :1077)。方法恢复是理解"为什么 mc 区需要 trampoline"的关键: dump 时 `Method::unlink_method`(method.cpp:977)把 `_i2i_entry` 设成 `Interpreter::entry_for_cds_method`(:985-986)——即 mc 区里的 **jmp 桩**(`update_cds_entry_table`,abstractInterpreter.cpp:214,每个桩 `jmp _entry_table[kind]`);load 时解释器重新生成(`method_entry` 宏,templateInterpreterGenerator.cpp:186-189)把桩的目标地址刷成当前进程的 `_entry_table`,而 `link_method` 的断言 `entry == _i2i_entry`(method.cpp:1082)保证两者一致——于是共享方法的解释器入口无需在归档里存任何运行期地址。i2c/c2i 适配器同理: dump 时 `ConstMethod` 的 `_adapter_trampoline` 指向 RW 区一个槽(初始 NULL,constMethod.hpp:212/301-308),第一个被 link 的方法在运行期生成 `AdapterHandlerEntry` 并把指针填进该槽(注释 method.cpp:1015-1031,`make_adapters` :1142-1148)。常量池侧: `ConstantPool::restore_unshareable_info`(constantPool.cpp:328)重建 resolved_references——归档堆可用就直接用归档的数组,否则按记录长度重建(:352-359)。

接着进 `link_class`(instanceKlass.cpp:777 起)——共享类在这里与普通类分道扬镳:

```cpp
// instanceKlass.cpp:787-807(截取核心,逐字)
    if (!is_linked()) {
      if (!is_rewritten()) {
        {
          bool verify_ok = verify_code(throw_verifyerror, THREAD);
          if (!verify_ok) {
            return false;
          }
        }

        // Just in case a side-effect of verify linked this class already
        // (which can sometimes happen since the verifier loads classes
        // using custom class loaders, which are free to initialize things)
        if (is_linked()) {
          return true;
        }

        // also sets rewritten
        rewrite_class(CHECK_false);
      } else if (is_shared()) {
        SystemDictionaryShared::check_verification_constraints(this, CHECK_false);
      }
```

[C++:] 归档类 `is_rewritten()` 为 true(dump 端重写 + nofast 化已完成,08-04 篇),所以**跳过 verify_code 与 rewrite_class**;走 else-if 分支调 `SystemDictionaryShared::check_verification_constraints`——这就是 44 域"验证约束延迟化"的兑现: dump 时 `ClassVerifier` 的 `is_reference_assignable_from` 遇到无法当场解析的类层级检查,`DumpSharedSpaces && SystemDictionaryShared::add_verification_constraint(...)` 把它记进字典条目并当场放行(verificationType.cpp:97-103);load 端 `check_verification_constraints`(systemDictionaryShared.cpp:911-941)逐条重跑 `VerificationType::resolve_and_check_assignability`,不满足就抛 **VerifyError**(:937)。**ClassFileParser 没有出现、Verifier 没有整体重跑、字节码没有重写**——01 篇说的"每次启动的重复劳动"就是被这三件事省掉的。

收尾: `print_class_load_logging`(systemDictionary.cpp:1350)——实证里每行 `[class,load] java.lang.Object source: shared objects file` 就是它;[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/11-cds-load-demo.txt) AppCDS 归档下应用类 T 同样 `T source: shared objects file`。之后 `define_instance_class` 把它挂进加载器的字典、加入类层级。注意状态机并没有"从归档继承 loaded"——dump 时 `remove_unshareable_info` 把 `_init_state` 重置回 allocated(instanceKlass.cpp:2293-2297,注释明说 loaded 要在运行期由 `add_to_hierarchy` 设置);load 端 `restore_unshareable_info` 的断言也要求状态 < loaded(:2349)。所以加载状态机照走一遍,但每一步的重活都已被跳过——解析(没有 ClassFileParser)、验证(只剩约束)、重写(没有 Rewriter)。

## 7. 符号与字符串: CompactHashtable 的 O(1) 查找

类就绪了,但它们的常量池引用着归档里的 `Symbol*` 与字符串对象。这些小东西归另一张表管:**CompactHashtable**(symbolTable.cpp:53/stringTable.cpp:68)。它只读、不可扩容,但每个条目省到极致: 桶数组 `buckets[num_buckets+1]` 每个 u4——**高 2 位是桶类型、低 30 位是 entries 偏移**(compactHashtable.hpp:140-147);entries 两种形态: 单条目桶(VALUE_ONLY)只存 4B offset,多条目桶(REGULAR)存 (hash, offset) 8B 对,桶尾用下一个桶的偏移标记边界(:158-195)。对照动态 Hashtable 每条目 8B 指针 + 8B 链,省一半以上。

```cpp
// compactHashtable.inline.hpp:59-91(截取核心,逐字)
template <class T, class N>
inline T CompactHashtable<T,N>::lookup(const N* name, unsigned int hash, int len) {
  if (_entry_count > 0) {
    int index = hash % _bucket_count;
    u4 bucket_info = _buckets[index];
    u4 bucket_offset = BUCKET_OFFSET(bucket_info);
    int bucket_type = BUCKET_TYPE(bucket_info);
    u4* entry = _entries + bucket_offset;

    if (bucket_type == VALUE_ONLY_BUCKET_TYPE) {
      T res = decode_entry(this, entry[0], name, len);
      if (res != NULL) {
        return res;
      }
    } else {
      // This is a regular bucket, which has more than one
      // entries. Each entry is a pair of entry (hash, offset).
      // Seek until the end of the bucket.
      u4* entry_max = _entries + BUCKET_OFFSET(_buckets[index + 1]);
      while (entry < entry_max) {
        unsigned int h = (unsigned int)(entry[0]);
        if (h == hash) {
          T res = decode_entry(this, entry[1], name, len);
          if (res != NULL) {
            return res;
          }
        }
        entry += 2;
      }
    }
  }
  return NULL;
}
```

[C++:] 哈希相同还要 **decode_entry 双保险**: 符号版 `(Symbol*)(_base_address + offset)` 后用 `sym->equals(name, len)` 逐字节比对,并且断言 `refcount() == -1`(compactHashtable.inline.hpp:36-46,共享符号不可释放);字符串版把 offset 当 narrowOop,`HeapShared::decode_from_archive` 解码出堆区对象再比对(:48-58)。`_base_address` 是 **dump 时写死的 `shared_rs()->base()`**(compactHashtable.cpp:147),load 时由 serialize 原样读回——之所以有效,正是因为第 3 节的同址映射;大纲所说的"mmap 后把 base 设成实际地址"并不存在,那是把结果当成了原因。

集成侧: 符号表查共享表与动态表的顺序由 `_lookup_shared_first` 决定(symbolTable.cpp:242-258)——初始 false 时**先查动态表**,miss 后查共享表,共享命中把它置 true;此后**先查共享表**,共享 miss 再回落 false——一个"最近哪边命中先查哪边"的启发式;`StringTable::lookup`(stringTable.cpp:240-249)则**固定先查共享表**,miss 才走动态表,归档堆没映射上时 `_shared_table.reset()` 全弃(:866-869)——字符串在堆里,堆区不能用,表就作废,一切回到普通加载。

**关键设计 (斜体)**: *只读 + 不扩容 = 没有 rehash、没有锁、没有引用计数。它赌的是"这些符号永远活着"——归档符号确实如此(没人能删),归档字符串由 G1 的归档区托管。4B 一个桶槽 + 4B 一个单条目值,是"为 mmap 而生"的哈希表。*

## 8. 堆对象: 子图恢复与静态字段

字符串之外,归档里还有一批**对象子图**——`IntegerCache`、`ImmutableCollections` 的 ListN/SetN/MapN、`Configuration`、`ArchivedModuleGraph` 等类的静态字段指向的对象(heapShared.cpp:728 `archive_static_fields` 归档)。load 端不在启动时一锅端: 各宿主类静态初始化时自己调 `VM.initializeFromArchive`(VM.java:426)→ `JVM_InitializeFromArchive`(jvm.cpp:3617-3620)→ `HeapShared::initialize_from_archived_subgraph`(heapShared.cpp:271): 按 klass 找记录(:283-285),把子图里所有对象的类 resolve 出来、**确认还是归档里的同一个类**(否则放弃,:294-311),再把记录里的归档对象 materialize 回 java_mirror 的对应字段(:324-336)。[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/11-cds-load-demo.txt) 同配置启动日志 `Trying to map heap data: region[4] at 0x00000007bfe00000, size = 442368 bytes`(st0 字符串区)与 `region[6]`(oa0 开放归档区)就是这两块堆区落地。

## 核心悬念

Load 端拆完了。回头看整个时序: 参数决定能不能用(-Xshare 三态)→ 打开与三重校验(magic/版本/jvm_ident/路径表)分三处做→ **MAP_FIXED 同址映射**(指针全部是"基址+偏移",同址是免修正的唯一方案)→ `initialize_shared_spaces` 装配(C++ vtable 现拷、共享字典 cast、well-known 类与符号表流式读回)→ 三条加载路(引导字典直查、AppCDS 拦截 findLoadedClass、自定义加载器按字节指纹)→ `restore_unshareable_info` 激活(方法入口、cpCache、验证约束、挂字典)。一句话: **Load 端没有"加载",只有"对位"**——该做的解析 dump 时做完了,load 端只负责把镜像放回原位、补上运行期指针,顺带用三分校验挡住"这份归档我不认识"。

但类"就绪"只是开始: 解释器要用它们,更重要的是 JIT 编译器——C2 编译 `String.length()` 时需要知道 value 字段的偏移、方法表、继承关系,可它不能直接读 InstanceKlass(太多 VM 专用的锁与虚函数)。下一域进入编译器侧: 12-ci,ciObject 镜像体系。

> → [12-ci/01 — ciObject 镜像体系 — JIT 怎么看到 Java 类？](openjdk/vol-02/12-ci/01-ci-overview-mirror.md)
