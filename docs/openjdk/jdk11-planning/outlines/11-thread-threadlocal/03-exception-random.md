# 03. 线程异常出口与 ThreadLocalRandom — uncaughtException 链、无锁随机数

> 🟡 Working | 域 11 线程与 ThreadLocal 第 3 篇 | Layer 1
> 读者处境: 线程池 execute 的任务抛异常,日志里什么都没有——异常去哪了?ThreadLocalRandom 为什么比 new Random() 快?

### 1. "子线程的异常去哪了？" — uncaughtException 链

场景: 生产"线程池任务异常静默消失"——谁来处理线程内未捕获异常?

- 线程 run() 返回时若异常未捕获 → JVM 调用 `dispatchUncaughtException`(`Thread.java:1996`)→ `getUncaughtExceptionHandler().uncaughtException(this, e)`
- 处理器链(`Thread.java:1968`): 实例 `uncaughtExceptionHandler`(1897)→ 否则 `ThreadGroup.uncaughtException`(ThreadGroup.java:1048)
- `ThreadGroup.java:1048-1060`: 逐级 parent 向上 → `defaultUncaughtExceptionHandler`(1900,静态)→ 都没有 → **System.err 打印**("Exception in thread ...")
- 关键设计 (斜体): *默认行为只是打印到 stderr——线上 stderr 没人看 → 异常"消失"的真相;线程池的 execute 任务异常走这条链,而 submit 的异常被 Future 捕获(域 14)*
- 生产: 自定义 UncaughtExceptionHandler 统一记日志/上报;框架(Spring @Async)有各自包装
- 面试点: "主线程能 catch 子线程异常吗?"——不能,只能靠处理器链或 Future
- [内部卷: 17-threads(线程退出路径: 异常未捕获时的 dispatch 时机与 VM 侧处理)]

### 2. "ThreadLocalRandom 为什么快？" — 无锁种子 + 线程局部

场景: 生产高并发 UUID/限流随机——Random 有锁,替代方案是什么?

- `Random` 的问题: 内部 CAS 竞争一个 `seed`(`AtomicLong`)→ 高并发争抢
- `ThreadLocalRandom.current()`(`ThreadLocalRandom.java:176`)— 每线程独立种子,无竞争
- 种子存放: `Thread.threadLocalRandomSeed` 字段(`Thread.java:2071`),用 **UNSAFE 直接读写**(`U.putLong(t, SEED, seed)`)— 不经 volatile getter,线程内访问无需同步
- 种子递进: `nextSeed()` = seed + GAMMA(`ThreadLocalRandom.java:1030` GAMMA=0x9e3779b97f4a7c15,黄金比例常量);初始种子 `mix64(seeder.getAndAdd(SEEDER_INCREMENT))`(165)
- 关键设计 (斜体): *"线程局部"的两种实现——ThreadLocal(挂在 map,可清除)vs ThreadLocalRandom(挂在 Thread 字段,UNSAFE 直写);随机数只需线程内可见,无需跨线程语义,所以不走 ThreadLocalMap*
- 面试点: "为什么 nextInt 没有线程安全问题?"——每线程独立状态机 + UNSAFE 私有字段访问
- 注意: 种子在普通线程死亡后随对象废弃;线程池复用线程时种子延续——实践上不跨任务依赖随机序列(任务应只消费本任务内的随机值)
- [C++: UNSAFE 直读线程字段的偏移量机制(objectFieldOffset,域 32 Unsafe 展开)]

### 3. 线程域收尾 — 与后续并发域的衔接

场景: 读完本域,并发体系地图在哪?

- 线程原语(域 11)→ 原子操作与 volatile 语义(域 13,CAS 是 AQS 的地基)→ 锁与同步器(域 12)→ 线程池(域 14)
- ThreadLocal 的泄漏治理与 remove 规范 → 域 14 线程池复用场景重点展开
- 内部卷视角: Java 层的 Thread 对象 ↔ VM 层 JavaThread/OSThread(内部卷 17-threads)
- 关键设计 (斜体): *域 11 是并发域的"语言级地基"(synchronized/volatile/Thread 语义),域 12-15 是"工具级"(AQS/原子/线程池/CF)——面试链路从本域开始一路打通*

---

### 核心悬念

线程能并发了,但**共享变量怎么保证可见性**?`volatile` 只是语言级关键字,它背后的内存屏障、CAS 指令、缓存一致性协议——是下一站: 域 13 原子类与内存语义,再往上就是面试必考的 AQS(域 12)。

> → 下一篇: 域 13 原子类(13-atomic 系列) | 域 12 锁与同步器 | 域 14 线程池
