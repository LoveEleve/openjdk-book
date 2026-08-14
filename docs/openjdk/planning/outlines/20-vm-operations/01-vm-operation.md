# 01. "帮我做 GC"——VM_Operation 从提交到执行

> 🔴 Deep | 2 KP 中的操作编排
> 读者处境: Java 线程调了 `System.gc()`→这个请求不能由自己执行(Gc 需要所有线程停在 safepoint)→必须交给 VMThread。提交者怎么等结果？VMThread 怎么排队执行？

> ⚠️ 写作期修正(2026-08-13, vol-02/20-vm-operations/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"evaluate_at_safepoint 检查 mode 决定入队到 SafepointPriority" 半对**: 入队优先级由 add() 内部按 evaluation_mode 定(vmThread.cpp:663-723);queue_drain 在 **loop 取到操作后**(:511-514)排干 safepoint 优先级整条链;coalesced 执行在 loop 里(begin→当前 op→do-while 逐链执行→end,:537-576,注释 :568-576 再排干防漏)
> - **"queue_peek lock-free 裸读 _queue_length" ✓**: vmThread.hpp:67-68 "may return the wrong answer but must not break";真实保护是 VMOperationQueue_lock(入队侧),peek 只是通知信号
> - **execute 协议细节**: 提交侧(vmThread.cpp:663-723): check_for_valid_safepoint_state(:671,18 域验证器)→doit_prologue(:676,取消机会)→入队+notify(:696-704)→**ticket 等待**(vm_operation_completed_count < ticket,wait VMOperationRequest_lock,:712-719,"轮到我"非"等特定 op")→doit_epilogue(:722,concurrent 不调);执行侧: loop(:457)空等 GuaranteedSafepointInterval 超时→no_op_safepoint 强制 cleanup(:494-505,18-01 Cleanup 来源)→evaluate_operation(:403)完成登记 increment_vm_operation_completed_count(:427-429,**登记后不能再访问 _cur_vm_operation**,:430-434)
> - **嵌套**: allow_nested_vm_operations 默认 false,VM 线程内 execute 检查 fatal(vmThread.cpp:724-736);嵌套走 VM 线程侧 begin/evaluate/end(:744-750)
> - **操作数**: ~84 种(VM_OPS_DO 宏 template 行数 86-2 个 shtemplate 定义)
> - **VMThread 是 NamedThread 非 JavaThread**(vmThread.hpp:114,注释 "primordial thread spawns all other threads");VMOperationTimeoutTask(:92)超时监控
> - **实证**: 20-vmops-demo.txt(-Xlog:vmthread=debug: Adding→Evaluating 对;触发原因统计 RevokeBias 10/G1CollectFull/PrintThreads/FindDeadlocks...——每个原因=一个 VM_Operation 名,与 18-01 Entering safepoint region 后的名字对应)

### 1. "我有四种身份" — VM_Operation 的 4 模式

场景: GC 需要 safepoint + 阻塞等待。JVMTI GetStackTrace 不需要 safepoint 但要阻塞。Shenandoah init mark 需要 safepoint 但不阻塞调用者(GC 线程自己)。

**4 种 Mode** (`vmOperations.hpp:136-141`):
```
_safepoint:       safepoint + 调用者阻塞等待 — GC/Deopt/BiasedLock Revoke
_no_safepoint:    no safepoint + 调用者阻塞 — PrintThreads/JFR checkpoint
_concurrent:      no safepoint + 非阻塞 — cleanup tasks
_async_safepoint: safepoint + 非阻塞 — GC concurrent phase triggers
```
- 源码: `vmOperations.hpp:136-141` enum Mode
- 关键设计: 4 模式解决了"是否全局暂停"和"调用者是否等待"两个正交维度。_safepoint 是最常用的——GC 需要暂停和等结果。_async_safepoint 是 GC concurrent phase 用的——触发 safepoint 但不阻塞 GC 线程(它还有 concurrent work 要做)
- [C++: 每个 VM_Operation 子类覆盖 `evaluation_mode()` 返回自己的 mode——virtual method dispatch——决定 VMThread 的调度行为。`evaluate_at_safepoint()` 检查 mode==_safepoint||_async_safepoint→决定是否入队到 SafepointPriority。多态让 VMThread 不需要 switch on operation type]

**70+ 种操作** (`vmOperations.hpp:48-132`):
```
GC: GenCollectFull, G1CollectForAllocation, ParallelGCSystemGC, CGC_Operation, CMS_*, Shenandoah*
Thread: ThreadStop, ThreadDump, ThreadSuspend
Deopt: Deoptimize, DeoptimizeFrame, ZombieAll
JVMTI: GetStackTrace, RedefineClasses, ChangeBreakpoints, SetFramePop
BiasLock: EnableBiasedLocking, RevokeBias, BulkRevokeBias
Handshake: HandshakeOneThread, HandshakeAllThreads
Misc: HeapDumper, RotateGCLog, DumpHashtable, FindDeadlocks
```
- 关键设计: 为什么 70+ 种而不合并？每种的 doit() 是独立的——GC doit 和 Deopt doit 完全不同。统一接口(evaluate→doit)保证 VMThread 不需要知道操作语义——只统一包装 safepoint+queue+notify

### 2. "排队——谁先上？" — VMOperationQueue 双优先级

场景: GC 请求和 PrintThreads 同时到达——GC 要 safepoint，PrintThreads 不需要。谁先执行？

**SafepointPriority > MediumPriority** (`vmThread.hpp:41-45`):
```
SafepointPriority: GC, deopt, biased lock revoke, handshake — 必须 safepoint
MediumPriority:    PrintThreads, JFR checkpoint, class loader stats — 不需要 safepoint
```
- 源码: `vmThread.hpp:41-45` enum Priorities
- 关键设计: SafepointPriority 打头的操作在一次 safepoint 中批量处理(queue_drain)——一次 begin/end 执行多个操作(如 GC + compil policy update + IC cleanup)。而不是 GC 一个 safepoint→醒来→deopt 又一个 safepoint。coalescing 减少 safepoint 次数

**queue 结构** (`vmThread.hpp:39-50`):
```
双链表: _queue[SafepointPriority] + _queue[MediumPriority]
_count: lock-free peek——VMThread::loop 用 while(!_queue_length[prio])→睡眠等 notify
counter: 每操作递增——用于跟踪排队深度
```
- 源码: `vmThread.hpp:48-53` _queue_length + _queue_counter
- 关键设计: queue_peek 是 lock-free——读 `_queue_length[prio] > 0`。不需要锁——写方(JavaThread)递增计数前已入队→读方(VMThread)只要看到 >0 就处理。spurious wakeup 由 loop 逻辑处理(peek 返回 false 继续睡觉)
- [C++: `_queue_length` 是普通 int 非 atomic——写方在 enqueue 后递增(int++)，读方在 peek 时裸读。这是安全的因为双链表已在计数变更前原子链接——计数只是"通知信号"不是"数据一致性保护"。真正的保护由 VMOperationLock 提供——write side through lock, read side relies on lock-free peek as hint only]

### 3. "提交→等待→叫醒" — VMThread execute 协议

场景: JavaThread 调 VMThread::execute(op)→op 入队→JavaThread block→VMThread pick op→safepoint→doit→notify。JavaThread 醒来→doit_epilogue。

**execute 完整协议** (`vmThread.cpp:120-280`):
```
JavaThread 侧:
  1. op->doit_prologue() — 在 JavaThread 中执行(还未阻塞)
     例如: biased lock one-shot revoke: 偏向线程需要先检查栈
  2. VMThread::execute(op) → queue add → wait on VMOperationLock
  // ... op 被执行 ...
  3. 醒来→op->doit_epilogue() — 在 JavaThread 中执行(已经恢复)

VMThread 侧:
  1. loop: wait for ops → queue remove_next
  2. if safepoint mode → SafepointSynchronize::begin()
  3. op->evaluate() → op->doit() — 实际操作
  4. if safepoint mode → SafepointSynchronize::end()
  5. notify JavaThread — VMOperationLock->notify_all()
```
- 源码: `vmThread.cpp:120-280` VMThread::loop 主体
- 关键设计: doit_prologue 在 JavaThread 执行——给操作一次在提交前"反悔"的机会。如果返回 false→VM 操作取消→不排队→JavaThread 立即继续。例如 biased lock revoke 的 doit_prologue 检查线程栈→发现偏向线程不在临界区→直接撤销→不需要 VMThread 介入

**nested 操作** (`vmOperations.hpp:196`):
```
allow_nested_vm_operations(): 默认 false
  = true: VM 操作中可以提交另一个 VM 操作 — 级联发生
  = false: VMThread 的 evaluate() 中不能再调用 VMThread::execute
```
- 关键设计: 嵌套操作罕见但有——如 GC doit 中需要 dump heap→提交 HeapDumper op。嵌套不阻塞——当前 op 的 evaluate 先继续，嵌套 op 异步执行

---

### 核心悬念

**"VMThread 是 JVM 的唯一操作执行线程——JavaThread 通过 execute→wait→doit→notify 协议委托操作。4 模式决定是否 safepoint + 是否阻塞调用者。SafepointPriority 批量 coalesce 同一 safepoint 的多个操作。"** — 但谁在后台周期性干活？下一篇: Background Task + Init。

> → [02-background-init.md](02-background-init.md)
