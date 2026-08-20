# Ch13-03 大对象分块写出：ChunkedInput、ChunkedFile、ChunkedStream 与 HttpChunkedInput — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `ChunkedInput` 当前抽象了 `isEndOfInput`、`readChunk`、`length`、`progress`、`close` 这组“渐进取块”语义，证据：`handler/src/main/java/io/netty/handler/stream/ChunkedInput.java:22`。  
2. `readChunk(...)` 当前返回 `null` 不必然等于输入结束，接口文档明确指出下一块也可能只是暂时不可用，证据：`handler/src/main/java/io/netty/handler/stream/ChunkedInput.java:55`。  
3. `ChunkedFile` 当前基于 `RandomAccessFile` + heap buffer 按 offset/chunkSize 渐进取块，且文档明确提醒 zero-copy 场景可考虑 `FileRegion`，证据：`handler/src/main/java/io/netty/handler/stream/ChunkedFile.java:28`、`:136`。  
4. `ChunkedNioFile` 当前基于 `FileChannel` 按块写入 `ByteBuf`，并保持自己的 offset 语义，证据：`handler/src/main/java/io/netty/handler/stream/ChunkedNioFile.java:30`、`:140`。  
5. `ChunkedStream` 当前基于 `InputStream` / `PushbackInputStream`，长度未知时 `length()` 返回 -1，`isEndOfInput()` 通过 `available + unread` 探测结尾，证据：`handler/src/main/java/io/netty/handler/stream/ChunkedStream.java:27`、`:77`、`:139`。  
6. `HttpChunkedInput` 当前把 `ChunkedInput<ByteBuf>` 包成 `ChunkedInput<HttpContent>`，每块返回 `DefaultHttpContent`，结束时返回 `LastHttpContent`，证据：`codec-http/src/main/java/io/netty/handler/codec/http/HttpChunkedInput.java:23`、`:91`。  
7. `ChunkedWriteHandlerTest.testChunkedStream/NioStream/File/NioFile` 当前证明多种来源都能沿同一 chunked write 主线写出，证据：`handler/src/test/java/io/netty/handler/stream/ChunkedWriteHandlerTest.java:73`。  
8. `testListenerNotifiedWhenIsEnd` 当前证明输入结束后 listener 仍需被通知，证据：`handler/src/test/java/io/netty/handler/stream/ChunkedWriteHandlerTest.java:153`。  
9. `testWriteFailureChunked*`、`testSkipAfterFailed*`、`testFailureWhenLastChunkFailed` 当前共同覆盖首块失败、失败后跳过和最后 chunk 失败边界，证据：`handler/src/test/java/io/netty/handler/stream/ChunkedWriteHandlerTest.java:267`。

### 深审发现

1. **高风险：容易把 chunked write 和普通 `write(ByteBuf)` 视为同一对象来源模型。** 正文已明确 chunked write 的输入本体本来就是渐进展开的源。  
2. **中风险：容易把 `null` chunk 写成结束信号。** 正文已明确 `isEndOfInput()` 才是结束判断核心。  
3. **中风险：容易把 `HttpChunkedInput` 写成简单语法糖。** 正文已补 `LastHttpContent` 的结束语义。  
4. **低风险：容易把 `ChunkedFile/ChunkedNioFile` 写成总是优于 `FileRegion`。** 正文已保留 zero-copy 边界提醒。  
5. **低风险：容易忽略 listener / last chunk / 失败跳过边界。** 正文已用测试单独收束。

## 第二轮：因果审

- 普通 write 假设消息已成型 -> 大对象/未知长度输入不满足该前提 -> 需要 `ChunkedInput` 抽象：✅  
- `ChunkedFile/NioFile/Stream` 只是不同来源模型的具体实现，而不是三种完全不同写协议：✅  
- HTTP 场景需要 `HttpContent/LastHttpContent` 结束语义 -> `HttpChunkedInput` 再包一层：✅  
- `null` chunk 不等于结束 -> listener 完成和最后 chunk 失败边界必须单独处理：✅  
- chunked write 不是替代出站主线，而是替换“对象来源模型”这一起点：✅

## 第三轮：结构审

正文结构按“先拆对象来源模型 -> ChunkedInput 抽象 -> 文件/流三条来源线 -> null 与结束语义 -> HttpChunkedInput -> 测试回读 -> 与出站主线关系 -> 收网”推进，没有按源码类顺序平铺。✅

失败方案已覆盖：
- 把大对象写出看成多写几次 `ByteBuf`  
- 把 `null` chunk 当成结束本身  
- 把 `ChunkedFile/NioFile` 绝对化成优于 `FileRegion`  
- 把 HTTP chunked 结束和普通 ByteBuf 结束混淆  
- 忽略失败后 listener/后续 chunk 边界  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- `ChunkedInput` 是渐进输入源抽象，不是普通已成型消息  
- `ChunkedFile/NioFile/Stream` 的来源差异和结束语义差异  
- `HttpChunkedInput` 如何把通用 chunk 流翻译成 HTTP 语义  
- 为什么 chunked write 和普通 write 的根本差异在“对象来源模型”  
- 失败和监听器完成边界为什么重要  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开 `ChunkedWriteHandler` 全部调度细节，只通过测试消费其行为边界。✅  
- 未把 `FileRegion` 深入展开成 zero-copy 专题。✅  
- 未把 chunked write 与池化/普通 ByteBuf write 混成同一路径。✅

## 第六轮：依赖审

- 依赖 Ch7-05/06/08、Ch13-02 和 Ch4-06 前置，真实存在。✅  
- 依赖 Ch11 HTTP 只作 `HttpContent` 语义复用，没有越界。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 9,061。  
- 去掉常见 markdown 标记后的字符数：约 8,682。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立大对象分块写出的渐进输入源主线，并把 HTTP 场景、listener 完成和失败跳过边界接回了出站主线。本篇不承担 zero-copy / `FileRegion` 的深入对照；那部分留给后续专题。Ch13-03 可作为后续 zero-copy / FileRegion 对照、大文件下载和传输调优专题的直接前置篇。