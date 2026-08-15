# 02. Timer + Monitoring Services — 高精度计时 + JMX 统计

> 🟡 Working | elapsedTimer + ClassLoadingService/RuntimeService/ThreadService
> 读者处境: GC 日志 `[123.4ms]` — 用 `TraceTime` RAII 自动计 GC phase 时间。JConsole 显示 "Loaded 5432 classes" — `ClassLoadingService` 在 safepoint 更新 counter。两者组合 → 运维可见性。

> ⚠️ 写作期修正(2026-08-15, vol-02/39-runtime-monitoring/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"timer.hpp/cpp 在 utilities/" 目录错**: 真实 **share/runtime/timer.hpp**(99 行)+timer.cpp(176 行)
> - **"TraceTime 在 timer.cpp" 错(重要)**: TraceTime 在**独立文件 share/runtime/timerTrace.hpp**(80 行);**输出走统一日志框架**(TraceTimerLogPrintFunc 函数指针+TRACETIME_LOG 宏,log_is_enabled 检查,timerTrace.hpp:57-59),**不是"析构 tty->print('%s took %.3f ms')"**;三构造(title,doit)/(title,accumulator,doit,verbose)/(title,ttlpf);elapsedTimer 成员 _t+_accum 累计器+suspend/resume
> - **"os::elapsed_counter 在 timer.cpp" 错**: 在 **os_linux.cpp:1435-1437**(=javaTimeNanos()-initial_time_count,initial 设于 :5565);javaTimeNanos **:1555-1569**=CLOCK_MONOTONIC 的 clock_gettime(:1558,clock_gettime 经 **dlsym 加载** :1489-1491 规避旧 glibc),fallback gettimeofday;elapsed_frequency=NANOSECS_PER_SEC(:1439-1441)
> - **"GC phases 用 TraceTime" 错(重要)**: GC 用 **GCTraceTimeImpl**(gcTraceTime.hpp:46-65,基于 Ticks/utilities/ticks.hpp,日志框架)+GCTraceCPUTime/GCTraceConcTimeImpl;实证 -Xlog:gc+phases "GC(0) Phase 1: Mark live objects 3.412ms"
> - **"三个 service thin wrappers,数据来自 ClassLoaderDataGraph/Safepoint/Thread-SMR" 半对(重要)**: 数据=**PerfData 计数器**(38 域): ClassLoadingService=PerfCounter 对,loaded_class_count=_classes_loaded_count+_shared_classes_loaded_count(hpp:62-65);**更新点=类加载/卸载事件钩子**(notify_class_loaded classLoadingService.cpp:148-166,被 classFileParser.cpp:5772 普通类/systemDictionary.cpp:1370 共享类调;unloaded 在 instanceKlass.cpp:2428)——非"safepoint 里数一遍";RuntimeService=PerfCounter(_total_safepoints/_safepoint_time_ticks/_application_time_ticks)+**TimeStamp**(_safepoint_timer/_app_timer),record_safepoint_begin/end(runtimeService.cpp:87+),JMX 读口 management.cpp:916/919/925;ThreadService=PerfCounter/PerfVariable+**原子计数**(_atomic_threads_count/_atomic_daemon_threads_count,get_live/daemon 读原子,hpp:98-101)
# - **行号漂移**: timer.hpp 99 行(大纲 40-150);timer.cpp 176 行;service hpp 各 ~100 行(大纲 30-60)
# - **悬念指向错**: "→ 域40 Launcher" 过期(40 是第 7 批);按 writing-order 39→**46-sa-postmortem**(第 5 批收官域,01-sa-postmortem.md)
# - **实证**: 39-runtime-monitoring-timer-demo.txt(jstat -class Loaded 1841/Bytes 3798.0 直接读 PerfCounter 无需 attach;gc+phases 四阶段毫秒;计时器家族定位;**环境修正: jcmd attach 在容器可用**——listener 已由之前实验触发,socket 文件存在,jcmd GC.run 成功)
# - **缺机制(重要)**: ①elapsedTimer 内部 _counter/_start_counter/_active,start/stop 累加(:32-50);②TimeStamp 事件时刻(:53-73);③TraceCPUTime user/sys/real(:75-90);④os::elapsedTime 秒(:1430-1433);⑤JFR 消费 loaded_class_count(jfrPeriodic.cpp:459)

### 1. "elapsedTimer + TraceTime — RAII 计时"

场景: `TraceTime t("Phase1", timer)` — 构造时 `os::elapsed_counter()`→析构时 print "Phase1 took 123ms"。GC phases 用 TraceTime **自动计时**——不需要手动 start/stop。

**elapsedTimer + TraceTime** (`timer.hpp:40-150 + timer.cpp:40-100`):
```
elapsedTimer:
  start(): _start = os::elapsed_counter()  // monotonic clock, 不受 NTP/wall clock 影响
  stop():  _stop = os::elapsed_counter()
  seconds() / milliseconds() / nanoseconds()

TraceTime (RAII):
  TraceTime(const char* title, elapsedTimer* t):
    构造函数: t->start()
    析构函数: t->stop(); tty->print("%s took %.3f ms", title, t->milliseconds())
[C++: timer.cpp——elapsed_counter() 用 clock_gettime(CLOCK_MONOTONIC) on Linux——不受 wall clock 调整影响]
```
- 源码: `timer.hpp:40-100` (elapsedTimer 接口) + `timer.cpp:40-80` (os::elapsed_counter 实现) + `timer.cpp:80-150` (TraceTime RAII)

- 关键设计: **monotonic clock** — 不受 NTP 同步/wall clock 回拨的影响——即使管理员调整系统时间→GC 日志中的时间仍然线性增加。**RAII** — GC phase 函数返回时 TraceTime 自动析构 print——即使中途抛 C++ 异常→析构仍然执行。

### 2. "Monitoring Services — per-JMX-MBean wrappers"

场景: JConsole HTTP endpoint→`ManagementFactory.getClassLoadingMXBean().getLoadedClassCount()`→`ClassLoadingService::loaded_class_count()`。

**三个 Monitoring Service** (`services/`):
```
ClassLoadingService (classLoadingService.hpp:30-80):
  → loaded_class_count() / unloaded_class_count()
  → 数据来源: ClassLoaderDataGraph 在 safepoint 更新 counter

RuntimeService (runtimeService.hpp:30-80):
  → safepoint_count() / safepoint_sync_time() / application_time()
  → 数据来源: SafepointSynchronize (域18) 统计

ThreadService (threadService.hpp:30-80):
  → thread_count() / peak_thread_count() / daemon_thread_count()
  → 数据来源: Thread-SMR (域17) — Threads::number_of_threads()
[C++: 三个 service 都是 thin wrappers——数据来自域17-18-33——service 只是 aggregator]
```
- 源码: `classLoadingService.hpp:30-60` (接口) + `runtimeService.hpp:30-60` (接口) + `threadService.hpp:30-60` (接口)

- 关键设计: **Thin wrappers** — 这些 Service 不含任何数据——只是 aggregator 接口。数据源分散在 JVM 各处(ClassLoaderDataGraph/SafepointSynchronize/Thread-SMR)——Service 收集并格式化为 JMX 可用格式。**更新时机**——class count 在 GC/safepoint 中更新(因为在 STW 外 ClassLoaderDataGraph 在并发变化中)→JConsole query 时返回最后已知值。

---

### 核心悬念

**"elapsedTimer(monotonic clock, 不受 NTP 影响)+TraceTime(RAII auto-print GC phase time)。ClassLoadingService/RuntimeService/ThreadService - thin JMX wrappers, 数据来自 ClassLoaderDataGraph/Safepoint/Thread-SMR。"** — 下一篇: 域40 Launcher (Group 10)。

> → 域40 Launcher
