# Netty 无基线章纲（M16.0 主链生成）

## 项目根问题（Project Thesis）

1. 高并发 I/O 事件如何在尽量少的线程同步成本下被持续处理。
2. 网络缓冲区如何减少分配、复制和 GC 压力，同时保持可控的所有权语义。
3. 事件传播、异步回调和协议装配如何在统一执行骨架上协同工作，而不把业务层拖入底层复杂度。
4. 发送路径、背压和 flush 边界如何被工程化，避免“能跑”却不稳定的网络栈。

## 设计论题（Design Theses）

- 通过单线程 EventLoop / EventExecutor 降低 I/O 与任务调度中的同步成本。
- 通过 Channel / Unsafe / Pipeline 的分层，把传输细节、控制流和业务处理拆开。
- 通过 ByteBuf + PooledByteBufAllocator，把内存管理从 JVM 默认语义拉回到可控的工程语义。
- 通过 Future / Promise / task queue，把异步结果重新接回主执行骨架。
- 通过 codec / bootstrap / initializer，把上层协议和装配逻辑建立在核心机制之上，而不是反过来塑造主线。

## 书级章纲

### 卷一：执行骨架——Netty 为什么能成立

#### 1. EventLoop / EventExecutor：I/O、普通任务与定时任务为何必须共处一个执行骨架 `A`
- 关键点：
  - EventLoop 不只是线程模型，而是统一执行语义。
  - I/O 事件、普通任务、定时任务为什么要被揉到一起。
  - 这样做如何换来线程亲和、低同步成本和事件顺序保证。
- 覆盖痛点：R2, R4, R7, R9, R10, R17, R19

#### 2. Channel / Unsafe：公开 API 背后真正的 I/O 边界是什么 `A`
- 关键点：
  - Channel 的抽象边界和生命周期。
  - 为什么有一层用户不该直接碰的 Unsafe。
  - NIO transport 如何被吸进统一抽象。
- 覆盖痛点：R3, R4, R7, R10, R12, R20

#### 3. Pipeline / HandlerContext：Netty 的主控制面如何双向传播事件 `A`
- 关键点：
  - inbound / outbound 的方向语义。
  - Handler 和 Context 为什么必须分离。
  - add/remove/replace 为什么影响的不只是“链表结构”。
- 覆盖痛点：R5, R7, R10, R11, R13, R15

### 卷二：内存与发送路径——Netty 为什么快

#### 4. ByteBuf：索引模型、所有权与引用计数 `A`
- 关键点：
  - readerIndex / writerIndex 的认知模型。
  - ByteBuf 不只是 ByteBuffer 替代品，而是所有权模型。
  - retain / release 的工程语义和 leak 风险。
- 覆盖痛点：R8, R9, R14, R15, R16, R17, R19

#### 5. PooledByteBufAllocator：Arena / Chunk / Subpage 的层级分配体系 `A`
- 关键点：
  - 为什么池化不是“一个对象池”这么简单。
  - Arena / Chunk / Subpage 如何分层。
  - 这套结构到底换来了什么性能收益，又引入了什么理解成本。
- 覆盖痛点：R7, R9, R11, R13, R18, R19

#### 6. OutboundBuffer / write / flush：发送路径、背压与可写性边界 `A`
- 关键点：
  - write 和 flush 为什么分离。
  - OutboundBuffer 如何承接发送路径。
  - writability / 背压和内存占用之间的约束关系。
- 覆盖痛点：R10, R11, R14, R15, R16, R18

#### 7. 零拷贝与 CompositeByteBuf：发送优化到底省掉了什么 `B`
- 关键点：
  - FileRegion / sendfile 的价值边界。
  - CompositeByteBuf 如何避免复制。
  - 零拷贝不是“永远更快”，而是要看路径条件。
- 覆盖痛点：R8, R9, R18, R22

### 卷三：异步控制与横切机制——Netty 为什么可控

#### 8. Promise / Future / task queue：异步结果如何回到主执行骨架 `A`
- 关键点：
  - Promise / Future 不是 API 装饰，而是控制流结构。
  - listener、任务队列和 EventLoop 的回接关系。
  - 为什么异步结果不能脱离执行骨架理解。
- 覆盖痛点：R7, R9, R10, R14, R17

#### 9. FastThreadLocal / Recycler / LeakDetector：高性能工程机制如何横切全局 `A`
- 关键点：
  - 这些组件为什么看起来分散，却共同决定系统可控性。
  - FastThreadLocal、Recycler、LeakDetector 各自解决什么问题。
  - 为什么它们必须单独成章，而不是散落在局部模块说明里。
- 覆盖痛点：R11, R13, R15, R16, R18, R22

#### 10. 横切专题：线程亲和、引用计数、背压三条理解轨 `A`
- 关键点：
  - 哪些概念在多个章节重复出现。
  - 如何把“局部理解”提升成“系统级直觉”。
  - 为什么学 Netty 真正难的不是模块数，而是这些横切约束。
- 覆盖痛点：R11, R13, R22, R23

### 卷四：装配层与上层协议——主线之上的系统组织

#### 11. Bootstrap / ServerBootstrap / ChannelInitializer：系统如何被装配起来 `B`
- 关键点：
  - Bootstrap 不是主机制，而是装配层。
  - parentGroup / childGroup 的职责边界。
  - ChannelInitializer 为什么是连接主线机制与应用逻辑的关键钩子。
- 覆盖痛点：R3, R5, R12, R24

#### 12. Codec：协议抽象如何建立在 Pipeline + ByteBuf 上 `B`
- 关键点：
  - codec 为什么应该排在 ByteBuf / Pipeline 之后。
  - ByteToMessageDecoder / MessageToMessageCodec 的抽象价值。
  - 协议装配如何复用主线机制，而不是另起炉灶。
- 覆盖痛点：R4, R5, R9, R12, R22

#### 13. HTTP / HTTP2 / timeout / websocket：外围协议与应用层能力 `C`
- 关键点：
  - 这些内容为什么属于外围层，不应抢主线位置。
  - 它们如何建立在主线机制之上。
  - 应用层案例的学习价值边界。
- 覆盖痛点：R3, R12, R24

### 卷五：真正难学和真正值钱的部分

#### 14. 高风险误区：哪里最容易学错、用错、排障失败 `A`
- 关键点：
  - 把 API 当机制。
  - 不理解引用计数所有权。
  - 不理解 flush / write 的边界。
  - 把 EventLoop 当普通线程池。
- 覆盖痛点：R14, R15, R16, R23

#### 15. 历史演进：哪些是核心，哪些只是兼容层 `B`
- 关键点：
  - 兼容层与主路径的区分。
  - 为什么时间维度会改变你对“核心机制”的判断。
- 覆盖痛点：R20, R21

#### 16. 可迁移思想：从 Netty 学到哪些系统设计原则 `B`
- 关键点：
  - 单线程执行骨架
  - 分层抽象与 Unsafe 边界
  - 所有权模型
  - 背压与发送路径
  - 横切机制显式化
- 覆盖痛点：R22, R24

#### 17. 费曼式自测：如何确认自己真的学会了 Netty `B`
- 关键点：
  - 能不能不用背 API，就解释主线机制为什么成立。
  - 能不能从症状反推出可能的源码位置。
  - 能不能把 Netty 的思想迁移到别的中间件。
- 覆盖痛点：R23, R24

## 评审结论

这版大纲相比 low 版的提升：

1. 不再以“概述/入门/案例”作为主线。
2. 把 ByteBuf、Allocator、OutboundBuffer、横切机制提升到了真正核心位置。
3. 明确区分了：
   - 执行骨架
   - 内存与发送路径
   - 异步控制与横切机制
   - 装配层与外围协议
   - 风险、演进与迁移
4. 把“源码学习为什么难”的核心难点显式变成章节，而不是散落注释。
