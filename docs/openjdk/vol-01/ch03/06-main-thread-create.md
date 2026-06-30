# 3.6 Stage 4：主线程创建

Stage 3 结束时，JVM 的 OS 层基础设施已经全部就绪——信号处理器注册完成、安全点轮询页分配完成、200+ 个 flag 全部锁定。但所有这些基础设施都是"悬浮在空中"的——没有线程来承载它们。从 `Threads::create_vm` 的 9 阶段骨架[^1]来看，下一步的使命很明确：创建 JVM 的第一个 `JavaThread` 对象，把主线程在 JVM 内部完成登记。

[^1]: 骨架见 [3.2 Stage 1-9 全貌](../02-threads-create-vm)

---
## Stage 4 全貌

`Threads::create_vm` 中 Stage 4 的完整源码：

```cpp
/* === src/hotspot/share/runtime/thread.cpp === */

  // Initialize Threads state
  _thread_list = NULL;
  _number_of_threads = 0;
  _number_of_non_daemon_threads = 0;

  // Initialize global data structures and create system classes in heap
  vm_init_globals();

#if INCLUDE_JVMCI
  // ... (编译期跳过)
#endif

  // Attach the main thread to this os thread
  JavaThread* main_thread = new JavaThread();
  main_thread->set_thread_state(_thread_in_vm);
  main_thread->initialize_thread_current();
  main_thread->record_stack_base_and_size();
  main_thread->register_thread_stack_with_NMT();
  main_thread->set_active_handles(JNIHandleBlock::allocate_block());

  if (!main_thread->set_as_starting_thread()) { ... return JNI_ENOMEM; }

  main_thread->create_stack_guard_pages();

  // Initialize Java-Level synchronization subsystem
  ObjectMonitor::Initialize();

  // → 下一阶段: jint status = init_globals();
```

10 个步骤的重要度分三层（`INCLUDE_JVMCI` 编译期跳过，不计入）：

| 步骤 | 重要度 | 操作 | 一句话 |
|------|--------|------|--------|
| 1 | ★ | Threads 状态零值初始化 | 三个静态成员变量清零——线程管理体系的起点 |
| 2 | ★★ | `vm_init_globals()` | 全局基础设施初始化（ch04 详讲） |
| 3 | ★★★ | `new JavaThread()` | 构造第一个 JavaThread——116 个字段初始化 |
| 4 | ★★ | `initialize_thread_current()` | TLS 绑定——衔接 Stage 1 的 `pthread_key_create` |
| 5 | ★★ | `record_stack_base_and_size()` | 记录主线程栈边界——`_stack_base` 和 `_stack_size` |
| 6 | ★ | `set_active_handles()` | 分配 JNI 局部引用句柄块 |
| 7 | ★ | `set_as_starting_thread()` | 将 OS 主线程附着到 JVM 的 JavaThread 对象 |
| 8 | ★★★ | `create_stack_guard_pages()` | **核心**：`mprotect(PROT_NONE)` 在栈底画守卫区 |
| 9 | ★★ | `ObjectMonitor::Initialize()` | PerfData 性能计数器注册（非锁初始化） |

---
## 1. Threads 状态零值初始化 ★

```cpp
_thread_list = NULL;
_number_of_threads = 0;
_number_of_non_daemon_threads = 0;
```

这三个是 `Threads` 类的静态成员。`Threads` 类继承 `AllStatic`——一个空基类，标记这个类的所有成员都是静态的，不存在实例。三个字段的 C++ 声明（`thread.hpp`）：

```cpp
class Threads: AllStatic {
  static JavaThread* _thread_list;           // JavaThread 链表头指针
  static int         _number_of_threads;     // 活跃线程总数
  static int         _number_of_non_daemon_threads; // 非守护线程数
};
```

`_thread_list` 是 `JavaThread` 链表的头指针——JVM 用 `JavaThread::_next` 字段把所有的 `JavaThread` 对象串成单链表。`_number_of_threads` 记录当前有多少个线程在 JVM 里跑（包括守护线程），`_number_of_non_daemon_threads` 只计数非守护线程——当这个计数降到 0，JVM 知道没有非守护线程在跑了，触发退出。

此刻全部归零——这是整个 JVM 线程管理体系启动前的零状态。

---
## 2. vm_init_globals() ★★

`vm_init_globals()` 初始化 JVM 全局基础设施，但它的内容属于 ch04 的范围。这里只展示骨架了解整体结构：

```
vm_init_globals()
├── check_ThreadShadow()        ★ 验证 Thread/ThreadShadow 内存布局
├── basic_types_init()          ★ 注册 JVM 基本类型常量
├── eventlog_init()             ★ 初始化 EventLog（崩溃报告用）
├── mutex_init()                ★★ 建立全局锁全序关系（rank）
├── chunkpool_init()            ★ Arena 块池初始化
├── perfMemory_init()           ★★ jstat PerfData 共享内存区创建
└── SuspendibleThreadSet_init() ★ 可挂起线程集合初始化
```

> `vm_init_globals()` 只是 VM 线程侧的前置基础设施。同文件下方的 `init_globals()` 才是 ch04 的核心——它依次初始化 management、bytecodes、classLoader、codeCache、VM_Version、universe、interpreter 等 20+ 个子系统。`vm_init_globals` 和 `init_globals` 是两个不同的函数，不要混淆。

---
## 3. new JavaThread() —— 构造第一个 JavaThread ★★★

Stage 4 的核心操作——用 `new` 在 C-Heap 上分配第一个 `JavaThread` 对象。`JavaThread` 继承自 `Thread`，构造函数调用链是：

```
new JavaThread()
  → Thread::Thread()              // 基类构造：栈/内存/系统监控/ParkEvent
  → JavaThread::initialize()      // 派生类初始化：执行引擎/栈守卫/异常/统计
  → pd_initialize()               // 平台相关初始化（Linux 上为空）
```

构造函数体本身只有一行：

```cpp
JavaThread::JavaThread() : Thread() {
  initialize();
}
```

`Thread()` 构造函数不接收参数——所有字段在构造体内由 `os::random()`、`ParkEvent::Allocate()` 等函数初始化。下面按功能分组展示核心字段——不是 116 个全列，而是按功能分 6 组。

### 3.1 栈信息（暂为空）

```cpp
_stack_base = NULL;
_stack_size = 0;
```

此刻线程的栈还没有捕获——等第 5 步 `record_stack_base_and_size()` 才从 `os::current_stack_base()` 和 `os::current_stack_size()` 读真实值。

### 3.2 内存管理

四个分配器对象——全部用 `new` 在 C-Heap 上分配，GC 不管理它们：

```cpp
ResourceArea*   _resource_area;    // new(mtThread) ResourceArea——临时内存池
HandleArea*     _handle_area;      // new(mtThread) HandleArea——GC 句柄区
GrowableArray<Metadata*>* _metadata_handles; // new——元数据句柄表
JNIHandleBlock* _active_handles;   // JNI 局部引用链表头
JNIHandleBlock* _free_handle_block; // 空闲句柄块链
int             _visited_for_critical_count; // 嵌套 JNI critical 调用计数器
```

`_resource_area` 是 Arena 风格的临时内存池——在线程生命周期内可以快速分配小块内存并在一次操作后全部回收。`_handle_area` 是 GC 句柄区——JVM 内部代码在操作 Java 对象时通过 Handle 包装，防止 GC 期间对象被移动。`_active_handles` 在本 Stage 第 6 步才赋值。

### 3.3 线程安全

```cpp
Threads::ThreadsList* _threads_hazard_ptr;  // 线程列表的 hazard pointer（无锁安全读取）
ThreadsList*          _threads_list_ptr;     // 指向当前有效的线程列表快照
int  _hazard_ptr_count;                      // 递归引用计数
uint _rcu_counter;                           // RCU 风格计数器
```

这三个是实现线程列表无锁遍历的基础——其他线程（如 GC 的 VMThread）可以在不拿锁的情况下安全遍历活跃线程列表。`_threads_hazard_ptr` 在遍历前保存当前列表指针，配合 `_rcu_counter` 防止遍历期间列表被回收。

### 3.4 系统监控

```cpp
Monitor* _SR_lock;          // suspend/resume 的 Monitor（不是 synchronized 那个 ObjectMonitor）
volatile uint32_t _suspend_flags;  // 挂起标志（0=正常运行，非0=需要挂起）
```

`_SR_lock` 是 HotSpot 的 `Monitor`（第 3.5 节详细讲解的四层锁机制的第 3 层），用于线程的 suspend/resume 操作。它和第 3.5 节第 1.1 步注册的 `SR_signum` 信号配合工作：

* `SR_signum`（信号 12）是**通知机制**——VMThread 用 `pthread_kill(target_id, SR_signum)` 通知目标线程"你要停下了"
* `_SR_lock` 是**同步机制**——线程进入 `SR_handler` 后通过这个 Monitor 和 VMThread 协调状态转换

两者功能不同但紧密配合：信号负责打断运行中的线程，Monitor 负责协调挂起/恢复的状态一致性。完整的 Suspend/Resume 流程将在后续 Stop-The-World 章节展开。

### 3.5 ParkEvent 四件套

每个 `Thread` 对象预分配四个 **ParkEvent**——每个 `ParkEvent` 都是第 3.5 节讲解的 `PlatformEvent` 的子类，加了链表能力（`ParkEvent* ListNext` 用于排队）。分配代码（`thread.cpp`）：

```cpp
_ParkEvent   = ParkEvent::Allocate(this);
_SleepEvent  = ParkEvent::Allocate(this);
_MutexEvent  = ParkEvent::Allocate(this);
_MuxEvent    = ParkEvent::Allocate(this);
```

`ParkEvent::Allocate(this)` 调用 `operator new` 在 C-Heap 上分配一个 256 字节对齐的 `ParkEvent` 对象，并把 `AssociatedWith` 设为自己所在的 `Thread`。四个各自的用途：

| ParkEvent | 用途 | 谁在用 |
|-----------|------|--------|
| `_ParkEvent` | `synchronized(obj){}` 等待锁时，park 线程 | `ObjectMonitor::wait()` |
| `_SleepEvent` | `Thread.sleep()` 超时等待 | `JVM_Sleep()` |
| `_MutexEvent` | HotSpot 内部 `Mutex`/`Monitor` 锁竞争时排队 | `Monitor::ILock()` |
| `_MuxEvent` | 低层 mux（内部线程间简单同步） | `Parker` |

256 字节对齐是关键——这正是第 3.5 节 SplitWord 设计能够工作的前提：`ParkEvent` 地址的低 8 位始终是 0，所以 `_LockWord` 可以把锁状态（最低位）和队列指针（高位）合并为一个机器字，单次 CAS 同时修改两者。

每个 `ParkEvent` 构造时调用 `PlatformEvent::park()` 和 `unpark()`，底层是 `pthread_mutex_lock` + `pthread_cond_wait` 的阻塞/唤醒原语。

### 3.6 Hash 种子

```cpp
_hashStateX = os::random();          // 线程本地随机数种子（第一阶段）
_hashStateY = 842502087;             // Marsaglia XorShift 算法的固定常量
_hashStateZ = 0x8767;                // └─ 来自经典论文《Xorshift RNGs》
_hashStateW = 273326509;             // └─ 四元组确保足够的周期和随机性
```

HotSpot 用 Marsaglia 的 XorShift 算法生成线程本地的伪随机数——每个线程有自己的 `_hashStateX/Y/Z/W` 四元组，不需要全局锁。

### 3.7 JavaThread::initialize() 专有字段

`Thread()` 构造完成后，`JavaThread()` 构造函数体调用 `initialize()`：

```cpp
void JavaThread::initialize() {
  if (_safepoint_state != NULL) {   // 子类 ThreadSafepointState 反向引用
    _safepoint_state->set_thread(this);
  }
  set_entry_point(NULL);
  set_jni_functions(jni_functions());
  ...
}
```

按功能分组：

**执行引擎和 JNI：**

```cpp
oop       _threadObj;               // Java 层的 Thread 对象（此刻 NULL，尚未绑定）
address   _entry_point;             // 线程启动后执行的第一个方法入口（NULL）
JNIEnv    _jni_environment;         // JNI 环境块，内含 jni_functions() 函数表
```

`_threadObj` 是 Java 堆中的 `java.lang.Thread` 对象引用——没创建到 Java 堆是因为此刻 `init_globals()` 还没执行，Java 堆还没初始化。`_jni_environment.functions = jni_functions()` 把 JNI 函数表指针写入——后续 native 方法通过这个表调用 JNI 函数。

**Deoptimization（去优化）：**

```cpp
vframeArray* _vframe_array_head;    // Java 帧栈的快照链表头
vframeArray* _vframe_array_last;    // 链表尾
nmethod*     _deopt_nmethod;        // 当前正在去优化的 nmethod（NULL）
intptr_t*    _must_deopt_id;        // 必须去优化的原因 ID（NULL）
```

去优化是 JIT 编译器特有的问题——当编译假设（比如"这个调用点总是调同一个方法"）被打破时，需要把当前编译帧"解构"回解释器帧。`_vframe_array_head/last` 链表保存被解构的帧信息。

**线程生命周期：**

```cpp
bool        _on_thread_list;        // 是否已插入 Threads::_thread_list 链表
ThreadState _thread_state;          // _thread_new → _thread_in_vm → ... 状态机
TerminatedTypes _terminated;        // _not_terminated（未终止） / _thread_exiting / _thread_dead
```

这三个字段记录线程在整个生命周期中处于哪个阶段。构造函数设 `_thread_state = _thread_new`（新建），`_terminated = _not_terminated`（未终止），`_on_thread_list = false`（尚未加入全局链表）。

**栈守卫：**

```cpp
StackGuardState   _stack_guard_state;            // stack_guard_unused → stack_guard_enabled
address           _reserved_stack_activation;     // 保留区激活地址
```

`_stack_guard_state` 控制栈守卫区的状态——初始为 `stack_guard_unused`（未启用）。第 8 步 `create_stack_guard_pages()` 成功后改为 `stack_guard_enabled`。`_reserved_stack_activation` 在第 5 步 `record_stack_base_and_size()` 中初始设为 `stack_base()`。

**异常处理：**

```cpp
oop       _exception_oop;          // 当前待处理的异常对象（NULL）
address   _exception_pc;           // 异常发生时的程序计数器（0）
address   _exception_handler_pc;   // 异常处理器的入口地址（0）
```

当 Java 代码中抛出异常时，JVM 把异常对象写入 `_exception_oop`，记录发生位置和处理器入口，然后跳转到异常处理逻辑。

**JVMTI/JVMC（Java 线程特定的调试和编译器控制）：**

```cpp
JvmtiThreadState* _jvmti_thread_state;     // JVMTI 调试器状态（NULL）
int               _interp_only_mode;        // 0=正常模式，非0=强制解释执行
AsyncStatus       _special_runtime_exit_condition; // _no_async_condition（无异步退出条件）
```

`_interp_only_mode` 是调试器通过 JVMTI 强制线程走解释器的开关——设为非 0 值后，即使方法有 JIT 编译的机器码也会走解释执行，方便调试器单步跟踪。

**统计和同步：**

```cpp
ThreadStatistics*           _thread_stat;     // new ThreadStatistics()——tlab 填充量、退优化计数等
Parker*                     _parker;          // Parker::Allocate(this)——Unsafe.park/unpark
ThreadSafepointState*       _safepoint_state; // ThreadSafepointState::create(this)——线程级安全点
```

`_parker` 是 `Unsafe.park()` / `Unsafe.unpark()` 的底层实现——每个 `JavaThread` 有一个私有的 `Parker` 对象（内部包装了一个 `PlatformEvent`）。

### 3.8 构造函数后状态快照

| 分类 | 分配内容 | 内存位置 |
|------|---------|---------|
| ParkEvent ×4 | `_ParkEvent`、`_SleepEvent`、`_MutexEvent`、`_MuxEvent` | C-Heap（`malloc`，256 字节对齐） |
| 内存管理 | `ResourceArea`、`HandleArea`、`GrowableArray<Metadata*>` | C-Heap |
| 统计/同步 | `ThreadStatistics`、`Parker`、`_SR_lock` Monitor | C-Heap |
| 安全点 | `ThreadSafepointState` | C-Heap |

所有分配都在 C-Heap（进程堆，通过 `malloc`/`new`），不在 Java 堆——此刻 Java 堆还没初始化。

| 字段 | 值 | 含义 |
|------|-----|------|
| `_threadObj` | NULL | Java Thread 对象尚未绑定 |
| `_osthread` | NULL | OS 线程尚未创建 |
| `_next` | NULL | 未插入线程链表 |
| `_thread_state` | `_thread_new` | 新建状态 |
| `_terminated` | `_not_terminated` | 未终止 |
| `_on_thread_list` | false | 未加入全局链表 |
| `_stack_guard_state` | `stack_guard_unused` | 守卫区未启用 |

---
## 4. initialize_thread_current() —— TLS 绑定 ★★

`Thread::initialize_thread_current()` 把当前 JavaThread 对象绑定到当前 OS 线程的 TLS（Thread-Local Storage）槽——这样后续任何代码调用 `Thread::current()` 都能直接拿回本线程的 `JavaThread*` 指针。

```cpp
void Thread::initialize_thread_current() {
#ifndef USE_LIBRARY_BASED_TLS_ONLY
  assert(_thr_current == NULL, "Thread::current already initialized");
  _thr_current = this;
#endif
  assert(ThreadLocalStorage::thread() == NULL, "...");
  ThreadLocalStorage::set_thread(this);
  assert(Thread::current() == ThreadLocalStorage::thread(), "TLS mismatch!");
}
```

HotSpot 维护了两套 TLS 机制——快路径和慢路径。

`_thr_current` 是一个 C++ `thread_local` 变量——编译器为每个线程分配独立的存储空间。`Thread::current()` 在 `#ifndef USE_LIBRARY_BASED_TLS_ONLY` 时直接读 `_thr_current`，速度快但只在能用 `thread_local` 的平台上可用。

`ThreadLocalStorage::set_thread(this)` 走的是 POSIX 标准路径，底层实现（`os_linux.cpp`）：

```cpp
void ThreadLocalStorage::set_thread(Thread* thread) {
  pthread_setspecific(_thread_key, thread);
}
```

`_thread_key` 是 Stage 1 的 `ThreadLocalStorage::init()` 中 `pthread_key_create(&_thread_key, NULL)` 创建的**进程级单例**。`pthread_key_create` 只调用一次——创建一个全局的 key 槽位。`pthread_setspecific` 则可以被每个线程分别调用，同一个 key 值在不同线程中自动路由到各自线程私有的 TLS 槽——内核为每个线程维护独立的 `pthread_key_t → void*` 映射表。

用表格对比两套 TLS 在四个关键时间点的操作：

| 时间点 | 位置 | 操作 |
|--------|------|------|
| key 创建 | Stage 1 `ThreadLocalStorage::init()` | `pthread_key_create(&_thread_key, ...)` |
| 主线程 TLS 写入 | Stage 4（此刻） | `initialize_thread_current()` → `pthread_setspecific(_thread_key, this)` |
| 新子线程 TLS | `thread_native_entry` | 新 pthread 在自己的栈上调用 |
| JNI Attach | `attach_current_thread` | 原生线程首次调 JNI 时 |
| 线程退出 | `Thread::clear_thread_current()` | `pthread_setspecific(_thread_key, NULL)` 清理 |

这套 TLS 绑定是后续所有阶段的基础——信号处理器收到 SIGSEGV 时需要 `Thread::current()` 判断"哪个线程触发了栈溢出"，GC 线程需要`Thread::current()`访问当前线程的安全点状态。没有 TLS 绑定，这些全部无法工作。

---
## 5. record_stack_base_and_size() —— 记录栈边界 ★★

TLS 绑定完成后，立刻捕获当前线程的栈边界：

```cpp
void Thread::record_stack_base_and_size() {
  set_stack_base(os::current_stack_base());
  set_stack_size(os::current_stack_size());
  if (is_Java_thread()) {
    ((JavaThread*) this)->set_stack_overflow_limit();
    ((JavaThread*) this)->set_reserved_stack_activation(stack_base());
  }
}
```

主线程和后续 `pthread_create` 创建的子线程的栈信息来源不同：

| 线程类型 | 栈信息来源 | 函数调用 |
|---------|-----------|---------|
| 主线程(primordial) | Stage 1 `capture_initial_stack()` 预存的静态变量 | `/proc/self/stat` + `/proc/self/maps` 解析 |
| pthread 子线程 | `pthread_getattr_np()` 实时查询 | `pthread_attr_getstack()` |

主线程不能用 `pthread_getattr_np()`——这个函数会返回虚假值（glibc 的实现对主线程只返回 `__libc_stack_end` 附近的一段内存，不准确）。所以 Stage 1 的 `os::init()` 阶段提前通过 `/proc/self/stat` 和 `/proc/self/maps` 解析了栈的真地址，保存为 `os::Linux` 的静态变量。此刻 `os::current_stack_base()` 返回的就是那个预存值。

四个相关字段：

| 字段 | 类型 | 含义 |
|------|------|------|
| `_stack_base` | address | 栈顶（高地址端，x86 栈向下增长） |
| `_stack_size` | size_t | 栈大小（已扣除 pthread 守护页） |
| `stack_end()` | address | `_stack_base - _stack_size`（栈底，低地址端） |

对 `JavaThread` 额外设置两个字段：

`set_stack_overflow_limit()` 计算 `stack_end() + MAX2(stack_guard_zone_size(), stack_shadow_zone_size())`。这个值存在 `_stack_overflow_limit` 字段中，供 JIT 编译器直接在汇编指令里和当前 SP 比较——`if (SP < _stack_overflow_limit) goto throw_StackOverflow`。

`set_reserved_stack_activation(stack_base())` 把 `_reserved_stack_activation` 初始设为栈顶地址——这意味着保留区从栈顶开始，随着栈使用越来越多而逐步下移。

下游消费方简要提及：
* `create_stack_guard_pages()`（第 8 步）——在 `stack_end()` 处设 `PROT_NONE`
* JIT 汇编——每次方法入口比较 SP 和 `_stack_overflow_limit`
* `is_in_stack()`——检查地址是否在线程栈内
* NMT 注册——`register_thread_stack_with_NMT()` 在 Native Memory Tracking 中登记这段栈内存

---
## 6. set_active_handles() —— JNI 局部引用块 ★

```cpp
main_thread->set_active_handles(JNIHandleBlock::allocate_block());
```

`_active_handles` 是每个线程的 JNI 局部引用句柄块链表头。当 Java 调用 native 方法时，JNI 接口创建的 `jobject` 引用存储在 `JNIHandleBlock` 的 `oop` 数组中。`JNIHandleBlock` 结构和对应的 Java 概念：

```
JNIHandleBlock
├── oop  _handles[32];           // 固定 32 个槽位的 oop 数组
├── JNIHandleBlock* _next;       // 下一个块（链表，32 个不够时可扩展）
├── int  _top;                   // 当前已用槽位数（0-32）
├── int  _free_list;             // 空闲槽位链表（复用已释放的 slot）
└── int  _allocate_before_rebuild; // 在该块被回收前还允许分配多少次
```

GC 通过遍历每个线程的 `_active_handles` 链表来标记这些局部引用为 GC 根——确保 native 方法返回前，其创建的 JNI 局部引用不会被 GC 回收。

---
## 7. set_as_starting_thread() —— 主线程附着 ★

```cpp
if (!main_thread->set_as_starting_thread()) { ... return JNI_ENOMEM; }
```

`set_as_starting_thread()` 调用链：

```
JavaThread::set_as_starting_thread()
  → os::create_main_thread((JavaThread*)this)
    → os::create_attached_thread(thread)
```

`os::create_attached_thread` 不调用 `pthread_create`——因为主线程已经存在（它是 `execve` 启动 `java` 进程后运行的第一个线程）。它的工作是：
* 记录主线程的 `pthread_t` 到 `OSThread` 对象
* 分配 `OSThread` 元数据（线程 ID、栈信息、优先级）
* 做栈展开等特殊处理

`set_as_starting_thread` 这个名字容易让人以为有一个对应的 `is_starting_thread()` 方法——并不存在。概念上最接近的是 `os::is_primordial_thread()`，它通过检查当前线程的栈地址是否落在 Stage 1 保存的 `initial_thread_stack_bottom()` 范围内来判断"我是不是原始线程"。

---
## 8. create_stack_guard_pages() —— 栈守卫区 ★★★

这是 Stage 4 最核心的部分。它承接 Stage 2 `init_before_ergo()` 算好的四个守卫区大小，在栈底真正画上 `PROT_NONE` 保护页。Java 线程在方法调用导致栈过深时，碰触这些保护页触发 SIGSEGV——信号处理器根据触发区域决定是抛 `StackOverflowError` 还是直接崩溃。

### 8.1 源码与守卫条件

```cpp
void JavaThread::create_stack_guard_pages() {
  if (!os::uses_stack_guard_pages() ||                          // 平台不支持
      _stack_guard_state != stack_guard_unused ||               // 已设置过
      (DisablePrimordialThreadGuardPages && os::is_primordial_thread())) {
    return;
  }
  address low_addr = stack_end();
  size_t len = stack_guard_zone_size();
  int must_commit = os::must_commit_stack_guard_pages();

  if (must_commit && !os::create_stack_guard_pages((char*)low_addr, len)) {
    ... return;
  }

  if (os::guard_memory((char*)low_addr, len)) {
    _stack_guard_state = stack_guard_enabled;
  } else {
    vm_exit_out_of_memory(..., "memory to guard stack pages");
  }
}
```

三个守卫条件——逐一解释：

`!os::uses_stack_guard_pages()` 检查当前平台是否支持栈守卫页。HotSpot 设计支持多种操作系统，但不是所有 OS 都支持 `mprotect` 实现的栈守卫——比如某些嵌入式系统。在 Linux 上这个函数始终返回 true。

`_stack_guard_state != stack_guard_unused` 防止重复设置。`_stack_guard_state` 初始值为 `stack_guard_unused`。第 3 步构造函数刚设了这个值，所以主线程第一次走到这里是会进入后面逻辑的。一旦 `os::guard_memory` 成功，状态改为 `stack_guard_enabled`——后续任何代码再调 `create_stack_guard_pages()` 会在这个守卫条件被挡掉。

`DisablePrimordialThreadGuardPages && os::is_primordial_thread()` 是一个调试开关（`-XX:+DisablePrimordialThreadGuardPages`）——关闭主线程的栈守卫。某些 JNI 代码的 native 方法会大量用栈，但正常 Java 模式下主线程的栈守卫是必须的。`DisablePrimordialThreadGuardPages` 默认 false。

### 8.2 两步操作

`low_addr = stack_end()` 取第 5 步 `record_stack_base_and_size()` 中算出的栈底地址。`len = stack_guard_zone_size()` 返回 `red + yellow + reserved` 三个区的总长度——Stage 2 已经算好了。

**第一步：commit 内存（条件执行）**

```cpp
if (must_commit && !os::create_stack_guard_pages((char*)low_addr, len)) { ... }
```

`os::must_commit_stack_guard_pages()` 检查是否需要 commit。栈底地址可能因为 lazy allocation 尚未真正分配物理页——只有真正访问页面时内核才为虚拟地址分配实际内存。`os::create_stack_guard_pages` 用 `mmap(MAP_FIXED, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0)` 强制对栈底的虚拟地址段做映射——`MAP_FIXED` 确保映射到已有的栈地址上，`PROT_READ|PROT_WRITE` 确保该地址有实际物理页支撑。

这步不是分配新内存——`MAP_FIXED` 明确表示"对已存在的虚拟地址重新映射"，不会创建新 VMA。只是确保栈底有物理页 backing，避免后续 `mprotect` 失败。

**第二步：设置保护（核心）**

```cpp
if (os::guard_memory((char*)low_addr, len)) {
    _stack_guard_state = stack_guard_enabled;
}
```

`os::guard_memory` 底层是 `mprotect(low_addr, len, PROT_NONE)`——把这段已 commit 的页面的访问权限改为完全不可访问。从此任何代码试图读写 `[stack_end(), stack_end() + len)` 范围内的地址，MMU 立即报告页错误，内核投递 SIGSEGV。

这里必须强调：`mprotect` **不是分配新内存**——是在已有页面上修改权限。栈本身由 `pthread_create`（子线程）或 OS（主线程）在创建线程时分配，`mprotect` 只是把其中一段的权限改成 `PROT_NONE`。这和 Stage 3 第 1.1 节中用 `mprotect(PROT_NONE)` 保护安全点 bad_page 是完全相同的机制——只是保护的对象不同。

### 8.3 守卫区内存布局

四个颜色区的来源是 Stage 2 `init_before_ergo()` 设置的四个 `JavaThread` 静态成员：

| 参数 | 默认页数 | 默认大小 | C++ 变量 |
|------|---------|---------|---------|
| `StackRedPages` | 1 | 4K | `JavaThread::_stack_red_zone_size()` |
| `StackYellowPages` | 2 | 8K | `JavaThread::_stack_yellow_zone_size()` |
| `StackReservedPages` | 1 | 4K | `JavaThread::_stack_reserved_zone_size()` |
| `StackShadowPages` | 20 | 80K | `JavaThread::_stack_shadow_zone_size()` |

四个值是 `JavaThread` 类的静态成员，所有 `JavaThread` 实例共享同一组值。总保护长度 = red + yellow + reserved = 4K + 8K + 4K = 16K——这块 16K 的区域被 `mprotect(PROT_NONE)` 整体保护。

守卫区在栈上的位置（x86 栈从高地址向低地址增长）：

```
高地址
  ▼ 栈增长方向
┌──────────────────────┐ ← stack_base()
│ [Shadow Zone—80K]     │ R/W, banging 探测
├──────────────────────┤
│ [Usable Stack]         │ 正常 Java 帧
├──────────────────────┤ ← _reserved_stack_activation
│ [Reserved Zone—4K]    │ PROT_NONE, @ReservedStackAccess
├──────────────────────┤
│ [Yellow Zone—8K]      │ PROT_NONE → StackOverflowError(可恢复)
├──────────────────────┤ ← stack_red_zone_base()
│ [Red Zone—4K]         │ PROT_NONE → SIGSEGV(不可恢复)
└──────────────────────┘ ← stack_end()
低地址
```

Shadow Zone 不是保护区——它只是用于 `banging` 探测的间隙区。当 Java 方法被调用时，JIT 生成的代码在方法入口处执行 "stack banging"——尝试写入影子区的高地址端。如果写入成功说明还剩足够栈空间，可以安全执行方法。如果写入触发了 SIGSEGV（因为栈已经用到了影子区内部），说明栈快用完了，信号处理器判断为 `StackOverflowError`。

### 8.4 OS 层 PROT_NONE vs Java 层颜色区

在 OS 层面，Red/Yellow/Reserved 三个区域全部是 `PROT_NONE`——MMU 无法区分"这是红区还是黄区"。区别发生在信号处理器中。当线程碰触 `[stack_end(), stack_end() + 16K)` 中的某个地址时，SIGSEGV 触发 `signalHandler` → `JVM_handle_linux_signal`（第 3.5 节第 1.1 步注册）：

```cpp
// 信号处理器中的三层栈检查（第 3.5 节 1.1 步已展示）
if (thread->in_stack_yellow_reserved_zone(addr)) {
  // → StackOverflowError: 先解开 yellow zone 保护,
  //   让异常处理代码有栈空间, 然后抛异常
}
```

信号处理器根据 `si_addr` 落在哪个区间来区分：
* **Red zone**（4K，最底层）— 直接 fatal error/VmExit（不可恢复）——连抛出 `StackOverflowError` 的栈空间都没了
* **Yellow zone**（8K，中间层）— 尝试展开栈 → 可能抛 `StackOverflowError`（可恢复）。处理器先临时解除 yellow zone 的保护，让异常抛出代码有栈空间可用
* **Reserved zone**（4K，最上层）— 仅 `@ReservedStackAccess` 注解的方法可用。正常情况下碰触也抛异常，但标注了该注解的方法（如某些关键的 finalizer）可以在 reserved zone 里执行

> 信号处理器中的完整栈溢出判断逻辑——包括如何在线程内展开栈帧、如何构造 `StackOverflowError` 对象、以及 `@ReservedStackAccess` 注解的处理——将在后续 SIGSEGV 处理专题章节单独详细讲解。这里只需知道：此刻 `mprotect(PROT_NONE)` 完成，后续所有的 SIGSEGV 都已经有对应的处理逻辑。

---
## 9. ObjectMonitor::Initialize() —— PerfData 计数器 ★★

```cpp
void ObjectMonitor::Initialize() {
  static int InitializationCompleted = 0;
  assert(InitializationCompleted == 0, "invariant");
  InitializationCompleted = 1;
  if (UsePerfData) {
    EXCEPTION_MARK;
    NEWPERFCOUNTER(_sync_Inflations);
    NEWPERFCOUNTER(_sync_Deflations);
    NEWPERFCOUNTER(_sync_ContendedLockAttempts);
    NEWPERFCOUNTER(_sync_FutileWakeups);
    NEWPERFCOUNTER(_sync_Parks);
    NEWPERFCOUNTER(_sync_Notifications);
    NEWPERFVARIABLE(_sync_MonExtant);
  }
}
```

`static int InitializationCompleted` 是一个函数级静态变量——只在第一次调用 `ObjectMonitor::Initialize()` 时初始化为 0。`assert(InitializationCompleted == 0)` 确保这个函数只被调用一次——是预防重复初始化的第二次守卫（第一次在调用代码路径上）。

`if (UsePerfData)` 守卫 PerfData 机制——Stage 2 中 `UsePerfData` 默认为 true，所以生产环境总是执行下面的注册。

`NEWPERFCOUNTER(name)` 和 `NEWPERFVARIABLE(name)` 是 `perfData.hpp` 中定义的宏——在 PerfData 共享内存区中注册性能计数器。注册的 7 个计数器全部和 `synchronized` 的运行时代码有关：

| 计数器名 | 类型 | 含义 |
|---------|------|------|
| `_sync_Inflations` | Counter | Monitor 膨胀次数（轻量锁→重量锁） |
| `_sync_Deflations` | Counter | Monitor 收缩次数 |
| `_sync_ContendedLockAttempts` | Counter | 竞争锁尝试次数 |
| `_sync_FutileWakeups` | Counter | 无效唤醒次数 |
| `_sync_Parks` | Counter | 线程 park 次数（等待锁） |
| `_sync_Notifications` | Counter | notify/notifyAll 调用次数 |
| `_sync_MonExtant` | Variable（可增减） | 当前存活的 ObjectMonitor 数量 |

Counter 和 Variable 的区别：Counter 只能递增（如膨胀次数——只增不减），Variable 可以增减（如当前存活的 Monitor 数量——创建和销毁都会更新）。这些数据被写入 PerfData 共享内存（第 3.5 节第 1.8 步创建的 `/tmp/hsperfdata_<user>/<pid>` 文件），`jstat -class`、`jcmd PerfCounter.print` 等工具可以读取。

> 注意：这不是 `synchronized` 锁的膨胀初始化——只是 PerfData 性能计数器注册。`synchronized` 的真正初始化（`ObjectSynchronizer` 模块——偏向锁/BasicLock/ObjectMonitor 的膨胀机制）将在后续同步机制章节详细展开。

---
## Stage 4 变量赋值表

本 Stage 中所有被赋值的变量和字段：

| 变量/字段 | C++ 类型 | 所属 | 新值 | 说明 |
|-----------|---------|------|------|------|
| `Threads::_thread_list` | `JavaThread*` | Threads（静态） | NULL | 线程链表头清零 |
| `Threads::_number_of_threads` | `int` | Threads（静态） | 0 | 活跃线程计数清零 |
| `Threads::_number_of_non_daemon_threads` | `int` | Threads（静态） | 0 | 非守护线程计数清零 |
| `main_thread->_stack_base` | `address` | Thread 实例 | `os::current_stack_base()` | 栈顶地址 |
| `main_thread->_stack_size` | `size_t` | Thread 实例 | `os::current_stack_size()` | 栈大小 |
| `main_thread->_stack_overflow_limit` | `address` | JavaThread 实例 | `stack_end() + MAX2(guard, shadow)` | 供 JIT 汇编比较 SP |
| `main_thread->_reserved_stack_activation` | `address` | JavaThread 实例 | `stack_base()` | 保留区激活地址 |
| `main_thread->_thr_current` | `Thread*` | Thread 实例（thread_local） | `this` | C++ thread_local 变量 |
| `main_thread 的 pthread TLS 槽` | `void*` | 线程 TLS | `this` 指针 | `pthread_setspecific(_thread_key, this)` |
| `main_thread->_active_handles` | `JNIHandleBlock*` | Thread 实例 | `new JNIHandleBlock` | JNI 局部引用链表头 |
| `main_thread->_osthread` | `OSThread*` | Thread 实例 | `new OSThread` | 通过 `set_as_starting_thread` 分配 |
| `main_thread->_stack_guard_state` | `StackGuardState` | JavaThread 实例 | `stack_guard_enabled` | 守卫区启用（或保持 unused） |
| `main_thread->_park_events_[4]` | `ParkEvent*` | Thread 实例 | `Allocate(this)` | ParkEvent ×4 预分配 |
| `main_thread->_resource_area` | `ResourceArea*` | Thread 实例 | `new ResourceArea` | 线程临时内存池 |
| `main_thread->_handle_area` | `HandleArea*` | Thread 实例 | `new HandleArea` | GC 句柄区 |
| `main_thread->_parker` | `Parker*` | JavaThread 实例 | `Parker::Allocate(this)` | Unsafe.park/unpark |
| `main_thread->_safepoint_state` | `ThreadSafepointState*` | JavaThread 实例 | `create(this)` | 线程级安全点 |
| `main_thread->_thread_stat` | `ThreadStatistics*` | JavaThread 实例 | `new ThreadStatistics` | TLAB/退优化统计 |
| `main_thread->_SR_lock` | `Monitor*` | Thread 实例 | `new Monitor(suspend_resume)` | 挂起/恢复锁 |
| `main_thread->_hashStateX` | `intptr_t` | Thread 实例 | `os::random()` | XorShift 种子 |
| `main_thread->_entry_point` | `address` | JavaThread 实例 | NULL | 线程入口点 |
| `main_thread->_jni_environment.functions` | `JNINativeInterface_*` | JavaThread 实例 | `jni_functions()` | JNI 函数表 |
| `main_thread->_thread_state` | `ThreadState` | JavaThread 实例 | `_thread_in_vm` | Stage 4 骨架中显式设置 |
| `ObjectMonitor::_sync_Inflations` 等 | PerfCounter | ObjectMonitor（静态） | 注册 | 7 个 PerfData 计数器 |
| `ObjectMonitor::InitializationCompleted` | `static int` | ObjectMonitor 函数级静态 | 1 | 防重复初始化 |

---
## 下一阶段

Stage 4 结束时，JVM 拥有了第一个 `JavaThread` 对象——TLS 绑定完成、栈边界记录完成、守卫区保护到位、PerfData 计数器就绪。下一个阶段 `init_globals()` 开始初始化 Java 堆、类加载器、代码缓存等 20+ 个 JVM 核心子系统。

> `init_globals()` 是 ch04 的核心——从 `Universe::initialize_heap()` 分配 Java 堆、`ClassLoader::initialize()` 加载系统类、`CodeCache::initialize()` 分配代码缓存，到 `Interpreter::initialize()` 创建模板解释器——20+ 个子系统的初始化将在 ch04 逐项展开。
