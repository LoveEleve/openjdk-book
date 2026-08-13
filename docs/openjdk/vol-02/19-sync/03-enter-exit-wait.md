# 03. 多线程抢锁——谁先拿到?— Enter/Exit 与 Wait/Notify

> **前置依赖**:[19-sync/02 — ObjectMonitor 结构](openjdk/vol-02/19-sync/02-objectmonitor-structure.md):本片的执行主体就是那些字段(owner/cxq/EntryList/WaitSet/succ);[19-sync/01 — synchronized 三步曲](openjdk/vol-02/19-sync/01-lock-hierarchy.md):inflate 后的入口;[17-threads/04 — interfaceSupport](openjdk/vol-02/17-threads/04-interface-support.md):enter 里的 ThreadBlockInVM 是 17 域那套守卫
> → **后续**:[19-sync/04 — VM 内部锁](04-internal-locks.md)(Mutex/Monitor 与 Java 锁有什么不同)
> 关联域: 06-oops(对象头)、19-sync(锁)、17-threads(线程)、01-os(原子与 futex)

## 三线程抢一把锁,底层怎么协调

3 个线程同时 `synchronized(obj)`: 一个拿到锁,两个排队;拿锁的线程 `wait()` 放弃,另一个 `notify()`。这一系列动作在 ObjectMonitor 上是: enter 的 CAS 一击与排队、exit 的 succ 继承与批量转移、wait/notify 的三队列流转。这一篇按"抢锁 → 释放 → 睡眠/唤醒"把协议走完。

## 1. enter: 一击 CAS,抢不到就排队

### 快速路径: 一条 cmpxchg

`ObjectMonitor::enter`(objectMonitor.cpp:265-291,截取核心,逐字):

```cpp
// objectMonitor.cpp:265-291(截取核心,逐字)
void ObjectMonitor::enter(TRAPS) {
  // The following code is ordered to check the most common cases first
  // and to reduce RTS->RTO cache line upgrades on SPARC and IA32 processors.
  Thread * const Self = THREAD;

  void * cur = Atomic::cmpxchg(Self, &_owner, (void*)NULL);
  if (cur == NULL) {
    // Either ASSERT _recursions == 0 or explicitly set _recursions = 0.
    assert(_recursions == 0, "invariant");
    assert(_owner == Self, "invariant");
    return;
  }

  if (cur == Self) {
    // TODO-FIXME: check for integer overflow!  BUGID 6557169.
    _recursions++;
    return;
  }

  if (Self->is_lock_owned ((address)cur)) {
    assert(_recursions == 0, "internal state error");
    _recursions = 1;
    // Commute owner from a thread-specific on-stack BasicLockObject address to
    // a full-fledged "Thread *".
    _owner = Self;
    return;
  }
  ...
```

三条快路径:**锁空闲**(`cmpxchg(Self, &_owner, NULL)`,:270 命中即 owner);**自己已是 owner**(重入,:279-283 直接 `_recursions++`);**锁还挂在膨胀前 owner 的栈上**(`is_lock_owned`,:285-291——把它转成正经的 `Thread*`,重入计数置 1)。

### 慢速路径: 防 deflate → EnterI 排队

真竞争来了: 先 `Atomic::inc(&_count)`(:316,**防 deflate 回收的引用计数**,02 篇讲过),套上 ThreadBlockInVM(:339,17 域守卫),然后循环调 `EnterI`(:355)。`EnterI`(objectMonitor.cpp:442 起)是排队主流程(截取核心,逐字):

```cpp
// objectMonitor.cpp:442-507(截取核心,逐字)
void ObjectMonitor::EnterI(TRAPS) {
  Thread * const Self = THREAD;
  ...
  // Try the lock - TATAS
  if (TryLock (Self) > 0) {
    ...
    return;
  }

  DeferredInitialize();

  // We try one round of spinning *before* enqueueing Self.
  ...
  if (TrySpin (Self) > 0) {
    ...
    return;
  }
  ...
  ObjectWaiter node(Self);
  Self->_ParkEvent->reset();
  node._prev   = (ObjectWaiter *) 0xBAD;
  node.TState  = ObjectWaiter::TS_CXQ;

  // Push "Self" onto the front of the _cxq.
  ...
  ObjectWaiter * nxt;
  for (;;) {
    node._next = nxt = _cxq;
    if (Atomic::cmpxchg(&node, &_cxq, nxt) == nxt) break;

    // Interference - the CAS failed because _cxq changed.  Just retry.
    // As an optional optimization we retry the lock.
    if (TryLock (Self) > 0) {
      ...
      return;
    }
  }
```

- **TryLock(TATAS)**(:448): test-and-test-and-set 再试一次;
- **TrySpin**(:464): 入队前的自旋(02 篇的 _Spinner 在这里干活;自旋上限 `Knob_SpinLimit=5000`,objectMonitor.cpp:109);
- **封 ObjectWaiter 入队**(:485-493: node 创建 :485、TState 置 TS_CXQ :488),然后 **CAS push-to-front**(:494-497)——失败重试,重试间隙还顺手 TryLock 再抢一次(:501-505)。

入队后的等待交给 ParkEvent(底层 PlatformEvent → futex),期间有一个 **Responsible 机制**(:503-516 注释): 竞争持续时至少一个线程用**定时 park** 周期检查 _owner——防止"锁已空但大家都睡着"的 stranding(注释原话: "at least one of the contended threads will periodically poll _owner")。

## 2. exit: 掉锁、看队列、选一个唤醒

### 掉锁与"简单/复杂出口"

`ObjectMonitor::exit`(objectMonitor.cpp:905 起): 重入退出直接 `_recursions--` 返回(:925-930);非重入走出口协议——先 `release_store(&_owner, NULL)` 掉锁(:967),再 `storeload`,然后**看 `_EntryList|_cxq` 与 `_succ`**(:968):

- **两者皆空或已有 succ** → **简单出口**,直接返回——锁空着,没人等,或者已经有人被预定为继承人;
- **有人在等且无 succ** → **复杂出口**——但只有 owner 能碰 EntryList/cxq,所以要先 **reacquire _owner**(:990-998,`Atomic::replace_if_null(THREAD, &_owner)`),失败就把"叫醒后继者"的责任交给新 owner。

### _succ: 减少"无谓唤醒"的继承人

_exit 的注释把 _succ 的来历讲得清楚(objectMonitor.cpp:978-997,截取核心,逐字):

```cpp
// objectMonitor.cpp:978-998(截取核心,逐字)
      // The _succ variable is critical to reducing futile wakeup frequency.
      // _succ identifies the "heir presumptive" thread that has been made
      // ready (unparked) but that has not yet run.  We need only one such
      // successor thread to guarantee progress.
      // See http://www.usenix.org/events/jvm01/full_papers/dice/dice.pdf
      // section 3.3 "Futile Wakeup Throttling" for details.
      //
      // Note that spinners in Enter() also set _succ non-null.
      // _succ so that exiting threads might avoid waking a successor.
```

只唤醒一个"推定继承人"而不是 wake-all——wake-all 里只有一个能拿到锁,其余被唤醒后发现锁被占又回去睡,就是"惊群"(thundering herd)。_succ 非空时,退出的线程甚至可以**不唤醒任何人就走**(责任已经转移)。

### 唤醒: ExitEpilog 的四步协议

复杂出口按 `Knob_QMode` 挑人: QMode 2 直接唤醒 cxq 头;QMode 3/4 先把 **cxq 整段 drain 进 EntryList**(detach _cxq → TState 转 TS_ENTER → append 到 EntryList 尾,:1067-1115 的 bulk transfer)。最后都汇聚到 `ExitEpilog`(objectMonitor.cpp:1282-1314,截取核心,逐字):

```cpp
// objectMonitor.cpp:1282-1314(截取核心,逐字)
void ObjectMonitor::ExitEpilog(Thread * Self, ObjectWaiter * Wakee) {
  assert(_owner == Self, "invariant");

  // Exit protocol:
  // 1. ST _succ = wakee
  // 2. membar #loadstore|#storestore;
  // 2. ST _owner = NULL
  // 3. unpark(wakee)

  _succ = Knob_SuccEnabled ? Wakee->_thread : NULL;
  ParkEvent * Trigger = Wakee->_event;

  // Hygiene -- once we've set _owner = NULL we can't safely dereference Wakee again.
  // The thread associated with Wakee may have grabbed the lock and "Wakee" may be
  // out-of-scope (non-extant).
  Wakee  = NULL;

  // Drop the lock
  OrderAccess::release_store(&_owner, (void*)NULL);
  OrderAccess::fence();                               // ST _owner vs LD in unpark()

  ...
  Trigger->unpark();
```

协议四步(注释 :1288-1291): 置 `_succ = wakee` → 屏障 → `_owner = NULL` → `unpark(wakee)`。被唤醒的线程醒来后 `cmpxchg _owner` 抢锁,抢到就清 _succ 成为新 owner;抢不到(有别人插队)回到 EnterI 重新排队——"成功与否由 CAS 说了算"。

## 3. wait/notify: 队列间的流转

### wait: 放弃锁,排队睡觉

`wait`(objectMonitor.cpp:1426 起): 在 `_WaitSetLock`(自旋锁)保护下 `AddWaiter` 把自己挂进 **WaitSet**(:1483-1484),**保存 _recursions**(:1490)后 `exit` 掉锁(:1493)、`park()` 睡下。醒来后不是直接拿锁——**回到 EntryList 重新排队竞争**(和 01/02 篇的 enter 路径汇合),最后恢复 _recursions。注释里的关键点: park 前必须 reset 事件再检查竞争(防"先 notify 后 park 丢失唤醒")。

### notify: 只搬队列,不立即唤醒

`notify`(objectMonitor.cpp:1776-1786): CHECK_OWNER → `INotify`(:1659 起)——从 WaitSet 取出第一个 waiter(DequeueWaiter),按 `Knob_MoveNotifyee` 策略处理(:1660;默认 =2,objectMonitor.cpp:135): **默认把 waiter 从 TS_WAIT 转到 TS_CXQ 并 CAS 进 cxq**(:1715-1726);policy 0/1 才进 EntryList(prepend/append,TS_ENTER,:1673-1714);policy 4 直接 unpark(:1742-1747)。**notify 本身不 unpark(默认策略下)**——真正的唤醒在持锁线程 exit 时才发生,被 notify 的线程醒来时锁往往已经空闲,可以直接拿(避免"醒来→锁被占→再睡"的浪费)。`notifyAll`(:1795)就是循环 INotify 直到 WaitSet 空。

**关键设计 (斜体)**: *这套协议的两个主题是"省"与"防": 省——自旋与 _succ 继承把"无谓唤醒"压到最低,只有锁空转需要内核;防——_count 防 deflate、Responsible 定时 park 防 stranding、park 前 reset 防丢唤醒。wait/notify 的移动路径是 WaitSet →(INotify,默认进 cxq)→(exit 的 drain)→ EntryList →(ExitEpilog unpark)→(enter CAS)→ owner,一条闭环。*

## 核心悬念

协议到齐: enter 三条快路径(空闲 CAS/重入/栈锁转移)+ 慢路径(_count 防 deflate、EnterI 的 TryLock→TrySpin→cxq CAS 入队、Responsible 防 stranding);exit 的简单/复杂出口(_succ 非空即可甩手)、QMode 的 cxq 优先或批量 drain、ExitEpilog 四步协议(置 succ → 屏障 → 掉锁 → unpark);wait 保存递归挂 WaitSet、notify 只搬队列不唤醒、notifyAll 循环搬空。但这一整套是 **Java 层的锁**——JVM 自己的代码用的 Mutex/Monitor 是另一套: rank 系统、条件变量 wait、safepoint 检查。下一篇: VM 内部锁。

> → [19-sync/04 — VM 内部锁](04-internal-locks.md)
