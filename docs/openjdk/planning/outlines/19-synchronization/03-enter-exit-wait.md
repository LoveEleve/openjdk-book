# 03. 多线程抢锁——谁先拿到？— Enter/Exit 与 Wait/Notify

> ⚠️ 写作期修正(2026-08-13, vol-02/19-sync/03 已按真实源码成文~185 行,本大纲为规划期产物,机制描述以文章为准):
> - **enter**(objectMonitor.cpp:265 起,非"280-320"): 三快路径=空闲 CAS :270/重入 _recursions++ :279-283/**is_lock_owned 栈锁转移** :285-291;慢路径=_count++ 防 deflate :316+ThreadBlockInVM+循环 EnterI :355;EnterI(:442): TryLock TATAS :448/TrySpin :464/封 ObjectWaiter :485-493(TS_CXQ :488)/CAS push-to-front :494-497/Responsible 定时 park 防 stranding(:503-516 注释)
> - **exit**(:905 起,非"500-650"): 重入退出 :925-930;Knob_ExitPolicy==0: release_store 掉锁 :967+storeload+**看 EntryList|cxq 与 _succ** :968(空或有 succ→简单出口);复杂出口需 **reacquire _owner**(replace_if_null :990-998);_succ 注释 :978-997(Dice §3.3 Futile Wakeup Throttling);QMode 2=cxq 优先 ExitEpilog(:1054-1063)/QMode 3-4=**drain cxq→EntryList bulk transfer**(:1067-1115);ExitEpilog :1282-1314 协议四步(注释 :1288-1291: 置 _succ→membar→_owner=NULL→unpark)
> - **wait**(:1426 起,非"1400-1600"): WaitSetLock+AddWaiter :1483-1484/保存 _recursions :1490/exit :1493/park;醒来回 EntryList 竞争+恢复递归
> - **notify**(:1776,非"1700-1800"): **默认 Knob_MoveNotifyee=2 把 waiter 转 TS_CXQ 进 cxq 而非 EntryList**(objectMonitor.cpp:135 默认值,:1715-1726);policy 0/1 才进 EntryList(prepend/append,TS_ENTER :1673-1714);policy 4 直接 unpark(:1742-1747);notify 本身不 unpark(默认策略),唤醒在 exit 时;notifyAll :1795 循环 INotify
> - 悬念指向 04-internal-locks.md(标题 "04. VM 内部锁——Mutex/Monitor 与 Java 锁有什么不同")✓

> 🔴 Deep | 4 KP 中的锁协议
> 读者处境: 3 个线程同时 `synchronized(obj)`——一个拿到了锁，两个在等。拿到锁的线程调了 `obj.wait()`。另一个线程调了 `obj.notify()`。这一系列操作的底层是怎么协调的？

### 1. "cmpxchg 一击" — enter 快速路径

场景: 锁是空闲的——第一个线程直接 cmpxchg _owner 拿到锁。

**enter 快速路径** (`objectMonitor.cpp:280-320`):
```cpp
void ObjectMonitor::enter(TRAPS) {
  // Fast path: 锁空闲
  void* cur = Atomic::cmpxchg(Self, &_owner, (void*)NULL);
  if (cur == NULL) {
    _recursions = 0;
    return; // 成功——1 条 CAS
  }
  // recurse: 我是 owner
  if (cur == Self) { _recursions++; return; }
  // Slow path: 竞争...
}
```
- 源码: `objectMonitor.cpp:280-320` enter 主体
- 关键设计: 快速路径 = 1 条 CAS 指令——无队列、无阻塞、无 OS 交互。这是 Linux futex 的用户空间复刻——只有真正发生阻塞才进内核(futex_wait)
- [x86: `lock cmpxchg` = ~20 cycles(L1 cache hit)——这是锁获取的最快路径。对比 pthread_mutex_lock = ~50 cycles(fast path, no contention) → ~5 µs(slow path, futex)]

**enter 慢速路径** (`objectMonitor.cpp:320-450`):
```
1. Adaptive Spinning: 自旋 _SpinDuration 次——每次 SpinPause()(~140 cycles)
2. 自旋后仍未获得→加入 _cxq:
   - 封成 ObjectWaiter node
   - CAS push-to-front _cxq
3. park: PlatformEvent::park() → pthread_cond_wait(底层 futex)
```
- 关键设计: 自适应自旋——_SpinDuration 根据历史调整(每次成功 +1, 失败>>1)。自旋不是固定值——在 Skylake+ 上初始 ~2000 次 PAUSE=280µs——对短暂持锁足够，对长时间锁浪费资源。自适应调整节省 CPU

### 2. "你完事了——叫他来" — exit + succ handoff

场景: 持锁线程退出——EntryList 上有等待者。把它唤醒。

**exit 流程** (`objectMonitor.cpp:500-650`):
```
1. _recursions--; if (_recursions > 0) return; // 重入退出不触发 handoff
2. 检查 EntryList:
   a) 非空 → wake 第一个 waiter: unpark(succ)
   b) 空 → 检查 cxq:
      - 非空 → 整个 cxq 转移到 EntryList → wake 第一个
3. _owner = NULL
```
- 关键设计: succ(Heir Presumptive) 唤醒优化——不是 wake-all。exit 选一个 waiter 标记为 _succ→unpark 它→它醒来后不需要重新排队(get _owner)。如果它被 spurious wakeup 或 timeout 错过→Responsible thread 接管
- [C++: 为什么 unpark ONE 不是 ALL？wake-all 在锁协议中是浪费——只有一个能获得锁——其他被唤醒后重新发现锁被占用→重新 park→"thundering herd"。succ 继承避免了 99% 的无谓 wakeup]

**Succ 继承流程**:
```
exit: _succ = first waiter in EntryList → unpark
succ wakes: cmpxchg _owner = Self → 成功 → 成为新 owner → _succ = NULL
如果 cmpxchg 失败(其他线程抢了): 回到 enter slow path → 重新排队
```

### 3. "wait 被谁唤醒？" — Wait/Notify 与 ParkEvent

场景: `obj.wait()` → 当前线程放弃锁 → 等别人 notify。内部的 notify 怎么把线程从 WaitSet 移到 EntryList？

**wait 流程** (`objectMonitor.cpp:1400-1600`):
```
ObjectMonitor::wait():
  1. add to _WaitSet (CAS append)
  2. exit the monitor (_recursions saved)
  3. ParkEvent::park() → pthread_cond_wait → BLOCKED
  // ... 被 notify 唤醒 ...
  4. remove from _WaitSet
  5. enter the monitor (重新和 EntryList 竞争)
  6. restore _recursions
```
- 源码: `objectMonitor.cpp:1400-1600` wait + enter after notify
- 关键设计: wait 不是"释放然后等"——它把线程从 _owner 移到 _WaitSet→保存 _recursions→释放 _owner (其他人可以获取)→park。被唤醒后不是直接成为 owner——而是进入 EntryList 重新排队竞争——和 EntryList 上的其他人公平竞争

**notify 流程** (`objectMonitor.cpp:1700-1800`):
```
notify():
  1. 从 _WaitSet 取出第一个 waiter
  2. 把它移到 EntryList(可能直接设为 _succ)
  3. 不做 unpark——exit 时才做
```
- 关键设计: notify 不立即 unpark——只是把 waiter 从 WaitSet 移到 EntryList。实际的唤醒在当前线程 exit 释放锁时才发生。这样被 notify 的线程醒来时就发现锁已经空闲——可以直接获取。避免 "notified thread wakes→sees lock held→repark" 的浪费

**ParkEvent — 底层 parked** (`park.hpp` + `park.cpp`):
```
PlatformEvent:
  _event: pthread_cond_t + pthread_mutex_t (OS 条件变量)
  _nParked: 统计
  park(): 设置许可→pthread_cond_wait→等待
  unpark(): 设置许可→pthread_cond_signal→唤醒
```
- 源码: `park.cpp:70-150` PlatformEvent::park + unpark
- [C++: `_nParked` 是 permit——park 前设为 1, 醒来后设为 0。这允许 unpark 发生在 park 之前——如果 permit=0 且 unpark→设 permit=1→下次 park 看到 permit=1→直接返回不阻塞。这是 LockSupport 的 "先 unpark 后 park 有效" 的基础]

---

### 核心悬念

**"ObjectMonitor enter/exit 用 cmpxchg+adaptive spinning+succ handoff 实现近公平的锁分配——wait/notify 把线程在三条队列间移动：_owner→_WaitSet→EntryList→_owner。"** — 但 JVM 自己用的内部锁(Mutex/Monitor)有什么不同？下一篇: VM 内部锁。

> → [04-internal-locks.md](04-internal-locks.md)
