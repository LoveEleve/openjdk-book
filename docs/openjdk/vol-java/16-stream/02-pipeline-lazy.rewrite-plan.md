# 16-stream/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `AbstractPipeline`、`ReferencePipeline`、`Sink`、`ReduceOps`、`ForEachOps`。本文聚焦 Pipeline 链、Sink 链、`evaluate`、`wrapSink`、`copyInto` / `copyIntoWithCancel`、`opWrapSink` 与终端触发；并行路径和具体中间/终端实现细节放到后续篇章。
> 目标：把“流水线结构与惰性机制”改写成一篇围绕“为什么 Stream 中间操作看起来在连着调用，实际上直到终端操作之前都只是在构建一张静态图；真正执行时，又是怎样把这张图翻译成一条逐元素消费链”的机制文章。

## 1. 读者困惑

- 上一篇已经知道中间操作惰性，但它们在内存里到底被表示成什么？
- 为什么 `filter().map().sorted()` 这串调用在终端操作之前完全不碰源数据？
- `AbstractPipeline` 为什么要同时保存 `previousStage`、`nextStage`、`sourceStage`、`depth`、`linkedOrConsumed`？
- `Sink` 链和 Pipeline 链是什么关系，为什么要维护两条链？
- 为什么说数据通常只单遍流过整条管道，而不是每个中间操作都各扫一遍？
- 短路操作为什么能在中途停下，它是在哪条链上生效的？

## 2. 一句话顿悟

**Stream 的惰性秘密不在“它没执行”，而在于它把构建期和执行期彻底分开：构建期是一条 Pipeline 链，只记录有哪些操作、前后关系和标志；执行期则把这些节点反向包成一条 Sink 链，由终端操作调用 `evaluate` 真正驱动数据从源 Spliterator 单遍流过。中间操作之所以惰性，是因为它们构建期只挂节点，不碰元素；终端操作一来，Pipeline 描述才会被翻译成可执行的消费管道。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `AbstractPipeline` 的链式字段、`linkedOrConsumed`、`Sink` 生命周期、`opWrapSink`、`wrapSink`、`evaluate` / `copyInto` / `copyIntoWithCancel` 等关键点。
- 已明确给出 Pipeline 链 vs Sink 链这两层抽象，是很好的主抓手。
- 已把具体中间操作、终端实现与并行路径留到后续篇章，边界划分合理。

### 必须重写

- 旧稿偏源码导读，需要先建立统一主问题：为什么中间操作不碰数据，直到终端把两条链焊起来。
- Pipeline 链和 Sink 链要讲成“静态图纸 vs 运行时消费管道”的分工，而不是两组结构清单。
- `linkedOrConsumed` 的异常语义要回到“为什么一个 Stream 不能重复接两次链/重复消费”这个真实问题里。
- `evaluate` / `wrapAndCopyInto` 应讲成从描述转执行的收口总图。
- 短路应作为执行期控制流补充，而不是散落提一句。

## 4. 理解路径

### 第一节：从“为什么不 collect 时什么都没扫”继续往下问

承接上一篇：中间操作惰性已经知道，但继续追问——如果它们没执行，那每次 `filter()` 到底返回了什么？引出本文总问题：这些调用只是挂节点，不是处理元素。

### 第二节：Pipeline 链为什么像一张静态图纸

证据：
- `AbstractPipeline.java:82`：`sourceStage`
- `AbstractPipeline.java:88`：`previousStage`
- `AbstractPipeline.java:101`：`nextStage`
- `AbstractPipeline.java:123`：`sourceSpliterator`
- `AbstractPipeline.java:135`：`linkedOrConsumed`
- `AbstractPipeline.java:201-213`：中间节点构造器

主线：
- 每个中间操作 new 一个新节点，并把自己挂到前驱后面。
- 构造器只做链路连接、标志合成、深度计数，不碰源元素。
- `linkedOrConsumed` 负责禁止重复链接/重复消费，说明 Stream 不是可随意反复复用的数据结构。

### 第三节：为什么 `filter` / `map` 这样的中间操作只是在提供“配方”

证据：
- `ReferencePipeline.java:162-167`：`filter`
- `ReferencePipeline.java:186-191`：`map`
- `ReferencePipeline.java:437`：`peek`

主线：
- 这些方法在注册期主要做参数校验和 new 一个 `StatelessOp` 节点。
- 真正的过滤/映射逻辑并没有在调用点执行，而是被包进后续 `opWrapSink` 的配方里。
- 这要作为“惰性”的具体证据，而不是口号。

### 第四节：Sink 链为什么是执行期才出现的消费管道

证据：
- `Sink.java:128/138/147`：`begin` / `end` / `cancellationRequested`
- `Sink.java:244-263`：`ChainedReference`
- `ReferencePipeline.java:167-180`：filter 的 `opWrapSink`
- `ReferencePipeline.java:191-199`：map 的 `opWrapSink`

主线：
- Sink 定义的是“元素来了以后怎么处理”的运行时协议：begin → accept × N → end。
- ChainedReference 让每个节点都持有 downstream，把上游逻辑包在下游外面，形成真正的数据消费链。
- filter/map 的业务逻辑都藏在 `opWrapSink` 里，说明中间操作在执行期才真正变成行为。

### 第五节：为什么终端操作一来，Pipeline 链才会被翻译成 Sink 链

证据：
- `AbstractPipeline.java:226-234`：`evaluate`
- `AbstractPipeline.java:518-522`：`wrapSink`
- `AbstractPipeline.java:473-476`：`wrapAndCopyInto`
- `AbstractPipeline.java:479-490`：`copyInto`
- `AbstractPipeline.java:494+`：`copyIntoWithCancel`

主线：
- `evaluate` 是从“静态描述”切到“真正执行”的总开关。
- `wrapSink` 沿 previousStage 反向包裹，把终端 sink 一层层套上中间操作逻辑。
- `copyInto` 再用源 Spliterator 驱动 begin → accept → end，完成单遍消费。
- 这要收成“终端操作把两条链焊在一起”这张总图。

### 第六节：为什么终端操作不是都一样，它们只是提供不同的链底 sink

证据：
- `ReduceOps.java:156`：`makeRef(Collector...)`
- `ReduceOps.java:911`：`evaluateSequential`
- `ForEachOps.java:132`：`ForEachOp`
- `ForEachOps.java:148`：`evaluateSequential`

主线：
- collect/reduce/forEach 的区别，不是前面链怎么构，而是最后谁来当终端 sink。
- 一旦终端 sink 准备好，前面的 Pipeline 节点就能统一反向包起来执行。
- 这说明“终端触发”不仅是开始执行，更是在提供链底的消费语义。

### 第七节：短路为什么能在执行期生效

证据：
- `AbstractPipeline.java:484-488`：SHORT_CIRCUIT 检查与 `copyIntoWithCancel`

主线：
- 短路不是 Pipeline 构建期就提前结束，而是在执行期通过 `cancellationRequested` 协议决定是否继续推进元素。
- 这把上一章的短路分类和本章的执行骨架真正接起来。

## 5. 失败方案清单

1. 把中间操作当成立刻扫数据的执行动作，而不是节点注册。
2. 以为 Stream 可以像集合一样被随意重复挂链和重复消费。
3. 把 Pipeline 链和 Sink 链当成同一层结构，只是叫法不同。
4. 认为每个中间操作都要单独遍历一次源数据。
5. 忽略终端操作的角色，以为它只是“最后取结果”而不是整个执行入口。
6. 把短路理解成 API 层描述，不理解它在执行时如何真正停流。

## 6. 误解清单

1. Stream 的惰性只是一种优化，和结构设计无关。
2. `linkedOrConsumed` 只是防御式编程，不影响真实使用模型。
3. Sink 只是 Consumer 的另一个名字，没有额外生命周期协议。
4. collect/reduce/forEach 的差别主要在前面中间操作，而不在终端 sink。
5. 单遍消费只是经验结论，不是 Stream 内部结构必然结果。
6. 短路终端/中间操作和普通终端/中间操作只在 API 名字上不同。

## 7. 证据清单

- `AbstractPipeline.java:82`：`sourceStage`
- `AbstractPipeline.java:88`：`previousStage`
- `AbstractPipeline.java:101`：`nextStage`
- `AbstractPipeline.java:123`：`sourceSpliterator`
- `AbstractPipeline.java:135`：`linkedOrConsumed`
- `AbstractPipeline.java:201-213`：节点构造器
- `AbstractPipeline.java:226-234`：`evaluate`
- `AbstractPipeline.java:473-476`：`wrapAndCopyInto`
- `AbstractPipeline.java:479-490`：`copyInto`
- `AbstractPipeline.java:494+`：`copyIntoWithCancel`
- `AbstractPipeline.java:518-522`：`wrapSink`
- `Sink.java:128`：`begin`
- `Sink.java:138`：`end`
- `Sink.java:147`：`cancellationRequested`
- `Sink.java:244-263`：`ChainedReference`
- `ReferencePipeline.java:162-167`：`filter`
- `ReferencePipeline.java:167-180`：filter `opWrapSink`
- `ReferencePipeline.java:186-191`：`map`
- `ReferencePipeline.java:191-199`：map `opWrapSink`
- `ReferencePipeline.java:437`：`peek`
- `ReferencePipeline.java:568`：`collect`
- `ReduceOps.java:156`：`makeRef`
- `ReduceOps.java:911`：`evaluateSequential`
- `ForEachOps.java:132`：`ForEachOp`
- `ForEachOps.java:148`：`evaluateSequential`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦串行主线与惰性结构，不展开并行流水线和 Spliterator 驱动细节，那些留给后续篇章。
- 不把 Sink 细节扩成完整所有原始类型分支教程，重点放在 ChainedReference 和统一协议。
- 不把 ReduceOps / ForEachOps 扩写成 Collector 教程，后续专章再讲。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么中间操作只是挂 Pipeline 节点 → 为什么终端操作才触发 evaluate → 为什么执行期要把节点反向包成 Sink 链 → 为什么数据通常单遍流过整条管道 → 短路是怎样在执行期真正停下的”。
- 必须把 Pipeline 链和 Sink 链讲成‘图纸 vs 消费管道’的分工。
- 必须把终端操作讲成执行开关，而不是结果读取器。
- 必须自然引到 `03-intermediate-ops.md`。
