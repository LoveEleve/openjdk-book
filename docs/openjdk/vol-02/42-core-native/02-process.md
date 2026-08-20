# 02. 为什么 `Runtime.exec()` 不是两次系统调用？— 进程管理的 native 协议

> **版本边界**：本文基于 `OpenJDK 11u / Linux / x86_64 / libjava`。这里讨论的是 Unix 路径下 Java 进程管理的 native 协议：`ProcessBuilder.start()` / `Runtime.exec()` 如何落到 `forkAndExec`，子进程如何在 `exec` 前重排自己的文件描述符与工作目录，父进程如何拿到准确的 exec 成败结果，以及 `ProcessHandle` 如何通过 `/proc` 和 `startTime` 管住查询与销毁。Windows 路径不在本文展开。
>
> **前置依赖**：[01 — 为什么 `System.getProperties()` 背后要有一层 native 骨架？— libjava 的 JNI 工具层与系统属性](01-jni-system.md)
> → **后续**：[03 — ClassLoader + I/O + TimeZone](03-class-io.md)

Java 层看起来最“像系统调用”的 API 之一，大概就是 `Runtime.getRuntime().exec(...)` 或 `new ProcessBuilder(...).start()` 了。

表面上看，它们像是在说一件很简单的事：拿一行命令，交给操作系统，新起一个进程。

但如果你顺着 OpenJDK 的 Unix 实现往下追，会很快发现事情远没有“调个 `fork()` 再 `exec()`”那么直白。native 侧要做的远不止启动子进程本身，还包括：

- 把 Java 世界里的 `String[]`、环境变量 `Map`、重定向配置翻译成 C 能消费的形状；
- 在 child 进程里把标准输入输出、错误流、工作目录、多余文件描述符改造成目标形状；
- 在 parent 进程里精确知道：`exec` 到底成功没成功；
- 到查询和销毁阶段，还要解决 `/proc` 解析、`waitpid`、pid 复用误杀这些进程身份问题。

这就逼出本篇最该回答的问题：**Java 层一行 `exec("ls -la")`，为什么底下不是简单的 `fork(); execvp();`？JDK 为什么还要自己打包参数块、设计 fail pipe、区分 `vfork`/`posix_spawn`、在 `destroy()` 时还要拿 `startTime` 再验一次 pid？这些看起来过度复杂的步骤，到底分别在防什么坑？**

先把答案压成一句话：**JDK 的进程面不是“帮你调系统调用”，而是在为 Java 世界补上一整套操作系统协议缺口：Java 参数/环境要先翻成 C 数组；fork 之后子进程必须在 exec 前把标准流、工作目录、继承 fd 清成目标形状；父进程还得拿到“exec 到底成没成”的准确结果；而到了查询和销毁阶段，又必须用 `(pid, startTime)` 而不是裸 pid 给进程做身份校验，避免 pid 复用误杀。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：Java 侧把命令传下来，native 里直接 `fork + execvp`

这是最自然的第一反应。

Java 把命令行丢给 native，native 里做：

- `fork()` 复制自己；
- child 里 `execvp()` 执行目标程序；
- parent 回去继续跑。

听起来非常像教科书上的 Unix 进程模型。

问题是，这只覆盖了“把一个新程序拉起来”这件事，却几乎没回答 Java 世界真正提出的协议问题。

比如：

- Java 的参数是 `String[]`，native 要的是 `char** argv`；
- 环境是 `Map<String,String>`，native 要的是 `char** envp`；
- `Redirect.PIPE`、`Redirect.INHERIT`、重定向到文件，这些 Java 侧语义都要落成具体 fd 布局；
- `redirectErrorStream(true)` 不是命令参数，而是 child 里一条 `dup2(1, 2)` 语义；
- 失败如果发生在 `chdir` 或 `exec` 之前，parent 不能只知道“child 退出了”，还得知道到底是哪一步失败、errno 是多少。

也就是说，简单的 `fork + execvp` 只是一段骨架，远远不够组成 Java API 需要的完整行为。

所以第一种朴素方案失败，不是因为 `fork/exec` 本身不对，而是因为**Java 的进程 API 需要的不是“起一个进程”，而是“一套从 Java 语义到 Unix 语义的完整协议”。**

### 朴素方案二：就算要补协议，也没必要这么多额外通道和校验

第二个也很自然的想法是：好，我承认要多做点转换。但为什么还要 fail pipe、为什么 destroy 还要验证 `startTime`、为什么 reaper 线程不让当前线程自己 `waitpid`？这些看起来像对边角问题的过度防御。

这个想法低估了 Unix 进程世界里几个特别烦人的现实：

- `exec` 的成功与失败并不能在 parent 里“提前知道”；
- pid 会被复用，今天这个 pid 对应的不是明天那个进程；
- Java 的 `waitFor()`、`onExit()`、`ProcessHandle` 查询和销毁都可能跨线程、跨时刻发生。

也就是说，JDK 这里补的不只是“把参数翻成 `argv`”，而是把操作系统原生接口里那些对 Java API 不够友好的地方，变成 Java 世界能稳定消费的协议。

所以第二种方案失败，不是因为 JDK 过度谨慎，而是因为**这些额外协议恰好对应了 Unix 进程模型里最容易让高层 API 失真的几个坑。**

这两种失败方案合起来，正好引出本篇主线：**JDK 的进程面并不是调用系统调用，而是在补 Java 和 Unix 之间的协议缺口。**

## 启动前打包：为什么参数块和 `std_fds` 要在 Java 层先压好

先看最前面那层翻译。

`ProcessImpl.start()` 不会把 `String[]` 原样扔给 C，它首先会在 Java 层把参数打包成一个连续字节块 `argBlock`。源码注释甚至明确说：在 Java 里做内存管理比在 C 里容易。`src/java.base/unix/classes/java/lang/ProcessImpl.java:196`

环境变量也一样，会先被打成 `envBlock`。而三个标准流则被翻译成一个 `std_fds` 整数数组：

- `-1` 表示这一路需要建管道；
- `0/1/2` 表示直接继承标准输入/输出/错误；
- 其他正整数则是已经打开好的文件描述符。`src/java.base/unix/classes/java/lang/ProcessImpl.java:223`

这一步非常关键，因为它说明 Java 侧不是“把原始对象交给 native 再慢慢拆”，而是在进入 native 之前先把自己整理成了**child protocol 能直接消费的扁平输入**。

### `ordinal() + 1` 不是小技巧，而是 Java/C 侧协议号

进构造函数时，Java 最终会调用：

```java
forkAndExec(launchMechanism.ordinal() + 1, ...)
```

`src/java.base/unix/classes/java/lang/ProcessImpl.java:340`

这里的 `ordinal() + 1` 特别值得讲清楚。它不是偷懒写法，而是在拿 Java 侧枚举顺序当 C 侧模式协议号。

因为 `LaunchMechanism` 的顺序就是：

- `FORK`
- `POSIX_SPAWN`
- `VFORK`。`src/java.base/unix/classes/java/lang/ProcessImpl.java:83`

而 C 侧 `MODE_FORK`、`MODE_POSIX_SPAWN`、`MODE_VFORK` 也必须和它一一对上。

这正说明 JDK 在进程启动最开始就已经进入“跨语言协议”模式：Java 侧不是只提供业务参数，连“接下来到底走哪种复制自己策略”都要编码成 native 能认的数值协定。

### 默认启动机制为什么是平台策略，而不是 API 常量

同一个 `ProcessBuilder.start()`，在 Linux 上默认是 `VFORK`，在 BSD/Solaris/AIX 上默认则是 `POSIX_SPAWN`。`src/java.base/unix/classes/java/lang/ProcessImpl.java:90`

这一步本身就说明进程 API 的底层实现不是“语言规范写死一种方式”，而是 JDK 根据平台权衡选默认策略。也就是说，**Java API 提供的是统一语义，native 层负责选最合适的实现姿势。**

## 复制自己：为什么要并存 `fork` / `vfork` / `posix_spawn`

真正进入 native 之后，最有信息量的不是某一行代码，而是 `ProcessImpl_md.c` 开头那段长注释。它几乎像一份策略备忘录，把几种“复制自己”的方式逐一分析了一遍。`src/java.base/unix/native/libjava/ProcessImpl_md.c:51`

### `fork`：稳，但会撞 overcommit 和大进程复制成本

`fork(2)` 的好处大家都知道：最传统、最可靠、最符合 Unix 直觉。

但源码直接提醒了它的老问题：大进程起小子进程时，会受到 overcommit 等机制影响，出现“明明只是想 exec 一个小命令，却要先复制一个巨大 VM 地址空间”的代价和假失败风险。`src/java.base/unix/native/libjava/ProcessImpl_md.c:54`

所以 `fork` 在 JDK 这里更像一条保底路径，而不是总默认。

### `vfork`：快，但共享地址空间，必须极度克制

`vfork` 的优势就在于：child 在 exec/_exit 前直接和 parent 共用地址空间，parent 会阻塞，省掉一大笔页表和地址空间复制成本。

但代价也非常尖锐：child 绝不能像普通 `fork` 那样随意返回、修改栈、碰全局状态。源码因此极度谨慎：

- 把 `vfork()` 单独拆到 `vforkChild()`；
- 尽量 `__attribute_noinline__`；
- 用 `volatile pid_t resultPid` 顶住编译器跨 `vfork` 的激进优化；
- 一旦返回 0 进入 child，就直接跳去 `childProcess(c)`，并断言它永不返回。`src/java.base/unix/native/libjava/ProcessImpl_md.c:342`

这非常值得翻成人话：**JDK 不是“喜欢 vfork 比 fork 快”，而是知道一旦选了 vfork，后续 child 路径就必须被设计成一条极窄、极保守、永不回头的通道。**

### `posix_spawn`：不是直接救场，而是要配 helper

`posix_spawn` 听起来像个更现代、更安全的替代品，但源码也把它的限制写得很明白：它自己做不到老 `fork/exec` 路径里“清干净所有继承 fd”这类需求，所以 JDK 只能让它先拉起一个 helper，再由 helper 去做真正的 child 改造与 exec。`src/java.base/unix/native/libjava/ProcessImpl_md.c:87`

这说明 `posix_spawn` 在 JDK 这里不是“更优雅的系统调用”，而是一条**要靠额外 helper 才补齐语义缺口**的策略。

所以本节最该记住的一句话是：**这三种方式并存，不是炫技，而是 JDK 在“成本、可靠性、语义完整性”之间做的平台化折中。**

## 子进程自我改造：为什么 child 不是一复制完就立刻 `exec`

复制自己之后，真正复杂的部分才开始：child 进程在 `exec` 前要把自己改造成 Java API 想要的样子。

这个施工现场都在 `childProcess()`。`src/java.base/unix/native/libjava/childproc.c:316`

### 为什么先关掉父进程那半边管道

`childProcess()` 一进来做的第一件事，就是显式关掉：

- `in[1]`
- `out[0]`
- `err[0]`
- `childenv` 两端
- `fail[0]`。`src/java.base/unix/native/libjava/childproc.c:329`

这一步不是多余洁癖，而是在建立“父子各持一半管道端点”的正确拓扑。只有把 parent 那边的副本尽早掐掉，后面 stdin/stdout/stderr 和失败信道的单向流动语义才不会被多余端点污染。

### `moveDescriptor`：`dup2 + close` 才是 Unix 进程重排 fd 的真身

child 的标准流重排核心其实非常朴素：`moveDescriptor(fd_from, fd_to)` 如果两个 fd 不同，就做一次 `dup2`，再把旧 fd 关掉。`src/java.base/unix/native/libjava/childproc.c:121`

这说明所谓“重排标准流”本质上并不神秘，就是把 Java 层预先描述好的 `std_fds` 协议，落实成 Unix 世界里的 `STDIN_FILENO` / `STDOUT_FILENO` / `STDERR_FILENO` 这三个槽位。

### `redirectErrorStream(true)` 为什么一定要在 child 里做

`redirectErrorStream(true)` 的效果不是给 Java 多一个布尔位，而是在 child 里把 `STDERR_FILENO` 直接 `dup2` 到 `STDOUT_FILENO`。`src/java.base/unix/native/libjava/childproc.c:348`

这一步特别能说明 Java API 和 Unix 语义的关系：Java 世界说的是“把错误流并到标准输出里”，而真正做到这件事的位置只能是 child 进程自己，因为只有它最清楚“接下来我要 exec 的进程看到的 1 号和 2 号 fd 应该长什么样”。

### 为什么还要有 `closeDescriptors()` 这一步

如果只重排 0、1、2 三个标准流，child 仍然可能带着 parent 进程里大量无关 fd 一起进入新程序。

这就是 `closeDescriptors()` 的职责。它会从 `FAIL_FILENO + 1` 往上，把 `/proc/self/fd` 里看到的其它打开 fd 逐个关掉；如果这条路径失败，还会退回按 `_SC_OPEN_MAX` 线性扫一遍的老办法。`src/java.base/unix/native/libjava/childproc.c:80`

这一步特别重要，因为它说明 child 在 exec 前不是“已经是目标程序”，而是一段**必须先把自己清场干净**的过渡状态。

### 为什么 `FAIL_FILENO` 一定要钉在 3

`childProcess()` 还会把失败信道那一端搬到固定的 `FAIL_FILENO`，然后对它设 `FD_CLOEXEC`。`src/java.base/unix/native/libjava/childproc.c:358`

这不是为了好看，而是为了后面的成功/失败协议能成立：

- fd 3 必须足够小，保证 `closeDescriptors()` 不把它一起扫掉；
- 它又必须带 `FD_CLOEXEC`，保证 exec 成功后它会自动关闭；
- parent 才能靠“读到 EOF”这件事推断 exec 成功。

所以这一步已经把下一节 fail pipe 协议的因果链提前写进 child 布局里了。

## 成败协议：为什么成功靠 EOF，失败回 errno

真正最有设计味道的地方，是 parent 怎么知道 child 的 `exec` 到底成了没有。

这件事不能靠“child 最后返回 0/1”来猜，因为失败可能发生在：

- `dup2`
- `closeDescriptors`
- `chdir`
- `exec` 本身

而这些步骤里很多都只在 child 进程自己内部发生。parent 无法预先判断“下一步会不会成功”，只能等 child 试完再告诉自己结果。

### `WhyCantJohnnyExec`：失败就把 errno 原样写回去

`childProcess()` 的结尾有一个经典的错误出口：`WhyCantJohnnyExec`。注释直接说：预测 child 会不会失败不可靠，真正需要的是一条把失败原因准确回传给 parent 的管道。`src/java.base/unix/native/libjava/childproc.c:382`

所以 child 的做法很简单：

- 如果哪一步失败，就把当前 `errno` 写进 fail pipe；
- 关掉 fail pipe；
- `_exit(-1)`。`src/java.base/unix/native/libjava/childproc.c:382`

重点不是退出码，而是 errno 已经沿专门控制通道回去了。

### 为什么成功反而“不说话”

那成功怎么表达？恰恰是什么都不写。

因为 child 侧的 fail fd 被设成了 `FD_CLOEXEC`。只要 `exec` 成功，那个 fd 就会在新程序替换地址空间时自动关闭。对于 parent 来说，读 fail pipe 时看到 EOF，就等于收到了“exec 成功”的无声信号。

这正是一个特别 Unix、也特别优雅的设计：**失败用数据说话，成功用描述符消失说话。**

### parent 为什么读完 errno 还要 `waitpid`

parent 在 `forkAndExec()` 里关闭自己的 `fail[1]` 后，会立即去读 `fail[0]`：

- 读到 0 字节（EOF）：`exec` 成功；
- 读到一个 `int errnum`：`exec` 失败，先 `waitpid` 回收僵尸，再带着真实 errno 抛 `IOException`。`src/java.base/unix/native/libjava/ProcessImpl_md.c:634`

这一步特别能说明 JDK 的进程协议不是“把子进程拉起来就完”，而是还要保证 Java 世界在失败时拿到尽可能准确、熟悉的错误语义——例如 `error=2, No such file or directory`。

### `posix_spawn` 为什么还要多一个 alive ping

`posix_spawn` 路径比 `fork/vfork` 多一道握手：child/helper 一起来先发一个 `CHILD_IS_ALIVE` ping，parent 先确认 helper 真活起来了，再继续等后续的 exec 成败结果。`src/java.base/unix/native/libjava/ProcessImpl_md.c:579`

这就是前面说的：`posix_spawn` 在 JDK 这里不是“少一层协议”，反而因为 helper 参与，必须再补一层协议才能把语义补齐。

所以本节最该记住的一句话是：**fail pipe 不是错误日志通道，而是 JDK 用来把 exec 成败变成可判定协议的一根生命线。**

## 观察与销毁：为什么 `ProcessHandle` 把 `(pid, startTime)` 当身份

讲完“怎么起一个进程”，再看另一个方向：怎么观察系统里已有的进程、怎么等它退出、怎么安全销毁它。

这里最容易被想简单的是：Unix 里进程不就是一个 pid 吗？拿 pid 去查、去等、去 kill 不就够了。

问题是，pid 会复用。

这意味着一个 `ProcessHandle` 持有的 `pid=1234`，今天可能是你刚起的子进程，明天也可能已经变成另一个毫不相干的新进程。如果 Java API 只拿裸 pid 当身份，那查询和 kill 都有机会打在错误对象上。

### `/proc` 遍历：为什么 `allProcesses()` 是 O(进程数)

`ProcessHandle.allProcesses()` 最终会落到 `unix_getChildren()`，它的办法非常朴素：`opendir("/proc")`，然后把目录项里长得像数字的名字逐个拿出来，再对每个候选 pid 调一次 `os_getParentPidAndTimings()`。`src/java.base/unix/native/libjava/ProcessHandleImpl_unix.c:508`

也就是说，JDK 这里并没有什么内核级“进程目录索引 API”，它就是在吃 `/proc` 提供的文件系统视图。

这解释了两点：

- `allProcesses()` 的成本天然是 O(进程数)；
- 它能工作，不是因为 JDK 会魔法，而是因为 Linux 已经把进程世界投影成了一个可遍历文件系统。

### `os_getParentPidAndTimings`：为什么要读 `/proc/<pid>/stat`

Linux 侧最关键的底层函数是 `os_getParentPidAndTimings()`。它会打开 `/proc/<pid>/stat`，小心跳过 `(comm)` 那段可能带空格甚至括号的名字，再用 `sscanf` 只抓自己真正需要的字段：

- `ppid`
- `utime`
- `stime`
- `starttime`。`src/java.base/linux/native/libjava/ProcessHandleImpl_linux.c:74`

然后它把：

- `utime + stime` 换成纳秒量级的 `totalTime`；
- `starttime` 结合 boot time 换成绝对的毫秒起始时间。`src/java.base/linux/native/libjava/ProcessHandleImpl_linux.c:127`

这一步最该记住的不是解析技巧，而是：**JDK 在有意把“pid + startTime”一起当成进程身份的底层材料。**

### reaper 线程：为什么 `waitFor()` 不直接自己 `waitpid`

Java 层 `ProcessHandleImpl` 里还有一层很有意思的结构：`completion(pid, shouldReap)` 会通过 `processReaperExecutor` 维护一组 “process reaper” 守护线程。它们会阻塞在 native `waitForProcessExit0(pid, shouldReap)` 上。`src/java.base/share/classes/java/lang/ProcessHandleImpl.java:84`

Unix 侧 `waitForProcessExit0` 则在：

- `shouldReap == true` 时用 `waitpid(pid, &status, 0)`；
- 否则用 `waitid(..., WNOWAIT)` 只观察退出，不立刻收尸。`src/java.base/unix/native/libjava/ProcessHandleImpl_unix.c:240`

这说明 Java 的 `waitFor()` / `onExit()` / `ProcessHandle` 退出完成机制，本质上不是“当前线程现场调用一次 `waitpid`”，而是**用可复用的 reaper 线程把进程退出状态转成 Java 世界里的 completion/future 协议。**

### `destroy0`：为什么 kill 前还要再验一次 `startTime`

`destroy0` 的关键逻辑非常短：

- 先根据 `force` 选 `SIGTERM` 或 `SIGKILL`；
- 再调一次 `isAlive0(pid)` 拿当前 startTime；
- 只有当当前 startTime 和持有时一致（或双方缺省为 0）时，才真正 `kill(pid, sig)`。`src/java.base/unix/native/libjava/ProcessHandleImpl_unix.c:312`

这一步就是整篇最后一个关键设计：**JDK 不把 pid 当身份，而把 `(pid, startTime)` 当身份。**

这样即使内核把 pid 复用了，只要启动时间变了，JDK 就宁可返回 `false` 不去 kill，也不冒险误杀另一个同 pid 新进程。

所以 destroy 这里最该记住的一句话是：**JDK 在 native 层宁可错过一次 kill，也不接受杀错进程。**

## 到这里为止，主线其实只发生了五件事

如果前面细节比较多，这里先把整件事压回五步：

1. Java 层先把命令、环境和重定向协议打包成 native 容易消费的扁平输入；
2. native 层再按平台策略选择 `fork` / `vfork` / `posix_spawn` 的复制方式；
3. child 在 `exec` 前必须先把自己的 fd、目录和继承状态改造成目标形状；
4. parent 靠 fail pipe + `FD_CLOEXEC` 精确知道 exec 成败，而不是靠猜；
5. 查询、等待和销毁则统一把 `(pid, startTime)` 当成进程身份，顶住 pid 复用。

只要这五步还在脑子里，`Runtime.exec()` 就不会再看起来像“Java 帮你包了一层 `fork()`”。

## 常见误解澄清

### 误解一：`Runtime.exec` 就是一层 `execvp` 薄封装

不是。

中间至少还隔着参数/环境打包、复制策略选择、child 改造、fail pipe 成败协议和 Java 流包装这些步骤。`execvp` 只是其中很靠后的一步。

### 误解二：`posix_spawn` 天然总优于 `fork/vfork`

不对。

在 JDK 这里它反而因为 fd 清理能力不足，需要 helper 和额外握手协议来补语义。是否默认使用，是平台折中的结果，不是绝对优越关系。`src/java.base/unix/native/libjava/ProcessImpl_md.c:87`

### 误解三：fail pipe 只是一个错误日志通道

不是。

它真正承载的是 exec 成败协议：失败回 errno，成功靠 CLOEXEC 后的 EOF。没有它，parent 很难精确知道 child 在 exec 前哪一步失败。`src/java.base/unix/native/libjava/childproc.c:382`

### 误解四：`ProcessHandle.allProcesses()` 是低成本常量时间操作

不是。

Linux 路径本质上是遍历 `/proc` 目录，再对每个候选 pid 读一次 stat，所以成本天然和系统进程数正相关。`src/java.base/unix/native/libjava/ProcessHandleImpl_unix.c:508`、`src/java.base/linux/native/libjava/ProcessHandleImpl_linux.c:74`

### 误解五：destroy 只靠 pid 就足够安全

不够。

pid 会复用，所以 JDK 一直拿 `(pid, startTime)` 做身份校验；只要发现当前这个 pid 已经不是原来那个进程，就拒绝 kill。`src/java.base/unix/native/libjava/ProcessHandleImpl_unix.c:312`

## 收网：JDK 的进程面，本质上是在补 Java 和 Unix 之间的协议缺口

现在再回头看最开头那个问题，答案已经能收成一张总图了。

```text
启动子进程
  Java ProcessBuilder.start()
    └─ ProcessImpl.start
         ├─ 打包 argBlock / envBlock / std_fds
         └─ forkAndExec(mode, ...)
              ├─ 选 fork / vfork / posix_spawn
              ├─ childProcess: 重排 fd / chdir / 清理继承 fd
              ├─ JDK_execvpe: 按父进程 PATH 查找并 exec
              └─ fail pipe: 失败回 errno，成功靠 EOF

观察/等待/销毁
  ProcessHandle / ProcessImpl
    ├─ /proc 扫描拿 ppid / time / cmdline / user
    ├─ reaper 线程 waitpid
    └─ destroy0(pid, startTime): 先验 startTime 再 kill
```

把它再压成三句话：

- JDK 的进程启动不是调用一个系统调用，而是把 Java 的命令、环境和重定向语义翻译成 child 进程可执行的 Unix 协议。
- fail pipe、`FD_CLOEXEC`、reaper 线程这些看似额外的结构，都是在补“Unix 原生接口没有直接给 Java 的那部分语义保证”。
- 到查询和销毁阶段，JDK 又进一步把“进程身份”从裸 pid 提升成 `(pid, startTime)`，避免把错误操作打到 pid 复用后的陌生进程上。

所以 `Runtime.exec()` 真正复杂的地方，不是“会不会调 `fork`”。

真正复杂的是：**Java 想要的是一份稳定、可组合、可等待、可查询、可安全销毁的进程抽象；Unix 给你的却只是几把锋利但松散的原语。JDK native 层做的，就是把这些原语重新编排成 Java 世界可接受的协议。**

下一篇就顺着这套协议继续往外扩。进程已经能起、能等、能杀，但 Java 世界还要和更多外部输入打交道：类加载、I/O 文件描述符、时区文件等等。它们会再次复用这层 native 骨架，只是对象和数据流又换了一批。

> → [03 — ClassLoader + I/O + TimeZone](03-class-io.md)
