# Ch12-02 HTTP/2 Netty API 层：FrameCodec 与 Multiplex rewrite plan

## 一句话困惑

前一篇已经把 HTTP/2 的 frame、stream、HPACK、流控地基讲清楚了，但真正回到 Netty 写业务时，读者会立刻卡在另一个问题上：这些底层概念怎么突然变成了 `Http2Frame`、`Http2FrameStream`、`Http2StreamChannel` 这些对象？为什么一条 TCP 连接里的多个 stream，在 Netty 里竟然可以看起来像多个 child channel？

## 一句话顿悟

Netty 在 HTTP/2 API 层做的核心翻译，不是“再包一层对象”，而是把一条连接上的 frame/stream 状态机，改写成开发者更容易接入的 pipeline 语义：`Http2FrameCodec` 负责把 wire frame 映射成 `Http2Frame` 对象，并把每个 stream 绑定到一个 `Http2FrameStream`；`Http2MultiplexHandler` 再把这个 stream 进一步投影成 child channel，让每个 stream 像独立 Channel 一样收发帧、观察活跃状态、感知可写性和处理异常。

## 本篇范围

- 主讲 `Http2FrameCodec` 如何把 inbound/outbound HTTP/2 帧转成 `Http2Frame` / `Http2StreamFrame`。
- 主讲 `Http2FrameStream` 如何充当 stream 生命周期在 API 层的句柄。
- 主讲 `Http2MultiplexHandler` 如何为每个 stream 创建 child channel，并把 frame / user event / writability 投射进去。
- 主讲 `Http2StreamChannelBootstrap` 如何在已有 HTTP/2 连接上主动开出 outbound stream channel。
- 主讲 reference counting、child channel 活跃时机、stream 关闭与 GOAWAY/RESET 事件在 API 层的含义。
- 不展开 encoder/decoder 连接主链实现细节；不展开 WeightedFairQueueByteDistributor 等底层流控调度器。

## 依赖声明

```text
本篇
├── HARD 前置：ch12-http2/01-http2-codec.md
├── HARD 前置：ch7-pipeline/05-outbound-buffer-and-writability.md
├── HARD 前置：ch7-pipeline/06-write-flush-and-consolidation.md
├── HARD 前置：ch4-bytebuf/06-ownership-and-reference-counting.md
├── HARD 前置：ch4-bytebuf/07-leak-detector-and-tracking.md
├── NAV 后续：HTTP/2 encoder / decoder 主链
└── NAV 后续：gRPC / Dubbo Triple 如何落在 Http2StreamChannel 上
```

## 结构设计

### 1. 开场：HTTP/2 地基已经有了，但业务代码还需要一个“像 Netty 一样的入口”
- 前一篇地基回答的是“协议怎么工作”，本篇回答的是“Netty 怎样把它变成开发者能接的 API”。
- 引出两个关键翻译动作：frame -> object，stream -> child channel。
- 预计 900-1200 字。

### 2. 失败方案：如果只暴露底层 connection/frame listener，业务会卡在哪
- 失败方案 A：业务直接面对一条连接上的所有 frame，自行按 streamId 路由。
- 失败方案 B：业务自己维护 stream 生命周期和 child pipeline。
- 失败方案 C：所有 stream 共用一个 handler 链，靠 if/switch 分发。
- 预计 1500-1900 字。

### 3. `Http2FrameCodec`：先把 wire frame 变成 Netty 对象，再把 stream 生命周期挂到 `Http2FrameStream`
- `Http2FrameCodec` 的定位、supported messages、`newStream()`、`Http2FrameStream` 句柄。
- inbound frame -> `channelRead`；outbound `Http2Frame` -> wire format。
- 为什么读入的 `Http2StreamFrame` 一定带 stream，写出时则需要应用自己先挂 stream。
- 预计 2000-2500 字。

### 4. `Http2MultiplexHandler`：为什么一个 stream 能看起来像一个 child channel
- 新 stream 到来时如何注册 `Http2MultiplexHandlerStreamChannel`。
- inbound stream handler / upgrade stream handler。
- `Http2ResetFrame` / `Http2PriorityFrame` 为什么走 user event，不走普通 read。
- 预计 2200-2800 字。

### 5. child channel 活跃、关闭、可写性：HTTP/2 API 层最容易误解的三个边界
- child channel 何时 active，不等于 stream 何时完全建立。
- close child channel 为什么可能映射成 `RST_STREAM(CANCEL)`。
- child channel 的 writability 只反映 stream-level flow control，不知道 connection-level 窗口。
- 预计 2200-2800 字。

### 6. `Http2StreamChannelBootstrap`：主动创建 outbound stream 的 Netty 式入口
- 为什么还需要一个 bootstrap，而不是直接 new 一个 stream channel。
- 如何在已存在的 parent channel 上找到 multiplex context，并在 event loop 中注册 child channel。
- option / attr / handler 如何应用到 child channel。
- 预计 1600-2200 字。

### 7. ownership 与异常传播：为什么 HTTP/2 API 层还在反复强调 release
- `Http2FrameCodec` / `Http2MultiplexHandler` 文档里的 reference counting 约束。
- 异常如何包装成 `Http2FrameStreamException` 或 `Http2MultiplexActiveStreamsException`。
- 预计 1400-1800 字。

### 8. 收网与桥接
- 总结：frame object、stream handle、child channel 三层投影。
- 桥到 gRPC / Triple：每个 RPC stream 为什么能自然落在 `Http2StreamChannel` 上。
- 预计 600-800 字。

## 证据清单

- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:45-61`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:77-123`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:127-142`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:167-243`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2FrameCodec.java:298-303`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:45-98`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2MultiplexHandler.java:168-275`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:45-57`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:98-132`
- `codec-http2/src/main/java/io/netty/handler/codec/http2/Http2StreamChannelBootstrap.java:135-203`
- `codec-http2/src/test/java/io/netty/handler/codec/http2/Http2FrameCodecTest.java:167-237`
- `codec-http2/src/test/java/io/netty/handler/codec/http2/Http2MultiplexHandlerTest.java:59-111`

## 误解清单

1. `Http2FrameCodec` 只是把底层 frame 换成几个 Java 类，没有引入新的生命周期语义。
2. `Http2FrameStream` 只是个编号包装，对状态和异常没有实际意义。
3. `Http2MultiplexHandler` 创建 child channel 只是为了“代码更优雅”，不是实际运行时边界。
4. child channel writable 就代表整条 HTTP/2 连接一定还能继续无限写。
5. child channel active 就等于 stream 已经完全建立完成。
6. 有了 child channel 以后，引用计数责任就会自动消失。

## 边界清单

- 本篇不展开 `Http2FrameCodec` 内部连接级编码/解码主链，只抓 API 层投影。
- 本篇不展开 `Http2MultiplexCodec` 与 `Http2MultiplexHandler` 的全部差异，只以当前主线为主。
- 本篇不提前写透 gRPC / Dubbo Triple 源码，只建立桥接方向。
- 本篇不把 child channel 的 writability 写成 connection-level flow control 的完整镜像，要保留“它不知道连接窗口”的边界。

## 深审预警

- [ ] 不把 `Http2FrameCodec` 写成单纯对象包装器，要写出 stream handle 和状态边界。
- [ ] 不把 child channel active 写成 stream 已经完全建立。
- [ ] 不把 child channel writable 写成整个连接无压力。
- [ ] 不把 `Http2ResetFrame` / `Http2PriorityFrame` 普通化成 channelRead，要保留它们走 user event 的差异。
- [ ] 不把 HTTP/2 API 层的 reference counting 约束写漏。