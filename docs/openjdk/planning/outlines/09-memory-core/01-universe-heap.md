# 01. Universe + CollectedHeap — JVM 的"Genesis"与全局堆

> 🔴 Deep | 10 KP 中的 3 个核心机制
> 读者处境: `new Object()` 分配在哪？GC heap。但这个 heap 是谁创建的、什么时候创建的？`Universe::genesis`——JVM 的 big bang，在 main thread 还没创建任何 Java 线程时执行。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/09-memory-core/01 已按真实源码成文~220 行,本大纲为规划期产物,机制描述以文章为准):
> - **时序全错**: "init.cpp:120 init_globals→genesis" 错——真实链: init_globals(init.cpp:101)里 **universe_init(:111)建堆**(initialize_heap universe.cpp:687→create_heap :752-755→GCConfig::arguments()->create_heap(),gcConfig.cpp:237,gcArguments.hpp:41 纯虚→G1Arguments::create_heap g1Arguments.cpp:151-153=new G1CollectedHeap+策略)→**universe2_init(init.cpp:124)调 Universe::genesis(universe.cpp:321-462)造第一批对象**→javaClasses_init(:125)
- **"Step 0: _verify_in_progress=false" 错**: _verify_in_progress 定义在 universe.cpp:127,是 verify 的全局开关(:1200-1264),与 genesis 无关
- **"Step 1: GCConfig create_heap→new G1 在 genesis" 错**: create_heap 在 universe_init(initialize_heap :766);GC 选择=GCConfig::select_gc(gcConfig.cpp:146-183),ergonomics(:102-114)=server-class→UseG1GC 否则 UseSerialGC;**new 只是 C++ 空壳,虚拟内存 reserve 在 G1CollectedHeap::initialize(g1CollectedHeap.cpp:1533+,注释 "Reserve the maximum" :1556)**
- **"Step 2: _the_array_interfaces_array=oopFactory::new_objArray" 错**: 是 **MetadataFactory::new_array<Klass*>**(Metaspace 的 C 数组,universe.cpp:354),填充 Cloneable/Serializable(:383-384)=数组类共享接口清单
- **"Step 3: initialize_basic_type_klass 预创建 TypeArrayKlass" 错**: 创建是 **TypeArrayKlass::create_klass ×8**(:334-341,先于一切,依赖 compute_base_vtable_size :331/:1115-1117=ClassLoader::compute_Object_vtable);initialize_basic_type_klass(:306-317)只是把 super 设为 Object 挂层次(:387-394)
- **"Step 4: genesis_oop 函数" 不存在(编造)**: _the_empty_int/short/method/klass_array 是 **Metaspace 的 Array<T>**(MetadataFactory::new_array,:355-358),**不是堆对象**;"new int[0] 返回预分配" 错——堆上预分配空数组只有 the_empty_class_klass_array(universe.cpp:1018,Class[0],用途: method.cpp:733 无 checked exception 时返回的规范对象)
- **"Step 5: SystemDictionary::initialize 创建空 InstanceKlass" 错**: initialize(systemDictionary.cpp:1907)是建字典表+new_intArray(0)锁对象(:1916)+**resolve_well_known_classes(:1918)真正加载核心类**(07-04);随后 Universe::initialize_basic_type_mirrors(universe.cpp:464-509,9 个基本类型镜像 create_basic_type_mirror :478-495,git 文中 **int.class 是 C++ 造的**)与 fixup_mirrors(:511-534,消化 07-07 的 fixup_mirror_list,"Bootstrap problem" 注释 :512-515);_objectArrayKlassObj(:414-415)=Object_klass()->array_klass(1)
- **"~200 个 Symbol" 未验证**: vmSymbols::initialize(vmSymbols.cpp:78)是预定义符号表,数量未数
- **"universe.hpp:100-250" 漂移**: class Universe :96;访问器: heap() :390、intArrayKlassObj() :276、the_array_interfaces_array() :327、the_empty_int_array() :362、out_of_memory_error_java_heap() :370、create_heap/initialize_heap :224-225;non_oop_word(universe.cpp:656-672)=os::non_memory_address_word()|1,用途=**compiledIC 内联缓存空目标占位**(compiledIC.cpp:61-63/:120),非"narrow oop 最高位编码"
- **"heap.hpp:50-350" 错**: heap.hpp 是 **CodeHeap**(代码缓存);CollectedHeap 在 **share/gc/shared/collectedHeap.hpp:104**(家族注释 :94-102: GenCollectedHeap/G1/ParallelScavenge/Shenandoah/Z);mem_allocate(:159-160 纯虚,单对象)/allocate_new_tlab(:145-149,**三参数** min/requested/actual)/collect(:398)/object_iterate(:443)/safe_object_iterate(:447)/gc_cause(:299)/total_collections(:419)
- **分配链(大纲"oopFactory→TLAB→G1Allocator"错)**: 真实=**MemAllocator**(share/gc/shared/memAllocator.cpp):allocate(:373-389)→mem_allocate(:362-369,TLAB 分派)→allocate_inside_tlab(:284-295,bump)→slow(:297+,剩余>refill_waste_limit 放弃 :309-311,否则换新 TLAB :324 heap->allocate_new_tlab)→allocate_outside_tlab(:270-281,heap->mem_allocate)→G1 attempt_allocation_humongous(:404)/attempt_allocation(:407);对象头初始化 finish(:396-408: prototype_header mark+release_set_klass);System.gc 终点=JVM_GC(jvm.cpp:457-460)→heap()->collect(_java_lang_system_gc)
- **oopFactory 编造**: **无 new_instance、无 new_symbol**;只有 8 个 type array 工厂(:44-51 依赖 Universe::xxxArrayKlassObj)+new_objectArray(:54-58)+new_typeArray(:63)+new_objArray(:68)
- **iterator.hpp:30-100 漂移**: OopClosure 在 :52-56(do_oop oop*/narrowOop* 双纯虚)、ObjectClosure 在 :161-165(do_object)
- **预分配 OOME(大纲未提,重点)**: universe_post_init(universe.cpp:1002+)6 个 OOME(:1020-1029)+delayed SOE 消息(:1032-1034);gen_out_of_memory_error(:615-650)池机制(PreallocatedOutOfMemoryErrorCount,取池+搬消息+填栈帧,池尽退回默认)
- **genesis 依赖顺序(大纲未提)**: compute_base_vtable_size→TypeArrayKlass×8(数组 Klass 先于普通类,vtable 长度继承 Object)→vmSymbols::initialize(:362)→SystemDictionary::initialize(:364)→mirrors→initialize_basic_type_klass×8→_objectArrayKlassObj;_bootstrapping FlagSetting(:324)
- 悬念指向 02-virtualspace.md(标题 "02. VirtualSpace — reserve/commit 三级虚拟地址管理")✓

### 1. Universe::genesis — JVM 的"宇宙大爆炸"

场景: JVM 启动→`init.cpp:120 init_globals()`→`Universe::genesis(TRAPS)`——此时只有一个 main thread，没有 Java 线程，没有 GC heap，没有加载任何类。genesis 创建了 JVM 需要的一切。

**完整流程** (`universe.cpp:100-500`):
- Step 0: `Universe::_verify_in_progress = false`——后续对象分配将跳过 debug verify 检查
- Step 1: `GCConfig::arguments()->create_heap()`→`new G1CollectedHeap(GCArguments*)`——选择 GC→分配 C++ 对象。Heap 只有 C++ 结构——**还没有 reserve 虚拟内存**——reserve 在 `G1CollectedHeap::initialize()` 中
- Step 2: `Universe::_the_array_interfaces_array = oopFactory::new_objArray(...)`——在刚创建的 heap 上分配第一个对象——interfaces 数组的 Klass
- Step 3: `initialize_basic_type_klass(klass, THREAD)`——预创建 int[]/byte[]/char[]/short[]/long[]/float[]/double[] 的 TypeArrayKlass——存为 `_intArrayKlassObj` 等全局指针
- Step 4: `Universe::genesis_oop(Handle, TempNewObject, THREAD)`→为每种基本类型创建 `_the_empty_<type>_array`——零长度数组实例——后续 `new int[0]` 直接返回预分配——**不触发 GC，不分配新对象**
- [C++: `Handle` 包装——`HandleMark hm(THREAD)` 在 genesis scope 入口——所有 Handle 在 hm dtor 时自动释放。`TempNewObject` 是临时 Handle——赋值时自动 `set_obj(oop)`——Java 对象被 GC 安全引用]
- Step 5: `SystemDictionary::initialize(THREAD)`→为 Object/String/Class/System/Thread 创建**空** InstanceKlass——类尚未加载——只分配 Klass C++对象→后续 `ClassLoader::load_classfile("java/lang/Object.class")` 解析 ClassFile 填充
- [C++: genesis 中 `oopFactory::new_symbol("java/lang/Object", 16, THREAD)` 创建 Symbol——存入 SymbolTable——refcount=1。genesis scope 创建 ~200 个 Symbol——class/method/field names——全部 intern 到 SymbolTable]

**Universe 的全局访问器** (`universe.hpp:100-250`):
- `intArrayKlassObj()`: `return _intArrayKlassObj`——inline——1 deref。`byteArrayKlassObj()`/`charArrayKlassObj()`/`shortArrayKlassObj()`/`longArrayKlassObj()`/`floatArrayKlassObj()`/`doubleArrayKlassObj()`
- `_the_empty_int_array`: `return _the_empty_int_array`——直接返回预分配的 TypedArray OOP——零分配
- `_non_oop_bits`: narrow oop 模式下，OOP的最高几位编码了是否是 OOP (gc 扫描区分)
- `_collectedHeap`: `return _collectedHeap`——G1CollectedHeap*——`Universe::heap()` 被全 VM 调用

### 2. CollectedHeap — GC 堆的抽象接口

**CollectedHeap** (`heap.hpp:50-350` + `heap.cpp`):
- 虚基类——所有 GC 堆 (G1/Parallel/Serial/Z/Shenandoah) 继承此——多态 GC
- `mem_allocate(size_t size, bool* gc_overhead_limit)`: 对象分配入口——TLAB 满后调用——virtual dispatch→G1 `attempt_allocation()` or Serial bump-pointer
- `allocate_new_tlab(size_t word_size)`: TLAB 分配——TLAB 满→分配新 TLAB→`mem_allocate(tlab_size)`
- [C++: `CollectedHeap::allocate_new_tlab` 的调用链——`ThreadLocalAllocBuffer::fill()`→size needed→`Universe::heap()->allocate_new_tlab(size)`→GC-specific→返回 HeapWord* (TLAB 起始地址)。TLAB 满: Thread 当前 TLAB 有剩余但不满足→refill→retire 当前 TLAB→try allocate_new_tlab]
- `collect(GCCause::Cause cause)`: 触发 GC——System.gc()→`Universe::heap()->collect(GCCause::_java_lang_system_gc)`
- `object_iterate(ObjectClosure* cl)`: 遍历堆所有 live objects——JVMTI 迭代/JFR heap dump/JMAP histogram——virtual dispatch→GC specific iteration
- `gc_cause()`: 上次 GC 的原因枚举——JMX `GarbageCollectorMXBean.getLastGcInfo()` 的报告
- `total_collections()`: 累计 GC 次数——JFR periodic event `GarbageCollection` 计数器

**OOP 工厂** (`oopFactory.hpp.cpp`):
- `oopFactory::new_instance(Klass* klass, TRAPS)`: `klass->check_valid_for_instantiation(THREAD)`→`klass->allocate_instance(THREAD)`→`InstanceKlass::allocate_instance(THREAD)`——zeroing→set markOop→return oop
- `oopFactory::new_objArray(Klass* klass, int length, TRAPS)`: `ObjArrayKlass::allocate_objArray(klass, length, THREAD)`——分配+zeroing elements
- `oopFactory::new_typeArray(BasicType type, int length, TRAPS)`: `TypeArrayKlass::allocate_common(type, length, THREAD)`——byte/short/int/long/...
- `oopFactory::new_symbol(const char* name, int len, TRAPS)`: `SymbolTable::new_symbol(name, len, THREAD)`——intern 到 SymbolTable

### 3. OopClosure + GC 扫描基础

**ObjectClosure / OopClosure** (`iterator.hpp:30-100`):
- `ObjectClosure::do_object(oop obj)`: 对每个 live object 执行——MarkSweep: mark+push; HeapDumper: write to HPROF
- `OopClosure::do_oop(oop* p)` / `do_oop(narrowOop* p)`: 处理对象引用——不同 Closure 不同行为
- G1: `G1ParCopyClosure::do_oop_work(oop* p, ...)`——copy obj to new region (evacuation)→forward→update reference
- [C++: GC 扫描调用链——thread stack→`frame::oops_do(frame, reg_map, closure)`→遍历 Frame 中的所有 OOP slot→`closure->do_oop(slot)`。static fields→`InstanceMirrorKlass::oops_do(mirror, closure)`。ClassLoaderData→`ClassLoaderDataGraph::always_strong_oops_do(closure)`]

---

### 核心悬念

**"`new Object()` 走多少层？JIT: oopFactory→TLAB→G1Allocator::attempt_allocation→bump-pointer (1 cycle 正常)→TLAB 满→CollectedHeap::allocate_new_tlab→G1 policy→new region。Universe 预创建了所有空数组和核心类 Klass——JVM 启动后第一个 `new Object()` 不需要等待 class loading。"** — Universe 是全局唯一——`Universe::heap()` 被全 VM 调用。下一个: VirtualSpace——这个 heap 底层怎么管理虚拟内存。

> → [02-virtualspace.md](02-virtualspace.md)
