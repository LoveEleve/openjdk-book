# 前置概念：Parker —— `Unsafe.park()`/`unpark()` 的底层实现

## 问题

`java.util.concurrent` 中的 `Lock`、`CountDownLatch`、`Semaphore`、`ThreadPoolExecutor` 都依赖 `LockSupport.park()` 来阻塞线程、`LockSupport.unpark()` 来唤醒线程。这两个方法最终调用 `Unsafe.park()` 和 `Unsafe.unpark()`，后者是 native 方法。

`Parker` 就是这两个 native 方法的底层实现。

## 和 ParkEvent 的区别

HotSpot 有两套非常相似的等待机制：

| | Parker | ParkEvent |
|--|--------|-----------|
| 用途 | `LockSupport.park()`/`unpark()`（JUC） | `synchronized`/`Object.wait()`/`notify()`（Java 内置同步） |
| 适用线程 | 仅 `JavaThread` | 通用 `Thread` |
| 许可模型 | `_counter`（0/1），类似信号量 | `_event`（-1/0/1），类似二元信号量 |
| 锁策略 | `pthread_mutex_trylock`（非阻塞） | `pthread_mutex_lock`（阻塞） |

两套东西高度重叠——源码注释直说"将来应该合到 ParkEvent"。历史原因：Parker 随 JSR166（`JUC`）引入，ParkEvent 更古老。

## 字段

`_parker` 在 `JavaThread` 构造时通过 `Parker::Allocate(this)` 分配（`thread.cpp:1661`），类型是 `Parker*`（`thread.hpp:2074`）。Parker 对象有三个核心字段（`park.hpp:48-75`）：

```cpp
class Parker : public os::PlatformParker {
  volatile int _counter;        // 许可计数（0 或 1）——unpark 设为 1，park 消费为 0
  Parker * FreeNext;            // 回收链指针（从不 delete，线程退出后回收到 FreeList）
  JavaThread * AssociatedWith;  // 关联的 JavaThread
};
```

底层继承 `PlatformParker`，持有一把 `pthread_mutex_t` 和两路 `pthread_cond_t`（一路用于相对时间 `_cond[0]`，一路用于绝对时间 `_cond[1]`）。

## park()——阻塞

`Unsafe_Park()`（`unsafe.cpp:939`）直接调用 `thread->parker()->park(isAbsolute, time)`。Parker::park 的核心逻辑（`os_posix.cpp:2158`）：

**快速路径——无锁消费许可**：

```cpp
if (Atomic::xchg(0, &_counter) > 0) return;
```

如果 `_counter` 已经是 1（说明在 park 之前已经有人调了 unpark），原子地把它设回 0，直接返回——不阻塞。这是 Parker 和 ParkEvent 的关键区别：Parker 的许可可以"预存"，先 unpark 后 park 不会丢。

```cpp
if (Thread::is_interrupted(thread, false)) return;
```

线程已经被中断——直接返回，不阻塞。

**慢速路径——进入 condvar 等待**：

```cpp
ThreadBlockInVM tbivm(jt);                    // 标记线程状态为 _thread_blocked
if (pthread_mutex_trylock(_mutex) != 0) return;  // 非阻塞拿锁，拿不到就返回
```

用 `trylock` 而不是 `lock`——避免持锁时被其他线程的 unpark 卡住。

```cpp
if (_counter > 0) {                           // 持锁后再次检查
  _counter = 0; pthread_mutex_unlock(_mutex); return;
}
```

防止 unpark 在 trylock 和 check 之间设置了许可。

```cpp
if (time == 0) {
  pthread_cond_wait(&_cond[REL_INDEX], _mutex);     // 无限等待
} else {
  pthread_cond_timedwait(&_cond[isAbsolute ? ABS_INDEX : REL_INDEX],
                         _mutex, &absTime);          // 带超时等待
}
_counter = 0;                                        // 醒来后清除许可
```

## unpark()——唤醒

`Unsafe_Unpark()`（`unsafe.cpp:960`）通过 `ThreadsListHandle` 找到目标线程的 `JavaThread` 对象（SMR 保护），取 `thr->parker()`，调 `p->unpark()`。Parker::unpark 的核心逻辑（`os_posix.cpp:2243`）：

```cpp
pthread_mutex_lock(_mutex);
_counter = 1;                             // 设置许可
int index = _cur_index;                   // 记录当前使用的 condvar 索引
pthread_mutex_unlock(_mutex);
```

释放锁之后才调 `pthread_cond_signal`——避免"无用唤醒"（唤醒后线程发现锁还占着又睡回去）。

```cpp
if (s < 1 && index != -1) {               // 旧 counter 是 0 且线程确实在 condvar 上等待
  pthread_cond_signal(&_cond[index]);
}
```

## 完整调用链

```
Java: LockSupport.park()
  → Unsafe.park()                [sun.misc.Unsafe]
    → Unsafe_Park()              [unsafe.cpp:939, JNI native]
      → thread->parker()->park() [park.hpp:65]
        → 快速路径: Atomic::xchg(0, &_counter) > 0 → 直接返回
        → 慢速路径: pthread_cond_wait/timedwait

Java: LockSupport.unpark(thread)
  → Unsafe.unpark(thread)        [sun.misc.Unsafe]
    → Unsafe_Unpark()            [unsafe.cpp:960, JNI native]
      → thr->parker()->unpark()  [park.hpp:66]
        → _counter = 1
        → pthread_cond_signal
```

## 生命周期

Parker 对象**从不被 delete**——线程退出后回收到全局 `FreeList` 链表中，下一个 `new JavaThread()` 时复用。`destroy()` 析构路径写 `ShouldNotReachHere()`——不真正析构。
