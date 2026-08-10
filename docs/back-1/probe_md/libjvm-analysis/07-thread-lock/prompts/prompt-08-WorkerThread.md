# PROMPT: 请撰写 08-JVM-WorkerThread.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**WorkerThread — JVM 的"GC 并行军团"：WorkGang 调度、Work Stealing 与 PLAB 局部化**

### 核心故事线（禁止做源码翻译机！）

上一篇文章 [07-VMThread] 讲了 JVM 最特殊的线程——单线程的 VMThread，所有 STW 操作必须串行执行。现在的问题是：**当 VMThread 发起了 GC，safepoint 达成，谁来执行 GC 的实际工作？**

答案不是 VMThread 自己——而是 **WorkerThread**，一群预先创建好的 GC 专用线程，由 `WorkGang` 统一管理。它们是 JVM 的"并行军团"：VMThread 是"将军"（下令、协调），WorkerThread 是"士兵"（并行执行）。这篇文章要回答的核心问题是：**为什么同是 NonJavaThread，WorkerThread 的设计和 VMThread 截然不同？**

本文要回答五个核心设计问题，每个都要有面试级深度：

1. **为什么 GC 需要并行线程？**— 为什么不让 VMThread 自己做完所有 GC 工作？和 VMThread 的单线程事件循环有什么本质区别？并行度由什么决定？
2. **WorkGang 怎么管理一群 Worker？**— Dispatcher 模式怎么工作？`run_task()` 怎么分派任务？怎么等所有人完成（barrier）？
3. **Work Stealing（工作窃取）是怎么实现的？**— 为什么需要偷任务？怎么偷？无锁 CAS 还是加锁？和 Cilk/Java ForkJoinPool 的 steal 有什么区别？
4. **PLAB / TLAB 怎么减少 GC 线程间的竞争？**— 没有 PLAB 会怎样？多线程 copy 对象到 Survivor Region 时怎么避免 CAS 竞争？
5. **Worker 挂了会怎样？**— 一个 Worker 处理 OOP 时 crash → GC 失败 → 整个 JVM 怎么办？

### 这篇文档的定位

它是 [07-VMThread] 之后的第二篇 **NonJavaThread 深度文章**。核心对比：VMThread 是单线程事件循环（串行模型），WorkerThread 是 WorkGang 并行调度（分治模型）。后续 [10-NonJavaThread] 也要以 WorkerThread 为参照。

### 禁止行为

- ❌ 把 C++ 源码逐行翻译成中文——这叫源码翻译机，没有任何设计洞察
- ❌ 罗列函数调用链（A调B、B调C…）——这不是分析，这是堆栈跟踪
- ❌ 复制粘贴大段源码却不解释"为什么这么设计"
- ❌ 写行号限定——深度自然会带出行数，浅薄写多长都是流水账

### 要求行为

- ✅ 每个关键设计决策都要问"为什么？"并从计算机科学原理层面回答
- ✅ 面试追问式分析——如果面试官追问"为什么不设计成…"，文档里应该有答案
- ✅ 概念映射——把 JVM 机制映射到通用 CS 概念（Work Stealing、Dispatcher/Barrier 模式、Locality Optimization）
- ✅ 交叉引用——标注哪些概念在 [05]/[07]/[11] 中有完整展开
- ✅ ★★★ 核心对比线：VS VMThread — "为什么不设计成 VMThread 那样？"

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（Region=4MB, 2048个）
- `ParallelGCThreads` = 默认（ncpus ≤ 8 ? ncpus : 8 + (ncpus-8)*5/8）
- 64 位 Linux x86

## 三、聚焦源文件

| 文件 | 类/函数 | 本文角色 | 行号 |
|------|------|------|------|
| `gc/shared/workgroup.hpp` | `WorkGang` / `AbstractGangTask` / `AbstractGangWorker` / `GangWorker` / `WorkData` | ★ 类定义 — Gang 结构 + Dispatcher | 全文件 |
| `gc/shared/workgroup.cpp` | `WorkGang::run_task()` / `initialize_workers()` / `stop()` / `GangWorker::loop()` / `wait_for_task()` / `signal_task_done()` | ★ 核心实现 — 调度 + worker 循环 | run_task():280, GangWorker::loop():378, wait_for_task():360, signal_task_done() |
| `gc/shared/taskqueue.hpp` | `GenericTaskQueue` / `OverflowTaskQueue` / `GenericTaskQueueSet` | ★ 无锁任务队列 — push/pop/steal 声明 | 全文件 |
| `gc/shared/taskqueue.inline.hpp` | `GenericTaskQueueSet::steal()` / `pop_global()` / `push()` | ★ steal 算法 — 无锁 CAS 实现 | steal():480, pop_global(), push() |
| `gc/g1/g1ParScanThreadState.hpp` | `G1ParScanThreadState` — `_plab_allocator` / `_lab` / `_term_attempts` | ★ G1 并行扫描状态 — PLAB + Termination | 全字段 |
| `gc/g1/g1ParScanThreadState.cpp` | `copy_to_survivor()` / `do_oop_evac()` | ★ G1 Young GC 实际工作 — 对象复制 | copy_to_survivor(), do_oop_evac() |
| `gc/g1/g1CollectedHeap.hpp` | `G1CollectedHeap::_workers` | ★ Worker 的创建入口 | _workers 字段 |
| `gc/g1/g1CollectedHeap.cpp` | `G1CollectedHeap::initialize()` | ★ `new WorkGang("GC Thread", ...)` + `initialize_workers()` | initialize():1874 |
| `gc/shared/workerManager.hpp` | `WorkerManager` | ★ 动态 Worker 数量管理 | 全文件 |
| `runtime/thread.hpp` | `WorkerThread` 类定义 + 继承链 | ★ Thread→NonJavaThread→NamedThread→WorkerThread | WorkerThread:858 |

## 四、必须深度走读的核心概念

> ★★★ **读码顺序铁律**（违反必翻车）：
> 1. 先读 `workgroup.hpp`（类定义、继承链、字段声明）→ 再读 `workgroup.cpp`（loop/wait/signal 实现）
> 2. 先读 `taskqueue.hpp`（GenericTaskQueue 字段 + push/pop/size 声明）→ 再读 `taskqueue.inline.hpp`（steal 的 CAS 实现）
> 3. 先读 `g1ParScanThreadState.hpp`（字段声明 + PLAB 成员）→ 再读 `g1ParScanThreadState.cpp`（copy_to_survivor 逻辑）
> 4. ★ 先验证函数存在再引用 — 禁止编造函数名（如"attempt_steal_task"这种不存在的函数）
> 5. ★ 先记录字段粒度再描述语义 — 读完 .hpp 后必须显式写下关键字段的存储粒度

### 4.1 设计动机 — ❓ 为什么不让 VMThread 自己做 GC？

```
┌─────────────────────────────────────────────────────────────────┐
│                    VMThread vs WorkerThread                     │
├─────────────────┬───────────────────┬───────────────────────────┤
│ 维度             │ VMThread (将军)    │ WorkerThread (士兵)       │
├─────────────────┼───────────────────┼───────────────────────────┤
│ 线程数           │ 1（全局唯一）      │ ParallelGCThreads (2-128) │
│ 调度模型         │ 事件循环 (FIFO)    │ WorkGang 分治并行         │
│ 粒度             │ VM_Operation 级别  │ 对象级别（卡/Region）      │
│ 创建时机         │ Threads::create_vm │ G1CollectedHeap::init    │
│ 生命周期         │ JVM 退出才终止     │ GC 期间活跃，GC 结束 idle  │
│ 失败影响         │ 单点故障 → JVM 死  │ 单个 crash → GC 失败/重试 │
│ 核心模式         │ 生产者-消费者      │ Master-Worker + Steal     │
└─────────────────┴───────────────────┴───────────────────────────┘

❓ 问题 1: GC 的并行化收益在哪？
   线索: Young GC 的 Evacuation (对象复制) 是 CPU-intensive — 需要遍历根集、
         扫描 CSet、复制活对象。8 核并行 → 理论上 8x 加速。
   → VMThread 单线程做 Young GC → 100GB 堆 = 数十秒 STW → 不可接受
   → 为什么不是线程池？→ WorkGang 的 thread-per-core 绑定 + 无锁 steal

❓ 问题 2: WorkerThread 和 VMThread 的本质区别？
   VMThread: "我自己决定做什么" — loop() + VMOperationQueue
   WorkerThread: "等着被分派任务" — loop() → wait_for_task() → work(i)
                 — 没有自己的队列（不取 VM_Operation），被动等 WorkGang 分配
   → 类比: VMThread = Node.js Event Loop; WorkerThread = ThreadPool + ForkJoin

❓ 问题 3: 为什么 Worker 数量是固定的而不是动态扩缩？
   线索: ① Worker 是 OS 线程 (clone syscall) — 创建/销毁有开销
         ② 每个 Worker 绑定 CPU 核心 — 切换会破坏 CPU cache locality
         ③ GC 是周期性突发工作 — burst 来时需要立刻响应，不能等线程创建
         ④ ParallelGCThreads = ncpus ≤ 8 ? ncpus : 8 + (ncpus-8)*5/8
            → 核心数越多，利用率越高，但不是线性增长（Amdahl 定律再次生效）

❓ 问题 4: Java 已有 ExecutorService / ForkJoinPool，JVM 为什么不复用标准线程池？
   线索: ① JVM 是 C++ 写的，不能直接调用 Java 标准库
         ② WorkGang 比通用线程池简单得多 — 没有超时、无拒绝策略、无队列上限
         ③ 核心差异在"同步模型":
            ForkJoinPool: task 持续异步提交 → 各自执行 → join() 等待结果
            WorkGang:     task 分派一次 → 所有 Worker 同步执行 → barrier 等全员完成
         ④ WorkGang 的假设是"GC 的 task 是整体性的" — 要么全体参与、要么全部 idle
            线程池的假设是"task 是独立的" — 提交一个、执行一个、完成一个
         ⑤ 如果复用线程池 → 需要额外 synchronization layer 来模拟 barrier → 得不偿失
```

### 4.2 WorkGang 架构 — 一群 Worker 怎么协调？

```
★★★ Dispatcher 模式的核心:

WorkGang (管理者):
  ┌─────────────────────────────────────────────────────────┐
  │ run_task(task)                                          │
  │   → 每个 Worker 被唤醒 → work(i) 执行 task               │
  │   → 所有 Worker 完成（barrier）→ task_done() → 返回       │
  │   → 下一个 task                                          │
  └─────────────────────────────────────────────────────────┘

每个 Worker (AbstractGangWorker):
  ┌──────────────────────────────────────────────────────┐
  │ while (!_should_terminate) {                         │
  │   wait_for_task();           ← 阻塞等待（Monitor）     │
  │   work(id);                  ← 执行 task.work(id)    │
  │   signal_task_done();        ← 通知"我完成了"         │
  │ }                                                    │
  └──────────────────────────────────────────────────────┘

❓ 关键设计问题:
  ① wait_for_task(): 哪个 Monitor？谁来 notify？
     → GangWorker::_monitor — WorkGang::run_task() 中 notify_all
     → 类比: VMThread 的 VMOperationQueue_lock → 但这里是"广播"不是"单播"

  ② signal_task_done() → barrier 怎么实现？
     → 每个 Worker 递减一个共享计数器
     → 最后一个完成的 Worker 通知 WorkGang "所有人完成"

  ③ 如果 Worker 在 work() 中 crash 了怎么办？
     → signal_task_done() 不会被调用 → run_task() 永远不返回
     → JVM hang（没有独立的 watchdog 线程来检测 Worker crash）

  ④ ★ 为什么不设计成 VMThread 那样（单线程事件循环）？
     → VMThread 处理的是"宏观操作"（GC、逆优化）— 天然串行
     → WorkerThread 处理的是"微观操作"（复制对象、扫描引用）— 天然并行
     → 粒度决定了模型: 粗粒度 → 单线程; 细粒度 → 并行分治
```

### 4.3 Work Stealing — Cilk 经典算法的 JVM 实现

```
★★★ 这是本文最"计算机科学"的部分:

动机:
  Worker A: [T1, T2, T3, T4] → 还有很多任务
  Worker B: []               → 队列空了，空闲
  Worker C: [T5]             → 快做完了

  没有 steal: B 和 C 空闲 → 浪费 CPU
  有 steal: B 从 A 的队列偷一个任务 → 负载均衡

JVM 的 steal 实现 (GenericTaskQueueSet::steal):
  ① 从 (queue_num + 1) % n 开始遍历其他 Worker 的队列
  ② 对每个目标队列调用 pop_global() — 从队列尾部尝试偷一个 task
  ③ pop_global() 是 CAS 无锁操作 — 和队列的 push（从头部 push）不冲突
  ④ 所有队列都空 → 返回 false → Worker 进入等待

❓ 为什么是"从尾部偷"而不是"从头部偷"？
  → push 从头部 (local LIFO — 快)
  → pop 也是从头部 (local LIFO — 快)
  → steal 从尾部 (global FIFO — 不冲突!)
  → 这是经典的两端队列 (work-stealing deque)
  → 类比: Cilk 的 THE protocol, Java ForkJoinPool 的 WorkQueue

❓ 为什么用 CAS 而不是 Mutex？
  → steal 是高频率操作 — 每次 pop_global 都是一次 CAS
  → 如果加锁 → Young GC 中几百次 steal → 锁竞争 → GC 停顿变长
  → CAS 失败 → 说明另一个 Worker 同时在偷 → 自然的"退避"

❓ 如果所有队列都空怎么办？
  → 这是正常的 — GC 中大多数对象已经处理完了
  → steal 失败 → Worker 调用 signal_task_done() → 进入 wait_for_task()
  → 不要自旋等新任务 — GC 不会产生新任务，所有 CSet Region 已分配

❓ ★★ steal 失败后，怎么判断"全员完成"而不是"暂时没任务"？
  → 这不是简单的"大家都空了就退出" — 存在竞态:
    Worker A 的队列刚空 → A 开始 steal
    Worker B 刚好往 A 的队列 push 一个新任务（引用发现）
    → 如果 A 宣布"我完成了" → B 的任务没人处理！
  → G1 的 Termination Protocol:
    ① _term_attempts 计数器 — 每次 steal 失败后递增
    ② 尝试 N 次 steal 后仍未成功 → 进入 termination 状态
    ③ 但其他 Worker 仍在工作中 → 可能产生新任务 → 已 termination 的 Worker
       必须被"重新激活"
    ④ 只有所有 Worker 同时处于 termination 状态 → 才算真正的"全员完成"
  → 这是并行计算中经典的 Termination Detection 问题
  → 类比: Dijkstra 的 Termination Detection in a Ring 算法
```

### 4.4 PLAB — 怎么避免十几条线程同时 CAS 到同一个 Survivor Region？

```
★★★ 核心问题: 多线程 copy 对象到 Survivor 时怎么分配内存？

没有 PLAB 的世界:
  Worker-1: 要分配 24 字节 → CAS(bump_pointer, current, current+24)
  Worker-2: 要分配 56 字节 → CAS(bump_pointer, current, current+56)
  Worker-3: 要分配 32 字节 → CAS(bump_pointer, current, current+32)
  → 3 个 Worker 同时 CAS 同一个 bump_pointer！
  → 每次只有 1 个成功，另外 2 个重试 → 严重的 cache line 乒乓
  → Young GC 中上千万次分配 → 不可接受的竞争

PLAB (Promotion Local Allocation Buffer) 方案:
  每个 Worker 预先从 Survivor Region "批量化" 抢一块内存（PLAB）
  → Worker 在自己的 PLAB 内使用 bump-pointer 分配（零竞争!）
  → PLAB 用完后 → 再抢一块新的
  → GC 结束时 flush 剩余的 PLAB

  ┌─────────────────────────────────────────────────────┐
  │ Survivor Region (4MB)                                │
  │ ┌─────────┬─────────┬─────────┬─────────┬────────┐  │
  │ │ PLAB W0 │ PLAB W1 │ PLAB W2 │  FREE   │ TOP    │  │
  │ └─────────┴─────────┴─────────┴─────────┴────────┘  │
  │                                         ▲           │
  │                                   bump_pointer      │
  └─────────────────────────────────────────────────────┘
  W0, W1, W2 各自的 PLAB 内部分配完全无锁

❓ PLAB 和 TLAB 有什么异同？
  TLAB: JavaThread 在 Eden 中分配对象 → 减少对堆锁的竞争（运行时）
  PLAB: WorkerThread 在 Survivor/Old 中分配对象 → 减少多线程竞争（GC 时）
  本质相同: "预取一批 → 本地无锁分配 → 用完再取"
  粒度不同: TLAB ~128KB, PLAB ~4KB（GC 中的对象通常较小）

❓ PLAB 太大 / 太小会怎样？
  太大 → 碎片化: 每个 Worker 占一大块，但 GC 结束时可能用不完 → 浪费
  太小 → 频繁抢新的 PLAB → CAS 竞争增加
  → G1 自适应调整 PLAB 大小 (G1PLABSizePercent)

❓ GC 结束时，每个 Worker PLAB 里没用完的空间去哪了？
  → flush: 剩余空间返还给 Region → 形成碎片
  → 8 个 Worker 各剩 3KB → 24KB 碎片（可接受）
  → 如果 PLAB 过大且对象都很小 → 严重碎片 → 这就是自适应调整的必要性
  → 与 TLAB 的差异: TLAB 在运行时持续复用，PLAB 在 GC 结束时一次性 flush
```

### 4.5 单点故障 — Worker 挂了会怎样？

```
❓ 面试必问: "Young GC 期间一个 Worker OOM 了怎么办？"

故障模式:
  ① Worker OOM (Native OOM, 不是 Java OOM):
     → Worker::work() 中 os::malloc() 失败 → crash
     → signal_task_done() 不会被调用
     → WorkGang::run_task() 的 barrier 永远等不到这个 Worker
     → VMThread 卡在 _cur_vm_operation->doit() (即 GC) 中
     → safepoint 永不结束 → JVM 死锁！

  ② Worker slow path (处理巨型 oop map):
     → 某个 Worker 比其他 Worker 慢很多（straggler）
     → run_task() 要等它 → GC 停顿变长
     → 缓解: Work Stealing — 让其他 Worker 可以偷它的任务

  ③ 谁来检测 Worker crash？
     → 没有独立 watchdog
     → 间接手段: GC log 时间异常 / hs_err
     → VMOperationTimeoutTask (如果配置了) 会检测到 GC 超时

  ④ 和 VMThread 单点故障的区别:
     VMThread: 只有一个 → 挂了 = 全局不可恢复
     Worker: 有多个 → 理论上可重新创建（但 JVM 没有实现 Graceful Degradation）
           → 实际行为: 整个 GC 失败 → safepoint 永不结束 → 等价于 VMThread 卡住
```

## 五、文章结构

```
§〇 源文件清单（跨 workgroup/taskqueue/g1ParScan/g1CollectedHeap）

§一 为什么 GC 需要 WorkerThread？
  ❓ VMThread 单线程做 GC 为什么不行？
  ❓ GC 并行化和"MapReduce"的相似性
  1.1 GC 工作的本质 — CPU-intensive 的对象复制 + 根集扫描
  1.2 VMThread vs WorkerThread 全维度对比表（7 维度）
  1.3 为什么是固定线程数而不是动态扩缩？
  1.4 WorkerThread 在继承体系中的位置：NonJavaThread → 不在 _thread_list → 不被暂停

§二 WorkGang 架构 — JVM 的"Master-Worker"模式
  ❓ Dispatcher 模式 vs 共享任务队列？
  2.1 创建: G1CollectedHeap::initialize() → new WorkGang("GC Thread", ParallelGCThreads) → initialize_workers() → 逐个 new GangWorker → os::create_thread
  2.2 GangWorker::loop() — "等待-执行-汇报" 三元循环
  2.3 run_task() → dispatch → barrier → 完成
  2.4 ★ 为什么不设计成 VMThread 那样（单线程事件循环）？

§三 Work Stealing — 无锁负载均衡
  ❓ 为什么 GC 中的任务粒度适合 steal？
  ❓ 为什么从尾部偷而不是头部偷？
  ❓ 和 Cilk / Java ForkJoinPool 的 steal 有什么区别？
  3.1 GenericTaskQueue: 两端操作的无锁 deque 数据结构
  3.2 steal 算法源码: pop_global() + CAS + 遍历策略
  3.3 为什么 CAS 失败就放弃（不重试）？
  3.4 ★★★ Termination Detection Protocol — 怎么判断"全员完成"？
  3.5 ★ 完整 steal + termination 的 Mermaid 时序图

§四 PLAB — 多线程分配的去竞争化
  ❓ 没有 PLAB 会怎样？— 定量分析 CAS 竞争的开销
  ❓ PLAB 和 TLAB 的异同？
  4.1 PLAB 的生命周期：预取 → 本地分配 → flush
  4.2 G1ParScanThreadState 中的 PLAB 管理
  4.3 自适应 PLAB 大小调整策略
  4.4 ★ PLAB 分配的内存布局图

§五 Worker 挂了会怎样？— 故障模式
  ❓ 和 VMThread 单点故障的区别
  5.1 OOM / Slow worker / Timeout 三种故障模式
  5.2 为什么没有 Graceful Degradation？
  5.3 检测手段：GC log / hs_err / VMOperationTimeoutTask

§六 GDB 验证 + 可证伪断言
  - break WorkGang::run_task → p num_workers / task 名称
  - break GenericTaskQueueSet::steal → 观测偷取成功率
  - break G1ParScanThreadState::copy_to_survivor → p obj_size
  - 验证 WorkerThread 不在 Threads::_thread_list
  - 验证 PLAB 大小自适应变化
```

## 六、写作要求

1. **设计思维优先**: 每个概念先讲"为什么存在"，再讲"怎么实现"
2. **面试级追问**: 凡是关键设计决策，下一段必然是一个 ❓ 追问
3. **★ 核心对比线**: 全文贯穿 VS VMThread — "为什么不设计成 VMThread 那样？"
4. **概念映射**: Work Stealing → Cilk/ForkJoin, Dispatcher → Master-Worker, PLAB → 本地化优化
5. **交叉引用**: [05] 线程继承链, [07] VMThread 对比, [11] Lock Ranking
6. **源码作为证据**: 源码片段用来支撑设计分析，不是用来"翻译"的
7. **Mermaid ≥2 张**: steal 时序图 + Worker::loop() 状态机图
8. **对比表 ≥3 张**: VMThread vs WorkerThread / PLAB vs TLAB / steal 算法家族对比
9. **可证伪断言 ≥8 条**：每条有 GDB 命令 + 预期值

## 七、输出格式

- Markdown 文件，命名为 `08-JVM-WorkerThread.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 [07] + [05] + 关联 + 阅读收益）
