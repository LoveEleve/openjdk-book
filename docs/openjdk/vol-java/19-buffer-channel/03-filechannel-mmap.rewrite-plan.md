# 19-buffer-channel/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `FileChannel`、`MappedByteBuffer`、`FileChannelImpl`。本文聚焦 `map`、`MappedByteBuffer.load/force`、`transferTo/transferFrom`、文件锁与零拷贝语义；不深入 NIO Selector/SocketChannel 与所有平台差异分支。
> 目标：把“FileChannel 与 mmap 零拷贝”改写成一篇围绕“为什么文件不只是‘读写字节流’，而是可以被当成可定位、可映射、可直接搬运的数据源；以及零拷贝为什么不是零移动，而是尽量不让数据经过用户态”的机制文章。

## 1. 读者困惑

- `FileChannel` 为什么不像 FileInputStream 那样只会顺序读写，它到底多了哪些能力？
- `map()` 为什么会被说成“把文件变成内存”，这到底是怎样的比喻？
- `MappedByteBuffer.load()`、`isLoaded()`、`force()` 各自控制的是什么，为什么一个是预热、一个是持久化？
- `transferTo()` 为什么叫零拷贝，它真的零复制了吗？
- 为什么 `sendfile`、`mmap`、`页缓存` 这些 OS 概念会直接影响 Java FileChannel 的性能语义？

## 2. 一句话顿悟

**FileChannel 真正区别于传统流的地方，不在“也能读写字节”，而在于它把文件视作可定位、可映射、可锁定、可直接搬运的资源：`map()` 借操作系统虚拟内存把文件页映射进进程地址空间，让读写像在碰内存；`transferTo()` 则尽量让内核直接在文件页缓存和目标通道之间搬运数据，减少用户态中转。所谓零拷贝，不是完全不移动数据，而是尽量不让数据穿过用户态缓冲。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 FileChannel 能力全集、MapMode 三态、页对齐、MappedByteBuffer 的 load/force 与 transferTo 三级路径。
- 已把“零拷贝 = 零用户态中转”这条关键纠偏讲清楚。
- 已顺手点到文件锁、mmap 写回与 DirectBuffer 关系，方向合理。

### 必须重写

- 主要不是内容缺失，而是需要统一风格计划文件与更强的问题驱动开场。
- FileChannel 应先从“为什么它比流多出定位/映射/锁定/批量转移能力”立住，不宜直接铺方法表。
- mmap 和 transferTo 要更明确地分别服务于“像内存访问文件”和“像通道搬运文件”两种场景，而不是都归到零拷贝名下。
- `load/force` 要讲成“页缓存方向控制”，强化与 OS 页缓存的对应关系。

## 4. 理解路径

### 第一节：从“为什么文件不只是顺序字节流”开场

用大文件随机访问、进程间文件互斥、日志转储/文件传输场景开场。先立问题：传统流只能按字节顺序读写，FileChannel 则把文件暴露成一个更接近“数据源资源对象”的能力全集。

### 第二节：FileChannel 为什么是文件能力接口而不是普通流

证据：
- `FileChannel.java` 中 `force` / `transferTo` / `map` / `lock` 抽象入口
- 旧稿里已定位 `FileChannelImpl` 的 read/force/transferTo/map/lock 实现入口

主线：
- 流更像“顺序搬字节”；通道则额外拥有位置、映射、锁、批量转移等能力。
- 这为后面的 mmap 和 sendfile 铺出两个不同方向：地址空间视角 vs 数据搬运视角。

### 第三节：mmap 为什么不是“把文件读进数组”，而是把文件页映射进地址空间

证据：
- `FileChannelImpl.java:1197-1199`：`map0`
- `FileChannel.java:795-818`：`MapMode`
- `FileChannelImpl.java:943-950`：模式换算
- `FileChannelImpl.java:996-1005`：页对齐
- `FileChannelImpl.java:1036-1044`：`newMappedByteBuffer`

主线：
- map 的核心不是复制文件内容，而是借 OS 虚拟内存把文件页映射进进程地址空间。
- 读/写 MappedByteBuffer 是在访问映射页，不是手工拉一段字节出来再操作。
- 页对齐解释了为什么 map 要把起点向前对齐到页边界再修正用户视角偏移。

### 第四节：MappedByteBuffer 的 load / isLoaded / force 为什么是一组页缓存控制动作

证据：
- `MappedByteBuffer.java:128`：`isLoaded`
- `MappedByteBuffer.java:152-179`：`load`
- `MappedByteBuffer.java:204-213`：`force`

主线：
- load 是预热：提前把页摸进物理内存，减少后续缺页中断。
- force 是持久化：把脏页尽快刷回磁盘，不再只依赖 OS 异步回写。
- isLoaded 是“当前大体是否都在内存”的查询，不是持久化保证。
- 这把三者统一成“页缓存方向控制”：磁盘→内存预热，内存→磁盘刷回。

### 第五节：transferTo 为什么叫零拷贝——零的是用户态中转，不是零数据移动

证据：
- `FileChannelImpl.java:654`：`transferTo`
- `FileChannelImpl.java:677-686`：三级路径
- `FileChannelImpl.java:1205`：`transferTo0` native

主线：
- 传统 read+write 路径要经过用户态缓冲两次中转。
- 直接 `sendfile` 路径尽量让内核在页缓存与目标通道之间直接搬运数据。
- 零拷贝真正省掉的是“进用户态再出来”的折返，而不是所有 DMA/内核内数据移动都为零。
- 三级降级路径说明：能直搬最好，不行再 mmap 中转，再不行才退回 read+write 慢路径。

## 5. 失败方案清单

1. 把 FileChannel 当成 FileInputStream 的等价替代，只看到读写字节。
2. 以为 mmap 就是把文件内容一次性复制进 Java 堆数组。
3. 把 load/force 都理解成“和磁盘同步一下”的同一种动作。
4. 把零拷贝理解成“数据根本没有任何移动”。
5. 看到 transferTo 就默认任何目标通道都必然走 sendfile 快路径。

## 6. 误解清单

1. FileChannel 的高级能力主要体现在 API 名字多，不在底层语义上。
2. MappedByteBuffer 天然就等于持久化文件修改。
3. load 会保证数据一定持久化落盘。
4. zero-copy 的“zero”指的是 CPU、DMA、页缓存都不搬数据。
5. 文件锁和 createNewFile 的存在性语义差不多，都是互斥方案。

## 7. 证据清单

- `FileChannelImpl.java:1197-1199`：`map0`
- `FileChannel.java:795-818`：MapMode
- `FileChannelImpl.java:943-950`：模式换算
- `FileChannelImpl.java:996-1005`：页对齐
- `FileChannelImpl.java:1036-1044`：MappedByteBuffer 构造
- `MappedByteBuffer.java:128`：`isLoaded`
- `MappedByteBuffer.java:152-179`：`load`
- `MappedByteBuffer.java:204-213`：`force`
- `FileChannelImpl.java:654`：`transferTo`
- `FileChannelImpl.java:677-686`：三级路径
- `FileChannelImpl.java:1205`：`transferTo0`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦文件通道、内存映射与零拷贝语义，不展开 SocketChannel/Selector 事件驱动部分。
- mmap 与 sendfile 的内核细节只解释到足以支撑 Java 层语义，不打穿所有 OS 分支实现。
- 文件锁仅作为能力全景点到，不扩写为专门锁语义篇。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“FileChannel 为什么是文件能力接口 → map 为什么是把文件页映射进地址空间 → load/force 如何分别控制页缓存预热与刷盘 → transferTo 为什么是在尽量消灭用户态中转 → 零拷贝的真实边界是什么”。
- 必须把 mmap 与 transferTo 讲成两条不同优化路径。
- 必须自然收束 19 域并衔接 21 域 Selector/NIO。
