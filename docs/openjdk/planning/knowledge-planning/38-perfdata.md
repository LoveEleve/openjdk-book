# 域 38: PerfData — 知识规划

> 源码: runtime/perfData.* + perfMemory.* + statSampler.* + os/linux/os_perf_linux.cpp | 9文件 | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| runtime/perfData.hpp/cpp/inline.hpp | **PerfData — JVM 内部性能计数器**: PerfLong/PerfCounter/PerfString 多类型, per-name注册(如"sun.gc.collector.0.time"), create_entry→write to shared memory, jstat/JConsole访问 | High |
| runtime/perfMemory.hpp/cpp | **PerfMemory — 共享内存区域**: mmap shared memory(producer=JVM, consumer=jstat), 附带 perf_data header, 同步协议 | Medium |
| runtime/statSampler.hpp/cpp | **StatSampler — 周期性数据采集**: WatcherThread定期sampling, sample_perf_data→update counters, GC stat/cpu load/compile count | Medium |

*3 知识点*

## 02 聚合 — P1
| KP | 出现文件 |
|----|---------|
| PerfData + perfMemory | perfData.*, perfMemory.*, statSampler.*, os/linux/os_perf_linux.cpp |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| PerfData + 共享内存架构 | JVM 的性能数据发布系统——每个计数器有名字+类型+值→通过 mmap shared memory 暴露给外部工具(jstat/JConsole)。Producer(JVM)更新值→Consumer(jstat)读共享内存(无IPC overhead)。PerfMemory 管理 shared memory region 创建/销毁→支持多Consumer 同时读 |

### 🟡 Working (1 KP)
| KP | 说明 |
|----|------|
| StatSampler | 周期性更新计数器(WatcherThread) |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | PerfData 架构 | "jstat -gc 的数据怎么实时读取 JVM 内部计数器？" |
| 2 | StatSampler + 共享内存 | "共享内存怎么同步？多个 jstat 同时读会不会冲突？" |
