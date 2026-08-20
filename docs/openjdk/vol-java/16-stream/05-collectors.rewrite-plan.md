# 16-stream/05 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Collector`、`Collectors`、`ReferencePipeline.collect`。本文聚焦 Collector 五要素、`CollectorImpl`、`toList` / `toMap` / `groupingBy` / `joining`、characteristics（IDENTITY_FINISH / CONCURRENT / UNORDERED）以及并行 collect 路径；Spliterator 与并行流分割细节放到下一篇。
> 目标：把“Collectors 与收集器”改写成一篇围绕“Collector 不是一堆方便方法，而是把‘容器怎么造、元素怎么装、结果怎么合并、最后要不要再加工’描述成可并行归约配置对象”的机制文章。

## 1. 读者困惑

- `collect(toList())` 看起来像语法糖，为什么内部还要专门引出 Collector 契约？
- `supplier` / `accumulator` / `combiner` / `finisher` / `characteristics` 这五个要素到底分别在解决什么问题？
- 为什么 `toMap` 默认重复 key 直接炸，而 `groupingBy` 却会自然把同 key 放在一起？
- `joining` 为什么看起来像字符串拼接，内部却也是一套标准归约？
- `IDENTITY_FINISH`、`CONCURRENT`、`UNORDERED` 为什么会直接改变并行 collect 路径？
- 什么时候该用 `toConcurrentMap`，什么时候 `groupingBy` 的并行结果仍然是分片合并而不是共享容器累加？

## 2. 一句话顿悟

**Collector 的本体不是“收集器工具类方法”，而是一份可并行归约配置：容器由谁创建、每个元素怎么塞进去、多片结果如何合并、最后是否还要再加工、以及这些步骤能否共享容器并发执行。`Collectors.toList()`、`toMap()`、`groupingBy()`、`joining()` 只是把这五件事按不同语义预配好；真正的难点在于，它们看起来都叫 collect，背后却在表达完全不同的重复 key、顺序、并发与结果成形语义。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 Collector 五要素、Characteristics 三个枚举、toList / toMap / joining / groupingBy 的关键实现，以及并行 collect 的特征驱动分流。
- 已抓到 `toMap` 的重复 key 保护和 `groupingBy` 的双层归约本质，这是本文最关键的两组对照。
- 已把 Spliterator 并行流细节放到下一篇，边界合理。

### 必须重写

- 旧稿偏“工厂速查表”，需要先建立总问题：为什么 collect 不能只是“最后塞进某个容器”。
- 五要素要讲成“并行归约配置对象”的必需组成，而不是接口清单。
- `toMap` 与 `groupingBy` 必须放在“同 key 到底报错还是合并”的核心对照上。
- `characteristics` 要更明确回扣到并行路径选择，而不是停留在枚举定义。
- 收尾要把前 1-5 篇 Stream 主线连成从 API 到 Collector 收口的一张图。

## 4. 理解路径

### 第一节：从“为什么 collect 不能只是 new 一个 List 再 add”开场

承接上一章：终端操作负责收口，但真正的问题不只是“把元素装进容器”，而是“并行时谁建容器、谁累加、怎么合并、最后结果和容器是不是一回事”。先立总问题：Collector 是一份归约配置，而不是一个容器工具箱。

### 第二节：Collector 五要素为什么刚好拼成一套可并行归约协议

证据：
- `Collector.java:197`：接口定义
- `Collector.java:203`：`supplier`
- `Collector.java:210`：`accumulator`
- `Collector.java:220`：`combiner`
- `Collector.java:233`：`finisher`
- `Collector.java:241`：`characteristics`
- `Collector.java:260/291`：`Collector.of(...)`

主线：
- supplier 解决“容器从哪来”。
- accumulator 解决“一个元素怎么进容器”。
- combiner 解决“多片结果怎么并回去”。
- finisher 解决“容器是不是最终结果”。
- characteristics 让框架知道是否允许共享容器、是否保序、是否可省 finisher。

### 第三节：toList / joining 为什么是“最容易看懂的模板 Collector”

证据：
- `Collectors.java:195`：`CollectorImpl`
- `Collectors.java:277-281`：`toList`
- `Collectors.java:367-371`：`joining()`
- `Collectors.java:399-402`：分隔符 joining

主线：
- `toList` 直接把五要素配成 `ArrayList::new` / `List::add` / `addAll` / `IDENTITY_FINISH`。
- `joining` 把容器换成 `StringBuilder`，最后再 `toString`，于是失去 IDENTITY_FINISH。
- 这两个例子最适合让读者看到“Collectors 工厂方法其实就是在预配五要素”。

### 第四节：toMap 为什么默认重复 key 直接炸

证据：
- `Collectors.java:1464-1466`：`toMap(keyMapper, valueMapper)` 入口
- `Collectors.java:174-183`：`uniqKeysMapAccumulator`
- `Collectors.java:1568-1571`：带 mergeFunction 重载
- `Collectors.java:1660-1667`：四参 `toMap`

主线：
- `toMap` 默认假设同一个 key 只该出现一次，所以 `putIfAbsent` 失败就抛异常。
- mergeFunction 重载不是功能增强小补丁，而是在明示：“现在允许重复 key 发生时有一套业务合并规则”。
- 这要讲成“映射结果到底该怎样处理冲突”的语义设计题。

### 第五节：groupingBy 为什么天然是“同 key 自动合并”

证据：
- `Collectors.java:1026-1027`：单参 `groupingBy`
- `Collectors.java:1075-1077`：双参 groupingBy
- `Collectors.java:1128-1155`：三参 groupingBy 本体
- `Collectors.java:1132-1136`：`computeIfAbsent` accumulator
- `Collectors.java:1137`：`mapMerger(downstream.combiner())`

主线：
- groupingBy 的本质是外层 Map + 内层下游 Collector 的双层归约。
- 同 key 时不是报错，而是复用已有容器继续累加；并行时再用下游 combiner 合并同 key 的容器。
- 这样能把它和 toMap 的“重复 key 默认即错误”形成最清晰对照。

### 第六节：characteristics 为什么会改变并行 collect 的路径

证据：
- `Collector.java:314`：`Characteristics`
- `Collectors.java:106-118`：`CH_ID` / `CH_NOID` / `CH_CONCURRENT_ID`
- `ReferencePipeline.java:568-583`：collect 路径分流
- `Collectors.java:1723-1725`：`toConcurrentMap`

主线：
- `IDENTITY_FINISH` 决定是否能直接返回容器。
- `CONCURRENT + UNORDERED` 允许多个线程并发往同一容器累加，绕开分片合并路线。
- 否则仍然走“分片容器 + combiner”骨架。
- 这把特征从“元数据”讲回执行策略，避免停留在枚举层。

## 5. 失败方案清单

1. 把 collect 只理解成“最后塞进 List/Map”的便利 API。
2. 自定义 Collector 时不提供正确 combiner，却期待并行流结果仍然可靠。
3. 用 `toMap` 收重复 key 数据，却没意识到默认策略是直接抛异常。
4. 把 `groupingBy` 当作 `toMap` 的语法糖，不理解它是双层归约。
5. 看到 `CONCURRENT` 就误以为所有并行 collect 都共享同一个容器。
6. 用 `joining` 时忽略它其实也要先在 StringBuilder 里累加再做 finisher。

## 6. 误解清单

1. Collectors 是一堆常用终端工具方法，与归约框架关系不大。
2. `supplier` / `accumulator` / `combiner` 只在并行流里才有意义。
3. `IDENTITY_FINISH` 只是一个小优化标记，不影响 Collector 语义。
4. `toMap` 和 `groupingBy` 只是返回类型不同，一个 Map 一个 Map of List。
5. `toConcurrentMap` 天然总比 `toMap` 更适合并行场景。
6. groupingBy 的组间和组内顺序问题可以忽略不看。

## 7. 证据清单

- `Collector.java:197`：接口定义
- `Collector.java:203`：`supplier`
- `Collector.java:210`：`accumulator`
- `Collector.java:220`：`combiner`
- `Collector.java:233`：`finisher`
- `Collector.java:241`：`characteristics`
- `Collector.java:260/291`：`Collector.of`
- `Collector.java:314`：`Characteristics`
- `Collectors.java:106-118`：特征常量组
- `Collectors.java:195`：`CollectorImpl`
- `Collectors.java:277-281`：`toList`
- `Collectors.java:367-371`：`joining()`
- `Collectors.java:399-402`：带分隔符 joining
- `Collectors.java:1464-1466`：`toMap` 入口
- `Collectors.java:174-183`：重复 key 检查 accumulator
- `Collectors.java:1568-1571`：三参 toMap 重载
- `Collectors.java:1660-1667`：四参 toMap
- `Collectors.java:1026-1027`：单参 groupingBy
- `Collectors.java:1075-1077`：双参 groupingBy
- `Collectors.java:1128-1155`：三参 groupingBy 本体
- `Collectors.java:1132-1136`：groupingBy accumulator
- `Collectors.java:1137`：groupingBy merger
- `Collectors.java:1723-1725`：`toConcurrentMap`
- `ReferencePipeline.java:568-583`：collect 路径分流

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦常用收集器和并行策略，不展开每个 downstream collector 家族的全部变体。
- 并行 collect 的细粒度性能边界只解释到 characteristics 驱动路径为止，不替代下一篇并行流专题。
- 不把 Collectors 讲成 SQL 教程，重点始终是归约配置和执行语义。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“Collector 为什么是五要素归约配置对象 → toList/joining 怎样各自预配五要素 → toMap 为什么默认拒绝重复 key → groupingBy 为什么天然双层归约 → characteristics 怎样改变并行 collect 路径”。
- 必须把 toMap 与 groupingBy 的差异讲成本文主对照。
- 必须把 characteristics 讲回执行策略，而不是停在枚举定义。
- 必须自然引到 `06-spliterator-parallel.md`。
