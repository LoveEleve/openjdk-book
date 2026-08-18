# 03. FileChannel 与 mmap 零拷贝 — map、transferTo、文件锁

> **前置依赖**: [19-buffer-channel/01 — Buffer 抽象与状态机](01-buffer-state-machine.md)(直接缓冲与地址)、[19-buffer-channel/02 — ByteBuffer 家族](02-bytebuffer-family.md)(MappedByteBuffer 的父类体系)
> → **后续**: 域 21 Selector 与网络 NIO(按写作顺序)
> 关联: 内部卷 01-os(虚拟内存与页缓存);域 32 Unsafe(堆外内存)

## 一个文件,怎么"变成"内存

面试必考 "零拷贝怎么实现"——答案的核心是 `FileChannel` 的两个方法: `map()` 和 `transferTo()`。前者把文件映射进进程地址空间,后者让内核直接搬运文件数据。这一篇拆三件事: FileChannel 的能力全景、mmap 内存映射与 MappedByteBuffer 的控制、transferTo 零拷贝的三级路径。

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

## 核心悬念

文件通道收官——但**网络通道**呢?`SocketChannel` 怎么注册到 `Selector`?epoll 是什么?IO 多路复用怎么让一个线程管百万连接?NIO 的事件驱动模型怎么工作?——下一篇(按写作顺序): 域 21 Selector 与网络 NIO。

> → 域 21 Selector 与网络 NIO(21-selector 系列)| 关联: 域 32 堆外内存
