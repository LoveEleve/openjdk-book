# Java并发编程

## 1. 线程基础

### 1.1 线程层次结构
- Java线程 → JVM线程 → Linux内核线程
- 一对一模型

### 1.2 线程创建方式
- 本质：只有一种（调用start() → pthread_create）
- 任务提交方式：
  - 继承Thread类
  - 实现Runnable接口
  - FutureTask（包装Callable）

### 1.3 线程状态
- NEW
- RUNNABLE
- BLOCKED（等待monitor锁）
- WAITING（无限等待）
- TIMED_WAITING（限时等待）
- TERMINATED

### 1.4 线程中断
- interrupt()方法
- 中断标志位
- InterruptedException

## 2. Java内存模型(JMM)

### 2.1 基础概念
- 主内存（Main Memory）
- 本地内存（Local Memory）
- 共享变量 vs 私有变量

### 2.2 三大特性
- 原子性
- 可见性
- 有序性

### 2.3 重排序类型
- 编译器重排序
- 指令并行重排序
- 内存重排序

### 2.4 内存屏障
- LoadLoad
- StoreStore
- LoadStore
- StoreLoad（最强）
- acquire/release语义

### 2.5 关键字内存语义
- volatile：
  - 读：acquire（LoadLoad + LoadStore）
  - 写：release + StoreLoad
  - 顺序一致性
- final：
  - 写final后加StoreStore屏障
- synchronized：
  - 获取锁：LoadLoad + LoadStore
  - 释放锁：StoreStore + StoreLoad

### 2.6 happens-before规则
- 程序顺序规则
- 监视器锁规则
- volatile变量规则
- 传递性

## 3. synchronized关键字

### 3.1 管程(Monitor)概念
- MESA模型
- 入口队列
- 等待队列（条件变量）
  - wait()：释放锁并等待
  - notify()：唤醒单个等待线程
  - notifyAll()：唤醒所有等待线程
  - 必须在同步块内调用

### 3.2 锁升级过程
- 无锁 → 偏向锁 → 轻量级锁 → 重量级锁

### 3.3 对象头(Mark Word)
- 锁状态标志位
- 指向锁记录的指针
- 指向Monitor的指针

### 3.4 轻量级锁
- CAS替换Mark Word
- 线程栈BasicObjectLock
- 锁重入判断

### 3.5 重量级锁(ObjectMonitor)
- _owner：持有锁的线程
- _cxq：竞争队列（单链表）
- _entryList：等待队列
- _WaitSet：条件等待队列

### 3.6 锁优化
- 偏向锁（无竞争时）
- 轻量级锁（交替执行）
- 自旋锁
- 锁消除
- 锁粗化

## 4. AQS框架

### 4.1 继承体系
- AbstractOwnableSynchronizer（可重入支持）
- AbstractQueuedSynchronizer（队列管理）
- Node内部类

### 4.2 核心属性
- state：同步状态
- head/tail：同步队列
- exclusiveOwnerThread：独占线程

### 4.3 节点状态(waitStatus)
- 0：初始状态
- SIGNAL(-1)：后继需要唤醒
- CANCELLED(1)：取消等待
- CONDITION(-2)：条件等待
- PROPAGATE(-3)：共享传播

### 4.4 独占模式
- acquire()：获取锁
  - tryAcquire()：子类实现
  - addWaiter()：入队
  - acquireQueued()：阻塞等待
- release()：释放锁
  - tryRelease()：子类实现
  - unparkSuccessor()：唤醒后继

### 4.5 共享模式
- acquireShared()：获取共享锁
- setHeadAndPropagate()：传播唤醒
- doReleaseShared()：释放共享锁

### 4.6 条件队列(ConditionObject)
- await()：释放锁并等待
- signal()：唤醒条件队列节点
- 单链表结构
- 支持多个条件变量

## 5. 锁实现

### 5.1 ReentrantLock
- 可重入互斥锁
- 公平锁 vs 非公平锁
  - 公平：检查队列前驱
  - 非公平：直接CAS竞争
- 性能对比

### 5.2 ReentrantReadWriteLock
- 读锁（共享）
- 写锁（独占）
- 锁降级支持（写→读）
- 写锁饥饿问题
- HoldCounter（读锁重入计数）
- 二级缓存设计：
  - firstReader
  - cachedHoldCounter
  - readHolds(ThreadLocal)

### 5.3 StampedLock
- 三种模式：
  - 悲观读锁
  - 写锁
  - 乐观读
- 版本号机制（state高56位）
- cowaiters（读线程链）
- 不支持重入
- 读写并发性能更好

## 6. 同步器

### 6.1 Semaphore
- 信号量/限流
- acquire()：获取许可
- release()：释放许可
- 公平 vs 非公平

### 6.2 CountDownLatch
- 一次性倒计时门闩
- await()：等待计数归零
- countDown()：计数减一
- 适用场景：主线程等待子线程完成

### 6.3 CyclicBarrier
- 循环屏障
- 可重复使用
- 回调函数(barrierAction)
- Generation（代）概念
- 异常处理与屏障破坏

### 6.4 Phaser
- 多阶段同步器
- 动态注册/注销参与者
- arriveAndAwaitAdvance()
- 奇偶队列设计（分散竞争）
- state分段（终止/阶段/参与数/未到达数）
- 父子Phaser层级

### 6.5 Exchanger
- 线程间数据交换
- slot单槽（无竞争）
- arena多槽（竞争时）
- ThreadLocal复用Node
- 成对线程协作
- 伪共享填充（*128）

## 7. 线程池

### 7.1 ThreadPoolExecutor
- 核心参数
  - corePoolSize：核心线程数
  - maximumPoolSize：最大线程数
  - keepAliveTime：空闲存活时间
  - workQueue：任务等待队列
  - threadFactory：线程工厂
  - handler：拒绝策略
- 状态管理(ctl)
  - 高3位：线程池状态
  - 低29位：工作线程数
  - 五种状态：RUNNING/SHUTDOWN/STOP/TIDYING/TERMINATED
- 任务提交流程
  - 核心线程数内：创建Worker
  - 队列未满：入队等待
  - 队列满：创建非核心线程
  - 超出最大线程数：拒绝
- Worker机制
  - 继承AQS实现独占锁
  - firstTask首任务
  - runWorker()任务执行循环
  - getTask()从队列取任务（阻塞/超时）
- 线程回收
  - 超时poll() vs 阻塞take()
  - allowCoreThreadTimeOut
  - processWorkerExit()
- 关闭流程
  - shutdown()：优雅关闭
  - shutdownNow()：立即关闭
  - tryTerminate()：尝试终止
  - interruptIdleWorkers()
- 拒绝策略
  - AbortPolicy：抛出异常
  - CallerRunsPolicy：调用者执行
  - DiscardPolicy：静默丢弃
  - DiscardOldestPolicy：丢弃最老

### 7.2 ScheduledThreadPoolExecutor
- 定时任务调度
- 延迟执行
- 周期执行

### 7.3 ForkJoinPool
- 分治算法支持
- 工作窃取（Work Stealing）
- 工作队列：
  - 偶队列：外部提交（FIFO）
  - 奇队列：工作线程（LIFO）
- ForkJoinTask：
  - RecursiveAction（无返回值）
  - RecursiveTask（有返回值）
  - fork()：异步执行子任务
  - join()：等待并获取结果
- ctl控制字段（64位分段）
  - AC：活跃线程数 - 并行度
  - TC：总线程数 - 并行度
  - SS：栈顶状态
  - ID：栈顶索引

### 7.4 CompletableFuture
- 异步编程模型
- 链式调用（CompletionStage）
- 核心方法：
  - supplyAsync()：有返回值异步执行
  - thenApply()：转换结果
  - thenAccept()：消费结果
  - thenRun()：无参执行
  - thenCompose()：组合Future
  - thenCombine()：合并两个Future
  - allOf()/anyOf()：多Future组合
- 异常处理：
  - exceptionally()
  - handle()
- 线程池选择：
  - 默认ForkJoinPool.commonPool()
  - 自定义Executor
- 实现原理：
  - Treiber栈（stack字段）
  - 依赖链级联触发
  - postComplete()传播

## 8. 高并发容器

### 8.1 ConcurrentHashMap
- 数据结构
  - 数组+链表+红黑树
  - JDK7：分段锁（Segment）
  - JDK8：CAS+synchronized
- 核心机制
  - sizeCtl：控制变量（初始化/扩容）
  - 多线程协助扩容（transfer）
  - ForwardingNode标记迁移节点
  - 高低链表迁移优化
- 线程安全保证
  - CAS初始化数组
  - synchronized锁住头节点
  - volatile保证可见性

### 8.2 ConcurrentSkipListMap
- 跳表实现
- 有序Map（支持范围查询）
- 无锁CAS操作
- 概率性索引层级
- Node+Index结构

### 8.3 CopyOnWriteArrayList/Set
- 写时复制机制
- 读多写少场景
- 弱一致性迭代器（快照）
- 内存占用较大
- ReentrantLock保护写操作

### 8.4 阻塞队列
- ArrayBlockingQueue：有界数组队列（单锁）
- LinkedBlockingQueue：可选有界链表队列（双锁）
- PriorityBlockingQueue：优先队列（堆实现）
- DelayQueue：延迟队列（Leader-Follower模式）
- SynchronousQueue：同步队列（无容量，直接传递）
- LinkedTransferQueue：Transfer模式优化
- LinkedBlockingDeque：双端队列

## 9. 原子类与ThreadLocal

### 9.1 基本原子类
- AtomicInteger/Long：基本类型
- AtomicReference：引用类型
- AtomicStampedReference：带版本号（解决ABA）
- AtomicMarkableReference：带标记
- AtomicIntegerArray：数组类型
- AtomicReferenceArray：引用数组

### 9.2 LongAdder/LongAccumulator
- 高并发计数器
- Striped64架构：
  - base：基础值
  - cells[]：分散竞争数组
- 性能优于AtomicLong（高并发场景）
- 特点：
  - 将竞争点由一个变为多个
  - 使用rehash重试代替扩容
  - sum()弱一致性

### 9.3 ABA问题与解决
- ABA问题定义
- AtomicStampedReference原理
  - Pair对象包装（引用+版本号）
- AtomicMarkableReference原理
  - boolean标记替代版本号

### 9.4 ThreadLocal
- 线程本地变量
- ThreadLocalMap（Thread内部字段）
- Entry弱引用（Key弱引用，Value强引用）
- 内存泄漏风险与防范
  - 使用完及时remove()
- InheritableThreadLocal
  - 子线程继承父线程值

### 9.5 FastThreadLocal
- Netty优化实现
- index替代hash计算
- 性能优于JDK实现
- InternalThreadLocalMap

## 10. 并发设计模式

### 10.1 生产者-消费者模式
- BlockingQueue解耦
- 平衡生产与消费速率
- 条件变量实现版本

### 10.2 读写分离模式
- CopyOnWrite思想
- ReadWriteLock实现
- 读多写少场景优化

### 10.3 无锁编程
- CAS算法
- 自旋优化
- 无锁数据结构

### 10.4 Future模式
- 异步执行任务
- 获取异步结果
- CompletableFuture组合

### 10.5 工作窃取模式
- ForkJoinPool实现
- 负载均衡
- 双端队列（LIFO+FIFO）

## 11. 性能优化策略

### 11.1 减少上下文切换
- 避免频繁阻塞/唤醒
- 使用自旋代替阻塞（短时间）
- 批量处理减少切换

### 11.2 减少锁竞争
- 降低锁粒度
- 分段锁设计
- 无锁化改造

### 11.3 提高并发度
- 细粒度锁
- 读写分离
- 并行化设计

### 11.4 缓存优化
- 伪共享问题
- 缓存行对齐（@Contended）
- 局部性原理

## 12. 线程安全策略

### 12.1 不可变对象
- final类、final字段
- 无setter方法
- 防御性拷贝

### 12.2 线程封闭
- 栈封闭（局部变量）
- ThreadLocal线程隔离
- 单线程执行

### 12.3 同步容器
- Collections.synchronizedXXX
- 粗粒度锁，性能较差

### 12.4 并发容器
- JUC包下的线程安全容器
- 细粒度锁或无锁设计
- 优先使用

## 13. 常见问题与解决

### 13.1 死锁
- 四个必要条件
- 检测与预防
- 按固定顺序获取锁
- 使用tryLock()超时
- jstack死锁检测

### 13.2 活锁
- 线程不断改变状态
- 引入随机等待
- 退避算法

### 13.3 饥饿
- 公平锁解决
- 自旋+退避优化
- 写锁饥饿（ReadWriteLock）

### 13.4 线程安全单例
- 饿汉式
- 懒汉式（DCL+volatile）
- 静态内部类
- 枚举（最佳实践）

## 14. 调试与监控

### 14.1 常用工具
- jstack：查看线程栈、死锁检测
- jconsole：可视化监控
- VisualVM：性能分析
- Arthas：实时诊断

### 14.2 关键指标
- 活跃线程数
- 阻塞线程数
- 死锁检测
- 线程状态分布
- CPU使用率

### 14.3 日志与追踪
- ThreadLocal记录请求链路
- MDC（Mapped Diagnostic Context）

## 15. 面试重点

### 15.1 必知必会
- synchronized锁升级过程
- AQS核心原理与源码
- volatile内存语义
- 线程池参数与工作原理
- ConcurrentHashMap实现原理
- JMM三大特性

### 15.2 常见问题
- 死锁的四个条件与预防
- 线程安全单例模式（DCL）
- wait()与sleep()区别
- notify()与notifyAll()区别
- ThreadLocal原理与内存泄漏
- CAS原理与ABA问题
- 公平锁与非公平锁区别
- 读写锁锁降级
- CompletableFuture优势

### 15.3 源码级问题
- AQS独占/共享模式区别
- Condition实现原理
- ThreadPoolExecutor Worker机制
- ForkJoinPool工作窃取
- LongAdder分散竞争
- StampedLock乐观读实现

## 16. 补充细节说明

### 16.1 volatile关键字详解
- 可见性保证：
  - 写操作：强制刷新到主内存
  - 读操作：从主内存读取最新值
  - 禁止指令缓存
- 有序性保证：
  - volatile写禁止前面的普通写与volatile写重排序
  - volatile写禁止后面的volatile读与前面的volatile写重排序
  - volatile读/写禁止volatile读/写与普通读/写重排序
- 原子性不保证：
  - 复合操作仍需同步（如i++）
  - 适用原子类替代（AtomicInteger等）
- 适用场景：
  - 状态标记（flag、running等）
  - 单例模式双重检查（DCL）
  - 单写多读的场景
  - 只需保证可见性的场景
- 不适用场景：
  - 复合操作（count++等）
  - 需要原子性的场景
  - 需要保证复杂逻辑原子性的场景
- 性能特点：
  - 读性能接近普通读（~5ns）
  - 写性能高于synchronized（~10ns）
  - 远低于synchronized（~50-100ns）

### 16.2 锁优化技术详解
- 偏向锁：
  - 一段同步代码只被一个线程访问
  - Mark Word记录线程ID（偏向线程）
  - 撤销条件：
    - 其他线程竞争
    - 调用对象的hashCode()方法
    - 调用wait()方法
  - 批量重偏向与撤销：
    - 同一个类多次撤销偏向锁
    - 批量重偏向到其他线程
    - 批量撤销偏向锁
- 轻量级锁：
  - 线程交替执行同步块（无竞争）
  - 在线程栈中创建Lock Record
  - CAS替换Mark Word指向Lock Record
  - 自旋等待（-XX:PreBlockSpin配置次数）
  - 失败后膨胀为重量级锁
- 自旋锁：
  - 自适应自旋
  - 根据上次自旋时间调整本次自旋次数
  - 自旋次数与CPU核心数相关
  - 适用于短时间持有锁的场景
- 锁消除：
  - JIT编译器逃逸分析
  - 方法内私有对象锁消除
  - StringBuffer（单线程使用StringBuilder）
  - JVM参数：-XX:+EliminateAllocations
- 锁粗化：
  - 将连续的加锁合并为一次
  - 循环内的锁提取到循环外
  - 减少加锁/解锁的开销

### 16.3 ReentrantReadWriteLock详解
- 读锁（共享锁）：
  - 多个线程可以同时持有读锁
  - readLock.lock()/unlock()
  - 读不阻塞读，读阻塞写
  - 读锁可重入（同一线程多次获取）
- 写锁（独占锁）：
  - 同一时刻只能一个线程持有写锁
  - writeLock.lock()/unlock()
  - 写阻塞读和写
  - 写锁可重入
- 锁降级（写锁→读锁）：
  - 持有写锁可以获取读锁
  - 然后释放写锁，保持读锁
  - 示例：
    ```java
    writeLock.lock();
    try {
        // 写操作
        readLock.lock();
        writeLock.unlock();
        // 读操作
    } finally {
        readLock.unlock();
    }
    ```
  - 不支持锁升级（读锁→写锁）：
    - 会导致死锁
    - 必须先释放读锁再获取写锁
- 写锁饥饿问题：
  - 读操作过多时，写线程可能一直等待
  - 公平锁可以缓解（但性能下降）
  - 使用StampedLock可更好解决
- HoldCounter机制：
  - 每个线程的读锁重入次数
  - ThreadLocal缓存
  - 二级缓存设计：
    - firstReader：第一个获取读锁的线程
    - cachedHoldCounter：最近一个获取读锁的线程计数
    - readHolds(ThreadLocal)：所有线程的计数
- state字段位设计：
  - 高16位：读锁持有数（shared count）
  - 低16位：写锁持有数（exclusive count）
  - CAS操作同时更新两部分
  - 读锁增加：state + SHARED_UNIT（1 << 16）
  - 写锁增加：state + 1
- 适用场景：
  - 读多写少（如缓存配置、数据库查询）
  - 读操作远多于写操作（>90%读）
  - 性能优于互斥锁（6-7倍提升）
  - 不适用场景：
    - 写操作频繁
    - 需要锁升级的场景

### 16.4 StampedLock详解
- 三种模式：
  - 悲观读锁（readLock）：
    - 与写锁互斥
    - readUnlock()释放
    - 返回stamp（版本号）
  - 写锁（writeLock）：
    - 独占锁
    - writeUnlock()释放
    - 返回stamp
  - 乐观读（tryOptimisticRead）：
    - 无锁，返回stamp
    - 读取数据后调用validate(stamp)校验
    - 失败后转悲观读（readLock）
- 版本号机制：
  - state高56位存储版本号
  - 每次写操作版本号+1
  - 乐观读校验版本号是否变化
  - 版本号回绕处理
- cowaiters链表：
  - 读线程排队链表
  - 写线程优先级高于读线程
  - 避免写锁饥饿
- 性能特点：
  - 乐观读：无锁，性能极高（~5ns）
  - 悲观读：与ReadWriteLock相当
  - 写锁：略优于ReadWriteLock
  - 读多写少：优于ReadWriteLock（2-3倍）
- 使用注意事项：
  - 必须调用validate()校验版本号
  - 乐观读临界区操作尽量简短
  - 不要在乐观读中调用阻塞操作
  - 不支持重入，避免死锁
  - 读操作完成后释放stamp

### 16.5 锁选择建议
- ReentrantLock：
  - 通用场景
  - 需要公平性时
  - 需要tryLock()超时时
  - 需要可中断锁时
- ReentrantReadWriteLock：
  - 读多写少场景（读>90%）
  - 写操作较少
  - 需要锁降级时
- StampedLock：
  - 读操作极频繁（读>95%）
  - 读操作性能要求高
  - 可以使用乐观读时
  - 无需锁重入时
- synchronized：
  - 简单场景
  - 不需要锁高级特性时
  - JVM优化后性能也很好
- volatile：
  - 状态标记
  - 单例DCL
  - 只需保证可见性时

### 16.6 CAS与自旋底层实现
- CAS原理：
  - Compare-And-Swap（比较并交换）
  - CPU指令级别的原子操作
  - Unsafe类提供本地方法调用
  - sun.misc.Ununsafe.compareAndSwapXXX()
- ABA问题：
  - 定义：值从A变B再变A
  - 版本号解决方案（AtomicStampedReference）
  - 标记解决方案（AtomicMarkableReference）
  - 实际场景影响分析
- 自旋优化：
  - 自适应自旋
  - 根据上次竞争情况调整自旋次数
  - CPU核心数影响
  - -XX:PreBlockSpin参数
- 底层实现：
  - x86：lock cmpxchg指令
  - ARM：ldrex/strex指令对
  - 内存屏障保证原子性
- 性能特点：
  - 无锁，性能优于synchronized
  - 高竞争下自旋消耗CPU
  - 适用于低竞争场景
  - LongAdder分散竞争优于CAS

### 16.7 ConcurrentHashMap深度解析
- JDK7实现（分段锁）：
  - Segment[]数组（默认16个）
  - 每个Segment是ReentrantLock
  - 每个Segment独立扩容
  - 并发度=segments.length
  - 缺点：最大并发度受限于segments
- JDK8实现（CAS+synchronized）：
  - Node[]数组+链表+红黑树
  - CAS初始化table
  - synchronized锁住头节点（粒度更细）
  - 数组扩容支持多线程协助
- sizeCtl字段详解：
  - -1：初始化中
  - -N：-(1+扩容线程数)
  - 0：默认初始容量
  - 正数：扩容阈值（容量*0.75）
- 扩容机制：
  - 多线程协助扩容（transfer）
  - ForwardingNode标记迁移节点
  - 逆序迁移减少竞争
  - 高低位链表优化
- put操作流程：
  - hash计算扰动
  - CAS初始化数组
  - 空槽位CAS插入
  - 冲突synchronized锁头节点
  - 链表转红黑树（长度>=8）
  - 扩容检查（sizeCtl）
- get操作流程：
  - 无锁读取
  - volatile保证可见性
  - 读到ForwardingNode去新表查
- size()计算：
  - CounterCell[]分散计数
  - base基准值
  - sum()弱一致性
- 性能优化点：
  - 细粒度锁（节点级）
  - 扩容并行化
  - CAS减少锁使用
  - volatile保证可见性
- 与其他Map对比：
  - HashMap：线程不安全
  - Hashtable：全表锁
  - Collections.synchronizedMap：粗粒度锁
  - ConcurrentHashMap：最优性能

### 16.8 并发队列深度解析
- ConcurrentLinkedQueue：
  - 非阻塞无锁队列
  - Michael-Scott队列算法
  - head/tail节点滞后更新
  - offer()/poll()无锁
  - CAS操作保证原子性
  - 适合高并发低延迟场景
- LinkedBlockingQueue：
  - 可选有界链表队列
  - 两把锁（takeLock/putLock）
  - notEmpty/notFull条件变量
  - 读写操作并发
  - take/put分别持锁
- ArrayBlockingQueue：
  - 有界数组队列
  - 单把锁
  - 生产消费互斥
  - take/put不能并发
  - 内存占用小
- DelayQueue：
  - 优先队列+延时特性
  - Leader-Follower模式优化唤醒
  - 只能存储Delayed实现类
  - 延时任务调度场景
- SynchronousQueue：
  - 无容量队列
  - 生产者直接传递给消费者
  - 交换模式（transfer）
  - 线程池Executors.newCachedThreadPool()使用
  - 公平/非公平策略
- LinkedTransferQueue：
  - TransferQueue接口实现
  - 支持tryTransfer()
  - 链表+cas操作
  - 无锁高性能
- PriorityBlockingQueue：
  - 优先级无界队列
  - 堆实现（小顶堆）
  - 自定义Comparator
  - 单把锁
  - 不能存储null
- LinkedBlockingDeque：
  - 双端阻塞队列
  - 两把锁（firstLock/lastLock）
  - 支持头尾操作
  - 栈队列都可实现

### 16.9 线程池动态调优
- 核心参数调优：
  - corePoolSize：
    - CPU密集型：N+1
    - IO密集型：2N
    - N=CPU核心数
  - maximumPoolSize：
    - 避免设置过大（线程切换开销）
    - 通常corePoolSize的2-3倍
  - keepAliveTime：
    - 非核心线程空闲时间
    - 允许核心线程超时
  - workQueue：
    - ArrayBlockingQueue（固定大小）
    - LinkedBlockingQueue（灵活）
    - SynchronousQueue（直传）
    - PriorityBlockingQueue（优先级）
- 拒绝策略选择：
  - AbortPolicy：任务重要，不能丢失
  - CallerRunsPolicy：降级策略，防止过载
  - DiscardPolicy：可容忍丢失
  - DiscardOldestPolicy：新任务更重要
  - 自定义策略：特殊场景
- 监控指标：
  - 活跃线程数
  - 队列长度
  - 拒绝任务数
  - 任务完成时间
  - 线程池状态
- 动态调整：
  - setCorePoolSize()
  - setMaximumPoolSize()
  - allowCoreThreadTimeOut()
  - setKeepAliveTime()
- 最佳实践：
  - 不同业务使用独立线程池
  - 避免使用Executors创建（OOM风险）
  - 合理命名线程（便于排查）
  - 任务捕获异常
  - 线程池优雅关闭
- 常见问题：
  - OOM：无界队列+任务堆积
  - CPU飙高：线程数过多
  - 任务堆积：线程数过少
  - 死锁：任务互相等待

### 16.10 CompletableFuture异步编程
- 创建CompletableFuture：
  - supplyAsync(Supplier)：有返回值
  - runAsync(Runnable)：无返回值
  - completedFuture(T)：已完成的Future
- 转换操作：
  - thenApply(Function)：转换结果
  - thenAccept(Consumer)：消费结果
  - thenRun(Runnable)：无参执行
  - thenCompose(Function)：组合Future
- 组合操作：
  - thenCombine(other, BiFunction)：合并两个Future
  - thenAcceptBoth(other, BiConsumer)：消费两个结果
  - applyToEither(other, Function)：取最快完成的结果
  - allOf(CompletableFuture...)：等待所有完成
  - anyOf(CompletableFuture...)：等待任意一个完成
- 异常处理：
  - exceptionally(Function)：处理异常
  - handle(BiFunction)：处理结果和异常
  - whenComplete(BiConsumer)：完成回调
- 线程池指定：
  - 默认：ForkJoinPool.commonPool()
  - 自定义：supplyAsync(supplier, executor)
- 实现原理：
  - Treiber无锁栈（stack字段）
  - Completion链式依赖
  - postComplete()传播执行
  - tryFire()触发完成
- 性能特点：
  - 非阻塞异步
  - 链式调用避免回调地狱
  - 多Future组合能力强
- 使用场景：
  - 异步IO操作
  - 并发RPC调用
  - 异步任务编排
  - 流式数据处理
- 注意事项：
  - 避免阻塞主线程
  - 合理选择线程池
  - 异常必须处理
  - 避免链路过长

### 16.11 AQS源码级解析
- acquire(int arg)：
  - tryAcquire(arg)：尝试获取（子类实现）
  - addWaiter(Node.EXCLUSIVE)：创建节点入队
  - acquireQueued(node, arg)：队列中等待
  - selfInterrupt()：恢复中断状态
- release(int arg)：
  - tryRelease(arg)：尝试释放（子类实现）
  - unparkSuccessor(node)：唤醒后继节点
- addWaiter()细节：
  - Node.EXCLUSIVE/SHARED独占/共享模式
  - CAS设置tail
  - 入队逻辑
- acquireQueued()细节：
  - 死循环等待
  - 前驱是head则tryAcquire
  - shouldParkAfterFailedAcquire()判断是否阻塞
  - parkAndCheckInterrupt()阻塞并检查中断
- shouldParkAfterFailedAcquire()：
  - waitStatus状态判断
  - SIGNAL(-1)表示后继需要唤醒
  - 前驱状态清零，尝试设置SIGNAL
- cancelAcquire()：
  - 取消节点获取
  - waitStatus=CANCELLED
  - 清理前驱后继关系
- ConditionObject（条件队列）：
  - await()：释放锁，加入条件队列
  - signal()：唤醒条件队列首节点，转移至同步队列
  - firstWaiter/lastWaiter：条件队列首尾
  - nextWaiter：单向链表
- 共享模式差异：
  - acquireShared()：共享获取
  - releaseShared()：共享释放
  - setHeadAndPropagate()：传播唤醒
  - doReleaseShared()：持续唤醒
- 独占vs共享：
  - 独占：同一时刻只能一个线程持有
  - 共享：多个线程可以同时持有（读锁、信号量）
  - 状态字段使用方式不同
- 子类实现模板：
  - tryAcquire/tryRelease
  - tryAcquireShared/tryReleaseShared
  - isHeldExclusively()
  - state字段使用方式灵活

### 16.12 并发编程常见陷阱
- 活锁：
  - 定义：线程不断改变状态，无法推进
  - 场景：重试+乐观锁
  - 解决：随机退避
- 饥饿：
  - 定义：线程长期无法获取资源
  - 场景：非公平锁、读锁饥饿
  - 解决：公平锁、优先级调整
- 伪共享：
  - 定义：多个变量同一缓存行
  - 影响：缓存一致性协议开销
  - 解决：缓存行填充（@Contended）
  - VolatileLong@sun.misc.Contended
- 死锁：
  - 四个必要条件：
    - 互斥条件
    - 请求与保持
    - 不剥夺
    - 循环等待
  - 预防：
    - 按固定顺序获取锁
    - tryLock()超时
    - 锁超时机制
  - 检测：jstack、VisualVM
- 内存泄漏：
  - ThreadLocal未remove()
  - 静态集合持有对象引用
  - 未关闭的资源（连接、流）
- 可见性问题：
  - 未使用volatile/synchronized
  - 跨线程共享变量
  - JMM重排序
- 原子性问题：
  - 复合操作非原子
  - 如count++、check-then-act
  - 使用synchronized或原子类
- 线程池陷阱：
  - 使用无界队列导致OOM
  - 线程数设置不当
  - 任务中循环依赖线程池
  - 异常未捕获导致线程终止
- 并发集合误用：
  - HashMap多线程put导致死循环（JDK7）
  - 使用同步容器性能差
  - 迭代器ConcurrentModificationException

### 16.13 并发性能调优
- 减少锁竞争：
  - 缩小锁的范围
  - 降低锁粒度
  - 分段锁/分区锁
  - 读写分离
  - 无锁化改造
- 减少上下文切换：
  - 合理设置线程数
  - 避免频繁阻塞/唤醒
  - 批量处理
  - 使用协程（虚拟线程）
- CPU缓存优化：
  - 缓存行对齐（@Contended）
  - 提高数据局部性
  - 避免伪共享
- 算法优化：
  - 粗化锁：合并连续锁
  - 锁消除：逃逸分析
  - 自适应自旋
  - 并行化改造
- 工具使用：
  - JProfiler：性能分析
  - VisualVM：线程分析
  - Arthas：实时诊断
  - JFR：事件记录
- 性能指标：
  - 吞吐量（TPS/QPS）
  - 延迟（P99/P95）
  - CPU利用率
  - 线程数
  - 上下文切换次数
- 调优原则：
  - 先测量后优化
  - 找到瓶颈再优化
  - 避免过早优化
  - 权衡空间与时间
- 常用命令：
  - jstack：线程栈
  - jstat：GC统计
  - jmap：内存映射
  - jinfo：JVM参数
  - jcmd：全能工具

### 16.14 异常处理最佳实践
- 线程异常捕获：
  - UncaughtExceptionHandler
  - setDefaultUncaughtExceptionHandler()
  - setUncaughtExceptionHandler()
- 线程池异常处理：
  - try-catch包裹任务
  - 自定义ThreadFactory设置Handler
  - 重写afterExecute()
  - Future.get()获取异常
- CompletionService异常：
  - take().get()捕获异常
- CompletableFuture异常：
  - exceptionally()处理
  - handle()处理
- ForkJoinTask异常：
  - get()抛出ExecutionException
  - getException()获取
- 注意事项：
  - 不要吞掉异常
  - 记录异常日志
  - 异常分类处理
  - 线程池优雅关闭

### 16.15 并发测试工具与方法
- 并发测试框架：
  - JMH（Java Microbenchmark Harness）
  - JUnit并发测试
  - TestNG并发测试
- 压力测试工具：
  - JMeter
  - Gatling
  - Apache Bench (ab)
- 静态分析：
  - FindBugs
  - SonarQube
  - SpotBugs
- 死锁检测：
  - jstack
  - VisualVM
  - JConsole
- 竞态检测：
  - ThreadSanitizer (TSan)
  - Java Pathfinder (JPF)
- 性能分析：
  - JProfiler
  - YourKit
  - Java Mission Control
- 测试要点：
  - 边界条件
  - 高并发场景
  - 长时间运行
  - 异常场景
- 测试技巧：
  - 使用CountDownLatch并发启动
  - 使用CyclicBarrier同步测试
  - 使用Phaser多阶段测试
  - 使用ThreadLocalRandom随机化

### 16.16 分布式锁实现
- 基于Redis实现：
  - SETNX + EXPIRE
  - Redlock算法（多节点）
  - Redisson框架
  - Lua脚本保证原子性
- 基于Zookeeper实现：
  - 临时顺序节点
  - EPHEMERAL | SEQUENTIAL
  - Watcher监听
  - Curator框架
- 基于数据库实现：
  - 乐观锁（版本号）
  - 悲观锁（SELECT FOR UPDATE）
  - 唯一索引约束
- 对比分析：
  - 性能：Redis > Zookeeper > 数据库
  - 可靠性：Zookeeper > Redis > 数据库
  - 实现复杂度：数据库 > Zookeeper > Redis
- 注意事项：
  - 锁超时时间设置
  - 锁续期机制（看门狗）
  - 锁释放失败处理
  - 主从切换问题

### 16.17 异步编程模式
- 回调模式：
  - 优点：简单直观
  - 缺点：回调地狱
  - 适用：简单异步操作
- Future模式：
  - Future + ExecutorService
  - get()阻塞获取结果
  - 缺点：阻塞式
- CompletableFuture模式：
  - 链式调用
  - 组合能力强
  - 异步非阻塞
- 响应式编程：
  - Reactive Streams
  - Project Reactor
  - RxJava
  - 背压支持
- 虚拟线程（Java 19+）：
  - 轻量级线程
  - 同步写法，异步执行
  - 阻塞操作不阻塞物理线程
  - 使用方式：
    - Thread.ofVirtual().start()
    - Executors.newVirtualThreadPerTaskExecutor()
  - 注意事项：
    - 不能使用synchronized（可能pin）
    - 不适用于CPU密集型任务
    - 需要改造阻塞调用

### 16.18 并发集合源码解析
- ConcurrentHashMap核心方法：
  - initTable()：初始化数组
  - putVal()：插入元素
  - transfer()：扩容迁移
  - helpTransfer()：协助扩容
  - get()：查询元素
- ConcurrentLinkedQueue核心方法：
  - offer()：入队
  - poll()：出队
  - updateHead()：更新head
  - succ()：获取后继
- ConcurrentSkipListMap核心方法：
  - doPut()：插入
  - findNode()：查找节点
  - findPredecessor()：查找前驱
  - CAS操作保证原子性
- CopyOnWriteArrayList核心方法：
  - add()：复制数组+插入
  - remove()：复制数组+删除
  - get()：直接读（无锁）
  - COWIterator：快照迭代器

### 16.19 线程通信机制
- wait/notify：
  - 必须在synchronized块内
  - wait()释放锁
  - notify()唤醒一个
  - notifyAll()唤醒所有
  - 缺点：容易死锁
- Condition：
  - ReentrantLock创建
  - await/signal
  - 支持多个条件队列
  - 可中断等待
  - 可超时等待
- CountDownLatch：
  - 一次性门闩
  - await/countDown
  - 不能重置
- CyclicBarrier：
  - 循环屏障
  - await等待
  - 可重用
  - barrierAction回调
- Phaser：
  - 多阶段同步
  - 动态注册/注销
  - 可复用
- Exchanger：
  - 线程间数据交换
  - 成对交换
  - 可用于数据校验

### 16.20 并发安全集合使用场景
- List：
  - Vector：全表锁，废弃
  - CopyOnWriteArrayList：读多写少
  - Collections.synchronizedList：粗粒度锁
  - ConcurrentLinkedQueue：无锁队列
- Set：
  - CopyOnWriteArraySet：读多写少
  - Collections.synchronizedSet：粗粒度锁
  - ConcurrentHashMap.newKeySet()：JDK8+
- Map：
  - Hashtable：全表锁，废弃
  - Collections.synchronizedMap：粗粒度锁
  - ConcurrentHashMap：首选，高并发
  - ConcurrentSkipListMap：有序Map
  - TreeMap：非线程安全
- Queue：
  - ArrayBlockingQueue：有界
  - LinkedBlockingQueue：无界
  - PriorityBlockingQueue：优先级
  - DelayQueue：延迟
  - SynchronousQueue：无容量
  - ConcurrentLinkedQueue：无锁
- Deque：
  - LinkedBlockingDeque：双端队列
  - ConcurrentLinkedDeque：无锁双端
- 选择原则：
  - 高并发：ConcurrentHashMap
  - 读多写少：CopyOnWrite
  - 有序：ConcurrentSkipListMap
  - 队列：阻塞队列优先
  - 无界注意OOM风险

### 16.21 ThreadLocal原理与最佳实践
- 内部实现：
  - ThreadLocalMap作为Thread成员
  - Entry弱引用Key
  - Value强引用
  - openAddressing哈希
- 内存泄漏原因：
  - Thread生命周期长
  - Entry被GC回收
  - Value无法回收
  - Key为null的Entry
- 解决方案：
  - 使用完立即remove()
  - 线程池环境必须remove()
  - 避免在ThreadLocal中存大对象
- InheritableThreadLocal：
  - 子线程继承父线程值
  - 父子线程间传递
  - 线程池场景不适用
- FastThreadLocal（Netty）：
  - index索引访问
  - 数组代替哈希
  - 性能更优
- 使用场景：
  - 数据库连接
  - 事务上下文
  - 用户会话
  - 请求链路追踪
- 最佳实践：
  - static final修饰
  - 命名规范
  - 及时remove()
  - 避免大对象

### 16.22 并发设计模式进阶
- 生产者-消费者模式：
  - BlockingQueue实现
  - 解耦生产消费
  - 缓冲作用
  - 适用场景：日志处理、消息队列
- Future模式：
  - 异步执行
  - 获取结果
  - CompletableFuture实现
  - 适用场景：RPC调用、并行计算
- Master-Worker模式：
  - 主从模式
  - 任务分发
  - 结果汇总
  - 适用场景：分布式计算
- 不变模式：
  - final修饰
  - 不可变对象
  - 线程安全
  - 适用场景：配置对象
- 读写锁模式：
  - ReentrantReadWriteLock
  - 读多写少
  - 性能优化
  - 适用场景：缓存
- 乐观锁模式：
  - CAS实现
  - 无锁竞争
  - 适合低并发
  - 适用场景：计数器
- 委派模式：
  - ForkJoinPool
  - 工作窃取
  - 适用场景：分治算法

### 16.23 并发工具类补充
- CountDownLatch应用：
  - 并行计算等待
  - 服务启动检查
  - 多线程协作
- CyclicBarrier应用：
  - 数据分批处理
  - 多阶段任务
  - 并行测试
- Phaser应用：
  - 多阶段并行
  - 动态参与者
  - 复杂同步场景
- Exchanger应用：
  - 数据交换
  - 数据校验
  - 生产消费配对
- Semaphore应用：
  - 限流
  - 资源池
  - 并发控制
- AtomicInteger应用：
  - 计数器
  - 序列号生成
  - 状态标记
- LongAdder应用：
  - 高并发计数
  - 性能优于AtomicLong
  - 分布式热点

### 16.24 实战经验总结
- 线程池配置：
  - 不同业务独立线程池
  - 合理命名便于排查
  - 拒绝策略合理选择
  - 核心线程数根据类型
- 锁的使用：
  - 锁范围尽可能小
  - 避免在锁内执行IO
  - 避免嵌套锁（防死锁）
  - 考虑锁升级/降级
- 异步编程：
  - 优先使用CompletableFuture
  - 异常必须处理
  - 避免回调地狱
  - 考虑虚拟线程
- 集合选择：
  - 高并发ConcurrentHashMap
  - 读多写少CopyOnWrite
  - 队列阻塞优先
  - 注意有界vs无界
- 监控告警：
  - 线程池监控
  - 队列长度监控
  - 死锁检测
  - 异常告警
- 性能优化：
  - 减少锁竞争
  - 无锁化改造
  - 伪共享处理
  - 批量处理
- 常见问题：
  - 死锁：按顺序获取锁
  - 内存泄漏：ThreadLocal及时remove
  - OOM：避免无界队列
  - 性能：合理配置参数
- 调试技巧：
  - jstack查看线程栈
  - VisualVM监控线程
  - Arthas实时诊断
  - 日志记录线程状态

### 16.25 Java并发新特性
- Java 8：
  - CompletableFuture
  - LongAdder/LongAccumulator
  - ConcurrentHashMap增强
  - 并行流
- Java 9：
  - Flow API（响应式流）
  - CompletableFuture改进
- Java 11：
  - var局部变量类型推断
  - HttpClient异步支持
- Java 17：
  - 虚拟线程（预览）
  - Structured Concurrency（预览）
- Java 19+：
  - 虚拟线程正式版
  - Scoped Values
  - StructuredTaskScope
- 新特性应用：
  - 虚拟线程替代传统线程池
  - 响应式编程模型
  - 结构化并发简化错误处理
- 迁移建议：
  - 逐步引入新特性
  - 性能测试验证
  - 注意兼容性

### 16.26 面试题详细解答
- synchronized锁升级：
  - 为什么需要锁升级：
    - 减少重量级锁的开销
    - 适应不同的竞争程度
  - 升级过程：
    - 无锁→偏向锁（首次）
    - 偏向锁→轻量级锁（竞争）
    - 轻量级锁→重量级锁（持续竞争）
  - 为什么不能降级：
    - 重量级锁有Monitor对象
    - 降级复杂且无意义
  - 偏向锁撤销条件：
    - 其他线程竞争
    - 调用hashCode()
    - 调用wait()
- volatile vs synchronized：
  - volatile特点：
    - 保证可见性
    - 保证有序性
    - 不保证原子性
    - 性能更高
  - synchronized特点：
    - 保证原子性
    - 保证可见性
    - 保证有序性
    - 性能相对低
  - 选择原则：
    - 简单可见性：volatile
    - 复合操作：synchronized
    - 性能要求高：volatile
- AQS原理：
  - 核心思想：
    - CLH队列变种
    - state控制同步
    - 独占/共享模式
  - 独占模式：
    - acquire：获取锁，失败入队
    - release：释放锁，唤醒后继
  - 共享模式：
    - acquireShared：共享获取
    - releaseShared：共享释放，传播唤醒
  - Condition：
    - 条件队列
    - await/signal
    - 转移至同步队列
- 线程池参数：
  - corePoolSize：核心线程数
    - CPU密集型：N+1
    - IO密集型：2N
  - maximumPoolSize：最大线程数
    - 通常core的2-3倍
  - keepAliveTime：空闲时间
  - workQueue：任务队列
    - 有界：ArrayBlockingQueue
    - 无界：LinkedBlockingQueue
    - 直传：SynchronousQueue
  - handler：拒绝策略
    - AbortPolicy：抛异常
    - CallerRunsPolicy：调用者执行
- ConcurrentHashMap实现：
  - JDK7：Segment分段锁
    - 并发度=segments.length
    - 每个Segment是ReentrantLock
  - JDK8：CAS+synchronized
    - 细粒度锁（节点级）
    - 多线程协助扩容
  - 为什么不用分段锁：
    - 分段数固定，并发度受限
    - JDK8细粒度锁更灵活
  - 扩容机制：
    - 多线程协助
    - ForwardingNode标记
    - 逆序迁移
- ThreadLocal内存泄漏：
  - 原因：
    - Entry弱引用Key
    - Value强引用
    - Key被GC回收，Value无法回收
  - 解决：
    - 使用完立即remove()
    - 线程池环境必须remove()
  - 为什么用弱引用：
    - 避免Key无法回收
    - 不影响Thread生命周期
- CAS与ABA：
  - CAS原理：
    - 比较并交换
    - CPU指令原子操作
  - ABA问题：
    - 值从A变B再变A
    - 看起来没变，实际变了
  - 解决方案：
    - AtomicStampedReference（版本号）
    - AtomicMarkableReference（标记）
- 线程状态转换：
  - NEW→RUNNABLE：start()
  - RUNNABLE→BLOCKED：等待monitor锁
  - RUNNABLE→WAITING：wait()/join()/park()
  - RUNNABLE→TIMED_WAITING：sleep(timeout)
  - WAITING→RUNNABLE：notify()/notifyAll()
  - TIMED_WAITING→RUNNABLE：超时或唤醒
  - RUNNABLE→TERMINATED：执行结束
- wait()与sleep()：
  - wait()：
    - Object方法
    - 释放锁
    - 需要在synchronized块内
    - 可被notify/notifyAll唤醒
  - sleep()：
    - Thread静态方法
    - 不释放锁
    - 不需要synchronized
    - 超时自动唤醒
- notify()与notifyAll()：
  - notify()：
    - 唤醒一个线程
    - 唤醒谁不确定
    - 可能导致信号丢失
  - notifyAll()：
    - 唤醒所有线程
    - 确保不会丢失信号
    - 可能唤醒不必要的线程
  - 选择：
    - 确定只有一个等待：notify()
    - 不确定或多个：notifyAll()
- ReentrantReadWriteLock：
  - 特点：
    - 读锁共享，写锁独占
    - 支持锁降级（写→读）
    - 不支持锁升级（读→写）
  - 锁降级示例：
    - 持有写锁
    - 获取读锁
    - 释放写锁
    - 保持读锁
  - 写锁饥饿：
    - 读操作多时，写线程等待
    - 使用StampedLock解决
- 死锁四个条件：
  - 互斥条件：资源互斥使用
  - 请求与保持：持有锁同时请求其他锁
  - 不剥夺：不能强行剥夺资源
  - 循环等待：形成等待环路
  - 打破任意一个可避免死锁
  - 常用方法：
    - 按固定顺序获取锁
    - tryLock()超时
    - 锁超时机制

### 16.27 并发编程进阶话题
- 伪共享与缓存行：
  - 缓存行（Cache Line）：
    - CPU缓存基本单位
    - 大小通常64字节
  - 伪共享：
    - 多个变量同一缓存行
    - 缓存一致性协议开销
    - 性能下降
  - 解决：
    - 缓存行填充
    - @Contended注解
    - VolatileLong@sun.misc.Contended
  - JVM参数：
    - -XX:-RestrictContended启用@Contended
- CPU指令重排序：
  - 编译器重排序：
    - 指令级优化
    - 保持单线程语义
  - 处理器重排序：
    - 指令并行执行
    - 内存系统乱序
  - 内存屏障：
    - LoadLoad：禁止load重排
    - StoreStore：禁止store重排
    - LoadStore：禁止load与store重排
    - StoreLoad：禁止store与load重排（最强）
- 指令级并行：
  - 超标量：
    - 一个时钟周期发射多条指令
  - 流水线：
    - 指令分阶段执行
  - 乱序执行：
    - 动态调度指令
  - 分支预测：
    - 预测分支走向
    - 预取指令
- 内存屏障实现：
  - volatile写：
    - StoreStore + StoreLoad
    - 禁止前面的普通写与volatile写重排
    - 禁止后面的volatile读与前面的volatile写重排
  - volatile读：
    - LoadLoad + LoadStore
    - 禁止后面的volatile读与前面的volatile读重排
    - 禁止后面的普通写与前面的volatile读重排
- happens-before规则：
  - 程序顺序规则：单线程内按程序顺序
  - 监视器锁规则：解锁 happens-before 加锁
  - volatile变量规则：写 happens-before 读
  - 传递性：A→B，B→C，则A→C
  - 线程启动规则：start() happens-before 新线程动作
  - 线程终止规则：线程动作 happens-before join()返回
  - 中断规则：interrupt() happens-before 检测到中断

### 16.28 高并发架构设计
- 并发层次：
  - 多线程：JVM级别
  - 多进程：进程级别
  - 分布式：机器级别
- 无锁数据结构：
  - CAS实现
  - 无队列算法
  - 适用低竞争场景
  - 如ConcurrentLinkedQueue
- 分段锁：
  - 减少锁粒度
  - 提高并发度
  - 如ConcurrentHashMap（JDK7）
- 读写分离：
  - ReadWriteLock
  - 读多写少场景
  - 主从复制（数据库）
- 缓存并发：
  - Cache Aside Pattern
  - Write-Through
  - Write-Behind
  - 缓存穿透/击穿/雪崩
- 消息队列并发：
  - 生产消费解耦
  - 异步处理
  - 削峰填谷
- 数据库并发：
  - 乐观锁：版本号
  - 悲观锁：SELECT FOR UPDATE
  - 隔离级别：READ COMMITTED/REPEATABLE READ
- 分布式事务：
  - 2PC两阶段提交
  - TCC补偿事务
  - SAGA事务
  - 本地消息表

### 16.29 并发工具源码分析
- CountDownLatch源码：
  - AQS共享模式
  - await()：等待count=0
  - countDown()：count减1，唤醒等待
  - tryReleaseShared()
  - 一次性使用
- CyclicBarrier源码：
  - ReentrantLock + Condition
  - await()：等待所有线程到达
  - Generation代概念
  - reset()：重置屏障
  - 可重复使用
- Semaphore源码：
  - AQS共享模式
  - acquire()：获取许可
  - release()：释放许可
  - 公平vs非公平
  - 限流场景
- Exchanger源码：
  - slot/arena槽位
  - 单槽：无竞争
  - 多槽：竞争时
  - exchange()：交换数据
- Phaser源码：
  - state分段设计
  - arriveAndAwaitAdvance()
  - 奇偶队列分散竞争
  - 可复用多阶段
  - 父子Phaser层级

### 16.30 性能优化实战案例
- 案例一：高并发计数器优化
  - 问题：AtomicLong高竞争性能差
  - 优化：使用LongAdder
  - 原理：分散竞争到cells[]
  - 性能提升：5-10倍
- 案例二：缓存击穿优化
  - 问题：热点key失效导致大量请求到数据库
  - 优化：互斥锁+双重检查
  - 方案：
    - synchronized + DCL
    - 本地缓存+定期刷新
  - 性能提升：DB压力降低90%
- 案例三：批量处理优化
  - 问题：单条处理IO频繁
  - 优化：批量处理
  - 方案：
    - BlockingQueue缓冲
    - 定时批量提交
  - 性能提升：吞吐量提升3-5倍
- 案例四：并行计算优化
  - 问题：串行计算耗时长
  - 优化：ForkJoinPool并行计算
  - 方案：
    - 任务拆分
    - 工作窃取
  - 性能提升：接近线性加速
- 案例五：连接池优化
  - 问题：连接数不足导致等待
  - 优化：动态扩缩容
  - 方案：
    - 动态调整连接数
    - 监控活跃连接
  - 性能提升：响应时间降低50%
- 案例六：异步IO优化
  - 问题：阻塞IO浪费线程
  - 优化：NIO+事件驱动
  - 方案：
    - Netty框架
    - Reactor模式
  - 性能提升：QPS提升5-10倍

### 16.31 并发安全检查清单
- 线程启动：
  - 线程是否正确启动
  - 线程是否正确关闭
  - 线程池参数是否合理
  - 拒绝策略是否配置
- 锁的使用：
  - 锁是否正确释放（try-finally）
  - 锁范围是否合理
  - 是否有死锁风险
  - 锁粒度是否合适
- 共享变量：
  - 是否需要同步
  - volatile/synchronized是否正确
  - 是否有竞态条件
  - 是否有可见性问题
- 异常处理：
  - 异常是否捕获
  - 线程异常是否处理
  - 资源是否正确释放
  - 是否有资源泄漏
- 集合使用：
  - 集合是否线程安全
  - 迭代器是否ConcurrentModification
  - 集合大小是否合理
  - 是否有内存泄漏
- 性能考虑：
  - 是否有性能瓶颈
  - 锁竞争是否严重
  - 上下文切换是否频繁
  - CPU利用率是否合理
- 测试验证：
  - 是否有并发测试
  - 是否有压力测试
  - 是否有性能测试
  - 是否有异常测试

### 16.32 常用并发工具类速查
- 锁：
  - synchronized：内置锁
  - ReentrantLock：可重入锁
  - ReadWriteLock：读写锁
  - StampedLock：印章锁
- 同步器：
  - CountDownLatch：门闩
  - CyclicBarrier：屏障
  - Semaphore：信号量
  - Exchanger：交换器
  - Phaser：多阶段同步器
- 原子类：
  - AtomicInteger/Long：基本类型
  - AtomicReference：引用类型
  - AtomicStampedReference：版本号
  - LongAdder：高并发计数器
- 集合：
  - ConcurrentHashMap：并发Map
  - ConcurrentSkipListMap：有序Map
  - CopyOnWriteArrayList：写时复制
  - ConcurrentLinkedQueue：无锁队列
  - ArrayBlockingQueue：有界队列
  - SynchronousQueue：同步队列
- 工具：
  - ThreadLocal：线程本地变量
  - ThreadLocalRandom：随机数
  - TimeUnit：时间单位
  - CompletableFuture：异步Future
- 线程池：
  - ThreadPoolExecutor：基础线程池
  - ScheduledThreadPoolExecutor：定时线程池
  - ForkJoinPool：分治线程池
  - Executors：工厂类（不推荐使用）
