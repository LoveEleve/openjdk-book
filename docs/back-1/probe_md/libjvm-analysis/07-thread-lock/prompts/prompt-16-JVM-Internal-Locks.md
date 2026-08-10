# PROMPT: 请撰写 16-JVM-Internal-Locks.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**"80+ 把锁为什么不死锁" — JVM 内部 Monitor/Mutex 二层模型 + Lock Ranking 全序死锁预防 + safepoint_check 三态协议**

### 核心故事线（禁止做源码翻译机！）

前十五篇文章 [01-04] 锁膨胀全链路 → [05-06] 线程生命周期/架构 → [07] VMThread → [08] WorkerThread → [09] 10 个 JavaThread → [10] 4 条 NonJavaThread → [11] AttachListener → [12] ServiceThread → [13] ReferenceHandler+Finalizer → [14] CompilerThread+Sweeper → [15] JfrThreadSampler+JfrRecorderThread。21+ 条线程全部讲完了。

现在还剩最后一个体系级问题：**这 21 条线程之间用 80+ 把内部锁（`mutexLocker.cpp` 中 `def()` 宏 105 处）协调，为什么不会死锁？**

你在前十一篇 [07]~[15] 中已经看到了很多锁：
- `Safepoint_lock`（整个 safepoint 协议的核心）— rank=`safepoint(19)`
- `Threads_lock`（ThreadsSMR 保护 JavaThread 创建/销毁）— rank=`barrier(20)`
- `CGC_lock`（G1ConcurrentMarkThread vs VMThread）— rank=`special(4)`, `_safepoint_check_never`
- `PeriodicTask_lock`（WatcherThread 的 10ms Tick）— rank=`nonleaf+5(26)`
- `JfrMsg_lock` / `JfrStream_lock` / `JfrThreadSampler_lock` [15] — rank=`leaf`/`leaf+1`
- `Service_lock` [12] — rank=`special(4)`, `_safepoint_check_never`
- `Terminator_lock`（线程退出同步）— rank=`nonleaf(21)`
- `STS_lock`（SuspendibleThreadSet—精炼线程的 yield）— rank=`leaf(9)`

**本文的核心叙事线**是一条从"观察现象"到"理解设计"的追溯链：

1. **★ Monitor vs Mutex 为什么有两层？而且历史反转过？**— [01-04] 讲的是 `synchronized` 的 ObjectMonitor（Java 层），这里讲 JVM C++ 内部用的 Monitor。它们不是同一个东西！Mutex 只能 lock/unlock，Monitor 额外有 wait/notify。但历史曾经反过来——Monitor 继承 Mutex（J2SE7 前），J2SE7 后反转为 Mutex 继承 Monitor。**为什么反转？** 注释说"过去区分 Mutex 和 Monitor 可能有意义，但那个时代已经过去了"——实际是把 wait/notify 放在基类以减少代码重复。更深层原因：pthread 的 pthread_mutex_t 和 pthread_cond_t 本来就是两个独立对象，不必强行区分。

2. **★ Lock Ranking 是什么？为什么用整数排名而不是依赖图？**— 80+ 把锁，每把有一个 rank 值（`event=0` → `native=922`）。规则：线程获取锁必须按 rank **严格降序**。这是一个 **O(1) 校验**——`if (new_rank >= min_held_rank) FATAL`，比遍历全局依赖图快 100 倍。但代价是：同 rank 的两把锁（如两个 leaf=9）之间没有先后顺序保证 → 不能同时持有。**追问：为什么 `leaf` 等级有最多锁（几十把）？** 因为 leaf 级的锁互相独立——各自保护不同的数据结构——永远不会出现"同时持有两把 leaf 锁"的场景。

3. **★ `set_owner_implementation()` 中的致命断言**— `mutex.cpp:1301-1326`，全文最重要的一段代码。每把锁获取后：
   ```
   ① 遍历线程的 _owned_locks 链表 → 找已持有的最小 rank 锁
   ② if (new_lock->rank() >= min_held_lock->rank()) {
        if (!豁免条件) FATAL("possible deadlock");
      }
   ```
   **追问：为什么 `>=` 不是 `>`？** 因为如果允许 rank 相等 → 线程可能先获取锁A(leaf, rank=9)，再获取锁B(leaf, rank=9) → 另一个线程获取顺序相反 → **死锁**。严格降序消除了这种交叉。

4. **★ safepoint 中的例外：为什么 safepoint 期间 rank 检查被跳过？**— `mutex.cpp:1319` 行：`!SafepointSynchronize::is_at_safepoint()` 时跳过整个 rank 检查。因为 safepoint 期间所有 JavaThread 已暂停 → 不存在并发持有锁冲突 → 死锁不可能发生。这是 Lock Ranking 的"安全期"——VMThread 在 safepoint 中可以自由获取任意锁。

5. **★ safepoint_check 三态是什么？为什么需要？**— `_safepoint_check_never`(0)、`_safepoint_check_sometimes`(1)、`_safepoint_check_always`(2)。这不是锁的属性——是**线程身份**的函数：
   - `PeriodicTask_lock` 本身是 `_safepoint_check_sometimes` → JavaThread 获取时做 safepoint 检查
   - 但 WatcherThread 获取时传 `_no_safepoint_check_flag` → 绕过检查
   - **为什么？** 因为 WatcherThread 是 NonJavaThread → 不参与 safepoint → 如果做检查 → VMThread 等它到达 safepoint → 但它永远不会 → 死锁
   - **追问：JavaThread 获取 `PeriodicTask_lock` 的场景存在吗？** 存在！`ServiceThread::enqueue_deferred_event()` [12] 在持 Service_lock 期间可能间接触发 PeriodicTask→需要获取 PeriodicTask_lock。此时 ServiceThread 是 JavaThread → 必须通过 safepoint 检查。

6. **★ Thread::_owned_locks — 锁链表为什么用 Monitor 自身的 `_next` 字段？**— 不是独立的 LinkedList 类。每把 Monitor 自带 `_next` 字段（`mutex.hpp:142`），获取锁时头插法：`this->_next = owner->_owned_locks; owner->_owned_locks = this`。**零额外内存**——每个锁对象同时是锁 + 链表节点。这是典型的侵入式链表（intrusive linked list）。

7. **★ RAII 为什么有三层封装？**— `MutexLocker`(基础 lock/unlock) → `MutexLockerEx`(支持 NULL + `_no_safepoint_check`) → `MonitorLockerEx`(在 Ex 上加 wait/notify)。**为什么不是一层？** 因为不同线程类型有不同的约束——NonJavaThread 需要 `lock_without_safepoint_check()`，JavaThread 需要 `lock()`。一层封装无法同时满足"可选 safepoint check"和"可选 NULL 锁"的需求。

8. **★ native rank(922) — JVM 边界的分界线**— `JVM_RawMonitorCreate` 创建的锁 rank 永远是 922，**豁免所有死锁检测**。因为 JNI 代码的锁获取顺序不由 JVM 控制——JVM 无法假设 `JNI_MonitorEnter(A); JNI_MonitorEnter(B)` 的顺序在所有 JNI 库中一致。这是"内部锁体系"和"外部体系"的隔离墙。

### 禁止行为

- ❌ 把 80+ 把锁列成表格——这是字典，不是分析
- ❌ 罗列 rank enum 全部 12 个值不解释为什么这样排序、为什么中间有断层
- ❌ 逐行翻译 `mutex_init()` 中的 `def()` 调用——选 8 个关键锁深入，其余概要
- ❌ 忽略 Monitor/Mutex 的历史反转原因——必须引用 mutex.hpp:274-277 注释原文
- ❌ 忽略 safepoint 期间 rank 检查被跳过的设计含义——这是"为什么 VMThread 可以安全持有任意锁"的关键
- ❌ 不画"线程→持锁→rank"关系图——用 VMThread/WatcherThread/G1 线程具体演示
- ❌ 把 `PeriodicTask_lock` 和 `_no_safepoint_check_flag` 混淆——锁本身的属性 vs 调用者传参的区别
- ❌ 不解释"为什么用整数 rank 而不是依赖图"——优势(O(1) vs O(E)) + 局限性(同 rank 锁不能同时持有)
- ❌ 只讲设计不讲反例——每个设计决策必须追问"如果不这样做会怎样"
- ❌ ★★ 不解释"为什么是 rank 降序（从高到低）不是升序"——这是 Lock Ranking 最反直觉的点，必须从头插法的角度解释
- ❌ 忽略 release build 安全网——rank 检查只在 ASSERT 下，生产环境怎么防死锁？必须回答
- ❌ 反例用不存在场景（如 PeriodicTask_lock + Terminator_lock 同线程持有）→ 必须用真实跨线程场景
- ❌ 不验证源码行号——所有 `mutex.cpp`/`mutex.hpp`/`mutexLocker.cpp` 的函数签名和行号必须在写文档前用 grep 确认

### 要求行为

- ✅ **★ 核心致命断言深度走读**：`set_owner_implementation()` 的 `mutex.cpp:1280-1330` 是全文最重要的代码——**不能贴整段代码然后翻译**。要拆成三个子问题：(1) 为什么检查 rank？(2) 为什么用 `>=` 而非 `>`？(3) 为什么 native/suspend_resume/safepoint 被豁免？每个子问题先给答案、再贴 3-5 行关键源码做引证
- ✅ **★ 降序 vs 升序必须画图解释**：头插法导致 _owned_locks 链表头 = 最新获取 = rank 最小 → rank 降序获取才能维持链表升序 → 画一条线程持 3 把锁的链表图示
- ✅ **★ release build 安全网必须回答**：rank 检查只在 #ifdef ASSERT → 生产环境靠什么？(1) debug test 覆盖所有执行路径 → release 自然安全；(2) 同 rank 锁保护不相交系统 → 执行路径永不交叉
- ✅ **★ 历史反转必须解释清楚**：引用 `mutex.hpp:274-277` 注释原文，解释"为什么回不去了"
- ✅ **★ 与 [01] ObjectMonitor 的对比**：两个 Monitor 系统，同底层（pthread_cond），不同上层
- ✅ **★ 从 [07]~[15] 追溯锁**：每把锁必须有具体的线程/场景作为"为什么要用它"的理由，不能凭空讲。锁不离线程，锁不离场景
- ✅ **★ Thread::_owned_locks 的侵入式链表设计**：Monitor::_next 自引用——零额外内存。头插法意味着 rank 必须严格降序。用 GDB 验证链表内容
- ✅ **★ safepoint 期间豁免的深层原因**：不是"偷懒跳过检查"——是"不存在并发冲突"的数学保证。附 VMThread 在 Young GC 中的具体锁序列
- ✅ **反例必须真实**：用 WatcherThread vs ServiceThread 的真实跨线程场景构造死锁时序图——不用不存在的场景
- ✅ **GDB 验证**：≥12 条，重点验证 `_owned_locks` 链表打印 + `rank()` + `safepoint_check`，在 WatcherThread 持有 PeriodicTask_lock 的时刻做，在 VMThread safepoint 中断点验证豁免

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 默认 mixed mode（Tiered Compilation 开启）
- 64 位 Linux x86
- ★ Lock Ranking 只在 `#ifdef ASSERT` 下启用 — slowdebug 生效，release build 全部跳过
- ★ 当前 [07]~[15] 中出现的所有线程均存在

## 三、聚焦源文件

> ★★★ **读码顺序铁律**（违反必翻车）:
> 1. 先读 `mutex.hpp` — 理解 `Monitor`(:82) 基类 + `Mutex`(:297) 派生 + `lock_types` enum(:106) + `_safepoint_check_required`(:167) — **这是全文根基**
> 2. 再读 `mutex.cpp:1280-1330` — 理解 `set_owner_implementation()` 的 rank 强制逻辑 — **全文灵魂**
> 3. 再读 `mutex.cpp:1224-1241` — 理解 `get_least_ranked_lock()` 如何 O(n) 遍历链表找最小 rank
> 4. 再读 `mutex.cpp:1369-1390` — 理解 `check_prelock_state()` 的 safepoint 状态检查
> 5. 再读 `mutexLocker.hpp` — 理解 RAII 三层封装 (`MutexLocker`→`MutexLockerEx`→`MonitorLockerEx`)
> 6. 再读 `mutexLocker.cpp` — 理解 `mutex_init()` 中 `def()` 宏创建 105 把锁
> 7. 最后从 [07]~[15] 中提取具体线程的锁使用场景 — 这是追溯分析的起点

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `mutex.hpp` | `src/hotspot/share/runtime/mutex.hpp` | `Monitor`(:82), `Mutex`(:297), `lock_types` enum(:106-119), `_safepoint_check_required`(:167-177), `SplitWord`(:64) | ★ 基类定义 + rank 枚举 + safepoint 三态 + PaddedMonitor/PaddedMutex |
| 2 | `mutex.cpp` | `src/hotspot/share/runtime/mutex.cpp` | `set_owner_implementation()`(:1280), `get_least_ranked_lock()`(:1224), `check_prelock_state()`(:1369), `lock()`(:878), `ILock()`(:429) | ★★★ rank 排序强制 + fatal 断言 + _owned_locks 链表 + safepoint 检查 |
| 3 | `mutexLocker.hpp` | `src/hotspot/share/runtime/mutexLocker.hpp` | `MutexLocker`(:182), `MutexLockerEx`(:223), `MonitorLockerEx`(:250) | ★ RAII 三层封装 + extern 声明 + safepoint_check 参数 |
| 4 | `mutexLocker.cpp` | `src/hotspot/share/runtime/mutexLocker.cpp` | `mutex_init()`(:194), `def()` 宏(:187) | ★ 105 把锁的创建 + rank 注入 + safepoint_check 赋值 |
| 5 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | Thread::_owned_locks 字段, `check_for_valid_safepoint_state()` | 线程持有的锁链表 |
| 6 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | `JVM_RawMonitorCreate` | native rank(922) 的来源 |
| 7 | `safepoint.hpp` | `src/hotspot/share/runtime/safepoint.hpp` | `SafepointSynchronize::is_at_safepoint()` | ★ safepoint 期间 rank 检查豁免的判定条件 |

## 四、必须深度走读的核心概念

> ★★★ 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。禁止贴整段函数。

### 4.1 Monitor vs Mutex 二层模型 — 历史为什么反转？

```
★★★ 请从 mutex.hpp 中回答（不允许编造）:

  ① Monitor 基类 (:82) 有哪些字段？Mutex 派生类 (:297) 有哪些字段？
     → 用 ptype /o Monitor 和 ptype /o Mutex 在 GDB 验证

  ② 历史反转 (mutex.hpp:274-277 注释原文):
     "At one point in time there may have been some benefit to having
      distinct mutexes and monitors, but that time has past."
     → 翻译这段注释，追问: 为什么说"the time has past"?
       线索: pthread_mutex_t 和 pthread_cond_t 本就是独立对象

  ③ ★ 和 [01] ObjectMonitor 的对比:
     → 两个 Monitor 系统 (mutex.hpp vs objectMonitor.hpp)
     → 底层都走 pthread_cond_timedwait → futex
     → 上层 _EntryList/_WaitSet 结构有什么不同？协议有什么不同？
```

### 4.2 ★★★ Lock Ranking — O(1) 全序死锁预防

```
★★★ 请从 mutex.hpp:106-119 和 mutex.cpp:1224-1330 中回答:

  ① lock_types 枚举: 12 级主 rank 的值和 gap 为什么这样设计?
     → event=0, leaf=9, safepoint=19, native=922 — 中间断层为什么这么大?
     → nonleaf(21) ~ max_nonleaf(921) 的 900 个 slot 怎么分配?
       从 mutexLocker.cpp 中找出具体例子 (如 PeriodicTask_lock = nonleaf+5)

  ② ★★ 核心误解: 为什么是 rank 降序（从高到低）不是升序（从低到高）?
     线索: _owned_locks 链表是头插法 — 头 = 最新获取
     → 如果升序获取: 头 rank = 最大, 尾 rank = 最小 → 违反链表升序 assert
     → 如果降序获取: 头 rank = 最小, 尾 rank = 最大 → 链表升序 ✓
     → 追问: 为什么链表按 rank 升序？— mutex.cpp:1235 assert 验证

  ③ set_owner_implementation() (mutex.cpp:1280-1330) — 拆成三个子问题:
     (a) 为什么检查 rank？已持有锁的 rank 和新锁的 rank 关系是什么？
     (b) 为什么用 >= 而非 > ？（线索: 同 rank 的两把锁能同时持有吗？）
     (c) ★ 三处豁免: native(922) + suspend_resume(5) + safepoint 期间
        — 每处豁免的理由是什么？从源码注释中找到原文

  ④ ★ 关键发现: rank 检查只在 #ifdef ASSERT 下生效 (mutex.cpp:1280)
     → release build 中 rank 检查完全不存在 — 那怎么防死锁？
     → 答案方向: debug build 通过所有 assert → release build 自然安全
     → 追问: 需要从源码验证 _next 字段的范围 (#ifndef PRODUCT?)
     → 追问: 如果有人写了只在 release 路径才触发的锁逆序怎么办？

  ⑤ 为什么用整数 rank 不用锁依赖图？
     → 优势: O(1) 比较 vs O(E) 遍历
     → 代价: 同 rank 锁不能同时持有 → 同 rank 锁必须保护"不相交的系统"
```

### 4.3 ★ safepoint_check 三态 — 锁与 GC 的交互协议

```
★★★ 请从 mutex.hpp:167-177 和 mutex.cpp:1369-1390 中回答:

  ① 三个枚举值的语义是什么？
     _safepoint_check_never(0) / sometimes(1) / always(2)
     → 每种对应什么类型的持有者？从 [10] NonJavaThread 和 [09] JavaThread 找例子

  ② ★★ 关键区分: _no_safepoint_check_flag ≠ 锁的属性!
     → PeriodicTask_lock 本身的 safepoint_check = _safepoint_check_sometimes (1)
     → WatcherThread 获取时传 MutexLockerEx(lock, _no_safepoint_check_flag)
     → 锁的属性 vs 调用者传参 — 从 mutexLocker.cpp 找到具体定义验证

  ③ check_prelock_state() (mutex.cpp:1369-1390):
     → 如果 JavaThread 在 _thread_in_vm 状态获取 _safepoint_check_always 锁 → 合法
     → 如果 JavaThread 在 _thread_in_Java 状态获取同样锁 → assert fail
     → 为什么？— safepoint 协议要求

  ④ ★ 从 [10] WatcherThread::sleep() 追踪:
     → WatcherThread 获取 PeriodicTask_lock 时传 _no_safepoint_check_flag
     → 如果不传 → lock() 内部调 check_prelock_state → 会怎样？
     → 答案: WatcherThread 是 NonJavaThread → 不参与 safepoint → 死锁
```

### 4.4 ★ Thread::_owned_locks — 侵入式链表

```
★★★ 请从 mutex.cpp:1224-1241 和 mutex.hpp:142 中回答:

  ① 头插法 (mutex.cpp L1328-1329):
     this->_next = new_owner->_owned_locks;
     new_owner->_owned_locks = this;
     → 头是"最新获取", 尾是"最早获取" → 为什么 rank 必须降序?
       验证: mutex.cpp:1235 assert(tmp->rank() <= tmp->next()->rank())

  ② get_least_ranked_lock() (mutex.cpp:1224-1241):
     → O(n) 遍历 _owned_locks → 返回 rank 最小的 Monitor
     → 为什么不用哈希表？n 通常 < 5（很少有线程同时持 5+ 把锁）

  ③ 侵入式链表 vs std::list: 为什么不用 STL 容器？
     → _next 字段在 Monitor 自身 (mutex.hpp:142, #ifndef PRODUCT)
     → 零额外内存: 每个 Monitor 同时是锁 + 链表节点
```

### 4.5 ★ RAII 三层封装 — 为什么不是一层？

```
★★★ 请从 mutexLocker.hpp:182-250 中回答:

  ① MutexLocker → MutexLockerEx → MonitorLockerEx 的递进关系:
     → 每一层比上一层多了什么？少了什么？

  ② ★ 具体调用场景 (从 [07][12][15] 找):
     → MutexLocker(Threads_lock)                        — [05] Threads::add()
     → MutexLockerEx(PeriodicTask_lock, _no_safepoint_check_flag)  — [10] WatcherThread
     → MonitorLockerEx(JfrMsg_lock, _no_safepoint_check_flag)      — [15] JfrRecorderThread

  ③ 如果只有一层会怎样?
     → 条件锁: MutexLockerEx(flag?NULL:lock) — 一层 MutexLocker 不支持 NULL
     → safepoint check: 一层没法让调用者选择 lock() vs lock_without_safepoint_check()
```

### 4.6 ★★ 反例构造 — 用真实场景演示死锁危险性

```
★★★ 请从 [10] WatcherThread 和 [12] ServiceThread 的源码中构造反例:

  线索: ServiceThread 处理 JVMTI 事件时持 Service_lock (rank=special,4)
        WatcherThread 执行 PeriodicTask 时持 PeriodicTask_lock (rank=nonleaf+5,26)

  追问: ServiceThread 持 Service_lock 期间是否可能间接触发 PeriodicTask?
        → 查看 ServiceThread::service_thread_entry() 中是否有周期性任务注册
        → 如果存在路径: 持 Service_lock(4) → 获取 PeriodicTask_lock(26) → rank 升序!
        → 但 rank 检查只在 ASSERT 下 — 生产环境不会报错 → 如果真的存在会死锁吗?

  构造反例时序图 (如果 rank 不存在):
  Thread-A(ServiceThread):  获取 Service_lock(4) → 等待 PeriodicTask_lock(26)
  Thread-B(WatcherThread):  获取 PeriodicTask_lock(26) → 等待 Service_lock(4)
  → 死锁!

  ★ 追问: 为什么这个场景在现实中不会死锁？
     线索: Service_lock 的 safepoint_check=_safepoint_check_never
           且 ServiceThread 可能根本不会在持锁时触发 PeriodicTask 注册
           → 即使 rank 检查不存在，执行路径也永远不会交叉

  ★ 这个追问比反例本身更重要: Lock Ranking 是"最后防线"，
     真正的安全靠的是"同 rank 锁保护不相交系统"的设计前提
```

### 4.7 ★★ safepoint 期间 rank 豁免 — VMThread 的"安全期"

```
★★★ 请从 mutex.cpp:1319 和 [07] VMThread::loop() 中回答:

  ① mutex.cpp:1319 — !SafepointSynchronize::is_at_safepoint() 时跳过 rank 检查
     → 为什么 safepoint 中不需要 rank 检查？
     答案: 所有 JavaThread 已暂停 → 锁持有者固定 → 不可能有新竞争者

  ② ★ 具体追踪: VMThread 在一次 Young GC 中的锁获取序列
     → 从 [07][08][09] 中追踪, 输出类似:
     Safepoint_lock(19) → Threads_lock(20) → (release subset) →
     SystemDictionary_lock(leaf,9) → CodeCache_lock(special,4)
     → 如果不在 safepoint 中，这个序列能通过 rank 检查吗？→ 不能 (9 < 19 升序!)

  ③ ★ 对比 [15] JfrRecorderThread: safepoint 外提交 JfrVMOperation:
     → JfrRecorderThread 在 pre_safepoint_write 持 JfrStream_lock(10)
     → 提交 VM_Operation → VMThread 进入 safepoint
     → safepoint 中 VMThread 可以自由获取任意锁 — 不受 JfrRecorderThread 锁干扰
```


## 五、文章结构

```
§〇 源文件清单（跨 runtime/os）

§一 为什么需要 80+ 把内部锁？— 线程体系的锁依赖全景
  ★ 从 [07]~[15] 中提取所有锁的使用场景
  ❓ 为什么不直接一把全局大锁？→ 粒度太粗，性能灾难（[07] safepoint 已经全局串行，锁再串行=单线程 JVM）
  ❓ 那 80+ 把细粒度锁为什么不死锁？→ Lock Ranking
  1.1 线程→锁映射矩阵：从 [07]~[15] 展示每条线程持有的锁 + rank
  1.2 [07]~[15] 中 12 个关键锁全景

§二 Monitor vs Mutex 二层模型 — 历史反转
  ❓ 为什么 J2SE7 后 Mutex 继承 Monitor 而不是反过来？
  ❓ 什么时候用 Mutex（纯互斥）？什么时候用 Monitor（需要 wait/notify）？
  2.1 Monitor 基类定义 + 字段 (mutex.hpp:82-259)
  2.2 Mutex 派生类 — "退化的 Monitor" (mutex.hpp:297-309)
  2.3 ★ 与 [01] ObjectMonitor 的对比 — 两套 Monitor 系统，同一 pthread 底层

§三 ★★★ Lock Ranking — 死锁预防的核心协议
  ❓ 为什么用整数 rank 不用依赖图？
  ❓ ★★ 为什么是 rank 降序（从高到低）不是升序？— 头插法的必然
  3.1 lock_types 枚举全景 — 12 级主 rank + 900 微调 slot（从源码导出，不编造）
  3.2 ★ 致命断言: set_owner_implementation() (mutex.cpp:1280-1330) ← 全文灵魂
      拆成 3 个子问题分析，不贴整段代码
  3.3 ★ 三处豁免: native(922) + suspend_resume(5) + safepoint 期间
      → safepoint 豁免的深层原因: 所有 JavaThread 已暂停 → 无并发持有者冲突
      → VMThread 在一次 Young GC 中的具体锁获取序列（从 [07][08] 追踪）
  3.4 ★ 线程系统锁的 rank 依赖图（从 [07]~[15] 中提取 12 把关键锁）
  3.5 ★ 验证: JfrRecorderThread [15] 的锁顺序 — JfrStream(10)→JfrMsg(9)→降序合规
  3.6 ★ release build 安全网追问: rank 检查只在 ASSERT 下 → 生产环境怎么防？
  3.7 反例: 用真实跨线程场景构造"如果没有 rank 检查"的死锁时序图

§四 safepoint_check 三态 — 锁与 GC 的交互协议
  ❓ PeriodicTask_lock 为什么 WatcherThread 获取时必须 _no_safepoint_check_flag？
  4.1 _safepoint_check_never/sometimes/always 精确语义
  4.2 lock() vs lock_without_safepoint_check() 的调用路径
  4.3 ★ 从 [10][15] 追溯: NonJavaThread 的锁为什么统一绕过 safepoint 检查
  4.4 check_prelock_state() 内部逻辑 (mutex.cpp:1369-1390)

§五 RAII 三层封装 — MutexLocker→MutexLockerEx→MonitorLockerEx
  ❓ 为什么需要三层？一层不行吗？
  5.1 封装的逐级演进: 基础lock → 可选NULL+no_safepoint → +wait/notify
  5.2 ★ 从 [07][12][15] 中找三种封装的使用实例

§六 Thread::_owned_locks — 侵入式链表设计
  ❓ 为什么不直接用 std::list<Monitor*>？
  6.1 头插法的设计含义: 链表按获取时间排序 → rank 必须降序
  6.2 get_least_ranked_lock() 的 O(n) 遍历
  6.3 额外检查: 链表按 rank 升序 (assert tmp->rank() <= tmp->next()->rank())
  6.4 GDB 验证: 打印某线程的 _owned_locks 链表

§七 mutex_init() — 105 把锁的创建全景
  ❓ 为什么用 def() 宏而不是直接 new？
  7.1 def() 宏设计 (mutexLocker.cpp:187-191)
  7.2 ★ 选 8 个关键锁展示 rank + safepoint_check + allow_vm_block 三元组
  7.3 为什么一半锁标记 allow_vm_block=true？

§八 GDB 验证 + 可证伪断言（≥12 条）
  断言 1-5: 验证关键锁的 rank + safepoint_check
  断言 6-8: 验证 _owned_locks 链表 + 头插法 + get_least_ranked_lock
  断言 9-10: safepoint 期间豁免验证（在 VMThread 断点中测）
  断言 11-12: native rank + JVM_RawMonitorCreate 溯源

  可证伪断言 1: slowdebug build 下 rank 检查启用 → 故意违反 → fatal
  可证伪断言 2: 同 rank 的两把锁不能同时持有 → 尝试 → assert fail → 验证 _next 字段
  可证伪断言 3: safepoint 期间 rank 检查跳过 → 断点 set_owner_implementation 测 is_at_safepoint
  可证伪断言 4: WatcherThread 获取 PeriodicTask_lock 不用 _no_safepoint_check_flag → 会触发什么？
  可证伪断言 5: release build 下 _next 字段是否存在？（#ifndef PRODUCT 范围验证）
  可证伪断言 6: 所有 rank 枚举值 GDB 验证: p Mutex::native = 922, p Mutex::safepoint = 19
```
```

## 六、写作要求

**最重要的一条**：参考 [07-VMThread] 和 [12-ServiceThread] 的写作风格——它们都以"❓ 为什么..."开头，先建立设计动机，再用源码做证据。本文以同样的标准：**先用问题驱动，再用源码验证，不做源码翻译机**。

1. **★ set_owner_implementation() 是全文灵魂**：必须拆成 3 个子问题分析：(1) 为什么检查 rank？(2) 为什么 `>=` 非 `>`？(3) 为什么有豁免？每个子问题先给答案、再贴 3-5 行关键源码做引证——**不贴整段函数**

2. **历史反转必须讲清楚**：引用 mutex.hpp:274-277 注释原文，解释技术原因（减少代码重复）和现实原因（改不动了）

3. **从 [07]~[15] 追溯锁**：每把锁在引入时标注"这条锁保护的是 [XX] 中的哪个子系统"。锁不离线程，锁不离场景

4. **反例必须具体**：用两线程的具体锁获取顺序演示如果不做 rank 检查会怎样——时序图

5. **GDB 验证重点**：在 WatcherThread 持有 PeriodicTask_lock 的时刻打印 `_owned_locks`；在 VMThread safepoint 中验证 rank 豁免

6. **和 [01] ObjectMonitor 做对比**：两个 Monitor 系统，同底层（pthread_cond），不同上层

7. **交叉引用**：[07] VMThread + [08] WorkerThread + [09] JavaThread + [10] NonJavaThread + [11] AttachListener + [12] ServiceThread + [13] ReferenceHandler+Finalizer + [14] CompilerThread + [15] JFR（JfrMsg_lock/JfrStream_lock） + [01] ObjectMonitor

## 七、输出格式

- Markdown 文件，命名为 `16-JVM-Internal-Locks.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 [01][07][08][09][10][11][12][13][14][15] + 阅读收益）
