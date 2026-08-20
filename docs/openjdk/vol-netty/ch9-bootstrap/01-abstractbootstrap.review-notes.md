# Ch9-01 `01-abstractbootstrap.md` review notes

## 第一轮：事实核对

### 已核对的核心结论

1. `AbstractBootstrap` 当前采用 `B extends AbstractBootstrap<B, C>` 自类型设计，并通过 `self()` 返回 `(B) this` 支撑链式 API，证据：`transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:55`、`:105`。
2. `validate()` 当前检查 `group` 和 `channelFactory`；`Bootstrap.validate()` 额外检查 `handler`；`ServerBootstrap.validate()` 额外检查 `childHandler`，且 `childGroup == null` 时回退到 `config.group()`，证据：`transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:223`、`transport/src/main/java/io/netty/bootstrap/Bootstrap.java:287`、`transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:176`。
3. `doBind()` 当前主线确实是 `initAndRegister()`，然后按 `regFuture` done/not done 两路进入普通 promise 或 `PendingRegistrationPromise`，证据：`transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:291`。
4. `initAndRegister()` 当前顺序是 `channelFactory.newChannel()` -> `init(channel)` -> `config().group().register(channel)`，证据：`transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:324`。
5. `doBind0()` 当前通过 `channel.eventLoop().execute(...)` 异步执行真正的 `channel.bind(...)`，证据：`transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:371`。
6. `PendingRegistrationPromise` 当前确实通过 `registered` 标志切换 `executor()`：成功注册后回到 `super.executor()`，失败或未注册前回退 `GlobalEventExecutor.INSTANCE`，证据：`transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:511`。
7. `initAndRegister()` 异常分支在 `channel != null` 时会 `closeForcibly()` 并返回绑定在该 channel 上的失败 promise；在 `channel == null` 时返回绑定在 `FailedChannel` 上的失败 promise，证据：`transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:329`。
8. `Bootstrap.doResolveAndConnect()` 与 `doResolveAndConnect0()` 当前复用 `initAndRegister()` 骨架，只是在最终 `doConnect(...)` 前多了一层 resolver 逻辑，证据：`transport/src/main/java/io/netty/bootstrap/Bootstrap.java:163`、`:194`。
9. `Bootstrap.init(...)` 当前直接给 client channel 加 handler/options/attrs；`ServerBootstrap.init(...)` 当前则通过 `ChannelInitializer` 先装 server 自身 handler，再异步补 `ServerBootstrapAcceptor`，证据：`transport/src/main/java/io/netty/bootstrap/Bootstrap.java:267`、`transport/src/main/java/io/netty/bootstrap/ServerBootstrap.java:132`。
10. `ReflectiveChannelFactory` 当前在构造时缓存无参 `Constructor`，`newChannel()` 只调用 `constructor.newInstance()`，证据：`transport/src/main/java/io/netty/channel/ReflectiveChannelFactory.java:27`。
11. `AbstractBootstrapConfig` / `BootstrapConfig` / `ServerBootstrapConfig` 当前提供的是只读 getter 和复制后的配置视图，不是冻结 Bootstrap 本体，证据：`transport/src/main/java/io/netty/bootstrap/AbstractBootstrapConfig.java:32`、`transport/src/main/java/io/netty/bootstrap/BootstrapConfig.java:26`、`transport/src/main/java/io/netty/bootstrap/ServerBootstrapConfig.java:30`。

### 已纠正的大纲偏差

- 大纲把 `ReflectiveChannelFactory` 写成“`getDeclaredConstructor()` 只在 `newChannel()` 首次调用时执行”，当前源码不是这样；构造器查找发生在工厂构造时，且用的是 `getConstructor()`，不是首次 `newChannel()` 再查。
- 大纲把 `ServerBootstrapAcceptor` 的六步子 Channel 初始化写得过细，当前第一篇只把它作为 `ServerBootstrap.init(...)` 的后半部分边界预告，没有提前展开第二篇内容。

## 第二轮：因果审

### 因果链是否成立

1. “为什么不能在调用线程里直接 bind/connect” 的因果链成立：`doBind0()` / `doConnect()` 都明确把真正 I/O 交给 `channel.eventLoop().execute(...)`，所以正文把原因落在 EventLoop 线程归属与 `channelRegistered` 顺序上是有源码支撑的。
2. “`PendingRegistrationPromise` 补的是 promise 执行器归属的缝” 也成立，因为它唯一新增的关键行为正是覆写 `executor()`，而不是只做一个延迟 listener 容器。
3. “`validate()` 是启动状态机第一道门” 属于解释性表述，但由它在 `bind()/connect()/register()` 入口被统一调用支撑，不是凭空拔高。
4. “`init(channel)` 必须先于 register 才能让注册事件到来前 pipeline 已有初始骨架” 是设计推断，但与 `doBind0()` 注释中提到给 `channelRegistered()` 机会补 pipeline 的事实一致，没有与源码冲突。

### 需保持克制的地方

- 正文没有把 `ServerBootstrap.init(...)` 里异步加 `ServerBootstrapAcceptor` 的具体原因过度下结论，因为当前源码没有在该点写出完整设计注释；只描述了它确实延迟到 `eventLoop().execute(...)` 中完成。
- 正文把 `config()` 说成“只读观察窗”，没有写成严格 immutable object，符合当前实现边界。

## 第三轮：结构审

### 结构是否按理解路径推进

当前结构：

1. 从“前八章只是零件”引出 Bootstrap 作为第一次系统装配。
2. 先推演 3 个失败方案，建立顺序与线程归属问题。
3. 再讲 CRTP Fluent API 的必要性。
4. 进入 `validate -> initAndRegister -> doBind0` 主线。
5. 单独拆 `PendingRegistrationPromise`。
6. 再补失败路径。
7. 再对照 `bind()` / `connect()` 共骨架与分叉点。
8. 最后收 `clone/config/factory` 边界。
9. 篇末桥接 `ServerBootstrapAcceptor` 第二篇。

这个顺序符合“问题 -> 失败 -> 顿悟 -> 机制 -> 回收”，没有按源码文件顺序逐段翻译。

### 结构风险检查

- 没有把 `ServerBootstrapAcceptor.channelRead()` 过早展开，避免第一篇失焦。
- 没有先讲 `clone/config` 再讲状态机，避免枝节抢主线。
- CRTP 放在状态机前，是为了先解释为什么 client/server 共用一套父类骨架仍能保留子类语言；位置合理。

## 第四轮：读者审

### 删掉代码块后是否仍成立

通读正文，不看代码块仍可复述：

1. Bootstrap 启动为何不是直接调底层 I/O。
2. 三步状态机分别在做什么。
3. `PendingRegistrationPromise` 解决的具体问题是什么。
4. `bind()` / `connect()` 共用什么骨架、在哪分叉。
5. `clone/config` 的边界是什么。

代码块只作证据，不承担主骨架。

### 容易卡住的点

- `PendingRegistrationPromise` 容易被读者误听成“只是延迟 bind”；正文已反复拉回“关键在 executor 归属”。
- `config()` 与 immutable config 容易混淆；正文已单独列边界，避免泛化。

## 第五轮：边界审

### 已明确边界

1. 本篇不展开 `ServerBootstrapAcceptor` 的子 Channel 生命周期，留待 Ch9-02。
2. 本篇不深入 resolver 实现，只说明 `connect()` 比 `bind()` 多一道解析关口。
3. 本篇不重讲 EventLoop / Promise / Pipeline 的基础机制，只消费前文结论。
4. 本篇不把 `config()` 说成冻结对象，只说是当前配置的只读观察视图。

### 失败路径覆盖

- 已覆盖：配置缺失导致 validate 失败。
- 已覆盖：`newChannel()` / `init()` 失败时的 `FailedChannel` / `closeForcibly()` 路径。
- 已覆盖：注册尚未完成时 promise 执行器未稳定的问题。
- 已覆盖：调用线程直接做 I/O 会破坏线程归属与注册后初始化顺序。

### Bug / issue 候选检查

本轮未发现新的可证实源码缺陷候选：

- `PendingRegistrationPromise` 逻辑与注释一致，没有观察到契约-实现反转。
- `ReflectiveChannelFactory` 的构造器缓存逻辑清晰，没有发现和正文主线相关的明显缺口。
- `ServerBootstrap.init(...)` 的 acceptor 延迟注入虽值得解释，但当前证据不足以定性为特殊缺陷或风险漏洞。

结论：本篇没有形成需要单列 issue 候选的问题。

## 第六轮：依赖审

### 前置依赖检查

- Ch5 EventLoop：本篇硬依赖“真正 I/O 动作必须投递给所属 EventLoop”。
- Ch6 Promise/Future：本篇硬依赖 future/promise 的完成、失败、listener 和 executor 语义。
- Ch7 `04-init-and-lifecycle.md`：本篇硬依赖 `ChannelInitializer` 与 `channelRegistered` 生命周期理解。
- Ch8 池化章节：仅作为“前八章零件已齐”的软依赖背景，不承担本篇主线逻辑。

### 后续桥接检查

- 篇末桥到 Ch9-02，只引出 `ServerBootstrapAcceptor` 处理子 Channel 的下一层，不提前使用其结论。
- 没有把 Ch10 Codec 的后置内容提前当前提。

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

- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:291`
- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:324`
- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:371`
- `transport/src/main/java/io/netty/bootstrap/AbstractBootstrap.java:511`
- `transport/src/main/java/io/netty/bootstrap/Bootstrap.java:163`
- `transport/src/main/java/io/netty/channel/ReflectiveChannelFactory.java:27`

### 删码测试目标

删除全部 fenced code block 后，正文仍应完整保留：

- Bootstrap 的三步状态机
- `PendingRegistrationPromise` 的补缝作用
- `bind()` / `connect()` 的共骨架与分叉
- `clone/config/factory` 的边界说明
