# 初始化与生命周期：Handler 什么时候才算真正生效

> 本文基于当前 Netty `ChannelInitializer`、`DefaultChannelPipeline` 与 `AbstractChannelHandlerContext` 实现。前置：Ch7-01 到 Ch7-03；本文解释 handler 何时真正 `handlerAdded()`、为什么有 pending callback 链、`ChannelInitializer` 为什么自移除，以及 `replace/remove/destroy` 如何在事件仍可能流动时保持一致性。

## 链表已经改好了，不等于这个 Handler 现在就能接事件

前 3 篇 Pipeline 已经把结构、传播方向和出站缓冲都讲清楚了。到这里，读者通常会自然产生一个错觉：

```text
只要 `pipeline.addLast(handler)` 返回了
这个 handler 就已经正式上岗了
```

这在很多普通集合 API 里是成立的：元素一进 list，后续遍历就能看见它。

但 Pipeline 不是普通集合。它有三个额外约束：

1. Handler 可能绑定了特定 executor，不能在错误线程里立刻接事件。
2. Channel 可能还没注册到 EventLoop，此时很多回调条件还没成熟。
3. 旧 handler 被替换或移除后，事件仍可能在链上半路飞行，不能粗暴切断。

所以 Pipeline 生命周期真正要解决的，不是“链表怎么改”，而是：

```text
结构上已经把节点插进来了
它什么时候才对事件真正可见？

结构上已经把节点摘掉了
它什么时候才算真正离场？
```

这就是本篇的主线。`ChannelInitializer`、pending callback、`handlerState`、replace/remove/destroy 看起来分散，其实都在回答同一个问题：

```text
Pipeline 节点的结构变化与事件可见性之间存在时间差
Netty 必须把这条时间差显式管起来
```

## 一、`ChannelInitializer`：不是长期 Handler，而是“一次性装配器”

### 1. 它最核心的职责不是处理数据，而是往 pipeline 里塞真正的 handler

`ChannelInitializer` 的注释已经把角色说得非常清楚：它是一个特殊的 `ChannelInboundHandler`，提供一种在 Channel 注册到 EventLoop 后初始化 Channel 的简便方式，典型用途就是 `Bootstrap.handler(...)` / `ServerBootstrap.childHandler(...)`，见 `ChannelInitializer.java:28-34`。

所以它的核心工作不是长期留在链上吃事件，而是：

```text
某个 Channel 一旦到达合适的生命周期点
  -> 调用用户实现的 `initChannel(ch)`
  -> 往这个 channel 的 pipeline 里批量加上真正的 codec / business handlers
  -> 自己离开
```

换句话说，`ChannelInitializer` 更像一次性脚手架，而不是常驻处理器。

### 2. 为什么它被标成 `@Sharable`

`ChannelInitializer` 本身带有 `@Sharable`，并且内部维护了一个 `ConcurrentHashMap.newKeySet()` 作为 `initMap`，见 `ChannelInitializer.java:53-59`。

这说明 Netty 预期你用同一个 initializer 实例服务很多 Channel，尤其是在服务端 `childHandler(...)` 场景里：每来一个新连接，都用同一份初始化逻辑把 pipeline 装起来。

但这里也要和上一节的 `@Sharable` 规则保持一致：

```text
@Sharable 允许实例复用
不等于它内部不需要自己的并发/防重入保护
```

`initMap` 的存在正是这个保护。它按 `ChannelHandlerContext` 维度记录“这个 initializer 是否已经对这个 ctx 做过初始化”，防止一次 channel 初始化过程里重入多次。

### 3. 初始化真正发生在什么时候

`ChannelInitializer` 有两个可能触发初始化的入口：

- `handlerAdded(ctx)`：如果这个时候 channel 已经 registered，就立刻尝试初始化。
- `channelRegistered(ctx)`：如果前面还没初始化，这里补做，并在成功后补发一次 `pipeline.fireChannelRegistered()`。

实现见 `ChannelInitializer.java:72-88`、`:105-117`。

这两条路径说明一个非常关键的时序判断：Netty 不是简单把“add 到 pipeline 时机”和“能不能初始化”绑死在一起，而是根据 channel 是否已经注册到 EventLoop 决定触发点。

所以初始化的真正条件不是：

```text
handler 已经在链上
```

而是更准确地说：

```text
handler 已经在链上
并且 channel 已经进入允许这段初始化逻辑安全运行的阶段
```

### 4. 初始化完成后为什么一定要自移除

`ChannelInitializer.initChannel(ChannelHandlerContext ctx)` 内部有一个非常关键的 `finally`：如果当前 context 还没被移除，就执行 `ctx.pipeline().remove(this)`，见 `ChannelInitializer.java:124-141`。

这就是所谓的“自移除”模式。

为什么一定要移掉？因为它的任务已经完成了：真正的 handler 已经被加进 pipeline。继续留在链上只会带来两个坏处：

- 它之后每次还要参与传播匹配，哪怕什么都不做。
- 它还要继续参与生命周期管理，增加状态复杂度。

更重要的是，如果不移除，后续再走到 `channelRegistered` 或其他相关路径时，就要继续面对“会不会再初始化一次”的问题。自移除等于从结构上宣布：

```text
这份脚手架已经用完
后面请让真正的 handler 接管这条链
```

### 5. `initMap` 防的不是多线程，而是一次初始化过程里的重入

`initChannel(ctx)` 的第一步是 `initMap.add(ctx)`；只有第一次成功加入时才真正执行初始化逻辑，见 `ChannelInitializer.java:124-141`。

这条保护最容易被误会成“只是为了并发安全”。它当然有并发意义，但更直接解决的是重入：

```text
一个 initializer 在初始化过程中
又触发了某些 pipeline 变化或回调
导致同一个 ctx 再次走到初始化入口
```

如果没有 `initMap`，这类重入会把“只应装配一次”的 handler 再装一遍。对 pipeline 来说，这比普通重复执行方法更危险，因为它会直接改结构。

所以 `initMap` 更像一次性门闩：这个 channel 的这个 initializer，一旦开始干活，就不允许在中途再被自己重新拉起来。

## 二、为什么会有 `PendingHandlerCallback`：先加入链上，不代表现在就能调 `handlerAdded()`

### 1. 未注册 Channel 上，结构修改和回调生效故意分开

`DefaultChannelPipeline.internalAdd(...)` 在 handler 插入链表后，会检查 `registered`。如果 Channel 还没注册到 EventLoop，它不会立刻调用 `callHandlerAdded0(newCtx)`；而是：

- `newCtx.setAddPending()`
- `callHandlerCallbackLater(newCtx, true)`
- 先返回

见 `DefaultChannelPipeline.java:188-205`。

这一步正是本篇总主题的第一处具体落点：

```text
链表结构已经变了
但 handlerAdded 回调还没真正发生
```

为什么要分开？因为很多 handler 会在 `handlerAdded()` 里做动作，比如：

- 立刻发一条欢迎消息
- 注册某些 read/write 相关行为
- 再向 pipeline 动态添加别的 handler

如果这时 channel 还没注册到 EventLoop，这些动作就可能发生在错误的线程或错误的生命周期阶段。

### 2. `pendingHandlerCallbackHead` 其实是一条延迟执行链

`DefaultChannelPipeline` 保存了一个 `pendingHandlerCallbackHead`，用来挂待执行的 added/removed 回调，见 `DefaultChannelPipeline.java:73-83`。

`callHandlerCallbackLater(ctx, added)` 会把 `PendingHandlerAddedTask` 或 `PendingHandlerRemovedTask` 挂到这条单链表尾部，见 `DefaultChannelPipeline.java:1141-1155`、`:1456-1529`。

所以 Netty 的做法不是“干脆忘掉这些回调”，而是：

```text
现在先改结构
把对应的 handlerAdded/handlerRemoved 需求记下来
等注册时机成熟，再统一执行
```

这条链表正是“结构加入了，但语义尚未生效”的缓冲带。

### 3. 为什么首次注册时要批量补发 `handlerAdded()`

`invokeHandlerAddedIfNeeded()` 会在第一次 `channelRegistered` 时调用 `callHandlerAddedForAllHandlers()`，见 `DefaultChannelPipeline.java:593-601`。

而 `callHandlerAddedForAllHandlers()` 会：

1. 在 synchronized 内把 `registered=true`，取出整条 pending callback 链。
2. 把 `pendingHandlerCallbackHead` 置空。
3. 在 synchronized 外逐个执行这些 callback。

见 `DefaultChannelPipeline.java:1118-1139`。

这说明 Pipeline 把“第一次注册到 EventLoop”当成一个全局闸门：

```text
在此之前，允许你批量改链
但回调先挂起
到这一步，统一宣布所有这些 handler 现在正式可见
```

这让 Channel 初始化阶段非常灵活：你可以在 register 之前连续 add 很多 handler，而不需要每加一个就立刻承担它的回调副作用。

### 4. 为什么这些 callback 要在 synchronized 外执行

`callHandlerAddedForAllHandlers()` 特地把 callback 链先摘出来，再在 synchronized 外执行。源码注释写得很直白：如果 holding 锁时执行 `handlerAdded()`，而这个回调里又从 EventLoop 外尝试 add handler，就可能产生死锁，见 `DefaultChannelPipeline.java:1131-1137`。

因此 Netty 的策略是：

```text
结构完整性更新在锁里完成
真正可能重入用户代码的 handlerAdded/Removed 回调放到锁外执行
```

这不是编码风格问题，而是典型的生命周期边界保护：只要用户回调有机会重新改 pipeline，就不能拿着核心结构锁去调它。

## 三、`handlerState`：这个节点在链上，不等于它已经有资格接事件

### 1. 四种状态不是装饰字段，而是可见性边界

`AbstractChannelHandlerContext` 里定义了几种状态：

- `INIT`
- `ADD_PENDING`
- `ADD_COMPLETE`
- `REMOVE_COMPLETE`

见 `AbstractChannelHandlerContext.java:69-85`。

这些状态真正要解决的，是同一个问题：

```text
这个 context 虽然已经在链表里
但现在到底能不能把事件真正交给它的 handler？
```

如果结构刚插进去、`handlerAdded()` 还没调用，就算链上能“看见”它，也不能当它已经 fully active。

### 2. `callHandlerAdded()` 为什么先 setAddComplete 再调用户代码

`callHandlerAdded()` 会先执行 `setAddComplete()`，然后再调用 `handler().handlerAdded(this)`，见 `AbstractChannelHandlerContext.java:985-990`。

源码注释给出的理由非常直接：如果 `handlerAdded()` 里触发了 pipeline 事件，而状态还没切到 add complete，那这个 handler 自己反而会 miss 掉本应接到的事件。

也就是说，`ADD_COMPLETE` 的语义不是“回调已经执行完”，而是：

```text
从现在开始，这个节点对事件传播已经是正式可见的
```

这是一条很 subtle 的时序保证：可见性必须早于用户回调内部可能触发的新事件。

### 3. `invokeHandler()` 为什么有时宁可 forward 也不直接调 handler

`invokeHandler()` 的逻辑是：

- `handlerState == ADD_COMPLETE` -> 可以调用 handler
- 或者在某些非 ordered executor 场景下，`ADD_PENDING` 也尽力允许

见 `AbstractChannelHandlerContext.java:1005-1017`。

如果它返回 false，传播路径就会继续 forward，而不是把事件交给这个 handler。

这再次说明：

```text
“在链表里”只是结构事实
“handler 可以正式接事件”是生命周期事实
```

两者之间正是 `handlerState` 在做仲裁。

## 四、remove / replace：旧节点还没彻底离场时，事件可能仍在飞

### 1. remove 先摘链，再决定何时 `handlerRemoved()`

`DefaultChannelPipeline.remove(ctx)` 的顺序是：

1. 先 `atomicRemoveFromHandlerList(ctx)` 把节点从链上摘掉。
2. 如果 Channel 还没注册，延迟 `handlerRemoved`。
3. 如果已注册但不在对应 executor 线程，就异步提交 `callHandlerRemoved0(ctx)`。
4. 否则立即执行 `callHandlerRemoved0(ctx)`。

见 `DefaultChannelPipeline.java:401-427`。

这条顺序表明 remove 也在显式分开两件事：

```text
结构上已经从链里摘掉
生命周期上 handlerRemoved 什么时候调用，还要看注册和线程归属
```

所以 remove 不是一个瞬时动作，而是“先让后续新事件不再经过它，再完成它自己的离场回调”。

### 2. replace 为什么一定要“先 added 新的，再 removed 旧的”

当前 `replace(...)` 在已注册场景下，会先 `callHandlerAdded0(newCtx)`，再 `callHandlerRemoved0(oldCtx)`，源码还专门解释了原因：`handlerRemoved()` 可能触发 `channelRead()` 或 `flush()` 到新 handler，因此新 handler 必须先 ready，见 `DefaultChannelPipeline.java:474-524`。

这说明 replace 不是“删一个，再加一个”的语法糖，而是一个非常强调时序的切换协议：

```text
先让新节点拥有接事件的资格
再让旧节点执行离场逻辑
```

否则，旧节点在 remove 过程中触发的新事件会找不到已经准备好的接收者。

### 3. `oldCtx.prev = oldCtx.next = newCtx` 为什么这么怪

`replace0(oldCtx, newCtx)` 除了把链表上的前后指针换成 newCtx 之外，还会把 `oldCtx.prev` 和 `oldCtx.next` 都指向 `newCtx`，见 `DefaultChannelPipeline.java:526-542`。

这一行如果只从“双向链表正确性”看，会显得很奇怪，因为 oldCtx 明明已经被替换出去了。

它真正服务的不是链表本身，而是“旧 context 对外残留引用上的 forward 行为”。如果某个事件恰好还沿着 oldCtx 传播，oldCtx 再往前/往后转发时，应该都落到新 ctx，而不是落到已经过期的邻居关系上。

所以这条赋值的意义可以压成：

```text
oldCtx 虽然不再是正式链表节点
但如果还有残留调用落到它身上
它继续 forward 时要把流量导向 newCtx
```

这是 Pipeline 生命周期里最能体现“结构切换”和“事件仍在飞行”同时存在的一处细节。

## 五、`destroyUp` / `destroyDown`：销毁不是简单从头删到尾

### 1. 为什么要分两个方向

`destroy()` 并不是单线程里从 head 走到 tail、逐个 `handlerRemoved()` 就结束。当前实现先 `destroyUp(head.next, false)`，再在合适时机 `destroyDown(...)`，见 `DefaultChannelPipeline.java:790-856`。

源码注释给出的核心理由是：先向上遍历，再向下删除，这样 handlerRemoved 会发生在所有事件处理之后。

把这个策略翻成人话就是：

```text
先确认各个 executor 上都到达“可以开始拆”的边界
再反向依次执行真正的移除回调
```

### 2. `destroyUp` 处理的是“到正确线程去”

`destroyUp` 沿着 next 方向走，一旦发现当前 ctx 的 executor 不是当前线程，就把后续销毁动作提交到那个 executor，再 break，见 `DefaultChannelPipeline.java:804-828`。

这说明第一阶段的重点不是删除节点，而是：

```text
确保后续这段销毁逻辑在节点所属的 executor 上继续推进
```

也就是说，destroyUp 更像一段“线程归属导航”，而不是立刻干活的删除循环。

### 3. `destroyDown` 才真正执行摘链和 `handlerRemoved()`

`destroyDown` 则沿着 prev 方向回走；在正确线程里，它会对当前 ctx 执行：

- `atomicRemoveFromHandlerList(ctx)`
- `callHandlerRemoved0(ctx)`

见 `DefaultChannelPipeline.java:830-856`。

这说明第二阶段才是真正的“从链里一个个拆掉并完成离场回调”。

两阶段合起来，Pipeline 销毁的逻辑就清楚了：

```text
destroyUp
  -> 把销毁流程送到正确 executor

destroyDown
  -> 按逆方向依次摘链并调用 handlerRemoved
```

### 4. Channel 关闭后为什么在 `channelUnregistered` 里触发 destroy

`HeadContext.channelUnregistered(...)` 在把事件继续向后 fire 之后，会检查 `!channel.isOpen()`；如果 channel 已关闭，就调用 `destroy()`，见 `DefaultChannelPipeline.java:1406-1413`。

这说明 Pipeline 的销毁不只是“生命周期自然结束”的附加效果，而是 Channel 关闭、注册关系解除之后的正式收尾阶段。

也就是说：

```text
channel 关闭 + unregistered
  -> 这条 pipeline 不再需要保留 handler 结构
  -> 开始两阶段销毁
```

它把 Channel 生命周期和 handler 生命周期真正接到了一起。

## 六、最容易错的五个判断

### 1. `addLast(handler)` 返回了，说明 `handlerAdded()` 一定已经执行完

不成立。未注册 Channel 上，context 可能已经在链表里，但 `handlerAdded()` 只是挂到 pending callback 链，等首次注册后再批量触发。

### 2. `ChannelInitializer` 是长期留在链上的一个 inbound handler

不成立。它的核心模式是“初始化一次 -> finally 里移除自己”，本质是一次性装配器。

### 3. remove 就是摘链和 `handlerRemoved()` 同步一把做完

不成立。当前实现先摘链，再根据注册状态和 executor 线程决定何时真正回调 `handlerRemoved()`。

### 4. replace 先 remove old 再 add new 更符合直觉

不成立。当前实现反而是先让 new handler ready，再让 old handler removed，因为 old 的 removed 过程本身可能继续触发事件到新 handler。

### 5. destroy 两阶段只是代码组织上的“拆函数”

不成立。它的根本目的是处理跨 executor 的线程归属和事件收尾顺序，不是为了代码好看。

## 收网：Pipeline 生命周期的真正难点，是“节点何时可见、何时离场”

现在可以回到本章开头的问题：为什么 handler 的初始化和销毁要搞得这么复杂？

因为对 Pipeline 来说，最难的从来不是“把节点插进链表”或“把节点从链表摘掉”，而是：

```text
结构变化已经发生
但这个节点是否已经可以接事件？
它是不是已经安全离场？
事件在这段窗口里还会不会飞过它？
```

Netty 当前的回答是分层处理：

```text
ChannelInitializer
  -> 一次性装配，完成后自移除

PendingHandlerCallback + handlerState
  -> 让“加入链表”和“正式可见”之间有缓冲带

remove / replace
  -> 先处理结构，再精确处理 added/removed 时序

destroyUp / destroyDown
  -> 把跨 executor 的销毁过程拆成线程归属导航和真正离场两步
```

所以 Ch7-04 最该带走的结论不是“Pipeline 有很多生命周期钩子”，而是：

```text
Pipeline 管的不只是事件怎么流过谁
还要管节点什么时候对事件真正可见、什么时候又真正离场
```

到这里，第 7 章已经把 Pipeline 的骨架、类型、出站缓冲和生命周期讲完整了。下一章进入内存池化：当每次 write/read 都要分配和释放 ByteBuf 时，Netty 为什么不满足于每次都 new / free，而要再造一套 PoolArena/PoolChunk/PoolThreadCache 的分配回收体系。