# ThreadLocal 在线程池里为什么既传不进去、又容易泄漏：一次继承失效和一次清不掉的值

> 基于 JDK 11 `ThreadLocal`、`InheritableThreadLocal`、`ThreadLocalMap` 与 `Thread` 构造器。本文讨论的是线程池场景下 ThreadLocal 的两种典型失败：`InheritableThreadLocal` 为什么在线程池里"不继承"、普通 `ThreadLocal` 为什么在线程池里"不释放"。这里的继承时机与清理路径是 JDK 11 当前实现，不能把 `InheritableThreadLocal` 的"构造时复制"外推成任务级上下文传递的通用机制。
> **前置依赖**：[ThreadLocal 原理与内存泄漏](../11-thread-threadlocal/02-threadlocal.md)、[线程池的 Worker 生命周期](../14-threadpool/02-execute-worker.md)
> → **后续**：[线程池生产治理](../42-production-practice/01-thread-pool-governance.md)

## 先看两个几乎每个线上服务都踩过的坑

第一个坑：业务上下文传不进去。你在入口线程里往 `InheritableThreadLocal` 塞了用户信息，期望提交给线程池的任务自动带上这份上下文。测试单线程没错，代码一上线，任务里读到的却是 `null`。这不是"有时候成功有时候失败"的偶发性，而是线程池场景下结构性的失效。

第二个坑：值清不掉。你在任务里用 `ThreadLocal` 暂存数据，任务跑完以为自己把它归还了。可在线程池里，这个值没有被移除的话，下一次复用到同一 worker 的任务就会读到上一次残留的数据。更麻烦的是，即使你出口处调用了 `remove()`，也可能在以下场景留下脏值：任务异常路径中 `finally` 块没有被执行到（例如 `System.exit` 或 `segfault` 级别的致命错误），或者 `beforeExecute` 注入值后 `afterExecute` 清理时只检查了 `t == null` 才清理，而 `submit` 路径的异常被 `FutureTask` 吞掉，`t` 为 null 时清理逻辑并未执行。

这两个坑背后其实是两个完全不同的机制问题，但它们都源于同一个事实：**ThreadLocal 的值是挂在"线程对象"身上的，而线程池恰恰要复用并长期持有线程对象。** 线程的复用周期和任务的执行周期不一致，ThreadLocal 的生命周期就必然和任务脱节。

这里至少有三个失败方案在真实团队里反复出现。

第一种失败方案，是以为 `InheritableThreadLocal` 在线程池里也能像普通 `new Thread()` 一样自动传递上下文。它把"线程创建时继承"这个时机，误当成了"每个任务执行前都继承"。

第二种失败方案，是任务结束时只依赖"线程池会复用，所以应该自动干净"。一些人甚至以为 worker 线程结束任务后会清掉自己的 ThreadLocal，完全忽略了线程池的 worker 并不随任务结束而消亡。

第三种失败方案，是用 `try/finally` 包住任务、在 finally 里调用 `remove()` 时，又没意识到任务抛异常时上下文可能已经写到一半，直接 `remove()` 会把本该在下游继续使用的值也给清掉——把清理和业务语义搅在了一起。

所以这三个失败方案指向同一个顿悟：**在线程池里用 ThreadLocal，必须先回答"值跟着谁走、什么时候到、什么时候走"。跟线程走，就要忍受复用污染；跟任务走，就要在任务边界显式传、显式清。**

## 一、`InheritableThreadLocal` 为什么在"新线程"上有效、在线程池上失效

### 继承发生在线程对象构造时，而不是任务提交时

先立住最核心的事实：JDK 11 里，`InheritableThreadLocal` 的传播发生在 `Thread` 构造函数里。当子线程对象被 `new` 出来时，会读取创建者线程的 `inheritableThreadLocals`，把它的内容复制一份给新线程：

```java
// Thread.java:443-445(截取核心,逐字)
if (inheritThreadLocals && parent.inheritableThreadLocals != null)
    this.inheritableThreadLocals =
        ThreadLocal.createInheritedMap(parent.inheritableThreadLocals);
```

这段代码出现在 Thread 构造器的初始化逻辑里。也就是说，继承是"从一个正在创建线程对象的线程，复制到另一个即将出生的线程对象"。

`InheritableThreadLocal` 之所以特殊，只是因为它覆写了两个入口：让 `getMap` 和 `createMap` 指向 `inheritableThreadLocals` 这张表，再通过 `childValue` 允许在复制时对值做一次转换（`InheritableThreadLocal.java:66`）。它没有改变"复制发生在构造时"这个事实。

### 线程池里为什么不继承

现在把线程池放进来。线程池的工作方式是：提前创建好一批 worker 线程，然后不断把任务交给这些线程执行。任务的提交并不触发 `new Thread()`；worker 是老早就生出来的，它的 `inheritableThreadLocals` 在出生那一刻就已经定死了。

于是链条就断了：

```text
线程池启动
  → 创建 worker 线程对象（此时继承父线程的 inheritableThreadLocals）
  → 但这批 worker 的"父线程"是启动线程池的线程，不是提交任务的线程

任务提交
  → 只是往 workQueue 里放
  → 没有 new Thread()
  → 不会重新执行 Thread 构造器里的复制逻辑
  → 任务读不到提交者新塞进 InheritableThreadLocal 的值
```

一句话总结：**`InheritableThreadLocal` 复制的是"worker 出生时"父线程的快照，不是"每次任务提交时"调用方线程的快照。** 线程池把多个任务的提交者压缩到一个复用线程身上，快照语义自然不成立。

### 一个容易误判的中间态

有人会抱着希望问：那如果提交者和启动线程池的线程是同一个，是不是就能传进去？答案是：只有第一次提交时可能"碰巧"对，因为此时 worker 的 `inheritableThreadLocals` 还停留在启动那一刻，如果那之后调用方在线程池启动的同一线程上更新了值，worker 也看不到；而第二次提交的任务，上下文已经被按 worker 自己的生命周期处理了。换句话说，它连"第一次能对"都不稳定，更谈不上可靠的任务级传递。

## 二、普通 `ThreadLocal` 为什么在线程池里容易泄漏：值跟线程走，不跟任务走

### 线程结束才会清，线程池的 worker 不结束

JDK 11 的 `Thread.exit()` 会在线程即将消亡时把两个表都清掉：

```java
// Thread.java:848-851(截取核心,逐字)
...
threadLocals = null;
inheritableThreadLocals = null;
```

这行代码只在"线程真正结束"时执行。对普通 `new Thread()` 来说，任务跑完线程就结束，表随之清空，泄漏窗口很小。可线程池的 worker 不一样：任务结束不等于线程结束，worker 会回到 `getTask()` 继续等下一个任务。于是：

```text
普通线程
  → 任务结束 → 线程结束 → threadLocals = null → 值被释放

线程池 worker
  → 任务结束 → 线程还活着 → threadLocals 仍在
  → 值没 remove 就一直挂在 worker 身上
  → 下一个复用到该 worker 的任务，能看到上一个任务塞入的值
```

这就是"串值"和"残留"的根源：不是 ThreadLocal 有问题，而是线程池把"线程级别的生命周期"拉得比"任务级别"长得多。

### 值为什么还会变成泄漏而不是只串值

如果只是串值，至少还能在日志里看到脏数据。真正积少成多的是：当 `ThreadLocal` 的 key 是弱引用、外部又不再持有 key 的强引用时，map 里会留下 key 为 null 的 `Entry`，而 value 仍被强引用。worker 线程活着，这张 `ThreadLocalMap` 就活着；一直不复用、不 `remove()`、不触发 map 清理，value 就会一直被握着。线程池的 worker 数量通常有限，但每个 worker 握住的可能是大对象，累积起来就是明显的驻留内存。

到这里已经走完两条主线了：`InheritableThreadLocal` 为什么传不进去，普通 `ThreadLocal` 为什么泄漏。接下来这一节是"追问层"——不是新机制，而是回答一个面试和生产里最容易被问住的问题：为什么失效表现"看起来像随机"。

## 三、为什么 `InheritableThreadLocal` 的失效"看起来"有时有有时没有

### 多个 worker、多个提交者时，行为像随机

我前面说这个失效是"结构性的"，但很多人在现场观察到的表现却是"时好时坏"。原因不是机制本身摇摆，而是观察者把"worker 首次创建时的继承"和"每次任务提交时的继承"混在了同一条时间线里。

设想线程池核心线程数 4：
- 启动时，4 个 worker 出生，各自拿到"启动线程快照 A"
- 请求 1 在线程 X 上更新 InheritableThreadLocal 为 B，提交任务 1，worker 1 拿到任务
- 请求 2 在线程 X 上继续更新为 C，提交任务 2
- 任务 1、任务 2 跑在哪个 worker 上，读到的是 A（全是出生快照），不是 B、C

可如果线程池后来因为任务量大补建了 worker 5、6，这两个新 worker 出生时父线程可能是正在提交请求的线程，于是新 worker 第一次拿到的上下文又"看起来像传进去了"。这就是"一会儿对、一会儿不对"的真相：**对的那几次，其实是恰好触发了新 worker 的创建。**

### 这解释了为什么面试里这个问题要往"构造时 vs 任务时"上答

如果只背"线程池里 InheritableThreadLocal 失效"，面试官再追问"那为什么有时候又能拿到"，就容易卡住。完整答法是：`InheritableThreadLocal` 的复制发生在 Thread 构造时，线程池复用老线程没有构造动作，所以平时失效；但线程池扩容新建 worker 的那一刻，新 worker 会按父线程快照初始化，造成"偶尔传进去"的假象。

## 四、正确姿势：上下文传递和清理都要落到"任务边界"而不是"线程边界"

### 传递不止一条路

既然线程池里不能靠 InheritableThreadLocal，生产场景有几种常见做法，它们的共同点是把"值"的流动从线程生命周期里拆出来：

- 把上下文作为显式参数传进任务，这是最直观、零状态的做法
- 用线程池包装或 `beforeExecute`/`afterExecute` 钩子，在每个任务执行前注入、执行后清理——本质上把 ThreadLocal 的"写"和"清"都绑定到任务生命周期
- 用专门的上下文透传库（例如 TransmittableThreadLocal 这类中间件）实现快照捕获与任务级回放

这些做法的共性，正是这次失败方案已经点破的方向：**值不再"跟线程走"，而是"跟任务走"；发送方在任务开始前捕获，接收方在任务开始时注入，任务结束时负责清理。**

### 清理为什么要和异常路径一起考虑

第三种的 finally 里 `remove()` 看似安全，但要分清"这个任务结束后值是否还有用"。如果这个值只属于当前任务，finally 里 `remove()` 是标准做法；但要注意 `beforeExecute` 注入的值，`afterExecute` 清理时如果只按 `t == null` 判断成功才清理，异常路径就可能残留。这里的取舍是：要么把清理放在更外层的 finally，要么让注入和清理配成一对。

## 五个最容易混掉的边界：Inheritable 是构造时复制不是任务时复制，threadLocals 是线程级不是任务级，失败不是随机是没有重新构造，泄漏不是 key 是 value，remove 也不是无脑 finally 就完事

第一，`InheritableThreadLocal` 是构造时复制，不是任务时复制。它的继承代码在 `Thread` 构造器里，只有 `new Thread()` 才触发；任务提交不构造线程，所以任务级上下文长期靠它传递是不可靠的。

第二，`threadLocals` / `inheritableThreadLocals` 是线程级状态，不是任务级状态。值的存活跟随线程对象，线程池复用 worker 时，任务结束不等于值结束。这是所有串值和驻留问题的总根源。

第三，"时对时不对"不是随机失败。它多半是线程池扩容时新建了 worker，新 worker 在构造瞬间按父线程快照继承了上下文；下次又不继承。把"新 worker 出生"和"任务提交"当成同一件事，才会觉得行为反复。

第四，泄漏的主要负担不在 key 而在 value。key 是弱引用，外部不持有 key 时 key 会被回收；但 value 被 Entry 强引用，worker 活着、map 不清理、原地不 remove，value 就一直驻留。

第五，`remove()` 也不是无脑 finally 就完事。清理要和注入配对、要考虑异常路径；在自己注入的值之外，还要想清楚这个任务的上下文对这个 worker 的下一个任务是否还有意义。

把这五条边界记稳，线程池里的 ThreadLocal 就不会再被简化成"`InheritableThreadLocal` 能传、`remove()` 能防泄漏"两句口诀。它真正想讲的是：ThreadLocal 的生命周期以线程为单位，而线程池把任务压进复用线程里执行；想让状态按任务流动，必须把捕获、注入和清理都显式绑定在任务边界上。

## 收网：在线程池里，ThreadLocal 的"传"和"清"都必须从线程边界挪到任务边界

回到开头那两个坑，现在可以看清它们是同一枚硬币的两面。

`InheritableThreadLocal` 失效，是因为它把继承绑定在"线程构造"这个时机上，而线程池复用的是早已出生的 worker，不随任务重新构造。普通 `ThreadLocal` 泄漏，是因为它把值绑定在"线程对象"上，而 worker 被池子长期持有，不复用、不清理，value 就一直在。

把整篇压成一张总图：

```text
普通 new Thread()
  → 任务结束 → 线程结束 → threadLocals 清空
  → 泄漏窗口小，传递靠线程继承

线程池 worker
  → 线程复用，不随任务结束
  → InheritableThreadLocal：只在 worker 出生时复制一次，提交任务不触发
  → 普通 ThreadLocal：worker 不结束就不清，value 可能长期驻留
  → 正确姿势：beforeExecute 注入 / afterExecute 清理 / 或显式参数传递
```

所以当你决定在带线程池的代码里使用 ThreadLocal 时，真正要问的不是"哪种 ThreadLocal 变体线程安全"，而是：**这份值的生命周期以什么为单位？** 如果以任务为单位，就别让值挂在以线程为单位的容器里；如果必须以线程为单位，就要从一开始接受它的复用污染，或用任务级的捕获与回放把生命周期切回任务。