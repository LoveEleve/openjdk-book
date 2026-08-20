# 11-thread-threadlocal/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Thread`、`ThreadGroup`、`ThreadLocalRandom`。本文聚焦未捕获异常处理链、`dispatchUncaughtException`、实例/默认处理器、线程组兜底，以及 `ThreadLocalRandom` 的每线程种子初始化与直写线程字段；不展开完整线程池异常包装与 ForkJoin 随机探针算法细节。
> 目标：把“线程异常出口与 ThreadLocalRandom”改写成一篇围绕“线程私有状态有两种完全不同的命运：异常要找最后兜底人，随机数种子则要尽量消掉共享竞争”的收官文章，并把异常处理链和线程私有随机数讲成同一域的两个边界问题。

## 1. 读者困惑

- 子线程抛了未捕获异常，为什么主线程经常看不见，日志里有时也没有？
- `execute()` 和 `submit()` 都在线程池里跑任务，为什么异常表现不同？
- `UncaughtExceptionHandler` 到底怎么选，实例处理器、线程组、默认处理器谁先谁后？
- 为什么说未捕获异常的最后出口常常只是 stderr，而不是日志框架？
- `ThreadLocalRandom.current()` 为什么比共享 `Random` 更适合并发场景？
- 它既然叫 ThreadLocalRandom，为什么又不走 `ThreadLocalMap` 那套弱引用 + remove 机制？
- `threadLocalRandomSeed`、`probe` 这些字段为什么直接挂在线程对象上？

## 2. 一句话顿悟

**线程私有状态有两种完全不同的命运：当线程里的异常没人接住时，JDK 会沿着“实例处理器 → 线程组 → 默认处理器 → stderr”这条兜底链给它找最后收容所；而当线程只需要一份高频随机种子时，JDK 则干脆把种子和探针直接塞进 `Thread` 对象字段里，绕开 `ThreadLocalMap`，用每线程独立状态消掉共享 `Random` 的竞争。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `dispatchUncaughtException`、实例/线程组/默认处理器链，以及 `ThreadLocalRandom.current()` / `localInit()` / `nextSeed()` 主线。
- 已指出 `execute` 和 `submit` 的异常感知差异，以及 `ThreadLocalRandom` 不依赖 `ThreadLocalMap`。
- 已抓住“异常最后默认落到 stderr”与“共享 Random 的 CAS 热点”两个核心现象。

### 必须重写

- 旧稿像两道分开的知识题，需要先建立统一主问题：线程私有状态在“失败兜底”和“无锁高频状态”上会走两条完全不同的设计路线。
- 异常处理链要从“为什么你看不见子线程异常”这个生产困惑切入，而不是先列处理器层级。
- `ThreadLocalRandom` 要先对照共享 `Random` 的竞争失败方案，再解释为什么直接挂在线程字段上。
- 本文是域 11 收官，收束段要把线程生命周期、ThreadLocal、异常出口和线程私有随机数连成一条线，不只是贴一个路线图。

## 4. 理解路径

### 第一节：从“子线程异常为什么像消失了一样”开场

用线程池 `execute` 任务抛异常、主线程 try/catch 接不住、日志框架不一定记录的场景开场。先让读者承认：异常不是没发生，而是沿着线程自己的退出链路收尾了。

### 第二节：未捕获异常的真正出口为什么在线程自己身上

证据：
- `Thread.java:1884`：`UncaughtExceptionHandler`
- `Thread.java:1897`：实例处理器字段
- `Thread.java:1900`：默认处理器字段
- `Thread.java:1935`：`setDefaultUncaughtExceptionHandler`
- `Thread.java:1954-1955`：`getDefaultUncaughtExceptionHandler`
- `Thread.java:1967`：`getUncaughtExceptionHandler`
- `Thread.java:1987`：`setUncaughtExceptionHandler`
- `Thread.java:1996-1997`：`dispatchUncaughtException`
- `ThreadGroup.java:1048-1055`：线程组兜底链

主线：
- 异常如果没在子线程栈内被捕获，不会 magically 回到主线程。
- JVM 在线程退出路径上调用 `dispatchUncaughtException`，把异常交给当前线程的 handler。
- handler 选择顺序要讲成一条责任链，而不是零散 API。

### 第三节：为什么默认终点常常只是 stderr

证据：
- `ThreadGroup.java:1048-1062`：parent 递归、默认 handler、stderr 打印

主线：
- 如果线程没设置实例处理器，就退回线程组；线程组没有最终处理策略时，再看全局默认 handler；再没有，最后只剩 stderr。
- 这解释了为什么“异常没进日志”不是它没抛，而是默认出口没人接 stderr。
- 顺带把 `execute` 与 `submit` 的异常差异点成：前者更容易走未捕获处理链，后者通常包装进 Future。

### 第四节：共享 Random 为什么会在并发下变成热点

主线：
- 随机数看似只是工具函数，但高并发场景下会被大量线程频繁调用。
- 如果所有线程共享一个状态源，就会在那个状态更新点形成竞争。
- 先把失败方案立住：共享 `Random` 不是不正确，而是会让所有线程在同一 seed 更新点上互撞。

### 第五节：ThreadLocalRandom 为什么绕开 ThreadLocalMap，而直接挂在线程字段上

证据：
- `Thread.java:2071`：`threadLocalRandomSeed`
- `Thread.java:2075`：`threadLocalRandomProbe`
- `Thread.java:2079`：`threadLocalRandomSecondarySeed`
- `ThreadLocalRandom.java:162-168`：`localInit`
- `ThreadLocalRandom.java:176-178`：`current()`
- `ThreadLocalRandom.java:194-197`：`nextSeed`
- `ThreadLocalRandom.java:1030`：`GAMMA`
- `ThreadLocalRandom.java:1040`：`SEEDER_INCREMENT`
- `ThreadLocalRandom.java:1074`：`probeGenerator`

主线：
- 这类状态只服务线程自己，而且访问频率极高；如果还走 `ThreadLocalMap` 查表，会平白多一层间接成本和清理负担。
- JDK 直接把种子、探针和 secondary seed 塞进 `Thread` 字段，用偏移直读直写。
- 这说明“线程私有状态”并不总要实现成 ThreadLocalMap；固定用途的高频字段可以走更极端的直挂模式。

### 第六节：`current()`、`localInit()`、`nextSeed()` 如何形成零共享热点主线

证据：
- `ThreadLocalRandom.java:176-178`：`current()`
- `ThreadLocalRandom.java:162-168`：`localInit`
- `ThreadLocalRandom.java:194-197`：`nextSeed`

主线：
- 第一次调用 `current()` 时检查 probe 是否初始化，未初始化就走 `localInit()`。
- 初始化阶段才触碰共享 seeder / probeGenerator；初始化后每次取随机数主要只更新当前线程自己的 seed。
- 这就是它相比共享 Random 的真正优势：共享竞争被压缩到初始化那一刻，高频路径只动线程私有状态。

### 第七节：域 11 收官——线程私有状态的两条路线

主线：
- Thread 对象是生命周期入口（01 篇）。
- ThreadLocal 把任意业务值挂在线程 map 上，带来泄漏和继承边界（02 篇）。
- 未捕获异常和 ThreadLocalRandom 则展示线程私有状态的两个极端：一个要兜底收尾，一个要极致去共享。
- 为后续域 13 / 14 铺路：原子类和线程池都建立在这些线程级基础设施之上。

## 5. 失败方案清单

1. 以为主线程 try/catch 能接住子线程抛出的异常。
2. 在线程池 `execute` 场景下不配置默认未捕获异常处理器，却期待日志框架自动接住一切。
3. 把 `submit` 与 `execute` 的异常语义当成完全相同。
4. 多线程高频共享同一个 `Random` 实例，忽略种子竞争热点。
5. 以为所有线程私有状态都必须通过 `ThreadLocalMap` 存取。
6. 把 `ThreadLocalRandom` 当成“带了 ThreadLocal 名字的普通工具类”，忽略它直接依附线程字段。
7. 以为 `transfer`/线程池/ForkJoin 的所有随机或探针状态都能用一个全局原子字段解决。

## 6. 误解清单

1. 子线程异常没被主线程 catch 到，说明异常丢了。
2. 设置了实例级 `UncaughtExceptionHandler` 后，线程组和默认处理器仍会照常串行执行。
3. stderr 打印天然等于业务日志已落盘。
4. `ThreadLocalRandom` 只是 `Random` 的语法糖包装。
5. `ThreadLocalRandom` 既然叫 ThreadLocalRandom，就一定内部用了 `ThreadLocal`。
6. 线程私有随机数没有共享争用，说明初始化阶段也完全无共享写入。
7. 域 11 只是在讲 API，不涉及后续线程池和原子类的基础设施。

## 7. 证据清单

- `Thread.java:1884`：`UncaughtExceptionHandler`
- `Thread.java:1897`：实例处理器字段
- `Thread.java:1900`：默认处理器字段
- `Thread.java:1935`：`setDefaultUncaughtExceptionHandler`
- `Thread.java:1954-1955`：`getDefaultUncaughtExceptionHandler`
- `Thread.java:1967`：`getUncaughtExceptionHandler`
- `Thread.java:1987`：`setUncaughtExceptionHandler`
- `Thread.java:1996-1997`：`dispatchUncaughtException`
- `ThreadGroup.java:1048-1055`：异常责任链核心
- `Thread.java:2071`：`threadLocalRandomSeed`
- `Thread.java:2075`：`threadLocalRandomProbe`
- `Thread.java:2079`：`threadLocalRandomSecondarySeed`
- `ThreadLocalRandom.java:162-168`：`localInit`
- `ThreadLocalRandom.java:176-178`：`current()`
- `ThreadLocalRandom.java:194-197`：`nextSeed`
- `ThreadLocalRandom.java:1030`：`GAMMA`
- `ThreadLocalRandom.java:1040`：`SEEDER_INCREMENT`
- `ThreadLocalRandom.java:1074`：`probeGenerator`

## 8. 版本与边界

- 基于 JDK 11。
- 本文不展开 `FutureTask` 和线程池 `submit`/`execute` 的完整实现链，只在异常可见性层面点出差异。
- `ThreadLocalRandom` 重点解释的是线程私有状态与共享竞争规避，不展开所有随机分布 API。
- stderr 兜底属于 JDK 默认行为，不等于生产系统一定能采集到。
- 本文把域 11 收束到线程私有状态与线程退出协议层面，不替代后续域 13 原子类与域 14 线程池完整展开。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么子线程异常不会回到主线程 → 未捕获异常责任链怎样兜底 → 为什么默认终点常常只是 stderr → 共享 Random 为什么在并发下形成热点 → ThreadLocalRandom 为什么直接挂在线程字段上 → 域 11 三篇如何收成同一张线程私有状态地图”。
- 必须把异常处理链讲成生产困惑的答案，而不是 API 名录。
- 必须把 ThreadLocalRandom 对照共享 Random 的失败方案讲清。
- 必须说明它为什么不走 ThreadLocalMap，而是走线程字段直挂。
- 结尾要自然引到域 13 / 域 14。
