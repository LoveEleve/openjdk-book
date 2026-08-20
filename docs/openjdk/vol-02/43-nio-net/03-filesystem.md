# 03. 为什么都是文件系统 API，底下却像三套系统？— `stat`、`readdir` 与 `inotify`

> **版本边界**：本文基于 `OpenJDK 11u / Linux / x86_64 / libnio/fs`。这里讨论的是 `java.nio.file` 域在 Linux/Unix 上的三条核心 native 路径：元数据快照、目录枚举、事件通知。重点是 `UnixNativeDispatcher` 与 `LinuxWatchService` 的职责边界，以及它们分别对应的系统输入面。Windows/macOS 的 watch 实现不在本文展开。
>
> **前置依赖**：[02 — 为什么 UDP、DNS、网卡枚举看起来像一类 API，底下却完全不是一回事？— Datagram、InetAddress 与 NetworkInterface](02-udp-dns.md)
> → **后续**：[22-deoptimization/01 — 编译代码什么时候回退？— Deopt 决策表](../22-deoptimization/01-deopt-decision.md)

`java.nio.file` 很容易让人形成一种错觉：文件系统 API 无非就是“多几种文件系统操作的 JNI 包装”。

`Files.readAttributes` 看起来像查文件信息，`Files.list` 看起来像列目录，`WatchService` 看起来像“目录变化通知版的 list”。从 Java 侧表面看，这三件事确实都在同一个文件系统世界里。

但顺着 native 源码往下看，很快会发现它们根本不是同一种输入面：

- `readAttributes` 面对的是一次性的**元数据快照**；
- `Files.list` / `DirectoryStream` 面对的是按条目吐名字的**目录枚举流**；
- `WatchService` 面对的则是内核持续推来的**事件通知流**。

这就逼出本篇最该回答的问题：**`Files.readAttributes`、`Files.list`、`WatchService` 都属于文件系统 API，为什么底层却完全不像一套机制？有的只是 `stat` 一次元数据快照，有的是 `readdir/getdents64` 目录流，有的又是 inotify 的持续事件流。JDK 在这里统一的到底是什么，又为什么要把 `UnixNativeDispatcher` 和 `LinuxWatchService` 分成两层？**

先把答案压成一句话：**文件系统在 Java 世界里看起来像一组连续 API，但 native 侧其实面对三种不同输入面：`stat/lstat/fstat` 这样的元数据快照、`opendir/readdir` 这样的目录枚举流、以及 inotify 这样的持续事件流。`UnixNativeDispatcher` 的职责是把路径地址、fd 和属性对象翻译成一组可重用的 POSIX syscall 包装，而 `LinuxWatchService` 则另外起一条“事件通知翻译”通道，把 inotify 的变长事件缓冲翻成 Java `WatchEvent`。**

---

## 1. 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：`java.nio.file` 底层就是几层 syscall 包装，差别不大

这是最自然的第一反应。

不管是查属性、列目录还是监听变化，最后总归都要调用内核文件系统接口。既然如此，native 层大概就是把若干 `stat/open/readdir/poll` 之类调用包一下，剩下的区别只是 Java API 表面的不同。

这个理解的问题在于，它把“都和文件系统打交道”误当成了“都共享同一数据形态”。

实际这三条路径面对的输入完全不同：

- `stat` 给你的是某个路径在某个时刻的一份属性快照；
- `readdir` 给你的是一个目录流里逐个吐出来的名字；
- inotify 给你的是一条会持续到来的变长事件序列。

也就是说，**它们的共同点只在于“来自文件系统”，不在于“结果长得像一家人”。**

### 朴素方案二：`WatchService` 只是目录轮询的 JNI 版

第二个也很自然的想法是：既然目录枚举已经能把目录里的名字一个个读出来，那“目录变化通知”不过就是再多一层轮询和对比。JDK 也许只是帮你把这个轮询做进 native 里了。

这在 Linux 路径上并不成立。

`WatchService` 并不是“反复 `readdir` 看差异”，而是完全走另一套内核输入面：inotify。它面对的是内核推送的 `struct inotify_event` 流，不是某一时刻目录内容的重新扫描。

这两者的差别非常大：

- 目录轮询拿到的是“现在有哪些名字”；
- inotify 拿到的是“刚才发生了什么事件”。

所以第二种朴素方案失败，不是因为轮询永远不行，而是因为**JDK 在 Linux 上明确选择了事件流模型，而不是目录快照差分模型。**

---

## 2. `UnixNativeDispatcher`：为什么路径统一先变成 native buffer 地址

先看前两类输入面共同依赖的那层：`UnixNativeDispatcher`。

它的角色非常接近网络域前几篇里的 `*_Dispatcher`：不是承载高层语义，而是把 Java 参数翻译成 syscall 可以直接消费的形状。

### 为什么路径不直接传 `jstring`

Java 侧 `UnixNativeDispatcher` 有一个非常关键的入口：`copyToNativeBuffer(UnixPath path)`。它会拿到路径的字节数组，把它拷进 `NativeBuffer`，最后通过 `buffer.address()` 把裸地址交给 native。`UnixNativeDispatcher.java:39`

随后像 `stat`、`openat` 这样的调用，Java 侧最终都变成：

- `stat0(buffer.address(), attrs)`
- `openat0(dfd, buffer.address(), flags, mode)`。`UnixNativeDispatcher.java:298`

这一步特别能说明文件系统域的共同翻译前提：**路径在进入 native 后，不再以 Java String 身份存在，而是以“native 缓冲区里的 C 风格字节串地址”存在。**

### `throwUnixException`：统一错误翻译

`UnixNativeDispatcher.c` 一开始就定义了 `throwUnixException(env, errnum)`，专门负责把 errno 包成 `sun.nio.fs.UnixException` 抛回 Java。`UnixNativeDispatcher.c:182`

这说明 `UnixNativeDispatcher` 和网络域里的工具层一样，首先做的是**统一翻译**：底层系统调用的失败不会直接把 errno 散落给 Java 层，而是先被压成同一种异常壳，再由更上层决定怎么继续翻译。

### `openat0`：为什么是运行时函数指针，不是直接写死 `openat64`

`openat0` 并不是直接静态调用某个 `openat64` 符号，而是通过初始化时 `dlsym` 出来的函数指针调。`UnixNativeDispatcher.c:452`

这说明 `UnixNativeDispatcher` 既不是纯头文件宏，也不是只做最薄的 syscall 直通，它还承担一层平台能力探测和运行时符号适配。

所以本节最该记住的一句话是：**`UnixNativeDispatcher` 不是文件系统语义层，而是“路径地址 + errno + 平台符号适配”的统一 syscall 翻译层。**

---

## 3. 元数据快照：为什么 `prepAttributes` 才是 `readAttributes` 真正的回填点

第一种输入面是元数据快照。

`UnixNativeDispatcher.stat0()` 的结构很简单：

- 把 `jlong pathAddress` 还原成 `const char* path`；
- 用 `RESTARTABLE(stat64(path, &buf), err)` 调系统调用；
- 成功后调用 `prepAttributes(env, &buf, attrs)`。`UnixNativeDispatcher.c:543`

### 真正关键的不是 `stat64`，而是 `prepAttributes`

如果只盯着系统调用名，很容易把这一节讲成“JDK 调了个 `stat64`”。但从 Java API 角度看，真正有价值的是后半步：native 要把 `struct stat64` 里的十几个字段分门别类地回填到 `UnixFileAttributes` 对象上。`UnixNativeDispatcher.c:514`

也就是说，**`Files.readAttributes` 真正收到的不是一个原始 `stat` 结构，而是一份已经被翻译进 Java 对象字段的快照。**

### `stat1` 为什么只回 `st_mode`

还有一个很能说明“快照面”特征的小函数是 `stat1`。它只做 `stat64`，成功就返回 `st_mode`，失败就给 0。`UnixNativeDispatcher.c:559`

这说明文件系统元数据并不是永远都要完整展开成大对象；某些上层路径只需要知道“这大概是目录、文件还是别的”。换句话说，**快照面里也存在“完整快照”和“只拿最关键位”的分层。**

---

## 4. 目录枚举：为什么 `readdir` 只回名字，不顺手回类型

第二种输入面是目录枚举。

`UnixNativeDispatcher` 提供的目录相关 native 包装非常朴素：

- `opendir0(pathAddress)` 返回 `DIR*`；
- `fdopendir(dfd)` 把已有目录 fd 包成 `DIR*`；
- `readdir(long dir)` 则直接调用 `readdir64(dirp)`。`UnixNativeDispatcher.c:733`、`UnixNativeDispatcher.c:748`、`UnixNativeDispatcher.c:774`

而 `readdir` 成功后的返回值非常克制：它只拿 `ptr->d_name` 的长度，构造一个 `byte[]`，把名字字节拷回去。`UnixNativeDispatcher.c:774`

也就是说，**目录枚举面默认返回的是“名字流”，不是“完整属性对象流”。**

### 为什么这不是偷懒，而是故意分层

如果 JDK 在这里顺手把每个条目的完整类型、权限、时间戳全带回来，表面上似乎更方便，实际上却会把“目录里有什么名字”和“这些名字各自还有什么属性”两种成本绑死在一起。

当前实现的选择是：

- `readdir` 先只把名字吐出来；
- 如果上层真想知道类型，再另走属性快照面。

这样做的好处是，列目录不必默认为每个条目再多付一次 stat 或额外元数据翻译成本。

所以第二种输入面的核心特征是：**它给你一串名字序列，而不是把目录枚举自动升级成属性枚举。**

---

## 5. 事件通知：为什么 `WatchService` 必须单开 inotify 通道

第三种输入面是持续事件流。

### `LinuxWatchService.c`：native 侧只暴露最薄的布局和系统调用壳

Linux 专属的 `LinuxWatchService.c` 非常像 `EPoll.c`：

- 布局查询：`eventSize()` 和 `eventOffsets()`，把 `struct inotify_event` 的布局告诉 Java；
- 系统调用壳：`inotifyInit`、`inotifyAddWatch`、`inotifyRmWatch`；
- 再补上 `configureBlocking` 和 `socketpair`；
- 最后用一个很薄的 `poll(fd1, fd2)` 同时等 inotify fd 和唤醒管道。`LinuxWatchService.c:49-130`

这说明 native 侧这里的重点和 `UnixNativeDispatcher` 不同：它不在做大而全的 syscall 翻译集合，而是在提供一条专门为“持续事件流”服务的底座。

### 为什么还要有 `socketpair`

`LinuxWatchService.c` 自己还提供了 `socketpair()` 包装。这不是因为 inotify 需要 socket 才能工作，而是因为 Java 侧的 Poller 线程不能只堵在 inotify fd 上。它还需要一条**自唤醒控制通道**，好在 register/close 等控制请求到来时把阻塞中的 poll 叫醒。

### Java Poller 为什么要自己解析变长事件缓冲

真正的消费主循环在 `LinuxWatchService.java` 的 Poller 线程里。它会：

- 先 `poll(ifd, socketpair[0])`；
- 然后从 inotify fd 一次 `read` 一整块缓冲；
- 再用 `SIZEOF_INOTIFY_EVENT` 和各字段偏移，把这块变长缓冲自己切成一个个 `event`。`LinuxWatchService.java:310`

这一步特别值得讲清楚，因为它说明 inotify 事件不是一条条整齐排队、每次 read 一个对象。JDK 面对的是一块塞着**多个变长事件**的原始字节缓冲，需要自己沿着 `SIZEOF_INOTIFY_EVENT + len` 往前跳。

### `maskToEventKind`：为什么 `ENTRY_CREATE` / `ENTRY_DELETE` 是 JDK 合成语义

`LinuxWatchService.java` 里 `maskToEventKind()` 的映射非常有意思：

- `IN_CREATE` 和 `IN_MOVED_TO` 都会变成 `ENTRY_CREATE`；
- `IN_DELETE` 和 `IN_MOVED_FROM` 都会变成 `ENTRY_DELETE`；
- `IN_MODIFY` 和 `IN_ATTRIB` 都会变成 `ENTRY_MODIFY`。`LinuxWatchService.java:384`

也就是说，**事件流到了 Java 世界前，还要再过一层“事件语义翻译”。**

### 为什么它不是递归监视

还有一个非常重要的边界：`implRegister()` 只对传入的那个目录做一次 `inotifyAddWatch`。`LinuxWatchService.java:208`

这说明当前实现不是递归监视整棵目录树，而是“**你注册哪个目录，我就监视哪个目录**”。如果应用想覆盖子目录，还得自己继续注册。

所以第三种输入面的核心特征是：**它是一条需要持续解包、持续映射、持续驱动的事件流。**

---

## 6. 误解澄清与收网

1. **`Files.readAttributes` 会顺手读文件正文吗?** 不会。它走的是 `stat/lstat/fstat` 这一面，返回的是属性快照，不碰正文内容。
2. **`readdir` 直接把类型信息也带回给 Java 吗?** 不会。当前 Unix 路径里 `readdir` 只把 `d_name` 拷成字节数组返回，类型信息并不在这一步顺手带回。
3. **`WatchService` 靠用户态轮询目录差异实现吗?** 不是。Linux 路径下它走的是 inotify 事件流，再由 Poller 把内核事件翻成 Java `WatchEvent`。
4. **inotify 默认递归监视子目录吗?** 不对。`implRegister()` 只给传入目录做一次 `inotifyAddWatch`；子目录不是自动递归覆盖的。
5. **jlong 地址传参只是 JNI 小技巧吗?** 也不是。它是 `UnixNativeDispatcher` 这一层的统一入参协议：Java 侧先把路径复制进 native buffer，再把地址交给大量 syscall 包装复用。

把这一篇压成三句话：

- `java.nio.file` 看上去是一组连续 API，native 侧面对的却是属性快照、名字流、事件流三种完全不同的数据形态。
- `UnixNativeDispatcher` 统一的是 syscall 翻译接口，`LinuxWatchService` 则单独负责持续事件流的翻译和驱动。
- JDK 在这里统一的不是内核输入模型，而是“怎样把这些不同输入面都翻成 Java 侧熟悉的对象、流和事件”。

下一篇: Deopt 决策表——编译代码什么时候放弃机器码、退回解释器。

> → [22-deoptimization/01 — 编译代码什么时候回退？— Deopt 决策表](../22-deoptimization/01-deopt-decision.md)