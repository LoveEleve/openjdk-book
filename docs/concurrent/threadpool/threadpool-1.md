# 线程池学习笔记（1）：ThreadPoolExecutor

jdk11线程池的学习笔记

## 介绍
### 思想
<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MWVkMDU4MmE0MTI1MTI3M2I5NWYxM2JiODBiYzQ0NGVfckY0cDkxTUNPUEJVSFNQcGh4MjNuQ0pSbzJWNWw4SWpfVG9rZW46THl1RGJQQUtVb1hUNEx4YVBGOWNWSTVObnpoXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



进程是资源分配的最小单位(或者说是程序的动态实例)，线程是CPU调度的最小单位。 但是我想表达的是线程的目的(职责)就是执行"用户"给它的任务,不管是我们启动的线程,还是框架或者是内核线程,它们的职责就是**执行任务**。

当面对任务请求时，一种粗暴的方式就是使用一个线程来完成这个请求，但是问题是任务请求的数量和请求频率是无法预估的,如果每来一个任务就创建一个线程来处理会存在什么问题？

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=Y2FjZDVjNjYwMDM1ZjRlYTNmN2ZiMjFmMDM5ZDY1YTRfcWtZRlFDenA0QWhnVFVyemxXR2t1N0lWNXpXQlFuR1BfVG9rZW46Rm5SeWJvWGFMb1JmWUx4SXgzN2NpTkdkbmZoXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



1. CPU资源：频繁的创建和"销毁"线程 - - **用户态和内核态的上下文切换频繁**
2. 内存资源：线程对象本身需要占用一定的内存
3. CPU资源：当线程数远远大于CPU核心数时,CPU为了保证各个线程能尽可能的公平执行,在每个线程运行一段时间后会根据OS的调度策略来选择下一个要执行的线程，所以这里就会涉及到频繁的**线程上下文的切换**
4. CPU利用率下降：在用户的角度上,虽然CPU一直在跑,但是由于大量的线程上下文切换,导致CPU绝大部分时间都在忙于线程切换了,而真正执行用户任务的时间相对就少了。

所以为了**缓解**上述问题：就引入了线程池，线程池的核心思想其实就是**池化技术**,避免线程的无限创建。并且通过参数暴露来运行用户影响线程池的行为。

### 类关系图
<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MWE3YzI1ZmYxMjZmOWIwYjE4ZGJkNGVlMGJhYThhOTFfN3VCZDN5WXRuSVdLYnlhaWx6azlyN0xtODRjc1MxTkFfVG9rZW46S210MGJsUHlNb05Db2Z4OFk2T2NoaHVhbkVmXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
public interface Executor {
    void execute(Runnable command);
}
```

该接口为线程池的顶级接口,该内部只定义了一个行为：执行,参数为要执行的任务。 这样的设计思想为：将**任务的提交**与**任务的执行**分离开来(职责划分),开发人员只需要专注于任务(或者说是业务的编写)，而不用关系具体是如何被执行的。

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MDE0ZDJjYTUwMzlmZTAyYTA4MzA4YjNmYTQ3Y2MxMzVfb011NWExQzNkeWQwelAzQURDY1Z0dVJQdERodHM2anBfVG9rZW46TlZTNGJrME1xbzgwdXh4bjhRbWNQZFRrbm9kXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



## ThreadPoolExecutor源码解析
线程池一般使用流程：创建 -> 执行提交的任务 -> 关闭。所以对应线程池来说它应该是有状态的，比如刚刚创建时处于NEW状态，执行提交的任务时处于RUNNING状态，关闭时处于TERMINATED状态，所以这里就会涉及到线程池的状态流转。「在这里只是说明一下线程池是具有状态的,具体的状态转换则在后续介绍。」

### 构造函数
线程池完整的构造函数拥有7个入参,不同的参数配置会影响着线程池行为

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ODU1YjAwMzg5OGYxZTM5OTUxZGQ3NzM5Y2NiZmM0ZTFfT2hpclhRc1VEcEVjWlVtdlB3alZ2eXJiY3htckdPOE1fVG9rZW46VllqZmI5SU1sb1kyOGF4Rks2YWNhMHR0blZaXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)

构造函数入参

构造函数进行相关属性的赋值

```plain
public ThreadPoolExecutor(int corePoolSize,
                          int maximumPoolSize,
                          long keepAliveTime,
                          TimeUnit unit,
                          BlockingQueue<Runnable> workQueue,
                          ThreadFactory threadFactory,
                          RejectedExecutionHandler handler) {
    if (corePoolSize < 0 ||
        maximumPoolSize <= 0 ||
        maximumPoolSize < corePoolSize ||
        keepAliveTime < 0)
        throw new IllegalArgumentException();
    if (workQueue == null || threadFactory == null || handler == null)
        throw new NullPointerException();
    this.corePoolSize = corePoolSize;
    this.maximumPoolSize = maximumPoolSize;
    this.workQueue = workQueue;
    this.keepAliveTime = unit.toNanos(keepAliveTime);
    this.threadFactory = threadFactory;
    this.handler = handler;
}
```

下面通过官网的介绍来简要的学习一下线程池的行为：

1.官网的介绍链接 [ThreadPoolExecutor (Java SE 11 & JDK 11 )](https://docs.oracle.com/en/java/javase/11/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MmUyYTZjNGUzZmIwZDdhOGFkZjU5ODM3OTAxY2FhOTBfNWI4UVYxY01VU0hvbDhxU1FiSU8zWG5Vczdsa3ZkRE1fVG9rZW46S01KWmJoVENjb1Z0aTB4QmpCQWN3NVJvbnpmXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)

核心工作原理

### 类关系图
<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=OWNhN2M0NzAyYTFkMjgwZTQ2ZTM3YjMxYmJlN2Y2NTZfNUpNUUpBSldDV0FaY0g1NGQzcHRUR3Mxc3JqVW1FM0dfVG9rZW46QVJpTGJYamdKb1JUMDd4aTRMb2NIQ3pibkU5XzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



### 类属性
```plain
private final AtomicInteger ctl = new AtomicInteger(ctlOf(RUNNING, 0));
```

在线程池中使用一个原子整型,并且将其分为不同的部分 - 线程池的工作状态(state) 和 当前工作的线程数(workThreads)。具体的划分为：高3位用来表示线程池的工作状态,低29位用来表示当前工作的线程数。

初始状态如下：&#x20;

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZWQ2MjFkZGY0YTVhMjQ4ZGEwZGQ0NGQ4ZDJiMWMyMzhfZjVkdGkzenMxaUhnbVZKa0ZWWDBYYWhBNGlqMm14N2NfVG9rZW46RTdLUGI5ZHk4b3Aya3p4S1NCM2NJc3publdnXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



使用一个原子变量来存储多个信息的好处： 1.**单个CAS操作能够同时更新线程池工作状态和工作线程数(主要)** 2.内存占用更少

### 源码解析
<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NWY3YWFkNmFjZmQ1ZTllOWE2NjAyMjQ5OWU5Y2JlYjVfU3FQQm9aWkNLN2dLZ2I1YU9yeGtVQ1c5UERsV29WSFRfVG9rZW46WUFEemJPQWs0b1ZSazF4aUxGamM2Y09tblljXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



向线程池中提交任务：线程池此时的状态为：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NTU2YzlhNjk5YjhjYjYwNTNkZjU0NTUxMDFiZjA0YjJfM0lqOGRGSnhsVUMwbElKSFZ4Umlob2dEZGt0N3VvYmxfVG9rZW46UEJnMmJSZ1JObzVlUDl4UmE2MGNFRjBLbmdaXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



在这个execute(run)方法中,doug lea也写了注释来描述提交时的工作原理,而代码就是对原理的实现,在这里先复述一遍其工作原理，然后再去看代码：&#x20;

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ODIzNTFmMzI2YmJlOGE5NGQ2YjQ5N2Y0ZjcyYWUzMzVfTmhubWx6elhRYlV4YUhZWlVXSEFLbjlSOGgyemJLaGJfVG9rZW46RzhXYmJwVzJwb0h6R2p4OFVjUmNBSmVIbjdiXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
public void execute(Runnable command) { 
    if (command == null) // 如果任务为空,那么直接抛出异常
        throw new NullPointerException();
    int c = ctl.get(); // 获取线程池的ctl
    if (workerCountOf(c) < corePoolSize) { // 如果线程池当前的工作线程数 < 核心线程数
        if (addWorker(command, true)) // 那么通过addWorker(command)来新增一个线程,并且将该command作为该线程的第一个任务来执行
            return; // 创建成功,则直接返回
        c = ctl.get(); // 如果创建线程失败,那么重新获取ctl,并且继续执行
    }

    if (isRunning(c) && workQueue.offer(command)) { // 如果线程池还处于Running状态,并且offer()成功「入队成功」
        int recheck = ctl.get();            // 那么进行double check,再次校验线程池的状态,如果已经不处于Running状态了,那么移除刚刚入队的任务
        if (! isRunning(recheck) && remove(command))
            reject(command); // 并且执行拒绝策略
        else if (workerCountOf(recheck) == 0) // 否则,线程池还处于Running状态,但是工作线程数为0,那么为了保证刚刚入队的任务能够被执行,那么需要添加一个新的任务
            addWorker(null, false);
    }
    else if (!addWorker(command, false)) // 否则进入到该分支 - 两种情况：线程池处于非Running状态 或者 线程池处于Running状态,但是offer()入队失败
        reject(command);
}
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZmU0N2VjYTdlYTcyYTc4MmU4NGY1YWVhYThkNDM0Y2VfNHdGSWZvdEh1ZTNzUTdlQ2RzVjltQlVDYkNYa3RTRVNfVG9rZW46SVVWS2JyZE5EbzNSdEF4TUNzM2NYRlh4blJmXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)

addWorker()源码讲解

该函数的入参为：该线程是否有第一个任务 以及 是否以corePoolSize作为线程数量的边界 , 此时再回顾一下线程池的状态

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MjVmZmQyYWJlMWY5OTk5MTljNGUwNGI3ZDhlNzQxZDBfQm1MN2NDUWl2bjVLRzJ2Nkxka3UwWUV6bGZ6MWV6MkNfVG9rZW46R0pqZ2JZTWhOb1VGZEt4dWZFMmNhNnZrblplXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



线程池的状态类型如下：

```plain
private static final int RUNNING    = -1 << COUNT_BITS;
    private static final int SHUTDOWN   =  0 << COUNT_BITS;
    private static final int STOP       =  1 << COUNT_BITS;
    private static final int TIDYING    =  2 << COUNT_BITS;
    private static final int TERMINATED =  3 << COUNT_BITS;
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NWMxZGJjYzVhNDk3MmYxYTE5ZjljM2RkZmE3MDI2MDFfTjJqZ0tyMFpoVWU3YzdxM3dKeW5jVGFUcEQwYzFvR1dfVG9rZW46TGR3UGJaS0Fxb0ZqZlV4aks0V2M1cExPbkZMXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



+ addWorker()源码解析

第一部分代码逻辑如上图所述：如果连条件1都不满足，那么说明当前线程池的状态为Running。 否则条件1+条件2-1说明当前线程池的状态>=STOP,如果firstTask==null && workQueue == empty,那么此次新增线程来执行任务失败。这是什么意思？代码如下

```plain
for (int c = ctl.get();;) { // 获取当前最新的ctl
    if (runStateAtLeast(c, SHUTDOWN)  // 线程池的状态需要>=shutdown
        && (runStateAtLeast(c, STOP)
            || firstTask != null
            || workQueue.isEmpty()))
        return false;
```

再细分一下：&#x20;

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZWUzM2JlNmViNmVkYjA1ZDFiZTVjZDEyZGZlOTlhY2RfVG92VFBkbnI5MmZlWml0SzRoM3lHTFNVMG9lNDBpQjRfVG9rZW46Tnc0bmI3Y1dOb3BTY2J4UHoxemNjZk5JbkRoXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



当条件1 = true，并且条件2-1 = true时,那么条件2-2/3是不起作用的,此时线程池的状态 >= STOP,也即至少是STOP,那么添加新线程来执行任务会失败，此时addWokrer()会返回false,同样,在execute()方法中，也不会执行第二个if,而第三个分支则会被命中,也即执行reject()策略,也即：当线程池处于STOP状态(具体来说是>=STOP状态)时,线程池是拒绝接收新的任务的！！

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YjVmOGQwOTc4OGExMDViYThhYTRlYWFlNGRiOGQyMmNfMWFBSVBwWDFPRHNrWUhRZXQwSjRrV3FwODRKdWRFZEJfVG9rZW46QTFCV2JmSWFZb00yMlN4QmIxQWNpc1FSbnhkXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



当条件1 = true，并且条件2-1 = false时，这代表线程池此时处于shutdown状态,并且如果此时firstTask!=null，那么也会返回false。同样不会进入到第二个if，会命中第三个分支，也即执行reject()策略，也即当线程池处于shutdown状态时，线程池拒绝新的任务

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MTlhMDdhODFiMTlmYzFkZGNkYjgwNWY4YTVlNTViZjJfTnlPTjVKUVJXdXlVWnFGa3NsZUJYQzRxYzd6aHVzdGhfVG9rZW46Vm4wNWJGM0JGb3hYeDB4WUM3a2NVdkhzblJlXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



在上面的基础上，如果线程池处于shutdown状态,并且不能添加新任务，并且工作队列中没有任务需要被执行了,那么也会返回false，然后执行拒绝策略，这说明：当线程池处于shutdown状态时，但是如果工作队列还有任务需要被执行，那么是可以新增线程来完成队列中未完成的任务的。

得出结论：**一个新的问题&#x20;**： _那么当线程池处于stop状态时，队列中的任务会被如何处置呢？_

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZTE5NWQ1Y2FhNzFiZTIwZTQ2NGE1NjAyODIxMjgyODNfMEhaQW1JNHhJYno1aXVyYWZ6RVYzQ3hvSXcyRjlOdUJfVG9rZW46RkNJbGJZdU5Bb0dnMnp4OENMOWNBc2EybmtoXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



当然这里不是主线分支,因为此时线程池还是处于Running状态呢，那么继续看下面的代码：

```plain
private boolean addWorker(Runnable firstTask, boolean core) {
    retry:
    for (int c = ctl.get();;) { // 获取当前最新的ctl
        if (runStateAtLeast(c, SHUTDOWN)  // 线程池的状态需要>=shutdown
            && (runStateAtLeast(c, STOP)
                || firstTask != null
                || workQueue.isEmpty()))
            return false;

        for (;;) {
            if (workerCountOf(c) // 获取工作线程数 
                >= ((core ? corePoolSize : maximumPoolSize) & COUNT_MASK)) // 线程数限制边界由core决定,不管怎么样,超过了线程的限制都会返回false
                return false;
            // 否则,没有超过线程限制,那么cas增加工作线程数 - 但是此时线程还没有启动,成功操作后,则结束该阶段的执行,进入下一阶段
            if (compareAndIncrementWorkerCount(c))
                break retry;
                                                // 否则,走到这里,说明上面cas失败,也即多个线程同时提交任务,那么在这里会重试,但是不是简单的重试
            c = ctl.get();  // Re-read ctl 
            if (runStateAtLeast(c, SHUTDOWN)) // 在这里会重新获取线程池的状态,如果>=shutdown,那么重新执行外层的大循环
                continue retry; 
            // else CAS failed due to workerCount change; retry inner loop  // 否则只是执行内层的小循环(也即线程池还处于running状态)
        }
    }

    // 省略下面的代码
```

这里的代码逻辑比较清晰了,如果没有超过线程限制,并且线程池还是处于running状态，那么在这里只是cas将工作线程数+1,但是还没有启动线程,继续看下面的代码

```plain
boolean workerStarted = false; 
boolean workerAdded = false; 
Worker w = null;
try {
    w = new Worker(firstTask); // 创建worker对象,并且首任务作为参数
    // 省略下面的代码
}

// Worker()构造函数
Worker(Runnable firstTask) {
    setState(-1); // inhibit interrupts until runWorker 在runWokrer()执行之前,禁止中断
    this.firstTask = firstTask;
    this.thread = getThreadFactory().newThread(this);
}
```

此时的状态如下：在这里有两个关键点：1.设置state为-1来防止过早中断，以及创建线程时,传入的Runnable是当前worker对象,那么对应的线程在启动之后,执行的则是worker.run()方法,而不是用户的run()方法

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZTVmNzBhNDQ0ZTU5MGI3OGQzYTBmMTdmZDUxMGZkOTBfUWlwTExSY1dKSlRhTXl2Q0NrQmNydngxamloTkJleDZfVG9rZW46TVJXUmJtOUdMb0xZTXp4UlQ2YWNSTUZObnpiXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)

worker状态

那么在这里将state设置为-1的意义是什么呢？&#x20;

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NzExMGI3Mjk1MjljZWViZjAwOTA1MDA3NGJkNmVkMjJfdUIyeVZ6dGlSalVVa1BvTmRScjNyZ0xiUnVxWVNCUUJfVG9rZW46T2VNYmJIeVJ4b3pBelp4aERlT2NBa3g4bmdlXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



看worker初始化时候的注释：inhibit interrupts until runWorker : 禁止中断直到runWorker()被执行.

runWorker()是什么？前面说过在创建线程的时候会把对应的worker对象传入进去(worker对象本身就是一个runnable),那么线程最终在执行的时候,回调的就是worker的run()方法，而在该run()方法中就会调用runWorker()方法,并且也把自己传入进去了，当然最终肯定是要执行this.task.run()的。

```plain
public void run() {
    runWorker(this);
}
// - - - 
final void runWorker(Worker w) {
    // ....
    w.unlock(); // allow interrupts
    // ....
    task.run();
    // ....
}
```

而在runWorker()中,在执行task.run()之前会执行w.unlock()

```plain
// 在这里会将state+1,也即从 -1 -> 0 
public void unlock() { release(1); }
```

而执行到runWorker()则代表线程已经开始运行起来了,换句话说，工作线程能够在完全准备好之前不被意外的中断。除此之外还有另外一个点：**防止在线程池关闭过程中,刚创建但是还未开始工作的线程被过早的中断** 这里可以引出另外一个问题：线程池是如何让其他线程停止下来的？

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=N2YzMWNhNzc5YzEwZTRiNjI4ZjVjNWMyOTUzYmQ1M2ZfcDlFb3N1Tk5Lb3lpcXJaNmpQNFBQT2kwbWpFbmFkMEhfVG9rZW46TzJwbmJBVnYxb1F4ZmZ4dzdTUWMyVVIwbktjXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



继续回到addWorker()方法中：再回顾一下此时的状态&#x20;

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NzY0NzJlMTFhMzQzMDA2ODRiYzQzYzA0M2NjZDE3MDNfTENZMVVjcWs4YndzSHRmMlFEM1daSWd2WjlyWnhzNjNfVG9rZW46UDdOWGJ3OUxEb25kVDZ4MDQyamNHT09KbmhnXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
// w = new Worker(firstTask); 上面讲述到了这行代码,继续看下面的代码
final Thread t = w.thread;
if (t != null) { // 如果创建的线程不为空「此时只是通过new Thread(worker)创建了一个线程对象,但是还未真正的启动」
    final ReentrantLock mainLock = this.mainLock; // # 1 获取锁
    mainLock.lock(); // 上锁
    try {
        int c = ctl.get(); // 获取线程池的ctl

        if (isRunning(c) ||  // 线程池还处于running状态
            (runStateLessThan(c, STOP) && firstTask == null))  // # 2 线程池不处于running状态,但是状态<stop(也即处于shutdown)状态,并且没有firstTask
        {
            if (t.getState() != Thread.State.NEW)
                throw new IllegalThreadStateException();  // 避免线程重复启动
            workers.add(w); // 将刚创建的worker对象添加到workers集合中
            workerAdded = true; // 设置添加成功标识
            int s = workers.size(); // 获取workers的大小
            if (s > largestPoolSize) // 如果大于历史最大工作线程数,那么更新(用于监控等功能)
                largestPoolSize = s;
        }
    } finally {
        mainLock.unlock();
    }
    if (workerAdded) { // 只有worker成功的被添加到workers集合中后才会真正的启动线程
        t.start(); // 启动线程
        workerStarted = true; // 设置线程启动成功标识
    }
}
finally {
  if (! workerStarted) // 如果启动线程失败,那么进行操作回滚
      addWorkerFailed(w);
}
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MTJlOWQyOWEwYzQwOTdkMjRhOTE4NjRlODBlYjJlNWRfWVpZc0dlb01aZ1NGRDVxY3hhTmh4aUIyN282UHY0eEZfVG9rZW46VEo0TGJEbmFZb2dTU1N4ek1VVmNIa0liblJjXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



到这里addWorker()的方法就介绍到这里了,此时线程池的状态如下：&#x20;

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MzQ4Nzc5MGNhYTFiYzhlMGVkNjE2NGQ4NmI3Y2IxNjlfM2FSc05NbkdXdE5XZld2OGgxU3RqMkpFMkdwOEhMaVFfVG9rZW46WDFVQmJrUFJKb0lVZnJ4d0R0d2NNWmNwbmZYXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



下面就是线程回调执行worker中的run()方法,下面进入到该方法中

```plain
public void run() {
     runWorker(this);
 }
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZTQ4ODExMTE1ODQzNjFlODIxYzQ2YWYzNmNiNGUyNTFfS3NrV3hTbEpYN0tvcUtGc0hzc1E2VEx3U1lvTmY0OUpfVG9rZW46QXZ0a2JJaXpFb3lJU1Z4UnRFNGNhZk0ybmsxXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



先来看下doug lea对runWorker()工作原理的总结：&#x20;

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YjFmNWNlYWJkM2ViZjY5NTgxNDNjYjUyMzQyNDFmODJfNnNjVm1wSzJZVlBZRnZpNk5iZWYzdUhSbkVnT0JTNEpfVG9rZW46Q3ZNa2J1TU5pbzlFbGp4RzBHRGNVc1NLblRlXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
final void runWorker(Worker w) {
    Thread wt = Thread.currentThread(); // 获取当前工作线程
    Runnable task = w.firstTask; // 获取线程的首任务(通常是核心线程才有firstTask),并且保存在局部变量task中
    w.firstTask = null; // 将worker的firstTask设置为null
    w.unlock(); // allow interrupts # 1
    boolean completedAbruptly = true;
    try {
        while (task != null || (task = getTask()) != null) {  // # 2
            // TODO
        }
        completedAbruptly = false;
    } finally {
        processWorkerExit(w, completedAbruptly);
    }
}
```

核心逻辑如下： 1.将线程设置为可中断状态 2.执行任务：firstTask 或者 从队列中拉取任务

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NWI3MTc4M2NiYTRlMGIxZTI2NWYzN2Y4NzA4ODBlYjFfYWJJbVVSN2Z5YXBseXV0OXVGd2ZDUFpERU1oSlRYNFdfVG9rZW46UWI5ZWJzcDlsb3N4TTl4YWhoUmM1dnAwbmJjXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
while (task != null || (task = getTask()) != null) {
        w.lock(); // 获取锁 -- 将state从0 -> 1,那么不允许被shutdown()中断
        if ((
                runStateAtLeast(ctl.get(), STOP) ||
                (Thread.interrupted() && runStateAtLeast(ctl.get(), STOP))) // 上面为1个判断 
            && !wt.isInterrupted() // 为1个判断
            )
            wt.interrupt();
 // .....
}
```

这里有两个判断如下：目的就是为了能够正确的处理中断&#x20;

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZWE1MmE2MTk5NmZhOTc3YWJmMGU2Y2I0OWRhMDUyYmFfaVp6UFJoOUdmOG93bDVZdlNnUldJWmRUNEVlck5naHFfVG9rZW46VTVidmJCeXZXb3k3c1B4OUFQV2NGQXd5bnZmXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
try {
    beforeExecute(wt, task); // 任务执行的前置回调
    try {
        task.run(); // 用户代码
        afterExecute(task, null); // 任务执行的后置回调
    } catch (Throwable ex) {
        afterExecute(task, ex); // 如果出现异常也会执行后置回调,并且将异常抛出
        throw ex; 
    }
} finally {  
    task = null; // 将任务设置为null,避免内存泄露
    w.completedTasks++; // 将当前worker执行过的任务数量+1
    w.unlock(); // 允许worker中断
}
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NmVkNmRjYWZkYzUyMDlhODQ4YmIwOTk3YmZlMGU5ZTZfY2hZc0JHbEE0R1NKd3Zha3FGS2toWnFRbnBCbmdHSENfVG9rZW46TG44WmI5d0NQb3FvN0F4aURXSmNTV1hubnhiXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



如果没出意外的话,递交给核心线程的firstTask就被执行完了，然后工作线程会重新执行while循环，此时就是从队列中获取任务了,下面再看下获取任务的原理,然后再看下线程正常退出和异常退出的情况

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZDY3OWExNjVhM2I1MDVkNjc5OGU5NDVmNjE4NzA2MjVfalBLSG1NU3ZRaHhselJsbFdyMlRUam1hUTR6NzNCZ0ZfVG9rZW46WG4xc2JtU3R4b3plRHB4YTU4MWM3bXVNblVYXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
private Runnable getTask() {

    boolean timedOut = false; // Did the last poll() time out? 上次通过poll()从队列中获取任务是否超时,默认为false

    for (;;) {
        int c = ctl.get(); // 获取线程池最新的ctl

        // Check if queue empty only if necessary.  # 1 逻辑
        if (runStateAtLeast(c, SHUTDOWN)
            && (runStateAtLeast(c, STOP) || workQueue.isEmpty())) {
            decrementWorkerCount(); // 将ctl中的工作线程数 - 1,然后返回null - 退出外层方法的while()循环
            return null;
        }
// .....
}

private void decrementWorkerCount() {
        ctl.addAndGet(-1);
}
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=OWIyYWRmOGZkZjgxOWU0MDJmN2VlZWQ4M2JjNGQ1NWNfU011SGVXbjE0WG1zdFlXUGVLVVcxSXA0NTRwak1jVmRfVG9rZW46QThWMmI5QVFob0hBdnl4R0hkemNQM2FobnFpXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



上述逻辑为线程池停止的流程：当线程池处于STOP状态或者SHUTDOWN状态(并且工作队列没有剩余的任务)，那么每个线程在getTask()的时候都会通过这个判断来返回NULL,最终结束自己的生命周期。

继续看非终止流程： 这里有个核心的概念：**非核心线程超时没有获取到任务后一定会被回收吗**？从这里的代码中可以回答 - 不一定 因为当非核心线程超时后，如果此时该线程是最后一个线程(wc = 1)，并且工作队列不为空，那么即使上次没有获取到任务,也不会退出,因为至少需要一个线程来执行任务

而这里的代码逻辑：主要就是为了保证非核心线程超时没有获取到任务时，timeOut会被设置为true,当再次尝试获取任务时，在这里就会被终止。

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NmFiOTlmYjI3ZTVhNGY4Yjg2ZTJhMjZhNzg3ZWQxZWVfN2dBSExmTEZtcGx5c3NFTlhmcTJlSDNYSTNmWnRYeFpfVG9rZW46TlU5SmJkckhmbzZ0R1F4YXNIT2NvZFBmbllkXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)

工作线程超时退出逻辑

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MDBiNTEwNzMwMjNmMDM3YTMxMDRjZmM4YWI5OTdkYjhfOTQ0SVRqdG9xT1dCVmhNSU1LMXduR1dnYXlRZk5iVHNfVG9rZW46RzBEUmJOUU5Gb05vU3B4QnFsaGNxbkJzbjNnXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)

工作线程从队列中获取任务的逻辑

+ getTask()的代码逻辑如下：核心就是从工作队列中获取任务返回的task不为空，否则超时等待返回的task = null,下面看下当getTask()返回null时以及出现异常，在runWorker()中的处理逻辑

```plain
private Runnable getTask() {

    boolean timedOut = false; // Did the last poll() time out? 上次通过poll()从队列中获取任务是否超时,默认为false
    for (;;) {
        int c = ctl.get(); // 获取线程池最新的ctl
        // .....
        int wc = workerCountOf(c); // 获取当前工作线程数

        /*
            Are workers subject to culling? 工作线程是否需要被淘汰/回收
            如果allowCoreThreadTimeOut被设置为了true,那么timed = true,也即所有线程都需要被回收
            否则该变量为false,那么代表核心线程不需要回收
            那么判断当前工作线程数 是否大于 核心线程数阈值,如果大于,那么timed = true,代表当前线程需要超时回收

        */
        boolean timed = allowCoreThreadTimeOut || wc > corePoolSize;

        # 1 
        if ((wc > maximumPoolSize || (timed && timedOut)) 
            && ( wc > 1 || workQueue.isEmpty() )) {
            if (compareAndDecrementWorkerCount(c))
                return null;
            continue; 
        }

        try {
            Runnable r = timed ? // 是否超时获取(通常只有非核心线程才为true)
                workQueue.poll(keepAliveTime, TimeUnit.NANOSECONDS) : // 如果是非核心线程,那么调用带超时时间的poll()来获取任务
                workQueue.take(); // 否则调用take()永久阻塞,直到获取到任务
            
            if (r != null) // 如果获取到的任务不为空,那么直接返回任务
                return r;
            timedOut = true; // 否则r == null,那么设置timeOut  = true,再次循环的时候在上面的#1处就会被拦截,返回null,然后正常退出(前提是工作线程>1或者队列为空)
        } catch (InterruptedException retry) {
            timedOut = false;
        }
    }
}
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YzhhNjc3ODNiNWE5NjEwNTI2ZThjMGVlZWI3ZWM4OTVfTktqeUR2YUJUYkE4VlRIMXFDdUFUTHh3cTBiUWhvc1hfVG9rZW46TWQ0dmI4QXh4b2M1Z0l4d0lWRmNxNDN5blZoXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
// getTask()返回null,那么completedAbruptly = false
final void runWorker(Worker w) {
    // ....

    boolean completedAbruptly = true;
    try {
        while (task != null || (task = getTask()) != null) { // getTask()返回null,结束while()循环
           // ....
        }
        completedAbruptly = false; // completedAbruptly = false
    } finally {
        processWorkerExit(w, completedAbruptly);
    }
}

// 任务执行出现异常,那么completedAbruptly = true
final void runWorker(Worker w) {
    // ....

    boolean completedAbruptly = true;
    try {
        while (task != null || (task = getTask()) != null) { 
         // 任务执行抛出异常...,那么代码逻辑跳跃到finally{}中,此时completedAbruptly = true
        }
        completedAbruptly = false; 
    } finally {
        processWorkerExit(w, completedAbruptly);
    }
}
```

+ &#x20;processWorkerExit(w, completedAbruptly):w为当前worker 如果是任务执行失败，那么执行当前任务的线程退出,并且会无条件补充一个新的线程 如果是线程超时空闲,那么在不影响线程池的正常工作下会正常退出,并不会补充一个新的线程,反正也会补充

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZjkzNGMzYTA0MGVmYTQ3NGY2YWE1ODFkMjk1MDU4NWVfeWtVckh2UFJnVjA2aGJEM01oSnRiT05UR2pNNnY2anFfVG9rZW46SklvRGJEdzBKb1F0Q0V4WEZweWNScjhibnJmXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
private void processWorkerExit(Worker w, boolean completedAbruptly) {
    /*
        如果completedAbruptly = true,那么代表是任务执行出现了异常,那么工作线程数是没有-1的
        而如果是因为getTask()返回null,那么在getTask()内部就调用了 decrementWorkerCount() 来减少工作线程数的,所以在这里需要-1

    */
    if (completedAbruptly) // If abrupt, then workerCount wasn't adjusted 
        decrementWorkerCount();

    final ReentrantLock mainLock = this.mainLock;
    mainLock.lock(); // 上锁
    try {
        completedTaskCount += w.completedTasks; // 统计全局任务执行数量
        workers.remove(w); // 并且将当前worker从workers集合中移除
    } finally {
        mainLock.unlock();
    }

    tryTerminate(); // 可以看到每个线程在退出的时候,都会尝试终止线程池

    int c = ctl.get(); 
    if (runStateLessThan(c, STOP)) { // 如果线程池的状态 < STOP , 也即处于running状态 或者 shutdown状态

        if (!completedAbruptly) { // 只有工作线程正常退出时才会进入这个分支 - 下面的处理是为了保证线程池的正常工作 # 1
            int min = allowCoreThreadTimeOut ? 0 : corePoolSize;
            if (min == 0 && ! workQueue.isEmpty())
                min = 1;
            if (workerCountOf(c) >= min)
                return; // replacement not needed
        }

        addWorker(null, false); 
    }
}
```

线程池的核心工作原理就介绍到这里,下面在介绍一下线程池终止的逻辑

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=OTQzODYxYzU5YjQ3ZTk4ZTIwM2RlY2ZmOWI2YjI3NGZfbmU2R3dyT0hUUG1TTW95djhoTjNoWGxCYVA5MEtlMVpfVG9rZW46UTVEWmJ0d3R4b3FJSGZ4OHlaaWNrWWxkbnFjXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZjI4YWY0ZmNhM2JkNDUzOTRiMTA4MzI1MzZjOGZjMjVfRHlrTzR4NTh4clJhVW5JRkpBZ3dORVZHSnh2cnpzanlfVG9rZW46SlJwUGJQcm1Hb0tSOXN4TWRmU2N1U2owblBoXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
public void shutdown() {
    final ReentrantLock mainLock = this.mainLock; // 只允许一个线程关闭线程池
    mainLock.lock(); // 上锁
    try {
        // ....
        advanceRunState(SHUTDOWN); // 将线程池的状态设置为shutdown
        interruptIdleWorkers(); // 中断工作线程
        onShutdown(); // hook for ScheduledThreadPoolExecutor hook函数
    } finally {
        mainLock.unlock(); // 解锁
    }
    tryTerminate(); // 尝试终止线程池
}

// advanceRunState(SHUTDOWN)
private void advanceRunState(int targetState) {
    for (;;) {
        int c = ctl.get();
        if (runStateAtLeast(c, targetState) || // 如果线程池的状态>=shutdown,那么该方法直接结束,否则cas设置线程池的状态为shutdown
            ctl.compareAndSet(c, ctlOf(targetState, workerCountOf(c))))
            break;
    }
}
```

此时线程池的状态已经变为了shutdown，这会影响到正在工作的所有线程,比如在runWorker()和getTask()中都有相应的判断。

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZDJkMmE1YWFjZGVlMTc1NzVjMmQzNmNiN2QyZjExNzlfV3E3RThhdTFyb0F4ckhtamV2ZDc5YlAyNHYzaHFGUGdfVG9rZW46R2I4WGJ1enZlb3ppVGt4dkZrdGNCSElObjdlXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



从代码中可以看到：在这里只是对那些没有执行任务的线程执行中断,而对于那些正在执行任务的线程是不会中断的，当没有任务执行时自然会退出

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YmNmMDFhYWIxYTY2NDUxODNkMmEwZjE3MWE1OTA1YmVfWFZ1bHFSblVyTWxQQU5xUmJRUkN2VktncFRYSHpTMHVfVG9rZW46TzlYaWJGbU5Bb05IeVF4a3hDS2MxRVhDbkJkXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
// 这里默认传入的参数为false,也即不是只中断一个线程,而是中断所有线程
private void interruptIdleWorkers(boolean onlyOne) {
    final ReentrantLock mainLock = this.mainLock; // 上锁,避免中断风暴
    mainLock.lock();
    try {
        for (Worker w : workers) { // 遍历线程池中的所有工作线程
            Thread t = w.thread;
            if (!t.isInterrupted() && w.tryLock()) { // 如果线程没有被中断,那么才需要被中断 并且 尝试中断工作线程 「因为线程在执行任务的时候是无法被中断的」
                try {
                    t.interrupt(); // 如果可以,那么中断线程
                } catch (SecurityException ignore) {
                } finally {
                    w.unlock();
                }
            }
            if (onlyOne) // 如果只中断一个线程,那么结束
                break;
        }
    } finally {
        mainLock.unlock();
    }
}
```

继续看tryTerminate()方法：此时的tryTerminate()方法是外部线程调用的(尝试将线程池的状态转换为TERMINATED)

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MmViOTdlYjk3Yjg3ODI4YmZkYjUyMDRiZTEyN2U4MTZfNDB2OEdZdG5Qc1p2N0ROSXhONE5mMEppRW5CNm44NEFfVG9rZW46RUV4TmIxTVF3b1d0azd4bXhzQ2NSamd6blNFXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



这里有一点很重要，那就是调用shutdown()并不总是会立即停止线程池。 当调用shutdown()后,线程池的状态会变为shutdown状态,但是如果工作队列中还有任务，那么该方法会返回。 但是大部分线程已经被中断了,并且线程能够根据线程池的状态进行退出

```plain
final void tryTerminate() {
    for (;;) {
        int c = ctl.get(); // 获取线程池最新的状态
        if (isRunning(c) ||  // 如果还是running状态,那么直接返回,在这里线程池的状态已经是shutdown了,所以这个判断为false
            runStateAtLeast(c, TIDYING) || // 线程池的状态 >= TIDYING,那么直接返回,因为不需要转换状态了
            (runStateLessThan(c, STOP) && ! workQueue.isEmpty()))  // 线程池的状态 <= STOP(比如为shutdown) 并且 工作队列中还有剩余的任务,那么也直接返回 # 1
            return;
```

继续看后续的代码：

这里有两个比较重要的点： 1.线程池的状态从TIDYING -> terminated() -> TERMINATED 2.只中断一个线程

如果此时工作线程线程数不为0,那么为什么只中断一个线程就可以了？ 因为线程阻塞在workerQueue.take()上，被中断后返回的task为null,然后退到外层的runWorker(),最终会执行processWorkerExit()，而在该函数中也会调用tryTerminate()来中断下一个线程。 避免了中断风暴

这里的问题就是：是否会存在线程池处于shutdown状态并且依旧有线程阻塞在take()函数上呢？ 我认为一种场景下会出现：那就是线程在持有任务执行时,躲过了shutdown()中的中断，并且在任务执行完毕后在getTask()的第一个判断中判断出当前队列中还有剩余的任务，但是在take()之前,任务被其他线程拿走了,那么在真正take()的时候就会阻塞

```plain
final void tryTerminate() {
    for (;;) {
        int c = ctl.get(); // 获取线程池最新的状态
        if (isRunning(c) ||  // 如果还是running状态,那么直接返回,在这里线程池的状态已经是shutdown了,所以这个判断为false
            runStateAtLeast(c, TIDYING) || // 线程池的状态 >= TIDYING,那么直接返回,因为不需要转换状态了
            (runStateLessThan(c, STOP) && ! workQueue.isEmpty()))  // 线程池的状态 <= STOP(比如为shutdown) 并且 工作队列中还有剩余的任务,那么也直接返回 # 1
            return;
        
        // .... 线程池处于shutdown状态,并且工作队列为空


        if (workerCountOf(c) != 0) { // Eligible to terminate // 如果工作线程数不等于0,那么只中断一个线程,返回即可  # 2 
            interruptIdleWorkers(ONLY_ONE); 
            return;
        }

        final ReentrantLock mainLock = this.mainLock;
        mainLock.lock();
        try {
            if (ctl.compareAndSet(c, ctlOf(TIDYING, 0))) { // TIDYING -> terminated()「hook」 -> TERMINATED
                try {
                    terminated();
                } finally {
                    ctl.set(ctlOf(TERMINATED, 0));
                    termination.signalAll(); // 唤醒所有阻塞在termination(调用awaitTermination()等待线程池状态变为TERMINATED的线程)上的线程
                }
                return;
            }
        } finally {
            mainLock.unlock();
        }
        // else retry on failed CAS
    }
}
```

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YzgzZWJhODczYjlmOTY0MzMxYzk1MjUwMTU5MzRlZGRfNlVVeWk4blBQWW5KeXVvNXY3ak1RR1YxRWhLZHJDb01fVG9rZW46UnNiSGI5V3J1b0xqN3N4ZDRUbmNtcVpNbnBkXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZTQ0YTI1M2RjZmVlODU5MzEwMjJiYWE2NjVjM2IwODdfNnkwY0VxRElvcnVPbmVzUzZwWjNLaU1hWFJkZFlUY2lfVG9rZW46WVJHZWJKOFhhb3B5amp4YmNQdGNzSEpWbjJiXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



```plain
public List<Runnable> shutdownNow() {
    List<Runnable> tasks;
    final ReentrantLock mainLock = this.mainLock; // 获取操作的锁
    mainLock.lock(); // 上锁
    try {
        // ...
        advanceRunState(STOP); // 将线程池的状态转化为STOP
        interruptWorkers(); // 中断workers
        tasks = drainQueue(); // 丢弃队列中的任务
    } finally {
        mainLock.unlock();
    }
    tryTerminate();
    return tasks;
}   

// 状态转换
private void advanceRunState(int targetState) {
    for (;;) {
        int c = ctl.get();
        if (runStateAtLeast(c, targetState) || // 如果线程池的状态已经>=STOP了,那么直接返回
            ctl.compareAndSet(c, ctlOf(targetState, workerCountOf(c)))) // 否则将线程池的状态CAS为STOP
            break;
    }
}
```

下面看下中断线程的处理

```plain
private void interruptWorkers() {
    for (Worker w : workers) // 遍历workers集合中的所有工作线程,进行中断
        w.interruptIfStarted(); 
}

void interruptIfStarted() {
    Thread t;
    // state大于0就可以中断(正在执行任务也会被中断),当然worker中的线程不能为空并且没有被中断过
    // 也即线程只要启动了,那么在shutdownNow()也会被中断,相比于shutdown()来说更加的粗暴
    if (getState() >= 0 && (t = thread) != null && !t.isInterrupted()) { 
        try {
            t.interrupt();
        } catch (SecurityException ignore) {
        }
    }
}
}
```

队列的处理：

```plain
// 该方法的作用就是将还在工作队列中的任务返回,返回给shutdownNow()的调用者
private List<Runnable> drainQueue() {
    BlockingQueue<Runnable> q = workQueue; // 当前工作队列
    ArrayList<Runnable> taskList = new ArrayList<>();
    q.drainTo(taskList); // 批量转移任务
    if (!q.isEmpty()) { // 处理剩余任务,针对特殊队列(比如DelayQueue)
        for (Runnable r : q.toArray(new Runnable[0])) {
            if (q.remove(r))
                taskList.add(r);
        }
    }
    return taskList;
}
```

拒绝策略：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NDNjYTA2YjExNzZjYjY2ODY2ZWEyOTgwYWFmY2MwMGVfaVpsSldZbDBzYTRhc1l6ejJqOEJMZHUwMGI3SFRodFZfVG9rZW46Tng5NWJkbGVrb3Uxa3Z4anliUWN4UXh2bkloXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



线程池的状态流转：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NDIwYjhjZWViYTQwZGZmZmUxYmU0YTVjZmUzOWM3NTJfcE42aHpNZWlZTEZ0WG8wSHE4dVQ4cEpSRlBucHpGajNfVG9rZW46UDdpQ2JhM0lTbzFPSWx4eWtOZ2NlU1Z3bklkXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)



到这里关于线程池的基本工作原理就讲解到这里。 关于线程池后续还有3个地方需要补充：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NWFmNTI0N2Y1NmMyMTM4NTZjOWRkN2M4YTQ2ZGRmOGFfZDRvcVg2dWJBYlFsVFdHaHdkQjR1N0hHSER6ZzVuOWtfVG9rZW46UHNRQmJWR0lpb2doVUV4ZEhxc2NUN2ZkbkJmXzE3Njg2NTU5NzY6MTc2ODY1OTU3Nl9WNA)
