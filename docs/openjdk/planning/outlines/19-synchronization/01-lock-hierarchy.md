# 01. `synchronized` 三步曲 — biased→BasicLock→ObjectMonitor

> 🔴 Deep | 4 KP 中的锁演化路径
> 读者处境: `synchronized(obj) {}` 编译成 monitorenter/monitorexit 字节码——但 JVM 不只一成不变地做重量级锁。同一把锁随着竞争程度变化，在三种不同实现间切换。

### 1. "对象头的 3 个 bit 在说什么？" — markOop 锁编码

场景: Java 对象头(mark word)的前 3 个 bit 决定了锁的状态——解锁/偏向/BasicLock/重量锁，Gc 也要借用这个空间。

**markOop 3-bit 锁定编码** (`markOop.hpp:67-85`):
```
[unused:25][hash:31][age:4][biased_lock:1][lock:2]
lock bits:
  00 = 无锁(unlocked)
  01 = 偏向锁(biased) — biased_lock bit 额外 1 bit
  10 = 轻量锁(BasicLock) — displaced markOop 在线程栈上
  11 = 重量锁(ObjectMonitor) — 指针指向 ObjectMonitor
```
- 源码: `markOop.hpp:67-85` enum lock_bits
- 关键设计: 2 bit + 1 biased bit = 3 bit 状态编码——只有 4 种状态但足够表达所有锁级别。为什么只有 2 bit (不是 3 bit)？因为 age 也需要 4 bit 给 GC，hash 需要 25 bit——锁和 GC 必须分享 32-bit mark word。
- [x86: cmpxchg 指令用 32-bit 原子比较+交换 markOop——`lock cmpxchgl %src, (%dest)`——把新 mark word 写入对象头的前提是 old 和 current 匹配。这是 Java 轻量锁 fast_path 的基石——1 条指令完成锁获取]

**锁的生命周期** (`synchronizer.cpp:160-240`):
```
unlocked (00) → biased (01) → BasicLock (10) → ObjectMonitor (11)
                  ↑                                    |
                  └──── deflate ← idle ←─¬             |
                                         └─ inflate ←──┘
```
- 源码: `synchronizer.cpp:160-240` fast_enter→fast_enter_biased→revoke_and_rebias→inflate
- 关键设计: 流程是单向的——unlocked→biased→BasicLock→ObjectMonitor。不降级到 BasicLock（ObjectMonitor 回收后直接变成 unlocked）。deflate 是 GC 时 safepoint 里做的唯一降级——从 ObjectMonitor 直接退回到 unlocked

### 2. "第一个线程进来——为什么要偏向？" — BiasedLocking

场景: 大多数锁只被一个线程使用——HashMap 的 put 在单线程代码中每次都要 CAS markOop（~20 cycles overhead）。偏向锁免除了这个代价。

**BiasedLocking enter 流程** (`biasedLocking.cpp:80-150`):
```
fast_enter:
  1. 读 markOop 的 biased_lock bit+lock bits
  2. biased_lock=1 → 检查 biased_thread_id == self？→ same → 直接进入 (0 CAS)
  3. biased_lock=1 → biased_thread_id != self → revoke_and_rebias
  4. biased_lock=0 → 走 BasicLock 路径
```
- 源码: `biasedLocking.cpp:80-150` `BiasedLocking::revoke_and_rebias()`
- 关键设计: 偏向锁的开销是 0(对偏向线程)和 1 次 CAS(首次获取时写 thread_id+epoch)。不是 CAS 减到 0——减少了"对已经偏向的线程"的所有 CAS——这是常态
- [C++: epoch 是 Klass 级别的 counter(_biased_lock_revocation_count)——当一个类的 epoch 递增，所有 biased lock 在下次检查时发现 epoch 不匹配→批量清理。不用逐对象逐线程撤销]

**Revoke 两种模式** (`biasedLocking.cpp:200-350`):
```
individual_revoke: safepoint→暂停偏向线程→检查它是否仍在临界区→是:走BasicLock,否:直接解锁
bulk_revoke: 当 revocations > BiasedLockingBulkRevokeThreshold→epoch++→所有epoch过期的偏向锁自动无效
bulk_rebias: 同类的所有偏向锁重偏向——revocations > BiasedLockingBulkRebiasThreshold
```
- 关键设计: 为什么 revoke 需要 safepoint？因为需要检查偏向线程的栈——看它是否持有这个锁。非 safepoint 读取其他线程的栈是不安全的那线程可能正在修改

### 3. "没有偏向——走轻量锁" — BasicLock

场景: 没有偏向或者偏向被撤销——两个线程罕见地争用同一把锁。走 BasicLock 路径。

**BasicLock 栈分配** (`basicLock.hpp:32-55`):
```cpp
class BasicLock {
  volatile markOop _displaced_header; // 原始 markOop 存这里
};
// BasicLock 在线程栈上——每个 monitorenter 创建一个
// 不共享——每个线程的 BasicLock 是独立分配的
```
- 源码: `basicLock.hpp:32-55` BasicLock 结构
- 关键设计: BasicLock 不分配堆内存——在栈上——意味着零 GC 开销。_displaced_header 存储进入前的 markOop(含 hash/age)——退出时 cmpxchg 恢复

**BasicLock fast_enter** (`synchronizer.cpp:70-100`):
```
cmpxchg(markOop: 当前是 unlocked → 写入指向线程本地 BasicLock 的指针 + 锁定标记)
```
- [x86: 轻量锁获取 = 1 条 `lock cmpxchgl` + 1 条 `jne slow_path`——无函数调用、无队列操作、无 OS 交互。成功路径 ~20 cycles。这是轻量锁为什么"轻": 全在硬件上完成]
- 失败路径→inflate→ObjectMonitor

---

### 核心悬念

**"`synchronized` 在同一把锁上可以经历 biased→BasicLock→ObjectMonitor 三级演化——每级的成本相差 10x(0→20→500 cycles)。对象头 3 bit 编码了全状态。"** — 但重量级锁(ObjectMonitor)内部是什么？下一篇: ObjectMonitor 结构。

> → [02-objectmonitor-structure.md](02-objectmonitor-structure.md)
