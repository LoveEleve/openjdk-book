# 并发同步模式：AQS、Latch、Barrier、Future 与分阶段协作如何避免永久等待

> 主题：高并发与性能｜第 3 篇
> 前置文章：`01-concurrency-foundation.md`、`02-concurrent-data-structures.md`
> 本篇后续：`04-traffic-management.md`
> 一句话困惑：主线程等待子任务、多个阶段同步和服务并行调用，怎样避免一人失败全员永久等待？
> 一句话顿悟：同步器的本质不是"哪个类更高级"，而是明确谁在等谁、等什么条件、等待多久、参与者失败怎么办，以及等待成本放在 CPU 还是队列。
> 依赖分类：
> - 硬依赖：读者至少知道 CountDownLatch/CyclicBarrier、线程池和 CAS 的基本概念；否则无法理解为什么需要 AQS 这个底层框架。
> - 软依赖：上一篇 `01-concurrency-foundation.md` 和 `02-concurrent-data-structures.md` 建立的线程池、连接池和锁的心智模型会帮助理解本文，但不是本文成立前提。
> - 导航依赖：下一篇 `04-traffic-management.md` 会把视角推进到限流算法、自适应保护、熔断降级与隔离；本篇先把同步原语的基础讲清。
> 版本说明：本文是高并发与性能域的同步原语篇，重点在 AQS、CountDownLatch、CyclicBarrier、Semaphore、ReadWriteLock、CompletableFuture、ForkJoinPool 和 Phaser 的稳定心智模型，不对应某个 JDK 版本的完整实现源码。本文锚在 state、等待队列、许可控制、依赖图和工作窃取这些经典机制本身，不把某一版 AQS 的自旋策略、ForkJoinPool 的 common pool 配置或 Phaser 的 phase 递进路径写成跨版本契约，而把重点放在"同步器解决的不是同一个问题：互斥保护共享状态，协调器表达阶段/许可/完成条件，异步组合表达依赖图"。

## 现在真正该问的，不再是"用哪个同步器"，而是"谁在等谁、等什么条件、等待多久、参与者失败怎么办"

前两篇把线程、线程池和并发容器的基础讲清楚了。现在要把视角推进到另一个关键层面：**线程之间怎样协调开始、结束、限流和协作，以及等待超时或参与者失败时如何避免整个系统卡死。**

很多人以为同步器就是"选一个类来用"：等子任务就用 CountDownLatch，阶段同步就用 CyclicBarrier。但真实的选择远比这复杂。CountDownLatch 是一次性的，CyclicBarrier 可以循环但参与者失败会 broken，Semaphore 只控制许可不提供资源生命周期，CompletableFuture 的异步链可能因为执行器配置错误重新变成阻塞。所以同步器的选型不是看"哪个类更高级"，而是看：

- **谁在等谁**：主线程等子任务？子任务之间互相等？还是异步任务之间形成依赖图？
- **等什么条件**：计数到零？所有参与者到达？许可可用？还是 Future 完成？
- **等待多久**：永久等待？超时？还是 interrupt 触发取消？
- **参与者失败怎么办**：计数不会自动减少？barrier broken？异常被吞掉？
- **等待成本放在哪里**：CPU 自旋？队列 park？还是 OS 调度？

先把总图记住：

```text
AQS:
  提供状态/队列/阻塞模板

Latch/Barrier/Phaser:
  阶段与完成条件

Semaphore/Lock:
  许可/互斥/读写协议

CompletableFuture/ForkJoin:
  异步依赖与计算调度
```

这篇最该先记住的一句话是：**同步器的本质不是"哪个类更高级"，而是明确谁在等谁、等什么条件、等待多久、参与者失败怎么办，以及等待成本放在 CPU 还是队列。**

## 一、AQS：状态变量与等待队列的同步框架

### 1. 最朴素的错误世界：CountDownLatch、Semaphore、ReentrantLock 看起来用途不同，底层各走各的

这个想法在"每个类独立实现"的假设下很常见，但这些看似不同的同步器底层都共享同一个框架思路：AQS。

### 2. AQS 的最小图

```text
state:
  volatile/int-like synchronization state

acquire:
  tryAcquire/tryAcquireShared 成功?
    是 → 继续
    否 → Node 入等待队列
        → park()
        → 前驱释放/状态变化
        → unpark/重新尝试

release:
  tryRelease/tryReleaseShared
  → 状态改变
  → 唤醒后继

独占:
  一个持有者
共享:
  多个许可/读者/计数参与者
```

### 3. 为什么等待线程不一直自旋

因为自旋低延迟但消耗 CPU，park 省 CPU 但唤醒有调度成本。具体自旋/阻塞策略由实现、竞争时间和 JVM/OS 共同决定，不能固定写死"自旋多少次最优"。而且 AQS 是 Java 层框架，底层 park/unpark 与 OS 调度和 futex 路径相关，不是纯 JVM 实现。

### 4. 本节最该记住的结论：AQS 提供 state、队列和模板方法，子类定义 state 的业务语义；自旋与 park 的取舍由实现和 OS 共同决定，不能固定写死

一句最短人话是：**AQS 像排队系统模板：state 是窗口容量，队列是候场名单，具体同步器决定"一个人进、几张票或倒数到零"。**

## 二、CountDownLatch 与 CyclicBarrier：一次性完成条件与循环阶段

### 1. 第二个朴素误解：等 10 个子任务结束和让 10 个线程在每轮计算后同时出发，可以用同一个类

两者等待对象和生命周期不同。CountDownLatch 是一次性的，计数到零就永久打开；CyclicBarrier 可以循环但参与者数量通常固定，有人掉队会 broken。

### 2. Latch/Barrier 的最小图

```text
CountDownLatch(count):
  worker countDown()
  coordinator await()
  count=0 → 永久打开
  → 一次性完成条件

CyclicBarrier(parties):
  每个参与者 await()
  全部到达 → barrier action/唤醒
  → phase 重置, 可重复使用
  → 参与者数量通常固定

异常:
  timeout/interrupt/参与者失败
  → barrier 可能 broken
  → 等待者收到异常, 必须处理恢复
```

### 3. 为什么 Barrier 的 broken 状态很重要

因为如果一名参与者永远不来，其他线程不能无限假设阶段仍能完成。超时/中断会让所有参与者知道本轮不能继续。Latch 的计数也不会自动因为线程异常而减少，任务必须在 finally/监督逻辑中报告完成或失败。

### 4. 本节最该记住的结论：Latch 是一次性完成条件，Barrier 是循环阶段同步；参与者失败时 barrier 会 broken，Latch 计数不会自动减少，两者都必须处理异常恢复

## 三、Semaphore 与 ReadWriteLock：许可控制不等于互斥锁

### 1. 第三个朴素误解：Semaphore 就是"更灵活的锁"

Semaphore 只控制许可，不提供资源创建、借还、验证和生命周期。许可数还需和真实数据库容量、事务时长、连接池大小配合。公平性也可能降低吞吐，非公平可能造成等待者不均。

### 2. Semaphore/ReadWriteLock 的最小图

```text
Semaphore(permits):
  acquire → permits--
  release → permits++
  → 可公平/非公平
  → 许可耗尽时等待/超时/失败

ReadWriteLock:
  read lock → 多个读者共享
  write lock → 独占
  → 适合明确读写比例与一致性协议

对比:
  thread pool 控制执行线程
  connection pool 控制连接资源
  semaphore 可进一步限制某段临界资源并发
```

### 3. 为什么 Semaphore 不是"连接池的替代品"

因为它只控制许可，不提供连接创建、借还、验证和生命周期。许可数还需和真实数据库容量、事务时长、连接池大小配合。公平性也可能降低吞吐，非公平可能造成等待者不均。

### 4. 本节最该记住的结论：Semaphore 是局部背压器，不能替代完整资源池；ReadWriteLock 适合明确读写比例与一致性协议，许可数需和真实容量配合

## 四、CompletableFuture：用依赖图替代回调嵌套

### 1. 第四个朴素误解：CompletableFuture 链就是"异步的"

默认执行器、thenApply 是否运行在调用线程、阻塞 I/O 是否占用 common pool、异常是否被吞掉都会改变行为。I/O 密集任务通常需要有界、可观测的自定义 executor，并设置 deadline/取消语义。

### 2. CompletableFuture 的最小图

```text
thenApply:
  value → transform value

thenCompose:
  value → async Future
  → flatMap, 避免 Future<Future<T>>

thenCombine:
  Future A + Future B → merge result

allOf/anyOf:
  等全部/任一完成

exceptionally/handle/whenComplete:
  分别表达恢复、同时访问结果/异常、最终观察
```

### 3. 为什么 CompletableFuture 链容易"看起来异步，实际阻塞"

因为默认执行器、thenApply 是否运行在调用线程、阻塞 I/O 是否占用 common pool、异常是否被吞掉都会改变行为。I/O 密集任务通常需要有界、可观测的自定义 executor，并设置 deadline/取消语义。thenApply 用 ForkJoinPool.commonPool 而 thenApplyAsync 用自定义 executor 的区别，必须按 API 方法区分。

### 4. 本节最该记住的结论：CompletableFuture 通过转换、扁平化、组合和异常阶段表达异步依赖；但执行器配置和异常传播必须按 API 方法区分，否则"异步链"会重新变成阻塞

## 五、ForkJoinPool 与 Phaser：工作窃取和动态参与者

### 1. 第五个朴素误解：ForkJoinPool 是"更快的线程池"

ForkJoinPool 用工作窃取提高分治任务利用率，但工作窃取池假设任务适合计算并行，阻塞会占住 worker、降低其他任务进展。分治任务也要有合理 cutoff，Phaser 必须处理参与者异常退出和 phase 永久等待。

### 2. ForkJoinPool/Phaser 的最小图

```text
ForkJoin:
  worker local deque
  → owner 取本地任务
  → 空闲 worker 从其他队列窃取
  → fork/join 分治

任务粒度:
  太小 → 调度/窃取开销超过计算
  太大 → 并行度不足

Phaser:
  register parties
  arrive/await advance
  arriveAndDeregister
  → phase 递进/参与者动态变化
```

### 3. 为什么把阻塞 I/O 直接塞进 common ForkJoinPool 很危险

因为工作窃取池假设任务适合计算并行，阻塞会占住 worker、降低其他任务进展。分治任务也要有合理 cutoff，Phaser 必须处理参与者异常退出和 phase 永久等待。

### 4. 本节最该记住的结论：ForkJoinPool 优化的是可分割计算，不是所有阻塞任务；Phaser 支持动态参与者，但必须处理异常退出和 phase 永久等待

## 六、把本篇收成一张图：同步器的本质是明确谁在等谁、等什么、等多久

现在可以把整篇彻底收回来。

一开始我们要解决的问题是：主线程等待子任务、多个阶段同步和服务并行调用，怎样避免一人失败全员永久等待。答案已经闭环了：AQS 提供 state/队列/阻塞模板，CountDownLatch/CyclicBarrier 处理一次性完成和循环阶段，Semaphore/ReadWriteLock 控制许可和读写协议，CompletableFuture/ForkJoinPool 处理异步依赖和计算调度。每种同步器解决的是不同的问题，选型要看"谁在等谁、等什么条件、等待多久、参与者失败怎么办"。

把这一切压成最短总图，就是：

```text
AQS:
  提供状态/队列/阻塞模板

Latch/Barrier/Phaser:
  阶段与完成条件

Semaphore/Lock:
  许可/互斥/读写协议

CompletableFuture/ForkJoin:
  异步依赖与计算调度
```

所以本篇最该记住的一句话是：**同步器的本质不是"哪个类更高级"，而是明确谁在等谁、等什么条件、等待多久、参与者失败怎么办，以及等待成本放在 CPU 还是队列。**

## 七、几个最容易说错的地方

### CountDownLatch 和 CyclicBarrier 可以互换？

不是。Latch 是一次性完成条件，Barrier 是循环阶段同步；生命周期和异常语义完全不同。

### Semaphore 就是"更灵活的锁"？

不是。它只控制许可，不提供资源创建、借还、验证和生命周期。

### CompletableFuture 链就是"异步的"？

不是。执行器配置和异常传播如果不对，异步链会重新变成阻塞。

### ForkJoinPool 是"更快的线程池"？

不是。它优化的是可分割计算，阻塞任务会占住 worker、降低其他任务进展。

### 自旋多少次最优有一个固定值？

没有。具体策略由实现、竞争时间和 JVM/OS 共同决定。

## 收束：同步器不是选哪个类更高级，而是明确谁在等谁、等什么、等多久

回到开头那个问题：主线程等待子任务、多个阶段同步和服务并行调用，怎样避免一人失败全员永久等待。答案已经闭环了：AQS 提供底层模板，Latch/Barrier/Semaphore/CompletableFuture/ForkJoinPool 各自解决不同的协调问题。选型要看"谁在等谁、等什么条件、等待多久、参与者失败怎么办"，而不是看"哪个类更高级"。

这就是为什么说：**同步器的本质不是"哪个类更高级"，而是明确谁在等谁、等什么条件、等待多久、参与者失败怎么办，以及等待成本放在 CPU 还是队列。** 只要这条主线站稳，下一篇进入限流时，你就不会再把令牌桶、漏桶、滑动窗口看成"独立的限流算法"，而会自然去问：它们分别在哪个位置做背压、如何与熔断和降级协作。

## 下一篇桥接

现在同步原语和异步协作已经建立，最自然的问题就是：**限流算法如何在峰值保护系统，令牌桶、漏桶、滑动窗口和自适应限流又怎样与熔断、降级、隔离协作？**

下一篇 `04-traffic-management.md` 会把视角推进到限流算法、自适应保护、熔断降级与隔离。
