# Ch13-03 大对象分块写出：ChunkedInput、ChunkedFile、ChunkedStream 与 HttpChunkedInput — rewrite-plan

## 篇章定位

- 核心困惑：前面已经讲了 writability、PendingWriteQueue、CoalescingBufferQueue、traffic shaping 和 timeout，但遇到大文件、大输入流、大响应体时，为什么 Netty 还要单独引入 `ChunkedInput`、`ChunkedFile`、`ChunkedNioFile`、`ChunkedStream` 和 `HttpChunkedInput` 这一整套？它们和普通 `ctx.write(ByteBuf)` 的区别到底在哪里？
- 一句话顿悟：普通 write 假设消息已经是一块完整可写的对象，而 `ChunkedInput` 这一支处理的是“数据本体本来就很大或长度未知，必须按块渐进取出和渐进写出”的场景；它把“大对象写出”重写成一连串可观测、可回压、可失败、可继续的 chunk 流程，再由 `ChunkedWriteHandler` 接到 Netty 的出站主线、promise 和失败回收语义上。
- 文章边界：本篇主讲 `ChunkedInput` 抽象、`ChunkedFile / ChunkedNioFile / ChunkedStream` 的差异、`HttpChunkedInput` 如何把 ByteBuf chunk 翻译成 `HttpContent`，以及大对象写出为何要和普通 message write 分开；不展开零拷贝 `FileRegion` 深入对比，只把它作为边界提醒。

## 依赖

### HARD

- Ch7-05 `ch7-pipeline/05-outbound-buffer-and-writability.md`：理解出站托管区和可写性。
- Ch7-06 `ch7-pipeline/06-write-flush-and-consolidation.md`：理解 write/flush 分离与推进边界。
- Ch7-08 `ch7-pipeline/08-pendingwrite-and-coalescing-queues.md`：理解辅助托管层、字节聚合和 promise 对齐。
- Ch13-02 `ch13-timeout/02-traffic-flow-logging.md`：理解连接治理与限速/节奏边界。
- Ch4-06 ownership：理解 chunk 读出/失败时 ByteBuf release 边界。

### SOFT

- Ch11 HTTP：只复用 `HttpContent` / `LastHttpContent` 语义。
- Ch8 memory pool：只复用“大对象与普通池化 buffer 是不同路径”的背景。

### NAV

- 后续：zero-copy `FileRegion` 与 chunked write 的取舍对照。
- 后续：HTTP 大文件下载与响应式/异步传输案例。

## 结构设计

### 1. 开场：为什么“大对象写出”不是再多写几个 ByteBuf
- 普通 message write 假设对象已经完整在手上。
- 大文件 / InputStream / 未知长度响应体不满足这个前提。
- 引出 chunked write 处理的是“渐进取数 + 渐进下放”语义。
- 预计 900-1200 字。

### 2. `ChunkedInput`：把“大对象”抽象成可逐块取出的流
- `isEndOfInput / readChunk / length / progress / close` 各自说明什么。
- `null` 不一定等于流已结束，可能只是当前时刻没有下一块可取。
- 预计 1500-1900 字。

### 3. 文件与流：`ChunkedFile`、`ChunkedNioFile`、`ChunkedStream`
- `ChunkedFile`：RandomAccessFile + heap buffer。
- `ChunkedNioFile`：FileChannel + ByteBuf 写入。
- `ChunkedStream`：InputStream / PushbackInputStream，长度未知时的读块逻辑。
- 为什么 `ChunkedFile/ChunkedNioFile` 文档都会提醒：若系统支持 zero-copy，优先考虑 `FileRegion`。
- 预计 2200-2800 字。

### 4. `HttpChunkedInput`：为什么 HTTP 场景还要再包一层
- 每个 ByteBuf chunk 包成 `HttpContent`。
- 结束时写出 `LastHttpContent`，而不是普通 `null` 结束。
- 解释它如何把 HTTP chunked transfer 语义挂到通用 `ChunkedInput<ByteBuf>` 之上。
- 预计 1400-1800 字。

### 5. 测试回读：ChunkedWriteHandlerTest 真正验证了哪些边界
- chunked stream / nio stream / file / nio file / unchunked data 都能通过同一主线。
- listener 在 `isEndOfInput` 后仍需被通知。
- first write fail / skip failed / last chunk fail 等测试说明失败边界和后续 chunk 跳过逻辑。
- 预计 1800-2400 字。

### 6. 收网：大对象写出和普通 write 的根本差异
- 普通 write：对象已成型，直接入托管区。
- chunked write：对象本体本来就是一个逐块展开的源，必须和出站主线渐进交接。
- 桥到 zero-copy / 大文件下载 / HTTP 响应体场景。
- 预计 700-1000 字。

## 证据清单

- `handler/src/main/java/io/netty/handler/stream/ChunkedInput.java:22-79`
- `handler/src/main/java/io/netty/handler/stream/ChunkedFile.java:28-169`
- `handler/src/main/java/io/netty/handler/stream/ChunkedNioFile.java:30-180`
- `handler/src/main/java/io/netty/handler/stream/ChunkedStream.java:27-147`
- `codec-http/src/main/java/io/netty/handler/codec/http/HttpChunkedInput.java:23-118`
- `handler/src/test/java/io/netty/handler/stream/ChunkedWriteHandlerTest.java:73-215`
- `handler/src/test/java/io/netty/handler/stream/ChunkedWriteHandlerTest.java:267-320`

## 误解清单

1. 大对象写出只是多写几次 `ByteBuf`，和普通 write 没本质区别。
2. `null` chunk 一定等于流已经结束。
3. `ChunkedFile` / `ChunkedNioFile` 一定优于 `FileRegion`。
4. `HttpChunkedInput` 只是语法糖，不改变 HTTP chunked transfer 的结束语义。
5. 失败时只要当前 chunk fail 就够了，后续 chunk 和 listener 不需要额外处理。

## 边界清单

- 本篇不展开 `ChunkedWriteHandler` 内部所有调度细节，只通过测试消费其行为边界。
- 本篇不把 `FileRegion` 深入展开成 zero-copy 专题，只保留对照边界。
- 本篇不把 chunked write 和池化/普通 ByteBuf write 混成同一路径，它们的对象来源模型不同。

## 深审预警

- [ ] 不把 `ChunkedInput` 写成“永远已知长度”的流。
- [ ] 不把 `null` chunk 写成结束信号本身。
- [ ] 不把 HTTP chunked ending 和普通 ByteBuf 结束混淆。
- [ ] 不把大对象分块写出写成性能结论，而要坚持结构与边界分析。