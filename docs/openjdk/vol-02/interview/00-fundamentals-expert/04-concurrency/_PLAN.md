# 04-concurrency · 线程、锁与并发

## 覆盖域（vol-02）

`05-cpu-primitives`（Atomic/OrderAccess）、`17-threads`（Thread 层次/状态/Handshake）、`19-sync`（ObjectMonitor/锁层次）、`16-jmm-varhandle`（intervie 域）、`02-thread-safepoint`（intervie 域）

## 题目清单

1. `synchronized` 和 `volatile` 的区别？——volatile 靠 storeload 屏障（x86 上 `lock addl`）；synchronized 靠 ObjectMonitor/轻量锁；偏向锁版本变化
2. 什么是死锁？如何检测？——wait-for graph 有环；`findDeadlockedThreads`/jstack 找环
3. 什么是内存屏障？JMM 为什么需要？——`OrderAccess` 四屏障；x86 TSO 只需 storeload；ARM 需 acquire/release
4. 偏向锁的版本变化？——JDK 8 默认开启 → JDK 15 默认禁用 → JDK 18 移除
5. 什么是 CAS？ABA 问题？——`Atomic::cmpxchg` → `lock cmpxchg`；ABA 用 `AtomicStampedReference`；x86 上 CAS 自带全屏障
6. 锁升级过程（无锁→偏向→轻量→重量）？——mark word 逐级变化；`BasicLock` 栈存 displaced mark；`ObjectMonitor` 膨胀；INFLATING 哨兵
7. 什么是 ThreadLocal？为什么可能内存泄漏？——`ThreadLocalMap` 弱引用 key；`Entry` 不可达但 value 不回收；`remove()` 的重要性
8. 线程池的核心参数有哪些？——`corePoolSize`/`maxPoolSize`/`keepAliveTime`/`workQueue`/`threadFactory`/`handler`；拒绝策略 `AbortPolicy`/`CallerRunsPolicy`/`DiscardPolicy`/`DiscardOldestPolicy`
9. volatile 能保证原子性吗？——不能保证复合操作原子性；`i++` 在 volatile 上仍然不是线程安全的
10. happens-before 规则有哪些？——volatile 写-读、锁释放-获取、线程 start()、join()、传递性；JMM 定义

## 回答框架提示

本组的"进程/OS 视角"是 x86 的 LOCK 前缀和 MESI 协议：`lock cmpxchg` 让其他 CPU 的 cache line 被 invalidated，这才是真正的代价。版本差异突出偏向锁 JDK 8→11→17→18 的变化链。