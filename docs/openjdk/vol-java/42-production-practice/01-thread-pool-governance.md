# 线程池生产治理：为什么"配置一次就再也不动"才是线上最大的坑

> 基于 JDK 11 `ThreadPoolExecutor`。本文讨论的是线程池参数动态调整、预热、执行钩子与低扰动观测的工程实践，不把这里的 `prestartCoreThread` 预热策略、`setCorePoolSize` 的启发式扩缩行为或 `afterExecute` 中通过 Future 捕获异常的方式外推成所有线程池管理框架都必须遵守的统一规范。
> **前置依赖**：[ctl 与 Worker](../14-threadpool/01-ctl-worker.md)、[execute 流程与 Worker 生命周期](../14-threadpool/02-execute-worker.md)
> → **后续**：[submit vs execute：异常为什么表现不同](../41-interview/01-misconception-submit-execute.md)

## 先看一个最容易忽略的生产现场

线上线程池的参数配好之后，很多人就不再动它了。核心线程数、最大线程数、队列容量、超时时间，这些值在启动时写在配置里，上线后就像被焊死在 JVM 里一样。等到流量高峰一来，任务积压看涨、拒绝计数开始上涨，第一反应往往是"是不是并发太高了，要不要调大 corePoolSize"，然后发现——改了参数要重启。

这不是一个"重启代价大"的问题，而是"线程池本来就能在运行中调整，但没人知道它已经准备好了这件事"。

更具体一点，这里至少有三个常见的失败方案。

第一种失败方案，是把线程池参数当成"一次性配好就封存"的静态配置。核心线程不够了，就重启改配置文件；队列满了，就重启加容量。重启不是免费的：正在执行的任务可能被打断，队列里积压的任务要么被丢弃、要么只能等下次再补，进程要重新经过类加载和预热窗口才能回到稳定吞吐。每一步都在浪费线程池本可直接调整的治理能力。

第二种失败方案，是监控靠 `ThreadMXBean.getAllThreadIds()` 每隔几秒扫一次全量线程。这里要说清边界：线程收集的量级与停顿开销属于工程经验，不是 JDK 11 规范承诺的事实，不同 JVM 实现的行为可能不同；但它至少不会告诉你"线程池里有多少活跃工人、积压了多少任务"——这些信息从 `ThreadPoolExecutor` 自己的状态 API 直接就能拿到，不需要去扫描 JVM 里所有线程。

第三种失败方案，是重写了 `afterExecute` 想捕获任务异常，却发现 `t` 始终是 `null`。原因是 `submit()` 提交的任务被包装成了 `FutureTask`，异常被 `FutureTask` 内部捕获并保存到 `outcome` 字段，根本不会沿 `afterExecute` 的异常参数传出来。你以为自己做了异常兜底，实际上异常路径根本没走通。

所以这三个失败方案指向同一个顿悟：**ThreadPoolExecutor 本身就是一台"可运行中调整"的状态机。预热方法、参数 setter、执行钩子和状态查询接口都是它的第一公民，问题只在于没有人把它认真当成动态系统来治理。**

接下来按"准备资源 → 调整容量 → 观测执行 → 观测状态"四步把这条治理能力拆开。这里先立一个路标：前三节是主线，全部围绕怎样让线程池在运行中被管理；每一节的代码都只是证据，主线不依赖它们也能跟上。

## 一、预热：为什么 core 线程不会自己先活着

### 默认 lazy 是成本保护，不是功能缺陷

线程池在默认行为下，不会在 `execute()` 之前创建任何 worker。`getPoolSize()` 在第一次提交任务前返回 0。这意味着第一波任务的响应时间可能被线程创建成本垫高。这个设计本身不是缺陷——它省掉了"可能永远用不到的线程"。但在流量确定性较高的场景里（比如定时任务、大促、服务预热期），这种省法反而会造成启动瞬间的毛刺。

### 预热入口

JDK 11 的 `ThreadPoolExecutor` 公开了两个预热入口：

- `prestartCoreThread()`（`ThreadPoolExecutor.java:1571`）：尝试启动一个核心 worker，如果所有核心线程都已就绪，返回 false。
- `prestartAllCoreThreads()`（`ThreadPoolExecutor.java:1595`）：循环调用 `addWorker(null, true)`，尽量把全部核心 worker 都启动起来，返回实际启动的数量。

```java
// ThreadPoolExecutor.java:1571-1574
public boolean prestartCoreThread() {
    return workerCountOf(ctl.get()) < corePoolSize &&
        addWorker(null, true);
}
```

```java
// ThreadPoolExecutor.java:1595-1600
public int prestartAllCoreThreads() {
    int n = 0;
    while (addWorker(null, true))
        ++n;
    return n;
}
```

这两个方法的核心特征是：它们创建的是不带 `firstTask` 的 worker，这些工人启动后会直接进入 `getTask()` 等待队列中的任务。也就是说，预热不是"提前执行业务逻辑"，而是"提前把核心工人资源准备好，让它们在线等活"。

### 什么时候应该预热

- 服务启动后预期流量会快速到达，不希望第一波请求被线程创建延迟拖慢
- 底层线程资源创建成本较高（例如某些网关或自定义线程工厂）
- 预热的代价很低：不启动的线程不花钱，启动后 idle 的 worker 也只占栈空间

## 二、动态参数：为什么 setter 才是治理主入口

### 先拆掉"参数只能靠重启改"的误解

很多人对线程池参数的第一印象是"构造时传入，后面不能再动"。这个想法来自很多框架组件的参数不可变设计，但 `ThreadPoolExecutor` 的方法签名本身就暴露了答案：`setCorePoolSize`、`setMaximumPoolSize`、`setKeepAliveTime`、`allowCoreThreadTimeOut`，这些方法是线程安全的，并且专门为运行期调整设计。

### setCorePoolSize 的两条语义分支

`setCorePoolSize(int)` 位于 `ThreadPoolExecutor.java:1533`。它不是一个简单的"把数字改掉"的赋值动作，而是两条不同的语义路径：

```java
// ThreadPoolExecutor.java:1533-1551
public void setCorePoolSize(int corePoolSize) {
    if (corePoolSize < 0 || maximumPoolSize < corePoolSize)
        throw new IllegalArgumentException();
    int delta = corePoolSize - this.corePoolSize;
    this.corePoolSize = corePoolSize;
    if (workerCountOf(ctl.get()) > corePoolSize)
        interruptIdleWorkers();
    else if (delta > 0) {
        int k = Math.min(delta, workQueue.size());
        while (k-- > 0 && addWorker(null, true)) {
            if (workQueue.isEmpty())
                break;
        }
    }
}
```

缩小核心（`delta < 0`）时，当前 worker 数超过新 core 值，线程池不会直接杀死正在执行任务的工人，而是调用 `interruptIdleWorkers()`，只唤醒那些阻塞在 `getTask()` 上的空闲线程。它们醒来后发现 workerCount 已经超过新阈值，就会自然退出。

扩大核心（`delta > 0`）时，线程池不是直接启动 `delta` 个新工人，而是根据当前队列积压量做启发式判断：`Math.min(delta, workQueue.size())`。如果队列根本没积压，就不会盲目补多余工人。

### 为什么其他 setter 也是安全的

- `setMaximumPoolSize`（`ThreadPoolExecutor.java:1658`）：如果新值小于当前 workerCount，同样触发 `interruptIdleWorkers()`。
- `setKeepAliveTime`（`ThreadPoolExecutor.java:1692`）：修改超时时间会影响 `getTask()` 中 `poll()` 的等待时长，已在执行的 worker 不受影响。
- `allowCoreThreadTimeOut(boolean)`（`ThreadPoolExecutor.java:1636`）：开启后，核心线程也会走超时路径，`getTask()` 中 `timed` 标志会因此改变。

这些 setter 的设计说明一个事实：**线程池的治理接口不是"顺便提供一下"，而是内置在状态机设计里的一等能力。**

### 动态调参最典型的两种场景

- 流量高峰时调大核心/最大线程数：让更多 worker 分担压力，避免排队深度过快增长。
- 流量回落后调小核心/提高 `allowCoreThreadTimeOut`：让空闲 worker 逐步退出，把线程资源释放回系统。

### 为什么调大 core 后工人不会立刻全部补齐

这里值得先推演一个最直觉、却会被源码否掉的预期：调大 `corePoolSize` 后，很多人会以为线程池立刻把差值 `delta` 个工人全部创建出来。但 `setCorePoolSize` 里的实现已经说明，它补人不是按"差多少补多少"执行，而是按队列积压量做启发式：`Math.min(delta, workQueue.size())`，并且每补一个就检查队列是否已空、空了就停。

换句话说，线程池不信任"你调大了数字，就代表马上需要这么多人"。它相信的是"队列里真的还有活没人干"。如果扩参后队列是空的，线程池不会先把工人铺满；它把名额留好，等任务真的来了再由 `execute` 按资源决策链逐步创建。这个设计对治理者有个直接含义：**调大参数是给容量松绑，不等于立刻扩容；想立刻见效，要么队列里确实有积压，要么配合 `prestartAllCoreThreads()` 立即预热。**

### 这边再补一个调参场景推演

如果把 `corePoolSize` 从 2 调到 10，而 `maximumPoolSize` 仍顶在 6，`setCorePoolSize` 会直接抛 `IllegalArgumentException`——因为入参不能大于 `maximumPoolSize`。治理脚本如果不先读当前 maximum 再计算目标值，就可能在动态策略里把参数调到非法区间。这也是为什么"动态调参不是无约束施法"：接口允许运行中改，但语义约束仍然存在。

## 三、beforeExecute/afterExecute 的正确姿势：submit 的异常为什么抓不到

### 先看最直觉也最容易出错的写法

很多人在 `ThreadPoolExecutor` 子类里重写 `afterExecute`，想在任务出异常时做日志、告警或计数：

```java
@Override
protected void afterExecute(Runnable r, Throwable t) {
    if (t != null) {
        // 记录异常
    }
}
```

这个写法对 `execute()` 提交的任务是有效的——异常会沿 `runWorker` 的 catch 路径传出来。但对 `submit()` 提交的任务，`t` 几乎永远是 `null`。

### 原因：FutureTask 吞掉了异常

`submit()` 会把 `Runnable` 或 `Callable` 包装成 `FutureTask`，`FutureTask.run()` 内部用 `try/catch` 捕获了所有异常，把它们写进 `outcome` 字段，而不是向上抛出。因此 `afterExecute` 的 `Throwable` 参数收不到它。

JDK 11 的 `afterExecute` 注释直接给出了一个示例，说明怎样在 `afterExecute` 中主动探测 Future 里的异常：

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
        // 现在 t 才真正代表异常，可以记录、告警或上报
}
```

这个设计说明两条边界：第一，`execute` 和 `submit` 的异常传播路径不同，不能只用 `afterExecute` 的异常参数覆盖所有场景；第二，`afterExecute` 的职责不是"替调用方捕获异常"，而是"给线程池管理者一个按任务粒度做观测的点"。

## 四、观测优先级：getXxx 状态 API 比全量线程采样更安全

### 线程池自带的状态查询方法

JDK 11 的 `ThreadPoolExecutor` 提供了一组状态查询入口，它们返回的是线程池内部已经维护好的计数器或快照值，不需要额外遍历线程栈：

- `getPoolSize()`（`ThreadPoolExecutor.java:1794`）：当前 worker 数量
- `getActiveCount()`（`ThreadPoolExecutor.java:1813`）：正在执行任务的 worker 数量
- `getCompletedTaskCount()`（`ThreadPoolExecutor.java:1876`）：已完成任务总数
- `getTaskCount()`（`ThreadPoolExecutor.java:1851`）：历史总任务数（含已完成和未完成）
- `getQueue()`（`ThreadPoolExecutor.java:1730`）：返回工作队列引用，可用于查询 `queue.size()` 积压量

线上观测线程池状态时，应该优先使用这些方法。它们直接反映线程池内部的关键事实，不需要额外遍历或采样。

### 一个常见的禁忌：全量线程采样

`ThreadMXBean.getAllThreadIds()` 或 `ThreadMXBean.getThreadInfo()` 这类方法不是线程池专有的监控入口。这里分开说：JDK 11 规范本身没有承诺这些方法的耗时或停顿量级，工程经验显示它们的工作方式是请求 JVM 收集当前所有线程信息，量级上可能接近一次轻量线程转储，而且不会告诉你"哪些线程是线程池的 worker"、"当前积压多少任务"。

如果要监控线程池，更合适的做法是：把 `getPoolSize()`、`getActiveCount()`、`getCompletedTaskCount()` 和 `getQueue().size()` 等指标暴露给 JMX 或 Micrometer 等可观测系统，而不是在代码里高频采集全量线程数据。

## 五个最容易混掉的边界：预热不是扩大容量，setCorePoolSize 缩小不是清场，afterExecute 的 null 不代表无异常，getActiveCount 不是积压数，动态调参也不是无约束施法

第一，预热不是扩大容量。`prestartAllCoreThreads` 只是把核心 worker 提前创建出来，让它们在线等活，并不能改变 `corePoolSize` 或 `maximumPoolSize` 的上限。把预热误解成"扩容"，会在流量真实超过核心容量时仍然依赖那几根提前启动的线程。

第二，`setCorePoolSize` 缩小不是清场。core 缩小时线程池只中断空闲 worker，正在执行任务的工人不会被强行打断。如果你期望"一缩 core 立刻所有线程全部退出"，那需要先确认当前没有正在执行的活，或者等到它们自然完成。

第三，`afterExecute` 的 `t == null` 不代表无异常。对 `submit` 提交的任务，异常被 `FutureTask` 吞进了 `outcome`，`afterExecute` 的异常参数根本收不到它。只有通过探测 `Future` 的 `get()` 才能拿到被吞掉的异常。

第四，`getActiveCount()` 不是积压数。它返回的是"正在执行任务的 worker 数"，不是"队列里排了多少任务"。要衡量积压，应该看 `getQueue().size()` 或 `getTaskCount() - getCompletedTaskCount()`。

第五，动态调参也不是无约束施法。`setCorePoolSize` 入参不能为负数，也不能大于 `maximumPoolSize`，否则直接抛 `IllegalArgumentException`。调参时必须先保证 `corePoolSize <= maximumPoolSize` 这个不变式，否则 setter 会拒绝执行。

把这五条边界记稳，线程池生产治理就不会再塌回"配置一次就再也不动"的静态心智。它真正想讲的是：ThreadPoolExecutor 的预热、setter、钩子和状态查询接口共同构成了一个可运行中管理的系统，治理的核心不是"重启时改参数"，而是"在线时看状态、调容量、收异常"。

## 收网：线程池治理不是重启时改配置，而是运行中看状态、调容量、收异常

回到开头那三个失败方案，现在已经能看清它们为什么是管理方把线程池用窄了。

管理者如果想在运行中治理线程池，动态参数 setter 不是"历史遗留的偶尔可调接口"，而是状态机设计里预留的治理入口。预热方法不是"可有可无的小功能"，而是解决启动毛刺的标准手段。`beforeExecute`/`afterExecute` 不是"装饰回调"，而是按任务粒度观测执行周期的钩子。状态查询 API 不是"辅助调试方法"，而是比 `ThreadMXBean` 全量采样更轻、更准确的监控入口。管理者真正要做的，不是重启时改配置，而是把这些接口串成"看状态、调容量、收异常"的在线闭环。

把整篇压成一张总图，就是：

```text
线程池生产治理
   ├── 预热：prestartCoreThread / prestartAllCoreThreads
   │    └── 提前启动核心 worker，不在线等活
   ├── 动态参数：setCorePoolSize / setMaximumPoolSize / setKeepAliveTime / allowCoreThreadTimeOut
   │    ├── 缩小：只杀空闲，不杀在跑
   │    └── 扩大：按队列积压启发式补人
   ├── 执行钩子：beforeExecute / afterExecute
   │    ├── execute 异常：直接传 t
   │    └── submit 异常：被 FutureTask 吞掉，需 probe Future
   └── 状态观测：getPoolSize / getActiveCount / getCompletedTaskCount / getQueue().size()
        └── 比 ThreadMXBean 全量采样更轻、更准确
```

到这里，主线已经走完了"准备资源、调整容量、观测执行、观测状态"四步。如果前几篇讲的是线程池的状态机、提交路由和 Worker 生命周期，这一篇真正补上的就是：**这些机制在线上怎么被真正用起来。**