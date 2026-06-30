# 3.6 Stage 4：主线程创建

Stage 3 结束时，JVM 的 OS 层基础设施已经全部就绪——信号处理器注册完成、安全点轮询页分配完成、200+ 个 flag 全部锁定。但所有这些基础设施都是"悬浮在空中"的——没有线程来承载它们。

**当前执行到这里的线程是谁？** 回顾 3.1 的"此刻的进程与线程"——JLI 层在进入 JVM 之前做了 `pthread_create`，此时进程中有两个 OS 线程：

```
Java 进程 (PID=xxx)
├─ 原始线程 (LWP-1)           ← 阻塞在 pthread_join
└─ 新 pthread (LWP-2)         ← 正在执行 Threads::create_vm（就是我们）
```

LWP-2 是由 `CallJavaMainInNewThread()` 中的 `pthread_create` 创建的。它是调用 `JavaMain()` → `InitializeJVM()` → `JNI_CreateJavaVM()` → `Threads::create_vm()` 的线程，也将是 Java 程序员眼中的"main 线程"——最终它会执行 `main(String[] args)`。LWP-1 永远不会变成 `JavaThread`，它唯一的使命是 `pthread_join` 等 LWP-2 结束。

现在的问题是：LWP-2 这个 OS 线程还没有在 JVM 内部"登记"——JVM 不知道它的栈边界在哪、它是什么状态、它的 ParkEvent 分配了没有。从 `Threads::create_vm` 的 9 阶段骨架[^1]来看，下一步的使命很明确：给 LWP-2 穿上 JVM 的外衣——创建 JVM 的第一个 `JavaThread` 对象，把当前线程在 JVM 内部完成登记。

> **澄清：`new JavaThread()` 不是创建新的 OS 线程。** 它只是创建一个 C++ 对象来"包装/描述"当前正在运行的 OS 线程（LWP-2）。`new JavaThread()` 之后也只有这一个线程在 `Threads::create_vm` 中执行。后面 `pthread_create` 创建的是额外的子线程（如 CompilerThread、GC 线程）——那些在 ch04 的 `init_globals()` 阶段才会出现。

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

Stage 3 结束时，信号处理器、安全点轮询页、200+ 个 flag 全部就位——但 JVM 的线程管理表还是一片空白。这三行源代码做的事很简单：把线程管理体系的三根支柱全部清零。

`Threads` 是继承 `AllStatic` 的纯静态类——构造函数和析构函数都声明为 `ShouldNotCallThis()`，确保任何人不创建 `Threads` 实例。它的所有成员都是 `static`，整个 JVM 进程中只有一份。

```cpp
static JavaThread* _thread_list;
```

`_thread_list` 是 JVM 中所有 `JavaThread` 对象的链表头指针。每个 `JavaThread` 通过自己的 `_next` 字段（`JavaThread*`）串在链表中，构成一个单向链表。头插法——最后加入的线程在最前面：

```
_thread_list → [最新加入的 JavaThread] → [上一个] → ... → [最早的] → NULL
```

此刻设为 NULL，表示链表中一个线程都没有。后面 `Threads::add()` 会用头插法把 `main_thread` 推进来。

```cpp
static int _number_of_threads;
```

`_number_of_threads` 记录链表中有多少个 `JavaThread`。每次 `Threads::add()` 时 ++，`Threads::remove()` 时 --。此刻为 0。

但这个数字只算 `JavaThread`——NonJavaThread（VMThread、WatcherThread 等）不计在内。它们有自己独立的 `NonJavaThread::_the_list`。

```cpp
static int _number_of_non_daemon_threads;
```

`_number_of_non_daemon_threads` 记录链表中非守护线程的数量。daemon 线程的判断来自 Java 层的 `Thread.isDaemon()`——`threadObj->bool_field(daemon_offset)`。此刻为 0。

这个计数器直接决定 JVM 何时退出：`Threads::destroy_vm()` 在 `Threads_lock` 上循环等待 `number_of_non_daemon_threads() > 1`，当只剩 shutdown 线程自己（计数降到 1）时才继续退出流程。守护线程不阻止 JVM 退出——所有 daemon 线程会被强制终止。

此刻 JVM 里没有任何线程在名单上。三行代码之后，这张空白名单将开始接收它的第一个成员。

回头想一个问题：将来 JVM 里跑着多个 Java 线程时，GC 需要遍历 `_thread_list` 找到所有线程的 Java 栈帧作为 GC 根。但这时候可能恰巧另一个 Java 线程执行完毕，正在 `Threads::remove()` 把自己从链表中摘除——如果 GC 正遍历到被删节点的 `_next` 指针，读到的就是已释放的内存。

HotSpot 用 Thread-SMR（Safe Memory Reclamation）解决这个问题。核心思路很简单：**不直接遍历原始的 `_thread_list` 链表，而是维护一份不可变的数组快照。** 每次有线程加入或移除时，不是原地改链表，而是创建一个新的快照数组（Copy-On-Write）——旧快照留在原地不动。遍历线程（如 GC）拿到旧快照的指针后，把这个指针写入自己 `_thread` 内的 `_threads_hazard_ptr` 字段——相当于宣告"这份快照我正在读，别释放"。删除线程要等到**所有线程**的 `_threads_hazard_ptr` 都不再指向这份旧快照时，才真正释放它的内存。

> 用生活中的例子：图书馆闭馆时要销毁一批旧书。管理员不是直接烧——而是先看所有阅览室的登记表（hazard pointer），确认"没有人在读这本书"，才来销毁。有人还拿着，就等着。

---
## 2. vm_init_globals() ★★

`vm_init_globals()`（`init.cpp:90-98`）在 `new JavaThread()` 之前建立 JVM 运行需要的全局基础设施。用树形骨架看全貌：

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

七个调用各做各的事，下面按重要度展开。不需要全部记住——需要记住三件：本节后续的大量字段分配依赖 chunkpool_init，ParkEvent 等锁依赖 mutex_init 建立了全局锁秩序，ObjectMonitor::Initialize() 依赖 perfMemory_init 创建了共享内存。

### check_ThreadShadow — 布局验证

```cpp
void check_ThreadShadow() {
  const ByteSize offset_of_exception = byte_offset_of(ThreadShadow, _pending_exception);
}
```

这是内联函数，仅做编译时断言——验证 `_pending_exception` 在 ThreadShadow 对象中的偏移量确实等于 JVM 硬编码的预期值。ThreadShadow 通过一个空虚拟函数 `unused_initial_virtual()` 强制编译器生成 vtable，确保内存布局的可预测性。如果编译器不生成 vtable，`check_ThreadShadow` 会在编译时捕获布局偏差（通过 `STATIC_ASSERT`）——这是 `vm_init_globals` 中最先执行的检查，防止整个 JVM 基于错位的内存布局运行。

### basic_types_init — 基本类型映射表

JVM 的字节码解释器在操作栈时，必须知道每个槽位里放的是什么——`iload` 知道栈顶是个 `int`（4 字节），`lload` 知道是个 `long`（8 字节），`aload` 知道是个对象引用。这需要一套从 BasicType 枚举到签名字符再到内存布局的映射。

三张关键的全局数组在 `globalDefinitions.cpp` 中编译时就已经造好：

```cpp
// BasicType → JVM 类型签名字符
char type2char_tab[T_CONFLICT+1] = {
  0, 0, 0, 0,           // 0-3: 未使用
  'Z', 'C', 'F', 'D',   // 4=boolean, 5=char, 6=float, 7=double
  'B', 'S', 'I', 'J',   // 8=byte, 9=short, 10=int, 11=long
  'L', '[', 'V',         // 12=object, 13=array, 14=void
};

// BasicType → 在栈/内存中的布局类型
BasicType type2field[T_CONFLICT+1] = {
  0, 0, 0, 0,
  T_BOOLEAN, T_CHAR, T_FLOAT, T_DOUBLE,     // 4-7: 自映射
  T_BYTE, T_SHORT, T_INT, T_LONG,           // 8-11: 自映射
  T_OBJECT, T_OBJECT, T_VOID,               // 12-14: array→object
  T_ADDRESS, T_NARROWOOP, T_METADATA, T_NARROWKLASS, T_CONFLICT // 15-19: 自映射
};

// HeapWord 对齐后的"宽"布局类型（栈 banging 用）
BasicType type2wfield[T_CONFLICT+1] = {
  0,0,0,0, T_INT,T_INT,T_FLOAT,T_DOUBLE, T_INT,T_INT,T_INT,T_LONG,
  T_OBJECT, T_OBJECT, T_VOID, T_ADDRESS, T_NARROWOOP, T_METADATA,
  T_NARROWKLASS, T_CONFLICT
};
```

第一张表 `type2char_tab` 回答了"一个 BasicType 在 JVM 规范里对应的签名字符是什么"。`T_INT=10` → `'I'`，`T_LONG=11` → `'J'`。JVM 规范里 `long` 的签名字符就是 `J`（因为 `L` 被对象引用占了）。反向查询 `char2type` 是同一张表的逆映射。

第二张表 `type2field` 回答了"这个类型在栈槽位里实际占什么布局"。大部分类型自映射——`T_INT` → `T_INT`，`T_DOUBLE` → `T_DOUBLE`。例外是 `T_ARRAY` → `T_OBJECT`——数组引用和普通对象引用在栈上存的是一样的指针（都是 oop），不需要区分。

第三张表 `type2wfield` 是 GC 和栈溢出检测用的。不关心栈上放的是 `boolean` 还是 `int`，统一按 HeapWord（至少 4 字节）对齐——JIT 编译器在方法入口检查栈空间时，不在乎"这一格是 boolean"，只看有没有足够的 HeapWord 槽位够新方法的 frame 用。

所谓的 "栈 banging" 技术：JIT 编译的机器码在进入一个方法前，先尝试往栈深处写一页——如果能写进去（没碰到 `PROT_NONE` 保护的守卫页），说明栈空间够，可以安全执行方法。如果触发了 SIGSEGV，说明栈快用完了，信号处理器根据碰到的位置决定抛 `StackOverflowError` 还是直接崩溃。这个"主动往栈深处写一页试探"的动作，就是 "banging"——像用拳头砸墙看墙后面有没有空间。

`basic_types_init()` 中 `#ifdef ASSERT` 包围的断言全跳过。product 构建下这个函数做两件实事：

```cpp
void basic_types_init() {
#ifdef ASSERT
  // assert(jint==4字节) + assert(type2char可逆) + assert(type2field规则) —— 全跳过
#endif

  // 第一件：把 -XX:JavaPriority1..10 映射到 OS 线程优先级数组
  if (JavaPriority1_To_OSPriority != -1)
    os::java_to_os_priority[1] = JavaPriority1_To_OSPriority;
  // ... JavaPriority2~10 同理，共 10 行 ...

  // 第二件：根据 UseCompressedOops 设置对象引用的大小
  if (UseCompressedOops) {
    heapOopSize        = jintSize;      // 4 字节
    LogBytesPerHeapOop = LogBytesPerInt;
    BytesPerHeapOop    = BytesPerInt;
  } else {
    heapOopSize        = oopSize;       // 8 字节
    LogBytesPerHeapOop = LogBytesPerWord;
    BytesPerHeapOop    = BytesPerWord;
  }
  _type2aelembytes[T_OBJECT] = heapOopSize;
  _type2aelembytes[T_ARRAY]  = heapOopSize;
}
```

第一件平常不执行——10 个 flag 的默认值都是 `-1`。用户显式传了 `-XX:JavaPriority1_To_OSPriority=N` 才触发映射，绝大多数启动场景下这 10 行全是死代码。

第二件才是重点。`UseCompressedOops` 是 Stage 2 参数解析中确定的全局开关（默认 true，64 位 heap < 32GB 时自动开启）。如果开启压缩指针，`heapOopSize = 4`——对象引用在 Java 堆中占 4 字节（而非原生指针的 8 字节），32GB 以下的堆能省一半内存。`_type2aelembytes` 是数组元素字节数表——`T_OBJECT` 和 `T_ARRAY` 的元素大小都设为 `heapOopSize`，后面 GC 的 oop 遍历和 JIT 编译器的数组边界检查都读这张表。

所以 `basic_types_init()` 的 product 构建版本实际上设置了 JVM 对象模型的基础参数——所有后续代码通过 `heapOopSize` 和 `_type2aelembytes` 判断"一个引用占几个字节"。

### eventlog_init — 四类事件的环形缓冲区

```cpp
void eventlog_init() {
  Events::init();
}
```

委托 `Events::init()`（`events.cpp:65-72`），创建四类事件的环形缓冲区：

```cpp
void Events::init() {
  if (LogEvents) {
    _messages       = new StringEventLog("Events");          // 编译/GC/线程启动等通用事件
    _exceptions     = new ExtendedStringEventLog("Internal exceptions"); // JVM 内部异常
    _redefinitions  = new StringEventLog("Classes redefined"); // 类重定义事件
    _deopt_messages = new StringEventLog("Deoptimization events"); // 去优化事件
  }
}
```

`LogEvents` 是一个 `diagnostic` 类型的 JVM flag（`globals.hpp:554`），默认 `true`。JVM 的 `-XX` flag 按可配性分四类。前两类最常用：

**`product` 类型**——谁都能改，不加任何锁。`-XX:+PrintGCDetails`、`-XX:MaxHeapSize=4g` 都是 product 类型，直接在命令行上写就行：

```
java -XX:+PrintGCDetails MyApp
```

**`diagnostic` 类型**——默认生效，但想关掉它必须先"开锁"。"锁"本身也是一个 flag：`UnlockDiagnosticVMOptions`。不加锁就关 diagnostic flag，JVM 直接拒绝启动：

```
# 这样不行——JVM 报错 Unrecognized VM option
java -XX:-LogEvents MyApp

# 必须加锁才行
java -XX:+UnlockDiagnosticVMOptions -XX:-LogEvents MyApp
```

`UnlockDiagnosticVMOptions` 也是 diagnostic 类型（在 debug 构建下默认 true，product 构建默认 false）。所以你在生产环境想关 `LogEvents`，命令就是 `-XX:+UnlockDiagnosticVMOptions -XX:-LogEvents`。

**`experimental` 类型**——和 diagnostic 同理，锁叫 `UnlockExperimentalVMOptions`。`UseZGC`、`UseShenandoahGC` 是 experimental 类型：

```
java -XX:+UnlockExperimentalVMOptions -XX:+UseZGC MyApp
```

**`develop` 类型**——只在 debug/slowdebug 构建的 JVM 中存在，product 构建的 `java` 命令根本没有这些 flag。

`LogEvents` 和 `LogEventsBufferEntries`（默认 20，控制每个环形缓冲区存多少条记录）都是 diagnostic 类型。

JVM 运行时，各处代码通过 `Events::log(thread, "Thread added: %p", p)` 写入事件——线程创建时写、GC 阶段开始时写、JIT 编译完成时写。环形缓冲区写满后覆盖最旧的记录。

这四个缓冲区最关键的用途是**崩溃诊断**。当 JVM 崩溃时，`hs_err_pid<pid>.log` 文件中会依次 dump 这四段缓冲区：

```
Event: 0.028 Thread added: 0x00007f1234000800
Event: 0.029 Thread added: 0x00007f1234001800
...
```

初始化这么早是因为崩溃随时可能发生——如果 `eventlog_init` 晚于某个记录事件的代码，崩溃报告中就会缺少关键线索。

### mutex_init — 锁的全序系统

`mutex_init()`（`mutexLocker.cpp:195-255`）创建约 50 个全局 `Mutex` 和 `Monitor` 对象。每个锁在创建时分配一个 rank：

```cpp
def(tty_lock              , PaddedMutex  , tty,       true, Monitor::_safepoint_check_never);
def(Patching_lock         , PaddedMutex  , special,   true, Monitor::_safepoint_check_never);
def(CodeCache_lock        , PaddedMutex  , special,   true, Monitor::_safepoint_check_never);
def(MetaspaceExpand_lock  , PaddedMutex  , leaf-1,    true, Monitor::_safepoint_check_never);
def(Service_lock          , PaddedMonitor, special,   true, Monitor::_safepoint_check_never);
// ...约45个类似的 def 调用...
```

`def` 宏的参数依次是：变量名、锁类型（PaddedMutex/PaddedMonitor）、rank、是否允许在 VM 阻塞、safepoint 检查模式。

rank 是一个枚举值——`tty` < `special` < `leaf` < `access` < `nonleaf` 等。规则接近教科书里的全序锁：一个线程一次可以持多把锁，但必须按 rank **从小到大**加锁——如果已经持了 rank=5 的锁，就不能再去拿 rank=3 的锁，否则判定为死锁风险（debug 构建直接 assert）。这就是 05 中讲解的锁 rank 防死锁机制的实际落地——05 讲的是理论，这里 `mutex_init` 给所有锁分配了具体 rank 值，建立了完整的加锁顺序表。

后续所有 `new Monitor(Mutex::xxx, ...)` 调用（包括 `_SR_lock` 的 `Mutex::suspend_resume`）都依赖这个 rank 体系——构造 Monitor 时必须声明自己的 rank，运行时根据 rank 决定加锁顺序。

### chunkpool_init — Arena 块池

```cpp
void chunkpool_init() {
  ChunkPool::initialize();
}
```

`ChunkPool` 预分配一批固定大小的内存块（chunk），供 Arena 风格的内存分配器使用。Section 3 构造的 `new ResourceArea()` 依赖这个块池——ResourceArea 从 ChunkPool 中取块而不是逐个 `malloc`，避免了小块内存碎片和频繁系统调用。池化后创建第一个 JavaThread 时，构造函数里所有 `new(mtThread) ResourceArea` 等分配才有内存可用。

### perfMemory_init — jstat 共享内存

```cpp
void perfMemory_init() {
  if (!UsePerfData) return;
  PerfMemory::initialize();
}
```

`UsePerfData` 默认为 true，所以正常 `java` 命令必然执行 `PerfMemory::initialize()`。这会创建 `/tmp/hsperfdata_<user>/<pid>` 文件——一个 mmap 的共享内存文件，JVM 所有 PerfData 计数器（包括本章末尾 `ObjectMonitor::Initialize()` 注册的 `_sync_Inflations` 等 7 个计数器）最终都写入这个文件。`jstat -class`、`jcmd PerfCounter.print` 通过读取这个文件获取实时指标。如果没有这步初始化，本章末的 7 个 `NEWPERFCOUNTER` / `NEWPERFVARIABLE` 宏调用会失败。

### SuspendibleThreadSet_init — 可挂起线程集合

`SuspendibleThreadSet`（STS）跟踪当前有多少线程处于"可挂起"状态。GC 在 safepoint 时需要挂起所有线程——但线程自己可以选择"我正做关键操作，暂时别挂起我"（通过 `SuspendibleThreadSetJoiner` RAII 对象）。STS_init 初始化这个计数器为 0。

> `vm_init_globals()` 只是 VM 线程侧的前置基础设施。同文件下方的 `init_globals()` 才是 ch04 的核心——它依次初始化 management、bytecodes、classLoader、codeCache、VM_Version、universe、interpreter 等 20+ 个子系统。`vm_init_globals` 和 `init_globals` 是两个不同的函数，不要混淆。

---
## 3. Attach the main thread to this os thread ★★★

从 `new JavaThread()` 到 `create_stack_guard_pages()`，这一段源码给 LWP-2 穿上 JVM 的外衣。在展开每行的具体实现之前，先明确 `new JavaThread()` 在创建什么。

`JavaThread` 是 HotSpot 内部类层次中专门执行 Java 代码的线程类型。它的继承链：

```
CHeapObj → ThreadShadow → Thread → JavaThread
```

`Thread` 基类提供所有线程共用的基础设施——栈元数据、内存池（ResourceArea/HandleArea）、四个 ParkEvent、Suspend/Resume 锁、hazard pointer。`JavaThread` 在基类之上增加 Java 执行引擎需要的字段——关联 Java 层 Thread 对象的 `_threadObj`、JNI 函数表、ThreadState 状态机、safepoint 状态、栈守卫区、异常处理。Thread 和 JavaThread 的完整字段清单将在下文的构造函数小节中逐一展开。

> HotSpot 还有另一条继承线 `NonJavaThread → NamedThread → VMThread/WatcherThread`，用于 GC 调度、周期采样等不执行 Java 代码的线程。它们共享 Thread 基类的基础设施但没有 Java 执行引擎的任何字段。本章只关注 `JavaThread`——当前 `_thread_list` 上唯一的线程对象。

### 3.1 new JavaThread() —— 构造函数 ★★★

Stage 4 的核心操作——用 `new` 在 C-Heap 上分配第一个 `JavaThread` 对象。构造函数调用链三层：

```
new JavaThread()
  → ThreadShadow::ThreadShadow()          // 异常传播基类：_pending_exception = NULL
  → Thread::Thread()                      // 基础线 ：栈/内存/系统监控/ParkEvent
  → JavaThread::initialize()              // Java 执行能力：TLS/栈守卫/状态机
  → pd_initialize()                       // 平台相关初始化（Linux 上为空）
```

`ThreadShadow` 是 `Thread` 的直接父类，只有三个字段——`_pending_exception`（`oop`）、`_exception_file`、`_exception_line`。HotSpot 内部 C++ 代码不能用 C++ 的 `throw` 来传播 Java 异常（C++ 异常对象和 Java 堆上的 `oop` 类型完全不兼容），所以通过 `THROW_MSG` 宏把 Java 异常对象写入 `_pending_exception`，然后逐层 `return`。每个调用点用 `CHECK` 宏检查——如果 `_pending_exception != NULL`，立即 `return`。构造时初始化为 NULL——线程刚诞生，没有残留异常。完整的 C++ 异常 vs Java 异常机制对比将在后续异常处理章节详细展开。

构造函数体本身只有一行：

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

`Thread()` 构造函数不接收参数——所有字段在构造体内由 `os::random()`、`ParkEvent::Allocate()` 等函数初始化。下面按功能分组展示核心字段——不是 116 个全列，而是按功能分组。

#### 栈信息（暂为空）

```cpp
_stack_base = NULL;
_stack_size = 0;
```

此刻线程的栈还没有捕获——等第 5 步 `record_stack_base_and_size()` 才从 `os::current_stack_base()` 和 `os::current_stack_size()` 读真实值。

#### 内存管理

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

#### 线程安全

```cpp
Threads::ThreadsList* _threads_hazard_ptr;  // 线程列表的 hazard pointer（无锁安全读取）
ThreadsList*          _threads_list_ptr;     // 指向当前有效的线程列表快照
int  _hazard_ptr_count;                      // 递归引用计数
uint _rcu_counter;                           // RCU 风格计数器
```

这三个是实现线程列表无锁遍历的基础——其他线程（如 GC 的 VMThread）可以在不拿锁的情况下安全遍历活跃线程列表。`_threads_hazard_ptr` 在遍历前保存当前列表指针，配合 `_rcu_counter` 防止遍历期间列表被回收。

#### 系统监控

```cpp
Monitor* _SR_lock;          // suspend/resume 的 Monitor（不是 synchronized 那个 ObjectMonitor）
volatile uint32_t _suspend_flags;  // 挂起标志（0=正常运行，非0=需要挂起）
```

`_SR_lock` 是 HotSpot 的 `Monitor`（第 3.5 节详细讲解的四层锁机制的第 3 层），用于线程的 suspend/resume 操作。它和第 3.5 节第 1.1 步注册的 `SR_signum` 信号配合工作：

* `SR_signum`（信号 12）是**通知机制**——VMThread 用 `pthread_kill(target_id, SR_signum)` 通知目标线程"你要停下了"
* `_SR_lock` 是**同步机制**——线程进入 `SR_handler` 后通过这个 Monitor 和 VMThread 协调状态转换

两者功能不同但紧密配合：信号负责打断运行中的线程，Monitor 负责协调挂起/恢复的状态一致性。完整的 Suspend/Resume 流程将在后续 Stop-The-World 章节展开。

#### ParkEvent 四件套

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

#### Hash 种子

```cpp
_hashStateX = os::random();          // 线程本地随机数种子（第一阶段）
_hashStateY = 842502087;             // Marsaglia XorShift 算法的固定常量
_hashStateZ = 0x8767;                // └─ 来自经典论文《Xorshift RNGs》
_hashStateW = 273326509;             // └─ 四元组确保足够的周期和随机性
```

HotSpot 用 Marsaglia 的 XorShift 算法生成线程本地的伪随机数——每个线程有自己的 `_hashStateX/Y/Z/W` 四元组，不需要全局锁。

#### JavaThread::initialize() 专有字段

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

JavaThread 的状态机共 10 个状态，核心设计是**偶数 = 稳定状态，奇数（偶数+1）= 过渡状态**。主线程在本节只会用到 5 个稳定状态：

| 状态 | 值 | 含义 |
|------|-----|------|
| `_thread_new` | 2 | 刚创建，正在初始化 |
| `_thread_in_native` | 4 | 正在执行 native 代码（JNI） |
| `_thread_in_vm` | 6 | 正在执行 VM 代码 |
| `_thread_in_Java` | 8 | 正在执行 Java 字节码或 JIT 编译的机器码 |
| `_thread_blocked` | 10 | 在 VM 中被阻塞（等待锁/IO） |

HotSpot 用 RAII 包装类管理状态转换——`ThreadInVMfromJava`（Java→VM）、`ThreadInVMfromNative`（Native→VM）、`ThreadBlockInVM`（VM→Blocked）。构造时进入新状态，析构时返回原状态，确保不会"半路抛异常"导致状态泄漏。过渡态期间会检查 safepoint——偶数稳定态之间不能直接跳，必须经过奇数过渡态。主线程在 `Threads::create_vm` 中直接设 `_thread_in_vm`（后面会看到），因为主线程本身就是 VM 代码。

`_terminated` 走另一条路径：`_not_terminated(0xDEAD-2=57003)` → `_thread_exiting(57004)` → `_thread_terminated(57005)`；特殊路径 `_vm_exited(57006)` 用于线程在 native 代码中时 JVM 执行 VM_Exit。

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

#### 构造函数后状态快照

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
### 4. initialize_thread_current() —— TLS 绑定 ★★

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
### 5. record_stack_base_and_size() —— 记录栈边界 ★★

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
### 6. set_active_handles() —— JNI 局部引用块 ★

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
### 7. set_as_starting_thread() —— 主线程附着 ★

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
### 8. create_stack_guard_pages() —— 栈守卫区 ★★★

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
## 4. ObjectMonitor::Initialize() —— PerfData 计数器 ★★

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
