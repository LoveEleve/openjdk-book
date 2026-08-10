## 全视角提问验证：G1 GC (域26)

> 巨型域 (~46360行, 197文件) | 7篇 | 目标 20+ 题

| # | 身份 | 子主题 | 问题 | 覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | Region | HeapRegion 6种类型—Humongous 怎么跨 Region 分配？ | ✅ 篇1-§1 |
| 2 | 开发者 | SATB | pre-write barrier save old value→enqueue SATB→标记线程怎么找到？ | ✅ 篇2-§1 |
| 3 | 开发者 | RSet coarsening | Sparse→Fine→Coarse 升级阈值——每级多少个 cards？ | ✅ 篇3-§1 |
| 4 | 开发者 | G1Allocator | 三层: TLAB→AllocRegion→Global CAS—每层分配失败怎么 fallback？ | ✅ 篇4-§1 |
| 5 | 开发者 | IHOP | 自适应 IHOP——学习什么指标？怎么调整？ | ✅ 篇5-§1 |
| 6 | 开发者 | G1Barrier | pre+post barrier 在 C2 Ideal graph 中怎么表示？ | ✅ 篇6-§3 |
| 7 | 开发者 | Full GC | G1FullCollector 4 phases—与 normal evacuation 的区别？ | ✅ 篇7-§1 |
| 8 | 性能工程师 | pause prediction | G1Predictions 用 avg+std—MaxGCPauseMillis 约束有效吗？ | ✅ 篇5-§3 |
| 9 | SRE | Full GC 触发 | 日志中 Full GC 出现→怎么区分 "evacuation failure" vs "System.gc"？ | ⚠️ 篇7-§1 有触发列表，log 格式未展开 |
| 10 | 架构师 | Region vs Generation | G1 放弃固定 Young/Old——为什么？G1 的 Region 模型优势？ | ✅ 篇1 |
| 11 | 架构师 | Mixed GC vs GC 策略 | 为什么需要 Mixed GC(Young+Old 结合)？纯 Young GC+Full GC 够不够？ | ✅ 篇5-§2 |
| 12 | 子系统开发者 | G1Barrier C2 | 给 G1 加一个 C2 barrier optimization——改哪些文件？ | ✅ 篇6-§3 |
| 13 | 学生 | 为什么叫 G1 | "G1" 是 Garbage-First——"先收集垃圾最多的"？ | ✅ 篇1 |
| 14 | 学生 | Humongous | 大数组(>50% Region) 为什么不 move？Evacuation 代价？ | ✅ 篇4-§2 |
| 15 | 学生 | Concurrent vs STW | 并发标记和非并发标记——对应用延迟的影响？ | ✅ 篇2-§1 |

15问: 14✅ + 1⚠️
