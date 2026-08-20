# 02. execute 流程与 Worker 生命周期 — 四步执行、任务取送

> 🔴 Deep | 域 14 线程池与任务第 2 篇 | Layer 5
> 读者处境: 面试"execute 流程"手写题——四步判断、队列与线程的博弈。

### 1. "execute 的四步" — 任务路由

场景: `pool.execute(task)` — 线程池怎么决定"加线程还是入队"?

- `ThreadPoolExecutor.java:1318` `execute`:
  1. `workerCountOf(c) < corePoolSize` → `addWorker(command, true)`(1342-1343)——**先加核心线程**
  2. `isRunning && workQueue.offer(command)`(1346)——**入队**(成功则双检查)
  3. `addWorker(command, false)`(1354)——**加非核心线程**(队列满)
  4. `reject(command)`(1356)——**拒绝**(达到最大且队列满)
- 关键设计 (斜体): *"先核心→再队列→再非核心→拒绝"是线程池的资源阶梯——核心线程优先于队列(减少排队);面试手写 execute 流程是必考题*
- 面试: "为什么先加线程不入队?"——核心线程"该建就建",避免任务堆积

### 2. "addWorker" — 线程的诞生

场景: 加线程时——怎么保证"状态合法+计数正确"?

- `ThreadPoolExecutor.java:885` `addWorker(firstTask, core)`:
  - **retry 双重检查**: CAS 更新 workerCount(校验状态: SHUTDOWN 不收新任务等)
  - `mainLock.lock()`(916 附近)→ `workers.add(w)`(HashSet,468)→ `t.start()`(线程启动)
- 失败回滚: CAS 失败回退计数
- 关键设计 (斜体): *"CAS+锁的组合"——计数用 CAS(快路径),workers 集合用锁(结构性变更);面试"addWorker 为什么复杂"——并发下"状态/计数/集合"三一致*
- 面试: "addWorker(null, false)"是什么——**补位线程**(execute 第 3 步: 队列非空但无线程时)
- [关联: 域 13 CAS;域 11 线程创建]

### 3. "getTask" — 任务的取与等

场景: 空闲 worker 在干嘛?——阻塞取还是超时取?

- `ThreadPoolExecutor.java:1026` `getTask`:
  - `timed = allowCoreThreadTimeOut || wc > corePoolSize`(1042)——**是否限时**
  - timed: `workQueue.poll(keepAliveTime, NANOSECONDS)`(1053)——**超时返 null → 线程退出**
  - 非 timed: `workQueue.take()`(1054)——**无限阻塞**
- 关键设计 (斜体): *"核心线程 take 常驻,超核心线程 poll 超时回收"——keepAliveTime 只对超核心生效(或 allowCoreThreadTimeOut);面试"线程什么时候回收"——getTask 超时返回 null*
- 面试: "core 线程会死吗"——默认不(allowCoreThreadTimeOut=false 时 take 常驻)

### 4. "runWorker" — 任务的执行循环

场景: worker 线程的 run 方法——主循环是什么?

- `ThreadPoolExecutor.java:1107` `runWorker`:
  ```java
  while (task != null || (task = getTask()) != null) {
      beforeExecute(wt, task);
      task.run();
      afterExecute(task, null);   // 异常时传 ex
  }
  processWorkerExit(w, completedAbruptly);
  ```
- `completedTasks` 累计(611 字段)
- 异常语义: task.run 异常被 afterExecute 捕获——**线程不死**(循环继续)
- 关键设计 (斜体): *"worker 主循环 = 取任务+执行+钩子"——异常不杀线程(除非异常退出 processWorkerExit 补线程);面试"任务异常线程会死吗"——默认不会(捕获后继续)*
- 面试: "before/afterExecute 干什么"——钩子(统计/上下文,域 11 ThreadLocal 关联)

---

### 核心悬念

线程池要关了——**优雅关闭**怎么保证"队列任务跑完"?shutdown 与 shutdownNow 的差别、awaitTermination 的等待、拒绝策略的四个选择——下一篇: 关闭与拒绝策略。

> → [03-shutdown-reject.md](03-shutdown-reject.md)
