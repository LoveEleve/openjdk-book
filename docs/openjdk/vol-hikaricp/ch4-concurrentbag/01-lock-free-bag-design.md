# 为什么 HikariCP 不直接用队列，而要自己做一个 `ConcurrentBag`

> 本文基于 HikariCP 7.0.2 当前源码。本文不把 `ConcurrentBag` 写成一个普通集合类，也不把它写成并发术语清单，而是专门解释：为什么 HikariCP 在连接借还这件事上，没有直接采用一个现成的阻塞队列或同步池结构，而是做了一套“本地命中 -> 共享扫描 -> handoff 移交”的协作协议。本文的重点不是容器里放了什么，而是多线程下对象怎么被借、还、等、移交。

## 为什么一个连接池，最后会逼着自己去实现一套看起来不像队列也不像池子的结构

第一次看 HikariCP 时，最容易出现的想法其实非常朴素：

- 池里有很多连接
- 线程要用时拿一个
- 用完后再放回去

这听起来和很多通用并发场景没有本质区别，于是一个非常顺手的直觉就会冒出来：

**为什么不直接用一个 `BlockingQueue<Connection>`？**

从表面看，这个想法几乎无可挑剔：

- 队列天然能排队
- 线程天然能等待
- 放回去的时候也天然有个位置

可一旦真的站到 HikariCP 的运行时要求上，这个模型就开始显得太粗了。因为连接池在高并发场景下关心的，并不只是“有没有地方放对象”，而是：

- 同一个线程刚归还过的对象，能不能下次优先命中
- 没命中本地对象时，能不能快速扫到全局可用对象
- 再不行时，等待线程和新归还对象怎么低成本移交
- 某个对象从可用到被借出，再到重新归还，状态怎么切换
- 这一切怎样尽量少碰全局锁，少制造争用

也就是说，HikariCP 面对的不是一个静态容器问题，而是一个非常具体的协作问题：

**多线程下，连接对象怎样被最快借到、最稳还回、最少争用地在不同线程之间移交。**

所以，本文真正要回答的问题不是“`ConcurrentBag` 里有哪些字段和方法”，而是：

**为什么 HikariCP 不直接用队列，而非要自己做一套看起来像 Bag 的无锁并发协作结构？**

## 先看失败方案：为什么普通队列和普通池模型都不够

### 失败方案一：直接用 `BlockingQueue<Connection>`

这是最自然的第一反应，因为从需求表面看，队列已经像是完美模型了：

- 有对象可拿
- 没对象可等
- 放回去时再 offer 回去

但这个模型对 HikariCP 来说有个根本问题：它只擅长回答“排队等待”，却不擅长回答“如何减少高频借还中的全局竞争”。

例如：

- 某个线程刚归还了一条连接，下一个请求还是这个线程，是否还要绕回全局队列？
- 全局明明已经有可用对象，是不是每次都要通过阻塞队列统一串行化？
- 等待线程和新归还对象之间，能不能更直接地移交？

这些问题说明，HikariCP 并不只是想“把对象放进一个线程安全容器”，而是想把借还路径拆成不同快慢层次。

所以，普通阻塞队列在语义上足够，在性能和协作层次上却太粗。

### 失败方案二：做一个普通对象池，借还时统一加锁

另一种自然方案是：

- 维护一个对象池
- 借的时候加锁取
- 还的时候加锁放
- 大家都按同一套入口走

这个模型比阻塞队列更贴近对象池语义，但它依然会把高频路径集中到同一个全局竞争点上。

而连接池里最重的操作之一，恰恰就是：
- 每次借还都在高频发生

如果每次都必须先去抢同一把全局锁，那么池的存储层就会成为新的瓶颈。

也就是说，HikariCP 不是不想做池，而是不想把“池”做成一个集中争用点。

### 失败方案三：ThreadLocal 做个小缓存就够了

当读者开始意识到全局竞争是问题时，第三个看起来很合理的想法就是：

- 那就加一个 ThreadLocal 缓存
- 命中本地就直接拿
- 命不中再说

这个想法抓到了 HikariCP 设计的一部分精髓，但如果只停在这里，又会忽略另外一半：

- 不是每个请求都能命中本地缓存
- 本地没命中时，还要有共享结构
- 共享结构之外，还要能支持等待线程与归还线程的直接移交

也就是说，ThreadLocal 不是完整答案，它只是第一层快路径。

真正的 `ConcurrentBag` 是：
- 本地命中
- 共享扫描
- handoff 等待/移交

三层一起工作，而不是只靠其中任意一层。

## `ConcurrentBag` 的最小总图：不是装对象，而是协调借还

如果把 `ConcurrentBag` 先压缩成最小模型，它可以写成下面这样：

```text
borrow request
   -> try thread-local list
   -> scan sharedList
   -> wait / handoff via handoffQueue

requite
   -> try handoff to waiter
   -> else back to thread-local/shared visibility
```

如果再换一种更容易理解的拆法，这条链可以分成三层：

```text
[本地快路径]
ThreadLocal list

   ->

[共享可见层]
sharedList

   ->

[线程间移交层]
handoffQueue + waiters
```

这张图最重要的价值，不是让读者背字段名，而是先把三个问题分开：

### 一、本地快路径
回答：为什么刚刚用过、刚刚还回的对象，应该尽量让当前线程优先再次命中？

### 二、共享可见层
回答：本地没命中时，怎么快速看到全局可用对象？

### 三、线程间移交层
回答：如果已经有线程在等，归还的对象为什么不只是“放回池里”，而应该优先考虑直接交给等待者？

只要这三层先分开，`ConcurrentBag` 为什么不是普通容器，就会清楚很多。

## 一、`ConcurrentBag` 真正解决的不是“存哪”，而是“怎么协作”

只要先把它的总图立住，就会发现一个非常关键的事实：

`ConcurrentBag` 真正要解决的不是“把对象放在哪”，而是：

- 借的时候先去哪里找
- 找不到时下一步怎么办
- 还的时候优先唤醒谁
- 候选对象的状态怎么切换
- 线程之间怎样减少没必要的争用

也就是说，它本质上不是一个被动容器，而是一套主动协作协议。

这也是为什么 HikariCP 不叫它 Queue，也不直接叫 Pool，而叫 Bag。因为它并不想给读者一个“这是顺序容器”或者“这是典型池实现”的错觉。它更像一个对象候选集合，只是这个集合在运行时带着自己的一整套借还协作规则。

## 二、`borrow()`：为什么先本地、再共享、最后 handoff

这条链里最核心的入口当然就是：
- `borrow()`

HikariCP 没有让 `borrow()` 一上来就碰全局结构，而是先尝试本地 ThreadLocal 列表。

方法级锚点很明确：
- `ConcurrentBag.borrow(...)`: `com/zaxxer/hikari/util/ConcurrentBag.java:132`
- 先走本地列表：`ConcurrentBag.java:134`
- 再扫共享列表：`ConcurrentBag.java:148`
- 最后进入 handoffQueue 等待：`ConcurrentBag.java:163`

这背后的意图非常清楚：
- 能在当前线程命中的，就不要先去碰共享竞争面

如果本地没有命中，再去扫共享列表。也就是说：
- 本地快路径优先
- 共享结构是第二层

再不行，才会进入等待和 handoff 协作。

这说明 HikariCP 的借出不是单路径的：

- 不是“统一去一个地方拿”
- 而是“按成本从低到高逐层找”

所以 `borrow()` 的真正价值，不在于“从 Bag 里拿对象”，而在于它把借出协作拆成了多层快慢路径。

## 三、`ThreadLocal`、`sharedList`、`handoffQueue` 为什么必须三层并存

很多并发结构看起来像是在不同实现之间二选一：
- 要么全局共享
- 要么本地缓存

但 `ConcurrentBag` 明显不是这个思路。它没有选择其中一层，而是三层并存：

### 1. ThreadLocal
负责低成本、当前线程优先的快路径。

### 2. sharedList
负责全局可见性，保证别的线程放回来的对象不是“只有自己知道”。

### 3. handoffQueue
负责等待线程和归还线程之间更直接的移交。

这说明 HikariCP 不是在找“最优单一容器”，而是在构造一套分层协作结构：

- 有些情况适合局部命中
- 有些情况适合共享扫描
- 有些情况已经出现等待线程，应该直接 handoff

所以三层并存不是复杂化，而是对不同并发场景分别优化。

而归还侧的锚点也能把这条链闭上：
- `ConcurrentBag.requite(...)`: `ConcurrentBag.java:187`
- 先把状态设回 `STATE_NOT_IN_USE`：`ConcurrentBag.java:189`
- 若有等待线程则优先 handoff：`ConcurrentBag.java:191`
- 否则才回到当前线程本地列表：`ConcurrentBag.java:203`

## 四、为什么状态机比容器本身更重要

只看存储结构还不够，因为连接对象不是简单放进去拿出来的值，它还有状态。

这也是为什么 `ConcurrentBag` 的真正核心之一，不只是：
- 本地列表
- 共享列表
- handoffQueue

而是：
- 对象从 `NOT_IN_USE` 到 `IN_USE`
- 以及 `RESERVED`、`REMOVED` 等状态如何参与借还协作

也就是说，Bag 并不是在管理“裸对象集合”，而是在管理：

**一批对象在不同线程之间以何种状态被借、被保留、被归还、被移除。**

这些状态在源码里就是显式常量：
- `STATE_NOT_IN_USE`: `ConcurrentBag.java:83`
- `STATE_IN_USE`: `ConcurrentBag.java:84`
- `STATE_REMOVED`: `ConcurrentBag.java:85`
- `STATE_RESERVED`: `ConcurrentBag.java:86`

而 `reserve()` / `unreserve()` 则把“临时保留但未彻底移除”的路径明确独立出来：
- `reserve(...)`: `ConcurrentBag.java:306`
- `unreserve(...)`: `ConcurrentBag.java:318`

这也解释了为什么前面讲借出链和归还链时，都不能把 `ConcurrentBag` 只当底层容器。因为真正决定安全借还的，不只是“对象在哪”，而是“对象现在处于什么状态”。

## 五、为什么这套结构能减少争用，但又不等于完全无协调

很多人看到 `ConcurrentBag` 的设计，会很快给它贴一个标签：
- 无锁
- 高性能
- 本地缓存优先

这些标签方向没错，但如果只停在这里，又会误读另一件事：

- 它不是完全没有协调
- 它只是把协调拆到了更细的层次里

也就是说，HikariCP 不是把所有争用消灭掉了，而是尽量避免让每一次借还都落到同一个全局竞争点上。

所以这里的重点不应写成：
- “它完全无锁”

更准确的说法是：
- **它尽量让高频路径局部化，让必要协调在更晚、更窄的层次上发生。**

这也是为什么它对连接池这种高频借还场景特别有效。



## 失败路径

1. **ThreadLocal 路径竞争**：`borrow()` 尝试从 ThreadLocal 获取，但其他线程也同时归还了对象到 ThreadLocal → CAS 失败 → 继续共享列表路径。风险低，因为 ThreadLocal 是本线程独有的

2. **handoff 队列无消息**：`handoffQueue.poll(timeout, ...)` 等待归还线程通过 handoff 移交对象 → 超时（无归还发生）→ 返回 null → `borrow()` 返回 null → 调用方超时退出

3. **requite 时 handoff 失败**：`requite()` 中 `handoffQueue.offer(bagEntry)` 失败（无等待线程）→ 回退到 ThreadLocal 路径。设计上这是正常的，但如果在高并发下频繁失败，说明 handoff 队列利用率低

4. **状态竞争**：`borrow()` 中 CAS `NOT_IN_USE→IN_USE` 失败（另一个线程同时借出）→ 跳过该条目，继续找下一个。CAS 失败是正常的，但频繁失败说明共享列表争用高

5. **reserve 失败**：`reserve()` 在 HouseKeeper 驱逐连接时使用，CAS `NOT_IN_USE→RESERVED` 失败 → 连接已被其他线程借出 → 跳过驱逐，等下次巡检

6. **ThreadLocal 泄漏**：ThreadLocal 在长期运行中积累大量已回收的 `bagEntry` 引用 → 但 `borrow()` 会移除并检查，理论上有泄漏风险




## 四种状态的完整语义

`ConcurrentBag.java:83-86` 定义了四种状态：

```java
int STATE_NOT_IN_USE = 0;  // 空闲，可被借出
int STATE_IN_USE = 1;      // 已借出，正在使用
int STATE_REMOVED = -1;    // 已从池中移除，不再可用
int STATE_RESERVED = -2;   // 已预留，等待驱逐/释放
```

状态转换图：

```
    NOT_IN_USE ──borrow()──→ IN_USE
        ↑                       │
        │  requite()             │  reserve()
        │                       ↓
        │                  RESERVED
        │                       │
        └── unreserve() ←───────┘
        
    REMOVED ←── closeConnection() ／ 驱逐 ──── 任何状态
```

`CAS` 操作是状态转换的核心。`borrow()` 中 `compareAndSet(STATE_NOT_IN_USE, STATE_IN_USE)` 是原子操作，多线程下只有一个能成功。`requite()` 中 `setState(STATE_NOT_IN_USE)` 直接设置（不需要 CAS，因为只有持有者才会归还）。`reserve()` 中 `compareAndSet(STATE_NOT_IN_USE, STATE_RESERVED)` 把空闲连接预留，防止在驱逐过程中被借出。

`REMOVED` 状态是终结态：一旦进入，不再回到任何其他状态。驱逐时 `closeConnection()` 标记 `REMOVED` 并从 `sharedList` 移除。

## 借出链与归还链如何通过 ConcurrentBag 衔接

借出链（Ch2）的终点是 `createProxyConnection` 交付代理，但存储层的变化是 `borrow()` 把状态从 `NOT_IN_USE` 改为 `IN_USE`。归还链（Ch3）的起点是 `close()` 被代理拦截，但存储层的变化是 `requite()` 把状态从 `IN_USE` 改回 `NOT_IN_USE`。

```text
HikariPool.getConnection()          ProxyConnection.close()
    │                                     │
    ▼                                     ▼
ConcurrentBag.borrow()              ConcurrentBag.requite()
    │                                     │
    │ NOT_IN_USE → IN_USE                │ IN_USE → NOT_IN_USE
    ▼                                     ▼
PoolEntry 交付给代理                  PoolEntry 回到池中
```

衔接点：`borrow()` 和 `requite()` 是借出链和归还链在存储层上的两个端点。`HikariPool.getConnection()` 调 `borrow()`，`ProxyConnection.close()` 最终调 `requite()`。`handoffQueue` 是它们之间的桥梁——归还线程在 `requite()` 中通过 `handoffQueue.offer()` 直接移交，借出线程在 `borrow()` 中通过 `handoffQueue.poll()` 接收。


## 到了这里，`ConcurrentBag` 已经不可能再被理解成“装连接的容器”了

现在再回头看最开始那个直觉：

- 既然是池，找个队列装起来不就行了？

看到这里，这个理解已经明显不够用了。

更准确的说法应该是：

- `ConcurrentBag` 当然也在存对象
- 但它真正关心的不是“存放”本身，而是“借还协作协议”

也就是说，HikariCP 需要的不是一个静态容器，而是一条在高并发下仍然能：

- 快速本地命中
- 共享可见
- 等待移交
- 状态切换

的协作结构。

这也是为什么 `ConcurrentBag` 会成为 HikariCP 主干里最值得单独拿出来讲的一条线。

## 这篇真正立住的，不是一个 Bag 类，而是“借还协作协议”这个概念

如果只从表面看，这篇很容易被讲成：

- 有个 ThreadLocal
- 有个 sharedList
- 有个 handoffQueue

这种讲法当然不算错，但还是太像结构拼图。

从前面 HikariCP 主干和借还链归纳回来，更稳妥的理解方式应该是：

1. `ConcurrentBag` 不是普通容器
2. 它把本地命中、共享扫描、线程移交串成一条分层借还协作链
3. 状态机保证了对象在借、还、保留、移除时的安全性
4. 所以它真正管理的不是“连接放在哪”，而是“连接怎么被并发地借还协作”

也就是说，这篇真正补上的，不是 `ConcurrentBag` API，而是：

**HikariCP 的池存储层，本质上是一套借还协作协议。**

## 这篇之后，HikariCP 最自然的继续方向是什么

到这里，HikariCP 的主干层已经被压得比较完整了：

- 总骨架
- 借出链
- 归还 / 驱逐链
- 存储层并发设计

如果继续往下写，最自然的下一步就是：

- **连接生命周期管理 / HouseKeeper**

因为到这里，连接怎么被借、怎么被还、怎么在并发结构里协作已经立住了；再往下最自然的问题就是：

- 连接活多久
- 什么时候该被淘汰
- 后台巡检是谁在推动这些生命周期策略真正落地