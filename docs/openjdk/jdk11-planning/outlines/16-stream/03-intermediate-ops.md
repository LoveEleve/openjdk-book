# 03. 中间操作实现 — 无状态包装、状态化操作、短路标记

> 🟡 Working | 域 16 Stream 与函数式第 3 篇(巨型域 6 篇之三)| Layer 4
> 读者处境: 面试"sorted 为什么需要缓存""distinct 用什么结构"——中间操作的两大阵营: 无状态 vs 有状态。

### 1. "无状态操作" — filter/map 的包装

场景: filter 和 map 的实现差异——为什么它们"无状态"?

- `ReferencePipeline.java:162` `filter` — `new StatelessOp<>(this, ..., NOT_SIZED)` + `opWrapSink` 返回 ChainedReference(175-180): `if (predicate.test(u)) downstream.accept(u)`
- `ReferencePipeline.java:186` `map` — 同构: `downstream.accept(mapper.apply(u))`
- "无状态"含义: 每个元素独立处理,**不需要缓存任何中间数据**(内存 O(1))
- 关键设计 (斜体): *"无状态 vs 有状态"是中间操作的第一分类——无状态可流式(每元素处理即抛),有状态必须攒批;面试"哪些操作无状态"——filter/map/flatMap/peek*
- 面试: "filter 的 accept 为什么不返回布尔?"——Consumer 语义,不匹配就不转发(不是"拒绝")

### 2. "sorted 为什么有状态？" — 缓存 + 排序

场景: sorted 在流中间——它怎么知道"全局顺序"?

- `SortedOps.java:50` `makeRef` → `OfRef` → `RefSortingSink`(304,AbstractRefSortingSink 基类)
- 实现: `begin` 创建缓冲;`accept` 全部暂存;`end` 排序后逐元素转发——**两种排序路径**: 非 SIZED 版 `list.sort(comparator)`(320-321),SIZED 版 `Arrays.sort(array, 0, offset, comparator)`(353-355,可预分配数组)
- **必须等全部元素到齐才能排序**——状态化操作的典型(缓冲整个流)
- 关键设计 (斜体): *sorted 的空间 O(n) 时间 O(nlogn)——"排序必须全局"决定它不能流式;并行版用合并排序(多段各自排再合并);面试"sorted 为什么慢"——缓存 + 排序,不是流式*
- [算法: 排序 O(nlogn)/去重 O(n);关联: 域 08 Arrays.sort(底层排序)]
- 面试: "sorted 和 list.sort 谁快?"——stream 最终也要建缓存排序,优势在惰性/并行

### 3. "distinct 用什么去重？" — LinkedHashSet

场景: distinct 的实现——顺序保持吗?

- `DistinctOps.java:61-63` — 内部用 **ReduceOps.makeRef 归约到 LinkedHashSet**(`LinkedHashSet::new/add/addAll`)——不是独立 Sink!
- LinkedHashSet 特性: 去重 + **保持插入顺序**(域 09)
- 关键设计 (斜体): *distinct 复用归约框架(ReduceOps)——"去重 = 归约到 Set";LinkedHashSet 保序是"顺序流 distinct 保持第一次出现顺序"的原因;面试"distinct 保序吗"——顺序流保,并行流不保(除非 UNORDERED 语义)*
- 面试: "distinct 内存"——O(n)(Set 缓存)

### 4. "limit/skip 与短路" — SliceOps

场景: `limit(3)` 的实现——它怎么知道什么时候停?

- `ReferencePipeline.java:467` `limit` → `SliceOps.makeRef`(109)
- 实现: 计数 Sink——accept 到 limit 个后**停止接收**(短路,见域 16 第 2 篇 SHORT_CIRCUIT)
- `skip(n)`: 前 n 个丢弃,之后转发;limit+skip 组合(分页)
- 关键设计 (斜体): *limit 的"停"不是结束流——是**不再从源拉取**(短路标志让源遍历终止);面试"limit(3) 处理几个元素"——最多 3 个+链上前序(配合 sorted 则要先全部排完——**有状态在前短路失效**)*
- 面试: "sorted().limit(3) 会短路吗?"——不会:sorted 要先吃完整流,limit 只省下游;顺序敏感组合是性能陷阱

---

### 核心悬念

中间操作讲完——**终端操作怎么收尾**?`collect` 的归约框架(ReduceOps)、`anyMatch` 的短路、`findFirst` 的顺序保证、`forEach` 的并行——下一篇: 终端求值。

> → [04-terminal-eval.md](04-terminal-eval.md)
