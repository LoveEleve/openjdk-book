# 域 05: CPU Primitives — 知识规划

> 源码路径: runtime/atomic.hpp + orderAccess.* + prefetch.* + icache.* + cpu/x86/*
> 源码量: ~20 文件 / ~2,200 行 | 小型域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| runtime/atomic.hpp:40-200 | **Atomic — CPU原子指令封装**: add/fetch_and_add/inc/dec/xchg/cmpxchg/load/store 全模板化, OrderSelect适配memory_order, 平台分发(cpu/x86 vs cpu/arm), LOCK前缀(Intel) vs LL/SC(ARM)差异 | High |
| runtime/orderAccess.hpp + orderAccess.cpp | **OrderAccess — 内存保序屏障**: loadload/loadstore/storestore/storeload 四种屏障, 平台特定fence实现, UseMembar flag控制, C++11 memory_order映射 | High |
| runtime/prefetch.hpp + prefetch.inline.hpp | **Prefetch — 预取指令**: prefetch_read/prefetch_write, locality提示(temporal/non-temporal), Intel PREFETCHNTA/PREFETCHT0/T1/T2映射 | Medium |
| runtime/icache.hpp + icache.cpp + cpu/x86/icache_x86.hpp + icache_x86.cpp | **ICache — 指令缓存刷新**: Icache::flush(addr, size), self-modifying code一致性, x86 CLFLUSH/WBINVD vs ARM ISB/DSB | Medium |
| cpu/x86/rdtsc_x86.hpp + rdtsc_x86.cpp | **TSC — 时间戳计数器**: rdtsc/rdtscp指令, CPUID序列化, 不同核心的TSC偏差, 虚拟化环境下TSC行为差异 | Medium |
| runtime/registerMap.hpp + cpu/x86/registerMap_x86.hpp.cpp | **RegisterMap — 寄存器保存集合**: 用于栈展开/Deoptimization, update_map标记哪些寄存器需要保存, x86具体寄存器映射 | Medium |
| runtime/javaFrameAnchor.hpp + cpu/x86/javaFrameAnchor_x86.hpp | **JavaFrameAnchor — Java栈帧锚点**: last_Java_sp/last_Java_fp保存, JNI→Java边界保护, GC根扫描入口 | Medium |
| runtime/safefetch.inline.hpp | **SafeFetch — 安全内存读取**: 尝试读可能为null/unmapped的地址, CanCauseSegfault模板, SIGSEGV安全恢复 | Medium |
| cpu/x86/runtime_x86_32.cpp + runtime_x86_64.cpp | **x86 Runtime — 平台启动/清理**: pd_start_thread, pd_initialize, 栈帧初始化 | Low |

*9 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识 (≥5 文件)

| KP | 出现文件 |
|----|---------|
| Atomic原子操作体系 | atomic.hpp, orderAccess.*, prefetch.*, icache.*, safefetch.inline.hpp + runtime/中所有调用者 |

### P2 — 局部重要 (2-4 文件)

| KP | 出现文件 |
|----|---------|
| OrderAccess 内存屏障 | orderAccess.*, atomic.hpp |
| ICache 刷新 | icache.*, icache_x86.* |
| TSC 时间戳 | rdtsc_x86.*, runtime_x86.* |
| RegisterMap + JavaFrameAnchor | registerMap.*, javaFrameAnchor.* + cpu/x86对应 |

### P3 — 孤立 (1 文件)

| KP | 文件 |
|----|------|
| Prefetch | prefetch.* |
| SafeFetch | safefetch.inline.hpp |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (3 KP)

| KP | 为什么 🔴 |
|----|---------|
| Atomic 原子操作 | **并发策略**: x86 用 LOCK prefix → 自动 full barrier；ARM 用 LL/SC loop → 需显式 barrier。同一接口 `Atomic::cmpxchg` 两套实现——但线程模型完全一致。为什么 x86 的 cmpxchg 本身不能保证 ordering？→ CMPXCHG 不是 read-modify-write，必须有 LOCK 才原子 |
| OrderAccess 屏障 | **内存模型**: JVM 的四种 barrier (LL/LS/SL/SS) 为什么不是 C++ 的四种 memory_order？→ JVM 内部需要比 C++ 更细粒度的屏障控制——storestore 在 GC write barrier 中只需要 StoreStore 而非 full fence |
| SafeFetch | **异常处理策略**: 怎么在不 crash JVM 的情况下读可能无效的地址？→ 利用 SIGSEGV handler 的 sigsetjmp 恢复点——如果读导致 SIGSEGV, 跳回安全点而非 crash。性能代价：正常路径无开销, 失败路径 ~100ns sigsetjmp |

### 🟡 Working — 有设计但非核心 (3 KP)

| KP | 说明 |
|----|------|
| ICache 刷新 | 自修改代码场景稀有 |
| TSC | 时钟源选择逻辑 |
| RegisterMap + JavaFrameAnchor | 栈展开/Deopt的基础数据结构 |

### 🟢 Surface — 了解即可 (3 KP)

| KP | 说明 |
|----|------|
| Prefetch | 编译器生成的提示——很少手动用 |
| JavaFrameAnchor | 简单的栈帧锚点数据结构 |
| runtime_x86 | 平台启动代码——格式固定 |

## 04 聚类 — 教学顺序与文章拆分

### 依赖图

```
A: 原子操作 — 无前置
  └─ B: 内存屏障 — 先理解原子的need_for_barrier, 再看屏障本身
       └─ C: SafeFetch — 依赖 SIGSEGV handler (与OS域信号处理关联)
D: 辅助 — ICache/Prefetch/TSC/RegisterMap/JavaFrameAnchor
```

### 教学顺序

```
1. 原子操作 + 内存屏障 — core concurrency primitives (A+B)
2. SafeFetch + 辅助 — 异常安全读 + 平台辅助 (C+D)
```

### 文章拆分建议

2 篇（小型域）:

- **01-atomic-and-memory-order.md** — Atomic + OrderAccess + Prefetch
- **02-safefetch-and-platform.md** — SafeFetch + ICache + TSC + RegisterMap + JavaFrameAnchor
