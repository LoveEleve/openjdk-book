# 域 18: Safepoint — 知识规划

> 源码路径: hotspot/share/runtime/safepoint.* + safepointMechanism.* + safepointVerifiers.*
> 源码量: 7 文件 / ~2,296 行 | 🟡 普通域（含 🔴 核心编排机制）

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| safepoint.hpp + safepoint.cpp | **SafepointSynchronize — 安全点编排器**: 三态机(_not_synchronized→_synchronizing→_synchronized), begin() 分两阶段(spinning→blocking), safepoint_counter 优化(偶数=无safepoint, jni_GetPrimitiveField快速路径), SafepointStats 统计(time_to_spin/block/sync/cleanup), SafepointTimeoutReason, SafepointCleanupTasks(7项后台清理) | High |
| safepointMechanism.hpp + safepointMechanism.cpp + safepointMechanism.inline.hpp | **SafepointMechanism — 线程检测通路**: global_page_poll vs thread_local_poll, poll_armed/disarmed_value 控制, local_poll(读ThreadSafepointState标记) vs global_poll(读全局页地址), block_if_requested_slow → SafepointSynchronize::block, _poll_bit=8(通过基地址+8区分armed/disarmed) | High |
| safepointVerifiers.hpp + safepointVerifiers.cpp | **NoSafepointVerifier — 禁止安全点RAII守卫**: NoSafepointVerifier(Assert only: 构造保存旧counter, 析构assert counter未变), NoThreadSafepointVerifier(complement for thread-specific safety), PauseNoSafepointVerifier(临时暂停verification) | Medium |

*3 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识
| KP | 出现文件 |
|----|---------|
| SafepointSynchronize begin/end 编排 | safepoint.*, safepointMechanism.*(依赖), safepointVerifiers.*(保护), thread.hpp(ThreadSafepointState) |

### P2 — 局部重要
| KP | 出现文件 |
|----|---------|
| Polling 机制 (global vs thread local) | safepointMechanism.*, thread.hpp(_polling_page), assembler_x86.hpp(生成testl指令) |

### P3 — 孤立
| KP | 文件 |
|----|------|
| SafepointVerifiers (RAII debug guards) | safepointVerifiers.* |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| begin() 两阶段 spinning→blocking | Safepoint 必须让所有 Java 线程安全地停止。阶段1(spinning): 自旋等待 `_waiting_to_block` 降到 1(只剩自己)，给线程时间到达安全点——避免昂贵的阻塞。阶段2(blocking): 剩余线程不在安全状态→加 Safepoint_lock 等待 condition→thread->safepoint_state->wait。这是 JVM 最核心的全局同步原语——所有 GC/deopt/JVMTI/biased-lock-revoke 都依赖它 |
| pollination 检测机制 (page trap + thread local) | 检测"需要 safepoint"有两种: (1) page trap — mprotect 把轮询页变不可读→Java code 中的内存读触发 SIGSEGV→handler 进 safepoint。(2) thread local poll — 线程检查自身 ThreadSafepointState flag→比 page trap 快(不触发 signal)。global page trap 适用于所有线程广播，thread local 适用于单线程 handshake。_poll_bit=8: 同一页的两个地址(base vs base+8)区分 armed(可读=无safepoint) vs disarmed(不可读=需要 safepoint) |

### 🟡 Working — 有设计但非核心 (3 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| SafepointCleanupTasks (7项后台) | deflate monitors/update IC/compilation policy/symbol rehash/string rehash/CLD purge/dict resize — safepoint 期间执行的维护任务 | 是 safepoint 的附赠功能——safepoint 提供"全局暂停"窗口后添加的任务。理解 safepoint 本身不需要懂每个 task |
| SafepointStats 统计系统 | time_to_spin/to_block/to_sync/to_cleanup + safepoint_reasons 计数器 | 运维辅助——提供性能数据但不决定 safepoint 正确性 |
| NoSafepointVerifier (Debug RAII) | 禁止在构造函数→析构函数间出现 safepoint——用于保护 GC 数据结构修改 | Debug only——release 模式编译为空。防止开发者 bug 但不改变 safepoint 行为 |

### 🟢 Surface — 了解即可 (1 KP)
| KP | 说明 |
|----|------|
| safepoint_counter 优化 | jni_GetPrimitiveField 快速路径: 读 `_safepoint_counter` 偶数→无 safepoint→直接读字段。奇数→可能在 safepoint→走慢路径 |

## 04 聚类 — 依赖图+教学顺序+文章拆分

### 依赖图
```
          SafepointSynchronize
          begin() / end()
               │
      ┌────────┼────────┐
      │        │        │
  SafepointMechanism  SafepointVerifiers
  (polling检测)      (NoSafepoint RAII)
      │
  ThreadSafepointState (域17)
  (线程侧等待/唤醒)
```

### 教学顺序

**编排 → 检测 → 保护**:
1. 先讲 begin/end 的整体编排——怎么叫所有线程停下来
2. 再讲底层检测机制——polling page trap 和 thread local poll 怎么工作
3. 最后讲并发保护——NoSafepointVerifier 怎么防止关键区间的 safepoint

### 文章拆分: 2 篇

| 篇 | 标题 | 覆盖 KP | 核心问题 | 预估 |
|:--:|------|:--:|------|:--:|
| 1 | Safepoint 编排 — begin/end 全流程 | 三态机, begin() spinning→blocking两阶段, cleanup tasks, statistics, safepoint_counter优化 | "JVM 怎么让所有 Java 线程在同一时刻停下来？" | 核心 |
| 2 | 检测与保护 — Polling + NoSafepointVerifier | global_page_poll vs thread_local_poll, _poll_bit=8 区分armed/disarmed, SIGSEGV→handler, NoSafepointVerifier RAII, PauseNoSafepointVerifier | "线程怎么知道自己需要 safepoint？怎么保证关键代码不被 safepoint 打断？" | 深度 |
