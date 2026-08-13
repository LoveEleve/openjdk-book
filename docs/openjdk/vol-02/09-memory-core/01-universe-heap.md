# 01. Universe + CollectedHeap — JVM 的"宇宙大爆炸"

> **前置依赖**:[07-classfile-classloader/07 — javaClasses](openjdk/vol-02/07-classfile-classloader/07-javaclasses-core-mirrors.md):基本类型镜像与 mirror 补丁在 genesis 阶段创建,偏移在 well-known 类加载时计算;[07-classfile-classloader/04 — SystemDictionary](openjdk/vol-02/07-classfile-classloader/04-system-dictionary.md):resolve_well_known_classes 在这里被调;[06-oops/02 — Klass 层次](openjdk/vol-02/06-oops/02-klass-hierarchy.md)与 [06-oops/03 — InstanceKlass/ArrayKlass](openjdk/vol-02/06-oops/03-instanceklass-arrayklass.md):这次预创建的 TypeArrayKlass/镜像都来自这两个家族
> → **后续**:[09-memory-core/02 — VirtualSpace](02-virtualspace.md)(heap 的虚拟内存怎么管理)
> 关联域: 06-oops(对象模型)、07-classfile-classloader(类加载)、25-gc(GC 堆实现)、10-metaspace(元数据空间)、16-code-cache(CodeHeap)

## 堆是谁创建的?在第一个对象之前

`new Object()` 分配在哪?GC 堆。但堆本身是谁、在什么时候创建的?答案是启动早期的两个函数: `universe_init` 建堆,`Universe::genesis`("创世纪")在堆上造出第一批对象。而且顺序反直觉: 堆诞生时 Java 类一个都还没加载,最早就位的却是**基本类型数组的 Klass**、**基本类型的 Class 镜像**(int.class 这类)、**内部空数组**——因为 JVM 的引导逻辑自己就需要它们。这一篇走完大爆炸全程: 堆怎么被选出来、第一批对象是什么、以及那个被全 VM 调用的 `Universe::heap()` 背后是什么。

## 1. 先有堆: universe_init 与 GC 的选择

### 启动时序: 堆在最前面

`init_globals`(init.cpp:101-140)是 JVM 的全局初始化主干,堆相关的一串在中间(截取核心,逐字):

```cpp
// init.cpp:111-125(截取核心,逐字)
  jint status = universe_init();  // dependent on codeCache_init and
                                  // stubRoutines_init1 and metaspace_init.
  if (status != JNI_OK)
    return status;

  gc_barrier_stubs_init();   // depends on universe_init, must be before interpreter_init
  interpreter_init();        // before any methods loaded
  invocationCounter_init();  // before any methods loaded
  accessFlags_init();
  templateTable_init();
  InterfaceSupport_init();
  VMRegImpl::set_regName();  // need this before generate_stubs (for printing oop maps).
  SharedRuntime::generate_stubs();
  universe2_init();  // dependent on codeCache_init and stubRoutines_init1
  javaClasses_init();// must happen after vtable initialization, before referenceProcessor_init
```

- `universe_init`(:111): 创建并初始化 GC 堆;
- `universe2_init`(:124): 内部调 `Universe::genesis`——在堆上造第一批对象;
- `javaClasses_init`(:125): 算 07-07 讲过的 29 个镜像偏移。

注意 `interpreter_init`(:117)夹在堆创建与 genesis 之间——它生成模板解释器的机器码,必须在任何 Java 方法运行前完成;而真正的大爆炸 `universe2_init`(:124)反而在它之后。

### universe_init 里发生了什么

`universe_init`(universe.cpp:675-750)的核心是 `initialize_heap`(:687)。堆创建分两步走(截取核心,逐字):

```cpp
// universe.cpp:752-771(截取核心,逐字)
CollectedHeap* Universe::create_heap() {
  assert(_collectedHeap == NULL, "Heap already created");
  return GCConfig::arguments()->create_heap();
}

jint Universe::initialize_heap() {
  _collectedHeap = create_heap();
  jint status = _collectedHeap->initialize();
  if (status != JNI_OK) {
    return status;
  }
  log_info(gc)("Using %s", _collectedHeap->name());
```

- **`create_heap`(:752-755)只 new 出 CollectedHeap 的 C++ 对象**,选择权在 GCConfig: `GCConfig::arguments()->create_heap()`(gcConfig.cpp:237;`create_heap` 是 GCArguments 的纯虚函数,gcArguments.hpp:41)。典型配置(server-class 机器)走 G1: `G1Arguments::create_heap`(g1Arguments.cpp:151-153)= `create_heap_with_policy<G1CollectedHeap, G1CollectorPolicy>()`——`new G1CollectedHeap` + 配一个策略对象;
- **GC 怎么被选中**: `GCConfig::select_gc`(gcConfig.cpp:146-183)——`-XX:+UseG1GC/UseSerialGC/...` 显式指定优先;一个都没给时 `select_gc_ergonomically`(:102-114)按机器挑: **server-class 机器(至少 2 个处理器、内存 ≥2GB-256MB 余量,多核包机器还需 ≥2 个物理包,os.cpp:1709-1741)默认 UseG1GC,否则 UseSerialGC**;
- **`_collectedHeap->initialize()`(:767)才做重活**: G1 的 `initialize`(g1CollectedHeap.cpp:1533 起)检查对齐后 `Reserve the maximum`——**这里才真正 reserve 虚拟地址空间**。new 只是搭了个 C++ 空壳,虚拟内存是 initialize 阶段的事(02 篇的 VirtualSpace 就是在管这块区域)。

之后 `universe_init` 建符号表(:734-735 `SymbolTable::create_table()`/`StringTable::create_table()`)、预置 6 个方法缓存(LatestMethodCache,:715-720——VM 内部高频调用的 Java 方法指针缓存,如 `Unsafe.throwIllegalAccessError`),堆就绪。

**关键设计 (斜体)**: *"C++ 对象创建"与"虚拟内存到位"分两步: create_heap 只做多态选择与构造,initialize 做资源申请。这样 GC 切换(-XX:+UseSerialGC)只影响第一步,堆初始化的大部分逻辑(检查/对齐/基址选择)在第二部统一走。*

## 2. 大爆炸: genesis 在堆上造出第一批对象

### 入口与总流程

`universe2_init`(universe.cpp:992-995)一行调用 `Universe::genesis`(:321-462)。genesis 全程在一个 `_bootstrapping` 标志保护下(:324,FlagSetting 结构块,出块自动恢复)——引导期很多检查会绕开。总流程(截取核心,逐字):

```cpp
// universe.cpp:322-341(截取核心,逐字)
  ResourceMark rm;

  { FlagSetting fs(_bootstrapping, true);

    { MutexLocker mc(Compile_lock);

      java_lang_Class::allocate_fixup_lists();

      // determine base vtable size; without that we cannot create the array klasses
      compute_base_vtable_size();

      if (!UseSharedSpaces) {
        _boolArrayKlassObj      = TypeArrayKlass::create_klass(T_BOOLEAN, sizeof(jboolean), CHECK);
        _charArrayKlassObj      = TypeArrayKlass::create_klass(T_CHAR,    sizeof(jchar),    CHECK);
        _singleArrayKlassObj    = TypeArrayKlass::create_klass(T_FLOAT,   sizeof(jfloat),   CHECK);
        _doubleArrayKlassObj    = TypeArrayKlass::create_klass(T_DOUBLE,  sizeof(jdouble),  CHECK);
        _byteArrayKlassObj      = TypeArrayKlass::create_klass(T_BYTE,    sizeof(jbyte),    CHECK);
        _shortArrayKlassObj     = TypeArrayKlass::create_klass(T_SHORT,   sizeof(jshort),   CHECK);
        _intArrayKlassObj       = TypeArrayKlass::create_klass(T_INT,     sizeof(jint),     CHECK);
        _longArrayKlassObj      = TypeArrayKlass::create_klass(T_LONG,    sizeof(jlong),    CHECK);
```

### 第一步是数组 Klass,不是 Object

genesis 的第一个实质动作是 `java_lang_Class::allocate_fixup_lists()`(:328——07-07 的 mirror 补丁列表在这里就绪),然后 `compute_base_vtable_size()`(:331)再 `TypeArrayKlass::create_klass` ×8——**基本类型数组的 Klass 反而先于任何普通类**。注释点破原因: "without that we cannot create the array klasses"。`compute_base_vtable_size`(:1115-1117)= `ClassLoader::compute_Object_vtable()`——先算出 Object 的 vtable 长度,因为数组类的方法表长度继承自 Object(06-02 讲过 vtable 从 Klass 头之后开始、数组不引入新方法);没有这个数字,数组 Klass 连尺寸都定不下来。8 个 Klass 存进 `_typeArrayKlassObjs[T_xxx]` 索引表(:343-350),并各有一个具名访问器(`_boolArrayKlassObj`/`_intArrayKlassObj`…)。注意引导期数组 Klass 的 super 先不挂(Object 还没加载,arrayKlass.cpp:93 在 `is_bootstrapping()` 时置 NULL),vtable 构建也在引导期跳过、由 `reinitialize_vtable_of` 后补(klassVtable.cpp:103-110,universe_post_init 时补)。

### Metaspace 的空数组与"空数组预分配"的真相

接着造四个**内部空数组**(universe.cpp:354-358,截取核心,逐字):

```cpp
// universe.cpp:354-358(截取核心,逐字)
        _the_array_interfaces_array = MetadataFactory::new_array<Klass*>(null_cld, 2, NULL, CHECK);
        _the_empty_int_array        = MetadataFactory::new_array<int>(null_cld, 0, CHECK);
        _the_empty_short_array      = MetadataFactory::new_array<u2>(null_cld, 0, CHECK);
        _the_empty_method_array     = MetadataFactory::new_array<Method*>(null_cld, 0, CHECK);
        _the_empty_klass_array      = MetadataFactory::new_array<Klass*>(null_cld, 0, CHECK);
```

注意: 这些是 **Metaspace 里的 C 数组**(`Array<int>*` 等),**不是堆上的 Java 对象**——流传的"genesis 预分配空数组,`new int[0]` 直接返回"是张冠李戴: `new int[0]` 每次都会走正常分配;堆上的预分配空数组只有一个——`_the_empty_class_klass_array`(Class[0],在 universe_post_init 里用 oopFactory 创建,universe.cpp:1018)——它的用途很具体: 方法没有 checked exceptions 时返回这个空数组的规范对象(method.cpp:733)。`_the_array_interfaces_array` 则是**数组类的接口清单**——所有 Java 数组的 Klass 共享它,稍后填入 Cloneable 与 Serializable(:383-384)。

### SystemDictionary::initialize: 核心类落地

`SystemDictionary::initialize`(systemDictionary.cpp:1907 起)是 genesis 的枢纽: 建字典表、`oopFactory::new_intArray(0)`(:1916)造一个空 int[] 当系统类加载器锁对象(oopFactory 在引导期的重要客户),然后 `resolve_well_known_classes`(:1918)——07-04 那套 well-known 类加载在这里发生: Object/String/Class/System 等被引导加载,同时 07-07 的 String/Class 镜像偏移就地计算。

类加载完立刻造两批镜像(javaClasses 篇的悬念在这里闭合):

- `Universe::initialize_basic_type_mirrors`(universe.cpp:464-509): 为 9 个基本类型(`int`/`float`/`double`/`byte`/`boolean`/`char`/`long`/`short`/`void`)调 `java_lang_Class::create_basic_type_mirror` 造镜像(:478-495)——**int.class 不是加载出来的,是这里用 C++ 造的**;
- `Universe::fixup_mirrors`(:511-534): 消化 07-07 的 `fixup_mirror_list`——注释说得很直白: "Bootstrap problem: all classes gets a mirror eagerly, but we cannot do that for classes created before java.lang.Class is loaded"(:512-515)。Object 等早期类的镜像在 Class 加载前没法造,先挂补丁列表,这里统一补。

之后 genesis 把 8 个基本类型数组 Klass 初始化(`initialize_basic_type_klass` ×8,:387-394;定义 :306-317: super 设为 Object、挂入类层次链表),再建 `_objectArrayKlassObj`(:414-415,`Object[]` 的 Klass,从 `Object_klass()->array_klass(1)` 来),还有两个 intern 字符串 `"null"` 与 `"-2147483648"`(:368-369)——`_the_null_string` 是编译器/运行时处理 "null" 字面量的规范对象(ciEnv 直接复用它,ciEnv.cpp:322-325),`_the_min_jint_string` 是 `Integer.MIN_VALUE` 的字符串(ciEnv.cpp:330)。

**关键设计 (斜体)**: *genesis 的依赖顺序是"自底向上"的: 数组 Klass(依赖 Object 的 vtable 尺寸)→ 核心类(Klass 存在)→ 镜像(依赖 Class 已加载)→ 基本类型数组 Klass 挂层次(依赖 Object 类在)。每一步都只依赖上一步已经就位的东西——而 `_bootstrapping` 标志(注释 "true during genesis",universe.hpp:209)把"半成品"显式化: 数组 Klass 先不挂 super、vtable 先不建,全靠这个标志让引导期的部分初始化合法化,之后再由 reinitialize_vtable_of 补齐。*

## 3. Universe: 全局唯一仓库

`Universe`(universe.hpp:96,`AllStatic`)就是这些全局单例的仓库: 堆指针、8 个数组 Klass、基本类型镜像、预分配异常对象。最常用的几个访问器:

- `Universe::heap()`(universe.hpp:390)= `_collectedHeap`(universe.hpp:189)——全 VM 到处调用的"当前堆";
- `intArrayKlassObj()`(:276)等 8 个——genesis 造的数组 Klass,`oopFactory` 的每个工厂都依赖它们(oopFactory.hpp:44-51: `new_intArray` = `TypeArrayKlass::cast(Universe::intArrayKlassObj())->allocate(length)`);
- `the_array_interfaces_array()`(:327)/`the_empty_int_array()`(:362)——genesis 的空数组;
- `non_oop_word()`(universe.cpp:656-672): 一个"保证不像任何 oop"的哨兵值——`os::non_memory_address_word() | 1`: 低位置 1 让它绝不对齐到 oop 的 4 字节边界,高位用 OS 提供的非内存地址字,高位低位都不像真 oop(注释 :657-666)。最典型的用途是**内联缓存的"空目标"占位**: compiledIC 的 data 槽存 non_oop_word 表示"还没有目标"(compiledIC.cpp:61-63 判定 `data == non_oop_word` 即无目标,:120 清缓存时写入)。

预分配的另一类对象在 `universe_post_init`(universe.cpp:1002 起): 6 个**提前造好的 OutOfMemoryError 实例**(:1020-1029,heap/metaspace/class_metaspace/array_size/gc_overhead_limit/realloc_objects 各一)+ `_delayed_stack_overflow_error_message`(:1032-1034)。设计动机直白: **OOM 发生时往往已经没有空间再分配异常对象了**——`gen_out_of_memory_error`(universe.cpp:615-650)的机制是: 另有一池预分配错误(`_preallocated_out_of_memory_error_array`,:1084,容量 `PreallocatedOutOfMemoryErrorCount`),抛出时优先从池里取一个、把当前错误消息搬过去、填上栈帧返回(:623-641);池用尽就退回 6 个默认 OOME 之一(比如 `out_of_memory_error_java_heap()`,universe.hpp:370)——全程不触发新的异常对象分配。

## 4. CollectedHeap: 所有 GC 堆的公共接口

### 位置与家族

CollectedHeap 在 `share/gc/shared/collectedHeap.hpp:104`——注意不是 `share/memory/heap.hpp`(那是 **CodeHeap**,16 域讲过的代码缓存)。类头注释列了全家族(collectedHeap.hpp:94-102): GenCollectedHeap(Serial/CMS)→ G1CollectedHeap / ParallelScavengeHeap / ShenandoahHeap / ZCollectedHeap。所有 GC 换着插进同一个 `Universe::heap()` 槽位。

### 分配接口: TLAB 与单对象两条路

CollectedHeap 对分配暴露两个接口(截取核心,逐字):

```cpp
// collectedHeap.hpp:140-160(截取核心,逐字)
  // Create a new tlab. All TLAB allocations must go through this.
  // To allow more flexible TLAB allocations min_size specifies
  // the minimum size needed, while requested_size is the requested
  // size based on ergonomics. The actually allocated size will be
  // returned in actual_size.
  virtual HeapWord* allocate_new_tlab(size_t min_size,
                                      size_t requested_size,
                                      size_t* actual_size);

  // Raw memory allocation facilities
  // The obj and array allocate methods are covers for these methods.
  // mem_allocate() should never be
  // called to allocate TLABs, only individual objects.
  virtual HeapWord* mem_allocate(size_t size,
                                 bool* gc_overhead_limit_was_exceeded) = 0;
```

对象分配的真实路径不在 oopFactory,而是 **MemAllocator**(share/gc/shared/memAllocator.cpp,`new` 字节码与反射分配的对象创建路径): `MemAllocator::allocate`(:373-389)是入口,`mem_allocate`(:362-369)按 UseTLAB 分派(截取核心,逐字):

```cpp
// memAllocator.cpp:362-381(截取核心,逐字)
HeapWord* MemAllocator::mem_allocate(Allocation& allocation) const {
  if (UseTLAB) {
    HeapWord* result = allocate_inside_tlab(allocation);
    if (result != NULL) {
      return result;
    }
  }

  return allocate_outside_tlab(allocation);
}

oop MemAllocator::allocate() const {
  oop obj = NULL;
  {
    Allocation allocation(*this, &obj);
    HeapWord* mem = mem_allocate(allocation);
    if (mem != NULL) {
      obj = initialize(mem);
```

- **TLAB 内快路径**: `allocate_inside_tlab`(:284-295)从当前线程的 TLAB 里 `tlab.allocate(_word_size)`——一次指针 bump,不碰 GC;TLAB 剩余不足时 `allocate_inside_tlab_slow`(:297 起)权衡: **剩余空间还很多(超过 `refill_waste_limit`),把整个 TLAB 作废太浪费,于是放弃换新、直接走 TLAB 外分配**(:309-311);剩余少到可以丢弃,才作废旧 TLAB、`_heap->allocate_new_tlab(min, requested, &actual)`(:324)换新的;
- **TLAB 外慢路径**: `allocate_outside_tlab`(:270-281)调 `_heap->mem_allocate(_word_size, &overhead_limit)`——G1 的实现是巨对象直接 `attempt_allocation_humongous`(g1CollectedHeap.cpp:404),普通对象 `attempt_allocation`(:407);
- 分配成功后 `initialize`(:373 处调用)填对象头: mark 复制 Klass 的 `prototype_header`(偏向锁模式),`release_set_klass` 发布 klass 指针(:396-408,`MemAllocator::finish`)——**先 mark 后 klass,release store 让并发 GC 能看到完整对象**。

### 生命周期接口

- `collect(GCCause::Cause)`(collectedHeap.hpp:398,纯虚): 触发 GC——`System.gc()` 的链路终点就是 `Universe::heap()->collect(GCCause::_java_lang_system_gc)`(jvm.cpp:457-460),`_gc_cause` 记录原因(gc_cause() :299),JMX 的 `GarbageCollectorMXBean.getLastGcInfo()` 读它;
- `object_iterate(ObjectClosure*)`(:443,纯虚)/`safe_object_iterate`(:447): 遍历堆上所有对象——jcmd `GC.class_histogram`、JFR 堆事件、JVMTI 堆迭代都走这套接口;
- `total_collections()`(:419): 累计 GC 次数。

## 5. OopClosure 与 ObjectClosure: GC 遍历的回调

遍历的"回调"接口在 `share/memory/iterator.hpp`(不是大纲说的 :30-100,实际): `OopClosure`(:52-56)两个纯虚——`do_oop(oop*)` 与 `do_oop(narrowOop*)`(压缩指针版本),任何要"看引用"的组件实现它;`ObjectClosure`(:161-165)一个 `do_object(oop)`——任何要"看对象"的组件实现它。GC 根集扫描、堆遍历都是"遍历器 + 回调"的组合: 遍历器(栈、静态区、句柄表)把每个引用/对象交给回调,回调做什么(标记、拷贝、统计)由实现者决定。

## 核心悬念

大爆炸的全过程到齐: `universe_init` 选 GC、create_heap + initialize 两步建堆(new 出 C++ 壳,initialize 里才 reserve 虚拟地址)→ `genesis` 在 `_bootstrapping` 下造第一批对象(8 个基本类型数组 Klass 先于一切、Metaspace 空数组、well-known 类与基本类型镜像、`Object[]` Klass)→ `Universe` 仓库与预分配 OOME → `CollectedHeap` 抽象(TLAB 内一次 bump、TLAB 外 mem_allocate/allocate_new_tlab 两条慢路径、collect/object_iterate 生命周期)。但有一个词被反复带过: **reserve**。`G1CollectedHeap::initialize` 里 `Reserve the maximum` 那句话留了个尾巴——"reserve 虚拟地址空间"到底是怎么做的?虚拟地址不像物理内存,reserve 与 commit 分离的机制是 Metaspace、CodeCache、GC 堆共同的地基。下一篇: VirtualSpace——reserve/commit 的虚拟地址管理。

> → [09-memory-core/02 — VirtualSpace](02-virtualspace.md)
