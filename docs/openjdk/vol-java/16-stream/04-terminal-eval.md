# 04. 终端求值 — 归约框架、短路终端、evaluate 流程

> **前置依赖**: [16-stream/02 — 流水线结构与惰性机制](02-pipeline-lazy.md)(链组装、SHORT_CIRCUIT 传播)、[16-stream/03 — 中间操作实现](03-intermediate-ops.md)(有状态操作)
> → **后续**: [16-stream/05 — Collectors 与收集器](05-collectors.md)
> 关联: 域 08 集合(ArrayList 容器);域 13 原子类(结合律思想同 LongAccumulator);内部卷 13-jit-framework(分层编译)

## 终端按下开关之后

第 2 篇讲了"终端按下开关"——`evaluate` 组装 Sink 链、单遍遍历。这一篇看开关本身: 终端操作有哪几类?`collect` 的三段式归约框架怎么工作?`anyMatch` 为什么快?以及 `list.stream().filter(...).collect(toList())` 的完整时序。

## 1. "终端操作家族" — 四大类

第 1 篇的 API 地图已按"中间/终端"分类。终端内部再分四类(`Stream.java` 接口行号同第 1 篇):

| 类 | 操作 | 实现工厂 |
|----|------|---------|
| 遍历 | `forEach`/`forEachOrdered` | `ForEachOps` |
| 归约 | `reduce`/`collect` | `ReduceOps` |
| 匹配/查找 | `anyMatch`/`allMatch`/`noneMatch`/`findFirst`/`findAny` | `MatchOps`/`FindOps` |
| 汇总 | `count`/`min`/`max`/`toArray` | `ReduceOps`/`Nodes` |

全部实现为 `TerminalOp`(`TerminalOp.java:45`)——接口只有一个抽象方法 `evaluateSequential`(`:96-97`);`evaluateParallel` 有默认实现,默认**转回串行**并打一条 Tripwire 警告(`:80-85`)。"并行"不是白来的,是每个终端操作自己实现的。

面试"终端操作都是短路吗": 不——只有匹配/查找类;`count` 要全遍历。不过 `count` 有个捷径: 流水线是 SIZED 时**一次都不遍历**,直接 `spliterator.getExactSizeIfKnown()` 返回大小:

```java
// ReduceOps.java:253-258(截取,逐字)
            public <P_IN> Long evaluateSequential(PipelineHelper<T> helper,
                                                  Spliterator<P_IN> spliterator) {
                if (StreamOpFlag.SIZED.isKnown(helper.getStreamAndOpFlags()))
                    return spliterator.getExactSizeIfKnown();
                return super.evaluateSequential(helper, spliterator);
            }
```

(`ReferencePipeline.count()` 在 `:604-605` 调 `evaluate(ReduceOps.makeRefCounting())`。)

关键设计(斜体):*终端操作 = "求值 + 收尾"——全部实现为 TerminalOp,串行求值是唯一抽象方法,并行是各操作自己实现的加分项。面试"终端操作有几类": 遍历/归约/匹配查找/汇总;面试"终端操作都是短路吗": 只有匹配/查找类,count 有 SIZED 捷径(`getExactSizeIfKnown`)但语义上是全遍历。*

## 2. "归约框架" — 容器 + 累加 + 合并

### 2.1 三段式: 三个函数合成一个 Sink

`collect(supplier, accumulator, combiner)` 与 `reduce(seed, reducer, combiner)` 分别走 `ReduceOps.makeRef` 的两个重载——seed 版在 `:68-69`、supplier 版在 `:204-205`,骨架完全同构。核心是 `ReducingSink`——一个持单个状态字段的 Box(`Box` 定义在 `:869-877`,就一个 `state` 字段 + `get()`),以下为 seed 版:

```java
// ReduceOps.java:73-86(ReducingSink 核心,逐字)
            @Override
            public void begin(long size) {
                state = seed;
            }

            @Override
            public void accept(T t) {
                state = reducer.apply(state, t);
            }

            @Override
            public void combine(ReducingSink other) {
                state = combiner.apply(state, other.state);
            }
```

- `begin`: 注入种子(每个 sink 自己的起点)
- `accept`: 每来一个元素累加
- `combine`: 合并另一个 sink 的状态——这是**并行化的接缝**

collect 版是同构的**可变归约**: `accumulator.accept(state, t)` 就地修改容器(`ReduceOps.java:168-170`);reduce 版是**不可变归约**: `state = reducer.apply(state, t)` 每次产生新状态(`:79-81`)。

骨架是 `AccumulatingSink`(`:858-861`)= `TerminalSink` + 一个 `combine(K other)` 方法。

### 2.2 串行直通,并行分片

`ReduceOp` 的两个求值入口(`ReduceOps.java:911-920`):

```java
// ReduceOps.java:911-914(逐字)
        public <P_IN> R evaluateSequential(PipelineHelper<T> helper,
                                           Spliterator<P_IN> spliterator) {
            return helper.wrapAndCopyInto(makeSink(), spliterator).get();
        }
```

- **串行**: 一个 sink,`wrapAndCopyInto` 灌完直接 `get()`——**combine 从不被调用**
- **并行**: `ReduceTask` 分治(`:927-965`)——`doLeaf` 每片独立 sink 各自累加(`:951-953`),`onCompletion` 沿任务树把左右子结果 `combine` 起来(`:956-964`)

并行可合并的前提: accumulator/combiner 满足**结合律**——和域 13 的 `LongAccumulator` 同一思想(能分片就能合并,分片粒度与结果无关)。

面试"combiner 什么时候调用": 仅并行;串行直通(顺序保持)。

关键设计(斜体):*归约 = "容器 + 累加 + 合并"三段式,是并行化的完美结构——每线程独立容器互不干扰,最后沿任务树合并。面试"collect 怎么并行": 分片容器 + combiner;面试"为什么 reduce/collect 要求结合律": 分片任意切分、合并结果必须一致。*

## 3. "短路终端" — MatchOps/FindOps

### 3.1 MatchKind: 三兄弟一张表

`MatchKind` 枚举(`MatchOps.java:50-68`)用两个布尔组合出三种语义:

| kind | 构造参数(到 :63-67) | 停的条件(stopOnPredicateMatches) | 停时的结果(shortCircuitResult) |
|------|--------------------|----------------------------------|-------------------------------|
| `ANY`(`:52`) | (true, true) | 谓词命中 | true |
| `ALL`(`:55`) | (false, false) | 谓词不命中 | false |
| `NONE`(`:58`) | (true, false) | 谓词命中 | false |

字段声明在 `:60-61`。`MatchSink.accept`:

```java
// MatchOps.java:89-94(逐字)
            public void accept(T t) {
                if (!stop && predicate.test(t) == matchKind.stopOnPredicateMatches) {
                    stop = true;
                    value = matchKind.shortCircuitResult;
                }
            }
```

命中条件即置 `stop`——`BooleanTerminalSink.cancellationRequested()` 返回 `stop`(`:264-267`),短路循环每轮先问取消(第 2 篇 §4.2),源遍历终止。

注意默认值(`MatchOps.java:256-258`): `value = !matchKind.shortCircuitResult`——ANY 默认 false、ALL 默认 true。**空流语义**由此保证: `anyMatch` 空流 = false、`allMatch` 空流 = true,与数学量词一致。

面试"anyMatch 复杂度": 最好 O(1)(第一个元素就命中);最坏 O(n)(全部不命中,遍历完)。"anyMatch 为什么快": 命中即置 stop,短路循环立即停。

### 3.2 findFirst vs findAny: 一个布尔

`FindOps.makeRef(mustFindFirst)`(`FindOps.java:58-63`)按布尔选静态实例(`:197-199` / `:201-203`)。差别就在 opFlags(`FindOps.java:130`):

```java
// FindOps.java:130(逐字)
            this.opFlags = StreamOpFlag.IS_SHORT_CIRCUIT | (mustFindFirst ? 0 : StreamOpFlag.NOT_ORDERED);
```

- `findFirst`: 保序——**必须**拿到 encounter order 的第一个,并行时为了保序各分片需要按 encounter order 对齐,代价高
- `findAny`: 标记 NOT_ORDERED——并行时**先到先得**,任意分片命中即可

两者串行行为一致(`FindSink` 拿到值即取消,第 2 篇 §4.2 逐字块)。

面试"并行流用 findAny 更优": 顺序保证 vs 并行性能——findFirst 有顺序约束,findAny 可以不管顺序抢答。

关键设计(斜体):*短路终端 = "命中即停"——MatchKind 两个布尔把 any/all/none 统一成一条 if;FindSink 一个 hasValue 字段承担"停"。面试"短路操作有哪些": 匹配/查找类(anyMatch/allMatch/noneMatch/findFirst/findAny);面试"空流结果": anyMatch=false、allMatch=true、findAny=empty——都由默认值/空结果约定保证。*

## 4. "evaluate 的完整流程" — 串行视角

### 4.1 四步全景: collect(toList())

以 `list.stream().filter(...).collect(toList())` 为例:

1. `collect(Collector)`(`ReferencePipeline.java:568`)——非 CONCURRENT 收集器走 `evaluate(ReduceOps.makeRef(collector))`(`:578`;CONCURRENT 收集器另有并行捷径 `:570-576`)
2. `evaluate(terminalOp)`(`AbstractPipeline.java:226`): 检查 linkedOrConsumed → 标记消费 → `sourceSpliterator(terminalOp.getOpFlags())` 取源并把终端标志并入 combinedFlags(第 2 篇 §3.1/§4.1)
3. `ReduceOp.evaluateSequential`(`ReduceOps.java:911`): `makeSink()` 建容器 sink → `wrapAndCopyInto`(`AbstractPipeline.java:473`)——wrapSink 反向组装 filter 的 Sink(第 2 篇 §2.4)→ `copyInto` 单遍遍历(第 2 篇 §3.2)
4. `get()` 取出容器;`IDENTITY_FINISH` 收集器直接返回,否则套 `finisher`(`ReferencePipeline.java:580-582`)

全部中间操作在一个 `forEachRemaining` 循环里完成——**没有中间集合**(sorted/distinct 的状态缓冲除外,第 3 篇)。`collect` 的集合是最后才建出来的。

### 4.2 并行分派对比

`evaluate` 的并行分支(`AbstractPipeline.java:233`)把求值交给各终端操作自己:

| 终端 | 并行实现 | 特点 |
|------|---------|------|
| `forEach` | `ForEachOrderedTask`/`ForEachTask`(`ForEachOps.java:152-157`) | 有序需专门任务 |
| `reduce`/`collect` | `ReduceTask` 分治(`ReduceOps.java:917-920`) | 分片 + combine |
| `anyMatch` 等 | `MatchTask`(`MatchOps.java:234-243`) | 命中即短路整棵树 |
| 未实现者 | `TerminalOp` 默认转串行(`TerminalOp.java:80-85`) | Tripwire 警告 |

面试"中间结果有集合吗": 无——所有中间操作在一个循环里完成;`collect` 才是最终集合。

关键设计(斜体):*串行求值 = "链组装 + 单遍遍历"——所有中间操作的 Sink 在一个循环里完成,无中间集合;并行 = 每个终端操作自己的分治(归约分片合并、匹配短路整树)。面试画完整时序图(源 → Sink 链 → 终端容器)是这道题的满分答案。*

跨层标注: [域 08 集合——collect 的容器常见 ArrayList(08-collections/01),归约思想同样适用于 StringBuilder(joining);域 13 原子类——结合律与分片合并思想同 LongAccumulator;域 01 字符串(03-build-concat)——谓词/累加器是 invokedynamic 引导的 lambda]

## 核心悬念

归约框架有了——**collect 的丰富形态**呢?`Collectors.toList/toMap/groupingBy/joining` 怎么实现?downstream 收集器怎么嵌套?`Characteristics` 的 CONCURRENT/UNORDERED/IDENTITY_FINISH 特征各干什么?——下一篇: Collectors 与收集器。

> → [16-stream/05 — Collectors 与收集器](05-collectors.md)
