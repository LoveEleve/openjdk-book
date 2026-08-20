# grpc-java：Marshaller、ProtoUtils 与消息对象桥 — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `MethodDescriptor` 当前定义的是远程方法描述，并持有 request/response marshaller，证据：`api/src/main/java/io/grpc/MethodDescriptor.java:29`、`:40`。  
2. `Marshaller` 当前只定义对象到 `InputStream` 的 `stream()` 与 `InputStream` 到对象的 `parse()`，证据：`api/src/main/java/io/grpc/MethodDescriptor.java:130`、`:139`、`:148`、`:157`。  
3. `MethodDescriptor` 当前通过 `streamRequest/parseRequest/streamResponse/parseResponse` 把 request/response 对象桥接到 marshaller，证据：`api/src/main/java/io/grpc/MethodDescriptor.java:283`、`:295`、`:306`、`:318`。  
4. `ProtoUtils` 当前提供 protobuf message 的 marshaller 与 metadata marshaller 适配入口，证据：`protobuf/src/main/java/io/grpc/protobuf/ProtoUtils.java:25`、`:45`、`:54`。  
5. `ProtoLiteUtils` 当前基于 `MessageLite`/`Parser` 创建 `MessageMarshaller`，并在 `stream/parse` 中完成对象与输入流转换，证据：`protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:39`、`:80`、`:133`、`:162`、`:167`。  
6. `ProtoLiteUtils.MessageMarshaller.parse()` 当前包含同 parser `ProtoInputStream` 的对象复用优化、KnownLength 读取、ThreadLocal 弱引用 buffer、size limit/recursion limit 与 protobuf parse failure 映射，证据：`protobuf-lite/src/main/java/io/grpc/protobuf/lite/ProtoLiteUtils.java:167`、`:191`、`:197`、`:227`、`:235`。  
7. `MessageFramer` 当前负责把 gRPC message 编码成 transport sink 可交付的 frame，证据：`core/src/main/java/io/grpc/internal/MessageFramer.java:41`、`:53`。  
8. `MessageFramer` 当前使用 5 字节 header，其中 1 字节压缩标志、4 字节长度，证据：`core/src/main/java/io/grpc/internal/MessageFramer.java:70`、`:216`、`:246`。  
9. `MessageFramer.writePayload()` 当前负责压缩选择、KnownLength/未知长度路径、outbound size limit、stats 与 framing failure，证据：`core/src/main/java/io/grpc/internal/MessageFramer.java:133`、`:184`、`:237`。  
10. `MessageFramer` 当前区分 `flush()`、`close()`、`dispose()`，并在 close/dispose 路径处理 buffer 生命周期，证据：`core/src/main/java/io/grpc/internal/MessageFramer.java:304`、`:323`、`:340`。  
11. `MessageDeframer` 当前是非线程安全的 gRPC frame deframer，默认方法应在 deframing thread 调用，证据：`core/src/main/java/io/grpc/internal/MessageDeframer.java:36`、`:43`。  
12. `MessageDeframer` 当前维护 HEADER/BODY 状态、5 字节 header、compressed flag、requiredLength、pendingDeliveries、partial buffers，证据：`core/src/main/java/io/grpc/internal/MessageDeframer.java:43`、`:85`、`:89`、`:97`、`:102`。  
13. `MessageDeframer.request(numMessages)` 当前决定 pending delivery quota，`deliver()` 根据 quota 和可用数据推进消息交付，证据：`core/src/main/java/io/grpc/internal/MessageDeframer.java:156`、`:257`。  
14. `MessageDeframer` 当前支持 per-message/full-stream decompression、max inbound message size、partial message close 与 stop delivery，证据：`core/src/main/java/io/grpc/internal/MessageDeframer.java:110`、`:141`、`:147`、`:198`、`:212`。  
15. `MethodDescriptor.streamRequest()` 当前要求返回的 InputStream 由调用方关闭，说明对象桥包含明确的资源所有权边界，证据：`api/src/main/java/io/grpc/MethodDescriptor.java:287`。

### 测试证据已核对

1. `MessageFramerTest` 当前覆盖 framer 基本 framing 路径，证据：`core/src/test/java/io/grpc/internal/MessageFramerTest.java:50`。  
2. `MessageDeframerTest` 当前覆盖 deframer 基本状态机、压缩与 size enforcing 路径，证据：`core/src/test/java/io/grpc/internal/MessageDeframerTest.java:70`、`:301`、`:345`。  
3. `AbstractTransportTest` 当前覆盖 client message 写出后在对端解析、server response 写出后在对端解析、大消息与多消息 framing/deframing，证据：`core/src/testFixtures/java/io/grpc/internal/AbstractTransportTest.java:866`、`:912`、`:1382`、`:1573`。  
4. `ServerCallImplTest` 当前证明服务端 listener 通过 `MethodDescriptor` marshaller 解析请求对象，证据：`core/src/test/java/io/grpc/internal/ServerCallImplTest.java:462`。

### 深审发现

1. **高风险：容易把 `sendMessage()` 写成对象直接进入 transport。** 当前正文已明确对象、framing、HTTP/2 承载三层边界。  
2. **高风险：容易把 Marshaller 写成网络协议全集。** 当前正文已收敛到 `stream/parse` 两个类型化边界。  
3. **高风险：容易把 gRPC message frame 和 HTTP/2 frame 混成一层。** 当前正文已明确 5 字节 gRPC message header 与 HTTP/2 transport 的层次差异。  
4. **中风险：容易把 MessageFramer 简化成长度头工具。** 当前正文已补压缩、buffer、flush、大小限制与 close/dispose。  
5. **中风险：容易把 MessageDeframer 简化成 while 读取循环。** 当前正文已补 HEADER/BODY、request quota、partial message、解压与回收。  
6. **中风险：容易漏掉对象桥的资源所有权。** 当前正文已补 InputStream、WritableBuffer、ReadableBuffer 的关闭/释放边界。  
7. **中风险：容易把性能接口职责讲混。** 当前正文已把 `KnownLength` / `Drainable` 收紧为“流特征由 marshaller 产出、由 framer 识别利用”的协作边界。  
8. **中风险：容易把入站失败全部扔给 deframer。** 当前正文已补清 deframer、size enforcing input stream 与 marshaller parse 的跨层收口。

## 第二轮：因果审

- Java 对象不能直接进入 transport，因为 transport 不应依赖对象类型和 protobuf parser：✅  
- Marshaller 必须独立于 framing，因为对象转换与消息边界是两类问题：✅  
- `KnownLength` / `Drainable` 这类性能能力必须区分“由消息流暴露”与“由 framer 利用”，否则对象桥和 framing 层会重新耦合：✅  
- MessageFramer 必须独立于 HTTP/2 transport，因为 gRPC message frame 与 HTTP/2 frame 不同层：✅  
- MessageDeframer 必须维护 request quota，因为消息交付受到应用请求额度与流控语义约束：✅  
- 入站失败不能被粗暴归为 deframer 一层，必须区分 frame 成立、size enforcing、marshaller parse 三段收口：✅  
- 失败与回收必须在对象转换、framing、deframing、transport 各层分别收口：✅

## 第三轮：结构审

正文结构按“困惑 -> 失败方案 -> 最小总图 -> Marshaller -> ProtoUtils/ProtoLiteUtils -> MessageFramer -> MessageDeframer -> 失败/所有权 -> 收网”推进，没有退化成 protobuf API 词典。✅

失败方案已覆盖：
- `sendMessage()` 直接把对象交给 transport  
- Marshaller 负责全部网络协议  
- MessageFramer 只是长度头工具  
- Deframer 收到字节就无限解析  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- Marshaller 是对象/InputStream 边界  
- ProtoUtils/ProtoLiteUtils 是 protobuf 适配桥  
- MessageFramer 是 gRPC message frame 出站状态机  
- MessageDeframer 是按需交付的入站状态机  
- HTTP/2 transport 只是承载已成立的 gRPC message frame  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开 protobuf compiler 内部。✅  
- 未把 HTTP/2 frame 与 gRPC message frame 混讲。✅  
- 未展开 compression registry 全量配置专题。✅  
- 未把 InProcess 所有优化细节吞进本篇。✅  
- 重点仍压在对象、framing、deframing 与 transport 的分层桥接，边界收得住。✅

## 第六轮：依赖审

- 已直接承接 codegen 篇：解释生成骨架里的 marshaller 怎样真正进入消息运行时。✅  
- 已承接第一/二篇：解释 `ClientCall` / `ServerCall` 的对象怎样进入 stream 和 message framing。✅  
- `MessageFramerTest`、`MessageDeframerTest`、transport fixtures 的组合足以强力支撑对象桥的正常路径、frame/deframe 边界和大消息场景；而资源回收与 marshaller 失败路径更多仍依赖实现代码本身的职责分析来收口，当前证据链已够正文成立，但这部分测试支撑力度弱于正常路径。⚠️

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：仅使用文字图代码块，不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 API、protobuf bridge、framer/deframer 与 transport 测试。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数：约 `24,662`。  
- 目标定位：重要消息对象与 framing 补深篇，满足篇幅要求。✅

## 结论

当前三件套的目标明确：这一篇应把 `Java object -> Marshaller -> gRPC message frame -> transport -> Deframer -> Java object` 这条消息对象桥立住，补上 codegen、客户端/服务端主线与实际 wire framing 之间的机制断层。只要正文按这个 review 结论收口，它就能成为后续 compression、InProcess 与生产消息超限专题的稳定基础。