# 06. Spliterator 与并行流 — 分割遍历、ForkJoin 引擎、使用陷阱

> 🔴 Deep | 域 16 Stream 与函数式第 6 篇(巨型域 6 篇之六)| Layer 4
> 读者处境: 面试"并行流原理/什么时候别用"——Spliterator 分割与 ForkJoin 任务树,并行流的真相。

### 1. "Spliterator 是什么？" — 可分割迭代器

场景: 集合怎么支持并行?——Spliterator 的两个能力

- `Spliterator.java:309` `tryAdvance`(单步消费)/`370` `trySplit`(**分割**: 返回子 Spliterator)/`395` `estimateSize`/`432` `characteristics`
- 特性位(`Spliterator.java:486-539`): ORDERED(0x10)/DISTINCT(0x01)/SORTED(0x04)/SIZED(0x40)/IMMUTABLE/CONCURRENT/NONNULL
- **分割递归**: trySplit 返回一半,子 Spliterator 再分割——**数据分治的基础**
- 关键设计 (斜体): *"流并行 = Spliterator 分割 + ForkJoin 执行"——trySplit 把数据切成任务粒度;特性位告诉框架能否优化(ORDERED 限制并行乱序/SUBSIZED 精确预估);面试"并行流数据怎么分"——trySplit 递归二分*
- 面试: "SIZED 特性有什么用?"——均衡分割(不 SIZED 可能分配不均)

### 2. "并行任务树" — AbstractTask

场景: 并行求值——任务怎么被创建和调度?

- `AbstractTask.java:88` — ForkJoin 任务基类(域 15): `compute()`(302): `while (sizeEstimate > sizeThreshold && trySplit() != null)` 继续 split 出子任务
- `AbstractTask.java:92` — `LEAF_TARGET = ForkJoinPool.getCommonPoolParallelism() << 2` — **叶任务粒度**(并行度×4)
- 结果合并: 子任务各自求值 → 按 combiner 合并回父任务
- 关键设计 (斜体): *"任务树"= 分治的标准形态: 根任务 split 成子树,叶子算,向上合并;LEAF_TARGET 控制分割深度(避免过细任务);面试"并行流内部结构"——ForkJoin 任务树*
- [关联: 域 15 ForkJoinPool(引擎);域 12 共享模式(合并语义)]

### 3. "并行流用什么线程池？" — commonPool

场景: `list.parallelStream().forEach(...)` — 跑在哪个线程?

- 引擎: `ForkJoinPool.commonPool()`——**全局共享池**(域 15)
- 并行度: CPU 核数 - 1(默认);`-Djava.util.concurrent.ForkJoinPool.common.parallelism` 可调
- **与业务线程池隔离**: commonPool 阻塞/繁忙会拖慢所有 parallelStream(无隔离)
- 关键设计 (斜体): *"共享公共池"是并行流的大坑——一个长任务阻塞 commonPool,全应用 parallelStream 变慢;面试"并行流线程模型"——commonPool + ForkJoin work-stealing*
- 生产: 阻塞操作(IO/锁)禁并行流;计算密集才并行;考虑自定义 ForkJoinPool(域 15)

### 4. "什么时候该用并行流？" — 性能判断

场景: 生产代码评审——parallelStream 该不该用?

- 适用: 计算密集 + 大数据量 + 无顺序依赖 + 无共享可变状态
- 陷阱: ① 小数据(分割开销 > 收益)② 有状态操作(sorted/distinct 并行开销大)③ 共享可变容器(线程不安全)④ IO/阻塞(commonPool 阻塞)
- 判断: 数据量 × 元素计算成本 > 分割与合并开销
- 关键设计 (斜体): *"并行不总是更快"是流式并行的第一课——分割+合并有固定成本;面试"什么时候不用并行流"——小数据/阻塞/有状态/顺序敏感;规则: 先串行正确,再 profile 决定并行*
- 面试: "并行流结果与串行一致吗?"——顺序流保证遭遇顺序;并行流对 ORDERED 保留顺序但开销大,findAny/无序操作更快

---

### 核心悬念

Stream 收官——**网络 IO 的多路复用**来了: `Selector` 怎么让一个线程管上万个连接?`epoll` 是什么?`SocketChannel` 与 BIO 的差异?——下一篇: 域 21 Selector 与网络 NIO。

> → 下一篇: 域 21 Selector 与网络 NIO(21-selector 系列) | 关联: 域 15 ForkJoin、域 13 原子
