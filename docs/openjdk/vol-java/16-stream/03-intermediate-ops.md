# 03. 中间操作实现 — 无状态包装、状态化操作、短路标记

> **前置依赖**: [16-stream/02 — 流水线结构与惰性机制](02-pipeline-lazy.md)(Sink 链组装、SHORT_CIRCUIT 传播)、[09-map-hash/03 — LinkedHashMap](../09-map-hash/03-linkedhashmap-treemap.md)(LinkedHashSet 插入序)
> → **后续**: [16-stream/04 — 终端求值](04-terminal-eval.md)
> 关联: 域 08 集合(ArrayList/Arrays.sort 底层);域 09 Map(LinkedHashSet);内部卷 13-jit-framework(分层编译)

## 中间操作的两大阵营

第 2 篇看了 filter 包装 Sink 的过程——每个中间操作都只提供一个 opWrapSink"配方"。这一篇把全部 9 个中间操作过一遍,第一分类:**无状态 vs 有状态**。基类已经分好(`ReferencePipeline.java:683` 起 `StatelessOp`、`:713` 起 `StatefulOp`),差别就一个布尔方法 `opIsStateful()`。无状态 = 每个元素独立处理、处理完即抛,内存 O(1);有状态 = 必须攒批(缓存或计数),内存 O(n)。面试"sorted 为什么慢""distinct 用什么结构""limit 怎么知道停"全部从这个分类出发。

## 1. "为什么 filter/map 是无状态" — 每元素独立处理

### 1.1 无状态 Sink: 只持函数,不留字段

filter/map 的 Sink 构造后除了传入的函数,没有任何字段(逐字块已在第 2 篇展示)。三种 accept 对照:

| 操作 | accept 语义 | 源码 |
|------|------------|------|
| `filter` | 谓词通过才转发 | `ReferencePipeline.java:175-178` |
| `map` | 转换后转发 | `:194-196` |
| `peek` | 先 action 再转发 | `:440-443` |

peek 的:

```java
// ReferencePipeline.java:440-443(逐字)
                    public void accept(P_OUT u) {
                        action.accept(u);
                        downstream.accept(u);
                    }
```

flatMap 略特殊(`ReferencePipeline.java:270-282`): accept 里对每个元素先 `mapper.apply(u)` 展开子流,再用 `result.sequential().forEach(downstream)` 把子流元素逐条灌进下游(try-with-resources 关流)——它同样不缓存,每元素独立处理,只是 accept 内部多了个子流驱动循环。

面试"filter 的 accept 为什么不返回布尔": Consumer 语义——`void accept`,谓词不通过就不转发。不是"拒绝元素",是"不产生输出"。

### 1.2 无状态的收益: 流式 + O(1)

每元素独立处理、即处理即抛——这就是"流式": 元素进来立刻决定去向,不需要等全部数据,空间 O(1)。

### 1.3 StatelessOp vs StatefulOp: 一个布尔方法

两个基类只差一个方法:

```java
// ReferencePipeline.java:700-702 + 729-731(截取,逐字;行内注释标注来源)
        final boolean opIsStateful() {      // StatelessOp
            return false;
        }
...
        final boolean opIsStateful() {      // StatefulOp
            return true;
        }
```

StatefulOp 还强制实现 `opEvaluateParallel`(`ReferencePipeline.java:734-737`,并行求值时每个有状态操作独立成段处理)。另外,有状态节点构造时会给链头打 `sourceAnyStateful` 标记(`AbstractPipeline.java:211-212`)——并行时据此把流水线切成段(每段以有状态操作结尾,第 2 篇 §3.3 的串行流程只适用于纯无状态链)。

面试"哪些操作无状态": filter/map/flatMap/peek(加 unordered);**其余中间操作——distinct/sorted/limit/skip/takeWhile 以及第 1 篇分类表之外的 dropWhile,全是有状态**。后三节逐个讲。

关键设计(斜体):*"无状态 vs 有状态"是中间操作的第一分类——无状态可流式(每元素处理即抛、O(1) 内存),有状态必须攒批(O(n) 内存)。面试"哪些操作无状态": filter/map/flatMap/peek;分类的根源是基类的 `opIsStateful()` 与链头的 `sourceAnyStateful` 分段标记。*

## 2. "sorted 为什么有状态" — 攒批 + 排序

### 2.1 opWrapSink 的三路选择

`sorted()` 走 `SortedOps.makeRef` → `OfRef`(`SortedOps.java:50-52`,StatefulOp)。opWrapSink 根据标志选路:

```java
// SortedOps.java:138-143(逐字)
            if (StreamOpFlag.SORTED.isKnown(flags) && isNaturalSort)
                return sink;
            else if (StreamOpFlag.SIZED.isKnown(flags))
                return new SizedRefSortingSink<>(sink, comparator);
            else
                return new RefSortingSink<>(sink, comparator);
```

两个细节:

- **标志优化**: 输入已经是自然序且本操作也是自然序 → 直接透传原 sink,不排了(138-139)
- **标志注入**: 无参 `sorted()` 注入 `IS_ORDERED | IS_SORTED`(`:111-112`);带比较器版注入 `IS_ORDERED | NOT_SORTED`(`:126-127`)——告诉下游"排没排过",下游(distinct)可据此优化(§3.1)

### 2.2 生命周期: begin 建缓冲 → accept 只存 → end 排序转发

`SizedRefSortingSink`(输入大小已知,预分配数组)的核心:

```java
// SortedOps.java:345-349 + 368-370(截取,逐字)
        public void begin(long size) {
            if (size >= Nodes.MAX_ARRAY_SIZE)
                throw new IllegalArgumentException(Nodes.BAD_SIZE);
            array = (T[]) new Object[(int) size];
        }
...
        public void accept(T t) {
            array[offset++] = t;
        }
```

**accept 只存不排**。真正的排序在 `end()`:

```java
// SortedOps.java:352-364(逐字)
        public void end() {
            Arrays.sort(array, 0, offset, comparator);
            downstream.begin(offset);
            if (!cancellationRequestedCalled) {
                for (int i = 0; i < offset; i++)
                    downstream.accept(array[i]);
            }
            else {
                for (int i = 0; i < offset && !downstream.cancellationRequested(); i++)
                    downstream.accept(array[i]);
            }
            downstream.end();
            array = null;
        }
```

大小未知版 `RefSortingSink` 同理(`SortedOps.java:384-392`): begin 建 `ArrayList`(预估大小),end 里 `list.sort(comparator)`。

### 2.3 sorted 短路失效: cancellationRequested 被吞

`AbstractRefSortingSink` 覆写了 `cancellationRequested`(注释省略):

```java
// SortedOps.java:321-329(截取,逐字,省略注释行)
        public final boolean cancellationRequested() {
            ...
            cancellationRequestedCalled = true;
            return false;
        }
```

关键在 `return false`: **记下"下游想取消",但自己不取消**——排序必须等全部元素到齐才能做,想停也停不了。于是 `sorted().limit(3)` 的流程是: 源被全部消费、全量排序;排序完成后转发阶段才检查 `downstream.cancellationRequested()`(360-361),limit 计数归零即停止转发。

面试"sorted().limit(3) 会短路吗": 不会——sorted 必须先吃完整流;limit 只省了转发。"有状态在前短路失效"是顺序敏感组合(limit/skip/findFirst 放在 sorted/distinct 之后)的经典性能陷阱。

关键设计(斜体):*sorted 是"攒批"的典型——begin 建缓冲、accept 只存、end 才排序转发,空间 O(n) 时间 O(nlogn);"排序必须全局"决定它不能流式。面试"sorted 为什么慢": 缓存全部元素 + 排序;短路到它为止被吞(`cancellationRequested` 返回 false),但转发阶段仍可被下游取消。*

## 3. "distinct 用什么去重" — 三条路径

### 3.1 顺序流: seen 过滤器(独立 Sink)

先说结论再纠正传闻: 常听到"distinct 内部是 ReduceOps 归约到 LinkedHashSet"——核实源码后那是**并行有序**路径(§3.2);顺序流是独立 Sink,opWrapSink 按标志选路(`DistinctOps.java:119-180`),三路:

1. 输入已 DISTINCT → 透传原 sink(`:122-123`),标志优化
2. 输入 SORTED → **相邻去重**(`:124-154`): 只记 `lastSeen`,与上一元素比较即可——排序后重复项必然相邻。`stream.sorted().distinct()`(自然序)的 distinct 这一层不需要 Set(空间 O(1);sorted 自己的 O(n) 缓冲另算)。这是上一节"标志注入"的受益方
3. 默认 → HashSet seen 过滤器(`:155-178`)

默认路的 accept:

```java
// DistinctOps.java:172-177(逐字)
                        public void accept(T t) {
                            if (!seen.contains(t)) {
                                seen.add(t);
                                downstream.accept(t);
                            }
                        }
```

**保序的机制**: HashSet 只做成员测试(contains/add),通过的元素在 accept 里**立即流式转发**——输出顺序 = 遍历顺序,与 Set 内部顺序无关(begin 里 `new HashSet<>()`,`:160-163`)。

### 3.2 并行路径: 归约与并发 Set

- **有序**: `ReduceOps.makeRef` 归约到 LinkedHashSet——LinkedHashSet 的插入序保证输出按"各分片汇入顺序"去重(插入序机制在域 09 第 3 篇):

```java
// DistinctOps.java:61-64(逐字)
                TerminalOp<T, LinkedHashSet<T>> reduceOp
                        = ReduceOps.<T, LinkedHashSet<T>>makeRef(LinkedHashSet::new, LinkedHashSet::add,
                                                                 LinkedHashSet::addAll);
                return Nodes.node(reduceOp.evaluateParallel(helper, spliterator));
```

- **无序**: ConcurrentHashMap 并发去重(`:80-98`),null 用 AtomicBoolean 单独记(ConcurrentHashMap 不收 null)

面试"distinct 保序吗": 顺序流保(流式转发);并行有序保(LinkedHashSet 插入序);并行无序不保。内存 O(n)(Set 缓存)。

关键设计(斜体):*distinct = "seen 过滤器"——Set 只做成员测试、命中即转发,顺序由遍历保证而非 Set;并行有序路径才用归约到 LinkedHashSet。面试"distinct 用什么结构": 顺序流 HashSet 过滤、排序流相邻去重(O(1))、并行有序 LinkedHashSet 归约、并行无序 ConcurrentHashMap;能答出"路径随标志切换"就是完整答案。*

## 4. "limit/skip/takeWhile 怎么停" — 切片与短路

### 4.1 limit/skip 也是 StatefulOp

`limit`/`skip` 走 `SliceOps.makeRef`(`SliceOps.java:109-113`)——返回的是 **StatefulOp**(有 n/m 计数状态),标志由 `flags(limit)` 决定(`:543-545`,第 2 篇 §4.1 已展示): **带 limit 才注入 SHORT_CIRCUIT,纯 skip 不注入**。

### 4.2 切片 Sink: 先 n 后 m

切片 Sink 两个计数:

```java
// SliceOps.java:186-187 + 194-205(截取,逐字)
                    long n = skip;
                    long m = limit >= 0 ? limit : Long.MAX_VALUE;
...
                    public void accept(T t) {
                        if (n == 0) {
                            if (m > 0) {
                                m--;
                                downstream.accept(t);
                            }
                        }
                        else {
                            n--;
                        }
                    }
```

前 `n` 个元素只递减不转发(skip);之后每转发一个 `m` 递减(limit);`cancellationRequested` 在 `m == 0` 时返回 true(`:206-208`,第 2 篇 §4.2 逐字块)——短路循环下一轮就停。分页就是 `skip(page*n).limit(n)` 组合。

面试"limit(3) 处理几个元素": 下游**最多**收到 3 个;源被拉取的数量取决于前序——前序 filter 可能拉更多(拒绝的补),前序 sorted 则全量拉(§2.3)。

### 4.3 takeWhile: 谓词失败即停

`takeWhile` 的 flag 是 `NOT_SIZED | IS_SHORT_CIRCUIT`(`WhileOps.java:50`);对照 `dropWhile` 只注入 `NOT_SIZED`(`:52`)——dropWhile 丢弃前导匹配段后,剩余元素必须全部转发,没有提前终止的停点,天然不短路。takeWhile 的 Sink:

```java
// WhileOps.java:89 + 96-106(截取,逐字)
                    boolean take = true;
...
                    public void accept(T t) {
                        if (take && (take = predicate.test(t))) {
                            downstream.accept(t);
                        }
                    }

                    public boolean cancellationRequested() {
                        return !take || downstream.cancellationRequested();
                    }
```

`take && (take = predicate.test(t))` 一石二鸟: 谓词失败时 `take` 置 false——不再测谓词、不再转发;`cancellationRequested` 随即返回 `!take` = true,`forEachWithCancel` 每轮先问取消(第 2 篇 §4.2),源遍历停止。

关键设计(斜体):*limit/takeWhile 的"停"不是结束流,是**请求取消、让源遍历终止**——SHORT_CIRCUIT 标志 + cancellationRequested 传播(第 2 篇 §4);skip/dropWhile 丢弃/转发完剩余全部元素,没有提前终止的语义,不注入标志。面试"limit(3) 处理几个元素": 下游最多 3 个,源被拉数量取决于前序(有状态前序全拉);"有状态在前短路失效"是顺序敏感组合的陷阱。*

跨层标注: [域 08 集合——sorted 的缓冲与排序依赖 ArrayList/Arrays.sort;域 09 Map——LinkedHashSet 插入序是并行 distinct 保序的根基;域 01 字符串(03-build-concat)——filter/takeWhile 的谓词是 invokedynamic 引导的 lambda]

## 核心悬念

中间操作讲完——**终端操作怎么收尾**?`collect` 的归约框架(ReduceOps 怎么把"容器+累加+合并"变成 Sink)、`anyMatch` 的短路终端、`findFirst` 的顺序保证、`forEach` 的并行分派——下一篇: 终端求值。

> → [16-stream/04 — 终端求值](04-terminal-eval.md)
