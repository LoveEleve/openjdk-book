# HeapBuffer 与 DirectBuffer：同一个 ByteBuffer，为什么分成两条内存路径

> 本文基于 JDK 11 NIO 的 `HeapByteBuffer`、`DirectByteBuffer` 和 `Bits` 实现。前置：Ch1-01 的 position/limit/capacity 状态机；本文只解释数据放在哪里、怎么释放和为什么可能 OOM，不展开虚拟内存系统调用细节。

## 先问一个选择题：数据应该住在哪里

创建一个缓冲区时，调用方通常只写一行：

```java
ByteBuffer buffer = ByteBuffer.allocate(size);
```

或者：

```java
ByteBuffer buffer = ByteBuffer.allocateDirect(size);
```

两个对象都能 `put`、`get`、`flip`，都遵守上一篇讲过的 position/limit/capacity 状态机。但它们把数据放在了不同地方：一个把字节放进 Java 堆的 `byte[]`，另一个把字节放进 Java 堆外的 native memory。

这不是简单的“快版本”和“慢版本”。它们是在做不同的取舍：

```text
HeapByteBuffer                         DirectByteBuffer
    │                                        │
    ▼                                        ▼
Java byte[]                             native address
    │                                        │
    ▼                                        ▼
GC 管对象生命周期                     Cleaner/Bits 管 native 内存
    │                                        │
    ▼                                        ▼
分配简单、访问直接                     更适合某些 native IO 路径
```

真正的问题是：如果 HeapBuffer 可能有一次中间复制，为什么不全部使用 DirectBuffer？如果 DirectBuffer 直接连接 native IO，为什么它仍然会因为 direct memory 超限而 OOM？

## 一、HeapBuffer：把生命周期交给 Java 堆

`ByteBuffer.allocate(capacity)` 的入口会创建 `HeapByteBuffer`。它的底层存储就是一个普通 Java 数组：

```text
ByteBuffer.allocate(N)
        │
        ▼
new HeapByteBuffer(N, N)
        │
        ▼
new byte[N]
        │
        ▼
Buffer: position=0, limit=N, capacity=N
```

这条路径的好处是简单。数组由 Java 对象持有，数组对象何时可回收由 GC 判断；访问时，HeapBuffer 的 `_get`/`_put` 最终就是数组索引和数组赋值。上一篇讲过的相对读写和绝对读写，最后都落到这个数组上。

对普通业务数据，HeapBuffer 往往是自然选择：

- 创建路径遵循普通对象分配
- 对象生命周期跟随 Java 引用关系
- 调试和工具支持直接面向 Java 数组
- 不需要额外维护 native address 和释放动作

但堆数组有一个边界：它是 GC 管理的移动对象。Java 代码看到的是一个稳定的数组引用，native 代码却需要一个可以直接使用的地址。某些 IO 调用要把堆数组内容复制到临时的 direct buffer，或者经过 JNI 的数组区域访问接口完成转换。

因此“HeapBuffer 一定慢”是错误的说法。若数据主要在 Java 代码内部处理，额外复制根本不存在；只有当数据要穿过 native IO 边界时，堆数组的可移动性才可能带来转换成本。

## 二、DirectBuffer：把数据放到 native address

`ByteBuffer.allocateDirect(capacity)` 走的是另一条路径：先向 `Bits` 申请 direct memory 额度，再创建一个带 native address 的 `DirectByteBuffer`。它的内部访问不是 `hb[index]`，而是通过 `Unsafe` 对 `address + offset` 进行读写。

```text
ByteBuffer.allocateDirect(N)
        │
        ▼
Bits.reserveMemory(...)
        │
        ▼
申请 native memory
        │
        ▼
DirectByteBuffer(address, capacity)
        │
        ▼
Unsafe.get/put(address + index)
```

DirectBuffer 的价值在于：当某个 native IO API 需要一个稳定地址时，它不必先把 Java 堆数组转移到临时 native 缓冲区。JNI 可以通过 `GetDirectBufferAddress` 拿到 direct buffer 的地址，再把这个地址交给底层读写路径。

但这里必须把两个词分开：**直接地址**不等于**绝对零拷贝**。DirectBuffer 减少了“堆数组 → 临时 direct buffer”这一类转换机会；具体 IO 调用是否还会复制、是否经过额外缓冲，取决于后面的 Channel、JNI 和操作系统路径。

DirectBuffer 的代价也很明确：

- native memory 不由 Java 堆直接管理
- 分配通常比 TLAB 中的数组对象复杂
- 对象回收与 native memory 释放不是同一个事件
- native memory 也需要独立容量限制
- 错误使用时，堆监控可能看不出真正的内存压力

所以 DirectBuffer 不是“更高级的 byte[]”，而是把生命周期和性能边界往 Java 堆之外推了一步。

## 三、DirectBuffer 的回收：对象死了，不代表释放立刻发生

Java GC 能看到 `DirectByteBuffer` 这个对象，但不能把它内部的 native address 当成普通堆字段一起回收。JDK 为 DirectBuffer 建了一个 `Deallocator`，它保存 address、size 和 capacity；真正释放时调用 `UNSAFE.freeMemory(address)`，并把 address 置为 0，避免重复释放（`Direct-X-Buffer.java.template:69-91`）。

那么谁来触发 `Deallocator.run()`？DirectBuffer 会注册一个 `Cleaner`。Cleaner 继承自 PhantomReference：当 DirectByteBuffer 对象已经不可达并经过引用处理后，Cleaner 才有机会进入处理流程，最终执行 Deallocator（`Direct-X-Buffer.java.template:96-134`）。

```text
DirectByteBuffer 仍被引用
        │
        ▼
native memory 继续占用
        │
对象变成不可达
        │
        ▼
GC + PhantomReference 处理
        │
        ▼
Cleaner 调 Deallocator
        │
        ▼
UNSAFE.freeMemory(address)
```

这条链最容易被误读成“DirectBuffer 由 GC 自动释放”。更准确的说法是：**GC 负责让 Cleaner 具备被处理的条件，Cleaner 再负责执行 native memory 的释放动作。** 两者之间隔着引用处理和调度时机。

于是就出现一个反直觉场景：Java 堆压力不大，但 DirectBuffer 已经分配了很多 native memory。因为堆对象还没有迫使 GC 运行，Cleaner 也可能没有及时处理；调用方继续创建 DirectBuffer，最后在 direct memory 额度检查处失败。

这也是 Netty 后来引入引用计数和池化内存的重要背景。引用计数把释放责任从“等待对象被 GC 发现”变成“资源使用者显式归还”；池化则减少重复申请 native memory。但这些机制属于 Ch4 ByteBuf，本文只保留这条设计桥接，不提前展开实现。

## 四、Direct memory 有自己的额度：Bits.reserveMemory

DirectBuffer 没有因为离开 Java 堆就获得无限空间。`Bits` 维护 direct buffer 的统计和上限：`MAX_MEMORY`、`RESERVED_MEMORY`、`TOTAL_CAPACITY` 和 `COUNT`（`Bits.java:93-106`）。其中 `-XX:MaxDirectMemorySize` 限制的是 direct buffer 的总 capacity，不等于进程所有 native memory 的总和。

`reserveMemory(size, cap)` 的主流程是：

```text
尝试原子增加 TOTAL_CAPACITY
        │
        ├─ 未超过上限 → RESERVED_MEMORY 增加，返回
        │
        └─ 超过上限
             │
             ├─ 等待引用处理
             ├─ System.gc()
             ├─ 1/2/4/8... ms 退避重试
             └─ 仍失败 → OutOfMemoryError("Direct buffer memory")
```

源码对 `MAX_MEMORY` 的语义也需要谨慎处理：JVM flag 的默认值是 0，初始化时 JVM 会把默认 direct memory 配置转换给 Java 层；`Bits.MAX_MEMORY` 通过 `VM.maxDirectMemory()`获得实际限制（`Bits.java:93-109`；`globals.hpp:2402`；`jvm.cpp:372-382`）。因此不能简单写成“默认永远等于 -Xmx”，更不能把这个限制理解成整个进程的 native 内存上限。

当第一次尝试失败时，`Bits` 会等待引用处理，并触发 `System.gc()`，然后以指数退避方式重新尝试。退避序列是 1、2、4、8、16、32、64、128、256 毫秒，最多 9 次（`Bits.java:109-183`）。这不是保证 Cleaner 一定及时释放，而是给已经不可达的 DirectBuffer 一个被处理的机会。

如果调用方大量创建短命 DirectBuffer，这条路径可能带来三个问题：

1. 额度频繁触顶
2. 申请线程被迫等待引用处理或 GC
3. 最终仍可能抛出 `OutOfMemoryError: Direct buffer memory`

所以 DirectBuffer 的性能优势必须和生命周期管理一起评估。只测单次 IO 速度，不测分配峰值和释放延迟，会得到片面的结论。

## 五、wrap：不分配，但共享同一块数组

还有一条经常被混淆的路径：`ByteBuffer.wrap(array, offset, length)`。它不是把数组复制进一个新的 Buffer，而是创建一个引用同一数组的 HeapBuffer 视图：

```text
byte[] data
    │
    └── ByteBuffer.wrap(data, offset, length)
             │
             ├─ hb 仍然指向 data
             ├─ position = offset
             ├─ limit = offset + length
             └─ capacity = data.length
```

因此对 Buffer 的写入会修改原数组，原数组的修改也会被 Buffer 看到。这是零额外分配的收益，也是共享存储带来的责任：调用方必须知道谁拥有数组，谁可以修改它，以及这个 Buffer 的 position/limit 只是视图边界，不是数组本身的边界。

`wrap` 适合“已有数组，只想用 Buffer API 访问”的场景；如果需要独立副本，就必须显式复制。把它当作 copy，会让修改在别处悄悄生效，问题往往直到协议解析或重试时才暴露。

## 六、两条路径的选择不是“堆内好、堆外坏”

可以把选择压缩成一张表：

| 维度 | HeapBuffer | DirectBuffer |
|---|---|---|
| 存储 | Java `byte[]` | native memory/address |
| 分配 | 普通堆对象路径 | `Bits` 额度检查 + native 分配 |
| 回收 | GC 管理对象 | Cleaner 触发 Deallocator |
| native IO | 可能需要转换/复制 | 更适合需要稳定地址的路径 |
| 监控 | 主要体现在 Java heap | 需要同时看 direct memory/native memory |
| 典型代价 | 堆对象生命周期与跨边界转换 | 释放不确定、额度限制、调试复杂 |

选择的关键不是“DirectBuffer 更快”，而是：

- 数据是否频繁穿过 native IO 边界？
- Buffer 是否短命且创建频繁？
- 是否有可靠的释放/池化策略？
- direct memory 上限和监控是否配置清楚？
- Java 堆压力与 native memory 压力哪个更需要控制？

## 结尾：DirectBuffer 的问题会在 Netty 里继续出现

HeapBuffer 和 DirectBuffer 的分叉，实际是在两种资源管理方式之间做选择：

- HeapBuffer 把对象生命周期交给 GC，使用简单
- DirectBuffer 为 native IO 提供稳定地址，但需要独立的额度和释放链
- Cleaner 让释放最终能够发生，却不提供确定的业务时机
- `Bits.reserveMemory` 把 direct buffer 的容量约束和失败路径显式化
- `wrap` 则展示了另一种选择：不复制，直接共享底层数组

下一篇进入视图和陷阱：当多个 Buffer 共享同一块数据时，slice/duplicate/wrap 的边界、equals 的 remaining 语义和线程安全问题，会把“分配选择”继续变成“所有权与观察方式”的问题。再往后，Netty Ch4 会用引用计数和池化 allocator 重新回答 DirectBuffer 的两个核心困难：何时释放，以及如何减少重复分配。
