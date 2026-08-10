# NIO Network (libnio/libnet) — 文章大纲

> vol-06 · 域 42 · 🟡 B | JDK Native | 基于 Pass 0+1
>
> **→ 从 Core Native**：通用 native 桥极快——但 `System.arraycopy` 解决不了高并发。Netty/Kafka 全依赖 NIO 的 epoll Selector。

## 叙事计划

**开篇场景**：`Selector.open()` → `EPollSelectorImpl`(Java 层) 创建 epoll fd + `EPollArrayWrapper`(DirectByteBuffer, 8192 events)——`selector.select()` → `EPoll.c`(native, `java.base/linux/native/libnio/ch/EPoll.c`) → `epoll_wait(2)` 系统调用——阻塞直到 I/O 事件。

**第一层：epoll 引擎 — EPoll.c + EPollArrayWrapper**：`epollCreate`→`epollCtl(ADD/MOD/DEL)` 注册 fd→`epollWait` 阻塞。关键设计：`EPollArrayWrapper` 用 `DirectByteBuffer`(堆外内存) 存储 epoll_event 数组——Java 和 native 通过 `GetDirectBufferAddress` 共享同一块内存，消除 JNI 数组复制。返回事件由 `updateSelectedKeys()` 转 `SelectionKey`。源码：`EPoll.c`、`nio_util.c`(`share/native/libnio/nio_util.c`)。

**第二层：非阻塞 Socket I/O**：`SocketChannelImpl.configureBlocking(false)` → fcntl `O_NONBLOCK`。`connect()` 非阻塞→`EINPROGRESS`→Selector OP_CONNECT→`SO_ERROR` 检查。`read()`/`write()` 返回实际字节——`0`=暂时无数据。

**第三层：零拷贝 + 堆外内存**：`DirectByteBuffer` = `UNSAFE.allocateMemory()`(malloc) 堆外分配——GC 不移动。`FileChannel.transferTo()` → `sendfile64(2)` 内核态直接复制。`Cleaner`(PhantomReference) 在 GC 时释放（域 14 详述）。

## 核心悬念

**`selector.select()` → `epoll_wait()`：DirectByteBuffer 零拷贝事件数组 → epollCtl 注册 → epollWait 阻塞 → updateSelectedKeys 分发——四步构建 Java 高并发网络基石。**

→ 下一域：网络跑着——JVM 死锁时不能靠网络诊断。SA Postmortem ptrace 强读——零协作诊断。

## 预估

1 篇，3 层递进，1400-1800 行。
