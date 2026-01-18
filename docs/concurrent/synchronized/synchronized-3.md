# Synchronized浅析（3）：park/unpark 与 Parker

> 虽然文章的命名是Synchronized浅析,但是实际上分析的是线程相关的一些行为,比如调用wait(),notify(),LockSupport.park()等等方法的行为
>
> 以下jvm的源码基于openjdk11
>



## 一：Parker和ParkEvent
这两个都是Hotspot JVM 用来实现线程同步和阻塞的两个核心内部类,通常用于线程的挂起与唤醒,但是设计目标与使用场景有所不同

### 1.Parker
数据结构

```cpp
// park.hpp
class Parker : public os::PlatformParker {
private:
  volatile int _counter;      // 许可计数器：0 或 1
  Parker * FreeNext;          // 空闲链表指针
  JavaThread * AssociatedWith; // 关联的 JavaThread
  
  static Parker * volatile FreeList;  // 全局空闲链表
  static volatile int ListLock;       // 链表锁
  
public:
  void park(bool isAbsolute, jlong time);  // 阻塞线程
  void unpark();                            // 唤醒线程
  static Parker * Allocate(JavaThread * t); // 分配
  static void Release(Parker * e);          // 释放
};
// 平台相关的 - 底层也是通过mutex来实现的
class PlatformParker : public CHeapObj<mtSynchronizer> {
protected:
  int _cur_index;              // 当前使用的条件变量索引: -1, 0, 1
  pthread_mutex_t _mutex[1];   // 互斥锁
  pthread_cond_t  _cond[2];    // 两个条件变量：[0]相对时间，[1]绝对时间
};
```

核心为_counter，其语义为：

+ _counter > 0 : 有许可,park()会立即返回
+ _counter = 0 : 没有许可证, park()会阻塞

这种特性导致：如果先调用了unpark()方法,那么会导致park()不会阻塞

+ 源码

park()

```java
// LockSupport.park()
public static void park(Object blocker) {
    Thread t = Thread.currentThread();
    setBlocker(t, blocker);
    UNSAFE.park(false, 0L);
    setBlocker(t, null);
}
```

```cpp
void Parker::park(bool isAbsolute, jlong time) {

  // 直接将 _counter属性设置为0,并且返回旧的_counter
  // 如果旧的 _counter > 0 , 那么说明之前存在许可(也即之前调用unpark()),那么直接返回
  // 否则说明之前没有许可,也即之前就是0「在这里将0设置为0没有问题」
  if (Atomic::xchg(0, &_counter) > 0) return;

  Thread* thread = Thread::current();
  JavaThread *jt = (JavaThread *)thread;

  // 如果当前线程已经被中断,那么直接返回,并且不清除中断标识
  if (Thread::is_interrupted(thread, false)) {
    return;
  }

  // Next, demultiplex/decode time arguments
  struct timespec absTime;
  if (time < 0 || (isAbsolute && time == 0)) { // don't wait at all
    return;
  }
  if (time > 0) {
    to_abstime(&absTime, time, isAbsolute);
  }

  // 构造时将线程的状态从 thread_in_vm 转化为 thread_in_blocked
  ThreadBlockInVM tbivm(jt);

  // 尝试获取锁,这里的锁就是在上面介绍的Parker中的_mutex属性,
  // 而Parker.unpark()在操作前也会获取这个锁,如果在这里tryLock()失败了,
  // 那么说明有别的线程在执行unpark()操作,此时直接返回即可(因为别的线程调用了unpark()了)
  if (Thread::is_interrupted(thread, false) ||
      pthread_mutex_trylock(_mutex) != 0) {
    return;
  }
  // 否则,到这里说明获取_mutex锁成功
  int status;
  // 再次判断_counter是否>0，为什么会出现这种情况呢？在 6 -> 32 行代码之前，
  // 别的线程可能已经执行unpark()成功了,所以即使上面tryLock()成功了,也需要再次判断一下
  if (_counter > 0)  { // no wait needed 
    // 从这里可以看到,许可证 只有 >0 和 =0 两种情况,不会因为调用了两次unpark()使得两次park()都不阻塞
    // 多次unpark()的效果相当于一次unpark()
    _counter = 0;
    status = pthread_mutex_unlock(_mutex); // 释放mutex锁
    assert_status(status == 0, status, "invariant");
    // Paranoia to ensure our locked and lock-free paths interact
    // correctly with each other and Java-level accesses.
    OrderAccess::fence();
    return; // 返回即可,没有阻塞
  }

  OSThreadWaitState osts(thread->osthread(), false /* not Object.wait() */);
  jt->set_suspend_equivalent();
  // 阻塞(可能是超时阻塞)
  assert(_cur_index == -1, "invariant");
  if (time == 0) {
    _cur_index = REL_INDEX; // arbitrary choice when not timed
    // 和Java的Condition一样,阻塞在条件变量上会释放锁, 被signal()唤醒时会重新获取锁
    // 所以在下面会看到释放_mutex的逻辑(但是没有看到获取_mutex的逻辑)
    status = pthread_cond_wait(&_cond[_cur_index], _mutex); 
    assert_status(status == 0 MACOS_ONLY(|| status == ETIMEDOUT),
                  status, "cond_wait");
  }
  else {
    _cur_index = isAbsolute ? ABS_INDEX : REL_INDEX;
    status = pthread_cond_timedwait(&_cond[_cur_index], _mutex, &absTime);
    assert_status(status == 0 || status == ETIMEDOUT,
                  status, "cond_timedwait");
  }
  _cur_index = -1;
  
  // 醒来后,依旧将_counter设置为0
  _counter = 0;
  status = pthread_mutex_unlock(_mutex); // 释放锁
  assert_status(status == 0, status, "invariant");
  // Paranoia to ensure our locked and lock-free paths interact
  // correctly with each other and Java-level accesses.
  OrderAccess::fence();

  // If externally suspended while waiting, re-suspend
  if (jt->handle_special_suspend_equivalent_condition()) {
    jt->java_suspend_self();
  }
}
```

unpark()

```java
public static void unpark(Thread thread) {
    if (thread != null)
        UNSAFE.unpark(thread);
}
```

```cpp
void Parker::unpark() {
  int status = pthread_mutex_lock(_mutex); // 获取_mutex锁
  assert_status(status == 0, status, "invariant");
  const int s = _counter;
  _counter = 1; // 将 _counter设置为1
  // must capture correct index before unlocking
  int index = _cur_index;
  status = pthread_mutex_unlock(_mutex); // 释放锁
  assert_status(status == 0, status, "invariant");

  if (s < 1 && index != -1) {
    // thread is definitely parked
    status = pthread_cond_signal(&_cond[index]); // 唤醒线程
    assert_status(status == 0, status, "invariant");
  }
}
```

这里为什么要先释放_mutex锁再进行唤醒呢? 在Java中一般的编程范式是怎么样的呢？

我们经常会强调要在finally{}块中释放（为了避免锁没有被正常释放），但是这里在signal()之后尽量避免做复杂的操作，因为await()内部线程在被唤醒之后,依然需要去竞争锁,如果获取不到,那么依然会重新去阻塞

> 这里已经回答了上面的问题了,也即为什么要先释放_mutex锁,再调用signal()来进行唤醒，这是为了避免无效的唤醒(无效的上下文切换)
>

```java
Thread t1 = new Thread(() -> {
    reentrantLock.lock();
    try {
        condition.await();
    } catch (InterruptedException e) {
        e.printStackTrace();
    } finally {
        reentrantLock.unlock();
    }

});
Thread t2 = new Thread(() -> {
    reentrantLock.lock();
    try {
        condition.signal(); // 先执行唤醒操作
        // don't do something
    } finally {
        reentrantLock.unlock(); // 在执行unlock() - 如果这里不及时unlock(),那么
    }
});
}

// 这种写法有没有搞头？
Thread t3 = new Thread(() -> {
    reentrantLock.lock();
    try {
        // to do something
    } finally {
        reentrantLock.unlock();
        condition.signal();
    }
});
```



---

### 2. ParkEvent
数据结构

```cpp
// park.hpp
class ParkEvent : public os::PlatformEvent {
private:
  ParkEvent* FreeNext;          // 空闲链表中的下一个
  Thread* AssociatedWith;       // 关联的线程

public:
  ParkEvent* volatile ListNext; // 在 ObjectMonitor 的 EntryList/WaitSet 中链接节点
  volatile intptr_t OnList;     // 是否在某个等待队列中
  volatile int TState;          // 用于 ObjectMonitor，标记线程状态（TS_CXQ, TS_ENTER, TS_WAIT 等）
  volatile int Notified;        // 是否被 notify
};


// 平台相关
class PlatformEvent : public CHeapObj<mtSynchronizer> {
private:
  double cachePad[4];        // 缓存行填充，避免伪共享
  volatile int _event;       // 事件状态/许可 三态信号量：-1(阻塞), 0(中立), 1(已唤醒) 【默认为0】
  volatile int _nParked;     // 是否有线程在等待
  pthread_mutex_t _mutex[1]; // POSIX 互斥锁
  pthread_cond_t  _cond[1];  // POSIX 条件变量
  double postPad[2];         // 缓存行填充
};

```

park()

```cpp
void os::PlatformEvent::park() {       // AKA "down()"
  // Transitions for _event:
  //   -1 => -1 : illegal 非法操作，已经在阻塞了,不能多次阻塞
  //    1 =>  0 : pass - return immediately 存在许可,直接返回,不会阻塞
  //    0 => -1 : block; then set _event to 0 before returning 无许可，阻塞

  int v;

  // atomically decrement _event 
  // cas的将 _event设置为 _event - 1
  for (;;) {
    v = _event; // 保存旧的 _event值
    if (Atomic::cmpxchg(v - 1, &_event, v) == v) break;
  }
  guarantee(v >= 0, "invariant");
  // 如果old _event = 0 ,那么代表之前没有许可,那么将会阻塞
  if (v == 0) { // Do this the hard way by blocking ...
    int status = pthread_mutex_lock(_mutex); // 获取锁
    ++_nParked; // 标记有线程等待
    while (_event < 0) { // 只要 < 0 ，那么就一直阻塞,需要使用while,避免伪唤醒
      // OS-level "spurious wakeups" are ignored
      status = pthread_cond_wait(_cond, _mutex);
      assert_status(status == 0 MACOS_ONLY(|| status == ETIMEDOUT),
                    status, "cond_wait");
    }
    // 没有线程在等待
    --_nParked;
    // 重置为中立状态
    _event = 0;
    status = pthread_mutex_unlock(_mutex); // 释放锁 
    OrderAccess::fence(); // 保证可见性
  }
  guarantee(_event >= 0, "invariant");
}
```

unpark()

```java
void os::PlatformEvent::unpark() {
    // 直接设置 _event的值为1,并且返回旧值,如果旧值为0/1,那么直接返回,说明没有线程在等待
    // 不需要执行唤醒操作
    if (Atomic::xchg(1, &_event) >= 0) return;  // 原值>=0，无线程等待
    // 原值是 -1，有线程在等待
    pthread_mutex_lock(_mutex);
    int anyWaiters = _nParked;
    pthread_mutex_unlock(_mutex);
    
    if (anyWaiters != 0) {
        pthread_cond_signal(_cond);  // 唤醒等待线程
    }
}
```

可以看到,这两个对象的阻塞/唤醒线程的原理本质上是一样的，都是通过pthread库来实现的，但是对于Java线程来说,Parker只有一个，而ParkEvent则有四个

```java
_ParkEvent = ParkEvent::Allocate(this);
_SleepEvent = ParkEvent::Allocate(this);
_MutexEvent = ParkEvent::Allocate(this);
_MuxEvent = ParkEvent::Allocate(this);
```



## 二：wait() 与 notify()
```java
public final native void wait(long timeout) throws InterruptedException;
public final native void notify();
{"wait",        "(J)V",                   (void *)&JVM_MonitorWait},
{"notify",      "()V",                    (void *)&JVM_MonitorNotify},
```

这两个方法都是native方法

### 1. wait()
> wait()和notify()的原理在之前的文章中讲解过，不过之前讲解的是基于jdk21的,这里是基于jdk11的
>

案例

```java
synchronized (lock){
    lock.wait(); // 相当于condition.await(),必须要在获取锁的前提下才能调用这个方法
}
```

```cpp
// synchronizer.cpp
int ObjectSynchronizer::wait(Handle obj, jlong millis, TRAPS) {
  // ... 不考虑偏向锁的逻辑
  // 等待的超时时间<0,抛出异常
  if (millis < 0) {
    TEVENT(wait - throw IAX);
    THROW_MSG_0(vmSymbols::java_lang_IllegalArgumentException(), "timeout value is negative");
  }
  /*
      获取锁对象的ObjectMonitor,如果锁对象此时处于轻量级锁(偏向锁),那么会主动膨胀为重量级锁
      因为wait()需要阻塞,需要等待队列,需要ObjectMonitor,而ObjectMonitor则是重量级锁时才会出现的对象
  */
  // 关于如何膨胀的,代码细节在另外一篇文章中,但是没必要深究了,看了也记不住的
  ObjectMonitor* monitor = ObjectSynchronizer::inflate(THREAD,
                                                       obj(),
                                                       inflate_cause_wait);

  DTRACE_MONITOR_WAIT_PROBE(monitor, obj(), THREAD, millis);
  monitor->wait(millis, true, THREAD);

  // This dummy call is in place to get around dtrace bug 6254741.  Once
  // that's fixed we can uncomment the following line, remove the call
  // and change this function back into a "void" func.
  // DTRACE_MONITOR_PROBE(waited, monitor, obj(), THREAD);
  return dtrace_waited_probe(monitor, obj, THREAD);
}
```

+ ObjectMonitor

这个对象非常重要（内部还有一个重要的类：ObjectWaiter - 等待节点）

> 在看Synchronized以及相关的方法时{比如wait()/notify()}时,会发现和JDK中的AQS/ReentrantLock/Condition很类似,这点其实也可以印证一个结论：高级语言中的锁其实就是管程的一种具体实现,遵循管程的模型
>

```cpp
class ObjectWaiter : public StackObj {
public:
  enum TStates { TS_UNDEF, TS_READY, TS_RUN, TS_WAIT, TS_ENTER, TS_CXQ };
  
  ObjectWaiter * volatile _next;      // 链表下一个
  ObjectWaiter * volatile _prev;      // 链表上一个
  Thread*       _thread;              // 关联的线程
  jlong         _notifier_tid;        // 通知者线程 ID
  ParkEvent *   _event;               // 用于阻塞/唤醒
  volatile int  _notified;            // 是否被 notify
  volatile TStates TState;            // 状态 - TS_READY/TS_RUN/TS_WAIT/TS_ENTER/TS_CXQ
};

// ObjectMonitor的核心属性 - 这里展示的只是核心属性,并且也只会讲解核心属性,
// 而一些用于其他优化的属性就不扩展了
/*
    这里就需要思考一个问题：从JDK的AQS来看,只需要一个入口队列和一个等待队列其实就可以实现管程模型了
    但是为什么这个结构需要有3个队列呢？该问题先保留在这里,先看下wait()方法都干了什么
*/ 
ObjectWaiter* volatile _EntryList;  // 等待获取锁的线程队列
ObjectWaiter* volatile _cxq;        // 竞争队列（新到达的线程）
ObjectWaiter* volatile _WaitSet;    // 调用 wait() 的线程队列
volatile jint _waiters;             // 等待线程数量
volatile int _WaitSetLock;          // 保护 WaitSet 的自旋锁

// 其他优化属性
Thread* volatile _succ;        // 假定继承者（Heir presumptive）
Thread* volatile _Responsible; // 负责线程
volatile int _Spinner;         // 自旋优化
volatile int _SpinDuration;    // 自旋持续时间
volatile jint _count;          // 引用计数，防止 deflation


```

wait()

```cpp
void ObjectMonitor::wait(jlong millis, bool interruptible, TRAPS) {
  Thread * const Self = THREAD;
  assert(Self->is_Java_thread(), "Must be Java thread!");
  JavaThread *jt = (JavaThread *)THREAD;

  DeferredInitialize();

  // Throw IMSX or IEX.
  CHECK_OWNER(); // 1. 验证当前线程是否是锁的持有者(这是调用wait()的前提)

  EventJavaMonitorWait event;

  // check for a pending interrupt
  // 2. 校验是否已经被中断了,如果在调用wait()前线程就已经被中断了,那么直接抛出异常,不需要阻塞
  // 也即wait()是响应中断的
  if (interruptible && Thread::is_interrupted(Self, true) && !HAS_PENDING_EXCEPTION) {
    // post monitor waited event.  Note that this is past-tense, we are done waiting.
    if (JvmtiExport::should_post_monitor_waited()) {
      // Note: 'false' parameter is passed here because the
      // wait was not timed out due to thread interrupt.
      JvmtiExport::post_monitor_waited(jt, this, false);
    }
    if (event.should_commit()) {
      post_monitor_wait_event(&event, this, 0, millis, false);
    }
    TEVENT(Wait - Throw IEX);
    THROW(vmSymbols::java_lang_InterruptedException());
    return;
  }

  TEVENT(Wait);  

  assert(Self->_Stalled == 0, "invariant");
  Self->_Stalled = intptr_t(this);
  jt->set_current_waiting_monitor(this);
  // 3. 创建等待节点
  ObjectWaiter node(Self);
  node.TState = ObjectWaiter::TS_WAIT; // 将节点的状态设置为TS_WAIT
  Self->_ParkEvent->reset(); //重置ParkEvent
  OrderAccess::fence();          // ST into Event; membar ; LD interrupted-flag

  // 锁保护
  Thread::SpinAcquire(&_WaitSetLock, "WaitSet - add");
  AddWaiter(&node); // 加入到_WAITSET中(也就是添加到等待队列中)
  Thread::SpinRelease(&_WaitSetLock);

  if ((SyncFlags & 4) == 0) {
    _Responsible = NULL;
  }
  intptr_t save = _recursions; // record the old recursion count
  _waiters++;                  // increment the number of waiters
  _recursions = 0;             // set the recursion level to be 1
  exit(true, Self);                    // exit the monitor 4.释放锁,确保其他线程能够正常的获取锁
  guarantee(_owner != Self, "invariant");


  int ret = OS_OK;
  int WasNotified = 0;
  { // State transition wrappers
    OSThread* osthread = Self->osthread();
    OSThreadWaitState osts(osthread, true);
    {
      ThreadBlockInVM tbivm(jt);
      // Thread is in thread_blocked state and oop access is unsafe.
      jt->set_suspend_equivalent();
      // 5.准备调用_parkEvent.park来进行阻塞,在这里再次校验是否被中断
      if (interruptible && (Thread::is_interrupted(THREAD, false) || HAS_PENDING_EXCEPTION)) {
        // Intentionally empty
      } else if (node._notified == 0) {
        if (millis <= 0) {
          Self->_ParkEvent->park();
        } else {
          ret = Self->_ParkEvent->park(millis);
        }
      }

      // were we externally suspended while we were waiting?
      if (ExitSuspendEquivalent (jt)) {
        // TODO-FIXME: add -- if succ == Self then succ = null.
        jt->java_suspend_self();
      }

    } // Exit thread safepoint: transition _thread_blocked -> _thread_in_vm
    // 被唤醒后需要将自己从 _waitset集合中移除(在这里应该是中断或者超时引起的)
    // 否则应该是在_cxq或者在_entryList中(被notify()移动的)
    if (node.TState == ObjectWaiter::TS_WAIT) {
      Thread::SpinAcquire(&_WaitSetLock, "WaitSet - unlink");
      if (node.TState == ObjectWaiter::TS_WAIT) {
        DequeueSpecificWaiter(&node);       // unlink from WaitSet
        assert(node._notified == 0, "invariant");
        node.TState = ObjectWaiter::TS_RUN; // 更新为TS_RUN
      }
      Thread::SpinRelease(&_WaitSetLock);
    }

    guarantee(node.TState != ObjectWaiter::TS_WAIT, "invariant");
    OrderAccess::loadload();
    if (_succ == Self) _succ = NULL;
    WasNotified = node._notified;

    if (JvmtiExport::should_post_monitor_waited()) {
      JvmtiExport::post_monitor_waited(jt, this, ret == OS_TIMEOUT);
      if (node._notified != 0 && _succ == Self) {
        node._event->unpark();
      }
    }

    if (event.should_commit()) {
      post_monitor_wait_event(&event, this, node._notifier_tid, millis, ret == OS_TIMEOUT);
    }

    OrderAccess::fence();

    assert(Self->_Stalled != 0, "invariant");
    Self->_Stalled = 0;

    assert(_owner != Self, "invariant");
    ObjectWaiter::TStates v = node.TState;
    // 6. 重新获取锁 - 分为两种情况「1.被中断或者超时,那么走enter()，否则是被notify()的,走ReenterI()」
    // 为什么说enter()是慢速操作,而ReenterI()是快速操作呢？
    if (v == ObjectWaiter::TS_RUN) {
      enter(Self);
    } else {
      guarantee(v == ObjectWaiter::TS_ENTER || v == ObjectWaiter::TS_CXQ, "invariant");
      ReenterI(Self, &node);
      node.wait_reenter_end(this);
    }

    // Self has reacquired the lock.
    // Lifecycle - the node representing Self must not appear on any queues.
    // Node is about to go out-of-scope, but even if it were immortal we wouldn't
    // want residual elements associated with this thread left on any lists.
    guarantee(node.TState == ObjectWaiter::TS_RUN, "invariant");
    assert(_owner == Self, "invariant");
    assert(_succ != Self, "invariant");
  } // OSThreadWaitState()

  jt->set_current_waiting_monitor(NULL);

  guarantee(_recursions == 0, "invariant");
  _recursions = save;     // restore the old recursion count
  _waiters--;             // decrement the number of waiters

  // Verify a few postconditions
  assert(_owner == Self, "invariant");
  assert(_succ != Self, "invariant");
  assert(((oop)(object()))->mark() == markOopDesc::encode(this), "invariant");

  if (SyncFlags & 32) {
    OrderAccess::fence();
  }

  // check if the notification happened
  if (!WasNotified) {
    // no, it could be timeout or Thread.interrupt() or both
    // check for interrupt event, otherwise it is timeout
    if (interruptible && Thread::is_interrupted(Self, true) && !HAS_PENDING_EXCEPTION) {
      TEVENT(Wait - throw IEX from epilog);
      THROW(vmSymbols::java_lang_InterruptedException());
    }
  }

  // NOTE: Spurious wake up will be consider as timeout.
  // Monitor notify has precedence over thread interrupt.
}
```

核心工作原理：和JDK中的Condition是十分类似的

**检查当前线程是否持有锁 -> 检查中断 -> 创建等待节点 - > 添加到等待队列 -> 释放synchronized锁 -> 阻塞**

简易模型如下：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NDhjNjM2NmQ3NWUyZjY0ZTRmNjg3N2JjMDU4YzY4MzlfNXZ4b29DbDZXUEhZS0E3bDBMNGV4b29nR0ZYR2xweTFfVG9rZW46U1lDVWJ4VUdob3ZPNzh4QjNWQ2MwZ1FtbnBQXzE3Njg2NTYyNDY6MTc2ODY1OTg0Nl9WNA)

### 2. notify()
```cpp
// objectMonitor.cpp
void ObjectMonitor::notify(TRAPS) {
  CHECK_OWNER(); // 检查是否持有锁
  // 如果_waitSet中没有等待节点,那么直接返回
  // 为什么_waitSet为空就不唤醒了呢？在_cxq/_entryList中的等待节点不去唤醒了吗？
  // 这里需要注意的是:在前面的文章中讲过,notify()遵循的是MESA管程模型,
  // notify()的职责就是将位于等待队列中的等待节点移动到入口队列中去
  // 而入口队列中阻塞的线程则是由ReentrantLock.unlock()或者monitorExit来唤醒
  if (_WaitSet == NULL) { 
    TEVENT(Empty-Notify);
    return;
  }
  DTRACE_MONITOR_PROBE(notify, this, object(), THREAD);
  INotify(THREAD); // 核心方法
  OM_PERFDATA_OP(Notifications, inc(1));
}

// INotify()
void ObjectMonitor::INotify(Thread * Self) {
  const int policy = Knob_MoveNotifyee;  // 策略配置，默认为 2

  // 获取 WaitSet 自旋锁
  Thread::SpinAcquire(&_WaitSetLock, "WaitSet - notify");
  
  // 从 WaitSet 头部取出一个等待者
  ObjectWaiter * iterator = DequeueWaiter();
  
  if (iterator != NULL) {
    // 设置通知标记
    iterator->_notified = 1;
    iterator->_notifier_tid = JFR_THREAD_ID(Self);  // 记录通知者线程ID
    
    // 根据策略将节点移动到不同位置
    // ...（见下面的策略分析）
  }
  
  Thread::SpinRelease(&_WaitSetLock);
}

// 默认策略
if (policy == 2) {
  if (list == NULL) {// EntryList 为空，直接放入 EntryList
    iterator->_next = iterator->_prev = NULL;
    _EntryList = iterator;
  } else {
    // EntryList 不为空，CAS 入队到 cxq 头部
    iterator->TState = ObjectWaiter::TS_CXQ;
    for (;;) {
      ObjectWaiter * front = _cxq;
      iterator->_next = front;
      if (Atomic::cmpxchg(iterator, &_cxq, front) == front) {
        break;
      }
    }
  }
}

```

在这里notify()会根据不同的策略来进行不同的处理

也即：**如果EntryList为空,那么放入到EntryList,否则EntryList不为空,那么CAS到_cxq的头部**

那么锁释放的逻辑是如何处理呢？在这里也有策略

逻辑为：**如果_entryList不为空,那么首先尝试唤醒_entryList的head节点，否则检查_cxq,如果不为空,那么将_cxq中所有节点批量的移动到_entryList中,然后唤醒_entryList的头节点**

```cpp
// 1. 先尝试从 EntryList 唤醒
w = _EntryList;
if (w != NULL) {
  ExitEpilog(Self, w);  // 唤醒 EntryList 头部
  return;
}

// 2. EntryList 为空，检查 cxq
w = _cxq;
if (w == NULL) continue;  // 都为空，重试

// 3. 批量转移：detach 整个 _cxq
for (;;) {
  ObjectWaiter * u = Atomic::cmpxchg((ObjectWaiter*)NULL, &_cxq, w);
  if (u == w) break;
  w = u;
}

// 4. 将单向链表转为双向链表，放入 EntryList
_EntryList = w;
ObjectWaiter * q = NULL;
for (ObjectWaiter * p = w; p != NULL; p = p->_next) {
  p->TState = ObjectWaiter::TS_ENTER;  // 状态改为 TS_ENTER
  p->_prev = q;                         // 建立 prev 指针
  q = p;
}

// 5. 唤醒 EntryList 头部
w = _EntryList;
if (w != NULL) {
  ExitEpilog(Self, w);
  return;
}

```

那么在这里为什么要有_cxq和_entryList呢？使用一个也可以,核心还是为了提高性能，将入队操作和出队操作分离，只有持有锁的线程才会去执行出队操作(通常是释放锁的线程),没有并发问题



## 三：中断原理
```java
thread.interrupt(); // 中断线程 
thread.isInterrupted(); // 判断线程是否被中断 - 不清除中断标识符
Thread.interrupted(); // 判断线程是否被中断 - 清除中断标识符
```

### 1. interrupt
```java
public void interrupt() {
    // thread may be blocked in an I/O operation
    /*
        处理可中断的IO操作,这个就是blocker的作用,因为普通的中断操作
        只会影响到wait()/sleep()/park(),
        而对于阻塞的IO操作,比如read()/write()/...等操作则不起作用
        需要通过blocker.interrupt()来进行操作（通过关闭channel,从而中断IO操作）
        在这里先不关系IO操作,后续学习NIO的时候会讲解
    */
    synchronized (blockerLock) {
        Interruptible b = blocker;
        if (b != null) {
            interrupt0();  // set interrupt status
            b.interrupt(this);
            return;
        }
    }
}
    // set interrupt status  这里是普通流程,看这里就行
    interrupt0();
}

// native方法
private native void interrupt0();
```

+ interrupt0()

```cpp
// os_posix.cpp
void os::interrupt(Thread* thread) {
  // 获取当前线程所关联的OSThread对象 
  OSThread* osthread = thread->osthread();
  // volatile bool interrupted() const                 { return _interrupted != 0; }
  // 这个属性非常重要,在这里判断线程是否已经中断了,当然这里默认为0（也就是没被中断）
  if (!osthread->interrupted()) {
    // 在这里设置为true(本质上是将 _interrupted 属性设置为1)
    osthread->set_interrupted(true);
    OrderAccess::fence(); // 保证可见性(为什么c++中加了volatile,还需要加内存屏障来保证可见性呢？)
    ParkEvent * const slp = thread->_SleepEvent ; // 如果线程正在阻塞在sleep()上,那么唤醒
    if (slp != NULL) slp->unpark() ;
  }

  // For JSR166. Unpark even if interrupt status already was set
  // 如果线程阻塞在LockSupport.park()，那么唤醒
  if (thread->is_Java_thread())
    ((JavaThread*)thread)->parker()->unpark();
  // 如果阻塞在wait()/synchronized失败，那么唤醒
  ParkEvent * ev = thread->_ParkEvent ;
  if (ev != NULL) ev->unpark() ;
}
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YTUxOWE3Y2QwNjhjYTNkNjZhZDFhZWQ4ODYyZDk3ODNfM2w3aXVWUzRnU2o1SjhZUFJncUJ5cUkzaTBpSUJ2Y2xfVG9rZW46SFlaZGJNV3pFb3AzUkt4a2xPaGNuWmoyblN4XzE3Njg2NTYyNDY6MTc2ODY1OTg0Nl9WNA)

### 2. thread.isInterrupted()
```java
public boolean isInterrupted() {
    return isInterrupted(false);
}

// Thread.interrupted()
public static boolean interrupted() {
    return currentThread().isInterrupted(true);
}

// focus
private native boolean isInterrupted(boolean ClearInterrupted);
```

这两个方法最终调用的方法都是一样的,不过是传入的参数不同,一个是false,一个是true

> 原理很简单,不再赘述
>

```cpp
bool os::is_interrupted(Thread* thread, bool clear_interrupted) {
  // 获取线程对应的OSThread对象
  OSThread* osthread = thread->osthread();
  // 获取线程的中断标识
  bool interrupted = osthread->interrupted();
  // 如果被中断了 & 需要清除中断标识,那么将 _interrupted 设置为0
  if (interrupted && clear_interrupted) {
    osthread->set_interrupted(false);
    // consider thread->_SleepEvent->reset() ... optional optimization
  }
  // 返回
  return interrupted;
}
```



## 四：sleep()
### 1. sleep()
```java
Thread.sleep(12)
public static native void sleep(long millis) throws InterruptedException;
```

```cpp
JVM_ENTRY(void, JVM_Sleep(JNIEnv * env, jclass threadClass, jlong millis))
    JVMWrapper("JVM_Sleep");
    // 如果要睡眠的时间<0,抛出异常
    if (millis < 0) {
        THROW_MSG(vmSymbols::java_lang_IllegalArgumentException(), "timeout value is negative");
    }
    // 线程已经被中断（这里会清除中断标识）& 没有需要处理的异常 ， 那么抛出异常
    if (Thread::is_interrupted(THREAD, true) && !HAS_PENDING_EXCEPTION) {
        THROW_MSG(vmSymbols::java_lang_InterruptedException(), "sleep interrupted");
    }

    // Save current thread state and restore it at the end of this block.
    // And set new thread state to SLEEPING.
    // 构造时设置SLEEPING状态，析构时自动恢复
    JavaThreadSleepState jtss(thread);

    HOTSPOT_THREAD_SLEEP_BEGIN(millis);
    EventThreadSleep event;
    // 如果要睡眠的时间 = 0，那么相当于调用yield()
    if (millis == 0) {
        os::naked_yield();
    } else {
        // 保存并设置OS线程状态
        ThreadState old_state = thread->osthread()->get_state();
        thread->osthread()->set_state(SLEEPING);
        // 调用os::sleep进行阻塞 - 核心方法
        if (os::sleep(thread, millis, true) == OS_INTRPT) {
            // An asynchronous exception (e.g., ThreadDeathException) could have been thrown on
            // us while we were sleeping. We do not overwrite those.
            if (!HAS_PENDING_EXCEPTION) {
                if (event.should_commit()) {
                    post_thread_sleep_event(&event, millis);
                }
                HOTSPOT_THREAD_SLEEP_END(1);

                // TODO-FIXME: THROW_MSG returns which means we will not call set_state()
                // to properly restore the thread state.  That's likely wrong.
                THROW_MSG(vmSymbols::java_lang_InterruptedException(), "sleep interrupted");
            }
        }
        // 恢复OS线程状态
        thread->osthread()->set_state(old_state);
    }
    if (event.should_commit()) {
        post_thread_sleep_event(&event, millis);
    }
    HOTSPOT_THREAD_SLEEP_END(0);
JVM_END
```

+ os::slepp()

核心原理其实就是调用parkEvent.park()方法，只不过这里调用的是SleepEvent

```cpp
int os::sleep(Thread* thread, jlong millis, bool interruptible) {
  assert(thread == Thread::current(),  "thread consistency check");
  // 获取专门用于Sleep的"ParkEvent" - SleepEvent
  ParkEvent * const slp = thread->_SleepEvent ;
  slp->reset() ;
  OrderAccess::fence() ;
  // 如果需要清除中断标识位
  if (interruptible) {
    jlong prevtime = javaTimeNanos();
    // 避免虚假唤醒
    for (;;) {
      if (os::is_interrupted(thread, true)) { // 如果已经被中断,那么返回 OS_INTRPT
        return OS_INTRPT;
      }

      jlong newtime = javaTimeNanos();

      if (newtime - prevtime < 0) {
        // time moving backwards, should only happen if no monotonic clock
        // not a guarantee() because JVM should not abort on kernel/glibc bugs
        assert(!os::supports_monotonic_clock(), "unexpected time moving backwards detected in os::sleep(interruptible)");
      } else {
        millis -= (newtime - prevtime) / NANOSECS_PER_MILLISEC;
      }

      if (millis <= 0) {
        return OS_OK;
      }

      prevtime = newtime;

      {
        assert(thread->is_Java_thread(), "sanity check");
        JavaThread *jt = (JavaThread *) thread;
        ThreadBlockInVM tbivm(jt);
        OSThreadWaitState osts(jt->osthread(), false /* not Object.wait() */);

        jt->set_suspend_equivalent();
        // cleared by handle_special_suspend_equivalent_condition() or
        // java_suspend_self() via check_and_wait_while_suspended()
        // 同样调用的是 ParkEvent.park()方法
        slp->park(millis);

        // were we externally suspended while we were waiting?
        jt->check_and_wait_while_suspended();
      }
    }
  } else {
    OSThreadWaitState osts(thread->osthread(), false /* not Object.wait() */);
    jlong prevtime = javaTimeNanos();

    for (;;) {
      // It'd be nice to avoid the back-to-back javaTimeNanos() calls on
      // the 1st iteration ...
      jlong newtime = javaTimeNanos();

      if (newtime - prevtime < 0) {
        // time moving backwards, should only happen if no monotonic clock
        // not a guarantee() because JVM should not abort on kernel/glibc bugs
        assert(!os::supports_monotonic_clock(), "unexpected time moving backwards detected on os::sleep(!interruptible)");
      } else {
        millis -= (newtime - prevtime) / NANOSECS_PER_MILLISEC;
      }

      if (millis <= 0) break ;

      prevtime = newtime;
      slp->park(millis); // 同样的调用park()方法
    }
    return OS_OK ;
  }
}
```

那么从这里看来,java中的sleep()方法并没有调用到linux内核中的sleep()系统调用

> 我之前一直以为都是调用了sleep()系统调用的
>

### 2. yield()
直接调用linux系统调用 yield()

```cpp
JVM_ENTRY(void, JVM_Yield(JNIEnv * env, jclass threadClass))
    JVMWrapper("JVM_Yield");
    if (os::dont_yield()) return;
    HOTSPOT_THREAD_YIELD();
    os::naked_yield();
JVM_END

// 直接调用系统调用
void os::naked_yield() {
    sched_yield();
}
```
