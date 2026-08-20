# Ch7-03 出站与写缓冲区 — 六轮 Review Notes

## 第一轮：事实核对

已核对正文中的关键源码引用。

| 结论 | 证据 | 结果 |
|---|---|---|
| `write/flush/writeAndFlush` 的 outbound 传播路径 | `AbstractChannelHandlerContext.java:741-841` | ✅ |
| pipeline 出站入口从 tail 发起 | `DefaultChannelPipeline.java:987-1044` | ✅ |
| head 最终落地到 `unsafe.write/flush` | `DefaultChannelPipeline.java:1385-1391` | ✅ |
| `ChannelOutboundBuffer` 的三指针与 flushed 计数 | `ChannelOutboundBuffer.java:76-85` | ✅ |
| `addMessage` 挂链、touch、增加 pending bytes | `ChannelOutboundBuffer.java:114-140` | ✅ |
| `addFlush` 把 unflushed 段整体迁入 flushed | `ChannelOutboundBuffer.java:146-170` | ✅ |
| `remove/remove(Throwable)` 的释放、promise 完成和 pending bytes 扣减 | `ChannelOutboundBuffer.java:275-345` | ✅ |
| progress 更新 progressive promise | `ChannelOutboundBuffer.java:247-268` | ✅ |
| `nioBuffers()` 聚集写数组、缓存与扩容 | `ChannelOutboundBuffer.java:414-551` | ✅ |
| `NIO_BUFFERS` 初始 1024，按需翻倍 | `ChannelOutboundBuffer.java:67-72`、`:517-534` | ✅ |
| `maxCount/maxBytes` 的约束 | `ChannelOutboundBuffer.java:427-460` | ✅ |
| `unwritable` 掩码、高低水位、用户自定义可写位 | `ChannelOutboundBuffer.java:92-104`、`:176-207`、`:554-616` | ✅ |
| writability 变化回到 pipeline / eventLoop | `ChannelOutboundBuffer.java:618-660` | ✅ |
| Entry 的 Recycler、pendingSize、cancel/recycle | `ChannelOutboundBuffer.java:826-898` | ✅ |

### 深审发现

1. **低风险：`tailEntry` 表述需要更精确。** 当前实现里的 `tailEntry` 不是独立尾哨兵，而是“最后一个实际 Entry 的引用”。已修正文案，避免与 Pipeline 的 head/tail 哨兵概念混淆。
2. **无高风险事实错误。** write/flush 分离、聚集写、progress、反压路径与当前源码一致。✅

## 第二轮：因果审

- `write` 不立即打到 Socket -> 先挂到 outbound buffer：✅
- `flush` 把 unflushed 段整体变成可写出批次：✅
- Entry 同时保存 msg/promise/size/progress -> 因为写出、失败、取消、释放和进度都在这里汇合：✅
- `nioBuffers()` 收集 ByteBuffer 视图 -> 为聚集写减少拼接复制和 syscall 次数：✅
- `totalPendingSize` 超过高水位 -> 不阻塞线程，而是切换 writability 状态并通知 pipeline：✅

因果链完整，没有把“write 语义”和“底层写出时机”混成一步。✅

## 第三轮：结构审

正文按“write 之后去哪 -> outbound 传播 -> 三指针链 -> Entry -> `nioBuffers()` -> 反压 -> 收网”推进，符合理解路径。✅

没有被 `ChannelOutboundBuffer` 大类文件顺序牵着走，而是围绕用户最困惑的 `write/flush` 语义组织。✅

## 第四轮：读者审

删掉代码块后，主线仍可复述：

- `write` 只是声明一条待发送操作。
- `flush` 才把这批操作推进到底层写出阶段。
- `ChannelOutboundBuffer` 用 Entry 链管理消息、promise、pending bytes 和进度。
- `nioBuffers()` 收集视图供聚集写。
- 高低水位通过 writability 反馈反压。

误解澄清覆盖 write/flush、`nioBuffers()`、高水位、1024 容量与 zero-copy 边界。✅

## 第五轮：边界审

- 已明确 `write()` 本身不保证立刻 I/O。✅
- 已明确 `nioBuffers()` 复用数组不可长期逃逸。✅
- 已明确聚集写不是“所有平台都零拷贝到底层”的绝对口号。✅
- 已明确高低水位是状态反馈，不是同步阻塞。✅
- 已明确 `tailEntry` 只是尾引用，不与 Pipeline 哨兵混淆。✅
- 未提前展开 PendingWriteQueue/initializer 生命周期。✅

## 第六轮：依赖审

- Ch7-01 Pipeline 骨架、Ch7-02 outbound handler 类型、Ch4 ByteBuf、Ch6 Promise 都已正确复用。✅
- Ch7-04 只作桥接，没有提前透支 handler 生命周期与 initializer。✅
- 没把 ChannelOutboundBuffer 细节外推到所有 transport 实现。✅

## 机械检查

- 禁用词：未发现。✅
- 源码引用：全部核对通过。✅
- 删码测试：正文主线仍成立。✅
- 总行数：约 430。
- 去码后字符数：约 7,980。
- 去码去空白后字符数：约 7,140。
- 对出站写缓冲专题篇已形成闭环。✅

## 结论

Ch7-03 六轮 review 完成，深审修正 1 处 `tailEntry` 表述边界。可进入 Ch7-04 初始化与生命周期。
