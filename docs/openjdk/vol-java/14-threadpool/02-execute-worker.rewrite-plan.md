# 14-threadpool/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ThreadPoolExecutor`。本文聚焦 `execute`、`addWorker`、`runWorker`、`getTask`、`processWorkerExit`、`beforeExecute/afterExecute` 等运行时主线；shutdown、拒绝策略和 FutureTask 放到后续篇章。
> 目标：把“execute 流程与 Worker 生命周期”改写成一篇围绕“线程池提交任务时为什么不是简单扔进队列，而是一条核心线程、队列、非核心线程、拒绝策略层层兜底的资源决策链”的机制文章。

## 1. 读者困惑

- `execute()` 到底先建线程还是先入队，为什么很多人记混？
- 为什么线程池要按 core → queue → max → reject 这条顺序决策，换顺序不行吗？
- `addWorker` 为什么既要 CAS 又要主锁，看起来为什么这么绕？
- worker 创建出来后，第一份任务和后续任务为什么要分开处理？
- `getTask()` 为什么有时 `take()` 常驻，有时 `poll()` 超时退出？
- 一个任务抛异常时，为什么线程池本身不死，但当前 worker 可能会退出重建？

## 2. 一句话顿悟

**`ThreadPoolExecutor.execute()` 真正做的不是“提交任务”，而是一次资源分配决策：先看核心执行能力够不够，不够就直接补核心 worker；再看队列能不能接住；再看是否还允许扩到非核心 worker；都不行才拒绝。Worker 一旦出生，又会沿着 `runWorker → getTask → processWorkerExit` 这条生命周期自己循环取活、执行、回收或异常退出。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 execute 的四步顺序、addWorker 的 CAS + 主锁分工、getTask 的 take/poll 差异、runWorker 主循环和异常退出逻辑。
- 已把 shutdown / reject 留到下一篇，篇章边界正确。
- 已提到 beforeExecute/afterExecute 钩子与异常对 worker 生命周期的影响。

### 必须重写

- 旧稿偏流程提纲，缺少一个统一主问题：为什么任务提交不是“入队或开线程”二选一，而是分层资源决策。
- execute 顺序要通过失败方案讲透：为什么不能先队列后核心、也不能一上来就猛加到 max。
- addWorker 应从“为什么计数和 workers 集合要分开保护”这个一致性问题切入。
- runWorker / getTask / processWorkerExit 要讲成一个工人生命周期，而不是三个孤立方法。
- 任务异常与 worker 退出要强调“线程池不死，工人可能换人”，这是常见误区。

## 4. 理解路径

### 第一节：从“为什么 execute 不能简单扔队列”开场

用突发流量场景开场：任务刚来时如果总是先入队，核心线程可能迟迟不被拉满；如果总是先加到 maximum，队列就失去缓冲意义。先立问题：线程池不是只存任务，而是在延迟、吞吐、线程创建成本与饱和保护之间做分层资源分配。

### 第二节：execute 为什么是 core → queue → max → reject

证据：
- `ThreadPoolExecutor.java:1318`：`execute`
- `ThreadPoolExecutor.java:1342-1355`：四段核心判断
- `ThreadPoolExecutor.java:393`：`workerCountOf`

主线：
- 核心线程代表常驻执行基线，所以优先补 core。
- core 满后，先看队列能否接住，这体现“缓冲优先于盲目扩线程”。
- 队列接不住，再看能否扩到非核心 worker。
- 都不行才 reject。
- 重点讲这条顺序是在平衡资源成本，而不是随便写的 if-else。

### 第三节：为什么队列成功入队后还要“二次检查”

证据：
- `ThreadPoolExecutor.java:1347-1352`：offer 成功后的 recheck 与 `addWorker(null, false)` 补位

主线：
- offer 成功并不代表提交链路就万事大吉，因为入队和状态变化之间可能并发发生 shutdown。
- 如果状态变了，需要回滚或拒绝；如果队列里有活但 workerCount 恰好为 0，还要补一个 worker 去消费。
- 这解释了为什么 execute 不是一次直线流程，而是状态机式双检查。

### 第四节：addWorker 为什么同时需要 CAS 和主锁

证据：
- `ThreadPoolExecutor.java:885-943`：`addWorker`
- `ThreadPoolExecutor.java:955`：`addWorkerFailed`
- `ThreadPoolExecutor.java:596-628`：`Worker` 构造

主线：
- workerCount 属于 ctl 联合状态，要用 CAS 和 runState 一起校验更新。
- workers 集合属于结构性共享集合，要用 mainLock 保护一致性。
- 线程真正 start 之前和之后都可能失败，所以需要 `addWorkerFailed` 回滚 workerCount 与集合状态。
- 说明“CAS 快路径 + 锁保护结构”是线程池常见分工，而不是实现偶然复杂。

### 第五节：Worker 的运行主线为什么是“首任务出生 + 后续循环取活”

证据：
- `ThreadPoolExecutor.java:620-628`：Worker 持有 `firstTask` 并 `runWorker(this)`
- `ThreadPoolExecutor.java:1107-1142`：`runWorker`
- `ThreadPoolExecutor.java:1026-1054`：`getTask`

主线：
- 新 worker 可能带着 `firstTask` 直接开工，避免首任务再进队列兜一圈。
- 后续任务则由 `getTask()` 决定是阻塞常驻还是超时退出。
- 这条线要讲成完整工人生命周期：出生、干首单、进主循环、空闲取活、可能超时退出。

### 第六节：getTask 为什么决定了“谁常驻、谁回收”

证据：
- `ThreadPoolExecutor.java:1026`：`getTask`
- `ThreadPoolExecutor.java:1039-1054`：`timed` 判定与 `poll/take`

主线：
- `allowCoreThreadTimeOut` 或 `wc > corePoolSize` 决定当前 worker 是否走超时模式。
- `take()` 代表常驻等待新任务；`poll(keepAliveTime)` 代表空闲太久就退出。
- 所以 keepAliveTime 真正生效的位置不在配置表，而在 getTask 的等待策略里。

### 第七节：任务异常为什么会结束当前 worker，却不让线程池整体崩溃

证据：
- `ThreadPoolExecutor.java:1126-1131`：`beforeExecute` / `afterExecute`
- `ThreadPoolExecutor.java:1142`：`processWorkerExit`
- `ThreadPoolExecutor.java:981-1005`：`processWorkerExit`

主线：
- `runWorker` 里任务异常不会被简单吞掉；afterExecute 能看到它，然后异常继续冒出，当前 worker 结束主循环。
- `processWorkerExit` 负责清理并视需要补 worker。
- 这就是“工人会死，但线程池会补人”的真正含义。

## 5. 失败方案清单

1. 任务一来就先入队，导致核心线程迟迟不被建立或利用。
2. 任务一来就先扩到 maximum，完全放弃队列缓冲作用。
3. offer 成功后不做状态二次检查，忽略入队与 shutdown 并发竞态。
4. 把 workerCount 更新和 workers 集合修改都交给同一种同步手段，导致一致性或性能问题。
5. 不区分首任务和后续任务，让新 worker 还得再去队列兜一圈取第一单。
6. 把 keepAliveTime 只理解成配置项，不理解它实际作用在 getTask 的等待策略里。
7. 以为任务异常会让整个线程池一起挂掉，或者相反地，误以为异常一定被线程池吞掉了。

## 6. 误解清单

1. execute 的流程只有“入队 or 开线程”两种选择。
2. corePoolSize 只是一个初始线程数，不影响运行时路由。
3. offer 成功就说明线程池一定会处理这个任务。
4. addWorker 的复杂度主要来自线程创建慢，而不是并发状态一致性。
5. getTask 返回 null 只是“当前没任务”，不代表 worker 生命周期结束。
6. beforeExecute/afterExecute 只是日志钩子，不影响异常出口。
7. 任务异常后看到线程池还活着，就说明 worker 没出问题。

## 7. 证据清单

- `ThreadPoolExecutor.java:393`：`workerCountOf`
- `ThreadPoolExecutor.java:596-628`：`Worker` 结构与构造
- `ThreadPoolExecutor.java:659`：`interruptIfStarted`
- `ThreadPoolExecutor.java:885-943`：`addWorker`
- `ThreadPoolExecutor.java:955`：`addWorkerFailed`
- `ThreadPoolExecutor.java:981-1005`：`processWorkerExit`
- `ThreadPoolExecutor.java:1026-1054`：`getTask`
- `ThreadPoolExecutor.java:1107-1142`：`runWorker`
- `ThreadPoolExecutor.java:1126-1131`：`beforeExecute` / `afterExecute`
- `ThreadPoolExecutor.java:1318`：`execute`
- `ThreadPoolExecutor.java:1342-1355`：execute 四步决策与二次检查

## 8. 版本与边界

- 基于 JDK 11。
- 本篇只讲任务提交与 worker 运行生命周期，不展开 shutdown、awaitTermination、拒绝策略与 FutureTask 包装。
- 不把 beforeExecute/afterExecute 讲成完整扩展框架，只在生命周期与异常出口层面使用。
- getTask 的超时退出逻辑只解释到 worker 回收语义，不提前展开 allowCoreThreadTimeOut 全部边角情况。
- 线程池队列类型的详细选型理由已在前文建立，这里只回钩其在 execute 中的角色。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 execute 是 core → queue → max → reject → offer 后为何还要二次检查 → addWorker 为什么要分 CAS 和主锁 → Worker 怎样从 firstTask 出生、在 runWorker 中循环取活 → getTask 如何决定常驻或回收 → 任务异常为何只结束当前 worker”。
- 必须把 execute 讲成资源决策链，而不是 if-else 列表。
- 必须把 Worker 生命周期讲成一条连续主线。
- 必须讲清 offer 成功后的竞态补救与 workerCount==0 补位逻辑。
- 结尾要自然引到 `03-shutdown-reject.md`。
