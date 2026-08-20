# 域 16: Stream 与函数式 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "中间 vs 终端操作" — 01 篇 §1(Stream.java:182/647/905/1048)
- [x] "lambda 与匿名类区别" — 01 篇 §2(function 包/LambdaMetafactory)
- [x] "为什么中间操作惰性/何时执行" — 02 篇 §1-3(AbstractPipeline.java:201/226, wrapAndCopyInto 473)
- [x] "短路/无限流为什么不死循环" — 02 篇 §4(StreamOpFlag.java:630)
- [x] "sorted 为什么有状态/内存" — 03 篇 §2(SortedOps.java:50/304)
- [x] "distinct 用什么结构/保序吗" — 03 篇 §3(DistinctOps.java:61-63)
- [x] "limit 短路吗(sorted 后不短路)" — 03 篇 §4(SliceOps.java:109)
- [x] "collect 原理(容器+累加+合并)" — 04 篇 §2(ReduceOps.java:72/88)
- [x] "anyMatch 短路/复杂度" — 04 篇 §3(MatchOps.java:50/79)
- [x] "Collector 五要素" — 05 篇 §1(Collector.java:197/203/314)
- [x] "toMap 重复 key 报错" — 05 篇 §2(277)
- [x] "groupingBy 双层归约" — 05 篇 §3
- [x] "并行流原理(分割+任务树)" — 06 篇 §1-2(Spliterator.java:309/370, AbstractTask.java:88/302)
- [x] "并行流线程池/commonPool" — 06 篇 §3(92)
- [x] "什么时候别用并行流" — 06 篇 §4

## 身份 2: 生产工程师
- [x] 无限流/大数据量处理 — 02 篇 §4
- [x] toMap 重复 key 坑 — 05 篇 §2
- [x] parallelStream 阻塞陷阱 — 06 篇 §3-4
- [x] 分组统计(groupingBy)— 05 篇 §3

## 身份 3: 框架工程师
- [x] 自定义 Collector — 05 篇 §1
- [x] 并行归约结合律要求 — 04 篇 §2
- [x] ForkJoin 引擎理解 — 06 篇 §2

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Stream.java:182/197/372/388/405/468/497/555/647/905/1027/1048/1108, AbstractPipeline.java:82/101/201/226-233/372/473, ReferencePipeline.java:162/175-180/186/452/457/462/467-480, Sink.java:244, StreamOpFlag.java:630, ReduceOps.java:72/84/88-91, MatchOps.java:50/63/79/97, FindOps.java:58, Collector.java:197/203/210/220/233/241/314, Collectors.java:277/367, Spliterator.java:309/370/395/432/486-539, StreamSupport.java:67/107, AbstractTask.java:88/92/302, DistinctOps.java:61-63, SortedOps.java:50/141/304/321, SliceOps.java:109)/关键设计/跨层([算法]/[关联])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 巨型域 6 篇分段写作:1-3 批自查(跨层补齐)→4-6 批

## 身份 5: 完整性缺口检查
- [x] API(01)/流水线(02)/中间操作(03)/终端(04)/Collectors(05)/并行(06)六篇覆盖域全部面试主战场
- [x] function 包 44 接口并入 01 篇;Optional 并入 01 篇 §4
- [x] Node/SpinedBuffer(🟢)并入 04/06 篇提及
- [x] 未覆盖确认: 原始流(IntStream/LongStream/DoubleStream)与引用流同构,01 篇提及;Streams 工具类不入篇
- [x] 二次 review 修正: sorted 双版本精确化(RefSortingSink list.sort 320-321/SizedRefSortingSink Arrays.sort 353-355);验证通过: toMap 重复 key 由 uniqKeysMapAccumulator/Merger 抛 IllegalStateException(1467-1468+Javadoc 1473-1481)、groupingBy computeIfAbsent 双层(1135/1298-1305)、evaluateSequential 分派(AbstractPipeline:234/TerminalOp:84/96)
- [ ] 待办: 写作时验证 groupingBy 的精确方法行号、forEach 并行实现(ForEachOps 507)
