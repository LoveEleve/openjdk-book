# 04. JVM 自己怎么锁自己？— VM 内部锁与安全网

> 🟡 Working | 3 KP 中的内部基础设施
> 读者处境: JVM 内部有 100+ 把锁——Mutex 保护 safepoint、CodeCache_lock 保护编译缓存、Threads_lock 保护线程列表。这些锁怎么保证不产生死锁？

### 1. "100 把锁的死锁预防" — Monitor/Mutex rank ordering

场景: 两个 VM 线程 A 和 B——A 先拿 CodeCache_lock 再拿 Threads_lock，B 先拿 Threads_lock 再拿 CodeCache_lock→死锁。JVM 的 rank 系统阻止它。

**Mutex rank 层级** (`mutexLocker.hpp:50-130`):
```
Mutex::safepoint    = 0   // 最高优先级(只被 safepoint 线程获取)
Mutex::tty          = 1
...
Mutex::CodeCache    = 15
Mutex::Threads_lock = 18
...
Mutex::Compile_lock = 25
```
- 源码: `mutexLocker.hpp:50-130` 全部 mutex rank 定义(Mutex 嵌套类)
- 关键设计: 获取时检查 `_rank > last_locked_rank→assert 失败。lock ordering 规则: 锁必须按 rank 递增获取(低→高)或递减(高→低)。不能违反——assert 在 debug 模式立即 crash→开发者必须重新设计获取顺序
- [C++: rank 是单增规则——thread 记录 `_owned_locks[]` 数组，每获取一把锁就插入。获取新锁时检查是否有已持有的锁 rank > 新锁的 rank——如果有→违反→assert。release 模式下禁用检查(性能)——所以死锁只在 debug 开发时出现]

**Monitor vs Mutex** (`mutex.hpp:60-160`):
```
Mutex:    纯互斥锁——只有 lock/unlock
Monitor:  Mutex + 条件变量——有 wait/notify/notify_all
```
- 源码: `mutex.hpp:60-160` Monitor 继承 Mutex
- 关键设计: Monitor 的条件变量是用 pthread_cond 实现的——`Monitor::wait(millis)`→pthread_cond_timedwait。notify 时调 pthread_cond_signal。比 Java 的 notify 更简单——没有 EntryList/WaitSet 分离

**MutexLocker RAII** (`mutexLocker.hpp:200-300`):
```cpp
class MutexLocker: public StackObj {
  Monitor* _mutex;
public:
  MutexLocker(Monitor* mutex) : _mutex(mutex) { _mutex->lock(); }
  ~MutexLocker() { _mutex->unlock(); }
};
```
- 源码: `mutexLocker.hpp:200-300` MutexLocker 模板
- [C++: 和 ThreadInVMfromJava 同样的 RAII 模式——C++ 没有 finally 块。栈上分配→抛出异常→析构确保解锁。VM 代码中几乎 100% 用 MutexLocker 而非裸 lock/unlock]

### 2. "偏向锁撤销——为什么需要 safepoint？" — BiasedLocking Revoke

场景: 线程 T1 偏向了一把锁→线程 T2 也要用这把锁→需要撤销偏向。但 T1 可能在临界区——不能强制撤销。

**revoke_at_safepoint 流程** (`biasedLocking.cpp:370-480`):
```
1. safepoint 暂停所有线程
2. 检查偏向线程 T1 的栈:
   - 栈上有这个锁的 BasicLock 记录吗？→ T1 正在临界区→不能撤销偏向→改为
     让 T1 在下次 exit 时变成 BasicLock
   - 栈上没有→ T1 不在临界区→可以安全撤销→biased_lock bit=0→恢复到 unlocked
3. safepoint 结束—T2 醒来→fast_enter 看到 unbiased→走 BasicLock 路径
```
- 源码: `biasedLocking.cpp:370-480` revoke_at_safepoint
- 关键设计: 撤销必须在 safepoint——因为需要读 T1 的栈(找 BasicLock 记录)。不同线程间读栈不是线程安全的——若 T1 正在修改它的 BasicLock→数据竞争。safepoint 暂停所有线程→栈是僵化的→可安全读
- [C++: `biasedLocking.cpp:150-200` 包含批量撤销(BulkRevoke)——当同一个类的撤销次数 > BiasedLockingBulkRevokeThreshold(默认 40)→epoch++→所有偏向锁的 epoch 过期→下次自动撤销——不需要逐线程 safepoint。批量撤销从 O(N×M) 优化到 O(N)]

### 3. "别让重量锁一直占着内存" — deflate 回收

场景: 一个 Object 被用作锁好久→现在已经没有人用它→ObjectMonitor 占着 ~200 bytes→需要回收。

**deflate_idle_monitors** (`synchronizer.cpp:700-900`):
```
safepoint 时:
  for each ObjectMonitor in global InUseList:
    if (_count == 0 && _owner == NULL && _cxq == NULL && _EntryList == NULL):
      → 空闲 → 归还到 free list
```
- 源码: `synchronizer.cpp:700-900` `ObjectSynchronizer::deflate_idle_monitors()`
- 关键设计: deflate 只在 safepoint 做——不增加每次锁获取的开销。_count 追踪活跃使用者(EntryList+WaitSet 中的线程)——count=0→无人等待→安全回收
- [C++: per-thread free list(ObjectMonitor::omFreeList) 提供低延迟的 inflate→已回收的 ObjectMonitor 原地重用。如果一个线程需要多把重量锁→从自己的免费列表取→不访问全局免费列表→无锁分配]

### 4. "LockSupport.park() 在底层是什么？" — ParkEvent

场景: `LockSupport.parkNanos(100_000_000)` → Java 线程阻塞 100ms。底层是 ParkEvent。

**ParkEvent 实现** (`park.cpp:70-150`):
```cpp
void PlatformEvent::park() {
  _nParked = 1;                // 标记 "已 parking"
  while (_event < 0) {         // permit < 0 → 未 unpark
    pthread_cond_wait(_cond, _mutex);
  }
  _nParked = 0;
}
void PlatformEvent::unpark() {
  pthread_mutex_lock(_mutex);
  _event = 1;                  // 设置 permit
  pthread_cond_signal(_cond);  // 唤醒 parker
  pthread_mutex_unlock(_mutex);
}
```
- 源码: `park.cpp:70-150` PlatformEvent::park + unpark
- [C++: `_event` 是 permit counter——`>0` = permit available, `≤0` = need to wait。park 条件 `event--; if(event < 0) wait;` 支持先 unpark 后 park——unpark 把 event 设 1→park 来时看到 1→直接返回不 Wait。这是 LockSupport.park() 的三个版本(park/parkNanos/parkUntil)的公共底层]
- [内核: pthread_cond_wait→futex(2)——FUTEX_WAIT_PRIVATE。与 ObjectMonitor 的 enter->park 是同一个内核机制。区别: ObjectMonitor 在用户态做了 adaptive spinning+cxq→只在最终需要时调用 park→减少了 futex 系统调用次数]

---

### 核心悬念

**"JVM 用 Mutex rank 系统防内部死锁(100+锁按层级排序获取)，偏向锁撤销依赖 safepoint 线程安全读写其他线程的栈，deflate 在 safepoint 回收空闲 ObjectMonitor。"** — 下一篇: 域20 VM Operations——安全点的所有操作由谁来驱动。

> → 域20 VM Operations
