# 04. ForkJoinTask 与分治 — 任务状态机、fork/join、CountedCompleter

> 🔴 Deep | 域 15 异步编程第 4 篇(规划终点·最终篇)| Layer 6
> 读者处境: 面试"ForkJoin 怎么写"——任务状态、分治模式与计数完成(25 域规划的收官)。

### 1. "ForkJoinTask 的状态" — status 位标记

场景: 任务的生命周期——怎么表示?

- `ForkJoinTask.java:206` — abstract 类(Future 实现)
- 状态位(239-243): `DONE`(1<<31)/`ABNORMAL`(1<<18,取消或异常)/`THROWN`(1<<17,异常)/`SIGNAL`(1<<16,等待者标记)/SMASK(标签位)
- 设置: `abnormalCompletion`(267,CAS 状态)
- 关键设计 (斜体): *"状态 = int 位标记"——DONE 高位+ABNORMAL/THROWN 细分;join 检查 DONE|ABNORMAL;面试"ForkJoinTask 状态"——完成/异常/取消三位*
- 面试: "异常怎么传播"——THROWN 标记 + join 时重抛(CompletionException)
- [关联: 域 14 FutureTask 状态机对照]

### 2. "fork/join 的语义" — 分治骨架

场景: 递归分治怎么写?

- `ForkJoinTask.java:699` `fork()`: 当前池 `externalPush`(704,入队)——**异步提交**(不阻塞)
- `ForkJoinTask.java:719` `join()`: `doJoin()`(定义于 391)→ **阻塞等结果**(内部 externalAwaitDone 322)
- 经典示例(RecursiveTask.java:18-24 注释):
  ```java
  f1.fork();                       // 子任务异步
  return f2.compute() + f1.join(); // 当前线程算一半 + 等另一半
  ```
- 关键设计 (斜体): *"fork = 分,join = 合"——当前线程不空等: 先算本地部分再 join 子任务(窃取池里 join 会帮助偷别的任务);面试"fork/join 为什么高效"——子任务可被其他线程窃取*
- 面试: "join 会死锁吗"——doJoin 的等待配合窃取(内部调度)
- [关联: 域 11 线程等待]

### 3. "RecursiveTask/RecursiveAction" — 分治写法

场景: 大数组求和——标准分治

- `RecursiveTask.java:80` `compute()` 抽象 + `exec`(93)——**有返回值**
- `RecursiveAction`(193)— 无返回值(数组填充/遍历)
- 分治模式: 阈值判断 → 小任务直接算 / 大任务拆分(fork 子任务)
- 关键设计 (斜体): *"分治 = 阈值 + 拆分 + 合并"——阈值太小则任务过多(开销大),太大则并行不足;面试"ForkJoin 示例"——数组求和/斐波那契(JDK 注释示例)*
- 生产: 大数组计算/树遍历;注意任务粒度(压测定阈值)
- [关联: 域 16 并行流(内部就是 FJP 分治)]

### 4. "CountedCompleter 与收官" — 计数完成 + 全景

场景: 依赖 DAG/复杂并行——CountedCompleter

- `CountedCompleter.java` — **待完成计数**(pending): 子任务完成减一,**计数归零触发 onCompletion**/propagateCompletion
- `tryComplete`(588): 计数减一 → 归零则传播完成
- 适用: 需要"所有子任务完成后聚合"的 DAG(比 RecursiveTask 灵活)
- 收官: 25 域规划终点——异步全景图(域 13 原子→14 线程池→15 ForkJoin)
- 关键设计 (斜体): *"CountedCompleter = 显式完成计数"——适合依赖图(非树);面试"RecursiveTask vs CountedCompleter"——树 vs DAG*
- 本域收官: 并发体系全链(原子→锁→集合→线程池→ForkJoin/异步)打通
- [关联: 域 12/13/14(前置全链)]

---

### 核心悬念

**25 域规划全部完成**——从字符串(域 01)到异步编程(域 15),Java 层源码分析的完整地图已经展开。后续是"文章写作阶段": 按每篇大纲展开为 300-500 行文章,保持方法论 v5 标准(场景/源码锚/关键设计/跨层/悬念)。

> → 下一步: 按 00-domain-writing-order.md 的 6 层顺序,从 Layer 0(01 字符串/06 异常)开始逐篇写作
