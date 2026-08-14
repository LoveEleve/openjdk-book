# 01. JIT 怎么看到 Java 类？— ciObject 镜像体系

> **前置依赖**:[11-cds/02 — mmap 之后共享类怎么进 SystemDictionary？— mmap archive → shared spaces → 类就绪](openjdk/vol-02/11-cds/02-cds-load-shared.md):归档类恢复成"活的"InstanceKlass,本篇看 JIT 怎么消费它;[06-oops/02 — Klass — 对象到类的桥](openjdk/vol-02/06-oops/02-klass-hierarchy.md):被镜像的 VM 侧对象;[08-interpreter/03 — 解释器怎么安全地调 C++？— InterpreterRuntime](openjdk/vol-02/08-interpreter/03-interpreter-runtime.md):计数器与编译触发阈值——编译队列从哪来;[16-code-cache/02 — nmethod 结构](openjdk/vol-02/16-code-cache/02-nmethod-structure.md):编译产物,ci 镜像的消费终点;[07-classfile-classloader/04 — SystemDictionary — 类的"全球电话号码本"](openjdk/vol-02/07-classfile-classloader/04-system-dictionary.md):并发类加载是编译依赖要防的变化
> → **后续**:[12-ci/02 — ciTypeFlow + bcEscapeAnalyzer — 类型流与逃逸分析](02-ci-typeflow-escape.md):编译器看到的类型从哪来——字节码类型流是内联与 devirtualize 的输入
> 关联域: 25-gc(编译与 GC 并行)、22-deopt(依赖失效→nmethod 作废)、17-threads(编译线程进出 VM)

## 编译器必须读元数据,但不能直接读

C2 编译 `CiDemo::work` 时,它需要知道: `String.length()` 的字节码有多大、`value` 字段在哪个偏移、`Square.area()` 是不是虚调用、有没有唯一实现者。这些信息都在 InstanceKlass/Method/fieldDescriptor 里——为什么编译器不直接读?

[实证:](planning/outlines/00-jvm-tools/materials/commands/12-ci-inlining-demo.txt) `-XX:+PrintInlining` 展示了编译器真的拿到了这些信息: `java.lang.String::length (11 bytes)` 被内联,它的 `coder`、`isLatin1` 也被内联;接口调用 `ShapeHolder.shape()` → `Square.area()` 被内联,决策依据是 `\-> TypeProfile (87426/87426 counts) = CiDemo$Square`——调用点剖面显示 100% 是 Square,于是编译器把它当具体类型处理。这些"读元数据 + 做决策"的动作,都发生在一个叫 **ci(compiler interface)** 的镜像层上。为什么要有这层?三个理由:

1. **VM 侧对象太重**。`InstanceKlass` 是 C++ 类,内部是给 VM 用的: 锁、状态机(`_init_state`)、`ClassLoaderData` 关联、各种断言与检查。编译器热路径上的查询(这是接口吗?字段在哪个偏移?方法多大?)不该背着这些;
2. **oop 会移动**。编译线程与 GC 是并发的: 编译在编译器线程上跑,GC 到 safepoint 时编译线程只是**阻塞**,编译状态要跨过 GC 存活。直接存 oop 指针,GC 一搬就悬空;
3. **世界会变**。类可以被重定义(RedefineClasses)、类层次会被并发类加载改变。编译基于的假设(唯一实现者、final 不改、类不被替换)必须在事后可验证——否则编出来的代码可能是错的。

解法就是镜像 + 依赖: **ciObject 快照**元数据,编译全程只碰快照;**Dependencies 登记**假设,假设失效就作废产物。这一篇拆镜像层本身。

## 1. ciObject: 双通道的"编译器对象"

ci 层把 VM 的 oop 与 Klass 两条层级(oopHierarchy 与 Klass 体系)合并成一条: 从 `ciBaseObject` 分出 `ciObject`(镜像 oop)与 `ciMetadata`(镜像 Klass/Method 等元数据)。看 `ciObject` 的类注释:

```cpp
// ciObject.hpp:33-44(截取核心,逐字)
// ciObject
//
// This class represents an oop in the HotSpot virtual machine.
// Its subclasses are structured in a hierarchy which mirrors
// an aggregate of the VM's oop and klass hierarchies (see
// oopHierarchy.hpp).  Each instance of ciObject holds a handle
// to a corresponding oop on the VM side and provides routines
// for accessing the information in its oop.  By using the ciObject
// hierarchy for accessing oops in the VM, the compiler ensures
// that it is safe with respect to garbage collection; that is,
// GC and compilation can proceed independently without
// interference.
```

"GC and compilation can proceed independently"——这句话是 ci 层的地基,实现靠**双通道引用**(ciObject.hpp:55-59):

- **oop(堆对象,会移动)→ JNI handle**: `ciObject::ciObject(oop o)` 里 `_handle = JNIHandles::make_local(o)`(ciObject.cpp:53-59)。JNI 句柄被 GC 跟踪,GC 搬对象时句柄跟着更新——编译线程恢复执行后,`get_oop()` 读到的是新地址;
- **Metadata(Metaspace 对象,不移动)→ 直接指针**: ciKlass/ciMethod 的 `_metadata`(ciBaseObject)直接指向 Metaspace 里的 InstanceKlass/Method。Metaspace 不参与堆 GC 的搬移(10 域),所以裸指针安全,查询不用绕句柄。

**关键设计 (斜体)**: *ciObject 本身不是 oop——它活在编译专属的 Arena 里(ciEnv 的 `_ciEnv_arena`,C 堆上、mtCompiler 内存类型,不是资源区),GC 不扫描它、也不管它的生命期;它的生命期随 `ciEnv`(一次编译的上下文)走,编译结束随 Arena 一起释放(well-known 类/符号的共享镜像例外,活在启动期就建好的长命 Arena 里,见第 2 节)。VM 侧的 oop 用句柄引用、Metadata 用裸指针引用——"移动的"绕一层,"不动的"直接用——这就是"编译与 GC 互不干扰"的全部秘密。*

还有个关键语义: **ci 对象可以"未加载"**。`is_loaded()` 的定义是 `handle() != NULL || is_classless()`(ciObject.hpp:138-140)——类还没解析、方法还没找到时,ci 层照样构造镜像(`get_unloaded_klass`/`get_unloaded_method`,ciObjectFactory.hpp:110-118),只是字段残缺。编译器必须能处理"这个类不存在"的情况: 编译期就发现链接错误,总比编出必崩的代码强(ciField::will_link 就是干这个的,第 5 节)。

## 2. ciObjectFactory: 一次编译一工厂,一份对象一份镜像

镜像从哪来?`ciObjectFactory`。它保证**同一个 oop/Metadata 在一次编译内至多对应一个 ciObject**(ciObjectFactory.hpp:35-37)——这个不变量让编译器可以放心用 `==` 比较 ci 对象。工厂在每次编译时新建(ciEnv 构造里 `_factory = new (_arena) ciObjectFactory(_arena, 128)`,ciEnv.cpp:131),持有两个缓存:

- `_ci_metadata`: **按指针排序的 GrowableArray**(ciObjectFactory.hpp:49)——Metadata 在 Metaspace 不移动,地址是稳定排序键,`find_sorted` 二分查找。查 Klass/Method 走它;
- `_non_perm_bucket[61]`:**oop 哈希桶**(:67-68)——oop 在堆里会移动,不能当排序键,用 61 个桶的哈希。

查 Metadata 的路径(ciObjectFactory.cpp:305-334): 二分 `find_sorted` → 命中返回已有镜像;未命中 `create_new_metadata`(按 oop 类型分派: InstanceKlass→ciInstanceKlass、Method→ciMethod 等,ciObjectFactory.cpp:379-407)→ 按序插回数组。查 oop 的路径(:238-259)同样: `find_non_perm` 查桶 → 没有就 `create_new_object` + `insert_non_perm`。

```cpp
// ciObjectFactory.cpp:305-334(截取核心,逐字)
  int len = _ci_metadata->length();
  bool found = false;
  int index = _ci_metadata->find_sorted<Metadata*, ciObjectFactory::metadata_compare>(key, found);

  if (!found) {
    // The ciMetadata does not yet exist. Create it and insert it
    // into the cache.
    ciMetadata* new_object = create_new_metadata(key);
    init_ident_of(new_object);
    assert(new_object->is_metadata(), "must be");

    if (len != _ci_metadata->length()) {
      // creating the new object has recursively entered new objects
      // into the table.  We need to recompute our index.
      index = _ci_metadata->find_sorted<Metadata*, ciObjectFactory::metadata_compare>(key, found);
    }
    assert(!found, "no double insert");
    _ci_metadata->insert_before(index, new_object);
    return new_object;
  }
  return _ci_metadata->at(index)->as_metadata();
```

**但有全局共享的一份**。`ciObjectFactory::initialize()` 只在 VM 启动时跑一次(ciObjectFactory.cpp:106): 用一个长命 Arena 建出**所有编译共享的镜像**——全部 vmSymbols 的 ciSymbol(`_shared_ci_symbols[]`,:130-136)、基本类型 ciType、ciNullObject、以及**全部 well-known 类的 ciInstanceKlass**(`WK_KLASSES_DO` 宏逐类 `get_metadata(SystemDictionary::name())`,:160-165,挂在 `ciEnv::_Object`/`_String` 这类静态成员上)。`_shared_ident_limit`(:204)把 ci 对象的 ident 编号切成两段: 小于它是全局共享的永久编号,大于它每次编译重新分配。

**关键设计 (斜体)**: *"工厂 per 编译"与"well-known 全局共享"的分界线是价值权衡: 每次编译都新建 java/lang/Object 的镜像毫无必要(它永远在、永远同一份)→ 全局共享省掉反复快照;而普通类每次编译新建,是因为它们的快照(字段表、方法表、子类关系)可能被类加载/重定义改变,不能跨编译缓存。大纲说"同一个 Klass 多次编译返回同一个 ciKlass"——只对 well-known 类成立。*

符号也分两档: `get_symbol`(ciObjectFactory.cpp:209)——vmSymbols 里有编号(SID)的符号直接返回共享 ciSymbol,不进主缓存;非 SID 的符号新建并记入 `_symbols`,编译结束时 `remove_symbols`(:223-229)对它们 `decrement_refcount` 归还。

## 3. ciInstanceKlass: 快照 + 懒字段

`ciInstanceKlass` 是 InstanceKlass 的镜像。构造时从 Klass 一次性提取的**标量**(ciInstanceKlass.hpp:50-61):

```cpp
// ciInstanceKlass.hpp:46-61(截取核心,逐字)
  InstanceKlass::ClassState _init_state;           // state of class
  bool                   _is_shared;
  bool                   _has_finalizer;
  bool                   _has_subklass;
  bool                   _has_nonstatic_fields;
  bool                   _has_nonstatic_concrete_methods;
  bool                   _is_anonymous;

  ciFlags                _flags;
  jint                   _nonstatic_field_size;
  jint                   _nonstatic_oop_map_size;
```

[C++:] 注意 `_flags` 不是一堆 bool,而是 **ciFlags——打包的 access_flags 位图**。于是 `is_interface()` 只是 `flags().is_interface()`(ciInstanceKlass.hpp:231 → ciFlags.hpp:59 一次按位与),`is_final`/`is_abstract`/`is_public` 同理。严格说 `ciKlass::is_interface` 在基类里仍是 **virtual**(ciKlass.hpp:97)——编译器把镜像当具体 `ciInstanceKlass` 用时是内联位测试,只有当静态类型退化成基类 `ciKlass*` 才付出虚分派。这是镜像层的核心收益: VM 侧的同类查询(要经过 accessFlags 对象与各种断言)在这里被降级成一次快照后的位读。

**懒字段是另一半**: `_super`、`_java_mirror`、`_field_cache`、`_nonstatic_fields`(ciInstanceKlass.hpp:63-68)都是 NULL 起步、首次访问才计算(`compute_nonstatic_fields` :105,递归父类合并非静态字段表)——因为字段表可能很大,编译没用到就不该建。快照 + 按需展开,是"镜像层"对"拷贝层"的取舍: 拷全了省心但贵,拷常用标量 + 懒展开大头。

**共享类(CDS)有专门处理**: `update_if_shared`(ciInstanceKlass.hpp:109-113)——归档类的 `_init_state` 是 dump 时的旧值,**快照值与查询目标不一致时**现算(`is_initialized()` 查 fully_initialized、`is_linked()` 查 linked 都会触发 `compute_shared_init_state()`,11-cds 域: 归档类的状态要在 load 端重新推演)。`implementor()`(ciInstanceKlass.cpp:599)对共享接口干脆**假设没有唯一实现者**(:602-604,`is_shared()` 时 `impl = this` 返回"多个")——因为 CDS 没保证把所有子类都归档,保守才不会编错。

**类层次查询其实转发回 VM**: `ciKlass::is_subtype_of(ciKlass* that)`(ciKlass.cpp:68)不是自己遍历继承链,而是 `VM_ENTRY_MARK` 进 VM 后调 `this_klass->is_subtype_of(that_klass)`(:80)——VM 侧的实现本身是 O(1) 的(super_check_offset 指针比较,06 域),不值得在 ci 层重造。镜像层只在"每次都要查、且能快照"的地方做缓存。

**"唯一实现者"的真相**: 大纲说的 "unique_concrete_method / DFA / _implementors 列表" 都不存在。真实是两个东西: ① `implementor()`(接口的唯一实现类,三态指针 `_implementor`: NULL=无、某个 ciInstanceKlass=一个、自身=多个,ciInstanceKlass.hpp:70-74,`nof_implementors()` :165 据此返回 0/1/2);② `unique_concrete_subklass()`(ciInstanceKlass.cpp:370)——抽象类的唯一具体子类,实现是 `ik->up_cast_abstract()`(:376,Klass 侧算法)。两者都是**懒计算 + 备忘**——首次访问进 VM 算,结果缓存。它们支撑的优化是 devirtualize: 调用点只可能命中一个实现时,虚调用降级为直接调用。

## 4. ciMethod: 一次提取,按需展开

`ciMethod` 是 Method 的镜像。构造(ciMethod.cpp:67-155)把"编译需要、且容易算"的东西全部抄进标量:

```cpp
// ciMethod.cpp:76-96(截取核心,逐字)
  // These fields are always filled in in loaded methods.
  _flags = ciFlags(h_m()->access_flags());

  // Easy to compute, so fill them in now.
  _max_stack          = h_m()->max_stack();
  _max_locals         = h_m()->max_locals();
  _code_size          = h_m()->code_size();
  _intrinsic_id       = h_m()->intrinsic_id();
  _handler_count      = h_m()->exception_table_length();
  _size_of_parameters = h_m()->size_of_parameters();
  _uses_monitors      = h_m()->access_flags().has_monitor_bytecodes();
  _balanced_monitors  = !_uses_monitors || h_m()->access_flags().is_monitor_matching();
  _is_c1_compilable   = !h_m()->is_not_c1_compilable();
  _is_c2_compilable   = !h_m()->is_not_c2_compilable();
  _can_be_parsed      = true;
  _has_reserved_stack_access = h_m()->has_reserved_stack_access();
  // Lazy fields, filled in on demand.  Require allocation.
  _code               = NULL;
  _exception_handlers = NULL;
  _liveness           = NULL;
  _method_blocks = NULL;
```

值得注意的几点: `is_c1_compilable`/`is_c2_compilable` 不是"检查方法大小/MDO 是否充足"(大纲的说法),而是 **Method access_flags 里的两个位**(`is_not_c1_compilable`,method.hpp:949)——VM 侧(如 CompileBroker 失败、redefine 后)把"别再编它"记在方法自己的标志里,ciMethod 构造时抄过来。真正的大小信息是 `_code_size`(构造时已抄),内联/编译规模决策(MaxInlineSize 等,03 域)直接用这份快照。构造时还会做一次 **hotswap 检查**(ciMethod.cpp:102-110): JVMTI 可热替换时,`Dependencies::check_evol_method` 命中就立刻把两个 compilable 置 false——**被重定义过的方法不编译**。

懒的部分: `_method_blocks`(基本块,02 篇的 ciTypeFlow 用)、`_method_data`(MDO 剖面,`ensure_method_data` ciMethod.cpp:961 按需创建)、`_exception_handlers`、`_code`。`_instructions_size` 初值 -1(ciMethod.cpp:149,首次调用才计算)。还有一份**计数快照**(:138-148): 解释器调用计数在构造时抄进 ciMethod——注释说得很直白: "Take a snapshot of these values, so they will be commensurate with the MDO"(:137),编译期间的计数变化不影响本次编译的决策。

## 5. ciField: 偏移、类型与"常量"的判定

`ciField` 是字段的镜像,构造时从 `fieldDescriptor` 提取(ciField.cpp:246-248): `_offset = fd->offset()`——C2 编译 `String.length()` 需要的 `value` 字段偏移就是这里来的,之后全部内联读,零 VM 访问。但字段镜像最有意思的是 **is_constant 判定**(ciField.cpp:257-291)——"这个字段能不能当编译期常量用":

- **static final(或 @Stable,`FoldStableValues` 开启时,:257-258)**: 是常量——除非它是 `System.in/out/err`(这三个"final"其实会被 System.setIn/Out/Err 改掉,:261-270 按偏移精确排除);
- **非 static final**: 只有持有者"可信"才当常量——`trust_final_non_static_fields`(ciField.cpp:216)的信任名单: `java.lang.invoke`/`sun.invoke` 包(方法句柄是 VM 自己造的)、匿名类(Unsafe 私有 API)、**所有装箱类**、**String**、`Atomic*FieldUpdater` 的实现类,或 `TrustFinalNonStaticFields` 标志;否则不信任(反射/Unsafe 可能改写 final);
- **CallSite.target** 特例: 即使非 final 也当常量(:281-286,方法句柄调用点缓存)。

`constant_value()`(ciField.cpp:297)真正读值: 静态字段的值在 **java_mirror** 里(VM 侧布局),进 VM 读一次后缓存进 `_constant_value`(T_ILLEGAL 是"未读"哨兵);非静态 final 用 `constant_value_of`(:317)从实例对象读。

**will_link**(ciField.cpp:361)是"编译期链接预检": 字段查不到(offset=-1,构造时已标记)、访问权限不够(NoSuchFieldError/IllegalAccessError)时在编译期就发现,而不是让编译产出一段必抛异常的代码——大纲这个机制是对的。

## 6. 依赖: 快照凭什么安全

快照解决"读得干净",但还差最后一块: 快照会过期。编译基于 `Square` 是唯一实现者、`String` 的布局、某类没被重定义这些假设——假设失效时,已产出的 nmethod 必须被撤销(not entrant → deopt,22 域)。这就是 **Dependencies**: `ciEnv` 持有一个 `Dependencies* _dependencies`(ciEnv.hpp:57/313),编译过程中编译器把每个"决定性的假设"登记进去;nmethod 安装时与后续的类加载/重定义对照校验(`validate_compile_task_dependencies`,ciEnv.cpp:933)——违反则编译产物作废。

[实证:](planning/outlines/00-jvm-tools/materials/commands/12-ci-inlining-demo.txt) PrintCompilation 里反复出现的 `made not entrant` 是这条链的常见形态: tier3 的 `CiDemo::work` 被 tier4 版本替换(:32/39/40 行的三个 made not entrant);替换不是"删代码",而是把旧 nmethod 标记为不可再进入,正在执行的栈帧继续跑完,新的调用走新版本(依赖失效是它的另一种触发: 假设被违反时 nmethod 同样被作废,22 域)。

## 核心悬念

镜像层拆完了: 编译器不直接读 InstanceKlass/Method/Field——原因(VM 对象太重、oop 会移动、世界会变)→ 双通道引用(oop 走句柄、Metaspace 走裸指针,GC 与编译互不干扰)→ 工厂保证同一次编译内镜像唯一(well-known 类与符号全局共享)→ 快照 + 懒字段(is_interface 是位测试,字段表按需展开)→ 常量判定(static final 排除 System.in/out/err,非 static final 要可信持有者)→ 依赖登记让快照过期时产物作废。一句话: **ci 层是"编译器的只读视图"——把 VM 的活对象降级成一份快照,把快照的保质期交给依赖体系。**

但镜像只是"数据从哪来";编译器真正要的是"**每个字节码位置的类型是什么**"——`@ 29 CiDemo$Square::area` 那行内联,前提是编译器知道调用点接收者类型。类型从哪来?两条路: profile(解释器/低 tier 收集的 TypeProfile)与字节码静态推导。下一篇: ciTypeFlow。

> → [12-ci/02 — ciTypeFlow + bcEscapeAnalyzer — 类型流与逃逸分析](02-ci-typeflow-escape.md)
