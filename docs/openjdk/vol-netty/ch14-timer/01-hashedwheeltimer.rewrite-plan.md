# Ch14-01 HashedWheelTimer rewrite plan

## 一句话困惑

HTTP、连接池、重试、idle 检测都离不开“30 秒后做一件事”这类定时任务；可当一个 JVM 同时挂着成千上万个 timeout 时，如果每个都丢进优先队列按截止时间排序，插入和调整就会持续支付 `O(log N)` 成本。Netty 为什么愿意用一个“不精确”的时间轮，而不是标准库的精确定时队列？

## 一句话顿悟

`HashedWheelTimer` 的目标不是做高精度闹钟，而是为大量 I/O 超时提供近似但稳定的调度：把时间切成固定 tick，把 timeout 先按 `(deadline / tickDuration) & mask` 落到某个 bucket，再用 `remainingRounds` 解决跨轮问题；Worker 线程每个 tick 只处理当前 bucket，而不是全局排序所有任务。

## 本篇范围

- 主讲 `HashedWheelTimer` 的时间轮结构、`tick & mask` 定位、`remainingRounds` 跨轮机制。
- 主讲 `Worker` 的 `INIT/STARTED/SHUTDOWN` 状态、`start()` CAS、`waitForNextTick()` 的绝对时间等待。
- 主讲 `HashedWheelBucket` 双向链表与 `HashedWheelTimeout` 自身作节点。
- 主讲 `cancelledTimeouts` 队列、异步取消与 `stop()` 收尾。
- 回答完整性问题 #1-#12。

## 依赖声明

```text
本篇
├── HARD 前置：ch4-bytebuf/01-dual-index-and-refcnt.md（只复用“状态机/索引思维”，不依赖具体 ByteBuf 机制）
├── SOFT 前置：ch11-http/02-aggregation-compression.md（作为应用场景桥接）
├── SOFT 前置：ch9-bootstrap/02-bootstrap-server.md（只复用连接/超时运行背景）
├── COMPARE：ScheduledThreadPoolExecutor / DelayedWorkQueue
└── END：Netty 核心卷收尾
```

## 结构设计

### 1. 开场：为什么“30 秒后关闭连接”会把普通优先队列拖成热路径
- 用 1w+ timeout 的场景引入。
- 强调 HashedWheelTimer 服务的是近似 I/O 超时，而不是毫秒级交易撮合。
- 预计 800-1000 字。

### 2. 失败方案：为什么不能继续把所有 timeout 丢进全局最小堆
- 失败方案 A：每次插入都进优先队列。
- 失败方案 B：每 tick 扫全部 timeout 检查是否到期。
- 失败方案 C：外部线程直接操作 bucket 链表取消任务。
- 预计 1600-2000 字。

### 3. 时间轮总图：wheel、mask、tickDuration、deadline、remainingRounds
- 画文字图：512 个 bucket，tick 每次前进一步。
- `wheel.length` 归一化为 2 的幂，mask=`length-1`。
- 解释 `deadline / tickDuration` 与 `tick & mask`。
- 回答完整性问题 #1/#10/#12。
- 预计 1800-2300 字。

### 4. `remainingRounds`：一圈装不下的 timeout 怎么办
- 解释“轮”的概念。
- 超出当前轮次时并不放错 bucket，而是落到目标 bucket 后延迟若干圈。
- `remainingRounds = (calculated - tick) / wheel.length`。
- 回答完整性问题 #2/#11。
- 预计 1600-2100 字。

### 5. `HashedWheelBucket`：为什么 timeout 自己就是双向链表节点
- head/tail、prev/next、O(1) 中段移除。
- `expireTimeouts()` 先存 next，再处理当前节点，避免遍历时链表断裂/死循环。
- `remove()` 对 head/tail/middle 的处理。
- 回答完整性问题 #3/#7。
- 预计 1700-2200 字。

### 6. Worker：CAS 启动、绝对时间等待、tick 精度与 Windows 特判
- `WORKER_STATE_INIT/STARTED/SHUTDOWN`。
- `start()` 多次调用如何只有一个线程获胜。
- `waitForNextTick()` 用绝对时间避免累积漂移。
- Windows `sleepTimeMs / 10 * 10` 特判。
- 回答完整性问题 #4/#6/#8/#9。
- 预计 2000-2600 字。

### 7. `newTimeout()`、transfer、cancel、stop：任务完整生命周期
- `pendingTimeouts`、`maxPendingTimeouts`、`timeouts` MPSC 队列。
- 每 tick 最多 transfer 100000 个 timeout。
- `cancel()` 只改状态并入 `cancelledTimeouts`，由 Worker 真正 unlink。
- `stop()` 如何收集未处理 timeout。
- 回答完整性问题 #5/#12。
- 预计 1800-2300 字。

### 8. 误解澄清
- 时间轮不是高精度定时器。
- bucket 内遍历 O(N) 不等于整体退化成 O(N)。
- 一个 JVM 不该为每个连接建一个 timer。
- `INSTANCE_COUNT_LIMIT=64` 是告警，不是硬限制。
- 预计 900-1200 字。

### 9. 收网
- 用三句话总结：近似、分桶、跨轮。
- 回收从 HTTP 超时、连接保活一路引到 timer 的主线。
- 作为 Netty 核心卷收尾。
- 预计 600-800 字。

## 证据清单

- `common/src/main/java/io/netty/util/HashedWheelTimer.java:90`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:97`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:104`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:110`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:114`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:288`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:335`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:352`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:431`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:476`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:522`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:547`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:570`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:612`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:656`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:698`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:760`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:783`
- `common/src/main/java/io/netty/util/HashedWheelTimer.java:804`

## 误解清单

1. 时间轮就是“每个 bucket 一个 List，遍历起来还是很慢，所以并没有意义”。
2. `remainingRounds` 是个优化变量，没有它也能正常跨圈。
3. `start()` 多次调用会启动多个 worker 线程。
4. `cancel()` 直接从外部线程改链表更快。
5. `INSTANCE_COUNT_LIMIT=64` 是硬上限，超过就不能再创建 timer。
6. HashedWheelTimer 适合所有需要高精度定时的场景。

## 边界清单

- 本篇不展开 Netty 之外的层级时间轮实现，也不讲 Linux 内核 timer wheel。
- 本篇只把 `ScheduledThreadPoolExecutor` 当对照，不深入 JDK 源码细节。
- 本篇不把 `tickDuration=100ms` 写成所有场景的最佳实践，只说明当前默认值与 I/O timeout 的契合。
- 本篇不展开 `taskExecutor` 的替换策略，只说明当前任务执行入口。