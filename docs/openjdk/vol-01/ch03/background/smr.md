# 前置概念：Thread-SMR —— 线程列表的安全并发访问

在阅读 `Thread::Thread()` 构造函数的最后几行（`thread.cpp:239-243`）时，会看到 5 个初始化为 0/NULL 的字段。它们全部服务于同一个目标：**让多个线程在不持有 `Threads_lock` 的情况下安全遍历全局线程列表**。

## 1. 问题：`ThreadsSMRSupport::_java_thread_list` 的并发困境

`threadSMR.hpp:108`：

```cpp
ThreadsList* volatile ThreadsSMRSupport::_java_thread_list = new ThreadsList(0);
```

这是 HotSpot 的全局 JavaThread 链表——所有存活的 `JavaThread` 对象都在上面。GC（`Threads::threads_do()`）、`jstack`（JVM/TI）、[JFR](https://bugs.openjdk.org/browse/JDK-8190298) 都需要遍历它。

JDK 8 的做法是**持 `Threads_lock` 遍历 `Threads::_thread_list`（`JavaThread*` 单向链表）**：读者和写者互斥——线程创建/退出拿着锁改链表时，遍历者全阻塞。JDK 11 的 `Threads::add()`（`thread.cpp:4463`）仍然把头插入这条链表，但在同一函数末尾（`thread.cpp:4482`）调用 `ThreadsSMRSupport::add_thread()`——从旧快照重建 `_java_thread_list`（`ThreadsList` 数组），作为 SMR 无锁遍历的只读快照。`_thread_list` 链表是增删的入口，`_java_thread_list` 是 SMR 便利读取的副本——两者不是两套独立的全局列表。

Thread-SMR（Safe Memory Reclamation）用**无锁读 + Copy-on-Write 写**解耦读者和写者。

---

## 2. ThreadsList：不可变快照

`threadSMR.hpp:158`：

```cpp
class ThreadsList : public CHeapObj<mtThread> {
  const uint _length;               // 线程数量
  ThreadsList* _next_list;          // 待删除链表下一块
  JavaThread *const *const _threads;  // JavaThread* 数组，不可修改
  volatile intx _nested_handle_cnt;   // 嵌套引用计数
};
```

`ThreadsList` 是一个 `JavaThread*` 的**不可变数组**。构造时从旧列表 `Copy::disjoint_words()` 拷贝所有指针，追加/移除目标线程后返回新列表——**永远不原地修改旧列表**。

核心操作是 `ThreadsList::add_thread()` 和 `ThreadsList::remove_thread()`：

```cpp
// threadSMR.cpp:562-574
ThreadsList *ThreadsList::add_thread(ThreadsList *list, JavaThread *java_thread) {
  ThreadsList *const new_list = new ThreadsList(list->_length + 1);
  Copy::disjoint_words(list->_threads, new_list->_threads, list->_length);  // 全拷贝
  new_list->_threads[list->_length] = java_thread;                           // 尾部追加
  return new_list;
}
```

`remove_thread()` 同理——拷贝旧列表的前半段和后半段，跳过目标线程。

### 2.1 原子替换全局指针

`threadSMR.cpp:743-758`：

```cpp
void ThreadsSMRSupport::add_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::add_thread(get_java_thread_list(), thread);
  ThreadsList *old_list = xchg_java_thread_list(new_list);  // Atomic::xchg
  free_list(old_list);  // 旧列表不立即删除，进入排队
}
```

新列表通过 `Atomic::xchg` 原子替换 `_java_thread_list`，旧列表进入 `_to_delete_list` 链表等待回收。读者拿到的是 `_java_thread_list` 的快照——即使写者同时在替换，读者已经持有一个 `ThreadsList*`，里面的 `JavaThread*` 指针仍然是有效的地址。

**问题来了**：旧列表里的 `JavaThread` 可能已经调用 `JavaThread::exit()` 退出——退出的线程需要 `delete` 掉 `JavaThread` 对象自身。如果读者手里的 `ThreadsList` 快照还指向那个线程，写者直接 `delete` 它——读者再通过 `thread_at(i)` 访问就悬空指针崩溃。

---

## 3. Hazard Pointer：告诉写者"别删"

hazard pointer 是一种**读者主动声明、写者被动等待**的无锁回收协议：

- **读者**在遍历前把 `ThreadsList*` 指针写入自己的 `_threads_hazard_ptr`。遍历完清零。
- **写者**在 `delete` 前扫描所有线程的 `_threads_hazard_ptr`，如果发现有人指着目标对象，就等——下一轮循环再检查。

在 HotSpot 里，`SafeThreadsListPtr` 封装了获取和释放的全流程。

### 3.1 acquire_stable_list（读者侧）

`threadSMR.cpp:366-380`：

```cpp
void SafeThreadsListPtr::acquire_stable_list() {
  _previous = _thread->_threads_list_ptr;        // 保存上一层
  _thread->_threads_list_ptr = this;              // 链入当前线程的 ptr 栈
  if (_thread->get_threads_hazard_ptr() == NULL) {
    acquire_stable_list_fast_path();              // 常见路径
  } else {
    acquire_stable_list_nested_path();            // 嵌套路径
  }
}
```

**快速路径** (`acquire_stable_list_fast_path`, `threadSMR.cpp:384-432`)：

```
① threads = get_java_thread_list()                               // 读全局指针
② unverified = tag_hazard_ptr(threads)                           // 打低位 tag
③ _thread->set_threads_hazard_ptr(unverified)                    // StoreStore 屏障
④ 检查 get_java_thread_list() 是否变了 → 变了就重试 ①
⑤ _thread->cmpxchg_threads_hazard_ptr(threads, unverified)       // 去掉 tag
   ├── 成功 → 发布完成，hazard_ptr = threads（已防死）
   └── 被其他扫描线程抢走 → 重试 ①
```

步骤 ③~⑤ 形成了一个两阶段发布协议（tag → untag）。步骤 ② 给指针最低 bit 打 1（tag），表示"还没验证这个快照是否稳定"——扫描线程看到 tag 会抢先把 `_threads_hazard_ptr` CAS 为 NULL，迫使读者重试，从而避免扫描到不一致的中间态。

tag/untag 实现（`thread.hpp:162-170`）：

```cpp
static bool is_hazard_ptr_tagged(ThreadsList* list) {
  return (intptr_t(list) & intptr_t(1)) == intptr_t(1);
}
static ThreadsList* tag_hazard_ptr(ThreadsList* list) {
  return (ThreadsList*)(intptr_t(list) | intptr_t(1));  // 利用 malloc 对齐（地址低 1 bit 必为 0）
}
```

**嵌套路径** (`acquire_stable_list_nested_path`, `threadSMR.cpp:437-467`)：当读者已经持有一个 `_threads_hazard_ptr`（外层 `ThreadsListHandle` 在作用域内）又在内部创建另一个时，不能两个 hazard_ptr 同时存在——协议只保证一个。于是外层用 `_nested_handle_cnt` **引用计数**替代：`current_list->inc_nested_handle_cnt()` 加计数，然后把自己的 `_threads_hazard_ptr` 清零，再走快速路径获取新的。

### 3.2 release_stable_list（读者侧释放）

`threadSMR.cpp:471-505`：

```cpp
void SafeThreadsListPtr::release_stable_list() {
  _thread->_threads_list_ptr = _previous;    // 弹栈
  if (_has_ref_count) {
    _list->dec_nested_handle_cnt();           // 减少引用计数
  } else {
    _thread->set_threads_hazard_ptr(NULL);    // 清零 hazard_ptr
  }
  if (ThreadsSMRSupport::delete_notify()) {
    release_stable_list_wake_up(_has_ref_count);  // 唤醒 smr_delete 里的等待者
  }
}
```

释放时执行双重检查锁：通过 `_delete_notify` 标志判断是否有线程在 `smr_delete` 里等待——无需每次都抢全局锁。

### 3.3 smr_delete（写者侧删除）

`threadSMR.cpp:944-1019`，线程退出后调用 `smr_delete(thread)`：

```
① 持 Threads_lock + delete_lock
② set_delete_notify()            // 此后的 release 会通知我
③ is_a_protected_JavaThread(thread)  // 扫描所有线程的 _threads_hazard_ptr
   ├── 无人指向 → 删除 thread，done
   └── 有人指向 → 
        drop Threads_lock
        delete_lock->wait()       // 阻塞等待通知
        收到通知 → 回到 ① 重试
```

`is_a_protected_JavaThread()` (`threadSMR.cpp:850-892`) 遍历所有线程的 `_threads_hazard_ptr`：如果某个线程的 hazard_ptr 指向的 `ThreadsList` 里包含目标 `JavaThread`，就返回 `true`——目标受保护，不能删。此外还会扫描 `_to_delete_list` 链表中 `_nested_handle_cnt != 0` 的列表——引用计数大于 0 表示有嵌套持有者。

---

## 4. 五个字段逐个解释

回到构造函数 `thread.cpp:239-243`：

```cpp
_oops_do_parity = 0;
_threads_hazard_ptr = NULL;
_threads_list_ptr = NULL;
_nested_threads_hazard_ptr_cnt = 0;
_rcu_counter = 0;
```

### 4.1 `int _oops_do_parity`（`thread.hpp:311`）

类型 `int`，初始值 `0`。

这是**并行 GC 根扫描的任务认领标志**。每次 GC 扫描线程 root 时，全局 `strong_roots_parity` 在 0 和 1 之间翻转。`Thread::claim_oops_do_par_case()` (`thread.cpp:862-874`) 用 CAS 比较 `_oops_do_parity` 与全局 parity——相等说明本线程的 root 已经被其他 GC 工作线程认领过了（跳过），不等说明未认领，CAS 更新后自己处理。

和 SMR 虽不是同一协议，但同为"线程间协同不持锁"的机制——放在同一段初始化。

### 4.2 `ThreadsList* volatile _threads_hazard_ptr`（`thread.hpp:157`）

类型 `ThreadsList* volatile`，初始值 `NULL`。

**Hazard pointer 本体**——读者把 `ThreadsList*` 写到这里，宣告"我正在读这个列表"。写者在 `smr_delete` 时扫描所有线程的这个字段来决定能不能 `delete` 一个 `JavaThread`。

读写用原子指令（`thread.inline.hpp:85-95`）：`set_threads_hazard_ptr()` 用 `release_store_fence`，`get_threads_hazard_ptr()` 用 `load_acquire`，`cmpxchg_threads_hazard_ptr()` 用 `Atomic::cmpxchg`。`volatile` 修饰符阻止编译器优化掉看似"多余"的读写。

### 4.3 `SafeThreadsListPtr* _threads_list_ptr`（`thread.hpp:158`）

类型 `SafeThreadsListPtr*`，初始值 `NULL`。

这个字段不直接存储 hazard ptr——它指向**本线程当前 `SafeThreadsListPtr` 的栈顶**。`acquire_stable_list()` 在获取快照前把当前 `_threads_list_ptr` 保存到 `_previous`，再把 `_threads_list_ptr` 设为自己，形成**线程私有的 SafeThreadsListPtr 链表**。嵌套 `ThreadsListHandle` 需要这个链表：内层通过 `_previous` 访问外层的 `_list`，用引用计数替代 hazard pointer。

这就是为什么 `SafeThreadsListPtr` 和 `_threads_hazard_ptr` 可以不同：一个线程的 `_threads_list_ptr` 可以指向包含多个嵌套的链表，但 `_threads_hazard_ptr` 始终只有一个（最内层的 fast path）。

### 4.4 `uint _nested_threads_hazard_ptr_cnt`（`thread.hpp:172`）

类型 `uint`，初始值 `0`。

**纯统计计数器**，只在 `-XX:+EnableThreadSMRStatistics` 时递增——`inc_nested_threads_hazard_ptr_cnt()` / `dec_nested_threads_hazard_ptr_cnt()` 配对在嵌套路径的进入和退出。SMR 协议不依赖这个值做安全决策。`ThreadsSMRSupport::_nested_thread_list_max` 用它记录历史的嵌套层数最大值。

### 4.5 `volatile uintx _rcu_counter`（`thread.hpp:315`）

类型 `volatile uintx`，初始值 `0`。

这属于另一套回收机制——**GlobalCounter（epoch-based reclamation）**。和 SMR 的 hazard pointer 是两套独立的、平行的机制：

| | Thread-SMR Hazard Pointer | GlobalCounter (RCU-style) |
|---|---|---|
| 粒度 | 单个 `ThreadsList` / `JavaThread` | 全局 epoch 计数 |
| 读者开销 | CAS + store fence（较大） | store fence（较小） |
| 写者开销 | 扫描所有线程的 hazard_ptr + 可能 wait | 递增全局 counter + 遍历所有线程等其 epoch 变新 |
| 使用场景 | `ThreadsList`、`JavaThread` 生命周期 | `Symbol` 名字表、`ClassLoaderDataGraph` |
| 嵌套支持 | 支持（引用计数） | 不支持 |

GlobalCounter 的 `_rcu_counter` 最低位（bit 0）是 `COUNTER_ACTIVE` 标志：

```
_rcu_counter = gbl_cnt | COUNTER_ACTIVE       // 进入 critical section
_rcu_counter = ~gbl_cnt                        // 退出 critical section（清零 active 位）
```

`write_synchronize()` (`globalCounter.cpp:60-73`)：递增全局 counter（加 2，跳过一个 bit），然后遍历所有线程读它们的 `_rcu_counter`——如果读到 active 位=1 且 counter 值小于新的全局值，说明该线程还在读取旧 epoch 的数据，spin 等待。全部通过后确认所有老读者已退出，安全回收。

在 `Thread::Thread()` 构造函数中的初始值 `0` 表示"线程出生时不在任何 critical section 内"——Active bit 为 0，计数器为 0。

---

## 5. 读者/写者完整时序

### 5.1 读者路径（获取稳定快照 → 遍历 → 释放）

JVM/TI `GetAllThreads` 为例：

```
JavaThreadIteratorWithHandle jtiwh;  // 构造 ThreadsListHandle
 ├── SafeThreadsListPtr::acquire_stable_list()
 │    ├── _threads_hazard_ptr = tag(ThreadsList_A)
 │    ├── 验证 _java_thread_list 没变 → cmpxchg 去 tag
 │    └── _list = ThreadsList_A（已发布 stable hazard ptr）
 │
 for (JavaThread *jt = jtiwh.next(); jt != NULL; ) {
   // jt 受 _threads_hazard_ptr 保护，写者不会 delete 它
 }
 // ThreadsListHandle 析构 → release_stable_list()
 //   └── _threads_hazard_ptr = NULL
```

### 5.2 写者路径（线程创建/退出）

**创建线程** (`add_thread`, `threadSMR.cpp:743-758`)：

```
old_list = get_java_thread_list()       // 读当前列表（不持锁）
new_list = new ThreadsList(old, [新增线程])
xchg_java_thread_list(new_list)         // 原子替换
free_list(old_list)                     // 旧列表进 to-delete 队列
  ├── 扫描所有线程的 _threads_hazard_ptr
  ├── 无 hazard 的旧列表 → delete
  └── 有 hazard 的旧列表 → 留队列里，下次释放时再扫描
```

**退出线程** (`smr_delete`, `threadSMR.cpp:944-1019`)：

```
持 Threads_lock
is_a_protected_JavaThread(thread)
  ├── 无人 hazard → break（直接 delete thread）
  └── 有人 hazard → 持 delete_lock，set_delete_notify
       drop Threads_lock
       delete_lock->wait() ← 等读者的 release_stable_list 发 notify
       收到通知 → 回到开头重试
delete thread;  // 物理删除
```

---

## 6. 总结

构造函数这 5 个字段的初始值形成的整体图景是：

```cpp
// 线程刚出生 = 不持有任何 SMR 状态的"白纸"
_oops_do_parity = 0;                  // 本轮 GC 还未被认领
_threads_hazard_ptr = NULL;           // 不保护任何 ThreadsList
_threads_list_ptr = NULL;             // SafeThreadsListPtr 栈为空
_nested_threads_hazard_ptr_cnt = 0;   // 0 层嵌套
_rcu_counter = 0;                     // 不在任何 critical section 里
```

线程要开始遍历全局线程列表时，创建 `ThreadsListHandle`——它自动调用 `acquire_stable_list()`，把 `_threads_hazard_ptr` + `_threads_list_ptr` 激活。作用域结束时析构自动释放。不需要手动 `lock/unlock`。
