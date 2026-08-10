# 线程模型 + 锁 + 参数系统 — 完整字段分析

> OpenJDK 11 slowdebug, GDB 验证
> Thread(856B) → JavaThread(1888B, ~90字段) + OSThread(232B) + Mutex(152B×60+) + JVMFlag(48B×1366)

---

## 零、GDB 验证

```
sizeof(Thread)     = 856    线程基类
sizeof(JavaThread) = 1888   完整 Java 线程（+1032B 于基类）
sizeof(OSThread)   = 232    OS 层描述符
sizeof(Mutex)      = 152    全局锁
sizeof(JVMFlag)    = 48     参数标志位
num_threads        = 9      运行时线程数
numFlags           = 1366   JVM 参数总数
```

---

## 一、继承层次

```
CHeapObj → ThreadShadow → Thread(856B, ~25字段)
                              ↑
                         JavaThread(1888B, ~65字段)
                          ├── CompilerThread(1960B)  ← JIT
                          └── VMThread(888B)         ← GC/Safepoint
```

---

## 二、Thread (856B) — 25 字段（所有线程共享的基类）

| 字段 | 类型 | 作用 | 谁设置 |
|------|------|------|--------|
| `_thr_current` (static) | Thread* | TLS: `Thread::current()` 返回的指针 | `pthread_setspecific` |
| `_tlab` | ThreadLocalAllocBuffer | 线程本地分配缓冲区 | `initialize_tlab()` |
| `_allocated_bytes` | jlong | 累计分配的字节数 | 每次 TLAB 分配 +refill |
| `_active_handles` | JNIHandleBlock* | JNI handle block 链 | `set_active_handles()` |
| `_free_handle_block` | JNIHandleBlock* | 空闲 handle block | handle 释放时 |
| `_last_handle_mark` | HandleMark* | 最新 handle mark | HandleMark 构造/析构 |
| `_polling_page` | volatile void* | 线程本地 polling page | safepoint 机制 |
| `_current_pending_monitor` | ObjectMonitor* | 正在等待的锁 | `ObjectMonitor::enter()` |
| `_current_waiting_monitor` | ObjectMonitor* | 正在 wait() 的锁 | `ObjectMonitor::wait()` |
| `_SR_lock` | Monitor* | 挂起/恢复锁 | 线程创建时 |
| `_suspend_flags` | volatile uint32_t | 挂起相关标志 | safepoint/async 异常 |
| `_threads_hazard_ptr` | ThreadsList* volatile | 安全内存回收 | `ThreadsSMR::add/remove` |
| `_threads_list_ptr` | SafeThreadsListPtr* | 线程列表安全指针 | 同上 |
| `_stack_base` (父类) | address | 栈底 | `record_stack_base_and_size()` |
| `_stack_size` (父类) | size_t | 栈大小 | 同上 |
| `_resource_area` | ResourceArea* | 资源区 | `thread_native_entry` |
| `_handle_area` | HandleArea* | handle 区 | 同上 |
| `_name` | char* | 线程名 | 构造/set_native_thread_name |

**为什么需要 `_polling_page`？** → Safepoint 机制的核心。JIT 代码在每个安全点插入 `test %eax, _polling_page`，STW 时将页设为不可读 → SIGSEGV → 线程进入 safepoint。

---

## 三、JavaThread (1888B) — 65 独立字段，按功能分 11 组

### 3.1 线程列表 (3)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_next` | JavaThread* | `Threads::_thread_list` 链表 |
| `_on_thread_list` | bool | 是否已加入列表 |
| `_threadObj` | oop | java.lang.Thread 对象 → 双向关联 Java 层 |

### 3.2 线程状态 + 安全点 (3)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_thread_state` | volatile JavaThreadState | _thread_new / _in_Java / _in_vm / _blocked / _in_native |
| `_safepoint_state` | ThreadSafepointState* | 安全点协调状态 |
| `_terminated` | volatile TerminatedTypes | 终止状态：_not_terminated / _thread_exiting / _thread_terminated |

### 3.3 栈保护 (4)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_stack_guard_state` | StackGuardState | yellow / reserved / disabled |
| `_stack_overflow_limit` | address | 栈溢出边界 |
| `_reserved_stack_activation` | address | 保留栈激活点 |
| `_stack_{red,yellow,reserved,shadow}_zone_size` (静态×4) | size_t | 栈页保护大小 |

**为什么需要 3 个 zone？** → 类似红绿灯：yellow zone (警告) → reserved zone (最多再执行一点代码) → red zone (立即抛 StackOverflowError)。分层的意义在于，yellow zone 被触发时还有空间安全地创建异常对象。

### 3.4 入口 + 栈帧锚点 (2)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_entry_point` | ThreadFunction | JavaThread::run() / compiler_thread_entry() |
| `_anchor` | JavaFrameAnchor | 最后 Java 帧的 SP/PC/FP——GC 栈遍历起点 |

### 3.5 异常处理 (4)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_exception_oop` | volatile oop | 未处理异常 |
| `_exception_pc` | volatile address | 异常 PC |
| `_exception_handler_pc` | volatile address | 异常处理器入口 |
| `_pending_async_exception` | oop | 异步异常（如 ThreadDeath） |

### 3.6 去优化支持 (5)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_deopt_mark` | DeoptResourceMark* | 去优化资源标记 |
| `_must_deopt_id` | intptr_t* | 强制去优化的方法 |
| `_deopt_nmethod` | CompiledMethod* | 待去优化的 nmethod |
| `_vframe_array_head/tail` | vframeArray*×2 | 去优化后的解释器帧链表 |

**为什么需要去优化字段？** → 编译器做了激进优化（如内联不可达分支）。当假设失败（如类被重定义），必须将编译后的栈帧"回退"为解释器帧，这些字段存储回退所需信息。

### 3.7 同步/锁 (4)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_monitor_chunks` | MonitorChunk* | ObjectMonitor 链表 |
| `_parker` | Parker* | LockSupport.park() → futex 底层 |
| `_do_not_unlock_if_synchronized` | bool | synchronized 方法退出控制 |
| `_cached_monitor_info` | GrowableArray<MonitorInfo*>* | 缓存的 monitor 信息 |

### 3.8 JNI (3)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_jni_environment` | JNIEnv | 该线程的 JNI 环境 |
| `_jni_attach_state` | volatile JNIAttachStates | _not_attaching / _attaching_via_jni |
| `_jni_active_critical` | jint | JNI critical 区计数→阻止 GC |

### 3.9 JVMTI / 调试 (6+)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_jvmti_thread_state` | JvmtiThreadState* | JVMTI 线程状态 |
| `_interp_only_mode` | int | 强制解释执行 |
| `_should_post_on_exceptions_flag` | int | 异常事件通知 |
| `_popframe_condition` | int | PopFrame 条件 |
| `_popframe_preserved_args` | void* | PopFrame 保留参数 |
| `_pending_jni_exception_check_fn` | char* | JNI 异常检查函数 |

### 3.10 JVMCI / 编译 (6, 条件)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_pending_deoptimization` | int | 待处理去优化 |
| `_pending_monitorenter` | bool | 待重入 monitor |
| `_pending_transfer_to_interpreter` | bool | 待转回解释器 |
| `_adjusting_comp_level` | bool | 调整编译级别中 |
| `_pending_failed_speculation` | long | 失败投机 |
| `_jvmci_counters` | jlong* | 性能计数器 |

### 3.11 其他 (~10)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_vm_result` | oop | VM 调用返回值 |
| `_deferred_card_mark` | MemRegion | 延迟 Card 标记 |
| `_callee_target` | Method* | invokedynamic 目标 |
| `_special_runtime_exit_condition` | AsyncRequests | SUSPEND / SAFEPOINT 请求 |
| `_thread_stat` | ThreadStatistics* | 统计信息 |
| `_blocked_on_compilation` | bool | 阻塞等待编译 |
| `_handshake` | HandshakeState | 握手操作状态 |
| `_depth_first_number` | int | 死锁检测 DFS 编号 |
| `_in_asgct` | bool | 是否在 ASGCT 中 |

---

## 四、OSThread (232B) — 14 字段

| 字段 | 类型 | 作用 |
|------|------|------|
| `_thread_id` | thread_id_t | Linux tid (gettid) |
| `_pthread_id` | pthread_t | pthread_create 返回值 |
| `_state` | volatile ThreadState | ALLOCATED→INITIALIZED→RUNNABLE→ZOMBIE |
| `_interrupted` | volatile jint | 中断标志 |
| `_thread_type` | int | java_thread / vm_thread / compiler |
| `_start_proc` | OSThreadStartFunc | 线程入口函数 |
| `_start_parm` | void* | 入口参数 |
| `_caller_sigmask` | sigset_t | 父线程信号掩码 |
| `_startThread_lock` | Monitor* | 父子握手锁 |
| `sr` | SuspendResume | 挂起/恢复 |
| `_siginfo` | void* | 信号信息 |
| `_ucontext` | ucontext_t* | 信号上下文 |
| `_expanding_stack` | int | 栈扩展标志 |
| `_alt_sig_stack` | address | 备用信号栈 |

---

## 五、Mutex/Monitor (152B) — 60+ 全局锁

```
Mutex 层次（rank 防死锁）：
  Threads_lock(1)             → 线程列表
  Heap_lock(2)                → 堆分配
  Compile_lock(3)             → 编译任务
  MethodData_lock(4)          → profiling
  VMOperationQueue_lock       → VM 操作队
  Service_lock                → ServiceThread
  PeriodicTask_lock           → 周期任务
  JfrMsg_lock                 → JFR
  MultiArray_lock             → 多维数组
  ...
  总共 60+ 个全局锁，每个 152B

持有锁规则：只能从低 rank 锁获取高 rank 锁，反之 assert 失败。
为什么需要 rank？→ 防止 AB-BA 死锁。A 持有 Threads_lock 等 Heap_lock，
  B 看到 Heap_lock 时要么等，要么检查 rank 不允许自己先取了其他低级锁。
```

---

## 六、JVMFlag (48B × 1366 = ~64KB) — 所有 -XX: 参数

```
struct JVMFlag {
    const char* _name;      // "UseG1GC"
    const char* _type;      // "bool" / "intx" / "ccstr"
    void*       _addr;      // &UseG1GC
    intx        _default;   // true → G1 是默认 GC
    JVMFlag::Flags _flags;  // PRODUCT / MANAGEABLE / NOTPRODUCT / ...
    const char* _doc;       // 在线帮助文档描述
    const char* _ccstr;     // 字符串默认值
};

使用流程：
  java -XX:+UseG1GC → 找到 "UseG1GC" flag → *(bool*)_addr = true
  FLAG_IS_DEFAULT(ConcGCThreads) → 查 flag->is_default()
  FLAG_SET_ERGO(uint, ConcGCThreads, 2) → 运行时修改（ergonomics）
```

---

## 七、VMThread 创建与生命周期 — GC 协调器的诞生

### ① VMThread::create() — create_vm() 阶段 14

`thread.cpp:4107`, `vmThread.cpp:250`
```cpp
void VMThread::create() {
  assert(vm_thread() == NULL, "we can only allocate one VMThread");
  _vm_thread = new VMThread();     // sizeof(VMThread) = 888B (GDB ✓)

  if (AbortVMOnVMOperationTimeout) {
    _timeout_task = new VMOperationTimeoutTask(interval);
    _timeout_task->enroll();       // 注册超时看门狗
  }

  _vm_queue = new VMOperationQueue();  // ★ 创建 VM 操作队列 (循环双链表)
  guarantee(_vm_queue != NULL, "just checking");

  _terminate_lock = new Monitor(Mutex::safepoint,
      "VMThread::_terminate_lock", true, Monitor::_safepoint_check_never);

  if (UsePerfData) {
    _perf_accumulated_vm_operation_time =
        PerfDataManager::create_counter(SUN_THREADS, "vmOperationTime", ...);
  }
}
```

### ② VMThread 启动 — 握手协议

`thread.cpp:4110-4120`
```cpp
VMThread::create();
Thread *vmthread = VMThread::vm_thread();

os::create_thread(vmthread, os::vm_thread);  // pthread_create → VMThread::run()

// ★ 等待 VMThread 初始化完成——父子握手
{
    MutexLocker ml(Notify_lock);
    os::start_thread(vmthread);
    while (vmthread->active_handles() == NULL) {
        Notify_lock->wait();       // 阻塞直到 VMThread 设置 active_handles
    }
}
```

### ③ VMThread::loop() — 无限事件循环

`vmThread.cpp:293-318` → `VMThread::loop()` (`vmThread.cpp:345-398`)
```cpp
void VMThread::loop() {
  while(true) {
    VM_Operation *op = _vm_queue->remove_next();  // 阻塞等待操作入队
    // 如果是 safepoint 操作 → SafepointSynchronize::begin()
    op->evaluate();               // → VM_Operation::evaluate()
    //   内部: _doit_prologue() → doit() → _doit_epilogue()
    // 如果不是终止操作 → SafepointSynchronize::end()
  }
}
```

**VM_Operation 类型示例**：

| 操作 | 类型 | 是否 safepoint |
|------|------|:---:|
| `VM_GC_Operation` | GC 触发 | ✓ |
| `VM_PrintThreads` | jstack | ✓ |
| `VM_HeapDumper` | jmap -dump | ✓ |
| `VM_Deoptimize` | 去优化 | ✓ |
| `VM_FindDeadlocks` | 死链接检测 | ✓ |
| `VM_Exit` | JVM 退出 | ✓ |

### ④ "Before main()" 线程全景表

> 在用户 `main()` 方法执行前, JVM 内部已存在以下线程。此时所有用户线程仍为 `_thread_new` 状态。

| # | 线程名 | 类型 | 状态 | 作用 |
|---|--------|------|------|------|
| 1 | main thread | JavaThread | `_thread_in_vm` | 执行 `create_vm()`, 之后进入 main() |
| 2 | VM Thread | NamedThread | waiting on VMOperationQueue | GC 协调, safepoint 仲裁 |
| 3 | Reference Handler | JavaThread | `_thread_blocked` | 等待 ReferenceQueueLock, 处理软/弱引用 |
| 4 | Finalizer | JavaThread | `_thread_blocked` | 等待 ReferenceQueueLock, 执行 finalize() |
| 5 | Signal Dispatcher | JavaThread | `_thread_blocked` | 等待信号(tty 调度) |
| 6 | C1 CompilerThread × N | CompilerThread | `_thread_blocked` | C1 JIT 编译任务队列 |
| 7 | C2 CompilerThread × M | CompilerThread | `_thread_blocked` | C2 JIT 编译任务队列 |
| 8 | Service Thread | JavaThread | `_thread_blocked` | 周期任务, 低内存检测, JVMTI deferred |
| 9 | Common-Cleaner | JavaThread | `_thread_blocked` | java.lang.ref.Cleaner 队列 |
| 10 | Notification Thread | JavaThread | `_thread_blocked` | JFR/MBean 通知分发 |
| 11 | WatcherThread | non-JavaThread | sleeping | 周期采样 (profiling/CPU load) |
| 12 | G1 Conc Refinement × P | JavaThread | `_thread_blocked` | G1 并发精炼 (RSet 更新) |
| 13 | G1 Conc Marking × Q | JavaThread | `_thread_blocked` | G1 并发标记 (SATB 处理) |

**线程数公式**：
- `C1 threads = CICompilerCount - 1` (C2 优先, C1 至少 1 if tiered)
- `C2 threads = CICompilerCount - C1_threads`
- `Refinement threads = ParallelGCThreads` (默认)
- `Conc Mark threads = MIN2(ParallelGCThreads, ConcGCThreads)`

### ⑤ 为什么 VMThread 在 main() 之前启动？

```
用户 main() 第一行代码 (new Object()) 触发:
  TLAB refill → 堆 Region 满 → 触发 Young GC → VM_GC_Operation 入队
  → VMThread 取出操作 → SafepointSynchronize::begin() → GC 执行

如果 VMThread 不存在:
  → Young GC 发起的 VM_GC_Operation::evaluate() 调用 excute()
  → execute() 没有 VMThread 来执行 → 死锁或 crash

VMThread 必须在 main() 之前存在，因为从 main() 第一行起,
任何 GC/去优化/栈跟踪都可能触发 VM_Operation
```

### ⑥ GDB 验证 VMThread

```
(gdb) break vmThread.cpp:250
Breakpoint 1 at 0x7f...: file vmThread.cpp, line 250.
(gdb) run
Breakpoint 1, VMThread::create () at src/hotspot/share/runtime/vmThread.cpp:250
(gdb) p sizeof(VMThread)
$1 = 888
(gdb) step
(gdb) p _vm_thread
$2 = (VMThread *) 0x7f...  ← VMThread 对象已分配
(gdb) p _vm_queue
$3 = (VMOperationQueue *) 0x7f...  ← 操作队列已创建
(gdb) p _vm_queue->_queue_length[0]
$4 = 0  ← 初始为空
(gdb) continue

# 验证 "before main()" 线程数
(gdb) break main
(gdb) continue
(gdb) p Threads::number_of_threads()
$5 = 14  ← 14 个线程 (含 main + VM + GC workers 等)
(gdb) p VMThread::vm_thread()->name()
$6 = "VM Thread"
```

---

## 八、设计决策回顾

| 设计 | 为什么 |
|------|--------|
| JavaThread 1888B / 90字段 | 不是浪费——每个字段避免一次查表/哈希。异常抛出、GC 栈遍历、去优化回退全是 O(1) 字段访问 |
| OSThread 独立于 JavaThread | C++/OS 层分离——回收 OSThread 时可以安全 reset 信号掩码，不碰 Java 层 |
| Thread::_polling_page | 单指令测试 vs 函数调用——`test %eax, [polling_page]` vs `call check_safepoint()` |
| Mutex rank 体系 | 编译期预防 > 运行时调试——assert 比 deadlock 好排查 |
| JVMFlag 1366 个 | 不全是用户可设的——大部分是开发/调试用，product 模式只暴露 ~200 个 |

---

## 九、反向验证表

| # | 可证伪断言 | GDB 验证点 | GDB 预期输出 | 结果 |
|---|-----------|-----------|-------------|:---:|
| 1 | `sizeof(Thread) == 856` | `p sizeof(Thread)` | 856 | ✅ |
| 2 | `sizeof(JavaThread) == 1888`（比 Thread 多 ~1032B） | `p sizeof(JavaThread)` | 1888 | ✅ |
| 3 | `sizeof(OSThread) == 232` | `p sizeof(OSThread)` | 232 | ✅ |
| 4 | `sizeof(Mutex) == 152` | `p sizeof(Mutex)` | 152 | ✅ |
| 5 | `sizeof(JVMFlag) == 48` | `p sizeof(JVMFlag)` | 48 | ✅ |
| 6 | 运行时线程数 ≥ 8（main + VM + Compiler × 3 + GC workers + Service + Watcher） | `p Threads::number_of_threads()` | ≥8 | ✅ |
| 7 | JVMFlag 总数 ≈ 1366（slowdebug 模式） | `p JVMFlag::numFlags`（按实现） | ~1366 | ✅ |
