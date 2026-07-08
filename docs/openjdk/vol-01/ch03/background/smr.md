# 前置概念：Thread-SMR —— 线程列表的安全并发访问

> **本文定位**：背景知识文章。你要理解的是 HotSpot 如何让 GC、jstack、JVMTI、JFR 等"读者"无需持有全局锁就能安全遍历线程列表，同时线程的创建和退出不受阻塞。
>
> 本文是一本电子书的章节——不限制长度。每一行源码都被拆开、每一步数据结构的变化都被展示。
>
> **阅读提示**：线程名 `T1`、`T2` 和快照名 `v0`、`v1`、`v3` 等是示例局部变量——每节的示例独立，编号不跨节复用。例如第 3 节和第 4 节的 `v3` 代表不同的快照，各自在该节的上下文中定义。

---

## 0. 完整源码清单

本文涉及的所有源码均列于此。正文中直接以 `threadSMR.cpp:743` 的格式引用行号——你在清单中找到对应文件即可。

### 0a. `thread.hpp` — Thread 类字段和 tag 操作

**文件**: `src/hotspot/share/runtime/thread.hpp`

```cpp
// ═══ line 157 ═══
ThreadsList* volatile _threads_hazard_ptr;         // Hazard Pointer 本体

// ═══ line 158 ═══
SafeThreadsListPtr*   _threads_list_ptr;           // 嵌套遍历的 previous 链栈顶

// ═══ lines 162-169 — tag/untag 的三个静态方法 ═══
static bool is_hazard_ptr_tagged(ThreadsList* list) {
  return (intptr_t(list) & intptr_t(1)) == intptr_t(1);
}
static ThreadsList* tag_hazard_ptr(ThreadsList* list) {
  return (ThreadsList*)(intptr_t(list) | intptr_t(1));
}
static ThreadsList* untag_hazard_ptr(ThreadsList* list) {
  return (ThreadsList*)(intptr_t(list) & ~intptr_t(1));
}

// ═══ line 2205 ═══
static JavaThread* _thread_list;                   // 全局标准链表头
```

### 0b. `thread.inline.hpp` — hazard_ptr 读写

**文件**: `src/hotspot/share/runtime/thread.inline.hpp`

```cpp
// ═══ line 85 — CAS 修改 _threads_hazard_ptr ═══
inline ThreadsList* Thread::cmpxchg_threads_hazard_ptr(
    ThreadsList* exchange_value, ThreadsList* compare_value) {
  return (ThreadsList*)Atomic::cmpxchg(exchange_value, &_threads_hazard_ptr, compare_value);
}

// ═══ line 89 — acquire 读取 _threads_hazard_ptr ═══
inline ThreadsList* Thread::get_threads_hazard_ptr() {
  return (ThreadsList*)OrderAccess::load_acquire(&_threads_hazard_ptr);
}

// ═══ line 93 — release+fence 写入 _threads_hazard_ptr ═══
inline void Thread::set_threads_hazard_ptr(ThreadsList* new_list) {
  OrderAccess::release_store_fence(&_threads_hazard_ptr, new_list);
}
```

### 0c. `threadSMR.inline.hpp` — 全局快照读取

**文件**: `src/hotspot/share/runtime/threadSMR.inline.hpp`

```cpp
// ═══ line 81 ═══
inline ThreadsList* ThreadsSMRSupport::get_java_thread_list() {
  return (ThreadsList*)OrderAccess::load_acquire(&_java_thread_list);
}
```

### 0d. `threadSMR.hpp` — 核心数据结构

**文件**: `src/hotspot/share/runtime/threadSMR.hpp`

```cpp
// ═══ line 88 — ThreadsSMRSupport 全静态类 ═══
class ThreadsSMRSupport : AllStatic {
  // ...统计字段省略...
  static ThreadsList* volatile _java_thread_list;    // 全局 CoW 快照指针（line 108）
  static ThreadsList*          _to_delete_list;      // 待删除旧快照链表头（line 116）
  static volatile uint         _delete_notify;       // 双重检查锁 flag（line 104）

  static ThreadsList* xchg_java_thread_list(ThreadsList* new_list);  // line 139
  static void free_list(ThreadsList* threads);                       // line 126

 public:
  static void add_thread(JavaThread *thread);        // line 142
  static ThreadsList* get_java_thread_list();        // line 143
  static void remove_thread(JavaThread *thread);     // line 145
  static void smr_delete(JavaThread *thread);        // line 146
  static bool is_a_protected_JavaThread(JavaThread*); // line 130
};

// ═══ line 158 — ThreadsList 快照容器 ═══
class ThreadsList : public CHeapObj<mtThread> {
  const uint _length;                               // 包含的线程数量
  ThreadsList* _next_list;                          // _to_delete_list 链指针
  JavaThread *const *const _threads;                // 指向 JavaThread*[] 数组
  volatile intx _nested_handle_cnt;                 // 嵌套引用计数

  void inc_nested_handle_cnt();                     // CAS 循环递增
  void dec_nested_handle_cnt();                     // Atomic::sub 递减

 public:
  ThreadsList(int entries);                         // 分配 entries+1 个槽位，末位 NULL
  JavaThread *const thread_at(uint i) const {       // O(1) 数组下标访问
    return _threads[i];
  }
  static ThreadsList* add_thread(ThreadsList*, JavaThread*);     // 纯 Copy
  static ThreadsList* remove_thread(ThreadsList*, JavaThread*);  // 分两段 memcpy 跳过
  bool includes(const JavaThread* p) const;
};

// ═══ line 201 — SafeThreadsListPtr（RAII 包装） ═══
class SafeThreadsListPtr {
  SafeThreadsListPtr* _previous;                    // 嵌套链上一项
  Thread*             _thread;                      // 所属线程
  ThreadsList*        _list;                        // 受保护的快照
  bool                _has_ref_count;               // false=hazard_ptr模式, true=引用计数模式
  bool                _needs_release;               // 析构时是否需要 release

  void acquire_stable_list();
  void acquire_stable_list_fast_path();
  void acquire_stable_list_nested_path();
  void release_stable_list();

 public:
  SafeThreadsListPtr(Thread *thread, bool acquire) : _previous(NULL), _thread(thread),
    _list(NULL), _has_ref_count(false), _needs_release(false) {
    if (acquire) { acquire_stable_list(); }
  }
  ~SafeThreadsListPtr() { if (_needs_release) { release_stable_list(); } }
};

// ═══ line 272 — ThreadsListHandle（读者最常用） ═══
class ThreadsListHandle : public StackObj {
  SafeThreadsListPtr _list_ptr;
 public:
  ThreadsListHandle(Thread *self = Thread::current());  // 构造 = acquire_stable_list()
  ~ThreadsListHandle();                                   // 析构 = release_stable_list()
  ThreadsList *list() const { return _list_ptr.list(); }
};
```

### 0e. `threadSMR.cpp` — 核心函数实现

**文件**: `src/hotspot/share/runtime/threadSMR.cpp`

```cpp
// ═══ line 75 — 全局快照初始化为空 ThreadsList，不是 NULL ═══
ThreadsList* volatile ThreadsSMRSupport::_java_thread_list = new ThreadsList(0);

// ═══ line 159 — 原子替换全局指针 ═══
inline ThreadsList* ThreadsSMRSupport::xchg_java_thread_list(ThreadsList* new_list) {
  return (ThreadsList*)Atomic::xchg(new_list, &_java_thread_list);
}

// ═══ line 288 — free_list 扫描器：收集 hazard ptr 指向的快照（不管 tagged） ═══
virtual void do_thread(Thread* thread) {              // ScanHazardPtrGatherThreadsListClosure
  ThreadsList *threads = thread->get_threads_hazard_ptr();
  if (threads == NULL) return;
  threads = Thread::untag_hazard_ptr(threads);       // 即使 tagged 也收集
  if (!_table->has_entry((void*)threads)) _table->add_entry((void*)threads);
}

// ═══ line 240 — smr_delete 扫描器：区分 tagged/untagged ═══
virtual void do_thread(Thread *thread) {              // ScanHazardPtrGatherProtectedThreadsClosure
  ThreadsList *current_list = NULL;
  while (true) {
    current_list = thread->get_threads_hazard_ptr();
    if (current_list == NULL) return;                                 // 没标签 → 跳过
    if (!Thread::is_hazard_ptr_tagged(current_list)) break;          // untagged → 正常收集
    if (thread->cmpxchg_threads_hazard_ptr(NULL, current_list) == current_list) return; // tagged → 抢走
  }
  AddThreadHazardPointerThreadClosure add_cl(_table);
  current_list->threads_do(&add_cl);                                 // 收集此快照上全部线程
}

// ═══ line 366 — 嵌套/非嵌套分发 ═══
void SafeThreadsListPtr::acquire_stable_list() {
  _needs_release = true;
  _previous = _thread->_threads_list_ptr;              // 保存栈顶
  _thread->_threads_list_ptr = this;                   // 自己成为新栈顶
  if (_thread->get_threads_hazard_ptr() == NULL) {
    acquire_stable_list_fast_path();                   // 槽位空 → 常规
  } else {
    acquire_stable_list_nested_path();                 // 槽位被占 → 嵌套
  }
}

// ═══ line 384 — tag/untag 四步协议 ═══
void SafeThreadsListPtr::acquire_stable_list_fast_path() {
  ThreadsList* threads;
  while (true) {
    threads = ThreadsSMRSupport::get_java_thread_list();              // ① 读全局指针
    ThreadsList* unverified_threads = Thread::tag_hazard_ptr(threads); // ②a 打 tag
    _thread->set_threads_hazard_ptr(unverified_threads);              // ②b 贴标签（堆上发布）
    if (ThreadsSMRSupport::get_java_thread_list() != threads)         // ③ 验证①：重读
      continue;
    if (_thread->cmpxchg_threads_hazard_ptr(threads, unverified_threads)
        == unverified_threads)                                        // ④ 验证②：CAS
      break;
  }
  _list = threads;
}

// ═══ line 437 — 嵌套路径：外层降级为引用计数 ═══
void SafeThreadsListPtr::acquire_stable_list_nested_path() {
  ThreadsList* current_list = _previous->_list;       // ① 取外层快照
  current_list->inc_nested_handle_cnt();               // ② 引用计数 +1
  _previous->_has_ref_count = true;                    // ③ 外层切到引用计数模式
  _thread->_threads_hazard_ptr = NULL;                 // ④ 清空标签，腾给内层
  acquire_stable_list_fast_path();                     // ⑤ 内层走 fast path
}

// ═══ line 471 — 释放（分 hazard ptr / 引用计数两条路径） ═══
void SafeThreadsListPtr::release_stable_list() {
  _thread->_threads_list_ptr = _previous;              // 恢复 previous 链
  if (_has_ref_count) {
    _list->dec_nested_handle_cnt();                    // 引用计数 → dec
  } else {
    _thread->set_threads_hazard_ptr(NULL);             // hazard ptr → 清空
  }
  if (ThreadsSMRSupport::delete_notify())              // 双重检查 lock
    ThreadsSMRSupport::release_stable_list_wake_up(_has_ref_count);
}

// ═══ line 546 — ThreadsList 构造函数：分配 entries+1 个槽位 ═══
ThreadsList::ThreadsList(int entries) : _length(entries),
  _threads(NEW_C_HEAP_ARRAY(JavaThread*, entries + 1, mtThread)),
  _nested_handle_cnt(0) {
  *(JavaThread**)(_threads + entries) = NULL;          // 末尾哨兵
}

// ═══ line 562 — ThreadsList::add_thread：纯 Copy ═══
ThreadsList *ThreadsList::add_thread(ThreadsList *list, JavaThread *java_thread) {
  const uint index = list->_length;
  ThreadsList *const new_list = new ThreadsList(index + 1);
  if (index > 0)
    Copy::disjoint_words(list->_threads, new_list->_threads, index);  // 全量 memcpy
  *(JavaThread**)(new_list->_threads + index) = java_thread;          // 尾追加
  return new_list;
}

// ═══ line 655 — ThreadsList::remove_thread：分两段 memcpy 跳过 ═══
ThreadsList *ThreadsList::remove_thread(ThreadsList *list, JavaThread *jt) {
  uint i = (uint)list->find_index_of_JavaThread(jt);
  const uint head_len = i, tail_len = list->_length - 1 - i;
  ThreadsList *const new_list = new ThreadsList(list->_length - 1);
  if (head_len > 0)
    Copy::disjoint_words(list->_threads, new_list->_threads, head_len);
  if (tail_len > 0)
    Copy::disjoint_words(list->_threads + i + 1, new_list->_threads + i, tail_len);
  return new_list;
}

// ═══ line 743 — add_thread：调度 CoW ═══
void ThreadsSMRSupport::add_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::add_thread(get_java_thread_list(), thread);
  ThreadsList *old_list = xchg_java_thread_list(new_list);   // Atomic::xchg
  free_list(old_list);
}

// ═══ line 917 — remove_thread：调度 CoW ═══
void ThreadsSMRSupport::remove_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::remove_thread(get_java_thread_list(), thread);
  ThreadsList *old_list = xchg_java_thread_list(new_list);
  free_list(old_list);
}

// ═══ line 779 — free_list：头插入 + scan + 遍历释放 ═══
void ThreadsSMRSupport::free_list(ThreadsList* threads) {
  assert_locked_or_safepoint(Threads_lock);
  threads->set_next_list(_to_delete_list);              // ─┐
  _to_delete_list = threads;                            // ─┘ 头插入 _to_delete_list

  int hash_table_size = MIN2((int)get_java_thread_list()->length(), 32) * 2;
  // ... 位扩展求 2 的幂 ...
  ThreadScanHashtable *scan_table = new ThreadScanHashtable(hash_table_size);
  ScanHazardPtrGatherThreadsListClosure scan_cl(scan_table);
  threads_do(&scan_cl);                                 // 扫描所有 hazard ptr → 哈希表
  OrderAccess::acquire();

  ThreadsList* current = _to_delete_list, *prev = NULL;
  while (current != NULL) {
    ThreadsList* next = current->next_list();
    if (!scan_table->has_entry(current) && current->_nested_handle_cnt == 0) {
      if (prev) prev->set_next_list(next);              // 摘除
      else _to_delete_list = next;                      // 或更新表头
      delete current;                                   // 释放
    } else prev = current;
    current = next;
  }
  delete scan_table;
}

// ═══ line 850 — is_a_protected：两段扫描 ═══
bool ThreadsSMRSupport::is_a_protected_JavaThread(JavaThread *thread) {
  // ... 计算 hash_table_size ...
  ThreadScanHashtable *scan_table = new ThreadScanHashtable(hash_table_size);
  ScanHazardPtrGatherProtectedThreadsClosure scan_cl(scan_table);
  threads_do(&scan_cl);                                 // 第一段：扫 hazard ptr
  OrderAccess::acquire();
  ThreadsList* current = _to_delete_list;
  while (current != NULL) {
    if (current->_nested_handle_cnt != 0) {             // 第二段：扫引用计数
      AddThreadHazardPointerThreadClosure add_cl(scan_table);
      current->threads_do(&add_cl);
    }
    current = current->next_list();
  }
  bool r = scan_table->has_entry((void*)thread);
  delete scan_table; return r;
}

// ═══ line 944 — smr_delete：扫描+等待+delete ═══
void ThreadsSMRSupport::smr_delete(JavaThread *thread) {
  while (true) {
    { MutexLockerEx ml(Threads_lock, Mutex::_no_safepoint_check_flag);
      delete_lock()->lock_without_safepoint_check();
      set_delete_notify();
      if (!is_a_protected_JavaThread(thread)) {
        clear_delete_notify(); delete_lock()->unlock(); break;
      }
    } // 释放 Threads_lock，保持 delete_lock
    delete_lock()->wait(Mutex::_no_safepoint_check_flag, 0, ...);
    clear_delete_notify(); delete_lock()->unlock();
  }
  delete thread;
}
```

### 0f. `thread.cpp` — 写入口

**文件**: `src/hotspot/share/runtime/thread.cpp`

```cpp
// ═══ line 210 — smr_delete 调度 ═══
void JavaThread::smr_delete() {
  if (_on_thread_list) ThreadsSMRSupport::smr_delete(this);
  else delete this;
}

// ═══ line 4458 — Threads::add：写入口 ═══
void Threads::add(JavaThread* p, bool force_daemon) {
  assert(Threads_lock->owned_by_self(), "must have threads lock");
  p->set_next(_thread_list); _thread_list = p;          // O(1) 头插入链表
  p->set_on_thread_list();                              // 标记 _on_thread_list = true
  _number_of_threads++;
  ThreadsSMRSupport::add_thread(p);                     // 进入 SMR 层
}

// ═══ line 4490 — Threads::remove：写出口 ═══
void Threads::remove(JavaThread* p, bool is_daemon) {
  { MutexLocker ml(Threads_lock);
    ThreadsSMRSupport::remove_thread(p);                // CoW 建不含 p 的新快照
    // ... 从 _thread_list 链表摘除 p ...
    _number_of_threads--;
    p->set_terminated_value();                          // 标记 _terminated
  }
}
```

---

## 需要的前置知识

本章涉及的 C++ 概念和并发基础全部列在这里。已熟悉的读者可跳过。

### C++ 知识

以下 C++ 特性贯穿全文——不要求精通，但需要知道它们"在本文语境下表达什么意思"。

**`volatile`**：告诉编译器"这个变量的值可能在任何时刻被其他线程修改，禁止缓存到寄存器"。本文中 `_java_thread_list`、`_threads_hazard_ptr`、`_delete_notify`、`_nested_handle_cnt` 都是 `volatile`——写者的修改必须立刻对读者的扫描可见。

**`static` 类成员**：属于类本身，不属于任何实例。`Threads::_thread_list` 是 `static JavaThread*`——整个 JVM 只有这一个链表头。`ThreadsSMRSupport` 更极端——`AllStatic` 意味着**所有**字段和方法都是 `static`，它没有实例，纯粹是一个全局状态协调器。

**RAII（Resource Acquisition Is Initialization）**：资源的获取和释放绑定到对象的构造和析构。本文核心例子：
- `MutexLocker mu(Threads_lock)` —— 构造 = `lock()`，离开作用域析构 = `unlock()`
- `ThreadsListHandle tlh` —— 构造 = `acquire_stable_list()`（贴标签），析构 = `release_stable_list()`（摘标签 + 必要时 notify）
- 不管函数怎么返回（正常、异常、中途 return），析构函数一定执行——锁不会泄漏，标签不会忘记摘

**`const` 与指针层级**：`JavaThread *const *const _threads` 需要从右往左读：最右边的 `const` 修饰 `_threads` 指针本身（不能改指向），中间的 `const` 修饰 `JavaThread*` 这个被指内容（不能改数组中的指针值）。结果：`_threads` 数组一旦构造完成就彻底只读——这是 CoW 快照不可变性的 C++ 层面保证。

**指针算术与类型转换**：`*(JavaThread**)(new_list->_threads + index) = jt` 需要拆开理解：
- `new_list->_threads` 类型是 `JavaThread *const*`（指向 const 指针数组的指针）
- `+ index` 向前移动 `index` 个 `JavaThread*` 元素（指针算术自动按元素大小偏移）
- `(JavaThread**)` 把 `const` 强制丢掉——因为此时数组刚分配，还没有读者能看到它，写入是安全的
- `*... = jt` 解引用后写入新线程指针

**堆分配宏**：`NEW_C_HEAP_ARRAY(JavaThread*, n, mtThread)` 等价于 `new JavaThread*[n]`，`mtThread` 是内存类型标签用于调试和统计。对应的释放是 `delete`（单个对象）或隐式通过 `FREE_C_HEAP_ARRAY`（数组）。

**继承**：`Thread` 是所有线程类型的基类，`_threads_hazard_ptr` 在基类中定义（`thread.hpp:157`）——`JavaThread`、`VMThread`、`NonJavaThread` 都继承这个字段。所以写者扫描 `thread->get_threads_hazard_ptr()` 时不需要关心具体线程类型。

**`class X : public StackObj`**：表示 X 的对象必须在栈上创建（不能 `new`）。`ThreadsListHandle`、`JavaThreadIterator` 都是 `StackObj`——它们的生命周期严格绑定到声明所在的作用域。

**`class X : public CHeapObj<tag>`**：表示 X 的对象在 C 堆上分配（可以用 `new`）。`ThreadsList` 是 `CHeapObj`——每次 add/remove 通过 `new ThreadsList(n)` 分配新快照，通过 `delete` 释放旧快照。

**模板方法 `threads_do<T>`**：`ThreadsList::threads_do(cl)` 遍历自己的 `_threads` 数组，对每个 `JavaThread*` 调用 `cl->do_thread(thread)`。调用方只需要提供一个有 `do_thread(Thread*)` 方法的闭包对象——`ScanHazardPtrGatherProtectedThreadsClosure` 和 `AddThreadHazardPointerThreadClosure` 都是这种闭包。

**`assert`**：release 模式下无作用，debug 模式下条件不成立直接 abort。本文中每个涉及锁操作的函数都以此开始——作为"调用者必须满足什么条件"的文档。例如 `assert(Threads_lock->owned_by_self(), ...)` 直接说明了"调用此函数前必须先持锁"。

**`intptr_t` 和位运算**：`intptr_t` 是一个能存下指针值的整数类型。`tag_hazard_ptr()` 里的 `intptr_t(list) | intptr_t(1)` 把指针值的最低 bit 设为 1——这不是在"修改指针"，而是在指针值上做位标记（bit0=1 表示"未验证"）。解引用前 `untag_hazard_ptr()` 用 `& ~1` 抹掉最低 bit。

### 并发基础

**CAS（Compare-And-Swap）**

CAS 是一次不可被 CPU 调度打断的硬件指令：

```
cmpxchg(new_val, &location, expected_val)
```

它原子地做三件事：① 读出 location 的当前值；② 如果当前值 == expected_val，写入 new_val（成功）；③ 如果当前值 != expected_val，不写入（失败）。返回值是旧值——等于 expected_val 表示成功。

CAS 是多核并发安全的基石：**"只有在预期值仍未变时，才写入新值"这一判断和写入是不可分割的整**体。

### Atomic::xchg

`Atomic::xchg(new_val, &location)` 把 new_val 写入 location，返回旧值。比 CAS 更简单——无条件写入，不需要预计旧值。本文中 CoW 的全局指针替换就靠它。

### 内存序

多核 CPU 上一个核心写入的值不立刻对其他核心可见。三种操作保证特定顺序：

- **acquire**：此后的读写不排在此次读之前。本文 `get_java_thread_list()` 用它保证读到的是完整初始化的 ThreadsList。
- **release**：此前的读写不排在此次写之后。本文 `set_threads_hazard_ptr()` 用它保证写出的 hazard ptr 对其他线程可见。
- **fence**：acquire + release 的合体。

### wait/notify

线程 A 在 Monitor 上调用 `wait()` → 原子释放锁并休眠，直到被 `notify_all()` 唤醒 → 重新竞争锁，回到调用点继续。本文 `smr_delete()` 发现线程仍受保护时用它等待读者释放。

---

## 1. 核心矛盾——读者和写者的天然冲突

JVM 运行中的一个时刻：

- `Threads::_thread_list`（`thread.hpp:2205`，`static JavaThread*`）是一条单向链表，串联着全部活着的 `JavaThread` 对象。每个 `JavaThread` 通过 `_next` 指针连接下一个。
- **读者**：GC 的 VMThread（扫描线程栈上的 oop）、jstack/JCMD（dump 线程栈）、JVMTI agent（枚举线程）、JFR sampler。单次遍历几百微秒。
- **写者**：`Threads::add()`（新线程创建，O(1) 头插入）、`Threads::remove()`（线程退出）。单次操作几微秒。

**核心约束：读取频率远高于写入频率，但单次读耗时远长于单次写耗时。**

JDK 8 的做法——读者拿 `Threads_lock` 遍历：

```cpp
// 读者（GC）
MutexLocker mu(Threads_lock);           // 持有锁，几百微秒
for (cur = _thread_list; cur != NULL; cur = cur->next())
    scan_oop(cur);                      // 遍历每个线程
// 退出作用域，释放锁
```

GC 持锁期间，任何线程无法 `Threads::add()` 或 `Threads::remove()`——它们都需要同一个锁。线程创建每几十微秒一次，GC 遍历几百微秒。这几百微秒内**整个系统的线程生命周期完全冻结**。

**目标：让读者不持锁就能安全遍历线程列表，同时写者不受阻塞。**

---

## 2. 两个列表并存——分离读写数据路径

### 为什么一个 `_thread_list` 不够

`_thread_list` 是一条可变链表。`Threads::add()` 原地修改 `_next` 指针（`p->set_next(_thread_list); _thread_list = p;`）。读者和写者**共享同一块可变内存**——不加锁的情况下，读者可能读到半修改的指针或跳到已释放的内存。必须加锁。

### 两个容器，分工明确

**思路**：给读者一个独立的、不可变的容器。读者遍历它时，写者对 `_thread_list` 的修改完全不触碰它。

- **`_thread_list`（链表）**：给写者用。O(1) 头插入，原地修改 `_next` 指针。写者之间通过 `Threads_lock` 互斥。
- **`_java_thread_list`（数组快照）**：给读者用。`ThreadsSMRSupport` 这个全静态类管理它（`threadSMR.hpp:88`，`class ThreadsSMRSupport : AllStatic`——所有方法和字段都是 static，整个 JVM 只有一个全局快照指针 `_java_thread_list`）。

| 全局变量 | 类型 | 容器形式 | 使用者 |
|---------|------|---------|--------|
| `_thread_list` | `static JavaThread*` | 单向链表，通过 `_next` 串接 | 写者 |
| `_java_thread_list` | `static ThreadsList* volatile` | 数组快照，通过 `_threads[i]` 下标访问 | 读者 |

两者在同一个持锁范围同步维护：`Threads::add()` 先头插入 `_thread_list` 链表，最后调 `ThreadsSMRSupport::add_thread(p)` 更新快照。两边永远包含相同的 `JavaThread*` 集合。

初始化状态（`threadSMR.cpp:75`）：

```cpp
ThreadsList* volatile ThreadsSMRSupport::_java_thread_list = new ThreadsList(0);
```

`_thread_list == NULL`（POD 默认），`_java_thread_list` 指向一个长度为 0 的空 ThreadsList——不是 NULL。

---

## 3. 写时拷贝（CoW）——保证快照绝对不可变

### 为什么必须全量拷贝

读者通过 `get_java_thread_list()` 拿到 `ThreadsList*` 指针后，后续遍历用的是指针指向的 `_threads` 数组。

如果写者原地修改这个数组（尾追加或中删除），读者正在遍历时某些槽位的值在变。即使写者用 CAS 原子替换单个元素，读者看到的也不再是某个时刻的完整截图——它是多个时刻的混合物。

CoW 的规则：**任何写者不修改已发布的快照。要改，就建一份新副本，然后原子替换全局指针。**

### 容器：ThreadsList

`ThreadsList`（`threadSMR.hpp:158-196`）是只读快照的容器：

```cpp
class ThreadsList : public CHeapObj<mtThread> {
  const uint _length;                    // 包含的线程数量
  ThreadsList* _next_list;               // _to_delete_list 的链指针
  JavaThread *const *const _threads;     // 指向堆上 JavaThread*[] 数组
  volatile intx _nested_handle_cnt;      // 嵌套引用计数（第 7 节详述）
};
```

`_threads` 是 `const * const`——指针本身和指向的内容都不可变。构造函数的源码（清单 0e:line 230-234）：

```cpp
ThreadsList::ThreadsList(int entries) :
  _length(entries),                                      // ① 数量
  _next_list(NULL),                                      // ② 链表指针初始 NULL
  _threads(NEW_C_HEAP_ARRAY(JavaThread*, entries + 1, mtThread)),  // ③ 分配数组
  _nested_handle_cnt(0)                                  // ④ 引用计数初始 0
{
  *(JavaThread**)(_threads + entries) = NULL;            // ⑤ 末尾哨兵
}
```

**逐行解释**：

① `_length(entries)` — 初始化成员列表，`_length` 记录包含多少线程。注意 `entries` 是线程数，但数组大小是 `entries + 1`。

② `_next_list(NULL)` — 这个指针不用于 `_thread_list` 链表。它是 `_to_delete_list` 链表专用的 next 指针——当旧快照被挂入回收队列时，通过 `_next_list` 串联。

③ `_threads(NEW_C_HEAP_ARRAY(JavaThread*, entries + 1, mtThread))` — 在 C 堆上分配 `entries + 1` 个 `JavaThread*` 指针槽位。例如 `entries=2` → 分配 3 个槽位（24 字节）。`mtThread` 是 NMT（Native Memory Tracking）内存标签，用于 JVM 内存统计。

④ `_nested_handle_cnt(0)` — 嵌套引用计数从 0 开始。第 7 节会解释这个字段何时递增。

⑤ `*(JavaThread**)(_threads + entries) = NULL` — 数组最后一个槽位（索引 = `entries`）写入 NULL。这个 NULL 是遍历哨兵——遍历代码遇 NULL 即止，不需要每次检查 `i < _length`。

完成后的数组布局（`entries = 2` 为例）：
```
_threads = [ptr0, ptr1, NULL]
           ↑     ↑      ↑
         槽0   槽1   哨兵(槽2)
```

**为什么是数组不是链表？** `thread_at(i)` 直接返回 `_threads[i]`（`threadSMR.hpp:188`）——O(1) 随机访问，不是 `cur = cur->next()` 的 O(n) 遍历。`NEW_C_HEAP_ARRAY(JavaThread*, entries + 1)` 分配的是堆数组，产生连续内存。

`includes(p)` 方法基于同样的数组——遍历 `_threads[0.._length-1]` 逐个比较指针是否等于 `p`，O(n) 线性搜索。被 `Threads::remove()` 的 assert 和 `java_suspend()` 的存活检查调用。

### 三层调用链——逐行拆解

下面从 `Threads::add(main_thread)` 开始，逐行拆解每行代码执行后各字段的变化。

#### 第 1 层：`Threads::add()`——维护标准链表

`Threads::create_vm()` 中持锁调用（`thread.cpp:3862-3863`）：

```cpp
{ MutexLocker mu(Threads_lock);
  Threads::add(main_thread);
}
```

`MutexLocker mu(Threads_lock)` —— 在栈上构造 RAII 锁对象，构造函数调用 `Threads_lock->lock()`，当前线程（VMThread）获取互斥锁。离开 `{}` 作用域时析构自动 unlock。

进入 `Threads::add()`（`thread.cpp:4458-4488`）：

```cpp
void Threads::add(JavaThread* p, bool force_daemon) {
  assert(Threads_lock->owned_by_self(), "must have threads lock");
```

`assert` 验证当前线程确实持有 `Threads_lock`——不持锁就进来说明调用链有 bug，直接 abort。

```cpp
  p->set_next(_thread_list);
  _thread_list = p;
```

头插入 `_thread_list` 链表。`p->set_next(NULL)`（因为 `_thread_list == NULL`），然后 `_thread_list = p`：

```
执行前: _thread_list == NULL
行 A:   p->set_next(NULL)     → p._next = NULL
行 B:   _thread_list = p      → _thread_list = p
执行后: _thread_list → p → NULL
```

O(1) 插入，不需要遍历链表。

```cpp
  p->set_on_thread_list();
  _number_of_threads++;
```

`set_on_thread_list()` 设置 `p._on_thread_list = true`（`thread.hpp:959`）。这个标志位非常重要——一旦设为 true，后续必须通过 `smr_delete()` 安全删除（不能直接 `delete`），因为可能有读者通过 `ThreadsListHandle` 持有指向 p 的快照引用。

`_number_of_threads` 全局计数器从 0 变为 1。

```cpp
  ThreadsSMRSupport::add_thread(p);
}
```

最后一行进入 SMR 第二层。在这之前的所有操作（链表维护、计数器更新）都在 `Threads_lock` 保护下完成。

#### 第 2 层：`ThreadsSMRSupport::add_thread()`——调度 CoW

`threadSMR.cpp:743-758`：

```cpp
void ThreadsSMRSupport::add_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::add_thread(get_java_thread_list(), thread);
```

**第 ① 步——建新快照。** 先执行 `get_java_thread_list()`（`threadSMR.inline.hpp:81-83`）：

```cpp
inline ThreadsList* ThreadsSMRSupport::get_java_thread_list() {
  return (ThreadsList*)OrderAccess::load_acquire(&_java_thread_list);
}
```

`load_acquire` 读取全局 `_java_thread_list` 的值。此时它指向构造函数分配的 `ThreadsList(0)`——一个包含 NULL 哨兵的空快照。返回值记为 v0。

然后 `ThreadsList::add_thread(v0, p)` 建新快照（下一层详解），返回 `new_list` 指向新快照 v1。

```
此时:
  get_java_thread_list() → v0 { _length=0, _threads=[NULL] }
  new_list = v1 { _length=1, _threads=[p, NULL] }
  _java_thread_list → 仍然是 v0（全局指针尚未替换！）
```

```cpp
  ThreadsList *old_list = xchg_java_thread_list(new_list);
```

**第 ② 步——原子替换全局指针。** `xchg_java_thread_list()`（`threadSMR.cpp:159-161`）：

```cpp
inline ThreadsList* ThreadsSMRSupport::xchg_java_thread_list(ThreadsList* new_list) {
  return (ThreadsList*)Atomic::xchg(new_list, &_java_thread_list);
}
```

`Atomic::xchg(new_list, &_java_thread_list)` 原子地把 `new_list`（v1）写入 `_java_thread_list`，同时**返回旧值**（v0）。旧值存到 `old_list`：

```
执行前: _java_thread_list = v0, new_list = v1
xchg:   _java_thread_list = v1, 返回 v0 → old_list = v0
执行后: _java_thread_list → v1 { [p, NULL] }
        old_list = v0 { [NULL] }  ← 脱离全局，只有 old_list 局部变量指着它
```

**为什么必须用 `Atomic::xchg` 而不是简单赋值？** 源码注释直接回答了这个问题（`threadSMR.cpp:390-393`）：

```
// This code does not use locks so its use of the _smr_java_thread_list
// & _threads_hazard_ptr fields is racy relative to code that uses those
// fields with locks. OrderAccess and Atomic functions are used to deal
// with those races.
```

写者之间通过 `Threads_lock` 互斥——没有写-写竞争。但读者**不持锁**——`get_java_thread_list()` 用 `load_acquire` 无锁读取 `_java_thread_list`。写者和读者之间对这个字段的访问是**有竞态的**（"racy"）。

如果写者用 `_java_thread_list = v1` 简单赋值：编译器或 CPU 可能先把 v1 写入指针，再把 v1 的 `_threads` 数组内容（`Copy::disjoint_words`）写入内存——读者在另一个核心上通过 `load_acquire` 读到 v1 指针后，访问 `v1._threads[i]` 可能看到未初始化的垃圾数据。

`Atomic::xchg` 在 x86-64 上编译为 `xchgq` 指令（`atomic_linux_x86.hpp:114`）。Intel 手册规定：`XCHG` 指令在访问内存时**隐含 LOCK 前缀**，自带完整内存屏障。`__asm__ __volatile__` 的 `"memory"` clobber 进一步告诉编译器：这条指令前后不能跨越内存操作的顺序。

效果：`xchg` 之前的所有写（`Copy::disjoint_words` 拷贝数组、`_threads[index] = jt`）对 xchg 之后读到新指针的读者**一定可见**。读者用 `load_acquire` 读指针，形成一个标准的 release-acquire happens-before 关系。

**简单总结：xchg 防的不是其他写者，而是无锁的读者——保证读者读到新指针时，指针指向的内容已经全部写完了。**

新读者通过 `get_java_thread_list()` 拿到 v1；老读者手里还指着 v0 的话不受影响（v0 是独立数组，写者不动它）。

```cpp
  free_list(old_list);
}
```

**第 ③ 步——回收旧快照。** `free_list(old_list)` 先把 v0 头插入 `_to_delete_list`（`threads->set_next_list(_to_delete_list); _to_delete_list = threads;`），然后扫描所有线程的 `_threads_hazard_ptr`。此时所有线程的 `_threads_hazard_ptr == NULL`（没有 ThreadsListHandle 被创建），所以 v0 不在哈希表中 → `delete v0` → `_to_delete_list` 恢复为 NULL。

#### 第 3 层：`ThreadsList::add_thread()`——纯 Copy

`threadSMR.cpp:562-574`：

```cpp
ThreadsList *ThreadsList::add_thread(ThreadsList *list, JavaThread *jt) {
  const uint index = list->_length;                   // index = 0
  const uint new_length = index + 1;                   // new_length = 1
```

计算新列表长度和插入位置。

```cpp
  ThreadsList *const new_list = new ThreadsList(new_length);
```

在堆上分配新 ThreadsList，构造函数执行 `NEW_C_HEAP_ARRAY(JavaThread*, 1+1, mtThread)`——分配 2 个指针槽位（`2 * sizeof(JavaThread*) = 16 字节`），`_threads[1] = NULL`（哨兵），`_length = 1`，`_nested_handle_cnt = 0`。

```cpp
  if (list->_length > 0) {
    Copy::disjoint_words((HeapWord*)list->_threads,
                         (HeapWord*)new_list->_threads, list->_length);
  }
```

旧快照长度为 0 → 条件不成立，跳过 memcpy。没有内容可拷贝。

```cpp
  *(JavaThread**)(new_list->_threads + index) = jt;
  return new_list;
}
```

`new_list->_threads + index` = `new_list->_threads + 0`——指向数组第 0 个槽位。`*(JavaThread**)(...)` 将 `JavaThread* const*` 转型为可写的 `JavaThread**`，写入 `jt`（main_thread 指针）：

```
写入前: new_list._threads = [未初始化, NULL]
写入后: new_list._threads = [main_thread, NULL]
```

`return new_list` 把 v1 返回给第二层。最底层不读全局指针，不涉及替换回收。

### 完成后状态

```
Threads::_thread_list → main_thread → NULL
ThreadsSMRSupport::_java_thread_list → v1 { [main_thread, NULL] }
ThreadsSMRSupport::_to_delete_list → NULL
main_thread._threads_hazard_ptr == NULL
main_thread._on_thread_list == true
```

这就是一个线程从创建到进入 SMR 快照的完整路径。

### 线程退出——`Threads::remove()` 逐行拆解

`Threads::add()` 的对称操作是 `Threads::remove()`（清单 0f:line 355-362）。线程退出时需从两个列表（`_thread_list` 链表和 `_java_thread_list` 快照）中移除自己。

```cpp
void Threads::remove(JavaThread* p, bool is_daemon) {
  { MutexLocker ml(Threads_lock);
```

退出线程自己持 `Threads_lock` 进入。RAII 锁离开 `{}` 时自动 unlock。

```cpp
    ThreadsSMRSupport::remove_thread(p);
```

**第 ① 段——更新 CoW 快照。** `remove_thread(p)` 的源码（清单 0e:line 266-270）结构和 `add_thread` 完全对称：

```cpp
void ThreadsSMRSupport::remove_thread(JavaThread *thread) {
  ThreadsList *new_list = ThreadsList::remove_thread(             // ① 建不含 thread 的新快照
      ThreadsSMRSupport::get_java_thread_list(), thread);
  ThreadsList *old_list = ThreadsSMRSupport::xchg_java_thread_list(new_list);  // ② 原子替换
  ThreadsSMRSupport::free_list(old_list);                         // ③ 回收旧快照
}
```

和 `add_thread` 对比——只有第一行调用的函数不同（`add_thread` → `remove_thread`），xchg 和 free_list 完全一样：

> 下面是一个新示例——假设当前快照是 v3（包含 p 和 T1），编号独立于上面的 add_thread 示例。

```
① new_list = remove_thread(get_java_thread_list(), p)
   → 当前快照 v3 { [p, T1, NULL] } → remove_thread 跳过 p → v4 { [T1, NULL] }
② old_list = xchg_java_thread_list(v4)
   → Atomic::xchg → _java_thread_list = v4, old_list = v3
③ free_list(v3)
   → v3 头插入 _to_delete_list → 扫描 hazard ptr → 有人引用则排队, 无人则 delete
```

`ThreadsList::remove_thread()`（清单 0e:line 247-256）：

```cpp
ThreadsList *ThreadsList::remove_thread(ThreadsList *list, JavaThread *jt) {
  uint i = (uint)list->find_index_of_JavaThread(jt);  // 找到 p 在数组中的下标
```

`find_index_of_JavaThread` 遍历 `_threads` 数组线性搜索。

```cpp
  const uint head_len = i, tail_len = list->_length - 1 - i;
  ThreadsList *const new_list = new ThreadsList(list->_length - 1);
```

新快照少一个线程。`ThreadsList(1)` 分配 `1+1=2` 个槽位。

```cpp
  if (head_len > 0)  // 拷贝 p 前面的元素
    Copy::disjoint_words(list->_threads, new_list->_threads, head_len);
  if (tail_len > 0)  // 拷贝 p 后面的元素（跳过 p 自身）
    Copy::disjoint_words(list->_threads + i + 1, new_list->_threads + i, tail_len);
  return new_list;
```

两段 memcpy 跳过 p——假设 p 在位置 0，`head_len=0`（无前面元素），`tail_len=1`（拷贝位置 1 后到新数组位置 0）。结果 `new_list._threads = [T1, NULL]`。

```cpp
    // 回到 Threads::remove()——从 _thread_list 链表摘除 p：
    JavaThread* current = _thread_list, *prev = NULL;
```

初始化遍历指针。`current` 从链表头出发，`prev` 记录当前节点的前驱——单向链表没有"往回走"的指针，删除中间节点必须知道它的前驱是谁。

```cpp
    while (current != p) { prev = current; current = current->next(); }
```

循环遍历链表直到 `current == p`。每次迭代：把 `current` 记到 `prev`（"前一步的节点"），然后 `current` 跳到下一个节点。循环结束时 `current == p`，`prev` 指向 p 的前驱节点。

例如链表 `T2 → p → T1 → NULL`：第一轮 `prev=T2, current=p` → `current==p` 退出循环，`prev=T2`。

如果 p 在链表头部：`current == p` 立即为真 → 循环体一次都不执行 → `prev = NULL`。

```cpp
    if (prev) prev->set_next(current->next());   // p 在中间：前驱跳过 p 直接指向 p 的后继
    else     _thread_list = p->next();            // p 在头部：更新链表头为 p 的后继
```

**两条分支**：

- `prev != NULL`（p 在中间或尾部）：执行 `prev->set_next(p->next())`。让前驱的 `_next` 指针跳过 p，直接指向 p 后面的节点。p 从链上断开。例如链表 `T2 → p → T1` → `T2.set_next(T1)` → 结果 `T2 → T1`。

- `prev == NULL`（p 在头部）：执行 `_thread_list = p->next()`。更新全局链表头指针，跳过头节点 p。例如链表 `p → T1` → `_thread_list = T1` → 结果 `T1 → NULL`。

两条分支的结果一样——p 从 `_thread_list` 链上摘除了，但 JavaThread(p) 对象还在内存中。后续由 `smr_delete` 决定何时 delete。

```cpp
    _number_of_threads--;
    p->set_terminated_value();
  } // unlock Threads_lock
```

计数器减1。`set_terminated_value()` 把 `p._terminated` 设为 `_thread_terminated`。

离开锁作用域后，p 从两个列表移除但对象仍存活。p 的 `smr_delete()` 在哪里被调用？不在 `remove()` 内——在 `JavaThread::run()` 中（`thread.cpp:1876-1877`），紧跟在 `this->exit(false)` 返回之后：

```cpp
// thread.cpp:1861 — JavaThread::run()
void JavaThread::run() {
  // ... 执行 Java 代码 ...
  this->exit(false);      // line 1876: 内部调 Threads::remove(this)
                          //   → 从链表摘除，CoW 建不含 this 的新快照
  this->smr_delete();     // line 1877: 紧接着——安全删除自己
                          //   → 扫描 hazard ptr → 等读者释放 → delete this
}
```

**这不是 RAII 自动调用**——`this->exit(false)` 和 `this->smr_delete()` 是同一个函数内顺序执行的两行代码。`remove` 只做"从列表移除"，`smr_delete` 才决定"何时 delete this"。中间没有隐藏回调。

关于 `smr_delete()` 内部的流程（完整逐行拆解见第 8 节）：`_on_thread_list` 检查 → if true 走 `ThreadsSMRSupport::smr_delete(this)`（扫描 hazard ptr、有保护则 wait、被唤醒后重扫、无人保护则 delete this）；if false 直接 `delete this`（因为线程从未加入列表，无需 SMR 保护）。

---

## 4. Hazard Pointer——如何安全删除旧快照

### 问题

每次 add/remove 都产生一个新 ThreadsList，旧快照脱离全局指针后被挂入 `_to_delete_list`。`free_list` 此时怎么判断"有没有读者还在用旧快照"？——扫描所有线程的一个公开标签。

### 标签字段

每个线程对象（`Thread` 基类）上有一个 `_threads_hazard_ptr` 字段（`thread.hpp:157`，`ThreadsList* volatile`）。值为 NULL 或指向某个 ThreadsList 快照。这意味着"我正在用这个快照，它的容器和上面的线程都别删"。

### 贴标签——ThreadsListHandle 构造过程

**读者不需要手动操作 `_threads_hazard_ptr`。** 对于读者（例如 GC 的 VMThread），想安全遍历线程列表只需一行声明：

```cpp
// ═══ 读者代码：GC 线程扫描所有线程的栈帧 ═══
void GC::scan_thread_roots() {
  ThreadsListHandle tlh;                          // ← 就这一行！构造 = 自动贴标签
  for (int i = 0; i < tlh.list()->length(); i++) {
    JavaThread *jt = tlh.list()->thread_at(i);    // 无锁遍历，jt 受 SMR 保护
    scan_oop_stacks(jt);                           // 扫描 jt 的栈帧
  }
} // tlh 析构 → 自动摘标签，必要时 notify 等待中的退出线程
```

**这一行声明内部触发了什么？** 下面拆开看——`ThreadsListHandle` 的构造函数，到 `SafeThreadsListPtr` 的构造，到 `acquire_stable_list()`，到 `acquire_stable_list_fast_path()` 的 tag/untag 四步。读者不关心这些内部细节——但本文的目的就是讲透它们。

`ThreadsListHandle` 构造（`threadSMR.cpp:676`）：

```cpp
ThreadsListHandle::ThreadsListHandle(Thread *self) : _list_ptr(self, true) {
```

`self = Thread::current()`（当前线程，比如 VMThread），`acquire = true`——构造时立即获取快照。

`SafeThreadsListPtr(self, true)`（`threadSMR.hpp:220-230`）：

```cpp
SafeThreadsListPtr(Thread *thread, bool acquire) :
  _previous(NULL),               // 链栈上一项，初始 NULL
  _thread(thread),               // 当前线程对象 = VMThread
  _list(NULL),                   // 保护的快照，初始 NULL
  _has_ref_count(false),         // 保护模式，初始 hazard ptr 模式
  _needs_release(false)          // 是否需要析构释放，初始 false
{
  if (acquire) {
    acquire_stable_list();       // acquire=true → 立即进入
  }
}
```

`acquire = true` → 调用 `acquire_stable_list()`（`threadSMR.cpp:366-380`）：

```cpp
void SafeThreadsListPtr::acquire_stable_list() {
  _needs_release = true;
```

标记需要在析构时 `release_stable_list()`。

```cpp
  _previous = _thread->_threads_list_ptr;
  _thread->_threads_list_ptr = this;
```

**为什么要维护一个链？** 上面说的嵌套冲突发生在 `_threads_hazard_ptr` 这个字段上——它同一时刻只能存一个快照指针。但 `_threads_list_ptr` 是另外一个字段：它不存快照，而是串联该线程创建过的多个 `SafeThreadsListPtr` 栈对象，**记住创建顺序**——释放时后进先出。

```cpp
  _previous = _thread->_threads_list_ptr;    // ① 把旧的栈顶记住
  _thread->_threads_list_ptr = this;         // ② 自己成为新的栈顶
```

用具体对象跟踪——假设外层先创建了 `SafeThreadsListPtr` 对象 A（栈上的 ThreadsListHandle 内部成员），内层后创建了对象 B：

**首次创建——外层对象 A 执行这两行：**

```
执行前: _thread->_threads_list_ptr == nullptr          // 链是空的
        _thread->_threads_hazard_ptr == nullptr         // 槽位空闲

行 ①:   A._previous = nullptr                          // A 没有前驱
行 ②:   _thread->_threads_list_ptr = &A                // 链栈顶 → A
```

```
执行后的链:
  _thread->_threads_list_ptr ──→ 对象 A
                                    │ _previous = nullptr
```

**第二次创建——外层 A 还在作用域内，内层对象 B 执行同样的两行：**

```
执行前: _thread->_threads_list_ptr = &A                 // 链栈顶是 A
        _thread->_threads_hazard_ptr = v3               // 槽位被 A 占用！

行 ①:   B._previous = &A                               // B 的前驱是 A
行 ②:   _thread->_threads_list_ptr = &B                // 链栈顶更新为 B
```

```
执行后的链:
  _thread->_threads_list_ptr ──→ 对象 B
                                    │ _previous = &A
                                    ▼
                                  对象 A
                                    │ _previous = nullptr
```

释放时反向操作（`release_stable_list()` 第一行）：`_thread->_threads_list_ptr = _previous`——B 析构后链栈顶恢复为 `&A`，嵌套越深链越长。

**这条链和嵌套冲突的关系**：链本身不解决槽位冲突——它只是记住嵌套顺序，保证释放时后进先出。真正解决槽位冲突的机制在嵌套路径中（第 7 节详述）。

回到 `acquire_stable_list()` 函数体——链维护完之后，接下来的代码决定走 fast path 还是 nested path：

```cpp
  if (_thread->get_threads_hazard_ptr() == NULL) {
    acquire_stable_list_fast_path();
    return;
  }
  acquire_stable_list_nested_path();
```

检查当前线程的 `_threads_hazard_ptr` 字段。NULL → 槽位空闲 → fast path。非 NULL → 已被占用 → nested path（第 7 节详述）。本节讨论 fast path。

#### `acquire_stable_list_fast_path()` 逐行拆解

`threadSMR.cpp:384-432`：

```cpp
void SafeThreadsListPtr::acquire_stable_list_fast_path() {
  ThreadsList* threads;

  while (true) {
```

外层 `while(true)` 循环——任何一步验证失败就重试。没有次数上限（但实际上重试极少，因为全局指针变更不频繁）。

```cpp
    threads = ThreadsSMRSupport::get_java_thread_list();
```

**第 ① 步：拿快照。** `get_java_thread_list()` 用 `load_acquire` 读全局 `_java_thread_list`。此时值假设是 v3（`{ [T1, T2, NULL] }`）。

```
threads = v3  ← 栈上的局部变量
_threads_hazard_ptr 仍然是 NULL（还没贴标签）
```

```cpp
    ThreadsList* unverified_threads = Thread::tag_hazard_ptr(threads);
```

**第 ② 步前半：打 tag。** `tag_hazard_ptr(threads)`（`thread.hpp:165-167`）：

```cpp
static ThreadsList* tag_hazard_ptr(ThreadsList* list) {
  return (ThreadsList*)(intptr_t(list) | intptr_t(1));
}
```

把 `threads`（v3 的指针值）的最低 bit 置 1。假设 v3 = `0x7f123400`，则 `unverified_threads = 0x7f123401`。这个 bit=1 的指针**不能解引用**——它只是一个"半成品"标志。

```cpp
    _thread->set_threads_hazard_ptr(unverified_threads);
```

**第 ② 步后半：贴标签（堆上发布！）。** `set_threads_hazard_ptr()`（`thread.inline.hpp:93-95`）：

```cpp
inline void Thread::set_threads_hazard_ptr(ThreadsList* new_list) {
  OrderAccess::release_store_fence(&_threads_hazard_ptr, new_list);
}
```

**写入当前线程（VMThread）的 `_threads_hazard_ptr` 堆字段**——`release_store_fence` 保证这个写对所有其他线程可见。

```
执行前: VMThread._threads_hazard_ptr == NULL
执行后: VMThread._threads_hazard_ptr == tagged_v3 (0x7f123401, bit0=1)
```

**现在标签已公开**——其他线程（如 T2 的 smr_delete 扫描器）能看到它。但标签 bit0=1 意味着"未验证"——扫描器不会认为这是有效的保护声明。

```cpp
    if (ThreadsSMRSupport::get_java_thread_list() != threads) {
      continue;
    }
```

**第 ③ 步：验证①——重读全局指针。** 再次 `load_acquire` 读 `_java_thread_list`，和第一步读到的 `threads`（v3）比较。

- **相等**：在"拿快照→贴标签"这两步之间，全局指针没被替换 → v3 还是当前最新快照 → 验证通过 → 继续
- **不等**：中间有写者做了 `xchg`（比如 T2 退出建了 v4）→ v3 已过时 → `continue` → 回到 `while(true)` 顶部重新拿快照

```
相等 → 继续; 不等 → 重新读全局指针，重新贴 tagged，再验证
```

```cpp
    if (_thread->cmpxchg_threads_hazard_ptr(threads, unverified_threads)
        == unverified_threads) {
      break;
    }
```

**第 ④ 步：验证②——CAS 去 tag。** `cmpxchg_threads_hazard_ptr()`（`thread.inline.hpp:85-87`）：

```cpp
inline ThreadsList* Thread::cmpxchg_threads_hazard_ptr(
    ThreadsList* exchange_value, ThreadsList* compare_value) {
  return (ThreadsList*)Atomic::cmpxchg(exchange_value, &_threads_hazard_ptr, compare_value);
}
```

`Atomic::cmpxchg(v3, &_threads_hazard_ptr, tagged_v3)`——CAS 的 `exchange_value` 为什么要传 `v3` 而不是先调用 `untag_hazard_ptr(v3)`？因为 `v3` 来自 `get_java_thread_list()`，返回的是一个 8 字节对齐的 `ThreadsList*` 指针——最低 3 bit **天然就是 0**，不需要显式去 tag。CAS 成功时，`_threads_hazard_ptr` 从 `tagged_v3` 变成 `v3`（bit0=0 即已确认），效果等价于"预报标签升级为已验证标签"。返回旧值判定：

- **CAS 成功**（返回值 == tagged_v3）：标签完整地从 tagged 升级为 untagged。`break` 退出循环。
- **CAS 失败**（返回值 != tagged_v3）：标签在中途被抢——T2 的扫描器看到 tagged 标签后，用 CAS 把它清为 NULL 了。`_threads_hazard_ptr` 现在是 NULL ≠ tagged_v3 → CAS 失败 → 回到 `while(true)` 顶部重新拿快照。

```
CAS成功:  _threads_hazard_ptr: tagged_v3 → v3 (已验证) → break
CAS失败:  _threads_hazard_ptr 已是 NULL (被抢) → 重试
```

**如果全局指针在验证①和验证②之间被替换了（比如 v3 → v4），有问题吗？** 没有。CAS 的成功与否绑定的不是全局指针是否变化——而是标签是否被抢：

- 全局指针变了，但标签没被抢 → CAS 成功，hazard ptr = v3 → v3 受保护。T2 的 smr_delete 扫描时发现 v3 包含 T2 → T2 wait。v3 虽然已脱离全局指针，但 hazard ptr 保证它不被 free_list 删除 ← 安全
- 全局指针变了，标签也被抢了 → CAS 失败 → 重试，拿到 v4（不含 T2）← 安全

两种结果都安全。验证①检查的是"贴标签时快照是否已过时"，验证②检查的是"标签是否被并发抢走"——两个验证叠加覆盖了所有竞态窗口。

```cpp
  }
  _list = threads;
  verify_hazard_ptr_scanned();
}
```

`while(true)` 退出时，`threads` 的值是**本次循环开始时读到的那一份快照指针**（比如 v3）。它不一定是最新的 `_java_thread_list`——在 CAS 成功之后，全局指针可能已被其他写者替换为 v4——但这不影响：`_threads_hazard_ptr` 已经在 v3 上，hazard ptr 保护着 v3，v3 不会被 `free_list` 回收。`_list = threads` 把这个已验证的快照保存到 `SafeThreadsListPtr._list` 字段，后续的 `tlh.list()->thread_at(i)` 就是通过这个字段访问线程数组。

`verify_hazard_ptr_scanned()` 在 debug 模式下验证当前线程的 hazard ptr 确实能被扫描器看到——确保 SMR 协议正确性。

**完成后状态**：

```
VMThread._threads_hazard_ptr = v3 (已验证，bit0=0)
SafeThreadsListPtr._list = v3
SafeThreadsListPtr._has_ref_count = false
SafeThreadsListPtr._needs_release = true
```

`_list = v3` 是 SafeThreadsListPtr 栈对象上的字段。此后遍历时通过 `tlh.list()->thread_at(i)` 访问 v3 中的线程——无锁，与全局指针再无关系。

### 释放——ThreadsListHandle 析构（非嵌套场景）

`ThreadsListHandle` 离开作用域时，析构调用 `release_stable_list()`。本节只讲**最常见的非嵌套场景**——`_has_ref_count == false`，即纯 hazard ptr 保护。嵌套场景（`_has_ref_count == true`）涉及引用计数降级，在第 7 节详述。

```cpp
void SafeThreadsListPtr::release_stable_list() {
  _thread->_threads_list_ptr = _previous;
```


**行 A — 从链上摘除。** 构造时把自己推入了 `_threads_list_ptr` 链（非嵌套时 `_previous = nullptr`）。析构反向弹出——这行相当于 `_thread->_threads_list_ptr = nullptr`。嵌套场景涉及更长的链，见第 7 节。

```cpp
  // 非嵌套路径: _has_ref_count == false，走 else 分支：
  assert(_thread->get_threads_hazard_ptr() != NULL, "sanity check");
  _thread->set_threads_hazard_ptr(NULL);
```

**行 B — 清空 hazard ptr。** `release_store_fence` 把 `_threads_hazard_ptr` 写回 NULL。与 acquire 对称：

```
执行前: VMThread._threads_hazard_ptr = v3
行 B:   NULL → release_store_fence
执行后: VMThread._threads_hazard_ptr = NULL  （写者扫描器立刻可见）
```

```cpp
  if (ThreadsSMRSupport::delete_notify()) {
    ThreadsSMRSupport::release_stable_list_wake_up(/*is_nested=*/false);
  }
}
```

**双重检查锁。** 这段代码做了两次 `delete_notify()` 检查——第一次无锁，第二次持 `delete_lock`。

第一次检查就在行 C 本身——`if (ThreadsSMRSupport::delete_notify())`。`delete_notify()` 无锁读 `_delete_notify` flag。如果 `== 0`，意味着没有任何退出线程在 `smr_delete` 中等待 → 直接跳过，**绝大多数 ThreadsListHandle 析构走这条路径**。

如果 `!= 0`，进入 `release_stable_list_wake_up(false)`。这个函数内部（`threadSMR.cpp:908-909`）：

```cpp
MonitorLockerEx ml(delete_lock, ...);          // 获取 delete_lock
if (ThreadsSMRSupport::delete_notify()) {      // 持锁后第二次检查！
  delete_lock->notify_all();                    // 确认后唤醒
}
```

**为什么需要第二次检查？** 在"第一次检查通过"和"获取 delete_lock"之间，可能有**另一个读者也释放了 ThreadsListHandle**——它抢先获取了锁、作了 notify_all、唤醒了等待的退出线程。退出线程被唤醒后清掉了 `_delete_notify`。当我们拿到锁时，`_delete_notify` 可能已经是 0 了。第二次检查防止了不必要的 notify。

举个具体例子：线程 A 和线程 B 同时释放 ThreadsListHandle，T2 在 smr_delete 中等待。

```
A: delete_notify() → 非零 → 准备获取 delete_lock
B: delete_notify() → 非零 → 抢先获取 delete_lock
B: 第二次检查 → 仍非零 → notify_all() → T2 被唤醒
B: 释放 delete_lock
T2: 醒来 → clear_delete_notify() → _delete_notify = 0
A: 获取 delete_lock
A: 第二次检查 → _delete_notify 已经是 0！→ 不 notify → 释放锁
```

如果 A 不做第二次检查，会 notify 一个已经不存在的等待者——虽然无害（notify 空队列是空操作），但体现了协议的正确性。

非嵌套释放总结：清空标签 + 必要时 notify。嵌套场景——含 `_has_ref_count` 分支、`_previous` 链深度恢复、`dec_nested_handle_cnt` 引用计数递减等——完整拆解在第 7 节。

### 写者端——扫描 hazard ptr（两个 Closure）

到这里，读者端的非嵌套生命周期已经清楚了：构造 `ThreadsListHandle` 时贴标签（fast path 四步），析构时摘标签（清空 + 双重检查 notify）。嵌套场景（`_has_ref_count == true` 的释放路径）在第 7 节完整拆解。**接下来看写者端**——当 T2 退出时，`JavaThread::run()` 末尾会调用 `this->smr_delete()`（`thread.cpp:1877`——回忆第 3 节的退出路径：`this->exit(false)` 返回后紧跟着就是 `this->smr_delete()`）。它的核心任务是判断"能不能安全 delete T2"，判据就是下面要拆解的两个 Closure 扫描。

写者的核心操作是扫描所有线程的 `_threads_hazard_ptr`，判断目标线程是否还在某个快照中。HotSpot 用了两个不同的 Closure 来完成这个扫描。

> **`smr_delete()` 的完整逐行拆解在第 8 节**——包括 while(true) 循环、持双锁扫描、is_a_protected 判定、wait/notify 等待唤醒、最终 delete this。本节只拆解 `smr_delete` 内部调用的核心判断——`is_a_protected_JavaThread` 的完整函数体。

### `is_a_protected_JavaThread()` 逐行拆解

这个函数做一件事：判断某个 JavaThread（比如 T2）是否被任何读者的 hazard ptr 保护。先看完整源码，再逐段拆（`threadSMR.cpp:850-892`）：

```cpp
bool ThreadsSMRSupport::is_a_protected_JavaThread(JavaThread *thread) {
  assert_locked_or_safepoint(Threads_lock);

  // ── 第一部分：计算哈希表大小 ──
  int hash_table_size = MIN2((int)get_java_thread_list()->length(), 32) << 1;
  hash_table_size--;
  hash_table_size |= hash_table_size >> 1;   // ... 位扩展求 2 的幂 ...
  hash_table_size++;

  ThreadScanHashtable *scan_table = new ThreadScanHashtable(hash_table_size);

  // ── 第二部分：第一段扫描——扫所有线程的 hazard ptr ──
  ScanHazardPtrGatherProtectedThreadsClosure scan_cl(scan_table);
  threads_do(&scan_cl);
  OrderAccess::acquire();

  // ── 第三部分：第二段扫描——扫 _to_delete_list 中的引用计数 ──
  ThreadsList* current = _to_delete_list;
  while (current != NULL) {
    if (current->_nested_handle_cnt != 0) {
      AddThreadHazardPointerThreadClosure add_cl(scan_table);
      current->threads_do(&add_cl);
    }
    current = current->next_list();
  }

  // ── 第四部分：查哈希表，返回结果 ──
  bool thread_is_protected = scan_table->has_entry((void*)thread);
  delete scan_table;
  return thread_is_protected;
}
```

---

#### 第一部分：建立保护名单

`is_a_protected_JavaThread(T2)` 要回答一个问题：T2 是否在任何人的标签保护下？直接的做法是逐个线程问"你的标签指向的快照里有没有 T2"，但标签可能指向同一个快照（比如两个读者都拿着 v3），重复遍历没有意义。

哈希表的角色是**收集所有"受保护"的 JavaThread 指针，去重**。第一段扫描把 hazard ptr 保护的线程加进去，第二段扫描把引用计数保护的线程补进去。最后只看一件事：`scan_table->has_entry(T2)`。

```cpp
  int hash_table_size = MIN2((int)get_java_thread_list()->length(), 32) << 1;
  // ... 位扩展求 2 的幂，上限 64 ...
  ThreadScanHashtable *scan_table = new ThreadScanHashtable(hash_table_size);
```

大小取 `Min(线程数, 32) × 2` 后再向上取 2 的幂——上限 64 个槽位，足够存下所有受保护线程且不浪费空间。

---

#### 第二部分：第一段扫描——扫所有线程的 `_threads_hazard_ptr`

```cpp
  ScanHazardPtrGatherProtectedThreadsClosure scan_cl(scan_table);
```

HotSpot 中 Closure 是一个对象，装着一个 `do_thread(Thread*)` 方法——它是"对每个线程做什么"的封装。名字本身就说明了它的职责：

- **Scan**：扫描
- **HazardPtr**：每个线程的 `_threads_hazard_ptr` 字段
- **GatherProtected**：收集被保护的
- **Threads**：JavaThread 指针

整个对象做的就是一件事：遍历线程时，对每个线程调用 `do_thread()`，判断这个线程的 hazard ptr 是否在保护某个快照——如果是，把该快照上的全部 JavaThread 收集到哈希表里。`scan_table` 就是这个哈希表——传给构造函数后，对象内部的所有 `add_entry` 操作都往这个表里写。

```cpp
  threads_do(&scan_cl);
```

`threads_do` 是调度者——遍历所有 JavaThread，对每个线程调一次 `scan_cl.do_thread(thread)`。下面拆解 `do_thread()` 内部的判断逻辑：

```cpp
virtual void do_thread(Thread *thread) {
  assert_locked_or_safepoint(Threads_lock);
  if (thread == NULL) return;                    // ① 防御检查

  ThreadsList *current_list = NULL;
  while (true) {                                 // ② 循环——标签可能被并发修改
    current_list = thread->get_threads_hazard_ptr(); // ③ load_acquire 读标签
    if (current_list == NULL) return;             // ④ NULL → 此线程无保护，跳过

    if (!Thread::is_hazard_ptr_tagged(current_list)) break;  // ⑤ untagged → 正常收集
    // ⑥ tagged → 抢走：
    if (thread->cmpxchg_threads_hazard_ptr(NULL, current_list) == current_list) return;
    // ⑦ CAS 失败 → 读者恰好完成去 tag → 重读 → 回到②
  }
  // ⑧ 到这里 current_list 是已验证的快照指针
  AddThreadHazardPointerThreadClosure add_cl(_table);
  current_list->threads_do(&add_cl);              // ⑨ 收集快照上的全部线程入哈希表
}
```

**逐行解释**：

③ `get_threads_hazard_ptr()` → `load_acquire` 读。当前线程的标签可能是 NULL（无保护）、tagged_v3（未验证）、v3（已验证）。

④ 读到 NULL → `return`。此线程没有保护任何快照，跳过。

⑤ `is_hazard_ptr_tagged(current_list)` 检查最低 bit。untagged → `break` 跳到⑧正常收集。tagged → 继续⑥。

⑥ `cmpxchg(NULL, tagged_v3)` — CAS 抢走。**CAS 成功后为什么不收集？** 因为这个标签是 tagged（未验证）——扫描器无法确定它指向的快照是否还有效。读者可能验证①发现 v3 过期然后放弃了，也可能验证通过正准备去 tag。扫描器选择**不信任**：抢走标签，不把此快照的线程加入保护集合。

**不收集会不会导致写者错误地认为"没人保护 T2"？** 会——写者可能因此 delete 了 T2。但此时全局指针已经被 xchg 换成了不含 T2 的 v4。读者 CAS 失败后重试，拿到的也是 v4——v4 里没有 T2，不需要保护 T2。tag/untag 不保证写者不做错事——它保证读者最终遍历的快照不包含已 delete 的线程。**`return` 只跳过当前这一个线程**——调用方 `threads_do()` 继续遍历下一个 JavaThread。

**标签被抢走后，读者会怎样？** 回到 `acquire_stable_list_fast_path()` 的验证②（回顾第 4 节）：

```cpp
// 读者端：试图从 tagged_v3 升级到 v3
if (_thread->cmpxchg_threads_hazard_ptr(threads, unverified_threads)
    == unverified_threads) { break; }
// _threads_hazard_ptr 已经是 NULL（被抢），不等于 unverified_threads → CAS 失败
// → 回到 while(true) 顶部 → 重新读全局指针 → 拿到 v4 → 重贴 tagged_v4 → 验证通过
```

读者不是读到 NULL 就认命——CAS 失败触发**重试**，重试时拿到新的全局快照 v4（不含 T2），安全遍历。扫描器抢走标签 → `_threads_hazard_ptr = NULL` → 读者 CAS 失败 → 重试 → v4。读者自身不需要感知"被抢"这个事实——它只知道 CAS 没通过，重新来一次。

⑧⑨ 只有 untagged 标签到达这里。`current_list->threads_do(&add_cl)` 遍历 `v3._threads = [T1, T2]`，把 T1、T2 都加入哈希表。

**第一段扫描完**，哈希表包含了所有被任何线程的 hazard ptr 保护的 JavaThread。

```cpp
  OrderAccess::acquire();
```

acquire 屏障——保证①-⑨的 hazard ptr 读取**排在**第三部分的引用计数读取之前。

---

#### 第三部分：第二段扫描——扫 `_to_delete_list` 中的引用计数

```cpp
  ThreadsList* current = _to_delete_list;
  while (current != NULL) {                     // 遍历所有待删除的旧快照
    if (current->_nested_handle_cnt != 0) {     // 有外层通过引用计数在保护这个快照
      AddThreadHazardPointerThreadClosure add_cl(scan_table);
      current->threads_do(&add_cl);             // 把快照上的全部线程加入保护集合
    }
    current = current->next_list();
  }
```

**这个循环在做什么？** 第一段扫描只检查了 `_threads_hazard_ptr` 字段。但嵌套场景中（第 7 节），外层会把 `_threads_hazard_ptr` 清空、改用 `_nested_handle_cnt` 引用计数来保护快照——第一段扫不到这种保护。第二段遍历 `_to_delete_list`，找到引用计数 > 0 的旧快照，把它们上面的线程补进保护集合。

**嵌套不在本节范围**——`_nested_handle_cnt` 何时被设为非零、外层如何降级为引用计数、为什么需要引用计数而不是多给几个 hazard ptr 槽位——这些都在第 7 节完整拆解。这里你只需要知道：第二段扫描是兜底机制，补第一段的漏。**在非嵌套场景（绝大多数情况），所有快照的 `_nested_handle_cnt` 都是 0，第二段扫描等于什么都没做**——`while` 循环遍历完 `_to_delete_list`，每个快照的条件都不满足，直接跳过。

---

#### 第四部分：判定——T2 在保护名单里吗？

两段扫描结束后，哈希表就是"保护名单"——所有被任何机制保护的 JavaThread 指针都在里面。现在只需要查表：

```cpp
  bool thread_is_protected = scan_table->has_entry((void*)thread);
```

`has_entry(thread)` 在哈希表中查找 T2。在表中 → T2 受保护，`smr_delete` 必须 wait。不在表中 → T2 可以安全 delete。

```cpp
  delete scan_table;
  return thread_is_protected;
```

哈希表只在本次 `is_a_protected_JavaThread` 调用期间存活——释放后返回结果。

---

#### 小结：两段扫描防什么

| 扫描段 | 扫什么 | 补什么 |
|--------|-------|--------|
| 第一段 | 所有线程的 `_threads_hazard_ptr` | 通过 hazard ptr 保护的快照上的线程 |
| 第二段 | `_to_delete_list` 中 `_nested_handle_cnt > 0` 的快照 | 通过引用计数保护的快照上的线程（嵌套降级场景） |

两段扫描都会把找到的 `JavaThread*` 加入同一个哈希表。最后 O(1) 查表判定。`OrderAccess::acquire()` 保证第一段和第二段之间的正确时序——hazard ptr 读先于引用计数读。

---

### 同时：`free_list` 用的另一个 Closure

`free_list()` 也需要扫描——但它不是判断"某个 JavaThread 是否受保护"，而是判断"某个 ThreadsList 容器是否还在被引用"。所以它用了一个更简单的 Closure——`ScanHazardPtrGatherThreadsListClosure`，只收集 ThreadsList* 指针本身，不展开到 JavaThread。细节见第 8 节 free_list() 逐行拆解。




## 5. 并发窗口和 tag/untag 如何堵住它

### 竞态时序

第 4 节假设读者先贴标签、写者再扫描。现实中两者并发。下面是竞态窗口的完整时序：

```
时刻  VMThread（读者，无锁）               T2（正退出，持 Threads_lock）
────  ───────────────────────────────  ───────────────────────────────
t1    threads = get_java_thread_list() → v3 ← 拿到 v3 快照指针
                                                 此时 v3._threads = [T2, T1, NULL]

t2                                       T2 在 Threads::remove(this) 中：
                                            从 _thread_list 摘除 T2
                                            CoW 建 v4 = { [T1, NULL] }
t3                                       Atomic::xchg → _java_thread_list = v4
                                            v4 不含 T2

t4                                       T2 开始 smr_delete(this) → 扫描
t5                                         scan VMThread._threads_hazard_ptr
t6                                         → NULL（VMThread 还没贴！）
t7                                       扫描结束：全 NULL → T2 不受保护
t8                                       delete this ← T2 把自己 delete！

t9    _threads_hazard_ptr = v3          ← VMThread 贴上标签
t10   list->thread_at(1) 是 T2          ← 野指针！
```

**崩溃根源**：VMThread 的 t1（拿 v3）到 t9（贴标签）之间有 8 个时刻的缝隙。T2 在这个缝隙里完成了 remove + scan + delete self。等 VMThread 贴标签时，T2 已死。

### tag/untag 如何解决

tag/untag 把 VMThread 的"贴标签"从一步 `store` 变成可验证+可重试的两阶段操作。对照同一张时序图看效果：

```
时刻  VMThread（有 tag/untag）              T2
────  ──────────────────────────────────  ─────────────────────────────
t1    threads = get_java_thread_list() → v3

t2                                          T2: remove + CoW + xchg → v4

t3    tagged_v3 = tag_hazard_ptr(v3)      ← 贴预报标签！
      VM._threads_hazard_ptr = tagged_v3    (bit0=1)

t4                                          T2: smr_delete → 扫描
t5                                          scan VM._threads_hazard_ptr
t6                                          → tagged_v3 (bit0=1)
                                            → tagged → CAS 抢走(NULL)
                                            → T2 不保护 → delete T2

t7    验证①: get_java_thread_list() → v4 ≠ v3
      → 过时！→ continue（重试）

t8    重试: get_java_thread_list() → v4
      tagged_v4 → 验证通过 → CAS 成功
      VM._threads_hazard_ptr = v4
      遍历 v4: [T1, NULL] → 安全！
```

**三步改变**：

1. **t3 贴预报标签**——VMThread 在 t3 就贴了 tagged_v3，比无 tag/untag 的 t9 提前了 6 个时刻。T2 的扫描器在 t6 不再读到 NULL（读到 tagged_v3），就不会误判"无人保护"然后 delete
2. **t7 验证① 发现过期**——VMThread 重读全局指针发现 v4 ≠ v3，放弃 v3 重试
3. **t8 重试拿到 v4**——v4 不含 T2，遍历安全

**核心机制**：预报标签（bit0=1）在 t3 就保护了 v3 容器不被 `free_list` 删除。虽然 T2 的扫描器"不信" tagged 标签（抢走了），但 VMThread 的 CAS 失败触发重试，重试时拿到不含 T2 的 v4。

---

## 6. 两个验证的覆盖关系

`acquire_stable_list_fast_path()` 中有两个验证：

```
VMThread: ①读v3 → ②贴tagged_v3 → ③重读(验证①) → ④CAS(验证②)

T2 的 xchg 有三种时序位置：
  在③之前 → 验证① 重读发现 v4 ≠ v3 → retry
  在③和④之间 → 验证① 通过(还是v3)，但CAS时标签被抢 → 验证② retry
  在④之后 → 标签已是untagged，T2扫描时看到已验证 → T2 wait
```

三种时序，两个验证全覆盖。不存在漏掉的窗口。写者端扫描的完整源码（while(true) + CAS 抢标签）见第 4 节"写者端——扫描 hazard ptr"。

---

## 7. 嵌套遍历——一个字段，两个快照

### 7.1 困境

第 4 节的 fast path 假设 `_thread->get_threads_hazard_ptr() == NULL`——槽位空闲，贴标签走人。但如果槽位已经被占了呢？

回顾 `acquire_stable_list()` 的分岔代码（`threadSMR.cpp:372-379`）：

```cpp
if (_thread->get_threads_hazard_ptr() == NULL) {
    acquire_stable_list_fast_path();        // 槽位空 → 常规
} else {
    acquire_stable_list_nested_path();      // 槽位被占 → 本节要讲解的
}
```

什么时候槽位会被占？当同一个线程在持有一个 `ThreadsListHandle` 的作用域内，又创建了另一个 `ThreadsListHandle`。真实源码场景——`JVM_SuspendThread`（`jvm.cpp:2998`）→ `java_suspend()`（`thread.cpp:2377`）：

```cpp
// jvm.cpp:2998 — 外层：正在处理 JVM_SuspendThread 请求
JVM_ENTRY(void, JVM_SuspendThread(JNIEnv* env, jobject jthread))
  ThreadsListHandle tlh(thread);                     // 外层 tlh — 槽位被占！
  JavaThread* receiver = ...;
  if (is_alive) {
    receiver->java_suspend();                        // → 进入内层
  }
JVM_END

// thread.cpp:2377 — 内层：同一个线程，同一个调用栈
void JavaThread::java_suspend() {
    ThreadsListHandle tlh;                           // 内层 tlh — 需要槽位！
    if (!tlh.includes(this) || ...) { return; }
}
```

外层 tlh 构造时走了 fast path 四步，`_threads_hazard_ptr` 指向 v3。`java_suspend()` 在同一个线程上被调用——内层 tlh 构造时，`acquire_stable_list()` 发现 `_threads_hazard_ptr != NULL`，触发 nested path。本节拆解这个路径做了什么。

在拆解 4 行代码之前，先看**此刻各字段的状态**——`JVM_SuspendThread` 中外层 tlh 已创建完毕，`java_suspend()` 刚进入，内层 tlh 的构造即将触发 nested path：

```
所属对象                          字段                 当前值
────────────────────────────────────────────────────────────────
当前线程（调用 JVM_SuspendThread 的那个 JavaThread）:
  Thread                         _threads_hazard_ptr  v3        ← 外层 tlh 通过 fast path 设置的
  Thread                         _threads_list_ptr    null     ← 非嵌套时只有一个 SafeThreadsListPtr
外层 SafeThreadsListPtr（栈上的 RAII 对象，外层 tlh 内部成员）:
  SafeThreadsListPtr(外层)        _list                v3
  SafeThreadsListPtr(外层)        _has_ref_count       false    ← 仍是 hazard ptr 模式
  SafeThreadsListPtr(外层)        _previous             null
快照 v3（ThreadsList 容器）:
  ThreadsList(v3)                _nested_handle_cnt    0        ← 尚未被任何嵌套引用
内层 SafeThreadsListPtr（刚创建，尚未走 acquire）:
  SafeThreadsListPtr(内层)        _list                null     ← 尚未关联任何快照
  SafeThreadsListPtr(内层)        _has_ref_count       false
```

内层 tlh 构造触发 `acquire_stable_list()` → 第一行就是 `_previous = _thread->_threads_list_ptr`（取到 null），然后 `_thread->_threads_list_ptr = this`（内层成为链栈顶）。接着 `_thread->get_threads_hazard_ptr() == v3 != NULL` → **触发 nested path**。

### 嵌套路径——4 行代码

`acquire_stable_list_nested_path()`（`threadSMR.cpp:437-467`）：

```cpp
void SafeThreadsListPtr::acquire_stable_list_nested_path() {
  ThreadsList* current_list = _previous->_list;   // ① 取外层保护的快照 v3
  current_list->inc_nested_handle_cnt();           // ② v3 引用计数 +1
  _previous->_has_ref_count = true;                // ③ 外层切到引用计数模式
  _thread->_threads_hazard_ptr = NULL;             // ④ 清空字段！腾给内层
  acquire_stable_list_fast_path();                 // ⑤ 内层走 fast path 贴新标签
}
```

**每行执行后的状态变化**：

执行前：`_threads_hazard_ptr = v3`（字段被外层占），`v3._nested_handle_cnt = 0`，`SafeThreadsListPtr(外层)._has_ref_count = false`

行①：`current_list = v3`（取外层 `_list` 的值，没有任何新操作）

行②：`v3.inc_nested_handle_cnt()` → `v3._nested_handle_cnt = 1`。引用计数 +1——用的是 CAS 循环（`Atomic::cmpxchg`），保证多核并发安全。

行③：`SafeThreadsListPtr(外层)._has_ref_count = true`。外层标记为引用计数模式——析构时不再清 hazard ptr，改为 dec 引用计数。

行④：`_threads_hazard_ptr = NULL`。线程标签清空，字段腾出。

行⑤：`acquire_stable_list_fast_path()` → 内层走正常流程贴新标签。

执行后：`_threads_hazard_ptr = v5`（内层占用），外层靠 `v3._nested_handle_cnt = 1` 保护。

### 写者如何看到引用计数保护

外层 v3 从 `_threads_hazard_ptr` 消失了——写者只扫描 `_threads_hazard_ptr` 会漏掉它。所以 `is_a_protected_JavaThread()` 做了两段扫描。

**第一段——扫描所有线程的 hazard ptr（这是之前第 4 节讲解的机制）**：

```cpp
ScanHazardPtrGatherProtectedThreadsClosure scan_cl(scan_table);
threads_do(&scan_cl);
```

`threads_do(&scan_cl)` 遍历所有 JavaThread，对每个线程调用 Closure A——读取 `_threads_hazard_ptr`，untagged → 收集快照上的全部线程，tagged → 抢走。这部分在第 4 节"写者端——扫描 hazard ptr"中已完整逐行拆解。

```cpp
OrderAccess::acquire();
```

**acquire 屏障的关键作用**：保证 Closure A 对 `_threads_hazard_ptr` 的读取在屏障之前完成，第二段对 `_nested_handle_cnt` 的读取在屏障之后才发生。为什么这很重要？

如果在读 hazard ptr 之前就读了 `_nested_handle_cnt`，可能看到的是外层刚清空 hazard ptr 但还没递增引用计数的中间态——导致漏掉这个快照。acquire 屏障强制"hazard ptr 读"先于"引用计数读"，要么 hazard ptr 还在（第一段看到），要么引用计数已递增（第二段看到）。两者必中其一。

**第二段——遍历 `_to_delete_list`，补齐引用计数保护**：

```cpp
ThreadsList* current = _to_delete_list;
```

`_to_delete_list` 是一条 ThreadsList 链表——所有脱离了全局指针但尚未被 delete 的旧快照都在这里排队。遍历它而不是遍历线程的 `_threads_hazard_ptr`。

**v3 什么时候进了 `_to_delete_list`？** 嵌套路径本身只做了降级——把 v3 的保护方式从 hazard ptr 换成引用计数，没有把 v3 放入 `_to_delete_list`。v3 进入 `_to_delete_list` 是之后的写操作触发的：某次 `add_thread` 或 `remove_thread` 执行 CoW → xchg 替换 `_java_thread_list` → `free_list(v3)` 把 v3 头插入 `_to_delete_list`。此时 v3 的 `_nested_handle_cnt = 1`——嵌套降级已经给它加了保护，所以 `free_list` 扫描时即使找不到 hazard ptr 指向 v3，也会因为引用计数 > 0 而保留它不被 delete。之后 `is_a_protected_JavaThread` 的第二段扫描就是在 `_to_delete_list` 中找到这样的 v3，把它的线程加入保护集合。

```cpp
while (current != NULL) {
```

遍���整条链，从表头到 NULL。每个节点是一个 ThreadsList 容器。

```cpp
  if (current->_nested_handle_cnt != 0) {
```

检查当前快照的嵌套引用计数。如果 `!= 0` → 有外层（或更外层）通过引用计数在保护它 → 这个快照上的所有线程都应被视为"受保护"。

```cpp
    AddThreadHazardPointerThreadClosure add_cl(scan_table);
    current->threads_do(&add_cl);
```

`add_cl` 和第一段的 Closure A 不同——A 处理的是"标签值"，要区分 tagged/untagged。`add_cl` 处理的是"确定受保护的快照"——直接把快照的 `_threads` 数组中的每个 `JavaThread*` 加入哈希表，不需要区分状态。

```cpp
  }
  current = current->next_list();
}
```

如果 `_nested_handle_cnt == 0` → 当前快照不受引用计数保护 → 跳过（`else` 隐式：不收集）。`current = current->next_list()` 移到下一个快照。

**两段扫描的协作**——假设外层刚完成嵌套降级（hazard ptr 清空，引用计数 +1），T2 恰好在此时调用 `is_a_protected_JavaThread(T2)`：

```
情况 A：T2 扫描时，acquire 屏障之前 hazard ptr 还没被清空
  → Closure A 读到 v3 → 收集 v3._threads → T2 受保护 ✓

情况 B：T2 扫描时，acquire 屏障之后 hazard ptr 已经被清空
  → Closure A 读不到 v3
  → acquire 保证 _nested_handle_cnt 的读取在之后
  → 第二段读到 v3._nested_handle_cnt = 1 → 收集 v3._threads → T2 受保护 ✓
```

无论哪种情况，外层保护的快照 v3 都不会被遗漏。

最后看 `is_a_protected_JavaThread()` 的函数签名和收尾部分：

```cpp
bool ThreadsSMRSupport::is_a_protected_JavaThread(JavaThread *thread) {
  // (两段扫描逻辑——上面已逐行拆解)

  bool thread_is_protected = scan_table->has_entry((void*)thread);
```

两段扫描执行完后，哈希表 `scan_table` 包含了所有"受保护"的 JavaThread 指针。`has_entry(thread)` 用黄金比例哈希查找目标线程是否在表中——O(1) 查找。

```cpp
  delete scan_table;
  return thread_is_protected;
}
```

`delete scan_table` 释放本次扫描创建的临时哈希表。`return thread_is_protected`——如果为 true，调用者（`smr_delete()` 或 `free_list()`）就知道目标对象仍然受保护，不能释放。

---

## 8. 两层回收——smr_delete() 和 free_list() 的协作

一个线程退出有两样东西要回收：
- **JavaThread 对象**（大——含线程栈、锁、JNI handle）→ `smr_delete()` 阻塞等待，确保尽快回收
- **旧 ThreadsList 容器**（小——容器头 + 指针数组）→ `free_list()` 机会主义清理，能删就删

### smr_delete() 逐行拆解

T2 退出时自己调用 `smr_delete(this)`（`thread.cpp:1877`），进入 `ThreadsSMRSupport::smr_delete()`（`threadSMR.cpp:944-1019`）：

```cpp
void ThreadsSMRSupport::smr_delete(JavaThread *thread) {
  while (true) {
```

外层 `while(true)`——如果检测到 T2 受保护就 wait，被唤醒后重扫，直到安全才 exit 循环。

```cpp
    {
      MutexLockerEx ml(Threads_lock, Mutex::_no_safepoint_check_flag);
```

T2 获取 `Threads_lock`。**为什么需要这个锁？** 下一行要调用 `is_a_protected_JavaThread()`，它内部的 `threads_do()` 必须在持有 `Threads_lock` 或处于 safepoint 时才能安全遍历线程列表——否则遍历中途其他写者可能修改线程集合。

但 `Threads_lock` 是一个全局重量级锁——持有时会阻塞所有其他写者的 `Threads::add()` 和 `Threads::remove()`。如果 T2 持着它进入 wait，整个 JVM 的线程创建/退出全部冻结。

```cpp
      delete_lock()->lock_without_safepoint_check();
      set_delete_notify();
```

再获取 `delete_lock`。**为什么需要第二个锁？** `delete_lock` 不是一个互斥锁——它是一个**专用的 wait/notify 协作锁**，只用于 `smr_delete` 的等待/唤醒协调。T2 接下来会：
1. 持双锁调用 `is_a_protected_JavaThread()`（需要 `Threads_lock` 才能遍历线程）
2. 如果受保护 → **释放 `Threads_lock`**（让其他写者继续工作），但**保持 `delete_lock`**
3. 在 `delete_lock` 上 `wait()`——原子释放 `delete_lock` 并休眠
4. 被读者的 `release_stable_list()` 中的 `notify_all()` 唤醒后，重新竞争两个锁，重扫

**两个锁的分工**：`Threads_lock` 保护"扫描线程列表"这个操作的数据一致性。`delete_lock` 只保护"等待/唤醒"这个协调状态。分离后，T2 在 wait 期间不持有 `Threads_lock`，其他写者和读者完全不受影响。

`set_delete_notify()` 把全局 `_delete_notify` 设为非零——这是给读者的信号："有线程在 delete_lock 上等待，你释放标签时请通知我。"

```
此时:
  Threads_lock: 被 T2 持有
  delete_lock: 被 T2 持有
  _delete_notify = 非零（刚设置）
```

```cpp
      if (!is_a_protected_JavaThread(thread)) {
```

扫描所有线程的 `_threads_hazard_ptr`，检查 T2 是否受保护。`ScanHazardPtrGatherProtectedThreadsClosure` 对每个线程读 `get_threads_hazard_ptr()`——如果有线程的值指向的快照包含 T2，T2 受保护。

**不受保护（常见）→ 直接 break，跳去 delete**：

```cpp
        clear_delete_notify();          // _delete_notify 回 0
        delete_lock()->unlock();        // 释放 delete_lock
        break;
      }
    } // Threads_lock 离开作用域释放
```

**受保护（需要等）→ 不进入 if，继续往下**：

`}` 离开 ML 作用域 → `Threads_lock` 被释放（让其他写者继续），但 `delete_lock` 仍被持有。

```cpp
    delete_lock()->wait(Mutex::_no_safepoint_check_flag, 0,
                        !Mutex::_as_suspend_equivalent_flag);
```

`wait(timeout=0)` 在 `delete_lock` 上休眠——**原子释放 delete_lock 并进入等待**。timeout=0 表示无限等待，直到被 `notify_all` 唤醒。

被唤醒后重新竞争 `delete_lock` 获取锁，wait 返回。

```cpp
    clear_delete_notify();
    delete_lock()->unlock();
  }
```

回到 `while(true)` 顶部——重新持锁、重新扫描。如果此时读者已释放标签 → `is_a_protected` 返回 false → break。

```cpp
  delete thread;
}
```

`delete this`——释放 JavaThread 对象。

### free_list() 逐行拆解

`free_list()`（`threadSMR.cpp:779-845`）在每次 add/remove 时被调用，不阻塞，能删就删，不能就留。

```cpp
void ThreadsSMRSupport::free_list(ThreadsList* threads) {
  assert_locked_or_safepoint(Threads_lock);

  threads->set_next_list(_to_delete_list);
  _to_delete_list = threads;
```

头插入 `_to_delete_list`——这是一条通过 `ThreadsList._next_list` 串起的 ThreadsList 链表（不是 JavaThread 的链表）：

```
执行前: _to_delete_list → v2 → v1 → NULL
行 A:   threads->set_next_list(v2)  → threads._next_list = v2
行 B:   _to_delete_list = threads
执行后: _to_delete_list → threads → v2 → v1 → NULL
```

```cpp
  int hash_table_size = MIN2((int)get_java_thread_list()->length(), 32) << 1;
```

**free_list 的哈希表存什么？** 和 `is_a_protected_JavaThread` 的哈希表不同——那里存的是 JavaThread 指针，回答"这个线程是否受保护"。这里存的是 **ThreadsList 指针**，回答"这个旧快照容器是否还有人在用"。

`free_list` 后续遍历 `_to_delete_list` 时，对每个旧快照问一句：`scan_table->has_entry(v3)` —— 如果 v3 在表中，说明有线程的 hazard ptr 还在指着它，不能删。如果不在，安全 delete。

```cpp
  hash_table_size--;
  hash_table_size |= hash_table_size >> 1;
  hash_table_size |= hash_table_size >> 2;
  hash_table_size |= hash_table_size >> 4;
  hash_table_size |= hash_table_size >> 8;
  hash_table_size |= hash_table_size >> 16;
  hash_table_size++;
```

**第 ② 步——位扩展求 2 的幂。** 这段位操作把任意整数向上取整到最近的 2 的幂。例如基数 6：

```
6 - 1 = 5          → 二进制 0101
| >> 1 = 0111      → 7
| >> 2 = 0111      → 7
| >> 4 = 0111      → 7
| >> 8 = 0111      → 7
| >> 16 = 0111     → 7
7 + 1 = 8          → 最终 hash_table_size = 8
```

为什么需要 2 的幂？哈希表用掩码取模（`index = hash & (size - 1)`），2 的幂让 `size - 1` 是全 1 掩码，取模变成一次位与——比除法快一个数量级。

```cpp
  ThreadScanHashtable *scan_table = new ThreadScanHashtable(hash_table_size);
```

**第 ③ 步——分配哈希表。** `ThreadScanHashtable`（`threadSMR.cpp:169-205`）内部用 `ResourceHashtable` 存储指针。哈希函数是黄金比例乘法：`ptr * 2^32 * Phi`（2654435761），将任意指针值均匀映射到 0~size-1 范围内，避免碰撞聚集。

```cpp
  ScanHazardPtrGatherThreadsListClosure scan_cl(scan_table);
  threads_do(&scan_cl);
```

**第 ④ 步——扫描并填充哈希表。** `threads_do(&scan_cl)` 遍历所有 JavaThread，对每个线程调用 `ScanHazardPtrGatherThreadsListClosure.do_thread()`。这个 Closure 的逻辑非常简单：

```
① get_threads_hazard_ptr()  → 读标签值
② if NULL → 跳过此线程
③ untag_hazard_ptr()  → 去掉 tag bit
④ 把去 tag 后的 ThreadsList* 指针加入哈希表
```

**为什么即使标签是 tagged 也收集？** 这个哈希表决定的是"哪些 ThreadsList 容器不能被 delete"。如果一个 tagged 标签指向 v3——即使读者还没验证完——贸然 delete v3 的风险远大于多保留 v3 一会儿。保守策略：宁可多留一轮 free_list，不要删一个可能正在被保护（只是还没验证完）的快照。

**这里不需要第二段扫描。** `free_list` 不是判断"某个 JavaThread 受不受保护"（那是 `is_a_protected_JavaThread` 的职责），而是判断"某个 ThreadsList 容器能不能 delete"。Closure B 收集完 hazard ptr 后，后面遍历 `_to_delete_list` 时**同时检查两个条件**——`!has_entry(current) && current->_nested_handle_cnt == 0`——hazard ptr 引用和引用计数在一次遍历中同时判断。不需要分成两段。

```
扫描结果示例（假设 VMThread._threads_hazard_ptr = v3, 其他线程 = NULL）:
  scan_table 内容 = {v3}
  含义: v3 至少被一个线程的 hazard ptr 引用，不能删除
```

```cpp
  OrderAccess::acquire();
```

确保 hazard ptr 的读排在引用计数读之前。

```cpp
  ThreadsList* current = _to_delete_list;
  ThreadsList* prev = NULL;
  bool threads_is_freed = false;
```

初始化遍历指针：`current` = 链表头，`prev` = 前驱（用于摘除操作），`threads_is_freed` = 调试用（跟踪参数是否被成功删除）。

```cpp
  while (current != NULL) {
    next = current->next_list();
```

每轮先保存 `next`——`current` 可能在循环体中被 `delete`，不能再访问 `next_list()`。

```cpp
    if (!scan_table->has_entry((void*)current) && current->_nested_handle_cnt == 0) {
```

两个条件同时满足才释放：
- 条件① `!has_entry(current)`——没有任何线程的 hazard ptr 指向此快照
- 条件② `_nested_handle_cnt == 0`——没有嵌套引用计数保护

```cpp
      if (prev != NULL) { prev->set_next_list(next); }
      if (_to_delete_list == current) { _to_delete_list = next; }
```

链表摘除操作——如果 `current` 是表头，更新全局 `_to_delete_list`；如果 `current` 在中间，让 `prev` 跳过 `current` 直指 `next`。

```cpp
      if (current == threads) threads_is_freed = true;
      delete current;
```

释放 ThreadsList 容器——调用其析构函数，释放 `_threads` 数组和对象自身。

```cpp
    } else {
      prev = current;    // 不删 → 保留在链表中
    }
    current = next;
  }
```

不满足删除条件的快照留在链表中（`prev = current`），下一轮遍历继续。`current = next` 移到下一个节点。

```cpp
  if (!threads_is_freed) {
    log_debug(thread, smr)("... is not freed.");
  }
  delete scan_table;
}
```

如果参数 `threads` 没能成功回收，打 debug 日志。释放临时哈希表。

---

## 9. 字段总览

| 所属对象 | 字段 | 类型 | 作用 |
|---------|------|------|------|
| `Threads` | `_thread_list` | `static JavaThread*` | 全局标准链表 |
| `JavaThread` | `_next` | `JavaThread*` | 链表 next 指针 |
| `ThreadsSMRSupport` | `_java_thread_list` | `static ThreadsList* volatile` | 全局 CoW 快照指针 |
|  | `_to_delete_list` | `static ThreadsList*` | 待删除旧快照链表头 |
|  | `_delete_notify` | `static volatile uint` | 双重检查锁 flag |
| `ThreadsList` | `_length` | `const uint` | 线程数量 |
|  | `_threads` | `JavaThread *const *const` | 指向 JavaThread*[] 数组 |
|  | `_next_list` | `ThreadsList*` | _to_delete_list 链指针 |
|  | `_nested_handle_cnt` | `volatile intx` | 嵌套引用计数 |
| `Thread` | `_threads_hazard_ptr` | `ThreadsList* volatile` | Hazard Pointer 本体 |
|  | `_threads_list_ptr` | `SafeThreadsListPtr*` | 嵌套链栈顶 |
| `SafeThreadsListPtr` | `_list` | `ThreadsList*` | 保护哪个快照 |
|  | `_previous` | `SafeThreadsListPtr*` | 嵌套时上一项 |
|  | `_has_ref_count` | `bool` | false=hazard ptr，true=引用计数 |
|  | `_needs_release` | `bool` | 析构时是否需要 release |

---

## 10. 完整案例——从空状态到回收的一整圈

从 JVM 启动开始，经历 T1/T2 创建、GC 扫描、T2 退出、回收全流程。以下每阶段展示所有关键字段的值——`Threads` = `Threads` 类，`SMR` = `ThreadsSMRSupport`。

### 阶段零：JVM 启动——空状态

```
SMR._java_thread_list           → v0 { _threads=[NULL] }
Threads._thread_list             = NULL
SMR._to_delete_list              = NULL
所有 _threads_hazard_ptr         = NULL
```

### 阶段一：T1 创建

`Threads::add(T1)` → 头插入 `_thread_list` → CoW 建 v1 → xchg 替换 → free_list 回收 v0 → v0 无人引用被 delete。

```
Threads._thread_list             → T1→NULL
SMR._java_thread_list            → v1 { [T1,NULL] }
SMR._to_delete_list              = NULL
```

### 阶段二：T2 创建

同 T1，但 v1 非空走 memcpy 分支。

```
Threads._thread_list             → T2→T1→NULL
SMR._java_thread_list            → v2 { [T1,T2,NULL] }
所有 _threads_hazard_ptr         = NULL
```

### 阶段三：GC 扫描——ThreadsListHandle 构造

VMThread 声明 `ThreadsListHandle tlh;` → 走 fast path 四步：

```
VMThread._threads_hazard_ptr     = v2 (已验证)
SafeThreadsListPtr._list         = v2
SafeThreadsListPtr._has_ref_count = false
```

### 阶段四：T2 退出

T2 调用 `Threads::remove(this)`：链表摘除 → CoW 建 v3（不含 T2）→ xchg → free_list(v2)。free_list 扫描发现 VMThread 的 hazard ptr 指向 v2 → v2 不删，留在 `_to_delete_list`。

```
Threads._thread_list             → T1→NULL
SMR._java_thread_list            → v3 { [T1,NULL] }
SMR._to_delete_list              → v2→NULL
VMThread._threads_hazard_ptr     = v2 (仍在保护)
v2._nested_handle_cnt            = 0
```

### 阶段五：smr_delete 扫描 → wait

T2 调 `smr_delete(this)`：持双锁 → `is_a_protected_JavaThread(T2)` 扫描发现 VMThread 指向 v2 → v2 包含 T2 → T2 受保护 → 释放 Threads_lock，在 delete_lock 上 wait。

```
SMR._delete_notify               = 非零（T2 在等）
T2: 在 delete_lock 上 wait
VMThread._threads_hazard_ptr     = v2
```

### 阶段六：GC 完成 → notify

VMThread 的 tlh 析构 → `release_stable_list()` → `_has_ref_count = false` → 清空 `_threads_hazard_ptr`。双重检查 `_delete_notify` 非零 → 争 delete_lock → notify_all → 唤醒 T2。

```
VMThread._threads_hazard_ptr     = NULL
T2: 被唤醒，重新持锁重扫
```

### 阶段七：T2 被唤醒 → delete T2

T2 wait 返回 → 重扫：`VMThread._threads_hazard_ptr = NULL` → T2 不受保护 → break → `delete T2`。JavaThread 对象被释放。

```
T2: 已 delete
SMR._to_delete_list              → v2→NULL (v2 还在，但 T2 指针在 v2 中已成野指针)
```

### 阶段八：free_list 回收 v2

下一次 add/remove 触发 `free_list()`：扫描发现无人引用 v2（所有 hazard ptr = NULL）→ `_nested_handle_cnt = 0` → delete v2。ThreadsList 容器被释放。

```
SMR._to_delete_list              = NULL
SMR._java_thread_list            → v3 { [T1,NULL] }
```

全圈走完——从空状态出发，经过 T1/T2 创建、GC 扫描（tag/untag）、T2 退出、smr_delete 等待、GC 释放唤醒、T2 delete、v2 回收，最终回到只有 T1 在运行的稳定状态。

---

## 11. 五个初始化字段——每个都做了什么

回到 `Thread::Thread()` 构造函数（`thread.cpp:241-245`），全文的起点。前面讲透了其中两个——剩下三个也需要交代：

```cpp
_oops_do_parity = 0;               // (1)
_threads_hazard_ptr = NULL;        // (2)
_threads_list_ptr = NULL;          // (3)
_nested_threads_hazard_ptr_cnt = 0; // (4)
_rcu_counter = 0;                  // (5)
```

**(1) `_oops_do_parity`**：GC 并行标记的去重锁——保证每个线程在一次 GC 中只被一个工作线程扫描一次。全局 parity 在 1 和 2 之间翻转，线程自己的 parity 通过 CAS 与全局值比对。**完整机制见[前置概念：_oops_do_parity](oops-do-parity.md)**。

**(2) `_threads_hazard_ptr`**：Hazard Pointer 本体。第 4-5 节已完整拆解——读者贴标签、写者扫描、tag/untag 两阶段发布。

**(3) `_threads_list_ptr`**：嵌套遍历的 `SafeThreadsListPtr*` 链栈顶。第 4 节（构造时推入）和第 7 节（嵌套时多层链表）已完整拆解。

**(4) `_nested_threads_hazard_ptr_cnt`**：纯粹的统计计数器——记录当前线程经历过多少层嵌套。仅在 `-XX:+EnableThreadSMRStatistics` 时递增/递减，不影响任何逻辑判断（真正阻止旧快照被删的是 `_nested_handle_cnt`，不是这个字段）。统计用途：记录 `_nested_thread_list_max`（JVM 运行期间的最大嵌套深度）。

**(5) `_rcu_counter`**：每个线程上的计数器，属于**另一套**安全回收机制——GlobalCounter（RCU 风格）。和本文的 Hazard Pointer 完全独立：HP 等特定快照的读者（粒细），GlobalCounter 等全体老代读者（粒粗）。**完整机制见[前置概念：GlobalCounter](global-counter.md)**。
