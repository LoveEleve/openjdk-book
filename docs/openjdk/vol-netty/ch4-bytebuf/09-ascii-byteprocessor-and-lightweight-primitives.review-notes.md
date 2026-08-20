# Ch4-09 AsciiString、ByteProcessor 与轻量基础设施 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `AsciiString` 当前以 byte[] 为底层存储，支持 offset/length 视图，并缓存 hash 与 toString，证据：`common/src/main/java/io/netty/util/AsciiString.java:36`。  
2. `AsciiString` 当前支持 copy / share 两种底层数组策略，并明确要求共享数组被外部修改后调用 `arrayChanged()`，证据：`common/src/main/java/io/netty/util/AsciiString.java:42`、`:95`。  
3. `AsciiString` 当前提供从 byte[]、ByteBuffer、char[]、CharSequence 等多种来源构造的路径，说明它站在字节表示与协议字符串之间，证据：`common/src/main/java/io/netty/util/AsciiString.java:78`。  
4. `ByteProcessor` 当前通过 `process(byte)` 的 true/false 语义定义可停止字节扫描协议，并提供 FIND_CRLF、FIND_LINEAR_WHITESPACE、IndexOfProcessor 等常量实现，证据：`common/src/main/java/io/netty/util/ByteProcessor.java:22`。  
5. `CharsetUtil` 当前不仅提供常见 charset 常量，还通过 `InternalThreadLocalMap` 缓存 `CharsetEncoder/CharsetDecoder`，证据：`common/src/main/java/io/netty/util/CharsetUtil.java:28`、`:108`、`:164`。  
6. `TypeParameterMatcher.get/find` 当前通过 `InternalThreadLocalMap` 持有两级 matcher cache，而不是每次重复反射解析，证据：`common/src/main/java/io/netty/util/internal/TypeParameterMatcher.java:31`、`:48`。  
7. `Signal` 当前是一个无栈、无 cause、identity equality 的固定信号对象，通过 `ConstantPool` 生成，证据：`common/src/main/java/io/netty/util/Signal.java:19`、`:27`。  
8. `Signal.expect(signal)` 当前明确表达了“这是不是我预期的那个固定信号”这一使用方式，证据：`common/src/main/java/io/netty/util/Signal.java:57`。  
9. `codec-http` 中大量 header / value / key 路径反复使用 `AsciiString`、`CharsetUtil` 等，证明这些组件并不是孤立工具，证据：本地 `codec-http` 搜索结果。  
10. `MessageToMessageEncoder` 这类对象流 codec 的 accept 语义依赖 `TypeParameterMatcher`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageToMessageEncoder.java:53`。

### 深审发现

1. **高风险：容易把这批类写成 common 包杂项。** 正文已改成“热点路径共同底盘”。  
2. **中风险：容易把 AsciiString 写成 String 替身。** 正文已限定为“让 ASCII 协议字符串尽量留在 byte[] 世界”。  
3. **中风险：容易把 CharsetUtil 写成纯常量类。** 正文已补线程本地 encoder/decoder 缓存语义。  
4. **中风险：容易把 Signal 写成普通异常。** 正文已改成“异常式控制流信号”。  
5. **低风险：容易写漏 TypeParameterMatcher 与 codec accept 语义的关系。** 正文已补这一桥接。

## 第二轮：因果审

- 协议字符串本就在 ASCII/byte[] 世界 -> `AsciiString` 让它们不必过早升格成 `String`：✅  
- 高速字节扫描反复出现 -> `ByteProcessor` 把停止条件抽成可复用协议：✅  
- 编码器/解码器和 matcher 高频重用 -> `CharsetUtil` / `TypeParameterMatcher` 接入线程本地缓存：✅  
- 某些控制流需要低开销固定信号 -> `Signal` 用无栈 identity 信号取代普通异常语义：✅

## 第三轮：结构审

正文结构按“先把工具类从杂项堆拉出 -> AsciiString -> ByteProcessor -> CharsetUtil -> TypeParameterMatcher -> Signal -> 收网”推进，没有按源码文件大小或方法列表平铺。✅

失败/误解已覆盖：
- `AsciiString` 不是普通 String 替身  
- `ByteProcessor` 不是完整 parser  
- `CharsetUtil` 不只是常量表  
- `TypeParameterMatcher` 不是每次都重新反射  
- `Signal` 不是普通异常  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- 这些类不是杂项，而是热点路径共同底盘  
- `AsciiString` 负责协议字符串的轻量表示  
- `ByteProcessor` 负责可停止字节扫描协议  
- `CharsetUtil` / `TypeParameterMatcher` 负责把高频辅助对象接到线程本地缓存  
- `Signal` 负责低开销固定控制信号  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把 AsciiString 的底层共享写成没有 `arrayChanged()` 责任。✅  
- 未把 ByteProcessor 写成完整 parser。✅  
- 未把 CharsetUtil 缓存写成跨线程共享 encoder/decoder。✅  
- 未把 TypeParameterMatcher 写成永久全局缓存。✅  
- 未把 Signal 写成普通带栈异常。✅

## 第六轮：依赖审

- 依赖 Ch5-03、Ch10、Ch11、Ch4-05 前置，真实存在。✅  
- HTTP/2 只作背景，不越界依赖。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 7,327。  
- 去掉常见 markdown 标记后的字符数：约 7,037。  
- 目标定位：中等专题篇，已形成独立闭环。✅

## 结论

当前正文已经把 AsciiString、ByteProcessor、CharsetUtil、TypeParameterMatcher、Signal 收束成同一条轻量基础设施主线。Ch4-09 可作为后续 HTTP header、对象流编解码和控制流专题的轻量底盘篇。