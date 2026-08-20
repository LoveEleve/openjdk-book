# 02. 流水线结构与惰性机制 — Pipeline 链、Sink 链、求值时机

> 🔴 Deep | 域 16 Stream 与函数式第 2 篇(巨型域 6 篇之二)| Layer 4
> 读者处境: 面试"为什么中间操作惰性"深问——Pipeline 双链结构与 Sink 消费链,Stream 的骨架。

### 1. "流水线是什么结构？" — Pipeline 链

场景: `filter.map.sorted.collect` — 内存里是什么形状?

- `AbstractPipeline.java:82/101` — `sourceStage`/`nextStage` — **前驱/后继链**(每个中间操作 new 一个 Pipeline 节点)
- `AbstractPipeline.java:201` — 构造(previousStage, opFlags)— **链接时只建对象,不执行**(惰性的结构基础)
- `ReferencePipeline.java:162` `filter` — `new StatelessOp<>(this, ...)` — 返回新 Pipeline 节点
- 关键设计 (斜体): *"中间操作 = 往链上挂节点"——O(1) 构建;执行发生在终端操作遍历链时;面试画"链条"图(源→op1→op2→终端)是核心*
- 面试: "为什么说 Stream 是懒的"——链构建不触碰数据;元素直到终端才流动

### 2. "Sink 链是什么？" — 消费管道

场景: 数据怎么"穿过"每个操作?

- `Sink.java` — 消费接口(accept 方法);`Sink.ChainedReference`(244)— 链式 Sink: 持 downstream(下一个)
- 每个中间操作的 `opWrapSink(flags, sink)`(`ReferencePipeline.java:172` 附近)— **把操作包成 Sink 挂在链上**
- filter 的 Sink(`ReferencePipeline.java:175-180`): `if (predicate.test(u)) downstream.accept(u)` — **过滤语义在 accept 里**
- 关键设计 (斜体): *"操作 → Sink"是惰性→执行的转换点: 终端操作触发时把整链 opWrapSink 组装成一条 Sink 链,数据单遍流过;面试"数据被处理几次"——单遍(Sink 链一次遍历)*
- [算法: 流水线单遍遍历(无中间集合,空间 O(1) 于无状态链);关联: 域 08 集合(数据源)]
- 面试: "Sink 和 Pipeline 关系"——Pipeline 描述结构,Sink 描述消费行为

### 3. "求值时机" — 终端触发

场景: `evaluate` 做了什么?

- `AbstractPipeline.java:226` `evaluate(terminalOp)`: 并行/串行分派(232-233)→ 串行 `wrapAndCopyInto`(473)— **组装 Sink 链并遍历 Spliterator**
- 流程: 终端 op 创建 sink → wrapAndCopyInto(把整条 Pipeline 链的 Sink 包起来)→ sourceSpliterator 驱动 forEachRemaining
- 关键设计 (斜体): *求值 = "链组装 + 单遍遍历"——中间操作零执行成本(构建期),全部成本在终端;面试"collect 前发生了什么"——直到 evaluate 才有数据流动*
- 面试: "惰性有什么好处"——短路(anyMatch 找到即停)、无限流、免中间集合

### 4. "惰性的收益" — 短路与流式

场景: `stream.filter(...).limit(3).findFirst()` — 处理了几个元素?

- 短路: `StreamOpFlag.java:630` — `IS_SHORT_CIRCUIT` — 短路标记(limit/findFirst/anyMatch)
- 效果: 找到结果即停——**不处理全部数据**(与 eager 的 for 循环差异)
- 无限流: `Stream.iterate(0, n -> n+1).filter(...).findFirst()` — 惰性使无限流可行
- 关键设计 (斜体): *短路 = "提前终止传播"——终端标记 SHORT_CIRCUIT,遍历循环检查标志;面试"无限流为什么不死循环"——惰性 + 短路*
- 面试: "短路操作有哪些"——limit/takeWhile(中间)、findFirst/anyMatch/allMatch/noneMatch(终端)

---

### 核心悬念

链与惰性通了——**每个中间操作怎么实现**?filter 包装 Sink、sorted 为什么"有状态"(要缓存)、limit 怎么切片、distinct 用什么去重——下一篇: 中间操作实现。

> → [03-intermediate-ops.md](03-intermediate-ops.md)
