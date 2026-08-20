# Ch4-08 Cleaner、直接内存释放与平台适配

## `release()` 已经讲清楚了，但“谁真的去 free 掉 direct memory”还没讲

前面关于 ByteBuf 的几篇已经把一条主线讲得很清楚了：引用计数负责对象生命周期协议，ownership 决定最后一次 `release()` 该由谁负责，leak detector 负责在这条协议断裂时留下轨迹。可只要再往下追一步，新的问题就会出现：当一个 direct buffer 最终真的走到了“该释放底层资源”的那一刻，谁去做这件事？它靠的是 JDK 自带 cleaner、Unsafe、MemorySegment，还是别的什么路径？

这个问题不能被一句“GC 会处理”糊过去。因为 Netty 前面已经明确把 direct buffer 的业务级回收和普通 heap 对象区别开了：direct memory 不应该只等 JVM 自己挑一个时间慢慢收；当 ownership 协议归零时，Netty 会选择并调用当前平台允许的那条清理路径，把底层释放责任落实到具体实现上。

可一旦真的落到底层，事情立刻变复杂了。JDK 版本不同，能调用的清理机制不同；Unsafe 是否可用，决定了能不能直接走 no-cleaner direct memory 路径；到了 Java 24/25，MemorySegment 和本地链接能力又引入了新的选择；有些清理动作相对便宜，适合频繁调用；有些清理动作代价更重，只能更谨慎地放在某些 allocator 路径里。

所以本篇真正要解决的，不是“Netty 具体用了哪一个 API 清理 direct memory”，而是：**Netty 为什么要把 direct memory 的分配、重分配和释放统一抽象成 `Cleaner`，再由 `PlatformDependent` 按 JDK 版本、Unsafe 能力和清理成本去挑选实际实现。**

只要这条选择链讲清楚，前面已经建立的 ownership、leak detector、池化 allocator 和 direct/heap 边界才会真正闭环。否则读者只知道“对象归零了”，却不知道归零之后底层 direct memory 到底沿哪条路径离场。

## 先拆抽象：`Cleaner` 不是“某个 cleaner 实现”，而是 direct memory 释放协议

最先要讲清楚的是，Netty 并没有把“清理 direct memory”写死成某一个 JDK API 调用，而是先定义了一个 `Cleaner` 接口。这个接口很小，但职责边界非常完整，见 `common/src/main/java/io/netty/util/internal/Cleaner.java:20`。

它至少回答了四个问题：

1. 如何 `allocate(int capacity)` 创建一块 direct `ByteBuffer`，并同时返回它的清理机制；
2. 如何 `reallocate(...)` 在需要扩容或缩容时处理旧 buffer 与新 buffer 的交接；
3. 如何在兼容旧路径时 `freeDirectBuffer(ByteBuffer)`；
4. 这条清理路径是不是“相对昂贵”，也就是 `hasExpensiveClean()`。

这里最关键的地方不是 `freeDirectBuffer(...)`，而是 `allocate(...)` 返回的根本不是裸 `ByteBuffer`，而是 `CleanableDirectBuffer` 这种“buffer + clean 动作”的组合体。接口注释已经把它写死：你拿到的不只是内存，还拿到“以后该如何 clean 它”这件事的句柄，见 `common/src/main/java/io/netty/util/internal/Cleaner.java:24`。

这意味着 Netty 对 direct memory 的理解不是“先给我一个 ByteBuffer，之后再想办法找 cleaner”，而是“创建时就把清理协议和数据一起带出来”。这和前面 ownership 主线完全一致：谁把资源带进系统，谁至少得把未来清理路径一并说清楚。

`reallocate(...)` 的默认实现也很能说明它是一个协议层，而不是某个固定 JDK API 的薄包装。默认逻辑只是“分配一块新 buffer -> 拷贝旧数据 -> clean 掉旧 buffer”，见 `common/src/main/java/io/netty/util/internal/Cleaner.java:34`。但接口允许实现覆盖它，用更高效的路径，比如直接基于底层 memory 做重分配。这说明 `Cleaner` 抽象的重点不在“现在具体怎么实现”，而在“direct memory 的生命周期要统一暴露出 allocate/reallocate/clean 这组动作”。

最后，`hasExpensiveClean()` 这一个布尔值看起来不起眼，其实非常关键。接口文档明确说，昂贵的 clean 对池化 allocator 可能是可接受的，但对 unpooled buffer 应当尽量避免，见 `common/src/main/java/io/netty/util/internal/Cleaner.java:62`。这说明 direct memory 清理不仅有“能不能做”的平台问题，还有“适不适合频繁做”的策略问题。

所以第一层心智模型应该立住：**`Cleaner` 不是某个 JDK cleaner 的名字，而是 Netty 对 direct memory 生命周期定义出来的一份统一协议。**不同 JDK/平台只是在实现这份协议，而不是各写各的散乱分支。

## 真正的选择器在 `PlatformDependent`

如果 `Cleaner` 是协议，那么真正决定“当前环境走哪条 direct memory 路径”的选择器，就是 `PlatformDependent`。

这类选择并不是小开关，而是 direct memory 运行时最关键的一次分流。`PlatformDependent` 里同时维护了：

- `DIRECT_MEMORY_COUNTER`
- `DIRECT_MEMORY_LIMIT`
- `CLEANER`
- `LEGACY_CLEANER`
- `NOOP`
- 以及 `io.netty.maxDirectMemory`、`io.netty.ignoreExpensiveClean` 这些系统属性语义

见 `common/src/main/java/io/netty/util/internal/PlatformDependent.java:121`。

这里最关键的不是字段多，而是它说明 direct memory 选择链同时受三类约束：

1. **内存额度约束**：Netty 是否自己维护 direct memory 计数与上限；
2. **平台能力约束**：Unsafe 可不可用、JDK 版本是多少、有没有 MemorySegment、本地链接权限在不在；
3. **清理成本约束**：当前 cleaner 的 clean 代价是偏便宜还是偏昂贵。

### `io.netty.maxDirectMemory` 不只是一个数字

`PlatformDependent` 对 `io.netty.maxDirectMemory` 的处理本身就说明它不只是“限制 direct memory 大小”。注释明确区分了三种语义，见 `common/src/main/java/io/netty/util/internal/PlatformDependent.java:174`：

- `< 0`：Netty 不额外指定上限，direct memory 上限更多沿用 JDK 估算值；
- `== 0`：Netty 不维护自己的 direct memory 计数上限；
- `> 0`：Netty 自己维护 direct memory 计数限制。

这里要特别小心不要把“是否用 cleaner 路径”与“Netty 是否自己维护 direct memory limit”混成一个开关。两者有关联，但不是完全相同的判断维度：前者最终要看 `CLEANER` 选择链和 no-cleaner direct buffer 能力，后者则首先取决于 `DIRECT_MEMORY_COUNTER` 是否启用以及 `DIRECT_MEMORY_LIMIT` 如何设定，见 `common/src/main/java/io/netty/util/internal/PlatformDependent.java:182`。

所以第二层心智模型要再补一句：**Netty 在 direct memory 上不是只判断“怎么 free”，还同时判断“由谁来记账、上限在哪里”。**这也是后面 `OutOfDirectMemoryError` 和 `DirectCleaner` 为什么要显式维护 memory counter 的前提。

## `LEGACY_CLEANER` 和 `CLEANER`：先挑兼容路径，再看能不能走更快的 no-cleaner 路径

`PlatformDependent` 的 cleaner 选择逻辑可以分成两段看。

第一段是先确定 `LEGACY_CLEANER`。如果不是 Android，并且 Java 版本大于等于 9，就优先尝试 `CleanerJava9`；不行再试 `CleanerJava24Linker`；再不行试 `CleanerJava25`；都不行才回退到 `NOOP`。如果 Java 版本更老，则看 `CleanerJava6` 是否支持；再不行也是 `NOOP`，见 `common/src/main/java/io/netty/util/internal/PlatformDependent.java:204`。

这条顺序说明，Netty 对 direct memory 清理的第一选择不是“哪条性能最好”，而是“当前环境下哪条兼容路径成立”。

第二段才是决定最终 `CLEANER`。如果 `io.netty.maxDirectMemory != 0`、Unsafe 可用，并且 `PlatformDependent0` 暴露了 no-cleaner direct buffer constructor，就直接选 `DirectCleaner`；否则使用前面挑好的 `LEGACY_CLEANER`，见 `common/src/main/java/io/netty/util/internal/PlatformDependent.java:231`。

这说明 `DirectCleaner` 不是和 Java6/9/24/25 cleaner 并列的“另一个兼容分支”，而是当前平台支持更激进 no-cleaner direct memory 能力时，Netty 会优先采用的一条更直接的路径。它与 `LEGACY_CLEANER` 的关系更像：

- 先确保我至少有一条兼容 direct clean 的路；
- 再看当前环境能不能走更直接的 no-cleaner fast path。

也正因为如此，`DIRECT_BUFFER_PREFERRED` 的判断才会依赖 `CLEANER != NOOP` 这种 cleaner 可用性语义，而不是简单依赖“JDK 支持 direct buffer”，见 `common/src/main/java/io/netty/util/internal/PlatformDependent.java:237`。

所以第三层心智模型应该是：**Netty 不是在一堆 cleaner 实现里盲选一个，而是先选兼容路径，再尝试切换到更直接的 no-cleaner 路径。**

## `DirectCleaner`：为什么它是 direct memory 的快路径

`DirectCleaner` 的实现非常短，但正因为短，反而把它和其他 cleaner 之间的差别暴露得很清楚。它直接实现 `Cleaner`，并在 `allocate(...)`、`reallocate(...)` 和 `clean()` 里走 `PlatformDependent0.allocateDirectNoCleaner`、`reallocateDirectNoCleaner` 和 `freeMemory`，见 `common/src/main/java/io/netty/util/internal/DirectCleaner.java:20`。

这里最关键的特征有三个。

第一，它维护 direct memory counter。无论是 `allocate(...)` 还是 `reallocate(...)`，都会先 `incrementMemoryCounter(...)`，失败时再回滚；clean 时则 `decrementMemoryCounter(capacity)`，见 `common/src/main/java/io/netty/util/internal/DirectCleaner.java:27`、`:55`、`:76`。这意味着这条路径不是“偷偷绕过系统直接 malloc/free”，而是把 no-cleaner direct memory 的生命周期和 Netty 自己的 direct memory 账本绑死。

第二，它的 `reallocate(...)` 不是默认的“新建+拷贝+clean old”，而是直接走底层 reallocate。这正说明 `Cleaner` 接口为什么允许重写默认实现：当前平台如果能直接改底层内存块，就没必要总是退回到更笨的默认路径。

第三，它的 `hasExpensiveClean()` 返回 false，见 `common/src/main/java/io/netty/util/internal/DirectCleaner.java:47`。这不是在说“这条路径一定快”，而是在告诉 allocator 策略层：当前实现把 clean 动作视为相对便宜的路径，因此更适合频繁出现在 unpooled/no-cleaner direct buffer 这种场景里。

所以 `DirectCleaner` 的本质，不是“另一个 cleaner 实现”，而是**当 Unsafe 和 no-cleaner direct buffer 能力同时成立时，Netty 直接把 direct memory 的分配、重分配、释放和记账都接到自己手上。**

这条路径也正好解释了为什么 `io.netty.maxDirectMemory > 0` 时会和 cleaner 选择发生关联。因为一旦你不用 JDK 那套 cleaner，而改走 no-cleaner direct memory，就必须自己维护 direct memory 计数与上限，否则 `OutOfDirectMemoryError` 根本无从谈起。

## `CleanerJava6` 与 `CleanerJava9`：兼容旧世界与 Java 9+ 世界的 direct clean 路径

如果 `DirectCleaner` 是更直接的 no-cleaner 路径，那 `CleanerJava6` 和 `CleanerJava9` 就是“仍然依赖 ByteBuffer/Unsafe 提供的清理入口，但适配不同 JDK 时代”的兼容路径。

### `CleanerJava6`：通过 cleaner() + clean()

`CleanerJava6` 的静态初始化会尝试找到 `sun.misc.Cleaner` 和 `sun.nio.ch.DirectBuffer.cleaner()` 这条链，再把它们拼成一个 `MethodHandle`，见 `common/src/main/java/io/netty/util/internal/CleanerJava6.java:30`。如果这条链可用，`freeDirectBufferStatic(buffer)` 最终就通过 `CLEAN_METHOD.invokeExact(buffer)` 去触发底层 clean，见 `common/src/main/java/io/netty/util/internal/CleanerJava6.java:150`。

这里可以看到，它仍然是“拿到一个 ByteBuffer，再想办法从里面找到 cleaner”。与 `DirectCleaner` 比起来，它对底层 direct memory 并没有完全接管，而是在 ByteBuffer 世界里寻找合法的释放入口。

### `CleanerJava9`：通过 `Unsafe.invokeCleaner`

`CleanerJava9` 则明显更现代。它会尝试拿到 `Unsafe.invokeCleaner(ByteBuffer)` 的 MethodHandle，并在 `freeDirectBufferStatic(buffer)` 中直接调用它，见 `common/src/main/java/io/netty/util/internal/CleanerJava9.java:30`、`:100`。

这说明 Java 9 以后，Netty 可以不再依赖 `DirectBuffer.cleaner()` 那种更早期的内部接口，而是改走 `Unsafe.invokeCleaner`。但它本质上仍然属于“给定一个 ByteBuffer，通过 JDK/Unsafe 暴露的合法释放入口把它 clean 掉”的兼容路径，而不是像 `DirectCleaner` 那样从一开始就自己掌控底层地址分配和释放。

### 二者的共同点

无论是 Java6 还是 Java9，这两条路径都有两个共同点：

- `allocate(...)` 默认都还是 `ByteBuffer.allocateDirect(capacity)`；
- `clean()` 最终都会在调用底层 cleaner 之后，自己维护 `PlatformDependent` 的 memory counter。

见 `common/src/main/java/io/netty/util/internal/CleanerJava6.java:102` 与 `common/src/main/java/io/netty/util/internal/CleanerJava9.java:84`。

所以它们和 `DirectCleaner` 的关系可以概括成：**不是自己造 direct memory，而是接住 JDK 给的 direct ByteBuffer，再在当前版本允许的接口上把 clean 动作接回来。**

## Java 24/25 路径：MemorySegment 和本地能力检查把选择问题重新抬高了一层

到了 Java 24/25，Netty 的 direct memory 路径又出现了一个新层次：MemorySegment 和 native access。

### `CleanerJava24Linker`：本地链接 `malloc/free`

`CleanerJava24Linker` 的实现说明，它并不是在用 JDK 旧式 cleaner，而是在满足条件时，通过 `Linker.nativeLinker()` 直接链接 libc 的 `malloc()` 和 `free()`，再把地址包装成 `ByteBuffer`，见 `common/src/main/java/io/netty/util/internal/CleanerJava24Linker.java:28`。

但它的前提也更苛刻：

- Java 版本至少是 24；
- 模块必须允许 native access；
- 地址大小必须和 Java long 匹配，实际等价于只支持 64 位平台。

见 `common/src/main/java/io/netty/util/internal/CleanerJava24Linker.java:64`、`:82`。这说明 Netty 这条路径虽然更接近直接控制底层内存，但它不再是“只要 JDK 版本够就能上”，而是把模块系统和平台能力也一并拉进了选择条件里。

更重要的是，它的 `freeDirectBuffer(ByteBuffer)` 直接抛 `UnsupportedOperationException`，因为它不能清理任意来源的 ByteBuffer，见 `common/src/main/java/io/netty/util/internal/CleanerJava24Linker.java:201`。这再次说明当前 cleaner 抽象已经从“给我一个 ByteBuffer，我试着 clean 它”逐渐转向“从 allocate 一开始就把 buffer 和 clean 动作绑成一体”。

### `CleanerJava25`：shared arena 的 MemorySegment 路径

`CleanerJava25` 则代表另一条 MemorySegment 路线。它不去直接链接 `malloc/free`，而是通过 `Arena.ofShared()`、`MemorySegment.allocate(...)`、`asByteBuffer()` 这套机制创建 `CleanableDirectBufferImpl`，见 `common/src/main/java/io/netty/util/internal/CleanerJava25.java:27`。

这条路径最值得注意的地方，是 `hasExpensiveClean()` 返回 true，源码注释明确说 shared arena 的 close 可能依赖 inter-thread handshakes，因此 clean 相对昂贵，见 `common/src/main/java/io/netty/util/internal/CleanerJava25.java:189`。

这正好回到本篇最开始讲的第三类约束：**不只是“能不能 clean”，还要问“这条 clean 路径适不适合被频繁调用”。**Java25 的 shared arena 路径就是一个非常典型的例子：它可以工作，但 clean 成本更高，因此 allocator 策略层不能把它和 `DirectCleaner` 那类路径一视同仁。

所以 Java24/25 这两条路径合起来说明：Netty 面对的新世界，不是“旧 cleaner 不行了，换个 API”这么简单，而是 direct memory 清理的选择条件已经上升为 JDK 版本、模块权限、本地链接能力和清理成本的组合问题。

## `UnpooledUnsafeNoCleanerDirectByteBuf`：不是绕过清理，而是依赖另一条 direct clean 能力

看到 `UnpooledUnsafeNoCleanerDirectByteBuf` 这个名字，很多人第一反应会是：既然叫 no-cleaner，是不是它压根不清理？这个理解正好反了。

这个类真正表达的，不是“不要清理”，而是“不要走 JDK 那条普通 cleaner 分配/释放路径，而改走 PlatformDependent 提供的 cleanable direct memory 能力”。它直接把 `allocateDirect(...)` 和 `freeDirect(...)` 禁掉，见 `buffer/src/main/java/io/netty/buffer/UnpooledUnsafeNoCleanerDirectByteBuf.java:28`、`:38`。而当容量变化时，它调用的是 `PlatformDependent.reallocateDirect(oldBuffer, newCapacity)`，也就是重用前面已经选好的 cleaner 抽象来做 direct memory 重分配，见 `buffer/src/main/java/io/netty/buffer/UnpooledUnsafeNoCleanerDirectByteBuf.java:33`。

所以这个类不是“绕过清理”，而是**绕过默认 `ByteBuffer.allocateDirect` 那条分配/cleaner 组合路径，改走 Netty 自己已经选好的 no-cleaner direct memory 路径。**

这一点非常关键，因为它再次说明 Netty 的 cleaner 选择不是只停留在 `PlatformDependent` 里做个分支判断，而是真的会影响到上层 direct ByteBuf 的具体类分工。某些 direct ByteBuf 的实现本来就建立在“底层 direct memory 由 Netty 自己管理”的前提上。

也正因为如此，本篇前面讲的 cleaner 抽象、memory counter 和 clean 成本判断才不是外围知识，而是 ByteBuf 具体实现分支的前提条件。

## `OutOfDirectMemoryError`：这是 direct limit 的信号，不是 heap OOM 的另一种说法

最后还要把一个容易被误判的边界钉死：`OutOfDirectMemoryError` 不是 heap OOM 的别名。

这个类本身非常简单，它就是一个专门表示“无法再分配 direct ByteBuffer”的 `OutOfMemoryError` 子类，见 `common/src/main/java/io/netty/util/internal/OutOfDirectMemoryError.java:20`。但它的意义不在于类有多复杂，而在于它说明 direct memory 在 Netty 这里拥有一套独立的额度与失败语义。

当 `DirectCleaner` 或其他路径通过 `PlatformDependent.incrementMemoryCounter(...)` 维护 direct memory 计数时，一旦超出 `DIRECT_MEMORY_LIMIT`，你面对的就不是普通 heap OOM 了，而是“这条 Netty direct memory 策略链已经拒绝继续分配”。

所以排查 `OutOfDirectMemoryError` 时，不能直接跳到“是不是 leak”。至少还要同时问：

- 当前是不是 no-cleaner 路径在自己维护 direct memory 上限；
- cleaner 路径是否可用，还是已经退到更保守的兼容实现；
- direct memory counter 和 JDK 自己的 direct memory 限制是不是双重约束；
- ownership、thread cache、arena/chunk 保留和真正 leak 哪一层先出了问题。

还要额外记住一点：`OutOfDirectMemoryError` 的出现并不自动说明 cleaner 路径失效。它更常见地说明 direct memory 额度、分配策略或保留路径已经触到当前边界，而 cleaner 是否失效只是众多可能性中的一种。

也就是说，`OutOfDirectMemoryError` 更像一个 direct memory 策略信号，而不是所有 direct 问题的最终判决书。

## 收网：direct memory 清理不是单一路径，而是一套平台选择策略

现在可以把这条线收回来了。

- `Cleaner` 先把 direct memory 的生命周期统一成 `allocate/reallocate/clean` 协议，见 `common/src/main/java/io/netty/util/internal/Cleaner.java:20`。  
- `PlatformDependent` 再根据 `io.netty.maxDirectMemory`、Unsafe 能力、JDK 版本、MemorySegment 能力和 native access 条件，选择 `DirectCleaner` 或不同的 legacy cleaner 路径，见 `common/src/main/java/io/netty/util/internal/PlatformDependent.java:174`。  
- `DirectCleaner` 代表的是 no-cleaner direct memory 快路径：自己分配、自己重分配、自己 free，并显式维护 memory counter，见 `common/src/main/java/io/netty/util/internal/DirectCleaner.java:20`。  
- `CleanerJava6/9` 代表旧世界和 Java9+ 世界下“给定 ByteBuffer，再找合法 clean 入口”的兼容路径；`CleanerJava24Linker/25` 则说明现代 JDK 下 direct clean 已经进一步受模块权限、本地链接和 clean 成本约束。  
- `UnpooledUnsafeNoCleanerDirectByteBuf` 证明 cleaner 选择会直接影响具体 ByteBuf 实现分支；`OutOfDirectMemoryError` 则说明 direct memory 有独立于 heap 的额度失败语义。

所以本篇真正要留下来的结论是：**Netty 的 direct memory 释放不是某个固定 API 调用，而是一套平台选择策略。**它同时回答“当前环境能不能 clean、怎么 clean、clean 成本大不大、direct memory 由谁记账、上层 ByteBuf 应走哪条实现分支”这几件事。

有了这层理解，前面 ownership、leak detector、池化 allocator 和指标诊断几条主线就真正闭环了：对象归零只是入口，direct memory 真正如何离场，取决于当前 JDK、平台能力、分配器策略和上层 ByteBuf 选择的那条 cleaner 路径。