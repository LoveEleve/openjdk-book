# 06. Spliterator 与并行流 — 分割遍历、ForkJoin 引擎、使用陷阱

> **前置依赖**: [16-stream/02 — 流水线结构与惰性机制](02-pipeline-lazy.md)(链组装、SHORT_CIRCUIT)、[16-stream/04 — 终端求值](04-terminal-eval.md)(归约并行分片)、[16-stream/05 — Collectors 与收集器](05-collectors.md)(特征驱动并行)
> → **后续**: 域 21 Selector 与网络 NIO(21-selector-nio 系列,按写作顺序)
> 关联: 域 08 集合(集合 Spliterator 实现);域 13 原子类(CAS 并发基础);内部卷 25-gc-framework(WorkGang 并行任务)

## 并行流的底层引擎

前 5 篇把串行求值的每个环节讲完,并行只作为分支提及。这一篇看并行流的底层引擎: `Spliterator` 怎么把数据切碎?ForkJoin 任务树怎么建?`parallelStream` 跑在哪个线程池?以及什么时候并行反而慢。

## 1. "Spliterator 是什么" — 可分割迭代器

### 1.1 四个能力

`Spliterator<T>` 接口(`Spliterator.java:296`)的四个核心方法:

| 方法 | 源码 | 作用 |
|------|------|------|
| `tryAdvance(action)` | `:309` | 单步消费一个元素,返回是否还有剩余 |
| `forEachRemaining(action)` | `:325-327` | 默认实现循环 tryAdvance 直到耗尽 |
| `trySplit()` | `:370` | **分割**: 返回覆盖部分元素的子 Spliterator,自己保留其余 |
| `estimateSize()` | `:395` | 大小估计(未知/无限返回 `Long.MAX_VALUE`) |
| `characteristics()` | `:432` | 特性位 |

名称来源: Spliterator = split + iterator——既能遍历又能分割。

### 1.2 特性位

`Spliterator.java:486-584` 定义 8 个特性位:

| 特性 | 值 | 源码 | 含义 |
|------|-----|------|------|
| `DISTINCT` | 0x01 | `:493` | 元素两两不等 |
| `SORTED` | 0x04 | `:507` | 元素已排序 |
| `ORDERED` | 0x10 | `:486` | 有 encounter order,`trySplit` 必须返回**严格前缀**(`:334-335`) |
| `SIZED` | 0x40 | `:521` | 大小精确可知 |
| `NONNULL` | 0x100 | `:528` | 不含 null |
| `IMMUTABLE` | 0x400 | `:539` | 源不可变 |
| `CONCURRENT` | 0x1000 | `:567` | 源可被并发安全修改 |
| `SUBSIZED` | 0x4000 | `:584` | 分割后子与自身大小之和守恒 |

### 1.3 分割递归: 数据分治的基础

`trySplit` 返回子 Spliterator,子还能再分——递归二分直到任务粒度。`ArrayList` 的 `ArrayListSpliterator`(`ArrayList.java:1565` 起)用 `mid = (lo + hi) >>> 1` 对半切(`:1619-1623`),报告 ORDERED|SIZED|SUBSIZED(`:1667-1669`);`Stream.iterate` 的无限流返回 `Long.MAX_VALUE` 大小估计且不可分(第 2 篇 §4.3)。

面试"并行流数据怎么分": trySplit 递归二分——分割是否均衡决定负载是否均衡(SIZED/SUBSIZED 提供精确预估,不 SIZED 可能分配不均)。

关键设计(斜体):*"流并行 = Spliterator 分割 + ForkJoin 执行"——trySplit 把数据切成任务粒度,特性位告诉框架能否优化(ORDERED 限制分割取严格前缀、SUBSIZED 让大小估计精确)。面试"并行流数据怎么分": trySplit 递归二分;面试"SIZED 特性有什么用": 均衡分割与精确预估(count 的 O(1) 捷径就靠它,第 4 篇 §1)。*

## 2. "并行任务树" — AbstractTask

### 2.1 ForkJoin 任务基类

`AbstractTask` 继承 `CountedCompleter`(`AbstractTask.java:88-90`)——ForkJoin 框架的任务基类。两个关键常量:

```java
// AbstractTask.java:92 + 160-168(截取,逐字)
    private static final int LEAF_TARGET = ForkJoinPool.getCommonPoolParallelism() << 2;
...
    public static int getLeafTarget() {
        Thread t = Thread.currentThread();
        if (t instanceof ForkJoinWorkerThread) {
            return ((ForkJoinWorkerThread) t).getPool().getParallelism() << 2;
        }
        else {
            return LEAF_TARGET;
        }
    }
```

**LEAF_TARGET = 并行度 × 4**——叶任务粒度(注释 `:154-158` 说"过度分割,每个处理器约 4 个任务,允许负载均衡: 某叶偏大时其他线程来帮忙")。

### 2.2 compute: 迭代式分治

`compute()`(`AbstractTask.java:302-329`)的核心循环:

```java
// AbstractTask.java:302-329(截取,逐字)
        while (sizeEstimate > sizeThreshold && (ls = rs.trySplit()) != null) {
            K leftChild, rightChild, taskToFork;
            task.leftChild  = leftChild = task.makeChild(ls);
            task.rightChild = rightChild = task.makeChild(rs);
            task.setPendingCount(1);
            ...
            taskToFork.fork();
            sizeEstimate = rs.estimateSize();
        }
        task.setLocalResult(task.doLeaf());
        task.tryComplete();
```

- `sizeThreshold` 来自 `suggestTargetSize`(`:194-197`): `estimateSize / (并行度 × 4)`——总任务数切到约 4 × 并行度 个
- **迭代式**: 循环里 fork 一个子任务、自己继续沿另一支往下切——避免深递归(注释 `:294-299`:"alternate which child is forked versus continued")
- 叶子: `doLeaf()` 计算局部结果;合并沿 `onCompletion` 回父任务(ReduceTask 已见,第 4 篇 §2.2)

### 2.3 短路并行: AbstractShortCircuitTask

匹配/查找类终端的并行基类(`AbstractShortCircuitTask.java:101` 起): compute 循环**每轮先查共享结果** `while ((result = sr.get()) == null)`(`:109`),任一分片命中即 `shortCircuit(result)`(`:150`)写入 `AtomicReference<R> sharedResult`——整棵树停止(第 4 篇 MatchTask 就是它)。

关键设计(斜体):*"任务树"= 分治标准形态: 根任务 split 成子树、fork 一个继续一个、叶子算、onCompletion 向上合并;LEAF_TARGET(并行度×4)控制分割深度,避免任务过细。面试"并行流内部结构": ForkJoin 任务树 + trySplit 递归二分;面试"短路并行怎么停": 共享 AtomicReference 结果,每轮先查。*

## 3. "并行流用什么线程池" — commonPool

### 3.1 全局共享池

`list.parallelStream()`(`Collection.java:732-734`)→ `StreamSupport.stream(spliterator(), true)`——并行任务经 `ForkJoinTask` 提交: 调用线程不是 ForkJoinWorkerThread 时,`fork`/`invoke` 把任务推进 **`ForkJoinPool.commonPool()`**(`ForkJoinPool.java:2395`)的外部队列(`ForkJoinTask.java:704`,`ForkJoinPool.common.externalPush(this)`),一个 JVM 全局共享池。

并行度(`ForkJoinPool.java:2335-2360`): 默认 `Runtime.getRuntime().availableProcessors() - 1`(`:2355-2356`,注释 "default 1 less than #cores");可用系统属性 `java.util.concurrent.ForkJoinPool.common.parallelism` 覆盖(`:2342-2343`)。

### 3.2 共享池的坑

- **无隔离**: 所有 `parallelStream` 共用 commonPool——一个长任务(阻塞 IO/锁)占住工作线程,全应用并行流变慢
- work-stealing: 空闲线程会偷取其他线程队列里的任务(负载均衡的核心机制)
- 生产: 阻塞操作禁并行流;计算密集才并行;需要隔离时把任务提交到**自定义** `ForkJoinPool`(`ForkJoinPool` 构造器指定并行度)

面试"并行流线程模型": commonPool + work-stealing;并行度默认核数 - 1。

关键设计(斜体):*"共享公共池"是并行流的大坑——一个长任务阻塞 commonPool,全应用 parallelStream 变慢(无隔离)。面试"并行流线程模型": commonPool + ForkJoin work-stealing;生产规则: 阻塞操作(IO/锁)禁并行流,计算密集才并行,要隔离就用自定义 ForkJoinPool。*

## 4. "什么时候该用并行流" — 性能判断

### 4.1 适用与陷阱

适用: 计算密集 + 大数据量 + 无顺序依赖 + 无共享可变状态。

四大陷阱:

1. **小数据**: 分割与合并的固定成本 > 收益(任务树/线程调度本身有开销)
2. **有状态操作**: sorted/distinct 并行要分段求值再合并(第 3 篇),额外成本
3. **共享可变容器**: 线程不安全——除非用 CONCURRENT 收集器(第 5 篇 §4)
4. **IO/阻塞**: 卡住 commonPool(§3.2),影响全应用

判断公式: 数据量 × 每元素计算成本 > 分割与合并开销——才值得并行。

### 4.2 顺序保证

- 并行流对 ORDERED 源**保留 encounter order**(实测: 并行有序 toList/groupingBy 组内保序,第 5 篇)——但保序要沿任务树按顺序合并,开销大
- `findAny`/无序操作更快: NOT_ORDERED 标记允许任意分片先到先得(第 4 篇 §3.2)
- 面试"并行流结果与串行一致吗": 语义一致(收集器满足结合律时);顺序上 ORDERED 保留但费,无序更快

关键设计(斜体):*"并行不总是更快"是流式并行的第一课——分割 + 合并有固定成本。面试"什么时候不用并行流": 小数据 / 阻塞 / 有状态 / 顺序敏感;规则: 先串行正确,再 profile 决定并行;面试"并行流结果与串行一致吗": 语义一致,顺序看 ORDERED。*

跨层标注: [域 08 集合——ArrayList/数组的 Spliterator 按索引二分;域 13 原子类——共享结果的 AtomicReference 与 CAS 并发基础;内部卷 25-gc-framework(WorkGang 任务队列)——HotSpot 侧 GC 并行任务的对应机制]

## 核心悬念

Stream 收官——**网络 IO 的多路复用**来了: `Selector` 怎么让一个线程管上万个连接?`epoll` 是什么?`SocketChannel` 与 BIO 的差异?——下一篇: 域 21 Selector 与网络 NIO。

> → 域 21 Selector 与网络 NIO(21-selector-nio 系列)| 关联: 域 13 原子类(CAS)、内部卷 25-gc-framework(并行任务)
