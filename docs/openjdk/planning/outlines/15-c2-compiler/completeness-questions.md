# 域 15: C2 Compiler — 全视角提问验证

> 🔴 巨型域 177K行/8篇 | 5 身份 | 25 问

## 1. Java 开发者 — 理解 JIT 行为 (5问)

1. `for (int i = 0; i < 10000; i++) sum += arr[i];` — 这个循环在 C2 编译后会变成什么？Loop unrolling 几次？SuperWord 向量化用哪种宽度？
2. `new Point(x,y)` 在热循环中——C2 的 Escape Analysis 判断 NoEscape 后，这个 new 还会产生堆分配吗？
3. `"hello".indexOf("ll")` — C2 intrinsic inline 后，底层用的什么 x86 指令？比 Java bytecode 循环快多少倍？
4. `Math.sin(angle)` 和 `StrictMath.sin(angle)` — C2 对两者的 intrinsic 处理有什么不同？
5. `synchronized(obj) { synchronized(obj) { ... } }` — 内层锁在 C2 编译后还存在吗？

## 2. JVM 性能工程师 — 调优 C2 (5问)

6. `-XX:LoopUnrollLimit=200` — 这个值调大后，C2 会 unroll 更多的循环体。trade-off 是什么(ICache blowup?)？
7. `-XX:+UseSuperWord` flag 打开后，什么类型的循环**不会**被 SLP 向量化？相邻内存访问的条件是什么？
8. `-XX:+DoEscapeAnalysis` 关闭后，哪些 MacroExpand 优化会丢失？
9. Chaitin 的 spill cost = `use_count × loop_depth × 10` —— 这个公式的 10x loop penalty 是否合理？load from L1 cache 实际上只需要 4 cycles vs register 1 cycle？
10. `-XX:MaxInlineSize=35` — inline 决策在 Parse 阶段。如果改了 inline 大小，IGVN 的优化机会会变多还是变少？

## 3. 编译器研究者 — IR/算法验证 (5问)

11. C2 的 Sea-of-Nodes IR 和 LLVM 的 SSA IR 有什么本质区别？为什么 C2 叫 "sea" 而不是 "forest"？
12. IGVN 的 Ideal→Value→Identity 三环迭代——为什么不合并为单环？三个步骤各自修改 Node 的不同属性(结构/类型/值)是有意分离的吗？
13. ConnectionGraph 的 PointsToNode 建模——为什么用 Field-Sensitive + Flow-Sensitive——不用 Context-Sensitive？
14. Chaitin-Briggs 的 Optimistic Coloring 假设"度数<N 的 LRG 一定能着色"——这个假设在所有情况下成立吗？
15. SuperWord 的 SLP (Superword Level Parallelism) 和 LLVM 的 SLPVectorizer 有什么不同？

## 4. 架构师/SRE — 平台适配 (5问)

16. .ad 文件 36815 行——如果我要 port OpenJDK 到 RISC-V，只需要重写 .ad 文件吗？还是需要改 Matcher/ADLC？
17. C2 的 Matcher DFA 状态转移表是编译期(adlc 编译 .ad→C++)生成的——为什么不用运行时 DFA(QEMU 那种)?
18. library_call.cpp 中的 intrinsic 是平台相关的吗？`inline_string_indexOf` 的 SSE 4.2 `pcmpestri` 指令——在 ARM 上用什么替代？
19. C2 编译一次需要 1-10 秒 vs C1 的 <1ms——这个差距来自哪个阶段(Parse/IGVN/Chaitin/Output)?
20. `-XX:TieredStopAtLevel=3` (禁用 C2)——只用 C1 编译。哪些 intrinsic(MacroExpand/scalar replacement/library_call) 仍然生效？

## 5. 安全研究者 — 攻击面 + 边界 (5问)

21. `Unsafe.allocateInstance()` 绕过构造函数——C2 怎么合法生成这个 intrinsic 而不被 bytecode verifier 拒绝？
22. IGVN 的 `hash_find_insert` 值编号——如果两个不同的 Node hash 到同一值(HashDoS 攻击)，C2 会 crash 还是产生错误优化？
23. Chaitin 的 Split 阶段可能插入 spill code——如果 spilled LRG 在 safepoint 被 GC 扫描，栈上的值需要是 OopMap 中的正确类型吗？
24. library_call.cpp:6991 行——如果 `vmIntrinsics::ID` 的 predicate 在 IGVN 中错误检测(假阳性)，intrinsic 被 inline 到不该 inline 的地方——后果是什么？
25. MacrosExpand 的 Scalar Replacement 消除 AllocateNode——如果 EA 错误地标记了 ArgEscape 为 NoEscape，原本应该存活的堆对象被拆为栈变量——GC 会丢失这个对象吗？
