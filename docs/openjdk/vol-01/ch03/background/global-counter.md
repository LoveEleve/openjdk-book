# 前置概念：GlobalCounter —— RCU 风格的宽限期等待

## 和 Thread-SMR 的关系

`_rcu_counter` 所属的 GlobalCounter 机制和本文核心的 Thread-SMR（Hazard Pointer）是 **两套独立的并发安全回收方案**。它们在同一个构造函数里初始化，但服务不同的场景：

- **Hazard Pointer**：读者贴标签指向特定快照，写者只等该快照的读者。粒度细、适用于持有时间长的场景（如 GC 扫描线程列表，耗时几百微秒）
- **GlobalCounter**：读者标记"我进入了临界区"，写者等全体老读者离开。粒度粗、适用于临界区极短的场景（如 oopStorage 操作，耗时几微秒）

## 字段和工作流

每个 `Thread` 对象上有一个 `volatile uintx _rcu_counter`（`thread.hpp:315`）。全局有一个 `GlobalCounter::_global_counter`（`globalCounter.hpp:54`，`volatile uintx`）。

```
读者路径:
  critical_section_begin(thread)    // 标记"进入了临界区"
  // ... 读取受保护的数据 ...
  critical_section_end(thread)      // 标记"离开了"

写者路径:
  // ... 替换数据（新数据已发布）...
  write_synchronize()               // 等所有人离开后再回收旧数据
  // 安全回收旧数据
```

## 逐行拆解

### 读者进入临界区（`globalCounter.inline.hpp:32-37`）

```cpp
inline void GlobalCounter::critical_section_begin(Thread *thread) {
```

栈上传递当前线程对象，必须是 `Thread::current()`。

```cpp
  assert(thread == Thread::current(), "must be current thread");
  assert((*thread->get_rcu_counter() & COUNTER_ACTIVE) == 0x0,
         "nested critical sections, not supported yet");
```

assert 1：必须是当前线程自己在操作自己的计数器。assert 2：不能嵌套——当前线程不能在已进入临界区的情况下再次进入（和 SMR 不同，SMR 支持嵌套遍历）。

```cpp
  uintx gbl_cnt = OrderAccess::load_acquire(&_global_counter._counter);
```

带 acquire 语义读全局计数器的当前值。假设此时值为 `42`。acquire 保证读到的是最新的完整值。

```cpp
  OrderAccess::release_store_fence(thread->get_rcu_counter(), gbl_cnt | COUNTER_ACTIVE);
}
```

`COUNTER_ACTIVE` 的值是 `1`（bit0）。`42 | 1 = 43`——bit0 置 1，高位不变。`43` 同时表达了两个信息：代际 42（高位）+ 我在临界区内（bit0=1）。release_store_fence 将 43 写入 `_rcu_counter`，对其他线程立刻可见。

执行后：`thread._rcu_counter = 43`（42 | 1）。含义："我在全局计数器 = 42 这一代进入了临界区，目前还在里面（bit0=1）"。

### 读者离开临界区（`globalCounter.inline.hpp:39-45`）

```cpp
inline void GlobalCounter::critical_section_end(Thread *thread) {
  assert(thread == Thread::current(), "must be current thread");
  assert((*thread->get_rcu_counter() & COUNTER_ACTIVE) == COUNTER_ACTIVE,
         "must be in critical section");
```

assert：离开之前必须先确认自己确实在临界区中。

```cpp
  uintx gbl_cnt = OrderAccess::load_acquire(&_global_counter._counter);
  OrderAccess::release_store(thread->get_rcu_counter(), gbl_cnt);
}
```

再次读全局计数器（此时是 `44`——写者已经递增过了），不带 ACTIVE 位写入线程计数器。

执行后：`thread._rcu_counter = 44`（ACTIVE 位为 0）。含义："我已经离开临界区，当前全局代际是 44"。

### 写者等待宽限期（`globalCounter.cpp:60-73`）

```cpp
void GlobalCounter::write_synchronize() {
  assert((*Thread::current()->get_rcu_counter() & COUNTER_ACTIVE) == 0x0,
         "must be outside a critcal section");
```

写者自己不能在临界区内——否则等待自己离开，死锁。

**写者不能等读者——而是先递增再等。** 写者在调用 `write_synchronize()` 之前已经把数据替换好了（新版本已经发布）。递增全局计数器的作用是**画一条分界线**——在这条线之前进入临界区的读者（代际 < 44）看到的是旧数据，在这条线之后进入的读者（代际 ≥ 44）看到的是新数据。写者只等"线前"的老代读者离开——"线后"的新代读者不需要等，因为他们看到的是新数据。

```cpp
  volatile uintx gbl_cnt = Atomic::add(COUNTER_INCREMENT, &_global_counter._counter,
                                       memory_order_conservative);
```

原子的把全局计数器加 2。`COUNTER_INCREMENT = 2`——为什么是 2 而不是 1？因为 bit0 被 ACTIVE 位占用。计数器实际值只使用高位，递增 2 才能保证 bit0 始终不变。

假设加之前全局 = 42，加之后 = 44。`gbl_cnt` 保存的是加之后的值（44）。这条分界线之后进入临界区的读者会读全局计数器 = 44，写入自己的 `_rcu_counter = 44 | 1 = 45`——这是新代读者，读的是新数据，写者不需要等他们。

```cpp
  CounterThreadCheck ctc(gbl_cnt);
  for (JavaThreadIteratorWithHandle jtiwh; JavaThread *thread = jtiwh.next(); ) {
    ctc.do_thread(thread);    // 检查每个 JavaThread
  }
  for (NonJavaThread::Iterator njti; !njti.end(); njti.step()) {
    ctc.do_thread(njti.current());  // 检查每个非 Java 线程
  }
}
```

遍历所有线程（JavaThread + NonJavaThread），调用 `CounterThreadCheck::do_thread`。

### `CounterThreadCheck`——判断一个线程是否还在老代中（`globalCounter.cpp:41-58`）

```cpp
void do_thread(Thread* thread) {
  SpinYield yield;
  while(true) {
    uintx cnt = OrderAccess::load_acquire(thread->get_rcu_counter());
```

读线程计数器的当前值。假设线程 A 在全局=42 时进入临界区（`_rcu_counter = 43 = 42 | 1`），写者递增全局=44 后来检查。

```cpp
    if (((cnt & COUNTER_ACTIVE) != 0) && (cnt - _gbl_cnt) > (max_uintx / 2)) {
      yield.wait();
    } else {
      break;
    }
  }
}
```

这个条件判断线程是否还在"老代"中——需要两段共同满足：

**条件 A**：`(cnt & COUNTER_ACTIVE) != 0` —— 线程的 ACTIVE 位为 1（还在临界区内）。

**条件 B**：`(cnt - _gbl_cnt) > (max_uintx / 2)` —— 线程的计数小于全局新计数。这是一个无符号环绕安全的"小于"比较：如果 `cnt - gbl_cnt` 大于无符号最大值的一半，说明 `cnt < gbl_cnt`（考虑溢出）。

**两段都成立** → 线程在全局递增**之前**就进入了临界区，且目前还**没有离开** → 这是老代读者 → `yield.wait()` 忙等待 → 重新读。

**任一不成立** → 要么 ACTIVE=0（已经离开），要么计数 ≥ 新全局值（是新代读者，在全局递增之后才进入）→ `break` 停止等待。

写者按顺序检查每个线程，对每个还活着的"老代读者"忙等待直到它离开。所有线程的 `do_thread` 返回后，`write_synchronize()` 完成——旧数据可以安全回收。

## 示意图：两代读者

```
全局计数器:  ──────42──────┬────44────── (write_synchronize 递增)
                          │
    线程 A:  进入(写42) ───│─── 还在临界区 ─── 离开(写44)
                          │    ↑ 写者忙等待它
    线程 B:               进入(写44) ─── 离开(写44)
                               ↑ 新代读者，写者不等它
```

线程 A 在全局=42 时进入，写者递增到 44 时还没离开 → 条件 A+B 都成立 → 写者忙等待 A。

线程 B 在写者递增后（全局=44）进入 → 条件 B 不成立（它的计数 ≥ 44）→ 写者不等它——它是新代读者，读的是新数据。

## 和 Hazard Pointer 的对比

| | GlobalCounter（RCU） | Thread-SMR（HP） |
|--|---------------------|-----------------|
| 读者声明 | `critical_section_begin`——不指定保护哪个对象 | `_threads_hazard_ptr = v3`——指定保护哪个快照 |
| 写者等待 | `write_synchronize`——等全体老代读者 | `smr_delete` 中的扫描——只等指向特定快照的读者 |
| 读者持有时间 | 必须极短（微秒级）——写者忙等待，读者持有时间越长写者负担越重 | 可以很长（毫秒级）——写者只在 `delete_lock` 上 `wait`，不影响其他操作 |
| 场景 | oopStorage、ConcurrentHashTable | 线程列表遍历 |
