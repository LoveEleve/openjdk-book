# 域 11: 线程与 ThreadLocal — 知识规划

> 源码路径: java.base/share/classes/java/lang/{Thread,ThreadLocal,InheritableThreadLocal,ThreadGroup}.java + java/util/concurrent/ThreadLocalRandom.java
> 源码量: 5 文件 / ~5,300 行 | 非巨型域
> 写作层: Layer 1(前置: 域 01/03/06;并发域的地基)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| Thread.java (2088 行) | **线程对象结构**: name(150,volatile)、tid(198,nextThreadID 递增)、threadSeqNumber(201)、threadStatus(210)、threadLocals(180)/inheritableThreadLocals(186) | High |
| Thread.java | **启动链路**: `start()` synchronized(780)→ `start0()` native(812)→ JVM 创建 OS 线程并回调 run(827) | High |
| Thread.java | **当前线程与调度**: currentThread native(258)、yield native(276)、sleep(319)、join(1374)→join(long)(1289,wait 模型)/join(long,int)(1340) | High |
| Thread.java | **中断机制**: interrupt(979,设置标志+唤醒可中断阻塞 wait/sleep/join)、interrupted(1015,静态,清标志)、isInterrupted | High |
| Thread.java | **线程局部继承**: 构造时从 parent 复制 inheritableThreadLocals(443-445)→ createInheritedMap | High |
| Thread.java | **线程异常出口**: setUncaughtExceptionHandler(1987)、默认处理器链(Thread→ThreadGroup→System) | Medium |
| ThreadLocal.java (741 行) | **哈希分配**: threadLocalHashCode(87)+ AtomicInteger nextHashCode(93)+ HASH_INCREMENT=0x61c88647(101,黄金分割增量) | High |
| ThreadLocal.java | **ThreadLocalMap**: Entry extends WeakReference(329,弱 key)+ 开放寻址 table(348)+ INITIAL_CAPACITY=16(342)+ setThreshold(363,2/3 扩容阈值) | High |
| ThreadLocal.java | **get/set 流程**: get(161)→getMap(253)→getEntry(433)快路径/getEntryAfterMiss(451);set(218)replaceStaleEntry(540);remove(239) | High |
| ThreadLocal.java | **脏条目清理**: expungeStaleEntry(460)、cleanSomeSlots、rehash/resize——弱 key 失效后的清理链 | High |
| InheritableThreadLocal.java (88) | **子线程继承**: childValue(66)、createMap(85)——覆写 createMap 进入 inheritableThreadLocals | Medium |
| ThreadGroup.java (1088) | **线程组与默认处理器**: uncaughtException(1048)逐级向上委托 | Low |
| ThreadLocalRandom.java (1097) | **线程局部随机数**: 每线程种子(Thread.threadLocalRandomSeed)+ mix64(133,splitmix64 变种)+ nextSeed(194);UNSAFE 按固定偏移读写字段(不受 GC 移动对象影响),无锁 | Medium |

*13 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | ThreadLocal 与 ThreadLocalMap | 3 (ThreadLocal/InheritableThreadLocal/Thread) | 面试重头(原理+泄漏);框架核心(Spring RequestContext/SqlSession) |
| P1 | 线程生命周期与中断 | 1 (Thread) | 面试高频(start vs run、sleep/yield/join、interrupt 语义);生产线程排查 |
| P2 | 线程异常处理 | 2 (Thread/ThreadGroup) | 面试偶尔;生产(线程池任务异常丢失) |
| P2 | ThreadLocalRandom | 1 | 面试低频;生产(无锁随机) |
| P3 | ThreadGroup 细节 | 1 | 已过时,面试低频 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | ThreadLocalMap 结构与 get/set 流程 | 面试必考(原理+为什么弱引用+为什么泄漏);框架处处依赖 |
| 🔴 Deep | 线程生命周期(启动/join/中断) | 面试高频(start0/run 关系、interrupt 三语义、sleep vs wait);并发域地基 |
| 🟡 Working | 线程异常出口 | 生产(线程池 execute 异常)、面试偶尔 |
| 🟡 Working | InheritableThreadLocal | 面试偶尔(链路追踪背景);生产(TraceId 传递) |
| 🟢 Surface | ThreadLocalRandom | 使用层;LCG 细节不展开 |

## 04 聚类

### 依赖图(域内)
```
Thread(生命周期) ←── ThreadLocal(getMap 挂载) ←── InheritableThreadLocal(继承)
ThreadLocalMap(弱 key 开放寻址) ←── ThreadLocal 全部操作
ThreadGroup(异常委托链) ←── Thread.uncaughtException
Thread(threadLocalRandomSeed 字段) ←── ThreadLocalRandom
```

### 教学顺序与文章拆分(3 篇)

1. **线程的生命周期与调度原语** — 创建/start/run、currentThread、sleep/yield/join、中断三语义、isAlive;衔接内部卷线程状态机
2. **ThreadLocal 原理与内存泄漏** — ThreadLocalMap 结构(弱引用/开放寻址/黄金分割哈希)、get/set/remove 流程、脏条目清理、泄漏分析、InheritableThreadLocal
3. **线程异常出口与 ThreadLocalRandom** — uncaughtException 链、默认处理器;线程局部随机数实现

> 前置: 域 03(Thread 也是对象)、06(异常出口)。跨层: start0/join/sleep 的 JVM 实现(内部卷 17-threads);线程状态 NEW/RUNNABLE/BLOCKED...(内部卷);uncaughtException 与域 14 线程池衔接
