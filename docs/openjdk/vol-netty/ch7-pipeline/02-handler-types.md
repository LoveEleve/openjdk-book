# Handler 类型与 mask：为什么 Pipeline 不需要每次都挨个问“你管不管这件事”

> 本文基于当前 Netty `ChannelInboundHandler` / `ChannelOutboundHandler` / `ChannelDuplexHandler` / `ChannelHandlerMask` / `SimpleChannelInboundHandler` / `CombinedChannelDuplexHandler` 实现。前置：Ch7-01 `01-pipeline-structure.md`；本文解释 handler 类型体系、`@Skip` 与位掩码、`@Sharable`/multiplicity、Simple 与 Combined 两类特殊包装，不展开 handler 生命周期和 initializer。

## Pipeline 的骨架已经有了，现在真正的问题是：谁该接这个事件

上一节已经把 Pipeline 的传播骨架讲清楚了：

- 它是带 head/tail 哨兵的双向链表。
- 入站事件沿 inbound 方向传播，出站操作沿 outbound 方向传播。
- 真正决定传播的是 `ChannelHandlerContext`，不是 Pipeline 主类自己挨个调 handler。

但骨架搭好以后，会立刻遇到一个非常实际的问题：

```text
链上这么多 handler
当前这个事件到底该落到谁头上？
```

如果答案是“每次都从当前节点往后看，挨个 `instanceof` 判断这个 handler 是不是 inbound/outbound，再决定要不要继续”，那 Pipeline 虽然能工作，但每次传播都在重复做同样的能力识别。

Netty 没有选择这条路。

它先把 handler 按职责分成 inbound / outbound / duplex 几大类，再用 adapter 提供默认转发实现，再通过 `@Skip` 和 `ChannelHandlerMask` 把“这个类哪些方法只是纯转发，可以跳过”预先编码成位掩码。到真正传播时，context 只需要：

```text
看一眼 executionMask
判断当前方向和事件位
决定这个节点该停下还是该被跳过
```

所以 Ch7 第二篇真正要回答的，不是“有哪些 handler 类”，而是：

```text
Pipeline 为什么能做到
只把事件送给真正关心这件事的 handler
而不必每次从零识别一遍
```

## 一、为什么 handler 还要分 inbound / outbound / duplex

### 1. 因为“收到数据”和“请求写出”根本不是一类事件

`ChannelInboundHandler` 处理的是：Channel 已经发生了什么。当前接口列出的典型回调包括：

- `channelRegistered`
- `channelActive`
- `channelRead`
- `channelReadComplete`
- `channelInactive`
- `channelWritabilityChanged`
- `userEventTriggered`
- `exceptionCaught`

见 `ChannelInboundHandler.java:22-75`。

这些事件有一个共同点：它们都是“已经发生在 Channel 身上的状态变化或入站数据”。

而 `ChannelOutboundHandler` 处理的则是：调用方想让 Channel 去做什么。它暴露的是：

- `bind`
- `connect`
- `disconnect`
- `close`
- `deregister`
- `read`
- `write`
- `flush`

见 `ChannelOutboundHandler.java:23-99`。

注意这里的 `read()`。这是最容易被新人看反的一个方法：它在 outbound 侧，表示“请求底层开始读”，而不是“已经读到了数据”。真正的数据到来通知仍然是 inbound 的 `channelRead`。

所以 inbound/outbound 的边界不在“名字里有没有 read/write”，而在事件语义：

```text
inbound  = 状态变化或数据已经到了
outbound = 我现在请求去做某个 I/O 操作
```

### 2. Duplex 不是第三种方向，而是“两种能力叠加在一个位置”

`ChannelDuplexHandler` 继承 `ChannelInboundHandlerAdapter`，同时实现 `ChannelOutboundHandler`，见 `ChannelDuplexHandler.java:23-29`。

它并没有创造出一种新的传播方向，而是把 inbound 和 outbound 两种能力叠加到同一个 handler 类里。适用场景非常直观：有些逻辑天然要同时看入站和出站，比如：

- 入站解码、出站编码是同一组协议语义。
- 某个统计/限流器既要看收到多少，也要看发出了多少。
- 某个状态机需要同时观察 connect/read/write/close 相关事件。

所以 handler 类型体系不是为了命名丰富，而是为了把“你到底处理哪类事件”提前说清楚。只有这层分工明确了，后面的跳过规则才有意义。

### 3. 类型划分最终服务于跳过

如果所有 handler 都统一实现一大堆 inbound 和 outbound 方法，那么 Pipeline 传播时根本没法先验判断“这个节点必然无关”。

当前类型划分让 Netty 能先得出一个粗结论：

```text
纯 inbound handler
  -> outbound 事件天然可跳过

纯 outbound handler
  -> inbound 事件天然可跳过

duplex handler
  -> 两边都可能命中，还要继续看具体方法位
```

所以分类不是装饰层，而是 mask 预计算的第一层输入。

## 二、Adapter 与 `@Skip`：默认转发不该每次真的进方法再转出去

### 1. Adapter 的本质是“我只关心少数几个方法”

`ChannelInboundHandlerAdapter` 和 `ChannelOutboundHandlerAdapter` 都是骨架类。它们几乎所有默认实现都只是把事件继续转给下一个节点。

例如 inbound adapter 的 `channelRead` 默认就是：

```text
ctx.fireChannelRead(msg)
```

见 `ChannelInboundHandlerAdapter.java:84-94`。outbound adapter 的 `write` 默认就是：

```text
ctx.write(msg, promise)
```

见 `ChannelOutboundHandlerAdapter.java:104-114`。`ChannelDuplexHandler` 的 outbound 默认实现也只是转发到下一个 outbound context，见 `ChannelDuplexHandler.java:31-128`。

这让绝大多数业务 handler 不需要实现 8 个或 9 个方法，只用覆盖自己真正关心的那几个。

### 2. 但“默认转发”如果每次都真正调用，也还是有成本

假设链上有一长串 `ChannelInboundHandlerAdapter`，其中某个事件真正只有第 5 个 handler 想处理，其余都只是默认 `ctx.fire...` 一下。如果每次传播都真的进入前 4 个方法，再由它们继续转发，虽然语义正确，但会造成大量无意义的栈帧和虚调用。

Netty 的答案不是删掉 adapter，而是在“默认实现只是纯转发”这件事上做静态标记。于是 `@Skip` 出现了。

### 3. `@Skip` 的意思不是“JVM 自己别调我”，而是“Netty 可以把这一步从传播路径里剪掉”

`ChannelHandlerMask.Skip` 注解定义在 `ChannelHandlerMask.java:188-204`。它的语义非常严格：只有当这个 handler 方法除了把事件转发给下一个节点之外，什么别的事都不做时，才允许打上 `@Skip`。

这点必须说清。`@Skip` 不是 Java 层的某种魔法，不会让 JVM 自动优化掉方法；也不是给开发者随手标“我懒得管这个方法”。它是 Netty 自己在预计算 handler 能力时读取的标记，用来说明：

```text
这个方法如果被调用，净效果只是继续传播
那就不如传播时直接跳过这个节点
```

所以 adapter 上那些 `@Skip`，本质上是在告诉 Pipeline：默认骨架方法不值得每轮真的进入。

## 三、`ChannelHandlerMask`：把“谁处理什么”预先编码成位掩码

### 1. 17 个位，不是在运行时临时拼出来的

`ChannelHandlerMask` 定义了一组位：

- 入站相关位：`MASK_CHANNEL_REGISTERED`、`MASK_CHANNEL_ACTIVE`、`MASK_CHANNEL_READ` ...
- 出站相关位：`MASK_BIND`、`MASK_CONNECT`、`MASK_READ`、`MASK_WRITE`、`MASK_FLUSH` ...
- 还有 `MASK_EXCEPTION_CAUGHT`

见 `ChannelHandlerMask.java:35-63`。

这些位先被组合成：

```text
MASK_ONLY_INBOUND
MASK_ONLY_OUTBOUND
MASK_ALL_INBOUND
MASK_ALL_OUTBOUND
```

也就是说，Netty 会先把“这类 handler 理论上可能关心哪些事件”编码成一个整数，再对具体方法做更细粒度裁剪。

### 2. mask 是按 class 缓存的，不是每次传播都重新反射

`ChannelHandlerMask.mask(clazz)` 会先从一个 `FastThreadLocal<WeakHashMap<Class<? extends ChannelHandler>, Integer>>` 中查缓存；找不到时才调用 `mask0(clazz)` 计算，再放回缓存，见 `ChannelHandlerMask.java:65-85`。

这说明 `mask` 的核心思路不是“传播时快”，而是“把传播时会重复做的能力识别前置到类级别、缓存起来”。

这里也顺便纠正一个常见误解：这个缓存和 `@Sharable` 不是一回事。它缓存的是“这个 handler class 的 execution mask”，不是“这个实例能不能跨 pipeline 复用”。

### 3. `mask0` 先看接口类型，再看方法是否 `@Skip`

`mask0(clazz)` 的流程大致是：

1. 先默认把 `MASK_EXCEPTION_CAUGHT` 打开。
2. 如果类实现 `ChannelInboundHandler`，先把所有 inbound 位都打开。
3. 如果类实现 `ChannelOutboundHandler`，先把所有 outbound 位都打开。
4. 再逐个反射检查对应方法是否带 `@Skip`；如果带了，就把那个位清掉。

见 `ChannelHandlerMask.java:91-164`。

所以一个 handler 的 execution mask 不是简单由“它实现了哪个接口”决定，而是由两层信息共同决定：

```text
第一层：我大类上属于 inbound / outbound / duplex 哪种
第二层：我在这些方法里，有哪些只是纯转发，可以跳过
```

这就把类型分类和 `@Skip` 真正连起来了：类型决定大方向，`@Skip` 决定细节裁剪。

### 4. `@Skip` 一旦被覆盖，就不再跳过

`ChannelHandlerMask.Skip` 的注释明确写着：这个注解不是继承性的。如果子类覆盖了某个带 `@Skip` 的方法，那它就不再自动跳过，见 `ChannelHandlerMask.java:193-196`。

这条边界非常合理：一旦你自己覆写了默认转发方法，就不能再假定它什么都不做。哪怕你现在只是多打印了一行日志，它也已经不再是“可以放心剪掉的空转发”。

这说明 `@Skip` 不是一种“方法类型标签”，而是一种非常具体的优化承诺：

```text
只有当这个实现真的什么都不做，只负责转发
Pipeline 才有资格把它跳过
```

## 四、为什么跳过要看 executor：不是同一线程，就不能随便跳

### 1. inbound/outbound 查找不是简单扫到下一个 mask 命中节点

`AbstractChannelHandlerContext.findContextInbound(mask)` 和 `findContextOutbound(mask)` 都会在链表上前进/后退，并通过 `skipContext(...)` 决定当前节点是否可跳过，见 `AbstractChannelHandlerContext.java:927-954`。

如果只看 execution mask，逻辑会很简单：

```text
这个节点不处理当前事件位
  -> 跳过
```

但当前实现没有这么粗糙。`skipContext` 还额外考虑了 executor：

```text
(1) 如果这个节点对当前方向和当前事件位整体都不相关 -> 可以跳
或者
(2) 只有在它的 executor 和当前 executor 相同，且这个节点不处理当前事件位时，才能跳
```

见 `AbstractChannelHandlerContext.java:945-954`。

### 2. 为什么“不同 executor 就算不处理这个具体事件位，也不能直接跳”

原因不在事件语义，而在线程顺序。

如果当前节点虽然对这个具体事件位没有处理逻辑，但它绑定在不同 executor 上，Pipeline 不能贸然把它像同线程空节点一样剪掉。因为一旦跨线程边界存在，事件传播本身就要考虑“把执行切到哪个 executor 上”这件事。

源码注释写得很明确：只有 EventExecutor 相同，才可以跳过，否则必须 offload 以保持顺序，见 `AbstractChannelHandlerContext.java:947-953`。

这点非常关键，也是很多高层资料容易讲漏的地方。Pipeline 的跳过规则不只是“谁关心这个事件”，还包括“跳过会不会破坏线程顺序”。

所以 `skipContext` 的真实含义应该写成：

```text
只有当当前节点既不需要处理这个事件
又不会引入新的 executor 边界时
才允许把它从传播路径里剪掉
```

### 3. 这也解释了为什么 `@Skip` 不是纯性能技巧

如果 `@Skip` 只影响性能，那它完全可以只和方法逻辑相关。但当前实现把它和 executor 顺序绑在一起，说明它还承担了另一层责任：

```text
帮助 Pipeline 在不破坏线程语义的前提下
缩短传播路径
```

所以 mask/skipContext 的设计不是“为了少几个 instanceof”这么简单，而是把事件能力和线程边界放进同一套传播优化里。

## 五、`@Sharable` 与 multiplicity：实例能不能复用，和类型能不能跳过不是一回事

### 1. `@Sharable` 是实例复用边界，不是线程安全证明

`ChannelHandler` 文档在“State management”一节里已经说得很清楚：如果 handler 持有某个连接专属的成员变量状态，通常应该为每个 Channel 创建一个新实例；只有当 handler 被标记为 `@Sharable` 时，才表示同一个实例可以被多个 pipeline 多次添加，见 `ChannelHandler.java:61-170`、`:200-218`。

这是一条实例复用规则，不是编译器或 JVM 帮你证明线程安全的结论。当前源码也明确说，这个注解本身主要是文档/约定意义。

因此不能把 `@Sharable` 理解成：

```text
打了注解
  -> 就自动线程安全
```

真正能不能共享，仍然取决于这个 handler 有没有把与单个 Channel 绑定的可变状态放在实例字段里。

### 2. `isSharable()` 会缓存注解检查结果

`ChannelHandlerAdapter.isSharable()` 会从 `InternalThreadLocalMap` 里的缓存取值；没有缓存时，才反射检查这个类有没有 `@Sharable` 注解，再把结果放回缓存，见 `ChannelHandlerAdapter.java:41-62`。

这条缓存与前面的 `ChannelHandlerMask` 很像：都不是每次 add/pipeline 操作时重新做反射，而是按 class 缓存一次结论。

但两者缓存的不是同一件事：

```text
mask cache      -> 这个 handler class 处理哪些事件位
sharable cache  -> 这个 handler class 是否允许实例复用
```

### 3. `checkMultiplicity()` 真正阻止的是“非 sharable 实例被重复加入”

`DefaultChannelPipeline.checkMultiplicity()` 会在插入 handler 时检查：如果 handler 是 `ChannelHandlerAdapter`，且不是 sharable，又已经被标记 added，就抛 `ChannelPipelineException`，同时把 `added` 置为 true，见 `DefaultChannelPipeline.java:544-553`。

这说明 Netty 真正防的不是“两个类同名的 handler”，而是“同一个非 sharable 实例被重复加到多个位置”。

所以 `@Sharable` 的运行时意义就是：

```text
允许同一个 handler 实例进入多个 pipeline
否则同实例复用会在 add 阶段直接报错
```

这条规则再次表明：类型体系解决“你处理什么事件”，sharable 体系解决“你这个实例能不能被复用”，两者不能混为一谈。

## 六、两类特殊 handler：`SimpleChannelInboundHandler` 和 `CombinedChannelDuplexHandler`

### 1. `SimpleChannelInboundHandler` 解决的是“匹配 + 自动释放”

`SimpleChannelInboundHandler<I>` 的核心不是多一个 inbound 子类型，而是给“只处理某一类消息并在处理后自动释放”这件事打包。

当前实现中，`acceptInboundMessage(msg)` 用 `TypeParameterMatcher` 判断消息是否匹配；如果匹配，就把 msg 强转成 I 调 `channelRead0(ctx, imsg)`；如果不匹配，就把消息透传给下一个 handler。最后在 `autoRelease && release` 时调用 `ReferenceCountUtil.release(msg)`，见 `SimpleChannelInboundHandler.java:42-120`。

这条路径的关键是：

```text
匹配的消息
  -> 交给 channelRead0
  -> 默认可自动 release

不匹配的消息
  -> 不自动 release
  -> 继续 fire 给下一个 handler
```

所以它不是“所有消息都自动释放”，而是“只有这个 handler 真正消费并接住的那类消息才按 autoRelease 规则处理”。如果你在匹配分支里还想把消息继续异步传走，就要自己 retain 或关掉 autoRelease。

### 2. `CombinedChannelDuplexHandler` 解决的是“一个 pipeline 位置里同时放一套 inbound 和一套 outbound”

如果某个组件的入站和出站逻辑想逻辑上捆在一起，但实现上又希望保持两个独立 handler，`CombinedChannelDuplexHandler` 就是当前答案。

它不是简单继承 `ChannelDuplexHandler` 然后把两个 handler 字段塞进去，而是为 inbound 和 outbound 各维护一个 `DelegatingChannelHandlerContext`。在 `channelRead`、`write`、`flush` 等方法里，如果对应方向的委托还没 removed，就把事件交给对应 handler；否则继续向下转发，见 `CombinedChannelDuplexHandler.java:220-389`。

所以它的真正价值是：

```text
在 pipeline 结构上占一个位置
但在处理逻辑上保留两套方向不同的上下文和委托
```

如果只是把两个 handler 简单放成相邻两个 pipeline 节点，顺序、remove/add 时机、异常边界都会变成另一套问题。Combined 的上下文代理正是为了把“逻辑上是一组双向能力”收回到一个结构位置上。

## 七、最容易错的五个判断

### 1. `@Skip` 是 JVM 自己的优化

不成立。它只是 Netty 自己读取的注解，用来在预计算 mask 和传播时决定能不能跳过纯转发方法。

### 2. `read()` 既然叫 read，就应该属于 inbound

不成立。outbound 的 `read()` 表示“请求底层去读”；inbound 的 `channelRead()` 才表示“已经收到数据”。

### 3. `@Sharable` 就等于线程安全

不成立。它只表示允许实例复用；如果 handler 持有跨 Channel 的可变状态，打了 `@Sharable` 一样会出问题。

### 4. mask 只是为了少做几个 `instanceof`

不完整。它还和 executor 边界一起决定哪些 context 在传播时能被安全跳过。

### 5. `SimpleChannelInboundHandler` 会自动释放所有经过它的消息

不成立。只有匹配并被它接住的消息才会按 autoRelease 规则释放；不匹配消息会继续透传。

## 收网：类型体系和 mask，让 Pipeline 只把事件送给真正该接它的人

现在可以回到本章开头的问题：为什么 Netty 需要这么多 handler 类型，还要配一套 mask 机制？

因为 Pipeline 真正的问题不是“能不能传播”，而是：

```text
当事件在链上流动时
如何尽快找到真正关心它的节点
同时不破坏线程顺序和生命周期边界
```

Netty 的回答分成两层：

```text
第一层：类型体系
  -> inbound / outbound / duplex / adapter / simple / combined
  -> 先把 handler 的职责边界说清楚

第二层：mask + skipContext
  -> 把“哪些方法只是纯转发、哪些事件位真正关心”预计算成位掩码
  -> 传播时按能力和 executor 边界跳过不匹配节点
```

这让 Pipeline 不只是“有一条链”，而是“这条链上的每个节点都事先说清楚自己管什么、不管什么、能不能被跳过、能不能被复用”。

因此 Ch7-02 最该带走的结论不是“handler 有很多种”，而是：

```text
Netty 先把 handler 的职责静态化
再把传播资格预编成 mask
这样事件在运行时不必每次从零识别一遍谁该接手
```

下一篇进入出站与写缓冲区。因为一旦 handler 真正开始 `write()` 和 `flush()`，事情就不再只是“往后传播一个调用”，而会落到 `ChannelOutboundBuffer` 的待发送链表、聚集写和反压机制上。