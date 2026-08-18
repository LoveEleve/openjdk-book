# 02. ThreadLocal 原理与内存泄漏 — ThreadLocalMap 全解剖

> **前置依赖**: [11-thread-threadlocal/01 — 线程的生命周期](01-thread-lifecycle.md)(threadLocals 字段挂在 Thread 上)、[03-object-system/01 — 四种引用](../03-object-system/01-object-contract-references.md)(弱引用语义)
> → **后续**:[11-thread-threadlocal/03 — 未捕获异常与 ThreadLocalRandom](03-exception-random.md)
> 关联: 内部卷 17-threads(线程创建与 threadLocals 挂载顺序)

## 并发必考题的两面:原理与泄漏

"ThreadLocal 原理 + 为什么内存泄漏"是并发面试的必考题——但大多数答案是背的: "每线程一份""弱引用""线程池要 remove"。被追问"值到底存在哪""0x61c88647 是什么""JDK 自己怎么清理泄漏"时,就卡住了。

这篇把 ThreadLocalMap 完整解剖: 存储位置、弱引用 Entry 与黄金分割哈希、开放寻址与清理链、扩容阈值,最后是 InheritableThreadLocal 的继承机制与局限。

## 1. "ThreadLocal 存在哪" — 每线程一个 Map

### 1.1 值在 Thread 里,不在 ThreadLocal 里

`Thread` 有两个字段(`Thread.java:180`/`186`):

```java
// Thread.java:180 + 186(截取核心,逐字)
ThreadLocal.ThreadLocalMap threadLocals = null;

ThreadLocal.ThreadLocalMap inheritableThreadLocals = null;
```

**ThreadLocal 的值存在当前线程的 threadLocals 里**——结构是:

```
Thread 对象 ──threadLocals──> ThreadLocalMap ──table──> Entry[](开放寻址数组)
                                                         每个 Entry: key = ThreadLocal 对象(弱引用)
                                                                      value = 你的值(强引用)
```

### 1.2 get/set:懒创建 map

`ThreadLocal.get()`(`ThreadLocal.java:161-170`):

```java
// ThreadLocal.java:161-170(截取核心,逐字)
public T get() {
    Thread t = Thread.currentThread();
    ThreadLocalMap map = getMap(t);
    if (map != null) {
        ThreadLocalMap.Entry e = map.getEntry(this);
        if (e != null) {
            @SuppressWarnings("unchecked")
            T result = (T)e.value;
            return result;
        }
    }
    ...
```

`getMap(t)`(`ThreadLocal.java:253`)返回 `t.threadLocals`——**第一次 get/set 时 map 还是 null**,走懒创建分支: `get()` 的 map==null 分支进 `setInitialValue`(`ThreadLocal.java:194`,内部同样 createMap),`set()` 的 else 分支直接 `createMap(t, value)`(`ThreadLocal.java:218-227`)——两条路径殊途同归。所以"一个线程第一次用 ThreadLocal 之前,不占任何 map 内存"。

关键设计(斜体):*为什么放线程而不是 ThreadLocal 里?一个 ThreadLocal 对象会被成百上千个线程共享,但每个线程的值必须隔离——"每线程一份"天然免锁(不用 ConcurrentHashMap 或锁)。代价: map 的生命周期绑定线程——线程不销毁,map 不释放,这就是泄漏的源头(第 2 节)。*

## 2. "为什么 Entry 用弱引用" — 弱 key 与泄漏根因

### 2.1 Entry:弱 key,强 value

`ThreadLocalMap.Entry`(`ThreadLocal.java:329-333`):

```java
// ThreadLocal.java:329-333(截取核心,逐字)
static class Entry extends WeakReference<ThreadLocal<?>> {
    /** The value associated with this ThreadLocal. */
    Object value;

    Entry(ThreadLocal<?> k, Object v) {
```

**key(ThreadLocal)是弱引用,value 是普通强引用**——这是整个泄漏故事的核心。

### 2.2 黄金分割哈希:0x61c88647

`ThreadLocal.java:87-107`:

```java
// ThreadLocal.java:87 + 101 + 107(截取核心,逐字)
private final int threadLocalHashCode = nextHashCode();

private static final int HASH_INCREMENT = 0x61c88647;

return nextHashCode.getAndAdd(HASH_INCREMENT);
```

每个 ThreadLocal 对象构造时,`threadLocalHashCode` 在静态 AtomicInteger(`ThreadLocal.java:93`)上递增 `0x61c88647`。这个常数是**黄金分割比例的 32 位整数表示**: `0x61c88647 = 2^32 × (3-√5)/2 ≈ 0.382 × 2^32`(即黄金分割比 (√5-1)/2 ≈ 0.618 的平方;与之互补的 `0x9E3779B9` 是 (√5-1)/2 本身,两者相加恰为 2^32)。斐波那契哈希的性质: 连续分配的哈希值在模 2^n 的区间上**分布极其均匀**,配合开放寻址的线性探测,冲突少、分布散——这是 ThreadLocalMap 不需要像 HashMap 那样做扰动的原因。

### 2.3 开放寻址:数组 + 线性探测

`ThreadLocalMap` 用**开放寻址**(`table` 数组 + 线性探测,`ThreadLocal.java:348` 的 `private Entry[] table`、`342` 的 `INITIAL_CAPACITY = 16`)而不是 HashMap 的链地址——数组小(16 起)、Entry 生命周期简单,线性探测的缓存友好性更好。

### 2.4 泄漏机制:泄漏的是 value,不是 key

三段式:

1. **key 可回收**:ThreadLocal 对象在外部被置 null 后,没有强引用了——Entry 里的弱引用不阻止 GC,key 被回收、槽位变成"key 为 null 的脏槽"
2. **value 永不清**:Entry 里的 value 是**强引用**——只要 Entry 还挂在 Thread 的 map 里,value 就活着
3. **线程不销毁 → 泄漏永久化**:普通线程死了,map 跟着死;但**线程池复用线程**——线程活着,map 活着,脏 Entry 的 value 一直占着内存

所以"ThreadLocal 内存泄漏"的准确描述是:**泄漏的是 value(以及 Entry 壳),不是 key**——key 早就被弱引用机制回收了。

关键设计(斜体):*为什么偏要用弱引用?如果 key 是强引用,ThreadLocal 对象被置 null 也不会被回收(Entry 强引着它),key 永远有效、槽位永远不脏,map 里全是"活的值"——比现在更糟。弱引用至少让 key 失效,配合第 3 节的清理链能把 value 收掉。面试必答句: "弱引用让 ThreadLocal 可回收,但 value 是强引用会泄漏——所以必须 remove"。*

## 3. "泄漏怎么被清理" — get/set 的清理链

### 3.1 get 路径:命中脏槽立即清理

`getEntry`(`ThreadLocal.java:433`)先按哈希定位,`getEntryAfterMiss`(`ThreadLocal.java:451`)在探测过程中遇到 **key 为 null 的脏槽**时,调用 `expungeStaleEntry`(`ThreadLocal.java:609`)——**清除该槽的 value,并把后续槽位 rehash 重新放置**(因为开放寻址的线性探测链可能因中间槽被清而断裂)。

### 3.2 set 路径:原地替换 + 启发式清扫

`set`(`ThreadLocalMap.set`,`ThreadLocal.java:474` 起)的探测循环里:

- 遇到"**key 相同但 value 过期**(key 已被 GC)"的脏槽 → `replaceStaleEntry`(`ThreadLocal.java:540`)——**原地替换 value**,避免新值落位后又触发清理
- 顺带 `cleanSomeSlots`(`ThreadLocal.java:669`)——**启发式清扫**: 从当前位置向后的若干槽位里扫描脏槽,`n` 每轮右移一位、对数递减(`ThreadLocal.java:681` 的 `n >>>= 1`),发现脏槽时 `n` 重置为 len 再扫一轮(`ThreadLocal.java:677`)——平衡清理成本与收益

### 3.3 扩容:2/3 阈值

`rehash`(`ThreadLocal.java:690`)→ `resize`(`ThreadLocal.java:701`): 平时 set 触发扩容的线是 **threshold = len × 2/3**(`setThreshold`,`ThreadLocal.java:363-364`);rehash 本身先 `expungeStaleEntries` 全量清理(`ThreadLocal.java:691`),再按 **更低的线**(`size >= threshold - threshold/4`,即约 len/2,注释 "Use lower threshold for doubling to avoid hysteresis"@692-693)决定是否扩容翻倍——清理后仍超半数才扩容,避免"清理→缩容→再写满"的抖动。注意 2/3 阈值比 HashMap 的 0.75 更保守——开放寻址在装载因子高时性能崩塌更快。

### 3.4 被动清理的盲区

关键事实:**清理是"被动触发"的**——只有后续 get/set 的探测路径**走到脏槽附近**,才会触发 expunge/cleanSome。长期空闲的 map 里的脏 Entry,没有任何主动清理机制,会一直挂到线程销毁。

这就是生产规范"**线程池任务里用 ThreadLocal 必须在 finally 里 remove**"的机制原因:

- **不 remove**:线程池复用线程 → 线程不销毁 → 脏 Entry 的 value 一直活着(泄漏)+ **值串用**(下一个任务 get 到上一个任务留下的值——业务 bug 比内存泄漏更常见)
- **remove 根治**:`ThreadLocal.remove()`(`ThreadLocal.java:239`)主动删除当前线程的这个 key——不依赖任何清理链

关键设计(斜体):*JDK 的清理链是"尽力而为"的补偿机制——弱引用是设计、清理链是兜底、remove 才是根治。面试答"为什么线程池下必须 remove": 复用线程不销毁,map 永不清理 + 值串用,两个理由都说到才是满分。*

## 4. "子线程能继承吗" — InheritableThreadLocal 与创建链路

### 4.1 继承的挂载点:线程构造器

`Thread` 构造器(`Thread.java:443-445`):

```java
// Thread.java:443-445(截取核心,逐字)
if (inheritThreadLocals && parent.inheritableThreadLocals != null)
    this.inheritableThreadLocals =
        ThreadLocal.createInheritedMap(parent.inheritableThreadLocals);
```

新线程构造时,如果父线程有 `inheritableThreadLocals`(非 null),就调用 `ThreadLocal.createInheritedMap`(`ThreadLocal.java:275`)把父线程的 map **复制一份**给子线程。注意是 **inheritableThreadLocals 专用字段**——普通 `threadLocals`(第 1 节的)不继承。

### 4.2 InheritableThreadLocal:两个覆写

`InheritableThreadLocal`(`InheritableThreadLocal.java:53`)只做了三处覆写:

- `childValue(T)`(`InheritableThreadLocal.java:66-67`):默认原样返回——子类可覆写定义"继承时值如何变换"(比如 TraceId 加前缀)
- `getMap`/`createMap`(`InheritableThreadLocal.java:72-84`):把存储指向 `inheritableThreadLocals` 字段而不是 `threadLocals`

### 4.3 局限:快照继承,不追后续

继承是**"创建那一刻的值复制"**:

- 父线程在创建子线程**之后**再改值,子线程看不到(值是复制,不是共享引用)
- **线程池场景失效**:线程池的 worker 线程不是每次任务都新建——`new Thread(task)` 的继承只发生在构造时,复用线程不会重新继承 → TraceId 用 InheritableThreadLocal 在池化场景传不出去

这就是阿里 TransmittableThreadLocal(TTL)存在的理由: 用"任务提交时显式快照 + 任务开始前恢复"的包装,让链路追踪变量能跨线程池传递。

关键设计(斜体):*"继承 = 复制值"这个语义决定了它的适用边界: 父子线程一对一的场景(简单任务)够用;一对多、异步链路(线程池/CompletableFuture)失效。面试答出"继承发生在线程构造那一刻、是值快照"就避开了'为什么线程池里 InheritableThreadLocal 不好使'的坑。*

跨层标注: [内部卷: 17-threads(线程创建流程与 threadLocals 挂载顺序)]

## 核心悬念

线程里的代码抛了异常——**异常去哪了**?主线程根本看不到子线程的异常;线程池 `execute` 的任务抛异常直接消失(只有 `submit` 的会包进 Future)。`Thread.UncaughtExceptionHandler` 链是怎么兜住它们的?以及线程私有的最后一个秘密——ThreadLocalRandom,为什么并发场景要用它而不是 `Math.random`?下一篇把这两个收尾。

> → [11-thread-threadlocal/03 — 未捕获异常与 ThreadLocalRandom](03-exception-random.md)
