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

**这个链表是唯一的标准全局线程链表。** 本文讨论的 SMR 机制在此基础上维护一份 `ThreadsSMRSupport::_java_thread_list`（`ThreadsList* volatile`，`threadSMR.hpp:108`）——从上一个 `_java_thread_list` 快照重建的 Copy-on-Write 只读副本。

两者初始化时都是空——`_thread_list = NULL`（`thread.cpp:3503`），`_java_thread_list = new ThreadsList(0)` 即长度为 0 的空数组（`threadSMR.cpp:75`）。增删线程时，`Threads::add()` 和 `Threads::remove()` 在**同一个函数、同一个持锁状态**下把同一个 `JavaThread*` 指针加入/摘除两边——`_thread_list` 是链表操作（O(1) 头插 / O(n) 摘除），`_java_thread_list` 是 CoW 重建（全量拷贝 + 替换）。两者永远包含相同的 `JavaThread*` 集合，不会出现一边比另一边多线程或漏线程的情况。

---

## 2. 方案一：全局锁 `Threads_lock`

最直觉的解法——读者拿锁遍历，写者拿锁修改。JDK 8 就这么做。

**问题**：GC 触发时 VMThread 持锁遍历 `_thread_list`。遍历期间任何线程无法创建也无法退出——因为 `Threads::add()` 和 `Threads::remove()` 都需要同一个锁。线程创建/退出是高频操作——应用启动时每几十微秒就有一个新线程。GC 遍历一次可能几百微秒，这几百微秒内整套系统的线程生命周期完全冻结。

**换个思路**：能不能让读者不拿锁，只让写者互斥？

> **`_thread_list` 还在用吗？** 正在使用，但只被线程**自己**操作。每个 `JavaThread` 在启动时调用 `Threads::add(this)`（`thread.cpp:3214`），把自己头插入 `_thread_list` 链表，同时在函数末尾（`thread.cpp:4482`）调用 `ThreadsSMRSupport::add_thread()` 更新 SMR 快照。退出时同理——`Threads::remove(this)`（`thread.cpp:2085`）把自己从链表摘除，同时调用 `ThreadsSMRSupport::remove_thread()` 重建快照。`_thread_list` 和 `_java_thread_list` 由**同一个线程**在**同一个函数**里同步维护，不存在独立的两组写者。
>
> **那 `_java_thread_list` 是谁在读？** 所有需要遍历线程列表的线程——GC 的 VMThread（`Threads::threads_do()` 扫描 oop 根）、jstack/JCMD（`Threads::print_on()` dump 线程栈）、JVMTI agent（`GetAllThreads()` 枚举线程）、JFR sampler（线程采样）。它们通过 `acquire_stable_list()` 拿到 hazard-pointer 保护的快照后无锁遍历。读者不关心链表怎么增删——它们只看到 `Atomic::xchg` 产生的某个原子状态的快照。

---

## 3. 方案二：Copy-on-Write 快照

锁的问题本质上是"读者阻塞写者"——有没有办法让读者不阻碍写者生产新数据？

### 3.1 从没有 CoW 的链表出发——为什么不行

JDK 8 的 `Threads::_thread_list`（`thread.hpp:2205`，`static JavaThread*`）就是一条没有 CoW 保护的单向链表。`Threads::add()` 用头插法在表头新增节点，`Threads::remove()` 从链表中摘除节点——原地修改，无快照。

```
写者：p->set_next(_thread_list); _thread_list = p;   // 头插法原地修改
读者：for (cur = _thread_list; cur != NULL; cur = cur->next()) { ... }
```

**能不能安全地读？不能。** 写者正在 `Threads::remove()` 里把某个节点的 `_next` 指针指向新目标，读者恰好遍历到这个节点——读到的 `_next` 可能是旧地址（指向已释放的内存），也可能刚被改成新地址（跳过有效的线程）。无论哪种都是 bug。

**本质上，问题出在"写者和读者共享同一块可变内存"。** `_thread_list` 只有一份——写者原地改它，读者直接读它。要安全就得加 `Threads_lock`——这正是方案一要解决的问题。JDK 8 正是这么做的：每次遍历都持锁，读者写者互斥，GC 等所有线程创建/退出完成才能开始。

### 3.2 CoW 的核心思想：读者和写者不共享同一块可变内存

Copy-on-Write 的关键就是消除"共享可变内存"这个条件。怎么做？写时不覆盖旧数据，而是建一份新副本：

```
原始: v3 → [T1, T2, T3]
         (读者拿着 v3 的指针正在遍历)

写者加入 T4:
  ① 分配新数组 v4，长度 = v3 长度 + 1
  ② 把 v3 的全部内容拷贝到 v4                  ← "Copy"
  ③ v4 尾部追加 T4
  ④ 全局指针从 v3 原子替换为 v4                 ← "Write"（改的是指针，不是数组）

结果: v4 → [T1, T2, T3, T4]  (新读者读这个)
      v3 → [T1, T2, T3]       (老读者还在用这个，不受影响)
```

读者拿到的是 `_java_thread_list` 指针的快照——一旦拿到，后面全程用这个指针操作独立的数组，**和全局指针再无关系**。写者改的是全局指针，每个写都生成一份新数组——"Copy" 发生在每次写操作时，所以叫 Copy-on-Write。

**数据结构**：`ThreadsList`（`threadSMR.hpp:158`）——存放这个只读快照的容器：

```cpp
class ThreadsList : public CHeapObj<mtThread> {
  const uint _length;                  // 线程数量
  ThreadsList* _next_list;             // free_list 头插法链表
  JavaThread *const *const _threads;   // 数组指针，指向 JavaThread* 数组
  volatile intx _nested_handle_cnt;    // 嵌套 handle 引用计数
};
```

`_threads` 指向的 `JavaThread*[]` 数组在构造函数中分配（`threadSMR.cpp:550-554`）：

```cpp
ThreadsList::ThreadsList(int entries) :
  _length(entries),
  _next_list(NULL),
  _threads(NEW_C_HEAP_ARRAY(JavaThread*, entries + 1, mtThread)),
  _nested_handle_cnt(0)
{
  *(JavaThread**)(_threads + entries) = NULL;  // 哨兵：多分配一个 NULL 终结
}
```

数组比 `entries` 多分配一个位置——末尾固定存 NULL，作为遍历时的哨兵。

### 3.3 源码对应：三层调用链

CoW 的设计嵌在一套严格的分层调用中，每一层有明确的职责边界。

**第一层：`Threads::add()`——标准链表的唯一写入口**（`thread.cpp:4456-4486`）

```cpp
void Threads::add(JavaThread* p, bool force_daemon) {
  assert(Threads_lock->owned_by_self(), "must have threads lock");  // 调用者已持锁
  p->set_next(_thread_list);
  _thread_list = p;                          // 头插到标准链表
  p->set_on_thread_list();
  _number_of_threads++;
  // ... daemon 计数 + ThreadService 注册 ...
  ThreadsSMRSupport::add_thread(p);          // 最后一步：同步更新 SMR 快照
}
```

这一层做的是标准链表的维护——头插新节点、递增计数器。最后一行才调 `SMRSupport::add_thread(p)`——SMR 快照是对标准链表的衍生。锁由调用者持：主线程在 `Threads::create_vm()` 中显式 `{ MutexLocker mu(Threads_lock); Threads::add(main_thread); }`（`thread.cpp:3860-3861`），普通子线程的 `JavaThread::prepare()` 调用前已有 `assert(Threads_lock->owner() == Thread::current())`（`thread.cpp:3180`）。

**第二层：`ThreadsSMRSupport::add_thread()`——CoW 快照的编排者**（`threadSMR.cpp:743-758`）

```cpp
void ThreadsSMRSupport::add_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::add_thread(get_java_thread_list(), thread);
  ThreadsList *old_list = xchg_java_thread_list(new_list);
  free_list(old_list);
}
```

这一层调度 CoW 三步：取当前快照 → 委托 `ThreadsList::add_thread()` 建新快照 → `Atomic::xchg` 原子替换全局指针 → 旧快照送入 `free_list()` 待回收队列。

**第三层：`ThreadsList::add_thread()`——纯 CoW 的底层实现**（`threadSMR.cpp:562-574`）

```cpp
ThreadsList *ThreadsList::add_thread(ThreadsList *list, JavaThread *java_thread) {
  ThreadsList *const new_list = new ThreadsList(list->_length + 1);  // ① 分配新容器
  if (list->_length > 0) {
    Copy::disjoint_words(list->_threads, new_list->_threads,         // ② 全量 memcpy
                         list->_length);
  }
  *(JavaThread**)(new_list->_threads + list->_length) = java_thread; // ③ 尾追加
  return new_list;
}
```

最底层——输入一个 `ThreadsList` 和一个 `JavaThread*`，输出长度 +1 的新 `ThreadsList`。不读全局指针，不涉及替换回收。全量拷贝而非原地追加——因为旧快照可能有读者正在遍历，原地改尾部会破坏读者手里的数据。

三层分工：

| 层 | 函数 | 职责 |
|---|---|---|
| 入口 | `Threads::add()` | 维护标准链表，触发 SMR 同步 |
| 编排 | `ThreadsSMRSupport::add_thread()` | 调度 CoW：取旧→建新→替换→回收 |
| 底层 | `ThreadsList::add_thread()` | 纯 CoW：全量拷贝 + 尾追加 |

**移除同理**：`ThreadsSMRSupport::remove_thread()`（`threadSMR.cpp:917-933`）同样三层——`Threads::remove()` 从标准链表摘除后调 `SMRSupport::remove_thread()`，底层 `ThreadsList::remove_thread()` 分两段拷贝跳过目标线程。

### 3.4 CoW 解决了什么、留下了什么

CoW 解决了"读者不用锁"——读者的数据（v3 数组）完全独立于写者修改的数据（全局指针 `_java_thread_list`）。写者改的是全局指针，读者用的是自己拿到的快照，两者不共享可变内存。

**但留下一个问题：旧版本什么时候删？** v3 在 reader 手中独立操作——reader 现在正在遍历，不能删。如果 reader 遍历到一半就把 v3 释放了，reader 的指针立刻悬空。所以必须等 reader 遍历完。

这就是 `free_list()` 不立即 `delete` 的原因——它只把旧列表挂入 `_to_delete_list`，等后续机制判断何时安全删除。

而"后续机制"就是 **Hazard Pointer**（下一节）：reader 在遍历前贴一个"别删"标签，writer 扫描所有标签——没人贴才删。CoW 解决了读者无锁读，Hazard Pointer 解决了旧快照的安全回收。

## 4. 方案三：Hazard Pointer —— 读者贴标签，写者等标签
CoW 留下了一个问题：旧快照（v3）何时能安全释放？读者还在用 v3，写者不能删——但等到内存无限增长也不可行。必须有一种机制让写者删除前**知道是否有人还在用旧快照**。

Hazard Pointer 就是这个机制。每个线程通过 `_threads_hazard_ptr` 字段公开发布自己正在使用的 `ThreadsList*` 快照地址。写者删除前扫描所有线程的这个字段——如果有人指着自己即将释放的快照，就等待；没人指，安全删除。

### 4.1 基本场景：没有并发冲突的理想情况

先考虑最简单的时序——读者先贴上标签，写者再开始扫描。

**初始状态**：`_java_thread_list → v3 = [T1, T2]`。

**Step 1 — GC（读者）贴标签**：GC 拿到 v3 快照，把自己的 `_threads_hazard_ptr` 设为 v3：

```
GC: _threads_hazard_ptr = v3   // 公开声明："我正在用 v3，别删"
```

**Step 2 — T2 退出（写者）**：T2 从线程列表退出，触发 SMR 流程：
- `remove_thread(T2)` → 分配新快照 v4 = [T1]，`Atomic::xchg` 全局指针换为 v4
- 旧快照 v3 进入 `_to_delete_list`
- `smr_delete(T2)` 开始：扫描所有线程的 `_threads_hazard_ptr`

**Step 3 — 写者发现有读者在保护旧快照**：

```
写者扫描每个线程的 _threads_hazard_ptr：
  T1: NULL
  GC: v3  ← 指着 v3！v3 里恰好包含 T2
  结论：T2 还被保护，不能删
```

**Step 4 — 写者等待**：写者在 `delete_lock` 上 wait，等读者释放。

**Step 5 — GC 读完，摘标签**：

```
GC: _threads_hazard_ptr = NULL   // "我用完了"
    同时通知等待中的写者（notify）
```

**Step 6 — 写者重扫，安全删除**：写者被唤醒后重扫——所有线程的 `_threads_hazard_ptr` 都是 NULL。没人再用 v3，T2 安全 delete。

用最简伪代码表达这个流程（不涉及 tag/untag，那是后面为解决并发窗口才加的）：

```cpp
// 读者（GC）—— 贴标签 → 遍历 → 摘标签
ThreadsList* list = ThreadsSMRSupport::get_java_thread_list(); // 拿快照
_threads_hazard_ptr = list;          // 贴标签："我正在用这个快照"
for (int i = 0; i < list->length(); i++) {
  scan_oop(list->thread_at(i));     // 遍历（无锁）
}
_threads_hazard_ptr = NULL;          // 摘标签："我用完了"

// 写者（T2 退出时的 smr_delete）
while (is_a_protected_JavaThread(T2)) { // 扫描所有 hazard_ptr
  delete_lock()->wait();               // 有人指着就等
}
delete T2;                               // 安全删除
```

> **`is_a_protected_JavaThread()` 做什么**：它扫描所有线程的 `_threads_hazard_ptr`，对每个非空 hazard ptr，收集其指向的 ThreadsList 上的全部 JavaThread。因为 hazard ptr 保护的是整个快照（ThreadsList），不是单个线程——只要有人指着 v3，v3 里的所有线程都不能删。

### 4.2 Hazard Pointer 解决了什么、留下了什么

Hazard Pointer 解决了旧快照的安全回收——写者在释放前扫描所有读者的标签，确认无人引用后才 delete。CoW + HP 构成 Thread-SMR 的骨架：CoW 负责读者无锁读取，HP 负责写者安全回收。

**但留下一个并发窗口**：上面的场景假设 GC 先贴标签、T2 才扫描。如果 T2 先扫描完、GC 后贴标签——T2 会错过 GC 的标签，错误地认为旧快照无人使用。

---

## 5. 并发窗口 —— 贴标签和扫描之间有竞争

### 5.1 完整的 race condition 时序

4.1 假设 GC 先把标签贴好，T2 才开始扫描。现实中两者并发运行——T2 持 `Threads_lock` 执行 `remove/smr_delete`，GC 不持锁读取。**贴标签和扫描之间没有同步屏障。**

```
时刻  GC（读者，无锁）                T2（写者，持 Threads_lock）
────  ─────────────────────────────  ─────────────────────────────────
t1    list = get_java_thread_list()    // 拿到 v3，但还没贴标签
t2                                      remove_thread(T2) → new_list = v4
t3                                      xchg → 全局指针 = v4
t4                                      smr_delete(T2): 扫描所有 hazard_ptr
t5                                      扫描 GC:_threads_hazard_ptr == NULL ← 还没贴！
t6                                      扫描结束: 全 NULL
t7                                      结论: 无人用 v3 → delete T2
t8    _threads_hazard_ptr = list      ← 贴标签（list 是 v3）
t9    遍历 v3: list->thread_at(0)    ← v3 中的 T2 已经被 delete 了！悬空！
```

GC 在 t1 拿到了 v3 的指针，但 t8 才贴标签。T2 在 t4-t7 完成了全部扫描——此时 GC 的标签还是 NULL。等 GC 在 t8 贴上标签时，T2 已经被 delete。

**根本原因**：GC 的"拿快照"和"贴标签"是两个分开的操作。T2 在这两步之间完成了整条删除链路——先替换全局指针（t3），再扫描并删除（t4-t7）。Hazard Pointer 的基本协议假设"先贴标签，再扫描"，但这个假设在并发下被打破了——窗口虽小，在多核上真实存在。

### 5.2 窗口的本质

问题不在 `set_threads_hazard_ptr()` 的实现——它使用了 `release_store_fence()`，保证 store 对其他核心可见。问题在**语义层面**：标签贴上去之后，GC 手上拿到的 v3 可能已经不是最新快照。写者在 GC 贴标签之前就已经替换了全局指针——GC 的标签指向的是一个已经过时、正在被回收的快照。

**要解决这个问题，读者需要在贴标签后做一个检查：自己拿到的快照还是不是最新的？如果是，标签有效；如果不是，重新来。**

### 5.3 本节总结

Hazard Pointer 的基本协议在并发下有一个窗口：读者在"拿快照"到"贴标签"之间，写者可能已经完成了全部删除操作。读者贴的标签因此是"过期的"——写者扫描时标签还没出现，读者贴标签时对象已经释放。下一步需要一种协议，让读者在贴标签后**验证快照是否仍然是对应当前全局指针的版本**。

---

## 6. 两阶段发布协议（tag/untag）

### 6.1 核心思路：把"贴标签"拆成两个阶段

解决并发窗口的关键在于让读者贴标签成为一个**两阶段操作**：

- **Phase 1 — tag（预报）**：贴一个"未验证"标签——指针最低 bit 置 1，告诉写者"我还没验证完，先别相信我"
- **Phase 2 — untag（确认）**：重新读全局指针——如果没变，去 tag（最低 bit 清零），标签从"未验证"变为"已验证"

写者在扫描中看到 tagged 标签时，不会把它当作有效的保护——**主动用 CAS 抢走**（设为 NULL），让读者的 Phase 2 CAS 失败，迫使读者重试。

这就是两阶段发布协议：**读者先预报（tag），验证后确认（untag）；写者看到预报时主动抢走，迫使读者重试。** 这正好消解 5.1 的窗口：如果写者在 GC 贴 tag 之前就扫描完了，GC 的 Phase 2 会发现全局指针已经从 v3 变成了 v4——标签无效，重试。

### 6.2 tag bit 的存储：复用指针的最低 bit

`ThreadsList*` 在 64 位系统上 8 字节对齐——最低 3 bit 恒为零。借用最低 bit 做 tag 不影响指针解引用（`thread.hpp:162-170`）：

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

### 6.3 读者端：`acquire_stable_list_fast_path()`

协议实现为 `SafeThreadsListPtr::acquire_stable_list_fast_path()`（`threadSMR.cpp:384-432`）：

```cpp
void SafeThreadsListPtr::acquire_stable_list_fast_path() {
  ThreadsList* threads;
  while (true) {
    threads = ThreadsSMRSupport::get_java_thread_list();
    // ① 读当前全局快照（无锁）

    ThreadsList* unverified_threads = Thread::tag_hazard_ptr(threads);
    _thread->set_threads_hazard_ptr(unverified_threads);
    // ② Phase 1：贴 tagged 临时标签（release_store_fence）

    if (ThreadsSMRSupport::get_java_thread_list() != threads) {
      continue;
      // ③ 重读全局指针：如果变成了 v4 →
      //    说明写者在②之前就替换了快照，标签过期，重试
    }

    if (_thread->cmpxchg_threads_hazard_ptr(threads, unverified_threads)
        == unverified_threads) {
      break;
      // ④ Phase 2：CAS 去 tag（tagged v3 → untagged v3）→ 正式生效
    }
    // ⑤ CAS 失败：标签被写者抢走（设为 NULL）→ 外层循环重试
  }
  _list = threads;
  verify_hazard_ptr_scanned();
}
```

步骤 ③ 是关键：通过重读全局指针来做验证。这依赖 `Atomic::xchg`（写者替换全局指针用）提供的顺序保证——写者先替换全局指针，再扫描 hazard_ptr。读者如果读到的全局指针已经变了，说明写者必然在读者贴标签**之前**就替换了快照——手上的 v3 已经过时。

步骤 ④ 的 CAS 检查标签是否被写者抢走。如果写者在步骤②和④之间扫描到 tagged 标签 → 写者 `cmpxchg(NULL, tagged_ptr)` 清空 → 读者的 CAS `cmpxchg(untagged_ptr, tagged_ptr)` 发现 expected 已经是 NULL → 失败，重试。如果写者还没扫到 → CAS 成功，标签从 unverified 升级为 verified。

### 6.4 写者端：扫描时抢 tagged 标签

写者端在 `ScanHazardPtrGatherProtectedThreadsClosure::do_thread()`（`threadSMR.cpp:234-278`）中扫描每个线程的 hazard_ptr：

```cpp
while (true) {
  current_list = thread->get_threads_hazard_ptr();
  if (current_list == NULL) {
    return;              // 没标签 → 不保护任何快照
  }
  if (!Thread::is_hazard_ptr_tagged(current_list)) break;
  // untagged（已验证）→ 正常保护它指向的快照
  // ↓ tagged（未验证）→ 主动抢走
  if (thread->cmpxchg_threads_hazard_ptr(NULL, current_list) == current_list)
    return;              // 抢成功了 → 读者重试，本次扫描跳过
  // CAS 失败 → 读者恰好同时完成了去 tag → 重读 hazard_ptr
}
// 到这里 current_list 是已验证的 hazard_ptr
current_list->threads_do(&add_cl);  // 保护此快照上所有 JavaThread
```

写者看到 tagged 标签时不等待——直接用 CAS 设 NULL，强制读者重试。如果 CAS 成功：读者在 Phase 2 发现 CAS 失败，`while(true)` 外层从头重试（重新拿全局指针、重新贴 tag）。如果 CAS 失败：说明读者恰好完成了 Phase 2 的 CAS → 标签已变为 untagged → 写者重读 `get_threads_hazard_ptr()` 后通过 `!is_tagged` 检查正常保护。

### 6.5 tag/untag 解决了什么、留下了什么

tag/untag 两阶段协议解决了 Hazard Pointer 的并发窗口。读者通过"预报→验证→确认"保证贴的标签指向当前仍然有效的全局快照；写者通过主动抢 tagged 标签迫使"贴晚了"的读者重试。窗口被压缩到一条 CAS 指令的粒度——要么读者确认成功，要么写者抢走标签，两者不会同时看到不一致的状态。

**留下的问题**：每个线程只有一个 `_threads_hazard_ptr`。如果读者遍历到一半被嵌套调用（GC 遍历一半触发 JFR 线程枚举），同一个线程需要同时保护两个不同的快照。这就引出了嵌套遍历——通过把外层升级为引用计数模式来解决（下一节）。---

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
