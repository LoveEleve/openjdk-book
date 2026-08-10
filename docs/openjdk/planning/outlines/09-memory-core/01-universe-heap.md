# 01. Universe + CollectedHeap — JVM 的"Genesis"与全局堆

> 🔴 Deep | 10 KP 中的 3 个核心机制
> 读者处境: `new Object()` 分配在哪？GC heap。但这个 heap 是谁创建的、什么时候创建的？`Universe::genesis`——JVM 的 big bang，在 main thread 还没创建任何 Java 线程时执行。

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
