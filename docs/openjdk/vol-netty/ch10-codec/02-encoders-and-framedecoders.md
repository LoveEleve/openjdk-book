# 编码器与四种拆包器：父类已经替你管住半包，子类真正要回答的只剩“边界在哪里”

> 本文基于当前 Netty `FixedLengthFrameDecoder`、`DelimiterBasedFrameDecoder`、`LineBasedFrameDecoder`、`LengthFieldBasedFrameDecoder`、`ReplayingDecoder`、`MessageToByteEncoder` 与相关辅助类实现。前置：Ch10 `01-bytetomessagedecoder.md`、Ch4 `01-dual-index-and-refcnt.md`、Ch4 `04-views-and-zerocopy.md`、Ch7 Pipeline；本文聚焦四类常见拆包器的边界判定模型、`ReplayingDecoder` 的 REPLAY 回退机制，以及 `MessageToByteEncoder` 的 encode→release→write 出站骨架，不展开 HTTP/WebSocket 等上层协议细节。

## 上一篇已经解决了“半包怎么等”，这一篇要解决的是“边界到底怎么找”

上一篇把 `ByteToMessageDecoder` 的骨架掰开讲过一遍之后，很多看起来零散的 codec 类其实已经没那么神秘了。

因为那一篇真正解决掉的，是最难统一、也最容易被每个协议重复造轮子的那部分：

- 多次到达的 `ByteBuf` 怎么积攒成 `cumulation`
- 一次 read 里怎么连续解出多条消息
- 数据不够时怎么停在正确位置等下一批
- decode 中间发生重入、remove、input closed 时怎么别把内部状态搞乱

换句话说，父类已经替你管住了“半包怎么等”和“循环怎么跑”这两件最麻烦的事。

可当你真的要写一个协议 decoder 时，困惑并没有结束，反而会变得更具体：

```text
入站：我该按什么边界把 TCP 字节流切成一帧一帧？
出站：业务对象又该在什么地方被编码成真正可写 Socket 的 ByteBuf？
```

这两个问题看起来像两条线，实际上正好构成 Codec 的一进一出。

- 入站拆包器回答的是：在哪里停，哪里算一条完整 frame。
- 出站编码器回答的是：什么对象由我接管，它要被写成什么字节。

而这一篇最重要的顿悟，可以先提前摆出来：

```text
父类骨架已经统一了“半包怎么等”；
所以具体拆包器真正要做的，只剩“边界在哪里”。

同样，出站编码器也不负责发送时序；
它真正要做的，是把对象编码进 ByteBuf，
再把原对象生命周期收口到统一的 encode→release→write 协议里。
```

如果没有这层区分，读源码时很容易再次把重点放错。

你会误以为：

- `FixedLengthFrameDecoder` 之类的子类也要自己管累积缓冲区。
- `LengthFieldBasedFrameDecoder` 的四参数只是靠背模板。
- `ReplayingDecoder` 只是“抛个异常偷懒”。
- `MessageToByteEncoder` 只是在 `write()` 里帮你少写几行 `encode()`。

当前实现都比这些直觉更具体，也更严格。

## 一、如果继续让业务 handler 自己切包、自己编码，会在三处重新掉回泥里

进入具体类之前，先重复上一篇的做法：故意走几条最顺手、也最容易把 codec 责任边界重新写乱的路。

### 1. 失败方案一：业务 handler 自己在 `channelRead()` 里手动 `readInt()`、`indexOf()`、`skipBytes()`

这是很多人第一次接 TCP 协议时最自然的做法。

反正上游已经把字节交给你了，那业务 handler 自己看着办就行：

- 如果是定长协议，就每次 `readBytes(fixedLen)`。
- 如果是分隔符协议，就自己搜 `\n` 或 `\0`。
- 如果是长度字段协议，就先 `readInt()` 再读 payload。

这个方案不是完全做不到，而是会很快把“协议边界判断”和“半包骨架管理”重新缠在一起。

因为一旦你在业务 handler 里自己做这些事，立刻就要重新面对上一篇已经解决过的那些问题：

- 这次 read 不够一帧怎么办。
- 一次 read 里有两帧半怎么办。
- `readerIndex` 试探性前进之后发现不够，要不要回退。
- 一个 decoder 被替换掉时，手头残留的半包归谁管。

也就是说，业务 handler 本来应该只关心“这是什么协议消息”，结果很快又被拉回“TCP 字节流的边界和生命周期管理”。

这不是职责分离，而是把已经沉到底座里的共性成本重新拉回业务层。

### 2. 失败方案二：为了好切分，先把整段字节流转成 `String` 再 `split()`

第二条路在文本协议上尤其诱人。

比如你看到行协议、NUL 分隔协议、CSV 一类格式时，很容易想：

```text
反正最后都是字符串，先把 ByteBuf 转成 String，
再按换行符或别的分隔符 split 不就行了？
```

这个方案的问题不止是“可能多一次拷贝”。真正更麻烦的是，它直接跳过了 `ByteBuf` 语义里最关键的几个边界：

- 你在完整 frame 出现之前就把半包提前做了解码和物化。
- 一旦字符集不是单字节，字节边界和字符边界就未必重合。
- 你会更难保留“只取出一帧、其余字节继续留在 cumulation 里”的精确位置感。

所以文本协议看起来“更像字符串问题”，但在真正拿到完整 frame 之前，它本质上仍然是字节边界问题。

这也是为什么 `LineBasedFrameDecoder` 当前注释明确把自己限定在 UTF-8 / ASCII 的低位换行字节处理上，而不是把“按行切分”偷换成“先整体转字符串再解析”，见 `codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:24`。

### 3. 失败方案三：出站编码只看 encode 成功路径，不管原消息什么时候释放

出站更容易被低估。

很多人第一次看 `MessageToByteEncoder`，会本能地把它理解成：

```text
业务对象 -> encode() -> ByteBuf -> ctx.write()
```

然后以为子类只要把字节写进 `out`，剩下都无所谓。

可一旦进入引用计数语义，这个“剩下都无所谓”会马上出事。因为对框架来说，出站不只是“写字节”，还包括：

- 这个 encoder 到底接管哪些类型的消息。
- 编码目标 buffer 是 direct 还是 heap。
- 如果 `encode()` 抛异常，原始 msg 谁来 release。
- 如果 encode 出来的是空 buffer，是写空消息、写 `EMPTY_BUFFER`，还是直接吞掉。

所以出站骨架真正统一的，也不仅是一次 `encode()` 调用，而是：

```text
谁被我接管
分配什么 ByteBuf
怎么 encode
什么时候 release 原 msg
最后写出去的是哪个 ByteBuf
```

这正是当前 `MessageToByteEncoder.write(...)` 真正承担的协议。

## 二、四种拆包器的总图：它们并不重新发明“等更多数据”，它们只定义 frame 边界

现在先把这一篇的入站总图立起来。

如果只看类名，`FixedLengthFrameDecoder`、`DelimiterBasedFrameDecoder`、`LineBasedFrameDecoder`、`LengthFieldBasedFrameDecoder` 看上去像四种完全不同的 decoder。

可从上一篇建立的骨架看，它们其实是在同一个父类协议里回答四种不同的边界问题：

```text
FixedLength
  -> 一帧多长是固定的

DelimiterBased
  -> 一帧在某个结束符处结束

LineBased
  -> 一帧在 \n 或 \r\n 处结束

LengthFieldBased
  -> 一帧多长，要先读某个长度字段才能知道
```

注意这里真正统一的不是“实现长得像”，而是它们都接受同一条父类契约：

- 输入来自 `ByteToMessageDecoder` 已经积攒好的 `cumulation`
- 数据不够时，不自己保存半包，只返回 `null`
- 数据够时，切出一帧 `ByteBuf` 或别的对象放进 `out`
- 是否继续尝试解下一帧，仍交给父类 `callDecode()` 判断

所以四种拆包器真正的共性可以压成一句话：

```text
它们都不管理“字节怎么攒”；
它们只管理“哪一段字节算一帧”。
```

这也是完整性问题 #6 的设计答案前提：四种拆包器统一复用父类积攒骨架，本质上是在把“边界判定”从“半包生命周期管理”里拆出来。

如果它们各自再维护一套 buffer，那上一篇的 `ByteToMessageDecoder` 就白设计了。

## 三、`FixedLengthFrameDecoder`：最省心的边界模型，但只适合边界天然等宽的协议

四种拆包器里，`FixedLengthFrameDecoder` 最简单，也最适合用来校准“子类真正负责什么”。

当前类只有一个核心字段：`frameLength`，见 `codec-base/src/main/java/io/netty/handler/codec/FixedLengthFrameDecoder.java:43`。

真正的 decode 逻辑也非常短，见 `codec-base/src/main/java/io/netty/handler/codec/FixedLengthFrameDecoder.java:71`：

```text
if readableBytes < frameLength
  -> return null
else
  -> readRetainedSlice(frameLength)
```

这段逻辑虽然短，但恰恰最能证明上一节那句话：

```text
子类不负责等更多数据；
它只负责回答“现在够不够一帧”。
```

如果不够，它什么都不额外保存，也不回退什么复杂状态，只是 `return null`。父类看到“没产出且没消费”，就自然停下，等下一批字节补上。

如果够，它也不做多余复制，而是 `readRetainedSlice(frameLength)` 直接从当前 `ByteBuf` 视图中切出这一帧。这和前面 ByteBuf 视图一章正好连上：

- 它不是重新分配一段新的字节数组。
- 它拿的是一个 retain 过的切片视图。
- 因此后续使用者要按引用计数规则接住它。

这类 decoder 适合什么协议，也就很清楚了：

- 每条记录长度天然固定
- 不需要额外头部说明长度
- 不依赖结束符

比如某些老式二进制记录流、固定宽度 telemetry 片段、严格定长设备报文，都适合这种模型。

反过来，为什么它不适合一般应用层协议？因为一旦 payload 长度可变，它立刻失去表达力。

所以这里真正该记住的不是“这个类很简单”，而是：

```text
FixedLengthFrameDecoder 之所以能简单，
不是它比别的 decoder 更聪明，
而是协议自己已经把边界问题简化到了“每帧恒长”。
```

## 四、`DelimiterBasedFrameDecoder` / `LineBasedFrameDecoder`：边界来自结束符，而不是预先知道长度

如果说定长协议把边界简化成“每次拿 N 个字节”，那分隔符协议刚好相反：

它不提前告诉你一帧多长，而是告诉你“看到某个结束符就算一帧结束”。

这类协议在人类可读文本、老式控制协议和某些简单二进制协议里很常见，比如：

- 一行命令一条消息
- NUL 结尾一条消息
- `\r\n` 结尾一条记录

### 1. `DelimiterBasedFrameDecoder` 的核心不是“按某个分隔符 split”，而是“找最近能结束一帧的那个分隔符”

当前 `DelimiterBasedFrameDecoder` 会持有一个或多个 delimiter，见 `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:64`。

真正的 decode 主线在 `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:229`。它会遍历所有 delimiter，调用 `indexOf(buffer, delim)`，找出能形成最短 frame 的那个分隔符。

这一步很值得停一下。

因为它说明多 delimiter 场景下，当前实现追求的不是“第一个遍历到的分隔符”，而是：

```text
谁最先把当前 readerIndex 之后的字节流截成一帧，
就优先用谁。
```

这正是类注释里 `ABC\nDEF\r\n` 例子的关键：如果你同时支持 `\n` 和 `\r\n`，真正应该先切出来的第一帧是 `ABC`，而不是把 `\nDEF` 一起吞进来。

所以这里不是普通字符串库那种“拿一个分隔符 split 完事”，而是面向字节流边界的“找最短合法 frame”。

### 2. `stripDelimiter` 决定的是交给下游的 frame 视图，不是搜索策略

找到最近 delimiter 之后，当前实现会根据 `stripDelimiter` 决定切出来的是：

- 仅 frame 内容
- 还是 frame + delimiter 一起交给下游

见 `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:269`。

这说明 `stripDelimiter` 的语义一定要摆正：

```text
它不是影响“哪里算边界”，
而是影响“下游拿到的 frame 是否保留结束符”。
```

这在一些协议里很重要。

- 如果业务 handler 根本不关心 `\n` 是否存在，就 strip 掉更省事。
- 如果下游还需要保留原始协议格式，比如日志转发或代理场景，不 strip 更合适。

### 3. `discardingTooLongFrame` 说明分隔符协议的危险在于：没有 delimiter 时，frame 会无限长下去

分隔符协议最麻烦的失败路径，不是 delimiter 找到了，而是一直找不到。

当前实现用 `discardingTooLongFrame` 和 `tooLongFrameLength` 处理这种情况，见 `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:68`。

如果当前 buffer 里还没出现 delimiter，但 `readableBytes` 已经超过 `maxFrameLength`，它会进入 discard 模式：

- 先把当前 buffer 全部 skip 掉
- 记住已经丢了多少字节
- 后续继续丢，直到终于遇到 delimiter
- 再按 `failFast` 决定是立刻报错，还是等整段超长 frame 丢完再报错

这条路径说明 delimiter 协议的主要风险并不是“半包”，而是：

```text
如果结束符一直不来，累积缓冲区就会被一条永远结束不了的消息拖着长大。
```

所以 `maxFrameLength` 在这里不是可有可无的保护参数，而是防止一条坏消息把连接拖进无界累积的重要闸门。

### 4. `LineBasedFrameDecoder` 不是简单重命名版，而是专门为 `\n` / `\r\n` 做了特化

虽然按表面看，行协议只是分隔符协议的一种特例，但当前实现并没有把 `LineBasedFrameDecoder` 完全做成 `DelimiterBasedFrameDecoder` 的薄皮封装。

`LineBasedFrameDecoder` 有自己的一套状态：

- `discarding`
- `discardedBytes`
- `offset`

见 `codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:45`。

其中最容易被忽略的是 `offset`。`findEndOfLine(...)` 每次找不到换行时，会把本轮已经扫描过的总长度记到 `offset`，下次从那个位置继续找，而不是每次都从 `readerIndex()` 重新全量扫描，见 `codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:173`。

所以它不仅是“按行切分”，还是“按行切分时避免重复扫描老字节”的一个小优化。

### 5. 为什么 `DelimiterBasedFrameDecoder` 在 `\n` + `\r\n` 场景下会直接委托给 `LineBasedFrameDecoder`

当前构造函数里有一个很关键的特判：如果 delimiters 正好是 `\n` 和 `\r\n`，并且当前类没有被子类化，就直接构造一个 `LineBasedFrameDecoder` 来处理，见 `codec-base/src/main/java/io/netty/handler/codec/DelimiterBasedFrameDecoder.java:173`。

这说明当前实现已经明确承认：

```text
“按行切分”虽然可以抽象成“分隔符切分”的特例，
但它值得一条专门的、更高效也更语义明确的实现路径。
```

所以这两个类不是简单命名差异，而是：

- `DelimiterBasedFrameDecoder` 面向一般结束符协议
- `LineBasedFrameDecoder` 面向最常见、也最值得专门优化的换行协议

### 6. `LineBasedFrameDecoder` 还带着一个很现实的安全边界提示

当前类注释里还专门提醒：如果协议严格要求 `\r\n`，而实现又对单独 `\n` 过于宽容，可能导致类似 SMTP smuggling 的 parser differential 风险，见 `codec-base/src/main/java/io/netty/handler/codec/LineBasedFrameDecoder.java:36`。

这条注释很有代表性，因为它说明“按行拆包”并不是一个完全无害的技术细节。

对框架来说：

- 它负责把行边界切出来。
- 但协议到底允许 `\n`、只允许 `\r\n`，还是两者都允许，这其实仍然是协议语义的一部分。

所以在这一类 decoder 上，边界判定和安全语义已经很接近了。

### 7. 这两类拆包器各自适合什么协议

到这里可以回答完整性问题 #9。

`FixedLengthFrameDecoder` 适合：

- 每条记录天然固定宽度
- 边界不依赖内容和结束符
- 典型场景是设备报文、定长二进制记录

`DelimiterBasedFrameDecoder` / `LineBasedFrameDecoder` 适合：

- 边界天然由终止符给出
- 文本命令、逐行协议、NUL 结尾记录
- 典型场景是按行命令流、简单文本协议、某些日志或控制流

真正不该混淆的是：

```text
定长协议的问题是“够不够 N 字节”；
分隔符协议的问题是“结束符来了没有”。
```

它们解决的是不同类型的边界信息。

## 五、`LengthFieldBasedFrameDecoder`：真正难的不是“先读长度”，而是“长度字段的值”与“整帧长度”经常不是一回事

四种拆包器里，`LengthFieldBasedFrameDecoder` 最常被背模板，也最容易在真正调协议时出错。

它难的地方不是“有四个参数记不住”，而是开发者经常把下面三件事混成一件事：

- 长度字段在帧里的位置
- 长度字段本身占几个字节
- 长度字段的值到底表示 payload 长度、header+payload 长度，还是整帧总长度

当前类把这几件事明确拆成了几个字段，见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:189`：

- `lengthFieldOffset`
- `lengthFieldLength`
- `lengthFieldEndOffset`
- `lengthAdjustment`
- `initialBytesToStrip`
- `maxFrameLength`
- `failFast`

### 1. 先用一个最常见的例子把四参数立住：`[2B len][4B header][payload]`

假设协议帧长这样：

```text
[2B len][4B header][payload]
```

并且 `len` 这个字段表示的不是整帧总长度，而只是 `payload` 的长度。

如果 payload 长度是 4，那么这条完整 frame 的总字节数其实是：

```text
2 (len 字段自身)
+ 4 (header)
+ 4 (payload)
= 10
```

可长度字段本身给你的值却只有 `4`。

这正是 `LengthFieldBasedFrameDecoder` 四参数存在的原因：

- `lengthFieldOffset = 0`：长度字段就在开头
- `lengthFieldLength = 2`：长度字段占 2 字节
- `lengthAdjustment = 4`：长度字段之后还有 4 字节 header 也属于整帧
- 但这里还要记住，解码器内部在最终计算时会自动再加上 `lengthFieldEndOffset`，也就是 `offset + lengthFieldLength`

当前实现的真正公式在 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:416`：

```text
frameLength = unadjustedLength + lengthAdjustment + lengthFieldEndOffset
```

所以对于上面这个例子：

- `unadjustedLength = 4`
- `lengthAdjustment = 4`
- `lengthFieldEndOffset = 2`

最终整帧长度就是 `10`。

这就是为什么理解这个类时，最重要的不是死记配置，而是先问：

```text
长度字段告诉我的，到底是哪一段的长度？
而我要真正等待的整帧，又总共有多少字节？
```

### 2. 四个最常用参数各自控制什么

现在可以把完整性问题 #4 里的四参数逐个说清：

#### `lengthFieldOffset`

长度字段相对整帧起点的偏移。

- 如果长度字段在帧开头，就是 `0`
- 如果前面还有 1 字节或 4 字节别的头部，就得把这些也算进去

#### `lengthFieldLength`

长度字段本身占几个字节。

当前默认实现支持 `1 / 2 / 3 / 4 / 8`，见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:454`。

#### `lengthAdjustment`

最容易写错的参数。

它不是“整帧长度”，而是：

```text
长度字段的值，要补偿多少，才能变成当前 decoder 真正应等待的整帧长度。
```

这个补偿既可能是正数，也可能是负数。

- 正数：长度字段没把后面的某些 header 算进去
- 负数：长度字段已经把自己或前面部分头部算进去了

#### `initialBytesToStrip`

切出 frame 之后，要从头部跳过多少字节再交给下游。

如果你希望业务 handler 直接看到 payload，而不是还要再手动 `skipBytes(lengthFieldLength)`，就可以把长度字段或前置 header 在这里 strip 掉。

它控制的是“下游最终拿到什么视图”，不是“父类等待多少字节”。

### 3. `frameLengthInt == -1` 其实就是这个类的两段式状态机

当前实现里还有一个非常关键的字段：`frameLengthInt = -1`，见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:200`。

它不是随手选的初始值，而是在表达两段状态：

```text
frameLengthInt == -1
  -> 还没成功读出本帧的总长度

frameLengthInt != -1
  -> 本帧总长度已经知道了，接下来只是在等足够字节到齐
```

这正是 `decode(...)` 主线的关键，见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:397`。

第一阶段，它先检查：

- 当前可读字节是不是连长度字段都还没到齐
- 如果没到齐，直接 `return null`
- 到齐后用 `getUnadjustedFrameLength(...)` 读出长度字段的原始值
- 再用 `lengthAdjustment + lengthFieldEndOffset` 算出整帧总长

第二阶段，如果总长已经算出来但当前 `readableBytes < frameLengthInt`，那也不再重复解析长度字段，而只是 `return null` 继续等整帧补齐。

所以它真正高明的点不在“四参数多复杂”，而在于：

```text
长度字段只在第一次够读时解析一次；
之后当前帧还没到齐时，就不重复推导边界了。
```

这就是大纲里所谓“两级状态”的当前源码落点。

### 4. 为什么 `[2B len][payload]` 的配置看起来简单，而 `[2B len][4B header][payload]` 容易把人绕晕

对于最简单的协议：

```text
[2B len][payload]
```

如果 `len` 表示 payload 长度，那么配置就是：

- `lengthFieldOffset = 0`
- `lengthFieldLength = 2`
- `lengthAdjustment = 0`
- `initialBytesToStrip = 2`（如果你只想给下游 payload）

因为最终总长度自动按：

```text
payloadLength + lengthFieldEndOffset(=2)
```

就已经正好等于整帧长度。

难的是当前面还有额外 header 时，很多人会误把 `lengthAdjustment` 设成“整帧总长度减去 payload 长度”。当前实现里其实不用这么抽象去记，直接问更稳：

```text
长度字段结束之后，直到 frame 结束之前，
还有多少不在长度字段原值里的字节，要额外补进去？
```

对 `[2B len][4B header][payload]` 来说，这个答案就是 `4`。

### 5. `initialBytesToStrip` 真正解决的是“业务 handler 想不想知道长度字段存在”

很多资料讲这个参数时只是说“strip 头部”。但当前语义更准确的理解应该是：

```text
这条协议的上层 handler，
究竟是想看到完整帧，还是只想看到去掉协议头后的业务体？
```

如果你后面的 handler 只关心 payload，就可以让 decoder 在边界已经确认之后，顺手把协议头部剥掉。

当前实现是在拿到完整 frame 后先 `skipBytes(initialBytesToStrip)`，再 `extractFrame(...)`，见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:432`。

这说明这个参数的职责非常单一：

- 它不参与判断数据是否到齐
- 它只决定交给下游的 frame 从哪里开始

### 6. 这个类最容易忽略的不是正常路径，而是三类坏帧和一类超长帧

`LengthFieldBasedFrameDecoder` 比前几类复杂，还因为它对坏输入做了明确分流。

当前实现至少单独处理了三类 corrupted frame：

- 长度字段原值为负，见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:349`
- 调整后的 `frameLength` 反而小于 `lengthFieldEndOffset`，见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:355`
- `initialBytesToStrip > frameLengthInt`，说明你想剥掉的头比整帧还长，见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:380`

而另一条更重要的失败路径是超长帧：`frameLength > maxFrameLength`。

当前实现会进入 `exceededFrameLength(...)`，见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:364`。

它要么：

- 如果当前 buffer 已经比整帧还多，直接把这一整帧 skip 掉
- 否则进入 discard 模式，后续持续丢弃直到整条超长 frame 扔完

这和前面的分隔符协议其实很像：

```text
一旦框架已经确认这是一条自己绝不会接收的超长消息，
就不能把它继续留在 cumulation 里陪跑。
```

### 7. `failFast` 的意义：到底是“刚看出来就报错”，还是“先扔干净再报错”

`failFast` 在这个类里尤其值得单独点出来。

当前 `failIfNecessary(...)` 的语义是：

- `failFast = true`：刚发现这条 frame 最终一定会超长时，就立即抛 `TooLongFrameException`
- `failFast = false`：先把整条超长 frame 全部丢干净，再抛异常

见 `codec-base/src/main/java/io/netty/handler/codec/LengthFieldBasedFrameDecoder.java:480`。

这不是纯粹的风格偏好，而是在两个运营语义之间做选择：

```text
尽快告诉上层“这条消息已经不可能接收”
vs
先把输入流重新对齐到下一帧边界，再告诉上层刚才发生了什么
```

所以 `failFast` 本质上控制的是异常通知时机，而不是“要不要丢弃超长帧”。后者是一定要做的。

## 六、`ReplayingDecoder`：不是把异常当错误处理，而是把“不够读”编码成一种可回退的控制流

`ReplayingDecoder` 最容易让人产生两个相反误解。

一种误解是把它神化，觉得它比普通 `ByteToMessageDecoder` 更高级，因为 decode 看上去更像同步阻塞风格，能少写一堆 `readableBytes()` 判断。

另一种误解是把它贬得很浅，觉得无非就是“不够了抛个异常”。

当前实现实际上处在两者之间：它确实把“边界检查”换成了“控制流回退”，但代价也非常真实。

### 1. `ReplayingDecoder` 的核心不是神秘状态机，而是一个会在“读不够”时抛 `REPLAY` 的 `ByteBuf` 代理

当前类里定义了一个缓存的 `Signal REPLAY`，见 `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:270`。

而真正抛它的，不在 `ReplayingDecoder` 本身，而在 `ReplayingDecoderByteBuf`。

这个代理 buffer 会包装真实的 cumulation，并在关键读操作前做检查：

- `checkReadableBytes(length)`：如果底层 `buffer.readableBytes() < length`，直接 `throw REPLAY`，见 `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoderByteBuf.java:1097`
- `checkIndex(index, length)`：如果索引越过当前 `writerIndex`，同样 `throw REPLAY`

所以它的真正戏法不是“神奇地让数据变多”，而是：

```text
先把“读不够”伪装成一种非局部跳转；
然后把普通 decode 代码里显式的边界判断，
换成外层统一 catch + 回退 readerIndex。
```

### 2. 为什么它看起来像“永远可读”

`ReplayingDecoderByteBuf` 还做了一件很关键的事：在没有 terminate 之前，它的 `capacity()` 和 `readableBytes()` 会表现得像“几乎无限”，见 `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoderByteBuf.java:68` 与 `:499`。

这就是为什么子类 decode 可以写出这种近乎阻塞式的代码：

```text
先 readByte()
再 readInt()
再 readBytes(len)
```

它不需要每步都问“现在够不够”，因为一旦真不够，代理 buffer 会把这一步读操作截断成 `REPLAY` 信号。

### 3. `checkpoint()` 真正保存的不是“逻辑状态”，而是回退起点

`checkpoint()` 当前保存的是 `internalBuffer().readerIndex()`，见 `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:293`。

`checkpoint(state)` 则在保存回退点的同时更新 decoder 自己的状态字段，见 `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:301`。

这意味着它解决的不是“状态机好不好看”的问题，而是：

```text
如果我已经成功读过前一段，
那下次因为后半段不够而 REPLAY 时，
到底该回退到哪里重新尝试？
```

没有 checkpoint，你只能每次回到当前 frame 的最开头重新跑。复杂协议里，这会非常浪费。

有了 checkpoint，你就能把“已确认完成的前半段”变成新的安全起点。

### 4. `callDecode()` 比父类多出来的关键判据：没消费输入也没改状态，就算没推进

`ReplayingDecoder` 自己覆写了 `callDecode()`，见 `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:341`。

它和父类最大的不同，不只是 catch `REPLAY`，还多了一条约束：

- 如果本轮没有往 `out` 里加消息
- 同时 `readerIndex` 没变
- 同时 `state` 也没变

那就直接抛 `DecoderException`，见 `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:376`。

这条规则非常关键，因为在 `ReplayingDecoder` 语义里，“状态发生迁移”本身也算一种推进。

也就是说，当前实现允许这样一种合法情况：

```text
我这轮还没解出完整消息，
readerIndex 可能也没前进多少，
但我已经确认了协议状态从 READ_LENGTH 切到了 READ_PAYLOAD。
```

这和父类 `ByteToMessageDecoder` 只看“有没有消费输入/有没有产出输出”的判据，已经不完全一样了。

所以不能把 `ReplayingDecoder` 理解成单纯包一层异常；它连“什么叫推进”都重新定义了一点。

### 5. REPLAY 不是错误，而是“这一步现在先别继续了”

当前 `callDecode()` 在 catch 到 `Signal replay` 后，会先 `replay.expect(REPLAY)`，再把 `readerIndex` 回退到 checkpoint，最后 break，见 `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:387`。

这说明 `REPLAY` 的语义不是“坏数据”也不是“解码失败”，而是：

```text
这条路径此刻不能继续向前读；
先退回上一个安全点，等更多数据再来。
```

所以大纲里说“REPLAY Signal 不是异常”更准确的人话应该是：

```text
它在 Java 机制层面当然是抛出来的一个 Signal，
但在协议语义层面，它承担的是控制流角色，不是错误角色。
```

### 6. 它为什么不能被当成默认最优方案

如果只看可读性，`ReplayingDecoder` 的确很诱人。但当前注释已经把代价写得很清楚，见 `codec-base/src/main/java/io/netty/handler/codec/ReplayingDecoder.java:93`。

至少有三类代价不能忽略：

- 某些 `ByteBuf` 操作在 replayable buffer 上被禁止，直接 `UnsupportedOperationException`
- 网络慢、协议复杂时，同一段前缀可能被多次重复解码
- decode 里的副作用状态如果不自己回滚或清理，会因为多次重试而积累出错

所以它真正适合的，不是“所有协议都这么写更优雅”，而是：

```text
协议读取步骤很多、手动 readableBytes 判断会明显淹没主逻辑，
而你又能接受额外重试成本和受限 ByteBuf 语义时。
```

## 七、`MessageToByteEncoder`：出站对偶不是“把对象写出去”，而是“把对象生命周期收口成一段 encode→release→write 协议”

现在把入站拆包器收住，转到出站。

如果说前半篇回答的是“字节流怎么切成消息”，那 `MessageToByteEncoder` 回答的就是另一个对偶问题：

```text
业务已经拿着一个对象想往外写了，
到底谁来接管它，谁把它编码成 ByteBuf，
原对象又在什么时候结束生命周期？
```

当前类的核心字段其实不多：

- `matcher`
- `preferDirect`

见 `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:48`。

可真正关键的是 `write(...)` 主线，见 `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:99`。

### 1. 第一步不是 encode，而是先看“这个消息是不是归我处理”

`write(...)` 一开始先 `acceptOutboundMessage(msg)`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:94`。

如果不匹配，就直接 `ctx.write(msg, promise)` 传给下一个 outbound handler。

这一步说明 `MessageToByteEncoder` 的第一职责不是“凡是 write 都要编码”，而是：

```text
在整个 outbound pipeline 里，先筛出哪些对象类型由我负责。
```

因此它更像“类型定向的出站转换器”，而不是一个无条件接管所有 write 的总出口。

### 2. 第二步才是分配目标 `ByteBuf`，而且默认偏向 direct

如果消息匹配，就会调用 `allocateBuffer(ctx, cast, preferDirect)`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:105`。

默认实现里，如果 `preferDirect = true`，就用 `ctx.alloc().ioBuffer()`；否则用 `heapBuffer()`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:137`。

这和前面直接内存一章是连着的：

- 出站最终常常要走 socket I/O
- 因此默认优先 direct buffer，更贴近写通道路径

所以这里不是“随便 alloc 一个 out”，而是已经把典型出站 I/O 路径的默认偏好固化进父类。

### 3. 最容易被忽略的一步：`encode()` 外面一定套着 `finally { release(cast) }`

当前 `write(...)` 最关键的一层在这里：

- 先 `encode(ctx, cast, buf)`
- 再无论成功失败，都在 finally 里 `ReferenceCountUtil.release(cast)`

见 `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:106`。

这直接回答了完整性问题 #7：

```text
如果 encode 抛异常，原 msg 会泄漏吗？
当前实现里，不会；因为 release(cast) 在 finally 里。
```

这也是为什么不能把 `MessageToByteEncoder` 理解成只是“帮你调用一下 encode”。

它真正统一的是：

```text
一旦某个 outbound msg 被这个 encoder 接管，
那它的生命周期收尾也由这个 encoder 骨架统一负责。
```

### 4. 但这不等于“什么都不会泄漏”，而是“原 msg 与目标 buf 的清理边界被分开了”

这里还要更细一点。

虽然原 `msg` 会在 finally 里被 release，但目标 `buf` 的清理是另一层：外层 `finally` 里如果 `buf != null`，也会 `buf.release()`，见 `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:126`。

这说明当前实现把两个资源的所有权边界分开得很清楚：

- 原始 `msg`：一旦进入 `encode()`，其生命周期在 encoder 这里终结
- 输出 `buf`：如果已经成功交给 `ctx.write(...)`，就置为 `null` 交给下游；否则由当前 finally 自己回收

所以出站骨架真正成熟的点是：

```text
输入对象和输出 ByteBuf 的释放责任，不是混在一起碰运气，
而是按是否已经完成所有权转移分两层收口。
```

### 5. 为什么空 buffer 还要专门写 `Unpooled.EMPTY_BUFFER`

`encode()` 成功后，当前实现还会区分：

- `buf.isReadable()`：正常 `ctx.write(buf, promise)`
- 否则：release 当前空 `buf`，改写 `Unpooled.EMPTY_BUFFER`

见 `codec-base/src/main/java/io/netty/handler/codec/MessageToByteEncoder.java:112`。

这说明框架不想把“一个刚分配但什么都没写进去的空 ByteBuf”继续沿 pipeline 传播下去，而是把它规范化成共享的空缓冲区语义。

所以这里做的不是多余清洁，而是在统一一个更稳定的出站语义：

```text
如果本次编码结果为空，就不要把一个无意义的新 buffer 往后传；
直接用标准的 EMPTY_BUFFER 表达“写空内容”。
```

### 6. 这类编码器适合什么角色

到这里也更容易看清 `MessageToByteEncoder` 在 pipeline 里的定位。

它适合的是：

- 上游拿到的是高层对象
- 这一层只负责把对象线性编码成 `ByteBuf`
- 发送时序、flush 时机、后续聚合或压缩，并不由它自己决定

所以它和入站 frame decoder 的角色刚好构成对偶：

```text
入站：把一段段字节切成消息
出站：把一个个消息写成字节
```

真正的时序和生命周期骨架，仍然是 pipeline 和父类在管。

## 八、误解澄清：`return null`、`REPLAY`、DirectBuffer、strip 行为不是同一层概念

到这里，把这一篇最容易混在一起的几个误解统一拆开。

### 误解一：四种拆包器都在各自维护半包缓存

不是。

当前四种 decoder 都建立在 `ByteToMessageDecoder` 已经准备好的 cumulation 上。它们真正关心的是边界判定，不是“把半包放哪”。

### 误解二：`ReplayingDecoder` 比普通 `ByteToMessageDecoder` 更高级，因此应该优先选它

也不是。

它换来的是 decode 代码更像同步读取，但代价是：

- 可能重复解码前缀
- 受限 ByteBuf 操作更多
- 状态副作用要更小心

所以它不是升级版，而是另一种控制流取舍。

### 误解三：`LengthFieldBasedFrameDecoder` 的四参数靠背模板就行

不行。

如果不先搞清“长度字段的值到底表示哪一段长度”，只会在 `lengthAdjustment` 上不断试错。这个类真正需要理解的是整帧长度公式，而不是参数背诵。

### 误解四：`MessageToByteEncoder` 只管 encode，不管原消息生命周期

当前实现正相反。它最关键的一层之一，就是无论成功失败都统一 `release(cast)`。这也是它存在为父类骨架而不是子类工具函数的原因。

### 误解五：`DelimiterBasedFrameDecoder` 和 `LineBasedFrameDecoder` 只是名字不同

也不是。

前者是一般分隔符模型；后者是为 `\n` / `\r\n` 场景专门特化过的实现，还有扫描优化和安全注释边界。

## 九、收网：拆包器定义边界，编码器定义对象到字节的映射，而“积攒与循环骨架”仍然来自上一篇

现在把这一篇和上一篇真正接起来。

上一章解决的是：

```text
半包怎么攒
多消息怎么循环
重入和 remove 怎么兜住
```

这一章解决的是：

```text
入站 frame 的边界到底在哪里
出站对象什么时候变成字节
```

所以四种拆包器虽然长得不同，本质却很统一：

- `FixedLengthFrameDecoder`：边界由固定长度给出
- `DelimiterBasedFrameDecoder`：边界由结束符给出
- `LineBasedFrameDecoder`：边界由换行给出
- `LengthFieldBasedFrameDecoder`：边界要先通过长度字段推导

它们都没有重新接管半包生命周期；真正负责“等更多数据”的，仍是前一篇的 `ByteToMessageDecoder` 骨架。

而 `MessageToByteEncoder` 这条出站线也一样：

- 它不决定 flush 时机
- 不决定网络何时真正发送
- 它只是把“对象 -> ByteBuf -> release 原对象 -> write 出去”这一段统一成框架协议

所以这一篇真正该带走的话可以压成下面两句：

```text
拆包器不是重新管理 TCP 字节流，
而是在父类已经管好半包之后，专门回答“边界在哪里”。

编码器也不是发送器，
而是在 outbound pipeline 里专门回答“这个对象该怎么写成字节”。
```

有了这层骨架，再往上走到 HTTP、WebSocket 一类更复杂协议时，你就不会再把它们看成一堆名字很多的 codec 类，而会先问：

- 它的 frame 边界是哪一型
- 它的对象编码属于哪一层
- 哪些复杂度已经由通用骨架替它兜住

到了那一步，HTTP codec 也就不再是全新世界，而只是建立在这两篇已经打好的 Codec 地基之上的协议实现。