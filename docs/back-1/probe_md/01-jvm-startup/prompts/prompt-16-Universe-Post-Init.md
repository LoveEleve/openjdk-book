# PROMPT: 请撰写 16-Universe-Post-Init.md

## §〇 Production Scenario

### 场景 1: Metaspace OOM 时 JVM 能抛出异常而不崩溃

```
Exception in thread "main" java.lang.OutOfMemoryError: Metaspace
```

JVM 在 Metaspace 耗尽时抛出了 `OutOfMemoryError: Metaspace`，但此时 Metaspace 已经无法分配任何新对象——包括异常对象本身。JVM 怎么做到的？

答案在 `universe_post_init()`（`universe.cpp:1252`）：JVM 在 `init_globals()` 阶段预先分配了 7 个 `OutOfMemoryError` 实例，存储在 `Universe::_out_of_memory_error_metaspace` 等静态 oop 中。当 Metaspace 分配失败时，`report_metadata_oome()`（`metaspace.cpp:1575`）调用 `Universe::out_of_memory_error_metaspace()` 返回预分配实例——无需 new 操作，无需 Metaspace 分配。

**三步诊断**：
```bash
# 1. 确认预分配 OOM 对象存在
gdb -ex "break universe.cpp:1340" \
    -ex "run" \
    -ex "print Universe::_out_of_memory_error_metaspace" \
    -ex "print Universe::_preallocated_out_of_memory_error_avail_count" \
    --args java -jar app.jar
# 期望: 非 NULL oop，avail_count > 0

# 2. 模拟 Metaspace OOM
java -XX:MaxMetaspaceSize=8m -jar app.jar
# 期望: OutOfMemoryError: Metaspace

# 3. 验证预分配 OOM 的 backtrace 是空的
jcmd <pid> GC.class_histogram | rg OutOfMemoryError
# 预分配 OOM 的 backtrace 长度为 0（节省内存）
```

**反事实**：如果 JVM 在 Metaspace OOM 时不预分配异常 → `report_metadata_oome()` 需要 `new OutOfMemoryError("Metaspace")` → 但 `new` 需要 Metaspace 分配 → 递归触发 `report_metadata_oome()` → 无限递归 → JVM crash（`SIGSEGV` on null oop dereference）。预分配机制将 O(N) 的异常创建降为 O(1) 的 oop 指针返回。

### 场景 2: `new int[Integer.MAX_VALUE]` 抛出 ArrayStoreException 还是 OutOfMemoryError？

```java
int[] arr = new int[Integer.MAX_VALUE];
// → java.lang.OutOfMemoryError: Requested array size exceeds VM limit
```

`universe_post_init()`（`universe.cpp:1254`）预分配了 `_out_of_memory_error_array_size`，消息为 `"Requested array size exceeds VM limit"`。`arrayKlass::allocate_arrayArray()`（`arrayKlass.cpp:133`）在数组长度超过 JVM 内部限制（`max_array_length`）时调用 `Universe::out_of_memory_error_array_size()` 返回此预分配实例。

**反事实**：如果此异常不是预分配的 → 数组分配请求本身已经因为大小问题失败 → `new OutOfMemoryError(...)` 可能也需要数组分配 → 循环依赖 → crash。预分配 OOM 对象独立于数组分配路径，打破循环依赖。

### 场景 3: JIT 编译的 `x / 0` 抛出 ArithmeticException 而不分配新对象

```java
int x = 5 / 0;
// → java.lang.ArithmeticException: / by zero
```

`universe_post_init()`（`universe.cpp:1272`）预分配了 `_arithmetic_exception_instance`，消息设为 `"/ by zero"`（`:1303`）。JIT 编译器在生成除法指令时，如果检测到除数可能为零，直接引用预分配实例——无需在异常路径上分配对象（异常路径通常是 JIT 编译的瓶颈，因为分配操作涉及 GC 安全点）。

源码注释称之为 "cheap & dirty solution"：不需要从 C1/C2 的 IR 节点生成异常对象分配的代码。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the FIVE remaining Universe initialization calls in `init_globals()` that complete Java's type system, class metadata, and exception infrastructure. These 5 calls run after `universe_init()` (which created G1 heap, Metaspace, SymbolTable, StringTable) and before the compiler initialization:

- `gc_barrier_stubs_init()` — GC barrier assembly stubs (line 144)
- `universe2_init()` → `Universe::genesis()` — 8 primitive array Klasses + SystemDictionary + null sentinel (line 157)
- `javaClasses_init()` → `JavaClasses::compute_offsets()` — 29 Java core class field offsets (line 161)
- `referenceProcessor_init()` — Soft reference LRU policy + timestamp clock (line 164)
- `universe_post_init()` — Pre-allocated OOM/NPE/Arithmetic exceptions + vtable reinit + known methods (line 183)

Reader completed **02-G1-Heap-Startup**, **03-Metaspace**, **04-SymbolTable**, **05-StringTable** (universe_init's sub-initializations) and **11-Stages5-10** (JVM startup stages). This doc: **how the JVM completes its type system by creating the 8 primitive array Klasses, caching 29 Java class field offsets, pre-allocating 10 exception instances to survive OOM scenarios, and initializing the GC barrier stub dispatch mechanism**.

### Interview Story Format Answer（必须出现在 §一 末尾）

"`init_globals()` at `init.cpp:109` has 5 Universe-related calls between `universe_init()` (line 137) and `compileBroker_init()` (line 177). `gc_barrier_stubs_init()` at `barrierSet.cpp:49` generates GC barrier assembly stubs via virtual dispatch through `BarrierSetAssembler::barrier_stubs_init()` — the actual stub code depends on the GC (G1 generates SATB pre-write barriers, Shenandoah generates Brooks pointer barriers, ZGC generates load barriers). `universe2_init()` at `universe.cpp:1220` delegates to `Universe::genesis()` (142 lines) which creates the 8 primitive array Klasses (`boolean[]` through `long[]`) via `TypeArrayKlass::create_klass()`, initializes `SystemDictionary` with 5 hash tables (placeholder, constraint, resolution error, invoke method, protection domain cache), computes `Object`'s base vtable size (5 entries = 10 words in 64-bit), creates the null sentinel string `"<null_sentinel>"`, and creates the `Object[]` Klass. `javaClasses_init()` at `javaClasses.cpp:4597` calls `JavaClasses::compute_offsets()` which uses the `BASIC_JAVA_CLASSES_DO_PART2` macro to compute field offsets for 29 Java core classes — from `java_lang_Thread.eetop` to `java_nio_Buffer.address` to `java_lang_invoke_MemberName.vmtarget`. `referenceProcessor_init()` at `referenceProcessor.cpp:47` initializes soft reference LRU policies — `LRUMaxHeapPolicy` for Server VM, `LRUCurrentHeapPolicy` for Client VM — and synchronizes `SoftReference.clock` via `java_lang_ref_SoftReference::set_clock()`. `universe_post_init()` at `universe.cpp:1230` (111 lines) is the heavyweight: pre-allocates 7 `OutOfMemoryError` instances with specific messages (Java heap space, Metaspace, Compressed class space, Requested array size exceeds VM limit, GC overhead limit exceeded, failed reallocation of scalar replaced objects), pre-allocates `NullPointerException`, `ArithmeticException` with '/ by zero' message, `VirtualMachineError`, creates a pre-allocated OOM array with backtrace pre-filled for high-frequency OOM scenarios, reinitializes vtables and itables, initializes 6 known methods (Finalizer.register, Unsafe.throwIllegalAccessError, etc.), and registers Metaspace memory pools with JMX. The key architectural insight: these 5 calls collectively complete Java's type system — after `universe_post_init()` returns, every Java object type, every array type, every core class field offset, and every emergency exception instance is ready for the JVM to execute Java code."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **TypeArrayKlass vs ObjArrayKlass**: `TypeArrayKlass` represents primitive arrays (`int[]`, `byte[]`, `boolean[]`) — elements are raw values stored directly in array memory, no oop headers, no GC scanning needed. `ObjArrayKlass` represents object arrays (`Object[]`, `String[]`) — elements are oop pointers that the GC must scan. `TypeArrayKlass::create_klass()` at `typeArrayKlass.cpp:58` creates a permanent Symbol, allocates the Klass in the null ClassLoaderData (bootstrap class loader), and registers it as a GC root. The 8 `TypeArrayKlass` instances are the JVM's "primitive type system foundation."

2. **预分配异常的 O(1) 设计**: `universe_post_init()` creates 10 exception instances before any Java code runs. These are stored as static `oop` pointers in `Universe` class. When the JVM needs to throw an OOM/NPE/ArithmeticException internally (GC, JIT, interpreter), it returns the pre-allocated oop via `Universe::out_of_memory_error_java_heap()` etc. — zero allocation, zero GC interaction, zero Metaspace usage. This breaks the circular dependency: "need memory to throw OutOfMemoryError about running out of memory."

3. **BASIC_JAVA_CLASSES_DO_PART2 宏**: This macro at `javaClasses.hpp:55` defines 29 Java classes whose field offsets HotSpot needs to access from C++. Each class has a `compute_offsets()` static method that calls `InstanceKlass::cast(k)->find_field()` to locate fields by name and signature, then stores the byte offset in a static member. These offsets are used by `java_lang_Thread::eetop()`, `java_nio_Buffer::address()`, etc. — the "bridge" between Java object layout and C++ direct field access.

4. **SystemDictionary 的五张哈希表**: `SystemDictionary::initialize()` at `systemDictionary.cpp:1937` creates 5 hash tables: `_placeholders` (tracks class loading in progress to prevent duplicate loading), `_loader_constraints` (enforces type safety across class loaders), `_resolution_errors` (caches resolution failures), `_invoke_method_table` (tracks invokedynamic resolution), `_pd_cache_table` (caches ProtectionDomain lookups). Each table uses different hash functions and collision strategies.

5. **SoftReference 时钟同步**: `ReferenceProcessor::init_statics()` at `referenceProcessor.cpp:54` calls `os::javaTimeNanos() / NANOSECS_PER_MILLISEC` to get a monotonic millisecond timestamp (NOT `os::javaTimeMillis()` which can go backwards due to NTP), then writes it directly to `SoftReference.clock` static field via `java_lang_ref_SoftReference::set_clock()`. This clock drives the LRU soft reference eviction policy — older soft references are evicted before newer ones.

6. **vtable 和 itable 的重初始化**: After `Universe::genesis()` creates Klasses, `universe_post_init()` calls `Universe::reinitialize_vtable_of()` and `Universe::reinitialize_itables()` — these recursively walk all loaded classes and rebuild their virtual method tables and interface method tables. This is necessary because methods are discovered during class loading (after genesis creates the Klasses), so the vtables need a second pass to fill in the actual `Method*` pointers. CDS (Class Data Sharing) skips this because vtables are restored from the archive.

7. **GC Barrier Stubs 的虚函数分派**: `gc_barrier_stubs_init()` at `barrierSet.cpp:49` calls `BarrierSet::barrier_set()->barrier_set_assembler()->barrier_stubs_init()` — a double virtual dispatch: first to get the GC-specific BarrierSetAssembler (G1 gets `G1BarrierSetAssembler`, Shenandoah gets `ShenandoahBarrierSetAssembler`), then to generate the actual assembly stubs. G1 generates SATB pre-write barrier stubs that go into CodeCache. The `#ifndef ZERO` guard skips this for the zero-assembler interpreter build variant.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/memory/universe.cpp` — Universe::genesis() (:323) + universe_post_init() (:1230)
- `src/hotspot/share/memory/universe.hpp` — _boolArrayKlassObj 等 8 个 Klass* + 预分配异常 oop 声明
- `src/hotspot/share/classfile/javaClasses.cpp` — JavaClasses::compute_offsets() (:4478)
- `src/hotspot/share/classfile/javaClasses.hpp` — BASIC_JAVA_CLASSES_DO_PART2 宏 (:55)
- `src/hotspot/share/classfile/systemDictionary.cpp` — SystemDictionary::initialize() (:1937)
- `src/hotspot/share/classfile/vmSymbols.cpp` — vmSymbols::initialize() (:78)
- `src/hotspot/share/gc/shared/referenceProcessor.cpp` — ReferenceProcessor::init_statics() (:51)
- `src/hotspot/share/gc/shared/referencePolicy.hpp` — ReferencePolicy 类层次
- `src/hotspot/share/gc/shared/barrierSet.cpp` — gc_barrier_stubs_init() (:49)
- `src/hotspot/share/gc/shared/barrierSet.hpp` — BarrierSet + BarrierSetAssembler
- `src/hotspot/cpu/x86/gc/shared/barrierSetAssembler_x86.hpp` — BarrierSetAssembler::barrier_stubs_init() (:81)
- `src/hotspot/share/oops/typeArrayKlass.cpp` — TypeArrayKlass::create_klass() (:58)
- `src/hotspot/share/oops/instanceKlass.cpp` — InstanceKlass::allocate_instance() (:1281)
- `src/hotspot/share/oops/oopFactory.cpp` — oopFactory::new_objArray() (:82)
- `src/hotspot/share/runtime/init.cpp` — init_globals() 中 5 个调用的位置

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjvm.so`

**关键全局状态表**：

| 变量 | 类型 | 位置 | 说明 |
|------|------|------|------|
| `Universe::_boolArrayKlassObj` ~ `_longArrayKlassObj` | `Klass*[8]` | universe.hpp:115-122 | 8 种基本类型数组 Klass |
| `Universe::_typeArrayKlassObjs[]` | `Klass*[T_LONG+1]` | universe.hpp:123 | BasicType→Klass* 快速索引 |
| `Universe::_objectArrayKlassObj` | `Klass*` | universe.hpp:114 | Object[] Klass |
| `Universe::_the_null_string` | `oop` | universe.hpp:136 | intern("null") |
| `Universe::_the_null_sentinel` | `oop` | universe.hpp:135 | String("<null_sentinel>") |
| `Universe::_out_of_memory_error_java_heap` ~ `_realloc_objects` | `oop[7]` | universe.hpp:148-153 | 7 个预分配 OOM 异常 |
| `Universe::_null_ptr_exception_instance` | `oop` | universe.hpp:155 | 预分配 NPE |
| `Universe::_arithmetic_exception_instance` | `oop` | universe.hpp:156 | 预分配 ArithmeticException "/ by zero" |
| `Universe::_preallocated_out_of_memory_error_array` | `objArrayOop` | universe.hpp:158 | OOM[N] 数组 |
| `Universe::_preallocated_out_of_memory_error_avail_count` | `jint` | universe.hpp:159 | 可用计数 |
| `Universe::_base_vtable_size` | `int` | universe.hpp:167 | Object vtable = 10 words |
| `ReferenceProcessor::_soft_ref_timestamp_clock` | `jlong` | referenceProcessor.hpp | 毫秒单调时钟 |
| `ReferenceProcessor::_default_soft_ref_policy` | `ReferencePolicy*` | referenceProcessor.hpp | LRU 策略 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **universe.cpp** | `src/hotspot/share/memory/universe.cpp` | 1609 | `Universe::genesis()`(:323), `universe_post_init()`(:1230), `initialize_basic_type_klass()`(:308), `reinitialize_vtable_of()`(:574), `initialize_known_methods()`(:1184) | Universe 初始化核心 |
| 2 | **universe.hpp** | `src/hotspot/share/memory/universe.hpp` | 250+ | 8 Klass* 声明, 预分配异常 oop 声明, `_base_vtable_size` | Universe 类定义 |
| 3 | **javaClasses.cpp** | `src/hotspot/share/classfile/javaClasses.cpp` | 4601 | `JavaClasses::compute_offsets()`(:4478), `allocate_fixup_lists()`(:880) | Java 类字段偏移量 |
| 4 | **javaClasses.hpp** | `src/hotspot/share/classfile/javaClasses.hpp` | 1200+ | `BASIC_JAVA_CLASSES_DO_PART2` 宏(:55) | 类列表宏 |
| 5 | **systemDictionary.cpp** | `src/hotspot/share/classfile/systemDictionary.cpp` | ~2500 | `SystemDictionary::initialize()`(:1937) | 系统字典 + 知名类解析 |
| 6 | **vmSymbols.cpp** | `src/hotspot/share/classfile/vmSymbols.cpp` | ~200 | `vmSymbols::initialize()`(:78) | VM 符号表初始化 |
| 7 | **referenceProcessor.cpp** | `src/hotspot/share/gc/shared/referenceProcessor.cpp` | 1401 | `ReferenceProcessor::init_statics()`(:51) | 引用处理器初始化 |
| 8 | **referencePolicy.hpp** | `src/hotspot/share/gc/shared/referencePolicy.hpp` | 83 | `AlwaysClearPolicy`, `LRUMaxHeapPolicy`, `LRUCurrentHeapPolicy` | 软引用策略层次 |
| 9 | **barrierSet.cpp** | `src/hotspot/share/gc/shared/barrierSet.cpp` | 55 | `gc_barrier_stubs_init()`(:49) | GC 屏障 stub 入口 |
| 10 | **barrierSetAssembler_x86.hpp** | `src/hotspot/cpu/x86/gc/shared/barrierSetAssembler_x86.hpp` | 82 | `BarrierSetAssembler::barrier_stubs_init()`(:81) | x86 屏障桩基类 |
| 11 | **typeArrayKlass.cpp** | `src/hotspot/share/oops/typeArrayKlass.cpp` | ~200 | `TypeArrayKlass::create_klass()`(:58) | 基本类型数组 Klass 创建 |
| 12 | **instanceKlass.cpp** | `src/hotspot/share/oops/instanceKlass.cpp` | ~3500 | `InstanceKlass::allocate_instance()`(:1281) | 实例对象分配 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 ★★★ Universe::genesis() — 8 种基本类型数组 Klass 的创建

```
问题：
  ① Universe::genesis() (universe.cpp:323-464, 142 行) 如何创建 8 种基本类型数组 Klass？
      答案方向: 源码展示创建循环（:336-343）：
        _boolArrayKlassObj  = TypeArrayKlass::create_klass(T_BOOLEAN, sizeof(jboolean), CHECK);
        _charArrayKlassObj  = TypeArrayKlass::create_klass(T_CHAR,    sizeof(jchar),    CHECK);
        _singleArrayKlassObj= TypeArrayKlass::create_klass(T_FLOAT,   sizeof(jfloat),   CHECK);
        _doubleArrayKlassObj= TypeArrayKlass::create_klass(T_DOUBLE,  sizeof(jdouble),  CHECK);
        _byteArrayKlassObj  = TypeArrayKlass::create_klass(T_BYTE,    sizeof(jbyte),    CHECK);
        _shortArrayKlassObj = TypeArrayKlass::create_klass(T_SHORT,   sizeof(jshort),   CHECK);
        _intArrayKlassObj   = TypeArrayKlass::create_klass(T_INT,     sizeof(jint),      CHECK);
        _longArrayKlassObj  = TypeArrayKlass::create_klass(T_LONG,    sizeof(jlong),     CHECK);
      
      TypeArrayKlass::create_klass() (typeArrayKlass.cpp:58-76):
        1. SymbolTable::new_permanent_symbol(name_str) → 永久符号（不会被 GC）
        2. TypeArrayKlass::allocate(null_loader_data, type, sym) → 在 null ClassLoaderData 中分配 Klass
        3. null_loader_data->add_class(ak) → 注册为 GC 强根
        4. complete_create_array_klass(ak, ak->super(), ModuleEntryTable::javabase_moduleEntry())
           → 设置超类（java.lang.Object）+ 模块（java.base）
      
      然后 :345-352 填充 _typeArrayKlassObjs[T_BOOLEAN..T_LONG] 数组建立 BasicType→Klass* 映射。
      最后 :308-320 initialize_basic_type_klass() 为每个 Klass 设置 Object 为超类并挂到兄弟链表。
      
      追问: 为什么 T_FLOAT 的 Klass 叫 _singleArrayKlassObj 而非 _floatArrayKlassObj？
      → JVM 内部用 "single" 而非 "float" 描述 32-bit 浮点类型。这是历史命名——Java 虚拟机规范
        中 T_FLOAT 的数组描述符是 [F (float)，但内部标识符使用 "single" 以区别于 "double" (64-bit)。

  ② Counterfactual: 如果基本类型数组 Klass 不在 genesis 中创建而是懒加载？
      答案方向: 每次 new int[10] 都需要检查 TypeArrayKlass 是否存在 → 不存在则调用 create_klass
      → 需要获取 ClassLoaderData_lock → 与类加载锁竞争 → 多线程首次数组分配会串行化。
      genesis 中的批量预创建将 O(N) 的首次分配延迟（N 次锁竞争 + Klass 创建）
      降为 O(1)（Klass* 指针查表）。代价：8 个 Klass* 指针（64 bytes）的静态存储。
```

### 4.2 ★★★ SystemDictionary::initialize() — 5 张哈希表

```
问题：
  ① SystemDictionary::initialize() (systemDictionary.cpp:1937-1955) 创建了哪 5 张哈希表？
      答案方向:
        _placeholders        = new PlaceholderTable(_placeholder_table_size)        — 类加载占位符
        _loader_constraints  = new LoaderConstraintTable(_loader_constraint_size)   — 加载器约束
        _resolution_errors   = new ResolutionErrorTable(_resolution_error_size)     — 解析错误缓存
        _invoke_method_table = new SymbolPropertyTable(_invoke_method_size)         — invokedynamic 方法
        _pd_cache_table      = new ProtectionDomainCacheTable(defaultProtectionDomainCacheSize) — 保护域缓存
        
        还创建 _system_loader_lock_obj = oopFactory::new_intArray(0) — 用 0 长度 int 数组作为系统类加载器的锁对象。
        
        然后调用 resolve_well_known_classes(CHECK) 加载所有 WK_KLASS 枚举定义的知名类。
        
      追问: 为什么系统类加载器的锁对象是 0 长度 int 数组？
      → Java 中任何 Object 都可以作为 synchronized 的锁。int[0] 是最小的非 null 对象
        （12 bytes header + 0 bytes data = 12 bytes），相比 new Object()（16 bytes aligned）
        节省 4 bytes。而且 int[] 永远不会被子类重写 hashCode/equals，保证锁行为一致性。

  ② Counterfactual: 如果没有 _resolution_errors 缓存？
      答案方向: 每次类加载失败后，相同的类名再次被引用时会重新尝试解析 → 重新走
      ClassLoader.loadClass → defineClass → verify → 再次失败 → 再次抛异常。
      对于频繁引用的缺失类（如反射扫描），这会产生 O(N) 的解析尝试开销。
      _resolution_errors 缓存失败结果 → 后续相同类名的解析直接抛缓存的异常 → O(1)。
```

### 4.3 ★★★ universe_post_init() — 预分配异常对象

```
问题：
  ① universe_post_init() (universe.cpp:1230-1340, 111 行) 预分配了哪些异常？
      答案方向: 源码展示 10 个预分配异常：
        // 7 个 OutOfMemoryError 变体
        _out_of_memory_error_java_heap          — "Java heap space"
        _out_of_memory_error_metaspace           — "Metaspace"
        _out_of_memory_error_class_metaspace     — "Compressed class space"
        _out_of_memory_error_array_size          — "Requested array size exceeds VM limit"
        _out_of_memory_error_gc_overhead_limit   — "GC overhead limit exceeded"
        _out_of_memory_error_realloc_objects     — "Java heap space: failed reallocation of scalar replaced objects"
        _preallocated_out_of_memory_error_array  — objArrayOop[PreallocatedOutOfMemoryErrorCount]
        
        // 3 个其他异常
        _null_ptr_exception_instance             — NullPointerException (无消息)
        _arithmetic_exception_instance           — ArithmeticException("/ by zero")
        _virtual_machine_error_instance          — VirtualMachineError (无消息)
        _vm_exception                            — VirtualMachineError 备用
        
        _preallocated_out_of_memory_error_array 的每个元素预先填充了空 backtrace
        (java_lang_Throwable::allocate_backtrace)，避免 OOM 时无法分配 backtrace。
        _preallocated_out_of_memory_error_avail_count 初始化为 PreallocatedOutOfMemoryErrorCount，
        每次消费一个预分配 OOM 时递减。
      
      追问: 为什么 VirtualMachineError 需要 link_class_or_fail() 而其他异常不需要？
      → VME 在 SystemDictionary::resolve_well_known_classes() 之后才被引用。
        OOM/NPE/ArithmeticException 在 WK_KLASS 枚举中，resolve_well_known_classes()
        已经完成了链接。VME 需要显式调用 link_class_or_fail() 完成链接。

  ② Counterfactual: 如果 _preallocated_out_of_memory_error_array 耗尽（avail_count=0）？
      答案方向: Universe::gen_out_of_memory_error() 回退到 _out_of_memory_error_java_heap
      静态实例。这是单例模式——所有后续 OOM 共享同一个异常对象。但因为 OOM 通常意味着
      JVM 即将终止，共享实例的竞态条件（多个线程同时修改 detailMessage）在实践中不构成问题。
      如果不预分配 → 每次 OOM 都尝试 new → Metaspace/Heap 分配 → 递归 OOM → crash。
```

### 4.4 ★★★ javaClasses_init() — 29 个核心类字段偏移量

```
问题：
  ① JavaClasses::compute_offsets() (javaClasses.cpp:4478-4497) 如何通过宏计算 29 个类的偏移量？
      答案方向: 宏展开机制：
        #define BASIC_JAVA_CLASSES_DO_PART2(f) \
          f(java_lang_System) \
          f(java_lang_ClassLoader) \
          f(java_lang_Throwable) \
          f(java_lang_Thread) \
          ... (共 29 个类)
        
        #define DO_COMPUTE_OFFSETS(k) k::compute_offsets();
        BASIC_JAVA_CLASSES_DO_PART2(DO_COMPUTE_OFFSETS)
      
      每个 compute_offsets() 的实现模式（以 java_lang_Thread 为例）：
        InstanceKlass* k = SystemDictionary::Thread_klass();
        _eetop_offset = k->find_field("eetop", "J", &_eetop_is_offset);
        // 找到 "eetop" 字段（类型 long），存储字节偏移量
        
        CDS 路径（UseSharedSpaces=true）: 直接返回，偏移量从归档恢复。
      
      覆盖的 29 个类按类别分：
        - 基础: System, ClassLoader, Throwable, Thread, ThreadGroup
        - MethodHandle: MethodHandle, DirectMethodHandle, MemberName, ResolvedMethodName, LambdaForm, MethodType, CallSite, CallSiteContext (8 个)
        - 反射: AccessibleObject, Method, Constructor, Field, Parameter (5 个)
        - NIO: Buffer
        - 安全: AccessControlContext, AbstractOwnableSynchronizer
        - 模块: Module
        - 栈: StackTraceElement, StackFrameInfo, LiveStackFrameInfo
        - 其他: ConstantPool, UnsafeStaticFieldAccessorImpl, SoftReference, AssertionStatusDirectives
      
      追问: 为什么 java_lang_String 和 java_lang_Class 不在 PART2 中？
      → 它们在 PART1 中，由 SystemDictionary::resolve_well_known_classes() 提前计算。
        因为 String 和 Class 是类型系统的最基础类——在 genesis 创建 Klass 时就需要
        它们的字段偏移量来访问对象内部结构。

  ② Counterfactual: 如果字段偏移量是硬编码而非运行时计算？
      答案方向: JDK 版本升级可能改变字段布局（添加/删除字段、改变字段顺序）。
      硬编码偏移量在 JDK 升级时会静默出错——读取到错误字段的值。
      运行时通过 find_field() 按名称查找确保偏移量始终正确，代价是每个类 ~1µs
      的查找时间（29 个类 × 1µs = 29µs，在 JVM 启动的 ~500ms 中可忽略）。
```

### 4.5 ★★★ referenceProcessor_init() — 软引用 LRU 时钟

```
问题：
  ① ReferenceProcessor::init_statics() (referenceProcessor.cpp:51-73) 如何初始化软引用策略？
      答案方向:
        jlong now = os::javaTimeNanos() / NANOSECS_PER_MILLISEC;  // 纳秒→毫秒，单调时钟
        _soft_ref_timestamp_clock = now;
        java_lang_ref_SoftReference::set_clock(_soft_ref_timestamp_clock);
        // set_clock() 直接写入 SoftReference.clock 静态字段:
        // InstanceKlass::static_field_base_raw()->long_field_put(static_clock_offset, value)
        
        _always_clear_soft_ref_policy = new AlwaysClearPolicy();
        if (is_server_compilation_mode_vm()) {
          _default_soft_ref_policy = new LRUMaxHeapPolicy();      // Server: 基于历史最大堆
        } else {
          _default_soft_ref_policy = new LRUCurrentHeapPolicy();  // Client: 基于当前堆
        }
      
      策略对比:
        - AlwaysClearPolicy: should_clear_reference() 始终返回 true — 不保留任何软引用
        - LRUMaxHeapPolicy: 基于上次 GC 后的最大可用堆空间计算存活时间
        - LRUCurrentHeapPolicy: 基于当前可用堆空间计算存活时间
      
      追问: 为什么用 javaTimeNanos() 而非 javaTimeMillis()？
      → javaTimeMillis() 是 wall clock，可能因 NTP 调整而回退 → 时钟回退会导致
        软引用时间戳计算错误（新创建的软引用看起来比旧软引用更老）。
        javaTimeNanos() 是 monotonic clock (CLOCK_MONOTONIC) → 保证非递减。

  ② Counterfactual: 如果不区分 Server/Client 策略？
      答案方向: Client VM 的堆通常较小（<256MB），基于当前堆的 LRUCurrentHeapPolicy
      在堆大小波动时更激进地清除软引用。Server VM 的堆通常很大（>1GB），
      LRUMaxHeapPolicy 基于历史峰值更保守——保留软引用更久，提高缓存命中率。
      如果 Server VM 用 LRUCurrentHeapPolicy → 堆大小因 GC 波动 → 大量软引用被过早清除
      → 缓存 miss rate 上升 → 性能退化。这是 JVM 根据部署场景自动优化策略的典型案例。
```

### 4.6 ★★★ gc_barrier_stubs_init() — GC 屏障的虚函数分派

```
问题：
  ① gc_barrier_stubs_init() (barrierSet.cpp:49-55) 如何通过虚函数分派到具体 GC？
      答案方向: 源码展示双重虚函数分派：
        void gc_barrier_stubs_init() {
          BarrierSet* bs = BarrierSet::barrier_set();           // 获取全局 BarrierSet 单例
        #ifndef ZERO  // ZERO 解释器构建跳过（无 JIT）
          BarrierSetAssembler* bsa = bs->barrier_set_assembler(); // 第一次虚分派
          bsa->barrier_stubs_init();                              // 第二次虚分派
        #endif
        }
      
      第一次虚分派（BarrierSet::barrier_set_assembler()）：
        G1 → G1BarrierSet::barrier_set_assembler() → G1BarrierSetAssembler
        Shenandoah → ShenandoahBarrierSet::barrier_set_assembler() → ShenandoahBarrierSetAssembler
        ZGC → ZBarrierSet::barrier_set_assembler() → ZBarrierSetAssembler
      
      第二次虚分派（BarrierSetAssembler::barrier_stubs_init()）：
        默认实现（barrierSetAssembler_x86.hpp:81）: virtual void barrier_stubs_init() {} — 空
        G1BarrierSetAssembler 重写 → 生成 SATB 预写屏障 + 后写屏障汇编 stub
        ShenandoahBarrierSetAssembler 重写 → 生成 Brooks 指针屏障 stub
      
      追问: 为什么用虚函数分派而非 #ifdef 条件编译？
      → #ifdef 在编译时选择 GC —— 一次只能编译一种 GC（INCLUDE_G1GC 等是编译期常量）。
        虚函数分派允许运行时选择（JVM 启动时通过 -XX:+UseG1GC 等选择 GC 实现），
        同一份 libjvm.so 可以支持所有 GC。但当前 OpenJDK 11 仍然是编译期选择 GC
        （INCLUDE_ALL_GCS 默认=1），所以这里虚分派更多是架构模式而非运行时多态。

  ② Counterfactual: 如果 gc_barrier_stubs_init() 在 universe_init 之前调用？
      答案方向: universe_init() 创建 G1CollectedHeap → G1CollectedHeap 构造函数设置
      BarrierSet::_barrier_set = new G1BarrierSet()。如果 gc_barrier_stubs_init 在
      universe_init 之前 → BarrierSet::barrier_set() 返回 NULL → 
      bs->barrier_set_assembler() → SIGSEGV on null pointer dereference。
      init_globals 中的调用顺序（universe_init 在 :137，gc_barrier_stubs_init 在 :144）
      确保了 GC 屏障集在 barrier stub 生成之前已初始化。
```

### 4.7 ★★★ Universe::reinitialize_vtable_of() + initialize_known_methods()

```
问题：
  ① universe_post_init() 为什么需要重新初始化 vtable 和 itable？
      答案方向: Universe::genesis() 创建 Klass 时，许多方法尚未加载（类加载发生在 genesis
      之后的 resolve_well_known_classes 中）。vtable 在 Klass 创建时初始化为空 Method* 槽位。
      reinitialize_vtable_of() (universe.cpp:574-590) 递归遍历所有类：
        ko->vtable().initialize_vtable(false, CHECK);  // 填充 Method* 指针
        for (Klass* sk = ko->subklass(); sk != NULL; sk = sk->next_sibling())
          reinitialize_vtable_of(sk, CHECK);            // 递归处理子类
      
      reinitialize_itables() (universe.cpp:592-596):
        ClassLoaderDataGraph::dictionary_classes_do(initialize_itable_for_klass, CHECK);
        // 遍历所有已加载类，为每个类初始化接口方法表
      
      CDS 模式（UseSharedSpaces=true）跳过——vtables 从归档直接恢复。
      
      追问: initialize_known_methods() 缓存了哪些方法？
      → universe.cpp:1184-1218 缓存 6 个常用方法到 LatestMethodCache:
        _finalizer_register_cache       → Finalizer.register(Object)
        _throw_illegal_access_error_cache → Unsafe.throwIllegalAccessError()
        _throw_no_such_method_error_cache → Unsafe.throwNoSuchMethodError()
        _loader_addClass_cache          → ClassLoader.addClass(Class)
        _pd_implies_cache               → ProtectionDomain.impliesCreateAccessControlContext()
        _do_stack_walk_cache            → AbstractStackWalker.doStackWalk(...)
      
      这些方法是 JVM 内部高频调用路径（finalizer 注册、安全检查、栈遍历），
      缓存 Method* 避免每次通过 SystemDictionary::find_method() 查找。

  ② Counterfactual: 如果 vtable 不重新初始化？
      答案方向: 虚方法调用会走到错误的 Method* 或 NULL → 第一个虚方法调用（通常是
      Object.finalize() 或 toString()）触发 SIGSEGV → JVM crash。
      CDS 归档保存了正确的 vtable，所以可以跳过重新初始化。非 CDS 路径必须执行。
```

### 4.8 ★★★ 预分配异常对象的消费者链路

```
问题：
  ① 预分配的 OOM 对象在运行时被谁消费？
      答案方向: 消费路径表：
        _out_of_memory_error_java_heap:
          → MemAllocator::check_out_of_memory() (memAllocator.cpp:116)
          → Allocation::~Allocation() (memAllocator.cpp:83)
          场景: TLAB 分配失败 + 全局堆分配失败
        
        _out_of_memory_error_metaspace:
          → report_metadata_oome() (metaspace.cpp:1575)
          场景: Metaspace VirtualSpaceNode commit 失败
        
        _out_of_memory_error_array_size:
          → arrayKlass::allocate_arrayArray() (arrayKlass.cpp:133)
          → InstanceKlass::allocate_objArray() (instanceKlass.cpp:1247)
          场景: new T[length] where length > max_array_length
        
        _out_of_memory_error_gc_overhead_limit:
          → MemAllocator::check_out_of_memory() (memAllocator.cpp:116)
          场景: GC 时间占比超过 GCTimeLimit
        
        _out_of_memory_error_realloc_objects:
          → Deoptimization::realloc_objects() (deoptimization.cpp:812)
          场景: 去优化时在堆上重新分配标量替换的对象失败
        
        _null_ptr_exception_instance:
          → JIT 编译器生成的 null check 失败路径（C1/C2 直接引用预分配 oop）
        
        _arithmetic_exception_instance:
          → JIT 编译器的除零检查失败路径（"/ by zero"）
      
      追问: 为什么 NPE 和 ArithmeticException 也是预分配的？
      → 这两个异常在 JIT 编译代码中的抛出频率极高（每次 null check / divide）。
        预分配避免异常路径上的对象分配 → 异常路径不需要 GC 安全点 → 
        JIT 可以生成更紧凑的异常处理代码（直接加载常量 oop 而非调用运行时分配函数）。

  ② Counterfactual: 如果 NPE 不在 universe_post_init 中预分配而是 JIT 每次 new？
      答案方向: JIT 编译的 null check 失败路径需要: (1) 进入 runtime (2) new NPE (3) GC 
      safepoint check (4) 返回。预分配 oop 的路径: (1) 进入 runtime (2) 返回预分配 oop。
      节省 ~200ns per NPE。对于高频 NPE 场景（如 Optional.orElseThrow 风格代码），
      这个差异累积显著。但预分配 oop 的 tradeoff: 所有 NPE 实例共享同一个对象——
      getStackTrace() 返回空（无实际发生位置的栈信息），因为预分配时还没有调用栈。
```

---

## §五 Article Structure

```
§〇 生产场景
  ★ 场景 1: Metaspace OOM 时 JVM 能抛出异常而不崩溃（预分配机制）
  ★ 场景 2: new int[Integer.MAX_VALUE] 的 ArrayStoreException vs OOM
  ★ 场景 3: JIT 编译的 x/0 抛出 ArithmeticException 不分配新对象
  每个场景: 真实错误消息 + 三步诊断 + 反事实讨论

§一 ★★★ Universe Post-Init 5 调用全链路源码走读
  ❓ 这不是 Java 类型系统教程 — 这是 JVM 如何创建 8 种数组 Klass + 预分配 10 个异常 + 计算 29 个类偏移
  1.1 gc_barrier_stubs_init() — 双重虚函数分派到 GC 特定 BarrierSetAssembler
  1.2 universe2_init() → Universe::genesis() — 8 TypeArrayKlass + SystemDictionary + null sentinel
  1.3 Genesis 阶段 A: allocate_fixup_lists + compute_base_vtable_size
  1.4 Genesis 阶段 B: vmSymbols::initialize() + SystemDictionary::initialize()
  1.5 Genesis 阶段 C: 空数组 + 字符串常量 + _the_null_sentinel
  1.6 Genesis 阶段 D: _objectArrayKlassObj + _fullgc_alot_dummy_array
  1.7 javaClasses_init() → JavaClasses::compute_offsets() — 29 类偏移量宏展开
  1.8 referenceProcessor_init() → init_statics() — 软引用时钟 + LRU 策略
  1.9 universe_post_init() — 10 个预分配异常 + vtable 重初始化 + known methods
  1.10 ★ Mermaid: Universe Post-Init 序列图
      Lanes: init_globals / BarrierSet / Universe::genesis / SystemDictionary / JavaClasses / ReferenceProcessor
  1.11 ★ 面试 Story Format 答案

§二 Standard Environment + 全局状态表

§三 Source Files Table（12 个文件）

§四 ★★★ 7 Beginner Callout 框
  4.1 TypeArrayKlass vs ObjArrayKlass
  4.2 预分配异常的 O(1) 设计
  4.3 BASIC_JAVA_CLASSES_DO_PART2 宏
  4.4 SystemDictionary 的五张哈希表
  4.5 SoftReference 时钟同步
  4.6 vtable 和 itable 的重初始化
  4.7 GC Barrier Stubs 的虚函数分派

§五 ★★★ 8 种数组 Klass 创建 + 异常预分配机制
  ❓ TypeArrayKlass::create_klass 的完整创建流程
  ❓ 预分配 OOM 的消费者链路表
  5.1 TypeArrayKlass 创建三步（Symbol → allocate → add_class）
  5.2 预分配异常对象清单（10 个 oop + 消息 + backtrace）
  5.3 OOM 预分配数组的消费-递减机制
  5.4 NPE/ArithmeticException 的 JIT 直接引用路径

§六 ★★★ 29 个类偏移量 + SystemDictionary 哈希表
  6.1 BASIC_JAVA_CLASSES_DO_PART2 宏展开表（29 个类 × 关键字段）
  6.2 compute_offsets 的 find_field 实现模式
  6.3 SystemDictionary 5 张哈希表的用途和碰撞策略
  6.4 resolve_well_known_classes 的 WK_KLASS 枚举

§七 ★★ 条件分支 + 内存开销
  7.1 Server vs Client 的 ReferencePolicy 分支
  7.2 UseSharedSpaces 的 CDS 跳过分
  7.3 ZERO 解释器构建的 barrier stub 跳过
  7.4 StackReservedPages 的延迟 SOE 消息
  7.5 ASSERT only 的 FullGCALot dummy 数组
  7.6 总内存开销估算（Klass 对象 + 异常 oop + 哈希表 + 偏移量表）

§八 ★ GDB 断点验证 — 8 断点
  断言 1: universe.cpp:336 — 验证第一个 TypeArrayKlass (boolArrayKlassObj) 创建
  断言 2: universe.cpp:370 — 验证 _the_null_string = intern("null")
  断言 3: systemDictionary.cpp:1939 — 验证 PlaceholderTable 创建
  断言 4: referenceProcessor.cpp:54 — 验证 soft_ref_timestamp_clock 设置
  断言 5: javaClasses.cpp:4493 — 验证 BASIC_JAVA_CLASSES_DO_PART2 宏入口
  断言 6: universe.cpp:1251 — 验证第一个 OOM 预分配 (java_heap)
  断言 7: universe.cpp:1272 — 验证 _arithmetic_exception_instance 预分配
  断言 8: universe.cpp:1331 — 验证 heap()->post_initialize()

§九 ★ Cross-Reference
  ❓ 03-Metaspace — genesis 的类加载触发 Metaspace 首次分配
  ❓ 04-SymbolTable — TypeArrayKlass::create_klass 创建永久符号
  ❓ 05-StringTable — genesis 中 StringTable::intern("null")
  ❓ 11-Stages5-10 — init_globals 在 JVM 启动序列中的位置
  ❓ 02-G1-Heap — heap()->post_initialize() 的 G1 实现

§十 诊断工具
  ❓ jcmd <pid> GC.class_histogram — 验证预分配 OOM 对象数量
  ❓ jcmd <pid> VM.system_properties — 验证 SoftReference 时钟
  ❓ GDB: print Universe::_preallocated_out_of_memory_error_avail_count — 验证可用计数
  ❓ strace -e clock_gettime — 验证 CLOCK_MONOTONIC 调用
  ❓ /proc/<pid>/maps — 验证 Metaspace 映射

§十一 边缘场景
  ❓ CDS 归档恢复 vs 重新初始化 vtable
  ❓ 预分配 OOM 数组耗尽（avail_count=0）的回退
  ❓ ZERO 构建跳过 barrier stub
  ❓ FullGCALot 的 ASSERT only dummy 数组
```

---

## §六 Writing Requirements

### 必须遵循的写作原则

1. **Every paragraph opens with WHY** — "Because JVM needs to throw OutOfMemoryError when Metaspace is already exhausted, universe_post_init() pre-allocates 7 OOM instances..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C++ code from universe.cpp / javaClasses.cpp / systemDictionary.cpp / referenceProcessor.cpp / barrierSet.cpp, do not describe it.

3. **Mermaid sequence diagram** — Universe Post-Init initialization sequence. 6 lanes: init_globals / BarrierSet / Universe::genesis / SystemDictionary / JavaClasses / ReferenceProcessor. Complete flow: `gc_barrier_stubs_init()` → `universe2_init()` → `Universe::genesis()` (8 TypeArrayKlass → SystemDictionary → null sentinel → Object[] Klass) → `javaClasses_init()` (29 compute_offsets) → `referenceProcessor_init()` (clock + policy) → `universe_post_init()` (10 exceptions + vtable + known methods). Annotate every step with file:line.

4. **GDB session** — 8 breakpoints with exact file:line numbers (see §五). Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一.

6. **"不要写成→应该写成"对照表**：

| 不要写成 | 应该写成 |
|---------|---------|
| "universe2_init() 创建基本类型数组 Klass" | "Universe::genesis() at universe.cpp:323 通过 TypeArrayKlass::create_klass(T_BOOLEAN, sizeof(jboolean)) 等 8 次调用创建 boolean[] 到 long[] 的 Klass——每个调用在 typeArrayKlass.cpp:58 中通过 SymbolTable::new_permanent_symbol() 创建永久符号，在 null ClassLoaderData 中 allocate Klass，再 add_class 注册为 GC 强根" |
| "universe_post_init() 预分配异常对象" | "universe_post_init() at universe.cpp:1251-1257 通过 InstanceKlass::allocate_instance() 预分配 7 个 OutOfMemoryError 实例——每个设置不同的 detailMessage（"Java heap space" / "Metaspace" / "Compressed class space" 等），存储在 Universe 的静态 oop 中。此外还创建 _preallocated_out_of_memory_error_array (objArrayOop[PreallocatedOutOfMemoryErrorCount]) 含预填充 backtrace 的高频 OOM 缓冲" |
| "javaClasses_init() 计算类字段偏移量" | "JavaClasses::compute_offsets() at javaClasses.cpp:4478 通过 BASIC_JAVA_CLASSES_DO_PART2(DO_COMPUTE_OFFSETS) 宏展开为 29 个类的 k::compute_offsets() 调用——每个通过 InstanceKlass::find_field(name, sig) 按名称查找字段并存储字节偏移量到静态成员（如 java_lang_Thread::_eetop_offset）" |
| "SystemDictionary::initialize() 创建哈希表" | "SystemDictionary::initialize() at systemDictionary.cpp:1937 创建 5 张 C_HEAP 分配的哈希表——_placeholders (PlaceholderTable, 防重复加载), _loader_constraints (LoaderConstraintTable, 跨类加载器类型安全), _resolution_errors (ResolutionErrorTable, 缓存失败), _invoke_method_table (SymbolPropertyTable, invokedynamic), _pd_cache_table (ProtectionDomainCacheTable, 保护域)——加上 _system_loader_lock_obj = oopFactory::new_intArray(0) 作为 12 字节锁对象" |
| "referenceProcessor_init() 初始化软引用策略" | "ReferenceProcessor::init_statics() at referenceProcessor.cpp:51 通过 os::javaTimeNanos()/NANOSECS_PER_MILLISEC 获取单调毫秒时钟（非 wall clock，避免 NTP 回退），写入 _soft_ref_timestamp_clock 并同步到 java_lang_ref_SoftReference::set_clock() 直接写入 SoftReference.clock 静态字段。然后根据 is_server_compilation_mode_vm() 选择 LRUMaxHeapPolicy (Server) 或 LRUCurrentHeapPolicy (Client)" |
| "gc_barrier_stubs_init() 生成 GC 屏障代码" | "gc_barrier_stubs_init() at barrierSet.cpp:49 通过双重虚函数分派——BarrierSet::barrier_set_assembler() → BarrierSetAssembler::barrier_stubs_init()——将调用路由到当前 GC 的汇编 stub 生成器（G1 生成 SATB 预写屏障，Shenandoah 生成 Brooks 指针屏障）。#ifndef ZERO 跳过零汇编解释器构建" |
| "vtable 需要重新初始化" | "universe_post_init() at universe.cpp:1239 调用 Universe::reinitialize_vtable_of() 递归遍历所有已加载类的继承树——ko->vtable().initialize_vtable(false) 填充 Method* 指针——因为 genesis 创建 Klass 时方法尚未加载，vtable 槽位为空。CDS 模式 (UseSharedSpaces=true) 跳过——vtables 从归档恢复" |

7. **Cross-reference at five points**:
   - At TypeArrayKlass::create_klass → "→ 04-SymbolTable for permanent symbol creation"
   - At StringTable::intern("null") → "→ 05-StringTable for intern mechanism"
   - At SystemDictionary::initialize → "→ 03-Metaspace for class metadata allocation"
   - At report_metadata_oome() → "→ 03-Metaspace for OOM consumer in Metaspace::allocate"
   - At heap()->post_initialize() → "→ 02-G1-Heap for G1 post-initialization"

8. **预分配异常消费者表** — 必须列出每个预分配 oop 的运行时消费者（函数 + file:line + 触发场景）。

9. **BASIC_JAVA_CLASSES_DO_PART2 展开表** — 29 个类的完整列表（类名 + 关键计算字段）。

10. **SystemDictionary 5 表对比** — 表名、类型、用途、碰撞策略、初始大小。

---

## §七 Output Format

- Markdown file, named `16-Universe-Post-Init.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/`
- 元信息头:

```
> **Phase**: 01-jvm-startup
> **前置**: [03-Metaspace]（元空间分配）、[04-SymbolTable]（永久符号创建）、[05-StringTable]（intern 机制）、[02-G1-Heap]（heap post_initialize）
> **配套**: [00-JNI-CreateJavaVM]（init_globals 在 create_vm 中的位置）
> **后续依赖本文**: [11-Stages5-10]（Stage 6 类加载使用本文创建的 Klass + 偏移量）
> **阅读收益**: 追踪 Universe 初始化的下半场 5 个调用——理解 TypeArrayKlass::create_klass 的 8 种基本类型数组创建、Universe::genesis 的 SystemDictionary 初始化、BASIC_JAVA_CLASSES_DO_PART2 宏展开的 29 个核心类偏移量计算、预分配 10 个异常对象（7 OOM + NPE + ArithmeticException + VME）的 O(1) 生存设计、ReferenceProcessor 的 Server/Client 双 LRU 策略、GC 屏障 stub 的虚函数分派机制；掌握 "Metaspace OOM 时如何抛出异常而不崩溃" 的预分配诊断路径
```

- 目标行数: 900-1100 lines
- Section 编号: `## §〇` 到 `## §十一`（连续无跳号）

---

## §八 Prohibited（≥8）

- ❌ 只说 "universe2_init 创建数组 Klass" 而不展示 TypeArrayKlass::create_klass 的三步流程 — 必须从 typeArrayKlass.cpp:58 源码开始
- ❌ 不展示 BASIC_JAVA_CLASSES_DO_PART2 宏的展开 — 必须列出 29 个类名和对应的关键字段
- ❌ 忽略预分配异常的消费者链路 — 必须展示每个预分配 oop 的运行时消费者（函数 + file:line + 触发场景）
- ❌ 不解释 vtable 为什么需要重初始化 — 必须展示 genesis 时方法未加载 → vtable 空槽位 → reinitialize 填充 Method* 的因果关系
- ❌ 忽略 SoftReference 时钟的单调性要求 — 必须展示 javaTimeNanos vs javaTimeMillis 的差异和 NTP 回退问题
- ❌ 不展示 SystemDictionary 的 5 张哈希表 — 必须列出每张表的类型、用途和初始大小
- ❌ 不解释 gc_barrier_stubs_init 的双重虚函数分派 — 必须展示 BarrierSet → BarrierSetAssembler 的分派链
- ❌ 不做 GDB 断点 trace — 至少 8 个断点覆盖 genesis → compute_offsets → post_init
- ❌ 忽略 CDS 路径的差异 — 必须展示 UseSharedSpaces 时的跳过分（compute_offsets 跳过、vtable 跳过）
- ❌ 不要解释 Java 异常类型体系（这是 JVM 文档，不是 Java 教程）

---

## §九 Required（≥8）

- ✅ **★ Mermaid Universe Post-Init 序列图** — 6 lanes: init_globals / BarrierSet / Universe::genesis / SystemDictionary / JavaClasses / ReferenceProcessor
- ✅ **★ Universe::genesis() 完整源码走读** — 142 行，4 阶段（A: fixup+vtable, B: 引导, C: 字符串, D: 后引导）
- ✅ **★ universe_post_init() 完整源码走读** — 111 行，8 阶段（解释器→vtable→OOM→NPE→Arith→VME→OOM数组→收尾）
- ✅ **★ 预分配异常消费者链路表** — 每个预分配 oop → 运行时消费者 (file:line + 场景)
- ✅ **★ BASIC_JAVA_CLASSES_DO_PART2 展开表** — 29 个类 + 关键字段
- ✅ **★ SystemDictionary 5 表对比** — 类型/用途/碰撞策略/初始大小
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ "不要写成→应该写成"对照表** — §六 中至少 7 行对照
- ✅ **★ 交叉引用** — 03-Metaspace / 04-SymbolTable / 05-StringTable / 02-G1-Heap / 11-Stages5-10
- ✅ **★ 总内存开销估算** — Klass 对象 + 异常 oop + 哈希表 + 偏移量表

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: TypeArrayKlass 创建 (universe.cpp:336)
  (gdb) break universe.cpp:336
  (gdb) run
  (gdb) continue → 进入 TypeArrayKlass::create_klass(T_BOOLEAN, 1)
  (gdb) finish
  (gdb) print Universe::_boolArrayKlassObj → 期望: 非 NULL Klass*

断言 2: _the_null_string = intern("null") (universe.cpp:370)
  (gdb) break universe.cpp:370
  (gdb) continue
  (gdb) print Universe::_the_null_string → 期望: 非 NULL oop (Java String "null")

断言 3: SystemDictionary::initialize — PlaceholderTable (systemDictionary.cpp:1939)
  (gdb) break systemDictionary.cpp:1939
  (gdb) print _placeholder_table_size → 期望: 默认值 (通常 1009)
  (gdb) continue
  (gdb) print SystemDictionary::_placeholders → 期望: 非 NULL PlaceholderTable*

断言 4: SoftReference 时钟设置 (referenceProcessor.cpp:54)
  (gdb) break referenceProcessor.cpp:54
  (gdb) print now → 期望: 正整数（毫秒时间戳）
  (gdb) continue
  (gdb) print ReferenceProcessor::_soft_ref_timestamp_clock → 期望: = now

断言 5: javaClasses compute_offsets 入口 (javaClasses.cpp:4493)
  (gdb) break javaClasses.cpp:4493
  (gdb) print UseSharedSpaces → 期望: false (非 CDS)
  (gdb) continue → 进入第一个 compute_offsets (java_lang_System)

断言 6: 第一个 OOM 预分配 (universe.cpp:1251)
  (gdb) break universe.cpp:1251
  (gdb) continue
  (gdb) print Universe::_out_of_memory_error_java_heap → 期望: 非 NULL oop
  (gdb) print java_lang_Throwable::message(Universe::_out_of_memory_error_java_heap) → 期望: "Java heap space"

断言 7: ArithmeticException 预分配 (universe.cpp:1272)
  (gdb) break universe.cpp:1272
  (gdb) continue
  (gdb) print Universe::_arithmetic_exception_instance → 期望: 非 NULL oop
  (gdb) print java_lang_Throwable::message(Universe::_arithmetic_exception_instance) → 期望: "/ by zero"

断言 8: heap()->post_initialize() (universe.cpp:1331)
  (gdb) break universe.cpp:1331
  (gdb) continue
  (gdb) print Universe::heap()->kind() → 期望: CollectedHeap::G1 (或其他 GC 类型)
  (gdb) continue → 进入 G1CollectedHeap::post_initialize()
```

---

## §十一 与 README 和同组文档的连续性

1. **从 README §init_globals 调用清单承接**：本文展开 init_globals 的第 10、18、19、20、28 次调用（gc_barrier_stubs_init, universe2_init, javaClasses_init, referenceProcessor_init, universe_post_init）——从 GC 屏障到预分配异常的完整代码级解答。

2. **与 03-Metaspace 的连接**：Universe::genesis() 通过 SystemDictionary::initialize() 触发类加载，首次使用 Metaspace 分配 Klass 元数据。universe_post_init() 调用 Metaspace::post_initialize() 完成元空间初始化，设置 commit 限制。

3. **与 04-SymbolTable 的连接**：TypeArrayKlass::create_klass() 调用 SymbolTable::new_permanent_symbol() 创建永久符号（[Z, [C, [F...），这些符号不会被 GC 回收。

4. **与 05-StringTable 的连接**：Universe::genesis() 调用 StringTable::intern("null") 和 intern("-2147483648") 创建 Java 字符串常量，存储在 Universe 的静态 oop 中。

5. **与 02-G1-Heap 的连接**：universe_post_init() 调用 Universe::heap()->post_initialize()——在 G1 下，这触发 G1CollectedHeap::post_initialize()，初始化引用处理器和 SATB 队列。

6. **与 11-Stages5-10 的连接**：本文覆盖的 5 个调用在 init_globals (Stage 4) 中执行。universe_post_init 返回后，Stage 6 的 initialize_java_lang_classes() 使用本文创建的 Klass 和偏移量加载 17 个 java.lang 核心类。

7. **同组边界**：本文覆盖 Universe 初始化的下半场（genesis → post_init）；上半场（universe_init → G1 heap + Metaspace + SymbolTable + StringTable）由 02/03/04/05/08/09 文档覆盖。
