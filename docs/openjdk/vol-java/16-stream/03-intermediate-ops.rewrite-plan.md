# 16-stream/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ReferencePipeline`、`DistinctOps`、`SortedOps`、`SliceOps`、`WhileOps`、`StreamOpFlag`。本文聚焦无状态/有状态中间操作、`opWrapSink` 配方、状态化缓存与短路标记传播；终端求值与并行执行细节放到后续篇章。
> 目标：把“中间操作实现”改写成一篇围绕“为什么有些中间操作能边来边过、而有些必须先攒住全局状态；短路为什么会在某些状态化操作前失效”的机制文章。

## 1. 读者困惑

- `filter`、`map`、`peek` 为什么能做到边来边处理，而 `sorted`、`distinct`、`limit` 却经常要攒批或带状态？
- 无状态和有状态操作在源码里到底差在哪，为什么只是一个布尔分类却会决定整条流水线的空间和时机？
- `sorted().limit(3)` 为什么并不会只排前三个元素？
- `distinct` 到底用什么去重，为什么顺序流和并行流的路径会不一样？
- `takeWhile` 和 `limit` 都会停，为什么实现语义却不相同？

## 2. 一句话顿悟

**中间操作的第一分水岭不是“干了什么业务逻辑”，而是“处理当前元素时，需不需要知道全局或前序状态”。`filter`/`map`/`peek` 这类无状态操作只在 `accept` 里按元素即时转发；`sorted`/`distinct`/`limit`/`takeWhile` 等有状态操作则必须维护缓存、计数或停止条件。也正因为如此，排序这类全局操作会吞掉前面的短路，而切片与条件截断则把短路标记显式注入执行链里。**

## 3. 旧稿优点与问题

### 保留

- 已完整覆盖无状态 / 有状态分类、sorted / distinct / limit/skip / takeWhile 的核心实现与短路细节。
- 已抓住 `sorted().limit(3)` 失去前置短路这一关键反直觉点。
- 已把下一篇终端求值留作后续，不抢边界。

### 必须重写

- 主要问题不是内容缺失，而是还缺一份与其他域一致的计划与最终收束视角。
- 需要更明确地把“中间操作到底在缓存什么全局状态”作为每节共用问题重新强调。
- 收尾需要更清楚地把本篇和前一篇 Pipeline/Sink 结构、后一篇终端求值串成一个连续链。

## 4. 理解路径

### 第一节：从“为什么 sorted 会让 limit 失去短路优势”开场

用 `stream.sorted().limit(3)` 开场：直觉以为只要前三个，实际上排序必须先吃完整流。先立住总问题：中间操作真正的区别在于它能否只靠当前元素做决定，还是必须攒全局状态。

### 第二节：无状态操作为什么能边来边过

证据：
- `ReferencePipeline.java:162-167`：`filter`
- `ReferencePipeline.java:167-180`：filter `opWrapSink`
- `ReferencePipeline.java:186-191`：`map`
- `ReferencePipeline.java:191-199`：map `opWrapSink`
- `ReferencePipeline.java:437`：`peek`

主线：
- 谓词通过就转发、映射后就转发、peek 观察后就转发。
- 这类操作除了函数参数外不需要额外全局状态，空间 O(1)、天然流式。

### 第三节：有状态操作为什么必须缓存或计数

证据：
- `ReferencePipeline.java:683-731`：`StatelessOp` / `StatefulOp`
- `AbstractPipeline.java:211-212`：`sourceAnyStateful`
- `ReferencePipeline.java:734-737`：`opEvaluateParallel`

主线：
- 有状态不是“更复杂”的同义词，而是“当前元素处理结果依赖前序或全局状态”。
- 这会改变内存开销、并行切段和短路时机。

### 第四节：sorted 为什么是典型的全局状态操作

证据：
- `SortedOps.java:138-143`：sorted `opWrapSink` 分支
- `SortedOps.java:345-349` / `352-364`：`SizedRefSortingSink` begin/end
- `SortedOps.java:321-329`：`cancellationRequested` 被吞

主线：
- 排序先收集，再排序，再转发，天然不是流式。
- 因为必须先拿到全局元素集，所以前面的 limit/anyMatch 之类短路在它前面失效。

### 第五节：distinct 为什么既可能是 HashSet，也可能只做相邻去重

证据：
- `DistinctOps.java:119-180`：顺序流路径
- `DistinctOps.java:61-64`：并行有序归约到 LinkedHashSet

主线：
- 是否已排序、是否并行、是否要求顺序，会决定去重结构选择。
- 这说明“一个 API 名字”背后不止一条实现路线，标志位会改变策略。

### 第六节：limit/skip/takeWhile 为什么把“停”也做成显式状态

证据：
- `SliceOps.java:109-113`：`SliceOps.makeRef`
- `SliceOps.java:186-208`：skip/limit 计数 sink
- `WhileOps.java:50-52`：takeWhile / dropWhile 标志
- `WhileOps.java:89-106`：takeWhile sink
- `StreamOpFlag.java:326-328`：SHORT_CIRCUIT

主线：
- skip/limit 通过计数决定转发与停止；takeWhile 用谓词失效触发取消；dropWhile 则不短路。
- 这把“停流”从抽象语义落实成 `cancellationRequested` 协议。

## 5. 失败方案清单

1. 以为所有中间操作都能边来边处理，不会缓存全局状态。
2. 认为 `sorted().limit(3)` 只会对前三个元素排序。
3. 把 `distinct` 简化成“总是 HashSet 去重”。
4. 以为 skip/limit/takeWhile 都只是“取一部分”所以实现差不多。
5. 忽略短路标记传播与 `cancellationRequested` 的真实作用。

## 6. 误解清单

1. 无状态 / 有状态只是分类题，对执行代价没影响。
2. sorted 的慢主要来自 comparator，本身不需要额外内存。
3. distinct 的保序来自 Set 自身顺序，而不是执行路径设计。
4. takeWhile 和 dropWhile 只是条件相反的镜像操作。
5. 中间操作短路和终端操作短路在执行时机上没有区别。

## 7. 证据清单

- `ReferencePipeline.java:162-167`：`filter`
- `ReferencePipeline.java:167-180`：filter `opWrapSink`
- `ReferencePipeline.java:186-191`：`map`
- `ReferencePipeline.java:191-199`：map `opWrapSink`
- `ReferencePipeline.java:437`：`peek`
- `ReferencePipeline.java:683-731`：`StatelessOp` / `StatefulOp`
- `ReferencePipeline.java:734-737`：`opEvaluateParallel`
- `AbstractPipeline.java:211-212`：`sourceAnyStateful`
- `SortedOps.java:138-143`：sorted 分支
- `SortedOps.java:321-329`：sorted 的 `cancellationRequested`
- `SortedOps.java:345-349` / `352-364`：排序 sink 生命周期
- `DistinctOps.java:61-64`：并行有序路径
- `DistinctOps.java:119-180`：顺序流三条路径
- `SliceOps.java:109-113`：切片入口
- `SliceOps.java:186-208`：skip/limit sink
- `WhileOps.java:50-52`：take/dropWhile 标志
- `WhileOps.java:89-106`：takeWhile sink
- `StreamOpFlag.java:326-328`：SHORT_CIRCUIT

## 8. 版本与边界

- 基于 JDK 11。
- 本篇专讲中间操作，不展开终端求值、Collector 框架与并行分割细节。
- 不把所有原始类型流实现都逐个重写，聚焦 Reference 路线建立心智。
- 需要反复强调状态化操作对短路和空间复杂度的影响。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“无状态操作为何能流式逐元素转发 → 有状态操作为何必须缓存/计数 → sorted 为什么吞短路 → distinct 为什么实现分叉 → limit/skip/takeWhile 怎样通过状态和短路协议控制停流”。
- 必须把‘是否需要全局状态’讲成所有中间操作的统一判断轴。
- 必须自然承接前一篇 Pipeline/Sink 和后一篇终端求值。
