# PROMPT: 请撰写 01-Output-Pipeline.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1：日志轮转故障 — 磁盘写满但日志未轮转**

```
$ java -Xlog:gc*=debug:file=/var/log/app/gc.log:filecount=5,filesize=10M -jar app.jar
... 运行若干小时后 ...
$ ls -la /var/log/app/
-rw-r--r-- 1 app app    10485760 Jun 18 14:22 gc.log
-rw-r--r-- 1 app app    10485760 Jun 18 12:15 gc.log.0
-rw-r--r-- 1 app app    10485760 Jun 18 10:08 gc.log.1
...
-rw-r--r-- 1 app app 10737418240 Jun 18 14:20 gc.log  ← 一个文件膨胀到 10GB
$ df -h /var/log
/dev/sda1  50G  50G  0  100% /var/log   ← 磁盘写满
```

根因分析：每个 `write()` 调用后 `_current_size += written` 并检查 `should_rotate()`（`logFileOutput.cpp:283-290`）。但如果配置了 `filesize=10M`，`_current_size >= _rotate_size` 时触发 rotate。然而磁盘满后 `fclose()` / `fopen()` 失败，_stream 可能被污染的半状态导致后续 `write()` 安静丢弃（`logFileOutput.cpp:279-281`: `if (_stream == NULL) return 0`）。用户看不到任何日志丢失警告——JVM 只向 stderr 打印 `jio_fprintf` 错误（`logFileOutput.cpp:326-327`），而 stderr 可能也被重定向或忽略。

**场景 2：multiline 日志被 stdout/stderr 截断**

生产环境中通过 `-Xlog:all=info:stdout:time,level,tags` 将日志输出到 stdout 交给 logstash/fluentd 管道，但遇到多行消息时：`LogFileStreamOutput::write(LogMessageBuffer::Iterator)`（`logFileStreamOutput.cpp:91-107`）在循环中依次 `jio_fprintf(_stream, "%s\n", msg_iterator.message())`，整个循环包裹在 `os::flockfile/fflush/funlockfile` 中一次性写出。但如果 stdout 缓冲模式被外部程序修改（例如通过 `setvbuf` 改为行缓冲），中间行可能被截断——因为 `fflush` 在循环后执行（`logFileStreamOutput.cpp:103`），并非每行都 flush。外部日志采集器可能捕获到不完整的多行输出块。

**场景 3：配置字符串解析失败 — 选项被静默忽略**

运维配置 `-Xlog:gc*=info:file=gc.log:filecount=abc,filesize=50M`。`parse_options()` 解析 `filecount=abc` 时 `parse_value("abc")`（`logFileOutput.cpp:77-84`）中 `strtoull("abc", &end, 10)` 返回 0 且 `*end == 'a'`，`isdigit(*value_str)` 检查失败 → `return SIZE_MAX`。调用处 `if (value > MaxRotationFileCount)` 为真（SIZE_MAX > 1000）→ 打印错误但只打印到 `errstream`（`logFileOutput.cpp:192-193`）。如果 `errstream` 不是 stderr（启动早期可能是 null），用户看到 "successfully initialized" 的日志但 `filecount` 实际保持 `DefaultFileCount=5`。

**三步诊断**：
```bash
# 1. 检查实际生效的日志配置（不是命令行参数，而是 JVM 内部状态）
jcmd <pid> VM.log list  # 输出各 output 的实际 config_string，例如 "all=debug,gc*=trace"

# 2. 验证文件轮转行为
ls -la gc.log* && stat gc.log && stat gc.log.0
# 如果只有一个 gc.log 且在增长，说明轮转未触发

# 3. GDB 验证 write() 分支
gdb -ex "break logFileOutput.cpp:279" \
    -ex "break logFileOutput.cpp:288" \
    -ex "break logFileOutput.cpp:360" \
    -ex "run" \
    -ex "print _current_size" \
    -ex "print _rotate_size" \
    -ex "print _stream" \
    --args java -Xlog:gc*=debug:file=gc.log:filecount=5,filesize=10M -jar app.jar
```

**反事实**：如果 LogFileOutput::write() 不使用 `_rotation_semaphore` 信号量同步 → 两个线程同时检测到 `should_rotate()` 为 true → 两个线程同时调用 `rotate()` → 两者都 `archive()` → 第二次 `rename(gc.log, gc.log.0)` 覆盖首次归档（`logFileOutput.cpp:322-325`，`remove` + `rename` 不是原子的）→ 日志丢失。当前设计的 Semaphore(1) 确保一次只有一个线程做旋转，但这意味着旋转时所有 writer 线程被阻塞在 `_rotation_semaphore.wait()`（`logFileOutput.cpp:284`）。

---

## §一 Task + Narrative + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the Output Pipeline of HotSpot's Unified Logging — the subsystem that translates "a log message is ready to be written" into actual file/stream bytes. This covers the three-tier class hierarchy (`LogOutput` → `LogFileStreamOutput` → `LogFileOutput`), the thread-safe output list with lock-free iteration, and the file rotation mechanism that is critical for production log management.

Reader has completed **00-Tag-Level-Selection-Configuration** (Tag/Level/Selection parsing + LogConfiguration dispatch). This doc: **how log messages actually reach disk/console — from the Iterator in the output list to the rename(2) in rotation**.

### Interview Story Format Answer（必须出现在 §一 末尾）

"When a log message passes the TagSet-Level filter, it hits LogOutputList::iterator(level) (`logOutputList.hpp:135`). The iterator starts at `_level_start[level]` — a precomputed index that jumps directly to the first node for that level. Each node is a LogOutput*; the list is sorted from coarsest to finest level, so `iterator(info)` walks through info + debug + trace outputs. Each `LogOutput::write()` is dispatched polymorphically: `LogFileStreamOutput` wraps `jio_fprintf` on a `FILE*` with per-FILE locking via `os::flockfile/funlockfile` — the write of decorations + message + newline is one atomic block to that FILE. `LogFileOutput` extends this by tracking `_current_size` and calling `rotate()` when it exceeds `_rotate_size`: `rotate()` does `fclose` → `archive()` (rename from `gc.log` to `gc.log.3` via `rename(2)`) → `fopen` → reset `_current_size`. The key design constraint: rotation happens under a Semaphore(1) that serializes all writers, and if `fopen` fails, `_stream` stays NULL causing all future writes to silently return 0. The `stdout`/`stderr` outputs are pre-allocated in static memory using placement new to avoid dynamic initialization order issues."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **Virtual dispatch in write()**: `LogOutput::write()` is a pure virtual function (`logOutput.hpp:100`). The actual write is dispatched at runtime based on the concrete type — `LogFileStreamOutput::write()` for stdout/stderr, `LogFileOutput::write()` for rotated files. This is polymorphism without vtable overhead at the call site because the `LogOutput*` pointer is already typed correctly. The key insight: the hot path (`log_is_enabled()` → `write()`) has only ONE virtual dispatch — the write itself — all prior checks (level, tag match) are inline/non-virtual.

2. **flockfile vs mutex**: `LogFileStreamOutput::write()` uses `os::flockfile(_stream)` (`logFileStreamOutput.cpp:79`) instead of a global mutex. Why? `flockfile` locks only the specific `FILE*` object — two threads writing to different outputs don't contend. If we used a shared mutex, a debug log to file would block an error log to stderr. This is per-output concurrency: `Semaphore(1)` for rotation serialization applies only to the specific `LogFileOutput` instance.

3. **rename(2) is NOT atomic with fopen**: The `archive()` function (`logFileOutput.cpp:314-329`) calls `remove(_archive_name)` then `rename(_file_name, _archive_name)`. Between `remove` and `rename`, another process could create a file at `_archive_name` — which `rename` would then overwrite. More critically, after `rename` succeeds but before `fopen` in `rotate()` reopens the file, the original file name doesn't exist — any external process trying to tail the log sees an empty/missing file briefly.

4. **_current_size tracking**: `_current_size += written` is a simple arithmetic increment, NOT `ftell(_stream)` (`logFileOutput.cpp:286`). Why? `ftell` on a FILE* with buffering (default glibc `fopen("a")` with 8KB buffer) returns the buffer-relative offset, not the file size. The approach: track written bytes manually — assumes `fwrite` writes exactly the number of bytes returned. This is correct because `jio_fprintf` returns the number of characters printed or negative on error, and the accumulated sum matches the file's logical size.

5. **Placement new for static outputs**: `StdoutLog` and `StderrLog` (`logFileStreamOutput.cpp:32-43`) are allocated in pre-reserved `union { char mem[sizeof(LogStdoutOutput)]; }` static memory. They are constructed via `::new (&StdoutLog) LogStdoutOutput()` in `LogFileStreamInitializer`, which is invoked by a static global `LogFileStreamInitializer log_stream_initializer` (`logFileStreamOutput.hpp:39`). This avoids dynamic allocation (`NEW_C_HEAP_ARRAY`) which would require `mtLogging` memory tracking before the logging system is ready — the classic chicken-and-egg problem.

6. **Iterator with active reader count**: `LogOutputList::Iterator` (`logOutputList.hpp:91-133`) follows a read-copy pattern: readers increment `_active_readers` on construction/copy, decrement on destruction. A thread that wants to `remove_output()` must wait until `_active_readers == 0` (`logOutputList.cpp:44-49`). This enables lock-free iteration during steady-state logging — multiple threads can iterate the list concurrently as long as no removal is happening. The wait is a busy-loop (`OrderAccess::storeload()` + spin), which is safe because removals are rare (only on reconfiguration).

7. **Greedy config string compression**: `LogOutput::update_config_string()` (`logOutput.cpp:220-340`) doesn't just concatenate all tag-level pairs — it uses a greedy algorithm to find the minimal set of LogSelections that covers all deviating tag sets. Why? The config string appears in `jcmd VM.log list` output and has a maximum display width. A 200-tag JVM with 50 deviating levels would produce a multi-KB string without compression. The algorithm iteratively picks the selection with the best "score" (correct matches minus incorrect matches) and re-generates selections for remaining deviates until none remain.

---

## §二 Standard Environment

OpenJDK 17 (compatible with OpenJDK 11 source layout), 64-bit Linux.

Source roots:
- `src/hotspot/share/logging/logOutput.hpp` — base class interface (:1-104)
- `src/hotspot/share/logging/logOutput.cpp` — config string update algorithm (:1-341)
- `src/hotspot/share/logging/logOutputList.hpp` — output list container (:1-145)
- `src/hotspot/share/logging/logOutputList.cpp` — list operations with RCU (:1-128)
- `src/hotspot/share/logging/logFileStreamOutput.hpp` — FILE*-based output (:1-93)
- `src/hotspot/share/logging/logFileStreamOutput.cpp` — write_decorations + write (:1-107)
- `src/hotspot/share/logging/logFileOutput.hpp` — file rotation output (:1-99)
- `src/hotspot/share/logging/logFileOutput.cpp` — rotation logic + option parsing (:1-455)

Build: `make jdk` (logging is part of libjvm.so, entry in `make/hotspot/lib/CompileJvm.gmk:153`)

Key binary: `build/linux-x86_64-server-*/jdk/lib/server/libjvm.so` — all logging .cpp compiled in

Syscall 速查表：

| Syscall | man | 出现位置 | 用途 |
|---------|-----|---------|------|
| `rename` | `man 2 rename` | `logFileOutput.cpp:325` | 日志文件归档重命名 |
| `remove` | `man 3 remove` (→ unlink(2)) | `logFileOutput.cpp:322` | 删除旧归档文件 |
| `fopen` | `man 3 fopen` | `logFileOutput.cpp:263,352` | 打开/重新打开日志文件 |
| `fclose` | `man 3 fclose` | `logFileOutput.cpp:67,343` | 关闭日志文件 |
| `fflush` | `man 3 fflush` | `logFileStreamOutput.cpp:85,103` | 刷新 FILE* 缓冲区 |
| `stat` | `man 2 stat` | `logFileOutput.cpp:88,97,105` | 检查文件属性(FIFO/regular/exists) |
| `ftruncate` | `man 2 ftruncate` | `logFileOutput.cpp:272` | 截断非轮转日志文件 |
| `strftime` | `man 3 strftime` | `logFileOutput.cpp:61` | 生成 %t 时间戳文件名 |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **logOutput.hpp** | `src/hotspot/share/logging/logOutput.hpp` | 104 | `write()=0`(:100-101), `force_rotate()`(:92-94), `initialize()=0`(:99), `add_to_config_string()`(:57), `update_config_string()`(:66), `set_config_string()`(:63) | 抽象基类接口 + 配置字符串管理 |
| 2 | **logOutput.cpp** | `src/hotspot/share/logging/logOutput.cpp` | 341 | `update_config_string()`(:220-340), `add_to_config_string()`(:64-87), `set_config_string()`(:58-62), `describe()`(:39-56), `~LogOutput()`(:35-37) | 配置字符串贪婪压缩算法 |
| 3 | **logOutputList.hpp** | `src/hotspot/share/logging/logOutputList.hpp` | 145 | `Iterator`(:91-133), `set_output_level()`(:89), `add_output()`(:60), `remove_output()`(:59), `level_for()`(:80-86), `is_level()`(:76-78) | 输出链表容器 + 迭代器定义 |
| 4 | **logOutputList.cpp** | `src/hotspot/share/logging/logOutputList.cpp` | 128 | `add_output()`(:97-122), `remove_output()`(:71-95), `update_output_level()`(:124-128), `find()`(:62-69), `increase_readers()`(:32-36), `decrease_readers()`(:38-42), `wait_until_no_readers()`(:44-49) | 链表操作 + 无锁读取同步 |
| 5 | **logFileStreamOutput.hpp** | `src/hotspot/share/logging/logFileStreamOutput.hpp` | 93 | `LogFileStreamOutput(FILE*)`(:47-51), `write_decorations()`(:53), `write()`(:56-57), `LogStdoutOutput`(:60-73), `LogStderrOutput`(:75-88), `LogFileStreamInitializer`(:33-36) | FILE* 抽象层 + stdout/stderr 单例 |
| 6 | **logFileStreamOutput.cpp** | `src/hotspot/share/logging/logFileStreamOutput.cpp` | 107 | `write_decorations()`(:53-73), `write(decorations,msg)`(:75-89), `write(msg_iterator)`(:91-107), `LogFileStreamInitializer()`(:45-51) | 写入装饰器 + 多行写入循环 |
| 7 | **logFileOutput.hpp** | `src/hotspot/share/logging/logFileOutput.hpp` | 99 | `parse_options()`(:68), `archive()`(:66), `rotate()`(:67), `should_rotate()`(:71-73), `increment_file_count()`(:75-79), `make_file_name()`(:69), `initialize()`(:85) | 文件轮转输出专用接口 |
| 8 | **logFileOutput.cpp** | `src/hotspot/share/logging/logFileOutput.cpp` | 455 | `initialize()`(:222-276), `write(decorations,msg)`(:278-294), `write(msg_iterator)`(:296-312), `rotate()`(:341-362), `archive()`(:314-329), `force_rotate()`(:331-339), `parse_options()`(:164-220), `make_file_name()`(:364-445) | 文件轮转核心实现 |

---

## §四 Deep Dive Question Groups（≥6 groups，each with counterfactual）

### 4.1 ★★★ LogOutput 虚函数体系 — 三层类继承与多态分派

```
问题：
  ① LogOutput 定义了哪些纯虚函数，各自的职责是什么？
      答案方向：logOutput.hpp:98-101 定义 3 个纯虚函数：
        - name() const = 0 → 返回输出名称（"stdout"/"stderr"/文件路径）
        - initialize(const char* options, outputStream* errstream) = 0 → 解析选项并初始化
        - write(LogDecorations&, const char* msg) = 0 → 单行写入
        - write(LogMessageBuffer::Iterator msg_iterator) = 0 → 多行批量写入
      非纯虚但可覆盖的函数：
        - force_rotate() → logOutput.hpp:92-94 默认空实现，只有 LogFileOutput 重写
        - describe(outputStream*) → logOutput.cpp:39-56 打印输出配置信息
        - ~LogOutput() → logOutput.cpp:35-37 释放 _config_string 内存
      _decorators (LogDecorators) 在基类 protected 中，决定哪些装饰器被写入。

      追问：为什么 force_rotate() 不是纯虚函数？
      → stdout/stderr 不支持轮转，提供空默认实现避免所有子类必须实现它。这是
        "Template Method with hook" 模式：hook 默认什么都不做，特定子类覆盖。

  ② Counterfactual: 如果 write() 不是虚函数，而是用函数指针表或 switch-case 分派？
      答案方向：每种输出类型用一个 enum + switch-case → 每次添加新输出类型需要
      修改所有调用点 → 违反开闭原则。虚函数表的额外开销是每次调用 ~2ns（一次
      vtable 查表 + 间接跳转），在 JVM 日志热路径上——每个 log_debug 语句都触发
      一次虚拟调用——2ns × 百万次日志/秒 = 2ms CPU 额外开销。这个开销被 C++ 的
      devirtualization 优化降低：如果编译器能证明运行时类型（通过 PGO 或类型传播），
      虚调用可被转换为直接调用。
```

### 4.2 ★★★ LogFileStreamOutput — flockfile 写入路径与装饰器对齐

```
问题：
  ① write(decorations, msg) 的完整写入流程是怎样的？
      答案方向：logFileStreamOutput.cpp:75-89：
        1. 检查 _decorators.is_empty() — 没有装饰器则跳过格式化
        2. os::flockfile(_stream) — 获取 FILE* 级锁，同 stream 多线程互斥
        3. 如有装饰器：write_decorations(decorations) 逐个写入 "[value]" 格式
        4. jio_fprintf(_stream, " ") — 装饰器和消息体之间空格
        5. jio_fprintf(_stream, "%s\n", msg) — 写入消息体 + 换行
        6. fflush(_stream) — 将缓冲区 flush 到内核
        7. os::funlockfile(_stream) — 释放锁
      装饰器对齐：write_decorations() (logFileStreamOutput.cpp:53-73) 保持每个
      装饰器列的宽度一致——_decorator_padding[decorator] 跟踪每个装饰器的最大宽度，
      后续写入时用 %-*s 左对齐填充空格，确保同一输出的所有日志行装饰器列对齐。

      追问：为什么 fflush 在 flockfile/funlockfile 之间调用而不是之后？
      → flockfile 保护的是"写入+flush"的原子性。如果 flush 在 unlock 之后，另一个
        线程可能在 flush 前写入，导致行交错。实际上 fflush 不需要 flockfile 保护——
        但放里面确保逻辑完整性。从性能角度看，flockfile 持有时间约 = 写入时间 +
        flush 时间（flush 是主要开销），减少 fflush 频率比减少锁持有时间更重要。

  ② Counterfactual: 如果不使用 flockfile，而使用全局 pthread_mutex_t？
      答案方向：`os::flockfile` 是对 glibc `flockfile(3)` 的封装——每个 FILE* 有
      独立的内部锁。而全局 mutex 会让 stdout 写入阻塞 stderr 写入（反之亦然）。
      在生产环境中，error 日志永远不应该被 gc 调试日志阻塞——错误日志需要即时可见。
      使用共享 mutex → gc debug 日志持有锁 → 另一个线程的 error 日志被阻塞 →
      崩溃前最后的 error message 丢失 → 排查困难。
      flockfile 的正确性前提：所有操作使用同一个 FILE* 对象。这就是 why LogFileOutput
      的 rotate() 在 Semaphore 保护下修改 _stream — 不能有两个 FILE* 同时存在于 _stream 中。
```

### 4.3 ★★★ LogFileOutput 文件轮转 — 从 write() 到 rename(2) 的完整路径

```
问题：
  ① write() 中如何触发 rotate()？完整的同步保护是怎样的？
      答案方向：logFileOutput.cpp:278-294
        1. _stream == NULL 检查（输出已损坏，静默丢弃）
        2. _rotation_semaphore.wait() — 获取旋转信号量（计数为 1，互斥）
        3. 调用父类 LogFileStreamOutput::write() 完成实际写入
        4. _current_size += written — 累加已写字节数（不是 ftell）
        5. should_rotate() 检查 → _file_count > 0 && _rotate_size > 0 && _current_size >= _rotate_size
        6. 如果满足 → rotate() → fclose + archive + fopen + reset current_size
        7. _rotation_semaphore.signal()

      rotate() 内部（logFileOutput.cpp:341-362）：
        1. fclose(_stream) — 关闭当前文件, flush 剩余缓冲
        2. archive() — 将文件重命名为归档名 (gc.log → gc.log.3)
        3. fopen(_file_name, "a") — 重新打开原始文件名（追加模式）
        4. _current_size = 0 — 重置已写字节计数
        5. increment_file_count() — _current_file++ 环回到 0

      追问：为什么 _rotation_semaphore 用 Semaphore 而不是 Mutex？
      → Semaphore 比 Mutex 更重（需要维护计数器和等待队列），但这里不需要 Mutex
        的优先级继承或递归锁特性——只有互斥需求。OpenJDK 的 Semaphore 基于
        PlatformEvent，支持中断等待（Safepoint 检查）。更重要的是：如果 writer 在
        wait() 期间收到 safepoint 请求，Semaphore 可以正确响应，而裸 Mutex 可能导致
        safepoint 延迟。

  ② Counterfactual: 如果在 rotate() 期间线程被 safepoint 挂起会发生什么？
      答案方向：rotate() 中 fclose → archive → fopen 不是原子的步骤链。如果一个线程
      A 执行 fclose 后被 safepoint 挂起，线程 B 或许会尝试 write() → 看到 _stream == NULL
      → 返回 0（静默丢弃日志）。但如果 Semaphore 保护正确，线程 B 在 _rotation_semaphore.wait()
      处阻塞，不会进入 write() 逻辑。问题在于：如果 Semaphore 在 safepoint 期间释放
      （PlatformEvent::unpark 能在 safepoint 期间执行），另一个线程可能在 A 恢复前获取
      信号量并操作半完成状态。_stream 的修改（从有效 → NULL → 有效）必须对整个系统可见。
      rotate() 中 fclose 后 _stream = fopen(...) 前，_stream 是 NULL。如果线程 B 在
      Semaphore 外读取 _stream（例如 describe()），会看到不一致状态。
```

### 4.4 ★★★ archive() 与 rename(2) 的原子性问题

```
问题：
  ① archive() 中 remove() + rename() 的组合为什么不是原子的？可能丢失什么？
      答案方向：logFileOutput.cpp:314-329：
        1. jio_snprintf → 构造归档文件名 "%s.%0*u" (gc.log → gc.log.3)
        2. remove(_archive_name) → 先删除可能存在的旧归档
        3. rename(_file_name, _archive_name) → 将当前日志改名

      原子性缺口：
        - remove 和 rename 之间：如果外部进程在这间隙创建了 _archive_name 文件，
          rename 会原子地覆盖它（rename(2) 的 POSIX 语义：如果目标存在且是普通文件，
          原子替换）。所以这个 gap 不丢数据，只可能覆盖外部进程的文件。
        - 真正的问题：当前日志文件 gc.log 在 fclose 和 rename 之间不存在。外部 tail -f
          会报告文件被截断/消失。rename 本身是原子的（同一文件系统），但 rename 不保证
          "gc.log 内容完整写入 gc.log.3" 和 "外部观察者能看到 gc.log.3" 之间的 happens-before。
          如果外部程序在 rename 后立即 stat gc.log.3 → 文件属性已更新，但 rename 的
          元数据操作可能还在页缓存中被调度。

      追问：为什么不用 O_APPEND + link/unlink 实现 logrotate 避免 rename？
      → 标准 Linux logrotate 模式：进程打开文件后，外部工具 move 文件 + 发 SIGHUP。
        JVM 不能依赖外部工具 —— 日志系统必须自包含。O_APPEND 只保证追加写入不覆盖
        已有内容，不提供文件计数和大小触发。JVM 选择 rename 是因为它跨平台且在单一
        文件系统内原子化。

  ② Counterfactual: 如果 JVM 使用 mmap + msync 替代 fopen/fclose/rename？                  
      答案方向: mmap 映射日志文件到进程地址空间 → memcpy 写入共享页 → msync 刷盘 —
      跳过 libc FILE* 缓冲层。轮转时：munmap 旧文件 → rename → mmap 新文件 — 没有
      fclose/fopen 的缓冲区管理。优势：零拷贝写入（直接 memcpy 到文件映射页），
      避免 libc 缓冲开销；轮转只是重新映射页表。劣势：需要连续的虚拟地址空间
      （filesize=50M 固定），不支持动态增长；页缓存由内核管理而非 libc，跨平台行为
      不一致（Windows 的 MapViewOfFile 语义不同于 mmap）。
      JVM 选择 stdio 的理由：标准化语义（fopen/fclose/fflush 在任何 ANSI C 平台行为
      一致）+ 调用者不需要理解 mmap 参数（PROT_WRITE | MAP_SHARED）+ fflush 比 msync
      更轻量（只刷 libc 缓冲不刷磁盘）。
```

### 4.5 ★★★ LogOutputList — 无锁迭代 + 读写分离

```
问题：
  ① 为什么 LogOutputList 需要 _level_start[LogLevel::Count] 数组？Iterator 如何使用它？
      答案方向：logOutputList.hpp:47-57。_level_start[i] 是指向第一个在第 i 级或更细
      级别的输出节点的指针。链表按从粗到细排序（Error → Warning → Info → Debug → Trace）。

      迭代器构造（logOutputList.hpp:135-138）：
        Iterator iterator(LogLevelType level = LogLevel::Last) {
          increase_readers();  // 原子增 _active_readers
          return Iterator(this, _level_start[level]);
          // 如果 level=Info, _level_start[Info] 跳到第一个 Info 级节点
          // 而非从链表头（Error）开始遍历
        }

      此设计避免了遍历所有高于当前级别的节点。例如 Trace 级别消息用 `iterator(Trace)`
      直接跳到 _level_start[Trace]，跳过所有 Error~Debug 节点。
      遍历方向：_level_start[Trace] → next → next → NULL，期间所有节点都 >= Trace 级，
      保证 Trace 消息被所有后续（更细级别）的输出处理。

      追问：为什么 _level_start 的更新（add_output 中）需要从 Last 向下更新？
      → logOutputList.cpp:109-113: `for (int l = LogLevel::Last; l >= level; l--)`
        新节点在 level X 加入。假设 _level_start[Debug] 原本指向 Debug 和 Trace 混编
        的某节点，新 Info 节点插入到链表前面 → _level_start[Debug] 和 _level_start[Trace]
        需要更新指向新节点（因为新节点在 Info 级别，比 Debug/Trace 更粗但更靠前）。
        从 Last 向下遍历确保所有受影响级别的索引都被修正。

  ② Counterfactual: 为什么不使用 std::vector<LogOutput*> 按级别分组？
      答案方向: vector 的遍历是各级别分别遍历 → Info 消息需要分别遍历 Info vector、
      Debug vector、Trace vector → 三次遍历而非一次链式遍历。链表允许一次遍历覆盖
      所有 >= level 的输出 — 这正是 Iterator::operator++ 的作用。
      vector 的删除需要 O(n) 元素移动，而链表删除只需 O(1) next 指针修正。
      但链表的缓存局部性差 — 节点分散在堆中，每次迭代是随机内存访问。对于高频
      日志（百万次/秒），这可能是瓶颈。HotSpot 的选择：链表灵活性优先于缓存局部性—
      配置重载是低频操作，但要求快速插入/删除，而日志写入频率可配置（线上通常只打
      info/warning，低频）。
```

### 4.6 ★★★ update_config_string() — 贪婪压缩算法

```
问题：
  ① 配置字符串 "all=info,gc*=debug,gc+heap=trace,jit=debug" 是如何产生的？
      答案方向：logOutput.cpp:220-340 的算法流程：
        1. 找出 Most Common Level (MCL) — 遍历 on_level[] 找出频率最高的级别
        2. 以 "all=<MCL>" 开头 — set_config_string("all=info")
        3. 收集所有 deviating tag sets（级别 != MCL 的 tag sets）
        4. 对每个 deviating tag set，生成所有可能的 selection（所有 tag 子集 × exact/wildcard）
        5. 贪婪选择：挑选得分最高的 selection
           - 分数 = 正确匹配的 deviating tag sets 数 - 错误匹配的 tag sets 数
           - 同分选 tag 最少的 selection（更简洁）
        6. add_to_config_string(best_selection) → 拼接到 _config_string
        7. 移除被覆盖的 deviating tag sets，重新生成 selections → 循环

      此算法不保证最优解（最小字符串长度），但保证 O(n³) 时间内找到合理压缩。
      最优解是集合覆盖问题（NP-hard）——精确求解会 O(2^n)。

      追问：为什么 "all=info" 总是第一部分？
      → "all" 是通配符 selection，匹配所有 tag sets。通过先设置 all=MCL，只有
        偏离 MCL 的 tag sets 需要额外 selections。例如如果 90% 的 tags 在 info 级别，
        只需额外指定 10% 的偏离项，而不是枚举所有 100 个 tag。

  ② Counterfactual: 如果将 config string 直接用 iterator 展开为每个 tag set 独立一行？
      答案方向: jcmd VM.log list 的输出会变成几百行——对 200+ tag 的 JVM，不可读。
      config string 是 admin 的界面，压缩是必需的。但压缩算法有代价：它假设"MCL 是最
      常见的"，如果实际上 distribute 均匀（每个级别 20%），"all=info" 后需要大量补充
      selections → 压缩比很低。更好的设计可能是允许用户指定 default 级别：但目前没有
      "default=info" 语法，这个优化被推迟了。

```

### 4.7 ★★★ make_file_name() — %p/%t 占位符替换

```
问题：
  ① make_file_name() 如何将 "%p" 和 "%t" 替换为运行时值？
      答案方向：logFileOutput.cpp:364-445：
        1. strstr 查找 "%p" 和 "%t" 在文件名中的位置
        2. 确定 first/second 占位符（按在字符串中出现顺序，而非类型）
        3. 计算结果缓冲区长度: 原文件名长 + pid长度 - 占位符长 + 时间戳长 - 占位符长
        4. 遍历组装：逐字符复制原文件名，到达占位符位置时 strcpy 替换字符串
        5. 末尾补 '\0'

      实际文件名示例：
        -Xlog:gc*=info:file=/var/log/gc-%p.log → /var/log/gc-12345.log
        -Xlog:all=trace:file=/var/log/jvm-%t.log → /var/log/jvm-2024-01-15_10-30-00.log
        -Xlog:all:file=/var/log/jvm-%t-%p.log → /var/log/jvm-2024-01-15_10-30-00-12345.log

      _pid_str 和 _vm_start_time_str 是类的 static 成员（logFileOutput.hpp:47-48），
      通过 set_file_name_parameters()（logFileOutput.cpp:54-63）在 JVM 启动时计算一次：
        _pid_str = 当前进程 PID (os::current_process_id())
        _vm_start_time_str = strftime(启动时间, "%Y-%m-%d_%H-%M-%S")

      追问：为什么 pid 和时间戳是 static 而非实例变量？
      → 同一个 JVM 的 PID 和启动时间对所有日志文件都相同——使用 static 避免每个文件
        都存储重复的字符串副本。但这也意味着如果有多个 LogFileOutput 对象创建时间不同，
        它们共享相同的启动时间（创建第一个时设置），而非各自独立的创建时间。

  ② Counterfactual: 如果在文件名中找不到 %p/%t，直接返回原文件名有什么风险？
      答案方向：logFileOutput.cpp:374-376 — `if (pid == NULL && timestamp == NULL)`
        直接 strdup 返回 → 开销是最小的（一个字符串复制）。但如果用户传入未展开的
        路径如 "~/logs/gc.log" — strdup 保留波浪号 — fopen("~/logs/gc.log", "a") 
        → Linux 下波浪号不是 shell 解释的，fopen 在 CWD 下创建字面命名的文件夹
        → 文件夹名 "~" 被创建 → 非预期的行为。这是一个已知的限制：filename 必须是
        fopen 可直接接受的绝对/相对路径，不经过 shell 展开。
```

---

## §五 Article Structure

```
§〇 生产场景
  ★ Scenario 1: 日志轮转故障 — 磁盘写满 + _stream == NULL 静默丢弃
  ★ Scenario 2: 多行日志 stdout 缓冲截断 — fflush 位置陷阱  
  ★ Scenario 3: 配置字符串解析失败 — filecount=abc 被默认为 5
  ★ Counterfactual: 无 Semaphore → 并发 rotate 日志丢失

§一 ★★★ Output Pipeline 全链路源码走读
  ❓ 从 LogTagSet 判定通过到实际文件字节的完整路径
  1.1 LogOutputList::iterator(level) → 跳转到对应级别首节点
  1.2 LogOutput 虚函数体系：纯虚 write() × 2 + 可选 hook force_rotate()
  1.3 LogFileStreamOutput::write() — flockfile 保护 + 装饰器对齐写入
  1.4 LogFileOutput::write() — Semaphore 保护 + _current_size 追踪 + should_rotate 触发
  1.5 rotate() 三步：fclose → archive(rename) → fopen
  1.6 archive() — remove + rename 组合的原子性分析
  1.7 make_file_name() — %p/%t 占位符展开
  1.8 LogOutputList 无锁迭代 —— _active_readers 计数器 + wait_until_no_readers
  1.9 ★ Mermaid: Output Pipeline 序列图 (Lanes: LogTagSet / LogOutputList::Iterator
       / LogFileStreamOutput / LogFileOutput / OS Kernel)
  1.10 ★ 面试 Story Format 答案

§二 ★★★ Beginner Callout 框 (7个)  
  2.1 Virtual dispatch 的设计选择
  2.2 flockfile vs 全局 mutex
  2.3 rename(2) 非原子性
  2.4 _current_size 手动追踪 vs ftell
  2.5 Placement new 静态分配 stdout/stderr
  2.6 Iterator 读-拷贝模式
  2.7 配置字符串贪婪压缩算法

§三 ★★★ 文件轮转深入剖析
  ❓ Logrotate 的 JVM 内部实现：从触发到完成的完整路径
  ❓ 为什么 Semaphore 而不是读写锁
  3.1 轮转触发条件：_file_count > 0 && _rotate_size > 0 && _current_size >= _rotate_size
  3.2 rotate() 内部状态迁移：_stream 从有效 → close → NULL → fopen → 有效
  3.3 increment_file_count() 的环形计数: _current_file = 0..file_count-1
  3.4 initialize() 时处理已有文件：next_file_number() 找到第一个空位或最旧文件
  3.5 FIFO 检测：_is_default_file_count && is_fifo_file → _file_count = 0
  3.6 ftruncate：file_count == 0 时的非轮转行为
  3.7 force_rotate() 的线程安全保障
  3.8 ★ Counterfactual 对比表: rename vs link/unlink vs mmap+msync 三种轮转策略

§四 ★★ LogOutputList 线程安全模型
  ❓ 如何在无全局锁的情况下支持并发读取 + 配置修改
  4.1 _active_readers 原子计数器 — Atomic::add (C++11 atomic)
  4.2 Iterator RAII 模式 — 构造增计数，析构减计数
  4.3 remove_output() 必须 wait_until_no_readers() — busy-loop spin
  4.4 add_output() 插入修正 — _level_start 索引更新 + 链表插入两步
  4.5 update_output_level() — add + wait + remove 的复合操作
  4.6 find() 的线性搜索 — O(输出数), 输出数通常 < 10
  4.7 ★ 与 RCU (Read-Copy-Update) 的比较: 简单化实现 vs Linux 内核 RCU 机制

§五 ★★ 配置字符串生成算法  
  ❓ "all=debug,gc*=trace" 怎么自动生成的
  5.1 Most Common Level (MCL) 计算
  5.2 生成所有 subset + exact/wildcard selection
  5.3 Greedy scoring: 正确匹配 - 错误匹配
  5.4 add_to_config_string() 的动态缓冲扩容 (×2 每遇 -1)
  5.5 describe() 输出格式化
  5.6 ★ 与 jcmd VM.log list 的联动 — outputType 依赖 config_string 完整性

§六 ★★ 选项解析与文件初始化
  ❓ "filecount=5,filesize=20M" 如何转换为内部状态
  6.1 parse_options() 的分号分隔解析 (strchr(strtok-like))  
  6.2 parse_value() 的边界检查 — 防止 SIZE_MAX 溢出
  6.3 Arguments::atojulong 的 size suffix 解析 (K/M/G)
  6.4 initialize() — parse → 已有文件检查 → 归档 → fopen → ftruncate
  6.5 next_file_number() — 找到当前应该使用的文件编号
  6.6 LogFileOutput 构造时的默认值: filecount=5, filesize=20M, rotation_semaphore(1)

§七 ★★ LogOutputList: add/remove/update 完整源码阅读  
  ❓ 输出列表增删改的每个步骤推导
  7.1 set_output_level() 三元分支 (remove/add/update)
  7.2 add_output() — 链表定位 + _level_start 更新 + 链表插入 三步
  7.3 remove_output() — 从 _level_start 移除 + 从链表断开 + wait + delete
  7.4 update_output_level() — add + wait + remove 的复合

§八 ★ GDB 断点验证 — ≥7 断点
  断言 1: logFileStreamOutput.cpp:79 — flockfile 调用验证
  断言 2: logFileStreamOutput.cpp:62 — write_decorations 装饰器宽度
  断言 3: logFileOutput.cpp:284 — rotation_semaphore.wait() 阻塞
  断言 4: logFileOutput.cpp:286 — _current_size 累加验证
  断言 5: logFileOutput.cpp:288 — should_rotate() 条件检查
  断言 6: logFileOutput.cpp:325 — rename(2) 返回值检查
  断言 7: logFileOutput.cpp:360 — _current_size 重置验证
  断言 8: logOutputList.cpp:33 — increase_readers 原子操作
  断言 9: logFileStreamOutput.cpp:45 — placement new 构造 stdout/stderr

§九 ★ Cross-Reference
  ❓ 00-Tag-Level-Selection-Configuration — 本文接收经 TagSet 过滤后的消息
  ❓ 02-Message-Composition-Macros — LogMessageBuffer 构造多行消息后进入本文 write()
  ❓ 01-jvm-startup — LogConfiguration::configure_output() 调用本文的 initialize()
  ❓ libjvm-analysis — 输出系统不涉及外部 .so 依赖
```

---

## §六 Writing Requirements

1. **每个技术断言标注精确 file:line** — 例如 "`_rotation_semaphore.wait()` at logFileOutput.cpp:284" 而非 "在 write 方法中获取信号量"。

2. **源码引用 3-5 行代码片段** — 关键路径（write、rotate、add_output、parse_options）直接粘贴源码，不做翻译描述。

3. **Mermaid 序列图** — Output Pipeline 完整序列图，4 lanes: LogTagSet (判定通过) / LogOutputList::Iterator (遍历节点) / LogFileStreamOutput (flockfile + fflush) / LogFileOutput (Semaphore + rotate)。标注每一步的 file:line。

4. **GDB 会话** — ≥7 个断点，精确到 file:line，每断点有预期变量值和验证目的。断点覆盖: flockfile 调用、装饰器格式化、信号量等待、大小追踪、rotate 触发、rename 返回、重置验证、原子操作、placement new。

5. **7 个 Callout 框** — exact text from §一，每个含 "为什么这样设计" 的解释，不要纯描述。

6. **Counterfactual 对比** — 至少 3 个 counterfactual 含对比分析表（当前设计 vs 替代方案），每组含: 替代方案名称、实现差异、优势、劣势、选择当前方案的理由。

7. **面试故事格式答案** — §一末尾的完整叙事：从 LogOutputList iterator 到文件字节的完整链路，包含所有关键设计决策的原因。

8. **"不要写成 → 应该写成"对照表**（至少 8 行）：

| 不要写成 | 应该写成 |
|---------|---------|
| "LogFileOutput supports file rotation" | "LogFileOutput::write() (logFileOutput.cpp:278-294) calls `should_rotate()` (logFileOutput.hpp:71-73) which checks `_current_size >= _rotate_size`, and if true, invokes `rotate()` which does fclose → archive(rename) → fopen (logFileOutput.cpp:341-362)" |
| "The output list is thread-safe" | "LogOutputList tracks concurrent readers via `_active_readers` (Atomic::add(1), logOutputList.cpp:33), and `remove_output()` busy-spins on `wait_until_no_readers()` (logOutputList.cpp:44-49) before `delete node` — a simple RCU-like pattern" |
| "flockfile protects the write" | "`os::flockfile(_stream)` (logFileStreamOutput.cpp:79) acquires a per-FILE* lock in glibc, allowing concurrent writes to different FILE* objects — stdout and stderr writes never block each other, unlike a global mutex" |
| "The config string is compressed" | "`update_config_string()` (logOutput.cpp:220-340) uses greedy set-cover: finds MCL → 'all=<MCL>' → iteratively picks the selection with max (correct_matches - incorrect_matches) and fewest tags, appending to config string via `add_to_config_string()`" |
| "Options like filecount=5 are parsed" | "`parse_options()` (logFileOutput.cpp:164-220) splits by comma, splits by '=', matches key against `FileCountOptionKey`/`FileSizeOptionKey`, validates via `parse_value()` (logFileOutput.cpp:77-84) returning SIZE_MAX on invalid input" |
| "File rotation uses rename" | "`archive()` (logFileOutput.cpp:314-329) calls `remove(_archive_name)` then `rename(_file_name, _archive_name)` (logFileOutput.cpp:322-325) using `rename(2)` (man 2 rename) — atomic on same filesystem per POSIX, but remove+rename pair is NOT atomic as a group" |
| "LogFileOutput inherits from LogFileStreamOutput" | "The three-tier hierarchy: LogOutput (pure virtual write + config_string) → LogFileStreamOutput (FILE* + flockfile + decorator alignment) → LogFileOutput (Semaphore + _current_size + rotate). `LogFileOutput::write()` calls `LogFileStreamOutput::write()` as the actual I/O, then adds size tracking and rotation logic around it" |
| "Outputs are initialized early" | "StdoutLog/StderrLog use placement new into union-aligned static memory (logFileStreamOutput.cpp:32-43) via `LogFileStreamInitializer` (logFileStreamOutput.cpp:45-51), invoked by static global `log_stream_initializer` (logFileStreamOutput.hpp:39), ensuring initialization before any log call" |
| "Rotation is serialized per file" | "`_rotation_semaphore` is a Semaphore(1) (logFileOutput.cpp:49) — binary semaphore per LogFileOutput instance. `write()` wait() before and signal() after (logFileOutput.cpp:284,291), ensuring only one thread ever executes rotate() for a given file" |

9. **交叉引用** — 至少 3 处标注前/后文档依赖，含具体 file:line 或机制名。

---

## §七 Output Format

- Markdown file, named `01-Output-Pipeline.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/23-logging/docs/`

元信息头：

```
> **阶段**：[23-logging]
> **前置**：[00-Tag-Level-Selection-Configuration]（Tag/Level 过滤判定 → 消息到达本文 entry point）
> **配套**：[02-Message-Composition-Macros]（LogStream/LogMessageBuffer 构造消息内容 → 进入本文 write()）
> **后续依赖本文**：[24-utilities] — 所有 logging 宏的使用者依赖本文的 write() 路径
> **阅读收益**：追踪一条日志消息从 LogOutputList::iterator() 到磁盘文件字节的完整 I/O 路径——理解 LogOutput 虚函数三层分派（基类→FileStream→FileOutput）、flockfile 的 per-FILE 并发设计、文件轮转的 Semaphore 保护 + rename(2) 原子性边界、LogOutputList 的无锁读-拷贝迭代模式、配置字符串贪婪压缩算法、placement new 解决循环依赖的 static 初始化技巧
```

- 目标行数: ≥350 行文档

---

## §八 Prohibited（≥8）

- ❌ 不要只说 "LogOutput is the base class" — 必须展示纯虚函数表（`write()=0` × 2 at logOutput.hpp:100-101 + `name()=0` at logOutput.hpp:98）和所有子类的 override 实现
- ❌ 不要忽略 write() 的两个重载版本的区别 — 必须解释 `write(decorations, msg)` 单行版 vs `write(msg_iterator)` 多行版在 flockfile/fflush 上的差异
- ❌ 不要只说 "rotation happens when file size exceeds limit" — 必须展示 `should_rotate()` (logFileOutput.hpp:71-73) 的三个条件 + `_current_size += written` 的准确性 + 触发后 rotate() 的完整状态迁移
- ❌ 不要忽略 `_rotation_semaphore` 的作用细节 — 必须解释它保护的是 "write+maybe_rotate" 整个操作，而不仅仅是 rotate 本身
- ❌ 不要忽略 rename(2) 的非原子性 — 必须分析 remove+rename 两步合成的 gap 和 POSIX rename 在同一文件系统内的原子保证
- ❌ 不要忽略 `_stream == NULL` 检查 (logFileOutput.cpp:279-281) — 必须解释这是静默丢弃日志的哨兵值及其不通知用户的问题
- ❌ 不要跳过 LogOutputList::Iterator 的 `_active_readers` 机制 — 必须解释 RAII 模式（构造增、析构减）和 `wait_until_no_readers()` 的 busy-spin 语义
- ❌ 不要忽略 `update_config_string()` 的算法细节 — 必须解释 MCL 计算 → subset 生成 → greedy scoring → 循环减少的策略
- ❌ 不要遗漏 placement new 的初始化问题 — 必须解释为什么 stdout/stderr 不能用 `new LogStdoutOutput()`（循环依赖：内存分配器可能依赖 logging）
- ❌ 不要不展示 `make_file_name()` 的 %p/%t 替换 — 必须展示完整的字符串组装逻辑和 static 成员设计

---

## §九 Required（≥8）

- ✅ **★ Mermaid 序列图** — 4 lanes: LogTagSet → LogOutputList::Iterator → LogFileStreamOutput → LogFileOutput (+ OS Kernel)。标注每一步的 file:line。完整流程：message arrives → iterator → virtual write dispatch → flockfile → jio_fprintf + fflush → funlockfile → (_current_size += written) → (if should_rotate: Semaphore → fclose → archive(rename) → fopen → reset → signal)
- ✅ **★ rotate() 源码完整展示** — logFileOutput.cpp:341-362 全文粘贴，并逐行注释 fclose/archive/fopen/reset/increment 五步状态迁移
- ✅ **★ write() 两个重载完整对比** — 单行版 (logFileStreamOutput.cpp:75-89) + 多行版 (logFileStreamOutput.cpp:91-107) 并排展示，标注循环中 fflush 位置的差异
- ✅ **★ archive() → rename(2) 原子性分析** — 包含 remove+rename gap 分析 + POSIX rename 原子性保证 + tail -f 观察者可见性分析
- ✅ **★ 7 个 Beginner Callout 框** — exact text from §一，不重复不遗漏，每个含设计 rationale
- ✅ **★ Interview Story Format 答案** — §一末尾叙事：从 iterator 到文件字节的完整链，含所有设计决策原因
- ✅ **★ GDB 断点 ≥7 条** — 精确到 file:line，每断点有预期变量值，覆盖：flockfile、装饰器、信号量、大小追踪、rotate 触发、rename 返回值、重置验证、原子操作、placement new
- ✅ **★ 文件轮转 Counterfactual 对比表** — rename vs link/unlink vs mmap+msync 三种策略的性能/一致性/复杂度对比
- ✅ **★ "不要写成→应该写成"对照表** — 至少 8 行，每行左列是浅层描述，右列是含 file:line + 机制解释的深层分析
- ✅ **★ parse_options() 完整解析流程** — 逗号分割 + 等号分割 + parse_value() 校验 + Arguments::atojulong 后缀解析

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: LogFileStreamOutput::write 中 flockfile 调用 (logFileStreamOutput.cpp:79)
  (gdb) break logFileStreamOutput.cpp:79
  (gdb) run
  (gdb) print _stream → 期望: 非 NULL 的 FILE* (stdout/文件流)
  (gdb) print _decorators.is_empty() → 期望: 根据配置返回 true/false
  (gdb) continue
  (gdb) print written → 期望: >0 (实际写入字节数)

断言 2: write_decorations 装饰器对齐 (logFileStreamOutput.cpp:62)
  (gdb) break logFileStreamOutput.cpp:62
  (gdb) run (重复触发多次)
  (gdb) print _decorator_padding[decorator] → 期望: 随调用增长(跟踪最大宽度)
  (gdb) print decorations.decoration(decorator) → 期望: 非空 C 字符串
  (gdb) print written → 期望: >= -1 (成功 >0, 失败 -1)

断言 3: LogFileOutput::write 信号量等待 (logFileOutput.cpp:284)
  (gdb) break logFileOutput.cpp:284
  (gdb) run
  (gdb) print _rotation_semaphore → 期望: Semaphore 对象，计数状态可见
  (gdb) print _stream → 期望: 非 NULL (有效文件流)
  (gdb) continue 经过 LogFileStreamOutput::write
  (gdb) print written → 期望: >0 (实际写入字节数)

断言 4: _current_size 累加验证 (logFileOutput.cpp:286)
  (gdb) break logFileOutput.cpp:286
  (gdb) print _current_size → 期望: 上一次调用后的值
  (gdb) print written → 期望: >0
  (gdb) continue
  (gdb) print _current_size → 期望: 等于上次 _current_size + written
  (gdb) print _rotate_size → 期望: 默认 20M 或用户配置值 (单位字节)

断言 5: should_rotate 条件检查 (logFileOutput.cpp:288)
  (gdb) break logFileOutput.cpp:288
  (gdb) print _file_count → 期望: 0..1000
  (gdb) print _rotate_size → 期望: >0 (if rotation enabled)
  (gdb) print _current_size → 期望: >= _rotate_size (if should rotate)
  (gdb) print _current_size >= _rotate_size → 期望: true (触发 rotate 条件)
  强制触发: (gdb) set var _current_size = _rotate_size 然后 continue

断言 6: archive() 中 rename(2) 调用 (logFileOutput.cpp:325)
  (gdb) break logFileOutput.cpp:325
  (gdb) run (需要先满足 rotate 条件)
  (gdb) print _file_name → 期望: 当前活跃日志文件名 (如 "gc.log")
  (gdb) print _archive_name → 期望: 归档文件名 (如 "gc.log.3")
  (gdb) continue
  (gdb) print rename 返回值 → 期望: 0 (成功) 或 -1 (失败, 检查 errno)
  (gdb) shell ls -la $_file_name $_archive_name → 期望: gc.log 消失, gc.log.3 存在

断言 7: rotate() 后 _current_size 重置 (logFileOutput.cpp:360)
  (gdb) break logFileOutput.cpp:360
  (gdb) run (触发 rotate 后)
  (gdb) print _current_size → 期望: 0 (刚重置)
  (gdb) print _current_file → 期望: 0..file_count-1 (环形递增)
  (gdb) print _stream → 期望: 非 NULL (fopen 成功重新打开)

断言 8: LogOutputList::increase_readers 原子操作 (logOutputList.cpp:33)
  (gdb) break logOutputList.cpp:33
  (gdb) run
  (gdb) print _active_readers → 期望: 调用前的值
  (gdb) continue
  (gdb) print _active_readers → 期望: 调用前值 + 1

断言 9: LogFileStreamInitializer placement new (logFileStreamOutput.cpp:47)
  (gdb) break logFileStreamOutput.cpp:47
  (gdb) run (启动 JVM 立即触发)
  (gdb) print &StdoutLog → 期望: 非 NULL 地址 (static 内存)
  (gdb) print initialized → 期望: false (初始)
  (gdb) continue 经过 ::new (&StdoutLog) LogStdoutOutput()
  (gdb) print StdoutLog.name() → 期望: "stdout"
  (gdb) print initialized → 期望: true
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二 承接**：本文展开 README §二 架构概览中的 "输出层（where）— LogOutput 子类写出消息" 环节。消息经 Tag/Level/Selection 判定（00 文档覆盖）后，进入本文的 Output Pipeline。

2. **同组边界**：
   - **00-Tag-Level-Selection-Configuration** — 覆盖 "什么消息应该输出"（过滤层）。本文起点恰在消息通过所有过滤器之后（LogOutputList::iterator() 返回输出列表）。两个文档在 `LogOutputList::set_output_level()` 处汇合：00 文档通过 `LogConfiguration::configure_output()` 调用本文的 `LogOutput::initialize()` 和 `LogOutputList::set_output_level()`。
   - **02-Message-Composition-Macros** — 覆盖 "消息如何构造"（LogStream/LogMessageBuffer）。本文的 `LogFileStreamOutput::write(LogMessageBuffer::Iterator)` 直接消费 02 的 `LogMessageBuffer`。需说明 Iterator 的 `is_at_end()`/`message()`/`decorations()` 接口如何从 02 传入本文。

3. **共享数据结构**：
   - `LogDecorations` (01 ↔ 00 ↔ 02) — 装饰数据在 00 被赋值，02 被携带，01 被 `write_decorations()` 消费
   - `LogOutputList` (01 ↔ 00) — 列表结构在 01 被定义，00 的 `LogConfiguration` 调用 `set_output_level()` 修改它

4. **全部文档共享开头语**：Reader completed 00-Tag-Level-Selection-Configuration (filtering). This doc: how filtered messages actually reach disk/console — from the output list iterator to file bytes.
