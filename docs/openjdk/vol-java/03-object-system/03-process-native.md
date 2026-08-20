# ProcessBuilder 与本地进程：一行 `start()` 如何变成一次进程通信

> 本文基于 JDK 11 `java.base`。进程创建和标准流部分以 Unix/Linux 平台实现 `java.base/unix/classes/java/lang/ProcessImpl.java` 为主；信号部分以 Unix/Linux 的 `Terminator` 为主。`ProcessBuilder` 的参数列表语义属于 Java API，`ProcessImpl` 的 `fork`、`vfork`、`posix_spawn` 选择和文件描述符细节属于 JDK 11 当前平台实现，不能外推为所有操作系统的统一路径。本文讨论的是 JDK 11 Unix/Linux 进程创建与通信边界，不把这里的启动机制枚举、管道容量和信号处理策略外推成所有平台或所有 JVM 进程管理的统一规范。
> **前置依赖**：[System 与 Runtime 门面](02-system-runtime.md)
> **后续**：域 07 类加载器

## 先看一个“进程没死，但业务卡死”的现场

服务需要调用外部命令生成文件。代码大致是：

```java
// 用法示意(API 形式,非源码片段)
Process process = new ProcessBuilder("converter", input, output).start();
int code = process.waitFor();
```

命令本身没报错，子进程也确实启动了，父进程却一直等不到 `waitFor()` 返回。线程 dump 看起来像是在等待，子进程则卡在写标准输出或标准错误。

另一个版本的故障更隐蔽：父进程只读取 stdout，却没有读取 stderr。外部程序把诊断信息持续写到 stderr 后，某一条管道先达到容量上限，子进程的写操作阻塞；父进程又在等待子进程退出，两个进程互相等着对方推进。

这不是 `waitFor()` 本身失效，而是调用者把两个必须同时推进的角色混成了一件事：

```text
父进程
  ├── 给子进程写 stdin
  ├── 读取子进程 stdout/stderr
  └── 等待子进程退出
          │
          ▼
      操作系统子进程
          ├── 从 fd 0 读输入
          ├── 向 fd 1 写输出
          └── 向 fd 2 写错误
```

`Process` 不是一个被 Java 线程包起来的“远程方法调用”。它代表操作系统中的另一个进程；Java 侧通过文件描述符和管道与它通信，通过进程句柄感知它结束。整篇文章只围绕这条链展开：

```text
启动描述
   → 参数、环境、目录、重定向
   → Unix 平台实现
   → native 创建子进程
   → 父子进程之间的三条标准流
   → 退出完成回调
   → waitFor 返回退出码
```

先记住开头的故障：**等待退出不能替代消费输出；进程生命周期和 I/O 生命周期必须同时管理。**

## 一、`ProcessBuilder` 不是 Shell，而是一份启动描述

### 先排除“把整条命令交给 Java”的直觉

很多人第一次使用进程 API 时，会把命令写成一整条字符串，然后期待 Java 像交互式终端一样帮忙拆分参数、展开重定向、解释管道符：

```java
// 用法示意(API 形式,非源码片段)
new ProcessBuilder("converter --input a.txt --output b.txt");
```

但 `ProcessBuilder` 的核心模型是命令元素列表，而不是 Shell 命令行。程序名、参数、空格、引号和重定向分别属于不同层次。若确实需要 Shell 语义，应显式启动 Shell，并把 Shell 当成真正的子进程；否则就直接把每个参数作为列表元素传入。

把所有内容拼成字符串的问题，不只是“空格处理麻烦”。它会把参数边界、转义规则和解释器选择混在一起：文件名里出现空格时，调用者不再清楚哪个字符是数据、哪个字符会被解释；同一段字符串在不同 Shell 和操作系统下也不一定有相同含义。列表模型虽然朴素，却把参数边界保留下来。

### `start()` 先保护启动描述，再交给平台

调用者真正触发的是 `ProcessBuilder.start()`。它先进入私有的 `start(Redirect[])`，把可变的命令集合转换成数组并复制一份，然后检查空参数、程序名、安全权限和 NUL 字符，最后才调用平台实现。

带着“为什么不能直接跳到 native”的问题看源码中的委托点：

```java
// ProcessBuilder.java:1106-1111
try {
    return ProcessImpl.start(cmdarray,
                             environment,
                             dir,
                             redirects,
                             redirectErrorStream);
```

这几步验证的是启动描述，而不是子进程已经成功运行。JDK 11 的实现先把命令列表转成数组，是为了避免用户提供的可变列表在安全检查和真正启动之间改变内容；程序名为空会在取首元素时失败；启用 `SecurityManager` 时会检查执行权限；任何参数含 NUL 都会抛出 `IOException`。

```java
// ProcessBuilder.java:1082-1096
String[] cmdarray = command.toArray(new String[command.size()]);
cmdarray = cmdarray.clone();

for (String arg : cmdarray)
    if (arg == null)
        throw new NullPointerException();
String prog = cmdarray[0];

SecurityManager security = System.getSecurityManager();
if (security != null)
    security.checkExec(prog);
```

NUL 检查不是普通的格式洁癖。Unix 的底层参数表示以 NUL 结束，Java 如果允许参数内部携带 NUL，Java 层看到的字符串和 native 层实际看到的参数就可能不是同一个东西。JDK 11 在进入平台实现之前拒绝它：

```java
// ProcessBuilder.java:1100-1107
for (String s : cmdarray) {
    if (s.indexOf('\u0000') >= 0) {
        throw new IOException("invalid null character in command");
    }
}

try {
    return ProcessImpl.start(cmdarray,
```

这里的设计取舍很明确：`ProcessBuilder` 负责保持“我要启动什么”的描述稳定、合法；平台实现负责回答“在当前操作系统上怎样启动”。如果让 Java 层自己拼接 Shell 字符串并猜测平台行为，边界会更模糊，而不是更简单。

**这一节的路标：`ProcessBuilder` 不是执行器，也不是 Shell。它先把命令、环境、工作目录和重定向整理成一份稳定的启动描述，再把描述交给平台实现。**

## 二、三条标准流：重定向配置为什么先变成 `std_fds`

### 父进程和子进程各自拿哪一端

子进程出生时天然认识三个标准文件描述符：0 是 stdin，1 是 stdout，2 是 stderr。Java API 让调用者用 `Redirect.PIPE`、`Redirect.INHERIT` 或文件重定向描述它们，但 native 层不需要理解这些 Java 对象，它需要的是文件描述符和特殊标记。

先把角色固定下来：

```text
stdin ：父进程写端 ─────→ 子进程 fd 0
stdout：子进程 fd 1 ────→ 父进程读端
stderr：子进程 fd 2 ────→ 父进程读端
```

因此 `process.getOutputStream()` 这个名字容易让人误会：它是父进程向子进程 stdin 写数据的输出流；`process.getInputStream()` 则是父进程读取子进程 stdout 的输入流；`getErrorStream()` 是另一条独立的 stderr 输入流。

### Java 侧先编码参数和环境

Unix 的 `ProcessImpl.start` 先把参数整理成连续字节块，再把环境变量编码成环境块。源码注释给出了一个很朴素但重要的取舍：在 Java 中管理这些内存，比把大量零散参数交给 C 侧再管理更容易。

```java
// ProcessImpl.java:196-213
byte[][] args = new byte[cmdarray.length-1][];
int size = args.length;
for (int i = 0; i < args.length; i++) {
    args[i] = cmdarray[i+1].getBytes();
    size += args[i].length;
}
byte[] argBlock = new byte[size];
int i = 0;
for (byte[] arg : args) {
    System.arraycopy(arg, 0, argBlock, i, arg.length);
    i += arg.length + 1;
}

int[] envc = new int[1];
byte[] envBlock = ProcessEnvironment.toEnvironmentBlock(environment, envc);
```

这里没有把参数拼成 Shell 字符串。每个参数依然是一个独立的元素，只是为了跨过 Java/native 边界，被编码成 native 能消费的连续结构。数据结构变了，参数语义没有变。

### `-1` 不是文件描述符，而是一个待创建管道的信号

真正有解释责任的是 `std_fds`。JDK 11 Unix 实现使用三个整数表示 stdin、stdout、stderr 的重定向结果：`Redirect.PIPE` 对应 `-1`，`Redirect.INHERIT` 对应父进程的 0、1、2，文件重定向则先打开文件并取出它的 fd。

以 stdin 为例：

```java
// ProcessImpl.java:223-237
if (redirects == null) {
    std_fds = new int[] { -1, -1, -1 };
} else {
    std_fds = new int[3];

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

stdout 和 stderr 使用同一组角色，只是继承的默认 fd 分别是 1 和 2。`Redirect.PIPE` 的 `-1` 表示“这里需要父子进程之间的管道”，不是“把 -1 传给子进程当作有效 fd”。`forkAndExec` 的文档进一步说明：对输入而言，`-1` 表示创建连接父子进程的管道；对输出而言，另一个方向会带回父进程管道 fd。

```text
Java Redirect
   ├── PIPE      → -1 → native 建立父子管道
   ├── INHERIT   → 0/1/2 → 使用父进程标准 fd
   ├── 文件       → 打开文件 → 传入文件 fd
   └── RedirectPipeImpl → 复用已有 fd
```

这套转换解决了一个失败方案：如果 Java 层分别创建三条管道，再独立调用创建进程、配置标准 fd、关闭多余 fd，任何一步失败都需要自己回滚已经创建的资源。现在 Java 层只把最终意图集中进 `std_fds`，平台实现把它和 native 创建过程放在同一条启动链里管理。

当然，这并不代表调用者不再有资源责任。父进程仍然需要关闭不用的流，持续消费需要保留的 stdout/stderr，并在向 stdin 写完后适时关闭写端，让子进程看到 EOF。

**到这里为止，启动描述已经变成三类 native 输入：`argBlock`、`envBlock` 和 `std_fds`。下一步不再是 Java API 的组合，而是跨过操作系统的进程创建边界。**

## 三、`forkAndExec`：Java 如何把启动描述交给操作系统

### 不是所有 Unix 都走同一条路径

旧式讲法容易把“Java 启动子进程”简化成固定的 `fork()` 后 `execve()`。这能帮助初学者建立 POSIX 直觉，却不能直接当作 JDK 11 Unix 实现的完整事实。

JDK 11 `ProcessImpl` 的注释列出三种机制：

```text
1 - fork(2) and exec(2)
2 - posix_spawn(3P)
3 - vfork(2) and exec(2)
```

平台枚举还规定了可选机制。Linux 的默认值是 `VFORK`，可选 `POSIX_SPAWN` 和 `FORK`；BSD、Solaris 和 AIX 的默认值与可选集合不同。系统属性 `jdk.lang.Process.launchMechanism` 可以参与选择，但候选必须是当前平台支持的机制。

```java
// ProcessImpl.java:83-106
private static enum LaunchMechanism {
    FORK,
    POSIX_SPAWN,
    VFORK
}

private static enum Platform {
    LINUX(LaunchMechanism.VFORK, LaunchMechanism.POSIX_SPAWN, LaunchMechanism.FORK),
    BSD(LaunchMechanism.POSIX_SPAWN, LaunchMechanism.FORK),
    SOLARIS(LaunchMechanism.POSIX_SPAWN, LaunchMechanism.FORK),
    AIX(LaunchMechanism.POSIX_SPAWN, LaunchMechanism.FORK);
```

所以文章应当说“JDK 11 Unix 实现提供这些启动模式，并按平台选择”，而不能说“ProcessBuilder 一定调用 fork”。Java API 要求的是创建一个新进程，具体采用哪种 native 机制是实现和平台的职责。

### POSIX 语义仍然值得理解

即使实际模式不是固定的 `fork`，经典的两步语义依然有助于理解边界：创建或准备出子进程后，子进程需要把工作目录、标准 fd、环境和程序映像准备好；`exec` 则用目标程序替换当前进程映像。替换之后，子进程仍然保留已经准备好的标准流关系，因此外部命令可以把输出写回父进程的管道。

JDK 11 把这一组平台动作收进一个 native 方法：

```java
// ProcessImpl.java:322-329
private native int forkAndExec(int mode, byte[] helperpath,
                               byte[] prog,
                               byte[] argBlock, int argc,
                               byte[] envBlock, int envc,
                               byte[] dir,
                               int[] fds,
                               boolean redirectErrorStream)
    throws IOException;
```

方法返回的是子进程 pid。它的参数同时携带程序、参数块、环境块、工作目录、三条标准流的 fd 描述和 stderr 合并选项。Java 层不用把每个平台的系统调用拼成一套公共流程，只需要把统一的启动描述交给当前 `ProcessImpl`。

### native 返回后，父进程才拥有 Java 侧的进程对象

构造器先调用 `forkAndExec`，拿到 pid 后创建内部进程句柄，再依据 fd 初始化 Java 流：

```java
// ProcessImpl.java:340-357
pid = forkAndExec(launchMechanism.ordinal() + 1,
                  helperpath,
                  prog,
                  argBlock, argc,
                  envBlock, envc,
                  dir,
                  fds,
                  redirectErrorStream);
processHandle = ProcessHandleImpl.getInternal(pid);

try {
    doPrivileged((PrivilegedExceptionAction<Void>) () -> {
        initStreams(fds, forceNullOutputStream);
        return null;
    });
```

这段时序很重要：先有 native 进程和 pid，再有 Java 的 `ProcessImpl` 流与 `ProcessHandle`。`Process` 不是先创建一个 Java 对象、再让它“变成”操作系统进程；Java 对象是对已经建立的 OS 进程关系的包装。

Linux/BSD 分支的 `initStreams` 会把父进程侧 fd 包装成 `ProcessPipeOutputStream` 或 `ProcessPipeInputStream`。如果某个方向不是管道，就使用空流或相应的继承/重定向关系。至此，Java 侧拿到的三个流才真正连上子进程的 fd 0、1、2。

## 四、为什么“不读输出”会让 `waitFor()` 看起来失效

### 两条独立的等待链

父进程等待子进程时，同时存在两条链：

```text
I/O 链：子进程 write → 管道缓冲区 → 父进程 read
退出链：子进程结束 → ProcessHandle completion → hasExited → waitFor 返回
```

退出链不负责替 I/O 链排水。子进程在退出前可能持续写 stdout/stderr；当某一条管道的有限缓冲区被填满后，子进程的写操作会阻塞。子进程没有结束，退出完成回调就没有机会把 `hasExited` 设为 true；父进程如果又只是在 `waitFor()` 中等待，就形成了闭环。

这就是为什么下面这种顺序不应当当作通用模板：

```java
// 用法示意(API 形式,非源码片段)
int code = process.waitFor();
String output = new String(process.getInputStream().readAllBytes());
```

如果子进程输出足够多，第二行永远没有机会执行。更可靠的方案是启动并行消费者读取 stdout 和 stderr，或者在启动阶段把输出重定向到文件；如果业务允许，也可以使用 `redirectErrorStream(true)` 把 stderr 合并进 stdout，减少需要同时消费的管道数量。

这里还有一个常见误会：把 stdout 和 stderr 放进同一个 Java 线程，轮流读一小段，并不能自动消除风险。两条流都可能独立增长，消费者必须保证不会长期忽略其中一条。对于大输出、长时间运行和双向交互命令，应把 I/O 生命周期单独设计，而不是把它当成 `waitFor()` 的附属步骤。

### `waitFor()` 等待的是状态变化，不是轮询系统调用

JDK 11 Unix 实现的 `waitFor()` 很短，但短并不等于没有机制：

```java
// ProcessImpl.java:493-498
public synchronized int waitFor() throws InterruptedException {
    while (!hasExited) {
        wait();
    }
    return exitcode;
}
```

调用线程进入对象监视器等待，真正的问题变成：谁设置 `hasExited`，谁负责唤醒它？答案在 `initStreams` 注册的进程完成回调：

```java
// ProcessImpl.java:389-405
ProcessHandleImpl.completion(pid, true).handle((exitcode, throwable) -> {
    synchronized (this) {
        this.exitcode = (exitcode == null) ? -1 : exitcode.intValue();
        this.hasExited = true;
        this.notifyAll();
    }

    if (stdout instanceof ProcessPipeInputStream)
        ((ProcessPipeInputStream) stdout).processExited();
```

回调把退出码写入对象状态，设置 `hasExited`，再 `notifyAll()`。同时，它会通知 stdout、stderr 和 stdin 对应的管道流进程已经退出，让流侧结束自己的收尾动作。`waitFor()` 只等待这个状态变化，不需要每个 Java 等待线程都自行轮询子进程。

带超时的 `waitFor` 还使用 `System.nanoTime()` 计算剩余时间，这正好呼应上一篇关于单调时钟的结论：等待时长不能依赖会被校时影响的墙上时间。

最直觉的失败方案是每个调用线程定时检查一次子进程状态。它看似容易写，却会带来轮询线程、检查间隔和退出延迟；JDK 把进程观察集中到 `ProcessHandle` 完成机制，再通过条件等待通知 Java 调用者。这里不是说所有 native 平台都用同一个内核函数，而是说 Java 层采用了“完成事件更新状态，等待者被通知”的结构。

**这一节收回开头的事故：`waitFor()` 没有失效，它只负责等退出状态；真正让进程无法退出的可能是另一条 I/O 链没有被消费。**

## 五、VM/native 初始化：为什么这条 API 能碰到进程边界

`ProcessBuilder` 已经把命令交给了 native，但 Java 进程自身也不是凭空获得这些能力的。`System` 的 native 方法需要先注册，VM 注入的属性需要进入 Java 侧的初始化结构，平台相关的终止处理也要在系统初始化阶段建立。

这里不把启动过程夸大成一条可以仅凭几个 Java 静态块证明的全局时序，只抓住和本文相关的边界。

### `System` 先注册 native 入口

JDK 11 的 `System` 类在静态初始化块中调用 `registerNatives()`：

```java
// System.java:101-104
private static native void registerNatives();
static {
    registerNatives();
}
```

这一步让 Java 声明的 native 方法具备 JVM 侧的绑定入口，例如上一篇看到的时间、数组复制等方法。它说明 Java API 的“稳定门面”并不等于实现也在 Java 文件里；有些能力从声明开始就准备跨到 VM 或操作系统。

### 属性初始化把启动参数交给 Java 库

`System.initPhase1()` 会创建 `props`，调用 `initProperties(props)` 接收 VM 初始化的属性，再调用 `VM.saveAndRemoveProperties(props)` 建立内部快照。这条链在上一篇已经展开，这里只保留一个用途：`ProcessImpl` 会根据平台、`os.name` 和 `jdk.lang.Process.launchMechanism` 决定平台与启动机制，进程启动并不是完全脱离 JVM 启动状态的独立黑盒。

这也是版本边界：`ProcessImpl` 的平台枚举、属性名和 helper 路径是 JDK 11 当前实现，不是 `ProcessBuilder` API 对所有 JDK 的永久承诺。

## 六、信号：`SIGTERM` 给 JVM 一个退出机会，`SIGKILL` 不给

### Unix 终止通知如何接入 Shutdown

JDK 11 Unix 的 `Terminator.setup()` 注册 `HUP`、`INT` 和 `TERM`。处理器收到信号后调用 `Shutdown.exit`，因此外部终止请求可以复用上一篇讲过的 shutdown hook 流程：

```java
// Terminator.java:47-53
static void setup() {
    if (handler != null) return;
    Signal.Handler sh = new Signal.Handler() {
        public void handle(Signal sig) {
            Shutdown.exit(sig.getNumber() + 0200);
        }
    };
    handler = sh;
```

注册的具体实现经过 `Signal.handle` 和 native `handle0`；收到信号后，JDK 的 dispatch 机制在 Java 线程中调用 handler。这个路径是 Unix/Linux 当前实现，不应写成 Windows 或所有 JVM 的统一行为。

`SIGTERM` 可以被处理，所以 JVM 有机会进入 shutdown；但“进入 shutdown”不等于“保证 hook 最终完成”。hook 可能阻塞，外部编排系统可能在宽限期结束后发送强制信号，进程也可能先崩溃。

### `SIGKILL` 为什么没有清理机会

`SIGKILL` 是操作系统强制终止语义，进程不能捕获、阻塞或忽略它。内核直接结束进程，不会等待 Java hook、不保证缓冲区刷新，也不会给 `Shutdown.exit` 留出执行机会。因此“先 SIGTERM，超时再 SIGKILL”不是两个等价的停止按钮，而是先协商清理、再放弃清理保证。

还必须注意 JDK 11 `Terminator` 的注释：使用 `-Xrs` 时，用户要自行通过 `System.exit()` 确保 shutdown hook 被执行。应用不能只根据“收到了终止信号”就推断 hook 一定运行，更不能把 Kubernetes 或其他编排系统的具体宽限秒数写成 JVM 规则。

```text
SIGTERM / SIGINT
   → Unix Terminator
   → Shutdown.exit
   → hooks / 清理
   → halt

SIGKILL
   → 内核直接终止
   → 不进入 Java shutdown 路径
```

**这一层只需要记住：信号是进程外部发来的请求，Shutdown 是 JVM 内部的清理状态机；只有前者给了后者运行机会，清理才可能发生。**

## 七、五个最容易混掉的边界：ProcessBuilder 不是 Shell，waitFor 不是排水器，Process 不是 Java 线程，-1 不是有效 fd，SIGTERM 也不是一定能跑完清理

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`ProcessBuilder` 不是 Shell。它接收的是命令元素列表，不是一整条待解析的命令字符串；参数边界、重定向和转义语义不会由 Java 自动跨 Shell 完成。真需要 Shell 语法时，应该显式启动 Shell 并把它当成一个真正的子进程。

第二，`waitFor()` 也不是输出排水器。它只等待子进程退出，不会帮你消费 stdout/stderr。两条标准流都有有限容量，写满后子进程写操作会阻塞；所以大输出场景必须先并行消费或显式重定向，而不是“先 waitFor、之后再读”。

第三，`Process` 更不是被 Java 线程包起来的远程调用。它代表操作系统里的另一个进程，Java 侧靠文件描述符和管道与它通信，靠进程句柄感知退出。把它当成线程去理解，就看不到管道容量和 I/O 生命周期的约束。

第四，`-1` 也不是会被传给孩子当有效 fd 的数字。`std_fds` 里的 `-1` 是“这里需要父子之间的管道”的信号，native 层为其创建管道后才填入真实 fd。

第五，`SIGTERM` 也不是一定能跑完 shutdown hook 的保证。它可以被捕获并进入 shutdown 流程，但 hook 可能阻塞，编排系统可能超时后补发 `SIGKILL`，进程也可能先崩溃。`SIGKILL` 才是内核直接终止、不给任何 Java 清理机会的强制路径。

把这五条边界记稳，`ProcessBuilder` 这一篇就不会重新塌回“几行启动命令”的表面印象。它真正想讲的是：一次 `start()` 跨越了启动描述、平台实现、native 创建、管道通信和退出通知五条链，任何一条没有同步推进，业务就可能卡死。

## 收网：启动、通信、等待、终止是四条不同的责任链

现在重新看最开始的两行代码：

```java
// 用法示意(API 形式,非源码片段)
Process process = new ProcessBuilder("converter", input, output).start();
int code = process.waitFor();
```

第一行不是执行字符串，而是完成一条分层转换：

```text
参数列表 / 环境 / 目录 / Redirect
        ↓
ProcessBuilder 校验启动描述
        ↓
Unix ProcessImpl 编码 argBlock、envBlock、std_fds
        ↓
forkAndExec(mode)
   ├── 子进程：准备标准 fd，执行目标程序
   └── 父进程：获得 pid 与管道 fd
        ↓
Java Process streams + ProcessHandle
```

第二行也不是“把输出读完再返回”。它只等待退出完成事件：

```text
子进程写 stdout/stderr ──→ 父进程持续消费
子进程结束 ───────────────→ completion 设置 hasExited
                              └→ notifyAll → waitFor 返回退出码
```

因此生产代码要遵循四条规则：

1. 用参数列表表达程序和参数；需要 Shell 时显式启动 Shell，不把解释器语义藏进字符串。
2. 把 stdout、stderr 和 stdin 当作独立的资源链管理；大输出时必须持续消费或显式重定向。
3. 把 `waitFor()` 理解成退出状态等待，不把它当作 I/O 排水器；超时等待使用单调时间语义。
4. 把 `SIGTERM`/`System.exit` 看作有机会清理的路径，把 `SIGKILL`/`halt` 看作可能跳过清理的强制路径。

`ProcessBuilder` 的设计价值，不是把系统调用藏起来让人永远不用理解，而是把跨平台的启动描述、平台相关的文件描述符和 native 进程创建分层组织起来。理解这条边界后，下一步再看类加载器时，读者已经知道：类加载不是脱离进程的魔法，它也要依赖 VM 初始化完成的状态、模块路径和底层文件系统。

> → 下一篇：域 07 类加载器（ClassLoader、类路径与模块系统）
