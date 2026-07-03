# 前置概念：Thread-SMR —— 线程列表的安全并发访问

> **本文定位**：背景知识文章，不依赖章节正文。你要理解的是 HotSpot 如何让 GC、jstack、JVMTI、JFR 等"读者"无需持有全局锁就能安全遍历线程列表，同时线程的创建和退出（"写者"）不被阻塞。读完本文后回到 [06-main-thread-create.md](../06-main-thread-create.md) 第 1420 行的 5 个 SMR 字段，你将完全理解它们的作用。

---

想象 JVM 运行中的一个时刻：

- VM 里有 1000 个活跃的 `JavaThread`，`Threads::_thread_list` 把它们串成一条单向链表
- GC 触发 safepoint，VMThread 持着 `Threads_lock` 遍历这条链表——扫描每个线程栈上的 oop 根
- 此时恰有一个线程调用 `Threads::remove()` 退出，另一个线程在 `Threads::add()` 创建新线程——它们也需要 `Threads_lock`

GC 遍历一次可能几百微秒。这几百微秒内，**整套系统的线程创建和退出全部冻结**——`Threads::add()` 和 `Threads::remove()` 在锁上排队。

能不能让遍历者不拿锁？这就是 Thread-SMR 要解决的全部问题。

答案只靠三步：**写时拷贝（Copy-on-Write）** 让读者拿到独立数据的快照、**Hazard Pointer** 让写者知道旧快照是否还有人用、**两阶段发布协议（tag/untag）** 把并发窗口压缩到一条 CAS 指令。

---

## 1. 两个列表，一个源头

`Threads::_thread_list`（`thread.hpp:2205`，`static JavaThread*`）是所有线程管理的唯一权威数据源——一条 `_next` 指针串起的单向链表。`Threads::add()` 头插新节点（O(1)），`Threads::remove()` 摘除已退出节点（O(n)），两个操作都在 `Threads_lock` 保护下原地修改链表。

**为什么原始的 `_thread_list` 需要另一个快照？** 链表的"原地修改"特性恰好是问题的根源。写者改 `_next` 指针的瞬间，如果读者正在遍历，可能读到半个修改或跳到野指针——这就是必须拿锁的原因。但是，如果读者遍历的不是可变链表，而是一份**不可变的数组**，就不用担心写者同时修改。

`ThreadsSMRSupport::_java_thread_list`（`threadSMR.hpp:108`，`ThreadsList* volatile`）就是这个不可变的数组快照。它和 `_thread_list` 在**同一个函数、同一个持锁状态**下同步维护——`Threads::add()` 把新 `JavaThread*` 头插入 `_thread_list` 链表之后，紧接着调用 `ThreadsSMRSupport::add_thread()` 更新 `_java_thread_list` 快照。两边包含的是**完全相同的 `JavaThread*` 集合**，不会出现一边多线程一边漏线程的情况。

初始化时两者都是空集：`_thread_list = NULL`（`thread.cpp:3503`），`_java_thread_list = new ThreadsList(0)`——一个长度为 0 的空数组（`threadSMR.cpp:75`）。

`ThreadsSMRSupport` 是这套机制的名称空间——一个 **全静态类**（`threadSMR.hpp:88`，`class ThreadsSMRSupport : AllStatic`）。所有方法和字段都是 `static`，JVM 中不存在它的实例对象。作为全局协调器，它管理以下关键状态：

```cpp
// threadSMR.hpp:108-117
static ThreadsList* volatile _java_thread_list;  // 全局 CoW 快照——JVM 唯一
static ThreadsList*          _to_delete_list;    // 待删除旧快照的链表头
static volatile uint         _delete_notify;     // 双重检查锁 flag（第 8.1 节）
// 其余字段是统计计数器（-XX:+EnableThreadSMRStatistics 控制）：
static volatile uint         _deleted_thread_cnt;
static volatile uint         _tlh_cnt;
// ...
```

全静态意味着 **SMR 的协调状态是 JVM 级别的全局单例**——整个 VM 只有一个 `_java_thread_list` 指针、一个 `_to_delete_list` 队列。每个线程私有的 SMR 字段（`_threads_hazard_ptr` 等 5 个，见本文第 11.2 节总结）与这个全局协调器配合，构成完整的读/写协议。

```
全局状态：
  Threads::_thread_list       → [T3] → [T2] → [T1] → NULL
                                  ↑ 头插法，新线程在前

  ThreadsSMRSupport::
  _java_thread_list           → [T1, T2, T3]  (ThreadsList 数组，只读)
                                  ↑ CoW 快照，顺序与链表不一定一致

写者（Threads::add / remove）：
  1. 持 Threads_lock 修改 _thread_list（链表头插/摘除）
  2. 在同一持锁范围内，调 ThreadsSMRSupport::add/remove_thread 重建快照
  3. 结果：两个列表包含完全相同的 JavaThread* 集合

读者（GC / jstack / JVMTI）：
  只读 _java_thread_list 快照，不碰 _thread_list 链表
```

**谁在读 `_java_thread_list`？** 不是线程自己。是所有需要遍历线程集合的外部系统——GC 的 VMThread（`Threads::threads_do()` 扫描 oop 根）、jstack 和 JCMD（`Threads::print_on()` dump 线程栈）、JVMTI agent（`GetAllThreads()` 枚举线程）、JFR sampler（线程采样）。线程自己不关心快照里有没有自己——它通过 `Threads::add()` 和 `Threads::remove()` 修改 `_thread_list` 链表，快照只是这套修改的"只读投影"。

---

## 2. 方案一：全局锁——JDK 8 的做法

JDK 8 没有 `_java_thread_list`。要遍历线程，唯一的选择是持有 `Threads_lock` 遍历 `_thread_list`：

```
读者（GC）：MutexLocker mu(Threads_lock);      // 持锁
          for (cur = _thread_list; cur != NULL; cur = cur->next())
              scan_oop(cur);                  // 遍历
          退出作用域，释放锁

写者（新线程）：MutexLocker mu(Threads_lock);  // 等待...等 GC 放锁
              // 头插入 _thread_list
```

**问题不在正确性——在性能。** GC 拿锁遍历期间，任何线程无法创建也无法退出。线程创建/退出是高频操作——应用启动时每几十微秒就有一个新线程。GC 遍历一次几百微秒，意味着这几百微秒内整个系统的线程生命周期完全冻结。

> 这是一个 **读者阻塞写者** 的经典问题。锁的本质是互斥——读者和写者不能同时操作。但当写者频率远高于读者时，用锁保护慢速读操作是灾难。

**方向很明确**：能不能让读者不拿锁？

---

## 3. 方案二：Copy-on-Write——读者不拿锁

### 3.1 为什么原始链表不能让读者不拿锁

`_thread_list` 是一条单向链表，写者在 `Threads::remove()` 里直接修改节点的 `_next` 指针：

```
写者：p->set_next(_thread_list); _thread_list = p;   // 原地修改
读者：for (cur = _thread_list; cur != NULL; cur = cur->next()) { ... }
```

读者和写者**共享同一块可变内存**——写者改的就是读者读的东西。没有保护的情况下，读者可能读到已经被释放的内存，或者跳过新插入但还未链上的节点。要安全就只能加锁——这就是 JDK 8 做的事。

### 3.2 CoW 的核心思想

Copy-on-Write 的解法是消除"共享可变内存"这个前提。**写者不修改读者正在使用的数据，而是建一份新副本，只改全局指针**：

```
原始状态：
  _java_thread_list → v3 = [T1, T2, T3]
  读者拿着 v3 的指针正在遍历

写者加入 T4：
  ① 分配新数组 v4，长度 = v3 长度 + 1
  ② 把 v3 的全部内容 memcpy 到 v4              ← "Copy"
  ③ v4 末尾写入 T4
  ④ Atomic::xchg 把全局指针从 v3 原子替换为 v4  ← "Write"（改的是指针，不是数据）

结果：
  v4 → [T1, T2, T3, T4]  （新读者拿这个）
  v3 → [T1, T2, T3]       （老读者还在用，不受影响）
```

> **关键认知**：读者拿到 `_java_thread_list` 指针快照的瞬间，后续遍历用的是独立数组，与全局指针再无关系。写者的 `Atomic::xchg` 改的是全局指针——不影响读者手里的 v3 数组。两者不再共享可变内存。

这就是 CoW 名称的由来——"Copy"（拷贝旧数据到新数组）发生在每次"Write"（全局指针替换）时。

### 3.3 数据结构：ThreadsList

快照的容器是 `ThreadsList`（`threadSMR.hpp:158-200`）：

```cpp
class ThreadsList : public CHeapObj<mtThread> {
  const uint _length;                  // 包含的线程数量
  ThreadsList* _next_list;             // 待删除链表的 next 指针
  JavaThread *const *const _threads;   // 指向 JavaThread*[] 数组（只读）
  volatile intx _nested_handle_cnt;    // 嵌套遍历的引用计数（第 7 节详述）
};
```

关键设计：`_threads` 指向的数组在构造函数中分配，比 `_length` 多分配一个位置存 NULL 哨兵（`threadSMR.cpp:546-553`）：

```cpp
ThreadsList::ThreadsList(int entries) :
  _length(entries),
  _next_list(NULL),
  _threads(NEW_C_HEAP_ARRAY(JavaThread*, entries + 1, mtThread)),
  _nested_handle_cnt(0)
{
  *(JavaThread**)(_threads + entries) = NULL;  // 数组末尾的哨兵
}
```

为什么要 `entries + 1`？遍历代码不需要每次检查 `i < length`，直接遇到 NULL 就停——更简洁也更安全。

**为什么说 `_threads` 是数组？** 证据在 `threadSMR.hpp:188` 的 `thread_at()`：

```cpp
JavaThread *const thread_at(uint i) const { return _threads[i]; }
```

遍历 ThreadsList 时使用的是**数组下标 `_threads[i]`**（O(1) 随机访问），不是链表式的 `cur = cur->next()`。构造函数中 `NEW_C_HEAP_ARRAY(JavaThread*, entries + 1, mtThread)` 分配的是堆数组——`NEW_C_HEAP_ARRAY` 是 HotSpot 的堆数组分配宏，产生一块连续内存。ThreadsList 的核心能力正是 **O(1) 下标定位**，这是它区别于 `_thread_list` 链表的本质特征。

### 3.4 三层调用链：从入口往下看

CoW 的搜索入口在 `Threads::add()`（`thread.cpp:4456-4486`）：

**第 1 层 — `Threads::add()`：标准链表的写入口**

```cpp
void Threads::add(JavaThread* p, bool force_daemon) {
  assert(Threads_lock->owned_by_self(), "must have threads lock");  // <1> 锁由调用者持有
  p->set_next(_thread_list);
  _thread_list = p;                          // 头插入标准链表
  p->set_on_thread_list();
  _number_of_threads++;
  // ... daemon 计数 ...
  ThreadsSMRSupport::add_thread(p);          // <2> 同步更新 SMR 快照
}
```

`<1>` 行的 assert 明确了锁的持有关系：调用者——主线程在 `Threads::create_vm()` 中 `{ MutexLocker mu(Threads_lock); Threads::add(main_thread); }`（`thread.cpp:3860-3861`），普通线程在 `JavaThread::prepare()` 中调用时有同款 assert 保护（`thread.cpp:3180`）。

`<2>` 行是进入 CoW 系统的入口。

**第 2 层 — `ThreadsSMRSupport::add_thread()`：调度 CoW 三步**

```cpp
void ThreadsSMRSupport::add_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::add_thread(get_java_thread_list(), thread);  // ① 建新快照
  ThreadsList *old_list = xchg_java_thread_list(new_list);                          // ② 原子替换
  free_list(old_list);                                                              // ③ 回收旧快照
}
```

`xchg_java_thread_list()` 内部是 `Atomic::xchg(new_list, &_java_thread_list)`（`threadSMR.cpp:159-161`）——写者替换全局指针的唯一代码路径。新读者从此看到 v4，老读者手里的 v3 不受影响。

`free_list()` 不直接在此时 delete v3——它先检查有没有读者的 hazard ptr 还指着 v3。这引出了下文的 Hazard Pointer 机制。

**第 3 层 — `ThreadsList::add_thread()`：纯 Copy 操作**

```cpp
ThreadsList *ThreadsList::add_thread(ThreadsList *list, JavaThread *java_thread) {
  ThreadsList *const new_list = new ThreadsList(list->_length + 1);   // ① 分配新容器
  if (list->_length > 0) {
    Copy::disjoint_words(list->_threads, new_list->_threads,          // ② 全量 memcpy
                         list->_length);
  }
  *(JavaThread**)(new_list->_threads + list->_length) = java_thread;  // ③ 末尾追加
  return new_list;
}
```

全量拷贝而非原地追加——因为旧快照 v3 可能正被读者遍历，原地修改会破坏读者手里的数据。

**三层分工总结**：

| 层 | 函数 | 职责边界 |
|---|------|---------|
| 入口 | `Threads::add()` | 维护标准链表，最后触发 SMR 同步 |
| 编排 | `ThreadsSMRSupport::add_thread()` | 调度 CoW 三步：取旧→建新→替换→回收 |
| 底层 | `ThreadsList::add_thread()` | 纯 Copy 操作：分配 + 全量 memcpy + 尾追加 |

移除线程同理——`ThreadsSMRSupport::remove_thread()`（`threadSMR.cpp:917-933`）也是同样的三层结构，底层 `ThreadsList::remove_thread()` 分两段 memcpy 跳过目标线程。

### 3.5 CoW 解决了什么、留下了什么

**解决了**：读者无锁遍历。读者拿到的 `ThreadsList*` 指向一个独立数组——写者后续替换全局指针不影响这个数组。

**留下了**：旧快照何时删除？v3 在 reader 手中独立使用——不能当场 delete。但也不可无限堆积——每个 add/remove 都产生一个新的 ThreadsList，泄露十几个 snapshot 就能把内存吃空。必须有机制让写者知道"此刻是否还有人引用旧快照"。

`free_list()`（`threadSMR.cpp:779-845`）采用机会主义清理：先把旧快照挂入 `_to_delete_list` 链表排队，扫描所有线程的 hazard ptr——没人指的当场 delete，有人指的先留着等下次扫描。这就是下一节 Hazard Pointer 做的事。

---

## 4. 方案三：Hazard Pointer——安全删除

### 4.1 最简场景：读者先贴标签，写者再扫描

先讨论没有并发冲突的理想情况——读者已经把标签贴好了，写者才开始扫描。

**初始状态**：`_java_thread_list → v3 = [T1, T2]`。GC 拿到 v3 快照。

**Step 1 — 读者贴标签**：GC 把自己的 `_threads_hazard_ptr` 设为 v3。这是一个发布于所有线程可见内存中的公开声明："我正在用 v3，别删"。

```
GC: _threads_hazard_ptr = v3   // release_store_fence，其他核心可见
```

**Step 2 — 写者替换全局指针**：T2 线程退出。`remove_thread(T2)` 调用 `Atomic::xchg` 把全局指针从 v3 换为 v4 = [T1]。旧快照 v3 进入 `_to_delete_list` 排队。

**Step 3 — 写者扫描所有 hazard ptr**：`smr_delete(T2)` 调用 `is_a_protected_JavaThread(T2)`，扫描每个线程的 `_threads_hazard_ptr`——发现 GC 指着 v3，而 T2 在 v3 里。

```
扫描结果：
  T1:  _threads_hazard_ptr == NULL
  GC:  _threads_hazard_ptr == v3  ← 指着包含 T2 的快照
  结论：T2 还被保护，不能删
```

**注意**：hazard ptr 保护的是一整个 `ThreadsList`，不是单个 `JavaThread`。只要有人指着 v3，v3 里**所有**线程——包括 T2——都不能删。

**Step 4 — 写者等待**：在 `delete_lock` 上 wait，等读者释放 v3。

**Step 5 — 读者读完，摘标签**：GC 遍历完成，把 `_threads_hazard_ptr` 设为 NULL。同时 notify 等待中的写者。

**Step 6 — 写者重扫**：被唤醒后重扫——所有 hazard ptr 都是 NULL。T2 安全 `delete`。

用最简伪代码总结这个理想流程（其中不涉及两阶段协议——那是为解决并发窗口才加入的）：

```cpp
// 读者（GC）
ThreadsList* list = ThreadsSMRSupport::get_java_thread_list();
_threads_hazard_ptr = list;                      // 贴标签
for (int i = 0; i < list->length(); i++) {
  scan_oop(list->thread_at(i));                   // 无锁遍历
}
_threads_hazard_ptr = NULL;                       // 摘标签 + 通知等待者

// 写者（smr_delete）
while (is_a_protected_JavaThread(T2)) {           // 扫描所有 hazard ptr
  delete_lock()->wait();                          // 还有人引用就等
}
delete T2;                                        // 安全删除
```

`is_a_protected_JavaThread()`（`threadSMR.cpp:850-892`）的扫描覆盖两处来源：
- 在线程的 `_threads_hazard_ptr` 中（`ScanHazardPtrGatherProtectedThreadsClosure` 遍历所有线程收集 hazard ptr 指向的快照上的全部 `JavaThread*`）
- 在待删除列表中 `_nested_handle_cnt != 0` 的快照上（嵌套引用计数保护——第 7 节详述）

### 4.2 Hazard Pointer 解决了什么、留下了什么

**解决了**：旧快照的安全回收——写者在释放前扫描所有读者的标签，确认无人引用后才 delete。

**留下了**：上面的 6 步假设 GC **先**贴标签、T2 **后**扫描。现实中两者并发运行——GC 不持锁，T2 持锁。**贴标签和扫描之间没有同步屏障。** 如果 T2 在 GC 贴标签之前就扫描完了，T2 会错过 GC 的标签。

---

## 5. 并发窗口——"拿快照"和"贴标签"之间有缝隙

### 5.1 Race condition 完整时序

下面展示并发运行时的真实竞态：

```
时刻  GC（读者，无锁）                  T2（写者，持 Threads_lock）
────  ───────────────────────────────  ─────────────────────────────────
t1    list = get_java_thread_list()      // 拿到 v3 的指针
t2                                        remove_thread(T2) → new_list = v4
t3                                        xchg → 全局指针 = v4
t4                                        smr_delete(T2): 开始扫描
t5                                        扫描 GC:_threads_hazard_ptr
t6                                        结果: NULL（还没贴！）
t7                                        扫描结束: 全 NULL
t8                                        → delete T2（T2 已释放）
t9    _threads_hazard_ptr = list        ← 贴上标签
t10   list->thread_at(1) 是 T2         ← 野指针！T2 已被 delete
```

GC 在 `t1` 拿到了 v3 的指针，但 `t9` 才贴标签。T2 在 `t4`-`t8` 完成了全部扫描——此时 GC 的标签还是 NULL。等 GC 在 `t9` 贴上标签时，T2 已经不存在了。

### 5.2 为什么简单解法不奏效

- **加内存屏障？** 不行。问题不在 CPU 核心之间的可见性，而在**语义层面**：标签贴上去之后，GC 手里拿到的 v3 已经不再是全局指针指向的版本。“过期的标签保护过期的快照”没有意义。
- **持锁再贴？** 那就回到方案一了——读者又阻塞写者。
- **贴完了再拿快照？** 也不行。先贴 NULL → 拿快照 → 贴快照——拿快照和贴快照仍是两步，窗口依然在。

**问题的本质**：读端的"拿快照"和"贴标签"是两个操作，中间有一个缝隙。写端在这个缝隙里完成了全部删除。要想消除窗口，读者贴标签后必须**验证**自己手里的快照是不是**此刻**全局指针指向的版本。

---

## 6. 两阶段发布协议（tag/untag）

### 6.1 设计思路：两步验证分别防两种并发

解决窗口的关键是让"贴标签"变成一个**两阶段操作**：

**Phase 1 — tag（预报）**：贴一个"未验证"标签——最低 bit 置 1。告诉写者："我还没验证完，先别信我。"

**Phase 2 — untag（确认）**：做完两个验证后去掉 tag——标签从"未验证"变为"已验证"。

**验证①**：重读全局指针 `_java_thread_list`，确认没变。如果变了，说明写者在读者贴 tag 之前就做了 `Atomic::xchg`。读者手里的 v3 已经过期——标签指向的是一个正在被回收的快照。回到 Phase 1 用新的全局指针重试。

> 这一验证防的是**写者替换全局指针**的 race。读者读全局指针 → 写者替换全局指针 → 读者贴 tag——读者贴的标签针对的是旧快照，但全局指针已经指向新快照。重读能抓到这个变化。

**验证②**：CAS 去 tag。尝试把 tag 从"unverified"改为"verified"。如果写者在验证①和验证②之间扫描到了这个 tagged 标签，写者会主动用 CAS 把标签清为 NULL（抢走）。读者的 CAS 发现 expected 值已经是 NULL 而非 tagged 值——失败，回到 Phase 1 重试。

> 这一验证防的是**写者扫描 hazard ptr** 的 race。写者扫到 tagged 标签时，它所在的瞬间就是这个标签的"决定时刻"——写者不能等读者验证完再说，因为读者可能在同一个快照上验证通过。写者必须在扫描这一刻决定：信还是不信？信 tagged = 可能保护一个过期快照；不信 = 可能错过一个即将有效的标签。tag/untag 的设计选择是**不信**——主动抢走，让读者重试。

**为什么写者要主动抢 tagged 标签？** 因为写者必须在此刻决定"这个快照有无人保护"。它不能等——等就是放弃决策。而对于 tagged 标签，此刻唯一确定的信息是"这个标签尚未验证"，所以写者选择最安全的决策：清空它，让读者重新走两阶段流程。

### 6.2 tag bit 的存储和操作

`ThreadsList*` 在 64 位系统上 8 字节对齐，最低 3 bit 恒为零。借用最低 bit 做 tag 不影响指针解引用（`thread.hpp:162-170`）：

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

### 6.3 读者端：fast path 的两个验证

以下是 `SafeThreadsListPtr::acquire_stable_list_fast_path()`（`threadSMR.cpp:384-432`）的逻辑，按验证①②分步讲解：

**外层循环**（整段逻辑在 `while (true)` 中——任何验证失败就重试）：

```
① 拿到快照：
   threads = get_java_thread_list();      // load_acquire 读全局指针

② Phase 1 — 贴未验证标签：
   unverified = tag_hazard_ptr(threads);   // 最低 bit 置 1
   set_threads_hazard_ptr(unverified);     // release_store_fence 公开

③ 验证① — 重读全局指针确认版本：
   if (get_java_thread_list() != threads) {
       continue;                           // 变了 → 标签过期，从头重试
   }

④ Phase 2 — CAS 去 tag 确认：
   if (cmpxchg_threads_hazard_ptr(threads, unverified) == unverified) {
       break;                              // 成功 → 标签已验证，结束
   }
   // 失败 → 标签被写者抢走（设为 NULL），从头重试
```

③ 重读全局指针检查一个前提："我贴标签的时候，写者有没有在这之前替换了全局指针？" 读全局指针（load_acquire）→写者 Atomic::xchg 替换→贴标签（release_store_fence）——如果读者在贴标签后重读，发现全局指针变了，说明写者必然在贴标签之前就替换了。手里的 v3 已经过时，标签指向的是被回收的快照。

④ 的 CAS 检查："写者有没有在验证①之后、确认之前扫到我的 tagged 标签？" 如果写者先执行 `cmpxchg(NULL, tagged_v3)` 清空 → 读者的 CAS `cmpxchg(untagged_v3, tagged_v3)` 失败 → 外层循环重试。如果写者还没扫到 → CAS 成功 → 标签从 unverified 升级为 verified。

下面是这个流程在源码中的完整对应——你可以对照上面的步骤①-④逐行理解：

```cpp
void SafeThreadsListPtr::acquire_stable_list_fast_path() {
  assert(_thread != NULL, "sanity check");
  assert(_thread->get_threads_hazard_ptr() == NULL, "sanity check");

  ThreadsList* threads;
  while (true) {
    threads = ThreadsSMRSupport::get_java_thread_list();
    // ① 读当前全局指针（load_acquire）

    ThreadsList* unverified_threads = Thread::tag_hazard_ptr(threads);
    _thread->set_threads_hazard_ptr(unverified_threads);
    // ② 贴 tagged 标签（release_store_fence）

    if (ThreadsSMRSupport::get_java_thread_list() != threads) {
      continue;
      // ③ 验证① 失败 → 标签过期，重试
    }

    if (_thread->cmpxchg_threads_hazard_ptr(threads, unverified_threads)
        == unverified_threads) {
      break;
      // ④ 验证② 成功 → 标签正式生效
    }
    // ④ 验证② 失败 → 标签被抢，重试
  }

  _list = threads;
  verify_hazard_ptr_scanned();
}
```

### 6.4 写者端：扫描时抢 tagged 标签

写者扫描在 `ScanHazardPtrGatherProtectedThreadsClosure::do_thread()`（`threadSMR.cpp:234-278`）中：

```cpp
while (true) {
  current_list = thread->get_threads_hazard_ptr();
  if (current_list == NULL) {
    return;              // 无标签 → 不保护任何快照
  }

  if (!Thread::is_hazard_ptr_tagged(current_list)) break;
  // 标签已验证（untagged）→ 正常保护 —— 退出循环去收集该快照上的线程

  // 标签未验证（tagged）→ 抢走它
  if (thread->cmpxchg_threads_hazard_ptr(NULL, current_list) == current_list)
    return;              // 抢成功 → 读者重试，本次扫描不认这个标签
  // CAS 失败 → 读者恰好同时完成了去 tag → 重读 hazard_ptr → 回到 while 头部
}
// current_list 是已验证的标签 → 保护该快照上全部 JavaThread
AddThreadHazardPointerThreadClosure add_cl(_table);
current_list->threads_do(&add_cl);
```

写者的循环和读者的 while(true) 形成对称设计——两边都在重试，直到达成共识。要么写者抢走标签（读者重试），要么读者成功确认（写者尊重标签）。

### 6.5 tag/untag 解决了什么、留下了什么

**解决了**：把并发窗口压缩到一条 CAS 指令的粒度。验证①保证读者手中的快照版本有效；验证②保证标签不被写者在中途抢走。读者要么拿到验证通过的标签，要么从头重试——不会出现"我以为验证通过了但实际上对象已经被删了"的状态。

**留下了**：一个线程只有一个 `_threads_hazard_ptr`。如果这个线程在遍历线程列表的中途又触发了一次线程遍历——槽位被占，无法贴新标签。

---

## 7. 嵌套遍历——一个槽位怎么保护两个快照

### 7.1 动机：什么时候会发生嵌套

当一个线程正在遍历线程列表（外层），又触发了另一个需要遍历线程列表的操作（内层）。具体场景——VMThread 执行 GC 的同时 JFR 触发了线程采样：

```
Thread::current() (VMThread)
  │
  ├─ ThreadsListHandle tlh;
  │   // 外层：hazard_ptr = v3，GC 正在遍历线程栈
  │   // _threads_hazard_ptr 指向 v3
  │
  └─ while (jtiwh.next()) {
        // 遍历到线程 T_k
        // JFR 触发：采样 T_k 的栈帧
        // JFR 内部需要获取线程快照来确定 T_k 是否还有效
        │
        └─ ThreadsListHandle inner_tlh;
            // 内层：需要 _threads_hazard_ptr 存新标签
            // 但槽位已经被外层占了！
            // 如果直接覆盖 → 外层遍历到一半，hazard ptr 没了
            //               → 写者可能删掉外层正在用的 v3 快照
     }
```

同一个线程同时需要两个 hazard ptr——但每个线程只有一个 `_threads_hazard_ptr` 字段。外层的快照仍在使用中，不能释放；内层需要一个新快照，但没地方贴标签。

### 7.2 解决策略：把外层升级为引用计数

当发现 hazard ptr 已被占用时，走嵌套路径：

1. **外层脱离 hazard ptr 保护**：用引用计数替代。把外层正在用的 `ThreadsList*` 上的 `_nested_handle_cnt` 递增
2. **清空 hazard ptr 槽位**：腾出来
3. **内层走 fast path**：用刚腾出的槽位，照常走两阶段协议设新的 hazard ptr

关键在于：写者在 `is_a_protected_JavaThread()` 和 `free_list()` 中**同时检查两样东西**——hazard ptr 指向的快照 **和** `_to_delete_list` 中引用计数 > 0 的快照。外层虽然不在 hazard ptr 中，但引用计数保护了它。

### 7.3 源码实现

`acquire_stable_list()`（`threadSMR.cpp:366-380`）是嵌套和非嵌套的公共入口：

```cpp
void SafeThreadsListPtr::acquire_stable_list() {
  _needs_release = true;
  _previous = _thread->_threads_list_ptr;   // 保存上一级 SafeThreadsListPtr
  _thread->_threads_list_ptr = this;         // 把自己设为 previous 链的栈顶

  if (_thread->get_threads_hazard_ptr() == NULL) {
    acquire_stable_list_fast_path();          // 槽位空 → 常规路径
    return;
  }
  acquire_stable_list_nested_path();          // 槽位被占 → 嵌套路径
}
```

**`_previous` 链**：`_thread->_threads_list_ptr` 是一个单向链表——当嵌套发生时，外层 `SafeThreadsListPtr` 在链上，内层成为新的栈顶。释放时从栈顶往下恢复（`release_stable_list()` 中 `_thread->_threads_list_ptr = _previous`）。

**嵌套路径**（`threadSMR.cpp:437-467`）：

```cpp
void SafeThreadsListPtr::acquire_stable_list_nested_path() {
  ThreadsList* current_list = _previous->_list;
  // ① _list 字段在构造时已设置为外层 SafeThreadsListPtr 持有的 ThreadsList*

  current_list->inc_nested_handle_cnt();
  // ② 引用计数 +1——用 CAS 循环实现 MO_SEQ_CST 保证

  _previous->_has_ref_count = true;
  // ③ 标记外层为"引用计数模式"——释放时不再清空 hazard ptr，改为 dec 引用计数

  _thread->_threads_hazard_ptr = NULL;
  // ④ 清空 hazard ptr 槽位——腾给内层

  acquire_stable_list_fast_path();
  // ⑤ 走 fast path 设新的 hazard ptr
}
```

`inc_nested_handle_cnt()`（`threadSMR.cpp:624-638`）使用 CAS 循环而非 `Atomic::inc`，因为需要 MO_SEQ_CST 保证——确保引用计数递增和写者扫描之间的时序。

**释放时的两条路径**（`release_stable_list()`，`threadSMR.cpp:471-505`）：

```
if (_has_ref_count) {
    _list->dec_nested_handle_cnt();  // 引用计数 → 递减引用计数
} else {
    set_threads_hazard_ptr(NULL);    // 普通模式 → 清空 hazard ptr
}
```

**为什么写者也要检查 `_nested_handle_cnt`？** `free_list()`（`threadSMR.cpp:816`）和 `is_a_protected_JavaThread()`（`threadSMR.cpp:877`）在扫描时除了检查 hazard ptr，还会遍历 `_to_delete_list` 上引用计数 > 0 的快照——把上面的线程加入保护集。否则嵌套路径保护的外层快照会被误删。

---

## 8. 安全删除：`smr_delete()`

当一个线程退出后，最终需要释放它的 `JavaThread` 对象。`smr_delete()`（`threadSMR.cpp:944-1019`）是唯一的安全删除入口：

```cpp
void ThreadsSMRSupport::smr_delete(JavaThread *thread) {
  while (true) {
    {
      MutexLockerEx ml(Threads_lock, Mutex::_no_safepoint_check_flag);
      delete_lock()->lock_without_safepoint_check();
      set_delete_notify();

      if (!is_a_protected_JavaThread(thread)) {
        clear_delete_notify();
        delete_lock()->unlock();
        break;                              // ① 安全 → 退出循环去 delete
      }
      // ② 不安全 → 记录日志
    } // 释放 Threads_lock，准备 wait

    // ③ wait：被 release_stable_list 的 notify_all 唤醒
    delete_lock()->wait(Mutex::_no_safepoint_check_flag, 0,
                        !Mutex::_as_suspend_equivalent_flag);
    clear_delete_notify();
    delete_lock()->unlock();
    // 回到循环头部，重新扫描
  }
  delete thread;                            // ④ 安全删除
}
```

流程可以概括为 **"扫描—决策—wait—重试"循环**：

1. 持 `Threads_lock` + `delete_lock` 扫描所有 hazard ptr 和引用计数
2. 如果线程不受保护 → 立即 delete（这是最常见：读者早已释放）
3. 如果线程受保护 → 释放 `Threads_lock`，在 `delete_lock` 上 wait（`timeout=0`，无超时，直到被 notify 才返回）
4. 被 `release_stable_list()` 中的 `notify_all()` 唤醒后重新扫描

### 8.1 双重检查锁优化

`release_stable_list()` 中不是每次释放都 notify，而是用了双重检查锁（`threadSMR.cpp:500-504`）：

```cpp
if (ThreadsSMRSupport::delete_notify()) {
  ThreadsSMRSupport::release_stable_list_wake_up(_has_ref_count);
}
```

`delete_notify()` 读的是 `_delete_notify` flag（`OrderAccess::load_acquire`），这个 flag 只在 `smr_delete()` 中 `set_delete_notify()` 设为非零、`clear_delete_notify()` 设回零。大部分时候没有线程在 `smr_delete()` 中等待——双重检查锁避免了无谓的锁竞争。

---

## 9. 完整生命周期

### 9.1 SafeThreadsListPtr——协议的驱动者

`SafeThreadsListPtr`（`threadSMR.hpp:201-252`）是整个协议的抽象载体：

- **构造时**：如果 `acquire=true`，调用 `acquire_stable_list()` 获取受保护的快照
- **持有期间**：`_list` 字段指向受保护的 `ThreadsList*`——写者不会删除此快照或其上的线程
- **析构时**：如果 `_needs_release=true`，调用 `release_stable_list()` 释放保护——清空 hazard ptr 或递减引用计数，必要时 notify 等待中的写者
- **复制构造**：转移所有权——`other._needs_release = false`，避免双重释放
- **`_previous` 链**：每个线程通过 `_thread->_threads_list_ptr` 维护当前作用域栈——外层 `SafeThreadsListPtr` 在栈底，嵌套的内层在栈顶

### 9.2 两个常用子类

| 子类 | 使用场景 | 行为 |
|------|---------|------|
| `ThreadsListHandle` | GC 根扫描、JVMTI 线程枚举 | 构造时自动 acquire，析构时自动 release |
| `ThreadsListSetter` | thread dump、死锁检测 | 构造时不 acquire——由调用者手动 `set()` |

`ThreadsListHandle` 是最常见的读者工具——一个函数内获取、遍历、释放，不需要手动管理：

```cpp
// GC 线程典型用法
ThreadsListHandle tlh;                     // 构造 → acquire_stable_list()
for (JavaThreadIteratorWithHandle jtiwh;
     JavaThread *jt = jtiwh.next(); ) {
  // jt 受 tlh 保护——smr_delete 在此作用域内不会 delete
}
// tlh 析构 → release_stable_list()
```

`ThreadsListSetter` 用于"先初始化容器，后按需获取"的模式——比如 thread dump 可能需要跨多个方法传递，但何时获取保护由调用者决定（`threadService.hpp:380`, `vmOperations.hpp:435`）。

---

## 10. GC 读快照——会不会漏 oop？

一个常见疑问：GC 拿到的只是某个瞬间的 `ThreadsList` 快照。如果快照里没有新创建的线程——GC 会漏掉栈上的 oop 吗？如果快照里有已退出的线程——会访问已释放内存吗？

### 情况 A：Stop-the-World GC（Serial / Parallel Full GC / CMS remark）

**不会漏，也不会悬空。**

STW GC 在 safepoint 中运行。`Threads::add()` 和 `Threads::remove()` 需要 `Threads_lock`——而锁的获取前提是**不在 safepoint 中**。GC 拿到的快照就是此刻全部活着的 Java 线程——不存在"快照之外创建的新线程"，因为此时根本没人能动线程列表。

### 情况 B：并发 GC（G1 concurrent marking / ZGC / Shenandoah）

**快照可能不全，但 GC 不会漏 oop。**

并发标记期间确有新线程出生、旧线程退出。GC 拿到的 `ThreadsList` 快照可能不是全体活线程的完整集合。但并发 GC 不唯一依赖 `ThreadsList` 来判定 oop 存活：

1. **SATB（Snapshot-At-The-Beginning）**：G1 并发标记开始时建立逻辑快照——所有此刻已存在的对象标记为存活。并发期间新线程分配的 oop 通过 SATB 写屏障记录到 SATB 缓冲区（`G1BarrierSet`）——即使新线程不在 `ThreadsList` 快照中，其分配的 oop 也会被标记。
2. **Card Table**：任何线程写入引用时更新 card table——并发期间新线程的引用写入同样标记脏 card。remark 阶段会扫描脏 card。
3. **Remark 阶段重新进入 safepoint**：G1 的 remark（`G1CMRemarkTask::work()`, `g1ConcurrentMark.cpp:1839`）在 safepoint 下调用 `Threads::threads_do()` **重新扫描全体线程栈**，处理并发期间积累的 SATB 缓冲区。

`ThreadsList` 快照是线程栈根扫描的起点；SATB 写屏障和 safepoint remark 兜底保证了 oop 的完整性。两者配合，快照不是唯一的信息来源。

---

## 11. 全文总结

### 11.1 方案演进全景

| 步骤 | 方案 | 解决的问题 | 留下的问题 |
|------|------|-----------|-----------|
| 1 | 全局锁 `Threads_lock` | 最基本的并发安全 | 读者阻塞写者——GC 冻结全部线程创建/退出 |
| 2 | Copy-on-Write + `Atomic::xchg` | 读者无锁遍历——读者手里是独立数组 | 旧快照何时删除？v3 在 reader 手里，不能删 |
| 3 | Hazard Pointer | 写者扫描标签——知道何时安全删除 | 贴标签有并发窗口——写者可能在贴标签前就扫完了 |
| 4 | tag/untag 两阶段协议 | 验证①防全局指针替换，验证②防标签被抢 | 单槽位——一个线程只有一个 `_threads_hazard_ptr` |
| 5 | 嵌套路径 + `_nested_handle_cnt` | 外层升级为引用计数，内层走 fast path | 写者必须同时检查 hazard ptr 和引用计数（已实现） |
| 6 | `free_list()` 机会主义回收 | 每次 add/remove 顺手清理 `_to_delete_list` | `_to_delete_list` 链表的非阻塞维护（已实现） |

### 11.2 五个字段的意义

回到 `Thread::Thread()` 构造函数初始化（`thread.cpp:242-245`）——现在你能理解每一行了：

```cpp
_oops_do_parity = 0;               // GC 并行标记 parity，防止同一次 GC 内重复扫描
_threads_hazard_ptr = NULL;        // ThreadsList* volatile — Hazard Pointer 本体
_threads_list_ptr = NULL;          // SafeThreadsListPtr* — 嵌套遍历的 _previous 链栈顶
_nested_threads_hazard_ptr_cnt = 0; // 统计用——当前嵌套深度（仅 -XX:+EnableThreadSMRStatistics）
_rcu_counter = 0;                  // GlobalCounter 代际计数——平行机制，非线程列表场景
```

所有字段此刻为 NULL/0——线程尚未加入 `_thread_list`，SMR 协议未启动。当 `Threads::add(p)` 第一次调用 `ThreadsSMRSupport::add_thread(p)` 时，`_java_thread_list` 从空数组变为 `[p]`，协议开始运转。

### 11.3 从初始化到生效

```
Thread::Thread()   → 5 字段全 NULL/0           → 构造函数完成
Threads::add(p)    → 头插入 _thread_list        → 维护标准链表
                   → ThreadsSMRSupport::add_thread(p)
                   → 创建第一个 ThreadsList 快照  → CoW 启动
运行时               → GC 用 ThreadsListHandle    → 读者无锁遍历
                   → 线程退出用 smr_delete()      → 写者安全删除
```

至此 Thread-SMR 的完整设计已讲透。这项设计在 `thread.cpp:242-245` 中只占用 5 行初始化代码——但在运行时支撑着 JVM 线程管理的全部并发安全。
