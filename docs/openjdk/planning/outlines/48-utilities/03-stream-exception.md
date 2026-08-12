# 03. Output streams + 异常上报 — tty/gclog + Exceptions

> 🟡 Working | outputStream 抽象层 + Exceptions::debug_check_abort
> 读者处境: `-Xlog:gc*` 统一日志→outputStream 家族;`-XX:AbortVMOnException`→fatal;`-XX:+ShowMessageBoxOnError`→交互问是否挂 gdb。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/48-utilities/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **`gclog_or_tty` 在 jdk11u 不存在**——JDK 9+ 统一日志(-Xlog)替代
> - **tty 不是 `tty::singleton()`**——是 `extern outputStream* tty`(ostream.hpp:146),`ostream_init` 里 `tty = defaultStream::instance`(ostream.cpp:922-925)
> - **`Exceptions::debug_check_abort` 不是消息框流程**——它检查 `AbortVMOnException` 匹配即 `fatal("Saw %s, aborting")`(exceptions.cpp:508-516);消息框在 VMError::show_message_box(vmError.cpp:1688)+ os::start_debugging/os::message_box(os_linux.cpp:6467/5965)
> - bufferedStream 默认 256 字节起步/上限 10MB(ostream.hpp:292),非"8K";networkStream 是 !PRODUCT 调试工具,与 JFR streaming 无关
> - "os::breakpoint(0xCC)在 debug_check_abort 里触发" 不存在——breakpoint(os_linux.cpp:526)是独立调试工具

### 1. "outputStream — 多后端抽象"

场景: JVM 输出到多个目标: stdout(tty)、file(fileStream)、string buffer(stringStream)、fd(fdStream)、缓冲(bufferedStream)。outputStream 基类提供 print/print_cr(格式化在基类),各子类实现 write(落盘在子类)。

**outputStream 层次** (`ostream.hpp:45-142` 基类 + 子类 194-300):
```
outputStream(45): 纯虚 write(const char* str, size_t len) = 0 (132)
  → print/print_cr(ostream.cpp:144-156) → do_vsnprintf_and_write(136-142) → write
子类:
  stringStream(194): 内部 char[] 自动扩容(48B 小缓冲起步, write@354), base()/as_string()/freeze()
  fileStream(234): FILE* 包装(fwrite)
  fdStream(261): open()/write() 直写,无缓冲,async-safe(注释 257-260:"Used by fatal error handler")
  bufferedStream(283): 缓冲(默认 256/上限 10MB, 292), "Not MT-safe"(282)
  tty(146): extern 全局指针 = defaultStream 单例(ostream.cpp:922-925),默认 stdout/stderr;ttyLocker(161-174) advisory lock
[C++: ostream.cpp:1147行——错误处理器用 fdStream(vmError.cpp:1334-1339, 48域01衔接);O_BUFLEN=2000(302)]
```
- 源码: `ostream.hpp:45-142` (基类) + `194-300` (子类) + `ostream.cpp:136-156` (print 链)

- 关键设计: **格式化与落盘分离** — print/print_cr/缩进/时间戳全在基类,子类只实现 write。"缓冲"与"async-safe"互斥:fdStream 放弃缓冲换极端可靠性,专门服务崩溃现场(崩溃时缓冲状态不可信)。

### 2. "Exceptions::debug_check_abort — 匹配即 fatal"

场景: 复现"只在某异常时出错"的 bug → `-XX:AbortVMOnException=java.lang.NullPointerException` → 抛 NPE 的瞬间 fatal。

**debug_check_abort**(`exceptions.cpp:508-516`):
```
void Exceptions::debug_check_abort(const char *value_string, const char* message):
  → if AbortVMOnException != NULL && strstr(value_string, AbortVMOnException):
      if AbortVMOnExceptionMessage == NULL || strstr(message, AbortVMOnExceptionMessage):
        fatal("Saw %s, aborting", value_string)
  Handle 版本(518-522)先取异常类名/消息(524-533)再走同一入口
[glags: AbortVMOnException(globals.hpp:1349-1351, diagnostic, 默认 NULL) + AbortVMOnExceptionMessage(1353-1356)]
```
- 源码: `exceptions.cpp:508-533` (debug_check_abort 全部)

- 关键设计: **"匹配即 fatal"调试模式** — 启动参数指定类名,JVM 在该异常抛出的瞬间走完整错误通道(hs_err+core),把"现场保存"做成开关。与 ShowMessageBoxOnError 是两条独立的路:自动中止 vs 交互调试。

### 3. "assert 链:从 report_vm_error 到 gdb"

场景: C++ `assert(cond, "msg")` 失败 → 完整错误通道;开 ShowMessageBoxOnError 则交互问是否挂 gdb。

**链条**(`debug.cpp:237-250` + `vmError.cpp:1688` + `os_linux.cpp:6467`):
```
assert 失败 → report_assert_msg(debug.cpp:303) → report_vm_error(237-250) → VMError::report_and_die(248, 48域01引擎)
  → report_and_die 早期(vmError.cpp:1379-1385): ShowMessageBoxOnError(默认 false, globals.hpp:630)
      → show_message_box(vmError.cpp:1688-1694) → os::start_debugging(os_linux.cpp:6467-6491):
          "To debug, run 'gdb /proc/%d/exe %d'..." → os::message_box(5965-5982, fdStream 边框 + read(0) 等 y)
          → 'y' → os::fork_and_exec("gdb ...")(6482-6488; fork+execve sh -c, 6327-6345)
os::breakpoint(os_linux.cpp:526-528): BREAKPOINT 宏 = int3(0xCC),独立调试工具
[C++: 三级调试: ShowMessageBoxOnError 交互 / AbortVMOnException 自动 / 默认全关 → hs_err+core]
```
- 源码: `debug.cpp:237-250` (report_vm_error) + `vmError.cpp:1688-1694` (show_message_box) + `os_linux.cpp:6467-6491` (start_debugging)

- 关键设计: **错误处理三级钥匙** — 消息框(慢速人工通道)/fatal(自动快照)/core(保底),开发者按需开锁,生产默认全锁。

---

### 核心悬念

**"outputStream: 格式化在基类、落盘在子类——stringStream 攒内存、fdStream 直写 async-safe、bufferedStream 攒批。Exceptions::debug_check_abort: AbortVMOnException 匹配即 fatal。assert→report_vm_error→VMError::report_and_die→ShowMessageBoxOnError→message_box→fork_and_exec gdb。"** — 下一篇: UTF-8 + JSON + ELF decoder。

> → [04-utf8-json-decoder.md](04-utf8-json-decoder.md)
