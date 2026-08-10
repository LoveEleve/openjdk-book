# 02. 共享内存怎么同步？— StatSampler + 多 Consumer

> 🟡 Working | 1 KP 中的采样+同步
> 读者处境: JVM 更新 PerfData counters、jstat 同时读——无锁！Producer 原子写、Consumer 可能读到"partially updated" value。

### 1. "StatSampler — 周期性更新"

场景: WatcherThread 每 50ms 采样→更新 perf counters(cpu load/compile count)。

**StatSampler** (`runtime/statSampler.hpp:30-60 + statSampler.cpp:40-150`):
```
StatSampler::run():
  → sample perf data per 50ms
  → update PerfCounter "sun.os.hrt.ticks"
```
- 源码: `runtime/statSampler.hpp:30-60` + `statSampler.cpp:40-150`

### 2. "同步 — 无锁"

场景: Producer写→无锁→Consumer 读可能 inconsistent——但每个 counter 是 64-bit→不会 tear。

**同步协议** (`os/linux/perfMemory_linux.cpp:40-150`):
```
Producer: write header.size=0, write data, write header.size=actual
Consumer: read header.size→if zero→retry→else read data
```
- 源码: `os/linux/perfMemory_linux.cpp:40-150`
- 关键设计: header.size=0 is "data invalid" flag —— Producer 在写入前 clear size→Consumer 看到 zero→know data not ready→轻量同步避免 lock

---

### 核心悬念

**"StatSampler 每 50ms 更新 counters。Producer-Consumer 通过 header_size=0 做 light 同步。"** — 下一篇: 域39 Runtime Monitoring。

> → 域39 Runtime Monitoring
