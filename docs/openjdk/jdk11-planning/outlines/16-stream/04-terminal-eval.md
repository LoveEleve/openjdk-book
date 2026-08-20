# 04. 终端求值 — ReduceOps 归约、短路终端、evaluate 流程

> 🔴 Deep | 域 16 Stream 与函数式第 4 篇(巨型域 6 篇之四)| Layer 4
> 读者处境: 面试"collect 的原理""anyMatch 为什么快"——终端操作与归约框架。

### 1. "终端操作家族" — 四大类

场景: forEach/count/collect/anyMatch — 终端操作怎么分类?

- 遍历类: forEach(Stream.java:647)/forEachOrdered
- 归约类: reduce/collect(905)——**ReduceOps 框架**
- 匹配/查找类: anyMatch(1048)/allMatch/noneMatch/findFirst(1108)/findAny——短路
- 汇总类: count(1027)/min/max/toArray
- 关键设计 (斜体): *终端操作 = "求值 + 收尾"——全部实现为 TerminalOp;面试"终端操作有几类"——遍历/归约/匹配查找/汇总*
- 面试: "终端操作都是短路吗?"——只有匹配/查找类短路;count 要全遍历

### 2. "归约框架 ReduceOps" — 容器+累加+合并

场景: `collect(supplier, accumulator, combiner)` — 三段式怎么工作?

- `ReduceOps.java:72` — `ReducingSink`(Box 容器): `accept` 调 accumulator 累加;`combine`(84)合并两个容器
- `ReduceOps.java:88` — `ReduceOp` 终端: makeSink(90)创建、串行: 遍历流喂 sink;并行: 分片各自累加再 combine(域 16 第 6 篇)
- **并行可合并的前提**: accumulator 必须满足结合律(与域 13 LongAccumulator 同思想)
- 关键设计 (斜体): *"归约 = 容器 + 累加 + 合并"三段式是并行化的完美结构——每线程独立容器,最后合并;面试"collect 怎么并行"——分片容器 + combiner*
- 面试: "combiner 什么时候调用?"——仅并行;串行直通(顺序保持)

### 3. "短路终端" — MatchOps/FindOps

场景: `anyMatch(x -> x > 100)` 大集合——处理几个元素就停?

- `MatchOps.java:50` — `MatchKind` 枚举(anyMatch/allMatch/noneMatch——stopOnPredicateMatches 标志 63)
- `MatchOps.java:79` — makeRef → MatchSink: 命中即短路(设置短路标志)
- `FindOps.java:58` — makeRef(mustFindFirst)——findFirst 必须取顺序第一个(并行代价大);findAny 任意(并行友好)
- 关键设计 (斜体): *短路 = "提前终止整个遍历"——Sink 链最下游把短路标志传回源(域 16 第 2 篇 IS_SHORT_CIRCUIT);面试"anyMatch 复杂度"——最好 O(1)(第一个就命中)*
- 面试: "findFirst vs findAny"——顺序保证 vs 并行性能;并行流用 findAny 更优
- [关联: 域 12 短路思想(SHORT_CIRCUIT 标志同族)]

### 4. "evaluate 的完整流程" — 串行视角

场景: `list.stream().filter(...).collect(toList())` — 一步步发生什么?

- `AbstractPipeline.java:226` `evaluate(terminalOp)` → 串行: terminalOp 的 evaluateSequential → `wrapAndCopyInto`(473)组装 Sink 链 → `sourceSpliterator` 驱动
- 并行: `evaluateParallel`(233)→ AbstractTask 分治(域 16 第 6 篇)
- 关键设计 (斜体): *串行求值 = "链组装 + 单遍遍历"——所有中间操作的 Sink 在一个循环里完成(无中间集合);面试画完整时序图(源→Sink 链→终端容器)*
- 面试: "中间结果有集合吗?"——无(除非 sorted/distinct 状态化);collect 才是集合

---

### 核心悬念

归约框架有了——**collect 的丰富形态**呢?`Collectors.toList/toMap/groupingBy/joining` 怎么实现?downstream 怎么嵌套?`Characteristics` 的并发/无序特征干什么?——下一篇: Collectors 与收集器。

> → [05-collectors.md](05-collectors.md)
