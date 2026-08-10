# 第六卷：运行时 — 线程、锁、Safepoint、信号

> 基于分析资产：Phase 01 (06/11) + Phase 26-runtime-extra + libjvm-analysis/07-thread-lock + libjvm-analysis/08-safepoint

---

## §〇 资产扫描报告

### 已有分析资产总览

| 来源 | 文档数 | 总行数 | 覆盖主题 |
|------|:---:|:---:|------|
| Phase 01 (06-Mutex.md) | 1 | 776 | 104 全局 Mutex + Rank 10 级死锁检测 |
| Phase 01 (11-Stages5-10) | 1 | 1,052 | VMThread 创建 + Safepoint begin/end + 信号分派器 |
| libjvm-analysis/07-thread-lock/ | 16 | ~20,000 | 线程架构、JavaThread 系统、非 Java 线程、锁全链路 |
| libjvm-analysis/08-safepoint/ | 5 | ~5,306 | Safepoint 协议、轮询机制、VM 操作、GCLocker |
| Phase 26-runtime-extra | 3 | ~16,000+ | Handshake/ThreadSMR、JVM Flag 系统、VMThread+VM Ops+Services |
| **合计** | **26** | **~43,000** | |

### 分析资产深度评估（按书籍章节映射）

| 书籍章节 | 已有资产 | 资产行数 | 深度评级 | 需补齐内容 |
|---------|---------|:---:|:---:|------|
| Ch26 线程系统 | 07/05-06-07-08-09-10-12-14 + 26/00 | ~8,000 | ★★★☆ | new Thread()→pthread_create 完整 C++ 构造链 |
| Ch27 同步与锁 | 07/01-02-03-04-16 + 01/06 | ~6,000 | ★★☆☆ | **ObjectMonitor 逐字节三队列分析 + ParkEvent**  |
| Ch28 Safepoint | 08/01-02-03-04-05 + 01/11 + 26/02 | ~10,000 | ★★★☆ | polling page mprotect + SIGSEGV 全链路 |
| Ch29 信号处理 | 01/11 (Signal Dispatcher) + 19-signal-chaining | ~1,500 | ★☆☆☆ | **全章需从 0 构建** — sigaction 安装链 + NPE/StackOverflow 信号路径 |

### 需从 0 构建的深层分析

```
1. ObjectMonitor::enter() 逐行 — cxq CAS 入队 → EntryList 出队 → OnDeck 选择
2. ParkEvent::park() — pthread_cond_wait 的完整状态转换 + timed_park
3. JavaThread 构造链 — JavaThread() → os::create_thread() → pthread_create() → thread_native_entry() → JavaCallWrapper
4. polling page mprotect → SIGSEGV → JVM_handle_linux_signal → handle_polling_page_exception
5. 信号体系 — JVM_handle_linux_signal 的 6 信号注册 + 异步安全保证
```

### 源码文件映射

| 章节 | 核心源文件 | 行数 |
|------|------|:---:|
| Ch26 线程 | thread.cpp/hpp, javaThread.cpp/hpp, park.cpp/hpp | ~8,077 |
| Ch27 锁 | objectMonitor.cpp/hpp, synchronizer.cpp/hpp, mutex.cpp/hpp, biasedLocking.cpp/hpp | ~7,859 |
| Ch28 Safepoint | safepoint.cpp/hpp, safepointMechanism.*, vmThread.cpp/hpp, vmOperations.cpp/hpp, interfaceSupport.* | ~4,014 |
| Ch29 信号 | os_linux.cpp (信号部分), os_posix.cpp, os.cpp, jsig.c | ~3,500+ |
| **合计** | | **~23,450** |

---

## §一 章节规划（4 章 × 3 级目录）

### 第26章：线程系统 — 从 new Thread() 到 pthread_create 的完整构造链

> **生产场景开场**：线程数飙到 5000 → jstack 无法连接 → 物理内存耗尽 swap thrashing → OOM-Killer 杀进程。源码级解释：JavaThread 的 20KB C++ 对象 + 1MB 栈 + handle area + JNIHandleBlock → 5000 线程 = 5GB+ 物理内存。为什么 `-XX:ThreadStackSize` 不能只改个数字？为什么 `ThreadsListHandle` 在 O(n^2) 时能让 jstack 永远不返回？

#### 26.1 Thread 类层次全景 — NonJavaThread 与 JavaThread 的分离

- 26.1.1 Thread 基类：`Thread::_id`、`_osthread`、`_MutexEvent`、`_ParkEvent` — 每个线程必备的 6 个成员
- 26.1.2 NamedThread → ConcurrentGCThread → WorkerThread 链路 — GC 线程的独特命名空间
- 26.1.3 JavaThread 独有成员：`_threadObj` (java.lang.Thread 句柄)、`_jni_environment`、`_thread_state` (10 状态机)、`_watcher_thread_id`、`_terminated`
- 26.1.4 线程种类全枚举（21+ 种）：VMThread、CompilerThread、ServiceThread、WatcherThread、Signal Dispatcher、AttachListener、GC Worker × N、G1ConcurrentRefine × N、ReferenceHandler、FinalizerThread、ProfilerThread、JFR Recorder 等

> **已有分析**：07-thread-lock/06-JVM-Thread-Architecture.md (790行) + 07/10-JVM-NonJavaThread.md (606行)
> **需补充**：每类线程的 C++ 创建入口 + 启动参数 + 命名规则 — 用于故障诊断时从线程名反推创建代码

#### 26.2 JavaThread 创建全链路 — 从 Java 层到 OS 线程的 7 步构造

- 26.2.1 Java 层 `new Thread().start()` → `Thread.start0()` → `JVM_StartThread` (jvm.cpp:3649)
- 26.2.2 `JVM_StartThread` — 线程组检查 + `allocate_threadObj()` + `Thread::current()->locks()` 死锁验证
- 26.2.3 `JavaThread::JavaThread(ThreadFunction, sz)` (thread.cpp:205) — C++ 对象构造：初始化 _jni_environment、_handle_mark、_TLAB、ObjectWaiter
- 26.2.4 `os::create_thread(this, thr_type, stack_size)` (os_linux.cpp) — `pthread_attr_init` → `pthread_attr_setstacksize` → `pthread_create(&tid, &attr, java_start, this)` — 栈大小 = `ThreadStackSize` (默认 1024KB) × `StackShadowPages` (20 pages = 80KB guard)
- 26.2.5 `java_start()` → `thread_native_entry()` (thread.cpp:3338) — OS 线程入口：`osthread->set_state(INITIALIZED)` → `Thread::record_stack_base_and_size()` → `os::is_first_C_frame(&fr)` → `JavaCallWrapper`
- 26.2.6 `JavaThread::thread_main_inner()` — 创建/获取 `java.lang.Thread` oop → `thread->call_run()` → 反射调用 Thread.run()
- 26.2.7 `JavaThread::exit()` (thread.cpp:1897) — 清理路径：TLAB 释放 → jni_active 退出 → deoptimization 清理 → HandleArea → remove_from_jni_handle_block_list
- 26.2.8 `Threads::add()` (thread.cpp:3510) — 将 JavaThread 加入 `_thread_list` → `ThreadsSMRSupport::add_thread()` 更新 `_java_thread_list` 快照 → 广播 `Threads_lock->notify_all()`

> **已有分析**：07-thread-lock/05-JVM-Thread-Lifecycle.md (768行) + 07/09-JavaThread-System.md (826行)
> **需补充**：**本节是书籍核心叙事 —— 需要源码逐行追踪构造链，不能只是宏观描述。** 每个 malloc/pthread_create 调用配 file:line + 对象大小计算。

#### 26.3 _thread_state 状态机 — 10 状态的安全转换

- 26.3.1 10 状态枚举 (thread.hpp:165)：`_thread_new`(0) → `_thread_in_native`(1) → `_thread_in_vm`(3) → `_thread_in_Java`(4) → `_thread_blocked`(12) → `_thread_in_native_trans`(7)
- 26.3.2 `transition_and_fence()` (interfaceSupport.inline.hpp:136) — StoreLoad 屏障的必要性：隐藏读者 (VMThread) 在 begin() 中无锁读取 `_thread_state`
- 26.3.3 ThreadBlockInVM / ThreadInVMfromJava / ThreadInVMfromNative — 3 种 RAII 转换器：构造 → transition_and_fence → 析构 → 恢复 + poll
- 26.3.4 `safepoint_check_block` 三态 (mutex.cpp:174)：是否允许 safepoint — `_safepoint_check_never`(no_safepoint_check) / `_safepoint_check_always` / 默认
- 26.3.5 状态转换的成本测量：StoreLoad fence ~100ns (x86 mfence) + poll ~20 cycles + transition 本身 ~10ns

> **已有分析**：07-thread-lock/09 (§三 safepoint_check 三态) + 08-safepoint/02-Polling-Mechanism.md (§2 transition_and_fence)
> **需补充**：状态机全图 (Mermaid) + 每个状态的可允许操作矩阵

#### 26.4 Thread-SMR — Safe Memory Reclamation 的 Hazard Pointer 实现

- 26.4.1 为什么需要 Thread-SMR — 传统 Iterator 模式：持有 Threads_lock → 阻止线程创建/销毁 → 性能退化
- 26.4.2 ThreadsListHandle 的 RAII Hazard Pointer：构造 → `acquire_stable_list()` → `_nested_handle_cnt++` → 析构 → `release_stable_list()`
- 26.4.3 `_java_thread_list` 快照机制 — `smr_java_thread_list()` 返回 `ThreadsList*`→ 写者通过 `Threads_lock` 保护创建新快照 → 读者通过 Hazard Pointer 保证旧快照不被释放
- 26.4.4 `smr_delete()` × `DeleteDeferredToken` — 延迟删除协议：不立即释放 JavaThread 内存 → 降到安全时机释放
- 26.4.5 性能对比：Threads_lock 独占 → 所有迭代串行 vs ThreadSMR → 无限并行读取 (代价：~100ns/acquire + 10 字节内存)
- 26.4.6 Bug 案例：jstack 挂起根因 — ThreadSMR 迭代 O(n²) + `_thread_list` 包含 2 个已退出线程 → 先扫描再无效

> **已有分析**：26-runtime-extra/00-Handshake-ThreadSMR.md (112KB) — 高强度覆盖
> **需补充**：书籍化摘要 — 从 112KB 提取 3,000 行书籍级叙事

#### 26.5 Handshake 协议 (JDK 10+) — 替换部分 Safepoint 的 Thread-Local 握手

- 26.5.1 三大 Handshake 类型：Global (全线程) / Per-Thread (单线程) / One-Thread (自身)
- 26.5.2 HandshakeClosure 抽象 — `do_thread(JavaThread*)` + `_is_async` 标志
- 26.5.3 HandshakeState 三步协议：arm → process → disarm (per-thread flag set → poll → execute closure → clear flag)
- 26.5.4 与 Safepoint 的对比：Handshake 只暂停目标线程(们) → 延迟低 (1μs vs 100μs+ STW) → 但闭包限制多 (不能 GC、不能改全局状态)
- 26.5.5 使用场景：BiasedLocking::revoke_and_rebias、StackWatermark、ThreadDump

> **已有分析**：26-runtime-extra/00-Handshake-ThreadSMR.md
> **需补充**：Handshake 与 Safepoint 的决策树 — 什么操作用 Handshake、什么时候必须 Safepoint

#### 26.6 每个 JavaThread 的辅助数据结构

- 26.6.1 Handle Area — `_handle_area: HandleArea` — Arena(Chunk 链表) 管理对象引用 GC root
- 26.6.2 HandleMark — RAII GC root 标记回滚 (JNI LocalFrame 的底层)
- 26.6.3 JNIHandleBlock — `_active_handles / _free_handle_block` — OopStorage 后端的 JNI 局部引用
- 26.6.4 TLAB — `_tlab: ThreadLocalAllocator` — `_start/_top/_end/_pf_top` 四指针 bump-pointer 分配
- 26.6.5 WatcherThread — `_watcher_thread: JavaThread*` — 线程终止通知的职责
- 26.6.6 DeoptSuspendState — `_pending_deoptimization / _pending_popframe / _pending_transfer_to_interpreter`

> **已有分析**：07-thread-lock/09-JavaThread-System.md (826行) — 覆盖面完整
> **需补充**：每个辅助结构的内存开销精确计算 — 一个 JavaThread 到底占多少字节？（C++ 对象 ~20KB + OS 栈 1MB + Handle/JNI/TLAB ~50-200KB）

---

### 第27章：同步与锁 — ObjectMonitor 逐字节三队列 + ParkEvent 底层

> **生产场景开场**：synchronized 瓶颈 → 在线线程 200 个全 WAITING 在 CXQ 中 → ObjectMonitor::exit() 的 O(N) EntryList→cxq 批量迁移 → 线程苏醒的 thundering herd。为什么 -XX:-UseBiasedLocking 有时让延迟降低 90%？为什么 ParkEvent 不使用 futex 而是 pthread_cond_wait + pthread_mutex_t？源码逐字节回答。

#### 27.1 Mark Word 与锁升级 — 从 01→10→11→00 的 4 态演进

- 27.1.1 markOop 编码 (markOop.hpp:82-108) — 64-bit 完整位布局：
  ```
  [ unused:25 | hash:31 | age:4 | biased_lock:1 | lock:2 | 0 ]
  lock=01 + bias=1: 偏向锁 (Thread ID 54 bits)
  lock=01 + bias=0: 无锁 (hash 已计算则存 hash)
  lock=00:          轻量级锁 (ptr-to-BasicLock 62 bits)
  lock=10:          重量级锁 (ptr-to-ObjectMonitor 62 bits)
  lock=11:          GC 标记
  ```
- 27.1.2 `markOopDesc::print_on()` 解读 — 如何从 raw value 反推锁状态
- 27.1.3 锁升级路径 (synchronizer.cpp:52)：
  ```
  Biased (线程 T1, 无竞争) → CAS 重偏向
  Biased → Lightweight (有竞争, CAS 失败)
  Lightweight → Fat (再次竞争, inflate())
  Fat → 保持 Fat (一旦 inflate 不退回)
  ```

> **已有分析**：07-thread-lock/02-BiasedLocking.md (607行) + 03-BasicLock-Synchronizer.md (675行)
> **需补充**：每步 CAS 操作的汇编级分析 — 什么指令、什么内存序

#### 27.2 ObjectMonitor 逐字节 — 本书最受期待的一节

- 27.2.1 ObjectMonitor 内存布局（objectMonitor.hpp:102-192）：19 个字段逐个解剖
  ```
  volatile markOop   _header;       // 8 bytes — displaced mark word
  void*  volatile    _object;       // 8 bytes — 关联的 Java 对象
  volatile intptr_t  _owner;        // 8 bytes — 持有线程的 LockWord
  
  // ★ 三队列
  ObjectWaiter* _cxq;               // 8 bytes — Contention Queue (LIFO stack)
  ObjectWaiter* volatile _EntryList; // 8 bytes — Entry List (FIFO queue for on-deck handoff)
  ObjectWaiter* volatile _WaitSet;  // 8 bytes — Wait Set (wait/notify)
  
  volatile int      _count;         // 4 bytes — 递归锁计数
  volatile int      _waiters;       // 4 bytes — WaitSet 中等待者计数
  int               _recursions;    // 4 bytes — 可重入计数
  volatile int      _succ;          // 4 bytes — Heir Presumptive (后继者提示)
  ObjectWaiter*     volatile _Responsible; // 8 bytes — 负责醒来线程 (防 park风暴)
  int64_t           _WaitSetLock;   // 4 bytes — WaitSet 保护自旋锁
  ```
- 27.2.2 cxq (Contention Queue) — 内部无锁 LIFO 栈
  - `ObjectWaiter` 结构 (8 字段) — `_prev/_next` 双指针 + `_thread` + `_notified` + `TState` 枚举
  - `Atomic::xchg(&_cxq, node)` (对象Model.cpp:502) — 原子 push
  - **关键设计**：为什么 cxq 用 LIFO(stack) 而不是 FIFO(queue)？→ push 只需一个 CAS → O(1) vs 队列需要 2 CAS → 但 LIFO 不公平 (后来的先进入 EntryList)
- 27.2.3 EntryList — 出队到 OnDeck 的 FIFO 队列
  - `EntryList::insert_from_cxq()` — 批量将 cxq 整个栈翻转后插入 EntryList 尾部 → 恢复 FIFO 公平性
  - `EntryList::select()` — 选择下一个 OnDeck 线程 (EntryList 头部)
  - `_succ` (Heir Presumptive) — 写者提示：从 unlock 线程直接传给继承者，绕过 EntryList
- 27.2.4 WaitSet — wait/notify 的等待队列
  - `ObjectMonitor::wait()` 的 6 步：① `_recursions = 0` → ② `ExitEpilog` 释放锁 → ③ `Self->TState = ObjectWaiter::TS_WAIT` → ④ `AddWaiter(&_WaitSet, Self)` → ⑤ `Self->_ParkEvent->park()` → ⑥ 被 notify 唤醒后 `Self->_notified = 0`
  - `ObjectMonitor::notify()` — `WaitSet` 头部出队 → 移到 EntryList 尾部 (不直接给 OnDeck)
  - `ObjectMonitor::notifyAll()` — WaitSet 全部迁移到 EntryList
  - **Bug 案例**：虚假唤醒 (spurious wakeup) — pthread_cond_wait 可被信号中断 → `_notified` 标志验证 (while loop check)
- 27.2.5 enter() 逐行 walk-through（objectMonitor.cpp:288-500）
  - ① CAS `_owner` 从 NULL → Self — 快速路径（无竞争）
  - ② CAS 失败 → `TrySpin()` — 自适应自旋 10-500 次 (Platform-specific)
  - ③ 自旋耗尽 → `EnterI(Self)` — 创建 ObjectWaiter → `cxq_push()` → 进入阻塞
  - ④ `Self->_ParkEvent->park()` — 底层 pthread_cond_wait
  - ⑤ 被唤醒 → 检查 `_succ == Self` 或 `Self` 在 EntryList 头 → `AtomicStoreIfNull(_owner, Self)` — 继承锁
- 27.2.6 exit() 逐行 walk-through（objectMonitor.cpp:720-980）
  - ① `_recursions--` → 如果 `_recursions > 0` → 直接返回
  - ② `OrderAccess::release_store(&_owner, 0)` — 释放所有者
  - ③ `OrderAccess::storeload()` — 防止 store 重排序前读 _cxq/_EntryList
  - ④ 检查 `_EntryList` → 非空 → `ExitEpilog(Self, w)` — 选 OnDeck → unpark
  - ⑤ `_EntryList` 空 + `_cxq` 非空 → `cxq → EntryList` 翻转 → 选 OnDeck → unpark
  - ⑥ 两者都空 → `AtomicStoreIfNull(_owner, 0)` 确认 → 无人可唤醒 → 快速返回
- 27.2.7 三队列并发协议 — cxq CAS + EntryList TSe + WaitSet 自旋锁
  - cxq 操作：完全无锁（单 CAS push）
  - EntryList 操作：持有 ObjectMonitor "内部锁" (_owner != 0 隐含锁) → 不需要额外锁
  - WaitSet 操作：受 `_WaitSetLock` (spin lock via `TryLock`) 保护 → 因为 wait 调用发生在 ThreadBlockInVM 释放 Monitor 后

> **已有分析**：07-thread-lock/01-ObjectMonitor.md (942行) + 04-Synchronized-Full-Path.md (755行)
> **需补充**：**本节必须从 942 行扩展到 3,000-5,000 行。** 942 行是 structure overview — 本节需要对 enter()/exit() 做逐行汇编级分析，包括每个 CAS 的内存序 (acquire/release/seq_cst)、每个自旋的 CPU 消耗、每个队列操作的 O 复杂度。

#### 27.3 ParkEvent — pthread_cond_wait 的 HotSpot 包装

- 27.3.1 ParkEvent 内存布局（park.hpp:53-90）：3 个子类 — `ParkEvent`(_MutexEvent) / `ParkEvent`(_ParkEvent) / `Parker`(JavaThread 私有)
  ```
  volatile int    _event;     // 4 bytes — 0=unset, 1=set (类似 semaphore)
  volatile int    _nParked;   // 4 bytes — 已 park 计数 (debug)
  pthread_mutex_t _mutex[1];  // 40 bytes — mutex for cond_wait
  pthread_cond_t  _cond[1];   // 48 bytes — condition variable
  ```
- 27.3.2 `ParkEvent::park()` (park.cpp:52-144) 完整时序：
  - ① `OrderAccess::fence()` — 确保 `_event = 0` 对 park 可见
  - ② `int v = _event` → 如果 `v != 0` → `_event = 0` → 立即返回 (信号已到达)
  - ③ `pthread_mutex_lock(_mutex)` → 持有 mutex
  - ④ `while (_event == 0)` → `pthread_cond_wait(_cond, _mutex)` — **循环等待，防 spurious wakeup**
  - ⑤ 被唤醒 → `_event = 0` → `pthread_mutex_unlock(_mutex)` → 返回
- 27.3.3 `ParkEvent::unpark()` (park.cpp:146-165)：`_event = 1` → `OrderAccess::fence()` → `pthread_mutex_lock(_mutex)` → `pthread_cond_signal(_cond)` → `pthread_mutex_unlock(_mutex)`
- 27.3.4 `ParkEvent::park(millis)` — timed wait 实现：`pthread_cond_timedwait()` → ETIMEDOUT 处理
- 27.3.5 **为什么不直接用 futex？** — 可移植性承诺 → Solaris/AIX/Windows → pthread 抽象层 → 代价：每次 park/unpark 额外 2 次 system call (mutex lock + cond_wait vs futex 单次)

> **已有分析**：**缺失** — 07-thread-lock 系列没有独立的 ParkEvent 深度章节
> **需补充**：全节从零构建 — pthread_mutex_t + pthread_cond_t 的内部实现 + 竞态条件分析 + futex 对比

#### 27.4 偏向锁 — BiasedLocking 的延迟撤销与批量重偏向

- 27.4.1 偏向锁的 markOop 编码 — biased_lock=1 + lock=01 → epoch 位 (2 bits) + Thread ID (54 bits)
- 27.4.2 `BiasedLocking::revoke_and_rebias()` (biasedLocking.cpp:186) — 单对象撤销：Safepoint → 检查 markOop → 如果偏向线程未退出 → 轻量级锁升级
- 27.4.3 `BulkRevoke` 和 `BulkRebias` (biasedLocking.cpp:515-650) — 批处理优化：epoch 位递增 → 所有该 class 的对象一起 rebias
- 27.4.4 BiasedLockingDecay — 批量撤销计数器衰减：`_revocation_count / 2` per safepoint → 降至 `BiasedLockingBulkRebiasThreshold` 重新启用
- 27.4.5 JDK 15+ 默认禁用偏向锁 — 原因：modern 应用锁竞争多 → 偏向锁的 safepoint 撤销开销 > 收益 → `-XX:-UseBiasedLocking`

> **已有分析**：07-thread-lock/02-BiasedLocking.md (607行) — 覆盖面完整但偏浅
> **需补充**：epoch 位的 CAS 操作 + bulk revoke 的内存顺序 + 为什么 JDK 15 默认关闭

#### 27.5 轻量级锁 — BasicObjectLock + Displaced Mark Word

- 27.5.1 `BasicObjectLock` 栈上结构 — `_lock: BasicLock` + `_obj: oop`
- 27.5.2 `ObjectSynchronizer::fast_enter()` (synchronizer.cpp:108-134) — CAS `obj->mark() → displaced_mark_word` → 成功 = 轻量级锁定 → 失败 = 检查是否为同一线程重入
- 27.5.3 Displaced Mark Word — `BasicLock::displaced_header()` — 原始 markOop 存储位置 → unwind 时需要恢复到对象头
- 27.5.4 `ObjectSynchronizer::slow_enter()` — 竞争 → `ObjectSynchronizer::inflate()` → 重量级

> **已有分析**：07-thread-lock/03-BasicLock-Synchronizer.md (675行)
> **需补充**：栈上 BasicObjectLock 的布局 + monitorenter 字节码路径 + 重入检测的 CAS 竞争分析

#### 27.6 JVM 内部锁 — 104 全局 Mutex + Rank 死锁检测

- 27.6.1 Mutex 类的 LockWord 设计 — `SplitWord` union 同时存 LockByte(低1位) + ParkEvent* 指针(高位)
- 27.6.2 Rank 10 级体系 ((mutex.hpp:106-119))：event(0) → access(1) → tty(3) → special(4) → suspend_resume(5) → vmweak(7) → leaf(9) → safepoint(19) → barrier(20) → nonleaf(21-921) → native(922)
- 27.6.3 `set_owner_implementation()` 死锁检测 (mutex.cpp:1316-1326)：`this->_rank <= locks->_rank` → `fatal("acquiring lock %s/%d out of order")` — O(1) 指针解引用 + 整数比较
- 27.6.4 `TryFast` → `TrySpin` → `ILock` 三层获取协议 + `PlatformMonitor` (pthread_cond_t + pthread_mutex_t)
- 27.6.5 104 个全局锁的创建 — `mutex_init()` 中用 `def()` 宏完整枚举 (mutexLocker.cpp:194-562)
- 27.6.6 MutexLocker RAII — 7 种变体 (MutexLocker/MutexLockerEx/MonitorLockerEx/MutexUnlocker/...)
- 27.6.7 锁统计与诊断 — `Mutex::_print_lock_counts` → `-XX:+PrintPreciseBiasedLockingStatistics` + `-XX:+PrintMallocStatistics`

> **已有分析**：01-jvm-startup/06-Mutex.md (776行) + 07-thread-lock/16-JVM-Internal-Locks.md (1131行)
> **需补充**：双层读者嵌套 — 外层介绍给首次接触的读者（104 锁全枚举表），内层源码级深度给工程师（CAS + fence + Spin 轮数数学计算）

---

### 第28章：Safepoint 机制 — Polling Page mprotect + SIGSEGV 处理全链路

> **生产场景开场**：GC 暂停 200ms → PrintSafepointStatistics 显示 spin 50ms + block 150ms → 问：为什么 block 这么久？→ 追踪：线程正在 `ObjectMonitor::enter()` 的 park 中 → ThreadBlockInVM 已经转换 _thread_state → 但 pthread_cond_wait 不返回 → 直到 timeout 或被 signal 中断才回来。为什么 "同步所有线程" 不能简单用信号？为什么不可以直接 kill -STOP？

#### 28.1 Polling Page 的物理机制 — mprotect + MMU 页故障

- 28.1.1 `SafepointMechanism::default_initialize()` (safepointMechanism.cpp:42) — `os::reserve_memory(page_size)` → `_polling_page = (address)mem`
- 28.1.2 Arm: `os::make_polling_page_unreadable()` (os_linux.cpp:6011) → `mprotect(_polling_page, page_size, PROT_NONE)` — 移除读权限
  - **系统调用链**：mprotect → `do_mprotect_pkey` (mm/mprotect.c) → `change_protection` → TLB shootdown → 所有 CPU 刷新 TLB → next access → MMU → page fault
- 28.1.3 Disarm: `os::make_polling_page_readable()` (os_linux.cpp:6018) → `mprotect(_polling_page, page_size, PROT_READ)` — 恢复读权限
- 28.1.4 为什么用 polling（主动轮询）而不是 signal（被动通知）？
  - Signal 方式：vmThread 向每个 JavaThread 发 SIGUSR1 → 线程在任意位置收到信号 → 异步信号安全限制 → 不能持有锁 → 无法在安全上下文检查
  - Polling 方式：线程在自愿编译点检查 → 线程知道自己的状态 → 可以安全阻塞或继续
- 28.1.5 Polling page 在 JVM 地址空间中的位置 — `_polling_page` 通常地址 x000000000(non-PIE) 或堆上 (PIE) — mmap(NULL, ...)

> **已有分析**：08-safepoint/02-Polling-Mechanism.md (919行)
> **需补充**：内核侧 TLB shootdown 开销计算 + mprotect 的 per-page VMA 修改流程

#### 28.2 轮询检查点 — JavaThread 在哪里检查 polling page？

- 28.2.1 `SafepointMechanism::global_poll()` (inline.hpp:37) → `*(intptr_t*)_polling_page` → 可读返回 0 → 不可读触发 SIGSEGV
- 28.2.2 5 个轮询检查点位置：
  1. 解释器 → 方法返回/循环回边 → `TemplateTable::safepoint_poll()` 生成 poll 指令
  2. JIT 编译代码 → `SafepointNode` 插入到 `Parse::do_all_blocks()` → 循环回边 + 方法返回
  3. `ThreadBlockInVM::~ThreadBlockInVM()` (interfaceSupport.inline.hpp:297) — `_thread_blocked → _thread_in_vm` → transition_and_fence → poll
  4. `ThreadInVMfromNative::~ThreadInVMfromNative()` — JNI 返回 → transition_and_fence → poll
  5. Monitor::lock() → 获取失败 → ThreadBlockInVM → ~dtor → poll
- 28.2.3 轮询开销测量：global poll ~20-30 CPU cycles (cache-cold 62 cycles) + SIGSEGV 路径 ~2-5μs
- 28.2.4 ThreadLocal Handshake 的轮询 (JDK 10+) — `local_poll()` → 检查 per-thread flag → 不触发 SIGSEGV

> **已有分析**：08-safepoint/02-Polling-Mechanism.md (§3)
> **需补充**：x86 汇编级 poll 指令展示 + JIT 插入 poll 的 Phase 位置

#### 28.3 SIGSEGV → handle_polling_page_exception() 全链路

- 28.3.1 SIGSEGV 信号到达 → CPU 保存现场 (rip/rsp/eflags) → kernel 查找 sigaction → `JVM_handle_linux_signal`
- 28.3.2 `JVM_handle_linux_signal(sig, info, ucVoid, abort_if_unrecognized)` (os_linux.cpp:4018)：
  - ① 读取 `info->si_addr` (故障地址)
  - ② 检查 `si_addr == _polling_page` → 是 → 调用 `SafepointSynchronize::handle_polling_page_exception()`
  - ③ 从 `uc->uc_mcontext.gregs[REG_PC]` 读取 faulting IP → 保存到 `_thread_saved_exception_pc`
  - ④ 检查 `si_code` → SEGV_ACCERR (权限错误, 预期) vs SEGV_MAPERR (非映射, bug)
- 28.3.3 `SafepointSynchronize::handle_polling_page_exception()` (safepoint.cpp:859) → `block()` → 设置 `_thread_state = _thread_blocked` → 等待 `_state = _synchronized`
- 28.3.4 返回后 — VMThread 在 `end()` 中 `_state = _not_synchronized` → disarm polling page → JavaThread 醒来 → 从 `_thread_saved_exception_pc` 恢复执行
- 28.3.5 **ImplicitNullCheck** — 同一条 SIGSEGV 路径的另一用途：`null check` → 访问 0x0 地址 → SIGSEGV → `si_addr < os::vm_page_size()` → 认为是 null pointer → 构造 NullPointerException

> **已有分析**：08-safepoint/02-Polling-Mechanism.md (§1-2) — polling page 机制 + 08/01-Safepoint-Protocol.md (§4) — block() 流程
> **需补充**：**本节必须从 919 行 + 930 行合并扩展到 2,500-3,000 行** — 从 SIGSEGV 信号上下文 (ucontext_t 完整字段) 到 MMU 页故障到 TLB shootdown 到 polling page 单页的全部物理路径。需要 x86 寄存器级分析。

#### 28.4 SafepointSynchronize::begin()/end() 源码逐行

- 28.4.1 `SafepointSynchronize::begin()` 7 步：
  1. 获取 Threads_lock (stop thread creation) → 获取 Safepoint_lock (防并发 safepoint)
  2. `_waiting_to_block = nof_threads` — 初始化等待计数
  3. **`_state = _synchronizing`** — 先改状态，再 arm polling (确保已在 VM 中的线程看到)
  4. `arm_safepoint()` — mprotect + `os::serialize_thread_states()` (store buffer 同步)
  5. **阶段 1 SPIN**: `while (still_running > 0)` → 遍历 `_java_thread_list` (JavaThreadIteratorWithHandle) → 跳过 _thread_in_native、jni_active → 检查 ThreadSafepointState → 到达者 `still_running--`
  6. **阶段 2 BLOCK**: `while (_waiting_to_block > 0)` → 等线程从 `_thread_in_vm → _thread_blocked` 完成
  7. `_state = _synchronized` → 正式进入 safepoint → `do_cleanup_tasks()`
- 28.4.2 **为什么阶段 1 先 spin 再 block？** — spin 等 CPU-bound 线程 (在 JIT 代码中很快 poll) → block 等 I/O-bound 线程 (可能在 pthread_cond_wait 中)
- 28.4.3 `SafepointSynchronize::end()` 4 步：
  1. `_state = _not_synchronized` (先改状态，醒来的线程看到可直接运行)
  2. `disarm_safepoint()` — mprotect(PROT_READ)
  3. `Safepoint_lock->notify_all()` — 唤醒等待 safepoint 的调用者
  4. 释放 Threads_lock → 记录 safepoint 时间 → `_end_of_last_safepoint`
- 28.4.4 SafepointTimeout — `-XX:+SafepointTimeout` / `-XX:SafepointTimeoutDelay=10000` (ms) — 超时打印慢线程
- 28.4.5 Safepoint 性能诊断 — `-XX:+PrintSafepointStatistics` / `-XX:+PrintSafepointStatisticsCount` — vmop 名称 + 线程数 + spin/block/sync/cleanup/vmop 五段时间

> **已有分析**：08-safepoint/01-Safepoint-Protocol.md (930行) + 08/05-Safepoint-Full-Path.md (1308行) — 高质量覆盖
> **需补充**：spin 次数的数学建模 — `GuaranteedSafepointInterval` 与预期 spin 时间的关系 + 超时 handler 的源码

#### 28.5 VM_Operation 三态调度 — 谁发起，谁执行，谁等待

- 28.5.1 VM_Operation 4 种 Mode：`_safepoint`(0) / `_no_safepoint`(1) / `_concurrent`(2) / `_async_safepoint`(3)
- 28.5.2 40+ VM_Operation 子类完整枚举 — VM_GC_Operation / VM_RevokeBias / VM_Deoptimize / VM_ThreadDump / VM_Exit / VM_PrintThreads / ...
- 28.5.3 `VMThread::loop()` 主循环 (vmThread.cpp:450-530)：
  1. `_vm_queue->remove_next()` — 阻塞等操作 (pthread_cond_wait)
  2. `evaluate_operation(op)` — mode 决定 begin/end
  3. 操作完成 → `op->notify()` — 唤醒调用者
- 28.5.4 VMOperationQueue — 3-priority circular doubly-linked list — Safepoint(0) / Medium(1) / Low(2)
- 28.5.5 `doit_prologue()` vs `doit()` — 调用者线程 (prologue) vs VMThread (doit) + GCLocker 在这里决定跳过 GC

> **已有分析**：08-safepoint/03-VM-Operation-System.md (598行) + 26-runtime-extra/02-VM-Thread-Ops-Services.md (200KB)
> **需补充**：书籍化精华提取 (200KB → 2,000行) — 40 个 VM_Operation 子类的调用者映射表

#### 28.6 GCLocker — JNI Critical 如何阻止 GC

- 28.6.1 `GCLocker::jni_lock()` (gcLocker.cpp:123) — `_jni_lock_count++` + 如果 `is_active_and_needs_gc` → JNICritical_lock->wait()
- 28.6.2 `GCLocker::jni_unlock()` — `_jni_lock_count--` + 如果 `needs_gc && _jni_lock_count == 0` → 立刻执行 GC (在最后一个 JNI critical 退出时)
- 28.6.3 `GCLocker::check_active_before_gc()` — 在 GC VM_Operation::doit_prologue() 中 (g1CollectedHeap.cpp:1175) — 返回 true → 跳过整个 safepoint → **VMThread 根本不调用 begin()**
- 28.6.4 为什么不是"等 JNI critical 结束"而是"放弃本次 GC"？→ JNI critical 时间不可控 → 等待 → 所有 JavaThread 被暂停等一个 JNI 调用

> **已有分析**：08-safepoint/04-GCLocker.md (1039行) — 高质量覆盖
> **需补充**：书籍化微调 — 补充 jni_lock_count 溢出的理论上限 + JNICritical_lock 的 rank 在第 10 级死锁系统中的位置

#### 28.7 interfaceSupport — ThreadBlockInVM 与 safepoint 检查的生命周期

- 28.7.1 ThreadBlockInVM 构造：`transition_and_fence(thread, _thread_in_vm, _thread_blocked)` — 告诉 VMThread "我会阻塞，不要等我"
- 28.7.2 ThreadBlockInVM 析构：`transition_and_fence(thread, _thread_blocked, _thread_in_vm)` → `SafepointMechanism::block_if_requested()` — 醒来检查是否有 safepoint pending
- 28.7.3 ThreadInVMfromJava — JNI 入口路径：`_thread_in_Java → _thread_in_vm` — 不做 safepoint check (JNI 入口已经过了 polling)
- 28.7.4 ThreadInVMfromNative — JNI 返回路径：`_thread_in_native → _thread_in_vm` — 必须做 poll (可能错过了整个 safepoint 周期)
- 28.7.5 使用场景枚举 — Mutex::lock() / Condition::wait() / Monitor::wait() / sleep() / JNI → Java

> **已有分析**：08-safepoint/02-Polling-Mechanism.md (§4) + 26-runtime-extra/02
> **需补充**：每种转换的 StoreLoad fence 必要性证明 + 错误使用时序反例

---

### 第29章：信号处理 — JVM 的 6 信号体系 + SIGSEGV → NPE 的完整路径

> **生产场景开场**：`SIGSEGV in C2 compiled code at PC=0x7f...` → hs_err_pid.log → JVM 不是 "crash" — 是 `handle_linux_signal` 的 `do_unrecognized()` → `abort_if_unrecognized = true` → `os::abort()` (signal handler 版本，只用 reentrant 函数) → `write(STDERR_FILENO, ..., ...)` → `_exit(97)`。问：如果 JVM 忽略了这个 SIGSEGV 会怎样？→ 对象字段全为 garbage → 业务逻辑静默错误 → 比 crash 更致命。更深入的问：为什么 ImplicitNullCheck 对同一个 SIGSEGV 返回 NullPointerException 而不是 crash？

#### 29.1 JVM 的 6 信号安装体系

- 29.1.1 `os::Linux::install_signal_handlers()` (os_linux.cpp) — `sigaction()` 安装 6+ 信号处理器
- 29.1.2 信号-用途映射表：
  | Signal | 用途 | 处理函数 | 致命？ |
  |--------|------|---------|:---:|
  | SIGSEGV | NullPointerException / StackOverflowError / polling page | JVM_handle_linux_signal | NPE/Stack: 抛异常, 其他: fatal |
  | SIGBUS | Bus Error (misaligned access, file mapping error) | JVM_handle_linux_signal | Usually fatal |
  | SIGFPE | ArithmeticException (除零) | JVM_handle_linux_signal | 抛 ArithmeticException |
  | SIGPIPE | Broken pipe (Socket write) | SIG_IGN | No-op |
  | SIGILL | Illegal instruction (JIT bug) | JVM_handle_linux_signal | Fatal |
  | SIGTRAP | Breakpoint (JIT debugging) | JVM_handle_linux_signal | Fatal or debug |
  | SIGBREAK | User thread dump (kill -3 <pid>) | Signal Dispatcher 线程 | No — 线程 dump |
  | SIGTERM/SIGINT | 优雅关闭 | Shutdown hook 线程 | 触发 shutdown sequence |
- 29.1.3 `sigaction()` 的 flags 选择 — `SA_SIGINFO | SA_RESTART | SA_ONSTACK` — 为什么 SA_ONSTACK? (stack overflow 时 stack 不可用 → 在 sigaltstack 上处理)
- 29.1.4 `sigaltstack()` — 信号栈分配 (MINSIGSTKSZ=2KB, SIGSTKSZ=8KB)

> **已有分析**：**缺失** — 没有独立的信号安装文档
> **需补充**：全节从零构建 — 每个 sigaction() 调用 + flags 含义 + 信号栈 + 信号屏蔽字 (sa_mask)

#### 29.2 JVM_handle_linux_signal — 信号分发中心

- 29.2.1 函数签名：`JVM_handle_linux_signal(int sig, siginfo_t* info, void* ucVoid, int abort_if_unrecognized)` (os_linux.cpp:4018)
- 29.2.2 `ucontext_t* uc = (ucontext_t*)ucVoid` — 信号上下文完整结构：
  - `uc->uc_mcontext.gregs[REG_RIP]` — 故障指令地址 (faulting PC)
  - `uc->uc_mcontext.gregs[REG_RAX]` — 返回值寄存器
  - `uc->uc_mcontext.gregs[REG_RSP]` — 栈指针
  - `uc->uc_mcontext.gregs[REG_EFL]` — 标志位
- 29.2.3 分发逻辑 (os_linux.cpp:4028-4500)：
  ```
  ① 获取 JavaThread* thread = JavaThread::current() → 可能 NULL (非 Java 线程故障)
  ② SIGSEGV + si_addr < os::vm_page_size() → 认为是 null check → 返回 NPE
  ③ SIGSEGV + si_addr == _polling_page → 返回给 handle_polling_page_exception()
  ④ SIGSEGV + si_addr 在线程 stack guard region → StackOverflowError
  ⑤ SIGSEGV + 在线程 stack reserved region → bang 栈 (扩展)
  ⑥ SIGBUS + pc 在 CodeCache → possibly fatal
  ⑦ SIGFPE → 检查除零 → ArithmeticException
  ⑧ 其他 → fatal → os::abort() 或 report_and_die()
  ```
- 29.2.4 信号安全性约束 — 在信号处理器内只能调用 async-signal-safe 函数：
  - **可用**：`write()`, `read()`, `_exit()`, `getpid()`, `sigaction()`, `time()`, `futex()`(部分)
  - **不可用**：`malloc()`, `printf()`, `pthread_mutex_lock()`, `new`, `ResourceMark`
  - JVM 的处理：所有数据结构预分配 → signal handler 只做最轻量的检查 → 设置 flag → 延迟到 JavaThread 安全上下文再处理

> **已有分析**：**缺失**
> **需补充**：全节从零构建

#### 29.3 SIGSEGV → NullPointerException — 隐式 Null Check 的完整路径

- 29.3.1 ImplicitNullCheck 原理 — JIT 编译时省略显式 `if (obj == null)` 检查 → 直接读 `obj->field` → 如果 obj=null → 访问地址偏移 `obj + field_offset` → address < 页面大小 → 肯定不是合法地址 → SIGSEGV
- 29.3.2 `JVM_handle_linux_signal` 中 Null Check 判断 (os_linux.cpp:4094-4150)：
  - `if (sig == SIGSEGV && info->si_addr < (void*)os::vm_page_size())` — 故障地址在 0 页内
  - 从 `ThreadCodeBuffer` 读 faulting instruction 的 `_relocation` — 检查是否为 implicit_exception reloc
  - 是 → `thread->set_pending_exception(Klass::cast(SystemDictionary::NullPointerException_klass())->...)` — 不 fatal
  - 然后 `uc->uc_mcontext.gregs[REG_PC] = SharedRuntime::get_handle_wrong_method_stub()` — 修改 PC 到异常处理桩
- 29.3.3 回到 JavaThread — 信号处理返回 → CPU 从修改后的 PC (异常处理桩) 继续 → 桩检查 `_pending_exception` → 展开栈帧 → 抛出 NullPointerException
- 29.3.4 **为什么不是显式 null check？** — 省略 `test %rax, %rax; jz slow_path` (2-3 指令) → 节省 ~3 字节代码 + ~2 cycles per object access → 代价：miss 时走 SIGSEGV (2-5μs)
- 29.3.5 ImplicitNullCheck 的陷阱 — 如果 `obj` 是合法地址但 field offset 为负数 → address = obj + (-128) → 可能掉入不可读页面 → SIGSEGV → JVM 认为 `address < vm_page_size` 不成立 → fatal → **这就是为什么对象的 field offset 不能为负数**

> **已有分析**：**缺失** — 没有独立文档
> **需补充**：全节从零构建 — x86 指令级分析 + relocation 表查找 + 异常处理桩的逻辑

#### 29.4 SIGSEGV → StackOverflowError — 栈溢出检测与 Guard Pages

- 29.4.1 线程栈布局（thread.hpp:338+）：`[Reserved Zone(red zone)] [Yellow Zone] [Red Zone] [Shadow Zone] [OS Guard Page] [Actual Stack]`
- 29.4.2 `os::guard_memory(char* addr, size_t size)` = `mprotect(addr, size, PROT_NONE)` — 创建不可访问的 guard 区域
- 29.4.3 Stack Yellow Zone — 1 page (4KB) → SIGSEGV 命中 → `JVM_handle_linux_signal` 检测到在 stack yellow zone → 设置 `_stack_overflow_state = StackOverflow::_stack_overflown` → 扩展栈 (允许当前调用) → 抛出 StackOverflowError
- 29.4.4 Stack Red Zone — 1 page → 类似 Yellow Zone → 但在 `exception_in_transit` 中 (处理 StackOverflowError 时) → 不允许再扩展 → fatal
- 29.4.5 `os::Linux::manually_expand_stack(JavaThread*, address)` (os_linux.cpp) — 手动映射额外的栈页 → `mmap(NULL, page_size, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS|MAP_STACK, -1, 0)`
- 29.4.6 `-XX:StackYellowPages` (默认 2) / `-XX:StackRedPages` (默认 1) / `-XX:StackShadowPages` (默认 20) — 完整的栈分区参数
- 29.4.7 栈溢出检测的成本 — 0额外指令 (由MMU做) → 只有真的溢出时才走 SIGSEGV (~2-5μs) → 比软件检查 (每次方法调用检查 SP) 零成本

> **已有分析**：**缺失** — 没有独立文档
> **需补充**：全节从零构建

#### 29.5 Signal Dispatcher — 信号到 Java 层的桥接线程

- 29.5.1 Signal Dispatcher 的创建 (os.cpp:409) — `new JavaThread(&signal_thread_entry)` → 启动后立即 `sigwait(&sigset, &sig)` 阻塞
- 29.5.2 `signal_thread_entry()` (os.cpp:346-470) — 主循环：`sigwait()` → 收到信号 → switch-case：
  - SIGBREAK → `jcmd VM.print_threads` → thread dump
  - SIGTERM/SIGINT → `Shutdown::shutdown()` → 清理并退出
  - SIGHUP → （平台特定，通常忽略）
  - 其他 → `JavaCalls::call_static()` → 调用 `jdk.internal.misc.Signal.handle()` → Java 层信号处理
- 29.5.3 为什么不用 signal handler 直接调 Java 回调？— signal handler 是异步信号上下文 → 不能安全访问 Java heap → 不能 call java → Signal Dispatcher 是一个真正的 JavaThread → 在安全上下文中调用 Java 方法
- 29.5.4 `sigwait()` vs `sigaction()` 的竞态 — Signal Dispatcher 用 `sigwait()` 等待信号 → 同时 JVM 的 `sigaction` handler 记录信号 → 需要协调两者的信号集
- 29.5.5 AttachListener 的 lazy init 与 Signal Dispatcher 的协作 — 收到 SIGBREAK → 检查 attach trigger file → 如果不存在 → `AttachListener::init()` 创建 UNIX domain socket

> **已有分析**：01-jvm-startup/11-Stages5-10 (Signal Dispatcher) + 07-thread-lock/11-JVM-AttachListener.md
> **需补充**：`sigwait()` 的信号集管理 + Signal Dispatcher 和 sigaction handler 的线程安全交互

#### 29.6 信号链 (libjsig) — JVM 与第三方库的信号共存

- 29.6.1 libjsig 的拦截机制 — `LD_PRELOAD=libjsig.so` → 拦截 `sigaction()` → 保存调用者的 handler → 调用 JVM 的 handler → 在 JVM 不处理的信号上转发到调用者
- 29.6.2 `signal()` / `sigaction()` wrapper — `libjsig::signal()` (jsig.c:78) → 保存 old handler → 调用 os::signal()
- 29.6.3 `JVM_handle_linux_signal` 中的信号转发 — `if (!recognized(sig, info, uc))` → 调用 `chained_handler(sig, info, ucVoid)` — 原应用注册的 handler
- 29.6.4 信号链的陷阱 — JVM 必须"拥有"信号 → 必须第一个检查 → 如果是 JVM 认识的 → 不让应用 handler 看到 → 如果是应用自己的 → 转发给应用 handler → **但不能同时让两个 handler 处理同一信号** (竞态)
- 29.6.5 与 -Xrs 的交互 — `-Xrs` = reduce signal usage → 不安装 SIGQUIT handler → 允许 native profiler 独占信号

> **已有分析**：Phase 19-signal-chaining — libjsig 分析
> **需补充**：书籍化汇总 — jsig 的 double-bookkeeping (chained handler 存储 + 恢复机制)

#### 29.7 信号安全编程 — 从内核到 JVM 的异步信号约束

- 29.7.1 POSIX async-signal-safe 函数完整清单 — 35+ 个系统调用 — `abort`, `_exit`, `write`, `read`, `futex`, `sem_post`, `char*, `kill`, `getpid`, ...
- 29.7.2 JVM 的信号安全策略 — `SharedRuntime::handle_wrong_method()` — 中断 stub 的执行保证：
  - 只在 `ThreadCodeBuffer` 中做 O(1) 查找
  - 只修改寄存器和 pending exception flag
  - 不做任何 heap 分配 (资源预分配策略)
- 29.7.3 `os::abort()` in signal handler (os_linux.cpp:5930+) — 只用 `write()` 写 hs_err_pid.log → `fork()` → child 调用 `abort()` → parent 等待子进程完成 → `_exit(97)`
- 29.7.4 `report_and_die()` — 比 abort 更轻量的 fatal 处理 — `write(2, "...", n)` 到 stderr → `_exit(1)` — 不写 hs_err

> **已有分析**：**缺失**
> **需补充**：全节从零构建 — POSIX 信号安全的官方文档 + JVM 的工程实践

#### 29.8 信号调试工具链

- 29.8.1 GDB 信号断点：`handle SIGSEGV stop nopass` → `break JVM_handle_linux_signal` → `info signals`
- 29.8.2 `strace -e signal` — 查看 sigaction/sigaltstack/sigreturn 系统调用
- 29.8.3 `/proc/<pid>/status` — SigCgt (caught signals) + SigIgn (ignored) + SigPnd/SigShdPnd (pending signals) 位掩码
- 29.8.4 hs_err_pid 信号 section 解读 — `siginfo: si_signo: 11 (SIGSEGV), si_code: 1 (SEGV_MAPERR), si_addr: 0x0000000000000000`
- 29.8.5 `kill -l` 信号列表 + `man 7 signal` 信号概览 + `man 2 sigaction` sigaction 结构

> **已有分析**：**缺失**
> **需补充**：参考 Phase 20 的 GDB Verification 格式 — 10+ 个可运行的 GDB 脚本

---

## §二 已有分析资产的书籍化策略

| 章节 | 已有资产 | 当前行数 | 书籍化策略 | 目标行数 |
|------|---------|:---:|------|:---:|
| 26.1 线程层次 | 07/06-10-07 | 2,494 | 浓缩提炼 — 去 repetitive，保留架构图 + 命名空间表 | 1,200 |
| 26.2 构造链 | 07/05-09 | 1,594 | **从 0 重写** — 源码逐行追踪 | 2,500 |
| 26.3 状态机 | 08/02 | 919 | 补充全状态矩阵 + Mermaid 图 | 800 |
| 26.4 ThreadSMR | 26/00 | 112KB | 112KB → 浓缩 2,500 行精华 | 2,500 |
| 26.5 Handshake | 26/00 | — | 同上 | 1,500 |
| 26.6 辅助结构 | 07/09 | 826 | 微调 — 补内存开销计算 | 1,000 |
| 27.1 Mark Word | 07/02-03 | 1,282 | 微调 — 补汇编级 CAS | 1,200 |
| 27.2 ObjectMonitor | 07/01 | 942 | **从 942 扩展到 4,000** — 逐方法逐行分析 | 4,000 |
| 27.3 ParkEvent | 缺失 | 0 | **从 0 构建** | 1,500 |
| 27.4 偏向锁 | 07/02 | 607 | 微调 — 补 epoch + 关闭原因 | 1,200 |
| 27.5 轻量级锁 | 07/03 | 675 | 微调 — 补栈上布局 + 字节码路径 | 1,000 |
| 27.6 Mutex | 01/06 + 07/16 | 1,907 | 整合浓缩 | 2,000 |
| 28.1 Polling Page | 08/02 | 919 | 扩展到包含内核侧 TLB | 1,500 |
| 28.2 轮询点 | 08/02 | — | 补 x86 汇编 + JIT Phase | 1,200 |
| 28.3 SIGSEGV 链路 | 08/01-02 | 1,849 | **合并重写** — ucontext 完整字段 | 2,500 |
| 28.4 begin/end | 08/01-05 | 2,238 | 微调 — 补超时 handler | 2,000 |
| 28.5 VM Ops | 08/03 + 26/02 | — | 26/02 200KB → 2,000 精华 | 1,500 |
| 28.6 GCLocker | 08/04 | 1,039 | 微调 | 1,000 |
| 28.7 ThreadBlockInVM | 08/02 + 26/02 | — | 微调 | 1,000 |
| 29.1 信号安装 | 缺失 | 0 | **从 0 构建** | 1,200 |
| 29.2 handle_signal | 缺失 | 0 | **从 0 构建** | 2,000 |
| 29.3 SIGSEGV→NPE | 缺失 | 0 | **从 0 构建** | 2,000 |
| 29.4 StackOverflow | 缺失 | 0 | **从 0 构建** | 1,500 |
| 29.5 SignalDispatcher | 01/11 | — | 微调 — 补 sigwait 信号集 | 800 |
| 29.6 libjsig | Phase 19 | — | 浓缩 1,200 精华 | 1,200 |
| 29.7 信号安全 | 缺失 | 0 | **从 0 构建** | 1,000 |
| 29.8 诊断工具 | 缺失 | 0 | **从 0 构建** | 800 |
| **Preface + Intro** | — | 0 | **从 0 构建** | 500 |
| **合计** | 26 文档 | ~43,000 | | **~42,000** |

---

## §三 写作挑战与叙事设计

### 挑战 1：ObjectMonitor 是"读者最期待的章节" — 如何让 942 行 → 4,000 行不注水？

**策略**：
1. **逐方法逐行走读**：enter() 4 种竞争策略 (Fast→Spin→EnterI→park) 每个 if 分支配注解
2. **每个 CAS 的汇编验证**：`Atomic::cmpxchg` → `lock cmpxchg` → memory order 标注 (acquire/release/seq_cst)
3. **三队列的并发协议**：cxq (lock-free CAS) vs EntryList (ownered) vs WaitSet (spin lock) — 每个操作的 happens-before 关系
4. **反事实讨论**：如果 cxq 用 Mutex 保护 → 额外 500ns per lock → enter() 延迟 2x
5. **GDB 实时追踪**：每小节的结尾附 GDB 断点 + 预期观察

### 挑战 2：Ch26.2 构造链需要 "from Java to pthread_create"

**策略**：
1. **7 步分解**：Java → JNI → JavaThread() → os::create_thread() → pthread_create → java_start → thread_main_inner
2. **每步的输出**：参数值、栈回溯、堆分配（malloc 大小 + arena 类型）、锁持有状态
3. **实物演示**：`strace -f -e clone java MyApp` 输出解读 — 每个 `clone` = 一个 pthread_create
4. **成本估算**：创建 5000 线程的内存成本 — C++ 对象 + 栈 + Handle + JNI + TLAB

### 挑战 3：Safepoint polling page mprotect + SIGSEGV 需要内核级理解

**策略**：
1. **从 kernel 侧追踪**：mprotect → `do_mprotect_pkey()` → `change_protection()` → `flush_tlb_mm_range()` → TLB shootdown IPI
2. **TLB shootdown 多核成本**：4-socket 112 core → single IPI → ~1μs → 112 cores → 112 IPIs → per-core ~1μs
3. **计时测量**：`bpftrace -e 'kprobe:do_mprotect_pkey { @start[tid] = nsecs; } kretprobe:do_mprotect_pkey { @end = nsecs - @start[tid]; }'`
4. **对比**：ThreadLocal Handshake 的 `mprotect` 开销为 0 — 用 per-thread flag 替换

### 叙事钩子设计

| 章节 | 生产场景 | 读者共鸣 |
|------|---------|---------|
| 26 | 5000 线程 → OOM-Killer | "我们线上真的遇到过" |
| 27 | synchronized 瓶颈 + 全部 WAITING | "优化半天为什么没用" |
| 28 | GC pause 200ms 根因分析 | "为什么这么慢？" |
| 29 | hs_err_pid SIGSEGV 日志 | "JVM crash 了但我不知道为啥" |

---

## §四 跨章节交叉引用矩阵

| 本章节 | 依赖第1卷 | 依赖第2卷 | 依赖第5卷 | 依赖第4卷 |
|--------|:---:|:---:|:---:|:---:|
| 26.2 构造链 | Ch1 (JNI_CreateJavaVM) | — | — | — |
| 26.3 状态机 | Ch2 (mutex_init) | — | — | — |
| 27.1 MarkWord | — | — | Ch24 (oop模型) | — |
| 27.6 Mutex | Ch2 (mutex_init) | — | — | — |
| 28.1 PollingPage | Ch1 (Stage 2 Safepoint初始化) | — | — | — |
| 28.3 SIGSEGV | — | — | — | — |
| 28.6 GCLocker | — | Ch6-11 (GC全体系) | — | — |
| 29.3 NPE | — | — | — | Ch21 (CodeCache nmethod) |
| 29.5 SignalDispatch | Ch5 (init_globals) | — | — | — |

---

## §五 写作工作流

```
Phase 1: 新分析生成（需从 0 构建的部分）
  ├── Ch29.1-29.8: 信号处理 (8 小节，全章从 0 构建) → 3 个 prompt → 新会话生成
  ├── Ch27.2: ObjectMonitor 扩展 (942→4000 行) → 2 个 prompt → 新会话生成
  └── Ch27.3: ParkEvent (从 0 构建) → 1 个 prompt → 新会话生成

Phase 2: 已有资产书籍化（提取、整合、重写）
  ├── Ch26: 线程系统 (从 07-thread-lock + 26-runtime-extra 提取精华)
  ├── Ch28: Safepoint (从 08-safepoint + 26-runtime-extra 提取精华)
  └── Ch27.6: Mutex 系统 (从 01/06 + 07/16 整合)

Phase 3: 总串与交叉引用
  ├── 全书交叉引用矩阵校验
  ├── GDB 验证脚本 — 全章 ≥50 个可运行 GDB 断点
  └── 生产场景一致性检查 — 同一场景在同一章节中被引用时故障参数一致
```

---

## §六 与其他卷的接口

```
第1卷 启动 → 本卷:
  - JNI_CreateJavaVM 创建的 VMThread/Safepoint infrastructure 在本卷被深入
  - mutex_init() 创建的 104 个锁在本卷 Ch27.6 被继承和扩展

本卷 → 第2卷 GC:
  - Safepoint 协议是 GC 暂停的底层机制 (GC 在 safepoint 中执行)
  - GCLocker 是 GC 能否执行的守卫

本卷 → 第3卷 解释器:
  - monitorenter/monitorexit 字节码调用本卷 Ch27.5 的轻量级锁

本卷 → 第4卷 编译:
  - ImplicitNullCheck 由 C2 生成信号路径 (Ch29.3 → Ch21)
  - Safepoint poll 在 JIT 代码中的插入位置 (Ch28.2 → Ch20)

本卷 → 第5卷 内存:
  - MarkWord 与 oopDesc 的关联 (Ch27.1 → Ch24)
```

---

## §七 预期里程碑

| 里程碑 | 内容 | 估计文档行数 |
|--------|------|:---:|
| M1: 新分析生成 | Ch29 (信号全章) + Ch27.2-3 (OM+ParkEvent) | ~12,000 |
| M2: 资产整合 | Ch26+28 从现有资产提取书籍化 | ~18,000 |
| M3: 补充分析 | Ch27.1/4/5/6 微调扩写 | ~5,000 |
| M4: 总串 | 交叉引用 + GDB 脚本 + 一致性校验 | ~5,000 |
| **合计** | | **~42,000** |
