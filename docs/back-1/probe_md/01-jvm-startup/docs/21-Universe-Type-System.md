# 21-Universe-Type-System — init_globals 类型系统全链路：genesis 创世 → 偏移量计算 → 收尾

> **Phase**: 01-jvm-startup
> **覆盖 init_globals 调用**: #18 `universe2_init` + #19 `javaClasses_init` + #28 `universe_post_init`
> **前置**: [02-G1-Heap-Startup] + [03-Metaspace]（universe_init #9 创建堆和元空间基底）、[20-Compilation-Pipeline]（编译器已就绪）
> **配套**: [00-init-globals-overview]（init_globals 30 调用全景）、[04-SymbolTable] + [05-StringTable]（universe_init 子步骤）
> **阅读收益**: 以 init_globals 执行顺序为主线，完整追踪 Universe 从"创世"到"收尾"的三步初始化——§1 genesis 创建 8 种 TypeArrayKlass + SystemDictionary + 9 种基本类型 mirrors（含 fixup_mirrors 延迟修复机制）、§2 compute_offsets 计算 31 个核心类字段偏移（含 11 个此前文档未覆盖的 JSR 292/反射/NIO/断言/安全类）、§3 universe_post_init 的 vtable 重初始化 + 10 种预分配异常（完整类型+消息枚举）+ known methods 缓存。全文 24 个 Callout 标注关键设计决策

---

## §〇 Production Scenario — 类型系统出问题的 3 个典型场景

### 场景 1: JDK 版本不匹配 → compute_offsets 失败

```bash
java -Xbootclasspath:/old/jdk/rt.jar -jar app.jar
# Error: Invalid layout of well-known class → JVM 退出
```

根因：`compute_offset()` (`javaClasses.cpp:~185`) 在 InstanceKlass 中按名称+签名查找字段 → `find_local_field()` 失败 → `vm_exit_during_initialization("Invalid layout of well-known class")`。

**反事实**：如果不做偏移量验证 → JDK 版本不匹配时 JVM 使用错误的偏移量读取字段 → `java_lang_Thread::thread()` 读到错误的 JavaThread* → 线程操作访问非法内存 → SIGSEGV。

### 场景 2: GC OOM 时 JVM 无法抛出异常 → 静默崩溃

```bash
java -Xmx64m -jar memory-hungry-app.jar
# 期望: java.lang.OutOfMemoryError: Java heap space
# 实际: SIGSEGV — 预分配 OOM 异常实例耗尽
```

根因：`universe_post_init()` (`universe.cpp:1248-1318`) 预分配了 `PreallocatedOutOfMemoryErrorCount` 个带 backtrace 的 OOM 异常实例。`gen_out_of_memory_error()` (`universe.cpp:617-654`) 在 OOM 时原子递减可用计数 → 预分配池耗尽 → fallback 到 `default_err`（无 backtrace）。

**反事实**：如果不预分配 OOM 异常 → GC 在堆满时尝试 `new OutOfMemoryError()` → 堆已满，分配失败 → JVM 无法抛出异常 → 静默崩溃 → 无法诊断的"JVM hang"。

### 场景 3: VirtualMachineError 链接失败 → JVM 启动崩溃

```bash
java -jar app.jar
# Error: Unable to link/verify VirtualMachineError class → JNI_ERR
```

根因：`universe_post_init()` (`universe.cpp:1273-1284`) 的 `link_class_or_fail()` 失败 → 返回 false → `init_globals()` 返回 `JNI_ERR`。这是 `universe_post_init` **唯一的显式失败路径**——VME 不在 `WK_KLASS` 枚举中（`resolve_well_known_classes()` 未预解析），链接可能失败。

---

## §一 genesis：Universe::genesis() — 创世三部曲

> **init_globals 调用 #18** (`init.cpp:157`): `universe2_init()` → `Universe::genesis()`
> 
> **前置条件**: universe_init (#9) 已创建 G1CollectedHeap + Metaspace + SymbolTable + StringTable

### 1.1 入口：universe2_init()

```cpp
// src/hotspot/share/memory/universe.cpp:1220-1223
void universe2_init() {
  EXCEPTION_MARK;
  Universe::genesis(CATCH);  // genesis 可能通过 CHECK 抛出 Java 异常
}
```

### 1.2 Phase 1: 持锁引导段 — 8 种 TypeArrayKlass 创建

```cpp
// src/hotspot/share/memory/universe.cpp:323-397
void Universe::genesis(TRAPS) {
  { FlagSetting fs(_bootstrapping, true);  // 标记引导中
    { MutexLocker mc(Compile_lock);        // ★ 保护 vtable 计算
      java_lang_Class::allocate_fixup_lists();    // mirror 修复列表
      compute_base_vtable_size();                 // 计算 Object 的 vtable 大小
    }
    
    if (!UseSharedSpaces) {  // ★ CDS 跳过：从 archive 恢复 Klass
      _boolArrayKlassObj   = TypeArrayKlass::create_klass(T_BOOLEAN, sizeof(jboolean), CHECK);
      _charArrayKlassObj   = TypeArrayKlass::create_klass(T_CHAR,    sizeof(jchar),    CHECK);
      _singleArrayKlassObj = TypeArrayKlass::create_klass(T_FLOAT,   sizeof(jfloat),   CHECK);
      _doubleArrayKlassObj = TypeArrayKlass::create_klass(T_DOUBLE,  sizeof(jdouble),  CHECK);
      _byteArrayKlassObj   = TypeArrayKlass::create_klass(T_BYTE,    sizeof(jbyte),    CHECK);
      _shortArrayKlassObj  = TypeArrayKlass::create_klass(T_SHORT,   sizeof(jshort),   CHECK);
      _intArrayKlassObj    = TypeArrayKlass::create_klass(T_INT,     sizeof(jint),     CHECK);
      _longArrayKlassObj   = TypeArrayKlass::create_klass(T_LONG,    sizeof(jlong),    CHECK);
      
      // 填充 type→Klass O(1) 查找表 (universe.cpp:345-352)
      _typeArrayKlassObjs[T_BOOLEAN] = _boolArrayKlassObj;
      _typeArrayKlassObjs[T_CHAR]    = _charArrayKlassObj;
      _typeArrayKlassObjs[T_FLOAT]   = _singleArrayKlassObj;
      _typeArrayKlassObjs[T_DOUBLE]  = _doubleArrayKlassObj;
      _typeArrayKlassObjs[T_BYTE]    = _byteArrayKlassObj;
      _typeArrayKlassObjs[T_SHORT]   = _shortArrayKlassObj;
      _typeArrayKlassObjs[T_INT]     = _intArrayKlassObj;
      _typeArrayKlassObjs[T_LONG]    = _longArrayKlassObj;
      
      // 创建 5 个空元数据数组（避免后续重复分配）(universe.cpp:354-360)
      _the_array_interfaces_array = MetadataFactory::new_array<Klass*>(null_cld, 2, NULL, CHECK);
      _the_empty_int_array        = MetadataFactory::new_array<int>(null_cld, 0, CHECK);
      _the_empty_short_array      = MetadataFactory::new_array<u2>(null_cld, 0, CHECK);
      _the_empty_method_array     = MetadataFactory::new_array<Method*>(null_cld, 0, CHECK);
      _the_empty_klass_array      = MetadataFactory::new_array<Klass*>(null_cld, 0, CHECK);
    }
  }
```

> **Callout 1: genesis 为什么需要 Compile_lock？**  
> `compute_base_vtable_size()` 计算 `java.lang.Object` 的虚函数表大小——这是所有 Klass 继承树的根。vtable 大小计算涉及 C1/C2 编译器生成代码时使用的 `vtable_index`。`Compile_lock` 确保在计算期间没有编译器线程并发读取未初始化的 vtable 索引。

### 1.3 TypeArrayKlass::create_klass() — 三步工厂方法

```cpp
// src/hotspot/share/oops/typeArrayKlass.cpp:58-79
TypeArrayKlass* TypeArrayKlass::create_klass(BasicType type, int scale, TRAPS) {
  Symbol* sym = SymbolTable::new_permanent_symbol(signature_for(type), CHECK_NULL);
  ClassLoaderData* null_cld = ClassLoaderData::the_null_class_loader_data();
  // ★ 第 1 步: 在 null_cld 的 Metaspace 中分配 Klass 内存
  TypeArrayKlass* ak = TypeArrayKlass::allocate(null_cld, type, sym, CHECK_NULL);
  // ★ 第 2 步: 加入 CLD 类链表 — 注册为 GC roots 可遍历对象
  null_cld->add_class(ak);
  // ★ 第 3 步: 完成类设置 — super、interfaces、access_flags
  complete_create_array_klass(ak, ak->super(), javabase_moduleEntry, CHECK_NULL);
  return ak;
}
```

**三步详解**：

| 步骤 | 操作 | 内部关键动作 | 失败处理 |
|------|------|-------------|---------|
| **allocate()** | 在 Metaspace 中分配 Klass | `Metaspace::allocate()` → 写 `_layout_helper`、`_max_length` | 返回 NULL → CHECK_NULL 展开为 `vm_exit_during_initialization()` |
| **add_class()** | 注册到 CLD 类链表 | `CLD::_klasses = ak; ak->_next_link = prev_head` → **头插法**入链 | 无失败（简单指针操作） |
| **complete()** | 设置父类和接口 | 设置 `ak->_super = Object`、实现 Cloneable+Serializable、设置 `_access_flags` | 依赖 Object Klass 已加载 |

**TypeArrayKlass 构造函数** (`typeArrayKlass.cpp:90-99`)：
```cpp
TypeArrayKlass::TypeArrayKlass(BasicType type, Symbol* name) {
  set_layout_helper(array_layout_helper(type));  // 编码 header_size + element_size + type_tag
  set_max_length(arrayOopDesc::max_array_length(type));  // (max_jint - header) / element_size
}
```

### 1.4 layout_helper 编码格式 — 快速类型判定

```
layout_helper 32-bit 编码:
┌──────────────────────────────────────────────────────┐
│ [0-7]:    _lh_element_type_tag   元素类型标记          │
│ [8-15]:   _lh_header_size_shift  header 大小 (words)  │
│ [16-23]:  _lh_log2_element_size  log2(元素字节大小)    │
│ [24-31]:  _lh_array_tag_vt       数组类型 vtable 标记  │
└──────────────────────────────────────────────────────┘
```

| 数组类型 | 元素大小 | log2 | layout_helper (hex) |
|---------|---------|------|---------------------|
| boolean[] | 1B | 0 | 0x00000001 |
| byte[] | 1B | 0 | 0x00000002 |
| char[] | 2B | 1 | 0x00000103 |
| short[] | 2B | 1 | 0x00000104 |
| int[] | 4B | 2 | 0x00000205 |
| float[] | 4B | 2 | 0x00000206 |
| long[] | 8B | 3 | 0x00000307 |
| double[] | 8B | 3 | 0x00000308 |

`layout_helper` 允许 `arrayOopDesc::header_size()` / `element_size()` 通过位掩码操作在 **单个 CPU 指令**内完成——没有虚函数调用，没有分支预测失败。这是类型判定热路径的关键优化。

> **Callout 2: 为什么需要 8 个独立 TypeArrayKlass 实例？**  
> 每种基本类型数组有不同的元素大小（jboolean=1B, jchar=2B, jint=4B, jlong=8B）→ 不同的 `layout_helper`（编码了 header_size + element_size + type_tag）→ 不同的 `max_length`（受元素大小和最大堆大小限制）。8 个独立 Klass 让 `arrayOopDesc::array_klass()` 可以通过 BasicType 做 O(1) 查找——`_typeArrayKlassObjs[T_INT]` 直接返回 `int[]` 的 Klass。
> 
> **反事实**：如果用一个统一 Klass + 运行时类型字段替代 → 每次数组访问需要一次额外内存加载获取元素大小 → `iaload`/`iastore` 热路径性能退化 10-15%（字节码解释器中几乎每次数组操作都受影响）。

### 1.5 initialize_basic_type_klass() — 类层次链接

```cpp
// src/hotspot/share/memory/universe.cpp:308-321
void Universe::initialize_basic_type_klass(Klass* k, TRAPS) {
  Klass* ok = SystemDictionary::Object_klass();
  if (UseSharedSpaces) {
    k->restore_unshareable_info(loader_data, Handle(), CHECK);  // CDS 恢复
  } else {
    k->initialize_supers(ok, NULL, CHECK);  // 设置 _super = Object
  }
  k->append_to_sibling_list();  // 追加到 Object 的子类链表（GC 遍历）
}
```

### 1.6 Phase 2: SystemDictionary 初始化 — 加载核心系统类

```cpp
// src/hotspot/share/classfile/systemDictionary.cpp:1937-1949
void SystemDictionary::initialize(TRAPS) {
  _placeholders       = new PlaceholderTable(1009);      // 类加载占位符
  _loader_constraints = new LoaderConstraintTable(107);  // 加载器约束
  _resolution_errors  = new ResolutionErrorTable(107);   // 解析错误缓存
  _invoke_method_table = new SymbolPropertyTable(107);   // invokedynamic 缓存
  _pd_cache_table     = new ProtectionDomainCacheTable(2011);  // 保护域缓存
  _system_loader_lock_obj = oopFactory::new_intArray(0, CHECK);  // 锁对象
  resolve_well_known_classes(CHECK);  // ★ 加载所有 WKID 类
}
```

`resolve_well_known_classes()` (`systemDictionary.cpp:2020-2102`) 的加载顺序：
1. `classLoader_init2()` → 创建 java.base 的 ModuleEntry
2. Object → String → Class（CDS 时从 archive 恢复）
3. `java_lang_String::compute_offsets()` + `java_lang_Class::compute_offsets()` — 立即计算偏移量（后续步骤需要）
4. `initialize_basic_type_mirrors(CHECK)` — 创建 int/float/double/... 的 java.lang.Class 镜像
5. `fixup_mirrors(CHECK)` — 修复先于 Class 加载创建的 Klass 的 mirror
6. Reference 体系（Reference/Soft/Weak/Final/PhantomReference）
7. JSR 292 类（MethodHandle → VolatileCallSite）
8. 填充 `_box_klasses[]` — 8 种装箱类型 Klass 索引表

**8 步加载顺序详解**（`systemDictionary.cpp:2020-2102`）：

| 步骤 | 加载操作 | SystemDictionary 变量 | 后续依赖 |
|------|---------|----------------------|---------|
| 1 | `classLoader_init2(THREAD)` | `_java_system_loader` (System ClassLoader) | 创建 java.base ModuleEntry，初始化 `ClassLoaderData::_the_null_class_loader_data` |
| 2a | 加载 `java.lang.Object` | `WK_KLASS(Object_klass)` | 所有类的根——必须先加载，vtable 大小依赖 Object |
| 2b | 加载 `java.lang.String` | `WK_KLASS(String_klass)` | genesis 中 `_the_null_string`、`_the_min_jint_string` 依赖 String |
| 2c | 加载 `java.lang.Class` | `WK_KLASS(Class_klass)` | mirror 系统的基础——之后才能创建 mirrors |
| 3a | `java_lang_String::compute_offsets()` | — | 立即计算 value/hash/coder 偏移——步骤 2b 加载了 String 但未计算偏移 |
| 3b | `java_lang_Class::compute_offsets()` | — | 立即计算 klass/array_klass/oop_size 等偏移——mirror 创建需要 |
| 4 | `initialize_basic_type_mirrors(CHECK)` | `_mirrors[9 types]` | 创建 int/float/double/byte/boolean/char/long/short/void 的 Class 对象 |
| 5 | `fixup_mirrors(CHECK)` | `_fixup_mirror_list` → 遍历修复 | 解决时序问题：步骤 2c 之前创建的 Klass 需要 mirrors |
| 6a | `Reference` → `SoftReference` → `WeakReference` → `FinalReference` → `Finalizer` → `PhantomReference` | `WK_KLASS(Reference_klass)` 等 | GC 引用处理基础——GC 必须等到此步骤后 |
| 6b | `java.lang.ref.Finalizer` 特殊处理 | `InstanceKlass::initialize()` → `registerNatives()` | 注册 Finalizer 本地方法——§3.4 的 known methods 缓存在此之前 |
| 7a | `MethodHandle` → `DirectMethodHandle` | `WK_KLASS(MethodHandle_klass)` | JSR 292 基础 |
| 7b | `MemberName` → `ResolvedMethodName` → `LambdaForm` → `MethodType` | WK_KLASS 对应项 | invokedynamic 链接链 |
| 7c | `MethodHandleNatives` → `CallSite` → `ConstantCallSite` → `MutableCallSite` → `VolatileCallSite` | WK_KLASS 对应项 | dynamic call site 支持 |
| 8 | `_box_klasses[8]` = {Boolean, Character, Float, Double, Byte, Short, Integer, Long} | `_box_klasses[]` 索引表 | auto-boxing 支持——JIT 编译器需要 |

**步骤间执行顺序约束**（不可调换的原因）：
- 步骤 2a→2b→2c: Object 是所有类的父类（super），必须先加载
- 步骤 2c→3b: Class 加载后才知字段布局，才能 compute offsets
- 步骤 3b→4: Class 的 `create_basic_type_mirror()` 依赖 Class 的 InstanceKlass
- 步骤 2c→5: fixup_mirrors 需要 `Class_klass_loaded()` 为 true
- 步骤 5→1.9: Object[] Klass 创建依赖 fixup_mirrors 完成（数组 Klass 需要 mirror）

> **Callout 3b: Reference 体系为什么在 fixup_mirrors 之后加载？**  
> `java.lang.ref.Reference` 有特殊字段 `referent`、`queue`、`next`、`discovered`——这些字段在 GC 引用处理中需要运行时偏移量。Reference 类必须在 GC 扫描之前加载完毕，确保 GC 可以正确读取 Reference 子类的字段偏移。实际上 Reference 偏移量是硬编码的（`hard_coded_offsets`），在 `compute_hard_coded_offsets()` 中由 `member_offset(hc_referent_offset)` 转换——这是启动顺序的硬约束。

> **Callout 3: String 和 Class 的偏移量为什么在 genesis 中立即计算？**  
> `resolve_well_known_classes()` 加载 Object/String/Class 后，立即调用 `java_lang_String::compute_offsets()` 和 `java_lang_Class::compute_offsets()`——因为 genesis 后续步骤（创建基本类型 mirrors、fixup_mirrors、创建 Object[] Klass）立即需要这些偏移量来访问 String 和 Class 的字段。其余 29 个类的偏移量在 §2 的 `javaClasses_init()` 中计算。

### 1.7 initialize_basic_type_mirrors() — 9 种基本类型镜像创建

```cpp
// src/hotspot/share/memory/universe.cpp:466-511
void Universe::initialize_basic_type_mirrors(TRAPS) {
#if INCLUDE_CDS_JAVA_HEAP
    if (UseSharedSpaces && MetaspaceShared::open_archive_heap_region_mapped() && _int_mirror != NULL) {
      // CDS: 9 种 mirrors 已在 archive heap region 中，直接使用
      assert(_float_mirror != NULL && _double_mirror != NULL && ...);
    } else
#endif
    {
      // 新建 9 个 java.lang.Class 实例（每个代表一种基本类型）
      _int_mirror     = java_lang_Class::create_basic_type_mirror("int",    T_INT, CHECK);
      _float_mirror   = java_lang_Class::create_basic_type_mirror("float",  T_FLOAT,   CHECK);
      _double_mirror  = java_lang_Class::create_basic_type_mirror("double", T_DOUBLE,  CHECK);
      _byte_mirror    = java_lang_Class::create_basic_type_mirror("byte",   T_BYTE, CHECK);
      _bool_mirror    = java_lang_Class::create_basic_type_mirror("boolean",T_BOOLEAN, CHECK);
      _char_mirror    = java_lang_Class::create_basic_type_mirror("char",   T_CHAR, CHECK);
      _long_mirror    = java_lang_Class::create_basic_type_mirror("long",   T_LONG, CHECK);
      _short_mirror   = java_lang_Class::create_basic_type_mirror("short",  T_SHORT,   CHECK);
      _void_mirror    = java_lang_Class::create_basic_type_mirror("void",   T_VOID, CHECK);
    }
    // 填充 _mirrors[] O(1) 查找表 — 索引 = BasicType 枚举值
    _mirrors[T_INT]     = _int_mirror;
    _mirrors[T_FLOAT]   = _float_mirror;
    _mirrors[T_DOUBLE]  = _double_mirror;
    _mirrors[T_BYTE]    = _byte_mirror;
    _mirrors[T_BOOLEAN] = _bool_mirror;
    _mirrors[T_CHAR]    = _char_mirror;
    _mirrors[T_LONG]    = _long_mirror;
    _mirrors[T_SHORT]   = _short_mirror;
    _mirrors[T_VOID]    = _void_mirror;
}
```

> **Callout 4: 为什么是 9 种而不是 8 种基本类型 mirror？**  
> 除了 8 种有值类型外，`void` 也是一种 BasicType（`T_VOID`），Java 反射 API 中 `void.class` 返回 `Void.TYPE`。`_mirrors[T_VOID]` 用于表示 void 返回类型的方法签名。`_mirrors[T_OBJECT]` 和 `_mirrors[T_ARRAY]` 不使用独立 mirror——分别使用 `Object_klass()->java_mirror()`。

**create_basic_type_mirror()** 内部步骤（`javaClasses.cpp:~1580`）：
1. 获取 `java.lang.Class` 的 InstanceKlass → 分配实例
2. 创建 name string（如 `"int"`、`"float"`）
3. 通过 `java_lang_Class::set_primitive_type(mirror, type)` 设置类型标记
4. 返回 mirror oop — 此后 `int.class` 通过 `_mirrors[T_INT]` 做 O(1) 查找

### 1.8 fixup_mirrors() — 延迟镜像修复机制

```cpp
// src/hotspot/share/memory/universe.cpp:513-526
void Universe::fixup_mirrors(TRAPS) {
  // Bootstrap problem: 所有类都需要一个 mirror (java.lang.Class 实例)，
  // 但在 java.lang.Class 加载之前创建的类无法立即获得 mirror。
  // 这里遍历已创建的 Klass 对象并修复它们的 mirror。
  assert(SystemDictionary::Class_klass_loaded(), "java.lang.Class should be loaded");
  HandleMark hm(THREAD);
  if (!UseSharedSpaces) {
    InstanceMirrorKlass::init_offset_of_static_fields();  // 缓存静态字段起始偏移
  }
  // 遍历 fixup_mirror_list，为每个 Klass 创建/关联 mirror
  GrowableArray<Klass*>* list = java_lang_Class::fixup_mirror_list();
  for (int i = 0; i < list->length(); i++) {
    java_lang_Class::fixup_mirror(list->at(i), CHECK);
  }
}
```

> **Callout 5: 时序问题 — 为什么 TypeArrayKlass 的 mirror 需要延迟修复？**  
> `genesis()` 首先创建 8 种 TypeArrayKlass（此时 `java.lang.Class` 尚未加载），然后加载 Object→String→Class。每个 Klass 需要 `java_mirror()`（即 `java.lang.Class` 实例）。`allocate_fixup_lists()` 在 genesis 开头分配了一个 `GrowableArray<Klass*>`——新创建的 Klass 被加入此列表。`fixup_mirrors()` 在 Class 加载完成后遍历列表，为每个 Klass 创建正确的 mirror。
> 
> **反事实**：如果忽略 Class 加载时序，试图在 Klass 创建时立即分配 mirror → Class 未加载时 `InstanceKlass::allocate_instance()` 返回 NULL → JVM 崩溃。

### 1.9 Phase 3: 剩余创建 — Object[] Klass + null_sentinel

```cpp
// universe.cpp:399-424
Handle tns = java_lang_String::create_from_str("<null_sentinel>", CHECK);
_the_null_sentinel = tns();  // 用于 JNI 中 null 的占位符

// 创建 Object[] 的 Klass (Object 已加载，1 维数组)
_objectArrayKlassObj = InstanceKlass::cast(SystemDictionary::Object_klass())->array_klass(1, CHECK);
_objectArrayKlassObj->append_to_sibling_list();  // 加入继承树
```

**null_sentinel 用途**：当 JNI 代码返回 null 但调用者期望非 null 时，JVM 返回此哨兵字符串（内容为 `<null_sentinel>`），避免 Native Method 中的 NPE 导致 JVM crash。

---

## §二 偏移量：javaClasses_init() — 31 个核心类字段偏移计算

> **init_globals 调用 #19** (`init.cpp:161`): `javaClasses_init()`
> 
> **前置条件**: universe2_init (#18) 已创建 Klass 和加载核心系统类

### 2.1 入口：javaClasses_init()

```cpp
// src/hotspot/share/classfile/javaClasses.cpp:4597-4601
void javaClasses_init() {
  JavaClasses::compute_offsets();
  JavaClasses::check_offsets();       // PRODUCT 下为空（仅 debug 验证）
  FilteredFieldsMap::initialize();
}
```

### 2.2 compute_offsets() — 完整 31 个核心类

```cpp
// src/hotspot/share/classfile/javaClasses.cpp:4478-4497
void JavaClasses::compute_offsets() {
  if (UseSharedSpaces) return;  // ★ CDS：偏移量已从 archive 恢复
  BASIC_JAVA_CLASSES_DO_PART2(DO_COMPUTE_OFFSETS);  // 宏展开为 29 个 compute_offsets()
  AbstractAssembler::update_delayed_values();        // 通知代码生成器
}
```

**DO_COMPUTE_OFFSETS 宏**：`#define DO_COMPUTE_OFFSETS(k) k::compute_offsets();`

**PART1 (2 个，在 genesis 中提前计算)**：

| # | 类 | 偏移字段 | 提前计算原因 |
|---|----|---------|-------------|
| P1 | String | value, hash, coder | genesis 后续步骤需要访问 String 字段 |
| P2 | Class | klass, array_klass, oop_size, static_oop_field_count, protection_domain, init_lock, signers, class_loader, module, component_mirror, name, source_file | genesis 后续步骤（mirror 创建、fixup_mirrors）需要访问 Class 字段 |

**PART2 (29 个，在 javaClasses_init 中计算)**：

| # | 类 | C++ 辅助类 | 关键字段 | 偏移变量 | 用途 | 实现行号 (:cpp) |
|---|----|----------|---------|---------|------|----------------|
| 1 | System | java_lang_System | in, out, err, security | static_in/out/err/security_offset | I/O 重定向 | :4165 |
| 2 | ClassLoader | java_lang_ClassLoader | parent, parallelLockMap, loader_data, name, nameAndId, unnamedModule | parent/parallelCapable/name/nameAndId/unnamedModule + _loader_data_offset | 类加载委托, CLD 关联 | :4046 |
| 3 | Throwable | java_lang_Throwable | backtrace, detailMessage, cause, stackTrace, depth | backtrace/detailMessage/stackTrace/depth_offset | 异常抛出 | :1880 |
| 4 | **Thread** | java_lang_Thread | **eetop**, name, tid, daemon, priority, group, stackSize, threadStatus, parkBlocker, contextClassLoader, inheritedAccessControlContext, stillborn | **_eetop_offset** 等 12 个 | **线程操作** (Java↔C++ 桥接) | :1624 |
| 5 | ThreadGroup | java_lang_ThreadGroup | parent, name, threads, groups, maxPriority, destroyed, daemon, nthreads, ngroups | _parent/name/threads/groups/maxPriority/destroyed/daemon/nthreads/ngroups_offset | 线程组管理 | :1860 |
| 6 | **AssertionStatusDirectives** | java_lang_AssertionStatusDirectives | classes, classEnabled, packages, packageEnabled, deflt | classes/classEnabled/packages/packageEnabled/deflt_offset | JVM 断言系统 | :4366 |
| 7 | SoftReference | java_lang_ref_SoftReference | timestamp, clock | timestamp/static_clock_offset | 软引用 LRU | :3559 |
| 8 | MethodHandle | java_lang_invoke_MethodHandle | type, form | _type/_form_offset | invokedynamic 方法句柄 | :3632 |
| 9 | **DirectMethodHandle** | java_lang_invoke_DirectMethodHandle | member (MemberName) | _member_offset | 直接方法句柄, C2 常量折叠优化 | :3600 |
| 10 | MemberName | java_lang_invoke_MemberName | clazz, name, type, flags, method, vmindex | _clazz/name/type/flags/method/_vmindex_offset | JSR 292 成员名解析 | :3650 |
| 11 | **ResolvedMethodName** | java_lang_invoke_ResolvedMethodName | vmtarget (Method*), vmholder (Klass mirror) | _vmtarget/_vmholder_offset | Method* 的 Java 包装, invokedynamic 链接 | :3663 |
| 12 | LambdaForm | java_lang_invoke_LambdaForm | vmentry (MemberName) | _vmentry_offset | Lambda 表达式编译形式 | :3678 |
| 13 | MethodType | java_lang_invoke_MethodType | rtype, ptypes | _rtype/_ptypes_offset | 方法类型签名 | :3831 |
| 14 | CallSite | java_lang_invoke_CallSite | target, context | _target/_context_offset | 调用点目标缓存 | :3925 |
| 15 | **CallSiteContext** | java_lang_invoke_MethodHandleNatives_CallSiteContext | vmdependencies (DependencyContext*) | _vmdependencies_offset | CallSite 依赖跟踪, 类重定义失效 | :3947 |
| 16 | **AccessControlContext** | java_security_AccessControlContext | context, privilegedContext, isPrivileged, isAuthorized | _context/privilegedContext/isPrivileged/_isAuthorized_offset | 安全上下文, JDK 1.2/1.3 布局差异 | :3978 |
| 17 | **AccessibleObject** | java_lang_reflect_AccessibleObject | override (boolean) | override_offset | 反射访问控制, setAccessible 标志 | :2702 |
| 18 | Method (reflect) | java_lang_reflect_Method | clazz, name, returnType, parameterTypes, exceptionTypes, slot, modifiers, signature, annotations, parameter_annotations, annotation_default, type_annotations | clazz/name/returnType/parameterTypes/exceptionTypes/slot/modifiers/signature/annotations/parameter_annotations/annotation_default/type_annotations_offset (12 个) | 反射方法调用 | :2737 |
| 19 | Constructor | java_lang_reflect_Constructor | clazz, parameterTypes, exceptionTypes, slot, modifiers, signature, annotations, parameter_annotations, type_annotations | clazz/parameterTypes/exceptionTypes/slot/modifiers/signature/annotations/parameter_annotations/type_annotations_offset (9 个) | 反射构造器调用 | :2925 |
| 20 | Field | java_lang_reflect_Field | clazz, name, type, slot, modifiers, signature, annotations, type_annotations | clazz/name/type/slot/modifiers/signature/annotations/type_annotations_offset (8 个) | 反射字段访问 | :3075 |
| 21 | Buffer | java_nio_Buffer | limit | _limit_offset | NIO Buffer checkIndex 内联 | :4406 |
| 22 | **ConstantPool** | reflect_ConstantPool | constantPoolOop (ConstantPool* 地址) | _oop_offset | 反射 class loading, Unsafe.defineAnonymousClass | :3201 |
| 23 | **UnsafeStaticFieldAccessorImpl** | reflect_UnsafeStaticFieldAccessorImpl | base (static field base) | _base_offset | Unsafe 静态字段快速访问 | :3387 |
| 24 | **Parameter** | java_lang_reflect_Parameter | name, modifiers, index, executable | name/modifiers/index/executable_offset | 方法参数反射 (Method.getParameters) | :3219 |
| 25 | Module | java_lang_Module | loader, name, module_entry | loader/name/_module_entry_offset | 模块系统, ModuleEntry 关联 | :3296 |
| 26 | StackTraceElement | java_lang_StackTraceElement | declaringClassObject, classLoaderName, moduleName, moduleVersion, declaringClass, methodName, fileName, lineNumber | declaringClassObject/classLoaderName/moduleName/moduleVersion/declaringClass/methodName/fileName/lineNumber_offset (8 个) | 栈追踪元素, StackWalker | :4290 |
| 27 | **StackFrameInfo** | java_lang_StackFrameInfo | memberName, bci, version (injected) | _memberName/_bci/_version_offset | StackWalker API, 栈帧快照 | :2669 |
| 28 | **LiveStackFrameInfo** | java_lang_LiveStackFrameInfo | monitors, locals, operands, mode | _monitors/_locals/_operands/_mode_offset | JVMTI GetLocalVariable, JDI locals 检查 | :2688 |
| 29 | AbstractOwnableSynchronizer | java_util_concurrent_locks_AbstractOwnableSynchronizer | exclusiveOwnerThread | _owner_offset | AQS 锁所有者监控, JFR + jcmd Thread.print | :4421 |

**注**：PART1 的 2 个类（String, Class）在 genesis §1.6 步骤 3 中提前计算，不参与 `javaClasses_init()` 宏展开。总计 **31 个核心类**（29 PART2 + 2 PART1）。

### 2.3 compute_offset() — 字段偏移查找引擎

```cpp
// src/hotspot/share/classfile/javaClasses.cpp:~185
static void compute_offset(int &dest_offset, InstanceKlass* ik,
                           Symbol* name_symbol, Symbol* signature_symbol,
                           bool is_static = false) {
  fieldDescriptor fd;
  if (ik == NULL) {
    vm_exit_during_initialization("Invalid layout of well-known class");
  }
  if (!ik->find_local_field(name_symbol, signature_symbol, &fd)
      || fd.is_static() != is_static) {
    vm_exit_during_initialization("Invalid layout of preloaded class");
  }
  dest_offset = fd.offset();  // ★ 将字段字节偏移量写入静态变量
}
```

> **Callout 6: java_lang_Thread::_eetop_offset — Java↔C++ 指针桥接**  
> `java.lang.Thread.eetop` 是 `long` 类型字段，JVM 在其中存储 C++ `JavaThread*` 指针。这是 Java Thread 对象 ↔ C++ JavaThread 对象的**唯一双向桥梁**：
> ```cpp
> // 写入（线程创建时）: java_lang_Thread::set_thread()
> java_thread->address_field_put(_eetop_offset, (address)thread);
> // 读取（线程操作时）: java_lang_Thread::thread()
> return (JavaThread*)java_thread->address_field(_eetop_offset);
> ```
> 线程退出时 `set_thread(java_thread, NULL)` 清除关联。如果 `_eetop_offset` 计算错误 → 所有线程操作（`isAlive()`、`interrupt()`、`join()`）访问非法内存 → SIGSEGV。

### 2.4 字段偏移宏体系 — FIELD_COMPUTE_OFFSET

所有 `compute_offsets()` 实现遵循统一的宏展开模式：

```cpp
// 以 java_security_AccessControlContext 为例 (:3972-3982)
#define ACCESSCONTROLCONTEXT_FIELDS_DO(macro) \
  macro(_context_offset,           k, "context",           protectiondomain_signature, false); \
  macro(_privilegedContext_offset, k, "privilegedContext", accesscontrolcontext_signature, false); \
  macro(_isPrivileged_offset,      k, "isPrivileged",      bool_signature, false); \
  macro(_isAuthorized_offset,      k, "isAuthorized",      bool_signature, false)

void java_security_AccessControlContext::compute_offsets() {
  assert(_isPrivileged_offset == 0, "offsets should be initialized only once");
  InstanceKlass* k = SystemDictionary::AccessControlContext_klass();
  ACCESSCONTROLCONTEXT_FIELDS_DO(FIELD_COMPUTE_OFFSET);
  // FIELD_COMPUTE_OFFSET 展开为: compute_offset(_context_offset, k, "context", ...);
}
```

### 2.5 注入字段 (Injected Fields) — Java 类中不存在的 JVM 私有字段

部分类有"注入字段"——这些字段**在 Java 源码中不存在**，由 JVM 在类链接时动态注入：

| 类 | 注入字段 | 类型 | 用途 |
|----|---------|------|------|
| java_lang_Class | klass | intptr | 存储 C++ Klass* 指针 (Java 侧不可见) |
| java_lang_Class | array_klass | intptr | 数组 Klass* 缓存 |
| java_lang_Class | oop_size | int | 实例大小缓存 |
| java_lang_Class | static_oop_field_count | int | 静态 oop 字段计数 |
| java_lang_Class | protection_domain | object | 保护域 |
| java_lang_Class | signers | object | 签名者 |
| java_lang_Class | source_file | object | 源文件名 |
| java_lang_ClassLoader | loader_data | intptr | 存储 ClassLoaderData* 指针 |
| java_lang_invoke_ResolvedMethodName | vmtarget | intptr | 存储 Method* 指针 |
| java_lang_invoke_ResolvedMethodName | vmholder | object | Klass mirror |
| java_lang_invoke_MemberName | vmindex | intptr | 成员索引 |
| java_lang_invoke_MethodHandleNatives_CallSiteContext | vmdependencies | intptr | DependencyContext* |
| java_lang_StackFrameInfo | version | short | class file 版本号 |
| java_lang_Module | module_entry | intptr | 存储 ModuleEntry* 指针 |

`INJECTED_FIELD_COMPUTE_OFFSET` 宏展开不同于 `FIELD_COMPUTE_OFFSET`——它使用 `InjectedField::compute_offset()` 而非 `ik->find_local_field()`，因为注入字段在 Java 类字节码中不存在。

### 2.6 CDS 模式下的跳过逻辑

**genesis**：`if (!UseSharedSpaces)` 跳过 8 种 TypeArrayKlass 创建 + 5 空元数据数组——从 archive 恢复。

**compute_offsets**：`if (UseSharedSpaces) return;` —— 偏移量已从 `JavaClasses::serialize_offsets()` 反序列化。

### 2.7 check_offsets() — Debug 模式下的偏移量验证

```cpp
// src/hotspot/share/classfile/javaClasses.cpp:4487-4496
bool JavaClasses::check_offset(const char *klass_name, int offset,
                                const char *field_name, const char* field_sig) {
  // PRODUCT 模式下编译为空函数
  // DEBUG 模式下:
  InstanceKlass* ik = SystemDictionary::find(klass_name, ...);  // 查找 Klass
  fieldDescriptor fd;
  if (ik->find_field(field_name, field_sig, &fd)) {
    assert(fd.offset() == offset, "offset mismatch");  // ★ 运行时验证
    return true;
  }
  return false;  // 字段不存在
}
```

**验证策略**：
- **PRODUCT 构建**: `check_offsets()` 被 `PRODUCT_RETURN` 宏编译为空——不增加启动开销
- **DEBUG/FASTDEBUG 构建**: 重新遍历所有 Klass，对比 `compute_offset()` 的结果与运行时实际偏移 → `assert()` 在偏移不一致时触发
- **验证的类**: PART1（String, Class）和 PART2 的 29 个类 + 注入字段 14 个 → 共验证 ~150+ 个偏移量

> **Callout 13: 为什么 check_offsets 在 compute_offsets 之后立即执行？**  
> `javaClasses_init()` (:4598) 先调用 `compute_offsets()` 再调用 `check_offsets()` — 因为 `check_offsets` 需要 `compute_offsets` 设置的偏移量作为参考值。如果在 compute 之前 check → 偏移变量全为 0 → 每个 assert 都会失败。但 compute 之后的 check 可以检测到两种错误：(1) `compute_offset()` 找到了错误的字段，(2) 字段在 compute 和 check 之间被修改（理论上不会，因为 VM 仍在单线程引导中）。

### 2.8 11 个此前缺失的 javaClasses 详细分析

以下 11 个类在原始文档中仅列名未展开，此处逐类分析偏移量、VM 使用模式和设计意图。

#### 2.8.1 java_lang_reflect_AccessibleObject — 反射访问控制根类

**声明**: `javaClasses.hpp:566-583, .cpp:2699-2718`

```cpp
#define ACCESSIBLEOBJECT_FIELDS_DO(macro) \
  macro(override_offset, k, "override", bool_signature, false)
```

- **唯一字段**: `override` (boolean) — 标记反射访问权限是否已被 `setAccessible(true)` 打开
- **继承链**: AccessibleObject → Method / Constructor / Field 三个子类共享此偏移量
- **VM 使用**: `jboolean override(oop reflect)` → `reflect->bool_field(override_offset)` — 反射调用前检查，决定是否跳过 Java 语言访问检查
- **关键运行时路径**: `Method::invoke()` JNI 实现中，调用 `AccessibleObject::override()` 决定是否允许私有方法调用

> **Callout 11: 为什么 AccessibleObject 只有一个字段却仍是独立 compute_offsets？**  
> 因为 Method、Constructor、Field 都继承 AccessibleObject。虽然只有 `override` 一个字段，但子类共享这个偏移量——VM 通过基类偏移量访问子类实例的 override 字段，无需类型判断。如果写在常量中而非运行时计算，JDK 版本间 AccessibleObject 字段布局变化时无法检测到不一致。

#### 2.8.2 java_lang_invoke_DirectMethodHandle — 直接方法句柄

**声明**: `javaClasses.hpp:1027-1049, .cpp:3597-3609`

```cpp
#define DIRECTMETHODHANDLE_FIELDS_DO(macro) \
  macro(_member_offset, k, "member", java_lang_invoke_MemberName_signature, false)
```

- **唯一字段**: `member` (MemberName 类型) — 描述目标方法/构造器/字段的元数据对象
- **VM 使用**: C1/C2 JIT 编译器通过 `member_offset_in_bytes()` 获取 DMH 的 MemberName → 解析其中的 `vmindex` → 生成直接调用指令
- **性能关键**: `DMH.invokeExact()` 热路径中，VM 在 C2 编译时常量折叠 `member` 字段 → 消除 vtable dispatch → 等同于直接方法调用
- **与 ResolvedMethodName 的关系**: DMH 的 `member` 字段包含 ResolvedMethodName 对象 → 通过 ResolvedMethodName 的 `vmtarget` (Method*) 获取编译入口

> **Callout 12: DirectMethodHandle 为什么需要独立偏移量而不是继承 MethodHandle？**  
> DMH 是 MH 的子类，但 MH 的字段 (`type`, `form`) 和 DMH 的字段 (`member`) 在不同的偏移位置。编译器需要分别访问两者——折叠 MH.type 用于类型检查，解析 DMH.member 用于目标方法定位。独立偏移量让编译器生成带精确偏移的 load 指令。

#### 2.8.3 java_lang_invoke_ResolvedMethodName — Method* 的 Java 对象包装

**声明**: `javaClasses.hpp:1084-1107, .cpp:3663-3673`

```cpp
// 所有字段都是注入字段（Java 类中不存在）:
// RESOLVEDMETHOD_INJECTED_FIELDS(macro):
//   vmtarget  — intptr, 存储 C++ Method* 指针
//   vmholder  — object,  Method 所属的 Klass mirror
```

- **核心作用**: 将 C++ `Method*` (指向 Metaspace 中的 Method 元数据) 包装为 Java 可访问的对象
- **不触发 GC 扫描**: `vmtarget` 是 intptr 不是 oop → GC 不遍历（Method* 在 Metaspace 不是堆对象）
- **VM 使用路径**: 
  1. `ResolvedMethodName::vmtarget(oop)` → `*(Method**)(oop_addr + _vmtarget_offset)` — 解引用获取 Method*
  2. `MemberName::vmtarget(oop)` → `ResolvedMethodName::vmtarget(memberName->obj_field(_method_offset))` — 穿越两层间接
- **invokedynamic 链接**: `CallSite` → `MethodHandle` → `LambdaForm` → `MemberName` → `ResolvedMethodName` → `Method*` → 编译入口

> **Callout 13a: 为什么 ResolvedMethodName 所有字段都是注入字段？**  
> ResolvedMethodName 是纯 JVM 内部对象——Java 代码从不直接访问其字段。所有数据 (Method* 指针, Klass mirror) 由 JVM 在类链接/重定义时设置。注入字段避免了 Java 字段布局与 C++ 指针存储之间的兼容性问题（intptr 大小随平台 32/64-bit 变化）。

#### 2.8.4 java_lang_invoke_MethodHandleNatives_CallSiteContext — CallSite 依赖跟踪

**声明**: `javaClasses.hpp:1256-1279, .cpp:3943-3963`

```cpp
// CALLSITECONTEXT_INJECTED_FIELDS:
//   vmdependencies  — intptr, 存储 DependencyContext* 指针
```

- **唯一字段**: `vmdependencies` (intptr 注入字段) — 存储 C++ `DependencyContext` 结构指针
- **DependencyContext**: 一个链表头指针，挂在 Method* 或 Klass* 上，记录所有依赖此方法的 CallSite
- **失效机制**: 当 JVMTI `RedefineClasses()` 重新定义类时 → `DependencyContext::wipe()` → 遍历依赖链表 → 使所有相关 CallSite 的 target 失效 → 下一次 invokedynamic 调用触发重新链接
- **`CallSiteContext::vmdependencies(oop)`** (`javaClasses.cpp:3958`):
  ```cpp
  intptr_t* vmdeps_addr = (intptr_t*)call_site->field_addr(_vmdependencies_offset);
  DependencyContext dep_ctx(vmdeps_addr);
  return dep_ctx;
  ```

> **Callout 14: DependencyContext 指针为什么直接嵌入 oop 字段？**  
> DependencyContext 以 intptr 形式存储在 Java 对象的注入字段中——它不是 oop（不受 GC 管理），也不是 Metaspace 对象（不受类卸载影响）。它是在 C++ 堆上分配的单向链表头，类重定义时通过 `wipe()` 来通知 CallSite 重新解析。

#### 2.8.5 java_security_AccessControlContext — 安全上下文 (JDK 版本兼容)

**声明**: `javaClasses.hpp:1281-1301, .cpp:3965-4005`

```cpp
#define ACCESSCONTROLCONTEXT_FIELDS_DO(macro) \
  macro(_context_offset,           k, "context",           protectiondomain_signature, false); \
  macro(_privilegedContext_offset, k, "privilegedContext", accesscontrolcontext_signature, false); \
  macro(_isPrivileged_offset,      k, "isPrivileged",      bool_signature, false); \
  macro(_isAuthorized_offset,      k, "isAuthorized",      bool_signature, false)
```

- **4 个字段**: `context` (ProtectionDomain[]), `privilegedContext` (AccessControlContext), `isPrivileged` (boolean), `isAuthorized` (boolean)
- **JDK 版本差异**: JDK 1.2 和 1.3 之间 AccessControlContext 字段布局不同 → 必须在运行时计算偏移量而非硬编码
- **初始值特殊**: `_isAuthorized_offset = -1` (表示未初始化)，`_isPrivileged_offset` 断言为 0
- **VM 使用**: `is_authorized(Handle)` 检查安全权限，在 `doPrivileged()` 路径中调用

#### 2.8.6 reflect_ConstantPool — 反射常量池代理

**声明**: `javaClasses.hpp:850-874, .cpp:3198-3211`

```cpp
#define CONSTANTPOOL_FIELDS_DO(macro) \
  macro(_oop_offset, k, "constantPoolOop", object_signature, false)
```

- **唯一字段**: `constantPoolOop` (object 类型) — 在 Java 对象字段中存储 C++ `ConstantPool*` 地址
- **与注入字段的区别**: 这是真正的 Java 对象字段（非注入），但内容仍是 C++ 指针
- **用途**: `Unsafe.defineAnonymousClass()` 需要访问宿主类的 ConstantPool → 通过 `reflect_ConstantPool::get_cp()` 解引用获取 ConstantPool*
- **偏移量访问**: `ConstantPool::oop_offset()` 被 `ClassFileParser` 在匿名类加载时调用

#### 2.8.7 reflect_UnsafeStaticFieldAccessorImpl — Unsafe 静态字段快速访问

**声明**: `javaClasses.hpp:877-891, .cpp:3384-3396`

```cpp
#define UNSAFESTATICFIELDACCESSORIMPL_FIELDS_DO(macro) \
  macro(_base_offset, k, "base", object_signature, false)
```

- **唯一字段**: `base` (object) — 静态字段的基对象 (static field base object)
- **用途**: `Unsafe.objectFieldOffset()` + `Unsafe.staticFieldBase()` 两个调用 → JIT 编译为单次 `base` 字段加载
- **优化**: C2 编译器将 `Unsafe.staticFieldBase()` 内联为从 `UnsafeStaticFieldAccessorImpl` 加载 `_base_offset` 的单条指令

#### 2.8.8 java_lang_reflect_Parameter — 方法参数反射

**声明**: `javaClasses.hpp:784-815, .cpp:3213-3228`

```cpp
#define PARAMETER_FIELDS_DO(macro) \
  macro(name_offset,        k, vmSymbols::name_name(),        string_signature, false); \
  macro(modifiers_offset,   k, vmSymbols::modifiers_name(),   int_signature,    false); \
  macro(index_offset,       k, vmSymbols::index_name(),       int_signature,    false); \
  macro(executable_offset,  k, vmSymbols::executable_name(),  executable_signature, false)
```

- **4 个字段**: `name`, `modifiers`, `index`, `executable` (Executable/Method/Constructor 引用)
- **用途**: `Method::getParameters()` Java API 返回 `Parameter[]{name, modifiers, index, executable}`
- **VM 写入**: 类链接时 ClassFileParser 将参数元数据写入 Parameter 对象 → `java_lang_reflect_Parameter::set_name()` 等方法
- **注意**: `name` 在编译时不一定会保留（取决于 `-parameters` 选项）→ 未保留时 name 为 `"argN"` 格式

#### 2.8.9 java_lang_StackFrameInfo — StackWalker 栈帧快照

**声明**: `javaClasses.hpp:1438-1463, .cpp:2665-2680`

```cpp
#define STACKFRAMEINFO_FIELDS_DO(macro) \
  macro(_memberName_offset, k, "memberName", object_signature, false); \
  macro(_bci_offset,        k, "bci",        int_signature,    false)
// 注入字段: version (short) — class file version
```

- **2 个 Java 字段 + 1 个注入字段**: `memberName` (MemberName), `bci` (int), `version` (short, injected)
- **StackWalker API (JEP 259)**: Java 9+ 的 `StackWalker.walk()` 返回 `Stream<StackFrameInfo>`（替代旧版 `Throwable.getStackTrace()`）
- **`to_stack_trace_element()`**: 将 StackFrameInfo 转换为 StackTraceElement → 兼容旧 API
- **注入字段 `version`**: 存储 class file 主版本号（如 55 = Java 11），用于 StackWalker 的 `RetainClassReference` 选项

#### 2.8.10 java_lang_LiveStackFrameInfo — 活动栈帧的局部变量快照

**声明**: `javaClasses.hpp:1465-1483, .cpp:2682-2697`

```cpp
#define LIVESTACKFRAMEINFO_FIELDS_DO(macro) \
  macro(_monitors_offset, k, "monitors", object_array_signature, false); \
  macro(_locals_offset,   k, "locals",   object_array_signature, false); \
  macro(_operands_offset, k, "operands", object_array_signature, false); \
  macro(_mode_offset,     k, "mode",     int_signature,          false)
```

- **4 个字段**: `monitors` (Object[]), `locals` (Object[]), `operands` (Object[]), `mode` (int)
- **用途**: JVMTI `GetLocalVariable` 和 JDI (Java Debug Interface) 栈帧检查 — 捕获活动栈帧中的局部变量、锁、操作数栈
- **与 StackFrameInfo 的区别**: LiveStackFrameInfo 是需要**暂停线程**才能获取的**活动帧**快照，而 StackFrameInfo 是轻量级快照（不需要暂停）
- **性能开销**: 需要 `VM_GetOrSetLocal` VM Operation → 安全点暂停 → 复制局部变量到对象数组

#### 2.8.11 java_lang_AssertionStatusDirectives — JVM 断言控制

**声明**: `javaClasses.hpp:1485-1508, .cpp:4358-4395`

```cpp
#define ASSERTIONSTATUSDIRECTIVES_FIELDS_DO(macro) \
  macro(classes_offset,        k, "classes",        string_array_signature, false); \
  macro(classEnabled_offset,   k, "classEnabled",   bool_array_signature, false); \
  macro(packages_offset,       k, "packages",       string_array_signature, false); \
  macro(packageEnabled_offset, k, "packageEnabled", bool_array_signature,   false); \
  macro(deflt_offset,          k, "deflt",          bool_signature,         false)
```

- **5 个字段**: `classes` (String[]), `classEnabled` (boolean[]), `packages` (String[]), `packageEnabled` (boolean[]), `deflt` (boolean)
- **用途**: Java 断言系统（`-ea`/`-da`/`-esa`/`-dsa` 命令行参数）的配置载体
- **VM 交互**: 
  - `ClassLoader.setDefaultAssertionStatus(boolean)` → 调用 `set_deflt(o, val)` → JVM 写入 `deflt` 字段
  - `ClassLoader.setClassAssertionStatus(String, boolean)` → 调用 `set_classes()` + `set_classEnabled()` → JVM 写入对应索引
  - `ClassLoader.setPackageAssertionStatus(String, boolean)` → 调用 `set_packages()` + `set_packageEnabled()`
- **并行数组设计**: `classes[i]` 和 `classEnabled[i]` 构成 (类名, 是否启用) 键值对——无需 HashMap 查找，适合启动时的小规模配置

### 2.9 边缘场景与反事实分析

#### 2.8.1 场景：JDK 版本不匹配 — 字段缺失或签名变化

| 错误类型 | 触发条件 | vm_exit 消息 | 诊断方法 |
|---------|---------|-------------|---------|
| Klass 为 NULL | `SystemDictionary::*_klass()` 返回 NULL（类未加载） | `"Invalid layout of well-known class"` | GDB: `print SystemDictionary::Thread_klass()` |
| 字段不存在 | `find_local_field(name, sig)` 失败 | `"Invalid layout of preloaded class"` | `javap -p java.lang.Thread \| grep eetop` |
| 字段是 static | `fd.is_static() != is_static` (参数 false 但字段为 true) | `"Invalid layout of preloaded class"` | 检查 `javap` 输出中的 `static` 标记 |
| 注入字段失败 | `InjectedField::compute_offset()` 在 `javaClasses.cpp:4478` 失败 | `"must be called in early JVMTI phase"` | 检查 JVMTI `can_generate_early_vmstart` |

**反事实**：如果 `compute_offset()` 失败时继续运行而非 `vm_exit` → JVM 使用零值偏移量读取字段 → 每次 `java_lang_Thread::thread()` 从 oop 偏移 0 处读取 → 可能读取到 mark word → 返回垃圾指针 → 线程 `isAlive()` 随机返回 true/false → 线程调度彻底混乱。

#### 2.8.2 场景：ClassLoader 隔离 — 同名字段不同偏移

```bash
# 用户自定义 ClassLoader 加载了不同版本的 java.lang.Thread
# → Thread 类有不同的字段布局，但 WK_KLASS(Thread_klass) 指向启动类
# → compute_offsets 使用启动类 Thread 的偏移 → 对自定义 ClassLoader 的 Thread 无效
```

**根因**: `compute_offsets()` 只针对 `SystemDictionary` 中的 WK_KLASS 实例。`compute_offset()` 在 `ik->find_local_field()` 中使用当前 Ik 的字段布局。如果自定义 ClassLoader 加载了另一份 `java.lang.Thread`——它有不同的字段偏移。

**缓解**: JVM 通过 `Dictionary::is_valid_protection_domain()` 和 `SystemDictionary::check_constraints()` 防止核心类被非启动 ClassLoader 重复加载。但—Xbootclasspath 可以绕过此限制。

#### 2.8.3 场景：genesis 中 OOM — 创建 TypeArrayKlass 时 Metaspace 耗尽

```cpp
// typeArrayKlass.cpp:60
TypeArrayKlass* ak = TypeArrayKlass::allocate(null_cld, type, sym, CHECK_NULL);
// CHECK_NULL → 如果 allocate 返回 NULL（Metaspace 满了）
// → vm_exit_during_initialization("Unable to allocate TypeArrayKlass")
```

**反事实**：如果创建第 5 个 TypeArrayKlass 时 Metaspace 耗尽（前 4 个已分配）→ `allocate()` 返回 NULL → `CHECK_NULL` 触发 `vm_exit_during_initialization()`。前 4 个已创建的 TypeArrayKlass 留在 Metaspace 中——但 Metaspace 本身也被用于分配这些 Klass，形成"分配半路失败"的不一致状态。

> **Callout 15: 为什么 genesis 不尝试 GC 后重试？**  
> genesis 阶段的 Metaspace 是初始分配——如果 Metaspace 初始空间（默认 ~20MB）连 8 个 TypeArrayKlass + 5 个空数组都装不下，说明 Metaspace 配置严重错误（`-XX:MetaspaceSize` 可能设为 <1MB）。此时 GC 也无法释放空间（没有已加载的类可以卸载），所以直接 `vm_exit` 是正确的——用户需要调大 Metaspace 初始大小。

#### 2.8.4 场景：预分配异常耗尽 — OOM 时 backtrace 降级

```bash
# 4 个线程同时 OOM → 前 4 个获得带 backtrace 的异常 → 第 5 个 OOM 无 backtrace
```

**降级策略**：
1. `gen_out_of_memory_error()` 首次调用 → `Atomic::add(-1)` = 3 → 使用 `obj_at(3)` → 填充 backtrace
2. 第 4 次调用 → `Atomic::add(-1)` = 0 → 使用 `obj_at(0)` → 填充 backtrace
3. 第 5 次调用 → `Atomic::add(-1)` = -1 → `next < 0` → fallback 到 `default_err` — 无 backtrace
4. 如果 `ThreadsListHandle` 遍历时发现多个线程同时 OOM，GC 日志中会看到 `"OutOfMemoryError backtrace pool exhausted"` 消息

#### 2.8.5 场景：SELinux/AppArmor 阻止 /proc/self/maps 读取

`genesis()` 不直接访问 `/proc`——但在 Metaspace 初始化（`universe_init` 在 genesis 之前）中，`Metaspace::global_initialize()` 可能读取 `/proc/self/maps` 判断虚拟地址空间布局（用于 CompressedOops 决策）。如果 SELinux 阻止 → `mmap()` 返回 `MAP_FAILED` with `errno=EACCES` → `vm_exit_during_initialization("Unable to allocate memory for metaspace")`。

**诊断**: `dmesg | grep -i selinux` + `audit2allow -a`

#### 2.9.6 场景：CDS 归档损坏 — 恢复的偏移量与实际 Klass 不匹配

```bash
java -Xshare:on -jar app.jar
# Error: Shared archive mismatch → 退化为 -Xshare:off (慢启动)
```

当 CDS archive 中序列化的偏移量与当前运行时的 Klass 实际偏移不一致（发生在 JDK 版本不匹配或 HotSpot patch 中修改字段顺序时）：
- `UseSharedSpaces` 自动降级为 false → 跳过 CDS 恢复
- `genesis()` 重新创建 8 种 TypeArrayKlass
- `compute_offsets()` 重新计算所有 31 个类的偏移量
- 启动变慢但功能正确——CDS 故障**不应导致 JVM 启动失败**

> **Callout 17: CDS 降级策略的设计哲学**  
> CDS 是性能优化而非功能依赖。如果 archive 不匹配 → 重做所有初始化 → 只损失启动速度，不损失功能。这是与 `compute_offset()` 失败即 `vm_exit` 的本质区别——偏移量计算是功能正确性的硬保证，CDS 是可选的性能捷径。**反事实**：如果 CDS 失败也退出 → 用户无法通过简单重启解决 JDK 小版本升级时的 archive 不匹配问题 → 需要每次手动 `java -Xshare:dump`。





---

## §三 收尾：universe_post_init() — 6 阶段收尾

> **init_globals 调用 #28** (`init.cpp:183`): `universe_post_init()`
> 
> **前置条件**: compileBroker_init (#27) 已完成，编译器就绪。**3 个错误路径之一**（返回 false → JNI_ERR）

### 3.1 阶段 1: vtable/itables 重初始化

```cpp
// src/hotspot/share/memory/universe.cpp:1234-1241
if (!UseSharedSpaces) {
  Klass* ok = SystemDictionary::Object_klass();
  Universe::reinitialize_vtable_of(ok, CHECK_false);  // 从 Object 递归遍历
  Universe::reinitialize_itables(CHECK_false);         // 遍历所有已加载类
}
```

**reinitialize_vtable_of()** (`universe.cpp:574-584`)：
```cpp
void Universe::reinitialize_vtable_of(Klass* ko, TRAPS) {
  ko->vtable().initialize_vtable(false, CHECK);  // false = 不初始化 itable
  if (ko->is_instance_klass()) {
    for (Klass* sk = ko->subklass(); sk != NULL; sk = sk->next_sibling()) {
      reinitialize_vtable_of(sk, CHECK);  // ★ 递归遍历继承树
    }
  }
}
```

> **Callout 7: 为什么 vtable 需要重初始化？**  
> genesis 阶段创建 TypeArrayKlass 和加载 Object/String/Class 时，方法尚未加载（方法在类链接阶段才加载）。vtable 槽位需要 `Method*` 指针——在 genesis 时为空或不完整。`universe_post_init()` 在所有系统类加载完成后重初始化 vtable → `initialize_vtable()` 从父类复制 vtable → 逐方法检查 override → 放置当前类的 Method* → 填充 miranda 方法。

**CDS 模式下跳过**：vtable/itables 从 archive 直接恢复。

### 3.2 阶段 2: 预分配异常实例 — 完整类型列表

```cpp
// src/hotspot/share/memory/universe.cpp:1248-1284
// ============ 6 种 OutOfMemoryError 实例 ============
Klass* k = SystemDictionary::resolve_or_fail(vmSymbols::java_lang_OutOfMemoryError(), true, CHECK_false);
InstanceKlass* ik = InstanceKlass::cast(k);
_out_of_memory_error_java_heap       = ik->allocate_instance(CHECK_false);
_out_of_memory_error_metaspace       = ik->allocate_instance(CHECK_false);
_out_of_memory_error_class_metaspace = ik->allocate_instance(CHECK_false);
_out_of_memory_error_array_size      = ik->allocate_instance(CHECK_false);
_out_of_memory_error_gc_overhead_limit = ik->allocate_instance(CHECK_false);
_out_of_memory_error_realloc_objects = ik->allocate_instance(CHECK_false);

// ============ 延迟 StackOverflowError 消息 (条件性) ============
if (StackReservedPages > 0) {
  _delayed_stack_overflow_error_message =
    java_lang_String::create_oop_from_str("Delayed StackOverflowError...", CHECK_false);
}

// ============ NullPointerException + ArithmeticException ============
// 编译器可直接使用预分配实例 (快速异常抛出)
k = SystemDictionary::resolve_or_fail(vmSymbols::java_lang_NullPointerException(), true, CHECK_false);
_null_ptr_exception_instance = InstanceKlass::cast(k)->allocate_instance(CHECK_false);
k = SystemDictionary::resolve_or_fail(vmSymbols::java_lang_ArithmeticException(), true, CHECK_false);
_arithmetic_exception_instance = InstanceKlass::cast(k)->allocate_instance(CHECK_false);

// ============ VirtualMachineError — ★ 唯一显式失败路径 ============
k = SystemDictionary::resolve_or_fail(vmSymbols::java_lang_VirtualMachineError(), true, CHECK_false);
bool linked = InstanceKlass::cast(k)->link_class_or_fail(CHECK_false);
if (!linked) { return false; }  // → JNI_ERR

// ============ vm_exception 应急实例 ============
_virtual_machine_error_instance = InstanceKlass::cast(k)->allocate_instance(CHECK_false);
_vm_exception = InstanceKlass::cast(k)->allocate_instance(CHECK_false);
```

**预分配异常完整清单**（共 11 种实例 + 消息 + 数组）：

| # | 异常类型 | Universe 变量 | 用途/触发场景 | 消息内容 |
|---|---------|-------------|-------------|---------|
| 1 | OutOfMemoryError | `_out_of_memory_error_java_heap` | GC 无法回收足够堆空间 | "Java heap space" (:1286) |
| 2 | OutOfMemoryError | `_out_of_memory_error_metaspace` | 元空间耗尽 | "Metaspace" (:1289) |
| 3 | OutOfMemoryError | `_out_of_memory_error_class_metaspace` | 压缩类空间耗尽 | "Compressed class space" (:1291) |
| 4 | OutOfMemoryError | `_out_of_memory_error_array_size` | 数组大小超限 | "Requested array size exceeds VM limit" (:1294) |
| 5 | OutOfMemoryError | `_out_of_memory_error_gc_overhead_limit` | GC 开销超限（98%+ CPU 用于 GC） | "GC overhead limit exceeded" (:1297) |
| 6 | OutOfMemoryError | `_out_of_memory_error_realloc_objects` | 标量替换对象重新分配失败 | "Java heap space: failed reallocation..." (:1300) |
| 7 | NullPointerException | `_null_ptr_exception_instance` | 编译器异常处理的快速路径 (cheap & dirty) | 无消息 (:1265) |
| 8 | ArithmeticException | `_arithmetic_exception_instance` | 编译器异常处理的快速路径 | "/ by zero" (:1303) |
| 9 | VirtualMachineError | `_virtual_machine_error_instance` | 无法恢复的 VM 内部错误 | 无消息 (:1281) |
| 10 | VirtualMachineError | `_vm_exception` | 应急异常 — **当 VME 本身创建失败时的最后兜底** | 无消息 (:1284) |
| 11 | StackOverflowError | `_delayed_stack_overflow_error_message` | ReserverdStackAccess 注解标记的方法 | "Delayed StackOverflowError..." (:1261) |

> **Callout 8: `_vm_exception` — 双重兜底机制**  
> `_virtual_machine_error_instance` 是 VME 的正常预分配实例。`_vm_exception` 是同一个类的**第二个实例**——当第一个 VME 实例因某些原因（如 GC 期间对象损坏）不可用时，JVM 使用 `_vm_exception` 作为最后的异常对象。这是 OOM+NPE+Arithmetic+VME 四类预分配异常中唯一有备份的设计。
> 
> **反事实**：如果只有一个 VME 实例 → 当 `gen_out_of_memory_error()` 耗尽 OOM 预分配池后 fallback 到 `default_err`（无 backtrace）时，若 default_err 处也损坏 → JVM 在 OOM 场景下彻底无法抛出异常 → 静默 SIGSEGV。

**gen_out_of_memory_error()** (`universe.cpp:617-654`) — 原子递减分配：
```cpp
oop Universe::gen_out_of_memory_error(oop default_err) {
  if (_preallocated_out_of_memory_error_avail_count > 0
      && Throwable_klass()->is_initialized()) {
    jint next = Atomic::add(-1, &_avail_count);  // ★ lock-free 原子递减
    if (next >= 0) {
      oop err = preallocated_out_of_memory_errors()->obj_at(next);
      java_lang_Throwable::set_message(err, message(default_err));
      java_lang_Throwable::fill_in_stack_trace_of_preallocated_backtrace(err);
      return err;  // 带完整 backtrace
    }
  }
  return default_err;  // 预分配池耗尽 → fallback 无 backtrace
}
```

> **Callout 9: Atomic::add(-1) 的并发安全**  
> 多个线程可能同时 OOM → `gen_out_of_memory_error()` 必须线程安全。`Atomic::add(-1, &_avail_count)` 是 lock-free 的原子递减——每个线程获取唯一的索引。如果 `next < 0`（预分配池耗尽）→ fallback 到 `default_err`（无 backtrace，但至少有一个错误对象可用）。这是 OOM 场景下的最小保证——"即使没有 backtrace，也要抛出正确的异常类型"。

### 3.3 阶段 3: PreallocatedOutOfMemoryErrorCount 批量预分配

```cpp
// universe.cpp:1306-1319
int len = (StackTraceInThrowable) ? (int)PreallocatedOutOfMemoryErrorCount : 0;
_preallocated_out_of_memory_error_array = oopFactory::new_objArray(ik, len, CHECK_false);
for (int i = 0; i < len; i++) {
  oop err = ik->allocate_instance(CHECK_false);
  Handle err_h = Handle(THREAD, err);
  java_lang_Throwable::allocate_backtrace(err_h, CHECK_false);  // ★ 预分配 backtrace
  preallocated_out_of_memory_errors()->obj_at_put(i, err_h());
}
_preallocated_out_of_memory_error_avail_count = (jint)len;  // 初始化可用计数
```

**预分配 backtrace 的意义**：`allocate_backtrace()` 预分配了 `trace_chunk_size` (=32) 个 `BacktraceElement` 对象数组，并设置 backtrace 字段。`fill_in_stack_trace_of_preallocated_backtrace()` 在 OOM 发生时才填充具体的栈帧信息，避免 OOM 时触发新的内存分配。

### 3.4 阶段 4: known methods 缓存

```cpp
// src/hotspot/share/memory/universe.cpp:1184-1218
void Universe::initialize_known_methods(TRAPS) {
  initialize_known_method(_finalizer_register_cache, ..., "register", ...);
  initialize_known_method(_throw_illegal_access_error_cache, ..., "throwIllegalAccessError", ...);
  initialize_known_method(_throw_no_such_method_error_cache, ..., "throwNoSuchMethodError", ...);
  initialize_known_method(_loader_addClass_cache, ..., "addClass", ...);
  initialize_known_method(_pd_implies_cache, ..., "impliesCreateAccessControlContext", ...);
  initialize_known_method(_do_stack_walk_cache, ..., "doStackWalk", ...);
}
```

**6 个 known methods 详情**：

| # | 缓存变量 | 所在类 | 方法 | 用途 |
|---|---------|-------|------|------|
| 1 | `_finalizer_register_cache` | Finalizer | `register(Object)` | GC 发现可回收对象时注册 Finalizer |
| 2 | `_throw_illegal_access_error_cache` | AccessibleObject/Module | `throwIllegalAccessError()` | 非法反射访问时抛异常 |
| 3 | `_throw_no_such_method_error_cache` | 同上 | `throwNoSuchMethodError()` | 反射方法不存在时抛异常 |
| 4 | `_loader_addClass_cache` | ClassLoader | `addClass(Class)` | 类加载完成后通知 ClassLoader |
| 5 | `_pd_implies_cache` | ProtectionDomain | `impliesCreateAccessControlContext()` | 安全权限检查 |
| 6 | `_do_stack_walk_cache` | AbstractStackWalker | `doStackWalk()` | StackWalker API 原生入口 |

**LatestMethodCache** (`universe.hpp:48-71`)：
```cpp
class LatestMethodCache {
  Klass* _klass;          // 所属类
  int    _method_idnum;   // 方法 ID 编号
  Method* get_method() { return InstanceKlass::cast(_klass)->method_with_idnum(_method_idnum); }
};
```

> **Callout 10: LatestMethodCache 为什么用 idnum 而不是 Method*？**  
> RedefineClasses（JVMTI 类重定义）会替换 Method* 指针但保留 method_idnum。存储 `method_idnum` 而非 `Method*` → `get_method()` 通过 `method_with_idnum()` 重新查找 → 类重定义后自动获取新 Method*。如果直接存储 Method*，类重定义后缓存失效 → 调用已释放的方法 → SIGSEGV。

**CallSiteContext 与 known methods 的交叉依赖**（JSR 292 + 类重定义）：

`java_lang_invoke_MethodHandleNatives_CallSiteContext` 的 `vmdependencies` 字段存储 `DependencyContext*`——这是一个链表头，记录所有依赖特定 Method* 的 CallSite。当 `RedefineClasses()` 重新定义类时：

```
RedefineClasses()
  → Method::set_code(method, new_code)     // 替换方法体
  → DependencyContext::wipe()               // 遍历依赖链表
    → CallSiteContext::vmdependencies()     // 获取 DependencyContext
      → 使 CallSite target 失效            // 下次 invokedynamic 重新链接
        → MethodHandle::set_target()         // 依赖 LatestMethodCache
          → LatestMethodCache::get_method()  // ★ 通过 idnum 查找新 Method*
```

这是 JVM 中 JSR 292 (invokedynamic) + JVMTI (类重定义) + known methods 缓存 **三者的唯一交叉点**。如果 `_vmdependencies_offset` 计算错误 → 类重定义后 CallSite 旧的 target 不会失效 → invokedynamic 调用旧的编译代码 → 方法体不一致 → 逻辑错误。

> **Callout 10b: init_globals 执行顺序约束在 CallSiteContext 上的体现**  
> `CallSiteContext` 的 `compute_offsets()` 在 `javaClasses_init()` (#19) 中计算，但 `CallSite` 类和 `DependencyContext` 在 `universe_post_init()` (#28) 的 `initialize_known_methods()` 中才首次使用——因为 CallSite 目标缓存需要编译器已就绪（compileBroker_init #27 在此之前）。这种顺序保证了"偏移量在 Klass 加载后就绪，但功能在编译器就绪后才激活"。

### 3.5 阶段 5-6: 堆后初始化 + MemoryService

```cpp
// universe.cpp:1325-1339
{ MutexLocker x(Heap_lock); update_heap_info_at_gc(); }
heap()->post_initialize();  // G1/Parallel/Serial/Epsilon/Shenandoah 各有实现
MemoryService::add_metaspace_memory_pools();
MemoryService::set_universe_heap(Universe::heap());
#if INCLUDE_CDS
MetaspaceShared::post_initialize(CHECK_false);
#endif
return true;
```

### 3.6 硬编码偏移量（Hard-Coded Offsets）— 启动早期的特殊处理

在 `genesis()` 调用 `resolve_well_known_classes()` 时，String 和 Class 的偏移量通过 `compute_offsets()` 在运行时计算。但在 `genesis()` **之前**（`universe_init` 阶段），JVM 就已需要访问 Reference 字段（用于 GC）。这些"硬编码偏移"在 `compute_hard_coded_offsets()` 中设置：

```cpp
// javaClasses.cpp:4441-4465
static int member_offset(int hardcoded_offset) {
  return (hardcoded_offset * heapOopSize) + instanceOopDesc::base_offset_in_bytes();
}
// base_offset_in_bytes() = mark word (8B) + klass pointer (4/8B) = 12 or 16 bytes
```

**硬编码偏移量公式**：`actual_offset = hardcoded_offset × heapOopSize + header_size`

| 类 | 字段 | hardcoded_offset | heapOopSize=8 时实际偏移 | 为何硬编码 |
|----|------|-----------------|----------------------|-----------|
| Reference | referent | hc_referent_offset(0) | 16 | GC 引用处理在 `genesis()` 之前就需要 |
| Reference | queue | hc_queue_offset(1) | 24 | GC 引用处理 |
| Reference | next | hc_next_offset(2) | 32 | GC 引用队列链表 |
| Reference | discovered | hc_discovered_offset(3) | 40 | GC discovery 过程 |
| Throwable | backtrace | hc_backtrace_offset(0) | 16 | 预分配异常时需要 (在 universe_post_init) |
| Throwable | detailMessage | hc_detailMessage_offset(1) | 24 | 预分配异常消息设置 |
| String | value | — | 24* | PART1 (在 genesis 中运行时计算) |
| String | hash | — | 12* | PART1 |

*注: String 的偏移量虽然是运行时计算的但仍依赖 pre-loaded class 的字段顺序假设。

**Reference 硬编码的必要性**（`javaClasses.hpp:940-946`）：
```cpp
class java_lang_ref_Reference: AllStatic {
 public:
  enum {
   hc_referent_offset   = 0,  // 第一个 oop 字段 → 紧接 header
   hc_queue_offset      = 1,  // 第二个 oop 字段
   hc_next_offset       = 2,  // 第三个 oop 字段
   hc_discovered_offset = 3   // 第四个 oop 字段 (不是最后一个，SoftReference 有额外字段)
  };
```

> **Callout 16: 为什么 Reference 必须硬编码而不是 compute_offsets？**  
> `java_lang_ref_Reference` 的字段偏移在 `genesis()` 调用 `resolve_well_known_classes()`（加载 Reference 类）之后才能通过运行时计算获取。但 `universe_init()` 中创建堆时就需要设置 `ReferenceProcessor`——因为 GC 扫描需要在 Object 加载之前就知道如何读取 Reference 的子类。硬编码假设 `oop` 字段按声明顺序排列（Java 规范保证），配合 `member_offset()` 转换为实际字节偏移。如果 JDK 中 Reference 字段顺序变化，JVM 启动时由 `check_offsets()` 验证不通过 → `vm_exit_during_initialization()`。

### 3.7 启动异常处理全景 — 所有退出路径

`universe_post_init()` 是 3 个可返回 `false` 的 init_globals 函数之一（另外两个是 `universe_init` 和 `init_globals2`）。所有导致启动失败的路径：

| 退出路径 | 函数 | 行号 | 失败条件 | 错误消息 |
|---------|------|------|---------|---------|
| `vm_exit_during_initialization()` | `compute_offset()` | javaClasses.cpp:~188 | 在 InstanceKlass 中找不到字段 | `"Invalid layout of well-known class"` |
| `vm_exit_during_initialization()` | `compute_offset()` | javaClasses.cpp:~190 | 字段属性不匹配 (static vs non-static) | `"Invalid layout of preloaded class"` |
| `vm_exit_during_initialization()` | `TypeArrayKlass::allocate()` | typeArrayKlass.cpp:63 | Metaspace 分配失败 | `"Unable to allocate TypeArrayKlass"` |
| `vm_exit_during_initialization()` | `gc_barrier_stubs_init()` | javaClasses.cpp:4486 | GC barrier stub 分配失败 | JVM 内部错误 |
| `return false` | `universe_post_init()` | universe.cpp:1278 | VME 类链接失败 | `"Unable to link/verify VirtualMachineError class"` |

---

## §四 类型系统全链路数据流

```
init_globals() @ init.cpp:109
  │
  ├──[#18] universe2_init()       ──→ genesis: 8 TypeArrayKlass + SystemDictionary (§1)
  │     └── Universe::genesis()
  │           ├── allocate_fixup_lists() + compute_base_vtable_size() [§1.2]
  │           ├── 8× TypeArrayKlass::create_klass() [§1.3]
  │           │     ├── allocate(null_cld) → Metaspace 分配
  │           │     ├── add_class(ak) → CLD 类链表注册
  │           │     └── complete_create_array_klass() → super/interfaces
  │           ├── 5× 空元数据数组 [§1.2]
  │           ├── SystemDictionary::initialize() [§1.6]
  │           │     ├── classLoader_init2() → java.base ModuleEntry
  │           │     ├── 加载 Object → String → Class
  │           │     ├── String::compute_offsets() + Class::compute_offsets()
  │           │     ├── initialize_basic_type_mirrors() → 9 种 mirrors [§1.7]
  │           │     ├── fixup_mirrors() → 延迟 mirror 修复 [§1.8]
  │           │     ├── Reference 体系 + JSR 292 类
  │           │     └── 填充 _box_klasses[] (8 种装箱)
  │           ├── initialize_basic_type_klass() ×8 [§1.5]
  │           └── Object[] Klass + null_sentinel [§1.9]
  │
  ├──[#19] javaClasses_init()     ──→ 31 个核心类字段偏移计算 (§2)
  │     └── JavaClasses::compute_offsets()
  │           ├── PART1: String + Class (已在 genesis 中计算)
  │           └── PART2: 29× k::compute_offsets()  [§2.2]
  │                 ├── normal fields: FIELD_COMPUTE_OFFSET → compute_offset()
  │                 ├── injected fields: INJECTED_FIELD_COMPUTE_OFFSET [§2.5]
  │                 └── hardcoded offsets: String/Class/Reference 预置偏移
  │
  └──[#28] universe_post_init()   ──→ 6 阶段收尾 (§3)
        ├── reinitialize_vtable_of(Object) [§3.1] — 递归遍历继承树
        ├── reinitialize_itables() [§3.1] — 遍历所有已加载类
        ├── 预分配 11 种异常实例 [§3.2-3.3]
        │     ├── 6 种 OOM + NPE + ArithmeticException + 2× VME + SOE 消息
        │     └── PreallocatedOutOfMemoryErrorCount 个带 backtrace OOM
        ├── initialize_known_methods() [§3.4] — 6 个 LatestMethodCache
        ├── heap()->post_initialize() [§3.5] — GC 特定初始化
        └── MemoryService + CDS 收尾 [§3.5]
```

---

## §五 关键全局标志速查

| Flag | 默认值 | 位置 | 影响 |
|------|--------|------|------|
| `UseSharedSpaces` | true (CDS on) | product flag | §1 跳过 TypeArrayKlass 创建, §2 跳过 compute_offsets, §3 跳过 vtable 重初始化 |
| `PreallocatedOutOfMemoryErrorCount` | ~4 | JVM 常量 | §3.3 带 backtrace 的 OOM 预分配数量 |
| `StackTraceInThrowable` | true | product flag | §3.3 是否预分配 backtrace |
| `StackReservedPages` | 0 | product flag | §3.2 是否创建延迟 StackOverflow 消息 |
| `VerifySubSet` | "" | product flag | §3.5 选择性 VM 验证 |
| `FullGCALot` | false | develop flag | §1.9 genesis 中分配 dummy 对象数组（压力测试） |
| `HeapBaseMinAddress` | 2GB | product flag | genesis 前 Metaspace 保留虚拟地址空间，影响 CompressedOops |
| `PrintHeapAtSIGBREAK` | false | product flag | SIGBREAK 时打印堆信息——调试 genesis 失败时有用 |

---

## §六 诊断工具

```bash
# 1. 验证 genesis 入口
gdb -ex "break universe.cpp:323" -ex "run" -ex "bt" --args java -version

# 2. 查看 TypeArrayKlass
gdb -ex "break universe.cpp:323" -ex "run" -ex "finish" \
    -ex "print Universe::_intArrayKlassObj" --args java -version

# 3. 验证 _eetop_offset
gdb -ex "break javaClasses.cpp:1624" -ex "run" -ex "finish" \
    -ex "print java_lang_Thread::_eetop_offset" --args java -version

# 4. 查看预分配 OOM 数量
gdb -ex "break universe.cpp:1319" -ex "run" \
    -ex "print Universe::_preallocated_out_of_memory_error_avail_count" \
    --args java -version

# 5. 验证 vtable 重初始化
gdb -ex "break universe.cpp:574" -ex "run" \
    -ex "print ko->name()->as_C_string()" --args java -version

# 6. 检查所有 31 个 javaClass 偏移量
gdb -ex "break javaClasses.cpp:4597" -ex "run" -ex "finish" \
    -ex "print java_lang_Thread::_eetop_offset" \
    -ex "print java_lang_reflect_AccessibleObject::override_offset" \
    -ex "print java_lang_invoke_DirectMethodHandle::_member_offset" \
    -ex "print java_lang_invoke_ResolvedMethodName::_vmtarget_offset" \
    -ex "print java_security_AccessControlContext::_context_offset" \
    -ex "print java_lang_StackFrameInfo::_memberName_offset" \
    -ex "print java_lang_LiveStackFrameInfo::_monitors_offset" \
    -ex "print reflect_ConstantPool::_oop_offset" \
    -ex "print java_lang_reflect_Parameter::name_offset" \
    -ex "print java_lang_AssertionStatusDirectives::classes_offset" \
    --args java -version

# 7. 验证基本类型 mirrors
gdb -ex "break universe.cpp:508" -ex "run" \
    -ex "print Universe::_mirrors" --args java -version

# 8. 查看 fixup_mirror_list 大小
gdb -ex "break universe.cpp:521" -ex "run" \
    -ex "print java_lang_Class::_fixup_mirror_list->_len" --args java -version

# 9. 使用 strace 追踪系统调用
strace -e trace=mmap,mprotect java -version 2>&1 | head -20

# 10. 使用 jcmd 查看预分配异常状态
jcmd <pid> VM.info | grep -A 20 "OutOfMemoryError"
```

---

## §七 源码文件

| 文件 | 关键行号 | 内容 |
|------|---------|------|
| `src/hotspot/share/memory/universe.cpp` | :308-321 | `initialize_basic_type_klass()` |
| `src/hotspot/share/memory/universe.cpp` | :323-464 | `Universe::genesis()` |
| `src/hotspot/share/memory/universe.cpp` | :466-511 | `initialize_basic_type_mirrors()` — 9 种基本类型 mirror |
| `src/hotspot/share/memory/universe.cpp` | :513-526 | `fixup_mirrors()` — 延迟 mirror 修复 |
| `src/hotspot/share/memory/universe.cpp` | :574-584 | `reinitialize_vtable_of()` |
| `src/hotspot/share/memory/universe.cpp` | :617-654 | `gen_out_of_memory_error()` |
| `src/hotspot/share/memory/universe.cpp` | :1184-1218 | `initialize_known_methods()` |
| `src/hotspot/share/memory/universe.cpp` | :1220-1223 | `universe2_init()` |
| `src/hotspot/share/memory/universe.cpp` | :1230-1340 | `universe_post_init()` |
| `src/hotspot/share/oops/typeArrayKlass.cpp` | :58-99 | `create_klass()` + 构造函数 + layout_helper |
| `src/hotspot/share/classfile/systemDictionary.cpp` | :1937-2102 | `initialize()` + `resolve_well_known_classes()` |
| `src/hotspot/share/classfile/javaClasses.cpp` | :~185 | `compute_offset()` |
| `src/hotspot/share/classfile/javaClasses.cpp` | :2669-2691 | StackFrameInfo + LiveStackFrameInfo compute_offsets |
| `src/hotspot/share/classfile/javaClasses.cpp` | :2702-2705 | AccessibleObject compute_offsets |
| `src/hotspot/share/classfile/javaClasses.cpp` | :3201-3222 | ConstantPool + Parameter compute_offsets |
| `src/hotspot/share/classfile/javaClasses.cpp` | :3387-3390 | UnsafeStaticFieldAccessorImpl compute_offsets |
| `src/hotspot/share/classfile/javaClasses.cpp` | :3600-3603 | DirectMethodHandle compute_offsets |
| `src/hotspot/share/classfile/javaClasses.cpp` | :3663-3667 | ResolvedMethodName compute_offsets |
| `src/hotspot/share/classfile/javaClasses.cpp` | :3947-3963 | CallSiteContext compute_offsets + DependencyContext |
| `src/hotspot/share/classfile/javaClasses.cpp` | :3978-3982 | AccessControlContext compute_offsets |
| `src/hotspot/share/classfile/javaClasses.cpp` | :4366-4375 | AssertionStatusDirectives compute_offsets |
| `src/hotspot/share/classfile/javaClasses.cpp` | :4478-4601 | `compute_offsets()` + `javaClasses_init()` |
| `src/hotspot/share/classfile/javaClasses.hpp` | :50-85 | BASIC_JAVA_CLASSES_DO_PART1/PART2 宏 |

---

## §八 总结

类型系统三步初始化：genesis 创世（创建 8 TypeArrayKlass + SystemDictionary + 9 基本类型 mirrors）→ compute_offsets 计算 31 个核心类偏移量（在 Klass 上查找字段位置 + 注入字段）→ universe_post_init 收尾（重初始化 vtable + 预分配 11 种异常实例 + 缓存 6 个 known methods）。

1. **genesis**：在 Heap + Metaspace 基底上创建 8 种 TypeArrayKlass（三步工厂：allocate→add_class→complete）+ SystemDictionary（加载所有 WK_KLASS）+ 9 种基本类型 mirrors（含 void）+ fixup_mirrors 延迟修复 + Object[] Klass + null_sentinel。全局标志 `_bootstrapping=true` 期间的行为与运行时不同。

2. **compute_offsets**：31 个核心类（29 PART2 宏展开 + 2 PART1 提前计算）的 ~150+ 字段偏移量，通过 `find_local_field(name, sig)` 在 InstanceKlass 中查找。其中 11 个此前未覆盖的类包括：DirectMethodHandle/ResolvedMethodName/CallSiteContext（JSR 292 内部对象指针桥接）、AccessibleObject（反射访问控制）、StackFrameInfo/LiveStackFrameInfo（StackWalker+JVMTI）、AccessControlContext（安全上下文）、AssertionStatusDirectives（断言系统）、ConstantPool/UnsafeStaticFieldAccessorImpl（反射内省优化）、Parameter（方法参数反射）。14 个注入字段（intptr 类型存储 C++ 指针）构成 Java↔C++ 的隐藏桥接层。

3. **universe_post_init**：vtable 重初始化（genesis 时方法未加载，sibling 链表递归遍历）+ 11 种预分配异常（6 OOM + NPE + Arithmetic + 2 VME + SOE 消息）+ PreallocatedOutOfMemoryErrorCount 个带 backtrace OOM（lock-free 原子分配）+ 6 个 LatestMethodCache（idnum 索引支持 RedefineClasses）+ 堆后初始化 + MemoryService。

### 关键设计模式

| 模式 | 体现位置 | 为什么 |
|------|---------|--------|
| **方案：延迟初始化** | fixup_mirrors + vtable 重初始化 | 依赖未就绪时不能操作——先记录任务列表，等条件满足后批量执行 |
| **方案：预分配池** | 6 种 OOM 实例 + PreallocatedOOMCount 个 backtrace | OOM 时无法 new → 提前分配避免在堆满时触发分配 |
| **方案：双重兜底** | `_virtual_machine_error_instance` + `_vm_exception` | 第一个 VME 损坏时第二个作为 backup——"崩溃也要崩溃得体面" |
| **方案：原子计数器** | `Atomic::add(-1)` 在 OOM 分配 | 多线程同时 OOM → lock-free 分配避免自旋锁加重 GC 压力 |
| **方案：idnum 间接引用** | LatestMethodCache 用 method_idnum 而非 Method* | RedefineClasses 替换 Method* 但保留 idnum——缓存不失效 |
| **方案：注入字段** | 14 个注入字段存储 C++ 指针 (intptr) | Java 对象 ↔ C++ 指针的零封装桥接——字段对 Java 代码透明，不对 GC 暴露 |
| **方案：O(1) 索引表** | `_typeArrayKlassObjs[9]` + `_mirrors[9]` + `_box_klasses[8]` | BasicType 转 Klass/mirror 只需单次数组索引——无哈希查找，无分支预测 |
| **方案：三步工厂** | TypeArrayKlass::create_klass: allocate→add_class→complete | 分配与注册分离——allocate 失败可回滚，add_class 和 complete 无失败路径 |

### 子机制交互矩阵

| | genesis | compute_offsets | post_init |
|---------|---------|----------------|-----------|
| **GC** | 创建 null_cld (GC roots) | — | heap()->post_initialize() |
| **编译器** | compute_base_vtable_size (Compile_lock) | AbstractAssembler::update_delayed_values | Interpreter::initialize |
| **CDS** | 跳过 8 TypeArrayKlass + 5 空数组 | 跳过 29 compute_offsets | 跳过 vtable/itables |
| **JSR 292** | 加载 MethodHandle 类家族 | DMH/MemberName/RMN/LF/MT/CS/CSContext 偏移 | CallSite 依赖 via known methods |
| **JVM TI** | — | 早于 can_generate_early_vmstart | RedefineClasses 依赖 LatestMethodCache |
| **反射** | — | AccessibleObject/Method/Constructor/Field/Parameter/ConstantPool | — |
