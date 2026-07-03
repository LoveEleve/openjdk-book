# 前置概念：Thread-SMR —— 线程列表的安全并发访问

`Thread::Thread()` 构造函数末尾（`thread.cpp:239-243`）初始化了 5 个字段，全部为 NULL/0。这篇文章解释它们服务的 SMR（Safe Memory Reclamation）机制——但不是从"是什么"开始，而是从"为什么"开始。

---

## 1. 起点：一个全局链表，两种并发操作

HotSpot 用一条全局链表管理所有 `JavaThread` 对象。两种操作：

- **写者（增删线程）**：`Threads::add()` 插入节点，`Threads::remove()` 摘除节点。
- **读者（遍历线程）**：GC 需要遍历所有线程的 oop 作为 GC 根，jstack 需要 dump 线程栈，JVMTI 需要枚举线程。

**这是经典的并发读写问题。如果什么都不做，读者遍历到一半时写者删掉一个节点——读者手上的 next 指针指向已释放的内存，直接 crash。**

---

## 2. 方案一：全局锁 `Threads_lock`

最直觉的解法——读者拿锁遍历，写者拿锁修改。JDK 8 就这么做。

**问题**：GC 触发时 VMThread 持锁遍历 `_thread_list`。遍历期间任何线程无法创建也无法退出——因为 `Threads::add()` 和 `Threads::remove()` 都需要同一个锁。线程创建/退出是高频操作——应用启动时每几十微秒就有一个新线程。GC 遍历一次可能花几百微秒，这几百微秒内整套系统的线程生命周期完全冻结。

**换个思路**：能不能让读者不拿锁，只让写者互斥？

---

## 3. 方案二：Copy-on-Write 快照

每增加一个线程不是往链表里插节点，而是**把整条链表复制一份，尾部追加一条，然后让全局指针指向新副本**。

```
旧版本 v3: [T1, T2, T3]
新线程 T4 加入:
  ── 复制 v3 → v4: [T1, T2, T3, T4]
  ── Atomic::xchg 把全局指针从 v3 换成 v4
  ── v3 不动——正在遍历 v3 的读者不受影响
```

读者在遍历前拿一次全局指针的快照，之后全程用这个快照遍历——不再读写全局指针，**完全不需要锁**。

**好处**：读者和写者彻底解耦。写者建新副本时读者继续用旧副本，谁都不等谁。

**问题**：旧副本什么时候删？读者 T1 拿到 v3 开始遍历。写者把全局指针换成了 v4。此时不能删 v3——T1 还在用。必须等 T1 遍历完。

**如果写者能知道"还有谁在用 v3"就好了。**

---

## 4. 方案三：Hazard Pointer——读者贴一张"别删"标签

给每个 `Thread` 加一个字段 `_threads_hazard_ptr`。读者在遍历前把正在用的快照地址写入这个字段——相当于贴一张标签说"我在用这个版本"。遍历完清零。

写者要删除某个 JavaThread 之前，扫描所有线程的 `_threads_hazard_ptr`：

- 如果没人指着包含此线程的快照 → 安全删除。
- 如果有人指着 → **等着**——每 10ms 重新扫描一次，直到对方读完。

**到此为止，核心方案成型**：Copy-on-Write 让读者无锁遍历，Hazard Pointer 让写者知道何时安全删除。

---

## 5. 一个 Hazard Pointer 的并发 bug

上面听起来很完美——但有一个微妙的并发窗口：

```
读者 T1                          写者 T2
─────────────────────────    ─────────────────────
get_java_thread_list() → v3   Thread 退出
                              新快照 v4 = remove(Tx)  
                              Atomic::xchg → v4
写入 _threads_hazard_ptr=v3   扫描 _threads_hazard_ptr
（这一纳秒还没写完）           还没扫到 T1 → 没有 v3
                              扫完了 → 没人用 v3
                              → delete Tx
完成写入 _threads_hazard_ptr=v3
开始遍历 v3 → 指针悬空！
```

T1 的 hazard ptr **还没写上去**，T2 已经扫了一遍。T2 扫完后认为安全，释放了目标线程。T1 这时才把自己的 hazard ptr 挂上去——已经晚了，手上的 v3 里包含已释放的指针。

**需要的是一种协议——T1 写完 hazard ptr 后能意识到"刚才 T2 可能已经扫过我"并重新验证。**

---

## 6. 两阶段发布协议（tag/untag）

这就是 `acquire_stable_list()` 快路径的工作原理（`threadSMR.cpp:384-432`）：

```
① threads = get_java_thread_list()          // 先读全局指针
② _threads_hazard_ptr = threads | 0x1       // 打 tag（unverified）
   release_store_fence()                     // 确保写可见
③ threads = get_java_thread_list()          // 再读一遍全局指针
④ cmpxchg → 去 tag（标记为 verified）       // 如果线程列表被替换了，cmpxchg 失败→重试
```

**tag 的作用**：当写者扫描时如果发现 tagged hazard ptr（最低 bit = 1），知道"这个读者还没验证完"——写者会**抢**这个 tag（把它设为 NULL）并 notify。读者在步骤④发现自己的 tag 变成了 NULL——知道自己被抢了，安全退出，外层重试。

tag 把普通的一行赋值拆成两阶段协议，换来的是写者不会在 wait 循环中浪费 CPU——如果读者还没贴完标签，写者主动帮它清零并通知，而不是一直等着。

---

## 7. 嵌套遍历——同一个线程需要再遍历一次

如果 GC 在遍历 `_thread_list` 时触发了 JFR 的线程枚举——JFR 也需要遍历线程列表。同一个线程已经贴了一张 hazard ptr，不能再贴第二张（会覆盖第一张）。

**解法**：外层脱离 hazard ptr，改用引用计数。内层正常用 hazard ptr。

```
步骤 1：外层构造（GC 开始）
  _threads_hazard_ptr = tagged ptr (v3)
  _threads_list_ptr = &外层 SafeThreadsListPtr

步骤 2：内层构造（JFR 嵌套）
  检测到 hazard ptr 已被占用 → 嵌套路径
  外层被 promote：清空它的 hazard ptr，改为 _has_ref_count=true
    v3->_nested_handle_cnt++  （对 ThreadsList 做引用计数）
  内层构造：
    _threads_hazard_ptr = tagged ptr (v3)
    _threads_list_ptr = &内层 SafeThreadsListPtr
    内层._previous = &外层

步骤 3：内层析构
  清除 hazard ptr
  _threads_list_ptr = 内层._previous (= 外层)

步骤 4：外层析构
  v3->_nested_handle_cnt--  （引用计数归零）
  if (delete_notify) → 唤醒 smr_delete 检查
  _threads_list_ptr = NULL
```

嵌套路径的关键在 `nested_handle_cnt`——ThreadsList 上的 `volatile intx`。它是引用计数：`inc`/`dec` 均用屏障保证可见性。当 `_nested_handle_cnt == 0` 且所有 hazard ptr 都不再指着此 ThreadsList，它可被 `smr_delete` 安全释放。

---

## 8. 安全删除：`smr_delete()` 的 wait 循环

```cpp
// threadSMR.cpp:944-1009（简化）
void ThreadsSMRSupport::smr_delete(JavaThread* thread) {
  while (true) {
    if (!is_a_protected_JavaThread(thread)) {  // 扫描所有 hazard ptr
      delete thread; return;
    }
    MonitorLockerEx ml(delete_lock(), ...);
    if (!is_a_protected_JavaThread(thread)) {  // 锁内再查一次
      delete thread; return;
    }
    _delete_notify = true;
    ml.wait(10);  // 最多等 10ms，避免死等
  }
}
```

三重防护：① 无锁扫描 → ② 持锁双重检查 → ③ 等 10ms 后重试。`is_a_protected_JavaThread()` 扫描所有线程的 `_threads_hazard_ptr`——检查是否有线程的 hazard ptr 指向包含目标线程的 ThreadsList。只有当"hazard ptr 指着快照"且"快照包含目标线程"两条同时成立时才算受保护。

---

## 9. 全文总结：一个方案的进化

| 步骤 | 方案 | 解决的问题 | 留下的问题 |
|------|------|-----------|-----------|
| 1 | 全局锁 | 最基本的并发安全 | 读者阻塞写者，GC 等所有线程创建/退出 |
| 2 | Copy-on-Write | 读者无锁遍历 | 旧快照不知道何时删除 |
| 3 | Hazard Pointer | 写者能知道何时安全删除 | 读者贴标签有并发窗口 |
| 4 | tag/untag 两阶段协议 | 消除窗口——读者验证自己不被抢先 | 同一线程不能嵌套遍历 |
| 5 | 嵌套路径 + Promo | 同一线程可嵌套遍历，外层改用引用计数 | 写者需同时检查 hazard ptr 和引用计数 |

最终产物就是 `Thread::Thread()` 构造函数中的五个字段——它们是这套协议的线程级基础设施。构造函数里全是 NULL/0 因为此刻线程还没加入全局链表，还没有并发读者需要通过这套协议来保护它。运行时一旦 `Threads::add()` 把线程加入链表（并同步更新 SMR 快照），这套协议即刻生效。

---

## 10. 回到 `Thread::Thread()` 的五个字段

```cpp
_oops_do_parity = 0;                        // int，GC 并行根扫描认领标记
_threads_hazard_ptr = NULL;                 // ThreadsList* volatile，hazard pointer 本体
_threads_list_ptr = NULL;                   // SafeThreadsListPtr*，嵌套遍历引用栈顶
_nested_threads_hazard_ptr_cnt = 0;         // uint，统计用嵌套深度计数器（非协议决策字段）
_rcu_counter = 0;                           // volatile uintx，GlobalCounter 代际计数（与 SMR 平行运作的另一套机制）
```

`_rcu_counter` 属于 GlobalCounter（epoch-based 回收），与 SMR 的 hazard pointer 平行：hazard pointer 保护具体快照不被释放，GlobalCounter 保护全局指针变更在所有线程感知后才生效。两者在 `Threads::oops_do()` 中协同工作。GlobalCounter 的详细机制将在后续章节单独展开。

> 此刻线程还没加入 `Threads::_thread_list`——这五个字段全部为 NULL/0。SMR 的完整运行时行为将在线程生命周期章节深入展开。
