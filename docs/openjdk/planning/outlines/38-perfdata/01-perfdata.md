# 01. jstat -gc 的数据怎么实时读取？ — PerfData 架构

> 🔴 Deep | mmap 共享内存计数器
> 读者处境: `jstat -gc <pid> 1000ms` — 每 1s 输出 GC 计数/Eden 使用/Full GC 时间。这些数据不是 JMX 接口——是 PerfData 通过 mmap 共享内存暴露——**无 IPC 开销 (1 cycle read)**。

### 1. "PerfData — ~200 计数器系统"

场景: JVM 启动→PerfDataManager 创建 ~200 counters→每个有 name+type+value→结构体数组存储在 mmap 文件中→jstat open/read 直接访问内存。

**PerfData 计数器** (`perfData.hpp:40-200 + perfData.cpp:50-250`):
```
PerfLong           sun.gc.collector.0.time          → GC 累计时间(ms)
PerfCounter        sun.gc.collector.0.invocations    → GC 次数
PerfString         sun.rt.javaCommand                → JVM command line
PerfByteArray      sun.rt.createVmBeginTime          → VM 启动时间戳
PerfLongVariable   sun.os.hrt.ticks                  → 高精度计时器 ticks
PerfLongCounter    sun.gc.policy.collectors          → GC 回收器数量
[C++: perfData.hpp——PerfLong/PerfCounter/PerfString 只是 C++ 模板别名——实际存储为 char[] buffer]
```
- 源码: `perfData.hpp:40-200` (counter 类型定义) + `perfData.cpp:50-250` (PerfDataManager::create_long_counter 等)

- 关键设计: **Producer(JVM) 直接写 64-bit 值(普通内存写, ~1 cycle)** — Consumer(jstat) 通过 mmap 映射同一物理页→直接读内存(普通内存读, ~1 cycle)——**无 IPC/无 socket/无 JMX 序列化**。jstat 连接→open `/tmp/hsperfdata_<user>/<pid>`→读 header→找到 counter offset→value。

### 2. "PerfMemory — mmap 共享内存文件"

场景: JVM 在 `/tmp/hsperfdata_<user>/` 创建 `pid` 命名的文件→mmap→写入 perfdata header+counters→jstat 在另一个进程 mmap 同一文件。

**PerfMemory** (`perfMemory.hpp:40-100 + os/linux/perfMemory_linux.cpp:40-150`):
```
JVM: open("/tmp/hsperfdata_<user>/<pid>", O_CREAT|O_RDWR)
     → ftruncate(size) → mmap(MAP_SHARED, PROT_READ|PROT_WRITE)
     → 写入 PerfData header(count + entry offsets) + counter values

jstat: open(same file, O_RDONLY)
     → mmap(MAP_SHARED, PROT_READ) → 读 header → 根据 entry offset 读 counter value
[C++: perfMemory_linux.cpp——文件在 JVM exit 时 unlink——不存在残留 hsperfdata 文件]
[内核: mmap(MAP_SHARED) 映射同一文件→两个进程共享同一物理页→cache coherency 由 CPU cache coherence (MESI) 保证]
```
- 源码: `perfMemory.hpp:40-100` (共享内存接口) + `os/linux/perfMemory_linux.cpp:40-150` (Linux 实现)

- 关键设计: **目录权限隔离**——`/tmp/hsperfdata_<user>/` 目录 mode 为 0700——只有同一用户能读取 JVM performance counters。不同用户的 JVM 互不可见。**64-bit 原子写天然无锁**——x86 保证 64-bit aligned stores 对其他核心原子可见——不需要 volatile/java lock——只需要 C++ int64_t store→consumer 看到完整值。

---

### 核心悬念

**"PerfData ~200 counters 通过 mmap 共享内存暴露→jstat 直接读内存(无 IPC, 1 cycle)。PerfMemory 是 hsperfdata_<user>/<pid> 文件的 mmap wrapper——Producer atomic write → Consumer atomic read——64-bit 天然无锁。"** — 下一篇: StatSampler(周期性刷新 + 同步协议)。

> → [02-stat-sampler.md](02-stat-sampler.md)
