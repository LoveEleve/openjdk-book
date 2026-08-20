# 10-concurrent-collections/06 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `TransferQueue`、`LinkedTransferQueue` 与本域已重写的 CHM、SkipList、COW/CLQ、BlockingQueue。本文聚焦 `transfer` 与 `put` 的语义差异、数据节点/请求节点配对、`xfer`/`awaitMatch` 主线，以及最后的并发集合和线程池队列选型。完整 sweep 清理和所有实现分支不在主线逐行展开。
> 目标：把“TransferQueue 与并发集合选型”改写成一篇围绕“入队成功和交接成功不是一回事，选择并发容器时必须先选语义再选实现”的收官文章。

## 1. 读者困惑

- `BlockingQueue.put()` 已经能阻塞等待了，为什么还需要 `TransferQueue.transfer()`？
- “元素成功进入队列”和“元素已经被消费者接收”到底差在哪？
- `LinkedTransferQueue` 如何让数据节点和请求节点直接配对？
- 没有匹配消费者时，`transfer`、`tryTransfer`、`put`、超时版分别怎么处理？
- 并发集合这么多，为什么不能只按“哪个更快”来选？
- 线程池的 `workQueue` 为什么会改变扩容、排队和拒绝行为？

## 2. 一句话顿悟

**TransferQueue 在 BlockingQueue 的“等待”之上再加了一层“交付确认”：`put` 只要元素进入队列就可以返回，`transfer` 则要等某个消费者真正接手才返回。这个差异决定了并发集合选型的第一步不是比较锁和 CAS，而是先确定你需要的是映射、有序、快照、缓冲、直接交接，还是严格的消费确认。**

## 3. 旧稿优点与问题

### 保留

- 已指出 `transfer` 比普通 `put` 多一层“必须被接收”的语义。
- 已覆盖 `TransferQueue` 方法组与 `LinkedTransferQueue.xfer` 主线。
- 已有并发集合矩阵和线程池 workQueue 选型内容。

### 必须重写

- 旧稿开头直接讲定义，缺少“为什么入队成功仍然不等于交付成功”的业务困惑。
- `LinkedTransferQueue` 需要把数据节点、请求节点和配对过程画成角色图，而不是只列 `xfer` 参数。
- `put`/`transfer`/`tryTransfer` 的差异要放在同一个状态机中解释。
- 全景矩阵必须从“语义问题 → 并发策略 → 代价”出发，不能只是类名表格。
- 线程池部分要明确队列选择如何改变“创建线程、排队、拒绝”的路径，而不是只给结论。

## 4. 理解路径

### 第一节：从“任务已经入队但业务仍未交付”开场

用事件交付/线程池任务场景：生产者把任务放进队列后返回，但调用者真正关心的可能是“已经有消费者接手”。如果只用 `put`，队列有空间就会立即返回，任务可能还在缓存里排队。引出“入队确认”和“交付确认”是两种不同语义。

### 第二节：TransferQueue 为什么比 BlockingQueue 多一层语义

证据：
- `TransferQueue.java:68`：接口定义
- `TransferQueue.java:86`：`tryTransfer`
- `TransferQueue.java:105`：`transfer`
- `TransferQueue.java:134`：定时 `tryTransfer`
- `TransferQueue.java:145`：`hasWaitingConsumer`
- `TransferQueue.java:160`：`getWaitingConsumerCount`

主线：
- `put`：元素进入队列即可返回。
- `transfer`：没有消费者就等，直到元素交给消费者。
- `tryTransfer`：没有等待消费者就立即失败。
- 定时版：在“交付确认”上增加时间边界。
- 这些方法不是数量扩展，而是在表达不同强度的交付承诺。

### 第三节：LinkedTransferQueue 的角色图——数据节点和请求节点如何相遇

证据：
- `LinkedTransferQueue.java:91`：类定义
- `LinkedTransferQueue.java:445-449`：`Node` 的 `item`/`next`/`waiter`
- `LinkedTransferQueue.java:662`：`xfer`
- `LinkedTransferQueue.java:703`：`awaitMatch`

主线：
- 发送方可以带数据进入队列。
- 接收方可以带空请求进入队列。
- 两类相反模式的节点在遍历中尝试 CAS 配对。
- 配对成功后，等待线程被唤醒；配对失败时，根据 `how` 决定异步返回、继续等待、限时等待或立即失败。

文字图：

```text
数据节点(data) ──CAS──> 请求节点(request)
请求节点(request) ──CAS──> 数据节点(data)
匹配成功 → 对方拿到元素 / 发送方确认交付
匹配失败 → 按 put/transfer/tryTransfer 语义排队或返回
```

### 第四节：`xfer` 为什么把 put/transfer/tryTransfer 收成一个状态机

证据：
- `LinkedTransferQueue.java:662-703`：`xfer` 与 `awaitMatch`
- `LinkedTransferQueue.java:1268-1381`：各公共 API 到 `xfer` 的映射

主线：
- `haveData` 区分发送方和接收方。
- `how` 区分 `NOW`、`ASYNC`、`SYNC`、`TIMED`。
- `put` 走异步入队；`transfer` 走同步交付等待；`tryTransfer` 走立即尝试；超时版走限时等待。
- 统一状态机避免每个 API 各自重复维护配对和取消逻辑。

### 第五节：为什么交付确认会改变系统背压

主线：
- `put` 的返回只说明队列接住了元素，不说明消费者已经处理或接收。
- `transfer` 的返回至少说明一个消费者已经完成接手，因此发送方可以把它当作交付边界。
- 代价是没有消费者时发送方会等待，吞吐和延迟会受接收方速度约束。
- `tryTransfer` 和定时版用于避免无限等待。

### 第六节：并发集合如何按语义而不是类名选型

对照已完成域：
- 需要 key/value 映射、无序高并发：`ConcurrentHashMap`
- 需要有序映射和范围查询：`ConcurrentSkipListMap`
- 读多写少且要稳定快照：`CopyOnWriteArrayList`
- 不要求阻塞的无界生产消费：`ConcurrentLinkedQueue`
- 需要容量边界和空满等待：`ArrayBlockingQueue` / `LinkedBlockingQueue`
- 不要缓冲、只要线程直接交接：`SynchronousQueue`
- 需要交付确认：`LinkedTransferQueue`
- 需要时间到期后才能取：`DelayQueue`

主线：
- 先问数据语义，再问顺序/容量/快照/交接，再评估锁、CAS、复制、节点和内存成本。
- “并发集合”不是一个统一性能等级，而是一组不同承诺。

### 第七节：线程池为什么把队列选择变成调度策略

证据：
- `ThreadPoolExecutor.java:447`：`workQueue`
- `ThreadPoolExecutor.java:1174-1186`：构造器接收工作队列

主线：
- 队列不是线程池的被动容器，而是决定 execute 路径何时创建线程、何时排队、何时触发拒绝的调度输入。
- `SynchronousQueue` 倾向直接交接，任务不愿在队列里落地，容易推动非核心线程创建或更早拒绝。
- 无界 `LinkedBlockingQueue` 倾向持续排队，可能让最大线程数长期没有机会发挥。
- 有界 `ArrayBlockingQueue` / 有界 LBQ 把积压上限显式化，满后进入拒绝策略。

### 第八节：域 10 收官

- 收回“语义优先”的总原则。
- 强调并发容器解决共享并发问题，但不能消除共享成本。
- 引出域 14：容器选完后，线程池如何消费这些队列并管理 Worker 生命周期。

## 5. 失败方案清单

1. 把 `put` 返回误解成消费者已经接收任务。
2. 需要交付确认时仍使用普通 `BlockingQueue`，让发送方过早返回。
3. 需要避免无限等待时直接使用 `transfer`，忽略 `tryTransfer` 和定时版。
4. 把 `LinkedTransferQueue` 理解成“更快的 LinkedBlockingQueue”，忽略交付语义差异。
5. 只按容器实现名选型，不先确认是否需要有序、容量、快照或交接。
6. 在线程池中使用无界队列，却期待 `maximumPoolSize` 自动扩容。
7. 在线程池中使用零容量交接，却忽略更早触发拒绝和线程创建压力。

## 6. 误解清单

1. `TransferQueue` 只是多了几个查询等待消费者的方法。
2. `transfer` 和 `put` 都是“放进去”，返回条件没有本质差异。
3. `tryTransfer` 失败说明队列坏了，而不是当前没有等待消费者。
4. 数据节点和请求节点只是内部对象形态，不影响交付语义。
5. 并发集合越“无锁”就越适合作为线程池队列。
6. 无界队列一定比有界队列更安全。
7. 线程池的队列只影响存储，不影响扩容和拒绝。

## 7. 证据清单

- `TransferQueue.java:68`：接口定义
- `TransferQueue.java:86`：`tryTransfer`
- `TransferQueue.java:105`：`transfer`
- `TransferQueue.java:134`：定时 `tryTransfer`
- `TransferQueue.java:145`：`hasWaitingConsumer`
- `TransferQueue.java:160`：`getWaitingConsumerCount`
- `LinkedTransferQueue.java:91`：类定义
- `LinkedTransferQueue.java:445-449`：节点字段
- `LinkedTransferQueue.java:662`：`xfer`
- `LinkedTransferQueue.java:703`：`awaitMatch`
- `LinkedTransferQueue.java:1268-1381`：公共方法到 `xfer` 的映射
- `ThreadPoolExecutor.java:447`：`workQueue`
- `ThreadPoolExecutor.java:1174-1186`：构造器接收队列

## 8. 版本与边界

- 基于 JDK 11。
- `LinkedTransferQueue` 的 sweep 清理只按“未匹配节点需要回收”说明，不逐行展开所有清理分支。
- `transfer` 只保证发送方完成交接，不等于消费者业务处理逻辑已经执行完毕。
- 线程池队列对扩容/拒绝的影响，本文解释 `ThreadPoolExecutor` 的基本选择逻辑，不替代域 14 的 Worker 全流程。
- 选型矩阵是语义与实现的工程归纳，不把任何单一容器写成所有负载下的性能最优解。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“入队确认不等于交付确认 → TransferQueue 方法强度差异 → 数据节点/请求节点配对 → xfer 状态机 → 交付确认如何形成背压 → 按语义选择并发容器 → 线程池队列如何改变调度”。
- 必须把 `transfer` 与 `put` 的返回条件讲清楚。
- 必须把 `LinkedTransferQueue` 讲成配对交接协议，而不是普通链队列优化。
- 必须让选型矩阵服务于语义问题，而不是堆类名。
- 结尾要自然引到域 14 线程池与任务执行。
