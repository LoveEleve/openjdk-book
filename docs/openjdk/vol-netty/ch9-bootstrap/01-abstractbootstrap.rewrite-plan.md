# Ch9-01 AbstractBootstrap rewrite plan

## 一句话困惑

`bind()` 或 `connect()` 看起来只是 Bootstrap Fluent API 的最后一下调用，为什么它能在一个方法里把 Channel、EventLoop、Pipeline、Promise 乃至前一章的内存池全部装配成真正可运行的网络端点？

## 一句话顿悟

`AbstractBootstrap` 真正做的不是“直接 bind/connect”，而是把启动拆成三段有先后约束的状态机：先校验配置，再创建并注册 Channel，最后把真正的 I/O 操作异步投递到该 Channel 所属的 EventLoop；`PendingRegistrationPromise` 则是把“注册可能尚未完成”这条缝补平的桥。

## 本篇范围

- 主讲 `AbstractBootstrap` 的 CRTP Fluent API、`validate -> initAndRegister -> doBind0` 三步状态机。
- 补 client `connect()` 与 server `bind()` 的对称性，只讲到 `Bootstrap.init(...)` / `ServerBootstrap.init(...)` 的入口差异。
- 讲 `FailedChannel`、`PendingRegistrationPromise`、`ReflectiveChannelFactory`、`clone/config` 快照边界。
- 不深入 `ServerBootstrapAcceptor` 子 Channel 生命周期；那部分留给 Ch9-02。

## 依赖声明

```text
本篇
├── HARD 前置：ch5-eventloop/01-architecture-and-runloop.md
├── HARD 前置：ch6-promise/01-state-model-and-listeners.md
├── HARD 前置：ch7-pipeline/04-init-and-lifecycle.md
├── SOFT 前置：ch8-memorypool/01-allocator-and-arena.md
├── SOFT 前置：ch8-memorypool/04-pooledbuf-lifecycle.md
├── NAV 后续：ch9-bootstrap/02-bootstrap-server.md
└── NAV 后续：ch10-codec/01-... 
```

## 结构设计

### 1. 开场：前八章的基础设施为什么还不算“系统已经启动”
- 从 `new ServerBootstrap().group(...).channel(...).childHandler(...).bind(8080)` 切入。
- 点明前几章讲的都是零件，这一篇第一次讲“零件何时被编织成系统”。
- 预计 700-900 字。

### 2. 失败方案：为什么不能在调用线程里直接 `new Channel -> init -> bind/connect`
- 失败方案 A：配置没校验就直接启动。
- 失败方案 B：先 bind 再 register。
- 失败方案 C：在 main 线程直接调 `channel.bind()` / `channel.connect()`。
- 引出 EventLoop 线程归属与 Promise 协调的必要性。
- 预计 1300-1700 字。

### 3. CRTP Fluent API：为什么 `B extends AbstractBootstrap<B, C>` 值得存在
- 讲 self-typed fluent API，避免链式配置时丢失子类返回类型。
- 对照“如果只返回 `AbstractBootstrap` / Object 会怎样”。
- 预计 800-1100 字。

### 4. 三步状态机主线：`validate -> initAndRegister -> doBind0`
- `validate()`：不是样板检查，而是把不完整配置挡在启动前。
- `initAndRegister()`：`channelFactory.newChannel()`、`init(channel)`、`group.register(channel)` 的顺序和失败收尾。
- `doBind0()`：为什么即使 register 已成功，也仍然要 `eventLoop().execute(...)` 异步提交。
- 预计 2200-2800 字。

### 5. `PendingRegistrationPromise`：它到底补的是哪条缝
- 解释 regFuture 可能 done / not done 两条路。
- 说明 not done 时不能直接用普通 promise，因为 executor 尚未稳定绑定到 channel 的 eventLoop。
- 解释 `registered()` 后 executor 切换的意义与失败时回退到 `GlobalEventExecutor`。
- 预计 1400-1800 字。

### 6. `FailedChannel` 与失败路径：为什么不能直接返回 null
- `newChannel()` / `init()` 抛错时的两条路径。
- `channel != null` 与 `channel == null` 的分流。
- 为什么即便失败也要返回一个失败的 `ChannelFuture`，而不是 null 或直接抛给上层完事。
- 预计 900-1200 字。

### 7. `bind()` 与 `connect()` 的对称性：共用骨架，不共用最后一步
- `bind()` 走 `doBind` + `doBind0`。
- `connect()` 走 `doResolveAndConnect` + `doConnect`，中间多一层 resolver。
- `Bootstrap.init(...)` 与 `ServerBootstrap.init(...)` 只做各自角色的 pipeline 初装，不展开 acceptor 深处。
- 预计 1300-1700 字。

### 8. `clone()` / `config()` / `ReflectiveChannelFactory` 的边界
- `clone` 共享 group/handler/channelFactory 引用，但复制 options/attrs map 内容。
- `config()` 暴露的是只读快照式访问，而不是可随意反改内部状态的可变门把手。
- `ReflectiveChannelFactory` 当前在构造时缓存无参 constructor，不是每次 `newChannel()` 再查一次。
- 预计 1000-1300 字。

### 9. 收网与桥接
- 回收：Bootstrap 不是“创建 Channel 的工具类”，而是“把启动流程压缩成三段状态机”的装配器。
- 桥到 Ch9-02：第一篇只讲父 Channel 怎么被创建和注册；第二篇再看 `ServerBootstrapAcceptor` 如何把 accept 出来的子 Channel 接上 worker 与 child pipeline。
- 预计 500-700 字。

## 证据清单

- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:55`
- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:223`
- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:291`
- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:324`
- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:371`
- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:511`
- `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:163`
- `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:194`
- `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:267`
- `transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:132`
- `transport/src/main/java/io/netty/channel/ReflectiveChannelFactory.java:27`
- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrapConfig.java:32`
- `transport/src/main/java/io/netty/bootstrap/BootstrapConfig.java:26`
- `transport/src/main/java/io/netty/bootstrap/ServerBootstrapConfig.java:30`

## 误解清单

1. `bind()` / `connect()` 只是对底层 `channel.bind` / `channel.connect` 的一层薄封装。
2. 只要 `register()` 返回成功 future，后续就可以在调用线程里直接继续 bind/connect。
3. `PendingRegistrationPromise` 只是“为了异步好看”，不是解决真实竞态。
4. `clone()` 会把 EventLoopGroup、Handler 都深拷贝一份。
5. `ReflectiveChannelFactory` 每次创建 Channel 都重新反射查 constructor。

## 边界清单

- 本篇不深入 `ServerBootstrapAcceptor.channelRead()` 的子 Channel 六步初始化；放在下一篇。
- 本篇不展开 DNS resolver 的实现，只说明 `connect()` 比 `bind()` 多一层解析关口。
- 本篇不重讲 EventLoop、Promise、Pipeline 的基础机制，只复用前文已建立的模型。
- 本篇不把 `BootstrapConfig` 说成真正不可变对象；它提供的是对当前配置的只读视图，而底层 bootstrap 仍可能继续被调用方配置。 