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

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：`java.nio.file` 底层就是几层 syscall 包装，差别不大

这是最自然的第一反应。

不管是查属性、列目录还是监听变化，最后总归都要调用内核文件系统接口。既然如此，native 层大概就是把若干 `stat/open/readdir/poll` 之类调用包一下，剩下的区别只是 Java API 表面的不同。

这个理解的问题在于，它把“都和文件系统打交道”误当成了“都共享同一数据形态”。

实际这三条路径面对的输入完全不同：

- `stat` 给你的是某个路径在某个时刻的一份属性快照；
- `readdir` 给你的是一个目录流里逐个吐出来的名字；
- inotify 给你的是一条会持续到来的变长事件序列。

也就是说，**它们的共同点只在于“来自文件系统”，不在于“结果长得像一家人”。**

所以如果把这三条线都讲成“syscall 包装差不多”，就会看不见为什么 `UnixNativeDispatcher` 和 `LinuxWatchService` 在结构上被故意拆开：前者面对一次性查询/操作，后者面对持续事件流。

### 朴素方案二：`WatchService` 只是目录轮询的 JNI 版

第二个也很自然的想法是：既然目录枚举已经能把目录里的名字一个个读出来，那“目录变化通知”不过就是再多一层轮询和对比。JDK 也许只是帮你把这个轮询做进 native 里了。

这在 Linux 路径上并不成立。

`WatchService` 并不是“反复 `readdir` 看差异”，而是完全走另一套内核输入面：inotify。它面对的是内核推送的 `struct inotify_event` 流，不是某一时刻目录内容的重新扫描。

这两者的差别非常大：

- 目录轮询拿到的是“现在有哪些名字”；
- inotify 拿到的是“刚才发生了什么事件”。

前者天然是快照，后者天然是时间序列。前者没有历史，后者带着时间上的因果。

所以第二种朴素方案失败，不是因为轮询永远不行，而是因为**JDK 在 Linux 上明确选择了事件流模型，而不是目录快照差分模型。**

这两个失败方案合起来，正好引出本篇主线：**JDK 文件系统层统一的是 JNI 翻译接口，不统一底层输入面的形态。**

## `UnixNativeDispatcher`：为什么路径统一先变成 native buffer 地址

先看前两类输入面共同依赖的那层：`UnixNativeDispatcher`。

它的角色非常接近网络域前几篇里那些 `*_Dispatcher`：不是承载高层语义，而是把 Java 参数翻译成 syscall 可以直接消费的形状。

### 为什么路径不直接传 `jstring`

Java 侧 `UnixNativeDispatcher` 有一个非常关键的入口：`copyToNativeBuffer(UnixPath path)`。它会拿到路径的字节数组，把它拷进 `NativeBuffer`，最后通过 `buffer.address()` 把裸地址交给 native。`src/java.base/unix/classes/sun/nio/fs/UnixNativeDispatcher.java:39`

随后像 `stat`、`openat` 这样的调用，Java 侧最终都变成：

- `stat0(buffer.address(), attrs)`
- `openat0(dfd, buffer.address(), flags, mode)`。`src/java.base/unix/classes/sun/nio/fs/UnixNativeDispatcher.java:298`

这一步特别能说明文件系统域的共同翻译前提：**路径在进入 native 后，不再以 Java String 身份存在，而是以“native 缓冲区里的 C 风格字节串地址”存在。**

这和前面 epoll 的地址传参很像，但这里要强调的是：它不是为了玩裸指针，而是为了让大量 syscall 包装能共用一种最便宜的入参形态。

### `throwUnixException`：统一错误翻译，而不是让每个 syscall 自己造异常

`UnixNativeDispatcher.c` 一开始就定义了 `throwUnixException(env, errnum)`，专门负责把 errno 包成 `sun.nio.fs.UnixException` 抛回 Java。`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:182`

这说明 `UnixNativeDispatcher` 和上一域的 libjava 工具层一样，首先做的是**统一翻译**：底层系统调用的失败不会直接把 errno 散落给 Java 层，而是先被压成同一种异常壳，再由更上层决定怎么继续翻译。

### `openat0`：为什么是运行时函数指针，不是直接写死 `openat64`

`openat0` 那段代码也很有代表性。它并不是直接静态调用某个 `openat64` 符号，而是先通过 `my_openat64_func` 这个初始化时 `dlsym` 出来的函数指针来调。`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:147`、`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:452`

这说明 `UnixNativeDispatcher` 既不是纯粹的头文件宏，也不是只做最薄的 syscall 直通，它还承担一层平台能力探测和运行时符号适配。

所以本节最该记住的一句话是：**`UnixNativeDispatcher` 不是文件系统语义层，而是“路径地址 + errno + 平台符号适配”的统一 syscall 翻译层。**

## 元数据快照：为什么 `prepAttributes` 才是 `readAttributes` 真正的回填点

先看第一种输入面：元数据快照。

`UnixNativeDispatcher.stat0()` 的结构很简单：

- 把 `jlong pathAddress` 还原成 `const char* path`；
- 用 `RESTARTABLE(stat64(path, &buf), err)` 调系统调用；
- 成功后调用 `prepAttributes(env, &buf, attrs)`。`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:543`

### 真正关键的不是 `stat64`，而是 `prepAttributes`

如果只盯着系统调用名，很容易把这一节讲成“JDK 调了个 `stat64`”。但从 Java API 角度看，真正有价值的是后半步：native 要把 `struct stat64` 里的十几个字段分门别类地回填到 `UnixFileAttributes` 对象上。`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:514`

也就是说，**`Files.readAttributes` 真正收到的不是一个原始 `stat` 结构，而是一份已经被翻译进 Java 对象字段的快照。**

这才是 `UnixNativeDispatcher` 在“元数据面”上的主要职责：不只是调 syscall，而是把 syscall 结果固化成 Java 属性对象。

### `stat1` 为什么只回 `st_mode`

还有一个很能说明“快照面”特征的小函数是 `stat1`。它只做 `stat64`，成功就返回 `st_mode`，失败就给 0。`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:559`

这说明文件系统元数据并不是永远都要完整展开成大对象；某些上层路径只需要知道“这大概是目录、文件还是别的”。换句话说，**快照面里也存在“完整快照”和“只拿最关键位”的分层。**

### 这一面为什么和“读文件内容”完全不是一回事

这一点特别值得讲明：`stat0/lstat0/fstat` 这一整条线拿到的只是元数据，不碰文件正文，不读内容字节，不打开目录流，也不关心事件历史。

所以如果把 `Files.readAttributes` 和 `Files.list` / `WatchService` 混成一类“文件系统查询”，就会看不见这第一种输入面的根本特征：**它给的是一份静态属性快照。**

## 目录枚举：为什么 `readdir` 只回名字，不顺手回类型

第二种输入面是目录枚举。

这里最容易被想当然的是：既然底层 `struct dirent` 里通常还有 `d_type` 之类字段，那 JDK 顺手把类型也一起带回不就行了？

OpenJDK 11 在 Unix 路径上并没有这么做。

### `opendir0/fdopendir/readdir`：这条线只负责把目录流翻成“名字序列”

`UnixNativeDispatcher` 提供的目录相关 native 包装非常朴素：

- `opendir0(pathAddress)` 返回 `DIR*`；
- `fdopendir(dfd)` 把已有目录 fd 包成 `DIR*`；
- `readdir(long dir)` 则直接调用 `readdir64(dirp)`。`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:733`、`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:748`、`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:774`

而 `readdir` 成功后的返回值非常克制：它只拿 `ptr->d_name` 的长度，构造一个 `byte[]`，把名字字节拷回去。`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:774`

也就是说，**目录枚举面默认返回的是“名字流”，不是“完整属性对象流”。**

### 为什么这不是偷懒，而是故意分层

如果 JDK 在这里顺手把每个条目的完整类型、权限、时间戳全带回来，表面上似乎更方便，实际上却会把“目录里有什么名字”和“这些名字各自还有什么属性”两种成本绑死在一起。

当前实现的选择是：

- `readdir` 先只把名字吐出来；
- 如果上层真想知道类型，再另走属性快照面。

这样做的好处是，列目录不必默认为每个条目再多付一次 stat 或额外元数据翻译成本。

所以第二种输入面的核心特征是：**它给你一串名字序列，而不是把目录枚举自动升级成属性枚举。**

### 这也是为什么它和 `Files.readAttributes` 必须分开讲

到这里就能看清第一、第二输入面的本质差异：

- `readAttributes` 是“给我某个路径当前的属性快照”；
- `readdir` 是“给我这个目录流里接下来的名字”。

它们都碰文件系统，但面对的是完全不同的数据形态。

## 事件通知：为什么 `WatchService` 必须单开 inotify 通道

第三种输入面则更不同：事件通知。

如果说目录枚举给的是“现在目录里有什么”，那 inotify 给的是“刚才发生了什么”。这不是快照，也不是名字序列，而是一条持续冒出来的事件流。

### `LinuxWatchService.c`：native 侧只暴露 inotify 布局和最薄 syscalls

Linux 专属的 `LinuxWatchService.c` 非常像上一章的 `EPoll.c`：

- 先给出 `eventSize()` 和 `eventOffsets()`，把 `struct inotify_event` 的布局告诉 Java；
- 再包一层 `inotifyInit`、`inotifyAddWatch`、`inotifyRmWatch`；
- 然后补上 `configureBlocking` 和 `socketpair`；
- 最后用一个很薄的 `poll(fd1, fd2)` 同时等 inotify fd 和唤醒管道。`src/java.base/linux/native/libnio/fs/LinuxWatchService.c:49`

这说明 native 侧这里的重点和 `UnixNativeDispatcher` 不同：它不在做大而全的 syscall 翻译集合，而是在提供一条专门为“持续事件流”服务的底座。

### 为什么还要有 `socketpair`

`LinuxWatchService.c` 自己还提供了 `socketpair()` 包装。`src/java.base/linux/native/libnio/fs/LinuxWatchService.c:118`

这不是因为 inotify 需要 socket 才能工作，而是因为 Java 侧的 Poller 线程不能只堵在 inotify fd 上。它还需要一条**自唤醒控制通道**，好在 register/close 等控制请求到来时把阻塞中的 poll 叫醒。

这一步和上一章 Selector 的 wakeup pipe 是同构的：都说明“事件面”不只是被动读内核事件，还得给 Java 控制流留一条可打断、可驱动的旁路。

### Java Poller 为什么要自己解析变长事件缓冲

真正的消费主循环在 `LinuxWatchService.java` 的 Poller 线程里。它会：

- 先 `poll(ifd, socketpair[0])`；
- 然后从 inotify fd 一次 `read` 一整块缓冲；
- 再用 `SIZEOF_INOTIFY_EVENT` 和各字段偏移，把这块变长缓冲自己切成一个个 `event`。`src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:310`

这一步特别值得讲清楚，因为它说明 inotify 事件不是一条条整齐排队、每次 read 一个对象。JDK 面对的是一块塞着**多个变长事件**的原始字节缓冲，需要自己沿着 `SIZEOF_INOTIFY_EVENT + len` 往前跳。

所以事件通知面和前两种输入面最大的差别，就是：**它是一条需要持续解包、持续映射、持续驱动的事件流。**

### `maskToEventKind`：为什么 `ENTRY_CREATE` / `ENTRY_DELETE` 是 JDK 合成语义

`LinuxWatchService.java` 里 `maskToEventKind()` 的映射非常有意思：

- `IN_CREATE` 和 `IN_MOVED_TO` 都会变成 `ENTRY_CREATE`；
- `IN_DELETE` 和 `IN_MOVED_FROM` 都会变成 `ENTRY_DELETE`；
- `IN_MODIFY` 和 `IN_ATTRIB` 都会变成 `ENTRY_MODIFY`。`src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:384`

这一步说明 JDK 在事件通知面做的并不只是“把内核事件名字原样抄给 Java”，而是在把 Linux inotify 的内核语义折叠成 Java `WatchEvent.Kind` 那套更抽象的文件系统事件语义。

也就是说，**事件流到了 Java 世界前，还要再过一层“事件语义翻译”。**

### 为什么它不是递归监视

还有一个非常重要的边界：`implRegister()` 只对传入的那个目录做一次 `inotifyAddWatch`。`src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:208`

这说明当前实现不是递归监视整棵目录树，而是“**你注册哪个目录，我就监视哪个目录**”。如果应用想覆盖子目录，还得自己继续注册。

所以不要把 WatchService 想成“目录树观察者”，在 Linux 路径上它首先只是“目录级别事件流翻译器”。

## 到这里为止，主线其实只发生了四件事

如果前面信息不少，这里先把整件事压回四步：

1. `UnixNativeDispatcher` 统一负责把路径地址、fd 和 errno 翻译成可复用的 POSIX syscall 包装；
2. 元数据查询走 `stat/lstat/fstat`，返回的是属性快照；
3. 目录枚举走 `opendir/readdir`，返回的是名字流；
4. 事件通知则走独立的 inotify + Poller 通道，返回的是持续事件流。

只要这四步还在脑子里，`java.nio.file` 这些 API 就不会再被误读成“同一套文件系统调用的不同按钮”。

## 常见误解澄清

### 误解一：`Files.readAttributes` 会顺手读文件正文

不会。

它走的是 `stat/lstat/fstat` 这一面，返回的是属性快照，不碰正文内容。`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:543`

### 误解二：`readdir` 直接把类型信息也带回给 Java

不对。

当前 Unix 路径里 `readdir` 只把 `d_name` 拷成字节数组返回，类型信息并不在这一步顺手带回。`src/java.base/unix/native/libnio/fs/UnixNativeDispatcher.c:774`

### 误解三：`WatchService` 靠用户态轮询目录差异实现

不是。

Linux 路径下它走的是 inotify 事件流，再由 Poller 把内核事件翻成 Java `WatchEvent`。`src/java.base/linux/native/libnio/fs/LinuxWatchService.c:72`、`src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:310`

### 误解四：inotify 默认递归监视子目录

不对。

`implRegister()` 只给传入目录做一次 `inotifyAddWatch`；子目录不是自动递归覆盖的。`src/java.base/linux/classes/sun/nio/fs/LinuxWatchService.java:208`

### 误解五：jlong 地址传参只是 JNI 小技巧

也不是。

它是 `UnixNativeDispatcher` 这一层的统一入参协议：Java 侧先把路径复制进 native buffer，再把地址交给大量 syscall 包装复用。`src/java.base/unix/classes/sun/nio/fs/UnixNativeDispatcher.java:39`

## 收网：文件系统在 Java 世界里看起来像一个域，在 native 世界里却分成了三种输入面

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
元数据面
  Files.readAttributes
    └─ UnixNativeDispatcher.stat0/lstat0/fstat...
         └─ prepAttributes -> UnixFileAttributes

目录枚举面
  Files.list / DirectoryStream
    └─ opendir/readdir
         └─ 只回 d_name，后续再按需判类型

事件通知面
  WatchService
    └─ inotify_init/add_watch/rm_watch
         + poll(ifd, socketpair)
         + Java Poller 解析 struct inotify_event
```

把它再压成三句话：

- `java.nio.file` 看上去是一组连续 API，native 侧面对的却是属性快照、目录流、事件流三种完全不同的数据形态。
- `UnixNativeDispatcher` 统一的是 syscall 翻译接口，`LinuxWatchService` 则单独负责持续事件流的翻译和驱动。
- JDK 在这里统一的不是内核输入模型，而是“怎样把这些不同输入面都翻成 Java 侧熟悉的对象、流和事件”。

所以这一篇真正该留下来的，不是 `stat`、`readdir`、`inotify` 三个系统调用名字。

真正该留下来的是：**同一个文件系统，在 Java 世界里会被投影成三种完全不同的交互模式；而 JDK native 层的工作，就是把内核的快照、名字流和事件流各自翻译成 Java API 觉得像同一个文件系统家族的东西。**

从这里往后，就离开 JDK 类库外设世界，回到 VM 内部更核心的控制路径：编译代码什么时候放弃机器码，退回解释器，以及这种回退是怎么被决策和执行的。

> → [22-deoptimization/01 — 编译代码什么时候回退？— Deopt 决策表](../22-deoptimization/01-deopt-decision.md)
