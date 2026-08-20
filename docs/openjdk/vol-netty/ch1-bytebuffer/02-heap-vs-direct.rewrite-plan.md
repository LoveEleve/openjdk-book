# Netty Ch1-02 HeapBuffer vs DirectBuffer — 正文写作规划

## 文章定位

- 写作卷：`vol-netty`
- 章节：Ch1 NIO ByteBuffer
- 篇：02 分配与内存
- 正文目标：`vol-netty/ch1-bytebuffer/02-heap-vs-direct.md`
- 当前状态：篇级规划完成，正文未写

## 前置依赖

### HARD

- Ch1-01 核心抽象：position/limit/capacity、relative/absolute、状态迁移。

### SOFT

- Java 堆对象与 GC 基础：用于理解 byte[] 的生命周期。
- OS 虚拟内存基础：只需知道 native address 与页，不提前展开 mmap 实现。
- Channel：只用于解释 DirectBuffer 的 IO 场景。

### NAV

- Ch1-03 视图与陷阱：slice/duplicate/wrap/equals/线程安全。
- Ch4 ByteBuf：引用计数、池化 allocator、heap/direct/composite 的 Netty 设计。

## 一句话困惑

同样是一个 ByteBuffer，为什么有 HeapBuffer 和 DirectBuffer 两条分配路径；DirectBuffer 明明绕过了 Java 堆，为什么仍然可能 OOM？

## 一句话顿悟

HeapBuffer 把分配和回收交给 Java 堆，DirectBuffer 把 IO 数据路径和 native 内存管理交给 JVM/OS；前者分配快，后者适合 native IO，但代价是 Cleaner 不确定、总池受限、释放不及时。

## 读者理解路径

1. 从 heap/direct 的真实选择困惑开始，而不是先介绍两个类。
2. 先讲 HeapBuffer：普通数组、快速分配、GC 生命周期。
3. 再讲 DirectBuffer：native address、IO 入口和“减少中间复制”的条件。
4. 再拆 Cleaner/Deallocator：为什么堆外回收不等于对象 GC。
5. 再讲 Bits.reserveMemory：为什么 direct memory 有独立上限和退避等待。
6. 最后讲 wrap：它是共享数组视图，不是独立复制。
7. 用 Netty 引用计数/池化作桥，但不提前展开 Ch4 实现细节。

## 失败方案推演

- 所有 IO 都用 HeapBuffer：native IO 可能需要临时 direct buffer/复制。
- 所有数据都用 DirectBuffer：分配、释放、调试和容量管理成本增加。
- 只依赖 Cleaner 回收：GC 不触发时堆外压力无法及时释放。
- 把 `wrap` 当 copy：调用方误以为修改不会影响原数组。

## 必须澄清的误解

1. DirectBuffer 不是“零拷贝保证”，它只是为某些 native IO 路径提供直接地址；具体是否复制取决于调用链。
2. `MaxDirectMemorySize` 是 direct buffer 的容量限制，不等于 native 进程全部内存上限。
3. Cleaner 回收依赖引用对象被 GC 发现，不是 direct memory 的确定性释放协议。
4. `wrap` 不复制数组，Buffer 与原数组共享存储。
5. `allocate()` 与 `allocateDirect()` 的差异不只是堆/堆外，还包括分配、回收、IO 和调试代价。

## 文章结构与字数预算

1. 选择困惑：为什么需要两种 Buffer（800-1000 字）
2. HeapBuffer：数组与 GC（1000-1300 字）
3. DirectBuffer：native address 与 IO（1400-1800 字）
4. Cleaner/Deallocator：被动释放（1400-1700 字）
5. Bits.reserveMemory：独立池、GC 触发与退避（1400-1800 字）
6. wrap：共享数组视图（900-1200 字）
7. trade-off 总结与 Netty 引出（700-900 字）

目标叙述性正文：7000-9000 字；以深度和闭环为准，不把字数作为硬门槛。

## 证据清单

写作时逐条重新验证，不能直接照抄大纲行号：

- `X-Buffer.java.template`：allocate/allocateDirect/wrap
- `Heap-X-Buffer.java.template`：heap `_get/_put`
- `Direct-X-Buffer.java.template`：address、Deallocator、Cleaner
- `Bits.java`：reserveMemory/tryReserveMemory/退避
- `ByteBuffer.java`：入口 API
- Netty Ch4 大纲：只用于桥接引用，不替代当前 JDK 源码证据

## 深审清单

- [ ] 区分“减少复制机会”与“绝对零拷贝”
- [ ] 区分 Java 对象回收与 native 内存释放
- [ ] 重新核对 `MaxDirectMemorySize` 的默认/初始化语义：当前 flag 默认值为 0，JVM 初始化时默认向 Java 层暴露 `-1`，`Bits.MAX_MEMORY` 再通过 `VM.maxDirectMemory()`确定限制；不能简单写成“默认等于 -Xmx”
- [ ] 代码块全部来自当前 JDK 源码
- [ ] 不提前展开 Netty refCnt 实现
- [ ] 结尾桥接 Ch1-03 与 Ch4 ByteBuf
- [ ] 通过六轮正文 review
