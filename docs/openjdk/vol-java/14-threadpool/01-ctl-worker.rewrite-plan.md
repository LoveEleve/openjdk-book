# 14-threadpool/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ThreadPoolExecutor`。本文聚焦 `ctl` 打包字段、运行状态常量、`runStateOf/workerCountOf/ctlOf`、`Worker` 结构、`interruptIfStarted`、核心参数与 `workQueue` 角色；`execute` 主流程、`addWorker`、shutdown 与拒绝策略放到后续篇章展开。
> 目标：把“TPE 核心”改写成一篇围绕“线程池为什么不是‘开几个线程’这么简单，而是一套把运行状态、工人数量和任务载体绑进同一个状态机”的机制文章。

## 1. 读者困惑

- 为什么 `ThreadPoolExecutor` 的核心不是线程数，而是一个叫 `ctl` 的打包整数？
- 运行状态和 worker 数量为什么要塞进同一个 `AtomicInteger`，拆成两个字段不行吗？
- `RUNNING`、`SHUTDOWN`、`STOP`、`TIDYING`、`TERMINATED` 这些状态真正改变了什么行为？
- Worker 为什么要继承 AQS，它不是一个普通 Runnable 包装就够了吗？
- `firstTask`、`completedTasks`、`interruptIfStarted` 这些字段为什么都挂在 Worker 身上？
- 线程池的 core/max/workQueue 等参数为什么不是独立旋钮，而是同一条决策链上的约束？

## 2. 一句话顿悟

**ThreadPoolExecutor 的核心不是“有多少线程”，而是“当前还接不接任务、还允不允许工人继续活、现在队列和工人数该怎么配合”这套联合状态。`ctl` 把运行状态和 worker 数量压进一个原子整数，避免两份共享变量之间出现中间态；`Worker` 则把真实线程、首任务、已完成任务数和中断控制绑成线程池可管理的工人实体。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `ctl` 的高低位打包、五个运行状态、Worker 的三元结构和核心参数列表。
- 已指出 Worker 继承 AQS 与中断控制相关，这个抓手是对的。
- 已把 `execute` 与 `addWorker` 留给后续篇章，边界划分合理。

### 必须重写

- 旧稿像概念拆分卡片，需要先建立总问题：线程池为什么不能只靠“线程数 + 队列”两件事拼出来。
- `ctl` 需要讲成“联合状态”而不是单纯位运算技巧。
- 状态常量要回到“策略变化”主线，不能只列名字。
- Worker 要从“为什么不能只是 Thread + Runnable”切入，强调它是线程池控制单元。
- 参数部分应强调它们如何共同决定行为，而不是表格式背诵。

## 4. 理解路径

### 第一节：从“线程池不是开几个线程”这个误区开场

用最常见误解开场：很多人把线程池看成“预先开 N 个线程 + 一个队列”。指出真正问题：线程池必须同时管理是否接新任务、队列中任务是否还要继续清、当前工人数能否再涨、什么时候该收尾终止。单看线程数根本不够描述这套系统。

### 第二节：`ctl` 为什么是一字段两用的联合状态

证据：
- `ThreadPoolExecutor.java:380`：`ctl`
- `ThreadPoolExecutor.java:381`：`COUNT_BITS`
- `ThreadPoolExecutor.java:382`：`COUNT_MASK`
- `ThreadPoolExecutor.java:385-389`：状态常量
- `ThreadPoolExecutor.java:392-394`：`runStateOf` / `workerCountOf` / `ctlOf`

主线：
- 高位表示运行状态，低位表示 workerCount。
- 线程池经常要同时检查和更新“当前状态 + 当前工人数”；把它们拆成两个共享字段，会出现读到交叉中间态的问题。
- `ctl` 不是炫位运算，而是在用一次 CAS 保持联合事实一致。

### 第三节：五个运行状态为什么不是标签，而是策略

证据：
- `ThreadPoolExecutor.java:346-367`：类注释中状态与迁移说明
- `ThreadPoolExecutor.java:385-389`：状态常量
- `ThreadPoolExecutor.java:678+` / `692+`：`advanceRunState`、`tryTerminate`（后续篇章详细展开，但本文先立语义）

主线：
- `RUNNING`：接新任务，也处理队列。
- `SHUTDOWN`：不再接新任务，但会继续清队列。
- `STOP`：不接新任务，不再处理队列，还要中断在跑任务的 worker。
- `TIDYING/TERMINATED`：进入完全收尾阶段。
- 状态不是记录历史，而是立即改变提交、排队、执行和中断策略。

### 第四节：Worker 为什么不能只是 Thread + Runnable

证据：
- `ThreadPoolExecutor.java:596-611`：`Worker` 类头与关键字段
- `ThreadPoolExecutor.java:620-628`：`Worker(Runnable firstTask)`
- `ThreadPoolExecutor.java:659`：`interruptIfStarted`

主线：
- Worker 既要持有真实线程，又要带着首任务进入 runWorker，还要统计 completedTasks。
- 它继承 AQS，不是为了“再造一把锁”，而是为了让线程池能用这个独占状态判断 worker 是否空闲、是否适合被中断。
- 这说明 Worker 是线程池的管理单元，不是普通的 Runnable 包装壳。

### 第五节：为什么 `firstTask`、`completedTasks`、中断控制都挂在 Worker 上

证据：
- `ThreadPoolExecutor.java:609`：`firstTask`
- `ThreadPoolExecutor.java:611`：`completedTasks`
- `ThreadPoolExecutor.java:628`：`runWorker(this)`
- `ThreadPoolExecutor.java:988`：汇总 completedTaskCount（后续篇章会再展开）

主线：
- `firstTask` 让新建 worker 可以带任务出生，而不是必须先进队列再取一次。
- `completedTasks` 让线程池能在 worker 维度累计已完成任务。
- `interruptIfStarted` 说明中断控制也不是对 Thread 裸调，而是受 worker 生命周期状态约束。

### 第六节：核心参数为什么必须放回同一条行为决策链里看

证据：
- `ThreadPoolExecutor.java:447`：`workQueue`
- `ThreadPoolExecutor.java:538-547`：core/max 与 COUNT_MASK 说明
- 构造参数相关行在后续篇章按需再补，可本文先基于字段语义收束

主线：
- `corePoolSize` 决定常驻工人数基线。
- `maximumPoolSize` 决定在排队之外还能把工人数拉到多高。
- `workQueue` 决定任务是先缓冲还是先促使扩线程。
- `keepAliveTime` / `threadFactory` / `handler` 都要放回“线程池如何扩缩和饱和”这条链里理解。
- 这一篇先建立心智，下一篇再讲 `execute` 如何实际走 core → queue → max → reject 这条决策链。

## 5. 失败方案清单

1. 把线程池理解成“固定几个线程 + 一个队列”，忽略运行状态机。
2. 用两个独立共享字段分别管理 runState 与 workerCount，期待检查和更新永远不会读到交叉中间态。
3. 把 `RUNNING/SHUTDOWN/STOP` 当历史标签，不当策略开关。
4. 把 Worker 当成普通 Runnable 包装，忽略它承担的中断控制和计数职责。
5. 把 core/max/workQueue 当独立参数分别调，不放回同一条执行决策链里看。
6. 以为 shutdown 只是“线程不再运行”，忽略队列任务处理策略差异。
7. 以为线程池的所有行为都发生在 `execute` 一次方法体里，而和 worker 生命周期无关。

## 6. 误解清单

1. 线程池状态是 7 态、8 态随便讲都行，源码常量不重要。
2. `ctl` 只是节省字段数的技巧，对并发一致性没有帮助。
3. Worker 继承 AQS 是为了复用条件队列功能。
4. `firstTask` 只是构造器参数缓存，对线程池语义没影响。
5. `completedTasks` 只是统计信息，不参与任何管理视图。
6. `workQueue` 只是存任务的容器，不影响扩线程和拒绝时机。
7. 线程池参数可以脱离任务模型单独“调最优值”。

## 7. 证据清单

- `ThreadPoolExecutor.java:346-367`：运行状态与迁移注释
- `ThreadPoolExecutor.java:380`：`ctl`
- `ThreadPoolExecutor.java:381`：`COUNT_BITS`
- `ThreadPoolExecutor.java:382`：`COUNT_MASK`
- `ThreadPoolExecutor.java:385-389`：状态常量
- `ThreadPoolExecutor.java:392-394`：拆包/打包方法
- `ThreadPoolExecutor.java:447`：`workQueue`
- `ThreadPoolExecutor.java:538-547`：core/max 与位宽说明
- `ThreadPoolExecutor.java:596-611`：`Worker` 结构
- `ThreadPoolExecutor.java:620-628`：`Worker` 构造与 `runWorker`
- `ThreadPoolExecutor.java:659`：`interruptIfStarted`
- `ThreadPoolExecutor.java:678+`：`advanceRunState`
- `ThreadPoolExecutor.java:692+`：`tryTerminate`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇只建立线程池状态机与 Worker 结构心智，不展开 `execute` / `addWorker` / `runWorker` 全流程细节。
- 不把 `ctl` 位运算扩展成整数编码教程，重点放在“联合状态为什么必须原子一致”。
- Worker 的 AQS 互斥状态只解释到“空闲/忙碌控制与中断边界”，不提前抢 `runWorker` 细节。
- 参数选型只做结构性铺垫，详细决策放后续篇章。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“线程池为什么不是只看线程数 → ctl 如何把 runState 和 workerCount 绑成联合状态 → 五个状态怎样改变提交与清理策略 → Worker 为什么是线程池控制单元而非普通 Runnable → core/max/workQueue 为什么必须放进同一条行为决策链”。
- 必须把 `ctl` 讲成并发一致性设计，而不是位运算技巧。
- 必须把状态讲成策略切换，而不是标签表格。
- 必须把 Worker 的 AQS 身份讲清楚：服务于线程池控制，不是再造业务锁。
- 结尾要自然引到 `02-execute-worker.md`。
