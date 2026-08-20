# 05. Collectors 与收集器 — Collector 契约、toMap/groupingBy、组合

> 🔴 Deep | 域 16 Stream 与函数式第 5 篇(巨型域 6 篇之五)| Layer 4
> 读者处境: 面试"groupingBy 原理""toMap 的坑"——收集器契约与工厂实现。

### 1. "Collector 是什么？" — 五要素契约

场景: 自定义 Collector——必须实现什么?

- `Collector.java:197` — 接口四方法 + 特征集:
  - `supplier()`(203): 创建容器
  - `accumulator()`(210): 元素→容器
  - `combiner()`(220): 容器合并(并行)
  - `finisher()`(233): 容器→结果
  - `characteristics()`(241): 特征(枚举 314: IDENTITY_FINISH/CONCURRENT/UNORDERED)
- 关键设计 (斜体): *"Collector = 可并行的归约描述"——五要素让框架自由并行(分片容器+合并);IDENTITY_FINISH 表示容器即结果(免 finisher);面试"Collector 五要素"是手写收集器的基础*
- 面试: "CONCURRENT 特征是什么?"——容器线程安全,可共享累加(免分片)

### 2. "toList/toMap" — 常用工厂的实现

场景: `Collectors.toList()` — 为什么那么简单?`toMap` 为什么报错?

- `Collectors.java:277` `toList()` — 返回 **ReduceOps.makeRef**(ArrayList::new, List::add, List::addAll)— 归约到 ArrayList
- `toMap(keyMapper, valueMapper)`: 归约到 HashMap;**重复 key 抛 IllegalStateException**(默认)——重载可指定 mergeFunction
- `joining()`(367): 字符串拼接(内部 StringBuilder + 分隔符)
- 关键设计 (斜体): *"工厂方法 = 归约配置"——每个 Collector 都是 ReduceOps 的定制;toMap 重复 key 报错是默认保护(可 merge);面试"toMap 重复 key 怎么办"——mergeFunction 重载*
- 生产: toMap 的 key 重复是最常见运行时坑(排查: 数据里 key 冲突)

### 3. "groupingBy 的分组原理" — 双层归约

场景: `groupingBy(Dept::getId)` — 分组怎么实现?

- 签名: `groupingBy(classifier, downstream)` — 分类器 + 下游收集器
- 实现: 归约到 **Map<K, 下游容器>**——accumulator: `map.computeIfAbsent(key, ...).add(element)`
- 嵌套: downstream 可以是 toList/counting/mapping——**分组 + 每组的聚合**
- 关键设计 (斜体): *"groupingBy = 外层 Map 归约 + 内层下游归约"——双层容器;面试"groupingBy 和 toMap 区别"——前者自动合并同 key,后者需 mergeFunction*
- 生产: 分组统计(各部门人数/订单按状态分组)是 SQL 风格的数据归约
- [关联: 域 09 HashMap(分组容器)]

### 4. "collect 的并行路径" — 特征的作用

场景: 并行流 + CONCURRENT 收集器——怎么工作?

- 非 CONCURRENT: 每分片独立容器 → combiner 合并(域 16 第 4 篇)
- CONCURRENT + UNORDERED: **共享一个容器并发累加**(免合并,要求容器线程安全如 ConcurrentHashMap)
- 关键设计 (斜体): *"特征驱动并行策略"——框架读 characteristics 决定分片合并 or 共享累加;面试"Collectors.toConcurrentMap 什么时候用"——并行流且容器安全时*
- 面试: "并行 collect 的结果顺序"——顺序流有序,并行流无序(除非特征保证)

---

### 核心悬念

串行/并行都通了——**并行流的底层引擎**?`Spliterator.trySplit` 怎么分割数据?ForkJoin 任务树怎么建?`parallelStream` 用什么线程池?什么场景并行反而慢?——下一篇: Spliterator 与并行流。

> → [06-spliterator-parallel.md](06-spliterator-parallel.md)
