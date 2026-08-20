# Ch15-02 io_uring 原生传输：IoUringIoHandler、AbstractIoUringChannel、IoUringSocketChannel — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `IoUringIoHandler` 当前是 `IoHandler` 的 Linux io_uring 实现，内部直接维护 ringBuffer、buffer rings、eventfd、timeout memory、iovArray、pendingOps 等 completion-oriented 结构，证据：`transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringIoHandler.java:51`。  
2. `run(context)` 当前在无 completion 且允许阻塞时会提交 eventfd 读并等待 completion；否则直接尝试提交/清理队列，再处理 completion queue，证据：`transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringIoHandler.java:151`。  
3. `handle(...)` 当前区分 eventfd token、ringfd token、fast path 与 slow path completion，说明 io_uring 承载层围绕“已提交操作的完成结果”组织，证据：`transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringIoHandler.java:280`。  
4. `AbstractIoUringChannel` 当前显式维护 pollIn/out/rdhup、write/read/connect scheduled 等状态位，以及 outstanding reads/writes、delayedClose、connectPromise/timeout 等，证据：`transport-classes-io_uring/src/main/java/io/netty/channel/uring/AbstractIoUringChannel.java:73`。  
5. `autoReadCleared()` 当前不仅清 `readPending`，还会取消 outstanding reads，说明 completion-oriented 模型下需要撤回已提交但未完成的操作，证据：`transport-classes-io_uring/src/main/java/io/netty/channel/uring/AbstractIoUringChannel.java:162`。  
6. `IoUringSocketChannel` 当前在 zero-copy 条件满足时会走 `send_zc/sendmsg_zc` 分支，而不是普通 write，证据：`transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringSocketChannel.java:79`、`:109`。  
7. `handleWriteCompleteZeroCopy(...)` 当前在 `IORING_CQE_F_MORE` 标志下会把 `ByteBuf` retain 并放进内部队列，等待后续 notification 再释放，证据：`transport-classes-io_uring/src/main/java/io/netty/channel/uring/IoUringSocketChannel.java:191`。  
8. `IoUringEventLoopTest` 当前证明 `MultiThreadIoEventLoopGroup + IoUringIoHandler.newFactory()` 仍然保留任务提交、schedule、shutdown 主线语义，证据：`transport-native-io_uring/src/test/java/io/netty/channel/uring/IoUringEventLoopTest.java:36`。  
9. `CombinationOfEpollAndIoUringTest` 当前证明 epoll 与 io_uring 可并列加载，说明它们是并列承载实现而不是互斥重写，证据：`transport-native-io_uring/src/test/java/io/netty/channel/uring/CombinationOfEpollAndIoUringTest.java:24`。  
10. `IoUringSocketConditionalWritabilityTest` 当前说明切换到底层承载模型后，条件 writability 主线仍然保持，证据：`transport-native-io_uring/src/test/java/io/netty/channel/uring/IoUringSocketConditionalWritabilityTest.java:28`。

### 深审发现

1. **高风险：容易把 io_uring 写成“更快 epoll”。** 正文已改成 completion-oriented 承载层模型。  
2. **中风险：容易写漏 outstanding read/write/connect 状态位的重要性。** 正文已把它们归为“已提交但未完成”的 Channel 状态机。  
3. **中风险：容易把 zero-copy 当成纯性能开关，忽略延迟 release 边界。** 正文已单独立节说明 `IORING_CQE_F_MORE` 路径。  
4. **低风险：容易把平台测试外推成通用性能结论。** 正文只把它们当作“主线不变、承载模型换了”的证据。

## 第二轮：因果审

- epoll 是 readiness-oriented，io_uring 是 completion-oriented -> 承载层中心必须从事件掩码切到 ring/completion/pendingOps：✅  
- 先提交再收结果 -> Channel 必须显式跟踪 outstanding I/O 状态：✅  
- zero-copy completion 可能分多阶段到达 -> buffer release 不能和单次写完成简单画等号：✅  
- 平台承载层变化不应重写上层 Pipeline/Promise/HTTP2 主线：✅

## 第三轮：结构审

正文结构按“先和 epoll 划边界 -> IoUringIoHandler 中心 -> AbstractIoUringChannel -> IoUringSocketChannel zero-copy -> 测试回读 -> 收网”推进，没有按类文件顺序平铺。✅

失败/误解已覆盖：
- io_uring 只是更快 epoll  
- 切到 io_uring 后上层主线全要重学  
- zero-copy 不影响 release 边界  
- outstanding I/O 状态只是噪声  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- io_uring 替换的是提交/完成模型，不是上层 Channel 主线  
- IoUringIoHandler 为什么是中心  
- AbstractIoUringChannel 为什么必须跟踪许多 outstanding 状态  
- IoUringSocketChannel 的 zero-copy 为什么会放大延迟 release 边界  
- 为什么测试共同证明“主线没变，承载模型换了”  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未展开 native C / liburing 细节。✅  
- 未把 io_uring 写成平台性能定论。✅  
- 未重讲上层 Promise/Pipeline/HTTP2 主线。✅  
- 未把 zero-copy 路径写成总是启用。✅

## 第六轮：依赖审

- 依赖 Ch15-01 epoll 平台篇、Ch5 EventLoop、Ch7 出站主线、Ch4 ownership 前置，真实存在。✅  
- 与后续平台调优/实测专题分工清晰。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 8,358。  
- 去掉常见 markdown 标记后的字符数：约 8,136。  
- 目标定位：平台专题篇，已形成独立闭环。✅

## 结论

当前正文已经建立 io_uring 平台专题的核心边界：替换 I/O 提交与完成模型，不重写上层主线。本篇不承担 liburing / native C 细节的深入展开；那部分如需扩写，应另开 native 深挖专题。Ch15-02 可作为后续平台对照总结和实测调优专题的直接前置篇。