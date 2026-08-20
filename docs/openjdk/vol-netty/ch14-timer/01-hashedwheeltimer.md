# HashedWheelTimer：为什么 Netty 愿意用一个“不精确”的时间轮，来换取成千上万个 I/O 超时的稳定调度

> 本文基于当前 Netty `HashedWheelTimer` 实现。前置：Ch11 HTTP 作为应用场景桥接、Ch10/Ch11 对 pipeline 与连接生命周期的理解；本文聚焦时间轮结构、`tick & mask` 定位、`remainingRounds` 跨轮机制、Worker 状态机、异步取消与 stop 收尾。不展开 Linux 内核时间轮或 JDK 定时器源码细节。

## HTTP 讲完以后，下一层自然会遇到“30 秒后做一件事”

HTTP 那两篇走到最后，其实已经把一个更底层的问题逼到了台前。

无论是：

- keep-alive 空闲检测
- 请求超时
- 重试退避
- 连接池里的 idle eviction
- 代理隧道的读写超时

它们背后都会落成一句很朴素的话：

```text
请在未来某个时间点，再回来检查或执行一件事。
```

如果只有个位数、几十个这样的任务，这并不构成设计问题。标准库里的定时器、线程池，甚至自己起个后台线程轮询，都还能勉强凑合。

可 Netty 面对的是另一种规模：

- 一台进程里可能同时挂着成千上万条连接
- 每条连接又都可能带着自己的读超时、写超时、心跳超时
- 这些 timeout 大多并不要求精确到 1ms
- 但它们会非常密集、非常常见、而且长期存在

这时如果你还是把所有 timeout 都当成“精确闹钟”去管理，问题就不再是“能不能做到”，而是：

```text
你为了管理这些 timeout，自己会不会先把调度器拖成系统热路径？
```

最典型的对照就是优先队列思路。

假设有 10000 个超时任务，每次新任务进来都按截止时间插入最小堆。单次插入的复杂度是 `O(log N)`；对 10000 级别，log 大概是 13 左右。单看一个任务没什么，但当连接和超时大量并发出现时，你实际上在不断支付：

```text
插入比较
堆调整
堆顶检查
删除后重排
```

这套成本对“少量高精度定时任务”很合理，对“大量近似 I/O 超时”就不一定划算了。

`HashedWheelTimer` 的立场非常鲜明：

```text
我不是要做一个毫秒级精确定时器；
我是要用足够好的近似精度，
去稳定地调度海量 I/O timeout。
```

这也是为什么当前类注释开头第一句话就说它是 “optimized for approximated I/O timeout scheduling”，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:45`。

所以本篇最重要的理解前提不是“时间轮比堆更高级”，而是：

```text
HashedWheelTimer 在解决的是另一类问题：
大量、长期存在、允许近似精度的超时任务。
```

## 一、如果继续把所有 timeout 都扔进全局排序结构，会在三处持续付费

### 1. 失败方案一：每个 timeout 都进一个按 deadline 排序的全局最小堆

这是最经典的定时器设计之一，也是很多人最先想到的方案。

每来一个任务：

- 算出 deadline
- 丢进优先队列
- 后台线程每次看堆顶是不是到期
- 到期就弹出执行

这个方案最大的优点是语义直观：

```text
最先到期的任务永远待在堆顶。
```

可它的成本同样直观：

- 插入 `O(log N)`
- 删除堆顶后重排 `O(log N)`
- 取消中间任务如果要精确删除，往往也不便宜

当 N 很大时，你不是在为“真正到期的那些任务”付费，而是在为“维持全局精确有序”这件事持续付费。

而 Netty 这里面对的大量 I/O 超时，很多并不需要这种全局精确排序。一个 30 秒连接超时，实际在 30.0 秒还是 30.08 秒触发，业务多数时候根本不在乎；但如果为了这种不敏感的超时仍然维持堆排序，你就把本来不该昂贵的东西做贵了。

所以 `HashedWheelTimer` 的第一层顿悟就是：

```text
并不是每一种未来任务，都值得用“全局按 deadline 精确排序”的方式管理。
```

### 2. 失败方案二：那就不用堆，后台线程每次扫全部 timeout 看谁到期

第二条路看起来更粗暴：既然排序贵，那我不排了。后台线程每次 tick 直接扫一遍所有 timeout，凡是 `deadline <= now` 就执行。

这当然能工作，但复杂度从另一头炸开：

- 有多少 timeout，就得扫多少
- 哪怕只有 3 个任务此刻真的到期，也要把那 10000 个全扫一遍
- 随着连接数上升，你每个 tick 的固定工作量会线性变大

也就是说，这条路虽然省掉了堆的插入重排，却把“到期检查”的成本变成了：

```text
每个 tick 都重新确认全世界谁还没到期。
```

这对高密度 timeout 来说同样不经济。

### 3. 失败方案三：既然 timeout 都已经落桶了，外部线程 cancel 时直接从 bucket 链表删掉不就行了

第三条路是局部优化常见陷阱。

如果 timer 已经有 bucket 和链表，那取消任务时看起来最直接的做法就是：

- timeout 里不是已经知道自己在哪个 bucket 吗
- 外部线程 cancel 时直接去改 `prev/next`
- 这样似乎能立刻从链表里删掉，何必再排队

问题在于，当前 bucket 链表是 Worker 线程独占遍历和修改的数据结构。外部线程如果同时进去改：

- 正在遍历的指针可能被并发改断
- head/tail 更新可能和当前 tick 的 expire/remove 交叠
- 最后不是链表损坏，就是要回退到大量加锁

所以“外部线程直接碰 bucket 链表”本质上是在偷走时间轮最大的简洁性：

```text
桶内链表只让一个线程碰，
这样 prev/next 才能简单、便宜，而且不必处处加锁。
```

这就把时间轮真正需要的三件事逼了出来：

- 不能全局排序
- 不能全量扫描
- 不能让所有线程直接并发碰桶内结构

`HashedWheelTimer` 的整体结构，正是为了同时绕开这三种成本。

## 二、时间轮总图：wheel、mask、tickDuration 和“只看当前桶”

先别急着抠源码细节，先把时间轮本身的心智图立起来。

当前类的核心字段很直接：

- `tickDuration`
- `HashedWheelBucket[] wheel`
- `int mask`

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:110`。

这三者可以压成一张文字图：

```text
时间轴被切成固定 tick
每个 tick 往前走一格
wheel 是一圈 bucket
当前 tick 只处理 wheel 上的一个槽位
```

如果默认配置是：

- `ticksPerWheel = 512`
- `tickDuration = 100ms`

那么一整圈时间跨度就是：

```text
512 * 100ms = 51.2s
```

这不意味着 timer 只能处理 51.2 秒以内的任务，而是：

```text
一圈 bucket 只直接编码“未来 51.2 秒内的相对位置”；
超过一圈的部分，再用 remainingRounds 表示还要多转几圈。
```

### 1. 为什么 `wheel.length` 一定会被归一化成 2 的幂

构造函数里会先调用 `createWheel(ticksPerWheel)`，再把 `mask = wheel.length - 1`，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:288`。

而 `createWheel(...)` 内部第一步就是：

```text
ticksPerWheel = findNextPositivePowerOfTwo(ticksPerWheel)
```

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:335`。

这一步不是为了“数字好看”，而是为后面的 bucket 定位服务。

如果 wheel 长度是 2 的幂，那么：

```text
index = ticks & (wheel.length - 1)
```

就等价于：

```text
index = ticks % wheel.length
```

但前者只是一次按位与，后者是真正的取模运算。

所以完整性问题 #1 的第一半答案是：

```text
mask 取 wheel.length - 1，
是因为 wheel.length 被规范成 2 的幂后，
`tick & mask` 就能用一次位运算完成 bucket 定位。
```

### 2. 为什么这能算 O(1) bucket 定位

Worker 每次进入一个新 tick 时，当前 bucket 下标是：

```text
idx = (int) (tick & mask)
```

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:494`。

这一步没有：

- 没有遍历 bucket
- 没有按 deadline 比较排序
- 没有全局扫描

它只是在“时间轮已经切好、当前是第几个 tick”的前提下，做一次定位。

所以完整性问题 #10 的关键不是“时间轮 magically 更快”，而是：

```text
它把“找该检查哪个 bucket”这件事，
从全局数据结构操作，降成了当前 tick 的局部索引运算。
```

### 3. `newTimeout()` 提交任务后，并不是立刻塞进 bucket

`newTimeout(...)` 的主线是：

- 先 `pendingTimeouts.incrementAndGet()`
- 必要时检查 `maxPendingTimeouts`
- 调用 `start()`，确保 worker 启动
- 计算 deadline
- 构造 `HashedWheelTimeout`
- 丢进 `timeouts` 这个 MPSC 队列

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:431`。

这里一个很重要的事实是：

```text
外部线程提交 timeout 时，
它并不直接把 timeout 放进某个 bucket；
它只是先放进一个待转移队列 timeouts。
```

真正把它们放进 wheel 里的，是 Worker 线程下一轮 tick 开头的 `transferTimeoutsToBuckets()`，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:522`。

这回答了完整性问题 #12：`newTimeout()` 只是登记和排队，真正进入对应 bucket、等待未来执行，要等 Worker 在后续 tick 中转移并处理。

### 4. `INSTANCE_COUNT_LIMIT=64` 是提醒你“别把 timer 当连接级对象”

类里还有一个经常被误会的常量：`INSTANCE_COUNT_LIMIT = 64`，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:92`。

它不是硬性上限，不会阻止你继续 new；它的作用是在实例数过多时打一个 error 级别日志，提醒你这个 timer 本来就是应该共享的资源，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:316` 与 `:467`。

这和类注释里“Do not create many instances”是同一条原则：

```text
HashedWheelTimer 自己就会起一个 worker 线程；
如果你为每个连接建一个 timer，
那你不是在节省调度成本，而是在制造线程和调度器本身的风暴。
```

所以完整性问题 #9 的答案是：它是告警阈值，不是硬限制；真正的设计意图是鼓励少量共享实例，而不是大量连接级实例。

## 三、`remainingRounds`：一圈装不下的 timeout，不是“放错桶”，而是“先放目标桶，再等多转几圈”

现在进入时间轮里最容易被误解、也最关键的一层：跨轮。

如果 wheel 一圈只有 51.2 秒，而我提交了一个 5 分钟后的 timeout，难道它根本放不下吗？

当前实现的答案不是“扩容到很大”，也不是“为长延时单独走另一套结构”，而是：

```text
先把它放到最终应该命中的那个 bucket，
再记住：在真正执行前，这个 bucket 还得先经过多少整圈。
```

这个“还得再绕几圈”的数字，就是 `remainingRounds`。

### 1. “轮”到底是什么

可以把 wheel 想成一个钟表盘。

- bucket 是刻度槽位
- Worker 每个 tick 往前走一格
- 走完一圈后，槽位会再次被访问到

如果某个 timeout 的目标槽位正好是 42，那么：

- 它第一次落到 bucket 42 时，不意味着一到 42 就该执行
- 还要看它是不是“这一圈的 42”就到期，还是“第三圈的 42”才到期

也就是说，bucket 下标只解决了：

```text
它最终应在哪个槽位被检查。
```

而 `remainingRounds` 解决的是：

```text
到真正能执行之前，这个槽位还要被白看见多少次。
```

这就是完整性问题 #11 里“走完一圈后 bucket 里的 timer 还没到期怎么办”的本质答案。

### 2. `remainingRounds` 在源码里是怎么计算的

Worker 转移 timeout 时，关键公式是：

- `calculated = timeout.deadline / tickDuration`
- `remainingRounds = (calculated - tick) / wheel.length`
- `ticks = max(calculated, tick)`
- `stopIndex = (int) (ticks & mask)`

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:536`。

这里真正该抓住的不是公式本身，而是两层语义：

1. `calculated` 表示这个 timeout 理论上落在第几个 tick。
2. `stopIndex` 只取这个 tick 对 wheel 长度的模，表示未来哪一个 bucket 会负责它。
3. `remainingRounds` 则表示，从当前 tick 到真正执行 tick 之间，还要完整绕多少圈。

所以完整性问题 #2 的第一半答案是：

```text
remainingRounds 的作用，
就是把“超出当前一圈的那部分距离”从 bucket 下标里拆出来，
单独按整圈计数保存。
```

### 3. `expireTimeouts()` 为什么只看当前 bucket，也不会错过长延时任务

bucket 到期扫描时，如果某个 timeout：

- `remainingRounds > 0`
- 且它没取消

当前实现只做一件事：`remainingRounds--`，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:797`。

只有当：

- `remainingRounds <= 0`
- 且 `timeout.deadline <= deadline`

时，才真正执行，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:789`。

这说明 bucket 并不是“命中就执行”，而是“命中时检查是否还欠几圈”。

所以一个 5 分钟后的 timeout 会怎样？

- 它会先被放进未来应该命中的 bucket，比如 bucket 42
- 第一次转到 42：`remainingRounds` 还很大，只减 1
- 第二次转到 42：继续减 1
- ...
- 直到某次轮到 42 时 `remainingRounds == 0`，再和 deadline 做最后确认，才执行

这就把“bucket 数固定”和“延时范围可远超一圈”两件看似矛盾的事统一起来了。

### 4. 为什么还要额外检查 `timeout.deadline <= deadline`

你可能会想：既然 `remainingRounds == 0` 了，不就执行吗？

当前实现没有这么粗糙。它还会检查 `timeout.deadline <= deadline`，否则直接抛 `IllegalStateException`，认为 timeout 被放错了槽位，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:790`。

这条检查不是多余防御，而是在为时间轮的正确性兜底：

```text
remainingRounds 负责“圈数”正确；
deadline 检查负责“圈内相对时机”不被提前触发。
```

所以当前实现不是“近似就可以乱一点”，而是：

- 整体调度精度允许 tick 粒度近似
- 但一旦 bucket 计算出错，仍然把它当成逻辑错误处理

## 四、`HashedWheelBucket`：为什么 timeout 自己就是双向链表节点

现在看桶内结构。

每个 bucket 不是 `List<TimerTask>`，也不是再包一层 `Node`。当前实现是：

- `HashedWheelBucket` 只维护 `head` / `tail`
- `HashedWheelTimeout` 自己带 `next` / `prev` / `bucket`

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:631` 和 `:760`。

这就是大纲里“Timeout 自身作为链表节点”的源码事实。

### 1. 为什么不额外建 `LinkedList.Node`

如果每个 timeout 再额外包一层节点对象，那么：

- 每注册一个 timeout，不只是 new timeout，还得 new node
- 取消和执行后，这个 node 还会变成额外 GC 垃圾
- 海量 timeout 场景下，对象数量会持续翻倍式放大

当前实现直接把 timeout 本身当节点，等于把：

```text
task 元数据 + deadline + 状态 + 链表指针
```

放在同一个对象里。

所以完整性问题 #7 的答案并不需要精确到“节省多少字节”才能成立。关键是：

```text
它避免了为桶内组织结构再额外制造一层短命 Node 对象，
从而减少 GC 压力和指针间接访问。
```

### 2. `addTimeout()` 只是尾插，桶内不排序

bucket 的 `addTimeout(...)` 非常简单：

- 空桶时 head=tail=timeout
- 否则 tail.next=timeout，timeout.prev=tail，再更新 tail

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:768`。

这意味着桶内链表不是按 deadline 排序的。

这一点很重要，因为它再次强调了时间轮的思路：

```text
全局不排序；
桶内也不再按更细粒度排序；
只要落到对的 bucket，并在对的圈数上被看见，就够了。
```

这也是它能把大量调度成本压到 O(1) 级定位上的前提。

### 3. `expireTimeouts()` 遍历时为什么先取 `next`

`expireTimeouts(deadline)` 里，当前实现一进入循环就先保存：

```text
HashedWheelTimeout next = timeout.next;
```

然后才看当前 timeout 是否到期、是否取消、是否需要删掉，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:783`。

这是一个非常关键的遍历手法。

因为当前 timeout 一旦：

- `expire()` -> 内部会 `remove()`
- 或者后续某条路径把它 unlink

那么当前节点的 `next/prev/bucket` 很可能被清空。如果你等处理完当前节点后再读 `timeout.next`，链表遍历就可能断掉。

所以完整性问题 #3 的第一半答案是：

```text
它通过“先缓存 next，再处理当前节点”的顺序，
避免了当前节点在 expire/remove 后链表指针失效导致的遍历断裂或死循环。
```

### 4. 中段移除为什么是安全的

`remove(timeout)` 的逻辑是标准双向链表 unlink：

- `prev.next = next`
- `next.prev = prev`
- 如果是 head/tail，分别更新 head/tail
- 最后把 timeout 的 `prev/next/bucket` 置空

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:804`。

它之所以可以写得这么直接，是因为真正改链表的线程只有 Worker：

- 到期执行是在 Worker 上发生
- cancel 真正 unlink 也在 Worker 的 `processCancelledTasks()` 里发生

所以完整性问题 #3 的第二半答案是：

```text
移除之所以安全，
不是因为双向链表天生线程安全，
而是因为 bucket 链表的真正修改被约束在 Worker 单线程上下文里。
```

## 五、Worker：CAS 启动、绝对时间等待，以及为什么它不用 `sleep(100)` 这种相对时间循环

### 1. Worker 三态不是装饰，它是在表达 timer 自己的生命周期

当前 timer 有三个状态常量：

- `WORKER_STATE_INIT`
- `WORKER_STATE_STARTED`
- `WORKER_STATE_SHUTDOWN`

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:104`。

这三态的意义很直接：

```text
INIT
  -> timer 还没真正启动 worker 线程

STARTED
  -> worker 正在按 tick 推进

SHUTDOWN
  -> timer 已停止，不再接受正常运行语义
```

`start()` 和 `stop()` 全靠 `AtomicIntegerFieldUpdater` 做 CAS 切换，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:97`。

这回答了完整性问题 #8：不加锁的设计意图不是省几行代码，而是让外部线程可以并发调用 `start()` / `stop()`，同时把真正的状态跃迁收束成一次原子更新，而不用让每次启动都串行争抢显式锁。

### 2. `start()` 被反复调用时，为什么只会有一个线程真正启动

`start()` 的核心分支是：

- 如果当前是 `INIT`，尝试 CAS 成 `STARTED`
- 只有 CAS 成功的那个调用者才 `workerThread.start()`
- 如果已经是 `STARTED`，直接返回
- 如果已经 `SHUTDOWN`，抛异常

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:352`。

所以完整性问题 #8 的第二半答案是：

```text
start() 可以被多线程反复调用；
但只有一个线程能把状态从 INIT 抢到 STARTED，
也只有它能真正启动 workerThread。
其余调用要么看到已经 STARTED，要么看到已 SHUTDOWN。
```

这也是当前实现为什么不需要 `synchronized start()` 的原因：CAS 已经足够表达“只能启动一次”的生命周期约束。

### 3. `waitForNextTick()` 为什么必须用绝对时间，而不是“睡一个 tick 再醒”

Worker 的主循环每轮都会先调用 `waitForNextTick()`，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:493`。

当前计算方式是：

```text
deadline = tickDuration * (tick + 1)
currentTime = System.nanoTime() - startTime
sleepTime = deadline - currentTime
```

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:570`。

这意味着每一轮等待的目标，不是“再睡 100ms”，而是：

```text
从 startTime 开始算，第 N 个 tick 的绝对边界是哪里。
```

为什么这很重要？因为如果你写成：

```text
while (running) {
  sleep(100ms)
  transfer()
  expire()
}
```

那 `transfer()` 和 `expire()` 自己花掉的时间会不断累积进下一轮。比如：

- 第 1 轮 sleep 100ms，处理花 2ms
- 第 2 轮再 sleep 100ms，总时间已经 202ms
- 第 3 轮再 sleep 100ms，总时间 304ms

tick 边界会越来越晚，误差不断累积。

而当前实现每轮都重新对齐到从 `startTime` 推导出来的绝对 deadline，所以完整性问题 #4 的答案是：

```text
绝对时间等待会把每轮 tick 重新对齐到统一时间轴；
相对时间 sleep 会把上一轮处理开销持续叠进下一轮，形成漂移累积。
```

### 4. 为什么默认 100ms 精度对 I/O timeout 足够，而某些场景又不该用它

类注释已经直接说明：对大多数网络应用，I/O timeout 不需要高精度，因此默认 tick duration 是 100ms，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:47`。

这里的关键不是“100ms 永远最好”，而是：

```text
很多连接超时、心跳超时、空闲检测的时间尺度是秒级；
在 30 秒这个量级上，100ms 误差通常完全可接受。
```

所以完整性问题 #6 的第一半答案是：当前默认值与 I/O timeout 的尺度契合，因此换来的是更便宜的近似调度。

反过来，如果你的场景是：

- 高频交易撮合
- 子毫秒级调度控制
- 对精确截止时刻极敏感的实时系统

那 `HashedWheelTimer` 就不是你该优先选的结构。它从设计上就承认自己是近似 timer，而不是高精度 timer。

### 5. Windows 特判说明“等待”本身也是跨平台实现细节

`waitForNextTick()` 里还有个很少被讲、但很说明问题的分支：如果运行在 Windows 上，会把 `sleepTimeMs` 向 10ms 对齐，最小也至少睡 1ms，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:585`。

这不是时间轮的理论核心，却很能说明当前实现的工程取向：

```text
它不是只在纸面上实现一个 timer wheel，
还要处理真实 JVM/平台在 sleep 粒度上的怪癖。
```

所以 Worker 的复杂度并不只在 bucket 算法，还在“如何尽量稳定地走过每个 tick”。

## 六、`newTimeout()`、transfer、cancel、stop：一个 timeout 从提交到执行，再到取消或收尾的完整生命周期

最后把所有局部结构收回到一条完整流程里。

### 1. `newTimeout()`：外部线程只负责登记，不负责落桶

当业务调用：

```text
timer.newTimeout(task, delay, unit)
```

当前实现会：

- 先递增 `pendingTimeouts`
- 必要时检查 `maxPendingTimeouts`
- `start()` 确保 Worker 线程已启动
- 计算相对 `startTime` 的 deadline
- 创建 `HashedWheelTimeout`
- 加入 `timeouts` MPSC 队列

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:431`。

这一步最关键的分工是：

```text
外部线程只会碰“待转移队列”；
真正决定 bucket、remainingRounds、链表位置的，是 Worker。
```

这也是它能同时支持多生产者并发提交，而不让外部线程直接碰轮盘内部结构的原因。

### 2. transfer：为什么每个 tick 最多只搬 100000 个 timeout

Worker 每轮 tick 会先跑 `transferTimeoutsToBuckets()`，但源码专门限制：每 tick 最多转移 100000 个 timeout，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:522`。

这个上限的意义很务实：

```text
如果外部线程此刻正在疯狂提交新 timeout，
Worker 不能为了搬运新任务，把整个 tick 都耗死在 transfer 上，
否则到期任务本身反而饿住了。
```

所以这条限制不是随意拍脑袋，而是在保护 Worker 的节拍稳定性：

- transfer 很重要
- 但 expire 当前 bucket 的任务也同样重要
- 不能让某一侧无界吞掉整个 tick 预算

### 3. `cancel()` 为什么不直接删链表，而是先改状态再入 `cancelledTimeouts`

`HashedWheelTimeout.cancel()` 的逻辑非常清楚：

- 先 CAS `ST_INIT -> ST_CANCELLED`
- 成功后把自己放进 `timer.cancelledTimeouts`
- 真正 unlink 留给 Worker 下一轮 `processCancelledTasks()` 去做

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:656` 与 `:547`。

这就是完整性问题 #5 的答案：

```text
cancel 不直接改 bucket 链表，
是因为链表由 Worker 单线程独占；
外部线程只做状态变更和排队委托，
真正 unlink 在 Worker 上执行，避免并发改链表。
```

这和前面 HTTP aggregator/codec 里的“外部线程不要直接碰内部运行态结构”是同一种设计风格：

- 外部线程负责请求
- 拥有内部状态的一方负责真正修改结构

### 4. `expire()` 不是直接调用 task.run()，而是先从 timer 结构里摘掉，再交给 `taskExecutor`

当某个 timeout 到期时，`expire()` 会：

- CAS `ST_INIT -> ST_EXPIRED`
- 先 `remove()`，把自己从 bucket 脱链，并递减 `pendingTimeouts`
- 再把自己交给 `taskExecutor.execute(this)`

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:698`。

这一步非常值得注意，因为它说明：

```text
timeout 一旦被认定要执行，
它会先退出 timer 的内部数据结构，
然后再进入真正的任务执行阶段。
```

这样 Worker 的责任就非常清楚：

- 它负责调度、转移、到期判断
- 它不把“任务执行中”这个状态继续挂在 bucket 结构上

默认 `taskExecutor` 是 `ImmediateExecutor.INSTANCE`，但当前构造器也支持替换，见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:247`。

本文不展开 executor 策略，只记住当前执行入口即可。

### 5. `stop()`：不是简单停线程，而是把还没处理的 timeout 收回来

`stop()` 的语义也很完整：

- 不能在 Worker 自己线程里调用，否则抛异常
- 把状态切到 `SHUTDOWN`
- 打断并 join Worker 线程
- 收集 `unprocessedTimeouts`
- 对这些未处理 timeout 再尝试 cancel
- 返回最终未处理集合

见 `common/src/main/java/io/netty/util/HashedWheelTimer.java:378`。

这说明 `stop()` 的目标不只是“别再跑了”，还包括：

```text
把 timer 里那些已经注册、但还没真正执行掉的任务，
尽量以可观察、可回收的形式交还给调用者。
```

所以它不是粗暴的线程终止，而是一种调度器收尾协议。

## 七、误解澄清：时间轮的“近似”和“遍历”，都不能脱离它真正优化的规模去看

### 误解一：bucket 里还得遍历链表，所以时间轮并没有真正更快

错在把“桶内遍历”混成了“全局遍历”。

`HashedWheelTimer` 真正省下来的，是每个 tick 不用重新看全世界的 timeout，只看当前 bucket；bucket 内遍历只是局部成本。

### 误解二：`remainingRounds` 没有也能跑，最多多几次比较

不行。

没有 `remainingRounds`，超过一圈的 timeout 只能被错误地提前放进某个 bucket 后立即到期，或者被迫引入另一套复杂结构。它不是优化变量，而是跨轮语义本身。

### 误解三：`start()` 多次调用就可能起多个 Worker 线程

不会。

CAS 只允许一个调用者完成 `INIT -> STARTED`，其余调用只会看到已启动状态。

### 误解四：`cancel()` 直接改链表更快

局部看似快，整体会把 Worker 单线程独占结构打碎，最后只能回到加锁或链表损坏风险。

### 误解五：`INSTANCE_COUNT_LIMIT=64` 是硬性上限

不是。

它只负责告警，提醒你 timer 是共享资源，不该连接级创建。

### 误解六：HashedWheelTimer 适合所有高精度定时场景

也不是。

它的立场从类注释第一句就写明了：面向 approximated I/O timeout scheduling。近似精度是它用来换调度稳定性的前提，不是副作用。

## 八、收网：时间轮真正提供的，不是“更准的定时”，而是“更便宜的大量近似超时调度”

现在回到最初那个问题：为什么 Netty 愿意用一个“不精确”的时间轮？

因为在 Netty 关心的场景里，真正昂贵的不是“误差 100ms”，而是：

- 为成千上万 timeout 维持全局有序
- 每个 tick 全量扫描所有任务
- 让多线程直接并发碰内部链表结构

`HashedWheelTimer` 的整套答案可以压成三句话：

```text
第一，把时间切成固定 tick，只处理当前 bucket，避免全局排序与全量扫描。
第二，用 `tick & mask` 做 O(1) bucket 定位，用 `remainingRounds` 表达跨轮等待。
第三，让 Worker 单线程独占桶内结构，外部线程只通过 MPSC 队列提交和取消请求。
```

所以它真正提供的，不是“最精确的未来时刻触发器”，而是：

```text
一个为大量 I/O 超时量身定做的、近似但稳定的调度器。
```

从 ByteBuffer 的四字段状态机，到 ByteBuf 的引用计数与视图，到 EventLoop、Pipeline、Codec、HTTP，再到这里的时间轮，Netty 核心卷其实一直在回答同一类问题：

- 状态放在哪里
- 谁拥有它
- 谁可以改它
- 什么时候推进
- 出错和收尾时由谁兜底

`HashedWheelTimer` 只是把这套思路落到了“未来什么时候再回来做一件事”这个最后的运行时问题上。到这里，Netty 核心主线就真正收成了一个闭环。