# Attach 机制：为什么诊断工具不是“直接碰 JVM”，而是先打开一条跨进程管理通道

> 本文基于 JDK 11 Attach API，重点覆盖 `VirtualMachine`、`AttachProvider` SPI、Linux `VirtualMachineImpl`、`HotSpotVirtualMachine.execute`。本文聚焦“工具进程如何连上目标 JVM 并发命令”；Instrumentation 与字节码增强放到下一篇。本文讨论的是 JDK 11 Attach 通道机制，不把这里的 Linux 套接字路径、provider SPI 组织方式和 execute 命令协议外推成所有 JVM 工具接入都必须遵守的统一规范。
> **前置依赖**：[双亲委派与 SPI](../07-classloader/01-delegation-model.md)、[字节流与响应流](../17-io-streams/01-byte-streams.md)
> **后续**：[Instrumentation 与字节码增强](02-instrumentation.md)

## 先看最容易被忽略的一层：`jstack`、`jcmd`、Arthas 首先不是“分析 JVM”，而是“先连上 JVM”

很多人谈诊断工具时，会直接跳到它们能做什么：线程 dump、加载 agent、执行命令、拿系统属性、做字节码增强。但这些能力真正成立之前，其实还有一个更基础的问题：**工具进程怎么和另一个正在运行的 JVM 说上话？**

这不是 Java 对象之间的普通方法调用，也不是同一个进程里拿一个引用就能完成的事。工具和目标 JVM 在操作系统看来是两个独立进程，所以第一步必须先建立一条跨进程管理通道。Attach API 解决的，正是这件事。

也正因为如此，这一篇不能从 agent 或 transformer 开始讲。那些能力都建立在“通道已经打通”之后。Attach 的真正主线应该是：工具怎样找到目标 JVM、怎样按平台方式接进去、怎样完成握手，然后怎样在这条连接上发命令、收结果。

## 一、为什么 `VirtualMachine.attach(pid)` 只是门面：它先统一入口，再把连接细节交给平台实现

### 先看公共入口本身

JDK 11 里，`VirtualMachine` 类定义在 `VirtualMachine.java:99`。两个 attach 入口在：

- `VirtualMachine.attach(String)`：`VirtualMachine.java:194`
- `VirtualMachine.attach(VirtualMachineDescriptor)`：`246`

旧稿已经抓到了核心链路：`attach(String)` 不会自己直接完成所有连接动作，而是先获取 provider 列表，再逐个尝试平台实现，直到某个 provider 成功把目标 JVM 接上。

### 为什么这说明 Attach 天生就是平台 SPI

这点非常关键。诊断工具面对的“连接另一个 JVM”问题，本来就不可能只靠一套纯 Java、纯跨平台的统一细节解决。不同平台上，如何发现目标、如何建立本地管理连接、如何触发目标监听，底层做法都会不同。

所以 JDK 把 Attach 设计成两层：

- `VirtualMachine` 负责提供统一门面；
- `AttachProvider` 负责把这套门面落成具体平台实现。

这也解释了为什么工具代码可以写成统一风格，而连接细节却不会硬编码死在 `VirtualMachine.attach()` 里。**Attach 的第一层抽象，不是诊断命令，而是“跨平台连接另一个 JVM”这件事本身。**

## 二、为什么 Linux 会落成 `.java_pid<pid>` 套接字：目标 JVM 要先暴露一条本地控制端点

### 先看平台实现的落点

旧稿已经定位到 Linux 平台实现 `VirtualMachineImpl`，类定义在 `jdk.attach/linux/classes/sun/tools/attach/VirtualMachineImpl.java:50`。它保存的就是目标 JVM 对应的套接字路径，并通过查找 `.java_pid<pid>` 这一类本地文件来确认目标 JVM 是否已经把 Attach listener 打开。

### 为什么工具不是“直接进入 JVM”，而是先找一个本地通信端点

这点很容易被抽象词汇掩盖掉。Attach 不是某种魔法入口，不是知道了 PID 就能直接穿透进 JVM 内部。它首先仍然要依赖一个操作系统层面的通信端点。在 Linux 上，这个端点就是目标 JVM 暴露出来的 Unix domain socket，也就是旧稿里提到的 `/tmp/.java_pid<pid>` 这一类路径。

只有当这个端点存在且能连接时，工具和目标 JVM 之间的控制通道才真正成立。

### 为什么目标尚未监听时还要先“叫醒”它

旧稿已经点到一个很关键的实现细节：如果目标 JVM 还没把 Attach listener 打开，Linux 实现会先通过信号去触发它。这个动作的意义不是“执行诊断命令”，而是先促使目标 JVM 把那条本地管理通道准备好。

这说明 Attach 连接的关键并不只是客户端去连，而是**目标 JVM 也必须先愿意并能够暴露一条可连接的 listener。** 如果这一步没成立，后面的命令、agent、响应流全都无从谈起。

## 三、为什么 Attach 通道建立后不是“直接调接口”，而是走一条极简命令协议

### 先看协议线索

旧稿已经抓到了 Linux 实现中的几个关键点：

- `PROTOCOL_VERSION = "1"`
- 先写协议版本
- 再写命令名
- 再写参数

这说明 Attach 通道一旦建立，工具和目标 JVM 之间并不是共享对象、共享内存或直接函数跳转，而是进入一条明确的命令-响应协议。

### 为什么这一步要显式握手版本

只要两边是独立进程，协议兼容性就必须被显式管理。先写协议版本，不是形式主义，而是在说：“我们接下来要按哪一种命令格式、参数布局和响应规则讲话。” 没有这个最小握手，Attach 通道就很难在实现演进中保持稳定边界。

### 为什么“命令 + 参数 + 响应流”就足够支撑诊断体系

这一层的妙处正在于足够小。Attach 通道并不尝试一上来就变成一个庞大框架，它只需要提供一件事：**把命令可靠发到目标 JVM，再把结果以流的形式带回来。** 一旦这条最小协议稳定了，线程 dump、属性查询、JMX 管理命令、agent 加载都可以挂在上面。

也就是说，Attach 先提供的是一条运输线，不是货物本身。

## 四、为什么 `HotSpotVirtualMachine.execute(...)` 本质上是一条极简 RPC：Attach 的核心不是命令内容，而是命令通道

### 先看 execute 的位置

旧稿已经定位到：`HotSpotVirtualMachine.execute(String, Object...)` 在 `HotSpotVirtualMachine.java:301`。这基本就是 Attach 通道在 HotSpot 侧的命令执行门面：工具把命令名和参数交给它，它返回一个响应 `InputStream`。

### 为什么说它本质上就是 RPC

只要把过程抽象一下，就会发现它和很多 RPC 没本质区别：

- 客户端发命令；
- 服务端执行；
- 结果通过响应流返回。

区别只是这里的“客户端”是诊断工具进程，“服务端”是目标 JVM 的 attach listener，而协议极简到只需要命令名、参数和流。

这也解释了旧稿里提到的另一个关键事实：agent 加载最终也只是 `execute("load", ...)` 这样的一个命令。也就是说，**agent 不是 Attach 之外的另一套神秘入口，而是 Attach 管道上的一种具体负载。**

## 五、为什么必须先把 Attach 通道讲清，再去讲 Instrumentation：通道是入口，增强只是挂在入口上的一种能力

### 先把两层问题分开

如果不先把 Attach 建通道这一步讲清，读者很容易误以为 Arthas、APM、在线增强这些东西，好像一开始就能直接改目标 JVM 的类。实际上，它们首先必须解决的是“怎样把命令和 agent 送进去”。这件事本身就是 Attach 负责的。

所以本篇和下一篇的分工应该非常清楚：

- 本篇解决“工具如何连上目标 JVM，并在这条连接上发命令”；
- 下一篇再解决“agent 被送进去之后，Instrumentation 能对类做什么”。

### 为什么这种顺序是理解上的必需品

因为 Attach 和 Instrumentation 分别回答的是两个完全不同的问题：

- Attach 回答“怎么进门”；
- Instrumentation 回答“进门之后能改什么、怎么改”。

顺序一乱，读者就会把“建立管理通道”和“执行字节码增强”误当成同一层机制。

## 六、五个最容易混掉的边界：Attach 不是 JVM 内调用，PID 不是控制权，套接字不是细枝末节，execute 不是本地函数跳转，agent 加载也不是另一条秘密通道

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，Attach 不是 JVM 内部对象之间的普通方法调用。工具和目标 JVM 在操作系统看来本来就是两个独立进程，所以第一问题始终是“这两个进程怎么建立管理通道”，而不是“Java 里该调用哪个对象方法”。

第二，知道 PID 也不等于已经拿到了控制权。PID 只能帮助你定位目标；真正有价值的是目标 JVM 是否已经愿意通过平台实现暴露 attach listener，是否存在那条可连接的本地控制端点。

第三，Linux 上的 `.java_pid<pid>` 套接字更不是无关紧要的实现细节。它正是这条跨进程管理通道在 OS 层的真实落点；如果这个端点找不到、连不上，后面的所有诊断命令、属性查询、agent 加载都无从谈起。

第四，`execute(...)` 也不是本地函数跳转的包装皮。它本质上是一条极简 RPC：命令和参数被写到通道里，目标 JVM 侧执行，再把结果按响应流带回来。Attach 真正统一的是这条命令通路，不是某一个具体能力。

第五，agent 加载更不是 Attach 之外的另一条秘密通道。它只是 Attach 通道上的一种具体负载：先连上、再发命令、目标 JVM 接收并处理。只有先把“进门”讲清，后面的 Instrumentation 和字节码改写才不会被误听成凭空发生的黑魔法。

把这五条边界记稳，Attach 这一篇就不会重新塌回“JDK 提供了一个能连 PID 的工具 API”这种表面印象。它真正想讲的是：诊断工具要先把跨进程管理连接这件事做成，再把所有后续能力都挂到这条连接上。

## 收网：Attach 真正解决的不是某个工具命令，而是让另一个进程先连上 JVM 的那条管理通道

现在可以把整篇压成一条主线：

- 诊断工具首先面对的是跨进程连接问题，而不是 JVM 内部对象调用问题；
- `VirtualMachine.attach()` 只是统一门面，真正连接细节交给平台 provider；
- Linux 上这条连接会落成 `.java_pid<pid>` 这一类本地套接字端点；
- 如果目标尚未监听，工具还要先促使目标 JVM 把 listener 打开；
- 通道打通后，再通过版本、命令、参数、响应流构成极简协议；
- `execute(...)` 因而本质上就是 Attach 管道上的极简 RPC；
- agent 加载也只是这条通道上的一种具体命令负载。

所以理解 Attach 的正确角度，不是“JDK 提供了一个能连 PID 的工具 API”，而是：**JDK 为诊断工具和运行中 JVM 之间建立了一条平台相关、可握手、可发命令、可回流结果的管理通道。** 这条通道一旦打通，后面的 agent 注入、类转换、在线诊断才有了真正的入口。

下一篇自然就会接住这条入口之后最关键的能力：agent 已经被送进 JVM 了，那 `Instrumentation` 到底给了它什么权限，transformer 怎样挂上去，已加载的类为什么还能 retransform，这就是 `02-instrumentation.md` 要接着回答的问题。
