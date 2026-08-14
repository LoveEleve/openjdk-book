# 01. "帮我做 GC"——VM_Operation 从提交到执行

> **前置依赖**:[18-safepoint/01 — JVM 怎么让所有线程同时停住？— Safepoint 编排](openjdk/vol-02/18-safepoint/01-safepoint-orchestration.md):VM 操作是 safepoint 的发起者——begin/end 就在本篇的 loop 里;[17-threads/01 — 线程层级与生命周期](openjdk/vol-02/17-threads/01-thread-hierarchy.md):VMThread 是 NamedThread 不是 JavaThread;[18-safepoint/02 — 线程怎么知道自己该停了？— 轮询机制与 NoSafepointVerifier](openjdk/vol-02/18-safepoint/02-polling-verifiers.md):提交时先过 check_for_valid_safepoint_state
> → **后续**:[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](02-background-init.md):谁在后台周期性干活
> 关联域: 25-gc(GC 是最重的 VM 操作)、27-jni、30-jvm-entry

## "GC 我不能自己来"

`System.gc()` 是 Java 代码——为什么请求 GC 的线程不能自己执行 GC?因为 GC 需要**全世界停摆**(safepoint),而"指挥全世界停摆"只有一条纪律: 只能由 **VM 线程**来(begin/end 有 `is_VM_thread` 断言,18 域)。所以所有"需要特权"的请求都被打包成 **VM_Operation**,提交给唯一的执行者。这一篇拆这条委托链: 操作的种类与模式、双优先级队列、提交→等待→执行→唤醒的完整协议。

## 1. VM_Operation: 四种模式,八十多种操作

`VM_Operation` 是请求的统一接口(vmOperations.hpp:134 起)。**模式**决定两件事: 要不要 safepoint、调用者要不要等:

```cpp
// vmOperations.hpp:136-141(截取核心,逐字)
  enum Mode {
    _safepoint,       // blocking,        safepoint, vm_op C-heap allocated
    _no_safepoint,    // blocking,     no safepoint, vm_op C-Heap allocated
    _concurrent,      // non-blocking, no safepoint, vm_op C-Heap allocated
    _async_safepoint  // non-blocking,    safepoint, vm_op C-Heap allocated
  };
```

四个组合恰好覆盖四个正交需求: `_safepoint`(GC/Deopt/偏向锁撤销——最常用);`_no_safepoint`(PrintThreads/JFR checkpoint——阻塞但不暂停);`_concurrent`(非阻塞,提交即走,如某些后台任务);`_async_safepoint`(触发 safepoint 但调用者不等待,GC 并发阶段用)。每个子类覆盖 `evaluation_mode()`(:195,默认 `_safepoint`),派生判定 `evaluate_at_safepoint()`/`evaluate_concurrently()`(:207-212)——**多态让 VM 线程不需要 switch 操作类型**。

**操作种类**: `VM_OPS_DO` 宏(vmOperations.hpp:48-132)罗列了约 **84 种**——GC 族(GenCollectFull/G1CollectForAllocation/ParallelGCSystemGC...)、线程族(ThreadStop/ThreadDump/ThreadSuspend)、反优化族(Deoptimize/DeoptimizeFrame/ZombieAll)、JVMTI 族(GetStackTrace/RedefineClasses/ChangeBreakpoints)、偏向锁族(EnableBiasedLocking/RevokeBias/BulkRevokeBias)、握手族(HandshakeOneThread/HandshakeAllThreads)、杂项(HeapDumper/RotateGCLog/DumpHashtable/FindDeadlocks)。**统一接口的妙处**: VM 线程只认 `evaluate()`→`doit()`,操作语义完全藏在子类里。

## 2. 队列: 两个优先级,一次排干

`VMOperationQueue`(vmThread.hpp:39-85)是双优先级链表:

- **`SafepointPriority`**(safepoint 操作,最高)——GC/Deopt/偏向锁撤销/握手;
- **`MediumPriority`**(非 safepoint 操作)——PrintThreads/JFR checkpoint 等。

**queue_peek 是刻意 lock-free 的**(vmThread.hpp:67-68,注释 "may return the wrong answer but must not break"): 裸读 `_queue_length[prio] > 0`——链表已由锁保护,计数只是"通知信号",peek 错过一次就再等一轮,不会出错。**关键动作是 `drain_at_safepoint_priority()`**(:77): 取出 safepoint 优先级的**整条操作链**——于是**一次 begin/end 里可以执行多个操作**(coalescing): GC 操作来的时候,把排队的 deopt、偏向锁撤销、握手一起办了,而不是每个操作一个 safepoint(loop 注释 :568-576 说明还会再排干一次,防止 safepoint 期间新入队的漏掉)。[实证:](planning/outlines/00-jvm-tools/materials/commands/20-vmops-demo.txt) 日志里多次成对出现的 `Adding VM operation: RevokeBias` / `Evaluating safepoint VM operation: RevokeBias` 就是频繁的偏向锁撤销操作。

## 3. 提交协议: 从请求到结果

**提交侧**(`VMThread::execute`,vmThread.cpp:663):

```cpp
// vmThread.cpp:712-719(截取核心,逐字)
    if (!concurrent) {
      // Wait for completion of request (non-concurrent)
      // Note: only a JavaThread triggers the safepoint check when locking
      MutexLocker mu(VMOperationRequest_lock);
      while(t->vm_operation_completed_count() < ticket) {
        VMOperationRequest_lock->wait(!t->is_Java_thread());
      }
    }
```

完整链条: ①非并发操作先过 `check_for_valid_safepoint_state`(18 域验证器,:671);②**`doit_prologue()`**(:676)——在提交线程里先跑,给操作一个"反悔"机会: 比如 `VM_RevokeBias::doit_prologue` 先检查传入对象**是否还带 bias 标记**(biasedLocking.cpp:520-534,注释 "Verify that there is actual work to do... we avoid a safepoint")——没有就返回 false 取消本次提交,连队列都不用进、省掉一次 safepoint;③入队 + `VMOperationQueue_lock->notify()`(:696-704);④**等结果用 ticket 计数**(:712-719)——提交线程记下自己的票号,醒来后 `vm_operation_completed_count()` 超过票号才算完成——**不用等"某个特定操作",而是"轮到我"**(多个提交者共用计数器);⑤`doit_epilogue()`(:722,并发模式不调用)。

**执行侧**(`VMThread::loop`,vmThread.cpp:457): 空队列时 `wait(GuaranteedSafepointInterval)` 定时醒来——**超时且需要 cleanup 就强制一次"空 safepoint"**(no_op_safepoint_needed,:494-505,18-01 的 `Cleanup` 原因);取到操作后:

```cpp
// vmThread.cpp:537-566(截取核心,逐字)
      if (_cur_vm_operation->evaluate_at_safepoint()) {
        log_debug(vmthread)("Evaluating safepoint VM operation: %s", _cur_vm_operation->name());

        _vm_queue->set_drain_list(safepoint_ops); // ensure ops can be scanned

        SafepointSynchronize::begin();

        if (_timeout_task != NULL) {
          _timeout_task->arm();
        }

        evaluate_operation(_cur_vm_operation);
        // now process all queued safepoint ops, iteratively draining
        // the queue until there are none left
        do {
          _cur_vm_operation = safepoint_ops;
          if (_cur_vm_operation != NULL) {
            do {
              EventMark em("Executing coalesced safepoint VM operation: %s", _cur_vm_operation->name());
              log_debug(vmthread)("Evaluating coalesced safepoint VM operation: %s", _cur_vm_operation->name());
              // evaluate_operation deletes the op object so we have
              // to grab the next op now
              VM_Operation* next = _cur_vm_operation->next();
              _vm_queue->set_drain_list(next);
              evaluate_operation(_cur_vm_operation);
              _cur_vm_operation = next;
              ...
```

`evaluate_operation`(:403)完成时做**完成登记**: `calling_thread()->increment_vm_operation_completed_count()`(:427-429)——**注意顺序**: 这个递增会让提交线程一醒来就可能释放操作对象,所以之后不能再访问 `_cur_vm_operation`(:430-434 注释)。**等待者的唤醒不在登记处**: loop 每一轮结束(无论有没有执行操作)都会 `VMOperationRequest_lock->notify_all()`(vmThread.cpp:622-624)——等待线程醒来后自检 ticket 是否轮到自己;同一处还复查 `no_op_safepoint_needed(true)` 决定要不要补一次空 safepoint(:625-631,18-01 的 `Cleanup` 另一触发点)。`VMOperationTimeoutTask`(:92)监控操作耗时(超时告警/中止)。

**嵌套**: 操作内部又提交操作(如 GC doit 里要 dump heap)——`allow_nested_vm_operations()` 默认 false,VM 线程自己调 `execute` 时检查,不允许就 `fatal`(vmThread.cpp:724-736);允许的嵌套走**另一条腿**: `evaluate_at_safepoint` 且不在 safepoint 时,由 VM 线程自己 begin/evaluate/end(:744-750)。

## 4. 实证: 一条请求的日志轨迹

[实证:](planning/outlines/00-jvm-tools/materials/commands/20-vmops-demo.txt) `-Xlog:vmthread=debug` 把整条链摊开: `Adding VM operation: G1CollectFull`(jcmd GC.run 的提交)→ `Evaluating safepoint VM operation: G1CollectFull`(VM 线程执行,伴随 begin/end);`-Xlog:safepoint` 的触发原因统计则展示了"谁在请求特权": 一次运行里 `RevokeBias` 10 次(偏向锁撤销最频繁)、`PrintThreads`/`FindDeadlocks`(Thread.print 的两次 jcmd)、`G1CollectFull`、`EnableBiasedLocking`、`Deoptimize`——**每个原因都是一个 VM_Operation 的名字**,18-01 日志里 `Entering safepoint region:` 后面跟的就是它。

## 核心悬念

VM 操作链拆完了: 操作(4 模式 × ~85 种,多态统一接口)、队列(双优先级 + lock-free peek + **safepoint 优先级一次排干 = coalescing**)、协议(提交侧 prologue→入队→ticket 等待→epilogue;执行侧 loop→begin→evaluate→登记→end;嵌套有严格门禁)。一句话: **VMThread 是 JVM 的"特权执行者",操作是它的任务单——safepoint 是它开闸放行的手段,coalescing 让它一次停摆办很多事**。

但还有一个问题: 谁在**后台周期性**干活?偏向锁为什么 10 次撤销?JFR checkpoint、周期任务怎么被调度?下一篇: 后台任务与初始化。

> → [20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](02-background-init.md)
