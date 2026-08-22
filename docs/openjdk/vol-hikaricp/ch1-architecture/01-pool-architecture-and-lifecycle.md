# 01. 为什么 HikariCP 不是"存连接的池子"，而是一条连接生命史管理链

> **前置依赖**: 无（第一卷第一篇，假设读者了解 JDBC DataSource 和 getConnection 基本语义）
> → **后续**: [02 — 一次 getConnection() 的借出链](../ch2-borrow-path/01-getconnection-borrow-path.md)
> 关联域：03-return-evict(归还链)、04-concurrentbag(存储层)、05-housekeeper(生命周期)

## 困惑：连接池不就是"存连接、拿连接、还连接"吗？

第一次接触连接池的人，脑子里最容易出现的图景其实很朴素：

```java
// 先创建一批连接
List<Connection> pool = new ArrayList<>();
for (int i = 0; i < 10; i++) {
    pool.add(DriverManager.getConnection(url, user, pass));
}
// 需要时拿一个
Connection conn = pool.remove(0);
// 用完放回去
pool.add(conn);
```

这个模型当然不能说错，它至少抓到了连接池存在的基本目的：避免每次请求都重新创建物理连接。创建一条 JDBC 连接涉及 TCP 三次握手、MySQL 认证、权限检查，耗时通常在 10-100ms 级别。如果每次 HTTP 请求都创建新连接，光连接建立的时间就占了大部分响应时间。

但如果继续往下看 HikariCP 源码，就会很快发现，这个理解只描述了一个表面动作，却完全解释不了池子真正复杂的部分。因为只要系统真的开始运行，就立刻会冒出一串"光靠一个容器装连接"根本解释不了的问题：

- 配置在什么时候被冻结，为什么池启动后不能随便改。如果运行中改了 `maxPoolSize`，池是按新值扩容还是维持旧值？
- 第一个连接是怎么验证的，失败时为什么有三种策略（立即失败/尝试一次/跳过）
- 借出连接前为什么要判断它是否失效、是否刚刚被归还。`aliveBypassWindow` 是什么？
- 空闲连接为什么还要 keepalive，不是已经空闲了吗。MySQL 的 `wait_timeout` 默认 8 小时，空闲连接会被数据库主动断开
- maxLifetime 为什么不是硬切，而要加随机抖动避免雪崩。如果 100 个连接同时到达 30 分钟寿命，数据库会同时收到 100 个连接创建请求
- 后台为什么还要有一个 HouseKeeper 周期性巡检。连接池不是"创建即忘"，而是一个持续运行的守护系统

## 一、三个直觉方案为什么都不理想

### 方案一：连接池就是一个装 JDBC Connection 的容器

这是最自然的直觉，因为"池"这个词本身就会诱导人往容器模型上想。JDBC 连接池看起来就是"先创建一批连接，放进池子里，借出时拿一个，归还时放回"。

```java
class NaivePool {
    List<Connection> pool = new ArrayList<>(10);
    NaivePool() {
        for (int i = 0; i < 10; i++)
            pool.add(createConnection());
    }
    synchronized Connection get() {
        return pool.remove(pool.size() - 1);
    }
    synchronized void put(Connection c) {
        pool.add(c);
    }
}
```

#### 为什么不行：三步各有致命缺陷

**第一步——创建连接的时机**：如果启动时一口气创建 10 条物理连接，而应用冷启动时根本用不到这么多，就白白浪费了数据库连接资源。如果惰性创建，又需要处理并发下重复创建的问题。HikariCP 用 `fillPool()` + `checkFailFast()` 的组合策略解决：启动时按 `initializationFailTimeout` 的语义决定是否立即创建第一条连接。

**第二步——借出的并发安全**：这个方案的 `synchronized` 关键字让所有 `get()` 串行执行。高并发下，1000 个线程同时 `get()`，只能排队拿锁。连接池越大，锁竞争越激烈，吞吐量反而下降。HikariCP 的 `ConcurrentBag` 用 ThreadLocal + CAS + handoffQueue 三层结构，把绝大多数借出从有锁路径变成无锁路径（Ch4 展开）。

**第三步——归还的状态**：随手 `pool.add(c)` 把连接原样放回，没有处理"连接上残留了上个事务的状态"。如果上个调用者开启了一个未提交事务（`setAutoCommit(false)`），归还后下个调用者拿到的连接还带着这个事务状态，造成数据污染。HikariCP 用 `dirtyBits` 位掩码追踪连接状态是否被修改，归还时按需重置（Ch3 展开）。

#### 真正的失败点：容器模型没有"连接活性"概念

这个方案假设池里的连接永远可用。但真实世界里连接会死：数据库重启、网络超时、MySQL `wait_timeout` 断开空闲连接。容器模型拿到一条死连接，交给调用方，调用方执行 SQL 才报错——错误从数据库层传播到应用层，中间没有任何防护。HikariCP 必须在借出前检查 `isConnectionDead()`（`PoolBase.java:157`）。

### 方案二：HikariDataSource 只是 DataSource 的薄壳

外部使用者最常见的接触点是 new `HikariDataSource` → 配置 URL/用户名/密码 → `getConnection()`。因此很容易形成一个印象：`HikariDataSource` 只是薄薄的入口，真正重要的都在 `HikariPool` 里。

```java
HikariDataSource ds = new HikariDataSource();
ds.setJdbcUrl("jdbc:mysql://localhost:3306/test");
ds.setUsername("root");
ds.setPassword("root");
Connection conn = ds.getConnection();
```

#### 为什么不行：它承担了初始化和快路径两个关键职责

**初始化职责**：`HikariDataSource(HikariConfig)` 构造器（`HikariDataSource.java:74`）里调用 `configuration.validate()` → `configuration.copyStateTo(this)` → `new HikariPool(this)` → `configuration.seal()`。这段逻辑决定了池是"立即创建"还是"惰性创建"，直接影响了 fail-fast 语义。如果 `HikariDataSource` 只是薄壳，这个初始化时序就没有归属。

**快路径职责**：`HikariDataSource.java:92` 的 `getConnection()` 里，`fastPathPool != null` 时直接走快路径（`:98`），跳过 `pool == null` 检查。这里要分清两个字段：`fastPathPool` 是 `final HikariPool`（`HikariDataSource.java:46`），表示“构造时就已经准备好的快路径池”；`pool` 才是 `volatile HikariPool`（`HikariDataSource.java:47`），负责承接惰性初始化分支。这个分工消除了常见路径上反复判断 `pool == null` 的开销。

### 方案三：各种优化点只是零散技巧

HikariCP 很容易让人被一堆很亮眼的优化细节吸引：

- `fastPathPool` — 入口优化
- `ConcurrentBag` — 无锁存储与借还（Ch4 展开）
- `AtomicIntegerFieldUpdater` — 代替 AtomicInteger 减少对象分配
- `aliveBypassWindow` — 高频借出时跳过验证（Ch2/Ch6 展开）
- `maxLifetime` 随机抖动 — 防止雪崩
- `HouseKeeper` — 后台巡检维护（Ch5 展开）

#### 为什么不行：它们都在服务同一条主线

如果把这些都看成离散优化点，就会失去更重要的视角——它们并不是彼此独立的 tricks，它们都在服务同一个总目标：让连接生命史既高效，又正确，还能长期稳定地持续下去。

更具体的说：`fastPathPool` 服务"接入"环节，`ConcurrentBag` 服务"存储与借还"环节，`aliveBypassWindow` 服务"验证"环节，`maxLifetime`/`keepaliveTime`/`idleTimeout` 服务"生命周期"环节，`HouseKeeper` 服务"后台维护"环节。只有把所有这些看成"连接生命史"的不同阶段，才能理解它们为什么都是必要的。

## 核心设计

**HikariCP 真正管理的不是"连接放在哪"，而是"连接这一生怎么被创建、借出、归还、维持、淘汰和退场"。**

## 总图：HikariCP 的最小骨架

```
[策略源头]                [应用入口]                [运行时中心]
HikariConfig ──────────→ HikariDataSource ────────→ HikariPool
  │ maxLifetime               │                       │
  │ keepaliveTime              │ 持有池实例              ├── ConcurrentBag（存储与借还）
  │ idleTimeout               │ 快路径优化              ├── HouseKeeper（后台巡检）
  │ initializationFailTimeout  │ seal() 后冻结配置       ├── maxLifetime 调度
  │ seal()                     │                       ├── keepalive 调度
  └─ checkIfSealed()           └─ fastPathPool          └── PoolEntry 生命周期
```

这张图最重要的价值，不是让读者背类名，而是先把三个问题分开：策略从哪来（Config）、入口在哪（DataSource）、运行时中心是谁（Pool）。

## 二、HikariConfig 策略字段：maxLifetime、keepaliveTime、idleTimeout 如何定义生命史

### 2.1 maxLifetime：连接最多活多久

`HikariConfig.java:67`：

```java
private volatile long maxLifetime;  // 默认 30 分钟
```

`HikariConfig.java:122` 设置默认值：`maxLifetime = MAX_LIFETIME`（30 分钟）。`HikariConfig.java:237` 提供 getter `getMaxLifetime()`。

#### 为什么默认 30 分钟

`maxLifetime` 的默认值 30 分钟是平衡"连接复用效率"和"连接新鲜度"的结果：太短会让连接频繁重建，太长会让连接长期不接触数据库的最新配置。`setMaxLifetime()` 可以覆盖默认值，但 `HikariConfig.java:242` 之后会校验 `maxLifetime` 不能小于 `idleTimeout` 等约束。

#### 为什么需要随机抖动（设置值只是基础）

`maxLifetime` 不是设成固定值就完事。`HikariPool.java:493` 计算连接的随机过期时间（`maxLifetime / lifeTimeVarianceFactor` 的方差），`:495` 调度 `MaxLifetimeTask`。如果不加抖动，100 个连接同时到达 30 分钟寿命，同时断开、同时重连，数据库会突收 100 个连接创建请求，这是雪崩。

### 2.2 keepaliveTime：空闲连接为什么还要保活

`HikariConfig.java:102`：

```java
private long keepaliveTime;  // 默认值来自 DEFAULT_KEEPALIVE_TIME
```

`HikariConfig.java:128` 设置默认值 `keepaliveTime = DEFAULT_KEEPALIVE_TIME`，而 `DEFAULT_KEEPALIVE_TIME` 定义在 `HikariConfig.java:55`，默认是 **2 分钟**，不是 0。

#### 为什么默认值是 2 分钟，但运行时不一定真的启用

这里最容易误读。源码的“字段默认值”确实是 2 分钟，但这不等于“最终运行时一定开启 keepalive”。真正落地前还要经过 `validate()` 的约束整理：

- 如果 `keepaliveTime < 30s`，在 `HikariConfig.java:1109` 会被直接禁用
- 如果 `keepaliveTime >= maxLifetime`，在 `HikariConfig.java:1115` 也会被禁用
- 只有在约束关系成立时，这个默认值才会继续进入 `KeepaliveTask` 的调度逻辑

所以准确说法不是“默认 0，不启用”，而是：**字段默认值是 2 分钟，但是否真正生效，取决于 `validate()` 后它是否还能保留下来。**

keepalive 的职责也不是“无脑每隔两分钟 ping 一下”，而是只对 NOT_IN_USE 状态的空闲连接做保活检查，不打扰正在使用的连接。

### 2.3 initializationFailTimeout：启动时划不划算失败

`HikariConfig.java:74`：

```java
private long initializationFailTimeout;  // 默认 1ms
```

三种语义（`HikariPool.java:567` 的 `checkFailFast()` 中体现）：

- **> 0**（默认 1ms）：尝试创建连接，失败后隔 1 秒重试，直到超时。超时后抛 `PoolInitializationException`，应用启动失败。这是最安全最严格的模式。
- **= 0**：尝试一次，成功就返回，失败不重试。不阻塞启动，但首次 `getConnection()` 可能失败。
- **< 0**（-1）：跳过 `checkFailFast()`，`HikariPool` 构造时不创建任何连接。第一次 `getConnection()` 时才惰性创建。这是最宽松但最危险的模式——数据库宕机时应用启动完全不受影响，但运行时才暴露。

### 2.4 validate()：配置字段不是自由组合

`HikariConfig.java:1045`：

```java
public void validate()
```

`validate()` 不是在做格式检查那么简单，它是在把看起来彼此独立的参数收束成一组能一起工作的运行时约束。源码里最关键的几条不是“值有没有填”，而是“这些值放在一起会不会互相打架”。

第一组约束来自 `maxLifetime`。`HikariConfig.java:1103` 明确把小于 30 秒的值直接改回默认值：

```java
if (maxLifetime != 0 && maxLifetime < SECONDS.toMillis(30)) {
    LOGGER.warn("{} - maxLifetime is less than 30000ms, setting to default {}ms.", poolName, MAX_LIFETIME);
    maxLifetime = MAX_LIFETIME;
}
```

这段逻辑说明一个事实：HikariCP 不接受“极短寿命连接池”这种配置幻想。因为一条连接的创建、认证、预热、借出，本身就需要成本。如果生命周期短到几十秒以内，连接还没充分复用，就已经进入驱逐周期，整个系统会退化成“频繁新建连接”的坏状态。

第二组约束来自 `keepaliveTime`。`HikariConfig.java:1109` 和 `HikariConfig.java:1115` 连续做了两层修正：

```java
if (keepaliveTime != 0 && keepaliveTime < SECONDS.toMillis(30)) {
    LOGGER.warn("{} - keepaliveTime is less than 30000ms, disabling it.", poolName);
    keepaliveTime = 0L;
}
if (keepaliveTime != 0 && maxLifetime != 0 && keepaliveTime >= maxLifetime) {
    LOGGER.warn("{} - keepaliveTime is greater than or equal to maxLifetime, disabling it.", poolName);
    keepaliveTime = 0L;
}
```

这里的核心不是“keepalive 默认多少”，而是“保活必须发生在连接寿命之内，而且频率不能高到本身变成负担”。如果 `keepaliveTime >= maxLifetime`，连接还没等到一次保活就该退场了；如果 keepalive 小到几十秒，后台线程就会不停唤醒，对数据库发送无意义探活。

第三组约束来自 `idleTimeout` 与 `maxLifetime` 的关系。`HikariConfig.java:1141`：

```java
if (idleTimeout + SECONDS.toMillis(1) > maxLifetime && maxLifetime > 0 && minIdle < maxPoolSize) {
    LOGGER.warn("{} - idleTimeout is close to or more than maxLifetime, disabling it.", poolName);
}
```

这段检查强调了一个常被忽略的点：`idleTimeout` 和 `maxLifetime` 都是“退场条件”，但它们管的不是一回事。`idleTimeout` 管“空闲太久”；`maxLifetime` 管“总寿命太长”。如果 idleTimeout 已经接近 maxLifetime，那么前者几乎没有独立意义，连接总会先被寿命策略带走。

### 2.5 路标：这三个字段决定了连接的一生

maxLifetime 决定连接最多活多久，keepaliveTime 决定空闲连接多久保活一次，initializationFailTimeout 决定启动时拿不到连接是否要启动失败。`validate()` 再把这些配置约束成能同时成立的一组运行时规则。到这里，连接生命史的“政策层”才算真的立住。

## 三、HikariConfig seal 机制：为什么池启动后配置不能改

### 3.1 sealed 字段：一个 boolean 冻结一切

`HikariConfig.java:104`：

```java
private volatile boolean sealed;
```

`HikariConfig.java:1154` 的 `checkIfSealed()` 是所有 setter 的运行时边界：

```java
private void checkIfSealed() {  // HikariConfig.java:1154
    if (sealed)
        throw new IllegalStateException("The configuration of the pool is sealed once started. Use HikariConfigMXBean for runtime changes.");
}
```

`HikariConfig.java:1156` 的异常信息很关键：提示用 `HikariConfigMXBean` 做运行时修改。

#### 为什么需要 seal

池启动后，正在运行的 `HikariPool` 已经基于初始配置创建了连接、注册了后台任务（HouseKeeper、MaxLifetimeTask、KeepaliveTask）。如果此时 `maxLifetime` 被改了，正在排队的 `MaxLifetimeTask` 用的还是旧值，调度逻辑就会混乱。seal 机制保证配置在启动后冻结，防止运行时状态与配置不一致。

### 3.2 seal() 的调用时机

`HikariConfig.java:1010`：

```java
void seal() {
    this.sealed = true;
}
```

从当前源码看，`seal()` 的直接调用都发生在 `HikariDataSource` 侧，而不是 `HikariPool` 内部：一个是在 `HikariDataSource(HikariConfig)` 构造器末尾的 `this.seal()`（`HikariDataSource.java:83`），另一个是在无参构造 + 首次惰性初始化分支里的 `this.seal()`（`HikariDataSource.java:112`）。也就是说，冻结配置的动作是跟着“DataSource 完成池创建”发生的，而不是由 `HikariPool` 自己额外再调一次。 

### 3.3 copyStateTo()：为什么不是把 config 直接塞给 pool

`HikariConfig.java:1021`：

```java
public void copyStateTo(HikariConfig other)
```

这一步很容易被忽略，但它其实解释了 HikariCP 配置模型的一个基本立场：**配置对象是“启动时的策略模板”，不是运行时共享状态中心。**

如果 `HikariDataSource` 和 `HikariPool` 只是一直引用最初那个 `HikariConfig`，那么后续任何外部对象只要还握着这个 config 的引用，就有可能绕过预期边界去影响运行中池子的行为。`copyStateTo()` 的存在，意味着运行时对象拿到的是一份状态快照，而不是一个可被任意外部继续摆弄的共享盒子。

这件事和 `seal()` 配合起来看才完整：`copyStateTo()` 负责把启动时配置散发到运行时对象，`seal()` 负责把原始模板封口。一个负责复制，一个负责封边。

### 3.4 哪些配置还能热改

`HikariConfigMXBean` 暴露了少量可热改属性：`maximumPoolSize`、`minimumIdle`、`leakDetectionThreshold`、`idleTimeout` 等。这些属性之所以能热改，是因为它们对应的是运行中的“调节参数”，而不是“物理连接身份”。

但 `jdbcUrl`、`username`、`password`、`catalog` 这种连接身份属性一旦启动就不可改——因为池已经持有了一批依据旧参数创建出的物理连接。如果运行中把 `jdbcUrl` 从 A 库改成 B 库，而池里旧连接还活着，整个系统会出现同一个 DataSource 混用两组物理后端的灾难性状态。

### 3.5 路标：sealing 不是反对运行时管理，而是定义边界

sealing 与 runtime management 不是对立的：`HikariConfigMXBean` 支持部分热改，但核心连接属性在启动后冻结。这个边界决定了池的运行时控制策略——什么能改、什么不能改、改了什么后果如何。

## 四、HikariDataSource 构造与初始化：入口的两种模式

### 4.1 构造器：验证、复制、创建池、冻结

`HikariDataSource.java:74`：

```java
public HikariDataSource(HikariConfig configuration) {
    configuration.validate();      // 验证配置完整性
    configuration.copyStateTo(this); // 复制配置到 DataSource
    pool = new HikariPool(this);   // 立即创建池
    configuration.seal();          // 冻结配置
}
```

#### 为什么 copyStateTo 而不是直接引用 configuration

`copyStateTo` 把 `HikariConfig` 的字段复制到 `HikariDataSource` 内部的 `<name>Holder` 字段，这样 `HikariDataSource` 的 getter 直接返回字段值，不依赖外部 `HikariConfig` 实例是否被修改。`validate()` 校验配置的完整性（如 maxPoolSize 必须 >= 1、maxLifetime 必须 > 0 等）。

### 4.2 getConnection() 的两种路径

`HikariDataSource.java:92`：

```java
public Connection getConnection() throws SQLException {
    if (fastPathPool != null) {           // HikariDataSource.java:98
        return fastPathPool.getConnection(...);
    }
    if (pool == null) {
        pool = new HikariPool(this);      // 首次调用才创建池
    }
    return pool.getConnection(...);
}
```

#### 快路径 vs 惰性初始化

`fastPathPool` 是 `volatile HikariPool`（`HikariDataSource.java:47`），非空时直接走快路径，跳过 `pool == null` 检查。

在 HikariCP 1.x 时代，`getConnection()` 每次都检查 `if (pool == null) pool = new HikariPool()`，CreatePool 的泛型擦除和检查增加开销。fastPathPool 就是为了消除这个慢路径。

### 4.3 为什么 fastPathPool 要和 pool 分开

`HikariDataSource.java:46-47`：

```java
private final HikariPool fastPathPool;
private volatile HikariPool pool;
```

`fastPathPool` 和 `pool` 同时存在，不是重复字段，而是为了把“构造时就已经确定的池”和“可能惰性初始化的池”区分开。

- 如果调用的是 `HikariDataSource(HikariConfig)`，那么构造器里已经创建出 `new HikariPool(this)`，此时 `pool = fastPathPool = new HikariPool(this)`（`HikariDataSource.java:80`）
- 如果调用的是无参构造，`fastPathPool = null`（`HikariDataSource.java:61`），意味着第一次 `getConnection()` 前并没有池可走快路径

这样一来，`getConnection()` 就能在“确定已经有池”的路径上少做一次判断，把最常见路径变成最短路径。

### 4.4 为什么 pool 还要是 volatile

`HikariDataSource.java:47`：

```java
private volatile HikariPool pool;
```

`volatile` 保证多线程下 `getConnection()` 能看到已初始化的池。如果没有 volatile，一个线程调用 `getConnection()` 后创建了池，但另一个线程可能仍看到旧值 `null`，于是重复进入创建逻辑。源码在 `HikariDataSource.java:105` 之后还配合了 `synchronized (this)`，把“先读快路径、再退回慢路径、最后在锁内二次检查”的模式拼完整：

- 先看 `fastPathPool`
- 再看 `pool`
- 最后必要时进同步块创建

这本质上是在做一个简化版的双重检查初始化。

### 4.5 路标：入口的快路径与惰性初始化

`HikariDataSource` 不只是薄壳，它承担了入口优化（fastPathPool）和初始化策略（立即 vs 惰性）。`HikariDataSource.java:98` 的 fastPathPool 快路径消除 `pool == null` 检查的开销，`volatile` 保证多线程可见性。

## 五、HikariPool 运行时中心：checkFailFast、HouseKeeper、createPoolEntry

### 5.1 构造与 fail-fast

`HikariPool.java:52`：

```java
// HikariPool.java:97
checkFailFast();  // 启动时校验
```

`checkFailFast()`（`HikariPool.java:567`）尝试创建第一个连接，如果 `initializationFailTimeout > 0` 且失败，抛异常阻止应用启动。`initializationFailTimeout` 的三种语义在这里体现。

### 5.2 HouseKeeper 注册：后台巡检

`HikariPool.java:118`：

```java
this.houseKeeperTask = houseKeepingExecutorService.scheduleWithFixedDelay(
    new HouseKeeper(), 100L, housekeepingPeriodMs, MILLISECONDS);
```

#### HouseKeeper 的三个职责

HouseKeeper（`HikariPool.java:793`）周期性巡检，执行三类操作：idleTimeout 淘汰空闲连接、maxLifetime 驱逐过期连接、fillPool 补充连接。它还检测时钟回拨（`HikariPool.java:816`）。

### 5.3 createPoolEntry：连接创建的完整流程

`HikariPool.java:485`：

```java
private PoolEntry createPoolEntry() { ... }
```

`createPoolEntry` 做四件事：通过 DataSource 创建物理连接 → 执行 connectionInitSql（如果配置了）→ 包装为 PoolEntry → 加入 ConcurrentBag。此外还调度 MaxLifetimeTask（`:493` 计算方差、`:495` 调度）和 KeepaliveTask（`:503` 调度）。

#### createPoolEntry 里真正昂贵的部分是什么

昂贵的不是 new 一个 `PoolEntry` 对象，而是背后的物理连接初始化链：

- DataSource 拿到 JDBC Connection
- `PoolBase.setupConnection()` 设置 autoCommit、readOnly、transactionIsolation、catalog、schema
- 如果启用了网络超时、验证查询、初始化 SQL，还要继续执行一串驱动调用

所以 `createPoolEntry()` 虽然在源码里只有几十行，但它代表的是整条“物理连接出生链”。这也是为什么 HikariCP 把借出路径极度优化、而把连接创建看成必须尽量少发生的慢路径。

#### createPoolEntry 和后续章节的关系

这一篇只先把 `createPoolEntry()` 作为生命周期起点立住，不展开每个 JDBC 初始化细节。后续如果写到 `PoolBase` 或 connection setup，再去拆驱动参数怎样落到物理连接上。这里先抓住一个主结论：**连接一旦出生，就已经同时挂上了退场任务（maxLifetime）和保活任务（keepalive）**。

### 5.4 fillPool()：为什么不是想补多少就补多少

`HikariPool.java:525`：

```java
private synchronized void fillPool(final boolean isAfterAdd)
```

`fillPool()` 的同步关键字非常重要。它说明“补池”这件事必须串行判断，而不能让多个线程同时看到“池子不够”然后并发补同一批连接。否则最容易出现的就是超配：本来只差 2 条连接，结果 5 个线程都触发了补池，各自创建 2 条，瞬间超出 `maximumPoolSize`。

`fillPool()` 的职责不是“尽可能多建连接”，而是“在 minIdle 和 maximumPoolSize 的边界内补齐缺口”。这让它天然成为一个慢路径协调器，而不是高频路径的一部分。

### 5.5 路标：Pool 是生命史的运行中心

HikariPool 不是"池子的某个实现类"，而是连接生命史真正被组织起来的运行时中心。checkFailFast、HouseKeeper、createPoolEntry 分别对应"启动校验"、"后台巡检"、"连接创建"三个关键环节。只要这个视角立住，前面那些看起来零散的优化点就一下子归位了。

### 5.6 补充展开：HouseKeeper 为什么是运行时中心的一部分

#### 5.6.1 HouseKeeper 不是“附加线程”，而是生命史的后半段执行器

`HikariPool.java:793`：

```java
private final class HouseKeeper implements Runnable
```

很多人第一次看到 HouseKeeper，会把它理解成“一个定时清理线程”。这个理解太轻了。更准确地说，HouseKeeper 是连接生命史后半段的执行器：连接一旦被归还，之后是继续活着、进入保活、因为太闲被淘汰、因为太老被驱逐，基本都靠它持续推进。

也就是说，借出链只解释了“连接怎样交到调用方手里”，而 HouseKeeper 解释的是“连接还回来以后谁继续管它”。

#### 5.6.2 时钟回拨检测：为什么池还要关心系统时间

`HikariPool.java:816`：

```java
if (plusMillis(now, 128) < plusMillis(previous, housekeepingPeriodMs)) {
```

这段代码常被一扫而过，但它很能说明 HikariCP 的工程立场：**生命周期调度强依赖时间，而时间本身不总是可靠。**

如果系统时钟被手动回拨、NTP 校准突然拉回、虚拟机宿主机时间异常，那么基于“上次巡检时间 + 周期”的各种判断都会失真。轻则空闲连接晚一点淘汰，重则一批本该过期的连接长时间继续存活。

HikariCP 没有假装“时间一定单调递增”，而是显式把这个不确定性纳入处理逻辑。对一个长期运行的池来说，这不是边角料，而是稳定性的一部分。

#### 5.6.3 fillPool(true)：巡检线程为什么还要负责补连接

`HikariPool.java:845`：

```java
fillPool(true); // Try to maintain minimum connections
```

这说明 HouseKeeper 不是纯粹的“回收者”，它还是“补给者”。回收和补给必须在同一条后台链上统一协调，否则会出现一个很常见的问题：

- 前半分钟回收了一批空闲连接
- 另一边业务低峰刚结束，马上又需要补到 `minimumIdle`
- 如果没有统一执行者，回收线程和补连接线程会互相打架

HouseKeeper 把“看池子整体状态后决定下一步动作”的职责接住，避免不同后台逻辑各自为战。

#### 5.6.4 路标：HouseKeeper 负责连接归还之后的命运分流

只要连接回到池里，后面是继续躺着、被保活、被淘汰、被补位，基本都进入 HouseKeeper 的治理范围。到这里，HikariCP 已经不是“借和还”的故事，而是“归还之后仍持续被管理”的故事。

## 六、控制节点：fail-fast / sealing / maxLifetime / keepalive 的同一条主线

### 7.1 fail-fast：生命史能不能立住

fail-fast（`checkFailFast()`，`HikariPool.java:567`）决定连接生命史在启动时能不能立住。`initializationFailTimeout > 0` 时首次连接失败直接抛异常；`= 0` 时尝试一次就放弃；`< 0` 时跳过校验。

### 7.2 sealing：运行边界不能再改

sealing（`seal()`/`checkIfSealed()`，`HikariConfig.java:1010/1154`）决定连接生命史的哪些边界在启动后不再可变。`HikariConfigMXBean` 只暴露部分可热改属性，其他 setter 在 `sealed = true` 后抛异常。

### 7.3 maxLifetime + 抖动：避免雪崩

maxLifetime（`HikariConfig.java:67`）决定连接最长活多久。`HikariPool.java:493` 计算随机方差、`:495` 调度 MaxLifetimeTask，让每个连接的到期时间在 `[0.5*maxLifetime, maxLifetime]` 随机分布，避免大量连接同时到期。

### 7.4 keepalive：空闲连接保活

keepaliveTime（`HikariConfig.java:102`）决定空闲连接定期保活。`KeepaliveTask`（`HikariPool.java:503` 调度）只对 NOT_IN_USE 状态的空闲连接执行，不打扰正在使用的连接。

### 7.5 路标：4 个控制节点负责“规则切换”，HouseKeeper 负责“规则执行” 

fail-fast 管出生、sealing 管边界、maxLifetime 管退场、keepalive 管保活；HouseKeeper 不再单列为“规则本身”，而是这些规则在后台持续落地的执行者。这样分开之后，控制节点和运行时执行层的边界就清楚了。

## 七、连接状态机：借出、归还、驱逐的完整生命周期

### 7.1 连接状态转换

一条连接在池中的完整状态机：

```
新连接创建 → PoolEntry
  → 加入 ConcurrentBag（NOT_IN_USE）
  → 被借出（IN_USE）→ 交付调用方
  → 调用方 close() → 归还（NOT_IN_USE）
  → 或超过 maxLifetime → 被驱逐（REMOVED）
  → 或 idleTimeout 过期 → softEvictConnection
  → 池关闭 → 物理连接关闭
```

### 7.2 每个状态转换的源码入口

- `NOT_IN_USE`：ConcurrentBag 中空闲状态
- `IN_USE`：`borrow()` CAS 转换（`ConcurrentBag.java:140/149/164`）
- `NOT_IN_USE`（归还）：`requite()` 转换（`ConcurrentBag.java:189`）
- `REMOVED`：驱逐时 `closeConnection()` 标记

### 7.3 状态机与三个时间参数的关系

| 参数 | 触发时机 | 状态转换 |
|------|---------|---------|
| maxLifetime | 连接存活超过设置值 | NOT_IN_USE → REMOVED（驱逐）|
| idleTimeout | 连接空闲超过设置值 | NOT_IN_USE → REMOVED（淘汰）|
| keepaliveTime | 到保活周期 | NOT_IN_USE 保活验证 |

### 8.4 并发视角下的状态转换为什么必须收敛

从状态机角度看，最危险的不是状态多，而是多个线程同时试图改同一条连接的状态。比如：

- 一个业务线程正准备归还连接
- HouseKeeper 正好想淘汰它
- KeepaliveTask 正好准备探活它

如果没有一个统一的状态门槛，连接就可能出现重复关闭、已归还又被继续使用、刚保活完马上被驱逐之类的竞态。

`ConcurrentBag` 的状态常量（`ConcurrentBag.java:83-86`）和 CAS 转换（`:140`、`:149`、`:164`、`:240`、`:308`、`:320`）就是在干这件事：把“能不能从 A 变到 B”收敛为原子判断，而不是靠调用者彼此礼让。

### 8.5 路标：连接的一生是状态机的每一次转换

理解了状态机，再看 HikariCP 的所有机制：borrow/requite 管借还，maxLifetime/idleTimeout 管驱逐，HouseKeeper 管巡检。每条连接的一生就是这些状态之间的一次次转换。到这里，连接生命史已经从“概念比喻”落成了源码里的状态流转。

## 八、失败路径：如果把生命史控制点拿掉，会坏在哪里

### 9.1 启动期失败：没有 fail-fast，坏库会带着应用一起上线

**源码锚点**：`HikariPool.java:567`

如果把 `checkFailFast()` 拿掉，或者总是把 `initializationFailTimeout` 设成负数，那么数据库不可用时，应用依然能正常启动。看起来这像是“提升了可用性”，实际上只是把失败从启动期推迟到了流量期。

后果是：容器健康检查通过、服务成功注册、监控看起来一切正常，但第一波真实请求进来才在 `getConnection()` 报错。失败不再集中地暴露在一个明确的启动点，而是分散到业务线程里，让排障成本成倍上涨。

如何避免：对核心数据库依赖服务，优先使用 `initializationFailTimeout > 0` 的 fail-fast 模式，把“数据库根本不可连”拦在启动阶段，而不是放进流量期再炸。

### 9.2 配置期失败：没有 sealing，池会变成半旧半新的混合体

**源码锚点**：`HikariConfig.java:1010`、`HikariConfig.java:1154`

如果没有 `seal()` / `checkIfSealed()`，运行中的池就可能处于一种最糟糕的中间态：老连接按旧参数创建，新任务按新参数调度，而调用方却以为整个池已经“切换完成”。

这种状态比“完全不支持热改”更危险，因为它表面上像成功了，实际上内部已经失去一致性。对连接池这种长期持有物理资源的组件来说，一致性比灵活更重要。

如何避免：把热修改限制在 `HikariConfigMXBean` 暴露的运行时参数上，不要指望在池启动后再去改 `jdbcUrl`、`username`、`password` 这一类连接身份配置。

### 9.3 生命周期失败：没有 maxLifetime 抖动，会出现集体退场

**源码锚点**：`HikariPool.java:493`、`HikariPool.java:495`

如果 `createPoolEntry()` 里只按固定 `maxLifetime` 调度，不做寿命方差计算，那么同一批启动的连接会在同一时刻大面积过期。后果不是“某一条连接慢一点”，而是一批连接同时退场：

- 借出高峰期突然可用连接锐减
- 补连接线程瞬时大量创建物理连接
- 数据库端同时承受认证和握手压力
- 应用侧延迟抖动被放大

HikariCP 对这个问题的处理很朴素：别让它们同一天同一刻一起老死。

如何避免：不要把池里一批连接用完全相同的固定寿命同时调度；保留 `HikariPool.java:493` 的寿命方差，让退场时间自然错峰。

### 9.4 维护期失败：没有 HouseKeeper，空闲连接会悄悄腐烂

**源码锚点**：`HikariPool.java:793`、`HikariPool.java:845`

如果没有 `HouseKeeper.run()`，归还后的连接就缺少持续治理：太闲的连接不会被淘汰、太老的连接不会被驱逐、`minimumIdle` 不会被补齐、长时间空闲后被数据库断开的连接会在下次借出时集中暴露。

这时连接池表面上“还有很多连接对象”，实际上其中不少已经在后台悄悄失效。也就是说，没有后台巡检的池，最多只能叫“借还容器”，还称不上真正的生命周期管理器。

如何避免：确保 HouseKeeper 周期调度存在，并让 `fillPool(true)`、空闲淘汰、寿命驱逐都继续挂在同一条后台巡检链上，而不是拆成彼此独立、互不协调的线程。

### 9.5 并发失败：没有状态机，借出、归还、驱逐会互相踩踏

**源码锚点**：`ConcurrentBag.java:83`、`ConcurrentBag.java:140`、`ConcurrentBag.java:189`、`ConcurrentBag.java:240`

如果没有 `ConcurrentBag` 的状态常量和 CAS 转换，多线程下最容易出现的不是简单的性能下降，而是语义错乱：

- 一条连接被两个线程同时借走
- 一条连接刚归还就被后台驱逐，同时又被别的线程拿走
- 一条连接已经从池中移除，却仍被当成可用对象交付

性能问题还能压测出来，语义错乱往往只会在少数时刻炸一次，但一次就足够难查。

如何避免：借出、归还、移除都必须通过统一状态机和 CAS 约束推进，不能把“是否还能被借走”这种判断交给调用方自己凭时序碰运气。

### 9.6 时间失败：系统时钟异常会直接污染生命周期判断

**源码锚点**：`HikariPool.java:816`

`HouseKeeper` 的时钟检测说明 HikariCP 连“时间本身会不可靠”都纳入了设计。如果忽略这一点，NTP 回拨或宿主机时间异常就会直接污染空闲时长计算、生命周期到期判断和后台巡检节奏。

对一个长期运行的连接池来说，这不是理论问题，而是线上环境会真实发生的问题。

如何避免：生命周期判断不要盲信“系统时间天然可靠”，而要像 `HikariPool.java:816` 这样显式检测回拨和大步前跳，把时间异常作为池治理的一部分。

## 九、收网：为什么这篇要先讲“生命史”，而不是先讲 borrow()

| 章节 | 核心收获 |
|------|---------|
| 困惑开场 | 连接池不是容器，而是生命史管理系统 |
| 三个方案 | 容器、薄壳、零散优化这三种理解都抓不住主线 |
| HikariConfig 策略 | maxLifetime/keepaliveTime/initializationFailTimeout 先定义生命史规则 |
| HikariConfig seal | validate() 负责参数收束，seal() / copyStateTo() 负责启动边界 |
| HikariDataSource | 入口层同时承担快路径与惰性初始化分流 |
| HikariPool | 运行时中心负责创建、补池、调度与失败兜底 |
| HouseKeeper 展开 | 后台巡检是运行时中心的延长线，不是附属线程 |
| 控制节点 | fail-fast、sealing、maxLifetime、keepalive 是规则切换点 |
| 状态机 | 连接的一生是状态之间的一次次原子转换 |
| 失败路径 | 去掉任何控制点，池都会退化回脆弱容器 |

HikariCP 不是"存连接的池子"，而是**连接生命史管理链**：`HikariConfig` 定义策略边界，`HikariDataSource` 提供入口，`HikariPool` 组织运行时，`HouseKeeper`/`MaxLifetimeTask`/`KeepaliveTask` 分别执行"巡检、到期驱逐、空闲保活"。

## 十、下篇桥接

下一篇 [02 — 一次 getConnection() 的借出链](02-getconnection-borrow-path.md) 将回答：请求一个连接时，池内部到底发生了什么——`ConcurrentBag` 的借出路径、`aliveBypassWindow` 的高频跳过、`beginRequest()` 的代理交付，是怎样在借出链上协同工作的。
