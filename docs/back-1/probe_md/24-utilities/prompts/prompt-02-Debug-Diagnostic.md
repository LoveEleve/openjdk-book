# prompt-02  Debug & Diagnostic — 崩溃报告、符号解码、事件日志

## §〇  Production Scenario

### 场景 1：线上 JVM 崩溃，hs_err 是唯一线索

生产环境 JVM 因 SIGSEGV 崩溃，留下 `hs_err_pid12345.log`。你需要从这份报告定位
根因。报告包含：
- 信号信息 (`#  SIGSEGV (0xb) at pc=0x00007f8a3c001234`)
- 原生栈 (`Native frames: (J=compiled Java code, ...)`)
- 寄存器状态 (`RAX=0x0000000000000000, RBX=..., RIP=0x00007f8a3c001234`)
- 编译任务、Java 帧、锁持有、内存映射、环境变量...

**你需要知道**：这份报告是怎么生成的？vmError 在执行 20+ 个子步骤的每一步时面临什么信号安全约束？解码器（Decoder）如何把裸 pc 地址转换成可读符号？如果 hs_err 文件不完整怎么办？

### 场景 2：Native Memory Tracking 的调用栈追溯

你启用了 `-XX:NativeMemoryTracking=detail`，然后 dump NMT 报告：
```
[0x00007f8a3c001234] malloc+0x20
[0x00007f8a51234567] os::realloc+0x15
```
这些裸地址如何被 NativeCallStack 捕获的？`_stack[NMT_TrackingStackDepth]` 数组用什么技术填充？`backtrace(3)` vs `__builtin_return_address` 怎么选？

### 场景 3：事件日志在崩溃后揭示死亡前最后事件

JVM 崩溃后 hs_err 文件底部显示：
```
Events (10 events):
Event: 123.456 Thread 0x00007f... GC heap expanded
Event: 123.789 Thread 0x00007f... Thread attaching
...
```
这些事件怎么存的？EventLogBase 的环形缓冲区在 Signal Handler 里打印时如何保证线程安全？为什么 `should_log()` 要在崩溃期间禁止追加？

---

## §一  Task + Narrative + Beginner Callouts

### Task
生成文档 `02-Debug-Diagnostic.md`，覆盖 HotSpot 调试诊断基础设施的核心实现：
1. **assert/guarantee/fatal** 三层断言框架 (`debug.hpp:48-113`)
2. **vmError 步骤引擎** 生成 hs_err 崩溃报告 (`vmError.cpp:419-950`)
3. **ELF 解析器** 的符号表查找 (`elfFile.cpp:1-351`)
4. **Decoder 双实例架构** 的线程安全 (`decoder.hpp:102-137`)
5. **NativeCallStack** 的栈行走 (`nativeCallStack.hpp:56-101`)
6. **Events 事件日志** 的环形缓冲区 (`events.hpp:71-135`)

### Narrative 主线

"一次 JVM 崩溃的完整诊断链路"：
1. assert/guarantee/fatal 宏触发 → report_vm_error() 调用 VMError::report_and_die()
2. VMError::report_and_die() 启动步骤引擎 → STEP("printing native stack") 等 20+ 子步骤
3. 栈帧打印时 → Decoder::decode() 将 pc 转为函数名 → ElfFile 解析 ELF 获取符号
4. EventLogBase::print_log_on() 打印崩溃前环形缓冲区的事件

### Beginner Callouts（至少 7 个）

> **Callout 1 — 为什么 hs_err 文件不能碰 heap？**
> vmError 运行在信号处理上下文中。如果此时尝试 `new` 或 `malloc`，可能因为锁被持有而死锁，或因为堆已损坏而二次崩溃。解决方案：Signal Handler Safe 编程——只用栈变量 + 静态缓冲区 + write(2) 系统调用。

> **Callout 2 — assert vs guarantee 的区别不是名字**
> `debug.hpp:48-64`: assert 在非 ASSERT 构建中编译为空 (`#define vmassert(p, ...) /* empty */`)。`debug.hpp:100-107`: guarantee 始终编译，用于 Verify 选项和廉价检查。fatal 无分支直接终止。

> **Callout 3 — VMError 的单线程协议**
> `vmError.hpp:68`: `first_error_tid` 原子变量保证只有第一个崩溃线程执行报告生成。其他崩溃线程调用 `os::infinite_sleep()` 永久睡眠。

> **Callout 4 — ELF 解析不是 dladdr 的替代品**
> `elfFile.hpp:122-125`: 文档强调 "Beware, this code is called from vm error reporting code, when vm is already in 'error' state"。ElfFile 从头解析 ELF 二进制，不依赖任何运行时的符号查找机制。这是为垮崩溃场景设计的最后防线。

> **Callout 5 — Decoder 双实例的安全墙**
> `decoder.hpp:120-125`: 正常的 JVM 操作用 `_shared_decoder`（带锁保护）。错误处理器用 `_error_handler_decoder`（独立实例，无锁，信号安全）。两个实例不能共享状态，防止信号处理时死锁。

> **Callout 6 — Events 环形缓冲区的零分配写入**
> `events.hpp:150-159`: `FormatStringEventLog::logv()` 在 Mutex 保护下向环形缓冲区写入。不动态分配——`EventRecord` 在构造时预分配。`compute_log_index()` 循环递增 `_index`，写满后覆盖最旧条目。

> **Callout 7 — STEP 宏的 __LINE__ trick**
> `vmError.cpp:419-420`: 每个 STEP 用 `__LINE__` 作为步骤标识。如果新代码插入两行之间，__LINE__ 自动变化，步骤排序保持正确。`record_step_start_time()` 在每个 STEP 开始时重置超时计时器。

---

## §二  Standard Environment

### Source Roots

```
src/hotspot/share/utilities/debug.hpp                         (:1-214)
src/hotspot/share/utilities/debug.cpp                         (:1-775)
src/hotspot/share/utilities/vmError.hpp                       (:1-202)
src/hotspot/share/utilities/vmError.cpp                       (:1-1870)
src/hotspot/share/utilities/nativeCallStack.hpp               (:1-103)
src/hotspot/share/utilities/nativeCallStack.cpp               (:1-128)
src/hotspot/share/utilities/elfFile.hpp                       (:1-217)
src/hotspot/share/utilities/elfFile.cpp                       (:1-351)
src/hotspot/share/utilities/elfSymbolTable.hpp                (:1-70)
src/hotspot/share/utilities/elfSymbolTable.cpp                (:1-112)
src/hotspot/share/utilities/decoder.hpp                       (:1-149)
src/hotspot/share/utilities/decoder.cpp                       (:1-140)
src/hotspot/share/utilities/decoder_elf.hpp                   (:1-57)
src/hotspot/share/utilities/decoder_elf.cpp                   (:1-77)
src/hotspot/share/utilities/events.hpp                        (:1-312)
src/hotspot/share/utilities/events.cpp                        (:1-98)
```

### Build

```bash
bash configure --with-debug-level=slowdebug
make hotspot
```

编译入口：`make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM`

### Binary

```
build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so
```

### Syscall 速查表

| 系统调用 | man | 用途 | 使用位置 |
|---------|-----|------|---------|
| write(2) | man 2 write | Signal Handler Safe 输出 | vmError.cpp STEP 各子步骤 |
| open(2) | man 2 open | 打开 hs_err 文件和 ELF 文件 | vmError.cpp, elfFile.cpp |
| close(2) | man 2 close | 关闭文件描述符 | vmError.cpp |
| mmap(2) | man 2 mmap | 映射 ELF 文件到内存 (可选) | elfFile.cpp (load_section) |
| fstat(2) | man 2 stat | 获取文件大小 | elfFile.cpp |
| fseek(2)/pread(2) | man 2 lseek / man 2 pread | ELF 文件随机读取 | elfFile.cpp (FileReader) |
| abort(3) | man 3 abort | 最终终止进程并生成 core | vmError.cpp 最后 STEP |
| backtrace(3) | man 3 backtrace | 原生栈行走 (glibc) | nativeCallStack.cpp |
| dladdr(3) | man 3 dladdr | 动态符号查找 (回退方案) | decoder.cpp |
| __cxa_demangle(3) | man 3 __cxa_demangle | C++ name demangling | decoder.cpp |

### 全局状态

| 变量 | 类型 | 定义位置 | 描述 |
|------|------|---------|------|
| `VMError::_id` | static int | vmError.cpp:387 | 信号/异常编号 |
| `VMError::first_error_tid` | volatile intptr_t | vmError.cpp:388 | 第一个崩溃线程ID |
| `VMError::_current_step` | static int | vmError.cpp:384 | 当前步骤编号 (__LINE__) |
| `VMError::_error_reported` | static bool | vmError.cpp:63 | 错误已报告标志 |
| `Events::_logs` | static EventLog* | events.cpp | 事件日志链表头 |
| `Decoder::_shared_decoder` | static AbstractDecoder* | decoder.cpp | 正常情况下解码器 |
| `Decoder::_error_handler_decoder` | static AbstractDecoder* | decoder.cpp | 错误处理器解码器 |
| `NativeCallStack::EMPTY_STACK` | static NativeCallStack | nativeCallStack.cpp | 空栈哨兵 |

---

## §三  Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| debug.hpp | `src/hotspot/share/utilities/debug.hpp` | 214 | `vmassert`, `guarantee`, `fatal`, `ShouldNotReachHere`, `Unimplemented` | 断言宏定义 |
| debug.cpp | `...utilities/debug.cpp` | 775 | `report_vm_error()`, `warning()`, `error_is_suppressed()`, `is_executing_unit_tests()` | 断言运行时 |
| vmError.hpp | `...utilities/vmError.hpp` | 202 | `VMError` 类, `report_and_die()`, `check_timeout()`, `coredump_status` | 错误处理接口 |
| vmError.cpp | `...utilities/vmError.cpp` | 1870 | STEP engine, `report()`, `print_native_stack()`, `print_stack_trace()` | hs_err 生成引擎 |
| nativeCallStack.hpp | `...utilities/nativeCallStack.hpp` | 103 | `NativeCallStack`, `_stack[]`, `hash()`, `equals()` | 调用栈捕获 |
| nativeCallStack.cpp | `...utilities/nativeCallStack.cpp` | 128 | `NativeCallStack()`, `frames()`, `os::get_native_stack()` | 栈行走实现 |
| elfFile.hpp | `...utilities/elfFile.hpp` | 217 | `ElfFile`, `ElfSection`, `Elf_Ehdr`, `Elf_Shdr`, `Elf_Sym` | ELF 解析器头 |
| elfFile.cpp | `...utilities/elfFile.cpp` | 351 | `parse_elf()`, `load_tables()`, `decode()` | ELF 符号查找 |
| elfSymbolTable.hpp | `...utilities/elfSymbolTable.hpp` | 70 | `ElfSymbolTable`, `lookup()` | 符号表查找 |
| elfSymbolTable.cpp | `...utilities/elfSymbolTable.cpp` | 112 | `compare()` binary search | 二分查找符号 |
| decoder.hpp | `...utilities/decoder.hpp` | 149 | `AbstractDecoder`, `NullDecoder`, `Decoder`, `DecoderLocker` | 解码器接口 |
| decoder.cpp | `...utilities/decoder.cpp` | 140 | `get_shared_instance()`, `get_error_handler_instance()`, `create_decoder()` | 双实例管理 |
| decoder_elf.hpp | `...utilities/decoder_elf.hpp` | 57 | `ElfDecoder` | ELF 解码器 |
| decoder_elf.cpp | `...utilities/decoder_elf.cpp` | 77 | `decode()`, `_opened_elf_files` linked list | ELF 符号→函数名 |
| events.hpp | `...utilities/events.hpp` | 312 | `EventLog`, `EventLogBase<T>`, `StringEventLog`, `Events`, `EventMark` | 事件日志缓存 |
| events.cpp | `...utilities/events.cpp` | 98 | `Events::_logs`, `Events::init()`, `Events::print_all()` | 事件日志管理 |

---

## §四  Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 三层断言框架的级别与编译期行为

① 阅读 `debug.hpp:46-113`，分析 assert/guarantee/fatal 三层宏的编译期区别。
   - assert 在非 ASSERT 构建中如何变成空语句？`while(0)` 的语义保障是什么？
   - guarantee 为什么必须始终存在？哪些生产场景需要它？
   - fatal 跳过条件检查直接终止——这合理吗？什么场景下用 fatal？
   - vmassert_status 的额外 `status` 参数解决了什么问题？（`debug.hpp:83-91`）

② **Counterfactual**: 如果 HotSpot 只有一种断言（都像 guarantee 保留在 product 构建）——会对性能有什么影响？JIT 编译器中大量的 `assert(is_oop(val))` 如果保留会减多少吞吐？

③ 阅读 `debug.cpp:98-111` 的 `Crasher` 结构体。为什么需要在静态初始化阶段测试 fatal？这跟 JDK-8214975 (dynamic initialization crash) 有什么关联？

④ `report_vm_error()` (debug.cpp) 如何将错误信息打包传递给 `VMError::report_and_die()`？`_detail_msg[1024]` 缓冲区够大吗？

### 4.2 VMError 步骤引擎的 STEP 宏设计

① 阅读 `vmError.cpp:419-421` 的 STEP/BEGIN 宏定义。为什么用 `__LINE__` 作为步骤编号而非枚举常量？在多文件编译时 `__LINE__` 会冲突吗？

② 追踪一个完整信号崩溃的步骤序列（从 `report_and_die()` 入口开始）：
   ```
   STEP("printing fatal error message")       (:429)
   STEP("printing type of error")             (:491)
   STEP("printing exception/signal name")     (:528)
   STEP("printing current thread and pid")    (:561)
   STEP("printing problematic frame")         (:583)
   STEP("printing native stack")              (:710)
   STEP("printing Java stack")                (:724)
   STEP("printing register info")             (:758)
   ...
   ```
   这些步骤的排序逻辑是什么？（先 generic → 后 thread-specific → 再 VM state → 最后 heap/GC）

③ **Counterfactual**: 如果用显式函数调用链替代 STEP 宏——`step1_print_fatal_error()` → `step2_print_type()` → ...。这会让超时处理更难吗？STEP 宏如何与 `check_timeout()` 集成？

④ `vmError.cpp:462` 的 TIMEOUT_TEST_STEP——WatcherThread 如何检测超时步骤？如果某步骤挂死（比如读取损坏的内存映射表）超时后怎么中断？

### 4.3 信号安全约束下的写操作

① `vmError.cpp` 的 report() 函数必须在信号处理上下文中运行。信号安全要求不能使用哪些操作？（malloc/printf/mutex_lock/new）
   - HotSpot 如何绕开这些限制？用 `os::print()` + `::write(2)` 替代 `printf()`。
   - 静态缓冲区 `_detail_msg[1024]` 和 `coredump_message[O_BUFLEN]` 为什么声明为 static？

② **Counterfactual**: 如果 vmError 允许使用 malloc/printf 在信号处理上下文中——什么场景会二次崩溃？给出具体例子（比如 malloc mutex 被信号打断的线程持有）。

③ `vmError.cpp:68`: `first_error_tid` 的 `volatile` 修饰如何保证多线程环境下只有一个线程执行报告？如果第一个线程在执行 STEP 时被第二个信号打断怎么办？

### 4.4 ELF 解析器的自包含设计

① 阅读 `elfFile.hpp:122-125` 的注释："Beware, this code is called from vm error reporting code, when vm is already in 'error' state"。
   - ElfFile 为什么不能依赖 `dladdr(3)`？（信号上下文中 dladdr 需要锁？）
   - `parse_elf()` (elfFile.cpp) 如何从头解析 ELF 文件：ELF header → program header → section header → .symtab → .strtab

② **Counterfactual**: 如果所有平台上 elfFile 都回退到 dladdr——在 Linux 上能 work 吗？macOS 呢？Windows 呢？（elfFile.hpp:28: `#if !defined(_WINDOWS) && !defined(__APPLE__)...`）

③ 阅读 `elfFile.hpp:98-118` 的 `FileReader`/`MarkedFileReader` 设计。为什么需要对 FILE* 做一次薄封装？`set_position()` 和 `read_buffer()` 的返回值语义是什么？

④ `elfFile.hpp:79-96`: ElfSection 的 `load_section()` 如何处理内存不足？`_stat = out_of_memory` 后 decode 路径如何优雅降级？

### 4.5 Decoder 双实例的线程安全墙

① 阅读 `decoder.hpp:118-125` 的注释："a private instance for error handler... where no lock can be taken"。
   - `get_shared_instance()` 和 `get_error_handler_instance()` 为什么要创建两个独立实例？
   - 如果用同一个 Decoder 实例——信号处理器内调用 `MutexLockerEx` 会怎样？

② **Counterfactual**: 如果取消双实例，改用 recursion-safe mutex (`Mutex::_safepoint_check_never` 的递归形式)。为什么不这样做？recursive mutex 在信号处理器中的真正陷阱是什么？

③ `decoder.hpp:139-147`: `DecoderLocker` 的两步初始化（`MutexLockerEx` 构造 + `is_first_error_thread()` 判断）。如果当前线程就是崩溃线程，选择哪个 decoder？

④ 解码的后端层次：`ElfDecoder` (自解析 ELF) → `dladdr(3)` (glibc) → demangle (GCC IA-64 ABI) 。追踪 `decoder.cpp:create_decoder()` 的平台决策树。

### 4.6 NativeCallStack 的栈行走实现

① 阅读 `nativeCallStack.hpp:56-101`。`_stack[NMT_TrackingStackDepth]` 是定长数组（典型值 4-8 帧）。为什么不用 `std::vector<address>` 动态增长？
   - 内存分配器限制：NativeCallStack 本身就是 NMT 基础设施，它不能用自己追踪的分配器。

② **Counterfactual**: 如果把 NMT_TrackingStackDepth 从 4 增到 32——NMT 的内存开销增加多少？假设 1M 个 NativeCallStack 实例。

③ 阅读 `nativeCallStack.cpp` 看实际栈行走实现。用的是 `backtrace(3)`、`__builtin_return_address` 还是 `_Unwind_Backtrace`？为什么选这个？

④ `hash()` 函数如何工作？用 FNV hash 还是简单 XOR？碰撞率重要吗？

### 4.7 Events 环形缓冲区的并发模型

① 阅读 `events.hpp:71-135` 的 `EventLogBase<T>` 模板。环形缓冲区的核心变量：`_index`、`_count`、`_length`、`_records[]`。
   - `compute_log_index()` (line 104-110): 为什么用后增量 (`_index++`) 而非 `(_index + 1) % _length`？两者的并发语义有何差异？
   - 缓冲区满后不扩容——为什么？（设计约束：写事件不能分配内存）

② **Counterfactual**: 如果换成 `lock-free SPSC ring buffer` 替代 Mutex 保护——在 `print_log_on()` 读者端如何做到内存序正确？CAS 操作为什么在信号处理器中也 safe？

③ 阅读 `events.hpp:252-258` 的 `print_log_on()`。为什么分 `Thread::current_or_null() == NULL` 的两条路径？线程未 attached 时取锁会怎样？

④ `Events::init()` (events.cpp) 创建了哪些默认 logger？`_messages`, `_exceptions`, `_deopt_messages`, `_redefinitions` 各追什么类型的事件？

### 4.8 Breakpoint 和 Poison 机制

① `debug.hpp:34-44`: `CAN_SHOW_REGISTERS_ON_ASSERT` 和 `TOUCH_ASSERT_POISON` 只在 Linux 上启用。`g_assert_poison` 指向 `g_dummy` 一个字节。
   - 触发断言时 `(*g_assert_poison) = 'X'` 写一个字节——这个 write 如何帮助崩溃调试？Writable 但真实地址？
   - `disarm_assert_poison()` 什么时候调用？为什么在 Thread::create_vm() 之后？

② **Counterfactual**: 如果不用 poison 机制，用 `raise(SIGTRAP)` 或 `int3` 替代——在 core dump 中能否同样拿到寄存器快照？Poison write 的独特优势是什么？

③ `debug.cpp:131-164` 的 `error_is_suppressed()`——`SuppressErrorAt` JVM flag 如何过滤重复断言？1-element cache 的设计巧妙在哪？

### 4.9 完整诊断链路的时间线

① 绘制一个端到端时间线：从 `assert(p == NULL)` 触发到 `hs_err_pid<N>.log` 写入完成：
   ```
   T+0μs:   assert(p == NULL) 失败 → TOUCH_ASSERT_POISON
   T+~5μs:  report_vm_error() → VMError::report_and_die()
   T+~10μs: first_error_tid CAS → 其他线程 infinite_sleep
   T+~15μs: reset_signal_handlers() — 安装递归崩溃保护
   T+~20μs: STEP("printing fatal error message") → write(2)
   ...
   T+~500μs: STEP("printing heap information")
   T+~1ms:   os::abort() → SIGABRT → core dump
   ```

② **Counterfactual**: 如果 vmError 在 STEP 10 时被 SIGKILL 杀死——hs_err 文件是部分写入还是完全丢失？`::write(2)` 在文件层面的原子性保证是什么？

---

## §五  Article Structure

建议文档结构（保留 § 编号体系）：

```
§〇 生产场景（3 个场景 + 三步定位法）
§一 Source Files Table（16 行文件表，含行号 + 角色）
§二 Standard Environment（source roots + build + binary + syscall 速查表）
§三 Debug 断言框架：三层体系 + 编译期行为
  §三.1 assert/guarantee/fatal 源码逐行解读（debug.hpp:46-113）
  §三.2 report_vm_error 调用链 → VMError::report_and_die()
  §三.3 TOUCH_ASSERT_POISON 和 CAN_SHOW_REGISTERS_ON_ASSERT
§四 VMError 步骤引擎：hs_err 的诞生
  §四.1 STEP 宏与 __LINE__ trick（vmError.cpp:419-421）
  §四.2 20+ 步骤的完整顺序与设计理由（vmError.cpp:429-950）
  §四.3 信号安全约束：write(2) 替代 printf/malloc
  §四.4 first_error_tid 单线程协议 + check_timeout 超时保护
  §四.5 OnError 命令执行（next_OnError_command）
§五 ELF 解析器：从字节到符号
  §五.1 ElfFile::parse_elf() 的 ELF 解析流程
  §五.2 ElfSymbolTable::lookup() 二分查找
  §五.3 FileReader/MarkedFileReader 的 I/O 抽象
  §五.4 跨平台差异：#if !defined(_WINDOWS) && !defined(__APPLE__)
§六 Decoder 双实例架构
  §六.1 AbstractDecoder 虚函数体系 + NullDecoder 降级
  §六.2 DecoderLocker 的两步选择逻辑
  §六.3 ElfDecoder::decode() 的符号查找链路
  §六.4 dladdr(3) 回退 + __cxa_demangle 解码
§七 NativeCallStack：NMT 的调用栈追溯
  §七.1 _stack[] 定长数组设计 + 内存分配器限制
  §七.2 栈行走实现：backtrace(3) vs __builtin_return_address
  §七.3 hash() + equals() 的碰撞容忍度
§八 Events：崩溃前最后的事件的环形缓冲区
  §八.1 EventLogBase<T> 模板：环形缓冲区 + Mutex + 零分配
  §八.2 Events 系统：_messages/_exceptions/_deopt_messages 四通道
  §八.3 print_log_on() 的并发读取：Thread::current_or_null() 分叉
  §八.4 EventMark RAII 生命周期标记
§九 7 个 Beginner Callout 框（嵌入各 § 尾部）
§十 边缘场景
  §十.1 递归崩溃：reset_signal_handlers() 后的二次信号处理
  §十.2 超时挂死：某 STEP 永不停机 → WatcherThread kill
  §十.3 ELF 损坏：parse_elf() 遇到截断文件的优雅降级
  §十.4 NativeCallStack 在信号处理器中调用：安全吗？
§十一 GDB 断点验证 + strace 诊断
  §十一.1 GDB: b VMError::report_and_die, b ElfFile::decode, b Events::log
  §十一.2 strace: 观察 hs_err 写入的 write(2) 调用
§十二 Cross-Reference
  §十二.1 前向/后向依赖表
  §十二.2 与 libjvm-analysis 旧文档的互补关系
§十三 "不要写成→应该写成" 对照表
```

---

## §六  Writing Requirements

### "不要写成→应该写成" 对照表（≥8 行）

| 不要写成 | 应该写成 |
|---------|---------|
| "vmError::report_and_die() 打印错误报告然后终止进程" | "vmError::report_and_die() 的 STEP 引擎按 `__LINE__` 顺序执行 20+ 子步骤，每步用 `record_step_start_time()` 重置超时，单线程通过 `first_error_tid` CAS 保证 (:419-950)" |
| "ElfFile 可以解析 ELF 文件获取符号" | "ElfFile::parse_elf() (:elfFile.cpp:68-120) 按照 ELF header → program header → section header → .symtab → .strtab 的固定顺序逐节解析，用 FileReader 封装 FILE* I/O (:elfFile.hpp:98-106)" |
| "Events 用环形缓冲区存储事件" | "EventLogBase<T>::compute_log_index() (:events.hpp:104-110) 用后增量 `_index++` 循环索引，缓冲区满后静默覆盖最旧条目——零分配、零扩容的设计是崩溃安全的必要条件" |
| "assert 用于调试，guarantee 用于 release" | "debug.hpp:48-64 中 assert 在 `#ifndef ASSERT` 下展开为空 `while(0)`，而 guarantee 始终执行。区别不在"用途"而在编译器消除——assert 在 product build 中不存在，它的开销是零" |
| "STEP 宏用 __LINE__ 标记步骤" | "STEP 宏 `#define STEP(s) } if (_current_step < __LINE__) { _current_step = __LINE__` (:vmError.cpp:420) 利用预处理器的 `__LINE__` 在编译时固化步骤编号，如果代码修改插入新 STEP，编号自动顺延——无需维护枚举常量表" |
| "Decoder 支持信号安全解码" | "Decoder::get_error_handler_instance() (:decoder.cpp:57-80) 返回独立的无锁 Decoder 实例，与 `_shared_decoder` 完全隔离——正常路径用 Mutex 保护的共享实例，信号路径用独立实例避免死锁" |
| "nativeCallStack 记录调用栈" | "NativeCallStack 的 `_stack[NMT_TrackingStackDepth]` (:nativeCallStack.hpp:60) 是固定大小数组（默认 4-8 帧）。不能用动态分配——NMT 本身追踪 NativeCallStack 分配，递归依赖会导致死循环" |
| "ELF 解析替代 dladdr" | "ElfFile 从头解析 ELF 二进制 (:elfFile.hpp:122-125) 而不是调用 `dladdr(3)`——因为 dladdr 可能在信号上下文中需要锁。这是一个 `#if !defined(_WINDOW) && !defined(__APPLE__)` (:elfFile.hpp:28) 限定平台的信号安全兜底方案" |
| "vmError 处理多线程同时崩溃" | "`first_error_tid` (:vmError.cpp:388) 是 `volatile intptr_t`，第一个写成功的线程执行报告，后续线程调用 `os::infinite_sleep()` 永久等待——不是锁，不是 FIFO，而是首来先得的 CAS 竞态模型" |

---

## §七  Output Format

### 文件路径
```
/data/workspace/openjdk-cut-new/probe_md/24-utilities/docs/02-Debug-Diagnostic.md
```

### 标题格式
```
# 02-Debug-Diagnostic — assert/vmError/ELF/Decoder/Events
```

### 必需元素
- 每个技术断言标注精确 `file:line` 引用
- Mermaid 序列图：vmError STEP 引擎的完整流程（至少 10 步）
- 3-5 行代码片段（关键宏或函数）
- GDB 断点验证（≥7 断言）
- 7 个 Beginner Callout 框（embed 在 §一 或各 § 末尾）
- 链接本文档中所有交叉引用（如 "见 §五.1"）

---

## §八  Prohibited（≥8 条）

1. **不要写成"信号安全编程"百科** — 只讨论 HotSpot 中用到的信号安全约束（write(2), 栈变量, static buf），不泛泛而谈 POSIX 信号安全函数列表
2. **不要把 vmError.cpp 的 20+ STEP 逐行翻译** — 提取步骤分类逻辑（信号信息 → 线程信息 → VM状态 → 内存/堆），不逐行抄源码
3. **不要忽略 `first_error_tid` 的 volatile 语义** — 不讲 CPU 内存屏障，但要讲"为什么 volatile 在这里足够"（单一 writer + 只读的读者）
4. **不要混淆 EventLog（基类）和 EventLogBase<T>（模板子类）** — 两者是不同的继承层次：CHeapObj base → EventLog → EventLogBase<T> → FormatStringEventLog<bufsz>
5. **不要忽略 ELF 解析的跨平台限制** — `#if !defined(_WINDOWS) && !defined(__APPLE__)` (:elfFile.hpp:28) 必须提
6. **不要忽略 Decoder 的 factory 模式** — `create_decoder()` 的平台决策树（Linux→ElfDecoder, Windows→WindowsDecoder, macOS→MachODecoder）比 Decoder 本身更有启发性
7. **不要写成"NativeCallStack 是 NMT 用的"就结束** — 要问 WHY 它固定大小、WHY 它是 StackObj、WHY 它从不分配
8. **不要把 `__LINE__` trick 说成"hack"** — 它是 C 预处理器的标准用法，配合 `_current_step < __LINE__` 保证不重复执行同一个 STEP
9. **不要跳过 BREAKPOINT 宏** — `debug.hpp:62/89/105/113`: 每个致命错误后都有 `BREAKPOINT;` ——这是为调试器设置的断点锚，也是 `ShouldNotReachHere` 的核心语义
10. **不要只讲"崩溃后打印事件"不给原因** — `should_log()` (:events.hpp:112-116) 禁止崩溃期间追加事件是因为 Mutex 可能被崩溃线程持有

---

## §九  Required（≥8 条）

1. **Mermaid 序列图**：vmError::report_and_die() 的完整 STEP 引擎流程（≥10 步），含超时检测分支
2. **vmError.cpp STEP 清单**：提取所有 STEP("...") 形成表格，标注每个步骤的 file:line 和输出内容摘要
3. **ElfFile 解析路径**：program header → section header → .symtab → .strtab → symbol lookup，每一步标注 file:line
4. **Decoder 工厂模式图解**：平台 → Decoder 子类 → 后端（ElfFile/dladdr/demangle）的决策树
5. **NativeCallStack 源码**：构造函数 + hash() + equals() + print_on()，每段源码后附 WHY not HOW
6. **Events 环形缓冲区源码**：compute_log_index() + logv() + print_log_on() 三段核心源码
7. **7 个 Callout 框**：在 §一 或各小节末尾嵌入，格式 `> **Callout N — ...**`
8. **Signal Handler Safe 对比表**：安全操作 vs 不安全操作（write(2) ✓ / printf ✗ / malloc ✗ / ::abort() ✓），标注 man 章节号
9. **§十 边缘场景**：≥4 个场景（递归崩溃、超时挂死、ELF 损坏、NMT 递归）
10. **§六 "不要写成→应该写成" 对照表**：≥8 行

---

## §十  GDB Verification（≥7 assertions）

在构建的 slowdebug JVM 上验证：

```gdb
# 1. 验证 assert/guarantee 触发路径
(gdb) b report_vm_error
(gdb) b report_fatal
(gdb) r -XX:+UnlockDiagnosticVMOptions -XX:+ExecuteInternalVMTests
# → 观察 assert/guarantee 触发后走到 report_vm_error → VMError::report_and_die

# 2. 验证 VMError STEP 引擎启动
(gdb) b VMError::report_and_die
(gdb) c
# → 观察 _current_step 从 0 递增，first_error_tid 被设为当前线程ID

# 3. 验证 ELF 解析器的符号查找
(gdb) b ElfFile::decode
(gdb) c
# → 观察 addr, buf, offset 参数。buf 应该获得函数名

# 4. 验证 Decoder 双实例
(gdb) p Decoder::_shared_decoder
(gdb) p Decoder::_error_handler_decoder
# → 两个指针应该不同，或 _error_handler_decoder 可能为 NULL（按需创建）

# 5. 验证 NativeCallStack 捕获
(gdb) b NativeCallStack::NativeCallStack
(gdb) c
# → 观察 _stack[] 数组被填充的返回地址

# 6. 验证 Events 环形缓冲区
(gdb) b Events::log
(gdb) c
# → 观察 _messages->_index, _messages->_count 递增

# 7. 验证 Signal Handler 中的 write(2)
strace -e trace=write -p $(pidof java) 2>&1 | grep -E "hs_err|fatal|assert"
# → 观察 hs_err 文件内容通过 write(2) 逐行输出

# 8. 验证 error_is_suppressed 缓存
(gdb) b error_is_suppressed
# → 第一次调用应返回 false，同 file+line 第二次调用应返回 true

# 9. 验证 BREAKPOINT 宏的效果
(gdb) r -XX:+CrashGCForDumpingJavaThread -version
# → JVM 触发 fatal 后应停在 BREAKPOINT 处（如果 GDB attached）
```

---

## §十一  与 README 和同组 prompt 的连续性

### 与 README 关系
- `probe_md/24-utilities/README.md` 定义了本文档为 `02-Debug-Diagnostic`
- 源文件范围：debug/vmError/elfFile/elfSymbolTable/decoder/decoder_elf/nativeCallStack/events
- BUILD_LIBRARY: `CompileJvm.gmk:153`

### 与 prompt-00（Core Containers）的交叉引用
- GlobalCounter 被 singleWriterSynchronizer 使用 → doc-00 §四 讨论
- NativeCallStack 使用 EventLogBase 的环形缓冲区模式 → doc-02 §八

### 与 prompt-01（Streams & Output）的交叉引用
- vmError::report() 接收 outputStream* 参数 → 继承体系定义在 doc-01
- Events::print_log_on() 也接收 outputStream*
- ostream 的 write() 虚函数是 vmError 的写后端

### 与旧文档关系
- `libjvm-analysis/10-services-diag/04-VMError-hs_err.md` 覆盖 VMError 的高层行为——本文档补充源码级实现
- 标记为互补，不冲突
