# grpc-java：ManagedChannelBuilder、ServerBuilder 与运行时配置装配 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ManagedChannelBuilder` 当前不是 transport-specific 构造器，而是 `ManagedChannel` 的公共 builder 抽象，集中暴露 target、executor、interceptor、authority、resolver、service config、message size、keepalive 等配置边界，证据：`api/src/main/java/io/grpc/ManagedChannelBuilder.java:27`、`:43`、`:90`、`:108`、`:153`、`:218`、`:273`、`:625`。  
2. `ManagedChannelBuilder.forTarget()` 当前会区分 URI target 与 authority string，并明确指出 authority 会被默认 resolver scheme 包装成 URI，说明 target 解释在 builder 层就开始决定后续 resolver 路径，证据：`api/src/main/java/io/grpc/ManagedChannelBuilder.java:43`、`:90`。  
3. `ManagedChannelBuilder` 当前把 `executor()` 与 `offloadExecutor()` 分成两套配置边界，说明执行路径与昂贵任务 offload 路径在 builder 层就已经被区分，证据：`api/src/main/java/io/grpc/ManagedChannelBuilder.java:122`、`:139`。  
4. `ManagedChannelImplBuilder` 当前持有完整的客户端内部装配状态，包括 executorPool、offloadExecutorPool、interceptors、nameResolverRegistry、transportFilters、authorityOverride、defaultLbPolicy、compressor/decompressor、idle timeout、retry、defaultServiceConfig、proxyDetector 等，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:152`。  
5. `ManagedChannelImplBuilder` 当前存在基于 target string 与 direct `SocketAddress` 的不同装配路径，说明 builder 层会直接决定后续 resolver/provider 走向，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:279`、`:368`。  
6. `ManagedChannelImplBuilder.directExecutor()` / `executor()` 当前会把外部 executor 收束成固定或默认对象池，而不是简单保存引用，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:407`。  
7. `ServerBuilder` 当前集中暴露服务端配置边界，包括 executor、callExecutor、service registry、interceptor、fallback registry、TLS、compressor/decompressor、handshake timeout、keepalive/max connection 等，证据：`api/src/main/java/io/grpc/ServerBuilder.java:29`、`:43`、`:61`、`:75`、`:105`、`:144`、`:181`、`:193`、`:242`。  
8. `ServerImplBuilder` 当前内部持有 registryBuilder、transportFilters、interceptors、streamTracerFactories、fallbackRegistry、executorPool、compressor/decompressor、handshakeTimeout、ticker、executorSupplier 等完整服务端装配状态，证据：`core/src/main/java/io/grpc/internal/ServerImplBuilder.java:57`、`:81`。  
9. `ServerImplBuilder.addService()` / `fallbackHandlerRegistry()` 当前说明服务端 method lookup 的主 registry / fallback registry 在 builder 阶段就已被参数化，证据：`core/src/main/java/io/grpc/internal/ServerImplBuilder.java:143`、`:181`。  
10. `ServerImplBuilder.build()` 当前不是凭空创建 server，而是在已装配状态上收口成 `ServerImpl`，并把 tracer factories、metric recorder、transport servers builder 一起喂进去，证据：`core/src/main/java/io/grpc/internal/ServerImplBuilder.java:257`。  
11. grpc-java README 当前把全库高层结构分成 `Stub / Channel / Transport` 三层，这为本篇解释“builder 是 codegen 之后、runtime 之前的装配桥”提供了官方结构支撑，证据：`README.md:232`。

### 测试证据已核对

1. `ManagedChannelImplBuilderTest.getDefaultPort_*()` 当前证明 default/custom/fixed-port provider 会在 builder 层就稳定下来，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:149`。  
2. `ManagedChannelImplBuilderTest.executor_*()`、`directExecutor()`、`offloadExecutor_*()` 当前证明执行模型与 offload 模型在 builder 阶段就会收束成对象池语义，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:180`。  
3. `ManagedChannelImplBuilderTest.nameResolverFactory_*()`、`defaultLoadBalancingPolicy_*()`、direct address 限制等测试，当前证明某些 resolver/LB 装配路径在 builder 阶段就会被允许或禁止，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:221`。  
4. `ManagedChannelImplBuilderTest.decompressorRegistry_*()`、`compressorRegistry_*()`、`userAgent_*()` 当前证明默认值与显式覆盖同样都在 builder 状态里收口，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:285`。  
5. `ManagedChannelImplBuilderTest.authorityIsReadable_*()` 与 address compatibility 检查，当前证明 target/authority/transport address 约束在 build 前就已经稳定，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:347`。  
6. `ManagedChannelImplBuilderTest` 后续 effective interceptors / target-aware interceptor 工厂 / idleTimeout / URI parsing / NameResolver provider 选择相关测试，当前共同证明许多“运行时行为”其实在 builder 阶段就已参数化，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:544`、`:637`、`:817`、`:886`。  
7. `ServerImplBuilderTest` 当前提供服务端 builder 默认值、interceptor、fallback registry 与 builder 约束的托底证据。  

### 深审发现

1. **高风险：容易把 builder 写成 fluent API 外壳。** 当前正文已把重点压回“外部配置 -> 内部装配状态”。  
2. **高风险：容易把公共 Builder API 与 ImplBuilder 混成一层。** 当前正文已明确一个负责定义用户配置边界，一个负责翻译内部装配状态。  
3. **中风险：容易让 transport-specific builder 抢走 builder 层主线，或反过来把它们误判成可有可无的参数附录。** 当前正文已把它们定位成公共装配语义落到具体 transport 时的不可省略兑现分叉。  
4. **中风险：容易让 codegen 的 `bindService()` 与 builder 的 `addService()`、runtime 的 registry lookup 彼此断开。** 当前正文已补出 `ImplBase -> bindService() -> ServerServiceDefinition -> addService() -> registry -> ServerImpl lookup` 完整链。  
5. **中风险：容易让 service config / resolver / registry 等看上去像 build 之后才出现。** 当前正文已补 builder 阶段的参数化与路径限制。  
6. **低风险：容易顺手扩成 transport 参数清单或 Spring 自动配置文。** 当前正文边界收在 grpc-java 自身 builder 装配桥。  

## 第二轮：因果审

- 如果把 builder 只看成参数门面，就解释不了 resolver、registry、executor、service config、authority 等为什么会在 build 前决定后续运行时路径：✅  
- 公共 Builder API 之所以重要，是因为它定义了用户可表达的配置边界：✅  
- ImplBuilder 之所以重要，是因为它把这些外部表达压成 grpc-java 内部运行时装配状态：✅  
- build() 之所以不能只理解成对象创建，是因为它是在已累积好的装配状态上收口：✅  
- transport-specific builder 只是差异化补层，而不是 builder 层存在的全部意义：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> ManagedChannelBuilder -> ManagedChannelImplBuilder -> ServerBuilder/ServerImplBuilder -> transport-specific builder 位置 -> 收网”推进，没有退化成参数清单或 Javadoc 翻译。✅

失败方案已覆盖：
- builder 只是参数收集器  
- 公共 Builder API 与 ImplBuilder 没本质区别  
- transport-specific builder 才是真正主体  
- resolver/service config/registry 都是 runtime 自己后面发现的  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- 公共 Builder API 定义用户可配置边界  
- ImplBuilder 把外部配置压成内部装配状态  
- build() 在已有装配状态上收口成 runtime 对象  
- transport-specific builder 只是第二座装配桥上的差异化补层  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未顺手扩成 transport handler 参数大全。✅  
- 未把本篇写成 Spring 自动配置桥。✅  
- 未重讲 codegen 装配桥或前四篇 runtime 细节，只解释配置怎样注入这些主线。✅  
- 重点仍压在“外部配置如何进入 grpc-java 内部结构”的 builder 装配桥，边界收得住。✅

## 第六轮：依赖审

- 已直接承接 codegen 装配桥篇：解释 `*Grpc` 生成的 `bindService()` 如何继续经过 `ServerBuilder.addService()` 进入 registry/runtime，而不是只泛泛讨论用户配置。✅  
- 已自然承接前四篇 runtime 主线：builder 解释的是这些主线在运行前怎样被参数化。✅  
- transport-specific builder 已被定位为公共装配语义落到具体 transport 时的兑现分叉，而不是可有可无的附录。✅  
- `ManagedChannelImplBuilderTest` 与 `ServerImplBuilderTest` 足以支撑“builder 不是门面，而是装配中枢”的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验公共 Builder API、ImplBuilder 与 builder 测试。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `21,866`。  
- 目标定位：关键装配层篇，满足篇幅要求。✅

## 结论

当前三件套的目标明确：这一篇应把“外部配置 -> Builder API -> ImplBuilder 装配状态 -> runtime 对象”这条第二座装配桥立住，修复 codegen 骨架与真正 runtime 对象之间的配置装配断层。只要正文按这个 review 结论收口，它就能成为 grpc-java 完整卷里承上启下的关键结构篇。