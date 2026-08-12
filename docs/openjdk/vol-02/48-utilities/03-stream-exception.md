# 03. 输出流与异常上报 — tty 到 fdStream,assert 到 gdb

> **前置依赖**:[48-utilities/01 — vmError 引擎](01-vmerror.md):assert 失败的最终归宿就是它;fdStream 在那里已亮过相
> → **后续**:[04 — UTF-8、JSON 与 ELF 解码器](04-utf8-json-decoder.md)
> 关联域: 04-logging(统一日志 -Xlog 的输出管线)、32-jfr(JSON 输出)、35-dcmd(诊断命令的输出)

## 所有 print 的终点:一个抽象的 write

GC 日志、VM 诊断、assert 信息、hs_err 文件——JVM 里所有的输出最终都汇到 `outputStream` 家族。它的基类只做一件事:把"格式化"和"落盘"分开——上层 `print_cr("fmt", ...)`,底层各子类自己实现 `write`。这篇拆两个主题:输出流的五种子类怎么分工;异常与 assert 怎么一路走到 gdb。

## 1. outputStream:一个抽象,五种子类

### 1.1 场景:同一句 print,五个不同的终点

基类(ostream.hpp:45-142)的核心只有两样东西:

```cpp
// ostream.hpp:96-97、131-132(截取核心,逐字)
   // printing
   void print(const char* format, ...) ATTRIBUTE_PRINTF(2, 3);
   void print_cr(const char* format, ...) ATTRIBUTE_PRINTF(2, 3);
   ...
   // flushing
   virtual void flush() {}
   virtual void write(const char* str, size_t len) = 0;
```

`print_cr` 的实现(ostream.cpp:151-156)是标准套路:`vsnprintf` 格式化 → `do_vsnprintf_and_write`(136-142,优先用调用者提供的 scratch buffer,否则栈上自动缓冲)→ 最终落到 `write`。**所有格式化逻辑都在基类,子类只实现 write**——这就是"多后端"的抽象方式。

五种子类(ostream.hpp:194-300):

| 子类 | write 做什么 | 用途 |
|---|---|---|
| `stringStream`(194) | 追加进内部 char[] 缓冲,自动扩容(48 字节小缓冲起步,ostream.cpp:354 起) | 内存里攒字符串,`as_string()`/`base()` 取出 |
| `fileStream`(234) | `::fwrite` 到 FILE* | 日志文件 |
| `fdStream`(261) | `open()/write()` 直写 fd,**无缓冲** | 致命错误处理器 |
| `bufferedStream`(283) | 攒进缓冲(默认 256 字节起步、上限 10MB,292),满了 flush 给子流 | 减少 syscall |
| `tty`(146,全局指针) | 映射 stdout/stderr | 终端输出 |

`fdStream` 值得单独说——它的注释(257-260)讲得很清楚:

```cpp
// ostream.hpp:257-260(注释逐字)
// unlike fileStream, fdStream does unbuffered I/O by calling
// open() and write() directly. It is async-safe, but output
// from multiple thread may be mixed together. Used by fatal
// error handler.
```

**async-safe、不缓冲、多线程输出会交错**——这正是 48-01 篇 vmError 里那个 `fdStream out(fd_out); fdStream log(fd_log);`(vmError.cpp:1334-1339)的用武之地:崩溃现场里不能依赖任何缓冲(缓冲区状态可能被破坏)、不能 malloc,只能直写 fd。

- [C++: tty 是 `extern outputStream* tty`(ostream.hpp:146),由 `ostream_init` 创建: `tty = defaultStream::instance`(ostream.cpp:922-925),默认走 stdout(fd 1)/stderr(fd 2)。注意 tty 输出有**多线程协调**:`ttyLocker`(161-174)提供 advisory lock——多线程同时 print 时不会互相穿插成乱码]
- [C++: bufferedStream 的注释直说 "Not MT-safe"(282)——缓冲流不保证线程安全,需要外层加锁;stringStream 是 JVM 内部"攒字符串"的常用工具(报错信息、诊断输出都先攒进它再统一处理)]

**关键设计 (斜体)**: *"格式化在基类、落盘在子类"让所有输出共享同一套格式逻辑(缩进、行宽、时间戳),子类各管各的传输——stringStream 攒内存、fileStream 写文件、fdStream 直写、bufferedStream 攒批。而"缓冲"与"async-safe"是互相排斥的两个目标:缓冲省 syscall 但状态复杂、崩溃时不可信;fdStream 放弃缓冲换极端可靠性,专门服务错误处理器。*

## 2. Exceptions 与调试钩子:匹配即 fatal

### 2.1 场景:一个异常,一张中止开关

`Exceptions` 类是 JVM 内部抛异常的入口(exceptions.cpp:549 行)。其中 `debug_check_abort` 是给开发者留的调试钩子:

```cpp
// exceptions.cpp:508-516(逐字)
void Exceptions::debug_check_abort(const char *value_string, const char* message) {
  if (AbortVMOnException != NULL && value_string != NULL &&
      strstr(value_string, AbortVMOnException)) {
    if (AbortVMOnExceptionMessage == NULL || (message != NULL &&
        strstr(message, AbortVMOnExceptionMessage))) {
      fatal("Saw %s, aborting", value_string);
    }
  }
}
```

逻辑很简单:**抛出的异常类名匹配 `AbortVMOnException`,就 `fatal` 中止 VM**。配套标志(globals.hpp:1349-1351):

```
  diagnostic(ccstr, AbortVMOnException, NULL,
          "Call fatal if this exception is thrown.  Example: "
          "java -XX:AbortVMOnException=java.lang.NullPointerException Foo")
```

`fatal` 触发的是完整的 assert 链(第 3 节)→ hs_err + core。典型用法:复现一个只在特定异常时出错的 bug,`-XX:AbortVMOnException=java.lang.NullPointerException` 让 JVM 在抛 NPE 的瞬间留下完整现场。还有个细化开关 `AbortVMOnExceptionMessage`(1353-1356):连异常消息也匹配才中止。`Handle` 版本(518-522)先取异常类名和消息(524-533)再走同一个入口。

**关键设计 (斜体)**: *"匹配即 fatal"是个极简但极其有用的调试模式:不需要在 Java 层打断点、不需要条件编译——启动参数指定类名,JVM 在该异常被抛出的那一帧直接走完整错误通道(crash dump + hs_err)。比起"打印日志再看",它把"现场保存"做成了开关。注意它和 ShowMessageBoxOnError 是两条独立的路:一个是自动中止留现场,一个是交互式问你要不要调试(下节)。*

## 3. assert 链:从 report_vm_error 到 gdb

### 3.1 场景:assert 失败后,发生了什么

C++ 代码里的 `assert(cond, "msg")` 失败 → `report_assert_msg`(debug.cpp:303)→ `report_vm_error`(debug.cpp:237):

```cpp
// debug.cpp:237-250(截取核心,逐字)
void report_vm_error(const char* file, int line, const char* error_msg, const char* detail_fmt, ...)
{
  if (Debugging || error_is_suppressed(file, line)) return;
  va_list detail_args;
  va_start(detail_args, detail_fmt);
  void* context = NULL;
#ifdef CAN_SHOW_REGISTERS_ON_ASSERT
  if (g_assertion_context != NULL && os::current_thread_id() == g_asserting_thread) {
    context = g_assertion_context;
  }
#endif // CAN_SHOW_REGISTERS_ON_ASSERT
  VMError::report_and_die(Thread::current_or_null(), context, file, line, error_msg, detail_fmt, detail_args);
```

**assert 失败 = 调用 48-01 篇那个 `VMError::report_and_die`**——first-error 令牌、STEP 流水线、hs_err_pid.log 全都在那里。在 `report_and_die` 的早期(48-01 篇已见,vmError.cpp:1379-1385),如果 `ShowMessageBoxOnError`(默认 false,globals.hpp:630)打开,会进 `show_message_box`(vmError.cpp:1688-1694):

```cpp
// vmError.cpp:1688-1694(逐字)
void VMError::show_message_box(char *buf, int buflen) {
  bool yes;
  do {
    error_string(buf, buflen);
    yes = os::start_debugging(buf,buflen);
  } while (yes);
}
```

`os::start_debugging`(os_linux.cpp:6467-6491)是交互环节——提示怎么调试:

```cpp
// os_linux.cpp:6471-6480(截取核心,逐字)
  jio_snprintf(p, buflen-len,
               "\n\n"
               "Do you want to debug the problem?\n\n"
               "To debug, run 'gdb /proc/%d/exe %d'; then switch to thread " UINTX_FORMAT " (" INTPTR_FORMAT ")\n"
               "Enter 'yes' to launch gdb automatically (PATH must include gdb)\n"
               "Otherwise, press RETURN to abort...",
               os::current_process_id(), os::current_process_id(),
               os::current_thread_id(), os::current_thread_id());

  bool yes = os::message_box("Unexpected Error", buf);
```

`os::message_box`(5965-5982)用 **fdStream** 打印 `====== Unexpected Error ======` 边框,然后 `::read(0, buf, 16)` 读 stdin——回答 `y` 就 `os::fork_and_exec("gdb /proc/PID/exe PID")`(6482-6488)启动 gdb:内部是 `fork()` + 子进程 `execve("/bin/sh", ["sh", "-c", cmd])`(os_linux.cpp:6327-6345),父进程 waitpid 等它退出。

- [C++: 调试链条全貌:`assert` → `report_assert_msg` → `report_vm_error`(debug.cpp:237)→ `VMError::report_and_die`(48-01 篇的引擎)→ `show_message_box`(vmError.cpp:1688)→ `os::start_debugging`(os_linux.cpp:6467)→ `os::message_box`(5965)读 y/n → `fork_and_exec` 启动 gdb。`os::breakpoint`(526-528)则是另一个工具:直接触发 `int3`(0xCC)让调试器中断]
- [x86: BREAKPOINT 宏展开就是 `int3`(0xCC)——单字节断点指令,调试器 SIGTRAP;`os::breakpoint()` 常用于开发期"停在这里看现场"]

**关键设计 (斜体)**: *错误处理分了三级,对应三种调试场景:① `ShowMessageBoxOnError`——交互式,问要不要挂 gdb(默认关,适合开发/复现);② `AbortVMOnException`——自动式,异常匹配就 fatal 留现场(默认关,适合复现特定 bug);③ 默认全关——直接走 hs_err + core,生产环境零打扰。**三把钥匙都在 VMError 的门口**:消息框是"慢速人工通道",fatal 是"自动快照",core 是"保底"。开发者按需开锁,生产默认全锁。*

## 核心悬念

"输出流的五种子类、异常的两个调试钩子、assert 的 gdb 链路——它们处理的都是'文本'。而 JVM 与外部世界交换的格式不止文本:UTF-8 编码(modified UTF-8 的 0xC0 0x80 陷阱)、JSON(JFR 录制)、ELF 符号(地址到函数名)。下一篇:UTF-8、JSON 与 ELF 解码器——三个格式工具的底层实现。"

> → [04-utf8-json-decoder.md](04-utf8-json-decoder.md):modified UTF-8、JSONWriter、ElfDecoder
