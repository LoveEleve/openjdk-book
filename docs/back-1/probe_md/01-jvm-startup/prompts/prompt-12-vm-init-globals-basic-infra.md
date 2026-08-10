# PROMPT: 请撰写 12-vm-init-globals-basic-infra.md

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

`eventlog_init()` (`events.cpp:74`) 创建 4 个 `EventLog` 对象：`_events` (JVM 操作日志)、`_exceptions` (内部异常)、`_redefinitions` (类重定义)、`_deopt_messages` (逆优化)。但如果 `LogEvents=false`（`-XX:-LogEvents`），这些对象不创建 → `jcmd VM.events` 无输出。

### 场景 3: GC safepoint 中线程无法被挂起

```
# JVM 日志
[warning] SuspendibleThreadSet::join() timed out
```

`SuspendibleThreadSet_init()` (`suspendibleThreadSet.cpp:39`) 创建 `_synchronize_wakeup = new Semaphore()`——用于在 GC 并发标记期间唤醒等待同步的可挂起线程。如果此信号量未创建 → `SuspendibleThreadSet::synchronize()` 中的 `_synchronize_wakeup->signal()` 操作空指针 → SIGSEGV。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the FOUR vm_init_globals() calls (in `vm_init_globals()` at `init.cpp:95`, NOT `init_globals()` at `init.cpp:109`) that establish the JVM's absolute lowest-level infrastructure. These calls run BEFORE `init_globals()` and create the foundation that `init_globals()`'s 31 calls depend on:

- `basic_types_init()` — type size validation + oop size + priority mapping (125 lines)
- `eventlog_init()` — 4 EventLog objects (internal events/exceptions/redefinitions/deoptimizations)
- `chunkpool_init()` — 4 ChunkPool instances (large/medium/small/tiny) for Arena allocator
- `SuspendibleThreadSet_init()` — 1 Semaphore for GC suspend/resume coordination

Reader completed **06-Mutex** (mutex_init, another vm_init_globals call), **07-PerfMemory** (perfMemory_init). This doc: **how the JVM validates its own ABI assumptions, creates the Arena allocation pool system, initializes internal event logging, and sets up GC thread suspension infrastructure — all before a single Java object exists**.

### Interview Story Format Answer（必须出现在 §一 末尾）

"`vm_init_globals()` at `init.cpp:95` runs BEFORE `init_globals()` at `init.cpp:109`. `basic_types_init()` at `globalDefinitions.cpp:53` (125 lines) is the longest function in vm_init_globals — it validates 30+ type size assertions (jbyte=1, jint=4, jlong=8, intx=8 on LP64), verifies `type2char`/`char2type` bidirectional mapping tables, checks that `HeapWordSize` is a power of 2, maps Java thread priorities 1-10 to OS priorities via 10 conditional assignments to `os::java_to_os_priority[]`, and sets `heapOopSize`/`BytesPerHeapOop`/`BitsPerHeapOop` based on `UseCompressedOops` — the single function that calibrates the JVM's understanding of its own runtime environment. `eventlog_init()` at `events.cpp:74` (3 lines, delegates to `Events::init()` 8 lines) conditionally creates 4 `StringEventLog` objects (if `LogEvents=true`, default): `_events` (VM operations, class loading, GC), `_exceptions` (internal JVM exceptions like `ClassCastException` in unsafe code), `_redefinitions` (JVMTI class redefinition events), `_deopt_messages` (C2 deoptimization reasons). `chunkpool_init()` at `arena.cpp:155` (3 lines, delegates to `ChunkPool::initialize()` 6 lines) creates 4 `ChunkPool` instances — `_large_pool` (chunks of `Chunk::size + overhead`), `_medium_pool` (`Chunk::medium_size + overhead`), `_small_pool` (`Chunk::init_size + overhead`), `_tiny_pool` (`Chunk::tiny_size + overhead`) — each pool is a free list of pre-allocated memory chunks that the Arena allocator uses for bump-pointer allocation. `SuspendibleThreadSet_init()` at `suspendibleThreadSet.cpp:39` (4 lines) creates `_synchronize_wakeup = new Semaphore()` — used by `SuspendibleThreadSet::synchronize()` to wake up GC-suspendible threads when concurrent marking completes. The key architectural insight: these 4 calls create zero Java objects, zero CodeCache allocations, zero Metaspace usage — they are pure C++ infrastructure that validates the execution environment and creates the memory allocation pools that `init_globals()`'s 31 calls will use."

### Beginner Callout Boxes（文档中必须出现的 5 个 callout 框）

1. **basic_types_init 是 JVM 的 ABI 校准器**：125 行代码中 30+ 个 assert 验证 C++ 基本类型大小与 JVM 预期一致。`sizeof(jint) != 4` 意味着 `jint` 的定义在某处被错误覆盖 → 所有 Java int 操作（数组索引、位运算、分支）都会产生错误结果。这些 assert 在 release 构建中被编译为空——但它们在 debug 构建中捕获了无数 ABI 回归。

2. **UseCompressedOops 对 oop 大小的影响**：`basic_types_init()` 第 161-176 行是 JVM 中唯一根据 `UseCompressedOops` 设置 `heapOopSize` 的地方。当 `UseCompressedOops=true`：`heapOopSize = 4`（narrowOop），`BytesPerHeapOop = 4`，`BitsPerHeapOop = 32`。当 `UseCompressedOops=false`：`heapOopSize = 8`（oop），`BytesPerHeapOop = 8`，`BitsPerHeapOop = 64`。这些值影响所有数组分配、对象头大小计算、GC 指针压缩逻辑。

3. **ChunkPool 的四级大小体系**：`ChunkPool::initialize()` 创建 4 个池——large（`Chunk::size + aligned_overhead`，默认 8KB）、medium（`Chunk::medium_size + overhead`，默认 4KB）、small（`Chunk::init_size + overhead`，默认 2KB）、tiny（`Chunk::tiny_size + overhead`，默认 256B）。每个池是一个单向链表（`_first` 指针），chunk 释放时归还到对应池中（而非 free()），减少 malloc/free 开销。Arena 分配器从池中取 chunk 用于 bump-pointer 分配。

4. **EventLog 不是 Java 日志**：`Events::init()` 创建的 4 个 `EventLog` 对象是 C++ 对象（`CHeapObj<mtInternal>`），记录 JVM 内部操作。它们通过 `Events::log()` 宏记录事件，`jcmd VM.events` 读取。与 Java 的 `java.util.logging` 完全独立——记录的是 JVM 层面的事件（class loading, deoptimization, GC trigger），不是应用层面的事件。

5. **SuspendibleThreadSet 的 Semaphore 协调**：`SuspendibleThreadSet` 是 GC 并发标记期间用于挂起/恢复非 Java 线程的机制。`_synchronize_wakeup` 信号量在 `SuspendibleThreadSet::synchronize()` 中等待，在 `SuspendibleThreadSet::desynchronize()` 中 signal。这是 G1/Shenandoah/ZGC 并发标记阶段线程协调的基础设施——没有这个信号量，并发标记无法安全地挂起编译器线程和引用处理线程。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/utilities/globalDefinitions.cpp` — basic_types_init() (:53)
- `src/hotspot/share/utilities/globalDefinitions.hpp` — 基本类型 typedef (jint, jlong, intx 等)
- `src/hotspot/share/utilities/events.cpp` — eventlog_init() (:74), Events::init() (:65)
- `src/hotspot/share/utilities/events.hpp` — Events 类 + EventLog 类
- `src/hotspot/share/memory/arena.cpp` — chunkpool_init() (:155), ChunkPool::initialize() (:134)
- `src/hotspot/share/memory/arena.hpp` — Arena, Chunk, ChunkPool 类
- `src/hotspot/share/gc/shared/suspendibleThreadSet.cpp` — SuspendibleThreadSet_init() (:39)
- `src/hotspot/share/gc/shared/suspendibleThreadSet.hpp` — SuspendibleThreadSet 类
- `src/hotspot/share/runtime/init.cpp` — vm_init_globals() (:95)

Build: `make jdk`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **globalDefinitions.cpp** | `src/hotspot/share/utilities/globalDefinitions.cpp` | ~200 | `basic_types_init()`(:53) | 类型大小验证 + oop 大小设置 |
| 2 | **globalDefinitions.hpp** | `src/hotspot/share/utilities/globalDefinitions.hpp` | ~500 | typedef, heapOopSize 声明 | 基本类型定义 |
| 3 | **events.cpp** | `src/hotspot/share/utilities/events.cpp` | ~200 | `eventlog_init()`(:74), `Events::init()`(:65) | 事件日志初始化 |
| 4 | **arena.cpp** | `src/hotspot/share/memory/arena.cpp` | ~600 | `chunkpool_init()`(:155), `ChunkPool::initialize()`(:134) | ChunkPool 初始化 |
| 5 | **suspendibleThreadSet.cpp** | `src/hotspot/share/gc/shared/suspendibleThreadSet.cpp` | ~100 | `SuspendibleThreadSet_init()`(:39) | 可挂起线程集初始化 |

---

## §四 Deep Dive Question Groups（≥5 组，每组含 counterfactual）

### 4.1 ★★★ basic_types_init() — 类型大小验证

```
问题：
  ① basic_types_init() (globalDefinitions.cpp:53-177, 125 行) 验证了哪些类型假设？
      答案方向: 源码展示 4 个 assert 块：
        Block 1 (:54-84): 验证所有基本类型大小
          sizeof(jbyte)=1, jchar=2, jshort=2, jint=4, jboolean=1
          sizeof(jlong)=8, jfloat=4, jdouble=8
          sizeof(u1)=1, u2=2, u4=4
          wordSize == BytesPerWord == HeapWordSize
        
        Block 2 (:86-93): 验证 type2char/char2type 双向映射
          11 个 BasicType (T_BOOLEAN..T_VOID) 的 char 映射正确
        
        Block 3 (:96-128): 验证 type2field 映射
          每个 BasicType 正确映射到布局类型，同类型大小一致
        
        Block 4 (:129-134): 验证 HeapWordSize 是 2 的幂 + >= sizeof(juint)
        
        运行时赋值 (:137-176):
        JavaPriority1_To_OSPriority ~ JavaPriority10_To_OSPriority
        → os::java_to_os_priority[1..10]
        
        if (UseCompressedOops) {
          heapOopSize = sizeof(narrowOop);  // 4
          BytesPerHeapOop = 4;
          BitsPerHeapOop = 32;
        } else {
          heapOopSize = sizeof(oop);        // 8
          BytesPerHeapOop = 8;
          BitsPerHeapOop = 64;
        }
        _type2aelembytes[T_OBJECT] = heapOopSize;
        _type2aelembytes[T_ARRAY]  = heapOopSize;
      
      追问: 为什么 type2aelembytes[T_OBJECT] 和 [T_ARRAY] 需要根据 UseCompressedOops 设置？
      → aelembytes = array element bytes。Object[] 中每个元素是 oop 引用——压缩时 4 字节，
        非压缩时 8 字节。ArrayKlass::array_klass() 使用此值计算数组大小。

  ② Counterfactual: 如果 UseCompressedOops 的设置与 heapOopSize 不一致？
      答案方向: UseCompressedOops=true 但 heapOopSize=8 → 指针压缩逻辑使用 8 字节 oop
        但编码为 4 字节 → 解码时丢失高 32 位 → 指针指向错误地址 → SIGSEGV。
        这就是为什么 basic_types_init 集中设置这些值——确保所有相关变量一致。
```

### 4.2 ★★ eventlog_init() — 事件日志

```
问题：
  ① eventlog_init() (events.cpp:74-76, 3 行) 创建了哪些 EventLog？
      答案方向: Events::init() (events.cpp:65-72, 8 行)：
        if (LogEvents) {
          _events        = new StringEventLog("Events");
          _exceptions    = new ExtendedStringEventLog("Internal exceptions");
          _redefinitions = new StringEventLog("Classes redefined");
          _deopt_messages= new StringEventLog("Deoptimization events");
        }
        
        每个 EventLog 是固定大小的环形缓冲区（默认 100 条记录）。
        _exceptions 使用 ExtendedStringEventLog（记录更多上下文信息）。
        _deopt_messages 记录 C2 去优化的原因（如 "unstable_if", "class_check"）。
      
      追问: 为什么 _exceptions 用 ExtendedStringEventLog 而非普通 StringEventLog？
      → 内部异常需要记录异常类型 + 发生位置 + 线程信息。ExtendedStringEventLog
        额外存储 PC 和线程 ID，帮助定位异常来源。

  ② Counterfactual: 如果 LogEvents=false，eventlog_init 跳过所有创建？
      答案方向: jcmd VM.events 返回空列表——但 JVM 正常运行。EventLog 是诊断工具，
        不是 JVM 运行的必要条件。生产环境中 -XX:-LogEvents 可节省 ~4KB C-Heap 内存。
```

### 4.3 ★★ chunkpool_init() — Arena 分配器前置

```
问题：
  ① chunkpool_init() (arena.cpp:155-157, 3 行) 创建了哪些 ChunkPool？
      答案方向: ChunkPool::initialize() (arena.cpp:134-139, 6 行)：
        _large_pool  = new ChunkPool(Chunk::size + aligned_overhead);          // ~8KB
        _medium_pool = new ChunkPool(Chunk::medium_size + aligned_overhead);   // ~4KB
        _small_pool  = new ChunkPool(Chunk::init_size + aligned_overhead);     // ~2KB
        _tiny_pool   = new ChunkPool(Chunk::tiny_size + aligned_overhead);     // ~256B
        
        每个 ChunkPool 包含: _size（块大小）, _first（链表头=NULL）, _num_chunks=0, _num_used=0。
        Arena 分配器从对应大小的池中取 chunk，释放时归还到池中（而非 free()）。
      
      追问: 为什么需要 4 个不同大小的池？
      → Arena 分配器根据请求大小选择最合适的池——小于 256B 从 tiny 池取，256B-2KB 从 small 池取，
        2KB-4KB 从 medium 池取，>4KB 从 large 池取。四级池减少内部碎片。

  ② Counterfactual: 如果 ChunkPool 不存在，Arena 直接 malloc/free？
      答案方向: malloc/free 每次调用涉及 libc 的堆管理（brk/mmap + freelist 遍历）。
        ChunkPool 是 JVM 内部的 freelist——chunk 归还时不 free()，保留在池中供下次使用。
        JVM 启动期间 ~100 次 Arena 分配 → malloc/free 路径 ~500µs vs ChunkPool 路径 ~50µs。
        10× 加速。ChunkPool 的设计理念与 Netty 的 PooledByteBufAllocator 类似。
```

### 4.4 ★★ SuspendibleThreadSet_init() — GC 线程挂起协调

```
问题：
  ① SuspendibleThreadSet_init() (suspendibleThreadSet.cpp:39-42, 4 行) 创建了什么？
      答案方向: 
        void SuspendibleThreadSet_init() {
          assert(SuspendibleThreadSet::_synchronize_wakeup == NULL, ...);
          SuspendibleThreadSet::_synchronize_wakeup = new Semaphore();
        }
        
        一个 Semaphore 对象——用于并发标记阶段挂起/恢复线程的同步。
        SuspendibleThreadSet::synchronize() 中: _synchronize_wakeup->wait()
        SuspendibleThreadSet::desynchronize() 中: _synchronize_wakeup->signal()
      
      追问: 哪些线程是可挂起的？
      → 编译器线程（C1/C2 CompilerThread）、引用处理线程、G1 并发精炼线程。
        这些线程在 GC 并发标记的特定阶段需要被挂起（如 SATB 队列处理、remark 阶段）。
        Java 应用线程不需要此机制——它们通过 safepoint 挂起。

  ② Counterfactual: 如果 Semaphore 未创建？
      答案方向: signal() 操作空指针 → SIGSEGV → JVM crash。此场景只可能在
        vm_init_globals() 未调用或 Semaphore 创建失败（OOM）时发生。
        assert 守卫在 debug 构建中捕获重复初始化。
```

### 4.5 ★★ Java 线程优先级映射

```
问题：
  ① basic_types_init() 如何映射 Java 优先级 1-10 到 OS 优先级？
      答案方向: globalDefinitions.cpp:137-156：
        JavaPriority1_To_OSPriority 到 JavaPriority10_To_OSPriority
        → os::java_to_os_priority[1] 到 os::java_to_os_priority[10]
        
        Linux 默认映射: Java 1→19 (最低), Java 5→10 (NORM), Java 10→-5 (最高)
        这些是 Linux nice 值——范围 -20 到 19，默认 0。
        
        每个映射是条件赋值——允许通过 JVM 参数覆盖默认值。
      
      追问: 为什么 Java 优先级 1-10 而不是 1-100？
      → Java Thread.setPriority() 接受 1-10（MIN_PRIORITY=1, NORM_PRIORITY=5, MAX_PRIORITY=10）。
        这是 Java 规范定义的范围——历史原因（Java 1.0 的绿色线程模型）。
```

---

## §五 Article Structure

```
§〇 生产场景
  ★ 场景 1: UseCompressedOops 导致 crash（oop 大小不一致）
  ★ 场景 2: JVM 内部事件日志为空（LogEvents=false）
  ★ 场景 3: GC safepoint 中线程无法被挂起（Semaphore 未创建）
  每个场景: 真实症状 + 三步诊断 + 反事实讨论

§一 ★★★ vm_init_globals 4 调用全链路源码走读
  1.1 basic_types_init() — 30+ assert + 10 优先级映射 + oop 大小
  1.2 eventlog_init() → Events::init() — 4 EventLog (条件 LogEvents)
  1.3 chunkpool_init() → ChunkPool::initialize() — 4 ChunkPool (large/medium/small/tiny)
  1.4 SuspendibleThreadSet_init() — 1 Semaphore
  1.5 ★ 面试 Story Format 答案

§二 Standard Environment

§三 Source Files Table（5 个文件）

§四 ★★★ 5 Beginner Callout 框
  > **1. basic_types_init 是 JVM 的 ABI 校准器**
  > **2. UseCompressedOops 对 oop 大小的影响**
  > **3. ChunkPool 的四级大小体系**
  > **4. EventLog 不是 Java 日志**
  > **5. SuspendibleThreadSet 的 Semaphore 协调**

§五 ★★★ 类型系统验证 + 优先级映射 + oop 大小
  5.1 30+ assert 的完整清单表
  5.2 type2char/char2type 双向映射验证
  5.3 Java 优先级 → OS 优先级映射表（Linux nice 值）
  5.4 UseCompressedOops → heapOopSize/BytesPerHeapOop/BitsPerHeapOop
  5.5 _type2aelembytes 的数组元素大小设置

§六 ★★ ChunkPool + EventLog + SuspendibleThreadSet
  6.1 ChunkPool 四级体系（large/medium/small/tiny 的大小和用途）
  6.2 Arena 分配器如何使用 ChunkPool（bump-pointer + freelist）
  6.3 4 个 EventLog 的记录内容和 jcmd 读取
  6.4 Semaphore 在并发标记中的使用时机

§七 ★ GDB 断点验证 — 6 断点
  断言 1: globalDefinitions.cpp:84 — 验证 sizeof(jint)=4
  断言 2: globalDefinitions.cpp:168 — 验证 UseCompressedOops → heapOopSize
  断言 3: events.cpp:65 — 验证 LogEvents 条件和 EventLog 创建
  断言 4: arena.cpp:134 — 验证 ChunkPool::initialize() 4 池创建
  断言 5: suspendibleThreadSet.cpp:39 — 验证 Semaphore 创建
  断言 6: globalDefinitions.cpp:137 — 验证 JavaPriority1_To_OSPriority 映射

§八 ★ Cross-Reference
  ❓ 06-Mutex — vm_init_globals 中的另一个调用
  ❓ 07-PerfMemory — vm_init_globals 中的另一个调用
  ❓ 13-Management-Services — init_globals 第一个调用，使用 vm_init_globals 创建的基础设施

§九 诊断工具
  ❓ jcmd <pid> VM.events — 验证事件日志
  ❓ GDB: print heapOopSize — 验证 oop 大小
  ❓ GDB: print ChunkPool::_large_pool->_num_chunks — 验证 chunk 使用量
```

---

## §六 Writing Requirements

### "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "basic_types_init 验证类型大小" | "basic_types_init() at globalDefinitions.cpp:53 (125 行) 包含 4 个 assert 块——Block 1 (:54-84) 验证 sizeof(jbyte)=1..sizeof(jdouble)=8 等 15 个基本类型大小，Block 2 (:86-93) 验证 type2char/char2type 双向映射，Block 3 (:96-128) 验证 type2field 布局类型，Block 4 (:129-134) 验证 HeapWordSize 是 2 的幂。运行时赋值 (:137-176) 设置 Java 优先级→OS 优先级映射 + UseCompressedOops 下 heapOopSize=4/BytesPerHeapOop=4/BitsPerHeapOop=32" |
| "chunkpool_init 创建 ChunkPool" | "ChunkPool::initialize() at arena.cpp:134 (6 行) 创建 4 个 ChunkPool——_large_pool (Chunk::size+overhead ~8KB), _medium_pool (~4KB), _small_pool (~2KB), _tiny_pool (~256B)——每个含 _size/_first(NULL)/_num_chunks(0)/_num_used(0)。Arena 分配器根据请求大小从对应池取 chunk，释放时归还到池中（而非 free()）" |
| "eventlog_init 创建事件日志" | "Events::init() at events.cpp:65 (8 行) 在 LogEvents=true 时创建 4 个 EventLog——_events (StringEventLog, VM 操作/类加载/GC), _exceptions (ExtendedStringEventLog, 内部异常+PC+线程), _redefinitions (StringEventLog, JVMTI 类重定义), _deopt_messages (StringEventLog, C2 去优化原因)——每个是 ~100 条记录的环形缓冲区" |
| "SuspendibleThreadSet_init 创建 Semaphore" | "SuspendibleThreadSet_init() at suspendibleThreadSet.cpp:39 (4 行) 创建 _synchronize_wakeup = new Semaphore()——在 SuspendibleThreadSet::synchronize() 中 wait()，desynchronize() 中 signal()——用于 G1/Shenandoah/ZGC 并发标记阶段挂起/恢复编译器线程和引用处理线程" |

---

## §七 Output Format

- Markdown file, named `12-vm-init-globals-basic-infra.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/`
- 元信息头:
```
> **Phase**: 01-jvm-startup
> **前置**: [06-Mutex]（vm_init_globals 的 mutex_init）、[07-PerfMemory]（perfMemory_init）
> **配套**: [00-JNI-CreateJavaVM]（vm_init_globals 在 create_vm Stage 4 中的位置）
> **后续依赖本文**: [13-Management-Services]（init_globals 第一个调用，使用 vm_init_globals 创建的基础设施）
> **阅读收益**: 追踪 vm_init_globals 的 4 个调用——理解 basic_types_init 的 30+ assert ABI 校准（jbyte=1..jlong=8）+ UseCompressedOops → heapOopSize 设置、eventlog_init 的 4 EventLog（VM 事件/内部异常/类重定义/去优化）、chunkpool_init 的 4 ChunkPool（large~8KB/medium~4KB/small~2KB/tiny~256B）Arena 分配器前置、SuspendibleThreadSet_init 的 Semaphore GC 线程挂起协调；掌握 "UseCompressedOops 导致 crash" 和 "ChunkPool 加速 Arena 分配 10×" 的底层机制
```
- 目标行数: 600-800 lines
- Section 编号: `## §〇` 到 `## §九`（连续无跳号）

---

## §八 Prohibited（≥8）

- ❌ 只说 "basic_types_init 验证类型" 而不展示 4 个 assert 块的内容 → 必须从 globalDefinitions.cpp:53 源码开始
- ❌ 不展示 UseCompressedOops 对 heapOopSize 的影响 → 必须展示 3 个变量（heapOopSize/BytesPerHeapOop/BitsPerHeapOop）的设置
- ❌ 忽略 ChunkPool 的四级大小 → 必须列出 large/medium/small/tiny 的具体大小和用途
- ❌ 不解释 EventLog 与 Java 日志的区别 → 必须强调这是 C++ 内部日志，非 java.util.logging
- ❌ 忽略 Semaphore 在 GC 并发标记中的角色 → 必须展示 synchronize/desynchronize 的 wait/signal
- ❌ 不做 GDB 断点 trace → 至少 6 个断点
- ❌ 不要解释 C 语言基础

---

## §九 Required（≥8）

- ✅ **★ basic_types_init() 完整源码走读** — 125 行，4 assert 块 + 运行时赋值
- ✅ **★ UseCompressedOops → heapOopSize 设置** — 3 变量 + _type2aelembytes
- ✅ **★ ChunkPool 四级体系表** — large/medium/small/tiny 的大小和用途
- ✅ **★ Java 优先级 → OS 优先级映射表** — 10 个优先级 + Linux nice 值
- ✅ **★ 5 Beginner Callout 框** — `> **` 块引用格式
- ✅ **★ 面试 Story Format 答案** — §一末尾
- ✅ **★ GDB 断点 ≥6 条** — 精确到 file:line
- ✅ **★ "不要写成→应该写成"对照表** — §六 中 4 行对照

---

## §十 GDB Verification（≥6 assertions）

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
  (gdb) print Events::_events → 期望: 非 NULL

断言 4: ChunkPool 创建 (arena.cpp:134)
  (gdb) break arena.cpp:134
  (gdb) continue
  (gdb) print ChunkPool::_large_pool → 期望: 非 NULL
  (gdb) print ChunkPool::_large_pool->_size → 期望: 8192

断言 5: Semaphore 创建 (suspendibleThreadSet.cpp:39)
  (gdb) break suspendibleThreadSet.cpp:39
  (gdb) continue
  (gdb) print SuspendibleThreadSet::_synchronize_wakeup → 期望: 非 NULL

断言 6: 优先级映射 (globalDefinitions.cpp:137)
  (gdb) break globalDefinitions.cpp:156
  (gdb) print os::java_to_os_priority[1] → 期望: 19 (Linux 最低)
  (gdb) print os::java_to_os_priority[5] → 期望: 0 (NORM)
  (gdb) print os::java_to_os_priority[10] → 期望: -5 (最高)
```

---

## §十一 与 README 和同组文档的连续性

1. **从 README §vm_init_globals 承接**：本文展开 vm_init_globals 的第 2、3、5、7 次调用（basic_types_init, eventlog_init, chunkpool_init, SuspendibleThreadSet_init）。其余 3 个调用（check_ThreadShadow, mutex_init, perfMemory_init）分别在其他文档中覆盖。

2. **与 06-Mutex 的连接**：mutex_init 在 vm_init_globals 的第 4 次调用，在 basic_types_init 和 chunkpool_init 之后——锁系统需要基本类型验证通过才能安全创建。

3. **与 07-PerfMemory 的连接**：perfMemory_init 在 vm_init_globals 的第 6 次调用，在 mutex_init 之后——PerfMemory 创建需要锁保护。

4. **与 13-Management-Services 的连接**：management_init 是 init_globals 的第一个调用——此时 vm_init_globals 创建的所有基础设施（类型验证、ChunkPool、EventLog、Semaphore）已就绪。
