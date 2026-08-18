# 05. StampedLock 与读写锁 — 读写分离、乐观读

> **前置依赖**: [12-lock-sync/01 — AQS 核心](01-aqs-core.md)(共享/独占模式)、[12-lock-sync/04 — 共享模式与并发工具族](04-shared-tools.md)(共享模式级联)
> → **后续**: 域 16 Stream 与函数式(按写作顺序)
> 关联: 内部卷 19-sync(JVM 锁机制);域 13 原子类(CAS)

## 读多写少,怎么让读不互相等

ReentrantLock 里,两个读者也要排队。但读多写少的场景(缓存、配置),读者之间明明可以并行——这就是读写锁。而 StampedLock 更进一步: **乐观读连锁都不加**。这一篇拆: ReentrantReadWriteLock 的高低 16 位计数、StampedLock 的三模式与 stamp 校验、锁转换、以及选型。

## 1. "ReentrantReadWriteLock" — 读写分离

### 1.1 一个 state 两用

`ReentrantReadWriteLock`(`ReentrantReadWriteLock.java`,1502 行)内部两个锁(`readLock@247`/`writeLock@246`),底层同一个 AQS 子类,state 被**高低 16 位拆分**(`Sync`,`:263-271`):

```java
// ReentrantReadWriteLock.java:263-271(截取核心,逐字)
        static final int SHARED_SHIFT   = 16;
        static final int EXCLUSIVE_MASK = (1 << SHARED_SHIFT) - 1;
        static int sharedCount(int c)    { return c >>> SHARED_SHIFT; }
        static int exclusiveCount(int c) { return c & EXCLUSIVE_MASK; }
```

- **高 16 位**: 读计数(sharedCount = c >>> 16)
- **低 16 位**: 写计数(exclusiveCount = c & 0xFFFF,只能是 0 或 1)

**一个 int 同时编码两种计数**——这就是"读写分离"的 state 层实现。两个锁各走各的 AQS 模式: **写锁用独占模式**(`tryAcquire`@382: 读计数非零或写者非本线程 → 失败)、**读锁用共享模式**(`tryAcquireShared`@453: 写计数非零 → 返回 -1,级联唤醒见域 12 第 4 篇)。

### 1.2 语义与降级

- **读-读并行**: 多个读者共享模式同时持有
- **读-写互斥**: 写者要独占(写计数=1 时读者全部失败)
- **写-写互斥**: 独占模式

经典操作: **写锁降级为读锁**(Javadoc 明说 "Reentrancy also allows downgrading from the write lock to a read lock",`ReentrantReadWriteLock.java:100-101`)——写者写完可以降级成读锁继续读(先获取读锁再释放写锁),避免"释放写锁后读者插进来改数据"的窗口;**读锁不可升级为写锁**(会死锁: 读-写互斥,读锁持有者等写锁、写锁等读者释放)。

关键设计(斜体):*"读写分离"用 state 的高低 16 位同时编码两种计数——一个 int 两用。面试"读锁和写锁关系": 写锁可降级为读锁,读锁不可升级为写锁(死锁风险);"读写锁适合什么": 读多写少的缓存/配置场景。*

## 2. "StampedLock 的三种模式" — 写/读/乐观读

### 2.1 非 AQS 实现

`StampedLock`(`StampedLock.java`,1620 行)**没有用 AQS**——它自实现状态机 + 队列(whead/wtail 自有队列)。核心状态常量(`:368-376`):

- `LG_READERS = 7`(`:368`): 读者计数位数
- `WBIT = 1L << 7`(`:372`): 写锁位
- `SBITS = ~RBITS`(`:376`): 版本位掩码

### 2.2 三种模式

| 模式 | 方法 | 语义 |
|------|------|------|
| 写锁 | `writeLock()`(`:459`) | 独占,返回写 stamp |
| 读锁 | `readLock()`(`:532`) | 共享,无竞争快路径 `casState(s, s + RUNIT)`(`:535-537`,直接 CAS 不加队列) |
| **乐观读** | `tryOptimisticRead()`(`:629`) | **不加锁的读** |

`tryOptimisticRead`(`:629-632`):

```java
// StampedLock.java:629-632(截取核心,逐字)
    public long tryOptimisticRead() {
        long s;
        return (((s = state) & WBIT) == 0L) ? (s & SBITS) : 0L;
    }
```

写锁位为 0(无写者)→ 返回**当前版本戳**(s & SBITS);有写者 → 返回 0(乐观读失败)。

### 2.3 validate:版本校验

乐观读的标准用法:

```java
// 用法示意(API 形式,非源码片段)
long stamp = lock.tryOptimisticRead();   // ① 拿版本戳(不加锁)
int x = data;                            // ② 直接读(无锁)
if (!lock.validate(stamp)) {             // ③ 校验: 期间有写?
    stamp = lock.readLock();             // ④ 有写 → 升级读锁重读
    try { x = data; } finally { lock.unlockRead(stamp); }
}
```

`validate`(`:646-650`):

```java
// StampedLock.java:646-650(截取核心,逐字)
    public boolean validate(long stamp) {
        VarHandle.acquireFence();
        return (stamp & SBITS) == (state & SBITS);
    }
```

**`(stamp & SBITS) == (state & SBITS)`**——读期间的版本戳与当前版本一致 = 没发生写(写会翻转版本位),校验通过;不一致 = 期间有写者,需要重读。开头的 `VarHandle.acquireFence()`(`:648`)不是装饰——源码注释(`:291-294`)说明: 乐观读依赖"读数据发生在校验之前"的排序,普通 volatile 读不强制这个顺序,需要 acquire 栅栏兜底(乐观读的正确性正是靠"先读后校验"的内存序)。

关键设计(斜体):*乐观读 = **不加锁的读**——读时假设没人写,结束后校验版本号;没写=赚到(零锁开销),有写=重读;stamp 是"版本快照"。面试"乐观读为什么快": 免锁读路径——tryOptimisticRead 只读一次 state,读数据零同步;适用条件: 写频率低(写频繁则重试浪费)。*

跨层标注: [域 13: 01-atomicinteger——StampedLock 的状态位(CAS 直写)与版本戳思想同源;内部卷 19-sync——synchronized 的监视器 vs StampedLock 的自实现状态机是"JVM 锁 vs 纯 Java 锁"两种路线]

## 3. "锁升级与转换" — tryConvertToWriteLock

### 3.1 转换方法族

`tryConvertToWriteLock`(`:739-775`)把已有 stamp 平滑升级/转换:

```java
// StampedLock.java:739-758(截取核心,逐字)
    public long tryConvertToWriteLock(long stamp) {
        long a = stamp & ABITS, m, s, next;
        while (((s = state) & SBITS) == (stamp & SBITS)) {
            if ((m = s & ABITS) == 0L) {
                if (a != 0L)
                    break;
                if ((next = tryWriteLock(s)) != 0L)
                    return next;
            }
            else if (m == WBIT) {
                if (a != m)
                    break;
                return stamp;
            }
            else if (m == RUNIT && a != 0L) {
                if (casState(s, next = s - RUNIT + WBIT)) {
                    VarHandle.storeStoreFence();
                    return next;
                }
            }
            ...
```

三种情形(模式判定靠 `stamp & ABITS`,源码注释 `:379-386`): ①当前无锁(m==0)——**stamp 是乐观读(a==0)才允许抢写锁**,带锁的旧 stamp(a!=0)直接失败;②当前已是写锁(m==WBIT)→ 原 stamp 返回(保持);③当前恰好一个读者(m==RUNIT)且 stamp 是读 stamp → CAS `s - RUNIT + WBIT` **读升级写**(多个读者时 m 不是 RUNIT,走不到升级,只能等)。其他转换: `tryConvertToReadLock`(`:776`)、`tryConvertToOptimisticRead`(`:817`)。

### 3.2 转换失败的代价

**转换失败返回 0**——调用方必须释放旧 stamp、重新完整获取。这是 stamp 状态机的优雅之处: 同一个 stamp 在不同条件下变换模式,失败即"换档"重来。

关键设计(斜体):*"转换"是 stamp 状态机的优雅之处——同一个 stamp 在不同条件下变换模式。面试"升级失败怎么办": 转换返回 0,释放旧 stamp 重新获取;注意 tryConvertToWriteLock 的读→写升级是**单一读锁**才能 CAS 升级(多个读者时必须等其他人释放)。*

## 4. "选型与注意" — 三锁对比

| 锁 | 特性 | 适用 |
|----|------|------|
| synchronized | 简单/内置/可重入 | 通用 |
| ReentrantLock | 公平/中断/多条件/可重入 | 高级语义 |
| ReentrantReadWriteLock | 读写分离/可重入 | 读多写少 |
| StampedLock | +乐观读/不可重入 | 写极少/读极多 |

**StampedLock 的注意点**(不是万能):

- **不可重入**: 同线程重复获取会死锁
- **不支持 Condition**
- 中断需 `lockInterruptibly`/`readLockInterruptibly` 变体
- 乐观读在**写频繁**时重试成本高

关键设计(斜体):*锁的选型 = 竞争模式分析: 读写比、写频率、重入需求。面试"读多写少用什么": 先 ReadWriteLock 再谈 StampedLock 乐观读;能说出 StampedLock 不可重入/无 Condition 的边界就是细节分;过度优化是反模式——先 profile 再换锁,简单优先。*

## 核心悬念

锁的世界收官——但**无锁的集合**呢?`ConcurrentHashMap` 怎么做到"读无锁、写细粒度"?`CopyOnWriteArrayList` 的写时复制?`BlockingQueue` 的阻塞语义?——下一篇(按写作顺序): 域 16 Stream 与函数式。

> → 域 16 Stream 与函数式(16-stream 系列)| 关联: 并发集合与线程池(域 10/14,后续展开)
