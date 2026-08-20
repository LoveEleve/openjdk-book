# gRPC-Java：拦截器、上下文传播与 Deadline — rewrite plan

## 篇章定位

- 写作卷：`vol-rpc-governance`
- 章节：`ch01-grpc-runtime`
- 篇：`03 拦截器、上下文传播与 Deadline`
- 对应主题：`G-RPC-3 拦截器、Context 与 Deadline`
- 文章类型：横切面语义篇
- 正文状态：未开始
- 基于版本：`grpc-java v1.83.1`

## 文章定位

- 核心困惑：前两篇已经把客户端/服务端调用主线立住了，但像认证、日志、Tracing、超时、取消、跨线程上下文这些“横着切进整条 RPC”的能力，到底是怎么被挂进调用主线里的？
- 一句话顿悟：gRPC 不把这些横切面语义塞进某一个具体调用类里，而是分成两套机制：拦截器负责在 call 入口和 dispatch 边界上插入行为，`Context`/`Deadline` 负责把“这次调用携带什么作用域、何时应该被取消”变成可传播、可继承、可级联的运行时协议。
- 文章边界：本篇只讲 `ClientInterceptor / ServerInterceptor / ClientInterceptors / Contexts / Context / Deadline` 怎样挂进前两篇调用主线；不展开 NameResolver/LoadBalancer，不重讲服务端/客户端主链，不深入 transport 细节或 observability 生态适配器。

## 前置依赖

### HARD

- `vol-rpc-governance/ch01-grpc-runtime/01-stub-channel-clientcall.md`：已经知道客户端主线怎样落到 `ClientCallImpl`。
- `vol-rpc-governance/ch01-grpc-runtime/02-servercall-and-streaming-model.md`：已经知道服务端主线怎样落到 `ServerImpl / ServerCallImpl / ServerCalls`。
- 至少知道 gRPC 调用是异步/回调驱动，而不是同步栈内直达。

### SOFT

- 认证、Tracing、Metrics 只作为拦截器典型用途点到，不展开具体生态实现。
- Netty HTTP/2 transport 只在说明 deadline/cancel 最终会下沉到 stream 时点到。

### NAV

- 后续第四篇：`gRPC-Java：NameResolver、LoadBalancer 与 Netty Transport`

## 一句话困惑

为什么日志、认证、Tracing、超时、取消和上下文传播这些横切面能力，没有把前两篇的调用主线打散，而是还能稳定地挂在客户端、服务端和跨线程回调的整条链上？

## 一句话顿悟

gRPC 通过“拦截器 + Context/Deadline”把横切面语义从主调用类里拆出来：拦截器负责在 `newCall/startCall` 边界包裹行为，`Context` 负责跨线程携带作用域和值，`Deadline` 负责把 timeout 提升成可传播的绝对截止时间，而取消会沿着这套上下文协议级联回整个调用链。

## 读者理解路径

1. 先否定“横切面就是 before/after callback”这种过于薄的理解。
2. 先建立最小总图：`ClientInterceptor/ServerInterceptor` 挂在调用入口，`Context` 挂在执行作用域，`Deadline` 挂在取消时钟。
3. 解释客户端拦截器为什么不是直接改业务 stub，而是包一层 `Channel -> ClientCall`。
4. 解释服务端拦截器为什么不是在业务方法里“顺手做点事”，而是通过 `startCall` 包装 `ServerCall.Listener`。
5. 解释 `Context` 为什么不是普通 ThreadLocal：它要可 attach/detach、可 wrap runnable/callable、可级联取消。
6. 解释 `Deadline` 为什么不是普通 timeout：它是可传递的绝对截止时间，能和 `Context`、`CallOptions` 一起裁决调用命运。
7. 最后收束到：横切面语义并不是附属品，而是整条 RPC 调用链可观测、可取消、可传播的基础协议。

## 失败方案推演

### 失败方案一：拦截器就是 before/after 回调

- 这只能解释“我想打印个日志”，解释不了：
- 为什么客户端拦截器要返回新的 `ClientCall`
- 为什么服务端拦截器要返回新的 `ServerCall.Listener`
- 为什么顺序、包装链和 `next.startCall()/next.newCall()` 如此关键
- 所以拦截器不是事件通知，而是调用边界重写点。

### 失败方案二：`Context` 就是带点包装的 ThreadLocal

- 这会漏掉：
- attach/detach 的作用域纪律
- wrap runnable/callable/executor 的跨线程传播
- 可取消上下文与监听器级联
- fork 不继承取消、child 继承取消这些边界
- 所以 `Context` 不是“线程本地变量袋子”，而是作用域与取消协议。

### 失败方案三：deadline 就是一个 timeout 数字

- 这会错过 deadline 最值钱的地方：
- 它是绝对时间点，不是相对时长
- 它能在父子上下文之间比较、取更早者
- 它能和 `CallOptions` deadline、`Context` deadline 一起决定谁真正生效
- 它到期后会转成取消和 `DEADLINE_EXCEEDED`
- 所以 deadline 不是参数，而是整条 RPC 链的截止约束。

### 失败方案四：横切面最好塞进具体调用类里，一层解决

- 这会把 `ClientCallImpl`、`ServerCallImpl`、`ServerImpl` 全部变成巨型上帝类。
- gRPC 选择拆分成拦截器 + Context/Deadline，恰恰是为了让主调用线保持稳定，而把认证、Tracing、取消、超时等横切逻辑独立出来。

## 必须澄清的误解

1. `ClientInterceptor` / `ServerInterceptor` 不是日志回调接口，而是调用边界包装机制。
2. `ClientInterceptors.intercept()` 的顺序不是装饰性的，先后顺序会改变谁最先/最后接触调用。
3. `Context` 不是普通 ThreadLocal，它是可作用域切换、可跨线程传播、可级联取消的协议对象。
4. `Deadline` 不是普通 timeout 数字，它是可传播、可比较的绝对截止时间。
5. 取消不是 transport 独享细节，而会沿 Context/Deadline 传播到 listener、call、stream 与应用代码。

## 文章结构与字数预算

1. 困惑开场：为什么横切面没有把调用主线打散（800-1000 字）
2. 最小总图：拦截器、Context、Deadline 分别挂在哪（1200-1600 字）
3. 客户端拦截器：为什么要包 `Channel -> ClientCall`（1800-2400 字）
4. 服务端拦截器：为什么要包 `ServerCall.Listener` 与 dispatch 边界（1600-2200 字）
5. `Context`：为什么它是作用域与取消协议，而不是 ThreadLocal 小工具（2200-3000 字）
6. `Deadline`：为什么它是绝对截止时间，而不是 timeout 参数（1600-2200 字）
7. 取消与传播：deadline/context 怎样真正落回调用主线（1200-1800 字）
8. 收网总结：横切面协议怎样把 RPC 链接成整体（600-800 字）

目标叙述性正文：`9000-12000` 字；代码块不计入目标。

## 证据清单

- `api/src/main/java/io/grpc/ClientInterceptor.java:21`
- `api/src/main/java/io/grpc/ClientInterceptor.java:51`
- `api/src/main/java/io/grpc/ServerInterceptor.java:21`
- `api/src/main/java/io/grpc/ServerInterceptor.java:41`
- `api/src/main/java/io/grpc/ClientInterceptors.java:35`
- `api/src/main/java/io/grpc/ClientInterceptors.java:64`
- `api/src/main/java/io/grpc/ClientInterceptors.java:86`
- `api/src/main/java/io/grpc/ClientInterceptors.java:144`
- `api/src/main/java/io/grpc/Contexts.java:31`
- `api/src/main/java/io/grpc/Contexts.java:44`
- `api/src/main/java/io/grpc/Contexts.java:63`
- `api/src/main/java/io/grpc/Contexts.java:128`
- `api/src/context/java/io/grpc/Context.java:33`
- `api/src/context/java/io/grpc/Context.java:41`
- `api/src/context/java/io/grpc/Context.java:59`
- `api/src/context/java/io/grpc/Context.java:72`
- `api/src/context/java/io/grpc/Context.java:171`
- `api/src/context/java/io/grpc/Context.java:239`
- `api/src/context/java/io/grpc/Context.java:268`
- `api/src/context/java/io/grpc/Context.java:342`
- `api/src/context/java/io/grpc/Context.java:403`
- `api/src/context/java/io/grpc/Context.java:426`
- `api/src/context/java/io/grpc/Context.java:461`
- `api/src/context/java/io/grpc/Context.java:489`
- `api/src/context/java/io/grpc/Deadline.java:27`
- `api/src/context/java/io/grpc/Deadline.java:69`
- `api/src/context/java/io/grpc/Deadline.java:79`
- `api/src/context/java/io/grpc/Deadline.java:122`
- `api/src/context/java/io/grpc/Deadline.java:148`
- `api/src/context/java/io/grpc/Deadline.java:162`
- `api/src/context/java/io/grpc/Deadline.java:195`

## 测试证据清单

- `api/src/test/java/io/grpc/ClientInterceptorsTest.java:98`：客户端拦截器确实包在 channel/newCall 边界上。
- `api/src/test/java/io/grpc/ClientInterceptorsTest.java:137`：`intercept()` 顺序是最后一个 interceptor 最先进入。
- `api/src/test/java/io/grpc/ClientInterceptorsTest.java:179`：`interceptForward()` 顺序相反。
- `api/src/test/java/io/grpc/ClientInterceptorsTest.java:221`：拦截器可改写 `CallOptions`，包括 deadline。
- `api/src/test/java/io/grpc/ClientInterceptorsTest.java:243`：拦截器可写 outbound headers。
- `api/src/test/java/io/grpc/ClientInterceptorsTest.java:274`：拦截器可观察 inbound headers。
- `api/src/test/java/io/grpc/ContextsTest.java:54`：`Contexts.interceptCall()` 会在 listener 各回调里绑定指定 Context。
- `api/src/test/java/io/grpc/ContextsTest.java:108`：即使 `next.startCall()` 抛错也会恢复原上下文。
- `api/src/test/java/io/grpc/ContextsTest.java:193`：`statusFromCancelled()` 可把取消映射成 `Status`。
- `api/src/test/java/io/grpc/ContextTest.java:276`：取消会通知监听器。
- `api/src/test/java/io/grpc/ContextTest.java:395`：父 context 取消会级联到 child。
- `api/src/test/java/io/grpc/ContextTest.java:472`：`fork()` 不继承取消。
- `api/src/test/java/io/grpc/ContextTest.java:486`：`wrap(Runnable)` 会恢复指定上下文。
- `api/src/test/java/io/grpc/ContextTest.java:557`：`currentContextExecutor()` / `fixedContextExecutor()` 可做跨线程传播。
- `api/src/test/java/io/grpc/ContextTest.java:624`：更早的 parent deadline 会压过 child deadline。
- `api/src/test/java/io/grpc/ContextTest.java:662`：`fork()` 不携带 deadline。
- `api/src/test/java/io/grpc/ContextTest.java:678`：deadline 到期会触发取消并级联。
- `core/src/test/java/io/grpc/internal/ServerImplTest.java:1022`：服务端 interceptor 可逐层扩展当前 Context。
- `core/src/test/java/io/grpc/internal/ServerImplTest.java:1228`：listener 回调中绑定的是同一个 call Context。
- `core/src/test/java/io/grpc/internal/ServerImplTest.java:1374`：极短 deadline 也要等 listener 先接好再 cancel。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:616`：客户端 listener 回调能看到创建 call 时捕获的 Context。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:694`：context 取消会真正 cancel stream。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:721`：context 若已取消，call 会立刻 `onClose` 且不创建 stream。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:809`：Context deadline 会下沉到 stream。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:829`：Context deadline 可压过更晚的 CallOptions deadline。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:850`：更早的 CallOptions deadline 不会被 Context deadline 覆盖。
- `core/src/test/java/io/grpc/internal/ClientCallImplTest.java:934`：Context deadline 到期会转成 stream cancel。

## 版本边界

- 当前分析对象固定为 `grpc-java v1.83.1`。
- 本篇讨论的是 gRPC 自带的横切面机制，不覆盖具体认证、Tracing、Metrics 适配器实现。
- `Context` 当前默认存储后端是 `ThreadLocalContextStorage`，但也允许 override；本文只讲抽象协议与默认心智图。
- `Deadline` 与自定义 ticker 的比较规则主要用于测试；生产语义默认应基于 system ticker。

## 与其他篇的边界

### 本篇要讲清

- 客户端/服务端拦截器如何挂进调用边界。
- `Context` 怎样传播值、作用域和取消。
- `Deadline` 怎样把 timeout 变成可传播截止时间。
- 拦截器与 Context/Deadline 怎样把横切面语义挂回前两篇调用主线。

### 本篇不深讲

- 具体 tracing/metrics/认证框架实现。
- NameResolver / LoadBalancer。
- Netty transport 细节。
- gRPC 之外框架的上下文模型对照。

## 写作后检查

- [ ] 开篇先抓“横切面为什么没有把调用主线打散”，而不是直接讲 API 列表。
- [ ] 至少展开 3 个失败方案，且包含“Context 不是 ThreadLocal 小工具”和“deadline 不是 timeout 数字”。
- [ ] 明确给出“拦截器挂入口、Context 挂作用域、Deadline 挂取消时钟”的总图。
- [ ] 不把本篇写成 API 词典或测试摘要。
- [ ] 不把第三篇扩成 observability 生态串讲。
- [ ] 删除代码块后，读者仍能复述横切面机制如何挂回调用主线。
- [ ] 所有 `file:line` 在写正文时重新验证。
- [ ] 通过一次性深审收口。
