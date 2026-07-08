# 前置概念：`_oops_do_parity` —— GC 并行标记的去重锁

## 问题

并行 GC（如 Parallel GC、G1）有多个 GC 工作线程同时扫描线程栈上的 oop 根。如果两个工作线程都去扫描同一个 Java 线程的栈——做了两遍无用功，甚至因为并发访问导致数据不一致。

需要一个机制保证：**每个 Java 线程在一次 GC 中最多被一个工作线程扫描一次**。

这就是 `_oops_do_parity` 的全部使命——它是一个线程级的去重锁，用 CAS 实现无锁的"谁先拿到谁扫描"。

## 字段定义

每个 `Thread` 对象上有一个 `int _oops_do_parity`（`thread.hpp:311`），初始化为 0（`thread.cpp:241`）。全局有一个 `Threads::_thread_claim_parity`（`thread.hpp:2209`），初始化为 0（`thread.cpp:3509`）。

```cpp
// thread.hpp:311
int _oops_do_parity;

// thread.hpp:2209
static int _thread_claim_parity;
```

## 全局 parity 的翻转

每次 GC 根扫描开始时，全局 parity 翻一次。翻转代码（`thread.cpp:4555-4563`）：

```cpp
void Threads::change_thread_claim_parity() {
  _thread_claim_parity++;
  if (_thread_claim_parity == 3) _thread_claim_parity = 1;
}
```

全局 parity 的取值是 1 和 2 之间的循环：`0 → 1 → 2 → 1 → 2 → ...`。线程的 parity 初始为 0——这个值永远不会等于全局 parity，所以新线程第一次被扫描时绝对不会被错误地视为"已 claim"。

## Claim 过程——CAS 抢一个线程

### 先理清角色

GC 工作线程（比如 G1 的 Worker 1、Worker 2）和 Java 线程（比如 T1、T2、T3）是**不同的线程**。这一步发生在 GC 的根扫描阶段——多个 GC 工作线程同时去扫描**同一个线程列表**中的所有 Java 线程，看每个 Java 线程的栈上有没有活着的 oop 指针。

谁来扫描谁？**GC 工作线程扫描 Java 线程。** 问题：如果 Worker 1 和 Worker 2 都去扫描 T1 的栈——做了两遍，浪费。所以需要"claim"机制——每个 Java 线程只能被一个 GC 工作线程 claim。

### 调用关系——三层

```
possibly_parallel_threads_do()           ← 遍历所有 Java 线程，分配任务
    ->  p->claim_oops_do(is_par, cp)       ← 判断是否并行，分派到具体实现
         ->  claim_oops_do_par_case(cp)    ← 并行路径：CAS 抢
```

`possibly_parallel_threads_do()`（`thread.cpp:3568`）遍历所有 JavaThread。对每个 Java 线程调用 `claim_oops_do()`。`claim_oops_do()`（`thread.hpp:591-598`）有两个分支：

```cpp
void Threads::possibly_parallel_threads_do(bool is_par, ThreadClosure* tc) {
  int cp = Threads::thread_claim_parity();     // 读当前全局 parity
  ALL_JAVA_THREADS(p) {
    if (p->claim_oops_do(is_par, cp)) {        // 尝试 claim
      tc->do_thread(p);                         // 成功后扫描
    }
  }
}
```

`claim_oops_do()` 有两个分支（`thread.hpp:591-598`）：

```cpp
bool claim_oops_do(bool is_par, int collection_parity) {
    if (!is_par) {
      _oops_do_parity = collection_parity;    // 单线程：直接赋值
      return true;
    }
    return claim_oops_do_par_case(collection_parity); // 并行：CAS 抢
}
```

**并行路径的核心**在 `claim_oops_do_par_case`（`thread.cpp:864-876`）。参数 `strong_roots_parity` 的值来自最外层 `possibly_parallel_threads_do` 中读到的全局 parity——例如当前 GC 轮次翻转后是 2。这个值被原封不动传递：`Threads::thread_claim_parity()` → `cp` → `collection_parity` → `strong_roots_parity`。含义不变——都是"本轮 GC 的全局 parity 值"。

```cpp
bool Thread::claim_oops_do_par_case(int strong_roots_parity) {
  int thread_parity = _oops_do_parity;                      // 第一步—— 读当前值

  if (thread_parity != strong_roots_parity) {               // 第二步—— 不等 → 还没被 claim
    jint res = Atomic::cmpxchg(strong_roots_parity,          // 第三步—— CAS 抢
                               &_oops_do_parity, thread_parity);
    if (res == thread_parity) {
      return true;   // 第四步—— CAS 成功 → 是我抢到了！扫描这个线程
    }
    return false;    // 第五步—— CAS 失败 → 被别的线程抢了
  }
  return false;      // parity 已经相等 → 本轮已被 claim
}
```

**逐行解释**：

第一步—— 读当前线程的 `_oops_do_parity` 值（比如 1）。

第二步—— 和全局 parity 比较。如果不等（比如线程是 1，全局是 2）→ 本轮 GC 还没有人 claim 过这个线程 → 尝试抢。

第三步—— `Atomic::cmpxchg(全局值, &_oops_do_parity, 旧值)` —— CAS 原子操作。只有当 `_oops_do_parity` 当前还是 `旧值` 时，才把它改成 `全局值`。原子性保证多个工作线程同时抢同一个线程时，只有一个能成功。

第四步—— `res == thread_parity` → CAS 返回旧值，等于 第一步—— 读到的值 → 说明在 第一步—— 和 第三步—— 之间没有人改过 → 我抢到了 → 返回 `true` → 工作线程执行 `oops_do` 扫描这个线程的栈。

第五步—— `res != thread_parity` → CAS 返回的值不等于 第一步—— 读到的值 → 说明另一个工作线程在我之前抢到了 → 返回 `false` → 跳过。

第六步—— 如果 第二步—— 比较时 `thread_parity == strong_roots_parity` → 说明本轮 GC 开始后已经有人 claim 过此线程了 → 直接返回 `false` 跳过。

### 具体走一轮

假设当前全局 parity 刚被翻转为 2。有 3 个 Java 线程 T1、T2、T3，2 个 GC 工作线程 W1、W2 同时扫描。初始状态所有线程的 `_oops_do_parity = 1`（上一轮 GC 留下的）。

```
W1 遍历列表:                         W2 遍历列表:
  T1: claim_oops_do(true, 2)           T1: claim_oops_do(true, 2)
    → thread_parity=1 ≠ 2               → thread_parity=1 ≠ 2
    → CAS(2, &_oops_do_parity, 1)       → CAS(2, &_oops_do_parity, 1)
    → 成功！返回 true ← W1 抢到了       → 失败！（W1 已经改成了 2）
    → W1 扫描 T1 的栈                   → 返回 false ← W2 跳过 T1
  T2: claim_oops_do(true, 2)           T2: claim_oops_do(true, 2)
    → thread_parity=1 ≠ 2               → thread_parity=1 ≠ 2
    → CAS(2, &_oops_do_parity, 1)       → CAS(2, &_oops_do_parity, 1)
    → 失败！（W2 先下手了）              → 成功！返回 true ← W2 抢到了
    → 返回 false ← W1 跳过 T2           → W2 扫描 T2 的栈
  T3: claim_oops_do(true, 2)           T3: claim_oops_do(true, 2)
    → thread_parity=1 ≠ 2               → W2 比 W1 快，先抢到 T3
    → CAS 失败                           → ...
    → 返回 false
```

最终：T1 被 W1 扫描，T2 和 T3 被 W2 扫描。每个 Java 线程只被一个 GC 工作线程处理。扫描结束后，所有线程的 `_oops_do_parity = 2`。

析构 `StrongRootsScope` 时，`assert_all_threads_claimed()` 遍历检查：每个线程的 parity 是否都等于当前全局 parity（2）。少一个都不行——说明有线程被漏掉了，直接 abort。

## 为什么全局 parity 用 1 和 2 循环而不是计数器

如果用递增计数器（1, 2, 3, 4, ...），溢出后回到 0。但线程初始值也是 0——溢出后会和新线程混淆（把新线程误认为"已被 claim"）。1 和 2 的循环避开了初始化值 0，永远不会和新线程冲突。

## 哪些 GC 触发 parity 翻转

每次构造 `StrongRootsScope` 对象时，全局 parity 翻转一次（`strongRootsScope.cpp:39`）：

```cpp
StrongRootsScope::StrongRootsScope(uint n_threads) {
  Threads::change_thread_claim_parity();
}
```

`StrongRootsScope` 被 Serial、Parallel、CMS、G1 所有 STW 根扫描阶段使用。ZGC 和 Shenandoah 也各自调用 `change_thread_claim_parity()`（`zRootsIterator.cpp:161`、`shenandoahRootProcessor.cpp:78`）。

析构时验证完整性（`strongRootsScope.cpp` 对应行）：

```cpp
StrongRootsScope::~StrongRootsScope() {
  Threads::assert_all_threads_claimed();  // 断言所有线程都被 claim 过
}
```

## 和 SMR 的关系

无直接关系。`_oops_do_parity` 和 `_threads_hazard_ptr` 只是在同一个构造函数中初始化的 5 个字段之二——它俩分别服务 GC 和 SMR 两个独立子系统。唯一的交集是：GC 扫描线程栈时已经通过 `StrongRootsScope` 做了 parity 翻转，同时 GC 也通过 `ThreadsListHandle` 的 hazard ptr 保护了它正在扫描的线程不被 `smr_delete` 释放。两者各司其职。
