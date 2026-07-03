# 前置概念：Thread-SMR —— 线程列表的安全并发访问

在阅读 `Thread::Thread()` 构造函数的最后几行（`thread.cpp:239-243`）时，会看到 5 个初始化为 0/NULL 的字段。它们全部服务于同一个目标：**让多个线程在不持有 `Threads_lock` 的情况下安全遍历全局线程列表**。

---

## 1. 问题：`ThreadsSMRSupport::_java_thread_list` 的并发困境

`threadSMR.hpp:108`：

```cpp
ThreadsList* volatile ThreadsSMRSupport::_java_thread_list = new ThreadsList(0);
```

这是 SMR 管理的全局 JavaThread 快照——所有存活的 `JavaThread` 对象都在上面。GC（`Threads::threads_do()`）、`jstack`（JVMTI）、JFR 都需要遍历它。`Threads::_thread_list`（`JavaThread*` 单向链表）仍同时存在——`Threads::add()`（`thread.cpp:4463`）用头插法维护它，并在同一函数末尾（`thread.cpp:4482`）调用 `ThreadsSMRSupport::add_thread()` 从旧快照重建 `_java_thread_list`。`_thread_list` 是增删入口，`_java_thread_list` 是 SMR 只读快照——两者不是独立的全局列表。

JDK 8 的做法是持 `Threads_lock` 遍历 `_thread_list` 链表：读者和写者互斥。线程创建/退出拿着锁改链表时，遍历者全阻塞。SMR 将读写解耦——读者无需持锁，写者不阻塞读者。

---

## 2. 核心类

Thread-SMR 涉及四个核心类。本节先讲它们的静态成员和实例字段，然后在下文逐个展开方法。

### 2.1 ThreadsList —— 不可变快照（`threadSMR.hpp:158-196`）

```cpp
class ThreadsList : public CHeapObj<mtThread> {
  const uint _length;                    // 数组实际长度（永不改变）
  ThreadsList* _next_list;              // 待回收链表指针
  JavaThread *const *const _threads;    // 指针数组（双重 const）
  volatile intx _nested_handle_cnt;     // 嵌套引用计数
};
```

`CHeapObj<mtThread>` 表示 `ThreadsList` 在 C-Heap 上分配（`new ThreadsList(n)` → `NEW_C_HEAP_OBJ`），不走 ResourceArea。因为 `_to_delete_list` 里排队的旧列表生命周期可能跨越多个 safepoint。

**`_length`（`const uint`）**：数组里存了多少个 `JavaThread*`。构造时由 `entries` 参数决定，之后永不改变——COW 模式下一次构造就是最终形态。遍历时用它决定循环边界，`_threads` 不是 NULL 结尾数组。

**`_next_list`（`ThreadsList*`）**：指向 `_to_delete_list` 链表中的下一个待回收列表。`free_list()`（`threadSMR.cpp:782-783`）用头插法把旧列表链入：

```cpp
threads->set_next_list(_to_delete_list);
_to_delete_list = threads;
```

**`_threads`（`JavaThread *const *const`）**：双重 const 指针数组。底层 `const`（`*const`）阻止修改数组元素——这个列表是不可变快照；顶层 `const`（`*const`）阻止 `_threads` 重新指向别的数组。构造时 `NEW_C_HEAP_ARRAY(JavaThread*, entries + 1, mtThread)` 分配 `entries+1` 个槽位，末尾填 NULL。

**`_nested_handle_cnt`（`volatile intx`）**：嵌套引用计数。当同一线程嵌套两次 `acquire_stable_list()` 时，外层脱离 hazard ptr 改用此计数器保护 ThreadsList。`dec_nested_handle_cnt()` 用 `Atomic::sub(1, ...)`（模拟 `MO_ACQ_REL`），因为在 PPC 等平台上普通 `Atomic::dec` 的屏障语义不足。

### 2.2 ThreadsSMRSupport —— 全局协调（`threadSMR.hpp:88-154`）

纯静态类（`AllStatic`），14 个静态字段按功能分三组：

**核心字段**：

```cpp
static ThreadsList* volatile _java_thread_list;  // 当前全局快照（Atomic::xchg 替换）
```

**统计计数器**（`-XX:+EnableThreadSMRStatistics` 时有效）：

```cpp
static uint64_t _java_thread_list_alloc_cnt;  // 已分配快照总数
static uint64_t _java_thread_list_free_cnt;   // 已释放快照总数
static uint _java_thread_list_max;            // 历史最大长度
static uint _nested_thread_list_max;          // 历史最大嵌套深度
```

**回收协调**：

```cpp
static ThreadsList* _to_delete_list;  // 待回收的旧列表链表头
static volatile uint _delete_notify;  // 双重检查锁通知标志
```

`delete_lock()` 不是成员字段——是全局 `ThreadsSMRDelete_lock`（`mutexLocker.cpp:1106`，rank = access-1）。`smr_delete()` 在这个锁上 `wait`，`release_stable_list()` 在这个锁上 `notify_all`。

### 2.3 SafeThreadsListPtr —— 线程本地的安全指针包装（`threadSMR.hpp:201-252`）

五个字段：

```cpp
SafeThreadsListPtr* _previous;          // 嵌套链的前一个节点
Thread* _thread;                         // 所属线程
ThreadsList* _list;                      // 持有的快照指针
bool _has_ref_count;                     // 是否走引用计数路径（嵌套）
bool _needs_release;                     // 析构时是否需要 release
```

- `_thread`：所有操作最终读写 Thread 对象上的 `_threads_hazard_ptr` / `_threads_list_ptr`。
- `_needs_release`：区分"构造时 acquire=true"、"拷贝构造转移所有权"、"构造 false 后 set()"三种情况。只有真正调过 `acquire_stable_list()` 的才需要析构释放。拷贝构造把 `other._needs_release = false`——实现所有权转移，避免 double-release。
- `_has_ref_count`：析构时判断走哪条释放路径。false → 直接清 `_threads_hazard_ptr`；true → `_list->dec_nested_handle_cnt()` 减引用计数，不碰 hazard ptr（进入嵌套路径时已经清零）。
- `_previous`：指向前一个 `SafeThreadsListPtr`。嵌套时构成链表——外层被 promote 到引用计数、脱离 hazard ptr，仍在链上。析构按后进先出顺序逐层释放。

### 2.4 ThreadsListHandle 与 ThreadsListSetter

`ThreadsListHandle`（`threadSMR.hpp:272-306`，`StackObj`）是最常用的封装——内部嵌入一个 `SafeThreadsListPtr`，构造自动 `acquire = true`，析构自动 release。调用方只需：

```cpp
ThreadsListHandle tlh;
for (JavaThreadIterator jti(tlh.list()); !jti.done(); jti.next()) { ... }
```

`ThreadsListSetter`（`threadSMR.hpp:258-269`，`StackObj`）构造时 `acquire = false`——延迟到后续调用 `set(ThreadsList*)` 时才写入 hazard ptr。

---

## 3. Copy-on-Write：线程列表的增删

### 3.1 `add_thread` —— 全拷贝后追一条

`ThreadsList::add_thread()`（`threadSMR.cpp:562-574`）：

```cpp
ThreadsList *ThreadsList::add_thread(ThreadsList *list, JavaThread *java_thread) {
  const uint index = list->_length;            // 新线程放在旧列表末尾
  const uint new_length = index + 1;           // 新长度 = 旧长度 + 1
  const uint head_length = index;              // 需复制的元素数

  ThreadsList *const new_list = new ThreadsList(new_length);  // ① 分配新数组

  if (head_length > 0) {
    Copy::disjoint_words(                       // ② 全量复制
      (HeapWord*)list->_threads,
      (HeapWord*)new_list->_threads,
      head_length
    );
  }
  *(JavaThread**)(new_list->_threads + index) = java_thread;  // ③ 尾部追加
  return new_list;
}
```

`Copy::disjoint_words` 按 `HeapWord`（8 字节）对齐复制，已持有旧列表指针的读者不受影响。`remove_thread()`（`threadSMR.cpp:655`）同理——分配长度 `-1` 的新数组，拷贝时跳过目标线程。

### 3.2 原子替换全局指针

新列表建好后，通过 `Atomic::xchg` 原子替换：

```cpp
// threadSMR.cpp:743-752
void ThreadsSMRSupport::add_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::add_thread(get_java_thread_list(), thread);
  ThreadsList *old_list = xchg_java_thread_list(new_list);  // Atomic::xchg
  free_list(old_list);  // 旧列表进入 _to_delete_list 排队
}
```

`Atomic::xchg` 保证读者要么读到旧列表、要么读到新列表——永远不会读到半成品。

---

## 4. Hazard Pointer：读者声明 + 写者等待

### 4.1 获取快照——`acquire_stable_list()`

`SafeThreadsListPtr::acquire_stable_list()` 根据嵌套状态选择两条路径。

#### 快路径（非嵌套，`_threads_hazard_ptr == NULL`）

```cpp
// 简化流程，完整代码在 threadSMR.cpp:384-432
ThreadsList* threads = get_java_thread_list();    // ① 读全局指针
_threads_hazard_ptr = threads | 0x1;              // ② 打 tag 标记为 unverified
}                                                 //    release_store_fence 保证写可见
// 写者扫描到 tagged ptr 时会"抢"——替换为 NULL 并 notify
threads = get_java_thread_list();                  // ③ 读全局指针（抢验证）
do {
  ThreadsList* old_value = _threads_hazard_ptr;
  if (old_value != (threads | 0x1)) { return; }   // ④ 被抢或已变化→重试
} while (!cmpxchg(threads, &_threads_hazard_ptr, threads | 0x1));  // ⑤ 去 tag
_needs_release = true;
```

**为什么需要 tag**：write 和 read 之间存在时间窗口。如果写者恰好在读者 tag 掉 hazard ptr、但还没读完 `_java_thread_list` 时扫描到了这个 tagged ptr——它会"抢"走并 notify。读者在步骤④发现自己的 tag 已变成 NULL，说明被抢了——安全退出，外层重试。tag 把一行代码就能搞定的简单赋值拆成了两阶段协议，但换来的是写者不会在 wait 循环中浪费 CPU。

**为什么不用 `xchg` 或更简单的原子操作**：`release_store_fence`（步骤②）提供单向屏障——确保之前的读（get_java_thread_list）不会被重排到 store 之后。`cmpxchg`（步骤⑤）保证去 tag 前的值确实是 tagged ptr——如果在这期间发生了变化（列表被替换了），cmpxchg 失败并重新进入验证循环。

#### 嵌套路径

`_threads_hazard_ptr != NULL` 时，线程已持有一个快照。走嵌套路径（`threadSMR.cpp:433-462`）：

1. 外层的 `SafeThreadsListPtr` 被 promote——清空它的 `_threads_hazard_ptr`，改为 `_has_ref_count = true`，`_list->inc_nested_handle_cnt()` 对 ThreadsList 做引用计数。
2. 新建的 `SafeThreadsListPtr` 不碰 hazard ptr，而是走引用计数——析构时 `dec_nested_handle_cnt()` 减计数，当计数归零且 `smr_delete` 确认无人持 hazard ptr 时，ThreadsList 可被安全回收。

### 4.2 释放快照——`release_stable_list()`

```cpp
// threadSMR.cpp:479-505（简化）
ThreadsList* old_list = _list;
if (!_has_ref_count) {
  _thread->set_threads_hazard_ptr(NULL);  // 快路径：清零 hazard ptr
} else {
  old_list->dec_nested_handle_cnt();      // 嵌套路径：减引用计数
}
// 双重检查锁：通知 smr_delete 检查是否有 hazard ptr 变动
if (old_list->_nested_handle_cnt == 0 && ThreadsSMRSupport::_delete_notify) {
  MonitorLockerEx ml(ThreadsSMRSupport::delete_lock(), Monitor::_no_safepoint_check_flag);
  ThreadsSMRSupport::release_stable_list_wake_up((char*)"releasing smr");
}
```

**双重检查锁**：先无锁检查 `_delete_notify`——大多数情况下不需要唤醒。只有在 `smr_delete()` 确实在等待时才拿锁 notify——减少 delete_lock 的争用。

### 4.3 安全删除——`smr_delete()`

```cpp
// threadSMR.cpp:944-1009（简化）
ThreadsSMRSupport::smr_delete(JavaThread* thread) {
  // ① 确认线程已从 _java_thread_list 移除
  ThreadsList* list = xchg_java_thread_list(...);  // 移除后调用

  // ② 扫描等待循环
  while (true) {
    // 如果没人用 _threads_hazard_ptr 指着包含此线程的快照→安全删除
    if (!is_a_protected_JavaThread(thread)) {
      delete thread;
      return;
    }
    // 有人指着→等待
    MonitorLockerEx ml(delete_lock(), Monitor::_no_safepoint_check_flag);
    if (!is_a_protected_JavaThread(thread)) { // 双重检查
      delete thread;
      return;
    }
    _delete_notify = true;
    ml.wait(10);  // 最多等 10 毫秒
  }
}
```

`is_a_protected_JavaThread()` 扫描所有线程的 `_threads_hazard_ptr`，检查是否有线程的 hazard ptr 指向包含目标线程的 ThreadsList。如果有就 `wait(10ms)`——10 毫秒是平衡响应速度与 CPU 消耗的折中。

---

## 5. `_previous` 链的完整生命周期

以 GC 线程在遍历 `_thread_list` 时触发 JFR 线程快照为例：

**步骤 1：外层构造（GC 开始遍历）**
```
SafeThreadsListPtr outer(gc_thread, true);  // fast path
  _previous = NULL
  _needs_release = true
  gc_thread->_threads_hazard_ptr = tagged ptr
  gc_thread->_threads_list_ptr = &outer
```

**步骤 2：内层构造（JFR 嵌套触达）**
```
SafeThreadsListPtr inner(jfr_thread, true);  // nested path detected
  外层被 promote:
    gc_thread->_threads_hazard_ptr = NULL
    outer._has_ref_count = true
    old_list->inc_nested_handle_cnt()
  内层构造:
    inner._previous = &outer
    inner._needs_release = true
    gc_thread->_threads_list_ptr = &inner
```

**步骤 3：内层析构（JFR 调用完毕）**
```
inner 析构:
  _list->dec_nested_handle_cnt()
  gc_thread->_threads_list_ptr = inner._previous (= &outer)
```

**步骤 4：外层析构（GC 返回）**
```
outer 析构:
  _list->dec_nested_handle_cnt()  // 引用计数减到 0
  if (delete_notify) → 唤醒 smr_delete 检查
  gc_thread->_threads_list_ptr = NULL
```

---

## 6. 五个 Thread 实例字段

回到 `Thread::Thread()` 构造函数（`thread.cpp:239-243`）中初始化的五个字段：

```cpp
_oops_do_parity = 0;                        // int，GC 并行根扫描认领标记
_threads_hazard_ptr = NULL;                 // ThreadsList* volatile，SMR hazard pointer
_threads_list_ptr = NULL;                   // SafeThreadsListPtr*，嵌套遍历引用栈顶
_nested_threads_hazard_ptr_cnt = 0;         // uint，统计用嵌套深度计数器
_rcu_counter = 0;                           // volatile uintx，GlobalCounter 代际计数
```

| 字段 | 类型 | 行号 | 角色 |
|------|------|------|------|
| `_oops_do_parity` | `int` | thread.hpp:311 | GC 调用 `claim_oops_do_parity()` 时用 CAS 和全局 `_thread_claim_parity` 比对，防止同一轮 GC 重复扫描 |
| `_threads_hazard_ptr` | `ThreadsList* volatile` | thread.hpp:157 | Hazard Pointer 本体。写者通过读取此字段判断旧 ThreadsList 是否被引用。最低 bit 用作 tag/unverified 标记 |
| `_threads_list_ptr` | `SafeThreadsListPtr*` | thread.hpp:158 | 当前活跃 `SafeThreadsListPtr` 的栈顶。嵌套遍历时通过此字段链式访问 |
| `_nested_threads_hazard_ptr_cnt` | `uint` | thread.hpp:172 | 仅 `-XX:+EnableThreadSMRStatistics` 时有效，记录嵌套深度最大值 |
| `_rcu_counter` | `volatile uintx` | thread.hpp:315 | GlobalCounter 机制的线程本地代际计数。写者递增全局 epoch 后遍历所有线程的 `_rcu_counter`，所有线程都同步后才回收旧状态 |

> `_threads_hazard_ptr` 和 `_threads_list_ptr` 分工不同——前者是对写者可见的 hazard ptr 本体，后者是 RAII 包装器的管理链。嵌套时外层脱离 hazard ptr（改用引用计数），但仍在 `_threads_list_ptr` 链上。

---

## 7. GlobalCounter：另一套并行机制

`_rcu_counter` 不属于 SMR——它是 GlobalCounter 机制的线程本地计数器。

| | SMR (Hazard Pointer) | GlobalCounter |
|---|---|---|
| 粒度 | 单个 ThreadsList 快照 | 全局 epoch |
| 读者 | `acquire_stable_list()` → `_threads_hazard_ptr` | `GlobalCounter::critical_section_begin()` → 读 epoch |
| 写者 | `smr_delete()` 扫描 hazard ptr → wait | `GlobalCounter::write_synchronize()` → 等所有线程同步 |
| 嵌套 | 支持（引用计数 + `_previous` 链） | 不支持（同一个线程多段临界区独立） |
| 用途 | 线程列表遍历 | JFR、JVMTI tag map 等通用安全回收 |

两者在 `Threads::oops_do()` 中协同——hazard pointer 保护快照不被释放，GlobalCounter 保护全局指针变更在所有线程感知后才生效。

---

## 8. 回到构造函数

`Thread::Thread()` 中这五个字段全部初始化为 NULL/0——此刻线程还没加入 `Threads::_thread_list`，不存在任何并发读者需要协调。`_java_thread_list` 也已由 `ThreadsSMRSupport::_java_thread_list = new ThreadsList(0)` 初始化为空快照。SMR 和 GlobalCounter 的完整运行时机制将在后续线程生命周期章节深入展开。
