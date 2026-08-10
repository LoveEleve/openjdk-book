# 域 19: Synchronization — 知识规划

> 源码路径: hotspot/share/runtime/objectMonitor.* + synchronizer.* + biasedLocking.* + mutex.* + park.* + semaphore.* + basicLock.* + rtmLocking.*
> 源码量: 19 文件 / ~9,433 行 | 🟡 大域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| objectMonitor.hpp + objectMonitor.cpp + objectMonitor.inline.hpp | **ObjectMonitor — 重量级锁**: _header(displaced markOop at offset 0), _owner(owning thread), _recursions(重入次数), _EntryList(等待进入), _cxq(最近到达的竞争者), _WaitSet(wait() 调用者), _succ(推定继承者), _Responsible, _Spinner+_SpinDuration(自适应自旋), _count(引用计数防deflate回收) | High |
| synchronizer.hpp + synchronizer.cpp | **ObjectSynchronizer — 锁入口调度器**: fast_enter(Slow: biased→BasicLock→inflate→ObjectMonitor), slow_enter(ObjectMonitor enter queue), fast_exit/slow_exit, inflate(BasicLock→ObjectMonitor), deflate_idle_monitors(safepoint 清理), omAlloc(per-thread free list→global list), notify/notifyall | High |
| biasedLocking.hpp + biasedLocking.cpp | **BiasedLocking — 偏向锁**: revoke_and_rebias(重偏向→revoke 批量/单个), bulk_revoke_or_rebias_at_safepoint, heuristic(epoch+bulk_rebias_limit), markOop::biased_lock 编码(thread_id+epoch+age)| High |
| basicLock.hpp + basicLock.cpp | **BasicLock — 轻量级栈锁**: displaced_header 存 markOop, 在线程栈上分配(obj 对象内部仅 lock_record 偏移指向 BasicLock), zero-size 检测 | Medium |
| mutex.hpp + mutex.cpp | **Monitor/Mutex — VM 内部锁**: Monitor=条件变量(pthread_cond)+ Mutex=spin lock, rank 系统(锁顺序防死锁), safepoint check(锁获取/释放的 safepoint 协调), _snuck(递归 bypass rank check), Monitor::wait/park/unpark | Medium |
| mutexLocker.hpp + mutexLocker.cpp | **MutexLocker — RAII 锁守卫**: MutexLocker(MonitorLocker 含 wait), 栈上分配自动释放, 支持 try_lock+wait, rank assertion | Low |
| park.hpp + park.cpp | **ParkEvent/Parker — 线程停放**: PlatformEvent(pthread_cond/mutex 封装), park 3步骤: 重置→检查 permit→cond_wait, unpark: 设置 permit→cond_signal, 支持带时限 park_nanos | Medium |
| semaphore.hpp + semaphore.inline.hpp | **Semaphore — 内部信号量**: POSIX sem 封装, wait/signal/trywait, 用于 Handshake/VMOps 协调 | Low |
| rtmLocking.hpp + rtmLocking.cpp | **RTMLocking — TSX 锁省略**: RTMRetryCount, abort 类型(busy/capacity/conflict/debug), 退避策略, UseRTMLocking flag | Low |

*9 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识
| KP | 出现文件 |
|----|---------|
| Java 锁三级层次 (biased→BasicLock→ObjectMonitor→inflate) | synchronizer.*, biasedLocking.*, basicLock.*, objectMonitor.*, markOop.hpp(域6) |

### P2 — 局部重要
| KP | 出现文件 |
|----|---------|
| ObjectMonitor enter/exit/wait/notify | objectMonitor.*, synchronizer.*, park.* |
| BiasedLocking revoke/rebias 协议 | biasedLocking.*, synchronizer.*, safepoint.* |
| VM 内部 Monitor/Mutex + rank lock ordering | mutex.*, mutexLocker.* |

### P3 — 孤立
| KP | 文件 |
|----|------|
| BasicLock 栈锁 | basicLock.* |
| ParkEvent/Parker | park.* |
| Semaphore | semaphore.* |
| RTMLocking | rtmLocking.* |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (4 KP)
| KP | 为什么 🔴 |
|----|---------|
| 锁膨胀偏斜路径 (biased→BasicLock→ObjectMonitor) | Java 锁不直接创建 ObjectMonitor——通过 markOop 编码 3-bit lock state(0=unlocked, 1=biased, 2=BasicLock, 3=ObjectMonitor)实现无成本升级。biased lock 让首次获取免 CAS(BasicLock biased_lock 标志位直接写入 thread_id), BasicLock 让快速路径在栈上(无全局分配), ObjectMonitor 让高竞争场景有期货唤醒。trinity 是 HotSpot locking performance 的核心 |
| ObjectMonitor enter/exit 协议 | 非公平锁 + adaptive spinning(自旋上限+自适应)+ _succ 继承传递(防止无谓唤醒): enter 通过 cmpxchg _owner 抢锁→失败进 EntryList→spin 自旋→park。exit 时如果 EntryList 非空→唤醒 succ(继承线程)而非 wake-all。这是 Linux futex 的用户空间复刻 |
| BiasedLocking revoke/rebias | 偏向锁撤销需要 safepoint——如果持有偏向锁的线程已经跑了→需要暂停所有线程做 bulk revocation。epoch 协议: 每个 Klass 有 _biased_lock_revocation_count→epoch 过期时批量撤销而非单个 O(n)→O(1) per class。JDK15 默认禁用 biased locking(startup overhead) |
| ObjectSynchronizer 等待队列 (cxq+EntryList+WaitSet 三队列) | `synchronized` 使用队列分离: cxq(最近到达者, LIFO)↔EntryList(等待进入者)→WaitSet(wait() 被唤醒后走 EnterList)。分离的原因是: cxq 处理新到达者的锁争用, EntryList 负责排队, WaitSet 管理 wait/notify。notify 从 WaitSet→EntryList→enter 重新竞争锁 |

### 🟡 Working — 有设计但非核心 (3 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| Monitor/Mutex rank ordering | 100+ 锁类型按 rank 编号(Mutex::safepoint=0, MM_tracker=1,...)——获取锁时必须 rank 递增检查防死锁。release 模式禁用以避免性能开销 | 死锁预防是 VM stability 的重要机制但非 🔴——没有它也正常工作。rank 系统是防御性设计 |
| ParkEvent/Parker (线程停放) | platform park——pthread_cond+mutex 实现 permit 原语: park=decrement permit then cond_wait, unpark=set permit then cond_signal。Timeout park→pthread_cond_timedwait | 是 OS 层提供的基础原语——JDK LockSupport.park() 的直接底层。作用大但自己不决定锁行为 |
| Semaphore 内部信号量 | POSIX sem 包装——Handshake 和 VMOps 协调使用——双边同步语义(sem_wait/sem_post) | 简单利薄——用于内部协调非 Java 锁可见 |

### 🟢 Surface — 了解即可 (2 KP)
| KP | 说明 |
|----|------|
| BasicLock 栈锁 | 在线程栈上分配→锁记录存 displaced markOop→锁释放时恢复 |
| RTMLocking TSX 锁省略 | x86 TSX xbegin/xend 硬件事务——锁省略失败→退避到传统锁 |

## 04 聚类 — 依赖图+教学顺序+文章拆分

### 依赖图
```
ObjectSynchronizer (入口调度)
     │
     ├→ fast_enter → biasedLocking.revoke_and_rebias (markOop biased bit)
     │            → BasicLock (stack lock record + cmpxchg markOop)
     │            → inflate → ObjectMonitor
     │
     ├→ slow_enter → ObjectMonitor.enter (spinning + park)
     ├→ fast_exit  → ObjectMonitor.exit (unpark succ)
     └→ wait/notify → WaitSet → EntryList → enter
```

### 教学顺序

**快速→膨胀→结构→进出→等待→内部**:
1. 先讲锁的演化路径——为什么需要 biased→BasicLock→ObjectMonitor 三级
2. 再讲 ObjectMonitor 内部结构——字段布局(fasle sharing prevention)和语义
3. 然后 enter/exit 协议——spinning/EntryList/Succ 继承
4. 最后 wait/notify+ParkEvent+内部锁 Mutex rank

### 文章拆分: 4 篇

| 篇 | 标题 | 覆盖 KP | 核心问题 | 预估 |
|:--:|------|:--:|------|:--:|
| 1 | 锁演化 — biased→BasicLock→ObjectMonitor | 三级锁路径, inflate, fast_enter/slow_enter, markOop 3-bit encoding, 为什么需要 biased lock | "`synchronized` 到底有几级锁？为什么？" | 基础 |
| 2 | ObjectMonitor 内部结构 | ObjectMonitor 字段布局(_header/_owner/_recursions), 三条队列分离 (cxq/EntryList/WaitSet), adaptive spinning, deflate | "一个 Java monitor 在 C++ 里是怎么表示的？" | 核心 |
| 3 | Enter/Exit 协议与 Wait/Notify | cmpxchg _owner enter, spinning+park exit, succ handoff, wait→WaitSet, notify→EntryList, ParkEvent parking | "多个线程抢同一把锁——到底谁先拿到？wait() 被唤醒后怎么重新抢锁？" | 核心 |
| 4 | VM 内部锁与安全网 | Mutex/Monitor rank ordering, MutexLocker RAII, BiasedLocking revoke safepoint, deflate_idle_monitors, Semaphore/ParkEvent | "JVM 内部的锁怎么保证不产生死锁？偏向锁撤销为什么需要 safepoint？" | 深度 |
