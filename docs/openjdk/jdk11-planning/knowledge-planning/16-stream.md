# 域 16: Stream 与函数式 — 知识规划

> 源码路径: java.base/share/classes/java/util/stream/(37 文件 25,688 行) + java/util/function/(44 文件 2,893 行) + java/util/{Optional 469,Spliterator 838}.java
> 源码量: ~83 文件 / ~29,000 行 | 🔴 巨型域(拆 6 篇分段写作)
> 写作层: Layer 4(前置: 域 08 集合、13 原子类/并发基础)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| Stream.java (1445) | **接口全景**: filter(182)/map(197)/distinct(372)/sorted(388)/limit(468)/skip(497)/takeWhile(555)/forEach(647)/collect(905)/count(1027)/anyMatch(1048)/findFirst(1108)——中间 vs 终端分类 | High |
| AbstractPipeline.java (712) | **流水线链**: 前驱/后继链接、sourceStage、isParallel(372)、evaluate(226,终端入口)、wrapAndCopyInto(473)、惰性设计 | High |
| ReferencePipeline.java (739) | **中间操作实现**: filter(162)/map(186)/distinct(452)/sorted(457)/limit(467)——**惰性包装**(返回新 Pipeline,不执行) | High |
| Sink.java (362) | **消费链**: chainedSink(链式 accept)、forEachRemaining——中间操作转 Sink 链 | High |
| StreamSpliterator 族 | **惰性分割**: StreamSpliterators(1552)——filter/map 等包装 Spliterator | Medium |
| ReduceOps.java (966) | **归约**: ReduceOp(容器+累加+合并)/count/collect 的终端实现 | High |
| SliceOps.java (717)/SortedOps.java (709)/DistinctOps.java | **状态化中间操作**: limit/skip(切片)、sorted(排序缓存)、distinct(去重)——**有状态**(需缓存) | High |
| MatchOps.java/FindOps.java/ForEachOps.java | **短路终端**: anyMatch/allMatch(短路)、findFirst、forEach(507) | Medium |
| Collectors.java (1925) | **收集器工厂**: toList/toMap/groupingBy/joining/partitioningBy——静态工厂+downstream 组合 | High |
| Collector.java | **收集器契约**: supplier/accumulator/combiner/finisher + Characteristics(IDENTITY_FINISH/CONCURRENT/UNORDERED) | High |
| Node.java (547)/Nodes.java (2235) | **数据缓冲**: Node 接口(顺序/并行合并的数据容器)、SpinedBuffer 分段增长 | Medium |
| AbstractTask.java | **并行任务**: ForkJoin 分治(opEvaluateParallel 的基础) | Medium |
| java/util/function/(44) | **函数式接口**: Function/Predicate/Consumer/Supplier + 原始类型变体 | Medium |
| Optional.java (469) | **可空包装**: map/filter/orElse/orElseGet——空安全链 | Medium |
| Spliterator.java (838) | **分割迭代器**: tryAdvance/trySplit/estimateSize/特性(ORDERED/DISTINCT/SORTED/SIZED) | High |

*15 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | 流水线结构与惰性 | 4 (AbstractPipeline/ReferencePipeline/Sink) | 面试必考(为什么中间操作不执行) |
| P1 | 终端求值 | 4 (ReduceOps/SliceOps/Match/Find) | 面试常问(求值触发) |
| P1 | Collectors | 2 | 面试高频(toMap/groupingBy 原理) |
| P1 | Spliterator 与并行 | 3 (Spliterator/StreamSupport/AbstractTask) | 面试常问(并行流原理/线程模型) |
| P2 | 函数式接口 | 44 | 使用层(接口语义) |
| P2 | Optional | 1 | 面试偶尔 |
| P3 | Node/SpinedBuffer | 2 | 实现细节 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | 惰性求值与流水线 | 面试必考(中间操作为什么惰性/何时执行) |
| 🔴 Deep | 终端求值流程 | 面试常问(短路/归约) |
| 🔴 Deep | Collectors 组合 | 面试高频(groupingBy 分组原理) |
| 🔴 Deep | 并行流与 Spliterator | 面试常问(并行流线程池/何时该用) |
| 🟡 Working | 状态化操作 | 面试偶尔(sorted 为什么缓存) |
| 🟢 Surface | Node/Optional 细节 | 使用层 |

## 04 聚类

### 依赖图(域内)
```
Stream(接口) ←── ReferencePipeline(实现链) ←── AbstractPipeline(链结构/惰性)
中间操作 → Sink 链(wrapAndCopyInto)
终端操作 → TerminalOp ←── ReduceOps/MatchOps/FindOps/ForEachOps
Collectors ←── Collector(契约)
Spliterator ←── StreamSupport/StreamSpliterators
并行 → AbstractTask(ForkJoin,域 15)
```

### 教学顺序与文章拆分(6 篇,巨型域分段)

1. **Stream 接口全景与函数式接口** — 中间/终端分类、function 包、Lambda 与 invokedynamic(域 04 衔接)
2. **流水线结构: Pipeline 链与惰性** — AbstractPipeline 链、ReferencePipeline 包装、Sink 链、为什么惰性
3. **中间操作实现** — filter/map 包装、状态化(sorted/distinct/limit)、短路标记
4. **终端求值** — evaluate 流程、ReduceOps 归约、Match/Find 短路、forEach
5. **Collectors 与收集器** — Collector 契约、toList/toMap/groupingBy、downstream 组合
6. **Spliterator 与并行流** — Spliterator 特性、并行分治(AbstractTask)、并行流线程模型与陷阱

> 前置: 域 08(集合)、13(并发)。跨层: ForkJoin(域 15);lambda invokedynamic(域 04);无 native
