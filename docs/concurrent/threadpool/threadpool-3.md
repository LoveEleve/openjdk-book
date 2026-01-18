# 线程池学习笔记（3）：Runnable、Callable 与 FutureTask

> 在这篇文章中介绍一下callable和futureTask的相关内容，基于jdk11
>

## runnable
在这里首先先介绍一下runnable接口:特点就是没有返回值,并且也不会抛出异常

(但是在run()方法中使用throw来抛出异常,并不会出现编译错误,也不会出现报错 - 这里提出一个问题:throw和throws的区别是什么？)

```java
/*
    可以看到,该接口内部只有一个run()方法,并且没有返回值,也不能抛出异常,
    如果在执行这个方法的时候抛出异常了,会如何处理呢？
*/
public interface Runnable {
    public abstract void run();
}

// 当线程池执行外部投递进来的任务时,会交给内部的工作线程(Worker)来处理, run() -> runWorker()
// 可以看到worker的run()没有异常处理
public void run() {
    runWorker(this);
}

// 
final void runWorker(Worker w) {
try {
     // ....
    try {
        task.run(); // 在这里抛出异常,如果具体的任务本身没有实现异常的处理,那么在这里会被下面catch到
     // ....
    } catch (Throwable ex) {
        // ....
        throw ex; // 在这里会将异常往上一个方法[run()]中抛,但是run()没有异常处理,最终会由jvm来处理这个异常
    }
}
    // ....
}
```

看下面一段代码:

```java
Runnable runnable = new Runnable() {
    @Override
    public void run() { // 该方法没有返回值,也无法抛出异常~
        throw new RuntimeException("error"); // 这里的throw的作用是什么？ 换句话说throw和throws的区别是什么？
    }
};
```

可以看到,虽然run()方法不允许通过throws声明可能方法可能会抛出的异常，但是却可以通过throw来抛出异常,这不会有点矛盾吗？

但是确实是这样的,因为在run()方法中能够通过throw抛出的只有非受检异常,而对于受检异常则是无法通过throw来抛出的。如下：如果抛出了非受检异常,那么必须在方法内部显示的通过try-catch来处理

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NTk2MTU0MWEyNjFhNDA3ODcxOTllYWExZjE0YzFkZWJfTXZLdEMyOWc2QlpiOVFtNlBlcEJubGxZamVPczlibDVfVG9rZW46TDVISmJTaGk1b1R6VDF4OEdDdmNKVHFzbmxmXzE3Njg2NTYwMjE6MTc2ODY1OTYyMV9WNA)



---

下面继续来说下runnable的使用方式：

任何想要由线程执行的实例都必须实现runnable接口，而这有两种方式：

1. 继承Thread类(因为thread类实现了Runnable接口)
2. 实现Runnable接口(推荐)

推荐第二种方式的主要原因是：职责分离(组合优于继承),Thread负责线程执行能力,而Runnable负责具体的任务逻辑

```java

public class Test_1 {
    public static void main(String[] args) {
        MyTask myTask = new MyTask();
        myTask.start();
        Tools.sleep(2);
        Task task = new Task();
        Tools.stratThread(task,"myThread");
        Tools.sleep(2);
    }
}

// --- #1 继承Thread
class MyTask extends Thread {
    @Override
    public void run() {
        System.out.println("hello world");
    }
}

// --- #2 实现Runnable接口
class Task implements Runnable {

    @Override
    public void run() {
        System.out.println("hello world task");
    }
}
```

## callable
而callable就解决了runnable的问题：

```java
public interface Callable<V> {
    V call() throws Exception; // 可以抛出受检异常,并且有返回值[V是返回值的类型]
}
```

但是前面说过:想要被线程执行,必须是一个runnable对象(实现Runnable接口)，而单纯的callable是无法被执行的。如下图所示：线程只会执行runnable类型的任务

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=Njk3MDUyMmQ1NTYzMTdlYThiMDg3ZWVjMTM5MDk3ODJfeUNHbnZzSlBxZnh3NldTZDhkUG9vNzloRmh1VEZnTzJfVG9rZW46WUxJWmJkdDBSb2FoS3p4dFVEcGN2SDNvbk9nXzE3Njg2NTYwMjE6MTc2ODY1OTYyMV9WNA)

所以要想callable被执行，那么必须把它包装为runnable - 在这里使用的就是FutureTask类，不过很明显,它还引入了另外一个接口:Future接口

## Future
在上面提到过,callable已经解决了runnable不能抛出受检异常和没有返回值的问题了。其实只需要将callable包装一下即可。

但是在平时使用中，所创建的任务一般都是提交给线程池来执行的,那么当外部提交任务的线程想要获取到任务的执行结果应该怎么办呢？

因为callable是只有一个call()方法的,所以就需要有个接口提供获取任务执行结果的能力 - Future「其内部定义的get()方法就是用来获取任务执行的结果的，当然该接口还支持其他的功能」

```java
public interface Future<V> {
    boolean cancel(boolean mayInterruptIfRunning); // 取消任务
    boolean isCancelled(); // 任务是否已经被取消
    boolean isDone(); // 任务是否已经完成
    // --- 获取任务的结果
    V get() throws InterruptedException, ExecutionException;
    V get(long timeout, TimeUnit unit) throws xxx;

}
```

下面就进入到FutureTask的工作原理讲解：从isDone()可以提出一个问题：如何知道一个任务是否已经完成了呢？ -- **状态**「这一点在阅读源码之前就应该知道」

+ 使用案例

在介绍使用案例前,需要了解一个事情：execute() 和 submit()方法的区别是什么？

从方法上可以看到一个很明显的区别：那就是execute()方法只能接受runnable类型的任务，而submit()方法还可以接受callcable类型的任务「当然最终是需要包装为runnable」，除此之外,execute()方法不会有任何返回值，而submit()方法则会返回一个Future对象,通过这个对象可以获得任务的执行结果「通过get()方法」

还有另外一个最为重要的区别：那就是对异常的处理，这里在后面会再次讨论到,在这里先总结一下两者的区别

```java
public void execute(Runnable command) {....}
public Future<?> submit(Runnable task) {....}
public <T> Future<T> submit(Callable<T> task) {....}
```

使用案例：

```java
public static void main(String[] args) throws ExecutionException, InterruptedException {
    ExecutorService threadPool = Executors.newFixedThreadPool(10);
    Callable<String> callable = new Callable<String>() {
        @Override
        public String call() throws Exception {
            Tools.sleep(4);
            return "hello";
        }
    };
    
    FutureTask<String> futureTask = new FutureTask<>(callable);
//  Future<?> result = threadPool.submit(futureTask);
//  result.get() -- 将会返回null,因为返回值被存放在futureTask中了
    threadPool.execute(futureTask);
    System.out.println(futureTask.get());
    Tools.sleep(2);
}

/*
    最终的预期希望输出“hello”
    但是如果通过submit()提交了一个futureTask
    (那么通过submit()返回的future,是无法通过get()来获取结果的)
*/

```

为什么通过submit()提交了一个futureTask后,通过其返回的future对象的get()方法无法获取任务对应的执行结果呢？

下面看下submit(xxx)的源码：

```java
// callable类型
public <T> Future<T> submit(Callable<T> task) {
    if (task == null) throw new NullPointerException();
    RunnableFuture<T> ftask = newTaskFor(task); // 包装
    execute(ftask);
    return ftask;
}

// runnable类型  -- 注意这里和上面调用的是不同newTaskFor()方法
public Future<?> submit(Runnable task) {
    if (task == null) throw new NullPointerException();
    RunnableFuture<Void> ftask = newTaskFor(task, null); // 包装
    execute(ftask); // 其内部还是通过execute()来执行任务的
    return ftask;
}

// newTaskFor(Callable)
protected <T> RunnableFuture<T> newTaskFor(Callable<T> callable) {
    return new FutureTask<T>(callable);
}
// newTaskFor(Runnable runnable, T value)
protected <T> RunnableFuture<T> newTaskFor(Runnable runnable, T value) {
    return new FutureTask<T>(runnable, value);
}
```

从上面的代码可以得出两个结论：  
1.不管传入的任务是callable类型还是runnable类型,都会被包装为futureTask类型  
2.然后通过execute()来执行



下面进入到FutureTask的源码：

## FutureTask
+ 构造函数

```java
// @1 当提交的任务为runnable类型时,会通过callable()继续包装为callable
// 具体的类型为RunnableAdapter「它是一个callable类型的」
public FutureTask(Runnable runnable, V result) {
    this.callable = Executors.callable(runnable, result);
    this.state = NEW;       // ensure visibility of callable
}
public static <T> Callable<T> callable(Runnable task, T result) {
    // null ex
    return new RunnableAdapter<T>(task, result);
}
// A callable that runs given task and returns given result.(返回给定的result)
RunnableAdapter(Runnable task, T result) {
    this.task = task;
    this.result = result;
}

// @2 当提交的任务为callable类型时
public FutureTask(Callable<V> callable) {
    // null ex
    this.callable = callable; // 直接保存传入的引用即可
    this.state = NEW;       // ensure visibility of callable
}
```

此时的结构如下：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=ZGMxZjc2NjEyYjg0NjIzOTE4YjM2Y2Y4MWMyMDBjOTdfanhYekd4a0VqZnMzQzlJZ3czem1BekRJd0F1VDNlZUVfVG9rZW46RXFkZmJsNllZbzJGSHB4VjdZcmNKWHlHbnNkXzE3Njg2NTYwMjE6MTc2ODY1OTYyMV9WNA)

+ FutureTask的状态

```java
private volatile int state;
// 一共有七种状态,初始时默认为NEW(0)
private static final int NEW          = 0;
private static final int COMPLETING   = 1;
private static final int NORMAL       = 2;
private static final int EXCEPTIONAL  = 3;
private static final int CANCELLED    = 4;
private static final int INTERRUPTING = 5;
private static final int INTERRUPTED  = 6;
```

状态转化：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MWJhMzQ5YjllMDNkOWNjZmVjODMzODJkNDM4NWYwN2ZfQ09wYmNqZWdnWDF1bUdwZUxqd1BtOUtMZVc0UU9jTXVfVG9rZW46Vmc4aWJFVjI0b3V3M2N4SWEzZGMyMHllblFwXzE3Njg2NTYwMjE6MTc2ODY1OTYyMV9WNA)

再看下futureTask的其他属性

```java
public class FutureTask<V> implements RunnableFuture<V> {
    private volatile int state; // 任务的执行状态
    private Callable<V> callable; // 要被执行的任务
    private Object outcome; // 返回的结果
    private volatile Thread runner; // 执行当前futuretask的线程
    private volatile WaitNode waiters; // 等待获取结果而阻塞的线程节点
}
```

当提交的任务被包装为FutureTask后,下一步就是提交给线程池执行任务了,下面来看下FutureTask的run()方法「调用路径为：Worker#run()  ->  Pool#runWorker() -> futureTask#run() 」

```java
// 此时是线程池的工作线程在执行这个run()方法
public void run() {
    if (state != NEW || // 状态校验:任务状态需要为NEW,并且cas设置执行当前任务的线程「使用runner属性保存」
        !RUNNER.compareAndSet(this, null, Thread.currentThread()))
        return;
    try {
        Callable<V> c = callable;
        if (c != null && state == NEW) {
            V result;
            boolean ran;
            try {
            // 调用call()方法,如果是RunnableAdapter,那么在内部会调用run()方法
            // 并且获取到返回值 - 注意:如果在call中抛出了异常,那么是会被catch{}到的
                result = c.call(); 
                ran = true; // 否则任务执行没有抛出异常,设置ran = true
            } catch (Throwable ex) {
             // ... 异常处理....
            }
            if (ran) // 如果执行成功,那么设置任务的执行结果
                set(result);
        }
    } finally {
        runner = null;
        int s = state;
        /*
            如果任务的状态>=INTERRUPTING
            这里的处理逻辑要和cancel()的逻辑一起看
        */
        if (s >= INTERRUPTING) 
            handlePossibleCancellationInterrupt(s);
    }
}

// cancel() - 在这里会设置任务的状态为>=INTERRUPTING
public boolean cancel(boolean mayInterruptIfRunning) {
    
    if (!(state == NEW && STATE.compareAndSet
      (this, NEW, mayInterruptIfRunning ? INTERRUPTING : CANCELLED)))
     
     // ....
}

// 如果被中断了:handlePossibleCancellationInterrupt(s)
// 自旋等待执行cancel()方法的线程,将state设置为INTERRUPTED
// 确保中断操作完成
private void handlePossibleCancellationInterrupt(int s) {
    if (s == INTERRUPTING)
        while (state == INTERRUPTING)
            Thread.yield(); // wait out pending interrupt
}
```

+ set(result)

```java
// 当任务正常的执行完毕
protected void set(V v) {
    if (STATE.compareAndSet(this, NEW, COMPLETING)) {  // cas将任务的状态设置为COMPLETING
        outcome = v; // 将返回值存放到outcome属性中
        STATE.setRelease(this, NORMAL); // final state 设置状态为NORMAL,这是一个最终状态
        finishCompletion();// 唤醒因为get()而阻塞的线程
    }
}

// finishCompletion()
    private void finishCompletion() {
        // assert state > COMPLETING;
        for (WaitNode q; (q = waiters) != null;) {
           // 挨个唤醒阻塞的等待节点
        }

        done(); // 在唤醒所有节点后,回调该方法,hook()函数
        callable = null;        // to reduce footprint 将callable设置为null
    }
```

+ 异常处理

```java
public void run() {
    // ...
    try {
        Callable<V> c = callable;
        if (c != null && state == NEW) {
            try {
                result = c.call();
                ran = true;
            } catch (Throwable ex) { // 异常处理
                result = null;
                ran = false;
                setException(ex); // 设置异常信息
            }
           // ....
        }
    } finally {
        // ....
    }
}

// setException()
protected void setException(Throwable t) {
    if (STATE.compareAndSet(this, NEW, COMPLETING)) {
        outcome = t; // 可以看到,在这里会将异常对象设置为返回值
        STATE.setRelease(this, EXCEPTIONAL); // final state
        finishCompletion();
    }
}
```

这里可以看到一个重要的信息：不管任务是执行成功还是执行失败,最终都会将结果存放到返回值中,下面来看get()方法

+ get()

```java
public V get() throws InterruptedException, ExecutionException {
    int s = state;
    if (s <= COMPLETING) // 如果任务"还未完成",那么调用awaitDone()准备阻塞
        s = awaitDone(false, 0L);   
    return report(s); // 否则获取返回值
}

//  Returns result or throws exception for completed task. 
//  这个方法会返回结果 或者 抛出异常(因为异常也被存放在outcoume中)
private V report(int s) throws ExecutionException {
    Object x = outcome;
    if (s == NORMAL) // 如果状态是NORMAL,则返回结果
        return (V)x;
    if (s >= CANCELLED) // 如果是被中断取消,那么抛出CancellationException异常
        throw new CancellationException();
    // 否则抛出的是任务执行时发生的异常
    throw new ExecutionException((Throwable)x);
}

// awaitDone(false, 0L)
// 按照doug lea的代码风格,通常采用的是"乐观方式",也即认为条件很快就会满足,每完成一个操作都重试一下
// 避免无效的上下文切换
private int awaitDone(boolean timed, long nanos)
    throws InterruptedException {
    long startTime = 0L;    // Special value 0L means not yet parked
    WaitNode q = null;
    boolean queued = false;
    for (;;) {
        int s = state;
        // 如果任务的执行状态 > COMPLETING「代表任务介绍,但是不代表任务成功」
        // 那么不需要阻塞
        if (s > COMPLETING) { 
            if (q != null)
                q.thread = null;
            return s;
        }
        else if (s == COMPLETING) // 否则任务执行完毕,正在设置结果,那么通过自旋来等待
            // We may have already promised (via isDone) that we are done
            // so never return empty-handed or throw InterruptedException
            Thread.yield();
        else if (Thread.interrupted()) { // 中断处理
            removeWaiter(q);
            throw new InterruptedException();
        }
        else if (q == null) { // 创建等待节点
            // 忽略超时等待
            q = new WaitNode();
        }
        else if (!queued) // 还没有入队,那么入队列
            queued = WAITERS.weakCompareAndSet(this, q.next = waiters, q);
        // ... 忽略超时等待
        else // 阻塞
            LockSupport.park(this);
    }
}
```

此时的结构如下：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NjJlYWRhZWViNGNhMjg0MWJjNGNhNTc4ZDAzMjg5ZDdfV2lmU1J6TUF4bGg4cnl3WjdRT3lkbUQycnBjaWdad3hfVG9rZW46UWhzMmJySlFGb2VPRHl4ZUdtR2N5M2x5bnJmXzE3Njg2NTYwMjE6MTc2ODY1OTYyMV9WNA)

到这里关于Future的相关知识就简单的介绍到这里，下面看下之前提到的execute()和submit()的异常处理

总结一下FutureTask的工作原理：

基本原理：对于futureTask任务来说，如果有线程想要获取这个任务的执行结果，那么可以通过get()来获取，  
而futureTask内部有state,outcome和waiters属性，其中state用来标识任务的执行状态，outcome用来存放任务执行的返回值，  
当任务没有完成时，但是有线程想要获取任务的执行结果，那么线程将会被包装为一个等待节点插入到waiter中，然后阻塞，  
直到执行完任务的那个线程(通常是工作线程)来唤醒位于waiters上的所有阻塞线&#x7A0B;**「ps:这里是否可以优化?让被唤醒的线程去帮助唤醒,类似共享锁内部的机制,因为由线程池内部的工作线程来唤醒所有的线程,可能会降低线程池的吞吐量」**

如果要实现的话：工作线程只需要唤醒首节点对应的线程即可,然后工作线程就完成了它的工作,而被唤醒的线程在get()中唤醒它的下一个线程(同样只是唤醒一个线程,下面以此类推.....)

## 异常处理
这里再讨论一下关于线程池的异常处理:

通常来说：当执行任务时出现了异常,那么对应的工作线程会退出,然后再替换一个新的工作线程  
但是如果提交给线程池执行的run()方法在内部自己捕获了异常,并且没用再次throw出去,那么是不会替换工作线程的

代码如下：

```java
import com.google.common.util.concurrent.ThreadFactoryBuilder;
import java.util.concurrent.*;

public class Demo_10 {
public static void main(String[] args) {
    ExecutorService executorService = buildThreadPoolExecutor();
    executorService.execute(() -> exeTask("execute-normal"));
    executorService.execute(() -> exeTask("execute-normal"));
    executorService.execute(() -> exeTask("execute-exception"));
    Tools.sleep(3);
    System.out.println("--------再次执行任务---------");
    executorService.execute(() -> exeTask("execute-normal"));
    executorService.execute(() -> exeTask("execute-normal"));
    executorService.execute(() -> exeTask("execute-normal"));
}

public static ExecutorService buildThreadPoolExecutor() {
    return new ThreadPoolExecutor(3, 10, 30L, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>(1000),
          new ThreadFactoryBuilder().setNameFormat("thread-pool-%d").build(),new ThreadPoolExecutor.CallerRunsPolicy()
    );
}

public static void exeTask(String name){
    String printName = "[thread-name:" + Thread.currentThread().getName() + ",执行方式" + name + "]";
    System.out.println(printName);
    if (name.equals("execute-exception")){
        System.out.println("出现异常 - 但是在run()中自己处理了");
        //throw new RuntimeException(printName + "执行任务抛出异常");
        //todo nothing 出现异常,但是不做任何处理 - try()catch{}并且没有继续throw出去
    }
}
}
```

执行结果：线程没有替换

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MmY3ODZiY2E4YzExOGI5YTNmOGFkYmEzMTViZTA3MDhfMnRUV3pNc0hmMzVtYUpidjBaUlRzS0tacTNXQjNGS1NfVG9rZW46RWdhbmIyc042b0VUMDh4a0ZvVWNsQWhqbnFnXzE3Njg2NTYwMjE6MTc2ODY1OTYyMV9WNA)

但是如果没有处理,或者处理了但是继续向外抛,那么就会替换新的线程

```java
public static void exeTask(String name){
    String printName = "[thread-name:" + Thread.currentThread().getName() + ",执行方式" + name + "]";
    System.out.println(printName);
    Tools.sleep(1);
    if (name.equals("execute-exception")){
        System.out.println("出现异常 - 继续向外抛");
        throw new RuntimeException(printName + "执行任务抛出异常"); // 抛出异常
    }
}
```

执行结果：

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=MWE3YzY3YWM1YmYwMjNmZTkzN2U1MzIxZDFjZGE3M2VfNW1oT3hTaThKcWlkM2VSaWhwZlBEYUVnQmNzMnVTbUhfVG9rZW46WEk4ZWJ1VFoxb1VjTGh4bmJRSmNId2NFbmxnXzE3Njg2NTYwMjE6MTc2ODY1OTYyMV9WNA)

+ 但是如果使用的是submit()来提交的话,那么不管是否在run()方法中处理了异常「抛出还是没抛出」,最终在控制台都不会看到异常信息

```java
// 只将execute()修改为submit()
public static void main(String[] args) {
    ExecutorService executorService = buildThreadPoolExecutor();
    executorService.submit(() -> exeTask("execute-normal"));
    executorService.submit(() -> exeTask("execute-normal"));
    executorService.submit(() -> exeTask("execute-exception"));
    Tools.sleep(3);
    System.out.println("--------再次执行任务---------");
    executorService.submit(() -> exeTask("execute-normal"));
    executorService.submit(() -> exeTask("execute-normal"));
    executorService.submit(() -> exeTask("execute-normal"));
}
```

+ 最终结果

<!-- 这是一张图片，ocr 内容为： -->
![](https://scnjnj9snmp7.feishu.cn/space/api/box/stream/download/asynccode/?code=NDZkMTBiNDM5ZmVkYTdlMzg2YWRmYzY3NGY5Zjk3OTZfU3JSM205eENndHVWSHI0bnZURFROR2t0SmhFejFYZzhfVG9rZW46TEYxYWIyV3lQb25WTmp4YnJGV2NvNkZNbnlnXzE3Njg2NTYwMjE6MTc2ODY1OTYyMV9WNA)

这是为什么呢？

原因就在于futureTask的run()方法

```java
public void run() {
    // ....
    try {
        Callable<V> c = callable;
        if (c != null && state == NEW) {
            V result;
            boolean ran;
            try {
                result = c.call(); // 调用具体的方法,不管其内部是否会抛出异常,在FutureTask的run()方法中都会被捕捉
                ran = true;
            } catch (Throwable ex) { // 可以看到,在这里会将异常信息存储在result中,并不会继续向外抛出(也即异常不会被传播到runWorker()中,那么工作线程就不会被替换)
                result = null;
                ran = false;
                setException(ex);
            }
            if (ran)
                set(result);
        }
    } finally {
       // ....
    }
}

// 这并不是丢失异常,因为在调用futureTask.get()方法时,会重新将异常抛出来

```

+ 那么应该如何处理和线程池相关的异常呢?

第一种方式：在我们提交的run()方法中使用try()catch{}来处理异常

当使用execute()来提交的时候,这里需要注意:catch{}中的处理会影响线程池的行为,如果在我们编写的try()catch{}代码中将异常再次通过throw抛出,那么执行当前任务的工作线程会退出(使用一个新的线程来替代当前工作线程)，反正则不会 - 这在上面验证过了。

除此之外,还有另外一个问题：那就是对于每一个提交的任务,都需要通过try-catch来处理,过于繁琐

在这里有另外一种全局的处理方式：当异常抛出时,工作线程的runWorker()方法是会将异常再次抛出的

关于异常的处理机制,后续会单独出一篇文章来讲解

```java
// runWorker()方法
try {
    task.run();
    afterExecute(task, null);
} catch (Throwable ex) {
    afterExecute(task, ex);
    throw ex; // 将异常再次抛出
}

// Worker # run() 这里是没有异常处理机制的,但是最终异常调用堆栈还是会被打出来,这是谁来完成的呢？
public void run() {
    runWorker(this);
}

// jvm-thread
// 异常会被向上传播到线程的 UncaughtExceptionHandler 处理器
// 如果用户没有自定义的异常处理器,那么在这里默认的处理就是打野异常调用栈
```

所以在这里：UncaughtExceptionHandler 就是在全局处理异常的一个可行点

```java
// 全局处理
Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() { // global
    @Override
    public void uncaughtException(Thread t, Throwable e) {
        // todo ex
    }
});

// 单个线程处理
Thread thread = new Thread();
thread.setUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() { 
    @Override
    public void uncaughtException(Thread t, Throwable e) {

    }
});

// 线程池工厂
ThreadFactory threadFactory = new ThreadFactory() {
    @Override
    public Thread newThread(Runnable r) {
        Thread thread = new Thread(r);
        thread.setUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {

            }
        });
        return thread;
    }
};
```

+ 使用案例

```java
public class exHandleTest {
    public static void main(String[] args) {
        ThreadPoolExecutor threadPoolExecutor = new ThreadPoolExecutor(3, 10, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<>(1000), CustomThreadFactory());
        threadPoolExecutor.execute(() -> {
            throw new RuntimeException("--custom error--");
        });
        Tools.sleep(2);

    }

    public static ThreadFactory CustomThreadFactory() {
        return new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread thread = new Thread(r);
                thread.setUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
                    @Override
                    public void uncaughtException(Thread t, Throwable e) {
                        System.out.println(e.getMessage());
                    }
                });
                return thread;
            }
        };
    }
}
// out put
--custom error--
```

但是如果是通过submit()方式来提交任务时,这样的全局异常处理器是不起作用的。

因为即使run()将异常重新抛出,但是submit()会将任务包装为一个futureTask,而futureTask#run()方法则对提交的任务做了try()catch{}处理

```java
// futureTask#run()
try {
    result = c.call();
    ran = true;
} catch (Throwable ex) { // 在这里catch住了异常,并且没有重新抛出,那么线程池的工作线程的runWorker()会认为任务正常执行
    result = null;
    ran = false;
    setException(ex);
}
```

并且由于异常被catch且没有向上抛,那么最终不会被处理器获取,那么设置全局处理器将无法生效,那么还有一种全局方式就是重写线程池的afterExecute()方法

```java
// 工作线程的runWorker()方法
try {
    beforeExecute(wt, task);
    try {
        task.run(); // 这里是futureTask#run(),无论如何,都不会抛出异常的
        afterExecute(task, null); // 在这里可以处理异常
    } catch (Throwable ex) {
        afterExecute(task, ex);
        throw ex;
    }
}
```

+ 使用案例

```java
public static void main(String[] args) {
    ThreadPoolExecutor threadPoolExecutor = new ThreadPoolExecutor(3, 10, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<>(1000), CustomThreadFactory()) {
        @Override
        protected void afterExecute(Runnable r, Throwable t) {
            System.out.println("afterExecute--->");
            if (r instanceof FutureTask) {
                try {
                    Object o = ((FutureTask<?>) r).get();
                } catch (InterruptedException e) {
                    throw new RuntimeException(e);
                } catch (ExecutionException e) {
                    System.err.println(e.getCause());
                    // throw new RuntimeException(e); 可以再次抛出,那么会被handle捕捉
                }
            }
        }

    };
    threadPoolExecutor.submit(() -> {
        throw new RuntimeException("--custom error--");
        //System.out.println("hello world");
    });
    Tools.sleep(2);
}

// out put
afterExecute--->
java.lang.RuntimeException: --custom error--
```
