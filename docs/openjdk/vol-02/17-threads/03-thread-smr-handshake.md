# 03. 线程退出了,别人怎么不 crash?— Thread-SMR 与 Handshake

> **前置依赖**:[17-threads/02 — JavaThread 状态机](openjdk/vol-02/17-threads/02-javathread-state.md):`smr_delete` 的尾巴在这里展开;[17-threads/01 — Thread 层次体系](openjdk/vol-02/17-threads/01-thread-hierarchy.md):Thread 基类里那组 hazard pointer 字段是这一篇的主角;[01-os/04 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md):safepoint 是 Handshake 的对照物
> → **后续**:[17-threads/04 — interfaceSupport](04-interface-support.md)(线程状态转换的 RAII 守卫)
> 关联域: 01-os(同步原语)、17-threads(线程)、20-vmops(VMThread 执行)、28-jvmti(Handshake 的消费者)

JVMTI agent 调 `GetThreadInfo(jthread)`：拿到 `JavaThread*` 后要读它的字段——但目标线程可能此刻正在退出,`JavaThread::exit` 之后对象随时会被 delete。直接解引用就是 use-after-free。

JVM 的答案是 Thread-SMR(Safe Memory Reclamation): 用**不可变的 ThreadsList 快照 + 每线程 hazard pointer** 保护“我在用这个线程”，删除方等所有保护解除才真删。这一篇拆 Thread-SMR 的读侧(无锁快路径)与写侧(延迟删除)，再讲它的小弟 Handshake——只让一个线程执行闭包的轻量机制。

---

## 1. 先试两个最自然的理解，看看为什么都不对

### 误解一：ThreadsList 就是一条加锁链表

如果 `Threads::list` 只是普通链表，那解决 use-after-free 的最直观办法就是：

- 读侧拿锁，遍历链表；
- 写侧删线程前拿同一把锁；
- 解引用时一直握着锁。

这当然能工作，但代价太高。线程枚举、JVMTI、栈遍历、监控接口都会频繁读线程列表。如果读侧每次都和写侧争 `Threads_lock`，整个 JVM 的线程观察路径会被硬串行化。

所以 Thread-SMR 的目标不是“加锁保证安全”，而是**让读侧几乎无锁，只让写侧承担等待成本**。

### 误解二：Handshake 只是缩小版 safepoint

Handshake 和 safepoint 都会“让线程停到安全位置”，所以很容易被理解成“Handshake = 只停一个线程的小 safepoint”。

但两者的粒度和协议完全不同：

- **safepoint** 的目标是“所有 JavaThread 都停住”，为 GC、deopt、全局 VM 操作让路；
- **Handshake** 的目标是“这个目标线程现在安全，可以执行一个闭包”，用于 JVMTI 单步、线程栈采样等局部动作。

它不是小号停世界，而是**单线程安全回调协议**。

---

## 2. 读侧：`ThreadsList` 与 hazard pointer

### 保护的是什么：不可变 `ThreadsList`

所有 Java 线程的“名单”不是链表,而是一串**不可变版本**：`ThreadsList`(threadSMR.hpp:158 起)——`_threads` 是指针数组(JavaThread* 们),`_next_list` 串起旧版本。线程加入/退出时**不修改旧表,而是造一个新版本**,用 xchg 换下全局指针 `_java_thread_list`，旧版本进 `_to_delete_list` 等待回收。`threadSMR.hpp:88-116`、`:158-373`

所以 `ThreadsListHandle` 真正保护的，不是“某个单独 JavaThread”，而是**我当前正在看的这份快照版本**。只要这份快照活着，里面所有 `JavaThread*` 都是稳定的。

### `ThreadsListHandle`：构造即保护,析构即释放

读者侧的 RAII 是 `ThreadsListHandle`。它包着一个 `SafeThreadsListPtr`：一个指向 `ThreadsList` 的安全指针——叶子场景用稳定 hazard ptr,嵌套场景用引用计数。也就是说，看上去是同一个 `ThreadsListHandle` API，内部其实有两种保护策略；用法就是开篇 JVMTI 那个场景：

- 作用域开始 `ThreadsListHandle tlh;`
- 在作用域内拿 `tlh.list()` 找线程；
- 析构时释放保护。

### 无锁快路径：发布 tagged hazard ptr → 重读校验 → CAS 去 tag

`acquire_stable_list_fast_path`(threadSMR.cpp:384-427)是读侧核心：

```cpp
// threadSMR.cpp:395-422(截取核心,逐字)
while (true) {
  threads = ThreadsSMRSupport::get_java_thread_list();

  ThreadsList* unverified_threads = Thread::tag_hazard_ptr(threads);
  _thread->set_threads_hazard_ptr(unverified_threads);

  if (ThreadsSMRSupport::get_java_thread_list() != threads) {
    continue;
  }

  if (_thread->cmpxchg_threads_hazard_ptr(threads, unverified_threads) == unverified_threads) {
    break;
  }
}
```

三步:

1. **发布 tagged hazard ptr**：先把读到的 `ThreadsList*` 打上 tag(最低位=1,表示“未验证”)，写进线程本地 hazard 字段；
2. **重读校验**：再读一次全局 `_java_thread_list`，如果期间版本变了，说明刚好撞上 add/remove，重试；
3. **CAS 去 tag**：把 tagged 指针换成 untagged——CAS 成功则稳定 hazard ptr 正式发布；失败说明扫描线程恰好来检查过，让读者重试。

这里最关键的是两阶段语义：

- **tagged** = “我可能在看它，但还没确认稳定”；扫描方可以把它作废；
- **untagged** = “我已确认正在使用它”；删除方必须视作受保护。

所以读侧快路径无锁、只有两次读 + 一次 CAS，就能完成一份线程快照的稳定发布。

---

## 3. 写侧：`smr_delete` 与 delete_notify 双检查唤醒

### `_to_delete_list` 装的是旧快照,不是线程

先澄清一个经常被讲错的点：`_to_delete_list` 装的是**旧 `ThreadsList` 快照版本**,不是退出的线程对象。线程对象的回收走 `JavaThread::smr_delete()` → `ThreadsSMRSupport::smr_delete(this)`。`thread.cpp:208-213`

### `smr_delete` 的协议

`smr_delete`(threadSMR.cpp:944-1010)的主循环是：

1. 拿 `ThreadsSMRDelete_lock`；
2. 先 `set_delete_notify()`；
3. 扫 hazard ptr，看目标线程是否仍被任何快照保护；
4. 如果没有人保护——常见路径，直接 break，最后 `delete thread`；
5. 如果有人保护——在 delete_lock 上 wait，等读者释放后重试。

核心代码:

```cpp
// threadSMR.cpp:953-1009(截取核心,逐字)
while (true) {
  {
    MutexLockerEx ml(Threads_lock, Mutex::_no_safepoint_check_flag);
    ThreadsSMRSupport::delete_lock()->lock_without_safepoint_check();
    ThreadsSMRSupport::set_delete_notify();

    if (!is_a_protected_JavaThread(thread)) {
      ThreadsSMRSupport::clear_delete_notify();
      ThreadsSMRSupport::delete_lock()->unlock();
      break;
    }
    ...
  }
  ThreadsSMRSupport::delete_lock()->wait(...);
  ...
}

delete thread;
```

这说明写侧真正慢的地方不是“删除线程对象”本身，而是**等待所有读者放下手里的快照版本**。

### 读者释放时的双检查

读者析构释放 hazard ptr 时(`release_stable_list`)，会先无锁读 `delete_notify` 计数：

- **0**：说明没人等删除，直接返回；
- **非 0**：说明有线程在 `smr_delete` 里等，才去争 `delete_lock` 并唤醒删除方。

这里的 `delete_notify` 不是单纯的布尔位，而是允许多个删除等待周期共享的计数器协议。双检查锁定的意义就是：把“每次 ThreadsListHandle 析构都争锁”降级为“真的有人在等删除时才争锁”。

所以写侧协议可以压成一句话：**删除方轮询 hazard ptr，看见保护就睡；读者释放时只在必要时唤醒。**

---

## 4. Handshake：只让一个线程干活

### 轻量替代：单线程闭包

safepoint 停全世界；Handshake 只让**一个目标线程**在安全状态下执行一段回调(`HandshakeClosure::do_thread`)。用途如 JVMTI 单步、线程栈采样。每线程一个 `HandshakeState`：

- `_operation`：挂起的闭包；
- `_semaphore`：VMThread 与目标线程的协调器；
- `_thread_in_process_handshake`：防重入。

### 两条执行路径

**路径一：目标线程自己做**

`process_by_self → process_self_inner`(handshake.cpp:417-434)：

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
    clear_handshake(thread);
    op->do_handshake(thread);
  }
  _semaphore.signal();
}
```

目标线程在下一个安全点自己执行：它通常是在线程本地轮询或相关 `SafepointMechanism::process` 路径里发现自己有 handshake 待处理，然后先抢信号量，拿到 `_operation` 后**先 `clear_handshake` 卸下武装，再执行闭包**，最后 signal 放行。

**路径二：VMThread 代办**

`try_process_by_vmThread`(handshake.cpp:481-516)：

- 没有 operation → `_no_operation`
- `possibly_vmthread_can_process_handshake` 先做保守检查
- `claim_handshake_for_vmthread` 用 `_semaphore.trywait()` 抢占代办权
- `vmthread_can_process_handshake` 再确认安全后 `do_handshake`
- `clear_handshake`
- `signal`

所以 Handshake 的关键不是“谁来跑闭包”，而是：**谁先抢到信号量，谁来安全执行这段单线程工作。**

### 与 safepoint 的关系

`Handshake::execute` 在 `ThreadLocalHandshakes` 开启时走 `VM_HandshakeAllThreads`，否则回退旧机制。它和 safepoint 的分工是粒度：

- safepoint 保证“所有线程都不动”；
- handshake 保证“这个线程现在安全”。

所以 Handshake 不是“小号停世界”，而是**单线程可证明安全的执行协议**。

---

## 5. 误解澄清与收网

1. **ThreadsList 是普通链表吗?** 不是。读侧看到的是不可变快照版本。
2. **`_to_delete_list` 装的是退出线程吗?** 不是。它装的是旧 `ThreadsList` 版本；线程对象回收走 `smr_delete`。
3. **hazard pointer 只是“有个指针放那儿”吗?** 不是。tagged → untagged 是两阶段发布协议，CAS 竞争决定读者还是扫描方重试。
4. **Handshake 就是小号 safepoint 吗?** 不是。它只要求一个目标线程安全执行闭包。
5. **VMThread 和目标线程会不会同时执行同一 handshake 闭包?** 不会。信号量是互斥和通知的统一协调器。

把这一篇压成三句话：

- **Thread-SMR 的核心是不可变 `ThreadsList` 快照 + per-thread hazard pointer**，让读侧无锁、写侧延迟删除。
- **`smr_delete` 等的不是“线程退出完成”，而是“所有读者放下手里的快照版本”。**
- **Handshake 是单线程安全回调协议，不是缩小版 safepoint。**

下一篇: `interfaceSupport`——这些状态转换守卫（`ThreadInVMfromNative`、`ThreadBlockInVM` 等）是怎么搭的。

> → [17-threads/04 — interfaceSupport](04-interface-support.md)