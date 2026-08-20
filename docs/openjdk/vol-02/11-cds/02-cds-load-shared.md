# 02. mmap 之后共享类怎么进 `SystemDictionary`？— CDS Load 端的对位、接线与激活

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 **CDS / AppCDS 的加载端**：归档文件已经存在时，JVM 如何判断它还能不能用、如何把共享空间映射回地址空间、如何把共享类重新接回当前进程的运行时体系。动态 CDS、其他 JVM 实现、其他平台的映射细节，不在本文展开。
>
> **前置依赖**：[11-cds/01 — 启动时怎么让核心类秒加载？— CDS 全景与 Dump](01-cds-overview-dump.md)、[07-classfile-classloader/04 — `SystemDictionary` — 类的“全球电话号码本”](../07-classfile-classloader/04-system-dictionary.md)、[08-interpreter/04 — `LinkResolver + Rewriter`](../08-interpreter/04-linkresolver-rewriter.md)、[09-memory-core/01 — `Universe + CollectedHeap`](../09-memory-core/01-universe-heap.md)
> → **后续**：[12-ci/01 — `ciObject` 镜像体系 — JIT 怎么看到 Java 类？](../12-ci/01-ci-overview-mirror.md)

上一篇我们把 dump 端拆开了：`-Xshare:dump` 并不是把 class 文件另存一份，而是把一批已经加载并链接过的核心类压成共享内存镜像。那一篇的关键词是“冻结、压实、重定位、分区写盘”。

这一篇的问题看似更轻，其实更容易想错：既然归档已经是“可映射的内存镜像”，那 JVM 下次启动时把它 `mmap` 进来不就完了吗？类不是已经在那里了吗？

问题就在这里。**`mmap` 只负责把字节放到地址上，不负责让这些字节自动成为“当前 JVM 的活类”。**

共享归档里当然已经躺着 `InstanceKlass`、`Method`、符号表、共享字典、字符串区，甚至还有一部分归档堆对象；但这些内容是在另一次 JVM 启动里做出来的。当前 JVM 要使用它们，至少还要再过四道门：

- 这份归档是不是仍然属于“同一个世界”；
- 这些共享区是不是被放回了当年假定的位置；
- 所有不能跨进程保存的运行期地址和状态，是不是已经补回来了；
- 这些共享类是不是已经重新穿过当前 JVM 的可见性检查、层级一致性检查和类加载状态机。

所以，CDS load 端既不是“重新解析一遍归档里的类”，也不是“什么都不用干”。它做的是一件更克制的事：**先验条件、再对位、再接线、再补状态，最后让这些共享类以最轻的代价重新进入 `SystemDictionary`。**

先记住这句总答案。后面所有看起来很散的动作——magic 校验、路径表校验、`MAP_FIXED`、`clone_cpp_vtables`、`restore_unshareable_info`、`check_verification_constraints`——其实都在为这句话服务。

## 先把两个最自然的误解拿掉

### 误解一：只要 `mmap` 成功，共享类就已经“加载完成”

这是最常见的第一反应。归档既然已经是一份准备好的内存镜像，当前 JVM 把它映射进来，里面的 `InstanceKlass*` 不就已经存在了吗？

存在，不等于可用。

这里最容易混淆的是“对象字节已经在内存里”和“当前 JVM 已经认可这是一批活类”这两件事。共享类里的很多东西是 dump 时故意剥掉的：比如 `java_mirror`、解释器入口、默认 native 方法入口、已解析引用数组的一部分运行期内容。因为这些东西跟当前进程的地址布局、当前 `libjvm.so` 的代码地址、当前加载器状态有关，根本不能直接跨进程保存。`share/classfile/systemDictionary.cpp:1328`、`share/oops/instanceKlass.cpp:2345`、`share/oops/method.cpp:979`、`share/oops/method.cpp:985`

所以 `mmap` 成功，只能说明“这批共享对象的字节被放回了一个看起来对的位置”。离“这个类现在真的能被解释器调用、能被字典登记、能通过层级检查、能被反射看见”还差一大截。

### 误解二：既然 dump 时都准备好了，load 端应该什么都不用做

另一种看法正好走到另一个极端：上一篇明明已经说过 dump 端做了压实和重定位，说明设计目标就是“以后直接映射即用”。那 load 端为什么还要搞校验、接线、恢复、重新 link？这不是打自己的脸吗？

不是。这里的关键区别在于：**dump 时能固化的，只是“与具体进程无关的稳定结构”；load 时必须补的，是“与当前进程有关的运行期信息”。**

举几个最硬的例子：

- C++ vtable 里的函数地址跟当前 `libjvm.so` 的装载位置有关，不能写死进归档；
- 解释器入口 trampoline 最终要跳到当前进程生成的 `_entry_table`，不是 dump 时那次 JVM 的入口地址；
- 自定义加载器能不能使用某个共享类，要看当前 class loader、当前保护域、当前模块状态；
- 某个共享类的超类和接口在当前 JVM 里解析出来的对象，必须还是 dump 时那同一批对象，否则布局前提就变了。`share/memory/metaspaceShared.cpp:2105`、`share/classfile/systemDictionary.cpp:1285`、`share/classfile/systemDictionary.cpp:1296`、`share/classfile/systemDictionary.cpp:1311`、`share/oops/method.cpp:1020`

所以“直接映射即用”这句话只能在一个限定语下成立：**对那些已经被 dump 端稳定化、而且仍然满足当前 JVM 全部假设的部分，load 端尽量不重做。**

换句话说，CDS load 端的高明之处不在于“完全不干活”，而在于“只补当前 JVM 非补不可的那一小块活”。

到这里先立一个路标：这一篇真正要追的不是“共享归档如何被打开”，而是“共享类如何从‘躺在归档里的字节对象’变成‘当前 JVM 的活类’”。

## 第一道门：先确认这还是不是“当年那份世界”

共享类之所以能直接拿来用，前提是当前 JVM 和 dump 那次 JVM 仍然生活在同一套世界观里。只要这个前提破了，归档里的字节越完整，风险反而越大。

这个判断从参数阶段就开始了。`Metaspace::global_initialize()` 在运行时会按 `UseSharedSpaces` 分流。如果不是 dump 模式但启用了共享空间，就会走 `MetaspaceShared::initialize_runtime_shared_and_meta_spaces()`。也就是说，CDS 加载根本不是“类加载时临时看看有没有 archive”，而是在 metaspace 和 class space 初始化的最前面就要介入，避免后面的地址布局先把关键位置占掉。`share/memory/metaspace.cpp:1294`、`share/memory/metaspace.cpp:1300`、`share/memory/metaspace.cpp:1305`、`share/memory/metaspaceShared.cpp:216`

`initialize_runtime_shared_and_meta_spaces()` 的骨架很直接：先 new 一个 `FileMapInfo`，然后只在 `mapinfo->initialize()` 和 `map_shared_spaces(mapinfo)` 都成功时继续往下。也就是说，CDS 加载的第一道门不是映射，而是“这份归档是否还可信”。`share/memory/metaspaceShared.cpp:223`、`share/memory/metaspaceShared.cpp:229`

`FileMapInfo::initialize()` 自己就像一个很谨慎的门卫。它先检查 JVMTI 的 early `ClassFileLoadHook`。这是个极好的例子：只要 VM 允许某个 agent 在非常早的阶段改系统类，CDS 对“共享类内容不会被动态替换”的假设就不成立，所以直接禁用共享。这里不是技术做不到，而是设计者不肯赌。`share/memory/filemap.cpp:1316`、`share/memory/filemap.cpp:1321`

接下来才是打开归档文件、读取 header、做头部校验。我们在上一篇看过归档头里塞了不少信息：magic、版本、JVM 标识、对象对齐、压缩指针参数、路径杂项信息、共享路径表等。现在终于能看出它们的真正作用：不是为了描述文件格式，而是为了判断“当前 JVM 还能不能继承 dump 当时的那套假设”。`share/memory/filemap.cpp:1325`、`share/memory/filemap.cpp:1329`、`share/memory/filemap.cpp:1332`、`share/memory/filemap.cpp:1359`

这一层检查里，最显眼的是 magic 与版本。它们保证眼前这玩意儿确实是 CDS archive，而且版本对得上。更细的还有 `ObjectAlignmentInBytes`、`CompactStrings`、JVM build 标识，以及共享路径杂项信息。只要有任何一条不对，HotSpot 就不再把它视为“本进程可以接上的共享镜像”，而是果断回退。`share/memory/filemap.cpp:1360`、`share/memory/filemap.cpp:1366`、`share/memory/filemap.cpp:1376`、`share/memory/filemap.cpp:1386`、`share/memory/filemap.cpp:1397`、`share/memory/filemap.cpp:1401`

这里有一个特别值得停一下的点：`validate_shared_path_table()` 并不在最开始做，而是延后到映射阶段之后。源码注释点得很清楚：因为那张表坐在 archive 的 `RW` 区里，没映射之前还读不到。`share/memory/filemap.cpp:1311`、`share/memory/filemap.cpp:480`

这说明 CDS 的校验不是一把梭，而是按“当前能读到哪一层信息”逐步推进的：

- 先用文件头能看到的东西，确认大前提还成立；
- 映射时再验证每个 region 的校验和；
- 映射完 `RW` 区，最后再验共享路径表。`share/memory/filemap.cpp:491`、`share/memory/filemap.cpp:493`

如果把这整段翻译成人话，就是：**HotSpot 不是在问“这个文件能不能打开”，而是在问“这是不是我当年那套世界里做出来的镜像，而且当前世界还没有变掉”。**

## 第二道门：不是“映射进来就行”，而是“必须映射回原位”

通过头部校验之后，才轮到真正的 `mmap`。但这里也不是随便找块空地把内容读进来。`map_shared_spaces()` 明确要求把四个 core spaces —— `mc`、`rw`、`ro`、`md` —— 映射到归档头记录的地址，而且中间不能有缝。`share/memory/metaspaceShared.cpp:2033`、`share/memory/metaspaceShared.cpp:2052`、`share/memory/metaspaceShared.cpp:2063`、`share/memory/metaspaceShared.cpp:2069`、`share/memory/metaspaceShared.cpp:2070`、`share/memory/metaspaceShared.cpp:2071`

为什么这么苛刻？因为共享类里的大量指针关系，并不是为“任意地址恢复”而设计的，而是为“尽量在同一基址原样成立”而设计的。上一篇已经讲过 dump 时为什么要围着共享区基址来设 `narrow_klass_base`；load 端在这里就是在兑现那个前提。

`FileMapInfo::reserve_shared_memory()` 会先尝试把整个 core spaces 连续预留出来，理由写得很坦白：如果不先 reserve，后面的映射可能会直接盖到别的保留内存，比如 code cache。`share/memory/filemap.cpp:868`、`share/memory/filemap.cpp:873`、`share/memory/filemap.cpp:875`、`share/memory/filemap.cpp:877`

然后 `map_region()` 再逐区做真正的文件映射。它不是“尽量映射到这个地址”，而是“必须映射到这个地址”。只要 `base == NULL` 或者 `base != requested_addr`，就算失败。随后还会跑 `verify_region_checksum()`。也就是说，CDS 这里关心的是 **地址正确 + 内容正确**，缺一不可。`share/memory/filemap.cpp:891`、`share/memory/filemap.cpp:897`、`share/memory/filemap.cpp:905`、`share/memory/filemap.cpp:908`、`share/memory/filemap.cpp:919`

这一步的本质非常重要：**共享 archive 不是一堆“可以被重新解释的数据”，而是一段“最好能被原样接上的运行时内存”。**

如果地址不对，HotSpot 不会说“那我辛苦一点，把所有共享类里的指针都重新修一遍吧”。它宁可放弃共享。因为一旦走到那一步，load 端就不再是“最轻量接线”，而会退化成另一套巨大的恢复系统，那等于自己否定了 dump 端整个镜像设计。

映射成功之后，事情还没完。运行时初始化还要顺手把 compressed class space 放到 CDS 区之后，并把 heap archive regions 也接进来。源码里明确要求先确定所有 encoding，再做 `map_heap_regions()`。如果 class space 地址和 CDS 基址不兼容，还会直接 stop sharing and unmap。`share/memory/metaspaceShared.cpp:233`、`share/memory/metaspaceShared.cpp:238`、`share/memory/metaspaceShared.cpp:239`、`share/memory/metaspaceShared.cpp:241`、`share/memory/metaspace.cpp:1187`、`share/memory/metaspace.cpp:1189`、`share/memory/metaspace.cpp:1193`

所以第二道门的真正答案是：load 端不是把文件读进来，而是在做一次严苛的“对位”。对位失败，整套共享类体系就不成立。

## 第三道门：映射完只是“躯壳到位”，还得把运行期接线补上

很多人第一次看到 `initialize_shared_spaces()` 会疑惑：既然四个 core spaces 都已经映射成功了，为什么还要再读一遍所谓的 miscellaneous data？

因为映射成功只是把归档里的“躯壳”摆回来了，真正让它接上当前 JVM 的那些线，还没插上。

`initialize_shared_spaces()` 一开头先从 `FileMapInfo` 里取回 `_cds_i2i_entry_code_buffers`、`_cds_i2i_entry_code_buffers_size` 和 `_core_spaces_size`，然后马上调用 `clone_cpp_vtables()`。这一步的直觉很好理解：归档里的 C++ 对象虽然字节形状对了，但 vtable 里的函数地址属于当前进程的 `libjvm.so`，不可能跨进程照搬。所以 dump 时只是给它们留了克隆表位置，load 时再把当前 JVM 的真实 vtable 内容 memcpy 进去。`share/memory/metaspaceShared.cpp:2102`、`share/memory/metaspaceShared.cpp:2105`、`share/memory/metaspaceShared.cpp:2106`

接下来 HotSpot 从 `read_only_tables_start()` 开始读回共享字典表头：先拿表长、条目数，再直接把那段内存 cast 成 `HashtableBucket` 数组，交给 `SystemDictionary::set_shared_dictionary()`。注意这个动作非常能体现 CDS 的风格：这里没有“重新解析一张字典文件”，而是“把一段已经成型的只读哈希表接到当前 `SystemDictionary` 身上”。`share/memory/metaspaceShared.cpp:2108`、`share/memory/metaspaceShared.cpp:2110`、`share/memory/metaspaceShared.cpp:2114`、`share/classfile/systemDictionary.cpp:1133`、`share/classfile/systemDictionary.cpp:1138`

再往后还有两层接线。

第一层是共享堆子图信息。`HeapShared::read_archived_subgraph_infos()` 会把这批记录读回来，供后续需要时按类去 materialize 归档对象子图。也就是说，连堆对象的恢复都是“先把索引和描述接好，等真正用到时再拿”。`share/memory/metaspaceShared.cpp:2126`、`share/memory/metaspaceShared.cpp:2127`

第二层是 `serialize(&rc)`。这个名字很容易让人误会成“又在序列化/反序列化对象”。其实它更像一份双端都认识的接线清单：按照固定顺序读回 well-known klasses、共享符号/字符串表、某些 Java 类字段偏移，以及一批尺寸与 tag 校验。它真正干的，是确认“dump/load 两端仍然在谈论同一批 C++ 结构与同一批全局对象”。`share/memory/metaspaceShared.cpp:2129`、`share/memory/metaspaceShared.cpp:2132`、`share/memory/metaspaceShared.cpp:2133`

最后，运行时符号表要创建，归档堆对象里嵌入的 oop 指针要 patch，文件句柄要关闭。到这一步，共享区才算真的从“纯字节地图”变成“当前 JVM 已接好线的共享运行时部件”。`share/memory/metaspaceShared.cpp:2135`、`share/memory/metaspaceShared.cpp:2138`、`share/memory/metaspaceShared.cpp:2140`

这里可以先收一个阶段性结论：**`initialize_shared_spaces()` 的意义不是“再做一次加载”，而是“把跨进程不能保存的接头重新插进当前 JVM”。**

## 共享类怎么真正进 `SystemDictionary`：三条入口，最后汇到同一个核心动作

到这里，共享区已经在内存里、共享字典已经挂上、共享符号表也能查了。但“共享类存在于 archive 中”仍然不等于“共享类已经变成当前类加载器眼里的类”。真正让它们进字典、进层级、进状态机，还要靠类加载路径上的接入点。

### 引导加载器：先查共享字典，再决定是否直接拿共享类

对于 bootstrap loader，逻辑最直观。`SystemDictionary::find_shared_class()` 会在 `_shared_dictionary` 上按 hash 查类名；`SystemDictionary::load_shared_class(Symbol*, Handle)` 再要求它必须是共享 boot class，而且当前 loader 也必须是 `NULL`。只有这一层条件成立，才会走真正的 `load_shared_class(InstanceKlass*, ...)`。`share/classfile/systemDictionary.cpp:1147`、`share/classfile/systemDictionary.cpp:1149`、`share/classfile/systemDictionary.cpp:1152`、`share/classfile/systemDictionary.cpp:1165`、`share/classfile/systemDictionary.cpp:1169`

这条路径很能说明共享类不是“字典里预先就算已加载完”。共享字典里放的是“可被尝试接入的共享类候选项”，而不是“已经完成当前 loader 语义的类对象”。真正接入系统，还要经过后面的可见性与恢复过程。

### 平台 / 应用加载器：在 `findLoadedClass` 这一刀上截胡

AppCDS 的巧劲在这里最明显。`SystemDictionaryShared.cpp` 里有一大段注释专门解释：平台类加载器和应用类加载器都经由 `BuiltinClassLoader.loadClassOrNull()`，而这条路径在 Java 侧会先调 `findLoadedClass()`。HotSpot 正是借这个时机，在 `JVM_FindLoadedClass` 里面插入 `SystemDictionaryShared::find_or_load_shared_class()`。这样做的好处是，一旦共享字典里有现成类，就可以直接从 archive 接入，省掉 classfile 解码，也省掉一轮父加载器委托。`share/classfile/systemDictionaryShared.cpp:449`、`share/classfile/systemDictionaryShared.cpp:471`、`share/classfile/systemDictionaryShared.cpp:472`、`share/classfile/systemDictionaryShared.cpp:474`

`find_or_load_shared_class()` 自己也很谨慎。它先要求 `UseSharedSpaces` 为真，归档里确实包含平台/应用类，然后要求共享字典不为空、当前 loader 是 system/platform loader。之后它先在当前 loader 自己的字典里检查是不是已经有同名类，避免重复定义；只有没找到，才去 `load_shared_class_for_builtin_loader()`。`share/classfile/systemDictionaryShared.cpp:480`、`share/classfile/systemDictionaryShared.cpp:483`、`share/classfile/systemDictionaryShared.cpp:488`、`share/classfile/systemDictionaryShared.cpp:494`、`share/classfile/systemDictionaryShared.cpp:514`、`share/classfile/systemDictionaryShared.cpp:521`

`load_shared_class_for_builtin_loader()` 再进一步要求：归档里的类必须标记为 shared app class 或 shared platform class，而且要与当前加载器身份对应。通过后才初始化安全信息，并走统一的 `load_shared_class(ik, class_loader, protection_domain, NULL, THREAD)`。`share/classfile/systemDictionaryShared.cpp:530`、`share/classfile/systemDictionaryShared.cpp:534`、`share/classfile/systemDictionaryShared.cpp:538`、`share/classfile/systemDictionaryShared.cpp:542`、`share/classfile/systemDictionaryShared.cpp:544`

### 自定义加载器：不是按名字认，而是按字节指纹认

第三条路径最能体现 HotSpot 为什么不能偷懒。对于非 builtin loader，光靠类名根本不足以确认“这是不是 dump 时归档的那一个类定义”。所以 `lookup_from_stream()` 先排除 `NULL`、system、platform loader，只在自定义加载器路径上工作。接着如果共享字典里连这个名字的 UNREGISTERED 条目都没有，就直接放弃。真有的话，还要拿当前 `ClassFileStream` 的长度和 `crc32`，与归档时记录的三元组 `(name, size, crc32)` 精确比对。`share/classfile/systemDictionaryShared.cpp:585`、`share/classfile/systemDictionaryShared.cpp:596`、`share/classfile/systemDictionaryShared.cpp:607`、`share/classfile/systemDictionaryShared.cpp:612`、`share/classfile/systemDictionaryShared.cpp:615`

命中之后，还不能直接宣布成功。`acquire_class_for_current_thread()` 要先在 `SharedDictionary_lock` 下确认这份 `InstanceKlass` 还没有被别的线程或别的 loader 抢走，然后先把它绑定到当前 `ClassLoaderData`，再继续调用统一的 `load_shared_class()`。`share/classfile/systemDictionaryShared.cpp:628`、`share/classfile/systemDictionaryShared.cpp:637`、`share/classfile/systemDictionaryShared.cpp:644`、`share/classfile/systemDictionaryShared.cpp:650`、`share/classfile/systemDictionaryShared.cpp:653`

三条路径看起来差别很大，但真正的共性就在这里：**它们最终都不是“直接拿共享类返回”，而是汇入同一个核心动作——`load_shared_class(InstanceKlass*)`。** 这正说明共享类是否能被当前 JVM 接受，并不是由“有没有映射成功”决定，而是由“能不能通过这套接入过程”决定。

## 共享类怎么“活过来”：先过可见性和层级检查，再恢复不可共享状态

`SystemDictionary::load_shared_class(InstanceKlass* ik, ...)` 是本篇真正的心脏。因为它决定了共享类从“archive 里的候选对象”变成“当前 JVM 的活类”还差哪些动作。`share/classfile/systemDictionary.cpp:1270`

第一关是可见性。`is_shared_class_visible()` 会根据类的 `shared_classpath_index()`、当前 loader、模块初始化状态、包与模块归属来判断这份共享类对当前 loader 是否成立。一个非常关键的规则是：`path_index < 0` 表示这个类本来就是为自定义加载器准备的，builtin loader 不能随便拿；被 patch 过的模块也不能再用 archive 里的版本。`share/classfile/systemDictionary.cpp:1183`、`share/classfile/systemDictionary.cpp:1189`、`share/classfile/systemDictionary.cpp:1191`、`share/classfile/systemDictionary.cpp:1194`、`share/classfile/systemDictionary.cpp:1224`、`share/classfile/systemDictionary.cpp:1226`

第二关是超类和接口必须还是“同一批对象”。源码注释说得非常直白：`ik` 的布局依赖于 dump 时看到的 `super()` 和 `local_interfaces()`。所以运行时要重新 resolve 一遍；如果现在解析出来的超类或接口对象，不等于归档里记录的那个对象，说明类层级世界已经变了，archive 里的这份 `ik` 就不能再用。`share/classfile/systemDictionary.cpp:1285`、`share/classfile/systemDictionary.cpp:1292`、`share/classfile/systemDictionary.cpp:1296`、`share/classfile/systemDictionary.cpp:1305`、`share/classfile/systemDictionary.cpp:1311`

第三关是 `ClassFileLoadHook`。如果 CFLH 真把类改了，那就放弃共享版本，改用新的类定义。这说明 CDS 加载不是“共享类优先级最高”，而是“在不违反当前类加载语义的前提下，尽量复用共享类”。`share/classfile/systemDictionary.cpp:1320`、`share/classfile/systemDictionary.cpp:1322`

真正最关键的第四关是 `restore_unshareable_info()`。源码注释非常值得细看：方法地址恢复必须在锁下完成，避免多个线程并行更新共享类的方法入口。共享类当前都由 bootstrap 或内部并行类加载器加载，所以这样加锁不会把 custom loader 锁死。`share/classfile/systemDictionary.cpp:1328`、`share/classfile/systemDictionary.cpp:1332`、`share/classfile/systemDictionary.cpp:1342`、`share/classfile/systemDictionary.cpp:1347`

`InstanceKlass::restore_unshareable_info()` 干的第一件事是断言当前状态还没有到 loaded，然后先 `set_package()`，再调用 `Klass::restore_unshareable_info()` 恢复类加载器相关信息。之后逐个 `Method::restore_unshareable_info()`，再恢复常量池的 resolved references，必要时连 array classes 一起恢复。`share/oops/instanceKlass.cpp:2345`、`share/oops/instanceKlass.cpp:2349`、`share/oops/instanceKlass.cpp:2350`、`share/oops/instanceKlass.cpp:2351`、`share/oops/instanceKlass.cpp:2355`、`share/oops/instanceKlass.cpp:2370`、`share/oops/instanceKlass.cpp:2373`

这里的方法恢复最能体现“load 端不是重新解析，而是补运行期缺件”。

在 dump 时，`Method::unlink_method()` 会把 `_i2i_entry` 和 `_from_interpreted_entry` 都改成 `Interpreter::entry_for_cds_method(this)`，也就是指向 CDS 代码区里的 trampoline；native 方法的真实入口清空；adapter trampoline 也只留下一个固定槽位。总之，dump 时刻意把那些不能跨进程带走的运行期入口都剥掉，只保留一个可在加载期接线的骨架。`share/oops/method.cpp:979`、`share/oops/method.cpp:983`、`share/oops/method.cpp:985`、`share/oops/method.cpp:988`、`share/oops/method.cpp:994`、`share/oops/method.cpp:996`

到运行时，`Method::restore_unshareable_info()` 并不重新造方法结构，只是在必要时重新 `link_method()`。而 `link_method()` 对 shared 方法有一个非常说明问题的断言：`Interpreter::entry_for_cds_method(h_method)` 必须已经和 `_i2i_entry` 一致，这说明共享方法的解释器入口骨架在 dump 时就定好了。运行时真正要补的，是 adapter、native 默认入口、以及最终跳到当前进程解释器/适配器代码的那一层连接。`share/oops/method.cpp:1077`、`share/oops/method.cpp:1080`、`share/oops/method.cpp:1081`、`share/oops/method.cpp:1084`、`share/oops/method.cpp:1106`、`share/oops/method.cpp:1126`、`share/oops/method.cpp:1142`、`share/oops/method.cpp:1152`

所以 `restore_unshareable_info()` 的真正意义不是“补点零碎字段”，而是：**把 dump 时为了可共享而剥掉的、所有属于当前进程的运行期接头重新装回去。**

## 最后那一点“链接”还要不要走？要，但已经是最轻量版本

到这里读者很容易再问一句：既然共享类已经恢复得差不多了，`link_class()` 还要不要走？

要走，但它和普通类已经不是同一条重量级路径了。

`InstanceKlass::link_class()` 里的关键分支是：如果类还没 linked，而且还没 rewritten，就走普通验证和 `rewrite_class()`；但如果类已经是 rewritten 的共享类，就不再重跑整套 verifier 和 rewriter，而是只做 `SystemDictionaryShared::check_verification_constraints()`。`share/oops/instanceKlass.cpp:787`、`share/oops/instanceKlass.cpp:788`、`share/oops/instanceKlass.cpp:790`、`share/oops/instanceKlass.cpp:804`、`share/oops/instanceKlass.cpp:805`、`share/oops/instanceKlass.cpp:806`

这段代码是理解 CDS 加载价值的关键证据。它告诉我们：

- `ClassFileParser` 不会重跑；
- verifier 不会整套重跑；
- `Rewriter` 不会再重写一次字节码；
- 只保留 dump 时没法完全确定、必须在当前 JVM 再兑现的那批验证约束。

而这些验证约束也不是凭空来的。dump 端在某些需要延迟决定的场景下，会把约束存进共享字典条目；到运行时，`SystemDictionaryShared::check_verification_constraints()` 再按当前类层级去逐条核验，不满足就抛 `VerifyError`。这说明 CDS 不是“把验证偷掉”，而是把“当时做不完、但以后必须兑现的那部分验证”延期到 load 端。`share/classfile/systemDictionaryShared.cpp:808`、`share/classfile/systemDictionaryShared.cpp:811`、`share/classfile/systemDictionaryShared.cpp:911`、`share/classfile/systemDictionaryShared.cpp:926`、`share/classfile/systemDictionaryShared.cpp:937`

所以最后这段链接可以概括成一句话：**共享类不是完全不走类状态机，而是走一条剥掉了解析、重写和大部分验证成本的最轻量路径。**

## 共享类活起来之后，符号、字符串和堆子图也要能一起跟上

共享类并不是孤零零活着的。它们的方法、常量池、字段名、字符串常量，全都依赖共享符号表、共享字符串表和一部分归档堆对象。

符号这边，`SymbolTable::lookup()` 会在动态表和共享表之间切换查找顺序；命中共享表时，共享符号是通过 `base_address + offset` 直接解码出来的。也就是说，符号表不是把名字再重建一遍，而是利用同址映射的共享区直接定位 `Symbol*`。`share/classfile/symbolTable.cpp:229`、`share/classfile/symbolTable.cpp:242`、`share/classfile/symbolTable.cpp:254`、`share/classfile/symbolTable.cpp:262`、`share/classfile/symbolTable.cpp:270`、`share/classfile/symbolTable.cpp:272`

字符串这边更直接：`StringTable::lookup()` 固定先查共享表，命中就直接返回 archive 里的字符串对象；否则才落回动态字符串表。`share/classfile/stringTable.cpp:240`、`share/classfile/stringTable.cpp:242`、`share/classfile/stringTable.cpp:246`

而 CompactHashtable 本身也很符合本文的主线：它不是一张需要恢复链表指针和节点对象的动态哈希表，而是一张只读、偏移驱动、专门为共享映射准备的紧凑查找结构。`decode_entry()` 对符号版直接做 `_base_address + offset`，对字符串版则通过 `HeapShared::decode_from_archive()` 还原归档堆对象。只有名字真正匹配，才返回对象。`share/classfile/compactHashtable.inline.hpp:36`、`share/classfile/compactHashtable.inline.hpp:38`、`share/classfile/compactHashtable.inline.hpp:48`、`share/classfile/compactHashtable.inline.hpp:50`、`share/classfile/compactHashtable.inline.hpp:60`、`share/classfile/compactHashtable.inline.hpp:77`

这部分虽然不是“共享类怎么进字典”的主线，但它提供了一个很重要的背景：**共享类之所以能像活类一样工作，并不是只有 `InstanceKlass` 自己活了，而是它依赖的整套共享元数据和归档堆对象也都一起被接进来了。**

## 收网：load 端真正做的，不是“重新加载类”，而是“把共享镜像重新接回当前 JVM”

现在可以把整篇压成一张总图。

CDS load 端先在 metaspace 初始化最前面介入，判断这份 archive 还是不是 dump 当时那套世界里做出来的东西；随后要求把 `mc/rw/ro/md` 这些 core spaces 映射回原地址，因为共享类内部大量指针关系就是为同址接线准备的；映射成功之后，还要补上 vtable、共享字典、共享符号表、归档堆对象指针这些跨进程不能保存的接头；然后类加载路径上的三类入口——boot loader、builtin loader、自定义 loader——再把候选共享类送进统一的 `load_shared_class()`；最后通过可见性检查、超类/接口一致性检查、`restore_unshareable_info()` 和最轻量版本的 `link_class()`，让这些共享类重新变成当前 JVM 真正承认的活类。`share/memory/metaspace.cpp:1300`、`share/memory/metaspaceShared.cpp:229`、`share/memory/metaspaceShared.cpp:2052`、`share/memory/metaspaceShared.cpp:2100`、`share/classfile/systemDictionaryShared.cpp:480`、`share/classfile/systemDictionary.cpp:1270`、`share/oops/instanceKlass.cpp:2345`、`share/oops/instanceKlass.cpp:805`

所以，这一篇最核心的一句话不是“共享类从 shared objects file 里读出来”，而是：

**共享类先被验明还属于当前世界，再被放回原位、补上当前进程的运行期接头，最后以最轻量的状态机路径重新接入 `SystemDictionary`。**

只要这句话抓住了，下一域为什么还需要 `ciObject` 这样的编译器镜像体系也就不难理解了：JIT 不能直接把这些 VM 内部对象当作自己的数据模型，它还要再看一层为编译器准备的镜像视图。

> → [12-ci/01 — `ciObject` 镜像体系 — JIT 怎么看到 Java 类？](../12-ci/01-ci-overview-mirror.md)
