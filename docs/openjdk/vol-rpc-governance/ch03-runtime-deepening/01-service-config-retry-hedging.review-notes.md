# grpc-java：Service Config、Retry 与 Hedging — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `ManagedChannelServiceConfig` 当前不是原始配置表，而是 service config 的 fully parsed and validated runtime representation，证据：`core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:39`。  
2. `ManagedChannelServiceConfig` 当前将 method config 拆成 default/service/method 三层匹配，并支持 health checking、retry throttling、lb config 等通道级补充信息，证据：`core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:45`、`:89`、`:121`、`:180`。  
3. `MethodInfo` 当前是每次调用真正命中的即时策略对象，持有 timeout、waitForReady、message size、retryPolicy、hedgingPolicy，证据：`core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:248`。  
4. `MethodInfo` 当前会在构造时解析 `retryPolicy` 与 `hedgingPolicy`，并应用 builder 给出的 `maxRetryAttemptsLimit` / `maxHedgedAttemptsLimit`，证据：`core/src/main/java/io/grpc/internal/ManagedChannelServiceConfig.java:285`、`:333`、`:380`。  
5. `ManagedChannelImplBuilder` 当前直接持有 retry/hedging 的关键 builder 级边界：`maxRetryAttempts`、`maxHedgedAttempts`、`retryBufferSize`、`perRpcBufferLimit`、`retryEnabled`、`defaultServiceConfig`、`lookUpServiceConfig`，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImplBuilder.java:191`、`:201`、`:539`、`:551`、`:566`、`:596`。  
6. `ManagedChannelImpl.ChannelStreamProvider` 当前会根据 `retryEnabled` 与 `MethodInfo` 中的 `RetryPolicy` / `HedgingPolicy`，决定是走普通 delayed transport 还是创建 `RetriableStream`，证据：`core/src/main/java/io/grpc/internal/ManagedChannelImpl.java:461`、`:483`。  
7. `RetriableStream` 当前不是若干 stream 列表，而是一条逻辑 `ClientStream`，内部维护 state、in-flight attempts、scheduled retry/hedging、buffer 预算与 throttle，证据：`core/src/main/java/io/grpc/internal/RetriableStream.java:54`、`:88`、`:127`。  
8. `RetriableStream.commit()` 当前负责选出 winningSubstream、取消其他 substream、取消计划任务、回收 buffer，并统一后续收口，证据：`core/src/main/java/io/grpc/internal/RetriableStream.java:155`。  
9. `RetriableStream.createSubstream()` / `updateHeaders()` 当前说明每次尝试会更新 `grpc-previous-rpc-attempts` 等元数据，而不是完全匿名的 transport 重试，证据：`core/src/main/java/io/grpc/internal/RetriableStream.java:251`、`:286`。  
10. retry 与 hedging 在 `RetriableStream` 中当前被明确区分：二者不能同时提供 policy，且后续状态机推进不同，证据：`core/src/main/java/io/grpc/internal/RetriableStream.java:127`。

### 测试证据已核对

1. `ManagedChannelServiceConfigTest` 当前覆盖 retry policy 解析、retry disabled、空 retryableStatusCodes 边界与 MethodInfo 命中，证据：`core/src/test/java/io/grpc/internal/ManagedChannelServiceConfigTest.java:148`、`:211`。  
2. `HedgingPolicyTest` 当前覆盖 hedging policy 解析与 enable/disable 边界，证据：`core/src/test/java/io/grpc/internal/HedgingPolicyTest.java:42`。  
3. `ManagedChannelImplBuilderTest` 当前覆盖 maxRetryAttempts、maxHedgedAttempts、retryBufferSize、perRpcBufferLimit、defaultServiceConfig、disableServiceConfigLookUp 等 builder 语义，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplBuilderTest.java:663`、`:720`。  
4. `ManagedChannelImplTest.retryBackoffThenChannelShutdown_retryShouldStillHappen_newCallShouldFail()` 当前证明 retry/backoff、shutdown 与新调用失败的交互，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3396`。  
5. `ManagedChannelImplTest.hedgingScheduledThenChannelShutdown_hedgeShouldStillHappen_newCallShouldFail()` 当前证明 hedging delay、shutdown 与后续尝试交互，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3512`。  
6. `ManagedChannelImplTest.badServiceConfigIsRecoverable()` 当前证明 bad service config 不是不可恢复全局崩溃，证据：`core/src/test/java/io/grpc/internal/ManagedChannelImplTest.java:3617`。  
7. `RetriableStreamTest` 当前覆盖 throttle、normal retry、hedging、多 substream 语义、buffer 限制等，证据：`core/src/test/java/io/grpc/internal/RetriableStreamTest.java:1619`、`:1903`、`:2042`、`:2724`。

### 深审发现

1. **高风险：容易把 retry/hedging 写成 transport 失败后的“小技巧”。** 当前正文已提升到 service config + builder 限额 + 逻辑流状态机。  
2. **高风险：容易把 service config 写成配置表。** 当前正文已压回 `ManagedChannelServiceConfig` / `MethodInfo` 这套 runtime 模型。  
3. **中风险：容易把 retry 和 hedging 的差异讲成串行/并行。** 当前正文已补出启动条件、状态、收口和预算差异。  
4. **中风险：容易把 budget/throttle 当性能附属件。** 当前正文已强调它们会直接改变逻辑流能否继续演化。  
5. **低风险：容易把本文写成 JSON 配置手册。** 当前正文边界收在“策略如何进入逻辑流”。

## 第二轮：因果审

- retry/hedging 如果没有前置配置和 builder 限额约束，就会退化成 transport 里的临时补救动作：✅  
- service config 必须先被压成 `ManagedChannelServiceConfig` / `MethodInfo`，否则每次调用都无法稳定命中具体策略：✅  
- `ChannelStreamProvider` 必须在流创建前决定是否进入 `RetriableStream`，否则上层 config/CallOptions/Context 无法参与策略裁决：✅  
- `RetriableStream` 必须统一管理 commit、drain、pushback、throttle 和 buffer 预算，否则多 substream 会失控：✅  
- retry 和 hedging 的真正差别不仅是串行/并行，而是启动条件与状态机结构都不同：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> ManagedChannelServiceConfig/MethodInfo -> builder 限额 -> ChannelStreamProvider -> RetriableStream -> retry vs hedging -> 收网”推进，没有退化成配置清单。✅

失败方案已覆盖：
- transport 失败后临时再试一次  
- service config 只是配置表  
- retry 和 hedging 只是串行/并行差异  
- buffer / throttle 只是优化附属件  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- service config 怎样变成 `MethodInfo`  
- builder 限额怎样影响 retry/hedging 行为  
- `ChannelStreamProvider` 怎样把调用导向 `RetriableStream`  
- `RetriableStream` 怎样统一承载 commit / retry / hedging / throttle / budget  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未扩成 xDS 全景或生产排障大全。✅  
- 未重讲基础 resolver/LB 主线。✅  
- 未把 `RetriableStream` 写成单纯子流列表。✅  
- 重点仍压在 service config、builder 限额与逻辑流状态机的桥接关系，边界收得住。✅

## 第六轮：依赖审

- 已直接承接第四篇发现/选址桥与 builder 装配层：说明 config 和 budget 怎样真正进入流状态机。✅  
- `ManagedChannelServiceConfigTest`、`ManagedChannelImplBuilderTest`、`ManagedChannelImplTest`、`RetriableStreamTest` 的组合足以支撑“配置/限额/逻辑流”三层桥接的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 `ManagedChannelServiceConfig`、builder、`ChannelStreamProvider` 与 `RetriableStream`。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `23,254`。  
- 目标定位：关键运行时补深篇，满足篇幅要求。✅

## 结论

当前三件套的目标明确：这一篇应把 `service config -> MethodInfo -> ChannelStreamProvider -> RetriableStream` 这条机制主线立住，解释 retry/hedging 为什么不是 transport 小技巧，而是配置、限额和逻辑流状态机共同决定的运行时结果。