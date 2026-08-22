# 11 · 性能、可观测性与生产故障：深度题目

## 1. 面对一个“内存 RSS 一路上涨但 GC 日志显示堆稳定”的生产问题，你的排查第一反应应该是什么？

这不是一个“查什么命令”的问题，而是一个“哪一层观测能回答哪一层问题”的判断题。

回答必须覆盖：

- 堆内 vs 堆外（native）内存各自由谁分配、谁回收；
- 为什么 GC 日志只回答堆内问题，堆外需要 NMT；
- `jcmd VM.native_memory summary` 为什么必须在**启动时**就开启，运行期无法补；
- MallocHeader 如何把每次 `os::malloc`/`free` 透明地记账；
- summary/detail 级别的成本差异，以及为什么 tracking level 只能降不能升。

追问：如果 NMT 没开，还有什么手段定位堆外增长？（如 `/proc/<pid>/smaps`、堆栈抓取、perf。）`smaps` 和 NMT 各自能回答哪一层？

源码入口：`share/services/memTracker.cpp:58`、`share/runtime/os.cpp:723`、`share/services/mallocTracker.hpp:246`、`src/java.base/share/native/libjli/java.c:858`。

## 2. JFR 为什么能做到“每线程写入几乎无锁”，而不是一块全局缓冲加锁？

方法采样、GC 事件、锁竞争事件都由业务线程产生。为什么 JFR 用 per-thread buffer，而不是全局缓冲 + 锁，或者按事件类型分 buffer？

回答必须覆盖：

- 全局缓冲 + 锁在高并发下的串行化问题；
- 按事件类型分 buffer 的冷热不均问题；
- per-thread buffer 如何让写入频率自然匹配线程繁忙程度；
- Java 事件与 native 事件为什么要分开两个 buffer；
- `_pos`/`_top` 双指针如何让写入线程无锁推进、后台线程安全刷写。

追问：如果写线程更新 `_pos` 是普通 store，刷写线程读到的 `_pos` 偏旧会怎样？为什么“少读（保守）比多读（越过写入点）安全”？

源码入口：`share/jfr/support/jfrThreadLocal.hpp:39`、`share/jfr/recorder/storage/jfrBuffer.hpp:33`、`share/jfr/recorder/storage/jfrStorage.cpp:489`。

## 3. GC 日志能告诉你“发生了什么”，但什么情况下你会怀疑 GC 日志本身遮蔽了真相？

GC 日志记录 pause、分配、晋升等阶段。它为什么不能回答“CPU 到底花在哪了”或“到底是不是 GC 引起的卡顿”？

回答必须覆盖：

- GC 日志只覆盖 GC 阶段树，不覆盖 mutator 全貌；
- safepoint 时间 vs GC 时间：`-XX:+PrintSafepointStatistics` 或 JFR 如何呈现 VM operation 开销；
- JIT 编译、JFR 自身、统计线程可能成为新的 CPU/内存开销源；
- 观测台本身的开销：为什么开启大量 GC log/PrintGCCause 会影响测量；
- 如何用 JFR、`jcmd Thread.print`、perf 交叉验证“卡顿真的来自 GC”。

追问：如果一个应用每 2 秒卡一下，但 GC 日志显示安排 GC 只有 30ms，你会怀疑哪些非 GC 的 stop-the-world 来源？`PrintSafepointStatistics` 为什么能在这里派上用场？

源码入口：`share/runtime/safepoint.cpp:830`、`share/gc/shared/gc_globals.hpp:158`、`share/runtime/thread.cpp:4002`。

## 4. hs_err 里“Current thread / Stack / Registers”这些片段，为什么不能只看字面，而要理解它是“崩溃现场保全”？

hs_err_pid.log 是崩溃后唯一的诊断来源。它为什么不是普通日志，而是一个“尽力保全 + 自身防御”的产物？

回答必须覆盖：

- first-error CAS 保证只有一个线程写报告，其他线程 `infinite_sleep`；
- STEP 流水线如何用 `__LINE__` 标记当前失败点；
- 错误线程为什么绕过共享 decoder 锁用专用实例；
- 崩溃线程可能持有任意锁，为何错误路径不能依赖普通锁；
- `-XX:ErrorLogTimeout` 与 step 超时如何避免报告自身无限挂起。

追问：如果报告写到一半再次 SIGSEGV（re-entrant），hs_err 会怎样标记？为什么报告线程不能继续跑业务而是无限睡眠？

源码入口：`share/utilities/vmError.cpp:1272`、`share/utilities/vmError.cpp:422`、`share/utilities/vmError.cpp:1351`、`share/utilities/decoder.cpp:99`。

## 5. jstat 为什么能跨进程读 JVM 计数，而不打扰目标进程？

`jstat -gc <pid> 1s` 每秒读到一堆数字，为什么它可以像一个“内存读”而不是 RPC/attach 请求？

回答必须覆盖：

- PerfData 内部对象层与对外 `PerfMemory` 共享布局层的边界；
- `PerfDataPrologue` + `PerfDataEntry` 为什么是公共二进制契约；
- `jstat` 读方如何 mmap 共享区，而不是通过 socket/attach；
- `StatSampler` 与共享布局的关系为什么是“写方刷新”，不是“读方 RPC”；
- 这种设计适合哪类观测（高频、低语义），不适合哪类（复杂管理、需要协调）。

追问：如果多个进程同时读同一个 JVM 的 PerfData 共享区，为什么不会互相干扰？为什么 PerfData 不适合承载安全敏感的观测？

源码入口：`share/runtime/perfData.hpp:97`、`share/runtime/perfMemory.hpp:62`、`share/runtime/perfMemory.hpp:74`。

## 6. JDK 的“性能问题”可以从哪些结构性信号直接读出来，而不是靠猜？

一个 CPU 高的 Java 服务，如果只给你 `jstack`、JFR、GC 日志、NMT 四样东西，你按什么顺序看、每样回答什么问题？

回答必须覆盖：

- `jstack`/JFR 采样回答“线程在哪”——锁等待、循环、IO；
- GC 日志回答“分配/晋升/回收压力”；
- NMT 回答“堆外分配”；
- JFR 的锁/分配/编译事件回答“为什么卡”；
- 如何用“现象 → 结构 → 日志/采样 → 源码入口”的链路定界，而不是先猜参数。

追问：同样的堆大小，为什么一个机器的 GC 频率高一个低？你会检查 `-Xms`/`-Xmx`、初始堆、Region/代数比例，还是先看分配速率？

源码入口：`share/services/diagnosticCommand.cpp:602`、`share/runtime/safepoint.cpp:830`、`share/gc/shared/collectorPolicy.cpp:3`。

## 7. 这些观测手段合起来，如何支撑“从现象反推源码机制”的能力？

JFR、JMX、GC 日志、PerfData、NMT、hs_err、SA 看似是七种工具。它们如何共享同一条“从观测回到 HotSpot 内部结构”的主线？

回答必须覆盖：

- 每种手段各自发布哪类内部状态、以哪种协议暴露；
- 为什么理解源码内部结构（Counter、Event、memTracker、vmError）才能正确解释观测值；
- 为什么“观测台本身也可能是 true source of problem”（如 PrintGCDetails 改变时序）；
- 从“看到数字”到“定位 line of code”所需的链路；
- 为什么专家级排查是“选择正确观测 + 反推机制”，而不是“背参数大全”。

追问：如果一个数字（如 MetaSpace 用量）异常，你会直接改参数，还是先找它由哪个 VM 结构驱动？为什么后者更可靠？

源码入口：`share/runtime/perfData.cpp:40`、`share/services/memTracker.cpp:164`、`share/utilities/vmError.cpp:1272`、`share/runtime/safepoint.cpp:830`。