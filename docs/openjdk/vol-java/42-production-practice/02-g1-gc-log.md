# G1 GC 日志解读：从一次 Young GC 停顿里，能看出什么问题、能误判什么问题

> 基于 JDK 11 默认收集器 G1 与 `-Xlog:gc*` 日志体系。本文讨论的是 G1 的 Young GC 停顿日志怎么读、`Parallel Time`/`Ref Proc`/`Humongous` 这些字段代表什么，以及从几张性能数字里该得出什么、不该得出什么。G1 的实现在 HotSpot 而非 `java.base`，因此本文的"证据"是命令行参数与日志输出事实，不是 Java 层源码行号；且 JDK 8 的 `-XX:+PrintGCDetails` 与 JDK 11 的 `-Xlog` 是两代不同的日志语法，不能混用理解。
> **前置依赖**：[常见性能优化与 GC 背景](../24-time-date/06-clock-best-practice.md)（工程经验层）
> → **后续**：按扩展计划进入内存泄漏与 CPU 定位

## 先看一段会让很多人误判"线程卡死"或"GC 很严重"的日志

线上服务突然慢了一下，运维拉出一段 GC 日志：

```
[GC pause (G1 Evacuation Pause) (young), 0.0312390 secs]
   [Parallel Time: 11.1 ms, GC Workers: 8]
      [Ext Root Scanning (ms): Min: 0.8, Avg: 1.4, Max: 4.1, Diff: 3.4]
      [Update RS (ms): Min: 0.0, Avg: 0.0, Max: 0.0, Diff: 0.0]
      [Scan RS (ms): Min: 0.0, Avg: 0.0, Max: 0.0, Diff: 0.2]
      [Object Copy (ms): Min: 6.7, Avg: 9.0, Max: 9.6, Diff: 2.9]
      [Termination (ms): Min: 0.0, Avg: 0.1, Max: 0.3, Diff: 0.3]
   [Other: 19.7 ms]
      [Ref Proc: 16.8 ms]
      [Humongous Register: 1.8 ms]
      [Humongous Reclaim: 0.0 ms]
```

第一次看到这段日志，很多人会立刻得出两种结论。第一种是"停顿好几毫秒，GC 是不是拖垮了系统"；第二种是"`Ref Proc` 占了 16.8ms，是不是引用泄漏"。这两个结论都可能错。

这段日志最该注意的事实是它的总时长：`0.0312390 secs`，也就是约 31ms。在这 31ms 里，真正卡住所有应用线程的是一个 Stop-The-World（STW）停顿。而停顿里最贵的两段——`Parallel Time` 11.1ms 和 `Other` 19.7ms——加起来才构成这 31ms。先看总时长，再拆内部字段，顺序不一样，结论完全不同。

这里至少有三个失败方案。

第一种失败方案，是只看单行数字就下结论。看到 `Ref Proc: 16.8 ms` 就以为是"引用泄漏"，但其实 `Ref Proc` 是 STW 引用处理器扫引用队列的耗时，它 16.8ms 大概率说明**这个停顿里有很多软/弱/虚引用要处理**，不一定代表泄漏。

第二种失败方案，是把"GC 停顿久"直接等同于"GC 调参失败"。一次 31ms 的 Young GC 在多数业务下是可接受的抖动；真正要判断的是它的频率、累计占比和对业务延迟的冲击，而不是单个数字的大与小。

第三种失败方案，是把打印参数当成运行时开关反复开关。JDK 8 时代 `-XX:+PrintGCDetails` 是印在进程参数里的；JDK 11 改成 `-Xlog:gc*`，很多人拿着老参数想临时换语法，结果日志格式对不上，反而没法对照历史。

所以这三个失败方案指向同一个顿悟：**读 GC 日志的核心不是"认识每个字段"，而是先问三个问题——这次停顿是哪种 GC？它总共停了多久？它停得值不值？** 字段只是用来回答"停得值不值"的证据，不是用来逐个抠数字的。

## 一、先分清这是哪种停顿：`G1 Evacuation Pause (young)` 是什么

### 读日志第一行先回答"哪种 GC"

G1 的日志里，`GC pause (G1 Evacuation Pause) (young)` 是一类常见停顿。拆开看：

- `GC pause`：这是一次会停住应用线程的 STW 停顿
- `(G1 Evacuation Pause)`：G1 把存活对象从若干 region 复制（evacuate）到别处的停顿
- `(young)`：这次只收集年轻代 region，不是 Full GC，也不是并发标记

一次 `(young)` 停顿的 STW 原因很直接：年轻代 region 满了，G1 需要把这些 region 里还活着的对象搬到新 region。它不像 Full GC 那样要全堆清扫，所以通常更短。

### 这一行最该记住的边界

看到 `(young)` 就只该把它当成"一次年轻的 evacuation 停顿"。它不告诉你是谁在制造这么多垃圾，也不告诉你老年代有没有问题。把"出现 YGC 停顿"当成"要开始调参了"，是最常见的过度反应。Young GC 本身是 G1 正常工作的节奏，不是故障信号。

## 二、总时长 vs 内部字段：为什么先看 `0.0312390 secs` 再看别的

### STW 停顿里，Parallel Time 和 Other 是两块主要的账

这段日志把一次停顿拆成两块：

- `[Parallel Time: 11.1 ms, GC Workers: 8]`：并行的 GC worker 线程实际参与 STW 工作的时间。这里 8 个 worker 通常对应 `-XX:ParallelGCThreads` 的配置。
- `[Other: 19.7 ms]`：并行的部分之外，由主 GC 线程串行处理的杂项，比如引用处理、清卡表、回收 Humongous 区。这段日志里 `Other` 的 19.7ms 明显大于 `Parallel Time` 的 11.1ms，而且里面最大的一块是 `Ref Proc: 16.8ms`。

"Other" 这个名字很误导人，它看起来像"无关紧要的杂项"，实际上可能是整个停顿里最大的一块。先看总时长 `0.0312390 secs`，再看两块账加起来是否对得上，最后才去抠某个子字段——这个顺序能避免你被一个孤立的数字带偏。

### 为什么"看数字之前先问值不值"

一次 31ms 的 YGC 停顿，如果发生在每秒几十万请求的高频服务上，可能是需要关注的抖动；如果发生在低频批处理进程上，完全可以忽略。数字本身没有意义，意义取决于"它打断了什么、多久打一次、占运行时间的百分比"。所以第一步永远是记录总时长和停顿频率，而不是盯着某个字段的绝对值。

## 三、`Ext Root Scanning`、`Update RS`、`Object Copy`：这些字段在回答什么问题

### 每个并行字段其实都在说"时间花在哪了"

`Parallel Time` 内部还有细分，每个字段都对应一个 GC 阶段：

- `Ext Root Scanning`：扫描 GC 根（线程栈引用、JNI、静态字段等），找哪些根引用了要收集的 region。时间高可能意味着根很多或线程栈很深。
- `Update RS`：把记录在缓冲里的引用更新信息，合并进各 region 的 Remembered Set（RSet）。它对年轻代停顿通常很小，但如果很大，可能说明跨 region 的老年代引用很密集。
- `Scan RS`：遍历 RSet，检查有多少指向收集 region 的引用。扫出来的引用数决定后续 Object Copy 的负担。
- `Object Copy`：把收集 region 里存活的对象复制到新 region。**这一段几乎总能看懂：它越大，说明这个停顿里复制的存活对象越多。**
- `Termination`：GC worker 干完活后互相等待、尝试偷取剩余任务的时间。它很小是好事，说明工作分配均衡。

### 这些字段连成的一句话

把上面几个字段连起来，就是一次 Young GC 的工作流：**先找到有哪些根指向要收集的 region，再看 RSet 里有哪些跨 region 引用，然后把这些 region 里还活着的对象复制出去，最后收尾。** 所以当你看到 `Object Copy` 特别大，应该想到"这次停顿搬了很多活对象"，而不是"线程好多"；看到 `Scan RS` 明显上涨，才该往"区域间引用变多"去想。

## 四、`Ref Proc` 高，是不是泄漏信号

### `Ref Proc` 到底是什么

`Ref Proc`（Reference Processing）是 STW 阶段里处理引用对象的耗时。它统计的是停顿期间，G1 遍历并处理 WeakReference、SoftReference、PhantomReference、FinalReference 等引用类型的队列所花的时间。

`Ref Proc` 高，最直接的解释是：**这次停顿里需要处理的引用对象数量多。** 引用多，处理时间就长。而"引用对象数量多"的原因可能很多：系统里确实有大量弱引用缓存、有大量 finalize 任务、或者刚经历了一次对象潮。它本身并不直接等于"泄漏"。

### 和泄漏的边界

泄漏通常是通过"引用越来越多但该清的不清"慢慢暴露的，而不是靠一次 `Ref Proc: 16.8ms` 就能断言。正确的判断路径是：`Ref Proc` 高 + 伴随停顿频率上升 + 堆占用持续不降，三个一起看，才有资格往"引用相关资源泄漏"的方向查。单个 `Ref Proc` 数字高，最多是提示"该看看你的引用用得多不多"，不是结论。

具体怎么操作：`Ref Proc` 高那次停顿之后，连续观察几轮 YGC 的 `Ref Proc` 值和堆占用趋势。如果每次 YGC 的 `Ref Proc` 都显著在 10ms 以上，并且堆占用在 YGC 后没有明显下降（例如每次 YGC 后 `Eden` 回收但 `Heap` 占用率持续缓慢爬升），才需要怀疑是引用对象泄漏。如果只是偶尔一次 16.8ms，其余 YGC 的 `Ref Proc` 都在 1-2ms，那更可能是本地波动，不需要深入调查。

## 五、`Humongous Register` / `Humongous Reclaim` 和那些大对象

到这里，一次 YGC 停顿的主要字段已经走完了：停顿类型、总时长、并行子阶段、`Other` 里的引用处理。接下来这一节是"大对象"相关的两个字段，它们不是每次停顿都会出现，但一出现就值得单独看。

### 大对象在 G1 里是什么命运

G1 中，超过 region 大小一半的对象会被当作 "Humongous" 对象处理，它会被放到连续的一组 region 里。日志里的这两个字段分别对应：评估哪些 Humongous 区是无死对象候选并登记（`Humongous Register`），以及把确认死亡的 Humongous 区回收并释放回空闲列表（`Humongous Reclaim`）。

### 为什么这两个字段值得单独看

`Humongous Reclaim` 在 YGC 停顿里如果能回收，通常说明有 Humongous 对象已死。如果频繁出现 Humongous 且 `Reclaim` 一直很低，就该怀疑是不是有大对象长期存活、占着连续 region 不还。这类大对象问题不是靠"调大堆"能自然缓解的，它来自对象本身太大且存活过久。

## 六、JDK 8 的 `PrintGCDetails` 和 JDK 11 的 `-Xlog`：为什么日志格式对不上

### 两代日志体系的边界

JDK 8 时代，GC 日志靠一组标志开启：`-XX:+PrintGC`、`-XX:+PrintGCDetails`、`-XX:+PrintGCDateStamps`、`-XX:+PrintHeapAtGC` 等。JDK 9 起，统一的 `-Xlog` 取代了这些标志，JDK 11 里推荐写法是 `-Xlog:gc*=info` 或用 `gc`、`gc+heap`、`gc+ergo` 这样的标签组合。

对生产排障来说，这条边界的影响很实际：**如果你从 JDK 8 迁移到 JDK 11，之前 `PrintGCDetails` 打的日志和新 `-Xlog` 打的不完全同构，不能简单地拿旧版字段一一对应新日志，更不能把 JDK 8 日志的某一行直接当成 JDK 11 同一语义的证据。** 迁移期建议保留一段时间新旧两套日志做对拍，确认关键数字能对上。

### 这也解释了为什么"临时开关日志"要谨慎

`-Xlog` 支持在运行期用 `jcmd <pid> VM.log output=gc.log` 或 `jcmd <pid> GC.rotate_log` 调整输出，但生产环境的日志策略最好启动时就定好，而不是事后靠记忆拼命令。因为日志本身有开销，且不同标签组合的输出量差异很大，临时把 `-Xlog:gc*=debug` 全量打开可能在问题排查的同时引入新的观测负担。

## 五个最容易混掉的边界：YGC 不是故障信号，Other 不是杂项可忽略，Ref Proc 高不是泄漏结论，Object Copy 大不是线程多，JDK 8 日志不等于 JDK 11 日志

第一，`G1 Evacuation Pause (young)` 不是故障信号。它是 G1 正常的年轻代回收节奏，不是 Full GC，也不直接代表堆有问题。看到 YGC 就调参，是把正常节奏误判为异常。

第二，`Other` 不是"杂项、可忽略"。它可能是整个停顿里最大的一块，里面往往有 `Ref Proc` 这样的耗时大头。读日志要先看 `Other`，不能因为它名字叫 Other 就跳过去。

第三，`Ref Proc` 高不是泄漏结论。它只说明这次停顿处理的引用对象数量多，泄漏需要"引用多 + 停顿频率升 + 堆占用不降"三个信号一起看，才能往那个方向查。

第四，`Object Copy` 大不是线程多。它反映的是这次停顿搬了多少存活对象，与 GC worker 数量没有因果关系。读到 `Object Copy` 大，应该想"存活对象搬运量上来了"，而不是"线程配置要改"。

第五，JDK 8 日志不是 JDK 11 日志。前者走 `PrintGCDetails` 系列标志，后者走 `-Xlog`，两者字段不完全同构。跨版本排查时不能拿旧版日志字段直接套新版语义，迁移期建议新旧对拍。

把这五条边界记稳，G1 日志就不会再被读成"一串需要背的缩写"。它真正想讲的是：一次停顿 = 哪种 GC + 停多久 + 哪块耗时最多；先回答这三件事，再看字段合不合理，才谈得上判断"要不要调参、是不是泄漏"。

## 收网：读 G1 日志的顺序，是先总时长，再哪块最贵，最后才谈字段语义

回到开头那段日志，现在能按正确顺序读一遍了。

`0.0312390 secs` 是一次约 31ms 的 STW 停顿。`Parallel Time` 11.1ms 是并行 worker 的活，里面 `Object Copy` 占了 9ms 上下；`Other` 19.7ms 是串行部分，里面 `Ref Proc` 16.8ms 是引用处理的大头。合起来解释是：这次年轻代停顿主要花在两个地方——复制存活对象、处理引用对象。至于要不要紧张，取决于它多频繁、打断的是什么、占比多少。

把整篇压成一张总图：

```text
读 G1 日志
  1. 先看是哪类停顿（G1 Evacuation / young 或 full）
  2. 再看总时长，别先抠字段
  3. Parallel Time 拆阶段：谁在搬对象、谁在扫根、谁在整理 RSet
  4. Other 别跳过：Ref Proc / Humongous 往往在这里
  5. 单个数字高 ≠ 结论，要配合频率、堆占用一起判断
  6. 记住版本边界：JDK 8 PrintGCDetails ≠ JDK 11 -Xlog
```

如果这一篇解决的是"日志到底在说什么"，下一篇就会沿着诊断链往下走：当 GC 停顿、CPU、内存三者都异常时，怎样用线程转储、堆转储和 JFR 把"现象描述"升级成"根因定位"。