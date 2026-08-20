# 02. ThreadLocal 原理与内存泄漏 — ThreadLocalMap 全解剖

> 🔴 Deep | 域 11 线程与 ThreadLocal 第 2 篇 | Layer 1
> 读者处境: 面试"ThreadLocal 原理 + 为什么泄漏"是并发必考题——从 0x61c88647 到弱引用 Entry,再到 set 时的清理链,一次讲透。

### 1. "ThreadLocal 存在哪？" — 每线程一个 Map

场景: 面试第一问——ThreadLocal 的值是存在 ThreadLocal 对象里吗?

- **不是**: 值存在**当前线程**的 `Thread.threadLocals` 字段(`Thread.java:180`)里——一个 ThreadLocalMap,key 是 ThreadLocal 对象
- `ThreadLocal.java:161` `get()` → `getMap(t)`(`ThreadLocal.java:253`)→ 每个线程第一次 get/set 时懒创建 map
- 结构: Thread → threadLocals(ThreadLocalMap)→ Entry[] table(key=ThreadLocal,value=你的值)
- 关键设计 (斜体): *为什么放线程而非 ThreadLocal 里?一个 ThreadLocal 要被成百上千线程共享,但值必须隔离——"每线程一份"天然免锁;代价是线程销毁前 map 一直存在(泄漏源头)*
- 面试点: "一个线程能存多少个 ThreadLocal?"——不受限,但 map 会扩容

### 2. "为什么 Entry 用弱引用？" — 弱 key 与泄漏根因

场景: 面试核心——ThreadLocal 为什么要用 WeakReference?泄漏到底怎么发生?

- `ThreadLocal.java:329` — `static class Entry extends WeakReference<ThreadLocal<?>>` — **key 是弱引用**
- 黄金分割哈希: `ThreadLocal.java:101` `HASH_INCREMENT = 0x61c88647` — 斐波那契哈希,`ThreadLocal.java:87` threadLocalHashCode 递增分配,分布均匀
- 开放寻址: `ThreadLocal.java:348` `Entry[] table` — 线性探测(不是链地址),`INITIAL_CAPACITY = 16`(342)
- 泄漏机制: ① key(ThreadLocal)被弱引用——外部强引用置 null 后,key 可被 GC 回收 ② 但 **value 是强引用**(Entry 持有 value)→ key 变 null、value 永不被清 → **Entry 泄漏**
- 关键设计 (斜体): *弱引用让"ThreadLocal 对象本身"可回收,但 value 与 Entry 仍挂在 Thread 上——这就是"ThreadLocal 内存泄漏"的准确描述: 泄漏的不是 key 是 value;线程池复用线程 → 泄漏的 value 一直活着*
- 面试必答: "为什么用弱引用?"——若强引用,ThreadLocal 对象永不回收(key 永不为 null);弱引用至少让 key 失效,配合清理链回收

### 3. "泄漏怎么被清理？" — get/set 的清理链

场景: 生产排查泄漏——JDK 自己做了哪些努力?

- `ThreadLocal.java:433` `getEntry` 快路径 → `getEntryAfterMiss`(451): 命中 null key 立即 `expungeStaleEntry`(460,清除该槽并 rehash 后续)
- `set`(`ThreadLocal.java:218`): 探测时遇脏槽走 `replaceStaleEntry`(540)原地替换;`cleanSomeSlots`(669)启发式清扫
- 扩容: `rehash`(690)→`resize`(701),阈值 2/3(`setThreshold`,363-364)
- 关键设计 (斜体): *清理是"被动触发"的——只有后续 get/set 走到脏槽附近才清理;长期空闲的 map 里的脏 Entry 不会被清(这就是"用完后必须 remove"的原因);`remove()`(`ThreadLocal.java:239`)主动删除才是根治*
- 生产规范: 线程池任务里用 ThreadLocal 必须在 finally 里 remove(常见坑: 线程复用导致"串值"——下一个任务读到上一个任务的值)
- 面试: "为什么线程池下必须 remove?"——复用线程不销毁,map 永不清理 + 值串用

### 4. "子线程能继承吗？" — InheritableThreadLocal 与创建链路

场景: 链路追踪(TraceId)怎么传给子线程?——继承机制 + 局限

- `Thread.java:443-445` — 新线程构造时: `parent.inheritableThreadLocals != null` → `ThreadLocal.createInheritedMap` 复制
- `InheritableThreadLocal.java:66` `childValue` — 覆写可定义"继承时值如何变换"(如 TraceId 加前缀)
- `InheritableThreadLocal.java:85` `createMap` — 覆写后子线程放入 inheritableThreadLocals
- 局限: 只继承**创建那一刻**的快照;线程池复用不重建 → TraceId 用 InheritableThreadLocal 在池化场景失效 → 用 TransmittableThreadLocal(阿里 TTL,面试常问)
- 关键设计 (斜体): *继承是"复制值"不是"共享引用传递"——创建后父线程改值不影响子线程;这决定了它不适合异步链路,商业方案 TTL 用增强包装解决*
- [内部卷: 17-threads(线程创建与 threadLocals 挂载顺序)]

---

### 核心悬念

线程里的代码抛了异常——**异常去哪了**?主线程根本看不到子线程的异常;线程池 execute 的任务异常直接消失。uncaughtException 链和 ThreadLocalRandom——线程私有的最后一个秘密。

> → [03-exception-random.md](03-exception-random.md)
