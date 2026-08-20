# 01. Stream 接口全景与函数式接口 — 中间/终端分类、Lambda 机制

> 🔴 Deep | 域 16 Stream 与函数式第 1 篇(巨型域 6 篇之一)| Layer 4
> 读者处境: 面试"Stream 的中间操作和终端操作区别"是入门题——完整 API 地图 + Lambda 的编译真相。

### 1. "Stream 的 API 地图" — 中间 vs 终端

场景: `list.stream().filter(...).map(...).collect(...)` — 每段属于哪类?

- 中间操作(返回 Stream,惰性): filter(182)/map(197)/distinct(372)/sorted(388)/limit(468)/skip(497)/takeWhile(555)/peek/flatMap
- 终端操作(求值触发): forEach(647)/collect(905)/count(1027)/anyMatch(1048)/findFirst(1108)/reduce/min/max/toArray
- 关键设计 (斜体): *"中间惰性 + 终端触发"是 Stream 的第一原理——**没有终端操作,中间操作什么都不做**;面试"stream 不 collect 会怎样"——无副作用(除了 peek 的调试性)*
- 面试: "中间操作有哪些/终端有哪些"——能完整分类是基础;短路中间(takeWhile)与短路终端(anyMatch)是进阶

### 2. "函数式接口是什么？" — function 包四族

场景: `filter(x -> x > 0)` 的 lambda 是什么类型?

- `java/util/function/`(44 个接口)— 四大族: `Function<T,R>`(映射)/`Predicate<T>`(断言)/`Consumer<T>`(消费)/`Supplier<T>`(供给)+ Bi/原始类型(int/long/double)变体
- lambda 编译: javac 生成 invokedynamic → `LambdaMetafactory.metafactory`(域 04 已述)——**不是匿名内部类**(JDK8+)
- 接口契约: 单一抽象方法(SAM)——函数式接口注解 @FunctionalInterface
- 关键设计 (斜体): *lambda 是"接口实例的语法糖"——SAM 接口 + invokedynamic 引导;面试"lambda 和匿名类区别"——捕获变量要求 effectively final、invokedynamic 生成(不创建类文件)*
- [关联: 域 04 StringConcatFactory(同款 invokedynamic 机制)]
- 面试: "为什么 lambda 快/慢"——invokedynamic 引导后内联(域 15 JIT 衔接)

### 3. "Stream 怎么创建？" — 数据源

场景: 集合/数组/文件/生成器——Stream 的四种来源

- 集合: `Collection.stream()/parallelStream()`;数组: `Arrays.stream`(域 08);值: `Stream.of`;生成: `Stream.iterate/generate`(无限流,配合 limit)
- `StreamSupport.stream(spliterator, parallel)` — 底层入口(域 16 第 6 篇)
- 关键设计 (斜体): *"源 → 流水线"的抽象: 任何 Spliterator 都能变 Stream——StreamSupport 是通用桥;面试"无限流怎么用"——iterate/generate + limit(惰性)*
- 生产: 大集合注意并行流的线程模型(第 6 篇)

### 4. "Optional 与空安全" — 链式空处理

场景: `obj.map(...).filter(...).orElse(default)` — Optional 的语义

- `Optional.java:469` — 可空包装: `map/filter/orElse(默认值)/orElseGet(惰性)/orElseThrow`
- `orElse vs orElseGet`: 前者总是求值(参数已算好),后者惰性(避免无谓计算)
- 关键设计 (斜体): *Optional 是"空值语义化"——强迫调用方处理为空路径;面试"orElse 和 orElseGet 区别"——求值时机;生产: 返回值用 Optional,字段/参数不用(规范争议)*
- 面试: "Optional 能替代 null 吗?"——不能全部;作返回值契约

---

### 核心悬念

API 知道了——**内部怎么组织**?`filter().map().sorted().collect()` 怎么串成一条链?为什么中间操作惰性?Sink 链是什么?——下一篇: 流水线结构与惰性机制。

> → [02-pipeline-lazy.md](02-pipeline-lazy.md)
