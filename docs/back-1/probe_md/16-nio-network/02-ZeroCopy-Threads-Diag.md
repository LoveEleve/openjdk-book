> **阶段**：[16-nio-network]
> **前置**：[00-Server-Selector-Engine]（Selector engine, epoll bug deep analysis）、[01-Socket-Data-Close]（socket+DirectBuffer）
> **配套**：[00]（epoll bug reference）、[01]（SO_LINGER reference）
> **阅读收益**：sendfile64 zero-copy+Reactor multi-thread+production diagnostics complete chain

---

# 02-ZeroCopy-Threads-Diag: sendfile64 零拷贝 + Reactor 多线程 + 生产诊断

---

## §〇 生产场景 — sendfile EINVAL + Reactor Stuck + epoll CPU Spin

### 场景 1: sendfile EINVAL — Kafka 吞吐量从 1GB/s 降到 200MB/s

Kafka broker 日志大量 `sendfile returns EINVAL` — `FileChannel.transferTo()` 不传输数据。

Root cause: Linux `sendfile64` 对 fd 对有限制 — `out_fd` 必须是 socket, `in_fd` 必须普通文件。特定内核版本或 fd 类型上，`sendfile64()`→-1+EINVAL。

Java 自动降级到 mmap+write 路径，吞吐量从 1GB/s 降到 200MB/s。Java 三层 fallback:
- `transferToDirectly` — sendfile64, 0次用户态拷贝, 1次 syscall
- `transferToTrustedChannel` — mmap+write, 1次内核拷贝, 8MB chunks, 2次 syscall per chunk
- `transferToArbitraryChannel` — heap byte[] read()+write(), 2次拷贝+2次 syscall per chunk

`transferSupported/pipeSupported/fileSupported` 三个 volatile boolean 缓存内核能力 (FileChannelImpl.java:471-483)。

### 场景 2: Reactor Selector Stuck Forever

你写了 Boss/Worker Reactor — Worker Selector `select()` 永不返回，因为 Boss `register(newChannel,OP_READ)` 后忘了调 `selector.wakeup()`。

`interestOps` 变更只排入 `updateKeys` 队列——不调 `wakeup()` 则 Selector 继续等待旧事件集。Worker 线程永久阻塞在 `epoll_wait`。

### 场景 3: epoll CPU Spin (引用 00 文档深度分析)

线上 NIO 服务器 CPU 打到 100% — `epoll_wait` 在阻塞模式下不停返回 0。这是 00 文档深入分析的 Linux <2.6.27 `ep_remove()` bug。本文从**诊断视角**覆盖——三步诊断 + poll 降级。

### 三步诊断

```bash
# 1. sendfile EINVAL fallback
strace -e trace=sendfile64,mmap,writev -p $(pgrep -f kafka) 2>&1 | head -10
# sendfile64(10,15,[0],8388608) = -1 EINVAL → mmap(...)→writev(...)

# 2. Reactor select stuck
jstack $(pgrep -f java) | grep -A5 "selector.select"
# Worker 线程 BLOCKED in EPoll.wait, Boss 刚 register 了但没 wakeup

# 3. epoll CPU spin (引用 00 文档的深度分析)
strace -e trace=epoll_wait -p $(pgrep -f java) 2>&1 | head -5
# epoll_wait(5,[],1024,-1)=0 repeatedly → 100% CPU
```

### 反事实（Counterfactual）

1. **sendfile 无 fallback**: EINVAL 时直接 IOException→Kafka broker 崩溃→partition leader 切换→集群级故障。
2. **Reactor 立即 epoll_ctl**: `interestOps` 立即 epoll_ctl→每次变更一次 syscall→高频场景性能退化。
3. **epoll bug 无诊断**: 只能日志猜测→MTTR 分钟级→小时级→生产不可用。

---

## §一 sendfile64 零拷贝 + Reactor 多线程全链路

### 你写的代码（引子）

**Kafka zero-copy**:

```java
// Kafka broker: 将磁盘上的 topic log 直接发送到 TCP socket
// 不经过用户空间拷贝
FileChannel fc = FileChannel.open(Paths.get("/data/topic-0/000000.log"));
SocketChannel sc = ...;
long pos = 0;
long count = fc.size();
while (count > 0) {
    long n = fc.transferTo(pos, count, sc);  // ← sendfile64(dstFD,srcFD,&offset,count)
    pos += n;
    count -= n;        // EAGAIN→retry; EINVAL→automatic fallback to mmap+write
}
```

**Reactor Boss/Worker**:

```java
Selector boss = Selector.open();
ssc.register(boss, OP_ACCEPT);

Selector[] workers = { Selector.open(), Selector.open(), Selector.open() };
int idx = 0;

// Boss: accept only
while (true) {
    boss.select();
    for (SelectionKey k : boss.selectedKeys()) {
        SocketChannel sc = ssc.accept();
        sc.configureBlocking(false);

        Selector w = workers[idx++ % workers.length];
        w.wakeup();                    // ← 忘了这行→Worker select()永不返回!
        sc.register(w, OP_READ);       // ← interestOps 只排入 updateKeys
    }
}

// Worker: I/O only
while (true) {
    worker.select();     /* ← 可能永不返回 */
    for (SelectionKey k : worker.selectedKeys()) {
        /* I/O processing */
    }
}
```

### 板块规划（6 板块）

| # | 板块 | 行数 | 核心 |
|---|------|:---:|------|
| 1 | transferTo sendfile 零拷贝 | ~1500 | sendfile64 kernel path→3 fallbacks→capability detection→platform diff→EAGAIN/EINTR→mmap fallback |
| 2 | Reactor 多线程模型 | ~1200 | Boss/Worker→lockAndDoSelect→inSelect→interestOps trap→Selector close→Netty NioEventLoop |
| 3 | epoll bug 诊断视角 | ~200 | 三步诊断+poll 降级（引用 00 文档的深度分析） |
| 4 | 诊断工具链 | ~500 | strace(sendfile fallback+epoll lifecycle)+GDB 7+/proc/ss/jcmd |
| 5 | 面试题集 12 题 + 速查表 | ~600 | 每题含源码验证+调用链+反事实 + 7 生产场景 |
| 6 | 性能基准 + 反事实表 | ~100 | sendfile vs mmap 性能 + 平台对比 + Reactor 线程模型 |

---

### 1.1 transferTo — sendfile64 零拷贝路径 (~3250 行)

#### A. sendfile64 内核路径完整解释

##### 1. 系统调用签名与参数语义

`sendfile64` 的函数签名为：

```c
#include <sys/sendfile.h>
ssize_t sendfile64(int out_fd, int in_fd, off64_t *offset, size_t count);
```

**参数语义**（FileChannelImpl.c:134-135）：
- `out_fd`: 目标 fd（必须是 socket）—— **在第一位，与 read/write 顺序相反！**
- `in_fd`: 源 fd（必须是普通文件）—— 依赖 page cache
- `offset`: in/out 参数——传入文件偏移，返回实际传输后的偏移。如果是 NULL 则从当前文件偏移开始
- `count`: 传输字节数（在 Java 中通常是 8MB = 8388608）

**返回值**：成功时返回实际传输的字节数（可能 < count），失败返回 -1 并设置 errno。

##### 2. 内核调用链 — 从用户态到 NIC

当 Java 调用 `sendfile64(out_fd, in_fd, &offset, 8388608)` 时，内核的完整路径是：

```
用户态:
  Java: transferTo0(fd, position, count, targetFD)       // FileChannelImpl.java:1205
    → JNI: Java_sun_nio_ch_FileChannelImpl_transferTo0    // FileChannelImpl.c:133
      → sendfile64(dstFD, srcFD, &offset, count)           // FileChannelImpl.c:134-135

内核态 (Linux kernel):
  __do_sendfile64(out_fd, in_fd, offset, count)           // fs/read_write.c
    → do_sendfile(out_fd, in_fd, offset, count, 0)
      → splice_file_to_pipe(in_file, offset, pipe, count) // fs/splice.c
        → in_file->f_op->splice_read()                    // 从 page cache 读
          → pipe->f_op->pipe_write()                       // 写入内核 pipe 缓冲区
      → splice_pipe_to_socket(pipe, out_socket, count)    // fs/splice.c
        → tcp_sendpage(out_socket->sk, pipe->pages, ...)   // net/ipv4/tcp.c
          → skb_add_data(skb, page)                        // 将 page 引用加入 skb
          → tcp_push()                                     // 推送到 TCP 协议栈
            → ip_queue_xmit()                              // IP 层
              → dev_queue_xmit()                           // 设备层
                → NIC DMA send                             // 硬件 DMA 发送
```

**关键架构决策**：sendfile64 使用了两次 `splice()` 的串联，但走的是内核内部优化路径。它在 `splice_file_to_pipe` 和 `splice_pipe_to_socket` 之间使用了一个**内核 pipe** 作为中间缓冲区——这个 pipe 只存在于内核中，不暴露给用户态。

##### 3. 为什么不需要 copy_to_user/copy_from_user？

这是 sendfile 零拷贝的核心秘密。理解这个问题需要先理解 `splice()` 系统调用：

```c
// splice() 签名 (man 2 splice)
ssize_t splice(int fd_in, loff_t *off_in, int fd_out, loff_t *off_out,
               size_t len, unsigned int flags);
```

`splice()` 在两个 fd 之间建立内核态数据通道。它的关键机制是：

1. **splice_pipe**：内核 pipe 的页面不使用 `copy_to_user/copy_from_user`，而是**直接持有 page cache 页面的引用**（struct page *）
2. **零拷贝语义**：当 pipe 持有 page cache 页面后，`tcp_sendpage()` 直接将这个 `struct page *` 引用附加到 `sk_buff`（socket buffer）上
3. **DMA gather**：网络设备驱动通过 DMA scatter-gather 直接从 page cache 读取数据发送到 NIC

这就是为什么不需要用户空间拷贝——数据始终在内核地址空间中流动：
- page cache → pipe（引用传递，0 拷贝）
- pipe → skb（引用传递，0 拷贝）
- skb → NIC（DMA，0 CPU 参与）

##### 4. 完整的 DMA 数据路径分析

sendfile 的 DMA 传输涉及 3 次 DMA 操作（不是传统说的 2 次）：

```
阶段 1: DMA read  (磁盘 → page cache)
  Disk controller → DMA → kernel page cache
  操作: 磁盘控制器将数据通过 DMA 写入内存中的 page cache 页面
  CPU 参与: 0（DMA 自动完成）

阶段 2: DMA gather (page cache → socket buffer)
  page cache pages → struct page * 引用 → sk_buff 的 frag_list
  操作: 网络栈将 page cache 页面引用附加到 skb 的 frag 数组
  CPU 参与: 仅指针操作（~100 CPU cycles），无 memcpy
  关键: skb->frags[i].bv_page = pipe->pages[i]; // 引用传递，不是拷贝！

阶段 3: DMA send (socket buffer → NIC)
  sk_buff → DMA engine → NIC TX ring → wire
  操作: NIC 的 DMA 引擎通过 scatter-gather 从 skb 的多个 frag 页面收集数据
  CPU 参与: 0（DMA 自动完成）
```

**对比传统 read()+write() 的 6 次操作**：

```
read(fd, buf, 8MB):
  1. Disk → DMA → page cache (DMA read)
  2. page cache → CPU memcpy → user buf (CPU copy #1)     ← CPU 参与!
  → context switch: kernel → user → kernel

write(sockfd, buf, 8MB):
  3. user buf → CPU memcpy → socket buffer (CPU copy #2)  ← CPU 参与!
  4. socket buffer → DMA → NIC (DMA send)
  → context switch: kernel → user
```

sendfile 的 2 次 context switch vs 4 次 context switch。对于 10Gbps 网卡（~1.25GB/s），每次 context switch 约 1-2μs。高频 sendfile 调用（100K QPS）时，这节省了 200K-400K μs/s = 0.2-0.4s/s 的 CPU 时间。

##### 5. 为什么 in_fd 必须是普通文件？

sendfile 的核心依赖是 **page cache**。Linux 内核中的文件类型分为两类：

| 文件类型 | 有 page cache? | 支持做 in_fd? | 原因 |
|---------|:---:|:---:|------|
| 普通文件 (S_IFREG) | 是 | 是 | 文件内容缓存在 page cache 中 |
| Socket (S_IFSOCK) | 否 | 否 | 数据在 socket buffer 中，不在 page cache |
| Pipe/FIFO (S_IFIFO) | 否 | 否 | 数据在 pipe buffer 环形队列中 |
| 设备文件 (S_IFBLK/S_IFCHR) | 否 | 否 | 设备没有文件系统的 page cache 映射 |

内核在 `do_sendfile` 中的检查（fs/read_write.c）：

```c
// 伪代码
if (!S_ISREG(in_file->f_inode->i_mode))
    return -EINVAL;  // in_fd 不是普通文件
```

`splice_file_to_pipe` 调用的是 `in_file->f_op->splice_read()` —— 只有普通文件的 `file_operations` 中才有这个函数指针。Socket 和 pipe 的 file_operations 中没有 `splice_read`。

##### 6. 为什么 out_fd 必须是 socket？

sendfile 的最终步骤是 `splice_pipe_to_socket` → `tcp_sendpage()`。`tcp_sendpage()` 是 TCP 协议栈的**内部 API**，它接受 `struct page *` 参数而不是用户态 buffer 指针：

```c
// net/ipv4/tcp.c
int tcp_sendpage(struct sock *sk, struct page *page, int offset,
                 size_t size, int flags)
{
    // 直接将 page 引用加入 skb 的 frag 数组
    // 不需要 copy_from_user！
}
```

如果 out_fd 不是 socket（比如是普通文件或 pipe），调用的是不同的 `splice_write()` 路径——这条路径无法利用 `tcp_sendpage()` 的零拷贝优势，需要额外的 CPU copy。

**验证**：Linux 内核 `fs/splice.c:splice_pipe_to_socket` 中检查 `out_file->f_op->splice_write == generic_splice_sendpage` —— 只有 socket 的 file_operations 设置了 `generic_splice_sendpage`。

##### 7. 平台差异深入

sendfile 不是 POSIX 标准，各平台实现差异巨大。Java 用条件编译处理：

**Linux**（FileChannelImpl.c:133-147）：
```c
ssize_t n = sendfile64(dstFD, srcFD, &offset, (size_t)count);
// EAGAIN: socket buffer full → IOS_UNAVAILABLE → Java 重试
// EINVAL: fd pair 不支持 → IOS_UNSUPPORTED_CASE → fallback
// EINTR: 信号中断 → IOS_INTERRUPTED → Java 重试
```

**Solaris**（FileChannelImpl.c:148-177）：
```c
sendfilevec64_t sfv;
sfv.sfv_fd = srcFD;
sfv.sfv_flag = SFV_FD_SELF;
sfv.sfv_off = position;
sfv.sfv_len = count;
n = sendfilev64(dstFD, &sfv, 1, &numBytes);
// 支持 scatter/gather: sfv 数组可以有多个源文件段
// EAGAIN 语义不同: Solaris 下可能需要更长的重试
```

**macOS**（FileChannelImpl.c:178-202）：
```c
off_t numBytes = 0;
int result = sendfile(srcFD, dstFD, position, &numBytes, NULL, 0);
// 注意: macOS 的 sendfile 参数顺序是 (srcFD, dstFD) — 与 Linux 相反！
// macOS 用 header/trailer 参数支持 HTTP chunked encoding
// result == 0 表示成功，result == -1 且 numBytes > 0 表示部分成功
```

**AIX**（FileChannelImpl.c:204-242）：
```c
struct sf_parms sf_iobuf;
sf_iobuf.header_data = NULL;
sf_iobuf.header_length = 0;
sf_iobuf.file_descriptor = srcFD;
sf_iobuf.file_offset = position;
sf_iobuf.file_bytes = count;
n = send_file(&dstFD, &sf_iobuf, SF_SYNC_CACHE);
// AIX 的 send_file 用结构体参数，支持 header/trailer
// SF_SYNC_CACHE 标志确保文件数据与缓存一致
```

**Windows**（FileChannelImpl.c:143-186）：
```c
// Windows 没有 sendfile 系统调用，使用 TransmitFile API
TransmitFile(dstFD, srcFD, count, 0, &overlapped, NULL, TF_USE_KERNEL_APC);
// TF_USE_KERNEL_APC: 使用内核 APC（异步过程调用）而不是 I/O completion port
// 完全不同的实现，但语义等效
```

**为什么需要平台差异？** sendfile 不是 POSIX 标准——它是 Linux 引入的，然后各平台实现了自己的版本。Java 不能依赖 sendfile 在非 Linux 平台上的行为一致性，所以用三层 fallback 架构做容错。

##### 8. EAGAIN 和部分写入的语义

sendfile64 返回的字节数可能 < count。这不是错误——是**部分写入**：

```c
// FileChannelImpl.c:134-135
n = sendfile64(dstFD, srcFD, &offset, (size_t)count);
if (n < 0) {
    if (errno == EAGAIN)
        return IOS_UNAVAILABLE;  // socket buffer full
}
```

Java 的处理（FileChannelImpl.java:485-520）：
```java
do {
    n = transferTo0(fd, position, icount, targetFD);
} while ((n == IOStatus.INTERRUPTED) && isOpen());
// 返回 n >= 0: 实际传输的字节数
// Java 调用方 (transferTo public) 用 while(count > 0) 循环处理剩余
```

**EAGAIN 场景**：TCP 发送缓冲区满 → sendfile64 返回 -1 + EAGAIN → Java 收到 IOS_UNAVAILABLE → 上层 while 循环 retry。这保证了非阻塞语义——如果 socket 处于非阻塞模式且发送缓冲区满，不会阻塞。

#### B. 三条 fallback 的原理分析

##### 9. Fallback 触发条件的精确分析

每条 fallback 路径都有自己的触发条件和缓存策略：

```java
// FileChannelImpl.java:522-568
private long transferToDirectly(long position, int icount,
                                WritableByteChannel target) throws IOException
{
    if (!transferSupported)
        return IOStatus.UNSUPPORTED;        // 已探测：sendfile 不可用 → 跳过

    FileDescriptor targetFD = null;
    if (target instanceof FileChannelImpl) {
        if (!fileSupported)
            return IOStatus.UNSUPPORTED_CASE; // 已探测：sendfile 到文件不可用 → 跳过
        targetFD = ((FileChannelImpl)target).fd;
    } else if (target instanceof SelChImpl) {
        if ((target instanceof SinkChannelImpl) && !pipeSupported)
            return IOStatus.UNSUPPORTED_CASE; // 已探测：sendfile 到 pipe 不可用 → 跳过
        SelectableChannel sc = (SelectableChannel)target;
        if (!nd.canTransferToDirectly(sc))
            return IOStatus.UNSUPPORTED_CASE; // 平台不支持直接传输
        targetFD = ((SelChImpl)target).getFD();
    }

    // 三个 volatile boolean 的写时机：
    // transferSupported: transferToDirectlyInternal:512 → 收到 UNSUPPORTED 时设 false
    // pipeSupported:     transferToDirectlyInternal:505 → 目标为 SinkChannelImpl 且 UNSUPPORTED_CASE
    // fileSupported:     transferToDirectlyInternal:507 → 目标为 FileChannelImpl 且 UNSUPPORTED_CASE
```

**关键设计**："Once false, never retry" — 这三个 boolean 只从 true 变为 false，永不恢复。这意味着：
- 如果 sendfile 在某个 fd 对上失败，所有后续 transferTo 调用都跳过 sendfile
- 要恢复 sendfile，需要重启 JVM
- 这是有意为之——避免每次 transferTo 都尝试 sendfile 然后失败

##### 10. 每层 fallback 为何存在 — 设计哲学

```
Layer 1: transferToDirectly (sendfile64)
  为何存在: 这是最优路径 — 0 次 CPU copy + 1 次 syscall
  失败场景: EINVAL (fd pair 不支持) / 目标不是 Socket/File/Pipe
  降级后: transferSupported=false — 永久跳过此路径

Layer 2: transferToTrustedChannel (mmap + write)
  为何存在: 1 次 CPU copy 的中间路径 — 比传统快，比 sendfile 慢
  失败场景: 目标不是 TrustedChannel (FileChannelImpl 或 SelChImpl)
  优点: 可以在任何可写的 fd 上工作（不限于 socket）
  代价: 8MB chunk 的 map/unmap + write 共 2 次 syscall per chunk

Layer 3: transferToArbitraryChannel (heap byte[] read/write)
  为何存在: 保底路径 — 永远可用
  优点: 任何 WritableByteChannel 都支持（包括自定义实现）
  代价: 2 次 CPU copy + 2 次 syscall per chunk — 最慢
```

**反事实思考**：
- 如果只有 Layer 1：EINVAL 时直接 IOException → Kafka broker 崩溃 → 集群不可用
- 如果只有 Layer 2+3 没有 Layer 1：1GB/s 的性能永远达不到 → 浪费硬件
- 如果只有 Layer 3：任何文件传输场景都是 read/write → 10Gbps 网卡浪费 80% 性能

三层 fallback 本质是**性能可用性的连续性保障**：在最好的情况下获得零拷贝性能，在最坏的情况下仍然能工作。

##### 11. sendfile vs mmap+write 性能对比

以 10GB 文件传输为例：

```
sendfile64 路径:
  syscall 次数: 1 (sendfile64 一次传输全部)
  CPU copy: 0
  context switch: 1
  理论吞吐量: ~1.2 GB/s (10Gbps 网卡)

mmap+write 路径:
  syscall 次数: 10GB / 8MB × 2 = 2560 (map+write 各 1280)
  CPU copy: 1280 (每次 8MB)
  context switch: 2560
  理论吞吐量: ~200 MB/s (受 CPU memcpy 带宽限制)

read/write 路径:
  syscall 次数: 10GB / 8KB × 2 = 2,621,440 (read+write 各 ~1310720)
  CPU copy: 2,621,440 (每次 8KB)
  context switch: 2,621,440
  理论吞吐量: ~80 MB/s (syscall 开销占主导)
```

**验证命令**：
```bash
# 生产环境用 strace 确认实际走的是哪条路径
strace -c -e trace=sendfile64,mmap,writev,read,write -p $(pgrep -f kafka) 2>&1
# sendfile64: 0 calls → 已降级
# mmap+writev: 2560 calls → Layer 2
```

#### C. mmap fallback 深入

##### 12. map0 的完整内核路径

```c
// FileChannelImpl.c:73-111
JNIEXPORT jlong JNICALL
Java_sun_nio_ch_FileChannelImpl_map0(JNIEnv *env, jobject this,
                                     jint prot, jlong off, jlong len)
{
    // ...
    void *mapAddress = mmap64(
        0,                    // addr = 0: 让内核选择映射地址
        len,                  // 映射长度
        protections,          // PROT_READ 或 PROT_READ|PROT_WRITE
        MAP_SHARED,           // 共享映射 → 对文件的修改可见
        fd,                   // 文件描述符
        off);                 // 文件内偏移
    // ...
}
```

`mmap64` 在内核中的处理流程：

```
用户态: mmap64(0, 8MB, PROT_READ, MAP_SHARED, fd, 0)
  → 内核: sys_mmap_pgoff(addr, len, prot, flags, fd, pgoff)
    → do_mmap(file, addr, len, prot, flags, pgoff)
      → get_unmapped_area()           // 在虚拟地址空间中找空闲区域
      → mmap_region(file, addr, len, vm_flags, pgoff)
        → 创建 VMA (vm_area_struct)    // 虚拟内存区域描述符
          vma->vm_file = file          // 关联文件
          vma->vm_pgoff = pgoff        // 文件内偏移
          vma->vm_ops = &file_mmap_ops // 设置缺页处理函数
        → 插入进程的 VMA 红黑树       // 地址空间管理
```

**Lazy load 机制**：mmap 返回时**不加载任何数据到物理内存**。只有在后续访问时（如 `write(fd, mmap_addr, len)` 的 copy_from_user），才触发缺页中断：

```
访问 mmap_addr → 缺页中断 (page fault)
  → do_page_fault()
    → handle_mm_fault()
      → filemap_fault()           // file-backed page fault
        → find_get_page()         // 在 page cache 中找
          → 如果不在 cache → readpage()  // 从磁盘加载
        → 将物理页面映射到用户页表
  → 返回用户态，继续执行
```

##### 13. 为什么选择 8MB 的 MAPPED_TRANSFER_SIZE？

```java
// FileChannelImpl.java:571
private static final long MAPPED_TRANSFER_SIZE = 8L*1024L*1024L;  // 8MB
```

这个数值的选择基于以下工程权衡：

**1. 32-bit JVM 虚拟地址空间约束**：
- 32-bit 进程虚拟地址空间 ~3GB（用户态部分）
- 频繁的 map/unmap 会造成地址空间碎片（即使 munmap 释放了虚拟地址）
- 8MB chunk 不长期驻留 → 碎片风险低
- 对比 1GB chunk：映射 1GB 后再 munmap → 留下 1GB 空洞 → 后续分配可能失败

**2. TLB（Translation Lookaside Buffer）友好性**：
- 8MB = 2048 个 4KB 页
- x86_64 TLB: L1 有 64 entries (4KB pages) + 32 entries (2MB huge pages)
- 8MB 如果用透明大页（2MB），只需 4 个 TLB entries → 极低 TLB miss
- 如果用 4KB 页，需要 2048 个 entries → 中等 TLB miss 开销

**3. Linux 预读（readahead）友好性**：
- Linux 默认预读窗口约 128KB-512KB
- 8MB 可以触发多次预读 → 下一个 chunk 的页面可能已在 page cache 中
- 对比 64KB chunk：预读窗口可能只有 1 次 → 更高的 page cache miss

**4. 内存压力平衡**：
- 即使在 1GB RAM 的机器上，8MB 映射不会触发 OOM Killer
- 对比 64MB chunk：在低内存系统上可能触发内存回收

**5. 32-bit 下的极端情况**：
- 如果 5 个线程同时执行 transferToTrustedChannel → 5 × 8MB = 40MB 映射
- 如果使用 64MB chunk → 5 × 64MB = 320MB → 在 32-bit JVM 中压力更大

##### 14. 为什么 mmap 后必须 munmap？

```c
// FileChannelImpl.c:114-122
JNIEXPORT jint JNICALL
Java_sun_nio_ch_FileChannelImpl_unmap0(JNIEnv *env, jobject this,
                                       jlong address, jlong len)
{
    void *a = (void *)jlong_to_ptr(address);
    return handle(env, munmap(a, (size_t)len), "Unmap failed");
}
```

`munmap` 在内核中做什么：
1. **释放虚拟地址空间**：从进程的 VMA 红黑树中删除该区域 → 虚拟地址可被后续分配重用
2. **解除页表映射**：清除页表中对应的 PTE → 访问该地址会触发段错误（SIGSEGV）
3. **回收物理页面**：如果页面是 file-backed（MAP_SHARED）且 clean → 直接放回 page cache；如果是 dirty → 先写回磁盘
4. **更新引用计数**：`struct file *` 的引用计数减 1 → 如果为 0 则关闭文件

**不显式 munmap 的后果**：

```
MappedByteBuffer 在 transferToTrustedChannel 中:
  创建 → 使用 → 返回给调用方（但调用方可能持有引用）
  GC → Cleaner → unmapper.run() → unmap0() → munmap()
```

问题在于 GC 的不确定性：
- 如果 `transferToTrustedChannel` 在循环中调用 1000 次 → 创建 1000 个 MappedByteBuffer
- GC 可能在 1000 次之后才触发 → 在此期间 1000 × 8MB = 8GB 虚拟地址被占用
- 64-bit JVM 可以承受（虚拟地址空间足够大），但 32-bit JVM 会在 ~400 次后虚拟地址耗尽

**Java 的显式 unmap 方案**：
```java
// transferToTrustedChannel 中的 try-finally 模式
try {
    MappedByteBuffer dbb = map(MapMode.READ_ONLY, position, size);
    try {
        int n = target.write(dbb);
    } finally {
        unmap(dbb);  // 立即 munmap — 不等待 GC
    }
} catch (IOException ioe) { ... }
```

##### 15. MappedByteBuffer 的自动释放 — Cleaner 机制

Java 没有显式的 unmap API（`FileChannel.map()` 返回的 `MappedByteBuffer` 无法主动释放），释放完全依赖 Cleaner：

```
MappedByteBuffer 的生命周期:
  1. FileChannel.map() → new DirectByteBufferR(addr, cap) → 创建 Unmapper (PhantomReference)
  2. CleanerFactory.cleaner().register(this, unmapper)    // 注册到 Cleaner 队列
  3. MappedByteBuffer 变成 unreachable → GC
  4. GC 发现 PhantomReference → 加入 ReferenceQueue
  5. ReferenceHandler 线程处理 → Cleaner.clean()
  6. Unmapper.run() → unmap0(address, size) → munmap()
```

**为什么计入 MaxDirectMemorySize 配额？**

```java
// Bits.java:185
private static boolean tryReserveMemory(long size, int cap) {
    // CAS 循环检查: totalCap + size <= MAX_MEMORY
    long totalCap;
    while (cap <= MAX_MEMORY - (totalCap = totalCapacity.get())) {
        if (totalCapacity.compareAndSet(totalCap, totalCap + cap)) {
            reservedMemory.addAndGet(size);
            return true;
        }
    }
    return false;
}
```

mmap 内存计入 MaxDirectMemorySize → 防止无限 mmap 导致系统 OOM。如果超出限制：
- 触发 `System.gc()` 尝试回收 unreachable 的 MappedByteBuffer
- 如果仍不足 → `OutOfMemoryError: Direct buffer memory`

##### 16. mmap vs sendfile 的性能基准测试

```java
// 伪基准测试代码
FileChannel fc = FileChannel.open(Paths.get("/data/10gb.bin"));
SocketChannel sc = SocketChannel.open(new InetSocketAddress("localhost", 9999));

// 场景 1: sendfile (最优)
long start = System.nanoTime();
fc.transferTo(0, 10_737_418_240L, sc); // 10GB
long elapsed = System.nanoTime() - start;
// 结果: ~8.5s → ~1.2 GB/s (10Gbps 网卡接近饱和)

// 场景 2: mmap + write (中间)
long start = System.nanoTime();
// transferToTrustedChannel 内部循环 map+write 8MB chunks
fc.transferTo(0, 10_737_418_240L, target); // 降级到 Layer 2
long elapsed = System.nanoTime() - start;
// 结果: ~50s → ~200 MB/s (CPU memcpy 带宽受限)

// 场景 3: read + write (最慢)
long start = System.nanoTime();
ByteBuffer buf = ByteBuffer.allocate(8192);
while (fc.read(buf) > 0) { buf.flip(); sc.write(buf); buf.clear(); }
long elapsed = System.nanoTime() - start;
// 结果: ~130s → ~80 MB/s (syscall 开销主导)
```

**关键洞察**：sendfile 不只是在"传输数据"——它通过消除 CPU copy 将 CPU 从数据传输中**彻底解放**。在 10Gbps 网卡上，CPU memcpy 是绝对瓶颈：memcpy 速度约 5-8 GB/s（取决于 CPU），而 sendfile 的 DMA 速度由硬件决定（~1.2 GB/s 是 10Gbps 线速）。

#### D. sendfile 的 EINTR 和信号中断处理

##### 17. EINTR 的完整处理逻辑

```c
// FileChannelImpl.c:165-166
if (errno == EINTR) {
    return IOS_INTERRUPTED;  // -3
}
```

Java 层的处理：
```java
// FileChannelImpl.java:485-520
do {
    n = transferTo0(fd, position, icount, targetFD);
} while ((n == IOStatus.INTERRUPTED) && isOpen());
// 循环直到: 成功 / 非 EINTR 错误 / Channel 关闭
```

**EINTR 场景**：
- JVM 收到 SIGALRM（定时器）、SIGCHLD（子进程）、SIGIO（I/O）等信号
- 内核中断 sendfile64 的执行 → 返回 -1 + EINTR
- Java 收到 IOS_INTERRUPTED → while 循环重试 → sendfile64 从上次的 offset 继续

**为什么不直接用 SA_RESTART？**
- Java 在 native 代码中不控制信号处理——信号处理在 JVM 初始化时设定
- 不是所有系统调用都支持 SA_RESTART（sendfile 在某些平台上不支持）
- 显式 EINTR 循环是最可靠的处理方式

#### E. sendfile 的限制与边界

##### 18. sendfile 不能做什么

**不能加密**：sendfile 走内核路径 → 无法在传输前对数据加密（TLS/SSL）。这就是为什么 nginx 的 `sendfile on` 和 SSL 模块不能同时使用——需要先 read 到用户态、加密、再 write。

**不能压缩**：类似地，需要先 read 到用户态进行压缩（gzip/zstd）。

**不能做应用层协议**：HTTP chunked encoding 需要应用层知道数据边界——sendfile 只传输连续的字节范围。

**不能部分修改**：sendfile 传输的是文件内容的完整字节。如果需要在传输前修改某些字节（如 HTTP 响应头），需要 read/write 或 mmap。

**Java 的限制**：
- `transferTo` 的 count 参数被截断为 `int`（`Integer.MAX_VALUE` = 2GB）— FileChannelImpl.java:660
- 单次 transferTo 最多传输 2GB — 超过需要循环
- transferTo 不支持 offset+length 在 2GB 以上范围 — 虽然底层 sendfile64 支持 64-bit offset

---

#### sendfile64 为什么能做到零拷贝？

这归结到 Linux 内核的架构选择：**`splice()`** 系统调用是内核态的"管道"——它不需要经过用户空间就可以在内核的两个 file descriptor 之间传输数据。sendfile64 是 splice 之上的一层优化——它语义更特殊（必须 in_fd 是普通文件，out_fd 是 socket），所以可以做更激进的优化：用 **DMA gather** 直接从 page cache 复制数据到 socket buffer，完全不经过 CPU。

```
传统 read()+write() 路径 (4次拷贝, 2次context switch):
  Disk → DMA → page cache → CPU copy_to_user → user buffer → CPU copy_from_user → socket buffer → DMA → NIC
  共: 2次DMA + 2次CPU copy = 4次拷贝, 2次 context switch

sendfile64 路径 (2次拷贝, 1次context switch):
  Disk → DMA → page cache → DMA gather → socket buffer → DMA → NIC
  共: 2次DMA + 0次CPU copy = 2次拷贝, 1次 context switch
```

**这不是"快了两倍"——是完全消除了 CPU 参与数据传输。** 对于 10Gbps 网卡，CPU copy 是绝对瓶颈——sendfile 将 CPU 从数据传输中彻底解放。

**为什么 in_fd 必须是普通文件？** 因为 sendfile 依赖 page cache 作为中间层——socket 和 pipe 没有 page cache 映射，所以不能做 in_fd。这是 sendfile 的核心限制。

#### Native 源码：FileChannelImpl.c transferTo0

```c
// FileChannelImpl.c:124-246
JNIEXPORT jlong JNICALL
Java_sun_nio_ch_FileChannelImpl_transferTo0(JNIEnv *env, jobject this,
                                            jobject srcFDO, jlong position,
                                            jlong count, jobject dstFDO)
{
    jint srcFD = fdval(env, srcFDO);
    jint dstFD = fdval(env, dstFDO);

#if defined(__linux__)
    off64_t offset = (off64_t)position;
    jlong n = sendfile64(dstFD, srcFD, &offset, (size_t)count);
    if (n < 0) {
        if (errno == EAGAIN)
            return IOS_UNAVAILABLE;          // -2: socket buffer full, retry
        if ((errno == EINVAL) && ((ssize_t)count >= 0))
            return IOS_UNSUPPORTED_CASE;     // -4: kernel doesn't support this fd pair
        if (errno == EINTR) {
            return IOS_INTERRUPTED;          // -3: signal interrupted
        }
        JNU_ThrowIOExceptionWithLastError(env, "Transfer failed");
        return IOS_THROWN;                   // -5
    }
    return n;                                // >=0: bytes transferred
```

**关键设计点**：
- `sendfile64(dstFD, srcFD, &offset, count)` — **out_fd 在前，in_fd 在后**（与 `read/write` 顺序相反！）
- `&offset` 是 in/out 参数——sendfile64 内部更新 offset 为已传输位置
- `EAGAIN` → `IOS_UNAVAILABLE(-2)` → Java 循环 while(count>0) 重试
- `EINVAL + count>=0` → `IOS_UNSUPPORTED_CASE(-4)` → Java 降级到 mmap fallback
- **平台差异**: Linux→sendfile64, Solaris→sendfilev64, macOS→sendfile, AIX→send_file

#### Java 三层 Fallback 架构

```java
// FileChannelImpl.java:654-687
public long transferTo(long position, long count, WritableByteChannel target)
    throws IOException
{
    // ...
    int icount = (int)Math.min(count, Integer.MAX_VALUE);

    long n;

    // Layer 1: Direct transfer via sendfile64
    if ((n = transferToDirectly(position, icount, target)) >= 0)
        return n;

    // Layer 2: Mapped transfer (mmap+write), trusted channel types only
    if ((n = transferToTrustedChannel(position, icount, target)) >= 0)
        return n;

    // Layer 3: Slow path — heap buffer read()+write()
    return transferToArbitraryChannel(position, icount, target);
}
```

##### Layer 1: transferToDirectly — sendfile64 0次拷贝

```java
// FileChannelImpl.java:522-568
private long transferToDirectly(long position, int icount,
                                WritableByteChannel target) throws IOException
{
    if (!transferSupported)
        return IOStatus.UNSUPPORTED;          // 已探测不支持 → 跳过

    FileDescriptor targetFD = null;
    if (target instanceof FileChannelImpl) {
        if (!fileSupported)
            return IOStatus.UNSUPPORTED_CASE;  // sendfile 到文件不支持
        targetFD = ((FileChannelImpl)target).fd;
    } else if (target instanceof SelChImpl) {
        if ((target instanceof SinkChannelImpl) && !pipeSupported)
            return IOStatus.UNSUPPORTED_CASE;  // sendfile 到 pipe 不支持
        SelectableChannel sc = (SelectableChannel)target;
        if (!nd.canTransferToDirectly(sc))
            return IOStatus.UNSUPPORTED_CASE;
        targetFD = ((SelChImpl)target).getFD();
    }

    // ...
    return transferToDirectlyInternal(position, icount, target, targetFD);
}
```

```java
// FileChannelImpl.java:485-520
private long transferToDirectlyInternal(...) {
    // ...
    do {
        n = transferTo0(fd, position, icount, targetFD);  // → sendfile64
    } while ((n == IOStatus.INTERRUPTED) && isOpen());

    if (n == IOStatus.UNSUPPORTED_CASE) {
        if (target instanceof SinkChannelImpl)
            pipeSupported = false;           // 缓存: pipe 不支持
        if (target instanceof FileChannelImpl)
            fileSupported = false;           // 缓存: file 不支持
        return IOStatus.UNSUPPORTED_CASE;
    }
    if (n == IOStatus.UNSUPPORTED) {
        transferSupported = false;           // 缓存: sendfile 完全不可用
        return IOStatus.UNSUPPORTED;
    }
    return IOStatus.normalize(n);
}
```

##### Layer 2: transferToTrustedChannel — mmap+write 1次内核拷贝

```java
// FileChannelImpl.java:570-619
private static final long MAPPED_TRANSFER_SIZE = 8L*1024L*1024L;  // 8MB chunks

private long transferToTrustedChannel(long position, long count,
                                      WritableByteChannel target) throws IOException
{
    boolean isSelChImpl = (target instanceof SelChImpl);
    if (!((target instanceof FileChannelImpl) || isSelChImpl))
        return IOStatus.UNSUPPORTED;

    long remaining = count;
    while (remaining > 0L) {
        long size = Math.min(remaining, MAPPED_TRANSFER_SIZE);
        try {
            MappedByteBuffer dbb = map(MapMode.READ_ONLY, position, size);
            try {
                int n = target.write(dbb);        // write(fd, mmap_addr, len)
                assert n >= 0;
                remaining -= n;
                if (isSelChImpl) break;            // one attempt per select
                position += n;
            } finally {
                unmap(dbb);                        // munmap
            }
        } catch (IOException ioe) {
            if (remaining == count) throw ioe;     // zero progress → fail
            break;
        }
    }
    return count - remaining;
}
```

**mmap fallback 数据路径**：

```
mmap64(fd, 0, 8MB, PROT_READ, MAP_SHARED, off) → 0x7f...
write(dstFD, 0x7f..., 8MB) → CPU copy_from_user: page cache → socket buffer
  # 比 sendfile64: 多1次CPU copy + 多1次 syscall
  # 比 read()+write(): 少1次CPU copy + 少1次 syscall
```

**为什么选择 8MB 的 MAPPED_TRANSFER_SIZE？**

1. **32-bit JVM 安全**: 虚拟地址空间 ~3GB → 8MB chunk 使用时间短 → 减少碎片风险
2. **TLB 友好**: 8MB = 2048 个 4KB 页 → 合理的 TLB miss 开销
3. **Linux 预读**: page cache 预读也偏向此大小
4. **系统内存**: 8MB 映射即使在低内存系统上也不会触发 OOM Killer

##### Layer 3: transferToArbitraryChannel — Heap Buffer 2次拷贝

```java
// FileChannelImpl.java:621-652
private long transferToArbitraryChannel(long position, int icount,
                                        WritableByteChannel target) throws IOException
{
    int c = Math.min(icount, TRANSFER_SIZE);
    ByteBuffer bb = ByteBuffer.allocate(c);           // Heap buffer
    long tw = 0;
    long pos = position;
    while (tw < icount) {
        bb.limit(Math.min((int)(icount - tw), TRANSFER_SIZE));
        int nr = read(bb, pos);                        // copy #1: page cache → heap
        if (nr <= 0) break;
        bb.flip();
        int nw = target.write(bb);                     // copy #2: heap → socket buffer
        tw += nw;
        if (nw != nr) break;
        pos += nw;
        bb.clear();
    }
    return tw;
}
```

**三层 fallback 对比**:

| Layer | 方法 | 拷贝 | Syscall | Chunk | 适用 |
|-------|------|:----:|:-------:|-------|------|
| 1 | sendfile64 | 0次CPU copy | 1 | 不限 | dst=Socket, 内核支持 |
| 2 | mmap+write | 1次CPU copy | 2 per 8MB | 8MB | dst=TrustedChannel |
| 3 | read+write heap | 2次CPU copy | 2 per chunk | TRANSFER_SIZE | dst=任意Channel |

#### Native mmap + unmap

```c
// FileChannelImpl.c:73-111 (map0 — mmap64)
JNIEXPORT jlong JNICALL
Java_sun_nio_ch_FileChannelImpl_map0(JNIEnv *env, jobject this,
                                     jint prot, jlong off, jlong len)
{
    void *mapAddress = mmap64(
        0,                    /* Let OS decide location */
        len,                  /* Number of bytes to map */
        protections,          /* PROT_READ or PROT_READ|PROT_WRITE */
        MAP_SHARED,           /* Changes shared with file */
        fd,                   /* File descriptor */
        off);                 /* Offset into file */

    if (mapAddress == MAP_FAILED) {
        if (errno == ENOMEM) {
            JNU_ThrowOutOfMemoryError(env, "Map failed");  // OOM on map overflow
            return IOS_THROWN;
        }
        return handle(env, -1, "Map failed");
    }
    return ((jlong) (unsigned long) mapAddress);            // Java long alias
}
```

```c
// FileChannelImpl.c:114-122 (unmap0 — munmap)
JNIEXPORT jint JNICALL
Java_sun_nio_ch_FileChannelImpl_unmap0(JNIEnv *env, jobject this,
                                       jlong address, jlong len)
{
    void *a = (void *)jlong_to_ptr(address);
    return handle(env, munmap(a, (size_t)len), "Unmap failed");
}
```

#### mmap 自动 unmap 机制 — Cleaner 释放

Java 没有显式 unmap API。释放流程:

```
MappedByteBuffer unreachable
  → Cleaner (PhantomReference)
    → Deallocator thread
      → unmapper.run()
        → unmap0(address, size)
          → munmap(ptr, size)
```

**为什么没有显式 unmap？** Java 安全模型:
1. try-with-resources 不可靠 → 忘记 → 泄漏
2. Cleaner 自动回收 → 垃圾回收时释放
3. 计入 MaxDirectMemorySize 配额 → 防止 OOM

#### Counterfactual: not having fallback layers

**场景**: sendfile64 EINVAL → Java 抛 IOException → Kafka broker 崩溃
**后果**: partition leader 切换 → 集群级故障 → 所有读写等待
**决策点**: FileChannelImpl.java:678-686 — 三层 fallback 是可用性保障，而不只是性能优化。

---

### 1.2 Reactor 多线程模型 (~2950 行)

#### A. lockAndDoSelect 并发语义深入

##### 19. 双层锁架构的完整分析

`lockAndDoSelect` 使用了**双层锁**设计（SelectorImpl.java:114-130）：

```java
private int lockAndDoSelect(Consumer<SelectionKey> action, long timeout)
    throws IOException
{
    synchronized (this) {                    // 外层锁: Selector 实例
        ensureOpen();
        if (inSelect)
            throw new IllegalStateException("select in progress");
        inSelect = true;                     // 防重入标志
        try {
            synchronized (publicSelectedKeys) {  // 内层锁: selectedKeys
                return doSelect(action, timeout);
            }
        } finally {
            inSelect = false;
        }
    }
}
```

**外层锁 `synchronized(this)` 保护什么？**

1. **register 和 select 的互斥**：`register()` 也需要 `synchronized(this)` — 确保 select 期间不能注册新 channel
2. **fdToKey HashMap 的完整性**：register 向 fdToKey 插入 (fd→key) 映射 → 如果 select 正在遍历 fdToKey → 并发修改异常
3. **inSelect 标志的原子性**：确保同一时刻只有一个线程在 select

**内层锁 `synchronized(publicSelectedKeys)` 保护什么？**

1. **selectedKeys 的并发安全**：`doSelect` 内部调用 `processEvents` → 修改 selectedKeys → 如果另一个线程在遍历 selectedKeys → 不一致
2. **JDK 文档明确说**：Selector 的 selected-key set 不是线程安全的 — 内层锁是这个限制的实现

**并发模型图**：

```
Thread A (Worker Event Loop):     Thread B (Boss Thread):
  selector.select()                  sc.register(worker, OP_READ)
    → lockAndDoSelect()                → AbstractSelectableChannel.register()
      → synchronized(this) {             → SelectorImpl.register()
          inSelect = true                    → synchronized(this) {  ← 阻塞!
          doSelect()              // 等待 Thread A 的 select 完成
            → epoll_wait()       // 如果 Thread A 在 epoll_wait 中 → Thread B 永远阻塞
          inSelect = false                  }  // 拿到锁后 → implRegister(key)
        }                                   → interestOps(OP_READ)
                                            → setEventOps(ski)
                                              → updateKeys.addLast(ski)
```

**关键陷阱**：如果 Thread A 在 `epoll_wait(timeout=-1)` 中 → Thread B 在 `synchronized(this)` 上阻塞 → **死锁**！因为 Thread A 在 epoll_wait 中持有锁，Thread B 需要拿到锁才能 register，而 Thread A 的 epoll_wait 永远不会返回（没有新的 fd 注册）。

**解决方案**：Thread B 在 register 之前调用 `selector.wakeup()`：
```java
workerSelector.wakeup();              // 强制 epoll_wait 返回 → 释放 synchronized(this)
sc.register(workerSelector, OP_READ); // 现在可以拿到锁
```

##### 20. inSelect 标志的防御作用

`inSelect` 标志防止同一 Selector 上的**重入 select**：

```java
// SelectorImpl.java:114-130
synchronized (this) {
    ensureOpen();
    if (inSelect)
        throw new IllegalStateException("select in progress");
    inSelect = true;
    try { ... doSelect(...) ... }
    finally { inSelect = false; }
}
```

**什么场景会触发重入？**

```
Thread A: selector.select() → lockAndDoSelect → inSelect=true → doSelect()
  → processEvents → 用户回调（如 Netty pipeline handler）
    → 用户代码中调用 selector.select() → 重入！
      → lockAndDoSelect → inSelect=true → IllegalStateException
```

**JDK 的防御**：抛出 `IllegalStateException` 而不是死锁或数据损坏。

##### 21. register 与 select 的完整互斥流程

```java
// SelectorImpl.java:199-230
protected final SelectionKey register(AbstractSelectableChannel ch,
                                       int ops, Object attachment)
{
    if (!(ch instanceof SelChImpl))
        throw new IllegalSelectorException();
    SelectionKeyImpl k = new SelectionKeyImpl((SelChImpl)ch, this);
    k.attach(attachment);

    synchronized (this) {                // ← 与 lockAndDoSelect 互斥
        implRegister(k);                 // EPollSelectorImpl: fdToKey.put(fd, k)
        keys.add(k);                     // 所有 key 的集合
    }
    return k;
}
```

`implRegister` 在 EPollSelectorImpl 中：

```java
// EPollSelectorImpl.java (implRegister 行号约 190-208)
protected void implRegister(SelectionKeyImpl ski) {
    SelChImpl ch = ski.channel;
    int fd = Integer.valueOf(ch.getFDVal());
    fdToKey.put(fd, ski);               // fd → SelectionKey 映射
    pollWrapper.add(fd);                // 添加到 pollArray
    keys.add(ski);                      // 所有注册的 key
}
```

**时序保证**：
- `synchronized(this)` 确保 register 在 select 前后执行，不在 select 期间
- 如果 select 正在执行 → register 阻塞 → 等待 select 完成
- 如果 select 在 register 之后 → 新 fd 已经注册 → select 可以检测到新 fd 的事件

##### 22. 跨 Selector 的无锁并发

不同 Selector 之间**完全没有锁竞争**：

```
Selector worker1: lockAndDoSelect → synchronized(worker1) → doSelect()
Selector worker2: lockAndDoSelect → synchronized(worker2) → doSelect()
Selector boss:    lockAndDoSelect → synchronized(boss)    → doSelect()
```

三个 synchronized 块在三个不同的对象上 → 完全并发。这是 Reactor 模型可以扩展到多核的关键——每个 Worker Selector 是独立的事件处理单元。

**CPU 亲和性优化**：每个 Worker Selector 绑定一个 CPU 核心 → 无锁 + 无 CPU 缓存失效 → 线性扩展。8 核 → 8 Worker → 理论 8x 吞吐量。

#### B. interestOps 变更 = updateKeys 延迟 — 完整的陷阱解析

##### 23. 从 interestOps() 到 epoll_ctl() 的完整调用链

```java
// 用户代码
key.interestOps(SelectionKey.OP_WRITE);  // 想要注册写事件

// 调用链:
SelectionKeyImpl.interestOps(int ops)       // SelectionKeyImpl.java:95
  → VarHandle CAS 更新 this.interestOps     // 原子更新
  → selector.setEventOps(this)              // SelectionKeyImpl.java:102
    → EPollSelectorImpl.setEventOps(ski)    // EPollSelectorImpl.java:242
      → synchronized(updateLock) {          // 独立锁，不阻塞 select
          updateKeys.addLast(ski);          // 只排队！
        }
      // 注意: 这里没有 epoll_ctl 调用！

// 真正生效:
Selector.select()                          // 下一次 select
  → lockAndDoSelect()
    → doSelect()
      → processUpdateQueue()                // EPollSelectorImpl.java:143
        → synchronized(updateLock) { ski = updateKeys.pollFirst(); }
        → 根据 ops 变化计算 epoll 操作:
          - 如果之前 ops=0, 现在 ops=OP_READ → EPoll.ctl(ADD, fd, EPOLLIN)
          - 如果之前 ops=OP_READ, 现在 ops=OP_WRITE → EPoll.ctl(MOD, fd, EPOLLOUT)
          - 如果之前 ops=OP_READ|OP_WRITE, 现在 ops=0 → EPoll.ctl(DEL, fd, 0)
```

##### 24. 为什么延迟注册？设计动机

**批量处理的性能优势**：

```
场景: 100 个 connection 同时想要注册 OP_WRITE
  立即 epoll_ctl: 100 次 syscall (每次 ~1μs) → 100μs
  延迟注册: 100 次 addLast (每次 ~50ns) + 1 次 processUpdateQueue (~50μs) → 55μs

性能提升: ~2x
```

**无锁优势**：`setEventOps` 使用独立的 `updateLock`（不是 Selector 的 `this` 锁）：
- select 在 epoll_wait 中时，其他线程可以自由修改 interestOps → 不阻塞
- interestOps 修改只在 `updateLock` 上同步 → 临界区极短（~100ns）

**设计权衡**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 立即 epoll_ctl | 事件立即生效 | 每次变更一次 syscall; 需要 synchronized(this) |
| 延迟批量 epoll_ctl | 批量减少 syscall; 解耦锁 | 事件不立即生效; 需要 wakeup |

JDK 选择了延迟批量——这是吞吐量优先的设计。

##### 25. Selector 的官方 API 约束

`Selector` Javadoc 明确说明：

> "Changes made to the interest sets of a selector's keys are not immediately propagated to the underlying operating system. They will only be reflected in the next selection operation. If the selector is currently blocked in a selection operation, invoking the selector's wakeup method will cause it to return immediately."

**这是设计约束，不是 bug。** JDK 清楚地记录了延迟注册的语义：
1. interestOps 变更在下次 select 时生效
2. 如果 select 正在阻塞 → 需要 wakeup 强制返回
3. 不调 wakeup → 变更永久不生效

##### 26. Netty NioEventLoop 如何封装此陷阱

```java
// Netty NioEventLoop 的简化模型
public final class NioEventLoop extends SingleThreadEventLoop {

    void select() throws IOException {
        Selector selector = this.selector;
        try {
            int selectedKeys = selector.select(timeoutMillis);  // 1. select
            processSelectedKeys(selectedKeys);                  // 2. 处理 I/O
            runAllTasks();                                      // 3. 执行任务
        } catch (...) { ... }
    }

    public void register(AbstractNioChannel ch) {
        if (inEventLoop()) {
            doRegister(ch);                    // 同线程: 直接注册
        } else {
            execute(() -> {                    // 跨线程: 提交任务
                doRegister(ch);
            });
            wakeup();                          // 总是调 wakeup!
        }
    }

    private boolean inEventLoop() {
        return Thread.currentThread() == this.thread;
    }
}
```

**Netty 的设计优势**：

1. **单线程事件循环**：select → process I/O → run tasks — 全部在一个线程中串行执行。不需要 `synchronized(this)`！
2. **inEventLoop() 检查**：register 来自外部线程 → 提交任务 → wakeup。Netty 不做假设——总是显式调 wakeup。
3. **task queue**：所有跨线程操作都提交到 task queue → event loop 在下一次循环中处理 → 自然与 select 同步。

**Netty vs JDK 对比**：

| 方面 | JDK Selector | Netty NioEventLoop |
|------|-------------|-------------------|
| 线程模型 | 多线程 (register 可跨线程) | 单线程 (event loop) |
| 同步 | synchronized(this) + updateLock | 无锁 (单线程保证) |
| interestOps | 延迟 (updateKeys) | 延迟 (task queue) |
| wakeup 要求 | 跨线程 register 必须调 | 跨线程 register 总是调 |
| 错误处理 | 忘了 wakeup → stuck | 自动 wakeup → 不会 stuck |

##### 27. 真实的 Reactor Stuck 案例

**症状**：
```
Worker Selector: select() stuck forever, no I/O processed
Boss Selector: 正常 accept 并 register 到 Worker
```

**根因**：
```java
// Boss 线程
SocketChannel sc = ssc.accept();
Selector worker = workers[idx++ % workers.length];
sc.register(worker, OP_READ);  // ← 忘了 worker.wakeup()!
// register 在 synchronized(worker) 中 → 如果 Worker 在 select() 中 → 阻塞
```

**时间线**：
```
T0: Worker: selector.select() → lockAndDoSelect → inSelect=true → epoll_wait(-1)
T1: Boss: sc.register(worker, OP_READ) → synchronized(worker) → 阻塞！
    (Worker 持有 worker 的 monitor 锁)
T2: ... 永久等待 ... 没有人 wakeup Worker
T3: Boss 继续 accept 新连接 → 再次尝试 register → 继续阻塞在 synchronized(worker)
T4: Boss 线程池耗尽 → 新连接无法 accept → 服务不可用
```

**修复**：
```java
worker.wakeup();                      // 在 register 之前!
sc.register(worker, OP_READ);
```

#### C. Selector 关闭的完整流程

##### 28. implCloseSelector 的完整步骤

```java
// SelectorImpl.java:177-190
public final void implCloseSelector() throws IOException {
    wakeup();                               // 1. 唤醒阻塞的 select
    synchronized (this) {                   // 2. 获取 Selector 锁
        implClose();                        // 3. 子类实现 (close fd + free memory)
        synchronized (publicSelectedKeys) {
            // 4. Deregister all keys (遍历所有注册的 key)
            Iterator<SelectionKey> it = keys.iterator();
            while (it.hasNext()) {
                SelectionKeyImpl ski = (SelectionKeyImpl)it.next();
                deregister(ski);           // fdToKey.remove + implDereg
                it.remove();
            }
        }
    }
}
```

EPollSelectorImpl 的 `implClose()`（EPollSelectorImpl.java:210-223）：

```java
protected void implClose() throws IOException {
    synchronized (interruptLock) {
        interruptTriggered = true;           // 阻止进一步的 wakeup
    }
    FileDispatcherImpl.closeIntFD(epfd);     // close(epoll_fd)
    EPoll.freePollArray(pollArrayAddress);   // free native pollArray
    FileDispatcherImpl.closeIntFD(fd0);      // close wakeup pipe read end
    FileDispatcherImpl.closeIntFD(fd1);      // close wakeup pipe write end
}
```

**步骤详解**：

1. **wakeup()**：强制正在 select 的线程从 epoll_wait 返回。如果不调 → select 线程可能阻塞到 timeout 或永远阻塞
2. **synchronized(this)**：确保没有其他线程在 register 或 select
3. **implClose()**：关闭 epoll fd → 所有正在 epoll_wait 的线程收到 EBADF 错误 → 退出
4. **遍历 deregister**：每个 key 的 implDereg 调用 `EPoll.ctl(DEL)` 从内核 epoll set 中移除
5. **释放资源**：free pollArray native 内存 + close wakeup pipe fd

##### 29. 关闭期间的安全性

**关闭期间 register**：
```java
protected final SelectionKey register(...) {
    ensureOpen();                    // ← 检查 isOpen
    // ...
    synchronized (this) {            // ← 如果 implCloseSelector 持有锁 → 阻塞
        implRegister(k);             // ← 如果 implCloseSelector 已释放锁 → 检查 isOpen
    }
}
```

`ensureOpen()` 检查 Selector 的 `isOpen` 字段 → 如果已关闭 → `ClosedSelectorException`。

**关闭期间 select**：
```java
private int lockAndDoSelect(...) {
    synchronized (this) {
        ensureOpen();                // ← ClosedSelectorException
        // ...
    }
}
```

**时序安全**：`wakeup()` 确保 select 线程先退出 → `synchronized(this)` 确保 implCloseSelector 独享锁 → 后续 register/select 都会看到 isOpen=false → ClosedSelectorException。

#### D. Netty NioEventLoop 的 Reactor 模型对比

##### 30. Netty 的单线程事件循环

Netty 的 `NioEventLoop` 实现了**单线程 Reactor**：

```java
public final class NioEventLoop extends SingleThreadEventLoop {
    // 核心循环
    @Override
    protected void run() {
        for (;;) {
            try {
                select(willBlock);           // select with strategy
            } catch (Throwable t) { ... }
            // ...
            processSelectedKeys();           // handle I/O
            // ...
            runAllTasks(ioTime * (100 - ioRatio) / ioRatio);  // run tasks
        }
    }
}
```

**关键设计**：

1. **单线程执行**：select → process I/O → run tasks — 串行，无锁。不需要 JDK 的 `synchronized(this)` 和 `inSelect` 标志。

2. **select 策略**：Netty 不简单调用 `selector.select()`，而是有自己的 `selectStrategy`：
   ```java
   // 默认策略
   if (hasTasks()) {
       selectNow();  // 有任务时非阻塞 select
   } else {
       select(timeout);  // 无任务时阻塞 select
   }
   ```

3. **epoll bug 防御**：Netty 有 epoll CPU spin 检测 —— 如果 select 在极短时间内返回 0 太多次 → 判定为 epoll bug → 切换到 poll。

##### 31. Boss/Worker 分离的 Netty 实现

**Boss EventLoopGroup**：
```java
// Boss EventLoop 只处理 OP_ACCEPT
EventLoopGroup bossGroup = new NioEventLoopGroup(1);
ServerBootstrap b = new ServerBootstrap();
b.group(bossGroup, workerGroup)
 .channel(NioServerSocketChannel.class)
 .childHandler(new ChannelInitializer<SocketChannel>() {
     @Override
     public void initChannel(SocketChannel ch) {
         ch.pipeline().addLast(new MyHandler());
     }
 });
```

Boss EventLoop 内部：
```
select() → OP_ACCEPT ready
  → processSelectedKeys()
    → unsafe.read()  // NioMessageUnsafe
      → doReadMessages()  // accept 循环
        → SocketChannel ch = javaChannel().accept()
        → NioSocketChannel nioCh = new NioSocketChannel(this, ch)
        → pipeline.fireChannelRead(nioCh)  // 触发 ServerBootstrapAcceptor
          → childGroup.register(nioCh)     // 注册到 Worker EventLoop
            → worker.execute(() -> worker.register(nioCh))
            → worker.wakeup()              // Netty 总是调 wakeup!
```

**Worker EventLoop**：
```
select() → OP_READ ready
  → processSelectedKeys()
    → unsafe.read()  // NioByteUnsafe
      → doReadBytes()  // 从 SocketChannel 读数据
        → ByteBuf byteBuf = allocHandle.allocate(allocator)
        → byteBuf.writeBytes(channel, byteBuf.writableBytes())
        → pipeline.fireChannelRead(byteBuf)  // 触发用户 Handler
```

##### 32. Netty 的 wakeup 机制

```java
// AbstractNioChannel.java
public void register(EventLoop eventLoop, ChannelPromise promise) {
    if (eventLoop.inEventLoop()) {
        register0(promise);      // 同线程: 直接注册
    } else {
        eventLoop.execute(() -> {
            register0(promise);  // 跨线程: 提交任务
        });
    }
}

// SingleThreadEventExecutor.java
public void execute(Runnable task) {
    boolean inEventLoop = inEventLoop();
    addTask(task);               // 添加到 task queue
    if (!inEventLoop) {
        startThread();           // 启动 event loop 线程（如果需要）
        // ...
    }
    if (!addTaskWakesUp && wakesUpForTask(task)) {
        wakeup(inEventLoop);     // 如果需要 → wakeup
    }
}
```

Netty 在 register 时的完整流程：
1. 检查调用线程 → 同线程直接注册
2. 跨线程 → 任务排队
3. 如果需要 wakeup → 调用 wakeup
4. Event loop 线程下一次循环 → 执行注册任务

**与 JDK 的对比**：

| 步骤 | JDK (手写 Reactor) | Netty NioEventLoop |
|------|-------------------|-------------------|
| register | `sc.register(worker, OP_READ)` | `worker.register(ch)` |
| 线程检查 | 无 | `inEventLoop()` |
| 任务排队 | 无（直接 register） | `execute(task)` |
| wakeup | 需要手动调用 | 自动（框架处理） |
| 生效时机 | 下次 select 的 processUpdateQueue | 下次 event loop 循环 |

---

#### 为什么 Boss/Worker 分离？

一个 Selector 线程可以管理 10000 个连接——但 `processEvents` 是串行的。如果 Boss 在同一 Selector 上同时处理 accept 和 I/O:

```
Boss 单线程 (accept + I/O):
  select() → 100 OP_READ ready + 3 OP_ACCEPT ready
    → processEvents 处理 100 OP_READ (5ms)
    → processEvents 处理 3 OP_ACCEPT (3μs)
    → select()
  在这 5ms 期间: accept queue 中有 ~50 个新连接等待 (10000 qps × 0.005s)
```

Boss/Worker 分离:
- Boss 只做 `accept()` (<1μs per accept) → 立即回到 `select()`
- Worker 只做 I/O → 不阻塞 Boss 的 accept throughput

```
Boss: accept only
  select() → 3 OP_ACCEPT ready
    → accept() × 3 → register each to worker → worker.wakeup()
    → select()

Worker: I/O only
  select() → 100 OP_READ ready
    → processEvents → 100 reads → 100 writes
    → select()
```

#### lockAndDoSelect — Selector 并发控制

```java
// SelectorImpl.java:114-130
private int lockAndDoSelect(Consumer<SelectionKey> action, long timeout)
    throws IOException
{
    synchronized (this) {                    // 每个 Selector 一把锁
        ensureOpen();
        if (inSelect)
            throw new IllegalStateException("select in progress");
        inSelect = true;                     // 防重入标志
        try {
            synchronized (publicSelectedKeys) {
                return doSelect(action, timeout);
            }
        } finally {
            inSelect = false;
        }
    }
}
```

**并发保护机制**:

```
不同 Worker Selector → 互相独立 (不同的 this monitor)
同一 Selector 上:
  register() → synchronized(this) → implRegister(key)
  select()   → synchronized(this) → doSelect()
  两者互斥 → 不可能在 select 进行中注册
```

`inSelect` 标志:
- `doSelect()` 开始时设为 true
- `doSelect()` 结束时设为 false
- 如果 register() 在另一个线程中拿到锁并发现自己也进入了 select → 拒绝

#### interestOps 变更不调 wakeup 陷阱

**这是 Reactor 模型中最常见的 bug**:

```java
// Boss 线程
SocketChannel sc = ssc.accept();
Selector worker = workers[idx++ % workers.length];
// 问题: Worker 正在阻塞在 select() 中!
sc.register(worker, OP_READ);   // setEventOps → updateKeys.addLast(ski)
// register 结束，但 interestOps 只排队了——不会立即生效
```

`setEventOps` 只入队而不立即 epoll_ctl:

```java
// EPollSelectorImpl.java:242-247
public void setEventOps(SelectionKeyImpl ski) {
    ensureOpen();
    synchronized (updateLock) {
        updateKeys.addLast(ski);        // ← 只排队！
    }
}
```

**有效的 sequence**:
- `setEventOps(ski)` → `updateKeys.addLast(ski)` ✓
- 下次 `select()` 中 `processUpdateQueue()` → `epoll_ctl(ADD, fd, EPOLLIN)` ✓
- 但如果 Worker 正在 `select()` 中 → 永不回到 `processUpdateQueue` → 新 channel 永不注册!

**解决方案**:

```java
// 正确: register 前先 wakeup
Selector worker = workers[idx++ % workers.length];
worker.wakeup();                          // ← 强制 select() 返回
sc.register(worker, OP_READ);             // ← 排在 updateKeys 中
// 下次 select() 时 processUpdateQueue 会处理新注册
```

```java
// Selector.java API doc 明确指出:
// "Changes to interest set will only be reflected in the next selection operation.
//  If the selector is currently blocked, invoking wakeup() will cause it to
//  return immediately."
```

#### Netty 如何避免此陷阱？

```java
// NioEventLoop.java 简化
public void register(AbstractNioChannel ch) {
    if (inEventLoop()) {
        doRegister(ch);                     // 同线程 → 直接注册
    } else {
        execute(() -> {
            doRegister(ch);                 // 不同线程 → 提交 task → wakeup
        });
        wakeup();                           // ← NETTY 总是调 wakeup!
    }
}
```

Netty 的 `inEventLoop()` 检查保证: 如果 register 调用来自外部线程 → task 排队 + wakeup。Netty 内部不做假设——总是显式调用 wakeup。

#### Selector close 流程

```java
// SelectorImpl.java:177-190
public final void implCloseSelector() throws IOException {
    wakeup();                               // 唤醒 select 线程
    synchronized (this) {                   // 对 Selector 互斥
        implClose();                        // 子类实现 (close fd + free memory)
        synchronized (publicSelectedKeys) {
            // Deregister all keys
        }
    }
}
```

EPollSelectorImpl 的 `implClose()`:

```java
// EPollSelectorImpl.java:210-223
protected void implClose() throws IOException {
    synchronized (interruptLock) {
        interruptTriggered = true;           // 阻止进一步 wakeup
    }
    FileDispatcherImpl.closeIntFD(epfd);     // close epoll fd
    EPoll.freePollArray(pollArrayAddress);   // free native memory
    FileDispatcherImpl.closeIntFD(fd0);      // close wakeup pipe read
    FileDispatcherImpl.closeIntFD(fd1);      // close wakeup pipe write
}
```

#### Counterfactual: 单线程 Reactor

```
单线程处理 accept + I/O:
  select() → 500 OP_READ + 5 OP_ACCEPT
    → 处理 500 reads + 处理 5 accepts
    → select()
  Accept 延迟: 500 reads × 50μs = 25ms accept delay
```

**决策点**: Boss/Worker 分离不是"更快"——是"不相互阻塞"。

---

### 1.3 epoll bug 诊断视角 (~400 行，引用 00 深度分析)

#### 为什么诊断工具链能发现这个 bug？

**正确行为**: Level-triggered epoll_wait 在阻塞模式下（timeout=-1）:
- 返回 >0 — fd 就绪
- 返回 -1 + EINTR — 信号中断
- 返回 0 — 超时 (timeout > 0)
- **永远不会正常返回 0 当 timeout=-1**

**Bug 签名**: `epoll_wait(5, [], 1024, -1) = 0` — 在阻塞模式下返回 0 是此内核 bug 的唯一签名。

```bash
# strace 检测
strace -e trace=epoll_wait -p $(pgrep -f java) 2>&1 | head -5
# epoll_wait(5, [], 1024, -1) = 0          ← 阻塞模式返回 0!
# epoll_wait(5, [], 1024, -1) = 0          ← 重复!
```

#### 为什么 RecycledSelector 触发？

因为 epoll instance 内的 fd 计数从 1→0 触发了 `ep_remove` 的 **最后一个 watched fd 路径**——这是内核 bug 的触发条件。

```
RecycledSelector 模式:
  1. register(fd1) → 1 fd in epoll
  2. deregister(fd1) → 0 fds in epoll → ep_remove() → BUG!
  3. register(fd2) → 1 fd in epoll
  4. deregister(fd2) → 0 fds in epoll → ep_remove() → BUG!
  ...
```

单次 register→use→deregister 不会触发——因为 epoll instance 中一直有 fd（其他已注册的 fd 计数 >0）。

#### 三步诊断

```bash
# 1. 确认 JDK 和内核版本边界
java -version  # JDK 6-8: affected; JDK 9+: fixed
uname -r       # Linux < 2.6.27: kernel bug present

# 2. strace 确认 epoll_wait 在 tight loop 中返回 0
strace -e trace=epoll_wait -p $(pgrep -f java) 2>&1 | head -20
# epoll_wait(5, [], 1024, -1) = 0  ← 重复出现，间隔 ~1μs

# 3. jcmd 确认线程正在 doSelect 中循环
jcmd $(pgrep -f java) Thread.print | grep -A10 "doSelect"
# 输出: 线程在 doSelect→processUpdateQueue→epollWait 之间反复切换，频率 >1000次/秒
```

#### 修复方案

| 方案 | 适用 | 说明 |
|------|------|------|
| 升级内核 | 通用 | Linux 2.6.27+ 已修复 |
| 升级 JDK 9+ | 通用 | EPollArrayWrapper 在 DEL 前清 pending events |
| poll 降级 | 旧内核+旧JDK | `-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider` |

**poll 降级原理**:
- 完全绕过 epoll → 使用 POSIX `poll()` 系统调用
- poll 无 ready-list bug (poll 不使用持久化事件跟踪)
- 代价: O(n) per select vs epoll O(1)
- 有 1024 fd 时: poll 每次 select 遍历所有 fd → ~1ms; epoll ~0.01ms

#### 与 EPOLLET 的关系

Edge-triggered epoll 不受此 bug 影响——因为 ET 下 fd 状态转换只在 not-ready→ready 时通知一次。已删除的 fd 没有新事件进入 ready-list → stale epitem 不会触发虚假唤醒。但 Java NIO 选择 LT 的简单性付出了此代价（完整分析在 00 文档）。

---

### 1.4 诊断工具链 (~1450 行)

#### A. strace 诊断思维

##### 33. 诊断思维框架：不是看 syscall，是看证据链

strace 的输出是一串系统调用——但诊断不是"看"这些调用，而是**从中提取因果链**：

```
观察 → 假设 → 验证 → 修复
  ↑___________________↓
  (如果验证失败，回到假设)
```

每一步 strace 输出的解读都需要回答三个问题：
1. **看什么**：这个 syscall 的什么特征有问题？
2. **为什么**：这个特征为什么代表问题？
3. **下一步**：确认后该做什么？

##### 34. sendfile 路径诊断 — 完整的证据链分析

**正常 sendfile 的证据链**：

```bash
$ strace -e trace=sendfile64 -p $(pgrep -f kafka) 2>&1 | head -5

sendfile64(10, 15, [0],           8388608) = 8388608   # (1)
sendfile64(10, 15, [8388608],     8388608) = 8388608   # (2)
sendfile64(10, 15, [16777216],    8388608) = 4194304   # (3)
```

**诊断解读**：

(1) `sendfile64(10, 15, [0], 8388608) = 8388608`
- 看什么：返回值 = 请求的字节数（8388608）
- 为什么：sendfile 一次传输了完整的 8MB chunk
- 下一步：确认后续 chunk 也成功 → 零拷贝工作正常

(2) `sendfile64(10, 15, [8388608], 8388608) = 8388608`
- 看什么：offset 从 [0] 前进到 [8388608] — sendfile 内部更新了 offset
- 为什么：Java 的 while 循环正在使用 sendfile 的内部 offset 追踪
- 下一步：检查是否所有 chunk 都使用相同的 dstFD=10 和 srcFD=15

(3) `sendfile64(10, 15, [16777216], 8388608) = 4194304`
- 看什么：返回值 4194304 < 请求的 8388608 — 部分写入
- 为什么：文件只剩 4MB → sendfile 返回实际传输的字节数
- 下一步：确认文件大小确实是 20MB（8MB+8MB+4MB）

**异常 sendfile — EINVAL 降级的证据链**：

```bash
$ strace -e trace=sendfile64,mmap,writev,munmap -p $(pgrep -f kafka) 2>&1 | head -15

sendfile64(10, 16, [0], 8388608)       = -1 EINVAL (Invalid argument)  # (1)
mmap(NULL, 8388608, PROT_READ, MAP_SHARED, 16, 0) = 0x7f1234000000    # (2)
writev(10, [{iov_base=0x7f1234000000, iov_len=8388608}], 1) = 8388608 # (3)
munmap(0x7f1234000000, 8388608)        = 0                             # (4)

sendfile64(10, 16, [8388608], 8388608) = -1 EINVAL (Invalid argument)  # (5)
mmap(NULL, 8388608, PROT_READ, MAP_SHARED, 16, 8388608) = 0x7f1234000000
writev(10, [{iov_base=0x7f1234000000, iov_len=8388608}], 1) = 8388608
munmap(0x7f1234000000, 8388608)        = 0
```

**诊断解读**：

(1) `sendfile64(10, 16, ...) = -1 EINVAL`
- 看什么：dstFD=10 是 socket，srcFD=16 是什么？EINVAL 说明 fd pair 不被支持
- 为什么：可能是管道 fd（16）不支持做 sendfile 的 in_fd
- 下一步：`ls -l /proc/{pid}/fd/16` 确认 fd 类型

(2) `mmap(NULL, 8388608, PROT_READ, MAP_SHARED, 16, 0) = 0x7f1234000000`
- 看什么：mmap 成功，返回虚拟地址
- 为什么：Java 自动降级到 Layer 2 (mmap+write)
- 下一步：确认 `transferSupported` 被设为 false（后续跳过 sendfile）

(3) `writev(10, [{iov_base=0x7f1234000000, iov_len=8388608}], 1) = 8388608`
- 看什么：writev 写入 socket，iov_base = mmap 返回的地址
- 为什么：这确认了 mmap 的地址被用于 writev — 1 次 CPU copy
- 下一步：计算吞吐量 = 8388608 / (syscall 开销 × 4 次 syscall per chunk)

(4) `munmap(0x7f1234000000, 8388608) = 0`
- 看什么：Java 显式 munmap — 不等待 GC
- 为什么：try-finally 中调用了 unmap(dbb)
- 下一步：确认没有内存泄漏（每次 mmap 都有对应的 munmap）

(5) 第二次 `sendfile64(...) = -1 EINVAL`
- 看什么：即使第一次失败了，第二次仍然尝试 sendfile
- 为什么：可能 Java 在检查 transferSupported 之前已经进入了循环？或者 transferSupported 还未被设为 false？
- **诊断发现**：检查 FileChannelImpl.java:485-520 — `transferToDirectlyInternal` 返回 UNSUPPORTED_CASE 后，`transferSupported` 不会被设为 false（只有 UNSUPPORTED 才触发）→ 第二次仍然尝试 sendfile！

##### 35. epoll 生命周期完整诊断

**epoll 创建的 strace 证据**：

```bash
$ strace -e trace=epoll_create1 -f -p $(pgrep -f java) 2>&1
epoll_create1(EPOLL_CLOEXEC) = 5        # 创建 epoll fd=5
```

**epoll_ctl 的 strace 证据 — 注册和修改**：

```bash
$ strace -e trace=epoll_ctl -p $(pgrep -f java) 2>&1

# 注册新 fd
epoll_ctl(5, EPOLL_CTL_ADD, 9, {events=EPOLLIN, data={u32=9, u64=9}}) = 0

# 修改事件
epoll_ctl(5, EPOLL_CTL_MOD, 9, {events=EPOLLIN|EPOLLOUT, data={u32=9, u64=9}}) = 0

# 删除 fd
epoll_ctl(5, EPOLL_CTL_DEL, 9, 0) = 0
```

**诊断解读**：
- `EPOLL_CTL_ADD`：新 SocketChannel 注册 → OP_READ 就绪
- `EPOLL_CTL_MOD`：interestOps 变更 → 可能是 connect 完成后添加 OP_WRITE
- `EPOLL_CTL_DEL`：channel.close() → 从 epoll set 中移除

**epoll_wait 诊断 — 正常 vs 异常**：

```bash
# 正常 (阻塞模式，等待 1 个事件):
epoll_wait(5, [{events=EPOLLIN, data={u32=9}}], 1024, -1) = 1
# ↑ 返回 1 个就绪 fd

# 正常 (阻塞模式，多个事件):
epoll_wait(5, [{events=EPOLLIN, data=...}, {events=EPOLLOUT, data=...}], 1024, -1) = 2

# 异常 — epoll bug 签名:
epoll_wait(5, [], 1024, -1) = 0        # ← 阻塞模式返回 0!
# 在 tight loop 中重复出现
```

**诊断思维**：正常时 `epoll_wait` 阻塞直到事件发生或超时。`timeout=-1` 表示无限等待。返回值 0 表示超时（但 timeout=-1 不可能超时）—— 这是内核 bug 的唯一签名。

##### 36. 非阻塞 connect 的 strace 证据

```bash
$ strace -e trace=connect,getsockopt -p $(pgrep -f java) 2>&1

# 步骤 1: 非阻塞 connect
connect(9, {sa_family=AF_INET6, sin6_port=htons(8080), ...}, 28) = -1 EINPROGRESS

# 步骤 2: 检查 connect 结果
getsockopt(9, SOL_SOCKET, SO_ERROR, [0], [4]) = 0  # error=0 → 连接成功
# 或
getsockopt(9, SOL_SOCKET, SO_ERROR, [111], [4]) = 0 # error=ECONNREFUSED → 连接被拒绝
```

**诊断解读**：
- `EINPROGRESS`：非阻塞 connect 的正常返回 → 连接在后台进行
- `SO_ERROR=0`：连接成功 → `finishConnect()` 返回 true
- `SO_ERROR=111` (ECONNREFUSED)：端口未监听 → `finishConnect()` 抛出异常

#### B. GDB 7 断点诊断

##### 37. 每个断点的诊断价值

**断点 1: sendfile64 调用 (FileChannelImpl.c:134)**

```
(gdb) break Java_sun_nio_ch_FileChannelImpl_transferTo0
(gdb) condition 1 dstFD!=srcFD
(gdb) commands 1
> silent
> printf "sendfile64(dst=%d, src=%d, offset=%lld, count=%zu)\n", dstFD, srcFD, *(off64_t*)$rdx, (size_t)$rcx
> continue
> end
```

**诊断价值**：
- 捕获每个 sendfile64 调用，输出参数
- 如果返回值 < 0 → 检查 errno → EAGAIN/EINVAL/EINTR
- 如果返回值 >= 0 但 < count → 部分写入 → 检查 socket 发送缓冲区

**断点 2: mmap fallback (FileChannelImpl.c:73)**

```
(gdb) break Java_sun_nio_ch_FileChannelImpl_map0
(gdb) commands 2
> silent
> printf "mmap64(len=%lld, prot=%d, fd=%d, off=%lld)\n", len, prot, fd, off
> continue
> end
```

**诊断价值**：
- 只有 sendfile 失败后才触发 → 确认降级发生
- 如果频繁触发 → sendfile 能力缓存未生效 → 检查 transferSupported
- len 通常为 8MB → 如果更小 → 可能是文件末尾

**断点 3: lockAndDoSelect (SelectorImpl.java:114)**

```
(gdb) break SelectorImpl.lockAndDoSelect
(gdb) commands 3
> silent
> printf "lockAndDoSelect this=%p inSelect=%d timeout=%lld\n", this, inSelect, timeout
> continue
> end
```

**诊断价值**：
- `inSelect=true` 时如果另一个线程尝试 select → IllegalStateException
- timeout=-1 (无限阻塞) → 可能永远不返回 → 检查是否有 wakeup 调用
- 如果同一个 Selector 上有多个线程 → 可能锁竞争

**断点 4: setEventOps 陷阱 (EPollSelectorImpl.java:242)**

```
(gdb) break EPollSelectorImpl.setEventOps
(gdb) commands 4
> silent
> printf "setEventOps ski=%p fd=%d oldOps=%d newOps=%d queueSize=%d\n",
         ski, ski.channel.getFDVal(), ski.interestOps, $(gdb)...
> continue
> end
```

**诊断价值**：
- **关键验证**：确认 setEventOps 只是入队，没有 epoll_ctl 调用
- queueSize 持续增长 → processUpdateQueue 没有被调用 → select stuck
- newOps=0 (取消所有事件) 但 updateKeys 中没有对应的 epoll_ctl(DEL) → fd 仍在 epoll set 中

**断点 5: dup2 trick (linux_close.c:275)**

```
(gdb) break closefd
(gdb) commands 5
> silent
> printf "closefd(fd1=%d, fd2=%d)\n", fd1, fd2
> continue
> end
```

**诊断价值**：
- fd1=-1: 正常 close（不是 dup2 trick）
- fd1>=0: dup2 trick 正在进行 → fd 正在被替换为 marker fd
- 如果 dup2 失败 → 检查 errno → 可能 fd 已关闭或无效

**断点 6: accept 新连接 (ServerSocketChannelImpl.c:77)**

```
(gdb) break Java_sun_nio_ch_ServerSocketChannelImpl_accept0
(gdb) commands 6
> silent
> printf "accept() → newfd=%d\n", newfd
> continue
> end
```

**诊断价值**：
- newfd=-1 + EMFILE → fd 耗尽 → 检查 ulimit
- newfd=-1 + EAGAIN → 非阻塞模式无可用连接
- newfd 快速递增 → 连接速率高 → 确认 Boss 线程的 accept 吞吐量

**断点 7: SO_ERROR 检查 (SocketChannelImpl.c:49)**

```
(gdb) break Java_sun_nio_ch_SocketChannelImpl_checkConnect
(gdb) commands 7
> silent
> printf "checkConnect fd=%d → SO_ERROR=%d\n", fd, error
> continue
> end
```

**诊断价值**：
- error=0: connect 成功
- error=111 (ECONNREFUSED): 端口无监听
- error=113 (EHOSTUNREACH): 主机不可达
- error=110 (ETIMEDOUT): 连接超时

#### C. /proc 文件系统诊断

##### 38. /proc/{pid}/fd/ — fd 泄漏诊断

```bash
# 1. 计数当前 fd 数量
ls /proc/$(pgrep -f java)/fd/ | wc -l

# 2. 分类 fd 类型
ls -l /proc/$(pgrep -f java)/fd/ | awk '{print $NF}' | sort | uniq -c | sort -rn
# 输出示例:
#   500 socket:[12345]     ← SocketChannel
#   300 anon_inode:[eventpoll] ← epoll fd (每个 Selector 一个)
#   200 pipe:[67890]       ← wakeup pipe
#    50 /data/topic-0/000000.log ← FileChannel
#     1 /dev/null
```

**诊断价值**：
- socket 数量接近 ulimit → EMFILE 风险
- anon_inode 数量 > Selector 数量 → epoll fd 泄漏
- pipe 数量 > Selector 数量 × 2 → wakeup pipe 泄漏

##### 39. /proc/{pid}/fdinfo/{epfd} — epoll 细节诊断

```bash
# 查看 epoll fd=5 监视的所有 fd
sudo cat /proc/$(pgrep -f java)/fdinfo/5

# 输出:
pos:    0
flags:  02000002
mnt_id: 15
tfd:    5 events: 7 data: 8     # fd=8, EPOLLIN|EPOLLOUT|EPOLLERR
tfd:    5 events: 1 data: 6     # fd=6, EPOLLIN (wakeup pipe)
tfd:    5 events: 1 data: 9     # fd=9, EPOLLIN (client connection)
tfd:    5 events: 4 data: 10    # fd=10, EPOLLOUT (connect 未完成!)
```

**诊断解读**：
- `events: 7` = EPOLLIN|EPOLLOUT|EPOLLERR (0x001|0x004|0x008 = 0x00d ≠ 7... 实际上是 EPOLLIN|EPOLLOUT|EPOLLRDHUP)
- `events: 4` = EPOLLOUT → fd=10 正在等待 connect 完成
- `events: 1` = EPOLLIN → fd=6 是 wakeup pipe 的读端

**诊断价值**：
- 确认每个 fd 注册的事件是否正确
- 发现"僵尸" epoll watches — fd 已关闭但仍在 epoll set 中
- 对比 Java 层 `fdToKey.size()` 和内核 epoll watches 数量 → 不一致说明有泄漏

##### 40. /proc/sys/net/ — 网络参数诊断

```bash
# 1. somaxconn — listen backlog 截断
cat /proc/sys/net/core/somaxconn
# 默认 128 — 如果 Java 调用 listen(fd, 1024) → 实际 backlog = min(1024, 128) = 128

# 2. tcp_max_syn_backlog — SYN 队列大小
cat /proc/sys/net/ipv4/tcp_max_syn_backlog
# 默认 512 — 半连接队列上限

# 3. tcp_syn_retries — SYN 重试次数
cat /proc/sys/net/ipv4/tcp_syn_retries
# 默认 6 — 总超时 ~127s (1+2+4+8+16+32+64)

# 4. tcp_fin_timeout — TIME_WAIT 持续时间
cat /proc/sys/net/ipv4/tcp_fin_timeout
# 默认 60 — TIME_WAIT 持续 60 秒

# 5. tcp_tw_reuse — TIME_WAIT 重用
cat /proc/sys/net/ipv4/tcp_tw_reuse
# 0: 不允许重用 → 大量 TIME_WAIT 时连接耗尽
# 1: 允许重用 → 客户端场景建议开启
```

**诊断场景**：

| 症状 | 检查 | 修复 |
|------|------|------|
| accept 慢，积压增长 | somaxconn < listen backlog | `sysctl -w net.core.somaxconn=4096` |
| 连接超时 127s | tcp_syn_retries=6 | `sysctl -w net.ipv4.tcp_syn_retries=3` |
| TIME_WAIT 过多 | tcp_tw_reuse=0 | `sysctl -w net.ipv4.tcp_tw_reuse=1` |
| 端口耗尽 | 本地端口范围小 | `sysctl -w net.ipv4.ip_local_port_range="1024 65535"` |

#### D. ss 和 jcmd 诊断

##### 41. ss — socket 状态诊断

```bash
# 1. 监听 socket 积压
ss -lnt | grep :8080
# State   Recv-Q Send-Q Local Address:Port
# LISTEN  50     128    0.0.0.0:8080
#         ↑       ↑
#    accept积压  backlog上限

# Recv-Q: 已完成握手但未被 accept 的连接数
# Recv-Q > 0: Boss 线程 accept 不够快 → 需要更多 Boss 线程或优化 accept 逻辑

# 2. TCP 连接状态分布
ss -ant state established '( sport = :8080 )' | wc -l    # 活跃连接
ss -ant state time-wait   '( sport = :8080 )' | wc -l    # TIME_WAIT 等待
ss -ant state syn-sent    '( dport = :8080 )' | wc -l    # 正在连接的客户端
ss -ant state close-wait  '( sport = :8080 )' | wc -l    # 等待应用层 close

# 3. 连接建立速率
watch -n1 'ss -ant state established "( sport = :8080 )" | wc -l'
# 每秒变化 → 连接建立/关闭速率
```

**诊断价值**：
- `Recv-Q > 0 且增长`: Boss 线程瓶颈 — accept 速度跟不上连接速度
- `TIME-WAIT 数量 > 1000`: 短连接场景 — 可能需要 SO_LINGER 优化
- `CLOSE-WAIT 增长`: 应用层未调用 close() — fd 泄漏

##### 42. jcmd — JVM 运行时诊断

```bash
# 1. 线程栈 — select stuck 检测
jcmd $(pgrep -f java) Thread.print | grep -A10 "selector.select"

# 正常 Worker:
#   "nioEventLoop-1-1" #12 prio=5 RUNNABLE
#     at sun.nio.ch.EPoll.wait(Native Method)
#     at sun.nio.ch.EPollSelectorImpl.doSelect(EPollSelectorImpl.java:120)
#     at sun.nio.ch.SelectorImpl.lockAndDoSelect(SelectorImpl.java:124)
#     at sun.nio.ch.SelectorImpl.select(SelectorImpl.java:141)
#     - locked <0x00000007c0001234> (a sun.nio.ch.EPollSelectorImpl)
#   ← RUNNABLE in EPoll.wait → 正常阻塞

# 异常 — epoll CPU spin:
#   "nioEventLoop-1-1" #12 prio=5 RUNNABLE
#     at sun.nio.ch.EPollSelectorImpl.processUpdateQueue(EPollSelectorImpl.java:143)
#     at sun.nio.ch.EPollSelectorImpl.doSelect(EPollSelectorImpl.java:118)
#     at sun.nio.ch.SelectorImpl.lockAndDoSelect(SelectorImpl.java:124)
#     at sun.nio.ch.SelectorImpl.select(SelectorImpl.java:141)
#   ← RUNNABLE in processUpdateQueue → CPU spin!

# 异常 — select stuck:
#   "nioEventLoop-1-1" #12 prio=5 WAITING
#     at sun.nio.ch.EPoll.wait(Native Method)
#     at sun.nio.ch.EPollSelectorImpl.doSelect(EPollSelectorImpl.java:120)
#   ← WAITING in EPoll.wait → 永远等待，因为没有 wakeup

# 2. Native Memory — DirectBuffer 泄漏
jcmd $(pgrep -f java) VM.native_memory summary

# 关注:
# - Other: DirectByteBuffer + MappedByteBuffer 的 native 内存
# - Thread: 线程栈的 native 内存
# - Internal: epoll fd + wakeup pipe 的 native 内存

# 3. SelectorProvider 确认
jcmd $(pgrep -f java) VM.system_properties | grep "Select"
# java.nio.channels.spi.SelectorProvider=sun.nio.ch.EPollSelectorProvider  ← epoll
# java.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider  ← poll 降级
```

##### 43. 综合诊断工作流

完整的 NIO 问题诊断工作流：

```
Step 1: 宏观检查
  jcmd Thread.print → 确认 Selector 线程状态
  ss -lnt → 确认 listen backlog 积压
  ls /proc/{pid}/fd/ | wc -l → 确认 fd 数量

Step 2: 定位具体问题
  strace -e epoll_wait → CPU spin 检测
  strace -e sendfile64 → sendfile fallback 检测
  strace -e connect,getsockopt → 非阻塞 connect 诊断

Step 3: 深入根因
  /proc/{pid}/fdinfo/{epfd} → epoll watches 细节
  jcmd VM.native_memory → 内存泄漏
  GDB 断点 → 运行时状态检查

Step 4: 修复验证
  修复后重新 strace → 确认问题消失
  jcmd Thread.print → 确认线程恢复正常
  ss → 确认连接状态正常
```

#### 精简诊断命令速查（详细分析见 A-D 节）

##### strace 一行命令

```bash
# sendfile 路径检查
strace -c -e trace=sendfile64,mmap,writev,munmap -p $(pgrep -f java) 2>&1

# epoll bug 检查
strace -e trace=epoll_wait -p $(pgrep -f java) 2>&1 | head -5

# 非阻塞 connect 检查
strace -e trace=connect,getsockopt -p $(pgrep -f java) 2>&1
```

##### GDB 7 断点速查

| # | 断点位置 | 查看 | 文件:行号 |
|---|---------|------|----------|
| 1 | `Java_sun_nio_ch_FileChannelImpl_transferTo0` | dstFD, srcFD, offset, count | FileChannelImpl.c:134 |
| 2 | `Java_sun_nio_ch_FileChannelImpl_map0` | len, prot, fd, off | FileChannelImpl.c:73 |
| 3 | `SelectorImpl.lockAndDoSelect` | this, inSelect, timeout | SelectorImpl.java:114 |
| 4 | `EPollSelectorImpl.setEventOps` | ski, fd, oldOps, newOps, queueSize | EPollSelectorImpl.java:242 |
| 5 | `closefd` | fd1, fd2 | linux_close.c:275 |
| 6 | `Java_sun_nio_ch_ServerSocketChannelImpl_accept0` | newfd | ServerSocketChannelImpl.c:77 |
| 7 | `Java_sun_nio_ch_SocketChannelImpl_checkConnect` | error (SO_ERROR) | SocketChannelImpl.c:49 |

##### /proc 速查

| 路径 | 作用 | 关键输出 |
|------|------|---------|
| `/proc/{pid}/fd/` | fd 计数 | `ls \| wc -l` vs ulimit |
| `/proc/{pid}/fdinfo/{epfd}` | epoll watches | `tfd:` 行 → 每个 watched fd 的事件 |
| `/proc/{pid}/limits` | 资源限制 | `Max open files` |
| `/proc/sys/net/core/somaxconn` | listen 截断 | backlog = min(arg, somaxconn) |
| `/proc/sys/net/ipv4/tcp_syn_retries` | connect 超时 | 重试次数 → 总超时 ~127s |

##### ss 速查

```bash
ss -lnt | grep :8080           # Recv-Q → accept 积压
ss -ant state time-wait | wc -l  # TIME_WAIT 数量
```

##### jcmd 速查

```bash
jcmd <pid> Thread.print | grep -A10 "selector.select"   # select stuck 检测
jcmd <pid> VM.native_memory summary | grep "Other"       # DirectBuffer 泄漏
jcmd <pid> VM.system_properties | grep "Select"          # SelectorProvider 确认
```

---

### 1.5 面试题集 12 题 (~1100 行)

#### Q1: epoll vs select — O(1) vs O(n) 的工程本质

**问题**: 为什么说 epoll 是 O(1) 而 select 是 O(n)？在 10000 个连接下有什么区别？

**源码依据**: `EPoll.java:116` — `epoll_wait(epfd, pollArrayAddress, numfds, timeout)` 只返回就绪的 fd 数量，不遍历所有 fd。`EPoll.c:83-110` — JNI 调用 `epoll_wait()`，返回的就绪事件数写入 pollArray。

**调用链**:
```
Java: EPoll.wait(timeout)                    // EPoll.java:116
  → JNI: Java_sun_nio_ch_EPoll_wait           // EPoll.c:83
    → epoll_wait(epfd, events, maxevents, timeout) // 内核
      → 从 rdllist (ready list) 直接取事件 → O(1)
  ← 返回就绪事件数 n
→ EPollSelectorImpl.processEvents(n)          // EPollSelectorImpl.java:120
  → 只遍历 n 个就绪 fd → O(ready)
```

对比 select:
```c
// select 内核实现 (fs/select.c)
for (int i = 0; i < nfds; i++) {        // ← O(n) 遍历
    if (FD_ISSET(i, &readfds)) {
        // 检查 fd i 是否有事件
    }
}
```

**10K fd benchmark**:
```
10000 个连接，其中 100 个有 I/O 事件:

epoll_wait:  ~100 个 epitem 检查 (rdllist) → ~10μs
select:      遍历 10000 个 fd → ~100μs (每个 fd ~10ns)

100 个就绪的 epoll 处理: ~100 次 epoll_wait → ~1ms (处理事件)
100 个就绪的 select 处理: ~100 次 select → ~10ms (遍历 fd)
```

**反事实**: 如果 Linux 只有 select → 10000 连接的服务器每次 select 要遍历 10000 个 fd → CPU 时间全花在遍历上 → 无法处理实际 I/O。

#### Q2: 非阻塞 connect — EINPROGRESS + SO_ERROR 两步验证

**问题**: 非阻塞 SocketChannel.connect() 的返回值 EINPROGRESS 是什么意思？如何确认连接是否成功？

**源码依据**: `Net.c:306-325` — `connect0` native 实现，319 行检查 `errno == EINPROGRESS`。`SocketChannelImpl.c:49-88` — `checkConnect` native 实现，76 行 `getsockopt(fd, SOL_SOCKET, SO_ERROR, ...)`。

**调用链**:
```
Java: SocketChannel.connect(addr)             // SocketChannelImpl.java
  → Net.connect(fd, remote, isa)              // Net.java
    → connect0(fd, remote, isa)               // Net.c:306
      → connect(fd, &sa, len)                 // 系统调用
        → 返回 -1 + EINPROGRESS (errno=115)    // Net.c:319
  ← Java: 连接未完成，返回 false

Java: SocketChannel.finishConnect()           // SocketChannelImpl.java
  → checkConnect(fd, true)                    // SocketChannelImpl.c:49
    → getsockopt(fd, SOL_SOCKET, SO_ERROR, &error)  // SocketChannelImpl.c:76
      → error = 0 → 连接成功
      → error = 111 (ECONNREFUSED) → 端口未监听
      → error = 113 (EHOSTUNREACH) → 主机不可达
```

**两步验证的原因**: TCP 三次握手在 connect() 返回 EINPROGRESS 后仍在后台进行。`getsockopt(SO_ERROR)` 检查三次握手的结果：
- 握手成功 → SO_ERROR=0 → finishConnect() 返回 true
- 握手失败 → SO_ERROR=错误码 → finishConnect() 抛出异常

**反事实**: 如果阻塞 connect 超时 75 秒 → 非阻塞 connect 可以在此期间处理其他连接的 I/O → 吞吐量提升 100x。

#### Q3: wakeup pipe vs 信号 — 为什么用 pipe？

**问题**: Java NIO Selector 为什么用 pipe 做 wakeup 而不是信号？

**源码依据**: `EPollSelectorImpl.java` — 构造函数中创建 wakeup pipe。`EPoll.java:112` — `epoll_create(256)` 返回 epoll fd。`EPollSelectorImpl.java:143` — `processUpdateQueue` 消费 updateKeys。

**为什么不用信号？**

1. **信号不可靠**: 信号不排队（标准信号）→ 快速连续 wakeup 可能丢失
2. **信号没有 payload**: pipe 可以传输数据（即使只有 1 字节）→ 信号只能通知"发生了某事"
3. **信号处理复杂**: 信号处理函数中能做的事情受限（async-signal-safe 函数列表很短）
4. **信号可能被阻塞**: 如果线程阻塞了信号 → wakeup 无效

**pipe 的优势**:
- 管道写入是可靠的 → 数据在 pipe buffer 中排队 → 不会丢失
- pipe 可以被 epoll 监视（和其他 fd 一样）→ 统一的事件模型
- 管道的读端清空后 → 再次写入会再次触发 EPOLLIN → 天然支持多次 wakeup

**反事实**: 如果用信号做 wakeup → 在信号处理函数中只能设置 volatile flag → select 线程需要轮询这个 flag → 回到 busy-wait → 违背事件驱动模型。

#### Q4: LT vs ET — Java 的选择 + Netty 的覆盖

**问题**: Java NIO 使用 Level-Triggered (LT) epoll。Edge-Triggered (ET) 有什么不同？Netty 为什么提供 ET 支持？

**源码依据**: `EPoll.c:69-80` — `epoll_ctl` 调用时不设置 EPOLLET 标志 → 默认 LT。`EPollSelectorImpl.java:120` — `processEvents` 处理就绪事件。

**LT vs ET 对比**:
```
LT (Level-Triggered):
  fd 有数据 → epoll_wait 每次返回 → 直到数据读完
  优点: 不会丢事件 → 读少了下次还会通知
  缺点: 可能触发不必要的唤醒 → CPU 开销

ET (Edge-Triggered):
  fd 从"无数据"变为"有数据" → epoll_wait 返回一次
  优点: 只在状态转换时通知 → 更低 CPU 开销
  缺点: 必须读直到 EAGAIN → 否则永远丢失事件
```

**Java 选择 LT 的原因**: LT 的容错性更高——如果应用层没有读完数据，epoll_wait 会再次返回。这简化了编程模型（不需要处理 EAGAIN 循环）。

**Netty 的 EpollEventLoop**: Netty 的 `EpollEventLoop`（不是 NioEventLoop）使用原生 epoll JNI 绑定 → 支持 ET 模式 → 比 JDK NIO 少约 30% 的 syscall。

**反事实**: 如果 Java 用 ET → 应用层必须 read 直到 EAGAIN → 忘记循环 → 数据丢失 → 更危险。

#### Q5: dup2 trick 三重防护 — lock/dup2/signal 每一步的必要性

**问题**: Java 的 close(fd) 为什么用 dup2 trick？三层防护各解决什么问题？

**源码依据**: `linux_close.c:275-350` — `closefd` 函数。297 行 `rv = dup2(fd1, fd2)`。

**三层防护**:

```
Layer 1: lock (pthread_mutex_lock)
  保护 fd 分配表不被并发修改
  问题: 如果另一个线程在 close 期间 alloc 了新 fd → 可能分配到相同的 fd 号 → close 了错误的 fd

Layer 2: dup2(fd, marker_fd)
  将正在关闭的 fd 替换为 marker_fd
  问题: 如果直接 close(fd) → 另一个线程的阻塞 read/write 不会醒来
  dup2 将 fd 替换为 marker → 原来的 fd 引用被解除 → 阻塞线程的 read/write 返回 EBADF

Layer 3: signal (pthread_kill)
  向阻塞在 fd 上的线程发送信号 → 确保线程醒来
  问题: 某些内核版本下 dup2 不唤醒阻塞的 I/O 线程 → 信号作为最后保障
```

**每一步的必要性**: 如果去掉任何一层 → close 可能永远不会完成（阻塞线程永久不醒来）。

**反事实**: 如果只用 close(fd) 不用 dup2 trick → 线程 A close(fd) 后，线程 B 的 read(fd) 仍在阻塞 → 线程 B 永远不会醒来 → 线程泄漏 + 资源泄漏。

#### Q6: DirectBuffer vs HeapBuffer — 内存布局本质差异

**问题**: DirectByteBuffer 和 HeapByteBuffer 的内存布局有什么本质区别？为什么 NIO 需要 DirectByteBuffer？

**源码依据**: `Bits.java:94` — `MAX_MEMORY = VM.maxDirectMemory()`。`Bits.java:185` — `tryReserveMemory` CAS 检查。

**内存布局差异**:
```
HeapByteBuffer:
  Java Heap → byte[] array → GC 管理
  read(Channel): JNI → GetByteArrayElements → 临时 native buffer → copy → kernel
  write(Channel): kernel → 临时 native buffer → SetByteArrayRelease → copy → heap

DirectByteBuffer:
  Native Memory (C heap, malloc) → 不在 GC 堆中
  read(Channel): JNI → GetDirectBufferAddress → 直接传地址给 read() → 0 copy
  write(Channel): JNI → GetDirectBufferAddress → 直接传地址给 write() → 0 copy
```

**为什么 NIO 需要 DirectByteBuffer?**
- JNI `GetByteArrayElements` 可能复制整个 byte[] → 对于 8KB buffer 开销小，但对于 1MB buffer 开销巨大
- DirectByteBuffer 的地址在 native 内存中固定 → JNI 可以直接使用
- `read/write` 系统调用需要 native 指针 → DirectByteBuffer 无需临时 copy

**代价**:
- DirectByteBuffer 分配/释放比 HeapByteBuffer 慢 ~10x（需要 malloc/free）
- 受 MaxDirectMemorySize 限制 → 超出则 OOM
- 依赖 Cleaner/PhantomReference 释放 → GC 压力

**反事实**: 如果 NIO 只用 HeapByteBuffer → 每次 I/O 都要 JNI 临界区 + 可能 copy → 吞吐量下降 50%+。

#### Q7: sendfile vs mmap — 0 copy vs 1 copy 的内核路径对比

**问题**: sendfile64 和 mmap+write 的数据路径有什么本质区别？各有什么适用场景？

**源码依据**: `FileChannelImpl.c:134-135` — `sendfile64(dstFD, srcFD, &offset, count)`。`FileChannelImpl.c:73-111` — `mmap64(0, len, PROT_READ, MAP_SHARED, fd, off)`。

**内核路径对比**:
```
sendfile64:
  1. 内核: splice_file_to_pipe → page cache 页面引用 → 内核 pipe
  2. 内核: splice_pipe_to_socket → tcp_sendpage → skb 附加页面引用
  3. 硬件: DMA gather → NIC 发送
  拷贝: 0 CPU copy, 2 DMA transfer
  Syscall: 1

mmap+write:
  1. 内核: mmap64 → 创建 VMA → 延迟映射 (lazy load)
  2. 内核: write(fd, mmap_addr, 8MB) → copy_from_user → page cache → socket buffer
  3. 硬件: DMA → NIC 发送
  拷贝: 1 CPU copy, 2 DMA transfer
  Syscall: 2 per 8MB chunk (mmap+write)
```

**适用场景**:
| 场景 | 选择 | 原因 |
|------|------|------|
| 文件 → socket (Kafka) | sendfile | 0 CPU copy, 最优 |
| 文件 → 文件 (copy) | mmap+write | sendfile 不支持 file→file |
| 文件 → pipe | mmap+write | sendfile 不支持 pipe 做 out_fd |
| 需要修改数据 (TLS) | mmap+write | sendfile 无法在传输前加密 |
| 大文件 (10GB+) | sendfile | 1 次 syscall vs 2560 次 |

**反事实**: 如果 Kafka 不用 sendfile → 每次消费都要 read→write → 2 次 CPU copy → 10Gbps 网卡下 CPU 成为瓶颈 → broker 吞吐量降 80%。

#### Q8: Kafka 为什么用 sendfile — 磁盘到 socket 全流程

**问题**: Kafka 的零拷贝是如何工作的？从 producer 写入到 consumer 读取的完整数据路径是什么？

**流程分析**:
```
Producer → Kafka Broker:
  Producer: SocketChannel.write(record)       // TCP send
  Broker: SocketChannel.read(DirectBuffer)    // TCP recv → DirectBuffer
  Broker: FileChannel.write(DirectBuffer)     // DirectBuffer → page cache (append to log)

Consumer ← Kafka Broker:
  Consumer: fetch request → offset=12345
  Broker: FileChannel.transferTo(12345, count, socketChannel) // ← 零拷贝!
    → sendfile64(socketFD, fileFD, &12345, count)
      → page cache → DMA gather → NIC → consumer
  Consumer: SocketChannel.read(buffer)        // TCP recv
```

**为什么 sendfile 有效？**
1. Producer 写入的数据已在 page cache 中（FileChannel.write 写入 page cache）
2. Consumer 读取时，数据仍在 page cache 中（未被换出）
3. sendfile 直接从 page cache 发送到 socket → 0 次 CPU copy
4. 端到端：producer 写入 (1 次 CPU copy) → sendfile (0 次) → consumer 读取 (1 次 CPU copy) = 总共 2 次 CPU copy

**反事实**: 如果 Kafka 用 read/write → consumer 读取时需要: file.read(heap) → socket.write(heap) → 额外的 2 次 CPU copy → 总共 4 次 → 吞吐量降 50%。

#### Q9: selector.select() 不返回的原因 — interestOps 忘 wakeup

**问题**: 线上服务中 Worker Selector 的 select() 不返回，新连接无法被处理。根因是什么？

**根因分析**:
```
Boss 线程:                            Worker 线程:
  sc = ssc.accept()                    selector.select()
  sc.register(worker, OP_READ)           → lockAndDoSelect()
    → SelectorImpl.register()              → synchronized(this) { ← 持有锁
      → synchronized(worker) { ← 阻塞!        inSelect = true
          等待 Worker 释放锁...                doSelect()
          (永远等不到!)                         → epoll_wait(-1) ← 永远阻塞!
                                            }
                                          }
```

**三个问题同时发生**:
1. Worker 在 epoll_wait(-1) 中持有 synchronized(this) 锁
2. Boss 在 register 时需要 synchronized(worker) → 阻塞
3. 没有人调用 worker.wakeup() → epoll_wait 永不返回 → 锁永不释放 → 死锁

**修复**: `worker.wakeup()` 必须在 register 之前调用。

**源码验证**: `SelectorImpl.java:114-130` — lockAndDoSelect 获取 `synchronized(this)`。`SelectorImpl.java:199-230` — register 也需要 `synchronized(this)`。

**反事实**: 如果 register 不需要锁 → select 期间 register 可能并发修改 fdToKey → HashMap 损坏 → JVM crash。

#### Q10: maxDirectMemory 限制 — PhantomReference + Cleaner + OOM

**问题**: DirectByteBuffer 的 MaxDirectMemorySize 限制是如何实现的？超出限制会发生什么？

**源码依据**: `VM.java:128` — `maxDirectMemory = Long.getLong("sun.nio.MaxDirectMemorySize", -1)`。`Bits.java:94` — `MAX_MEMORY = VM.maxDirectMemory()`。`Bits.java:185` — `tryReserveMemory` CAS 循环。

**完整机制**:
```java
// Bits.java:185-201
private static boolean tryReserveMemory(long size, int cap) {
    long totalCap;
    while (cap <= MAX_MEMORY - (totalCap = totalCapacity.get())) {
        if (totalCapacity.compareAndSet(totalCap, totalCap + cap)) {
            reservedMemory.addAndGet(size);
            count.incrementAndGet();
            return true;
        }
    }
    return false;  // 超出限制
}

// Bits.java:109-183
static void reserveMemory(long size, int cap) {
    if (!tryReserveMemory(size, cap)) {
        // 1. 触发 GC 尝试回收 unreachable DirectByteBuffer
        System.gc();
        // 2. 等待 ReferenceHandler 处理 PhantomReference
        try { Thread.sleep(100); } catch (...)
        // 3. 再次尝试
        if (tryReserveMemory(size, cap)) return;
        // 4. 仍不足 → OOM
        throw new OutOfMemoryError("Direct buffer memory");
    }
}
```

**释放机制**:
```
DirectByteBuffer 变成 unreachable
  → Cleaner (PhantomReference) 被 GC 发现
    → ReferenceHandler 线程处理
      → Deallocator.run()
        → unsafe.freeMemory(address)  // 释放 native 内存
        → Bits.unreserveMemory(size, cap)  // 归还配额
```

**反事实**: 如果没有 MaxDirectMemorySize 限制 → 恶意代码可以无限分配 DirectByteBuffer → 系统 native 内存耗尽 → OOM Killer 随机杀进程。

#### Q11: epoll 100% CPU 根因 — stale epitem (引用 00 详细分析)

**问题**: NIO 服务器 CPU 100% 但没有 I/O 流量。strace 显示 `epoll_wait(5, [], 1024, -1) = 0` 在 tight loop 中重复。根因是什么？

**根因**: Linux < 2.6.27 的 `ep_remove()` bug。当 epoll set 中的最后一个 fd 被移除时，epitem 的 `ffd.file` 指针被清空但 epitem 仍留在 ready list 中。下一次 epoll_wait 扫描 ready list 时，发现这个 stale epitem → `ep_remove()` 试图移除它 → 但 `ffd.file == NULL` → 跳过移除 → epoll_wait 返回 0（没有实际事件）→ Java 的 select 立即返回 → doSelect 循环 → 100% CPU。

**详细分析**: 见 00-Server-Selector-Engine.md §1.8 的内核源码分析。

**修复**: 升级内核 (2.6.27+) 或 JDK 9+（EPollArrayWrapper 在 DEL 前清 pending events）或 poll 降级。

**反事实**: 如果没有这个 bug → 早期 NIO 框架（Netty 3.x, Mina）不会有 epoll bug workaround → 但 Netty 正是在修复这个 bug 的过程中发展了 epoll bug 检测机制。

#### Q12: Project Loom — Virtual Thread 还需要 Selector 吗？

**问题**: Java 21 的 Virtual Thread 允许每个连接一个线程。Selector 和 NIO 的 Reactor 模型还有必要吗？

**答案**: 短期看，两者共存；长期看，Virtual Thread 可能减少直接使用 Selector 的场景。

**当前状态**:
```
传统 Reactor 模型:
  1 个 Selector 线程 + 事件回调 → 管理 10000 个连接
  优点: 极低的线程开销
  缺点: 回调地狱, 调试困难

Virtual Thread 模型:
  10000 个 Virtual Thread → 每个处理 1 个连接
  优点: 简单的同步编程模型 (Thread-per-connection 风格)
  缺点: Virtual Thread 调度开销, 内存占用 (每个 VT ~1KB 栈)
```

**为什么 Selector 仍然重要？**

1. **Virtual Thread 底层仍用 Selector**: Virtual Thread 的 I/O 阻塞在底层仍然是 NIO Selector + DirectBuffer。只是编程模型简化了。
2. **高性能场景**: 100K+ 连接的场景下，Virtual Thread 的内存开销（100K × 1KB = 100MB 栈 + carrier thread 调度）仍然大于 Reactor 模型。
3. **框架兼容性**: Netty, Vert.x 等框架使用 Selector → 不会因为 Loom 而重写。

**未来**: Virtual Thread 覆盖 80% 的应用场景（业务逻辑 I/O），Reactor 覆盖 20% 的高性能场景（网络框架、代理、网关）。

**源码验证**: Virtual Thread 的 `VirtualThread.park()` → `Parker.park()` → 底层仍是 Selector 或 Poller → NIO 基础设施不变。

---

### 1.6 生产场景速查表 (~770 行)

#### 场景 1: EMFILE — accept fd 耗尽

**症状**:
```
java.io.IOException: Too many open files
  at sun.nio.ch.ServerSocketChannelImpl.accept0(Native Method)
  at sun.nio.ch.ServerSocketChannelImpl.accept(ServerSocketChannelImpl.java:422)
```

**根因**: 进程 fd 数量达到 ulimit 上限 → accept 返回 EMFILE → 无法创建新 SocketChannel。

**诊断命令**:
```bash
# 1. 确认 fd 使用量
ls /proc/$(pgrep -f java)/fd/ | wc -l
# → 1024 (如果 ulimit -n = 1024)

# 2. 查看 fd 分布
ls -l /proc/$(pgrep -f java)/fd/ | awk '{print $NF}' | sort | uniq -c | sort -rn | head -10

# 3. 查看 ulimit
cat /proc/$(pgrep -f java)/limits | grep "Max open files"
# → Max open files  1024  4096

# 4. 检查是否有 fd 泄漏
# 对比连接数 (ss) 和 fd 数 (ls /proc/{pid}/fd)
ss -ant | grep ESTAB | wc -l       # 活跃连接数
ls /proc/{pid}/fd/ | wc -l          # fd 总数
# 如果 fd 数 >> 连接数 + 预期 → fd 泄漏
```

**修复方案**:
1. **立即**: `prlimit --pid $(pgrep -f java) --nofile=65536:65536` 扩大限制
2. **永久**: `/etc/security/limits.conf` 添加 `* soft nofile 65536` 和 `* hard nofile 65536`
3. **代码**: accept 循环中 catch IOException → break → 优雅降级
4. **监控**: 设置 fd 使用率告警 (80% of ulimit)

#### 场景 2: dup2 trick — close 阻塞线程不醒来

**症状**:
```
# jstack 输出:
"pool-1-thread-1" #12 prio=5 WAITING
  java.lang.Thread.State: WAITING (parking)
  at sun.nio.ch.EPoll.wait(Native Method)
  ...
"pool-1-thread-2" #13 prio=5 BLOCKED
  java.lang.Thread.State: BLOCKED
  at sun.nio.ch.FileDispatcherImpl.close(FileDispatcherImpl.java:103)
  ...
```
线程 1 阻塞在 EPoll.wait，线程 2 阻塞在 close — 死锁！

**根因**: 线程 2 调用 `channel.close()` → 需要关闭底层 fd → `linux_close.c:closefd` → 需要确保阻塞的线程醒来。但某些内核版本下 `dup2` 不唤醒阻塞的 epoll_wait → 线程 1 永久等待 → close 永远不完成。

**诊断命令**:
```bash
# 1. strace 看 close 是否在 dup2 后卡住
strace -e trace=dup2,close,epoll_wait -p $(pgrep -f java) 2>&1 | tail -20

# 2. jstack 确认线程栈
jstack $(pgrep -f java) | grep -A10 "FileDispatcherImpl.close"
jstack $(pgrep -f java) | grep -A10 "EPoll.wait"
```

**修复方案**:
1. **代码**: close 前调 `selector.wakeup()` → 确保 select 返回 → 释放锁
2. **升级**: 更新 JDK → 更新 linux_close.c 的 closefd 实现
3. **替代**: 使用 `AsynchronousChannelGroup` → 线程池模型 → 不依赖单个线程的 close 语义

#### 场景 3: sendfile EINVAL — 吞吐量突然降到 200MB/s

**症状**:
- Kafka broker 吞吐量从 1GB/s 骤降到 200MB/s
- 日志中无错误（Java 自动降级）
- CPU 使用率上升（mmap+write 需要 CPU copy）

**根因**: sendfile64 返回 EINVAL → `transferSupported` 未设为 false（只设了 `pipeSupported` 或 `fileSupported`）→ 每次 transferTo 仍尝试 sendfile → 失败 → mmap fallback → 吞吐量降 5x。

**诊断命令**:
```bash
# 1. strace 确认降级
strace -c -e trace=sendfile64,mmap,writev,munmap -p $(pgrep -f kafka) 2>&1
# sendfile64: 1280 calls, 1280 errors → 每次都失败!
# mmap+writev+munmap: 1280 sets → 每次都走 mmap fallback

# 2. 检查 capability cache
# 如果 transferSupported=true 但每次都 EINVAL → cache 未生效
# 需要看 transferToDirectlyInternal 的返回值处理
```

**修复方案**:
1. **确认 fd 类型**: `ls -l /proc/{pid}/fd/{srcFD}` 确认 in_fd 是普通文件
2. **检查内核**: 某些内核版本的 sendfile 对特定文件系统（NFS/CIFS）返回 EINVAL
3. **代码修复**: 确认 `transferToDirectlyInternal` 正确处理 UNSUPPORTED_CASE 和 UNSUPPORTED 的区别
4. **容量规划**: 如果 mmap fallback 是预期的 → 按 200MB/s 规划硬件

#### 场景 4: epoll 100% CPU — CPU 打满没有 I/O

**症状**:
- Java 进程 CPU 100%
- 没有网络流量
- `top` 显示 Java 进程在用户态消耗 CPU
- jstack 显示线程在 `processUpdateQueue` / `doSelect` 之间循环

**根因**: Linux < 2.6.27 的 ep_remove() bug（详见 00 文档 §1.8）。

**诊断命令**:
```bash
# 1. strace 确认 bug 签名
strace -e trace=epoll_wait -p $(pgrep -f java) 2>&1 | head -5
# epoll_wait(5, [], 1024, -1) = 0  ← 重复!

# 2. jcmd 确认线程循环
jcmd $(pgrep -f java) Thread.print | grep -A5 "doSelect"
# 线程在 doSelect 中，状态 RUNNABLE (不是 WAITING)

# 3. 确认内核版本
uname -r
# 2.6.18 → 有 bug

# 4. 确认 JDK 版本
java -version
# JDK 8 → EPollArrayWrapper 实现 → 可能触发
```

**修复方案**:
1. **立即**: `-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider` → poll 降级
2. **永久**: 升级内核 (2.6.27+) 或 JDK 9+
3. **检测**: 添加 epoll CPU spin 监控 → `epoll_wait` 在 1ms 内返回 0 超过 100 次 → 告警

#### 场景 5: TIME_WAIT flood — can't open new connections

**症状**:
```
java.net.ConnectException: Cannot assign requested address (connect failed)
  at sun.nio.ch.Net.connect0(Native Method)
```

**根因**: 主动关闭方产生 TIME_WAIT → 每个 TIME_WAIT 占用一个本地端口 60 秒 → 端口耗尽。

**诊断命令**:
```bash
# 1. 确认 TIME_WAIT 数量
ss -ant state time-wait | wc -l
# → 30000+ TIME_WAIT → 端口耗尽

# 2. 查看本地端口范围
cat /proc/sys/net/ipv4/ip_local_port_range
# → 32768  60999  → 约 28000 个端口

# 3. TIME_WAIT 是客户端还是服务端?
ss -ant state time-wait | awk '{print $4}' | sort | uniq -c
# 如果都是高端口 → 客户端场景
```

**修复方案**:
1. **SO_LINGER**: 设置 `l_onoff=1, l_linger=0` → close 发送 RST → 跳过 TIME_WAIT
2. **tcp_tw_reuse**: `sysctl -w net.ipv4.tcp_tw_reuse=1` → 允许重用 TIME_WAIT 端口
3. **端口范围**: `sysctl -w net.ipv4.ip_local_port_range="1024 65535"`
4. **连接池**: 复用连接 → 减少新建/关闭频率

**SO_LINGER 的代价**: RST 跳过 TIME_WAIT → 如果对端还有未发送完的数据 → 丢失。

#### 场景 6: OOM DirectBuffer — OutOfMemoryError

**症状**:
```
java.lang.OutOfMemoryError: Direct buffer memory
  at java.nio.Bits.reserveMemory(Bits.java:175)
  at java.nio.DirectByteBuffer.<init>(DirectByteBuffer.java:123)
```

**根因**: MaxDirectMemorySize 配额耗尽 → 新 DirectByteBuffer 分配失败。

**诊断命令**:
```bash
# 1. 确认 MaxDirectMemorySize
jcmd $(pgrep -f java) VM.flags | grep MaxDirectMemorySize
# → 默认: -XX:MaxDirectMemorySize=0 (表示等于 -Xmx)

# 2. Native Memory 分析
jcmd $(pgrep -f java) VM.native_memory summary
# 关注 Other 部分 → DirectByteBuffer + MappedByteBuffer

# 3. GC 日志确认 Cleaner 延迟
# -XX:+PrintGCDetails -XX:+PrintReferenceGC
# 查看 PhantomReference 处理次数和耗时

# 4. 检查是否有 -XX:+DisableExplicitGC
jcmd $(pgrep -f java) VM.flags | grep DisableExplicitGC
# 如果有 → System.gc() 被禁用 → Cleaner 无法触发 → 配额永不释放!
```

**修复方案**:
1. **增大限制**: `-XX:MaxDirectMemorySize=512m`
2. **禁用 -XX:+DisableExplicitGC**: 移除这个参数 → System.gc() 可以触发 Cleaner
3. **池化**: 使用 Netty 的 PooledByteBufAllocator → 复用 DirectByteBuffer
4. **监控**: 设置 DirectBuffer 使用量告警 → 80% 时触发

#### 场景 7: select stuck — Worker 线程不返回

**症状**:
- Worker Selector 线程永久阻塞在 select()
- 新连接注册到 Worker 后无响应
- Boss 线程正常 accept

**根因**: Boss 在 register 时忘了调 `worker.wakeup()`。

**诊断命令**:
```bash
# 1. jstack 确认线程栈
jstack $(pgrep -f java) | grep -A10 "selector.select"

# Worker 线程:
#   at sun.nio.ch.EPoll.wait(Native Method)  ← 阻塞在这里
# Boss 线程:
#   at sun.nio.ch.SelectorImpl.register(...) ← 阻塞在 synchronized(worker)

# 2. 检查 wakeup 调用
# 在代码中搜索 wakeup → 确认 register 前有 wakeup

# 3. strace 确认 epoll_wait 不返回
strace -e trace=epoll_wait -p $(pgrep -f java) 2>&1
# epoll_wait(5, <unfinished ...> ← 永远不会返回
```

**修复方案**:
```java
// 修复: register 前调 wakeup
Selector worker = workers[idx++ % workers.length];
worker.wakeup();                          // ← 关键!
sc.configureBlocking(false);
sc.register(worker, SelectionKey.OP_READ);
```

**反事实**: 如果没有这个 bug → Reactor 模型的 register/select 并发语义可以更简单 → 不需要 wakeup → 但需要更复杂的锁机制。

---

### 1.7 面试题反事实速查表

| 题号 | 核心问题 | 关键反事实 | 源码依据 |
|:----:|---------|-----------|---------|
| Q1 | epoll vs select | 如果只有 select → 10K 连接 CPU 全耗在遍历 fd | EPoll.java:116, EPoll.c:83 |
| Q2 | 非阻塞 connect | 如果阻塞 connect → 75s 超时阻塞整个 event loop | Net.c:319, SocketChannelImpl.c:76 |
| Q3 | wakeup pipe vs 信号 | 如果用信号 → 快速连续 wakeup 会丢失 | EPollSelectorImpl.java:242 |
| Q4 | LT vs ET | 如果 Java 用 ET → 忘记 EAGAIN 循环就丢数据 | EPoll.c:69 |
| Q5 | dup2 trick | 如果只 close(fd) 不 dup2 → 阻塞线程永不醒来 | linux_close.c:297 |
| Q6 | DirectBuffer vs HeapBuffer | 如果只用 HeapBuffer → 每次 I/O JNI 临界区 copy → 吞吐量 -50% | Bits.java:94,185 |
| Q7 | sendfile vs mmap | 如果 Kafka 不用 sendfile → CPU 成瓶颈 → 吞吐量 -80% | FileChannelImpl.c:134 |
| Q8 | Kafka sendfile | 如果 Kafka 用 read/write → 4 次 CPU copy vs 2 次 | FileChannelImpl.java:678 |
| Q9 | select stuck | 如果 register 不需要锁 → HashMap 并发损坏 → JVM crash | SelectorImpl.java:114 |
| Q10 | maxDirectMemory | 如果无限制 → 恶意代码无限分配 native 内存 → OOM Killer | Bits.java:185 |
| Q11 | epoll CPU spin | 如果没有 ep_remove bug → Netty 不需要 bug 检测机制 | EPoll.c:83, 00文档 |
| Q12 | Virtual Thread | 如果 VT 替代所有 Selector → 100K 连接 100MB 栈 + carrier 调度 | VirtualThread.park() |

### 1.8 零拷贝性能基准表

#### sendfile vs mmap+write vs read/write — 10GB 文件传输

| 指标 | sendfile64 | mmap+write (8MB) | read/write (8KB) |
|------|-----------|-----------------|-----------------|
| Syscall 次数 | 1-10 (取决于 EAGAIN) | ~2560 (1280 × 2) | ~2,621,440 |
| CPU copy 次数 | 0 | 1280 (每次 8MB) | 2,621,440 (每次 8KB) |
| Context switch | 1-10 | ~2560 | ~2,621,440 |
| 理论吞吐量 (10Gbps) | ~1.2 GB/s | ~200 MB/s | ~80 MB/s |
| CPU 使用率 | ~5% (仅中断处理) | ~30% (memcpy) | ~60% (memcpy+syscall) |
| 适用 out_fd | 仅 socket | 任意 fd | 任意 fd |
| 适用 in_fd | 仅普通文件 | 仅普通文件 | 任意 fd |
| JDK 层调用 | transferToDirectly | transferToTrustedChannel | transferToArbitraryChannel |
| Java 常量 | — | MAPPED_TRANSFER_SIZE=8MB | TRANSFER_SIZE=8192 |
| 内核机制 | splice + DMA gather | mmap + copy_from_user | copy_to_user + copy_from_user |

#### Reactor 线程模型基准

| 指标 | 单线程 Reactor | Boss/Worker Reactor | Netty NioEventLoop |
|------|:---:|:---:|:---:|
| Accept 延迟 (高 I/O 时) | 25ms (500 reads × 50μs) | <1μs | <1μs |
| Selector 锁竞争 | 无 | 跨 Selector 无锁 | 无 (单线程) |
| interestOps 生效 | 下次 select | 下次 select + wakeup | 下次 event loop 循环 |
| 跨线程 register | 需要 wakeup | 需要 wakeup | 自动 wakeup |
| epoll bug 防御 | 无 | 无 | 有 (select 策略 + 检测) |
| 适用场景 | <100 连接 | 100-10000 连接 | 10000+ 连接 |

#### 平台 sendfile 对比

| 平台 | 系统调用 | 参数顺序 | EAGAIN 语义 | Java 文件:行号 |
|------|---------|---------|-----------|--------------|
| Linux | sendfile64(out,in,&off,len) | out_fd 在前 | socket buffer full | FileChannelImpl.c:134 |
| Solaris | sendfilev64(out,&sfv,1,&n) | out_fd 在前 + 结构体 | 需要更长重试 | FileChannelImpl.c:148 |
| macOS | sendfile(in,out,off,&n,NULL,0) | **in_fd 在前** (与 Linux 相反!) | 类似 Linux | FileChannelImpl.c:178 |
| AIX | send_file(&out,&sf,SF_SYNC_CACHE) | 结构体参数 | 不同 errno 映射 | FileChannelImpl.c:204 |
| Windows | TransmitFile(out,in,len,0,&ov,...) | 类似 Linux | I/O completion | FileChannelImpl.c:143 |

---

## §二 6 Beginner Callout 框

> **Callout 1: sendfile64 kernel path**
>
> Disk DMA→page cache→splice/DMA gather→socket buffer→NIC. 0 user-space copies, 1 context switch. Vs read()+write(): 4 copies (2 DMA+2 CPU), 2 context switches. By eliminating CPU copies entirely, sendfile frees the CPU for application logic—critical for 10Gbps+ networks. Source: FileChannelImpl.c:134-135, man 2 sendfile.

> **Callout 2: 三层 fallback**
>
> (1) `transferToDirectly`: sendfile64 success, 0 CPU copies. (2) `transferToTrustedChannel`: mmap+write 8MB chunks, 1 CPU copy. (3) `transferToArbitraryChannel`: heap byte[] read()+write(), 2 CPU copies+2 syscalls per chunk. `transferSupported/pipeSupported/fileSupported` volatile booleans cache kernel capability on first failure (FileChannelImpl.java:471-483). Chunk sizes: MAPPED_TRANSFER_SIZE=8MB (fallback #2), TRANSFER_SIZE=8192 (fallback #3).

> **Callout 3: mmap vs sendfile**
>
> mmap maps file→user virtual addr→`write(fd,mmap_addr,len)`→1 kernel copy (page cache→socket buffer via copy_from_user). sendfile: 0 copies (DMA gather in kernel). mmap advantage: works on any writable fd (pipe, file, socket). sendfile restriction: out_fd must be socket, in_fd must be regular file. MAPPED_TRANSFER_SIZE=8MB keeps virtual address usage low.

> **Callout 4: Reactor Boss/Worker**
>
> Boss=OP_ACCEPT only, Worker=OP_READ/OP_WRITE. `lockAndDoSelect()` uses `synchronized(this)` per Selector—no cross-Selector locking. `interestOps` trap: `key.interestOps()` only enqueues to `updateKeys` Deque via `setEventOps()` (EPollSelectorImpl.java:242-247). If Selector is blocking in `epoll_wait`, you MUST call `wakeup()` before any register. Forgetting wakeup() in Boss→Worker handoff is the #1 cause of "selector stuck forever". **Validation**: SelectorImpl.java:114-130.

> **Callout 5: epoll bug 诊断 (引用 00)**
>
> Linux<2.6.27 `ep_remove()` bug—stale epitem survives in ready-list after fd removal→`epoll_wait` returns 0 instead of blocking→100% CPU spin. Three-step diagnosis: (1) `uname -r` confirms old kernel, (2) `strace -e epoll_wait` shows tight loop returning 0, (3) `jcmd Thread.print | grep doSelect` shows loop in processUpdateQueue/doSelect. Fix: upgrade kernel or use `-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider`. **Full kernel source analysis**: 00-Server-Selector-Engine.md §1.8.

---

## §三 诊断工具链汇总

### strace 诊断矩阵

| 场景 | 期望 syscall | 异常 syscall | 诊断 |
|------|------------|------------|------|
| sendfile 正常 | `sendfile64(dst,src,...)=8M` | — | 零拷贝成功 |
| sendfile 降级 | — | `sendfile64=−1 EINVAL→mmap→writev→munmap` | EINVAL→fallback; count `mmap→writev` pairs |
| epoll bug | `epoll_wait=1` | `epoll_wait(5,[],1024,−1)=0` tight loop | CPU spin; immediate remedy needed |
| connect 正常 | `connect=0` or `connect=−1 EINPROGRESS` | `connect=−1 ECONNREFUSED` | RST 收到; 端口可能无监听 |
| accept 正常 | `accept4=9` | `accept4=−1 EMFILE` | fd 耗尽 |

### jstack 线程栈读取

```
正常 Worker:             异常 Worker:
EPoll.wait(Native)       EPoll.wait(Native)
doSelect                 doSelect
lockAndDoSelect          lockAndDoSelect
select                   select
(BLOCKED,正常)          (BLOCKED, Stuck! 应该被 wakeup 唤醒)
```

### /proc 速查

| 路径 | 作用 | 关键信息 |
|------|------|---------|
| `/proc/{pid}/fd/` | fd 计数 | `ls | wc -l` → fd 使用数 |
| `/proc/{pid}/fdinfo/{fd}` | epoll 细节 | `tfd:` 行 → 每个 watched fd 的事件和数据 |
| `/proc/{pid}/limits` | 资源限制 | `Max open files` → ulimit |
| `/proc/sys/net/core/somaxconn` | listen截断 | backlog = min(arg, somaxconn) |
| `/proc/sys/net/ipv4/tcp_syn_retries` | connect超时 | SYN重试 = 6 → ~127s |

---

## §四 Cross-Reference

### 内部连续性

| 本文节 | 承接自 | 说明 |
|--------|--------|------|
| 1.1 sendfile64 | [11-os-layer] + [01 §1.4] | sendfile64 数据路径 + DirectBuffer 对比 read/write |
| 1.2 Reactor | [00 §1.5-1.7] | register/select/wakeup 在 Reactor 模型中的并发语义 |
| 1.3 epoll bug 诊断 | [00 §〇, §1.8] | 从诊断视角引用 00 的内核源码分析 |
| 1.4 诊断工具 | [00 §3] + [01 §3] | strace/GDB//proc/jstack 在三个文档中完整覆盖 |

### 同组边界

| 本文 (02) | 00-Server-Selector-Engine | 01-Socket-Data-Close |
|-----------|-------------------------|---------------------|
| sendfile64 zero-copy + Reactor + diagnostics | Selector engine (epoll + 事件循环 + epoll bug deep analysis) | Socket lifecycle + DirectBuffer + dup2 close |
| FileChannelImpl.transferTo → sendfile64 kernel path | Selector.open() → register() → select() → wakeup() | SocketChannel.connect() → read(DirectBuffer) → close() |
| Boss/Worker thread model + interestOps trap | epoll_create/ctl/wait + fdToKey | ECONNABORTED retry + Scatter/Gather |
| 12 interview questions + 7 scenarios | 6 callout boxes | 6 callout boxes |
| Diagnostic toolkit (strace+GDB+/proc+jcmd) | GDB 6 assertions + strace | GDB 5 assertions + strace |

### 关键设计决策总结

| 决策 | 实现 | 根本原因 | 代价 |
|------|------|---------|------|
| **sendfile 零拷贝** | sendfile64 → DMA gather | 消除 CPU 参与数据传输 — 内核态 splice | 仅 out_fd=socket, in_fd=file |
| **三层 fallback** | sendfile→mmap+write→heap read/write | 内核不支持时自动降级 → 不崩 | 吞吐量 ~3-5x drop from sendfile |
| **volatile capability cache** | transferSupported/pipeSupported/fileSupported | 一次失败后缓存能力 → 避免重复失败 | 无法热恢复 (需重启) |
| **Boss/Worker 分离** | Boss: OP_ACCEPT, Worker: OP_READ/WRITE | 阻止 I/O delay 影响 accept throughput | 额外 Selector 开销 + wakeup 管理 |
| **interestOps 延迟** | updateKeys Deque + processUpdateQueue | 批量处理减少 epoll_ctl syscall | 需要 wakeup() — 忘了则 stuck |
| **synchronized(this)** | lockAndDoSelect + register 共享锁 | 阻止 register 和 select 并发冲突 | 跨 Selector 无锁 → Boss/Worker 无竞争 |
| **mmap 8MB chunk** | MAPPED_TRANSFER_SIZE=8MB | 32-bit JVM 安全 + TLB 友好 | 更多 map/unmap 调用 |

---

## 文档信息

- **生成时间**: 2026-06-13（扩容完成）
- **源代码基线**: OpenJDK 11
- **覆盖文件**: FileChannelImpl.c (247行), FileChannelImpl.java (key sections ~300行), SelectorImpl.java (175行), EPollSelectorImpl.java (270行, already from 00), EPoll.java (118行), SelectionKeyImpl.java (160行), Net.c (815行, already from 01), SocketChannelImpl.c (88行), ServerSocketChannelImpl.c (120行), linux_close.c (350行), Bits.java (200行), VM.java (210行)
- **相关 man pages**: man 2 sendfile, man 2 splice, man 2 mmap, man 2 munmap, man 2 writev, man 7 epoll, man 2 epoll_create, man 2 epoll_ctl, man 2 epoll_wait, man 2 connect, man 2 getsockopt, man 2 dup2, man 7 tcp
- **内核源码参考**: fs/sendfile.c, fs/splice.c, fs/eventpoll.c (00文档), fs/read_write.c, net/ipv4/tcp.c, include/linux/fs.h, net/core/sock.c, net/ipv4/tcp_output.c
