# Ch9-02 `02-bootstrap-server.md` review notes

## 第一轮：事实核对

### 已核对的核心结论

1. `ServerBootstrap.init(...)` 当前先设置 listener channel 自己的 options/attrs，再向其 pipeline 添加一个匿名 `ChannelInitializer`，证据：`transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:132`。
2. 该匿名 initializer 在 `initChannel(...)` 中先添加 `config.handler()` 到 listener pipeline，然后通过 `ch.eventLoop().execute(...)` 延迟加入 `ServerBootstrapAcceptor`，证据：`transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:145`。
3. `ServerBootstrap.validate()` 当前会检查 `childHandler != null`，并在 `childGroup == null` 时回退到 `config.group()`，证据：`transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:176`。
4. `ServerBootstrapAcceptor.channelRead(...)` 当前顺序是：`child.pipeline().addLast(childHandler)` -> `setChannelOptions(child, childOptions, logger)` -> `setAttributes(child, childAttrs)` -> child extensions -> `childGroup.register(child)`，证据：`transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:221`。
5. `forceClose(child, t)` 当前策略是 `child.unsafe().closeForcibly()` 并打印 warning，证据：`transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:257`。
6. `ServerBootstrapAcceptor.exceptionCaught(...)` 当前在 listener channel `autoRead == true` 时，会临时关闭 `autoRead` 并在 1 秒后恢复，然后继续 `fireExceptionCaught(cause)`，证据：`transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:263`。
7. `ChannelInitializer` 当前是 `@Sharable`，并以 `ConcurrentHashMap.newKeySet()` 作为 `initMap` 记录初始化中的 context，证据：`transport/src/main/java/io/netty/channel/ChannelInitializer.java:53`。
8. `ChannelInitializer` 既可能在 `handlerAdded(...)` 路径初始化，也可能在 `channelRegistered(...)` 路径初始化；初始化后会自移除，并在需要时补发 `fireChannelRegistered()`，证据：`transport/src/main/java/io/netty/channel/ChannelInitializer.java:72`、`:104`、`:124`。
9. `ChannelInitializerTest.testChannelInitializerInInitializerCorrectOrdering()` 覆盖了嵌套 initializer 的 handler 顺序正确性，证据：`transport/src/test/java/io/netty/channel/ChannelInitializerTest.java:118`。
10. `ChannelInitializerTest.testChannelInitializerReentrance()` 覆盖了 `initChannel()` 内部触发 `fireChannelRegistered()` 时只初始化一次的防重入行为，证据：`transport/src/test/java/io/netty/channel/ChannelInitializerTest.java:160`。
11. `ChannelInitializerTest` 还验证了 `channelRegistered` 事件不会因为 initializer 而丢失，证据：`transport/src/test/java/io/netty/channel/ChannelInitializerTest.java:196`。
12. `ChannelInitializerExtension` 当前提供三个 server/client 初始化后回调，其中 server 端有 listener 与 child 两个分开的回调时点，证据：`transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtension.java:40`。
13. `ChannelInitializerExtensions` 当前根据 `io.netty.bootstrap.extensions` 走 none/serviceload/log 三态，并对加载出的扩展按 `priority()` 排序，证据：`transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtensions.java:45`、`:102`。
14. `Bootstrap.init(...)` 当前只初始化 client channel 自己的 handler/options/attrs 和 client 扩展，证据：`transport/src/main/java/io/netty/bootstrap/Bootstrap.java:267`。

### 已纠正的大纲偏差

- 大纲把第二篇标题定在 `ChannelInitializer + BootstrapConfig + Clone`，但当前写作按完整性问题和实际源码主线重排，第二篇聚焦 `ServerBootstrapAcceptor + ChannelInitializer + 父子初始化分层`，没有把已在第一篇收敛的 `clone/config/factory` 再重复一遍。
- 大纲把 `ServerBootstrapAcceptor` 的“六步”写得偏模板化，正文改为当前真实顺序，不额外虚构 `fireChannelActive` 一类 acceptor 内部并未直接调用的步骤。

## 第二轮：因果审

### 因果链是否成立

1. “父/子 Channel 需要两次初始化” 由 `ServerBootstrap.init(...)` 和 `ServerBootstrapAcceptor.channelRead(...)` 的分层证据支撑，不是叙事性夸大。
2. “`childHandler` 必须在 `childGroup.register(child)` 前落入 pipeline” 是基于当前顺序和前文已建立的 `register` 后生命周期事件可能立即传播这一事实作出的机制解释，成立。
3. “`ChannelInitializer` 的防重入不只是多线程共享问题，也包括单 Channel 内部事件重入” 由 `testChannelInitializerReentrance()` 支撑，成立。
4. “`autoRead=false` 一秒恢复是 listener 接收节流，而不是 child 重连策略” 由代码位置与对 `ctx.channel().config()` 的操作对象支撑，成立。

### 需保持克制的地方

- `ServerBootstrap.init(...)` 中为何要先 `handler` 再异步加 `acceptor`，正文解释成 listener 初始化顺序要求，没有把它写成唯一作者意图。
- 对 extensions 的描述限定为“进程级初始化扩展面”，没有拔高成广义插件系统。

## 第三轮：结构审

### 结构是否按理解路径推进

当前结构：

1. 从“第一篇只讲父 Channel 起飞”切入，引出服务端第二条初始化链。
2. 先用 3 个失败方案说明为什么不能把服务端拍扁成单条 Channel 生命周期。
3. 再讲 `ServerBootstrap.init(...)` 如何在 listener channel 上布置一次性 initializer。
4. 之后单独展开 `ChannelInitializer` 的时序、防重入和自移除。
5. 再进入 `ServerBootstrapAcceptor` 的 child 接管链。
6. 然后补父/子 EventLoopGroup 分离。
7. 再看失败与恢复路径。
8. 最后收 extensions 边界与篇末桥接。

这个顺序符合“问题 -> 失败 -> 顿悟 -> 机制 -> 回收”，没有按源码文件硬翻译。

### 结构风险检查

- 没有把 `ChannelInitializer` 当成零散 API 介绍，而是放在 listener -> acceptor 之间作为机制枢纽。
- 没有重复第一篇 `PendingRegistrationPromise` 主线，只在需要的地方复用“register 前后顺序”结论。
- 没有提前切入 Ch10 codec 细节，只用篇末导航过去。

## 第四轮：读者审

### 删掉代码块后是否还能成立

删掉代码块后，正文仍可复述：

1. 为什么服务端需要父 listener 与子连接两次初始化。
2. 为什么 `ChannelInitializer` 必须防重入、自移除并补注册事件。
3. acceptor 接管 child channel 的真实顺序是什么。
4. 为什么 worker 组只是父/子分工的进一步部署选择。
5. listener 异常时一秒关闭 `autoRead` 的真正含义。

代码块和 `file:line` 仅作证据，不承担主骨架。

### 可能的阅读负担点

- `config.handler()` 与 `childHandler` 很容易混淆；正文已在 `ServerBootstrap.init(...)` 小节专门拆分。
- `ChannelInitializer` 的两个入口和重入测试容易显得细碎；正文用“为什么会重复触发初始化”先把问题建起来，再落测试证据，结构上可读。

## 第五轮：边界审

### 已明确边界

1. 本篇不展开底层 `accept` 系统调用细节。
2. 本篇不重讲 `AbstractBootstrap` 三步状态机，只把它作为 listener 启动骨架前提。
3. 本篇不把 extensions 写成常规业务 API；明确其默认关闭和进程级范围。
4. 本篇不把 `childGroup == null` 回退写成推荐部署，而只说它是协议允许的回退路径。

### 失败路径与风险覆盖

- 已覆盖：child options 设置失败或 child 注册失败时的 `forceClose` 路径。
- 已覆盖：accept 异常连续发生时 listener 暂时关闭 `autoRead` 的恢复逻辑。
- 已覆盖：initializer 初始化异常时默认关闭 channel。
- 已覆盖：嵌套 initializer / reentrance 场景下的事件顺序与只初始化一次。

### Bug / issue 候选检查

本轮未形成新的可证实缺陷候选：

- `ChannelInitializer` 的 `initMap`、`removeState` 与测试表现一致，没有发现显著契约漏洞。
- `ServerBootstrapAcceptor` 的 child 初始化顺序与当前源码一致，未观察到本文范围内可定性的资源/竞态 bug。
- `autoRead` 恢复逻辑是有意识的节流策略，不能仅凭直觉定性为风险缺口。

结论：没有需要单列 issue 候选的真实缺陷。

## 第六轮：依赖审

### 前置依赖检查

- Ch9-01：本篇硬依赖“父 Channel 启动骨架”与“register 前先 init”的结论。
- Ch7 生命周期篇：本篇硬依赖 Pipeline 节点、handlerAdded/channelRegistered 的理解。
- Ch5 EventLoop：本篇硬依赖 listener 与 child 对不同 EventLoopGroup 的归属理解。
- Ch6 Promise/Future：本篇软依赖 register 的异步完成语义。

### 后续桥接检查

- 篇末只把视角桥到 Ch10 Codec：child pipeline 已装好，下一步开始面对 TCP 字节流。
- 没有把 Codec 的后置结论提前当作本篇前提。

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

预期：正文不命中偷懒词。

### 行号引用复核目标

重点复核：

- `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:145`
- `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:221`
- `transport/src/main/java/io/netty/channel/ChannelInitializer.java:124`
- `transport/src/test/java/io/netty/channel/ChannelInitializerTest.java:160`
- `transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtensions.java:45`

### 删码测试目标

删除全部 fenced code block 后，正文仍应保留：

- 父 listener / 子连接两次初始化主线
- `ChannelInitializer` 的自移除、防重入与事件补发
- acceptor 的 child 接管顺序
- `autoRead` 异常节流边界
- extensions 的双时点边界
