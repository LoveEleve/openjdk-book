# Ch14-01 `01-hashedwheeltimer.md` review notes

## 第一轮：事实审

### 已核对的核心结论

1. `HashedWheelTimer` 当前核心字段确实包括 `tickDuration`、`HashedWheelBucket[] wheel`、`mask`、`timeouts`、`cancelledTimeouts`、`pendingTimeouts`，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:110`。
2. `ticksPerWheel` 构造时会被 `findNextPositivePowerOfTwo()` 归一化成 2 的幂，随后 `mask = wheel.length - 1`，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:288`、`:335`。
3. Worker 当前每个 tick 用 `idx = (int) (tick & mask)` 定位 bucket，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:494`。
4. `newTimeout()` 当前不会直接把 timeout 放入 bucket，而是先加入 `timeouts` MPSC 队列，真正落桶由 `transferTimeoutsToBuckets()` 完成，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:431`、`:522`。
5. `transferTimeoutsToBuckets()` 当前通过 `calculated = deadline / tickDuration`、`remainingRounds = (calculated - tick) / wheel.length`、`stopIndex = (int) (ticks & mask)` 完成跨轮计算和 bucket 定位，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:536`。
6. `HashedWheelTimeout` 当前自己持有 `next`/`prev`/`bucket`，自身就是 bucket 双向链表节点，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:631`。
7. `HashedWheelBucket.addTimeout()` 当前是尾插链表，桶内不做排序，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:768`。
8. `expireTimeouts()` 当前遍历时先缓存 `next = timeout.next`，然后根据 `remainingRounds`、`deadline` 和取消状态决定 expire / rounds--，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:783`。
9. `remove()` 当前更新 prev/next/head/tail 后，会把 timeout 的 `prev/next/bucket` 清空，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:804`。
10. `cancel()` 当前仅把状态从 `ST_INIT` CAS 到 `ST_CANCELLED`，再加入 `cancelledTimeouts` 队列；真正 unlink 在 `processCancelledTasks()` 中调用 `removeAfterCancellation()` 完成，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:656`、`:547`、`:675`。
11. Worker 三态当前是 `INIT/STARTED/SHUTDOWN`，通过 `AtomicIntegerFieldUpdater` 切换，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:97`、`:104`。
12. `start()` 当前只有 CAS 抢到 `INIT -> STARTED` 的线程才能 `workerThread.start()`，其余并发调用只会观察到已经启动或已 shutdown，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:352`。
13. `waitForNextTick()` 当前按绝对 deadline=`tickDuration*(tick+1)` 计算 sleep 时间，而不是简单 `sleep(tickDuration)`，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:570`。
14. Windows 平台当前会把 `sleepTimeMs` 向 10ms 对齐并确保最小为 1ms，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:585`。
15. `transferTimeoutsToBuckets()` 当前每 tick 最多处理 100000 个 timeout，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:522`。
16. `expire()` 当前先 `remove()`、减少 `pendingTimeouts`，再通过 `taskExecutor.execute(this)` 执行任务，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:698`。
17. `stop()` 当前不能在 worker 线程中调用，会中断并 join worker 线程，并返回未处理 timeout 集合，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:378`。
18. `INSTANCE_COUNT_LIMIT=64` 当前只用于告警“创建过多实例”，不是硬性拒绝创建，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:92`、`:316`、`:467`。
19. 默认 tick duration 当前确实是 100ms，默认 wheel size 是 512，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:168`、`:183`。
20. `maxPendingTimeouts` 小于等于 0 时表示不限制，超限时 `newTimeout()` 抛 `RejectedExecutionException`，证据：`common/src/main/java/io/netty/util/HashedWheelTimer.java:239`、`:438`。

### 术语精度检查

- 正文把 `tick & mask` 解释为 O(1) bucket 定位，前提是 wheel 长度已归一化为 2 的幂，措辞准确。
- 正文把 `remainingRounds` 解释成“还要多绕几圈”，符合当前实现语义，没有误写成精确剩余时间。
- 正文把 `INSTANCE_COUNT_LIMIT` 解释为告警阈值，未误写成硬上限。

## 第二轮：因果审

### 因果链是否成立

1. “时间轮用近似精度换大量 I/O 超时的稳定调度” 有类注释与默认参数设计直接支撑，成立。
2. “wheel 长度取 2 的幂，是为了让 `% wheel.length` 退化成 `& mask`” 由源码初始化方式直接支撑，成立。
3. “一圈装不下的任务通过 `remainingRounds` 表达，而不是放错 bucket” 由 transfer 计算与 expire 逻辑直接支撑，成立。
4. “bucket 中段移除之所以安全，不在于链表本身，而在于 Worker 单线程独占修改” 由 cancel 走队列、remove 在 Worker 上执行直接支撑，成立。
5. “`waitForNextTick()` 用绝对时间避免 drift 累积” 由公式结构直接支撑，成立。
6. “`cancel()` 不直接改链表是为了避免外部线程并发修改 Worker 私有结构” 由 `cancelledTimeouts` 设计直接支撑，成立。
7. “`INSTANCE_COUNT_LIMIT=64` 是为了提醒 timer 应共享，而非连接级实例化” 由源码告警文案直接支撑，成立。

### 需要克制的推断

- 文中举“10000 个 timeout 的 logN 开销”只是数量级直觉，不写成精确基准测试结果，符合证据边界。
- 对“100ms 对多数 I/O timeout 足够”的解释和类注释一致，但没有扩展成所有场景普适结论，保持克制。

## 第三轮：结构审

### 当前结构是否按理解路径推进

1. 从 HTTP/连接超时场景切入，引出“未来 30 秒再回来做一件事”。
2. 先推演全局堆、全量扫描、外部线程直改链表三种失败方案。
3. 再讲时间轮总图与 O(1) bucket 定位。
4. 然后专讲 `remainingRounds` 跨轮语义。
5. 再讲 bucket 链表结构与 timeout 自作节点。
6. 再讲 Worker 状态、绝对时间等待与 Windows 特判。
7. 最后收 timeout 生命周期：newTimeout/transfer/cancel/stop。
8. 用误解澄清与收网完成全卷闭环。

结构符合“问题 -> 失败 -> 顿悟 -> 机制 -> 回收”，没有沿源码文件从上到下翻译。

### 结构风险检查

- 没有一上来就解释所有构造器和 leak detector，而是只在主线需要的地方提默认 tick 和实例告警，正确。
- `remainingRounds` 单独成节，有助于回答“为什么 51.2 秒以上还能处理”这一核心困惑，合理。
- `cancel()/stop()` 放在后段形成完整生命周期闭环，合理。

## 第四轮：读者审

### 删码测试判断

删除正文 fenced code block 后，仍能复述：

1. 为什么时间轮相对优先队列适合海量近似超时。
2. `tick & mask` 如何定位 bucket。
3. `remainingRounds` 如何表达跨圈等待。
4. bucket 双向链表如何安全遍历与移除。
5. Worker 如何用绝对时间推进 tick。
6. cancel/stop 的异步清理语义。

代码块承担的是文字图和局部证据，不是主叙事骨架。

### 阅读风险点

- `remainingRounds` 公式比较抽象；正文已先讲“轮”的概念，再落公式，负担可接受。
- `waitForNextTick()` 的绝对时间与相对时间差异容易空泛；正文已用 drift 累积例子解释。
- `INSTANCE_COUNT_LIMIT` 容易被误解为限制；正文在误解澄清中再次回收，合理。

## 第五轮：边界审与缺陷猎取

### 已覆盖边界

- 默认 tick 近似精度与高精度场景不匹配。
- wheel 一圈长度有限但 timeout 可跨轮。
- transfer 每 tick 有 100000 上限，避免 worker 被持续塞满。
- cancel 走异步队列而非外部线程直改链表。
- channel 级多实例化不是推荐模式，只会告警。
- stop() 返回未处理 timeout 集合作为收尾协议。

### Bug / issue 候选检查

本轮未形成可单列 issue 的源码缺陷：

- `remainingRounds` 计算与 `deadline <= deadline` 兜底检查当前自洽，未发现长延时任务落错 bucket 的证据。
- `expireTimeouts()` 先缓存 next 的遍历方式和 `remove()` 的清理顺序未发现死循环或悬挂指针证据。
- `cancel()` 到 `cancelledTimeouts` 再到 Worker unlink 的线程模型与注释一致，未发现竞态缺口。
- Windows sleep rounding 是已知兼容性 workaround，不构成当前代码缺陷。

结论：本篇未发现需要单列 issue 候选的源码 bug。

## 第六轮：依赖审

### 前置依赖

- Ch11 HTTP 只作为应用场景桥接，不承担硬事实前提，方向正确。
- Ch10/Ch11 中关于状态拥有者、单线程独占、骨架与边界的理解被复用为认知前置，逻辑成立。
- 不依赖尚未分析的外部库定时器实现。

### 后续与收尾

- 本篇作为 Netty 核心卷收尾，结尾回收到“状态放在哪里、谁拥有它、谁推进它”的总主线，成立。
- 没有强行前向引用 HTTP/2 或其他尚未作为当前卷依赖的域。

## 机械检查

### 禁用词扫描目标

- 此处不再赘述
- 不再展开
- 类似地
- 同理
- 依此类推
- 篇幅所限
- 显然
- 容易看出
- 细节读者自行阅读源码

预期：正文不命中。

### 删码测试目标

删除全部 fenced code block 后，正文仍应保留：

- 时间轮总图与 O(1) bucket 定位
- `remainingRounds` 跨轮机制
- bucket 双向链表与安全移除
- Worker 绝对时间等待逻辑
- cancel / stop 生命周期闭环