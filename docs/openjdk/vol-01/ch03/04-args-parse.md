# 3.4 Stage 2：参数解析

从 `Threads::create_vm` 的 Stage 2 开始，命令行的 `-Xms/-Xmx/-XX:+UseG1GC` 才真正拿到语义。Stage 2 的源码：

```c
/* === src/hotspot/share/runtime/thread.cpp === */

// 第一组：初始化基础设施
Arguments::init_system_properties();                   // 创建系统属性空链表
JDK_Version_init();                                     // 读取 JDK 版本号
Arguments::init_version_specific_system_properties();   // 补齐版本相关属性
LogConfiguration::initialize(create_vm_timer.begin_time());  // 初始化统一日志框架

// 第二组：解析命令行 + 环境变量 + vm_options 资源
jint parse_result = Arguments::parse(args);
if (parse_result != JNI_OK) return parse_result;

// 第三组：自动推算 + 校验
os::init_before_ergo();
jint ergo_result = Arguments::apply_ergo();
if (ergo_result != JNI_OK) return ergo_result;

if (!JVMFlagRangeList::check_ranges()) {
    return JNI_EINVAL;
}
bool constraint_result = JVMFlagConstraintList::check_constraints(JVMFlagConstraint::AfterErgo);
if (!constraint_result) {
    return JNI_EINVAL;
}

// 收尾
JVMFlagWriteableList::mark_startup();
if (PauseAtStartup) {
    os::pause();
}
```

四个阶段：初始化基础设施、解析参数、自动推算校验、收尾。下面逐个展开。

---

## Arguments::init_system_properties() —— 创建系统属性空链表

第一行就做这件事，在 `arguments.cpp:381-420`：

```c
void Arguments::init_system_properties() {

  // Set up _system_boot_class_path which is not a property but
  // relies heavily on argument processing and the jdk.boot.class.path.append
  // property. It is used to store the underlying system boot class path.
  _system_boot_class_path = new PathString(NULL);

  PropertyList_add(&_system_properties, new SystemProperty("java.vm.specification.name",
                                                           "Java Virtual Machine Specification",  false));
  PropertyList_add(&_system_properties, new SystemProperty("java.vm.version", VM_Version::vm_release(),  false));
  PropertyList_add(&_system_properties, new SystemProperty("java.vm.name", VM_Version::vm_name(),  false));
  PropertyList_add(&_system_properties, new SystemProperty("jdk.debug", VM_Version::jdk_debug_level(),  false));

  // Initialize the vm.info now, but it will need updating after argument parsing.
  _vm_info = new SystemProperty("java.vm.info", VM_Version::vm_info_string(), true);

  // Following are JVMTI agent writable properties.
  // Properties values are set to NULL and they are
  // os specific they are initialized in os::init_system_properties_values().
  _sun_boot_library_path = new SystemProperty("sun.boot.library.path", NULL,  true);
  _java_library_path = new SystemProperty("java.library.path", NULL,  true);
  _java_home =  new SystemProperty("java.home", NULL,  true);
  _java_class_path = new SystemProperty("java.class.path", "",  true);
  // jdk.boot.class.path.append is a non-writeable, internal property.
  _jdk_boot_class_path_append = new SystemProperty("jdk.boot.class.path.append", "", false, true);

  // Add to System Property list.
  PropertyList_add(&_system_properties, _sun_boot_library_path);
  PropertyList_add(&_system_properties, _java_library_path);
  PropertyList_add(&_system_properties, _java_home);
  PropertyList_add(&_system_properties, _java_class_path);
  PropertyList_add(&_system_properties, _jdk_boot_class_path_append);
  PropertyList_add(&_system_properties, _vm_info);

  // Set OS specific system properties values
  os::init_system_properties_values();
}
```

`SystemProperty` 是一个单链表节点，继承自 `PathString`（一个长度自适应的字符串管理器），定义在 `arguments.hpp:90-131`：

```c
class SystemProperty : public PathString {
 private:
  char*           _key;
  SystemProperty* _next;
  bool            _internal;
  bool            _writeable;

 public:
  char* value() const                 { return PathString::value(); }
  const char* key() const             { return _key; }
  bool internal() const               { return _internal; }
  SystemProperty* next() const        { return _next; }
  void set_next(SystemProperty* next) { _next = next; }

  SystemProperty(const char* key, const char* value, bool writeable, bool internal = false);
};
```

在解释 `SystemProperty` 的构造函数之前，必须先看懂它的父类 `PathString`——属性值就存在这个父类里。

### PathString —— 属性值的所有权管理器

`PathString` 定义在 `arguments.hpp:58-69`，是 SystemProperty 的直接父类：

```c
class PathString : public CHeapObj<mtArguments> {
 protected:
  char* _value;                   // 唯一数据成员：堆上的 C 字符串
 public:
  char* value() const { return _value; }

  bool set_value(const char *value);
  void append_value(const char *value);

  PathString(const char* value);
  ~PathString();
};
```

基类 `CHeapObj<mtArguments>` 是一个纯标记类——没有虚函数，只表示"这个对象分配在 C 堆上（malloc，不是 GC 堆）"，模板参数 `mtArguments` 是 NMT（Native Memory Tracking）的内存分类标签，让 `jcmd VM.native_memory summary` 能把这块内存计入"Arguments"类别。

`_value` 指向堆上由 `AllocateHeap`（HotSpot 的 `malloc` 包装）分配的内存。四个方法在 `arguments.cpp:120-173`：

```c
// ===== 构造：深拷贝 =====
PathString::PathString(const char* value) {
  if (value == NULL) {
    _value = NULL;                               // 允许 NULL——空壳，等后续 set_value
  } else {
    _value = AllocateHeap(strlen(value)+1, mtArguments);  // malloc
    strcpy(_value, value);                       // 深拷贝，不持有外部指针
  }
}

// ===== 设值：释放旧值→分配新值 =====
bool PathString::set_value(const char *value) {
  if (_value != NULL) {
    FreeHeap(_value);                            // 释放旧内存
  }
  _value = AllocateHeap(strlen(value)+1, mtArguments);
  if (_value != NULL) {
    strcpy(_value, value);
  } else {
    return false;                                // OOM 时返回 false
  }
  return true;
}

// ===== 追加：自动插入路径分隔符 =====
void PathString::append_value(const char *value) {
  char *sp;
  size_t len = 0;
  if (value != NULL) {
    len = strlen(value);
    if (_value != NULL) {
      len += strlen(_value);                     // 总长度 = 旧 + 新
    }
    sp = AllocateHeap(len+2, mtArguments);       // +2 = 分隔符 + '\0'
    if (sp != NULL) {
      if (_value != NULL) {
        strcpy(sp, _value);
        strcat(sp, os::path_separator());        // Linux 是 ":"
        strcat(sp, value);
        FreeHeap(_value);                        // 释放旧内存
      } else {
        strcpy(sp, value);
      }
      _value = sp;
    }
  }
}

// ===== 析构 =====
PathString::~PathString() {
  if (_value != NULL) {
    FreeHeap(_value);
    _value = NULL;
  }
}
```

**关键设计点：**

1. **不是原地修改，而是"释放→重分配"。** `set_value` 和 `append_value` 都不修改原 `_value` 指向的内存——它们释放旧内存、分配新内存、拷贝新值。外部持有了旧 `_value` 指针的代码，在 set/append 之后指针就悬空了。这和 Java `String` 的不可变性是同一个思路，只不过 Java 用 GC 自动回收，PathString 用手动 free+malloc。

2. **`append_value` 是路径语义，不是通用字符串追加。** 注意内部插入了 `os::path_separator()`（Linux 是 `":"`）。它专为类路径拼接设计——`-Xbootclasspath/a:/other.jar` 最终调用 `append_sysclasspath("/other.jar")`，内部走 `append_value` 自动加 `:`。

3. **`AllocateHeap` / `FreeHeap` 是带内存标签的 malloc/free。** 模板参数 `mtArguments` 让 NMT 追踪到"这块内存属于参数解析"——调 `jcmd <pid> VM.native_memory summary` 时，Arguments 的内存占用独立统计。

**Java 类比：**

```java
class PathString {
    protected String value;

    public PathString(String value) { this.value = value; }

    // 对应 set_value：替换（旧 String 由 GC 回收）
    public boolean setValue(String value) {
        this.value = value;
        return true;
    }

    // 对应 append_value：路径拼接，自动加 File.pathSeparator
    public void appendValue(String value) {
        if (value != null) {
            if (this.value != null) {
                this.value = this.value + File.pathSeparator + value;  // Linux 自动加 ":"
            } else {
                this.value = value;
            }
        }
    }

    public String value() { return value; }

    // 析构——Java 不需要，GC 自动回收
}
```

`PathString` 的本质：**C 字符串的所有权管理器**。Java 里 GC 和 `String` 不可变性隐式完成了这件事，HotSpot 在 C 语言中必须手动封装——`AllocateHeap` 分配、`FreeHeap` 释放、`strcpy` 拷贝——PathString 把这三步包在一个类里。

有了父类的完整理解，再看 SystemProperty 的构造函数，`arguments.cpp:194-204`：

```c
SystemProperty::SystemProperty(const char* key, const char* value,
                               bool writeable, bool internal)
  : PathString(value)                       // ← 父类构造：malloc + strcpy 存 value
{
  if (key == NULL) {
    _key = NULL;
  } else {
    _key = AllocateHeap(strlen(key)+1, mtArguments);  // 深拷贝 key
    strcpy(_key, key);
  }
  _next = NULL;                // 刚创建时不属于任何链表
  _internal = internal;
  _writeable = writeable;
}
```

构造函数做了两件事：调用 `PathString(value)` 把属性值存入父类的 `_value`，然后把 `_key` 也深拷贝一份。`_next = NULL` 表示新节点初始独立，等 `PropertyList_add` 尾插法把它链入链表。

### writeable、internal、readable 三种权限

构造函数里的 `writeable` 和 `internal` 两个 bool，决定了这个属性的三种访问控制。它们在 `SystemProperty` 类中对应的方法（`arguments.hpp:96-127`）：

```c
private:
  bool writeable() { return _writeable; }   // 是否允许写

public:
  bool is_readable() const {                // 是否可读
    return !_internal                       // 非 internal 属性 → 可读
        || strcmp(_key, "jdk.boot.class.path.append") == 0;  // 唯一例外
  }

  bool set_writeable_value(const char *value) {
    if (writeable()) {                      // ★ 只有 writeable=true 才允许写
      return set_value(value);              // 调到父类 PathString::set_value
    }
    return false;                           // 否则静默拒绝
  }
```

**四种属性类型举例：**

| 属性 | writeable | internal | readable | 含义 |
|------|-----------|----------|----------|------|
| `java.vm.name` | false | false | true | 规范声明，只读 |
| `sun.boot.library.path` | true | false | true | OS 启动时写入，后续 JVMTI 可改 |
| `java.class.path` | true | false | true | 用户 `-Djava.class.path=...` 可写 |
| `jdk.boot.class.path.append` | false | true | **true** | 唯一的 internal 但 readable——只允许 `-Xbootclasspath/a:` 修改 |

关键理解：**writeable 控制"写"权限**（谁可以通过 `set_writeable_value` 修改）；**internal 控制"读"权限**（`System.getProperty` 能不能读到）。`java.class.path` 初始值设为 `""` 的原因就在这里——它 writeable=true，用户传 `-Djava.class.path=xxx` 时，`Arguments::parse` 会调用 `set_writeable_value` 把 `""` 覆盖成实际值。空串只是一个"占位符"，确保 `_java_class_path` 指针非 NULL，后续写入有地方可写。

### PropertyList_add —— 尾插法

```c
void Arguments::PropertyList_add(SystemProperty** plist, SystemProperty *new_p) {
  SystemProperty* p = *plist;
  if (p == NULL) {
    *plist = new_p;           // 空链表：新节点直接当头
  } else {
    while (p->next() != NULL) {
      p = p->next();          // 遍历到尾部
    }
    p->set_next(new_p);       // 尾部追加
  }
}
```

尾插法意味着属性在链表中的顺序就是 `init_system_properties` 代码中的添加顺序。`_system_properties` 是 `Arguments` 类的静态成员（`arguments.hpp:291`），类型 `SystemProperty*`，作为整个系统属性链表的头指针。

### 最后一步：`os::init_system_properties_values()` 

回到 `init_system_properties` 第 63-68 行，那时有三条属性是带着 NULL 值创建的：

```c
_sun_boot_library_path = new SystemProperty("sun.boot.library.path", NULL,  true);
_java_library_path     = new SystemProperty("java.library.path",     NULL,  true);
_java_home             = new SystemProperty("java.home",             NULL,  true);
```

现在 `os::init_system_properties_values()` 负责把这些 NULL 填上真实值。Linux 实现位于 `os_linux.cpp:400-521`，核心逻辑是用 `os::jvm_path` 获取 `libjvm.so` 的绝对路径，然后向上逐层剥目录：

```
libjvm.so 绝对路径（本机）
   /usr/lib/jvm/java-11-xxx/lib/server/libjvm.so
   │
   ├── strrchr(buf, '/') → 去掉 /libjvm.so
   │        /usr/lib/jvm/java-11-xxx/lib/server
   │
   ├── strrchr(buf, '/') → 去掉 /server
   │        /usr/lib/jvm/java-11-xxx/lib
   │        └── set_dll_dir(buf)   → sun.boot.library.path 填入此路径
   │
   ├── strrchr(buf, '/') → 去掉 /lib
   │        /usr/lib/jvm/java-11-xxx         ← 这就是 JAVA_HOME
   │        └── set_java_home(buf)           → java.home 填入此路径
   │
   ├── 拼接 java.library.path
   │       getenv("LD_LIBRARY_PATH") + ":/usr/java/packages/lib:" + DEFAULT_LIBPATH
   │       本机 LD_LIBRARY_PATH 为空，DEFAULT_LIBPATH(AMD64) = /usr/lib64:/lib64:/lib:/usr/lib
   │       → java.library.path = "/usr/java/packages/lib:/usr/lib64:/lib64:/lib:/usr/lib"
   │       └── set_library_path(result)
   │
   └── set_boot_path('/', ':')
           扫描 JAVA_HOME/lib/modules (jimage 文件)
           本机: /usr/lib/jvm/java-11-xxx/lib/modules 存在
            └── set_sysclasspath("/usr/lib/jvm/java-11-xxx/lib/modules", true)
```

三条 NULL 属性全部兑现：`sun.boot.library.path` 拿到了剥去 `libjvm.so` 的 lib 路径，`java.home` 拿到了剥去 `lib` 的 JAVA_HOME 路径，`java.library.path` 拿到了环境变量拼默认库路径。此外 `set_boot_path` 还顺便检测出本机是模块化镜像（有 `modules` jimage），把 `_system_boot_class_path`（最初 `new PathString(NULL)`）也填上了真实的 `modules` 文件路径。

#### `os::jvm_path` 是如何拿到路径的

整棵树的第一步——"获取 `libjvm.so` 的绝对路径"——在这里用的是 `os::jvm_path()`，实现位于 `os_linux.cpp:2878-2965`。它的原理和 Ch01 里启动器的 `GetJVMPath`（字符串拼接 + `stat()` 验证）完全不同：

```c
void os::jvm_path(char *buf, jint buflen) {
  static char saved_jvm_path[MAXPATHLEN] = {0};   // 缓存

  if (saved_jvm_path[0] != 0) {
    strcpy(buf, saved_jvm_path);        // 后续调用：直接返回缓存
    return;
  }

  // ★ 核心：把自己的函数地址喂给动态链接器，问"我在哪个 .so 里？"
  dll_address_to_library_name(
      CAST_FROM_FN_PTR(address, os::jvm_path),   // 传自己的地址
      dli_fname, sizeof(dli_fname), NULL);

  realpath(dli_fname, buf, buflen);     // 解析符号链接
  strncpy(saved_jvm_path, buf, MAXPATHLEN);  // 缓存起来
}
```

`dll_address_to_library_name` 内部有两层查询策略，`os_linux.cpp:1803-1840`：

```c
bool os::dll_address_to_library_name(address addr, char* buf,
                                     int buflen, int* offset) {
  struct _address_to_library_name data;
  data.addr = addr;
  data.fname = buf;
  data.buflen = buflen;
  data.base = NULL;

  // 策略1：遍历 ELF program header，返回地址所在的 .so
  int rslt = dl_iterate_phdr(address_to_library_name_callback, (void *)&data);
  if (rslt) {
    return true;                         // 回调已经填好了 buf
  }

  // 策略2：回退到 dladdr()
  Dl_info dlinfo;
  if (dladdr((void*)addr, &dlinfo) != 0) {
    jio_snprintf(buf, buflen, "%s", dlinfo.dli_fname);
    if (dlinfo.dli_fbase != NULL && offset != NULL) {
      *offset = addr - (address)dlinfo.dli_fbase;  // 返回相对偏移
    }
    return true;
  }
  return false;
}
```

两个 Linux 系统 API 分别解释：

**策略 1：`dl_iterate_phdr` —— 遍历进程的 ELF 加载表**

`dl_iterate_phdr` 是 GNU C 库提供的函数（非 POSIX 标准，Linux/BSD 可用）。它的工作方式是：ld.so（动态链接器）在加载进程时维护了一份"已加载共享库链表"（link map），每个节点记录了一个 .so 文件的名称、加载基址、以及 ELF Program Header 数组。`dl_iterate_phdr` 遍历这张表，对每个节点调用回调函数，传入 `struct dl_phdr_info`：

```c
struct dl_phdr_info {
    ElfW(Addr) dlpi_addr;        // 共享库的加载基址（link_map.l_addr）
    const char *dlpi_name;       // 共享库文件名
    const ElfW(Phdr) *dlpi_phdr; // ELF Program Header 数组指针
    ElfW(Half) dlpi_phnum;       // Program Header 数量
    // ...
};
```

HotSpot 的 `address_to_library_name_callback` 回调做的事情：遍历每个 `PT_LOAD` 段（真正被映射到内存的段），检查目标地址是否落在 `[dlpi_addr + p_vaddr, dlpi_addr + p_vaddr + p_memsz)` 范围内。如果命中，说明目标地址属于这个 .so——把文件名写入 `buf`，返回非零值终止遍历。

```
进程虚拟地址空间
   │
   ├─ 0x7f...0000  libc.so.6      [dlpi_addr = 0x7f...0000]
   │     ├─ PT_LOAD: vaddr=0x00000, memsz=0x1e0000  →  [base, base+1e0000)
   │     └─ PT_LOAD: vaddr=0x1e0000, memsz=0x08000  →  [base+1e0000, ...)
   │
   ├─ 0x7f...0000  libjava.so     [dlpi_addr = ...]
   │     └─ ...
   │
   ├─ 0x7f...0000  libjvm.so      [dlpi_addr = 0x7f...0000]
   │     ├─ PT_LOAD: vaddr=0x00000, memsz=0x...     ← os::jvm_path 地址落在这里
   │     └─ PT_LOAD: vaddr=0x..., memsz=0x...
   │
   └─ ...
```

**策略 2：`dladdr` —— POSIX 标准 API，一行调用搞定**

`dladdr` 是 POSIX 定义的标准函数，语义更简单：给定一个地址，直接返回这个地址所属共享库的信息。它填入一个 `Dl_info` 结构体：

```c
typedef struct {
    const char *dli_fname;  // 共享库文件路径，如 "/usr/lib/jvm/.../lib/server/libjvm.so"
    void       *dli_fbase;  // 共享库加载基址
    const char *dli_sname;  // 最近符号名（可选）
    void       *dli_saddr;  // 最近符号地址（可选）
} Dl_info;
```

**为什么 HotSpot 用两个策略？** 注释里说明了原因（`os_linux.cpp:1811-1815`）：旧版 glibc 的 `dladdr()` 有一个 bug——当 .so 文件被预链接（prelink）导致加载基址不为 NULL 时，`dladdr` 可能返回错误的库名。因此优先用 `dl_iterate_phdr` 手动遍历 ELF header（更精确），`dladdr` 作为后备方案。

**与 Ch01 的衔接：** Ch01 中启动器已经通过 `GetJVMPath`（`%s/lib/%s/%s/libjvm.so` 拼字符串 + `stat()` 验证）找到了这个路径，然后 `dlopen` 加载。但 `JNI_CreateJavaVM` 的入参里没有"我是在哪个路径被加载的"这个字段——所以 VM 启动后必须自己重新发现。启动器用的是"文件系统拼接 + stat 验证"（**编译期已知的目录布局**），VM 用的是"动态链接器反查 + realpath 解析"（**运行时自省**）——二者殊途同归，拿到的是同一个路径。

#### 此时 SystemProperty 链表的完整状态

`init_system_properties` 分两个阶段构建了链表，随后 `init_version_specific_system_properties` 追加了 3 个节点，`os::init_system_properties_values` 把 NULL 填上了真实值。最终链表共 **13 个节点**（尾插法，遍历顺序等于添加顺序）：

```
( 1) java.vm.specification.name       = "Java Virtual Machine Specification"   w=false i=false
( 2) java.vm.version                  = "11.0.31"                              w=false i=false
( 3) java.vm.name                     = "OpenJDK 64-Bit Server VM"             w=false i=false
( 4) jdk.debug                        = "release"                              w=false i=false
( 5) sun.boot.library.path            = "/usr/lib/jvm/java-11-xxx/lib"         w=true  i=false
( 6) java.library.path                = "/usr/java/packages/lib:/usr/lib64..." w=true  i=false
( 7) java.home                        = "/usr/lib/jvm/java-11-xxx"             w=true  i=false
( 8) java.class.path                  = ""        (占位，等 -Djava.class.path)  w=true  i=false
( 9) jdk.boot.class.path.append       = ""        (占位，等 -Xbootclasspath/a:) w=false i=true
(10) java.vm.info                     = "mixed mode"                           w=true  i=false
(11) java.vm.specification.vendor     = "Oracle Corporation"                   w=false i=false
(12) java.vm.specification.version    = "11"                                   w=false i=false
(13) java.vm.vendor                   = 平台相关字符串                           w=false i=false
```

(1)-(4) 是 `init_system_properties` 第一阶段加入的不可写属性——JVM 规范声明的固定值。(5)-(9) 是第二阶段加入的可写属性，其中 (5)-(7) 在 `os::init_system_properties_values()` 中被本机真实路径填充，(8)-(9) 是空串占位符。(11)-(13) 是 `init_version_specific_system_properties` 拿到版本号后追加的三个属性。`Arguments` 类还维护了五个快捷指针——`_sun_boot_library_path`、`_java_library_path`、`_java_home`、`_java_class_path`、`_jdk_boot_class_path_append`——直接指向链表中对应的节点，后续 `set_dll_dir()` / `set_java_home()` 等操作不需要遍历链表，直接用指针覆盖值。

---

## JDK_Version_init() —— 读取 JDK 版本

第二行调用 `JDK_Version_init()`，位置 `java.cpp:726-728`：

```c
void JDK_Version_init() {
  JDK_Version::initialize();
}
```

`JDK_Version::initialize()` 在 `java.cpp:699-724`：

```c
void JDK_Version::initialize() {
  jdk_version_info info;
  assert(!_current.is_valid(), "Don't initialize twice");

  void *lib_handle = os::native_java_library();
  jdk_version_info_fn_t func = CAST_TO_FN_PTR(jdk_version_info_fn_t,
     os::dll_lookup(lib_handle, "JDK_GetVersionInfo0"));

  assert(func != NULL, "Support for JDK 1.5 or older has been removed after JEP-223");

  (*func)(&info, sizeof(info));

  int major = JDK_VERSION_MAJOR(info.jdk_version);
  int minor = JDK_VERSION_MINOR(info.jdk_version);
  int security = JDK_VERSION_SECURITY(info.jdk_version);
  int build = JDK_VERSION_BUILD(info.jdk_version);

  if (info.pending_list_uses_discovered_field == 0) {
    vm_exit_during_initialization(
      "Incompatible JDK is not using Reference.discovered field for pending list");
  }
  _current = JDK_Version(major, minor, security, info.patch_version, build,
                         info.thread_park_blocker == 1,
                         info.post_vm_init_hook_enabled == 1);
}
```

这段代码解释了一个核心的 OS 概念：`os::native_java_library()` 和 `os::dll_lookup` 是在 `dlopen`/`dlsym` 的语义上工作的。

`os::native_java_library()` 加载 `libjava.so` 并返回其句柄。注意：`libjava.so` **不是** Java 标准库的字节码——Java 类（`String`、`HashMap` 等）的字节码存储在 `modules` jimage 文件中。`libjava.so` 是 java.base 模块中 **native 方法的 C 实现**，由以下源文件编译而成（`CMakeLists.txt` 第 19-23 行）：

```
src/java.base/share/native/libjava/*.c     ← Object.c, Class.c, Runtime.c,
                                              System.c, ClassLoader.c ... (40+ 个)
src/java.base/unix/native/libjava/*.c      ← 平台相关：ProcessEnvironment_md.c,
                                              childproc.c, io_util_md.c ... (10+ 个)
src/java.base/linux/native/libjava/*.c     ← Linux 专有：ProcessHandleImpl_linux.c,
                                              CgroupMetrics.c (2 个)
```

举例：Java 代码中 `Object.getClass()` 是一个 native 方法，它的 C 实现在 `Object.c` 里叫 `Java_java_lang_Object_getClass`——这才是 `libjava.so` 里的函数。HotSpot（`libjvm.so`）需要调用 `libjava.so` 里的这些 JNI 函数，因此通过 `dlopen` 动态加载 `libjava.so`，再用 `dlsym` 查找具体函数。

`os::dll_lookup(lib_handle, "JDK_GetVersionInfo0")` 等价于 `dlsym(handle, "JDK_GetVersionInfo0")`，在 libjava.so 的符号表中查找 `JDK_GetVersionInfo0` 的函数地址。找到后把函数指针转换成 `jdk_version_info_fn_t`，调用它填入 `jdk_version_info` 结构体——这个结构体由 java 层写入，但内容由构建时 `-source 8` 或 `--release 11` 编译参数决定。

`_current` 是 `JDK_Version` 的静态成员，定义在 `java.hpp:65`：

```c
class JDK_Version {
 private:
  static JDK_Version _current;
  uint8_t _major;
  uint8_t _minor;
  uint8_t _security;
  uint8_t _patch;
  uint8_t _build;
  bool _thread_park_blocker;
  bool _post_vm_init_hook_enabled;

  bool is_valid() const {
    return (_major != 0);
  }

 public:
  static JDK_Version current() { return _current; }
  uint8_t major_version() const          { return _major; }
  uint8_t minor_version() const          { return _minor; }
};
```

`_major` 为 0 表示未初始化（构造函数初始化列表 `_major(0)`）。`is_valid()` 检查 `_major != 0`，防止重复初始化。`assert(!_current.is_valid())` 在函数开头保证这一点。

为什么要在这时候初始化版本？注释说得很清楚：`So that JDK version can be used as a discriminator when parsing arguments`。有些 flag 在不同 JDK 版本下的行为不同——比如 `UseBiasedLocking` 在 JDK 15 默认 false、JDK 11 默认 true——解析参数时需要知道当前 JDK 的版本号来决定 flag 的默认值。

---

## Arguments::init_version_specific_system_properties() —— 补齐版本相关属性

拿到版本号后立即补充三个系统属性，`arguments.cpp:423-437`：

```c
void Arguments::init_version_specific_system_properties() {
  enum { bufsz = 16 };
  char buffer[bufsz];
  const char* spec_vendor = "Oracle Corporation";
  uint32_t spec_version = JDK_Version::current().major_version();

  jio_snprintf(buffer, bufsz, UINT32_FORMAT, spec_version);

  PropertyList_add(&_system_properties,
      new SystemProperty("java.vm.specification.vendor",  spec_vendor, false));
  PropertyList_add(&_system_properties,
      new SystemProperty("java.vm.specification.version", buffer, false));
  PropertyList_add(&_system_properties,
      new SystemProperty("java.vm.vendor", VM_Version::vm_vendor(),  false));
}
```

`jio_snprintf` 是 JDK 内部对标准库 `snprintf` 的包装——同一个函数，只是统一的跨平台命名约定。`JDK_Version::current().major_version()` 返回 `_major` 字段——刚刚 `JDK_Version::initialize()` 从 libjava.so 的 `JDK_GetVersionInfo0` 获取的值，本机为 11。

三个新增属性：
- `java.vm.specification.vendor` = `"Oracle Corporation"`
- `java.vm.specification.version` = `"11"`（本机实际值）
- `java.vm.vendor` = `VM_Version::vm_vendor()` 返回的字符串

Java 代码中 `System.getProperty("java.vm.specification.version")` 读取的就是这个链表。`java.vm.specification.version` 是 JVM 规范版本（11），不是 JDK 版本——JDK 版本可以从发行文件读取，规范版本则在此刻固定。

---

## LogConfiguration::initialize() —— 统一日志框架初始状态

先理清 HotSpot 的两套输出系统。

### 两套输出系统

Stage 1 的 `ostream_init()`（3.3.3 节）已经创建了 `defaultStream::instance` 并赋值给 `tty`。这是 HotSpot 的"通用输出"——`tty->print_cr(...)`、`warning(...)`、`fatal(...)`、assert 错误信息、崩溃日志都通过它输出到 stdout/stderr。它的类层次是：

```
outputStream → xmlTextStream → defaultStream   （单例，在 ostream_init 创建）
```

`LogConfiguration` 是另一套系统——Unified Logging Framework（UL，统一日志框架），专门处理 `-Xlog:gc*=info:stdout` 这类结构化日志。它的类层次不同：

```
LogOutput → LogStdoutOutput    （全局对象 StdoutLog，编译期已存在）
          → LogStderrOutput    （全局对象 StderrLog，编译期已存在）
          → LogFileOutput      （-Xlog:...:file=gc.log 时动态创建）
```

**关键区别：** `defaultStream`(tty) 处理"无分类的通用输出"——JVM 要说句话、报个错、打个 warning。UL 处理"带标签的结构化日志"——`-Xlog:gc*=info` 表示只输出 gc 相关的 info 级别日志。两者互不替代：tty 不会去解析 `-Xlog` 的参数，UL 也不会拦截 `tty->print_cr()` 的输出。

### 初始化源码

`LogConfiguration::initialize` 在 `logConfiguration.cpp:103-111`。注意它在 `Arguments::parse()` 之前被调用——因为 parse 阶段要解析 `-Xlog:...` 参数，UL 的输出端必须先建好：

```c
void LogConfiguration::initialize(jlong vm_start_time) {
  LogFileOutput::set_file_name_parameters(vm_start_time);
  LogDecorations::initialize(vm_start_time);
  assert(_outputs == NULL, "Should not initialize _outputs before this function, initialize called twice?");
  _outputs = NEW_C_HEAP_ARRAY(LogOutput*, 2, mtLogging);
  _outputs[0] = &StdoutLog;
  _outputs[1] = &StderrLog;
  _n_outputs = 2;
}
```

逐行解释：

**第 1 行：`LogFileOutput::set_file_name_parameters(vm_start_time)`**

`vm_start_time` 是从 `create_vm_timer.begin_time()` 获得的 JVM 启动时间戳（毫秒级）。这行把一个全局变量填入：当前进程的 PID、启动时间戳。后续用户写 `-Xlog:gc*=info:file=gc-%p-%t.log` 时，`%p` 替换为 PID，`%t` 替换为这个时间戳格式化后的字符串——如 `gc-12345-2024-01-15_10-30-00.log`。

**第 2 行：`LogDecorations::initialize(vm_start_time)`**

UL 的每条日志行都有前缀装饰（decorations），如：
```
[0.123s][info][gc] GC(0) Pause Young (G1 Evacuation Pause) 10M->5M(64M) 3.456ms
```
其中 `[0.123s]` 是运行时间、`[info]` 是日志级别、`[gc]` 是标签。装饰器对象记录了 `vm_start_time` 作为零点——所有日志的时间戳都是"当前时间 − 启动时间"。

**第 3-6 行：创建输出端数组**

`_outputs` 是一个 `LogOutput*` 数组，初始大小 2。`StdoutLog` 和 `StderrLog` 是两个**全局对象**（不是 `new` 出来的，编译期就存在），类型分别是 `LogStdoutOutput` 和 `LogStderrOutput`。它们把"输出"这个操作封装成多态接口——`StdoutLog.write(...)` 写到 stdout，`StderrLog.write(...)` 写到 stderr。

`_n_outputs = 2` 记录当前输出端个数。后续 parse 阶段遇到 `-Xlog:...:file=gc.log` 时，会 `new LogFileOutput(...)` 动态扩展这个数组。

### 和 `ostream_init` 的对比

| | `ostream_init` (Stage 1) | `LogConfiguration::initialize` (Stage 2) |
|---|---|---|
| 创建时机 | Stage 1 第 4 步 | Stage 2 第 4 步 |
| 创建对象 | `defaultStream::instance` (单例) | `_outputs[]` 数组 (`StdoutLog` + `StderrLog`) |
| 用途 | 通用输出：tty->print_cr、warning、fatal | 结构化日志：-Xlog:gc*=info |
| 何时使用 | JVM 任何地方说句话、报错 | 只处理带标签的输出 |
| 输出端 | stdout + stderr（FILE* 直写） | LogOutput 多态数组（可扩展 file 输出） |

一句话：`tty` 是 JVM 的嘴巴——想说什么就直接说。UL 是 JVM 的日志系统——带标签、分级、可重定向。两者并存在 HotSpot 中，UL 不取代 tty，tty 也不依赖 UL。

---

## Arguments::parse() —— 参数解析主流程

`arguments.cpp:3761-3961`，200 行，分 5 个阶段：

```
阶段 (1)  初始化 Flag 管理链表（Range/Constraint/Writeable）
阶段 (2)  读环境变量（JAVA_TOOL_OPTIONS / _JAVA_OPTIONS）+ vm_options 资源
阶段 (3)  展开选项（expand_vm_options_as_needed）
阶段 (4)  parse_vm_init_args —— 按优先级逐层解析每个选项
阶段 (5)  解析后处理（CDS、Validation、产品模式特殊配置等）
```

完整源码：

```c
jint Arguments::parse(const JavaVMInitArgs* initial_cmd_args) {
  assert(verify_special_jvm_flags(), "deprecated and obsolete flag table inconsistent");

  // Initialize ranges, constraints and writeables
  JVMFlagRangeList::init();
  JVMFlagConstraintList::init();
  JVMFlagWriteableList::init();

  // If flag "-XX:Flags=flags-file" is used it will be the first option to be processed.
  const char* hotspotrc = ".hotspotrc";
  bool settings_file_specified = false;
  bool needs_hotspotrc_warning = false;
  ScopedVMInitArgs initial_vm_options_args("");
  ScopedVMInitArgs initial_java_tool_options_args("env_var='JAVA_TOOL_OPTIONS'");
  ScopedVMInitArgs initial_java_options_args("env_var='_JAVA_OPTIONS'");

  // Pointers to current working set of containers
  JavaVMInitArgs* cur_cmd_args;
  JavaVMInitArgs* cur_vm_options_args;
  JavaVMInitArgs* cur_java_options_args;
  JavaVMInitArgs* cur_java_tool_options_args;

  // Containers for modified/expanded options
  ScopedVMInitArgs mod_cmd_args("cmd_line_args");
  ScopedVMInitArgs mod_vm_options_args("vm_options_args");
  ScopedVMInitArgs mod_java_tool_options_args("env_var='JAVA_TOOL_OPTIONS'");
  ScopedVMInitArgs mod_java_options_args("env_var='_JAVA_OPTIONS'");


  jint code =
      parse_java_tool_options_environment_variable(&initial_java_tool_options_args);
  if (code != JNI_OK) {
    return code;
  }

  code = parse_java_options_environment_variable(&initial_java_options_args);
  if (code != JNI_OK) {
    return code;
  }

  // Parse the options in the /java.base/jdk/internal/vm/options resource, if present
  char *vmoptions = ClassLoader::lookup_vm_options();
  if (vmoptions != NULL) {
    code = parse_options_buffer("vm options resource", vmoptions, strlen(vmoptions), &initial_vm_options_args);
    FREE_C_HEAP_ARRAY(char, vmoptions);
    if (code != JNI_OK) {
      return code;
    }
  }

  code = expand_vm_options_as_needed(initial_java_tool_options_args.get(),
                                     &mod_java_tool_options_args,
                                     &cur_java_tool_options_args);
  if (code != JNI_OK) {
    return code;
  }

  code = expand_vm_options_as_needed(initial_cmd_args,
                                     &mod_cmd_args,
                                     &cur_cmd_args);
  if (code != JNI_OK) {
    return code;
  }

  code = expand_vm_options_as_needed(initial_java_options_args.get(),
                                     &mod_java_options_args,
                                     &cur_java_options_args);
  if (code != JNI_OK) {
    return code;
  }

  code = expand_vm_options_as_needed(initial_vm_options_args.get(),
                                     &mod_vm_options_args,
                                     &cur_vm_options_args);
  if (code != JNI_OK) {
    return code;
  }

  const char* flags_file = Arguments::get_jvm_flags_file();
  settings_file_specified = (flags_file != NULL);

  if (IgnoreUnrecognizedVMOptions) {
    cur_cmd_args->ignoreUnrecognized = true;
    cur_java_tool_options_args->ignoreUnrecognized = true;
    cur_java_options_args->ignoreUnrecognized = true;
  }

  // Parse specified settings file
  if (settings_file_specified) {
    if (!process_settings_file(flags_file, true,
                               cur_cmd_args->ignoreUnrecognized)) {
      return JNI_EINVAL;
    }
  } else {
#ifdef ASSERT
    // Parse default .hotspotrc settings file
    if (!process_settings_file(".hotspotrc", false,
                               cur_cmd_args->ignoreUnrecognized)) {
      return JNI_EINVAL;
    }
#else
    struct stat buf;
    if (os::stat(hotspotrc, &buf) == 0) {
      needs_hotspotrc_warning = true;
    }
#endif
  }

  if (PrintVMOptions) {
    print_options(cur_java_tool_options_args);
    print_options(cur_cmd_args);
    print_options(cur_java_options_args);
  }

  // Parse JavaVMInitArgs structure passed in, as well as JAVA_TOOL_OPTIONS and _JAVA_OPTIONS
  jint result = parse_vm_init_args(cur_vm_options_args,
                                   cur_java_tool_options_args,
                                   cur_java_options_args,
                                   cur_cmd_args);

  if (result != JNI_OK) {
    return result;
  }

  // Call get_shared_archive_path() here, after possible SharedArchiveFile option got parsed.
  SharedArchivePath = get_shared_archive_path();
  if (SharedArchivePath == NULL) {
    return JNI_ENOMEM;
  }

  // Set up VerifySharedSpaces
  if (FLAG_IS_DEFAULT(VerifySharedSpaces) && SharedArchiveFile != NULL) {
    VerifySharedSpaces = true;
  }

  // Delay warning until here so that we've had a chance to process
  // the -XX:-PrintWarnings flag
  if (needs_hotspotrc_warning) {
    warning("%s file is present but has been ignored.  "
            "Run with -XX:Flags=%s to load the file.",
            hotspotrc, hotspotrc);
  }

  if (needs_module_property_warning) {
    warning("Ignoring system property options whose names match the '-Djdk.module.*'."
            " names that are reserved for internal use.");
  }

#if defined(_ALLBSD_SOURCE) || defined(AIX)
  UNSUPPORTED_OPTION(UseLargePages);
#endif

#if defined(AIX)
  UNSUPPORTED_OPTION_NULL(AllocateHeapAt);
#endif

  ArgumentsExt::report_unsupported_options();

#ifndef PRODUCT
  if (TraceBytecodesAt != 0) {
    TraceBytecodes = true;
  }
  if (CountCompiledCalls) {
    if (UseCounterDecay) {
      warning("UseCounterDecay disabled because CountCalls is set");
      UseCounterDecay = false;
    }
  }
#endif // PRODUCT

  if (ScavengeRootsInCode == 0) {
    if (!FLAG_IS_DEFAULT(ScavengeRootsInCode)) {
      warning("Forcing ScavengeRootsInCode non-zero");
    }
    ScavengeRootsInCode = 1;
  }

  if (!handle_deprecated_print_gc_flags()) {
    return JNI_EINVAL;
  }

  // Set object alignment values.
  set_object_alignment();

  return JNI_OK;
}
```

### 阶段 (1)：JVMFlagRangeList / JVMFlagConstraintList / JVMFlagWriteableList::init()

`-XX:MaxHeapSize` 的值不能超过 4TB（32 位压缩指针模式下），`-XX:+UseG1GC` 和 `-XX:+UseSerialGC` 互斥——HotSpot 用三个链表来管理这些约束：

- **JVMFlagRangeList** —— 存储每个 flag 的值域范围（最小值/最大值）
- **JVMFlagConstraintList** —— 存储 flag 间约束关系（A 必须配合 B、C 和 D 互斥等）
- **JVMFlagWriteableList** —— 存储 flag 的写入时机标记（哪些 flag 在启动后可以通过 `jcmd VM.set_flag` 动态修改）

`init()` 方法内部什么也不做——它们是声明式的。实际的 flag 注册在编译阶段由 `globals.hpp` 等文件的宏展开完成。每个 flag 定义里嵌入了注册到相应链表的静态代码——链表在 `.cpp` 编译单元初始化阶段就填充好了，init 只标记"可以开始校验"。

### 阶段 (2) 和 (3)：收集 4 路参数源 + 展开 `@file`

参数来源有 4 路：

1. **`JAVA_TOOL_OPTIONS` 环境变量** —— 用户在任何 Java 程序里添加的全局 JVM 参数
2. **`_JAVA_OPTIONS` 环境变量** —— 历史遗留，和 JAVA_TOOL_OPTIONS 功能相同
3. **vm_options 资源** —— 嵌入在 `java.base` 模块内部的 JVM 默认参数（`jdk/internal/vm/options`，JDK 构建时生成）
4. **命令行参数** —— 用户在 `java -Xmx2g MyApp` 中敲的内容

`parse_java_tool_options_environment_variable` 和 `parse_java_options_environment_variable` 各自调用 `parse_options_environment_variable`，后者用 `getenv` 读环境变量、按空格分割成 `JavaVMOption` 数组。

`ClassLoader::lookup_vm_options()` 是一个 `dlsym` 包装——从 libjava.so 中查找一个导出字符数组，内容是构建阶段写入的 JVM 参数字符串。

`expand_vm_options_as_needed` 的作用是展开 `@file` 语法。如果某个参数值是 `@/path/to/flags`，函数会读取该文件内容、将文件中的每行作为独立参数插入到 `JavaVMInitArgs` 中。4 路参数源依次展开。

### 阶段 (4)：parse_vm_init_args —— 按优先级逐层解析

展开后调用 `parse_vm_init_args`（`arguments.cpp:2196-2256`）：

```c
jint Arguments::parse_vm_init_args(const JavaVMInitArgs *vm_options_args,
                                   const JavaVMInitArgs *java_tool_options_args,
                                   const JavaVMInitArgs *java_options_args,
                                   const JavaVMInitArgs *cmd_line_args) {
  bool patch_mod_javabase = false;

  Arguments::_AlwaysCompileLoopMethods = AlwaysCompileLoopMethods;
  Arguments::_UseOnStackReplacement    = UseOnStackReplacement;
  Arguments::_ClipInlining             = ClipInlining;
  Arguments::_BackgroundCompilation    = BackgroundCompilation;
  if (TieredCompilation) {
    Arguments::_Tier3InvokeNotifyFreqLog = Tier3InvokeNotifyFreqLog;
    Arguments::_Tier4InvocationThreshold = Tier4InvocationThreshold;
  }

  set_mode_flags(_mixed);

  // Parse args structure generated from java.base vm options resource
  jint result = parse_each_vm_init_arg(vm_options_args, &patch_mod_javabase, JVMFlag::JIMAGE_RESOURCE);
  if (result != JNI_OK) {
    return result;
  }

  // Parse args structure generated from JAVA_TOOL_OPTIONS environment variable
  result = parse_each_vm_init_arg(java_tool_options_args, &patch_mod_javabase, JVMFlag::ENVIRON_VAR);
  if (result != JNI_OK) {
    return result;
  }

  // Parse args structure generated from the command line flags.
  result = parse_each_vm_init_arg(cmd_line_args, &patch_mod_javabase, JVMFlag::COMMAND_LINE);
  if (result != JNI_OK) {
    return result;
  }

  // Parse args structure generated from the _JAVA_OPTIONS environment variable
  result = parse_each_vm_init_arg(java_options_args, &patch_mod_javabase, JVMFlag::ENVIRON_VAR);
  if (result != JNI_OK) {
    return result;
  }

  os::init_container_support();

  // Do final processing now that all arguments have been parsed
  result = finalize_vm_init_args(patch_mod_javabase);
  if (result != JNI_OK) {
    return result;
  }

  return JNI_OK;
}
```

**解析顺序决定了优先级：`vm_options`（最低）→ `JAVA_TOOL_OPTIONS` → `命令行` → `_JAVA_OPTIONS`（最高）。** 后解析的可以覆盖先解析的，但 flag 的 `CMDLINE` 来源标记不会被 `ENVIRON_VAR` 覆盖——代码里 `FLAG_SET_CMDLINE` 只在命令行调用，环境变量使用不同的标记。

`parse_each_vm_init_arg`（`arguments.cpp:2380`）是每个选项的处理入口，一个巨大的 `if/else if` 链，逐个匹配 `-X`、`-XX:`、`-D`、`--module` 等选项前缀。核心匹配逻辑：

```c
jint Arguments::parse_each_vm_init_arg(const JavaVMInitArgs* args, bool* patch_mod_javabase, JVMFlag::Flags origin) {
  const char* tail;

  for (int index = 0; index < args->nOptions; index++) {
    bool is_absolute_path = false;

    const JavaVMOption* option = args->options + index;

    if (!match_option(option, "-Djava.class.path", &tail) &&
        !match_option(option, "-Dsun.java.command", &tail) &&
        !match_option(option, "-Dsun.java.launcher", &tail)) {
        build_jvm_args(option->optionString);
    }

    // -verbose:[class/module/gc/jni]
    if (match_option(option, "-verbose", &tail)) {
      if (!strcmp(tail, ":class") || !strcmp(tail, "")) {
        LogConfiguration::configure_stdout(LogLevel::Info, true, LOG_TAGS(class, load));
        LogConfiguration::configure_stdout(LogLevel::Info, true, LOG_TAGS(class, unload));
      } else if (!strcmp(tail, ":module")) {
        ...
      }
    // -da / -ea
    } else if (match_option(option, user_assertion_options, &tail, true)) {
      bool enable = option->optionString[1] == 'e';
      ...
    // -Xbootclasspath/a:
    } else if (match_option(option, "-Xbootclasspath/a:", &tail)) {
      Arguments::append_sysclasspath(tail);
    // -Xms
    } else if (match_option(option, "-Xms", &tail)) {
      ...
      set_min_heap_size((size_t)long_initial_heap_size);
    // -Xmx
    } else if (match_option(option, "-Xmx", &tail) || match_option(option, "-XX:MaxHeapSize=", &tail)) {
      ...
    // -Xmn
    } else if (match_option(option, "-Xmn", &tail)) {
      ...
    // --add-modules / --add-reads / --add-exports 等模块选项
    } else if (match_option(option, "--add-modules=", &tail)) {
      ...
    }
    // 最终是 -XX: 或 -D 选项，交给 parse_argument
    ...
  }
}
```

`build_jvm_args` 把每个非排除选项字符串追加到内部 `_java_vm_args` 缓冲区——这个字符串最终会写入 `java.vm.args` PerfData（JVM 性能统计指标）。

最后 `finalize_vm_init_args` 做收尾：检查 `mod_javabase` patch 是否还需处理、设置 CDS 归档相关 flag、校验编译模式 flag 冲突（`-Xint` 和 `-Xcomp` 不能同时启用）。

### 阶段 (5)：解析后处理

`parse` 结束后还有几步收尾：

- `SharedArchivePath = get_shared_archive_path()` —— 如果指定了 `-XX:SharedArchiveFile`，解析出完整路径
- `VerifySharedSpaces` 自动设 true —— 当 SharedArchiveFile 指定但未显式禁用时
- `.hotspotrc` 警告 —— release 构建发现 `.hotspotrc` 文件存在但被忽略时输出警告（debug 构建直接解析）
- 平台不支持选项处理 —— `UseLargePages` 在 BSD/AIX 无效果、`AllocateHeapAt` 在 AIX 不支持
- `handle_deprecated_print_gc_flags()` —— 把 `-XX:+PrintGC` 等旧 flag 转换为统一日志框架的 `-Xlog:gc` 配置
- `set_object_alignment()` —— 把 `ObjectAlignmentInBytes` 设置为 `MinObjAlignmentInBytes` 的倍数

总结：`Arguments::parse` 是 HotSpot 启动流程中最大的单个函数之一——200 行、5 个阶段、4 路参数源、300+ 个可识别 flag。它的角色相当于 C 程序的 `getopt_long` 加上 JVM 专属的语义解释器，把字符串选项映射到内部 flag 变量、日志配置、Agent 列表、模块属性。

---

## os::init_before_ergo() —— 自动推算前的 OS 准备

参数解析完成后，`os::init_before_ergo()` 为自动推算做 OS 级准备，`os.cpp:449-466`：

```c
void os::init_before_ergo() {
  initialize_initial_active_processor_count();
  // We need to initialize large page support here because ergonomics takes some
  // decisions depending on large page support and the calculated large page size.
  large_page_init();

  // We need to adapt the configured number of stack protection pages given
  // in 4K pages to the actual os page size. We must do this before setting
  // up minimal stack sizes etc. in os::init_2().
  JavaThread::set_stack_red_zone_size     (align_up(StackRedPages      * 4 * K, vm_page_size()));
  JavaThread::set_stack_yellow_zone_size  (align_up(StackYellowPages   * 4 * K, vm_page_size()));
  JavaThread::set_stack_reserved_zone_size(align_up(StackReservedPages * 4 * K, vm_page_size()));
  JavaThread::set_stack_shadow_zone_size  (align_up(StackShadowPages   * 4 * K, vm_page_size()));

  // VM version initialization identifies some characteristics of the
  // platform that are used during ergonomic decisions.
  VM_Version::init_before_ergo();
}
```

三步：

1. `initialize_initial_active_processor_count()` —— 检测可用 CPU 核数。如果运行在容器中（Docker `--cpus` 限制），会读 `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` 和 `cpu.cfs_period_us` 计算限制后的核数；否则用 `sysconf(_SC_NPROCESSORS_CONF)`。

2. `large_page_init()` —— 检测大页支持。Linux 通过读 `/proc/meminfo` 中的 `Hugepagesize` 获取大页大小（通常 2MB），`apply_ergo` 后续会据此决定堆的起始地址对齐。

3. 栈守卫区域大小调整 —— `StackRedPages` 等 flag 以 4KB 页为单位定义，但 OS 的实际页大小可能不同（如 ARM 的 64KB）。`align_up(StackRedPages * 4 * K, vm_page_size())` 把值向上对齐到 OS 页大小。`vm_page_size()` 在 Linux x86-64 上返回 4096（`sysconf(_SC_PAGE_SIZE)`），所以计算结果通常保持不变。

`VM_Version::init_before_ergo()` 是 CPU 特定初始化——检测 CPU 特性（SSE、AVX、LZCNT 等），这些特性会影响后续 `apply_ergo` 中 `UseCompressedOops` 等 flag 的默认值。

---

## Arguments::apply_ergo() —— 自动推算

解析完用户的显式参数后，JVM 需要填补缺失的值——"你没说 -Xmx，我根据物理内存帮你算一个好用的"。这就是 `apply_ergo`，`arguments.cpp:3963-4068`：

```c
jint Arguments::apply_ergo() {
  // Set flags based on ergonomics.
  jint result = set_ergonomics_flags();
  if (result != JNI_OK) return result;

  // Set heap size based on available physical memory
  set_heap_size();

  GCConfig::arguments()->initialize();

  set_shared_spaces_flags();

  // Initialize Metaspace flags and alignments
  Metaspace::ergo_initialize();

  // Set compiler flags after GC is selected and GC specific
  // flags (LoopStripMiningIter) are set.
  CompilerConfig::ergo_initialize();

  // Set bytecode rewriting flags
  set_bytecode_flags();

  // Set flags if Aggressive optimization flags (-XX:+AggressiveOpts) enabled
  jint code = set_aggressive_opts_flags();
  if (code != JNI_OK) {
    return code;
  }

  // Turn off biased locking for locking debug mode flags
  if (UseHeavyMonitors
#ifdef COMPILER1
      || !UseFastLocking
#endif
#if INCLUDE_JVMCI
      || !JVMCIUseFastLocking
#endif
    ) {
    if (!FLAG_IS_DEFAULT(UseBiasedLocking) && UseBiasedLocking) {
      warning("Biased Locking is not supported with locking debug flags"
              "; ignoring UseBiasedLocking flag." );
    }
    UseBiasedLocking = false;
  }

#ifdef CC_INTERP
  FLAG_SET_DEFAULT(ProfileInterpreter, false);
  FLAG_SET_DEFAULT(UseBiasedLocking, false);
  LP64_ONLY(FLAG_SET_DEFAULT(UseCompressedOops, false));
  LP64_ONLY(FLAG_SET_DEFAULT(UseCompressedClassPointers, false));
#endif

  if (PrintAssembly && FLAG_IS_DEFAULT(DebugNonSafepoints)) {
    warning("PrintAssembly is enabled; turning on DebugNonSafepoints to gain additional output");
    DebugNonSafepoints = true;
  }

  if (FLAG_IS_CMDLINE(CompressedClassSpaceSize) && !UseCompressedClassPointers) {
    warning("Setting CompressedClassSpaceSize has no effect when compressed class pointers are not used");
  }

  if (PrintCommandLineFlags) {
    JVMFlag::printSetFlags(tty);
  }

  // Apply CPU specific policy for the BiasedLocking
  if (UseBiasedLocking) {
    if (!VM_Version::use_biased_locking() &&
        !(FLAG_IS_CMDLINE(UseBiasedLocking))) {
      UseBiasedLocking = false;
    }
  }
#ifdef COMPILER2
  if (!UseBiasedLocking || EmitSync != 0) {
    UseOptoBiasInlining = false;
  }
#endif

  return JNI_OK;
}
```

### set_ergonomics_flags()

`arguments.cpp:1696-1714`：

```c
jint Arguments::set_ergonomics_flags() {
  GCConfig::initialize();

  set_conservative_max_heap_alignment();

#ifndef ZERO
#ifdef _LP64
  set_use_compressed_oops();
  set_use_compressed_klass_ptrs();
#endif
#endif

  return JNI_OK;
}
```

`GCConfig::initialize()` 选择 GC——如果用户没指定，默认选 G1（JDK 11 默认 GC）。检查步骤在 `src/hotspot/share/gc/shared/gcConfig.cpp`，含冲突检测（不能同时 -XX:+UseSerialGC 和 -XX:+UseG1GC）。

`set_use_compressed_oops()` 决定是否使用压缩对象指针——64 位 JVM 把对象引用从 8 字节压缩到 4 字节，条件是堆大小不超过 32GB（压缩指针可达 4GB * 8 字节对齐 = 32GB）。`set_use_compressed_klass_ptrs()` 在 CompressedOops 的基础上为类元数据指针启用压缩。

`set_conservative_max_heap_alignment()` 设置堆的最大对齐值——用于后续 allocatable memory 计算。

### set_heap_size() —— 自动计算堆大小

`arguments.cpp:1729-1790`，核心逻辑：

```c
void Arguments::set_heap_size() {
  julong phys_mem =
    FLAG_IS_DEFAULT(MaxRAM) ? MIN2(os::physical_memory(), (julong)MaxRAM)
                            : (julong)MaxRAM;

  if (FLAG_IS_DEFAULT(MaxRAMPercentage) &&
      !FLAG_IS_DEFAULT(MaxRAMFraction))
    MaxRAMPercentage = 100.0 / MaxRAMFraction;

  if (FLAG_IS_DEFAULT(MaxHeapSize)) {
    julong reasonable_max = (julong)((phys_mem * MaxRAMPercentage) / 100);
    const julong reasonable_min = (julong)((phys_mem * MinRAMPercentage) / 100);
    if (reasonable_min < MaxHeapSize) {
      reasonable_max = reasonable_min;
    } else {
      reasonable_max = MAX2(reasonable_max, (julong)MaxHeapSize);
    }

    if (!FLAG_IS_DEFAULT(ErgoHeapSizeLimit) && ErgoHeapSizeLimit != 0) {
      reasonable_max = MIN2(reasonable_max, (julong)ErgoHeapSizeLimit);
    }
    if (UseCompressedOops) {
      julong max_coop_heap = (julong)max_heap_for_compressed_oops();
      ...
      reasonable_max = MIN2(reasonable_max, max_coop_heap);
    }
    reasonable_max = limit_by_allocatable_memory(reasonable_max);

    FLAG_SET_ERGO(size_t, MaxHeapSize, (size_t)reasonable_max);
  }
```

`phys_mem` 取值：如果 `-XX:MaxRAM` 是默认值，取物理内存；否则取用户指定的值。物理内存通过 `os::physical_memory()` 读取 `/proc/meminfo` 的 `MemTotal` 字段（Linux），经过容器限制校正。

如果没有显式指定 `-Xmx`，堆大小按 `MaxRAMPercentage`（默认 25%）乘以物理内存计算。例如物理内存 64GB，`MaxHeapSize ≈ 64 × 25% = 16GB`。如果启用压缩指针，还受限于压缩指针可达的最大堆（通常是 32GB）。

`MinRAMPercentage` 用于小内存设备——当计算出来的堆小于 `MaxHeapSize` 默认值（大约 96MB）时，用 `MinRAMPercentage` 重新计算。

### 剩余的 ergo 步骤

- **GCConfig::arguments()->initialize()** —— GC 特定参数初始化（G1 的 `G1HeapRegionSize` 默认值等）
- **Metaspace::ergo_initialize()** —— 元空间初始/最大大小自动推算
- **CompilerConfig::ergo_initialize()** —— 编译器线程数自动推算（基于 CPU 核数）
- **set_bytecode_flags()** —— `RewriteBytecodes`、`RewriteFrequentPairs` 的默认值
- **set_aggressive_opts_flags()** —— `-XX:+AggressiveOpts` 打开时启用额外优化
- **BiaedLocking 冲突处理** —— 调试模式（`UseHeavyMonitors`、`!UseFastLocking`）下自动关闭偏向锁
- **CPU 特定策略** —— 某些 CPU（ARM 低端芯片等）默认关闭偏向锁

总结：`apply_ergo` 把用户在命令行指定的 10 个参数扩展成运行所需的 200+ 个参数的完整集合。它的输入是用户知道的 flag，输出是 JVM 可以工作的完整配置状态。

---

## JVMFlagRangeList::check_ranges() 和 JVMFlagConstraintList::check_constraints() —— Flag 校验

`apply_ergo` 可能修改 flag 值（例如自动设置 `MaxHeapSize`），所以 range 和 constraint 校验放在 ergo 之后。

### check_ranges

`jvmFlagRangeList.cpp:423-430`：

```c
bool JVMFlagRangeList::check_ranges() {
  bool status = true;
  for (int i=0; i<length(); i++) {
    JVMFlagRange* range = at(i);
    if (range->check(true) != JVMFlag::SUCCESS) status = false;
  }
  return status;
}
```

遍历所有注册的 range 对象，调用 `range->check(true)`。参数 `true` 表示这是最终检索（非中间阶段），会打印错误信息。例如 `MaxHeapSize` 的 range 检查确保值不超过物理地址空间限制。

### check_constraints

`jvmFlagConstraintList.cpp:356-367`：

```c
bool JVMFlagConstraintList::check_constraints(JVMFlagConstraint::ConstraintType type) {
  guarantee(type > _validating_type, "Constraint check is out of order.");
  _validating_type = type;

  bool status = true;
  for (int i=0; i<length(); i++) {
    JVMFlagConstraint* constraint = at(i);
    if (type != constraint->type()) continue;
    if (constraint->apply(true) != JVMFlag::SUCCESS) status = false;
  }
  return status;
}
```

遍历所有注册的约束对象，只检查匹配 `type` 的约束。Stage 2 传的是 `AfterErgo`——表示约束检查发生在 ergo 计算之后（ergo 可能会改变 flag 值，之前的校验结果可能不再有效）。

`_validating_type` 是一个递增的时间标记——防止约束校验顺序错乱。HotSpot 有三轮约束校验：启动时的 `AfterErgo` 和 `AfterMemoryInit`（在 `Universe::genesis` 之后），以及运行时通过 `jcmd` 的 `VM.set_flag` 触发的校验。

约束检查的一个实际例子：`ThreadLocalHandshakesConstraintFunc` 确保 `-XX:+ThreadLocalHandshakes` 只在支持线程本地轮询的平台上生效。如果平台不支持，该约束函数会把 `ThreadLocalHandshakes` 设回 `false` 并输出日志。

---

## JVMFlagWriteableList::mark_startup() 和 PauseAtStartup

### mark_startup

`jvmFlagWriteableList.cpp:197-202`：

```c
void JVMFlagWriteableList::mark_startup(void) {
  for (int i=0; i<length(); i++) {
    JVMFlagWriteable* writeable = at(i);
    writeable->mark_startup();
  }
}
```

遍历所有 writable flag，调用 `mark_startup()` 保存启动时的初始值。`jcmd VM.set_flag` 修改 flag 时，只允许修改标记为 writable 的 flag，且 `mark_startup` 记录的值用于 `jcmd VM.flags -all` 显示"启动时设的值 vs 当前值"。

### PauseAtStartup

`PauseAtStartup` 定义在 `globals.hpp:2551`：

```c
diagnostic(bool, PauseAtStartup, false,
           "When set, VM will wait for external debugger connection on startup")
```

如果用户传递了 `-XX:+PauseAtStartup`，`os::pause()` 会让 JVM 进程在此处暂停——通常是 Linux 下调用 `pause()`（进程等待信号），或 `read(0, &c, 1)`（等待终端输入）。调式工具在 JVM 启动早期连接调试器时使用——此时 VM 结构体已经初始化，但还未进入 Java main 方法。

---

## Stage 2 总结

37 行 thread.cpp 代码触发了 ~3000 行参数解析逻辑。数据流如下：

```
JavaVMInitArgs (从 JavaMain 传入)
    │
    ▼
Arguments::parse()
    │  4 路参数源：vm_options / JAVA_TOOL_OPTIONS / 命令行 / _JAVA_OPTIONS
    │  parse_each_vm_init_arg：逐个匹配 -X / -XX: / -D / --module
    │  finalize_vm_init_args：处理冲突和默认值
    │
    ▼
os::init_before_ergo()                          — CPU 核数 / 大页 / 栈守卫 / CPU 特性
    │
    ▼
Arguments::apply_ergo()                         — GC 选择 / 堆大小 / 元空间 / 编译器线程 / 偏向锁
    │
    ▼
JVMFlagRangeList::check_ranges()                — 值域校验
JVMFlagConstraintList::check_constraints(AfterErgo) — 约束校验
    │
    ▼
JVMFlagWriteableList::mark_startup()            — 标记启动初值
PauseAtStartup 处理                             — 调试等待
    │
    ▼
HOTSPOT_VM_INIT_BEGIN()                         — Stage 3 入口
```

`parse` 之后，参数系统内保存的是 200+ 个已校验的 flag——GC 类型、堆大小、编译模式、日志配置——每个都经过了 4 路参数源优先级、范围校验和跨 flag 约束检查。接下来 `HOTSPOT_VM_INIT_BEGIN` 把这些配置喂给 init_globals，虚拟机的身体才开始搭建。
