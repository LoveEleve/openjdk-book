# 16-stream/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `TerminalOp`、`ReduceOps`、`ForEachOps`、`FindOps`、`MatchOps`、`ReferencePipeline`。本文聚焦终端操作分类、`evaluate` 触发、归约 sink、短路终端、`allMatch/anyMatch/findFirst/count/collect` 的求值骨架；并行 collector 细节与收集器特征放到下一篇。
> 目标：把“终端求值”改写成一篇围绕“终端操作不是链末尾顺手拿个结果，而是整条流水线真正开始执行、并决定如何收口结果与何时停止遍历的那一刻”的机制文章。

## 1. 读者困惑

- 中间操作已经把 Pipeline/Sink 链搭好了，终端操作到底又额外决定了什么？
- `collect`、`reduce`、`forEach`、`findFirst`、`anyMatch` 看起来都只是“最后一步”，为什么内部实现分成几大家族？
- `collect` 的 supplier/accumulator/combiner 为什么刚好构成一套并行归约框架？
- `count()` 为什么有时根本不遍历元素就能返回结果？
- `anyMatch` / `findFirst` 为什么能提前停，而 `collect` 通常必须走完全程？
- “终端操作按下开关”到底在源码里具体是哪一步？

## 2. 一句话顿悟

**终端操作不是 Stream 链最后随手挂的一个方法，而是真正把整条 Pipeline 描述转成执行的总开关：它一方面通过 `TerminalOp` 决定链底 sink 是归约、遍历、匹配还是查找；另一方面通过 `evaluate` / `wrapAndCopyInto` 驱动源数据流过整条 Sink 管道。不同终端操作的核心差异，不在前面中间链怎么建，而在最后谁来收口结果、谁能请求提前停流。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖四大终端家族、`TerminalOp`、`ReduceOps`、`MatchOps` / `FindOps`、`collect` 的三段式归约框架以及 `count` 的 SIZED 快路径。
- 已抓到 `collect(toList())` 的完整 evaluate 时序，这是很强的主抓手。
- 已把 Collectors 独立放到下一篇，边界划分合理。

### 必须重写

- 旧稿偏“终端家族说明书”，需要先建立总问题：终端操作真正决定的是收口语义和停流语义。
- 归约框架要强调“为什么 supplier/accumulator/combiner 恰好支持并行切分再合并”，而不只是三段式背诵。
- `anyMatch` / `findFirst` 等短路终端要更明确地回扣前一篇的 cancellation 协议。
- count 的 SIZED 快路径要放在“终端可以决定是否甚至不必真正遍历”这个反直觉点上讲。
- 收尾要更强地把 01-04 四篇 Stream 主线收成一条链。

## 4. 理解路径

### 第一节：从“为什么 collect 才是真正按下开关”开场

承接前两篇：Pipeline 链和 Sink 链都已经知道了，继续追问——为什么 `stream().filter().map()` 什么都不做，而 `collect()` 一来整条流水线 suddenly 开始跑？先立住总问题：终端操作不只是拿结果，而是在决定执行入口和收口语义。

### 第二节：TerminalOp 为什么是“链底策略对象”而不是普通终端 API 名字

证据：
- `TerminalOp.java:45`：接口定义
- `TerminalOp.java:80-84`：默认 `evaluateParallel`
- `TerminalOp.java:96`：`evaluateSequential`

主线：
- 所有终端操作最后都会落实成某个 TerminalOp。
- TerminalOp 真正决定的是：串行怎么收口、并行怎么收口、是否需要短路、最后结果长什么样。
- 这把“终端操作只是链尾方法调用”升格成“终端策略对象”。

### 第三节：归约为什么天然适合做终端收口——容器、累加、合并三段式

证据：
- `ReduceOps.java:69`：有 identity 的 `makeRef`
- `ReduceOps.java:105`：无 identity 的 `makeRef`
- `ReduceOps.java:156`：collector 版 `makeRef`
- `ReduceOps.java:911`：`evaluateSequential`
- `ReferencePipeline.java:568/586`：两种 `collect`

主线：
- 归约不是“遍历完再手工组装结果”，而是从一开始就把结果容器、单元素累加和多片结果合并设计好。
- 这三段式正好允许串行单路推进，也允许并行多片局部归约后再合并。
- 这解释了为什么 collect/reduce 是 Stream 收口的核心框架。

### 第四节：count 为什么有时根本不必真正遍历

证据：
- `ReferencePipeline.java:604`：`count`
- `ReduceOps.java:253-258`：SIZED 快路径

主线：
- 不是所有终端操作都必须逐元素消费；如果 Spliterator 明确知道精确大小，count 可以直接返回。
- 这说明终端操作不仅决定“怎么收口”，还决定“到底需不需要真正驱动整条管道”。
- 这是一个非常反直觉但很能体现终端语义主导权的点。

### 第五节：短路终端为什么能提前停——它们的 sink 会主动请求取消

证据：
- `MatchOps.java:50-63`：`MatchKind`
- `MatchOps.java:89-94`：`accept` 设 stop
- `MatchOps.java:256`：`BooleanTerminalSink`
- `FindOps.java:171-199`：`FindSink`

主线：
- `anyMatch` / `allMatch` / `noneMatch` 不同之处其实只是“什么条件下 stop，stop 后返回什么布尔值”。
- `findFirst` / `findAny` 则是“找到一个值就停，但是否必须守 encounter order”这层差异。
- 它们之所以快，不是因为用了特殊循环，而是因为终端 sink 通过 cancellation 协议把“够了，别再往下喂元素”这件事传回执行链。

### 第六节：collect(toList()) 的完整时序为什么最能代表终端求值主线

证据：
- `ReferencePipeline.java:568`：`collect(Collector)`
- `AbstractPipeline.java:226-234`：`evaluate`
- `AbstractPipeline.java:473-490`：`wrapAndCopyInto` / `copyInto`
- `ReduceOps.java:911-914`：collector 路线 evaluateSequential
- `ForEachOps.java:132/148`：ForEachOp 收口作为对照

主线：
- collect 调 evaluate，evaluate 取源 Spliterator 并选择串/并行路径。
- ReduceOps 先做终端 sink，再让 wrapAndCopyInto 把前面的中间链焊上来执行。
- 这能把前几篇“API 分类 → Pipeline 链 → Sink 链 → 终端收口”真正串成一个闭环示意。

## 5. 失败方案清单

1. 把终端操作只当作“最后取结果”的语法收尾，不把它当执行总开关。
2. 以为 collect/reduce 只是不同返回值形式，忽略 supplier/accumulator/combiner 的并行意义。
3. 把短路能力只归因于中间操作，不理解终端 sink 也在主动请求取消。
4. 以为 count 一定要把每个元素都数一遍。
5. 把 allMatch / anyMatch / noneMatch / findFirst / findAny 都当成表面 API 差异，不追内部停流语义。
6. 忽略终端操作在串行/并行路径上的不同收口实现。

## 6. 误解清单

1. TerminalOp 只是内部命名，与真实求值逻辑关系不大。
2. collect 的 combiner 在串行路径里经常会用到。
3. 短路终端只是“遍历时提前 return”，和 Sink 协议无关。
4. count 的 SIZED 快路径只是一个微优化，不影响心智模型。
5. findFirst 和 findAny 的差异主要是返回类型，不是顺序承诺。
6. 终端操作的差别主要在中间链如何构造，而不是收口方式。

## 7. 证据清单

- `TerminalOp.java:45`：接口定义
- `TerminalOp.java:80-84`：默认 `evaluateParallel`
- `TerminalOp.java:96`：`evaluateSequential`
- `ReferencePipeline.java:568/586`：`collect`
- `ReferencePipeline.java:604`：`count`
- `ReduceOps.java:69`：identity reduce
- `ReduceOps.java:105`：optional reduce
- `ReduceOps.java:156`：collector reduce
- `ReduceOps.java:911-914`：`evaluateSequential`
- `ForEachOps.java:132`：`ForEachOp`
- `ForEachOps.java:148`：`evaluateSequential`
- `FindOps.java:171-199`：`FindSink`
- `MatchOps.java:50-63`：`MatchKind`
- `MatchOps.java:89-94`：match accept
- `MatchOps.java:256`：`BooleanTerminalSink`
- `AbstractPipeline.java:226-234`：`evaluate`
- `AbstractPipeline.java:473-490`：`wrapAndCopyInto` / `copyInto`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦终端求值骨架，不展开 Collector 特征矩阵与并行 collector 细粒度优化，那些放到下一篇。
- 短路并行实现只点到语义，不打穿所有 task 细节。
- count 的 SIZED 快路径只用来说明终端语义主导权，不扩成 Spliterator 全景。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“终端操作为什么是执行总开关 → TerminalOp 如何决定收口策略 → collect/reduce 为什么天然适合并行归约 → 短路终端如何通过 sink 取消协议提早停流 → count 为什么有时不用遍历 → collect(toList()) 如何把前 1-3 篇内容收成一条完整时序链”。
- 必须把终端操作讲成“收口策略 + 执行触发”双角色。
- 必须把归约和短路都讲回前一篇 Sink 协议。
- 必须自然引到 `05-collectors.md`。
