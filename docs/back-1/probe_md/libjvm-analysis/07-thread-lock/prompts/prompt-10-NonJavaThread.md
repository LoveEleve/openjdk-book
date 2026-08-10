# PROMPT: 请撰写 10-JVM-NonJavaThread.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**"不需要 safepoint 的自由" — WatcherThread + G1 Concurrent 线程全景与 NonJavaThread 分类理由**

### 核心故事线（禁止做源码翻译机！）

前六篇文章 [04][05][06][07][08][09] 已经覆盖了锁膨胀全链路、线程生命周期、线程架构全景、VMThread 事件循环、WorkerThread 并行军团、10 个系统 JavaThread。现在要回答最后一个体系级问题：**JVM 内部还有哪些线程永远不需要被 safepoint 暂停？凭什么？**

在 [09 §四] 中我们建立了核心认知——「堆访问权 = safepoint 的负担」。CompilerThread 需要读 InstanceKlass/MethodData（在 Java 堆上），所以被迫继承 JavaThread。那么**反过来**，哪些线程不需要访问 Java 堆，可以享受"永远不被 GC 暂停"的自由？

**本文的核心叙事线**是一条对称追问链：

1. **WatcherThread 凭什么归 NonJavaThread？**— [09 §四] 只讲了 CompilerThread 侧的理由，本文从 WatcherThread 侧完整回答
2. **WatcherThread 的 PeriodicTask 调度机制是什么？**— 10ms 粒度定时器如何做到不依赖 OS timerfd？如何在 GC 期间仍然精准触发回调？
3. **G1ConcurrentMarkThread 为什么是 NonJavaThread？**— 它读 SATB 队列、遍历标记位图（C heap），不碰 Java 堆上的对象？真的完全不碰吗？并发标记中的"引用发现"阶段需要访问 Reference 对象链——这算不算"访问 Java 堆"？
4. **★ G1 Concurrent Refinement 线程凭什么不怕 GC？**— 精炼线程读写 DirtyCardQueue 和 RSet（都在 C heap），但 RSet 中的 PRT (PerRegionTable) 指向的卡表在 Java 堆上。精炼线程不关心 GC 是否移动对象——为什么？
5. **G1YoungRemSetSamplingThread 为什么存在？**— 它的输出直接影响年轻代大小（G1NewSizePercent / G1MaxNewSizePercent 之间的决策）。它是一个采样器，不是一个驱动器。threadObj() 返回 NULL → 没有 Java 层线程身份。

### 禁止行为

- ❌ 把 4 条 NonJavaThread 写成"定义 + 用途"的流水账
- ❌ 罗列函数调用链不解释设计意图
- ❌ 忽略"G1ConcurrentMarkThread 真的完全不碰 Java 堆吗"这个边界问题
- ❌ 忽略 NonJavaThread 的 OS 层面特征（无 JNIHandleBlock, 无 threadObj, 无 Java 栈帧）

### 要求行为

- ✅ 每条线程回答 6 个问题：创建入口(文件:行号)、调度循环、线程状态机、不碰堆证明(或碰堆的边界)、死亡后果、分类理由
- ✅ **★ 对称对比线**：WatcherThread(NonJavaThread) vs CompilerThread(JavaThread) — 从 NonJavaThread 侧完整论述"不需要访问 Java 堆 = 不需要被 GC 暂停"
- ✅ **★ G1 并发线程是否真的不碰 Java 堆？边界分析**：标记位图(bitmap)在 C heap，SATB 队列在 C heap，但 Reference 发现阶段需要读 Java 堆上的 Reference 对象 → 这怎么处理？
- ✅ **★ PeriodicTask 调度机制全链路**：enroll → disenroll → 10ms 定时 Tick → 回调执行 → 如何做到 GC 期间也不丢 Tick
- ✅ **★ RSet 精炼线程的"堆无关"证明**：DirtyCardQueueBuffer 在 thread-local C heap，PRT 卡索引在 C heap，卡表页在 Java 堆（但地址固定）→ GC 移动对象不影响卡索引有效性
- ✅ 全链路 GDB 验证（threadObj() == NULL 断言 + OSThread::thread_type() 验证 + jstack 对照）
- ✅ 交叉引用 [06][07][08][09] 的相关概念

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 默认 mixed mode（Tiered Compilation 开启）
- 64 位 Linux x86
- ★ G1 并发线程数量取决于并行度：`G1ConcRefinementThreads`（默认 = `ParallelGCThreads`）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | `NonJavaThread`, `NamedThread`, `WatcherThread` | ★ 所有 NonJavaThread 的类定义 + 继承链 |
| 2 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | `WatcherThread::WatcherThread()`, `WatcherThread::start()`, `WatcherThread::run()`, `WatcherThread::sleep()` | ★ PeriodicTask 调度循环 + sleep 实现 |
| 3 | `task.hpp/.cpp` | `src/hotspot/share/runtime/` | `PeriodicTask`, `PeriodicTask_lock`, `real_time_tick()`, `execute_if_pending()` | ★ enroll/disenroll + 静态数组 _tasks[] + 10ms tick |
| 4 | `concurrentGCThread.hpp/.cpp` | `src/hotspot/share/gc/shared/` | `ConcurrentGCThread` | ★ G1 并发线程的基类 |
| 5 | `g1ConcurrentMarkThread.hpp/.cpp` | `src/hotspot/share/gc/g1/` | `G1ConcurrentMarkThread`, `run()`, `ConcurrentGCTimer` | ★ 并发标记调度循环 + tracing 循环 |
| 6 | `g1ConcurrentMark.hpp/.cpp` | `src/hotspot/share/gc/g1/` | `G1ConcurrentMark` | 并发标记引擎 — SATB 队列 + bitmap + remark |
| 7 | `g1ConcurrentRefineThread.hpp/.cpp` | `src/hotspot/share/gc/g1/` | `G1ConcurrentRefineThread`, `run()` | ★ RSet 精炼主循环 |
| 8 | `g1RemSet.hpp/.cpp` | `src/hotspot/share/gc/g1/` | `G1RemSetSummary`, `G1ConcurrentRefine` | RSet 数据结构 + 精炼控制 |
| 9 | `g1YoungRemSetSamplingThread.hpp/.cpp` | `src/hotspot/share/gc/g1/` | `G1YoungRemSetSamplingThread` | ★ 记忆集采样线程 |
| 10 | `dirtyCardQueue.cpp/.hpp` | `src/hotspot/share/gc/g1/` | `DirtyCardQueueSet`, `DirtyCardQueue` | ★ 脏卡队列（精炼线程的数据源） |
| 11 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `os::create_thread()` | ThreadType 映射 — `watcher_thread` vs `cgc_thread` |
| 12 | `os.cpp` | `src/hotspot/share/runtime/os.cpp` | `os::create_thread()` | ThreadType 枚举值 |

## 四、必须深度走读的核心概念

### 4.1 NonJavaThread 体系总览 — 7 个内部守护者

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        7 个 NonJavaThread 全景                          │
├────────────────────┬──────────────────┬─────────┬───────────────────────┤
│ 线程名(jstack无Java标识)│ 创建时机         │ 线程类型 │ 死了后果              │
├────────────────────┼──────────────────┼─────────┼───────────────────────┤
│ VMThread           │ create_vm        │ vm      │ JVM dead [07]        │
│ WorkerThread × N   │ GC 初始化 [08]    │ pgc     │ GC hang [08]         │
│ WatcherThread      │ create_vm 尾      │ watcher │ PeriodicTask停摆      │
│                    │                  │         │ + VMError看门狗缺失   │
│ G1ConcMarkThread   │ G1 GC 初始化      │ cgc     │ 并发标记永不触发       │
│ G1ConcRefineThr×N  │ G1 GC 初始化      │ cgc     │ RSet不更新→扫描变慢   │
│ G1YngRemSetSamplThr│ G1 GC 初始化      │ cgc     │ 年轻代大小决策失准     │
└────────────────────┴──────────────────┴─────────┴───────────────────────┘

★ 本文聚焦后 4 条（VMThread[07] + WorkerThread[08] 已覆盖）
★ G1ConcurrentRefineThread 数量 = G1ConcRefinementThreads (默认=ParallelGCThreads)
★ 所有 NonJavaThread 的共同特征:
   - threadObj()==NULL (无 java.lang.Thread 身份)
   - 无 Java 栈帧 (不执行字节码)
   - 不被 safepoint 暂停 (没有 ThreadSafepointState)
   - 有独立的线程链表: NonJavaThread::_the_list + NonJavaThread::Iterator
     (与 JavaThread 的 Threads::_thread_list 分离管理，
      但共同存在于 OS 层面 — top -H 和 pstack 都能看到)
★ 注意: WorkerThread(G1 GC 并行 Worker) 使用 pgc_thread (Parallel GC thread),
  不是 cgc_thread (Concurrent GC thread)
```

### 4.2 ★ 核心对比线 — WatcherThread(NonJavaThread) vs CompilerThread(JavaThread)

```
这是 [09 §四] 的完整对称版 — 从 NonJavaThread 侧完整论述:

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
│ active_handles()       │ ★ 有(JNIHandleBlock)  │ 有 (JNIHandleBlock)      │
│                       │ run()中显式分配        │ 构造时分配               │
│ Java 栈帧              │ 无                    │ 有 (解释器/C1/C2 帧)      │
│ OS ThreadType          │ watcher_thread        │ compiler_thread           │
│ stack_size             │ ~512KB                │ 4MB                       │
│ 挂了                   │ PeriodicTask 停摆      │ 纯解释 → 慢但不崩溃        │
│                       │ + VMError 超时无看门狗  │                          │
└──────────────────────┴───────────────────────┴───────────────────────────┘

★ 设计哲学 (双理由):
  1. "时间精准": 对 PeriodicTask 来说, 10ms Tick 的精准性比堆访问权更重要。
     如果 WatcherThread 是 JavaThread → GC 期间被暂停 → 定时任务不准
     → 偏向锁延迟启用 / JFR 采样 / 低内存检测全部受影响。
  
  2. "崩溃安全": WatcherThread 的 VMError 看门狗职责——
     如果 JVM 崩溃后 WatcherThread 也停在 safepoint → 无人 timeout kill JVM
     → 进程 hang 在 crash 状态。所以它必须是 NonJavaThread，永远不被暂停。
```
```

### 4.3 WatcherThread — PeriodicTask 定时调度器 + VMError 看门狗

```
★★★ WatcherThread::run() — PeriodicTask 调度循环 (thread.cpp:1553-1612):

WatcherThread::run():
  this->set_active_handles(JNIHandleBlock::allocate_block());  // ← 有 JNIHandleBlock!
  while (true) {
    int time_waited = sleep();             // ★ 持有 PeriodicTask_lock 等待

    if (VMError::is_error_reported()) {
      // ★★ VMError 看门狗: JVM crash 后如果 hs_err 生成卡住, WatcherThread 负责超时终止
      for (;;) {
        if (VMError::check_timeout()) {
          os::die();                       // ← 强制 kill JVM, 避免 hang
        }
        os::naked_short_sleep(999);        // 每 1 秒重检
      }
    }

    if (_should_terminate) break;

    PeriodicTask::real_time_tick(time_waited);  // ★ 委托给 PeriodicTask 框架
  }

★★★ WatcherThread::sleep() — 持有 PeriodicTask_lock 的条件等待 (thread.cpp:1495-1551):

WatcherThread::sleep():
  // WatcherThread 不参与 safepoint 协议 (注释原文: "because it is not a JavaThread")
  MutexLockerEx ml(PeriodicTask_lock, Mutex::_no_safepoint_check_flag);

  if (_should_terminate) return 0;

  int remaining = PeriodicTask::time_to_wait();  // 所有任务中下次触发的最短时间
  int time_slept = 0;

  while (true) {
    bool timedout = PeriodicTask_lock->wait(     // ★ Monitor::wait(remaining) — 不是 ParkEvent::park!
                       Mutex::_no_safepoint_check_flag, remaining);
    jlong now = os::javaTimeNanos();

    if (remaining == 0) {                        // 无任务 → 无限等待 → 新 enroll 唤醒
      time_slept = 0;
    } else {
      time_slept = (int)((now - time_before) / 1000000);
    }

    if (timedout || _should_terminate) break;    // 正常超时 → 出去 Tick

    remaining = PeriodicTask::time_to_wait();    // 伪唤醒 → 重新计算剩余时间
    if (remaining == 0) continue;                // 任务被 disenroll → 重新 wait
    remaining -= time_slept;
    if (remaining <= 0) break;
  }
  return time_slept;

★ 关键认知:
  - sleep() 全程持有 PeriodicTask_lock — 不允许 safepoint check (不是 JavaThread)
  - GC 期间 WatcherThread 仍然每秒正常醒来 — PeriodicTask 时间精准
  - 使用 Monitor::wait() 而不是 PlatformEvent::park() — 这是"锁 + 条件变量"模型,
    park 是"信号量"模型, 两者底层虽然都到 pthread_cond_timedwait, 但锁定纪律完全不同
  - 无任务时 sleep() 会 block 无限长 (直到新任务 enroll 并 notify)

★★★ PeriodicTask 框架 — 静态数组 + 计数器 (task.hpp:39-108, task.cpp):

PeriodicTask 核心数据结构:
  enum { max_tasks = 10 };                    // ★ 硬限制: 最多 10 个 PeriodicTask!
  static int _num_tasks;                      // 当前已注册任务数
  static PeriodicTask* _tasks[max_tasks];     // ★ 静态数组, 不是链表!
  int _counter;                               // 累计等待时间
  const int _interval;                        // 触发间隔 (ms)

  enroll():
    { MutexLocker ml(PeriodicTask_lock);
      _tasks[_num_tasks++] = this;            // ★ 追加到数组尾部
      if (_num_tasks == 1 && WatcherThread::watcher_thread() != NULL)
        PeriodicTask_lock->notify();           // 唤醒正在无限等待的 sleep()
    }

  disenroll():
    { MutexLocker ml(PeriodicTask_lock);
      // 从 _tasks[] 中移除 (移动尾部元素填补空洞)
      _num_tasks--;
    }

  real_time_tick(int delay_time):             // ★ 由 WatcherThread::run() 调用
    { MutexLockerEx ml(PeriodicTask_lock, Mutex::_no_safepoint_check_flag);
      for (int i = 0; i < _num_tasks; i++) {
        _tasks[i]->execute_if_pending(delay_time);
      }
    }

  execute_if_pending(int delay_time):
    // ★ 注意: 不是 _counter >= _interval!
    // 使用 _counter + delay_time >= _interval (加法防止溢出后误触发)
    if (_counter + delay_time >= _interval) {
      _counter = 0;
      task();                                 // ★ 执行业务回调
    } else {
      _counter += delay_time;
    }

  time_to_wait():                             // 返回所有任务下次触发的最短等待时间
    int min_wait = max_interval;
    for (int i = 0; i < _num_tasks; i++)
      min_wait = MIN2(min_wait, _tasks[i]->time_to_next_interval());
    return min_wait;                          // 0 = 立即触发, >0 = 等 N ms

★★★ WatcherThread 创建 & 启动 — 构造函数自启动 (thread.cpp:1477-1493):

WatcherThread::WatcherThread():
  if (os::create_thread(this, os::watcher_thread)) {  // OS 线程创建
    _watcher_thread = this;
    os::set_priority(this, MaxPriority);               // 最高 OS 优先级
    if (!DisableStartThread) {
      os::start_thread(this);                          // ★ 构造函数中自启动!
    }
  }

WatcherThread::start() (thread.cpp:1614-1625):
  // 静态方法, create_vm 中通过 make_startable() 加 gate 控制
  if (watcher_thread() == NULL && _startable) {
    new WatcherThread();                    // ← 构造函数自启动, 此调用返回时线程已在运行
  }

★★★ ★★ VMError 看门狗 — WatcherThread 的非主责关键功能

  WatcherThread 有第二个关键职责: JVM crash 后的 hs_err 文件生成超时看门狗。
  
  场景: JVM 在 GC 中 crash → hs_err 文件生成卡住 (disk full / NFS hang)
       → 如果 WatcherThread 也是 JavaThread → 被 safepoint 暂停 → 永远醒不来
       → JVM 不会 exit → 进程 hang 在 crash 状态
  
  但 WatcherThread 是 NonJavaThread:
       → 不受 safepoint 影响
       → 每秒醒来检查 VMError::check_timeout()
       → 超时后调用 os::die() 强制 kill 进程
       → 不会出现 "crash 后 hang" 的情况
  
  ★ 这是 WatcherThread 必须是 NonJavaThread 的第二个深层理由:
    不只是 "时间精准", 还有 "崩溃安全"。

★★★ PeriodicTask 的延迟注册 & create_vm 初始化:

  create_vm 末尾 (thread.cpp:4320-4333):
    MutexLocker ml(PeriodicTask_lock);
    WatcherThread::make_startable();         // _startable = true
    if (PeriodicTask::num_tasks() > 0) {
      WatcherThread::start();               // 有预注册任务 → 立即启动
    }

  延迟注册场景 (不用在 create_vm 中预注册):
    - BiasedLocking::init(): 4 秒后注册 → 触发 notify 唤醒 sleep()
    - StringTable 清理: SafepointSynchronize::end() 中注册
    - JFR 采样: JFR 开启时注册
    - SafepointCleanupTask: 后台监控降级

  ★ max_tasks=10 的约束: 所有 PeriodicTask 合起来不超过 10 个,
    这个限制在 enroll() 中由 assert 保证 (超过 10 个触发 assert fail)
```

### 4.4 G1ConcurrentMarkThread — 并发标记调度线程

```
★★★ G1ConcurrentMarkThread::run_service() — 并发标记全周期 (g1ConcurrentMarkThread.cpp:248):

G1ConcurrentMarkThread::run_service():
  while (!should_terminate()) {
    sleep_before_next_cycle();                    // 等待 Initial Mark (Young GC) 唤醒
    
    ConcurrentGCTimer timer;
    // 阶段 1 — 初始标记 (STW, 由 VMThread 执行)
    // 阶段 2 — 根扫描 (并发, 由 ConcurrentMarkThread 调度)
    // 阶段 3 — 并发标记 (★ 本线程执行)
    //    G1ConcurrentMark::mark_from_roots()
    //      → 遍历 SATB 队列
    //      → 标记位图 (bitmap on C heap)
    //      → Reference 发现 (★ 边界: 需要读 Java 堆上的 Reference 对象!)
    // 阶段 4 — 再次标记 (STW, 由 VMThread 执行)
    // 阶段 5 — 清除 (并发, 由 ConcurrentMarkThread 调度)
    
    if (!completed) {
      // 标记被中断 (Young GC 抢占) → 重新开始
      continue;
    }
  }

★★★ 并发标记线程是否真的不碰 Java 堆？— 边界分析

  证据1 — 标记位图: 在 C heap 上
    G1CMBitMap (extends BitMap) → CHeapObj → ResourceObj
    → 分配在 C heap (mtGC)
    → 结论: 不碰 Java 堆 ✓

  证据2 — SATB 队列: 在 C heap 上
    SATBMarkQueue → PtrQueue → CHeapObj
    → 每个 JavaThread 的 SATB buffer 也在 thread-local C heap
    → 结论: 不碰 Java 堆 ✓

  ★ 证据3 — Reference 发现: 需要读 Java 堆 ← 边界!
    G1CMRefProcTaskExecutor 在并发标记的"引用发现"阶段需要:
    ① 遍历 ReferenceQueue → 在 Java 堆 (但队列头在 C++ 维护)
    ② 调用 ReferenceProcessor::process_discovered_references()
       → 读 pending list (在 C++ 维护的 oop 链表)
       → 设置 Reference 的 discovered 字段 (在 Java 堆)
    ③ 结论: ★ 实际会碰 Java 堆，但通过 oop 访问 — 如果标记期间发生并发
       Young GC，移动了 Reference 对象 → oop 失效 → 需要在 safepoint
       中完成引用处理! ★
    ④ 这一点在源码中由以下机制保证:
       - 并发标记的 Reference 发现阶段之前有一个 "remark" STW 暂停
       - remark 期间完成所有 pending Reference 的处理
       - 并发标记线程在 remark 阶段被暂停 (通过 safepoint 等待)
       → 所以并发标记线程在"真正"的并发阶段不会碰到 GC 正在移动的对象

  ★ 正确表述: G1ConcurrentMarkThread 在纯并发标记阶段不碰 Java 堆上的移动对象，
    所有可能碰 Java 堆的操作都在 STW Remark 阶段完成。
    这就是"为什么 ConcurrentMarkThread 可以是 NonJavaThread"的精确答案。

★★★ 为什么是 NonJavaThread?

  核心: 并发标记不是"不碰堆"，而是在 Remark 阶段把所有可能碰堆的操作完成了。
  纯并发标记阶段只碰:
  - SATB 队列 (C heap)
  - 标记位图 (C heap)
  - 类元数据 (Metaspace, 不是 Java 堆)
  → 不会遇到 GC 移动中的对象 → 不需要 safepoint 保护 → 可以是 NonJavaThread

  代价: 如果并发标记线程持有 stale oop → 在下次 safepoint 前不解除引用。
  约束: 并发标记线程不能在 safepoint 之间解除 oop 引用。
```

### 4.5 G1ConcurrentRefineThread — RSet 精炼线程

```
★★★ G1ConcurrentRefineThread::run_service() — RSet 精炼主循环 (g1ConcurrentRefineThread.hpp:58):

G1ConcurrentRefineThread::run_service():
  while (!_should_terminate) {
    // 等待 DirtyCardQueue 有数据
    DirtyCardQueueSet& dcqs = JavaThread::dirty_card_queue_set();
    
    if (!_active) {
      // Green zone: 后台空闲模式, 长 sleep
      wait_for_completed_buffers();
    }
    
    while (dcqs.apply_closure_to_completed_buffer(cl, ...)) {
      // ★ 核心: 处理一个 completed buffer (64 cards)
      // 每个 card (512B) → G1RemSet::refine_card():
      //   ① 读卡表: 卡对应的内存页是否被修改?
      //   ② 扫描卡: 找到跨 Region 引用的对象
      //   ③ 更新 RSet: 在目标 Region 的 PRT 中添加卡索引
      //   ④ 重复...
    }
  }

★★★ 精炼线程为什么不碰 Java 堆 (精确证明)

  DirtyCardQueue:
    _buf (void**): 指向 card address 的数组 — card 地址 = Java 堆地址
    _index: 当前消费位置
    → 卡地址本身在 Java 堆, 但只需要"读"就能判断 card 是否 dirty

  PerRegionTable (PRT):
    底层是 BitMap → CHeapObj
    → 存储的是"卡索引" (card index) — 不是 Java 对象指针
    → 卡索引是纯整数 (card_index = card_addr >> CardTable::card_shift)
    → GC 移动对象不影响卡索引的有效性 (因为卡索引是固定地址映射)

  ★ 所以精炼线程只读写:
    - 卡地址 (读 → 判断 dirty)
    - 卡索引 (整数 → 不依赖对象位置)
    - BitMap (C heap)
    → 完全不碰 Java 堆上的对象引用 → 永远不需要 safepoint 保护
```

### 4.6 G1YoungRemSetSamplingThread — 记忆集采样线程

```
★★★ G1YoungRemSetSamplingThread — 采样器而非驱动器

创建: G1CollectedHeap::initialize() → G1YoungRemSetSamplingThread::create()
循环 (G1YoungRemSetSamplingThread::run_service()):
  while (!_should_terminate) {
    sample_work();
    sleep(G1ConcRefinementServiceIntervalMillis);
  }

采样逻辑:
  sample_work():
    → 遍历所有 Region 的 RSet 大小
    → 统计 RSet 总大小 / 年轻代 Region 数 → 判断年轻代是否可以扩容
    → 更新 G1CollectorPolicy 的 _young_list_length 建议值

★ 为什么存在?
  年轻代大小在 G1NewSizePercent(5%) ~ G1MaxNewSizePercent(60%) 之间浮动。
  如果 RSet 很大 (跨 Region 引用多) → 缩减年轻代 (减少 GC 时间)
  如果 RSet 很小 → 扩容年轻代 (提高吞吐量)
  这个线程只是采样数据 → 等待下一次 Young GC 时由 G1CollectorPolicy 做决策。

★ 为什么是 NonJavaThread?
  完全不碰 Java 堆 — 只读 RSet 的 BitMap 大小 (整数) 和 Region 统计。
```

### 4.7 ThreadType 对照 — NonJavaThread 的 OS 层身份

```
★★★ os::create_thread() 中 ThreadType 决定线程栈大小 + 调度属性:

┌──────────────────────┬─────────────┬─────────────────┬────────────────────┐
│ 线程                  │ ThreadType   │ stack_size       │ guard page          │
├──────────────────────┼─────────────┼─────────────────┼────────────────────┤
│ VMThread             │ vm_thread   │ 1MB (默认)       │ page_size()        │
│ GC Worker Thread     │ pgc_thread  │ ~512KB           │ page_size()        │
│ G1ConcMarkThread     │ cgc_thread  │ ~512KB           │ page_size()        │
│ G1ConcRefineThread   │ cgc_thread  │ ~512KB           │ page_size()        │
│ G1YngRmSetSamplThrd  │ cgc_thread  │ ~512KB           │ page_size()        │
│ WatcherThread        │ watcher     │ ~512KB           │ page_size()        │
└──────────────────────┴─────────────┴─────────────────┴────────────────────┘

对比 JavaThread 体系 (见 [09 §1.3]):
  java_thread / compiler_thread: guard_size = 0 (使用 HotSpot 自身的 guard page)
  vm_thread / pgc_thread / cgc_thread / watcher_thread: guard_size = page_size()

★ 原因:
  - JavaThread 需要 HotSpot 自己的 GuardPage 机制 (栈溢出检测)
  - NonJavaThread 栈浅且安全 → 只需 OS 的 guard page
  - os_linux.cpp:3585-3590 的 default_guard_size() 注释说明了这个差异
```

## 五、文章结构

```
§〇 源文件清单（跨 runtime/gc-shared/gc-g1/os）
  → 搜索不到时回退到 source_index/ 索引
  → 注意: g1 目录下的文件在 source_index/06-gc.md 中索引

§一 NonJavaThread 体系全景 — 7 个内部线程总览
  ★ 开头即贴线程分类树 (从 thread.hpp 继承链开始)
  ❓ 为什么 JVM 需要 NonJavaThread？
  ❓ 所有 NonJavaThread 的共同特征 (threadObj()==NULL, 无 SafepointState, 无 JavaThreadState)
  ❓ jstack 看不到 NonJavaThread — 那怎么发现它们？
     → pstack/top -H + GDB Threads::number_of_threads() vs _thread_list 对比
  1.1 7 线程创建时机矩阵
  1.2 ThreadType 对照表 (vm/pgc/cgc/watcher 四种)
  1.3 ★ 对比 JavaThread: 堆访问权 vs 永不暂停的自由

§二 ★ WatcherThread — PeriodicTask 定时调度引擎
  ❓ 为什么是 NonJavaThread？— 从 "时间精准 > 堆访问权" 角度论述
  2.1 PeriodicTask 框架: enroll/disenroll/task()
  2.2 WatcherThread::run() 调度循环: 10ms sleep → Tick → 遍历链表
  2.3 ★ 延迟注册机制: BiasedLocking 4秒后注册 + StringTable 清理 + JFR
  2.4 ★ 为什么不用 OS timerfd? park/unpark vs timerfd 的设计权衡
  2.5 ★ 创建时机 + make_startable() + PeriodicTask_lock 保护

§三 G1ConcurrentMarkThread — 并发标记调度者
  ❓ 为什么不碰 Java 堆？★ 边界分析 — mark bitmap + SATB 队列在 C heap
  ❓ ★ Reference 发现阶段的边界: 碰了 → 但通过 STW Remark 完成
  3.1 G1ConcurrentMarkThread::run_service() 全周期
  3.2 并发标记 vs Remark — 为什么 Remark 必须是 STW
  3.3 ★ NonJavaThread 分类理由 — 精确到"纯并发阶段不碰堆, 碰堆在 STW 完成"
  3.4 与 VMThread 的分工: 并发标记线程只做"纯计算", VMThread 做"堆操作"

§四 G1ConcurrentRefineThread × N — RSet 精炼军团
  ❓ ★ 为什么不碰 Java 堆？— 卡地址 → 卡索引 → BitMap 整数 (全程无对象引用)
  4.1 run_service() 主循环: DirtyCardQueue → refine_card → PRT::add_reference
  4.2 ★ 卡索引的永恒稳定性: card = (addr >> 9) → GC 移动不改变这个映射
  4.3 Green/Yellow/Red Zone 三级精炼策略
  4.4 ★ NonJavaThread 分类理由 — 全程不持 heap reference

§五 G1YoungRemSetSamplingThread — 记忆集采样器
  ❓ 为什么存在？— 驱动年轻代自适应大小决策 (G1NewSizePercent ↔ G1MaxNewSizePercent)
  5.1 run_service() 循环: sample RSet sizes → 更新 policy
  5.2 ★ 数据流: RSet size (整数) → 决策建议 → G1CollectorPolicy 拍板
  5.3 ★ NonJavaThread 分类理由 — 只读整数统计, 不碰对象

§六 ★ 对称对比线完整版 — NonJavaThread 的自由哲学
  ❓ "不需要堆访问权" 是 NonJavaThread 分类的充要条件吗？
  6.1 ★ 正面: 为什么这些线程是 NonJavaThread
  6.2 ★ 反面: 有没有 NonJavaThread 实际碰了堆？(ConcurrentMarkThread 的 Reference 边界)
  6.3 ★ 设计哲学: "堆访问权 = safepoint 的负担" vs "即使碰堆也要在 STW 完成"
  6.4 ★ 如果让 WatcherThread 继承 JavaThread → 后果推演

§七 死亡后果分析
  ❓ 4 条 NonJavaThread 各自挂了有什么影响？
  7.1 致命（间接）: WatcherThread 挂了 → JVM crash 后 VMError 看门狗缺失
      → 如果 crash 发生于 critical 路径，无人强制 kill → 进程 hang
  7.2 功能退化: 并发标记停摆 → Full GC 频率上升 → 吞吐量退化
  7.3 性能退化: RSet 精炼停摆 → 扫描开销上升 → GC 暂停时间增长
  7.4 精度退化: RSet 采样停摆 → 年轻代大小决策失准 → 自适应调优失效
  ★ 注: VMThread 挂了 JVM 直接死 [07]、WorkerThread 挂了 GC hang [08]

§八 GDB 验证 + 可证伪断言（≥10 条, 每条含命令 + 预期值）

  断言 1 — 验证 NonJavaThread 的 threadObj() == NULL:
    (gdb) break WatcherThread::run
    (gdb) p threadObj()
    → 预期: NULL (或 0x0)
    (gdb) p is_Java_thread()
    → 预期: false

  断言 2 — 验证 JavaThread 的 threadObj() != NULL:
    (gdb) p main_thread->threadObj()
    → 预期: 非 NULL (有效的 oop 地址)

  断言 3 — 验证 WatcherThread 不参与 safepoint 协议:
    (gdb) break WatcherThread::sleep
    # 检查注释原文 (thread.cpp:1496-1497):
    # "The WatcherThread does not participate in the safepoint protocol
    #  for the PeriodicTask_lock because it is not a JavaThread."
    (gdb) p this->is_Java_thread()
    → 预期: false
    (gdb) p ((JavaThread*)this)  # 强制转换
    → 预期: 类型不匹配或编译警告 (NonJavaThread 不是 JavaThread 子类)

  断言 4 — 验证 WatcherThread 不在 _thread_list 上:
    (gdb) set $t = Threads::_thread_list
    (gdb) while $t != 0
     >if strcmp($t->name(), "VM Periodic Task Thread") == 0 → FAIL
    → 预期: 遍历全程不匹配 (WatcherThread 不在 list 上)

  断言 5 — 验证 WatcherThread 在构造函数中自启动:
    (gdb) break WatcherThread::WatcherThread
    → 启动 JVM → 预期: 在 create_vm 尾触发 1 次
    (gdb) p this->_watcher_thread
    → 预期: 在构造函数返回前已非 NULL (单例已注册)
    (gdb) p os::start_thread 被调用
    → 预期: 在构造函数内部, DisableStartThread=false 时调用

  断言 6 — 验证 G1ConcurrentMarkThread 的 ThreadType:
    (gdb) break G1ConcurrentMarkThread::run_service
    (gdb) p osthread()->thread_type()
    → 预期: os::cgc_thread (枚举值)
    (gdb) p osthread()->thread_type() == os::java_thread
    → 预期: false

  断言 7 — 验证 G1ConcurrentRefineThread 的线程数:
    (gdb) p G1ConcRefinementThreads
    → 预期: 非 0 (默认 = ParallelGCThreads)
    (gdb) p _thread_list 上是否出现 "G1 Refine"
    → 预期: 否 (NonJavaThread 不在 _thread_list)

  断言 8 — 验证 WatcherThread 在 GC 期间继续运行:
    (gdb) 在 WatcherThread::run 的 task->task() 打 log 断点
    → 预期: 在 SafepointSynchronize::begin 到 end 之间仍然有输出

  断言 9 — 验证 WatcherThread 显式分配了 JNIHandleBlock:
    (gdb) break WatcherThread::run
    (gdb) p this->active_handles()
    → 预期: 非 NULL (WatcherThread::run() line 1557 分配了 JNIHandleBlock)
    → ★ 这说明 active_handles() 是 Thread 基类方法, 不是 JavaThread 专有!
    → 对比 JavaThread: active_handles() 在构造时分配
    → 对比 WatcherThread: active_handles() 在 run() 入口分配

  断言 10 — 验证 NonJavaThread stack 有 OS guard page:
    (gdb) p os::Linux::default_guard_size(os::watcher_thread)
    → 预期: page_size() (4096)
    (gdb) p os::Linux::default_guard_size(os::java_thread)
    → 预期: 0 (JavaThread 用自己的 guard page 机制)

  断言 11 — 验证 ConcurrentMarkThread 的 bitmap 在 C heap:
    (gdb) break G1ConcurrentMark::mark_from_roots
    (gdb) p _prevMarkBitMap
    → 预期: G1CMBitMap* 指向 C heap 地址
    (gdb) p _prevMarkBitMap->size()
    → 预期: heap_size >> card_shift (bitmap 大小由堆决定, 但在 C heap 分配)
```

## 六、写作要求

1. **7 条 NonJavaThread 全枚举**: 本文覆盖除 VMThread[07] + WorkerThread[08] 外的 4 条（实为 WatcherThread + 3 种 G1 并发线程，每种 G1 并发线可能×N）
2. **6 问题标配**: 每条线程必须回答创建入口、调度循环、堆访问分析(碰不碰+边界)、死亡后果、分类理由
3. **★ 对称对比线**: WatcherThread(NonJavaThread) vs CompilerThread(JavaThread) — 完整的两侧论证
4. **★ G1 并发标记的 Reference 边界分析**: 这是全文最深的点 — 不能简单说"不碰堆"，要精确到"纯并发阶段不碰，碰堆的 Reference 处理在 STW Remark 阶段完成"
5. **★ PeriodicTask 延迟注册机制**: enroll/disenroll 如何自动管理 WatcherThread 的生命周期
6. **★ 卡索引永恒稳定性**: card index = address >> card_shift → GC 移动对象不改变 → 精炼线程永远不需要 safepoint
7. **代码精确性**: threadObj()==NULL, safepoint_state() 不存在, _thread_list 不含 NonJavaThread
8. **交叉引用**: [06] 继承链, [07] VMThread, [08] WorkerThread, [09] JavaThread — 形成完整的线程体系闭环

## 七、输出格式

- Markdown 文件，命名为 `10-JVM-NonJavaThread.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 [06][07][08][09] + 阅读收益）
