# 32-unsafe/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `DirectByteBuffer` 模板生成实现、`Bits`、`sun.nio.ch.DirectBuffer`、`jdk.internal.ref.Cleaner`、`Unsafe.allocateMemory/freeMemory`。本文聚焦堆外分配、记账、稳定地址与 Cleaner 回收桥接；CAS/park 放到下一篇。
> 目标：把“堆外内存与 DirectBuffer”改写成一篇围绕“DirectBuffer 的真正难点不是申请到一块 native memory，而是如何把一段 GC 不直接管理的地址空间，包装成一个可被 Java 世界持有、被 NIO/native 代码按稳定地址访问、并最终被间接回收的对象”展开的机制文章。

## 1. 读者困惑

- `ByteBuffer.allocateDirect(...)` 申请到的到底是什么，为什么它不在 Java 堆里？
- 如果 GC 只认识包装对象，不认识那块 native memory，DirectBuffer 到底怎么回收？
- 为什么 DirectBuffer 设计里要暴露 `address()` 和 `cleaner()` 这种明显偏底层的接口？
- Direct buffer OOM 为什么会在 Java 堆还没满时照样发生？
- 为什么 DirectBuffer 的关键价值不是“天然更快”，而是“有稳定地址可供 native/IO 路径使用”？

## 2. 一句话顿悟

**DirectBuffer 的本体不是一个堆内 `byte[]`，而是“一块堆外地址 + 一个 Java 包装对象 + 一条延迟清理链”。`Unsafe.allocateMemory` 真正解决的只是地址申请；`Bits.reserveMemory` 负责配额记账，`DirectBuffer.address()` 让底层代码拿到稳定地址，`Cleaner` 再把“包装对象不可达”间接翻译成“释放 native memory”。真正困难的不是分配，而是跨越 GC 生命周期与 native 内存生命周期之间的桥接。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 `Unsafe.allocateMemory/freeMemory`、`Bits.reserveMemory/unreserveMemory`、模板构造、`Cleaner` 和 `DirectBuffer` 接口这些关键证据。
- 已指出 Direct buffer OOM 和堆 OOM 是两套账，这是生产理解重点。
- 已把“稳定地址”提炼出来，方向正确。

### 必须重写

- 旧稿偏流程卡片，需要先立住总问题：GC 不直接管理的内存，怎么被 Java 对象安全持有和最终释放。
- 模板构造流程要统一服务于“申请地址 + 配额记账 + 对齐 + 注册清理器”这条桥接主线。
- `DirectBuffer` 接口要讲成“为什么 JDK 内部必须拿到真实地址”，而不是顺手列方法。
- OOM 章节要回扣两套账本和 Cleaner 延迟回收的根因。

## 4. 理解路径

### 第一节：从“DirectBuffer 为什么不是堆上的 byte[]”开场

用最常见误解开场：很多人以为 direct 只是“更快的 ByteBuffer”。先立总问题：它真正换掉的是内存归属和地址稳定性。

### 第二节：Unsafe 解决的只是申请地址，不是生命周期管理

证据：
- `sun.misc.Unsafe.java:461/607`
- `jdk.internal.misc.Unsafe.java:607/899`

主线：
- `allocateMemory/freeMemory` 提供的是裸地址分配与释放。
- 这一步本身不认识 Java 对象，也不帮你管生命周期。
- DirectBuffer 的难题由此开始，而不是到此结束。

### 第三节：DirectByteBuffer 构造为什么要串上 `Bits`、对齐和 `Cleaner`

证据：
- `Direct-X-Buffer.java.template:69/77/91`
- `Direct-X-Buffer.java.template:116/118/122/124/127/134`
- `Bits.java:72/109/203`

主线：
- 先算页大小和容量；
- 先 reserve 配额，再真正 allocate；失败要 unreserve 回滚；
- 申请后清零、必要时做页对齐；
- 最后注册 `Cleaner.create(this, new Deallocator(...))`。
- 这说明构造器真正做的是“把裸地址包装成受规则约束的 Java 持有物”。

### 第四节：为什么 `DirectBuffer` 必须暴露 `address()` 和 `cleaner()`

证据：
- `DirectBuffer.java:31/33/37`

主线：
- DirectBuffer 的价值不在抽象外观，而在底层代码能拿到稳定地址。
- `cleaner()` 暴露了它确实附着着一条外部清理链。
- 这证明 DirectBuffer 不是普通堆内对象的小变体，而是 native/IO 路径的桥接对象。

### 第五节：Cleaner 为什么只是“间接回收桥”，而不是 GC 直接管理堆外内存

证据：
- `Cleaner.java:59/130`
- `Direct-X-Buffer.java.template:134`

主线：
- GC 只发现包装对象不可达。
- Cleaner 把这个事件翻译成 `Deallocator` 运行，最终触发 free 与 unreserve。
- 这意味着“对象快没用了”和“native memory 立刻释放”不是同一个时钟。

### 第六节：为什么 direct buffer OOM 会在堆还很空时照样发生

证据：
- `Bits.java:109/203`
- `Direct-X-Buffer.java.template:91/118/124`

主线：
- direct memory 有自己的一套 reserve/unreserve 账本。
- 分配速度过快、对象仍被引用、Cleaner 滞后，都会让配额先耗尽。
- 所以排查要看 direct memory、引用链和 BufferPool，而不只看 Java heap。

## 5. 失败方案清单

1. 把 direct buffer 当成“更快的 byte[]”，忽略它的堆外生命周期。
2. 认为 GC 会像管理普通对象一样直接回收那块 native memory。
3. 只在 Java 堆视角排查 direct buffer OOM。
4. 忽略包装对象引用链，误以为“业务上不用了”就等于内存已释放。
5. 把 stable address 的价值简化成“性能更好”而不看 native/IO 需要。

## 6. 误解清单

1. allocateDirect 只是把字节数组放到另一个池子里。
2. `Unsafe.allocateMemory` 已经帮 DirectBuffer 解决了回收问题。
3. `Cleaner` 就是 GC 本身。
4. `address()` 暴露只是调试方便，不是设计核心。
5. Java 堆没满就不会出现 direct buffer memory OOM。

## 7. 证据清单

- `sun.misc.Unsafe.java:461/607`
- `jdk.internal.misc.Unsafe.java:607/899`
- `Bits.java:72/109/203`
- `Direct-X-Buffer.java.template:69/77/91/116/118/122/124/127/134/175`
- `DirectBuffer.java:31/33/37`
- `Cleaner.java:59/130`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 direct/offheap 生命周期，不展开 mmap unmapper 的全部细枝末节。
- Netty 等框架只作为动机背景，不展开它们自己的池化实现。
- BufferPoolMXBean 只作为排查方向点到为止，不扩展成监控专题。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 direct buffer 不在堆上 → 裸地址分配为什么不等于生命周期完成 → DirectByteBuffer 构造如何串起 reserve/allocate/对齐/cleaner → 为什么需要稳定地址 → Cleaner 如何间接桥接回收 → 为什么 direct OOM 和 heap OOM 是两套账”。
- 必须把生命周期桥接讲成本文主线。
- 必须自然引到 `03-cas-park.md`。
