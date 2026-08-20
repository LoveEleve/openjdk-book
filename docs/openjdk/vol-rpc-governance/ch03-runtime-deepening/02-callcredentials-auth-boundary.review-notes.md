# grpc-java：CallCredentials、认证与调用凭证边界 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ClientInterceptor` 当前在注释里明确说明“提供认证凭证更好用 `CallCredentials`”，它只是在 `CallOptions` 里设置 `CallCredentials` 的方案之一，证据：`api/src/main/java/io/grpc/ClientInterceptor.java:31`。  
2. `CallCredentials` 当前定义的是每次 RPC 都要通过 request metadata 传给 server 的 credential data，证据：`api/src/main/java/io/grpc/CallCredentials.java:21`。  
3. `CallCredentials.applyRequestMetadata(RequestInfo, Executor appExecutor, MetadataApplier applier)` 当前被设计成异步凭证生成口：允许实现把阻塞操作放到 app executor，最终通过 applier 放行或失败，证据：`api/src/main/java/io/grpc/CallCredentials.java:40`、`:55`。  
4. `CallCredentials.MetadataApplier` 当前只有 `apply(Metadata)` 与 `fail(Status)`，且注释明确 RPC 只有在这之后才会继续，证据：`api/src/main/java/io/grpc/CallCredentials.java:68`、`:73`。  
5. `CallCredentials.RequestInfo` 当前提供 method、callOptions、security level、authority、transport attrs，说明凭证决策需要安全视角，证据：`api/src/main/java/io/grpc/CallCredentials.java:86`。  
6. `CallOptions` 当前持有 `CallCredentials`，并提供 `withCallCredentials` / `getCredentials`，证据：`api/src/main/java/io/grpc/CallOptions.java:65`、`:139`、`:284`。  
7. `AbstractStub.withCallCredentials(...)` 当前通过 `build(channel, callOptions.withCallCredentials(credentials))` 进入调用，证据：`stub/src/main/java/io/grpc/stub/AbstractStub.java:224`。  
8. `CallCredentialsApplyingTransportFactory` 当前会在每个 transport 前检查 `callOptions.getCredentials()`，无则回退 channel 级，两者都有则组合 `CompositeCallCredentials`，证据：`core/src/main/java/io/grpc/internal/CallCredentialsApplyingTransportFactory.java:43`、`:117`。  
9. `CallCredentialsApplyingTransportFactory` 当前在真正新建 stream 前构造 `RequestInfo`、`MetadataApplierImpl` 并触发 `applyRequestMetadata`，证据：`core/src/main/java/io/grpc/internal/CallCredentialsApplyingTransportFactory.java:124`、`:130`。  
10. `MetadataApplierImpl` 当前通过 `apply(headers)` / `fail(status)` 把凭证结果送回调用，证据：`core/src/main/java/io/grpc/internal/MetadataApplierImpl.java:33`、`:54`。  
11. `CompositeCallCredentials` / `CompositeChannelCredentials` 当前提供凭证组合语义，说明认证不是单一静态 header，而是可组合的每-RPC 安全语义，证据：`api/src/main/java/io/grpc/CompositeCallCredentials.java:27`、`api/src/main/java/io/grpc/CompositeChannelCredentials.java:22`。

### 测试证据已核对

1. `CallCredentialsApplyingTest` 当前覆盖 per-call credentials 进入 transport factory、`RequestInfo` 传播、app executor 传递、metadata 挂入、异步 apply/fail 与 null/channel 级回退等，证据：`core/src/test/java/io/grpc/internal/CallCredentialsApplyingTest.java:131`、`:147`、`:172`、`:254`、`:275`、`:305`、`:464`、`:492`、`:508`。  
2. `CompositeCallCredentialsTest` 当前覆盖多凭证组合时的成功、失败与 header 合并语义，证据：`api/src/test/java/io/grpc/CompositeCallCredentialsTest.java:27`。  
3. `ManagedChannelImplTest.informationPropagatedToNewStreamAndCallCredentials()` 当前证明 `RequestInfo` 会传播到 call credentials，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:2096`。  
4. `ManagedChannelImplTest.oobChannelHasNoChannelCallCredentials()` 与 `oobChannelWithOobChannelCredsHasChannelCallCredentials()` 当前证明 OOB channel 的 credentials 边界，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:1769`、`:1861`。  
5. `CallOptionsTest` 当前证明 `CallOptions` 可以携带并覆写 credentials，证据：`api/src/test/java/io/grpc/CallOptionsTest.java:58`。

### 深审发现

1. **高风险：容易把认证写成 interceptor 里加 token。** 当前正文已压回 `CallCredentials` 的每次 RPC 异步凭证门语义。  
2. **高风险：容易把 `CallCredentials` 写成 metadata utils。** 当前正文已补 `RequestInfo`、`appExecutor`、`MetadataApplier`、组合语义等结构差异。  
3. **中风险：容易忽略安全等级、authority、transport attrs。** 当前正文已补 `RequestInfo` 的安全视角。  
4. **中风险：容易把认证失败写成抛异常。** 当前正文已补 `MetadataApplier.fail(status)` 的收口路径。  
5. **低风险：容易把本篇写成具体认证框架使用手册。** 当前正文边界收在 `CallCredentials` 运行时机制。

## 第二轮：因果审

- 认证如果不是每-RPC、需要异步获取、需要安全视角，就可能被降级成普通 metadata 拼接：✅  
- `CallCredentials` 必须独立于 interceptor，因为它需要独有的 `RequestInfo`、`appExecutor`、`MetadataApplier` 与组合语义：✅  
- RPC 必须等 `apply()/fail()` 才能继续，因此它是调用前强制门：✅  
- `CallCredentialsApplyingTransportFactory` 必须站在 transport 前，才能把 channel/per-call 凭证组合压到 stream 创建前：✅  
- 认证失败必须通过 `MetadataApplier.fail(status)` 而不是普通抛异常，才能和调用收口对齐：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> CallCredentials -> RequestInfo -> MetadataApplier -> CallOptions -> ApplyingTransportFactory -> 组合语义 -> 与 interceptor 边界 -> 收网”推进，没有退化成使用手册。✅

失败方案已覆盖：
- 认证用 interceptor 塞 token  
- CallCredentials 等价 metadata utils  
- 安全等级无所谓  
- 认证失败就抛异常  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `CallCredentials` 是每-RPC 的异步凭证生成门  
- `RequestInfo` 提供安全决策信息  
- `MetadataApplier` 是调用前强制出口  
- factory 在 transport 前组合 channel/per-call 凭证  
- 认证与 `ClientInterceptor` 职责不同  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未扩成 TLS/mTLS/ALTS 全量机制。✅  
- 未把 OAuth/JWT 写成使用手册。✅  
- 未把 `CallCredentials` 与 `ClientInterceptor` 职责混为一谈。✅  
- 重点仍压在调用前异步凭证门的位置，边界收得住。✅

## 第六轮：依赖审

- 已直接承接 interceptor 篇：解释哪些横切适合 interceptor、哪些适合 `CallCredentials`。✅  
- 已承接客户端调用主线与 builder 装配层：解释 credentials 如何从 stub/callOptions 进入 transport 前链。✅  
- `CallCredentialsApplyingTest`、`CompositeCallCredentialsTest`、`ManagedChannelImplTest` 与 `CallOptionsTest` 足以支撑“调用前凭证门”的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 `CallCredentials`、`CallOptions`、transport factory 与 testing 实现。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `15,256`。  
- 目标定位：重要认证边界补深篇，满足篇幅要求。✅

## 结论

当前三件套的目标明确：这一篇应把 `CallCredentials` 从“又一个 metadata helper”提升到“每次 RPC 的调用前异步凭证门”，并和 `ClientInterceptor` 的职责彻底拆开。只要正文按这个 review 结论收口，它就能成为 grpc-java 完整卷里非常关键的认证安全工作基础。