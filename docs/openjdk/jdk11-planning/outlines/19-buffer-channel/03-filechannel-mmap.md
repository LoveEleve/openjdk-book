# 03. FileChannel 与 mmap 零拷贝 — map、transferTo、文件锁

> 🔴 Deep | 域 19 Buffer 与 Channel 第 3 篇 | Layer 3
> 读者处境: 面试"零拷贝怎么实现"必考;生产大文件/高性能 IO——mmap 与 sendfile 的 Java 侧全景。

### 1. "FileChannel 是什么？" — 文件通道抽象

场景: `FileChannel.open(path)` 后能干什么——抽象方法与 native 边界

- `channels/FileChannel.java` — 抽象类: read(358)/write/position/size/force(564)/transferTo(629)/map(925)/lock(1021)
- 实现: `sun/nio/ch/FileChannelImpl.java` — read(208)/force(451,force0 native)/lock(1099,lock0 native)
- 定位: 阻塞式文件 IO 的"通道化"——比 FileInputStream 更完整的文件操作(映射/锁/截断)
- 关键设计 (斜体): *FileChannel = "文件的完整能力接口"(读写+映射+锁+截断),FileInputStream 只是"读流";面试"文件 IO 怎么选"——通用读用流,高级操作(锁/映射/批量)用通道*
- 生产: 文件锁(进程间互斥,域 17 createNewFile 的更强方案)
- [关联: 域 17 文件系统;内核: open/read/write(2)]

### 2. "map() 的 mmap 是什么？" — 内存映射文件

场景: `channel.map(READ_WRITE, 0, size)` — 文件怎么"变成内存"?

- `FileChannel.java:925` `map(MapMode, position, size)` → FileChannelImpl:928 → **`map0` native**(FileChannelImpl.java:1198)→ **mmap 系统调用**
- MapMode 三态(`FileChannel.java:805/811/817`): READ_ONLY/READ_WRITE/PRIVATE(写时复制)
- 返回 `MappedByteBuffer` — 堆外直接缓冲(地址直映文件页)
- 卸载: `unmap0`(1202 native)— JDK11 在 GC/显式时释放映射(898 调用)
- 关键设计 (斜体): *mmap 把"文件页"映射进进程地址空间——读写 buffer 即读写文件(OS 页缓存回写);vs read/write 的系统调用拷贝;大文件随机访问 mmap 完胜(免每次 read 系统调用+用户态拷贝)*
- [内核: mmap(2);内部卷 01-os(虚拟内存/页缓存)]
- 面试: "mmap 与普通读的区别"——用户态读写直映页缓存,少一次用户↔内核拷贝;写回由 OS 管理(force 刷盘)

### 3. "MappedByteBuffer 的 load/force" — 映射控制

场景: 映射后怎么"确保在内存"/"确保落盘"?

- `MappedByteBuffer.java:128` `isLoaded()` / `152` `load()` — **预加载页**(isLoaded0 native 215,pageCount 计算 136)
- `MappedByteBuffer.java:204` `force()` — **刷盘**(把脏页写回磁盘,对应 msync/fsync)
- 语义: load 减少后续缺页;force 保证持久性(崩溃恢复)
- 关键设计 (斜体): *load/force 是"页缓存管理"的 Java 入口——load 预热(大文件顺序读)、force 持久化(事务日志类场景);面试"mmap 数据什么时候落盘"——OS 页缓存回写或显式 force*
- 生产: 大文件排序/日志回放用 mmap;事务场景写后 force
- [内核: msync(2)/fsync(2);内部卷 01-os 页缓存]

### 4. "transferTo 零拷贝" — sendfile

场景: 复制大文件(`channel.transferTo`)— 为什么比流拷贝快?

- `FileChannel.java:629` `transferTo(position, count, target)` → FileChannelImpl:654
- **三级路径**(654-690): ① `transferToDirectly`(678, **sendfile 系统调用**,内核内完成拷贝)② `transferToTrustedChannel`(682,同 JVM 通道优化)③ 通用 IO 降级
- 零拷贝本质: 传统 read+write = 4 次拷贝(磁盘→内核→用户→内核→磁盘);sendfile = 1 次(磁盘→内核→目标,或 DMA)
- 关键设计 (斜体): *"零拷贝"= 数据不进用户态——sendfile 让内核直接把文件页发给 socket/目标 fd;面试"零拷贝几次拷贝"——传统 4 次 vs sendfile 2 次(免两次用户态中转);Kafka/Netty 零拷贝同源*
- [内核: sendfile(2);关联: 域 21 Selector(socket 通道与 transferTo 组合)]
- 生产: 大文件传输/日志复制优先 transferTo(同机/同 JVM 均可)

---

### 核心悬念

文件通道收官——但网络通道呢?`SocketChannel` 怎么注册到 `Selector`?epoll 是什么?IO 多路复用让一个线程管百万连接——下一篇(按写作顺序)先到域 21 Selector 与网络 NIO。

> → 下一篇: 域 21 Selector 与网络 NIO(21-selector 系列) | 关联: 域 32 堆外内存
