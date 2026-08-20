# Ch4-08 Cleaner、直接内存释放与平台适配 — rewrite-plan

## 篇章定位

- 核心困惑：前面已经知道 direct buffer 不靠普通 GC 时机来完成业务级释放，也知道 leak detector 能定位“没归零”的对象，但更底层的问题还没解释：当 Netty 真要释放 direct memory 时，到底是谁在做这件事？为什么同时出现 `CleanerJava6`、`CleanerJava9`、`CleanerJava24Linker`、`CleanerJava25`、`DirectCleaner`、`UnpooledUnsafeNoCleanerDirectByteBuf`、`OutOfDirectMemoryError` 这么多名字？
- 一句话顿悟：Netty 在“直接内存如何分配/重分配/释放”这件事上同时面对三个维度的约束：JDK 版本差异、Unsafe/MemorySegment/本地链接能力差异，以及“清理成本是否适合频繁调用”的分配器策略差异。于是它把 direct memory 清理抽象成 `Cleaner` 接口，再由 `PlatformDependent` 在不同平台/JDK 条件下选择 `DirectCleaner`、Java6/9 cleaner、Java24/25 MemorySegment 变体或 NOOP 回退路径。
- 文章边界：本篇主讲 `Cleaner` 抽象、`DirectCleaner` 与 `LEGACY_CLEANER` 选择、JDK 6/9/24/25 适配差异、direct memory counter / limit、`UnpooledUnsafeNoCleanerDirectByteBuf` 的 no-cleaner 路径和 `OutOfDirectMemoryError` 的含义；不展开所有 `PlatformDependent0` 反射/Unsafe 细节，不重讲 leak detector 定位逻辑。

## 依赖

### HARD

- Ch4-03 `ch4-bytebuf/03-heap-vs-direct.md`：理解 heap/direct 的根本差异。
- Ch4-06 `ch4-bytebuf/06-ownership-and-reference-counting.md`：理解对象 ownership 结束不等于底层物理内存立刻如何释放。
- Ch4-07 `ch4-bytebuf/07-leak-detector-and-tracking.md`：理解 leak detector 关注“谁没归零”，本篇再下钻“归零后谁来真释放”。
- Ch8-05 `ch8-memorypool/05-pooled-allocator-overview.md`：理解池化和 huge/direct 路径如何接到 direct memory 分配器。

### SOFT

- Ch8-07：只复用 direct memory 指标和诊断边界。
- Ch5-03：只复用 thread-local / cleanup “受控清理”的思路。

### NAV

- 后续：直接内存调优与系统级诊断专题。
- 后续：Java 版本迁移对 Netty direct memory 路径的影响。

## 结构设计

### 1. 开场：`release()` 已经讲清楚了，但“谁真的 free 掉 direct memory”还没讲
- 从读者误区切入：引用计数归零 != 自动知道底层是用哪种方式回收 direct memory。
- 引出三类约束：JDK 版本、Unsafe/MemorySegment 能力、清理成本。
- 预计 900-1200 字。

### 2. `Cleaner` 抽象：Netty 为什么先把“释放 direct memory”统一成接口
- `allocate/reallocate/freeDirectBuffer/hasExpensiveClean` 的职责边界。
- `CleanableDirectBuffer` 表示“buffer + clean 动作”的组合体，而不是裸 ByteBuffer。
- 预计 1500-1900 字。

### 3. `PlatformDependent`：真正的选择器
- `io.netty.maxDirectMemory`、`DIRECT_MEMORY_COUNTER`、`DIRECT_MEMORY_LIMIT`。
- `LEGACY_CLEANER` 如何在 Java6/9/24/25/NOOP 中选择。
- `CLEANER` 如何在存在 Unsafe no-cleaner constructor 时切到 `DirectCleaner`。
- 预计 2200-2800 字。

### 4. `DirectCleaner`：为什么它是“快路径”
- 直接走 `allocateDirectNoCleaner / reallocateDirectNoCleaner / freeMemory`。
- 手工维护 direct memory counter。
- `hasExpensiveClean=false` 的意义：为什么这更适合频繁 clean 的 unpooled/direct 路径。
- 预计 1800-2300 字。

### 5. `CleanerJava6 / CleanerJava9 / CleanerJava24Linker / CleanerJava25`：JDK 版本和平台适配
- Java6/9 路径：通过 cleaner / `Unsafe.invokeCleaner` 清理 ByteBuffer。
- Java24 linker：本地链接 `malloc/free`，且要求 native access、64-bit 条件。
- Java25：基于 shared arena 的 MemorySegment 路径，`hasExpensiveClean=true`。
- 为什么 `freeDirectBuffer(ByteBuffer)` 在新路径里可能不再支持任意 buffer。
- 预计 2400-3000 字。

### 6. `UnpooledUnsafeNoCleanerDirectByteBuf`：为什么有“no-cleaner direct buffer”这条分支
- `allocateDirect/freeDirect` 被禁用，改走 `reallocateDirect(cleanable, newCapacity)`。
- 说明这个类不是“忘了 cleaner”，而是显式依赖 cleaner 抽象和 no-cleaner direct memory 能力。
- 预计 1400-1800 字。

### 7. `OutOfDirectMemoryError` 与诊断边界
- 它不是普通 heap OOM，而是 direct memory 限额 / 分配失败的专门信号。
- 需要和 leak、池化保留、操作系统内存观测分开看。
- 预计 1000-1400 字。

### 8. 收网：direct memory 清理不是单一路径，而是一套平台选择策略
- 总结 JDK 版本、能力检测、清理成本与分配器策略的关系。
- 桥接到后续 direct memory 调优与诊断。
- 预计 600-800 字。

## 证据清单

- `common/src/main/java/io/netty/util/internal/Cleaner.java:20-68`
- `common/src/main/java/io/netty/util/internal/DirectCleaner.java:20-82`
- `common/src/main/java/io/netty/util/internal/CleanerJava6.java:30-174`
- `common/src/main/java/io/netty/util/internal/CleanerJava9.java:30-151`
- `common/src/main/java/io/netty/util/internal/CleanerJava24Linker.java:28-237`
- `common/src/main/java/io/netty/util/internal/CleanerJava25.java:27-194`
- `common/src/main/java/io/netty/util/internal/PlatformDependent.java:121-235`
- `common/src/main/java/io/netty/util/internal/OutOfDirectMemoryError.java:20-29`
- `buffer/src/main/java/io/netty/buffer/UnpooledUnsafeNoCleanerDirectByteBuf.java:23-54`
- `buffer/src/main/java/io/netty/buffer/VarHandleByteBufferAccess.java:22-28`

## 失败方案推演

- 只依赖普通 GC/finalize：业务完成与物理释放时机脱钩。
- 所有 JDK 一律只走一种 cleaner 路径：模块系统、Unsafe 可用性、MemorySegment 能力差异都会打破假设。
- 无视清理成本差异：频繁 unpooled clean 与池化保留路径的成本无法统一对待。
- 只看 direct OOM 就断定 leak：还要区分 direct limit、counter、平台能力和 ownership 问题。

## 边界清单

- 本篇不把某条 cleaner 路径写成所有 JDK/平台都稳定可用的统一真相。
- 本篇不把 `hasExpensiveClean()` 直接等同为基准结论；它是当前实现对清理成本级别的策略信号。
- 本篇不重讲 leak detector 的追踪逻辑，只消费其结论。
- 本篇不把 `VarHandleByteBufferAccess` 写成 cleaner 本身；它只说明现代 JDK / verifier 兼容适配也是 direct 路径的一部分。

## 深审预警

- [ ] 不把 DirectCleaner 和 Java6/9/24/25 cleaner 路径混成一套实现。
- [ ] 不把 `OutOfDirectMemoryError` 写成 heap OOM 的别名。
- [ ] 不把 `UnpooledUnsafeNoCleanerDirectByteBuf` 写成绕过清理，而要写成依赖另一套 direct clean 能力。
- [ ] 不把 PlatformDependent 的默认选择写成所有环境的最佳配置。