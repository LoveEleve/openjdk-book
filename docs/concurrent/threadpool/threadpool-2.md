# 线程池学习笔记（2）：Executors 工厂线程池

> 官方文档：[https://docs.oracle.com/en/java/javase/11/docs/api/java.base/java/util/concurrent/Executors.html](https://docs.oracle.com/en/java/javase/11/docs/api/java.base/java/util/concurrent/Executors.html)
>

该类是JDK官方提供的，其提供了多个工厂方法来创建不同类型的线程池(不需要传入过多的参数),本文章就介绍一下这些现有线程池的工作原理：不会在再详细的介绍线程池内部的工作原理了,而是介绍一下这些现有线程池的一些特性。

## newCachedThreadPool()
从名字上来看：缓存线程池

> 官方介绍：
>

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MTc3OTEzMmUyMWJjMjE3MWYzNWM2MzNkY2ZhYWExNDBfS2hHcEhNRHZFVmxMYjhPb29FZ2J4cG1kQkpFbFI2TmhfVG9rZW46Q0dEM2JPVWZwbzF1OFd4WmN2OWM0T0hqbnJiXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

创建一个线程池,根据需要创建新线程，但在可用时将重用以前构造的线程，这种线程池通常会提高执行许&#x591A;**<font style="color:rgb(216,57,49);">短期</font>**&#x5F02;步任务程序的性能，但是如果没有现成可用的线程,那么将会创建一个新线程来工作，并且如果一个线程在60s内没有执行任务那么将会被回收。

## 源码解析
```java
  public static ExecutorService newCachedThreadPool() {
        return new ThreadPoolExecutor(0, Integer.MAX_VALUE,
                                      60L, TimeUnit.SECONDS,
                                      new SynchronousQueue<Runnable>());
    }
```

可以看到，它的核心线程数是被设置为0的,并且使用的队列是SynchronousQueue。

这意味着在线程池工作时,工作线程池将永远不会小于核心线程数( 0 也不小于 0 )，那么在execute()方法中,第一个if分支将永远不会被执行「因为工作线程数 永远不会小于核心线程数」

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NGZiODI5YmYzZDY2YjFjODVhNmIxYmM3M2ExZmFkZGFfdVQxSllCN2FlcHJQSzJ6cmZXbGxzeWQwMFlyejFsR3ZfVG9rZW46V0J1d2JqRDZBb2F0Wkx4TENrS2NmdXhsblhsXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

这个时候就会直接尝试将任务"添加"到队列中,调用的是 workQueue.offer(command)方法，而对于SynchronousQueue队列来说,如果此时没有消费者在等待消费「也即没有工作线程阻塞在(或者正在调用)take()方法」，那么该方法会立即的返回false,此时第二个分支也不会执行了.而是会去执行第三个分支。

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ODM3NjJkOTUwNWE2MzBiNjBkYThiZGM2YzFkYzYzYzRfNUxick1IMWxpNFhNZkF3aTJNcVd6cHZjd25UU1NNeHNfVG9rZW46RU1pM2JhUFQ3b3lwZnh4S0FEVWNIZEZobjhnXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

第三个分支：添加一个新的线程来执行该任务

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ODEyYzcwOTFlMDMyNjllYTE0ZjNhNjRjNzcxZmUzZDJfcFV3a0ZRYXZWUTVjVGc1WGxyTVhiS0xYRW04RkpPMlNfVG9rZW46VjBWVWJFNE5jb0RVb2d4cUVpOGNRUGVqbmJkXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

所以介绍说,该线程池会复用之前创建的线程的含义是，如果有工作线程在等待take()任务「默认是60s」,那么就使用该工作线程来执行任务，否则会立即创建一个新的线程来执行此次任务。  
并且也可以看出,它确实只适合用来执行那些**短期**的任务,这样线程的利用率会比较高，否则如果有大量的任务是比较耗时的（在这里是大于60s），那么则会创建大量的线程，导致性能极速的下降。



+ 在这里有另外一个问题：当工作线程数被设置为0后,线程池的工作流程数怎么样的呢？

这个问题,没有标准答案，因为需要根据线程池所使用的阻塞队列来做进一步判断，但是不管怎么样,只要掌握了execute()的工作原理就没什么问题。在这里总结一下execute()的工作原理：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YzFiMDAyMzE0NDBkZDliZGQ5YjMxODFlYTA5MzgwZGNfV0QyUjZoV3pJNTcyUFV5SExtUzBvdVJFb0JjNDZ1RUNfVG9rZW46VnFUTmJyVnBub28ydzl4d3EzTmNPN2U3bnBmXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

## newFixedThreadPool(int nthreads)
名字含义：固定大小的线程池「这里指的是线程的数量大小是固定的」

> 官方介绍：
>

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZmJlMTc0OGExMzczNDg5ZDAxMzE2YzM0YTQ5NzdjYjFfaVI2VEdSUUhCWWdUMU02OTlOSkJEald3TVFqaHlJRGxfVG9rZW46QzVzdmJYcDZtb1loeVh4YzNQbWMxSmt1bkloXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

## 源码解析
```java
public static ExecutorService newFixedThreadPool(int nThreads) {
    return new ThreadPoolExecutor(nThreads, nThreads,
                                  0L, TimeUnit.MILLISECONDS,
                                  new LinkedBlockingQueue<Runnable>());
}
```

其特点为：核心线程数和最大线程数相等,并且采用无界的阻塞队列来存储任务「因为没有指明队列的大小,则默认是无界的」。

假设固定为10个线程,那么如果某一个时刻，这10个线程都在执行任务，那么新来的任务将会存储在阻塞队列中，等待被拉取执行「因为这里是LinkedBlockingQueue，所以offer(E e)是不会失败的，除非OOM了」

+ 验证：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=YWZjN2I3MGEwMDI1NzAxMWRhMGNlY2Y3MmY0MTNiNGJfeEdsMG9XMGMzRncyVjZJQWdMT3pja2l0MnVLQ0tUYzZfVG9rZW46UzQ3TmJMSVBabzUxZlJ4WERRc2NCdnI5bk1mXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

```java
public static void main(String[] args) throws Exception{
   Tools.RunThread(()->{
       for (int i = 0; i < 10; i++) {
           fixedThreadPool.execute(()->{
               try {
                   Thread.sleep(300000);
               } catch (InterruptedException e) {
                   throw new RuntimeException(e);
               }
           });
       }
   });
   Thread.sleep(1000);
   Tools.RunThread(()->{
       for (int i = 0; i < 2; i++) {
           fixedThreadPool.execute(()->{
               // TODO
           });
       }
   });
    Field field = fixedThreadPool.getClass().getDeclaredField("workQueue");
    field.setAccessible(true);
    // 此时队列中有两个任务
    LinkedBlockingQueue obj = (LinkedBlockingQueue) field.get(fixedThreadPool);
    System.out.println("hello");
}
```

## newSingleThreadExecutor()
> 官方介绍
>

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=Mzk1ZjM5M2Q2NDZiMGM0ZWQzOGIzNGM5MGM1NzY3MjRfUHcyTG5sRHZYNzliVnB3ZXNFdzlIMGpidXdGZVJCRnhfVG9rZW46RVRNcGJ2cVBEb0hIdnN4VmpxcmNRclNWbk5oXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

创建一个使&#x7528;**<font style="color:rgb(216,57,49);">单个工作线程</font>**&#x7684;Executor，该线程基于无界队列进行操作。（但需注意：若此单个线程在执行过程中因故障终止，在执行后续任务时将根据需要创建新线程来替代。）**<font style="color:rgb(216,57,49);">任务保证按顺序执行</font>**，且在任一时刻最多只有一个任务处于活动状态。与功能相同但可重新配置为使用更多线程的newFixedThreadPool(1)不同，此处返回的executor确保不会被重新配置为使用额外线程。

关键点：单个工作线程，无界队列，任务保证按顺序执行，与newFixedThreadPool(1)不同

## 源码解析
```java
public static ExecutorService newSingleThreadExecutor() {
    return new FinalizableDelegatedExecutorService
        (new ThreadPoolExecutor(1, 1,
                                0L, TimeUnit.MILLISECONDS,
                                new LinkedBlockingQueue<Runnable>()));
}
```

该方法的实现和其他现有线程池的实现有些不同,就是其使用了FinalizableDelegatedExecutorService类来包装线程池  
这样做的目的是为了保证内部线程池只能只能有1个线程在工作「这与newFixedThreadPool()不同,虽然从名字上看来它是固定线程数,那么由于该方法返回的是一个ThreadPoolExecutor对象,其可以调用setCorePoolSize(int corePoolSize) 和 setMaximumPoolSize(int maximumPoolSize)来修改线程数配置，这样就违背了其FIX的初衷了」

为了解决这个问题：在这里使用FinalizableDelegatedExecutorService类来包装,返回的是ExecutorService对象,其没有上述的两个方法,从而避免了线程数配置的修改，做到了真正的FIX

由于只有一个线程在工作，所以某一时刻最多只能执行一个任务,其他任务必须在阻塞队列中等待，只适&#x5408;**<font style="color:rgb(216,57,49);">任务必须严格的按照提交顺序来执行</font>**&#x7684;场景



## newScheduledThreadPool()
<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZWEwYjBlYzUwYmUxZjM3MjNmMjk0MjBhODgxMmQ0MzhfMWM2UEY1Wjh0R2pwZWlTMFhzVExOOTJZTXpyUjVTcnJfVG9rZW46Qm5kVGJrREFEb2h2Vnd4ekhhMmN5NU1SbmRkXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

创建一个可以调度任务&#x5728;**<font style="color:rgb(216,57,49);">给定延迟</font>**&#x540E;运行，&#x6216;**<font style="color:rgb(216,57,49);">周期性执行</font>**&#x7684;线程池。



## 源码解析
```java
public static ScheduledExecutorService newScheduledThreadPool(int corePoolSize) {
    return new ScheduledThreadPoolExecutor(corePoolSize);
}

// 内部自己实现的阻塞队列 - 是一种优化操作，每个 ScheduledFutureTask 都会记录 其在堆数组中的索引
// 这种设计消除了在取消任务时需要查找的任务的开销，极大地加快了移除速度（从 O(n) 降至 O(log n)）
// 在这里关于队列的详细设计就不在这里探讨了
public ScheduledThreadPoolExecutor(int corePoolSize) {
    super(corePoolSize, Integer.MAX_VALUE,
          DEFAULT_KEEPALIVE_MILLIS, MILLISECONDS, // 10L & second(默认的超时时间为10s)
          new DelayedWorkQueue()); // 内部使用的是其自己实现的阻塞队列
}

// 属性:前面说过,如果采用的队列是无界队列,那么keepAlive参数是使用不到的,那么在这里设置默认为10S的意义在哪里呢？
// doug lea在注释中也进行了说明
/*

    通常情况下，这个值不会被使用，因为所有池线程都将是核心线程，
    但如果用户创建了一个核心线程数为零的池（尽管我们不建议这样做），
    我们会在有任务排队时保持一个线程存活。
    如果保活时间为零（历史值），我们最终会在 getTask 方法中热旋转，浪费 CPU 资源。
    但另一方面，如果我们将这个值设置得过高，而用户创建了一个未正确关闭的一次性池，
    那么池中的非守护线程将会阻止 JVM 终止。
    一个较小但非零的值（相对于 JVM 的生命周期而言）似乎是最佳选择。 
*/
private static final long DEFAULT_KEEPALIVE_MILLIS = 10L;
```

如何理解这段注释呢？看工作线程在runWork() # getTask()的代码

```java
for (;;) {
    int c = ctl.get();

    // 状态相关的处理...

    int wc = workerCountOf(c); // 获取工作线程数,在这里为1

    // Are workers subject to culling? 由于corePoolSize = 0,这就导致了所有的线程都为非核心线程
    // 所以coreSize = 0,可以抵消掉无界队列的作用，让keepAlive参数起作用
    boolean timed = allowCoreThreadTimeOut || wc > corePoolSize;
    
    // 由于wc = 1,所有这里的分支永远不会执行,也即永远不会退出
    if ((wc > maximumPoolSize || (timed && timedOut))
        && (wc > 1 || workQueue.isEmpty())) {
        if (compareAndDecrementWorkerCount(c))
            return null;
        continue;
    }
    // 那么该工作线程将会执行：poll(0,second),由于又不会退出,在这里可能会导致CPU飙高(这里有一个for(;;)死循环)
    try {
        Runnable r = timed ?
            workQueue.poll(keepAliveTime, TimeUnit.NANOSECONDS) :
            workQueue.take();
        if (r != null)
            return r;
        timedOut = true;
    } catch (InterruptedException retry) {
        timedOut = false;
    }
}
// 但是如果设置的keepAliveTime值太大,这又会导致,如果线程池没有正常关闭，那么jvm将不会退出
// 所以 ：一个较小但非零的值（相对于 JVM 的生命周期而言）似乎是最佳选择。 
```

下面进入到该线程池工作的三个调度方法：

```java
public ScheduledFuture<?> schedule(Runnable command,
                                   long delay,
                                   TimeUnit unit) {
   // 异常处理.....
    
   // 会将传入的任务包装为 ScheduledFutureTask类型的
    RunnableScheduledFuture<Void> t = decorateTask(command,
        new ScheduledFutureTask<Void>(command, null, 
                                      triggerTime(delay, unit),
                                      sequencer.getAndIncrement()));
    // .....
}

// scheduleAtFixedRate(xxx)
public ScheduledFuture<?> scheduleAtFixedRate(Runnable command,
                                              long initialDelay,
                                              long period,
                                              TimeUnit unit) {
    // 异常处理....
    ScheduledFutureTask<Void> sft =
        new ScheduledFutureTask<Void>(command,
                                      null,
                                      triggerTime(initialDelay, unit),
                                      unit.toNanos(period),
                                      sequencer.getAndIncrement());
    RunnableScheduledFuture<Void> t = decorateTask(command, sft);
    sft.outerTask = t;
    delayedExecute(t);
    return t;
}

//

public ScheduledFuture<?> scheduleWithFixedDelay(Runnable command,
                                                 long initialDelay,
                                                 long delay,
                                                 TimeUnit unit) {
    // 异常处理....
    ScheduledFutureTask<Void> sft =
        new ScheduledFutureTask<Void>(command,
                                      null,
                                      triggerTime(initialDelay, unit),
                                      -unit.toNanos(delay),
                                      sequencer.getAndIncrement());
    RunnableScheduledFuture<Void> t = decorateTask(command, sft);
    sft.outerTask = t;
    delayedExecute(t);
    return t;
}

// ---- 分割线

// ScheduledFutureTask() - schedule()调用的
ScheduledFutureTask(Runnable r, V result, long triggerTime,
                    long sequenceNumber) {
    super(r, result); // 将任务包装为一个callable
    this.time = triggerTime; // 初始需要延迟的时间
    this.period = 0; // 周期为0
    this.sequenceNumber = sequenceNumber; // 记录任务的序列号
}

// scheduleAtFixedRate() && scheduleWithFixedDelay()调用的
ScheduledFutureTask(Runnable r, V result, long triggerTime,
                    long period, long sequenceNumber) {
    super(r, result);
    this.time = triggerTime; // 初始需要延迟的时间
    this.period = period; // 周期
    this.sequenceNumber = sequenceNumber;
}
```

可以看到，三个调度方法其实内部调用的逻辑差不多,都会将任务包装为一个ScheduledFutureTask，不过Task的构造参数不同,在这里额外区分一下scheduleAtFixedRate()和scheduleWithFixedDelay()的区别：  
在构造任务的时候,其传入的参数为：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NTBmMWRjY2FlYzQ4ZTNiNDI4OWNhZDZjZjY3NzYzMmFfTzRlaUdsY3haR0lWczk5d0RQNE1HYlgyNUVkMnRUbDFfVG9rZW46Q3lDOWI4a2J3b21HNkR4YzZhNWNzUUIzbk1mXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

关注点不同：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MDFiN2U2MjAzNzBhMTM1Y2ZlYmQ2MDBkYTU5NTk0OWZfOUJCTHQ3amg3bFE0cUdHSHBMSzBIWXhwMjM4b052M2pfVG9rZW46REl1M2JHZ2tLb3I2NVh4eWVoNmNaUVA1bkdkXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

除此之外,schedule()方法是没有sft.outerTask = t;这行代码的，而后面的两个方法都有：这是因为schedule()方法是一次性的，任务只会在某个延迟后被执行,并不会重复执行,而后面两个方法是需要重复执行任务的。在这里使用outerTask字段来保存任务,用于后续重新入队

下面继续看delayedExecute(t)方法

```java
private void delayedExecute(RunnableScheduledFuture<?> task) {
    if (isShutdown()) // 如果线程池状态为shutdown,那么拒绝任务
        reject(task);
    else {
        super.getQueue().add(task); // 将当前任务添加到阻塞队列中
        // canRunInCurrentRunState():double check，在这里会对线程池的状态再次做校验
        if (!canRunInCurrentRunState(task) && remove(task))
            task.cancel(false);
        else
            ensurePrestart();
    }
}
//canRunInCurrentRunState()
boolean canRunInCurrentRunState(RunnableScheduledFuture<?> task) {
    if (!isShutdown())
        return true;
    if (isStopped())
        return false;
        
    // 如果线程池处于shutdown状态(非stop状态)
    return task.isPeriodic() // 根据任务是否是周期任务采用不同的策略,关于shutdown状态的处理,先不考虑
        ? continueExistingPeriodicTasksAfterShutdown 
        : (executeExistingDelayedTasksAfterShutdown
           || task.getDelay(NANOSECONDS) <= 0);
}

//  ensurePrestart()：确保至少有一个工作线程
//  它的作用和prestartCoreThread很类似，因为此时的任务不一定会被执行(任务具有延迟时间)
//  但是如果不保证至少有一个线程,那么任务将不会被执行
void ensurePrestart() {
    int wc = workerCountOf(ctl.get());
    if (wc < corePoolSize)
        addWorker(null, true);
    else if (wc == 0)
        addWorker(null, false);
}
```

当任务到达了初始的延迟时间后,就会被线程take()执行,然后调用任务的run()方法：下面看下任务的run()方法

```java
//ScheduledFutureTask
public void run() {
        if (!canRunInCurrentRunState(this)) // 状态处理...
            cancel(false);
        // 如果任务是非周期的,比如是通过schedule()添加的任务,那么调用FutureTask.run()方法
        // 关于FutureTask/Future后面会单独出一篇文章来介绍
        // 在这里只讨论周期任务
        else if (!isPeriodic()) 
            super.run();
        // 否则：是周期任务,那么调用FutureTask.runAndReset()方法
        // run()和runAndReset()的区别在于后者不会执行set(result)方法,来修改任务的状态
        // 这样任务就能被再次执行
        // 此时任务已经执行完毕了,注意:不管是scheduleAtFixedRate()还是scheduleWithFixedDelay()
        // 都是在任务执行完后才执行下面的两行代码
        else if (super.runAndReset()) {
            setNextRunTime();
            reExecutePeriodic(outerTask);
        }
    }
```

继续看后续的代码：

+ setNextRunTime() / reExecutePeriodic()

```java
// ScheduledFutureTask
ScheduledFutureTask(Runnable r, V result, long triggerTime,
                    long sequenceNumber) {
    super(r, result);
    this.time = triggerTime; // 任务的初始延迟时间
    this.period = 0; // 任务的周期时间 - AtFix为正数，WithFix为负数
    this.sequenceNumber = sequenceNumber;
}
private void setNextRunTime() {
    long p = period; 
    if (p > 0) // 如果是AtFix -  那么任务下一次的执行时间就是time + p
        time += p;
    else // 否则在当前时间的基础上再过delay时间再执行任务
        time = triggerTime(-p); 
}

// triggerTime() 当前时间 + (-delay)「其实就是传入的delay时间」
// 注意此时任务已经执行完毕了哦～,所以直接加上delay时间即可
long triggerTime(long delay) {
    return System.nanoTime() +
        ((delay < (Long.MAX_VALUE >> 1)) ? delay : overflowFree(delay));
}

// 主要是将任务重新入阻塞队列,并且确保至少有一个线程
void reExecutePeriodic(RunnableScheduledFuture<?> task) {
    if (canRunInCurrentRunState(task)) {
        super.getQueue().add(task);
        if (canRunInCurrentRunState(task) || !remove(task)) {
            ensurePrestart();
            return;
        }
    }
    task.cancel(false);
}
```

从这个方法其实就可以看出两者的区别了：

AtFix : 固定周期性执行任务，提交任务后不会立即执行，而是过了N秒后再执行(初始延迟)，同时每过M秒都会重新执行这个任务(这个M秒是在N秒的基础上的)

WithFix: 固定间隔周期性任务，提交任务后不会立即执行，而是过了N秒后再执行(初始延迟),这里是最大的不同，这里下一个任务的执行时间为：上一个任务执行完毕后,再等待M秒后重新执行该任务

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NGMyZGI5YWQ3OGE1NWExZjczZDY3OTU3ZTk0ZWU3OGNfZUwwamVVS1ZQUnBpeW9WZ3lZYkNuY0RDSkdpRzdQRmhfVG9rZW46T0dNbGJkTFdZb0RRQlp4bGlWSmNLenFQbnBkXzE3Njg2NTYwMDM6MTc2ODY1OTYwM19WNA)

下面举个代码的例子：

```java
scheduledThreadPool.scheduleAtFixedRate(()->{
    System.out.println("Rate任务开始: " + LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_TIME));
    Tools.sleep(3);
    System.out.println("Rate任务结束: " + LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_TIME));

},0,5,TimeUnit.SECONDS); // 默认不要延迟,直接执行

// out put 任务是以固定周期执行的,12 -> 17 -> 22 -> ... 「与任务执行时间无关」
Rate任务开始: 17:28:12.822557
Rate任务结束: 17:28:15.825816
Rate任务开始: 17:28:17.811678
Rate任务结束: 17:28:20.811974
Rate任务开始: 17:28:22.811188
Rate任务结束: 17:28:25.811511

// 但是如果任务执行的时间 > 周期时间呢 会出现什么情况呢？ 
// 因为在上面代码中看到, 设置下一个任务的时间是在上一个任务执行完毕后才操作的
// 这就会导致下一个任务会在上一个任务结束后就执行(因为已经过了周期时间了)
scheduledThreadPool.scheduleAtFixedRate(()->{
    System.out.println("Rate任务开始: " + LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_TIME));
    Tools.sleep(3);
    System.out.println("Rate任务结束: " + LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_TIME));

},0,2,TimeUnit.SECONDS); //  任务执行时间(3s) > 周期时(2s)

// out put
Rate任务开始: 17:31:19.559134
Rate任务结束: 17:31:22.562334
Rate任务开始: 17:31:22.562818
Rate任务结束: 17:31:25.563023
Rate任务开始: 17:31:25.563666
Rate任务结束: 17:31:28.564002
Rate任务开始: 17:31:28.564362

// 
scheduledThreadPool.scheduleWithFixedDelay(()->{
    System.out.println("Delay任务开始: " + LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_TIME));
    Tools.sleep(3);
    System.out.println("Delay任务结束: " + LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_TIME));
},0,5,TimeUnit.SECONDS);

// out put 下一个任务的开始时间 = 上一个任务的执行时间(3s) + 周期时间(5s)
Delay任务开始: 17:35:40.264053
Delay任务结束: 17:35:43.267287
Delay任务开始: 17:35:48.268241
Delay任务结束: 17:35:51.268569
Delay任务开始: 17:35:56.268974
Delay任务结束: 17:35:59.269315
Delay任务开始: 17:36:04.269708
```
