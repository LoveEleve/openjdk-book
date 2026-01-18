# Synchronized浅析（2）：wait/notify 与等待队列

> 以下源码基于hotspot21
>

在上一篇文章中,对synchronized的核心原理已经简单的介绍了一下，但是还有一个问题没有解决，那就是没看到等待队列，这篇文章就来简单的探索一下synchronized中的等待队列(条件队列)

```java
// 首先回顾一下ReentrantLock的条件变量的使用
public class ConditionalDemo {
    public static void main(String[] args) {
        ReentrantLock lock = new ReentrantLock();
        Condition condition = lock.newCondition();
      //  lock.lock();
        try {
            condition.await(); 
        } catch (InterruptedException e) {
            e.printStackTrace();
        } finally {
            lock.unlock();
        }
    }
}
// 如果直接运行这段代码,会抛出IllegalMonitorStateException这个异常
```

很明显,使用条件变量的一个前提就是已经获取到锁了

> 这也很好理解,条件变量的初衷就是:**当线程获取到锁后**,发现继续往下执行的条件不满足了,然后阻塞在条件变量上
>

那么在这里synchronized也是同理

```java
public static void main(String[] args) throws InterruptedException {
    Object lock = new Object();
    Object condition = new Object();
    synchronized (lock){
        /**
         * if 条件不满足,等待,注意,这里必须等待在锁对象上,换句话说,锁对象本身就充当了条件变量
         * condition.wait() - 将会抛出异常
         */
        lock.wait();
    }
}
```

那么下面就进入到Object.wait()的原理介绍中

```java
public final void wait() throws InterruptedException {
    wait(0L);
}
// 最终会调用到native方法(这是由jvm实现的)
private final native void wait0(long timeoutMillis) throws InterruptedException;
```

> 在上篇篇文章中其实就已经提到过等待队列,其位于ObjectMonitor#waitSet属性中,这代表了什么？  
代表了当调用wait()时,需要用到ObjectMonitor,这就会导致原本是轻量级锁,但是主动膨胀为重量级锁(注意这里是持有轻量级锁的线程主动膨胀为重量级锁)
>



```cpp
// hotspot/share/runtime/synchronizer.cpp
// -----------------------------------------------------------------------------
//  Wait/Notify/NotifyAll
// NOTE: must use heavy weight monitor to handle wait() 注释也说明了必须使用重量级锁
/*
    Handle obj：要等待的对象的handle包装
    millis:等待时间
*/
int ObjectSynchronizer::wait(Handle obj, jlong millis, TRAPS) {
  JavaThread* current = THREAD; // 当前的线程对象
  // 必须膨胀为重量级锁,如果已经是重量级锁了,那么就直接返回已有的ObjectMonitor即可
  ObjectMonitor* monitor = inflate(current, obj(), inflate_cause_wait);
  // 调用ObjectMonitor.wait()方法 - true代表可以被中断
  monitor->wait(millis, true, THREAD); // Not CHECK as we need following code
  return ret_code;
}

// monitor->wait(millis, true, THREAD)
void ObjectMonitor::wait(jlong millis, bool interruptible, TRAPS) {
    JavaThread* current = THREAD;
    /*
        提前中断校验
         - interruptible：允许被中断
         - current->is_interrupted(true)：校验当前线程是否已经被中断(true)
             - 那么直接抛出异常 #1 验证
    */
    if (interruptible && current->is_interrupted(true) && !HAS_PENDING_EXCEPTION) {
        THROW(vmSymbols::java_lang_InterruptedException());
        return;
    }
    // 设置当前线程正在等待的监视器（就是当前锁对象）
    current->set_current_waiting_monitor(this);
    // 创建等待线程节点,并且节点的状态为TS_WAIT
    ObjectWaiter node(current);
    node.TState = ObjectWaiter::TS_WAIT;
    current->_ParkEvent->reset();
    OrderAccess::fence();          // ST into Event; membar ; LD interrupted-flag
    /*
        有个疑问：只有持有锁的线程才能调用wait()/notify()，
        那么这里为什么对waitSet的操作还需要自旋锁来保护呢?
        并发场景是什么呢？ --> wait(time)
        当超时阻塞时,线程唤醒后会将自己从WaitSet中移除,此时存在并发操作
    */
    Thread::SpinAcquire(&_WaitSetLock, "WaitSet - add");
    /*
        将等待节点(ObejctWaiter)添加到WaitSet的尾部
        并且这个WaitSet是一个循环双向链表,如果只有一个等待节点,那么该节点的prev和next都是指向自己的
    */
    AddWaiter(&node);
    Thread::SpinRelease(&_WaitSetLock);
    ntx save = _recursions;     // record the old recursion count
    _waiters++;                  // increment the number of waiters
    _recursions = 0;             // set the recursion level to be 1
    exit(current);               // exit the monitor 释放锁(此时其他线程可以竞争锁/当前线程唤醒_entryList中的等待节点)
    int ret = OS_OK;
    int WasNotified = 0;
    // 再次判断当前线程是否已经被中断
    bool interrupted = interruptible && current->is_interrupted(false);
    {
        if (interrupted || HAS_PENDING_EXCEPTION) {
        // Intentionally empty
        } else if (node._notified == 0) {
        if (millis <= 0) {
          current->_ParkEvent->park(); // 阻塞
        } else {
          ret = current->_ParkEvent->park(millis);
        }
        }        
    }
    
}

```

验证#1

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MjdlZTE5Nzk1MGM1ZWFjODRkMTcxYTI3YTBmN2JmMWZfdkpiSUlWS0V5Z29CQlFHbG1jaWF3ZXBwTnJWdWNMTXBfVG9rZW46R1RGaWJPRmFub1BUYWR4eDBuMmN3S0ZBbndmXzE3Njg2NTYyMzY6MTc2ODY1OTgzNl9WNA)

此时当前线程(线程节点就阻塞在了ObjectMonitor中的waitSet链表中了),并且也是通过ParkEvent来进行阻塞的

验证WaitSet

```java
public class ConditionalDemo {
    public static void main(String[] args) throws InterruptedException {
        Object lock = new Object();
        Object condition = new Object();
        Thread thread = new Thread(() -> {
            synchronized (lock){
                try {
                    lock.wait();
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        }, "thread-1");
        thread.start();
        Tools.sleep(3);
        if (thread.getState() == Thread.State.WAITING){
            System.out.println(ClassLayout.parseInstance(lock).toPrintable());
        }
        thread.join();

    }
}

//out put
  0   8        (object header: mark)     0x00007fdec8000ff2 (fat lock: 0x00007fdec8000ff2)
```

此时的结构如下：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=Njc5Y2M3NWEyZDI0NGVlMGMwZDEwOGY1ZDg0ZThhZWZfeTNrY0NRd3VVR0dYYlN5bHVXdVJQeWFYa2o3enhqUXJfVG9rZW46WjM2Z2JkUmxmbzF0WUp4U3VPM2M5aW9tbnlmXzE3Njg2NTYyMzY6MTc2ODY1OTgzNl9WNA)

符合预期

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YTkzNTcyNjM4YWE1MGM5YzkyNTk1NDg2MjJjMDFlMDBfdWF2dGxSMDdvZGxPNFdTdlNvYnVpUG80WU5XUFlQQVdfVG9rZW46VnMyVmJWOXE5b0R2SFJ4OVVmTGNBVmhSbkFlXzE3Njg2NTYyMzY6MTc2ODY1OTgzNl9WNA)

下面再来看下唤醒的操作：object.notify()

```cpp
// native方法
public final native void notify();
JVM_ENTRY(void, JVM_MonitorNotify(JNIEnv* env, jobject handle))
  Handle obj(THREAD, JNIHandles::resolve_non_null(handle));
  ObjectSynchronizer::notify(obj, CHECK);
JVM_END

// ObjectSynchronizer::notify(obj, CHECK)
void ObjectSynchronizer::notify(Handle obj, TRAPS) {
  JavaThread* current = THREAD; // 获取当前线程对象
  markWord mark = obj->mark(); // 获取对象头
  if (LockingMode == LM_LIGHTWEIGHT) {
   // .. 新轻量级锁的实现 ..
  } 
  /*
      优化操作:
          - mark.has_locker()：是否是轻量级锁
          - current->is_lock_owned((address)mark.locker()：当前线程是否持有锁
      如果这两个都满足,那么notify可以直接返回,因为一定没有等待节点在waitSet中
      (如果有,那么此时一定是重量级锁了，也即mark.has_locker()会返回false)
  */
  else if (LockingMode == LM_LEGACY) {
    if (mark.has_locker() && current->is_lock_owned((address)mark.locker())) {
      // Not inflated so there can't be any waiters to notify.
      return;
    }
  }
  // 否则,同样获得已经存在的ObjectMonitor对象(锁对象对应的ObjectMonitor)
  // The ObjectMonitor* can't be async deflated until ownership is
  // dropped by the calling thread.
  ObjectMonitor* monitor = inflate(current, obj(), inflate_cause_notify);
  monitor->notify(CHECK);
}

// monitor->notify(CHECK)
void ObjectMonitor::notify(TRAPS) {
  JavaThread* current = THREAD;
  if (_WaitSet == nullptr) { // 如果_waitSet为nullptr,那么直接返回
    return;
  }
  INotify(current);
}

// INotify(current)
void ObjectMonitor::INotify(JavaThread* current) {
  Thread::SpinAcquire(&_WaitSetLock, "WaitSet - notify");
  // 从_waitSet(双向循环链表)中弹出第一个元素(等待节点)
  ObjectWaiter* iterator = DequeueWaiter();
  // 如果不为空
  if (iterator != nullptr) {
      // 将等待节点的状态从TS_WAIT -> TS_ENTER (这代表即将要插入到_entryList)
      iterator->TState = ObjectWaiter::TS_ENTER;
      ObjectWaiter* list = _EntryList;
  /*
      调用wait()阻塞的线程,会被放到不同入口队列中
          - _entryList = nullptr:那么当前线程等待节点作为唯一节点插入到_entryList中
          - _entryList != nullptr:那么当前节点cas的插入到_cxq队列中
  */
  if (list == nullptr) {
  iterator->_next = iterator->_prev = nullptr;
  _EntryList = iterator;
  }else{
    iterator->TState = ObjectWaiter::TS_CXQ;
      for (;;) {
        ObjectWaiter* front = _cxq;
        iterator->_next = front;
        if (Atomic::cmpxchg(&_cxq, front, iterator) == front) {
          break;
        }
      }
  }
 iterator->wait_reenter_begin(this);      
  }
  Thread::SpinRelease(&_WaitSetLock);
}
```

到这里,notify()就结束了,可以看到该方法并没有唤醒线程,它只是将线程等待节点从_waitSet(等待队列/条件队列)移动到入口队列(_entryList/_cxq)中，并没有真正的将线程唤醒

> ReentrantLock#Condition也是这样的做法,为什么呢？因为唤醒根本没有意义啊,此时的锁还被当前执行唤醒动作的线程拿着呢,就算唤醒了也一定抢不到锁(因为当前线程还没有释放呢)
>
> 并且也可以知道:synchronized和reentrantLock都是经典的MESA管程模型的一种具体实现「也即在条件满足时(signal())不会立即唤醒线程，而是将等待节点从条件队列移动到入口队列」
>

下面来验证一下：

```java
public class Test_2 {
    public static void main(String[] args) throws InterruptedException {
        Object lock = new Object();
        Thread thread_1 = new Thread(()->{
            synchronized (lock){
                try {
                    System.out.println("thread-1 wait");
                    lock.wait();
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                }
            }
        });
        thread_1.start();
        Tools.sleep(3);
        Thread thread_2 = new Thread(()->{
            synchronized (lock){
                System.out.println("thread-2 get the lock and notify but not release");
                lock.notify();
                System.out.println(ClassLayout.parseInstance(lock).toPrintable());
                Tools.readLine();
            }
        });
        thread_2.start();
        thread_2.join();
    }
}
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MTQxZmRkOTA1OTc1MzBiZGUxYTJhZDRlODZhM2E4YTBfZFVwYUtmbVVaZnZCV3BuRUVORElRazFnbHpTTFBoYlJfVG9rZW46QTV4amJPcG9ob01WY3l4ODY5dmM3N2lRbkxnXzE3Njg2NTYyMzY6MTc2ODY1OTgzNl9WNA)

现在回过头再来看下,当wait()被唤醒后的处理

```cpp
{
    {
      ClearSuccOnSuspend csos(this);
      ThreadBlockInVMPreprocess<ClearSuccOnSuspend> tbivs(current, csos, true /* allow_suspend */);
      if (interrupted || HAS_PENDING_EXCEPTION) {
        // Intentionally empty
      } else if (node._notified == 0) {
        if (millis <= 0) {
          current->_ParkEvent->park();
        } else {
          ret = current->_ParkEvent->park(millis);
        }
      }
    }
    // .... 当在上面被唤醒后,就会继续执行下面的代码
    
    /*
        这里针对的场景是超时阻塞 - park(time)
        这种场景下,线程唤醒后需要直接从_waitSet中移除
    */
    if (node.TState == ObjectWaiter::TS_WAIT) {
      Thread::SpinAcquire(&_WaitSetLock, "WaitSet - unlink");
      if (node.TState == ObjectWaiter::TS_WAIT) {  
        DequeueSpecificWaiter(&node);       // unlink from WaitSet
        node.TState = ObjectWaiter::TS_RUN;
        }
          Thread::SpinRelease(&_WaitSetLock);
    }
     OrderAccess::loadload();
    if (v == ObjectWaiter::TS_RUN) {
      enter(current); 
    }else { // 这个是通常情况,此时线程节点已经在_entryList/_cxq中来
      ReenterI(current, &node); // 最终会再次阻塞
      node.wait_reenter_end(this);
    }
}

// ReenterI(current, &node)
void ObjectMonitor::ReenterI(JavaThread* current, ObjectWaiter* currentNode) {

    for (;;) {
        ObjectWaiter::TStates v = currentNode->TState;
        //阻塞前的自旋优化
        if (TryLock(current) > 0) break;
        if (TrySpin(current) > 0) break;
        //还是没有获取到锁
        current->_ParkEvent->park();
        // 醒来后,继续尝试获取锁
        if (TryLock(current) > 0) break;
    }
    // 获取锁成功后,将当前线程等待节点从_entryList/_cxq中移除
    UnlinkAfterAcquire(current, currentNode);
    currentNode->TState = ObjectWaiter::TS_RUN; // 更新状态
    OrderAccess::fence(); 
}

```
