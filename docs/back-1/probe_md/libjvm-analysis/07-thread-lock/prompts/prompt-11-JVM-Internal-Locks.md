# PROMPT: 请撰写 11-JVM-Internal-Locks.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**"80+ 把锁为什么不死锁" — JVM 内部 Mutex/Monitor 二层模型 + Lock Ranking 死锁预防体系**

### 核心故事线（禁止做源码翻译机！）

前七篇文章 [04] 锁膨胀全链路 → [05][06] 线程生命周期/架构 → [07] VMThread → [08] WorkerThread → [09] 10 个 JavaThread → [10] 4 条 NonJavaThread。线程体系的 21+ 条线程全部讲完了。

现在还剩最后一个体系级问题：**这 21 条线程之间用 80+ 把内部锁协调，为什么不会死锁？**

你在前六篇 [07][08][09][10] 中已经引用了很多锁：
- `PeriodicTask_lock`（WatcherThread 的 10ms Tick）— `_no_safepoint_check_flag`
- `CGC_lock`（G1ConcurrentMarkThread vs VMThread）— `_no_safepoint_check_flag`
- `Terminator_lock`（WatcherThread::stop() 等待线程退出）— `_as_suspend_equivalent_flag`
- `Threads_lock`（ThreadsSMR 保护 JavaThread 创建/销毁）— `_safepoint_check_sometimes`
- `Safepoint_lock`（整个 safepoint 协议的核心）— rank=`safepoint`
- `NonJavaThreadsList_lock`（NonJavaThread::_the_list 的并发保护）
- `STS_lock`（SuspendibleThreadSet — 精炼线程的 yield）

**本文的核心叙事线**是一条从"观察现象"到"理解设计"的追溯链：

1. **Mutex vs Monitor 为什么有两层？**— [04] 讲的是 `synchronized` 的 ObjectMonitor（Java 层），这里讲 JVM 内部用的 Monitor。它们不是同一个东西！Mutex 只能 lock/unlock，Monitor 额外有 wait/notify/notify_all。但历史曾经反过来——Monitor 继承 Mutex，J2SE7 后反转为 Mutex 继承 Monitor。为什么？
2. **Lock Ranking 是什么？**— 80+ 把锁，每把都有一个 rank 值（event=0 → native=922）。规则：线程获取锁必须按 rank **严格递增**排序。违反 → `fatal("possible deadlock")`。这是一个**编译期（rank enum）+ 运行时（assert）**的双重死锁预防。
3. **`set_owner_implementation()` 中的 fatal 断言**— 这是全文最关键的代码。`mutex.cpp:1301-1326`：获取锁后，找到线程当前持有的最低 rank 锁，如果它的 rank ≤ 新锁的 rank → fatal。**这是 JVM 内部 80+ 锁不死锁的根本原因。**
4. **为什么有 `native` rank？**— rank=922 的锁不受死锁检测约束。为什么？因为它们是由 `JVM_RawMonitorCreate` 创建的（JNI 外部使用），不参与 JVM 内部的锁排序。
5. **safepoint_check 三态是什么？**— `_safepoint_check_never` / `_safepoint_check_sometimes` / `_safepoint_check_always`。`PeriodicTask_lock` 为什么是 `_no_safepoint_check_flag`？因为 WatcherThread 不是 JavaThread，持有 PeriodicTask_lock 期间不允许 safepoint 检查。
6. **RAII 封装链**— `MutexLocker`（基础）→ `MutexLockerEx`（支持 NULL + no_safepoint_check）→ `MonitorLockerEx`（在 MutexLockerEx 上加 wait/notify）。为什么需要三层？因为不同的调用场景有不同的约束。
7. **★ 线程系统锁的依赖链**— 从 [07][08][09][10] 中出现的锁出发，追溯它们的 rank 关系，回答"为什么 VMThread 获取 VMOperationQueue_lock 后再获取 PeriodicTask_lock 不会死锁？"

### 禁止行为

- ❌ 把 80+ 把锁列成表格 — 这是字典，不是分析
- ❌ 罗列 rank enum 不解释为什么这样排序
- ❌ 忽略 Mutex vs Monitor 的历史反转原因
- ❌ 忽略 `set_owner_implementation()` 中的 fatal 断言 — 这是全文核心
- ❌ 不画"线程持有锁"的关系图 — 用具体线程（VMThread/WatcherThread/G1 线程）演示锁获取顺序

### 要求行为

- ✅ **★ 核心致命断言深度走读**：`set_owner_implementation()` 的第 1301-1326 行是全文最重要的代码——逐行解释为什么 `locks->rank() <= this->rank()` 会触发 fatal，以及为什么 `native` 和 `suspend_resume` 被豁免
- ✅ **★ 历史反转**：Mutex 继承 Monitor（J2SE7 后）vs Monitor 继承 Mutex（J2SE7 前）— 为什么反转？设计意图是什么？
- ✅ **★ Thread::_owned_locks 链表**：每把锁获取时插入线程的 `_owned_locks` 链表头，释放时遍历链表移除。这不是 LinkedList 类 — 就是 Monitor 自身的 `_next` 字段串起来的单链表
- ✅ **★ safepoint_check 三态的精确语义**：`_safepoint_check_never` = 永远不在 safepoint 中持有（STS_lock/PeriodicTask_lock）；`_safepoint_check_sometimes` = safepoint 时可以持有但需要特殊处理（Safepoint_lock/Terminator_lock）；`_safepoint_check_always` = 必须在 safepoint 外持有（常规 mutex）
- ✅ **★ 线程系统锁的关系图**：画一张线程→锁→rank 的映射表，展示 VMThread/WatcherThread/G1ConcurrentMarkThread/G1ConcurrentRefineThread 各自持有的锁和它们的 rank
- ✅ **★ `lock_without_safepoint_check()` 的调用者分析** — 哪些场景需要用这个绕过 safepoint 检查？WatcherThread::sleep() / NonJavaThread 构造 / GC 并发线程
- ✅ GDB 验证 `_owned_locks` 链表 + `rank()` 验证 + 锁名称
- ✅ 交叉引用 [07][08][09][10] 中出现的所有锁

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 默认 mixed mode（Tiered Compilation 开启）
- 64 位 Linux x86
- ★ Lock Ranking 只在 `#ifdef ASSERT` 下启用 — slowdebug 生效，release 不检查

## 三、聚焦源文件

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `mutex.hpp` | `src/hotspot/share/runtime/mutex.hpp` | `Monitor`(:82), `Mutex`(:297), `lock_types` enum(:106-119), `_safepoint_check_required`(:167-177), `SplitWord`(:64) | ★ 基类定义 + rank 枚举 + safepoint 三态 + PaddedMonitor/PaddedMutex |
| 2 | `mutex.cpp` | `src/hotspot/share/runtime/mutex.cpp` | `set_owner_implementation()`(:1280), `get_least_ranked_lock()`(:1224), `check_prelock_state()`(:1369), `lock()`(:878), `ILock()`(:429) | ★★★ rank 排序强制 + fatal 断言 + _owned_locks 链表 + safepoint 检查 |
| 3 | `mutexLocker.hpp` | `src/hotspot/share/runtime/mutexLocker.hpp` | `MutexLocker`(:182), `MutexLockerEx`(:223), `MonitorLockerEx`(:250) | ★ RAII 三层封装 + extern 声明 + safepoint_check 参数 |
| 4 | `mutexLocker.cpp` | `src/hotspot/share/runtime/mutexLocker.cpp` | `mutex_init()`(:194-354), `def()` 宏(:187-191) | ★ 80+ 锁的创建 + rank 注入 + safepoint_check 赋值 |
| 5 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | Thread::_owned_locks 字段, 线程创建/销毁时的锁交互 | 线程持有锁的生命周期 |
| 6 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | Thread::_owned_locks 声明, `check_for_valid_safepoint_state()` | 线程持有的锁链表 + safepoint 状态验证 |
| 7 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `JVM_RawMonitorCreate` → rank=`native` 的锁 | native rank 的使用场景 |
| 8 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | `SafepointSynchronize::begin()`, `Safepoint_lock` | safepoint 协议中的锁交互 |

## 四、必须深度走读的核心概念

### 4.1 Mutex vs Monitor 二层模型 — 为什么历史反转？

```
★★★ 当前设计 (J2SE7 至今, mutex.hpp:273-294 注释):

  Monitor (基类, 第 82 行)
    ├── _LockWord, _owner, _EntryList, _WaitSet, ...
    ├── lock(), unlock(), try_lock()
    ├── wait(), notify(), notify_all()           ← 条件变量全部在基类
    ├── 子类: PaddedMonitor (加 cache-line padding)
    │
    └── Mutex (第 297 行, 继承 Monitor)
          ├── wait()/notify()/notify_all() → private + ShouldNotReachHere()
          ├── 只暴露 lock()/unlock() → 纯互斥语义
          ├── 子类: PaddedMutex (加 cache-line padding)
          └── ★ 这就是"退化的 Monitor" — 禁用了条件变量功能

  历史反转的原因 (mutex.hpp:274-277 注释):
    在 J2SE7 之前: Monitor extends Mutex (逻辑直觉: 互斥锁 + condvar = 监视器)
    在 J2SE7 之后: Mutex extends Monitor (实现便利: 把 wait/notify 放在基类)
    
    为什么不回到原始设计？
    注释说: "At one point in time there may have been some benefit to
     having distinct mutexes and monitors, but that time has past."
     → 实际上应该彻底消除 Mutex，全用 Monitor → 但改不动

  ★ 与 Java 层 synchronized 的 ObjectMonitor 的区别:
    - 本文的 Monitor 是 JVM 内部锁 (C++ pthreads 实现)
    - [04] 的 ObjectMonitor 是 Java synchronized 的底层实现
    - 它们是不同的类! 本文的 Monitor 在 mutex.hpp, ObjectMonitor 在 objectMonitor.hpp
    - 两者唯一的联系: 底层都用 pthread_cond_timedwait
```

### 4.2 ★★★ Lock Ranking — 全局全序死锁预防

```
★★★ lock_types 枚举 (mutex.hpp:106-119) — 12 级主 rank + 900 个微调 slot:

  event       = 0      ← 最低 rank (先获取)
  access      = 1      ← SATB/DirtyCard 队列锁
  tty         = 3      ← tty_lock (stdout 互斥)
  special     = 4      ← CodeCache_lock, Service_lock, Patching_lock
  suspend_resume = 5   ← 豁免 rank 检查 (与 native 一样)
  vmweak      = 7      ← VMWeakAlloc_lock, StringTableWeak locks
  leaf        = 9      ← ★ 大量锁: STS_lock, SystemDictionary_lock, ...
  safepoint   = 19     ← Safepoint_lock (唯一)
  barrier     = 20     ← Threads_lock
  nonleaf     = 21     ← Terminator_lock, VMOperationQueue_lock
  max_nonleaf = 921    ← ★ nonleaf + 900 个微调 slot (如 nonleaf+5)
  native      = 922    ← 最高 rank, 豁免死锁检测

★★★ rank 排序规则 (mutex.cpp:1301-1326 — 全文最重要的代码):

  set_owner_implementation(Thread * new_owner):
    ① 获取线程当前持有的最低 rank 锁: locks = get_least_ranked_lock(new_owner->owned_locks())
    ② 如果新锁的 rank ≥ locks->rank() 且不是 native/suspend_resume → FATAL

  // ★ 规则: 获取锁必须按 rank 严格降序 (从高 rank 往低 rank)
  //   源码注释 (mutex.cpp:1306-1310):
  //   "m1 is the lowest ranked mutex that the thread holds and m2 is the
  //    mutex the thread is trying to acquire, then deadlock avoidance rules
  //    require that the rank of m2 be less than the rank of m1."
  //
  //   翻译: 已持有锁中 rank 最低的 = m1, 新锁 = m2, 必须 rank(m2) < rank(m1)
  //   → 因为 _owned_locks 是头插法, 最近获取的在链表头 → rank 越来越小
  //   → 获取顺序: native(922) → nonleaf(21) → leaf(9) → special(4) → event(0)
  //
  //  已持有 rank=9 (leaf)     → 只能获取 rank < 9 的锁 (如 special=4, tty=3)  → 合法
  //  已持有 rank=4 (special)  → 获取 rank=9 (leaf) → FATAL! (rank 必须降序)
  //  已持有 rank=21 (nonleaf) → 获取 rank=9 (leaf) → 合法 (9 < 21, 降序)

  // 例外:
  //  ① native (922): JVM_RawMonitorCreate 创建, 不参与 JVM 内部锁排序
  //  ② suspend_resume (5): 线程挂起/恢复协议, 不参与排序
  //  ③ 在 safepoint 中: 所有锁排序失效 (因为所有 JavaThread 停在 safepoint)
  //  ④ Safepoint_lock + Terminator_lock 特殊情况 (mutex.cpp:1314-1321):
  //     在 safepoint 同步期间, 如果已持有 Terminator_lock(21),
  //     可以破例获取 Safepoint_lock(19) — 即使 rank 降序不满足也会豁免

★★★ 为什么用整数排名而不是锁的依赖图?

  1. 简单性: O(1) 比较两个锁的 rank 值 vs O(E) 遍历依赖图
  2. 静态性: rank 在编译期确定 (enum), 不需要动态注册
  3. 可调试: fatal 输出锁名 + rank 值 → 立即知道哪个锁顺序错了
  4. 局限性: 两个 rank=leaf(9) 的锁之间没有先后顺序 → 不能同时持有两个 leaf 锁
     (除非代码保证调用顺序永远不会交叉)

★★★ 从 [07][08][09][10] 追溯到的锁及其 rank:

  ┌────────────────────────────┬─────────────────────────┬──────────────┐
  │ 锁                         │ 持有者                   │ rank          │
  ├────────────────────────────┼─────────────────────────┼──────────────┤
  │ CGC_lock                   │ VMThread/G1ConcrMarkThrd │ special (4)   │
  │ STS_lock                   │ G1ConcurrentRefineThr   │ leaf (9)      │
  │ NonJavaThreadsList_lock    │ NonJavaThread 构造/析构  │ leaf (9)      │
  │ Safepoint_lock             │ VMThread                │ safepoint (19)│
  │ Threads_lock               │ VMThread/JavaThread     │ barrier (20)  │
  │ VMOperationQueue_lock      │ VMThread                │ nonleaf (21)  │
  │ Terminator_lock            │ WatcherThread/ServiceThr│ nonleaf (21)  │
  │ VMOperationRequest_lock    │ 发起 VMOperation 的线程  │ nonleaf (21)  │
  │ PeriodicTask_lock          │ WatcherThread           │ nonleaf+5 (26)│
  └────────────────────────────┴─────────────────────────┴──────────────┘

  ★ 核心验证: WatcherThread 获取顺序:
    ① PeriodicTask_lock (rank=26)
    ② 如果在 sleep() 中一直持有 PeriodicTask_lock
    ③ 不会被 safepoint 中断 (不是 JavaThread)
    ④ 不需要获取其他锁 → 不会违反 rank 排序
```

### 4.3 ★ safepoint_check 三态 — 锁与 GC 的交互协议

```
★★★ SafepointCheckRequired 枚举 (mutex.hpp:167-177):

  _safepoint_check_never    = 0  // ★ 永远不能做 safepoint 检查
                                  //   持有者: WatcherThread (非 JavaThread)
                                  //   持有者: NonJavaThread (不参与 safepoint)
                                  //   使用: _no_safepoint_check_flag
                                  //   示例: CGC_lock, NonJavaThreadsList_lock, STS_lock
                                  //   注意: PeriodicTask_lock 本身是 _safepoint_check_sometimes,
                                  //        但 WatcherThread 通过 _no_safepoint_check_flag 绕过检查

  _safepoint_check_sometimes = 1  // ★ safepoint 时可以持有，但需要特殊处理
                                  //   持有者: VMThread (只在 safepoint 中持有)
                                  //   使用: 不做额外检查
                                  //   示例: Safepoint_lock, Terminator_lock,
                                  //         Threads_lock, VMOperationQueue_lock,
                                  //         PeriodicTask_lock (WatcherThread 通过
                                  //         _no_safepoint_check_flag 绕过)

  _safepoint_check_always   = 2  // ★ 必须在 safepoint 外持有
                                  //   持有者: JavaThread (正常执行时)
                                  //   使用: lock() 函数自动检查
                                  //   示例: SystemDictionary_lock, Module_lock,
                                  //         InlineCacheBuffer_lock

★★★ lock() vs lock_without_safepoint_check() 的区别 (mutex.cpp:878 vs mutex.hpp:224):

  lock():
    ① assert(_safepoint_check_required != _safepoint_check_never)
       → 这个锁不允许用 lock() 获取 (必须用 lock_without_safepoint_check)
    ② check_prelock_state() → 检查线程的 safepoint 状态
    ③ 如果是 JavaThread → ThreadBlockInVM → 允许 safepoint

  lock_without_safepoint_check():
    ① 不做任何 safepoint 检查
    ② 直接 ILock() → park 等待
    ③ ★ WatcherThread::sleep() / NonJavaThread 构造 / GC 并发线程 使用

★★★ 为什么 PeriodicTask_lock 需要 _no_safepoint_check_flag?

  PeriodicTask_lock 本身的 safepoint_check 设定是 _safepoint_check_sometimes:
    → 如果由 JavaThread 获取 → 用 lock() → 允许 safepoint 检查 → 可以在 safepoint 中被 block
    → 如果由 WatcherThread 获取 → 用 lock_without_safepoint_check()
      → 因为 WatcherThread 不是 JavaThread → 不能参与 safepoint 协议
      → 如果做 safepoint check → VMThread 等待 WatcherThread 到达 safepoint
      →但 WatcherThread 永远不响应 safepoint → 死锁

  ★ 关键区分: _no_safepoint_check_flag 是 MutexLockerEx 的参数, 不是锁的属性!
    锁本身是 _safepoint_check_sometimes → 允许 JavaThread 安全获取
    但 NonJavaThread 调用时必须传 _no_safepoint_check_flag → 绕过检查
```

### 4.4 ★ Thread::_owned_locks — 每线程的锁链表

```
★★★ _owned_locks 不是独立的数据结构 — 就是 Monitor::_next 串起来的单链表:

  Thread::_owned_locks (thread.hpp, #ifdef ASSERT 下):
    Monitor* _owned_locks;  // ★ 指向该线程当前持有的锁

  获取锁时 (set_owner_implementation, mutex.cpp:1328-1329):
    this->_next = new_owner->_owned_locks;  // 新锁的 _next 指向旧链表头
    new_owner->_owned_locks = this;          // 线程的 _owned_locks 指向新锁

  释放锁时 (set_owner_implementation, mutex.cpp:1344-1362):
    遍历线程的 _owned_locks 链表 → 找到 this → 移除

  ★ 设计精妙: 不需要额外的链表节点!
    Monitor 自身自带 _next 字段 (mutex.hpp:142, #ifndef PRODUCT)
    → 每个 Monitor 同时是锁对象 + 链表节点
    → 零额外内存开销

★★★ get_least_ranked_lock() (mutex.cpp:1224-1241):

  遍历 _owned_locks 链表 → 返回 rank 最小的 Monitor

  额外检查 (mutex.cpp:1231-1238):
    如果不处于 safepoint → 验证链表按 rank 升序 (assert tmp->rank() <= tmp->next()->rank())
    因为头插法: _owned_locks 头 = 最新获取, 头 rank 最小 → 越往后 rank 越大
    → 获取顺序就是 rank 降序 (先拿大 rank, 再拿小 rank)

★★★ print_owned_locks() — 死锁诊断:

  fatal 前调用 new_owner->print_owned_locks():
    → 输出线程当前持有的所有锁的名称 + rank
    → 直接定位死锁原因 → 不需要事后分析 core dump
```

### 4.5 ★ RAII 三层封装 — 为什么需要三层？

```
★★★ RAII 封装链:

  // 第 1 层 — 基础封装
  MutexLocker(Monitor * mutex):
    ① 构造函数: mutex->lock()                     // 普通 lock, 做 safepoint check
    ② 析构函数: mutex->unlock()
    ③ 限制: rank=special 的锁不能用 MutexLocker (必须用 MutexLockerEx)

  // 第 2 层 — 扩展封装 (支持 NULL + no_safepoint_check)
  MutexLockerEx(Monitor * mutex, ...):
    ① 支持 mutex=NULL → no-op                           // WatcherThread 可能没创建
    ② 支持 no_safepoint_check=true → lock_without_safepoint_check()
    ③ 构造函数可以接受条件表达式                            // 动态选择锁

  // 第 3 层 — 条件变量封装
  MonitorLockerEx(Monitor * monitor, ...) extends MutexLockerEx:
    ① 增加 wait(timeout) → _monitor->wait()
    ② 增加 notify() / notify_all()
    ③ 析构时 assert_lock_strong(_monitor)              // 确保 wait 后重新持有锁

★★★ 为什么需要 MutexLockerEx 而不是全部用 MutexLocker?

  场景 1 — 条件锁:
    MutexLockerEx ml(PeriodicTask_lock->owned_by_self() ? NULL : PeriodicTask_lock);
    → 如果已经持有 PeriodicTask_lock → 不重复加锁 (Monitor 不支持递归!)

  场景 2 — NonJavaThread 锁:
    MutexLockerEx ml(PeriodicTask_lock, Mutex::_no_safepoint_check_flag);
    → WatcherThread 不是 JavaThread → 不能做 safepoint check

  场景 3 — 可选锁:
    MonitorLockerEx ml(lock, Mutex::_no_safepoint_check_flag);
    ...
    ml.wait(timeout);  // 只有 MonitorLockerEx 支持 wait/notify
```

### 4.6 ★ JVM_RawMonitorCreate — native rank 的来源

```
★★★ native rank (922) 豁免死锁检测的原因:

  JVM_RawMonitorCreate (os_linux.cpp):
    → 创建 new PaddedMonitor(Mutex::native, ...)
    → rank = 922 → 不受死锁检测约束
    → 供 JNI 代码通过 JVM_RawMonitorEnter/Exit 使用
    → 这些锁的获取顺序不由 JVM 控制 → 不能强加 rank 排序

  jvm_raw_lock() (mutex.cpp:1014-1015):
    assert(rank() == native, "invariant");
    → 只有 native rank 的锁才能用 jvm_raw_lock

  ★ 设计洞察: native rank 是 JVM 内部锁体系和外部 JNI 锁体系的分界线。
    内部锁 → rank 排序保证不死锁
    外部锁 → 不保证，由 JNI 开发者自己负责
```

## 五、文章结构

```
§〇 源文件清单（跨 runtime/os）

§一 为什么需要 80+ 把内部锁？— 线程体系的锁依赖全景
  ★ 从 [07][08][09][10] 中提取所有锁的使用场景
  ❓ 为什么不直接一把全局大锁？→ 粒度太粗 → 性能灾难
  ❓ 那 80+ 把细粒度锁为什么不死锁？→ Lock Ranking
  1.1 线程→锁映射矩阵：展示每条线程持有的锁 + rank
  1.2 [07][08][09][10] 中的 8 个关键锁全景

§二 Mutex vs Monitor 二层模型 — 历史反转
  ❓ 为什么 J2SE7 后 Mutex 继承 Monitor 而不是反过来？
  ❓ 什么时候用 Mutex？什么时候用 Monitor？
  2.1 Monitor 基类定义 + 字段 (mutex.hpp:82-259)
  2.2 Mutex 派生类 — 退化的 Monitor (mutex.hpp:297-309)
  2.3 ★ 与 [04] ObjectMonitor 的对比 — 两套 Monitor 系统共存的理由

§三 ★★★ Lock Ranking — 死锁预防的核心协议
  ❓ 为什么不用锁依赖图而用整数排名？
  3.1 lock_types 枚举全景 (mutex.hpp:106-119) — 12 级主 rank
  3.2 ★ 致命断言走读: set_owner_implementation() (mutex.cpp:1280-1330) ← 全文核心
  3.3 ★ 两处豁免: native + suspend_resume + safepoint 特殊处理
  3.4 ★ 线程系统锁的 rank 关系: 画出 rank 依赖图
  3.5 反例分析: 如果 rank 排序错了会怎样？构造死锁场景

§四 safepoint_check 三态 — 锁与 GC 的交互协议
  ❓ PeriodicTask_lock 为什么必须 _no_safepoint_check_flag？
  4.1 _safepoint_check_never/sometimes/always 的精确语义 (mutex.hpp:167-177)
  4.2 lock() vs lock_without_safepoint_check() 的调用路径 (mutex.cpp:878 vs mutex.hpp:224)
  4.3 ★ 从 [10] 追溯: 所有 NonJavaThread 的锁为什么都用 _no_safepoint_check_flag
  4.4 check_prelock_state() 的内部逻辑 (mutex.cpp:1369-1390)

§五 RAII 三层封装 — MutexLocker→MutexLockerEx→MonitorLockerEx
  ❓ 为什么需要三层？
  5.1 MutexLocker: 基础 lock/unlock (mutexLocker.hpp:182)
  5.2 MutexLockerEx: NULL + no_safepoint_check 支持 (mutexLocker.hpp:223)
  5.3 MonitorLockerEx: wait/notify 能力 (mutexLocker.hpp:250)
  5.4 ★ 从 [07][09][10] 中找三种封装的使用实例

§六 Thread::_owned_locks — 每线程的锁链表
  ❓ 为什么不直接用 Thread::_owned_locks 做锁排序验证？
  6.1 _owned_locks 的链表结构 — Monitor::_next 自引用
  6.2 get_least_ranked_lock() 的实现 (mutex.cpp:1224-1241)
  6.3 ★ head-insert 的设计含义: 链表按获取时间排序 → rank 必须严格递增
  6.4 GDB 验证: 打印一个线程的 _owned_locks 链表

§七 mutex_init() — 80+ 锁的创建入口
  ❓ 为什么用宏 def() 而不是直接 new？
  7.1 def() 宏的设计 (mutexLocker.cpp:187-191)
  7.2 线程系统 8 个关键锁的完整声明 (rank + safepoint_check + allow_vm_block)
  7.3 为什么 half of locks 标记 allow_vm_block=true？

§八 ★ 线程系统的锁排序全景
  ❓ VMThread 获取 3 把锁的顺序为什么不会死锁？
  8.1 VMThread 在 safepoint 中的锁获取: Safepoint_lock(19) → Threads_lock(20) → ...
      ★ 为什么不会触发 rank 检查? 因为 mutex.cpp:1319 行:
      `!SafepointSynchronize::is_at_safepoint()` → safepoint 中跳过全部 rank 检查
  8.2 WatcherThread 的锁顺序: PeriodicTask_lock(26) 单独持有 → 无冲突
  8.3 G1ConcurrentMarkThread: CGC_lock(4) 单独持有 → 无冲突
  8.4 ★ 核心洞察: rank 检查只在"并发执行"期间生效, safepoint 期间全部豁免

§九 GDB 验证 + 可证伪断言（≥10 条, 每条含命令 + 预期值）

  断言 1 — 验证 PeriodicTask_lock 的 rank + safepoint_check:
    (gdb) p PeriodicTask_lock->rank()
    → 预期: 26 (nonleaf+5)
    (gdb) p PeriodicTask_lock->_safepoint_check_required
    → 预期: _safepoint_check_sometimes (1)

  断言 2 — 验证 CGC_lock 的 safepoint_check:
    (gdb) p CGC_lock->rank()
    → 预期: 4 (special)
    (gdb) p CGC_lock->_safepoint_check_required
    → 预期: _safepoint_check_never (0)

  断言 3 — 验证Threads_lock 的 rank 在 Safepoint_lock 之上:
    (gdb) p Threads_lock->rank()
    → 预期: 20 (barrier)
    (gdb) p Safepoint_lock->rank()
    → 预期: 19 (safepoint)
    → 验证: Threads_lock(20) > Safepoint_lock(19) → 合法获取顺序

  断言 4 — 验证 Thread::_owned_locks 链表:
    (gdb) break WatcherThread::sleep + 15 (在获取 PeriodicTask_lock 之后)
    (gdb) continue
    (gdb) p this->_owned_locks
    → 预期: 非 NULL (至少持有 PeriodicTask_lock)
    (gdb) p this->_owned_locks->_name
    → 预期: "PeriodicTask_lock"

  断言 5 — 验证 lock_without_safepoint_check 调用者:
    (gdb) break Monitor::lock_without_safepoint_check
    (gdb) continue
    (gdb) bt
    → 预期: 调用栈来自 WatcherThread::sleep 或 NonJavaThread 构造

  断言 6 — 验证 MutexLockerEx 的 NULL 处理:
    (gdb) break MutexLockerEx::MutexLockerEx
    (gdb) continue
    设置断点条件: _mutex == NULL
    → 预期: 不再调用 lock() (no-op)

  断言 7 — 验证 PeriodicTask_lock 在 mutex_init 中的定义:
    源码: mutexLocker.cpp:321
    → def(PeriodicTask_lock, PaddedMonitor, nonleaf+5, true,
           Monitor::_safepoint_check_sometimes)

  断言 8 — 验证 NonJavaThreadsList_lock 的 safepoint_check:
    (gdb) p NonJavaThreadsList_lock->rank()
    → 预期: 9 (leaf)
    (gdb) p NonJavaThreadsList_lock->_safepoint_check_required
    → 预期: _safepoint_check_never (0)
    → 原因: NonJavaThread 构造/析构不参与 safepoint

  断言 9 — 验证 Safepoint_lock + Terminator_lock 特殊情况:
    # 阅读 mutex.cpp:1323-1326 注释:
    # "also ok to acquire Safepoint_lock at the very end while we
    #  already hold Terminator_lock"
    → 验证: 这个硬编码例外防止误 fatal

  断言 10 — 验证 rank 枚举值:
    (gdb) p Mutex::native
    → 预期: 922
    (gdb) p Mutex::safepoint
    → 预期: 19
    (gdb) p Mutex::leaf
    → 预期: 9

  断言 11 — 验证 Monitor::lock() 对 _safepoint_check_never 的拒绝:
    # 源码: mutex.cpp:880-881
    # assert(_safepoint_check_required != _safepoint_check_never,
    #        "This lock should never have a safepoint check")
    → 验证: 带 _safepoint_check_never 的锁调用 lock() 会 assert fail

  断言 12 — 验证 PaddedMonitor vs PaddedMutex:
    # PaddedMonitor: Monitor + cache-line padding (伪共享避免)
    # PaddedMutex:   Mutex   + cache-line padding
    → 对比: PaddedMonitor 可以 wait/notify, PaddedMutex 不行
    → 验证: PeriodicTask_lock 是 PaddedMonitor (需要 wait/notify)
            NonJavaThreadsList_lock 是 PaddedMutex (只需要 lock/unlock)
```

## 六、写作要求

1. **★ set_owner_implementation() 是全文灵魂**: 第 1301-1326 行的每行都要解释——为什么这样设计、不这样设计会怎样、两个豁免条件的理由
2. **历史反转必须有**: Mutex 继承 Monitor 的合理性解释，引 mutex.hpp 注释原文
3. **从 [07][08][09][10] 追溯锁**: 不凭空讲锁，每把锁都有具体的线程/场景作为"为什么要用它"的理由
4. **rank 依赖图**: 用关系图展示线程系统 8 把关键锁的 rank 依赖关系
5. **反例构造**: "如果 rank 排序错了会怎样"——用一个具体死锁场景演示
6. **GDB 验证 _owned_locks 链表**: 在 WatcherThread 持有 PeriodicTask_lock 的时刻，打印 _owned_locks
7. **交叉引用**: [07] VMThread, [08] WorkerThread, [09] JavaThread, [10] NonJavaThread + [04] ObjectMonitor vs 本文 Monitor

## 七、输出格式

- Markdown 文件，命名为 `11-JVM-Internal-Locks.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 [04][07][08][09][10] + 阅读收益）
