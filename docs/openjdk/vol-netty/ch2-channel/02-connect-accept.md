# Channel 的连接与接受：一个两拍完成，一个回来却还是阻塞的

> 本文基于 JDK 11 NIO `SocketChannel` / `ServerSocketChannel` 实现。前置：Ch1 ByteBuffer 三篇、Ch2-01 `01-read-write.md`；本文只讲连接建立与接受连接这条主线，Selector 事件分发放到 Ch3。

## 同样是 Channel，为什么一个要分两拍，一个又像回到了 BIO

上一节刚建立一个直觉：NIO Channel 不会替你把所有事情做完。`read()` 只告诉你这次读到了多少、暂时没数据还是已经 EOF；`write()` 只告诉你这次写出多少，剩下的进度要靠 Buffer 自己保存。

到了连接建立阶段，这个直觉会被再次放大。

客户端第一次接触 `SocketChannel.connect()` 时，最容易带着老 `Socket` 的习惯：调用一次 `connect()`，连接就算建立好了，后面自然可以 `read()`、`write()`。可一旦切到非阻塞模式，`connect()` 可能立刻返回 `false`。它没有抛异常，也没有告诉你“成功”；它只是说：我已经替你把连接发起出去了，但这件事还没完。

服务端这边又是另一种反直觉。很多人把 `ServerSocketChannel` 设成了非阻塞模式，觉得整个服务端都已经进入 NIO 世界了，于是下意识以为 `accept()` 拿到的新 `SocketChannel` 也会延续这个设定。结果真正把它拿去注册 Selector 时才发现：这个新 child channel 居然默认还是阻塞的。

于是同一个 Channel 家族里出现了两种看上去很不统一的行为：

```text
客户端 connect：
发起连接 -> 可能先返回 false -> 以后再 finishConnect()

服务端 accept：
监听 socket 可设成非阻塞 -> accept() 拿到 child socket
                                 -> child 默认仍是阻塞
```

这不是 API 设计者忘了统一，而是 NIO 在两个方向上分别做了不同折中。

- 客户端 connect 被拆成两拍，是为了不让线程在三次握手期间白白卡住。
- 服务端 accept 返回阻塞 child channel，则是为了和旧 `Socket` 世界保持兼容。

这一篇要回答的核心问题其实只有一个：为什么连接建立阶段会出现这两个折中点，以及上层框架为什么必须主动接管它们。

## 一、一个连接为什么不能只靠一次 connect

先把最朴素的想法摆出来：既然 API 叫 `connect()`，那它最自然的语义就应该是“连上再返回”。

这个想法在阻塞模式里成立。`SocketChannel` 的抽象合同写得很明确：如果当前 channel 处于阻塞模式，`connect()` 会一直等到连接建立或失败再返回；但如果它处于非阻塞模式，这个调用只负责发起连接，若不能立刻成功，就返回 `false`，后续必须由 `finishConnect()` 完成连接流程，见 `SocketChannel.java:330` 和 `SocketChannel.java:397`。

也就是说，NIO 没有发明另一套“非阻塞专用连接 API”，而是把差异压进了同一个方法合同里：

```text
blocking connect
  -> 调用线程等待建立完成/失败
  -> 返回 true 或抛异常

non-blocking connect
  -> 先发起连接
  -> 立即返回 true 或 false
  -> false 表示还在进行中，后续必须 finishConnect()
```

这个设计解决的不是“语法统一”问题，而是线程所有权问题。

如果一个事件循环线程同时管理很多连接，它不可能在某个连接的三次握手上长时间停住。因为一旦这里停住，其他连接的读写、定时任务、关闭动作就都跟着一起停住了。非阻塞 connect 的核心价值，不是让连接“更快”，而是把“等待连接完成”这段时间从线程上拿掉。

但线程不等待，不代表连接就神奇地自动完成了。它只是把“发起”与“确认”拆成了两个动作：

```text
第一拍：connect(remote)
  -> 告诉内核开始连
  -> 这一步可能成功，也可能只是进入进行中

第二拍：finishConnect()
  -> 重新回来确认结果
  -> 成功才真正进入 connected 状态
```

如果把这个两拍模型记住，后面很多返回值就不再奇怪。`false` 的意思不是“这次连接失败”，而是“你问早了，连接还在路上”。

## 二、connect：第一拍只负责把连接发出去

JDK 11 里的 `SocketChannelImpl.connect()` 先做地址检查和安全检查，然后进入一个很紧的主流程，见 `SocketChannelImpl.java:672`。

真正值得记的不是每一行调用，而是这条状态链：

```text
connect(remote)
  -> beginConnect(blocking, remote)
  -> state: ST_UNCONNECTED -> ST_CONNECTIONPENDING
  -> Net.connect(fd, remote)
  -> 若本次就完成: endConnect(..., true)  -> ST_CONNECTED
  -> 若还没完成: endConnect(..., false) -> 保持 ST_CONNECTIONPENDING
```

`beginConnect()` 最关键的动作不是发系统调用，而是先把 channel 的状态改成 `ST_CONNECTIONPENDING`，并记录 remote 地址，见 `SocketChannelImpl.java:621`。这一步很重要，因为从这一刻开始，这个 channel 就已经不能再被当成“完全没开始连接”的对象了。后续如果你再次发起 `connect()`，JDK 会直接给出 `ConnectionPendingException`，而不是偷偷替你重连。

然后真正发起连接的是 `Net.connect(fd, ia, isa.getPort())`，见 `SocketChannelImpl.java:692` 和 `Net.java:469`。JDK 在这一层没有把 native 细节摊开讲透，它只保留了 Java 侧能验证的合同：底层尝试发起连接，如果本次已经完成，就返回正数；如果没完成，外层不会把 channel 回滚到“未连接”，而是保留 pending 状态。

这时最容易犯的错误，是把 `connect()` 的返回值想成“成败二值”。实际上它是三种含义中的两种：

```text
true  -> 连接这次已经完成
false -> 连接已经发起，但还没完成
异常   -> 连接失败，且 channel 会被关闭
```

这里故意没有把 `false` 归到失败里，因为源码合同明确区分了它们。`connect()` 如果抛出检查型异常，JDK 会在 catch 块里关闭 channel，再把异常包装抛出，见 `SocketChannelImpl.java:705`。换句话说：

- 返回 `false` 时，channel 还活着，而且状态是 pending。
- 抛异常时，连接这条路已经结束，channel 也一并收掉了。

这就是第一拍的全部职责：它负责把连接发出去，负责把对象从“未连接”推进到“连接进行中”，但它不负责替你等待最终结果。

### 一个最常见的失败方案：把 false 当成“再试一次 connect”

很多人第一次写非阻塞客户端，会不自觉写出下面这种思路：

```text
if (!channel.connect(remote)) {
    while (!channel.connect(remote)) {
        继续重试
    }
}
```

这个思路错在两个层面。

第一，它误解了 `false` 的意义。`false` 不是“刚才那次 connect 没发出去”，而是“已经发出去了，但还没有完成”。既然状态已经从 `ST_UNCONNECTED` 变成了 `ST_CONNECTIONPENDING`，你再调用一次 `connect()`，不是补发，而是逻辑冲突。

第二，它把非阻塞重新写成了忙等。即便底层允许你反复询问，也不应该让线程空转盯着一个还未完成的连接。真正合理的问题不是“我现在要不要立刻再连一次”，而是“什么时候值得回来确认这次连接有没有完成”。这正是第二拍 `finishConnect()` 和后续 Selector `OP_CONNECT` 要解决的事。

## 三、finishConnect：第二拍才决定你能不能把它当成已连接

既然第一拍只负责发起，那第二拍就负责收口。

`SocketChannel` 的抽象合同已经说明了这一点：非阻塞连接一旦建立完成，或者已经失败，对应 channel 会变得 connectable，这时调用 `finishConnect()` 来完成连接序列；如果还没完成，它可以继续返回 `false`，见 `SocketChannel.java:397`。

JDK 11 的 `SocketChannelImpl.finishConnect()` 也沿着这个合同实现，见 `SocketChannelImpl.java:757`。它的流程可以压缩成下面这样：

```text
finishConnect()
  -> 如果已经 connected，直接返回 true
  -> beginFinishConnect(blocking)
       -> 要求当前 state 必须是 ST_CONNECTIONPENDING
  -> checkConnect(fd, blocking?)
  -> connected = (n > 0)
  -> endFinishConnect(blocking, connected)
       -> 若 connected，则 state -> ST_CONNECTED
  -> 返回 connected
```

这里最要紧的不是 `checkConnect` 的 native 细节，而是它前后的状态合同。

`beginFinishConnect()` 先检查当前状态是否真的是 `ST_CONNECTIONPENDING`，见 `SocketChannelImpl.java:718`。如果根本没有一个进行中的连接，却来调用 `finishConnect()`，JDK 不会替你“顺便 connect 一下”，而是直接抛 `NoConnectionPendingException`。这再次说明：`finishConnect()` 不是另一个 `connect()`，它只是第二拍确认。

如果确认成功，`endFinishConnect()` 才会把本地地址补齐，并把状态推进成 `ST_CONNECTED`，见 `SocketChannelImpl.java:741`。也就是说，真正语义上的“这个 channel 已经连上，可以当成正常 socket 用了”，是在第二拍完成后才成立的。

这会直接影响后续读写。

在抽象语义上，读写 API 要求 channel 已连接；如果第一拍之后还处在 pending 状态，就不能把它当成一个已经稳定可用的连接。所以上层代码如果跳过 `finishConnect()`，本质是在绕过连接状态机，后面任何读写失败都不是偶然事故，而是对合同的违背。

### 为什么 finishConnect 也可能返回 false

再想一个朴素但错误的期待：既然我都专门调用 `finishConnect()` 了，它是不是就应该“一次收尾”，不然这个 API 好像没有意义。

可非阻塞的关键恰恰在于：第二拍也不承诺替你等待。

`SocketChannel.java:407` 讲得很清楚：如果 channel 已连接，`finishConnect()` 立即返回 `true`；如果当前仍是非阻塞模式，连接过程尚未完成时，它会返回 `false`；只有在阻塞模式下，它才会一直等到成功或失败。因此 `finishConnect()` 的意义不是“保证结束”，而是“给你一个合法的确认入口”。

于是这条路径才完整：

```text
connect() 返回 false
   -> 当前状态: ST_CONNECTIONPENDING
   -> 不能再重复 connect()
   -> 也不该忙等
   -> 等合适时机后调用 finishConnect()
   -> true  才真正 connected
   -> false 说明还要继续等
```

这也是 Selector 在客户端连接阶段存在的理由。它不是负责“建立 TCP 连接”本身，而是负责告诉你：现在值得回来执行第二拍了。Netty 后面包装 `Bootstrap.connect()` 时，本质上也是在代用户管理这个两拍状态机，而不是改变底层契约。

## 四、bind：为什么服务端必须先站住地址，客户端却可以省略

讲完两拍 connect，再补一块看似平常、其实很容易混淆的拼图：`bind()`。

很多人一说到 socket 编程，脑子里会默认浮现一个固定流程：先 `bind()`，再 `connect()` 或 `accept()`。这个印象在服务端是对的，在客户端却不完全对。

`SocketChannelImpl.bind()` 做的事情很直接：检查当前状态，确认没有正在连接、没有重复绑定，然后调用 `Net.bind(fd, isa.getAddress(), isa.getPort())` 把底层文件描述符绑定到本地地址，见 `SocketChannelImpl.java:572` 和 `Net.java:445`。

它的重要语义不在于“做了一个系统调用”，而在于绑定后这个 channel 的本地身份就固定下来了。你可以明确指定：这个客户端必须从哪块网卡、哪个本地端口发起连接。

可客户端为什么经常不需要显式 `bind()`？因为如果你不做这一步，操作系统会在真正 `connect()` 时帮你自动挑一个合适的本地地址和临时端口。也就是说，客户端不是“不能 bind”，而是“通常没必要”。只有在这些场景里，显式 bind 才变得重要：

- 机器有多块网卡，需要控制从哪个本地 IP 出去。
- 业务或防火墙规则要求固定源端口。
- 你要刻意复用某个本地绑定策略做测试或诊断。

服务端则完全不同。

`ServerSocketChannel.bind(local, backlog)` 不只是“记录一个本地地址”，它在 `Net.bind(...)` 之后还会继续调用 `Net.listen(fd, backlog < 1 ? 50 : backlog)`，把这个 fd 正式推进到监听状态，见 `ServerSocketChannelImpl.java:215`。没有这一步，内核根本不知道有哪个地址和端口在等待新连接，客户端也就无从连入。

所以客户端与服务端在 bind 上的分叉，可以压成一句话：

```text
客户端 bind：可选，决定“我从哪里发起”
服务端 bind：必须，决定“别人该连到哪里”并进入 listen
```

这个分叉很容易被忽略，因为两个 API 名字一样，底层也都走了 `Net.bind`。但它们承担的角色并不一样：客户端 bind 是局部策略，服务端 bind 是整个监听生命周期的前提。

## 五、accept：监听可以非阻塞，收进来的 child 却默认还是阻塞

现在来到整篇里最容易让人愣住的一步：`accept()`。

先说抽象合同。`ServerSocketChannel.accept()` 在非阻塞模式下，如果当前没有待接入连接，会立刻返回 `null`；如果有新连接，它返回一个新的 `SocketChannel`。可这个合同还额外补了一句很关键的话：无论监听 channel 当前是否阻塞，这个新返回的 socket channel 都会处于阻塞模式，见 `ServerSocketChannel.java:230` 和 `ServerSocketChannel.java:235`。

这句话如果只是文档里写着，很多人未必会当回事。可 JDK 11 的具体实现把这件事写得非常直接。

`ServerSocketChannelImpl.accept()` 先根据当前模式执行 accept：阻塞模式下可能等待，非阻塞模式下如果没有连接就返回 `null`。一旦真的拿到了新 fd，它马上执行下面这个动作：

```java
// newly accepted socket is initially in blocking mode
IOUtil.configureBlocking(newfd, true);
```

位置就在 `ServerSocketChannelImpl.java:295`。

这意味着什么？意味着服务端监听 socket 的阻塞模式，并不会自动继承到新接入的 child socket 上。监听 socket 只是负责“我自己在等新连接时怎么表现”；而 accept 返回的新连接，则被 JDK 主动设回了阻塞模式。

于是服务端连接建立实际上分成了两层：

```text
监听层：ServerSocketChannel
  -> 可以 blocking / non-blocking
  -> 决定 accept() 没有新连接时是等待还是返回 null

连接层：accept() 返回的 SocketChannel
  -> 默认 blocking
  -> 若想交给 Selector，必须显式 configureBlocking(false)
```

这就是很多 NIO 初学者最容易踩的坑。

他们做对了第一步：把 `ServerSocketChannel` 调成非阻塞。可他们漏了第二步：对子连接再调一次 `configureBlocking(false)`。于是程序表面上看是 NIO，实际上新连接一旦进入后续读写，就又会把线程拖回阻塞语义里。

### 为什么这里不沿用“父 channel 的非阻塞设定”

这个设计最容易引发的抱怨是：既然都已经是 NIO 了，为什么不让 child channel 自动继承父 channel 的模式？这样不是更统一吗？

直觉上确实更统一，但 JDK 这里优先保留的是兼容语义。

`ServerSocketChannel.accept()` 返回的是一个 `SocketChannel`，而 `SocketChannel` 又有 `socket()` 这个桥，能暴露出兼容旧 `java.net.Socket` 的外观，见 `SocketChannel.java:299`。旧 `Socket` 世界的默认直觉就是阻塞 IO。如果 accept 出来的 child 默认就跟着变成非阻塞，那么很多把 `SocketChannel` 当作传统 socket 使用的代码会立刻踩进行为差异里。

所以这里的取舍不是“哪种模式更先进”，而是“默认值更靠近哪一代代码的预期”。JDK 选择了向旧 socket 预期靠拢，于是把“进入纯事件驱动模型所需的第二次 `configureBlocking(false)`”留给上层框架或业务代码自己做。

这就是为什么真正的网络框架必须补上这一层初始化。对 Netty 来说，`ServerBootstrap` 不只是帮你监听端口，更重要的是它会在新连接进来后，替你把 child channel 配置成事件循环可管理的形态，包括阻塞模式、选项和后续 handler 链。框架存在的价值，很多时候正是把这些 JDK 原生 API 的折中点收平。

### accept 的失败方案不是抛异常，而是悄悄把你带回阻塞世界

connect 那边最危险的失败方案，是把 `false` 当成失败。accept 这边最危险的失败方案，则更隐蔽：代码可以运行，但模型已经错了。

比如下面这种心智模型就很常见：

```text
server.configureBlocking(false)
while (true) {
    SocketChannel sc = server.accept();
    if (sc != null) {
        selector.register(sc, OP_READ)
    }
}
```

问题不是 `accept()` 这一行，而是 `sc` 还没被显式改成非阻塞。对于 Selector 来说，只有非阻塞 channel 才满足注册前提；即便某些后续代码暂时没立刻炸掉，你也已经把程序带回了“child socket 可能阻塞线程”的风险里。

所以 `accept()` 这里真正需要记住的不是一句孤立知识点“它默认阻塞”，而是一条完整动作链：

```text
ServerSocketChannel.accept()
  -> 无连接且非阻塞: 返回 null
  -> 有新连接: 返回新的 SocketChannel
  -> 这个新 SocketChannel 默认 blocking
  -> 若要纳入 Selector / EventLoop
       必须再 configureBlocking(false)
```

## 六、把 connect、bind、accept 收成一张连接建立总图

走到这里，可以把整篇的主线收拢成一张更完整的图。

### 客户端

```text
可选：bind(local)
  -> 决定从哪个本地地址/端口发起
  -> 不调用则 OS 自动分配

connect(remote)
  -> blocking: 等到成功/失败
  -> non-blocking:
       true  -> 已连接
       false -> ST_CONNECTIONPENDING
                 以后必须 finishConnect()

finishConnect()
  -> true  -> ST_CONNECTED
  -> false -> 继续等待后续时机
```

### 服务端

```text
bind(local, backlog)
  -> Net.bind
  -> Net.listen
  -> 进入监听状态

accept()
  -> blocking: 等新连接
  -> non-blocking: 没连接就返回 null
  -> 有连接时返回新的 SocketChannel
       但这个 child 默认 blocking
       若要走 Selector / EventLoop
       还要 configureBlocking(false)
```

这样再回头看开篇的两个反直觉点，它们其实都在服务同一件事：JDK 把“线程是否等待”与“连接对象处于哪个生命周期状态”拆得很开。

- 客户端两拍 connect，是为了让等待三次握手这件事不要霸占线程。
- 服务端 child 默认阻塞，是为了不把新的连接对象默认推进到更激进的 NIO 语义里。

看上去它们不统一，实则都在暴露一个事实：原生 NIO 只是给你基本构件，不负责替你抹平所有使用边界。

## 收网：Netty 为什么一定要接管这几个拐点

现在可以理解，为什么上层框架不可能只是“把 JDK Channel 包一层”就完事。

如果没有框架托管，客户端要自己维护一套连接状态机：

- 什么时候 `connect()` 可以接受 `false`
- 什么时候应该回来 `finishConnect()`
- 什么时候这条连接才算真正可读可写

服务端也要自己记住另一套初始化义务：

- 监听 socket 是否非阻塞
- `accept()` 返回 `null` 时如何等待下一次机会
- 新 child channel 拿到后要不要立刻 `configureBlocking(false)`
- 后续要给它挂哪些选项和处理器

Netty 的 `Bootstrap`、`ServerBootstrap`、EventLoop 和 child pipeline，后面本质上都是在替你收这些零散步骤。它们不是发明了新的 socket 规律，而是把 JDK 原生 API 暴露出来的连接拐点接成了一个更稳定的运行时模型。

所以这一篇最该带走的结论，不是几个孤立 API 名字，而是下面这两句：

```text
非阻塞 connect 不是“一次完成”，而是“发起 + 确认”两拍。
非阻塞 accept 也不是“新连接自动进入非阻塞”，child 仍需二次配置。
```

下一篇进入阻塞与非阻塞的系统对照。到那时，这一篇埋下的两个点会一起收束：为什么同一个 `SocketChannel` 上，连接、接受、读写、等待时机这些动作都在围绕“线程该不该在这里停住”重新分工。