# 01. 启动时怎么让核心类秒加载？— CDS 全景与 Dump

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 **CDS dump 端**：`-Xshare:dump` 如何把一批已经加载并链接过的核心类整理成归档文件。运行时 `mmap`、共享区校验、类如何重新进入 `SystemDictionary`，放到下一篇展开。
>
> **前置依赖**：[08-interpreter/04 — LinkResolver + Rewriter](../08-interpreter/04-linkresolver-rewriter.md)、[07-classfile-classloader/01 — ClassFile 解析](../07-classfile-classloader/01-classfile-parser.md)、[10-metaspace/01 — Metaspace 概览](../10-metaspace/01-metaspace-overview.md)
> → **后续**：[11-cds/02 — mmap archive → shared spaces → 类就绪](02-cds-load-shared.md)

JVM 启动时有一批重复劳动非常显眼：`java.lang.Object`、`String`、`Class`、`System` 以及它们牵出的上千个核心类，每次都要重新读 `.class`，重新跑 `ClassFileParser`，重新验证，重新构造 `InstanceKlass`、`Method`、常量池缓存，再重新完成链接。哪怕应用代码完全不同，这一批基础设施类的结果也几乎一样。

读到这里，很多人会自然冒出一个直觉：既然这些类每次启动都差不多，JVM 直接把“上次解析好的类”存盘，下次再读回来，不就行了吗？

这正是 CDS（Class Data Sharing）要解决的问题，但它的答案和“把类存盘”并不是一回事。HotSpot 在 `-Xshare:dump` 模式下做的事情，不是导出一份“类信息文件”，也不是把 `InstanceKlass` 这样的 C++ 对象一个个序列化，而是构造一份未来希望被 **固定地址 `mmap` 进来** 的内存镜像。下一次 JVM 启动时，它想要的不是“再解析一遍这份归档”，而是“把这段内存直接映射进地址空间，然后尽量原样拿来用”。`share/memory/metaspaceShared.cpp:1632`、`share/memory/metaspaceShared.cpp:1333`、`share/memory/filemap.hpp:36`、`share/include/cds.h:36`

先记住这一句人话答案，后面所有看起来琐碎的设计——为什么要冻结 metaspace、为什么要分 `rw`/`ro`、为什么要要求固定基址、为什么头里要写 magic 和路径表——都会从这一句里长出来：

**CDS dump 的产物不是“类的离线描述”，而是“给未来 JVM 直接映射的预制内存”。**

## 每次启动都重新造一遍 VM 元数据，问题不在 `.class`，而在“运行时形态”

把 `.class` 文件读进来，只是类加载的最前面一步。真正重的是后面的 JVM 内部建模：HotSpot 要把字节流变成 `InstanceKlass`、`ConstantPool`、`ConstMethod`、`MethodData`、符号表项、字典项，还要完成字节码重写、验证约束、常量池缓存、方法入口等一大批运行时结构。这些东西大多不长得像 Java 规范里的“类文件格式”，而长得像 HotSpot 进程内的 C++ 对象图。

所以 CDS 想缓存的核心对象，其实不是 class 文件本身，而是 **“JVM 已经理解完这个类之后，在自己内存里摆出来的那一套东西”**。这一点非常重要，因为它直接决定了 dump 端后面不会走“重新发明一个 class 级序列化格式”的路，而会想办法尽量保留现成的运行时形态。

如果只看现象，CDS 很像“把启动结果存起来”。但如果往实现里走一步，你会发现真正被保存下来的并不是“启动日志的结论”，而是对 HotSpot 最有价值的那部分中间结果：已经链接好的元数据、整理过的符号表、可共享的字节码与字典内容，以及一部分可归档的 Java 堆对象。`share/memory/metaspaceShared.cpp:1400`、`share/memory/metaspaceShared.cpp:1403`、`share/memory/metaspaceShared.cpp:1408`、`share/memory/metaspaceShared.cpp:1294`

这也是为什么下一篇加载端根本不会把归档当成“另一种 classpath”。它不是再走一遍 class 文件解析，而是尝试把一段准备好的空间直接接回 HotSpot 的运行时数据结构。

到这里先立一个路标：这一篇真正要回答的，不是“CDS 有哪些文件格式字段”，而是“为什么 HotSpot 必须把归档做成内存镜像，而不能用看起来更普通的办法”。

## 先试三个最容易想到的办法，看看它们为什么都不够

### 朴素方案一：既然 `.class` 没变，那就缓存 `.class`

这是最顺手的想法：JVM 第一次启动时把常用 class 文件缓存到一个更快的位置，下次直接读缓存，不就少了磁盘 I/O 吗？

问题在于，类加载真正贵的部分并不只是读文件。就算 `.class` 原文已经躺在页缓存里，HotSpot 依然要做语义级工作：校验、符号解析、构造元数据对象、字节码改写、构建运行时表格。这些步骤恰恰是 CDS 想绕开的地方。

换句话说，缓存 `.class` 解决的是“字节流从哪儿来”，而 CDS 瞄准的是“字节流被 JVM 消化之后长成什么样”。如果你只缓存 `.class`，下一次启动还是得重新造一遍 `InstanceKlass` 与其关联对象，节省不了最想省的那段劳动。

所以 HotSpot 的 dump 流程一开始就没有发明什么“把 class 文件重新打包成 archive”的机制。它先按正常方式把类真正加载进来，再考虑如何保留结果。`share/memory/metaspaceShared.cpp:1699`、`share/memory/metaspaceShared.cpp:1703`、`share/memory/metaspaceShared.cpp:1722`

### 朴素方案二：把 `InstanceKlass` 之类的对象逐个序列化到文件

第二个更进一步的想法是：既然 class 文件不够，那就把 HotSpot 里现成的 C++ 对象一个个写盘。下次启动时再反序列化回来，不就可以了吗？

这比缓存 `.class` 更接近真实目标，但它马上撞上两个更硬的问题。

第一个问题是 **指针关系**。这些元数据对象不是一张张独立卡片，而是一个互相引用的对象图。对象内部埋着大量指针，外部还有根集合指向它们。如果下一次启动时对象落在了不同地址，所有这些引用都得重新修。你当然可以做一整套“对象 ID → 新地址 → 回填指针”的反序列化系统，但那样得到的就不再是“映射即可用”的结果，而是“读文件后再重建一次对象图”。

第二个问题是 **内存属性**。HotSpot 希望一部分数据以后能被多个 JVM 进程共享，那就要尽量把它们放进只读页；一部分内容运行时还会被 patch，就必须放在可写页；一小块方法 trampoline 甚至要带执行权限。普通“对象序列化”关心的是如何恢复逻辑关系，CDS 关心的是如何恢复 **一段页属性正确、布局连续、地址假设稳定** 的共享映射。

这也是为什么 dump 端真正的核心类名叫 `ArchiveCompactor`，而不是“Serializer”。它的动作顺序也不是“遍历对象图、写对象、写引用表”，而是“分读写属性做浅拷贝、建立新旧地址映射、批量重定位嵌入指针和外部根”。`share/memory/metaspaceShared.cpp:1089`、`share/memory/metaspaceShared.cpp:1106`、`share/memory/metaspaceShared.cpp:1107`、`share/memory/metaspaceShared.cpp:1180`、`share/memory/metaspaceShared.cpp:1205`、`share/memory/metaspaceShared.cpp:1211`

所以这条路虽然比缓存 `.class` 更聪明，但仍然不够贴近 HotSpot 的真正目标。CDS 不是想得到一份“可恢复对象”的文件，而是想得到一份“最好连恢复动作都省掉”的文件。

### 朴素方案三：边 dump 边继续长对象，最后统一收尾

第三个想法经常发生在理解 `-Xshare:dump` 时：既然前面已经把类加载起来了，那 dump 过程中继续让 metaspace 正常分配不就行了？最后统一扫一遍，把当时活着的对象全写出去。

这听上去很宽松，实际上和 dump 目标正面冲突。`VM_PopulateDumpSharedSpace::doit` 一开头就先 `Metaspace::freeze()`，而且源码把理由写得很直白。第一，`Metaspace::allocate` 可能在空间吃紧时触发 GC，但 dump 的主体运行在 VM 线程里，不能在这里再去走一次 GC。第二，`ArchiveCompactor` 需要面对一组 **稳定的** `MetaspaceObj`，这样才可能把对象复制、排布、重定位成一个封闭镜像。`share/memory/metaspaceShared.cpp:1333`、`share/memory/metaspaceShared.cpp:1336`、`share/memory/metaspaceShared.cpp:1339`、`share/memory/metaspace.hpp:168`

如果对象集还在增长，你就会遇到一连串连锁问题：

- 复制到一半，新对象又出现了，旧地址表不完整；
- 你刚算好的 `ro`/`rw` 边界被打破；
- 某个原本以为不会再变的 `ConstMethod` 又被运行期改写；
- 最致命的是，你根本无法保证“写到文件里的那一刻”对应着一个一致的进程内世界。

所以 `freeze` 不是实现细节，而是 dump 端最重要的约束之一。你可以把它理解成“快门按下去的那一刻，场景必须静止”，否则你拍出来的就不是一张可用的镜像，只是一堆拍摄中的残影。

到这里，三个失败方案其实已经把答案围出来了：

- 只缓存 `.class`，太早，没缓存到真正昂贵的结果；
- 逐对象序列化，太像恢复系统，不像可直接映射的镜像；
- 不冻结对象集，根本拿不到一致快照。

这时候 CDS 的真正设计就呼之欲出了：**先完整走一次类加载，拿到 HotSpot 已经认可的元数据对象；再把这些对象冻结、清理、压实、分区、重定位，做成一份以后想直接 `mmap` 的共享内存镜像。**

## `-Xshare:dump` 不是一个“附加动作”，而是一条独立启动路径

理解了上面的约束，再回头看入口，很多细节就顺了。`-Xshare:dump` 不是在正常 JVM 启动末尾顺手导出点信息，而是明确切到一条“为归档服务”的路径。入口就在 `MetaspaceShared::preload_and_dump`。`share/memory/metaspaceShared.cpp:1632`

这段函数先做一件很生活化但很关键的事：决定 classlist 从哪里来。如果没有显式指定 `SharedClassListFile`，它会从 JVM 自己的位置往上回溯目录，再拼出默认的 `lib/classlist` 路径；如果额外给了 `ExtraSharedClassListFile`，还会再追加一轮预加载。`share/memory/metaspaceShared.cpp:1638`、`share/memory/metaspaceShared.cpp:1642`、`share/memory/metaspaceShared.cpp:1658`、`share/memory/metaspaceShared.cpp:1671`

这一步看似只是找文件，其实已经透露出一个态度：CDS dump 不是“扫描当前应用碰巧用了哪些类”，而是 **按一份预先挑选的清单驱动一次可重复的基础类预加载**。这样做的好处是，归档内容可控，可被发行版预置，也能让不同机器上的 dump 行为更稳定。

更关键的是接下来的 `preload_classes`。这段代码没有什么“特殊读取归档对象”的捷径，它就是一行一行读 classlist，然后调用 `ClassLoaderExt::load_one_class` 去真正加载类。类一旦是 `InstanceKlass`，还会马上调用 `try_link_class`，主动把链接工作做掉，让字节码改写和 `cpCache` 创建尽早完成。`share/memory/metaspaceShared.cpp:1699`、`share/memory/metaspaceShared.cpp:1703`、`share/memory/metaspaceShared.cpp:1704`、`share/memory/metaspaceShared.cpp:1719`、`share/memory/metaspaceShared.cpp:1722`、`share/memory/metaspaceShared.cpp:1726`

这正好纠正了一个很常见的误解：**CDS dump 不是跳过类加载，而是先认真做完一遍类加载，再把成果保存下来。**

`ClassListParser` 自己也很克制。它做的只是打开文件、逐行读取、跳过注释、把 `\t\r\n` 归一成空格、裁掉末尾空白，再把这一行拆成类名和可选参数。它不碰 `SymbolTable`，不做真正加载，更不负责“生成归档对象”。这条分工线很重要，因为它告诉我们：classlist 只是 **输入脚本**，不是归档格式本身。`share/classfile/classListParser.cpp:46`、`share/classfile/classListParser.cpp:57`、`share/classfile/classListParser.cpp:78`、`share/classfile/classListParser.cpp:88`、`share/classfile/classListParser.cpp:103`、`share/classfile/classListParser.cpp:123`

这里可以先立一个局部结论：dump 端的前半段，不是在“写文件”，而是在 **造一组适合被写成共享镜像的元数据对象**。只有理解成这一层，后面的 `freeze`、`remove_unshareable`、`copy_and_compact` 才不会显得跳跃。

## 真正的 dump 核心不在 classlist，而在 VM 线程里的“冻结、清理、压实、重定位”

前面的预加载只能算备料。真正把“很多离散的 HotSpot 元数据对象”变成“一份可映射 archive”的动作，发生在 `VM_PopulateDumpSharedSpace::doit` 里，而且是由 VM 线程执行。`share/memory/metaspaceShared.cpp:1693`、`share/memory/metaspaceShared.cpp:1694`、`share/memory/metaspaceShared.cpp:1333`

这一步为什么要切到 VM 线程？因为接下来要做的不是普通 Java 类库层面的整理，而是直接碰 HotSpot 的全局元数据：扫 `ClassLoaderDataGraph`、合并系统字典、批量改写方法字节码、清除不可共享状态、重新布置元数据对象地址、写共享区文件。这些动作需要站在 VM 的中心视角下完成。

`doit()` 一开头就冻结 metaspace，我们前面已经解释过原因。随后它会确认共享路径表中的目录状态，检查字典里没有占位符、`invoke_method_table` 没有未处理残留，然后通过 `ClassLoaderDataGraph::loaded_classes_do` 把当前所有已加载类收集到 `_global_klass_objects`。这一步把“散在很多地方的类对象”收拢成一份全局数组，后面的批处理都围绕它展开。`share/memory/metaspaceShared.cpp:1344`、`share/memory/metaspaceShared.cpp:1347`、`share/memory/metaspaceShared.cpp:1354`、`share/memory/metaspaceShared.cpp:1357`、`share/memory/metaspaceShared.cpp:1359`

接着是一个很容易被漏掉、但对 dump 特别关键的动作：`rewrite_nofast_bytecodes_and_calculate_fingerprints()`。它会遍历归档类的方法，把某些会在运行时被改写的快速字节码恢复成 `_nofast_*` 形式，并顺手为方法计算 fingerprint。源码注释说得很明白，目的就是保证这些 `ConstMethod` 在运行期不需要再被修改。对 dump 来说，这等于在拍照前先把“以后还会动的部件”收回到稳定形态。`share/memory/metaspaceShared.cpp:1380`、`share/memory/metaspaceShared.cpp:526`、`share/memory/metaspaceShared.cpp:545`、`share/memory/metaspaceShared.cpp:550`、`share/memory/metaspaceShared.cpp:557`、`share/memory/metaspaceShared.cpp:558`

然后 HotSpot 会把 platform/system dictionaries 合并进 boot dictionary，并检查共享类的 loader type。这里的意图也很统一：dump 不是简单保存“当前内存里碰巧长什么样”，而是尽量把将来要共享给大家的那一份状态收束到更稳定、可重放的布局里。`share/memory/metaspaceShared.cpp:1385`、`share/memory/metaspaceShared.cpp:1388`

再往下就是另一个关键口：`remove_unshareable_in_classes()`。这个函数遍历全局类数组，对每个非对象数组类调用 `remove_unshareable_info()`，把那些只属于当前运行期、下次启动不能直接共享的部分剥掉。注意，这一步和后面的 `remove_java_mirror_in_classes()` 不是一回事。前者先清掉“不可共享信息”，后者在写只读表前再专门把 `java_mirror` 从类里摘掉。两个函数的分工如果混了，读者很容易误以为 CDS 只是“把 mirror 去掉就完了”。`share/memory/metaspaceShared.cpp:1391`、`share/memory/metaspaceShared.cpp:489`、`share/memory/metaspaceShared.cpp:496`、`share/memory/metaspaceShared.cpp:501`、`share/memory/metaspaceShared.cpp:508`、`share/memory/metaspaceShared.cpp:1300`、`share/memory/metaspaceShared.cpp:1304`

到这里，主线终于来到本篇最该记住的实现名：`ArchiveCompactor::copy_and_compact()`。如果你只记一个函数名，应该记它，因为这才是“CDS dump 不是对象序列化，而是内存镜像构造”的最直接证据。`share/memory/metaspaceShared.cpp:1400`、`share/memory/metaspaceShared.cpp:1401`

## `copy_and_compact` 真正在做什么：先浅拷贝，再重定位，不是“递归序列化对象图”

`ArchiveCompactor` 的第一步是 `initialize()`，建立统计器和新旧地址映射表。真正的 `copy_and_compact()` 分成非常鲜明的四段：

1. 扫根并浅拷贝 `RW` 对象；
2. 再浅拷贝 `RO` 对象；
3. 重定位对象内部嵌入指针；
4. 重定位外部根指针。 `share/memory/metaspaceShared.cpp:1081`、`share/memory/metaspaceShared.cpp:1083`、`share/memory/metaspaceShared.cpp:1180`、`share/memory/metaspaceShared.cpp:1187`、`share/memory/metaspaceShared.cpp:1196`、`share/memory/metaspaceShared.cpp:1205`、`share/memory/metaspaceShared.cpp:1211`

这四段的顺序本身就说明它不是常见意义上的序列化。普通序列化往往是“看到一个对象，递归下去，把整个对象图编码出来”；这里的做法却更像一次“搬家”：先把对象按照只读/可写属性分区搬到新地址，再根据 `_new_loc_table` 把旧引用改到新位置。`allocate()` 里先按 `read_only` 决定从 `_ro_region` 还是 `_rw_region` 取空间，然后直接 `memcpy` 对象内容，接着把 “旧地址 → 新地址” 记进 relocation table。`share/memory/metaspaceShared.cpp:1089`、`share/memory/metaspaceShared.cpp:1097`、`share/memory/metaspaceShared.cpp:1102`、`share/memory/metaspaceShared.cpp:1106`、`share/memory/metaspaceShared.cpp:1107`

也就是说，CDS dump 端根本不是在“重新解释对象”，而是在 **尽量保留对象机器内存形态的前提下，给它们安排一套更适合长期保存与共享映射的新地址**。这一点是理解整个机制的钥匙。

再往后，`ShallowCopyEmbeddedRefRelocator` 负责修对象内部的元数据指针，`RefRelocator` 负责修外部根集合。到了 `ASSERT` 模式下，`IsRefInArchiveChecker` 还会再验证所有引用最终都落到 `_ro_region` 或 `_rw_region` 之内。你会发现这整个流程关注的都是“引用是否已经指向 archive 中的新地址”，而不是“对象有没有被恢复成某种逻辑模型”。这就是镜像思维和序列化思维的差别。`share/memory/metaspaceShared.cpp:1144`、`share/memory/metaspaceShared.cpp:1147`、`share/memory/metaspaceShared.cpp:1157`、`share/memory/metaspaceShared.cpp:1166`、`share/memory/metaspaceShared.cpp:1171`

这里再给一个路标：如果前面内容太细，只需先记住两个动作。第一，归档对象不是重新编码，而是浅拷贝到新 region。第二，所有引用关系都要改成指向 archive 里的新地址。只抓住这两点，后面看 region 布局和固定基址时就不会迷路。

## 为什么要分区：CDS 保存的不是一坨数据，而是一段带页属性语义的共享空间

理解了 `copy_and_compact` 是在搬对象，接下来就能回答另一个常见问题：为什么非要拆 `mc`、`rw`、`ro`、`md` 这些区？直接拼成一个大块文件不行吗？

不行，因为 HotSpot 保存的不是“信息集合”，而是“以后要以特定权限映射的内存布局”。在 `MetaspaceShared` 的 region 枚举里，核心区有四个：`mc`、`rw`、`ro`、`md`。其中 `mc` 是方法 trampoline 用的杂项代码区，`rw` 是加载后仍可能被写的共享元数据，`ro` 是只读共享元数据，`md` 是初始化表格等杂项数据。除此之外，JDK 11u 还定义了两个字符串区和两个 open archive heap region 的索引。按 `metaspaceShared.hpp` 的枚举，命名 region 一共是 8 个。`share/memory/metaspaceShared.hpp:66`、`share/memory/metaspaceShared.hpp:68`、`share/memory/metaspaceShared.hpp:69`、`share/memory/metaspaceShared.hpp:70`、`share/memory/metaspaceShared.hpp:71`、`share/memory/metaspaceShared.hpp:77`、`share/memory/metaspaceShared.hpp:80`、`share/memory/metaspaceShared.hpp:84`

如果你只看 `share/include/cds.h`，又会看到 `NUM_CDS_REGIONS` 是 9。这里要特别提醒版本实现边界：JDK 11u 的 `cds.h` 预留了 9 个 filemap region 槽位，但 `metaspaceShared.hpp` 里有名字的运行时 region 索引是 8 个。写正文时真正描述布局，应当以 dump 过程实际写出的核心区和堆归档区为主，不要把“文件头数组容量”和“当前实现实际命名的区域数”混成一层。`share/include/cds.h:36`、`share/memory/metaspaceShared.hpp:84`

真正落到 dump 写盘时，HotSpot 会先写四个 core spaces，再写字符串区和 open archive heap regions。源码里 `write_region()` 的调用次序非常清楚：`mc`、`rw`、`ro`、`md`。后面再调用 `write_archive_heap_regions()` 处理字符串区与 open archive heap 区。`share/memory/metaspaceShared.cpp:1458`、`share/memory/metaspaceShared.cpp:1459`、`share/memory/metaspaceShared.cpp:1460`、`share/memory/metaspaceShared.cpp:1461`、`share/memory/metaspaceShared.cpp:1463`、`share/memory/metaspaceShared.cpp:1468`

为什么必须这样拆？因为下一次 `mmap` 进来时，每种内容需要的页权限并不一样。

- `ro` 希望尽量纯只读，这样多个 JVM 进程可以稳定共享；
- `rw` 需要容纳运行期补丁与可变内容；
- `mc` 要容纳可执行代码；
- `md` 虽然叫 misc data，但源码注释点得很清楚，其中带有方法入口 trampoline 之类会在运行时 patch 的内容，因此也不能做成只读。`share/memory/metaspaceShared.cpp:1456`

所以 region 分拆不是审美问题，而是共享内存的页属性要求决定的。如果你把它想成一个数据库导出文件，`rw/ro/mc/md` 就会显得过度设计；如果你把它想成一段未来会被原样映射进进程地址空间的内存，分区就变成了最自然的动作。

## 固定基址不是锦上添花，而是“指针尽量原样成立”的前提

到这里还剩最后一个大疑问：就算你把对象压到了新的 region 里，下次启动时它们还是要被映射到某个地址。地址如果变了，这些指针关系不还是要大修吗？

这正是 dump 端为什么从一开始就关心地址布局的原因。`initialize_dumptime_shared_and_meta_spaces()` 会先尝试在 `SharedBaseAddress` 附近保留一大块共享区；在 64 位下，又会把预留出来的 4GB 空间拆成两部分：上面的 1GB 当作临时 compressed class space，供 `preload_classes()` 阶段放 `Klass`；下面的大约 3GB 留给最终 archive，等预加载完成后再由 `ArchiveCompactor` 把类元数据复制进去。`share/memory/metaspaceShared.cpp:251`、`share/memory/metaspaceShared.cpp:255`、`share/memory/metaspaceShared.cpp:275`、`share/memory/metaspaceShared.cpp:289`、`share/memory/metaspaceShared.cpp:290`、`share/memory/metaspaceShared.cpp:292`

更关键的是，HotSpot 在 dump 时主动把 `narrow_klass_base` 设成共享区基址：`Universe::set_narrow_klass_base((address)_shared_rs.base())`。同时还设置 `narrow_klass_shift` 和地址范围。这个动作的意义不是“顺手记一下参数”，而是让压缩 klass 指针的编码基准从一开始就和 archive 共享区对齐。`share/memory/metaspaceShared.cpp:304`、`share/memory/metaspaceShared.cpp:305`、`share/memory/metaspaceShared.cpp:308`、`share/memory/metaspaceShared.cpp:310`

把这个设计翻译成人话就是：**CDS 希望以后把共享区重新映射到同样的基址附近，这样大量依赖该基址的指针关系就能少修，甚至原样成立。**

这也是为什么加载端会对一堆“看起来和类内容无关”的配置特别敏感，比如压缩指针模式、对象对齐、最大堆、类路径状态。因为这些外部条件一旦变了，“同样一份字节内容映射进来就能用”的前提就不成立了。换句话说，CDS 归档不是抽象字节码缓存，而是 **带着地址与布局假设的半成品运行时内存**。

这里顺手把另一个误解也堵住：CDS 不是要求所有指针在任何机器、任何地址上都一字不差地天然成立。它的目标是尽量把最有价值、最稳定的那部分对象放到一个固定布局里，减少加载时修补成本，并用严格校验保护这套假设。一旦假设不成立，HotSpot 宁可放弃归档，也不冒险使用半对半错的共享镜像。

## 文件头和校验之所以复杂，是因为 HotSpot 在检查“这份内存镜像的成立条件还在不在”

讲到这里，`filemap` 头里的 magic、版本、CRC、路径表终于能放回正确语境里了。它们不是为了把 archive 变成一个“可被普通工具读取的格式”，而是为了在加载前确认：**这份镜像是在什么前提下做出来的，而当前 JVM 还能不能满足这些前提。**

`filemap.hpp` 最上面的注释就把 archive 的大体布局写出来了：header、页对齐填充、读写区、只读区、杂项数据区，再跟一个 tag。magic 是 `0xF00BABA2`。实际常量定义在 `share/include/cds.h`，当前版本号是 5。`share/memory/filemap.hpp:36`、`share/memory/filemap.hpp:37`、`share/include/cds.h:37`、`share/include/cds.h:38`

`FileMapHeader` 里保存的不只是 magic 和版本，还有对象对齐、压缩 oop/klass 的基址与 shift、`CompactStrings`、dump 时的最大堆、共享路径表大小、路径杂项信息等一大串环境前提。读起来像文件格式字段，实质上更像“这份共享镜像的成立合同”。`share/memory/filemap.hpp:96`、`share/memory/filemap.hpp:97`、`share/memory/filemap.hpp:99`、`share/memory/filemap.hpp:104`、`share/memory/filemap.hpp:105`、`share/memory/filemap.hpp:119`、`share/memory/filemap.hpp:132`

运行时校验也正是按这个思路来的。`FileMapHeader::validate()` 会先比对 `ObjectAlignmentInBytes`、`CompactStrings` 等设置，再处理是否允许归档平台类和应用类的边界。`FileMapInfo::validate_header()` 在 header 自身通过后，还会继续检查共享路径的杂项信息。更底层的 `validate()` 还会比对 magic、版本、JVM 标识和 CRC。注意这里的语气不是“能不能读懂文件”，而是“当前 JVM 配置与 dump 时是否兼容”。`share/memory/filemap.cpp:1359`、`share/memory/filemap.cpp:1360`、`share/memory/filemap.cpp:1366`、`share/memory/filemap.cpp:1397`、`share/memory/filemap.cpp:1401`、`share/memory/filemap.cpp:537`、`share/memory/filemap.cpp:545`、`share/memory/filemap.cpp:568`、`share/memory/filemap.cpp:576`

下一篇我们会看到，真正 `map_shared_spaces()` 时不仅要把 `mc/rw/ro/md` 分别映射进来，还要求这些 core spaces 连续排布，并且通过 `validate_shared_path_table()`。这再次印证了本文的中心句：HotSpot 不是在找一份“逻辑上正确的类数据库”，它是在找一份“当前进程仍能安全接上的共享内存镜像”。`share/memory/metaspaceShared.cpp:2033`、`share/memory/metaspaceShared.cpp:2052`、`share/memory/metaspaceShared.cpp:2057`、`share/memory/metaspaceShared.cpp:2058`、`share/memory/metaspaceShared.cpp:2063`

## dump 的尾声：写盘是最后一步，而且写的是已经成形的空间

理解到这里，再看写盘部分，整个流程就会显得非常顺。`VM_PopulateDumpSharedSpace::doit()` 在完成压实、符号表写出、堆对象归档、只读表组织之后，才开始构造 `FileMapInfo`，填 header，并以两遍方式写文件。第一遍不真正落盘，只更新 header 所需字段；第二遍在 header 定稿后计算 CRC，打开文件，再把 header 与所有 region 正式写出。`share/memory/metaspaceShared.cpp:1403`、`share/memory/metaspaceShared.cpp:1408`、`share/memory/metaspaceShared.cpp:1412`、`share/memory/metaspaceShared.cpp:1435`、`share/memory/metaspaceShared.cpp:1443`、`share/memory/metaspaceShared.cpp:1445`、`share/memory/metaspaceShared.cpp:1448`、`share/memory/metaspaceShared.cpp:1451`、`share/memory/metaspaceShared.cpp:1452`

这个双遍写盘的小细节很能说明问题。HotSpot 并不是一边生成对象一边随手写文件，而是先把共享空间在内存中组织成型，等 header 也完整后，再统一把这份镜像写成归档。这和“对象流式序列化”是两种完全不同的心态。

最后打印 region 统计时，`mc`、`rw`、`ro`、`md` 的已用空间会与字符串区、open archive 区一起汇总，形成我们平时在 `-Xshare:dump` 输出里看到的那张表。也就是说，命令行里那几行统计并不是另做的一份摘要，而是对刚刚被写出的共享空间布局的直接汇报。`share/memory/metaspaceShared.cpp:1496`、`share/memory/metaspaceShared.cpp:1502`、`share/memory/metaspaceShared.cpp:1508`、`share/memory/metaspaceShared.cpp:1512`、`share/memory/metaspaceShared.cpp:1515`

## 到这里，把最容易想错的几件事一起收回来

第一，CDS dump 不是缓存 `.class` 文件。它当然依赖 classlist，也会复用正常类加载流程，但真正保存的是 HotSpot 已经构造好的运行时元数据与归档堆对象，而不是 class 文件字节流副本。`share/memory/metaspaceShared.cpp:1699`、`share/memory/metaspaceShared.cpp:1704`、`share/memory/metaspaceShared.cpp:1403`、`share/memory/metaspaceShared.cpp:1408`

第二，CDS dump 不是跳过类加载。恰恰相反，它要先把类正常加载并尽量链接好，否则根本拿不到可归档的元数据对象。`share/memory/metaspaceShared.cpp:1722`、`share/memory/metaspaceShared.cpp:1726`

第三，`ArchiveCompactor::copy_and_compact()` 不是“把对象递归序列化”。它更像一次按页属性分区的内存搬迁：先浅拷贝，再建新旧地址表，再修对象内部与外部引用。`share/memory/metaspaceShared.cpp:1106`、`share/memory/metaspaceShared.cpp:1107`、`share/memory/metaspaceShared.cpp:1205`、`share/memory/metaspaceShared.cpp:1211`

第四，`freeze` 不是多余保险丝。没有稳定对象集，就没有一致镜像；而在 VM 线程里还要防止 metaspace 分配触发 GC，所以冻结是前提，不是尾声。`share/memory/metaspaceShared.cpp:1336`、`share/memory/metaspaceShared.cpp:1339`

第五，`rw/ro/mc/md` 的拆分不是“文件格式细节”，而是未来 `mmap` 后页权限与共享语义的提前表达。`ro` 追求共享只读，`rw` 与 `md` 为运行期 patch 留路，`mc` 保持可执行。`share/memory/metaspaceShared.cpp:1456`、`share/memory/metaspaceShared.cpp:1458`、`share/memory/metaspaceShared.cpp:1460`

第六，文件头和路径校验不是官样文章。它们是在保护同一个核心假设：这份 archive 当年就是按某组布局、指针、类路径和 JVM 选项做出来的；只要这些条件不再成立，HotSpot 就应该拒绝把它当作共享内存镜像接进来。`share/memory/filemap.cpp:1397`、`share/memory/filemap.cpp:1401`、`share/memory/filemap.cpp:537`、`share/memory/filemap.cpp:568`

## 收网：CDS dump 真正保存的，是 HotSpot 未来想直接接回来的那段内存

现在可以把全篇压成一张总图了。

`-Xshare:dump` 的前半段先按 classlist 预加载核心类，并尽量提前完成链接；中段切到 VM 线程，冻结 metaspace，收集已加载类，清掉运行期不可共享状态，把方法字节码收回到稳定形态；核心阶段通过 `ArchiveCompactor` 按读写属性把对象搬进新的共享 region，并把所有引用改到新地址；最后再把这份已经成形的空间，连同头部、路径信息、校验信息一起写成归档文件。`share/memory/metaspaceShared.cpp:1632`、`share/memory/metaspaceShared.cpp:1699`、`share/memory/metaspaceShared.cpp:1333`、`share/memory/metaspaceShared.cpp:1380`、`share/memory/metaspaceShared.cpp:1391`、`share/memory/metaspaceShared.cpp:1401`、`share/memory/metaspaceShared.cpp:1454`

所以，CDS dump 最核心的一句话答案不是“把类保存起来”，而是：

**把一批已经链接好的核心类与相关共享数据，整理成一份以后最好能被固定地址 `mmap` 进来并直接接上 HotSpot 运行时的数据镜像。**

只要这句话记住了，下一篇的加载端就好理解了：JVM 启动时为什么要这么严格地校验路径、版本、对象对齐和压缩指针参数；为什么 `mmap` 成功还不算完；以及最关键的，映射进来的共享类最终是怎么重新挂回 `SystemDictionary`，看起来像“刚刚被正常解析和链接过”一样。

> → [11-cds/02 — mmap archive → shared spaces → 类就绪](02-cds-load-shared.md)
