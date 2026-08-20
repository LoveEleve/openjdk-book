# 为什么 `shrink()` 不是“定时清一清”，而是 Druid 池长期运行的后台维护中心

> 本文基于 Druid 1.2.27 当前源码。本文只讲 Druid 连接池的后台维护体系：`shrink()`、`DestroyTask`、`CreateConnectionTask`、`removeAbandoned()`。不展开 Filter/StatFilter/WallFilter/解析器。

## 为什么一个方法要管四件事

如果你读过 HikariCP 的 HouseKeeper 篇，就会知道它的后台维护是按“单一职责”拆的：
- `maxLifetime` 管连接寿命
- `keepaliveTime` 管空闲保活
- `idleTimeout` 管空闲驱逐
- `fillPool` 管补连接
- 这些最后在 HouseKeeper 的 `run()` 里按顺序执行

Druid 后台维护的入口看起来完全不同。它只有一个方法：

- `shrink(boolean checkTime, boolean keepAlive)`

但这个方法一个人就包了四件事：
1. fatalError 处理
2. 空闲驱逐
3. keepAlive 检测
4. 数组紧凑化

这很容易让人产生一个直觉：`shrink` 就是“清理空闲连接”的别名。

但一旦真的往源码里追，就会发现 shrink 不是“一个清理方法”，而是 Druid 池维护主线的执行中心。它把多个维护动作压进同一个扫描循环，用 `checkTime` 和 `keepAlive` 两个布尔参数控制分支，再通过 `DestroyTask` 定时触发。

所以，本文真正要回答的问题不是“shrink 有哪些参数”，而是：

**为什么 Druid 选择把后台维护压进一个方法，而不是像 HikariCP 那样拆成多个独立任务，以及这套模式为什么仍然成立？**

## 先看失败方案

### 失败方案一：`shrink()` 就是驱逐空闲连接

只从名字看，shrink 确实像“收缩”，于是很容易理解为“驱逐空闲连接”。

但 shrink 做的不只是空闲驱逐。它的扫描循环里至少同时处理：
- fatalError 标记的老连接
- 达到 `phyTimeoutMillis` 的连接
- 达到 `minEvictableIdleTimeMillis` 的空闲连接
- 达到 `maxEvictableIdleTimeMillis` 的连接（无论空闲多久）
- 触发 keepAlive 检测条件的连接

所以 shrink 不是“清理空闲”，而是“维护扫描”。

### 失败方案二：Druid 维护体系和 HikariCP HouseKeeper 一样

HikariCP 的 HouseKeeper 是一个 `scheduleWithFixedDelay` 定时任务，所有决策在 `run()` 里一次完成。

Druid 的维护是两条后台线路：
- `DestroyTask`：定时触发 `shrink()` + `removeAbandoned()`
- `CreateConnectionTask`：由 `createScheduler` 管理，负责建新连接

一个是维护执行者，一个是新连接生产者。不能混为一谈。

### 失败方案三：`removeAbandoned()` 是 shrink 的一部分

`removeAbandoned()` 虽然也在 `DestroyTask` 里被调用，但它和 `shrink()` 管的是不同范围的连接：
- `shrink()` 管的是池内未借出的连接
- `removeAbandoned()` 管的是已经借出去但超时未归还的连接

所以不能把 removeAbandoned 当成 shrink 的附属。

## shrink 体系的最小总图

```text
DestroyTask.run()
  -> shrink(true, keepAlive)
    -> ① fatalError 处理
    -> ② idle timeout 驱逐
    -> ③ keepAlive 检测
    -> ④ 数组紧凑化
  -> removeAbandoned()

CreateConnectionTask (由 createScheduler 管理)
  -> 失败时指数退避重试
  -> 成功时放入 connections[] 并 signal notEmpty
```

## 一、`shrink(boolean, boolean)`：为什么一个方法要管四件事

`shrink()` 在 `DruidDataSource.java` 的三重重载是：

- `shrink()`：约第 3061 行
- `shrink(boolean checkTime)`：约第 3065 行
- `shrink(boolean checkTime, boolean keepAlive)`：约第 3069 行

最终的最重实现是 `shrink(boolean, boolean)`，约 200 行。

而 `DestroyTask.run()` 的执行入口也把它和 `removeAbandoned()` 的分野看得非常清楚：

```java
public void run() {
    shrink(true, keepAlive);
    if (isRemoveAbandoned()) {
        removeAbandoned();
    }
}
```

证据：`com/alibaba/druid/pool/DruidDataSource.java:2887`

这直接验证了前文说的：`removeAbandoned()` 不是 shrink 的固定后续，而是只有在 `isRemoveAbandoned()` 为 `true` 时才透出的可选分支。

它把四个维护动作压进同一个扫描循环，而不是分开四个方法，说明 Druid 的设计哲学是：

- 一次锁住 `connections[]` 数组，把能做的维护一次性扫完
- 减少多次加锁、多次扫描的开销

所以它不是“一个方法做了四件事”的问题，而是“一次扫描完成四件事”。

## 二、四阶段扫描

### 第一阶段：fatalError 处理

如果数据库发生致命错误，`fatalErrorCount` 会递增。在 shrink 的第一阶段，所有在 fatalError 之后被创建的老连接都会被标记淘汰。

这意味着 Druid 不只是在驱逐空闲连接，还在处理“数据库下线后重建的连接”这一批老连接。

### 第二阶段：空闲驱逐

这是大多数人最熟悉的 shrink 职责。它检查：

- `phyTimeoutMillis`：物理超时
- `minEvictableIdleTimeMillis`：逐出前的最小空闲时间
- `maxEvictableIdleTimeMillis`：无论空闲多久，超过这个时间就全部逐出

但关键区别在于：Druid 不是“挨个检查每个连接”，而是在一次数组扫描中完成全部判断。

### 第三阶段：keepAlive 检测

如果 `keepAlive` 参数为 `true`，shrink 还会检查：

- `idleMillis >= keepAliveBetweenTimeMillis`
- 并且 `lastKeepTimeMillis` 去重

符合条件的连接会被收集到 `keepAliveConnections[]` 数组中，后续由 `validationQuery` 验证。

### 第四阶段：数组紧凑化

前三个阶段完成后，`connections[]` 中可能已经出现了多个空槽位。Druid 不会让这些空槽位散落，而是通过 `System.arraycopy` 把尾部存活连接向前移动，保持数组紧凑。

## 三、`DestroyTask` / `CreateConnectionTask`：两条后台线路的分工

Druid 的后台维护不是由同一个线程执行的，而是多个独立节点协作：

- `DestroyTask`：定时触发 `shrink()`，并在 `isRemoveAbandoned()` 时触发 `removeAbandoned()`：`com/alibaba/druid/pool/DruidDataSource.java:2887`
- `CreateConnectionTask`：由 `createScheduler` 管理，负责在池空或不足时补充连接：`com/alibaba/druid/pool/DruidDataSource.java:2560`
- `removeAbandoned()`：强制回收超时未归还的连接：`com/alibaba/druid/pool/DruidDataSource.java:2925`
- 触发频率由 `timeBetweenEvictionRunsMillis` 控制：`com/alibaba/druid/pool/DruidDataSource.java:987`

`DestroyTask` 是维护的执行者，`CreateConnectionTask` 是新建连接的生产者。两者不能替换。

## 四、`removeAbandoned()`：强制回收超时未归还的连接

`removeAbandoned()` 在 `DestroyTask` 里被调用，但它和 `shrink()` 不是同一件事：

- `shrink()` 管的是池内未借出的连接
- `removeAbandoned()` 管的是已经借出去但超时未归还的连接

它通过 `removeAbandonedTimeoutMillis` 判断一条连接是否超时，如果超时则强制回收并 WARN 日志“not use in production”。

## 五、Druid vs HikariCP 后台维护模型对比

| 维度 | HikariCP | Druid |
|---|---|---|
| 执行入口 | HouseKeeper.scheduleWithFixedDelay(100L, 30s) | DestroyTask + CreateConnectionTask |
| 维护方法 | 多任务：maxLifetime/keepalive/idleTimeout/fillPool 在 HouseKeeper 里顺序执行 | 一个 `shrink()` 完成四阶段扫描 |
| 连接创建 | 由 PoolEntryCreator 由 addConnectionExecutor 异步提交 | 由 CreateConnectionTask 由 createScheduler 管理 |
| 空闲驱逐 | 由 HouseKeeper `values(STATE_NOT_IN_USE)` 筛选后逐条 reserve → close | 由 `shrink()` 一次数组扫描完成 |
| 强制回收 | 无 | removeAbandoned() |

## 这篇真正立住的，不是几个任务类，而是“Druid 维护体系是一套缩紧的一次扫描协议”

如果只从表面看，这篇很容易被读成：

- `shrink()` 做了什么
- `DestroyTask` 是什么
- `removeAbandoned()` 是什么

这种读法会错过真正的骨架。

更稳的理解方式应该是：

1. `shrink()` 不是“清理方法”，而是 Druid 维护主线的执行中心
2. 它把 fatalError / idle / keepAlive / compact 四件事压进一次数组扫描
3. `DestroyTask` + `CreateConnectionTask` 是两条独立后台线路
4. `removeAbandoned()` 和 `shrink()` 管的是不同范围的连接

## 这篇之后，最自然的继续方向是什么

到这里，Druid 的池本体（D-1）和后台维护（D-5）都已经立住了。接下来最自然的继续方向是：

- **Filter 拦截链体系**

因为到这时，池的借出、归还、维护已经讲完，接下来最自然的就是进入 Druid 最独特的扩展点——Filter 链。