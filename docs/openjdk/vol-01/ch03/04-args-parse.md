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

这行的作用是**预先格式化两个字符串并存为静态成员**——后续所有 `-Xlog:...:file=gc-%p-%t.log` 都从这两个字符串取值做占位符替换。实现位于 `logFileOutput.cpp:54-63`：

```c
// 两个静态字符数组，全局只有一份
char LogFileOutput::_pid_str[21];              // 存储 "12345"   (PID 字符串)
char LogFileOutput::_vm_start_time_str[20];    // 存储 "2024-06-28_12-30-45"

void LogFileOutput::set_file_name_parameters(jlong vm_start_time) {
  // 第一件事：把进程 PID 格式化为字符串，存到 _pid_str
  int res = jio_snprintf(_pid_str, sizeof(_pid_str), "%d",
                         os::current_process_id());
  // → _pid_str = "12345" (本机 PID)

  // 第二件事：把 vm_start_time（毫秒时间戳）转为本地时间+格式化字符串
  struct tm local_time;
  time_t utc_time = vm_start_time / 1000;          // 毫秒→秒
  os::localtime_pd(&utc_time, &local_time);        // UTC→本地时间
  res = (int)strftime(_vm_start_time_str, sizeof(_vm_start_time_str),
                      "%Y-%m-%d_%H-%M-%S",        // 格式化模板
                      &local_time);
  // → _vm_start_time_str = "2024-06-28_12-30-45"
}
```

两个静态成员 `_pid_str` 和 `_vm_start_time_str` 存了格式化后的字符串——**这是 HotSpot 整个进程生命周期中唯一一次计算日志文件名的时间戳**。后续当 `Arguments::parse` 解析到 `-Xlog:gc*=info:file=gc-%p-%t.log` 时，会调用 `new LogFileOutput("file=gc-%p-%t.log")`，其构造函数内部调 `make_file_name`（`logFileOutput.cpp:359`），把文件名里的 `%p` 替换为 `_pid_str`，`%t` 替换为 `_vm_start_time_str`，得到最终文件名：`gc-12345-2024-06-28_12-30-45.log`。如果有日志滚动配置（`filecount=5`），还会产出 `gc-12345-2024-06-28_12-30-45.log.0`、`.log.1` 等。

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

> **★★ 关注点：** 4 路参数源的优先级顺序——理解命令行怎么覆盖环境变量、vm_options 怎么提供默认值。至于 `parse_each_vm_init_arg` 里具体匹配了哪些 flag——本质是 JVM 版 `getopt_long`，700 行 `if/else if` 字符串匹配，不需要逐行阅读。

`arguments.cpp:3761-3961`，200 行，分 5 个阶段：

```
阶段 (1)  Flag 管理链表初始化   → Range/Constraint/Writeable 的 init()
阶段 (2)  收集 4 路参数源       → 环境变量 + vm_options 资源 + 命令行
阶段 (3)  展开 @file 语法        → expand_vm_options_as_needed
阶段 (4)  按优先级逐层解析       → parse_vm_init_args → parse_each_vm_init_arg
阶段 (5)  解析后处理             → CDS、hotspotrc 警告、旧 GC flag 转换、对象对齐
```

**4 路参数源及其优先级：**

1. `vm_options` —— `java.base` 模块内嵌的默认参数（构建时写入，最低优先级）
2. `JAVA_TOOL_OPTIONS` 环境变量
3. 命令行参数 —— 用户 `java -Xmx2g MyApp`
4. `_JAVA_OPTIONS` 环境变量（历史遗留，最高优先级）

环境变量用 `getenv` 读取后按空格分割为 `JavaVMOption` 数组；`vm_options` 通过 `ClassLoader::lookup_vm_options()`——本质是一个 `dlsym` 从 `libjava.so` 读取编译期写入的字符串。`expand_vm_options_as_needed` 对每路参数源展开 `@file` 语法（读取文件内容，每行作为独立参数插入）。

**阶段 (4) 的核心：** `parse_vm_init_args` 按优先级从低到高依次调用 `parse_each_vm_init_arg`，后解析的覆盖先解析的。`parse_each_vm_init_arg`（`arguments.cpp:2380`，700+ 行）就是一个巨大的 `if/else if` 链，按 `-verbose` → `-da/-ea` → `-Xbootclasspath/a:` → `-Xms` → `-Xmx` → `-Xmn` → `--add-modules` → ... 的顺序逐个 `match_option` 匹配字符串前缀，匹配到就调用对应的 setter——本质是 JVM 版的 `getopt_long`。

**阶段 (5) 收尾：** CDS 归档路径解析、`.hotspotrc` 兼容性警告、`-XX:+PrintGC` 等旧 flag 自动转换为 `-Xlog:gc` 的 UL 配置、`ObjectAlignmentInBytes` 对齐修正。

总结：`parse` 的角色就是路由器——把 4 路来源的字符串选项分发到对应的内部 flag 变量上。实际的默认值推断和约束校验不在它身上，在后面的 `apply_ergo` 和 `check_constraints`。



---

## os::init_before_ergo() —— 自动推算前的 OS 准备

参数解析完成后，`os::init_before_ergo()` 为自动推算做 OS 级准备，`os.cpp:449-466`：

```c
void os::init_before_ergo() {
  initialize_initial_active_processor_count();
  large_page_init();
  JavaThread::set_stack_red_zone_size     (align_up(StackRedPages      * 4 * K, vm_page_size()));
  JavaThread::set_stack_yellow_zone_size  (align_up(StackYellowPages   * 4 * K, vm_page_size()));
  JavaThread::set_stack_reserved_zone_size(align_up(StackReservedPages * 4 * K, vm_page_size()));
  JavaThread::set_stack_shadow_zone_size  (align_up(StackShadowPages   * 4 * K, vm_page_size()));
  VM_Version::init_before_ergo();
}
```

这个函数只做变量赋值，不创建任何对象。被赋值的变量总结：

| 函数 | 被赋值的变量 | 类型 | 本机实际值 | 来源 |
|------|-------------|------|-----------|------|
| `initialize_initial_active_processor_count` | `os::_initial_active_processor_count` | `int` | **96** | `sysconf(_SC_NPROCESSORS_CONF)`（不在容器中） 或 `cpu.cfs_quota_us / cpu.cfs_period_us`（Docker 中） |
| `large_page_init` | `os::Linux::_large_page_size` | `size_t` | **2M** | `/proc/meminfo` 的 `Hugepagesize: 2048 kB` |
| | `UseLargePages` | `bool` | true/false | `setup_large_page_type` 根据 hugepage 可用性自动设 |
| `set_stack_red_zone_size` | `JavaThread::_stack_red_zone_size` | `size_t` | **4K** | `StackRedPages(1) × 4K`，本机页大小也是 4K，不变 |
| `set_stack_yellow_zone_size` | `JavaThread::_stack_yellow_zone_size` | `size_t` | **8K** | `StackYellowPages(2) × 4K` |
| `set_stack_reserved_zone_size` | `JavaThread::_stack_reserved_zone_size` | `size_t` | **4K** | `StackReservedPages(1) × 4K` |
| `set_stack_shadow_zone_size` | `JavaThread::_stack_shadow_zone_size` | `size_t` | **80K** | `StackShadowPages(20) × 4K` |
| `VM_Version::init_before_ergo` | `VM_Version::_features` 等 | CPU 特性位 | 平台相关 | CPUID 指令检测 SSE/AVX/LZCNT 等 |

逐项说明：

**`initialize_initial_active_processor_count`** —— `os.cpp:1744`。调用 `active_processor_count()` 获取可用 CPU 核数，存到 `os::_initial_active_processor_count`。本机是物理机（非容器环境），走 `sysconf(_SC_NPROCESSORS_CONF)`，返回 96。如果在 Docker 容器中，会读 `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` 和 `cpu.cfs_period_us` 计算受限核数（如 `quota=200000 / period=100000 = 2` 核）。这个值直接影响后续 `apply_ergo` 中的 `CompilerConfig::ergo_initialize()`——编译器线程数默认值 = `min(cpu_count, 2)`。

**`large_page_init`** —— `os_linux.cpp:4156`。读 `/proc/meminfo` 的 `Hugepagesize` 字段获取大页大小（本机 2048 kB），存到 `_large_page_size`。`setup_large_page_type` 检查系统是否支持 Transparent Huge Pages 或 hugetlbfs，根据结果设 `UseLargePages`、`UseHugeTLBFS`、`UseSHM` 三个 bool。`apply_ergo` 后续会根据 `_large_page_size` 调整堆的起始地址对齐——堆必须对齐到大页边界。

**四个栈守卫区域** —— `thread.hpp:1606-1635`。这是 JVM 检测 `StackOverflowError` 的底层机制。

每个 `JavaThread` 的栈由 `pthread_create` 分配一块完整内存（大小由 `-Xss` 指定，默认 1MB）。HotSpot 拿到这块内存后，调用 `mprotect(PROT_NONE)` 把栈底方向的一部分页标记为不可读写——不是"预留"，是修改已有页的访问权限。当 Java 方法调用层级太深、栈指针触及这些被保护的页时，CPU 触发 `SIGSEGV`，JVM 的信号处理器识别为栈溢出，根据触及的区域执行不同策略。

四个区域从栈底往上（地址从低到高）排列：

<img src="/docs/openjdk/vol-01/ch03/assets/线程栈守卫区域.png" alt="线程栈守卫区域" style="max-width:100%">

四个 `Stack*Pages` 宏（`globals_x86.hpp`）定义了默认 4K 页数：red=1、yellow=2、reserved=1、shadow=20。`align_up` 把这四个值向上对齐到 `vm_page_size()`（本机 x86-64 也是 4096，所以不变），存入 `JavaThread` 的四个静态成员。

**`init_before_ergo` 只是保存大小值，真正的保护动作发生在创建线程时。** `pthread_create` 确实只控制线程栈的总大小——HotSpot 启动 `JavaThread` 时传入 `-Xss` 指定的值（默认 1MB），内核分配这段虚拟地址空间作为线程栈。HotSpot 拿到这块完整内存后，在 `JavaThread` 构造函数末尾调用 `create_stack_guard_pages()`，关键源码在 `thread.cpp:2607-2640`：

```c
void JavaThread::create_stack_guard_pages() {
  address low_addr = stack_end();          // 栈的底部地址（低地址端）
  size_t len = stack_guard_zone_size();    // red + yellow + reserved 三区总大小

  if (os::guard_memory((char *) low_addr, len)) {  // ★ 核心动作
    _stack_guard_state = stack_guard_enabled;
  }
}
```

`os::guard_memory` 最终调的是 Linux 系统调用 `mprotect(addr, len, PROT_NONE)`（`os_linux.cpp:3944-3946`）。**这些页就是 `pthread_create` 分配栈的一部分，不是额外的内存。** `stack_end()` 的计算公式是 `stack_base() - stack_size()`，其中 `stack_size()` 是在 `record_stack_base_and_size()` 中从 OS 拿到的实际栈大小——和 `pthread_create` 分配的大小一致（默认约 1MB）。`create_stack_guard_pages` 从栈的底端取 `red + yellow + reserved`（16K）字节，调 `mprotect` 把它们的页表访问权限改为 `PROT_NONE`。剩余的约 1008K 正常使用。CPU 尝试访问被保护的页时触发 SIGSEGV，JVM 信号处理器识别为栈溢出，根据触及的区域采取不同策略。

另外注意，HotSpot 在 `os::create_thread` 中**显式禁用了 glibc 的默认 guard page**——`pthread_attr_setguardsize(&attr, 0)`（`os_linux.cpp:3503-3508`），因为 glibc 只支持一个 guard page，而 HotSpot 需要四层守卫。

**为什么需要 `align_up`？** `mprotect` 以页为单位保护内存。如果 OS 页大小是 64KB（如 ARM64 某些配置），而 `StackRedPages` 只指定了 1 页 × 4KB = 4KB，保护范围就会不完整。对齐到 OS 实际页大小保证每个区域都是完整的页倍数。

**`VM_Version::init_before_ergo`** —— CPU 特定的平台特性检测。x86 上通过 CPUID 指令检测 SSE、SSE2、AVX、AVX2、LZCNT 等指令集，存为 `VM_Version` 的静态标志位。`apply_ergo` 中 `UseCompressedOops` 等 flag 的默认值依赖于这些 CPU 特性。例如不支持 64 位的平台不会启用压缩指针。

---

## Arguments::apply_ergo() —— 自动推算

> **★★★ 核心关注：** ergo 自动补全了哪些关键 flag，以及补全的依据（物理内存 → 堆大小、CPU 核数 → 编译器线程数）。不需要逐行阅读源码。

解析完用户的显式参数后，JVM 填补缺失的值。用户只指定了几个 flag（`-Xmx2g`、`-XX:+UseG1GC` 等），而 JVM 运行需要 200+ 个 flag 有明确值——`apply_ergo` 负责根据物理环境自动推算。

`arguments.cpp:3963-4068`，主要赋值路径：

```
set_ergonomics_flags()
  ├── GCConfig::initialize()      → UseG1GC / UseSerialGC 等（默认 G1）
  ├── set_use_compressed_oops()   → UseCompressedOops（堆 < 32GB 且 64 位平台）
  ├── set_use_compressed_klass_ptrs() → UseCompressedClassPointers
  └── set_conservative_max_heap_alignment()

set_heap_size()
  ├── phys_mem = os::physical_memory() → 本机 ~500GB（/proc/meminfo MemTotal）
  ├── MaxHeapSize = phys_mem × MaxRAMPercentage(25%) ≈ 16GB（如果未显式指定）
  └── 如果启用压缩指针：限制 ≤ 32GB

GCConfig::arguments()->initialize()    → G1HeapRegionSize 等 GC 特定参数
Metaspace::ergo_initialize()           → MetaspaceSize / MaxMetaspaceSize
CompilerConfig::ergo_initialize()      → CICompilerCount（基于 CPU 核数，默认 min(cpus, 2)）
set_bytecode_flags()                  → RewriteBytecodes / RewriteFrequentPairs
set_aggressive_opts_flags()           → -XX:+AggressiveOpts 的附加优化
UseBiasedLocking 冲突处理              → 调试模式下自动关闭偏向锁
UseOptoBiasInlining                   → 和 UseBiasedLocking 联动
```

**核心推算规则：**

- **堆大小** = `MinRAMPercentage` 或 `MaxRAMPercentage` × 物理内存。本机 500GB 物理内存 → 默认 `MaxHeapSize ≈ 500 × 25% = 125GB`，但压缩指针上限 32GB 会截断这个值。实际本机若显式传 `-Xmx2g`，则不触发自动推算。

- **编译器线程数** = `min(CPU 核数, 2)`。本机 96 核 → 默认 2 条 C1 + 2 条 C2 编译线程。`-XX:CICompilerCount=N` 可覆盖。

- **GC 选择**：JDK 11 默认 G1。`GCConfig::initialize()` 检查是否有显式 GC flag 后，设 `UseG1GC = true` 并注册冲突检测（`-XX:+UseSerialGC` 和 `-XX:+UseG1GC` 不可同时开启）。

- **CompressedOops**：64 位平台上，如果堆大小不超过 32GB，自动启用压缩对象指针（8 字节引用 → 4 字节，节省内存）。

区别于 `parse` 的"用户说什么就设什么"，ergo 是"用户没说的，我来帮用户算"。输入是少数用户 flag，输出是 200+ 个完整配置。

---

## JVMFlagRangeList::check_ranges() 和 JVMFlagConstraintList::check_constraints() —— Flag 校验

`apply_ergo` 可能修改 flag 值（如自动设 `MaxHeapSize`），所以校验放在它之后、`mark_startup` 之前。两个检查各自遍历编译期注册的 range/constraint 链表：`check_ranges` 验证每个 flag 的值在其允许范围内（如 `MaxHeapSize` 不能超过物理地址空间），`check_constraints(AfterErgo)` 验证跨 flag 的互斥或依赖关系（如 `UseG1GC` 不能和 `UseSerialGC` 同时为 true）。不通过则 JVM 启动失败。

HotSpot 有三轮约束校验：`AfterErgo`（此刻）、`AfterMemoryInit`（堆初始化后）、以及运行时 `jcmd VM.set_flag` 触发的动态校验。

---

## JVMFlagWriteableList::mark_startup() 和 PauseAtStartup

`mark_startup` 遍历所有标记为 writable 的 flag，保存它们此刻的值——用于 `jcmd VM.flags -all` 显示"启动值 vs 当前值"。`PauseAtStartup` 是一个调试用 flag：如果用户传了 `-XX:+PauseAtStartup`，`os::pause()` 会暂停 JVM 进程等待调试器连接。

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

`parse` + `apply_ergo` 之后，用户指定的几个 flag 被补齐为 200+ 个完整配置，每个都经过了优先级、范围校验和跨 flag 约束检查。这些 flag 的实际存储位置不是某个"配置对象"或 map——而是 **编译期由 `globals.hpp` 等文件中的宏展开生成的全局变量**。以 `UseG1GC` 为例：

```c
// gc_globals.hpp → 展开为 globals_extension.hpp 的宏
MATERIALIZE_PRODUCT_FLAG(bool, UseG1GC, false, ...)
// → 等价于: bool UseG1GC = false;           ← 全局变量，就是这个名字
```

每个 flag 对应一个 `JVMFlag` 结构体（`jvmFlag.hpp:107-112`），其 `_addr` 字段指向那个全局变量的地址。所有 `JVMFlag` 组成一个静态数组 `JVMFlag::flags[]`。当你写 `FLAG_SET_ERGO(uintx, MaxHeapSize, value)` 时，实际是找到 `MaxHeapSize` 的 JVMFlag 条目，往 `*(_addr)` 写入 value，并标记来源为 `ERGONOMIC`。

换句话说：**flag 就是 C++ 全局变量，JVMFlag 只是包装了它的元数据（名字、类型、来源）。** `parse`/`apply_ergo` 做的事情本质上就是 `maxHeapSize = 2G; useG1GC = true; ciCompilerCount = 2;`。接下来 `HOTSPOT_VM_INIT_BEGIN` 进入 Stage 3，这些全局变量被 `init_globals` 读取来搭建虚拟机的身体。
