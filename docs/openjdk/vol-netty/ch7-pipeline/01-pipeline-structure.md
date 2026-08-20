# Pipeline 的骨架：数据不是被一个 Handler 吃掉，而是沿链传播

> 本文基于当前 Netty `DefaultChannelPipeline` 与 `AbstractChannelHandlerContext` 实现。前置：Ch5 EventLoop 四篇、Ch6 Promise 三篇、Ch4 ByteBuf 五篇；本文只讲 Pipeline 的双向传播骨架、head/tail 哨兵、context 角色和线程归属，不展开 handler 分类与生命周期细节。

## ByteBuf 会流动，问题是：它到底流过谁

到第 6 章为止，Netty 的运行时基础已经相当完整：

- EventLoop 知道什么时候驱动 I/O 和任务。
- Promise/Future 知道异步结果怎么回来。
- ByteBuf 知道数据如何存储、切片、拼接和释放。

但还有一个比“怎么读写”更靠近业务的问题没有回答：

```text
一条消息读进来以后
是哪个对象先接住它？
解码、业务处理、编码、写回、异常处理
这些阶段按什么顺序流过？
```

最偷懒的办法当然是：把所有事情塞进一个 handler，甚至直接塞进 Channel 实现本身。

可一旦这样做，马上会出现几类纠缠：

- 解码逻辑和业务逻辑混在一起。
- 出站写回和入站读取共用一个巨大状态机。
- 想在业务处理前后插一个统计、限流或日志切面，变得困难。
- 同一个处理阶段想复用到别的协议或别的 Channel，又要整体拆代码。

所以 Netty 没把“收到一条消息以后怎么处理”写成一个大方法，而是把它建模成一条可插拔的责任链：数据可以沿这条链向前传播，也可以沿另一方向向后传播。

这就是 Pipeline。

本篇最重要的目标不是背熟几个类名，而是建立一张心智图：

```text
Pipeline 不是一个 handler 列表
它是一条带 head/tail 哨兵的双向链表
每个节点都是一个 ChannelHandlerContext
入站事件沿 inbound 节点向前传播
出站操作沿 outbound 节点向后传播
```

只要这张图立住，后面无论是 decoder、encoder、业务 handler，还是 flush、close、exceptionCaught，它们都只是沿这条骨架流动的不同事件。

## 一、为什么不能把所有逻辑塞进一个 Handler

### 1. 因为入站和出站本来就不是一条方向

假设一个最小的服务端处理链：

```text
Socket.read -> 解码 -> 业务处理 -> 编码 -> Socket.write
```

如果把这条链全塞进一个 handler，那么这个 handler 至少要同时承担：

- 入站方向：收到字节、切分消息、转换对象。
- 业务方向：判断协议、访问状态、生成响应。
- 出站方向：把对象重新编码成字节并发送。
- 异常方向：前面任一阶段抛错后的处理。

更麻烦的是，这几类动作并不共享同样的传播方向：

```text
入站：从 Socket.read 往“业务上层”走
出站：从业务 write 往 Socket.write 走
```

这就意味着一个“大一统 handler”其实内部已经偷偷包含了两条责任链，只不过这些边界全都藏在 if/else 和方法调用里。

Pipeline 的第一层价值，就是把这两条本来就存在的方向显式化。Netty 不再假装所有事件都是一条单向流水，而是承认：

```text
入站和出站本来就是两条相反方向的传播
```

### 2. 因为真正需要的是“能插、能跳、能局部替换”

一旦承认处理链有多个阶段，接下来最重要的能力就不是“能不能处理”，而是：

- 能不能在业务前插一个 decoder。
- 能不能在业务后插一个 encoder。
- 能不能只处理 inbound，而对 outbound 透明跳过。
- 能不能在某个 Channel 上临时加一个 handler，不影响别的 Channel。

这些能力如果靠一个巨型 handler 里的条件分支来实现，就会越来越像脚手架堆叠。Pipeline 则把它们变成结构能力：你不是修改一个大方法，而是在链上插入、删除、替换节点。

所以本篇后面所有链表、context、head/tail 的细节，最后都服务于一个很朴素的设计目的：

```text
数据处理阶段应该是可组合的
而不是被一个类永久焊死
```

## 二、先看总图：入站和出站沿同一条链走相反方向

### 1. 官方文档本身就先给了“方向图”

`ChannelPipeline` 的接口文档没有一上来就讲实现类，而是先画了一张图：左边是 inbound handlers 自下而上，右边是 outbound handlers 自上而下，底部连接 Socket.read 和 Socket.write，见 `ChannelPipeline.java:84-123`。

这张图已经把最小心智模型说透了：

```text
Socket.read 产生入站事件
  -> 经过一串 inbound handler
  -> 走向业务处理层

业务发起 write/flush/close
  -> 经过一串 outbound handler
  -> 最终落回 Socket.write 或其他实际输出动作
```

它还有一个非常重要的补充：Pipeline 会跳过那些与当前方向无关的 handler。比如只实现 outbound 接口的 handler，不会参与 inbound 事件；只实现 inbound 接口的 handler，不会参与 outbound 操作，见 `ChannelPipeline.java:113-123`。

这说明 Pipeline 不是“每个节点每次都得过一遍”的死板链条，而是会按 handler 的能力类型做方向过滤。

### 2. 真正传播的是事件，不是“调用下一个对象的某个固定方法”

文档里把传播方法列得很清楚。

Inbound 方向靠的是：

- `fireChannelRegistered()`
- `fireChannelActive()`
- `fireChannelRead(msg)`
- `fireExceptionCaught(cause)`
- ...

Outbound 方向靠的是：

- `bind(...)`
- `connect(...)`
- `write(msg, promise)`
- `flush()`
- `close(promise)`
- ...

见 `ChannelPipeline.java:125-175`。

这告诉我们，Pipeline 真正组织的不是“某个类表里的对象”，而是“不同种类事件的传播路径”。handler 只是在对应事件到来时参与处理。

所以如果把 Pipeline 只理解成一个“handler 列表”，你会漏掉最重要的一点：

```text
同一条链上跑的不是一种操作
而是一组有方向、有类型的事件
```

### 3. “从哪里开始”也因方向而不同

入站事件通常从 head 一侧进入用户 handler 链，再往 tail 方向靠近业务上层；出站操作则从业务当前 context 往前找到最近的 outbound 节点，再一路回到 head，最后打到真正的 `unsafe.write/flush`。

这里先记住方向，不急着看实现代码。因为一旦先把实现细节压进脑子，读者很容易忘了：Head/Tail、双向链表、mask 跳过，这一切首先是在落实“同一条链要承载相反传播方向”这个需求。

## 三、默认结构为什么是带 Head/Tail 的双向链表

### 1. Pipeline 一开始就有两个哨兵

`DefaultChannelPipeline` 构造时会先创建 `tail`，再创建 `head`，然后连成：

```text
head.next = tail
tail.prev = head
```

见 `DefaultChannelPipeline.java:91-101`。

这说明一个新 Pipeline 从来不是“空列表”，而是天然有两个边界节点：

- `HeadContext`
- `TailContext`

用户添加的 handler 只是在这两个哨兵之间插入。

这条设计立刻解决了一个经典链表问题：传播到边界时，不需要写一堆“如果没有下一个节点怎么办”。因为最前和最后永远有东西在那儿接住。

### 2. 为什么不是数组，而是双向链表

`addFirst0`、`addLast0`、`addBefore0`、`addAfter0` 都在操作 `prev/next` 指针，见 `DefaultChannelPipeline.java:212-235`、`:249-279`。

这说明默认结构是一个典型双向链表，而不是数组或普通 list。

原因也很直白：Pipeline 需要高频支持这些动作：

- 在头尾添加 handler。
- 在某个 handler 前后插入新 handler。
- 删除或替换中间某个 handler。
- 按入站/出站方向向前或向后找下一个合适节点。

数组对“顺序存储、偶尔追加”很友好，但对“中间频繁插入/删除并且要双向遍历”就不够自然。双向链表正好反过来：

```text
插入/删除一个节点
  -> 改几条 prev/next 指针
向前/向后传播
  -> 顺着 prev/next 找下一个 context
```

这并不是说链表在任何情况下都更快，而是说它和 Pipeline 的操作模式更契合。

### 3. `addFirst/addLast` 只是表面 API，真正插入的是 context

`DefaultChannelPipeline.internalAdd(...)` 会先创建一个新的 context，再根据 `ADD_FIRST/ADD_LAST/ADD_BEFORE/ADD_AFTER` 选择具体插入策略，见 `DefaultChannelPipeline.java:161-205`。

这一步很关键：插入进链表的不是 handler 本身，而是“包住 handler 的 context”。也就是说，Pipeline 节点不是 `ChannelHandler`，而是：

```text
ChannelHandler + executor 归属 + mask + prev/next + 生命周期状态
```

所以 context 不是实现细节小壳子，而是整条责任链真正的节点。后面看传播时，这个认识会变得尤其重要。

## 四、Head/Tail 为什么是哨兵，而不是普通用户 Handler

### 1. Tail 是 inbound 的最后兜底者

`TailContext` 继承 `AbstractChannelHandlerContext` 并实现 `ChannelInboundHandler`。它的很多方法要么空实现，要么把“无人处理的事件”交给 pipeline 的未处理分支，见 `DefaultChannelPipeline.java:1263-1322`。

可以把 Tail 理解成：

```text
如果一个 inbound 事件一路往后传播
最后没有任何用户 handler 真正接住它
Tail 就是最后的兜底边界
```

这让 Pipeline 不需要在每次 `fireChannelRead` 时反复判断“后面还有没有 handler”。就算真的一路走到尽头，也还有 Tail 这个稳定节点接住“没人管”的情况。

### 2. Head 是 outbound 的真正落地口

`HeadContext` 同时实现 `ChannelOutboundHandler` 和 `ChannelInboundHandler`，但它最重要的工作，是持有 `unsafe`，并把出站操作真正打到底层 `Channel.Unsafe` 上，见 `DefaultChannelPipeline.java:1324-1392`。

例如：

- `bind(...)` -> `unsafe.bind(...)`
- `connect(...)` -> `unsafe.connect(...)`
- `write(...)` -> `unsafe.write(...)`
- `flush()` -> `unsafe.flush()`

这说明 Head 的角色不是“又一个普通 handler”，而是：

```text
出站传播的最终桥接点
负责把 pipeline 里的逻辑操作变成 channel 底层动作
```

所以 Head/Tail 不是为了凑完整链表而随便塞的两个节点，而是分别把：

- 入站无人消费的尾边界
- 出站真正打到 I/O 的头边界

显式化了。

### 3. Pipeline 自身的 `write/flush/fireChannelRead` 为什么分别从 tail 或 head 启动

当前 `DefaultChannelPipeline` 自身对外的 `write/flush/fireChannelRead` 等方法，最终会从固定边界节点启动：

- `fireChannelRead(msg)` 通过 `head.fireChannelRead(msg)` 进入入站传播。
- `write(msg)` / `flush()` 通过 `tail.write(msg)` / `tail.flush()` 进入出站传播。

见 `DefaultChannelPipeline.java:915-1036`。

这恰好验证了前面那张方向图：

```text
入站事件从 head 方向开始往后找 inbound 节点
出站操作从 tail 方向开始往前找 outbound 节点
```

Head/Tail 因此也是传播起点的固定锚点，不只是链表的首尾占位符。

## 五、真正传播事件的不是 Pipeline，而是每个 Context

### 1. Context 才是链表节点的完整形态

`AbstractChannelHandlerContext` 持有：

- `prev` / `next`
- `pipeline`
- `name`
- `executionMask`
- `childExecutor`
- `contextExecutor`
- `handlerState`

见 `AbstractChannelHandlerContext.java:62-116`。

这比“一个 handler 节点”丰富得多。它不仅知道自己包着谁，还知道：

```text
前后邻居是谁
这个 handler 支持哪些事件掩码
事件该在哪个 executor 上执行
当前 handlerAdded/Removed 到哪一步了
```

所以 Context 的本质可以先压成一句话：

```text
Pipeline 里的一个节点，不是 handler 本身
而是“handler + 传播元数据 + 线程归属 + 生命周期状态”
```

### 2. `executor()` 为什么默认回到 channel.eventLoop

`AbstractChannelHandlerContext.executor()` 会先看 `contextExecutor` 缓存；没有缓存时，若 `childExecutor != null` 就用它，否则回到 `channel().eventLoop()`，见 `AbstractChannelHandlerContext.java:133-140`。

这说明 Pipeline 里的 handler 默认仍然运行在所属 Channel 的 EventLoop 上；只有当某个 handler 被显式绑定到额外的 `EventExecutorGroup` 时，它才可能切到别的 executor。

这和 Ch5 的主线完全一致：默认线程亲和属于 channel.eventLoop，不会因为 Pipeline 的存在而自动丢掉。

### 3. `fireChannelRead` 的真正含义是“找到下一个能处理 inbound read 的 context”

`fireChannelRead(msg)` 并不是“把消息交给 Pipeline，让 Pipeline 从头扫一遍”。当前 `AbstractChannelHandlerContext.fireChannelRead` 的第一步是：

```text
next = findContextInbound(MASK_CHANNEL_READ)
```

然后根据 next 的 executor 决定：

- 如果已经在该 executor 线程里，直接 invoke。
- 否则 `executor.execute(...)` 切过去。

见 `AbstractChannelHandlerContext.java:341-360`。

这说明真正的传播模型是：

```text
当前 context 收到事件
  -> 跳过不处理这个 inbound 事件的节点
  -> 找到下一个匹配 mask 的 inbound context
  -> 在它的 executor 上执行 handler 方法
```

因此“Pipeline 会跳过无关 handler”这句文档描述，在源码里不是抽象概念，而是由 `findContextInbound(mask)` 和 execution mask 真正落实的。

### 4. 线程切换也发生在 context 这一层

如果下一个 context 绑定了不同 executor，而当前线程不在它的 executor 中，就不是当前线程直接去调 handler，而是把传播动作包装成任务丢给 next.executor()，见 `AbstractChannelHandlerContext.java:148-175`、`:341-360`。

这非常关键。它说明 Pipeline 不只组织“谁处理谁”，还组织“在哪个线程里处理谁”。

所以 context 的职责其实有两层：

```text
一层：方向过滤和链表跳转
一层：线程归属判断与必要的执行器切换
```

这也是为什么正文不能把 Pipeline 讲成“纯链表结构文”。如果忽略 executor 归属，读者只会看到一个静态责任链，却看不到它和 EventLoop 的真正连接点。

## 六、childExecutor：为什么同一个 group 的 handler 默认会 pin 到同一条线程

### 1. Pipeline 允许单个 handler 挂到额外的 EventExecutorGroup

`DefaultChannelPipeline.newContext(...)` 创建 context 时会调用 `childExecutor(group)`，见 `DefaultChannelPipeline.java:118-143`。

如果没有显式 group，就返回 null，后续 executor() 会回退到 channel.eventLoop。若传入了 `EventExecutorGroup`，Pipeline 需要从这个 group 里拿出一个 child executor 供该 handler 使用。

### 2. 默认行为不是“每次事件随机选 group.next()`

当前 `childExecutor(group)` 有一个非常关键的默认行为：如果 `SINGLE_EVENTEXECUTOR_PER_GROUP` 没被关闭，它会把同一个 `EventExecutorGroup` 对某个 channel 选出的 child executor 缓存起来，后续都复用同一个，见 `DefaultChannelPipeline.java:122-143`。

源码注释写得很明确：为同一个 channel pin 住 group 的一个 child executor，这样该 channel 在这个 group 上触发的事件，都尽量落到同一条线程。

也就是说，Pipeline 并不是每来一次事件就重新 `group.next()`。默认策略更像：

```text
这个 channel 第一次遇到这个 executor group
  -> 选一个 child executor
以后同一个 channel 再经过这个 group
  -> 继续用同一个 child executor
```

这能显著降低同一 channel 在同组多线程里乱跳造成的时序复杂度。

### 3. 为什么这条 pin 规则很重要

如果同一 channel 的同组 handler 每次都随机落到不同 child executor，虽然从 API 上看还是“使用了同一个 EventExecutorGroup”，但实际执行顺序、局部状态和并发交错都会复杂得多。

当前默认的 pin 行为，让 Pipeline 在允许“为某段 handler 绑定额外线程池”的同时，仍尽量保住按 channel 维度的线程稳定性。

这再次说明 Netty 的设计取向：允许灵活切 executor，但不鼓励无约束乱切。因为 Pipeline 的真正目标不是抽象地“支持并发”，而是让数据流在可控边界里前进。

## 七、最容易错的五个判断

### 1. Pipeline 就是一个 handler 列表

不成立。它是带 head/tail 哨兵的双向链表，而且真正节点是 `ChannelHandlerContext`，不是 handler 本身。

### 2. 入站和出站都沿同一方向遍历

不成立。入站沿 inbound 方向传播，出站沿 outbound 方向传播；head/tail 只是启动和落地边界不同。

### 3. Pipeline 自己负责逐个调用所有 handler

不成立。真正执行传播的是当前 context：它根据 mask 找下一个匹配节点，再决定直接调用还是切 executor。

### 4. Head 和 Tail 只是占位符，没有实际逻辑

不成立。Head 负责把 outbound 操作真正打到 `unsafe`，Tail 负责兜底未被消费的 inbound 事件。

### 5. 给 handler 配了 EventExecutorGroup，就表示每次事件都会随机落到 group 的任一线程

不成立。当前默认会为同一 channel pin 住同组的一个 child executor，除非显式关闭这条策略。

## 收网：Pipeline 把“数据流过谁”变成一条有方向的责任链

现在可以回答本章开头的问题：数据流进 Channel 以后，究竟是“谁在处理它”？

答案不是某个全能 handler，也不是 Channel 自己的一个大方法，而是一条由 `ChannelHandlerContext` 节点组成的责任链：

```text
结构上
  -> HeadContext <-> 用户 Context... <-> TailContext

传播上
  -> inbound 事件沿 inbound 节点向前找
  -> outbound 操作沿 outbound 节点向后找

线程上
  -> 默认回到 channel.eventLoop
  -> 必要时切到 context 绑定的 child executor
```

这让 Netty 能把：

- 解码
- 业务处理
- 编码
- 出站写回
- 异常兜底
- 生命周期回调

都组织成一条可以插拔、可跳过、可切线程的流动路径，而不是塞进一个巨大类里。

所以 Ch7 的第一篇最关键的结论不是“Pipeline 是个双向链表”，虽然这句话没错；真正该带走的是：

```text
Pipeline 让 Netty 把数据处理阶段显式拆成可传播、可插拔、可切线程的责任链
而 Context 才是这条责任链真正的执行节点
```

下一篇进入 handler 类型本身：既然 Pipeline 会按 inbound/outbound 能力跳过节点，那么这些 handler 到底分成哪几类？duplex 为什么能同时站在两条方向里？这就是 Ch7-02 要展开的内容。