# 02. StatSampler — 周期性刷新 + 无锁同步

> 🟡 Working | 采样线程 + header 标记同步
> 读者处境: JVM 写 PerfData counters、jstat 同时读——**无锁**！Producer 原子写 64-bit→不会 "tear"。header.size=0 标记 "data invalid"——Consumer 轮询直到非零。

### 1. "StatSampler — WatcherThread 50ms 采样"

场景: `sun.os.hrt.ticks` counter 每 50ms 更新——这是 WatcherThread 的 `StatSampler::task()` 周期性采集。

**StatSampler** (`statSampler.hpp:30-60 + statSampler.cpp:40-150`):
```
StatSampler::task(): // 在 WatcherThread 中周期性执行
  → sample_thread_cpu_time() → sun.rt.safepointTime/sun.rt.applicationTime
  → sample_java_system_properties() → sun.os.hrt.ticks
  → sample_loaded_classes() → sun.cls.loadedClasses
  → 更新 PerfData counters(直接写 mmap 内存)
[C++: statSampler.cpp:40-100——sampling 频率 = PerfDataSamplingInterval(默认 50ms)]
```
- 源码: `statSampler.cpp:40-100` (task 主循环) + `statSampler.cpp:100-200` (各 sample 函数实现)

- 关键设计: **采样在 WatcherThread 中执行**——不是独立线程——safepoint 检查在采样之间。**50ms 间隔**——~20 次/秒——对应用程序扰动 <0.01% CPU。**PerfDataManager 的 create_entry 在 JVM 启动时一次性创建全部 entries——采样时只更新 value 不分配内存**——保证无 GC。

### 2. "无锁同步 — header.size=0 flag"

场景: JVM 正在更新 counters 时 jstat 同时读——无 lock/无 CAS——64-bit stores 是原子的→不会看到半个值。header.size=0 是 "data ready" flag——避免 jstat 读到的 counter offsets 未初始化。

**同步协议** (`os/linux/perfMemory_linux.cpp:40-150`):
```
Producer(JVM):
  → write header.size = 0        // 标记 "updating"
  → 写入全部 counter values
  → write header.size = actual   // 标记 "ready"

Consumer(jstat):
  → 循环: read header.size → if == 0 → usleep(100) → retry
  → header.size > 0 → read counter per offset → done
[C++: perfMemory_linux.cpp——size=0 是轻量 barrier——无 lock/无 CAS——仅一个普通的 32-bit store]
```
- 源码: `os/linux/perfMemory_linux.cpp:40-100` (create_shared_memory → mmap + header init)

- 关键设计: **为什么不用 lock？** PerfData 的要求——consumer 数量未知(jstat + VisualVM + JConsole + custom tool)——加锁需要共享 mutex(POSIX named semaphore or pthread_mutexattr_pshared)——创建和销毁复杂且 kernel 不保证清理。**header.size=0 协议的代价**——Consumer 可能漏掉一次更新(在读取 header 和 counter values 之间更新)→下一次刷新会读到新值——**最终一致性** → 对于 monitoring dashboards(更新频率 1-5s)无影响。

---

### 核心悬念

**"StatSampler(WatcherThread 50ms)→PerfData counters 直接写 mmap——header.size=0 轻量同步——Consumer 轮询直到 ready。无锁——64-bit stores 原子 + 最终一致性。"** — 下一篇: 域39 Runtime Monitoring。

> → 域39 Runtime Monitoring
