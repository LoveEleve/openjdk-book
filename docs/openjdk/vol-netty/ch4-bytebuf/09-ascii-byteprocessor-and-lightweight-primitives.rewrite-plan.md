# Ch4-09 AsciiString、ByteProcessor 与轻量基础设施 — rewrite-plan

## 篇章定位

- 核心困惑：Netty common 里有一批看起来不像主线的类：`AsciiString`、`ByteProcessor`、`CharsetUtil`、`TypeParameterMatcher`、`Signal`。它们为什么会被 HTTP header、codec、类型匹配和异常控制流反复使用？它们到底是“工具类杂项”，还是 Netty 为字节型热点准备的公共底盘？
- 一句话顿悟：这批类共同体现了 Netty 的轻量基础设施策略：`AsciiString` 把常见协议字符串留在 byte[]/CharSequence 世界，`ByteProcessor` 把扫描逻辑变成可停止的字节迭代器，`CharsetUtil` 把编码器/解码器缓存接入线程本地容器，`TypeParameterMatcher` 把反射型类型判断缓存起来，`Signal` 则把异常式控制流压缩成无栈、可比较的固定信号。
- 文章边界：本篇主讲这些组件各自解决的高频小问题、与 HTTP/codec/FastThreadLocal 的连接，以及它们为什么不应被简单归类为“杂项工具”；不展开完整 `AsciiString` 方法矩阵、不展开所有 ByteProcessor 常量、不重讲 FastThreadLocal/InternalThreadLocalMap 本体。

## 依赖

### HARD

- Ch5-03 `ch5-eventloop/03-fastthreadlocal-and-recycler.md`：理解线程本地缓存承载面。
- Ch10-01/02：理解 decoder/encoder 高频扫描与类型匹配场景。
- Ch11 HTTP：理解 header 名称、ASCII 协议字段和 CharSequence API。
- Ch4-01/05：理解 ByteBuf 字节访问与 ByteBufUtil 基础。

### SOFT

- Ch12 HTTP/2：只复用 headers / pseudo-header 的字节型协议背景。

### NAV

- 后续：HTTP headers / DefaultHeaders 的哈希策略与 AsciiString 细节。
- 后续：更完整的内部信号与异常控制流专题。

## 结构设计

### 1. 开场：为什么这些“工具类”会反复出现在热点路径
- 从 HTTP header、codec 扫描、类型匹配和异常控制流四个场景切入。
- 引出共同问题：如何少做转换、少分配、少重复反射、少创建异常栈。
- 预计 900-1200 字。

### 2. `AsciiString`：把协议字符串留在 byte[] 世界
- byte[] 存储、CharSequence 兼容、offset/length 视图。
- copy=false 的共享数组边界与 `arrayChanged()` 责任。
- hash/toString 缓存和 HTTP header 使用点。
- 预计 2000-2500 字。

### 3. `ByteProcessor`：可停止的字节扫描协议
- `process(byte)` 返回 true 继续、false 停止。
- FIND_CRLF、FIND_LINEAR_WHITESPACE、IndexOfProcessor 等常量。
- 为什么 codec/HTTP 解析更适合把扫描逻辑注入 ByteBuf 遍历，而不是到处复制循环。
- 预计 1500-1900 字。

### 4. `CharsetUtil`：编码器缓存与线程本地运行时
- 常用 charset 常量。
- `encoder/decoder` 创建与缓存路径。
- 与 `InternalThreadLocalMap` 的连接，以及 reset/error action 的边界。
- 预计 1300-1700 字。

### 5. `TypeParameterMatcher`：把反射型泛型判断收束成可缓存 matcher
- `get(parameterType)` 与 `find(object, superclass, typeParamName)` 两级缓存。
- `Object.class` 的 NOOP matcher。
- 与 `MessageToMessageEncoder/Decoder` 类型接受判断的连接。
- 预计 1500-2000 字。

### 6. `Signal`：无栈、可比较的异常式控制信号
- Error 作为状态/请求信号的用途。
- 空栈、无 cause、identity equality、`expect(signal)`。
- 与 `ReplayingDecoder` 等控制流机制的边界，不把它写成普通异常。
- 预计 1200-1600 字。

### 7. 收网：轻量基础设施不是杂项，而是热点路径的共同底盘
- 统一回收：字节表示、扫描、编码、类型判断、控制流信号。
- 桥到 HTTP/codec/FastThreadLocal 现有篇章。
- 预计 600-900 字。

## 证据清单

- `common/src/main/java/io/netty/util/AsciiString.java:36-73`
- `common/src/main/java/io/netty/util/AsciiString.java:78-159`
- `common/src/main/java/io/netty/util/ByteProcessor.java:22-147`
- `common/src/main/java/io/netty/util/CharsetUtil.java:28-186`
- `common/src/main/java/io/netty/util/internal/TypeParameterMatcher.java:22-83`
- `common/src/main/java/io/netty/util/Signal.java:19-111`
- `codec-http/src/main/java/io/netty/handler/codec/http/DefaultHttpHeaders.java`
- `codec-base/src/main/java/io/netty/handler/codec/MessageToMessageEncoder.java:53-79`

## 误解清单

1. `AsciiString` 只是 String 的另一个写法，没有协议热点意义。
2. `ByteProcessor` 只是函数式接口，和 decoder 状态机没有关系。
3. `CharsetUtil.encoder/decoder` 每次都会新建对象。
4. `TypeParameterMatcher` 每次都要重新反射解析泛型。
5. `Signal` 就是普通异常，只是名字不同。

## 边界清单

- 本篇不把 AsciiString 的每个 API 都当成独立机制，只抓存储、视图、缓存和 header 连接。
- 本篇不把 ByteProcessor 写成完整 parser，只解释扫描协议。
- 本篇不把 CharsetUtil 缓存写成全局共享，它连接的是线程本地缓存。
- 本篇不把 Signal 的无栈控制流外推成所有异常处理的通用建议。

## 深审预警

- [ ] 不把 AsciiString 的 byte[] 共享写成没有 `arrayChanged()` 责任。
- [ ] 不把 ByteProcessor 返回 false 写成异常，它是正常停止扫描协议。
- [ ] 不把 CharsetUtil 缓存写成跨线程共享 encoder/decoder。
- [ ] 不把 TypeParameterMatcher 缓存写成永久全局缓存。
- [ ] 不把 Signal 写成普通带栈异常。