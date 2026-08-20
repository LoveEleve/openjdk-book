# Collectors 与收集器：为什么它不是一堆方便方法，而是一套归约配置对象

> 本文基于 JDK 11 `Collector`、`Collectors` 与 `ReferencePipeline.collect`。讨论重点是 Collector 五要素、`CollectorImpl`、`toList` / `toMap` / `groupingBy` / `joining`、characteristics（IDENTITY_FINISH / CONCURRENT / UNORDERED）以及并行 collect 路径；Spliterator 与并行流分割细节放到下一篇。
> **前置依赖**：[终端求值](04-terminal-eval.md)、[流水线结构与惰性机制](02-pipeline-lazy.md)
> **后续**：[Spliterator 与并行流](06-spliterator-parallel.md)

## 先看一个最容易把 collect 误讲成“把结果塞进某个容器”的错觉

很多人讲 Stream 收尾时，最自然的说法是：`collect(toList())` 就是把结果收进一个 List；`toMap()` 就是把结果塞成 Map；`groupingBy()` 就是自动分组。这样的描述当然不完全错，但它会把最重要的问题藏掉：**终端收集不是“最后往容器里装一装”这么简单，而是必须先把“容器怎么造、元素怎么进、并行时怎么合并、结果是不是还要再加工”这些规则写清楚。**

为什么这件事不能省？因为一旦进入并行流，或者只是进入更复杂的收集语义，collect 已经不再是“有一个容器，大家往里 add”这么朴素。不同 worker 可能会先在各自分片里累加结果，再在后面合并；有些收集器结果容器和最终返回类型其实不是一回事；有些场景允许并发往同一个容器里灌数据，有些则必须先分片再合并。没有一套明确契约，这些事情根本说不清。

这就是 `Collector` 存在的真正意义：**它不是一堆收集器工具方法的统称，而是一份把归约行为完整描述出来的配置对象。** `Collectors.toList()`、`toMap()`、`groupingBy()`、`joining()` 这些工厂，只是在替你预先把这份配置写好了。

所以这篇的主线不是“记住有哪些 Collectors”，而是：为什么 `collect` 需要一份五要素配置对象，以及这些常用工厂是如何在“重复 key 怎么办、容器是否就是结果、并行时能否共享容器”这些关键语义上做不同选择的。

## 一、Collector 为什么必须有五要素：因为并行归约不能只靠“最后有个容器”就收尾

### 先看最直觉但不够用的失败方案

如果你只看串行流，确实很容易觉得 collect 不需要这么复杂：先 `new ArrayList()`，然后每来一个元素就 add 进去，不就结束了吗？这个模型一遇到更复杂的场景马上就不够了：

- 如果结果不是 List，而是 String 拼接结果，最后是不是还要做一步 `toString()`？
- 如果是并行流，多个分片各自先收集了结果，最后怎么合并？
- 如果容器允许并发累加，是不是就可以绕过分片合并？
- 如果收集结果和中间容器其实是同一个对象，是否还能省掉 finisher？

所以 collect 真正需要的不是“一个目标容器”，而是一套完整的归约协议。

### 为什么五要素刚好够用

JDK 11 的 `Collector` 接口定义在 `Collector.java:197`。它的五个核心方法分别是：

- `supplier()`（`Collector.java:203`）
- `accumulator()`（`210`）
- `combiner()`（`220`）
- `finisher()`（`233`）
- `characteristics()`（`241`）

这五个角色一旦放回归约流程里，意义就非常清晰：

- `supplier`：结果容器从哪来；
- `accumulator`：一个元素来了，怎么灌进容器；
- `combiner`：并行时两份局部容器怎么合并；
- `finisher`：容器是不是最终结果，如果不是，最后再怎么转一次；
- `characteristics`：把“是否并发安全、是否无序、是否容器即结果”这些元信息告诉框架。

这说明 Collector 不是“给 collect 的参数对象”，而是**完整的归约配置描述**。它从一开始就在告诉 Stream：如果你要用我来收尾，这条流水线在串行和并行路径上应该按什么规则落地。

### 为什么 `Collector.of(...)` 能证明它首先是配置而不是实现

`Collector.of(...)` 的工厂方法在 `Collector.java:260` 和 `291`。这非常能说明问题：Collector 本身并不要求你写一个大类去实现复杂逻辑，你只要把五要素（或带默认 IDENTITY_FINISH 的四要素）交出来，框架就能用它当成收口策略对象。

所以如果一定要给 Collector 下一句最准确的人话定义，那应该是：**Collector 是一份把“收集结果怎么被构造、累加、合并、收尾”显式化的配方。**

## 二、为什么 `toList()` 和 `joining()` 是最适合看懂 Collectors 思想的两块样板

### toList 看上去简单，恰好能把五要素摊平给你看

`Collectors.toList()` 位于 `Collectors.java:277-281`。它几乎就是五要素模板最直白的样板：

- `supplier`：`ArrayList::new`
- `accumulator`：`List::add`
- `combiner`：`left.addAll(right)`
- `finisher`：省掉，因为容器本身就是结果
- `characteristics`：`CH_ID`，也就是带 `IDENTITY_FINISH`

这说明所谓“收进 List”，绝不是一句口头描述，而是框架真的拿到了一整套明确的构造、累加和合并规则。

### joining 为什么正好说明“容器不一定等于结果”

`Collectors.joining()` 位于 `Collectors.java:367-371`。它特别适合拿来对照 `toList()`，因为这里中间容器和最终结果明显不是同一个东西：

- 中间容器是 `StringBuilder`；
- 元素累加方式是 `append`；
- 多片容器合并也是 `append`；
- 最终结果却要经过 `StringBuilder::toString` 这一步 finisher 才成立。

这就让读者很直观地看到：**收集过程里的容器，和最终想返回给调用方的结果，未必是同一个类型。** 也正因为如此，`IDENTITY_FINISH` 就不再成立，框架必须老老实实跑 finisher。

这一对样板很重要，因为它们把“Collector 是归约配置对象”这句话从抽象定义落到了最具体的两种日常用法上：一种容器即结果，一种容器只是中间工作台。

## 三、为什么 `toMap()` 默认重复 key 直接炸：因为它在表达“这类收集语义本来就不接受冲突”

### 先看最常见、也最容易在运行时才爆出来的坑

`toMap()` 是收集器里最容易让人在运行时吃惊的一类。很多人直觉会觉得：收成 Map 而已，遇到同一个 key 后来的把前面的覆盖掉，或者默认合一下，不就行了吗？JDK 故意没有替你这么做。

在 JDK 11 里，`toMap(keyMapper, valueMapper)` 入口位于 `Collectors.java:1464-1466`。它内部用的关键 accumulator 是 `uniqKeysMapAccumulator`，实现片段在 `174-183`。里面最重要的一行不是 put，而是：

```java
V u = map.putIfAbsent(k, v);
if (u != null) throw duplicateKeyException(k, u, v);
```

也就是说，默认 `toMap` 的语义不是“冲突了帮你猜怎么处理”，而是：**如果同一个 key 出现两次，那说明你的收集规则本身没讲清楚，这时应该尽早炸出来。**

### 为什么 mergeFunction 重载不是“高级版”，而是“现在你终于把冲突规则说清楚了”

JDK 提供的 `toMap(..., mergeFunction)` 和四参重载（如 `Collectors.java:1568-1571`、`1660-1667`）并不是锦上添花，而是在表达另一种语义：现在重复 key 是被允许的，但你必须告诉框架“**冲突时怎么合**”。

这非常关键，因为它让 `toMap` 的两条分支语义完全清楚：

- 默认版：重复 key 是错误；
- mergeFunction 版：重复 key 合法，但必须有显式合并规则。

所以这类收集器不是在比“谁更方便”，而是在表达你对映射冲突到底承诺什么。

## 四、为什么 `groupingBy()` 天然会“同 key 合并”：它本来就是双层归约

### 先看它和 toMap 看起来最像、语义却完全不同的地方

表面上看，`groupingBy(classifier)` 和 `toMap(classifier, valueMapper)` 都是在“按 key 收东西”。但它们的默认态度恰好相反：toMap 看到重复 key 会炸，groupingBy 则恰恰把“同 key 的元素继续塞进同一个桶里”当成设计目标。

这不是 API 风格差异，而是两种不同的结果语义：

- `toMap` 目标是“一 key 对一值”；
- `groupingBy` 目标是“一 key 对一组归约结果”。

### groupingBy 为什么本质上是“外层 Map + 内层下游 Collector”的双层归约

JDK 11 里：

- 单参 `groupingBy` 在 `Collectors.java:1026-1027`，本质上就是 `groupingBy(classifier, toList())`；
- 双参在 `1075-1077`；
- 三参本体在 `1128-1155`。

最关键的 accumulator 逻辑在 `1132-1136`：

- 先用 classifier 算出 key；
- `computeIfAbsent` 拿到或创建该 key 对应的下游容器；
- 再把当前元素交给下游 accumulator 去处理。

这说明 groupingBy 从一开始就在做双层归约：外层用 Map 组织桶，内层每个桶再走自己的下游 Collector 语义。正因为如此，并行合并时它也不是简单地合 Map，而是要用 `mapMerger(downstream.combiner())`（`1137`）去合并同 key 下的两份下游容器。

这一层必须讲透，因为它把 `groupingBy` 和 `toMap` 的本质差异直接钉死了：**前者的语义本来就需要同 key 合并，后者则默认同 key 冲突即错误。**

## 五、为什么 characteristics 不是注释元数据，而是会直接改变并行 collect 路径

### 先看三个特征到底在告诉框架什么

`Collector.Characteristics` 枚举位于 `Collector.java:314`。最核心的三个特征是：

- `IDENTITY_FINISH`
- `CONCURRENT`
- `UNORDERED`

如果只把它们背成定义表，意义其实不大。真正重要的是，它们会直接影响终端收口路径怎么走。

- `IDENTITY_FINISH`：说明容器本身就是结果，可以跳过 finisher；
- `CONCURRENT`：说明 accumulator 可被多个线程并发灌入同一个容器；
- `UNORDERED`：说明不需要守 encounter order。

这三者一结合，collect 的并行策略就会出现分岔。

### 为什么 `toConcurrentMap` 的意义不在“名字更并发”，而在“它允许共享容器累加”

在 `ReferencePipeline.collect(...)`（`ReferencePipeline.java:568-583`）里，JDK 会根据收集器特征判断：

- 是走“每片一个容器，最后 combiner 合并”的分片路线；
- 还是在满足 `CONCURRENT` 且无顺序约束时，直接让多个线程并发往同一个结果容器里灌数据。

`toConcurrentMap()`（如 `Collectors.java:1723-1725`）最关键的不是它返回 `ConcurrentMap`，而是它把并行收集的语义从“分片后再合并”切到了“**共享一个并发安全容器直接累加**”。

这说明 characteristics 不是文档注释，而是框架在真实决定并行收口策略时要读取的执行条件。

## 五个最容易混掉的边界：Collector 不是容器本身，finisher 不是总能省，toMap 不是默认覆盖，groupingBy 不是 toMap 变体，CONCURRENT 也不是“自动更快”

第一，`Collector` 不是容器本身。它更像一份归约配方，描述容器如何被创建、元素如何进入、并行如何合并，以及结果是否还要再收尾处理。

第二，`finisher` 不是总能省。只有在结果容器本身就是最终结果时，`IDENTITY_FINISH` 才成立；像 `joining()` 这种中间用 `StringBuilder`、最终返回 `String` 的收集器，就必须显式跑收尾转换。

第三，`toMap()` 不是默认覆盖。JDK 默认语义恰恰是重复 key 直接报错，逼你把冲突规则讲清楚；只有给出 mergeFunction 时，重复 key 才被正式视为合法输入。

第四，`groupingBy()` 不是 `toMap()` 变体。它从一开始就在表达“同 key 元素继续进入同一个下游归约桶”，语义上本来就是双层归约，而不是一 key 对一值映射收集失败后的补丁路线。

第五，`CONCURRENT` 也不是“自动更快”。它表示框架在满足无序等条件时可以让多个线程并发灌同一个结果容器，但是否值得这么做、容器是否真适合共享累加，仍然取决于收集器和数据源语义。

把这五条边界记稳，Collectors 就不会再被理解成“一堆把结果装进常见容器里的方便方法”。它真正想讲的是：collect 的每一条路径都必须先把收口协议讲清楚，而 Collectors 工厂只是把这些 supplier、accumulator、combiner、finisher 和特征组合提前替你配好了。

## 收网：Collector 真正描述的不是“收集成什么”，而是“结果怎样被造出来、装进去、合起来”

回到开头那个误解，现在已经能看清为什么 Collectors 绝不只是若干方便方法了。`toList()`、`joining()`、`toMap()`、`groupingBy()` 看起来都在“收结果”，但它们背后真正不同的，是：

- 容器从哪来；
- 元素怎么累加；
- 冲突时是报错还是合并；
- 容器是不是最终结果；
- 并行时是分片合并还是共享容器直接灌入。

把整篇压成一张总图，就是：

```text
Collector
  → supplier：造容器
  → accumulator：装元素
  → combiner：并行合并
  → finisher：结果收尾
  → characteristics：告诉框架走哪条收口路线

Collectors 工厂
  → 只是把这五要素预配好
  → toMap 与 groupingBy 的核心差别在于重复 key 语义
  → toConcurrentMap 的核心差别在于并行共享容器语义
```

如果说前一篇讲的是“终端操作怎样收口”，这一篇真正补上的就是：**在 collect 这条最常用的收口路径里，收口策略本身是怎样被配置出来的。**

下一篇继续顺着这条线走向并行流真正的底层入口：这些流水线为什么能并行拆开？`Spliterator` 如何切分数据源、传递特征、支撑 parallel stream 的执行策略？这会把 Stream 域从 API、骨架、收口一路接到并行拆分与调度上。