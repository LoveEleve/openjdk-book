# Phase 16: NIO Network — libnio.so + libnet.so

> **Java NIO 不是 Java 的发明——它是 Linux epoll 的 JNI 包装。** Selector 在一个线程上管理 10,000 个 Socket 连接——每个连接注册到 epoll fd。当数据到达时，epoll_wait 返回就绪 fd 集合——Java 层只处理就绪连接，不轮询空闲连接。DirectByteBuffer 允许数据从网卡直接读到 native 内存——跳过 GC 堆，实现零拷贝。FileChannel.transferTo 调用 sendfile64——数据从磁盘到 socket 全程不走用户态。

> **本文档范围**: 完整 NIO 网络子系统 — 143 个源文件全覆盖。深度分析 (✅ 30 个) 聚焦 epoll Selector + SocketChannel + FileChannel + DirectByteBuffer 核心链路；清单覆盖 (📋 54 个) 含 UDP/DatagramChannel/Pipe/SPI 等辅助模块；排除范围 (🔲 59 个) 为异步 I/O (AIO 独立子系统)、网络层 (地址解析/接口枚举)、java.nio Buffer 基类 (Phase 03 覆盖) 及其他平台代码。详见 §三 完整源文件表及末尾覆盖统计。

---

## §〇 上手指南

### 3-Tier Reading Path

| Tier | 读者 | 阅读量 | 重点 |
|------|------|:---:|------|
| 🥉 Bronze | 想理解一个线程如何管理 10K 连接 | §二.1, §二.7 + §一 epoll 核心链路 | 30min |
| 🥈 Silver | 想理解整个 NIO 栈 | §二全篇 + §四 文档描述 + §三 源文件表 | 2h |
| 🥇 Gold | 想诊断生产问题 (Selector 100% CPU, OOM DirectBuffer) | §六 + §二.5 dup2 trick + source | 1天 |

### 前置阅读

| Phase | 需要理解的内容 | 本 Phase 用到 |
|-------|---------------|-------------|
| 09-native-interface | JNI_ENTRY / JVM_ENTRY 宏, JNI native 方法注册 | 所有 I/O native 方法的入口 |
| 11-os-layer | epoll_create/epoll_ctl/epoll_wait 系统调用, dup2, sendfile, pipe | §二.1 epoll, §二.5 dup2, §二.4 sendfile |
| 03-object-model | DirectByteBuffer 的 Java 对象布局, Cleaner/PhantomReference | §二.3 DirectBuffer 分配与生命周期 |
| 15-core-native | System.c 的 JNI bridge 模式, convertReturnVal 机制 | IOUtil.c 共用 convertReturnVal (IOUtil.c:178) |

### 3 句话本质

Java NIO 不是 Java 的发明——它是 Linux epoll 的 JNI 包装。Selector 在一个线程上管理 10,000 个 Socket 连接——每个连接的 fd 注册到 epoll fd，epoll_wait 只返回有数据就绪的 fd 集合（O(1) 复杂度），Java 层只处理活跃连接。DirectByteBuffer 通过 `UNSAFE.allocateMemory` 在堆外分配 native 内存——地址稳定，内核可以 DMA 直接读写，跳过 GC 堆拷贝。

### 核心术语

| 术语 | 定义 | 出现位置 |
|------|------|---------|
| **epoll fd** | epoll_create() 创建的 epoll 实例 fd，管理所有注册的事件 | EPoll.c:61, EPollSelectorImpl.java:79 |
| **EPOLL_CTL_ADD/MOD/DEL** | epoll_ctl 的三个操作码：添加/修改/删除注册的 fd 和事件 | EPoll.java:58-60, EPoll.c:69-80 |
| **EPOLLIN / EPOLLOUT** | epoll 事件：fd 可读 / fd 可写 | EPoll.java:63-64 |
| **level-triggered** | 每次 epoll_wait 都返回仍有数据的 fd（直到读完数据）——Java NIO 选型 | §二.1 |
| **EPOLLONESHOT** | fd 触发一次后自动从 epoll 移除——需要 EPOLL_CTL_MOD 重新激活 | EPoll.java:67 |
| **DirectByteBuffer** | Java Buffer 对象，内部 `address` 字段保存 native 内存地址 | Direct-X-Buffer.java.template:122 |
| **Cleaner / Deallocator** | PhantomReference 机制——直接缓冲区不可达时自动释放 native 内存 | Direct-X-Buffer.java.template:69-94 |
| **IOVecWrapper** | 构建 native `struct iovec` 数组——scatter/gather I/O 的载体 | IOVecWrapper.java (17 行 native struct 布局) |
| **sendfile64** | Linux 系统调用——内核态文件到 socket 的零拷贝传输 | FileChannelImpl.c:135 |
| **wakeup pipe** | Selector 内部 pipe——写 1 字节唤醒 epoll_wait 阻塞的线程 | IOUtil.c:91, EPollSelectorImpl.java:83-93 |
| **dup2 trick** | 关闭 fd 时 dup2 到预 shutdown 的 AF_UNIX socketpair endpoint——让阻塞在该 fd 上的 read() 返回 EBADF | linux_close.c:275-321 |
| **WAKEUP_SIGNAL** | SIGRTMAX-2——用于中断阻塞 I/O 线程的 POSIX 实时信号 | linux_close.c:63 |
| **Reactor 模式** | 单线程事件循环——Selector 等待事件 → dispatch 就绪 channel 给 handler 处理 | §二.7 |
| **EINPROGRESS** | 非阻塞 connect() 返回值——TCP 三次握手已启动但未完成 | PlainSocketImpl.c:328, Net.c:319 |
| **IPV6_V6ONLY** | socket 选项——设为 0 允许 IPv6 socket 接受 IPv4 连接 (dual-stack) | PlainSocketImpl.c:189-196, Net.c:207-217 |
| **SO_LINGER** | socket 选项——控制 close() 行为：l_onoff=1 + l_linger=0 → 发 RST 跳过 TIME_WAIT | PlainSocketImpl.c:863-884, §六 TIME_WAIT flood |
| **TCP_NODELAY** | 禁用 Nagle 算法——不合并小数据包，立即发送，降低延迟 | Net.c, §五.T2.Q8 |

---

**C 导航——开始读源码前需要认识的 4 个模式:**

这 4 个 C 模式贯穿整个 16 阶段——认识它们，代码就透明了。

1. **jlong_to_ptr(addr)** — Java long → native pointer 转换。DirectBuffer.address() 返回 long → 在 C 层转为 void* → 传给 read(fd, ptr, len)。本质上是一个 cast: `(void*)(uintptr_t)jlong_val`。Java 无指针 → 用 long 表示内存地址。

2. **#if defined(__linux__)** — 平台条件编译。同一个 .c 文件可能包含 Linux/MacOS/Windows 三个版本的内核调用。`#if defined(__linux__)` 块中是 epoll/sendfile64 等 Linux 专属代码。

3. **errno + JNU_ThrowIOExceptionWithLastError** — OS 错误转 Java 异常。当 read() 返回 -1 → 检查 errno (全局错误码) → EAGAIN (11: try again, 非阻塞 socket 的正常状态) vs ECONNRESET (104: connection reset) → JNU_ThrowIOExceptionWithLastError 抛出对应 IOException。

4. **JNI_ENTRY static jint → JNI_END** — Java→native 入口宏。JNI_ENTRY 隐藏了 Parameter Marshalling (提取 jclass/jfield/jmethod), JNI_END 隐藏了 Return value wrapping。详细见 09-native-interface。

---

## §一 The Selector Lifecycle — 完整源码验证

### 系统架构全景图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Java 层 (JDK class library)                      │
│                                                                              │
│  ┌─────────────────────┐   ┌─────────────────────┐   ┌────────────────────┐ │
│  │  SocketChannel      │   │  Selector /          │   │  FileChannel       │ │
│  │  .read(buf)         │   │  EPollSelectorImpl   │   │  .transferTo()     │ │
│  │  .write(buf)        │   │    .select()         │   │                    │ │
│  │  .register(sel,ops) │   │    .wakeup()         │   │                    │ │
│  └───────┬─────────────┘   └──────────┬──────────┘   └─────────┬──────────┘ │
│          │ DirectBuffer.address()     │                         │            │
│          │ + IOUtil.read/write        │                         │            │
└──────────┼────────────────────────────┼─────────────────────────┼────────────┘
           │                            │                         │
           ▼                            ▼                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           JNI 边界 (libnio.so + libnet.so)                    │
│                                                                              │
│  ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐ │
│  │ FileDispatcherImpl.c │ │ EPoll.c              │ │ FileChannelImpl.c    │ │
│  │  read0/write0        │ │  epollCreate/ctl/wait│ │  transferTo0         │ │
│  │  readv0/writev0      │ │  eventSize/Offset    │ │  map0/unmap0         │ │
│  │  convertReturnVal    │ │                      │ │  sendfile64()        │ │
│  └──────────┬───────────┘ └──────────┬───────────┘ └──────────┬───────────┘ │
│  ┌──────────┴───────────┐ ┌──────────┴───────────┐            │             │
│  │ IOUtil.c             │ │ Net.c                │            │             │
│  │  makePipe/drain      │ │  socket0/connect0    │            │             │
│  │  fdLimit/iovMax      │ │  bind0/listen        │            │             │
│  │  configureBlocking   │ │  poll/pollinValue    │            │             │
│  └──────────┬───────────┘ └──────────┬───────────┘            │             │
│  ┌──────────┴───────────┐ ┌──────────┴───────────┐            │             │
│  │ linux_close.c        │ │ PlainSocketImpl.c    │            │             │
│  │  closefd/dup2 trick  │ │  socketCreate/Connect│            │             │
│  │  NET_Read/Accept     │ │  socketBind/Listen   │            │             │
│  │  WAKEUP_SIGNAL       │ │  socketClose0        │            │             │
│  └──────────────────────┘ └──────────────────────┘            │             │
│                                                                │             │
└────────────────────────────────────────────────┬────────────────┼─────────────┘
                                                 │                │
              POSIX System Calls                 ▼                ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                           Linux 内核层                                         │
│                                                                                │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ read()   │  │ write()  │  │ epoll_    │  │ sendfile64│  │ pipe()       │  │
│  │ readv()  │  │ writev() │  │ create    │  │ mmap64    │  │ dup2()       │  │
│  │          │  │          │  │ epoll_ctl │  │ munmap    │  │ fcntl()      │  │
│  │          │  │          │  │ epoll_wait│  │           │  │ close()      │  │
│  └──────────┘  └──────────┘  └───────────┘  └───────────┘  └──────────────┘  │
│                                                                                │
│  ┌──────────────────────────────────────────────────────────────────────┐     │
│  │              内核数据结构: epoll 实例                                   │     │
│  │  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐         │     │
│  │  │  红黑树       │ ←──→ │  就绪链表     │ ───→ │   fd 集合     │         │     │
│  │  │  (全量 fd)    │      │  (就绪 fd)    │      │  (epoll_wait │         │     │
│  │  │  O(log N)     │      │  O(1) 取出    │      │   一次取出)   │         │     │
│  │  └──────────────┘      └──────────────┘      └──────────────┘         │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
│                                                                                │
│  N: 网卡驱动 → DMA → kernel socket buffer → DirectByteBuffer (native memory) │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Selector.open() — 创建 epoll 实例

```
Java: Selector.open()
  → SelectorProvider.openSelector()
    → EPollSelectorProvider.openSelector()        // linux/classes/sun/nio/ch/EPollSelectorProvider.java
      → new EPollSelectorImpl(sp)                 // EPollSelectorImpl.java:76
```

**EPollSelectorImpl 构造函数** (EPollSelectorImpl.java:76-94):
```java
this.epfd = EPoll.create();                          // [1] 创建 epoll fd
this.pollArrayAddress = EPoll.allocatePollArray(NUM_EPOLLEVENTS); // [2] 分配事件数组
long fds = IOUtil.makePipe(false);                   // [3] 创建 pipe
this.fd0 = (int) (fds >>> 32);                       // [4] pipe 读端
this.fd1 = (int) fds;                                // [5] pipe 写端
EPoll.ctl(epfd, EPOLL_CTL_ADD, fd0, EPOLLIN);        // [6] 注册 pipe 读端到 epoll
```

**Native 链路**:

1. `EPoll.create()` → `Java_sun_nio_ch_EPoll_create` (EPoll.c:58-66):
   ```c
   int epfd = epoll_create(256);  // size 参数自 Linux 2.6.8 起被忽略
   ```
   **验证**: epoll_create(256) — size 参数暗示 "预计管理 256 个 fd"，但 Linux 2.6.8+ 已忽略此参数。EPoll.c:61 注释明确：`/* size hint not used in modern kernels */`

2. `EPoll.allocatePollArray(NUM_EPOLLEVENTS)` (EPoll.java:72-73): `unsafe.allocateMemory(count * SIZEOF_EPOLLEVENT)` — 直接在 native 堆分配 epoll_event 数组。

3. `IOUtil.makePipe(false)` → `Java_sun_nio_ch_IOUtil_makePipe` (IOUtil.c:87-105):
   ```c
   pipe(fd);  // 创建 pipe
   configureBlocking(fd[0], JNI_FALSE);  // 读端非阻塞
   configureBlocking(fd[1], JNI_FALSE);  // 写端非阻塞
   return ((jlong) fd[0] << 32) | (jlong) fd[1];  // 打包两个 fd 到一个 long
   ```
   **验证**: `configureBlocking` (IOUtil.c:70-76) 通过 `fcntl(fd, F_GETFL/F_SETFL, O_NONBLOCK)` 设置非阻塞。

4. `EPoll.ctl(epfd, EPOLL_CTL_ADD, fd0, EPOLLIN)` → `Java_sun_nio_ch_EPoll_ctl` (EPoll.c:69-80):
   ```c
   event.events = events;   // 直接使用 Java 传入的事件标志（不含 EPOLLET）
   event.data.fd = fd;      // 关联 fd 到 epoll_event.data
   res = epoll_ctl(epfd, opcode, fd, &event);
   ```
   **关键发现**: Java 不设置 EPOLLET (edge-triggered) 标志。`translateInterestOps()` 只返回 `EPOLLIN|EPOLLOUT` (SocketChannelImpl.java:1057-1065)。Java NIO 默认使用 **level-triggered** epoll。

### 1.2 register() — 注册 Channel 到 Selector

```
Java: channel.register(selector, OP_READ | OP_WRITE)
  → SelectorImpl.register(ch, ops, att)               // SelectorImpl.java:199
    → create SelectionKeyImpl(ski)
    → implRegister(k)                                  // 平台特定注册
    → k.interestOps(ops) → setEventOps(ski)            // 排入 updateKeys 队列
```

**EPollSelectorImpl.setEventOps** (EPollSelectorImpl.java:242-247):
```java
synchronized (updateLock) {
    updateKeys.addLast(ski);  // 排入更新队列，不在注册时立即调用 epoll_ctl
}
```

### 1.3 select() — 事件循环核心

```
Java: selector.select(timeout)
  → SelectorImpl.lockAndDoSelect()                     // SelectorImpl.java:114
    → EPollSelectorImpl.doSelect(action, timeout)      // EPollSelectorImpl.java:102
```

**doSelect 完整流程** (EPollSelectorImpl.java:102-138):

```java
protected int doSelect(Consumer<SelectionKey> action, long timeout) {
    processUpdateQueue();        // [1] 处理排队的注册/事件变更
    processDeregisterQueue();    // [2] 处理取消的 key

    do {
        numEntries = EPoll.wait(epfd, pollArrayAddress, NUM_EPOLLEVENTS, to); // [3] 阻塞等待
        if (numEntries == IOStatus.INTERRUPTED && timedPoll) {
            to -= elapsed;       // [4] EINTR 被信号中断 → 调整剩余超时
            if (to <= 0) numEntries = 0;
        }
    } while (numEntries == IOStatus.INTERRUPTED);

    processDeregisterQueue();    // [5] 重新处理取消的 key
    return processEvents(numEntries, action);           // [6] 处理就绪事件
}
```

**processUpdateQueue** (EPollSelectorImpl.java:143-175): 将 `updateKeys` 队列中的 interest 变更批量应用：
```java
int newEvents = ski.translateInterestOps();  // OP_READ→EPOLLIN, OP_WRITE→EPOLLOUT
int registeredEvents = ski.registeredEvents();
if (newEvents != registeredEvents) {
    if (newEvents == 0)      EPoll.ctl(epfd, EPOLL_CTL_DEL, fd, 0);   // 无兴趣→删除
    else if (registeredEvents == 0) EPoll.ctl(epfd, EPOLL_CTL_ADD, fd, newEvents); // 新注册
    else                     EPoll.ctl(epfd, EPOLL_CTL_MOD, fd, newEvents); // 修改事件
}
```

**processEvents** (EPollSelectorImpl.java:181-207):
```java
for (int i=0; i<numEntries; i++) {
    long event = EPoll.getEvent(pollArrayAddress, i);   // address + SIZE*i
    int fd = EPoll.getDescriptor(event);                 // unsafe.getInt(addr+FD_OFFSET)
    if (fd == fd0) {                                     // wakeup pipe 读端
        interrupted = true;
    } else {
        SelectionKeyImpl ski = fdToKey.get(fd);           // fd → key 映射
        if (ski != null) {
            int rOps = EPoll.getEvents(event);            // unsafe.getInt(addr+EVENT_OFFSET)
            numKeysUpdated += processReadyEvents(rOps, ski, action);
        }
    }
}
```

**Native epoll_wait 调用** → `Java_sun_nio_ch_EPoll_wait` (EPoll.c:82-97):
```c
struct epoll_event *events = jlong_to_ptr(address);  // Java 地址 → C 指针
int res = epoll_wait(epfd, events, numfds, timeout);  // 阻塞等待
if (res < 0) {
    if (errno == EINTR) return IOS_INTERRUPTED;        // 被信号中断
}
return res;  // 返回就绪 fd 数量
```

**NUM_EPOLLEVENTS**: `Math.min(IOUtil.fdLimit(), 1024)` (EPollSelectorImpl.java:53) — 单次 epoll_wait 最多返回 1024 个事件。`fdLimit()` (IOUtil.c:152-165) 通过 `getrlimit(RLIMIT_NOFILE)` 获取系统 fd 上限。

### 1.4 事件数据结构 — EPoll.java

**Java 侧 epoll_event 布局** (EPoll.java:53-55, 86-102):
```java
// struct epoll_event { __uint32_t events; epoll_data_t data; }
// epoll_data_t = union { void *ptr; int fd; __uint32_t u32; __uint64_t u64; }
SIZEOF_EPOLLEVENT = eventSize();       // sizeof(struct epoll_event) — 12 bytes on x86-64
OFFSETOF_EVENTS = eventsOffset();      // 0
OFFSETOF_FD = dataOffset();            // offsetof(struct epoll_event, data)
```

**Native 实现**: EPoll.c:41-56
```c
Java_sun_nio_ch_EPoll_eventSize()  { return sizeof(struct epoll_event); }
Java_sun_nio_ch_EPoll_eventsOffset() { return offsetof(struct epoll_event, events); }
Java_sun_nio_ch_EPoll_dataOffset() { return offsetof(struct epoll_event, data); }
```

**关键**: `EPoll.getEvent(address, i)` = `address + SIZEOF_EPOLLEVENT * i` — 直接在 native 内存中索引 epoll_event 数组。Java 不创建 epoll_event 的 Java 对象——直接用 `Unsafe.getInt` 读取 native 内存中的 events 和 data.fd 字段。

### 1.5 fd→key 映射

**EPollSelectorImpl.fdToKey** (EPollSelectorImpl.java:66):
```java
private final Map<Integer, SelectionKeyImpl> fdToKey = new HashMap<>();
```

epoll_wait 返回的是就绪 fd 的原始整数。`processEvents` 通过 `fdToKey.get(fd)` 找到对应的 SelectionKey (EPollSelectorImpl.java:194)。注册时 `fdToKey.putIfAbsent(fd, ski)` 在 `processUpdateQueue` 中完成 (EPollSelectorImpl.java:152)。

### 1.6 wakeup() — 唤醒 Selector 线程

**EPollSelectorImpl.wakeup()** (EPollSelectorImpl.java:250-262):
```java
public Selector wakeup() {
    synchronized (interruptLock) {
        if (!interruptTriggered) {
            IOUtil.write1(fd1, (byte)0);     // 向 pipe 写端写 1 字节
            interruptTriggered = true;
        }
    }
}
```

**Native**: `IOUtil.write1` → `Java_sun_nio_ch_IOUtil_write1` (IOUtil.c:108-112):
```c
char c = (char)b;
write(fd, &c, 1);  // write 1 byte to pipe
```

**处理**: epoll_wait 检测到 fd0 (pipe 读端) 有 EPOLLIN → `processEvents` 发现 `fd == fd0` → 调用 `clearInterrupt()` (EPollSelectorImpl.java:202-204)。

**clearInterrupt** (EPollSelectorImpl.java:264-268):
```java
IOUtil.drain(fd0);          // 读空 pipe 中的数据
interruptTriggered = false;
```

**IOUtil.drain** (IOUtil.c:115-129): 循环以 16 字节块读取 pipe 直到返回 EAGAIN——这样无论 pipe 中累积了多少 wakeup 字节，都能一次性清空。

### 1.7 I/O 读取 — DirectByteBuffer 路径

```
Java: sc.read(directBuffer)
  → SocketChannelImpl.read(buf)                       // SocketChannelImpl.java:336
    → IOUtil.read(fd, buf, -1, nd)                     // IOUtil.java:226
      → readIntoNativeBuffer(fd, buf, -1, nd)          // IOUtil.java:255
        → long addr = ((DirectBuffer)buf).address() + pos  // 提取 native 地址
        → nd.read(fd, addr, rem)                       // NativeDispatcher → native
```

**Native**: `read0` → `Java_sun_nio_ch_FileDispatcherImpl_read0` (FileDispatcherImpl.c:79-86):
```c
jint fd = fdval(env, fdo);
void *buf = (void *)jlong_to_ptr(address);    // Java long → void* 指针
return convertReturnVal(env, read(fd, buf, len), JNI_TRUE);  // POSIX read syscall
```

**convertReturnVal** (IOUtil.c:178-199):
```c
if (n > 0) return n;                                    // 成功读取 n 字节
else if (n == 0) return reading ? IOS_EOF : 0;          // EOF
else if (errno == EAGAIN || errno == EWOULDBLOCK)
    return IOS_UNAVAILABLE;                              // 非阻塞无数据
else if (errno == EINTR) return IOS_INTERRUPTED;         // 被信号中断
else return IOS_THROWN;                                  // 抛出 IOException
```

**HeapBuffer fallback**: 如果 Buffer 不是 DirectBuffer，IOUtil 先分配临时 DirectBuffer，拷贝 heap 数据到 native buffer → 发起 I/O → 拷贝回 heap buffer。这就是 HeapByteBuffer I/O 需要额外拷贝两次的原因。

### 1.8 Scatter/Gather I/O — IOVecWrapper

**Java 侧**: IOVecWrapper 使用 `AllocatedNativeObject` 在 native 内存中构建 `struct iovec` 数组 (IOVecWrapper.java:52-53, 141-155)。

```java
// struct iovec { void* iov_base; size_t iov_len; } — 每个 16 bytes (x86-64)
vecArray = new AllocatedNativeObject(size * SIZE_IOVEC, false);  // native 内存
address = vecArray.address();  // native 指针

// 填充 iovec 数组
void putBase(int i, long base) { vecArray.putLong(SIZE_IOVEC*i, base); }     // iov_base
void putLen(int i, long len)   { vecArray.putLong(SIZE_IOVEC*i+LEN_OFFSET, len); } // iov_len
```

**Native scatter-read**: `readv0` → `Java_sun_nio_ch_FileDispatcherImpl_readv0` (FileDispatcherImpl.c:99-105):
```c
struct iovec *iov = (struct iovec *)jlong_to_ptr(address);  // Java 地址 → iovec 数组
return convertLongReturnVal(env, readv(fd, iov, len), JNI_TRUE);  // POSIX readv syscall
```

---

### 1.9 数据流全景 — 从网卡到 Java DirectBuffer

```
    ┌──────────┐
    │  网卡    │  NIC receives TCP packet
    └────┬─────┘
         │  DMA
         ▼
    ┌──────────────┐
    │ kernel socket│  kernel buffer (sk_buff)
    │   buffer     │  TCP/IP stack → reassemble, ACK, seq
    └──────┬───────┘
           │
    ┌──────┴─────────────────────────────────────────────┐
    │              数据路径 (3 种)                         │
    │                                                       │
    │  ┌──────────────────────────────────────────────────┐ │
    │  │ 路径 A: DirectBuffer (最快, 1 次拷贝)             │ │
    │  │                                                    │ │
    │  │   kernel buffer                                    │ │
    │  │        │                                           │ │
    │  │        │ read(fd, buf, len)  — POSIX syscall       │ │
    │  │        ▼                                           │ │
    │  │   native memory (DirectBuffer.address())           │ │
    │  │        │                                           │ │
    │  │        │ DirectBuffer.get()  — JVM intrinsic        │ │
    │  │        ▼                                           │ │
    │  │   Java layer — 直接通过 address 偏移访问            │ │
    │  │                                                    │ │
    │  │   源码链:                                          │ │
    │  │    read(fd, addr, len)  ← FileDispatcherImpl.c:83  │ │
    │  │    jlong_to_ptr(address) ← same file:82             │ │
    │  │    ((DirectBuffer)buf).address()+pos ← IOUtil.java │ │
    │  └──────────────────────────────────────────────────┘ │
    │                                                       │
    │  ┌──────────────────────────────────────────────────┐ │
    │  │ 路径 B: HeapBuffer (慢, ≥3 次拷贝)                │ │
    │  │                                                    │ │
    │  │   kernel buffer                                    │ │
    │  │        │ read(fd, tempAddr, len)                    │ │
    │  │        ▼                                           │ │
    │  │   temp native buffer  ← allocateTemporaryDirect   │ │
    │  │        │                                           │ │
    │  │        │ memcpy: native → heap byte[]               │ │
    │  │        ▼                                           │ │
    │  │   heap byte[]  ← IOUtil.java fallback path         │ │
    │  │        │                                           │ │
    │  │        │ buf.get()/getInt()                        │ │
    │  │        ▼                                           │ │
    │  │   Java layer                                       │ │
    │  └──────────────────────────────────────────────────┘ │
    │                                                       │
    │  ┌──────────────────────────────────────────────────┐ │
    │  │ 路径 C: sendfile64 (最快文件传输, 0 次用户态拷贝)  │ │
    │  │                                                    │ │
    │  │   disk → page cache (kernel)                       │ │
    │  │        │                                           │ │
    │  │        │ sendfile64(dstFD, srcFD, &offset, count)  │ │
    │  │        ▼                                           │ │
    │  │   kernel socket buffer                             │ │
    │  │        │                                           │ │
    │  │        │ NIC DMA                                   │ │
    │  │        ▼                                           │ │
    │  │   网卡 — 全程无用户态参与                            │ │
    │  │                                                    │ │
    │  │   源码: FileChannelImpl.c:135:                      │ │
    │  │     sendfile64(dstFD, srcFD, &offset, (size_t)count)│ │
    │  └──────────────────────────────────────────────────┘ │
    └──────────────────────────────────────────────────────┘
```

**对比**: 路径 A 的 DirectBuffer 是最佳通用方案——仅 1 次 DMA 拷贝 (kernel → native mem)，Java 层通过 `address + position` 偏移直接访问。路径 B 是兼容 fallback——每次 I/O 需要额外分配临时 DirectBuffer + 2 次 memcpy (native↔heap)。路径 C 是文件传输专用——sendfile64 全程在内核态完成，Kafka 的核心性能基石。

---

## §二 First-Principles Design Decisions

### 1. 为什么选择 epoll 而不是 select/poll？

| 系统调用 | 复杂度 | 10K fd 开销 | 问题 |
|---------|:---:|:---:|------|
| **select** | O(n) | 每次 select 遍历 10K 个 fd → ~10ms | FD_SETSIZE 上限 1024；每次调用必须重新传入整个 fd_set |
| **poll** | O(n) | 每次 poll 遍历 10K 个 fd → ~10ms | 无 fd 数限制，但仍然遍历全量 |
| **epoll** | O(1) | 仅返回就绪 fd → ~0.1ms | 每次只返回有事件的 fd，**100x** 优势 |

**epoll 的核心机制**: epoll_ctl 将 fd 注册到内核的 epoll 实例中——内核维护一棵红黑树 + 就绪链表。epoll_wait 直接从就绪链表取 fd ——不遍历全量。与 select/poll 的 O(n) 扫描相比，epoll 单次查询开销与注册 fd 总数无关——对于 10K 连接的服务器，epoll 快 100x。

**源码验证**: `epoll_wait` 的 C 实现中直接返回就绪 fd 数量，不迭代全量 fd (EPoll.c:87)。

### 2. Level-triggered vs Edge-triggered — Java NIO 的选择

**源码验证结果**: Java NIO 使用 **level-triggered** (水平触发) epoll。

`translateInterestOps()` (SocketChannelImpl.java:1057-1065) 只返回 `EPOLLIN (0x1) | EPOLLOUT (0x4)`，不设置 `EPOLLET` 标志。EPoll.java:63-67 定义的事件常量中根本没有 `EPOLLET` 常量。

- **Level-triggered**: 只要 fd 仍有数据可读，每次 epoll_wait 都返回该 fd。优点：即使程序没有一次读完全部数据，select 返回后仍会被再次通知。缺点：对慢连接可能导致重复通知。
- **Edge-triggered** (需要设置 EPOLLET 标志): 仅在数据**首次到达**时通知一次。要求程序必须循环 read() 直到返回 EAGAIN。优点：零冗余通知。风险：如果只读部分数据，剩余数据不会被再次通知。

Java 选择 level-triggered 的设计理由：简化编程模型。用户不需要在每次 select 返回后循环读取到底——即使在一次 read 中只读 1 byte，下次 select 仍然会返回。

### 3. 为什么 DirectByteBuffer 用于 I/O 而不是 HeapBuffer？

| 操作 | DirectBuffer | HeapBuffer |
|------|:---:|:---:|
| I/O 数据路径 | NIC → kernel buffer → `read(fd, directAddr, len)` | NIC → kernel buffer → native temp buffer → JNI → heap byte[] → temp → copy back to heap |
| 内存拷贝次数 | 1 次 (kernel → native mem) | ≥3 次 (kernel→native→GC heap→native→GC heap) |
| 地址稳定性 | 稳定——GC 不移动 native 内存 | 不稳定——GC 可能移动 heap 对象 |
| 分配成本 | `UNSAFE.allocateMemory()` — 慢 | `new byte[]` — 快 |
| 释放 | Cleaner/PhantomReference — 延迟 | GC — 及时 |

**源码验证**:

分配 (Direct-X-Buffer.java.template:112-140):
```java
Bits.reserveMemory(size, cap);                        // [1] 检查 maxDirectMemory
long base = UNSAFE.allocateMemory(size);              // [2] malloc
UNSAFE.setMemory(base, size, (byte) 0);               // [3] 清零
this.address = base;                                   // [4] 保存地址
cleaner = Cleaner.create(this, new Deallocator(base, size, cap)); // [5] 注册释放回调
```

I/O 路径 (IOUtil.java 等价逻辑): `((DirectBuffer)buf).address() + pos` → `long` → `read(fd, (void*)addr, len)`。

HeapBuffer fallback: 先分配临时 DirectBuffer → 拷贝 heap→native → I/O → 拷贝 native→heap。

### 4. 为什么 sendfile64 用于 FileChannel.transferTo？

```
Without sendfile:
  disk → kernel buffer → read() → user buffer (Java heap) → write() → kernel socket buffer → NIC
  4 copies, 2 context switches (user↔kernel)

With sendfile64:
  disk → kernel buffer → sendfile64(fd_out, fd_in, &offset, count) → kernel socket buffer → NIC
  2 copies (both in kernel), 0 copies to user space, 1 context switch
```

**源码验证** (FileChannelImpl.c:133-147):
```c
#if defined(__linux__)
    off64_t offset = (off64_t)position;
    jlong n = sendfile64(dstFD, srcFD, &offset, (size_t)count);
    // Returns bytes transferred; EAGAIN→UNAVAILABLE; EINVAL→UNSUPPORTED_CASE
```

**Java 层三层 fallback** (FileChannelImpl.java:678-686):
1. `transferToDirectly()` → sendfile64 (零拷贝，最快)
2. `transferToTrustedChannel()` → mmap + write (一次拷贝，备用)
3. `transferToArbitraryChannel()` → byte[] read/write 循环 (慢路径)

**sendfile64 的限制**: 仅支持 fd_out 是 socket，fd_in 是普通文件。不支持管道、任意 WritableByteChannel。Java 通过 `transferSupported`、`pipeSupported`、`fileSupported` 三个 volatile boolean 标记内核能力 (FileChannelImpl.java:471-483)。

### 5. 为什么需要 dup2 trick 关闭 socket？

**问题**: 线程 A 阻塞在 `read(sockfd, buf, len)`。线程 B 调用 `Socket.close()` → `close(sockfd)`。Linux 上 `close(fd)` 释放 fd，但正在进行的 `read()` **不会返回**——线程 A 永久阻塞。

**解决方案 — dup2 trick** (PlainSocketImpl.c:783-785, linux_close.c:328-334):
```c
// 不是 close(fd)，而是 dup2(marker_fd, fd)
NET_Dup2(marker_fd, fd);   // 把 fd 替换为 /dev/null 等价 fd
// 阻塞的 read() 在替换后的 fd 上返回 EBADF → 线程唤醒
```

**完整机制** (linux_close.c:275-321):
1. 锁住 fdEntry→lock（阻止 fd 上的新 I/O 操作）
2. `dup2(fd1, fd2)` — 将 fd2 替换为 fd1 的副本（marker_fd 是一个 shutdown 过的 AF_UNIX socketpair 的一端）
3. 遍历 `fdEntry→threads` 链表 — 标记 `intr=1`
4. 对每个阻塞线程发送 `pthread_kill(thr, WAKEUP_SIGNAL)` — 信号处理器 `sig_wakeup()` 是空函数，仅用于中断系统调用
5. 线程被唤醒后 `endOp` 检测到 `intr=1` → 设置 `errno=EBADF` → I/O 返回 -1

**竞态条件防护**: 在 dup2 和 true close 之间，另一个线程可能打开新 socket 复用同一个 fd 号。Java 两层防护：
1. `closefd()` 全程持有 `fdEntry→lock` (linux_close.c:286)
2. Java 侧 `socketClose0` 先 dup2 到 marker_fd，再 close — Java 不再引用原 fd 号

### 6. 为什么非阻塞 connect + EINPROGRESS？

**阻塞 connect**: 线程阻塞直到 TCP 三次握手完成 → 1-3 秒（远程主机）→ 10K 连接 × 3s = 30,000s（8.3 小时）。

**非阻塞 connect 流程** (PlainSocketImpl.c:311-401, Net.c:306-327):

```
1. SET_NONBLOCKING(fd)                               // PlainSocketImpl.c:317
2. connect(fd) → errno=EINPROGRESS                   // PlainSocketImpl.c:320
   → Net.connect0(fd) → connect(fd)                  // Net.c:317
     → errno==EINPROGRESS → return IOS_UNAVAILABLE   // Net.c:319-320
3. poll(fd, POLLOUT, timeout)                        // PlainSocketImpl.c:341-348
4. getsockopt(fd, SOL_SOCKET, SO_ERROR)              // PlainSocketImpl.c:388
   → connect_rv == 0 → 连接成功
   → connect_rv != 0 → 连接失败（错误码在 SO_ERROR）
5. SET_BLOCKING(fd)                                  // PlainSocketImpl.c:395
```

在 **NIO Selector 模型**下更高效:
```
sc.connect() → register(selector, OP_CONNECT)
selector.select() → epoll_wait 返回 EPOLLOUT → finishConnect() → getsockopt(SO_ERROR)
```

### 7. 为什么 1 个 Selector 线程管理 10K 连接？

**BIO (Blocking I/O)**: 每连接一线程 → 10K 线程 × 1MB 栈 = 10GB 内存 → 上下文切换吃掉 CPU。

**NIO**: 1 个 Selector 线程 → epoll_wait 返回就绪 fd → 只处理活跃连接 → 其他 9,900 空闲连接零 CPU 开销。

**源码验证**:
- epoll_wait 只返回就绪 fd 数量 (EPoll.c:87-96)：空闲连接在内核中就绪链表为空，不产生开销。
- fdToKey HashMap 允许 O(1) 查找 (EPollSelectorImpl.java:66)：就绪 fd → key 转换无遍历。
- NUM_EPOLLEVENTS ≤ 1024 (EPollSelectorImpl.java:53)：单次 epoll_wait 最多处理 1024 个就绪事件。

**生产扩展 — Boss-Worker Reactor 模型** (详见 §四 02 文档)：

单 Selector 线程处理 10K 连接所有 I/O 仍有瓶颈——`processEvents` 逐个处理就绪 channel 时，后处理的 channel 有排队延迟。生产框架 (Netty) 的解决方案是 **Boss/Worker 拆分**：

```
Boss Selector 线程 (1个):
  │
  │  epoll_wait on ServerSocketChannel (OP_ACCEPT)
  │
  ├─ SocketChannel 就绪 → accept() → 获取新 SocketChannel
  │
  └─ 分发新 SocketChannel 给 Worker Selector
       │
       ▼
Worker Selector 线程 (N个，通常 = CPU核数):
  │
  │  epoll_wait on SocketChannel (OP_READ | OP_WRITE)
  │
  ├─ 就绪 fd → processEvents → 分发到业务线程池
  │
  └─ key.interestOps() 更新事件 → EPollSelectorImpl.setEventOps → 排入 updateKeys 队列
```

**关键**: Boss 只负责 accept 连接——不处理 I/O 数据，保证新连接接受不受 I/O 处理阻塞。Worker 负责所有 I/O——每个 Worker 管理 ~1K 连接，`doSelect` 循环 (EPollSelectorImpl.java:102-138) 中的 `processEvents` 串行迭代在 1K 连接范围内排队延迟可接受。`SelectorImpl.lockAndDoSelect` 使用 `synchronized(this)` (SelectorImpl.java:114) ——同一 Selector 的 register/select 互斥，但不同 Worker Selector 之间无锁竞争。见 02 文档 Reactor 多线程 Selector 模型板块。

### 8. 为什么 wakeup 用 pipe 而不是信号？

**Pipe 方案** (当前实现):
```
wakeup() → write(fd1, 1 byte) → epoll 检测 fd0 有 EPOLLIN → epoll_wait 返回
→ processEvents 发现 fd==fd0 → drain(fd0) → 清除 interrupt
```

**信号方案的缺陷**:
- 信号处理器运行在任意线程上下文 → 不能安全操作 Selector 的共享状态 (fdToKey 等)
- 信号处理器中加锁 → 死锁风险（如果信号到达时已持有同一锁）
- 信号可能丢失 (SIGUSR1 不排队)
- POSIX 信号安全函数限制严格 (只能调用 async-signal-safe 函数)

**Pipe 方案优势**: wakeup 和正常事件处理发生在**同一线程** (Selector 线程)，不存在并发问题。

---

## §三 源文件总表 — 完整清单 (94 个文件)

> 图例: **✅ Deep Analysis** = §一/§二已深度分析 | **📋 Inventoried** = 已列出但浅覆盖 | **🔲 Out of Scope** = 有其他 Phase 覆盖或独立子系统

### A. Native 层 — libnio.so (Linux/Unix C 文件)

| 文件 (相对路径) | 行数 | 覆盖 | 关键函数 / 角色 |
|------|:---:|:---:|------|
| **EPoll.c** — `linux/native/libnio/ch/` | 97 | ✅ | `epollCreate(256)` → `epoll_create()`; `epollCtl` → `epoll_ctl(ADD/MOD/DEL)`; `epollWait` → `epoll_wait()`; `eventSize/eventsOffset/dataOffset` — struct 布局查询 |
| **IOUtil.c** — `unix/native/libnio/ch/` | 230 | ✅ | `makePipe(pipe+fctntl)`; `write1/drain/drain1` — wakeup pipe 操作; `fdLimit(getrlimit)/iovMax(sysconf)`; `convertReturnVal/convertLongReturnVal` — errno→Java status; `configureBlocking(fcntl O_NONBLOCK)` |
| **Net.c** — `unix/native/libnio/ch/` | 814 | ✅ | `socket0(socket+IPV6_V6ONLY=0+SO_REUSEADDR)`; `connect0(EINPROGRESS→UNAVAILABLE)`; `bind0/listen`; `getIntOption0/setIntOption0(SO_LINGER/SO_SNDBUF/IP_TOS)`; `poll/pollinValue/polloutValue` |
| **FileDispatcherImpl.c** — `unix/native/libnio/ch/` | 373 | ✅ | `read0(read→convertReturnVal)`; `readv0(readv→convertLongReturnVal)`; `write0/writev0`; `seek0`; `force0(fsync/fdatasync)`; `close0/preClose0/closeIntFD` |
| **FileChannelImpl.c** — `unix/native/libnio/ch/` | 247 | ✅ | `map0(mmap64)`; `unmap0(munmap)`; **`transferTo0` — `sendfile64(dstFD, srcFD, &offset, count)`** |
| **SocketChannelImpl.c** — `unix/native/libnio/ch/` | ~250 | ✅ | `checkConnect` — 验证非阻塞 connect(getsockopt SO_ERROR); `sendOutOfBandData` — 紧急数据发送 |
| **ServerSocketChannelImpl.c** — `unix/native/libnio/ch/` | ~200 | ✅ | `accept0` — 接受连接; `initIDs` — JNI field/method cache |
| **SocketDispatcher.c** — `unix/native/libnio/ch/` | ~40 | ✅ | `read0/write0/readv0/writev0` → 委托 FileDispatcherImpl — SocketDispatcher.java 的 native 对等 |
| **NativeThread.c** — `unix/native/libnio/ch/` | ~70 | 📋 | `NativeThread_init/current/signal` — 异步 I/O 线程生命周期 (AIO 子系统使用) |
| **MappedByteBuffer.c** — `unix/native/libnio/` | ~200 | 📋 | `load0/isLoaded0/force0` (msync 等价); `unmapper` — mmap 映射内存管理 (配合 FileChannelImpl.map) |
| **nio_util.c** — `share/native/libnio/` | ~70 | 📋 | `JNI_OnLoad` 注册 JNI; `nio_util.h` — libnio.so 初始化 + 共享工具常量 |
| **FileKey.c** — `unix/native/libnio/ch/` | ~70 | 📋 | `FileKey_init` — 从 st_dev/st_ino 构造文件唯一标识 (FileLock 文件标识) |
| **DatagramChannelImpl.c** — `unix/native/libnio/ch/` | ~350 | 📋 | `receive0(sendto)/send0(recvfrom)/disconnect0` — UDP NIO 完整 native 实现 |
| **DatagramDispatcher.c** — `unix/native/libnio/ch/` | ~50 | 📋 | `read0/write0` via recvfrom/sendto — UDP Socket 分发器 |
| **PollSelectorImpl.c** — `unix/native/libnio/ch/` | ~60 | 📋 | poll() 系统调用的 JNI 包装 — epoll 不可用时的 fallback Selector |
| **InheritedChannel.c** — `unix/native/libnio/ch/` | ~250 | 📋 | `System.inheritedChannel()` — inetd 风格 fd 继承; SO_TYPE 探测 stdin/stdout 是否为 socket |
| **UnixAsynchronousSocketChannelImpl.c** — `unix/native/libnio/ch/` | ~200 | 🔲 | AIO socket read/write — 异步 I/O 子系统 |
| **UnixAsynchronousServerSocketChannelImpl.c** — `unix/native/libnio/ch/` | ~150 | 🔲 | AIO server accept — 异步 I/O 子系统 |

### B. Native 层 — libnet.so (Linux/Unix C 文件)

| 文件 (相对路径) | 行数 | 覆盖 | 关键函数 / 角色 |
|------|:---:|:---:|------|
| **PlainSocketImpl.c** — `unix/native/libnet/` | 1038 | ✅ | `socketCreate(socket+IPv6 dual-stack)`; `socketConnect(non-blocking+EINPROGRESS wait)`; `socketBind/socketListen/socketAccept`; `socketClose0(dup2 trick)`; `socketSetOption0/socketGetOption(SO_LINGER etc.)` |
| **linux_close.c** — `linux/native/libnet/` | 450 | ✅ | `closefd(lock+dup2/close+WAKEUP_SIGNAL)`; `NET_Dup2/NET_SocketClose`; `NET_Read/NET_Accept/NET_Connect` — BLOCKING_IO_RETURN_INT 宏; `NET_Timeout(poll with timeout)` |
| **SocketInputStream.c** — `unix/native/libnet/` | ~100 | 📋 | `socketRead0` — java.net.SocketInputStream 的 native read (BIO 路径, 非 NIO) |
| **SocketOutputStream.c** — `unix/native/libnet/` | ~80 | 📋 | `socketWrite0` — java.net.SocketOutputStream 的 native write (BIO 路径) |
| **SocketImpl.c** — `unix/native/libnet/` | ~50 | 📋 | `socketCreate/socketClose/socketBind` — AbstractPlainSocketImpl 的 native stub |
| **PlainDatagramSocketImpl.c** — `unix/native/libnet/` | ~300 | 🔲 | UDP DatagramSocket 的 native 实现 (java.net 传统 API, 非 NIO) |
| **Inet4AddressImpl.c** — `unix/native/libnet/` | ~200 | 🔲 | IPv4 地址解析 (getaddrinfo/gethostbyaddr) — 网络层, 非 I/O 层 |
| **Inet6AddressImpl.c** — `unix/native/libnet/` | ~300 | 🔲 | IPv6 地址解析 — 网络层 |
| **InetAddressImplFactory.c** — `unix/native/libnet/` | ~40 | 🔲 | 地址工厂 — 选择 Inet4/Inet6 实现 |
| **NetworkInterface.c** — `unix/native/libnet/` | ~800 | 🔲 | 网络接口枚举 (getifaddrs) — 网络层 |
| **net_util_md.c/.h** — `unix/native/libnet/` | ~300 | 🔲 | 平台网络工具 (preferredIPv4Stack, IPv6 avail test) — 网络配置 |
| **net_util.c/.h** — `share/native/libnet/` | ~400 | 🔲 | 共享网络工具 (InetAddress 构造, sockaddr 转换) — 网络层 |
| **portconfig.c** — `unix/native/libnet/` | ~80 | 🔲 | Solaris port 配置 — Solaris 平台 |
| **SdpSupport.c** — `unix/native/libnet/` | ~100 | 🔲 | InfiniBand Sockets Direct Protocol 支持 — 特殊硬件 |
| **ResolverConfigurationImpl.c** — `unix/native/libnet/` | ~80 | 🔲 | DNS resolver 配置 — 网络配置 |
| **proxy_util.c/.h** — `share/native/libnet/` | ~100 | 🔲 | 代理设置工具 — 网络配置 |
| **DefaultProxySelector.c** — `unix/native/libnet/` | ~150 | 🔲 | 系统代理自动检测 — macOS/Unix 代理 |
| **DatagramPacket.c** — `share/native/libnet/` | ~50 | 🔲 | DatagramPacket JNI — 传统 API |
| **InetAddress.c / Inet4Address.c / Inet6Address.c** — `share/native/libnet/` | ~300 | 🔲 | InetAddress JNI 共享实现 — 网络层 |

### C. Java 内部实现 — sun.nio.ch 包 (share + unix + linux)

| 文件 | 行数 | 覆盖 | 关键符号 / 角色 |
|------|:---:|:---:|------|
| **EPoll.java** — `linux/classes/sun/nio/ch/` | 122 | ✅ | EPOLL_CTL_ADD/DEL/MOD, EPOLLIN/EPOLLOUT, EPOLLONESHOT, allocatePollArray, getEvent/getDescriptor/getEvents |
| **EPollSelectorImpl.java** — `linux/classes/sun/nio/ch/` | 270 | ✅ | epollCreate+makePipe, doSelect, processUpdateQueue, processEvents, wakeup, fdToKey |
| **EPollSelectorProvider.java** — `linux/classes/sun/nio/ch/` | ~40 | 📋 | SPI: `openSelector()` → new EPollSelectorImpl |
| **DefaultSelectorProvider.java** — `linux/classes/sun/nio/ch/` | ~30 | 📋 | 平台选择: Linux→EPollSelectorProvider, macOS→KQueue |
| **EPollPort.java** — `linux/classes/sun/nio/ch/` | ~200 | 🔲 | epoll-based async I/O port — AIO 子系统 |
| **DefaultAsynchronousChannelProvider.java** — `linux/classes/sun/nio/ch/` | ~30 | 🔲 | AIO SPI — 平台选择 |
| **LinuxAsynchronousChannelProvider.java** — `linux/classes/sun/nio/ch/` | ~30 | 🔲 | AIO SPI — Linux 实现 |
| **SelectorImpl.java** — `share/classes/sun/nio/ch/` | 311 | ✅ | register, lockAndDoSelect, implCloseSelector, processDeregisterQueue, processReadyEvents |
| **IOUtil.java** — `share/classes/sun/nio/ch/` | ~400 | ✅ | read/write (DirectBuffer→address 提取), writeFromNativeBuffer/readIntoNativeBuffer, writev/readv (scatter/gather) |
| **IOVecWrapper.java** — `share/classes/sun/nio/ch/` | 162 | ✅ | SIZE_IOVEC, putBase/putLen (struct iovec), ThreadLocal 缓存 |
| **FileChannelImpl.java** — `share/classes/sun/nio/ch/` | 1215 | ✅ | transferTo 三层 fallback: sendfile→mmap+write→byte[]; transferSupported/pipeSupported/fileSupported 能力探测 |
| **SocketChannelImpl.java** — `share/classes/sun/nio/ch/` | 1129 | ✅ | read/write (单+scatter/gather), translateInterestOps(OP_READ→POLLIN), translateReadyOps, state machine (ST_UNCONNECTED→ST_CONNECTED) |
| **ServerSocketChannelImpl.java** — `share/classes/sun/nio/ch/` | ~500 | ✅ | accept, bind, translateInterestOps |
| **Net.java** — `share/classes/sun/nio/ch/` | ~400 | ✅ | translateToSocketException, checkAddress, translateToSysReturn — socket 选项 Java 协议 |
| **IOStatus.java** — `share/classes/sun/nio/ch/` | ~50 | ✅ | EOF=-1, UNAVAILABLE=-2, INTERRUPTED=-3, THROWN=-4 — convertReturnVal 返回码 Java 语义 |
| **SocketDispatcher.java** — `unix/classes/sun/nio/ch/` | 61 | ✅ | read/write/readv/writev → 委托 FileDispatcherImpl |
| **SelectionKeyImpl.java** — `share/classes/sun/nio/ch/` | ~150 | 📋 | interestOps/readyOps 管理 — fd→key 映射中的 value |
| **SelChImpl.java** — `share/classes/sun/nio/ch/` | ~30 | 📋 | SelectableChannel 实现接口: getFDVO, translateAndSetReadyOps 等 |
| **SelectorProviderImpl.java** — `share/classes/sun/nio/ch/` | ~70 | 📋 | SelectorProvider 基类 — openDatagramChannel/openPipe 等 |
| **FileDispatcherImpl.java** — `unix/classes/sun/nio/ch/` | ~80 | 📋 | FileDispatcher 的 Unix 实现 — 声明 native 连接 |
| **FileDispatcher.java** — `share/classes/sun/nio/ch/` | ~50 | 📋 | 抽象 FileDispatcher — read/write/force/lock 接口 |
| **NativeDispatcher.java** — `share/classes/sun/nio/ch/` | ~30 | 📋 | 抽象 NativeDispatcher — read/write/pread 接口 |
| **NativeObject.java** — `share/classes/sun/nio/ch/` | ~40 | 📋 | native 内存 wrapper — allocationAddress, address 返回 |
| **AllocatedNativeObject.java** — `share/classes/sun/nio/ch/` | ~30 | 📋 | Unsafe.allocateMemory wrapper — IOVecWrapper 等使用 |
| **NativeThreadSet.java** — `share/classes/sun/nio/ch/` | ~60 | 🔲 | 线程 ID set 管理 — AIO 子系统 |
| **NativeThread.java** — `unix/classes/sun/nio/ch/` | ~50 | 🔲 | native 线程方法 — AIO 子系统 |
| **PipeImpl.java** — `unix/classes/sun/nio/ch/` | ~200 | 📋 | Pipe.SinkChannel/SourceChannel — pipe() 系统调用包装 |
| **SinkChannelImpl.java** — `unix/classes/sun/nio/ch/` | ~200 | 📋 | Pipe sink 实现 |
| **SourceChannelImpl.java** — `unix/classes/sun/nio/ch/` | ~200 | 📋 | Pipe source 实现 |
| **PollSelectorImpl.java** — `unix/classes/sun/nio/ch/` | ~200 | 📋 | poll() 系统调用的 Selector 实现 — epoll 不可用时的 fallback |
| **PollSelectorProvider.java** — `unix/classes/sun/nio/ch/` | ~30 | 📋 | SPI: openSelector() → new PollSelectorImpl |
| **Port.java** — `unix/classes/sun/nio/ch/` | ~100 | 🔲 | Solaris Event Completion Framework — Solaris 平台 |
| **DatagramChannelImpl.java** — `share/classes/sun/nio/ch/` | ~1200 | 📋 | UDP Channel 实现 — send/receive/connect/disconnect, multicast join/leave |
| **DatagramSocketAdaptor.java** — `share/classes/sun/nio/ch/` | ~150 | 📋 | DatagramChannel → DatagramSocket 适配器 |
| **DatagramDispatcher.java** — `unix/classes/sun/nio/ch/` | ~50 | 📋 | UDP I/O 分发器 |
| **MembershipKeyImpl.java** — `share/classes/sun/nio/ch/` | ~100 | 📋 | 多播组成员管理 |
| **MembershipRegistry.java** — `share/classes/sun/nio/ch/` | ~80 | 📋 | 多播组注册表 |
| **FileKey.java** — `unix/classes/sun/nio/ch/` | ~40 | 📋 | 文件 key JNI 包装 — FileLock 标识 |
| **FileLockImpl.java** — `share/classes/sun/nio/ch/` | ~80 | 📋 | FileLock 实现 |
| **FileLockTable.java** — `share/classes/sun/nio/ch/` | ~100 | 📋 | FileLock 表管理 |
| **InheritedChannel.java** — `unix/classes/sun/nio/ch/` | ~200 | 📋 | System.inheritedChannel() — inetd fd 继承 |
| **SocketAdaptor.java** — `share/classes/sun/nio/ch/` | ~300 | 📋 | SocketChannel → java.net.Socket 适配器 |
| **ServerSocketAdaptor.java** — `share/classes/sun/nio/ch/` | ~200 | 📋 | ServerSocketChannel → java.net.ServerSocket 适配器 |
| **ChannelInputStream.java** — `share/classes/sun/nio/ch/` | ~100 | 📋 | ReadableByteChannel → InputStream 适配器 |
| **OptionKey.java** — `share/classes/sun/nio/ch/` | ~30 | 📋 | Socket option key — level+name 元组 |
| **ExtendedSocketOption.java** — `share/classes/sun/nio/ch/` | ~30 | 📋 | 扩展 socket 选项常量 |
| **DirectBuffer.java** — `share/classes/sun/nio/ch/` | ~20 | 📋 | DirectBuffer 接口 — address() 方法, cleaner 返回 |
| **Util.java** — `share/classes/sun/nio/ch/` | ~300 | 📋 | NIO 工具 — TemporaryBuffer 池, SelectorProvider 加载, default thread pool |
| **Reflect.java** — `share/classes/sun/nio/ch/` | ~40 | 📋 | 反射辅助 — 访问控制绕过 |
| **Secrets.java** — `share/classes/sun/nio/ch/` | ~20 | 📋 | 内部访问桥梁 |
| **Cancellable.java** — `share/classes/sun/nio/ch/` | ~15 | 🔲 | 取消接口 — AIO 子系统 |
| **CompletedFuture.java** — `share/classes/sun/nio/ch/` | ~40 | 🔲 | 已完成 Future — AIO 子系统 |
| **Groupable.java** — `share/classes/sun/nio/ch/` | ~15 | 🔲 | 通道组接口 — AIO 子系统 |
| **Interruptible.java** — `share/classes/sun/nio/ch/` | ~15 | 🔲 | 中断接口 — AIO 子系统 |
| **Invoker.java** — `share/classes/sun/nio/ch/` | ~80 | 🔲 | 异步调用器 — AIO 子系统 |
| **PendingFuture.java** — `share/classes/sun/nio/ch/` | ~80 | 🔲 | 待定 Future — AIO 子系统 |
| **ThreadPool.java** — `share/classes/sun/nio/ch/` | ~150 | 🔲 | 线程池 — AIO 子系统 |
| **AsynchronousChannelGroupImpl.java** — `share/classes/sun/nio/ch/` | ~200 | 🔲 | AIO 通道组实现 |
| **AsynchronousFileChannelImpl.java** — `share/classes/sun/nio/ch/` | ~300 | 🔲 | 异步 FileChannel — AIO 子系统 |
| **AsynchronousServerSocketChannelImpl.java** — `share/classes/sun/nio/ch/` | ~150 | 🔲 | 异步 ServerSocket — AIO 子系统 |
| **AsynchronousSocketChannelImpl.java** — `share/classes/sun/nio/ch/` | ~700 | 🔲 | 异步 SocketChannel — AIO 子系统 |
| **SimpleAsynchronousFileChannelImpl.java** — `share/classes/sun/nio/ch/` | ~200 | 🔲 | 简单异步 FileChannel — 线程池执行同步 I/O |
| **UnixAsynchronousServerSocketChannelImpl.java** — `unix/classes/sun/nio/ch/` | ~150 | 🔲 | AIO Unix server — AIO 子系统 |
| **UnixAsynchronousSocketChannelImpl.java** — `unix/classes/sun/nio/ch/` | ~250 | 🔲 | AIO Unix socket — AIO 子系统 |

### D. Java 公共 API — java.nio / java.nio.channels 包 (对外接口)

| 文件 | 行数 | 覆盖 | 角色 |
|------|:---:|:---:|------|
| **Buffer.java** — `share/classes/java/nio/` | ~500 | 🔲 | Buffer 基类 (position/limit/capacity/mark) — Phase 03-object-model 覆盖 |
| **MappedByteBuffer.java** — `share/classes/java/nio/` | ~200 | 📋 | mmap 映射的 ByteBuffer — 与 FileChannelImpl.map 配合 |
| **Bits.java** — `share/classes/java/nio/` | ~700 | 📋 | reserveMemory/allocateMemory/freeMemory — DirectBuffer 分配的全局配额管理 |
| **ByteOrder.java** — `share/classes/java/nio/` | ~50 | 📋 | BIG_ENDIAN/LITTLE_ENDIAN/nativeOrder — 字节序 |
| **BufferMismatch.java** — `share/classes/java/nio/` | ~100 | 🔲 | JDK 11+ 缓冲区不匹配检测 — JDK 内部工具 |
| **CharBufferSpliterator.java** — `share/classes/java/nio/` | ~100 | 🔲 | CharBuffer Spliterator — Stream API |
| **StringCharBuffer.java** — `share/classes/java/nio/` | ~80 | 🔲 | String 包装 CharBuffer |
| **Channel.java** — `share/classes/java/nio/channels/` | ~30 | 📋 | 根接口: isOpen()/close() |
| **InterruptibleChannel.java** — `share/classes/java/nio/channels/` | ~30 | 📋 | 可中断通道接口 |
| **ReadableByteChannel.java** — `share/classes/java/nio/channels/` | ~30 | 📋 | read(ByteBuffer) |
| **WritableByteChannel.java** — `share/classes/java/nio/channels/` | ~30 | 📋 | write(ByteBuffer) |
| **ByteChannel.java** — `share/classes/java/nio/channels/` | ~20 | 📋 | ReadableByteChannel + WritableByteChannel 组合 |
| **ScatteringByteChannel.java** — `share/classes/java/nio/channels/` | ~30 | 📋 | read(ByteBuffer[]) — scatter read |
| **GatheringByteChannel.java** — `share/classes/java/nio/channels/` | ~30 | 📋 | write(ByteBuffer[]) — gather write |
| **SeekableByteChannel.java** — `share/classes/java/nio/channels/` | ~50 | 📋 | position()/size()/truncate() — FileChannel 接口 |
| **NetworkChannel.java** — `share/classes/java/nio/channels/` | ~30 | 📋 | bind()/getLocalAddress()/setOption()/getOption() |
| **MulticastChannel.java** — `share/classes/java/nio/channels/` | ~40 | 📋 | join()/close() — 多播接口 |
| **MembershipKey.java** — `share/classes/java/nio/channels/` | ~80 | 📋 | 多播成员 key — block/unblock |
| **SelectableChannel.java** — `share/classes/java/nio/channels/` | ~100 | 📋 | configureBlocking()/register()/blockingLock()/validOps() |
| **SelectionKey.java** — `share/classes/java/nio/channels/` | ~200 | 📋 | OP_READ/WRITE/CONNECT/ACCEPT, interestOps()/readyOps(), attach() |
| **Selector.java** — `share/classes/java/nio/channels/` | ~300 | 📋 | open()/select()/selectedKeys()/wakeup()/close() |
| **Pipe.java** — `share/classes/java/nio/channels/` | ~80 | 📋 | open() → SourceChannel/SinkChannel 内部类 |
| **SocketChannel.java** — `share/classes/java/nio/channels/` | ~300 | 📋 | open()/bind()/connect()/read()/write(), socket() → Socket adaptor |
| **ServerSocketChannel.java** — `share/classes/java/nio/channels/` | ~150 | 📋 | open()/bind()/accept(), socket() → ServerSocket adaptor |
| **FileChannel.java** — `share/classes/java/nio/channels/` | ~500 | 📋 | open()/read()/write()/map()/transferTo()/transferFrom()/lock() |
| **FileLock.java** — `share/classes/java/nio/channels/` | ~200 | 📋 | 文件锁 — position/size/shared/isValid/release |
| **DatagramChannel.java** — `share/classes/java/nio/channels/` | ~400 | 📋 | open()/bind()/connect()/send()/receive() — UDP public API |
| **Channels.java** — `share/classes/java/nio/channels/` | ~200 | 📋 | 工具方法: newInputStream/newOutputStream/newReader/newWriter — Channel↔Stream 桥接 |
| **CompletionHandler.java** — `share/classes/java/nio/channels/` | ~30 | 🔲 | completed()/failed() 回调 — AIO 公共接口 |
| **AsynchronousChannel.java** — `share/classes/java/nio/channels/` | ~30 | 🔲 | 异步通道基接口 — AIO 子系统 |
| **AsynchronousByteChannel.java** — `share/classes/java/nio/channels/` | ~40 | 🔲 | 异步字节通道 — AIO 子系统 |
| **AsynchronousChannelGroup.java** — `share/classes/java/nio/channels/` | ~80 | 🔲 | 异步通道组 — AIO 子系统 |
| **AsynchronousFileChannel.java** — `share/classes/java/nio/channels/` | ~200 | 🔲 | 异步文件通道 — AIO 子系统 |
| **AsynchronousServerSocketChannel.java** — `share/classes/java/nio/channels/` | ~100 | 🔲 | 异步 ServerSocket — AIO 子系统 |
| **AsynchronousSocketChannel.java** — `share/classes/java/nio/channels/` | ~150 | 🔲 | 异步 SocketChannel — AIO 子系统 |
| **AbstractInterruptibleChannel.java** — `share/classes/java/nio/channels/spi/` | ~80 | 📋 | close() 中断协调 — Channel 实现的 SPI 基类 |
| **AbstractSelectableChannel.java** — `share/classes/java/nio/channels/spi/` | ~150 | 📋 | configureBlocking/register 实现 — SelectableChannel 的 SPI 基类 |
| **AbstractSelectionKey.java** — `share/classes/java/nio/channels/spi/` | ~50 | 📋 | isValid/cancel 基础实现 |
| **AbstractSelector.java** — `share/classes/java/nio/channels/spi/` | ~100 | 📋 | Selector 基类 — wakeup/close/provider |
| **SelectorProvider.java** — `share/classes/java/nio/channels/spi/` | ~200 | 📋 | SPI: provider()/openSelector/openSocketChannel 等 |
| **AsynchronousChannelProvider.java** — `share/classes/java/nio/channels/spi/` | ~50 | 🔲 | AIO provider SPI |

### E. 模板文件 (Template)

| 文件 | 行数 | 覆盖 | 角色 |
|------|:---:|:---:|------|
| **Direct-X-Buffer.java.template** — `share/classes/java/nio/` | 543 | ✅ | UNSAFE.allocateMemory + Cleaner+Deallocator, address() |
| **Direct-X-Buffer-bin.java.template** — `share/classes/java/nio/` | ~50 | 📋 | DirectBuffer 二进制操作模板 |
| **Heap-X-Buffer.java.template** — `share/classes/java/nio/` | ~600 | 🔲 | HeapBuffer 实现 — Phase 03-object-model 覆盖 |
| **X-Buffer.java.template** — `share/classes/java/nio/` | ~1500 | 🔲 | Buffer 抽象基类模板 — Phase 03-object-model 覆盖 |
| **X-Buffer-bin.java.template** — `share/classes/java/nio/` | ~50 | 🔲 | Buffer 二进制操作模板 |
| **ByteBufferAs-X-Buffer.java.template** — `share/classes/java/nio/` | ~200 | 🔲 | ByteBuffer 视图 (IntBuffer/LongBuffer 等) |

### 覆盖统计

| 分类 | 总数 | ✅ Deep Analysis | 📋 Inventoried | 🔲 Out of Scope |
|------|:---:|:---:|:---:|:---:|
| libnio Native (A) | 18 | 10 | 5 | 3 |
| libnet Native (B) | 20 | 2 | 4 | 14 |
| sun.nio.ch Java (C) | 58 | 17 | 23 | 18 |
| java.nio Public API (D) | 41 | 0 | 21 | 20 |
| Templates (E) | 6 | 1 | 1 | 4 |
| **合计** | **143** | **30** | **54** | **59** |

> **布局变更说明**: 此 JDK 版本中，`EPollArrayWrapper.c` 已被合并入 `EPoll.c`。`Net.c`、`SocketDispatcher.c`、`FileDispatcherImpl.c` 从 `libnet/` 迁移至 `libnio/ch/`。

---

## §四 文档规划

> **叙事方法**: 每篇文档从开发者日常编写的 Java 代码出发 — 逐行揭秘背后的 JVM native 层 + Linux 内核实现。源码是证据，故事是主角。

### 3 篇文档总览

| # | 文档 | 核心故事 | 目标行数 |
|---|------|---------|:---:|
| 00 | **Server-Selector-Engine.md** | 你写了一个 NIO echo server — `open()`/`bind()`/`register()`/`select()`/`accept()` 每一行背后发生的事 | ~5000 |
| 01 | **Socket-Data-Close.md** | client `connect()` 为什么不是立即完成 → `read(DirectBuffer)` 数据怎么到达 → `close()` 的并发安全问题 | ~5000 |
| 02 | **ZeroCopy-Threads-Diag.md** | 怎么让它快 100 倍 — sendfile 零拷贝 / Reactor 多线程 / 生产问题诊断工具箱 | ~5000 |

### 00 — Server-Selector-Engine.md（~5000 行）

**Java 引子** (~200 行): 一段完整的 NIO echo server 代码

**正文** (~4800 行) — 按代码执行顺序逐行展开：

| 板块 | 行 | 对应代码 | 深度覆盖 |
|------|:--:|---------|---------|
| `ServerSocketChannel.open()` | ~600 | `open()` | `socket(AF_INET6, SOCK_STREAM, 0)` → `setsockopt(IPV6_V6ONLY, 0)` 双栈设计原理 → `setsockopt(SO_REUSEADDR, 1)` 自动设置 → 对比 `PlainSocketImpl.c` BIO 路径 → Linux `struct sockaddr_in6` 与 IPv4-mapped 地址 `::ffff:a.b.c.d` → 反事实: 如果 `IPV6_V6ONLY=1` 需要两套 socket |
| `server.bind(8080)` | ~300 | `bind(8080)` | `Net.bind0` → `NET_Bind` → POSIX `bind()` → `EADDRINUSE` 错误全景 → `SO_REUSEADDR` 与 TIME_WAIT 的交互 → 内核端口分配机制 |
| `server.listen(50)` | ~200 | `listen(50)` | `Net.listen` → POSIX `listen(fd, backlog)` → `min(backlog, somaxconn)` 内核静默截断 → TCP SYN 队列 vs accept 队列 → `ss -lnt` 诊断 `Recv-Q` 积压 |
| `Selector.open()` | ~1200 | `Selector.open()` | `EPollSelectorProvider.openSelector()` → `new EPollSelectorImpl(sp)` 完整构造 → `epoll_create(256)` size hint 真相 (Linux 2.6.8+ 忽略) → 内核 `struct eventpoll` — 红黑树 + ready-list 双向链表 → `allocatePollArray` + `sizeof(epoll_event)`/`offsetof` 动态 struct layout 查询 (跨平台必要性) → `IOUtil.makePipe(false)` — `pipe(fd)` + `fcntl(O_NONBLOCK)` 双端 → `((jlong)fd0 << 32) | fd1` 打包 → `epoll_ctl(ADD, fd0, EPOLLIN)` 注册 wakeup pipe |
| `server.register(sel, OP_ACCEPT)` | ~600 | `register(sel, ACCEPT)` | `AbstractSelectableChannel.register()` → `SelectorImpl.register()` → `fdToKey.putIfAbsent(fd, ski)` → `setEventOps(ski)` → `updateKeys` Deque 延迟队列 → 为什么延迟？epoll_ctl 是昂贵 syscall，批量批处理 → `processUpdateQueue()` 批量 epoll_ctl ADD/MOD/DEL → `EPoll.ctl()` 进入 native → `epoll_ctl(epfd, opcode, fd, &event)` → `event.data.fd = fd` 存储 → 内核 `ep_insert()` 插入红黑树 O(logN) 在 `ep->mtx` 下 |
| `sel.select()` | ~1200 | `select()` | `lockAndDoSelect()` 获取 Selector 内部锁 → `processUpdateQueue()` 先处理延迟注册 → `processDeregisterQueue()` → `doSelect()` 核心循环 → `begin(blocking)` 虚拟线程准备 → `EPoll.wait()` → `jlong_to_ptr(address)` 转换 → `epoll_wait(epfd, events, 1024, timeout)` 阻塞 → EINTR 中断处理: SIGPROF @100Hz → `to -= elapsed` 精确超时调整 (为什么必要：不调整则 100Hz 下永不返回) → `processEvents(numEntries, action)` → `EPoll.getEvent(address+12*i)` → `EPoll.getDescriptor(event)` = `Unsafe.getInt(addr+4)` → `fdToKey.get(fd)` HashMap O(1) → level-triggered 证明: `EPoll.java` 只有 `EPOLLIN=0x1`, `EPOLLOUT=0x4` — 无 `EPOLLET` → `translateInterestOps()` 只返回这三者 → NUM_EPOLLEVENTS=1024 的设计: 旧栈安全 + LT 保证不丢事件 → IOStatus: INTERRUPTED=-3, THROWN=-5 → `end(blocking)` |
| wakeup pipe 完整故事 | ~500 | `wakeup()` | `selector.wakeup()` 谁调、何时调 → `synchronized(interruptLock)` → `IOUtil.write1(fd1, (byte)0)` → `write(fd, &c, 1)` → 内核检测 1 字节 → fd0 标记 EPOLLIN ready → `epoll_wait` 返回 → `processEvents` 检测 `fd == fd0` → `clearInterrupt()` → `IOUtil.drain(fd0)` 循环 `read()` 16 字节块直到 EAGAIN → `interruptTriggered` 去重 → 反事实: 为什么不用 POSIX 信号 (signal handler: async-signal-unsafe + SIGUSR1 coalescing + synchronized 死锁) |
| epoll bug 完整史记 | ~800 | 诊断 | Linux <2.6.27 `ep_remove()` bug 源码分析 → `struct epitem` 从红黑树移除但 ready-list 连接未清除 → stale epitem 残留 → `epoll_wait` 遍历 ready-list → `ffd.file == NULL` → 返回 0 而非阻塞 → Java 侧: `doSelect` 收到 0 → `numEntries != INTERRUPTED` → 退出循环 → 上层反复重试 → 100% CPU → 触发条件: RecycledSelector 模式 (频繁 unregister + reregister) → JDK 9+ 修复: `EPollArrayWrapper` 在 DEL 前清 pending events → 降级方案: `-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider` → 三步诊断: `uname -r` + `strace epoll_wait` + `jcmd Thread.print` |
| Mermaid + 诊断 | ~300 | — | 4-lane 全链路序列图: Java → NIO → JNI → Kernel → GDB 6 断言: EPoll.c:61,78,87 + IOUtil.c:110 + processEvents + IOUtil.drain → strace 完整 trace → `/proc/{pid}/fd/` + `/proc/{pid}/fdinfo/` |

**IN**: `EPoll.c`(全量), `EPollSelectorImpl.java`(全量), `EPoll.java`(全量), `IOUtil.c`(makePipe/write1/drain/fdLimit), `EPollSelectorProvider.java`, `SelectorImpl.java`(lockAndDoSelect), `IOStatus.java`
**OUT**: `Net.c` socket/connect/bind/listen (→ 01), `DirectByteBuffer` (→ 01), `sendfile` (→ 02)
**前置**: [09-native-interface] JNI 基础, [11-os-layer] epoll 系统调用签名

---

### 01 — Socket-Data-Close.md（~5000 行）

**Java 引子** (~200 行): NIO client 连接代码 + server 端 `channel.read(buf)` 代码

**正文** (~4800 行):

| 板块 | 行 | 对应代码 | 深度覆盖 |
|------|:--:|---------|---------|
| 非阻塞 `connect()` | ~800 | `connect(addr)` | `Net.connect0` (Net.c:306-327) 完整源码 → `connect(fd, &sockaddr)` → `errno == EINPROGRESS` → `IOS_UNAVAILABLE` — 这不是错误，是握手进行中 → 注册 `OP_CONNECT` 到 epoll → TCP 三次握手内核轨迹 → `epoll_wait` 返回 `EPOLLOUT` → `finishConnect()` → `checkConnect()` (SocketChannelImpl.c:49-88) → `poll(fd, POLLOUT)` 第一步 + `getsockopt(fd, SO_ERROR)` 第二步 → `SO_ERROR` 值: 0=成功, ECONNREFUSED=端口无监听, EHOSTUNREACH=主机不可达, ENETUNREACH=网络不通 → `POLLHUP` 额外检查 → connect timeout: `tcp_syn_retries` 内核行为 (default 6 → ~127s) → BIO 对比: `PlainSocketImpl.c socketConnect` poll 循环 + nano-timeout 调整 |
| `SocketChannel` 状态机 | ~300 | 状态转换 | 五态: `ST_UNCONNECTED(0)` → `connect()` → `ST_PENDING(1)` → `finishConnect()` → `ST_CONNECTED(2)` → `close()` → `ST_KILLPENDING(3)` → `ST_KILLED(4)` → `translateInterestOps()` 映射: PENDING→OP_CONNECT, CONNECTED→OP_READ, KILL→0 |
| `channel.read(DirectBuffer)` | ~1500 | `read(buf)` | **DirectBuffer 分配**: `ByteBuffer.allocateDirect(cap)` → `Bits.reserveMemory(size, cap)` 配额检查 → `Unsafe.allocateMemory(n)` → `Cleaner.create(this, new Deallocator(address))` → `address` 字段存储 native ptr → **读取路径**: `SocketChannel.read(buf)` → `IOUtil.read(fd, buf, -1, nd)` → `((DirectBuffer)buf).address() + pos` 计算目标地址 → `FileDispatcherImpl.read0(fd, addr, rem)` → `read(fd, (void*)jlong_to_ptr(addr), len)` → 内核: TCP socket buffer → `tcp_recvmsg()` → `copy_to_user()` → DMA 到 DirectBuffer native 地址 → **HeapBuffer fallback**: 无 stable address → 分配临时 DirectBuffer → `put` → `flip` → `read` → `get` 拷贝回 heap → 额外 2 次 memcpy → **Scatter/Gather**: `IOVecWrapper` → `malloc(iov_len)` 构建 native `struct iovec[]` → `readv(fd, iov, cnt)` / `writev(fd, iov, cnt)` → 减少 syscall 次数 → **Deallocator 生命周期**: PhantomReference → GC 检测 DirectByteBuffer 对象不可达 → Cleaner 线程执行 `Deallocator.run()` → `Unsafe.freeMemory(address)` → `Bits.unreserveMemory(size, cap)` 释放配额 → OOM 场景: `-XX:MaxDirectMemorySize` 耗尽 → DirectBuffer 不参与年轻代 GC → 需要 Full GC 才能回收 |
| Socket Options | ~700 | `setOption()` | `Net.setIntOption0` (Net.c:446-497) 完整源码 → `setsockopt(fd, level, opt, val, len)` → `SO_LINGER`: `struct linger {l_onoff, l_linger}` → `l_onoff=1, l_linger=0` → `close()` 发 RST 跳过 TIME_WAIT → 代价: 可能丢未确认数据 → `TCP_NODELAY`: 禁用 Nagle 算法 → `setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, 1)` → 小包立即发送 → `SO_KEEPALIVE`: 空闲连接探测 → `SO_RCVBUF/SO_SNDBUF`: 内核 buffer 大小调整 → `IP_TOS`: 流量分类 → `getsockopt SO_ERROR` 在 connect 失败后的验证 |
| `server.accept()` 完整路径 | ~500 | `accept()` | `ServerSocketChannelImpl.accept0` (ServerSocketChannelImpl.c:77-119) → POSIX `accept(ssfd, &sockaddr, &addrlen)` → `ECONNABORTED` 重试循环 → `EAGAIN/EWOULDBLOCK → IOS_UNAVAILABLE` → `EINTR → IOS_INTERRUPTED` → EMFILE → `JNU_ThrowIOExceptionWithLastError` → Java 侧: `configureBlocking(true)` 临时切换阻塞 → `accept0()` → `SecurityManager.checkAccept()` → `configureBlocking(false)` 恢复 → fd 泄漏防护: SecurityException → catch 中 close newfd |
| `channel.close()` — dup2 trick | ~1000 | `close()` | **为什么 direct `close(fd)` 不够**: Linux 上 `close()` 不打断阻塞的 `read(fd)` → 线程永久挂起 → **三层防护**: `closefd()` (linux_close.c:275-321) → Layer 1: `pthread_mutex_lock(&fdEntry->lock)` 阻止新 I/O → Layer 2: `dup2(marker_fd, fd)` 替换 fd 号为预 shutdown 的 AF_UNIX socketpair endpoint → 已阻塞的 `read()` 操作在 marker fd 上 → 立即返回 EBADF → Layer 3: `pthread_kill(thr, WAKEUP_SIGNAL=SIGRTMAX-2)` 双重保障 → `sig_wakeup()` 空 handler 仅用于中断 syscall → 竞态防护: `fdEntry->lock` 全流程持有 + `BLOCKING_IO_RETURN_INT` 后验证 → BIO 封装: `NET_Read`/`NET_Accept`/`NET_Connect` 全部经此宏 → `endOp()` 检查 `fdEntry->intr` → 若关闭中则覆写 errno=EBADF → NIO 路径: `epoll_wait` 不受 BLOCKING_IO_RETURN_INT 影响 (epoll instance 持有 fd ref) |
| BIO vs NIO 完整对比 | ~300 | — | `PlainSocketImpl.c` (libnet.so) vs `Net.c` (libnio.so) — 为什么同一功能两套实现 → BIO: 阻塞 I/O + poll timeout loop + SO_LINGER closing → NIO: 非阻塞 + EINPROGRESS 立即返回 + Java 层 Selector 管理 → 共享: `linux_close.c` closefd, `IPV6_V6ONLY=0`, `SO_REUSEADDR` |

**IN**: `Net.c`(socket0/connect0/bind0/listen), `PlainSocketImpl.c`(socketCreate/socketConnect/socketClose0), `linux_close.c`(closefd/BLOCKING_IO_RETURN_INT/信号处理), `ServerSocketChannelImpl.c`(accept0), `SocketChannelImpl.c`(checkConnect), `Direct-X-Buffer.java.template`(allocateDirect/Cleaner/Deallocator), `IOUtil.java`(read/write + HeapBuffer fallback), `FileDispatcherImpl.c`(read0/write0), `IOVecWrapper.java`
**OUT**: epoll/Selector 事件循环 (→ 00), sendfile 零拷贝 (→ 02)
**前置**: [00-Server-Selector-Engine] Selector register/select 机制, [11-os-layer] socket + connect 系统调用

---

### 02 — ZeroCopy-Threads-Diag.md（~5000 行）

**Java 引子** (~200 行): Kafka `fileChannel.transferTo()` 代码 + Reactor Boss/Worker 架构图

**正文** (~4800 行):

| 板块 | 行 | 深度覆盖 |
|------|:--:|---------|
| `FileChannel.transferTo` sendfile 零拷贝 | ~1500 | `FileChannelImpl.transferTo()` → `transferTo0(dstFD, srcFD, &offset, count)` → `sendfile64(dstFD, srcFD, &offset, count)` (FileChannelImpl.c) → Linux 内核数据路径: 磁盘 DMA → page cache → `splice()` or DMA gather → socket buffer → NIC — **0 次用户态拷贝** → EAGAIN retry loop (partial transfer) → EINTR retry → EINVAL → **三条 fallback**: `transferToDirectly` (sendfile64 成功, 0 次拷贝) → `transferToTrustedChannel` (mmap 文件 + `write()` 到 socket, 1 次内核拷贝, 8MB chunk 循环) → `transferToArbitraryChannel` (`read()` 到 heap byte[] → `write()` 到 socket, 2 次拷贝 + 2 次 syscall) → EINVAL → `IOS_UNSUPPORTED_CASE` → Java 自动降级触发 → 能力探测: `transferSupported`/`pipeSupported`/`fileSupported` → 平台差异: Linux `sendfile64` vs macOS `sendfile` (header 区别) vs AIX `send_file` vs Solaris `sendfilev64` → mmap vs sendfile benchmark: 10GB 文件 → sendfile: 0 次用户态拷贝, mmap: 1 次, heap: 2 次 |
| Reactor 多线程 Selector 模型 | ~1200 | Boss/Worker 架构 → 多 Selector 线程 `select()` 并发 → `SelectorImpl.lockAndDoSelect()` → `synchronized(this)` 独占 Selector → `inSelect` 标志防重入 → Boss 线程: `accept()` → `workerSelector.wakeup()` → `register(newSocketChannel, OP_READ)` → Worker 线程: `select()` → `processEvents()` → 分发 handler → 多 Worker 负载均衡 → Selector 关闭流程: `implClose()` → 先 `wakeup()` 确保 select 返回 → `epoll_ctl(DEL)` 所有注册 fd → fast close + drain → `interestOps` 变更陷阱: `key.interestOps(OP_WRITE)` 仅排入 updateKeys 队列 → next `select()` 才生效 → 如果新 ops 需要立即处理，必须手动 `wakeup()` → JavaDoc `Selector` 类明确说明了这一点 → Netty 的 `NioEventLoop` 实现模式 |
| epoll bug 深度复盘 + 诊断 | ~800 | Linux <2.6.27 `fs/eventpoll.c:ep_remove()` bug 源码级复现 → stale `struct epitem` → `ffd.file == NULL` → ready-list 遍历每一轮都发现它 → `epoll_wait` 返回 0 而非阻塞 → Java 侧: `doSelect` 收到 0 → 非 INTERRUPTED → 退出循环 → 上层反复重试 → RecycledSelector 模式精准触发条件 → JDK 9+ 修复: `EPollArrayWrapper` 在 DEL 前主动调用 `epoll_ctl` 变体清 events → poll 降级: `-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider` → 三步诊断: `uname -r` + `strace -e epoll_wait` + `jcmd Thread.print | grep doSelect` → 反事实: 如果 Java 用 edge-triggered 根本不会触发此 bug → 但代价是所有 NIO 代码需要改成 "循环读到 EAGAIN" |
| 生产诊断工具链全集 | ~800 | **strace**: `epoll_create`/`epoll_ctl`/`epoll_wait` + `socket`/`bind`/`listen`/`accept4`/`connect` + `sendfile64`/`mmap` + `dup2`/`close` + `pipe2`/`fcntl`/`write`/`read` — 完整生命周期 trace 的正常输出 vs 异常输出 (EMFILE, epoll 0 返回, EINVAL) → **GDB**: `Net.socket0`, `Net.connect0`, `EPoll.epollWait`, `closefd`, `ServerSocketChannelImpl.accept0`, `SocketChannelImpl.checkConnect`, `FileChannelImpl.transferTo0` — 7 断点 → **/proc**: `fd/` 计数, `fdinfo/` epoll 监视详情, `limits` 查看 ulimit, `net/somaxconn` 队列限制, `net/tcp_syn_retries` 连接超时 → **ss -lnt**: `Send-Q` backlog, `Recv-Q` 积压 → **jcmd**: `Thread.print` 线程栈, `VM.native_memory` DirectBuffer 用量 |
| 面试题集 (12 题) | ~700 | Q1: epoll vs select — O(1) vs O(n), 10K fd benchmark → Q2: 非阻塞 connect — EINPROGRESS + SO_ERROR 两步验证 → Q3: wakeup pipe vs 信号 → Q4: LT vs ET — Java 的选择 → Q5: dup2 trick 三重防护 → Q6: DirectBuffer vs HeapBuffer — break-even → Q7: sendfile vs mmap → Q8: Kafka 用 sendfile 的原因 → Q9: selector.select() 不返回的原因 → Q10: maxDirectMemory 限制 → Q11: epoll 100% CPU 根因 → Q12: Loom Virtual Thread — Selector 还需要吗？ |
| 生产场景速查表 | ~400 | EMFILE → dup2 trick 关闭 → sendfile EINVAL fallback → epoll 100% CPU → TIME_WAIT flood (SO_LINGER RST) → OOM DirectBuffer → `accept()` 不返回 (队列积压) → `select()` 不返回 (interestOps 未 wakeup) — 每个场景: 症状 → 根因 → 诊断命令 → 修复方案 |

**IN**: `FileChannelImpl.c`(transferTo0/map0/unmap0), `FileChannelImpl.java`(transferTo/三条fallback), `SelectorImpl.java`(lockAndDoSelect), `Net.c`(poll/setsockopt wrappers), `PlainSocketImpl.c`(SO_LINGER), 诊断工具链全部
**OUT**: socket 创建+连接 (→ 01), DirectBuffer 分配/回收 (→ 01)
**前置**: [00-Server-Selector-Engine] Selector 引擎, [01-Socket-Data-Close] socket 连接 + DirectBuffer 生命周期

---

## §五 面试题 (12 题，源码验证)

### Tier 1 — 基础

**1. "epoll vs select/poll — 为什么？"**

select: O(n) — 每次 select() 内核遍历**所有** fd 检查就绪状态。10K fd → 10K 次检查 → ~10ms/次。
epoll: O(1) — 内核维护就绪链表，epoll_wait 直接返回就绪 fd。空闲连接零开销。
→ EPoll.c:87-96 — `epoll_wait` 直接返回就绪 fd 数量，不迭代全量。
→ EPollSelectorImpl.java:53 — 单次 `epoll_wait` 最多返回 `min(fdLimit(), 1024)` 个事件。

**2. "NIO non-blocking connect 怎么工作？"**

1. `socket(fd, O_NONBLOCK)` — 设置非阻塞
2. `connect(fd)` → returns EINPROGRESS — TCP 握手已启动但未完成 → Net.c:319
3. 注册 OP_CONNECT 到 Selector (translateInterestOps: OP_CONNECT→POLLOUT)
4. epoll_wait 返回 → fd 的 events 包含 EPOLLOUT
5. `getsockopt(fd, SOL_SOCKET, SO_ERROR)` 检查连接是否成功 → PlainSocketImpl.c:388

→ 10K 连接同时发起 → ~3s 全部完成（vs 阻塞：~8 小时）

**3. "Selector.wakeup 怎么实现？"**

`wakeup()` → `IOUtil.write1(fd1, (byte)0)` — 向 pipe 写端写 1 字节 → EPollSelectorImpl.java:254
epoll 检测到 fd0 (pipe 读端) 有数据就绪 → epoll_wait 返回 → `processEvents` 发现 `fd==fd0` → `drain(fd0)` 读空 pipe → 清除中断标志 → EPollSelectorImpl.java:192,202,264-268

### Tier 2 — 设计

**4. "为什么 Java NIO 使用 level-triggered 而不是 edge-triggered？"**

Level-triggered: epoll_wait 只要有未读数据就持续返回。不需要程序保证读到底。
Edge-triggered: 只在新数据到达时通知一次。用户必须循环 read() 直到 EAGAIN。

Java 选 level-triggered: 简化编程模型。程序不需要保证每次 read 到底——即使在一次 read 中只读 1 byte，下次 select 仍然返回。

源码验证: `translateInterestOps()` 只返回 `EPOLLIN|EPOLLOUT`，不设置 `EPOLLET` 标志 → SocketChannelImpl.java:1057-1065, EPoll.java:63-64.

**5. "为什么 wakeup 用 pipe 而不是信号？"**

Pipe: wakeup 处理发生在 Selector 线程自身 → 无并发问题。
信号: 处理器运行在任意线程上下文 → 不能安全操作 Selector 共享状态 (fdToKey HashMap 等) → 信号处理器中加锁有死锁风险 → async-signal-safe 函数限制严格。
→ 源码: wakeup 和 clearInterrupt 都在 Selector 线程中执行 (EPollSelectorImpl.java:181-204)

**6. "dup2 trick 为什么需要？详细解释竞态条件和防护。**"

1. 线程 A 阻塞在 `read(fd)` → 线程 B 调用 `close(fd)` → Linux 上 `read()` 不返回 → 线程 A 永久阻塞
2. 解决方案: `dup2(marker_fd, fd)` — 将 fd 替换为 shutdown 的 /dev/null 等价 fd → 正在进行的 `read()` 在新 fd 上返回 EBADF → 线程 A 被唤醒
3. 信号辅助: `pthread_kill(thr, WAKEUP_SIGNAL)` 中断系统调用 → linux_close.c:308
4. **竞态**: dup2 后但 close 前，另一个线程可能 `socket()` 拿到同一个 fd 号 → 新的 socket 被误关闭
5. **防护**: `closefd()` 全程持有 `fdEntry→lock` → 阻止新 I/O 在 fd 上开始 → linux_close.c:286
→ PlainSocketImpl.c:783-785, linux_close.c:275-343

### Tier 3 — 性能

**7. "DirectByteBuffer 的分配成本 vs HeapBuffer 的 I/O 成本——break-even 是多少？"**

- DirectBuffer 分配: `UNSAFE.allocateMemory(n)` — malloc 系统调用，~1-10μs，由 Cleaner 延迟回收
- HeapBuffer I/O 额外成本: 每次 I/O 分配临时 DirectBuffer + 两次 memcpy (heap↔native) — 对于 1MB buffer，额外 ~2ms
- Break-even: 如果 Buffer 被重复使用 >10 次 → 用 DirectBuffer。一次性使用 → HeapBuffer 更快
→ Direct-X-Buffer.java.template:112-135 (分配), IOUtil.java (heap→native→heap fallback)

**8. "sendfile 和 mmap 的区别——什么时候用哪个？"**

- sendfile: 内核态完成传输，0 次用户空间拷贝。限制: out_fd 必须是 socket
- mmap: 映射文件到用户地址空间，1 次拷贝 (kernel→user mmap 区域)
- Java: `transferToDirectly` (sendfile) → 失败用 `transferToTrustedChannel` (mmap + write，每次 8MB 块) → 最差用 `transferToArbitraryChannel` (byte[] 慢路径)
→ FileChannelImpl.java:678-686 (三层 fallback), FileChannelImpl.c:135 (sendfile64)

### Tier 4 — 生产

**9. "Kafka 为什么用 sendfile 而不是 DirectBuffer 读 + SocketChannel 写？"**

sendfile: 1 次系统调用，0 次用户态内存拷贝。磁盘 → kernel buffer → socket buffer → NIC。
DirectBuffer 读+写: 2 次系统调用 + 1 次 memcpy (kernel→user direct buffer→kernel socket buffer)。CPU 更高，带宽更低。
→ FileChannelImpl.c:135: `sendfile64(dstFD, srcFD, &offset, count)` — 单系统调用完成传输

**10. "maxDirectMemory 限制是什么？为什么需要？"**

`-XX:MaxDirectMemorySize` 默认为堆大小。DirectBuffer 不会被年轻代 GC 回收——Java 对象 (DirectByteBuffer) 很小（~100 bytes），native 内存却是 heap 外的——GC 不追踪 native 内存用量。只有 DirectByteBuffer 对象本身不可达且被 GC + Cleaner 执行后，native 内存才被释放。如果没有限制 → 大量 allocateDirect → native OOM (不是 Java OOM，是系统 OOM killer)。
→ Direct-X-Buffer.java.template:118: `Bits.reserveMemory(size, cap)` 检查限制
→ Direct-X-Buffer.java.template:89,96: `UNSAFE.freeMemory(address)` 在 Deallocator.run() 中

### Tier 5 — 未来

**11. "如果 Linux 有 io_uring——Java 的 NIO 怎么演进？"**

io_uring: 提交 I/O 请求到共享环形缓冲区 → 内核异步完成 → 批量获取结果。零系统调用 I/O (当 SQ poll 启用时)。Java NIO 的 epoll + read/write 需要 2 次系统调用 (epoll_wait + read)。io_uring 可以提交 batch I/O (1000 个 read)，等待所有完成→单次批量回收。潜在改进: 10x latency reduction for small I/O。

**12. "Project Loom 的 Virtual Thread——Selector 还需要吗？"**

Virtual Thread 将阻塞调用 (read/write) 通过 JVM 的 continuations 挂起虚拟线程而非 OS 线程。但底层 I/O 仍然需要 Selector/epoll 来管理 readiness notification。Loom 的革新在于调度层——不再需要手动 Selector 线程——而不是替代内核 I/O 多路复用机制。epoll 仍然是 10K 连接场景下的最优选择。

---

## §六 生产场景诊断

| Scenario | Symptom | Doc | Diagnostic |
|---------|---------|-----|------------|
| **Selector 100% CPU spin** | select() 立即返回 0 在 tight loop 中 | 00/02 | Linux <2.6.27 ep_remove bug: stale epitem 残留在 ready-list → 每次 epoll_wait 返回 0 → 三步诊断: `uname -r` + `strace -e epoll_wait` + `jcmd Thread.print | grep doSelect` → 修复: 升级内核 或 `-Djava.nio.channels.spi.SelectorProvider=sun.nio.ch.PollSelectorProvider` |
| **Too many open files** | IOException: Too many open files at accept() | 01 | `ulimit -n 65536`。每个 TCP 连接消耗 1 fd → accept() 触发 EMFILE → ServerSocketChannelImpl.c accept0 → accept() 返回 -1 → `JNU_ThrowIOExceptionWithLastError` → 诊断: `ls /proc/{pid}/fd | wc -l` + `/proc/{pid}/limits` |
| **OOM DirectBuffer** | OutOfMemoryError: Direct buffer memory | 01 | DirectBuffer 不被年轻代 GC 回收 → 需要 Full GC 或 System.gc() → `Bits.reserveMemory` 配额耗尽 → `-XX:MaxDirectMemorySize` 调大 → 诊断: `jcmd VM.native_memory` |
| **sendfile returns EINVAL** | FileChannel.transferTo 不传输数据 | 02 | Linux sendfile64 不支持某些 fd 对 → Java 自动 fallback: transferToDirectly→transferToTrustedChannel(mmap+write)→transferToArbitraryChannel(byte[] 慢路径) → FileChannelImpl.java 三层重试 |
| **TIME_WAIT flood** | 30,000+ TIME_WAIT sockets, can't accept new | 01 | SO_LINGER {l_onoff=1, l_linger=0} → close() 发 RST 跳过 TIME_WAIT → 代价: 可能丢未确认数据 → 或 `sysctl net.ipv4.tcp_tw_reuse=1` → PlainSocketImpl.c:863-884 |
| **Selector.select() 不返回** | 程序卡死在 select() | 00/02 | 另一个线程调了 `key.interestOps()` 但没调 `selector.wakeup()` → Selector 不知道 interest set 变了 → EPollSelectorImpl.setEventOps 只排入队列 (line 242-247) → 下次 select 才生效 → 常见于 Netty Boss→Worker 注册新 Channel 时忘调 wakeup |

---

## §七 文档质量审计矩阵

| 文档 | 目标行数 | 源文件覆盖 | 概念深度 | 可操作性 |
|------|:---:|------|:---:|:---:|
| 00-Server-Selector-Engine.md | ~5000 | EPoll.c, EPollSelectorImpl.java, EPoll.java, IOUtil.c 关键段 | ★★★★★ | ★★★★★ |
| 01-Socket-Data-Close.md | ~5000 | Net.c, PlainSocketImpl.c, linux_close.c, Direct-X-Buffer, FileDispatcherImpl.c | ★★★★★ | ★★★★★ |
| 02-ZeroCopy-Threads-Diag.md | ~5000 | FileChannelImpl.c, FileChannelImpl.java, SelectorImpl.java | ★★★★☆ | ★★★★★ |

### 文档完成状态

| 文档 | 状态 | 说明 |
|------|:---:|------|
| **README.md** (本文档) | ✅ 已完成 | Phase 导航页 + 完整源码清单 + 面试题 + 诊断 + 详细文档规划 |
| 00-Server-Selector-Engine.md | ⬜ 待创建 | 从 NIO echo server 代码出发 → Selector+epoll 完整引擎 + epoll bug 史记 |
| 01-Socket-Data-Close.md | ⬜ 待创建 | 从 client connect 代码出发 → socket 生命周期 + DirectBuffer I/O + dup2 close |
| 02-ZeroCopy-Threads-Diag.md | ⬜ 待创建 | 从 Kafka sendfile 代码出发 → 零拷贝 + Reactor 多线程 + 生产诊断全集 |

---

## §八 深层问题 (12 题，5 层)

| Tier | # | 问题 | 指向 |
|------|:---:|------|------|
| 🥉 Basic | 1 | 为什么需要 NIO？BIO 有什么问题？ | §二.7 |
| 🥉 Basic | 2 | epoll fd 是什么？和普通 fd 的区别？ | §一.1 |
| 🥉 Basic | 3 | SocketChannel.read(buf) — 数据怎么从网卡到 Java？ | §一.7 |
| 🥈 Design | 4 | 为什么选 level-triggered——何时用 edge-triggered 更优？ | §二.2 |
| 🥈 Design | 5 | 为什么 wakeup 用 pipe——信号方案有什么致命问题？ | §二.8 |
| 🥈 Design | 6 | dup2 trick 竞态条件如何被 Java 预防？ | §二.5 |
| 🥈 Design | 7 | transferTo 的三层 fallback——每一层存在的理由？ | §二.4 |
| 🥇 Performance | 8 | DirectBuffer 的分配成本 vs HeapBuffer 的 I/O 成本——break-even 是多少？ | §二.3 |
| 🥇 Performance | 9 | sendfile 和 mmap 的区别——什么时候用哪个？ | §二.4 |
| 💎 Production | 10 | Kafka 为什么用 sendfile 而不是 DirectBuffer 读+SocketChannel 写？ | §二.4 |
| 💎 Production | 11 | Netty PooledByteBufAllocator 如何减少 DirectBuffer 分配开销？ | §二.3, 02 文档 |
| 🔮 Future | 12 | Project Loom 的 Virtual Thread — Selector 还需要吗？ | §二.7, 02 文档 |

---

## §九 跨 Phase 连接

| Phase | Connection | 具体示例 |
|-------|-----------|---------|
| **09-native-interface** | 所有 I/O native 方法使用 JNI entry points | `Java_sun_nio_ch_EPoll_create` → EPoll.c:59, JNIEXPORT + JNICALL + JNIEnv* |
| **11-os-layer** | epoll_create / epoll_ctl / epoll_wait / sendfile64 / dup2 / pipe 等 POSIX 系统调用 | EPoll.c:61 → `epoll_create(256)`, FileChannelImpl.c:135 → `sendfile64()`, IOUtil.c:91 → `pipe()`, linux_close.c:297 → `dup2()` |
| **03-object-model** | DirectByteBuffer 的 Java 对象布局——`address` long field + Cleaner + Deallocator | Direct-X-Buffer.java.template:56 (address field), 69-94 (Deallocator), 96 (Cleaner) |
| **05-jit-compiler** | C2 将 `DirectBuffer.address()` 编译为直接内存访问 → 消除方法调用开销 | IOUtil.java:276:`((DirectBuffer)bb).address() + pos` — hotspot intrinsic 优化 |
| **15-core-native** | `convertReturnVal` / `convertLongReturnVal` 共用 JNI_ENTRY 模式 | IOUtil.c:178-224 — 与 System.c/nanoTime 共享同一套错误码转换惯式 |
| **14-zip-jimage** | jimage 使用 FileChannel.map → mmap64 → 同 libnio 的 map0 实现 | FileChannelImpl.c:94 → `mmap64(0, len, protections, flags, fd, off)` |

---

## §十 文档编写清单 — 3 篇子文档的源文件映射

> **阅读约定**: ①=主力(逐函数深度分析) | ②=辅助(引用关键函数) | ③=背景(一句话提及)

### 00-Server-Selector-Engine.md — NIO Server + Selector 引擎

| 级别 | 文件 | 分析重点 |
|:---:|------|------|
| ① | **EPoll.c** | 逐函数: eventSize/eventsOffset/dataOffset, epollCreate, epollCtl(ADD/MOD/DEL), epollWait(EINTR→IOS_INTERRUPTED) |
| ① | **EPollSelectorImpl.java** | 完整类: 构造函数, doSelect(EINTR loop), processUpdateQueue(批量 ctl), processEvents(fd→fdToKey), wakeup, clearInterrupt |
| ① | **EPoll.java** | Native 声明 + struct 布局常量 + allocatePollArray + getEvent/getDescriptor/getEvents(Unsafe 读写) |
| ② | **IOUtil.c** | makePipe(pipe+fcntl), write1, drain/drain1, fdLimit(getrlimit) |
| ② | **EPollSelectorProvider.java** | SPI: openSelector() → new EPollSelectorImpl |
| ② | **SelectorImpl.java** | lockAndDoSelect(synchronized this), inSelect 重入保护 |
| ② | **IOStatus.java** | INTERRUPTED=-3, THROWN=-5 |
| ③ | **PollSelectorImpl.java** | epoll fallback — poll 降级方案 |

### 01-Socket-Data-Close.md — Socket 连接 + 数据路径 + 关闭

| 级别 | 文件 | 分析重点 |
|:---:|------|------|
| ① | **Net.c** | socket0(AF_INET6+IPV6_V6ONLY+SO_REUSEADDR), connect0(EINPROGRESS), bind0, listen, handleSocketError(errno→Exception) |
| ① | **PlainSocketImpl.c** | socketCreate(BIO 双栈), socketConnect(BIO poll loop), socketClose0(SO_LINGER→dup2) |
| ① | **linux_close.c** | closefd(lock+dup2+WAKEUP_SIGNAL), BLOCKING_IO_RETURN_INT, NET_Read/Write/Accept/Connect |
| ① | **ServerSocketChannelImpl.c** | accept0(ECONNABORTED retry + EAGAIN/EINTR/EMFILE) |
| ① | **SocketChannelImpl.c** | checkConnect(poll+getsockopt SO_ERROR+POLLHUP) |
| ② | **Direct-X-Buffer.java.template** | allocateDirect(Bits.reserve→Unsafe.allocate→Cleaner+Deallocator), address() |
| ② | **IOUtil.java** | read/write (DirectBuffer 路径 + HeapBuffer fallback) |
| ② | **FileDispatcherImpl.c** | read0/write0(jlong_to_ptr→read/write), readv0/writev0 |
| ② | **IOVecWrapper.java** | native struct iovec → readv/writev |
| ② | **SocketChannelImpl.java** | 状态机 + translateInterestOps |
| ③ | PlainDatagramSocketImpl.c | UDP — 引用不展开 |

### 02-ZeroCopy-Threads-Diag.md — 零拷贝 + Reactor 线程 + 诊断

| 级别 | 文件 | 分析重点 |
|:---:|------|------|
| ① | **FileChannelImpl.c** | transferTo0(sendfile64), map0(mmap64), unmap0(munmap) |
| ① | **FileChannelImpl.java** | transferTo 三层 fallback + 能力探测 |
| ② | **SelectorImpl.java** | lockAndDoSelect + close→wakeup 协调 |
| ② | **Net.c** | setIntOption0/getIntOption0(setsockopt wrapper—SO_LINGER linger struct) |
| ② | **PlainSocketImpl.c** | socketSetOption0/socketGetOption(BIO 侧 option 处理) |
| ③ | 诊断工具 | strace/GDB//proc/ss/jcmd — 诊断汇总, 机制引用 00/01 |

### 汇总

| 文档 | 主力 ① | 辅助 ② | 背景 ③ | 总计 |
|------|:---:|:---:|:---:|:---:|
| 00-Server-Selector-Engine | 3 | 4 | 1 | 8 |
| 01-Socket-Data-Close | 5 | 5 | 1 | 11 |
| 02-ZeroCopy-Threads-Diag | 2 | 3 | 1 | 6 |
| **合计(去重)** | **10** | **10** | **2** | **22** |
