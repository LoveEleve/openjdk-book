# 02. 进程管理 — Runtime.exec 的 fork+exec 与进程查询

> **前置依赖**:[42-core-native/01 — JNI 工具层与系统属性](openjdk/vol-02/42-core-native/01-jni-system.md):libjava 的异常管道与编码分派是本章所有 native 方法的地基
> → **后续**:[03 — ClassLoader + I/O + TimeZone](03-class-io.md)
> 关联域: 01-os(信号/系统调用基础)、07-classfile-classloader(类加载是另一个"外部输入"通道)

## 一次 exec 的完整旅程

`Runtime.getRuntime().exec("ls -la")` 只有一行代码,但内核里发生的事需要一本书的一半章节: 字符串先被打包成 C 数组,然后**复制当前进程**(fork/vfork),在副本里重排标准输入输出、关闭所有多余的文件描述符、切换工作目录,最后用新程序把自己替换掉(exec)——期间任何一步失败,父进程都必须知道失败的原因。而 `ProcessHandle.allProcesses()` 则是另一个方向的问题: 不创建进程,而是**反过来观察系统里已有的所有进程**。这一篇拆 libjava 的进程面: 启动(forkAndExec)、子进程改造(childProcess)、成败协议(fail pipe)、以及查询/终止(ProcessHandle)。

## 1. 启动: 参数打包与"复制自己"的四种姿势

### Java 侧: 把一切压成 C 数组

`ProcessBuilder.start()`(ProcessBuilder.java:1070-1072)转调 `ProcessImpl.start`(unix/classes/java/lang/ProcessImpl.java:187 起)。Java 层把命令参数压进一个连续字节块 `argBlock`(:198-210,注释 "it's easier to do memory management in Java than in C"),环境变量压成 `envBlock`,重定向翻译成三个整数的 `std_fds`(:223-265): `-1` 表示"给我建管道"(Redirect.PIPE),`0/1/2` 表示子进程直接沿用父进程的标准 fd(Redirect.INHERIT),否则是已打开文件的 fd。然后构造函数把模式、程序路径、这些块一次传给 native(ProcessImpl.java:340-347):

```cpp
// ProcessImpl.java:340-347(截取核心,逐字)
        pid = forkAndExec(launchMechanism.ordinal() + 1,
                          helperpath,
                          prog,
                          argBlock, argc,
                          envBlock, envc,
                          dir,
                          fds,
                          redirectErrorStream);
```

注意第一个参数: `launchMechanism.ordinal() + 1`——**用枚举序号当协议号**。`LaunchMechanism` 枚举(ProcessImpl.java:83-88,注释 "order IS important!")顺序是 FORK/POSIX_SPAWN/VFORK,对应 childproc.h:85-88 的宏 `MODE_FORK 1 / MODE_POSIX_SPAWN 2 / MODE_VFORK 3`——两个文件必须同步,注释 "These numbers must be the same as the Enum in ProcessImpl.java"。默认机制按平台选(ProcessImpl.java:90-98): **Linux 默认 VFORK,BSD/Solaris/AIX 默认 POSIX_SPAWN**;还能用系统属性 `jdk.lang.Process.launchMechanism` 覆写(:130-156)。

### native 侧: 四种策略的取舍

`forkAndExec`(ProcessImpl_md.c:499 起)开头是一段罕见的"策略备忘录"(ProcessImpl_md.c:51-99),把四种复制自己的方式逐一分析:

- **fork(2)**: 最稳,但有大进程起小命令时 overcommit 假失败的老问题(:54-58);
- **vfork(2)**: 可怕但被 XPG4 标准化,glibc 的 posix_spawn 自己也优先用 vfork——注释顺带给出 JDK 不用 posix_spawn 的直接理由(:68-70,注释原文 "we cannot use posix_spawn ourselves because there's no reliable way to close all inherited file descriptors");
- **clone(CLONE_VM)**: 曾在 32 位 i386 上触发 glibc 的 `pthread_getattr_np` ESRCH bug,被弃用(:73-86);
- **posix_spawn**: 由内核/glibc 干 fork+exec 的活,但需要额外起一个 helper 程序"jprochelper"来补上清理 fd 这一步(:87-95)。

结论写死在文件里(ProcessImpl_md.c:97-98): "we are currently using vfork() on Linux and posix_spawn() on other Unix systems"。vfork 的实现被单独拆成一个函数、加 `__attribute_noinline__`(ProcessImpl_md.c:346-348,注释 :343-344 "We are unusually paranoid; use of vfork is especially likely to tickle gcc/glibc bugs"),还专门写了防止编译器跨 vfork 乱优化局部变量的 `volatile`(截取核心,逐字):

```cpp
// ProcessImpl_md.c:352-369(截取核心,逐字)
static pid_t
vforkChild(ChildStuff *c) {
    volatile pid_t resultPid;

    /*
     * We separate the call to vfork into a separate function to make
     * very sure to keep stack of child from corrupting stack of parent,
     * as suggested by the scary gcc warning:
     *  warning: variable 'foo' might be clobbered by 'longjmp' or 'vfork'
     */
    resultPid = vfork();

    if (resultPid == 0) {
        childProcess(c);
    }
    assert(resultPid != 0);  /* childProcess never returns */
    return resultPid;
}
```

vfork 与 fork 的差别在文章里被反复强调: **fork 复制页表(COW 按页共享),vfork 完全不复制、父进程阻塞到子进程 exec/_exit**。代价是共享栈与地址空间: 子进程不能从 vfork 返回(会把两个进程的栈一起毁掉)、不能修改非 volatile 的状态——这解释了为什么 `childProcess` 被设计成"永不返回"(assert 注释 :367)、为什么拆成独立函数加 noinline 防编译器跨 vfork 乱优化,而 `volatile resultPid` 正是为了让 gcc 不把跨 vfork 的变量优化进寄存器。

**关键设计 (斜体)**: *"复制自己"的三种方式并存,不是炫技: fork 是底线,posix_spawn 是安全但无法清理 fd 的替代,而 Linux 上选 vfork 是"最快+可清理"的折中。`ordinal()+1` 的协议号让 Java 侧枚举与 C 侧宏天然同步,任何一边改了枚举顺序都会立刻错位——用注释互相锁死。*

### 管道: 数据通道与"失败信道"

fork 之前先建管道(ProcessImpl_md.c:558-565): 只有 Java 侧传 `-1` 的那一路才建(文件重定向直接复用 fd):

```cpp
// ProcessImpl_md.c:558-565(截取核心,逐字)
    if ((fds[0] == -1 && pipe(in)  < 0) ||
        (fds[1] == -1 && pipe(out) < 0) ||
        (fds[2] == -1 && pipe(err) < 0) ||
        (pipe(childenv) < 0) ||
        (pipe(fail) < 0)) {
        throwIOException(env, errno, "Bad file descriptor");
        goto Catch;
    }
```

五对管道里(Java 侧给了现成 fd 时对应的数据管道不建),in/out/err 是数据通道(其中 childenv 只在 posix_spawn 模式下给 helper 传 ChildStuff);**fail 是控制通道**——它的用途下一节展开。父进程启动后第一件事是 `close(fail[1])`(ProcessImpl_md.c:608,注释 "See: WhyCantJohnnyExec")——只留下自己的读端,保证后面"EOF 即成功"的判定成立。

## 2. 子进程的自我改造与成败协议

### childProcess: 重排 fd、关清、exec

子进程的天下在 `childProcess`(childproc.c:316-400,整个文件 400 行)。顺序很讲究(截取核心,逐字):

```cpp
// childproc.c:340-356(截取核心,逐字)
    /* Give the child sides of the pipes the right fileno's. */
    /* Note: it is possible for in[0] == 0 */
    if ((moveDescriptor(p->in[0] != -1 ?  p->in[0] : p->fds[0],
                        STDIN_FILENO) == -1) ||
        (moveDescriptor(p->out[1]!= -1 ? p->out[1] : p->fds[1],
                        STDOUT_FILENO) == -1))
        goto WhyCantJohnnyExec;

    if (p->redirectErrorStream) {
        if ((closeSafely(p->err[1]) == -1) ||
            (restartableDup2(STDOUT_FILENO, STDERR_FILENO) == -1))
            goto WhyCantJohnnyExec;
    } else {
```

- 进函数第一件事是 `closeSafely` 掉**父进程端的管道副本**(childproc.c:332-338: in[1]/out[0]/err[0]/childenv[0]/childenv[1]/fail[0],注释 "a little paranoia is a good thing")——子进程只留自己的那半对,数据才能单向流动;
- **moveDescriptor**(childproc.c:121-130)就是 `dup2 + close` 两步,没有更巧的: fd 相同则不动(注释 "it is possible for in[0] == 0" 指管道读端恰好落在 fd 0 时直接生效);
- **redirectErrorStream**(`pb.redirectErrorStream(true)`)在子进程内 `dup2(1, 2)` 把 stderr 并进 stdout(:348-351)——管道数量不变,省一路 fd;
- 然后是 `moveDescriptor(fail_pipe_fd, FAIL_FILENO)`(:358-359,`FAIL_FILENO` = 3,childproc.h:73)把失败信道钉在 fd 3,再 `fcntl(3, F_SETFD, FD_CLOEXEC)`(:377-378);
- **closeDescriptors**(childproc.c:80-119)是清理继承 fd 的主力: 先显式关 4、5 给 `opendir` 让位(:94-95),再遍历 `/proc/self/fd`,把所有数字 ≥ 6 的目录项逐个 `close`(:109-114)——不用 close_range/closefrom 这类批量调用,而是借 `/proc` 自省。fail 信道的 fd 3 因为小于 6 而幸免——顺序设计环环相扣;
- 兜底: `closeDescriptors` 失败时线性循环 `sysconf(_SC_OPEN_MAX)`(childproc.c:365-371);
- `chdir(p->pdir)` 切工作目录(:374-375),最后一步是 exec。

### exec: 用父进程的 PATH,不是子进程的

exec 不是简单的 `execvp`。`JDK_execvpe`(childproc.c:234-308)是 JDK 自己的 PATH 搜索器,注释点明动机(:252,逐字): "We must search PATH (parent's, not child's)"——子进程环境(ProcessBuilder.environment())里的 PATH 可能被用户改过,而搜索用的 `parentPathv` 是父进程在 `ProcessImpl.init()`(ProcessImpl_md.c:202-208)时缓存的**父进程自己 PATH 的切分数组**(`effectivePathv`,:176-200,空组件按 `.` 处理)。而 execvp 有个隐藏前提: 它按全局 `environ` 搜索,不是按参数里的 envp——非共享模式下 JDK 先把 `environ` 换成子进程环境再 execvp(execve_with_shell_fallback,childproc.c:222-223),但 vfork 模式下地址空间是共享的,改 `environ` 就等于改父进程,只能逐目录 `execve` 显式传环境(execve_with_shell_fallback,:210-225);execve 返回 ENOEXEC 时再用 `/bin/sh` 兜底跑传统脚本(execve_as_traditional_shell_script,:187-204,注释 "compatibility wins over sanity")。

**关键设计 (斜体)**: *PATH 的语义在"谁的 PATH"上最容易出错: execvp 按调用者 environ 搜,而这里子进程有自己的一套环境——JDK 选择让 exec 的搜索路径来自父进程、被 exec 程序的环境来自参数,两者彻底分开。vfork 模式下"不改全局变量"的禁令,连 execvp 都被排除在外。*

### 成败协议: EOF 就是成功

fork 之后父进程怎么知道 exec 成了没有?子进程失败时写 errno、成功时什么都不做,靠 FD_CLOEXEC 让管道自然断流(childproc.c:382-399,核心注释逐字):

```cpp
// childproc.c:382-399(逐字)
 WhyCantJohnnyExec:
    /* We used to go to an awful lot of trouble to predict whether the
     * child would fail, but there is no reliable way to predict the
     * success of an operation without *trying* it, and there's no way
     * to try a chdir or exec in the parent.  Instead, all we need is a
     * way to communicate any failure back to the parent.  Easy; we just
     * send the errno back to the parent over a pipe in case of failure.
     * The tricky thing is, how do we communicate the *success* of exec?
     * We use FD_CLOEXEC together with the fact that a read() on a pipe
     * yields EOF when the write ends (we have two of them!) are closed.
     */
    {
        int errnum = errno;
        restartableWrite(fail_pipe_fd, &errnum, sizeof(errnum));
    }
    close(fail_pipe_fd);
    _exit(-1);
    return 0;  /* Suppress warning "no return value from function" */
```

**exec 成功 = fd 3 被 exec 自动关闭 = 父进程读到 EOF;exec 失败 = errno 原样回传**。注意 `_exit(-1)` 而不是 `_exit(1)`——退出码本身没意义,真正的失败原因已经走管道。父进程侧(ProcessImpl_md.c:634-643)读一次 int,`0`(EOF)即成功,`sizeof(int)` 即失败并带 errno:

```cpp
// ProcessImpl_md.c:634-643(截取核心,逐字)
    switch (readFully(fail[0], &errnum, sizeof(errnum))) {
    case 0: break; /* Exec succeeded */
    case sizeof(errnum):
        waitpid(resultPid, NULL, 0);
        throwIOException(env, errnum, "Exec failed");
        goto Catch;
    default:
        throwIOException(env, errno, "Read failed");
        goto Catch;
    }
```

`waitpid` 回收掉僵尸,然后带着**真实的 errno** 抛 `IOException`——`Cannot run program ... error=2, No such file or directory` 就是这么来的。exec 成功则数据管道回到 Java: 三个 fd 写回 `fds[0..2]`(fds[0]=stdin 写端、fds[1]=stdout 读端、fds[2]=stderr 读端,ProcessImpl_md.c:645-647),`initStreams`(ProcessImpl.java:373-407)把它们包成 `getOutputStream`/`getInputStream`/`getErrorStream`;子进程退出时 reaper 回调触发 `processExited`——先 `drainInputStream` 把管道里残留的输出榨干、再关 fd(ProcessPipeInputStream,ProcessImpl.java:657-700)——所以子进程死后仍能读到它最后吐出的几行。

posix_spawn 模式多一道握手: 因为 glibc 的 posix_spawn 不回报 exec 失败(ProcessImpl_md.c:579-589,注释引 JDK-8223777),子进程醒来第一件事先写 `CHILD_IS_ALIVE`(=65535,childproc.c:322-327)再干活,父进程先读到 ping 才知道"活着、接下来看 errno"(ProcessImpl_md.c:611-632)。helper 程序 `jspawnhelper`(unix/native/jspawnhelper/jspawnhelper.c:133-152)用 `fcntl`/`fstat` 校验管道参数后(:140-147,防被手动调用,"This command is not for general use")从管道读回 ChildStuff,再调同一个 `childProcess`(:150)。

**关键设计 (斜体)**: *"成功不可言说、失败有准确原因"用一条管道和一个 CLOEXEC 语义就解决了: 成功连一个字节都不用写。这个协议同时约束了 fd 布局(失败信道必须钉在 3、必须小于 closeDescriptors 的门槛、必须带 CLOEXEC),三处机制互为因果。*

## 3. 观察: ProcessHandle 的 /proc 世界

### 遍历: 每读到一个目录项,就开一次 stat

`ProcessHandle.allProcesses()`(ProcessHandle.java:197-199)只是 `ProcessHandleImpl.children(0)` 的别名——**pid 0 表示"全部进程"**。链路的另一端是 `unix_getChildren`(ProcessHandleImpl_unix.c:508-615): `opendir("/proc")`(:546)后逐个 `readdir`(:570),数字开头的目录名才是 pid(`atoi` 过滤, :576-579),然后**对每个候选进程调一次 `os_getParentPidAndTimings` 读 stat**(:582)——Java 侧会循环扩大数组直到装下全部(ProcessHandleImpl.java:431-435)。

### stat: 跳过名字,数到第 22 个字段

`os_getParentPidAndTimings`(Linux 版,ProcessHandleImpl_linux.c:74-132)打开 `/proc/<pid>/stat` 解析。难点是格式里 `pid (comm)` 的 comm 是任意字符串(进程可借 prctl 改名,含 `)` 也合法),所以先找第一个 `(` 再找**最后一个** `)`,跳过名字后按位置取字段(ProcessHandleImpl_linux.c:107-131,逐字):

```cpp
// ProcessHandleImpl_linux.c:107-131(截取核心,逐字)
    buffer[statlen] = '\0';
    s = strchr(buffer, '(');
    if (s == NULL) {
        return -1;               // parent pid is not available
    }
    // Found start of command, skip to end
    s++;
    s = strrchr(s, ')');
    if (s == NULL) {
        return -1;               // parent pid is not available
    }
    s++;

    // Scan the needed fields from status, retaining only ppid(4),
    // utime (14), stime(15), starttime(22)
    if (4 != sscanf(s, " %*c %d %*d %*d %*d %*d %*d %*u %*u %*u %*u %lu %lu %*d %*d %*d %*d %*d %*d %llu",
            &parentPid, &utime, &stime, &start)) {
        return 0;              // not all values parsed; return error
    }

    *totalTime = (utime + stime) * (jlong)(1000000000 / clock_ticks_per_second);

    *startTime = bootTime_ms + ((start * 1000) / clock_ticks_per_second);

    return parentPid;
```

- 输出三样东西: **ppid、CPU 时间(utime+stime 换算纳秒)、startTime(启动时刻)**;
- startTime 由 `btime`(开机时刻,启动时从 /proc/stat 读一次,ProcessHandleImpl_linux.c:248-271)加上进程自身的 ticks 换算——它就是后面的"防误杀"工具;
- **isAlive0 就是"stat 文件开得开"**(ProcessHandleImpl_unix.c:387-394 调 os_getParentPidAndTimings,fopen 失败返回 -1)——不需要 kill(pid,0) 那种信号探测。流传的 "kill(pid,0)+ESRCH" 判定在这里不成立,它只存在于 Solaris/AIX 路径(读完 psinfo 后的二次校验,ProcessHandleImpl_unix.c:666)。

进程详情 `info()`(command/args/user)走另一组文件: `/proc/<pid>/exe` 的 `readlink` 拿命令全路径(ProcessHandleImpl_linux.c:178-184,权限不足时 `command` 缺省)、`/proc/<pid>/cmdline` 按 `\0` 分隔计数参数(:194-230,当 exe 读不到或 cmdline 被截断时把整串 `\0` 换成空格作 commandLine 兜底,:210-222)、`/proc/<pid>` 的 stat 拿 uid 查用户名(:146-150)。[实证] 里 `handle.info = [user: root, cmd: /usr/bin/bash, args: [-c, sleep 1; echo hello-from-child], ...]`(materials/commands/42-process-demo.txt)——`cmd` 正是 readlink 的结果。

**关键设计 (斜体)**: *"遍历 /proc"听起来便宜,实际每个进程一次 fopen+sscanf——allProcesses 是 O(进程数)的目录扫描加 O(进程数)的文件解析,系统上进程越多越贵。但好处是**不需要任何内核权限就能看到所有进程的父子关系和启动时刻**,这是 /proc 文件系统对 Java 层的最大价值。*

## 4. 回收与终止: reaper 线程与"防误杀"

### waitFor 不调 waitpid

`p.waitFor()`(ProcessImpl.java:493-498)看起来是阻塞等待——实现只是 `while (!hasExited) wait()` 的监视器等待。真正等子进程的是**进程收割者(reaper)线程**: `ProcessHandleImpl.completion(pid, true)`(ProcessHandleImpl.java:123-181)用 `completions` 并发表做单例化,起一个名为 `process reaper (pid N)` 的守护线程,栈只给 128KB、`MAX_PRIORITY`(:54,:84-107),阻塞在 native `waitForProcessExit0`(ProcessHandleImpl_unix.c:245 的 `waitpid(pid, &status, 0)`)上;子进程一死,reaper 解析状态并 `complete(exitcode)`,回调把 exitcode 写进 ProcessImpl 并 `notifyAll`(ProcessImpl.java:389-406)。[实证] 里 jstack 能直接看到它(materials/commands/42-process-reaper-thread.txt):

```
"process reaper (pid 1140149)" #25 daemon prio=10 ... runnable
        at java.lang.ProcessHandleImpl.waitForProcessExit0(java.base@17.0.8.1/Native Method)
        at java.lang.ProcessHandleImpl$1.run(java.base@17.0.8.1/ProcessHandleImpl.java:150)
```

退出码解码在 ProcessHandleImpl_unix.c:254-260: 正常退出 `WEXITSTATUS(status)`,被信号杀则返回 **128+信号号**(非 Solaris 的 `WTERMSIG_RETURN` 定义于 :143)。[实证] `exitValue = 7`(`sh -c "exit 7"`)与 `waitFor after destroy = 143`(=128+15,SIGTERM)两个数字都能对上。

### destroy: kill 之前先对"出生证"

`p.destroy()`(ProcessImpl.java:526-571)→ `processHandle.destroyProcess(force)`(ProcessHandleImpl.java:346-351)→ native `destroy0`(ProcessHandleImpl_unix.c:312-327,逐字):

```cpp
// ProcessHandleImpl_unix.c:312-327(逐字)
JNIEXPORT jboolean JNICALL
Java_java_lang_ProcessHandleImpl_destroy0(JNIEnv *env,
                                          jobject obj,
                                          jlong jpid,
                                          jlong startTime,
                                          jboolean force) {
    pid_t pid = (pid_t) jpid;
    int sig = (force == JNI_TRUE) ? SIGKILL : SIGTERM;
    jlong start = Java_java_lang_ProcessHandleImpl_isAlive0(env, obj, jpid);

    if (start == startTime || start == 0 || startTime == 0) {
        return (kill(pid, sig) < 0) ? JNI_FALSE : JNI_TRUE;
    } else {
        return JNI_FALSE;
    }
}
```

`force` 决定 SIGKILL/SIGTERM,但**先重新读一次当前 startTime 与持有时的比对**——pid 是会被内核复用的,如果目标 pid 已被新进程占用,startTime 必然不同,拒绝 kill。这套"startTime 防误杀"贯穿整个 ProcessHandle 家族: `isAlive()` 要求 startTime 匹配(ProcessHandleImpl.java:388-391)、`children()` 用 startTime 过滤掉旧父进程的后代(:413)、`info()` 在 startTime 不符时清空所有字段(:587-598)、reaper 在轮询中还检测 startTime 变化判断"pid 已经不是原来那个"(ProcessHandleImpl.java:152-166)。

**关键设计 (斜体)**: *"pid 复用"是进程 API 的原罪: pid 只有 32 位,系统起来久了必然轮回。JDK 的答案是把 (pid, startTime) 当成进程身份,凡是"对别的进程动手"的操作(kill/查询/收割)都先验 startTime——宁可不杀、不可杀错。这也是 ProcessHandleImpl 每个实例都缓存 startTime 的原因。*

## 核心悬念

一次 exec 的完整闭环到齐: ProcessBuilder 打包 → forkAndExec 建管道 → vfork/posix_spawn 复制自己 → childProcess 重排 fd(dup2/redirectErrorStream/closeDescriptors)→ JDK_execvpe 按父进程 PATH 执行 → fail pipe 回传成败;反过来,ProcessHandle 遍历 /proc 看世界、reaper 线程负责 waitpid、destroy 用 startTime 防误杀。进程面用的是文件描述符和 /proc 这两套操作系统设施,而 libjava 还有第三个大块: **类的原生字节从哪来、native 库怎么被 dlopen 进来、java.io.File 的 fd 又是怎么被包装的**——下一篇进入 ClassLoader 与 I/O。

> → [03 — ClassLoader + I/O + TimeZone](03-class-io.md)
