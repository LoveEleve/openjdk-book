# Ch10-01 `01-bytetomessagedecoder.md` review notes

## 第一轮：事实核对

### 已核对的核心结论

1. `ByteToMessageDecoder` 当前默认使用 `MERGE_CUMULATOR`，同时提供 `COMPOSITE_CUMULATOR` 两种积攒策略，证据：`codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:83`、`:123`、`:170`。
2. `MERGE_CUMULATOR` 在 `cumulation` 为空且 `in.isContiguous()` 时会直接返回 `in`；在写入失败或正常路径结束时都负责释放 `in`，证据：`codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:91`。
3. `COMPOSITE_CUMULATOR` 当前不是简单“总是零拷贝”，而是优先复用 `CompositeByteBuf` 或新建 composite，并在失败时释放未接管的 `in` 与新建 composite，证据：`codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:137`。
4. `channelRead(...)` 当前主线确实是：`CodecOutputList.newInstance()` -> `cumulator.cumulate(...)` -> `callDecode(...)` -> finally 收尾释放/丢弃/分发/回收，证据：`codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:285`。
5. `callDecode(...)` 当前通过 `oldInputLength`、`out.isEmpty()`、`ctx.isRemoved()` 和 `singleDecode` 共同决定是否继续循环；当“产出消息但没消费输入”时抛 `DecoderException`，证据：`codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:464`。
6. `decodeRemovalReentryProtection(...)` 当前通过 `STATE_CALLING_CHILD_DECODE` / `STATE_HANDLER_REMOVED_PENDING` 保护 decode 期间的 remove/reentry，证据：`codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:163`、`:541`。
7. reentrant `channelRead` 当前不会递归立即处理，而是进入 `inputMessages` 队列，等外层 do/while 再 poll 处理，证据：`codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:167`、`:333`。
8. `discardAfterReads` 当前默认值是 16，并在 `numReads` 达阈值后调用 `discardSomeReadBytes()`；该方法仅在 `cumulation != null && !first && cumulation.refCnt() == 1` 时执行，证据：`codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:191`、`:316`、`:377`。
9. `channelInactive()` 与 `ChannelInputShutdownEvent` 都会汇入 `channelInputClosed()`，在必要时触发 `decodeLast()`，证据：`codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:390`、`:395`、`:406`、`:566`。
10. `CodecOutputList` 当前通过 `FastThreadLocal` 缓存每线程 16 个实例，`newInstance()` 取、`recycle()` 还，证据：`codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:38`、`:93`、`:192`。
11. 测试 `reentrantReadSafety()`、`reentrantReadThenRemoveSafety()`、`testRemoveWhileInCallDecode()` 共同证明了当前父类对 decode 中重入/移除的保护语义，证据：`codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:217`、`:688`、`:720`。
12. 测试 `releaseWhenMergeCumulateThrows*` 与 `releaseWhenCompositeCumulateThrows()` 说明 cumulator 当前非常重视异常路径 release 边界，证据：`codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:345`、`:365`、`:416`。

### 已纠正的大纲偏差

- 大纲把 `callDecode` 说成“return null 等更多数据”，当前源码事实不是返回值驱动，而是“输入是否被消费 + 输出是否产生”驱动；正文已明确纠正。
- 大纲把“三级状态机重入保护”容易讲成单纯 child decode 内部状态；正文明确限定为框架自身安全状态，而非协议状态。

## 第二轮：因果审

### 因果链是否成立

1. “父类统一接管半包积攒，而不是让子类各自维护 buffer” 的结论由 `channelRead -> cumulator -> callDecode` 主线直接支撑，成立。
2. “`callDecode()` 真正看的是消费量而不是返回值” 有直接源码依据，因为 `decode()` 根本无返回值，循环控制依赖 `out` 与 `readableBytes` 变化，成立。
3. “`out` 非空但输入不变会被视为子类违约” 由直接抛 `DecoderException` 的实现支撑，成立。
4. “重入保护防的不是多线程，而是 decode 调用栈内部再次触发 inbound 事件” 由 `inputMessages` 队列路径与 reentrant tests 支撑，成立。
5. “`discardSomeReadBytes()` 要看 `refCnt == 1` 是为了避免共享视图场景下重整底层存储” 由源码注释直接支撑，成立。

### 需保持克制的地方

- 正文没有把 COMPOSITE 写成“一定更适合大消息”的绝对规律，只说它把拷贝成本换成更复杂索引结构，符合当前源码证据边界。
- 对 `CodecOutputList` 的描述限定为性能辅助结构，没有夸大成协议语义的一部分。

## 第三轮：结构审

### 结构是否按理解路径推进

当前结构：

1. 从 TCP 字节流没有消息边界切入。
2. 先推演 3 个失败方案，说明为什么需要统一骨架。
3. 再讲 `channelRead()` 主线。
4. 再拆 cumulator 两策略。
5. 再进入最核心的 `callDecode()` 循环条件。
6. 然后讲重入/移除保护。
7. 再补长期运行边界：discard 与 decodeLast。
8. 最后才收 `CodecOutputList` 和篇末桥接。

这符合“问题 -> 失败 -> 顿悟 -> 机制 -> 回收”，没有按源码文件顺序机械翻译。

### 结构风险检查

- 没有在第一篇就提前展开具体拆包器参数，避免主线被例子牵走。
- 重入/移除保护放在 `callDecode()` 之后，有助于读者先建立正常流程，再理解保护层为何存在。
- `CodecOutputList` 放在后面作为性能补充，不抢主线。

## 第四轮：读者审

### 删掉代码块后是否仍成立

删掉代码块后，正文仍可复述：

1. 为什么需要 cumulation。
2. 为什么父类循环以“输入是否被消费 / 输出是否被产出”为判据。
3. 为什么 decode 中的 reentrant read / remove 会危险。
4. 为什么 discard 与 decodeLast 是长期运行边界，而不是枝节。
5. 为什么 `CodecOutputList` 也值得被骨架统一管理。

代码块仅作证据位，不承担叙事骨架。

### 可能的阅读负担点

- `callDecode()` 的若干 break/continue 条件较多；正文已按“out 空/非空 + 输入是否变化”四格逻辑拆开，减轻机械感。
- `decodeRemovalReentryProtection` 名字较重；正文已先讲“真正危险是什么”，再落实现细节。

## 第五轮：边界审

### 已明确边界

1. 本篇不展开具体拆包器参数和协议例子，留给下一篇。
2. 本篇不讲 `MessageToByteEncoder` 路径。
3. 本篇不把 `ReplayingDecoder` 混入主叙事，只在桥接处导航。
4. 本篇不把 `CodecOutputList` 误写成协议层概念。

### 失败路径与风险覆盖

- 已覆盖：cumulator 异常时 release 边界。
- 已覆盖：decode 中 remove/reentrant read 的状态保护。
- 已覆盖：子类“产出消息但不消费输入”的死循环风险。
- 已覆盖：连接关闭或输入半关闭时尾料收尾。
- 已覆盖：共享视图场景下 discard 的安全边界。

### Bug / issue 候选检查

本轮未形成新的可证实缺陷候选：

- `callDecode()` 的循环与异常语义在测试层有充分覆盖，未观察到本文范围内契约-实现反转。
- cumulator 异常路径和 remove/reentrant path 都有专门测试托底，当前阅读没有发现新漏洞证据链。
- `discardAfterReads=16` 是策略参数，不是可直接定性的错误常数。

结论：本篇未发现需要单列 issue 候选的真实缺陷。

## 第六轮：依赖审

### 前置依赖检查

- Ch4 ByteBuf：本篇硬依赖 readerIndex/refCnt/共享视图边界。
- Ch7 Pipeline：本篇硬依赖 `fireChannelRead`、handler remove、inbound 传播模型。
- Ch9 Bootstrap：本篇硬依赖 child pipeline 已装配好的上下文。
- Ch8 生命周期：本篇软依赖 ByteBuf 所有权与 release 纪律。

### 后续桥接检查

- 篇末桥到 Ch10-02，只说“具体拆包器只是实现 decode() 边界判断”，没有提前使用其细节结论。
- 没有把 HTTP 等后续域当前置事实。

## 机械检查

### 禁用词扫描目标

- 此处不再赘述
- 不再展开
- 类似地
- 同理
- 依此类推
- 篇幅所限
- 显然
- 容易看出
- 细节读者自行阅读源码

预期：正文不命中偷懒词。

### 行号引用复核目标

重点复核：

- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:285`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:464`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:541`
- `codec-base/src/main/java/io/netty/handler/codec/ByteToMessageDecoder.java:574`
- `codec-base/src/main/java/io/netty/handler/codec/CodecOutputList.java:93`
- `codec-base/src/test/java/io/netty/handler/codec/ByteToMessageDecoderTest.java:688`

### 删码测试目标

删除全部 fenced code block 后，正文仍应保留：

- `channelRead -> cumulator -> callDecode` 主骨架
- MERGE / COMPOSITE 的取舍边界
- `callDecode` 的消费量判据
- 重入 / remove / input closed 收尾边界
- `CodecOutputList` 的性能辅助角色
