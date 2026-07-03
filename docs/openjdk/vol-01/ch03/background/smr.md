# 前置概念：Thread-SMR —— 线程列表的安全并发访问

`Thread::Thread()` 构造函数末尾（`thread.cpp:238-243`）初始化了 5 个 SMR 相关字段，全部为 NULL/0：

```cpp
_oops_do_parity = 0;
_threads_hazard_ptr = NULL;          // ThreadsList* volatile，hazard pointer 本体
_threads_list_ptr = NULL;            // SafeThreadsListPtr*，嵌套遍历的 previous 链栈顶
_nested_threads_hazard_ptr_cnt = 0;  // uint，嵌套深度计数器（仅统计用）
_rcu_counter = 0;                    // volatile uintx，GlobalCounter 代际计数（平行机制）
```

这篇文章解释 SMR（Safe Memory Reclamation）的设计——从第一性原理出发，一步一步推到 JDK 11 的最终实现。

---

## 1. 起点：一个全局链表，两种并发操作

HotSpot 用 `Threads::_thread_list`（`thread.hpp:2205`，`static JavaThread*`）管理所有 `JavaThread` 对象——用 `_next` 指针串成的单向链表，`Threads::add()` 头插新节点，`Threads::remove()` 摘除已退出节点。

**这个链表是唯一的标准全局线程链表。** 本文讨论的 SMR 机制在此基础上维护一份 `ThreadsSMRSupport::_java_thread_list`（`ThreadsList* volatile`，`threadSMR.hpp:108`）——从上一个 `_java_thread_list` 快照重建的 Copy-on-Write 只读副本。读者通过 SMR 遍历的是 `_java_thread_list`（无锁快照），写者增删后同步更新两者：`Threads::_thread_list`（标准链表）和 `ThreadsSMRSupport::_java_thread_list`（SMR 快照）始终包含相同的线程集合。

---

## 2. 方案一：全局锁 `Threads_lock`

最直觉的解法——读者拿锁遍历，写者拿锁修改。JDK 8 就这么做。

**问题**：GC 触发时 VMThread 持锁遍历 `_thread_list`。遍历期间任何线程无法创建也无法退出——因为 `Threads::add()` 和 `Threads::remove()` 都需要同一个锁。线程创建/退出是高频操作——应用启动时每几十微秒就有一个新线程。GC 遍历一次可能几百微秒，这几百微秒内整套系统的线程生命周期完全冻结。

**换个思路**：能不能让读者不拿锁，只让写者互斥？

---

## 3. 方案二：Copy-on-Write 快照

不往链表里插节点，而是**把整条链表复制一份，追加/移除目标线程，然后用原子操作替换全局指针**。读者在遍历前拿一次快照，之后全程用这个快照遍历——**完全不需要锁**。

**核心数据结构**：`ThreadsList`（`threadSMR.hpp:158`）

```cpp
class ThreadsList : public CHeapObj<mtThread> {
  const uint _length;                  // 线程数量
  ThreadsList* _next_list;             // free_list 头插法链表
  JavaThread *const *const _threads;   // 数组指针，指向 JavaThread* 数组
  volatile intx _nested_handle_cnt;    // 嵌套 handle 引用计数
};
```

### 3.1 线程加入：`ThreadsSMRSupport::add_thread()`（`threadSMR.cpp:743-758`）

```cpp
void ThreadsSMRSupport::add_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::add_thread(get_java_thread_list(), thread);
  // ... 统计代码 ...
  ThreadsList *old_list = xchg_java_thread_list(new_list);  // Atomic::xchg 原子替换
  free_list(old_list);  // 旧列表挂入 _to_delete_list
}
```

`get_java_thread_list()` 通过 `OrderAccess::load_acquire` 读取全局指针（`threadSMR.inline.hpp:81-83`）：

```cpp
inline ThreadsList* ThreadsSMRSupport::get_java_thread_list() {
  return (ThreadsList*)OrderAccess::load_acquire(&_java_thread_list);
}
```

`xchg_java_thread_list()` 用 `Atomic::xchg` 原子替换并返回旧值（`threadSMR.cpp:159-161`）：

```cpp
inline ThreadsList* ThreadsSMRSupport::xchg_java_thread_list(ThreadsList* new_list) {
  return (ThreadsList*)Atomic::xchg(new_list, &_java_thread_list);
}
```

Copy-on-Write 的具体拷贝逻辑在 `ThreadsList::add_thread()`（`threadSMR.cpp:562-574`）：

```cpp
ThreadsList *ThreadsList::add_thread(ThreadsList *list, JavaThread *java_thread) {
  const uint index = list->_length;
  const uint new_length = index + 1;
  ThreadsList *const new_list = new ThreadsList(new_length);
  if (list->_length > 0) {
    Copy::disjoint_words((HeapWord*)list->_threads, (HeapWord*)new_list->_threads, list->_length);
  }
  *(JavaThread**)(new_list->_threads + index) = java_thread;  // 尾部追加
  return new_list;
}
```

`Threads::add()` 位于上层——先在标准 `_thread_list` 上做头插法，再调用 SMR 层更新快照（`thread.cpp:4456-4486`）：

```cpp
void Threads::add(JavaThread* p, bool force_daemon) {
  assert(Threads_lock->owned_by_self(), "must have threads lock");
  BarrierSet::barrier_set()->on_thread_attach(p);
  p->set_next(_thread_list);     // 标准链表头插
  _thread_list = p;
  p->set_on_thread_list();
  _number_of_threads++;
  // ... daemon 判断 ...
  ThreadService::add_thread(p, daemon);
  ThreadsSMRSupport::add_thread(p);  // 同步更新 SMR 快照
  Events::log(p, "Thread added: " INTPTR_FORMAT, p2i(p));
}
```

`Threads::add()` 同时维护两条链表。`_thread_list` 的头插法使 `ThreadsList::add_thread()` 的新快照里线程按创建顺序排列。SMR 更新发生在持 `Threads_lock` 的临界区内，保证原子替换时刻的全局一致性。

### 3.2 线程移除：`ThreadsSMRSupport::remove_thread()`（`threadSMR.cpp:917-933`）

移除是同样的 CoW 模式——复制一份不含目标线程的新列表，原子替换：

```cpp
void ThreadsSMRSupport::remove_thread(JavaThread *thread) {
  if (ThreadIdTable::is_initialized()) {
    ThreadIdTable::remove_thread(...);
  }
  ThreadsList *new_list = ThreadsList::remove_thread(get_java_thread_list(), thread);
  // ... 统计代码 ...
  ThreadsList *old_list = xchg_java_thread_list(new_list);
  free_list(old_list);
}
```

`ThreadsList::remove_thread()` 是 `add_thread()` 的镜像——拷贝时跳过目标线程（`threadSMR.cpp:655-674`）：

```cpp
ThreadsList *ThreadsList::remove_thread(ThreadsList* list, JavaThread* java_thread) {
  assert(list->_length > 0, "sanity");
  uint i = (uint)list->find_index_of_JavaThread(java_thread);
  const uint new_length = list->_length - 1;
  ThreadsList *const new_list = new ThreadsList(new_length);
  // 拷贝 head 部分：[0, i)
  if (i > 0) {
    Copy::disjoint_words((HeapWord*)list->_threads, (HeapWord*)new_list->_threads, i);
  }
  // 拷贝 tail 部分：(i, length)
  if (new_length > i) {
    Copy::disjoint_words((HeapWord*)list->_threads + i + 1, (HeapWord*)new_list->_threads + i, new_length - i);
  }
  return new_list;
}
```

分两段拷贝（head + tail 跳过被删除元素），不改变剩余线程的相对顺序。

### 3.3 旧列表回收：`free_list()`（`threadSMR.cpp:779-845`）

旧列表不能立即删除（读者可能还在用），而是挂入 `_to_delete_list` 延后回收：

```cpp
void ThreadsSMRSupport::free_list(ThreadsList* threads) {
  assert_locked_or_safepoint(Threads_lock);
  // 头插法挂入 _to_delete_list
  threads->set_next_list(_to_delete_list);
  _to_delete_list = threads;
  // ... 统计代码 ...

  // 扫描所有线程的 hazard ptr，收集正在被保护的 ThreadsList
  ThreadScanHashtable *scan_table = new ThreadScanHashtable(hash_table_size);
  ScanHazardPtrGatherThreadsListClosure scan_cl(scan_table);
  threads_do(&scan_cl);
  OrderAccess::acquire();  // 确保 hazard ptr 读在引用计数读之前

  // 遍历 _to_delete_list，释放既无 hazard ptr 保护、引用计数也为 0 的列表
  ThreadsList* current = _to_delete_list;
  ThreadsList* prev = NULL;
  while (current != NULL) {
    ThreadsList* next = current->next_list();
    if (!scan_table->has_entry((void*)current) && current->_nested_handle_cnt == 0) {
      if (prev != NULL) prev->set_next_list(next);
      if (_to_delete_list == current) _to_delete_list = next;
      delete current;
    } else {
      prev = current;  // 不能删，保留在链表中
    }
    current = next;
  }
  delete scan_table;
}
```

`ThreadsList` 通过 `_next_list` 头插法形成待删除链表。释放条件双重要求：无 hazard ptr 引用 **且** `_nested_handle_cnt == 0`（嵌套 handle 引用计数清零）。两者缺一不可。

**问题**：旧副本什么时候删？读者 T1 拿到 v3 开始遍历。写者把全局指针换成了 v4。此时不能删 v3——T1 还在用。必须等 T1 遍历完。

**如果写者能知道"还有谁在用 v3"就好了。**

---

## 4. 方案三：Hazard Pointer —— 读者贴一张"别删"标签

给每个 `Thread` 加字段 `_threads_hazard_ptr`（`thread.hpp:157`）。读者遍历前把正在用的快照地址写入，遍历完清零。写者要删除前扫描所有线程的 `_threads_hazard_ptr`——如果有人指着包含目标线程的快照，就等着，直到对方读完。

核心存取方法在 `thread.inline.hpp:85-95`：

```cpp
inline ThreadsList* Thread::get_threads_hazard_ptr() {
  return (ThreadsList*)OrderAccess::load_acquire(&_threads_hazard_ptr);
}
inline void Thread::set_threads_hazard_ptr(ThreadsList* new_list) {
  OrderAccess::release_store_fence(&_threads_hazard_ptr, new_list);
}
inline ThreadsList* Thread::cmpxchg_threads_hazard_ptr(ThreadsList* exchange, ThreadsList* compare) {
  return (ThreadsList*)Atomic::cmpxchg(exchange, &_threads_hazard_ptr, compare);
}
```

`load_acquire` / `release_store_fence` / `Atomic::cmpxchg` 三者构成无锁协议的内存序保证。

**到此为止，核心方案成型**：Copy-on-Write 让读者无锁遍历，Hazard Pointer 让写者知道何时安全删除。

---

## 5. 一个 Hazard Pointer 的并发 bug

上面听起来很完美——但有一个微妙的并发窗口：

```
读者 T1                          写者 T2
─────────────────────────    ─────────────────────
get_java_thread_list() → v3   Thread 退出
                              新快照 v4 = remove(Tx)  
                              xchg → v4
写入 _threads_hazard_ptr=v3   扫描 _threads_hazard_ptr
（这一纳秒还没写完）           还没扫到 T1 → 没有 v3
                              扫完了 → 没人用 v3
                              → delete Tx
完成写入 _threads_hazard_ptr=v3
开始遍历 v3 → 指针悬空！
```

T1 的 hazard ptr **还没写上去**时 T2 已经扫完了。T1 此时才贴标签——手上的 v3 里包含已释放的指针。

**需要一种协议——T1 写完 hazard ptr 后能意识到"T2 可能已经扫过我"并重新验证。**

---

## 6. 两阶段发布协议（tag/untag）

这就是 `acquire_stable_list_fast_path()` 的工作方式（`threadSMR.cpp:384-432`）：

```cpp
void SafeThreadsListPtr::acquire_stable_list_fast_path() {
  ThreadsList* threads;
  while (true) {
    threads = ThreadsSMRSupport::get_java_thread_list();     // ① 先读全局指针

    ThreadsList* unverified_threads = Thread::tag_hazard_ptr(threads); // ② 打 tag
    _thread->set_threads_hazard_ptr(unverified_threads);

    if (ThreadsSMRSupport::get_java_thread_list() != threads) { // ③ 再读一遍
      continue;  // 全局指针变了——重试
    }

    // ④ cmpxchg 去 tag：把 tagged ptr 替换为 untagged
    // 如果扫描线程抢了 tag（设为 NULL），cmpxchg 会失败 → 重试
    if (_thread->cmpxchg_threads_hazard_ptr(threads, unverified_threads) == unverified_threads) {
      break;
    }
  }
  _list = threads;
  verify_hazard_ptr_scanned();
}
```

tag/untag 的原理基于指针的最低 bit 复用。`ThreadsList*` 的最低 bit 在 64 位系统上总是 0（对齐保证），可以借用作 tag（`thread.hpp:162-170`）：

```cpp
static bool is_hazard_ptr_tagged(ThreadsList* list) {
  return (intptr_t(list) & intptr_t(1)) == intptr_t(1);
}
static ThreadsList* tag_hazard_ptr(ThreadsList* list) {
  return (ThreadsList*)(intptr_t(list) | intptr_t(1));
}
static ThreadsList* untag_hazard_ptr(ThreadsList* list) {
  return (ThreadsList*)(intptr_t(list) & ~intptr_t(1));
}
```

**tag 的作用**：写者扫描时发现 tagged hazard ptr（最低 bit = 1），知道"这个读者还没验证完"。写者会通过 `cmpxchg` **抢**这个 tag——把它设为 NULL（`threadSMR.cpp:249-268`）：

```cpp
// ScanHazardPtrGatherProtectedThreadsClosure::do_thread() 片段
while (true) {
  current_list = thread->get_threads_hazard_ptr();
  if (current_list == NULL) return;
  if (!Thread::is_hazard_ptr_tagged(current_list)) break;  // untagged → 已验证安全
  // tagged → 抢 tag
  if (thread->cmpxchg_threads_hazard_ptr(NULL, current_list) == current_list) return;
}
```

读者在步骤④的 `cmpxchg` 如果发现自己的 tag 变成了 NULL（被写者抢了），循环重试。tag 把一行赋值拆成两阶段协议，换来写者不浪费 CPU——发现未验证的 ptr 直接清零，不 wait。

---

## 7. 嵌套遍历 —— `acquire_stable_list_nested_path()`

如果 GC 遍历到一半触发了 JFR 线程枚举，同一个线程不能贴第二张 hazard ptr（会覆盖第一张）。

**解法**：外层脱离 hazard ptr，改用 ThreadsList 上的引用计数。内层用正常的 hazard ptr。

核心入口在 `SafeThreadsListPtr::acquire_stable_list()`（`threadSMR.cpp:366-380`）：

```cpp
void SafeThreadsListPtr::acquire_stable_list() {
  _needs_release = true;
  _previous = _thread->_threads_list_ptr;   // 保存上一级
  _thread->_threads_list_ptr = this;         // 把自己设为栈顶

  if (_thread->get_threads_hazard_ptr() == NULL) {
    acquire_stable_list_fast_path();          // 无嵌套 → 快路径
    return;
  }
  acquire_stable_list_nested_path();          // 已占用 → 嵌套路径
}
```

嵌套路径（`threadSMR.cpp:437-467`）：

```cpp
void SafeThreadsListPtr::acquire_stable_list_nested_path() {
  ThreadsList* current_list = _previous->_list;
  // 引用计数递增外层正在用的 ThreadsList
  current_list->inc_nested_handle_cnt();
  _previous->_has_ref_count = true;       // 标记外层为"引用计数模式"
  _thread->_threads_hazard_ptr = NULL;    // 清空 hazard ptr 腾出位置
  acquire_stable_list_fast_path();        // 走快路径设新 hazard ptr
}
```

嵌套路径的关键转换：
- `_previous->_has_ref_count = true`：外层从"hazard ptr 保护"切换到"引用计数保护"
- `current_list->inc_nested_handle_cnt()`：用 `Atomic::cmpxchg` 循环递增（`threadSMR.cpp:624-638`），保证与 `free_list()` 的 MO_ACQ_REL 递减形成正确的内存序
- 清空 `_threads_hazard_ptr` 后才走 fast path——腾出来给内层用

---

## 8. 释放：`release_stable_list()`（`threadSMR.cpp:471-505`）

```cpp
void SafeThreadsListPtr::release_stable_list() {
  _thread->_threads_list_ptr = _previous;  // 恢复 previous 链

  if (_has_ref_count) {
    // 引用计数模式（外层被 promote 了）
    _list->dec_nested_handle_cnt();         // Atomic::sub(1) → MO_ACQ_REL
  } else {
    // 普通模式：只清空 hazard ptr
    _thread->set_threads_hazard_ptr(NULL);  // release_store_fence
  }

  // 双重检查锁：减少 delete_lock 流量
  if (ThreadsSMRSupport::delete_notify()) {
    ThreadsSMRSupport::release_stable_list_wake_up(_has_ref_count);
  }
}
```

双重检查锁：先无锁读 `_delete_notify` flag（`OrderAccess::load_acquire`），为 true 才去争 `delete_lock` 并 `notify_all()`——唤醒可能在 `smr_delete()` 中等待的线程。

---

## 9. 安全删除：`smr_delete()`（`threadSMR.cpp:944-1019`）

```cpp
void ThreadsSMRSupport::smr_delete(JavaThread *thread) {
  while (true) {
    {
      MutexLockerEx ml(Threads_lock, Mutex::_no_safepoint_check_flag);
      ThreadsSMRSupport::delete_lock()->lock_without_safepoint_check();
      ThreadsSMRSupport::set_delete_notify();

      if (!is_a_protected_JavaThread(thread)) {
        ThreadsSMRSupport::clear_delete_notify();
        ThreadsSMRSupport::delete_lock()->unlock();
        break;                              // 安全 → 退出循环去 delete
      }
      // 不安全 → 持锁打印诊断日志
    } // 释放 Threads_lock，准备 wait

    // wait 等待 release_stable_list 发 notify
    ThreadsSMRSupport::delete_lock()->wait(
        Mutex::_no_safepoint_check_flag, 0,
        !Mutex::_as_suspend_equivalent_flag);
    ThreadsSMRSupport::clear_delete_notify();
    ThreadsSMRSupport::delete_lock()->unlock();
    // 重新循环检查
  }
  delete thread;
}
```

三重防护：
1. 持 `Threads_lock` 扫描所有 hazard ptr（`is_a_protected_JavaThread()`）
2. 如果安全 → 立即 delete（常见路径：读者已经释放）
3. 如果不安全 → 在 `delete_lock` 上 wait，等读者 `release_stable_list` 时 notify

注意原文档描述的"等 10ms"是简化版——实际源码用的是 `wait(..., 0, ...)`，第三个参数 `0` 表示无超时。wait 一直到被 notify 才返回。这和"每 10ms 重试"是不同的语义。

### 9.1 `is_a_protected_JavaThread()`（`threadSMR.cpp:850-892`）

```cpp
bool ThreadsSMRSupport::is_a_protected_JavaThread(JavaThread *thread) {
  // 扫描所有线程的 hazard ptr，收集它们指向的 ThreadsList 中的 JavaThread
  ThreadScanHashtable *scan_table = new ThreadScanHashtable(hash_table_size);
  ScanHazardPtrGatherProtectedThreadsClosure scan_cl(scan_table);
  threads_do(&scan_cl);
  OrderAccess::acquire();  // 确保 hazard ptr 读在引用计数读之前

  // 额外检查 _to_delete_list 中引用计数 > 0 的 ThreadsList
  ThreadsList* current = _to_delete_list;
  while (current != NULL) {
    if (current->_nested_handle_cnt != 0) {
      AddThreadHazardPointerThreadClosure add_cl(scan_table);
      current->threads_do(&add_cl);
    }
    current = current->next_list();
  }

  bool thread_is_protected = scan_table->has_entry((void*)thread);
  delete scan_table;
  return thread_is_protected;
}
```

扫描覆盖两处来源：
- **在线程的 `_threads_hazard_ptr` 中**：`ScanHazardPtrGatherProtectedThreadsClosure` 遍历所有线程，对每个线程的 hazard ptr 调用 `current_list->threads_do()` 把该 ThreadsList 上所有 JavaThread 加入 hash table
- **在 `_to_delete_list` 的嵌套引用中**：如果一个待删除 ThreadsList 的 `_nested_handle_cnt != 0`（有嵌套 handle 引用），它上面的 JavaThread 也受保护

---

## 10. `SafeThreadsListPtr` 的生命周期

整个协议由 `SafeThreadsListPtr` 驱动（`threadSMR.hpp:201-252`）：

**构造**：`SafeThreadsListPtr(Thread*, bool acquire)`——`acquire == true` 时调用 `acquire_stable_list()`。`_thread->_threads_list_ptr` 形成单向 previous 链（`thread.hpp:158`）。

**析构**：若 `_needs_release` 为 true，调用 `release_stable_list()`。恢复 `_previous` 链接。

**复制构造**：`SafeThreadsListPtr(SafeThreadsListPtr& other)`——转移所有权，`other._needs_release = false`。

两个常用子类：

| 子类 | 头文件 | 使用场景 |
|------|--------|---------|
| `ThreadsListHandle` | `threadSMR.hpp:272-298` | **最常见**。GC 根扫描、JVMTI 线程枚举——构造时自动 acquire |
| `ThreadsListSetter` | `threadSMR.hpp:258-267` | **特殊场景**。thread dump、死锁检测——构造时不 acquire，手动 `set()` |

**`ThreadsListHandle`** 是读者最常用的工具：

```cpp
// GC 线程典型用法：构造时自动获取 protected 快照
ThreadsListHandle tlh;                     // 构造时 acquire + 统计 timer
for (JavaThreadIteratorWithHandle jtiwh;   // 组合迭代器
     JavaThread *jt = jtiwh.next(); ) {
  // jt 受 tlh 保护，在此作用域内不会被 smr_delete 释放
}
```

析构时停止 timer 并记录统计（`threadSMR.cpp:683-689`）。

**`ThreadsListSetter`** 不自动 acquire——由调用者决定何时设置（`threadSMR.hpp:258-267`）：

```cpp
class ThreadsListSetter : public StackObj {
  SafeThreadsListPtr _list_ptr;
public:
  ThreadsListSetter() : _list_ptr(Thread::current(), /* acquire */ false) {}
  void set() { _list_ptr.acquire_stable_list(); }
  bool is_set() { return _list_ptr._needs_release; }
};
```

典型使用在 `ThreadDumpResult`（`threadService.hpp:380`）和 `VM_FindDeadlocks`（`vmOperations.hpp:435`）：

```cpp
// ThreadDumpResult 持有 ThreadsListSetter，在 dump 开始后手动 set
class ThreadDumpResult : public StackObj {
  ThreadsListSetter _setter;       // 构造时不 acquire
  // ... snapshots ...
public:
  // dump 开始时主动 set()，保护所有 ThreadSnapshot 中的 JavaThread*
};
```

`ThreadsListHandle` 用于"拿到线程后立即遍历"的模式（reader 在同一个函数内完成获取和释放）。`ThreadsListSetter` 用于"先初始化容器，后按需获取"的模式——比如 thread dump 结果可能要跨多个方法传递，需要延后决定何时获取保护。

---

## 11. 概念辨析：CoW、Hazard Pointer、RCU、Thread-SMR

读者常困惑：这到底是 Copy-on-Write、Hazard Pointer 还是 RCU？**四者不互斥，描述的是同一个机制的不同维度：**

**Thread-SMR** 是 HotSpot 对整套线程列表安全并发访问方案的命名（Safe Memory Reclamation）。它由两个正交的技术组成：

- **Copy-on-Write (CoW)**：快照的**创建**方式。增删线程时不原地修改数组，而是分配新 `ThreadsList` + 全量拷贝 + `Atomic::xchg` 原子替换全局指针（`threadSMR.cpp:160`）。解决的是"读者如何拿到一个不被写者破坏的版本"。

- **Hazard Pointer (HP)**：快照的**回收**方式。读者在遍历前把正在使用的 `ThreadsList*` 写入自己线程的 `_threads_hazard_ptr`（`thread.inline.hpp:88`），遍历完清零。写者删除前扫描所有线程的 hazard ptr，有引用就不删（`threadSMR.cpp:850-892`）。解决的是"旧版本何时能安全释放"。

Thread-SMR 和 Linux 内核的 **RCU (Read-Copy-Update)** 共享"读者无锁 + 写入生成新版本 + 延迟回收旧版本"的设计思想，但回收的**触发条件**不同：RCU 等 grace period（所有读者离开临界区），Thread-SMR 等 hazard ptr 清零（持有**特定版本**的读者读完）。粒度差异——RCU 等全体读者，SMR 等特定读者。

JDK 源码中的 `_rcu_counter`（`thread.hpp:313-318`）是平行于 `_threads_hazard_ptr` 的另一套机制（通过 `GlobalCounter`），用于 Thread-SMR 之外的非线程列表场景，不影响本文核心逻辑。

## 12. GC 读快照的安全性

核心疑问：GC 扫描线程 oop 时拿到的只是某个瞬间的 `ThreadsList` 快照。如果快照创建后才出生的新线程不在里面——GC 会漏掉栈上 oop 吗？如果快照里有已退出的线程——会访问已释放内存吗？

### 情况 A：Stop-the-World GC（Serial / Parallel Full GC / CMS remark）

**不会漏，也不会悬空。** STW GC 在 safepoint 中运行（`SafepointSynchronize::begin()`），此时没有任何 Java 线程能创建或退出——`Threads::add()` 和 `Threads::remove()` 都需要 `Threads_lock`，而锁的获取前提是**不在 safepoint 中**。快照包含的就是此刻所有活着的 Java 线程，不存在"快照之外"的线程。

### 情况 B：并发 GC（G1 concurrent marking / ZGC / Shenandoah）

**并发标记阶段确实有线程在继续跑**——包括新出生的和正在退出的。GC 拿到的 `ThreadsList` 快照可能不是全体活线程的完整集合。但 **GC 不会漏 oop**，因为并发 GC 不是纯粹靠 `ThreadsList` 快照来判断 oop 存活：

1. **SATB (Snapshot-At-The-Beginning)**：G1 并发标记开始时建立逻辑快照——所有此刻已存在的对象视为存活。并发期间新线程分配的对象通过 SATB 写屏障记录（`G1BarrierSet`），即使新线程不在 `ThreadsList` 快照中，其分配的 oop 也会被标记。
2. **Card Table**：任何线程写入引用时更新 card table。并发期间新线程的引用写入同样标记 card，remark 阶段会扫描脏 card。
3. **Remark 阶段重新进入 safepoint**：G1 的 remark (`G1CMRemarkTask::work()`, `g1ConcurrentMark.cpp:1839`) 在 safepoint 下调用 `Threads::threads_do()` 重新扫描**全体**线程栈，处理并发期间积累的 SATB 缓冲区。

**一句话**：并发 GC 不是纯粹靠某次 `ThreadsList` 快照来找 oop——它还依赖写屏障（SATB / card table）追踪快照之外的并发变化。`ThreadsList` 快照是根扫描的起点，SATB 写屏障和 safepoint remark 兜底保证完整性。

## 13. 全文总结

| 步骤 | 方案 | 解决的问题 | 留下的问题 |
|------|------|-----------|-----------|
| 1 | 全局锁 | 最基本的并发安全 | 读者阻塞写者，GC 冻结线程生命周期 |
| 2 | Copy-on-Write + `Atomic::xchg` | 读者无锁遍历 | 旧快照不知道何时删除 |
| 3 | Hazard Pointer | 写者能知道何时安全删除 | 读者贴标签有并发窗口 |
| 4 | tag/untag 两阶段 + `cmpxchg` | 消除窗口——读者验证不被抢先 | 同一线程不能嵌套遍历 |
| 5 | 嵌套路径 + `_nested_handle_cnt` | 嵌套遍历用引用计数替代 | 写者需同时检查 hazard ptr 和引用计数 |
| 6 | `free_list()` 递延回收 | 旧列表自动回收 | `_to_delete_list` 链表的非阻塞维护 |

最终产物是 `Thread::Thread()` 构造函数中全部为 NULL/0 的五个字段——SMR 协议的线程级基础设施。运行时一旦 `Threads::add()` 把线程加入链表并调用 `ThreadsSMRSupport::add_thread()` 创建 CoW 快照，这套协议即刻生效。
