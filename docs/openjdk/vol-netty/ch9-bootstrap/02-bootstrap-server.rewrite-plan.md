# Ch9-02 ServerBootstrap rewrite plan

## 一句话困惑

第一篇已经讲清父 Channel 怎样被创建、初始化并注册，但服务端真正麻烦的不是监听 socket 自己，而是 accept 之后那一串子 Channel 究竟由谁接手、何时装 pipeline、什么时候切到 worker EventLoop，以及为什么 `ChannelInitializer` 能“用完即走”而不把 Pipeline 弄乱。

## 一句话顿悟

`ServerBootstrap` 的关键不是比 `Bootstrap` 多几个 child 配置项，而是把监听 Channel 和子 Channel 切成两条不同生命周期：监听 Channel 在 `init(channel)` 时先挂一个一次性的 `ChannelInitializer`，由它把 `ServerBootstrapAcceptor` 延迟塞进父 Pipeline；真正 accept 到 child 之后，再由 acceptor 把 child handler/options/attrs 和 worker 注册串起来。

## 本篇范围

- 主讲 `ServerBootstrap.init(...)`、`ChannelInitializer`、`ServerBootstrapAcceptor.channelRead(...)`。
- 讲父/子 EventLoopGroup 分离和 `childGroup == null` 回退。
- 讲 `ChannelInitializer` 的防重入、自移除和事件顺序。
- 讲 initializer extensions 在 server listener / child channel 两个时点的介入。
- 不再重讲 `AbstractBootstrap` 的三步状态机细节；只把它当上一篇前置骨架。

## 依赖声明

```text
本篇
├── HARD 前置：ch9-bootstrap/01-abstractbootstrap.md
├── HARD 前置：ch7-pipeline/04-init-and-lifecycle.md
├── HARD 前置：ch5-eventloop/01-architecture-and-runloop.md
├── HARD 前置：ch6-promise/01-state-model-and-listeners.md
├── SOFT 前置：ch4-bytebuf/01-dual-index-and-refcnt.md
├── NAV 后续：ch10-codec/01-... 
└── COMPARE：Bootstrap.init(...) 与 ServerBootstrap.init(...)
```

## 结构设计

### 1. 开场：为什么服务端比客户端多出来的不是一个 `accept()` 调用
- 从“父监听 / 子连接”两条生命周期切入。
- 点明第一篇只讲了父 Channel 起飞，这篇讲 accept 后谁接棒。
- 预计 700-900 字。

### 2. 失败方案：如果把服务端也当成“一个 Channel 配一个 handler”会错在哪里
- 失败方案 A：把 boss 和 worker 混成一条 EventLoop 责任线。
- 失败方案 B：把 child handler 直接挂在 listener channel 上，指望它自动覆盖子连接。
- 失败方案 C：让 `ChannelInitializer` 永久留在 pipeline 中。
- 预计 1300-1700 字。

### 3. `ServerBootstrap.init(...)`：为什么父 Channel 先挂的是 `ChannelInitializer`
- 讲 listener channel 自己的 options/attrs 先设置。
- 讲 `p.addLast(new ChannelInitializer<Channel>() { ... })` 的角色。
- 解释为什么 `config.handler()` 属于父 listener，而 `childHandler` 不在这里直接加到 child 上。
- 预计 1500-1900 字。

### 4. `ChannelInitializer`：自移除、防重入与事件不丢失
- `@Sharable` + `initMap` 的语义。
- `handlerAdded()` 已注册路径 vs `channelRegistered()` 延后路径。
- `initChannel(ctx)` 中 `initMap.add(ctx)` 防重入、`finally remove(this)` 自移除、`fireChannelRegistered()` 补事件。
- 结合测试解释“嵌套 initializer 顺序正确”和“reentrance 只初始化一次”。
- 预计 2000-2500 字。

### 5. `ServerBootstrapAcceptor`：accept 之后的 child Channel 接管链
- `channelRead(ctx, msg)` 把 `msg` 视为 child channel。
- 顺序：`child.pipeline().addLast(childHandler)` -> `setChannelOptions` -> `setAttributes` -> 扩展回调 -> `childGroup.register(child)`。
- 解释这里为什么要先装 child pipeline 再 register。
- 预计 1800-2200 字。

### 6. 父/子 EventLoop 分离：worker 什么时候回退到 boss
- `group(parent, child)` 与 `group(group)` 的语义。
- `validate()` 中 `childGroup == null -> config.group()` 回退。
- 解释这是角色复用，不是启动骨架变化。
- 预计 900-1200 字。

### 7. 失败与恢复：accept 子连接失败时为什么先 `forceClose`，异常时为什么临时关 `autoRead`
- `setChannelOptions` / `register` 失败时 `forceClose(child, cause)`。
- `exceptionCaught()` 中 `autoRead=false`，一秒后恢复，边界是 listener channel 自己的接收节流，不是 child channel 重试机制。
- 预计 1000-1300 字。

### 8. extensions：为什么 listener 和 child 有两个介入时点
- `postInitializeServerListenerChannel(serverChannel)`。
- `postInitializeServerChildChannel(child)`。
- `ChannelInitializerExtensions` 的 none/serviceload/log 三态与按 priority 排序。
- 预计 800-1100 字。

### 9. 收网与桥接
- 回收：ServerBootstrap 不只是“Bootstrap + childHandler”，而是把服务端拆成父监听链和子连接链两次初始化。
- 桥到 Ch10：到这里 pipeline 终于在父/子 channel 上都装配完了，下一步这些 handler 才开始面对真正的 TCP 字节流与拆包问题。
- 预计 500-700 字。

## 证据清单

- `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:132`
- `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:145`
- `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:176`
- `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:221`
- `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:257`
- `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:263`
- `transport/src/main/java/io/netty/channel/ChannelInitializer.java:53`
- `transport/src/main/java/io/netty/channel/ChannelInitializer.java:72`
- `transport/src/main/java/io/netty/channel/ChannelInitializer.java:104`
- `transport/src/main/java/io/netty/channel/ChannelInitializer.java:124`
- `transport/src/test/java/io/netty/channel/ChannelInitializerTest.java:118`
- `transport/src/test/java/io/netty/channel/ChannelInitializerTest.java:160`
- `transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtension.java:40`
- `transport/src/main/java/io/netty/bootstrap/ChannelInitializerExtensions.java:45`
- `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:267`

## 误解清单

1. `childHandler` 会像 client `handler` 一样，在 `ServerBootstrap.init(...)` 时直接挂到所有子 Channel 上。
2. `ChannelInitializer` 只是一个方便写法，留在 pipeline 里也没关系。
3. `initMap` 防重入是为了多线程共享同一个 initializer，不涉及单 Channel 内部重入事件。
4. `childGroup.register(child)` 之前先加 handler/options/attrs 只是风格问题，不影响语义。
5. `autoRead=false` 的一秒恢复是在给 child channel 重连。

## 边界清单

- 本篇只讲服务端 listener/child 初始化链，不展开底层 `accept` 系统调用本身；那属于传输实现细节。
- 本篇不重讲 `PendingRegistrationPromise`，只在需要时引用“register 完成前后顺序”结论。
- 本篇不把 `ChannelInitializerExtension` 写成常用业务 API；它默认关闭，且是进程级扩展点。 