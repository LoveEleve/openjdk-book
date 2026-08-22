# 02. 一次 `getConnection()` 到底穿过哪些门：HikariCP 的借出链

> **前置依赖**: [01 — 连接生命史管理链总骨架](../ch1-architecture/01-pool-architecture-and-lifecycle.md)：已建立 HikariDataSource → HikariPool → PoolEntry 总骨架
> → **后续**: [03 — close() 为什么不是关闭连接（归还与驱逐）](../ch3-return-evict/01-return-and-eviction.md)
> 关联域：04-concurrentbag(存储层)、06-validation(验证)、07-leak-detection(泄漏)

## 困惑：一个看起来再普通不过的 `getConnection()`，为什么值得单独成篇？

对业务代码来说，连接池最朴素的使用方式通常只有一行：

```java
Connection connection = dataSource.getConnection();
```

所以很容易产生一种印象：这不过就是从池子里拿一个连接出来，真正复杂的都在池内部，`getConnection()` 自己应该没什么好讲的。

这个印象的问题在于，它把“结果”误当成了“过程”。从 HikariCP 当前实现看，`getConnection()` 不只是一个外部入口，它还是整条连接生命史里最频繁、最敏感的一次过闸动作。

因为只要应用调用 `getConnection()`，池内部立刻要同时回答一串问题：

- 这个时刻池是不是允许借出，还是正处于 suspend 状态
- 当前调用走的是 fastPath 还是第一次惰性初始化
- 候选对象是不是已经从 `ConcurrentBag` 拿到了
- 拿到的候选是不是已经被驱逐、是不是已经死了
- 当前时刻是不是可以走 `aliveBypassWindowMs` 跳过活性检测
- 最终交给调用方的到底是底层连接，还是池控制下的代理连接

也就是说，一次借出，把池子的运行时策略、并发存储、健康判断、生命周期边界和代理封装全都拉到了同一个瞬间。

如果 Ch1 讲的是“连接这一生有哪些阶段”，那么这一篇要回答的就是：**当应用说“给我一个连接”时，池内部到底要过几道门，哪些门只是找候选，哪些门才是真正的安全交付门。**

## 一、三个直觉方案为什么都不理想

### 方案一：`getConnection()` 就是把连接从池里取出来

```java
Connection conn = pool.get(idleConnections.get(0));
return conn;
```

#### 为什么不行：它把“候选获取”误当成了“借出完成”

如果借出只是“从容器里取一个对象”，那整个借出链最关键的部分都会被抹掉：

- 池可能正被挂起，当前并不允许借出
- 取出来的候选可能已经被标记驱逐
- 候选可能已经被数据库断开
- 借出可能已经接近超时，不能无穷等待

所以“取一个对象出来”顶多解释了 `ConcurrentBag.borrow()` 之前的直觉，解释不了借出之后还要继续做的安全检查和代理交付。

#### 为什么不行：它根本没有“交付条件”概念

真正的借出链，核心不是“池里有没有连接”，而是“这条连接现在配不配交给调用方”。这就意味着候选获取只是前半段，后半段必须继续经过驱逐检查、活性检查、请求边界、代理封装，最后才能说“借出完成”。

### 方案二：`ConcurrentBag.borrow()` 成功了，后面就没什么事了

```java
PoolEntry entry = concurrentBag.borrow(timeout, MILLISECONDS);
return entry;
```

#### 为什么不行：Bag 只解决“候选能不能拿到”

`ConcurrentBag.borrow()` 解决的是存储层问题：有没有办法以较低争用成本拿到一个状态为 `NOT_IN_USE` 的候选对象。

它并不自动保证这条候选：

- 还活着（`isConnectionDead()`）
- 还没被驱逐（`isMarkedEvicted()`）
- 能被调用方安全 `close()` 回池
- 已经挂上泄漏检测任务

所以 Bag 成功，只能说明“候选获取成功”，还不能说明“借出交付成功”。

#### 为什么不行：它会让借出链在中途断掉

如果把 `borrow()` 当成终点，后面的活性判断和代理封装都不见了。于是连接池就只剩“借到一个对象”的能力，没有“把对象安全交给外部再收回来”的能力。

### 方案三：调用方拿到的就是底层 JDBC Connection

```java
return rawConnection;
```

#### 为什么不行：一旦直接交裸连接，池就失去控制权

如果把底层 JDBC Connection 直接交出去，问题会立刻出现：

- `close()` 会真正关闭物理连接，而不是回池
- 归还前状态重置没有入口
- 泄漏检测不知道这条连接什么时候借出的
- 异常连接如何触发驱逐，也失去了统一入口

所以调用方拿到的不是池里的裸连接，而是一个被池控制过的代理视图。

#### 为什么不行：借出链的真正终点其实是代理交付

HikariCP 的借出链终点不是 `borrow()` 返回，也不是活性检测通过，而是 `createProxyConnection()` 完成。只有到这一步，连接才真正从“池内候选”变成“对外可用的连接对象”。

## 核心设计（一句话顿悟）

**HikariCP 的连接借出，本质上不是“从池里拿对象”，而是一条把池内候选转换成可安全交付连接的过闸链；这条链的终点不是 `borrow()` 返回，而是代理连接成功交付。**

## 总图：借出链的完整路径

```text
HikariDataSource.getConnection()
  → fastPath ? 直接进 HikariPool : 惰性初始化池
    → HikariPool.getConnection(hardTimeout)
      → suspendResumeLock.acquire()           [池状态门]
      → connectionBag.borrow(timeout)         [候选获取门]
        → ThreadLocal 本地列表
        → sharedList 共享列表
        → handoffQueue 直接移交
      → isMarkedEvicted() ?                   [驱逐门]
      → aliveBypassWindow ? 跳过活检 : isConnectionDead()  [活性门]
      → metricsTracker.recordBorrowStats()    [统计门]
      → beginRequest()                        [请求边界门，可选]
      → createProxyConnection(leakTask)       [代理交付门]
        → 返回代理连接给调用方
```

这张图最重要的价值，不是让读者背 API 顺序，而是先分清五件事：

- 入口是谁：`HikariDataSource`
- 编排中心是谁：`HikariPool`
- 候选从哪来：`ConcurrentBag`
- 候选怎么变成“可交付”：驱逐门 + 活性门
- 交出去以后凭什么还能收回来：代理连接

## 二、入口层：`HikariDataSource.getConnection()` 为什么分成两条路

### 2.1 快路径：已经有池时，入口必须尽量短

`HikariDataSource.java:92`：

```java
public Connection getConnection() throws SQLException
```

`HikariDataSource.java:98`：

```java
if (fastPathPool != null) {
   return fastPathPool.getConnection();
}
```

这条快路径服务的是最常见场景：池早就已经建好，调用者只想要一个连接。此时入口层不该再做多余判断，更不该每次都进入同步块。

### 2.2 慢路径：第一次真实调用，才触发惰性初始化

`HikariDataSource.java:105-112`：

```java
if (result == null) {
   synchronized (this) {
      result = pool;
      if (result == null) {
         validate();
         pool = result = new HikariPool(this);
         this.seal();
      }
   }
}
```

慢路径回答的是另一个问题：如果这是第一次真正调用 `getConnection()`，那池应该在这一刻完成校验、创建和 seal。

### 2.3 为什么要同时保留 `fastPathPool` 和 `pool`

`HikariDataSource.java:46-47`：

```java
private final HikariPool fastPathPool;
private volatile HikariPool pool;
```

`fastPathPool` 表示“构造时就已经准备好的池”，`pool` 表示“可能走惰性初始化的池”。这两个字段一起存在，不是重复，而是在区分“稳定常态路径”和“第一次初始化路径”。

### 2.4 路标：入口层先解决“怎么进池”，还没开始解决“能不能借到”

到这里，`HikariDataSource` 只负责把调用安全地带进池世界。真正的借出判断，还没开始。

## 三、编排中心：`HikariPool.getConnection(long)` 为什么是整条链的核心

### 3.1 公开入口只是把默认超时转给真正核心方法

`HikariPool.java:140-142`：

```java
public Connection getConnection() throws SQLException
{
   return getConnection(connectionTimeout);
}
```

真正重要的不是无参版本，而是 `HikariPool.java:152` 的 `getConnection(final long hardTimeout)`。

### 3.2 真正的核心不是“找连接”，而是“带着剩余时间反复过闸”

`HikariPool.java:152` 之后的主体逻辑是一个带剩余超时的循环。也就是说，借出链不是“一次判断然后结束”，而是：

- 借一个候选
- 如果候选不合格就淘汰
- 重新计算剩余时间
- 再借下一个候选

这说明借出链天然支持“候选失败后的继续尝试”，而不是第一条连接不合格就立即抛错。

### 3.3 借出链的时钟从 `startTime` 开始，而不是从每次候选开始

`HikariPool.java:155`：

```java
final var startTime = currentTime();
```

这很关键。说明超时预算属于整次借出，而不是属于单个候选。否则每拿到一个坏候选都重新计时，调用者就可能被无限拖住。

### 3.4 路标：`HikariPool.getConnection(long)` 是“带预算的编排器”

`HikariPool` 这里做的不是简单分发，而是在固定预算内，不断尝试把一个合格候选变成可交付连接。

## 四、第一道门：`suspendResumeLock` 为什么不是普通锁

### 4.1 它先问的不是“有没有连接”，而是“现在允不允许借”

`HikariPool.java:154`：

```java
suspendResumeLock.acquire();
```

这说明借出链的第一道门不是候选获取门，而是池状态门。池可以没有坏，也可以有空闲连接，但如果池此刻处于 suspend 状态，借出照样不能继续。

### 4.2 它保护的是“借出权限”，不是保护某个共享容器

这里最容易误会成“加锁保护共享资源”。但 `ConcurrentBag` 自己已经有并发控制机制。`suspendResumeLock` 更像是一道总闸门：池可以暂时关闭借出权限，让后续所有借出线程统一阻塞在入口，而不是放它们进入候选获取链再各自失败。

### 4.3 为什么释放一定放在 `finally`

`HikariPool.java:191`：

```java
finally {
   suspendResumeLock.release();
}
```

这说明无论成功借出、候选失败、还是中断异常，池状态门都必须被正常释放。否则一次异常借出就可能把整条池状态门永久卡死。

### 4.4 路标：状态门先处理“能不能借”，再轮到“借哪个”

`suspendResumeLock` 把“池状态是否允许借出”和“哪条连接可以借出”彻底分开了，这是借出链分层的起点。

## 五、候选获取门：`ConcurrentBag.borrow()` 为什么要分三段路径

### 5.1 第一段：先试 ThreadLocal，本质上是把最近归还的连接留给最近使用它的线程

`ConcurrentBag.java:132-140`：

```java
final var list = threadLocalList.get();
for (var i = list.size() - 1; i >= 0; i--) {
   final var entry = list.remove(i);
   final T bagEntry = useWeakThreadLocals ? ((WeakReference<T>) entry).get() : (T) entry;
   if (bagEntry != null && bagEntry.compareAndSet(STATE_NOT_IN_USE, STATE_IN_USE)) {
      return bagEntry;
   }
}
```

ThreadLocal 路径的价值不是“看起来更快”这么简单，而是尽量把最近归还、缓存还热的连接优先交回给最近使用它的线程。

### 5.2 第二段：扫共享列表，是把线程私域资源退回公共候选池

`ConcurrentBag.java:145-153`：

```java
for (T bagEntry : sharedList) {
   if (bagEntry.compareAndSet(STATE_NOT_IN_USE, STATE_IN_USE)) {
      if (waiting > 1) {
         listener.addBagItem(waiting - 1);
      }
      return bagEntry;
   }
}
```

共享列表路径说明：当本线程本地缓存里没有可用项时，借出链才退回公共候选池，用 CAS 从共享列表里抢一个 `NOT_IN_USE` 候选。

### 5.3 第三段：handoffQueue 不是“第四个池子”，而是直接移交通道

`ConcurrentBag.java:160-171`：

```java
listener.addBagItem(waiting);
timeout = timeUnit.toNanos(timeout);
do {
   final var start = currentTime();
   final T bagEntry = handoffQueue.poll(timeout, NANOSECONDS);
   if (bagEntry == null || bagEntry.compareAndSet(STATE_NOT_IN_USE, STATE_IN_USE)) {
      return bagEntry;
   }
   timeout -= elapsedNanos(start);
} while (timeout > 10_000);
```

handoffQueue 不是新的连接池层次，而是在没有空闲连接时，让归还线程把刚回来的连接直接交给正在等待的借出线程。

### 5.4 为什么三段路径必须按这个顺序

如果先扫共享列表，再查 ThreadLocal，本线程最近归还的热连接优势就没了；如果先阻塞等待 handoff，再扫共享列表，就会白白放弃当前已经存在的候选。所以三段顺序其实已经编码了 HikariCP 对“借出成本”的排序：

- 本地热连接最便宜
- 共享池候选次之
- 等待归还最贵

### 5.5 路标：`borrow()` 只负责把候选捞上来，还没给它发通行证

`ConcurrentBag.borrow()` 到这里解决的是“能不能拿到一个状态上可借的候选”，还没开始回答“这条候选是不是一条能交付的连接”。

## 六、驱逐门：`isMarkedEvicted()` 为什么放在借出链上

### 6.1 借到候选不代表它的生命周期还允许继续交付

`HikariPool.java:166` 的组合判断里，第一件事就是看：

```java
poolEntry.isMarkedEvicted()
```

这说明驱逐不是只发生在后台任务里，借出链本身也必须承担一道“生命周期合法性检查”。

### 6.2 为什么要在借出时再做一次驱逐判断

因为后台任务和借出线程是并发的。某条连接可能刚在后台被标记为应驱逐，但还没来得及完全清理出池。这时如果借出链不再补一刀检查，就可能把“已判死刑”的连接又重新交给业务线程。

### 6.3 驱逐失败后的动作不是报错，而是关闭候选并继续找

驱逐门后面的动作不是“整次借出立刻失败”，而是：

- 关闭当前候选
- 重新计算剩余时间
- 回到循环继续找下一条候选

这体现了 HikariCP 的一个很重要的取向：**坏的是候选，不一定是整次借出。**

### 6.4 路标：驱逐门过滤掉的是“不该继续活着的连接”

借出链上的第一道安全门，不是检查这条连接“现在能不能用”，而是先检查它“是不是已经不该再活着了”。

## 七、活性门：`isConnectionDead()` 为什么不是可有可无的附加检测

### 7.1 活性门解决的是“看起来在池里，实际上已经死了”的连接

`PoolBase.java:157`：

```java
boolean isConnectionDead(final Connection connection)
```

这道门服务的不是理论场景，而是现实世界里极常见的问题：数据库重启、网络闪断、防火墙闲置回收、云网络抖动，都会让一条“还在池里挂着”的连接实际上已经死掉。

### 7.2 活检前先缩短超时，是为了让验证失败尽快暴露

`PoolBase.java:160`：

```java
setNetworkTimeout(connection, validationTimeout);
```

这一步的意义很大：活性检测不该沿用正常业务请求的长超时，否则一条坏连接会在借出阶段把线程卡很久。HikariCP 先把网络超时切到 `validationTimeout`，验证完再恢复原值。

### 7.3 `isValid()` 和 `connectionTestQuery` 是两种不同的活检策略

`PoolBase.java:164-173`：

```java
if (isUseJdbc4Validation) {
   return !connection.isValid(validationSeconds);
}
try (var statement = connection.createStatement()) {
   statement.execute(config.getConnectionTestQuery());
}
```

这两条路径解决的是不同兼容性问题：

- `isValid()` 更现代，少一段 SQL 配置
- `connectionTestQuery` 更传统，但对驱动兼容性更宽

### 7.4 活检失败为什么不直接把异常抛给调用方

`isConnectionDead()` 捕获异常后返回 `true`，由借出链继续关闭候选、继续尝试下一个候选。也就是说，HikariCP 优先尝试把局部候选失败在池内部消化掉，而不是第一时间把故障传播给调用方。

### 7.5 路标：活性门过滤掉的是“还活着但已经死了的表象连接”

驱逐门解决“生命周期不合法”，活性门解决“物理连接已死亡”。两道门过滤的不是同一种坏连接。

## 八、旁路窗口：`aliveBypassWindowMs` 为什么敢跳过活检

### 8.1 旁路窗口不是偷懒，而是用时间局部性换性能

`HikariPool.java:62`：

```java
private final long aliveBypassWindowMs = Long.getLong(
   "com.zaxxer.hikari.aliveBypassWindowMs", MILLISECONDS.toMillis(500));
```

默认 500ms 的意思不是“500ms 内连接一定不死”，而是：如果一条连接刚被访问过，在这么短的窗口内再借出，它依然存活的概率非常高。

### 8.2 借出链真正判断的是“值不值得再花一次活检成本”

`HikariPool.java:166` 里的条件本质上是：

- 距上次访问太近 → 省掉一次活检
- 距上次访问够久 → 做活检再交付

所以旁路窗口不是取消安全门，而是在“高概率安全”的局部时间片里，暂时绕过昂贵检查。

### 8.3 旁路窗口的代价是接受极短时间内的误判风险

风险很明确：如果连接恰好在这个 500ms 窗口里死掉，借出链会把坏连接交出去。

但 HikariCP 接受这个风险，是因为：

- 窗口足够短
- 高频借出场景里每次都活检成本太高
- 失败最终仍会在业务调用或后续借出里被发现

### 8.4 路标：旁路窗口不是放弃安全，而是在局部时段里重排安全与成本

活性门和旁路窗口不是对立关系；它们是在一起定义“什么时候必须查，什么时候可以不查”。

## 九、交付前动作 + 最终交付：为什么真正的借出完成要等到代理连接创建成功

### 9.1 统计先记，是为了把借出耗时留在池内部

`HikariPool.java:171`：

```java
metricsTracker.recordBorrowStats(poolEntry, startTime);
```

这一步发生在代理交付之前，说明统计的是“池把连接交出来花了多久”，而不是“业务线程拿着连接用了多久”。它属于交付前动作，不直接生成连接对象，但会把借出链的成本留在池内监控里。

### 9.2 `beginRequest()` 是请求边界，不是借出本身的必要部分

`HikariPool.java:174`：

```java
if (isRequestBoundariesEnabled) {
   poolEntry.connection.beginRequest();
}
```

这说明 beginRequest 是一个可选增强：如果启用了 request boundaries，就在连接正式交付前打一个“请求开始”标记。它仍然属于“交付前准备”，而不是交付动作本身。

### 9.3 `createProxyConnection()` 才是借出链的真正终点

`HikariPool.java:179`：

```java
return poolEntry.createProxyConnection(leakTaskFactory.schedule(poolEntry));
```

这里同时做了两件事：

- 给这次借出挂上泄漏检测任务
- 把裸连接包装成代理连接

只有到这一行返回，连接才真正从“池内候选”变成“对外可用对象”。所以严格说，前两步是交付前动作，`createProxyConnection()` 才是最终交付门。

### 9.4 为什么代理连接是借出链不可缺的一门

没有代理，`close()` 就会直接变成物理关闭，归还链断掉；泄漏检测没有挂点；状态重置没有入口；池也就无法在调用方用完后重新接回控制权。

### 9.5 路标：交付动作和交付前准备要分开看

借出链真正最值钱的地方，不是把连接交出去，而是交出去以后控制权还没丢。`recordBorrowStats()` 和 `beginRequest()` 是交付前准备，`createProxyConnection()` 才是最终把连接对象交给调用方的那一步。

## 十、超时与失败：为什么整次借出失败不等于每个候选都失败在同一个地方

### 10.1 候选失败有很多种，但整次借出只认同一个预算

整次借出可能经历：

- 候选被驱逐
- 候选活检失败
- 候选创建代理失败
- 当前根本借不到候选

但这些局部失败共享的是同一个 `hardTimeout` 预算。

### 10.2 借出超时说明的是“在预算内没能形成一条完整交付链”

所以 `createTimeoutException(startTime)` 的含义，不是“池里完全没有连接”，而是：在这一段预算内，池没能把任何候选一路通过所有门，变成一条可交付代理连接。

### 10.3 借出失败最怕的不是报错，而是状态泄漏

对借出链来说，最危险的不是最终抛异常，而是中途已经把候选状态改成 `IN_USE`，却因为后续异常没能正确关闭、归还或移除。这样池就会慢慢“掉连接”。

### 10.4 路标：失败路径的核心不是“为什么报错”，而是“失败后状态怎么收口”

借出链的优秀与否，不只看成功路径快不快，也看失败路径会不会把状态留脏。

## 十一、失败路径：如果借出链某道门失效，会坏在哪里

### 11.1 池被挂起但借出线程继续冲进来

源码锚点：`HikariPool.java:154`

后果：借出线程失去统一入口门槛，挂起状态名存实亡。

如何避免：把 suspend/resume 作为借出链最前面的总闸门，而不是事后补救逻辑。

### 11.2 候选获取成功，但驱逐门没拦住已过期连接

源码锚点：`HikariPool.java:166`

后果：本该退场的连接又被重新交付，生命周期策略被破坏。

如何避免：借出时再补一刀 `isMarkedEvicted()`，不要只依赖后台线程清理。

### 11.3 活性门缺失，坏连接会直接流入业务线程

源码锚点：`PoolBase.java:157`

后果：池表面上借出成功，业务线程真正执行 SQL 时才报错，故障位置后移。

如何避免：把活检放在交付前，而不是等调用方自己撞错。

### 11.4 旁路窗口过大，会把优化变成风险放大器

源码锚点：`HikariPool.java:62`

后果：活检被跳过的时间片太长，坏连接被交付的概率上升。

如何避免：把 `aliveBypassWindowMs` 控制在足够短的范围内，让它只服务高频借出场景。

### 11.5 代理交付失败后没收口，池会慢慢丢连接

源码锚点：`HikariPool.java:179`

后果：候选已经从 Bag 里拿出来，但没成功交付给调用方，也没被正确回收，最终造成连接泄漏。

这里要分清两件事：正文这条更多是在提醒“借出链设计上最危险的状态泄漏点”，而不是说 HikariCP 当前源码已经明显留下了一个裸露漏洞。当前实现里，借出链整体是围绕“候选拿出后继续过门，失败则关闭或继续循环”来收口的；因此这一条更像是对借出链设计约束的反面镜像，而不是在指认一个现成的源码 bug。

如何避免：所有交付失败路径都要确保底层候选不是被归还，就是被关闭移除；也就是说，借出链上最重要的不是“最终有没有报错”，而是“任何报错后状态有没有回到池能继续管理的范围里”。

### 11.6 借出超时被误读成“数据库完全不可用”

源码锚点：`HikariPool.java:184`

后果：排障方向被带偏。实际上可能只是预算内一直拿到坏候选，或者池被挂起，或者活检过慢。

如何避免：把借出超时理解成“完整交付链没在预算内闭合”，不要把它简单等同为“数据库挂了”。

## 十二、收网：为什么 `borrow()` 不是终点，代理交付才是终点

| 章节 | 核心收获 |
|------|---------|
| 困惑开场 | `getConnection()` 是一次高频过闸，而不是简单取对象 |
| 三个方案 | 容器式取连接、Bag 成功即结束、直接交裸连接都不成立 |
| 入口层 | `HikariDataSource` 先解决“怎么进入池” |
| 编排中心 | `HikariPool.getConnection(long)` 带着整次预算编排借出 |
| 状态门 | `suspendResumeLock` 决定当前允不允许借 |
| 候选获取门 | `ConcurrentBag.borrow()` 负责把候选捞上来 |
| 驱逐门 | 过滤掉生命周期上已不该继续交付的连接 |
| 活性门 | 过滤掉物理上已经死亡的连接 |
| 旁路窗口 | 在极短时间片里用局部性换掉部分活检成本 |
| 交付门 | 代理连接创建成功，借出链才真正闭合 |
| 失败路径 | 借出失败最怕的不是报错，而是状态收口失败 |

现在再回头看最开始那一行：

```java
Connection connection = dataSource.getConnection();
```

调用方看到的是“一次取连接”，池内部经历的却是一整条链：

- `HikariDataSource` 决定怎么进入池
- `HikariPool` 决定怎么在预算内组织这次借出
- `ConcurrentBag` 决定候选从哪里来
- 驱逐门和活性门决定候选能不能继续往下走
- 代理交付门决定连接交出去以后池还能不能继续掌握控制权

所以这篇真正立住的结论只有一句：**借出链不是“拿到候选”就完成，而是“候选一路穿过所有门，最后以代理连接形态被安全交付”才完成。**

如果把它再压缩成一句更工程化的话，就是：`getConnection()` 的目标从来不是“尽快返回某个对象”，而是“在固定预算内返回一条仍可被池继续控制的安全连接”。这也是为什么借出链里会同时出现状态门、候选门、驱逐门、活性门和代理交付门——少掉任何一门，返回对象这件事也许更快了，但“连接池”就会逐步退化成“连接容器”。

再回看 Ch1 的生命史主线，这一篇其实是在把“使用中”阶段展开成源码级动作：连接不是一借出就完事了，而是从进入池、选候选、过安全门、挂泄漏任务、创建代理开始，正式进入“被应用持有但仍受池控制”的中间阶段。只有把这一段讲清楚，下一篇的归还链才有真正的落点。

换句话说，Ch1 讲的是“连接这一生有哪些阶段”，Ch2 讲的是“连接从池内候选变成业务线程手里那条代理连接时，到底经历了哪些门”。这两篇合在一起，生命史的前半段才算真正闭合。

## 十三、下篇桥接

下一篇 [03 — close() 为什么不是关闭连接（归还与驱逐）](../ch3-return-evict/01-return-and-eviction.md) 将回答：借出去的代理连接为什么在 `close()` 时不关闭物理连接，而是触发状态重置、泄漏任务取消、`PoolEntry.recycle()` 和 `ConcurrentBag.requite()`；以及一条连接在归还链上又是如何分叉进入“正常回池”或“应该驱逐”的。
