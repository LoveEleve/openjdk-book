# 03. FileChannel 与 mmap 零拷贝 — map、transferTo、文件锁

> 本文基于 JDK 11 `FileChannel`、`MappedByteBuffer`、`FileChannelImpl`。本文聚焦 `map`、`MappedByteBuffer.load/force`、`transferTo/transferFrom`、文件锁与零拷贝语义；不深入 NIO Selector/SocketChannel 与所有平台差异分支。本文讨论的是 JDK 11 文件通道与内存映射语义，不把这里的 mmap、sendfile 降级路径和页缓存控制方式外推成所有平台、所有通道实现都必须遵守的统一规范。
> **前置依赖**：[19-buffer-channel/01 — Buffer 抽象与状态机](01-buffer-state-machine.md)(直接缓冲与地址)、[19-buffer-channel/02 — ByteBuffer 家族](02-bytebuffer-family.md)(MappedByteBuffer 的父类体系)
> **后续**：域 21 Selector 与网络 NIO(按写作顺序)

## 为什么文件不只是“读一段字节”,还可以像内存一样访问、像内核任务一样直接搬运

很多人第一次接触 `FileChannel` 时,都会把它理解成“比 FileInputStream 更高级一点的读写接口”。这样理解当然不全错,但会把它最值得学的两个能力都压扁: 一是 `map()`——文件为什么能看起来像一段内存;二是 `transferTo()`——文件数据为什么有机会根本不经过用户态缓冲就被送到目标通道。

真正的问题不在“API 多了几个方法”,而在于 **文件在通道视角下不再只是顺序字节流,而是既可以被映射成地址空间的一段页,也可以被当成内核直接搬运的数据源**。这也是为什么 `FileChannel`、`MappedByteBuffer`、`transferTo()` 这些名字经常和 `mmap`、页缓存、sendfile、零拷贝绑在一起——它们对应的是三条完全不同于普通流的能力边界。

所以这一篇的主线不是方法清单,而是沿着两个问题展开: 为什么 `map()` 像是在把文件“变成内存”,以及为什么 `transferTo()` 所谓的“零拷贝”其实是在尽量消灭用户态中转,而不是让数据凭空不移动。

## 1. "FileChannel 是什么？" — 文件通道抽象

### 1.1 文件操作的"完整能力接口"

`FileChannel`(`java/nio/channels/FileChannel.java`)是抽象类,定义了一整族文件操作(`FileChannel.java:564` 的 `force`、`:629` 的 `transferTo`、`:925` 的 `map`、`:1021` 的 `lock`)。实现是 `sun.nio.ch.FileChannelImpl`(`FileChannelImpl.java`): `read`@208、`force`@451、`transferTo`@654、`map`@928、`lock`@1099。

定位: **阻塞式文件 IO 的"通道化"**。对比 `FileInputStream`(只能读的流),FileChannel 是文件能力的全集——读写、随机定位(position)、映射(map)、锁(lock)、截断(truncate)。生产选型: 通用顺序读写用流;需要映射/锁/批量转移用通道。

### 1.2 文件锁:进程间互斥

`lock`(`FileChannel.java:1021` 抽象、`FileChannelImpl.java:1099` 实现)提供**文件区域锁**——多个进程/线程对同一文件的重叠区域互斥。锁的语义:

- `lock(0, Long.MAX_VALUE, false)` = 独占整文件
- `lock(pos, size, true)` = 共享锁(读锁)
- `tryLock` = 非阻塞尝试,拿不到立刻返回 null

生产里这是比 `createNewFile` 更强的进程互斥方案——锁的范围是文件区域,不是"文件是否存在"(createNewFile 只是"原子创建"的弱方案)。

关键设计(斜体):*FileChannel = "文件的完整能力接口"(读写+映射+锁+截断),FileInputStream 只是"读流"。面试"文件 IO 怎么选": 通用读用流,高级操作(锁/映射/批量转移)用通道;文件锁是进程间互斥的正式机制。*

## 2. "map() 的 mmap 是什么？" — 内存映射文件

### 2.1 从抽象到 native

`map`(`FileChannel.java:925` 抽象)→ `FileChannelImpl.map`(`FileChannelImpl.java:928`)→ `map0` native(`FileChannelImpl.java:1198`)→ **mmap 系统调用**。调用链:

```java
// FileChannelImpl.java:1197-1199(截取核心,逐字)
    // Creates a new mapping
    private native long map0(int prot, long position, long length)
        throws IOException;
```

### 2.2 三态映射模式

MapMode(`FileChannel.java:795-818`)三态:

| 模式 | 语义 | FileChannelImpl 映射 |
|------|------|------|
| `READ_ONLY` | 只读映射,写抛 ReadOnlyBufferException | `MAP_RO = 0`(`FileChannelImpl.java:924`) |
| `READ_WRITE` | 读写映射,改动会写回文件 | `MAP_RW = 1`(`:925`) |
| `PRIVATE` | **写时复制**(copy-on-write)——改动只在内存,不写回文件 | `MAP_PV = 2`(`:926`) |

实现里 `imode` 按 MapMode 换算(`FileChannelImpl.java:943-950`),传给 map0 的 prot 参数。

### 2.3 map 的页对齐细节

`map` 的实现有一段**页对齐逻辑**(`FileChannelImpl.java:996-1005`):

```java
// FileChannelImpl.java:996-1005(截取核心,逐字)
                pagePosition = (int)(position % allocationGranularity);
                long mapPosition = position - pagePosition;
                mapSize = size + pagePosition;
                try {
                    // If map0 did not throw an exception, the address is valid
                    addr = map0(imode, mapPosition, mapSize);
```

mmap 要求**映射起点页对齐**——`position` 不落在页边界时,向前对齐到页首(`mapPosition = position - pagePosition`),映射长度补上多出的部分(`mapSize = size + pagePosition`)。返回的 MappedByteBuffer 从 `addr + pagePosition` 开始(`FileChannelImpl.java:1038` 的 `newMappedByteBuffer(isize, addr + pagePosition, ...)`),用户看到的还是从原 position 开始。

另外两个细节:

- **文件扩展**: 映射超出文件末尾时(`filesize < position + size`),`READ_WRITE` 模式会先 `nd.truncate` 扩展文件(`FileChannelImpl.java:974-982`);只读通道则抛 IOException("cannot extend file to required size")
- **OOM 重试**: map0 抛 OutOfMemoryError 时,先 `System.gc()` + 睡 100ms 再试一次(`FileChannelImpl.java:1008-1013`)——映射失败常因地址空间碎片,GC 后再试有机会成功

### 2.4 返回 MappedByteBuffer:堆外直接缓冲

map 返回的是 `MappedByteBuffer`(`Util.newMappedByteBuffer`,`FileChannelImpl.java:1036-1044`)——**堆外直接缓冲**,地址直映文件页: 读写 buffer 即读写文件页缓存,OS 负责脏页回写。这就是"文件变成内存"。

卸载: `unmap0`(`FileChannelImpl.java:898`)在 `Unmapper.run`(`FileChannelImpl.java:896-903`,映射对象的 cleaner 回调)里调用——映射随 GC 释放。

关键设计(斜体):*mmap 把"文件页"映射进进程地址空间——读写 buffer 即读写文件(OS 页缓存回写);对比 read/write 系统调用(每次进内核+拷贝),大文件随机访问 mmap 完胜。面试"mmap 与普通读的区别": 用户态读写直映页缓存,少一次用户↔内核拷贝;写回由 OS 管理,force 才刷盘。页对齐细节能说出来(向前对齐+补长)就是源码级。*

跨层标注: [内部卷: 01-os 02-virtual-memory——mmap 把虚拟内存页映射到文件页,页缓存(Page Cache)是中间层;map0 的页对齐是虚拟内存页大小的直接体现]

## 3. "MappedByteBuffer 的 load/force" — 映射控制

### 3.1 load:预加载页

`load()`(`MappedByteBuffer.java:152`)把映射的所有页**预加载进物理内存**——`load0` native 先做一次性预载,再用"逐页读一个字节"的循环把每页真正带进物理内存(`MappedByteBuffer.java:152-179`):

```java
// MappedByteBuffer.java:152-179(截取核心,逐字;前半校验省略)
    public final MappedByteBuffer load() {
        ...
        long offset = mappingOffset();
        long length = mappingLength(offset);
        load0(mappingAddress(offset), length);

        // Read a byte from each page to bring it into memory. A checksum
        // is computed as we go along to prevent the compiler from otherwise
        // considering the loop as dead code.
        Unsafe unsafe = Unsafe.getUnsafe();
        int ps = Bits.pageSize();
        int count = Bits.pageCount(length);
        long a = mappingAddress(offset);
        byte x = 0;
        try {
            for (int i=0; i<count; i++) {
                // TODO consider changing to getByteOpaque thus avoiding
                // dead code elimination and the need to calculate a checksum
                x ^= unsafe.getByte(a);
                a += ps;
            }
        } finally {
            Reference.reachabilityFence(this);
        }
```

`isLoaded()`(`MappedByteBuffer.java:128`)问"页都在内存吗",底层是 `isLoaded0` native(`MappedByteBuffer.java:215`);`load0` 声明在 `:216`。语义: **load 减少后续访问的缺页中断**——大文件顺序读前预热,避免边读边缺页的抖动。

### 3.2 force:刷盘

`force()`(`MappedByteBuffer.java:204-213`):

```java
// MappedByteBuffer.java:204-213(截取核心,逐字)
    public final MappedByteBuffer force() {
        if (fd == null) {
            return this;
        }
        if ((address != 0) && (capacity() != 0)) {
            long offset = mappingOffset();
            force0(fd, mappingAddress(offset), mappingLength(offset));
        }
        return this;
    }
```

`force0` native(`MappedByteBuffer.java:217`,对应 **msync/fsync**)把**脏页写回磁盘**。语义: **force 保证持久性**——mmap 的写入默认由 OS 页缓存异步回写,崩溃可能丢数据;事务日志类场景必须写后 force。

### 3.3 语义对比

| | load() | force() |
|--|--------|--------|
| 方向 | 磁盘 → 内存(预加载) | 内存 → 磁盘(刷盘) |
| 目的 | 减少缺页,提升读性能 | 保证持久性,防崩溃丢失 |
| 底层 | 逐页触及(isLoaded0) | msync/fsync(force0) |

关键设计(斜体):*load/force 是"页缓存管理"的 Java 入口——load 预热(大文件顺序读)、force 持久化(事务日志)。面试"mmap 数据什么时候落盘": OS 页缓存异步回写,或显式 force——不 force 的 mmap 写入有崩溃丢失风险。*

## 4. "transferTo 零拷贝" — sendfile

### 4.1 三级路径

`transferTo`(`FileChannel.java:629` 抽象、`FileChannelImpl.java:654` 实现)从源文件往目标通道搬运数据,内部**三级降级**(`FileChannelImpl.java:677-686`):

```java
// FileChannelImpl.java:677-686(截取核心,逐字)
        // Attempt a direct transfer, if the kernel supports it
        if ((n = transferToDirectly(position, icount, target)) >= 0)
            return n;

        // Attempt a mapped transfer, but only to trusted channel types
        if ((n = transferToTrustedChannel(position, icount, target)) >= 0)
            return n;

        // Slow path for untrusted targets
        return transferToArbitraryChannel(position, icount, target);
```

1. **`transferToDirectly`**(`:522`)——**sendfile 系统调用**(native 是 `transferTo0`,`FileChannelImpl.java:1205`): 内核直接在"源文件页 → 目标 fd"之间搬运,**数据不进用户态**
2. **`transferToTrustedChannel`**——目标也是同 JVM 的通道时,用 mmap 中转优化
3. **`transferToArbitraryChannel`**——普通通道,退化为 read+write 循环

### 4.2 零拷贝的本质:少两次用户态中转

传统 read+write 拷贝路径:

```
磁盘 → 内核缓冲 → 用户缓冲 → 内核缓冲 → 目标
     (DMA)      (read)      (write)    (DMA)
```

**四次数据搬移,两次经过用户态**。sendfile 路径:

```
磁盘 → 内核页缓存 → 目标
     (DMA)      (DMA)
```

**数据全程不经过用户态**——这就是"零拷贝"的含义: 不是零数据搬移,是**零用户态中转**(内核内可能仍有 DMA 到目标)。

面试表述: "传统 4 次拷贝(两次用户态中转)vs sendfile 2 次(纯内核 DMA);Kafka/Netty 的零拷贝同源"。

### 4.3 生产:大文件传输

```java
// 用法示意(API 形式,非源码片段)
try (FileChannel src = FileChannel.open(srcPath, READ);
     FileChannel dst = FileChannel.open(dstPath, WRITE, CREATE)) {
    src.transferTo(0, src.size(), dst);   // 同机大文件复制
}
```

同机文件复制、日志转储、网络传输(配合 SocketChannel,域 21)优先 transferTo。

关键设计(斜体):*"零拷贝"= 数据不进用户态——sendfile 让内核直接把文件页发给目标 fd。面试"零拷贝几次拷贝": 传统 4 次 vs sendfile 2 次(免两次用户态中转);能说出三级降级路径(直接→信任通道→通用)就是源码级;Kafka/Netty 零拷贝与 JDK 的 transferTo 同源。*

跨层标注: [内部卷: 01-os——sendfile(2)/mmap(2)系统调用与页缓存;域 21 Selector——SocketChannel 与 transferTo 组合的网络零拷贝]

## 五、五个最容易混掉的边界：FileChannel 不只是流，mmap 不是读进堆数组，load 不等于 force，零拷贝不是零移动，transferTo 也不是总走 sendfile

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`FileChannel` 不是“比 FileInputStream 多几个方法”的顺序流小升级。它真正多出来的是文件资源视角：位置、映射、锁、批量转移，这些能力都在说明它面对的已经不是单纯“读一串字节”，而是一份可定位、可映射、可搬运的文件资源。

第二，`map()` 也不是把文件内容复制进一个 Java 堆数组。它借的是操作系统虚拟内存，把文件页映射进进程地址空间；你碰到的是映射页，不是手工 `read` 出来的一份用户态副本。

第三，`load()` 更不等于 `force()`。一个是在努力把页提前热进内存，减少后续缺页；另一个是在尽量把已经改脏的页刷回磁盘，保证持久性。它们一进一出，服务的是完全不同的方向。

第四，所谓零拷贝也不是“数据完全没有移动”。它真正省掉的是数据经过用户态缓冲再回到内核的那两次折返；DMA、页缓存和目标设备之间照样会发生数据搬移，只是这条路径尽量不再把用户态当中转站。

第五，`transferTo()` 也不是无论何时都能直接命中 sendfile 快路径。JDK 自己就准备了直接搬运、信任通道中转和通用 read+write 慢路径三级降级；目标通道类型、平台支持和场景边界一变，走的就可能不是同一条路。

把这五条边界记稳，FileChannel 这一篇就不会重新塌回“mmap 很快、零拷贝很酷”的口号印象。它真正想讲的是两条不同但互补的能力线：一条把文件页映射成地址空间里的可访问页，另一条把文件数据尽量留在内核路径里直接搬运到目标通道。

## 收网：FileChannel 真正把文件从“顺序字节流”提升成“可映射、可锁定、可直接搬运的数据源”

回到开头那个问题，现在已经能看清为什么 FileChannel 不该只被理解成“更高级的文件流”。它真正把文件能力拆成了两种非常不同的视角：

- `map()` 让文件页进入地址空间，于是文件可以像内存一样被访问；
- `transferTo()` 让文件数据尽量在内核侧直接搬运，于是用户态中转可以被最大限度削掉；
- `load/force` 又进一步把页缓存预热和持久化边界显式交给调用方控制。

把整篇压成一张总图，就是：

```text
FileChannel
  → 不只是顺序读写
  → 还拥有位置、映射、锁与批量转移能力

mmap 路线
  → 文件页映射进地址空间
  → load 预热页
  → force 刷回脏页

transferTo 路线
  → 优先走 sendfile 直搬
  → 不行再降级到中转或 read+write
  → 零拷贝的重点是少过用户态
```

如果说这一域前两篇解决的是“Buffer 怎样组织状态、ByteBuffer 家族怎样共享底层”，这一篇真正补上的就是：**当底层数据源换成文件时，缓冲、映射和直接搬运怎样一起把 I/O 能力推到更接近操作系统的边界。** 下一站进入域 21 时，视角就会从文件转到网络：为什么一个线程能等很多连接，Selector 又是怎样把“替每个连接单独阻塞”等待这件事重新集中起来的。
