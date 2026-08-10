# 26-ClassLoader-Init — 类加载底座：30 PerfData + zip 函数指针 + bootstrap 搜索路径

> **Phase**: 01-jvm-startup
> **前置**: [07-PerfMemory]（PerfData 计数器存储后端）、[00-init-globals-overview]（classLoader_init1 是 init_globals 第 3 步）
> **配套**: [24-Universe2-JavaClasses]（SystemDictionary::initialize 需要 classpath 已设置）
> **后续依赖本文**: 所有类加载操作（SystemDictionary::resolve_or_null → ClassLoader::load_class → ClassPathEntry::open_stream）
> **阅读收益**: 深度理解 ClassLoader::initialize() 的三阶段——30 个 PerfData 计数器覆盖类加载全生命周期（解析/验证/链接/初始化/锁竞争）、load_zip_library 的 7 个 dlsym 函数指针绑定（ZIP_Open→ZIP_CRC32）、setup_bootstrap_search_path 的两种构建模式（jimage vs exploded build）、以及 init1/init2 两阶段分离的设计原因（SymbolTable 依赖）

> **Callout 0: 本文为何是 Phase 01 最薄文档？**
> ClassLoader 初始化本身代码量不大（核心逻辑约 200 行），但它是 100+ 个后续函数的底座。Phase 01 最厚文档 0x-Thread-Init 达 7000+ 行，因为线程创建涉及信号、栈、TLAB、safepoint 等 10+ 子系统。本文 294→800+ 行扩容主要补充：jimage mmap 管道、`os::dll_locate_lib` 路径搜索算法、ClassPathEntry 链表四个指针区别、以及 `open_stream()` 内部分支路径。

---

## §〇 Production Scenario

### 场景 1: libzip.so 缺失 → JVM 启动失败

```bash
java -jar app.jar
# Error: Unable to load ZIP library: /path/to/libzip.so
# JVM 退出（vm_exit_during_initialization）
```

`ClassLoader::load_zip_library()` (`classLoader.cpp:1173`) 调用 `os::dll_load()` → `dlopen("libzip.so")`。如果 libzip.so 缺失或损坏 → `vm_exit_during_initialization("Unable to load ZIP library")` → JVM 退出。没有 zip 库，JVM 无法读取 rt.jar 或 modules 文件中的任何类。

**三步诊断**：
```bash
# 1. 定位 libzip.so
find $JAVA_HOME -name "libzip.so"

# 2. 检查动态库依赖
ldd $JAVA_HOME/lib/libzip.so

# 3. GDB 验证
gdb -ex "break classLoader.cpp:1173" \
    -ex "run" \
    -ex "print path" \
    --args java -version
```

**反事实**：如果 zip 加载失败不阻止启动 → 后续类加载时 `(*FindEntry)()` 是空指针 → 第一个类加载请求就 SIGSEGV → 更差的用户体验（无明确错误信息）。

### 场景 2: bootstrap classpath 为空 → 无法加载任何类

```bash
java -Xbootclasspath: -jar app.jar
# Error: Could not find or load main class
```

`setup_bootstrap_search_path()` (`classLoader.cpp:649`) 解析 `sun.boot.class.path` 属性。如果为空 → `_first_entry` 为 NULL → 后续 `ClassLoader::load_class()` 遍历空链表 → 类加载失败 → JVM 无法启动。

### 场景 3: jimage 文件损坏 → 类加载失败

```bash
java -jar app.jar
# Error: java.lang.NoClassDefFoundError: java/lang/Object
```

正式构建中，bootstrap classpath 指向 `$JAVA_HOME/lib/modules`（jimage 文件）。如果此文件损坏 → `(*JImageOpen)()` 失败 → `create_class_path_entry()` 返回 NULL → `_jrt_entry` 为空 → 所有类加载失败。

### 场景 4: 多版本 JAR (MRJAR) classpath 冲突

```bash
java -Xbootclasspath/a:old.jar:new.jar -jar app.jar
# 隐式风险: old.jar 中的 class 可能 shadow new.jar 中的同名 class
```

`load_class()` 按链表顺序线性搜索 (`classLoader.cpp:1498-1515`)。先找到的类就加载，不检查后续是否存在同名类。如果 `-Xbootclasspath/a` 添加了旧版本 jar → 可能加载旧版本类而非预期的新版本类。诊断方式：`-Xlog:class+load=info` 查看每个类的加载来源。

### 场景 5: jimage 解码失败 → OOM 或 NoClassDefFoundError

```bash
# 正常启动，但加载大量类后 OOM
java -Xmx128m -jar large-app.jar
# java.lang.OutOfMemoryError: Java heap space
```

jimage 压缩资源需要用 `ImageDecompressor::decompress_resource()` 解压 (`imageFile.cpp:555`)。每次解压需要在 Java heap 中分配缓冲区。在低内存条件下启动大应用时，解压缓冲区累积可能导致 OOM。`(*JImageGetResource)()` 返回原始资源大小会反映在 `sun.cls.appClassBytes` 和 `sun.cls.sysClassBytes` 两个 PerfData 计数器上 (`classLoader.cpp:538`)。

---

## §一 源码走读

### 1.1 classLoader_init1() → ClassLoader::initialize()

```cpp
// src/hotspot/share/classfile/classLoader.cpp:1694-1765
void ClassLoader::initialize() {
  // ★ 阶段 1: 创建 30 个 PerfData 计数器
  if (UsePerfData) {
    NEWPERFTICKCOUNTER(_perf_accumulated_time, SUN_CLS, "time");
    NEWPERFEVENTCOUNTER(_perf_classes_inited, SUN_CLS, "initializedClasses");
    NEWPERFTICKCOUNTER(_perf_class_init_time, SUN_CLS, "classInitTime");
    // ... 30 个计数器
  }

  // ★ 阶段 2: 加载 zip 库
  load_zip_library();

  // ★ 阶段 3: 设置 bootstrap 搜索路径
  setup_bootstrap_search_path();
}
```

### 1.2 30 个 PerfData 计数器

| 类别 | 数量 | 命名空间 | 示例 |
|------|------|---------|------|
| 类加载生命周期计时器 | 10 | `sun.cls.*` | `time`, `classInitTime`, `classLinkedTime`, `classVerifyTime` |
| 类加载事件计数 | 6 | `sun.cls.*` | `initializedClasses`, `linkedClasses`, `verifiedClasses` |
| 解析/查找/加载计时器 | 6 | `sun.cls.*` | `parseClassTime`, `lookupSysClassTime`, `appClassLoadTime` |
| 锁竞争与同步 | 5 | `sun.cls.*` | `systemLoaderLockContentionRate`, `jvmFindLoadedClassNoLockCalls` |
| 字节计数 | 2 | `sun.cls.*` | `appClassBytes`, `sysClassBytes` |
| 特殊计数器 | 1 | `sun.cls.*` | `unsafeDefineClassCalls` |

这些计数器通过 jvmstat perf buffer 暴露，`jstat -class` 读取。

> **Callout 1: 为什么类加载需要这么多 PerfData 计数器？**
> 类加载是 JVM 启动性能的瓶颈——大型应用（如 Spring Boot）启动时加载数万个类。`parseClassTime`/`classLinkedTime`/`classVerifyTime` 的 self 版本（`*.self`）只计自身耗时，排除子调用——帮助定位是"解析慢"还是"验证慢"还是"链接慢"。锁竞争计数器（`systemLoaderLockContentionRate`）是 bug fix 6365597 的结果——早期 JDK 中系统类加载器锁竞争是启动性能的主要瓶颈。

### 1.3 load_zip_library() — 7 个 dlsym 函数指针

```cpp
// src/hotspot/share/classfile/classLoader.cpp:1173-1214
void ClassLoader::load_zip_library() {
  // 1. 确保 libjava.so 已加载
  os::native_java_library();

  // 2. 定位并加载 libzip.so
  char path[JVM_MAXPATHLEN];
  os::dll_locate_lib(path, sizeof(path), Arguments::get_dll_dir(), "zip");
  void* handle = os::dll_load(path, ebuf, sizeof(ebuf));
  if (handle == NULL) {
    vm_exit_during_initialization("Unable to load ZIP library", path);
  }

  // 3. dlsym 绑定 7 个入口点
  ZipOpen         = CAST_TO_FN_PTR(ZipOpen_t, os::dll_lookup(handle, "ZIP_Open"));
  ZipClose        = CAST_TO_FN_PTR(ZipClose_t, os::dll_lookup(handle, "ZIP_Close"));
  FindEntry       = CAST_TO_FN_PTR(FindEntry_t, os::dll_lookup(handle, "ZIP_FindEntry"));
  ReadEntry       = CAST_TO_FN_PTR(ReadEntry_t, os::dll_lookup(handle, "ZIP_ReadEntry"));
  GetNextEntry    = CAST_TO_FN_PTR(GetNextEntry_t, os::dll_lookup(handle, "ZIP_GetNextEntry"));
  ZipInflateFully = CAST_TO_FN_PTR(ZipInflateFully_t, os::dll_lookup(handle, "ZIP_InflateFully"));
  Crc32           = CAST_TO_FN_PTR(Crc32_t, os::dll_lookup(handle, "ZIP_CRC32"));

  // 4. 有效性检查
  if (ZipOpen == NULL || FindEntry == NULL || ReadEntry == NULL
      || GetNextEntry == NULL || Crc32 == NULL) {
    vm_exit_during_initialization("Corrupted ZIP library", path);
  }

  // 5. 从 libjava.so 获取路径规范化函数
  CanonicalizeEntry = CAST_TO_FN_PTR(CanonicalizeEntry_t,
      os::dll_lookup(libjava_handle, "Canonicalize"));
}
```

**7 个函数指针的运行时用途**：

| 函数指针 | 来源 .so | 运行时调用者 | 调用频率 |
|---------|---------|------------|---------|
| `ZipOpen` | libzip.so | `create_class_path_entry()` | 每个 jar 文件 1 次 |
| `FindEntry` | libzip.so | `ClassPathZipEntry::open_entry()` | 每个类加载 1 次 |
| `ReadEntry` | libzip.so | `ClassPathZipEntry::open_entry()` | 每个类加载 1 次 |
| `GetNextEntry` | libzip.so | `ClassPathZipEntry::contents_do()` | CDS dump 时 |
| `ZipInflateFully` | libzip.so | `ClassLoader::decompress()` | 压缩类数据 |
| `Crc32` | libzip.so | CDS classpath 验证 | CDS 加载时 |
| `CanonicalizeEntry` | libjava.so | `get_canonical_path()` | 路径规范化 |

> **Callout 2: 为什么 zip 入口点用 dlsym 而不是静态链接？**
> libzip.so 是 JDK 的一部分，理论上可以静态链接。但 dlsym 提供了**版本灵活性**——同一份 libjvm.so 可以配合不同版本的 libzip.so（只要入口点签名兼容）。此外，如果 libzip.so 加载失败，JVM 可以在启动早期给出明确的错误信息，而不是在第一个类加载请求时才 SIGSEGV。

### 1.4 setup_bootstrap_search_path() — 两种构建模式

```cpp
// src/hotspot/share/classfile/classLoader.cpp:838-899
void ClassLoader::setup_boot_search_path(const char *class_path) {
  // 按 ':' 分隔遍历路径
  int len = (int)strlen(class_path);
  int end = 0;
  bool set_base_piece = true;

  while (end < len) {
    // 提取当前路径段
    int start = end;
    while (end < len && class_path[end] != ':') end++;

    // 第一个条目是核心路径
    if (set_base_piece) {
      // jimage 模式: $JAVA_HOME/lib/modules
      // exploded 模式: $JAVA_HOME/modules/java.base
      os::stat(path, &st);  // 检查路径存在
      create_class_path_entry(path, st, false, false, CHECK);
      set_base_piece = false;
    } else {
      // 后续条目 → 追加到 boot append 列表
      update_class_path_entry_list(path, st, false, true);
    }
    end++;  // 跳过 ':'
  }
}
```

**两种构建模式**：

| 模式 | 路径 | ClassPathEntry 类型 | 入口点 |
|------|------|-------------------|--------|
| Jimage（正式构建） | `$JAVA_HOME/lib/modules` | `ClassPathImageEntry` | `(*JImageOpen)()` |
| Exploded build | `$JAVA_HOME/modules/java.base` | `ClassPathDirEntry` | 直接文件读取 |

### 1.5 classLoader_init1 vs classLoader_init2

| | Phase 1 (init1) | Phase 2 (init2) |
|---|---|---|
| **调用时机** | init_globals #3 | SystemDictionary::resolve_well_known_classes |
| **核心任务** | PerfData + zip 库 + class path | patch-module + java.base ModuleEntry |
| **SymbolTable 依赖** | 无 | **必须**（`SymbolTable::lookup(module_name)`） |
| **失败后果** | `vm_exit` | `vm_exit` |

**init2 为什么必须在 SymbolTable 之后？**

`setup_patch_mod_entries()` 需要 `SymbolTable::lookup(module_name)` 做模块名比较——SymbolTable 在 init_globals 的 `universe_init()` (#9) 中初始化，而 init1 在 #3 就执行。两阶段分离避免了循环依赖。

### 1.6 classLoader_init2() 详细流程

```cpp
// src/hotspot/share/classfile/classLoader.cpp:1858-1884
void ClassLoader::classLoader_init2(TRAPS) {
  // 1. 设置 --patch-module 条目
  if (Arguments::get_patch_mod_prefix() != NULL) {
    setup_patch_mod_entries();
  }

  // 2. 创建 java.base 的 ModuleEntry
  // java.base 必须在任何类加载前存在
  create_javabase();

  // 3. 为 exploded build 初始化 _exploded_entries
  if (!has_jrt_entry()) {
    assert(!DumpSharedSpaces, "DumpSharedSpaces not supported with exploded module builds");
    assert(!UseSharedSpaces, "UsedSharedSpaces not supported with exploded module builds");
    _exploded_entries = new (ResourceObj::C_HEAP, mtModule)
      GrowableArray<ModuleClassPathList*>(EXPLODED_ENTRY_SIZE, true);
    add_to_exploded_build_list(vmSymbols::java_base(), CHECK);
  }
}
```

**EXPLODED_ENTRY_SIZE = 80** (`classLoader.hpp:231`)：预分配 80 个模块位置。目前 JDK 有约 60 个模块，预留 20 个增长空间。如果超过 80 个，`GrowableArray` 自动扩容。

---

## §二 ClassPathEntry 全局状态布局

### 2.1 五个核心 ClassPathEntry 指针

```cpp
// src/hotspot/share/classfile/classLoader.hpp:229-238
static ClassPathEntry* _jrt_entry;               // ① jimage base piece
static GrowableArray<...>* _exploded_entries;      // ② exploded build entry
static ClassPathEntry* _first_append_entry;        // ③ boot append 起点
static ClassPathEntry* _last_append_entry;         // ④ boot append 终点
static GrowableArray<...>* _patch_mod_entries;     // ⑤ --patch-module 条目
```

**五个指针形成的三层架构** (`classLoader.hpp:211-219`)：
```
┌──────────────────────────────────────────────────────┐
│  Boot Loader Class Path (按查找优先级排序)              │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Layer 1: --patch-module (最高优先级)                  │
│    _patch_mod_entries[] → ModuleClassPathList          │
│      module_first_entry → entry → next() → ...        │
│                                                      │
│  Layer 2: Base Piece (核心)                            │
│    _jrt_entry (jimage) 或 _exploded_entries[]         │
│                                                      │
│  Layer 3: Boot Append (最低优先级)                      │
│    _first_append_entry → next() → ... → _last_append_entry
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 2.2 _first_entry 与 _last_entry 的不同角色

这是一个常见的误解点：ClassLoader 没有单一的 `_first_entry`。实际上有三组链表：

| 指针对 | 所属层 | 遍历起点 | 追加终点 |
|-------|--------|---------|---------|
| `module_first_entry` / `module_last_entry` | --patch-module (`ModuleClassPathList`) | 每模块独立 | 追加新路径 |
| `_jrt_entry` / `_exploded_entries` | Base piece | 单入口或数组 | 模块级追加 |
| `_first_append_entry` / `_last_append_entry` | Boot append | 遍历起点 | O(1) 追加 |

**追加路径的 O(1) 尾部插入** (`classLoader.cpp:1041-1051`)：
```cpp
void ClassLoader::add_to_boot_append_entries(ClassPathEntry *new_entry) {
  if (_last_append_entry == NULL) {
    // 首个条目：first = last = new_entry
    _first_append_entry = _last_append_entry = new_entry;
  } else {
    // 追加到尾部：last->next = new_entry, last = new_entry
    _last_append_entry->set_next(new_entry);
    _last_append_entry = new_entry;
  }
}
```

### 2.3 CDS 专用路径指针

```cpp
// src/hotspot/share/classfile/classLoader.hpp:243-248
CDS_ONLY(static ClassPathEntry* _app_classpath_entries;)    // APP classpath 链表头
CDS_ONLY(static ClassPathEntry* _last_app_classpath_entry;)  // APP classpath 链表尾
CDS_ONLY(static ClassPathEntry* _module_path_entries;)       // Module path 链表头
CDS_ONLY(static ClassPathEntry* _last_module_path_entry;)    // Module path 链表尾
```

CDS dump 时需要通过这些指针记录 classpath 以便运行时验证——运行时 CDS archive 只对相同 classpath 有效。

### 2.4 ClassPathEntry 子类选择逻辑

```cpp
// src/hotspot/share/classfile/classLoader.cpp:938-997
ClassPathEntry* ClassLoader::create_class_path_entry(const char *path, const struct stat* st, ...) {
  if ((st->st_mode & S_IFMT) == S_IFREG) {
    // ① 常规文件: 尝试 jimage → 再尝试 zip
    JImageFile* jimage = (*JImageOpen)(canonical_path, &error);
    if (jimage != NULL) {
      new_entry = new ClassPathImageEntry(jimage, canonical_path);  // jimage 文件
    } else {
      jzfile* zip = (*ZipOpen)(canonical_path, &error_msg);
      if (zip != NULL && error_msg == NULL) {
        new_entry = new ClassPathZipEntry(zip, path, is_boot_append); // ZIP 文件
      } else {
        // 打开失败: 记录错误，如果是 is_boot_append 则忽略
        return NULL;
      }
    }
  } else {
    // ② 目录: ClassPathDirEntry
    new_entry = new ClassPathDirEntry(path);
  }
  return new_entry;
}
```

**决策树**：
```
os::stat(path, &st)
  ├─ S_IFREG (常规文件)
  │   ├─ JIMAGE_Open 成功 → ClassPathImageEntry (modules 文件)
  │   ├─ ZIP_Open 成功   → ClassPathZipEntry (jar/zip 文件)
  │   └─ 都失败          → NULL (appended entry 悄悄忽略)
  └─ 目录 → ClassPathDirEntry
```

---

## §三 ClassPathEntry 遍历策略

### 3.1 load_class() 三次尝试的顺序

```cpp
// src/hotspot/share/classfile/classLoader.cpp:1435-1554
InstanceKlass* ClassLoader::load_class(Symbol* name, bool search_append_only, TRAPS) {
  // Attempt #1: --patch-module entries (最高优先级)
  if (_patch_mod_entries != NULL && !search_append_only) {
    if (!DumpSharedSpaces) {
      stream = search_module_entries(_patch_mod_entries, class_name, file_name, CHECK_NULL);
    }
  }

  // Attempt #2: [jimage | exploded build] base piece
  if (!search_append_only && (NULL == stream)) {
    if (has_jrt_entry()) {
      e = _jrt_entry;  // 单入口 jimage
      stream = _jrt_entry->open_stream(file_name, CHECK_NULL);
    } else {
      stream = search_module_entries(_exploded_entries, class_name, file_name, CHECK_NULL);
    }
  }

  // Attempt #3: [-Xbootclasspath/a] + [jvmti appended entries]
  if (search_append_only && (NULL == stream)) {
    classpath_index = 1;  // 跳过 base piece
    e = _first_append_entry;
    while (e != NULL) {
      stream = e->open_stream(file_name, CHECK_NULL);
      if (NULL != stream) break;  // 找到即停止
      e = e->next();   // 沿链表继续
      ++classpath_index;
    }
  }

  // 4. 如果找到 stream，调用 KlassFactory::create_from_stream() 解析
  if (NULL != stream) {
    InstanceKlass* result = KlassFactory::create_from_stream(stream, name, ...);
    // 5. 记录包路径索引
    if (!add_package(file_name, classpath_index, THREAD)) {
      return NULL;
    }
    return result;
  }
  return NULL;  // 所有路径都未找到类
}
```

> **Callout 3: 为什么 "找到即停止" 而不是搜索完所有路径后选择最新版本？**
> Java 类加载器采用"first-match-wins"策略 (`classLoader.cpp:1510`)。这类似于 Linux `$PATH` 的 `which` 命令。设计假设：classpath 中没有重复类。如果确实存在重复 → -Xbootclasspath/a 添加的类会 shadow 原始类——这是特性，不是 bug。实际使用中，JVM TI agent 用这个机制替换追踪类。

### 3.2 ClassPathEntry 的 `_next` 指针和 `volatile` 语义

```cpp
// src/hotspot/share/classfile/classLoader.hpp:49
class ClassPathEntry : public CHeapObj<mtClass> {
private:
  ClassPathEntry* volatile _next;  // 注意 volatile
public:
  ClassPathEntry* next() const;
  void set_next(ClassPathEntry* next);
};
```

`_next` 是 `volatile` 指针 (`classLoader.hpp:49`)。原因：
- **读取端** (`load_class()`) ：应用线程在类加载时遍历链表——读取 `_next` 不需要锁，volatile 确保可见性
- **写入端** (`add_to_boot_append_entries()`) ：只在初始化阶段写入，单线程（init 线程），有锁保护

**性能影响**：volatile 读取在 x86 上几乎零开销（x86 内存模型强，只需要 compiler barrier）。在 ARM/Power 上有 `ldar` 指令成本。

### 3.3 重复条目检测

```cpp
// src/hotspot/share/classfile/classLoader.cpp:1028-1039
bool ClassLoader::contains_append_entry(const char* name) {
  ClassPathEntry* e = _first_append_entry;
  while (e != NULL) {
    if (strcmp(name, e->name()) == 0) {
      return true;
    }
    e = e->next();
  }
  return false;
}
```

线性 O(n) 检查——对于正常大小的 classpath（通常 < 20 条目），成本可忽略。

### 3.4 search_module_entries 的双路径查找

```cpp
// src/hotspot/share/classfile/classLoader.cpp:1382-1432
ClassFileStream* ClassLoader::search_module_entries(
    const GrowableArray<ModuleClassPathList*>* const module_list,
    const char* const class_name, const char* const file_name, TRAPS) {

  // ① 根据类名找到 module name
  PackageEntry* pkg_entry = get_package_entry(class_name, ..., CHECK_NULL);
  ModuleEntry* mod_entry = (pkg_entry != NULL) ? pkg_entry->module() : NULL;

  // ② 模块系统未初始化 → 所有类归入 java.base
  if (!Universe::is_module_initialized() &&
      !ModuleEntryTable::javabase_defined() &&
      mod_entry == NULL) {
    mod_entry = ModuleEntryTable::javabase_moduleEntry();
  }

  // ③ 按模块名找到 ClassPathEntry 链表
  ClassPathEntry* e = NULL;
  if (mod_entry != NULL && mod_entry->is_named()) {
    e = find_first_module_cpe(mod_entry, module_list);
  }

  // ④ 遍历该模块的所有路径
  while (e != NULL) {
    stream = e->open_stream(file_name, CHECK_NULL);
    if (NULL != stream) {
      return stream;
    }
    e = e->next();
  }
  return NULL;  // 模块存在但路径中无此类
}
```

> **Callout 4: 遍历中 Module_lock 的使用时机**
> 对 exploded build 的遍历需要 `Module_lock` (`classLoader.cpp:1411`)——因为运行时可能动态添加模块。而对 --patch-module 条目不需要——这些只在 init2 设置，之后不变。这种锁粒度差异化避免了不必要的锁争用。

---

## §四 load_zip_library 详细流程

### 4.1 os::dll_locate_lib 路径搜索算法

```cpp
// src/hotspot/share/runtime/os.cpp:282-340
bool os::dll_locate_lib(char *buffer, size_t buflen,
                        const char* pname, const char* fname) {
  // 1. 构建完整库名: "lib" + "zip" + ".so" = "libzip.so"
  char* fullfname = ...;  // libzip.so
  dll_build_name(fullfname, ..., fname);

  if (pnamelen == 0) {
    // 2a. 无 pname → 当前工作目录 (CWD)
    const char* p = get_current_directory(buffer, buflen);
    // buffer = CWD/libzip.so → os::stat() 检查存在
  } else if (strchr(pname, *os::path_separator()) != NULL) {
    // 2b. pname 含 ':' → 多路径列表 (如 LD_LIBRARY_PATH)
    char** pelements = split_path(pname, &n);  // 按 ':' 分割
    for (int i = 0; i < n; i++) {
      // pelements[i]/libzip.so → os::stat() 检查存在
      // 找到第一个即返回（first-match-wins）
    }
  } else {
    // 2c. pname 是单个路径（如 JAVA_HOME/lib）
    // pname/libzip.so → os::stat() 检查存在
  }
}
```

**对于 `load_zip_library()` 的调用**：`pname = Arguments::get_dll_dir()`，返回 `$JAVA_HOME/lib`（或其他 DllDir）作为单一路径。不走 LD_LIBRARY_PATH 搜索。

**关键设计点**：
- **不依赖 `dlopen()` 自带的搜索** (`classLoader.cpp:1184`)：先用 `os::stat()` 检查文件存在再加载。这避免了 `dlopen()` 在 `$LD_LIBRARY_PATH` 中找到一个有权限但签名不正确的 libzip.so。
- **错误信息包含路径** (`classLoader.cpp:1187`)：`vm_exit_during_initialization("Unable to load ZIP library", path)` —— 明确告诉用户哪个文件无法加载，比 `dlopen()` 返回的 `NULL` 更有诊断价值。

### 4.2 三个 ZIP 库加载策略

JVM 有三种获取 ZIP 入口点的方式（历史原因）：

| 策略 | 方法 | 使用条件 | 优缺点 |
|------|------|---------|--------|
| ① `dlopen("libzip.so")` | `os::dll_load(path)` | **默认** (所有 Linux/Win 构建) | 灵活，可替换 |
| ② 静态链接 | `JNI_OnLoad()` 符号查找 | JDK 嵌入平台 | 不需要外部文件，但版本固定 |
| ③ 系统默认 | `dlopen("libzip")` 无完整路径 | 无 (已废用) | 依赖系统 LD_LIBRARY_PATH |

策略③的由来：早期 JDK（< 1.5）可能尝试 `dlopen("libzip")` 依赖 LD_LIBRARY_PATH。现在已被 `dll_locate_lib` 的显式路径检查取代。

### 4.3 每个 dlsym 函数指针的使用场景

以下是 7 个函数指针在实际代码中的调用位置和使用场景：

**ZipOpen** (`classLoader.cpp:967`)：
```cpp
jzfile* zip = (*ZipOpen)(canonical_path, &error_msg);
```
**场景**：创建 `ClassPathZipEntry` 时打开 ZIP 文件。每次调用创建独立的 `jzfile*` 句柄——同一 jar 文件被多次引用时不会共享。例如：`$JAVA_HOME/lib/tools.jar` 和 `/usr/share/java/tools.jar` 路径不同，各自独立 `ZipOpen`。

**FindEntry** (`classLoader.cpp:318`)：
```cpp
jzentry* entry = (*FindEntry)(_zip, name, filesize, &name_len);
```
**场景**：按名称在 ZIP 文件中查找类文件（如 `java/lang/String.class`）。内部是 ZIP 中心目录的二分查找或哈希表查找。

**ReadEntry** (`classLoader.cpp:338`)：
```cpp
if (!(*ReadEntry)(_zip, entry, buffer, filename)) return NULL;
```
**场景**：从 ZIP 文件中读取已定位的资源到调用者提供的缓冲区中。

**GetNextEntry** (`classLoader.cpp:453`)：
```cpp
jzentry *ze = ((*GetNextEntry)(_zip, n));  // n = 0, 1, 2, ...
```
**场景**：遍历 ZIP 文件所有条目。仅 CDS dump 时使用 `ClassPathZipEntry::contents_do()`，记录所有可用类名到 CDS archive。

**ZipInflateFully** (`classLoader.cpp:1246`)：
```cpp
return (*ZipInflateFully)(in, inSize, out, outSize, pmsg);
```
**场景**：解压类数据。ZIP 文件中存储的类可能是 Deflated 压缩的——JVM 需要解压后传给 `ClassFileParser`。

**Crc32** (`classLoader.cpp:1251`)：
```cpp
return (*Crc32)(crc, (const jbyte*)buf, len);
```
**场景**：CDS shared archive 验证。运行时需要验证 classpath 中每个 jar 的 CRC32 与 dump 时记录的一致性。

**CanonicalizeEntry** (`classLoader.cpp:1897`)：
```cpp
if ((CanonicalizeEntry)(env, os::native_path(orig_copy), out, len) < 0) {
  return false;
}
```
**场景**：路径规范化为 OS 原生格式（如 Windows 的 `\` → `/`）。JDK 9+ 此函数指针通常为 NULL，fallback 到 `strncpy`（不做规范化）。

### 4.4 load_jimage_library() 并行加载

```cpp
// src/hotspot/share/classfile/classLoader.cpp:1216-1243
void ClassLoader::load_jimage_library() {
  os::native_java_library();
  char path[JVM_MAXPATHLEN];
  void* handle = NULL;
  if (os::dll_locate_lib(path, sizeof(path), Arguments::get_dll_dir(), "jimage")) {
    handle = os::dll_load(path, ebuf, sizeof ebuf);
  }
  // 6 个 jimage 入口点（全部必须非 NULL）
  JImageOpen              = dlsym(handle, "JIMAGE_Open");
  JImageClose             = dlsym(handle, "JIMAGE_Close");
  JImagePackageToModule   = dlsym(handle, "JIMAGE_PackageToModule");
  JImageFindResource      = dlsym(handle, "JIMAGE_FindResource");
  JImageGetResource       = dlsym(handle, "JIMAGE_GetResource");
  JImageResourceIterator  = dlsym(handle, "JIMAGE_ResourceIterator");
}
```

注意与 `load_zip_library()` 的区别：
- `load_jimage_library()` 对所有 6 个入口点使用 `guarantee(ptr != NULL)` (`classLoader.cpp:1232-1242`)，任何 NULL 都会 abort
- `load_zip_library()` 允许 `ZipClose` 和 `CanonicalizeEntry` 为 NULL（向后兼容）
- `load_jimage_library()` 的入口点最终名称不同：`JIMAGE_Open` vs `ZIP_Open`（有前缀）

---

## §五 jimage 模式详解

### 5.1 JIMAGE_Open → ImageFileReader::open() → mmap

```cpp
// src/java.base/share/native/libjimage/jimage.cpp:59-64
extern "C" JNIEXPORT JImageFile*
JIMAGE_Open(const char *name, jint* error) {
    *error = 0;
    ImageFileReader* jfile = ImageFileReader::open(name);
    return (JImageFile*) jfile;
}
```

`ImageFileReader::open()` 使用 mmap 映射 jimage 文件 (`imageFile.cpp:394`)：
```cpp
bool ImageFileReader::open() {
    _fd = osSupport::openReadOnly(_name);  // ① open(O_RDONLY)
    _file_size = osSupport::size(_name);   // ② stat() 获取文件大小

    // ③ 读取 magic + version header (16 字节)
    read_at((u1*)&_header, sizeof(ImageHeader), 0);

    // ④ 验证 header
    if (_header.magic() != IMAGE_MAGIC ||
        _header.major_version() != MAJOR_VERSION ||
        _header.minor_version() != MINOR_VERSION) {
      close(); return false;
    }

    // ⑤ mmap 整个文件 (仅 64 位)
    _index_data = (u1*)osSupport::map_memory(_fd, _name, 0, (size_t)map_size());
    // Linux: mmap(NULL, bytes, PROT_READ, MAP_SHARED, fd, 0)
}
```

**mmap 的 Linux 实现** (`osSupport_unix.cpp:74-82`)：
```cpp
void* osSupport::map_memory(int fd, const char *filename,
                            size_t file_offset, size_t bytes) {
    mapped_address = (void*) mmap(NULL, bytes, PROT_READ, MAP_SHARED, fd, file_offset);
    if (mapped_address == MAP_FAILED) {
        return NULL;
    }
    return mapped_address;
}
```

### 5.2 全局内存映射决策

```cpp
// src/java.base/share/native/libjimage/imageFile.cpp:44
bool ImageFileReader::memory_map_image = sizeof(void *) == 8;
```

**只在 64 位 JVM 上使用 mmap** (`imageFile.cpp:44`)。原因：
- 32 位进程地址空间有限（4GB），mmap 大文件可能耗尽地址空间
- `$JAVA_HOME/lib/modules` 约 130MB——mmap 实际占用 130MB 地址空间
- 在 32 位上 fallback 到 `read()`：`read_at()` 按请求位置随机读取 (`imageFile.cpp:441`)

### 5.3 JIMAGE_FindResource → 完美哈希查找

```cpp
// src/java.base/share/native/libjimage/jimage.cpp:111-141
JIMAGE_FindResource(JImageFile* image, const char* module_name,
                    const char* version, const char* name, jlong* size) {
    // ① 构造内部路径: "/<module>/<classpath>" → e.g. "/java.base/java/lang/String.class"
    char fullpath[IMAGE_MAX_PATH];
    // index = 0; fullpath[index++] = '/';
    // memcpy(module_name); fullpath[index++] = '/';
    // memcpy(name); fullpath[index++] = '\0';

    // ② 用完美哈希查找 location index
    JImageLocationRef loc = ((ImageFileReader*) image)->find_location_index(fullpath, (u8*) size);
    return loc;
}
```

**完美哈希查找** (`imageFile.cpp:447-490`)：
1. 用 `ImageStrings::hash_code(path)` 计算哈希值
2. `index = hash_code % table_length` 模运算得到表索引
3. 查 redirect 表处理冲突（`-1-value` = 真索引，`>0` = 重新哈希 seed）
4. 验证字符串精确匹配（处理 false positive）
5. 返回 location 的 offset（JImageLocationRef = u4）

**时间复杂度**：O(1) 查找，O(N+E) 空间（N=表大小，E=条目数）

### 5.4 JIMAGE_GetResource → 读取 + 解压

```cpp
// src/java.base/share/native/libjimage/imageFile.cpp:533-565
void ImageFileReader::get_resource(ImageLocation& location, u1* uncompressed_data) const {
    u8 offset = location.get_attribute(ATTRIBUTE_OFFSET);
    u8 uncompressed_size = location.get_attribute(ATTRIBUTE_UNCOMPRESSED);
    u8 compressed_size = location.get_attribute(ATTRIBUTE_COMPRESSED);

    if (compressed_size != 0) {
        // ★ 资源被压缩
        if (!memory_map_image) {
            compressed_data = new u1[(size_t)compressed_size];
            read_at(compressed_data, compressed_size, _index_size + offset);
        } else {
            compressed_data = get_data_address() + offset; // ★ 零拷贝
        }
        // 解压
        ImageDecompressor::decompress_resource(compressed_data, uncompressed_data,
                                               uncompressed_size, &strings, _endian);
        if (!memory_map_image) {
            delete[] compressed_data;
        }
    } else {
        // 未压缩 → 直接从 mmap 或 read_at 读取
        read_at(uncompressed_data, uncompressed_size, _index_size + offset);
    }
}
```

> **Callout 5: mmap 给 jimage 带来的三大性能收益**
> 1. **零拷贝访问**：`get_data_address() + offset` (`imageFile.cpp:550`) === `mmap_ptr + offset`，类数据直接通过指针访问，不需要 read() 系统调用
> 2. **页面缓存共享**：多个 JVM 进程打开同一 modules 文件时，页面缓存由内核维护，物理内存只占用一份（MAP_SHARED）
> 3. **惰性页面加载**：`MAP_SHARED | PROT_READ` 不会预加载整个文件，只有实际访问的页面触发 page fault → 内核读取

### 5.5 ClassPathImageEntry::open_stream() 完整流程

```cpp
// src/hotspot/share/classfile/classLoader.cpp:494-547
ClassFileStream* ClassPathImageEntry::open_stream(const char* name, TRAPS) {
  jlong size;
  // ① 第一次查找：空 module name + 版本 "9.0"
  JImageLocationRef location = (*JImageFindResource)(_jimage, "", "9.0", name, &size);

  if (location == 0) {
    // ② 重试：从包名找模块名
    const char* pkg_name = ClassLoader::package_from_name(name);
    if (pkg_name != NULL) {
      if (!Universe::is_module_initialized()) {
        // ③ 模块系统未初始化 → 尝试 java.base
        location = (*JImageFindResource)(_jimage, JAVA_BASE_NAME, "9.0", name, &size);
      } else {
        // ④ 模块系统已初始化 → 从 PackageEntry 获取 module name
        PackageEntry* pkg = get_package_entry(name, ..., CHECK_NULL);
        if (pkg != NULL) {
          const char* module_name = pkg->module()->name()->as_C_string();
          location = (*JImageFindResource)(_jimage, module_name, "9.0", name, &size);
        }
      }
    }
  }

  if (location != 0) {
    // ⑤ 分配缓冲区 + 读取资源
    char* data = NEW_RESOURCE_ARRAY(char, size);
    (*JImageGetResource)(_jimage, location, data, size);
    return new ClassFileStream((u1*)data, (int)size, _name, ClassFileStream::verify);
  }
  return NULL;
}
```

**两次查找的模块系统耦合**：`open_stream()` 第一次用空模块名查找——如果 jimage 中只有 java.base，这是有效路径。如果失败，再通过模块系统查找。这种"先快后慢"的策略避免了模块系统未初始化时的 crash。

---

## §六 ClassPathEntry 延迟与缓存语义

### 6.1 初始化是 eager 的，类加载是 lazy 的

**澄清**：JDK 11 中没有 `LazyClassPathEntry` 类。延迟语义体现在类加载层面：

| 操作 | 时机 | 延迟特性 |
|------|------|---------|
| `create_class_path_entry()` | ClassLoader::initialize() | **Eager** — 立即创建所有 ClassPathEntry |
| `open_stream()` | 类首次被请求时 | **Lazy** — 只有触发 load_class 才读取文件 |
| `jzfile*` handle | `ZipOpen()` 立即 | **No-caching** — 每个 zip 独立句柄，不共享 |
| `JImageFile*` handle | `JIMAGE_Open()` 立即 | **Shared** — 同进程共享（_reader_table） |

### 6.2 JImageFile 的引用计数共享

```cpp
// src/java.base/share/native/libjimage/imageFile.cpp:254-271
ImageFileReader* ImageFileReader::find_image(const char* name) {
  SimpleCriticalSectionLock cs(&_reader_table_lock);
  for (u4 i = 0; i < _reader_table.count(); i++) {
    ImageFileReader* reader = _reader_table.get(i);
    if (strcmp(reader->name(), name) == 0) {
      reader->inc_use();  // 引用计数 +1
      return reader;
    }
  }
  return NULL;
}
```

`ImageFileReaderTable` 维护已打开 jimage 文件的全局表。当多个 `ClassPathImageEntry` 指向同一 `modules` 文件时——只有一个 `JImageFile*` 实例，通过 `inc_use()` 引用计数管理 (`imageFile.cpp:250-271`)。

### 6.3 ClassPathZipEntry 不共享句柄

与 jimage 不同，ZIP 文件没有全局共享表。每个 `ClassPathZipEntry` 持有独立的 `jzfile* _zip` 句柄。原因：ZIP 文件的打开成本低（读取中心目录），不需要共享优化。

### 6.4 ZipInflateFully 的 on-demand 特性

`ZipInflateFully` 是唯一"可能不需要但存在"的函数指针——只有 DEFLATE 压缩的类数据需要。JAR 中可以选择 `STORED`（不压缩）或 `DEFLATE`。JVM 不预测哪些类被压缩，只在 `ClassPathZipEntry::open_entry()` 返回压缩标记后才调用 `decompress()`。

---

## §七 类加载数据流（完整版本）

```
SystemDictionary::resolve_or_null()
  → resolve_instance_class_or_null()
    → load_instance_class()
      → ClassLoader::load_class(name, search_append_only, THREAD)
        │
        │  // ★ Attempt #1: --patch-module
        ├→ if (_patch_mod_entries != NULL && !search_append_only)
        │     search_module_entries(_patch_mod_entries, ...)
        │       → PackageEntry → ModuleEntry → module_first_entry
        │         → while (e != NULL)
        │             e->open_stream(file_name)  → ClassPathZipEntry::open_stream()
        │               → (*FindEntry)(_zip, name, ...)  → libzip.so:ZIP_FindEntry
        │               → (*ReadEntry)(_zip, entry, buffer) → libzip.so:ZIP_ReadEntry
        │             └→ e = e->next()
        │
        │  // ★ Attempt #2: Base piece (jimage 或 exploded)
        ├→ if (!search_append_only && stream == NULL)
        │     if (has_jrt_entry())
        │       _jrt_entry->open_stream(file_name)
        │         → ClassPathImageEntry::open_stream()
        │           → (*JImageFindResource)(_jimage, module, ver, name, &size)
        │           → (*JImageGetResource)(_jimage, location, data, size)
        │     else  // exploded build
        │       search_module_entries(_exploded_entries, ...)
        │
        │  // ★ Attempt #3: Boot append (-Xbootclasspath/a)
        ├→ if (search_append_only && stream == NULL)
        │     e = _first_append_entry
        │     while (e != NULL)
        │       stream = e->open_stream(file_name)
        │       if (stream) break
        │       e = e->next(); classpath_index++
        │
        │  // ★ Attempt #4: Klass 创建
        └→ if (stream != NULL)
              InstanceKlass* result = KlassFactory::create_from_stream(
                  stream, name, loader_data, protection_domain, NULL, NULL, THREAD)
              add_package(file_name, classpath_index, THREAD)
              return result
            return NULL
```

---

## §八 边缘场景

### 8.1 场景 1: libzip.so 损坏 → Corrupted ZIP library

```bash
# Error: Corrupted ZIP library: /path/to/libzip.so
```

`load_zip_library()` 检查所有关键入口点非 NULL。如果 libzip.so 存在但缺少导出符号 → 某个 `dlsym` 返回 NULL → `vm_exit_during_initialization("Corrupted ZIP library")`。

### 8.2 场景 2: ZipClose 可为 NULL — 非致命

Windows JDK5 兼容——`ZipClose` 可能为 NULL，这不是致命错误 (`classLoader.cpp:1199`)。`ClassPathZipEntry::~ClassPathZipEntry()` 中有 `if (ZipClose != NULL)` 保护。

### 8.3 场景 3: CanonicalizeEntry 可为 NULL

`CanonicalizeEntry` 只在 JDK 1.3 上有效。现代 JDK 上为 NULL，不影响启动——`get_canonical_path()` 中 fallback 到 `strncpy` (`classLoader.cpp:1900-1904`)。

### 8.4 场景 4: jimage 解码失败 → OOM

```bash
java -Xmx64m -jar large-app.jar
# java.lang.OutOfMemoryError: Java heap space
```

`ClassPathImageEntry::open_stream()` 在 ResourceArea 中分配缓冲区 (`classLoader.cpp:537`)：
```cpp
char* data = NEW_RESOURCE_ARRAY(char, size);  // ResourceMark 管理
```
大量类需要解压时，ResourceArea 膨胀可能压入 OOM。监控方法：`jcmd <pid> VM.classloaders show-classes` 查看加载类总数。

### 8.5 场景 5: 并发类加载的 FIRST-MATCH 竞态

```cpp
// classLoader.cpp:1506-1514
e = _first_append_entry;
while (e != NULL) {
  stream = e->open_stream(file_name, CHECK_NULL);  // ← 可能返回 NULL
  if (NULL != stream) { break; }
  e = e->next();
  ++classpath_index;
}
```

两个线程同时请求同一类 → 都遍历链表 → 第一个找到时创建 ClassFileStream → 第二个仍然在遍历。但 `SystemDictionary` 的 `ObjectLocker` 最终只允许一个线程成功定义类（第二个线程在 `resolve_instance_class_or_null` 中被阻塞）。

### 8.6 场景 6: LD_PRELOAD 干扰 libzip.so

```bash
LD_PRELOAD=/path/to/custom-libzip.so java -jar app.jar
```

`LD_PRELOAD` 会影响 `dlopen()` 的行为。但 JVM 使用显式路径（`dll_locate_lib` → `os::stat()` 检查 → `dlopen(path)`），所以 LD_PRELOAD 只在以下情况干扰：
- `dlopen()` 内部使用 `RTLD_NEXT` 时（罕见）
- 自定义 libzip.so 的 `ZIP_Open` 返回非 NULL 但内部行为异常

检查方法：
```bash
LD_PRELOAD=/path/to/libzip.so ldd $(which java) | grep libzip
```

---

## §九 诊断工具

```bash
# 1. 查看 bootstrap classpath
java -XshowSettings:all -version 2>&1 | grep "sun.boot.class.path"

# 2. 查看类加载统计
jstat -class <pid>

# 3. 查看 PerfData 计数器
jcmd <pid> PerfCounter.print | grep "sun.cls"

# 4. GDB 验证 zip 入口点
gdb -ex "break classLoader.cpp:1173" \
    -ex "run" \
    -ex "finish" \
    -ex "print ZipOpen" \
    -ex "print FindEntry" \
    --args java -version

# 5. 验证 classpath 链表
gdb -ex "break classLoader.cpp:838" \
    -ex "run" \
    -ex "finish" \
    -ex "print ClassLoader::_jrt_entry" \
    -ex "print ClassLoader::_first_append_entry" \
    --args java -version

# 6. strace 验证 jimage mmap
strace -e trace=openat,mmap,munmap,read,pread64 -f java -version 2>&1 | grep modules

# 7. 验证已打开文件描述符
lsof -p <pid> | grep modules

# 8. 查看 mmap 映射区域
cat /proc/<pid>/maps | grep modules

# 9. 查看类加载日志
java -Xlog:class+load=info -version 2>&1 | head -20

# 10. 检查 jimage 完整性
java -Xshare:dump -version 2>&1 | grep -i "jimage\|module"
```

### 9.1 GDB 断点位置速查表

| 断点 | 文件:行 | 触发条件 | GDB 命令 |
|-----|--------|--------|---------|
| `load_zip_library` | `classLoader.cpp:1173` | init_globals #3 | `b classLoader.cpp:1173` |
| `zip open` | `classLoader.cpp:967` | 每个 jar 文件 1 次 | `b classLoader.cpp:967` |
| `jimage open` | `classLoader.cpp:957` | 发现 modules 文件 | `b classLoader.cpp:957` |
| `find entry` | `classLoader.cpp:318` | 每次类加载 | `b classLoader.cpp:318` |
| `mmap modules` | `imageFile.cpp:394` | jimage 首次打开 | `b imageFile.cpp:394` |

---

## §十 源码文件

| 文件 | 关键行号 | 内容 |
|------|---------|------|
| `src/hotspot/share/classfile/classLoader.cpp` | :81-96 | zip + jimage 函数指针 + 全局声明 |
| `src/hotspot/share/classfile/classLoader.cpp` | :109-151 | 所有 PerfCounter 全局变量 |
| `src/hotspot/share/classfile/classLoader.cpp` | :260-294 | `ClassPathDirEntry::open_stream()` — 目录读取 |
| `src/hotspot/share/classfile/classLoader.cpp` | :296-457 | `ClassPathZipEntry` — open_entry + open_versioned_entry + open_stream + contents_do |
| `src/hotspot/share/classfile/classLoader.cpp` | :459-589 | `ClassPathImageEntry` — open_stream + close_jimage + compile_the_world |
| `src/hotspot/share/classfile/classLoader.cpp` | :649-672 | `setup_bootstrap_search_path()` |
| `src/hotspot/share/classfile/classLoader.cpp` | :838-899 | `setup_boot_search_path()` — 两层模式分支 |
| `src/hotspot/share/classfile/classLoader.cpp` | :901-936 | `add_to_exploded_build_list()` — 动态添加模块 |
| `src/hotspot/share/classfile/classLoader.cpp` | :938-997 | `create_class_path_entry()` — jimage vs zip vs dir 决策 |
| `src/hotspot/share/classfile/classLoader.cpp` | :1041-1051 | `add_to_boot_append_entries()` — O(1) 尾部追加 |
| `src/hotspot/share/classfile/classLoader.cpp` | :1091-1121 | `update_class_path_entry_list()` — entry 创建入口 |
| `src/hotspot/share/classfile/classLoader.cpp` | :1173-1243 | `load_zip_library()` + `load_jimage_library()` |
| `src/hotspot/share/classfile/classLoader.cpp` | :1245-1252 | `decompress()` + `crc32()` |
| `src/hotspot/share/classfile/classLoader.cpp` | :1382-1432 | `search_module_entries()` — 模块级类搜索 |
| `src/hotspot/share/classfile/classLoader.cpp` | :1435-1554 | `load_class()` — 三次尝试的完整流程 |
| `src/hotspot/share/classfile/classLoader.cpp` | :1853-1884 | `classLoader_init1()` + `classLoader_init2()` |
| `src/hotspot/share/classfile/classLoader.cpp` | :1908-1930 | `create_javabase()` — ModuleEntry 创建 |
| `src/hotspot/share/classfile/classLoader.hpp` | :47-66 | `ClassPathEntry` base class (volatile _next) |
| `src/hotspot/share/classfile/classLoader.hpp` | :68-82 | `ClassPathDirEntry` |
| `src/hotspot/share/classfile/classLoader.hpp` | :98-125 | `ClassPathZipEntry` — 压缩资源访问 |
| `src/hotspot/share/classfile/classLoader.hpp` | :128-146 | `ClassPathImageEntry` — jimage 访问 |
| `src/hotspot/share/classfile/classLoader.hpp` | :152-164 | `ModuleClassPathList` — 模块路径列表 |
| `src/hotspot/share/classfile/classLoader.hpp` | :168-400 | `ClassLoader: AllStatic` — 完整声明 |
| `src/hotspot/share/runtime/os.cpp` | :282-340 | `os::dll_locate_lib()` — 路径搜索算法 |
| `src/java.base/share/native/libjimage/jimage.cpp` | :58-163 | `JIMAGE_*` — 6 个 C API 入口 |
| `src/java.base/share/native/libjimage/imageFile.cpp` | :44 | `memory_map_image` — 仅 64 位 mmap |
| `src/java.base/share/native/libjimage/imageFile.cpp` | :274-303 | `ImageFileReader::open()` — 打开 + 复用 |
| `src/java.base/share/native/libjimage/imageFile.cpp` | :369-418 | `ImageFileReader::open()` — mmap + parser |
| `src/java.base/share/native/libjimage/imageFile.cpp` | :533-565 | `get_resource()` — 读取 + 解压逻辑 |
| `src/java.base/unix/native/libjimage/osSupport_unix.cpp` | :74-82 | mmap 实现 (PROT_READ \| MAP_SHARED) |

---

## §十一 总结

`classLoader_init1()` 是 init_globals 中**类加载系统的底座初始化**。它本身影响面小（5 个符号），但它设置的 zip 函数指针和 classpath 链表在运行期被 `SystemDictionary::resolve_or_null()` 的 86+ 个符号依赖。核心机制：

1. **30 个 PerfData 计数器**：覆盖类加载全生命周期（含 self 版本分离子调用耗时）
2. **7 个 dlsym 函数指针**：ZIP_Open→ZIP_CRC32，类加载时通过函数指针调用 libzip.so
3. **两种构建模式**：jimage（正式构建）vs exploded build（开发构建）
4. **两阶段分离**：init1 不依赖 SymbolTable（zip + classpath），init2 需要 SymbolTable（patch-module）
5. **三层查找架构**：--patch-module（最高优先级）→ base piece（jimage/exploded）→ boot append（最低优先级）
6. **jimage mmap 管道**：仅 64 位使用 mmap (PROT_READ | MAP_SHARED)，实现零拷贝 + 页面缓存共享 + 惰性页面加载

### 本文各 Section 方法覆盖

| Section | 覆盖方法数 | 深度 |
|---------|----------|------|
| §一 | `initialize()`, `load_zip_library()`, `setup_bootstrap_search_path()`, `classLoader_init2()` | 高 — 有伪码 + 行引用 |
| §二 | 所有 ClassPathEntry 成员 + 全局指针布局 | 高 — 五指针架构图 |
| §三 | `load_class()`, `search_module_entries()`, `open_stream()` | 高 — 三次尝试伪码 |
| §四 | `dll_locate_lib()`, ZipOpen/FindEntry/ReadEntry/GetNextEntry/ZipInflateFully/Crc32/CanonicalizeEntry 使用场景 | 高 — 每个函数指针有独立场景 |
| §五 | `JIMAGE_Open()`, `JIMAGE_FindResource()`, `JIMAGE_GetResource()`, `ImageFileReader::open()`, `get_resource()` | 高 — mmap 链路完整 |
| §六 | `find_image()` (引用计数), `open_stream()` 延迟语义 | 中 — 澄清无 LazyClassPathEntry |
| §七 | 完整数据流 | 中 — 有来源行号 |
| §八 | 6 个边缘场景 | 中 — 运行时报错 + 诊断方法 |
