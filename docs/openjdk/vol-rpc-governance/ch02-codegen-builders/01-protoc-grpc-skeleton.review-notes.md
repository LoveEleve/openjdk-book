# grpc-java：protoc 代码生成与 `*Grpc` 骨架 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. grpc-java 官方 README 当前明确把“Generated Code”单独列为核心入口，并要求通过 `protoc-gen-grpc-java` 与 protobuf 插件生成服务骨架，证据：`README.md:99`。  
2. grpc-java 官方 README 当前把整库高层结构分成 `Stub / Channel / Transport` 三层，而 codegen 插件正是把 `.proto` 契约接入 Stub 层的官方入口，证据：`README.md:232`。  
3. `compiler/README.md` 当前明确说明 `protoc-gen-grpc-java` 会把 `.proto` 服务定义生成为 Java 接口/骨架，并给出 full/lite 两条输出路径，证据：`compiler/README.md:1`、`:37`。  
4. full golden 产物 `TestServiceGrpc` 当前会先生成静态 `MethodDescriptor`，并把 `MethodType`、full method name、marshaller、schema descriptor 等契约信息固定下来，证据：`compiler/src/test/golden/TestService.java.txt:14`、`:20`。  
5. full golden 产物当前会生成 async/blocking/future 等多类 stub 工厂入口，证据：`compiler/src/test/golden/TestService.java.txt:274`。  
6. full golden 产物当前还会生成 `AsyncService` 及默认 `asyncUnimplemented*` 行为，为服务端未实现方法提供统一协议兜底，证据：`compiler/src/test/golden/TestService.java.txt:335`。  
7. lite golden 产物当前与 full 产物在骨架结构上相似，但 marshaller 已切换成 `ProtoLiteUtils.marshaller(...)`，证据：`compiler/src/testLite/golden/TestService.java.txt:11`、`:37`。  
8. 真实生成产物 `interop-testing/.../TestServiceGrpc.java` 当前同样包含 `MethodDescriptor`、stub 工厂、`AsyncService`、`ImplBase`、`MethodHandlers`、`bindService()`，说明这些结构不是测试专用样板，而是正式生成骨架，证据：`interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:12`。  
9. 真实生成产物当前会生成 stub 工厂族，说明不同调用风格入口是 codegen 层先分化出来的，证据：`interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:267`。  
10. 真实生成产物当前会生成 `AsyncService` 默认实现和 `ImplBase implements BindableService, AsyncService`，说明服务端入口桥也在 codegen 层固定下来，证据：`interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:332`。  
11. 真实生成产物当前通过 `MethodHandlers` 和 `bindService()` 把方法 descriptor 与服务端 dispatch glue 到 `ServerServiceDefinition`，证据：`interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:917`、`:999`。  
12. 生成骨架中的 `ProtoUtils.marshaller(...)` / `ProtoLiteUtils.marshaller(...)` 已经说明 full/lite 差异不只是依赖名，而是对象到消息桥接路径本身不同，证据：`compiler/src/test/golden/TestService.java.txt:40`、`compiler/src/testLite/golden/TestService.java.txt:37`。

### 测试证据已核对

1. `compiler/src/test/golden/TestService.java.txt` 当前是 full protobuf codegen 黄金样本，覆盖 descriptor、stub、`AsyncService`、`MethodHandlers`、`bindService()`。  
2. `compiler/src/testLite/golden/TestService.java.txt` 当前是 lite protobuf codegen 黄金样本，证明骨架结构保留但 marshaller 桥切换。  
3. `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:267` 当前证明 stub 工厂骨架在真实生成产物中成立。  
4. `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:332` 当前证明 `AsyncService` 默认未实现行为在真实生成产物中成立。  
5. `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:917` 当前证明 `MethodHandlers` 如何把方法号映射到具体调用形态。  
6. `interop-testing/src/generated/main/grpc/io/grpc/testing/integration/TestServiceGrpc.java:999` 当前证明 `bindService()` 如何把所有方法组装成 `ServerServiceDefinition`。

### 深审发现

1. **高风险：容易把 `*Grpc` 文件整体当成样板噪音跳过。** 当前正文已把它提升为“用户契约进入 runtime 的装配桥”。  
2. **高风险：容易把生成代码理解成 API 皮肤，不承载运行时语义。** 当前正文已压回 `MethodDescriptor`、marshaller、`MethodHandlers`、`bindService()`。  
3. **中风险：容易把 `interop-testing` 中的真实生成样本误听成“业务项目标准目录”或“grpc-java 运行时手写核心类”。** 当前正文已补清楚它作为仓库内真实 codegen 样本的边界。  
4. **中风险：容易把服务端生成层理解成“方便继承 `ImplBase`”。** 当前正文已补 `AsyncService`、默认未实现行为与 `bindService()` 桥。  
5. **中风险：容易忽略 lite/full 差异，把它们只当依赖名区别。** 当前正文已指出 marshaller 骨架已不同。  
6. **低风险：容易顺手扩成 builder 装配层或 protobuf 内部实现专题。** 当前正文边界仍收在 codegen 装配桥。

## 第二轮：因果审

- 如果跳过 codegen 层，前四篇 runtime 主线和用户真实入口 `*Grpc`/`ImplBase` 之间会出现断桥：✅  
- `MethodDescriptor` 之所以必须先稳定下来，是因为 unary/streaming、full method name、marshaller、safe/idempotent 等契约都要先被固定：✅  
- 三类 stub 之所以在 codegen 层先生成，是为了让用户入口先类型化分化，再由 runtime 统一收束回 `ClientCall`：✅  
- `AsyncService` / `ImplBase` / `MethodHandlers` / `bindService()` 的组合之所以重要，是因为它们共同把应用实现精确接回 `ServerCalls` 主线：✅  
- 这一篇真正闭合的是“用户契约 -> 主干运行时”的桥，而不是整个 grpc-java 全部运行时链条；后者还要继续接第三、第四篇：✅  
- lite/full 差异之所以值得单独点出，是因为消息对象桥已经在 codegen 层发生分叉：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> MethodDescriptor -> Stub 工厂 -> AsyncService/ImplBase -> MethodHandlers/bindService -> lite/full 差异 -> 收网”推进，没有退化成 generated file 字段罗列。✅

失败方案已覆盖：
- 生成代码只是样板可以整体跳过  
- `*Grpc` 只是 API 皮肤  
- 服务端生成代码只是方便继承 `ImplBase`  
- 三类 stub 是 runtime 临时长出来的  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `.proto` 不直接变成 runtime，而先变成 `*Grpc` 骨架  
- `MethodDescriptor` 是 codegen 层先固定下来的契约地基  
- Stub 工厂是客户端入口桥  
- `AsyncService` / `ImplBase` / `MethodHandlers` / `bindService()` 是服务端入口桥  
- lite/full 差异在 marshaller 骨架上就已经出现  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未顺手扩成 `ManagedChannelBuilder` / `ServerBuilder` 装配层。✅  
- 未把 protobuf runtime 内部实现全吞进来。✅  
- 未展开 Spring / Boot / Cloud 集成层。✅  
- 重点仍压在“契约怎样被装进 runtime 主线”的 codegen 桥，边界收得住。✅

## 第六轮：依赖审

- 已自然承接第一篇客户端调用主线：解释 stub 入口从何而来。✅  
- 已自然承接第二篇服务端调用主线：解释 `ImplBase` / `bindService()` 怎样接回 `ServerCalls`。✅  
- 以整卷顺序看，这篇补的是“用户契约 -> 主干运行时”的装配桥：它既不是只服务客户端篇，也不是只服务服务端篇，而是把前四篇 runtime 主线整体向上接到了 `.proto` 入口。✅  
- `README`、`compiler/README`、golden 样本与真实生成产物的组合，足以支撑“codegen 不是噪音，而是装配桥”的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 README、golden 样本与真实生成产物。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `24,002`。  
- 目标定位：重要装配桥篇，满足篇幅要求。✅

## 结论

当前三件套的目标明确：这一篇应把 `.proto -> *Grpc -> runtime 主线` 这条装配桥立住，修复前四篇运行时主线与用户真实入口之间的断桥。只要正文按这个 review 结论收口，它就能成为 grpc-java 从“主干卷”走向“完整卷”的第一篇关键补层。