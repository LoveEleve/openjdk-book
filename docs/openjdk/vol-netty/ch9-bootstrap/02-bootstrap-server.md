# ServerBootstrap：父监听和子连接为什么要分两次初始化，而不是一次把 handler 全挂完

> 本文基于当前 Netty `ServerBootstrap`、`ServerBootstrapAcceptor`、`ChannelInitializer`、`ChannelInitializerExtension(s)` 与相关测试实现。前置：Ch5 EventLoop、Ch6 Promise/Future、Ch7 `04-init-and-lifecycle.md`、Ch9 `01-abstractbootstrap.md`；本文聚焦服务端专属启动链——listener channel 与 child channel 的分离初始化、`ChannelInitializer` 的自移除与防重入、`ServerBootstrapAcceptor` 的子 Channel 接管顺序、父/子 EventLoopGroup 分工与异常节流，不展开底层 `accept` 系统调用细节。

## 第一篇只讲了父 Channel 怎样起飞，服务端真正麻烦的是“accept 之后谁接棒”

上一节已经把 Bootstrap 骨架收住了：

- 先 `validate()`。
- 再 `initAndRegister()`。
- 最后把真正的 `bind()` / `connect()` 投到 Channel 所属的 EventLoop。

那一篇解决的是所有 Bootstrap 共用的问题：一个 Channel 怎样从抽象配置被落成运行对象。

可服务端真正比客户端难的地方，不在“它最后调用的是 bind 而不是 connect”，而在监听 socket 后面还藏着第二条生命周期。

客户端通常只要关心一条连接：

```text
我这个 Channel 自己怎么初始化
我这个 Channel 自己什么时候 connect
```

服务端不一样。服务端至少同时管理两类 Channel：

```text
父 Channel / listener channel
  -> 负责监听与 accept 新连接

子 Channel / child channel
  -> 代表每一条已经建立的客户端连接
```

这两类 Channel 虽然都挂在同一个 `ServerBootstrap` 之下，但它们承担的职责根本不是一回事：

- 父 Channel 关心的是监听、接收和把新连接吐出来。
- 子 Channel 关心的才是后续 read/write、编解码、业务 handler、连接级选项与属性。

所以一旦你把服务端启动想成“像客户端一样给一个 Channel 挂几个 handler 就完了”，马上就会卡住：

```text
childHandler 到底该挂到谁身上？
childOptions / childAttrs 是在 bind 前统一生效，还是 accept 后逐条生效？
worker EventLoopGroup 是什么时候真正接手子连接的？
为什么父 Pipeline 里会先出现一个 ChannelInitializer，而不是直接出现 acceptor？
```

这篇文章就是专门把这条“父监听 / 子连接”的双层初始化链讲完整。

先把本文最核心的一句话摆前面，后面会反复回收：

```text
ServerBootstrap 的关键不是比 Bootstrap 多几个 child 配置项，
而是把服务端拆成了两次初始化：
先初始化 listener channel，再在 accept 到 child 之后初始化每一条子连接。
```

如果没有这条主线，后面读 `ServerBootstrap.init(...)`、`ChannelInitializer`、`ServerBootstrapAcceptor.channelRead(...)` 时，就很容易把几个动作混成一个扁平过程，以为 handler 都是在 bind 前“一把挂完”的。当前实现不是这样。

## 一、如果把服务端也当成“一个 Channel 配一个 handler”，会在三处走偏

正式进源码前，先故意走三条最省事、也最容易误导人的路。

### 1. 失败方案一：父 Channel 和子 Channel 反正都是 Channel，责任线不必拆开

这是最自然的误解。

从类型上看，listener channel 和 child channel 确实都实现 `Channel`；那为什么不把它们理解成“只是同一类东西的不同实例”，然后让一套 handler / 一组 EventLoop 对它们统一处理？

问题在于，这两者虽然接口同名，生命周期位置却完全不同。

父 Channel 接受的是：

```text
bind 之后的监听生命周期
  -> 何时 accept
  -> accept 到的对象怎么交出去
```

子 Channel 接受的是：

```text
连接建立之后的业务生命周期
  -> pipeline 怎么装
  -> 读写谁来驱动
  -> options / attrs 怎么生效
```

如果你不拆这两条责任线，就会把“监听 socket 自己的初始化”和“每一条新连接的初始化”揉成一个时点。那时最先变糊的，就是 `childHandler` 到底属于谁。

### 2. 失败方案二：既然 `childHandler` 迟早要加到子连接上，不如在 `ServerBootstrap.init(...)` 里直接一步到位

第二条错误更像“工程上提前做完”。

`ServerBootstrap` 已经在 bind 前拿到了 `childHandler`、`childOptions`、`childAttrs`，那为什么不在 `ServerBootstrap.init(...)` 里就把这些东西一次性挂好？

这听起来像减少步骤，实际会马上撞上一个事实：bind 前你手上还只有 listener channel，本就不存在那些未来才会 accept 出来的 child channel。

换句话说：

```text
你现在能初始化的，只有监听 Channel 自己。
子 Channel 还没出生，根本无处可挂 child 配置。
```

所以 `ServerBootstrap.init(...)` 只能先把“将来 child 出生后谁来接手它”这件事准备好，而不能假装 child 已经存在。

### 3. 失败方案三：`ChannelInitializer` 只是方便写法，留在 Pipeline 里也无所谓

第三条错误最容易被低估。

很多人第一次看到 `ChannelInitializer`，会把它理解成一个“启动辅助 handler”：用来在一开始加几个别的 handler。既然如此，它留在 Pipeline 里似乎也不碍事；下一次事件来时它不做事就行。

当前实现却非常认真地把它设计成“一次性角色”：

- `@Sharable`
- `initMap` 防重入
- `finally { pipeline.remove(this) }`
- 必要时补发 `fireChannelRegistered()`

见 `transport/src/main/java/io/netty/channel/ChannelInitializer.java:53`、`:72`、`:104`、`:124`。

这已经说明它绝不是“挂上去也无所谓”的临时辅助件，而是：

```text
只负责把第一次初始化动作做完，
做完就必须退场，
免得后续事件继续穿过一个本不该长期留在链上的启动角色。
```

带着这三条失败方案进主线，再看 `ServerBootstrap` 的代码时，很多“为什么不一步做完”的疑问就会自然消失。

## 二、`ServerBootstrap.init(...)`：父 Channel 先装的是 listener 自己的骨架，不是子连接的业务链

上一节已经讲过，`AbstractBootstrap.initAndRegister()` 在创建出 Channel 之后，会调用一个抽象 `init(channel)` 钩子。对于服务端，这个钩子落在 `ServerBootstrap.init(...)`，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:132`。

这一步是第二篇的真正起点，因为它第一次把“父监听链”和“子连接链”分开了。

### 1. 开场先设置的是 listener channel 自己的 `options/attrs`

`ServerBootstrap.init(...)` 一上来先做两件事：

- `setChannelOptions(channel, newOptionsArray(), logger)`
- `setAttributes(channel, newAttributesArray())`

见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:134`。

这一步容易被看漏，但它非常关键，因为它表明：

```text
ServerBootstrap 里既有父 Channel 自己的配置，
也有 child Channel 将来才会用到的配置；
两者不是一套东西。
```

这里先落到 listener channel 自己身上的，是第一类：

- 监听 socket 本身的 channel options
- 监听 socket 本身的 attributes

这一步并没有触碰 child options/attrs。也就是说，当前实现从开头就在强迫我们承认：父和子不是同一层配置面。

### 2. 为什么先往父 Pipeline 放的是 `ChannelInitializer`

接下来 `ServerBootstrap.init(...)` 取到 `ChannelPipeline p = channel.pipeline()`，然后做的不是直接 `addLast(new ServerBootstrapAcceptor(...))`，而是先放一个匿名 `ChannelInitializer<Channel>`，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:145`。

这件事特别值得停下来讲。因为如果只看结果，acceptor 最终确实会出现在父 Pipeline 里；那为什么不现在立刻加进去？

当前实现的真实顺序是：

```text
父 Channel 初始化阶段
  -> 先放一个一次性的 initializer
  -> initializer 真正运行时，再把 listener 自己的 handler 加进去
  -> 再通过 eventLoop.execute(...) 延迟补上 acceptor
```

也就是说，`ChannelInitializer` 在这里不是“包装一下更优雅”，而是专门承担“第一次初始化时机编排”的角色。

### 3. `config.handler()` 属于父 listener，不等于 `childHandler`

匿名 initializer 的 `initChannel(final Channel ch)` 里，第一件事是看 `config.handler()`，如果不为 null，就加到当前 listener channel 的 pipeline 上，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:149`。

这里要明确区分两种 handler：

- `handler()`：父 listener channel 自己的 handler。
- `childHandler`：未来每个 child channel 要用的 handler。

很多资料会把两者一笔带过，仿佛都是“给服务器配置 handler”。当前源码恰恰在这里把它们严格分层：

```text
listener channel 自己的 pipeline
  -> 用 config.handler()

child channel 的 pipeline
  -> 以后在 acceptor.channelRead(...) 里用 childHandler
```

如果把这两者混了，就会把服务端的两层生命周期重新拍扁成一层，回到前面失败方案二那条错路上去。

### 4. acceptor 为什么还要再延迟一次，交给 `eventLoop().execute(...)`

initializer 在给 listener channel 挂完 `config.handler()` 之后，并没有立即 `pipeline.addLast(new ServerBootstrapAcceptor(...))`，而是：

```java
ch.eventLoop().execute(new Runnable() {
    @Override
    public void run() {
        pipeline.addLast(new ServerBootstrapAcceptor(...));
    }
});
```

见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:154`。

这一层延迟很容易让人以为只是“和第一篇一样，什么都扔给 EventLoop 再说”。但这里的关键不是重复上一节的状态机，而是 listener pipeline 的初始化顺序。

当前实现想保证的是：

```text
先让 ChannelInitializer 在正确时机运行
  -> listener 自己的 handler 先进入父 pipeline
  -> acceptor 再作为监听链后续角色被补进去
```

也就是说，acceptor 不是“谁先加都行”的普通 handler。它承担的是“从父监听链切到子连接链”的接棒角色，所以它得出现在 listener 自身初装已经成立之后。

这里先做个路标：到目前为止，本篇主线只需要记住一句话。

```text
ServerBootstrap.init(...) 并没有直接初始化 child channel；
它只是在 listener channel 身上，提前安放好“未来谁来接手 child”的机制。
```

## 三、`ChannelInitializer`：一次性启动角色为什么必须防重入、补事件、然后自移除

现在可以专门收 `ChannelInitializer` 了。

如果不把它讲透，后面 `ServerBootstrap.init(...)` 那段“先放 initializer、再让它退场”的写法就会一直像技巧，不像机制。

### 1. `@Sharable` 说明它常常是跨多个 Channel 复用的同一个初始化器

`ChannelInitializer` 类本身就带着 `@Sharable`，见 `transport/src/main/java/io/netty/channel/ChannelInitializer.java:53`。类注释也明确说，它常用于 `Bootstrap.handler(...)`、`ServerBootstrap.handler(...)` 和 `ServerBootstrap.childHandler(...)` 场景。

这意味着真实世界里非常常见的一种用法是：

```text
同一个 ChannelInitializer 实例
  -> 被多个 client channel 复用
  -> 被多个 server child channel 复用
```

所以它不能把自己的临时初始化状态随便塞在实例字段里，仿佛一次只服务一个 Channel。当前实现用 `Set<ChannelHandlerContext> initMap = ConcurrentHashMap.newKeySet()` 来记录“哪些 context 正在初始化”，见 `transport/src/main/java/io/netty/channel/ChannelInitializer.java:59`。

这一步不仅是为了省点内存；更重要的是它把状态粒度放在 `ctx` 上，而不是放在 initializer 实例上。

### 2. 为什么会出现“同一个 Channel 上重复触发初始化”的风险

光知道 `initMap` 存在还不够，还得回答：到底什么场景会重复进初始化？

当前实现里至少有两条入口可能触发：

- `handlerAdded(...)`：如果 handler 加入 pipeline 时，channel 已经 registered，则直接尝试初始化，见 `transport/src/main/java/io/netty/channel/ChannelInitializer.java:104`。
- `channelRegistered(...)`：如果先前还没做过初始化，则在注册事件到来时初始化，见 `transport/src/main/java/io/netty/channel/ChannelInitializer.java:72`。

也就是说，同一个 initializer 既可能在“被加进 pipeline 的那一刻”触发，也可能在“channelRegistered 事件到来时”触发。更进一步，如果 `initChannel(...)` 里自己又触发了 `fireChannelRegistered()` 之类事件，单 Channel 内部还可能出现重入。

这也是为什么 `initMap` 防重入不能被简单讲成“多线程共享防冲突”。它同样是在防单个 Channel 初始化期间的事件重入。

`ChannelInitializerTest.testChannelInitializerReentrance()` 就专门覆盖了这一点：测试里的 `initChannel()` 人为 `fireChannelRegistered()`，最终断言 `initChannelCalled == 1`，而注册事件处理仍能发生两次，见 `transport/src/test/java/io/netty/channel/ChannelInitializerTest.java:160`。

这正好说明当前设计想同时守住两件事：

```text
初始化逻辑只跑一次
但该继续向后传播的注册事件不能丢
```

### 3. `handlerAdded` 路径和 `channelRegistered` 路径为什么要并存

很多读者会直觉地问：既然 initializer 本来就是“等注册后初始化”，那只留 `channelRegistered(...)` 不就行了，为什么还要在 `handlerAdded(...)` 里再做一遍判断？

当前源码注释已经给了答案：好处是如果一个 `ChannelInitializer` 里又添加另一个 `ChannelInitializer`，handler 的添加顺序就不会出乎意料，见 `transport/src/main/java/io/netty/channel/ChannelInitializer.java:107`。

这句话翻成人话就是：

```text
如果 channel 已经 registered，
那你现在把 initializer 加进 pipeline，
最好立刻就把它该做的初始化做掉；
否则你得等一个已经过去的注册事件重来，顺序就会变怪。
```

`ChannelInitializerTest.testChannelInitializerInInitializerCorrectOrdering()` 正是用嵌套 initializer 验证这一点：最终 handler 顺序保持为 `handler1 -> handler2 -> handler3 -> handler4`，见 `transport/src/test/java/io/netty/channel/ChannelInitializerTest.java:118`。

所以 `handlerAdded(...)` 不是“重复入口”，而是为了保证“后加 initializer”仍能在已注册 channel 上保持自然顺序。

### 4. 为什么它做完初始化后必须把自己移除

`initChannel(ChannelHandlerContext ctx)` 的 finally 块里，如果当前 context 还没被移除，就会 `ctx.pipeline().remove(this)`，见 `transport/src/main/java/io/netty/channel/ChannelInitializer.java:133`。

这一步的意义不该被讲成“清理一下更整洁”。它承担的是角色退出：

```text
ChannelInitializer 的职责只到“第一次把启动骨架装好”为止；
后面的普通 read/write/active/exception 事件，不该继续穿过这个启动角色。
```

如果它长期留在 pipeline 里，至少会制造三种混乱：

- 读 pipeline 时多了一个其实已经完成历史使命的节点。
- 未来事件仍可能经过这个本不该再参与运行态的 handler。
- 再配合共享实例与事件重入，初始化状态边界会越来越难读。

所以“用完即走”不是风格偏好，而是 ChannelInitializer 这个角色定义本身的一部分。

### 5. 为什么初始化成功后还要补 `fireChannelRegistered()`

`channelRegistered(...)` 路径里，如果 `initChannel(ctx)` 返回 true，当前实现不会吞掉事件，而是显式 `ctx.pipeline().fireChannelRegistered()`，见 `transport/src/main/java/io/netty/channel/ChannelInitializer.java:77`。

这一步非常关键。因为一旦 initializer 自己拦下了注册事件并顺手做了初始化，后面那些刚被加进 pipeline 的 handler 仍然应该看到这次注册事件；否则你只是“初始化成功了”，却让后续 handler 错过了自己依赖的生命周期钩子。

`ChannelInitializerTest` 里也有专门的传播测试，确保无论 handler 被加在前还是后，最终都能收到 `channelRegistered`，见 `transport/src/test/java/io/netty/channel/ChannelInitializerTest.java:196`。

所以 `ChannelInitializer` 的完整语义应该压成下面这张图：

```text
如果该初始化
  -> 防重入
  -> 执行 initChannel(C)
  -> 把自己从 pipeline 移除
  -> 该补的 channelRegistered 继续补出去
```

这才是它既像“脚手架”又不像“一次性 hack”的原因。

## 四、`ServerBootstrapAcceptor`：父监听链在这里把 child channel 交给下一条生命周期

有了上一节的铺垫，现在再看 `ServerBootstrapAcceptor` 就很顺了。

这个类不是在 bind 前直接出现的，而是通过 listener channel 上的一次性 initializer 延迟挂进去的。它真正上场后，承担的角色很简单但非常关键：

```text
父 Channel accept 到一个新 child channel
  -> 我负责把它初始化到“可以交给 worker 和业务链接管”的状态
```

### 1. `channelRead(ctx, msg)` 里的 `msg`，在这里就已经是 child Channel 了

`ServerBootstrapAcceptor.channelRead(...)` 第一行直接把 `msg` 强转成 `Channel child = (Channel) msg`，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:223`。

这一步本身就在提醒我们：对 listener pipeline 来说，accept 事件到这里时，数据已经不是普通业务字节，而是“一条新连接对应的 child channel”。

所以 acceptor 的工作也不是“继续处理某段入站数据”，而是“接住一个新出生的连接对象”。

### 2. 为什么第一步是先给 child pipeline 加 `childHandler`

拿到 `child` 后，当前实现第一件事就是：

```java
child.pipeline().addLast(childHandler);
```

见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:226`。

这一步顺序非常重要。因为 child channel 之后马上就要：

- 设置 child options
- 设置 child attrs
- 触发扩展点
- 注册到 childGroup

其中注册之后，child 自己的 `channelRegistered`、`channelActive` 等生命周期事件就可能开始传播。那在这之前，child pipeline 至少得已经有它最核心的业务入口，也就是 `childHandler`。

这和第一篇里 `init(channel)` 必须先于 register 的逻辑是同一个味道，只是层次从“父 Channel 启动骨架”下降到了“子连接接管骨架”。

### 3. child options / attrs 为什么也要在 register 前落下去

`child.pipeline().addLast(childHandler)` 之后，acceptor 继续：

- `setChannelOptions(child, childOptions, logger)`
- `setAttributes(child, childAttrs)`

见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:228` 与 `:234`。

这说明 child 的配置也不是“注册后再慢慢补”。当前实现明确要求：

```text
在 child 真正归属 worker EventLoop 并开始经历自己的生命周期事件前，
它应当已经带着自己的 handler、options 和 attrs。
```

如果顺序反过来，让 child 先 register，再回头补 handler/options/attrs，那你就会重演第一篇里父 Channel 那个老问题：后续事件已经开始跑了，配置骨架却还没装稳。

### 4. extension 为什么放在 child register 之前

如果存在启用的 extensions，acceptor 会在注册前调用 `extension.postInitializeServerChildChannel(child)`，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:236`。

这里的顺序和前面保持一致：extension 的定位也是“初始化补充”，不是“运行时再修改”。`ChannelInitializerExtension` 自己的文档也明确限制：允许改 pipeline、attrs、options，但不要做 I/O、不要关 channel，见 `transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtension.java:109`。

这就说明 extension 在这里的角色，是 child 初始化链上的一个可选横插点，而不是独立运行态协议。

### 5. 最后才 `childGroup.register(child)`：到这里 child 才真正交给 worker 线

全部初始化动作落完之后，acceptor 才调用：

```java
childGroup.register(child).addListener(...)
```

见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:246`。

这一步就是子连接从“刚刚被 accept 出来”转成“真正交给 worker EventLoopGroup 管理”的瞬间。

所以整个 child 接管链可以压成：

```text
accept 出 child
  -> 给 child pipeline 装 childHandler
  -> 给 child 落 childOptions / childAttrs
  -> 跑 child extensions
  -> 把 child 注册给 childGroup
```

这条链看起来像细节罗列，但它其实就是服务端第二条初始化骨架。第一篇的 `initAndRegister()` 解决的是“父 Channel 怎样起飞”；这一节解决的是“每个 child 被 accept 之后怎样移交给 worker 与业务链”。

## 五、父/子 EventLoopGroup 分离：worker 不是装饰位，而是服务端把监听和连接处理拆开的那把刀

现在可以专门回答一个经常被口号化的问题：为什么服务端常说 boss/worker 分离？

### 1. `group(parent, child)` 和 `group(group)` 不是两套模式，而是是否显式分工

`ServerBootstrap.group(parentGroup, childGroup)` 很直接：父 listener channel 归 parent group，子连接归 child group，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:84`。

而重写后的单参数 `group(group)` 则直接调用 `group(group, group)`，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:72`。

这说明所谓“boss/worker 分离”在当前 API 里不是另起一套启动骨架，而只是：

```text
你可以显式给父监听链和子连接链不同的 EventLoopGroup；
如果不显式分，默认也可以让两条链共用同一组 EventLoop。
```

### 2. `childGroup == null` 的回退说明：分工是优化选择，不是协议前提

`ServerBootstrap.validate()` 里，如果 `childGroup == null`，当前实现会警告后回退到 `config.group()`，也就是 parent group，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:182`。

这一步特别能说明 Netty 的立场：

- 父子分离是常见、推荐、也更清楚的服务端部署形态。
- 但服务端启动协议本身并不强制要求两组 EventLoop 必须不同。

也就是说，这不是“少了 worker 就无法运行”，而是：

```text
服务端语义先分成父监听链与子连接链；
是否再给它们配不同 EventLoopGroup，是部署层面的进一步分工。
```

这条边界如果不说清，就容易把“boss/worker”讲成硬编码事实，好像 Netty 服务端必须两组线程才成立。当前实现并不是这样。

## 六、失败与恢复：子连接接管失败时为什么是 `forceClose`，监听异常时为什么临时关 `autoRead`

到这里，主成功路径已经清楚了，接着看失败怎么收。

### 1. child 初始化阶段一旦失败，当前策略是立刻 `forceClose`

无论是：

- `setChannelOptions(child, childOptions, logger)` 抛错
- 还是 `childGroup.register(child)` 抛错或 future 失败

当前 `ServerBootstrapAcceptor` 的处理都是 `forceClose(child, cause)`，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:228`、`:246`、`:257`。

这里的信号很明确：

```text
这条 child 连接既然连最基本的接管都没完成，
就不应该带着半初始化状态继续活着。
```

所以这里不是“先记日志再看看能不能凑合跑”，而是宁可马上强关，也不让一个配置没装稳、线程归属没落稳的 child 漏进运行态。

### 2. `exceptionCaught()` 里关的是 listener 的 `autoRead`，不是给 child 重连

acceptor 的 `exceptionCaught(...)` 做了一件很容易被误读的事：如果当前 listener channel 的 `config.isAutoRead()` 为 true，就先把它关掉，一秒后再重新打开，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:263`。

这一步千万别讲成“子 Channel 失败后一秒后重试连接”。它处理的根本不是 child 连接级重试，而是 listener channel 自己的接收节流：

```text
accept 路径如果持续出错，
先别疯狂继续接新连接了；
暂停 1 秒 autoRead，给监听链一个恢复窗口，随后再恢复接收。
```

源码注释也直接指向 issue #1328，说明这是一种 listener 级别的事故缓冲，而不是业务层重试协议。

### 3. 为什么恢复逻辑做成预先构造的 `enableAutoReadTask`

构造 acceptor 时，会先把 `enableAutoReadTask` 准备好，再在异常路径里 schedule 它，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:208`。

注释说明得很具体：这样做是为了避免某些极端文件句柄耗尽场景里，再临时创建任务对象/加载类时出问题。

这也是一个很典型的 Netty 风格小点：

```text
真正出问题的时候，
别再临时依赖更多可能失败的动作；
恢复用的最小任务，尽量提前准备好。
```

## 七、extensions：为什么要给 listener 和 child 准备两个插入时点

最后把扩展点边界收一下。

### 1. 当前扩展点默认关闭，而且不是普通业务 API

`ChannelInitializerExtension` 明确说了，这组扩展默认关闭，只有显式设置 `io.netty.bootstrap.extensions=serviceload` 才真正启用；设成 `log` 则只检测并记录，不运行，见 `transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtension.java:29` 与 `transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtensions.java:45`。

所以这不该被写成“ServerBootstrap 常规配置的一部分”。更准确的定位是：

```text
这是一个进程级、ServiceLoader 驱动、默认关闭的初始化扩展面。
```

### 2. listener 和 child 为什么是两个回调时点

当前服务端有两个明确的 extension 切入点：

- `postInitializeServerListenerChannel(serverChannel)`：listener channel 初始化后，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:164`。
- `postInitializeServerChildChannel(child)`：child channel 初始化后、register 前，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:236`。

这两点再次印证了本文主线：服务端不是单条初始化链，而是父和子两条链。

如果只有一个统一扩展回调，就会把这两种时机重新揉成一团；可很多规则恰恰只该打到其中一边：

- 某些监听级别规则应当作用于父 listener。
- 某些连接级别规则应当作用于每个 child。

所以 extension 设计成双时点，不是为了 API 丰富，而是为了尊重服务端本来就分成两层的生命周期。

### 3. `ChannelInitializerExtensions` 的三态与排序说明它是全局设施，不是局部助手

`ChannelInitializerExtensions.getExtensions()` 根据系统属性返回三种实现：

- `none`：空实现
- `serviceload`：加载并缓存扩展
- `log`：只检测并记录可用扩展

见 `transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtensions.java:45`。

如果真正加载扩展，还会按 `priority()` 排序后再注册，见 `transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtensions.java:102`。

这说明它的设计目标不是“某个 bootstrap 临时顺手加个钩子”，而是：

```text
允许同一 JVM 里分散使用 Netty 的多个地方，
在不修改各自调用代码的前提下，
统一插入初始化规则。
```

这条边界也决定了本文对它的讲法：点明它为何存在、在哪两个服务端时点介入即可，不把它写成常规业务开发主线。

## 八、收网：ServerBootstrap 真正多出来的，不是 child 配置项，而是第二条初始化骨架

现在回到这篇的核心问题：为什么服务端不能像客户端那样，一次把 handler 都挂完？

因为服务端启动的对象从来不只是一条 Channel 生命周期。

它至少包含两层：

- 父 listener channel：负责监听与 accept。
- 子 child channel：负责每条连接自己的 pipeline、选项、属性和后续 I/O。

所以 `ServerBootstrap` 真正比 `Bootstrap` 多出来的，不是几个 child 字段，而是第二条初始化骨架：

```text
第一层：listener channel 初始化
  -> listener 自己的 options / attrs
  -> 一次性的 ChannelInitializer
  -> listener handler
  -> ServerBootstrapAcceptor

第二层：child channel 初始化
  -> childHandler
  -> childOptions / childAttrs
  -> child extensions
  -> childGroup.register(child)
```

而 `ChannelInitializer` 则是把这两层接上去的关键脚手架：

- 它保证初始化只跑一次。
- 它保证嵌套 initializer 和注册事件顺序不乱。
- 它保证自己做完后及时退场，不污染运行态 pipeline。

所以这篇真正该带走的，不是“ServerBootstrapAcceptor 会在 `channelRead` 里做几步”，而是下面这句话：

```text
ServerBootstrap 的本质，是把服务端从“一条启动链”拆成“父监听链 + 子连接链”两次初始化，
然后用 acceptor 把两次初始化接起来。
```

到这里，Bootstrap 这一章才算真正闭环。

第一篇解释了：一个 Channel 怎样被创建、初始化并归属 EventLoop。
第二篇解释了：服务端怎样在父 listener 和子连接之间继续做第二次初始化分工。

下一章进入 Codec 时，视角就不再是“系统怎么启动”，而是“这些已经装好的 child pipeline 终于开始面对真正的 TCP 字节流，怎样把半包、粘包和原始字节切成业务消息”。