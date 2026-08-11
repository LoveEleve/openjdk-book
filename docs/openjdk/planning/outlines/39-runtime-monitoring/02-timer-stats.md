# 02. Timer + Monitoring Services — 高精度计时 + JMX 统计

> 🟡 Working | elapsedTimer + ClassLoadingService/RuntimeService/ThreadService
> 读者处境: GC 日志 `[123.4ms]` — 用 `TraceTime` RAII 自动计 GC phase 时间。JConsole 显示 "Loaded 5432 classes" — `ClassLoadingService` 在 safepoint 更新 counter。两者组合 → 运维可见性。

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
