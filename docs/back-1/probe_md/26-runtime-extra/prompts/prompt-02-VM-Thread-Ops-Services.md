# Prompt 02 — VM Thread, VM Ops & Service Infrastructure

> **Target doc**: `probe_md/26-runtime-extra/docs/02-VM-Thread-Ops-Services.md`
> **Phase**: 26-运行时剩余（libjvm.so runtime/）
> **Scope**: vmThread + vmOperations + javaCalls + interfaceSupport + serviceThread + safepointMechanism + timer + perfData

---

## §〇 Production Scenario

你是 HotSpot JVM 的运行时基础设施开发者。一个 Java 应用触发 `System.gc()`，你需要在 **不阻塞 GC 线程的情况下，把 VM_Operation 放入 VMThread 的双优先级队列**，由 VMThread 在下一个 safepoint 时取出执行。同时，`jcmd <pid> Thread.print` 触发了 `VM_PrintThreads` 操作——这类 `_safepoint` 模式操作会被批量合并执行（coalescing），以最小化 safepoint 次数。

同一时间，ServiceThread 正在处理 JVMTI 编译方法加载事件并发送 GC 通知，interfaceSupport 的 RAII 类正在保障线程状态转换时的 safepoint 可见性，safepointMechanism 通过 per-thread local poll 实现 O(1) 武装/解除，而 PerfData 计数器正在 `/tmp/hsperfdata_<pid>` 中积累性能数据。

你的任务是深度理解这 8 个子系统如何组合成 JVM 的服务基础设施层。

---

## §一 Task + Narrative + Beginner Callouts

### Task

生成文档 `02-VM-Thread-Ops-Services.md`，深度分析 10 个源文件中 8 个子系统的设计与实现。

### Narrative（叙事主线）

以 **一条 VM_Operation 的完整生命周期** 为主线索，串联所有子系统：

```
JavaThread 发起 VM_Operation::execute(op)
  → op->doit_prologue()  // 在发起线程中
  → VMOperationQueue::add(op)  // 双优先级链表入队
  → VMOperationQueue_lock->notify()  // 唤醒 VMThread
  → VMThread::loop() 醒来 → remove_next() 出队
  → evaluate_at_safepoint()? 
      Yes: SafepointSynchronize::begin() + 批量合并 drain 优化 + evaluate_operation()
      No:  evaluate_operation()  // 非 safepoint 操作
  → doit_epilogue() // 在发起线程中
  → VMOperationRequest_lock->notify_all()
```

每个子系统在此主线上扮演角色：
- **VMOperationQueue**：队列引擎（双向循环链表 + 2 级优先级 + 防饥饿调度）
- **VM_Operation 继承树**：40+ 子类定义操作语义
- **VMThread::loop()**：主循环（wait→execute→notify，超时强制 safepoint）
- **javaCalls**：VMThread/ServiceThread 调用 Java 方法的标准路径
- **interfaceSupport**：线程状态转换的安全 RAII 守卫
- **safepointMechanism**：poll page 的 arm/disarm 底层实现
- **ServiceThread**：无关 safepoint 的后台任务调度器
- **PerfData**：性能计数器系统及共享内存导出

### Beginner Callouts（7 个，仅在本节内）

> **Callout 1: VM Thread ≠ GC Thread**
> VMThread 是 JVM 中唯一的特权线程，**不是 GC 线程**。它执行 VM_Operation（包括 GC 请求），但本身不执行 GC 逻辑。GC 操作通过 `VM_GenCollectFull` 等 op 转发给对应 GC 实现。VMThread::loop() 是 JVM 的"心脏起搏器"。

> **Callout 2: Safepoint 操作 vs Concurrent 操作**
> `evaluate_at_safepoint()` 返回 true 的操作必须在 safepoint 中执行——所有 Java 线程暂停。`evaluate_concurrently()` 返回 true 的操作可在 VMThread 中直接执行，无需 safepoint。`_async_safepoint` 模式两者都返回 true：发起线程不阻塞，但操作在 safepoint 中执行。

> **Callout 3: 双优先级队列的防饥饿设计**
> VMOperationQueue 不是简单的 FIFO。它有两个优先级（SafepointPriority/MediumPriority），通过 10:1 计数器调度防止低优先级饿死。这是对 bug 4390175 的修复。

> **Callout 4: thread_local_poll vs global_page_poll**
> HotSpot 支持两种 safepoint 轮询机制。旧方案所有线程共享一个保护页，arm 时用 mprotect 设为 PROT_NONE。新方案（ThreadLocalHandshakes）每个线程有独立的 poll 地址，arm/disarm 是简单的内存写操作——O(1) 无系统调用。

> **Callout 5: ThreadStateTransition 的三态协议**
> 所有 VM 边界穿越遵循：`from → from+1 → safepoint check → to`。中间过渡态（如 _thread_in_native_trans）让 safepoint 协议能检测到正在穿越边界的线程，等待其完成转换。

> **Callout 6: ServiceThread 是隐藏线程**
> ServiceThread 继承自 JavaThread 但 `is_hidden_from_external_view()` 返回 true。Thread.getAllStackTraces() 和 jcmd 不会列出它。它使用 `ThreadBlockInVM` 而非 safepoint 阻塞，因此不会参与 safepoint 协议。

> **Callout 7: PerfData 的三级稳定性契约**
> `java.*` 命名空间 = 稳定支持接口，`com.sun.*` = 不稳定但支持，`sun.*` = 不稳定且不支持。这遵循 Java 包命名约定，外部工具（如 jstat）依赖此约定判断计数器是否可用。

---

## §二 Standard Environment

### Source Roots
- `src/hotspot/share/runtime/vmThread.cpp` (:1-818) — VMThread 实现
- `src/hotspot/share/runtime/vmThread.hpp` (:1-189) — VMThread 头文件
- `src/hotspot/share/runtime/vmOperations.cpp` (:1-515) — VM_Operation 实现
- `src/hotspot/share/runtime/vmOperations.hpp` (:1-534) — VM_Operation 继承树
- `src/hotspot/share/runtime/javaCalls.cpp` (:1-649) — JavaCalls 实现
- `src/hotspot/share/runtime/javaCalls.hpp` (:1-271) — JavaCalls 接口
- `src/hotspot/share/runtime/interfaceSupport.inline.hpp` (:1-605) — 线程状态转换
- `src/hotspot/share/runtime/serviceThread.cpp` (:1-186) — ServiceThread 实现
- `src/hotspot/share/runtime/serviceThread.hpp` (:1-60) — ServiceThread 头文件
- `src/hotspot/share/runtime/safepointMechanism.cpp` (:1-122) — Poll 机制实现
- `src/hotspot/share/runtime/safepointMechanism.hpp` (:1-94) — Poll 机制接口
- `src/hotspot/share/runtime/timer.cpp` (:1-178) — Timer 实现
- `src/hotspot/share/runtime/timer.hpp` (:1-99) — Timer 头文件
- `src/hotspot/share/runtime/perfData.cpp` (:1-622) — PerfData 实现
- `src/hotspot/share/runtime/perfData.hpp` (:1-973) — PerfData 头文件

### Build Configuration
```bash
# .so 目标
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
# 构建命令
make hotspot
# binary 路径
build/linux-x86_64-server-release/hotspot/variant-server/libjvm/libjvm.so
```

### Key Global Variables

| 变量 | 定义位置 | 类型 | 作用 |
|------|---------|------|------|
| `VMThread::_vm_queue` | vmThread.hpp:183 | `VMOperationQueue*` | 全局 VM 操作队列 |
| `VMThread::_cur_vm_operation` | vmThread.hpp:182 | `VM_Operation*` | 当前执行的操作 |
| `VMThread::_should_terminate` | vmThread.hpp:118 | `bool` | 终止标志 |
| `VMThread::_timeout_task` | vmThread.hpp:125 | `VMOperationTimeoutTask*` | 超时检测定时任务 |
| `VMOperationQueue::_queue[SafepointPriority/MediumPriority]` | vmThread.hpp:50 | `VM_Operation*[2]` | 双优先级队列哨兵 |
| `VMOperationQueue::_queue_counter` | vmThread.hpp:49 | `int` | 10:1 防饥饿计数器 |
| `SafepointMechanism::_polling_type` | safepointMechanism.hpp:39 | `PollingType` | global_page 或 thread_local |
| `SafepointMechanism::_poll_armed_value` | safepointMechanism.hpp:40 | `void*` | 武装值（写 poll_bit） |
| `SafepointMechanism::_poll_disarmed_value` | safepointMechanism.hpp:41 | `void*` | 解除值（无 poll_bit） |
| `ServiceThread::_instance` | serviceThread.hpp:38 | `ServiceThread*` | 单例 |
| `ServiceThread::_jvmti_service_queue` | serviceThread.hpp:40 | `JvmtiDeferredEventQueue` | JVMTI 延迟事件队列 |
| `PerfDataManager::_all` | perfData.cpp:40 | `PerfDataList*` | 所有 PerfData 项 |
| `PerfDataManager::_sampled` | perfData.cpp:41 | `PerfDataList*` | 需采样项 |
| `PerfDataManager::_constants` | perfData.cpp:42 | `PerfDataList*` | 常量项 |

### Syscall Quick Reference

| syscall | man | 用途 | 调用上下文 |
|---------|-----|------|-----------|
| `futex(2)` | `man 2 futex` | Monitor::wait/notify 底层实现 | VMOperationQueue_lock, VMOperationRequest_lock, Service_lock |
| `mprotect(2)` | `man 2 mprotect` | polling page 保护 | SafepointMechanism::default_initialize() → os::protect_memory() |
| `mmap(2)` | `man 2 mmap` | polling page 分配 | os::reserve_memory() → anon mmap |
| `gettid(2)` | `man 2 gettid` | PerfData 共享内存文件命名 | PerfMemory::create_memory_region() |
| `shm_open(3)` | `man 3 shm_open` | PerfData 共享内存 | `/tmp/hsperfdata_<pid>` 文件创建 |
| `ftruncate(2)` | `man 2 ftruncate` | 共享内存大小设置 | PerfMemory::create_memory_region() |
| `clock_gettime(2)` | `man 2 clock_gettime` | os::elapsed_counter() 底层 | elapsedTimer, PerfTraceTime |
| `signal(2)` / `sigaction(2)` | `man 2 sigaction` | VM 操作超时信号 | AbortVMOnVMOperationTimeout |

### Key Locks

| Lock | 类型 | 保护范围 |
|------|------|---------|
| `VMOperationQueue_lock` | Monitor | VM 操作队列读写 |
| `VMOperationRequest_lock` | Monitor | 发起线程等待操作完成 |
| `Service_lock` | Monitor | ServiceThread 等待事件 |
| `PerfDataManager_lock` | Mutex | PerfData 列表操作 |
| `_terminate_lock` | Monitor | VMThread 终止同步 |

---

## §三 Source Files Table

| 文件 | 行数 | 关键类/函数 | 职责 |
|------|:---:|------------|------|
| `vmThread.hpp` | 189 | `VMThread`, `VMOperationQueue`, `VMOperationTimeoutTask` | VMThread 接口定义 |
| `vmThread.cpp` | 818 | `VMThread::loop()` (:465), `VMThread::execute()` (:686), `VMOperationQueue::add()` (:156), `VMOperationQueue::remove_next()` (:176) | VMThread 主循环 + 队列操作 |
| `vmOperations.hpp` | 534 | `VM_Operation` 基类 (:134), `VM_OPS_DO` 宏 (:48), `VM_PrintThreads` (:384), `VM_ThreadDump` (:452), `VM_FindDeadlocks` (:430), `VM_Exit` (:483) | 40+ VM_Operation 子类 |
| `vmOperations.cpp` | 515 | `VM_Operation::evaluate()` (:58), `VM_ThreadStop::doit()` (:101), `VM_Deoptimize::doit()` (:121) | VM_Operation 实现 |
| `javaCalls.hpp` | 271 | `JavaCalls`, `JavaCallWrapper`, `JavaCallArguments` | Java 方法调用接口 |
| `javaCalls.cpp` | 649 | `JavaCallWrapper::ctor/dtor` (:56), `call_virtual` (:190), `call_special` (:235), `call_static` (:270), `call_helper` (:354) | JavaCalls 实现 |
| `interfaceSupport.inline.hpp` | 605 | `ThreadStateTransition`, `ThreadBlockInVM`, `ThreadInVMfromJava`, `ThreadInVMfromNative`, `ThreadInVMForHandshake` | 线程状态转换 RAII |
| `serviceThread.hpp` | 60 | `ServiceThread`, `JvmtiDeferredEvent` | ServiceThread 接口 |
| `serviceThread.cpp` | 186 | `ServiceThread::service_thread_entry()` (:90), `ServiceThread::initialize()` (:51) | ServiceThread 实现 |
| `safepointMechanism.hpp` | 94 | `SafepointMechanism` | Poll 机制接口 |
| `safepointMechanism.cpp` | 122 | `SafepointMechanism::default_initialize()` (:42), `SafepointMechanism::block_if_requested_slow()` (:94) | Poll 机制实现 |
| `timer.hpp` | 99 | `elapsedTimer`, `TimeStamp`, `TraceCPUTime`, `TimeHelper` | 计时工具 |
| `timer.cpp` | 178 | `elapsedTimer::start/stop` (:66-78), `TimeStamp::update` (:102) | 计时器实现 |
| `perfData.hpp` | 973 | `PerfData`, `PerfLong`, `PerfLongConstant`, `PerfLongCounter`, `PerfLongVariable`, `PerfStringConstant`, `PerfDataManager`, `PerfTraceTime` | PerfData 类型系统 |
| `perfData.cpp` | 622 | `PerfData::create_entry()` (:125), `PerfDataManager::add_item()` (:296), `PerfDataManager::create_long_counter()` (:506) | PerfData 实现 |

---

## §四 Deep Dive Question Groups

### Group 1: VMOperationQueue — 双优先级双向循环链表

**WHY**: 为什么队列选择双向循环链表而非 stl::deque 或数组？
- 哨兵节点设计：`_queue[prio]` 是 dummy 节点，队列为空时 `head->next() == head`（`vmThread.cpp:72`）
- 非阻塞 peek：`queue_peek()` 用 `_queue_length[prio] > 0` 无锁查询（`vmThread.hpp:68`）
- 内存分配：所有 VM_Operation 都是 CHeapObj，队列只存指针

**Counterfactual**: 如果改用 `std::priority_queue<VM_Operation*>` 会有什么问题？(1) 无法 O(1) drain 整个优先级队列；(2) 无法在 safepoint 期间无锁 peek；(3) 无法支持 oops_do 遍历——GC 时需要扫描队列中 VM_Operation 持有的 oop 引用。

**分析要求**：
- 画出 `VMOperationQueue` 数据结构的内存布局图（哨兵节点 + next/prev 指针）
- 解释 `queue_add_back` (:92) vs `queue_add_front` (:87) 的策略差异——为什么 safepoint 操作 add_back（FIFO）？
- `drain_at_safepoint_priority()` (:114) 如何一次性取出整条链表？尾部哨兵如何重新闭合？
- `remove_next()` (:176) 中的 10:1 防饥饿调度详解：`_queue_counter++ < 10` 时优先取 SafepointPriority，否则取 MediumPriority
- GC 安全性：`oops_do()` (:202) 遍历 2 个队列 + drain_list 中的所有 VM_Operation

### Group 2: VM_Operation 4 种执行模式

**WHY**: 为什么需要 `_safepoint` / `_no_safepoint` / `_concurrent` / `_async_safepoint` 四种模式？
- `_safepoint`：阻塞调用线程，在 safepoint 中执行（如 GC, deoptimization）。调用线程通过 `vm_operation_ticket()` + `VMOperationRequest_lock->wait()` 等待完成
- `_no_safepoint`：阻塞调用线程，但不在 safepoint 中执行。调用线程也在 VMThread 执行期间阻塞
- `_concurrent`：非阻塞，操作在 VMThread 中执行，调用线程立即返回。操作对象必须是 `is_cheap_allocated()` → 由 VMThread delete
- `_async_safepoint`：非阻塞 + safepoint 执行。`evaluate_at_safepoint()` 和 `evaluate_concurrently()` 都返回 true

**Counterfactual**: 如果把 `_concurrent` 模式改为在调用线程中直接执行（不用 VMThread），会有什么后果？(1) 并发安全问题——可能和 GC 线程竞争；(2) 失去对 VM 全局状态的独占访问保证；(3) JFR 事件无法正确定义 caller。

**分析要求**：
- 列出 VM_OPS_DO 宏中至少 20 个代表性操作的 `type()` / `evaluation_mode()` / `allow_nested_vm_operations()` 三要素
- 追踪 `VM_ThreadStop` 为什么是 `_async_safepoint`（`:247-248`）——非阻塞线程停止语义
- 解释 `VMThread::execute()` (:686) 中对 4 种模式的分支处理：concurrent → 不入队直接返回？non-concurrent → ticket 等待
- doit_prologue/doit_epilogue 的生命周期：prologue 在调用线程执行（如 `VM_PrintThreads` 获取 Heap_lock），epilogue 在调用线程执行释放锁
- nested VM operations：`allow_nested_vm_operations()` 机制——为什么 `VM_Deoptimize` 允许嵌套但普通 GC 不行

### Group 3: VMThread 主循环 — wait→execute→notify 三段式

**WHY**: 为什么 VMThread::loop() 需要 `GuaranteedSafepointInterval` 超时强制 safepoint？
- 如果长时间没有 VM 操作入队，Java 线程可能无限运行而从未到达 safepoint
- `no_op_safepoint_needed()` (:445) 判断条件：(1) `SafepointALot` (2) `is_cleanup_needed()` (3) `GuaranteedSafepointInterval` 超时
- 超时等待使用 `VMOperationQueue_lock->wait(timeout)` 而非 `sleep()`——可被即时入队操作打断

**Counterfactual**: 如果没有 `GuaranteedSafepointInterval` 机制会怎样？(1) JIT 编译方法永远不会被 sweep/flush；(2) 偏向锁撤销永远延迟；(3) ThreadLocalHandshakes 操作可能无限延期。

**分析要求**：
- `VMThread::loop()` (:465-659) 完整执行流分析，标注每个分支
- 批量合并优化 (:527-609)：当取出 safepoint 操作后，`drain_at_safepoint_priority()` 一次性取出所有排队 safepoint 操作，在一个 safepoint 中全部执行
- 为什么 safepoint 操作执行完后还要 peek 一次队列（`:601`）？因为释放 `VMOperationQueue_lock` 后、safepoint 开始前，其他线程可能又入队了 safepoint 操作
- `SelfDestructTimer` 自毁机制 (:504-508)
- VMThread 终止流程：`_should_terminate` → break loop → 最终 safepoint → `VerifyBeforeExit` → `set_should_block()` 编译线程 → `wait_for_threads_in_native_to_block()` → 通知 `_terminate_lock`

### Group 4: javaCalls — 从 VM 调用 Java 方法

**WHY**: 为什么所有 VM→Java 调用必须经过 `JavaCallWrapper` 栈对象？
- `JavaCallWrapper` 构造函数 (:56-118) 执行：分配新 handle block → 线程状态转换 `_thread_in_vm → _thread_in_Java` → 处理异步异常 → 保存/清除 frame anchor → 设置新 active_handles
- 析构函数 (:121-153) 执行反向操作：恢复 handle block → `_thread_in_Java → _thread_in_vm` → 恢复 frame anchor → 释放旧 handle block
- 确保 **GC 安全性**：帧锚点信息让 GC 能 walk Java 调用栈

**Counterfactual**: 如果 VMThread 直接 call Java 方法而不经过 JavaCallWrapper？(1) 没有活跃 handle block → 分配的 handle 互相覆盖；(2) 没有 frame anchor 保存/恢复 → GC 扫描时找不到 Java 栈帧；(3) 线程状态不对 → safepoint 协议看不到 VMThread 正在运行 Java 代码。

**分析要求**：
- `call_virtual` / `call_special` / `call_static` 三者的 LinkResolver 差异：
  - `call_virtual` → `resolve_virtual_call` → vtable/itable 查找
  - `call_special` → `resolve_special_call` → 精确方法查找
  - `call_static` → `resolve_static_call` → 静态方法
- `call_helper()` (:354-479) 的完整流程：编译策略检查 → entry_point 确定 → 栈溢出检查 → StubRoutines::call_stub() → 结果保存
- `JavaCallArguments` 的参数编码：`_value_state` 区分 primitive/oop/handle/jobject 四种类型
- `construct_new_instance()` (:312) 的 new+<init> 两步操作
- 为什么 `JavaCallWrapper` 构造函数中先 `transition` 再保存 `_callee_method` 和 `_receiver`（`:85-86`）？因为 transition 可能阻塞（safepoint check），由于引用是裸 oop，必须在 transition 之后再保存

### Group 5: interfaceSupport — 线程状态转换 RAII

**WHY**: 为什么线程状态转换必须遵循 `from → from+1 → check safepoint → to` 四步协议？
- 中间过渡态（如 `_thread_in_native_trans`）是 safepoint 协议的**关键可见性标记**
- SafepointSynchronize 通过检查线程的 `thread_state()` 判断是否已到达安全状态
- `transition()` (:114-128)：先写 `from+1` → `serialize_thread_state`（内存屏障/序列化页写入）→ `block_if_requested`（如果有 safepoint 请求则阻塞）→ 写 `to`

**Counterfactual**: 如果直接 `from → to` 不经过过渡态？(1) SafepointSynchronize 可能在线程写到 `to` 之前就检查通过——线程还没准备好被 GC 扫描；(2) 过渡态给 SafepointSynchronize 一个"等待窗口"——看到 `_thread_in_native_trans` 时知道线程正在转换，应等待。

**分析要求**：
- 6 个主要 RAII 类的状态转换图：
  - `ThreadInVMfromJava`：`_thread_in_Java → _thread_in_vm` → 析构时反向
  - `ThreadInVMfromNative`：`_thread_in_native → _thread_in_native_trans → check → _thread_in_vm`
  - `ThreadBlockInVM`：`_thread_in_vm → _thread_blocked`（需要 `make_walkable`）
  - `ThreadToNativeFromVM`：`_thread_in_vm → _thread_in_native`（需要 `make_walkable`）
  - `ThreadInVMfromUnknown`：运行时判断 `thread_state()` 选择转换路径
  - `ThreadInVMForHandshake`：任意状态 → `_thread_in_vm` → 执行 handshake → 恢复原状态
- 每种转换的序列化策略：`serialize_thread_state`（无 SEH）vs `serialize_thread_state_with_handler`（有 SEH）
- `transition_from_native` (:158-177) 的特殊处理：为什么先 `check_safepoint_and_suspend_for_native_trans` 才设置最终状态？
- 宏体系（JRT_ENTRY/JNI_ENTRY/JVM_ENTRY/IRT_ENTRY）如何选择正确的 RAII 守卫

### Group 6: ServiceThread — 后台任务调度器

**WHY**: 为什么需要 ServiceThread 而非在 VMThread 中处理这些任务？
- 低内存检测、JVMTI 事件通知、GC 通知都是**非 safepoint 操作**——在 VMThread 中处理会阻塞真正的 VM 操作
- ServiceThread 使用 `ThreadBlockInVM` 睡眠，不参与 safepoint 协议——可以在 safepoint 期间被唤醒执行
- 各子系统通过 `Service_lock->notify_all()` 唤醒 ServiceThread

**Counterfactual**: 如果低内存检测和 JVMTI 事件都在 VMThread 中处理？(1) VMThread 需要遍历所有内存传感器，增加每个 VM 操作的延迟；(2) safepoint 期间 ServiceThread 不能运行意味着 GC 通知可以立即发送——当前设计允许在 safepoint 中进行 GC 通知。

**分析要求**：
- `service_thread_entry()` (:90-149) 的 5 个检查分支：`LowMemoryDetector` / `_jvmti_service_queue` / `GCNotifier` / `DCmdFactory` / `StringTable`
- 为什么 JVMTI 事件要在 `Service_lock` 作用域内 dequeue 到局部变量（`:121-125`）？防止在 `post()` 调用期间锁竞争
- `ServiceThread::initialize()` (:51-88) 的创建流程：构造 JavaThread → 设置 threadObj → 加入 Threads 列表 → 启动
- 为什么 `is_hidden_from_external_view()` 返回 true？Thread.getAllStackTraces() 需要过滤掉内部线程
- GC 安全性：`oops_do()` (:161-173) 和 `nmethods_do()` (:175-185) 需要扫描 JVMTI 延迟事件队列

### Group 7: safepointMechanism — 两种轮询实现

**WHY**: 为什么 ThreadLocalHandshakes 引入 per-thread poll？
- 全局 poll page 的 mprotect 操作是**全局系统调用**——所有线程的 TLB 失效 → 性能代价随核心数增长
- thread-local poll 只需修改目标线程的 `_local_poll` 字段——纯内存操作，O(1)，无系统调用
- `_poll_bit = 8` 的设计：利用 poll page 地址的 bit 3 区分 arm/disarm

**Counterfactual**: 如果只保留 global page poll 而不支持 thread-local poll？(1) 无法实现 per-thread handshake——全局 poll 会停止所有线程，handshake 只需停止一个线程；(2) 大规模机器上频繁 safepoint 的 TLB shootdown 开销无法忽略。

**分析要求**：
- `default_initialize()` (:42-91) 的两种初始化路径：
  - Global page：单页 `os::protect_memory(... PROT_READ)` —— arm 时 mprotect 为 PROT_NONE
  - Thread-local：双页（bad_page + good_page）+ poll_bit 掩码
- `arm_local_poll()` / `disarm_local_poll()` 的 inline 实现——直接写线程的 `_local_poll` 地址
- `poll()` 的分发逻辑：thread-local → `local_poll(thread)`（读 `_local_poll` 检查 bit）；global → `global_poll()`（读全局 polling page）
- `block_if_requested()` → `block_if_requested_slow()` → `global_poll()` 检查 + `has_handshake()` 检查
- `initialize_serialize_page()` (:108-116) 的内存序列化页作用——替代 `UseMembar` 的内存屏障

### Group 8: PerfData — 性能计数器系统

**WHY**: 为什么 PerfData 需要 Separate Memory Region（`/tmp/hsperfdata_<pid>`）？
- 外部工具（jstat, VisualVM）需要通过共享内存读取计数器，不必通过 JVM 进程
- 双存储模型：JVM 堆上的 C++ PerfData 对象（_valuep 指针）→ PerfMemory 中的 PerfDataEntry（共享内存布局）
- `PerfData::create_entry()` (:125-188) 在 PerfMemory 中分配空间：`[PerfDataEntry header | name string | padding | data array]`

**Counterfactual**: 如果 PerfData 只在进程内存储（无共享内存）？(1) jstat 无法通过 mmap 读取——必须通过 socket/pipe 通信；(2) 进程崩溃后性能数据无法事后分析；(3) 容器化环境的多进程监控无法实现。

**分析要求**：
- 类层次结构：`PerfData → PerfLong → PerfLongVariant → PerfLongCounter/PerfLongVariable`；`PerfByteArray → PerfString → PerfStringConstant/PerfStringVariable`
- 三种变异性（Variability）：`V_Constant`（创建后不可变）、`V_Monotonic`（单调递增/递减）、`V_Variable`（任意修改）
- 六种单位（Units）：`U_None/U_Bytes/U_Ticks/U_Events/U_String/U_Hertz`
- 三级命名空间稳定性：`java.*`（稳定支持）/ `com.sun.*`（不稳定但支持）/ `sun.*`（不稳定不支持）
- `PerfDataManager` 的三个列表：`_all`（全部）、`_sampled`（周期性采样）、`_constants`（常量）
- `PerfTraceTime` RAII 类：构造时 start timer → 析构时 stop + inc counter
- `StatSampler` 的采样机制：`PerfLongVariant::sample()` 调用 `_sample_helper->take_sample()` 或读取 `_sampled` 指针
- `/tmp/hsperfdata_<pid>` 文件格式：PerfMemory 的共享内存布局

**每个 Group 必须包含的 Counterfactual 已在上方标注。**

---

## §五 Article Structure

```
# 02-VM Thread, VM Ops & Service Infrastructure

## §〇 概述与全景图
八子系统关系图 + 执行流时序图（JavaThread→VMThread→safepoint）

## §一 VMOperationQueue — 双优先级队列引擎
- 双向循环链表数据结构（哨兵节点）
- add/remove_next/drain 核心操作
- 10:1 防饥饿调度
- GC 安全性（oops_do）

## §二 VM_Operation 类型系统
- 40+ 子类总览表（type, mode, allow_nested, is_cheap）
- 四种执行模式生命周期
- doit_prologue/epilogue 协议
- 嵌套操作（allow_nested_vm_operations）

## §三 VMThread 主循环与生命周期
- loop() wait→execute→notify 详细分析
- 批量合并优化（coalescing）
- no_op_safepoint_needed 三种触发条件
- VMThread 启动/终止流程
- VMOperationTimeoutTask 超时机制

## §四 javaCalls — Java 方法调用路径
- JavaCallWrapper 栈帧管理
- call_virtual/special/static 三种调用约定
- call_helper 完整执行流
- JavaCallArguments 参数编码
- construct_new_instance 两步分配

## §五 interfaceSupport — 线程状态转换 RAII
- 6 类转换器状态图
- from→trans→to 三态协议
- 序列化机制（membar vs serialize page）
- 宏体系（JRT/JNI/JVM/IRT）

## §六 ServiceThread — 后台服务调度
- service_thread_entry 5 分支循环
- 低内存检测 / JVMTI 事件 / GC 通知 / DCmd / StringTable
- initialize 创建流程
- GC 安全性（oops_do/nmethods_do）

## §七 safepointMechanism — 安全点轮询
- Global page poll vs Thread-local poll
- default_initialize 双页布局
- arm/disarm 的底层实现
- block_if_requested 的分发逻辑
- Serialize page 的内存屏障替代

## §八 PerfData — 性能计数器基础设施
- 类层次与三种变异性
- PerfMemory 共享内存布局
- PerfDataEntry 结构
- PerfDataManager 工厂方法
- PerfTraceTime RAII 计时
- /tmp/hsperfdata_<pid> 文件格式

## §九 诊断与调试
- strace 跟踪 futex/mprotect 调用
- jcmd VM.command_line / VM.system_properties
- jstat -gcutil <pid> 与 PerfData 的关系
- GDB 断点 + 数据结构遍历
- /proc/<pid>/maps 查看 Polling page / PerfMemory
- hsperfdata 文件 hexdump 分析

## §十 边缘场景与竞态
- VMThread 退出与 safepoint 的竞态
- ServiceThread 在 safepoint 期间被唤醒
- PerfData 创建与销毁的并发安全
- 嵌套 VM_Operation 的死循环防护
- VMOperationTimeoutTask 的 false positive

## §十一 跨文档连接
- 与 08-safepoint 的关系：safepointMechanism 是实现细节
- 与 07-thread-lock 的关系：ThreadStateTransition 的 monitor 配合
- 与 05-jit-compiler 的关系：VM_Deoptimize 触发去优化
```

---

## §六 Writing Requirements

### "不要写成 → 应该写成" 对照表（≥8 行）

| # | 不要写成 | 应该写成 |
|---|---------|---------|
| 1 | 不要写成源码逐行注释翻译（"第 465 行开始 while 循环，第 474 行获取锁..."） | 应该用**执行流叙事**描述 VMThread::loop() 的 wait→execute→notify 三段式，只在关键决策点引用 `:line` |
| 2 | 不要写成 VM_OPS_DO 宏的机械展开列表 | 应该按**操作类别**（GC/诊断/去优化/BIAS/SHENANDOAH/特殊）分组，标注每个子类的 mode + allow_nested + is_cheap |
| 3 | 不要写成"ThreadBlockInVM 的作用是阻塞线程" | 应该描述**状态转换协议**：为什么 `make_walkable` 必须先于状态修改，为什么 `transition_and_fence` 需要 fence/serialize_page，引用 `interfaceSupport.inline.hpp:299-309` |
| 4 | 不要写成"JavaCallWrapper 分配 handle block 然后转换状态" | 应该解释**顺序依赖**：为什么 handle block 分配必须在 transition 之前（`:66`），为什么 `_callee_method` 赋值必须在 transition 之后（`:85`） |
| 5 | 不要写成"VMOperationQueue 是一个链表队列" | 应该画**内存布局图**：哨兵节点 `_queue[prio]` → 循环链表 → drain_list。解释为什么队列为空时 `head->next() == head` |
| 6 | 不要写成"ServiceThread 处理 GC 通知和 JVMTI 事件" | 应该描述**事件循环的五分支结构**和**锁释放时机**：为什么 JVMTI 事件要在 Service_lock 内 dequeue 到局部变量再 post |
| 7 | 不要写成"PerfData 有三种变异性" | 应该按**类层次**自顶向下展开：`PerfData → PerfLong → PerfLongVariant → PerfLongCounter/PerfLongVariable`，并在每个层次标注构造链和 `create_entry()` 的共享内存分配 |
| 8 | 不要写成"safepointMechanism 负责轮询" | 应该解释**两种 poll 的物理实现差异**：global page → `os::protect_memory()` 系统调用；thread-local → 直接写内存地址。并量化性能差异 |
| 9 | 不要写成模板化的"GDB 命令：p *(VMThread*)_vm_thread" | 应该给出**具体的、可运行的** GDB 命令链：断点位置 → 单步路径 → 预期输出 → 输出解读 |
| 10 | 不要写成"timer.hpp 定义了几个计时类" | 应该用**使用场景**驱动：`elapsedTimer` 用于 VM 操作耗时统计（`PerfTraceTime`）→ `TimeStamp` 用于事件时间戳 → `TraceCPUTime` 用于打印输出 |

### 写作原则

1. **源码是证据（20%），原理是正文（80%）**：每个技术断言必须标注 `file:line`，但解释应聚焦于设计原理、权衡和边界条件
2. **执行流驱动**：以 VM_Operation 完整生命周期为主线，子系统按执行顺序介绍
3. **Counterfactual 必含**：每个 §四 Group 指定了至少一个 counterfactual 问题，正文必须回答
4. **代码引用格式**：`函数名() function_file.cpp:line` 或 `ClassName::method() file.cpp:line`
5. **量化对比**：thread-local poll vs global page poll 的性能差异、批量合并的 safepoint 减少比例（理论模型给出数量级估计）
6. **man 手册引用**：所有 syscall 标注 `man 2/syscall`，如 `futex(2)`、`mprotect(2)`、`mmap(2)`

---

## §七 Output Format

### 文件格式
- 单文件 Markdown：`probe_md/26-runtime-extra/docs/02-VM-Thread-Ops-Services.md`
- 标题格式：`# 02-VM Thread, VM Ops & Service Infrastructure — 运行时基础设施层`
- Section 编号：`## §〇` 到 `## §十一`

### 代码引用格式
```
VMOperationQueue::remove_next() vmThread.cpp:176-200  ← 函数级引用
interfaceSupport.inline.hpp:299-309                     ← 行范围引用
```

### Callout 框格式（≥10 个，仅在 §一 内）
```
> **Callout N: 标题**
> 内容...
```

### 内联引用格式
```
`VMThread::loop()` 在 (:465) 开始主循环...
```

### 总行数目标
≥3500 行（8 个子系统各 ~400 行 + 诊断 ~200 行 + 边缘场景 ~200 行 + 连接 ~100 行）

---

## §八 Prohibited（≥8 条）

1. **禁止输出空壳 Section**：每个 ## § 必须有 ≥3 段实质性内容（代码引用 + 解释 + 设计原理）
2. **禁止纯源码翻译**：不能出现"接着调用 xxx 函数，然后调用 yyy 函数"的枚举式描述；必须解释为什么按此顺序调用，每个步骤的设计目的
3. **禁止遗漏 counterfactual**：§四 的 8 个 Group 每个都有 counterfactual，正文中必须回答
4. **禁止不标注 file:line**：每个技术断言（函数调用、数据结构访问、状态转换）必须标注源码位置
5. **禁止在 §一 之外使用 Callout 框**：§一 是唯一合法位置；后续 section 使用 `> **注意**` 或 `> **关键**` 块引用标注重要内容
6. **禁止使用模糊描述**：不能说"性能很好"；必须给出量化数据（如"thread-local poll 消除 mprotect 系统调用，在大规模机器上减少 ~X μs arm 延迟"）
7. **禁止重复 §二 的内容**：不要复制粘贴 Source Files Table；后续 section 需要引用的用 `file:line` 格式
8. **禁止泛泛而谈的"诊断工具"段落**：§九 必须给出可运行的命令（完整参数）、可预期的输出、输出解读方法
9. **禁止忽略 GC 安全性**：每个涉及 oop 引用的子系统（VMOperationQueue, ServiceThread）必须解释 oops_do 如何与 GC 协作
10. **禁止在 §六 中列出空话条目**：每个 "不要写成→应该写成" 行必须有具体的反面例子和正面例子（至少包含 file:line 引用）

---

## §九 Required（≥8 条）

1. **必须含完整执行流时序图**：§〇/§一 中绘制 JavaThread→VMOperationQueue→VMThread::loop()→safepoint→evaluate 的 ASCII 时序图
2. **必须列出 40+ VM_Operation 子类的分类表**：按 GC/诊断/去优化/偏斜锁/Shenandoah/其他分组，标注 mode + allow_nested + is_cheap
3. **必须含 VMOperationQueue 内存布局图**：双向循环链表、哨兵节点、drain_list 的 ASCII 图示
4. **必须含 6 类 ThreadStateTransition 的状态转换图**：from→trans→to 的 ASCII 状态机图
5. **必须含 PerfData 类层次结构图**：从 PerfData 到 PerfLongCounter/PerfStringConstant 的继承树 ASCII 图
6. **必须含 ServiceThread 的事件循环流程图**：5 个检查分支 + 锁范围的 ASCII 流程图
7. **必须含 safepointMechanism 双页布局的内存图**：bad_page (PROT_NONE) + good_page (PROT_READ) 的地址关系
8. **必须含 /tmp/hsperfdata_<pid> 文件的内存布局图**：PerfDataEntry header + name + data 的对齐策略
9. **必须含诊断命令与预期输出**：每个诊断工具（strace/jcmd/jstat/GDB）给出完整命令 + 关键输出行 + 解读
10. **必须标注每个 syscall 的 man 手册来源**：futex(2), mprotect(2), mmap(2), shm_open(3), ftruncate(2), clock_gettime(2)
11. **必须横向对比 VMThread vs ServiceThread**：线程类型/参与 safepoint/处理操作/睡眠方式/可见性 五维度对比表
12. **必须验证子系统完整性**：确认所有 8 个子系统的关键函数都已覆盖，无遗漏

---

## §十 GDB Verification（≥7 断言）

**前提**：已有运行的 HotSpot JVM 进程（pid），编译了 debug 符号的 libjvm.so。

### 断言 1：VMThread 单例存在
```gdb
(gdb) print VMThread::_vm_thread
$1 = (VMThread *) 0x7f...  # 非 NULL，单例
(gdb) print VMThread::_vm_thread->name()
$2 = "VM Thread"  # 验证线程名
```

### 断言 2：VM_Operation 队列状态查询
```gdb
(gdb) print VMThread::_vm_queue
(gdb) print VMThread::_vm_queue->_queue_length[0]  # SafepointPriority 长度
(gdb) print VMThread::_vm_queue->_queue_length[1]  # MediumPriority 长度
(gdb) print VMThread::_vm_queue->_queue_counter    # 防饥饿计数器
(gdb) print *VMThread::_vm_queue->_queue[0]        # 遍历 safepoint 队列哨兵
```

### 断言 3：当前 VM_Operation 信息
```gdb
(gdb) print VMThread::_cur_vm_operation
(gdb) print VMThread::_cur_vm_operation->name()       # 操作名
(gdb) print VMThread::_cur_vm_operation->evaluation_mode()  # 执行模式
(gdb) print VMThread::_cur_vm_operation->calling_thread()   # 发起线程
```

### 断言 4：Safepoint 轮询机制类型
```gdb
(gdb) print SafepointMechanism::_polling_type
# 0 = _global_page_poll, 1 = _thread_local_poll
(gdb) print SafepointMechanism::_poll_armed_value
(gdb) print SafepointMechanism::_poll_disarmed_value
(gdb) print SafepointMechanism::_poll_bit  # 应返回 8
```

### 断言 5：ServiceThread 实例
```gdb
(gdb) print ServiceThread::_instance
(gdb) print ServiceThread::_instance->name()
$3 = "Service Thread"
(gdb) print ServiceThread::_instance->thread_state()
# 预期 _thread_blocked 或 _thread_in_vm
(gdb) print ServiceThread::_jvmti_service_queue  # 检查 JVMTI 事件队列
```

### 断言 6：PerfData 计数器查询
```gdb
(gdb) print PerfDataManager::_all
(gdb) print PerfDataManager::_all->length()     # 计数器总数
(gdb) print PerfDataManager::find_by_name("sun.threads.vmOperationTime")
(gdb) print ((PerfLongCounter*)PerfDataManager::find_by_name("sun.threads.vmOperationTime"))->get_value()
```

### 断言 7：线程状态转换验证
```gdb
# 断点设在 ThreadBlockInVM 构造函数
(gdb) break ThreadBlockInVM::ThreadBlockInVM
(gdb) continue
# 在断点处检查
(gdb) print ((JavaThread*)$rdi)->thread_state()
# 预期 _thread_in_vm
(gdb) finish
(gdb) print ((JavaThread*)$rdi)->thread_state()
# 预期 _thread_blocked
(gdb) print ((JavaThread*)$rdi)->frame_anchor()->_last_Java_sp
# 非 NULL — make_walkable 已完成
```

### 断言 8：VMOperationQueue 遍历
```gdb
(gdb) set $sentinel = VMThread::_vm_queue->_queue[0]
(gdb) set $cur = $sentinel->next
(gdb) while $cur != $sentinel
> print $cur->name()
> set $cur = $cur->next
> end
# 打印所有 SafepointPriority 队列中的 VM 操作名
```

---

## §十一 与 README 和同组 prompt 的连续性

### 与 README (`probe_md/26-runtime-extra/README.md`) 的关系
- 本文档对应 README 中 **doc-02: VM Thread, VM Ops & Service Infrastructure**
- 覆盖源文件：vmThread, vmOperations, javaCalls, interfaceSupport, timer, statSampler, serviceThread, safepointMechanism, perfData（10 个文件，~4,100 行源码）
- README 中标记的关键问题：
  1. VM Thread 主循环：wait → execute → notify 消息驱动 ✓
  2. VM_Operation 继承树（40+ 子类）和优先级队列 ✓
  3. VM_Operation::evaluate_at_safepoint() vs evaluate_concurrently() ✓
  4. javaCalls 的 call_virtual/call_static/call_special 三层 ✓
  5. ThreadBlockInVM/ThreadInVMfromNative/ThreadInVMfromJava RAII 转换 ✓
  6. PerfData 计数器模型和 /tmp/hsperfdata 文件 ✓

### 与 doc-00 (Handshake & ThreadSMR) 的边界
- **safepointMechanism 只覆盖 poll 机制的 arm/disarm 实现**，不涉及 Handshake 协议本身
- doc-00 的 HandshakeClosure + HandshakeState 通过 `thread->has_handshake()` 与 safepointMechanism 协作
- `SafepointMechanism::block_if_requested_slow()` (:94-102) 调用 `thread->handshake_process_by_self()` 是边界交叉点

### 与 doc-01 (JVM Flag System) 的关系
- `AbortVMOnVMOperationTimeout` / `AbortVMOnVMOperationTimeoutDelay` → VMOperationTimeoutTask
- `GuaranteedSafepointInterval` → VMThread::loop() 超时逻辑
- `ThreadLocalHandshakes` → safepointMechanism 模式选择
- `UsePerfData` → PerfData 启用判断

### 与已有文档的重叠
- `libjvm-analysis/08-safepoint/` 覆盖 SafepointSynchronize 协议，本文档的 safepointMechanism 是其底层实现补充
- `libjvm-analysis/07-thread-lock/` 覆盖线程生命周期，本文档的 interfaceSupport 是线程状态转换的 RAII 实现
- 旧文档标记**互补**，本文档不做重复覆盖，仅交叉引用
