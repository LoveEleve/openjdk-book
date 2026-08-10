# 07 - 线程与锁

> 源码索引：`source_index/02-runtime.md`（173 文件，已索引 160+）
> 插桩覆盖：runtime/ 24cpp + oops/ 6cpp（详见 §六 探针覆盖）
> 标准环境：`-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UseBiasedLocking`
> 前置专题：[03-object-model](../03-object-model/)（对象头 markOop 位布局） [04-interpreter](../04-interpreter/)（monitorenter 字节码） [06-gc-memory](../06-gc-memory/)（safepoint 与偏向锁撤销交互）

---

## 〇、上手指南 ⭐

### 0.1 本文档适合谁？

| 水平 | 特征 | 建议路径 |
|------|------|---------|
| 🟢 初级 | 知道 `synchronized` 是重量锁，不知道偏向/轻量锁区别 | 先读 §0.3-0.4 → 入门路径 |
| 🟡 中级 | 了解偏向/轻量/重量三种锁，想深入 JVM 源码实现 | 入门速览 → 进阶路径 |
| 🔴 高级 | 读过 HotSpot 锁优化论文，需要源码级 enter/exit 参考 | 直接按需查阅专家路径 |

### 0.2 你需要什么基础？

| 必须 | 来自 |
|------|------|
| 理解 `synchronized(obj){...}` 的语义（互斥/重入/wait/notify） | Java 基础 |
| 知道对象头的 markOop 位布局（biased_lock/lock/hash/age 位） | [03-object-model] |
| 知道解释器怎么执行 `monitorenter` 字节码 | [04-interpreter] |
| 知道 safepoint 是什么（偏向锁撤销需要 STW） | [06-gc-memory] |
| 理解 CAS（Compare-And-Swap）原子操作 | 并发编程基础 |

### 0.3 前置知识速览（5 分钟）⭐

#### 概念 A：markOop — 8 字节存锁的全部状态

```
64 位对象头（非偏向 normal object）:
 [ unused:25 ][ hash:31 ][ unused:1 ][ age:4 ][ biased_lock:1 ][ lock:2 ]
  63────────39 38───────8              7──────4              3──────────0
                                                             ▲
                                    lock bits = 01→unlocked  00→stack-locked
                                                 10→inflated  11→GC marked

64 位对象头（偏向 biased object）:
 [ JavaThread*:54 ][ epoch:2 ][ unused:1 ][ age:4 ][ biased_lock:1 ][ lock:2 ]
  63─────────────10                     7──────4              3──────────0
                                                              ▲ biased_lock=1→低3位=101

★ 关键冲突：hash(31bit) 和 thread_ptr(54bit) 共用 markOop 空间
  → 调用 hashCode() 后偏向锁必须撤销（markOop 无法同时存 hash 和 thread 指针）
```

#### 概念 B：三条队列 — ObjectMonitor 内部排队系统

```
_cxq (Contention Queue)     ← 刚到达、CAS _owner 失败的线程（Node* LIFO 链表）
_EntryList                  ← 从 _cxq 批量转移、准备抢锁的线程（Node* 链表）
_WaitSet                    ← wait() 后等待 notify 的线程（ObjectWaiter* 双向链表）

enter: 线程到达→CAS _owner失败→组装 ObjectWaiter→_cxq 头部(LIFO)→park()
exit (QMode=0): _cxq→_EntryList(FIFO反转)→取头唤醒→unpark
wait/notify: wait()→_WaitSet尾部→park(); notify()→_WaitSet头→_EntryList

类比: _cxq=银行门口排队, _EntryList=大厅等候区, _WaitSet=出去办事了
```

#### 概念 C：锁升级路径（非严格单向）

```
偏向锁(biased)           ← 最快: 同一线程反复进锁, 只需 CAS 线程指针(1次!)
  │ 撤销（竞争/hashCode/wait）
  ▼
轻量锁(stack-locked)     ← CAS markOop→ptr_to_BasicLock
  │ 竞争（多线程同时CAS 或 已持有）
  ▼
重量锁(inflated)         ← ObjectMonitor::enter()→自适应自旋→park→OS mutex
  │ 空闲
  ▼
降级(deflated)           ← 后台 SafepointCleanupTask 回收空闲 Monitor→unlocked

★ 偏向撤销后直接变轻量（不是重量！）。只有轻量竞争才膨胀。
★ 重量可以降级回 unlocked（deflate），但不是降级回轻量。
```

#### 概念 D：JVM 内部锁 — 80+ 个 Mutex/Monitor + lock ranking

```
JVM C++ 代码内部有 80+ 个全局锁:
  tty_lock → Heap_lock → JNIGlobalHandle_lock → Compile_lock  (rank 递增)

Mutex  vs Monitor:
  Mutex:   纯互斥(不可重入), CAS+自旋, pthread_mutex fallback
  Monitor: 继承 Mutex + 条件变量 + 可重入 + wait/notify

lock ranking 死锁预防:
  每个锁有 rank 值, MutexLocker(lock) 检查当前持有锁 rank < 新锁 rank
  违反 → assert fail（宁可 crash 也不死锁）
```

#### 概念 E：JVM 线程类型全景 — 17 种系统线程，两大类

```
JVM 所有线程从 Thread 基类分为两大派系:

┌── Thread ──────────────────────────────────────────────────────────┐
│                                                                      │
│  NonJavaThread（JVM 内部线程 — 非 Java 代码创建，top -H 可见）      │
│  ├── NamedThread（有名字的线程）                                     │
│  │   ├── VMThread             ★ 执行 VM 操作（GC/逆优化/偏向撤销）  │
│  │   ├── ConcurrentGCThread   ★ 并发 GC 后台线程                    │
│  │   │   ├── G1ConcurrentMarkThread     ← SATB+Finger 并发标记      │
│  │   │   ├── G1ConcurrentRefineThread   ← RSet 异步更新             │
│  │   │   └── G1YoungRemSetSamplingThread← 记忆集采样               │
│  │   └── WorkerThread         ★ GC 并行 worker（WorkGang 管理）      │
│  │       └── AbstractGangWorker         ← Young/Mixed/Full GC workers│
│  │                                                                   │
│  └── WatcherThread            定时任务（PeriodicTask）               │
│                                                                      │
│  JavaThread（Java 代码创建的线程 — Thread.start()）                  │
│  ├── 应用程序线程              new Thread().start()                 │
│  ├── CompilerThread           ★ C1/C2 JIT 编译（thread.hpp:2130）  │
│  ├── CodeCacheSweeperThread   ★ 清理 zombie/not_entrant 代码(:2109)│
│  ├── ServiceThread             低内存检测 / JNI 周期检查             │
│  ├── JvmtiAgentThread          JVMTI 调试代理                       │
│  ├── ReferenceHandler          java.lang.ref.Reference 处理队列      │
│  ├── FinalizerThread           Object.finalize()                    │
│  ├── SignalDispatcher          信号分发 (SIGINT/SIGTERM → shutdown)  │
│  └── AttachListener            jcmd/jstack/jmap 连接入口             │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

★ 关键认知:
- NonJavaThread 不执行 Java 字节码，没有 Java 栈帧，不会被 safepoint 暂停
- JavaThread 拥有完整的 JVM 栈（解释器/C1/C2 帧），可以被 safepoint 暂停
- ★★★ CompilerThread/CodeCacheSweeperThread 虽然是"系统线程"，但继承自 JavaThread！
  它们需要访问 Java 堆（类元数据/方法数据），必须参与 safepoint 协议
- VMThread 是所有 STW 操作的执行者：它从 VMOperationQueue 取任务，等所有 JavaThread 到 safepoint 后执行
- WorkerThread（WorkGang）是 GC 的主力：Young GC 的 Evacuation 由它并行完成
- 线程安全删除由 ThreadSMR (Hazard Pointers) 保证——不是引用计数
```

### 0.4 核心术语速查表

| 术语 | 一句话解释 | 关键源码 |
|------|----------|---------|
| **markOop** | 对象头 8B，存 hash+age+锁状态（粒度: 64bit word） | `markOop.hpp:30-58` |
| **biased_lock bit** | markOop bit 3: 1=偏向锁模式, 0=普通锁模式 | `markOop.hpp:39` |
| **lock bits** | markOop bit 0-1: 01=unlocked, 00=stack-locked, 10=inflated, 11=GC marked | `markOop.hpp:39-40` |
| **BasicLock** | 栈上 8B，存 displaced markOop（轻量锁的原始对象头），粒度: 8B on stack | `basicLock.hpp:31-46` |
| **BasicObjectLock** | 解释器栈帧: BasicLock(8B) + oop(8B) = 16B per monitor slot | `basicLock.hpp:57-78` |
| **ObjectMonitor** | ~216B C 堆对象，存 _owner/_cxq/_EntryList/_WaitSet（粒度: mtObjectMonitor） | `objectMonitor.hpp:128-199` |
| **inflate** | 轻量→重量膨胀: 分配 ObjectMonitor，CAS 安装到对象头 | `synchronizer.cpp:1403` |
| **deflate** | 回收空闲 ObjectMonitor → markOop 恢复 unlocked | `synchronizer.cpp:1747` |
| **Epoch** | 偏向锁代际标记(2bit)，类级别递增——旧 epoch 偏向锁无效需撤销 | `markOop.hpp:40` |
| **Bulk Rebias** | 批量重偏向: epoch 失效+撤销次数达 20 → 全类重偏向 | `biasedLocking.cpp` |
| **Bulk Revoke** | 批量撤销: 重偏向后仍频繁撤销达 40 → 禁用该类偏向 | `biasedLocking.cpp` |
| **Lock Ranking** | JVM 内部锁静态排序，MutexLocker 获取时检查 rank 递增防死锁 | `mutexLocker.cpp:194` |
| **QMode** | ObjectMonitor::exit() 唤醒策略，控制 _cxq→_EntryList 转移方式 | `objectMonitor.cpp` |
| **Adaptive Spinning** | 自适应自旋——据历史成功次数动态调整 SpinDuration，减少过早 park | `objectMonitor.cpp` |
| **ThreadSMR** | Safe Memory Reclamation——Hazard Pointers 无锁安全删除 JavaThread | `threadSMR.cpp` |
| **VMThread** | ★ JVM 唯一 VM 操作线程——所有 STW 任务（GC/偏向撤销）由它执行 | `vmThread.hpp:114` |
| **WorkerThread** | GC 并行 worker——WorkGang 管理，执行 Young/Mixed/Full GC 的 Evacuation/Compaction | `thread.hpp:858` |
| **NonJavaThread** | JVM 内部线程基类——不执行 Java 字节码，不被 safepoint 暂停 | `thread.hpp:792` |
| **JavaThread** | Java 应用线程——有完整 JVM 栈帧，synchronized 的执行者，被 safepoint 暂停 | `thread.hpp:925` |
| **os::create_thread** | JVM 线程创建的唯一入口——`pthread_create` → `clone()` 系统调用 | `os_linux.cpp` |
| **ThreadState** | JavaThread 状态机——20+ 种状态（_thread_new→_thread_in_vm→_thread_in_Java→...） | `thread.hpp` |

### 0.5 Linux 系统编程前置知识 — JVM 锁的 OS 层基础 ⭐

理解 JVM 锁实现，必须先理解 6 个 Linux 原语。**JVM 不是魔法——它只是把这些原语精巧地组合在一起。** 每个原语都标明了 JVM 中的调用位置。

#### ① CAS — `lock cmpxchg` → Atomic::cmpxchg → 锁的原子性

```c
// x86 汇编（JVM 源码: atomic_linux_x86.hpp:86, 128）
lock cmpxchgl %1,(%3)       // 32位 CAS（轻量锁/偏向锁用）
lock cmpxchgq %1,(%3)       // 64位 CAS（偏向锁 JavaThread* 用）

// lock 前缀锁住总线/缓存行，保证 RMW（Read-Modify-Write）原子性
// 比 pthread_mutex_lock 快 100 倍——没有系统调用，没有上下文切换
```

**JVM 中用在哪？** 每一次 `synchronized` 的轻量锁获取都是一次 CAS：`Atomic::cmpxchg(BasicLock_ptr, &obj->mark, unlocked_mark)` [synchronizer.cpp]。ObjectMonitor 的 fast path enter 也是 CAS `_owner`：[objectMonitor.cpp:265]。偏向锁获取也是 CAS 线程指针到对象头。

**关键认知**：CAS 是 JVM 锁性能的基石。无竞争时 `synchronized` 的开销 = 一次 `lock cmpxchg`（~20-30 CPU cycles）。这就是为什么 JVM 的偏向锁/轻量锁能在无竞争时接近零开销。

#### ② `pthread_mutex` + `futex` → Mutex → JVM 内部锁

```c
// glibc pthread_mutex 的简化实现:
int pthread_mutex_lock(pthread_mutex_t *m) {
    if (atomic_cmpxchg(&m->lock, 1, 0) == 0)  // 快速路径: 一次 CAS
        return 0;                               // ★ 无竞争: 无系统调用!
    // 慢路径: 内核 futex
    while (atomic_xchg(&m->lock, 2) != 0)
        futex(FUTEX_WAIT, &m->lock, 2, NULL);  // 进内核排队
}
// ★ futex(7): Fast Userspace muTEX — 无竞争纯用户态，有竞争才进内核
```

**JVM 中用在哪？** `Mutex::lock()` [mutex.cpp] 的第一层也是 CAS 快速路径——如果 `Atomic::cmpxchg` 成功（无竞争），根本不调用 `pthread_mutex_lock`。**futex 的这个"快速路径零系统调用"设计直接启发了 JVM 的偏向锁和轻量锁设计。**

**关键认知**：JVM 的锁层次（偏向→轻量→重量）和 Linux futex 的层次（纯 CAS→futex_wait）是同构的——都是在"无竞争零开销"和"有竞争内核仲裁"之间做分层降级。

#### ③ `pthread_cond_wait/signal` → ParkEvent → park/unpark

```c
// JVM 源码: os_posix.cpp:1998-2137
void os::PlatformEvent::park() {
    int v = _event;
    if (v == 0) {                             // ★ 快速路径: _event > 0 直接返回, 不调 pthread
        pthread_mutex_lock(_mutex);
        while (_event < 0)
            pthread_cond_wait(_cond, _mutex); // 进内核等待
        _event = 0;
        pthread_mutex_unlock(_mutex);
    }
}

void os::PlatformEvent::unpark() {
    if (Atomic::xchg(1, &_event) >= 0) return;// ★ 快速路径: 没人等, 不调 pthread_cond_signal
    pthread_cond_signal(_cond);               // 真正唤醒等待者
}
```

**JVM 中用在哪？** `Unsafe.park()` → `Parker::park()` → `PlatformEvent::park()`。ObjectMonitor 的自适应自旋失败后调用 `Self->_ParkEvent->park()` 把线程挂起 [objectMonitor.cpp]。在 futex 之上又包了一层 `_event` 计数器的快速路径——避免不必要的 `pthread_mutex_lock`。

**关键认知**：park/unpark 是 JVM 线程挂起/唤醒的唯一原语。`Thread.sleep()`、`Object.wait()`、`LockSupport.park()`、synchronized 阻塞——全部最终走到 `pthread_cond_wait`。

#### ④ 内存屏障 — `lock addl`/`mfence` → OrderAccess → 锁的有序性

```c
// JVM 源码: orderAccess_linux_x86.hpp:48-51
inline void OrderAccess::fence() {
    // x86 上 mfence 比 lock addl 慢——HotSpot 用 lock addl 替代
    __asm__ volatile ("lock; addl $0,0(%%rsp)" : : : "cc", "memory");
}
// x86 是 TSO（Total Store Order）模型——Store-Load 需要显式屏障
// 其他三种顺序（LoadLoad/StoreStore/LoadStore）硬件自动保证
```

**JVM 中用在哪？** `ObjectMonitor::exit()` 释放 `_owner` 后需要 `OrderAccess::release()`——确保临界区内的写对所有后续 enter 者可见 [objectMonitor.cpp:921]。`Mutex::unlock()` 也同理 [mutex.cpp]。**没有屏障，其他 CPU 核心可能看到过期的 `_owner`。**

**关键认知**：x86 的内存模型相对强（TSO），所以 HotSpot 的 `acquire()` 和 `release()` 在 x86 上是空操作（只需编译器屏障）。但在 ARM/PowerPC（弱内存模型）上，它们是真正的 `dmb`/`sync` 指令。理解这一点才能理解 JVM 的 `atomic_memory_order` 枚举为什么存在。

#### ⑤ CPU 缓存行 & false sharing → ObjectMonitor 的 `DEFINE_PAD`

```c
// x86: L1 缓存行 = 64 bytes
// 两个 CPU 核心同时写同一缓存行的不同字段 → 缓存行在核心间乒乓
//   = false sharing = 性能灾难（50-100 倍退化）

// ObjectMonitor 源码: objectMonitor.hpp:148-150
DEFINE_PAD_MINUS_SIZE(0, DEFAULT_CACHE_LINE_SIZE, ...)
// ★ 在 _header 和 _owner 之间插入 padding ——
//   确保一个线程 CAS _owner 时不会 invalidate 另一个读 _header 的核心的缓存行
```

**JVM 中用在哪？** ObjectMonitor 的 `DEFINE_PAD` 在 `_header`（偏移 0）和 `_owner`（偏移 128）之间插入 ~104B padding。原因：enter 频繁 CAS `_owner`，exit 频繁读 `_header`（displaced markOop）——如果它们在同一缓存行，一个核心的 CAS 会让另一个核心的 L1 缓存失效，导致每次读都变内存访问。

**关键认知**：没有这个 padding，ObjectMonitor 在中等竞争下的性能会退化 10-20 倍。这是从"正确"到"高性能"的关键一步。

#### ⑥ `clone()` → `os::create_thread()` → JavaThread 诞生的系统调用

```c
// JVM 源码: os_linux.cpp
bool os::create_thread(Thread* thread, ThreadType thr_type, size_t stack_size) {
    pthread_attr_t attr;
    pthread_attr_setstacksize(&attr, stack_size);  // Java 线程栈大小(-Xss)
    pthread_create(&tid, &attr, java_start, thread); // glibc → clone() syscall
}
// clone() 是 Linux 创建线程的唯一系统调用
// glibc 的 pthread_create 最终调用 clone(CLONE_VM | CLONE_FS | CLONE_FILES | ...)
// CLONE_VM: 共享地址空间（线程），不加 = fork（进程）
```

**JVM 中用在哪？** `JVM_StartThread` [jvm.cpp:2890] → `os::create_thread(this, ...)` → `pthread_create` → `clone()`。`JavaThread::run()` 在子线程中执行 `thread_main_inner()` → 调用 `Threads::add(this)` 注册到全局线程链表 → 执行 Java `run()` 方法。

**关键认知**：JVM 中每个 Java 线程 = 一个内核可见的 `clone()` 创建的轻量进程（LWP）。`top -H` 能看到所有 Java 线程的内核线程 ID（TID）。这也是为什么创建线程很贵——每次都是系统调用 + 内核调度实体分配。

---

## 一、阅读路径

### 入门路径（预计 2.5 小时，得"骨架"）

```
1. 先读本节 §0.1-0.5                                  ← 你现在在这里
2. ★ 必读 §0.3: markOop / 三队列 / 锁升级 / JVM内部锁 / JVM线程全景
3. ★ 必读 §0.5: CAS/futex/pthread_cond/fence 6 个 Linux 原语
4. ★ 必读 §3.3: 17 种系统线程分类 — NonJavaThread vs JavaThread
5. 04-Synchronized-Full-Path.md                       ← 总览篇: monitorenter→OS mutex 全链路
6. 01-ObjectMonitor.md                                ← ★ 核心: enter/exit/wait/notify 源码
```

### 进阶路径（预计 12-16 小时，得"血肉"）

```
在入门基础上:
5. 05-JVM-Thread-Architecture.md    ← ★ JVM 17 种线程全景: 分类/创建/调度/safepoint
6. 03-BasicLock-Synchronizer.md     ← 轻量锁 CAS + inflate + hashCode 六种策略
7. 02-BiasedLocking.md              ← 偏向锁获取/撤销/epoch/批量撤销
8. 06-JVM-Thread-Lifecycle.md       ← JavaThread: create→状态机→exit→ThreadSMR
9. 07-JVM-VMThread.md               ← VMThread::loop() + VMOperation 体系
10. 08-JVM-WorkerThread.md           ← WorkGang + GC 并行调度 + 工作窃取
11. 09-JVM-JavaThread-System.md      ← 10 个系统 JavaThread 创建入口+职责
12. 10-JVM-NonJavaThread.md          ← 7 个内部线程详解: ConcurrentGC/Watcher/Compiler
13. 11-JVM-Internal-Locks.md         ← 80+ 全局 Mutex/Monitor 层级 + lock ranking
```

### 专家路径（按需查阅）

| 你想了解 | 看这篇 |
|---------|---------|
| 重量锁 enter/exit CAS + park 实现 | 01-ObjectMonitor |
| 偏向锁撤销 + epoch + 批量机制 | 02-BiasedLocking |
| 轻量锁 CAS → inflate → ObjectMonitor | 03-BasicLock-Synchronizer |
| Object.hashCode() 6 种生成策略 | 03-BasicLock-Synchronizer (hashCode 部分) |
| JVM 有多少种线程？各干什么？ | 05-JVM-Thread-Architecture |
| new Thread().start() → run() 全链路 | 06-JVM-Thread-Lifecycle |
| VMThread 怎么执行 STW 操作？ | 07-JVM-VMThread |
| GC 并行 Worker 怎么调度？ | 08-JVM-WorkerThread |
| 10 个系统 JavaThread 从哪创建？ | 09-JVM-JavaThread-System |
| 7 个 NonJavaThread 各自做什么？ | 10-JVM-NonJavaThread |
| 80 个全局锁层次 + lock ranking | 11-JVM-Internal-Locks |

---

## 二、环境准备

```bash
JAVA=/data/workspace/openjdk-cut-new/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java

# 偏向锁日志（JDK 自带）
$JAVA -Xms8g -Xmx8g -XX:+UseG1GC \
  -XX:+PrintBiasedLockingStatistics -Xlog:biasedlocking*=info -Xint \
  -cp /data/workspace/demo/src com.wjcoder.Main 2>&1 | head -20

# 禁用偏向锁（对比锁膨胀差异）
$JAVA -Xms8g -Xmx8g -XX:+UseG1GC -XX:-UseBiasedLocking \
  -Xlog:monitorinflation=info -Xint \
  -cp /data/workspace/demo/src com.wjcoder.Main 2>&1 | head -20

# GDB 调试锁
gdb --args $JAVA -Xms8g -Xmx8g -XX:+UseG1GC -XX:+UseBiasedLocking -Xint \
  -cp /data/workspace/demo/src com.wjcoder.Main
(gdb) break ObjectMonitor::enter
(gdb) break ObjectSynchronizer::slow_enter
(gdb) break ObjectSynchronizer::inflate
(gdb) break BiasedLocking::revoke_and_rebias
(gdb) run
# 在 ObjectMonitor::enter 断点:
(gdb) p *this              # 全字段
(gdb) p/x _header          # displaced markOop
(gdb) p _owner             # 持有者线程
(gdb) p _cxq               # 竞争队列头
(gdb) p _EntryList         # 就绪队列头
(gdb) p _WaitSet           # 等待队列头
```

---

## 三、锁与线程全景

### 3.1 锁状态转换图（markOop 位视角）

```
new Object() → markOop: [hash:31][unused:1][age:4][0][01]  biased_lock=0 lock=01=unlocked

4秒安全延迟后 → 匿名偏向:
  markOop: [0...0][epoch:2][unused:1][age:4][1][01]  lock=01, biased_lock=1

T1 第一次 synchronized(obj):
  CAS [T1_ptr:54] 写入 markOop → biased to T1 ★ 仅一次 CAS!

T2 也争同一个偏向锁 → revoke_and_rebias():
  SAFEPOINT 暂停 T1 → 检查是否在临界区
  ├─ 不在 → 重偏向给 T2 (CAS)
  ├─ 在   → 撤销偏向 → 升级轻量锁:
  │    markOop: [ptr_to_BasicLock:62][00]  lock=00
  │    BasicLock._displaced_header = 原始 markOop
  │    └─ T2 CAS 失败 → slow_enter:
  │         ├─ 同一线程? → 重入(递归 enter count +1)
  │         └─ 不同线程 → inflate():
  │              markOop: [ptr_to_ObjectMonitor:62][10]  lock=10
  │              → ObjectMonitor::enter() → CAS_owner → 自旋 → park
  └─ epoch 变更 → 批量重偏向(BulkRebiasThreshold=20)

降级:
  后台 SafepointCleanupTask → 空闲 ObjectMonitor → deflate → markOop 恢复 unlocked
```

### 3.2 ObjectMonitor 内部结构

```
ObjectMonitor (~216B, C heap mtObjectMonitor):

  偏移    字段            类型              含义
  ─────────────────────────────────────────────────────────────
  +0    _header          volatile markOop   displaced object header
  +8    _object          void*              → 关联 Java 对象
  +16   FreeNext         ObjectMonitor*     全局空闲链表
  +24   [padding]        DEFINE_PAD         cache line 对齐
  +128  _owner           void* volatile     ★ 持有者线程(TLS*或BasicLock*)
  +136  _previous_owner  volatile jlong     前持有者 TID
  +144  _recursions      volatile intptr_t  ★ 重入计数(0=首次进入)
  +152  _EntryList       ObjectWaiter*      ★ 就绪队列头
  +160  _cxq             ObjectWaiter*      ★ 竞争队列头(LIFO入队)
  +168  _succ            Thread* volatile   继任者线程
  +176  _Responsible     Thread* volatile   负责线程(防惊群)
  +184  _Spinner         volatile int       自旋计数器
  +188  _SpinDuration    volatile int       ★ 自适应自旋时长
  +192  _count           volatile jint      引用计数(防降级误删)
  +196  _WaitSet         ObjectWaiter*      ★ 等待队列头
  +204  _waiters         volatile jint      等待线程计数
  +208  _WaitSetLock     volatile int       WaitSet 自旋锁

队列流转:
  _cxq(LIFO entry) → exit()时整链搬移(QMode控制) → _EntryList(FIFO出队)
  → 线程持有_owner → wait() → _WaitSet(双向链表) → notify() → _EntryList
```

### 3.3 线程体系详解

```
Thread (thread.hpp:115)                     ← 所有线程基类: _osthread(OSThread*), _ParkEvent, _MutexEvent
│
├── NonJavaThread (:792)                    ← JVM 内部线程（C++ 代码创建，无 Java 栈帧）
│   │                                         ★ 不被 safepoint 暂停！只有 JavaThread 需要到 safepoint
│   │
│   ├── NamedThread (:830)                  ← 有名字的线程（便于 jstack 调试）
│   │   │
│   │   ├── VMThread (vmThread.hpp:114)     ★ 唯一 VM 操作执行者:
│   │   │   │   VMOperationQueue → pop() → doit()
│   │   │   │   执行: GC/逆优化/偏向锁撤销/线程dump/类重定义
│   │   │   │   等待所有 JavaThread 到 safepoint 后才执行
│   │   │   │   返回后唤醒所有 JavaThread
│   │   │
│   │   ├── ConcurrentGCThread              ★ 并发 GC 后台线程基类
│   │   │   ├── G1ConcurrentMarkThread       ← SATB+Finger 并发标记 [06 §4.2]
│   │   │   ├── G1ConcurrentRefineThread     ← RSet 异步更新（DirtyCardQueue 消费端）
│   │   │   ├── G1YoungRemSetSamplingThread  ← 记忆集采样
│   │   │   ├── ConcurrentMarkSweepThread    ← CMS 并发线程
│   │   │   ├── ShenandoahControlThread      ← Shenandoah GC
│   │   │   └── ZDirector/ZDriver            ← ZGC
│   │   │
│   │   ├── WorkerThread (:858)             ★ GC 并行 worker 基类
│   │   │   └── AbstractGangWorker           ← WorkGang::run_task() 调度
│   │   │       └── GangWorker               ← Young/Mixed/Full GC workers
│   │
│   └── WatcherThread (:875)                ← 定时任务: PeriodicTask 框架
│       └── 周期性执行: 偏向锁延迟启用 / JFR 采样 / 低内存检测
│
└── JavaThread (:925)                       ← ★ Java 代码创建的线程 + 系统线程
    │   ★ 拥有完整 JVM 栈（解释器/C1/C2/本地帧）
    │   ★ 被 safepoint 暂停——轮询 SafepointPollingPage
    │   ★ synchronized 的执行者
    │
    ├── 应用线程          new Thread().start() → JVM_StartThread → os::create_thread
    ├── ServiceThread (serviceThread.hpp:35)  PeriodicTask: 低内存检测 / JNI 周期检查 / StringTable 清理
    ├── CompilerThread (thread.hpp:2130)  ★ C1/C2 JIT 编译线程（compiler_thread 栈4MB）
    │   └── CompileBroker::compiler_thread_loop() → 从 CompileQueue 取任务
    ├── CodeCacheSweeperThread (thread.hpp:2109) ← 清理 zombie/not_entrant nmethod
    ├── JvmtiAgentThread   JVMTI 调试代理（-agentlib:jdwp 等）
    ├── ReferenceHandler   java.lang.ref.Reference 引用队列处理（非独立 C++ 类，特殊入口）
    ├── FinalizerThread    Object.finalize() 执行线程
    ├── SignalDispatcher   SIGINT/SIGTERM → Shutdown 钩子分发
    └── AttachListener     jcmd/jstack/jmap 等诊断工具连接入口

Threads (:2203) → 全局 JavaThread 链表管理:
  _thread_list → JavaThread* 链表头（双向链表）
  add(JavaThread*) → 线程启动时注册
  remove(JavaThread*) → 线程退出时注销
  ThreadSMRSupport → Hazard Pointers 保证遍历安全性
```

**三类线程的 safepoint 行为**：

| 类别 | 代表 | safepoint 行为 |
|------|------|---------------|
| **JavaThread** | 应用线程、CompilerThread、CodeCacheSweeperThread | ★ 被暂停——轮询 polling page，在 safepoint 阻塞（`_thread_blocked`） |
| **NonJavaThread 有锁** | VMThread、WatcherThread | 自行约定——不在 safepoint 期间获取可能有竞争的锁 |
| **NonJavaThread 无锁** | ConcurrentGCThread、WorkerThread | 不受 safepoint 影响——继续并发执行 |

### 3.4 ObjectMonitor 相关线程角色

```
一次 synchronized 竞争中的线程角色:

  _owner          ← 持有锁、正在临界区执行的线程
  _cxq 上的线程    ← CAS _owner 失败、刚入队、等待抢锁
  _EntryList 上的  ← 从 _cxq 整批转移、就绪等待唤醒
  _WaitSet 上的    ← wait() 后释放锁等待 notify 的线程
  _Responsible     ← 负责线程——用 timed-park 代替 park，定期检查锁是否已释放（防 stranding）
  _succ            ← 继任者——exit() 时选定的下一个 owner，减少"惊群唤醒"
```

### 3.5 实测：一个最小 JVM 进程（G1GC）启动了多少线程？

```
$ jstack $PID | grep '"'

"main"                              #1   JavaThread — 应用主线程
"Reference Handler"                 #2   JavaThread — 引用处理守护线程
"Finalizer"                         #3   JavaThread — finalize() 守护线程
"Signal Dispatcher"                 #4   JavaThread — 信号分发守护线程
"Service Thread"                    #5   JavaThread — 低内存/JNI 周期检查
"C2 CompilerThread0"                #6   JavaThread — C2 JIT 编译线程
"C1 CompilerThread0"                #9   JavaThread — C1 JIT 编译线程
"Sweeper thread"                    #10  JavaThread — CodeCache 清理线程
"Common-Cleaner"                    #11  JavaThread — JDK Cleaner 线程
"Attach Listener"                   #12  JavaThread — jcmd/jstack 连接入口

"VM Thread"                              NonJavaThread — ★ 所有 STW 操作的执行者
"GC Thread#0"                            NonJavaThread — G1 并行 GC worker
"G1 Main Marker"                         NonJavaThread — G1ConcurrentMarkThread
"G1 Conc#0"                              NonJavaThread — G1ConcurrentRefineThread
"G1 Refine#0"                            NonJavaThread — G1 异步 RSet 更新线程
"G1 Young RemSet Sampling"               NonJavaThread — 记忆集采样
"VM Periodic Task Thread"                NonJavaThread — WatcherThread 定时任务

总计: 17 个线程（10 个 JavaThread + 7 个 NonJavaThread）
OS 内核: ps -T 显示 18 个 SPID (包含主进程 SPID)
所有 NonJavaThread 在 WCHAN=futex_wait_queue — 挂在内核 futex 上等待
```

**关键观察**：

| # | 发现 | 对应源码 |
|---|------|---------|
| 1 | CompilerThread 在 JavaThread 分支（jstack 编号 #6/#9，被 safepoint 暂停） | `thread.hpp:2130` — `class CompilerThread : public JavaThread` |
| 2 | G1 启动了 3 个并发线程（Main Marker + Conc#0 + Refine#0），而非只有 1 个 | G1ConcRefinementThreads = ParallelGCThreads（默认 CPU 核心数） |
| 3 | "VM Periodic Task Thread" = WatcherThread — 虽然命名为 "VM Periodic"，但它在 NonJavaThread 分支 | `thread.hpp:875` — `class WatcherThread : public NonJavaThread` |
| 4 | 所有线程的 `os_prio=0` — JVM 不由内核调度优先级，而是靠 futex 的公平唤醒 | 全部 `S futex_wait_queue` |
| 5 | `Reference Handler` 和 `Finalizer` 是普通的 `JavaThread` 实例（非独立 C++ 类） | 通过特殊 Java 入口函数创建 |

---

## 四、完整文件索引

| # | 文件 | 核心类 | 说明 |
|---|------|--------|------|
| 1 | `objectMonitor.cpp/.hpp` | `ObjectMonitor` | ★ 重量锁: enter/exit/wait/notify |
| 2 | `synchronizer.cpp/.hpp` | `ObjectSynchronizer` | ★ 锁入口调度: fast_enter/slow_enter/inflate/deflate/hashCode |
| 3 | `biasedLocking.cpp/.hpp` | `BiasedLocking` | ★ 偏向锁: revoke/rebias/bulk_revoke |
| 4 | `basicLock.cpp/.hpp` | `BasicLock` / `BasicObjectLock` | 轻量锁: 栈上 displaced header(8B) |
| 5 | `thread.cpp/.hpp` | `JavaThread` / `Threads` | ★ 线程生命周期: 创建/运行/退出 |
| 6 | `mutex.cpp/.hpp` | `Mutex` / `Monitor` | JVM 内部互斥锁: CAS+自旋+pthread_mutex |
| 7 | `mutexLocker.cpp/.hpp` | `MutexLocker` / 80+ 全局锁 | ★ Lock ranking 死锁预防 |
| 8 | `safepoint.cpp/.hpp` | `SafepointSynchronize` | SafePoint: 偏向锁撤销的必要前提 |
| 9 | `park.cpp/.hpp` | `ParkEvent` | ★ park/unpark 原语: pthread_cond_wait |
| 10 | `threadSMR.cpp/.hpp` | `ThreadsSMRSupport` | 安全内存回收(Hazard Pointers) |
| 11 | `vmThread.cpp/.hpp` | `VMThread` | VM 操作线程 |
| 12 | `vmOperations.hpp` | `VM_RevokeBias` | ★ 偏向锁撤销的 VM 操作封装 |
| 13 | `osThread.cpp/.hpp` | `OSThread` | OS 线程封装(pthread_id) |
| 14 | `handshake.cpp/.hpp` | `Handshake` | 线程握手(替代部分 safepoint) |
| 15 | `monitorChunk.cpp/.hpp` | `MonitorChunk` | 解释器用 BasicObjectLock 数组 |
| 16 | `javaCalls.cpp/.hpp` | `JavaCalls` | C++ 调用 Java 方法 |
| 17 | `reflection.cpp/.hpp` | `Reflection` | 反射调用支持 |
| 18 | `interfaceSupport.cpp` | `InterfaceSupport` | JNI/VM 状态切换 |

### 关键函数精确定位

| 函数 | 文件:行号 | 触发/作用 |
|------|-----------|------|
| `TemplateTable::monitorenter()` | `templateTable_x86.cpp` | monitorenter 字节码 → 选择锁路径 |
| `ObjectSynchronizer::fast_enter()` | `synchronizer.cpp:265` | 尝试偏向锁 → 轻量锁 CAS |
| `ObjectSynchronizer::slow_enter()` | `synchronizer.cpp:340` | 轻量 CAS 失败 → inflate |
| `ObjectSynchronizer::inflate()` | `synchronizer.cpp:1403` | ★ 分配 ObjectMonitor → CAS 安装 |
| `ObjectMonitor::enter()` | `objectMonitor.cpp:266` | ★ CAS_owner → 自旋 → park |
| `ObjectMonitor::exit()` | `objectMonitor.cpp:921` | ★ 释放 → QMode 唤醒策略 |
| `ObjectMonitor::wait()` | `objectMonitor.cpp:1444` | wait() → 释放锁 → park |
| `ObjectMonitor::notify()` | `objectMonitor.cpp:1798` | notify() → WaitSet → EntryList |
| `BiasedLocking::revoke_and_rebias()` | `biasedLocking.cpp:624` | ★ 偏向锁撤销(safepoint 中) |
| `get_next_hash()` | `synchronizer.cpp:678` | hashCode 六种策略 |

---

## 五、关键数据结构（GDB 实测）

| 结构 | sizeof | 作用 | 核心字段 |
|------|:---:|------|------|
| `markOopDesc` | **8B** | 对象头—hash+age+锁状态(粒度: 64bit word) | biased_lock(1)+lock(2)+age(4)+hash(31) |
| `BasicLock` | **8B** | 栈上轻量锁(粒度: 8B on stack) | `_displaced_header`(markOop) |
| `BasicObjectLock` | **16B** | 解释器栈帧 monitor slot | `_lock`(8B) + `_obj`(oop*,8B) |
| `ObjectMonitor` | **~216B** | ★ 重量锁实现(粒度: C heap) | `_owner`, `_cxq`, `_EntryList`, `_WaitSet`, `_recursions`, `_SpinDuration` |
| `ObjectWaiter` | **~56B** | 队列节点(粒度: C heap) | `_thread`, `_next`, `_prev`, `_event`, `TState` |
| `JavaThread` | **~2KB** | Java 线程(粒度: C heap mtThread) | `_thread_state`, `_stack_base`, `_satb_mark_queue` |
| `OSThread` | **~100B** | OS 线程封装(粒度: C heap) | `_thread_id`, `_state` |
| `ParkEvent` | **~128B** | park/unpark 原语(粒度: C heap) | pthread_mutex_t + pthread_cond_t |
| `Mutex` | **~80B** | JVM 内部互斥锁(粒度: C heap) | `_lock`(SplitWord), `_owner`(Thread*), `_rank`(MutexRank) |

---

## 六、探针覆盖

| 阶段 | 探针 | 触发时机 |
|------|------|---------|
| **偏向锁** | `BiasedLock REVOKE (anonymous)` | 匿名偏向锁撤销 CAS |
| | `BiasedLock SAFEPOINT_REVOKE` | safepoint 中: SINGLE/BULK_REBIAS/BULK_REVOKE |
| **膨胀** | `Lock INFLATE (neutral_CAS_failed)` | 无锁 CAS 失败 → inflate |
| | `Lock INFLATE (locked_other_thread)` | 被其他线程持有 → inflate |
| | `Lock INFLATE (auto-inflated)` | 已是膨胀态 |
| **hashCode** | `FastHashCode INSTALL` | hashCode CAS 写入对象头 |
| | `FastHashCode INFLATE` | hashCode 需先膨胀 |
| **降级** | `MonitorDeflation (scavenged)` | 清理空闲 ObjectMonitor |
| | `MonitorDeflation (inuse)` | 正在使用中 |
| **线程** | `ThreadSMR::add_thread` | 线程注册到 ThreadSMR |
| | `Handshake::execute` | 线程握手 |

---

## 七、计划文档（7 篇核心 + 2 篇扩展）

---

### P0-01 ObjectMonitor — 重量锁完整实现

> 源文件: `objectMonitor.cpp/hpp/inline.hpp`, `synchronizer.cpp`(inflate/deflate)

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `objectMonitor.hpp` | `src/hotspot/share/runtime/objectMonitor.hpp` | 02-runtime:#60 | ★ ObjectMonitor 全字段定义，DEFINE_PAD 偏移 | `_owner`, `_cxq`, `_EntryList`, `_WaitSet`, `_recursions`, `_SpinDuration` |
| 2 | `objectMonitor.cpp` | `src/hotspot/share/runtime/objectMonitor.cpp` | 02-runtime:#59 | ★ enter/exit/wait/notify 全部实现 | `enter()`:266, `EnterI()`:454, `exit()`:921, `wait()`:1444, `notify()`:1798 |
| 3 | `objectMonitor.inline.hpp` | `src/hotspot/share/runtime/objectMonitor.inline.hpp` | 02-runtime:#61 | TryLock/TrySpin 内联 | `TryLock()`:436, `TrySpin_VaryDuration()` |
| 4 | `synchronizer.cpp` | `src/hotspot/share/runtime/synchronizer.cpp` | 02-runtime:#122 | inflate/deflate 实现 + fast_enter/slow_enter 入口 | `inflate()`:1403, `deflate_idle_monitors()`:1747 |
| 5 | `synchronizer.hpp` | `src/hotspot/share/runtime/synchronizer.hpp` | 02-runtime:#123 | ObjectSynchronizer 类定义 | `fast_enter()`, `slow_enter()`, `inflate()` 声明 |
| 6 | `markOop.hpp` | `src/hotspot/share/oops/markOop.hpp` | 01-oops:#50 | markOop 位布局 + has_monitor()/is_locked() 判断 | `has_monitor()`:273, `lock bits` 枚举 |
| 7 | `park.hpp` | `src/hotspot/share/runtime/park.hpp` | 02-runtime:#72 | ParkEvent 定义，park/unpark 原语 | `ParkEvent` 类 |
| 8 | `park.cpp` | `src/hotspot/share/runtime/park.cpp` | 02-runtime:#71 | park/unpark 实现（objectMonitor 中 Self->_ParkEvent->park()） | `park()` 调用链 |
| 9 | `orderAccess.hpp` | `src/hotspot/share/runtime/orderAccess.hpp` | 02-runtime:#63 | 内存屏障——exit() 中 OrderAccess::release_store | `release()`, `fence()` |
| 10 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | 02-runtime:#127 | JavaThread::_ParkEvent 字段 | `_ParkEvent`, `_MutexEvent` |
> 关键函数(精确行号): `enter()`:266, `exit()`:921, `EnterI()`:454, `TryLock()`:436, `TrySpin()`:1908, `wait()`:1444, `notify()`:1798
> 预估: ~600 行

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | 源文件清单（4 个文件 + inflate/deflate 来源标注） | 文件索引表 |
| §一 | 核心原理：为什么需要重量锁 — 轻量锁 CAS 失败→必须有一个"仲裁者"，enter/exit/wait/notify 四操作全景 | "为什么" → 数量级直觉 |
| §二 | **数据结构**: ObjectMonitor 全部字段（偏移表，~216B）+ ObjectWaiter 全部字段 + markOop 编码 ObjectMonitor 指针的方式 | 每个字段标注粒度（Thread*/intptr_t/jlong/ObjectWaiter*/jint），DEFINE_PAD 防 false sharing 原理 |
| §三 | **enter() 源码逐行**: ①CAS _owner=NULL(快速路径) → ②重入检查(cur==Self, _recursions++) → ③栈锁升级(is_lock_owned) → ④Knob_SpinEarly 抢先自旋 → ⑤Atomic::inc(&_count) 防降级 → ⑥JavaThreadBlockedOnMonitorEnter 状态切换 → ⑦EnterI() 慢路径 | 每一步标注行号 + CAS 失败后的决策树，Mermaid 流程图 |
| §四 | **EnterI() 慢路径**: ①TryLock(TATAS) → ②TrySpin 自适应自旋 → ③自旋失败→ObjectWaiter 入队 _cxq（LIFO, CAS 竞争插入） → ④park() → ⑤醒来后 TryLock → ⑥成功则出队 | _Responsible 线程 timed-park 防 stranding，_succ 继任者机制 |
| §五 | **exit() 源码逐行**: ①_recursions>0→减计数返回 → ②退出策略: ExitPolicy 1-0 vs 1-1 → ③OrderAccess::release_store(&_owner, NULL) → ④storeload 屏障 → ⑤检查 _cxq/_EntryList → ⑥QMode=0/2/3/4 四种唤醒策略源码 → ⑦ExitEpilog→unpark 继任者 | 每种 QMode 的区别与适用场景，futile wakeup throttling 原理 |
| §六 | **wait()/notify()**: ①wait() 释放锁→加入 _WaitSet 双向链表尾部→park → ②notify() 从 _WaitSet 头部取→转移到 _EntryList/_cxq → ③notifyAll() 全量转移 | WaitSet 自旋锁 `_WaitSetLock` 保护 |
| §七 | **Adaptive Spinning**: `_SpinDuration` 递增/递减规则，历史成功率反馈，`Knob_SpinLimit`/`Knob_PreSpin`/`Knob_SpinBackOff` 调优参数 | 自旋成功→duration++，失败→duration-- |
| §八 | **GDB 验证**: `ptype /o ObjectMonitor` 偏移验证, `p sizeof(ObjectMonitor)`, 断点 enter/exit/EnterI | 可证伪断言 ≥9 条 |
| §九 | 一句话总结 + 交叉引用 [03-BasicLock-Synchronizer] inflate, [05-JVM-Thread-Architecture] 线程分类 |

> 📎 **前置依赖**: README §0.3B（三队列概念）、§0.3C（锁升级路径）、§0.5③（pthread_cond/park）
> 📎 **GDB 实测点**: `p *this` 在 enter() 断点看 _owner/_cxq/_EntryList/_WaitSet 运行时状态

---

### P0-03 BasicLock-Synchronizer — 轻量锁 + 膨胀 + hashCode

> 源文件: `synchronizer.cpp/hpp`, `basicLock.cpp/hpp`, `markOop.hpp`
> 关键函数: `fast_enter()`:265, `slow_enter()`:340, `inflate()`:1403, `deflate_idle_monitors()`:1747, `get_next_hash()`:678, `FastHashCode()`:719
> 预估: ~550 行

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `synchronizer.cpp` | `src/hotspot/share/runtime/synchronizer.cpp` | 02-runtime:#122 | ★ 轻量锁+膨胀+hashCode核心实现 | `fast_enter()`:265, `slow_enter()`:340, `inflate()`:1403, `deflate_idle_monitors()`:1747, `get_next_hash()`:678, `FastHashCode()`:719 |
| 2 | `synchronizer.hpp` | `src/hotspot/share/runtime/synchronizer.hpp` | 02-runtime:#123 | ObjectSynchronizer 类声明 | `fast_enter()`, `slow_enter()`, `inflate()` 声明 |
| 3 | `basicLock.hpp` | `src/hotspot/share/runtime/basicLock.hpp` | 02-runtime:#9 | BasicLock/BasicObjectLock 类定义 | `BasicLock::_displaced_header`, `BasicObjectLock::_lock+_obj` |
| 4 | `basicLock.cpp` | `src/hotspot/share/runtime/basicLock.cpp` | 02-runtime:#8 | BasicLock 方法实现 | `BasicLock::print()` |
| 5 | `markOop.hpp` | `src/hotspot/share/oops/markOop.hpp` | 01-oops:#50 | markOop 位布局 + 锁状态判断 | `has_displaced_mark_helper()`, `is_locked()`, `is_unlocked()`, lock bits 枚举 |
| 6 | `objectMonitor.hpp` | `src/hotspot/share/runtime/objectMonitor.hpp` | 02-runtime:#60 | inflate 目标：ObjectMonitor 字段 | `_owner`, `_header`(存 displaced hash) |
| 7 | `objectMonitor.cpp` | `src/hotspot/share/runtime/objectMonitor.cpp` | 02-runtime:#59 | slow_enter→enter() 调用链 | `enter()` 入口 |
| 8 | `orderAccess.hpp` | `src/hotspot/share/runtime/orderAccess.hpp` | 02-runtime:#63 | CAS 内存屏障 | `cmpxchg` 序列 |
| 9 | `templateTable_x86.cpp` | `src/hotspot/cpu/x86/templateTable_x86.cpp` | 05-interpreter | monitorenter/monitorexit 字节码入口 | `monitorenter()`, `monitorexit()` |

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | 源文件清单（9 个文件，跨 runtime/oops/interpreter） | 文件索引表 |
| §一 | **核心原理**: 轻量锁=栈上 CAS，为什么快？→ 无系统调用无上下文切换。CAS 失败的三种归宿：重入/偏向锁升级/inflate | 对比重量锁的周期开销 |
| §二 | **数据结构**: BasicLock(8B, displaced markOop), BasicObjectLock(16B, lock+oop), 解释器栈帧中 Lock Record 布局 | GDB 验证栈上 Lock Record 地址 |
| §三 | **fast_enter() 源码**: ①BiasedLocking::revoke_and_rebias 或 ②CAS BasicLock*→对象头 → ③成功=轻量锁获取, 失败→slow_enter | 单次 `lock cmpxchg` 汇编映射 |
| §四 | **slow_enter() 源码**: ①重入检查(同一线程→displaced_header 匹配) → ②inflate() → ③ObjectMonitor::enter() | 重入计数 vs ObjectMonitor._recursions 对比 |
| §五 | **inflate() 三种原因** (插桩可区分): ①neutral_CAS_failed — 无锁状态多线程同时 CAS → ②locked_other_thread — 已被其他线程轻量持有 → ③auto_inflated — 已膨胀。inflate 内部: ObjectMonitor 分配→CAS 安装到对象头→设置 displaced header | inflate 的全路径 Mermaid |
| §六 | **hashCode 六种策略** (`get_next_hash`): 0=Park-Miller 随机, 1=随机⊕地址, 2=恒为1(测试), 3=自增序列, 4=对象地址, **5=Marsaglia XOR-Shift(JDK8+默认)** | 每种策略的算法、优缺点、性能对比 |
| §七 | **markOop hash 冲突**: ①偏向锁模式下调用 hashCode → 必须撤销偏向 → ②轻量锁已持有 hashCode → displaced 到 BasicLock → ③膨胀后 hashCode → 存 ObjectMonitor._header | 三种锁状态存储 hash 的方式对比 |
| §八 | **deflate_idle_monitors**: SafepointCleanupTask 扫描→_count==0→删除 ObjectMonitor→markOop 恢复，`MonitorDeflation(scavenged/inuse/circulating)` 探针 | deflate 的 safepoint 依赖 |
| §九 | GDB 验证 + 可证伪断言 | ≥8 条 |

> 📎 **前置依赖**: README §0.3A（markOop 位布局）、[01-ObjectMonitor] enter/exit
> 📎 **关键验证**: `Atomic::cmpxchg` in `synchronizer.cpp:265` — 单次 CAS 获取轻量锁

---

### P0-02 BiasedLocking — 偏向锁全机制

> 源文件: `biasedLocking.cpp/hpp`, `markOop.hpp`, `vmOperations.hpp`(VM_RevokeBias), `klass.hpp`(_prototype_header/epoch), `synchronizer.cpp`(fast_enter→biased_locking_enter), `thread.hpp`(JavaThread)
> 关键函数(精确行号): `revoke_and_rebias()`:624, `bulk_revoke_or_rebias_at_safepoint()`:374, `Condition` 枚举: `biasedLocking.hpp:161`, `fast_enter()`:265, `biased_locking_enter()`:synchronizer.cpp
> 预估: ~550 行

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `biasedLocking.cpp` | `src/hotspot/share/runtime/biasedLocking.cpp` | 02-runtime:#10 | ★ 偏向锁撤销/重偏向/批量撤销全部实现 | `revoke_and_rebias()`:624, `bulk_revoke_or_rebias_at_safepoint()`:374, `single_revoke_at_safepoint()` |
| 2 | `biasedLocking.hpp` | `src/hotspot/share/runtime/biasedLocking.hpp` | 02-runtime:#11 | BiasedLocking 类定义 + Condition 枚举 + JVM 参数声明 | `Condition` 枚举:161, `BiasedLockingStartupDelay`, `BiasedLockingBulkRebiasThreshold`, `BiasedLockingBulkRevokeThreshold` |
| 3 | `markOop.hpp` | `src/hotspot/share/oops/markOop.hpp` | 01-oops:#50 | ★ markOop 偏向位布局定义 + 锁状态判断 | biased_lock+lock 位域, `has_bias_pattern()`, `biased_locker()`, `bias_epoch()`, `set_bias()` |
| 4 | `markOop.inline.hpp` | `src/hotspot/share/oops/markOop.inline.hpp` | 01-oops:#51 | markOop 内联方法（偏向锁相关快速判断） | `is_biased()`, `has_bias_pattern()` 内联实现 |
| 5 | `vmOperations.hpp` | `src/hotspot/share/runtime/vmOperations.hpp` | 02-runtime:#156 | VM_RevokeBias/VM_BulkRevokeBias 操作定义 | `VM_RevokeBias`, `VM_BulkRevokeBias` 类声明 |
| 6 | `vmOperations.cpp` | `src/hotspot/share/runtime/vmOperations.cpp` | 02-runtime:#155 | VM_RevokeBias/VM_BulkRevokeBias 的 doit() 实现 | `VM_RevokeBias::doit()`, `VM_BulkRevokeBias::doit()` |
| 7 | `klass.hpp` | `src/hotspot/share/oops/klass.hpp` | 01-oops:#45 | ★ `_prototype_header`(含类级别 epoch) + `_bias_count` 字段 | `_prototype_header`, `set_prototype_header()`, bias epoch 存储位置 |
| 8 | `instanceKlass.hpp` | `src/hotspot/share/oops/instanceKlass.hpp` | 01-oops:#34 | InstanceKlass 继承 Klass，_prototype_header 实际持有者 | 类级别 epoch 机制实例 |
| 9 | `synchronizer.cpp` | `src/hotspot/share/runtime/synchronizer.cpp` | 02-runtime:#122 | fast_enter() → biased_locking_enter() 调用入口 | `fast_enter()`:265, `biased_locking_enter()` |
| 10 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | 02-runtime:#127 | JavaThread 作为偏向持有者，_biased_lock_marker 字段 | `JavaThread` 类, 偏向锁持有者身份标识 |

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | 源文件清单（10 个文件，跨 runtime/oops） | 文件索引表 |
| §一 | **核心原理**: 为什么需要偏向锁？— 多数锁"总是同一个线程反复获取"（实测 >80%）。偏向锁把"获取"从 CAS 降为单次 CAS + 无后续 CAS 的偏向状态 | 数量级：偏向锁获取 1 次 CAS vs 轻量锁每次 CAS |
| §二 | **markOop 偏向位布局**: 54bit JavaThread* + 2bit epoch + 1bit unused + 4bit age + 1bit biased_lock + 2bit lock | 和普通 markOop 的字段占用对比图 |
| §三 | **匿名偏向**: BiasedLockingStartupDelay(4秒) → `BiasedLockingBulkRebiasThreshold`(20) / `BiasedLockingBulkRevokeThreshold`(40) 参数 | JVM 启动时为什么等 4 秒？— 避免大量启动期间的类加载/初始化锁产生无意义的偏向撤销 |
| §四 | **偏向获取**: 第一次 `synchronized(obj)` → CAS 线程指针到对象头 → 成功 = biased to T1。之后 T1 再进同一个锁 → 只需检查线程指针匹配（无需 CAS！） | 极简路径：单次指针比较 |
| §五 | **撤销: revoke_and_rebias()**: STW → VM_RevokeBias → 暂停偏向持有者 → 检查是否仍在临界区 → ①不在 → 重偏向给新线程(CAS) → ②在 → 撤销偏向 → 升级轻量锁 | safepoint 依赖（连接 [06-gc-memory]） |
| §六 | **Epoch 机制**: 类级别 2bit epoch 计数器 → 类加载/重定义时 epoch++ → 对象上的旧 epoch 偏向自动失效 → 下次进入时触发 rebias | epoch 如何减少 per-object 撤销 |
| §七 | **批量重偏向 (Bulk Rebias)**: 单个类撤销次数达 20 → 全类 epoch++ → 所有该类对象下次进入时重偏向（而非每个都撤销） | 批量操作节省 safepoint 开销 |
| §八 | **批量撤销 (Bulk Revoke)**: BulkRebias 后仍频繁撤销达 40 → 禁用该类的偏向锁（永久） | `Condition` 枚举: NOT_BIASED/BIAS_REVOKED/BIAS_REVOKED_AND_REBIASED |
| §九 | **强制撤销触发**: hashCode() 调用 / wait() 调用 → 偏向锁无法共存 → 立即撤销 | 之前 README §0.3A 的 markOop 冲突的完整展开 |
| §十 | GDB 验证 + GC log 对比（`-XX:+PrintBiasedLockingStatistics`）+ 可证伪断言 | ≥8 条 |

> 📎 **前置依赖**: [03-BasicLock-Synchronizer] fast_enter/slow_enter, [06-gc-memory] safepoint 机制
> 📎 **关键 JVM 参数**: `-XX:+/-UseBiasedLocking`, `-XX:BiasedLockingStartupDelay=0`

---

### P0-05 JVM-Thread-Architecture — 17 种线程全景

> 源文件: `thread.hpp/cpp`, `vmThread.hpp/cpp`, `concurrentGCThread.hpp`, `workgroup.hpp`, `os_linux.cpp`(os::create_thread), `jvm.cpp`(JVM_StartThread), `threadSMR.hpp/cpp`
> 关键函数: `os::create_thread()`(os_linux.cpp:965), `Threads::add()`(thread.cpp:4716), `Threads::create_vm()`(thread.cpp:3620-4300), `Threads::remove()`(thread.cpp:4754), `JVM_StartThread()`(jvm.cpp:2890)
> 前置素材: §3.5 实测 jstack 17 线程列表 + §0.4 概念 E 线程全景树
> 预估: ~600 行

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | 02-runtime:#127 | ★ Thread/JavaThread/NonJavaThread 全部类定义 + 继承体系 | `Thread`:115, `JavaThread`:925, `NonJavaThread`:792, `Threads`:2203 |
| 2 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | 02-runtime:#126 | ★ Threads::create_vm()/add()/remove() + JavaThread::exit() | `create_vm()`:3620, `Threads::add()`:4716, `JavaThread::exit()`:1932 |
| 3 | `vmThread.hpp` | `src/hotspot/share/runtime/vmThread.hpp` | 02-runtime:#160 | VMThread 类定义 + VMOperationQueue 声明 | `VMThread` class, `_vm_queue` |
| 4 | `vmThread.cpp` | `src/hotspot/share/runtime/vmThread.cpp` | 02-runtime:#159 | ★ VMThread::loop() — STW 操作唯一执行者 | `loop()`:465, `evaluate_operation()` |
| 5 | `concurrentGCThread.hpp` | `src/hotspot/share/gc/shared/concurrentGCThread.hpp` | 06-gc:#42 | ConcurrentGCThread 基类定义 | `ConcurrentGCThread` class, `should_terminate()` |
| 6 | `concurrentGCThread.cpp` | `src/hotspot/share/gc/shared/concurrentGCThread.cpp` | 06-gc:#41 | ConcurrentGCThread::run() 实现 | `run()`, `stop()` |
| 7 | `workgroup.hpp` | `src/hotspot/share/gc/shared/workgroup.hpp` | 06-gc:#153 | ★ WorkGang/AbstractGangWorker/AbstractGangTask 定义 | `WorkGang` class, `AbstractGangWorker` class |
| 8 | `workgroup.cpp` | `src/hotspot/share/gc/shared/workgroup.cpp` | 06-gc:#152 | WorkGang::run_task()/initialize_workers() | `run_task()`:280, `initialize_workers()` |
| 9 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | 12-os-cpu:#12 | ★ os::create_thread() — pthread_create 封装 | `create_thread()`:965, `pd_start_thread()` |
| 10 | `os.hpp` | `src/hotspot/share/runtime/os.hpp` | 02-runtime:#65 | os 类定义（create_thread/abort/exit 抽象） | `create_thread()` 声明 |
| 11 | `jvm.cpp` | `src/hotspot/share/prims/jvm.cpp` | 09-prims:#12 | ★ JVM_StartThread/JVM_StopThread 等 JVM_* 入口 | `JVM_StartThread()`:2890 |
| 12 | `threadSMR.hpp` | `src/hotspot/share/runtime/threadSMR.hpp` | 02-runtime:#134 | ★ ThreadsListHandle/ThreadsSMRSupport 声明 | `ThreadsListHandle` class |
| 13 | `threadSMR.cpp` | `src/hotspot/share/runtime/threadSMR.cpp` | 02-runtime:#133 | ThreadsSMRSupport 实现（Hazard Pointer） | `_java_thread_list` 管理 |
| 14 | `safepoint.hpp` | `src/hotspot/share/runtime/safepoint.hpp` | 02-runtime:#93 | SafepointSynchronize 类定义 | `_state` 枚举 |
| 15 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | 02-runtime:#92 | ★ SafepointSynchronize::begin()/end() | `begin()`:155, `end()`:499 |

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | 源文件清单（15+ 文件，跨 runtime/gc/os/prims） | 文件索引表 |
| §一 | **完整 Mermaid 继承树**: Thread→NonJavaThread→(NamedThread→VMThread/WorkerThread/ConcurrentGCThread + WatcherThread) + JavaThread→(应用线程/10个系统线程，★含CompilerThread/CodeCacheSweeperThread/ServiceThread)。每个节点标注 `class X : public Y` 定义的文件:行号<br>★★★ **关键纠正**: `CompilerThread`(thread.hpp:2130)和`CodeCacheSweeperThread`(thread.hpp:2109)实际继承自`JavaThread`而非`NonJavaThread`！它们需参与safepoint协议 | ★ 精确继承树 |
| §二 | **NonJavaThread 家族**(7 类):<br>① VMThread — `VMThread::loop()` → STW 操作唯一执行者<br>② WorkerThread — `WorkGang` 管理，GC 并行 Evacuation<br>③ G1MainMarker — `G1ConcurrentMarkThread::run_service()` → CM 并发标记<br>④ G1 Conc#0 — `G1ConcurrentRefineThread::run()` → DirtyCard→RSet<br>⑤ G1 Refine#0 — 同上，多线程 refine<br>⑥ G1 Young RemSet Sampling — 记忆集采样<br>⑦ VM Periodic Task Thread — `WatcherThread::run()` → PeriodicTask 框架<br>★ 关键约束：所有 NonJavaThread **不在 `Threads::_thread_list` 上** — 它们的生命周期由各自子系统管理，不受 `Threads_lock` 保护 | ★ 创建时机/调度循环/WCHAN |
| §三 | **JavaThread 家族**(10 系统线程 + N 应用线程):<br>main / Reference Handler / Finalizer / Signal Dispatcher / Service Thread / C1 Compiler / C2 Compiler / Sweeper / Common-Cleaner / Attach Listener<br>★ 创建时机：startup 4 线程 (`create_vm`中) vs runtime 6 线程 (延迟触发)<br>★ 守护标记：main 是唯一非守护 JavaThread — main 退出 → 最后一个 non-daemon 结束 → JVM 退出<br>★ 关键约束：所有 JavaThread **在 `Threads::_thread_list` 上** — safepoint 遍历此链表收集需暂停的线程 | 创建时机/入口函数/守护标记/WCHAN |
| §四 | **线程创建统一链路**: `os::create_thread()` → `pthread_attr_init` → `pthread_attr_setdetachstate(DETACHED)` → `pthread_attr_setstacksize(-Xss)` → `pthread_create(tid, attr, thread_native_entry, thread)` → `clone(CLONE_VM\|...)` → 内核 LWP<br>★ 4 种 ThreadType: java_thread(1MB)/compiler_thread(4MB)/gc_thread(512KB)/watcher_thread(512KB) | ★ 完整创建调用链 |
| §五 | **17 线程生命周期总表**: 每线程：谁创建 / 创建位置(文件:行号) / 能否终止 / 终止后影响<br>★ JVM 退出策略：最后一个 non-daemon JavaThread 退出 → `destroy_vm` → 通知所有守护线程 <br>★ NonJavaThread 终止：JVM 退出时各子系统显式 `should_terminate()=true` → Worker/Watcher 跳出循环 | ★ 完整生命周期矩阵 |
| §六 | **safepoint 行为三分类 + 隐藏读者讲解**:<br>① JavaThread — 被暂停，轮询 polling page，`_thread_state` 可见<br>② NonJavaThread 有锁 — 自行约定，不在 safepoint 期间获取竞争锁<br>③ NonJavaThread 无锁 — 不受影响，继续并发执行<br>★ **隐藏读者**：VMThread 在 safepoint 期间**无锁读取**所有 JavaThread 的 `_thread_state` — 这就是 [06] 中 `transition_and_fence` 必须 fence 的原因<br>★ 并行数据结构预告：`Threads::_thread_list`(双向链表, Threads_lock 保护) vs `ThreadsSMRSupport::_java_thread_list`(快照, 无锁 Hazard Pointer) | ★ 三类线程 safepoint 对比表 + 双链表结构 |
| §七 | **§3.5 实测对照**: jstack 17 线程逐一对应源码创建位置<br>• 验证 10 JavaThread + 7 NonJavaThread = 17<br>• 验证所有 NonJavaThread WCHAN=`futex_wait_queue`<br>• 验证 main 是唯一 non-daemon JavaThread | ★ 理论 vs 实战对照表 |
| §八 | GDB 验证 + 可证伪断言:<br>• `p Threads::_thread_list` → `p _next→_next...` 遍历链表验 17<br>• `ps -T -o spid,comm,wchan \| wc -l` → 18 (含主进程)<br>• `break os::create_thread` → 统计不同 ThreadType 的调用次数<br>• `p ThreadsSMRSupport::_java_thread_list->_length` → ThreadSMR 快照长度 | ≥8 条 |

> 📎 **前置依赖**: README §3.5（实测线程列表）、§0.4 概念 E（线程全景树）、§0.5⑥（clone 系统调用）
> 📎 **产出位置**: 09/10 的文章入口函数精确定位来自本篇 §二 + §三
> 📎 **关键跨篇概念**: 双链表结构（[06]展开）、VMThread 隐藏读者（[06][07]展开）


---

### P0-04 Synchronized-Full-Path — 全链路串联

> 源文件: `templateTable_x86.cpp`, `synchronizer.cpp`, `objectMonitor.cpp`, `biasedLocking.cpp`, `basicLock.cpp`
> 关键函数: 横跨 5 个文件的完整调用链
> 预估: ~450 行

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `templateTable_x86.cpp` | `src/hotspot/cpu/x86/templateTable_x86.cpp` | 12-os-cpu:#17 | ★ monitorenter/monitorexit 字节码入口 | `monitorenter()`, `monitorexit()` |
| 2 | `templateTable_x86.hpp` | `src/hotspot/cpu/x86/templateTable_x86.hpp` | 12-os-cpu:#18 | 字节码模板声明 | `monitorenter()`/`monitorexit()` 声明 |
| 3 | `synchronizer.cpp` | `src/hotspot/share/runtime/synchronizer.cpp` | 02-runtime:#122 | ★ fast_enter/slow_enter/inflate/deflate 轻量锁+膨胀入口 | `fast_enter()`:265, `slow_enter()`:340, `inflate()`:1403, `deflate_idle_monitors()`:1747 |
| 4 | `synchronizer.hpp` | `src/hotspot/share/runtime/synchronizer.hpp` | 02-runtime:#123 | ObjectSynchronizer 类声明 | `fast_enter()`, `slow_enter()`, `inflate()` 声明 |
| 5 | `objectMonitor.cpp` | `src/hotspot/share/runtime/objectMonitor.cpp` | 02-runtime:#59 | ★ enter/exit/wait/notify 重量锁全部实现 | `enter()`:266, `EnterI()`:454, `exit()`:921, `wait()`:1444, `notify()`:1798 |
| 6 | `objectMonitor.hpp` | `src/hotspot/share/runtime/objectMonitor.hpp` | 02-runtime:#60 | ObjectMonitor 全字段定义 | `_owner`, `_cxq`, `_EntryList`, `_WaitSet`, `_recursions` |
| 7 | `biasedLocking.cpp` | `src/hotspot/share/runtime/biasedLocking.cpp` | 02-runtime:#10 | ★ 偏向锁撤销/重偏向/批量撤销全部实现 | `revoke_and_rebias()`:624, `bulk_revoke_or_rebias_at_safepoint()`:374 |
| 8 | `biasedLocking.hpp` | `src/hotspot/share/runtime/biasedLocking.hpp` | 02-runtime:#11 | BiasedLocking 类定义 + Condition 枚举 | `Condition` 枚举:161, JVM 参数声明 |
| 9 | `basicLock.cpp` | `src/hotspot/share/runtime/basicLock.cpp` | 02-runtime:#8 | BasicLock 方法实现 | `BasicLock::print()` |
| 10 | `basicLock.hpp` | `src/hotspot/share/runtime/basicLock.hpp` | 02-runtime:#9 | BasicLock/BasicObjectLock 类定义 | `BasicLock::_displaced_header`, `BasicObjectLock::_lock+_obj` |
| 11 | `markOop.hpp` | `src/hotspot/share/oops/markOop.hpp` | 01-oops:#50 | ★ markOop 位布局 + 锁状态判断 | `has_monitor()`:273, `is_locked()`, lock bits 枚举 |
| 12 | `markOop.inline.hpp` | `src/hotspot/share/oops/markOop.inline.hpp` | 01-oops:#51 | markOop 内联方法（锁状态快速判断） | `is_biased()`, `has_bias_pattern()` 内联实现 |

> 关键函数(精确行号): `monitorenter()`(templateTable_x86), `fast_enter()`:265, `slow_enter()`:340, `inflate()`:1403, `enter()`:266, `exit()`:921, `revoke_and_rebias()`:624

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | **阅读地图**: 本文是 01-06 的总览串联篇，每个步骤标注参考文献 | 完整阅读导航 |
| §一 | **全链路 Mermaid**: monitorenter 字节码 → TemplateTable::monitorenter() → biased_locking_enter | 全链路时序图，每步标注行号 |
| §二 | **路径 A: 偏向锁获取**: 单次 CAS 线程指针到对象头 → 成功即返回 | 标出 [02-BiasedLocking] 相关章节 |
| §三 | **路径 B: 轻量锁 CAS**: fast_enter → CAS BasicLock* → markOop → 成功=栈锁 | 标出 [03-BasicLock-Synchronizer] |
| §四 | **路径 C: 轻量→重量膨胀**: slow_enter → inflate → ObjectMonitor::enter | 标出 [01-ObjectMonitor] |
| §五 | **路径 D: 直接重量锁**: 已膨胀对象 → ObjectMonitor::enter → CAS _owner / 自旋 / park | 标出 [01-ObjectMonitor §三] |
| §六 | **monitorexit 全链路**: 偏向锁=空操作 → 轻量锁=CAS 恢复 markOop → 重量锁=ObjectMonitor::exit(QMode 唤醒) | exit 侧同步标注 |
| §七 | **GC log 对比**: `-XX:+UseBiasedLocking` vs `-XX:-UseBiasedLocking` 下的锁行为差异 | 实测日志对比 |
| §八 | **性能数据**: 无竞争(20 cycles CAS) → 偏向锁(1次CAS+0后续) → 轻量锁(每次CAS) → 重量锁(>1000 cycles park/unpark) | 四级开销对比表 |
| §九 | **GDB 验证**: 完整断点 + 可证伪断言（≥6 条） | ★ 全链路可验证 |

> 📎 **读的第 1 篇，写的第 5 篇** — 需要前三篇（01/03/02）完成后才能写
> 📎 **交叉引用密度最高**: 每步标注引用文档+章节

**§九 GDB 验证详细步骤**：

```bash
# 准备：编译 slowdebug 版本
JAVA=/data/workspace/openjdk-cut-new/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java
gdb --args $JAVA -Xms8g -Xmx8g -XX:+UseG1GC -XX:+UseBiasedLocking -Xint \
      -cp /data/workspace/demo/src com.wjcoder.Main
```

**断点设置**（覆盖全链路 5 个文件）：
```
# ① monitorenter 字节码入口
(gdb) break TemplateTable::monitorenter

# ② 偏向锁入口（fast_enter 第一个分支）
(gdb) break ObjectSynchronizer::fast_enter

# ③ 轻量锁 CAS 入口（fast_enter 失败后的分支）
(gdb) break ObjectSynchronizer::slow_enter

# ④ 膨胀入口（slow_enter 失败后）
(gdb) break ObjectSynchronizer::inflate

# ⑤ 重量锁 enter 入口
(gdb) break ObjectMonitor::enter

# ⑥ 重量锁 exit 入口
(gdb) break ObjectMonitor::exit

(gdb) run
```

**可证伪断言**（≥6 条）：

| # | 断言 | GDB 验证命令 | 预期值 |
|---|------|-------------|--------|
| 1 | 偏向锁获取：CAS 后 markOop 的 biased_lock=1, lock=01 | `break ObjectSynchronizer::fast_enter` → `n`(步过) → `p/x obj->mark()` | `biased_lock=1, lock=01`, JavaThread* 指针正确 |
| 2 | 轻量锁获取：CAS 后 markOop 的 lock=00, ptr≠0 | `break ObjectSynchronizer::slow_enter` → `n` → `p/x obj->mark()` | `lock=00`, `ptr_to_BasicLock ≠ 0` |
| 3 | 膨胀：inflate 后 markOop 的 lock=10 | `break ObjectSynchronizer::inflate` → `n` → `p/x obj->mark()` | `lock=10`, `ptr_to_ObjectMonitor ≠ 0` |
| 4 | 重量锁 enter 成功：`_owner == Self` | `break ObjectMonitor::enter` → `n` → `p _owner` | `Self`(当前线程指针) |
| 5 | 重量锁 exit 后 `_owner == NULL` | `break ObjectMonitor::exit` → `n` → `p _owner` | `NULL` 或继任者线程 |
| 6 | monitorexit：偏向锁直接返回，轻量锁 CAS 恢复 displaced_header | `break TemplateTable::monitorexit` → `n` → `p/x obj->mark()` | 偏向：不变；轻量：恢复为 unlocked |

★ **关键验证路径**：从 `TemplateTable::monitorenter` 开始单步，跟踪完整的锁获取路径（偏向→轻量→重量），确认每一步 markOop 的位变化符合预期。

---

### P0-06
### P0-06 JVM-Thread-Lifecycle — JavaThread 从生到死 ✅

> ✅ **已完成** — `05-JVM-Thread-Lifecycle.md`，766 行
> 源文件: `thread.cpp/hpp`, `jvm.cpp`(JVM_StartThread), `os_linux.cpp`(create_thread), `threadSMR.cpp`
> 关键产出: `new Thread().start()` → `pthread_create` → `clone()` → TLS → 三套状态系统 → `exit` → `smr_delete` (Hazard Pointers)

> 📎 **前置依赖**: 无（Thread 基类已在 §二 覆盖），但建议先读 [05-Thread-Architecture] 建立全景

---

### P0-07 JVM-VMThread — STW 操作的唯一执行者

> 源文件: `vmThread.cpp/hpp`, `vmOperations.cpp/hpp`, `vm_operations.cpp`, `safepoint.cpp`
> 关键函数: `VMThread::loop()`(vmThread.cpp:465), `VMThread::wait_for_vm_thread_operation()`(vmThread.cpp:350), `VMThread::create()`(vmThread.cpp), `VMOperationQueue::add()`(vmOperations.cpp:56), `VM_Operation::doit()` 虚函数分发
> 预估: ~550 行

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `vmThread.hpp` | `src/hotspot/share/runtime/vmThread.hpp` | 02-runtime:#160 | ★ VMThread 类定义，NonJavaThread 继承关系，_vm_queue/_cur_vm_operation 字段 | `class VMThread`, `_vm_queue`, `_cur_vm_operation`, `_vm_operation_counter` |
| 2 | `vmThread.cpp` | `src/hotspot/share/runtime/vmThread.cpp` | 02-runtime:#159 | ★ loop()/wait_for_vm_thread_operation()/evaluate_operation()/create() 全部实现 | `loop()`:465, `wait_for_vm_thread_operation()`:350, `evaluate_operation()`, `create()` |
| 3 | `vmOperations.hpp` | `src/hotspot/share/runtime/vmOperations.hpp` | 02-runtime:#156 | ★ VM_Operation 基类（doit()纯虚函数 + evaluate_mode/allow_nested_vm_operation）+ VMOperationQueue 类 | `VM_Operation::doit()`, `VM_Operation::evaluate_mode()`, `VMOperationQueue` |
| 4 | `vmOperations.cpp` | `src/hotspot/share/runtime/vmOperations.cpp` | 02-runtime:#155 | VMOperationQueue::add()/remove_next() 队列操作实现 | `add()`:56, `remove_next()` |
| 5 | `safepoint.hpp` | `src/hotspot/share/runtime/safepoint.hpp` | 02-runtime:#93 | ★ SafepointSynchronize 类定义，_state 枚举(_not_synchronized/_synchronizing/_synchronized) | `_state` 枚举, `begin()`, `end()`, `block()` 声明 |
| 6 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | 02-runtime:#92 | ★ begin()/end()/block() 实现，VMThread 不加锁遍历 Threads::_thread_list 的逻辑 | `begin()`:155, `end()`:499, `block()`:816 |
| 7 | `safepointMechanism.hpp` | `src/hotspot/share/runtime/safepointMechanism.hpp` | 02-runtime:#95 | SafepointMechanism 类，polling page 机制 | `class SafepointMechanism`, `local_poll_armed()` |
| 8 | `safepointMechanism.inline.hpp` | `src/hotspot/share/runtime/safepointMechanism.inline.hpp` | 02-runtime:#96 | SafepointMechanism 内联实现（ARM/x86 polling page 检查） | `local_poll_armed()` 内联 |
| 9 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | 02-runtime:#127 | Thread/JavaThread/Threads 类定义，_thread_state 字段(volatile jint) | `Threads::_thread_list`, `JavaThread::_thread_state` |
| 10 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | 02-runtime:#126 | Threads::create_vm() 中 VMThread::create() 调用位置 | `Threads::create_vm()`:3620-4300 |
| 11 | `mutex.hpp` | `src/hotspot/share/runtime/mutex.hpp` | 02-runtime:#56 | Monitor/Mutex 类定义，VMThread 阻塞使用的 Monitor | `class Monitor`, `class Mutex`, `wait()`/`notify()` |
| 12 | `vm_operations_g1.cpp` | `src/hotspot/share/gc/g1/vm_operations_g1.cpp` | 06-gc:#35 | VM_GC_Operation 子类（GC 触发 VM 操作示例） | `VM_G1CollectForAllocation` |

> 关键函数(精确行号): `loop()`:465, `wait_for_vm_thread_operation()`:350, `evaluate_operation()`, `SafepointSynchronize::begin()`:155, `SafepointSynchronize::end()`:499, `VMOperationQueue::add()`:56

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | 源文件清单（vmThread/vmOperations/safepoint，6+ 文件） | 跨模块文件索引 |
| §一 | **为什么需要 VMThread？** — safepoint 期间所有 JavaThread 暂停，必须有一个"不受暂停"的线程执行 GC/偏向撤销等操作。串行执行保证一致性<br>★ **生命周期**：`Threads::create_vm()` 中通过 `VMThread::create()` 创建 → `os::create_thread(type=vm_thread)` → clone → 进入 `loop()` → **永不终止**（JVM 退出时自然结束）<br>★ **关键约束**：VMThread 是 NonJavaThread → **不在 `Threads::_thread_list` 上** → 不受 safepoint 暂停 → 不参与 ThreadSMR 快照 | 设计动机 + 生命周期完整 |
| §二 | **VMThread::loop()** 源码逐行走读：<br>① `_cur_vm_operation == NULL` → `wait_for_vm_thread_operation`（阻塞在 Monitor::wait）<br>② 有新操作 → `_vm_queue->remove_next()` 出队<br>③ `evaluate_operation()`:<br>  a. 需要 safepoint → `SafepointSynchronize::begin()` → 等待所有 JavaThread 到达<br>  b. 执行 `_cur_vm_operation->doit()`<br>  c. 需要 safepoint → `SafepointSynchronize::end()` → 唤醒所有 JavaThread<br>④ `_cur_vm_operation->doit_epilogue()` 收尾<br>⑤ 循环 | ★ 完整 loop 逐行注释，标注文件:行号 |
| §三 | **VM_Operation 体系**:<br>`VM_Operation` 基类 — `doit()` 纯虚函数 → vtable 多态分发<br>十大子类表：`VM_GC_Operation`(GC) / `VM_RevokeBias`(偏向锁撤销) / `VM_ThreadDump`(jstack) / `VM_RedefineClasses` / `VM_FindDeadlocks` / `VM_PrintThreads` / `VM_ForceSafepoint` / `VM_Exit` / `VM_PrintJNI` / `VM_Deoptimize` | ★ 每个子类的触发条件 + doit() 入口文件:行号 |
| §四 | **VMOperationQueue**: `add()`(入队)→`remove_next()`(出队)。单生产多消费还是多生产单消费？→ VMThread 是唯一消费者，但任何线程都可以 add。safepoint 操作有优先级，no-safepoint 操作插队到 safepoint 操作之前 | 队列优先级调度源码 |
| §五 | **safepoint 协议 + VMThread 作为隐藏读者**:<br>① `SafepointSynchronize::begin()` — 设置 `_state = _synchronizing` → ARM polling page → 等待所有 JavaThread 进入 `_thread_blocked`<br>② VMThread 执行 doit()<br>③ `SafepointSynchronize::end()` — 恢复 polling page → 唤醒<br>★ **隐藏读者深度分析**：VMThread 在 `begin()` 中**不加锁遍历** `Threads::_thread_list`，读取每个 JavaThread 的 `_thread_state`(volatile jint) 来判断是否已到达 safepoint。这就是为什么 [06-Thread-Lifecycle] 中 `transition_and_fence` 必须用 `StoreLoad` 屏障 — 没有 fence，VMThread 可能读到 stale `_thread_new`，漏掉未初始化的线程 → 堆损坏 | ★ safepoint 三阶段时序图(Mermaid) + 隐藏读者分析 |
| §六 | GDB 验证 + 可证伪断言:<br>• `break VMThread::loop` → `p _cur_vm_operation` → 当前执行的 VM 操作<br>• `break VMOperationQueue::add` → `bt` 看到谁投递了 VM 操作<br>• `p _vm_queue->_queue` → 等待队列长度<br>• `break SafepointSynchronize::begin` → `p _state` → `_synchronizing` | ≥7 条 |

> 📎 **前置依赖**: [05-Thread-Architecture] 线程全景 + 隐藏读者预告, [06-Thread-Lifecycle] JavaThread safepoint 行为 + fence 原因, [08-safepoint] safepoint 协议详情

---

### P0-08 JVM-WorkerThread — GC 并行主力

> 源文件: `workgroup.cpp/hpp`, `taskqueue.hpp/inline.hpp`, `g1ParScanThreadState.cpp/hpp`, `gangWorker.hpp`, `g1CollectedHeap.cpp`(Worker 创建)
> 关键函数: `WorkGang::run_task()`(workgroup.cpp:280), `AbstractGangWorker::run()`(workgroup.cpp:190), `GenericTaskQueueSet::steal()`(taskqueue.hpp:480), `G1ParScanThreadState::copy_to_survivor()`(g1ParScanThreadState.cpp), `WorkGang::initialize_workers()`(workgroup.cpp)
> 预估: ~500 行

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `workgroup.hpp` | `src/hotspot/share/gc/shared/workgroup.hpp` | 06-gc:#153 | ★ WorkGang/AbstractGangTask/AbstractGangWorker/GangWorker 类定义 + gang 结构 | `class WorkGang`, `class AbstractGangTask`, `class AbstractGangWorker`, `class GangWorker` |
| 2 | `workgroup.cpp` | `src/hotspot/share/gc/shared/workgroup.cpp` | 06-gc:#152 | ★ WorkGang 全部实现：run_task()/initialize_workers()/stop() + GangWorker::run()/loop()/wait_for_task()/signal_task_done()/run_task() | `WorkGang::run_task()`:280, `AbstractGangWorker::run()`:190, `GangWorker::loop()`:378, `GangWorker::wait_for_task()`:360, `WorkGang::initialize_workers()`, `WorkGang::stop()` |
| 3 | `taskqueue.hpp` | `src/hotspot/share/gc/shared/taskqueue.hpp` | 06-gc:#138 | ★ TaskQueue/OverflowTaskQueue/GenericTaskQueueSet 类定义 + steal() 声明 | `class TaskQueue`, `class OverflowTaskQueue`, `class GenericTaskQueueSet`, `steal()` 声明 |
| 4 | `taskqueue.inline.hpp` | `src/hotspot/share/gc/shared/taskqueue.inline.hpp` | 06-gc:#139 | TaskQueue 内联方法，特别是 pop_global()（steal 的底层实现） | `GenericTaskQueueSet::steal()`:480, `TaskQueue::pop_global()` |
| 5 | `taskqueue.cpp` | `src/hotspot/share/gc/shared/taskqueue.cpp` | 06-gc:#137 | TaskQueue 非内联方法实现 | 辅助方法实现 |
| 6 | `g1ParScanThreadState.cpp` | `src/hotspot/share/gc/g1/g1ParScanThreadState.cpp` | 06-gc:#20 | ★ G1 并行扫描线程状态全部实现，含 copy_to_survivor()/do_oop_evac() | `G1ParScanThreadState::copy_to_survivor()`, `do_oop_evac()` |
| 7 | `g1ParScanThreadState.hpp` | `src/hotspot/share/gc/g1/g1ParScanThreadState.hpp` | 06-gc:#21(推测) | G1ParScanThreadState 类定义 + PLAB/TLAB 成员 | `_plab`, `_lab` (TLLAB), 类定义 |
| 8 | `g1CollectedHeap.cpp` | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | 06-gc:#1 | ★ G1 堆实现，Worker 创建入口：initialize() 中 new WorkGang | `G1CollectedHeap::initialize()`:1874, `_workers = new WorkGang(...)` |
| 9 | `g1CollectedHeap.hpp` | `src/hotspot/share/gc/g1/g1CollectedHeap.hpp` | 06-gc:#2 | G1CollectedHeap 类定义，_workers 字段 | `G1CollectedHeap::_workers` 字段 |
| 10 | `workerManager.hpp` | `src/hotspot/share/gc/shared/workerManager.hpp` | 06-gc:#151 | WorkerManager 类定义，动态 Worker 管理 | `class WorkerManager` |

> 关键函数(精确行号): `WorkGang::run_task()`:280, `AbstractGangWorker::run()`:190, `GangWorker::loop()`:378, `GenericTaskQueueSet::steal()`:480, `G1ParScanThreadState::copy_to_survivor()`, `WorkGang::initialize_workers()`, `G1CollectedHeap::initialize()`:1874

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | 源文件清单（workgroup/taskqueue/g1ParScanThreadState/g1CollectedHeap） | 跨模块文件索引 |
| §一 | **WorkGang 架构 + 生命周期**:<br>• 创建时机：`G1CollectedHeap::initialize()` → `_workers = new WorkGang(...)` → `initialize_workers()` → 循环 `new AbstractGangWorker` → `os::create_thread(type=gc_thread)`<br>• Workers 数量 = `ParallelGCThreads`（默认 = CPU 核心数）<br>• 生命周期：JVM 启动时创建 → GC 期间活跃 → GC 结束回 idle → JVM 退出前 `WorkGang::stop()` → `_should_terminate=true` → Workers 退出 `run()` 循环<br>• ★ **关键约束**：Worker 是 NonJavaThread → **不在 `Threads::_thread_list` 上** → 不被 safepoint 暂停 → 不需要 ThreadSMR 保护 | ★ 创建→使用→终止 全生命周期 + gang 结构 ASCII |
| §二 | **AbstractGangWorker::run()** 源码走读：<br>① 主循环 `while (!_should_terminate)`<br>② `_dispatcher->task_done()` → 等新任务（Monitor::wait）<br>③ 有新任务 → `work(i)` 索引 i 的 Worker 执行其 task<br>④ `_gang->run_task(task)` 分派 task 到所有 Worker<br>⑤ 所有 Worker 完成(barrier) → task 结束 → 回到② | ★ dispatch 调度源码逐行注释 |
| §三 | **工作窃取（Work Stealing）**:<br>动机：Worker A 的队列空了但 B 还有任务 → A 空闲浪费<br>算法：`GenericTaskQueueSet::steal(queue_num, seed, t)`:<br>① 从 `queue_num+1` 开始遍历其他 Worker 的队列<br>② `pop_global()` 尝试从目标队列尾部偷一个 task（无锁 CAS）<br>③ 成功 → 执行；所有队列都空 → 返回 false → Worker 进入等待 | steal 算法源码 + 无锁 CAS 效率分析 |
| §四 | **Young GC 中的角色**:<br>• 每个 Worker 获得 `G1ParScanThreadState`<br>• 内部含 PLAB + TLAB 用于对象分配<br>• `copy_to_survivor()`: 从 CSet Region 复制活对象到 Survivor/Old<br>• 完成后各 Worker 的 PLAB 被 flush 到新生代 Region | 与 [06-gc-memory] G1 Young GC 交叉引用 |
| §五 | **Worker 数量 + 生命周期约束**:<br>• `ParallelGCThreads` 默认 = `ncpus ≤ 8 ? ncpus : 8 + (ncpus-8)*5/8`<br>• 能否动态增减？→ 否，Worker 创建后数量不变<br>• 能否在 safepoint 期间新增 Worker？→ 不会发生 | 参数影响 + 约束分析 |
| §六 | GDB 验证 + 可证伪断言:<br>• `break AbstractGangWorker::run` → `p this` → Worker 的 Thread 对象<br>• `break GenericTaskQueueSet::steal` → `p seed` → 随机种子值<br>• `p G1CollectedHeap::_workers->_created_workers` → Worker 总数<br>• `p _should_terminate` → JVM 退出前被设为 true | ≥6 条 |

> 📎 **前置依赖**: [05-Thread-Architecture], [06-gc-memory] G1 Young GC 并行 Evacuation

---

### P0-09 JVM-JavaThread-System — 10 个系统 JavaThread 详解

> 源文件: `thread.cpp`(create_vm/Threads.cpp), `referenceProcessor.cpp`, `signalDispatcher`, `serviceThread.cpp`, `attachListener.cpp`, `javaClasses.hpp`(java_lang_Thread)
> 关键函数: `Threads::create_vm()`(thread.cpp:3620-4300), `java_lang_Thread::threadStatus()`, `JVM_StartThread()`(jvm.cpp:2890), 各线程的 Java 入口函数
> 预估: ~500 行

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | 02-runtime:#126 | ★ Threads::create_vm() JVM启动入口 + JavaThread 生命周期 + _thread_list 管理 | `Threads::create_vm()`:3595, `JavaThread::initialize()`, `Threads::add()`, `Threads::remove()`, 所有线程创建入口 |
| 2 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | 02-runtime:#127 | ★ Thread/JavaThread/Threads 类定义 + 线程状态枚举 | `class JavaThread`:925, `class Thread`:115, `class Threads`:2203, `JavaThreadState` 枚举, `_thread_list` 字段 |
| 3 | `jvm.cpp` | `src/hotspot/share/prims/jvm.cpp` | 09-prims:#12 | ★ JVM_StartThread/JVM_IsInterrupted/JVM_Sleep 等 JVM_* 入口 | `JVM_StartThread()`:2646, `JVM_IsInterrupted()`:2710 |
| 4 | `javaClasses.cpp` | `src/hotspot/share/runtime/javaClasses.cpp` | 02-runtime:#41 | ★ java_lang_Thread 类映射 + threadStatus 设置/读取 | `java_lang_Thread::set_threadStatus()`, `java_lang_Thread::get_threadStatus()` |
| 5 | `javaClasses.hpp` | `src/hotspot/share/runtime/javaClasses.hpp` | 02-runtime:#42 | ★ java_lang_Thread 偏移量定义 + ThreadStatus 枚举 | `java_lang_Thread` 类所有偏移量, `JavaThreadStatus` 枚举 |
| 6 | `compileBroker.cpp` | `src/hotspot/share/compiler/compileBroker.cpp` | 07-compiler:#7 | ★ CompilerThread 循环入口 | `CompileBroker::compiler_thread_loop()`:2180 |
| 7 | `serviceThread.cpp` | `src/hotspot/share/runtime/serviceThread.cpp` | 02-runtime:#101 | ★ ServiceThread 入口 + 低内存检测/JNI 周期检查 | `ServiceThread::service_thread_entry()`:45 |
| 8 | `attachListener.cpp` | `src/hotspot/share/services/attachListener.cpp` | 10-services:#2 | ★ Attach 机制入口（jcmd/jstack/jmap） | `AttachListener::attach_listener_thread_entry()`:464 |
| 9 | `referenceProcessor.cpp` | `src/hotspot/share/gc/shared/referenceProcessor.cpp` | 06-gc:#118 | ★ ReferenceHandler 线程的引用处理逻辑 | `ReferenceProcessor::process_discovered_references()` |
| 10 | `referenceProcessor.hpp` | `src/hotspot/share/gc/shared/referenceProcessor.hpp` | 06-gc:#119 | ReferenceProcessor 类定义 | `class ReferenceProcessor` |
| 11 | `bytecodeInterpreter.cpp` | `src/hotspot/share/interpreter/bytecodeInterpreter.cpp` | 05-interpreter:#8 | ★ monitorenter/monitorexit 字节码解释 | `CASE(_monitorenter)`:749, `CASE(_monitorexit)`:774 |
| 12 | `signalDispatcher.hpp` | `src/hotspot/share/runtime/signalDispatcher.hpp` | 02-runtime:#105 | SignalDispatcher 线程定义 | `class SignalDispatcher` |

> 关键函数(精确行号): `Threads::create_vm()`:3595(thread.cpp), `JVM_StartThread()`:2646(jvm.cpp), `ServiceThread::service_thread_entry()`:45(serviceThread.cpp), `AttachListener::attach_listener_thread_entry()`:464(attachListener.cpp), `CompileBroker::compiler_thread_loop()`:2180(compileBroker.cpp), `monitorenter`:749(bytecodeInterpreter.cpp), `monitorexit`:774(bytecodeInterpreter.cpp)

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | **10 线程总表**（创建时机/文件:行号/守护标记/WCHAN/入口函数/能否终止） | ★ 精确定位总表 |
| §一 | **startup 4 线程** — `Threads::create_vm()` 中顺序创建:<br>① `main` — 第一个 JavaThread，执行 `main()` 入口<br>② `Reference Handler` — `JVM_StartThread` → Java 入口 `java.lang.ref.Reference$ReferenceHandler.run()` → `ReferenceQueue` 循环处理<br>③ `Finalizer` — `JVM_StartThread` → `java.lang.ref.Finalizer$FinalizerThread.run()` → 调用 `Object.finalize()`<br>④ `Signal Dispatcher` — `JVM_StartThread` → 内部 Java 类 → `wait()` 在信号上<br>★ **创建顺序约束**：Finalizer 依赖 Reference Handler 已完成 Reference 入队 → 顺序不能乱<br>★ **生命周期**：这 4 个线程 + main = 守护线程(除 main) → 随 JVM 退出而终止 → 走标准 `JavaThread::exit` → `smr_delete` | 创建顺序 + 文件:行号精确定位 + 生命周期 |
| §二 | **runtime 6 线程** — 延迟创建，触发条件各异:<br>⑤ `Service Thread` — `create_vm` 尾部创建，周期检查低内存/JNI local ref 上限<br>⑥⑦ `C1/C2 CompilerThread` — 第一次 JIT 编译时由 `CompileBroker::init_compiler_threads()` 创建<br>⑧ `Sweeper thread` — `CodeCacheSweeperThread::start()` 创建，清理 zombie nmethod<br>⑨ `Common-Cleaner` — JDK 内部，`Cleaner` 机制驱动<br>⑩ `Attach Listener` — 首次 `jcmd`/`jstack` 连接时按需创建<br>★ **生命周期**：运行时线程可被显式终止（如 `-XX:-UseCompiler` 则 Compiler 不创建，AttachListener 可超时退出） | 每条线程的延迟创建触发器 + 终止条件 |
| §三 | **每线程职责详解 + 鲁棒性分析**:<br>• main — 唯一 non-daemon，退出 → JVM exit<br>• RefHandler — ❓ 如果死掉？→ Reference 永远不入队 → Soft/Weak/PhantomReference 泄漏 → OOM<br>• Finalizer — ❓ 如果死掉？→ `finalize()` 永远不执行 → 但 `Cleaner` 机制已逐步替代<br>• SignalDispatcher — ❓ 如果死掉？→ SIGINT/SIGTERM 无响应 → `kill -9` 才能终止<br>• ServiceThread — OOP 异常 → 退出后 `ServiceThread::start()` 重新创建<br>• C1/C2 — `CompileBroker::compiler_thread_loop()` → 可取 `CompileTask` → JIT → 线程池模型<br>• Sweeper — 周期遍历 nmethod → 清理 zombie/not_entrant<br>• Cleaner — `ReferenceQueue` 驱动<br>• AttachListener — UNIX socket accept → jcmd/jstack 命令分发 | ★ 逐个标注 Java 入口 + 调度循环 + 死亡后果 |
| §四 | **与 §3.5 实测对照**: 10 线程 ≡ jstack 输出逐一对应源码创建位置<br>验证方法：GDB `break Threads::create_vm` 后单步，每 `new JavaThread` 出现一次，记录其入口函数 | 理论 vs 实战完整对照表 |
| §五 | GDB 验证 + 可证伪断言:<br>• `break JVM_StartThread` → `p thread_entry` → 每个线程传入的 Java 入口<br>• `break Threads::create_vm` → 统计 startup 线程数 = 4 + main<br>• `p java_lang_Thread::threadStatus(t)` → 每个线程的 Java 层状态<br>• `p java_lang_Thread::is_daemon(t)` → main=false, 其余=true | ≥6 条 |

> 📎 **前置依赖**: [05-Thread-Architecture] 全景 + 所有线程在 `_thread_list` 上, [06-Thread-Lifecycle] JavaThread 创建+退出链路, §3.5 实测线程列表

---

### P0-10 JVM-NonJavaThread — 5 个 NonJavaThread 详解 + Compiler/Sweeper 分类澄清

> 源文件: `concurrentGCThread.cpp/hpp`, `g1ConcurrentMarkThread.cpp`, `g1ConcurrentRefineThread.cpp`, `watcherThread.cpp/hpp`, `g1CollectedHeap.cpp`; 参考: `compilerThread.cpp`(JavaThread分支), `codeCacheSweeperThread.cpp`(JavaThread分支)
> 关键函数(NonJavaThread): `ConcurrentGCThread::run()`(concurrentGCThread.cpp), `G1ConcurrentMarkThread::run_service()`(g1ConcurrentMarkThread.cpp:356), `WatcherThread::run()`(watcherThread.cpp:125), `G1ConcurrentRefineThread::run()`(g1ConcurrentRefineThread.cpp), 各线程的创建函数; 参考(JavaThread): `CompileBroker::compiler_thread_loop()`, `CodeCacheSweeperThread::run()`:101
> 预估: ~500 行

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `concurrentGCThread.hpp` | `src/hotspot/share/gc/shared/concurrentGCThread.hpp` | 06-gc:#42 | ★ ConcurrentGCThread 基类定义 + _should_terminate + run()/stop() | `class ConcurrentGCThread`, `run()`, `stop()`, `_should_terminate` |
| 2 | `concurrentGCThread.cpp` | `src/hotspot/share/gc/shared/concurrentGCThread.cpp` | 06-gc:#43 | ★ ConcurrentGCThread::run()/stop() 实现 | `ConcurrentGCThread::run()`, `ConcurrentGCThread::stop()` |
| 3 | `g1ConcurrentMarkThread.cpp` | `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.cpp` | 06-gc:#7 | ★ G1 并发标记线程 — run_service() CM 五大阶段循环 | `G1ConcurrentMarkThread::run_service()`:356, 创建: `G1CollectedHeap::initialize()`:1874 |
| 4 | `g1ConcurrentRefineThread.cpp` | `src/hotspot/share/gc/g1/g1ConcurrentRefineThread.cpp` | 06-gc:#23 | ★ G1 并发细化线程 — DirtyCardQueue 消费者 | `G1ConcurrentRefineThread::run()`, 创建: `G1CollectedHeap::initialize()` |
| 5 | `watcherThread.hpp` | `src/hotspot/share/runtime/watcherThread.hpp` | 02-runtime:#875 | ★ WatcherThread 类定义 + PeriodicTask 框架 | `class WatcherThread`, `_should_terminate`, `start()`, `stop()` |
| 6 | `watcherThread.cpp` | `src/hotspot/share/runtime/watcherThread.cpp` | 02-runtime:#876 | ★ WatcherThread::run()/start()/stop() 实现 + PeriodicTask 调度 | `WatcherThread::run()`:125, `WatcherThread::start()`:75, `WatcherThread::stop()` |
| 7 | `compilerThread.cpp` | `src/hotspot/share/compiler/compilerThread.cpp` | 07-compiler:#9 | CompilerThread 实现（C1/C2编译线程，属JavaThread分支） | `CompilerThread::run()` → `CompileBroker::compiler_thread_loop()` |
| 8 | `codeCacheSweeperThread.cpp` | `src/hotspot/share/runtime/codeCacheSweeperThread.cpp` | 02-runtime:#2109 | CodeCacheSweeperThread 实现（扫nmethod，属JavaThread分支） | `CodeCacheSweeperThread::run()`:101 |
| 9 | `g1CollectedHeap.cpp` | `src/hotspot/share/gc/g1/g1CollectedHeap.cpp` | 06-gc:#1 | ★ G1 堆初始化 — 所有 NonJavaThread 的创建入口 | `G1CollectedHeap::initialize()`:1874, Worker 创建 |
| 10 | `g1CollectedHeap.hpp` | `src/hotspot/share/gc/g1/g1CollectedHeap.hpp` | 06-gc:#2 | G1CollectedHeap 类定义，_workers 字段 | `G1CollectedHeap::_workers` |

> 关键函数(精确行号): `ConcurrentGCThread::run()`(concurrentGCThread.cpp), `G1ConcurrentMarkThread::run_service()`:356(g1ConcurrentMarkThread.cpp), `WatcherThread::run()`:125(watcherThread.cpp), `CodeCacheSweeperThread::run()`:101(codeCacheSweeperThread.cpp), `G1ConcurrentRefineThread::run()`(g1ConcurrentRefineThread.cpp), `G1CollectedHeap::initialize()`:1874

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | **5 NonJavaThread + Compiler/Sweeper 分类总表**（创建时机/文件:行号/WCHAN/调度循环/能否终止/★继承分支） | ★ 调度入口精确定位 + 生命周期 + ★ 明确标注 CompilerThread/Sweeper 属 JavaThread |
| §一 | **VMThread 回顾** — `loop()` 等待 VM_Operation → 永不终止 → 连接 [07-VMThread] | 交叉引用 |
| §二 | **G1 ConcurrentGCThread ×3 — 生命周期完整**:<br>• `G1MainMarker` — 创建：`G1CollectedHeap::initialize()`(g1CollectedHeap.cpp:1874) → `new G1ConcurrentMarkThread()` → `os::create_thread(type=cgc_thread)` → `run_service()` 进入 CM 五大阶段循环<br>• `G1 Conc#0` — 创建：同上 → `new G1ConcurrentRefineThread()` → `run()` DirtyCardQueue 消费者<br>• `G1 Refine#0` — 同上，多线程并发 refine<br>• 终止：JVM 退出前 `ConcurrentGCThread::stop()` → `_should_terminate=true` → 跳出 `run()` 循环<br>• ★ **不在 `_thread_list` 上** — 不被 safepoint 暂停，但受 `CMBitMap` 并发访问约束 | ★ 每个线程的创建位置精确行号 + `run()` 入口 + 终止路径 |
| §三 | **WatcherThread — 生命周期 + PeriodicTask**:<br>• 创建：`WatcherThread::start()`(watcherThread.cpp:75) → `os::create_thread(type=watcher_thread)`<br>• `WatcherThread::run()`:<br>① 计算下次唤醒时间 = `min(next_periodic_task_time, next_delayed_task_time)`<br>② `sleep(delay)` → OS 唤醒<br>③ `PeriodicTask::real_time_tick()` → 遍历所有注册的 PeriodicTask<br>④ 典型任务：偏向锁延迟启用(4s)、JFR 采样、低内存检测<br>• 终止：JVM 退出前 `WatcherThread::stop()` → `notify()` → `run()` 检查 `_should_terminate` → 退出 | ★ PeriodicTask 框架 + 已注册 task 列表 + 创建位置 |
| §四 | **Compiler/Sweeper 分类澄清**:<br>• C1/C2 CompilerThread 实际在 **JavaThread** 分支（被 safepoint 暂停！）→ 走 `CompileBroker::compiler_thread_loop()`<br>• Sweeper 也在 JavaThread 分支 → `CodeCacheSweeperThread::run()` → 扫 nmethod<br>★ 为什么要归为 JavaThread？→ 编译器需要访问 Java 堆（类元数据/方法数据），必须被 safepoint 暂停以保证 GC 安全 | 关键认知修正 |
| §五 | **WCHAN 统一 + 关键约束**:<br>• 5 NonJavaThread 全部 `futex_wait_queue` — 不操作 Java 堆 oop，不持有 Java 锁，不被 safepoint 暂停<br>• ★ 5 NonJavaThread 不在 `Threads::_thread_list` 上 → 不受 ThreadSMR 保护 → 由各自子系统管理生命周期<br>• ★ CompilerThread/Sweeper 属 JavaThread → **在 `_thread_list` 上** → 被 safepoint 暂停 → 受 ThreadSMR 保护<br>• §3.5 实测验证：ps -T 确认 NonJavaThread 为 `futex_wait_queue` | §3.5 实测对照 |
| §六 | GDB 验证 + 可证伪断言:<br>• `break WatcherThread::run` → `p _next_period` → 下次唤醒时间<br>• `break G1ConcurrentMarkThread::run_service` → `bt` 看到 CM 标记循环<br>• `ps -T -o spid,comm,wchan` → 5 NonJavaThread 全部 `futex_wait_queue`<br>• `break G1CollectedHeap::G1CollectedHeap` → 步进到 ConcurrentGCThread 创建<br>• ★ `ptype CompilerThread` → 验证继承链包含 JavaThread（非 NonJavaThread）<br>• ★ `ptype CodeCacheSweeperThread` → 验证继承链包含 JavaThread | ≥6 条 |

> 📎 **前置依赖**: [05-Thread-Architecture] NonJavaThread 不在 `_thread_list`, [07-VMThread], [04-ConcurrentMark], [03-YoungGC], §3.5 实测

---

### P1-11 JVM-Internal-Locks — 80+ 全局 Mutex/Monitor（线程模块收尾）

> 源文件: `mutex.cpp/hpp`, `mutexLocker.cpp/hpp`, `os_posix.cpp`(PlatformMutex/PlatformMonitor)
> 关键函数: `Mutex::lock()`(mutex.cpp:86), `Mutex::lock_without_safepoint_check()`(mutex.cpp:92), `Mutex::try_lock()`, `mutex_init()`(mutexLocker.cpp:245+), `assert_rank()`(mutexLocker.cpp:194)
> 预估: ~500 行

#### 必读文件清单

| # | 文件 | 完整路径 | source_index | 必读原因 | 重点读 |
|---|------|---------|-------------|---------|--------|
| 1 | `mutex.hpp` | `src/hotspot/share/runtime/mutex.hpp` | 02-runtime:#55 | ★ Mutex/Monitor 类定义 + rank 枚举 | `class Monitor`(extends Mutex), `class Mutex`, `MutexRank` 枚举, `_owner`, `_rank`, `_lock` |
| 2 | `mutex.cpp` | `src/hotspot/share/runtime/mutex.cpp` | 02-runtime:#56 | ★ Mutex::lock() 三阶段 + Monitor::wait()/notify()/notify_all() | `Mutex::lock()`:86, `Mutex::lock_without_safepoint_check()`:92, `Monitor::wait()`, `Monitor::notify()`, `Monitor::notify_all()` |
| 3 | `mutexLocker.hpp` | `src/hotspot/share/runtime/mutexLocker.hpp` | 02-runtime:#57 | ★ 全局 Mutex/Monitor 实例声明 + MutexLocker/MonitorLockerEx RAII | 所有 `extern Monitor *XXX_lock;` 声明, `class MutexLocker`, `class MonitorLockerEx` |
| 4 | `mutexLocker.cpp` | `src/hotspot/share/runtime/mutexLocker.cpp` | 02-runtime:#58 | ★ 80+ 全局锁定义 + mutex_init() 初始化 + assert_rank() | `mutex_init()`:245+, `assert_rank()`:194, 所有 `Monitor* XXX_lock = NULL;` |
| 5 | `os_posix.cpp` | `src/hotspot/os/posix/os_posix.cpp` | 12-os-cpu:#38 | PlatformMutex/PlatformMonitor 底层实现(pthread_mutex/pthread_cond) | `class PlatformMutex`, `class PlatformMonitor` |
| 6 | `os_posix.hpp` | `src/hotspot/os/posix/os_posix.hpp` | 12-os-cpu:#39 | PlatformMutex/PlatformMonitor 类定义 | `class PlatformMutex`(pthread_mutex_t), `class PlatformMonitor`(pthread_cond_t) |

> 关键函数(精确行号): `Mutex::lock()`:86(mutex.cpp), `Mutex::lock_without_safepoint_check()`:92(mutex.cpp), `mutex_init()`:245+(mutexLocker.cpp), `assert_rank()`:194(mutexLocker.cpp), `Monitor::wait()`, `Monitor::notify()`

| 章节 | 内容 | 关键产出 |
|:---:|------|------|
| §〇 | 源文件清单（mutex/mutexLocker/os_posix，6 文件） | 跨模块文件索引 |
| §一 | **Mutex vs Monitor 区别 + 生命周期**:<br>• Mutex — 不可重入/纯互斥/CAS 快速路径/`lock()`+`unlock()`+`try_lock()`<br>• Monitor — 继承 Mutex + 可重入(`_count`)+ 条件变量(`wait`/`notify`/`notify_all`)<br>• ★ JVM 大部分"全局 Mutex"实际是 Monitor（需要 wait/notify）<br>• ★ **锁的生命周期**：80+ 锁在 `mutex_init()` 中通过 `new PaddedMonitor(rank)` **C-Heap(mtInternal)分配** → JVM 启动后**永不释放**（全局锁随进程消亡回收）<br>• ★ **谁读取锁状态？** → `_owner` 字段被 debug check 无锁读取（`assert(!owned_by_self())`）、safepoint 检查读取、hs_err 日志读取 — 但这不是并发安全问题，因为读取者只看不写 | 对比表 + 生命周期 |
| §二 | **Mutex::lock() 三层降级**:<br>① Phase 1: `Atomic::cmpxchg SplitWord` — 纯用户态 CAS（~20 CPU cycles）<br>② Phase 2: 自适应自旋 — TryLock 循环 + `os::naked_short_nop`（~200ns）<br>③ Phase 3: `PlatformMutex::lock()` → `pthread_mutex_lock` → `futex(FUTEX_WAIT)`（~10μs）<br>★ `lock_without_safepoint_check` vs `lock_with_safepoint_check` 区别 | ★ 源码逐行注释 + 性能数量级 |
| §三 | **80+ 全局锁完整层级**:<br>`tty_lock(rank=0)` → `ParGCRareEvent_lock(1)` → ... → `Heap_lock(8)` → ... → `Threads_lock` → ... → `CodeCache_lock` → `MethodCompileQueue_lock` → `Compile_lock(MAX)`<br>★ `mutex_init()` 源码走读 — 80+ 锁的创建 + rank 赋值 + 用途注释<br>★ 标注每个锁的**持有者类型**(JavaThread/VMThread/任意) + **持有期间是否允许 safepoint** | ★ 完整 rank 表（≥25 锁，标注 rank/用途/持有者/safepoint 行为） |
| §四 | **Lock Ranking 死锁预防**:<br>`assert_rank()`: `assert(!thread->owns_lock(low_rank) \|\| _rank > owned_lock->_rank)` — 违反 rank 递增 → assert fail<br>★ 宁可 crash（hs_err 可排查）也不死锁（hang 无法排查）<br>• `_no_safepoint_check_flag`: 持有期间禁止到达 safepoint（如 `Threads_lock` — safepoint 协议需要遍历线程列表，持有者不能在此刻暂停）<br>• Special 锁: `SR_lock` — 不参与 ranking，suspend/resume 专用协议 | 死锁案例分析 |
| §五 | **MutexLocker/MonitorLockerEx RAII**:<br>构造时 `lock(_mutex)` → 析构时 `_mutex->unlock()` → 异常安全<br>`MonitorLockerEx` 扩展: `wait(millis)`/`notify()`/`notify_all()` | RAII 模板使用范例 |
| §六 | **PaddedMutex/PaddedMonitor**: cache line padding(64B) 防 false sharing<br>DEFINE_PAD 宏 → 确保 `_lock`(SplitWord) 独占一个缓存行 | sizeof 验证(≥128) |
| §七 | GDB 验证 + 可证伪断言:<br>• `p Threads_lock->_rank` → rank 值<br>• `p sizeof(PaddedMutex)` → ≥ 128 (两个 64B 缓存行)<br>• `break Mutex::lock` → `bt` 看到三阶段调用<br>• `break mutex_init` → `p lock->_rank` 验证 rank 递增 | ≥7 条 |

> 📎 **前置依赖**: [05-Thread-Architecture] 所有线程都使用这些锁, [06-Thread-Lifecycle] Threads_lock 在 JVM_StartThread 中的角色, [07-VMThread] VMThread 持有 Heap_lock 期间执行 GC

---

### 写作顺序与阅读顺序

```
写作顺序（按依赖链）:
  01-ObjectMonitor ────┬──→ 04-Full-Path (需 01+03+02)
  03-BasicLock         ─┤
  02-BiasedLocking     ─┘
  05-Thread-Architecture ──→ 06-Thread-Lifecycle (依赖 05)
                          ├─→ 07-VMThread           (依赖 05+06)
                          ├─→ 08-WorkerThread       (依赖 05, 需 GC 知识)
                          ├─→ 09-JavaThread-System  (依赖 05+06)
                          └─→ 10-NonJavaThread      (依赖 05+07)
  11-Internal-Locks    (独立，最后写)

阅读顺序（按理解梯度）:
  04-Full-Path → 01-ObjectMonitor → 05-Thread-Architecture → 03-BasicLock → 02-BiasedLocking
    → 06-Thread-Lifecycle → 07-VMThread → 08-WorkerThread → 09-JavaThread-System → 10-NonJavaThread → 11-Internal-Locks

产出优先级:
  P0-01 ObjectMonitor         ← ★ 最重要 (~600行)
  P0-03 BasicLock+Hash        ← 连接桥梁 (~550行)
  P0-02 BiasedLocking         ← 最精巧 (~550行)
  P0-05 Thread-Architecture   ← ★ 线程全景, 依赖 §3.5 实测 (~500行)
  P0-04 Full Path             ← 全局串联 (~450行)
  P0-06 Thread-Lifecycle      ← ✅ 已完成 (~766行)
  P0-07 VMThread              ← STW 执行者 (~500行)
  P0-08 WorkerThread          ← GC 并行调度 (~450行)
  P0-09 JavaThread-System     ← 10 系统线程详解 (~400行)
  P0-10 NonJavaThread         ← 7 内部线程详解 (~400行)
  P1-11 Internal-Locks        ← 线程模块收尾 (~400行)
```

### 每篇文章的 GDB 验证模板

```
01-ObjectMonitor:      p sizeof(ObjectMonitor), ptype/o ObjectMonitor, break enter→p *this
03-BasicLock:          p sizeof(BasicLock), break fast_enter→p/x obj->mark()
02-BiasedLocking:      break revoke_and_rebias, break bulk_revoke_or_rebias_at_safepoint
05-Thread-Architecture:p Threads::_thread_list, p _next→_next... 遍历 17 个线程
04-Full-Path:          break TemplateTable::monitorenter, break inflate, break enter
06-Thread-Lifecycle:   break JVM_StartThread, break JavaThread::exit
07-VMThread:           break VMThread::loop, break VMOperationQueue::add
08-WorkerThread:       break WorkGang::run_task, break AbstractGangWorker::run
09-JavaThread-System:  break Threads::create_vm, p java_lang_Thread::threadStatus(t)
10-NonJavaThread:      break WatcherThread::run, break ConcurrentGCThread::run
11-Internal-Locks:     p Mutex::_rank, break Mutex::lock→p _owner

---

## 附录：与 06-gc-memory 的衔接

```
06-gc-memory ← 分配满了怎么办? GC 怎么回收?
    ↓
07-thread-lock ← synchronized 怎么实现? 锁怎么竞争?
    ↓
08-safepoint ← GC 怎么让所有线程停下来?（偏向锁撤销也需要 safepoint）
```

**关键交叉点**：
- 偏向锁撤销需要 `VM_RevokeBias` → VMThread → safepoint（[06 §1.4] Young GC 触发也走同一路径）
- `ObjectMonitor::wait()` 释放锁后线程 park——GC 到达 safepoint 时需要知道该线程不在临界区
- ThreadSMR 在 GC 的 `Threads::threads_do()` 遍历线程列表时保证安全
