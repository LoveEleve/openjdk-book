# 01. JIT 怎么看到 Java 类？— `ciObject` 镜像体系

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 HotSpot C1/C2 共用的 `ci`（compiler interface）镜像层：编译器如何观察类、方法、字段和对象，而不直接把 VM 运行时对象搬进编译热路径。Graal/JVMCI、CompileBroker 调度细节、后续 IR 构建细节，不在本文展开。
>
> **前置依赖**：[11-cds/02 — mmap 之后共享类怎么进 `SystemDictionary`？— CDS Load 端的对位、接线与激活](../11-cds/02-cds-load-shared.md)、[06-oops/02 — `Klass` — 对象到类的桥](../06-oops/02-klass-hierarchy.md)、[16-code-cache/02 — `nmethod` 结构](../16-code-cache/02-nmethod-structure.md)、[07-classfile-classloader/04 — `SystemDictionary`](../07-classfile-classloader/04-system-dictionary.md)
> → **后续**：[12-ci/02 — `ciTypeFlow + bcEscapeAnalyzer` — 类型流与逃逸分析](02-ci-typeflow-escape.md)

JIT 编译器在做的事情，远比“把字节码翻成机器码”要具体得多。

它要判断一个调用是不是虚调用，某个接口有没有唯一实现者，`String.length()` 能不能内联，某个字段是不是编译期常量，某个类型检查能不能提前折叠。这些判断都离不开 HotSpot 运行时内部那套真正的类与方法对象：`InstanceKlass`、`Method`、`fieldDescriptor`、常量池、方法数据、类层级。

这就会逼出一个看起来很自然的问题：**既然 JIT 就跑在 HotSpot 里面，为什么不直接读这些 VM 对象？为什么还要多做一层 `ciObject`、`ciKlass`、`ciMethod` 的镜像？**

这个问题如果没想透，后面的 `ciObjectFactory`、`ciEnv`、`ciField`、`Dependencies` 看起来都会像“又一层抽象封装”。但这层东西的真正目标，不是 API 好不好看，而是更硬的一件事：**给编译器提供一份在整个编译期间都足够稳定、足够便宜、足够安全的只读视图。**

JIT 缺的不是“拿到 VM 对象地址的入口”，而是这样一份视图。

先把这一句记住。因为 `ci` 层的所有设计——为什么 oop 走句柄，为什么 Metadata 走裸指针，为什么一编译一工厂，为什么普通类不跨编译共享，为什么还要有 Dependencies——都是从这个缺口里长出来的。

## 先试三个最自然的办法，看看它们为什么都会把编译器带沟里去

### 朴素方案一：直接把 `oop*`、`InstanceKlass*`、`Method*` 交给编译器长期拿着

这是最直觉的想法。编译器反正就在 VM 里，类和方法对象都现成地躺在那里，那就把指针传进去，后面每次要看字段偏移、方法大小、继承关系，直接读不就完了？

问题在于，这三类对象的稳定性根本不是一个级别。

先看 `oop`。Java 堆对象会被 GC 搬动。编译线程在编译过程中并不独占世界，GC 来了，编译线程会被停下；GC 走完，编译线程再继续。如果它手里拿的是一个裸 `oop*`，GC 一搬，那个地址就悬了。`ciObject` 的类注释为什么专门强调 “GC and compilation can proceed independently without interference”，根就在这里：编译器不能依赖会被堆压缩和复制改写的裸地址。`share/ci/ciObject.hpp:35`、`share/ci/ciObject.hpp:40`、`share/ci/ciObject.hpp:41`

再看 `InstanceKlass*` 和 `Method*`。它们倒是不在 Java 堆里，不会像 oop 那样被 GC 搬家，但直接把 VM 内部对象交给编译器也有别的代价：这些对象是按 VM 运行时需要设计的，不是按编译器热路径查询设计的。类加载状态、`ClassLoaderData` 关联、各种访问检查、包与模块关系、JVMTI 与重定义边界，全都跟着进来了。编译器真正高频要问的问题，往往只是“这个类是不是接口”“这个字段偏移是多少”“这个方法字节码多大”“它能不能静态绑定”。如果每次都背着整桶 VM 语义往前走，编译路径会被 VM 的活对象复杂性拖得很重。

最要命的是，世界本身会变。类可以被并发加载，方法可以被 RedefineClasses 影响，`CallSite` 目标可以失效。也就是说，就算你手里的指针本身没悬空，它所代表的“编译假设”也可能在编译过程中变旧。单靠“我能读到这个对象”远远不够，编译器还需要知道“我基于它做出的结论还能不能成立”。`share/ci/ciEnv.cpp:928`、`share/ci/ciEnv.cpp:933`、`share/ci/ciEnv.cpp:939`

所以第一条路的问题不是“做不到直接读”，而是“直接读不能给出一份编译期稳定语义”。

### 朴素方案二：那就别长期持有，编译器每查一次都回 VM 现问现答

第二个想法听起来更稳健：既然长期拿 VM 对象不安全，那编译器干脆别缓存。每当它想知道某个类是不是接口、某个方法能不能静态绑定、某个字段是不是常量，就临时回 VM 问一次，问完就丢。

这条路当然更安全，但它会让编译器失去另一个很重要的东西：**本次编译内部的一致视图。**

编译不是一次问一个问题就结束，而是在一连串决策之间反复依赖同一批对象。如果每次都现问现答，你就会遇到两个问题。

第一，成本高。很多查询会被非常频繁地重复：类层级、方法属性、字段偏移、方法字节码大小、profile 数据、常量池解析结果。把这些都做成“每次跨墙回 VM 现取”，编译热路径就会被边界切换拖垮。

第二，更难得到“同一时刻”的编译视图。假设你前半段编译看见某个方法可以静态绑定，后半段再问一次时，世界已经因为并发类加载而变了。这样一来，前后两段决策就不是基于同一份事实快照做的，编译器内部反而更难自洽。

所以 `ci` 层要做的不是“杜绝回 VM”，而是“把该快照的高频信息先快照下来，把不值得快照、或者天然应该交给 VM 算的部分再按需回问 VM”。这也是为什么 `ciKlass::is_subtype_of` 这样的操作仍然明确 `VM_ENTRY_MARK` 回到 VM，而很多 access flag、字段偏移、方法大小则会在镜像构造时就抄成标量。`share/ci/ciKlass.cpp:67`、`share/ci/ciKlass.cpp:77`、`share/ci/ciKlass.cpp:80`、`share/ci/ciMethod.cpp:76`、`share/ci/ciMethod.cpp:80`、`share/ci/ciField.cpp:246`、`share/ci/ciField.cpp:249`

### 朴素方案三：那就做一个全局永久镜像池，所有编译共享同一份 `ciKlass`

第三个想法更进一步：既然编译内部需要稳定视图、反复查值，那 HotSpot 不如做一个全局的镜像池。每个 `InstanceKlass`、每个 `Method`、每个 `oop` 永远只对应一份 `ci` 对象，所有编译会话都来复用它。

这对一小部分“永远不太变”的对象成立，比如 `java/lang/Object` 这样的 well-known 类、基本类型、VM 内置符号。它们确实值得在启动期就建成共享镜像。

但对普通类来说，这条路会让缓存过期问题急剧恶化。编译 A 看见的类层级、字段布局、共享状态、实现者信息，未必还能安全地交给编译 B。只要把普通类的 `ci` 镜像做成长期全局缓存，你就得再设计一整套跨编译失效与刷新机制，复杂度几乎又把 `ci` 层拖回了“直接绑定 VM 活对象”的世界。

所以 HotSpot 选的是一条更克制的边界：**每次编译有自己的一份镜像工厂，保证本次编译内部对象唯一；只有 well-known 类与 vmSymbols 这种稳定度极高的东西，才放进全局共享镜像。** `share/ci/ciObjectFactory.hpp:32`、`share/ci/ciObjectFactory.hpp:35`、`share/ci/ciObjectFactory.cpp:106`、`share/ci/ciObjectFactory.cpp:111`、`share/ci/ciObjectFactory.cpp:117`、`share/ci/ciObjectFactory.cpp:160`、`share/ci/ciObjectFactory.cpp:199`

到这里，三个失败方案已经把正确答案围出来了：

- 直接抓 VM 指针，稳定性和边界太差；
- 每次都回 VM 现问，热路径太贵，也难保本次编译视图一致；
- 做永久全局镜像池，普通类的快照又会跨编译过期。

这时 `ci` 层真正要提供的东西就清楚了：**一份“只对本次编译负责”的稳定视图。**

## `ci` 层提供的不是一套别名对象，而是一份“编译期视图”

`ci` 层最容易被误解成“VM 对象的轻量包装”。但从类定义开始，它讲的就不是“包装”，而是“镜像”。

`ciObject` 的注释写得很直白：它表示的是 HotSpot VM 里的一个 oop，而它的子类层级并不是简单复制 VM 的 oop/klass 双层体系，而是把两套层级折叠成编译器更方便消费的一套视图。`share/ci/ciObject.hpp:35`、`share/ci/ciObject.hpp:36`、`share/ci/ciObject.hpp:46`、`share/ci/ciObject.hpp:49`

更底层的 `ciBaseObject` 也已经透露了另一个关键信号：这些镜像对象本身是 `ResourceObj`，带有自己的 `_ident`。也就是说，`ci` 对象不是 VM 管的对象，它有自己在编译期世界里的身份编号和生命周期。`share/ci/ciBaseObject.hpp:50`、`share/ci/ciBaseObject.hpp:55`、`share/ci/ciBaseObject.hpp:66`

这个视角很重要。因为它意味着 `ci` 层从一开始就没有把自己设计成“随时同步 VM 实时状态”的二级表面，而是设计成“给一次编译用的、可持有的、对象身份稳定的编译器对象”。

后面我们会看到，这些镜像对象里有三类信息：

- 构造时立刻快照下来的高频标量；
- 首次用到时才展开的懒字段；
- 干脆不在 `ci` 层重复维护、而是按需回 VM 查询的关系计算。

这三类分工，本质上就是对“什么值得变成编译期视图”的一次筛选。

## 第一根主梁：为什么 oop 走句柄，而 Metadata 走裸指针

`ci` 层最核心的安全设计，其实只在一句很朴素的话里：**会移动的，绕一层；不移动的，直接用。**

在 `ciObject` 里，真正保存 VM 对象引用的是一个 `jobject _handle`，也就是 JNI handle，而不是裸 `oop*`。构造函数里也写得非常明确：如果 `ciObjectFactory` 已经初始化，就用 `JNIHandles::make_local`；初始化阶段的共享对象则用 `make_global`。`share/ci/ciObject.hpp:55`、`share/ci/ciObject.hpp:56`、`share/ci/ciObject.cpp:53`、`share/ci/ciObject.cpp:55`、`share/ci/ciObject.cpp:56`、`share/ci/ciObject.cpp:68`、`share/ci/ciObject.cpp:71`

这条路的意义非常直接。GC 搬对象时，JNI handle 会被正确更新；编译线程在 safepoint 后恢复运行，再通过 handle 取 oop，就能拿到新地址。也就是说，编译器从此不需要自己承担“对象会不会被搬家”的问题。

反过来，`Metadata` 这条路就不同了。`ciObject` 只负责 oop，而 `ciMetadata`/`ciKlass`/`ciMethod` 这批镜像对应的是 metaspace 里的 `Klass`、`Method`、`MethodData` 等对象。它们不参与 Java 堆对象那种搬移式 GC，所以工厂可以直接按 `Metadata*` 做排序和缓存。`ciObjectFactory::metadata_compare` 甚至就是直接拿 `constant_encoding()` 的地址做大小比较。`share/ci/ciObjectFactory.cpp:261`、`share/ci/ciObjectFactory.cpp:262`、`share/ci/ciObjectFactory.cpp:263`

这就是为什么 `ciObjectFactory` 对 oop 用哈希桶，而对 metadata 用有序数组二分：前者地址会动，不适合拿来做稳定排序键；后者地址稳定，正好可以直接排序缓存。`share/ci/ciObjectFactory.hpp:67`、`share/ci/ciObjectFactory.cpp:243`、`share/ci/ciObjectFactory.cpp:257`、`share/ci/ciObjectFactory.cpp:305`、`share/ci/ciObjectFactory.cpp:307`、`share/ci/ciObjectFactory.cpp:331`

这里还可以顺手把“未加载镜像”这个概念也看清。`ciObject::is_loaded()` 的定义是 `handle() != NULL || is_classless()`。也就是说，`ci` 对象允许表示一种“语义上存在、但 VM 实体还没到位”的占位状态。比如未解析类、未找到方法、未创建的 `java.lang.Class` mirror，都可以先在编译期以未加载镜像出现。编译器并不要求所有东西都先变成 VM 里的活对象，才允许自己开始推理。`share/ci/ciObject.hpp:132`、`share/ci/ciObject.hpp:138`

到这里可以先收一个很关键的局部结论：**`ci` 层并不是把所有 VM 对象都“复制一份”，而是按对象稳定性选不同引用策略：oop 用 handle 隔离 GC，Metadata 用裸指针保留低成本访问。**

## 第二根主梁：为什么是一编译一工厂，而不是整个 JVM 一池到底

理解了引用策略，再看对象生命周期就顺了。`ciEnv` 本身就是“一次编译的上下文”。构造时，它会把 `_arena` 指向自己的编译 Arena，并在这个 Arena 里 new 一份 `ciObjectFactory`。析构时，再把工厂里本次编译创建的符号引用计数减掉，并把当前线程上的 env 清空。`share/ci/ciEnv.cpp:130`、`share/ci/ciEnv.cpp:131`、`share/ci/ciEnv.cpp:190`、`share/ci/ciEnv.cpp:191`、`share/ci/ciEnv.cpp:215`、`share/ci/ciEnv.cpp:218`、`share/ci/ciEnv.cpp:221`

这说明普通 `ci` 对象的默认寿命，就是“一次编译”。不是跟线程同寿，也不是跟 JVM 同寿。

在这个前提下，`ciObjectFactory` 的角色就很清楚了：它不是一个全局注册中心，而是“本次编译的镜像唯一性保证器”。类注释点得很死：对于每个 oop，至多创建一个 `ciObject`。这个不变量让编译器可以放心地用对象身份来比较镜像，而不用担心同一底层对象在一次编译里被包装成两份不同的 `ciObject`。`share/ci/ciObjectFactory.hpp:32`、`share/ci/ciObjectFactory.hpp:35`、`share/ci/ciObjectFactory.hpp:36`

它内部的两套缓存结构也非常贴合前一节说的双通道引用：

- `_non_perm_bucket[61]` 这套桶是给 oop 用的；
- `_ci_metadata` 这套有序数组是给 Metadata 用的。`share/ci/ciObjectFactory.hpp:48`、`share/ci/ciObjectFactory.hpp:49`、`share/ci/ciObjectFactory.hpp:67`、`share/ci/ciObjectFactory.hpp:68`

`get(oop key)` 的流程很简单：先按 oop 找桶，命中就返回旧镜像；没命中就 `create_new_object`，给它编号，再插进桶里。这样，同一个 oop 在本次编译里永远只对应一份 `ciObject`。`share/ci/ciObjectFactory.cpp:238`、`share/ci/ciObjectFactory.cpp:243`、`share/ci/ciObjectFactory.cpp:248`、`share/ci/ciObjectFactory.cpp:253`、`share/ci/ciObjectFactory.cpp:257`

`get_metadata(Metadata* key)` 的逻辑也一样，只是底层容器换成了有序数组：先 `find_sorted` 二分查找，没找到就 `create_new_metadata`，必要时重算插入位置，再按序插回。这样，同一个 `Method*`、`Klass*`、`MethodData*` 在本次编译里也只会有一份镜像。`share/ci/ciObjectFactory.cpp:287`、`share/ci/ciObjectFactory.cpp:305`、`share/ci/ciObjectFactory.cpp:318`、`share/ci/ciObjectFactory.cpp:321`、`share/ci/ciObjectFactory.cpp:328`、`share/ci/ciObjectFactory.cpp:331`

但 HotSpot 也不是把所有东西都做成 per-compilation。`ciObjectFactory::initialize()` 会在 VM 初始化期建立一份长命 Arena，借一个临时 `ciEnv initial(arena)` 来生成“所有编译共享的 ciObjects”。`init_shared_objects()` 里会创建 vmSymbols 对应的共享 `ciSymbol`、基本类型 `ciType`、`ciNullObject`，以及 well-known 类的 `ciInstanceKlass`。最后还把 `_shared_ident_limit` 定成共享对象 ident 的边界：这个边界以下的 ident 永久属于全局共享对象，以上的 ident 则由每个新 `ciEnv` 重新分配。`share/ci/ciObjectFactory.cpp:106`、`share/ci/ciObjectFactory.cpp:111`、`share/ci/ciObjectFactory.cpp:115`、`share/ci/ciObjectFactory.cpp:123`、`share/ci/ciObjectFactory.cpp:130`、`share/ci/ciObjectFactory.cpp:147`、`share/ci/ciObjectFactory.cpp:157`、`share/ci/ciObjectFactory.cpp:160`、`share/ci/ciObjectFactory.cpp:199`、`share/ci/ciObjectFactory.cpp:204`

这条边界非常值得记住：**对永远稳定的对象，ci 层愿意全局共享；对普通类和方法，ci 层只承诺“本次编译内部唯一”，不承诺“跨编译永远同一份镜像”。**

这正是它躲开“全局永久镜像池”那个陷阱的方法。

## `ciInstanceKlass`：该快照的先快照，该懒算的先别碰

理解了 `ci` 层的寿命与唯一性，再看具体镜像类就会顺很多。`ciInstanceKlass` 不是把 `InstanceKlass` 完整复制一份，而是把“编译最爱问、而且比较稳定”的那部分标量先抄下来。

从字段定义就能看出来：`_init_state`、`_is_shared`、`_has_finalizer`、`_has_subklass`、`_has_nonstatic_fields`、`_has_nonstatic_concrete_methods`、`_is_anonymous`、`_flags`、`_nonstatic_field_size`、`_nonstatic_oop_map_size`，这些都是典型的“快照后直接位读/数值读”的字段。`share/ci/ciInstanceKlass.hpp:50`、`share/ci/ciInstanceKlass.hpp:51`、`share/ci/ciInstanceKlass.hpp:58`、`share/ci/ciInstanceKlass.hpp:59`、`share/ci/ciInstanceKlass.hpp:60`

与此同时，`_super`、`_java_mirror`、`_field_cache`、`_nonstatic_fields` 这些更重的结构则保持懒加载。原因也很朴素：编译一个方法未必会真去看完整字段表或 `java_mirror`，没必要一上来就把整棵类信息树拷全。`share/ci/ciInstanceKlass.hpp:62`、`share/ci/ciInstanceKlass.hpp:63`、`share/ci/ciInstanceKlass.hpp:64`、`share/ci/ciInstanceKlass.hpp:66`、`share/ci/ciInstanceKlass.hpp:67`

这里能看出镜像层很清晰的一条取舍：**高频小查询，做成快照；可能很大但不是总会用到的结构，做成懒字段。**

但 `ciInstanceKlass` 也没有试图把一切都本地化。比如 `ciKlass::is_subtype_of` 就直接 `VM_ENTRY_MARK` 回到 VM，让真正的 `Klass::is_subtype_of` 来算。原因其实不复杂：类层级判定已经有成熟而高效的 VM 侧实现，没必要在 `ci` 层再维护一套并随时同步。`share/ci/ciKlass.cpp:68`、`share/ci/ciKlass.cpp:77`、`share/ci/ciKlass.cpp:80`

这点特别能说明 `ci` 的哲学：它不追求“永不回 VM”，而追求“只在值得回的时候回”。

共享类还有自己的特殊补丁逻辑。`ciInstanceKlass` 里 `update_if_shared()` 会在共享类的 `_init_state` 看起来和预期不一致时，重新计算共享初始化状态。也就是说，`ci` 层并不盲信构造时抄到的那份状态值，只要对象是共享类、而且状态问题和共享恢复语义有关，就按需更新。`share/ci/ciInstanceKlass.hpp:101`、`share/ci/ciInstanceKlass.hpp:108`、`share/ci/ciInstanceKlass.hpp:109`、`share/ci/ciInstanceKlass.hpp:117`、`share/ci/ciInstanceKlass.hpp:127`

实现者信息也很保守。`_implementor` 的三态编码——`NULL`、唯一实现者、`this` 代表“多个实现者”——本质上也是一份“只在能安全保守回答时才缓存”的结果。`share/ci/ciInstanceKlass.hpp:70`、`share/ci/ciInstanceKlass.hpp:71`、`share/ci/ciInstanceKlass.hpp:74`、`share/ci/ciInstanceKlass.hpp:165`

到这里可以先记一个结论：`ciInstanceKlass` 不是“把 `InstanceKlass` 缩写一下”，而是在给编译器造一个问答成本更低、寿命更合适的类视图。

## `ciMethod`：把编译最常用的判定成本，提前摊平到构造期

`ciMethod` 的味道和 `ciInstanceKlass` 很像，但它服务的是另一类高频问题：方法大小、参数规模、异常表长度、监视器使用、能不能编、能不能静态绑定、profile 计数快照。

构造函数一开头就把这些“容易算、而且后面会反复用”的字段全抄进来：`_max_stack`、`_max_locals`、`_code_size`、`_intrinsic_id`、`_handler_count`、`_size_of_parameters`、`_uses_monitors`、`_balanced_monitors`、`_is_c1_compilable`、`_is_c2_compilable`、`_has_reserved_stack_access`。`share/ci/ciMethod.cpp:76`、`share/ci/ciMethod.cpp:80`、`share/ci/ciMethod.cpp:82`、`share/ci/ciMethod.cpp:83`、`share/ci/ciMethod.cpp:84`、`share/ci/ciMethod.cpp:88`、`share/ci/ciMethod.cpp:89`、`share/ci/ciMethod.cpp:91`

与此同时，`_code`、`_exception_handlers`、`_liveness`、`_method_blocks` 这些需要额外分配、也未必总会用到的大块内容则先留空。也就是同样的节奏：先快照热路径最常问的标量，把真正重的东西延后到首次使用。`share/ci/ciMethod.cpp:92`、`share/ci/ciMethod.cpp:93`、`share/ci/ciMethod.cpp:94`、`share/ci/ciMethod.cpp:95`、`share/ci/ciMethod.cpp:96`

这里还有两处很能说明 `ciMethod` 不是“傻拷贝”。

第一处是 hotswap 检查。只要当前 JVMTI 状态允许热替换或断点，构造时就会在 `Compile_lock` 下跑 `Dependencies::check_evol_method`。只要这个方法已经演化过，`_is_c1_compilable`、`_is_c2_compilable` 和 `_can_be_parsed` 会被一起打成 false。也就是说，镜像层在构造时就已经开始替编译器把“这个方法还有没有资格编”这类运行期风险吸收进来了。`share/ci/ciMethod.cpp:102`、`share/ci/ciMethod.cpp:105`、`share/ci/ciMethod.cpp:106`、`share/ci/ciMethod.cpp:107`、`share/ci/ciMethod.cpp:109`

第二处是计数快照。解释器调用次数和 throwout 次数会在构造时抄一份，源码注释明确说这是为了让这些值和 `MethodData` 的快照保持可比。编译期间计数继续增长没关系，本次编译决策看的就是这一刻的快照。`share/ci/ciMethod.cpp:136`、`share/ci/ciMethod.cpp:137`、`share/ci/ciMethod.cpp:138`、`share/ci/ciMethod.cpp:139`、`share/ci/ciMethod.cpp:147`

这恰恰是“编译期视图”的典型味道：它不承诺永久真，只承诺对本次编译足够一致。

## `ciField`：让“字段偏移、常量性、能不能链接”从运行时问题变成编译期问题

字段镜像是另一个很好的例子。编译器看字段时最想知道的无非三件事：偏移是多少、字段类型是什么、这个字段值能不能当常量折叠、这次访问将来会不会链接出错。

`ciField::initialize_from` 一开始就把 access flags、offset 和 canonical holder 抄出来。对编译器来说，`_offset` 几乎就是最值钱的信息之一，因为后面大量 field load/store 优化都围着它转。`share/ci/ciField.cpp:246`、`share/ci/ciField.cpp:248`、`share/ci/ciField.cpp:249`、`share/ci/ciField.cpp:252`

更有意思的是常量性判断。`ciField` 并没有粗暴地把 “`final` 就是常量” 当规则，而是塞进了一整套细化判断：

- `System.in/out/err` 这种虽然 `static final` 但语义上会变的字段，不信；
- `java/lang/invoke`、`sun/invoke`、匿名类、装箱类、`String`、部分 `Atomic*FieldUpdater` 的非静态 final 字段，可以信；
- `CallSite.target` 即便不是普通 final 语义，也被特殊当作可编译期常量。`share/ci/ciField.cpp:216`、`share/ci/ciField.cpp:219`、`share/ci/ciField.cpp:223`、`share/ci/ciField.cpp:227`、`share/ci/ciField.cpp:230`、`share/ci/ciField.cpp:233`、`share/ci/ciField.cpp:257`、`share/ci/ciField.cpp:261`、`share/ci/ciField.cpp:266`、`share/ci/ciField.cpp:281`、`share/ci/ciField.cpp:283`

这说明 `ciField` 并不是只负责搬字段信息，它还承担了一层“把 VM 里分散的编译信任策略收成一个编译器可问答对象”的任务。

真正取常量值时也不是随便读。静态字段要先确认 holder 已初始化，然后去 holder 的 `java_mirror` 上读；非静态 final 则从具体对象实例里读。`ci` 层把“从哪里取字段真值”的运行时细节吸收掉，给编译器暴露的是统一的 `constant_value` / `constant_value_of`。`share/ci/ciField.cpp:297`、`share/ci/ciField.cpp:299`、`share/ci/ciField.cpp:302`、`share/ci/ciField.cpp:305`、`share/ci/ciField.cpp:317`、`share/ci/ciField.cpp:320`

还有一个很关键但容易被忽略的点是 `will_link()`。它会在编译期先判断：这个字段访问如果真的按当前字节码去执行，是否会触发静态/实例不匹配、访问权限错误、或者字段本身当初就没能解析出来。也就是说，编译器不是等生成代码后再把潜在链接错误留给运行时，而是尽量在 `ciField` 阶段就知道“这条路走不通”。`share/ci/ciField.cpp:357`、`share/ci/ciField.cpp:361`、`share/ci/ciField.cpp:368`、`share/ci/ciField.cpp:376`

这又一次证明了 `ci` 层不是单纯的缓存，而是 **把编译最爱问、而且值得稳定下来的 VM 事实提前整理出来。**

## 视图终究会过期，所以还需要 Dependencies 兜底

到这里还有最后一个必须回答的问题：既然 `ci` 层是快照，那快照会不会在编译过程中变旧？

当然会。并发类加载会改变类层级，hotswap 会让方法失去可编译资格，`CallSite` 目标值会变化，JVMTI 和 DTrace 状态也可能改变编译的前提。

`ci` 层没有试图用“实时同步一切镜像”去对抗这件事，那样成本太高。它选的是另一种分工：**镜像负责给编译器一份稳定视图，Dependencies 负责在代码真正落地前检查这份视图赖以成立的假设是不是还在。**

`ciEnv` 里直接挂着一个 `Dependencies* _dependencies`，编译结果注册时会先把依赖编码，再调用 `validate_compile_task_dependencies` 检查编译期间有没有发生并发类加载、方法演化、断点、调用点失效等变化。只要依赖被打破，就记录失败、放弃这次编译。`share/ci/ciEnv.hpp:313`、`share/ci/ciEnv.cpp:926`、`share/ci/ciEnv.cpp:928`、`share/ci/ciEnv.cpp:933`、`share/ci/ciEnv.cpp:935`、`share/ci/ciEnv.cpp:938`、`share/ci/ciEnv.cpp:1004`、`share/ci/ciEnv.cpp:1008`

这条链路特别重要，因为它解释了 `ci` 镜像为什么不需要也不应该追求“永远跟 VM 完全同步”。编译器真正需要的不是一份永不变旧的世界模型，而是一份 **本次编译足够稳定的世界模型 + 在安装代码前验证这份模型没过期的保险丝**。

这两件事，一件由 `ci` 做，一件由 Dependencies 做，分工非常清楚。

## 收网：`ci` 层解决的不是“怎么访问 VM 对象”，而是“怎么得到一份编译期稳定视图”

现在可以把整篇收成一张总图了。

编译器当然需要知道 VM 里的类、方法、字段和对象长什么样，但它不能直接把 VM 活对象当自己的长期工作内存：oop 会被 GC 搬动，VM 对象太重，类层级与方法语义还会在编译期间变化。于是 HotSpot 在 `ciEnv` 里为每次编译准备一份独立的镜像工厂；工厂保证本次编译里一份 VM 实体最多对应一份 `ci` 镜像；对会移动的 oop，用 JNI handle 隔离 GC；对不移动的 Metadata，用直接指针保留低成本访问；对编译高频要问的标量，构造时快照；对大块但不一定用到的结构，首次访问再懒展开；对不值得本地维护的关系计算，再回 VM 现算；最后再用 Dependencies 把这份快照的保质期看住。`share/ci/ciEnv.cpp:130`、`share/ci/ciObjectFactory.hpp:35`、`share/ci/ciObject.cpp:53`、`share/ci/ciObjectFactory.cpp:292`、`share/ci/ciKlass.cpp:68`、`share/ci/ciMethod.cpp:80`、`share/ci/ciField.cpp:249`、`share/ci/ciEnv.cpp:930`

所以，本篇最核心的一句话不是“`ciObject` 是编译器看到的 Java 对象”，而是：

**`ci` 层把 VM 的活对象降成了编译器可持有、可重复查询、可跨 GC、并且只对本次编译负责的只读视图。**

只要这个结论抓住了，下一篇 `ciTypeFlow` 就好理解了：镜像层回答的是“编译器能看到哪些对象与元数据”，而类型流回答的是“编译器如何沿着字节码一步步推导每个位置上可能出现的类型”。

> → [12-ci/02 — `ciTypeFlow + bcEscapeAnalyzer` — 类型流与逃逸分析](02-ci-typeflow-escape.md)
