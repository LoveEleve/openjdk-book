# 堆外内存与 DirectBuffer：为什么真正困难的不是分配，而是把一段 native memory 接进 Java 生命周期

> 本文基于 JDK 11 `DirectByteBuffer` 模板生成实现、`Bits`、`sun.nio.ch.DirectBuffer`、`jdk.internal.ref.Cleaner`、`Unsafe.allocateMemory/freeMemory`。本文聚焦堆外分配、记账、稳定地址与 Cleaner 回收桥接；CAS/park 放到下一篇。本文讨论的是 JDK 11 DirectBuffer 生命周期桥接机制，不把这里的模板构造链、Cleaner 桥接方式和 direct memory 记账策略外推成所有堆外内存框架都必须遵守的统一规范。
> **前置依赖**：[Unsafe 全景](01-unsafe-overview.md)、[字节流与缓冲](../17-io-streams/01-byte-streams.md)
> **后续**：[CAS 原语与线程控制](03-cas-park.md)

## 先看最容易被误解的一点：`allocateDirect` 真正换掉的，不只是“缓冲区类型”，而是内存归属和生命周期模型

很多人第一次接触 `ByteBuffer.allocateDirect(...)`，往往只记住一个模糊结论：direct buffer 更适合 IO，性能更高。但如果继续追问一句——它到底“direct”在哪里，为什么会单独出现 `Direct buffer memory` 这种 OOM，为什么 GC 明明跑了却那块内存还没立刻释放——就会发现这根本不是“堆内缓冲区的加强版”这么简单。

DirectBuffer 真正换掉的，是底层内存的归属方式。它不再以 Java 堆上的 `byte[]` 作为本体，而是把一段 native memory 包装成一个 Java 对象。这样做的收益是：底层代码可以拿到稳定地址，不必担心堆对象移动；代价则是：GC 只能直接看见包装对象，看不见那块地址空间本身。

这也意味着 DirectBuffer 的真正难题，从来都不是“申请一块内存”——`Unsafe.allocateMemory(...)` 早就能做到这一点。真正困难的是：**如何把一段 GC 不直接管理的地址空间，桥接进 Java 对象的生命周期、NIO/native 的地址需求，以及 direct memory 的单独配额管理里。**

## 一、为什么 `Unsafe.allocateMemory` 解决的只是裸地址分配：它并不会自动帮你接上对象生命周期

### 先看最底层入口

JDK 11 里：

- `sun.misc.Unsafe.allocateMemory(...)` / `freeMemory(...)` 在 `sun/misc/Unsafe.java:461` / `607`
- 内部真实实现 `jdk.internal.misc.Unsafe.allocateMemory(...)` / `freeMemory(...)` 在 `jdk/internal/misc/Unsafe.java:607` / `899`

这组 API 的职责其实非常单纯：给你一段地址，或者把这段地址释放掉。它们知道的是 native memory，不是 Java 对象语义，不是 ByteBuffer 协议，更不是“这个地址什么时候对业务来说已经没用了”。

### 为什么 DirectBuffer 的问题恰恰从这里开始

如果世界上只有裸地址分配，那 DirectBuffer 当然可以非常简单：申请地址、返回地址、用完释放。但 Java 世界不是这么运作的。Java 代码希望拿到的是对象，NIO/native 路径希望拿到稳定地址，GC 只会跟踪对象可达性，而 direct memory 又需要单独记账和限额。

所以 `allocateMemory(...)` 只是地基，不是整栋楼。真正的设计难点在于：如何把“裸地址”变成一个 Java 世界可持有、可追踪、可最终间接释放的 buffer 对象。

## 二、为什么 DirectByteBuffer 构造器要串起记账、分配、清零、对齐和 Cleaner：它在搭一座桥，不是在做一步分配

### 先看模板里真正发生了什么

JDK 11 的 DirectByteBuffer 不是普通源码文件，而是模板生成类。旧稿已经定位到 `java/nio/Direct-X-Buffer.java.template`，关键锚点包括：

- `Deallocator` 在 `Direct-X-Buffer.java.template:69` / `77`
- `Bits.unreserveMemory(...)` 在 `91`
- `Bits.pageSize()` 在 `116`
- `Bits.reserveMemory(...)` 在 `118`
- `UNSAFE.allocateMemory(...)` 在 `122`
- 分配失败回滚 `Bits.unreserveMemory(...)` 在 `124`
- `UNSAFE.setMemory(...)` 在 `127`
- `Cleaner.create(this, new Deallocator(...))` 在 `134`

配额与页大小则由 `Bits` 承担：

- `pageSize()` 在 `Bits.java:72`
- `reserveMemory(...)` 在 `109`
- `unreserveMemory(...)` 在 `203`

### 为什么这条构造链的顺序非常关键

这条链路不是“顺手做点初始化”，而是在解决五件必须串起来的事：

1. 先算页大小和容量边界；
2. 先记账，确认 direct memory 配额上允许这次分配；
3. 再真正申请 native memory；
4. 申请后清零、必要时做页对齐；
5. 最后把这块地址和一个未来的释放动作绑到 Cleaner 上。

其中最重要的一点是：**记账、地址、Java 包装对象、未来释放动作，必须在构造期被同时接上。** 如果这里只有地址分配而没有额度管理，就失去了 direct memory 的独立账本；如果没有 Cleaner 绑定，就失去了“对象死后谁来 free”这条回路；如果没有对齐与稳定地址，native/IO 路径又拿不到自己真正想要的东西。

所以 DirectByteBuffer 构造器做的不是“多申请一类内存”，而是在把 native 地址正式收编进 Java 世界的生命周期体系。

## 三、为什么 `DirectBuffer` 必须暴露 `address()` 和 `cleaner()`：DirectBuffer 的价值核心不是抽象外观，而是稳定地址与外部清理链

### 先看接口本身

JDK 内部接口 `sun.nio.ch.DirectBuffer` 定义在 `DirectBuffer.java:31`，关键方法是：

- `address()` 在 `DirectBuffer.java:33`
- `cleaner()` 在 `37`

这两个方法放在一起，非常能说明 DirectBuffer 的本质。

### 为什么 `address()` 才是 direct 的真正核心价值之一

堆内 `byte[]` 的最大问题不是“不能存数据”，而是它的物理位置对 GC 来说不是稳定承诺。native 代码和底层 IO 路径如果想直接操作一块内存，最想要的通常不是“长得像 Buffer 的对象”，而是**一段稳定地址**。

这就是 DirectBuffer 和普通堆内缓冲最根本的差异之一：它让 JDK 内部代码能够把 Buffer 当成可寻址的 native memory 视图来使用。

### 为什么 `cleaner()` 也同样关键

`cleaner()` 的存在说明，这个对象从设计上就承认自己背后附着着一条独立于普通堆对象析构语义的清理链。它不是“堆上对象自动回收，所以什么都不用管”，而是“对象的死亡只是释放 native memory 的触发信号之一”。

也就是说，DirectBuffer 的设计从接口层面就已经把“稳定地址”和“延迟清理桥接”两件事暴露出来了。

## 四、为什么 Cleaner 只是间接回收桥，而不是 GC 直接管理堆外内存

### 先看 Cleaner 站在哪一层

JDK 11 的 `jdk.internal.ref.Cleaner` 定义在 `Cleaner.java:59`，创建入口 `create(...)` 在 `Cleaner.java:130`。DirectByteBuffer 模板里会在构造末尾调用：

- `Cleaner.create(this, new Deallocator(...))`，位置在 `Direct-X-Buffer.java.template:134`

这条链已经说明得很清楚：GC 真正直接观察到的，只有 `this` 这个 Java 包装对象是否还可达。真正负责释放地址和回收 direct memory 配额的，是后面绑定的 `Deallocator`。

### 为什么“对象不可达”和“native memory 立刻释放”不是同一个时钟

这正是很多 direct memory 误解的根源。GC 并不会像处理普通堆对象那样，直接把那块 native memory 一并管理掉。它做的只是发现包装对象已经死了；然后 Cleaner 才有机会把这个事实翻译成真正的清理动作，最终触发 free 和 unreserve。

所以这中间天然存在一个桥接延迟：

- 业务上觉得“这个 buffer 我早就不用了”；
- 但对象也许还可达；
- 或者对象虽不可达，Cleaner 还没来得及把清理动作跑完。

这也就是为什么 direct memory 的生命周期感受，经常和普通堆对象完全不一样。

## 五、为什么 `Direct buffer memory` OOM 会在堆还很空时照样发生：因为 direct memory 有自己独立的一套账本

### 先看账本由谁维护

DirectBuffer 的配额管理不在 Java heap 里，而在 `Bits.reserveMemory(...)` / `unreserveMemory(...)` 这条链上，位置分别是 `Bits.java:109` / `203`。模板里的构造与清理也明确把它接进来了：

- 分配前 `reserveMemory(...)`，位置在 `Direct-X-Buffer.java.template:118`
- 构造失败回滚 `unreserveMemory(...)`，位置在 `124`
- 最终 `Deallocator` 清理后 `unreserveMemory(...)`，位置在 `91`

### 为什么这会导致“堆没满，direct 先炸”

因为 direct memory 和 Java heap 从来就不是同一本账：

- Java heap 记的是堆对象占用；
- direct memory 记的是堆外地址空间占用及其限额。

所以即使 Java 堆还有大量空余，只要 direct buffer 的分配速度太快、包装对象仍被引用、或者 Cleaner 回收跟不上，direct memory 这本账也可能先被打满，最后抛出 `OutOfMemoryError: Direct buffer memory`。

这也是为什么排查 direct OOM 时，不能只盯着 heap dump 里的堆大小。你还得同时看：

- direct buffer 是否大量分配却没有复用；
- 包装对象引用链是否仍然存在；
- Cleaner 是否存在释放滞后；
- direct memory 配额是否已经被打满。

## 七、五个最容易混掉的边界：allocateDirect 不是更快数组，裸地址不等于已托管，Cleaner 不是 GC 本体，地址稳定不等于生命周期简单，direct OOM 也不是 heap OOM

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`allocateDirect(...)` 不是“更快的 byte[]”。它真正换掉的是内存归属和地址语义：底层不再是堆上的数组，而是一段 native memory，再由 Java 对象把它包起来。

第二，拿到裸地址也不等于问题已经解决。`Unsafe.allocateMemory(...)` 只完成了“给你一块地址”这一步；真正困难的是如何把这块地址接进 direct memory 账本、包装成 Buffer 对象、再把未来释放动作绑回生命周期链条里。

第三，`Cleaner` 也不是 GC 本体。GC 只负责发现包装对象是否还可达；真正把这件事翻译成 `freeMemory` 和 `unreserveMemory` 的，是 Cleaner 挂着的那条清理动作。两者之间天然会有时间差。

第四，地址稳定也不等于生命周期简单。正因为 direct buffer 给了 native/IO 路径最想要的稳定地址，你才必须同时承担“这块地址何时释放、谁负责记账、对象死了之后什么时候才真正 free”这些普通堆对象通常不用你自己直面的责任。

第五，`Direct buffer memory` OOM 也不是 Java heap OOM 的另一种表现。它打满的是 direct memory 那本独立账，而不是堆对象空间本身；所以堆还很空时，direct 配额照样可能先炸。

把这五条边界记稳，DirectBuffer 这一篇就不会重新塌回“allocateDirect 更快”这种表面印象。它真正想讲的是：DirectBuffer 最难的从来不是分配，而是把一段 GC 不直接管理的 native memory，桥接进 Java 对象生命周期、NIO 地址需求和独立配额管理这三套系统里。

## 收网：DirectBuffer 的真正挑战不是“在堆外分配成功”，而是把一段堆外地址纳入 Java 对象、native 访问和延迟回收的三方桥接里

现在可以把整篇压成一条主线：

- `Unsafe.allocateMemory(...)` 只负责给出裸地址；
- `Bits.reserveMemory(...)` / `unreserveMemory(...)` 负责 direct memory 的独立账本；
- DirectByteBuffer 构造器把地址、对齐、记账和 Cleaner 绑定到一个 Java 包装对象上；
- `DirectBuffer.address()` 让底层代码拿到稳定地址；
- Cleaner 只负责把“对象死亡”间接翻译成“释放 native memory”；
- 所以 direct OOM 和 heap OOM 从根上就是两套不同问题。

这也解释了为什么 DirectBuffer 的核心价值不该被简化成“更快”。它真正提供的是：**一段可被 Java 世界持有、可被 native/IO 世界按稳定地址访问、并可被延迟清理链最终释放的堆外内存视图。**

下一篇自然就会回到 Unsafe 另一组同样关键、但语义完全不同的原语：如果说这一篇讲的是“直接碰内存”，那最后一篇要讲的就是“直接碰并发协议和线程调度”——CAS 到底怎样支撑无锁更新，`park/unpark` 为什么能成为 AQS 的地基，这就是 `03-cas-park.md` 要接着回答的问题。
