# 01. synchronized 三步曲 — biased→BasicLock→ObjectMonitor

> **前置依赖**:[06-oops/01 — 对象头](openjdk/vol-02/06-oops/01-markoop-oopdesc.md):markOop 的锁位编码(locked_value=0/unlocked_value=1/monitor_value=2/biased_lock_pattern=5)已在那篇讲透,这篇承接它的生命周期;[17-threads/01 — Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):Thread 基类里的 omFreeList/omInUseList 是 ObjectMonitor 的每线程缓存
> → **后续**:[19-synchronization/02 — ObjectMonitor 结构](02-objectmonitor-structure.md)(重量级锁内部)
> 关联域: 06-oops(对象头)、19-synchronization(锁)、17-threads(线程)、01-os(原子指令)

## 同一把锁,三种身份

`synchronized(obj)` 编译成 `monitorenter`/`monitorexit` 两条字节码。但 JVM 不会一成不变地做重量级锁——**同一把锁会随着竞争程度在三种实现之间演化**: 单线程反复进入时是**偏向锁**(零开销),偶发竞争时是**栈上轻量锁**(一条 cmpxchg),真打起来才**膨胀成 ObjectMonitor**(重量级)。这一篇拆前两级: 对象头 3 bit 怎么说状态、偏向锁的撤销与批量重偏向、以及栈上 BasicLock 的进出。

## 1. 对象头 3 bit 与锁的生命周期

### 承接 06-01: 锁位怎么编码

对象头的锁状态编码在 06-01 已经讲透(locked_value=0/unlocked_value=1/monitor_value=2/biased_lock_pattern=5,高位的 biased_lock 位与 lock 位联合)。这里只补**生命周期**: 演化是单向的——

```
unlocked → biased → BasicLock → ObjectMonitor
                        ↑                |
                        └── deflate ←────┘
```

只有 GC 在 safepoint 的 **deflate** 是降级: ObjectMonitor 回收后对象头直接回到 unlocked(不退回 BasicLock)。调度的入口是 `ObjectSynchronizer::fast_enter`(synchronizer.cpp:264-280,截取核心,逐字):

```cpp
// synchronizer.cpp:264-280(截取核心,逐字)
void ObjectSynchronizer::fast_enter(Handle obj, BasicLock* lock,
                                    bool attempt_rebias, TRAPS) {
  if (UseBiasedLocking) {
    if (!SafepointSynchronize::is_at_safepoint()) {
      BiasedLocking::Condition cond = BiasedLocking::revoke_and_rebias(obj, attempt_rebias, THREAD);
      if (cond == BiasedLocking::BIAS_REVOKED_AND_REBIASED) {
        return;
      }
    } else {
      assert(!attempt_rebias, "can not rebias toward VM thread");
      BiasedLocking::revoke_at_safepoint(obj);
    }
    assert(!obj->mark()->has_bias_pattern(), "biases should be revoked by now");
  }

  slow_enter(obj, lock, THREAD);
}
```

逻辑是**分层退让**: 偏向锁可撤销并重偏向成功(BIAS_REVOKED_AND_REBIASED)→ 完事;否则清掉偏向 → `slow_enter`(BasicLock 路径);safepoint 里则 `revoke_at_safepoint`。

## 2. BiasedLocking: 偏向、撤销与批量重偏向

### 撤销的 CAS 快路径

`revoke_and_rebias`(biasedLocking.cpp:624 起)先试几个**不需要 safepoint**的快路径(截取核心,逐字):

```cpp
// biasedLocking.cpp:624-668(截取核心,逐字)
BiasedLocking::Condition BiasedLocking::revoke_and_rebias(Handle obj, bool attempt_rebias, TRAPS) {
  assert(!SafepointSynchronize::is_at_safepoint(), "must not be called while at safepoint");

  // We can revoke the biases of anonymously-biased objects
  // efficiently enough that we should not cause these revocations to
  // update the heuristics because doing so may cause unwanted bulk
  // revocations (which are expensive) to occur.
  markOop mark = obj->mark();
  if (mark->is_biased_anonymously() && !attempt_rebias) {
    // We are probably trying to revoke the bias of this object due to
    // an identity hash code computation. Try to revoke the bias
    // without a safepoint. This is possible if we can successfully
    // compare-and-exchange an unbiased header into the mark word of
    // the object, meaning that no other thread has raced to acquire
    // the bias of the object.
    markOop biased_value       = mark;
    markOop unbiased_prototype = markOopDesc::prototype()->set_age(mark->age());
    markOop res_mark = obj->cas_set_mark(unbiased_prototype, mark);
    if (res_mark == biased_value) {
      return BIAS_REVOKED;
    }
  } else if (mark->has_bias_pattern()) {
    Klass* k = obj->klass();
    markOop prototype_header = k->prototype_header();
    if (!prototype_header->has_bias_pattern()) {
      // This object has a stale bias from before the bulk revocation
      // for this data type occurred. It's pointless to update the
      // heuristics at this point so simply update the header with a
      // CAS. If we fail this race, the object's bias has been revoked
      // by another thread so we simply return and let the caller deal
      // with it.
      markOop biased_value       = mark;
      markOop res_mark = obj->cas_set_mark(prototype_header, mark);
      assert(!obj->mark()->has_bias_pattern(), "even if we raced, should still be revoked");
      return BIAS_REVOKED;
    } else if (prototype_header->bias_epoch() != mark->bias_epoch()) {
      ...
```

- **匿名偏向**(:633-642): 对象被偏向过但持有者还没跑(线程 id 为空)——直接 CAS 换回无偏向原型,一次原子操作完事;
- **类原型已无偏向**(:647-660): 说明这个类经历过 bulk revocation,对象头的偏向是"过期残留"——CAS 换回类原型即撤销;
- **epoch 过期**(:664 起): 类的 epoch 递增过(批量重偏向),这个对象的偏向在下次检查时失效——按 attempt_rebias 决定重偏向给自己或直接撤销,同样是 CAS 快路径。

### 快路径走不通: heuristics 与 safepoint

CAS 都失败才进 `update_heuristics`(:321): 撤销次数记在 **Klass 上**(`_biased_lock_revocation_count`,:353-362),两个阈值驱动批量操作——**`BiasedLockingBulkRebiasThreshold=20`**(globals.hpp:978)与 **`BiasedLockingBulkRevokeThreshold=40`**(:984): 同类的偏向锁撤销超过 20 次 → epoch+1 触发**批量重偏向**;超过 40 次 → 批量撤销(类原型清除偏向位,以后这类对象不再偏向)。HR_SINGLE_REVOKE 时若能走"偏向自己的栈"(revoke 自己的偏向)也可以无 safepoint;否则需要 **safepoint 暂停对方线程检查它的栈**——因为撤销时要确认"它是否还在临界区",非 safepoint 读别的线程的栈不安全。

**关键设计 (斜体)**: *偏向锁把"常态"变成零成本: 偏向的线程再次进入不需要任何原子操作——解释器汇编的 monitorenter 快路径直接比对 thread_id(biased_locking_enter,interp_masm_x86.cpp:1179)。撤销设计成"能 CAS 就 CAS,不能才进 safepoint"——匿名/过期/残留三类都可以无锁搞定,只有真有人在临界区里才需要停世界。批量阈值(20/40)把"这个类的偏向锁频繁被抢"识别出来,从逐个撤销升级为整类重偏向/撤销(epoch 递增,biasedLocking.cpp:409-411)。*

## 3. BasicLock: 栈上的轻量锁

### 进入: 一条 cmpxchg 换头

无偏向(或撤销后)走 `slow_enter`(synchronizer.cpp:339-371,截取核心,逐字):

```cpp
// synchronizer.cpp:339-371(截取核心,逐字)
void ObjectSynchronizer::slow_enter(Handle obj, BasicLock* lock, TRAPS) {
  markOop mark = obj->mark();
  assert(!mark->has_bias_pattern(), "should not see bias pattern here");

  if (mark->is_neutral()) {
    // Anticipate successful CAS -- the ST of the displaced mark must
    // be visible <= the ST performed by the CAS.
    lock->set_displaced_header(mark);
    if (mark == obj()->cas_set_mark((markOop) lock, mark)) {
      TEVENT(slow_enter: release stacklock);
      return;
    }
    // Fall through to inflate() ...
  } else if (mark->has_locker() &&
             THREAD->is_lock_owned((address)mark->locker())) {
    assert(lock != mark->locker(), "must not re-lock the same lock");
    assert(lock != (BasicLock*)obj->mark(), "don't relock with same BasicLock");
    lock->set_displaced_header(NULL);
    return;
  }

  // The object header will never be displaced to this lock,
  // so it does not matter what the value is, except that it
  // must be non-zero to avoid looking like a re-entrant lock,
  // and must not look locked either.
  lock->set_displaced_header(markOopDesc::unused_mark());
  ObjectSynchronizer::inflate(THREAD,
                              obj(),
                              inflate_cause_monitor_enter)->enter(THREAD);
}
```

- **无锁(中性)**: 先把原 mark 存进栈上的 `BasicLock`(`set_displaced_header`,:345),再 `cas_set_mark` 把对象头换成指向这个 BasicLock 的指针(:346)——**成功即拿锁**,一条 `lock cmpxchg`;
- **自己已经持有**(mark 指向自己的 locker): **递归进入**——`set_displaced_header(NULL)`(:355)标记递归,不做任何 CAS;
- 都不是 → 膨胀成 ObjectMonitor(:363-365)。

`BasicLock` 本身只是 `volatile markOop _displaced_header` 一个字段(basicLock.hpp:32-44)——**分配在解释器帧/编译栈上**(BasicObjectLock 嵌入帧,:55 起),不进堆,零 GC 开销。退出时 `fast_exit`(synchronizer.cpp:282-331): 递归(dhw==NULL)直接返回;正常 `cas_set_mark` 把 displaced header 换回对象头(:305-308);CAS 失败(膨胀进行中)→ inflate → ObjectMonitor::exit。

**关键设计 (斜体)**: *BasicLock 的"轻"来自两处: 锁状态全部编码在对象头+栈指针里(不建对象、不排队),拿锁退锁各一条 CAS;递归用 displaced_header=NULL 标记,零成本。它假设"竞争是偶发的"——一旦 CAS 失败说明有人抢,立刻 inflate,不恋战。*

## 核心悬念

前两级到齐: 对象头 3 bit 编码四种锁态(06-01 的布局 + 本篇的单向生命周期);fast_enter 分层退让(偏向可重偏向就返回,否则 slow_enter);BiasedLocking 的撤销三快路径(匿名/残留/epoch 过期全是 CAS)+ 20/40 批量阈值与 safepoint 撤销;BasicLock 栈锁一条 cmpxchg 进出、递归零成本。但 CAS 失败后的"重量级"还没露面: ObjectMonitor 内部——owner/EntryList/cxq/WaitSet 怎么组织、enter/exit/wait 怎么协调?下一篇: ObjectMonitor 结构。

> → [19-synchronization/02 — ObjectMonitor 结构](02-objectmonitor-structure.md)
