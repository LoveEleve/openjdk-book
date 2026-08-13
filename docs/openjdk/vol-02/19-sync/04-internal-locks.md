# 04. JVM 自己怎么锁自己?— VM 内部锁与安全网

> **前置依赖**:[19-sync/03 — enter/exit/wait](openjdk/vol-02/19-sync/03-enter-exit-wait.md):VM 内部锁与 ObjectMonitor 共享同一套 ParkEvent 队列思想;[19-sync/01 — synchronized 三步曲](openjdk/vol-02/19-sync/01-lock-hierarchy.md):偏向锁撤销与 deflate 的安全点依赖;[17-threads/04 — interfaceSupport](openjdk/vol-02/17-threads/04-interface-support.md):锁获取时的状态守卫
> → **后续**:域 20 VM Operations(安全点的所有操作由谁来驱动)
> 关联域: 01-os(原子与 futex)、17-threads(线程)、19-sync(锁)、18-safepoint

## 100 多把锁,怎么保证不死锁

JVM 内部有上百把锁: Heap_lock 管堆、CodeCache_lock 管代码缓存、Threads_lock 管线程列表——本会话已经一路用过 SR_lock/Threads_lock/MetaspaceExpand_lock/delete_lock。这些锁与 Java 层的 synchronized 不同: 没有偏向/膨胀演化,但多了两样 Java 锁没有的东西——**rank 系统**(防死锁)与 **safepoint 检查**(与停世界配合)。这一篇是 19 域收官: 锁的声明与家族、Monitor 的自研锁实现、MutexLocker RAII,以及它们与安全网的衔接。

## 1. 锁的声明与 rank 系统

### 上百把锁,一张声明表

VM 内部锁全部声明在 `mutexLocker.hpp`: 一个 extern 指针一个注释(mutexLocker.hpp:33-99,截取核心,逐字):

```cpp
// mutexLocker.hpp:33-99(截取核心,逐字)
extern Mutex*   Patching_lock;                   // a lock used to guard code patching of compiled code
extern Monitor* SystemDictionary_lock;           // a lock on the system dictionary
extern Mutex*   SharedDictionary_lock;           // a lock on the CDS shared dictionary
extern Mutex*   Module_lock;                     // a lock on module and package related data structures
...
extern Monitor* Heap_lock;                       // a lock on the heap
...
extern Monitor* CodeCache_lock;                  // a lock on the CodeCache, rank is special, use MutexLockerEx
extern Monitor* Threads_lock;                    // a lock on the Threads table of active Java threads
...
extern Mutex*   Compile_lock;                    // a lock held when Compilation is updating code (used to block CodeCache traversal, CHA updates, etc)
```

每个指针的注释就是它保护的资源;`CodeCache_lock` 的注释还提醒它的 rank 是 special、只能用 MutexLockerEx(后面会讲为什么)。

### rank: 符号枚举,不是数字等级

流传的"Mutex rank 0-25 数字层级"是旧版——jdk11u 的 rank 是**符号枚举**(mutex.hpp:107-120,截取核心,逐字):

```cpp
// mutex.hpp:106-120(截取核心,逐字)
  enum lock_types {
       event,
       access         = event          +   1,
       tty            = access         +   2,
       special        = tty            +   1,
       suspend_resume = special        +   1,
       vmweak         = suspend_resume +   2,
       leaf           = vmweak         +   2,
       safepoint      = leaf           +  10,
       barrier        = safepoint      +   1,
       nonleaf        = barrier        +   1,
       max_nonleaf    = nonleaf        + 900,
       native         = max_nonleaf    +   1
  };
```

头文件注释把每个 rank 的含义与约束讲透(mutex.hpp:82-105): **special 是最低层级**(除 event/access),持有它时保证不会阻塞(不能有 vm operation、不能再拿别的阻塞锁);**safepoint 级只用于 Safepoint_lock**(进入/离开 safepoint 的同步);**leaf 是历史命名**(注释原话 "is probably historical...aren't really leaf mutexes at all")。rank 存进 `debug_only(int _rank;)`(mutex.hpp:141)——**只存在于 debug 构建**,死锁检测是开发期的安全网,不付生产性能。

### rank 怎么防死锁

锁获取时校验"锁序": 线程记录已持有的锁,新锁的 rank 必须遵循规则——违反就 assert。典型检查在 `Monitor::wait`(mutex.cpp:1082-1088): **不能持 special 级及以下的锁去 wait**(wait 会释放锁并睡下,若别人正等这把锁就可能死锁,断言 "Shouldn't block(wait) while holding a lock of rank special")。MutexLocker 构造里也有 `rank() != Mutex::special` 断言(mutexLocker.hpp:187)——special 锁必须走带 no_safepoint_check 的 MutexLockerEx。deadlock 检测在 debug 模式当场 crash,逼开发者改获取顺序。

## 2. Monitor: 自研的锁 + ParkEvent 队列

### 家族: Mutex 是退化版的 Monitor

流传的"Monitor 继承 Mutex"说反了——真实是 **`Mutex : public Monitor`**(mutex.hpp:297,注释 "degenerate Monitor"): Monitor 是完整版(锁+等待队列+notify),Mutex 只是去掉 wait 能力的退化版。

### 锁实现: 与 ObjectMonitor 同构

Monitor 的锁**不是 pthread_mutex**——它是自研的(mutex.hpp:122-136,截取核心,逐字):

```cpp
// mutex.hpp:122-136(截取核心,逐字)
 protected:                              // Monitor-Mutex metadata
  SplitWord _LockWord ;                  // Contention queue (cxq) colocated with Lock-byte
  Thread * volatile _owner;              // The owner of the lock
                                         // Consider sequestering _owner on its own $line
                                         // to aid future synchronization mechanisms.
  ParkEvent * volatile _EntryList ;      // List of threads waiting for entry
  ParkEvent * volatile _OnDeck ;         // heir-presumptive
  volatile intptr_t _WaitLock [1] ;      // Protects _WaitSet
  ParkEvent * volatile  _WaitSet ;       // LL of ParkEvents
  volatile bool     _snuck;              // Used for sneaky locking (evil).
  char _name[MONITOR_NAME_LEN];          // Name of mutex
```

**`SplitWord _LockWord`**: 一个机器字里同时放**锁字节与 cxq 队列**(注释: "Contention queue (cxq) colocated with Lock-byte")——加锁状态与等待队列在同一个原子单元里,CAS 一次搞定;`_EntryList`/`_OnDeck`(推定继承人,类似 ObjectMonitor 的 _succ)/`_WaitSet` 全是 **ParkEvent 队列**(02/03 篇 ObjectMonitor 队列思想的原版)。`ILock`(mutex.cpp:436-500)的路径与 EnterI 同构: TryFast(锁字节 CAS)→ TrySpin → AcquireOrPush(cxq)→ 在 `_OnDeck` 上等 → ParkCommon。

### wait/notify: 队列操作,底层才碰条件变量

`notify`(mutex.cpp:663-701): 从 `_WaitSet` 取头,**CAS push 到 cxq**(:679-687,与 ObjectMonitor 的 INotify 同构);`notify_all`(:703-708)循环 notify。`wait`(mutex.cpp:1064 起): 断言 rank(不能持 special 级锁 wait,:1082-1088)→ `set_owner(NULL)`(:1095)→ safepoint 检查版的走 ThreadBlockInVM(:1103)→ `IWait`(:1112)。**pthread_cond 只出现在最底层**: PlatformEvent(os_posix.hpp:170-190)的 `_event` permit(-1/0/1)+ `pthread_mutex_t _mutex` + `pthread_cond_t _cond`——ParkEvent 们最终在这上面睡。所以流传的"Monitor 的条件变量用 pthread_cond 实现"要精确成: **Monitor 的队列是自研的,队列成员(ParkEvent)的睡眠才用 pthread_cond**。

## 3. MutexLocker RAII

获取/释放的 RAII 三兄弟在 mutexLocker.hpp:

- **`MutexLocker`**(:183-207): 构造 lock、析构 unlock——但**special 级锁不许用它**(断言 :187;MutexLockerEx 的注释把理由说透: "Mutexes with rank special or lower should not do safepoint checks",:229);
- **`MutexLockerEx`**(:224): 带 `no_safepoint_check` 参数——special 锁与"已知在 safepoint"场景用它;
- **`MonitorLockerEx`**(:251): MutexLockerEx 加 `wait()`(:271-275)。

这是 17 域 ThreadInVMfromJava 那套 RAII 的同款: 栈对象,异常路径也保证解锁——VM 代码里几乎不用裸 lock/unlock。

## 4. 安全网衔接(19 域收尾)

两个依赖 safepoint 的机制在 01 篇已详讲,这里只归位: **偏向锁撤销**需要 safepoint 读对方栈(确认它是否在临界区);**deflate_idle_monitors** 在 safepoint 回收空闲 ObjectMonitor。加上本篇的 rank 系统与 safepoint 检查(锁获取时校验"是否允许阻塞 VM 线程/是否需要在 safepoint 外"),VM 内部锁与停世界机制咬合: 锁保证数据一致,rank 保证不死锁,safepoint 检查保证不停在错误状态。

**关键设计 (斜体)**: *VM 内部锁与 Java 锁是"同一棵树上的两个枝": 队列思想(ParkEvent/cxq/OnDeck/WaitSet)完全同构,区别在外部环境——Java 锁面对偏向与膨胀演化,VM 锁面对 rank 秩序与 safepoint 纪律。而 PlatformEvent 的 permit 语义(-1/0/1)让"先 unpark 后 park 也有效"成为可能,这是 LockSupport 语义的底层。*

## 核心悬念

19 域收官: VM 内部锁到齐——声明表(mutexLocker.hpp 每把锁一个注释)、符号 rank 枚举(lock_types: special 最低/leaf 历史命名/safepoint 专属 Safepoint_lock,mutex.hpp:107-120)、debug 期死锁检测(wait 不能持 special 级锁)、Monitor 自研锁(SplitWord 锁字节+cxq colocate、ParkEvent 队列、ILock 与 EnterI 同构)、MutexLocker/MutexLockerEx/MonitorLockerEx 三兄弟、PlatformEvent 的 pthread_cond 底层。所有这些锁的获取与释放,最终都要回答同一个问题: "现在能安全地停吗?"——而"停"这件事本身,由谁发起、怎么执行、执行什么?下一篇: 域 20 VM Operations。

> → 域 20 VM Operations(第 5 批)
