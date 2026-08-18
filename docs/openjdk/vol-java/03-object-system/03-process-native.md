# 03. 进程与本地交互 — ProcessBuilder 启动流程、fork+exec、VM 初始化

> **前置依赖**: [03-object-system/02 — System 与 Runtime](02-system-runtime.md)(exit 流程与 VM 属性快照)
> → **后续**:域 07 类加载器(07-classloader 系列,下一篇)
> 关联: 内部卷 30-jvm-entry(启动与退出序列);内核: fork(2)/execve(2)/waitpid(2)

## 一行 start,背后几步

`Process p = new ProcessBuilder("curl", url).start()`——生产代码里拉起外部命令的标配写法。但这一行背后有几步?谁创建了管道?子进程是怎么"出生"的?为什么 `p.getInputStream().read()` 不读就会卡死整个流程?更远的: main 方法执行之前,Java 侧的第一段代码又是什么?

这篇把两条链拆开: 子进程的启动流水线(配置 → 平台实现 → forkAndExec → 管道 → waitFor),以及 JVM 启动时 Java 侧与 VM 的初始化握手。最后看信号: `kill -9` 和 `kill -15` 对 Java 进程意味着什么。

## 1. "ProcessBuilder.start 发生了什么" — 启动流水线

### 1.1 第一层:参数校验与安全检查

`ProcessBuilder.start()`(`ProcessBuilder.java:1070`)转调私有 `start(Redirect[])`(`ProcessBuilder.java:1077` 起),校验链:

- 命令数组克隆(防恶意 list 绕过安全检查)、元素非空检查
- `SecurityManager.checkExec(prog)`(启用安全管理器时)
- **NUL 字符检查**:`s.indexOf('\u0000')`——命令行参数不能含 NUL,否则抛 IOException("invalid null character in command")(`ProcessBuilder.java:1101-1104`)——这是防注入的硬约束(NUL 在 execve 里是参数终止符)

然后委托给平台实现(`ProcessBuilder.java:1107-1111`):

```java
// ProcessBuilder.java:1107-1111(截取核心,逐字)
return ProcessImpl.start(cmdarray,
                         environment,
                         dir,
                         redirects,
                         redirectErrorStream);
```

### 1.2 第二层:平台实现与 std_fds 组装

`ProcessImpl` 是**平台目录**里的实现(JDK11 在 `java.base/unix/classes/java/lang/ProcessImpl.java`,Linux 专属逻辑再往下)——`static Process start(...)`(`ProcessImpl.java:187`)。它做的第一件事是把 Java 参数编码成 C 友好的连续内存块:

- **argBlock**:所有参数拼成一个连续 byte[] 数组、NUL 分隔(`ProcessImpl.java:198-210`)——注释说 "it's easier to do memory management in Java than in C"
- **envBlock**:环境变量同样编码成连续块(`ProcessImpl.java:212-213`)
- **std_fds**:三个标准流的文件描述符(`ProcessImpl.java:215-265`)——按重定向配置逐档决定:

```java
// ProcessImpl.java:228-237(截取核心,逐字)
if (redirects[0] == Redirect.PIPE) {
    std_fds[0] = -1;
} else if (redirects[0] == Redirect.INHERIT) {
    std_fds[0] = 0;
} else if (redirects[0] instanceof ProcessBuilder.RedirectPipeImpl) {
    std_fds[0] = fdAccess.get(((ProcessBuilder.RedirectPipeImpl) redirects[0]).getFd());
} else {
    f0 = new FileInputStream(redirects[0].file());
    std_fds[0] = fdAccess.get(f0.getFD());
}
```

四个分支对应四种重定向: **PIPE → -1**(告诉 native"给我建管道")、**INHERIT → 0/1/2**(继承父进程标准流)、**RedirectPipeImpl → 复用已有 fd**(进程间管道直接传)、**文件 → 打开后取 fd**。这个 `std_fds` 数组就是 native 层唯一需要的"重定向配置"。

### 1.3 第三层:native forkAndExec

`ProcessImpl` 构造器(`ProcessImpl.java:331-358`)调用核心 native:

```java
// ProcessImpl.java:322-329(截取核心,逐字)
private native int forkAndExec(int mode, byte[] helperpath,
                               byte[] prog,
                               byte[] argBlock, int argc,
                               byte[] envBlock, int envc,
                               byte[] dir,
                               int[] fds,
                               boolean redirectErrorStream)
    throws IOException;
```

native 方法**一次调用完成管道创建 + fork + exec**,返回 pid。之后 Java 侧包装: `ProcessHandleImpl.getInternal(pid)`(`ProcessImpl.java:348`)建立句柄,`initStreams(fds, ...)`(`ProcessImpl.java:352`)按 fds 创建 `ProcessPipeInputStream`/`ProcessPipeOutputStream`——子进程的 stdout/stderr 就是父进程侧的管道读端。

关键设计(斜体):*ProcessBuilder 是"配置"(命令、环境、目录、重定向的 DSL),ProcessImpl 是"执行"(平台专属)。接口与平台实现分离,unix/linux 平台目录各放一份——JDK 的跨平台就是这么切的。面试/生产的经典 bug: `p.getInputStream().read()` 会阻塞——**不消费子进程输出,管道缓冲区(约 64KB)写满,子进程的 write 阻塞**,进程双双卡死。读完输出再 waitFor 是铁律。*

## 2. "fork + exec 是什么" — 子进程的诞生

### 2.1 三种启动机制

`forkAndExec` 的 javadoc(`ProcessImpl.java:303-310`)写明了三种机制:

```
1 - fork(2) and exec(2)
2 - posix_spawn(3P)
3 - vfork(2) and exec(2)
```

平台默认值由 `LaunchMechanism` 枚举决定(`ProcessImpl.java:83-105`): **Linux 默认 VFORK**,备选 POSIX_SPAWN 和 FORK(`ProcessImpl.java:92`);BSD/Solaris 默认 POSIX_SPAWN。选型的考虑是安全和性能: vfork 避免拷贝页表(写时复制之前的最快路径),但语义危险(子进程 exec 前共享父进程地址空间),所以只在信任的启动路径用。

### 2.2 POSIX 语义:两步,一次封装

进程诞生的 POSIX 语义: **fork**(复制当前进程,写时复制——不真正拷贝内存,只在写入时分裂)把 JVM 进程复制出一份;**exec**(`execve`)用新程序映像替换子进程地址空间。两步合一的原因: fork 之后 exec 之前,子进程还"是"父进程——管道重定向、fd 关闭等准备工作在这个窗口做掉,exec 后子进程带着配置好的 fd 运行。

Java 侧不需要看到这些: `forkAndExec` 一个 native 调用包圆了"建管道 + fork + 配置 fd + exec + 返回 pid"。

### 2.3 waitFor:wait/notify 模型

`Process.waitFor()`(`ProcessImpl.java:493-498`)是教科书式的 wait/notify:

```java
// ProcessImpl.java:493-498(截取核心,逐字)
public synchronized int waitFor() throws InterruptedException {
    while (!hasExited) {
        wait();
    }
    return exitcode;
}
```

Java 侧**不直接轮询子进程**——`hasExited` 标志由回调设置: `ProcessHandleImpl.completion(pid, true)` 注册的完成回调(`ProcessImpl.java:389-406`)在子进程退出时执行——native 侧(waitpid 路径)监控到退出,回调里 `synchronized (this) { exitcode = ...; hasExited = true; notifyAll(); }`,并顺带 `processExited()` 唤醒管道流(`ProcessImpl.java:396-403`)——阻塞在读管道上的线程被唤醒、读到 EOF。

关键设计(斜体):*为什么不能纯 Java 做?进程创建必须走内核(fork/execve),这是操作系统唯一合法的"造进程"入口。Java 的 native 封装把"创建 + 管道 + 等待"打包,避免每步一个系统调用的重复代码和状态管理。面试点: "Process 不是线程——它是内核进程,Java 侧通过管道与其通信、通过回调感知退出"。*

## 3. "JVM 启动时 Java 侧做了什么" — VM 初始化

### 3.1 第一个 Java 代码:静态块里的握手

main 方法执行前,Java 侧最早的执行点是 `jdk/internal/misc/VM` 的静态块(`VM.java:412-415`):

```java
// VM.java:412-415(截取核心,逐字)
static {
    initialize();
}

private static native void initialize();
```

`VM` 是 Java 侧与 JVM 的"初始化握手点": 静态块触发 native `initialize()`——VM 侧完成启动准备(内存初始化、标志解析等)。`VM.isBooted()`(`VM.java:93`)标志"启动完成";`saveAndRemoveProperties`(第 2 篇 §3)在随后的 `System.initPhase1` 阶段执行——静态块是握手,属性快照是握手之后的第一件事。

### 3.2 System 的 registerNatives

`System` 类(`System.java:101-103`)同样在静态块里做一件事:

```java
// System.java:101-103(截取核心,逐字)
private static native void registerNatives();
static {
    registerNatives();
}
```

`registerNatives` 把 Java 声明的 native 方法(如 `System.arraycopy`、`currentTimeMillis`)与 JVM 侧的 C 函数绑定。**顺序的鸡生蛋问题**: `System.getProperty` 的 native 支持要先绑定,VM 才能通过 `initProperties` 注入属性——所以注册必须在属性初始化之前。

启动顺序大致是: VM 静态块(VM 初始化)→ System 静态块(native 绑定)→ initPhase1(属性注入 + saveAndRemoveProperties)→ 用户 main。

跨层标注: [内部卷: 30-jvm-entry(启动序列: main 入口 → System 初始化 → 用户 main)]

关键设计(斜体):*启动顺序的"鸡生蛋"是 JDK 初始化设计的主线: 属性读取需要 native → native 需要先注册 → 注册需要 VM 已初始化 → VM 初始化由静态块触发。每一层都在"尽可能早但依赖必须就绪"之间选择。面试问"main 之前发生了什么",能说出"VM 静态块 → registerNatives → initPhase1"三段就超过 90% 的人。*

## 4. "Signal 与进程间信号" — kill -9 与 kill -15

### 4.1 Java 侧的信号注册

`jdk/internal/misc/Signal`(`Signal.java:73`)提供 Java 侧信号注册: `Signal.handle(sig, handler)`(`Signal.java:164`)转调 native `handle0`(`Signal.java:237`)——把 Java 回调注册进 JVM 的信号分发器,收到信号时 dispatch 到回调。

### 4.2 两个 kill 的差别

- **SIGTERM(15)**:可捕获。JVM 收到后把它转成 **shutdown 流程**——第 2 篇的 `Shutdown.exit` 路径: 执行所有 shutdown hooks、清理,然后退出。这就是"优雅停机"的机制来源
- **SIGKILL(9)**:**不可捕获、不可忽略**。进程被内核直接终止,钩子不执行、清理不跑——"kill -9 丢数据"的本质

生产映射: K8s 的 `terminationGracePeriodSeconds`(默认 30 秒)窗口内先发 SIGTERM 让 JVM 跑钩子;超时未退出再 SIGKILL。发布系统的优雅关闭时间预算 = 钩子执行时间,超了就退化成强杀。

关键设计(斜体):*信号是内核给进程的"带外通知"——JVM 把 SIGTERM/SIGINT(ctrl+C)接进自己的 shutdown 状态机,让"外部终止请求"与"内部优雅关闭"复用同一条路径;SIGKILL 则没有协商余地。面试能说清"kill -15 走钩子、kill -9 直接没"是基础,能补上"K8s 优雅窗口是钩子的预算"就带出了生产视角。*

跨层标注: [内核: man 7 signal(信号投递与默认行为)]

## 核心悬念

进程有了,对象也有了——但**类**是怎么从磁盘走进 JVM 的?`String` 的字节码、`IntegerCache` 的缓存,这些类是谁加载的?`ClassLoader` 的双亲委派为什么是那个形状?`-D` 参数、classpath、模块系统又是怎么参与加载的?下一站进入类加载域: 从 `ClassLoader` 的 3000 行开始,把"类的一生"讲清楚。

> → 下一篇: 域 07 类加载器(07-classloader 系列)| 关联: 内部卷 30-jvm-entry(启动)、07-classfile-classloader(系统字典)
