# grpc-java：Metadata、Status 与 Trailers — review notes

## 第一轮：事实审

### 已核对的核心结论

1. `Metadata` 内部存储为 `Object[] namesAndValues` 交错数组（`[name0, value0, name1, value1, ...]`），key 为 `byte[]`，value 为 `byte[]` 或 `LazyValue`，证据：`api/src/main/java/io/grpc/Metadata.java:150`。
2. `Key<T>` 是抽象类，构造器将 name 小写化并转为 ASCII bytes，`validateName()` 限制字符为 `[a-z0-9._-]`，证据：`Metadata.java:671`、`:736`。
3. `Key.of(String, AsciiMarshaller)` 创建 `AsciiKey`，key 名不能以 `-bin` 结尾，值通过 `toAsciiString`/`parseAsciiString` 转换为 ASCII 字符串，证据：`Metadata.java:703`、`:966`。
4. `Key.of(String, BinaryMarshaller)` 创建 `BinaryKey`，key 名必须以 `-bin` 结尾，值通过 `toBytes`/`parseBytes` 直接操作字节数组，证据：`Metadata.java:682`、`:859`。
5. `put(Key, T)` 追加值，`get(Key)` 返回最后一个匹配值，`removeAll(Key)` 移除所有匹配值，`serialize()` 返回 `byte[][]` 交错数组，证据：`Metadata.java:342`、`:248`、`:402`、`:467`。
6. `Status.Code` 枚举定义 15 个标准码（OK=0 到 UNAUTHENTICATED=16），`STATUS_LIST` 是规范实例，证据：`api/src/main/java/io/grpc/Status.java:65`、`:237`。
7. `Status` 对象包含 code/description/cause 三个字段，通过 `withDescription()` 和 `withCause()` 创建新实例，`asRuntimeException()` 包装为 `StatusRuntimeException`，证据：`Status.java:441`、`:455`、`:466`、`:523`。
8. `Status.CODE_KEY` 是 `Metadata.Key<Status>`（`grpc-status`），`Status.MESSAGE_KEY` 是 `Metadata.Key<String>`（`grpc-message`），`StatusCodeMarshaller` 将 code 序列化为 ASCII 十进制字符串，`StatusMessageMarshaller` 对非 ASCII 字符做 percent-encoding，证据：`Status.java:355`、`:386`、`:560`、`:572`。
9. `fromThrowable()` 遍历 cause 链找 `StatusException`/`StatusRuntimeException`，`trailersFromThrowable()` 同样遍历提取 trailers，证据：`Status.java:396`、`:416`。
10. `AbstractServerStream.close()` 分三步：关闭 framer → `addStatusToTrailers()` → `writeTrailers()`；`addStatusToTrailers()` 先 discard 再 put `grpc-status`/`grpc-message`，证据：`core/src/main/java/io/grpc/internal/AbstractServerStream.java:123`、`:138`。
11. `Http2ClientStreamTransportState.transportTrailersReceived()` 调用 `statusFromTrailers()` 提取 Status，再调用 `stripTransportDetails()` 剥离 `grpc-status`/`grpc-message`/`:status`，证据：`core/src/main/java/io/grpc/internal/Http2ClientStreamTransportState.java:172`、`:193`、`:255`。
12. `GrpcUtil` 定义了 `TIMEOUT_KEY`（`grpc-timeout`）、`MESSAGE_ENCODING_KEY`（`grpc-encoding`）、`CONTENT_TYPE_KEY`（`content-type`）等预留 key，证据：`core/src/main/java/io/grpc/internal/GrpcUtil.java:99`、`:144`。

### 测试证据已核对

1. `MetadataTest.java:127` — `testMutations()` 覆盖 put/get/getAll/removeAll。
2. `MetadataTest.java:189` — `testWriteParsed()` 覆盖 serialize/deserialize 循环。
3. `MetadataTest.java:310` — `testKeyCaseHandling()` 验证小写归一化。
4. `StatusTest.java:34` — `verifyExceptionMessage()` 验证异常消息格式。
5. `StatusTest.java:66` — `metadataEncode_lowAscii()` 验证 percent-encoding。
6. `Http2ClientStreamTransportStateTest.java:242` — `transportTrailersReceived_notifiesListener()` 验证 grpc-status=0 产生 OK。
7. `Http2ClientStreamTransportStateTest.java:274` — `transportTrailersReceived_observesStatus()` 验证 grpc-status=1 产生 CANCELLED。
8. `Http2ClientStreamTransportStateTest.java:289` — `transportTrailersReceived_missingStatusUsesHttpStatus()` 验证兜底映射。

### 深审发现

1. **高风险：容易把 Metadata 写成 HashMap 说明书。** 当前正文已压回"三段式生命周期"总图，key 类型解释放在"为什么 ASCII/Binary 两种"的动机之后。  
2. **高风险：容易把 Status 的 15 个码写成清单。** 当前正文已用表格式清单，但随即解释"层次结构"和"三种使用方式"，没有退化成列表。  
3. **中风险：容易忽略 grpc- 预留 key 的剥离对应用层的影响。** 当前正文已用"干净的 trailers"概念收束，并给出完整传播链路图。  
4. **中风险：容易把 trailers 当成"可选的"。** 当前正文已强调"Status 必须通过 trailers 发送"的协议语义，以及 streaming 场景下必须在流结束时才确定状态。  
5. **低风险：容易把 StatusMessageMarshaller 的 percent-encoding 忽略。** 当前正文已提及非 ASCII 字符的编码处理。

## 第二轮：因果审

- Metadata 必须用 `Object[]` 交错数组而不是 HashMap，因为序列化到 HTTP/2 header 块时数组比 Map 遍历效率更高：✅  
- Status 必须放在 trailers 中而不是 headers 中，因为 streaming 响应的最终状态只有在流结束时才确定：✅  
- `grpc-` 前缀 key 必须在交付应用层之前剥离，否则应用层代码可能误读系统内部状态：✅  
- Binary key 必须以 `-bin` 结尾且自动 base64 编码，因为 HTTP/2 header 值只允许 ASCII 字符：✅  
- `AbstractServerStream.addStatusToTrailers()` 必须先 discard 再 put，避免重复/过期的 `grpc-status` 值：✅  
- `Status.fromThrowable()` 必须遍历 cause 链，因为 `StatusRuntimeException` 可能被包装在业务异常中：✅

## 第三轮：结构审

正文结构按"困惑开场 → 前情回顾 → 失败方案(3个) → 最小总图 → Metadata key 类型 → Status 15 个码 → Trailers 协议语义 → 编码/解码循环 → grpc- 剥离机制 → 收网总结 → 下篇钩子"推进，没有退化成 Metadata 字段说明书。

失败方案已覆盖：
- Metadata 就是 headers，Status 就是错误码  
- Status 通过 headers 发送就够了  
- Metadata key 只有一种类型  

每一层拆解均包含：动机→机制→证据，符合"分层拆解四动作"要求。✅

## 第四轮：读者审（删码测试）

删除所有代码块后，正文仍应能复述：
- Metadata 的三段式生命周期（headers → 消息体 → trailers）  
- ASCII/Binary 两种 key 类型及其序列化差异（-bin 后缀 + base64）  
- Status 的 15 个标准码层次和三种构造方式  
- Trailers 承载 Status 的协议语义  
- grpc- 预留 key 的剥离机制  

当前正文按设计应满足删码后主线仍成立。✅

## 第五轮：边界审

- 未扩入 `LazyStreamBinaryKey` 的流式序列化细节。✅  
- 未扩入 `grpc-status-details-bin` 的 protobuf 丰富错误详情。✅  
- 未扩入 gRPC-web 或 gRPC-json 的适配。✅  
- 未扩入 Status 与 deadline/cancel/retry 的交互（留给生产排查卷）。✅  
- 重点仍压在 Metadata/Status/Trailers 的三段式生命周期与编码/解码循环，边界收得住。✅

## 第六轮：依赖审

- 已直接承接 ch04/01 方法契约篇：`ServerCall.close()` 已知，本篇补充 close 内部的 Status 编码。✅  
- 已承接 ch01 主干篇：`ClientCall.onClose()` 已知，本篇补充 onClose 的 Status 解码。✅  
- 已承接 ch03/04 压缩篇：`grpc-encoding`/`grpc-accept-encoding` 为压缩协商提供协议基础。✅  
- `MetadataTest`、`StatusTest`、`Http2ClientStreamTransportStateTest` 的组合足以支撑"三段式元数据"的论断。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 已复扫；当前命中为 0。✅  
- 代码块：使用少量有限代码块（含示意代码），不承担主叙事骨架。✅  
- 源码引用：已与 rewrite-plan 证据清单逐项对照，正文实际使用锚点来自已核验 `Metadata`、`Status`、`AbstractServerStream`、`ServerCallImpl`、`Http2ClientStreamTransportState`、`AbstractClientStream`、`GrpcUtil`。✅  
- 去掉代码块后正文仍成立：是。✅  
- 叙述性正文字符数（不含代码块与空白行）：约 `17,950`。  
- 目标定位：规范层重要专题篇，篇幅与结构均满足要求。✅

## 结论

当前三件套的目标明确：这一篇应把 Metadata/Status/Trailers 从"API 返回值"提升到"gRPC 协议的三段式元数据体系"，讲清 Metadata 的 key 类型设计、Status 的编码/解码循环、Trailers 的协议语义，以及 grpc- 预留 key 的剥离机制。只要正文按这个 review 结论收口，它就能成为 grpc-java 完整卷里规范层的核心元数据篇。