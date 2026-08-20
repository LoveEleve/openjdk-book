# 为什么 Druid 不能只是“HikariCP 加上监控”

> 本文基于 Druid 1.2.27 当前源码。本文只讲 `DruidDataSource` 池本体：为什么它内部不是 HikariCP 那样的 ThreadLocal + CAS 无锁查找，而是一把 `ReentrantLock`、两个 `Condition`、一批固定长度数组加阻塞等待协议。本文不展开 Filter/StatFilter/WallFilter/解析器，那属于后续篇目。

## 为什么“Druid 就是 HikariCP 加监控”这个印象，一开始就会把人带偏

如果你已经读过 HikariCP，第一次看到 Druid 时很容易得到一个非常顺滑的归纳：

- HikariCP 很精简
- Druid 功能多
- 所以 Druid 无非就是 HikariCP 加 SQL 监控、加防火墙、加控制台

这个归纳听起来合理，但它会在你看源码时制造连续的挫败感。

因为只要你顺着连接池本身往深处看，就会立刻撞到一个 HikariCP 里完全不存在的模型：

- 借连接时不是从线程本地找候选，而是拿一把锁、进两个 Condition 队列去等
- 不会用 `ConcurrentBag` 那套无锁协议，而是固定数组 + 阻塞等待
- 借出的主路径上，还会穿插 `createDirect`、`maxWaitThreadCount`、`onFatalError` 这类 HikariCP 里没有的分支

也就是说，Druid 的问题不在“它多做了什么”，而在**它池子本身的模型就和 HikariCP 不一样。**

如果你把“HikariCP 加监控”当默认前提，后面看 `notEmpty` / `empty` 两个 Condition 时，很容易把它们当成“普通 wait/notify”，然后所有借不足、超时、补充醒来的语义都会被读扁。

所以，本文真正要回答的问题不是“Druid 有哪些连接池 API”，而是：

**为什么 Druid 的连接池本体选择了和 HikariCP 完全不同的并发模型，并且这套模型仍然成立？**

## 先看失败方案：为什么不能拿 HikariCP 的模型硬套 Druid

### 失败方案一：Druid 就是 HikariCP + 监控

这是最容易形成、也最容易误导人的理解。

如果只从外部看，二者确实都提供：
- 连接池
- 借出
- 归还

于是很容易推断：差异只在“Druid 额外带了监控和安全”。

但真正的差异有两层：
- 一层是池内并发模型不同
- 一层是拦截模型不同（Druid 有 Filter 链，HikariCP 靠代理类直接处理）

只看“加了多少功能”，会漏掉这两层本质差异，导致后面读 Filter/Stat/Wall 时没有正确骨架。

所以在 `vol-druid` 的阅读里，最重要的不是“功能比 HikariCP 多”，而是：

- 这两套池自己是两套不同协议

### 失败方案二：`init()` 只是配置校验

如果沿用 HikariCP 的印象，会把启动阶段看得很轻，觉得 Druid 构造 `DataHolder` 和校验配置差不多。

但 Druid 的 `init()` 是一个真正的“从配置变成运行池”的转折点：
- 驱动加载
- Filter 链初始化
- 预建 initialSize 个连接
- 启动创建/销毁线程
- 通过 initedLatch 同步等待首配完成

它不只是校验，而是装配。

如果跳过这一步，后面 `connections[maxActive]` 数组和借出协议为什么存在，都会失去上下文。

### 失败方案三：池空时的 wait/signal 只是普通 Object 等待

这是最容易让理解崩掉的一个点。

因为 `notEmpty` 和 `empty` 这两个 `Condition` 看起来很像 Java 普通的 wait/notify 用法，于是很容易被当作“阻塞等待 + 唤醒”简单带过。

但 Druid 的这套不是孤立的 wait/signal：

- 它是一个固定数组 + 双 Condition 的借出/补充/超时协议
- 借不到时阻塞在 `notEmpty`
- 池空时创建线程在 `empty` 上等待“要不要补”
- 超时、discard、致命错误都在这套协议上加了分支

只有把 `notEmpty`/`empty` 看成一个受控协议，后面的 `createDirect`、`maxWaitThreadCount`、`onFatalError` 才有落点。

## Druid 池本体的最小总图

如果把 Druid 连接池本体先压缩成最小模型，它可以写成下面这样：

```text
DruidDataSource
  -> init()
    -> connections[maxActive]
      -> borrow via getConnectionInternal()
        -> notEmpty / empty Condition protocol
          -> pollLast() -> holder -> holder.discard retry
      -> return via recycle()
```

如果按职责拆，可以分成三层：

```text
[配置与启动]
DruidDataSource / init()

  ->

[池存储与协议]
DruidAbstractDataSource / connections[] / notEmpty / empty

  ->

[连接对象]
DruidConnectionHolder / DruidPooledConnection
```

这张图最重要的价值，是先把“HikariCP 借还链”和“Druid 池协议”区分开。

## 一、`DruidDataSource` / `DruidAbstractDataSource` / `DruidConnectionHolder`：三层不是装饰，而是一个完整池模型

先看最上层的 `DruidDataSource`：

- 源码路径：`pool/DruidDataSource.java`
- 类声明：`com/alibaba/druid/pool/DruidDataSource.java:81`；文件总长度为 3979 行

它和 `DruidAbstractDataSource`、`DruidConnectionHolder` 不是三个并列类，而是一个完成的池模型分层：

- `DruidDataSource`：对外接口 + 主启动/借出/归还逻辑
- `DruidAbstractDataSource`：连接池共享配置与基础行为
- `DruidConnectionHolder`：单条连接的持有与状态

如果你先用 HikariCP 的“`DataSource` 只是薄入口”的印象去看它，会低估 `DruidDataSource` 的份量。它在这里承担的是真正的池中心，而不只是应用入口。

它可以做到 3979 行，是因为池的启动、借出、归还、shutdown 几乎都压在这里。方法级入口也很明确：
- `init()`：`com/alibaba/druid/pool/DruidDataSource.java:659`
- `getConnectionInternal(long)`：`com/alibaba/druid/pool/DruidDataSource.java:1543`

## 二、`connections = new DruidConnectionHolder[maxActive]`：为什么它是“固定数组”，而不是动态容器

`DruidDataSource` 里有一条关键声明：

- `connections = new DruidConnectionHolder[maxActive];`

这句话和 HikariCP 的 `ConcurrentBag` 形成鲜明对照。

而且它不止这一条：`init()` 里同时建了 `connections`、`evictConnections`、`keepAliveConnections`、`nullConnections` 四个平行数组。

证据：`com/alibaba/druid/pool/DruidDataSource.java:772`

HikariCP 的池存储是动态对象集合，靠 ThreadLocal + CAS 让它高并发查找；
Druid 的池存储是固定长度数组，靠锁 + 数组下标去访问。

这就带来截然不同的并发语义：

- 数组在 `maxActive` 上就封死了上限
- 借出者直接和数组中的槽位打交道
- 槽位空 / 槽位有 holder / 槽位被标记 discard，都是这套数组协议的一部分

所以不是“Druid 不会用并发结构”，而是它选择了一种更简单的存储模型，然后用锁 + Condition 去稳住这套协议。

## 三、`init()`：从“配置对象”到“运行池”的转折点

`DruidDataSource.init()` 是一个真正的启动转折点。源码位置大约在：

- `pool/DruidDataSource.java` 的 `public void init()`（约第 659 行）

它和 HikariCP 的构造启动最大的不同，在于它需要处理的东西更多：

- SPI 加载 / Driver 解析
- Filter 链初始化
- 预建 `initialSize` 个连接
- 启动 create/destroy 后台线程
- 通过 `initedLatch` 让首次启动能同步等待

也就是说，`init()` 完成后，`connections[]` 才真正成为可借出的运行池；而在 `init()` 之前，它更像一个等待启动的配置对象。

如果你把 `init()` 只看成校验方法，就会漏掉整个“配置对象 → 运行池”的转折语义。

## 四、`getConnectionInternal()`：借出不是“从池里拿一个”，而是走一套协议

借出真正的主路径在：

- `getConnectionInternal(long)`（约第 1543 行）

它并不是单单“从数组尾部拿一个直接返回”。它在拿的过程中会检查：

- 池是否已 closed / disable / 有异常
- 是否有 `createDirect` 机会（池空且创建线程已有排队）
- 是否触发 `maxWaitThreadCount` 限流
- 是否触发 `onFatalError` 保护
- 从数组 `pollLast()`，但取出后可能还要处理 `holder.discard` 后重试
- 超时则抛异常

这说明借出并不是“拿对象”，而是“走完借出协议”。

如果跳过这套协议，`createDirect` 看起来就是又一个优化 trick，`maxWaitThreadCount` 像是额外开关，`onFatalError` 像防御性补丁。但放回这套协议里，它们都是借出链上必要分支。

## 五、为什么 `notEmpty` / `empty` 不是普通 wait/signal，而是一套受控协议

把前面几条串起来，就会看到 Druid 的池本体不是“数据结构 + 接口”，而是“数组存储 + 两路 Condition 协议”：

- 借出者拿不到连接时，阻塞在 `notEmpty` 上等“有连接可用”
- 池空且创建线程空闲时，可能等在 `empty` 上等“是否需要补连接”
- 生产者建完连接后唤醒等待者，借出者被唤醒后再从数组取

这套双 Condition 协议能成立的关键，是它和固定的 `connections[]` 数组、固定的 `maxActive` 上限、以及 `pollLast` / `putLast` 语义绑定在一起。

所以你如果把两个 Condition 当成普通 wait/notify，会漏掉：
- 为什么等待者不是每次醒来都一定拿得到连接
- 为什么池空时创建线程还要判断要不要新补
- 为什么超时与丢弃会重新进入等待或重试

## 到了这里，Druid 的池本体已经不能再被当成“HikariCP 换个壳”了

现在回看最初那个印象：

- Druid 就是 HikariCP 加监控

这条已经明显不够了。

更准确的说法应该是：
- HikariCP 池本体是无锁动态集合
- Druid 池本体是“固定数组 + Lock + 双 Condition”的受控协议
- 二者在借出/归还上有本质不同的运行模型

所以 `vol-hikaricp` 里的“连接生命史 + ConcurrentBag”不能直接搬来理解 Druid；Druid 池协议需要单独建起来。

## 这篇真正立住的，不是几个池类，而是“Druid 池协议”这个骨架

如果只从表面看，这篇很容易被读成：

- `DruidDataSource`、`DruidAbstractDataSource`、`DruidConnectionHolder` 三个类的说明

这种读法会错过真正的骨架。

更稳的理解方式应该是：

1. Druid 池本体的存储是固定数组 `connections[maxActive]`
2. 借出走 `getConnectionInternal()` 协议
3. `notEmpty` / `empty` 双 Condition 是这套协议的等待/补充控制面
4. `init()` 是从配置对象变成运行池的转折点

也就是说，这篇真正立住的不是类名，而是：

**Druid 池本体是一套和 HikariCP 不同的受控协议。**

## 这篇之后，Druid 最自然的继续方向是什么

到这里，Druid 的池本体骨架已经立住了：

- `connections[]` 固定数组
- `notEmpty` / `empty` 双 Condition
- `init()` 启动转折
- `getConnectionInternal()` 借出协议

接下来最自然的继续方向，就是 `shrink` 维护体系：

- 空闲驱逐
- keepAlive
- removeAbandoned
- DestroyTask / CreateConnectionTask

也就是说，下一篇应该顺着池本体，讲后台如何维持这套池协议长期稳定。