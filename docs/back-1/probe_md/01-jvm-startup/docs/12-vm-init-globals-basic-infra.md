# 12-vm-init-globals-basic-infra — vm_init_globals：类型验证 + ChunkPool + EventLog + GC 线程挂起

> **Phase**: 01-jvm-startup
> **前置**: [06-Mutex]（vm_init_globals 的 mutex_init）、[07-PerfMemory]（perfMemory_init）
> **配套**: [00-JNI-CreateJavaVM]（vm_init_globals 在 create_vm Stage 4 中的位置）
> **后续依赖本文**: [13-Management-Services]（init_globals 第一个调用，使用 vm_init_globals 创建的基础设施）
> **阅读收益**: 追踪 vm_init_globals 的 4 个调用——理解 basic_types_init 的 30+ assert ABI 校准（jbyte=1..jlong=8）+ UseCompressedOops → heapOopSize 设置、eventlog_init 的 4 EventLog（VM 事件/内部异常/类重定义/去优化）、chunkpool_init 的 4 ChunkPool（large~32KB/medium~10KB/small~1KB/tiny~256B）Arena 分配器前置、SuspendibleThreadSet_init 的 Semaphore GC 线程挂起协调；掌握 "UseCompressedOops 导致 crash" 和 "ChunkPool 加速 Arena 分配 10×" 的底层机制

---

## §〇 Production Scenario

### 场景 1: `-XX:+UseCompressedOops` 导致 JVM crash

```bash
java -XX:+UseCompressedOops -jar app.jar
# Error: ShouldNotReachHere() in globalDefinitions.cpp:168
```

`basic_types_init()` (`globalDefinitions.cpp:53`) 在 `UseCompressedOops=true` 时设置 `heapOopSize = sizeof(narrowOop)` (= 4 字节) 和 `BytesPerHeapOop = 4`。但此设置依赖 `_type2aelembytes[T_OBJECT]` 已正确定义——如果 `type2aelembytes` 映射表未初始化 → `ArrayKlass::array_klass()` 在计算数组元素大小时使用错误的 oop 大小 → 内存分配错误 → crash。

**三步诊断**：
```bash
# 1. 验证 oop 大小设置
gdb -ex "break globalDefinitions.cpp:168" \
    -ex "run" \
    -ex "print heapOopSize" \
    -ex "print BytesPerHeapOop" \
    --args java -XX:+UseCompressedOops -jar app.jar
# 期望: heapOopSize=4, BytesPerHeapOop=4

# 2. 验证基本类型大小断言
gdb -ex "break globalDefinitions.cpp:84" \
    -ex "run" \
    -ex "print sizeof(jint)" \
    -ex "print sizeof(jlong)" \
    --args java -jar app.jar
# 期望: jint=4, jlong=8 (LP64)
```

**反事实**：如果 `basic_types_init()` 不验证基本类型大小 → LP64 平台上 `intx` 可能被错误定义为 32-bit（应该是 64-bit）→ 指针运算截断 → 静默数据损坏 → 极难诊断的 heap corruption。

### 场景 2: JVM 内部事件日志为空

```bash
jcmd <pid> VM.events
# 输出为空——期望看到类加载、逆优化、GC 等事件
```

`eventlog_init()` (`events.cpp:74`) 创建 4 个 `EventLog` 对象：`_messages` (JVM 操作日志)、`_exceptions` (内部异常)、`_redefinitions` (类重定义)、`_deopt_messages` (逆优化)。但如果 `LogEvents=false`（`-XX:-LogEvents`），这些对象不创建 → `jcmd VM.events` 无输出。

### 场景 3: GC safepoint 中线程无法被挂起

```
# JVM 日志
[warning] SuspendibleThreadSet::join() timed out
```

`SuspendibleThreadSet_init()` (`suspendibleThreadSet.cpp:39`) 创建 `_synchronize_wakeup = new Semaphore()`——用于在 GC 并发标记期间唤醒等待同步的可挂起线程。如果此信号量未创建 → `SuspendibleThreadSet::synchronize()` 中的 `_synchronize_wakeup->signal()` 操作空指针 → SIGSEGV。

---

## §一 ★★★ vm_init_globals 4 调用全链路源码走读

### 1.1 Interview Story Format Answer

"`vm_init_globals()` at `init.cpp:95` runs BEFORE `init_globals()` at `init.cpp:109`. `basic_types_init()` at `globalDefinitions.cpp:53` (125 lines) is the longest function in vm_init_globals — it validates 30+ type size assertions (jbyte=1, jint=4, jlong=8, intx=8 on LP64), verifies `type2char`/`char2type` bidirectional mapping tables (11 BasicType mappings), checks that `HeapWordSize` is a power of 2, maps Java thread priorities 1-10 to OS priorities via 10 conditional assignments to `os::java_to_os_priority[]`, and sets `heapOopSize`/`BytesPerHeapOop`/`BitsPerHeapOop` based on `UseCompressedOops` — the single function that calibrates the JVM's understanding of its own runtime environment. `eventlog_init()` at `events.cpp:74` (3 lines, delegates to `Events::init()` 8 lines) conditionally creates 4 `EventLog` objects (if `LogEvents=true`, default): `_messages` (VM operations, class loading, GC), `_exceptions` (ExtendedStringEventLog for internal JVM exceptions with extra PC/thread context), `_redefinitions` (JVMTI class redefinition events), `_deopt_messages` (C2 deoptimization reasons). `chunkpool_init()` at `arena.cpp:155` (3 lines, delegates to `ChunkPool::initialize()` 6 lines) creates 4 `ChunkPool` instances — `_large_pool` (Chunk::size + overhead ~32KB), `_medium_pool` (Chunk::medium_size + overhead ~10KB), `_small_pool` (Chunk::init_size + overhead ~1KB), `_tiny_pool` (Chunk::tiny_size + overhead ~256B) — each pool is a free list of pre-allocated memory chunks that the Arena allocator uses for bump-pointer allocation, with `ChunkPoolCleaner` periodic task (5000ms) keeping max 5 chunks per pool. `SuspendibleThreadSet_init()` at `suspendibleThreadSet.cpp:39` (4 lines) creates `_synchronize_wakeup = new Semaphore()` — used by `SuspendibleThreadSet::synchronize()` to wait() and `desynchronize()` to signal() for coordinating compiler/reference-processing threads during concurrent marking. The key architectural insight: these 4 calls create zero Java objects, zero CodeCache allocations, zero Metaspace usage — they are pure C++ infrastructure that validates the execution environment and creates the memory allocation pools that `init_globals()`'s 31 calls depend on."

### 1.2 basic_types_init() — 类型大小验证（125 行）

`globalDefinitions.cpp:53-177` 分为三个部分。

**Part 1: ASSERT 块 — 30+ 类型大小断言**（:54-134）：

```cpp
void basic_types_init() {
#ifdef ASSERT
#ifdef _LP64
  assert(min_intx == (intx)CONST64(0x8000000000000000), "correct constant");
  assert(max_intx == CONST64(0x7FFFFFFFFFFFFFFF), "correct constant");
  assert(8 == sizeof(intx), "wrong size for basic type");
  assert(8 == sizeof(jobject), "wrong size for basic type");
#else
  assert(4 == sizeof(intx), "wrong size for basic type");
  assert(4 == sizeof(jobject), "wrong size for basic type");
#endif
  assert(1 == sizeof(jbyte), "wrong size for basic type");
  assert(2 == sizeof(jchar), "wrong size for basic type");
  assert(2 == sizeof(jshort), "wrong size for basic type");
  assert(4 == sizeof(juint), "wrong size for basic type");
  assert(4 == sizeof(jint), "wrong size for basic type");
  assert(1 == sizeof(jboolean), "wrong size for basic type");
  assert(8 == sizeof(jlong), "wrong size for basic type");
  assert(4 == sizeof(jfloat), "wrong size for basic type");
  assert(8 == sizeof(jdouble), "wrong size for basic type");
  assert(1 == sizeof(u1), "wrong size for basic type");
  assert(2 == sizeof(u2), "wrong size for basic type");
  assert(4 == sizeof(u4), "wrong size for basic type");
  assert(wordSize == BytesPerWord, "should be the same");
  assert(wordSize == HeapWordSize, "should be the same");
```

接着验证 `type2char`/`char2type` 双向映射（:86-94）：

```cpp
  for (int i = 0; i < 99; i++) {
    if (type2char((BasicType)i) != 0) {
      assert(char2type(type2char((BasicType)i)) == i, "proper inverses");
      num_type_chars++;
    }
  }
  assert(num_type_chars == 11, "must have tested the right number of mappings");
```

然后验证 `type2field` 映射的正确性（:96-128）——每个 BasicType 要么映射到自己（布局类型），要么映射到相同大小的布局类型。

最后验证 HeapWordSize 假设（:130-134）：

```cpp
  assert(is_power_of_2(sizeof(juint)), "juint must be power of 2");
  assert(is_power_of_2(HeapWordSize), "HeapWordSize must be power of 2");
  assert((size_t)HeapWordSize >= sizeof(juint), "HeapWord should be at least as large as juint");
```

**Part 2: Java 优先级 → OS 优先级映射**（:137-156）：

```cpp
  if (JavaPriority1_To_OSPriority != -1)
    os::java_to_os_priority[1] = JavaPriority1_To_OSPriority;
  if (JavaPriority2_To_OSPriority != -1)
    os::java_to_os_priority[2] = JavaPriority2_To_OSPriority;
  // ... 重复到 JavaPriority10_To_OSPriority ...
```

每个 `JavaPriorityN_To_OSPriority` 是一个 JVM 参数（`globals.hpp:2134`），默认值 -1（不覆盖）。Linux 默认映射表（`os_linux.cpp:4804`）：

```cpp
int os::java_to_os_priority[CriticalPriority + 1] = {
  19,   // 0  (未使用)
  4,    // 1  MinPriority
  3,    // 2
  2,    // 3
  1,    // 4
  0,    // 5  NormPriority
  -1,   // 6
  -2,   // 7
  -3,   // 8
  -4,   // 9  NearMaxPriority
  -5,   // 10 MaxPriority
  -5    // 11 CriticalPriority
};
```

**Part 3: UseCompressedOops → heapOopSize**（:161-176）：

```cpp
  if (UseCompressedOops) {
    heapOopSize        = jintSize;       // 4
    LogBytesPerHeapOop = LogBytesPerInt; // 2
    LogBitsPerHeapOop  = LogBitsPerInt;  // 5
    BytesPerHeapOop    = BytesPerInt;    // 4
    BitsPerHeapOop     = BitsPerInt;     // 32
  } else {
    heapOopSize        = oopSize;            // sizeof(char*) = 8 (LP64)
    LogBytesPerHeapOop = LogBytesPerWord;    // 3
    LogBitsPerHeapOop  = LogBitsPerWord;     // 6
    BytesPerHeapOop    = BytesPerWord;       // 8
    BitsPerHeapOop     = BitsPerWord;        // 64
  }
  _type2aelembytes[T_OBJECT] = heapOopSize;
  _type2aelembytes[T_ARRAY]  = heapOopSize;
```

**追问**：为什么 `_type2aelembytes[T_OBJECT]` 和 `[T_ARRAY]` 需要根据 UseCompressedOops 设置？→ aelembytes = array element bytes。Object[] 中每个元素是 oop 引用——压缩时 4 字节，非压缩时 8 字节。`ArrayKlass::array_klass()` 使用此值计算数组大小。`_type2aelembytes` 数组在编译时（:265）用 `T_OBJECT_aelem_bytes`（LP64=8）初始化，运行时被 `basic_types_init()` 覆盖为 `heapOopSize`（压缩时=4）。

**反事实**：如果 UseCompressedOops 的设置与 heapOopSize 不一致？→ UseCompressedOops=true 但 heapOopSize=8 → 指针压缩逻辑使用 8 字节 oop 但编码为 4 字节 → 解码时丢失高 32 位 → 指针指向错误地址 → SIGSEGV。这就是为什么 `basic_types_init()` 集中设置这些值——确保所有相关变量一致。

### 1.3 eventlog_init() → Events::init() — 4 EventLog

`events.cpp:74-76` 是外部入口：

```cpp
void eventlog_init() {
  Events::init();
}
```

**Events::init()**（`events.cpp:65-72`，8 行）：

```cpp
void Events::init() {
  if (LogEvents) {
    _messages = new StringEventLog("Events");
    _exceptions = new ExtendedStringEventLog("Internal exceptions");
    _redefinitions = new StringEventLog("Classes redefined");
    _deopt_messages = new StringEventLog("Deoptimization events");
  }
}
```

**4 个 EventLog 类型和内容**：

| 日志对象 | 类型 | 记录内容 |
|---------|------|---------|
| `_messages` | `StringEventLog` | VM 操作、类加载、GC 触发 |
| `_exceptions` | `ExtendedStringEventLog` | JVM 内部异常 + PC + 线程信息 |
| `_redefinitions` | `StringEventLog` | JVMTI 类重定义事件 |
| `_deopt_messages` | `StringEventLog` | C2 去优化原因（如 "unstable_if", "class_check"） |

**EventLog 的全局链表**（`events.cpp:42-49`）：

```cpp
EventLog::EventLog() {
  ThreadCritical tc;
  _next = Events::_logs;
  Events::_logs = this;  // 头插法注册到全局单链表
}
```

每个 EventLog 构造时自动注册到全局链表——`Events::print_all()` 遍历此链表在 JVM crash 时打印所有事件日志。ThreadCritical 而非 Mutex 保护（因为此时 Mutex 尚未初始化）。

**追问**：为什么 `_exceptions` 用 `ExtendedStringEventLog` 而非普通 `StringEventLog`？→ 内部异常需要记录异常类型 + 发生位置 + 线程信息。`ExtendedStringEventLog` 额外存储 PC 和线程 ID，帮助定位异常来源。

### 1.4 chunkpool_init() → ChunkPool::initialize() — 4 ChunkPool

`arena.cpp:155-157` 是外部入口：

```cpp
void chunkpool_init() {
  ChunkPool::initialize();
}
```

**ChunkPool::initialize()**（`arena.cpp:134-139`，6 行）：

```cpp
static void initialize() {
  _large_pool  = new ChunkPool(Chunk::size        + Chunk::aligned_overhead_size());
  _medium_pool = new ChunkPool(Chunk::medium_size + Chunk::aligned_overhead_size());
  _small_pool  = new ChunkPool(Chunk::init_size   + Chunk::aligned_overhead_size());
  _tiny_pool   = new ChunkPool(Chunk::tiny_size   + Chunk::aligned_overhead_size());
}
```

**Chunk 尺寸常量**（`arena.hpp:55-70`）：

```cpp
enum {
#ifdef _LP64
  slack = 40,
#else
  slack = 20,
#endif
  tiny_size  =  256  - slack,   // LP64: 216 bytes
  init_size  =  1*K  - slack,   // LP64: 984 bytes
  medium_size= 10*K  - slack,   // LP64: 10160 bytes
  size       = 32*K  - slack,   // LP64: 32728 bytes
};
```

**ChunkPool 四级体系**：

| 池 | 大小 (LP64) | 用途 |
|----|:---:|------|
| `_tiny_pool` | ~256B | 微小临时分配（如符号表条目、方法签名字符串） |
| `_small_pool` | ~1KB | 小块分配（如单个方法的常量池缓存条目） |
| `_medium_pool` | ~10KB | 中块分配（如整个方法的解析数据） |
| `_large_pool` | ~32KB | 大块分配（如类文件的解析缓冲区） |

**ChunkPool 分配逻辑**（`arena.cpp:70-84`）：

```cpp
void* allocate(size_t bytes, AllocFailType alloc_failmode) {
  void* p = NULL;
  { ThreadCritical tc;
    _num_used++;
    p = get_first();          // 从池中取空闲 chunk
  }
  if (p == NULL) p = os::malloc(bytes, mtChunk, CURRENT_PC);  // 池空则 malloc
  return p;
}
```

**Chunk 释放逻辑**（`arena.cpp:87-96`）——归还到池而非 free()：

```cpp
void free(Chunk* chunk) {
  ThreadCritical tc;
  _num_used--;
  chunk->set_next(_first);   // 头插法归还到池
  _first = chunk;
  _num_chunks++;
}
```

**定期清理**（`arena.cpp:141-147`）——每 5 秒保留 5 个 chunk，多余 free()：

```cpp
static void clean() {
  enum { BlocksToKeep = 5 };
  _tiny_pool->free_all_but(BlocksToKeep);
  _small_pool->free_all_but(BlocksToKeep);
  _medium_pool->free_all_but(BlocksToKeep);
  _large_pool->free_all_but(BlocksToKeep);
}
```

**追问**：为什么需要 4 个不同大小的池？→ Arena 分配器根据请求大小选择最合适的池——小于 256B 从 tiny 池取，256B-1KB 从 small 池取，1KB-10KB 从 medium 池取，>10KB 从 large 池取。四级池减少内部碎片——如果只有一个大池，分配 100 字节也需要消耗 32KB 的 chunk。

**反事实**：如果 ChunkPool 不存在，Arena 直接 malloc/free？→ malloc/free 每次调用涉及 libc 的堆管理（brk/mmap + freelist 遍历）。ChunkPool 是 JVM 内部的 freelist——chunk 归还时不 free()，保留在池中供下次使用。JVM 启动期间 ~100 次 Arena 分配 → malloc/free 路径 ~500µs vs ChunkPool 路径 ~50µs → 10× 加速。

### 1.5 SuspendibleThreadSet_init() — GC 线程挂起协调

`suspendibleThreadSet.cpp:39-42`（4 行）：

```cpp
void SuspendibleThreadSet_init() {
  assert(_synchronize_wakeup == NULL, "STS already initialized");
  _synchronize_wakeup = new Semaphore();
}
```

**Semaphore 的使用场景**——GC 并发标记阶段的线程协调：

- `SuspendibleThreadSet::synchronize()` 中：`_synchronize_wakeup->wait()` — VM 线程等待所有可挂起线程 yield/leave
- `SuspendibleThreadSet::desynchronize()` 中：`MonitorLockerEx::notify_all()` 唤醒所有阻塞线程
- `SuspendibleThreadSet::yield()` 中：当最后一个线程 yield 时 `_synchronize_wakeup->signal()` 唤醒 VM 线程

**追问**：哪些线程是可挂起的？→ 编译器线程（C1/C2 CompilerThread）、引用处理线程、G1 并发精炼线程。这些线程在 GC 并发标记的特定阶段需要被挂起（如 SATB 队列处理、remark 阶段）。Java 应用线程不需要此机制——它们通过 safepoint 挂起。

**反事实**：如果 Semaphore 未创建 → signal() 操作空指针 → SIGSEGV → JVM crash。此场景只可能在 `vm_init_globals()` 未调用或 Semaphore 创建失败（OOM）时发生。assert 守卫在 debug 构建中捕获重复初始化。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/utilities/globalDefinitions.cpp` — basic_types_init() (:53)
- `src/hotspot/share/utilities/globalDefinitions.hpp` — 基本类型 typedef, heapOopSize 声明
- `src/hotspot/share/utilities/events.cpp` — eventlog_init() (:74), Events::init() (:65)
- `src/hotspot/share/memory/arena.cpp` — chunkpool_init() (:155), ChunkPool::initialize() (:134)
- `src/hotspot/share/gc/shared/suspendibleThreadSet.cpp` — SuspendibleThreadSet_init() (:39)
- `src/hotspot/share/runtime/init.cpp` — vm_init_globals() (:95)

Build: `make jdk`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **globalDefinitions.cpp** | `src/hotspot/share/utilities/globalDefinitions.cpp` | 368 | `basic_types_init()`(:53) | 类型大小验证 + oop 大小设置 |
| 2 | **globalDefinitions.hpp** | `src/hotspot/share/utilities/globalDefinitions.hpp` | 1405 | typedef, heapOopSize 声明 | 基本类型定义 |
| 3 | **events.cpp** | `src/hotspot/share/utilities/events.cpp` | ~100 | `eventlog_init()`(:74), `Events::init()`(:65) | 事件日志初始化 |
| 4 | **arena.cpp** | `src/hotspot/share/memory/arena.cpp` | ~300 | `chunkpool_init()`(:155), `ChunkPool::initialize()`(:134) | ChunkPool 初始化 |
| 5 | **suspendibleThreadSet.cpp** | `src/hotspot/share/gc/shared/suspendibleThreadSet.cpp` | ~150 | `SuspendibleThreadSet_init()`(:39) | 可挂起线程集初始化 |

---

## §四 ★★★ 5 Beginner Callout 框

> **1. basic_types_init 是 JVM 的 ABI 校准器**: 125 行代码中 30+ 个 assert 验证 C++ 基本类型大小与 JVM 预期一致。`sizeof(jint) != 4` 意味着 `jint` 的定义在某处被错误覆盖 → 所有 Java int 操作（数组索引、位运算、分支）都会产生错误结果。这些 assert 在 release 构建中被编译为空——但它们在 debug 构建中捕获了无数 ABI 回归。

> **2. UseCompressedOops 对 oop 大小的影响**: `basic_types_init()` at `globalDefinitions.cpp:161-176` 是 JVM 中唯一根据 `UseCompressedOops` 设置 `heapOopSize` 的地方。当 `UseCompressedOops=true`：`heapOopSize = 4`（narrowOop），`BytesPerHeapOop = 4`，`BitsPerHeapOop = 32`。当 `UseCompressedOops=false`：`heapOopSize = 8`（oop），`BytesPerHeapOop = 8`，`BitsPerHeapOop = 64`。这些值影响所有数组分配、对象头大小计算、GC 指针压缩逻辑。

> **3. ChunkPool 的四级大小体系**: `ChunkPool::initialize()` at `arena.cpp:134` 创建 4 个池——large（Chunk::size + aligned_overhead，LP64 ~32KB）、medium（Chunk::medium_size + overhead，LP64 ~10KB）、small（Chunk::init_size + overhead，LP64 ~1KB）、tiny（Chunk::tiny_size + overhead，LP64 ~256B）。每个池是一个单向链表（`_first` 指针），chunk 释放时归还到对应池中（而非 free()），减少 malloc/free 开销。`ChunkPoolCleaner` 每 5 秒清理多余 chunk（每个池保留 5 个）。

> **4. EventLog 不是 Java 日志**: `Events::init()` at `events.cpp:65` 创建的 4 个 `EventLog` 对象是 C++ 对象（`CHeapObj<mtInternal>`），记录 JVM 内部操作。它们通过 `Events::log()` 宏记录事件，`jcmd VM.events` 读取。与 Java 的 `java.util.logging` 完全独立——记录的是 JVM 层面的事件（class loading, deoptimization, GC trigger），不是应用层面的事件。每个 EventLog 构造时通过头插法自动注册到全局链表 `Events::_logs`——JVM crash 时 `Events::print_all()` 遍历打印所有事件。

> **5. SuspendibleThreadSet 的 Semaphore 协调**: `SuspendibleThreadSet` 是 GC 并发标记期间用于挂起/恢复非 Java 线程的机制。`_synchronize_wakeup` 信号量在 `SuspendibleThreadSet::synchronize()` 中 wait()，在最后一个线程 `yield()` 时 signal()。`desynchronize()` 通过 `MonitorLockerEx::notify_all()` 唤醒所有阻塞线程。这是 G1/Shenandoah/ZGC 并发标记阶段线程协调的基础设施——没有这个信号量，并发标记无法安全地挂起编译器线程和引用处理线程。

---

## §五 ★★★ 类型系统验证 + 优先级映射 + oop 大小

### 5.1 30+ assert 的完整清单

| 类别 | 断言 | 含义 |
|------|------|------|
| LP64 | `sizeof(intx) == 8` | intx 是 64-bit |
| LP64 | `sizeof(jobject) == 8` | jobject 是 64-bit |
| 基本类型 | `sizeof(jbyte) == 1` | jbyte 是 1 字节 |
| 基本类型 | `sizeof(jchar) == 2` | jchar 是 2 字节 |
| 基本类型 | `sizeof(jshort) == 2` | jshort 是 2 字节 |
| 基本类型 | `sizeof(juint) == 4` | juint 是 4 字节 |
| 基本类型 | `sizeof(jint) == 4` | jint 是 4 字节 |
| 基本类型 | `sizeof(jboolean) == 1` | jboolean 是 1 字节 |
| 基本类型 | `sizeof(jlong) == 8` | jlong 是 8 字节 |
| 基本类型 | `sizeof(jfloat) == 4` | jfloat 是 4 字节 |
| 基本类型 | `sizeof(jdouble) == 8` | jdouble 是 8 字节 |
| 基本类型 | `sizeof(u1) == 1, u2 == 2, u4 == 4` | uN 类型大小正确 |
| 一致性 | `wordSize == BytesPerWord == HeapWordSize` | 三种 word 大小定义一致 |
| 映射 | `type2char ↔ char2type` 双向 | 11 个 BasicType 映射正确 |
| 映射 | `type2field[vt]` 自映射或同大小 | 布局类型映射正确 |
| 幂 | `HeapWordSize` 是 2 的幂 | 对齐运算保证 |
| 最小 | `HeapWordSize >= sizeof(juint)` | 至少 4 字节 |

### 5.2 type2char/char2type 双向映射验证

`type2char_tab`（`globalDefinitions.cpp:181`）：

```cpp
char type2char_tab[T_CONFLICT+1] = { 0,0,0,0, 'Z','C','F','D','B','S','I','J','L','[','V',0,0,0,0,0 };
```

验证循环（:86-94）：遍历 0-98，对每个非零映射检查 `char2type(type2char(i)) == i`——确保双向映射无歧义。

### 5.3 Java 优先级 → OS 优先级映射表

| Java 优先级 | 默认 Linux nice 值 | 含义 |
|:---:|:---:|------|
| 1 (MinPriority) | 4 | 最低 |
| 2 | 3 | |
| 3 | 2 | |
| 4 | 1 | |
| 5 (NormPriority) | 0 | 默认 |
| 6 | -1 | |
| 7 | -2 | |
| 8 | -3 | |
| 9 (NearMaxPriority) | -4 | VMThread |
| 10 (MaxPriority) | -5 | WatcherThread |

`basic_types_init()` 中 10 个条件赋值（:137-156）允许通过 JVM 参数 `JavaPriorityN_To_OSPriority` 覆盖默认值。`UseCriticalJavaThreadPriority` 时 MaxPriority 提升到 CriticalPriority 级别。

### 5.4 UseCompressedOops → heapOopSize 设置

| 变量 | CompressedOops=true | CompressedOops=false |
|------|:---:|:---:|
| `heapOopSize` | 4 (jintSize) | 8 (oopSize=sizeof(char*)) |
| `BytesPerHeapOop` | 4 (BytesPerInt) | 8 (BytesPerWord) |
| `BitsPerHeapOop` | 32 (BitsPerInt) | 64 (BitsPerWord) |
| `LogBytesPerHeapOop` | 2 | 3 |
| `LogBitsPerHeapOop` | 5 | 6 |

### 5.5 _type2aelembytes 的数组元素大小设置

`_type2aelembytes` 数组（`globalDefinitions.cpp:265-286`）在编译时初始化，运行时 `basic_types_init()` 末尾（:175-176）覆盖 T_OBJECT/T_ARRAY 条目为 `heapOopSize`：

```cpp
_type2aelembytes[T_OBJECT] = heapOopSize;
_type2aelembytes[T_ARRAY]  = heapOopSize;
```

其余条目不变：T_BOOLEAN=1, T_CHAR=2, T_FLOAT=4, T_DOUBLE=8, T_BYTE=1, T_SHORT=2, T_INT=4, T_LONG=8。

---

## §六 ★★ ChunkPool + EventLog + SuspendibleThreadSet

### 6.1 ChunkPool 四级体系

| 池 | Chunk 大小 (LP64) | 池大小 (含 overhead) | 用途 |
|----|:---:|:---:|------|
| `_tiny_pool` | 216B | ~256B | 微小临时分配 |
| `_small_pool` | 984B | ~1KB | 小块分配 |
| `_medium_pool` | 10160B | ~10KB | 中块分配 |
| `_large_pool` | 32728B | ~32KB | 大块分配 |

### 6.2 Arena 分配器如何使用 ChunkPool

`Chunk::operator new`（`arena.cpp:182-202`）按 length 路由到对应池：

```cpp
void* Chunk::operator new(size_t requested_size, AllocFailType alloc_failmode, size_t length) throw() {
  size_t bytes = ARENA_ALIGN(requested_size) + length;
  switch (length) {
   case Chunk::size:        return ChunkPool::large_pool()->allocate(bytes, alloc_failmode);
   case Chunk::medium_size: return ChunkPool::medium_pool()->allocate(bytes, alloc_failmode);
   case Chunk::init_size:   return ChunkPool::small_pool()->allocate(bytes, alloc_failmode);
   case Chunk::tiny_size:   return ChunkPool::tiny_pool()->allocate(bytes, alloc_failmode);
   default:                 return os::malloc(bytes, mtChunk, CALLER_PC);  // 非标准大小
  }
}
```

只有 4 种标准尺寸走池，其他尺寸直接 os::malloc。`Chunk::operator delete`（:204-215）对称地按 length 归还到对应池。

### 6.3 4 个 EventLog 的记录内容

| 日志 | 记录时机 | 典型内容 |
|------|---------|---------|
| `_messages` | VM 操作触发时 | "GC triggered", "class loading: java.lang.String" |
| `_exceptions` | JVM 内部异常 | "ClassCastException at pc=0x..., thread=0x..." |
| `_redefinitions` | JVMTI 类重定义 | "Redefining com/example/Foo" |
| `_deopt_messages` | C2 去优化 | "unstable_if at bci=42", "class_check failed" |

### 6.4 Semaphore 在并发标记中的使用时机

```
synchronize():  VM 线程调用 → 设置 _suspend_all=true → _synchronize_wakeup->wait()
yield():        编译器线程调用 → _nthreads_stopped++ → 最后一个线程 signal()
desynchronize(): VM 线程调用 → _suspend_all=false → notify_all() 唤醒所有等待线程
```

---

## §七 ★ GDB 断点验证 — 6 断点

```
断言 1: sizeof 验证 (globalDefinitions.cpp:84)
  (gdb) break globalDefinitions.cpp:84
  (gdb) run
  (gdb) print sizeof(jint) → 期望: 4
  (gdb) print sizeof(jlong) → 期望: 8
  (gdb) print sizeof(oop) → 期望: 8 (LP64, 非压缩)

断言 2: UseCompressedOops → heapOopSize (globalDefinitions.cpp:168)
  (gdb) break globalDefinitions.cpp:168
  (gdb) print UseCompressedOops → 期望: true
  (gdb) continue
  (gdb) print heapOopSize → 期望: 4

断言 3: EventLog 创建 (events.cpp:65)
  (gdb) break events.cpp:65
  (gdb) print LogEvents → 期望: true
  (gdb) continue
  (gdb) print Events::_messages → 期望: 非 NULL

断言 4: ChunkPool 创建 (arena.cpp:134)
  (gdb) break arena.cpp:134
  (gdb) continue
  (gdb) print ChunkPool::_large_pool → 期望: 非 NULL
  (gdb) print ChunkPool::_large_pool->_size → 期望: ~32768

断言 5: Semaphore 创建 (suspendibleThreadSet.cpp:39)
  (gdb) break suspendibleThreadSet.cpp:39
  (gdb) continue
  (gdb) print _synchronize_wakeup → 期望: 非 NULL

断言 6: 优先级映射 (globalDefinitions.cpp:156)
  (gdb) break globalDefinitions.cpp:156
  (gdb) print os::java_to_os_priority[1] → 期望: 19 (Linux 最低)
  (gdb) print os::java_to_os_priority[5] → 期望: 0 (NORM)
  (gdb) print os::java_to_os_priority[10] → 期望: -5 (最高)
```

---

## §八 ★ Cross-Reference

- **06-Mutex** — vm_init_globals 中的另一个调用（mutex_init），在 basic_types_init 和 chunkpool_init 之后——锁系统需要基本类型验证通过才能安全创建
- **07-PerfMemory** — vm_init_globals 中的另一个调用（perfMemory_init），在 mutex_init 之后——PerfMemory 创建需要锁保护
- **13-Management-Services** — init_globals 的第一个调用，此时 vm_init_globals 创建的所有基础设施已就绪

---

## §九 诊断工具

- **jcmd `<pid>` VM.events** — 验证事件日志有内容
- **GDB: `print heapOopSize`** — 验证 oop 大小设置
- **GDB: `print ChunkPool::_large_pool->_num_chunks`** — 验证 chunk 使用量
- **GDB: `print os::java_to_os_priority[5]`** — 验证 Java 优先级映射
- **strace `-e brk,mmap`** — 验证 ChunkPool 首次分配时从 OS 获取内存的系统调用（`Chunk::operator new` → `os::malloc` → `brk`/`mmap`）
- **/proc/`<pid>`/maps** — 验证 Arena/ChunkPool 的 C-Heap 映射区域（`[heap]` 段）
- **jstack `<pid>`** — 验证 SuspendibleThreadSet 中阻塞的编译器/引用处理线程（并发标记阶段 `SuspendibleThreadSet::synchronize()` 中显示为 `waiting on Semaphore`）

---

## 附录: Writing Requirements 对照表（参见 §六）

| 不要写成 | 应该写成 |
|---------|---------|
| "basic_types_init 验证类型大小" | "basic_types_init() at globalDefinitions.cpp:53 (125 行) 包含 4 个 assert 块——Block 1 (:54-84) 验证 sizeof(jbyte)=1..sizeof(jdouble)=8 等 15 个基本类型大小，Block 2 (:86-93) 验证 type2char/char2type 双向映射，Block 3 (:96-128) 验证 type2field 布局类型，Block 4 (:129-134) 验证 HeapWordSize 是 2 的幂。运行时赋值 (:137-176) 设置 Java 优先级→OS 优先级映射 + UseCompressedOops 下 heapOopSize=4/BytesPerHeapOop=4/BitsPerHeapOop=32" |
| "chunkpool_init 创建 ChunkPool" | "ChunkPool::initialize() at arena.cpp:134 (6 行) 创建 4 个 ChunkPool——_large_pool (Chunk::size+overhead ~32KB), _medium_pool (~10KB), _small_pool (~1KB), _tiny_pool (~256B)——每个含 _first(NULL)/_num_chunks(0)/_num_used(0)。Chunk::operator new 按 length 路由到对应池，释放时归还到池中（而非 free()），ChunkPoolCleaner 每 5s 清理保留 5 个" |
| "eventlog_init 创建事件日志" | "Events::init() at events.cpp:65 (8 行) 在 LogEvents=true 时创建 4 个 EventLog——_messages (StringEventLog, VM 操作/类加载/GC), _exceptions (ExtendedStringEventLog, 内部异常+PC+线程), _redefinitions (StringEventLog, JVMTI 类重定义), _deopt_messages (StringEventLog, C2 去优化原因)——每个通过 EventLog 构造函数的头插法注册到全局链表 _logs" |
| "SuspendibleThreadSet_init 创建 Semaphore" | "SuspendibleThreadSet_init() at suspendibleThreadSet.cpp:39 (4 行) 创建 _synchronize_wakeup = new Semaphore()——在 SuspendibleThreadSet::synchronize() 中 wait()，最后一个 yield() 线程 signal()，desynchronize() 中 notify_all()——用于 G1/Shenandoah/ZGC 并发标记阶段挂起/恢复编译器线程和引用处理线程" |
