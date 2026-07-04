# 前置概念：Thread-SMR —— 线程列表的安全并发访问

> **本文定位**：背景知识文章。不依赖章节正文——你要理解的是 HotSpot 如何让 GC、jstack、JVMTI、JFR 等"读者"无需持有全局锁就能安全遍历线程列表，同时线程的创建和退出（"写者"）不被阻塞。

---

## 1. 核心矛盾——读者和写者的天然冲突

JVM 运行中的一个典型时刻：

- `Threads::_thread_list`（`thread.hpp:2205`，`static JavaThread*`）是一条单向链表，串联着 JVM 中全部活着的 `JavaThread` 节点。
- **读者**：GC 的 VMThread（`Threads::threads_do()`，扫描线程栈上的 oop 根）、jstack/JCMD（`Threads::print_on()`，dump 线程栈）、JVMTI agent（`GetAllThreads()`，枚举线程）、JFR sampler（线程采样）。单次遍历耗时几百微秒。
- **写者**：`Threads::add()`（新线程创建，O(1) 头插入链表）、`Threads::remove()`（线程退出，O(n) 链表摘除）。单次操作耗时几微秒。

**核心的数据约束**：读取频率远高于写入频率，但单次读耗时远长于单次写耗时。

JDK 8 的做法最直接——读者拿 `Threads_lock` 遍历，写完也拿同一个锁：

```
读者（GC）：MutexLocker mu(Threads_lock);  // 持锁，几百微秒
          for (cur = _thread_list; cur != NULL; cur = cur->next())
              scan_oop(cur);
          退出作用域，释放锁

写者（新线程）：MutexLocker mu(Threads_lock);  // 等...直到 GC 释放锁
              // 头插入 _thread_list
```

**问题不在正确性——在性能。** 线程创建每几十微秒一次，GC 扫描几百微秒。GC 持锁期间，任何线程无法创建也无法退出。这是**读者阻塞写者**的经典场景。

**目标**：让读者不持锁就能安全遍历线程列表，同时写者不受阻塞。

---

## 2. 两个列表并存——分离读写数据路径

### 2.1 为什么一个 `_thread_list` 不够

`_thread_list` 是一条可变链表。`Threads::add()`（`thread.cpp:4464-4465`）和 `Threads::remove()` 原地修改 `_next` 指针。读者和写者**共享同一块可变内存**——没有保护机制的情况下，读者随时可能读到半修改的指针或跳到已释放的内存。

要安全只能加锁。所以只要数据容器不变，就逃不开"读者阻塞写者"的困境。

### 2.2 设计决策：两个容器，分工明确

**思路**：给读者一个**独立的、不可变的容器**。读者遍历这个容器时，写者对 `_thread_list` 的修改完全不触碰它。两个容器包含相同的 `JavaThread*` 集合——同一份数据，两种表示。

- `_thread_list`（链表）：给写者用。O(1) 头插入，原地修改 `_next` 指针。全部写操作在 `Threads_lock` 保护下完成——写者之间互斥，不受读者影响。
- `_java_thread_list`（`threadSMR.hpp:108`，`ThreadsList* volatile`）：给读者用。这是一个**快照容器**——内部是一个 `JavaThread*[]` 数组，O(1) 下标访问 `thread_at(i)`。它解决的不只是"无锁遍历"问题，还包括"O(1) 定位"——这两个维度在链表上都无法做到。

| 全局变量 | 类型 | 容器形式 | 访问方式 | 使用者 |
|---------|------|---------|---------|--------|
| `_thread_list` (`thread.hpp:2205`) | `static JavaThread*` | 单向链表 | O(1) 头插 / O(n) 遍历 | 写者（Threads::add/remove） |
| `_java_thread_list` (`threadSMR.hpp:108`) | `static ThreadsList* volatile` | 数组快照 | O(1) 下标访问 `thread_at(i)` | 读者（GC/jstack/JVMTI/JFR） |

**两者必须同步**。`Threads::add()`（`thread.cpp:4464`）在持锁状态下先头插入 `_thread_list` 链表，最后调用 `ThreadsSMRSupport::add_thread(p)` 同步更新 `_java_thread_list` 快照。`Threads::remove()` 同理。两个容器在**同一个函数、同一个持锁范围**内同步维护——永远包含相同的 `JavaThread*` 集合。

`ThreadsSMRSupport` 是这套机制的名称空间——一个 **全静态类**（`threadSMR.hpp:88`，`class ThreadsSMRSupport : AllStatic`）。所有方法和字段都是 `static`，JVM 中不存在它的实例。作为全局协调器，它管理 `_java_thread_list`（全局 CoW 快照指针）、`_to_delete_list`（待删除旧快照的链表头）和 `_delete_notify`（双重检查锁 flag，第 7.3 节详述）等关键状态。

```
全局状态示意图：

Threads::_thread_list      → JavaThread(T3) → JavaThread(T2) → JavaThread(T1) → NULL
                               ↑ 链表，通过 _next 串接，写者原地修改

ThreadsSMRSupport::
_java_thread_list          → ThreadsList
                               │ _length = 3
                               │ _threads → [T3, T2, T1, NULL]  ← 数组快照，读者只读
                               │             ↑ 末尾 NULL 哨兵，遍历时遇 NULL 即止
                               └ 写者通过 CoW 产生新版本，不改旧版本
```

**初始化状态**（`thread.cpp:242-245`, `threadSMR.cpp:75`）：
```cpp
Threads::_thread_list       = NULL;                            // POD 默认 NULL，链表为空
ThreadsSMRSupport::
_java_thread_list           = new ThreadsList(0);              // 空快照，不是 NULL
_to_delete_list             = NULL;
```

### 2.3 谁读谁写

- **写者** 修改 `_thread_list`（链表），更新后顺带触发 `_java_thread_list` 的快照重建。
- **读者** 只读 `_java_thread_list`（快照），不碰 `_thread_list` 链表。线程自己也不读 `_java_thread_list`——它通过 `Threads::add()` 和 `Threads::remove()` 修改链表，快照只是这套修改的"只读投影"。
- 读者群体：GC 的 VMThread、jstack/JCMD、JVMTI agent、JFR sampler。

**没有两个列表行不行？** 不行。只有一个链表 → 读者和写者共享可变内存 → 必须加锁 → 读者阻塞写者。只有一个数组 → 写者的插入/删除需要 O(n) 全量重分配，无法做到 O(1) 头插入。

### 2.4 留下的问题

写者如何在读者无感知的情况下更新 `_java_thread_list`？直接原地修改数组 → 如果读者正在遍历 → 数据不一致。必须让每次更新产生一个**新版本**的快照。第 3 节解决这个问题。

---

## 3. 写时拷贝（CoW）——保证快照绝对不可变

### 3.1 为什么必须全量拷贝而非原地修改

读者通过 `get_java_thread_list()`（`threadSMR.inline.hpp:81`，`OrderAccess::load_acquire`）拿到当前全局快照的 `ThreadsList*` 指针。拿到之后，后续遍历用的是指针指向的 `_threads` 数组。

如果写者原地修改这个数组——尾追加新 `JavaThread*`、中删除旧 `JavaThread*`——读者正在遍历时某些槽位的值在变。读者可能看到重复线程、跳过有效线程，或者读到半写入的指针。

**增量更新的另一个致命问题**：即使写者用 CAS 原子地替换单个数组元素，读者在遍历过程中看到的快照也不再是某个时刻的"完整截图"——它是多个时刻的混合物。这破坏了对读者最基本的语义承诺：你在遍历的这个快照，代表某个确定时刻的线程集合。

### 3.2 设计决策：写时全量拷贝，只改全局指针

CoW 的核心规则只有一条：**任何写者不修改已发布的快照。要改，就建一份新副本，然后原子替换全局指针。**

```
add_thread(T3) 的三个步骤：

① 建新快照 v4：
   new_list = new ThreadsList(v3._length + 1)
   Copy::disjoint_words(v3._threads, v4._threads, v3._length)  ← 全量 memcpy
   v4._threads[末尾] = T3                                       ← 尾追加

② 原子替换：Atomic::xchg(v4, &_java_thread_list)
   返回旧值 v3。全局指针现在指向 v4——新读者从此看到 v4。
   v3 脱离全局指针，但老读者手里的 v3 指针不受影响。

③ 回收旧快照：free_list(v3)
   v3 挂入 _to_delete_list 排队——何时 delete 由第 5 节的 Hazard Pointer 决定。
```

**关键认知**：读者拿到 `ThreadsList*` 指针的那一刻，后续遍历用的是独立内存——写者的 `Atomic::xchg` 改的是全局指针，不影响老读者手中的内容。两者不再共享可变内存。这就是 CoW 名称的由来——"Copy"（全量 memcpy）发生在每次"Write"（全局指针替换）时。

### 3.3 容器结构：ThreadsList

`ThreadsList`（`threadSMR.hpp:158-196`）是只读快照的容器。核心字段：

```cpp
class ThreadsList : public CHeapObj<mtThread> {
  const uint _length;                    // 包含的线程数量
  ThreadsList* _next_list;               // _to_delete_list 的链指针
  JavaThread *const *const _threads;     // 指向堆上 JavaThread*[] 数组
  volatile intx _nested_handle_cnt;      // 嵌套引用计数（第 6 节详述）
};
```

`_threads` 是 `JavaThread *const *const`——指针和指向的内容都是 const。一旦构造完成，数组内容不再变化。构造函数分配 `entries + 1` 个槽位，末尾固定存 NULL 哨兵（`threadSMR.cpp:546-553`）：

```cpp
ThreadsList(int entries) :
  _length(entries),
  _threads(NEW_C_HEAP_ARRAY(JavaThread*, entries + 1, mtThread)) {
  *(JavaThread**)(_threads + entries) = NULL;  // 哨兵，遍历遇 NULL 即止
}
```

**为什么说是数组？** 证据在 `threadSMR.hpp:188`：`thread_at(i)` 用 `_threads[i]` 下标访问——O(1) 随机访问，不是链表的 `cur = cur->next()`。

### 3.4 三层调用链——从入口往下看

**第 1 层 — `Threads::add()`**（`thread.cpp:4458-4488`）—维护标准链表：

```cpp
void Threads::add(JavaThread* p, bool force_daemon) {
  assert(Threads_lock->owned_by_self(), "must have threads lock"); // ← 调用者已持锁
  p->set_next(_thread_list);
  _thread_list = p;                          // 头插入链表（O(1)）
  p->set_on_thread_list();
  _number_of_threads++;
  // ...
  ThreadsSMRSupport::add_thread(p);          // ← 进入 SMR 第二层
}
```

锁由调用者持有：主线程在 `Threads::create_vm()` 中 `{ MutexLocker mu(Threads_lock); Threads::add(main_thread); }`（`thread.cpp:3862-3863`），普通线程的 `JavaThread::prepare()` 调用前有同款 assert（`thread.cpp:3180`）。

**第 2 层 — `ThreadsSMRSupport::add_thread()`**（`threadSMR.cpp:743-758`）—调度 CoW 三步：

```cpp
void ThreadsSMRSupport::add_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::add_thread(get_java_thread_list(), thread);
  ThreadsList *old_list = xchg_java_thread_list(new_list);    // Atomic::xchg
  free_list(old_list);                                        // 第 5 节详述
}
```

- `get_java_thread_list()`：`OrderAccess::load_acquire` 读取当前全局指针。
- `xchg_java_thread_list()`（`threadSMR.cpp:159-161`）：`Atomic::xchg(new_list, &_java_thread_list)`，原子替换全局指针的唯一代码路径。返回的旧值（v3）从全局指针脱离，此后只有仍持有旧指针的读者能访问。
- `free_list(old_list)`：旧快照回收——第 5 节的 Hazard Pointer 决定它何时被 delete。本节下文 3.5 先看两个完整例子，展示数据结构在各步中的变化。

**第 3 层 — `ThreadsList::add_thread()`**（`threadSMR.cpp:562-574`）—纯 Copy 操作：

```cpp
ThreadsList *ThreadsList::add_thread(ThreadsList *list, JavaThread *jt) {
  ThreadsList *const new_list = new ThreadsList(list->_length + 1);
  if (list->_length > 0) {
    Copy::disjoint_words(list->_threads, new_list->_threads, list->_length); // 全量 memcpy
  }
  *(JavaThread**)(new_list->_threads + list->_length) = jt;  // 尾追加
  return new_list;
}
```

最底层不读全局指针，不涉及替换回收。纯 Copy：分配 → memcpy → 尾追加。`remove_thread` 同理——分配 `length-1` 的新容器，分两段 memcpy 跳过目标线程。

**三层分工**：

| 层 | 函数 | 职责边界 |
|---|------|---------|
| 入口 | `Threads::add()` | 维护标准链表，末尾触发 SMR 同步 |
| 编排 | `ThreadsSMRSupport::add_thread()` | 调度 CoW 三步：取旧→建新→替换→回收 |
| 底层 | `ThreadsList::add_thread()` | 纯 Copy 操作：分配 + 全量 memcpy + 尾追加 |

### 3.5 两个完整例子——从空集到运行时

**例子一：JVM 启动——第一个线程加入**

`Threads::create_vm()`（`thread.cpp:3862-3863`）中显式持锁：

```cpp
{ MutexLocker mu(Threads_lock);
  Threads::add(main_thread);             // thread.cpp:3863
}
```

初始状态：`_thread_list = NULL`，`_java_thread_list → ThreadsList(0) { _threads → [NULL] }`。

```
Threads::add(main_thread) 内：
  头插入 → _thread_list → JavaThread(main_thread) → NULL

ThreadsSMRSupport::add_thread(main_thread) 内：
  ① get_java_thread_list() → ThreadsList(0)          ← 当前空快照
  ② ThreadsList::add_thread(ThreadsList(0), main_thread):
       new ThreadsList(1) → _threads = [main_thread, NULL]   ← length=1，分配了 2 个元素
       因为 v0._length = 0，跳过 memcpy 分支
  ③ xchg_java_thread_list(v1):
       Atomic::xchg(v1, &_java_thread_list) → 返回旧值 v0
       替换后: _java_thread_list → v1 = ThreadsList(1) { [main_thread, NULL] }
              old_list = v0 = ThreadsList(0) { [NULL] }          ← 脱离全局
  ④ free_list(v0):
       v0 挂入 _to_delete_list → 扫描发现无人引用 → delete v0
       _to_delete_list 回到 NULL

最终状态：
  _thread_list       → JavaThread(main_thread) → NULL
  _java_thread_list  → ThreadsList(v1) { [main_thread, NULL] }
  _to_delete_list    == NULL
```

**例子二：运行时追加——第三个线程加入**

已有 T1、T2 在运行。`_thread_list → T2 → T1`，`_java_thread_list → v3 { [T2, T1, NULL] }`。

新线程 T3 走一样的流程：

```
Threads::add(T3):
  头插入 → _thread_list → T3 → T2 → T1 → NULL

ThreadsSMRSupport::add_thread(T3):
  ① v3 = get_java_thread_list()  → ThreadsList(v3) { [T2, T1, NULL] }
  ② v4 = ThreadsList::add_thread(v3, T3) → v4 { [T2, T1, T3, NULL] }
     |_ 分配 4 个元素的数组，memcpy v3 的 2 个线程，尾追加 T3
  ③ xchg: _java_thread_list 从 v3 变为 v4，old_list = v3
  ④ free_list(v3):
       扫描所有 hazard ptr → 全部 NULL → v3 当场 delete
       或: GC._threads_hazard_ptr == v3 → v3 留在 _to_delete_list 中排队

最终状态（无人引用）：
  _thread_list       → T3 → T2 → T1 → NULL
  _java_thread_list  → ThreadsList(v4) { [T2, T1, T3, NULL] }
  _to_delete_list    == NULL

最终状态（GC 还在读 v3）：
  _thread_list       → T3 → T2 → T1 → NULL
  _java_thread_list  → ThreadsList(v4) { [T2, T1, T3, NULL] }
  _to_delete_list    → ThreadsList(v3) { [T2, T1, NULL] }
  GC._threads_hazard_ptr == v3
```

### 3.6 CoW 留下了什么问题

**解决**：读者无锁遍历——拿到的 `ThreadsList*` 指向独立内存，写者的全局指针替换不影响老读者。

**留下**：旧快照何时删除？v3 在 reader 手中独立使用，不能当场 delete。但每次 add/remove 都产生一个新的 ThreadsList——不回收就泄漏。`free_list()` 先把 v3 挂入 `_to_delete_list` 排队——但它怎么知道"此刻是否还有人引用 v3"？这引出了下一个机制。

---

## 4. Hazard Pointer——让写者感知读者正在使用哪个快照

### 4.1 最简场景——读者先贴标签，写者再扫描

从 CoW 的遗留问题出发：旧快照 v3 脱离全局指针后，如果还有读者在遍历 v3——不能 delete。写者需要知道：**此刻有没有读者正在使用我要删除的旧快照？**

**设计思路**：读者在使用快照前，先在某个写者能扫描到的公共位置贴一个标签。标签内容 = 正在使用的 `ThreadsList*` 指针。写者删除前扫描所有标签——没看到自己要删的快照 → 安全；看到了 → 等待。

这个公共标签就是每个 `JavaThread` 对象上的 `_threads_hazard_ptr` 字段（`thread.hpp:157`，`ThreadsList* volatile`）。值为 NULL（空闲）或指向某个 ThreadsList 快照（受保护）。**hazard ptr 保护的是整个 ThreadsList，不是单个 JavaThread**——只要有人指着 v3，v3 上全部线程都不能删。

先讨论没有并发冲突的理想情况——读者已经把标签贴好了，写者才开始扫描。

**初始状态**：两个活跃线程 T1、T2。`_java_thread_list → v3 { [T2, T1, NULL] }`。所有 `_threads_hazard_ptr == NULL`。

**Step A — GC（读者）贴标签**：

```
GC._threads_hazard_ptr = v3
  // 公开声明："我正在遍历 v3 快照，v3 上全部 JavaThread(T2, T1) 都别删"
```

**Step B — T2 退出，写者从两个列表移除 T2**。JavaThread(T2) 对象尚未 delete——只做了"从列表移除"。

T2 退出路径（`Threads::remove(T2)`，持 `Threads_lock`）：
- **B1**：从标准链表摘除 T2——`_thread_list` 原地修改为 `JavaThread(T1) → NULL`。T2 的 `_next` 被绕过，但对象本身还在内存中。
- **B2**：更新 CoW 快照——`ThreadsSMRSupport::remove_thread(T2)` 建新快照 `v4 { [T1, NULL] }`，`Atomic::xchg` 替换全局指针，`free_list(v3)` 挂入 `_to_delete_list`。

此时状态：
```
_thread_list       → T1 → NULL
_java_thread_list  → v4 { [T1, NULL] }
_to_delete_list    → v3 { [T2, T1, NULL] }    ← v3 在这排队，T2 还在 v3 里
GC._threads_hazard_ptr     == v3              ← 指着 v3
T1._threads_hazard_ptr     == NULL
```

**Step C — 写者调用 `smr_delete(T2)`，扫描决定能否 delete**。

`smr_delete()` 的第一环是 `is_a_protected_JavaThread(T2)`（`threadSMR.cpp:850-892`）——扫描所有线程的 `_threads_hazard_ptr`：

```
扫描过程：
  T1: _threads_hazard_ptr == NULL
  GC: _threads_hazard_ptr == v3  ← 指着 v3
  ↓
  收集 v3 快照上的所有 JavaThread → {T1, T2} → 结论：T2 在受保护集合中
```

**Step D — 写者等待**：T2 受保护 → `smr_delete()` 在 `delete_lock` 上 `wait()`。释放 `Threads_lock`，让其他线程继续运行。

**Step E — 读者读完，摘标签，通知写者**：

```
GC._threads_hazard_ptr = NULL               // 摘标签——不再保护 v3
release_stable_list_wake_up() → notify_all   // 唤醒等待者
```

**Step F — 写者被唤醒，重扫，安全删除**：

`smr_delete()` 的 `wait()` 返回，外层 `while(true)` 重新循环：
```
① 持 Threads_lock + delete_lock
② is_a_protected_JavaThread(T2) → false （所有 hazard_ptr == NULL）
③ break → delete T2
```

用最简伪代码总结：

```cpp
// 读者（GC）
ThreadsList* list = get_java_thread_list();    // 拿快照
_threads_hazard_ptr = list;                    // 贴标签
for (int i = 0; i < list->length(); i++)
  scan_oop(list->thread_at(i));                // 无锁遍历
_threads_hazard_ptr = NULL;                    // 摘标签 + notify

// 写者（T2 退出 → Threads::remove(T2) → smr_delete(T2)）
while (is_a_protected_JavaThread(T2)) {       // 扫描所有 hazard ptr
  delete_lock()->wait();                      // 有人引用就等
}
delete T2;                                     // 安全删除
```

### 4.2 并发窗口——贴标签和扫描之间有缝隙

4.1 节假设读者**先**贴标签、写者**后**扫描。但现实中两者并发运行——读者不持锁，写者随时可能扫描。

**概念过渡**：读者"拿快照"和"贴标签"是两个独立操作，中间有一个缝隙。如果写者在这个缝隙里完成了全部扫描——写者认为无人保护 → delete 目标线程 → 读者随后贴标签指向已释放内存 → 野指针。

下面展示这个竞态条件的完整时序：

```
时刻  GC（读者，无锁）                   T2（写者，持 Threads_lock）
────  ───────────────────────────────  ─────────────────────────────────
t1    list = get_java_thread_list()     ← 拿到 v3 指针，但还没贴标签
t2                                       Threads::remove(T2) → CoW 建 v4
t3                                       Atomic::xchg → _java_thread_list = v4
t4                                       smr_delete(T2): 开始扫描
t5                                         scan GC._threads_hazard_ptr
t6                                         → NULL （还没贴！）
t7                                       扫描结束：全 NULL → 无人保护
t8                                       delete T2 ← T2 已释放！
t9    _threads_hazard_ptr = list       ← 贴上标签，但 list=v3，T2 已 delete
t10   list->thread_at(1) 是 T2        ← 野指针！
```

**根本原因**：读端的"拿快照"和"贴标签"是两步。写端在这个窗口里完成了全部删除。

**为什么简单解法不奏效**：
- 加内存屏障？不行。问题不在 CPU 核心间可见性，而在语义层面：标签贴在已过时的快照上没意义。
- 持锁再贴标签？回到方案一——读者阻塞写者。
- 先贴 NULL → 拿快照 → 贴快照？仍是两步，窗口依然在。

**解决方向**：读者贴标签后需要**验证**自己手里的快照是否仍然有效。如果发现快照已经过时（全局指针已变），就重试。

### 4.3 留下的问题

如何让"贴标签"和"验证快照有效性"成为一个原子化的操作序列？第 5 节的 tag/untag 两阶段协议回答这个问题。

---

## 5. 两阶段发布协议（tag/untag）——压缩并发窗口

### 5.1 设计思路——把标签分两级

第 4.2 节揭示的本质问题："拿快照"和"贴标签"是两个操作，中间有缝隙。根源不在操作数量——而在于**写者无法区分"还没贴完的标签"和"已确认有效的标签"**。

**解决方案**：让标签有一个"未验证"状态。写者看到这个状态就知道此标签还不能信。

- **Phase 1 — tag（预报）**：贴"未验证"标签（指针最低 bit = 1）。意味："我要保护这个快照，但还没验证它是不是最新版本。先别信我。"
- **Phase 2 — untag（确认）**：做完两个验证后去 tag（最低 bit = 0）。标签从"未验证"升级为"已验证"。

这两个验证分别防两种不同的并发：

| 验证 | 防的 race | 检查方式 |
|------|----------|---------|
| 验证① | 写者在读者贴标签之前替换了全局指针 | 重读 `_java_thread_list`——变了 = 标签过期，重试 |
| 验证② | 写者在读者验证①通过后、去 tag 前抢走了标签 | CAS 去 tag——失败 = 被抢，重试 |

**为什么写者要主动抢 tagged 标签？** 写者持 `Threads_lock` 扫描——它在此刻必须决策。如果它等读者验证完——等待 = 释放 `Threads_lock` = 其他写者可能修改数据 = 复杂性爆炸。所以设计选择是**不信**——抢走（CAS 清为 NULL），让读者重试。代价：让读者多跑一次 CAS（不到 100ns）。

### 5.2 tag bit 的存储

`ThreadsList*` 在 64 位系统上 8 字节对齐，最低 3 bit 恒为 0。借用最低 bit 做 tag，解引用前抹掉最低 bit 即可（`thread.hpp:162-170`）：

```cpp
static ThreadsList* tag_hazard_ptr(ThreadsList* list)   { return (ThreadsList*)(intptr_t(list) | 1); }
static ThreadsList* untag_hazard_ptr(ThreadsList* list) { return (ThreadsList*)(intptr_t(list) & ~1); }
static bool is_hazard_ptr_tagged(ThreadsList* list)     { return (intptr_t(list) & 1) == 1; }
```

### 5.3 读者端——`acquire_stable_list_fast_path()`

`SafeThreadsListPtr::acquire_stable_list_fast_path()`（`threadSMR.cpp:384-432`）在 `while(true)` 中循环四步：

```
① 拿快照：
   threads = get_java_thread_list();         // load_acquire 读全局指针

② Phase 1 — 贴未验证标签：
   unverified = tag_hazard_ptr(threads);     // 最低 bit 置 1
   set_threads_hazard_ptr(unverified);       // release_store_fence 公开

③ 验证① — 重读全局指针确认版本：
   if (get_java_thread_list() != threads)    // 全局指针变了？
       continue;                             // 变了 → 标签过期，从头重试

④ Phase 2 — CAS 去 tag 确认：
   if (cmpxchg_threads_hazard_ptr(threads, unverified) == unverified)
       break;                                // CAS 成功 → 标签正式生效
   // CAS 失败 → 标签被写者抢走（设为 NULL）→ 重试
```

**验证① 的逻辑**：读者贴了 tagged 标签后重读全局指针。如果全局指针已变——说明写者在读者贴标签**之前**就做了 `Atomic::xchg`。读者手里的 v3 已经过时，标签指向的 ThreadsList 正在被回收。回到循环头用新的全局指针重试。

**验证② 的逻辑**：验证①通过后，从 tagged 变 untagged。这个 CAS 检查的是"写者有没有在验证①之后、去 tag 之前扫到了我的 tagged 标签"。如果写者抢走了（CAS 为 NULL）→ 读者 CAS 失败 → 重试。如果写者没抢 → CAS 成功 → 标签正式生效。

### 5.4 写者端——扫描时抢 tagged 标签

`ScanHazardPtrGatherProtectedThreadsClosure::do_thread()`（`threadSMR.cpp:234-278`）对待不同标签有两种行为：

```cpp
while (true) {
  current_list = thread->get_threads_hazard_ptr();
  if (current_list == NULL) return;              // 无标签 → 不保护

  if (!Thread::is_hazard_ptr_tagged(current_list)) break;
  // untagged（已验证）→ 正常保护该快照上的全部 JavaThread

  if (thread->cmpxchg_threads_hazard_ptr(NULL, current_list) == current_list)
      return;                                     // tagged → 抢走（设为 NULL）
  // CAS 失败 → 读者恰好同时去 tag 了 → 重读 hazard_ptr → 回到 while 头部
}
// current_list 是已验证的标签 → 收集该快照上的全部 JavaThread 加入保护集合
```

读者和写者的两个 `while(true)` 形成对称设计——两边都在重试，直到达成共识：要么写者抢走标签（读者重试），要么读者成功确认（写者尊重标签）。

### 5.5 为什么这个协议不会 livelock

读者的 `while(true)` 没有重试上限——会不会和写者无限互相干扰？

**不会**。写者一次扫描遍历**所有**线程的 `_threads_hazard_ptr`，每个线程最多检查一次。它不是反复回来抢同一个线程。读者的 CAS 失败后重试——写者已经不在这个线程上了——下一次 CAS 必然成功（除非中间又发生了 `_java_thread_list` 替换 → 验证①已经抓到了）。

标签被抢的代价：一次 CAS 失败（~100ns）。远小于为每个线程分配额外状态做更复杂协议的代价。

### 5.6 留下了什么

**解决了**：把并发窗口从"拿快照到贴标签"的多条指令间隙压缩到"一条 CAS 指令"的粒度。

**留下了**：每个线程只有一个 `_threads_hazard_ptr`。如果遍历期间触发了另一个需要线程列表的操作 → 槽位被占 → 无法贴新标签。第 6 节解决这个问题。

---

## 6. 嵌套遍历——单槽位下的多层保护

### 6.1 什么时候会发生嵌套

第 5 节的协议假设"一个线程一次只保护一个快照"——绝大多数场景成立。但嵌套确实存在——VMThread 执行 GC 时 JFR 触发线程采样：

```
Thread::current() (VMThread)
  │
  ├─ ThreadsListHandle tlh;
  │    // 外层: hazard_ptr 指向 v3，GC 正在遍历线程栈
  │
  └─ while (遍历每个线程 T_k) {
        // JFR 触发，需要线程快照确定 T_k 是否存活
        └─ ThreadsListHandle inner_tlh;
            // 内层: 需要 _threads_hazard_ptr 存新标签
            // 但槽位已被外层占了！如果直接覆盖 → 外层仍在遍历
            // → 写者可能删掉外层正在用的 v3
     }
```

同一个线程同时需要两个 hazard ptr——但只有一个槽位。

### 6.2 为什么选择单槽位 + 引用计数

嵌套极其罕见——绝大多数线程生命周期中 `_threads_hazard_ptr` 被占的时间不到 1%。

**替代方案**：每个线程分配多个槽位（如 4 个或 8 个）。代价：1000 个线程 × 8 个槽位 × 8 字节 = 64KB 内存总是被占用——其中 99% 以上从未被使用。选择了**单槽位 + 嵌套时走引用计数降级**，而非多槽位。

### 6.3 解决策略：外层升级为引用计数保护

**设计思路**：
1. 外层快照 v3 已经通过了 tag/untag 验证——它是有效的，不需要重复验证。
2. 让 v3 脱离 hazard ptr，改用 ThreadsList 上的 `_nested_handle_cnt` 引用计数保护。
3. 清空 `_threads_hazard_ptr` 槽位 → 内层走正常的 fast path 设新标签。
4. 写者在扫描时同时检查两样东西：hazard ptr 指向的快照 **和** `_to_delete_list` 中 `_nested_handle_cnt > 0` 的快照。

`acquire_stable_list()`（`threadSMR.cpp:366-380`）是嵌套/非嵌套的公共入口：

```cpp
void SafeThreadsListPtr::acquire_stable_list() {
  _previous = _thread->_threads_list_ptr;     // 保存外层 SafeThreadsListPtr
  _thread->_threads_list_ptr = this;           // 内层成为 previous 链栈顶

  if (_thread->get_threads_hazard_ptr() == NULL) {
    acquire_stable_list_fast_path();           // 槽位空 → 常规路径
    return;
  }
  acquire_stable_list_nested_path();           // 槽位被占 → 嵌套路径
}
```

嵌套路径（`threadSMR.cpp:437-467`）：

```cpp
void SafeThreadsListPtr::acquire_stable_list_nested_path() {
  ThreadsList* current_list = _previous->_list;   // 外层正在用的快照
  current_list->inc_nested_handle_cnt();           // 引用计数 +1（CAS 循环）
  _previous->_has_ref_count = true;                // 标记外层为引用计数模式
  _thread->_threads_hazard_ptr = NULL;             // 清空槽位
  acquire_stable_list_fast_path();                 // 走 fast path 设新标签
}
```

释放时（`release_stable_list()`）分两条路径：
- `_has_ref_count == true` → `dec_nested_handle_cnt()`：递减引用计数（MO_ACQ_REL 保证内存序）。
- `_has_ref_count == false` → `set_threads_hazard_ptr(NULL)`：清空 hazard ptr + 检查 `_delete_notify` flag 决定是否 notify。

**`_previous` 链**：每个线程的 `_threads_list_ptr`（`thread.hpp:158`）是一个 `SafeThreadsListPtr*` 的单向链表。嵌套时外层在链上，内层在栈顶。释放时从栈顶往下恢复：`_thread->_threads_list_ptr = _previous`。

### 6.4 留下了什么

**解决了**：单槽位下的嵌套保护。写者的 `free_list()` 和 `is_a_protected_JavaThread()` 中已经同时检查了 hazard ptr 和 `_nested_handle_cnt`。

**留下了**：一个线程退出时，有两样东西需要回收——① JavaThread 对象本身（`smr_delete()`）② 从全局快照移除后产生的旧 ThreadsList（`free_list()`）。这两个回收层面在第 7 节统一梳理。

---

## 7. 两层回收——`smr_delete()` 和 `free_list()` 的协作

### 7.1 两种回收，两个层面

一个线程退出时产生两类待回收对象：

| 对象 | 大小 | 回收入口 | 回收策略 |
|------|------|---------|---------|
| `JavaThread` | 大（含线程栈、锁、JNI handle等） | `smr_delete()` | 阻塞等待——确保尽快回收 |
| `ThreadsList` | 小（容器头 + `JavaThread*[]` 数组） | `free_list()` | 机会主义——能删就删，不能就排队 |

两者都依赖 hazard ptr 扫描来判断安全性，但工作机制完全不同。

### 7.2 `smr_delete()`——阻塞等待的精确回收

`JavaThread` 对象必须尽快回收——`smr_delete()` 采用阻塞式设计（`threadSMR.cpp:944-1019`）：

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
        break;                               // 无人保护 → 去 delete
      }
    } // 释放 Threads_lock，让其他写者可以继续

    delete_lock()->wait(Mutex::_no_safepoint_check_flag, 0,
                         !Mutex::_as_suspend_equivalent_flag);
    // wait(timeout=0) → 无限等待，直到被 notify_all 唤醒
    clear_delete_notify();
    delete_lock()->unlock();
  }
  delete thread;
}
```

**三重防护**：
1. 持 `Threads_lock` + `delete_lock` 扫描（`is_a_protected_JavaThread`）→ 安全则 delete
2. 不安全 → 释放 `Threads_lock`，在 `delete_lock` 上 wait（`timeout=0`，无限等待）
3. 被 `release_stable_list` 的 `notify_all` 唤醒后重扫

**双重检查锁优化**：`release_stable_list()` 中不是每次释放都去争 `delete_lock` 发 notify：

```cpp
// release_stable_list() 中的双重检查（threadSMR.cpp:500-504）
if (ThreadsSMRSupport::delete_notify()) {          // 无锁检查 flag
  release_stable_list_wake_up(_has_ref_count);     // 有 flag 才争锁 notify
}
```

`_delete_notify` flag 只在 `smr_delete()` 的等待路径中被置为非零。大部分释放场景下没有写者在 wait——双重检查避免了无谓的锁竞争。

### 7.3 `free_list()`——机会主义的批量清理

`ThreadsList` 容器的回收没那么紧迫——`free_list()`（`threadSMR.cpp:779-845`）不阻塞，能删就删，不能就留在 `_to_delete_list` 链表里：

**五段逻辑概览**：

1. **头插入** `_to_delete_list`：`threads->set_next_list(_to_delete_list)` → `_to_delete_list = threads`。这是 ThreadsList 的链表，不是 JavaThread 的链表。

2. **计算哈希表大小**：`MIN2(current_thread_count, 32) * 2` → 2 的幂取整（位操作），上限 64。用于收集 hazard ptr 的哈希表。

3. **扫描所有线程的 hazard ptr**：`ScanHazardPtrGatherThreadsListClosure`（`threadSMR.cpp:282-306`）遍历所有 JavaThread，读取其 `_threads_hazard_ptr`——注意即使是 tagged（未验证）标签也收集（保守处理，安全优先）。`OrderAccess::acquire()` 屏障保证 hazard ptr 的读取排在后续读 `_nested_handle_cnt` 之前。

4. **遍历 `_to_delete_list` 释放无人引用的快照**：

```cpp
while (current != NULL) {
  next = current->next_list();
  if (!scan_table->has_entry((void*)current) && current->_nested_handle_cnt == 0) {
    // 两个条件同时满足 → 可以删：
    //   ① 不在 hazard ptr 哈希表中 （无人贴标签保护）
    //   ② _nested_handle_cnt == 0   （无嵌套引用计数保护）
    //
    // 从链表中摘除 current（更新 prev 的 next 或表头指针）
    if (current == threads) threads_is_freed = true;
    delete current;
  } else {
    prev = current;     // 不删 → 留在链表中，等下次 free_list 再检查
  }
  current = next;
}
```

5. **清理**：打 debug 日志（如果参数 threads 没能回收），删除哈希表。

**为什么扫描整条 `_to_delete_list` 而不只扫刚挂入的 `threads`？** 机会主义清理。之前的节点可能当时有 hazard ptr 引用，现在释放了——每次 add/remove 触发 `free_list` 时顺手清掉链上所有能清掉的节点。

### 7.4 两种回收的协作全景

一次线程退出的完整回收时间线：

```
① T2 调用 Threads::remove(T2)：
    从 _thread_list 摘除 → CoW 建新快照 v4 → free_list(v3) → v3 挂入 _to_delete_list

② T2 调用 smr_delete(T2)：
    扫描发现 T2 在 GC.v3._threads 中 → T2 受保护 → wait

③ GC 完成遍历：
    _threads_hazard_ptr = NULL → notify_all

④ smr_delete 被唤醒：
    重扫 → 无人引用 → delete T2 ← JavaThread 对象被释放

⑤ 下一次 add/remove 触发 free_list：
    扫描 _to_delete_list → v3 现在无人引用 → delete v3 ← ThreadsList 容器被释放
```

T2 的 JavaThread 对象（第 ④ 步）和 v3 ThreadsList（第 ⑤ 步）分两个层面、两个时机被回收——前者阻塞等待后立即释放，后者在下一次机会主义扫描时顺手清理。

---

## 8. GC 读快照——会不会漏 oop？

### 8.1 问题定义

GC 拿到的是某个瞬间的 `ThreadsList` 快照。如果快照里没有新创建的线程——GC 会漏掉栈上 oop 吗？如果快照里有已退出的线程——会访问已释放内存吗？

### 8.2 Stop-the-World GC

**不会漏，也不会悬空。** STW GC 在 safepoint 中运行。`Threads::add()` 和 `Threads::remove()` 需要 `Threads_lock`——锁的获取前提是**不在 safepoint 中**。

GC 拿到的 `ThreadsList` 快照就是此刻全部活着的 JavaThread 的精确全集。不会漏：safepoint 期间没人能动线程列表。不会悬空：hazard ptr 保护了正在被 GC 使用的快照。

### 8.3 并发 GC（G1 concurrent marking / ZGC / Shenandoah）

**快照可能不全，但 GC 不会漏 oop。** 并发标记期间确有新线程出生、旧线程退出——`ThreadsList` 快照不是完整集。但并发 GC 不唯一依赖它来找 oop：

1. **SATB（Snapshot-At-The-Beginning）**：G1 并发标记开始时建立逻辑快照——并发期间新线程分配的 oop 通过 SATB 写屏障记录到缓冲区（`G1BarrierSet`），即使新线程不在 ThreadsList 快照中，其分配的 oop 也会被标记。
2. **Card Table**：并发期间新线程的引用写入同样标记 card table。remark 阶段扫描脏 card。
3. **Remark 阶段重入 safepoint**：G1 的 remark（`G1CMRemarkTask::work()`）在 safepoint 下调用 `Threads::threads_do()` 重新扫描全员线程栈，处理并发期间积累的 SATB 缓冲区。

ThreadsList 快照是线程栈根扫描的起点——但不是唯一的信息来源。SMR 保证快照中线程对象不被提前释放；SATB + card table + remark 保证并发期间的 oop 不漏。

---

## 9. 全文总结——从约束到决策的完整链条

### 9.1 方案演进全景

每一步方案都是在上一步留下问题的基础上推导出来的：

```
约束：读取频率 >> 写入频率，单次读耗时 >> 单次写耗时
  ↓ 推导
决策①：两个列表并存 → 链表（O(1)头插）给写者，数组快照（O(1)下标）给读者
  ↓ 原因
约束：读者必须看到一致的线程集合，不能看到写者正在修改的数据
  ↓ 推导
决策②：CoW 全量拷贝 → 每个版本独立内存，读者拿到的快照绝对不可变
  ↓ 原因
约束：旧快照不能无限堆积，每次 add/remove 都产生新版本
  ↓ 推导
决策③：Hazard Pointer → 读者贴标签声明"我正在用 vN"，写者扫描后安全释放
  ↓ 原因
约束：贴标签有并发窗口——"拿快照"和"贴标签"不是原子操作
  ↓ 推导
决策④：tag/untag 两阶段协议 → 验证①防全局指针替换，验证②防标签被抢
  ↓ 原因
约束：一个线程只有一个 _threads_hazard_ptr 槽位，嵌套需要两个快照
  ↓ 推导
决策⑤：嵌套路径 → 外层升级为引用计数，内层走 fast path
```

### 9.2 工程权衡

每一项设计都考虑了替代方案：

| 设计选择 | 替代方案 | 当前方案胜出的原因 |
|---------|---------|-----------------|
| 两个列表并存 | 只留链表 | 链表无法 O(1) 下标定位，遍历依赖锁 |
| | 只留数组 | 数组无法 O(1) 头插，每次都全量重建 |
| CoW 全量拷贝 | 增量 CAS 更新 | 增量破坏"不可变快照"前提——读者看到部分更新 |
| Hazard Pointer | RCU (GlobalCounter) | RCU 等**全体**读者退出临界区；HP 等**特定版本**的读者释放。线程列表持有时间长，RCU 退化为同步 |
| 单槽位 | 多槽位数组 | 嵌套极其罕见（<1%），单槽位 + 引用计数避免多数线程浪费内存 |
| tag 被抢走 | tag 被等待 | 写者持 `Threads_lock`，不能等——可能死锁 |
| free_list 机会主义 | 精确即时回收 | 不阻塞——短暂多持有一点旧快照内存的成本 < 引入同步机制的复杂度 |

### 9.3 五个字段回顾

回到起点——`Thread::Thread()` 构造函数（`thread.cpp:242-245`）中初始化的 5 个 SMR 字段：

```cpp
_oops_do_parity = 0;               // GC 并行标记 parity，防止同一次 GC 内重复扫描
_threads_hazard_ptr = NULL;        // ThreadsList* volatile — Hazard Pointer 本体（第 4-5 节）
_threads_list_ptr = NULL;          // SafeThreadsListPtr* — 嵌套遍历的 _previous 链栈顶（第 6 节）
_nested_threads_hazard_ptr_cnt = 0; // 当前嵌套深度（统计用，仅 -XX:+EnableThreadSMRStatistics）
_rcu_counter = 0;                  // GlobalCounter 代际计数——平行机制，非线程列表场景
```

此刻全部为 NULL/0——线程尚未加入 `_thread_list`。当 `Threads::add(p)` 首次调用 `ThreadsSMRSupport::add_thread(p)`，`_java_thread_list` 从空的 `ThreadsList(0)` 变为包含 `[p]` 的新 `ThreadsList`，SMR 协议正式运转。

这个设计只有 5 行初始化代码——但在运行时支撑着 JVM 线程管理的全部并发安全。
