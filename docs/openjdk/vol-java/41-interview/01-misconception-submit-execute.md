# submit vs execute：同样提交任务，为什么异常一个被装进 Future、一个会炸掉当前 worker

> 基于 JDK 11 `ThreadPoolExecutor`、`AbstractExecutorService` 与 `FutureTask`。本文讨论的是 `execute` 与 `submit` 两条提交路径下任务异常的去向差异，以及 `afterExecute` 为什么在这种差异下会"接不住"异常。这里的异常传播路径是 JDK 11 当前实现事实，不能把 `submit` 的吞异常行为外推成所有执行框架的统一语义。
> **前置依赖**：[execute 流程与 Worker 生命周期](../14-threadpool/02-execute-worker.md)、[未来任务与定时调度](../14-threadpool/04-futuretask-scheduled.md)
> → **后续**：[线程池生产治理](../42-production-practice/01-thread-pool-governance.md)

## 先看一个最容易答错、也最容易踩进生产事故的疑问

几乎所有接触过线程池的人都在一段代码里同时用过这两种提交方式。一种是把任务交给 worker 去跑，不拿返回值；另一种是提交后拿一个能取结果的句柄。直觉上，这两者只是"有没有返回值"的区别。可一旦任务里抛了异常，两者的行为就会彻底分叉。

更让很多人措手不及的是：如果你在一个重写了 `afterExecute` 的线程池里分别用两种方式提交一个必抛异常的任务，会发现只有其中一种能把异常接住。另一种的 `afterExecute` 永远收到 `null`，好像任务从未出问题。

这里至少有三个失败方案值得先推演。

第一种失败方案，是把 `submit` 理解成" `execute` 加一个返回值包裹"。这样想的话，你会天然期待异常在两条路径上以同样方式传播，于是 `afterExecute` 里接不到异常时就误判"任务执行成功了"。

第二种失败方案，是直接用 `Future.get()` 的返回值原始直观感受任务结果，却忽略 `get()` 抛出来的往往是二次包装的 `ExecutionException`，而不是任务内部异常本体。你在排查问题时一路追 `getCause()`，才知道异常曾经真实发生过。

第三种失败方案，是只在 `execute` 路径上验证过 `afterExecute` 能接异常，就默认 `submit` 也一定可以。这个假设在生产里很常见，直到某天监控发现"线程池一个任务都没报过错，但业务数据已经错了一批"。

所以这三个失败方案指向同一个顿悟：**`submit` 与 `execute` 的差异不在"返回值"，而在"异常所有权"。`execute` 把异常的所有权留在任务本身，worker 层看得见；`submit` 把异常的所有权收进了 FutureTask 的状态机里，worker 层只能看到一个"已经结束、但不抛异常"的任务。**

## 一、先看 `runWorker` 怎么调用任务：`afterExecute` 的异常参数从哪来

### Worker 执行任务的真实结构

线程池的 worker 并不是直接 `task.run()` 就结束，它在每次执行完任务后都会调用 `afterExecute`，并用 try/catch 决定异常参数怎么传。JDK 11 的 `runWorker` 主循环里是这样组织的：

```java
// ThreadPoolExecutor.java:1124-1131(截取核心,逐字)
try {
    beforeExecute(wt, task);
    try {
        task.run();
        afterExecute(task, null);
    } catch (Throwable ex) {
        afterExecute(task, ex);
        throw ex;
    }
} finally {
    task = null;
    w.completedTasks++;
    w.unlock();
}
```

把这个结构拆开看：

- `task.run()` 正常返回：执行 `afterExecute(task, null)`，异常参数是 `null`
- `task.run()` 抛异常：执行 `afterExecute(task, ex)`，异常参数是真实异常

对 `execute(Runnable)` 来说，task 通常就是那个 Runnable 本身。它如果抛异常，worker 一定能抓住，并把异常交给 `afterExecute`。这是最直白的路径。这里有一个边界要提一句：如果你显式把 `FutureTask` 塞给 `execute`，它也会走 `FutureTask.run()` 的吞异常路径——`execute` 并不要求参数必须是裸 Runnable，能不能拿到异常取决于你传进去的 task 对象本身是否自带异常处理。

还有一个后果值得记住：`runWorker` 在 `afterExecute(task, ex)` 之后又把异常 `throw ex` 抛出主循环。这个异常会打断当前 worker 的"循环取活"，让它带着 `completedAbruptly = true` 走完最后收尾，再进入 `processWorkerExit` 触发补位。也就是说，`execute` 的任务异常不仅会被 worker 层看到，还会让当前 worker 提前退休、由线程池按状态补一个新工人。而 `submit` 路径不会发生这件事——`FutureTask.run()` 从不往外抛，worker 会继续优雅地取下一个任务。

### 关键转折：submit 传进来的不是 Runnable，而是 RunnableFuture

先停一下，这里已经走到第一个关键分叉了。前面讲的是 execute 路径下异常怎么暴露，下面要讲的是 submit 的包装层怎样把异常从 worker 视角移走。主线是"runWorker 一致，但 task 对象的行为不同"。

`submit` 在 `AbstractExecutorService` 里并不是直接把你的任务塞进 `execute`，而是先走一层包装：

```java
// AbstractExecutorService.java:114-118(截取核心,逐字)
public Future<?> submit(Runnable task) {
    ...
    RunnableFuture<Void> ftask = newTaskFor(task, null);
    execute(ftask);
    return ftask;
}
```

`newTaskFor` 的默认实现把裸任务包进 `FutureTask`（`AbstractExecutorService.java:92-95`）。这个被 `execute` 拿去跑的对象，是一个 `FutureTask`，而不是你原来的 Runnable。

于是 `runWorker` 里 `task.run()` 执行的是 `FutureTask.run()`，它自己内部有一套异常处理。worker 层面根本看不到你原始任务的异常。

## 二、`FutureTask.run()` 为什么能把异常"藏"起来

### FutureTask 内部先接住异常，再写进状态机

`FutureTask.run()` 的骨架是：

```java
// FutureTask.java:254-271(截取核心,逐字)
public void run() {
    ...
    try {
        Callable<V> c = callable;
        if (c != null && state == NEW) {
            V result;
            boolean ran;
            try {
                result = c.call();
                ran = true;
            } catch (Throwable ex) {
                result = null;
                ran = false;
                setException(ex);
            }
            if (ran)
                set(result);
        }
    } finally {
        ...
    }
}
```

它在内部用一个 `try/catch` 把所有 `Throwable` 都接住了：如果是异常就走 `setException(ex)`（`FutureTask.java:246`），把异常当作完成结果写进 `outcome` 字段和状态机；如果正常返回就走 `set(result)`。

对 `runWorker` 来说，它调用的 `task.run()` 是 `FutureTask.run()`。这个方法是不会往外抛异常的——异常都在方法内部被消化成状态了。所以 `runWorker` 会走 `afterExecute(task, null)` 那条正常分支，`afterExecute` 收到的异常参数永远是 `null`。

### 异常去哪了：`outcome` 与 `Future.get()`

`outcome` 字段保存的不是正常结果就是被吞掉的异常（`FutureTask.java:104`）。调用方拿到的 `Future` 在 `get()` 时，会根据状态机重新把异常恢复出来：

- 如果任务是异常完成的，`get()` 会抛出包装后的 `ExecutionException`
- 异常本体在 `ExecutionException` 的 `cause` 里

于是这里形成两条完全不同的"异常可见性"：

```text
execute(Runnable)
  → task.run() 直接跑原始 Runnable
  → 异常在 runWorker 里能被 afterExecute 抓住
  → 不被 Future 持有

submit(Runnable)
  → task.run() 跑 FutureTask.run()
  → 异常被 FutureTask 内部 setException 吞进 outcome
  → worker 层看不到，afterExecute 收到 null
  → 只有 Future.get() 能把它以 ExecutionException 重新暴露出来
```

## 三、为什么这不是 bug，而是"所有权转移"的设计取舍

### execute 的语义：任务自己负责，异常就地暴露

`execute` 的设计意图是"让这个任务尽快被某个 worker 完整执行，任务产生的后果由任务内部自行吸收或用 afterExecute 兜底"。它不承诺给你一个能事后查询结果的句柄，所以异常要么传给你重写的 `afterExecute`，要么沿原路径再抛出来，打断当前 worker 并触发它的退出。

### submit 的语义：结果与异常都委托给 Future

`submit` 的设计意图是"给你一个能控制、能等待、能取结果、能感知异常的状态句柄"。为了让 `get()` 能完整反映任务的结局，FutureTask 必须把正常结果和异常都保存进自己的状态机。`afterExecute` 是 worker 层的观测点，而 `submit` 把观测义务移交给了调用方通过 `get()` 完成。这不是 design smell，而是"任务结局归谁所有"的明确分工。

### 那句容易误导的话

很多人会背一句"submit 不抛给线程池，所以生产上不要用 submit 让它安静失败"。更准确的说法是：**submit 没有安静失败，它把失败锁进了 Future 里；安静的只是 worker 层和 afterExecute，调用方不主动 get，异常就一直休眠在 outcome 里。** 这也解释了为什么很多线程池埋点的告警会错过 submit 任务：不是线程池不帮你记，而是异常去了另一方。

## 四、`afterExecute` 想接住 submit 的异常该怎么做

### 先承认 afterExecute 的边界

JDK 11 的 `afterExecute` 注释本来就专门指出：当任务被 FutureTask 包住（不论显式包装还是 `submit`），内部异常不会传入 `afterExecute`。需要同时覆盖两类任务的观测者，必须自己从当前任务里把 Future 里的异常"捞"出来。

`ThreadPoolExecutor` 自己给的示例思路是这样的：在 `afterExecute` 里，如果异常参数是 null、且当前任务实现了 `Future`、且它已经 done，就尝试 `get()` 去取回被吞掉的异常：

```java
// ThreadPoolExecutor.java:1969(截取,JDK 注释示例)
protected void afterExecute(Runnable r, Throwable t) {
    super.afterExecute(r, t);
    if (t == null && r instanceof Future<?> && ((Future<?>)r).isDone()) {
        try {
            Object result = ((Future<?>) r).get();
        } catch (CancellationException ce) {
            t = ce;
        } catch (ExecutionException ee) {
            t = ee.getCause();
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        }
    }
    if (t != null)
        // 现在 t 才真正代表 submit 任务内部的异常
}
```

这个例子的价值在于点明方向：**真正统一的异常观测点，不是"相信 afterExecute 的异常参数"，而是"把 execute 的直接异常与 submit 的 Future 异常都归并把回同一处"。**

### 那调用方侧呢

对使用 `submit` 并期望得到结果的调用方来说，正确姿势是：拿到 Future 后按需 `get()`，并且意识到 `get()` 抛出的是 `ExecutionException`，要拿到根因必须继续拆 `getCause()`。如果业务根本不在乎结果，也不想承担"未来异常被锁住"的语义，那当初就不该用 `submit`，直接用 `execute` 并把异常处理塞进任务内部即可。

## 五个最容易混掉的边界：submit 不是 execute 加返回值，afterExecute 不保证接住所有异常，"安静失败"不是 bug，ExecutionException 不是任务本体异常，任务异常也不是取消

第一，`submit` 不是 `execute` 加返回值。它先经过 `newTaskFor` 包装成 `FutureTask`，再交给 `execute`。返回值只是额外产物，真正的差异在异常所有权被移交给了 Future 状态机。

第二，`afterExecute` 不保证接住所有异常。它只能从 worker 层直接看到的 `task.run()` 路径拿异常；被 `FutureTask` 内部接住的异常不会出现在异常参数里，需要主动从 `Future.get()` 探回。

第三，"安静失败"不是 bug。`submit` 任务出现异常后线程池看起来"没动静"，是异常被收进 `outcome` 的结果，不是线程池吞掉了它。调用方不 `get()`，这个失败就长期休眠。

第四，`ExecutionException` 不是任务本体异常。`Future.get()` 抛出的包装异常，根因在 `getCause()` 里；排查时只看到最外层，你会一路困惑"任务明明抛了 A，为什么这里只有 B"。

第五，任务异常也不是"取消"。`submit` 任务是异常完成，`get()` 会抛 `ExecutionException`；只有调用方显式 `cancel()` 之后，`get()` 才会抛 `CancellationException`。这两者是不同结局，不能混成一类处理。

把这五条边界记稳，`submit` 与 `execute` 就不会再被简化成"带不带结果"的选择题。它真正想讲的是一次异常所有权转移：`execute` 让 worker 层认领异常，`submit` 让 Future 状态机认领异常；而你选择哪一种提交方式，实际上是在选择由谁来负责观察失败。

## 收网：提交方式选择的不是"要不要返回值"，而是"异常所有权归谁"

回到开头那个最容易答错的问题，现在已经能看清分叉的真正原因了。

`execute` 直接跑你的任务，异常沿 worker 层暴露，`afterExecute` 能看见，异常会打断当前 worker 并触发补位。`submit` 先把你打包进 `FutureTask`，异常被内部状态机接住，worker 层只能看到"任务结束但没抛异常"，只有 `Future.get()` 才能把异常以 `ExecutionException` 的形式挖出来。

把整篇压成一张总图：

```text
execute(Runnable)
  → task.run() = 原始 Runnable
  → 异常 → runWorker catch → afterExecute(task, ex)
  → 会重新抛，打断当前 worker

submit(Runnable/Callable)
  → newTaskFor → FutureTask
  → task.run() = FutureTask.run()
  → 内部 catch(Throwable) → setException → outcome
  → runWorker 视角 task.run() 没抛 → afterExecute(task, null)
  → 异常只能经 Future.get() → ExecutionException(cause) 取回
```

所以当你写代码时，真正该问的不是"要不要拿返回值"，而是：**这个任务失败之后，谁来负责看见它？是我在 worker 层用 afterExecute 兜底，还是我保留 Future 句柄、在合适的时机 get() 并拆根因。** 选错的一方，异常并不会消失，只是去了你不在场的那一边。