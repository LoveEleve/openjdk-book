# 域 19: Buffer 与 Channel — 知识规划

> 源码路径: java.base/share/classes/java/nio/{Buffer.java + X-Buffer.java.template/Heap-X-Buffer.java.template/Direct-X-Buffer.java.template(构建生成) + MappedByteBuffer.java} + java/nio/channels/{FileChannel,Channels,FileLock}.java + sun/nio/ch/{FileChannelImpl,FileDispatcher,DirectBuffer}.java
> 源码量: ~15 文件(含模板)/ ~20,000 行 | 非巨型域
> 写作层: Layer 3(前置: 域 17 IO、32 Unsafe 堆外内存)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| Buffer.java | **四状态机**: mark(198)/position(199)/limit(200)/capacity(201)、position()(274)/flip/clear/rewind/compact 语义、remaining(483)/hasRemaining(495) | High |
| Buffer.java | **抽象边界**: isDirect 抽象(580)、地址访问(address,模板 1673)——堆内/堆外的统一接口 | High |
| X-Buffer.java.template | **缓冲模板**: hb 数组(271,堆内存储)、wrap(389)、get 抽象(615)——N 个 Buffer 类型由同一模板生成 | High |
| Heap-X-Buffer.java.template | **堆内实现**: offset(55,子缓冲区偏移)、isDirect false(188)——byte[] 包装 | Medium |
| Direct-X-Buffer.java.template | **堆外实现**: allocateMemory+Cleaner(域 32 已述)、isDirect true | High |
| MappedByteBuffer.java | **内存映射**: isLoaded(128)/load(152)/force(204)、isLoaded0 native(215)——mmap 的 Java 视图 | High |
| channels/FileChannel.java | **文件通道抽象**: read(358)/force(564)/transferTo(629)/map(925)/lock(1021)、MapMode 三态(READ_ONLY 805/READ_WRITE 811/PRIVATE 817) | High |
| sun/nio/ch/FileChannelImpl.java | **文件通道实现**: read(208)/write、transferToDirectly(522,零拷贝 sendfile)/transferTo(654)/map(928,map0 native 1002-1013,unmap0 898)/lock(1099,lock0 native)/force(451,force0) | High |
| channels/Channels.java | **流↔通道桥**: newInputStream(119)/newOutputStream(138)/newChannel(346)——旧 IO 与新 IO 互转 | Medium |
| channels/FileLock.java | **文件锁抽象**: 重叠区/共享独占、与 OS flock 关系 | Low |
| sun/nio/ch/DirectBuffer.java | 地址/清理器暴露(33/37,域 32 已述) | Medium |

*11 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | Buffer 状态机 | 1 (Buffer) | 面试必考(flip/clear/rewind 语义、position/limit) |
| P1 | mmap 与 FileChannel | 3 (FileChannel/Impl/MappedByteBuffer) | 面试高频(零拷贝/mmap/大文件);生产(高性能 IO) |
| P1 | 零拷贝 transferTo | 2 (FileChannel/Impl) | 面试常问(sendfile/零拷贝概念) |
| P2 | 堆内/堆外 Buffer | 3 (模板) | 面试常问(isDirect/区别) |
| P2 | Channels 桥 | 1 | 生产(新旧 IO 互转) |
| P3 | FileLock | 1 | 面试低频 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | Buffer 四状态与 flip/clear/rewind | 面试必考(读写切换语义,手写 ByteBuffer 解析) |
| 🔴 Deep | mmap 与零拷贝 | 面试高频(零拷贝路径: 用户态↔内核态拷贝次数);生产(大文件/IO 优化) |
| 🔴 Deep | FileChannel 核心操作 | 面试常问(force/position/锁);生产 |
| 🟡 Working | 堆内 vs 堆外 | 面试常问(isDirect 语义) |
| 🟢 Surface | Channels/FileLock | 使用层 |

## 04 聚类

### 依赖图(域内)
```
Buffer(状态机) ←── 模板生成(Heap*/Direct*) ←── 域 32 Unsafe(堆外)
FileChannel(抽象) ←── FileChannelImpl ←── native(map0/transferTo/force0)
MappedByteBuffer ←── FileChannel.map ←── mmap 系统调用
Channels(桥) ←── InputStream/OutputStream(域 17)
FileLock ←── lock0 native
```

### 教学顺序与文章拆分(3 篇)

1. **Buffer 抽象与状态机** — 四状态字段、flip/clear/rewind/compact、remaining/读写切换、堆内堆外两实现
2. **ByteBuffer 家族与生成体系** — 模板生成(Heap/Direct)、wrap/视图(ByteBufferAs)、字节序、isDirect
3. **FileChannel 与 mmap 零拷贝** — FileChannel 操作族、FileChannelImpl native 边界、map/MapMode/MappedByteBuffer、transferTo 零拷贝、文件锁

> 前置: 域 17(流)、32(堆外内存)。跨层: mmap/read/write/sendfile 系统调用(内部卷 01-os);地址与 GC(内部卷 09-memory-core)
