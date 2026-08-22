# 02 · 线程、Safepoint 与同步

> 目标：判断候选人是否理解 JVM 如何在不停机、可重入、可恢复的条件下协调线程。

## 1. Safepoint 为什么不是“VM 线程逐个通知 JavaThread”？

**主问题**

VM 线程要让全体 JavaThread 停下。为什么 HotSpot 主要改状态、设置计数器，再让线程自行经过 poll，而不是拿着锁逐个通知？

**必须回答**

- safepoint begin、线程到达、block、cleanup、end 的角色分工；
- `_safepoint_counter` 的不同消费者；
- Java、native、blocked、compiled frame 各自如何到达安全状态；
- 为什么结束 safepoint 依赖线程锁/状态放行，而不只是条件变量通知。

**追问**

1. 一个线程在 safepoint 请求前刚离开 Java 状态，怎样避免漏报？
2. 编译代码为什么需要 poll，解释器为什么天然有检查点？
3. 如果 poll 是全局页保护而不是 thread-local 状态，性能和信号语义会有什么变化？
4. safepoint 超时报告说明的是谁没有到达，还是谁到达后又重新进入？

**源码路线**

`SafepointSynchronize::begin` → `JavaThread::check_and_wait_while_safepoint` → `SafepointSynchronize::block` → `SafepointSynchronize::end`。

**反事实**

如果 VM 线程对每个 JavaThread 使用独立 mutex 通知，如何处理线程创建/退出、信号中断、持锁线程和 native transition？

## 2. Handshake 为什么不是“小号 safepoint”？

**主问题**

Handshake 也让线程执行 VM 请求。它为什么不直接复用 safepoint，而要维护单线程目标、SMR 线程列表和回调状态？

**必须回答**

- safepoint 的全局停顿与 handshake 的单线程安全回调差异；
- 发起者、目标线程、HandshakeState 的生命周期；
- 目标线程主动轮询与 VM/信号协助路径；
- ThreadsListHandle 为什么保护的是线程列表快照，而不是线程对象本身。

**追问**

1. 目标线程已经退出时，发起者如何判断请求是否完成？
2. 为什么 handshake 回调不能随意在发起者线程执行？
3. SMR 的保护范围如果缩短一行，最可能出现 use-after-free 还是丢请求？
4. 什么场景仍然必须使用 safepoint？

**源码路线**

`Handshake::execute` → `HandshakeState` → `ThreadsListHandle` → `JavaThread::handshake_process_by_self`。

**反事实**

如果所有单线程请求都改成 safepoint，正确性是否更简单？暂停延迟、吞吐和嵌套请求会怎样恶化？

## 3. JavaThread 状态为什么同时有“真实状态”和“过渡态”？

**主问题**

线程从 Java 进入 native，再回到 VM。为什么状态枚举要包含 `_thread_in_native_trans`、`_thread_in_vm_trans` 这类过渡态，而不是直接写最终状态？

**必须回答**

- transition 的观察者是谁；
- safepoint、handshake、JNI fast path 如何利用状态；
- “线程已经不执行 Java”与“线程已安全可观察”不是同一件事；
- 状态写入与 poll/lock 的顺序如何避免竞态。

**追问**

1. native 线程在 safepoint 请求期间返回 VM，在哪个时点必须重新检查？
2. `_thread_blocked` 为什么不能简单理解为“不占 CPU”？
3. 如果删掉 trans 状态，哪个观察窗口会变得不可表示？
4. JNI fast path 为什么关心 safepoint counter 而不是只读线程状态？

**源码路线**

`JavaThreadState` → `ThreadStateTransition` → `JavaThread::transition_from_native` → `SafepointSynchronize`/JNI fast path。

## 4. ObjectMonitor 为什么不能只是一个带 owner 的 mutex？

**主问题**

Java monitor 要支持 enter、竞争、wait、notify、退出和异常路径。为什么 HotSpot 需要 owner、entry list、wait set、recursion 等多套状态？

**必须回答**

- monitor ownership 与 entry queue/wait set 的区别；
- wait 会释放 owner，但保留重新竞争所需语义；
- notify 不是把线程直接变成 owner；
- 膨胀前的 mark word、displaced mark 与 ObjectMonitor 的交接。

**追问**

1. notify 后线程为什么仍然可能无法立即继续？
2. 线程在 wait 中抛出 InterruptedException 时，monitor 归属如何恢复？
3. 如果把 wait set 和 entry list 合并，会丢失哪条语义？
4. 为什么 monitor 的 native 生命周期不能只由 Java 对象引用计数管理？

**源码路线**

`ObjectSynchronizer::enter/exit` → `ObjectMonitor` → `wait/notify` → monitor deflation/cleanup。
