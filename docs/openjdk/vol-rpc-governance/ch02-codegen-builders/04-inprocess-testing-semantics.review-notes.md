# grpc-java：InProcess Transport、Testing 与真实测试语义 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `examples/README.md` 当前明确不鼓励覆盖/模拟 client stub，并把 mock stub 视作“false sense of security”，证据：`examples/README.md:134`、`:141`。  
2. `examples/README.md` 当前明确推荐使用 `InProcessTransport`、`InProcessChannelBuilder`、`InProcessServerBuilder` 与 `GrpcCleanupRule` 来做更真实的单测，证据：`examples/README.md:154`、`:164`。  
3. `InProcessChannelBuilder` 当前并不是独立重写 channel 运行时，而是内部继续借助 `ManagedChannelImplBuilder` 和自定义 transport factory builder 装配 InProcess transport，证据：`inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:43`、`:61`、`:109`。  
4. `InProcessChannelBuilder` 当前会主动关闭部分 stats/retry metrics，并对 `useTransportSecurity()`、`usePlaintext()`、keepalive 做 no-op 处理，说明它保留主线语义但删掉网络噪音，证据：`inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:117`、`:139`、`:155`。  
5. `InProcessChannelBuilder` 当前还支持 `scheduledExecutorService()`、`maxInboundMetadataSize()`、`propagateCauseWithStatus()`、`assumedMessageSize()` 等测试/本地运行特有边界，证据：`inprocess/src/main/java/io/grpc/inprocess/InProcessChannelBuilder.java:183`、`:203`、`:224`。  
6. `InProcessServerBuilder` 当前同样继续复用 `ServerImplBuilder`，而不是另写一套 server runtime，证据：`inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:44`、`:84`、`:130`。  
7. `InProcessServerBuilder` 当前会关闭部分 stats，并把 handshake timeout 拉大到无意义值，避免测试环境被网络协商线程噪音污染，证据：`inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:132`。  
8. `InProcessServerBuilder` 当前仍保留 `scheduledExecutorService()`、`deadlineTicker()`、`maxInboundMetadataSize()`，说明 deadline/metadata 等语义在 InProcess 里依旧是要真实生效的，证据：`inprocess/src/main/java/io/grpc/inprocess/InProcessServerBuilder.java:157`、`:177`、`:195`。  
9. `GrpcCleanupRule` 当前不是语法糖，而是把 channel/server 的 graceful cleanup、await termination 和 force cleanup 纪律显式固化进测试层，证据：`testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:37`、`:118`、`:133`、`:165`、`:225`、`:253`。  
10. `InProcessTransportTest` 当前证明 InProcessTransport 仍然保留 method lookup、status/cause、message parse/serialize、stream listener 等真实 grpc 运行时语义，证据：`inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:63`、`:116`、`:153`、`:193`。

### 测试证据已核对

1. `InProcessTransportTest.causeShouldBePropagatedWithStatus()` 当前证明 InProcess 测试路径可开启更强的错误可见性，证据：`inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:116`。  
2. `InProcessTransportTest.methodNotFound()` 当前证明 InProcess 场景下 method lookup 仍走 `UNIMPLEMENTED`，证据：`inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:153`。  
3. `InProcessTransportTest.basicStreamInProcess()` 当前证明 client/server 对象仍真实经过 `streamRequest/parseRequest`、`streamResponse/parseResponse`，证据：`inprocess/src/test/java/io/grpc/inprocess/InProcessTransportTest.java:193`。  
4. `examples/README.md` 当前直接点名 mock stub 测不到 null message、close、headers、deadline、cancellation 等真实语义问题，证据：`examples/README.md:146`。  
5. `GrpcCleanupRule.after()` 当前证明测试层资源收尾不是“随手关一下”，而是先 graceful cleanup，再 await，再 force cleanup，证据：`testing/src/main/java/io/grpc/testing/GrpcCleanupRule.java:165`。

### 深审发现

1. **高风险：容易把 mock stub 当成更轻量但等价的测试替代。** 当前正文已压回“假安全感”与真实语义绕过。  
2. **高风险：容易把 InProcess 当成 fake transport。** 当前正文已强调它保留 grpc 主线语义，只删除网络噪音。  
3. **中风险：容易把 InProcess 夸成完全等价网络 transport。** 当前正文已点明 TLS/plaintext/keepalive 等 no-op，并进一步补强了“调试可见性更强不等于更接近生产”“网络级问题本来就被主动删掉”的边界。  
4. **中风险：容易把 `GrpcCleanupRule` 当 JUnit 语法糖。** 当前正文已补资源生命周期纪律。  
5. **低风险：容易把本篇写成测试工具说明书。** 当前正文边界收在测试语义桥，而非框架教程。

## 第二轮：因果审

- grpc-java 官方不鼓励 mock stub，是因为那会绕开真正值钱的 runtime 语义链，而不是因为风格偏好：✅  
- InProcess 必须沿用 builder、stub、marshaller、stream、status 主线，否则它就只是 fake transport：✅  
- InProcess 同时必须短路掉 TLS/keepalive/socket 噪音，否则测试成本和主线语义价值不匹配：✅  
- InProcess 的某些调试友好偏置（如 cause 传播）必须被理解为“更利于测试定位”，而不是“更接近生产 transport”：✅  
- `GrpcCleanupRule` 必须纳入本文主线，因为测试中的资源生命周期本来就是 grpc runtime 纪律的一部分：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> README 测试哲学 -> InProcessChannelBuilder -> InProcessServerBuilder -> InProcessTransport -> GrpcCleanupRule -> 收网”推进，没有退化成 API 列表或测试工具介绍。✅

失败方案已覆盖：
- mock stub 最方便所以足够好  
- InProcess 只是假的 transport  
- 测试收尾只是 JUnit 小事  
- InProcess 和真实网络 transport 完全等价  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- InProcess 不是 fake grpc，而是保留主线语义的测试/集成桥  
- 它沿用 builder、stub、stream、status、message parse 等真实 grpc 路径  
- 它删掉的是 socket/TCP/TLS/keepalive 等网络噪音  
- `GrpcCleanupRule` 把资源生命周期纪律带进测试层  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未写成 JUnit/Mockito 教程。✅  
- 未把 InProcess 夸成完全等价网络 transport。✅  
- 未把所有内部优化细节吞进本篇。✅  
- 重点仍压在 InProcess/testing 作为集成层桥接的结构位置，边界收得住。✅

## 第六轮：依赖审

- 已直接承接 builder、消息对象桥与客户端/服务端主线：说明这些主线在真实测试场景如何继续成立。✅  
- 与 codegen 篇的关系更多是上游背景而非直接下游装配链，本篇重点不在 `*Grpc` 生成，而在生成后的真实调用语义如何被保留下来。✅  
- `examples/README`、builder 实现、transport 测试和 cleanup rule 的组合足以支撑“这不是测试附录，而是集成层桥”的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 README、InProcess builder/transport 与 cleanup rule。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `19,035`。  
- 目标定位：重要集成层/测试语义篇，满足篇幅要求。✅

## 结论

当前三件套的目标明确：这一篇应把 InProcess / Testing 从“测试附录”提升为 grpc-java 集成层里的真实语义桥，说明为什么官方宁可保留主线语义、去掉网络噪音，也不鼓励直接 mock stub。只要正文按这个 review 结论收口，它就能成为完整卷里非常关键的一块开发者接入与验证地基。