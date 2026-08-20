# Selector 工程陷阱：裸 NIO 为什么还不够生产级

> 本文基于 JDK 11 Linux `EPollSelectorImpl`、`SelectorImpl` 与 `Selector` 契约。前置：Ch3-01 `01-selector-model.md`、Ch3-02 `02-select-loop.md`；本文不重复 select 循环的基础写法，只解释裸 Selector 在工程环境中最容易暴露的三个坑，并为 Ch4 ByteBuf 与 Ch5 EventLoop 留出入口。

## 循环能跑，不等于循环能扛住生产

到上一节为止，我们已经能拼出一个最小 NIO 服务端：一个线程持有一个 Selector，所有 Channel 注册进去，线程阻塞在 `select()`，醒来后遍历 `selectedKeys`，按 `OP_ACCEPT`、`OP_READ`、`OP_WRITE` 分流，再把本轮结果移除。

这套循环在演示代码里很漂亮。

但生产环境会继续追问三个问题：

- 如果 `select()` 醒来了，却没有任何 Channel 就绪，线程会不会一直空转？
- 如果另一个线程想叫醒正在 select 的线程，wakeup 的时序有没有窗口？
- 如果事件循环忘了 remove selected key，JDK 会不会替它自动收尾？

这三个问题表面上分属不同层面：第一个像操作系统问题，第二个像并发问题，第三个像集合使用问题。实际上它们共享一个根源：JDK NIO 把底层等待、唤醒和结果集维护的语义暴露得很直接，但没有替你补齐一层生产级的保护机制。

所以这里不要把它们简单归结为“JDK 有 bug”。更准确的说法是：

```text
JDK 给了你多路复用的原始能力
但工程上的异常时序、状态收尾和故障自愈
仍然要由上层框架自己补上
```

## 一、select() 空轮询：线程醒了，但没有事情可做

### 1. 先区分正常返回 0 和异常空转

`select()` 返回 0，本身并不一定是故障。

如果调用的是 `select(timeout)`，超时到达而没有 Channel 就绪，返回 0 是正常合同；如果调用的是 `selectNow()`，它本来就不等待，没有就绪事件时返回 0 也完全正常。上一节已经建立过：三种 selection 方法的本质差别就是等待方式和等待时长，见 `Selector.java:163-165`。

真正危险的是另一种形态：

```text
select() 返回 0
  -> 没有事件可处理
  -> 下一轮 select() 立即又返回 0
  -> 线程持续重复
```

这时问题不在某一次返回 0，而在于一个本来应该阻塞等待的循环，变成了高速重复调用。事件循环没有消费任何 I/O，却持续占用 CPU。

### 2. Linux JDK 11 的路径：epoll_wait 返回值如何一路上浮

要理解这个现象，必须把 JDK Java 层和 Linux 系统调用之间的路径接起来。

JDK 11 的 Linux Selector 实现是 `EPollSelectorImpl`。它的 `doSelect(...)` 先处理 interest 更新和待注销 key，然后进入 `EPoll.wait(...)`：

```text
processUpdateQueue()
processDeregisterQueue()
  -> EPoll.wait(epfd, pollArrayAddress, ..., timeout)
  -> 得到 numEntries
  -> processEvents(numEntries, action)
```

源码中，`EPoll.wait(...)` 的返回值直接保存到 `numEntries`，见 `EPollSelectorImpl.java:112-120`。如果系统调用返回 `IOStatus.INTERRUPTED`，JDK 只在定时等待场景下重新调整剩余 timeout，然后继续重试，见 `EPollSelectorImpl.java:121-130`。

正常情况下，返回值可以这样理解：

- `numEntries > 0`：epoll 报告了一个或多个就绪描述符，JDK 继续处理事件。
- `numEntries == 0`：这次没有得到就绪事件，可能是 timeout 到期或非阻塞查询没有结果。
- `numEntries == IOStatus.INTERRUPTED`：系统调用被信号等原因打断，JDK 按中断路径重试。

`processEvents(...)` 会遍历 `numEntries` 个事件；如果其中包含用于唤醒的 fd，就记下 interrupt；否则就找到对应的 `SelectionKeyImpl`，把底层事件交给 `processReadyEvents(...)`，见 `EPollSelectorImpl.java:181-207`。

因此，当 `numEntries == 0` 时，事件处理循环根本没有可处理的条目，`processEvents(0, action)` 会返回 0，`doSelect(...)` 也就没有新的就绪 key 可交给上层。但还要注意一个容易混淆的边界：`select()` 返回的是被更新的业务 key 数，不是 `epoll_wait` 返回的描述符数。如果 `numEntries > 0` 的唯一条目是唤醒 fd，`processEvents(...)` 也可能不更新任何业务 key，最终仍然返回 0，见 `EPollSelectorImpl.java:186-207`。

JDK 的职责在这里很克制：它忠实地把这次 epoll 查询的结果转成 Selector 结果，并没有在 Java 层维护一个“连续 0 次数”计数器，也没有因为某次 0 就擅自重建 Selector。

### 3. 空轮询是怎么把 CPU 推到 100% 的

在正常的阻塞场景里，`select()` 返回 0 后，调用方下一轮再次进入 `select()`，应该重新阻塞，等待下一次真实事件。

空轮询故障的危险在于：底层等待可能在某些系统调用边界条件下反复过早返回。这里需要把“JDK 能直接证明的事实”和“生产环境观测到的现象”分开：JDK 源码能证明它会把 epoll 查询结果向上转换；至于某些内核、文件描述符状态或系统调用边界为什么会触发连续的无事件返回，则属于具体平台与运行环境的问题，不是 `Selector` API 合同的一部分。

一旦这种过早返回持续发生，数据流就会变成：

```text
epoll_wait 过早返回
  -> numEntries == 0
  -> processEvents(0) 不处理任何 key
  -> select() 返回 0
  -> 事件循环再次调用 select()
  -> epoll_wait 再次过早返回
```

线程没有阻塞在 I/O 上，也没有推进业务状态，却不断执行方法调用、锁操作和循环判断。最终表现通常是：

- CPU 使用率突然升高。
- 连接数和业务流量没有对应增长。
- selectedKeys 可能长期为空。
- 日志里未必有异常，因为每一次调用本身都可以返回合法的 0。

这就是“空轮询”最难排查的地方：单次返回看起来没有违反 API 合同，真正异常的是连续时序。

### 4. 为什么 sleep 不是好修复

看到 CPU 空转后，一个直觉修复是：

```text
select() 返回 0
  -> sleep(1)
  -> 再 select()
```

它确实可能把 CPU 压下来，但代价是把故障从“忙等”换成“额外延迟”。如果下一毫秒真的来了连接事件，线程仍可能在 sleep 中，响应时间被人为拉长。

更糟的是，固定 sleep 无法同时适应不同负载：

- sleep 太短，CPU 仍然可能很高。
- sleep 太长，正常事件的响应延迟变大。
- 事件与 sleep 的边界还会制造新的时序抖动。

所以工程上的正确方向不是给 select loop 外面加一个固定延时，而是检测“连续无事件返回”的异常模式，并在达到阈值后恢复底层等待结构。

Netty 的做法会在 Ch5 EventLoop 中展开：它维护连续空 select 的计数，超过阈值后重建 Selector，把有效注册关系迁移到新 Selector，再关闭旧 Selector。这里先只留下判断原则：

```text
一次返回 0 可能正常
连续、快速、无事件的返回 0 才值得怀疑
```

## 二、wakeup 竞态：叫醒动作也有时序窗口

### 1. wakeup 解决什么问题

`wakeup()` 不是一个业务事件，也不会给 selectedKeys 凭空添加一把连接 key。它解决的是另一个问题：selector 线程可能正阻塞在 `select()` 里，而另一个线程刚刚提交了任务、修改了某个 key 的 interestOps，或者改变了事件循环下一轮要做的事情。

如果没有 wakeup，selector 线程可能继续睡到下一个 I/O 事件才回来，外部更新就无法及时生效。

JDK 的并发合同明确规定：selection 进行中的 interest set 变更不会影响当前这轮，只会在下一轮 selection 被看见，见 `Selector.java:216-218`。因此 wakeup 的角色是：

```text
让当前阻塞尽快结束
  -> 进入下一轮 selection
  -> 看见此前已经提交的更新
```

### 2. Linux JDK 11 如何实现 wakeup

Linux 下的 `EPollSelectorImpl` 在初始化时建立了一对用于中断的文件描述符，并把读端 `fd0` 注册进 epoll，见 `EPollSelectorImpl.java:61-63`、`:76-94`。

调用 `wakeup()` 时，JDK 并不是调用某个神奇的线程 API，而是向 pipe 的写端 `fd1` 写入一个字节：

```text
wakeup()
  -> interruptLock 加锁
  -> 如果还没有触发过：write1(fd1, 0)
  -> interruptTriggered = true
  -> epoll_wait 观察到 fd0 可读
```

这段实现见 `EPollSelectorImpl.java:249-262`。

`fd0` 不是业务 Socket，而是专门注册到 epoll 中的唤醒文件描述符。于是正在 `EPoll.wait(...)` 中阻塞的线程，会因为这个 fd 变成就绪而返回。

返回后，`processEvents(...)` 识别出这是 `fd0`，不把它当成业务 Channel，而是记下 `interrupted = true`；随后调用 `clearInterrupt()` 把 fd0 中的字节 drain 掉，并把 `interruptTriggered` 重置为 false，见 `EPollSelectorImpl.java:186-205`、`:264-268`。

所以 wakeup 的真实数据流是：

```text
线程 A: epoll_wait 阻塞
线程 B: wakeup()
  -> fd1 写入一个字节
线程 A: fd0 变成可读，epoll_wait 返回
  -> 识别为 interrupt fd
  -> drain fd0
  -> interruptTriggered = false
  -> 回到事件循环下一轮
```

### 3. 两层竞态：JDK 原生 wakeup 与上层状态标志不是一回事

先把 JDK 自己的实现边界说清楚：`EPollSelectorImpl.wakeup()` 在 `interruptLock` 内检查并更新 `interruptTriggered`，`clearInterrupt()` 也在同一把锁内 drain fd0 并重置标志，见 `EPollSelectorImpl.java:249-268`。就这段 JDK 实现而言，写入唤醒字节与清理标志之间有锁保护，不能简单描述成“clear 之后、下一次 epoll_wait 之前写入就一定丢失”。如果字节已经写入 fd1，它会留在唤醒管道中，后续 epoll 等待仍可能观察到它。

真正容易出问题的竞态，通常出现在上层事件循环为了减少 `selector.wakeup()` 调用而维护的另一个状态标志。Netty 的 `NioIoHandler` 就用 `wakenUp` 记录是否已经发出唤醒请求：外部线程先通过 `compareAndSet(false, true)` 设置它，再调用 `selector.wakeup()`，见 `NioIoHandler.java:614-618`。select 线程则在进入等待前把旧状态取成 false，返回后再检查一次，见 `NioIoHandler.java:433-465`。

这个优化会产生一个真实的时序窗口：

1. select 线程把 `wakenUp` 设为 false，但还没有进入 `selector.select(...)`。
2. 另一个线程看到 false，把它设为 true，并调用一次 `selector.wakeup()`。
3. select 线程随后进入 select，消费这次唤醒并立即返回。
4. 如果上层逻辑没有在合适位置重新建立下一轮状态，后续线程看到 `wakenUp` 仍为 true 时可能跳过真正的 `selector.wakeup()`。

Netty 源码把第 1 种时序标为需要再次 wakeup 的情况，并在 select 返回后检查 `wakenUp`，必要时再次调用 `selector.wakeup()`，见 `NioIoHandler.java:440-466`。这说明“wakeup 不丢”的结论不能从 JDK 的 fd 实现直接推广到任意上层 wakeup 标志协议；上层为了优化调用次数，可能重新引入自己的竞态。

JDK API 合同本身只保证：如果 selection 正在阻塞，wakeup 会让它立即返回；如果当前没有 selection，下一次 selection 会立即返回；两次 selection 之间多次调用的效果等同于一次，见 `Selector.java:592-606`。它不保证返回时一定有业务 key，因为返回也可能只由 wakeup、interrupt 或 close 触发。

因此更准确的判断是：

```text
JDK 原生 wakeup：有明确的唤醒标志和 fd 清理协议
上层 wakeup 优化：必须额外证明状态标志与 select 时序不会错位
select 返回：可能只是被叫醒，不代表有业务事件
```

否则你可能把 wakeup 返回误判成“有网络事件”，或者为了避免重复唤醒而在业务层自行加一套不完整的锁协议。

## 三、selectedKeys 累积：结果集消费者不收尾

### 1. 为什么 JDK 不自动替你 remove

上一节已经讲过，`selectedKeys` 不是每轮重新创建的快照。Selector 的 selection 操作会把新发现的 key 加进 selected-key set，或者更新已经存在 key 的 ready set，见 `Selector.java:105-108`、`:139-150`。

JDK 实现中的 `processReadyEvents(...)` 也把这条规则写得很直接：

- 如果 key 已经在 `selectedKeys` 中，调用 `translateAndUpdateReadyOps(...)` 更新 ready 状态。
- 如果 key 不在集合中，才把它 `selectedKeys.add(...)`。

见 `SelectorImpl.java:279-304`。

这意味着，Selector 是生产者，事件循环是消费者。JDK 不可能替你猜“消费者什么时候已经处理完了这个 key”，因此它不会在每轮 selection 后自动清空 selected-key set。

### 2. 不 remove 的第一层后果：同一个 key 反复进入业务分支

典型错误循环是：

```text
while (iter.hasNext()) {
    SelectionKey key = iter.next();
    handle(key);
    // 忘记 iter.remove()
}
```

本轮 `handle(key)` 返回后，这个 key 仍然留在 selectedKeys 中。下一轮 selection 如果底层又报告同一个 Channel 的 readiness，JDK 会更新它的 ready set，但不会因为 key 已经存在就自动把它移除。

于是下一轮迭代仍然能看到它：

```text
select()
  -> key1 加入 selectedKeys
处理 key1
  -> 忘记 remove
下一轮 select()
  -> key1 仍在 selectedKeys
  -> 再次遍历到 key1
```

如果业务处理本身没有推进 Channel 状态，例如没有读掉数据、没有关闭连接、没有关闭对应 interest 位，那么这个重复结果可能继续放大，最终表现为重复处理或事件循环空转。

### 3. 不 remove 的第二层后果：把 ready 状态误当成新事件

`readyOps` 记录的是 key 当前已经积累的 ready 位，而不是一个自动消费后清零的消息队列。对于仍留在 selectedKeys 中的 key，后续 selection 可能按位更新 ready set，旧的 readiness 也可能被保留，见 `Selector.java:145-150`。

如果上层没有建立清晰的消费边界，就容易产生一种错误判断：

```text
我这次已经处理过 OP_READ 了
所以下一轮看到 OP_READ 一定是全新的通知
```

但 selected-key set 的语义不是“每个事件只投递一次”。它更像一个持续维护的待处理结果集。你必须先用 `iter.remove()` 表示“本轮结果已经消费”，再进入下一轮 selection，让下一轮的新 readiness 重新进入结果集。

这就是为什么 `iter.remove()` 不是形式主义。它在事件循环里承担的是消息确认的作用：不是确认网络数据已经读完，而是确认“这条 selection 结果已经被当前消费者接手并处理过”。

### 4. cancel 交叉窗口：失效 key 可能暂时还在集合里

selectedKeys 累积和 cancel 还会叠加出另一个陷阱。

`key.cancel()` 会先把 key 标记为无效并加入 cancelled-key set，真正的 deregister 会在后续 selection 中处理。JDK 的 `processDeregisterQueue()` 在清理时才从 `selectedKeys` 和 `keys` 中移除它，见 `SelectorImpl.java:244-268`，其中从 selectedKeys 移除位于 `SelectorImpl.java:259`。

因此，下面这段时间是客观存在的：

```text
key.cancel() 已执行
  -> key.isValid() == false
  -> key 仍可能暂时出现在 selectedKeys
下一次 selection
  -> processDeregisterQueue()
  -> 才从 selectedKeys / keys 等集合移除
```

JDK 文档也明确提醒：key 出现在 selector 的一个或多个集合里，并不等于 key 仍有效，见 `Selector.java:220-224`。

所以处理 selectedKeys 时，稳妥顺序应该是：

```text
SelectionKey key = iter.next();
if (!key.isValid()) {
    iter.remove();
    continue;
}
处理 key;
iter.remove();
```

这里的 `isValid()` 检查和 `iter.remove()` 各有自己的职责：前者防止对失效关系继续做 I/O，后者保证当前结果被消费，不在 selectedKeys 里继续积累。

## 收网：裸 NIO 缺的不是能力，而是保护层

现在把三个陷阱放在一起看。

### 空轮询告诉你：底层等待结果可能需要健康检查

一次 `select()` 返回 0 可以正常，连续快速返回 0 就可能意味着底层等待结构已经失去预期行为。JDK 把 epoll 的查询结果交给你，但没有替你判断“这是不是连续异常”。

### wakeup 告诉你：跨线程协作不是一个原子动作

wakeup 可以打断阻塞，但可能发生在清理前、清理后或下一轮等待前。JDK 用 fd 和标志位保证唤醒请求不会轻易丢失，却没有把“业务任务提交 + 唤醒 + 下一轮消费”包装成你的完整调度协议。

### selectedKeys 告诉你：结果消费必须有确认边界

Selector 可以生产结果，但不知道你的业务何时处理完。JDK 保留 selected-key set 的持续语义，把 remove / clear 的责任留给事件循环。

所以裸 NIO 的真实状态不是“不能用”，而是：

```text
它提供了高效 I/O 多路复用的地基
但没有替你完成故障检测、跨线程调度和结果消费治理
```

这正是 Netty 继续向上构建的原因。后续章节会分别补上这些保护层：

- Ch4 先处理 ByteBuffer 的状态管理、视图与生命周期问题，解释为什么需要 ByteBuf。
- Ch5 再处理 EventLoop 如何包装 select、执行任务、检测空轮询并重建 Selector。
- 后续出站写缓冲结构则负责把 `OP_WRITE` 的按需开关从业务循环中收走。

如果说 Ch3-01 讲的是 Selector 的模型，Ch3-02 讲的是模型如何落成循环，那么这一篇要留下的判断就是：

```text
裸 NIO 的难点不在“能不能监听到事件”
而在“事件异常、唤醒竞态和结果消费失控时，谁来保护循环”
```

这也正好把问题交给 Ch4：当 select loop 已经把等待时机统一起来，下一层最先暴露出来的，就是 ByteBuffer 本身的状态管理成本。