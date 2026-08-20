# 16-stream/06 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Spliterator`、`StreamSupport`、`Collection.parallelStream()` 与 ForkJoin 共用执行后端。本文聚焦 `tryAdvance` / `trySplit` / `estimateSize` / `characteristics`、并行拆分任务树、commonPool 使用边界与并行流适用条件；不展开每个集合具体 Spliterator 实现的所有细节。
> 目标：把“Spliterator 与并行流”改写成一篇围绕“并行流为什么不是 magically 变快，而是先靠 Spliterator 把数据切得够像样，再交给 ForkJoin 执行；如果切不好、活不够重或阻塞了公共池，反而会更慢”的机制文章。

## 1. 读者困惑

- `parallelStream()` 到底做了什么，为什么不是简单多开几个线程遍历？
- Spliterator 为什么不只是 Iterator 的升级版，它多出来的 `trySplit` 到底在解决什么问题？
- `SIZED`、`SUBSIZED`、`ORDERED`、`CONCURRENT` 这些特性为什么会影响并行效果？
- 为什么有的数据源一并行就很顺，有的即使并行也很难提速？
- parallelStream 默认到底跑在哪个线程池里，为什么阻塞操作会连累全局？
- `findAny`、无序流、有状态操作这些因素为什么会显著改变并行表现？

## 2. 一句话顿悟

**并行流真正依赖的不是“多线程”这四个字，而是两层前提：第一层，`Spliterator.trySplit` 得把数据切成足够均衡、足够便宜的子块，特性位再告诉框架能否信任大小、顺序和并发边界；第二层，这些子块要被提交给 ForkJoin 的任务树去执行。切不均、任务太轻、顺序约束太重，或把阻塞操作扔进 commonPool，都会让并行流从优势变成负担。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 Spliterator 四个核心能力、特性位、ArrayList 二分分割、AbstractTask 任务树、commonPool 与并行流适用/陷阱。
- 已把 `SIZED`/`SUBSIZED` 与并行均衡联系起来，方向正确。
- 已把并行流陷阱放到收尾段，较符合生产问题导向。

### 必须重写

- 旧稿偏“底层模块说明书”，需要先建立总问题：并行流不是天然快，它有一套前提链。
- `Spliterator` 要突出“可分割”才是并行流的真正入口，不只是“遍历器接口更多了”。
- 抽象任务树和 commonPool 要讲成“Spliterator 切块之后，谁来接这些块继续干”的自然下游，而不是平铺另一个模块。
- 适用/陷阱部分要更明确地回扣前文：切分质量、每元素计算量、顺序约束、阻塞行为如何分别拖垮并行收益。
- 收尾要把整个 Stream 域从 API、Pipeline、Sink、终端、Collector、Spliterator 串成一个闭环。

## 4. 理解路径

### 第一节：从“为什么 parallelStream 不是白送加速”开场

用最常见反例开场：小集合、很轻的 map/filter、或者带阻塞 IO 的回调上 parallelStream 反而更慢。先立住总问题：并行不是语法选项，而是拆分质量 + 执行成本 + 顺序约束共同决定的结果。

### 第二节：Spliterator 为什么比 Iterator 多出来一层“能不能切”

证据：
- `Spliterator.java:296`：接口定义
- `Spliterator.java:309`：`tryAdvance`
- `Spliterator.java:370`：`trySplit`
- `Spliterator.java:395`：`estimateSize`
- `Spliterator.java:432`：`characteristics`

主线：
- Iterator 只回答“下一个元素是谁”。
- Spliterator 还要回答“我能不能把自己切成两半，让别人并行干另一半”。
- 这是它之所以成为并行流入口的根本原因。

### 第三节：特性位为什么不只是标签，而是并行优化前提

证据：
- `Spliterator.java:486`：`ORDERED`
- `Spliterator.java:521`：`SIZED`
- `Spliterator.java:539`：`IMMUTABLE`
- `Spliterator.java:567`：`CONCURRENT`
- `Spliterator.java:584`：`SUBSIZED`

主线：
- `SIZED` / `SUBSIZED` 让框架更敢于按大小均衡切块。
- `ORDERED` 会给并行执行附加顺序约束成本。
- `CONCURRENT` / `IMMUTABLE` 影响源数据在遍历期能否安全地被同时修改或被假定稳定。
- 这把特性位从“定义表”讲回执行策略。

### 第四节：为什么 trySplit 的质量会直接决定并行成败

证据：
- `Spliterator.java:334-346`：`trySplit` 与大小/前缀约束注释
- `Collection.java:710-732`：`stream()` / `parallelStream()` 通过 StreamSupport 建流
- `StreamSupport.java:67`：`stream(spliterator, parallel)`

主线：
- 数据源必须被切成足够均衡、足够便宜的子块，ForkJoin 才有活可分。
- 切得很歪或不能切，worker 之间就会失衡，窃取成本会上升，甚至退化回串行瓶颈。
- `parallelStream()` 本质只是把 parallel 标志交给 StreamSupport，再把后续切块与求值交给流水线和 FJP。

### 第五节：为什么并行流最终会落到 ForkJoin commonPool

证据：
- `Collection.java:731-732`：`parallelStream()`
- `ForkJoinPool.java:2395`：`commonPool()`
- `ForkJoinPool.java:2563`：`getCommonPoolParallelism()`

主线：
- 集合默认 `parallelStream()` 并不会新建专属线程池，而是走公共 FJP 后端。
- 这解释了为什么一个阻塞任务会影响别处的并行流或 CF async 链：底层池是共享的。
- commonPool 适合计算型切块任务，不适合随手扔长阻塞 IO。

### 第六节：什么时候并行有希望更快，什么时候注定更慢

主线：
- 条件 1：数据能切得足够均衡。
- 条件 2：每个元素处理成本足够重，能覆盖拆分/调度/合并开销。
- 条件 3：顺序约束和有状态操作不会把并行收益吞回去。
- 条件 4：执行逻辑不阻塞 commonPool。
- 用这四条回扣 small data / ordered / sorted / distinct / blocking 回调这些典型坑。

## 5. 失败方案清单

1. 看到数据量大就直接上 parallelStream，不先判断单元素计算成本。
2. 在阻塞 IO 或锁竞争逻辑里使用 commonPool 并行流。
3. 以为 Spliterator 只是 Iterator 多几个方法，和并行效果关系不大。
4. 忽略 ORDERED / SIZED / SUBSIZED 特性对拆分和合并成本的影响。
5. 用并行流处理强顺序依赖或高状态化中间操作链，却期待自然提速。
6. 以为 parallelStream 一定会给当前任务分配独立线程池资源。

## 6. 误解清单

1. parallelStream 的加速主要来自“线程变多了”。
2. 只要能 trySplit，就一定能获得良好并行均衡。
3. `SIZED` 只影响 `count()` 的优化，对并行拆分没帮助。
4. `findAny` 与 `findFirst` 在并行流里差别只是结果顺序口味不同。
5. commonPool 是并行流内部专用池，不会影响其他异步任务。
6. 小任务并行化的坏处主要是线程创建开销。

## 7. 证据清单

- `Spliterator.java:296`：接口定义
- `Spliterator.java:309`：`tryAdvance`
- `Spliterator.java:370`：`trySplit`
- `Spliterator.java:395`：`estimateSize`
- `Spliterator.java:432`：`characteristics`
- `Spliterator.java:486`：`ORDERED`
- `Spliterator.java:521`：`SIZED`
- `Spliterator.java:539`：`IMMUTABLE`
- `Spliterator.java:567`：`CONCURRENT`
- `Spliterator.java:584`：`SUBSIZED`
- `StreamSupport.java:67`：`stream(spliterator, parallel)`
- `Collection.java:710-732`：`stream()` / `parallelStream()`
- `ForkJoinPool.java:2395`：`commonPool()`
- `ForkJoinPool.java:2563`：`getCommonPoolParallelism()`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 Spliterator 与并行流入口，不展开每个具体集合 Spliterator 的全部实现，也不重讲 ForkJoinPool 内部 work-stealing 细节。
- 不把并行流写成性能银弹；重点是建立适用前提和失败边界。
- commonPool 的自定义替换或隔离实践只点到为止，不在本文做完整工程方案。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么并行流首先依赖可切分数据源 → Spliterator 的 trySplit/estimateSize/characteristics 如何决定切块质量 → 切块后为什么会交给 commonPool / ForkJoin 执行 → 什么条件下并行能赢、什么条件下只会更慢”。
- 必须把 Spliterator 讲成并行流入口，而不是 Iterator 变体百科。
- 必须把并行流失败条件讲回任务开销、顺序约束和公共池阻塞这几类真实工程问题。
- 必须在结尾把 16 域全篇逻辑收束起来。
