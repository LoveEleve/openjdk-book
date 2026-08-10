# 01. jstat -gc 的数据怎么实时读取？— PerfData 架构

> 🔴 Deep | 1 KP 中的性能计数
> 读者处境: `jstat -gc <pid> 1000ms` — 每 1s 输出 GC计数/Eden使用/Full GC时间。这些数据不是 JMX 接口——是 PerfData 通过共享内存暴露。

### 1. "PerfData — 计数器系统"

场景: JVM 启动→PerfDataManager 创建 ~200 counters→每个有 name+type+value→通过 mmap 共享内存暴露。

**PerfData** (`runtime/perfData.hpp:40-200 + perfData.cpp:50-250`):
```
PerfLong/sun.gc.collector.0.time → GC time
PerfCounter/sun.gc.collector.0.invocations → GC count
PerfString/sun.rt.javaCommand → JVM command line
```
- 源码: `runtime/perfData.hpp:40-200` + `perfData.cpp:50-250`
- 关键设计: Producer(JVM)直接写计数器值(普通内存写, ~1 cycle)——Consumer(jstat)通过 mmap 读共享内存(普通内存读, ~1 cycle)——无IPC。jstat 连接→open `/tmp/hsperfdata_<user>/<pid>`→读 header→找到 counter offset→读值

### 2. "共享内存 — PerfMemory"

场景: JVM 在 /tmp 创建 `hsperfdata_<user>/<pid>` 文件→mmap→写入 perfdata→jstat mmap 读取。

**PerfMemory** (`runtime/perfMemory.hpp:40-100 + perfMemory.cpp:50-200`):
```
JVM: create file → mmap(MAP_SHARED, PROT_READ|PROT_WRITE) → write header+data
jstat: open same file → mmap(MAP_SHARED, PROT_READ) → read counters
```
- 源码: `runtime/perfMemory.hpp:40-100` + `os/linux/perfMemory_linux.cpp:40-150`

---

### 核心悬念

**"PerfData 用 mmap 共享内存暴露 ~200 计数器→jstat 直接读内存(无 IPC)。"** — 下一篇: StatSampler。

> → [02-stat-sampler.md](02-stat-sampler.md)
