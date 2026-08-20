# AQS 核心：为什么同步器既不能只靠一个 state，也不能只靠一条队列

> 本文基于 JDK 11 `AbstractQueuedSynchronizer`。讨论范围聚焦 `state`、`head/tail`、`Node`、`getState/setState/compareAndSetState`、`enq/addWaiter`、`acquire/release` 与模板方法钩子。`acquireQueued` 里的 park/unpark、自旋与取消清理细节放到下一篇。
> **前置依赖**：[AtomicInteger 与 CAS 封装](../13-atomic/01-atomicinteger-cas.md)、[线程生命周期与中断基础](../11-thread-threadlocal/01-thread-lifecycle.md)
> **后续**：[AQS 的等待与唤醒](02-await-wakeup.md)

## 先看一个最常见、也最容易把同步器想简单了的错误直觉

很多人第一次理解锁或同步器时，都会把问题压缩成一句话：不就是一个 `state` 吗？拿锁时 CAS 一下，从 `0` 改成 `1`；成功就过，失败就再试。这个模型在无竞争、低竞争时确实能跑起来，但它一旦被放进真实并发环境，很快就会露出两个根本缺口。

第一个缺口是：如果 CAS 失败的线程只是原地 while 自旋，那高竞争下它们会一直白烧 CPU。线程没有拿到资格，却又不愿意睡下去，整个系统就会陷入“大家都在抢，但没多少人在真正往前做事”的局面。

第二个缺口是：就算你给失败线程安排一条等待队列，如果没有一个统一的状态事实来源，队列里的人醒来后仍然不知道“现在是不是轮到我了”。队列只能解决“你先去排队”，不能独立回答“此刻谁有资格通过”。

这正是 `AbstractQueuedSynchronizer` 真正在解决的问题：**同步器既不能只靠一个 CAS 状态位，也不能只靠一条等待队列；它必须同时拥有‘资格事实’、‘失败收容’和‘子类语义钩子’这三件东西。**

所以这篇不按字段和方法名平铺源码，而是沿着一条更完整的主线来讲：AQS 为什么要把 `state`、CLH 变体队列和模板方法钩子拼在一起，才能支撑 `ReentrantLock`、`Semaphore`、`CountDownLatch` 这类看起来完全不同的同步器。

## 一、AQS 真正解决的是两个问题：谁有资格，没资格的人去哪等

### 先把“同步器”拆成两类职责

任何同步器至少要同时回答两个问题：

- 现在谁有资格继续往前走？
- 没资格的人应该停在哪里，按什么秩序等？

如果只回答第一个问题，你得到的只是一个共享状态机：线程可以抢 state，但失败线程没有合理去处。反过来，如果只回答第二个问题，你得到的只是一个等待室：线程们排队站好了，却不知道什么时候轮到自己真正通过。

AQS 恰恰把这两件事分开做，再统一收口。源码层面，这个分工体现在三组核心字段上：

- `state`（`AbstractQueuedSynchronizer.java:580`）
- `head`（`AbstractQueuedSynchronizer.java:569`）
- `tail`（`AbstractQueuedSynchronizer.java:575`）

`state` 负责表达同步资格的当前事实；`head/tail` 负责把失败线程收容进一条队列。也就是说，AQS 的本体并不是“一个 volatile int”，也不是“一条 CLH 队列”，而是：**一个资格事实来源，加上一条失败线程收容链。**

### 为什么这对不同同步器都成立

这套分工看似抽象，却正好能被很多同步器复用。对于可重入锁，`state` 可以表示持有计数；对于信号量，它可以表示剩余许可；对于倒计时器，它又可以表示还剩多少步才放行。含义不同，但“这是资格事实”的角色不变。

同样地，失败线程收容的需求也不会变。拿不到锁的线程、拿不到许可的线程、还没等到倒计时结束的线程，都需要一个等待位置，而不是一直在 CPU 上空转。

所以理解 AQS 的第一步，不是记住它是“锁框架”，而是看懂这两个职责：**state 管事实，队列管失败者。**

## 二、为什么 `state` 只能做“事实来源”，具体语义必须由子类提供

### 先别把 `state` 当成“锁标志位”

JDK 11 中，AQS 的核心状态字段定义得非常克制：

```java
// AbstractQueuedSynchronizer.java:580
private volatile int state;
```

再加上三组最基础操作：

- `getState()`（`AbstractQueuedSynchronizer.java:587`）
- `setState()`（`AbstractQueuedSynchronizer.java:596`）
- `compareAndSetState()`（`AbstractQueuedSynchronizer.java:611`）

这三组 API 只告诉你一件事：AQS 提供了一块可见、可 CAS 修改的共享整数状态。它没有说这块状态一定是“0=无锁，1=有锁”，更没说它必须像布尔值那样只在两种状态间切换。

这也是为什么面试里那句“state 为什么是 int，不是 boolean”其实很关键。因为同步器的状态往往天然就是多值的：重入锁需要计数，信号量需要许可数，倒计时器需要剩余步数。AQS 故意只给你一块原材料，不替你规定它的业务含义。

### 模板方法钩子才是真正赋义的位置

真正决定“这个 state 表示什么”的，是模板方法钩子。最典型的是：

```java
// AbstractQueuedSynchronizer.java:1117
protected boolean tryAcquire(int arg) {
```

以及：

```java
// AbstractQueuedSynchronizer.java:1143
protected boolean tryRelease(int arg) {
```

AQS 并不在这里写死独占锁逻辑。相反，它默认只提供“你应该在这里定义如何基于 state 取得资格、如何基于 state 释放资格”的扩展点。不同子类只要覆写这一小块，就能把同一套队列和等待骨架复用到完全不同的同步语义上。

这就是 AQS 被称为模板方法框架的真正原因：**它统一的是排队、挂起、唤醒和骨架控制流；子类补的是 state 的业务解释。**

这一层一定要讲透，否则读者很容易把 AQS 误会成“ReentrantLock 的内部基类”，而看不见它之所以重要，正是因为它把“资格语义”和“等待协议”拆成了可复用框架。

## 三、为什么失败线程不能一直自旋：它们需要一条被唤醒前的收容队列

### 先看只靠 CAS 自旋的失败方案

如果同步器只靠 `compareAndSetState`，那线程失败后最直觉的动作就是继续重试。无竞争时这没问题，甚至很快；但高竞争时，几十上百个线程可能会围着同一块 state 不断自旋，争夺的线程越多，CPU 上花在无效失败重试上的时间越长。

这种方案的根本问题不是“不正确”，而是“不知道失败线程该如何优雅地退场”。它们既没有拿到资格，又没有一个睡眠位置，最后只能靠 CPU 空转来表达“我还在等”。

AQS 不接受这种代价，所以它给失败线程准备了一条 CLH 变体队列，让线程在拿不到资格后，不是继续死磕 state，而是进入可管理、可唤醒、可取消的等待位置。

### `head` / `tail` / `Node` 说明了这是一条真实等待链

AQS 的队列头尾字段很明确：

- `head`（`AbstractQueuedSynchronizer.java:569`）
- `tail`（`AbstractQueuedSynchronizer.java:575`）

失败线程会被包装进 `Node`，再链接到这条等待链里。虽然本篇不展开 `Node` 全部细节，但至少要先建立这样一张图：

```text
head <-> Node <-> Node <-> ... <-> tail
```

每个节点背后都代表一个正在等待的线程，以及它在等待协议中的位置。这里的重点不是背所有 `waitStatus` 常量，而是先理解：**AQS 不是把失败线程扔进一个抽象集合，而是把它们放进一条有前后关系的链路里，后续唤醒和前驱判断都依赖这条链。**

### 为什么 `enq` 的 CAS 尾插是并发入队的关键

线程并发入队时，最怕的是“两个线程都以为自己接到了尾巴后面”。AQS 的 `enq()` 在 `AbstractQueuedSynchronizer.java:629`，核心就是用 CAS 抢占尾指针，让多个失败线程也能安全地排进同一条队列。

它的语义非常清楚：

- 先读当前 `tail`
- 把新节点的前驱指到旧尾
- CAS 抢占 `tail`
- 成功后再把旧尾的 `next` 接上自己
- 失败说明别的线程先入队了，重试即可

这条线说明，AQS 不是口头上说“有个等待队列”，而是把并发失败线程如何进入这条链也设计成了统一协议。

这一层的顿悟是：**队列不是公平性的装饰，而是失败线程的停泊区。没有它，CAS 失败的线程只能在 CPU 上自旋发抖。**

## 四、为什么模板方法能让 AQS 变成通用同步器：骨架统一，语义留给子类

### 先回答“为什么这些同步器长得不像，却都能复用 AQS”

`ReentrantLock` 要解决的是独占重入，`Semaphore` 要解决的是多个许可并行放行，`CountDownLatch` 要解决的是计数归零后一次性开门。它们在业务语义上几乎不像同一家族，但从 AQS 视角看，它们都可以拆成同一个骨架：

- 先看当前 `state` 是否允许通过
- 不允许就把线程送进等待队列
- 条件变化后再按队列顺序推进

差异只在于“什么时候算允许通过”与“释放后怎样改变 state”。而这正好是 `tryAcquire` / `tryRelease` 这类钩子负责的部分。

### AQS 统一了什么，子类又只需要管什么

AQS 统一的东西包括：

- 失败线程如何入队
- 何时从队首再尝试获取
- 释放后怎样推进后继
- 取消和等待的基本骨架

子类只需要管：

- 这个 `state` 到底代表什么
- 在当前语义下，获取成功条件是什么
- 释放成功条件是什么

这就是为什么 AQS 的强大不在于“它实现了一个锁”，而在于**它把同步器里最麻烦、最容易写错的排队等待协议做成了基础设施。** 子类不用重新发明一套等待队列和唤醒链，只要把自己的状态语义嵌进去就行。

## 五、`acquire` / `release` 为什么是整套骨架的总收口

### `acquire` 的关键不是代码短，而是顺序正确

AQS 的独占获取总入口在 `AbstractQueuedSynchronizer.java:1238-1240`：

```java
// AbstractQueuedSynchronizer.java:1238-1240
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))
```

这段代码最重要的不是“一行很帅”，而是它把整套同步器骨架压成了一个正确顺序：

1. 先 `tryAcquire(arg)`，给无竞争或轻竞争场景一次直接成功机会
2. 只有失败了，才 `addWaiter(...)` 进入等待队列
3. 进入 `acquireQueued(...)`，开始受队列和后继唤醒协议管理

这就是 AQS 一直坚持的乐观路径：**先试，失败才排队。** 如果一开始就无条件排队，那无竞争路径也会平白承担队列开销；如果失败后又不排队，就会退回前面说的自旋浪费。

### `release` 的关键不是改 state，而是推动后继前进

释放总入口在 `AbstractQueuedSynchronizer.java:1301-1305`：

```java
// AbstractQueuedSynchronizer.java:1301-1305
public final boolean release(int arg) {
    if (tryRelease(arg)) {
        Node h = head;
        if (h != null && h.waitStatus != 0)
            unparkSuccessor(h);
```

这段代码再次体现了分工：`tryRelease(arg)` 由子类决定当前语义下是否真正释放成功；一旦释放成功，AQS 就去看等待队列是否需要推进后继。也就是说，释放不是“state 改完就结束”，而是“**state 改完后，后面排队的人有没有资格被叫醒继续争取通过**”。

这也是为什么前面一直强调 state 和队列不能拆开：只有 state，没有后继推进，等待线程会饿死；只有队列，没有 state 变化事实，唤醒又不知道为什么发生。

### 为什么下一篇必须接着讲 park/unpark

本篇刻意停在 `acquireQueued` 的入口处（`AbstractQueuedSynchronizer.java:906`），不立刻深入 park/unpark 和取消清理，是因为这一篇的任务是先建立骨架：资格事实、等待收容、模板钩子、获取/释放总收口。只有这张总图先立住，下一篇再看线程怎么真正睡下去、怎么被前驱状态决定是否该 park、取消节点怎么清理，读者才不会迷路。

## 收网：AQS 真正拼起来的是“资格事实 + 失败收容 + 子类语义”

现在回到开头那个错误直觉，就能看清为什么“一个 CAS state 就够了”这句话在真实同步器面前站不住了。只靠 state，失败线程没有优雅去处；只靠队列，线程醒来后不知道自己是否真的该过；只靠子类手写语义，又会让每个同步器都重复实现一套易错的排队等待协议。

AQS 的价值，恰恰就在于把这三件事拼成了可复用骨架：

```text
state
  → 当前同步资格的单一事实来源

CLH 变体队列
  → 获取失败线程的停泊与推进秩序

模板方法钩子
  → 让不同子类为 state 赋予不同语义

acquire / release
  → 把“先尝试、失败再排队、释放后推进后继”收成统一流程
```

所以，AQS 不是“某个锁的源码细节”，而是 Java 并发库里一套通用同步器框架。`ReentrantLock`、`Semaphore`、`CountDownLatch` 这些看起来很不像的工具，之所以能站在同一地基上，正是因为它们共享了这套“资格事实 + 排队等待 + 子类钩子”的骨架。

下一篇继续沿着这条线往下走：线程已经排进队了，它到底什么时候真正 park？前驱节点为什么要承担 SIGNAL 语义？被中断或超时取消的节点又怎么从队列里退出？这些才是 AQS 从“骨架”走向“等待与唤醒细节”的下半场。