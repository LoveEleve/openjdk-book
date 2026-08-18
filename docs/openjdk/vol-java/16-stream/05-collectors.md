# 05. Collectors 与收集器 — Collector 契约、toMap/groupingBy、特征

> **前置依赖**: [16-stream/04 — 终端求值](04-terminal-eval.md)(归约框架、IDENTITY_FINISH 判断)、[16-stream/02 — 流水线结构与惰性机制](02-pipeline-lazy.md)(Sink 链)
> → **后续**: [16-stream/06 — Spliterator 与并行流](06-spliterator-parallel.md)
> 关联: 域 08 集合(ArrayList 容器);域 09 Map(HashMap 存储);域 01 字符串(03-build-concat)(invokedynamic 引导的 lambda)

## 收集器是"归约的配置"

第 4 篇讲了 `collect(Collector)` 的归约框架——五要素被 `ReduceOps.makeRef(collector)` 包装成 Sink。这一篇看"配置"本身: `Collector` 五要素是什么?`toList`/`toMap`/`joining` 这些工厂怎么配置的?`groupingBy` 怎么做到"分组 + 每组聚合"?`CONCURRENT` 特征怎么改变并行策略?

## 1. "Collector 是什么" — 五要素契约

### 1.1 五个方法一张表

`Collector<T, A, R>` 接口(`Collector.java:197`)五个方法:

| 方法 | 源码 | 作用 |
|------|------|------|
| `supplier()` | `:203` | 创建容器 |
| `accumulator()` | `:210` | 元素 → 容器 |
| `combiner()` | `:220` | 合并两个容器(并行) |
| `finisher()` | `:233` | 容器 → 结果 |
| `characteristics()` | `:241` | 特征集 |

三个泛型: T 输入元素、A 中间容器、R 最终结果。`Collectors` 的所有工厂都返回同一个简单包装 `CollectorImpl`(`Collectors.java:195`,五字段 + 两个构造器)——工厂方法本身只做"配置"。

### 1.2 特征: 三个枚举

`Characteristics` 枚举(`Collector.java:314`):

- **IDENTITY_FINISH**: 容器即结果——collect 的步骤 4 直接返回容器,免 finisher(第 4 篇 §4.1)
- **CONCURRENT**: 容器线程安全,accumulator 可被多线程**并发调用同一个容器**(`:315-319` 注释)
- **UNORDERED**: 结果与 encounter order 无关

`Collectors` 里用 `CH_ID`/`CH_NOID`/`CH_CONCURRENT_ID` 等常量组合(`Collectors.java:106-118`): `CH_ID` = 仅 IDENTITY_FINISH,`CH_CONCURRENT_ID` = CONCURRENT+UNORDERED+IDENTITY_FINISH,`CH_NOID` = 空集。

面试"自定义 Collector": 用 `of()` 工厂(`Collector.java:260`/`:291`)——四参版自动补 IDENTITY_FINISH(`:268-271`)。

关键设计(斜体):*Collector = "可并行的归约描述"——五要素让框架自由决定并行策略(分片容器 + 合并,或共享容器)。面试"Collector 五要素": supplier/accumulator/combiner/finisher/characteristics;面试"IDENTITY_FINISH 是什么": 容器即结果,collect 直接返回容器。*

## 2. "toList/toMap/joining" — 常用工厂的实现

### 2.1 toList: 一句话配置

`toList()`:

```java
// Collectors.java:276-281(逐字)
    public static <T>
    Collector<T, ?, List<T>> toList() {
        return new CollectorImpl<>((Supplier<List<T>>) ArrayList::new, List::add,
                                   (left, right) -> { left.addAll(right); return left; },
                                   CH_ID);
    }
```

四要素: `ArrayList::new` 建容器、`List::add` 累加、`left.addAll(right)` 合并、CH_ID 容器即结果。

注意一个易错点: 工厂返回的是 **CollectorImpl 配置**,不是归约本身——归约发生在 `collect(toList())` 调 `ReduceOps.makeRef(collector)` 时(第 4 篇 §4.1 步骤 1)。

### 2.2 toMap: 重复 key 保护

`toMap(keyMapper, valueMapper)`(`Collectors.java:1463-1470`): `HashMap::new` + `uniqKeysMapAccumulator` + `uniqKeysMapMerger` + CH_ID。核心在累加器:

```java
// Collectors.java:174-183(截取,逐字)
        return (map, element) -> {
            K k = keyMapper.apply(element);
            V v = Objects.requireNonNull(valueMapper.apply(element));
            V u = map.putIfAbsent(k, v);
            if (u != null) throw duplicateKeyException(k, u, v);
        };
```

- `putIfAbsent` 探测重复: 已存在则抛 **IllegalStateException**——这就是"toMap 重复 key 报错"的根源
- value 也做非空检查(`requireNonNull`)
- 重载 `toMap(k, v, mergeFunction)`(`:1567-1571`,委托四参版)与 `toMap(k, v, merge, mapFactory)`(`:1660-1667`)分别解决"要合并"和"要指定 Map 类型"——合并版用 `map.merge(key, value, mergeFunction)`(`:1665-1666`)+ `mapMerger`

面试"toMap 重复 key 怎么办": 默认抛 IllegalStateException;需要合并语义就换 `mergeFunction` 重载。

### 2.3 joining: StringBuilder 归约

`joining()`:

```java
// Collectors.java:367-371(逐字)
    public static Collector<CharSequence, ?, String> joining() {
        return new CollectorImpl<CharSequence, StringBuilder, String>(
                StringBuilder::new, StringBuilder::append,
                (r1, r2) -> { r1.append(r2); return r1; },
                StringBuilder::toString, CH_NOID);
    }
```

容器是 `StringBuilder`、累加是 `append`、finisher 是 `toString`、CH_NOID(必须走 finisher)。分隔符版 `joining(delimiter)`(`:382-384`)委托三参版(delimiter/prefix/suffix,内部是 StringJoiner)。

关键设计(斜体):*"工厂方法 = 归约配置"——每个 Collector 都是五要素的一句话定制(toList 的 add、toMap 的 putIfAbsent+查重、joining 的 append)。面试"toMap 重复 key 怎么办": 默认抛异常是保护,mergeFunction 重载是解法;生产: toMap 重复 key 是最常见的运行时坑,排查方向是数据里 key 冲突。*

## 3. "groupingBy 的分组原理" — 双层归约

### 3.1 三个重载一条链

- `groupingBy(classifier)`(`Collectors.java:1025-1027`): `groupingBy(classifier, toList())`
- `groupingBy(classifier, downstream)`(`:1073-1077`): `groupingBy(classifier, HashMap::new, downstream)`
- 三参版(`:1127-1130`,classifier/mapFactory/downstream)是本体

### 3.2 本体: 外层 Map 归约 + 内层下游容器

accumulator:

```java
// Collectors.java:1132-1136(逐字)
        BiConsumer<Map<K, A>, T> accumulator = (m, t) -> {
            K key = Objects.requireNonNull(classifier.apply(t), "element cannot be mapped to a null key");
            A container = m.computeIfAbsent(key, k -> downstreamSupplier.get());
            downstreamAccumulator.accept(container, t);
        };
```

- **外层容器是 `Map<K, A>`**——A 是下游收集器的中间容器类型
- `computeIfAbsent`: key 首次出现时用 `downstreamSupplier.get()` 建下游容器,之后复用——这就是"同 key 自动合并"
- `requireNonNull`: classifier 返回 null key 直接 NPE(消息 "element cannot be mapped to a null key")
- merger 是 `mapMerger(downstream.combiner())`(`:1137`): 并行合并两个 Map 时,同 key 的两容器用**下游的 combiner** 合并
- 特征跟随下游(`:1141-1155`): 下游 IDENTITY_FINISH → CH_ID 直接返回;否则 finisher 对每个 key 的值逐个加工(`intermediate.replaceAll(...)`,`:1148-1153`)

### 3.3 面试

- "groupingBy 和 toMap 区别": groupingBy 同 key **自动复用容器**(computeIfAbsent),toMap 默认重复抛异常
- "分组 + 聚合": `groupingBy(Dept::getId, counting())` 各部门人数——downstream 可以是任意收集器(mapping/toSet/joining)
- "groupingBy 保序吗": 组**内**保序(下游是 List,累加按 encounter order);组**间**顺序无保证——默认 HashMap 桶序,要保组间顺序用三参版指定 LinkedHashMap/TreeMap(实测: 并行有序流组内仍保序,§4 的路径决定)

关键设计(斜体):*groupingBy = "外层 Map 归约 + 内层下游归约"的双层容器——computeIfAbsent 复用容器实现自动合并,mapMerger 让并行合并落到下游 combiner。面试"groupingBy 和 toMap 区别": 前者自动合并同 key,后者需 mergeFunction;面试"分组统计": groupingBy + counting/mapping 是 SQL 风格归约。*

## 4. "collect 的并行路径" — 特征驱动策略

### 4.1 两条路

`collect(Collector)`(`ReferencePipeline.java:568-583`)按特征选路:

- **非 CONCURRENT**(或流有序且收集器无 UNORDERED): `evaluate(ReduceOps.makeRef(collector))`(`:578`)——分片容器 + combiner 合并(第 4 篇 §2.2)
- **CONCURRENT + (流无序或收集器 UNORDERED)**: **共享一个容器并发累加**(`:570-576`)——`supplier().get()` 只调一次,`forEach` 多线程直灌同一容器,免合并(要求容器线程安全)

### 4.2 特征表

| 收集器 | 特征 | 并行行为 |
|--------|------|---------|
| `toList`/`toMap` | CH_ID | 分片合并 |
| `groupingBy` | CH_ID 或 CH_NOID(看下游) | 分片合并 |
| `toConcurrentMap` | CH_CONCURRENT_ID | 共享容器 |

`toConcurrentMap`(`Collectors.java:1722-1729`): `ConcurrentHashMap::new` + CH_CONCURRENT_ID——专为并行共享累加设计。

面试"toConcurrentMap 什么时候用": 并行流且结果无需顺序时;共享累加免合并(实测: 并行下求和正确)。面试"并行 collect 结果顺序": 非 CONCURRENT 路径分片按 encounter order、合并沿任务树顺序进行,有序流结果保序;CONCURRENT 共享容器不保序。

关键设计(斜体):*"特征驱动并行策略"——框架读 characteristics 决定分片合并 or 共享累加;面试"Collectors.toConcurrentMap 什么时候用": 并行流 + 容器安全;面试"并行 collect 顺序": 分片合并保序、共享容器不保序。*

跨层标注: [域 08 集合——toList 的容器是 ArrayList;域 09 Map——toMap/groupingBy 的容器是 HashMap,`computeIfAbsent`/`putIfAbsent` 是 JDK8 的 Map 默认方法;域 01 字符串(03-build-concat)——joining 的 StringBuilder 归约与 concat 的 StringBuilder 思想同源]

## 核心悬念

串行/并行都通了——**并行流的底层引擎**?`Spliterator.trySplit` 怎么分割数据?ForkJoin 任务树怎么建?`parallelStream` 用什么线程池?什么场景并行反而慢?——下一篇: Spliterator 与并行流。

> → [16-stream/06 — Spliterator 与并行流](06-spliterator-parallel.md)
