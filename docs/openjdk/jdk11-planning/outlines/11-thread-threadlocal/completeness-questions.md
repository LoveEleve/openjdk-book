# 域 11: 线程与 ThreadLocal — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "start vs run" — 01 篇 §1(Thread.java:780/812/827)
- [x] "sleep vs wait / join 原理" — 01 篇 §2(Thread.java:319/1289-1309/1374)
- [x] "interrupt 语义(三方法)" — 01 篇 §3(Thread.java:979/1015)
- [x] "ThreadLocal 原理 + 为什么弱引用 + 为什么泄漏" — 02 篇 §2-3(ThreadLocal.java:329/348/101)
- [x] "线程池下为什么必须 remove" — 02 篇 §3
- [x] "InheritableThreadLocal / TTL" — 02 篇 §4(Thread.java:443-445)
- [x] "主线程能 catch 子线程异常吗" — 03 篇 §1(Thread.java:1996, ThreadGroup.java:1048)
- [x] "ThreadLocalRandom 为什么快" — 03 篇 §2(Thread.java:2071, UNSAFE 直写)

## 身份 2: 生产工程师
- [x] 线程池任务异常静默丢失 — 03 篇 §1
- [x] ThreadLocal 泄漏排查与 remove 规范 — 02 篇 §3
- [x] 线程状态 jstack 对照 — 01 篇 §4
- [x] TraceId 传递(继承+TTL 局限)— 02 篇 §4

## 身份 3: 框架工程师
- [x] Spring RequestContext/SqlSession 的 ThreadLocal 机制 — 02 篇
- [x] 异步框架异常处理链 — 03 篇 §1
- [x] 高并发随机数(限流/雪花算法)— 03 篇 §2

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Thread.java:150/180/186/210/258/276/319/443-445/780/812/827/979/1015/1289-1309/1374/1897/1900/1968/1996/2071, ThreadLocal.java:87/93/101/161/194/218/239/253/329/342/348/363-364/433/451/460/540/669/690/701, InheritableThreadLocal.java:66/85, ThreadGroup.java:1048-1060, ThreadLocalRandom.java:162/165/176/1030/1040/1057)/关键设计/跨层([内部卷]/[man])/核心悬念+OUTBOUND
- [x] 无文字描述源锚(自查 grep 通过)
- [x] join(long) 已实测为 wait 循环模型(1289-1309),非自旋

## 身份 5: 完整性缺口检查
- [x] 生命周期(01)/ThreadLocal(02)/异常与随机(03)三篇覆盖域全部面试主战场
- [x] ThreadGroup 已并入 03 篇 §1(异常链部分),未单独成篇——🟢 Surface 决策
- [x] InheritableThreadLocal 已并入 02 篇 §4
- [x] ThreadLocalRandom 的 LCG 细节不展开(🟢),只讲"线程局部+无锁"核心
- [x] Thread 的优先级/daemon/ThreadLocal 初始种子等细节——daemon 在 01 篇提及,优先级面试低频未展开
- [ ] 待办: 02 篇 §1 的"懒创建 map"行号(getMap 253 已锚,首次创建位置在 set/get 内部分支,写作时定位精确行)
