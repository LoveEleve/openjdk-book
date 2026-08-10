# 02-Message-Composition-Macros — 消息构造层

> **阶段**：[23-logging]
> **前置**：[00-Tag-Level-Selection-Configuration]（log_is_enabled 守卫 + LogTagSetMapping 模板 -> 本文宏入口）、[01-Output-Pipeline]（LogOutput::write() -> 接收本文构造的消息字符串）
> **配套**：[00-Tag-Level-Selection-Configuration]、[01-Output-Pipeline]
> **后续依赖本文**：[24-utilities] — 所有使用 log_debug/log_info/LogStream 的子系统
> **阅读收益**：追踪 log_debug(gc)("msg") 从宏展开到装饰器值计算的完整 11 步执行路径 — 理解 LOG_TAGS 的编译期 tag->枚举转换、三元表达式守卫的参数惰性求值、Log/LogTarget 两层类 API 的设计分工、LogStream 的 outputStream 继承与 LineBuffer 栈优化、LogMessage 的多行原子缓冲与 LogMessageBuffer 双平行数组引擎、LogHandle 的类型擦除桥接、LogDecorations 的 12 装饰器三级性能计算分类、以及 LOG_PREFIX_LIST 的 GC 周期自动前缀协议

---

## §〇 生产场景

### 场景 1：多行日志被线程间交替插入（Log vs LogMessage）

生产环境配置 `-Xlog:class+unload=debug` 监控类卸载。自定义代码中使用 `Log` 类：

```cpp
Log(gc, classhisto) log;
if (log.is_debug()) {
  log.debug("Class histogram dump start");
  // ... 若干行 histo 输出 ...
  log.debug("Class histogram dump end");
}
```

**问题根因**：`log.debug()` 每行都是独立写入 `LogTagSet::vwrite()`（log.hpp:157 delegate -> logTagSet.cpp:110-139）。在 `vwrite()` 内部（logTagSet.cpp:122-133），每个 output 的 `LogOutput::write()` 被独立调用。两个线程同时使用 `Log(gc, classhisto)` -> 线程 A 的 `debug("start")` 和线程 B 的 `debug("start")` 可能在 `LogOutputList::Iterator` 遍历中交错 -> stderr 显示 `[start][start][end][end]` 而非 `[start][end][start][end]`。

**修复**：使用 `LogMessage(gc, classhisto) msg;`（logMessage.hpp:60）-> 所有行缓冲在 `LogMessageBuffer` 中 -> 析构时一次性 `_log.write(*this)` -> `LogTagSet::log(msg)` 将整个 buffer 一次性提交到所有 output —— 一个 Iterator 遍历覆盖整个多行消息。源码路径：logMessage.hpp:72-76 析构函数检查 `_has_content` -> `flush()` -> logMessage.hpp:78-81 `_log.write(*this)` -> `LogTagSet::log(const LogMessageBuffer&)` (logTagSet.cpp:75-87) 在一个 `LogOutputList::Iterator` 遍历内完成所有行写入。

**反事实**：如果 `LogMessage` 不存在 -> 每个对 `log.debug()` 的调用都是独立的 `vwrite()` -> 多行 GC 日志（GC heap before/after, phases, timing breakdown）永远无法保证原子性 -> GC 日志文件变成无法解析的文本交错。

---

### 场景 2：LogStream 行缓冲未 flush 导致日志"丢失"

```cpp
Log(gc) log;
LogStream stream(log);
stream.print("GC stats: heap=%zu, ", size);
// ... 忘记写 '\n' 或 stream.cr() ...
// 函数返回 -> LogStream 析构 -> 之前 print 的 "GC stats: heap=..." 才被 flush
```

**原因**：`LogStream::write()`（logStream.cpp:104-113）以 `'\n'` 作为 flush 边界——遇到 `'\n'` 时调用 `_log_handle.print("%s", _current_line.buffer())` + `_current_line.reset()`。无 `'\n'` 的写入只在 `LineBuffer` 中累积，直到析构函数 `~LogStream()`（logStream.cpp:116-121）检查 `is_empty()` 并强制 flush。如果不是栈上对象（例如 `new LogStream()` 忘了 `delete`），`~LogStream()` 永远不会被调用 -> 内存泄漏 + 日志永久丢失。

**反事实**：如果 LogStream 每写一个非换行字符串就 flush -> 每次 `stream.print("x")` 产生一行独立日志 -> 链式 `stream.print("a").print("b").print_cr("c")` 本应输出 `"abc"` 变成三行独立输出 -> 失去了 `outputStream` 的流式接口语义。

---

### 场景 3：装饰器性能灾难 — hostname 每行 gethostname

配置 `-Xlog:gc=debug:stdout:hostname,uptime,level,tags`。每秒 100K 行 GC 日志 -> 如果每次调用 `LogDecorations::create_hostname_decoration()`（logDecorations.cpp:132-135）都执行 `gethostname(2)` 系统调用 -> 100K * ~500ns = 50ms/s CPU 消耗纯于获取不变的 hostname。HotSpot 的设计：`LogDecorations::_host_name` 是 `static const char*`（logDecorations.hpp:41），在 `LogDecorations::initialize()`（logDecorations.cpp:40-46）中一次性调用 `os::get_host_name()` + `os::strdup_check_oom()` -> 之后所有 `create_hostname_decoration()` 只用一次 `jio_snprintf` 打印缓存值。

类似地，`_vm_start_time_millis` 是 static jlong（logDecorations.hpp:40），在 `initialize()` 中设置一次 -> `create_uptimemillis_decoration()`（logDecorations.cpp:94-98）做 `java_millis() - _vm_start_time_millis` 每次计算但不重复读取启动时间。

### 三步诊断

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

## §一 Source Files Table

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

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux (TencentOS Server 4.2, RHEL-like)。

**Source roots**（构建入口 `make/hotspot/lib/CompileJvm.gmk:153` — `BUILD_LIBJVM`）：
- `src/hotspot/share/logging/log.hpp:1-201` — 三层宏 API 定义
- `src/hotspot/share/logging/logStream.hpp:1-108` — LogStream + LineBuffer 声明
- `src/hotspot/share/logging/logStream.cpp:1-123` — write() + LineBuffer 实现
- `src/hotspot/share/logging/logMessage.hpp:1-105` — LogMessage 延迟缓冲声明
- `src/hotspot/share/logging/logMessageBuffer.hpp:1-131` — LogMessageBuffer 声明
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

**构建命令**：
```bash
cd /data/workspace/openjdk-cut-new
bash configure --with-debug-level=slowdebug --disable-warnings-as-errors
make jdk
```

**Key binary**: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — 所有 logging/ .cpp 编译在此。

**Syscall 速查表**：

| 功能 | syscall | man | 出现位置 | 用途 |
|------|---------|-----|---------|------|
| 获取主机名 | `gethostname` | `man 2 gethostname` | logDecorations.cpp:42 | hostname 装饰器单次初始化 |
| 获取时间(毫秒) | `clock_gettime` | `man 2 clock_gettime` | logDecorations.cpp:63 (via os::javaTimeMillis) | timemillis/uptimemillis 装饰器 |
| 获取时间(纳秒) | `clock_gettime` | `man 2 clock_gettime` | logDecorations.cpp:101 (via os::javaTimeNanos) | timenanos/uptimenanos 装饰器 |
| 获取进程ID | `getpid` | `man 2 getpid` | logDecorations.cpp:111 (via os::current_process_id) | pid 装饰器 |
| 获取线程ID | `gettid` | `man 2 gettid` | logDecorations.cpp:117 (via os::current_thread_id) | tid 装饰器 |
| ISO8601 时间格式化 | `localtime_r`/`gmtime_r` | `man 3 localtime_r` / `man 3 gmtime_r` | logDecorations.cpp:73-76 (via os::iso8601_time) | time/utctime 装饰器 |
| 进程运行时间 | `times`/`clock_gettime` | `man 2 times` | logDecorations.cpp:85 (via os::elapsedTime) | uptime 装饰器 |
| 动态内存分配 | `malloc` | `man 3 malloc` | logStream.cpp:64 (via os::malloc) | LineBuffer 超 64 字节扩容 |
| 完整格式化输出 | `vsprintf` | `man 3 vsprintf` | logMessageBuffer.cpp:113 (via os::vsnprintf) | LogMessageBuffer 格式化写入 |

**全局状态表**：

| 变量 | 定义位置 | 说明 |
|------|---------|------|
| `LogDecorations::_host_name` | logDecorations.hpp:41 + logDecorations.cpp:33 | 静态主机名缓存（单次 gethostname）|
| `LogDecorations::_vm_start_time_millis` | logDecorations.hpp:40 + logDecorations.cpp:32 | 静态 VM 启动毫秒时间戳 |
| `LogDecorators::DefaultDecoratorsMask` | logDecorators.hpp:72 | 默认装饰器位掩码 (uptime\|level\|tags) |
| `LogDecorators::None` | logDecorators.cpp:28 | 空装饰器实例 (位掩码=0) |
| `LogDecorators::_name[][2]` | logDecorators.cpp:30-34 | 装饰器名称表 (全名 + 缩写) |

---

## §三 三层宏 API + LogStream/LogMessage + 装饰器 全链路源码

### 1.1 引言：`log_debug(gc)("msg")` 这一行 C++ 代码背后的 11 步

```
log_debug(gc)("Class unloading: %s", name)
```

这一行 C++ 代码背后，经历 11 步完成完整链路：

| 步骤 | 操作 | 位置 | 数据流 |
|------|------|------|--------|
| 1 | 宏展开 `log_debug(gc)` -> 三元表达式 `?:` | log.hpp:49 | 文本替换 |
| 2 | `LOG_TAGS(gc)` -> `PREFIX_LOG_TAG(gc)` -> `LogTag::_gc` | logTag.hpp:198-205 | tag 字符串 -> 枚举 |
| 3 | `log_is_enabled(Debug, gc)` 守卫检查 | log.hpp:69 -> logTagSet.hpp:114 | 布尔值 |
| 4 | 三元 `?:` 分支选择：false 端 `(void)0` 短路 | log.hpp:49 | void |
| 5 | true 端：实例化 `LogImpl<_gc>::write<Debug>` 函数模板 | log.hpp:142-149 | 函数指针 |
| 6 | `LogImpl::vwrite(Debug, fmt, args)` | log.hpp:152-154 | va_list |
| 7 | `LogTagSetMapping<_gc>::tagset().vwrite()` | logTagSet.cpp:110-139 | 进入 TagSet |
| 8 | `LogPrefix<_gc>::prefix()` 计算 GC 周期前缀 | logPrefix.hpp:94-100 | "GC(15) " |
| 9 | `LogDecorations` 构造 + `create_decorations()` | logDecorations.cpp:36-37 + 48-59 | 装饰器值 |
| 10 | `LogOutputList::Iterator` 遍历所有 output | logTagSet.cpp:122-133 | 输出列表 |
| 11 | `(*it)->write(decorations, msg)` 进入 Output Pipeline | 01-Output-Pipeline 领域 | 字符串输出 |

---

### 1.2 宏展开：三种 TAG 宏

`LOG_TAGS(gc)` 经过两级宏展开（logTag.hpp:198-205）：

```cpp
// 第一级：LOG_TAGS -> LOG_TAGS_EXPANDED + 填充 __NO_TAG
#define LOG_TAGS(tag1, ...) EXPAND_VARARGS(LOG_TAGS_EXPANDED(tag1, __VA_ARGS__, __NO_TAG, ...))

// 第二级：每个 tag 套上 PREFIX_LOG_TAG
#define LOG_TAGS_EXPANDED(tag1, tag2, tag3, tag4, tag5, ...) \
  PREFIX_LOG_TAG(tag1), PREFIX_LOG_TAG(tag2), PREFIX_LOG_TAG(tag3), \
  PREFIX_LOG_TAG(tag4), PREFIX_LOG_TAG(tag5)

// PREFIX_LOG_TAG 将 "gc" 转为 LogTag::_gc
#define PREFIX_LOG_TAG(tag) LogTag::_##tag
```

结果：`LOG_TAGS(gc)` -> `LogTag::_gc, LogTag::__NO_TAG, LogTag::__NO_TAG, LogTag::__NO_TAG, LogTag::__NO_TAG` — 恰好 5 个枚举值填充 `LogImpl` 的模板参数。

---

### 1.3 表达式守卫：ternary `?:` 表达式

这就是 `log_debug(gc)("msg")` 的完整宏展开（log.hpp:49）：

```cpp
#define log_debug(...)   (!log_is_enabled(Debug, __VA_ARGS__))   ? (void)0 : LogImpl<LOG_TAGS(__VA_ARGS__)>::write<LogLevel::Debug>
```

**为什么用 `?:` 而非 `if` 语句？** `?:` 是 C++ 表达式（expression），`if` 是语句（statement）。在以下场景中，`if` 无法编译：

```cpp
return log_debug(gc)("failed"), false;  // comma expression, ?: works, if fails
```

`?:` 确保 `(!log_is_enabled(...))` 为真时，不仅跳过写入，而且 printf varargs 参数也完全不被求值。代价是两端类型必须兼容——`(void)0` 和 `LogImpl::write` 都返回 `void`，无冲突。

log_is_enabled 宏的展开（log.hpp:69）：

```cpp
#define log_is_enabled(level, ...) (LogImpl<LOG_TAGS(__VA_ARGS__)>::is_level(LogLevel::level))
```

这是一个内联的 `LogTagSet::is_level()` 调用（logTagSet.hpp:114），约 5ns 的布尔检查。

---

### 1.4 Log 类 API：`LogImpl` 的 LOG_LEVEL_LIST 展开

当需要多次写入或流式接口时，创建 `Log` 实例（log.hpp:87）：

```cpp
#define Log(...)  LogImpl<LOG_TAGS(__VA_ARGS__)>
```

`LogImpl`（log.hpp:110-176）的核心结构：

```cpp
template <LogTagType T0, ..., LogTagType GuardTag>
class LogImpl {
  static const size_t LogBufferSize = 512;
  STATIC_ASSERT(GuardTag == LogTag::__NO_TAG);

  static bool is_level(LogLevelType level) {
    return LogTagSetMapping<T0, T1, T2, T3, T4>::tagset().is_level(level);
  }

  static void vwrite(LogLevelType level, const char* fmt, va_list args) {
    LogTagSetMapping<T0, T1, T2, T3, T4>::tagset().vwrite(level, fmt, args);
  }
```

`LogImpl` 通过 `LOG_LEVEL_LIST` 宏为每个级别生成 4 个方法（log.hpp:156-175）：

```cpp
#define LOG_LEVEL(level, name) \
  LogImpl& v##name(const char* fmt, va_list args) { vwrite(LogLevel::level, fmt, args); return *this; } \
  LogImpl& name(const char* fmt, ...) { va_list args; va_start(args, fmt); vwrite(LogLevel::level, fmt, args); va_end(args); return *this; } \
  static bool is_##name() { return is_level(LogLevel::level); } \
  static LogTargetImpl<LogLevel::level, T0, ...>* name() { return NULL; }  // type carrier
LOG_LEVEL_LIST   // LogLevel::Trace,Debug,Info,Warning,Error
#undef LOG_LEVEL
```

展开后产生：`vtrace()` / `trace()` / `is_trace()` / `trace()`（返回 LogTarget 类型指针）、`vdebug()` / `debug()` / `is_debug()` / `debug()`、……。每个 `is_##name()` 方法用于 `if (log.is_debug())` 守卫，每个返回 `*this` 允许链式调用。

---

### 1.5 LogTarget API：级别内嵌 + `print()` 便捷方法

当级别在构造时已知且不变时，使用 `LogTarget`（log.hpp:105）：

```cpp
#define LogTarget(level, ...) LogTargetImpl<LogLevel::level, LOG_TAGS(__VA_ARGS__)>
```

`LogTargetImpl`（log.hpp:179-199）将级别固定为模板参数：

```cpp
template <LogLevelType level, LogTagType T0, ..., LogTagType GuardTag>
class LogTargetImpl {
public:
  static bool is_enabled() { return LogImpl<T0, ...>::is_level(level); }
  static void print(const char* fmt, ...) {
    va_list args; va_start(args, fmt);
    LogImpl<T0, ...>::vwrite(level, fmt, args);
    va_end(args);
  }
};
```

**设计优势**：级别内嵌后，调用者只需 `out.print("msg")` 不需每次传入 level 参数。`is_enabled()` 检查一次后 `out.print()` 无需重复检查——但 HotSpot 当前实现实际每写一行都会调用 `is_level()`。

> **Counterfactual** — 如果只有宏（`log_debug(gc)("msg")`）而无 `Log` 类和 `LogTarget` 类，会失去：
> 1. **流式接口** — 无法 `LogStream stream(log)` 利用 outputStream 的 hexdump/indent/print_on 生态
> 2. **多次输出的级别缓存** — 每次 `log_debug(gc)` 要重新展开 `log_is_enabled(Debug, gc)` 检查（两个函数调用+比较，~5ns），1000 行批量日志浪费 5µs
> 3. **LogTarget 的级别固定** — 每次调用得重复指定 level，且无法在函数入口一次性判定 `is_enabled()` 后多次输出
> 
> 如果���有 `Log` 类而无宏（最基础的 `log_debug`），会失去：
> 1. **表达式安全性** — 不能在 `return`/`?:`/`throw` 等表达式上下文中使用
> 2. **参数惰性求值** — 必须手写 `if (log.is_debug()) { log.debug("expensive: %s", compute_expensive_string()); }` — 多一层代码嵌套，且容易忘记守卫

---

### 1.6 LogStream 流式接口：outputStream 继承 + LineBuffer 栈优化

`LogStream` 解决"如何获得 C++ 流式日志接口"的问题。它继承 HotSpot 的 `outputStream`（logStream.hpp:34）：

```cpp
class LogStream : public outputStream {
  LineBuffer  _current_line;
  LogTargetHandle _log_handle;
```

**为什么继承 `outputStream`？** `outputStream`（utilities/ostream.hpp）是 HotSpot 全局的格式化输出抽象，提供 30+ 方法：
- `print()` / `print_cr()` / `print_raw()` — printf 格式化
- `hexdump()` — 十六进制转储
- `fill_to()` / `put()` / `indent()` — 格式化
- `bol()` / `cr()` — 行控制
- `time_stamp()` — 时间戳

LogStream 只覆写一个 `virtual void write(const char* s, size_t len)`（logStream.cpp:104-113），继承所有 print 方法——因为它们最终都委托给 `write()`。这带来了一个强大的副作用：**任何有 `print_on(outputStream*)` 方法的 HotSpot 对象都可以直接输出到日志**，如 `klass->print_on(log_stream)`、`method->print_on(log_stream)`。

**构造函数禁止 `new` 操作符**（logStream.hpp:60-61）：

```cpp
static void* operator new (size_t);   // private, 禁止 new
static void* operator new[] (size_t);
```

LogStream 设计为栈分配对象，析构函数自动 flush `LineBuffer`。如果分配在堆上且无人 `delete`，日志内容永久丢失。

---

### 1.7 LineBuffer 栈优化：64 字节避免 malloc

`LogStream::LineBuffer`（logStream.hpp:42-55）的核心设计：

```cpp
class LineBuffer {
  char _smallbuf[64];   // 栈上固定 64 字节
  char* _buf;           // 指向 _smallbuf 或堆内存
  size_t _cap;          // 当前容量
  size_t _pos;          // 已写入位置
```

构造函数（logStream.cpp:29-33）：

```cpp
LogStream::LineBuffer::LineBuffer()
 : _buf(_smallbuf), _cap(sizeof(_smallbuf)), _pos(0) {
  _buf[0] = '\0';
}
```

`_buf` 初始指向 `_smallbuf` 的 64 字节栈缓冲。对于绝大多数日志行（典型 30-80 字节），这避免了 `os::malloc`（`man 3 malloc`）调用。仅当行超过 64 字节时，`try_ensure_cap()`（logStream.cpp:46-77）才通过 `os::malloc` 分配堆内存，扩容上限为 1MB（logStream.cpp:50 `reasonable_max = 1*M`）防止失控增长。

**LogStream::write() 完整源码**（logStream.cpp:104-113）：

```cpp
void LogStream::write(const char* s, size_t len) {
  if (len > 0 && s[len - 1] == '\n') {
    _current_line.append(s, len - 1); // omit the newline.
    _log_handle.print("%s", _current_line.buffer());
    _current_line.reset();
  } else {
    _current_line.append(s, len);
  }
  update_position(s, len);
}
```

设计要点：
1. `'\n'` 触发 flush — 累积的行内容通过 `_log_handle.print()` 输出，然后 `reset()` 清空
2. 无 `'\n'` 的写入只在 `_current_line` 中累积（通过 `append()`）
3. **析构函数强制 flush**（logStream.cpp:116-121）：

```cpp
LogStream::~LogStream() {
  if (_current_line.is_empty() == false) {
    _log_handle.print("%s", _current_line.buffer());
    _current_line.reset();
  }
}
```

即使最后一行忘记 `cr()`，析构时也会强制输出——前提是 LogStream 是栈对象。这是 `operator new` 被禁止的根本原因。

> **Counterfactual** — 如果 LineBuffer 不使用 64 字节栈优化，始终从堆分配：
> 每次创建 `LogStream` → 1 次 `os::malloc(64)` ≈ 50-100ns。GC 日志每秒 10K 次 LogStream 创建 → 10K × 50ns = 500µs/s → 0.05% CPU。加上 `os::free` 在析构时 (50ns) → ~1ms/s。**真正的问题不是 CPU 而是**：
> 1. `malloc(3)` 内部需获取 arena 锁（多线程竞争，`man 3 malloc`）
> 2. 频繁 malloc/free 产生额外内存碎片
> 3. 64 字节行覆盖 80% 以上日志场景 — malloc 不值得
> 
> 当前设计：`_buf` 初始指向 `_smallbuf[64]` (logStream.cpp:29-30)，只有 `try_ensure_cap(atleast > 64)` 才 malloc (logStream.cpp:48-54)。对于 30-80 字节典型行 → 零堆分配。

---

### 1.8 LogMessage 延迟格式化：多行缓冲 + 析构时 flush

`LogMessage` 用于需要多行原子输出的场景。`LogMessageImpl`（logMessage.hpp:63）继承 `LogMessageBuffer`：

```cpp
class LogMessageImpl : public LogMessageBuffer {
  LogImpl<T0, T1, T2, T3, T4, GuardTag> _log;
  bool _has_content;
```

**关键设计**：`_has_content` 标志可能最容易被忽略但最重要。`LogMessage` 可能构造后作用域内条件不满足（`if (!msg.is_debug())`）导致没有任何 `vwrite` 调用 -> `_has_content` 保持 `false` -> 析构时跳过 `flush()` -> 零开销空对象。

**LogMessage::vwrite()**（logMessage.hpp:89-95）：

```cpp
void vwrite(LogLevelType level, const char* fmt, va_list args) {
  if (!_has_content) {
    _has_content = true;
    set_prefix(LogPrefix<T0, T1, T2, T3, T4>::prefix);
  }
  LogMessageBuffer::vwrite(level, fmt, args);
}
```

首次 `vwrite()` 时设置 `_prefix_fn` 为对应 tagset 的 LogPrefix 函数。后续行共享同一前缀。

**LogMessage::flush()**（logMessage.hpp:78-81）：

```cpp
void flush() {
  _log.write(*this);
  reset();
}
```

**析构函数**（logMessage.hpp:72-76）：

```cpp
~LogMessageImpl() {
  if (_has_content) {
    flush();
  }
}
```

`_log.write(*this)` 调用 `LogImpl::write(const LogMessageBuffer&)` -> `LogTagSet::log(msg)`（logTagSet.cpp:75-87）在一个 `LogOutputList::Iterator` 遍历中输出所有行，保证多行原子性。

**注意："延迟格式化"不是格式化本身延迟**。`vwrite()` 调用时立即执行 `os::vsnprintf`（`man 3 vsprintf`）格式化。真正的"延迟"是 flush 到 output 的时机——析构时一次性批量输出而非每行即时输出。

> **Counterfactual** — 如果不用 LogMessageBuffer 而用 `std::stringstream` 累积多行再输出：
> 1. `std::stringstream` 在 product build 不可用（HotSpot 禁用 C++ iostream 异常体系）
> 2. 即使自定义实现：`std::string` 拼接会产生多次 `realloc` + 复制
> 3. LogMessageBuffer 的 2-attempt `vsprintf`（`man 3 vsprintf`）策略避免了 "逐字符/逐段 append + 多次 grow"——`_lines[]` 数组记录行边界而非重复存储 message 内容，`message_buffer` 是连续块，不做字符串复制（只做一次 `vsnprintf` 格式化到 buffer 末尾）

---

### 1.9 LogMessageBuffer 引擎：双平行数组 + 2-attempt vwrite + 懒分配

`LogMessageBuffer` 是消息缓冲的核心引擎。它声明了两个核心数据结构（logMessageBuffer.hpp:31-49）：

```cpp
struct LogLine {
  LogLevelType level;
  size_t message_offset;
};

char* _message_buffer;    // 连续字符缓冲区（所有行的消息文本）
LogLine* _lines;          // 平行数组（每行的 level + 消息在 _message_buffer 中的偏移）
bool _allocated;          // 懒分配标志 — 首次 vwrite() 才分配
size_t _prefix_fn;         // 函数指针（如 GCId::print_prefix）
```

**Why 双平行数组而非 '\n' 分隔？**
- `_lines[i].level` — O(1) 定位任一行级别，Iterator 过滤时直接比较
- `_lines[i].message_offset` — O(1) 获取消息字符串，无需 `strchr` 线性扫描
- `Iterator::skip_messages_with_finer_level()`（logMessageBuffer.cpp:71-77）需按 level 过滤行——直接读 `_lines[i].level` 做比较，零开销

**构造函数懒分配**（logMessageBuffer.cpp:39-48）：

```cpp
LogMessageBuffer::LogMessageBuffer()
  : _message_buffer_size(0), _message_buffer_capacity(0),
    _message_buffer(NULL), _line_count(0), _line_capacity(0),
    _lines(NULL), _allocated(false), _least_detailed_level(LogLevel::Off),
    _prefix_fn(NULL) {}
```

`_allocated` 初始为 `false`，`_message_buffer` 为 `NULL`。如果 LogMessage 从未写入 -> 零堆分配、零释放。

**initialize_buffers()**（logMessageBuffer.cpp:62-69）：

```cpp
void LogMessageBuffer::initialize_buffers() {
  assert(!_allocated, "buffer already initialized/allocated");
  _allocated = true;
  _message_buffer = NEW_C_HEAP_ARRAY(char, InitialMessageBufferCapacity, mtLogging);
  _lines = NEW_C_HEAP_ARRAY(LogLine, InitialLineCapacity, mtLogging);
  _message_buffer_capacity = InitialMessageBufferCapacity;  // 1024
  _line_capacity = InitialLineCapacity;                      // 10
}
```

初始容量：消息 1024 字节 + 10 行。覆盖绝大数场景——GC 日志通常 3-10 行 per cycle。

**vwrite() — 2-attempt 乐观策略**（logMessageBuffer.cpp:86-131）：

```cpp
void LogMessageBuffer::vwrite(LogLevelType level, const char* fmt, va_list args) {
  if (!_allocated) {
    initialize_buffers();
  }

  if (level > _least_detailed_level) {
    _least_detailed_level = level;
  }

  size_t written;
  for (int attempts = 0; attempts < 2; attempts++) {
    written = 0;
    size_t remaining_buffer_length = _message_buffer_capacity - _message_buffer_size;
    char* current_buffer_position = _message_buffer + _message_buffer_size;

    if (_prefix_fn != NULL) {
      written += _prefix_fn(current_buffer_position, remaining_buffer_length);
      current_buffer_position += written;
      if (remaining_buffer_length < written) {
        remaining_buffer_length = 0;
      } else {
        remaining_buffer_length -= written;
      }
    }

    va_list copy;
    va_copy(copy, args);
    written += (size_t)os::vsnprintf(current_buffer_position, remaining_buffer_length, fmt, copy) + 1;
    va_end(copy);
    if (written > _message_buffer_capacity - _message_buffer_size) {
      assert(attempts == 0, "Second attempt should always have a sufficiently large buffer (resized to fit).");
      grow(_message_buffer, _message_buffer_capacity, _message_buffer_size + written);
      continue;
    }
    break;
  }

  if (_line_count == _line_capacity) {
    grow(_lines, _line_capacity);
  }

  _lines[_line_count].level = level;
  _lines[_line_count].message_offset = _message_buffer_size;
  _message_buffer_size += written;
  _line_count++;
}
```

**2-attempt 策略分析**：

1. **attempt 0**：乐观地用当前剩余空间 `vsnprintf`。如果 `written > remaining` -> `grow()` 扩容 -> `continue` 进入 attempt 1
2. **attempt 1**：buffer 已扩容到 `>= _message_buffer_size + written` 所需空间 -> `vsnprintf` 必定成功。`assert(attempts == 0)` 确保 attempt 1 永远不会再溢出

**为什么用 `va_copy`？** `vsnprintf` 消费 `va_list` 后 `va_list` 失效。两次 attempt 需要两次 `vsnprintf` -> 第一次可能失败（空间不够）-> 第二次必须重新格式化整个字符串。`va_copy` 保存 args 副本供第二次使用。这是 C++ varargs 的局限——`va_list` 是单向迭代器，不可回退。

**grow() 加倍扩容**（logMessageBuffer.cpp:29-37）：

```cpp
template <typename T>
static void grow(T*& buffer, size_t& capacity, size_t minimum_length = 0) {
  size_t new_size = capacity * 2;
  if (new_size < minimum_length) {
    new_size = minimum_length;
  }
  buffer = REALLOC_C_HEAP_ARRAY(T, buffer, new_size, mtLogging);
  capacity = new_size;
}
```

与 `std::vector` 相同的 amortized O(1) 策略。`capacity * 2` 保证加倍扩容，`minimum_length` 确保扩容后至少能容纳当前行。

> **Counterfactual** — 如果 `_message_buffer` 是一条连续字符串（无 `_lines[]` 索引），用 `'\n'` 做行分隔符而非 `LogLine` 结构数组：
> - 当前设计：`_lines[_line_count] = {level, message_offset}` — O(1) 定位任一行 + 每行独立 level 信息
> - 用 `'\n'` 分隔：迭代时需 `strchr(message_buffer, '\n')` 线性扫描，无法知道第 N 行的 level — 除非在每行前加 level 前缀字节（破坏可读性）
> - 更关键：`Iterator::skip_messages_with_finer_level()` (logMessageBuffer.cpp:71-77) 需要在遍历时跳过 level < filter_level 的行 — 当前设计直接读 `_lines[i].level` 做比较，`'\n'` 分隔则需解析字符串查找 level 标记

---

### 1.10 LogHandle 类型擦除：模板->运行时指针

`LogHandle` 解决了一个关键工程问题：**如何将模板化的 `LogImpl<gc, class>` 作为函数参数传递而不污染函数签名为模板？**

考虑一个函数签名对比：

```cpp
// 无 LogHandle — 必须模板
template <LogTagType T0, LogTagType T1, ...>
void do_log(const LogImpl<T0, T1, ...>& log);

// 有 LogHandle — 纯非模板
void do_log(const LogHandle& handle);
```

`LogHandle` 的单一成员（logHandle.hpp:35）：

```cpp
LogTagSet* _tagset;   // 运行时指针 — 唯一的成员
```

构造时从模板化的 `LogImpl<>` 提取 `LogTagSetMapping::tagset()` 地址（logHandle.hpp:38-40）：

```cpp
template <LogTagType T0, ..., LogTagType GuardTag>
LogHandle(const LogImpl<T0, T1, T2, T3, T4, GuardTag>& type_carrier) :
    _tagset(&LogTagSetMapping<T0, T1, T2, T3, T4>::tagset()) {}
```

之后所有 `vdebug()`/`vtrace()` 调用都通过 `_tagset->vwrite()`（logHandle.hpp:51-52）——完全绕过模板，纯虚函数调用路径。

**代价**：丢失编译期内联机会。`is_level()` 原来是内联访问 `_output_list` 成员（logTagSet.hpp:114），现在必须在 `_tagset` 指针上间接调用 -> ~2ns 额外延迟 per call。

**LogTargetHandle**（logHandle.hpp:73-102）在此基础上额外存储 `const LogLevelType _level`（logHandle.hpp:78-79），用于 `LogStream` 的固定级别输出。

**静态工厂方法**（logHandle.hpp:86-89）：

```cpp
template <LogLevelType level, LogTagType T0, ..., LogTagType GuardTag>
static LogTargetHandle create() {
  return LogTargetHandle(LogTargetImpl<level, T0, T1, T2, T3, T4, GuardTag>());
}
```

这允许在不持有 `LogTargetImpl` 实例的情况下创建 handle。

> **Counterfactual** — 如果所有使用日志的代码都直接使用 `LogImpl<T0,T1,...>` 模板类型而不做类型擦除：
> - 每个使用日志的函数变成模板函数 → 实例化 N 个不同版本（每个 tag 组合一个版本）
> - 以 `Thread::print_on(outputStream*)` 为例，假设内部调用 `Log(gc,classhisto)` → 200 个不同 tag 组合都在不同翻译单元中被实例化 → 每个产生 ~200 字节代码 → **~40KB 额外 .text** 仅为一个 `print_on` 方法
> - LogHandle 的运行时指针方案 → 所有 tag 组合共享同一个函数体 → 零实例化膨胀
> - **代价权衡**：运行时指针丢失了编译期内联机会 → `is_level()` 原来是内联的（直接访问 `_output_list` 成员），现在必须在 `_tagset` 指针上间接调用 → ~2ns 额外延迟 per call。在 ~100K/s 日志速率下 → 0.2ms/s → 完全可以忽略

---

### 1.11 LogDecorations 运行时计算：12 个装饰器三级性能分类

`LogDecorations` 是一个**临时对象**，在每次日志写入时创建于 `LogTagSet::vwrite()` 栈上（logDecorations.cpp:35-38）：

```cpp
LogDecorations::LogDecorations(LogLevelType level, const LogTagSet &tagset, const LogDecorators &decorators)
    : _level(level), _tagset(tagset), _millis(-1) {
  create_decorations(decorators);
}
```

每个 `LogDecorations` 持有一个 256 字节栈缓冲区（logDecorations.hpp:35）：

```cpp
char _decorations_buffer[256];                     // 装饰器值文本
char* _decoration_offset[LogDecorators::Count];    // 每个装饰器的偏移指针
```

`_millis` 初始化为 -1（lazy 缓存），`_host_name` 和 `_vm_start_time_millis` 是 static 成员。

**性能分级**：

| 级别 | 装饰器 | 开销 | 机制 |
|:----:|--------|------|------|
| **L0 — 零/一次开销** | hostname, pid, level, tags | ~5-20ns | static 缓存 / 内联读取 |
| **L1 — 每次轻量计算** | timemillis, uptimemillis, tid | ~10-100ns | 首次 os::javaTimeMillis() ~100ns, 后续 ~5ns |
| **L2 — 每次 syscall** | time, utctime, uptime, timenanos, uptimenanos | ~50-500ns | localtime_r/gmtime_r/clock_gettime/RDTSC |

**static 初始化**（logDecorations.cpp:40-46）：

```cpp
void LogDecorations::initialize(jlong vm_start_time) {
  char buffer[1024];
  if (os::get_host_name(buffer, sizeof(buffer))) {
    _host_name = os::strdup_check_oom(buffer);
  }
  _vm_start_time_millis = vm_start_time;
}
```

`initialize()` 由 JVM 启动时调用，一次性通过 `gethostname(2)` 获取主机名。在整个 JVM 生命周期内，`create_hostname_decoration()` 只用 `jio_snprintf` 打印缓存值。

---

### 1.12 LogDecorators 位掩码：DECORATOR_LIST X-MACRO + parse

`LogDecorators` 管理"选择了哪些装饰器"。核心是 32-bit 位掩码 `uint _decorators`（logDecorators.hpp:70）。

**DECORATOR_LIST**（logDecorators.hpp:41-53）：

```cpp
#define DECORATOR_LIST          \
  DECORATOR(time,         t)    \
  DECORATOR(utctime,      utc)  \
  DECORATOR(uptime,       u)    \
  DECORATOR(timemillis,   tm)   \
  DECORATOR(uptimemillis, um)   \
  DECORATOR(timenanos,    tn)   \
  DECORATOR(uptimenanos,  un)   \
  DECORATOR(hostname,     hn)   \
  DECORATOR(pid,          p)    \
  DECORATOR(tid,          ti)   \
  DECORATOR(level,        l)    \
  DECORATOR(tags,         tg)
```

**三处差异化 #define**：

1. **枚举定义**（logDecorators.hpp:61-67）：
```cpp
enum Decorator {
#define DECORATOR(name, abbr) name##_decorator,
  DECORATOR_LIST
#undef DECORATOR
  Count, Invalid
};
```
-> `time_decorator=0, utctime_decorator=1, ..., tags_decorator=11, Count=12, Invalid=13`

2. **名称表**（logDecorators.cpp:30-34）：
```cpp
const char* LogDecorators::_name[][2] = {
#define DECORATOR(n, a) {#n, #a},
  DECORATOR_LIST
#undef DECORATOR
};
```
-> `{"time","t"}, {"utctime","utc"}, ..., {"tags","tg"}`

3. **位掩码检查**（logDecorations.cpp:50-58）：
```cpp
#define DECORATOR(full_name, abbr) \
if (decorators.is_decorator(LogDecorators::full_name##_decorator)) { \
  _decoration_offset[LogDecorators::full_name##_decorator] = position; \
  position = create_##full_name##_decoration(position) + 1; \
} else { \
  _decoration_offset[LogDecorators::full_name##_decorator] = NULL; \
}
```

**默认装饰器**（logDecorators.hpp:72）：

```cpp
static const uint DefaultDecoratorsMask = (1 << uptime_decorator) | (1 << level_decorator) | (1 << tags_decorator);
```

三个默认装饰器：uptime（体现运行时间）+ level（表明级别）+ tags（表明来源）。

**位掩码 vs bool 数组**：

| 操作 | 位掩码 | bool 数组 |
|------|--------|-----------|
| `is_decorator(d)` | `_decorators & (1<<d)` — 1 条 AND | `_active[d]` — 1 条 MOV |
| `is_empty()` | `_decorators == 0` — 1 条 CMP | `for i..Count if _active[i]` — 最多 12 次比较 |
| `combine_with()` | `_decorators \|= src` — 1 条 OR | `for i..Count \|= src[i]` — 12 条 OR |
| 内存 | 4 bytes | 12 bytes |

**parse() — 逗号分隔解析**（logDecorators.cpp:46-83）：

```cpp
bool LogDecorators::parse(const char* decorator_args, outputStream* errstream) {
  if (decorator_args == NULL || strlen(decorator_args) == 0) {
    _decorators = DefaultDecoratorsMask;
    return true;
  }

  if (strcasecmp(decorator_args, "none") == 0) {
    _decorators = 0;
    return true;
  }

  uint tmp_decorators = 0;
  char* args_copy = os::strdup_check_oom(decorator_args, mtLogging);
  char* token = args_copy;
  char* comma_pos;
  do {
    comma_pos = strchr(token, ',');
    if (comma_pos != NULL) { *comma_pos = '\0'; }
    Decorator d = from_string(token);
    if (d == Invalid) {
      if (errstream != NULL) { errstream->print_cr("Invalid decorator '%s'.", token); }
      result = false;
      break;
    }
    tmp_decorators |= mask(d);
    token = comma_pos + 1;
  } while (comma_pos != NULL);
```

空字符串 -> `DefaultDecoratorsMask`；"none" -> 清空所有装饰器；逗号分隔解析每个装饰器名 -> 通过 `from_string()` 做 `strcasecmp` 匹配全名和缩写。

---

### 1.13 logPrefix.hpp 跨行前缀：42 gc tagset 自动 GC(id) 前缀

`LOG_PREFIX_LIST`（logPrefix.hpp:45-90）列出 42 个条目，全部使用 `GCId::print_prefix` 作为前缀函数。**只有 GC 子系统需要前缀**，因为 GC 周期有编号语义：GC(15) 标识第 15 次 GC。

**默认模板返回 0**（logPrefix.hpp:94-100）：

```cpp
template <LogTagType T0, ..., LogTagType GuardTag>
struct LogPrefix : public AllStatic {
  STATIC_ASSERT(GuardTag == LogTag::__NO_TAG);
  static size_t prefix(char* buf, size_t len) {
    return 0;
  }
};
```

返回 0 告知调用者"没有前缀要写"——调用者跳过任何前缀相关处理。如果返回空字符串 `""` -> 写入 `'\0'` 到 buffer -> 后续 `strcat`/`strlen` 会在空字节处截断 -> 破坏 message 内容。**0 是明确的"跳过"信号**。

**LOG_PREFIX 宏特化**（logPrefix.hpp:102-115）：

```cpp
#define LOG_PREFIX(fn, ...) \
template <> struct LogPrefix<__VA_ARGS__> { \
  static size_t prefix(char* buf, size_t len) { \
    size_t ret = fn(buf, len); \
    assert(ret == 0 || strlen(buf) < len, "Buffer overrun by prefix function."); \
    assert(ret == 0 || strlen(buf) == ret || ret >= len, \
           "Prefix function should return length of prefix written," \
           " or the intended length of prefix if the buffer was too small."); \
    return ret; \
  } \
};
```

`LOG_PREFIX(GCId::print_prefix, LOG_TAGS(gc))` 展开为特化模板 `LogPrefix<LogTag::_gc, __NO_TAG, ...>::prefix()`，内部调用 `GCId::print_prefix(buf, len)`。

**前缀写入时机**：在 `LogMessageBuffer::vwrite()` 中（logMessageBuffer.cpp:101-109），`_prefix_fn()` 先于 `vsnprintf` 被调用，写入 `"GC(15) "` 到 `_message_buffer` 头部。**前缀不是装饰器**——它不在 `_decorations_buffer` 中，而直接在 message body 内，所有行共享同一前缀。

---

### 1.14 Mermaid 序列图：消息构造全链路

```mermaid
sequenceDiagram
    participant UC as User Code
    participant ML as Macro Layer<br/>(log.hpp)
    participant LS as LogStream<br/>or LogMessage
    participant MB as LogMessageBuffer
    participant TS as LogTagSet

    Note over UC: 用户代码调用 log_debug(gc)("msg")

    UC->>ML: log_debug(gc)("msg")
    Note over ML: log.hpp:49 — 三元展开<br/>(!log_is_enabled) ? (void)0 : LogImpl::write
    ML->>ML: log.hpp:69 — is_enabled?<br/>-> LogTagSetMapping tagset().is_level()
    alt 禁用
        ML->>UC: (void)0 — 所有参数不求值
    else 启用
        ML->>ML: log.hpp:49 — LogImpl<_gc>::write<Debug>
        ML->>ML: log.hpp:142-149 — write() -> va_start
        ML->>TS: log.hpp:152 — vwrite(Debug, fmt, args)

        TS->>TS: logTagSet.cpp:110 — LogPrefix::prefix()
        Note over TS: logPrefix.hpp:94 — 返回 0 或 N 字节前缀

        TS->>TS: logTagSet.cpp — 构造 LogDecorations
        Note over TS: logDecorations.cpp:36-37 — millis=-1 lazy
        Note over TS: logDecorations.cpp:48-59 — create_decorations()<br/>检查 bitmask, 计算启用的装饰器值

        TS->>TS: logTagSet.cpp:122-133 — LogOutputList::Iterator 遍历
        Note over TS: 对每个 output 调用 write(decorations, msg)
        Note over TS: 进入 01-Output-Pipeline
    end

    Note over UC,TS: --- 流式接口分支 ---
    UC->>ML: Log(gc) log; LogStream stream(log)
    UC->>LS: stream.print("part1"); stream.print_cr("part2")
    Note over LS: logStream.cpp:110 — 无 \n -> append 到 LineBuffer
    Note over LS: logStream.cpp:107 — 有 \n -> append + flush 到 _log_handle.print
    Note over MB: LogStream 不使用 LogMessageBuffer

    Note over UC,TS: --- 多行原子性分支 ---
    UC->>ML: LogMessage(gc) msg
    UC->>MB: msg.debug("line1")
    Note over MB: logMessageBuffer.cpp:86-131 — vwrite<br/>2-attempt: vsnprintf -> grow -> vsnprintf
    Note over MB: _lines[i] = {Debug, message_offset}
    UC->>MB: msg.debug("line2")
    Note over MB: 同上, _line_count=2
    UC->>ML: } msg 析构 -> _has_content=true -> flush()
    ML->>MB: logMessage.hpp:78-81 — _log.write(*this)
    MB->>TS: LogTagSet::log(msg) (logTagSet.cpp:75-87)
    Note over TS: 一个 Iterator 遍历输出所有行<br/>保证多行原子性
```

---

### 1.15 Interview Story Format 答案

**"`log_debug(gc)("msg")` 的完整链路"**：

宏展开为 `log_is_enabled(Debug, gc)` 守卫的三元表达式 -> 启用时调用 `LogImpl<_gc>::write<Debug>("msg")` -> `LogImpl::vwrite()` 委托给 `LogTagSetMapping<_gc>::tagset().vwrite()` -> 在 `LogTagSet::vwrite()` 内部：计算 `LogPrefix` 前缀 -> 构造 `LogDecorations`（bitmask 检查 `create_*_decoration()`，hostname 读 static 缓存、uptime 调用 `os::elapsedTime()`、pid/tid 调用 `os::current_process_id/thread_id()`、time 调用 `os::iso8601_time` 含 `localtime_r` 格式化）-> `LogOutputList::Iterator` 遍历所有 output -> `(*it)->write(decorations, msg)` 进入 Output Pipeline。

对于多行场景，`LogMessage(gc) msg; msg.debug("before"); msg.debug("after");` 将所有行缓冲在 `LogMessageBuffer` 的双平行数组（`_lines[]` + `_message_buffer[]`）中。首次 `vwrite` 懒分配 1024 字符 + 10 行容量的堆缓冲，2-attempt `vsnprintf` 策略保证扩容安全。析构时 `_has_content=true` 触发 `flush()` -> 一次性 `LogTagSet::log(msg)` 在一个 Iterator 遍历中输出所有行，保证多行原子性。

`LogStream` 继承 `outputStream`，利用 `LineBuffer` 的 64 字节栈优化累积字符串片段，遇 `'\n'` 或析构时通过 `LogTargetHandle::print()` flush 到 TagSet。

---

## §四 7 个 Beginner Callout 框

> **Callout 1 — Ternary guard vs short-circuit**：`log_debug(...)(...)` (log.hpp:49) 使用 C++ 三元表达式 `?:` 而非 `if` 语句。`?:` 是表达式（可用在任何需要表达式的位置，如函数实参），而 `if` 是语句（只能在语句位置）。`?:` 确保 `(!log_is_enabled(...)) ? (void)0 : do_write` —— 当禁用时不仅 skip 写入，而且 `printf` 的 varargs 参数也完全不会被求值。如果用 `if (log_is_enabled(...)) { ... }` —— `if` 不能出现在表达式上下文中（如 `return log_debug(...)(...)`）。**设计意图**：让日志调用像表达式的自然部分融入 C++ 语法（逗号表达式 `,` 链式）而非需要额外语句块。

> **Callout 2 — outputStream 继承 — 为什么不是 iostream**：LogStream 继承 `outputStream` (logStream.hpp:34)，而非 C++ 标准的 `std::ostream`。`outputStream` 是 HotSpot 自有的轻量级输出抽象（`utilities/ostream.hpp`），提供 `print()`、`print_cr()`、`print_raw()`、`hexdump()` 等方法，零异常开销（no `try/catch`）、零虚函数表中间层额外开销、可编译到 product build（HotSpot 禁用 C++ exceptions）。继承它意味着 LogStream 获得所有 `print` 方法而无须重写——只实现 `virtual void write(const char* s, size_t len)` 即可。**设计意图**：桥接 HotSpot 的 `outputStream` 生态——任何有 `print_on(outputStream*)` 的对象（klass/method/thread）都可以直接输出到日志。

> **Callout 3 — LineBuffer 栈优化 — 64 字节小缓冲**：`LogStream::LineBuffer` (logStream.hpp:42-55) 声明了 `char _smallbuf[64]` 作为栈上固定缓冲区。构造函数 (logStream.cpp:29-33) 让 `_buf` 初始指向 `_smallbuf` 而非堆分配。对于绝大多数日志行（典型日志行 30-80 字节，如 `[0.123s][debug][gc] GC(15) Pause Young 12M->8M(64M) 2.543ms` ≈75 字节），这避免了 `os::malloc` 调用（~50-100ns）。仅当行超过 64 字节时（如调用栈 dump），`try_ensure_cap()` (logStream.cpp:46-77) 才通过 `os::malloc` 分配堆内存，扩容上限 1MB 防失控。**设计意图**：80%+ 的日志行在 64 字节内，避免每次 `LogStream` 构造都触发 `os::malloc` + `os::free` 的原子操作和内存碎片开销。

> **Callout 4 — LogMessage 延迟格式化 != 延迟字符串构造**：`LogMessage` 的 "deferred formatting" 不是指 printf 格式化被推迟——`vwrite()` (logMessage.hpp:89-95) 在调用时立即执行 `os::vsnprintf` 格式化。真正的"延迟"是：格式化的结果被写入 `LogMessageBuffer` 的堆缓冲而非直接输出，所有行积攒到析构时才一次性 flush。这使得多行日志有原子性——输出层看到的是完整的 `const LogMessageBuffer&` 引用，而非离散的单行字符串。**设计意图**：格式化即时完成（节省内存——不存未格式化的 `fmt+varargs`），但输出延迟（保证多行连贯性）。类比：写邮件时一边打字一边存在草稿箱，发送时才一次性投递。

> **Callout 5 — LogHandle 类型擦除 — 模板去模板化**：`LogHandle` (logHandle.hpp:33-67) 的唯一成员是 `LogTagSet* _tagset` (logHandle.hpp:35)。构造时从模板化的 `LogImpl<T0,T1,...>` 提取 `LogTagSetMapping<T0,...>::tagset()` 地址。之后所有 `vdebug()`/`vtrace()` 调用都通过 `_tagset->vwrite()` 实现——完全依赖运行时指针而非编译期模板参数。这允许将 Log handle 作为函数参数传递而不污染函数签名为模板函数。`LogTargetHandle` 同样原理但额外存储 `LogLevelType _level`。**设计意图**：避免模板爆炸——如果 200 个调用 `Log(gc,class)` 的函数都变成模板，`.text` 段会因每个 tag 组合独立实例化而膨胀 40KB+。

> **Callout 6 — 静态装饰器值的单次初始化**：`LogDecorations::_host_name` (logDecorations.hpp:41) 和 `_vm_start_time_millis` (logDecorations.hpp:40) 是 `static` 成员，由 `LogDecorations::initialize(jlong vm_start_time)` (logDecorations.cpp:40-46) 在 JVM 启动时一次性设置。`hostname` 在整个 JVM 生命周期内不变 —— 每次日志行调用 `gethostname(2)` 是纯粹浪费。`_vm_start_time_millis` 作为 `create_uptimemillis_decoration()` 的基准也是静态的。**设计意图**：分类计算成本——对 12 个装饰器做运行时成本分级：hostname 零成本（static 缓存）、pid/level/tags 微成本（直接读取）、time/uptime 重成本（每次 syscall 或计算）——使得用户在配置装饰器时有性能预算意识。

> **Callout 7 — LOG_LEVEL_LIST X-MACRO 的重复展开**：`LOG_LEVEL_LIST` (logLevel.hpp:45-50) 定义五级宏调用 `LOG_LEVEL(Trace, trace) LOG_LEVEL(Debug, debug) LOG_LEVEL(Info, info) LOG_LEVEL(Warning, warning) LOG_LEVEL(Error, error)`。在 `LogImpl` (log.hpp:156-175)、`LogHandle` (logHandle.hpp:50-67)、`LogMessageBuffer` (logMessageBuffer.hpp:124-128) 三处各自 `#define LOG_LEVEL(level, name)` 为不同的实现——在 `LogImpl` 中展开为 `v##name()`/`name()` printf 方法 + `is_##name()` 检查 + `name()` 返回 LogTarget 指针；在 `LogHandle` 中展开为类似的 vprintf 方法但通过 `_tagset->vwrite()` 调用；在 `LogMessageBuffer` 中展开为返回 `LogMessageBuffer&` 以支持链式调用。**设计意图**：添加新 level（如 Fatal）-> 改一行 `LOG_LEVEL_LIST` -> 三处自动生成对应方法 -> 编译器保证一致性（少写一处编译失败）。

---

## §五 LogStream 与 LogMessage 对比分析

### 3.1 使用场景矩阵

| 场景 | 推荐 API | 原因 |
|------|---------|------|
| 单行日志 | `log_debug(gc)("msg")` | 最简洁，表达式安全，禁用时零开销 |
| 多次写入同一 tagset | `Log(gc) log; log.debug(...); log.debug(...)` | 只需一次 is_enabled 检查，支持链式调用 |
| 流式打印对象 | `LogStream stream(log.debug()); obj->print_on(&stream)` | 继承 outputStream 的 30+ 方法 |
| 固定级别多次输出 | `LogTarget(Debug, gc) out; out.print(...)` | 级别不重复指定，最简洁 |
| 多行 GC 日志 | `LogMessage(gc) msg; msg.debug(...); msg.debug(...)` | 保证原子性 |
| 函数参数传递 | `LogHandle handle(log); do_log(handle)` | 类型擦除，非模板函数签名 |

### 3.2 LogStream 析构 flush 陷阱

`LogStream` 的两层 flush 机制：

1. **主动 flush**：`write()` 遇到 `'\n'` 时（logStream.cpp:107）-> `_log_handle.print("%s", _current_line.buffer())` + `reset()`
2. **被动 flush**：`~LogStream()` 析构时（logStream.cpp:116-121）-> 如果 `_current_line.is_empty() == false` -> `_log_handle.print("%s", _current_line.buffer())` + `reset()`

**关键陷阱**：如果 `new LogStream()` 且不 `delete`，析构函数永远不会被调用 -> 行缓冲中未 flush 的内容永久丢失。这就是为什么 `operator new` 被声明为 `private`（logStream.hpp:60-61）。

### 3.3 LogMessage 的 _has_content 零开销优化

如果一个 `LogMessage` 在作用域内从未写入内容（条件分支未命中），`_has_content` 保持 `false` -> 析构时跳过 `flush()`（logMessage.hpp:72-73）：

```cpp
~LogMessageImpl() {
  if (_has_content) {    // 零开销空对象 — 跳过所有
    flush();
  }
}
```

对比：如果总是 flush -> 空 `LogMessageBuffer` 的 `Iterator` 遍历 `_line_count == 0` -> `is_at_end()` 立即返回 true -> 浪费了一次虚函数调用和一次 `Iterator` 构造。

### 3.4 LogStream 的 LineBuffer 扩容阈值

`try_ensure_cap()`（logStream.cpp:46-77）的扩容策略：

- 起始 64 字节（栈缓冲 `_smallbuf`）
- 扩容步长 256 字节（logStream.cpp:56）
- 上限 1MB（logStream.cpp:50）
- 超上限时截断并打印 `log_info(logging)("Suspiciously long log line: ...")`（logStream.cpp:59-60）

示例扩容路径：64 -> 320 -> 576 -> 832 -> 1088 ... -> 1M（上限）。

### 3.5 LogMessageBuffer 的初始容量

- `InitialMessageBufferCapacity = 1024`（logMessageBuffer.hpp:39）— 消息文本字符容量
- `InitialLineCapacity = 10`（logMessageBuffer.hpp:38）— 行记录数容量

这对于典型的 GC 日志足够了：一次 GC Pause 通常 3-10 行输出，每行 50-200 字节。超容量时 `grow()` 加倍扩容（logMessageBuffer.cpp:31）。

### 3.6 LogTargetHandle::print() — LogStream 到 LogTagSet 的桥接

`LogStream` 内部使用 `LogTargetHandle`（logStream.hpp:57 `LogTargetHandle _log_handle`）将行缓冲的输出发送到 TagSet。`LogTargetHandle::print()`（logHandle.hpp:91-96）：

```cpp
void print(const char* fmt, ...) {
  va_list args; va_start(args, fmt);
  _tagset->vwrite(_level, fmt, args);   // 利用预存的 _level 和 _tagset
  va_end(args);
}
```

这个 `print()` 是 LogStream 行 flush 的唯一出口——通过 `LogTargetHandle` 绕过模板，直接调用 `LogTagSet::vwrite()`。

> **三层 API 对比矩阵**：

| 维度 | `log_debug(gc)` 宏 | `Log(gc) log` 类 | `LogTarget(Debug,gc)` |
|------|-------------------|------------------|---------------------|
| **表达式安全** | 是（`?:` 表达式） | 否（实例需声明语句） | 否（同上） |
| **参数惰性求值** | 是（禁用时不可求） | 需手动 `if(is_enabled)` | 需手动 `if(is_enabled)` |
| **级别固定** | 是（宏决定了级别） | 否（每次调用指定级别） | 是（模板参数固定级别） |
| **多次输出** | 否（每次重新展开宏） | 是（单一实例复用） | 是（单一实例复用） |
| **流式接口** | 否 | 通过 `log.debug()` 返回 LogTarget | 通过 `out` 直接使用 |
| **链式调用** | 否 | 是（`return *this`） | 否 |
| **函数参数传递** | 否 | 需 `LogHandle` 擦除 | 需 `LogTargetHandle` 擦除 |
| **编译期开销** | 最高（每次展开宏） | 低（一次实例化） | 低（一次实例化） |
| **运行时开销** | 最低（直接 vwrite） | 低（指针调用） | 最低（级别固定） |

**LOG_LEVEL_LIST 三处差异化展开对比**：

| LOG_LEVEL(level, name) | LogImpl (log.hpp:156) | LogHandle (logHandle.hpp:50) | LogMessageBuffer (logMessageBuffer.cpp:133) |
|------------------------|----------------------|---------------------------|---------------------------------------------|
| `v##name()` | 委托 `vwrite(level, fmt, args)` + 返回 `*this` | 委托 `_tagset->vwrite(level, fmt, args)` + 返回 `*this` | 委托 `vwrite(level, fmt, args)` + 返回 `*this` |
| `name()` | va_start + vwrite + va_end + 返回 `*this` | 同上 | 同上 |
| `is_##name()` | `is_level(level)` 内联调用 TagSetMapping | `_tagset->is_level(level)` 指针间接调用 | **不存在** — buffer 不做 level 过滤 |
| extra 方法 | `name()` 返回 `LogTargetImpl* = NULL`（类型携带者） | 无 | 无 |

---

## §六 装饰器系统源码剖析

### 4.1 DECORATOR_LIST X-MACRO 双重展开

`DECORATOR_LIST`（logDecorators.hpp:41-53）在**两处**被展开：

**一处：enum 定义**（logDecorators.hpp:61-67）：
```cpp
enum Decorator {
#define DECORATOR(name, abbr) name##_decorator,
  DECORATOR_LIST
#undef DECORATOR
  Count, Invalid
};
```
产生：`time_decorator=0, utctime_decorator=1, uptime_decorator=2, ..., tags_decorator=11, Count=12, Invalid=13`

**一处：名称表**（logDecorators.cpp:30-34）：
```cpp
const char* LogDecorators::_name[][2] = {
#define DECORATOR(n, a) {#n, #a},
  DECORATOR_LIST
#undef DECORATOR
};
```
产生：`{"time","t"}, {"utctime","utc"}, ..., {"tags","tg"}`

### 4.2 DefaultDecoratorsMask

（logDecorators.hpp:72）：
```cpp
static const uint DefaultDecoratorsMask = (1 << uptime_decorator) | (1 << level_decorator) | (1 << tags_decorator);
```

**为什么是这三个？**
- `uptime` — 最基本的时序信息，用户感知"什么时候发生"
- `level` — 最基本的严重度信息，日志分类基础
- `tags` — 最基本的来源信息，知道"哪个子系统"输出

### 4.3 from_string() 线性扫描

（logDecorators.cpp:36-44）：
```cpp
LogDecorators::Decorator LogDecorators::from_string(const char* str) {
  for (size_t i = 0; i < Count; i++) {
    Decorator d = static_cast<Decorator>(i);
    if (strcasecmp(str, name(d)) == 0 || strcasecmp(str, abbreviation(d)) == 0) {
      return d;
    }
  }
  return Invalid;
}
```

O(12) 线性扫描足够了——Count=12 小到不需要二分。`strcasecmp` 确保 "TIME"/"time"/"Time" 都能匹配。匹配全名（`name(d)` = "time"）和缩写（`abbreviation(d)` = "t"）都行。

### 4.4 parse() — 逗号分隔 + 错误输出

parse 逻辑四步骤（logDecorators.cpp:46-83）：
1. 空字符串 -> `DefaultDecoratorsMask`
2. "none" 不区分大小写 -> `_decorators = 0`
3. OOM 安全的 `os::strdup_check_oom` 副本 -> 逗号分隔（`strchr`）-> 每个 token 调用 `from_string`
4. 对每个匹配的 decorator 调用 `tmp_decorators |= mask(d)` — 用位掩码 OR 写入 -> 最后 `_decorators = tmp_decorators`

### 4.5 create_decorations() — DECORATOR for-each

（logDecorations.cpp:48-59）：

```cpp
void LogDecorations::create_decorations(const LogDecorators &decorators) {
  char* position = _decorations_buffer;
  #define DECORATOR(full_name, abbr) \
  if (decorators.is_decorator(LogDecorators::full_name##_decorator)) { \
    _decoration_offset[LogDecorators::full_name##_decorator] = position; \
    position = create_##full_name##_decoration(position) + 1; \
  } else { \
    _decoration_offset[LogDecorators::full_name##_decorator] = NULL; \
  }
  DECORATOR_LIST
#undef DECORATOR
}
```

对每个装饰器：
1. `is_decorator()` 检查位掩码中对应的 bit -> 单条 AND 指令
2. 如果启用：调用 `create_*_decoration(position)` 写入 `_decorations_buffer` -> 位置指针后移（+1 跳过尾随空格或分隔符）
3. 记录 `_decoration_offset[decorator]` 指针 -> 后续 `decoration()` 方法使用
4. 如果未启用：`_decoration_offset[decorator] = NULL`

### 4.6 13 个 create_*_decoration() 分级展示

#### Level 0 — 零/一次开销（静态缓存）

**create_hostname_decoration()**（logDecorations.cpp:132-135）：
```cpp
char* LogDecorations::create_hostname_decoration(char* pos) {
  int written = jio_snprintf(pos, DecorationsBufferSize - (pos - _decorations_buffer), "%s", _host_name);
  ASSERT_AND_RETURN(written, pos)
}
```
- 开销：~10ns（一次 `jio_snprintf` 字符串复制）
- 系统调用：无（`_host_name` 是 static const char* 缓存）
- man 参考：`man 2 gethostname` — 但只在 `initialize()` 中调用一次

**create_level_decoration()**（logDecorations.cpp:121-125）：
```cpp
char* LogDecorations::create_level_decoration(char* pos) {
  // Avoid generating the level decoration because it may change.
  // The decoration() method has a special case for level decorations.
  return pos;
}
```
- 特例：**不写** `_decorations_buffer`，只返回 `pos`（position 不后移）
- 原因：level 在 `LogMessageBuffer::Iterator` 遍历中可能因 `set_level()` 而改变（logMessageBuffer.hpp:92-95）
- 读取：`decoration()` 方法（logDecorations.hpp:59-63）特殊处理 level -> 调用 `LogLevel::name(_level)` 动态返回

**create_tags_decoration()**（logDecorations.cpp:127-130）：
```cpp
char* LogDecorations::create_tags_decoration(char* pos) {
  int written = _tagset.label(pos, DecorationsBufferSize - (pos - _decorations_buffer));
  ASSERT_AND_RETURN(written, pos)
}
```
- 开销：~20ns（遍历 tags 数组做字符串拼接）
- 系统调用：无

**create_pid_decoration()**（logDecorations.cpp:110-113）：
```cpp
char* LogDecorations::create_pid_decoration(char* pos) {
  int written = jio_snprintf(pos, DecorationsBufferSize - (pos - _decorations_buffer), "%d", os::current_process_id());
  ASSERT_AND_RETURN(written, pos)
}
```
- 开销：~5ns（`os::current_process_id()` 返回 static 缓存值）
- 系统调用：无（进程 ID 在 JVM 启动时缓存）
- man 参考：`man 2 getpid` — 但只在启动时调用一次

**create_tid_decoration()**（logDecorations.cpp:115-119）：
```cpp
char* LogDecorations::create_tid_decoration(char* pos) {
  int written = jio_snprintf(pos, DecorationsBufferSize - (pos - _decorations_buffer),
                             INTX_FORMAT, os::current_thread_id());
  ASSERT_AND_RETURN(written, pos)
}
```
- 开销：~10ns
- 系统调用：`man 2 gettid` — 通过 `os::current_thread_id()` 内部调用

#### Level 1 — 每次轻量计算

**create_timemillis_decoration()**（logDecorations.cpp:89-92）：
```cpp
char * LogDecorations::create_timemillis_decoration(char* pos) {
  int written = jio_snprintf(pos, DecorationsBufferSize - (pos - _decorations_buffer), INT64_FORMAT "ms", java_millis());
  ASSERT_AND_RETURN(written, pos)
}
```
- `java_millis()`（logDecorations.cpp:61-66）使用 lazy 缓存：`if (_millis < 0) { _millis = os::javaTimeMillis(); }`
- 首次调用 ~100ns（clock_gettime syscall），同一 decorator 对象内后续 ~5ns
- 实际每行都重新创建 `LogDecorations`（`_millis = -1` per constructor），所以每行首次调用时都需 ~100ns
- 但 `java_millis()` 同时被 `uptimemillis` 调用——lazy 缓存避免了同一行的重复 syscall

**create_uptimemillis_decoration()**（logDecorations.cpp:94-98）：
```cpp
char * LogDecorations::create_uptimemillis_decoration(char* pos) {
  int written = jio_snprintf(pos, DecorationsBufferSize - (pos - _decorations_buffer),
                             INT64_FORMAT "ms", java_millis() - _vm_start_time_millis);
  ASSERT_AND_RETURN(written, pos)
}
```
- 开销：~10ns（整数减法 + jio_snprintf）
- 依赖 `java_millis()` 的 lazy 缓存——如果 `timemillis` 已经在前面被调用，此处 `java_millis()` 返回缓存值 ~5ns

#### Level 2 — 每次系统调用（重量）

**create_time_decoration()**（logDecorations.cpp:72-76）：
```cpp
char* LogDecorations::create_time_decoration(char* pos) {
  char* buf = os::iso8601_time(pos, 29);
  int written = buf == NULL ? -1 : 29;
  ASSERT_AND_RETURN(written, pos)
}
```
- 输出格式：`2024-01-15T10:30:00.123+0000`（固定 29 字节）
- 系统调用：`localtime_r(3)` + `strftime` -> ~500ns
- man 参考：`man 3 localtime_r`

**create_utctime_decoration()**（logDecorations.cpp:78-82）：
```cpp
char* LogDecorations::create_utctime_decoration(char* pos) {
  char* buf = os::iso8601_time(pos, 29, true);
  int written = buf == NULL ? -1 : 29;
  ASSERT_AND_RETURN(written, pos)
}
```
- 输出格式同上，但使用 UTC（`gmtime_r`（`man 3 gmtime_r`）替代 `localtime_r(3)`）
- 系统调用：`gmtime_r(3)` + `strftime` -> ~500ns

**create_uptime_decoration()**（logDecorations.cpp:84-87）：
```cpp
char * LogDecorations::create_uptime_decoration(char* pos) {
  int written = jio_snprintf(pos, DecorationsBufferSize - (pos - _decorations_buffer), "%.3fs", os::elapsedTime());
  ASSERT_AND_RETURN(written, pos)
}
```
- 输出格式：`6.567s`
- 系统调用：`os::elapsedTime()` 内部调用 `clock_gettime` 或读 `/proc/uptime` -> ~200ns
- man 参考：`man 2 times`，`man 2 clock_gettime`

**create_timenanos_decoration()**（logDecorations.cpp:100-103）：
```cpp
char * LogDecorations::create_timenanos_decoration(char* pos) {
  int written = jio_snprintf(pos, DecorationsBufferSize - (pos - _decorations_buffer), INT64_FORMAT "ns", os::javaTimeNanos());
  ASSERT_AND_RETURN(written, pos)
}
```
- 系统调用：`os::javaTimeNanos()` -> `clock_gettime(CLOCK_MONOTONIC)` -> ~50ns
- man 参考：`man 2 clock_gettime`

**create_uptimenanos_decoration()**（logDecorations.cpp:105-108）：
```cpp
char * LogDecorations::create_uptimenanos_decoration(char* pos) {
  int written = jio_snprintf(pos, DecorationsBufferSize - (pos - _decorations_buffer), INT64_FORMAT "ns", os::elapsed_counter());
  ASSERT_AND_RETURN(written, pos)
}
```
- `os::elapsed_counter()` 通常使用 `RDTSC`（x86）或 `clock_gettime` -> ~20ns

### 4.7 ASSERT_AND_RETURN 宏

（logDecorations.cpp:68-70）：
```cpp
#define ASSERT_AND_RETURN(written, pos) \
    assert(written >= 0, "Decorations buffer overflow"); \
    return pos + written;
```

如果在 256 字节的 `_decorations_buffer` 中发生溢出，`jio_snprintf` 返回负数，断言立即触发。正常运行时 `written` 只可能是非负数，断言帮助捕获开发阶段的缓冲区大小错误。

### 4.8 Counterfactual 对比表：静态缓存 vs 每次重算

| 装饰器 | 每次重算开销 | 静态缓存开销 | 冗余 CPU (100K lines/sec) | 合理性 |
|--------|-------------|-------------|--------------------------|--------|
| hostname | gethostname ~500ns | jio_snprintf ~10ns | 50ms/s (5% CPU) | hostname 不变 — 缓存合理 |
| pid | getpid ~100ns | 读取缓存 ~5ns | 10ms/s (1% CPU) | pid 不变 — 缓存合理 |
| uptime | clock_gettime ~200ns | — | 20ms/s (2% CPU) | uptime 每次变化 — 无法缓存 |
| time | localtime_r ~500ns | — | 50ms/s (5% CPU) | time 每次变化 — 无法缓存 |

---

## §七 logPrefix.hpp — GC 周期前缀协议

### 5.1 LogPrefix 默认模板返回 0

（logPrefix.hpp:94-100）：

```cpp
template <LogTagType T0, ..., LogTagType GuardTag>
struct LogPrefix : public AllStatic {
  STATIC_ASSERT(GuardTag == LogTag::__NO_TAG);
  static size_t prefix(char* buf, size_t len) {
    return 0;
  }
};
```

`return 0` 不是返回空字符串——它是"没有前缀"的明确信号。调用者检查 `ret == 0` -> 跳过所有前缀处理。这与返回 `""` 有本质区别：返回 `""` 会导致 `'\0'` 被写入 buffer，后续字符串拼接在 `'\0'` 处截断。

### 5.2 LOG_PREFIX 宏特化

（logPrefix.hpp:102-115）：

```cpp
#define LOG_PREFIX(fn, ...) \
template <> struct LogPrefix<__VA_ARGS__> { \
  static size_t prefix(char* buf, size_t len) { \
    size_t ret = fn(buf, len); \
    assert(ret == 0 || strlen(buf) < len, "Buffer overrun by prefix function."); \
    assert(ret == 0 || strlen(buf) == ret || ret >= len, \
           "Prefix function should return length of prefix written," \
           " or the intended length of prefix if the buffer was too small."); \
    return ret; \
  } \
};
```

两个断言：
1. `strlen(buf) < len` — 前缀没溢出 buffer
2. `strlen(buf) == ret || ret >= len` — 返回长度 = 实际写入长度，或 >= len 表示 buffer 太小

### 5.3 GCId::print_prefix 的实现来源

前缀函数指针来自 `gc/shared/gcId.hpp`（包含于 logPrefix.hpp:27）。`GCId::print_prefix` 输出 `"GC(15) "` 格式——当前 GC 周期编号 + 空格。这是 GC 日志中所有行共享的前缀。

### 5.4 前缀写入时机

在 `LogMessageBuffer::vwrite()` 中（logMessageBuffer.cpp:101-109），前缀在 `vsnprintf` 之前写入 message buffer 头部：

```
[prefix_fn output "GC(15) "]
[vsnprintf output: "before: heap=128M->64M\0"]
```

两者在 `_message_buffer` 中连续存放。所有行共享同一前缀——`_prefix_fn` 只在首次 vwrite 时设置一次（logMessageBuffer.cpp:108-109 在 if (!_has_content) 块内）。

### 5.5 前缀不参与 LogOutput::write_decorations

前缀不属于装饰器系统。它不会出现在 `_decorations_buffer` 中，也不会被 `LogOutput::write_decorations()` 处理。它直接存在于 message body（`_message_buffer`），因此前缀的颜色、格式化与普通消息文本相同。

**为什么只有 GC 需要前缀？** GC 是唯一有"周期编号"语义的子系统。每个 GC 周期有多个操作步骤（mark、sweep、compact、ref processing），每个步骤产生多行日志。前缀 `GC(15)` 将所有步骤关联到同一个 GC 周期。JIT 编译、类加载等子系统没有"周期"概念——每个事件独立。

**反事实**：如果不使用自动前缀，而是手动在每个 GC 日志调用点加 gc_id：
- ~200 个调用点需要手写 `"GC(%u) ..." gc_id`
- 某处忘记 -> 日志行缺 GC ID -> 无法关联前后日志
- gc_id 传错 -> 误导分析
- `LOG_PREFIX_LIST` 的自动方案：调用者零感知，所有 gc-tagged 日志行自动带 GC ID

---

## §八 "不要写成→应该写成" 对照表

本文档覆盖从 `log_debug(gc)("msg")` 宏展开到 `LogDecorations` 装饰器字节写入的全链路。以下对照表确保每个主题以原理驱动而非机械翻译方式呈现：

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

---

## §九 边缘场景

### 9.1 宏展开类型安全：`#` 字符串化与 `##` 拼接边界陷阱

`LOG_TAGS` 和相关的宏展开涉及 C 预处理器字符串化（`#`）和标记拼接（`##`），在边界条件下存在类型安全陷阱：

- **`EXPAND_VARARGS` 的参数数量刚性**：`LOG_TAGS(gc)` → `EXPAND_VARARGS(LOG_TAGS_EXPANDED(gc, __VA_ARGS__, __NO_TAG, ...))`。当只传 1 个 tag 时，`EXPAND_VARARGS`（定义于 `utilities/macros.hpp`）负责去除尾随的 `__NO_TAG`。如果 `EXPAND_VARARGS` 的实现有 bug（例如 `__VA_ARGS__` 为空时 GCC/MSVC 行为差异），可能导致 `LOG_TAGS(gc)` 展开为 `PREFIX_LOG_TAG(gc), PREFIX_LOG_TAG(__NO_TAG), ...` 而非正确的 1 个有效 tag + 4 个 `__NO_TAG` → 编译通过但 `LogTagSetMapping` 匹配到错误的 tagset → 日志可能输出到错误的目标或级别过滤失效。
- **`PREFIX_LOG_TAG` 只对字母 tag 有效**：`PREFIX_LOG_TAG(gc)` → `LogTag::_gc`，但 `PREFIX_LOG_TAG(42)` → `LogTag::_42` 是无效的 C++ token → 编译错误。幸运的是，`LOG_TAG_LIST` 中的所有 tag 都是字母标识符，且 `__NO_TAG` 是有效的枚举值，过填充 (`__VA_ARGS__` empty) 退化为 `__NO_TAG` 而非非法 token。
- **`##` 拼接的 GCC/MSVC 差异**：`va_copy` 在 GCC 中内建，MSVC 需要 `<stdarg.h>`。`os::vsnprintf` 在 POSIX 和 Windows 之间有不同的溢出返回值约定（POSIX: 返回"应该写入的字节数"，Win: 返回 -1）——LogMessageBuffer 的 2-attempt 策略（logMessageBuffer.cpp:86-131）在 Windows 上需要 `_vscprintf` 预检查而非乐观尝试，否则 attempt 0 的溢出判断逻辑失效。

### 9.2 LogHandle TagSet 生命周期：handle 比 tagset 长寿 → 悬垂指针

`LogHandle` 存储 `LogTagSet* _tagset`（logHandle.hpp:35），但 **不管理** tagset 的生命周期。在以下场景中出现悬垂指针：

```cpp
// 危险模式：堆分配的对象持有 LogHandle，但 tagset 在 LogTagSetMapping 中是静态存储
class MyService {
  LogHandle _log_handle;
public:
  MyService(LogHandle h) : _log_handle(h) {}  // OK if tagset outlives service
};

// 安全模式：LogTagSetMapping 的 tagset() 返回 static 局部变量引用（function-local static）
// 所有 tagset 在 JVM 启动时通过 LogTagSetMapping::initialize() 注册（logTagSet.cpp:32-35）
// tagset 生命周期=JVM 生命周期 → LogHandle 指针始终有效
```

**实际情况**：`LogTagSetMapping<T...>::tagset()` 返回 `static LogTagSet`（logTagSet.hpp:148-150）的引用，生存期为整个 JVM 生命周期。`LogHandle` 持有 `LogTagSet*` 指针而非智能指针是安全的——tagset 不会在 JVM 运行期间被销毁。但如果未来 tagset 改为动态注册/注销（例如 plugin 系统），所有 `LogHandle` 实例立即变为悬垂指针。

**防范**：当前设计中 `LogHandle` 被 `inline` 标记为轻量级指针包装（logHandle.hpp:33 `class LogHandle {` 无虚函数），且 tagset 的 static 存储期由 `LogTagSetMapping` 保证。`os::strdup_check_oom` 的使用强化了 JVM 的"分配即永久"内存模型——这也是为什么 `LogHandle` 不需要引用计数或 `shared_ptr`：JVM 不卸载子系统。

### 9.3 LogMessage 析构异常安全：析构不抛异常保证

`LogMessageImpl::~LogMessageImpl()`（logMessage.hpp:72-76）在当前实现中是**技术上不抛异常**的，但边界条件值得审查：

```cpp
~LogMessageImpl() {
  if (_has_content) {
    flush();                     // → _log.write(*this)
  }
}
```

调用链：`flush()` → `_log.write(const LogMessageBuffer&)` → `LogTagSet::log(const LogMessageBuffer&)` → `LogOutputList::Iterator` 遍历 → `(*it)->write(decorations, msg)`。在 `LogOutput::write()` 中可能触发：
- `os::vsnprintf` 格式化（noexcept / 不抛异常）
- `os::fwrite` / `::write(2)` 系统调用（不抛异常）
- `LogFileOutput` 的 rotate 逻辑（`os::rename` + `os::fopen` — 可能抛 `std::bad_alloc` 如果 HotSpot 启用了 exceptions）

**HotSpot 的异常禁用策略**：product build 中 `-fno-exceptions` 编译标志禁止所有 C++ 异常。因此 `~LogMessageImpl()` 即使内部调用可能抛出异常的代码路径，也会因编译器标志而无异常传播。但 **slowdebug build 中异常可能启用**——如果 `LogFileOutput::rotate()` 中的 `os::malloc` 失败且 new-handler 未设置，`NEW_C_HEAP_ARRAY` 可能通过 `vm_exit_out_of_memory` 直接退出进程（logMessageBuffer.cpp:63 调用 `NEW_C_HEAP_ARRAY` 在 OOM 时调用 `report_java_out_of_memory` → `vm_exit_out_of_memory` → 进程终止），而非抛异常。

**结论**：析构在技术上是异常安全的——要么成功写入，要么通过 `vm_exit_out_of_memory` 终止进程。不会出现"析构中间抛异常导致栈展开中断"的情况。

---

## §十 GDB 断点验证 + strace/jstack 诊断

### 断言 1：log_debug 宏的三元守卫

```bash
(gdb) break logTagSet.hpp:114  # is_level() return
(gdb) print this->_output_list._level_name  # 查看内部级别设置
(gdb) finish
(gdb) print $rax  # 期望: true/false 控制三元表达式走哪条分支
```

### 断言 2：LogStream::write \n flush 分支

```bash
(gdb) break logStream.cpp:107
(gdb) print s[strlen(s)-1]  # 期望: '\n'
(gdb) print _current_line.buffer()  # 期望: 之前累积的行内容（不含 \n）
(gdb) continue  # 经过 _log_handle.print
(gdb) print _current_line.buffer()  # 期望: "" (reset 后被清空)
(gdb) print _current_line.is_empty()  # 期望: true
```

### 断言 3：LogStream 析构 flush

```bash
(gdb) break logStream.cpp:117
(gdb) print _current_line.is_empty()  # 期望: false（有无换行符的数据）
(gdb) continue  # 到 _log_handle.print
(gdb) print _current_line.buffer()  # 期望: 完整的剩余行内容
(gdb) continue  # 经过 reset()
(gdb) print _current_line.is_empty()  # 期望: true
```

### 断言 4：LogMessageBuffer 懒分配

```bash
(gdb) break logMessageBuffer.cpp:87
# 运行: LogMessage(gc) msg; msg.debug("test");
(gdb) print _allocated  # 期望: false（首次调用前尚未分配）
(gdb) continue  # 经过 initialize_buffers
(gdb) print _allocated  # 期望: true
(gdb) print _message_buffer_capacity  # 期望: 1024
(gdb) print _line_capacity  # 期望: 10
```

### 断言 5：LogMessageBuffer::vwrite 2-attempt overflow

```bash
(gdb) break logMessageBuffer.cpp:117  # grow overflow 断言
# 运行: 写入极长消息（>1024 字节）
(gdb) print written  # 期望: 大于 _message_buffer_capacity - _message_buffer_size
(gdb) print attempts  # 期望: 0（第一次）
(gdb) continue  # 经过 grow -> 回到 for loop top
(gdb) print attempts  # 期望: 1（第二次）
(gdb) print _message_buffer_capacity  # 期望: 扩容后的值
```

### 断言 6：LogMessage 析构 flush

```bash
(gdb) break logMessage.hpp:73
(gdb) print _has_content  # 期望: true（有内容写入）
(gdb) print _line_count  # 期望: >0
(gdb) print _lines[0].level  # 期望: LogLevel::Debug (4)
(gdb) print _message_buffer + _lines[0].message_offset  # 期望: 第一条消息文本
(gdb) continue  # 经过 flush() -> reset()
(gdb) print _line_count  # 期望: 0 (reset 后)
```

### 断言 7：LogDecorations::create_decorations 装饰器计算

```bash
(gdb) break logDecorations.cpp:49
(gdb) print decorators._decorators  # 期望: 位掩码值（例如 7 = uptime|level|tags）
(gdb) continue 几次（每个装饰器迭代一次）
(gdb) print position  # 期望: 逐步递增（每个装饰器向 _decorations_buffer 末尾追加）
```

### 断言 8：create_hostname 静态缓存验证

```bash
(gdb) break logDecorations.cpp:133
(gdb) print _host_name  # 期望: 非空 C 字符串
(gdb) print _host_name  # 地址与前一次调用相同 — 确认 static
```

### 断言 9：LogHandle 构造的类型擦除

```bash
(gdb) break logHandle.hpp:39
# 运行: Log(gc) log; LogHandle handle(log);
(gdb) print &type_carrier  # 期望: LogImpl 引用
(gdb) continue  # 经过构造
(gdb) print this->_tagset  # 期望: 非 NULL LogTagSet* 指针
(gdb) print this->_tagset->ntags()  # 期望: >=1 (至少一个 tag)
(gdb) frame  # 确认调用者函数签名不含 LogTagType 模板参数
```

---

### strace 诊断：跟踪日志 write(2) 输出

```bash
# 跟踪 Java 进程的所有 write(2) 系统调用（日志输出的底层）
strace -e trace=write -p $(pgrep -f "java.*-Xlog") 2>&1 | head -20
# 典型输出：
# write(2, "[0.123s][debug][gc] GC(15) Pause Young", 38) = 38
# write(2, "[0.124s][debug][gc] GC(15) Pause End\n", 39) = 39
# 每个 write(2) 对应一次 LogFileOutput::write() → ::fwite/::write
```

**验证要点**：
- 如果看到多行日志的 `write()` 调用之间有其他线程的 `write()` → 说明使用 `Log` 而非 `LogMessage`，多行非原子
- 如果两个线程的 write 交替插入 → 用 `LogMessage` 包装后可看到连续的多个 `write()` 无交替

### jstack 诊断：多线程间日志交替

```bash
# 获取线程快照，查看哪些线程持有可能的日志锁
jstack <pid>
# 关注点：
# 1. 线程在 LogTagSet::vwrite() → logTagSet.cpp:122-133 中的 LogOutputList::Iterator 遍历
# 2. 线程在 LogFileOutput::write() → ::fwrite 或 flush 调用
# 3. 多个线程都在 GC 日志点 → 检查它们使用 Log 还是 LogMessage
```

**验证要点**：在 GC 高峰期 `jstack` 连续采样 3 次 → 如果多次都看到不同线程停在 `LogTagSet::vwrite()` 同一位置（logTagSet.cpp:110-139）→ 确认 vwrite 是非互斥的，`LogMessage` 通过批处理保证原子性而非加锁。

---

## §十一 Cross-Reference

### 前置文档依赖

| 前序文档 | 本文接续点 | 关键桥梁 |
|---------|-----------|---------|
| **00-Tag-Level-Selection-Configuration** | `log_is_enabled()` 返回值控制 `?:` 分支 | log.hpp:49 — macro 使用 log_is_enabled 作为守卫 |
| **00-Tag-Level-Selection-Configuration** | `LogTagSetMapping<T...>` 模板提取 tagset | log.hpp:127 — LogImpl::is_level 委托 tagset.is_level() |
| **01-Output-Pipeline** | `LogTagSet::vwrite()` 中 `LogOutput::write()` 调用 | logTagSet.cpp:122-133 — Iterator 遍历输出本文构造的 decorations + msg |
| **01-Output-Pipeline** | `LogTagSet::log(LogMessageBuffer)` 接收多行消息 | logTagSet.cpp:75-87 — 消费 LogMessageBuffer 结构 |
| **01-jvm-startup** | `LogConfiguration::initialize()` 调用 `LogDecorations::initialize()` | logDecorations.cpp:40-46 — 初始化 static 装饰器缓存 |

### 后续依赖本文的子系统

| 后续文档 | 依赖本文的内容 |
|---------|-------------|
| **24-utilities** 及所有使用日志的子系统 | `log_debug()`/`log_info()`/`LogStream`/`LogMessage` — 本文覆盖的宏 API 是所有其他子系统写日志的唯一入口 |

### 共享数据结构生命周期

```
                    本文构造                    01-Output-Pipeline 消费
    ┌──────────────────────────────────────────────────────────────────┐
    │                                                                  │
    │  LogDecorations  ──[create_decorations()]──> decorations_buffer  │──> write_decorations() + fflush
    │  LogMessageBuffer ──[LogMessage + vwrite]──> _message_buffer     │──> LogTagSet::log() → Iterator → OutputList
    │  LogDecorators    ──[parse() + bitmask]──>  _decorators          │──> is_decorator() 检查 → create_*_decoration
    │                                                                  │
    └──────────────────────────────────────────────────────────────────┘
```

---

> **Reader completed**：00-Tag-Level-Selection-Configuration (filter layer) + 01-Output-Pipeline (output write). **This doc**：how log messages are composed — the three-tier macro API (`log_*`/`Log`/`LogTarget`), `LogStream` chain writes with `outputStream` inheritance, `LogMessage` atomic buffering via `LogMessageBuffer`'s dual parallel arrays, `LogHandle`/`LogTargetHandle` type erasure, 12 `LogDecorations` decorators with three-tier performance classification, `LogDecorators` bitmask parsing, and `LOG_PREFIX_LIST` for cross-line GC cycle prefix protocol.
