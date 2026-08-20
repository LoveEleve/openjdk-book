# Ch12-01 HTTP/2 codec rewrite plan

## 一句话困惑

HTTP/1.1 那两篇已经把“一个请求/响应如何沿 pipeline 流动”讲清楚了，但到了 gRPC、Dubbo Triple 这种跑在 HTTP/2 上的协议，问题突然变成：为什么一条 TCP 连接上能同时交错跑很多请求？这些 HEADERS/DATA/WINDOW_UPDATE 到底靠什么区分彼此、压缩头、控制反压？

## 一句话顿悟

HTTP/2 的核心不是把 HTTP/1.1 文本语法换成二进制，而是把“连接”与“请求”拆成两层：连接上只流动带 `streamId` 的帧，真正的请求/响应语义挂在 Stream 上；帧 reader 负责解析 9 字节头，连接对象负责维护 Stream 生命周期，HPACK 负责连接级头压缩，流控负责连接级+流级双层反压。

## 本篇范围

- 主讲 HTTP/2 帧头、10 种标准帧类型与 `DefaultHttp2FrameReader` 的解析主线。
- 主讲 `DefaultHttp2Connection` 如何维护 streamId、奇偶归属、状态迁移与 GOAWAY 影响。
- 主讲 HPACK 静态表 + 动态表 + Huffman 的连接级压缩模型。
- 主讲本地/远端流控器的双窗口设计与 `WINDOW_UPDATE` 触发。
- 建立到 gRPC / Dubbo Triple 的桥接，不展开 gRPC 源码细节。

## 依赖声明

```text
本篇
├── HARD 前置：ch11-http/01-codec-pipeline.md
├── HARD 前置：ch11-http/02-aggregation-compression.md
├── HARD 前置：ch10-codec/02-encoders-and-framedecoders.md
├── HARD 前置：ch7-pipeline/01-pipeline-structure.md
├── SOFT 前置：ch14-timer/01-hashedwheeltimer.md（仅作“状态拥有者”设计思路延续）
├── NAV 后续：gRPC / Dubbo Triple 源码分析
└── COMPARE：HTTP/1.1 文本报文 / HTTP/3 QUIC（只做边界对照）
```

## 结构设计

### 1. 开场：HTTP/1.1 的问题不是“文本慢”，而是连接与请求绑死了
- 回收 HTTP/1.1：一个连接上一条请求/响应序列，队头阻塞、并发连接受限。
- 引出 HTTP/2：一条连接上交错跑多个 stream。
- 预计 900-1200 字。

### 2. 失败方案：如果只把 HTTP/1.1 报文改成二进制，还解决不了什么
- 失败方案 A：只把文本首行/headers 换成二进制字段。
- 失败方案 B：一条连接还是一次只服务一个请求。
- 失败方案 C：只做连接级窗口，不做每 stream 窗口。
- 预计 1500-1900 字。

### 3. 二进制帧总图：9 字节头 + 10 种类型，streamId 才是多路复用的最小路由键
- 讲 3B length + 1B type + 1B flags + 4B streamId。
- `DefaultHttp2FrameReader.readFrame -> preProcessFrame -> verifyFrameState -> processPayloadState`。
- 回答完整性问题 #1/#5/#10。
- 预计 1800-2300 字。

### 4. Stream 多路复用：一条连接上为什么能交错跑很多请求
- `DefaultHttp2Connection`、`DefaultStream`、activeStreams。
- streamId 奇偶归属：客户端奇数、服务端偶数；0 保留给连接控制。
- `createStream`、half-closed、RST_STREAM、GOAWAY。
- 回答完整性问题 #2/#6/#11。
- 预计 2200-2800 字。

### 5. HPACK：61 项静态表 + 连接级动态表，不是在“压字符串”，而是在复用头上下文
- `HpackStaticTable` 关键索引：`:method`、`:path`、`:status`。
- `HpackEncoder.encodeHeader` 的命中路径：动态表 -> 静态表 -> literal。
- `HpackDecoder.decodeDynamicTableSizeUpdates/decode` 状态机。
- 动态表连接级共享的收益与风险。
- 回答完整性问题 #3/#7。
- 预计 2200-2800 字。

### 6. 双层流控：连接窗口 + 流窗口为什么缺一不可
- `DefaultHttp2LocalFlowController.consumeBytes`。
- `windowUpdateRatio=0.5`，消费过半才发 `WINDOW_UPDATE`。
- `DefaultHttp2RemoteFlowController.isWritable = connection writable && stream writable`。
- 连接级防总量失控，流级防单流独占。
- 回答完整性问题 #4/#8。
- 预计 2200-2800 字。

### 7. 误解澄清
- HTTP/2 没有完全消除队头阻塞，只消除应用层 HOL，TCP 层仍在。
- 二进制更快不只是“机器爱数字”，而是状态机和定长头更容易解析。
- HPACK 动态表不是每 stream 各自一份，而是连接共享。
- gRPC 不是“跳过 HTTP/2”，而是把 RPC 语义映射到 HEADERS/DATA/END_STREAM。
- 预计 1000-1400 字。

### 8. 收网与跨框架桥接
- 总结：帧层、stream 层、header 压缩层、流控层。
- 桥到 gRPC / Triple：HEADERS 承载元数据，DATA 承载 payload，流控/多路复用提供传输地基。
- 预计 600-800 字。

## 证据清单

- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameTypes.java:21`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:147`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:188`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:207`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:246`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:427`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2FrameReader.java:525`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:63`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:381`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:694`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:731`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:761`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2Connection.java:776`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/HpackStaticTable.java:52`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/HpackEncoder.java:119`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/HpackEncoder.java:161`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/HpackDecoder.java:126`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2LocalFlowController.java:47`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2LocalFlowController.java:176`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2RemoteFlowController.java:170`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/DefaultHttp2RemoteFlowController.java:606`

## 误解清单

1. HTTP/2 只是把 HTTP/1.1 报文改成二进制，所以主要收益只是解析快一点。
2. streamId 只是编号，不真正参与帧路由和状态隔离。
3. 客户端和服务端都可以随便申请下一个 streamId。
4. HPACK 动态表是每个 Stream 自己维护的。
5. 只做连接级窗口也能避免单条慢流拖垮整个连接。
6. HTTP/2 已经彻底消除了所有队头阻塞。

## 边界清单

- 本篇不展开 `Http2FrameCodec` / `Http2MultiplexHandler` 的 pipeline API 细节，只以连接/帧/流模型为主。
- 本篇不展开 gRPC `GrpcHttp2ConnectionHandler` 源码，只建立传输语义桥。
- 本篇不深入 HTTP/3/QUIC，只把 TCP 层队头阻塞作为边界提醒。
- 本篇不做 HPACK 安全攻击专题，只说明连接级动态表共享的风险与压缩上下文后果。