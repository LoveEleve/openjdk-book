# Heap 与 Direct：ByteBuf 存在哪里，为什么会改变路径

> 本文基于当前 Netty `buffer` 模块源码，比较 Unpooled Heap/Direct ByteBuf、Unsafe 变体、扩容释放与跨类型复制。前置：Ch4-01 `01-dual-index-and-refcnt.md`、Ch4-02 `02-allocator-system.md`、Ch1 Heap/Direct 基础、Ch2/Ch3 I/O 场景；本文不展开派生视图、Composite 内部算法和 Pooled Arena。

## Allocator 已经做了选择，差别才刚刚开始

上一节讲了 `ByteBufAllocator` 的职责：调用者表达“我要普通缓冲区”或“我要 I/O 缓冲区”，allocator 再把这个意图落成 heap、direct、pooled 或 unpooled 的具体对象。

但当 allocator 返回 ByteBuf 后，真正影响行为的问题才出现：

```text
这块数据到底放在哪里？
Java 代码如何访问它？
Channel 如何把它交给 native I/O？
扩容时旧数据怎么搬？
release 时谁负责释放？
```

Heap 和 Direct 的差别，不是“一个好、一个坏”，更不是所有场景都能用一句“Direct 更快”概括。它们至少在四条路径上不同：

1. 底层存储：`byte[]` 还是 direct `ByteBuffer`/native memory。
2. Java 访问：数组索引、ByteBuffer get/put，或 Unsafe/VarHandle 变体。
3. I/O 交接：是否可以直接提供 native 可识别的 direct buffer 或地址。
4. 生命周期：GC 管理数组，还是由 cleanable、外部所有权或池化结构共同管理。

因此，本篇不试图给出一个脱离场景的性能排名，而是沿着同一份数据的完整旅程比较两种实现：从创建开始，经过读写和扩容，最终到跨类型拷贝和释放。

## 一、先建立两条路径：Heap 方便 Java，Direct 方便特定交接

先用一个 I/O 场景把问题具体化。

事件循环从 Socket 读到数据后，通常还要经过协议解析、字段判断、消息组装，最后可能又交给 Socket 写出。中间的处理阶段更关心 Java 能否方便地访问和修改内容；边界上的 I/O 阶段则可能更关心底层接口能否直接使用一块 native 可见的内存。

于是同一份数据会面对两种需求：

```text
Java 业务处理：数组/索引/对象模型更方便
Native I/O 交接：direct memory 可能减少中间转换
```

Heap ByteBuf 把内容放进 Java `byte[]`。它天然适合普通 Java 访问，数组可直接暴露给需要数组的 API，回收责任最终由 GC 承担。

Direct ByteBuf 把内容放到堆外的 direct `ByteBuffer` 或其背后的 native memory。它不提供 `byte[]`，但可以在满足条件时暴露 direct buffer 地址，让某些 I/O 路径直接使用这块内存。

这里的“可能”很关键。Direct 只是在特定交接路径上具备优势，不意味着每次 Java 访问都绕过了所有开销；Heap 也不意味着每次 I/O 都必然发生一次额外复制。真正的路径要看具体的 ByteBuf 实现、目标 API 和是否存在 array/address/NIO buffer 能力。

接下来先看 Heap，把它作为基线；再看 Direct 为什么需要更多字段、分支和释放协议。

## 二、Heap ByteBuf：一块 byte[] 如何变成完整 ByteBuf

### 1. 新建和包裹是两种不同的初始状态

`UnpooledHeapByteBuf` 的底层核心很直接：一个 `byte[] array`，外加 allocator 引用和一个惰性的临时 NIO view，见 `UnpooledHeapByteBuf.java:38-42`。

但构造 Heap ByteBuf 时有两种语义，不能混在一起。

第一种是新分配：allocator 给出 initialCapacity，ByteBuf 创建一块新数组，并把两个索引设为 0，准备接受写入，见 `UnpooledHeapByteBuf.java:50-61`。

```text
new byte[initialCapacity]
  -> readerIndex = 0
  -> writerIndex = 0
  -> 整块空间都是 writable
```

第二种是包裹已有数组：ByteBuf 不复制这块数组，而是直接把它作为底层存储，并把 `writerIndex` 设置为数组长度，见 `UnpooledHeapByteBuf.java:69-82`。

```text
已有 byte[]
  -> readerIndex = 0
  -> writerIndex = array.length
  -> 整块数组立刻被视为 readable
```

这正是 wrapped 和新建 buffer 的根本区别：新建数组代表“等待写入”，包裹数组代表“内容已经存在”。如果调用者没意识到这一点，就会误把已有数组里的所有字节当成空白 writable 区域，或者重复写入已经被标记为 readable 的内容。

默认的 `allocateArray` 就是 `new byte[initialCapacity]`，`freeArray` 则是 NOOP，见 `UnpooledHeapByteBuf.java:84-90`。这里的 NOOP 不是忘了释放，而是这块数组由 JVM 对象生命周期管理，ByteBuf 的 `deallocate()` 不需要手动向操作系统归还数组内存。

### 2. Heap 的 capacity 变化就是“新数组 + 复制 + 替换”

ByteBuf 的 capacity 可以扩张，也可以缩小。Heap 实现不会在原数组后面凭空延长空间，而是创建一块新数组，把旧内容复制过去，再替换当前引用，见 `UnpooledHeapByteBuf.java:113-138`。

流程是：

```text
capacity(newCapacity)
  -> 检查新容量
  -> 计算需要保留的字节数
  -> allocateArray(newCapacity)
  -> System.arraycopy(oldArray, newArray)
  -> array 指向新数组
  -> freeArray(oldArray)
```

扩容时，旧数组全部内容可以作为复制上限；缩容时，先通过 `trimIndicesToCapacity` 把 reader/writer index 收回新容量范围，再只复制新容量范围内的数据。

这条路径有两个直接后果：

- 扩容不是零成本的，旧数据需要复制。
- 扩容期间短时间内可能同时存在旧数组和新数组，峰值内存会高于最终容量。

所以 Ch4-02 的容量增长策略很重要：如果每次只增加刚好需要的几个字节，Heap 就会频繁经历分配和复制；如果每次都过度增长，又会浪费堆空间。Allocator 的增长算法是在这些成本之间做折中，而不是 Heap 实现自己决定所有增长行为。

### 3. Heap 的普通访问先经过 ByteBuf 边界，再访问数组

安全 Heap ByteBuf 的绝对读取路径可以压缩成两步：

```text
getByte(index)
  -> ensureAccessible()
  -> _getByte(index)
       -> HeapByteBufUtil.getByte(array, index)
```

`UnpooledHeapByteBuf.getByte` 先做可达性检查，随后委托到 `_getByte`；后者由 `HeapByteBufUtil` 从数组读取，见 `UnpooledHeapByteBuf.java:320-334`。

多字节读取也遵循相同思想。`HeapByteBufUtil` 在 VarHandle 可用时走 `VarHandleByteBufferAccess`，否则用字节组合得到 short/int/long，见 `HeapByteBufUtil.java:25-33`、`:59-64`。

这里有一个重要的分层：

```text
ByteBuf 公共入口：负责资源可达性与索引边界
底层工具类：负责从 byte[] 取出并按字节序解释数据
```

因此不能因为底层最终是数组，就认为公开 API 没有保护；也不能因为工具类做了直接数组访问，就认为调用者可以绕过 ByteBuf 的边界协议。

### 4. Heap 的便利也带来一个能力边界

Heap ByteBuf 的 `hasArray()` 返回 true，`array()` 可以拿到底层数组；`hasMemoryAddress()` 返回 false，`memoryAddress()` 不支持，见 `UnpooledHeapByteBuf.java:141-163`。

这意味着它与需要 Java 数组的 API 互操作很自然，但不能假装自己拥有一个稳定的 native address。调用方如果需要 direct 地址，就必须选择 direct ByteBuf，或者接受一次转换/复制。

Heap 的优点因此不是“所有操作都更快”，而是能力面很适合 Java 侧：

- 数组访问简单。
- 普通对象分配路径成熟。
- 不需要 ByteBuf 主动释放堆外地址。
- 适合大量不直接穿过 native I/O 的处理。

这条基线建立后，Direct 的复杂性就有了参照：它要解决的不是“如何把 byte[] 换成另一个字段”，而是如何维护一块 Java 堆之外的可访问、可扩容、可释放资源。

## 三、Direct ByteBuf：一块堆外资源带来的全部责任

### 1. Direct ByteBuf 为什么保存不止一个字段

`UnpooledDirectByteBuf` 的字段比 Heap 复杂：它保存 allocator、`CleanableDirectBuffer`、底层 `ByteBuffer`、临时 NIO view、单独的 capacity，以及 `doNotFree` 标志，见 `UnpooledDirectByteBuf.java:39-47`。

每个字段都对应一个责任：

- `buffer`：Java 侧进行绝对 get/put 的 direct ByteBuffer。
- `cleanable`：当前实现可用的清理句柄。
- `capacity`：ByteBuf 自己维护的稳定容量。
- `tmpNioBuf`：需要 NIO view 时的缓存对象。
- `doNotFree`：这块 direct memory 是否由当前 ByteBuf 负责释放。

为什么要单独保存 `capacity`？因为底层 `ByteBuffer` 的 `position` 和 `limit` 会被用于复制、view 或 I/O 操作，不能把受这些状态影响的 `remaining()` 当作 ByteBuf 永久的 capacity。ByteBuf 的容量必须独立于某次 NIO view 的位置状态。

### 2. 新分配和包裹外部 Direct 的 ownership 不同

新建 Direct ByteBuf 时，构造器会调用 `allocateDirectBuffer(initialCapacity, ...)`，再把返回的 cleanable buffer 设置进对象，见 `UnpooledDirectByteBuf.java:55-71`、`:124-130`。

```text
allocateDirect(capacity)
  -> 得到 cleanable + direct ByteBuffer
  -> 保存 buffer / cleanable
  -> capacity = buffer.remaining()
```

但如果调用者把已有 direct `ByteBuffer` 交给 Netty，情况不同：ByteBuf 只是包装一份外部资源，默认不能假定自己拥有释放权。构造器把 `doNotFree` 设为 `!doFree`，用底层 buffer 的 remaining 作为初始容量，并把 writerIndex 设置为这段可读内容的长度，见 `UnpooledDirectByteBuf.java:78-104`。

这条规则和 Heap 的 wrapped array 相似，又比它多一层 ownership 风险：

```text
wrapped heap array：共享数组内容，GC 管数组
wrapped direct buffer：共享堆外资源，当前 ByteBuf 可能不拥有释放权
```

如果包装者在 release 时擅自清理外部 direct memory，就可能破坏仍由原始持有者或其他 view 使用的资源。

### 3. 为什么 Java 9+ 让 doNotFree 更重要

Unsafe Direct 变体的构造器明确把外部 ByteBuffer 包装路径设置为 `doFree=false`，并解释了原因：如果传入的是 duplicate 或 slice，Java 9 的 `Unsafe.invokeCleaner(...)` 会检查对象类型，清理这类 buffer 可能抛出 `IllegalArgumentException`，见 `UnpooledUnsafeDirectByteBuf.java:58-68`。

所以 `doNotFree` 同时承担两层保护：

1. ownership 保护：当前 ByteBuf 不知道外部 direct memory 是否仍被别人使用。
2. 实现兼容保护：某些外部 ByteBuffer 只是 duplicate/slice，不能安全地作为原始分配对象直接清理。

这不是说外部 direct memory 永远不会释放，而是说当前包装对象不应越权执行释放。谁创建、谁拥有、谁负责最终清理，需要由外部 ownership 协议决定。

### 4. Direct 的普通访问仍然可能经过 ByteBuffer

Direct ByteBuf 的基础 byte 访问并没有自动变成 Unsafe 地址访问。`UnpooledDirectByteBuf._getByte` 直接调用 `buffer.get(index)`，见 `UnpooledDirectByteBuf.java:257-266`。

多字节访问则有条件分支：如果 `PlatformDependent.hasVarHandle()` 为 true，`getInt/getLong` 等路径使用 `VarHandleByteBufferAccess`；否则使用 `ByteBuffer.getInt/getLong`，见 `UnpooledDirectByteBuf.java:323-341`、`:357-369`。

写入路径也同样：VarHandle 可用时使用对应的 set 方法，不满足条件时回退到 `ByteBuffer.putInt/putLong`，见 `UnpooledDirectByteBuf.java:449-480`、`:527-549`。

因此不能把 Direct 直接写成“绕过 JNI 的最快路径”。当前普通 Direct 实现仍以 NIO ByteBuffer 为访问抽象；是否走 VarHandle、是否能拿到地址、底层平台如何实现，都由运行环境和具体变体决定。

## 四、Unsafe 变体：把地址访问提前，但把边界责任留在上层

### 1. Unsafe Heap 为什么可以跳过初始化清零

`UnpooledUnsafeHeapByteBuf` 继承 Heap ByteBuf，但重写数组分配和访问路径：数组可以通过 `PlatformDependent.allocateUninitializedArray` 创建，单字节和多字节访问委托给 `UnsafeByteBufUtil`，见 `UnpooledUnsafeHeapByteBuf.java:37-51`。

所谓 uninitialized 的关键是：对于即将被完整写入的缓冲区，可以避免先把每个字节初始化为 0，再马上覆盖一遍的成本。但它也改变了安全前提：如果代码读取了尚未写入的区域，就不能期待普通 `new byte[]` 带来的零值。

这类路径因此适合 Netty 能明确管理写入范围的内部场景，不应被误解成“所有新建数组都应该跳过初始化”。

### 2. Unsafe Direct 把 address 缓存成访问入口

`UnpooledUnsafeDirectByteBuf` 在 Direct 基础上增加 `memoryAddress`，当底层 ByteBuffer 被设置或替换时，重新取得 direct buffer address，见 `UnpooledUnsafeDirectByteBuf.java:32-36`、`:94-104`。

它的单字节访问可以概括成：

```text
getByte(index)
  -> checkIndex(index)
  -> _getByte(index)
       -> UnsafeByteBufUtil.getByte(memoryAddress + index)
```

源码中 `_getByte` 走 `UnsafeByteBufUtil.getByte(addr(index))`，多字节访问也在 VarHandle 可用时走 VarHandle，否则走 Unsafe 地址路径，见 `UnpooledUnsafeDirectByteBuf.java:117-140`、`:167-207`。

这里的性能意图很明确：把底层地址缓存下来，避免每次访问都重新取得地址，并在已经完成边界检查后使用底层访问工具。但“意图明确”不等于可以给出固定的纳秒数字；实际成本还受 JIT、CPU、对齐、VarHandle 能力和调用路径影响。

### 3. Unsafe 没有取消边界检查，只是把检查和访问分层

从 `_getByte` 的代码看，它没有再次检查 index；但公开的 `getByte` 先调用 `checkIndex(index)`，见 `UnpooledUnsafeDirectByteBuf.java:117-126`。`getInt`、`getLong` 等公开入口也先检查对应长度，再进入底层访问，见 `UnpooledUnsafeDirectByteBuf.java:167-199`。

这是一种明确的分层：

```text
公开 API：ensureAccessible + checkIndex/checkIndex(length)
底层 _get/_set：假定边界已确认，追求更直接的访问
```

如果一个内部调用绕过公开入口却没有自己证明边界，Unsafe 访问可能把错误扩展成更严重的内存问题。因此 Unsafe 不是“没有安全检查”，而是把安全检查放到了调用层；调用层必须始终履行这份责任。

### 4. VarHandle 不是 Heap/Direct 的专属替代品

Heap 的 `HeapByteBufUtil`、Direct 的 `UnpooledDirectByteBuf`、Unsafe 变体都可能在 VarHandle 可用时采用对应路径。它解决的是多字节访问如何在当前 Java 运行环境中走一条合适的访问通道，而不是简单宣布“VarHandle 一定比 Unsafe 快”。

Unsafe 工具还会根据平台是否支持 unaligned access 选择不同策略：可以批量读取时走更宽的访问，不满足条件时退回按字节组合，见 `UnsafeByteBufUtil.java:34-57`。

所以这里应该记住的是条件结构，而不是某个固定实现排名：

```text
能力可用 + 边界已确认
  -> 选择更直接的访问路径
能力不满足或场景不适合
  -> 回退到兼容实现
```

## 五、扩容和释放：Heap 搬数组，Direct 搬资源

### 1. Heap 扩容是数组替换

Heap 扩容的核心动作是 `new byte[]`、`System.arraycopy`、替换数组引用。旧数组不再被 ByteBuf 持有后，`freeArray` 默认不做显式释放，最终由 GC 管理，见 `UnpooledHeapByteBuf.java:113-138`、`:548-551`。

它的优势是生命周期简单；代价是扩容时存在数组复制和短暂的旧新数组共存。

### 2. Direct 扩容还要处理 ByteBuffer 的 position/limit

Direct 扩容不能简单写成“分配新 direct memory，再 copyMemory”。当前普通 Direct 实现会：

1. 检查新容量。
2. 计算需要保留的字节数。
3. 分配新的 `CleanableDirectBuffer`。
4. 把旧 buffer 的 position 设为 0、limit 设为保留长度。
5. 把新 buffer 的 position/limit 设为对应范围。
6. 调用新 buffer 的 `put(oldBuffer)` 复制。
7. 清理并替换旧 buffer。

见 `UnpooledDirectByteBuf.java:178-203`。

```text
old direct ByteBuffer
  -> position(0).limit(bytesToCopy)
new direct ByteBuffer
  -> position(0).limit(bytesToCopy)
  -> newBuffer.put(oldBuffer).clear()
  -> setByteBuffer(newBuffer, true)
```

这里使用 ByteBuffer 的 put，不代表 Direct 一定没有更底层的复制优化，而是当前这个普通 Direct 实现通过 ByteBuffer 的相对 put 完成扩容复制，同时让 `setByteBuffer` 统一处理旧资源清理和字段更新。Unsafe/no-cleaner 变体可以采用不同重分配路径；`UnpooledUnsafeNoCleanerDirectByteBuf.capacity` 直接使用 `PlatformDependent.reallocateDirect`，见 `UnpooledUnsafeNoCleanerDirectByteBuf.java:23-54`。

### 3. Direct release 的责任比 Heap 多一层

Heap `deallocate()` 调用 `freeArray`，默认是 NOOP，然后把 array 替换为空数组。Direct `deallocate()` 则要根据当前是否有 cleanable、是否允许释放，选择 `cleanable.clean()` 或 `freeDirect(buffer)`，见 `UnpooledDirectByteBuf.java:781-797`。

如果是外部包装的 direct buffer，`doNotFree` 保护了这条路径；如果是 no-cleaner 变体，则可能由专用的 reallocate/free 逻辑管理资源。池化 ByteBuf 又会把资源归还到 arena 和 recycler，见 `PooledByteBuf.java:174-185`。

因此释放动作的差别可以这样看：

```text
Heap：取消 ByteBuf 对 byte[] 的持有，GC 最终处理数组
Direct：清理/释放 direct 资源，不能越过 doNotFree
Pooled：归还池化结构，并回收 ByteBuf 对象
```

这也是为什么上一篇说 allocator 选择的不只是“存储位置”，还选择了资源寿命管理路径。

## 六、Heap 与 Direct 之间的拷贝：先找能力，再选路径

### 1. 跨类型复制不是一个固定动作

假设要执行：

```text
srcBuf.getBytes(srcIndex, dstBuf, dstIndex, length)
```

实现至少需要回答两个问题：

- 目标是否暴露 Java array？
- 源或目标是否暴露 native memory address？

如果不先看这些能力，最简单的通用实现就是逐字节调用 ByteBuf API。它通常能工作，但会错过批量复制和底层内存路径。

Netty 的策略是先判断能力，再选择路径。

### 2. Heap 源的三路分发

`UnpooledHeapByteBuf.getBytes(index, dst, dstIndex, length)` 先检查目标：

1. 目标有 memory address 且 Unsafe 可用：使用 `PlatformDependent.copyMemory`。
2. 目标有 array：走数组复制路径。
3. 两者都不满足：回退到目标的 `setBytes`，见 `UnpooledHeapByteBuf.java:167-175`。

Heap 到普通 byte[] 的路径直接使用 `System.arraycopy`，见 `UnpooledHeapByteBuf.java:180-183`。

因此不同组合大致是：

```text
Heap -> Heap：array 到 array，批量数组复制
Heap -> Direct：array 到 native address，条件满足时 copyMemory
Heap -> 通用目标：回退到目标 ByteBuf 的 setBytes
```

这里必须纠正“copyMemory 就是零拷贝”的说法：它仍然把数据从源复制到目标，只是避免了中间对象和逐字节通用路径。真正的零拷贝视图是共享同一底层存储、只改变索引范围的另一类机制，留到 Ch4-04。

### 3. Direct 源的对称路径

Direct 源的 `getBytes` 会优先判断目标是否有 array；如果目标是 Netty 的 AbstractByteBuf，还可以取内部 NIO buffer，使用 `PlatformDependent.absolutePut`；如果目标暴露多个 NIO buffer，则逐个处理；最后才回退到 `dst.setBytes`，见 `UnpooledDirectByteBuf.java:373-391`。

Unsafe Direct 则把可用地址和数组能力的判断集中到 `UnsafeByteBufUtil`。当目标有 memory address 时直接 `copyMemory`；目标有 array 时复制到数组；否则回退到通用 ByteBuf API，见 `UnsafeByteBufUtil.java:513-577`。

所以跨类型拷贝的主线是：

```text
先检查能力
  -> address/address：底层批量复制
  -> address/array：底层批量复制
  -> array/array：System.arraycopy 或等价路径
  -> 没有可用能力：NIO/ByteBuf 通用回退
```

这种“积极匹配”既保留了统一 API，也避免让所有组合都退化到最慢的通用方式。但它会增加实现复杂度：每种能力组合都要正确处理索引、长度、ByteOrder、read-only 和生命周期。

## 七、几个最容易错的判断

### 1. Direct 一定比 Heap 快

不成立。Direct 的优势集中在某些 native I/O 交接路径；普通 Java 访问、频繁小对象分配、调试和释放都可能让 Heap 更合适。应根据数据是否频繁穿过 native 边界、分配复用情况和实际 benchmark 决定。

### 2. Heap 到 Direct 的 copyMemory 是零拷贝

不成立。`copyMemory` 仍然复制数据，只是使用了更直接的地址/数组批量复制。共享底层存储的 slice/duplicate 才属于视图式零拷贝，下一篇再讲。

### 3. Unsafe 绕过了边界检查，所以公开 API 不安全

不成立。Unsafe 变体的公开入口仍然先做 `checkIndex`；底层 `_get/_set` 假定边界已由上层确认。真正危险的是绕过这些入口后，调用者没有履行边界证明责任。

### 4. 外部 Direct ByteBuffer 被包装后，release 就应该清理它

不成立。包装对象可能没有释放权，`doNotFree` 就是这种 ownership 边界的实现表达。外部资源的最终释放要由真正的拥有者负责。

### 5. no-cleaner 就等于不需要释放

不成立。no-cleaner 只是改变 direct 内存的分配/重分配/释放路径，不会取消 ByteBuf 的 ownership 协议。仍然必须正确 release。

## 收网：Heap 与 Direct 选择的是路径，不是排名

现在可以回答开篇的问题：Allocator 为什么需要区分 heap 和 direct？

因为它们会把同一份 ByteBuf 操作引向不同的底层路径：

```text
Heap
  -> byte[]
  -> Java 数组/HeapByteBufUtil
  -> arraycopy 或跨类型复制
  -> freeArray 默认不负责显式释放

Direct
  -> direct ByteBuffer / native memory
  -> ByteBuffer get/put 或 VarHandle/Unsafe 变体
  -> 可在条件满足时暴露 address 给 I/O/复制路径
  -> cleanable/freeDirect/doNotFree 共同决定释放边界
```

Unsafe 变体再把访问路径细分：它把地址或未初始化数组带来的机会交给底层工具，但把边界和可达性责任留在公开入口。跨类型复制则根据 array、address 和 NIO 能力选择批量复制或通用回退。

所以本篇真正的结论不是“Heap 适合业务、Direct 适合网络”这句口号，而是：

```text
Heap 与 Direct 的差别，贯穿创建、访问、复制、扩容和释放五条链路
选择一种存储类型，就是选择一组成本、能力和 ownership 约束
```

上一篇讲 Allocator 如何决定“创建哪一种策略”，本篇讲这些策略落地后会发生什么。下一篇进入视图与零拷贝：如果 slice/duplicate 不复制数据，它们如何复用 Heap/Direct 的底层存储？一个视图 release 后，父 buffer 和其他视图为什么可能一起失效？