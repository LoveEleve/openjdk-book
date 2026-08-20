# 03. 为什么这些看起来无关的 native 杂事会落在同一层？— ClassLoader、FileDescriptor 与 TimeZone

> **版本边界**：本文基于 `OpenJDK 11u / Linux / x86_64 / libjava + HotSpot`。这里讨论的是 libjava 里另外三条很高频、但常被分开看的 native 路径：类字节如何交给 JVM 定义、native 库如何组织加载握手、`FileDescriptor` 的 fd 如何进入系统调用、默认时区如何从系统配置翻译成 Java tzid。本文重点是职责边界：哪些工作停在 libjava，哪些必须继续交给 HotSpot 或操作系统。
>
> **前置依赖**：[02 — 为什么 `Runtime.exec()` 不是两次系统调用？— 进程管理的 native 协议](02-process.md)
> → **后续**：[43-nio-net/01 — TCP Socket](../43-nio-net/01-tcp-epoll.md)

libjava 这一域写到这里，最容易出现一个错觉：前两篇讲的是一套骨架，后面这些 defineClass、dlopen、文件描述符、时区探测，不过是一些零散的剩余 native 杂活。

顺着源码看下去，你会发现并不是这样。

表面上，这几条线确实很不像一家人：

- `ClassLoader.defineClass` 要把类的字节交给 JVM；
- `System.loadLibrary` 要把一个 `.so` 拉进进程；
- `java.io.FileDescriptor` 只是包着一个 int fd；
- `TimeZone.getDefault()` 第一次调用时却要去翻 `TZ`、`/etc/timezone`、`/etc/localtime`，甚至最后退到 GMT 偏移。

但如果把它们放在“Java 世界如何接触外部世界”这条轴上看，这几条线其实都在做同一件事：**把外部输入翻译成 Java 语义。**

这就逼出本篇最该回答的问题：**为什么“类的字节进 JVM”“native 库进进程”“FileDescriptor 里的 fd 进系统调用”“默认时区进 Java TimeZone”这几条路径虽然看起来毫不相干，却都落在 libjava 这层？它们到底共享了什么样的翻译职责，为什么有的工作停在 libjava，有的却必须交给 HotSpot 或操作系统去做？**

先把答案压成一句话：**这三条线表面上是 defineClass、dlopen、文件描述符和时区探测，底层其实都在做同一件事：把‘外部世界的原始字节、句柄和配置’翻成 Java 世界能稳定消费的对象语义。类字节先被整理成 JVM 能接受的内部名字和内存块，再交给 HotSpot 真正定义；native 库加载则由 VM 持有句柄和栈保护修复能力，libjava 只组织 `JNI_OnLoad` 握手；FileDescriptor 把一个裸 fd 嵌进 Java 对象并在关闭时补上竞态防御；TimeZone 则把 `TZ`、`/etc/localtime`、GMT 偏移这条系统配置链翻成 Java 侧时区 ID。**

## 先试两个最自然的理解，看看为什么都不对

### 朴素方案一：这几件事只是零散 native 杂活，放哪都行

这是最自然的第一反应。

defineClass 需要一点 native，loadLibrary 需要一点 native，FileDescriptor 需要一点 native，TimeZone 也要一点 native。看起来它们彼此之间没有共享结构，只是刚好都写成了 C 文件而已。

这个理解的问题在于，它忽略了这些路径最核心的共性：**它们都不是在“做一件业务功能”，而是在“替 Java 世界解释外部输入”。**

比如：

- `defineClass1` 不负责真正定义类，它负责把 Java 侧字节数组和名字整理成 VM 能接受的形式；
- `NativeLibrary.load0` 不直接持有 dlopen 全流程，它负责组织 JNI 侧加载握手；
- `GET_FD/SET_FD` 并不是“读一个 int”那么简单，它们是把 Java 对象和 Unix fd 之间的关系标准化；
- `findJavaTZ_md` 不是在计算时区规则，而是在把操作系统提供的几种线索翻成 Java 理解的 tzid。

换句话说，这几条线的共同点不是“都碰到了系统调用”，而是“**都在外部世界和 Java 对象世界之间做语义翻译**”。

如果把它们当作无关杂务来看，就很容易错过一个决定性的边界：到底哪一步在做翻译，哪一步在做真正执行。

所以第一种朴素方案失败，不是因为这些模块表面上像一家人，而是因为**它们在职责上确实共享同一种翻译层位置。**

### 朴素方案二：既然最终都要进 VM 或系统调用，那就干脆都交 HotSpot

第二个也很自然的想法是：defineClass 最后进 VM，dlopen 最后也要 VM 帮忙，fd 最后要调 read/write/open/close，时区最后也要依赖系统文件和 libc。既然如此，为什么不干脆都放到 HotSpot 里做？

这个想法的问题在于，它把“JVM 内核运行时职责”和“JDK 类库前的 native 翻译职责”混成了一层。

HotSpot 真正必须持有的是：

- 类定义、类加载、线程、GC、JIT、同步等 VM 内核语义；
- `JVM_LoadLibrary` 这种会牵扯 VM 线程状态、栈保护、异常语义的 VM 级入口；
- 少量平台钩子，如 `JVM_NativePath` 对应的 `os::native_path`。

libjava 则持有另一组责任：

- 把 Java API 的参数翻成 native 可执行协议；
- 把 native 错误、路径、编码、配置翻成 Java 对象；
- 组织 JDK 原生库与 VM 之间的握手，而不是直接接管 VM 内核工作。

如果把这些全下沉到 HotSpot，HotSpot 就会被迫知道太多 JDK 类库侧的翻译细节；反过来，如果把 VM 必须掌握的工作强行留在 libjava，又会让类定义、库加载、栈保护修复这些动作失去应该有的运行时控制权。

所以第二种朴素方案失败，不是因为 HotSpot 不能做这些，而是因为**它不该吃掉 libjava 这层 Java 类库前的翻译职责。**

这两种失败方案合起来，正好引出本篇主线：**这三条线看似分散，其实都在回答“外部世界的原始输入怎样被翻成 Java 世界的稳定语义”。**

## defineClass：为什么 libjava 只搬运和整理，不真正定义类

先看类字节进 JVM 这条线。

`ClassLoader.defineClass1` 的 native 侧实现一上来做的事情其实很朴素：

- 检查 `byte[]` 是否为 null；
- 分配一块 C 堆内存；
- 用 `GetByteArrayRegion` 把 Java 字节复制进去；
- 把类名转成 UTF 字符串；
- 调 `VerifyFixClassname` 把 `.` 这种外部表示修成 JVM 内部惯用的 `/` 形式；
- 最后才把整理好的参数交给 `JVM_DefineClassWithSource(...)`。`src/java.base/share/native/libjava/ClassLoader.c:75`

这条路径里最关键的一点不是“会 malloc 一块内存”，而是：**libjava 在这里并不真正“定义类”，它只是把 Java 世界里的字节和名字翻译成 VM 能吃的那种输入形状。**

### `VerifyFixClassname` 为什么是翻译动作，不是类定义动作

`VerifyFixClassname` 特别能说明这点。

Java 层的类名可能带 `.` 分隔，而 VM 内部在很多路径上用的是斜杠形式 `java/lang/String`。`defineClass1` 先把名字修成 JVM 惯用的内部形式，再交给 VM。`src/java.base/share/native/libjava/ClassLoader.c:123`

这恰好说明 libjava 的职责不是解释 classfile 语义，而是把“Java API 传来的外部名字表示”翻译成“JVM 内部想看到的名字表示”。

真正的 classfile 解析、常量池构建、验证和类元数据安装，都不在这里，而在 `JVM_DefineClassWithSource` 背后的 HotSpot 路径里。`src/java.base/share/native/libjava/ClassLoader.c:136`

所以 defineClass 这条线最该记住的一句话是：**类字节和类名先在 libjava 被整理成 VM 协议，再由 VM 真正定义。**

### `defineClass2`：direct buffer 只是少一层复制，不改职责边界

`defineClass2` 的 ByteBuffer 版本和 `defineClass1` 很像，只不过它直接用 `GetDirectBufferAddress` 拿地址，不再把正文拷到新分配的 C 堆缓冲里。`src/java.base/share/native/libjava/ClassLoader.c:150`

但这并没有改变职责边界：它仍然先做名字翻译，再把最终输入交给 `JVM_DefineClassWithSource`。也就是说，“零拷贝一点”只影响搬运成本，不改变“libjava 负责翻译，VM 负责定义”这条总分工。

## native 库加载：为什么 dlopen 在 VM 里，流程组织在 libjava

再看最容易被说成“就是 `dlopen`”的那条线：`System.loadLibrary()`。

### `load0` 是组织者，不是最终执行者

`ClassLoader$NativeLibrary.load0` 的 native 实现先做的是：

- 把 Java 字符串库名转成平台字符串；
- 走 `JVM_LoadLibrary(cname, throwExceptionIfFail)`；
- 成功后再找 `JNI_OnLoad`；
- 调用 `JNI_OnLoad` 拿版本；
- 校验版本，不合法就卸载并回滚；
- 最后把 `handle` 和 `jniVersion` 写回 Java 对象字段。`src/java.base/share/native/libjava/ClassLoader.c:337`

这条流程非常能说明边界：**`load0` 组织的是“Java 类库视角的加载握手”，但它并不亲自执行最底层的库装入。**

真正的装库入口在 VM：`JVM_LoadLibrary`。`src/hotspot/share/prims/jvm.cpp:3448`

而 Linux 上真正去调 `::dlopen(filename, RTLD_LAZY)` 的，是 `os::Linux::dlopen_helper`。`src/hotspot/os/linux/os_linux.cpp:2106`

所以这条线的分工特别清楚：

- libjava 负责“把一个 Java 层的 `NativeLibrary` 变成一份完整握手流程”；
- HotSpot/OS 负责“真正把 ELF 共享库装进当前进程地址空间”。

### 为什么有些事情必须在 VM 里做

这条分工不是风格选择，而是能力边界决定的。

Linux 上有一段非常关键的保护逻辑：如果被加载库没有声明 `noexecstack`，`dlopen` 可能会让线程栈变成可执行，从而破坏栈 guard page 的保护；这时 VM 需要在恰当时机重新修复各线程的 guard memory。`src/hotspot/os/linux/os_linux.cpp:1883`

这类工作只有 VM 才有资格做，因为：

- 它知道当前有没有 Java 线程；
- 它知道是否能进 VMThread / safepoint；
- 它能在需要时遍历所有 JavaThread 重设 guard。

libjava 拿不到这些运行时控制权。所以这里的边界不是“谁更方便写代码”，而是“**谁拥有足够的线程与栈语义来修这件事**”。

### `JNI_OnLoad`：真正的握手是“找、调、验”三件套

库被装进进程之后，`load0` 还要完成一层 JNI 世界特有的握手。

它会通过 `findJniFunction` 去找：

- 普通库的 `JNI_OnLoad`；
- 内建库的 `JNI_OnLoad_<libname>` 变体。`src/java.base/share/native/libjava/ClassLoader.c:290`

找到以后再调用它，拿到 `jniVersion`，最后用 `JVM_IsSupportedJNIVersion` 校验；如果版本不支持，就抛 `UnsatisfiedLinkError`，并把库卸回去。`src/java.base/share/native/libjava/ClassLoader.c:357`

这条“找、调、验、失败回滚”的流程，就是典型的 libjava 组织职责：**它不拥有 dlopen 本身，但它拥有“Java/JNI 世界需要怎样确认这次加载真的可用”的协议。**

### 为什么“加载时只握手，不预绑定所有方法”也属于翻译边界

native 方法符号本身并不会在 load 时全部绑定。JDK 这里的默认语义是：加载时只关心 `JNI_OnLoad` 这层握手，普通 native 方法符号仍然留到第一次调用时按需解析。

这再次说明，库加载流程不是“把所有符号一次性准备好”，而是“先把 Java 类库和 native 库之间的最低握手协议立住”。之后真正的方法调用链接，仍然是另一层运行时问题。

所以本节最该记住的一句话是：**libjava 组织的是 JNI 握手协议，HotSpot/OS 执行的是共享库装入本身。**

## FileDescriptor：为什么一个 int 字段还要配一套宏和关闭协议

再看最容易被低估的一条线：`java.io.FileDescriptor`。

从 Java 侧看，它像是一个很轻的包装类，仿佛只是把一个本地 fd int 塞进对象里而已。

native 侧的实现恰恰说明，**光有一个 int 远远不够，还得有一整套“如何安全读它、写它、关闭它”的协议。**

### `GET_FD/SET_FD` 为什么不是小语法糖

`FileDescriptor_initIDs` 会先缓存 `fd` 和 `append` 两个 field ID。`src/java.base/unix/native/libjava/FileDescriptor_md.c:50`

随后 `io_util_md.h` 里定义了：

- `SET_FD(this, fd, fid)`
- `GET_FD(this, fid)`
- `THIS_FD(obj)`。`src/java.base/unix/native/libjava/io_util_md.h:49`

这些宏表面上像只是把 `GetObjectField` / `GetIntField` 包了一层，实际上它们在统一两件事：

- Java `FileInputStream` / `FileOutputStream` 等外层对象怎样找到内部那个 `FileDescriptor` 子对象；
- 如果这个子对象是 null，该怎样避免直接把 VM 弄崩，而是统一退成 `-1` 或跳过写入。

所以它们的价值不在“少打几个 JNI 调用”，而在“**把 Java 句柄对象到 native fd 的访问方式标准化**”。

### 读写路径真正分成了 JNI 搬运层和系统调用层

像 `readSingle`、`readBytes` 这类函数，最重要的职责不是发起 read，而是：

- 做 null / 越界检查；
- 决定用栈上 8KB 缓冲还是临时 malloc；
- 把读到的数据写回 Java `byte[]`。`src/java.base/share/native/libjava/io_util.c:38`

真正的系统调用细节则在 `handleRead` / `handleWrite` 这一层，而且这里明确用了 `RESTARTABLE(read(...))` / `RESTARTABLE(write(...))` 把 `EINTR` 重试吞掉。`src/java.base/unix/native/libjava/io_util_md.c:166`

这非常能体现 libjava 的分层味道：**Java 层对象搬运、JNI 数组拷贝、异常翻译在上；Unix `read/write` 细节在下。**

### `fileOpen`：为什么连“尾部的 `/`”都要管

`fileOpen` 也很能说明这里不是“拿 path 调 open”那么简单。Linux/Unix 路径下，它会先在平台字符串上剥掉尾部连续 `/`，因为内核不喜欢这种形式；真正 `open64` 后还要 `fstat64` 一次，发现目标其实是目录就立刻 `close` 并改成 `EISDIR`。`src/java.base/unix/native/libjava/io_util_md.c:95`

这再次说明 libjava 在这里干的不是“执行系统调用”，而是**把系统调用结果校正成 Java I/O API 想暴露的语义**。

### `fileDescriptorClose`：为什么要先置 -1，再考虑真正 close

`fileDescriptorClose` 的两处细节最值得停一下。

第一，它会先把 Java 对象里的 fd 字段设成 `-1`，再去真正 close 底层 fd。源码注释写得很清楚：这样可以缩短别的线程错误复用已关闭 fd 的竞态窗口。`src/java.base/unix/native/libjava/io_util_md.c:124`

第二，对 0、1、2 这三个标准流，它根本不直接 close，而是把它们重定向到 `/dev/null`。因为如果把它们真关了，后面任何一个新打开的文件或 socket 都可能重新拿到 0/1/2，悄悄把标准输入输出语义污染掉。`src/java.base/unix/native/libjava/io_util_md.c:147`

这两点特别能说明 FileDescriptor 这一层真正防的不是“正常路径”，而是“**fd 被关闭后复用、标准流被重新占用**”这类 Unix 特有的后坐力。

所以本节最该记住的一句话是：**FileDescriptor 不是存一个 int，而是在给这个 int 套一层 Java 对象语义和关闭协议。**

## TimeZone：为什么默认时区探测是一条阶梯式回退链

最后看默认时区这条线。

如果只看 Java API，很容易把 `TimeZone.getDefault()` 想成“查个环境变量”或者“读一下 `/etc/localtime`”。实际的 native 路径远比这更像一条层层回退的翻译链。

### Java 入口只是牵线，真正探测在 `findJavaTZ_md`

`TimeZone.getSystemTimeZoneID` 的 native 实现非常薄：拿到 `java_home`，调用平台函数 `findJavaTZ_md(java_home_dir)`，如果得到 tzid，再把它翻成 Java `String` 返回。`src/java.base/share/native/libjava/TimeZone.c:40`

这再次体现了本域的共性：Java 入口本身并不做复杂逻辑，它只是把请求交给平台翻译函数，再把结果收回到 Java 世界。

### 为什么优先级是 `TZ` → `/etc/timezone` / `/etc/localtime` → GMT 偏移

`findJavaTZ_md` 的逻辑非常清楚：

- 先看 `TZ` 环境变量；
- 如果没有，再调用 `getPlatformTimeZoneID()` 去读系统文件；
- 如果拿到值，还要顺手洗掉前导 `:` 和 Linux 上的 `posix/` 前缀；
- 全部失败，Java 侧后续还有 GMT 偏移兜底。`src/java.base/unix/native/libjava/TimeZone_md.c:793`

这说明默认时区探测并不是“读某一个权威来源”，而是**按便宜程度和可靠程度层层尝试**。

### `getPlatformTimeZoneID`：为什么 `/etc/localtime` 还分三种情况

Linux 路径下，`getPlatformTimeZoneID()` 会先试 Debian 系常见的 `/etc/timezone` 单行文件。`src/java.base/unix/native/libjava/TimeZone_md.c:251`

拿不到，再看 `/etc/localtime`：

- 如果它是符号链接，就通过 `readlink` 取出目标路径，再从 `zoneinfo/` 后面的片段抠出 tzid；
- 如果它是普通文件，就只能把文件内容读出来，再去 `/usr/share/zoneinfo` 里找内容一模一样的那个 zoneinfo 文件；
- 两条都失败，就返回 NULL。`src/java.base/unix/native/libjava/TimeZone_md.c:251`

这一步非常说明时区探测不是“读配置”，而是在做“**把系统侧各种可能的配置表达形式翻译成 Java 认可的 Olson tzid**”。

同一个“Asia/Shanghai”，在系统里可能表现成：

- `TZ=Asia/Shanghai`
- `/etc/timezone` 里的一行文本
- `/etc/localtime -> /usr/share/zoneinfo/Asia/Shanghai` 的符号链接
- 或者一份被直接 copy 过去的二进制文件。

libjava 的职责就是把这些形态统一翻译成同一种 Java 侧时区 ID。

### 最后一层：`getGMTOffsetID` 不是主路径，而是保险丝

如果前面都失败了，native 侧还有 `getGMTOffsetID()`：

- 先拿本地时间和 UTC；
- 再格式化出像 `GMT+08:00` 这样的 ID。`src/java.base/unix/native/libjava/TimeZone_md.c:855`

这一步很重要，因为它说明默认时区探测并不是“找不到 zoneinfo 就报错”，而是尽量保证 Java 世界至少拿到一个能表达当前偏移的时区 ID。

所以 TimeZone 这条线最该记住的一句话是：**它不是读取某个单点配置，而是在把操作系统侧多种时区表达形式折叠成 Java 的统一时区标识。**

## 到这里为止，主线其实只发生了四件事

如果前面信息不少，这里先把整件事压回四步：

1. 类字节先在 libjava 被搬运和整理，再交给 VM 真正定义；
2. native 库加载由 libjava 组织 JNI 握手，但共享库装入和栈保护修复必须落在 VM/OS 侧；
3. `FileDescriptor` 给裸 fd 套上 Java 对象访问和关闭协议；
4. TimeZone 把 `TZ`、时区文件和 GMT 偏移这几种系统配置形态翻成 Java 统一 tzid。

只要这四步还在脑子里，这篇就不再像“三件剩余杂活”的拼盘。

## 常见误解澄清

### 误解一：`defineClass1` 真正完成了类定义

不是。

它负责的是字节搬运、名字整理和参数准备；真正的类定义发生在 `JVM_DefineClassWithSource` 背后的 VM 路径里。`src/java.base/share/native/libjava/ClassLoader.c:136`

### 误解二：`JVM_LoadLibrary` 就等于 libjava 自己 `dlopen`

不对。

libjava 侧的 `load0` 只是组织加载与 `JNI_OnLoad` 握手；真正的 `dlopen` 和 execstack/guard page 修复都在 HotSpot/OS 路径里。`src/hotspot/share/prims/jvm.cpp:3448`、`src/hotspot/os/linux/os_linux.cpp:2106`

### 误解三：`JNI_OnLoad` 等于库里所有 native 方法在加载时都已绑定

不是。

加载时主要完成的是初始化入口和版本握手；普通 native 方法符号默认仍是按需动态链接，不会在 load 阶段全部预绑定。

### 误解四：`GET_FD/SET_FD` 只是语法糖

不只是。

它们统一了 Java 外层对象到内部 `FileDescriptor` 的访问路径，并在 null / 关闭态上给出一致语义，是“Java 句柄对象如何触到 Unix fd”的小协议。`src/java.base/unix/native/libjava/io_util_md.h:53`

### 误解五：默认时区永远只看 `TZ`

不对。

`TZ` 只是最高优先级的一层；缺席时还会退到 `/etc/timezone`、`/etc/localtime`，再不行才退到 GMT 偏移。`src/java.base/unix/native/libjava/TimeZone_md.c:793`

## 收网：这三条线的共同点，不是“都用到了 C”，而是“都在做语义翻译”

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
外部输入
  ├─ class bytes / direct buffer
  ├─ shared library handle / JNI_OnLoad
  ├─ int fd / path string
  └─ TZ env / /etc/localtime / GMT offset

libjava 翻译层
  ├─ defineClass1/2        : 字节与类名整理后交 JVM
  ├─ NativeLibrary.load0   : 组织库加载握手
  ├─ GET_FD/SET_FD + io    : fd 与 Java FileDescriptor 对接
  └─ findJavaTZ_md         : 系统时区探测与 Java tzid 映射

HotSpot / OS 真正执行者
  ├─ JVM_DefineClassWithSource
  ├─ JVM_LoadLibrary / dlopen
  ├─ read/write/open/close
  └─ readlink/realpath/strftime/TZ files
```

把它再压成三句话：

- libjava 不负责替 VM 或内核重做底层工作，它负责把外部输入翻成 Java 世界能稳定消费的语义形状。
- defineClass、loadLibrary、FileDescriptor、TimeZone 看似分散，真正共享的是“翻译层”位置，而不是业务主题。
- 只要某件事开始牵扯 VM 内核状态、线程保护或 OS 原始接口，libjava 就会把它交给 HotSpot 或系统调用去真正执行。

所以这一篇真正该留下来的结论，不是某个单独 API 的实现细节。

真正该留下来的是：**libjava 在这里扮演的始终不是执行者，而是翻译器。它把类字节、库句柄、文件描述符和系统时区这些外部世界的原料，整理成 Java 世界可复用、可组合、可保持一致语义的入口。**

从这里往后，就会从“传统阻塞 I/O + 本地句柄”这类老路径，进入另一套更强调多路复用、Buffer 和事件分发的 native 世界，也就是 NIO/Net。

> → [43-nio-net/01 — TCP Socket](../43-nio-net/01-tcp-epoll.md)
