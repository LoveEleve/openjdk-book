# 03. Output streams + 异常系统 — tty/gclog + Exceptions

> 🟡 Working | outputStream 抽象层 + Exceptions::debug_check_abort
> 读者处境: GC log `-Xlog:gc*:stdout`→gclog_or_tty→outputStream→write to stdout/file。`-XX:+ShowMessageBoxOnError`→`Exceptions::debug_check_abort()`→fprintf+wait——让开发者在 crash 前 attach debugger。

### 1. "outputStream — 多后端抽象"

场景: JVM 输出到多个目标: stdout(tty), file(gclog), string buffer(stringStream), network(JFR streaming)。outputStream 是基类——提供 `print_cr("fmt", args...)` / `write(buf, len)` / `flush()` 虚拟函数——各子类实现自己的 write。

**outputStream 层次** (`ostream.hpp:100-300 + ostream.cpp:50-500`):
```
outputStream(abstract base):
  → virtual write(const char* buf, size_t len) = 0
  → print_cr(const char* fmt, ...) → vsnprintf→write→\n
  → print(const char* fmt, ...) → vsnprintf→write(no \n)

子类:
  fileStream: write(buf, len)→::fwrite(buf, 1, len, fd)
  stringStream: write→append to internal char[] buffer(2x grow)
  bufferedStream: write→accumulate 8K buffer→flush→delegate to child stream
  tty: 全局 singleton fileStream(stdout)
  gclog_or_tty: GC log→either tty or a dedicated log file(per -Xlog)
[C++: ostream.cpp:1147行——outputStream 链支持嵌套(bufferedStream wrapping fileStream)]
```
- 源码: `ostream.hpp:100-250` (outputStream base class) + `ostream.cpp:50-200` (fileStream + stringStream)

- 关键设计: **tty 是全局 singleton** — `#define tty tty::singleton()` — 所有 JVM print 走 tty→通常映射到 stdout。**bufferedStream** — 先缓冲 8K→flush→底层 stream——减少 syscall(write) 次数(GC log 每秒可能百万次 print)。**stringStream** — internal char[] buffer→`as_string()` 返回 C string→JNI 可转换为 Java String。

### 2. "Exceptions + debug_check_abort"

场景: JVM C++ 代码 `assert(size > 0, "size must be positive")`→`vm_abort(msg)`(`debug.cpp:100-200`)→`Exceptions::debug_check_abort(msg)`→if `-XX:+ShowMessageBoxOnError`→`os::message_box(title, msg)`→fprintf + getchar→wait developer attach debugger。

**Exceptions** (`exceptions.cpp:100-400 + debug.cpp:200-400`):
```
Exceptions::debug_check_abort(const char* msg, ...):
  → ThreadCritical tc  // 全局锁——一次只有一个线程 abort
  → if ShowMessageBoxOnError:
      jio_fprintf(defaultStream::error_stream(), "Error: %s\n", msg)
      jio_fprintf(defaultStream::error_stream(), "Do you want to debug? (y/n): ")
      int c = getchar() → if c=='y':
        os::breakpoint()  // int3(0xCC)→触发调试器(GDB/L DB)
  → 如果 not interactive: vm_direct_exit(-1)
[C++: exceptions.cpp:549行——debug_check_abort 在 assert failure 时触发——生产环境 -XX:-ShowMessageBoxOnError(默认关)]
```
- 源码: `exceptions.cpp:100-250` (debug_check_abort→message box + getchar) + `debug.cpp:200-400` (report_assert_msg→format msg→fire abort trigger)

- 关键设计: **`ThreadCritical` 全局锁** — `ThreadCritical tc` 进入临界区(禁止线程切换)——assert failure 时只能一个线程报告——防止多线程 assert 交叉输出。**breakpoint(0xCC)** — x86 int3 指令——触发调试器 SIGTRAP→GDB 中断——开发者可 inspect stack/registers。

---

### 核心悬念

**"outputStream: tty(stdout singleton)/fileStream/gclog_or_tty/stringStream/bufferedStream——嵌套链支持。Exceptions::debug_check_abort: ShowMessageBoxOnError→getchar→breakpoint→GDB debug crash。"** — 下一篇: UTF-8 + JSON + ELF decoder。

> → [04-utf8-json-decoder.md](04-utf8-json-decoder.md)
