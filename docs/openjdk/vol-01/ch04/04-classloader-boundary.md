# 4.4 classLoader_init1 边界 + os_init_globals 空实现

4.3 节讲了 `bytecodes_init`——初始化 JVM 字节码表。本节讲 `init_globals()` 接下来的两个函数：`classLoader_init1()` 和 `os_init_globals()`。

这两个函数本身都很薄——`classLoader_init1` 只有 3 行，`os_init_globals` 只有 1 行。但 `classLoader_init1` 背后有 dlsym 加载 zip 库的机制，`os_init_globals` 则是个空壳——真正的 OS 初始化在更早的 `os::init()` / `os::init_2()` 里。本节讲清楚这两个函数的边界。

---

## classLoader_init1() 全貌源码

```cpp
/* === src/hotspot/share/classfile/classLoader.cpp:1805 === */

void classLoader_init1() {
  ClassLoader::initialize();
}
```

只有 3 行，转调 `ClassLoader::initialize()`（`classLoader.cpp:1653-1717`）。后者做 4 件事：

1. 创建 30 个 PerfData 性能计数器（类加载统计）
2. `load_zip_library()`——dlopen 加载 libzip.so，dlsym 查找 7 个 ZIP 函数
3. 如果 `DumpSharedSpaces`，创建 `SharedPathsMiscInfo` 对象（CDS 相关）
4. `setup_bootstrap_search_path()`——构建引导类加载器搜索路径

PerfData 计数器的创建机制和 ch03/06 的 `ObjectMonitor::Initialize()` 一样（都是 `PerfDataManager::create_counter` 往共享内存里写 PerfDataEntry），本节不再重复。重点讲第 2、3、4 步。

---

## SharedPathsMiscInfo（CDS 相关）

第 3 步的源码（`classLoader.cpp:1710-1715`）：

```cpp
#if INCLUDE_CDS
  if (DumpSharedSpaces) {
    _shared_paths_misc_info = new SharedPathsMiscInfo();
  }
#endif
```

`DumpSharedSpaces` 是一个 JVM flag——用 `-Xshare:dump` 启动时为 true，表示"生成 CDS 归档文件"而不是"正常启动 JVM"。普通启动时这个 flag 是 false，这步跳过。

`SharedPathsMiscInfo` 是什么？它是一个记录**类路径信息**的对象——boot classpath、app classpath 等。在 CDS dump 时把这些路径信息记录下来，写入 CDS 归档文件的文件头。运行时用 CDS 归档启动时，会读出这些路径信息并校验——如果运行时的类路径和 dump 时不一致，CDS 归档就不可用（因为路径变了，类的位置可能变了）。

> **CDS 在生产环境用得多吗？** CDS（Class Data Sharing）是 JDK 5 引入的特性，把核心类的元数据预先归档到共享文件，启动时 mmap 进内存，跳过类加载的部分步骤，加快 JVM 启动。**从 JDK 12 开始默认开启**（`-Xshare:auto`），所以现代 JDK 生产环境**普遍在用**——只是大多数人不知道。但 CDS 的 **dump 阶段**（`-Xshare:dump`）只在制作归档时运行一次，不是常规启动路径。本节讲的 `SharedPathsMiscInfo` 只在 dump 阶段创建，**普通启动时不走这步**。
>
> CDS 的完整机制（归档格式、mmap 映射、指针修补、共享字典等）在后续专门的 CDS 章节展开。本节只需知道"classLoader_init1 在 CDS dump 模式下会额外记录路径信息"即可。

**普通启动时这步不做**——只有 `-Xshare:dump` 时才创建 `SharedPathsMiscInfo`。后续在 CDS 相关章节展开。

---

## setup_bootstrap_search_path()：构建引导类加载器搜索路径

第 4 步的源码（`classLoader.cpp:640-654`）：

```cpp
/* === src/hotspot/share/classfile/classLoader.cpp:640 === */

void ClassLoader::setup_bootstrap_search_path() {
  const char* sys_class_path = Arguments::get_sysclasspath();
  if (PrintSharedArchiveAndExit) {
    // Don't print sys_class_path
  } else {
    trace_class_path("bootstrap loader class path=", sys_class_path);
  }
#if INCLUDE_CDS
  if (DumpSharedSpaces) {
    _shared_paths_misc_info->add_boot_classpath(sys_class_path);
  }
#endif
  setup_boot_search_path(sys_class_path);
}
```

### 什么是引导类加载器搜索路径

Java 有三种类加载器：引导类加载器（Bootstrap ClassLoader）、扩展类加载器、应用类加载器。引导类加载器负责加载 JDK 核心类（`java.lang.Object`、`java.lang.String` 等）——这些类在 JDK 的 `lib/modules` 文件（jimage 格式）里。

但 JVM 要知道去哪里找这些类——这就是"搜索路径"。`Arguments::get_sysclasspath()` 返回的就是引导类加载器的搜索路径，在 JVM 启动参数解析阶段（ch03/04 讲的 `Arguments::parse`）设置好的。

### setup_boot_search_path 做什么

`setup_boot_search_path(sys_class_path)`（`classLoader.cpp:818`）遍历搜索路径里的每个条目，为每个条目创建一个 `ClassPathEntry` 对象。搜索路径是用路径分隔符（Linux 上是 `:`）分隔的多个路径，比如 `/usr/lib/jvm/java-11/lib/modules:/path/to/app.jar`。

源码（`classLoader.cpp:818-875`）核心是一个 for 循环遍历路径：

```cpp
/* === src/hotspot/share/classfile/classLoader.cpp:818 === */

void ClassLoader::setup_boot_search_path(const char *class_path) {
  int len = (int)strlen(class_path);
  int end = 0;
  bool set_base_piece = true;

  // 遍历路径里的每个条目（用路径分隔符分隔）
  for (int start = 0; start < len; start = end) {
    // 找到下一个路径分隔符
    while (class_path[end] && class_path[end] != os::path_separator()[0]) {
      end++;
    }
    // 提取这一段路径
    char* path = ...;  // 例如 "/usr/lib/jvm/java-11/lib/modules" 或 "/path/to/app.jar"

    if (set_base_piece) {
      // 第一段路径必须是 jimage 文件（lib/modules）或 java.base exploded build
      struct stat st;
      if (os::stat(path, &st) == 0) {
        ClassPathEntry* new_entry = create_class_path_entry(path, &st, false, false, CHECK);
        if (Arguments::has_jimage()) {
          _jrt_entry = new_entry;   // 保存 jimage 入口
        }
      }
      set_base_piece = false;
    } else {
      // 后续路径（-Xbootclasspath/a 追加的）调 update_class_path_entry_list
      update_class_path_entry_list(path, false, true);
    }

    // 跳过路径分隔符
    while (class_path[end] == os::path_separator()[0]) { end++; }
  }
}
```

### ClassPathEntry 的三种子类

`ClassPathEntry` 是基类（`classLoader.hpp:47`），有三个子类，分别对应三种类来源：

```
ClassPathEntry (CHeapObj, 基类)
  _next → 链表指针
  open_stream(name) → 核心方法：打开类文件流
├── ClassPathDirEntry       // 从目录读 class 文件
│     _dir → 目录路径
│     open_stream() → 拼接路径打开文件
├── ClassPathZipEntry       // 从 jar/zip 读 class 文件
│     _zip → jzfile* 句柄（用前面加载的 ZIP_Open 打开的）
│     _zip_name → jar 文件名
│     open_stream() → 调 FindEntry + ReadEntry 读 class
└── ClassPathImageEntry     // 从 jimage 文件读 class 文件
      _jimage → JImageFile* 句柄
      open_stream() → 调 JImageFindResource + JImageGetResource 读 class
```

| 子类 | `is_jar_file()` | `is_modules_image()` | 读 class 的方式 |
|------|----------------|---------------------|--------------|
| `ClassPathDirEntry` | false | false | `open()` 系统调用直接读文件 |
| `ClassPathZipEntry` | true | false | 调前面 dlsym 加载的 `ZIP_Open`/`ZIP_FindEntry`/`ZIP_ReadEntry` |
| `ClassPathImageEntry` | false | true | 调 `JIMAGE_FindResource`/`JIMAGE_GetResource` |

`open_stream(name)` 是核心方法——传入类名（如 `"java/lang/String"`），返回 `ClassFileStream*`（class 文件的字节流），后续 ClassFileParser 解析这个流。

### 实际的搜索路径长什么样

在 jdk11u-copy 构建输出里，`Arguments::get_sysclasspath()` 返回的第一段是：

```
/data/workspace/jdk11u-copy/build/linux-x86_64-normal-server-slowdebug/jdk/modules
```

注意这是 **exploded build**（展开构建）——`modules` 是个**目录**而不是打包的 jimage 文件。目录里直接放的就是 .class 文件：

```
$ ls jdk/modules/java.base/
com/  java/  javax/  jdk/  META-INF/  module-info.class  sun/

$ find jdk/modules/java.base/ -name "String.class"
jdk/modules/java.base/java/lang/String.class    ← 直接就是 .class 文件
```

JVM 从这个目录读 class 文件时走的是 `ClassPathDirEntry`——直接用 `open()` 系统调用读文件。

### jimage 是什么格式

标准安装的 JDK（如 KonaJDK）的 `lib/modules` 不是目录，而是**一个文件**：

```
$ file /usr/lib/jvm/java-11-konajdk/lib/modules
Java module image (little endian), version 1.0

$ du -sh /usr/lib/jvm/java-11-konajdk/lib/modules
137M

$ xxd /usr/lib/jvm/java-11-konajdk/lib/modules | head -3
00000000: dada feca 0000 0100 0000 0000 dd84 0000  ................
```

`file` 命令识别为 "Java module image"——这是 JDK 9 引入的 **jimage** 格式。开头 4 字节 `0xdadafeca` 是 jimage 的魔数（和 class 文件的 `0xCAFEBABE` 不同）。137MB 的文件里打包了所有核心类的 .class 文件，但**不是 zip/jar 格式**，而是专门为 JVM 快速加载设计的格式——所有 class 内容紧凑排列，mmap 后直接用偏移量定位，不用解压。

### 为什么 jdk11u-copy 是目录而标准 JDK 是文件

| | jdk11u-copy（编译输出） | 标准 JDK（安装版） |
|---|---|---|
| `modules` 是什么 | **目录** | **jimage 文件** |
| class 在哪 | 直接是 `java.base/java/lang/String.class` | 打包在 137MB 的文件里 |
| JVM 用哪个子类 | `ClassPathDirEntry`（`open()` 直接读文件） | `ClassPathImageEntry`（用 `JIMAGE_FindResource` 定位） |
| 为什么 | `make` 编译后默认是展开形式，方便改代码重新编译立即生效 | 发布前用 `jlink` 工具把目录打包成 jimage，减少文件数量、加快启动 |

jdk11u-copy 是开发用的——改了某个 .java 文件，`make` 重新编译后直接生成新的 .class 文件放在目录里，JVM 立即能读到。如果每次改代码都要重新打包 jimage，开发效率太低。标准 JDK 是发布给用户用的——打包成 jimage 减少文件数量（从几万个 .class 变成 1 个文件），启动时 mmap 一次就全加载了。

### 对 ClassPathEntry 的影响

`setup_boot_search_path()` 遍历搜索路径时，根据每个条目是目录还是文件创建不同的 `ClassPathEntry` 子类：

| 条目类型 | 创建的子类 | 怎么读 class |
|---------|----------|------------|
| 目录（如 jdk11u-copy 的 `modules/`） | `ClassPathDirEntry` | `open()` 系统调用直接读 .class 文件 |
| jar/zip 文件 | `ClassPathZipEntry` | 调 `ZIP_Open`/`ZIP_FindEntry`/`ZIP_ReadEntry` |
| jimage 文件（如标准 JDK 的 `lib/modules`） | `ClassPathImageEntry` | 调 `JIMAGE_FindResource`/`JIMAGE_GetResource` |

这就是为什么 `load_zip_library()` 要在 `setup_bootstrap_search_path()` 之前执行——如果搜索路径里有 jar/zip，`ClassPathZipEntry` 要用 ZIP 函数。

如果有 `-Xbootclasspath/a:/path/to/app.jar`，app.jar 会作为后续条目追加，创建 `ClassPathZipEntry`。

### 和前面步骤的关系

第 4 步依赖第 2 步——`ClassPathZipEntry` 要用 `load_zip_library()` 加载的 ZIP 函数（`ZipOpen`/`FindEntry`/`ReadEntry` 等）才能从 jar 里读 class 文件。`ClassPathImageEntry` 要用 `JIMAGE_Open` 等 jimage 函数（但这些在 `lookup_vm_options()` 更早加载，不在 `classLoader_init1` 里）。所以 `load_zip_library()` 必须在 `setup_bootstrap_search_path()` 之前执行。

第 4 步也依赖第 3 步（仅在 CDS dump 时）——如果 `DumpSharedSpaces`，把 boot classpath 写入 `SharedPathsMiscInfo`，写入 CDS 归档文件头。

---

## load_zip_library()：dlsym 加载 7 个 ZIP 函数

### 为什么要加载 zip 库

Java 的类文件通常打包在 jar（zip 格式）里。JVM 要从 jar 里读 class 文件，需要 zip 解压能力。但 HotSpot 自己不实现 zip 解压——它调用 JDK 自带的 libzip.so 里的函数。

这和 ch01 讲的 dlopen 形成对称：ch01 里 Java 启动器用 dlopen 加载 libjvm.so（Java 启动 C++ JVM），这里 JVM 用 dlsym 加载 libzip.so（C++ JVM 回调 Java 生态的本地库）。

### 加载过程

`classLoader.cpp:1148-1185`：

```cpp
/* === src/hotspot/share/classfile/classLoader.cpp:1148 === */

void ClassLoader::load_zip_library() {
  assert(ZipOpen == NULL, "should not load zip library twice");
  // 先确保 libjava.so 已加载
  os::native_java_library();
  // 定位 libzip.so 的路径
  char path[JVM_MAXPATHLEN];
  char ebuf[1024];
  void* handle = NULL;
  if (os::dll_locate_lib(path, sizeof(path), Arguments::get_dll_dir(), "zip")) {
    handle = os::dll_load(path, ebuf, sizeof ebuf);     // 底层是 dlopen
  }
  if (handle == NULL) {
    vm_exit_during_initialization("Unable to load ZIP library", path);
  }
  // 用 dlsym 查找 7 个 ZIP 函数
  ZipOpen         = CAST_TO_FN_PTR(ZipOpen_t,         os::dll_lookup(handle, "ZIP_Open"));
  ZipClose        = CAST_TO_FN_PTR(ZipClose_t,        os::dll_lookup(handle, "ZIP_Close"));
  FindEntry       = CAST_TO_FN_PTR(FindEntry_t,       os::dll_lookup(handle, "ZIP_FindEntry"));
  ReadEntry       = CAST_TO_FN_PTR(ReadEntry_t,        os::dll_lookup(handle, "ZIP_ReadEntry"));
  GetNextEntry    = CAST_TO_FN_PTR(GetNextEntry_t,     os::dll_lookup(handle, "ZIP_GetNextEntry"));
  ZipInflateFully = CAST_TO_FN_PTR(ZipInflateFully_t,  os::dll_lookup(handle, "ZIP_InflateFully"));
  Crc32           = CAST_TO_FN_PTR(Crc32_t,            os::dll_lookup(handle, "ZIP_CRC32"));
  // 校验关键函数非 NULL
  if (ZipOpen == NULL || FindEntry == NULL || ReadEntry == NULL ||
      GetNextEntry == NULL || Crc32 == NULL) {
    vm_exit_during_initialization("Corrupted ZIP library", path);
  }
  // 额外从 libjava.so 查找 Canonicalize 函数
  void *javalib_handle = os::native_java_library();
  CanonicalizeEntry = CAST_TO_FN_PTR(canonicalize_fn_t, os::dll_lookup(javalib_handle, "Canonicalize"));
}
```

`os::dll_load` 底层是 `dlopen`，`os::dll_lookup` 底层是 `dlsym`——都是 C 标准库的动态链接函数。

### 7 个 ZIP 函数

| 符号名 | 做什么 |
|--------|--------|
| `ZIP_Open` | 打开 zip/jar 文件，返回句柄 |
| `ZIP_Close` | 关闭 zip/jar 文件 |
| `ZIP_FindEntry` | 在 zip 里按名字查找条目 |
| `ZIP_ReadEntry` | 读取 zip 条目内容到 buffer |
| `ZIP_GetNextEntry` | 遍历 zip 里的下一个条目 |
| `ZIP_InflateFully` | 把压缩数据完整解压到 buffer |
| `ZIP_CRC32` | 计算 CRC32 校验值 |

JVM 后续从 jar 里读 class 文件时就调这些函数指针——打开 jar、查找条目、读取内容、解压。

### 和 ch01 的对称关系

| 方向 | 谁 | 做什么 | 底层调用 |
|------|-----|--------|---------|
| Java → C++ | Java 启动器 | dlopen libjvm.so，dlsym JNI_CreateJavaVM | dlopen/dlsym |
| C++ → Java 生态 | JVM (classLoader_init1) | dlopen libzip.so，dlsym ZIP_Open 等 7 个函数 | os::dll_load / os::dll_lookup |

Java 启动器通过 dlopen 把 JVM 加载进进程，JVM 启动后通过 dlopen 把 Java 生态的本地库（libzip）加载进来——两个方向都用同样的动态链接机制。

---

## classLoader_init1 不做什么——边界澄清

`classLoader_init1()` 只做 zip 库加载 + PerfData + bootstrap 路径构建。以下事情**不在这里**做：

| 不做的事 | 在哪里做 | 何时 |
|---------|---------|------|
| 创建 ClassLoaderData（引导类加载器的元数据容器） | `universe_init()` 里的 `ClassLoaderData::init_null_class_loader_data()` | `init_globals()` 第 111 行，在 classLoader_init1 之后 |
| 创建 java.base 的 ModuleEntry | `classLoader_init2()` | `universe2_init()` 阶段（`init_globals()` 第 124 行，间接调用） |
| 处理 `--patch-module` | `classLoader_init2()` | 同上 |
| 加载 libjimage.so | `lookup_vm_options()` | `Arguments::parse()` 阶段，早于 init_globals |
| 加载任何 Java 类 | 后续阶段 | `initialize_java_lang_classes()` 等 |

### classLoader 初始化的三个阶段

classLoader 相关的初始化分散在 `init_globals()` 的三个子阶段里：

```
init_globals() [init.cpp:101]
  line 105: classLoader_init1()      ← 阶段 1（本节讲）
  line 109: os_init_globals()         ← 空壳（本节讲）
  line 111: universe_init()           ← 阶段 2: ClassLoaderData::init_null_class_loader_data()
  ...
  line 124: universe2_init()          ← 阶段 3: classLoader_init2()
    → genesis()
      → SystemDictionary::initialize()
        → resolve_well_known_classes()
          → ClassLoader::classLoader_init2()
```

| 阶段 | 做什么 | 调用位置 |
|------|--------|---------|
| 1. classLoader_init1 | zip 库加载 + PerfData + bootstrap 路径 | init.cpp:105 |
| 2. init_null_class_loader_data | 创建引导类加载器的 ClassLoaderData | universe.cpp:711 |
| 3. classLoader_init2 | java.base ModuleEntry + --patch-module + exploded build | systemDictionary.cpp:1995 |

阶段 2 和 3 在后续章节（universe_init 相关）展开，本节只讲阶段 1。

---

## os_init_globals()：一个空壳

### 源码

```cpp
/* === src/hotspot/share/runtime/os.cpp:91 === */

void os_init_globals() {
  // Called from init_globals().
  os::init_globals();
}
```

转调 `os::init_globals()`，后者在 `os.hpp:175` 是个内联空壳：

```cpp
/* === src/hotspot/share/runtime/os.hpp:175 === */

  static void init_globals(void) {
    init_globals_ext();
  }
```

而 `init_globals_ext()` 的默认实现（`os_ext.hpp:33`）是**空函数体**：

```cpp
/* === src/hotspot/share/runtime/os_ext.hpp:33 === */

  static void init_globals_ext() {} // Run from init_globals().
```

所以 `os_init_globals()` 在默认构建中**什么都不做**——它是个扩展点（extension point），允许平台特定的 OS 实现覆盖 `init_globals_ext()` 做额外初始化，但 JDK 11 默认构建里是空的。

### 真正的 OS 初始化在哪里

真正的 OS 初始化在 `os::init()` 和 `os::init_2()` 里，它们在 `Threads::create_vm()` 中被调用，**早于** `init_globals()`：

```
Threads::create_vm() [thread.cpp:3702]
  line 3721: os::init()        ← OS 第一阶段（参数解析前）
  line 3774: os::init_2()      ← OS 第二阶段（参数解析后）
  line 3809: vm_init_globals()  ← VM 线程做的全局初始化
  line 3846: init_globals()     ← Java 线程做的全局初始化
    line 109: os_init_globals()  ← 空壳，什么都不做
```

`os::init()` 做的事：获取时钟频率、页大小、CPU 数、内存信息、初始化时钟等（`os_linux.cpp:5529`）。

`os::init_2()` 做的事：初始化信号处理器、suspend/resume 支持、最小栈大小、libpthread 初始化、NUMA 等（`os_linux.cpp:5588`）。这些在 ch03/05 已经讲过。

所以 `os_init_globals()` 在 `init_globals()` 里只是个占位符——真正的 OS 初始化在更早就做完了。

---

## 小结

`classLoader_init1()` 做了 4 件事：
1. 创建 30 个 PerfData 计数器（类加载统计）
2. dlopen 加载 libzip.so，dlsym 查找 7 个 ZIP 函数
3. CDS 模式下创建 SharedPathsMiscInfo
4. 构建引导类加载器搜索路径

`os_init_globals()` 什么都不做——是空壳扩展点，真正的 OS 初始化在 `os::init()` / `os::init_2()` 里，早于 `init_globals()`。

下一节（4.5）合并讲 4 个 trivial 函数：`accessFlags_init` / `invocationCounter_init` / `InterfaceSupport_init` / `VMRegImpl::set_regName`——它们都只有几行，但背后各有小机制。
