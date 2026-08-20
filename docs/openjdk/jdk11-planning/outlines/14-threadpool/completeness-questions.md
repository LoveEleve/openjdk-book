# 域 14: 线程池与任务 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "线程池原理/ctl 一字段两用" — 01 篇 §1(ThreadPoolExecutor.java:380/392-394)
- [x] "生命周期 7 态/shutdown vs Now" — 01 篇 §2/03 篇 §1(385-387, 1369/1400)
- [x] "Worker 为什么 AQS" — 01 篇 §3(607-620)
- [x] "execute 四步" — 02 篇 §1(1318-1356)
- [x] "addWorker 双重检查" — 02 篇 §2(885)
- [x] "线程什么时候回收(getTask)" — 02 篇 §3(1026-1074)
- [x] "任务异常线程会死吗" — 02 篇 §4(runWorker 1107)
- [x] "优雅停机三连" — 03 篇 §2(awaitTermination)
- [x] "拒绝策略四选一" — 03 篇 §3(554/2012-2095)
- [x] "FutureTask 状态机/cancel 语义" — 04 篇 §1-2(FutureTask.java:92-99/164/187)
- [x] "固定频率 vs 固定延迟" — 04 篇 §3(616)
- [x] "submit vs execute 异常" — 04 篇 §4
- [x] "Executors 为什么禁" — 05 篇 §2(91/217)
- [x] "线程池参数怎么配" — 05 篇 §3

## 身份 2: 生产工程师
- [x] 优雅停机(钩子集成)— 03 篇 §2/4
- [x] 线程池监控(域 34 关联)— 05 篇 §3
- [x] 自定义线程池规范 — 05 篇 §2
- [x] 定时任务(STPE)— 04 篇 §3

## 身份 3: 框架工程师
- [x] Spring @Async 底层(域外但同源)— 各篇
- [x] 任务调度器实现 — 04 篇

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 ThreadPoolExecutor.java:380/385-387/392-394/447/462/468/473/516/524/541/549/554/607-620/627/885/896-930/1026-1080/1107-1140/1318-1356/1369/1400/2012-2095, ScheduledThreadPoolExecutor.java:200/456/616, FutureTask.java:92-99/102/104/164-186/187-220/246/254-269/295, Executors.java:91-100/174/217-230, AbstractExecutorService, ExecutorCompletionService)/关键设计/跨层([关联])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 5 篇拆分为面试密度驱动(非巨型域)

## 身份 5: 完整性缺口检查
- [x] ctl/Worker(01)/execute(02)/关闭拒绝(03)/FutureTask 调度(04)/选型(05)五篇覆盖域全部面试主战场
- [x] CompletionService 并入 05 篇提及(完成优先取)
- [x] 未覆盖确认: ExecutorCompletionService 细节(面试低频)、ThreadFactory 实现细节——写作时按需
- [x] 二次 review 修正: Worker 类声明多行(596-598 extends AQS implements Runnable)+字段(607/609/611);getTask timed 精确(1042)/poll(1053)/take(1054);shutdown 内部(advanceRunState 1374+interruptIdleWorkers 1375,定义 783);COUNT_BITS=29(Integer.SIZE-3,381)
- [ ] 待办: 写作时验证 ctl 的 COUNT_BITS=29 精确布局、awaitDone 的自旋+park 实现、DelayedWorkQueue 的 leader-follower 机制
