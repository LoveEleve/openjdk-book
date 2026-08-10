# 02. 怎么计时 JVM 内部操作？— Timer + Monitoring Services

> 🟡 Working | 1 KP 中的计时+统计
> 读者处境: GC 日志 "[123.4ms]" — 用 elapsedTimer 计时。JConsole 显示 "Loaded 5432 classes" — ClassLoadingService 统计。

### 1. "Timer — 高精度计时"

场景: `elapsedTimer.start()`→跑代码→`elapsedTimer.stop()`→`elapsedTimer.milliseconds()`。

**Timer** (`runtime/timer.hpp:40-150 + timer.cpp:40-100`):
```
elapsedTimer: os::elapsed_counter() (monotonic timer)
TraceTime:    RAII auto-print on destructor — "phase took 123ms"
```
- 源码: `runtime/timer.hpp:40-150` + `timer.cpp:40-100`
- 关键设计: elapsedTimer 用 monotonic clock(不受 wall clock 调整影响)。TraceTime RAII——构造记录开始时间→析构 print duration。GC phases 用 TraceTime 自动记时——不需要显式 start/stop

### 2. "Monitoring Services"

场景: `ManagementFactory.getClassLoadingMXBean()` → ClassLoadingService→返回 loadedClassCount。

**ClassLoadingService + RuntimeService + ThreadService** (`services/`):
```
ClassLoadingService: loaded/unloaded class count (per class loader)
RuntimeService:      safepoint count, application time
ThreadService:       total/peak/daemon thread counts
```
- 源码: `services/classLoadingService.hpp:30-80` + `services/runtimeService.hpp:30-80` + `services/threadService.hpp:30-80`
- 关键设计: 这些 services 是 per-JMX-MBean 的 thin wrappers——数据来自 MemoryService(域33)和 Thread-SMR(域17)。更新在 safepoint/GC 中——service 只是 query 接口

---

### 核心悬念

**"elapsedTimer+TraceTime RAII high-precision timing。MonitoringServices 统计 class/thread/runtime 供 JConsole。"** — 下一篇: 域40 Launcher (Group 10)。

> → 域40 Launcher
