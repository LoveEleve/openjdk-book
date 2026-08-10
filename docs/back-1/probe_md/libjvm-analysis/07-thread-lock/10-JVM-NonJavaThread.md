# 10-NonJavaThread — "不需要 safepoint 的自由"：WatcherThread + G1 并发线程全景与 NonJavaThread 分类理由

> **标准环境**：OpenJDK 11 slowdebug build, `-Xms8g -Xmx8g -XX:+UseG1GC`, 64-bit Linux AMD64
> **编译模式**：默认 mixed mode（Tiered Compilation 开启）
> **源文件**：`thread.hpp/cpp` `task.hpp/cpp` `concurrentGCThread.hpp/cpp` `g1ConcurrentMarkThread.hpp/cpp` `g1ConcurrentRefineThread.hpp/cpp` `g1YoungRemSetSamplingThread.hpp/cpp` `dirtyCardQueue.hpp/cpp` `os_linux.cpp`
> **前置阅读**：[06-ThreadOverview] 线程分类全景、[07-VMThread] VMThread 事件循环、[08-WorkerThread] WorkerThread 并行军团、[09-JavaThread] 10 个系统 JavaThread + 堆访问权分类理由
> **阅读收益**：理解 JVM 中所有永不停止的线程 → 回答"哪些线程 GC 管不了"→ 理解 PeriodicTask 10ms 定时器如何不依赖 OS timerfd → 理解 G1 并发线程的"不碰堆"证明

---

## §〇 源文件清单

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | `NonJavaThread`(:792), `NamedThread`(:830), `WatcherThread`(:875) | ★ 所有 NonJavaThread 的类定义 + 继承链 + NonJavaThread::Iterator(:813) |
| 2 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | `WatcherThread::WatcherThread()`(:1477), `WatcherThread::start()`(:1614), `WatcherThread::run()`(:1553), `WatcherThread::sleep()`(:1495) | ★ PeriodicTask 调度循环 + sleep 实现 + create_vm 尾部启动(:4320) |
| 3 | `task.hpp` | `src/hotspot/share/runtime/task.hpp` | `PeriodicTask`(:39) | ★ enroll/disenroll + 静态数组 _tasks[] + max_tasks=10 |
| 4 | `task.cpp` | `src/hotspot/share/runtime/task.cpp` | `real_time_tick()`(:49), `time_to_wait()`(:80), `enroll()`(:110), `disenroll()`(:135) | ★ PeriodicTask 框架实现 |
| 5 | `concurrentGCThread.hpp` | `src/hotspot/share/gc/shared/concurrentGCThread.hpp` | `ConcurrentGCThread`(:31) | ★ G1 并发线程基类 — run_service() 纯虚函数 |
| 6 | `concurrentGCThread.cpp` | `src/hotspot/share/gc/shared/concurrentGCThread.cpp` | `run()`(:82), `initialize_in_thread()`(:55) | ★ 并发线程生命周期模板 |
| 7 | `g1ConcurrentMarkThread.hpp` | `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.hpp` | `G1ConcurrentMarkThread`(:36) | ★ 状态机 Idle/Started/InProgress |
| 8 | `g1ConcurrentMarkThread.cpp` | `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.cpp` | `run_service()`(:248), `sleep_before_next_cycle()`(:90) | ★ 并发标记全周期调度 |
| 9 | `g1ConcurrentMark.hpp` | `src/hotspot/share/gc/g1/g1ConcurrentMark.hpp` | `G1CMBitMap`(:62), `G1ConcurrentMark`(:301), `mark_from_roots()`(:580) | 并发标记引擎 — SATB + bitmap + Reference |
| 10 | `g1ConcurrentMark.cpp` | `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp` | `mark_from_roots()`(:1102), `weak_refs_work()`(:1764) | ★ 标记根扫描 + Reference 处理边界 |
| 11 | `g1ConcurrentRefineThread.hpp` | `src/hotspot/share/gc/g1/g1ConcurrentRefineThread.hpp` | `G1ConcurrentRefineThread`(:37) | ★ RSet 精炼线程定义 |
| 12 | `g1ConcurrentRefineThread.cpp` | `src/hotspot/share/gc/g1/g1ConcurrentRefineThread.cpp` | `run_service()`(:96), `wait_for_completed_buffers()`(:63) | ★ 精炼主循环 |
| 13 | `g1ConcurrentRefine.hpp` | `src/hotspot/share/gc/g1/g1ConcurrentRefine.hpp` | `G1ConcurrentRefine`(:31), `G1ConcurrentRefineThreadControl`(:144) | ★ Green/Yellow/Red 三级 zone + 动态线程激活 |
| 14 | `g1ConcurrentRefine.cpp` | `src/hotspot/share/gc/g1/g1ConcurrentRefine.cpp` | `do_refinement_step()`(:481), `maybe_activate_more_threads()`(:473), `create()`(:283) | ★ 精炼线程创建 + zone 计算 |
| 15 | `g1RemSet.hpp` | `src/hotspot/share/gc/g1/g1RemSet.hpp` | `refine_card_concurrently()`(:130) | ★ 并发精炼单卡入口 |
| 16 | `g1RemSet.cpp` | `src/hotspot/share/gc/g1/g1RemSet.cpp` | `refine_card_concurrently()`(:731) | ★ 精炼单卡完整流程 |
| 17 | `g1YoungRemSetSamplingThread.hpp` | `src/hotspot/share/gc/g1/g1YoungRemSetSamplingThread.hpp` | `G1YoungRemSetSamplingThread`(:34) | ★ 采样线程定义 |
| 18 | `g1YoungRemSetSamplingThread.cpp` | `src/hotspot/share/gc/g1/g1YoungRemSetSamplingThread.cpp` | `run_service()`(:53), `sample_young_list_rs_lengths()`(:118) | ★ 采样循环 |
| 19 | `dirtyCardQueue.hpp` | `src/hotspot/share/gc/g1/dirtyCardQueue.hpp` | `DirtyCardQueue`(:44), `DirtyCardQueueSet`(:70) | ★ 脏卡队列（精炼线程的数据源） |
| 20 | `dirtyCardQueue.cpp` | `src/hotspot/share/gc/g1/dirtyCardQueue.cpp` | `apply_closure_to_completed_buffer()`(:273), `refine_completed_buffer_concurrently()`(:261) | ★ 并发精炼 buffer 处理 |
| 21 | `heapRegionRemSet.cpp` | `src/hotspot/share/gc/g1/heapRegionRemSet.cpp` | `PerRegionTable`(:47), `add_card_work()`(:78), `card_within_region()`(:340) | ★ 卡索引存储的位图实现 |
| 22 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `os::create_thread()`(:965), `default_guard_size()`(:3585) | ★ ThreadType 映射 — watcher_thread vs cgc_thread |
| 23 | `os.cpp` | `src/hotspot/share/runtime/os.cpp` | `os::create_thread()` 声明 | ThreadType 枚举值声明 |

---

## §一 NonJavaThread 体系全景 — 7 个永不暂停的守护者

### ❓ 为什么 JVM 需要 NonJavaThread？

前六篇文章 [04][05][06][07][08][09] 已经覆盖了锁膨胀全链路、线程生命周期、线程架构全景、VMThread 事件循环、WorkerThread 并行军团、10 个系统 JavaThread。现在要回答最后一个体系级问题：**JVM 内部还有哪些线程永远不需要被 safepoint 暂停？凭什么？**

在 [09 §四] 中我们建立了核心认知——「堆访问权 = safepoint 的负担」。CompilerThread 因为需要读 `InstanceKlass`/`MethodData`（在 Java 堆上），所以被迫继承 `JavaThread`，加入 safepoint 协议。**那么反过来**：哪些线程不需要访问 Java 堆，可以享受"永远不被 GC 暂停"的自由？

**答案就是 7 个 NonJavaThread**——它们可以分为两类：

1. **已覆盖**：VMThread [07] + WorkerThread × N [08]
2. **本文聚焦**：WatcherThread + G1ConcurrentMarkThread + G1ConcurrentRefineThread × N + G1YoungRemSetSamplingThread

### 1.1 继承链全景

从 `Thread` 基类开始的完整继承链（`thread.hpp:97-110`）：

```
Thread                                  (thread.hpp:115)
├── JavaThread                          (thread.hpp:925)
│   ├── CompilerThread                  [09 §四]
│   ├── CodeCacheSweeperThread          [09 §3.8]
│   └── ServiceThread 等               [09 §3.5]
│
└── NonJavaThread                       (thread.hpp:792)
    │                                   字段: NonJavaThread* volatile _next
    │                                   静态: static List _the_list
    │                                   内部类: class Iterator
    │
    ├── NamedThread                     (thread.hpp:830)
    │   ├── VMThread                    [07]
    │   ├── ConcurrentGCThread          (concurrentGCThread.hpp:31)
    │   │   ├── G1ConcurrentMarkThread  ← 本文 §三
    │   │   ├── G1ConcurrentRefineThread ← 本文 §四
    │   │   └── G1YoungRemSetSamplingThread ← 本文 §五
    │   └── WorkerThread                [08]
    │       ├── GangWorker
    │       └── GCTaskThread
    │
    ├── WatcherThread                   (thread.hpp:875) ← 本文 §二
    └── JfrThreadSampler                (不在本文范围)
```

**★ 关键：WatcherThread 直接继承 NonJavaThread，不经过 NamedThread 中间层。** 这意味着 WatcherThread 没有 `name()` 虚方法的覆盖——它直接覆盖 `Thread::name()`，返回硬编码字符串 `"VM Periodic Task Thread"`。而 G1 并发线程通过 `NamedThread` → `set_name()` 设置可变名称（如 `"G1 Conc#0"`）。

### 1.2 7 条 NonJavaThread 全景矩阵

```
┌─────────────────────────┬──────────────────┬───────────┬───────────────────────┬──────────┐
│ 线程名(jstack 无 Java 标识)│ 创建时机         │ ThreadType│ 数量                   │ 前一文档  │
├─────────────────────────┼──────────────────┼───────────┼───────────────────────┼──────────┤
│ VMThread                │ create_vm        │ vm_thread │ 1 (单例)               │ [07]     │
│ WorkerThread (×N)       │ GC 初始化         │ pgc_thread│ ParallelGCThreads      │ [08]     │
│ WatcherThread           │ create_vm 尾部    │ watcher   │ 1 (单例)               │ 本文 §二 │
│ G1ConcurrentMarkThread  │ G1 GC 初始化      │ cgc_thread│ 1                      │ 本文 §三 │
│ G1ConcurrentRefineThr   │ G1 GC 初始化      │ cgc_thread│ G1ConcRefinementThreads│ 本文 §四 │
│                         │                  │           │ (默认=ParallelGCT)      │          │
│ G1YoungRemSetSampThr    │ G1 GC 初始化      │ cgc_thread│ 1                      │ 本文 §五 │
└─────────────────────────┴──────────────────┴───────────┴───────────────────────┴──────────┘

★ ConcGCThreads 是 G1ConcurrentMark 内部的任务线程（WorkGang），不是独立的线程类型
★ G1ConcurrentRefineThread 数量 = G1ConcRefinementThreads（默认 = ParallelGCThreads）
```

### 1.3 ★ NonJavaThread 的 4 个硬特征

所有 NonJavaThread 共享以下区别于 JavaThread 的特征：

| 特征 | NonJavaThread | JavaThread [09] |
|------|---------------|-----------------|
| `threadObj()` | **NULL** — 无 `java.lang.Thread` 身份 | 非 NULL — `oop` 指向 Java 层 Thread 对象 |
| `JavaThreadState` | **不存在** — 没有 `volatile` 状态字段 | `_thread_state` — 三套状态之一 [06 §4.3] |
| `ThreadSafepointState` | **不存在** — 不参与 safepoint 协议 | 存在 — `SafepointState` 管理 block/page |
| Java 栈帧 | **无** — 不执行字节码 | 有 — 解释器/C1/C2 帧 |
| `JNIHandleBlock` | **有** — 但不是构造时分配，是 `run()` 中手动分配 | 有 — 构造时自动分配 [06 §3.2] |
| 线程链表 | **`NonJavaThread::_the_list`** (自有链表) | **`Threads::_thread_list`** (ThreadSMR 保护) |
| jstack 可见 | **否** — jstack 只遍历 `_thread_list` | **是** |
| pstack 可见 | **是** — OS 原生线程 | **是** |
| OS guard page | `page_size()` (4KB) — OS 管理 | `0` — HotSpot 自己的 GuardPage [09 §1.3] |
| safepoint 暂停 | **不受影响** — 永远不在 safepoint 中 block | 在 safepoint 中被暂停 |

```
★★★ 设计哲学内核:

  "堆访问权 = safepoint 的负担"
  
  JavaThread 因为访问 Java 堆 → 必须加入 safepoint 协议
    → GC 移动对象时 JavaThread 必须暂停
    → 代价: 编译被卡住 / 服务线程被延迟
  
  NonJavaThread 因为不访问 Java 堆 → 不需要 safepoint 协议
    → 永远不被 GC 暂停
    → 收益: 定时任务精准 / 并发标记持续 / RSet 精炼不中断
```

### ❓ jstack 看不到 NonJavaThread — 那怎么发现它们？

```bash
# 方法 1: GDB 遍历 NonJavaThread::_the_list
(gdb) set $t = NonJavaThread::_the_list._head
(gdb) while $t != 0
  >printf "NonJavaThread: %s\n", $t->name()
  >set $t = $t->_next
  >end

# 方法 2: pstack (OS 原生线程，全部可见)
pstack <pid> | grep -E "Periodic|Conc|Refine|Young"

# 方法 3: top -H (查看所有 OS 线程)
top -H -p <pid>

# 方法 4: GDB 对比数量
(gdb) p Threads::number_of_threads()    # JavaThread 数量
(gdb) p Threads::number_of_non_daemon_threads()
# 差值 = NonJavaThread 数量
```

### 1.4 ThreadType 对照 — OS 层的身份决定栈大小和 guard

`os::create_thread()` 中 ThreadType 决定线程的栈大小和 guard page 策略（`os_linux.cpp:965`）：

```
┌──────────────────────┬─────────────┬─────────────────┬────────────────────┐
│ 线程                  │ ThreadType   │ stack_size (AMD64)│ guard_page          │
├──────────────────────┼─────────────┼─────────────────┼────────────────────┤
│ JavaThread            │ java_thread │ 1MB (默认, -Xss) │ 0 (HotSpot 管理)    │
│ CompilerThread        │ compiler    │ 4MB (!)          │ 0 (HotSpot 管理)    │
│ VMThread              │ vm_thread   │ 1MB              │ page_size() (4KB)   │
│ WorkerThread          │ pgc_thread  │ 1MB              │ page_size() (4KB)   │
│ G1 并发线程            │ cgc_thread  │ 1MB              │ page_size() (4KB)   │
│ WatcherThread         │ watcher     │ 1MB              │ page_size() (4KB)   │
└──────────────────────┴─────────────┴─────────────────┴────────────────────┘

★ 源码验证: os_linux.cpp:3585-3589:
  if (thr_type == java_thread || thr_type == compiler_thread) return 0;
  else return page_size();

★ 原因:
  - JavaThread 需要 HotSpot 自己的 GuardPage 机制（栈溢出检测 → StackOverflowError）
  - NonJavaThread 栈浅且安全 → 只需 OS 的 guard page
  - CompilerThread 栈 4MB → 编译器需要深递归（解析复杂表达式/方法内联）
```

---

## §二 WatcherThread — PeriodicTask 定时调度引擎 + VMError 看门狗

### ❓ 为什么是 NonJavaThread？— 双重理由论证

**理由 1 — "时间精准 > 堆访问权"**

WatcherThread 的唯一职责是以 10ms 粒度驱动 `PeriodicTask` 回调。这些任务包括：

- 偏向锁延迟启用（4 秒后检查安全点频率）
- StringTable 定期清理
- JFR 采样
- SafepointCleanupTask（后台监控降级）
- VMThread 忙碌检测

如果 WatcherThread 是 JavaThread → GC 期间被 safepoint 暂停 → 定时任务不准 → 偏向锁延迟启用失效、JFR 漏采样、低内存检测延迟。

**理由 2 — "崩溃安全"（VMError 看门狗）**

WatcherThread 有第二个关键职责：JVM crash 后的 hs_err 文件生成超时看门狗。

```
场景: JVM 在 GC 中 crash → hs_err 文件生成卡住 (disk full / NFS hang)
     → 如果 WatcherThread 也是 JavaThread → 被 safepoint 暂停 → 永远醒不来
     → JVM 不会 exit → 进程 hang 在 crash 状态

但 WatcherThread 是 NonJavaThread:
     → 不受 safepoint 影响
     → 每秒醒来检查 VMError::check_timeout()
     → 超时后调用 os::die() 强制 kill 进程
     → 不会出现 "crash 后 hang" 的情况
```

### 2.1 创建 & 启动 — 构造函数自启动

```
★★★ WatcherThread 静态字段 (thread.cpp:1473-1475):

  WatcherThread *WatcherThread::_watcher_thread = NULL;  // 单例
  bool WatcherThread::_startable = false;                 // gate 标志
  volatile bool WatcherThread::_should_terminate = false;  // 终止标志

★★★ WatcherThread::WatcherThread() (thread.cpp:1477-1493):

  WatcherThread::WatcherThread() : NonJavaThread() {
    assert(watcher_thread() == NULL, "we can only allocate one WatcherThread");
    if (os::create_thread(this, os::watcher_thread)) {    // OS 线程创建
      _watcher_thread = this;                              // 注册单例
      os::set_priority(this, MaxPriority);                 // ★ 最高 OS 优先级!
      if (!DisableStartThread) {
        os::start_thread(this);                            // ★ 构造函数中自启动!
      }
    }
  }

★★★ WatcherThread::start() (thread.cpp:1614-1622):

  void WatcherThread::start() {
    assert(PeriodicTask_lock->owned_by_self(), "PeriodicTask_lock required");
    if (watcher_thread() == NULL && _startable) {
      _should_terminate = false;
      new WatcherThread();  // 构造函数自启动，返回时线程已在运行
    }
  }
```

**★ 关键认知**：`new WatcherThread()` 返回时线程已经在运行——不是延迟启动，是立即 `os::start_thread(this)`。

### 2.2 ★ 启动时机 — create_vm 尾部

```
★★★ Threads::create_vm() 尾部 (thread.cpp:4320-4333):

  {
    MutexLocker ml(PeriodicTask_lock);
    // Make sure the WatcherThread can be started by WatcherThread::start()
    // or by dynamic enrollment.
    WatcherThread::make_startable();              // _startable = true

    // Start up the WatcherThread if there are any periodic tasks
    // NOTE:  All PeriodicTasks should be registered by now. If they
    //   aren't, late joiners might appear to start slowly (we might
    //   take a while to process their first tick).
    if (PeriodicTask::num_tasks() > 0) {
      WatcherThread::start();                     // 有预注册任务 → 立即启动
    }
  }
```

**★ 如果 `create_vm` 结束时没有 PeriodicTask 注册（`num_tasks() == 0`），WatcherThread 不会被立即创建。** 但后续任何 `PeriodicTask::enroll()` 调用都会触发 `WatcherThread::start()`（如果尚未创建）。

### 2.3 ★★★ WatcherThread::run() 调度循环

```
★★★ WatcherThread::run() (thread.cpp:1553-1612):

void WatcherThread::run() {
  assert(this == watcher_thread(), "just checking");

  this->set_native_thread_name(this->name());          // OS 线程名
  this->set_active_handles(JNIHandleBlock::allocate_block());  // ★ 显式分配 JNIHandleBlock

  while (true) {
    assert(watcher_thread() == Thread::current(), "thread consistency check");
    assert(watcher_thread() == this, "thread consistency check");

    // 计算离下次 PeriodicTask 触发还有多久，sleep 那么久
    int time_waited = sleep();                         // ★ 持有 PeriodicTask_lock 等待

    // ────────── VMError 看门狗 ──────────
    if (VMError::is_error_reported()) {
      // JVM crash 后 hs_err 文件生成卡住 → 看门狗循环
      for (;;) {
        if (VMError::check_timeout()) {                // 超时了?
          os::naked_short_sleep(200);                  // 再给 200ms 收尾
          fdStream err(defaultStream::output_fd());
          err.print_raw_cr("# [ timer expired, abort... ]");
          os::die();                                   // ★ 强制 kill JVM
        }
        os::naked_short_sleep(999);                    // 每 ~1 秒重检
      }
    }
    // ────────── 看门狗结束 ──────────

    if (_should_terminate) {
      break;
    }

    PeriodicTask::real_time_tick(time_waited);           // ★ 执行所有到期任务
  }

  // 通知 WatcherThread 已终止
  {
    MutexLockerEx mu(Terminator_lock, Mutex::_no_safepoint_check_flag);
    _watcher_thread = NULL;
    Terminator_lock->notify();
  }
}
```

### 2.4 ★★★ WatcherThread::sleep() — 最精妙的等待实现

这是整个 HotSpot 中最精妙的一段线程等待代码：

```
★★★ WatcherThread::sleep() (thread.cpp:1495-1551):

int WatcherThread::sleep() const {
  // ★ 注释原文: "The WatcherThread does not participate in the safepoint
  //    protocol for the PeriodicTask_lock because it is not a JavaThread."
  MutexLockerEx ml(PeriodicTask_lock, Mutex::_no_safepoint_check_flag);

  if (_should_terminate) {
    return 0;  // 没 sleep
  }

  // remaining == 0 → 无任务 → 无限等待直到新任务 enroll 唤醒
  int remaining = PeriodicTask::time_to_wait();  // ★ 所有任务的最短等待时间
  int time_slept = 0;

  jlong time_before_loop = os::javaTimeNanos();

  while (true) {
    bool timedout = PeriodicTask_lock->wait(     // ★ Monitor::wait() — 不是 ParkEvent::park()!
                       Mutex::_no_safepoint_check_flag, remaining);
    jlong now = os::javaTimeNanos();

    if (remaining == 0) {
      // 无限等待 → 被唤醒后重置计时起点
      time_slept = 0;
      time_before_loop = now;
    } else {
      // 定时等待 → 计算实际已等待时间
      time_slept = (int) ((now - time_before_loop) / 1000000);
    }

    // 正常超时 或 收到终止信号 → 退出
    if (timedout || _should_terminate) {
      break;
    }

    // ★ 伪唤醒 → 重新计算剩余时间
    remaining = PeriodicTask::time_to_wait();
    if (remaining == 0) {
      // 最后一个任务刚被 disenroll → 重新无限等待
      continue;
    }

    remaining -= time_slept;
    if (remaining <= 0) {
      break;
    }
  }

  return time_slept;
}
```

**核心设计洞察（6 层嵌套语义，层层递推）：**

| 场景 | `remaining` | `wait()` 行为 | 唤醒原因 | 结果 |
|------|-----------|-------------|---------|------|
| 无任务 | `0` | 无限等待 | enroll 后 notify 唤醒 | 重新计算 `time_to_wait()` |
| 有任务，正常超时 | `>0` | 定时等待 N ms | 超时 | 退出 sleep，执行 Tick |
| 有任务，伪唤醒 | `>0` | 定时等待 | 系统伪唤醒 | 重新计算并减去已等待时间 |
| 有任务，新 enroll | `>0` | 定时等待 | 新任务 notify | 重新计算 `time_to_wait()` |
| 有任务，任务 disenroll | `>0` | 定时等待 | disenroll 未 notify | 重新计算后可能 `remaining==0` |
| 终止信号 | 任意 | — | `_should_terminate=true` | 退出 |

**★ sleep() vs ParkEvent::park() 的差异：**

```
┌──────────────────────┬───────────────────────────┬────────────────────────────┐
│ 维度                   │ Monitor::wait() (sleep 用) │ ParkEvent::park() (普通用)  │
├──────────────────────┼───────────────────────────┼────────────────────────────┤
│ 使用模型              │ "锁 + 条件变量"             │ "信号量"                    │
│ 需要持有的锁          │ 必须持有 Monitor            │ 不需要持锁                  │
│ 等待期间             │ 释放锁 → 等待 → 重新获取锁   │ 只等待 → 不依赖锁           │
│ 底层实现             │ pthread_cond_timedwait     │ pthread_cond_timedwait     │
│ 锁定纪律             │ 退出时重新占有 PeriodicTask_lock │ 无锁纪律                  │
│ WatcherThread 用     │ ★ 因为需要在 sleep 结束后    │ 不适用 — 需要保护 _tasks[]  │
│                      │   立即获取 PeriodicTask_lock │                           │
│                      │   以执行 real_time_tick()    │                           │
└──────────────────────┴───────────────────────────┴────────────────────────────┘
```

### ❓ 为什么不用 OS timerfd？— park/unpark vs timerfd 的设计权衡

Linux 内核提供了 `timerfd_create()` + `timerfd_settime()` 用于精确的定时器创建，那为什么 JVM 不直接用 timerfd 替代 PeriodicTask 框架？

```
★★★ 设计权衡: 为什么不直接用 OS timerfd?

  timerfd 方案:
    timerfd_create(CLOCK_REALTIME, O_NONBLOCK)
    timerfd_settime(timerfd, ..., &itimerspec{interval=10ms}, ...)
    read(timerfd, ...)  // 阻塞等待定时触发
    
    优点: 内核级精度 — 不受用户态调度影响
    缺点:
      ① timerfd 触发间隔是固定的 — 不能动态调整
         → PeriodicTask 的 time_to_wait() 返回动态值 (可能 50ms, 可能 0ms)
         → 如果用了 timerfd, 每次有新任务 enroll 需要撤销旧定时器 → 系统调用开销
      
      ② timerfd 只能设置一个定时器 — 无法同时等待多个不同间隔
         → 需要多个 timerfd → 需要用 epoll 来 multiplex → 复杂度暴涨
         → 而 pthread_cond_timedwait 自然支持被 notify 打破等待
      
      ③ 跨平台 — timerfd 是 Linux 特有
         → HotSpot 有多平台需求 (Solaris/AIX/BSD)
         → pthread_cond_timedwait 是 POSIX 标准，全平台可用
      
      ④ 唤醒语义 — timerfd 的 read() 和 PeriodicTask_lock->notify() 不能同时 wait
         → 必须用 epoll (timerfd + eventfd) 来"等待定时器或新任务 enroll"
         → 复杂度远超当前的单一条件变量方案

  ★ HotSpot 的选择 — pthread_cond_timedwait + notify:
    - sleep() 用 PeriodicTask_lock->wait(remaining_ms)
    - 新任务 enroll 后 PeriodicTask_lock->notify()
    - 底层是 pthread_cond_timedwait — 一个调用同时支持"定时唤醒"和"条件唤醒"
    - 不需要 epoll, 不需要多个 fd, 不需要撤销定时器
    - 跨平台 — 所有 POSIX 系统都支持
    
  代价: pthread_cond_timedwait 精度取决于系统调度器 (jiffies), 不是纳秒级
  收益: 用一个条件变量优雅解决了 "多定时器 + 动态注册 + 跨平台" 三个需求

  这个设计反映了 HotSpot 的一贯哲学:
    "用最简单可行的方案, 而不是最高精度的方案。
     如果 10ms 精度已经足够, 不需要为此引入 epoll + timerfd 的复杂性。"
```

### 2.5 ★★★ PeriodicTask 框架 — 静态数组 + 累加计数器

```
★★★ PeriodicTask 核心数据结构 (task.hpp:39-108):

class PeriodicTask: public CHeapObj<mtInternal> {
 public:
  enum { max_tasks     = 10,       // ★ 硬限制: 最多 10 个 PeriodicTask!
         interval_gran = 10,       // 间隔粒度: 必须是 10ms 的整数倍
         min_interval  = 10,
         max_interval  = 10000 };

  static int num_tasks() { return _num_tasks; }

 private:
  int _counter;                       // ★ 累计等待时间 → 达到 _interval 时触发
  const int _interval;                //   触发间隔 (ms), 构造时设置

  static int _num_tasks;              // ★ 当前已注册任务数
  static PeriodicTask* _tasks[10];    // ★ 静态数组, 不是链表!
   
  static void real_time_tick(int delay_time);  // WatcherThread::run() 调用

  friend class WatcherThread;         // 只有 WatcherThread 能 Tick

 public:
  PeriodicTask(size_t interval_time); // interval 必须是 10ms 的整数倍
  ~PeriodicTask();

  void enroll();                      // 注册 → 加入 _tasks[]
  void disenroll();                   // 注销 → 从 _tasks[] 移除

  void execute_if_pending(int delay_time) {
    jlong tmp = (jlong)_counter + (jlong)delay_time;  // ★ 加法防溢出!
    if (tmp >= (jlong)_interval) {
      _counter = 0;
      task();                          // ★ 到点了 → 执行回调
    } else {
      _counter += delay_time;
    }
  }

  int time_to_next_interval() const {
    assert(_interval > _counter, "task counter greater than interval?");
    return _interval - _counter;      // ★ 距离下次触发还有多少 ms
  }

  static int time_to_wait();          // ★ 所有任务的最短等待时间
  virtual void task() = 0;            // ★ 纯虚函数 → 子类实现业务逻辑
};
```

**★ `execute_if_pending()` 的防溢出设计：**

```
为什么用 _counter + delay_time >= _interval 而不是 _counter >= _interval？

错误设计:
  if (_counter >= _interval) { _counter = 0; task(); }
  else { _counter += delay_time; }
  
问题: 如果 _counter 从 INT_MAX-1 再加 delay_time → 整数溢出 → _counter 变成负数
     → _counter >= _interval 永远不会为 true → 任务永远不触发!

正确设计:
  jlong tmp = (jlong)_counter + (jlong)delay_time;  // 先提升到 jlong (64位)
  if (tmp >= (jlong)_interval) { ... }               // 用 64 位比较 → 安全
```

### 2.6 ★★★ PeriodicTask::real_time_tick() — 执行所有到期任务

```
★★★ PeriodicTask::real_time_tick() (task.cpp:49-78):

void PeriodicTask::real_time_tick(int delay_time) {
  assert(Thread::current()->is_Watcher_thread(), "must be WatcherThread");

  {
    // ★ 与 sleep() 一样，用 _no_safepoint_check_flag
    MutexLockerEx ml(PeriodicTask_lock, Mutex::_no_safepoint_check_flag);
    int orig_num_tasks = _num_tasks;

    for (int index = 0; index < _num_tasks; index++) {
      _tasks[index]->execute_if_pending(delay_time);

      // ★ 如果任务在 task() 回调中 disenroll 了自己
      if (_num_tasks < orig_num_tasks) {  // 数量变了!
        index--;                            // ★ 重试当前 slot (被尾部元素填补)
        orig_num_tasks = _num_tasks;
      }
    }
  }
}
```

**★ 关键设计**：`disenroll()` 使用"尾部元素填补空洞"策略（`task.cpp:135-156: disenroll()` 通过 `_tasks[index] = _tasks[index+1]` 移动元素），所以 `real_time_tick()` 需要用 `index--` 重试当前 slot。

### 2.7 ★ 延迟注册机制 — 不在 create_vm 中预注册的 PeriodicTask

```
★★★ 两类 PeriodicTask 注册时机:

1. create_vm 中预注册 (VM 启动时):
   - 各种内置监控任务

2. 延迟注册 (运行时动态):
   - BiasedLocking::init(): 4 秒后注册 — 检查安全点频率 → 决定是否启用偏向锁
   - StringTable 清理: SafepointSynchronize::end() 中注册
   - JFR 采样: JFR 开启时注册
   - SafepointCleanupTask: 后台监控降级

★★★ 延迟注册如何唤醒 WatcherThread (task.cpp:110-132):

void PeriodicTask::enroll() {
  MutexLockerEx ml(PeriodicTask_lock->owned_by_self() ? NULL : PeriodicTask_lock);

  if (_num_tasks == PeriodicTask::max_tasks) {
    fatal("Overflow in PeriodicTask table");   // ★ ≥11 个 → 直接 fatal!
  } else {
    _tasks[_num_tasks++] = this;                // 追加到数组
  }

  WatcherThread* thread = WatcherThread::watcher_thread();
  if (thread != NULL) {
    thread->unpark();                          // ★ WatcherThread 已存在 → 唤醒它
  } else {
    WatcherThread::start();                    // ★ WatcherThread 不存在 → 创建并启动
  }
}
```

**★ 所以 WatcherThread 的生命周期由 PeriodicTask 的注册/注销自动管理：**
1. 如果 `create_vm` 结束时没有任务 → WatcherThread 不存在
2. 第一个 `enroll()` 创建 WatcherThread
3. WatcherThread 在 `sleep()` 中无限等待（`remaining == 0`）
4. 新任务 `enroll()` 通过 `PeriodicTask_lock->notify()` 唤醒 WatcherThread
5. 所有任务 `disenroll()` 后 → WatcherThread 回到无限等待
6. JVM 退出 → `WatcherThread::stop()` 终止

---

## §三 G1ConcurrentMarkThread — 并发标记调度者

### ❓ 为什么不碰 Java 堆？— ★ 边界分析

**错误说法**："G1ConcurrentMarkThread 完全不碰 Java 堆"。

**正确说法**："G1ConcurrentMarkThread 在纯并发标记阶段不碰 Java 堆上的移动对象，所有可能碰 Java 堆的操作都在 STW Remark 阶段完成。"

```
★★★ 并发标记各阶段的内存访问分析:

┌──────────────────────┬────────┬──────────────────────────┬─────────────┐
│ 阶段                   │ 谁执行  │ 访问的内存                 │ 碰 Java 堆?  │
├──────────────────────┼────────┼──────────────────────────┼─────────────┤
│ Initial Mark         │ STW     │ 扫描 GC 根               │ 是 (安全)    │
│ Root Region Scan     │ 并发    │ 扫描 Survivor Region      │ 是 (引用未变) │
│ ★ Concurrent Mark    │ 并发    │ SATB 队列 + 标记位图       │ ★ 否         │
│ ★ Reference 发现     │ 并发    │ Reference 对象链           │ ★ 边界!      │
│ ★ Remark              │ STW     │ Reference 处理 + SATB 排空 │ 是 (安全)    │
│ Cleanup              │ 并发    │ 位图 + Region 统计         │ 否           │
└──────────────────────┴────────┴──────────────────────────┴─────────────┘
```

### 3.1 ★★★ 证据链 — 为什么纯并发阶段不碰 Java 堆

```
证据 1 — 标记位图: 在独立虚拟内存中，不在 Java 堆

  G1CMBitMap::initialize() (g1ConcurrentMarkBitMap.cpp:47-56):
    _bm = BitMapView((BitMap::bm_word_t*) storage->reserved().start(), ...)
    
  storage 由 G1CollectedHeap::create_aux_memory_mapper() 创建:
    → 通过 ReservedSpace + mmap 分配独立虚拟内存区域
    → 不在 Java 堆范围内
    → GC 移动对象不影响位图的位布局
    → 位图大小: heap_size >> LogMinObjAlignment (8GB堆 → ~128MB/bitmap，双缓冲 prev+next 共 ~256MB)

证据 2 — SATB 队列: thread-local C heap

  SATBMarkQueue extends PtrQueue → CHeapObj
  → SATB buffer 在 C heap 上 (mtGC)
  → G1SATBBufferSize = 1KB (默认)
  → 每个 JavaThread 有一个 SATB buffer
  → 并发标记线程消费 completed SATB buffers

★★★ 证据 3 — Reference 发现: 边界分析 ← 全文最深的点!

  G1CMRefProcTaskExecutor (g1ConcurrentMark.cpp:1698-1762):
    在并发标记的"预清理"阶段 (preclean):
      → ReferenceProcessor::preclean_discovered_references()
      → 读 Reference 对象的 discovered 字段 ← 在 Java 堆上!
      → 但此时 Reference 对象还没有被 GC 移动
      → 如果发生 Young GC → Reference 对象被移动 → oop 失效

  解决方案:
    真正的 Reference 处理 (process_discovered_references) 在 remark 阶段:
      → remark 是 STW 暂停!
      → 由 VMThread 执行 (gc_prologue → weak_refs_work → gc_epilogue)
      → 所有可能碰 Java 堆的操作都在 STW 中安全完成
      
  weak_refs_work() (g1ConcurrentMark.cpp:1764-1854):
    → 处理 SoftReference → WeakReference → FinalReference → PhantomReference
    → 设置 discovered 字段 → 在 Java 堆上
    → 但此时所有 JavaThread 都停在 safepoint → 安全

  ★ 所以: G1ConcurrentMarkThread 在纯并发标记阶段不碰 Java 堆上的移动对象。
    所有可能碰 Java 堆的操作都在 STW Remark 阶段完成。
    这就是 "为什么 ConcurrentMarkThread 可以是 NonJavaThread" 的精确答案。
```

### 3.2 G1ConcurrentMarkThread 的继承链和创建

```
继承: Thread → NonJavaThread → NamedThread → ConcurrentGCThread → G1ConcurrentMarkThread

创建: G1CollectedHeap::initialize() → G1ConcurrentMarkThread::create()
  → new G1ConcurrentMarkThread()      (构造函数)
  → create_and_start(NearMaxPriority)  (继承自 ConcurrentGCThread)
    → os::create_thread(this, os::cgc_thread)  ← ThreadType = cgc_thread
    → os::set_priority(this, NearMaxPriority)  ← 优先级略低于 VMThread
    → os::start_thread(this)
```

### 3.3 G1ConcurrentMarkThread 的状态机

```
★★★ G1ConcurrentMarkThread::State (g1ConcurrentMarkThread.hpp:45-49):

  enum State { Idle, Started, InProgress };

★★★ 状态转换:

  Idle ──────────────→ Started ──────────────→ InProgress ──────────────→ Idle
   ↑                   │                      │                           │
   │ 收到 Initial Mark   │ 等待 CGC_lock       │ mark_from_roots()         │
   │ notify            │ 或超时              │ + preclean()             │
   │                   ↓                      ↓                           │
   └──────────────────────────────────────────────────────────────────────┘
                          循环 (Young GC 触发新的 Initial Mark)

★★★ run_service() 核心循环 (g1ConcurrentMarkThread.cpp:248):

void G1ConcurrentMarkThread::run_service() {
  while (!should_terminate()) {
    sleep_before_next_cycle();          // 等待 Initial Mark (Young GC) 唤醒

    ConcurrentGCTimer timer;

    // Phase 1: Initial Mark — STW, 由 VMThread 执行
    // Phase 2: Root Region Scan — 并发, 本线程调度
    // Phase 3: ★ Concurrent Mark — 并发, 本线程执行
    //   G1ConcurrentMark::mark_from_roots()
    //     → 遍历 SATB 队列
    //     → 标记位图 (bitmap on virtual memory)
    //     → 预清理 Reference (仅排空 SATB side queue)
    // Phase 4: Remark — STW, 由 VMThread 执行
    // Phase 5: Cleanup — 并发, 本线程执行

    if (!completed) {
      continue;  // 标记被中断 (Young GC 抢占) → 重新开始
    }
  }
}
```

### 3.4 ★ NonJavaThread 分类理由 — 精确到阶段

```
为什么 G1ConcurrentMarkThread 是 NonJavaThread？

1. 纯并发标记阶段只碰:
   - SATB 队列 (C heap)
   - 标记位图 (独立虚拟内存, 不在 Java 堆)
   - 类元数据 (Metaspace, 不是 Java 堆)
   → 不会遇到 GC 移动中的对象
   → 不需要 safepoint 保护

2. 可能碰 Java 堆的 Reference 处理 → 在 STW Remark 阶段完成
   → Remark 由 VMThread 执行 (JavaThread)
   → 并发标记线程在 Remark 期间被暂停 (通过 CGC_lock 等待)
   → 安全

3. 代价: 如果并发标记线程持有 stale oop → 在下次 safepoint 前不能解除引用
   约束: 并发标记线程不能在 safepoint 之间解除 oop 引用

★ 结论: G1ConcurrentMarkThread 不是 "不碰堆"，而是 "碰堆的操作在 STW 完成，
  纯并发阶段不碰堆" — 这是 NonJavaThread 分类的精确边界条件。
```

### 3.5 sleep_before_next_cycle() — 与 VMThread 的协作

```
★★★ sleep_before_next_cycle() (g1ConcurrentMarkThread.cpp:90):

  → 获取 CGC_lock (Mutex::_no_safepoint_check_flag!)
  → while (!started() && !should_terminate()) {
      CGC_lock->wait(...);  // 等待 VMThread 在 Initial Mark 后 notify
    }
  → 被唤醒 → 开始新一轮并发标记

★ 协作模式:
  1. VMThread (JavaThread) 在 Young GC 中执行 Initial Mark (STW)
  2. Initial Mark 完成后 notify CGC_lock
  3. G1ConcurrentMarkThread (NonJavaThread) 醒来 → 开始并发标记
  4. 并发标记完成后 → 回到 sleep_before_next_cycle() 等待下一次

★ 注意: CGC_lock 使用 _no_safepoint_check_flag (因为持有者是 NonJavaThread)
```

---

## §四 G1ConcurrentRefineThread × N — RSet 精炼军团

### ❓ ★ 为什么不碰 Java 堆？— 卡索引的永恒稳定性

**这是本文最优雅的数学证明**：精炼线程只读写卡索引（纯整数），而卡索引是 Java 堆地址的固定映射，GC 移动对象不改变这个映射。

```
★★★ 重要澄清: 卡表(CardTable) vs RSet(PerRegionTable) 的物理位置:

  CardTable::_byte_map (~16MB for 8GB heap):
    → 位于 Java 堆起始位置之前的一段预留内存 (G1 称为 "backing storage")
    → 是一块连续的字节数组 (card_size = 512B, 每个 card 对应 1 byte)
    → GC 从不移动卡表本身 (它在堆之外的固定地址)
    → card_ptr = _byte_map + (heap_addr >> card_shift)
    → 精炼线程通过 *card_ptr 读 card 的 dirty/clean 状态

  PerRegionTable (PRT):
    → 继承 CHeapObj<mtGC> → 在 C heap 分配
    → _bm 是 CHeapBitMap → 在 C heap
    → 存储的是 card_idx (纯整数, 不是指针!)
    → 精炼线程只写 _bm bit, 不写 Java 堆

  ★ 所以: card TABLE 在 Java 堆预留区域, RSet 在 C heap。
    精炼线程读 card table (只读), 写 RSet (C heap)。
    全程不改写 Java 堆上的任何对象。
```
★★★ 核心数据流: DirtyCard → Card Address → Card Index → BitMap Bit

  Mutator 线程写屏障 (post-write barrier):
    ① obj.field = new_value;
    ② DirtyCardQueue::enqueue(&obj.field);  // 记录被修改的 card 地址
       → card_addr = (byte*)((uintptr_t)&obj.field & ~(card_size - 1));
       → 写入 thread-local DirtyCardQueue buffer (C heap)

  G1ConcurrentRefineThread:
    ③ DirtyCardQueueSet::apply_closure_to_completed_buffer():
       → 对 buffer 中每个 card_addr:
       → G1RemSet::refine_card_concurrently(card_addr, worker_i):
         ④ 读 card 内容: *card_addr → 判断 card 是否 dirty
         ⑤ 如果 dirty → 扫描 card (512B) 中找到跨 Region 引用的对象
         ⑥ 计算 card 索引: card_idx = (card_addr - region->bottom) >> card_shift
         ⑦ PerRegionTable::add_card_work(card_idx):
              _bm.at_put(card_idx, 1);  // ★ 在 CHeapBitMap 中设置一个 bit!
              _occupied++;

  ★ 为什么卡索引永远有效:
    - card_idx = (addr - region_bottom) / card_size
    - GC 移动对象 → addr 变化 → 对象在新位置
    - 但 card_idx 不是对象指针! 它是地址的偏移量
    - 同一个 card_idx 指向的 card 页在移动后仍然 valid
    - 因为 card 表映射的是整个堆地址空间的固定分区
    - GC compact 不会改变 card 页的粒度和编号方式

  ★ 精炼线程全程不持 Java 对象引用:
    - 读 card value: 只需要知道 card 是否 dirty → 不需要知道对象是谁
    - 扫描 card: 临时持有 oop → 但只读不写 → 不改变对象引用
    - 更新 RSet: 只写 card_idx (纯整数) → CHeapBitMap → C heap
    - 结论: 精炼线程永远不需要 safepoint 保护
```

### 4.1 ★★★ Green / Yellow / Red 三级 Zone 策略

```
★★★ Dirty Card Queue 的三级 zone (g1ConcurrentRefine.hpp:73-93):

  注释原文: "The value of the completed dirty card queue length falls into
             one of 3 zones: green, yellow, red."

  ┌──────────┬──────────────┬──────────────┬────────────────────────────────┐
  │ Zone      │ 队列长度范围   │ 精炼线程行为  │ Mutator 行为                    │
  ├──────────┼──────────────┼──────────────┼────────────────────────────────┤
  │ Green     │ [0, green)   │ 不处理        │ 不处理                          │
  │           │              │ ★ 保留 buffer │ (利用缓存 — card 可能再次 dirty)  │
  │ Yellow    │ [green, yellow)│ ★ 逐步激活  │ 不处理                          │
  │           │              │ 1→2→3...→N   │                                │
  │ Red       │ [yellow, red) │ 所有线程激活  │ 不处理                          │
  │ 超 Red    │ ≥ red         │ 所有线程激活  │ ★ Mutator 也参与处理!            │
  └──────────┴──────────────┴──────────────┴────────────────────────────────┘

★★★ Zone 默认值计算 (g1ConcurrentRefine.cpp:251-281):

  green  = ParallelGCThreads        (8核 → 8)
  yellow = green * 3                (8核 → 24)
  red    = yellow + (yellow-green)  (8核 → 40)

  ★ 自适应: 如果设置了 UseDynamicNumberOfGCThreads (默认 true):
    - 初始只创建 1 个精炼线程
    - 队列长度超过 worker_1 的 activation_threshold → 激活 worker_2
    - 队列长度超过 worker_2 的 activation_threshold → 激活 worker_3
    - ...最多 max_num_threads (= G1ConcRefinementThreads)

★★★ 每个 Worker 的激活阈值 (g1ConcurrentRefine.cpp:205-222):

  calc_thresholds():
    step = ceil((yellow - green) / max_num_threads)
    for each worker_i:
      activation_threshold[i]   = green + step * (worker_i + 1)  // 激活线
      deactivation_threshold[i] = green + step * worker_i        // 停用线

  例: max_num_threads=3, green=8, yellow=24:
    Worker 0: activate=14, deactivate=8
    Worker 1: activate=20, deactivate=14
    Worker 2: activate=26, deactivate=20
```

### 4.2 ★★★ run_service() — 精炼主循环

```
★★★ G1ConcurrentRefineThread::run_service() (g1ConcurrentRefineThread.cpp:96-148):

void G1ConcurrentRefineThread::run_service() {
  _vtime_start = os::elapsedVTime();

  while (!should_terminate()) {
    // ── 步骤 1: 等待工作 ──
    wait_for_completed_buffers();    // 在 _monitor 上等待，直到 _active == true
    if (should_terminate()) break;

    // ── 步骤 2: 加入 SuspendibleThreadSet ──
    size_t buffers_processed = 0;
    {
      SuspendibleThreadSetJoiner sts_join;  // 允许 Young GC 通知本线程 yield

      while (!should_terminate()) {
        // ★ 检查是否需要 yield (给 Young GC 让路)
        if (sts_join.should_yield()) {
          sts_join.yield();
          continue;
        }

        // ── 步骤 3: 精炼一个 completed buffer ──
        if (!_cr->do_refinement_step(_worker_id)) {
          break;  // 队列长度低于 deactivation_threshold → 停用
        }
        ++buffers_processed;
      }
    }

    // ── 步骤 4: 停用 ──
    deactivate();  // 设置 _active = false
  }
}

★★★ do_refinement_step() (g1ConcurrentRefine.cpp:481-501):

bool G1ConcurrentRefine::do_refinement_step(uint worker_id) {
  DirtyCardQueueSet& dcqs = G1BarrierSet::dirty_card_queue_set();
  size_t curr_buffer_num = dcqs.completed_buffers_num();

  // 如果队列长度回落到 yellow zone 以内 → 清除 padding
  if (dcqs.completed_queue_padding() > 0 && curr_buffer_num <= yellow_zone()) {
    dcqs.set_completed_queue_padding(0);
  }

  // ★ 检查是否需要激活更多线程
  maybe_activate_more_threads(worker_id, curr_buffer_num);

  // ★ 精炼一个 completed buffer
  return dcqs.refine_completed_buffer_concurrently(
           worker_id + worker_id_offset(),
           deactivation_threshold(worker_id));
}
```

### 4.3 ★★★ 精炼单卡流程 — refine_card_concurrently()

```
★★★ G1RemSet::refine_card_concurrently() (g1RemSet.cpp:731-873):

void G1RemSet::refine_card_concurrently(jbyte* card_ptr, uint worker_i) {
  // 步骤 1: 如果 card 不再是 dirty → 跳过
  if (*card_ptr != CardTable::dirty_card_val()) return;

  // 步骤 2: card 指针 → HeapWord* → HeapRegion*
  HeapWord* start = _ct->addr_for(card_ptr);
  HeapRegion* r = _g1h->heap_region_containing(start);

  // 步骤 3: 跳过无法处理的 region (young/humongous 除外)
  // ...

  // 步骤 4: ★ 热卡缓存 (Hot Card Cache)
  //   如果 card 已经在缓存中 → 跳过 (刚刚处理过)
  //   如果旧 card 被从缓存中驱逐 → 处理旧的 card

  // 步骤 5: 将 dirty region 裁剪到 region->top() (避免处理未分配内存)
  HeapWord* end = start + CardTable::card_size_in_words;
  if (end > r->top()) end = r->top();

  // 步骤 6: ★ 标记 card 为 clean
  *card_ptr = CardTable::clean_card_val();

  // 步骤 7: ★ 迭代 card 上的对象 → 找到跨 Region 引用
  G1ConcurrentRefineOopClosure cl(_g1h, worker_i);
  //   cl 对每个对象:
  //     → 遍历对象的引用字段
  //     → 如果引用指向其他 Region → 调用 PerRegionTable::add_reference()
  //     → add_reference 计算 card_idx 并设置 _bm bit

  // 步骤 8: 如果 card 不可处理 (stale reference) → 重新 dirty + 重新入队
}

★★★ card_index 计算 (heapRegionRemSet.cpp:340-345):

CardIdx_t OtherRegionsTable::card_within_region(OopOrNarrowOopStar within_region,
                                                 HeapRegion* hr) {
  CardIdx_t result = (CardIdx_t)(
    pointer_delta((HeapWord*)within_region, hr->bottom())
    >> (CardTable::card_shift - LogHeapWordSize)
  );
  return result;
}

// ★ 数学本质:
//   card_idx = (addr - region_base) / card_size
//   其中 card_size = 512 bytes (CardTable::card_shift = 9)
//
//   GC compact 后:
//     addr 变 → addr' (对象被移动到新位置)
//     但 card_idx' = (addr' - region_base) / card_size
//     仍然是合法的卡索引 → 仍然指向新的 card 页
//     → 卡索引不关心对象在哪里 → 只关心"哪个 512B 页被修改过"
```

### 4.4 ★ NonJavaThread 分类理由 — 全程不持 heap reference

```
精炼线程操作总结:

  输入: card_addr (Java 堆地址) → 读 *card_addr (card value)
  处理: 扫描 512B card → 临时持有 oop → 只读不写
  输出: card_idx (纯整数) → _bm.at_put(card_idx, 1) → CHeapBitMap (C heap)

  ★ 全程没有:
    - 修改 Java 对象引用 (不写 Java 堆)
    - 持有长期 oop 引用 (oop 只在扫描窗口内有效)
    - 依赖对象的地址稳定性 (card_idx 与对象位置无关)

  ★ 结论: 精炼线程永远不需要 safepoint 保护
```

---

## §五 G1YoungRemSetSamplingThread — 记忆集采样器

### ❓ 为什么存在？— 驱动年轻代自适应大小决策

年轻代大小在 `G1NewSizePercent`(5%) ~ `G1MaxNewSizePercent`(60%) 之间浮动。每次 Young GC 后，G1 需要决定下次年轻代用多大。这个决策取决于 RSet 的大小：

- **RSet 很大** → 跨 Region 引用多 → 扫描开销大 → **缩减年轻代**（减少 GC 时间）
- **RSet 很小** → 跨 Region 引用少 → 扫描开销小 → **扩容年轻代**（提高吞吐量）

G1YoungRemSetSamplingThread 在 GC 之间空闲时采样 RSet 大小，为下次 Young GC 的决策提供数据。

```
★★★ G1YoungRemSetSamplingThread::run_service() (g1YoungRemSetSamplingThread.cpp:53-74):

void G1YoungRemSetSamplingThread::run_service() {
  double vtime_start = os::elapsedVTime();

  while (!should_terminate()) {
    sample_young_list_rs_lengths();  // ★ 采样 RSet 大小
    // ...
    sleep(G1ConcRefinementServiceIntervalMillis);  // 默认 300ms
  }
}

★★★ sample_young_list_rs_lengths() (g1YoungRemSetSamplingThread.cpp:118-145):

  → 遍历所有 collection set 中的 Region
  → 对每个 Region:
      size_t rs_length = r->rem_set()->occupied();  // ★ 读 RSet 的 occupied 值 (整数!)
  → 汇总后调用:
      g1p->revise_young_list_target_length_if_necessary(rs_length);
      // ↑ 更新 G1CollectorPolicy 的 _young_list_target_length 建议值

★★★ occupied() 的计算 (heapRegionRemSet.cpp:531-536):

  size_t OtherRegionsTable::occupied() const {
    return occ_fine() + occ_coarse() + occ_sparse();
    //     ↑ PerRegionTable BitMap _occupied 字段的累加和
    //     ↑ _n_coarse_entries * CardsPerRegion
    //     ↑ SparsePRT 中存储的 card 数量
  }
```

**★ 这是纯整数统计，不碰对象引用。**

### 5.1 ★ NonJavaThread 分类理由

```
G1YoungRemSetSamplingThread 全程只做:

  1. 读 HeapRegion::rem_set()->occupied() → size_t (纯整数)
  2. 调用 G1CollectorPolicy::revise_young_list_target_length_if_necessary()
  3. 更新 _young_list_target_length (一个 size_t)

  ★ 不碰 Java 对象引用
  ★ 不读 Java 堆上的对象数据
  ★ 只做统计分析 → 决策留给下次 Young GC 的 VMThread

  → 永远不需要 safepoint 保护
  → threadObj() == NULL (无 Java 层线程身份)
```

### 5.2 数据流全景

```
G1YoungRemSetSamplingThread (NonJavaThread, cgc_thread):
  
  ┌─────────────────────────────────────────────────────────────┐
  │ 每 300ms:                                                    │
  │   sample_young_list_rs_lengths()                            │
  │     → 遍历 Region → r->rem_set()->occupied() (size_t)       │
  │     → revise_young_list_target_length_if_necessary()        │
  │       → 更新 _young_list_target_length (建议值)              │
  └─────────────────────────────────────────────────────────────┘
                              ↓
                    等待下一次 Young GC:
                              ↓
  ┌─────────────────────────────────────────────────────────────┐
  │ VMThread (JavaThread, STW):                                 │
  │   G1CollectorPolicy::calculate_young_list_target_length()   │
  │     → 读 _young_list_target_length (采样线程提供的建议值)     │
  │     → 结合当前堆状态做最终决策                                │
  └─────────────────────────────────────────────────────────────┘

★ 关键: 采样线程是"建议者"，VMThread 是"决策者"。
  采样线程的数据可能"过时"（GC 可能已经改变了 RSet），但不影响正确性 —
  calculate_young_list_target_length() 会用自己的数据验证建议值。
```

---

## §六 ★ 对称对比线 — NonJavaThread 的自由哲学

### 6.1 ★ 正面：为什么这些线程是 NonJavaThread

```
┌────────────────────────┬──────────────────────────────────────────────────┐
│ 线程                    │ NonJavaThread 的精确理由                          │
├────────────────────────┼──────────────────────────────────────────────────┤
│ WatcherThread          │ ① PeriodicTask 回调只访问 C heap 数组 + 计数器     │
│                        │ ② VMError 看门狗必须在 crash 后仍然运行             │
│                        │ ③ "时间精准 > 堆访问权"                            │
├────────────────────────┼──────────────────────────────────────────────────┤
│ G1ConcurrentMarkThread │ ① 纯并发阶段只碰 SATB 队列(C heap) + bitmap(独立mmap)│
│                        │ ② 可能碰 Java 堆的 Reference 处理在 STW Remark 完成 │
│                        │ ③ 碰堆操作 → STW 安全，纯并发阶段 → NonJavaThread 安全 │
├────────────────────────┼──────────────────────────────────────────────────┤
│ G1ConcurrentRefineThr  │ ① 只读写 card 值 + 计算 card_idx (纯整数)          │
│                        │ ② 更新 RSet = 在 CHeapBitMap 中设置 bit            │
│                        │ ③ card_idx 只依赖地址偏移 → GC compact 不影响       │
├────────────────────────┼──────────────────────────────────────────────────┤
│ G1YngRemSetSamplThr    │ ① 只读 RSet::occupied() → size_t (纯整数)          │
│                        │ ② 只更新 size_t 建议值 → 决策留给 VMThread          │
│                        │ ③ 全程不碰 Java 对象引用                           │
└────────────────────────┴──────────────────────────────────────────────────┘
```

### 6.2 ★ 反面：有没有 NonJavaThread 实际碰了堆？

**有！G1ConcurrentMarkThread 的 Reference 发现阶段。**

```
但这不违反 NonJavaThread 的规则，因为:

  1. Reference 发现在 mark_from_roots() 的尾部 — preclean() 阶段
  2. preclean() 是"预清理" — 只排空 SATB side queue，不处理最终引用
  3. 真正的引用处理在 weak_refs_work() — STW Remark 阶段
  4. 如果 concurrent preclean 期间发现 Reference 对象被 GC 移动了
     → 并发标记线程会检测到 oop 失效 → 标记被中断 → 重来
     → 下次 Remark 中安全处理

  总结: 不是 "完全不碰堆"，而是 "碰堆时做好了异常处理，
       真正危险的操作移到 STW 阶段"。
```

### 6.3 ★ 核心对比：WatcherThread(NonJavaThread) vs CompilerThread(JavaThread)

这是 [09 §四] 的完整对称版 — 从 NonJavaThread 侧完整论证：

```
┌──────────────────────┬───────────────────────┬───────────────────────────┐
│ 维度                   │ WatcherThread         │ CompilerThread            │
│                       │ (NonJavaThread)       │ (JavaThread)              │
├──────────────────────┼───────────────────────┼───────────────────────────┤
│ 访问 Java 堆           │ 否 — PeriodicTask     │ ★ 是 — InstanceKlass/     │
│                       │ 数组+计数器全在 C heap │ ConstantPool/MethodData   │
│ safepoint 行为         │ 不受影响 — 继续 Tick   │ 被暂停 — 编译被卡住         │
│ _thread_list (JavaThread)│ 否 — 在 NonJavaThread│ ★ 是 — ThreadSMR 保护     │
│                       │ 自有的 _the_list 上    │                          │
│ NonJavaThread::_the_list│ ★ 是 — 自有链表+迭代器│ 否                        │
│ threadObj()            │ NULL                  │ 非 NULL (java.lang.Thread)│
│ JavaThreadState        │ 无                    │ volatile thread_state    │
│ active_handles()       │ ★ 有, run()中显式分配  │ 有, 构造时分配             │
│ Java 栈帧              │ 无                    │ 有 (解释器/C1/C2 帧)      │
│ OS ThreadType          │ watcher_thread        │ compiler_thread           │
│ stack_size             │ 1MB                   │ 4MB                       │
│ 挂了                   │ PeriodicTask 停摆      │ 纯解释 → 慢但不崩溃        │
│                       │ + VMError 看门狗缺失    │                          │
└──────────────────────┴───────────────────────┴───────────────────────────┘

★ 设计哲学 (双重理由):
  1. "时间精准": 对 PeriodicTask 来说, 10ms Tick 的精准性比堆访问权更重要。
     如果 WatcherThread 是 JavaThread → GC 期间被暂停 → 定时任务不准
     → 偏向锁延迟启用 / JFR 采样 / 低内存检测全部受影响。
  
  2. "崩溃安全": WatcherThread 的 VMError 看门狗职责 —
     如果 JVM 崩溃后 WatcherThread 也停在 safepoint → 无人 timeout kill JVM
     → 进程 hang 在 crash 状态。所以它必须是 NonJavaThread，永远不被暂停。
```

### 6.4 ★ 如果让 WatcherThread 继承 JavaThread → 后果推演

```
灾难1 — GC 期间 PeriodicTask 全部停摆:
  - safepoint 暂停 200ms → WatcherThread 停在 safepoint
  - 这 200ms 内没有 PeriodicTask Tick
  - 偏向锁延迟启用的 4 秒计时器被拉长 → 偏向锁启用延迟
  - JFR 采样漏掉 200ms → 火焰图失真

灾难2 — VM crash 后无人兜底:
  - JVM 在 GC 中 crash
  - WatcherThread 此时正停在 safepoint → 永远醒不来
  - VMError::report_and_die() 卡住 (disk full / NFS hang)
  - 没有人检查 check_timeout()
  - 进程 hang 在 crash 状态 → 运维自动拉起失效 → 服务不可用

反例验证: 为什么 CompilerThread 可以是 JavaThread?
  - 编译慢了 → C1 解释执行 → 功能正确，只是性能退化
  - 不会导致系统级 hang
  → "性能退化" vs "系统崩溃" → 设计者选择了正确的父子类归属
```

---

## §七 死亡后果分析

### ❓ 4 条 NonJavaThread 各自挂了有什么影响？

```
┌────────────────────────┬──────────┬───────────────────────────────────────┐
│ 线程                    │ 严重级别   │ 后果分析                              │
├────────────────────────┼──────────┼───────────────────────────────────────┤
│ WatcherThread          │ ☠ 致命   │ ★ 间接致命:                            │
│                        │ (间接)    │   ① PeriodicTask 全部停摆              │
│                        │          │      → 偏向锁延迟启用失效               │
│                        │          │      → StringTable 定期清理停止         │
│                        │          │      → JFR 采样停止                    │
│                        │          │   ② VMError 看门狗缺失                  │
│                        │          │      → crash 后可能 hang               │
│                        │          │   ③ 不直接 crash → 功能退化而非挂掉      │
├────────────────────────┼──────────┼───────────────────────────────────────┤
│ G1ConcurrentMarkThread │ ⚠ 退化   │ ① 并发标记停摆 → Mixed GC 不触发        │
│                        │ (功能)    │ ② 回收不了老年代 → heap 占用上升        │
│                        │          │ ③ 最终 → Full GC (STW, 秒级暂停)       │
│                        │          │ ④ 吞吐量严重退化 → 但不 crash           │
├────────────────────────┼──────────┼───────────────────────────────────────┤
│ G1ConcurrentRefineThr  │ ⚠ 退化   │ ① RSet 不更新 → dirty card 堆积         │
│ × N                    │ (性能)    │ ② Young GC: RSet 不完整 → 扫描更慢     │
│                        │          │ ③ GC 暂停时间增长 → 不影响正确性         │
│                        │          │ ④ 队列满后 Mutator 也会参与处理 → 但     │
│                        │          │   Mutator 是 JavaThread → STW 暂停期间  │
│                        │          │   无法处理 → 延迟累积                    │
├────────────────────────┼──────────┼───────────────────────────────────────┤
│ G1YngRemSetSamplThr    │ ⚠ 退化   │ ① RSet 采样停止 → _young_list_target   │
│                        │ (精度)    │    _length 不再更新                    │
│                        │          │ ② 年轻代大小决策失准                    │
│                        │          │    → 可能太小(吞吐量下降)               │
│                        │          │    → 或太大(GC 暂停变长)               │
│                        │          │ ③ 自适应调优失效 → 但不 crash           │
└────────────────────────┴──────────┴───────────────────────────────────────┘

★ 对比: VMThread 挂了 → JVM 直接死 [07 §五]
★ 对比: WorkerThread 挂了 → GC hang [08 §五]
```

---

## §八 GDB 验证 + 可证伪断言

> **验证环境**：
> ```bash
> JAVA=/data/workspace/openjdk-cut-new/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java
> gdb --args $JAVA -Xms8g -Xmx8g -XX:+UseG1GC -cp /data/workspace/demo/src com.wjcoder.Main
> ```

### 断言 1 — 验证 NonJavaThread 的 threadObj() == NULL

```gdb
(gdb) break WatcherThread::run
(gdb) continue
(gdb) p this->threadObj()
# 预期: (oop)0x0 或 NULL
(gdb) p this->is_Java_thread()
# 预期: false
```

### 断言 2 — 验证 JavaThread 的 threadObj() != NULL

```gdb
(gdb) p main_thread->threadObj()
# 预期: 非 NULL (有效的 oop 地址)
(gdb) p main_thread->is_Java_thread()
# 预期: true
```

### 断言 3 — 验证 WatcherThread 不参与 safepoint 协议

```gdb
(gdb) break WatcherThread::sleep
(gdb) continue
# 检查 thread.cpp:1496-1498 注释原文:
# "The WatcherThread does not participate in the safepoint protocol
#  for the PeriodicTask_lock because it is not a JavaThread."
(gdb) p this->is_Java_thread()
# 预期: false
(gdb) p PeriodicTask_lock->_safepoint_check_required
# 预期: false (因为用了 _no_safepoint_check_flag)
```

### 断言 4 — 验证 WatcherThread 不在 _thread_list 上

```gdb
# 遍历 Threads::_thread_list，验证没有 "VM Periodic Task Thread"
(gdb) set $t = Threads::_thread_list
(gdb) set $found = 0
(gdb) while $t != 0
 >if strcmp((char*)$t->name(), "VM Periodic Task Thread") == 0
 >  set $found = 1
 >  printf "FOUND on _thread_list: %s\n", (char*)$t->name()
 >end
 >set $t = $t->_next
 >end
(gdb) p $found
# 预期: 0 (WatcherThread 不在 _thread_list 上)
```

### 断言 5 — 验证 WatcherThread 在 _the_list 上

```gdb
# 遍历 NonJavaThread::_the_list，验证 WatcherThread 在其中
(gdb) set $t = NonJavaThread::_the_list._head
(gdb) while $t != 0
 >printf "NonJavaThread: %s, is_Watcher=%d\n", (char*)$t->name(), $t->is_Watcher_thread()
 >set $t = $t->_next
 >end
# 预期: 至少有一行 is_Watcher=1
```

### 断言 6 — 验证 WatcherThread 在构造函数中自启动

```gdb
(gdb) break WatcherThread::WatcherThread
(gdb) run ...
# 预期: 在 create_vm 尾部触发 1 次
(gdb) p this->_watcher_thread
# 预期: 在构造函数返回前 os::start_thread 已被调用
```

### 断言 7 — 验证 G1ConcurrentMarkThread 的 ThreadType

```gdb
(gdb) break G1ConcurrentMarkThread::run_service
(gdb) continue
(gdb) p this->osthread()->thread_type()
# 预期: os::cgc_thread (枚举值)
(gdb) p this->osthread()->thread_type() == os::java_thread
# 预期: false
(gdb) p this->threadObj()
# 预期: NULL
```

### 断言 8 — 验证 G1ConcurrentRefineThread 数量

```gdb
(gdb) p G1ConcRefinementThreads
# 预期: 非 0 (默认 = ParallelGCThreads)

# 遍历 NonJavaThread::_the_list 统计名称含 "G1 Refine" 的线程:
(gdb) set $t = NonJavaThread::_the_list._head
(gdb) set $count = 0
(gdb) while $t != 0
 >if strstr((char*)$t->name(), "G1 Refine") != 0
 >  set $count = $count + 1
 >  printf "Found: %s\n", (char*)$t->name()
 >end
 >set $t = $t->_next
 >end
(gdb) printf "Total G1 Refine threads: %d\n", $count
# 预期: $count == G1ConcRefinementThreads
```

### 断言 9 — 验证 NonJavaThread 有 JNIHandleBlock

```gdb
(gdb) break WatcherThread::run
(gdb) continue
# 在此断点暂停后:
(gdb) p this->active_handles()
# 预期: 非 NULL (WatcherThread::run() 第一行分配了 JNIHandleBlock)
# ★ 这说明 active_handles() 是 Thread 基类方法, 不是 JavaThread 专有!
# 对比 JavaThread: active_handles() 在构造时分配
# 对比 WatcherThread: active_handles() 在 run() 入口分配 (thread.cpp:1557)
```

### 断言 10 — 验证 NonJavaThread stack 有 OS guard page

```gdb
(gdb) p os::Linux::default_guard_size(os::watcher_thread)
# 预期: page_size() (4096 on Linux x86_64)
(gdb) p os::Linux::default_guard_size(os::java_thread)
# 预期: 0 (JavaThread 用自己的 guard page 机制)
# 源码: os_linux.cpp:3585-3589
```

### 断言 11 — 验证 ConcurrentMark 的 bitmap 不在 Java 堆

```gdb
(gdb) break G1ConcurrentMark::mark_from_roots
(gdb) continue
# 在此断点:
(gdb) ptype this->_prevMarkBitMap
# 预期: type = class G1CMBitMap { ... } (值类型成员，不是指针)
# G1ConcurrentMark 继承 CHeapObj<mtGC> → 整个对象在 C heap
# _prevMarkBitMap 作为成员也在 C heap 分配
(gdb) p &_prevMarkBitMap
# 预期: 地址在 C heap 范围，不在 Java 堆 (可通过 pmap 验证)
(gdb) p _prevMarkBitMap._bm
# 预期: BitMapView, 底层指针指向 G1RegionToSpaceMapper 分配的 mmap 区域
# 验证: 该指针指向的地址不是 Java 堆地址
(gdb) p _prevMarkBitMap._covered
# 预期: MemRegion 描述堆范围 (what to cover, not where bitmap lives)
```

### 断言 12 — 验证 WatcherThread 在 GC 期间继续运行

```gdb
# 在 WatcherThread::run 的 PeriodicTask::real_time_tick 之前打 log 断点:
(gdb) break PeriodicTask::real_time_tick
(gdb) commands
 >silent
 >printf "real_time_tick called at GC=%d\n", SafepointSynchronize::is_at_safepoint()
 >continue
 >end
(gdb) continue
# 预期: 即使在 safepoint 期间 (is_at_safepoint()==true)，
#       real_time_tick 仍然被调用 (WatcherThread 不会被 safepoint 阻止)
#       证明 NonJavaThread 不受 safepoint 影响
```

---

## §九 总结

### 7 个 NonJavaThread 速查

| 线程 | 类型 | 可替代？ | 挂了？ |
|------|------|---------|--------|
| VMThread | vm_thread | 否 — 单线程是设计优势 | ☠ 致命 — JVM 直接死 |
| WorkerThread × N | pgc_thread | 数量可调 (ParallelGCThreads) | ☠ 致命 — GC hang |
| WatcherThread | watcher | 否 — 否则定时不准 | ☠ 致命 (间接) — watchdog 缺失 |
| G1ConcurrentMarkThread | cgc_thread | 否 — 并发标记唯一调度者 | ⚠ 退化 — Full GC 频率上升 |
| G1ConcurrentRefineThr × N | cgc_thread | 数量可调 (G1ConcRefinementThreads) | ⚠ 退化 — GC 暂停变长 |
| G1YngRemSetSamplThr | cgc_thread | 否 — 年轻代自适应依赖它 | ⚠ 退化 — 调优失准 |

### 核心设计洞察

1. **"堆访问权 = safepoint 的负担"** — 这是 NonJavaThread 分类的充要条件
2. **WatcherThread 的双重理由**: "时间精准" + "崩溃安全" — 比 CompilerThread 对时间复杂度更敏感
3. **G1ConcurrentMarkThread 的精确边界**: "纯并发阶段不碰堆，碰堆的 Reference 在 STW 完成"
4. **卡索引的永恒稳定性**: `card_idx = (addr - base) / 512` — GC compact 不改变映射
5. **NonJavaThread 有自己的链表**: `_the_list` 与 `_thread_list` 分离 — jstack 看不到，但 pstack 能看到
6. **ThreadType 决定物理属性**: 栈大小、guard page、OS 调度类 — 都由 `os_linux.cpp` 中 `ThreadType` 的 switch 分支决定

> 📎 **下一篇**：[11-JVM-AttachListener.md] — JVM AttachListener 机制
> 📎 **交叉引用**：[06-ThreadOverview] 线程分类全景 | [07-VMThread] VMThread 单线程大脑 | [08-WorkerThread] WorkerThread 并行军团 | [09-JavaThread] 10 个系统 JavaThread
