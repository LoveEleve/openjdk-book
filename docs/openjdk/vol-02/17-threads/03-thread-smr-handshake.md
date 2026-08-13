# 03. 线程退出了,别人怎么不 crash?— Thread-SMR 与 Handshake

> **前置依赖**:[17-threads/02 — JavaThread 状态机](openjdk/vol-02/17-threads/02-javathread-state.md):`smr_delete` 的尾巴在这里展开;[17-threads/01 — Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):Thread 基类里那组 hazard pointer 字段是这一篇的主角;[01-os/04 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md):safepoint 是 Handshake 的对照物
> → **后续**:[17-threads/04 — interfaceSupport](04-interface-support.md)(线程状态转换的 RAII 守卫)
> 关联域: 01-os(同步原语)、17-threads(线程)、20-vmops(VMThread 执行)、28-jvmti(Handshake 的消费者)

## 线程 B 退出了,线程 A 手里的指针怎么办

JVMTI agent 调 `GetThreadInfo(jthread)`: 拿到 JavaThread\* 后要读它的字段——但目标线程可能此刻正在退出,`JavaThread::exit` 之后对象随时会被 delete。直接解引用就是 use-after-free。JVM 的答案是 Thread-SMR(Safe Memory Reclamation): 用**不可变的 ThreadsList 快照 + 每线程 hazard pointer** 保护"我在用这个线程",删除方等所有保护解除才真删。这一篇拆 Thread-SMR 的读侧(无锁快路径)与写侧(延迟删除),再讲它的小弟 Handshake——只让一个线程执行闭包的轻量机制。

## 1. 读侧: ThreadsList 与 hazard pointer

### 保护的是什么: 不可变的 ThreadsList

所有 Java 线程的"名单"不是链表,而是一串**不可变版本**: `ThreadsList`(threadSMR.hpp:158)——`_threads` 是指针数组(JavaThread\* 们),`_next_list` 串起旧版本。线程加入/退出时**不修改旧表,而是造一个新版本**,用 xchg 换下全局指针 `_java_thread_list`(threadSMR.hpp:108),旧版本进 `_to_delete_list`(:116)等待回收。读者只要持有某个版本的引用,这个版本里的 JavaThread\* 就全部受保护——快照不可变,旧版本在回收前不会被破坏。

### ThreadsListHandle: 构造即保护,析构即释放

读者侧的 RAII 是 `ThreadsListHandle`(threadSMR.hpp:272,不是流传说的 :37-84——那是文件头注释里的用法示例),它包着一个 `SafeThreadsListPtr`(:200): "一个指向 ThreadsList 的安全指针——叶子场景用稳定 hazard ptr,嵌套场景用引用计数"(注释原话 :198-200)。用法就是开篇 JVMTI 那个场景: `ThreadsListHandle tlh;` 在作用域内拿 `tlh.list()` 找线程,析构时释放。

### 无锁快路径: 发布、校验、去 tag

`acquire_stable_list_fast_path`(threadSMR.cpp:384-427)是读侧核心(截取核心,逐字):

```cpp
// threadSMR.cpp:395-422(截取核心,逐字)
  while (true) {
    threads = ThreadsSMRSupport::get_java_thread_list();

    // Publish a tagged hazard ptr to denote that the hazard ptr is not
    // yet verified as being stable. Due to the fence after the hazard
    // ptr write, it will be sequentially consistent w.r.t. the
    // sequentially consistent writes of the ThreadsList, even on
    // non-multiple copy atomic machines where stores can be observed
    // in different order from different observer threads.
    ThreadsList* unverified_threads = Thread::tag_hazard_ptr(threads);
    _thread->set_threads_hazard_ptr(unverified_threads);

    // If _smr_java_thread_list has changed, we have lost a race with
    // Threads::add() or Threads::remove() and have to try again.
    if (ThreadsSMRSupport::get_java_thread_list() != threads) {
      continue;
    }

    // We try to remove the tag which will verify the hazard ptr as
    // being stable. This exchange can race with a scanning thread
    // which might invalidate the tagged hazard ptr to keep it from
    // being followed to access JavaThread ptrs. If we lose the race,
    // we simply retry. If we win the race, then the stable hazard
    // ptr is officially published.
    if (_thread->cmpxchg_threads_hazard_ptr(threads, unverified_threads) == unverified_threads) {
      break;
    }
  }
```

三步:

1. **发布 tagged hazard ptr**(:402-403): 先把自己读到的 ThreadsList\* **打上 tag**(低位标记"未验证")写进线程本地字段——扫描方看到 tagged 就知道"这个读者还没完成发布",会尝试把它作废(见下);
2. **重读校验**(:408-411): 再读一次全局 `_java_thread_list`,若已变化说明刚好有线程进出,重试;
3. **cmpxchg 去 tag**(:416-421): 把 tagged 指针换成 untagged——CAS 成功则稳定 hazard ptr 正式发布(删除方看到 untagged 就知道"它已确认在用,不能回收");CAS 失败说明扫描线程恰好来检查过(它会把 tagged 指针当作无效),重试。

全程无锁,每轮只有两次读 + 一次 CAS。tag 技巧本身在 Thread 基类(thread.hpp:162-170): `tag_hazard_ptr(list) = list | 1`、`untag = list & ~1`——**ThreadsList 对象按指针宽度对齐,最低位恒为 0**,白捡一位做标记,不占任何额外内存。

**关键设计 (斜体)**: *tagged→untagged 的两阶段发布是快路径的核心,语义要看清: tagged("未验证")在扫描方眼里是可以作废的中间态——扫描方会尝试用 CAS 把它换成 NULL,让这个读者重试;untagged("稳定")才是正式受保护的状态,扫描方会把表里的线程全部视为不可回收。读者用 cmpxchg 抢在扫描方前面完成去 tag——CAS 竞争的结果决定"谁重试",而读路径始终没有锁、没有等待。*

## 2. 写侧: smr_delete 与双检查唤醒

### to_delete_list 装的是旧快照,不是线程

先澄清一个流传说法: `_to_delete_list`(threadSMR.hpp:116)装的是**旧 ThreadsList 快照**,不是退出的线程对象。线程的回收走 `smr_delete`(threadSMR.cpp:944-1010,截取核心,逐字):

```cpp
// threadSMR.cpp:953-1009(截取核心,逐字)
  while (true) {
    {
      // No safepoint check because this JavaThread is not on the
      // Threads list.
      MutexLockerEx ml(Threads_lock, Mutex::_no_safepoint_check_flag);
      // Cannot use a MonitorLockerEx helper here because we have
      // to drop the Threads_lock first if we wait.
      ThreadsSMRSupport::delete_lock()->lock_without_safepoint_check();
      // Set the delete_notify flag after we grab delete_lock
      // and before we scan hazard ptrs because we're doing
      // double-check locking in release_stable_list().
      ThreadsSMRSupport::set_delete_notify();

      if (!is_a_protected_JavaThread(thread)) {
        // This is the common case.
        ThreadsSMRSupport::clear_delete_notify();
        ThreadsSMRSupport::delete_lock()->unlock();
        break;
      }
      ...
    } // We have to drop the Threads_lock to wait or delete the thread
    ...
    // Wait for a release_stable_list() call before we check again. No
    // safepoint check, no timeout, and not as suspend equivalent flag
    // because this JavaThread is not on the Threads list.
    ThreadsSMRSupport::delete_lock()->wait(Mutex::_no_safepoint_check_flag, 0,
                                     !Mutex::_as_suspend_equivalent_flag);
    ...
    ThreadsSMRSupport::clear_delete_notify();
    ThreadsSMRSupport::delete_lock()->unlock();
    // Retry the whole scenario.
  }

  delete thread;
```

- 拿 `delete_lock` 后先 `set_delete_notify()`(:964,实现是 `Atomic::inc` 计数,threadSMR.cpp:937-939);
- **`is_a_protected_JavaThread(thread)`(:966)**: 扫所有线程的 hazard ptr,看有没有人保护这个退出线程——没人保护(常见情形)→ 直接 break → `delete thread`(:1006);
- 有人保护 → 在 delete_lock 上 wait(:993-997,注释: "Wait for a release_stable_list() call before we check again"),等持有者释放后重试。

### 读侧释放时的双检查

读者析构释放 hazard ptr 时(release_stable_list,threadSMR.cpp:471 起;双检查在 :500-509): **先无锁读 `delete_notify` 标志,false 就直接返回**——大多数情况下没有线程在等删除,一条 load 完事;只有 true(有线程在 smr_delete 里等)才去争 delete_lock 唤醒。这就是双检查锁定的用途: 把"每次 ThreadsListHandle 析构都争锁"降级为"标志置位才争锁"。

**关键设计 (斜体)**: *删除方与读者的协议是"轮询保护,主动让路": 读者发布/清除 hazard ptr 都不碰删除方;删除方扫 hazard ptr 发现保护就睡,读者释放时用 delete_notify 标志决定要不要唤醒。快路径(读者无锁、删除方一次扫描通过)是常态,等待是罕见路径——这正是 hazard pointer 相对引用计数的地方: 读者永远不付原子操作的代价。*

## 3. Handshake: 只让一个线程干活

### 轻量替代: 单线程闭包

safepoint 停全世界;Handshake 只让**一个目标线程**在安全状态下执行一段回调(`HandshakeClosure::do_thread`,handshake.hpp:36-45)。用途如 JVMTI 单步、线程栈采样。每线程一个 `HandshakeState`(handshake.hpp:55-101): `_operation`(volatile,挂起的闭包,:57)+ `_semaphore`(VM 线程与目标线程的协调器,:59)+ `_thread_in_process_handshake`(防重入,:60)。

### 两条执行路径

- **目标线程自己做**(process_by_self → process_self_inner,handshake.cpp:417-434,截取核心,逐字):

```cpp
// handshake.cpp:417-434(截取核心,逐字)
void HandshakeState::process_self_inner(JavaThread* thread) {
  assert(Thread::current() == thread, "should call from thread");
  assert(!thread->is_terminated(), "should not be a terminated thread");

  ThreadInVMForHandshake tivm(thread);
  if (!_semaphore.trywait()) {
    _semaphore.wait_with_safepoint_check(thread);
  }
  HandshakeOperation* op = OrderAccess::load_acquire(&_operation);
  if (op != NULL) {
    HandleMark hm(thread);
    CautiouslyPreserveExceptionMark pem(thread);
    // Disarm before execute the operation
    clear_handshake(thread);
    op->do_handshake(thread);
  }
  _semaphore.signal();
}
```

线程在下一个安全点(self 路径)自己执行: 先抢占信号量(`trywait`,失败说明 VM 线程正在处理,就 `wait_with_safepoint_check` 等它),然后 `load_acquire` 取闭包,**先 `clear_handshake` 卸下武装再执行**(:430——先清后做,防止执行期间再来新请求),最后 `signal` 放行;

- **VM 线程代办**(try_process_by_vmThread,handshake.cpp:481-516): 检查 `has_operation`(:486,没有就 `_no_operation`)→ `possibly_vmthread_can_process_handshake`(:491,目标线程不在安全状态就 `_not_safe`,让它自己发现)→ **`claim_handshake_for_vmthread`(:497,实现是 `_semaphore.trywait()` + 复查,handshake.cpp:470-479——流传的"CAS 独占"是错的,信号量抢占才是真相)** → 确认安全后 `do_handshake`(:508)→ `clear_handshake`(:510)→ `_success` → `signal`。

`Handshake::execute`(handshake.cpp:381-389)在 ThreadLocalHandshakes 下走 `VM_HandshakeAllThreads`(VM 操作,等所有线程处理),否则回退旧机制——全局 handshake 与单线程 handshake 共用同一套状态机。

**关键设计 (斜体)**: *Handshake 与 safepoint 的分工是"粒度"：safepoint 保证"所有线程都不动"(GC 需要);Handshake 保证"这个线程现在安全"(JVMTI 单步只需要它)。信号量既是互斥(VM 线程与目标线程不会同时执行闭包)又是通知(谁赢了谁干活,输家等待)——一个原语两个职责。*

## 核心悬念

Thread-SMR 与 Handshake 到齐: 读侧用不可变 ThreadsList + tagged hazard ptr 两阶段发布实现无锁保护(CAS 去 tag 即确认);写侧 smr_delete 扫保护、被保护就睡,读者释放时用 delete_notify 双检查决定是否唤醒;to_delete_list 装的是旧快照而非线程。Handshake 用每线程 HandshakeState + 信号量协调"目标线程自办"与"VM 线程代办"两条路径。但你大概注意到了两处一闪而过的 RAII: `ThreadsListHandle tlh` 与 `ThreadInVMForHandshake tivm`——构造/析构自动完成状态登记与释放。下一篇: interfaceSupport——这些状态转换守卫是怎么搭的。

> → [17-threads/04 — interfaceSupport](04-interface-support.md)
