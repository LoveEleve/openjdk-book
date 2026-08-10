# PROMPT: 请撰写 02-Message-Composition-Macros.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

### 场景 1：多行日志被线程间交替插入（Log vs LogMessage）

生产环境配置 `-Xlog:class+unload=debug` 监控类卸载。自定义代码中：

```cpp
Log(gc, classhisto) log;
if (log.is_debug()) {
  log.debug("Class histogram dump start");
  // ... 若干行 histo 输出 ...
  log.debug("Class histogram dump end");
}
```

问题：`log.debug()` 每行都是独立写入 `LogTagSet::vwrite()`（log.hpp:157 `vwrite(level, fmt, args)` → logTagSet.cpp:110-139 `vwrite()`）。在 `vwrite()` 内部（logTagSet.cpp:122-133），每个 output 的 `LogOutput::write()` 被独立调用。两个线程同时使用 `Log(gc, classhisto)` → 线程 A 的 `debug("start")` 和线程 B 的 `debug("start")` 可能在 `LogOutputList::Iterator` 遍历中交错 → stderr 显示 `[start][start][end][end]` 而非 `[start][end][start][end]`。

修复：使用 `LogMessage(gc, classhisto) msg;`（logMessage.hpp:60）→ 所有行缓冲在 `LogMessageBuffer` 中 → 析构时一次性 `_log.write(*this)` → `LogTagSet::log(msg)` 将整个 buffer 一次性提交到所有 output —— 一个 Iterator 遍历覆盖整个多行消息。源码：logMessage.hpp:72-76 析构函数检查 `_has_content` → `flush()` → logMessage.hpp:78-81 `_log.write(*this)` → `LogTagSet::log(const LogMessageBuffer&)` (logTagSet.cpp:75-87) 在一个 `LogOutputList::Iterator` 遍历内完成所有行写入。

**反事实**：如果 `LogMessage` 不存在 → 每个对 `log.debug()` 的调用都是独立的 `vwrite()` → 多行 GC 日志（GC heap before/after, phases, timing breakdown）永远无法保证原子性 → GC 日志文件变成无法解析的文本交错。

### 场景 2：LogStream 行缓冲未 flush 导致日志"丢失"

```cpp
log_debug(gc)("GC stats: heap=%zu, ");
log_debug(gc)("time=%zu", elapsed);
```

期望不同，但实际输出可能是两行（各自带装饰器前缀）。如果用 `LogStream` 代替 `log_debug` 宏：

```cpp
Log(gc) log;
LogStream stream(log);
stream.print("GC stats: heap=%zu, ", size);
// ... 忘记写 '\n' 或 stream.cr() ...
// 函数返回 → LogStream 析构 → 之前 print 的 "GC stats: heap=..." 才被 flush
```

原因：`LogStream::write()`（logStream.cpp:104-113）以 `'\n'` 作为 flush 边界——遇到 `'\n'` 时调用 `_log_handle.print("%s", _current_line.buffer())` + `_current_line.reset()`。无 `'\n'` 的写入只在 `LineBuffer` 中累积，直到析构函数 `~LogStream()`（logStream.cpp:116-121）检查 `is_empty()` 并强制 flush。如果不是栈上对象（例如 `new LogStream()` 忘了 `delete`），`~LogStream()` 永远不会被调用 → 内存泄漏 + 日志永久丢失。

**反事实**：如果 LogStream 每写一个非换行字符串就 flush → 每次 `stream.print("x")` 产生一行独立日志 → 链式 `stream.print("a").print("b").print_cr("c")` 本应输出 `"abc"` 变成三行独立输出 → 失去了 `outputStream` 的流式接口语义。

### 场景 3：装饰器性能灾难 — hostname 每行 gethostname

配置 `-Xlog:gc=debug:stdout:hostname,uptime,level,tags`。每秒 100K 行 GC 日志 → 如果每次调用 `LogDecorations::create_hostname_decoration()`（logDecorations.cpp:132-135）都执行 `gethostname(2)` 系统调用 → 100K × ~500ns = 50ms/s CPU 消耗纯于获取不变的 hostname。HotSpot 的设计：`LogDecorations::_host_name` 是 `static const char*`（logDecorations.hpp:41），在 `LogDecorations::initialize()`（logDecorations.cpp:40-46）中一次性调用 `os::get_host_name()` + `os::strdup_check_oom()` → 之后所有 `create_hostname_decoration()` 只用一次 `jio_snprintf` 打印缓存值。

类似地，`_vm_start_time_millis` 是 static jlong（logDecorations.hpp:40），在 `initialize()` 中设置一次 → `create_uptimemillis_decoration()`（logDecorations.cpp:94-98）做 `java_millis() - _vm_start_time_millis` 每次计算但不重复读取启动时间。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 检查所有 tag 组合的实际输出量
jcmd <pid> VM.log list
# 输出每类 output 的 selections + 装饰器配置

# 2. 验证多行日志的原子性
for i in $(seq 1 100); do
  jcmd <pid> VM.log what="gc=debug" decorators="uptime,level,tags,gcid"; sleep 0.1
done
# 观察 gc.log 中 GC heap before/after 行之间是否有其他线程的插入

# 3. GDB 验证 LogStream 行缓冲
gdb -ex "break logStream.cpp:107" \
    -ex "break logStream.cpp:110" \
    -ex "break logStream.cpp:117" \
    -ex "run" \
    -ex "print _current_line.buffer()" \
    -ex "print _current_line.is_empty()" \
    --args java -Xlog:gc=debug -version
```

---

## §一 Task + Narrative + Beginner Callouts

### Task

阅读本 prompt，你将生成一份文档，覆盖 HotSpot 统一日志框架的**消息构造层** —— 从 `log_debug(gc)("msg")` 宏展开到 `LogDecorations` 装饰器字节写入。包括：三层宏 API（`log_*` / `Log` / `LogTarget`）的设计阶梯、`LogStream` 的 `outputStream` 流式接口、`LogMessage` 的延迟格式化与多行原子性、`LogMessageBuffer` 的懒分配双缓冲引擎、`LogHandle` 的类型擦除桥接、`LogDecorations` 的运行时装饰器计算与静态缓存优化、`LogDecorators` 的位掩码解析系统、以及 `logPrefix.hpp` 的跨行统一前缀协议。

Reader 已完成 **00-Tag-Level-Selection-Configuration**（Tag/Level/Selection 过滤判定 → 消息经 `log_is_enabled()` 进入本文的宏入口）、**01-Output-Pipeline**（`LogOutput::write()` 接收本文构造的消息字符串 → 写出到文件/流）。本文：**日志消息的三个 API 层 + 装饰器系统 + 前缀协议**。

### Narrative

"`log_debug(gc, class)("Class unloading: %s", name)` 只写一行 C++ 代码，但幕后发生了什么？宏 `log_debug(gc, class)` (log.hpp:49) 首先展开为一个三元表达式：`(!log_is_enabled(Debug, gc, class)) ? (void)0 : LogImpl<LogTag::_gc, LogTag::_class>::write<LogLevel::Debug>("Class unloading: %s", name)`。`log_is_enabled()` 宏调用 `LogTagSetMapping<_gc,_class>::tagset().is_level(Debug)` —— 一个内联的 `_output_list.is_level(level)` 布尔检查（logTagSet.hpp:114）。如果禁用，三元表达式短路不执行任何参数求值；如果启用，调用 `LogImpl::vwrite()` → `LogTagSet::vwrite()`。

`LogTagSet::vwrite()` (logTagSet.cpp:110-139) 是消息构造和输出之间的桥梁。它先调用 `LogPrefix<_gc,_class>::prefix()` 生成前缀字符串（如果 `LOG_PREFIX_LIST` 中有对应条目——本文档覆盖的 `logPrefix.hpp` 系统），然后构造 `LogDecorations` 对象计算装饰器值，最后遍历 `LogOutputList::Iterator` 调用 `(*it)->write(decorations, msg)` —— 进入 01-Output-Pipeline 的领域。

如果需要输出多行日志（例如 GC heap before/after）而不被其他线程插入，则用 `LogMessage(gc) msg;` (logMessage.hpp:60)。每行通过 `msg.debug("line")` 写入 `LogMessageBuffer`，析构时 `flush()` 一次性 `_log.write(*this)` → `LogTagSet::log(msg)` 在一个迭代器遍历中输出所有行 → 保证原子性。

当需要流式接口（`print()`、`print_cr()`、`hexdump` 等）时，用 `LogStream stream(Log(gc));` (logStream.hpp:67-79) → 继承 `outputStream` 的全部格式化方法 → 通过 `LineBuffer` 累积 → `'\n'` 或析构时自动 flush。"

### Interview Story Format Answer（必须出现在 §一 末尾）

"`log_debug(gc)("msg")` 的完整链路：宏展开为 `log_is_enabled(Debug, gc)` 守卫的三元表达式 → 启用时调用 `LogImpl<_gc>::vwrite(Debug, "msg")` → `LogTagSet::vwrite()` → 计算 `LogPrefix` 前缀 → 构造 `LogDecorations`（bitmask 检查 `create_*_decoration()`，hostname 读 static 缓存、uptime 调用 `os::elapsedTime()`、pid/tid 调用 `os::current_process_id/thread_id()`）→ `LogOutputList::Iterator` 遍历 → `(*it)->write(decorations, msg)` 进入 Output Pipeline。对于多行场景，`LogMessage(gc) msg; msg.debug("before"); msg.debug("after");` 将所有行缓冲在 `LogMessageBuffer` 的双平行数组（`_lines[]` + `_message_buffer[]`）中，懒分配 1KB 初始缓冲，析构时一次性 `LogTagSet::log(msg)` 保证多行原子性。`LogStream` 继承 `outputStream`，利用 `LineBuffer` 的 64 字节栈优化累积字符串片段，遇 `'\n'` 或析构时通过 `LogTargetHandle::print()` flush 到 TagSet。"

### Beginner Callout Boxes（文档 §一 中必须出现的 7 个 callout 框）

1. **Ternary guard vs short-circuit**: `log_debug(...)(...)` (log.hpp:49) 使用 C++ 三元表达式 `?:` 而非 `if` 语句。`?:` 是表达式（可用在任何需要表达式的位置，如函数实参），而 `if` 是语句（只能在语句位置）。`?:` 确保 `(!log_is_enabled(...)) ? (void)0 : do_write` —— 当禁用时不仅 skip 写入，而且 `printf` 的 varargs 参数也完全不会被求值。如果用 `if (log_is_enabled(...)) { ... }` —— `if` 不能出现在表达式上下文中（如 `return log_debug(...)(...)`）。

2. **outputStream 继承 — 为什么不是 iostream**: LogStream 继承 `outputStream` (logStream.hpp:34)，而非 C++ 标准的 `std::ostream`。`outputStream` 是 HotSpot 自有的轻量级输出抽象（`utilities/ostream.hpp`），提供 `print()`、`print_cr()`、`print_raw()`、`hexdump()` 等方法，零异常开销（no `try/catch`）、零虚函数表中间层额外开销、可编译到 product build（HotSpot 禁用 C++ exceptions）。继承它意味着 LogStream 获得所有 `print` 方法而无须重写——只实现 `virtual void write(const char* s, size_t len)` 即可。

3. **LineBuffer 栈优化 — 64 字节小缓冲**: `LogStream::LineBuffer` (logStream.hpp:42-55) 声明了 `char _smallbuf[64]` 作为栈上固定缓冲区。构造函数 (logStream.cpp:29-33) 让 `_buf` 初始指向 `_smallbuf` 而非堆分配。对于绝大多数日志行（典型日志行 30-80 字节，如 `[0.123s][debug][gc] GC(15) Pause Young 12M->8M(64M) 2.543ms` ≈75 字节），这避免了 `os::malloc` 调用（~50-100ns）。仅当行超过 64 字节时（如调用栈 dump），`try_ensure_cap()` (logStream.cpp:46-77) 才通过 `os::malloc` 分配堆内存。Source: logStream.cpp:29-33 + logStream.cpp:42-78。

4. **LogMessage 延迟格式化 ≠ 延迟字符串构造**: `LogMessage` 的 "deferred formatting" 不是指 printf 格式化被推迟——`vwrite()` (logMessage.hpp:89-95) 在调用时立即执行 `os::vsnprintf` 格式化。真正的"延迟"是：格式化的结果被写入 `LogMessageBuffer` 的堆缓冲而非直接输出，所有行积攒到析构时才一次性 flush。这使得多行日志有原子性——输出层看到的是完整的 `const LogMessageBuffer&` 引用，而非离散的单行字符串。Source: logMessageBuffer.cpp:86-131 + logMessage.hpp:72-76。

5. **LogHandle 类型擦除 — 模板去模板化**: `LogHandle` (logHandle.hpp:33-67) 的唯一成员是 `LogTagSet* _tagset` (logHandle.hpp:35)。构造时从模板化的 `LogImpl<T0,T1,...>` 提取 `LogTagSetMapping<T0,...>::tagset()` 地址。之后所有 `vdebug()`/`vtrace()` 调用都通过 `_tagset->vwrite()` 实现——完全依赖运行时指针而非编译期模板参数。这允许将 Log handle 作为函数参数传递而不污染函数签名为模板函数。`LogTargetHandle` 同样原理但额外存储 `LogLevelType _level`。Source: logHandle.hpp:34-67。

6. **静态装饰器值的单次初始化**: `LogDecorations::_host_name` (logDecorations.hpp:41) 和 `_vm_start_time_millis` (logDecorations.hpp:40) 是 `static` 成员，由 `LogDecorations::initialize(jlong vm_start_time)` (logDecorations.cpp:40-46) 在 JVM 启动时一次性设置。`hostname` 在整个 JVM 生命周期内不变 —— 每次日志行调用 `gethostname(2)` 是纯粹浪费。`_vm_start_time_millis` 作为 `create_uptimemillis_decoration()` 的基准也是静态的。这种"分类计算成本"的设计：对 12 个装饰器做运行时成本分级——hostname 零成本（static 缓存）、pid/level/tags 微成本（直接读取）、time/uptime 重成本（每次 syscall 或计算）——使得装饰器配置选择有性能含义。

7. **LOG_LEVEL_LIST X-MACRO 的重复展开**: `LOG_LEVEL_LIST` (logLevel.hpp:45-50) 定义五级宏调用 `LOG_LEVEL(Trace, trace) LOG_LEVEL(Debug, debug) LOG_LEVEL(Info, info) LOG_LEVEL(Warning, warning) LOG_LEVEL(Error, error)`。在 `LogImpl` (log.hpp:156-175)、`LogHandle` (logHandle.hpp:50-67)、`LogMessageBuffer` (logMessageBuffer.hpp:124-128) 三处各自 `#define LOG_LEVEL(level, name)` 为不同的实现——在 `LogImpl` 中展开为 `v##name()`/`name()` printf 方法 + `is_##name()` 检查 + `name()` 返回 LogTarget 指针；在 `LogHandle` 中展开为类似的 vprintf 方法但通过 `_tagset->vwrite()` 调用；在 `LogMessageBuffer` 中展开为返回 `LogMessageBuffer&` 以支持链式调用。一处修改（添加新 level）→ 三处自动同步。Source: log.hpp:156-175 + logHandle.hpp:50-67 + logMessageBuffer.hpp:124-128。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux (TencentOS Server 4.2, RHEL-like)。

Source roots:
- `src/hotspot/share/logging/log.hpp:1-201` — 三层宏 API 定义
- `src/hotspot/share/logging/logStream.hpp:1-108` — LogStream + LineBuffer 声明
- `src/hotspot/share/logging/logStream.cpp:1-123` — write() + LineBuffer 实现
- `src/hotspot/share/logging/logMessage.hpp:1-105` — LogMessage 延迟缓冲声明
- `src/hotspot/share/logging/logMessageBuffer.hpp:1-130` — LogMessageBuffer 声明
- `src/hotspot/share/logging/logMessageBuffer.cpp:1-146` — vwrite() + grow() 实现
- `src/hotspot/share/logging/logHandle.hpp:1-104` — LogHandle + LogTargetHandle 声明
- `src/hotspot/share/logging/logDecorations.hpp:1-67` — LogDecorations 计算对象声明
- `src/hotspot/share/logging/logDecorations.cpp:1-136` — 13 个 create_*_decoration() 实现
- `src/hotspot/share/logging/logDecorators.hpp:1-116` — Decorator enum + bitmask 声明
- `src/hotspot/share/logging/logDecorators.cpp:1-83` — 名称表 + parse() 实现
- `src/hotspot/share/logging/logPrefix.hpp:1-119` — LOG_PREFIX_LIST + LogPrefix 模板
- `src/hotspot/share/logging/logTag.hpp:198-205` — LOG_TAGS/PREFIX_LOG_TAG 宏定义
- `src/hotspot/share/logging/logLevel.hpp:45-50` — LOG_LEVEL_LIST 宏定义
- `src/hotspot/share/logging/logTagSet.hpp:143-157` — LogTagSetMapping 模板
- `make/hotspot/lib/CompileJvm.gmk:153` — BUILD_LIBJVM 编译入口

Build:
```bash
cd /data/workspace/openjdk-cut-new
bash configure --with-debug-level=slowdebug --disable-warnings-as-errors
make jdk
```

Key binary:
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — 所有 logging/ .cpp 编译在此

Syscall 速查表：

| 功能 | syscall | man | 出现位置 | 用途 |
|------|---------|-----|---------|------|
| 获取主机名 | `gethostname` | `man 2 gethostname` | logDecorations.cpp:42 | hostname 装饰器单次初始化 |
| 获取时间(毫秒) | `clock_gettime` | `man 2 clock_gettime` | logDecorations.cpp:63 (via os::javaTimeMillis) | timemillis/uptimemillis 装饰器 |
| 获取时间(纳秒) | `clock_gettime` | `man 2 clock_gettime` | logDecorations.cpp:101 (via os::javaTimeNanos) | timenanos/uptimenanos 装饰器 |
| 获取进程ID | `getpid` | `man 2 getpid` | logDecorations.cpp:111 (via os::current_process_id) | pid 装饰器 |
| 获取线程ID | `gettid` | `man 2 gettid` | logDecorations.cpp:117 (via os::current_thread_id) | tid 装饰器 |
| ISO8601 时间格式化 | `localtime_r`/`gmtime_r` | `man 3 localtime_r` | logDecorations.cpp:73-76 (via os::iso8601_time) | time/utctime 装饰器 |
| 进程运行时间 | `times`/`clock_gettime` | `man 2 times` | logDecorations.cpp:85 (via os::elapsedTime) | uptime 装饰器 |
| 动态内存分配 | `malloc` | `man 3 malloc` | logStream.cpp:64 (via os::malloc) | LineBuffer 超 64 字节扩容 |
| 完整格式化输出 | `vsprintf` | `man 3 vsprintf` | logMessageBuffer.cpp:113 (via os::vsnprintf) | LogMessageBuffer 格式化写入 |

全局状态：

| 变量 | 定义位置 | 说明 |
|------|---------|------|
| `LogDecorations::_host_name` | logDecorations.hpp:41 + logDecorations.cpp:33 | 静态主机名缓存（单次 gethostname）|
| `LogDecorations::_vm_start_time_millis` | logDecorations.hpp:40 + logDecorations.cpp:32 | 静态 VM 启动毫秒时间戳 |
| `LogDecorators::DefaultDecoratorsMask` | logDecorators.hpp:72 | 默认装饰器位掩码 (uptime\|level\|tags) |
| `LogDecorators::None` | logDecorators.cpp:28 | 空装饰器实例 (位掩码=0) |
| `LogDecorators::_name[][2]` | logDecorators.cpp:30-34 | 装饰器名称表 (全名 + 缩写) |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Constructs | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **log.hpp** | `src/hotspot/share/logging/log.hpp` | 201 | `log_error/warning/info/debug/trace` macros(:46-50), `Log(...)` macro(:87), `LogTarget(level,...)` macro(:105), `log_is_enabled()` macro(:69), `LogImpl<...>` template(:112-176), `LogTargetImpl<...>` template(:181-199), LOG_LEVEL_LIST expansion(:156-175) | **三层宏 API** — 表达式安全守卫 + Log 类方法 + LogTarget 级别固定 |
| 2 | **logStream.hpp** | `src/hotspot/share/logging/logStream.hpp` | 108 | `LogStream` class(:34-97) inherits outputStream, `LineBuffer`(:42-55) inner class, 4 constructors(:68-94), `LogStreamHandle` macro(:100), `LogStreamTemplate`(:102-106) | **流式日志接口** — outputStream 桥接 + 行缓冲 |
| 3 | **logStream.cpp** | `src/hotspot/share/logging/logStream.cpp` | 123 | `LineBuffer::LineBuffer()`(:29-33), `LineBuffer::try_ensure_cap()`(:46-77), `LineBuffer::append()`(:80-97), `LogStream::write()`(:104-113), `~LogStream()`(:116-121) | **write() + LineBuffer 实现** — 栈优化 + 扩容 + flush |
| 4 | **logMessage.hpp** | `src/hotspot/share/logging/logMessage.hpp` | 105 | `LogMessage(...)` macro(:60), `LogMessageImpl<...>` template(:63-103) inherits LogMessageBuffer, `vwrite()`(:89-95), `flush()`(:78-81), LOG_LEVEL_LIST(:97-101) | **延迟格式化包装** — scoped 多行批处理 |
| 5 | **logMessageBuffer.hpp** | `src/hotspot/share/logging/logMessageBuffer.hpp` | 131 | `LogMessageBuffer` class(:31-129) inherits StackObj, `LogLine` struct(:34-37), `Iterator`(:64-96), `set_prefix()`(:114-116), LOG_LEVEL_LIST expansion(:124-128) | **多行缓冲引擎** — 双平行数组 + 懒分配 |
| 6 | **logMessageBuffer.cpp** | `src/hotspot/share/logging/logMessageBuffer.cpp` | 146 | `grow()` template(:29-37), Constructor(:39-48), `initialize_buffers()`(:62-69), `vwrite()`(:86-131), `Iterator::skip_messages_with_finer_level()`(:71-77), LOG_LEVEL_LIST implementation(:133-146) | **vwrite 2-attempt 策略** — 乐观首次 + 保证二次 |
| 7 | **logHandle.hpp** | `src/hotspot/share/logging/logHandle.hpp` | 104 | `LogHandle` class(:33-67) with `LogTagSet* _tagset`, `LogTargetHandle` class(:73-102) with `_level + _tagset`, LOG_LEVEL_LIST expansion(:50-67) | **类型擦除桥接** — 模板→运行时指针 |
| 8 | **logDecorators.hpp** | `src/hotspot/share/logging/logDecorators.hpp` | 116 | `DECORATOR_LIST` X-MACRO(:41-53) 12 decorators, `Decorator` enum(:61-67), `uint _decorators` bitmask(:70), `DefaultDecoratorsMask`(:72), `from_string()`(:99), `parse()`(:113), `is_decorator()`(:109) | **装饰器枚举系统** — 位掩码 + 解析 |
| 9 | **logDecorators.cpp** | `src/hotspot/share/logging/logDecorators.cpp` | 83 | `_name[][2]` table(:30-34), `LogDecorators::None`(:28), `from_string()`(:36-44), `parse()`(:46-83) | **装饰器名称表 + 逗号解析** |
| 10 | **logDecorations.hpp** | `src/hotspot/share/logging/logDecorations.hpp` | 67 | `LogDecorations` class(:31-65), `_decorations_buffer[256]`(:35), `_decoration_offset[]`(:36), `_host_name`/`_vm_start_time_millis` static members(:40-41), `create_*_decoration()` via DECORATOR_LIST(:46-48), `set_level()`(:55), `decoration()`(:59) | **运行时装饰器值计算** — 临时对象 + 静态缓存 |
| 11 | **logDecorations.cpp** | `src/hotspot/share/logging/logDecorations.cpp` | 136 | `LogDecorations::initialize()`(:40-46), `create_decorations()`(:48-59), `java_millis()`(:61-66), 13 `create_*_decoration()` methods(:72-135) | **12 种装饰器值计算方法** |
| 12 | **logPrefix.hpp** | `src/hotspot/share/logging/logPrefix.hpp` | 119 | `LOG_PREFIX_LIST`(:45-90) 42 entries, `LogPrefix<T...>` template(:94-100), `LOG_PREFIX` macro(:102-115), `GCId::print_prefix` as primary prefixer | **跨行统一前缀协议** — GC cycle ID 前置 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 ★★★ log.hpp 三层 API 设计 — 表达式安全 / 实例方法 / 级别固定

```
问题：
  ① 为什么设计三层 API（log_* 宏/ Log 类 / LogTarget）而非单层？
      答案方向：
      Tier 1 (log_debug(gc)("msg")): 表达式安全 — C++ 三元 `?:` 确保是表达式而非语句。
      log.hpp:49: `(!log_is_enabled(Debug, gc)) ? (void)0 : LogImpl<_gc>::write<Debug>`
      可以在 `return log_debug(...)("msg"), other_value` 中使用。
      如果禁用，所有参数（printf args）不被求值 — 节省 CPU（printf 参数构造可能昂贵，
      如 `log_debug(gc)("Class name: %s", klass->external_name())` — external_name()
      调用涉及字符串分配）。
      
      Tier 2 (Log(gc) log; log.debug("msg")): 多次输出的实例方法 — 创建 LogImpl 实例，
      持有 `is_##name()` 检查和每个级别的 `debug()/trace()/info()` 方法，
      还通过 `name()` 返回 `LogTargetImpl*` 支持 `LogStream stream(log.debug())` 创建流。
      
      Tier 3 (LogTarget(Debug, gc) out; out.print("msg")): 级别内嵌 — 级别在构造时固定，
      避免每次 `out.print()` 写 level 参数。out.is_enabled() 直接检查 `level` + `tags`。
      最简洁的 API，适合在函数入口处一次性判定 `is_enabled()` 然后多次写入。
      
      追问: 为什么 Tier 1 的宏用 `?:` 而非 `do { ... } while(0)` 表达式？
      → do-while 是语句不是表达式。在 `return log_debug(...)("msg"), expr` 这样的逗号
        表达式中，语句会触发编译错误。`?:` 是 C++ 唯一能在表达式位置做条件分支的机制。
        代价：两个分支的类型必须兼容——`(void)0` 和 `LogImpl::write` 返回 void 不冲突。

  ② Counterfactual: 如果只有 Tier 1 宏（无 Log/LogTarget），会失去什么？
      答案方向: 失去：
        1. 流式接口 — `log.debug_stream()->print("...")` 复用 outputStream 的 hexdump/indent 等。
        2. 多次输出的级别缓存 — 没有 `LogTarget(Debug, gc)` 意味着每次 `log_debug(gc)` 
           都要重新展开 `log_is_enabled(Debug, gc)` 检查（两个函数调用+比较，约5ns）。
           对于 1000 行批量日志，5µs 浪费。

      如果只有 Log 类（无宏），会失去：
        1. 表达式安全性 — 不能在 `return`/`?:`/`throw` 等表达式上下文中使用。
        2. 参数惰性求值 — 必须写 `if (log.is_debug()) { log.debug("expensive: %s", 
           compute_expensive_string()); }` — 比 `log_debug(gc)("expensive: %s", compute())`
           多一层代码嵌套。
```

### 4.2 ★★★ LogStream — outputStream 继承 + LineBuffer 栈优化

```
问题：
  ① 为什么 LogStream 继承 outputStream 而非直接实现 write() 方法集合？
      答案方向: outputStream (utilities/ostream.hpp) 是 HotSpot 全局的格式化输出抽象。
      它提供 30+ 方法：`print()`、`print_cr()`、`print_raw()`、`fill_to()`、`put()`、
      `indent()`、`hexdump()`、`bol()`、`cr()`、`reset()`、`time_stamp()` 等。
      LogStream 只覆写 `virtual void write(const char* s, size_t len)` (logStream.cpp:104-113)，
      继承所有 `print*` 方法——因为它们最终都委托给 `write()`。
      继承意味着：
        `obj->print_on(log_stream)` — 任何有 print_on(outputStream*) 方法的对象
        可以直接记录到日志！
        `klass->print_on(log_stream)` / `method->print_on(log_stream)` etc.
      这是一个强大的"对象可日志化"设计——日志系统获得了 HotSpot 整个 print_on 生态。
      无继承意味着重复实现 30+ 方法或根本放弃流式接口。

      追问: 为什么 constructor 禁止 new 操作符分配 LogStream？
      → logStream.hpp:60-61 将 `operator new` 设为 private: LogStream 设计为栈分配对象。
        析构函数自动 flush LineBuffer —— 如果分配在堆上且无人 delete，日志内容丢失。

  ② Counterfactual: 如果 LineBuffer 不使用 64 字节栈优化，始终从堆分配？
      答案方向: 每次创建 LogStream → 1 次 os::malloc(64) ≈ 50-100ns。
      如果 GC 日志每秒 10K 次 LogStream 创建 → 10K × 50ns = 500µs/s → 0.05% CPU on malloc。
      似乎可接受，但加上 `os::free` 在析构时（50ns）→ 1ms/s。
      真正的问题不是 CPU 而是：
        1. malloc 内部需要获取 arena 锁（多线程竞争）
        2. malloc 产生额外内存碎片
        3. 64 字节行覆盖 80% 以上的日志场景——malloc 不值得
      当前设计：_buf 初始指向 `_smallbuf[64]` (logStream.cpp:29-30)，
      只有 `try_ensure_cap(atleast > 64)` 才 malloc (logStream.cpp:48-54)。
      对于 30-80 字节典型行 → 零堆分配。
```

### 4.3 ★★★ LogMessage 延迟格式化 — 多行原子性的引擎

```
问题：
  ① LogMessage 如何保证多行消息不会被其他线程的日志插入？
      答案方向: logMessage.hpp:63 "inherits LogMessageBuffer":
        - LogMessageBuffer 内部维护 `_lines[]` + `_message_buffer[]` 双平行数组
        - msg.debug("line1") → vwrite(Debug, "line1", ...) → os::vsnprintf 立即格式化
          → 结果存入 _message_buffer + 记录 _lines[_line_count] = {Debug, offset}
        - msg.trace("line2") → 同上但 level=Trace
        - 析构函数 (logMessage.hpp:72-76): if (_has_content) { flush(); }
        - flush() (logMessage.hpp:78-81): _log.write(*this) → LogTagSet::log(LogMessageBuffer)
        - LogTagSet::log() (logTagSet.cpp:75-87) 获取一个 Iterator 遍历所有 output
          → 在这个遍历中完整输出所有行 → 多行作为一个整体进入 Output Pipeline
      
      关键：LogMessage 抢占的不是"写入时"的排他性（多个 LogMessage 可以同时写入
      各自 buffer）——它抢占的是"输出时"的连续性：LogTagSet::log() 获得 Iterator
      后在一个遍历事务中输出所有行。而单行 log_debug 每个调用都独立获取 Iterator。

      追问: _has_content 标志的设计目的是什么？
      → 如果 LogMessage 构造后作用域中条件不满足（if (!msg.is_debug())），没有任何
        vwrite 调用 → _has_content = false → 析构时跳过 flush → 零开销空对象。
        对比：如果总是 flush → 每次 LogMessage 出作用域都调用 _log.write(empty_buffer)
        → 遍历 Iterator 发现没内容 → 浪费 CPU。

  ② Counterfactual: 如果不用 LogMessageBuffer 而用 std::stringstream 累积多行再输出？
      答案方向: std::stringstream 在 product build 不可用（HotSpot 不使用 C++ iostream）。
      即使自定义实现：string 拼接会产生多次 realloc。
      LogMessageBuffer 的 vwrite 2-attempt 策略：
        第一次：直接用当前缓冲区容量尝试 vsnprintf。如果溢出（`written > remaining`）:
        第二次：grow() 扩容到需要的大小，再 vsnprintf。
      这避免了 stringstream 的"逐字符/逐段 append + 多次 grow"。
      _lines[] 数组记录行边界而非重复存储 message 内容——message_buffer 是连续块，
      不做字符串复制（只做一次 vsnprintf 格式化到 message_buffer 末尾）。
```

### 4.4 ★★★ LogMessageBuffer — 双平行数组 + 2-attempt vwrite

```
问题：
  ① vwrite() 的 2-attempt 策略如何保证一次成功？为什么不是 1 次？
      答案方向: logMessageBuffer.cpp:86-131:
        1. attempts=0: vsnprintf 到现有剩余空间。如果 written > remaining → 
           不要紧，grow(buffer, capacity, new_cap_needed) → continue (attempts=1)
        2. attempts=1: buffer capacity 已扩大到 >= 所需 → vsnprintf 必定成功
        
      断言 (logMessageBuffer.cpp:116) 确保 attempt=1 不会再次溢出。
      
      追问: 为什么用 va_copy（logMessageBuffer.cpp:112-114）？
      → vsnprintf 消费 va_list 后 va_list 失效。两次 attempt 需要两次 vsnprintf ——
        第一次可能失败（空间不够），第二次必须重新格式化整个字符串。va_copy 保存 args
        副本供第二次使用。这是 C++ varargs 的局限——va_list 是单向迭代器，不可回退。
      
      追问: grow() 的加倍扩容策略 `capacity * 2` (logMessageBuffer.cpp:31) 的含义？
      → 与 std::vector 相同的 amortized O(1) 策略。如果每次都按 precise needed 扩容，
        频繁日志调用会导致频繁 realloc —— O(n) per append。加倍保证下一次扩容的时机
        指数增长。

  ② Counterfactual: 如果 _message_buffer 是一条连续字符串（无 _lines[] 索引），
      用 '\n' 做行分隔符而非 LogLine 结构数组？
      答案方向: 
        当前设计: `_lines[_line_count] = {level, message_offset}` — O(1) 定位任一行 
        + 每行独立 level 信息。
        用 '\n' 分隔: 迭代时需要 `strchr(message_buffer, '\n')` 线性扫描，
        无法知道第 N 行的 level — 除非在每行前加 level 前缀字节（破坏可读性）。
        更关键：Iterator::skip_messages_with_finer_level() (logMessageBuffer.cpp:71-77)
        需要在遍历时跳过 level < filter_level 的行 —— 当前设计直接读 `_lines[i].level`
        做比较，'\n' 分隔则需要解析字符串查找 level 标记。
```

### 4.5 ★★★ LogHandle 类型擦除 — 为什么不能用模板传播到所有 API

```
问题：
  ① LogHandle / LogTargetHandle 解决了什么具体问题？
      答案方向: 考虑一个函数签名：
        无 LogHandle: `template <LogTagType T0, LogTagType T1, ...> 
                        void do_log(const LogImpl<T0,T1,...>& log)`
        有 LogHandle: `void do_log(const LogHandle& handle)`
      
      第一个版本的问题：
        1. 调用者每次都要带模板参数 → `do_log<LogTag::_gc, LogTag::__NO_TAG, ...>(my_log)`
        2. 函数定义必须在头文件中（模板）
        3. 函数签名依赖于 LogTag 枚举值 → ODR 敏感 → 链接错误风险
        4. 不能存为类的成员变量（除非类本身也变成模板）
      
      LogHandle 存储 `LogTagSet* _tagset` (logHandle.hpp:35) — 一个运行时指针。
      所有 vwrite/vprint 调用直接走 `_tagset->vwrite()` 路径。
      代价：失去"编译期知道 level"的优势 — `LogTargetHandle` 补偿了这点
      (logHandle.hpp:78-79: `const LogLevelType _level` + `LogTagSet* _tagset`)。
      
      追问: LogTargetHandle::create<level,T0,...>() 静态工厂方法 (logHandle.hpp:86-89)
      为什么需要？
      → 允许在不持有 LogTargetImpl 实例的情况下创建 handle：
        `auto handle = LogTargetHandle::create<LogLevel::Debug, LogTag::_gc>();`
        不依赖现有 LogImpl 实例的拷贝构造。

  ② Counterfactual: 如果所有使用日志的代码都直接使用 LogImpl<...> 模板类型？
      答案方向: 代码膨胀 — 每个使用日志的函数变成模板函数 → 实例化 N 个不同版本
      （每个 tag 组合一个版本）→ .text 段爆炸。以 `Thread::print_on(outputStream*)`
      假设调用 Log(gc,classhisto) → 200 个不同 tag 组合都在不同翻译单元中被实例化
      → 每个产生 ~200 字节代码 → 40KB 额外代码仅为一个 print_on 方法。
      LogHandle 的运行时指针方案 → 所有 tag 组合共享同一个函数体 → 零实例化膨胀。
      但运行时指针丢失了编译期内联机会 → `is_level()` 原来是内联的（直接访问 _output_list
      成员），现在必须在 _tagset 指针上间接调用 → ~2ns 额外延迟 per call。
```

### 4.6 ★★★ LogDecorations — 运行时性能分级与静态缓存

```
问题：
  ① 12 个装饰器在性能上分几级？每级的开销来源是什么？
      答案方向: 三级性能分类：
        Level 0 — 零/一次开销（静态缓存）:
          - hostname: _host_name static const char* (logDecorations.hpp:41)
             → jio_snprintf 一次字符串复制 ~10ns
          - pid: os::current_process_id() 返回 static 缓存值 → ~5ns
          - level: dynamic — 但 `decoration()` (logDecorations.hpp:59-63) 
            特殊处理 level_decorator，返回 `LogLevel::name(_level)` 而非预计算值
             → 通常 ~5ns 指针查找
          - tags: _tagset.label() (logDecorations.cpp:128-129) → 遍历 tags 数组
             → ~20ns for 3 tags
          
        Level 1 — 每次计算（轻量）:
          - timemillis: java_millis() (logDecorations.cpp:61-66) — 首次调用 os::javaTimeMillis()
             → 后续返回缓存 _millis → 首次 ~100ns, 后续 ~5ns
          - uptimemillis: java_millis() - _vm_start_time_millis → ~10ns
          - tid: os::current_thread_id() → ~10ns
          
        Level 2 — 每次 syscall/系统函数（重量）:
          - time: os::iso8601_time() → localtime_r + snprintf → ~500ns
          - utctime: os::iso8601_time(true) → gmtime_r + snprintf → ~500ns
          - uptime: os::elapsedTime() → clock_gettime 或 /proc/uptime → ~200ns
          - timenanos: os::javaTimeNanos() → clock_gettime CLOCK_MONOTONIC → ~50ns
          - uptimenanos: os::elapsed_counter() → RDTSC 或 clock_gettime → ~20ns
      
      追问: 为什么 java_millis() 做一次 lazy 缓存但在一个 LogDecorations 对象范围内？
      → logDecorations.cpp:61-66: `if (_millis < 0) { _millis = os::javaTimeMillis(); }`
        _millis 初始化为 -1 (logDecorations.cpp:36)。首次调用时计算，后续复用。
        但 LogDecorations 是每次日志行都创建的临时对象（在 LogTagSet::vwrite() 栈上）
        → 所以每行的 _millis 都要重新计算一次（_millis = -1 per construction）。
        这个缓存只在"同一行日志中多次使用 time 装饰器"情况下有效——实际上装饰器
        只被调用一次（create_decorations 每个 decorator 运行一次），所以缓存没意义？
        但 java_millis 也可能被 uptimemillis 和 timemillis 两个装饰器同时调用——
        此时 lazy 缓存避免了重复 syscall。

  ② Counterfactual: 如果所有装饰器都每次重新计算（无 static _host_name 缓存）？
      答案方向: hostname 装饰器下 100K/s 日志行：
        每行 gethostname(2) → syscall 约 200ns + 内核时间约 300ns → 500ns
        100K/s × 500ns = 50ms/s = 5% CPU 纯在获取永远不变的 hostname。
        加上 uptime 每次 clock_gettime(~200ns) + timemillis 每次(~100ns)
        + pid 每次 getpid(~100ns) → 100K × 900ns = 90ms/s = 9% CPU。
        默认 3 个装饰器（uptime, level, tags）已经合理：uptime 需要每次计算
        （它确实在增长），level 和 tags 极轻量。用户添加 hostname 装饰器时的
        额外开销 ~10ns（仅 printf 缓存值），而非 ~500ns（syscall）。
```

### 4.7 ★★★ LogDecorators 位掩码解析 — 枚举 + 位图 + 逗号分割

```
问题：
  ① DECORATOR_LIST 如何在同一文件中产生 enum 值 + 字符串名称 + 位掩码？
      答案方向: 三处差异化 #define DECORATOR:
        1. enum Decorator (logDecorators.hpp:61-67):
           #define DECORATOR(name, abbr) name##_decorator,
           → time_decorator=0, utctime_decorator=1, ..., tags_decorator=11, Count=12, Invalid=13
        2. _name[][2] (logDecorators.cpp:30-34):
           #define DECORATOR(n, a) {#n, #a},
           → {"time","t"}, {"utctime","utc"}, ..., {"tags","tg"}
        3. create_decorations() (logDecorations.cpp:50-58):
           #define DECORATOR(full_name, abbr) \
             if (decorators.is_decorator(...)) { create_##full_name##_decoration(position); }
           → 对每个装饰器，检查位掩码中有无对应位，有则调用计算方法
      
      追问: from_string() 的二分查找顺序是什么？
      → 线性扫描 (logDecorators.cpp:36-44): for i=0..Count → strcasecmp str against 
        name(d) 和 abbreviation(d)。O(12) 遍历，Count=12 小到不需要二分。
        strcasecmp 确保 "TIME"/"time"/"Time" 都能匹配。

  ② Counterfactual: 如果装饰器不使用位掩码（`uint _decorators`）而用 bool 数组 `bool _active[Count]`？
      答案方向: bool 数组 = 12 字节（vs 4 字节 uint），内存占用 3×。
        位操作 `mask & (1<<decorator)` (logDecorators.hpp:74-75) vs 数组访问 `_active[decorator]` — 
        两者都是单指令，性能无差异。is_empty() `_decorators == 0` vs `for i..Count if _active[i]` — 
        位掩码版本 1 指令 vs 最多 12 次比较。
        combine_with `_decorators |= source._decorators` vs `for i..Count _active[i] |= src._active[i]` — 
        位掩码 1 指令 vs 12 次 OR 赋值。
        关键 win: parse() 的 tmp_decorators |= mask(d) — 收集 3 个装饰器只需 3 条 OR 指令。
```

### 4.8 ★★★ logPrefix.hpp — 跨行统一前缀协议

```
问题：
  ① LOG_PREFIX_LIST 的 42 个条目全部是 gc 家族 —— 为什么？perf 或其他子系统不需要前缀？
      答案方向: logPrefix.hpp:45-90 列出 42 个 tagset，都用 `GCId::print_prefix` 作为前缀函数。
      GC 是唯一需要前缀的子系统，因为 GC 周期有明确的"编号"语义 —— GC(15) 标识第 15 次 GC。
      其他子系统（jit, class, thread, etc.）的日志每个事件独立无编号。
      
      前缀写入机制：LogTagSet::vwrite() (logTagSet.cpp:110-139) 调用 LogPrefix<T0,T1,...>::prefix(buf,len)
      → 返回 0（无前缀）或 N（写入 N 字节前缀）。
      GCId::print_prefix(char* buf, size_t len) 输出 "GC(15) " → 占用约 7 字节。
      这个 prefix 写入到 LogMessageBuffer 的 message_buffer 中（logMessageBuffer.cpp:101-109），
      在所有行之前共享同一个前缀。

      追问: 默认 LogPrefix<T...> 模板的 prefix() 为什么返回 0 而非空字符串？
      → 返回 0 告知调用者"没有前缀要写" — 调用者跳过任何前缀相关处理。
        如果返回空字符串 "" → 写入 '\0' 到 buffer → 后续 strcat/strlen 会在空字节处截断
        → 破坏 message 内容。0 是明确的"跳过"信号。

  ② Counterfactual: 如果前缀不被自动添加到 LogMessageBuffer，而是每个 GC 日志调用点
      手动 `log_debug(gc)("GC(%u) heap: before=%zu after=%zu", gc_id, before, after)`？
      答案方向: GCC id 每次 GC 递增 → GC 子系统中 ~200 个日志调用点都要手动传递 gc_id。
      如果某个调用点忘记传递 → 日志行缺失 GC ID → 无法关联前后日志 → 排查困难。
      如果 gc_id 传递错误（传了旧的） → 误导分析。
      LOG_PREFIX_LIST 的自动前缀机制：所有带 gc tag 的日志行自动获得 GC(id) 前缀，
      调用者无需知道 gc_id。但代价是 tagset 注册粒度膨胀：每个 `gc,foobar` 组合需要
      单独一行 `LOG_PREFIX(GCId::print_prefix, LOG_TAGS(gc, foobar))` 注册。
```

### 4.9 ★★★ LOG_LEVEL_LIST 的三处差异化展开（附加组）

```
问题：
  ① LOG_LEVEL_LIST 在 LogImpl / LogHandle / LogMessageBuffer 三处的展开有什么不同？
      答案方向: 同一宏 LOG_LEVEL(level, name) 在三处定义不同行为：
        
        LogImpl (log.hpp:156-175):
          LOG_LEVEL(level, name):
            - v##name(char* fmt, va_list) → vwrite(LogLevel::level, fmt, args)
            - name(const char* fmt, ...) → va_start + vwrite + va_end
            - is_##name() → is_level(LogLevel::level)
            - name() → 返回 LogTargetImpl<level, T0,...>* = NULL（类型携带者指针）
        
        LogHandle (logHandle.hpp:50-67):
          LOG_LEVEL(level, name):
            - v##name → _tagset->vwrite(LogLevel::level, fmt, args)
            - name → va_start + _tagset->vwrite + va_end
            - is_##name → _tagset->is_level(LogLevel::level)
            （无 name() 返回 LogTarget，因为 LogHandle 不知道模板信息）
        
        LogMessageBuffer (logMessageBuffer.cpp:133-146):
          LOG_LEVEL(level, name):
            - v##name → vwrite(LogLevel::level, fmt, args); return *this
            - name → va_start + vwrite + va_end; return *this
            （无 is_##name 检查——buffer 不做 level 过滤，存储时记录 level，
             输出时由 Iterator::skip_messages_with_finer_level() 过滤）
        
      设计优势：添加一个新 level (如 Fatal) → 需修改 LOG_LEVEL_LIST 加一行 →
        三处自动生成对应方法 → 编译器保证一致性（如果某处忘记，编译失败）。

  ② Counterfactual: 如果三个类各自手写 5 个 level 方法而非用 LOG_LEVEL_LIST？
      答案方向: 5 levels × 每个 2-4 个方法 × 3 classes = 30-60 个独立方法。
        每个方法 ~5 行 = 150-300 行重复代码。
        添加新 level: 修改 3 个文件的 3-5 处 → 可能遗漏一处 → 编译通过但运行时
        行为不一致（某种 logging 方式无新 level 方法）。
        当前：修改 1 行 LOG_LEVEL_LIST → 3 处自动生成 → 零遗漏风险。
```

---

## §五 Article Structure

```
§〇 生产场景
  ★ Scenario 1: Log vs LogMessage — 多行日志线程间交替插入
  ★ Scenario 2: LogStream 行缓冲未 flush — print 后忘记 cr()
  ★ Scenario 3: 装饰器性能灾难 — hostname 每行 gethostname 本可静态缓存
  ★ Counterfactual: 无 LogMessage → GC 日志永远无法原子输出

§一 ★★★ 三层宏 API + LogStream/LogMessage + 装饰器 全链路源码
  ❓ log_debug(gc)("msg") 这一行 C++ 代码背后的 11 步执行路径
  1.1 宏展开: LOG_TAGS(gc) → PREFIX_LOG_TAG → LogTag::_gc → 模板参数
  1.2 表达式守卫: ternary ?: — is_enabled 为 false 时不求值参数
  1.3 Log 类 API: LogImpl<...> 的 LOG_LEVEL_LIST 展开产生 5 个 level 方法
  1.4 LogTarget API: LogTargetImpl<level,...> — 级别内嵌 + print() 便捷方法
  1.5 LogStream 流式接口: outputStream 继承 + LineBuffer 栈优化 + \n flush
  1.6 LogMessage 延迟格式化: 多行缓冲 + 析构时 flush 保证原子性
  1.7 LogMessageBuffer 引擎: 双平行数组 + 2-attempt vwrite + 懒分配
  1.8 LogHandle 类型擦除: 模板→运行时 LogTagSet* 指针 + API 简洁化
  1.9 LogDecorations 运行时计算: 12 个装饰器三级性能分类
  1.10 LogDecorators 位掩码: DECORATOR_LIST X-MACRO + from_string + parse
  1.11 logPrefix.hpp 跨行前缀: 42 gc tagset 自动 GC(id) 前缀
  1.12 ★ Mermaid: 消息构造全链路序列图 (Lanes: User Code / Macro Layer / LogStream / LogMessage / LogMessageBuffer / LogTagSet)
  1.13 ★ 面试 Story Format 答案

§二 ★★★ 7 个 Beginner Callout 框
  2.1 Ternary guard — ternary 是表达式, if 是语句
  2.2 outputStream 继承 — 获得 30+ print 方法生态
  2.3 LineBuffer 栈优化 — 64 字节避免 malloc
  2.4 LogMessage defer — 格式化立即执行但 flush 延迟
  2.5 LogHandle 类型擦除 — 避免模板传播到所有 API
  2.6 静态装饰器值 — hostname + start_time 单次初始化
  2.7 LOG_LEVEL_LIST 三处展开 — 一处修改、三处同步

§三 ★★★ LogStream 与 LogMessage 对比分析
  ❓ 何时用 LogStream、何时用 LogMessage、何时用 log_debug 宏
  ❓ 三者在性能、原子性、接口类型上的对比
  3.1 使用场景矩阵: 单行 / 多行 / 流式 / 原子性需求
  3.2 LogStream 析构 flush 陷阱 — 忘记换行的日志"失而复得"机制
  3.3 LogMessage 的 _has_content 零开销优化
  3.4 LogStream 的 LineBuffer 扩容阈值 — 64→256→512... 直到 1M cap
  3.5 LogMessageBuffer 的 1024 初始消息缓冲 + 10 行初始行容量
  3.6 通过 LogTargetHandle::print() 桥接 LogStream → LogTagSet::vwrite()

§四 ★★★ 装饰器系统源码剖析
  ❓ -Xlog:gc=debug:time,level,tags 中的 time,level,tags 怎么变成 [2024-01-15T10:30:00.123+0000][debug][gc]
  ❓ 为什么 level 装饰器有特殊处理
  4.1 DECORATOR_LIST X-MACRO 双重展开: enum + _name[] 字符串
  4.2 DefaultDecoratorsMask = uptime | level | tags — 默认三个的最小集合
  4.3 from_string() — strcasecmp 对全名和缩写都做匹配
  4.4 parse() — comma 分隔 + 错误输出到 errstream
  4.5 create_decorations() — macro for-each 调用位掩码检查 + 计算
  4.6 13 个 create_*_decoration() 各自实现:
    4.6.1 time — os::iso8601_time (localtime_r) → 固定 29 字节
    4.6.2 utctime — os::iso8601_time (gmtime_r) → 固定 29 字节
    4.6.3 uptime — os::elapsedTime() → "%.3fs" 格式
    4.6.4 timemillis — java_millis() with lazy cache → INT64_FORMAT "ms"
    4.6.5 uptimemillis — java_millis() - _vm_start_time_millis
    4.6.6 timenanos — os::javaTimeNanos() → INT64_FORMAT "ns"
    4.6.7 uptimenanos — os::elapsed_counter()
    4.6.8 pid — os::current_process_id() → "%d"
    4.6.9 tid — os::current_thread_id() → INTX_FORMAT
    4.6.10 level — 特殊: create_level_decoration 返回 pos（不写），decoration() 动态返回 LogLevel::name
    4.6.11 tags — _tagset.label() 字符串数组遍历
    4.6.12 hostname — jio_snprintf static _host_name 缓存
  4.7 ASSERT_AND_RETURN 宏 — 装饰器缓冲区溢出断言（256 字节可用）
  4.8 ★ Counterfactual 对比表: 静态缓存 vs 每次重算的性能差异

§五 ★★ logPrefix.hpp — GC 周期前缀协议
  ❓ 为什么 42 个 gc tagset 都有 GCId::print_prefix
  ❓ 前缀如何写入 message_buffer 而不是 decorator buffer
  5.1 LogPrefix<T...> 默认模板 — prefix() 返回 0 (无前缀)
  5.2 LOG_PREFIX 宏特化 — 为特定 tagset 绑定自定义 prefix 函数
  5.3 GCId::print_prefix 的实现来源（gc/shared/gcId.hpp）
  5.4 vwrite 中 prefix_fn 的调用时机: 在 vsnprintf 之前，在 message_buffer 中
  5.5 前缀不参与 LogOutput::write_decorations — 只存在于 message body

§六 ★ GDB 断点验证 — ≥7 断点
  断言 1: log.hpp:49 log_debug 宏展开 — 验证 ?
  断言 2: logStream.cpp:107 \n flush 分支 — 验证 _current_line.buffer()
  断言 3: logStream.cpp:117 析构 flush — 验证 is_empty() 和 buffer 内容
  断言 4: logMessageBuffer.cpp:86 vwrite entry — 验证 _allocated 初始状态
  断言 5: logMessageBuffer.cpp:117 grow overflow — 验证 2-attempt 策略
  断言 6: logMessage.hpp:73 析构 flush — 验证 _has_content 和 _line_count
  断言 7: logDecorations.cpp:49 create_decorations — 验证 bitmask 和 offset 指针
  断言 8: logDecorations.cpp:132 create_hostname — 验证 _host_name static 缓存
  断言 9: logHandle.hpp:39 LogHandle 构造 — 验证 _tagset 非 NULL

§七 ★ Cross-Reference
  ❓ 00-Tag-Level-Selection-Configuration — log_is_enabled() 是本文宏的入口守卫
  ❓ 01-Output-Pipeline — logTagSet::vwrite() 调用 LogOutput::write() 进入输出管道
  ❓ 01-jvm-startup — LogConfiguration::initialize() 调用 LogDecorations::initialize()
```

---

## §六 Writing Requirements

核心原则：每个段落以 WHY 开头，源码是证据（20%），原理是正文（80%）。**不要写成宏展开的机械翻译** — 要解释设计意图、性能权衡、和替代方案。

1. **每个技术断言标注精确 file:line** — 所有宏定义、类方法、函数实现必须标注。例："`LogImpl::vwrite()` (log.hpp:152-154) 直接委托给 `LogTagSetMapping::tagset().vwrite()` — 这是模板类到运行时 TagSet 的桥接点"。

2. **源码引用 3-5 行代码片段** — 关键路径（log.hpp 三层宏、logStream::write、logMessage::vwrite、logMessageBuffer::vwrite、logDecorations::create_decorations）直接粘贴源码，不做翻译描述。

3. **Mermaid 序列图** — 消息构造全链路序列图，5 lanes: User Code / Macro Layer (log.hpp) / LogStream or LogMessage / LogMessageBuffer / LogTagSet。从 `log_debug(gc)("msg")` 到 `LogTagSet::vwrite()` 的完整路径。标注每一步的 file:line 和数据类型转换。

4. **GDB 会话** — ≥7 个断点，精确到 file:line，每断点有预期变量值和验证目的。

5. **7 个 Callout 框** — exact text from §一，每个含 "为什么这样设计" 的解释。

6. **Interview Story Format 答案** — §一末尾的叙事：`log_debug(gc)("msg")` 从宏展开到装饰器值计算的完整 11 步路径。

7. <!--->**三层 API 对比矩阵**：在 §三 中，对 log_* 宏 vs Log vs LogTarget 做 feature 对比表（表达式可用 / 参数惰性 / 流式接口 / 级别固定 / 多次输出 / 编译期开销 / 运行时开销）。

8. **"不要写成 → 应该写成"对照表**（至少 8 行）：

| 不要写成 | 应该写成 |
|---------|---------|
| "log_debug 是日志宏" | "`log_debug(gc)` (log.hpp:49) 展开为 `?:(void)0 : LogImpl<_gc>::write<Debug>` — C++ 三元表达式守卫确保禁用时不求值 printf 参数。`LOG_TAGS(gc)` → `EXPAND_VARARGS(LOG_TAGS_EXPANDED(gc, _NO_TAG, ...))` → `PREFIX_LOG_TAG(gc) → LogTag::_gc` — 所有字母 tag 在编译期转换为枚举值" |
| "LogStream 支持流式输出" | "LogStream 继承 `outputStream` (logStream.hpp:34)，只覆写 `virtual write(s, len)` (logStream.cpp:104-113)，继承 `print()`/`print_cr()`/`hexdump()`/`indent()` 等 30+ 方法 — 任何实现 `print_on(outputStream*)` 的对象都可以直接输出到日志" |
| "LineBuffer 有内存管理" | "LineBuffer 使用 `_smallbuf[64]` 栈优化 (logStream.cpp:29-30)：80% 日志行 ≤ 64 字节时零堆分配。仅超长行触发 `try_ensure_cap()` (logStream.cpp:46-77) malloc，上限 1MB (logStream.cpp:50) 防止失控内存增长 — 超 1MB 时截断并打印 `log_info(logging) Suspicously long log line` (logStream.cpp:59-60)" |
| "LogMessage 保证多行原子性" | "LogMessageImpl (logMessage.hpp:63) 继承 LogMessageBuffer，每行 `vwrite()` (logMessage.hpp:89-95) 将格式化结果写入 `_message_buffer` + 记录 `_lines[].level`。析构函数 (logMessage.hpp:72-76) 一次性 `_log.write(*this)` → `LogTagSet::log(msg)` (logTagSet.cpp:75-87) 在一个 `LogOutputList::Iterator` 遍历中输出所有行，杜绝其他线程半路插入" |
| "LogDecorations 计算装饰器值" | "create_decorations() (logDecorations.cpp:48-59) 通过 `DECORATOR_LIST` X-MACRO 遍历 12 个装饰器，对每个装饰器调用 `decorators.is_decorator()` (logDecorators.hpp:109-111) 做位掩码 `_decorators & mask(decorator)` 检查 → 如果启用，调用对应的 `create_*_decoration(position)` 写入 `_decorations_buffer[256]` 栈缓冲 → 记录 `_decoration_offset[decorator] = position` 指针" |
| "LogHandle 简化模板 API" | "LogHandle (logHandle.hpp:33-67) 将 `LogImpl<T0,T1,...>` 模板实例的类型信息擦除为 `LogTagSet* _tagset` 运行时指针 (logHandle.hpp:35)。构造时从 `LogTagSetMapping<T0,...>::tagset()` 提取地址 (logHandle.hpp:39-40) — 之后所有 `vdebug()`/`vtrace()` 调用直接走 `_tagset->vwrite()` 纯虚接口，零模板依赖" |
| "LOG_PREFIX_LIST 给 gc 加前缀" | "logPrefix.hpp:45-90 的 42 个 `LOG_PREFIX(GCId::print_prefix, LOG_TAGS(gc, ...))` 条目为所有含 gc tag 的 tagset 自动绑定 `GCId::print_prefix` 函数 (gc/shared/gcId.hpp)。在 LogMessageBuffer::vwrite() (logMessageBuffer.cpp:101-109) 中，`_prefix_fn` 先于 vsnprintf 被调用 — 写入 "GC(15) " 到 message_buffer 头部 — 所有行共享同一前缀，调用者无需手动传递 gc_id" |
| "装饰器位掩码优化" | "`LogDecorators::_decorators` 是 `uint` 位掩码 (logDecorators.hpp:70)，12 个 decorator 各占 1 bit。`is_decorator()` (logDecorators.hpp:109-111) 只需 `_decorators & (1 << decorator)` — 单条 AND 指令。`combine_with()` (logDecorators.hpp:101-103) 只需 `_decorators |= source._decorators` — 单条 OR 指令。对比 bool 数组方案：检查和合并都需要循环 12 次" |
| "LogMessageBuffer 懒分配" | "LogMessageBuffer 构造函数 (logMessageBuffer.cpp:39-48) 设置 `_message_buffer=NULL`、`_allocated=false`。首次 `vwrite()` (logMessageBuffer.cpp:87-89) 调用 `initialize_buffers()` (logMessageBuffer.cpp:62-69): `NEW_C_HEAP_ARRAY(char, 1024)` + `NEW_C_HEAP_ARRAY(LogLine, 10)`。如果 LogMessage 在作用域内从未写入内容 → 零堆分配、零释放 — `_has_content=false` 跳过析构 flush" |

9. **交叉引用** — 至少 3 处标注前/后文档依赖。

---

## §七 Output Format

- Markdown file, named `02-Message-Composition-Macros.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/23-logging/docs/`

元信息头：

```
> **阶段**：[23-logging]
> **前置**：[00-Tag-Level-Selection-Configuration]（log_is_enabled 守卫 + LogTagSetMapping 模板 → 本文宏入口）、[01-Output-Pipeline]（LogOutput::write() → 接收本文构造的消息字符串）
> **配套**：[00-Tag-Level-Selection-Configuration]、[01-Output-Pipeline]
> **后续依赖本文**：[24-utilities] — 所有使用 log_debug/log_info/LogStream 的子系统
> **阅读收益**：追踪 log_debug(gc)("msg") 从宏展开到装饰器值计算的完整 11 步执行路径 — 理解 LOG_TAGS 的编译期 tag→枚举转换、三元表达式守卫的参数惰性求值、Log/LogTarget 两层类 API 的设计分工、LogStream 的 outputStream 继承与 LineBuffer 栈优化、LogMessage 的多行原子缓冲与 LogMessageBuffer 双平行数组引擎、LogHandle 的类型擦除桥接、LogDecorations 的 12 装饰器三级性能计算分类、以及 LOG_PREFIX_LIST 的 GC 周期自动前缀协议
```

- 目标行数: ≥450 行文档

---

## §八 Prohibited（≥8）

- ❌ 不要写成 "log_debug 展开为 X" 的机械宏翻译 — 必须解释 WHY：为什么用 ?: 而非 if、为什么有 Log 类而非只有宏、为什么 LogTarget 独立存在
- ❌ 不要只说 "LogStream 继承 outputStream" — 必须展示继承获得了什么（print_on 生态、hexdump、indent），以及只覆写一个 `write()` 就能获得所有功能的设计含义
- ❌ 不要忽略 LineBuffer 的 64 字节栈优化 — 必须展示 `_smallbuf` → `_buf` 的初始指向 + `try_ensure_cap` 的扩容阈值 + 1MB cap 防失控
- ❌ 不要只说 "LogMessage 延迟格式化" 而不分析延迟了什么 — 格式化仍在调用时执行（vsnprintf 即时），延迟的是 flush 到 output 的时机（析构时一次性批量输出）
- ❌ 不要跳过 LogMessageBuffer 的 2-attempt vwrite — 必须展示第一次 vsnprintf 可能 overflow → grow → 第二次必定成功（assert）的乐观策略
- ❌ 不要忽略 LogHandle 的类型擦除目的 — 必须解释 `LogTagSet* _tagset` 替代 6 个模板参数如何简化函数签名、减少代码膨胀
- ❌ 不要说 "装饰器系统很灵活" — 必须展示 DECORATOR_LIST 如何驱动 3 种展开（enum + _name[] + create_*_decoration 调用）、位掩码的效率和 DefaultDecoratorsMask 的含义
- ❌ 不要跳过 logPrefix.hpp 的 42 个 gc 条目 — 必须解释为什么只有 gc 需要前缀、前缀的写入时机（在 vsnprintf 之前而非 decorations 之中）、默认模板返回 0 的语义
- ❌ 不要忽略 `_has_content` 标志 — 必须展示它如何使空的 LogMessage 零开销（跳过析构 flush）
- ❌ 不要把 LogMessageBuffer 和 LogStream::LineBuffer 混淆 — LogMessageBuffer 存多行结构化数据（lines[] + message_buffer[]），LineBuffer 存一行平文本（char[]），职责完全不同

---

## §九 Required（≥8）

- ✅ **★ Mermaid 消息构造全链路序列图** — 5 lanes: User Code / Macro Layer / LogStream or LogMessage / LogMessageBuffer / LogTagSet。标注每一步 file:line。完整流程：`log_debug(gc)("msg")` → ternary ?: guard → LogImpl::vwrite → LogPrefix::prefix → LogDecorations construction → LogOutputList::Iterator → write(decorations, msg)
- ✅ **★ log.hpp 三层 API 源码完整展示** — 并排展示 `log_debug` macro (log.hpp:49) + `Log(...)` macro (log.hpp:87) + `LogTarget(...)` macro (log.hpp:105) + `LogImpl` template LOG_LEVEL_LIST expansion (log.hpp:156-175)
- ✅ **★ LogStream::write() 完整源码** — logStream.cpp:104-113，标注 \n flush 分支和析构 flush 分支
- ✅ **★ LogMessage::vwrite() + flush() 完整源码** — logMessage.hpp:89-95 + :78-81，标注 prefix 设置和原子 flush 路径
- ✅ **★ LogMessageBuffer::vwrite() 完整 2-attempt 源码** — logMessageBuffer.cpp:86-131，标注 va_copy 原因和 grow 溢出处理
- ✅ **★ LogDecorations::create_decorations() 完整源码** — logDecorations.cpp:48-59，展示 DECORATOR_LIST macro for-each 如何驱动装饰器计算
- ✅ **★ 13 个 create_*_decoration() 分级展示** — 按性能分 Level 0/1/2 三级，每级含开销分析和 syscall 依赖
- ✅ **★ 7 个 Beginner Callout 框** — exact text from §一，不重复不遗漏，每个含设计 rationale
- ✅ **★ Interview Story Format 答案** — §一末尾叙事：11 步从宏到装饰器的完整链
- ✅ **★ "不要写成→应该写成"对照表** — 至少 9 行（已提供），每行左列是浅层描述，右列是含 file:line + 机制解释
- ✅ **★ 三层 API 对比矩阵** — 在 §三 中对比 log_* / Log / LogTarget 的功能维度
- ✅ **★ LOG_LEVEL_LIST 三处差异化展开对比** — 展示 LogImpl/LogHandle/LogMessageBuffer 对同一宏的不同 #define

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: log_debug 宏的三元守卫 (log.hpp:49)
  (gdb) break logTagSet.hpp:114  // is_level() return
  在 Java 代码触发 log_debug(gc)("test") 前/后:
  (gdb) print this->_output_list → 期望: 查看内部级别设置
  (gdb) finish → print return → 期望: true/false 控制三元表达式走哪条分支
  (gdb) 用 GDB 的 `set` 修改级别 → 验证 ?: 分支切换

断言 2: LogStream::write \n flush 分支 (logStream.cpp:107)
  (gdb) break logStream.cpp:107
  (gdb) print s[len-1] → 期望: '\n'
  (gdb) print _current_line.buffer() → 期望: 之前累积的行内容（不含\n）
  (gdb) continue 经过 _log_handle.print
  (gdb) print _current_line.buffer() → 期望: "" (reset 后被清空)
  (gdb) print _current_line.is_empty() → 期望: true

断言 3: LogStream 析构 flush (logStream.cpp:117)
  (gdb) break logStream.cpp:117
  (gdb) print _current_line.is_empty() → 期望: false（有无换行符的数据）
  (gdb) continue 到 _log_handle.print
  (gdb) print _current_line.buffer() → 期望: 完整的剩余行内容
  (gdb) print _current_line.is_empty() → 期望: false（旧数据）
  (gdb) continue 经过 reset()
  (gdb) print _current_line.is_empty() → 期望: true

断言 4: LogMessageBuffer 懒分配 (logMessageBuffer.cpp:87-89)
  (gdb) break logMessageBuffer.cpp:87
  (gdb) 运行: LogMessage(gc) msg; msg.debug("test");
  (gdb) print _allocated → 期望: false（首次调用前尚未分配）
  (gdb) continue 经过 initialize_buffers
  (gdb) print _allocated → 期望: true
  (gdb) print _message_buffer_capacity → 期望: 1024
  (gdb) print _line_capacity → 期望: 10

断言 5: LogMessageBuffer::vwrite 2-attempt overflow (logMessageBuffer.cpp:117)
  (gdb) break logMessageBuffer.cpp:117
  (gdb) 运行: 写入极长消息 (>1024 字节) 触发日志
  (gdb) print written → 期望: 大于 _message_buffer_capacity - _message_buffer_size
  (gdb) print attempts → 期望: 0（第一次）
  (gdb) continue → 经过 grow → 回到 for loop top
  (gdb) print attempts → 期望: 1（第二次）
  (gdb) print _message_buffer_capacity → 期望: 扩容后的值 (>= _message_buffer_size + written)

断言 6: LogMessage 析构 flush (logMessage.hpp:73)
  (gdb) break logMessage.hpp:73
  (gdb) print _has_content → 期望: true（有内容写入）
  (gdb) print _line_count → 期望: >0
  (gdb) print _lines[0].level → 期望: LogLevel::Debug 或其他
  (gdb) print _message_buffer + _lines[0].message_offset → 期望: 第一条消息文本
  (gdb) continue 经过 flush()
  (gdb) print _line_count → 期望: 0 (LogMessageBuffer::reset 后)

断言 7: LogDecorations::create_decorations 装饰器计算 (logDecorations.cpp:49)
  (gdb) break logDecorations.cpp:49
  (gdb) 运行: 触发任意已启用的日志行
  (gdb) print decorators._decorators → 期望: 位掩码值（例如 0b00000111 表示 uptime+level+tags）
  (gdb) continue 几次（每个装饰器迭代一次）
  (gdb) print full_name → 期望: "time" / "uptime" / "level" / "tags" / ...
  (gdb) print position → 期望: 逐步递增（每个装饰器向 _decorations_buffer 末尾追加）

断言 8: create_hostname 静态缓存验证 (logDecorations.cpp:132)
  (gdb) break logDecorations.cpp:133
  (gdb) print _host_name → 期望: 非空 C 字符串（如 "myhost-123"）
  (gdb) print _host_name[0] → 期望: 非 '\0'
  (gdb) print → 确认 _host_name 是 static 成员（地址与上一次调用相同）

断言 9: LogHandle 构造的类型擦除 (logHandle.hpp:39)
  (gdb) break logHandle.hpp:39
  (gdb) 运行: Log(gc) log; LogHandle handle(log);
  (gdb) print type_carrier → 期望: LogImpl 引用（模板参数在编译时可见）
  (gdb) continue 经过构造
  (gdb) print this->_tagset → 期望: 非 NULL LogTagSet* 指针
  (gdb) print this->_tagset->ntags() → 期望: >=1 (至少一个 tag)
  (gdb) frame → 确认调用者函数签名不含 LogTagType 模板参数
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二 承接**：本文展开 README §二 架构概览中的"消息层（how）— LogStream/LogMessage 构造消息文本"。README 的"三层模型"中消息层的完整源码展开 — 从宏 API 入口到 LogTagSet::vwrite() 的桥接。

2. **同组边界**：
   - **00-Tag-Level-Selection-Configuration** — 覆盖 `log_is_enabled()` → `LogTagSetMapping` → `LogTagSet::is_level()` 过滤层。本文的 `log_debug` 宏以 `log_is_enabled()` 作为守卫，在 is_enabled=true 时通过 `LogImpl::vwrite()` 进入 `LogTagSet::vwrite()`。两文档在 `LogTagSet::vwrite()` 处桥接。
   - **01-Output-Pipeline** — 覆盖 `LogOutput::write()` 的 I/O 路径。本文的 `LogTagSet::vwrite()` 在计算完 `LogDecorations` + `LogPrefix` 后，调用 `LogOutputList::Iterator` 遍历 → `(*it)->write(decorations, msg)` 将装饰器值和消息文本传入输出管道。两文档在 `Iterator` 遍历处桥接。
   - 边界清晰：本文停止在 `LogOutputList::Iterator` 遍历处（迭代器和输出的 write 归 01），涵盖宏层 → 消息构造 → 装饰器计算的完整源码路径。

3. **共享数据结构**：
   - `LogDecorations` — 本文构造（create_decorations），01 消费（write_decorations + fflush）
   - `LogMessageBuffer` — 本文构造（LogMessage + vwrite），01 消费（LogTagSet::log → Iterator）
   - `LogDecorators` — 本文定义（bitmask + parse），00 配置（configure_output → update_decorators）

4. **全部文档共享开头语**：Reader completed 00-Tag-Level-Selection-Configuration (filter layer) + 01-Output-Pipeline (output write). This doc: how log messages are composed — the three-tier macro API, LogStream chain writes, LogMessage atomic buffering, LogHandle type erasure, decorations computation, and cross-line prefix protocol.
