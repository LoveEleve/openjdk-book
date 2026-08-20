# Ch4-08 Cleaner、直接内存释放与平台适配 — Review Notes

## 第一轮：事实审

### 已核对的核心结论

1. `Cleaner` 当前统一定义 `allocate/reallocate/freeDirectBuffer/hasExpensiveClean` 这组 direct memory 生命周期动作，证据：`common/src/main/java/io/netty/util/internal/Cleaner.java:20`。  
2. `Cleaner.reallocate(...)` 默认实现当前是“新建 + 拷贝 + clean old”，但允许具体实现覆盖，证据：`common/src/main/java/io/netty/util/internal/Cleaner.java:34`。  
3. `PlatformDependent` 当前同时维护 `DIRECT_MEMORY_COUNTER`、`DIRECT_MEMORY_LIMIT`、`CLEANER`、`LEGACY_CLEANER` 和 `NOOP`，证据：`common/src/main/java/io/netty/util/internal/PlatformDependent.java:121`。  
4. `io.netty.maxDirectMemory` 当前会影响 direct memory 计数与 cleaner 选择策略，证据：`common/src/main/java/io/netty/util/internal/PlatformDependent.java:174`。  
5. `LEGACY_CLEANER` 当前在 Java6/9/24/25/NOOP 之间按平台能力选择，`CLEANER` 当前在满足 Unsafe + no-cleaner constructor 条件时切到 `DirectCleaner`，证据：`common/src/main/java/io/netty/util/internal/PlatformDependent.java:204`、`:231`。  
6. `DirectCleaner` 当前直接使用 `allocateDirectNoCleaner/reallocateDirectNoCleaner/freeMemory`，并显式维护 memory counter，证据：`common/src/main/java/io/netty/util/internal/DirectCleaner.java:20`。  
7. `DirectCleaner.hasExpensiveClean()` 当前返回 false，证据：`common/src/main/java/io/netty/util/internal/DirectCleaner.java:47`。  
8. `CleanerJava6` 当前通过 `DirectBuffer.cleaner().clean()` 这类 MethodHandle 路径释放 direct ByteBuffer，证据：`common/src/main/java/io/netty/util/internal/CleanerJava6.java:30`。  
9. `CleanerJava9` 当前通过 `Unsafe.invokeCleaner(ByteBuffer)` 路径释放 direct ByteBuffer，证据：`common/src/main/java/io/netty/util/internal/CleanerJava9.java:30`。  
10. `CleanerJava24Linker` 当前在满足 native access、64-bit 等条件时，通过 linker 直接链接 `malloc/free`，而不能清理任意来源的 ByteBuffer，证据：`common/src/main/java/io/netty/util/internal/CleanerJava24Linker.java:64`、`:201`。  
11. `CleanerJava25` 当前基于 shared `Arena` / `MemorySegment` 路径分配 direct memory，并把 `hasExpensiveClean()` 标成 true，证据：`common/src/main/java/io/netty/util/internal/CleanerJava25.java:27`、`:189`。  
12. `UnpooledUnsafeNoCleanerDirectByteBuf` 当前禁用普通 `allocateDirect/freeDirect`，改走 `PlatformDependent.reallocateDirect(cleanable, newCapacity)`，证据：`buffer/src/main/java/io/netty/buffer/UnpooledUnsafeNoCleanerDirectByteBuf.java:23`。  
13. `OutOfDirectMemoryError` 当前是 direct memory 分配受限时的专门错误类型，不是 heap OOM 别名，证据：`common/src/main/java/io/netty/util/internal/OutOfDirectMemoryError.java:20`。  
14. `VarHandleByteBufferAccess` 当前说明 direct/heap ByteBuffer 访问的 verifier/JDK 兼容适配也是现代 direct 路径的一部分，但它本身不是 cleaner，证据：`buffer/src/main/java/io/netty/buffer/VarHandleByteBufferAccess.java:22`。

### 深审发现

1. **高风险：容易把 DirectCleaner 和 Java6/9/24/25 cleaner 路径混成同一实现。** 正文已明确“兼容路径”和“no-cleaner 快路径”的层次。  
2. **中风险：容易把 `OutOfDirectMemoryError` 写成 heap OOM 变体。** 正文已改成 direct memory 策略信号。  
3. **中风险：容易把 `UnpooledUnsafeNoCleanerDirectByteBuf` 写成绕过清理。** 正文已明确它依赖另一条 direct clean 路径。  
4. **中风险：容易把 `hasExpensiveClean()` 写成基准结论。** 正文已限定为当前实现给 allocator 的策略信号。  
5. **低风险：容易把 PlatformDependent 默认选择写成所有环境最佳配置。** 正文已保留平台/JDK/权限差异边界。

## 第二轮：因果审

- ownership 结束 != 自动知道底层 direct memory 如何释放 -> 需要 Cleaner 抽象：✅  
- 平台能力、JDK 版本、Unsafe/MemorySegment、本地链接权限共同决定 direct clean 路径：✅  
- `PlatformDependent` 先选兼容 cleaner，再尝试切到 `DirectCleaner` 快路径：✅  
- no-cleaner 路径需要自己维护 direct memory counter 与 limit：✅  
- 新 JDK 路径下 clean 成本和任意 ByteBuffer 清理能力都不再相同：✅

## 第三轮：结构审

正文结构按“release 已讲但 direct free 还没讲 -> Cleaner 抽象 -> PlatformDependent 选择器 -> DirectCleaner -> Java6/9 路径 -> Java24/25 路径 -> NoCleanerDirectByteBuf -> OutOfDirectMemoryError -> 收网”推进，没有按类文件顺序平铺。✅

失败方案已覆盖：
- 只依赖普通 GC/finalize  
- 所有 JDK 统一一种 cleaner 路径  
- 无视清理成本差异  
- 只看 direct OOM 就断定 leak  
满足方法论要求。✅

## 第四轮：读者审

删除代码块后，正文仍应能复述：
- Cleaner 是 direct memory 生命周期协议，不是某个具体 cleaner 名字  
- PlatformDependent 才是真正的路径选择器  
- DirectCleaner 与 Java6/9/24/25 路径的层次和差异  
- NoCleanerDirectByteBuf 不是绕过清理，而是依赖另一条 direct clean 能力  
- OutOfDirectMemoryError 代表独立于 heap 的 direct memory 额度失败语义  

当前正文满足删码后主线仍成立。✅

## 第五轮：边界审

- 未把某条 cleaner 路径写成所有 JDK/平台统一真相。✅  
- 未把 `hasExpensiveClean()` 写成基准结论。✅  
- 未重讲 leak detector 追踪逻辑。✅  
- 未把 `VarHandleByteBufferAccess` 混写成 cleaner 本身。✅

## 第六轮：依赖审

- 依赖 Ch4-03、Ch4-06、Ch4-07、Ch8-05 前置，真实存在。✅  
- 依赖 Ch8-07 的 direct memory 指标边界，正文只复用结论。✅

## 机械检查

- 禁用词：`此处不再赘述 / 不再展开 / 类似地 / 同理 / 依此类推 / 篇幅所限 / 显然 / 容易看出 / 细节读者自行阅读源码` 均未命中。✅  
- 代码块：未使用 fenced code block。✅  
- 源码引用：已逐条核对。✅  
- 去掉代码块后正文仍成立：是。✅  
- 正文字符数：约 12,645。  
- 去掉常见 markdown 标记后的字符数：约 12,196。  
- 目标定位：重大机制篇，满足篇幅要求。✅

## 结论

当前正文已经建立 direct memory cleaner 的平台选择主线：Cleaner 抽象 -> PlatformDependent 选择 -> 具体路径 -> NoCleaner ByteBuf 分支 -> direct memory limit / error 语义。本篇不承担 leak detector 的追踪结论，也不承担 allocator metrics 的诊断结论；这些分别留在 Ch4-07 与 Ch8-07。Ch4-08 可作为后续 direct memory 调优、系统级诊断和 JDK 版本迁移分析的直接前置篇。