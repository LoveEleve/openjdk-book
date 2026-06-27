# 3.3 Stage 1 — 前置初始化

`Threads::create_vm` 入口在 `thread.cpp`。Stage 1 是进入正式 JVM 初始化之前的准备工作——版本检查、TLS 注册、输出流初始化、参数处理、OS 初始化——每一项都是后续能正常走下去的前提。

Stage 1 的完整代码：

```c
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

  MACOS_AARCH64_ONLY(os::current_thread_enable_wx(WXWrite));

  // Record VM creation timing statistics
  TraceVmCreationTime create_vm_timer;
  create_vm_timer.start();
```c

`VM_Version::early_initialize()` 是 CPU 平台各异的提前初始化——在 x86 上检测 CPU 特性（SSE、AVX 等），在默认基类中为空操作。这里先一笔带过。

下面是 Stage 1 八个步骤的逐个展开。

---

## 3.3.1 JNI 版本检查

```c
if (!is_supported_jni_version(args->version)) return JNI_EVERSION;
```c

`args` 是从 `JNI_CreateJavaVM` 传进来的 `JavaVMInitArgs*`，其中的 `version` 字段由调用方（launcher）设置。`JNI_EVERSION` 是 JNI 规范定义的错误码 `-3`，表示"JNI version error"。

`is_supported_jni_version` 定义在 `/data/workspace/jdk11u-copy/src/hotspot/share/runtime/thread.cpp`：

```c
jboolean Threads::is_supported_jni_version(jint version) {
  if (version == JNI_VERSION_1_2) return JNI_TRUE;
  if (version == JNI_VERSION_1_4) return JNI_TRUE;
  if (version == JNI_VERSION_1_6) return JNI_TRUE;
  if (version == JNI_VERSION_1_8) return JNI_TRUE;
  if (version == JNI_VERSION_9) return JNI_TRUE;
  if (version == JNI_VERSION_10) return JNI_TRUE;
  return JNI_FALSE;
}
```c

每个 `JNI_VERSION_*` 是定义在 `/data/workspace/jdk11u-copy/src/java.base/share/native/include/jni.h` 中的整数常量：

```c
#define JNI_VERSION_1_2 0x00010002
#define JNI_VERSION_1_4 0x00010004
#define JNI_VERSION_1_6 0x00010006
#define JNI_VERSION_1_8 0x00010008
#define JNI_VERSION_9   0x00090000
#define JNI_VERSION_10  0x000a0000
```c

版本号的编码规律：`0x0001` 开头的是 Java 1.x 系列（`0x00010002` 中末两位 `02` 对应 1.2），`0x0009` 对应 Java 9，`0x000a` 对应 Java 10。JNI 版本号与 JDK 主版本号一一对应。

`JNI_VERSION_1_1`（`0x00010001`）不在支持列表中——JDK 11 启动器传的是 `JNI_VERSION_10`，launcher 传入 JNI 1.1 版本号直接返回 `-3` 错误。JDK 1.1 时代早已过去，这个入口只是为了兼容性保留在 JNI 规范中。

函数只有六行 if + 一行兜底 return——白名单式的版本兼容检查。传入不在白名单的版本号，直接返回 `JNI_FALSE`，`create_vm` 得到 false 后立即 `return JNI_EVERSION`，JVM 启动流程终止。

---

## 3.3.2 线程局部存储初始化

```c
ThreadLocalStorage::init();
```c

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
```c

`_thread_key` 是全局变量，只创建一次。第二个参数 `restore_thread_pointer` 是析构函数。

#### 背景：`pthread_key_create` 的析构函数

`pthread_key_create` 的第二个参数是一个函数指针，称为"析构函数"。它的作用是：当线程退出时，如果该线程在这个 key 上的值非 NULL，glibc 自动调用这个析构函数，把值传进去做清理。每个 key 对应一个析构函数——HotSpot 在这里注册的析构函数就是 `restore_thread_pointer`。

普通的析构函数会真正清理（比如 `free` 掉内存），然后设 NULL。但 `restore_thread_pointer` 不做任何清理——只是把值原样放回去。实现只有一行：

```c
extern "C" void restore_thread_pointer(void* p) {
  ThreadLocalStorage::set_thread((Thread*) p);
}
```c

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
```c

编译运行：`gcc -lpthread test.c && ./a.out`。本机输出：

```c
destructor called, value = 0xdeadbeef
destructor called, value = 0xdeadbeef
destructor called, value = 0xdeadbeef
destructor called, value = 0xdeadbeef
```c

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
```c

本机输出：

```c
key2 读 key1 = 0x6f       在同一轮清理中，key2 的析构函数
成功读到了 key1 的值
```c

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
```c

`init()` 只被调用一次（`_thread_key` 全局唯一）。后续任何线程调用 `set_thread(p)` 存入自己的 `Thread*`，其他函数通过 `thread()` 取出——`Thread::current()` 最终就是调这里。

如果你写过 Java，这个模式和 `java.lang.ThreadLocal` 几乎一样：`new ThreadLocal<T>()` 对应 `pthread_key_create`，`set(T value)` 对应 `pthread_setspecific`，`get()` 对应 `pthread_getspecific`。

`pthread_setspecific` 把 `Thread*` 存入当前线程的 TLS 槽位——这个操作会在 Stage 2 创建 `JavaThread` 时发生，届时每个新线程都会把自己的 `JavaThread*` 通过这里注册。

**总结**：`ThreadLocalStorage::init()` 用 `pthread_key_create` 创建了一个全局 TLS key，后续 HotSpot 所有线程都通过这个 key 存取自己的 `Thread*`。这是整个线程模型的基础——没有它，任何代码都无法通过 `Thread::current()` 获取当前线程对象。

---

## 3.3.3 输出流初始化

```c
ostream_init();
```c

在解释这行代码做什么之前，先搞清楚 HotSpot 是怎么做"输出"的。

### 背景：HotSpot 的 outputStream

标准 C 程序的输出用 `printf`，C++ 用 `std::cout`。HotSpot 不用这两者——它自己实现了一套流抽象层，核心是 `outputStream` 类（`ostream.hpp`）。

`outputStream` 做了什么？它把输出操作（`print`、`print_cr`、`print_raw`）和"输出到哪里"解耦。子类决定写到 stdout、stderr、文件还是内存缓冲区：

```c
outputStream（基类）
  ├── stringStream   → 写到内存缓冲区（日志拼接）
  ├── fileStream     → 写到文件（GC 日志、编译日志）
  ├── defaultStream  → 写到 stdout/stderr（默认输出）
  └── bufferedStream → 带缓冲的包装
  ... 共 12 个子类
```c

全局变量 `tty`（`outputStream*` 类型）是 HotSpot 代码中最常用的输出入口。在 `ostream_init()` 之前它是 NULL——在那之前任何试图 `tty->print(...)` 的代码都会段错误。

> **为什么叫 `tty`？** Unix 传统——`/dev/tty` 永远指向当前进程的控制终端。`tty = TeleTYpewriter`。HotSpot 用它命名全局输出流变量，表示"往终端输出"。

### HotSpot 的 new 重载：ResourceObj::C_HEAP 和 NMT

C++ 标准的 `new` 调 `malloc` 分配内存。HotSpot 重载了 `new`，加了一个关键参数——分配位置和内存类型：

```c
new(ResourceObj::C_HEAP, mtInternal) defaultStream()
```c

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
```c

三件事：

**1. 创建 defaultStream 对象。** `new(ResourceObj::C_HEAP, mtInternal) defaultStream()`——在 C 堆上分配 `defaultStream`，打 `mtInternal` 标签。`defaultStream` 继承自 `outputStream`，封装了往 stdout 和 stderr 写数据的逻辑。构建完成后存到静态成员 `defaultStream::instance`。

**2. 赋值给 tty。** `tty = defaultStream::instance`——全局变量 `tty` 指向这个唯一的 `defaultStream` 实例。从此 HotSpot 代码可以通过 `tty->print_cr("hello")` 输出到终端。

**3. 对齐时间戳零点。** `tty->time_stamp().update_to(1)`——把流的时间戳重设为当前时刻 + 1 毫秒。这样 GC 日志里的时间戳以 JVM 初始化完成那一刻为零点，而不是以第一次写日志的时刻为零点。`update_to(1)` 而不是 `update_to(0)` 是为了避免值为 0 时被误判为"未初始化"。

---

**总结**：`ostream_init()` 创建全局输出流对象 `tty`，并校准时间戳零点。从此 HotSpot 代码可以安全地通过 `tty` 输出日志。没有这步，`tty` 还是 NULL，任何输出操作崩溃。

---

## 3.3.4 Launcher 属性处理

```c
Arguments::process_sun_java_launcher_properties(args);
```c

Java 启动器在调用 `JNI_CreateJavaVM` 时，会通过系统属性传递自己的元信息。这些属性以 `-D` 形式放在 `JavaVMInitArgs` 的 options 数组中，前缀是 `sun.java.launcher`。处理时机很关键——必须早于其他系统属性的初始化，因为后续的属性设置可能依赖 launcher 类型。

定义在 `/data/workspace/jdk11u-copy/src/hotspot/share/runtime/arguments.cpp`：

```c
void Arguments::process_sun_java_launcher_properties(JavaVMInitArgs* args) {
  // See if sun.java.launcher, sun.java.launcher.is_altjvm or
  // sun.java.launcher.pid is defined.
  // Must do this before setting up other system properties,
  // as some of them may depend on launcher type.
  for (int index = 0; index < args->nOptions; index++) {
    const JavaVMOption* option = args->options + index;
    const char* tail;

    if (match_option(option, "-Dsun.java.launcher=", &tail)) {
      process_java_launcher_argument(tail, option->extraInfo);
      continue;
    }
    if (match_option(option, "-Dsun.java.launcher.is_altjvm=", &tail)) {
      if (strcmp(tail, "true") == 0) {
        _sun_java_launcher_is_altjvm = true;
      }
      continue;
    }
    if (match_option(option, "-Dsun.java.launcher.pid=", &tail)) {
      _sun_java_launcher_pid = atoi(tail);
      continue;
    }
  }
}
```c

遍历 `args->nOptions` 个 `JavaVMOption`，用 `match_option` 做前缀匹配。`match_option` 的定义在同文件第 227 行：

```c
static bool match_option(const JavaVMOption *option, const char* name,
                         const char** tail) {
  size_t len = strlen(name);
  if (strncmp(option->optionString, name, len) == 0) {
    *tail = option->optionString + len;
    return true;
  } else {
    return false;
  }
}
```c

`match_option` 用 `strncmp` 做前缀比较，匹配成功则把等号后面的部分（tail）通过指针返回。

处理的三个属性：

- **`-Dsun.java.launcher=<名称>`**：launcher 程序名。`tail` 是 "java" 或 "javac" 等。交给 `process_java_launcher_argument` 处理，该函数在同文件第 2013 行：

```c
void Arguments::process_java_launcher_argument(const char* launcher, void* extra_info) {
  _sun_java_launcher = os::strdup_check_oom(launcher);
}
```c

直接用 `strdup` 保存一份 launcher 名称，存到 `_sun_java_launcher` 成员变量。

- **`-Dsun.java.launcher.is_altjvm=true`**：标记是否使用了 `-altjvm` 参数选择了备选 JVM。`_sun_java_launcher_is_altjvm` 在类定义中默认为 false，只有碰到这个属性才设为 true。

- **`-Dsun.java.launcher.pid=<数字>`**：launcher 进程的 PID。用 `atoi` 转为整数存入 `_sun_java_launcher_pid`。这个 PID 值后续用于 `jcmd` 和管理接口。

`args->options + index` 是指针运算——`options` 是 `JavaVMOption*`，`+ index` 直接偏移到第 index 个选项。

`continue` 确保每个 option 只匹配一个属性，避免重复检查。

**总结**：从 launcher 传入的 JVM options 中提取三个内部属性——launcher 名称、是否 altjvm、launcher PID——存到 `Arguments` 类的静态成员变量中。这些值在后继的系统属性初始化阶段被使用。

---

## 3.3.5 OS 层初始化

```c
os::init();
```c

这是 Stage 1 中最大的步骤。HotSpot 将 OS 相关代码封装在 `os` 命名空间下，`os::init()` 在不同平台有不同的实现。Linux 实现在 `/data/workspace/jdk11u-copy/src/hotspot/os/linux/os_linux.cpp`：

```c
void os::init(void) {
  char dummy;   // used to get a guess on initial stack address

  clock_tics_per_sec = sysconf(_SC_CLK_TCK);

  init_random(1234567);

  Linux::set_page_size(sysconf(_SC_PAGESIZE));
  if (Linux::page_size() == -1) {
    fatal("os_linux.cpp os::init: sysconf failed (%s)",
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
```c

逐段拆解。

### 时钟 ticks 和随机数

```c
clock_tics_per_sec = sysconf(_SC_CLK_TCK);
init_random(1234567);
```c

`sysconf(_SC_CLK_TCK)` 获取系统时钟滴答频率——标准 Linux 是 100（每秒 100 个 jiffies）。`init_random(1234567)` 用固定种子初始化随机数生成器，确保 JVM 内部的随机行为可复现。

### 页大小

```c
Linux::set_page_size(sysconf(_SC_PAGESIZE));
if (Linux::page_size() == -1) {
  fatal("os_linux.cpp os::init: sysconf failed (%s)",
        os::strerror(errno));
}
init_page_sizes((size_t) Linux::page_size());
```c

`sysconf(_SC_PAGESIZE)` 获取系统内存页大小——标准 x86 Linux 是 4096 字节（4KB）。如果返回 -1 说明系统调用失败，直接 `fatal` 终止 JVM。

`init_page_sizes` 基于标准页大小初始化 large page（大页）支持——HotSpot 后续分配 heap 和 code cache 时依赖页大小信息来决定内存布局。

### 系统和 OS 信息

```c
Linux::initialize_system_info();
Linux::initialize_os_info();
```c

`initialize_system_info` 读取 `/proc/cpuinfo` 和 `/proc/meminfo` 获取 CPU 核数、内存大小等。`initialize_os_info` 读取 `/proc/version` 获取内核版本、读取 `/etc/os-release` 获取发行版信息。这些信息后续用于 `-XshowSettings` 输出、`hs_err` 崩溃日志以及 JFR 事件。

### glibc malloc 统计

```c
#ifdef __GLIBC__
  Linux::_mallinfo = CAST_TO_FN_PTR(Linux::mallinfo_func_t, dlsym(RTLD_DEFAULT, "mallinfo"));
  Linux::_mallinfo2 = CAST_TO_FN_PTR(Linux::mallinfo2_func_t, dlsym(RTLD_DEFAULT, "mallinfo2"));
#endif // __GLIBC__
```c

用 `dlsym` 动态查找 glibc 的 `mallinfo` 和 `mallinfo2` 函数指针。`dlsym(RTLD_DEFAULT, "mallinfo")` 在当前进程的全局符号表中查找 `mallinfo` 符号，返回函数地址。`CAST_TO_FN_PTR` 是 HotSpot 的类型安全函数指针转换宏。

`mallinfo` 返回 `struct mallinfo`（包含 arena、ordblks、uordblks 等字段），`mallinfo2` 是 glibc 2.33+ 的改进版本（返回 `struct mallinfo2`，使用 64 位字段避免溢出）。HotSpot 在 NMT 和 GC 日志中打印 malloc 统计时调用这些函数。

### CPU 性能计数器

```c
os::Linux::CPUPerfTicks pticks;
bool res = os::Linux::get_tick_information(&pticks, -1);

if (res && pticks.has_steal_ticks) {
  has_initial_tick_info = true;
  initial_total_ticks = pticks.total;
  initial_steal_ticks = pticks.steal;
}
```c

`get_tick_information` 读取 `/proc/stat` 获取系统启动以来的 CPU tick 计数，包括总 ticks 和被虚拟机 steal 的 ticks（虚拟化环境下的 stolen time）。这些初始值保存下来，后续监控代码通过差值计算 JVM 运行期间的 CPU 利用率。

### 主线程和时钟

```c
Linux::_main_thread = pthread_self();
Linux::clock_init();
initial_time_count = javaTimeNanos();
```c

`pthread_self()` 获取调用 `create_vm` 的线程的 POSIX 线程 ID——这就是 JVM 主线程（不是 Java 的 main 线程，是创建 JVM 的那个 native 线程）。`Linux::_main_thread` 用于后续 JVM attach 机制判断是否为原始主线程。

`Linux::clock_init()` 初始化用于 JFR 和性能监控的高精度计时器。`javaTimeNanos()` 在 Linux 上基于 `clock_gettime(CLOCK_MONOTONIC)`，记录 JVM 启动的时间戳作为时间基准。

### 线程命名函数

```c
Linux::_pthread_setname_np =
  (int(*)(pthread_t, const char*))dlsym(RTLD_DEFAULT, "pthread_setname_np");
```c

`pthread_setname_np` 是 Linux 特有的 POSIX 扩展（`_np` = non-portable），用于给线程设置名称（在 `top -H` 和 `ps` 中可见）。`dlsym` 动态查找函数地址，存为函数指针，后续 HotSpot 创建 Java 线程时调用它设置线程名——如 "C2 CompilerThread0"、"GC Thread#0" 等。

### PaX 安全检查

```c
check_pax();
```c

PaX 是 Linux 内核的安全补丁（主要用于 Hardened Gentoo），提供地址空间布局随机化（ASLR）增强和内存页的执行权限控制。`check_pax` 检测当前内核是否启用了 PaX，如果启用了某些限制，HotSpot 需要调整代码生成策略——JIT 编译器生成的代码需要在可执行内存页上运行。

### POSIX 子层初始化

```c
os::Posix::init();
```c

Linux 的 OS 层分成两级：`os::Linux`（Linux 特有）和 `os::Posix`（所有 POSIX 系统共享）。`os::Posix::init()` 在 `/data/workspace/jdk11u-copy/src/hotspot/os/posix/os_posix.cpp`，核心任务是确认单调时钟可用：

```c
void os::Posix::init(void) {
  // 1. Check for CLOCK_MONOTONIC support.

  void* handle = NULL;

  handle = dlopen("librt.so.1", RTLD_LAZY);
  if (handle == NULL) {
    handle = dlopen("librt.so", RTLD_LAZY);
  }

  if (handle == NULL) {
    handle = RTLD_DEFAULT;
  }

  _clock_gettime = NULL;

  int (*clock_getres_func)(clockid_t, struct timespec*) =
    (int(*)(clockid_t, struct timespec*))dlsym(handle, "clock_getres");
  int (*clock_gettime_func)(clockid_t, struct timespec*) =
    (int(*)(clockid_t, struct timespec*))dlsym(handle, "clock_gettime");
  if (clock_getres_func != NULL && clock_gettime_func != NULL) {
    struct timespec res;
    struct timespec tp;
    if (clock_getres_func(CLOCK_MONOTONIC, &res) == 0 &&
        clock_gettime_func(CLOCK_MONOTONIC, &tp) == 0) {
      _clock_gettime = clock_gettime_func;
    }
  }

  // 2. Check for pthread_condattr_setclock support.

  _pthread_condattr_setclock = NULL;

  int (*condattr_setclock_func)(pthread_condattr_t*, clockid_t) =
    (int (*)(pthread_condattr_t*, clockid_t))dlsym(RTLD_DEFAULT,
                                                   "pthread_condattr_setclock");
  if (condattr_setclock_func != NULL) {
    _pthread_condattr_setclock = condattr_setclock_func;
  }

  pthread_init_common();

  int status;
  if (_pthread_condattr_setclock != NULL && _clock_gettime != NULL) {
    if ((status = _pthread_condattr_setclock(_condAttr, CLOCK_MONOTONIC)) != 0) {
      if (status == EINVAL) {
        _use_clock_monotonic_condattr = false;
        warning("Unable to use monotonic clock with relative timed-waits" \
                " - changes to the time-of-day clock may have adverse affects");
      } else {
        fatal("pthread_condattr_setclock: %s", os::strerror(status));
      }
    } else {
      _use_clock_monotonic_condattr = true;
    }
  }
}
```c

> **单调时钟（CLOCK_MONOTONIC）**：Linux 提供多种时钟源。`CLOCK_REALTIME` 跟随系统时间（会被 NTP 和用户手动调整），而 `CLOCK_MONOTONIC` 从某个固定起点开始单调递增，不受系统时间调整影响。JVM 中的 `Object.wait(timeout)` 和 `Thread.sleep()` 使用条件变量实现超时等待，如果用 `CLOCK_REALTIME`，系统时间被回拨时等待时间会错误延长。用 `CLOCK_MONOTONIC` 可以保证超时精确。

函数分两步：

第一步，在 `librt` 中查找 `clock_gettime` 和 `clock_getres` 函数指针，验证 `CLOCK_MONOTONIC` 是否可用。如果可用，存到 `_clock_gettime` 函数指针中。HotSpot 后续所有高精度计时通过这个函数指针调用，而不是直接调用系统函数——一次 `dlsym`，处处使用。

第二步，查找 `pthread_condattr_setclock`——这个函数允许将条件变量的时钟源设置为 `CLOCK_MONOTONIC`。如果可用，尝试设置 `_condAttr`（全局条件变量属性对象）。设置成功则 `_use_clock_monotonic_condattr = true`，设置失败且 errno 为 `EINVAL` 则降级为 false 并打印 warning。

`pthread_init_common()` 初始化全局条件变量和互斥锁，这些是 HotSpot 线程同步的基础设施。

**总结**：`os::init()` 完成六个方面的初始化：时钟参数和随机种子、内存页大小、CPU/内存/OS 信息采集、malloc 统计函数绑定、CPU tick 快照、PaX 安全检查，最后委托 `os::Posix::init()` 设置单调时钟和条件变量。经过这一步，HotSpot 具备了在 Linux 上正常运行所需的全部 OS 级信息。

---

## 3.3.6 macOS AArch64 — W^X 配置

```c
MACOS_AARCH64_ONLY(os::current_thread_enable_wx(WXWrite));
```c

`MACOS_AARCH64_ONLY(x)` 宏定义在 `/data/workspace/jdk11u-copy/src/hotspot/share/utilities/macros.hpp`：

```c
#define MACOS_AARCH64_ONLY(x) MACOS_ONLY(AARCH64_ONLY(x))
```c

层层展开：在非 macOS 平台上展开为空，在非 AArch64 平台上展开为空。只有 macOS + Apple Silicon（M1/M2/M3）上才展开为 `os::current_thread_enable_wx(WXWrite)`。

macOS on Apple Silicon 默认执行 W^X（Write XOR Execute）安全策略——内存页不能同时拥有写权限和执行权限。JIT 编译器需要写代码到内存再执行，这种模式违反了 W^X 策略。Apple 提供了 `pthread_jit_write_protect_np` API 让线程临时切换权限：需要写代码时打开写权限、写完关掉再执行。`os::current_thread_enable_wx(WXWrite)` 就是启动时先打开写权限，让后续初始化代码能正常写入 code cache。

在 Linux x86_64 上这行代码被宏展开为空，不产生任何指令。

---

## 3.3.7 启动计时器

```c
TraceVmCreationTime create_vm_timer;
create_vm_timer.start();
```c

`TraceVmCreationTime` 是定义在 `/data/workspace/jdk11u-copy/src/hotspot/share/services/management.hpp` 的一个 RAII 风格的计时器：

```c
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
```c

> **RAII（Resource Acquisition Is Initialization）**：C++ 惯用法——对象的生命周期管理资源。构造函数获取资源、析构函数释放。`TraceVmCreationTime` 是栈对象（继承 `StackObj`），在 `create_vm` 函数结束时自动析构，析构函数会调用 `Management::record_vm_startup_time()` 记录 JVM 启动时间。

`start()` 做了两件事：把 `_timer` 的起点设置为当前时间（毫秒精度），用 `os::javaTimeMillis()` 记录挂钟时间戳。后面 `create_vm` 结束时调用 `end()`：

```c
void end()
{ Management::record_vm_startup_time(_begin_time, _timer.milliseconds()); }
```c

`_timer.milliseconds()` 返回从 `start()` 到 `end()` 经过的毫秒数——这就是 JVM 启动耗时。

---

## Stage 1 总结

Stage 1 是整个 `Threads::create_vm` 的序幕。八个步骤完成了进入正式初始化之前的所有前置工作：

| 步骤 | 函数 | 做了什么 |
|------|------|----------|
| 1 | `VM_Version::early_initialize()` | CPU 特性检测（x86 平台） |
| 2 | `is_supported_jni_version()` | 白名单检查 JNI 版本号 |
| 3 | `ThreadLocalStorage::init()` | 创建全局 pthread TLS key |
| 4 | `ostream_init()` | 初始化全局输出流 `tty` |
| 5 | `process_sun_java_launcher_properties()` | 提取 launcher 名称/PID/altjvm 标记 |
| 6 | `os::init()` | OS 级初始化（时钟/页大小/系统信息/malloc 统计/CPU tick/线程名/POSIX 时钟） |
| 7 | `os::current_thread_enable_wx(WXWrite)` | macOS AArch64 上的写权限切换（Linux 展开为空） |
| 8 | `create_vm_timer.start()` | 启动 JVM 启动计时器 |

这些步骤之间没有复杂的数据依赖——它们是为后续 Stage 准备运行环境。版本检查确保调用方兼容，TLS 注册让线程模型可用，输出流让日志能写，OS 初始化让系统信息可查——每一项都不可跳过，但每一项都简单直接。
