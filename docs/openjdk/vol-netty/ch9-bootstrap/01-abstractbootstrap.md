# AbstractBootstrap：为什么 `bind()` 不是直接绑端口，而是先走一段三步状态机

> 本文基于当前 Netty `AbstractBootstrap`、`Bootstrap`、`ServerBootstrap`、`ReflectiveChannelFactory` 与 `AbstractBootstrapConfig` 实现。前置：Ch5 EventLoop、Ch6 Promise/Future、Ch7 `04-init-and-lifecycle.md`、Ch8 `01-allocator-and-arena.md` 与 `04-pooledbuf-lifecycle.md`；本文聚焦 Bootstrap 启动骨架——Fluent API 的自类型设计、`validate -> initAndRegister -> doBind0` 三步状态机、`PendingRegistrationPromise`、失败路径与 client/server 对称入口，不展开 `ServerBootstrapAcceptor` 的子 Channel 生命周期细节。

## 前八章讲的都是零件，到了 Bootstrap 才第一次变成“系统启动”

如果把前面八章连起来看，会发现 Netty 到目前为止讲过的几乎都是零件。

- Ch4 讲 `ByteBuf`，说明数据将来装在哪种缓冲区里。
- Ch5 讲 `EventLoop`，说明 I/O 和任务最终由谁在线程里驱动。
- Ch6 讲 `Promise/Future`，说明异步动作如何把完成、失败和监听器串起来。
- Ch7 讲 `Pipeline`，说明事件和数据将来从哪些 handler 身上流过。
- Ch8 讲内存池，说明高频申请与归还 `ByteBuf` 时，底层内存如何复用。

这些东西每一项都很重要，但它们到上一章为止还只是“随时可被拿来使用的能力”，并没有回答一个真正运行时的问题：

```text
一个 Netty 服务端到底从哪一刻开始，才算真的启动了？
一个客户端连接到底从哪一刻开始，才算真的进入 connect 流程？
前面这些基础设施是谁、按什么顺序、在哪条线程上把它们装到一起的？
```

这正是 Bootstrap 这一章第一次要回答的主问题。

因为从调用者视角看，启动 Netty 往往就是一串非常流畅的链式调用：

```java
new ServerBootstrap()
    .group(boss, worker)
    .channel(NioServerSocketChannel.class)
    .childHandler(...)
    .bind(8080);
```

或者客户端版本：

```java
new Bootstrap()
    .group(group)
    .channel(NioSocketChannel.class)
    .handler(...)
    .connect(host, port);
```

如果只盯着最后那个 `bind()` 或 `connect()`，很容易觉得 Bootstrap 干的只是“把已经配置好的参数往底层 API 里一塞”。可一旦把视角拉回前面几章，你就会意识到这事根本没那么薄。

在真正 `bind` 或 `connect` 之前，至少还有几件事必须已经成立：

- Channel 实例得先被创建出来。
- Pipeline 得先装上初始 handler。
- Channel 得先归属到某个 EventLoop。
- 后续真正的 I/O 动作得在这个 EventLoop 线程里发起。
- 这一整串动作里任何一步失败，都得以 `Future/Promise` 协议的形式交还给调用者。

也就是说，Bootstrap 真正干的不是“直接启动”，而是把启动压缩成一个调用者看起来很短、内部却有严格先后约束的装配过程。

先把本文最核心的一句话放前面，后面会反复回收：

```text
AbstractBootstrap 的关键不在于 Fluent API 有多顺手，
而在于它把启动拆成了三段必须按顺序完成的状态机：
先校验，再创建并注册 Channel，最后把真正的 bind/connect 异步投递到该 Channel 所属的 EventLoop。
```

如果少了这条主线，后面读源码就很容易滑回一种误解：以为 `bind()` 本质上只是 `channel.bind()` 的别名；以为 `connect()` 多出来的也不过是 DNS 解析；以为 `PendingRegistrationPromise` 只是“为了异步风格统一”才存在。当前实现都不是这样。

## 一、如果想把启动压成“一口气直接做完”，会在三处撞墙

正式看源码前，先故意走几条最容易让人觉得省事、但在 Netty 里会出事的路。

### 1. 失败方案一：配置不完整也没关系，启动时碰到再说

最朴素的想法是：Bootstrap 不过是个配置器，`group`、`channelFactory`、`handler` 这些东西，能不能等真正启动时“按需取用”？如果缺了哪个，再在底层抛个错不就行了。

这种做法看起来弹性大，实际上会让错误出现在最不该出现的地方。

想象一下下面几种情况：

- `group` 还没设置，但你已经开始创建 Channel 了。
- `channelFactory` 还没设置，但已经走到 `newChannel()` 这一步了。
- `ServerBootstrap` 连 `childHandler` 都没配，服务端监听却已经开始启动了。

这时候错误不再是“配置阶段少了一项”，而会演变成“启动链走到一半才发现没法继续”。那你就得在已经创建一部分对象、甚至已经挂上部分 pipeline 的中间状态里回滚。

所以 Bootstrap 的第一道门不是“开始启动”，而是“先保证配置已经最起码能启动”。当前 `AbstractBootstrap.validate()` 就专门做这件事：检查 `group` 和 `channelFactory` 是否存在，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:223`；而 `Bootstrap.validate()`、`ServerBootstrap.validate()` 又分别把 client `handler` 与 server `childHandler` 的约束补上，见 `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:287` 与 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:176`。

也就是说，Bootstrap 不允许“缺口带入运行态再说”。

### 2. 失败方案二：先 `bind/connect`，再慢慢把 Channel 挂到 EventLoop 上

第二条更容易掉进去的误解是：反正最后都要执行 `channel.bind()` 或 `channel.connect()`，那为什么不把这个动作先发出去，等底层 socket 已经在路上了，再把 Channel 注册给 EventLoop 呢？

这条路的问题，不是 API 美观，而是线程归属。

前面 Ch5 已经反复建立过一条纪律：Netty 里的 I/O 动作并不是“谁拿到 Channel 谁就能随便调”，而是要受该 Channel 所属 EventLoop 线程约束。换句话说：

```text
不是先有 I/O，再决定归谁管；
而是先决定这个 Channel 属于哪个 EventLoop，再让真正的 I/O 从那个线程发起。
```

如果顺序反过来，马上就会出现两个问题：

- 你在调用线程里做了 bind/connect，但这个 Channel 未来真正的状态事件却要在另一个 EventLoop 线程里继续传播。
- `channelRegistered`、pipeline 初始化、底层 bind/connect 这几个动作的先后顺序被打乱，用户 handler 还来不及在注册阶段补完 pipeline，底层 I/O 就已经冲出去了。

当前 `doBind0(...)` 和 `doConnect(...)` 都明确把最后一步包装成 `channel.eventLoop().execute(...)`，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:371` 与 `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:248`。这已经很清楚地表明：真正的 bind/connect 不是“调用线程现在就做”，而是“等这个 Channel 归属的 EventLoop 线程来做”。

### 3. 失败方案三：注册是异步也没关系，直接继续 bind/connect 就行

第三条失败方案最微妙，因为它半真半假。

`group.register(channel)` 返回的是 `ChannelFuture`。既然是 Future，就意味着注册未必已经在当前线程同步完成。很多人读到这会自然问：既然注册可能还没 done，那 `bind()` / `connect()` 后面是不是就应该直接等它结束？或者反过来，既然 Netty 大量逻辑都在同一个 EventLoop 里串行执行，那注册 future 没完成也无所谓，后面继续把 bind/connect 请求塞进去不就行了？

这两种想法各有一半道理，所以也是最容易讲糊的地方。

Netty 当前实现的真实态度是：

```text
注册 future 未必已经完成，
但启动骨架不能因此阻塞；
同时后续 promise 的执行器归属又必须在注册成功后才稳定下来。
```

这就逼出了 `PendingRegistrationPromise` 这条缝补机制。它不是“异步风格统一”的小装饰，而是专门处理“register 可能还没完成，但我又得先把后续 promise 占住位置”这个缝。

这件事我们后面单独展开。先在这里记住一个路标：

```text
Bootstrap 的难点不是三段逻辑本身有多复杂，
而是这三段逻辑既要保持严格顺序，
又不能靠阻塞把顺序硬等出来。
```

## 二、CRTP 自类型：Fluent API 看起来只是手感问题，实际上在保护子类语义

开始进入源码之前，先看 `AbstractBootstrap` 的类型声明：

```java
public abstract class AbstractBootstrap<B extends AbstractBootstrap<B, C>, C extends Channel>
```

见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:55`。

这就是典型的 CRTP，也可以理解成 self-typed fluent API：让父类知道“我操作链最后返回的还是哪个具体子类”。

### 1. 为什么它不是“写泛型炫技”，而是链式配置必须解决的问题

Bootstrap 的配置 API 大量依赖方法链：

- `group(...)`
- `channel(...)`
- `option(...)`
- `attr(...)`
- `handler(...)`

这些方法都定义在 `AbstractBootstrap` 里，但真实调用者有两类：

- `Bootstrap`
- `ServerBootstrap`

如果父类这些方法统一返回 `AbstractBootstrap`，那调用链一旦走进父类方法，静态类型就会被抹平。你马上会遇到一个非常具体的问题：

```text
ServerBootstrap.group(...)
  -> 如果返回 AbstractBootstrap
  -> 后面就未必还能继续调 childHandler(...) / childOption(...)
```

因为这些 server 专属方法并不在父类上。

当前实现用 `self()` 把 `this` 转回 `B`，再让 `group()`、`option()`、`attr()` 之类方法统一返回 `B`，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:105`。这样 `ServerBootstrap` 调这些父类方法后，静态类型仍然是 `ServerBootstrap`，而不是被拍扁成父类。

### 2. 如果只返回 `Object` 或父类，会坏的不是运行时，而是调用链本身

这里要特别区分“类型系统里的坏”和“运行时里的坏”。

如果全改成返回 `Object`，运行时当然也能把配置存进去；如果全改成返回 `AbstractBootstrap`，底层字段照样能被设置。也就是说，逻辑不一定立即错。

但调用者写出来的 API 就会变得很别扭：

```text
链式配置在走到父类方法后丢失子类语义
  -> 你得不断强转
  -> 要么父类被迫暴露一堆并不属于所有子类的配置项
```

这会把本来清楚的 client/server 分层搅乱。

所以这一层泛型设计虽然不像 `doBind()` 那样直接关乎启动时序，却在更早的地方保护了一件事：

```text
同一套启动骨架由父类复用，
但 client 和 server 的配置表面仍保持各自的专属语言。
```

这其实已经预告了本文后面的一条主线：Bootstrap 体系是“共骨架，不共角色细节”。

## 三、启动真正的骨架：`validate -> initAndRegister -> doBind0`

现在进入本文最核心的部分。

以 `bind(SocketAddress)` 为例，当前 `AbstractBootstrap` 的外层入口非常短：先 `validate()`，再 `doBind(localAddress)`，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:286`。真正值得讲的是 `doBind()` 内部如何拆分动作，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:291`。

### 1. 第一步 `validate()`：别把不完整配置带进启动链

前面已经说过，`validate()` 不是样板式空检查，而是启动状态机的第一道闸门。

对 `AbstractBootstrap` 而言，它保证两件最基础的事：

- 有 `group`
- 有 `channelFactory`

对 `Bootstrap` 而言，还必须有 client `handler`；对 `ServerBootstrap` 而言，还必须有 `childHandler`，并在 `childGroup` 为空时回退到 parent group，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:182`。

这一层的作用不是“早点报错”这么简单，而是：

```text
只要启动已经进入后两步，
代码就默认“现在讨论的不是配置是否完整，
而是启动流程如何排时序、如何收失败”。
```

没有这道门，后面的状态机就会被“配置本来就缺失”这种低层问题持续污染。

### 2. 第二步 `initAndRegister()`：真正把“抽象配置”落成一个有归属的 Channel

`initAndRegister()` 是 Bootstrap 从“配置对象”迈向“运行对象”的真正转折点，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:324`。

它的顺序非常清楚：

```text
1. channelFactory.newChannel()
2. init(channel)
3. config().group().register(channel)
```

这三步一旦调换，就会破坏前面几章建立过的职责边界。

#### 为什么先 `newChannel()`

这个显而易见，但仍值得点出来：Bootstrap 首先得拿到一个真正的 `Channel` 实例，否则后续谈 pipeline、eventLoop、options、attrs 都无处附着。

当前默认常见路径是 `channel(Class)` 把 `Class<? extends C>` 包成 `ReflectiveChannelFactory`，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:115`。而 `ReflectiveChannelFactory` 在构造时就缓存无参 `Constructor`，后续 `newChannel()` 只做 `constructor.newInstance()`，见 `transport/src/main/java/io/netty/channel/ReflectiveChannelFactory.java:27`。

这里要特别纠正一个很容易沿大纲写错的点：当前不是“每次 newChannel 再查一遍 constructor”。查 constructor 发生在 `ReflectiveChannelFactory` 构造时，不在每次启动的热路径上。

#### 为什么 `init(channel)` 在 `register(channel)` 之前

这是启动时序里最关键、也最容易被忽略的一步。

`init(channel)` 是一个抽象钩子：client 的 `Bootstrap.init(...)` 会把 client handler、options、attrs 和扩展回调装到新 Channel 上，见 `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:267`；server 的 `ServerBootstrap.init(...)` 则会把 listener channel 自己的 options/attrs 先设好，再通过一个 `ChannelInitializer` 把后续 acceptor 延迟挂进去，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:132`。

这一步必须发生在 register 之前，因为一旦 register 发生，`channelRegistered` 这样的生命周期事件就可能马上传播。那时如果 pipeline 还没装出最基本的初始骨架，用户自定义的注册阶段逻辑就会错过时机。

所以 `init(channel)` 的本质不是“顺便加几个 handler”，而是：

```text
在这个 Channel 真正归属于某个 EventLoop 并开始接收生命周期事件前，
先把它最起码的运行骨架搭起来。
```

#### 为什么 `register(channel)` 才是“这个 Channel 真正进入 Netty 运行态”的那一步

当 `config().group().register(channel)` 被调用后，这个 Channel 才第一次和 EventLoop 建立起正式归属关系，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:340`。

从这一刻开始，后面所有 bind/connect 之类 I/O 动作都不该再被理解成“谁手上拿着引用谁就能调”，而应理解成：

```text
这个 Channel 已经有了自己的运行线程归属
后面的 I/O 动作应该由那条 EventLoop 线程发起
```

也正因为如此，Bootstrap 虽然对外暴露的是一串链式 API，但真正把它从“配置器”变成“运行态装配器”的，是 `register(channel)` 这一步，而不是最后那个 `bind()` 方法名本身。

### 3. 第三步 `doBind0()`：即使注册已成功，也不在调用线程里直接 bind

`doBind()` 在拿到 `regFuture` 之后，并没有自己直接调 `channel.bind(localAddress, promise)`。当前实现无论 `regFuture` 是已完成还是未完成，最终都会走到 `doBind0(...)`，而 `doBind0(...)` 又明确把真正的 bind 包进 `channel.eventLoop().execute(...)`，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:371`。

这段代码前面的注释把动机点得非常准确：

```text
这个方法在 channelRegistered() 触发之前就会被调用，
所以要给用户 handler 一个机会，让它们在 channelRegistered() 里继续补 pipeline。
```

这意味着 `doBind0()` 的异步投递不是“懒得当前线程执行”，而是同时在保护两件事：

- 线程归属：真正的 I/O 在该 Channel 所属的 EventLoop 线程里发起。
- 生命周期顺序：用户 handler 仍有机会在 `channelRegistered` 阶段补完初始化，再进入真实 bind。

如果当前线程里直接 `channel.bind()`，前面失败方案二里提到的两个问题就会同时冒出来。

到这里，Bootstrap 的三步状态机可以先压成一张总图：

```text
validate()
  -> 启动资格检查

initAndRegister()
  -> new Channel
  -> init pipeline / options / attrs
  -> 归属到 EventLoop

doBind0() / doConnect()
  -> 把真正 I/O 动作异步提交给该 EventLoop
```

这张图就是本文最重要的骨架。后面无论讲 bind 还是 connect，本质都在这条骨架上变体，而不是另起一套完全独立的启动逻辑。

## 四、`PendingRegistrationPromise`：它补的不是“异步风格”，而是“注册未完成时 promise 归谁管”的缝

现在可以专门收最微妙的那部分了。

`doBind()` 一拿到 `regFuture`，会先看三件事：

- `regFuture.cause() != null`：注册已经失败，直接返回。
- `regFuture.isDone()`：注册已完成，可以直接创建普通 promise，进入 `doBind0()`。
- 否则：注册尚未完成，进入 `PendingRegistrationPromise` 分支。

见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:291`。

### 1. 为什么“注册尚未完成”是一个真的需要被补的状态，而不是理论分支

源码注释已经说得很坦白：`regFuture` “几乎总是已经完成”，但不是绝对，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:304`。

这里的关键不在于这个分支常不常见，而在于：只要它可能发生，Bootstrap 就必须把它讲明白。因为一旦这里处理糊了，后面的 bind/connect promise 归属就会出问题。

注册尚未完成时，当前 Channel 还没稳定绑定到自己的 EventLoop 执行器上。可调用者这时候已经拿到了启动返回的 future；也就是说，Bootstrap 必须先给调用者一个 promise 占位，但这个 promise 又不能假装自己已经有了正确 executor。

这就是 `PendingRegistrationPromise` 存在的真正原因。

### 2. 它解决的不是“什么时候继续 bind”，而是“在此之前 listener 通知由谁执行”

很多人第一次看到这个类，会以为它只是把 `doBind0()` 延迟一下。其实延迟 bind 只是表面现象，真正关键的是它覆写了 `executor()`，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:525`。

当前实现的逻辑是：

- 注册成功前，`registered == false`，通知回退到 `GlobalEventExecutor.INSTANCE`。
- 注册成功后，调用 `registered()` 把标记拉起，此后 `executor()` 再回到 `super.executor()`，也就是 Channel 自己的执行器。

这说明 `PendingRegistrationPromise` 补的不是一句“等注册完了再说”，而是一条更具体的缝：

```text
现在我已经得把 promise 交给调用者，
但这个 promise 的正确执行器还没稳定下来；
在注册成功前，我只能退回 GlobalEventExecutor，
等注册真正成功，再切回 Channel 自己的 EventLoop executor。
```

这就是为什么它不是普通 `DefaultChannelPromise` 直接顶上就行的原因。

### 3. 为什么不能干脆阻塞等注册完成

到这里有人会自然问：既然只差注册这一步，为什么不直接同步等 `regFuture` 完成，再继续 bind/connect？

这看似省掉了 `PendingRegistrationPromise`，其实把 Bootstrap 设计整条路都推翻了。

前面 Ch6 已经把 Netty 的异步协议讲得很清楚：Future/Promise 的存在不是装饰，而是承认“这类动作本来就不该靠调用线程阻塞等待”。如果 Bootstrap 在这里选择阻塞：

- 启动调用会把线程挂住。
- EventLoop 线程归属与监听器通知的异步语义会被硬抹平。
- 更糟的是，一旦调用线程本身就在某些不该阻塞的上下文里，问题会迅速外溢。

所以 Netty 的选择不是“把不稳定状态藏起来”，而是：

```text
承认 register 可能尚未完成，
但用一个过渡 promise 把这段时间里的执行器归属与失败通知处理好。
```

这才是 `PendingRegistrationPromise` 的真正教学意义。它让我们看到 Bootstrap 不是简单串 API，而是在认真处理“异步启动链条中，某一步尚未收口时，后继 promise 如何仍然成立”。

## 五、失败路径：为什么即便 `newChannel()` 崩了，也要还你一个失败的 `ChannelFuture`

启动骨架如果只讲成功路径，很容易写成顺滑故事；但 Bootstrap 这类装配器真正的成熟度，往往体现在失败路径怎么收。

### 1. `initAndRegister()` 里失败可能发生在 Channel 存在前，也可能发生在存在后

当前 `initAndRegister()` 把 `channelFactory.newChannel()` 与 `init(channel)` 包在同一个 try 里，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:324`。这意味着失败点有两种：

- `channelFactory.newChannel()` 直接失败，`channel == null`。
- `newChannel()` 成功了，但 `init(channel)` 失败，`channel != null`。

这两个分支的收尾不一样：

- 若 `channel != null`，要先 `channel.unsafe().closeForcibly()`，再返回一个失败的 `DefaultChannelPromise(channel, GlobalEventExecutor.INSTANCE)`。
- 若 `channel == null`，则返回绑定在 `FailedChannel` 上的失败 promise，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:337`。

### 2. 为什么不能直接返回 null

这件事最核心的原因，不是“API 风格统一”，而是异步协议不能突然塌掉。

调用者调用 `bind()` / `connect()` 时，拿到的约定一直都是 `ChannelFuture`。它后面可能会：

- `addListener(...)`
- `sync()` / `await()`
- 检查 `cause()`
- 从 `future.channel()` 往后挂链路

如果某些失败场景直接返回 null，调用者整个心智模型就会被撕裂：

```text
成功时我是 Future 协议
失败时突然变成 null 检查协议
```

这不仅难用，更重要的是它会把错误处理从一条统一的异步链打散。

所以当前实现即便在“连 Channel 都没真正建起来”的情况下，也要塞一个 `FailedChannel` 进去，保证返回值仍然是一个失败的 `ChannelFuture`。这就维持住了对上层最重要的一条契约：

```text
启动结果永远通过 Future 协议返回，
而不是成功失败各走一套接口。
```

### 3. 为什么这里要临时回退到 `GlobalEventExecutor`

无论 `channel != null` 还是 `channel == null` 的失败分支，当前实现都明确用 `GlobalEventExecutor.INSTANCE` 作为 promise 的执行器，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:334` 与 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:337`。

原因很直接：这时候 Channel 还没有完成注册，根本谈不上依附它自己的 EventLoop 来通知 promise。既然所属执行器未建立，就只能退回一个全局兜底执行器，把失败通知这件事本身先守住。

这和前面 `PendingRegistrationPromise` 的逻辑其实是一致的：

```text
只要 Channel 还没稳定归属于自己的 EventLoop，
Promise/Future 的通知执行器就不能假装已经就位。
```

## 六、`bind()` 和 `connect()` 共用同一套骨架，但最后一步不一样

讲到这里，可以把 server 和 client 放在一起对照了。

### 1. 它们不是两套启动体系，而是一套公共骨架的两种出口

`bind()` 走的是：

```text
validate()
  -> initAndRegister()
  -> doBind0()
```

`connect()` 走的是：

```text
validate()
  -> initAndRegister()
  -> doResolveAndConnect0()
  -> doConnect()
```

见 `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:163`。

也就是说，client 和 server 最大的共同点不是“都能链式调用”，而是：

```text
它们共享同一套启动骨架：
先校验
再创建并注册 Channel
最后把真正 I/O 动作投到 EventLoop
```

真正分叉，只出现在最后一步：server 是 bind，本地监听；client 是 resolve + connect，远端连接。

### 2. `connect()` 比 `bind()` 多的不是另一套状态机，而是一道地址解析关口

`Bootstrap.doResolveAndConnect0(...)` 在真正 `doConnect(...)` 前，多看了一层 resolver：

- 若 `disableResolver` 开启，直接走 connect。
- 若地址不支持解析或已经 resolved，直接走 connect。
- 否则先 `resolver.resolve(remoteAddress)`，成功后再 `doConnect(...)`。

见 `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:194`。

这说明 client 比 server 多出来的，不是另一条完全独立的启动架构，而只是：

```text
在“最后把 I/O 投到 EventLoop”之前，
有时得先把远端地址解析成真正可连接的地址。
```

所以如果把 `connect()` 写成“客户端启动体系完全不同于 bind”，就会把两者骨架上的共性写没了。

### 3. `Bootstrap.init(...)` 与 `ServerBootstrap.init(...)` 也体现了“共骨架，不共角色细节”

前面说过，`init(channel)` 是启动骨架里的一个抽象钩子。

client 版本的 `Bootstrap.init(...)` 很直接：把 `config.handler()` 放进 pipeline，再设置 options、attrs 和可选扩展，见 `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:267`。

server 版本的 `ServerBootstrap.init(...)` 则更复杂一点：

- 先给 listener channel 自己设置 options 和 attrs。
- 再向 pipeline 放一个 `ChannelInitializer`。
- 这个 initializer 里会先把 server 自己的 handler 挂上。
- 然后通过 `eventLoop().execute(...)` 延迟把 `ServerBootstrapAcceptor` 挂进去，见 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:145`。

但这一篇先不深入 acceptor 细节。现在只需要抓住一条：

```text
Bootstrap 骨架共用，
真正角色差异被收进了 init(channel) 这个钩子里。
```

这也是为什么上一节讲 CRTP 自类型时说它不是单纯语法糖：它让父类能复用同一套装配骨架，同时允许 client/server 在角色专属部分保留各自的配置语言和初始化动作。

## 七、`clone()`、`config()` 与 `ReflectiveChannelFactory`：别把它们写成“不可变配置系统”

讲 Bootstrap 很容易被 Fluent API 表面吸引，然后顺手把 `clone()`、`config()`、`channelFactory` 写成一套“优雅配置系统”。当前源码其实比这更朴素，也更值得按边界讲清楚。

### 1. `config()` 提供的是只读视图，不是冻结后的不可变 Bootstrap

`AbstractBootstrap.config()` 返回的是一个配置视图对象，client 对应 `BootstrapConfig`，server 对应 `ServerBootstrapConfig`，见 `transport/src/main/java/io/netty/bootstrap/BootstrapConfig.java:26` 与 `transport/src/main/java/io/netty/bootstrap/ServerBootstrapConfig.java:30`。

这些 config 对象做的事情很克制：

- 暴露 `group()`、`channelFactory()`、`options()`、`attrs()`、`handler()` 等 getter。
- 对 options/attrs 返回复制后的只读 map，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:452`。
- 在 server/client 侧额外补充 `remoteAddress()`、`resolver()`、`childGroup()`、`childHandler()` 这类角色专属只读入口。

所以它更准确的定位是：

```text
这是当前 bootstrap 状态的只读观察窗，
不是说 bootstrap 本体此后就被冻结不可变了。
```

这条边界必须写清，否则很容易把它讲成 builder `build()` 之后返回的 immutable config。当前实现不是那一套。

### 2. `clone()` 复制的是配置容器内容，不是整套运行资源

`AbstractBootstrap` 拷贝构造函数会复制 `options`、`attrs` 这些 map 内容，但 `group`、`channelFactory`、`handler`、`localAddress` 等是引用拷贝，见 `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:80`。`Bootstrap.clone()` 和 `ServerBootstrap.clone()` 也只是基于这个拷贝构造继续构造新实例，见 `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:296` 与 `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:277`。

这意味着 clone 的语义不是：

```text
复制出一套完全独立的新运行时资源
```

而是：

```text
复制出一份配置容器内容相同、
但底层共享 group / handler / channelFactory 等引用的 bootstrap 壳子
```

这和大纲里“options 深拷贝、handler 浅拷贝”的方向是一致的，但正文里必须把“深拷贝”这个词收紧：准确地说，是 map 内容被复制，运行资源并没有整体克隆。

### 3. `ReflectiveChannelFactory` 也不是“每次都反射一遍”

前面已经顺手点过一次，这里再单独收一下。

`ReflectiveChannelFactory` 在构造时保存 `Constructor<? extends T> constructor`，后面每次 `newChannel()` 只调 `constructor.newInstance()`，见 `transport/src/main/java/io/netty/channel/ReflectiveChannelFactory.java:29`。

所以这里更准确的说法应该是：

```text
Bootstrap 默认通过一个预先拿到无参构造器的工厂创建 Channel；
每次启动仍然要 new 新 Channel，
但不是每次都重新做 constructor 查找。
```

这虽然不是本文主线，但如果写错，会把读者带到一条“反射每次都很重，所以 Bootstrap 热路径怎样怎样”的误区里去。

## 八、收网：Bootstrap 不是“帮你 new Channel”，而是把启动压成了三段有线程归属的装配协议

现在可以回到开头那个问题了：为什么 `bind()` 不是直接绑端口？

因为对 Netty 来说，真正要启动的从来不只是一个底层 socket 操作。

在 `bind()` 或 `connect()` 真正发生之前，至少还有三件事必须先落稳：

- 配置得先完整到足以启动。
- Channel 得先被创建并完成初始骨架装配。
- Channel 得先归属于某个 EventLoop，后续真正 I/O 才能从正确线程发起。

所以 `AbstractBootstrap` 真正的工作，不是“最后代你调一下底层 API”，而是把启动压缩成一条三步状态机：

```text
validate()
  -> 把不完整配置挡在门外

initAndRegister()
  -> 把抽象配置落成一个真正有 pipeline、有 options/attrs、且已归属 EventLoop 的 Channel

doBind0() / doConnect()
  -> 把真正 I/O 动作异步投给该 Channel 所属的 EventLoop
```

而 `PendingRegistrationPromise` 则是这条状态机里最容易被忽略、却最能体现 Netty 味道的补缝器：它承认 register 可能尚未完成，但不靠阻塞硬等，而是把“这时 promise 的执行器该归谁”这件事认真补平。

所以这一篇真正该带走的，不是 Bootstrap Fluent API 的表面写法，而是下面这句话：

```text
Bootstrap 的本质，是把启动从“我现在就去做一个 I/O 动作”
改写成“我先把 Channel 正确装配并归属线程，再让那个线程去做 I/O 动作”。
```

到这里，父 Channel 或 client Channel 的启动骨架就算收拢了。

下一篇再继续往 server 深处走：第一篇只讲“父 Channel 怎样被创建、初始化并注册”；第二篇要看 `ServerBootstrapAcceptor` 如何接住 accept 出来的子 Channel，把它们交给 child EventLoopGroup、child pipeline 和 child options/attrs，前面几章讲过的运行时零件，才会第一次在“父监听 / 子连接”这层真正分家。