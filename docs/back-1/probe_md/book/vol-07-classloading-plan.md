# 第七卷：类加载与反射 — 详细规划

> 覆盖 ClassLoader 体系（Bootstrap/Platform/App）、双亲委派、类加载 5 步、模块系统、反射、JNI、JVMTI
> 基于书籍框架 JVM-Source-Code-Book-Plan.md §一 第 30-33 章

---

## §〇 分析资产扫描

### 已完成的深度分析

| 文档 | 行数 | 覆盖内容 | 对第七卷的贡献 |
|------|:---:|---------|-------------|
| `01-jvm-startup/docs/22-ClassLoader-Init.md` | 1,045 | ClassLoader::initialize()：30 PerfData + 7 dlsym zip 函数 + bootstrap search path 构建 | 第 30 章底座：ClassPathEntry 三种实现、jimage mmap 管道 |
| `01-jvm-startup/docs/21-Universe-Type-System.md` | 1,212 | Klass 体系、typeArrayKlass、javaClasses_init（30 核心类字段偏移） | 第 31 章前置：类解析后的 Klass 创建与类型系统 |
| `01-jvm-startup/docs/10-JNIHandle-CompileQueue-JVMTI.md` | 1,194 | JNIHandleBlock 4 路径分配 + OopStorage + JVMTI agent 加载 | 第 33 章 JNI/JVMTI 部分底座 |
| `01-jvm-startup/docs/11-Stages5-10-Threads-And-ClassLoading.md` | 1,052 | Stage 6 17 java.lang 核心类加载 + Stage 9 模块系统 3 Phase | 第 30-32 章：核心类依赖顺序 + 模块初始化骨架 |
| `13-launcher/README.md` | ~800 | Java 层类加载关系表（LoadMainClass → FindClass） | 第 30 章：launcher 层 FindClass 触发时机 |
| `14-zip-jimage/README.md` | ~200 | jimage/ZIP 到 defineClass 的完整 I/O 管线 | 第 30 章：ClassPathEntry 物理字节读取管道 |

### 未被深度分析的源码区域（第七卷需要补齐）

| 源码区域 | 文件 | 总行数 | 状态 |
|---------|------|:---:|------|
| SystemDictionary 核心 | systemDictionary.cpp/hpp | 3,853 | **未分析** — 已有文档只提了 load_instance_class 入口名，未展开 5 步内部 |
| ClassLoaderData 体系 | classLoaderData.cpp/hpp | 2,100 | **未分析** — CLD 链表、Graph 迭代器、_packages/_modules 成员 |
| ClassFileParser | classFileParser.cpp/hpp | 7,028 | **未分析** — parseClassFile 完整 ~2000 行，常量池/字段/方法/属性解析 |
| 类链接 (LinkResolver) | linkResolver.cpp | 1,934 | **未分析** — 5 种 invoke 指令的静态/动态解析 |
| 类初始化 (<clinit>) | instanceKlass.cpp | ~3000 | **未分析** — initialize_impl() + 初始化锁 + 递归检查 |
| 类卸载 | classLoaderData.cpp | — | **未分析** — ClassLoaderDataGraph::do_unloading |
| 模块系统 (ModuleEntry) | moduleEntry.cpp/hpp + modules.cpp/hpp | 1,663 | **未分析** — ModuleEntryTable 哈希表 + 多版本 JAR 支持 |
| Package 系统 | packageEntry.cpp/hpp | 615 | **未分析** — PackageEntryTable + exported/concealed packages |
| 反射核心 | reflection.cpp | 1,311 | **未分析** — invoke_method + invoke_constructor + new_field/new_method |
| JNI 函数表 (231+ 条目) | jni.cpp:3560-3850 | ~300 | **未分析** — 每类函数的分组和薄封装模式 |
| JVM_ 类加载系列 | jvm.cpp:710-970 | ~260 | **未分析** — FindClassFromCaller→find_class_from_class_loader 桥接 |
| Dictionary/PlaceholderTable | dictionary.cpp + placeholders.cpp | 870 | **未分析** — 类的注册表 + 加载中的临时占位 |
| LoaderConstraints | loaderConstraints.cpp | 490 | **未分析** — 多类加载器约束检查 |
| KlassFactory | klassFactory.cpp | 236 | **未分析** — ClassFileParser → InstanceKlass 的工厂桥接 |
| Verifier | verifier.cpp | ~1000+ | **未分析** — 字节码类型安全验证 |
| JVMTI class events | jvmtiExport.cpp + jvmtiEnv.cpp | ~240K | **部分分析** — Phase 转变 + capabilities，但 class load/prepare/init 事件未展开 |
| **总计待分析** | | **~29,000+** | |

---

## §一 四章详细规划

### 第 30 章：类加载器体系 — ClassLoader 层次与 ClassPathEntry

> 30.1-30.7 共 7 节，预计文档 ~3,500 行

#### 30.1 ClassLoader 三层次：Bootstrap → Platform → App

**核心函数**：
- `SystemDictionary::compute_java_loaders()` @ `systemDictionary.cpp` — 创建 PlatformClassLoader + AppClassLoader
- `ClassLoader::_the_null_class_loader_data` @ `classLoaderData.hpp:221` — Bootstrap 的 CLD 实例
- `ClassLoaderDataGraph::_head → _next → ...` 链表结构 @ `classLoaderData.hpp:266`

**内部数据结构**：
- `ClassLoaderData` 成员表（21+ 字段）：`_class_loader` (OopHandle), `_holder` (WeakHandle), `_next` (CLD*), `_packages` (PackageEntryTable*), `_modules` (ModuleEntryTable*), `_dictionary` (Dictionary*), `_metaspace` (ClassLoaderMetaspace*), `_jmethod_ids` (JNIMethodBlock*)
- `ClassLoaderDataGraph` 静态工具类：`_head` (头节点), `classes_do()`, `methods_do()`, `dictionary_classes_do()`, `do_unloading()` (类卸载)

**Bootstrap 类加载器的特殊性**：
- `_the_null_class_loader_data` 不是 Java 对象 — `_class_loader` 为 NULL
- Bootstrap CLD 无 PackageEntryTable（JDK 8 兼容），但 JDK 9+ 有 _unnamed_module
- `java.lang.ClassLoader` Java 对象为 null（getClassLoader() 返回 null）

#### 30.2 ClassPathEntry：jimage / zip / directory 三种实现

**核心函数**：
- `ClassPathEntry` 虚基类：`open_stream()`, `open_entry()` @ `classLoader.hpp`
- `ClassPathImageEntry` (jimage)：`JIMAGE_Open` → `JIMAGE_FindResource` → `JIMAGE_GetResource`
- `ClassPathZipEntry` (zip/jar)：`(*ZipOpen)()` → `(*FindEntry)()` → `(*ReadEntry)()`
- `ClassPathDirEntry` (目录)：`os::stat` → `fopen` → `fread`
- `setup_bootstrap_search_path()` @ `classLoader.cpp:649` — 从 `sun.boot.class.path` 解析

**ClassPathEntry 链表结构**：
```
_first_entry → ClassPathEntry #1 → ... → _last_entry
_first_append_entry → appended entry #1 → ...
_jrt_entry  (单独指针，指向 jimage entry)
_exploded_entries (exploded build 路径链表)
```
每个 entry 的核心字段：`_name` (路径名), `_next` (链表)

**jimage 内部机制** (来自 14-zip-jimage 分析)：
- `libjimage.so` 的 6 个 dlsym 函数：`JIMAGE_Open`, `JIMAGE_Close`, `JIMAGE_PackageToModule`, `JIMAGE_FindResource`, `JIMAGE_GetResource`, `JIMAGE_ResourcesByName`
- `ImageFileReader` 内部：完美哈希 (O(1) 查找), `ImageStrings`, `ImageLocation`, `ImageDecompressor`
- 内存映射：`os::map_memory()` → `mmap` 整个 modules 文件到虚拟地址空间

#### 30.3 双亲委派机制

**核心函数**：
- `ClassLoader::load_class()` @ `classLoader.cpp:1498` — 三级查找：check loaded → parent → find_class
- `jvm_define_class_common()` @ `jvm.cpp:894` — Java 层的 defineClass 入口
- `KlassFactory::create_from_stream()` @ `klassFactory.cpp` — ClassFileStream → InstanceKlass

**完整调用链** (Class.forName("com.example.Foo")):
```
java.lang.Class.forName("com.example.Foo")
  → native: JVM_FindClassFromCaller          [jvm.cpp:795]
    → find_class_from_class_loader           [jvm.cpp:3591]
      → SystemDictionary::resolve_or_fail    [systemDictionary.cpp:199]
        → SystemDictionary::resolve_instance_class_or_null [systemDictionary.cpp:382]
          → Dictionary::find (检查已加载)     [dictionary.cpp]
          → PlaceholderTable::find_and_add (占位防重入) [placeholders.cpp]
          → ClassLoader::load_class           [classLoader.cpp:1498]
            → _first_entry->open_stream("com/example/Foo.class") [ClassPathEntry]
          → SystemDictionary::load_instance_class [systemDictionary.cpp:1426]
            → KlassFactory::create_from_stream  [klassFactory.cpp]
            → ClassFileParser::parseClassFile   [classFileParser.cpp]
            → define_instance_class             [systemDictionary.cpp:1582]
              → Dictionary::add_klass           [dictionary.cpp]
              → PlaceholderTable::find_and_remove
```

#### 30.4 Lazy 机制：启动时延迟创建路径条目

**来源**：`22-ClassLoader-Init.md` 已覆盖 classLoader_init1 三阶段

- `classLoader_init1()` → `ClassLoader::initialize()` 创建 PerfData + 加载 libzip.so + 设置搜索路径
- `classLoader_init2()` @ `classLoader.cpp:1853` — 在 SymbolTable 创建后设置 `_shared_archive` 等 CDS 路径
- 懒加载策略：`_first_entry` 只在首次 `load_class` 时创建；`_jrt_entry` 在 runtime image 模式上延迟创建

#### 30.5 CDS: Class Data Sharing 的归档与 mmap

**核心文件**：`classLoader.cpp` (CDS 部分), `systemDictionaryShared.cpp`, `compactHashtable.cpp`

- `FileMapInfo` - 共享归档文件的 mmap
- `MetaspaceShared` - 共享类的元空间映射
- `SystemDictionaryShared::find_or_load_shared_class()`
- `CompactHashtable` (compactHashtable.cpp 479 行)：共享归档中的哈希表布局

#### 30.6 ClassLoaderData 生命周期与类卸载

**核心函数**：
- `ClassLoaderData::add_class()` @ `classLoaderData.cpp`
- `ClassLoaderDataGraph::do_unloading()` @ `classLoaderData.cpp` — GC 时的类卸载
- `ClassLoaderDataGraph::purge()` — 清理已卸载的 CLD
- 卸载条件：`_keep_alive` 为 false + `_class_loader` oop 被 GC 回收

#### 30.7 诊断与调试

- `jcmd <pid> VM.classloader_stats` — `ClassLoaderStats` 输出
- `ClassLoaderHierarchyDCmd` (classLoaderHierarchyDCmd.cpp 500+ 行)：递归打印 CLD 树
- `-Xlog:class+load=info` — 每个类的加载来源
- `-Xlog:class+unload=info` — 类卸载追踪

---

### 第 31 章：类加载流程 — SystemDictionary 的 5 步加载

> 31.1-31.6 共 6 节，预计文档 ~4,000 行

#### 31.1 SystemDictionary：JVM 的"类注册表"

**核心数据结构** (来自 systemDictionary.hpp 736 行)：

| 成员 | 类型 | 作用 |
|------|------|------|
| `_dictionary` | `Dictionary*` (per CLD) | 该类加载器已加载的 InstanceKlass |
| `_placeholders` | `PlaceholderTable*` | 正在加载中的类占位（防并发重入） |
| `_shared_dictionary` | `Dictionary*` | CDS 共享归档中的类 |
| `_number_of_modifications` | `int` | 字典修改计数器（并发安全） |
| `_parallelCapable` 标记 | `bool` (per CLD) | 是否允许并行类加载 |
| `_vm_weak_oop_storage` | `OopStorage*` | VM 内部弱引用存储 |
| `WKID` 枚举 | >300 个枚举值 | 已知类 ID (java_lang_Object, java_lang_String, ...) |

**辅助表**：
- `PlaceholderTable` (placeholders.cpp 237 行)：类加载中状态 — `LOAD_INSTANCE` / `LOAD_SUPER` / `DEFINE_CLASS` 三状态
- `LoaderConstraintTable` (loaderConstraints.cpp 490 行)：不同 CLD 对同一类名的类型约束
- `ResolutionErrorTable` (resolutionErrors.cpp 137 行)：缓存已失败的类解析（避免重复抛 NoClassDefFoundError）
- `ProtectionDomainCacheTable` (protectionDomainCache.cpp 145 行)：ProtectionDomain 字典缓存

**已知类 (WKID) 快速查找**：
```cpp
// systemDictionary.hpp: WKID 枚举 + 内联快速查找
static Klass* Object_klass()     { return check_klass(_well_known_klasses[WK_KLASS_ENUM_NAME(Object_klass)]); }
static Klass* String_klass()     { return check_klass(_well_known_klasses[WK_KLASS_ENUM_NAME(String_klass)]); }
// ... ~200+ 已知类快速访问器
```
`_well_known_klasses` 数组在 `initialize_java_lang_classes()` 阶段填充 (thread.cpp:3822-3873)。

#### 31.2 load_instance_class：5 步加载详析

**入口**：`SystemDictionary::load_instance_class()` @ `systemDictionary.cpp:1426` (~160 行)

**5 步流程图**：
```
load_instance_class(Symbol* name, Handle class_loader)
│
├── Step 1: load — 读取 .class 字节
│   ├── ClassLoader::load_class(name, loader)  [classLoader.cpp:1498]
│   │   ├── 检查是否已加载 (Dictionary::find)
│   │   ├── 双亲委派: parent->loadClass(name)
│   │   └── find_class: ClassPathEntry 链表线性搜索
│   │       └── entry->open_stream() → ClassFileStream
│   └── 返回 ClassFileStream* 或 NULL
│
├── Step 2: parse — 解析 .class 字节 → InstanceKlass
│   ├── KlassFactory::create_from_stream(stream, name, loader) [klassFactory.cpp]
│   └── ClassFileParser::parseClassFile()  [classFileParser.cpp ~6475行]
│       ├── parse_magic_and_version       (magic=0xCAFEBABE)
│       ├── parse_constant_pool           (常量池 14 种 tag)
│       ├── parse_interfaces              (接口表)
│       ├── parse_fields                   (字段: access_flags + name + descriptor + attributes)
│       ├── parse_methods                  (方法: access_flags + code + exceptions + ...)
│       ├── parse_class_attributes         (类属性: SourceFile, EnclosingMethod, InnerClasses, BootstrapMethods)
│       └── fill_instance_klass            → 填充 InstanceKlass 内部字段
│
├── Step 3: verify — 字节码验证
│   ├── Verifier::verify() @ verifier.cpp (~1000行)
│   ├── 类型检查 (StackMapTable 验证)
│   └── 控制流分析 (基本块 + 异常处理)
│
├── Step 4: link — 链接 (prepare + resolve)
│   ├── InstanceKlass::link_class()  [instanceKlass.cpp]
│   │   ├── prepare: 计算 vtable/itable 大小, 分配方法数组
│   │   ├── rewrite: 常量池缓存重写 (Rewriter)
│   │   └── resolve: LinkResolver::resolve_* 系列
│   │       ├── resolve_invokevirtual/invokespecial/invokestatic
│   │       ├── resolve_invokeinterface
│   │       └── resolve_invokedynamic
│   └── LinkResolver 核心 : linkResolver.cpp (1934 行)
│
├── Step 5: initialize — 初始化 <clinit>
│   ├── InstanceKlass::initialize() → initialize_impl() [instanceKlass.cpp]
│   ├── 初始化锁: 线程安全的单次执行保证
│   ├── 递归检查: 检测 <clinit> 循环依赖 (ClassCircularityError)
│   └── 调用 <clinit> 方法 → Java 静态初始化块 + 静态字段赋值
│
└── 注册到 Dictionary + 更新 PlaceholderTable
```

**并行类加载**：
- `_parallelCapable` 标志：只有注册为 parallel capable 的类加载器允许多线程并行加载
- PlaceholderTable 的角色：`LOAD_INSTANCE` placeholder 防止同一类的并发重复加载
- `ObjectLocker` 保护：非 parallel capable 的类加载器使用全局锁

#### 31.3 双亲委派的内部实现

**源码追踪**（三层查找）：
```
ClassLoader::load_class(Symbol* name, Handle class_loader)  [classLoader.cpp:1498]
  ├── 第 1 层: 检查已加载 (JVM 内部)
  │   Dictionary::find(name, class_loader_data->dictionary())
  │   
  ├── 第 2 层: 双亲委派 (Java 层回调，在 load_instance_class 调用者中处理)
  │   由 java.lang.ClassLoader.loadClass() 在 Java 层实现双亲委派
  │   然后调用 findClass() → defineClass() → JVM_DefineClass
  │   
  └── 第 3 层: find_class (Bootstrap 层搜索)
      遍历 _first_entry → _next → ... 链表
      每个 entry->open_stream(name) 尝试读取
```

**为什么 JVM_DefineClass 不经过 SystemDictionary::resolve_or_fail？**
- `jvm_define_class_common()` @ `jvm.cpp:894` 直接调用 `SystemDictionary::parse_stream()` → `load_instance_class()` 内部逻辑
- 与 Class.forName 路径的关键区别：Class.forName 路径走 resolve_or_fail → resolve_instance_class_or_null → load_instance_class
- DefineClass 路径跳过 lookup 阶段，直接进入 parse + define

#### 31.4 类链接 (LinkResolver)

**核心函数** (linkResolver.cpp: 1934 行)：

| 函数 | 行号 | 字节码指令 | 解析逻辑 |
|------|:---:|----------|---------|
| `resolve_invokevirtual` | 1728 | `invokevirtual` | 虚方法分派：vtable 索引 |
| `resolve_invokespecial` | 1721 | `invokespecial` | 特殊方法：直接调用 + super |
| `resolve_static_call` | 1076 | `invokestatic` | 静态方法：类初始化检查 |
| `resolve_invokeinterface` | 1738 | `invokeinterface` | 接口方法：itable 索引 |
| `resolve_invokedynamic` | 1793 | `invokedynamic` | 动态调用点：BSM + CallSite |
| `resolve_invokehandle` | — | `invokehandle` | MethodHandle 调用 |

**LinkInfo** (CallInfo) 结构：`_resolved_klass`, `_name`, `_signature`, `_resolved_method`, `_selected_method`

#### 31.5 类初始化 (<clinit> 的线程安全执行)

**核心函数**：`InstanceKlass::initialize_impl()` @ `instanceKlass.cpp`

- 初始化状态机：`allocated → loaded → linked → being_initialized → fully_initialized → initialization_error`
- `init_state` 字段 @ `InstanceKlass`：使用 `OrderAccess::storestore()` 和 `load_acquire()` 保证可见性
- 初始化锁：`ObjectLocker(Handle(THREAD, class_loader))` 或 JNI 全局锁
- 递归检查：当前线程在 `<clinit>` 执行中再次请求同一类 → 允许 (JLS 12.4.2 步骤 4)
- 多线程等待：另一个线程正在执行 `<clinit>` → 当前线程调用 `ObjectLocker.wait()` 等待
- `<clinit>` 失败：状态设为 `initialization_error` → 后续请求抛 `NoClassDefFoundError` (ExceptionInInitializerError 包装)

#### 31.6 类卸载与 ClassLoaderDataGraph 的并发清理

**核心函数**：
- `ClassLoaderDataGraph::do_unloading()` — GC safepoint 时调用
- `ClassLoaderDataGraph::purge()` — 清理已卸载数据的 deferred list
- `Dictionary::do_unloading()` — 从字典中移除被卸载的类
- `SystemDictionary::do_unloading()` @ `systemDictionary.cpp`
- 卸载触发：`_class_loader` oop 不再可达 → `ClassLoaderData` 被标记为 dead → GC 清理 Metaspace chunks + Dictionary entries

---

### 第 32 章：JDK 9 模块系统 — ModuleEntryTable / PackageEntryTable

> 32.1-32.5 共 5 节，预计文档 ~3,000 行

#### 32.1 JDK 9 模块系统架构全景

**模块文件的格式**：
- `$JAVA_HOME/lib/modules` — jimage 格式的运行时镜像
- `module-info.class` — 每个模块的元数据（exports, requires, provides, uses）
- `--module-path` vs `--class-path` vs `--upgrade-module-path`

**模块系统的 C++ 层**：
- `ClassLoaderData::_modules` — 每个类加载器的 ModuleEntryTable
- `ClassLoaderData::_packages` — 每个类加载器的 PackageEntryTable
- `ClassLoaderData::_unnamed_module` — 无名模块（向后兼容 classpath）
- `SystemDictionary::_java_base_module` — java.base 模块引用

#### 32.2 ModuleEntryTable + PackageEntryTable 的内部数据结构

**ModuleEntry** (`moduleEntry.hpp:63-193`)：

```cpp
class ModuleEntry : public HashtableEntry<Symbol*, mtModule> {
  Symbol*     _module;          // 模块名 (e.g., "java.base")
  ModuleEntry* _next;           // 哈希表链表
  // 以下为额外成员
  oop         _module_oop;      // java.lang.Module Java 对象
  bool        _is_open;         // 是否 open module
  bool        _can_read_all_unnamed; // 是否可读无名模块
  GrowableArray<ModuleEntry*>* _reads;    // 可读模块列表
  GrowableArray<PackageEntry*>* _packages; // 导出的包列表
  // _version, _location 等元数据
};
```

**PackageEntry** (`packageEntry.hpp`)：

```cpp
class PackageEntry : public HashtableEntry<Symbol*, mtModule> {
  Symbol*       _name;          // 包名 (e.g., "java/lang")
  ModuleEntry*  _module;        // 所属模块
  bool          _is_exported;   // 是否 exported（vs concealed）
  bool          _is_exported_allUnnamed; // 是否对所有无名模块导出
  GrowableArray<ModuleEntry*>* _exported_pending_delete; // 延迟清理
};
```

**ModuleEntryTable** (`moduleEntry.hpp:208`)：
- 继承自 `Hashtable<Symbol*, mtModule>`
- `_javabase_module` 字段：快速访问 java.base 模块
- 方法：`lookup_only(Symbol*)`, `add_module()`, `purge_reads_for_unloaded_module()`
- 无锁查找 (lock-free lookup)

**PackageEntryTable** (`packageEntry.hpp`)：
- 继承自 `Hashtable<Symbol*, mtModule>`
- 方法：`lookup(Symbol*)`, `add_entry()`, `is_exported()`

#### 32.3 模块依赖图：readability + accessibility

**可读性 (Readability)**：
- `ModuleEntry::can_read(ModuleEntry* m)` → 检查 `_reads` GrowableArray
- `ModuleEntry::add_read(ModuleEntry* m)` → adds dependency
- 命名模块默认可读 `java.base`（由 `Modules::define_module()` 设置）

**可访问性 (Accessibility)**：
- `ModuleEntry::is_exported(Symbol* pkg, ModuleEntry* from)` → 包是否对指定模块导出
- `is_exported_allUnnamed` → 包对所有无名模块导出
- `ModuleEntry::is_exported_all()` → 包对所有模块导出
- `is_concealed()` → 包是否未导出（concealed package）

**服务绑定 (Service Binding)**：
- `ModuleEntry::_provides` — 模块提供的服务
- `ModuleEntry::_uses` — 模块使用的服务
- `Modules::add_module_exports/opens/reads/uses/provides()` 系列 @ `modules.cpp`

#### 32.4 模块的初始化：call_initPhase1/2/3

**三阶段 (来自 11-Stages5-10 分析)**：

```
Stage 9: 模块系统初始化
│
├── call_initPhase1()  @ thread.cpp:3773
│   └── System.initPhase1() — 创建模块层 (ModuleLayer)
│       构建 ModuleFinder → ModuleReader → ModuleDescriptor 解析
│
├── call_initPhase2()  @ thread.cpp:3791
│   └── System.initPhase2() — 解析 ModuleBootstrap (boot layer)
│       解析 java.base → java.se → java.xml → ...
│       构建 ModuleGraph (配置 → 解析 → 绑定)
│       ★ 失败是 Fatal: vm_exit_during_initialization(no message)
│
├── call_initPhase3()  @ thread.cpp:3815
│   └── System.initPhase3() — SecurityManager + SystemClassLoader
│       SystemClassLoader 赋值
│       SecurityManager 初始化框架
│
└── compute_java_loaders()  @ systemDictionary.cpp
    缓存 _java_platform_loader 和 _java_system_loader oop
```

**C++ 层模块定义**：
- `Modules::define_module()` @ `modules.cpp` — 在 C++ 层创建 ModuleEntry
- `Modules::add_module_exports()` — 注册模块导出
- `Modules::add_reads_module()` — 注册模块可读性
- `Modules::set_bootloader_unnamed_module()` — 无名模块 for Bootstrap

#### 32.5 无名模块 (Unnamed Module) 与向后兼容

**无名模块的特性**：
- `ClassLoaderData::_unnamed_module` — 每个类加载器一个
- `UnnamedModule` 可读所有命名模块（但命名模块不能读它）
- 无名模块的所有包默认为 `exported_allUnnamed`
- 无名模块的 `ModuleDescriptor` 为空

**classpath 上的类**：
- 从 classpath 加载的类 → 通过 `define_module(NULL)` → 无名模块
- `PackageEntry::set_exported_allUnnamed(true)` — 所有包对所有无名模块可见
- `can_read_all_unnamed` → 命名模块可以读所有无名模块

**Split Package 检测**：
- `Modules::check_cross_classloader_package_consistency()` — 跨类加载器 split package 警告
- `PackageEntry::is_qual_exported_to()` — 限定导出检查

---

### 第 33 章：反射、JNI 与 JVMTI

> 33.1-33.6 共 6 节，预计文档 ~3,500 行

#### 33.1 JNI 函数表：jni_NativeInterface 的 231 个函数指针

**函数表结构** (`jni.cpp:3560-3850`，~290 行)：

```cpp
struct JNINativeInterface_ jni_NativeInterface = {
    NULL, NULL, NULL, NULL,              // 4 个保留槽位
    jni_GetVersion,                      // 版本查询
    jni_DefineClass,                     // 类定义
    jni_FindClass,                       // 类查找
    jni_FromReflectedMethod,             // Method → jmethodID
    jni_FromReflectedField,              // Field → jfieldID
    jni_ToReflectedMethod,               // jmethodID → Method
    jni_GetSuperclass,                   // 父类
    jni_IsAssignableFrom,                // 类型判定的
    jni_ToReflectedField,                // jfieldID → Field
    jni_Throw, jni_ThrowNew,            // 异常
    jni_ExceptionOccurred, jni_ExceptionDescribe, jni_ExceptionClear, jni_FatalError,
    jni_PushLocalFrame, jni_PopLocalFrame, // local frame
    jni_NewGlobalRef, jni_DeleteGlobalRef, jni_DeleteLocalRef, jni_IsSameObject,
    jni_NewLocalRef, jni_EnsureLocalCapacity,
    jni_AllocObject,                     // 对象分配
    jni_NewObject, jni_NewObjectV, jni_NewObjectA,
    jni_GetObjectClass, jni_IsInstanceOf,
    jni_GetMethodID,                     // 方法 ID
    jni_CallObjectMethod, jni_CallObjectMethodV, jni_CallObjectMethodA,  // 方法调用 (10 种返回类型 × 3 变体)
    jni_CallBooleanMethod, /* ... */
    jni_CallStaticObjectMethod, /* ... */
    jni_GetFieldID,                      // 字段 ID
    jni_GetObjectField, /* ... */        // 字段访问 (10 种类型)
    jni_SetObjectField, /* ... */
    jni_GetStaticFieldID, jni_GetStaticObjectField, /* ... */
    jni_NewString,                       // 字符串
    jni_GetStringLength, jni_GetStringChars, jni_ReleaseStringChars,
    jni_NewStringUTF, jni_GetStringUTFLength, jni_GetStringUTFChars, jni_ReleaseStringUTFChars,
    jni_GetArrayLength,                  // 数组
    jni_NewObjectArray, jni_GetObjectArrayElement, jni_SetObjectArrayElement,
    jni_New<Primitive>Array, /* ... */   // 基本类型数组
    jni_Get<Primitive>ArrayElements, jni_Release<Primitive>ArrayElements,
    jni_Get<Primitive>ArrayRegion, jni_Set<Primitive>ArrayRegion,
    jni_RegisterNatives, jni_UnregisterNatives, // 原生方法注册
    jni_MonitorEnter, jni_MonitorExit,   // 同步
    jni_GetJavaVM,                       // JavaVM 引用
    jni_GetStringRegion, jni_GetStringUTFRegion,
    jni_GetPrimitiveArrayCritical, jni_ReleasePrimitiveArrayCritical,
    jni_GetStringCritical, jni_ReleaseStringCritical,
    jni_NewWeakGlobalRef, jni_DeleteWeakGlobalRef,
    jni_ExceptionCheck,
    jni_NewDirectByteBuffer, jni_GetDirectBufferAddress, jni_GetDirectBufferCapacity,
    jni_GetObjectRefType,                // JNI 1.6+
    jni_GetModule,                       // JNI 9+
    jni_IsVirtualThread,                 // JNI 19+
};
```

**函数分组**（按功能）：
1. 版本信息 (1 个)
2. 类操作 (5 个)：DefineClass, FindClass, GetSuperclass, IsAssignableFrom
3. 异常 (5 个)
4. 全局/局部引用 (6 个)
5. 对象操作 (4 个)
6. 方法调用 (Call*Method, CallStatic*Method, CallNonvirtual*Method ~30 个)
7. 字段访问 (Get*Field, Set*Field ~48 个)
8. 静态字段访问 (GetStatic*Field, SetStatic*Field ~48 个)
9. 字符串 (8 个)
10. 数组 (GetArrayLength + NewArray + Get/Set + Get/Release + Region ~40 个)
11. 原生方法注册 (2 个)
12. 监视器 (2 个)
13. NIO 支持 (3 个)
14. 弱引用 (2 个)
15. 模块 (1 个，JNI 9+)

**jni_fast_GetField 优化 (jniFastGetField.cpp 49 行 + jni.cpp:3844-3906)**：
- `copy_jni_function_table()` — 运行时替换 GetField 函数指针为快速版本
- 使用 JNI 快速版本的 8 种基本类型：`GetBooleanField`, `GetByteField`, `GetCharField`, `GetShortField`, `GetIntField`, `GetLongField`, `GetFloatField`, `GetDoubleField`
- 条件：`UseFastJNIAccessors` + JVMTI 未启用 + 有信号处理器

#### 33.2 JNI 调用的薄封装模式

**jni.h 声明 + jni.cpp 实现 + jvm.cpp 后端**（三层架构）：

```
Java 代码: env->FindClass("java/lang/String")
    │
    ├── jni.h: jni_NativeInterface 函数表 (编译时绑定)
    │   JNIEXPORT jclass JNICALL FindClass(JNIEnv *env, const char *name) {
    │       return env->functions->FindClass(env, name);
    │   }
    │
    └── jni.cpp: jni_FindClass 包装函数
        JNI_ENTRY(jclass, jni_FindClass(JNIEnv *env, const char *name))
          → find_class_from_class_loader(env, symbol, false, loader, prot, true, thread)
            → SystemDictionary::resolve_or_fail(symbol, loader, prot, true, thread)
              → JNIHandles::make_local(env, klass->java_mirror())
```

**JNI_ENTRY / JNI_END 宏**（`jni.cpp` 头部的宏定义）：
- `JNI_ENTRY` — 设置 JavaThread*, ResourceMark, HandleMark, JNIHandleBlock
- `JNI_LEAF` — leaf 函数：无 safepoint，无 GC，无 JNI 本地帧
- `JNI_END` — 清理资源，返回值

#### 33.3 反射：Method::invoke 的 JNI 路径

**完整调用链**：
```
java.lang.reflect.Method.invoke(obj, args)
  ↓
  → native: JVM_InvokeMethod                [jvm.cpp:3607]
    → Reflection::invoke_method             [reflection.cpp:1259]
      → invoke() 内部函数                   [reflection.cpp:1074]
        ├── 参数展开: unbox + widen + cast
        │   Reflection::unbox_for_primitive()
        │   Reflection::widen()             类型提升
        │   Reflection::array_get/set()     参数提取
        ├── 方法选择
        │   Reflection::resolve_method()    方法签名匹配
        │   LinkResolver::resolve_method()  解析虚方法
        ├── 调用执行
        │   JavaCalls::call(result, method, args, CHECK)   [javaCalls.cpp]
        │     → method->from_interpreted()? Interpreter::invoke : c2i_adapter
        │     → 解释执行 / 编译代码执行
        ├── 返回值包装
        │   Reflection::box(value, return_type)
        └── JVMTI 事件
            JvmtiExport::post_vm_object_alloc()  (基本类型 boxing)
```

**Reflection::new_method / new_field / new_constructor**：
- 将 HotSpot 内部 `Method*` / `fieldDescriptor` 包装为 Java `java.lang.reflect.Method` / `Field` 对象
- `java_lang_reflect_Method::create()` / `java_lang_reflect_Field::create()` 在 javaClasses.cpp 中

**Reflection::invoke_method vs invoke_constructor**：
- 共享内部函数 `invoke()`，参数 `is_method_invoke` 区分
- 构造函数总是返回 `void` → receiver 是最新创建的 `klass->allocate_instance()`
- 方法调用返回类型由 `return_type()` 决定

#### 33.4 Unsafe: sun.misc.Unsafe 的 C++ 后端

**核心文件**：`unsafe.cpp` (798 行), `unsafe.hpp` (42 行)

- `Unsafe_DefineAnonymousClass` — 匿名类定义（Lambda 使用）
- `Unsafe_AllocateInstance` — 绕过构造函数的对象分配
- `Unsafe_CompareAndSwapInt/Long/Object` — CAS 操作
- `Unsafe_PutObjectVolatile / GetObjectVolatile` — 内存屏障保证
- `Unsafe_GetUnsafe` — 单例获取（Bootstrap 类加载器检查）
- `Unsafe_DefineClass0` — 类重新定义
- 字段偏移量缓存：`Unsafe_ObjectFieldOffset` — 使用 `javaClasses.cpp` 中的固定偏移量

#### 33.5 JVMCI: JVM Compiler Interface (Graal 的后端)

**相关文件**：`jvmciCompiler.cpp/hpp`, `jvmciCompilerToVM.cpp`, `jvmciRuntime.cpp`

- JVMCI 允许用 Java 编写的 JIT 编译器（如 Graal）与 HotSpot 交互
- `CompilerToVM` — 提供 ~200 个 native 方法给 Java 编译器
- 热方法替换：JVMCI 编译的 nmethod 通过 `nmethod::make_not_entrant()` 替换
- `JVMCIEnv::initialize()` — 创建 JVMCI 编译器线程池

#### 33.6 JVMTI: 类加载事件 + capabilities + agent 加载

**核心文件**：`jvmtiExport.cpp` (3,005 行), `jvmtiEnv.cpp` (3,500+ 行), `jvmtiEnvBase.cpp` (1,400 行), `jvmti.xml` (13,800 行)

**类加载相关事件**：
- `ClassFileLoadHook` — .class 字节修改（retransform/redefine 使用）
- `ClassLoad` — 类加载完成
- `ClassPrepare` — 类链接完成（方法可以调用）
- `VMInit` — JVM Live Phase 进入
- `VMStart` — JVM 启动（early agent 回调）

**Event Controller** (`jvmtiEventController.cpp` 1,050 行)：
- 事件使能位图 (`jvmtiEventEnabled[]`)
- 线程级事件钩子
- `JvmtiEventController::set_event_callbacks(env, callbacks, size_of_callbacks)`

**Capabilities** (`jvmtiManageCapabilities.cpp` 460 行)：
- `can_retransform_classes` — 允许 ClassFileLoadHook + retransform
- `can_redefine_classes` — 允许 redefine (热替换)
- `can_tag_objects` — 允许 SetTag/GetTag
- `can_generate_all_class_hook_events` — 全局 hook
- `can_get_bytecodes` / `can_get_constant_pool` — 允许读取字节码/常量池

**Agent 加载** (已在 01-jvm-startup 中覆盖)：
- Stage 3 Agent: `create_vm_init_agents()` → `dlopen` → `dlsym("Agent_OnLoad")` → `Agent_OnLoad(vm, options)`
- Late attach: `AttachListener::init()` → UNIX socket → `Agent_OnAttach`
- JvmtiEnv 魔术数 `0x71EE` + 5 阶段状态机
- `JvmtiEnvBase` 持有：事件回调表 + capabilities 位图 + 版本号

---

## §二 源文件映射表

### 第 30 章：类加载器体系

| 源文件 | 行数 | 角色 | 关键函数/类 |
|--------|:---:|------|-----------|
| `share/classfile/classLoader.cpp` | 2,254 | ClassPathEntry + 类加载搜索 | `load_class()`, `ClassPathImageEntry`, `ClassPathZipEntry`, `ClassPathDirEntry` |
| `share/classfile/classLoader.hpp` | 635 | ClassPathEntry 接口定义 | `ClassPathEntry`, `LazyClassPathEntry` |
| `share/classfile/classLoader.inline.hpp` | 97 | 内联方法 | — |
| `share/classfile/classLoaderData.cpp` | 1,644 | CLD 生命周期 + Graph | `ClassLoaderDataGraph::do_unloading()`, `add_class()` |
| `share/classfile/classLoaderData.hpp` | 456 | CLD 数据结构定义 | `_class_loader`, `_packages`, `_modules`, `_dictionary`, `_next` |
| `share/classfile/classLoaderData.inline.hpp` | 100 | 内联方法 | — |
| `share/classfile/classLoaderExt.cpp` | 354 | 扩展路径处理 | `process_module_table()` |
| `share/classfile/classLoaderExt.hpp` | 149 | — | — |
| `share/classfile/classLoaderHierarchyDCmd.cpp` | 451 | jcmd 诊断命令 | ClassLoaderStats 递归打印 |
| `share/classfile/classLoaderStats.cpp` | 151 | 统计信息 | — |
| `share/classfile/compactHashtable.cpp` | 424 | CDS 共享哈希表 | — |
| `share/classfile/sharedPathsMiscInfo.cpp` | 239 | 共享路径信息 | — |
| `share/prims/jvm.cpp` (部分) | 710-970 | JVM_ 类加载入口 | `JVM_FindClassFromCaller`, `JVM_DefineClass`, `JVM_FindLoadedClass` |

### 第 31 章：类加载流程

| 源文件 | 行数 | 角色 | 关键函数/类 |
|--------|:---:|------|-----------|
| `share/classfile/systemDictionary.cpp` | 3,117 | 类注册表 + 5 步加载 | `resolve_or_fail()`, `load_instance_class()`, `define_instance_class()` |
| `share/classfile/systemDictionary.hpp` | 736 | WKID 枚举 + 辅助表 | `_well_known_klasses`, `WK_KLASS_ENUM_NAME` |
| `share/classfile/systemDictionaryShared.cpp` | ~300 | CDS 共享类 | `find_or_load_shared_class()` |
| `share/classfile/dictionary.cpp` | 633 | 类字典 (Hashtable) | `find()`, `add_klass()`, `do_unloading()` |
| `share/classfile/dictionary.hpp` | 296 | Dictionary 定义 | `DictionaryEntry` |
| `share/classfile/placeholders.cpp` | 237 | 加载中占位表 | `PlaceholderTable::find_and_add()`, `find_and_remove()` |
| `share/classfile/placeholders.hpp` | 326 | PlaceholderTable 定义 | `PlaceholderEntry: LOAD_INSTANCE/LOAD_SUPER/DEFINE_CLASS` |
| `share/classfile/loaderConstraints.cpp` | 490 | 跨 CLD 约束检查 | `add_constraint()`, `check_constraint()` |
| `share/classfile/loaderConstraints.hpp` | 121 | — | `LoaderConstraintEntry` |
| `share/classfile/resolutionErrors.cpp` | 137 | 解析失败缓存 | `record()`, `find()` |
| `share/classfile/protectionDomainCache.cpp` | 145 | ProtectionDomain 缓存 | — |
| `share/classfile/classFileParser.cpp` | 6,475 | .class 字节解析 | `parseClassFile()`, `parse_constant_pool()`, `parse_fields()`, `parse_methods()` |
| `share/classfile/classFileParser.hpp` | 553 | ClassFileParser 定义 | `ClassFileParser::parseClassFile()` |
| `share/classfile/classFileStream.cpp` | 136 | .class 字节流 | `ClassFileStream` |
| `share/classfile/klassFactory.cpp` | 236 | 解析→Klass 桥接 | `KlassFactory::create_from_stream()` |
| `share/interpreter/linkResolver.cpp` | 1,934 | 类链接解析 | `resolve_invokevirtual/special/static/interface/dynamic` |
| `share/classfile/verifier.cpp` | ~1,000+ | 字节码验证 | `Verifier::verify()` |
| `share/classfile/verificationType.cpp` | ~500 | 验证类型 | — |
| `share/classfile/stackMapTable.cpp` | ~1,000 | StackMapTable 验证 | — |
| `share/classfile/defaultMethods.cpp` | 1,139 | 默认方法处理 | — |
| `share/oops/instanceKlass.cpp` (部分) | ~3,000 | 初始化 + 锁 + 状态机 | `initialize()`, `initialize_impl()`, `link_class()` |
| `share/oops/instanceKlass.hpp` | — | InstanceKlass 定义 | `_init_state`, `_init_thread` |

### 第 32 章：模块系统

| 源文件 | 行数 | 角色 | 关键函数/类 |
|--------|:---:|------|-----------|
| `share/classfile/moduleEntry.cpp` | 538 | 模块条目实现 | `ModuleEntry::can_read()`, `is_named()`, `set_can_read_all_unnamed()` |
| `share/classfile/moduleEntry.hpp` | 267 | 模块数据结构定义 | `ModuleEntry`, `ModuleEntryTable` |
| `share/classfile/packageEntry.cpp` | 365 | 包条目实现 | `PackageEntry::is_exported()`, `set_exported()` |
| `share/classfile/packageEntry.hpp` | 308 | 包数据结构定义 | `PackageEntry`, `PackageEntryTable` |
| `share/classfile/modules.cpp` | 729 | 模块操作 (JVM_ 后端) | `Modules::define_module()`, `add_module_exports()`, `add_reads_module()` |
| `share/classfile/modules.hpp` | 129 | Modules 类定义 | — |
| `share/classfile/classLoaderData.hpp` (部分) | — | CLD 中的模块/包引用 | `_modules`, `_packages`, `_unnamed_module` |
| `share/runtime/thread.cpp` (部分) | 3773-3815 | 模块初始化 3 Phase 调用 | `call_initPhase1/2/3()` |

### 第 33 章：反射、JNI 与 JVMTI

| 源文件 | 行数 | 角色 | 关键函数/类 |
|--------|:---:|------|-----------|
| `share/prims/jni.cpp` (部分) | 3560-3917 | JNI 函数表 + 薄封装 | `jni_NativeInterface` (231 函数), `JNI_ENTRY/JNI_LEAF/JNI_END` 宏 |
| `share/prims/jni.hpp` | ~100 | JNI 头文件 | `JNI_ENTRY`, `JNI_LEAF` 宏定义 |
| `share/prims/jniCheck.cpp` | 2,210 | JNI 参数检查模式 | `checked_jni_*` 函数 |
| `share/prims/jniFastGetField.cpp` | 48 | 快速字段访问 | `jni_fast_Get*Field` 优化 |
| `share/prims/jvm.cpp` (部分) | 3600-3660 | 反射入口 | `JVM_InvokeMethod`, `JVM_NewInstanceFromConstructor` |
| `share/runtime/reflection.cpp` | 1,311 | 反射核心实现 | `invoke_method()`, `invoke_constructor()`, `new_method()`, `new_field()`, `new_constructor()` |
| `share/runtime/reflection.hpp` | ~200 | Reflection 类定义 | — |
| `share/prims/unsafe.cpp` | 798 | Unsafe 后端 | `Unsafe_DefineAnonymousClass`, `Unsafe_AllocateInstance`, CAS |
| `share/prims/methodHandles.cpp` | 1,752 | MethodHandles 调用 | `MethodHandles::generate_adapters()` |
| `share/prims/nativeLookup.cpp` | 634 | JNI 原生方法查找 | `NativeLookup::lookup()`, `lookup_base_method()` |
| `share/prims/jvmtiExport.cpp` (部分) | — | JVMTI 事件回调 | `post_class_load()`, `post_class_prepare()`, `ClassFileLoadHook` |
| `share/prims/jvmtiEnv.cpp` (部分) | — | JVMTI Env 实现 | `JvmtiEnv::GetLoadedClasses()`, `RetransformClasses()`, `RedefineClasses()` |
| `share/prims/jvmtiEnvBase.cpp` (部分) | — | JvmtiEnv 基础设施 | `JvmtiEnvBase` 类定义 |
| `share/prims/jvmtiManageCapabilities.cpp` | 460 | Capabilities 管理 | `JvmtiManageCapabilities::get_potential_capabilities()` |
| `share/prims/jvmtiEventController.cpp` | 1,050 | 事件开关管理 | `JvmtiEventController::set_event_callbacks()` |
| `share/prims/jvmtiRedefineClasses.cpp` | 4,640 | 类重定义 (热替换) | VM_RedefineClasses |
| `share/prims/jvmtiClassFileReconstituter.cpp` | 891 | 还原 .class 文件 | ClassFileReconstituter |

---

## §三 完整调用链 (Class.forName → InstanceKlass)

### 场景 1: Class.forName("com.example.Foo") — 用户代码触发的类加载

```
Java: Class.forName("com.example.Foo")
  │
  ├── native: JVM_FindClassFromCaller(env, "com.example.Foo", true, callerCL, callerClass)
  │   │                                                   [jvm.cpp:795]
  │   │   ├── TempNewSymbol h_name = SymbolTable::new_symbol("com.example.Foo")
  │   │   ├── 解析 caller + class_loader → protection_domain
  │   │   └── find_class_from_class_loader(env, h_name, true, h_loader, h_prot, false, THREAD)
  │
  ├── SystemDictionary::resolve_or_fail(name, loader, prot, false)
  │   │                                                [systemDictionary.cpp:199]
  │   │   ├── 处理数组类: 递归调用 array_klass()
  │   │   └── resolve_instance_class_or_null(name, loader, prot, THREAD)
  │   │                                                [systemDictionary.cpp:382]
  │   │
  │   │   ┌─ Step 1: Dictionary::find(name, loader_data->dictionary())
  │   │   │   已加载? → 直接返回 (快速路径)
  │   │   │
  │   │   ├─ Step 2: PlaceholderTable::find_and_add() 
  │   │   │   反重入: 另一线程正在加载此类?
  │   │   │   ├── LOAD_INSTANCE 占位: 等待 (ObjectLocker::wait)
  │   │   │   └── 新占位: 继续
  │   │   │
  │   │   ├─ Step 3: SharedDictionary (CDS)
  │   │   │   find_shared_class(name) → 从归档加载
  │   │   │
  │   │   └─ Step 4: load_instance_class(name, loader)
  │   │       │                                    [systemDictionary.cpp:1426]
  │   │       │   ├── ClassLoader::load_class(name, loader)
  │   │       │   │                                [classLoader.cpp:1498]
  │   │       │   │   ├── 检查已加载 (Dictionary::find)
  │   │       │   │   ├── 双亲委派 (parent->loadClass)
  │   │       │   │   └── find_class (遍历 ClassPathEntry 链表)
  │   │       │   │       ├── ClassPathImageEntry::open_stream()
  │   │       │   │       │   JIMAGE_FindResource + JIMAGE_GetResource
  │   │       │   │       ├── ClassPathZipEntry::open_stream()
  │   │       │   │       │   ZIP_FindEntry + ZIP_ReadEntry
  │   │       │   │       └── ClassPathDirEntry::open_stream()
  │   │       │   │           os::stat + fopen + fread
  │   │       │   │
  │   │       │   ├── KlassFactory::create_from_stream(stream, name, loader)
  │   │       │   │                                [klassFactory.cpp]
  │   │       │   │   └── ClassFileParser::parseClassFile()
  │   │       │   │                                    [classFileParser.cpp]
  │   │       │   │       ├── parseClassFile() — 主入口 ~2000行
  │   │       │   │       ├── parse_constant_pool() — 14 种 cp tag
  │   │       │   │       ├── parse_interfaces() — 接口数组
  │   │       │   │       ├── parse_fields() — 字段信息
  │   │       │   │       ├── parse_methods() — 方法 + Code 属性
  │   │       │   │       ├── parse_class_attributes() — 类属性
  │   │       │   │       └── fill_instance_klass() → InstanceKlass 对象
  │   │       │   │
  │   │       │   └── define_instance_class(k)
  │   │       │                                    [systemDictionary.cpp:1582]
  │   │       │       ├── 约束检查 (LoaderConstraintTable)
  │   │       │       ├── 模块一致性检查
  │   │       │       ├── Dictionary::add_klass(name, d_hash, k)
  │   │       │       └── PlaceholderTable::find_and_remove()
  │   │       │
  │   │       └── 类初始化 (如 init=true)
  │   │           klass->initialize(CHECK_NULL)
  │   │             [instanceKlass.cpp]
  │   │             ├── link_class() — 如果未链接
  │   │             │   ├── InstanceKlass::link_class_impl()
  │   │             │   │   ├── prepare: vtable/itable 分配
  │   │             │   │   ├── Method::link_method (方法链接)
  │   │             │   │   └── rewrite: MethodRewriter
  │   │             │   └── Verifier::verify() — 如果未验证
  │   │             └── initialize_impl()
  │   │                 ├── 获取初始化锁
  │   │                 ├── 递归检查 (<clinit> 循环)
  │   │                 ├── 调用 <clinit> 方法
  │   │                 └── 状态 → fully_initialized
  │   │
  │   └── return klass
  │
  └── JNIHandles::make_local(env, klass->java_mirror())
      → 返回 jclass (Java 层 Class<?> 对象)
```

### 场景 2: ClassLoader.defineClass → JVM_DefineClass — 自定义类加载器路径

```
Java: MyClassLoader.defineClass(name, bytes, off, len)
  │
  ├── native: Java_java_lang_ClassLoader_defineClass1()
  │                                                [ClassLoader.c:76]
  │   └── JVM_DefineClass(env, name, loader, bytes, len, pd)
  │
  ├── jvm_define_class_common()                    [jvm.cpp:893]
  │     ├── 参数检查 (name, len, loader)
  │     ├── ClassFileStream st((u1*)buf, len, source)
  │     ├── SystemDictionary::resolve_from_stream()
  │     │   └── (内部走 parseClassFile → fill_instance_klass)
  │     └── (不经过 ClassLoader::load_class 搜索)
  │
  └── (与 Class.forName 路径合并到 define_instance_class)
```

### 场景 3: 反射调用 — Method.invoke() 的执行路径

```
Java: method.invoke(obj, args)
  │
  ├── native: JVM_InvokeMethod(env, method, obj, args)
  │                                                [jvm.cpp:3607]
  │
  ├── Reflection::invoke_method(method_mirror, receiver, args)
  │                                                [reflection.cpp:1259]
  │   ├── 从方法反射对象提取 InstanceKlass + MethodHandle
  │   └── invoke(klass, method, receiver, override, ptypes, rtype, args, true)
  │                                                [reflection.cpp:1074]
  │       │
  │       ├── 访问检查 (Method::is_public / override)
  │       │   Reflection::verify_member_access()
  │       │
  │       ├── 参数展开
  │       │   ├── unbox_for_primitive / unbox_for_regular_object
  │       │   ├── widen (类型提升: int→long, float→double)
  │       │   └── 参数数组构建 (GrowableArray)
  │       │
  │       ├── 方法分派 (虚方法)
  │       │   ├── method->is_static()? 直接调用
  │       │   ├── klass->is_interface()? LinkResolver::resolve_interface_call()
  │       │   └── 否则: LinkResolver::resolve_virtual_call()
  │       │       → vtable 索引查找
  │       │
  │       └── JavaCalls::call(result, method, args)
  │           │                                    [javaCalls.cpp]
  │           ├── method->from_compiled_entry() — 是否已编译
  │           ├── from_compiled? → 直接跳转编译代码
  │           └── from_interpreted? → Interpreter::invoke 解释执行
  │
  ├── 返回值包装: Reflection::box(value, return_type)
  └── JvmtiExport::post_vm_object_alloc() — 基本类型 boxing 通知
```

---

## §四 需新建 Phase 的源码区域分析

### 现有 Phase 覆盖情况

| 子主题 | 已有碎片分析 | 需系统化覆盖 | 建议 |
|--------|:----------:|:----------:|------|
| ClassPathEntry 三种实现 | 01 doc-22 (部分) + 14 (jimage) | SystemDictionary 完整 5 步 | 新建 Phase classfile |
| SystemDictionary | 01 doc-11 (调用入口名) | resolve/load/define 全流程 | 同上 |
| ClassFileParser | 未分析 | parseClassFile ~2000 行 | 同上 |
| ClassLoaderData | 01 doc-22 (CLD _head) | Graph 链表 + 卸载 | 同上 |
| ModuleEntry/PackageEntry | 01 doc-11 (模块 3 Phase) | 内部数据结构 + 依赖图 | 同上 |
| PlaceholderTable | 未分析 | 并发类加载防重入 | 同上 |
| LinkResolver | 未分析 | 5 种 invoke 解析 | 同上 |
| Reflection | 未分析 | invoke_method 完整调用链 | 同上 |
| JNI 函数表 | 偏移表提及 | 231 函数分组 + 薄封装模式 | 同上 |
| Verifier | 未分析 | 字节码类型安全验证 | 同上 |
| 类初始化 | 未分析 | initialize_impl + <clinit> 线程安全 | 同上 |
| ClassFileLoadHook (JVMTI) | 部分 | retransform + redefine 全流程 | 同上 |

### 评估结论

**优先级**：第七卷覆盖 ~29,000+ 行未分析源码。这些大部分属于 `classfile/` 目录，可分 1-2 个 Phase 系统化分析：
- **Phase classfile-1**：SystemDictionary + ClassFileParser + ClassLoaderData（类加载核心）
- **Phase classfile-2**：模块系统 + LinkResolver + Reflection + JNI table + JVMTI class events

或合并为单个 **Phase classfile**（约 15-25 篇 prompt + 文档）。

---

## §五 写作策略与建议

### 推荐的生成方式

1. **先 Phase 分析后书籍化**：先新建 Phase 对 classfile 目录做系统化 prompt → 文档生成，然后把分析结果转入书籍第七卷
2. **复用分析**：第 30 章大量复用 01-jvm-startup doc-22 + 14-zip-jimage 分析资产
3. **渐进式覆盖**：先写第 30-31 章（类加载核心），再写第 32 章（模块系统），最后第 33 章（反射/JNI）

### 各章复杂度预估

| 章 | 节数 | 核心源文件行数 | 预估文档行数 | 难度 |
|:---:|:---:|:---:|:---:|:---:|
| 30 — 类加载器体系 | 7 | 6,500 | ~3,500 | 中 (大量复用已有分析) |
| 31 — 类加载流程 | 6 | 14,000 | ~4,000 | 高 (SystemDictionary + ClassFileParser + LinkResolver 三大核心) |
| 32 — 模块系统 | 5 | 2,200 | ~3,000 | 中 (JDK 9 新特性，数据结构清晰) |
| 33 — 反射/JNI/JVMTI | 6 | 7,300 | ~3,500 | 高 (231 函数分组 + 反射调用链 + JVMTI 事件模型) |
| **合计** | **24** | **~30,000** | **~14,000** | |

### 与其他卷的接口

| 接口 | 第七卷 | 关联卷 | 说明 |
|------|--------|--------|------|
| 类名→Klass | 第 31 章 load_instance_class | 第五卷 §22-25 (OOP/Klass 模型) | InstanceKlass 是 ClassFileParser 的输出 |
| ClassLoader → Metaspace | 第 30 章 CLD | 第五卷 §22-23 (Metaspace) | classLoaderData()->metaspace_non_null() |
| 反射调用 → 执行 | 第 33 章 Reflection::invoke | 第三卷 §13-14 (解释器) / 第四卷 §18-20 (编译器) | JavaCalls::call → 解释 executing / 编译 executing |
| JVMTI → Safepoint | 第 33 章 redefine | 第六卷 §28 (Safepoint) | VM_RedefineClasses 是 safepoint VM_Operation |
| Symbol → 字符串 | 第 31 章 SymbolTable::new_symbol | 第五卷 §22 (SymbolTable) | 类名从 C 字符串到 Symbol 的转换 |

---

## §六 现有书籍框架的对齐

与 `JVM-Source-Code-Book-Plan.md` 第七卷章节对照：

| 书籍框架章节 | 本规划章节 | 对齐状态 |
|------------|----------|:---:|
| 30 — 类加载器层次 + ClassPathEntry + jimage + CDS | 30.1-30.7 | 完全对齐，细化到 7 小节 |
| 31 — 类加载流程 + 5 步 + 双亲委派 + 链接 + 初始化 + 卸载 | 31.1-31.6 | 完全对齐，细化到 6 小节，补充 ClassFileParser |
| 32 — 模块系统 + ModuleEntryTable + PackageEntryTable | 32.1-32.5 | 完全对齐，细化到 5 小节，补充 split package + 服务绑定 |
| 33 — JNI 函数表 + Reflection + Unsafe + JVMCI + JVMTI | 33.1-33.6 | 完全对齐，细化到 6 小节，补充 JVMCI |

**书籍框架中未包含但本规划补充的内容**：
- ClassFileParser 内部结构 (parseClassFile 已纳入 §31.2)
- PlaceholderTable / LoaderConstraintTable / ResolutionErrorTable 等辅助数据结构 (§31.1)
- 完整的三条调用链：Class.forName / defineClass / Method.invoke (§三)
- ClassLoaderDataGraph 的卸载机制 (§30.6)

---

## §七 下一步操作

1. **确认规划**：用户确认本规划的章节、小节划分、源文件覆盖范围
2. **新建 Phase**：创建 `probe_md/XX-classfile/` Phase，包含 prompt + docs
3. **Prompt 写作**（会话 A）：按 scout → reader → tracer 顺序分析上述 30,000 行源码，写出 prompt
4. **文档生成**（会话 B）：在新会话中按 prompt 生成文档
5. **Review**：12 项完整性检查 + 8 review gap 检查
6. **书籍化**：将 Phase 分析文档重组为书籍第七卷章节

