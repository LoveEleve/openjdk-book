# 02. Output + 运行时热配置 — 从 log message 到 gc.log

> 🔴 Deep | 13 KP 中的 2 个核心机制
> 读者处境: Tag 过滤出了该输出什么——但输出到哪？能不能在运行时切换输出目标？

### 1. LogOutput — 多输出管道

场景: 同一类日志 (gc+task)——同时输出到 stdout (调试) 和 gc.log (持久化)——两个目标，一个 TagSet。

**LogOutputList 多输出链表** (`logOutputList.hpp:34`):
- 一个 TagSet 绑定多个 Output——每帧日志遍历链表写两次
- [C++: LogOutputList 是单链表——`_output` 指针向头→`_next` 向后。每次 write 遍历整个链表。开销: 双输出=双 write——但每帧 GC 日志通常 <200B——双 write <1µs]
- LogOutput 抽象接口: `write(LogDecorations&, const char* msg)`——虚函数 dispatch (~5ns) (`logOutput.hpp:46`)

**LogFileOutput** (`logFileOutput.hpp:38`):
- 文件名模板: `gc_%p_%t.log` (%p=pid, %t=startup time)
- [C++: `os::replace_fd()`—Linux 用 dup2 原子替换文件描述符。rotate 时: open 新文件→dup2 替换旧 fd→close 旧文件——中间没有"无 fd"的窗口期]
- rotate: size-based (file > filesize→truncate) + signal-based (SIGUSR2→rotate)
- [内核: SIGUSR1/SIGUSR2——用户定义信号，默认行为 terminate。JVM 注册 handler 替代——`kill -USR2 <pid>` → rotate 而非 kill——不停止 JVM]
- [man 2 dup2] [man 7 signal]

**LogFileStreamOutput** (`logFileStreamOutput.hpp`):
- [C++: JVM 用 POSIX fd (write/fsync) 而非 C++ ofstream——fd 的 flush 控制更精细: fsync 强制写入磁盘 (O_SYNC 打开) vs fflush (只刷新 C 库缓冲)]

### 2. LogConfiguration — -Xlog + jcmd 共用引擎

场景: JVM 启动时 `-Xlog:gc*=debug:gc.log`——运行 3 天后想关掉。`jcmd <pid> VM.log disable gc*`——同一个配置引擎。

**-Xlog 解析** (`logConfiguration.cpp:62-186`):
- `-Xlog:gc*=debug:gc.log:filesize=10M,filecount=5`
- 分段: 第 1 段=Selection (gc*=debug), 第 2 段=Output (gc.log), 第 3 段=OutputOptions (filesize+filecount)
- configure_output: 将 Selection 绑定到 Output——创建 LogFileOutput 对象→注册到对应的 LogTagSet 的 OutputList

**jcmd VM.log 子命令** (`logDiagnosticCommand.cpp:72`):
- `list`: 遍历所有 TagSet→输出当前 level+output
- `disable`: 禁止特定 TagSet 的日志——level 设为 Off
- `output`: 改变输出目标——stdout→file——重新解析 Output 段→create or replace Output
- `decorators`: 改变装饰器——`[uptime][level]` 替代 `[level][tags]`
- [C++: jcmd 和 -Xlog 共享 configure_output——二者用同一个 LogConfiguration 对象。jcmd 修改后——下一帧日志自动使用新配置——不需要重启、不需要 flush 中间缓冲区]

### 3. LogDecorations — 13 种装饰 + 时间缓存

**装饰器** (`logDecorators.hpp:40-95`):
- 13 种: level, tags, uptime, uptimeMillis, timeMillis, timeNanos, hostname, pid, tid
- 格式: `[uptime][level][tags]`——每个输出独立配置
- 缓存: Millis/nanos 以 ms/ns 为单位——同 ms 内的时间戳缓存 (`logDecorations.cpp:83`)
- [C++: `os::javaTimeNanos()` 每帧日志调一次——装饰器层缓存结果——多条日志共用同一时间戳]
- LogMessageBuffer: 1024B 栈上缓冲→>1024B→truncate + `... (truncated)` (`logMessageBuffer.hpp:48`)
- [C++: 为什么用栈缓冲不用堆？→ 避免每条日志 (每秒数千条) 调用 malloc。1024B 覆盖 99% 的日志消息。truncate 比分配新缓冲区 + copy 快——直接丢弃尾部]

**LogStream 适配** (`logStream.cpp:29`):
- outputStream (JVM 内部传统 API)→LogStream 适配器——GC/JIT/Class 的旧代码不用改即可接入 ULF
- [C++: `outputStream::write` 虚函数 → `LogStream::write` 实现——填充 LogMessageBuffer。兼容层: 所有 outputStream 使用者 (GC 日志/JIT 打印/Class 加载) 自动接入 ULF 体系]

---

### 核心悬念

**"怎么在不停 JVM 的情况下让所有 GC 日志从 stdout 切换到 gc.log？"** — `jcmd <pid> VM.log output gc.log`——重新配置 OutputList，下一帧日志开始投到新文件。`-Xlog` 和 jcmd 共享引擎——配置引擎不关心"谁调用了我"——只做 configure_output。tag+selection+output 三层的完全解耦让运行时热配置成为可能。

> → domain 5: [CPU Primitives — 日志依赖的原子操作: 怎么在无锁情况下保证日志消息不丢？](../05-cpu-primitives/01-atomic-and-memory-order.md)
