# 3.3 Stage 1 — 前置初始化

`Threads::create_vm` 入口在 `thread.cpp`。Stage 1 是进入正式 JVM 初始化之前的准备工作——版本检查、TLS 注册、输出流初始化、参数处理、OS 初始化——每一项都是后续能正常走下去的前提。

Stage 1 的完整代码：

```
jint Threads::create_vm(JavaVMInitArgs* args, bool* canTryAgain) {
  extern void JDK_Version_init();

  // Preinitialize version info.
  VM_Version::early_initialize();

  // Check version
  if (!is_supported_jni_version(args->version)) return JNI_EVERSION;

  // Initialize library-based TLS
  ThreadLocalStorage::init();

  // Initialize the output stream module
  ostream_init();

  // Process java launcher properties.
  Arguments::process_sun_java_launcher_properties(args);

  // Initialize the os module
  os::init();

  MACOS_AARCH64_ONLY(os::current_thread_enable_wx(WXWrite));  // Linux 上空宏，不执行

  // Record VM creation timing statistics
  TraceVmCreationTime create_vm_timer;
  create_vm_timer.start();
```

`VM_Version::early_initialize()` 是 CPU 平台各异的提前初始化——在 x86 上检测 CPU 特性（SSE、AVX 等），在默认基类中为空操作。这里先一笔带过。

下面是 Stage 1 八个步骤的逐个展开。

---

## 3.3.1 JNI 版本检查

```
if (!is_supported_jni_version(args->version)) return JNI_EVERSION;
```

`args` 是从 `JNI_CreateJavaVM` 传进来的 `JavaVMInitArgs*`，其中的 `version` 字段由调用方（launcher）设置。`JNI_EVERSION` 是 JNI 规范定义的错误码 `-3`，表示"JNI version error"。

`is_supported_jni_version` 定义在 `/data/workspace/jdk11u-copy/src/hotspot/share/runtime/thread.cpp`：

```
jboolean Threads::is_supported_jni_version(jint version) {
  if (version == JNI_VERSION_1_2) return JNI_TRUE;
  if (version == JNI_VERSION_1_4) return JNI_TRUE;
  if (version == JNI_VERSION_1_6) return JNI_TRUE;
  if (version == JNI_VERSION_1_8) return JNI_TRUE;
  if (version == JNI_VERSION_9) return JNI_TRUE;
  if (version == JNI_VERSION_10) return JNI_TRUE;
  return JNI_FALSE;
}
```

每个 `JNI_VERSION_*` 是定义在 `/data/workspace/jdk11u-copy/src/java.base/share/native/include/jni.h` 中的整数常量：

```
#define JNI_VERSION_1_2 0x00010002
#define JNI_VERSION_1_4 0x00010004
#define JNI_VERSION_1_6 0x00010006
#define JNI_VERSION_1_8 0x00010008
#define JNI_VERSION_9   0x00090000
#define JNI_VERSION_10  0x000a0000
```

版本号的编码规律：`0x0001` 开头的是 Java 1.x 系列（`0x00010002` 中末两位 `02` 对应 1.2），`0x0009` 对应 Java 9，`0x000a` 对应 Java 10。JNI 版本号与 JDK 主版本号一一对应。

`JNI_VERSION_1_1`（`0x00010001`）不在支持列表中——JDK 11 启动器传的是 `JNI_VERSION_10`，launcher 传入 JNI 1.1 版本号直接返回 `-3` 错误。JDK 1.1 时代早已过去，这个入口只是为了兼容性保留在 JNI 规范中。

函数只有六行 if + 一行兜底 return——白名单式的版本兼容检查。传入不在白名单的版本号，直接返回 `JNI_FALSE`，`create_vm` 得到 false 后立即 `return JNI_EVERSION`，JVM 启动流程终止。

---

## 3.3.2 线程局部存储初始化

```
ThreadLocalStorage::init();
```

HotSpot 的内部线程模型建立在 `Thread` 类层次上（`Thread` → `JavaThread` / `CompilerThread` / `VMThread` 等）。注意区分三个概念：

| 概念 | 是什么 | 关系 |
|------|--------|------|
| OS 线程（pthread） | 操作系统创建和调度的执行单元 | 底层实体 |
| `Thread` / `JavaThread` | HotSpot 的 C++ 类，是 JVM 内部的线程对象模型 | 包装一个 OS 线程，不是 OS 线程本身 |
| `java.lang.Thread` | Java 层的类，`new Thread().start()` 创建 | 在 JVM 内部对应一个 `JavaThread` |

HotSpot 需要一种方式让任意线程——不管是不是 HotSpot 自己创建的——能快速获取其关联的 `Thread*` 指针。这就是 Thread Local Storage（TLS）的作用：每个线程一个槽位，存着该线程对应的 HotSpot `Thread*`。

Linux 通过三个 POSIX 函数实现 TLS：

| 函数 | 作用 |
|------|------|
| `pthread_key_create(key, destructor)` | 创建一个全局 key，所有线程共享这个 key。`destructor` 是析构函数，线程退出时自动调用，传该线程 key 对应的值 |
| `pthread_setspecific(key, value)` | 把 `value`（`void*`）存入当前线程的 key 槽位 |
| `pthread_getspecific(key)` | 取出当前线程的 key 槽位里存的值（`void*`），key 未设值时返回 NULL |

使用模式：全局调用一次 `pthread_key_create` 创建 key，之后每个线程通过同一个 key 存取自己的私有数据——key 是全局的，值是按线程隔离的。

HotSpot 的用法（`threadLocalStorage_posix.cpp`）：

```c
static pthread_key_t _thread_key;

void ThreadLocalStorage::init() {
    int rslt = pthread_key_create(&_thread_key, restore_thread_pointer);
}
```

`_thread_key` 是全局变量，只创建一次。第二个参数 `restore_thread_pointer` 是析构函数。

#### 背景：`pthread_key_create` 的析构函数

`pthread_key_create` 的第二个参数是一个函数指针，称为"析构函数"。它的作用是：当线程退出时，如果该线程在这个 key 上的值非 NULL，glibc 自动调用这个析构函数，把值传进去做清理。每个 key 对应一个析构函数——HotSpot 在这里注册的析构函数就是 `restore_thread_pointer`。

普通的析构函数会真正清理（比如 `free` 掉内存），然后设 NULL。但 `restore_thread_pointer` 不做任何清理——只是把值原样放回去。实现只有一行：

```c
extern "C" void restore_thread_pointer(void* p) {
  ThreadLocalStorage::set_thread((Thread*) p);
}
```

#### 为什么要这样设计

写一个简单的 C 程序来理解。线程退出时，如果析构函数把值设回去，glibc 会反复调它——最多 4 轮：

```c
#include <stdio.h>
#include <pthread.h>

static pthread_key_t key;

void my_destructor(void* val) {
    printf("  destructor called, value = %p\n", val);
    pthread_setspecific(key, val);     // 把值设回去——不清理
}

void* thread(void* arg) {
    pthread_setspecific(key, (void*)0xDEADBEEF);
    return NULL;                       // 线程退出，触发析构
}

int main() {
    pthread_key_create(&key, my_destructor);
    pthread_t t;
    pthread_create(&t, NULL, thread, NULL);
    pthread_join(t, NULL);
    return 0;
}
```

编译运行：`gcc -lpthread test.c && ./a.out`。本机输出：

```
destructor called, value = 0xdeadbeef
destructor called, value = 0xdeadbeef
destructor called, value = 0xdeadbeef
destructor called, value = 0xdeadbeef
```

析构函数被调了 4 次——因为每次设回去，glibc 发现值还在，就再调一次。4 轮后 glibc 强制停止，把值清 NULL。

再写一个双 key 的程序，验证同一轮清理中 key 之间的调用顺序和可见性：

```c
#include <stdio.h>
#include <pthread.h>

static pthread_key_t key1, key2;

void destructor1(void* p) {
    pthread_setspecific(key1, p);                    /* 设回去——模拟 restore_thread_pointer */
}

void destructor2(void* p) {
    printf("  key2 读 key1 = %p\n", pthread_getspecific(key1));  /* 模拟 Thread::current() */
}

void* thread(void* arg) {
    pthread_setspecific(key1, (void*)111);
    pthread_setspecific(key2, (void*)222);
    return NULL;
}

int main() {
    pthread_key_create(&key1, destructor1);
    pthread_key_create(&key2, destructor2);
    /* 创建线程，退出，观察 */
}
```

本机输出：

```
key2 读 key1 = 0x6f        在同一轮清理中，key2 的析构函数
                             成功读到了 key1 的值
```

这说明：glibc 在一轮清理中按 key 创建顺序依次调析构函数——先 key1（HotSpot 的 `_thread_key`），再 key2（第三方库）。key1 的析构函数设回去的值，key2 的析构函数马上就能读到。

#### 实际用途

线程退出时，HotSpot 注册了 `restore_thread_pointer` 作为 `_thread_key` 的析构函数。同一个线程可能还被某个 JNI 第三方库注册了另一个 key，其析构函数里调了 `DetachCurrentThread`。

清理流程是这样的：

1. glibc 第一轮：先调 HotSpot 的 `restore_thread_pointer`——把 `Thread*` 设回 TLS
2. 接着调第三方库的析构函数，其中调 `DetachCurrentThread`
3. `DetachCurrentThread` 内需要 `Thread::current()`——读 TLS，拿到了上一步设回去的值，正常运行
4. `DetachCurrentThread` 最终调 `clear_thread_current()`，把 `Thread*` 永久清空
5. glibc 第二轮：`_thread_key` 的值已是 NULL，不再调 `restore_thread_pointer`——结束

**如果没有** `restore_thread_pointer`：HotSpot 的析构函数真的做了清理，第 1 步值就丢了。第 3 步 `Thread::current()` 返回 NULL，`DetachCurrentThread` 崩溃。

一句话总结：`restore_thread_pointer` 是 HotSpot 注册到 glibc 的保险——线程退出清理期间，如果别的代码还需要 `Thread::current()`，它保证 TLS 里始终有这个值。真正的清理由 `DetachCurrentThread` 调用 `pthread_setspecific(NULL)` 来完成。

```c
Thread* ThreadLocalStorage::thread() {
    return (Thread*) pthread_getspecific(_thread_key);
}

void ThreadLocalStorage::set_thread(Thread* current) {
    pthread_setspecific(_thread_key, current);
}
```

`init()` 只被调用一次（`_thread_key` 全局唯一）。后续任何线程调用 `set_thread(p)` 存入自己的 `Thread*`，其他函数通过 `thread()` 取出——`Thread::current()` 最终就是调这里。

如果你写过 Java，这个模式和 `java.lang.ThreadLocal` 几乎一样：`new ThreadLocal<T>()` 对应 `pthread_key_create`，`set(T value)` 对应 `pthread_setspecific`，`get()` 对应 `pthread_getspecific`。

`pthread_setspecific` 把 `Thread*` 存入当前线程的 TLS 槽位——这个操作会在 Stage 2 创建 `JavaThread` 时发生，届时每个新线程都会把自己的 `JavaThread*` 通过这里注册。

**总结**：`ThreadLocalStorage::init()` 用 `pthread_key_create` 创建了一个全局 TLS key，后续 HotSpot 所有线程都通过这个 key 存取自己的 `Thread*`。这是整个线程模型的基础——没有它，任何代码都无法通过 `Thread::current()` 获取当前线程对象。

---

## 3.3.3 输出流初始化

```
ostream_init();
```

在解释这行代码做什么之前，先搞清楚 HotSpot 是怎么做"输出"的。

### 背景：HotSpot 的 outputStream

标准 C 程序的输出用 `printf`，C++ 用 `std::cout`。HotSpot 不用这两者——它自己实现了一套流抽象层，核心是 `outputStream` 类（`ostream.hpp`）。

`outputStream` 做了什么？它把输出操作（`print`、`print_cr`、`print_raw`）和"输出到哪里"解耦。子类决定写到 stdout、stderr、文件还是内存缓冲区：

```
outputStream（基类）
  ├── stringStream   → 写到内存缓冲区（日志拼接）
  ├── fileStream     → 写到文件（GC 日志、编译日志）
  ├── defaultStream  → 写到 stdout/stderr（默认输出）
  └── bufferedStream → 带缓冲的包装
  ... 共 12 个子类
```

全局变量 `tty`（`outputStream*` 类型）是 HotSpot 代码中最常用的输出入口。在 `ostream_init()` 之前它是 NULL——在那之前任何试图 `tty->print(...)` 的代码都会段错误。

> **为什么叫 `tty`？** Unix 传统——`/dev/tty` 永远指向当前进程的控制终端。`tty = TeleTYpewriter`。HotSpot 用它命名全局输出流变量，表示"往终端输出"。

### HotSpot 的 new 重载：ResourceObj::C_HEAP 和 NMT

C++ 标准的 `new` 调 `malloc` 分配内存。HotSpot 重载了 `new`，加了一个关键参数——分配位置和内存类型：

```c
new(ResourceObj::C_HEAP, mtInternal) defaultStream()
```

标准 C++ `new` 只做两件事：分配内存、调构造函数。HotSpot 扩展为四件事：

| 参数/标签 | 含义 |
|----------|------|
| `ResourceObj::C_HEAP` | 分配位置——在普通 C 堆上分配（即 `malloc`）。其他选项有 `ResourceObj::RESOURCE_AREA`（线程局部资源区）、`ResourceObj::ARENA`（Arena 区域） |
| `mtInternal` | NMT（Native Memory Tracking）标签——`mt` 前缀是 "memory type"。HotSpot 对每块 malloc 的内存打标签，统计各模块内存开销。`mtInternal` = "内部杂项"。其他标签如 `mtThread`（线程）、`mtGC`（GC）、`mtCode`（编译代码） |

NMT 开启后，`jcmd <pid> VM.native_memory summary` 能看到所有标签的内存占用。不开启时这些标签在编译期被优化掉。

这就是 HotSpot 的 memory management 基础——不是随便 `new`，每次分配都要声明"从哪分配"和"算谁的账"。

### 源码

现在看 `ostream_init()` 的完整实现（`ostream.cpp`）：

```c
void ostream_init() {
  if (defaultStream::instance == NULL) {
    defaultStream::instance = new(ResourceObj::C_HEAP, mtInternal) defaultStream();
    tty = defaultStream::instance;

    // We want to ensure that time stamps in GC logs consider time 0
    // the time when the JVM is initialized, not the first time we ask
    // for a time stamp.
    tty->time_stamp().update_to(1);
  }
}
```

三件事：

**1. 创建 defaultStream 对象。** `new(ResourceObj::C_HEAP, mtInternal) defaultStream()`——在 C 堆上分配 `defaultStream`，打 `mtInternal` 标签。`defaultStream` 继承自 `outputStream`。

所谓的"封装 stdout/stderr"体现在它的静态成员定义（`ostream.cpp`）：

```c
defaultStream* defaultStream::instance = NULL;
int    defaultStream::_output_fd     = 1;       // fd=1 即标准输出
int    defaultStream::_error_fd      = 2;       // fd=2 即标准错误
FILE*  defaultStream::_output_stream = stdout;  // C 标准库的 stdout
FILE*  defaultStream::_error_stream  = stderr;  // C 标准库的 stderr
```

`stdout` 和 `stderr` 是 C 标准库的全局 `FILE*` 指针——`printf` 底层就是往 `stdout` 写。`defaultStream` 内部在需要输出时通过 `_output_stream`/`_error_stream` 直接操作这两个 FILE 指针，而不是调 `printf`。这样 HotSpot 可以控制缓冲、刷新时机、日志重定向等细节。构建完成后存到静态成员 `defaultStream::instance`。

**2. 赋值给 tty。** `tty = defaultStream::instance`——全局变量 `tty` 指向这个唯一的 `defaultStream` 实例。从此 HotSpot 代码可以通过 `tty->print_cr("hello")` 输出到终端。

**3. 对齐时间戳零点。** `tty->time_stamp().update_to(1)`——把流的时间戳重设为当前时刻 + 1 毫秒。这样 GC 日志里的时间戳以 JVM 初始化完成那一刻为零点，而不是以第一次写日志的时刻为零点。`update_to(1)` 而不是 `update_to(0)` 是为了避免值为 0 时被误判为"未初始化"。

---

## 3.3.5 OS 层初始化

```
os::init();
```

这是 Stage 1 中最大的步骤。HotSpot 将 OS 相关代码封装在 `os` 命名空间下，`os::init()` 在不同平台有不同的实现。Linux 实现在 `/data/workspace/jdk11u-copy/src/hotspot/os/linux/os_linux.cpp`：

```
void os::init(void) {
  char dummy;   // used to get a guess on initial stack address

  clock_tics_per_sec = sysconf(_SC_CLK_TCK);

  init_random(1234567);

  Linux::set_page_size(sysconf(_SC_PAGESIZE));
  if (Linux::page_size() == -1) {
    fatal("os_linux.cpp: os::init: sysconf failed (%s)",
          os::strerror(errno));
  }
  init_page_sizes((size_t) Linux::page_size());

  Linux::initialize_system_info();

  Linux::initialize_os_info();

#ifdef __GLIBC__
  Linux::_mallinfo = CAST_TO_FN_PTR(Linux::mallinfo_func_t, dlsym(RTLD_DEFAULT, "mallinfo"));
  Linux::_mallinfo2 = CAST_TO_FN_PTR(Linux::mallinfo2_func_t, dlsym(RTLD_DEFAULT, "mallinfo2"));
#endif // __GLIBC__

  os::Linux::CPUPerfTicks pticks;
  bool res = os::Linux::get_tick_information(&pticks, -1);

  if (res && pticks.has_steal_ticks) {
    has_initial_tick_info = true;
    initial_total_ticks = pticks.total;
    initial_steal_ticks = pticks.steal;
  }

  // _main_thread points to the thread that created/loaded the JVM.
  Linux::_main_thread = pthread_self();

  Linux::clock_init();
  initial_time_count = javaTimeNanos();

  // retrieve entry point for pthread_setname_np
  Linux::_pthread_setname_np =
    (int(*)(pthread_t, const char*))dlsym(RTLD_DEFAULT, "pthread_setname_np");

  check_pax();

  os::Posix::init();
}
```

逐段拆解。

### 时钟 ticks 和随机数

```
clock_tics_per_sec = sysconf(_SC_CLK_TCK);
init_random(1234567);
```

`sysconf` 是 POSIX 标准函数，查询系统运行时的配置参数。`sysconf(_SC_CLK_TCK)` 返回每秒的 clock tick 数——标准 Linux 是 100（每秒 100 个 jiffies，每个 tick 10ms）。`SC` 前缀代表 System Config。

`init_random` 的实现（`os.cpp`）：

```c
void os::init_random(unsigned int initval) {
  _rand_seed = initval;
}
```

把全局变量 `_rand_seed` 设为固定值 `1234567`。后续 `os::random()` 用这个种子做线性同余计算——`next = (16807 × seed) % (2^31 - 1)`。固定种子保证每次 JVM 启动的随机序列完全一致，便于调试和复现问题。

### 页大小

```
Linux::set_page_size(sysconf(_SC_PAGESIZE));
if (Linux::page_size() == -1) {
  fatal("os_linux.cpp: os::init: sysconf failed (%s)",
        os::strerror(errno));
}
init_page_sizes((size_t) Linux::page_size());
```

`sysconf(_SC_PAGESIZE)` 获取系统内存页大小——标准 x86 Linux 是 4096 字节（4KB）。如果返回 -1 说明系统调用失败，直接 `fatal` 终止 JVM。

`init_page_sizes` 基于标准页大小初始化 large page（大页）支持——HotSpot 后续分配 heap 和 code cache 时依赖页大小信息来决定内存布局。

### 系统和 OS 信息

```
Linux::initialize_system_info();
Linux::initialize_os_info();
```

`initialize_system_info` 用 `sysconf` 采集 CPU 和内存（`os_linux.cpp`）：

```c
void os::Linux::initialize_system_info() {
  set_processor_count(sysconf(_SC_NPROCESSORS_CONF));   // CPU 核数
  if (processor_count() == 1) {
    // 检查 /proc/{pid} 是否存在——不存在说明运行在 chroot 环境
    pid_t pid = os::Linux::gettid();
    char fname[32];
    jio_snprintf(fname, sizeof(fname), "/proc/%d", pid);
    FILE *fp = fopen(fname, "r");
    if (fp == NULL)  unsafe_chroot_detected = true;
    else             fclose(fp);
  }
  // 物理内存 = 物理页数 × 页大小
  _physical_memory = (julong)sysconf(_SC_PHYS_PAGES) * (julong)sysconf(_SC_PAGESIZE);
}
```

- `set_processor_count(sysconf(_SC_NPROCESSORS_CONF))` — `_SC_NPROCESSORS_CONF` 返回系统配置的 CPU 核数，存到全局变量 `_processor_count`
- `_physical_memory = _SC_PHYS_PAGES × _SC_PAGESIZE` — 物理页数乘以页大小得到总内存字节数，存到 `_physical_memory`

`initialize_os_info` 用 `uname()` 获取内核版本（`os_linux.cpp`）：

```c
void os::Linux::initialize_os_info() {
  struct utsname _uname;
  _os_version = 0x01000000;              // 默认：未知版本
  if (uname(&_uname) != -1) {
    sscanf(_uname.release, "%d.%d.%d", &major, &minor, &fix);
    _os_version = (major << 16) | (minor << 8) | fix;  // 如 5.4.0 → 0x050400
  }
}
```

`uname` 是 POSIX 系统调用，返回内核名称、版本、发行号等信息。这里取 `_uname.release`（内核版本号字符串），用 `sscanf` 解析三段数字，拼成 `0xMMmmff` 格式（M=major, m=minor, f=fix）。

存到哪？CPU 核数在 `_processor_count`，物理内存在 `_physical_memory`，OS 版本在 `_os_version`——三个都是 `os::Linux` 的静态成员变量。后续 `-XshowSettings`、`hs_err` 崩溃日志、JFR 事件都从这里读取。

### glibc malloc 统计

```
Linux::_mallinfo  = CAST_TO_FN_PTR(Linux::mallinfo_func_t, dlsym(RTLD_DEFAULT, "mallinfo"));
Linux::_mallinfo2 = CAST_TO_FN_PTR(Linux::mallinfo2_func_t, dlsym(RTLD_DEFAULT, "mallinfo2"));
```

glibc 的 `malloc` 内部维护了 arena、已分配块数、空闲块数等统计信息。`mallinfo` 是一个 glibc 函数，返回 `struct mallinfo`，包含这些 malloc 内部数据。`mallinfo2` 是 glibc 2.33+ 的版本，把字段从 `int` 升级为 `size_t`（避免 32 位溢出）。

HotSpot 在 `os_linux.hpp` 中定义了自己版本的这两个结构体（避免直接依赖 glibc 头文件）：

```c
struct glibc_mallinfo {                      struct glibc_mallinfo2 {
    int arena;    // 已分配的总空间              size_t arena;
    int ordblks;  // 普通块数量                  size_t ordblks;
    int smblks;   // 快速 bin 块数量             size_t smblks;
    int hblks;    // mmap 块数量                 size_t hblks;
    int hblkhd;   // mmap 总空间                 size_t hblkhd;
    int usmblks;  // 始终为 0                    size_t usmblks;
    int fsmblks;  // 快速 bin 的空闲空间          size_t fsmblks;
    int uordblks; // 已使用的空间                 size_t uordblks;
    int fordblks; // 空闲空间                     size_t fordblks;
    int keepcost; // 堆顶可释放空间               size_t keepcost;
};                                           };

typedef struct glibc_mallinfo (*mallinfo_func_t)(void);
typedef struct glibc_mallinfo2 (*mallinfo2_func_t)(void);
```

用 `dlsym(RTLD_DEFAULT, "mallinfo")` 动态查找函数地址，而不是静态链接——这样 HotSpot 可以在不链接 glibc 特定版本的情况下，在运行时按需调用。`CAST_TO_FN_PTR` 做类型安全的函数指针转换。

找到的函数地址存到 `Linux::_mallinfo` 和 `Linux::_mallinfo2` 两个静态函数指针中。后续 NMT（Native Memory Tracking）和 GC 日志打印 malloc 统计时，通过这两个指针间接调用。

`mallinfo` 返回 `struct mallinfo`（包含 arena、ordblks、uordblks 等字段），`mallinfo2` 是 glibc 2.33+ 的改进版本（返回 `struct mallinfo2`，使用 64 位字段避免溢出）。HotSpot 在 NMT 和 GC 日志中打印 malloc 统计时调用这些函数。

### CPU 性能计数器

```
os::Linux::CPUPerfTicks pticks;
bool res = os::Linux::get_tick_information(&pticks, -1);

if (res && pticks.has_steal_ticks) {
  has_initial_tick_info = true;
  initial_total_ticks = pticks.total;
  initial_steal_ticks = pticks.steal;
}
```

`get_tick_information` 读取 `/proc/stat` 获取系统启动以来的 CPU tick 计数，包括总 ticks 和被虚拟机 steal 的 ticks（虚拟化环境下的 stolen time）。这些初始值保存下来，后续监控代码通过差值计算 JVM 运行期间的 CPU 利用率。

### 主线程和时钟

```
Linux::_main_thread = pthread_self();
Linux::clock_init();
initial_time_count = javaTimeNanos();
```

`pthread_self()` 获取调用 `create_vm` 的线程的 POSIX 线程 ID——这就是 JVM 主线程（不是 Java 的 main 线程，是创建 JVM 的那个 native 线程）。`Linux::_main_thread` 用于后续 JVM attach 机制判断是否为原始主线程。

`Linux::clock_init()` 初始化用于 JFR 和性能监控的高精度计时器。`javaTimeNanos()` 在 Linux 上基于 `clock_gettime(CLOCK_MONOTONIC)`，记录 JVM 启动的时间戳作为时间基准。

### 线程命名函数

```
Linux::_pthread_setname_np =
  (int(*)(pthread_t, const char*))dlsym(RTLD_DEFAULT, "pthread_setname_np");
```

`pthread_setname_np` 是 Linux 特有的 POSIX 扩展（`_np` = non-portable），用于给线程设置名称（在 `top -H` 和 `ps` 中可见）。`dlsym` 动态查找函数地址，存为函数指针，后续 HotSpot 创建 Java 线程时调用它设置线程名——如 "C2 CompilerThread0"、"GC Thread#0" 等。

### PaX 安全检查

```
check_pax();
```

PaX 是 Linux 内核的安全补丁（主要用于 Hardened Gentoo），提供地址空间布局随机化（ASLR）增强和内存页的执行权限控制。`check_pax` 检测当前内核是否启用了 PaX，如果启用了某些限制，HotSpot 需要调整代码生成策略——JIT 编译器生成的代码需要在可执行内存页上运行。

### POSIX 子层初始化

```
os::Posix::init();
Linux 的 OS 层分成两级：`os::Linux`（Linux 特有）和 `os::Posix`（所有 POSIX 系统共享）。`os::Posix::init()` 做三件事。

第一，查找 `clock_gettime` 并验证 `CLOCK_MONOTONIC` 是否可用。

`dlsym` 的第一个参数通常是一个 `dlopen` 返回的句柄——第一章 `dlsym(libjvm_handle, "JNI_CreateJavaVM")` 就是在 `libjvm.so` 里找符号。但这里传入的不是普通句柄，而是一个特殊值。`dlsym` 的 man 手册原文：

> **RTLD_DEFAULT** — Find the first occurrence of the desired symbol using the default shared object search order. The search will include global symbols in the executable and its dependencies, as well as symbols in shared objects that were dynamically loaded with the RTLD_GLOBAL flag.

`RTLD_DEFAULT` 是 `dlsym` 定义的一个 pseudo-handle（伪句柄），不是真正的动态库句柄。它的值在 `dlfcn.h` 中定义为 `(void*)0`，但 `dlsym` 内部识别它后，改为搜索整个进程的全局符号表——包括主程序及其依赖的所有 `.so`。Linux 上 `clock_gettime` 就在 glibc 的符号表里，所以能直接找到。

`NEEDS_LIBRT` 在 Linux 上未定义，直接走 `RTLD_DEFAULT`：

```c
int (*clock_gettime_func)(clockid_t, struct timespec*) =
    (int(*)(clockid_t, struct timespec*))dlsym(RTLD_DEFAULT, "clock_gettime");
if (clock_gettime_func(CLOCK_MONOTONIC, &tp) == 0) {
    _clock_gettime = clock_gettime_func;          // 存到函数指针，后续复用
}
```

> **单调时钟（CLOCK_MONOTONIC）**：Linux 提供多种时钟源。`CLOCK_REALTIME` 跟随系统时间（会被 NTP 和用户手动调整），而 `CLOCK_MONOTONIC` 从某个固定起点开始单调递增，不受系统时间调整影响。`Object.wait(timeout)` 和 `Thread.sleep()` 使用它保证超时精确。

第二，查找 `pthread_condattr_setclock`，设条件变量的时钟源：

```c
int (*condattr_setclock_func)(pthread_condattr_t*, clockid_t) =
    (int (*)(pthread_condattr_t*, clockid_t))dlsym(RTLD_DEFAULT,
                                                     "pthread_condattr_setclock");
if (condattr_setclock_func != NULL) {
    _pthread_condattr_setclock = condattr_setclock_func;
}
```

第三，`pthread_init_common()` 初始化 HotSpot 的全局线程同步属性。

### 背景：pthread 的属性对象

理解这段代码之前，先搞清楚两个关键信息：

**1. 为什么要 `[1]`？**

```c
static pthread_condattr_t _condAttr[1];
static pthread_mutexattr_t _mutexAttr[1];
```

声明成长度为 1 的数组而不是单个变量，是因为 C 语言里数组名自动退化为指针。写成 `_condAttr[1]` 后，传参时 `_condAttr` 就是 `pthread_condattr_t*`（指向第一个元素）。如果写成普通变量 `pthread_condattr_t _condAttr`，每次传参都要写 `&_condAttr`。这是 C 的惯用手法——用单元素数组替代取地址操作。

**2. 属性对象的工作方式**

pthread 创建互斥锁或条件变量时，可以传一个"属性对象"进去。这个对象是一组配置集合——创建时把配置拷贝进去，后续所有用这个属性对象创建的锁/条件变量都继承同样的配置。流程是这样的：

```c
/* 第一步：初始化属性对象（全填默认值） */
pthread_mutexattr_t attr;
pthread_mutexattr_init(&attr);           // 默认值：普通锁、进程私有

/* 第二步：修改配置 */
pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_NORMAL);

/* 第三步：创建互斥锁时传入属性对象——配置被拷贝到锁里 */
pthread_mutex_t lock;
pthread_mutex_init(&lock, &attr);        // lock 现在就是普通锁

/* 之后所有用 attr 创建的锁都一样 */
pthread_mutex_t lock2;
pthread_mutex_init(&lock2, &attr);       // 和 lock 同样的配置
```

HotSpot 的做法就是把属性对象设为全局变量，配一次，后面每次 `pthread_cond_init` / `pthread_mutex_init` 都传进去。`pthread_init_common()` 就是设置全局属性对象的函数：

```c
static void pthread_init_common(void) {
  pthread_condattr_init(_condAttr);   // 填默认值（PTHREAD_PROCESS_PRIVATE、CLOCK_REALTIME）
  pthread_mutexattr_init(_mutexAttr); // 填默认值（PTHREAD_MUTEX_DEFAULT）
  pthread_mutexattr_settype(_mutexAttr, PTHREAD_MUTEX_NORMAL);
}
```

`pthread_condattr_init` 把属性对象重置为系统默认值——条件变量默认使用进程私有、系统时钟。`pthread_mutexattr_init` 同理。`pthread_mutexattr_settype` 把锁类型设为 `PTHREAD_MUTEX_NORMAL`——普通互斥锁，不检测死锁、不递归——和 HotSpot 的 `Mutex` 层语义一致。后续 `pthread_init_common()` 外面还会把条件变量的时钟源从默认的 `CLOCK_REALTIME` 改为 `CLOCK_MONOTONIC`（通过 `_pthread_condattr_setclock(_condAttr, CLOCK_MONOTONIC)`）。

属性对象配好后，尝试把条件变量时钟源设为单调时钟——成功则 `_use_clock_monotonic_condattr = true`，失败降级。

至此 Posix 层初始化完成。五个变量被赋值：`_clock_gettime`、`_pthread_condattr_setclock`（两个函数指针）、`_condAttr`、`_mutexAttr`（两个属性对象）、`_use_clock_monotonic_condattr`（bool）。

**总结**：`os::init()` 完成六个方面的初始化：时钟参数和随机种子、内存页大小、CPU/内存/OS 信息采集、malloc 统计函数绑定、CPU tick 快照、PaX 安全检查，最后委托 `os::Posix::init()` 设置单调时钟和条件变量。经过这一步，HotSpot 具备了在 Linux 上正常运行所需的全部 OS 级信息。

---

## 3.3.6 启动计时器

```
TraceVmCreationTime create_vm_timer;
create_vm_timer.start();
```

`TraceVmCreationTime` 是定义在 `/data/workspace/jdk11u-copy/src/hotspot/share/services/management.hpp` 的一个 RAII 风格的计时器：

```
class TraceVmCreationTime : public StackObj {
private:
  TimeStamp _timer;
  jlong     _begin_time;

public:
  TraceVmCreationTime() {}
  ~TraceVmCreationTime() {}

  void start()
  { _timer.update_to(0); _begin_time = os::javaTimeMillis(); }
};
```

`TraceVmCreationTime` 继承自 `StackObj`，这是 HotSpot 的一个标记类——它不做任何事，只是声明"这个类的对象只能在栈上分配，禁止 `new`"。`create_vm_timer` 在 `create_vm` 的栈上声明，函数结束时自动析构。但析构函数是空的——因为它不用 RAII 的构造-析构配对，而是显式调用 `start()/end()`。

RAII 是 C++ 最常见的资源管理模式：构造函数获取资源，析构函数释放。写一个简单的程序来理解：

```c
#include <stdio.h>

class Timer {
    const char* _name;
public:
    Timer(const char* name) : _name(name) {
        printf("[%s] 构造——开始计时\n", _name);
    }
    ~Timer() {
        printf("[%s] 析构——停止计时\n", _name);
    }
};

void do_work() {
    Timer t("work");       // 栈上声明，构造时自动开始计时
    printf("  工作中...\n");
}                          // 离开作用域，自动析构——停止计时

int main() {
    Timer t("main");       // main 函数开始
    do_work();
    printf("  main 继续...\n");
    return 0;
}                          // main 函数结束，t 自动析构
```

编译运行：

```
[main] 构造——开始计时
[work] 构造——开始计时
  工作中...
[work] 析构——停止计时
  main 继续...
[main] 析构——停止计时
```

`Timer` 对象的生命周期和花括号作用域绑定——进入作用域构造，离开作用域自动析构，不需要手动调 `start/stop`。这就是 RAII：**R**esource **A**cquisition **I**s **I**nitialization（资源获取即初始化）。

HotSpot 里 `create_vm_timer` 的 RAII 不太典型——析构函数是空的，因为它用外部可见的 `start()/end()` 而非构造/析构来计时。但 `StackObj` 继承 + 栈上声明保证了它一定在函数退出时被析构（生命周期安全），哪怕 `create_vm` 中间任何地方 `return` 或抛异常。

`start()` 做了两件事：把 `_timer` 的起点（`_counter`）归零，用 `os::javaTimeMillis()` 记录系统时间戳。

在整个 `create_vm` 390 行执行完毕后，Stage 9 末尾调用 `end()`：

```c
void end()
{ Management::record_vm_startup_time(_begin_time, _timer.milliseconds()); }
```

`_timer.milliseconds()` 返回从 `start()` 到现在经过的毫秒数。`Management::record_vm_startup_time()` 把启动耗时写入 PerfData 共享内存。在本机 HelloWorld 运行中，这个值约 200-300ms（debug build）。

---

## Stage 1 总结

`os::init()` 是 Stage 1 中最大的函数。以下列出了整个 Stage 1 中被赋值的全部变量——它们大部分是静态成员或全局变量，分布在 `os::Linux`、`os::Posix`、`os`、`ThreadLocalStorage` 四个位置：

| 变量 | 类型 | 存储位置 | 来源 |
|------|------|---------|------|
| `_rand_seed` | `unsigned int` | `os` | `init_random(1234567)` |
| `clock_tics_per_sec` | `int` | `os` | `sysconf(_SC_CLK_TCK)` |
| `_page_size` | `int` | `os::Linux` | `sysconf(_SC_PAGESIZE)` |
| `_processor_count` | `int` | `os::Linux` | `sysconf(_SC_NPROCESSORS_CONF)` |
| `_physical_memory` | `julong` | `os::Linux` | `sysconf(_SC_PHYS_PAGES) × _SC_PAGESIZE` |
| `_os_version` | `uint32_t` | `os::Linux` | `uname()` → `sscanf("%d.%d.%d")` |
| `_mallinfo` | 函数指针 | `os::Linux` | `dlsym("mallinfo")` |
| `_mallinfo2` | 函数指针 | `os::Linux` | `dlsym("mallinfo2")` |
| `initial_total_ticks` | `uint64_t` | `os` | `/proc/stat` 总 CPU tick |
| `initial_steal_ticks` | `uint64_t` | `os` | `/proc/stat` steal tick |
| `_main_thread` | `pthread_t` | `os::Linux` | `pthread_self()` |
| `initial_time_count` | `jlong` | `os_linux.cpp` | `javaTimeNanos()` |
| `_pthread_setname_np` | 函数指针 | `os::Linux` | `dlsym("pthread_setname_np")` |
| `_clock_gettime` | 函数指针 | `os::Posix` | `dlsym("clock_gettime")` |
| `_pthread_condattr_setclock` | 函数指针 | `os::Posix` | `dlsym("pthread_condattr_setclock")` |
| `_use_clock_monotonic_condattr` | `bool` | `os::Posix` | `pthread_condattr_setclock()` |
| `_thread_key` | `pthread_key_t` | `ThreadLocalStorage` | `pthread_key_create()` |
| `tty` | `outputStream*` | 全局变量 | `new defaultStream()` |
| `defaultStream::instance` | `defaultStream*` | `defaultStream` | 同上 |
| `_begin_time` | `jlong` | `create_vm_timer` | `os::javaTimeMillis()` |
| `_timer._counter` | `jlong` | `create_vm_timer` | `update_to(0)` → 实际值为 1 |

所有值都存为静态成员或全局变量——Stage 1 不做任何 Java 层面的初始化。它就是纯 C++ 工作，把系统信息和基础函数指针采集齐全，让后续 Stage 随时读取。
