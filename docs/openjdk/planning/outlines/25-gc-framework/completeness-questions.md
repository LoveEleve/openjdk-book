## 全视角提问验证：GC Framework (域25)

> 域: 巨型域 (~37400 行, 184 文件) | 6 篇 | 目标 25+ 题

| # | 身份 | 子主题 | 问题 | 覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | Access API | Access<decorators>::store() 怎么在编译期静态 dispatch 到 BarrierSet？ | ✅ 篇1-§1 |
| 2 | 开发者 | BarrierSet 3层 | 怎么给自定义 GC 实现 BarrierSetC1/C2/Assembler？ | ✅ 篇1-§2 |
| 3 | 开发者 | TLAB | TLAB::allocate 的 fast path 在 x86 上怎么 inline？ | ✅ 篇2-§1 |
| 4 | 开发者 | ReferenceProcessor | process_discovered_references 四阶段调用顺序——为什么 Final 在 Weak 之后？ | ✅ 篇3-§1 |
| 5 | 开发者 | TaskQueue steal | pop_global 的 64-bit CAS _age——tag 为什么需要？ABA 问题实例？ | ✅ 篇4-§1 |
| 6 | 开发者 | CardTable | byte_for() 的计算公式——card_shift=9→为什么 512 bytes 而非 256/1024？ | ✅ 篇5-§1 |
| 7 | 开发者 | OopStorage | OopStorage 并发 allocate——thread-private block 满了怎么换？ | ✅ 篇6-§1 |
| 8 | 性能工程师 | TLAB hit rate | TLAB 大小自适应——什么 factor 决定 size？ | ✅ 篇2-§3 |
| 9 | 性能工程师 | Card scan | CardTable scanning——全表 dirty 时最多多少 overhead？ | ⚠️ 未量化 |
| 10 | 架构师 | BarrierSet设计 | BarrierSet 的三层为什么分开(Assembler独于C1/C2)？ | ✅ 篇1-§2 |
| 11 | 架构师 | Access 模板 | Access<> 模板元 vs 虚函数——性能差多少？ | ✅ 篇1-§1 |
| 12 | 架构师 | 死代码 | GenCollectedHeap 死代码为什么还保留？对理解 G1 设计有什么价值？ | ✅ 篇6-§4 |
| 13 | 子系统开发者 | 自定义GC | 给 JVM 加一个自定义 GC 需要实现哪些类？最小集合？ | ✅ 篇1-§2 |
| 14 | 学生 | GC 为什么有 barrier | barrier 和 GC 的关系——不插入 barrier 会怎样？ | ✅ 篇1-§3 |
| 15 | 学生 | TLAB vs malloc | TLAB 和 C malloc 的区别——为什么 Java 分配这么快？ | ✅ 篇2-§1 |
| 16 | 学生 | 四种引用 | 写 Java 代码用 Soft/Weak/Phantom——它们的行为差异？ | ✅ 篇3-§1 |

16问: 15✅ + 1⚠️ (0❌)
