# gRPC-Java：拦截器、上下文传播与 Deadline — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ClientInterceptor` 当前拦截的是 outgoing call 的创建边界，而不是普通 before/after 回调，证据：`api/src/main/java/io/grpc/ClientInterceptor.java:21`、`:51`。  
2. `ClientInterceptor` 当前明确要求 `next.newCall()` 不得在不同于当前的 `Context` 下调用，否则可能造成未定义行为和 `Context` 链泄漏，证据：`api/src/main/java/io/grpc/ClientInterceptor.java:51`。  
3. `ServerInterceptor` 当前拦截的是 incoming call 在 `ServerCallHandler` 之前的 dispatch 边界，并返回新的 `ServerCall.Listener`，证据：`api/src/main/java/io/grpc/ServerInterceptor.java:21`、`:41`。  
4. `ClientInterceptors.intercept()` 当前通过逐层包 `InterceptorChannel` 构造拦截链，`interceptForward()` 则通过 reverse 改变先后顺序，证据：`api/src/main/java/io/grpc/ClientInterceptors.java:35`、`:64`、`:86`、`:144`。  
5. `Contexts.interceptCall()` 当前会先 attach 指定 `Context` 调 `next.startCall()`，再返回一个在每次 listener 回调时 attach/detach 的 `ContextualizedServerCallListener`，证据：`api/src/main/java/io/grpc/Contexts.java:31`、`:44`、`:63`。  
6. `Contexts.statusFromCancelled()` 当前会把已取消的 Context 映射回 `Status`，其中 `TimeoutException` 会映射成 `DEADLINE_EXCEEDED`，证据：`api/src/main/java/io/grpc/Contexts.java:128`。  
7. `Context` 当前定义的不是普通局部值容器，而是可 attach/detach 的作用域、可继承的值和可级联取消协议，证据：`api/src/context/java/io/grpc/Context.java:33`、`:41`、`:59`、`:72`。  
8. `Context.current()` 当前永不返回 null；`withCancellation()`、`withDeadlineAfter()`、`withValue()`、`fork()` 共同构成了值传播/取消传播/边界切断的协议面，证据：`api/src/context/java/io/grpc/Context.java:171`、`:239`、`:268`、`:342`、`:403`、`:426`、`:461`、`:489`。  
9. `Deadline` 当前是绝对时间点，而不是相对 timeout；它支持比较、取更小者、偏移与到期任务调度，证据：`api/src/context/java/io/grpc/Deadline.java:27`、`:69`、`:79`、`:122`、`:148`、`:162`、`:195`。  
10. `Deadline` 当前对自定义 ticker 有严格边界说明，生产环境默认应使用 system ticker，证据：`api/src/context/java/io/grpc/Deadline.java:79`。  
11. `ClientCallImpl` 当前会在创建 call 时捕获 `Context.current()`，并在 listener 回调、取消和 deadline 下沉时真实使用这份上下文，证据：`core/src/test/java/io/grpc/internal/ClientCallImplTest.java:616`、`:694`、`:721`、`:809`。  
12. `ServerImpl` 当前通过 interceptor 与 call context 把服务端 listener 生命周期绑定到统一 Context，证据：`core/src/test/java/io/grpc/internal/ServerImplTest.java:1022`、`:1228`、`:1374`。

### 测试证据已核对

1. `ClientInterceptorsTest.channelAndInterceptorCalled()` 当前证明客户端拦截器确实包在 `newCall()` 边界上，证据：`api/src/test/java/io/grpc/ClientInterceptorsTest.java:98`。  
2. `ClientInterceptorsTest.ordered()` 与 `orderedForward()` 当前证明 `intercept()` / `interceptForward()` 的顺序语义不同，证据：`api/src/test/java/io/grpc/ClientInterceptorsTest.java:137`、`:179`。  
3. `ClientInterceptorsTest.callOptions()` 当前证明客户端拦截器可改写 CallOptions，包括 deadline，证据：`api/src/test/java/io/grpc/ClientInterceptorsTest.java:221`。  
4. `ClientInterceptorsTest.addOutboundHeaders()` 与 `examineInboundHeaders()` 当前证明拦截器既可改 outbound metadata，也可包 listener 观察 inbound headers，证据：`api/src/test/java/io/grpc/ClientInterceptorsTest.java:243`、`:274`。  
5. `ContextsTest.interceptCall_basic()` 当前证明 `Contexts.interceptCall()` 会在所有 listener 回调中绑定指定 Context，证据：`api/src/test/java/io/grpc/ContextsTest.java:54`。  
6. `ContextsTest.interceptCall_restoresIfNextThrows()` 当前证明即使 `startCall()` 抛异常，原 Context 也会恢复，证据：`api/src/test/java/io/grpc/ContextsTest.java:108`。  
7. `ContextsTest.statusFromCancelled_TimeoutExceptionShouldMapToDeadlineExceeded()` 当前证明超时取消会映射成 `DEADLINE_EXCEEDED`，证据：`api/src/test/java/io/grpc/ContextsTest.java:193`。  
8. `ContextTest.notifyListenersOnCancel()`、`cascadingCancellationNotifiesChild()`、`nonCascadingCancellationDoesNotNotifyForked()` 当前证明取消通知、父子级联与 `fork()` 边界，证据：`api/src/test/java/io/grpc/ContextTest.java:276`、`:395`、`:472`。  
9. `ContextTest.testWrapRunnable()` 与 `currentContextExecutor()` 当前证明 Context 可以跨线程传播到 runnable / executor，证据：`api/src/test/java/io/grpc/ContextTest.java:486`、`:557`。  
10. `ContextTest.earlierParentDeadlineTakesPrecedenceOverLaterChildDeadline()`、`forkingContextDoesNotCarryDeadline()`、`absoluteDeadlineTriggersAndPropagates()` 当前证明 deadline 在 parent/child/fork 之间的差异与传播，证据：`api/src/test/java/io/grpc/ContextTest.java:624`、`:662`、`:678`。  
11. `ServerImplTest.interceptors()` 当前证明多层服务端 interceptor 能逐层扩展当前 Context，证据：`core/src/test/java/io/grpc/internal/ServerImplTest.java:1022`。  
12. `ServerImplTest.testCallContextIsBoundInListenerCallbacks()` 当前证明服务端 listener 各回调看到的是同一个 call Context，证据：`core/src/test/java/io/grpc/internal/ServerImplTest.java:1228`。  
13. `ServerImplTest.testContextExpiredBeforeStreamCreate_StreamCancelNotCalledBeforeSetListener()` 当前证明极短 deadline 下，listener 先装好、再 cancel，证据：`core/src/test/java/io/grpc/internal/ServerImplTest.java:1374`。  
14. `ClientCallImplTest.callerContextPropagatedToListener()`、`contextCancellationCancelsStream()`、`contextAlreadyCancelledNotifiesImmediately()`、`contextDeadlineShouldBePropagatedToStream()` 当前证明客户端 Context/Deadline 会真正落回 call/stream，证据：`core/src/test/java/io/grpc/internal/ClientCallImplTest.java:616`、`:694`、`:721`、`:809`。  
15. `ClientCallImplTest.contextDeadlineShouldOverrideLargerCallOptionsDeadline()` 与 `contextDeadlineShouldNotOverrideSmallerCallOptionsDeadline()` 当前证明 Context deadline 与 CallOptions deadline 会取更早者，证据：`core/src/test/java/io/grpc/internal/ClientCallImplTest.java:829`、`:850`。  
16. `ClientCallImplTest.expiredDeadlineCancelsStream_Context()` 当前证明 Context deadline 最终会转成 stream cancel，证据：`core/src/test/java/io/grpc/internal/ClientCallImplTest.java:934`。

### 深审发现

1. **高风险：容易把拦截器写成 before/after 回调。** 当前正文已把重点压回 `newCall()` / `startCall()` 边界包装。  
2. **高风险：容易把 `Context` 写成 ThreadLocal 小工具。** 当前正文已补作用域纪律、wrap、取消级联与 fork 边界。  
3. **高风险：容易把 deadline 写成 timeout 参数。** 当前正文已明确其绝对时间点、比较规则与裁决角色。  
4. **中风险：容易把第三篇写成 observability 生态串讲。** 当前正文边界收在 gRPC 自带机制上。  
5. **中风险：容易让横切面脱离前两篇主线。** 当前正文已把拦截器/Context/Deadline 重新挂回 `ClientCallImpl`、`ServerImpl` 与 listener/stream，但卷内接力关系仍以导语和局部回扣为主，不如第二篇那样强。

## 第二轮：因果审

- 横切面如果不挂在调用边界，就会侵入具体调用类并打散主线：✅  
- 客户端拦截器之所以包 `Channel -> ClientCall`，是因为客户端真正统一入口就是 `ClientCall`：✅  
- 服务端要把“扩展什么 Context”和“Context 怎样附着到 listener 生命周期”拆成两段机制，否则 `ServerInterceptor` 与 `Contexts` 的职责会糊在一起：✅  
- `Context` 之所以重要，不是因为能存值，而是因为它能传播作用域、取消和 deadline：✅  
- `Deadline` 之所以要独立存在，是因为整条调用链需要可传播、可比较的绝对截止时间，而不是局部 timeout：✅  
- 取消最终还要被翻译回统一 `Status` 语义，因此横切面协议并没有停留在作用域层：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> 客户端拦截器 -> 服务端拦截器 -> Context -> Deadline -> 回挂主线 -> 收网”推进，没有退化成 API 词典。✅

失败方案已覆盖：
- 拦截器就是 before/after 回调  
- `Context` 就是 ThreadLocal 小工具  
- deadline 就是 timeout 数字  
- 横切面全部塞进调用类  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- 客户端拦截器包 `Channel -> ClientCall`  
- 服务端拦截器包 `startCall()` / listener 边界  
- `Context` 负责作用域、值传播和取消级联  
- `Deadline` 负责整条调用链的截止时钟  
- 这些横切面协议最终会重新挂回 `ClientCallImpl`、`ServerImpl` 和 stream/listener 主线  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开具体 tracing/metrics/auth 生态实现。✅  
- 未把 NameResolver / LoadBalancer 拉进第三篇。✅  
- 未重写 Netty transport 细节。✅  
- 未把第三篇写成 API 枚举或测试摘要。✅  
- 重点仍压在横切面协议怎样挂回调用主线，边界收得住。✅

## 第六轮：依赖审

- 已承接前两篇主线：客户端调用基线与服务端调用基线共同为第三篇提供挂点。✅  
- `ClientCallImplTest`、`ServerImplTest`、`ContextsTest`、`ContextTest` 的组合足以支撑“横切面协议重新落回调用主线”的论断。✅  
- 当前正文已经不只是导语式承接：服务端段落已明确拆开 `ServerInterceptor` 与 `Contexts.interceptCall()` 的职责，且补出了与前两篇、作用域取消语义之间的顺推关系。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验实现或测试。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `30,222`。  
- 目标定位：重大横切面语义篇，满足篇幅要求。✅

## 结论

当前三件套的目标明确：第三篇应把“拦截器挂调用边界、Context 管执行作用域、Deadline 管取消时钟”这套横切面协议立住，并解释它们怎样稳定地挂回前两篇的 RPC 主线。只要正文按这个 review 结论收口，它就能成为后续 NameResolver/LoadBalancer/transport 桥接篇的稳定前置地基。