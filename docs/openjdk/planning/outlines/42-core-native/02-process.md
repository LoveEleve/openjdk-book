# 02. 进程管理 — Runtime.exec() 的 fork+exec+wait

> 🔴 Deep | ProcessBuilder→ProcessImpl + ProcessHandle(children/live/destroy)
> 读者处境: `Runtime.getRuntime().exec("ls -la")`→ProcessBuilder→fork+execvp→redirect stdin/stdout/stderr→waitpid→exit code。`ProcessHandle.allProcesses()` 遍历 `/proc`→返回所有进程。`process.destroy()`→kill(SIGTERM)。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/42-core-native/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准;本文 264 行):
> - **平台默认启动方式错**: 不是 "Linux vfork / Solaris fork"。真实=Linux 默认 VFORK、BSD/Solaris/AIX 默认 POSIX_SPAWN(fork 仅作属性覆写选项,ProcessImpl.java:90-98);mode 由 LaunchMechanism.ordinal()+1 决定(:340),MODE_FORK=1/POSIX_SPAWN=2/VFORK=3(childproc.h:85-88);文件头注释 :97-98 "vfork() on Linux and posix_spawn() on other Unix systems"
> - **closeDescriptors 机制编造**: 不是 "fcntl(F_CLOSEM)/close_range(Linux 5.9+)";真实=显式关 4、5 给 opendir 让位(:94-95)+ 遍历 /proc/self/fd 关 ≥6(childproc.c:80-119,定义处;大纲 :365 是 childProcess 内的 fallback 调用点: sysconf(_SC_OPEN_MAX) 线性循环 :365-371)
> - **moveDescriptor "fd<4 先 dup 临时位置" 编造**: 真实就是 dup2+close 两步,fd_from==fd_to 不动(childproc.c:121-130)
> - **execvp(cmd[0],cmd) 简化错**: 真实=JDK_execvpe(childproc.c:234-308): 按**父进程** PATH(parentPathv,ProcessImpl.init :202-208 缓存,effectivePathv :176-200)搜索非子环境 PATH(注释 :252 "We must search PATH (parent's, not child's)");vfork 共享空间模式不能改 environ → 逐目录 execve(:215-219),ENOEXEC → /bin/sh 传统脚本兜底(:187-204)
> - **_exit(1) 错**: 真实 _exit(-1)(childproc.c:398)
> - **isAlive0 "kill(pid,0)+ESRCH" 错(Linux)**: isAlive0(ProcessHandleImpl_unix.c:387-394)=os_getParentPidAndTimings=fopen /proc/pid/stat 成败(ProcessHandleImpl_linux.c:74-132,先找 '(' 再找最后一个 ')' 跳过 comm 后 sscanf 取 ppid(4)/utime(14)/stime(15)/starttime(22) :122;startTime=bootTime_ms(btime /proc/stat :248-271)+ticks 换算 :129);kill(pid,0) 仅 Solaris/AIX 读 psinfo 后二次校验(unix.c:666)
> - **destroy0 "kill+waitpid(WNOHANG)" 错**: 真实=kill(SIGTERM/SIGKILL) 前先 isAlive0 重读 startTime 比对防 pid 复用(ProcessHandleImpl_unix.c:312-327);等待/回收由 Java 侧 process reaper 线程 waitForProcessExit0(waitpid 阻塞 :245,解码 WEXITSTATUS/128+信号 :254-260)完成,ProcessImpl.waitFor 只是 monitor wait(:493-498)
> - **fail pipe 协议(大纲未提,核心设计)**: 子进程把 fail 钉在 fd 3(FAIL_FILENO,:358-359)+FD_CLOEXEC(:377-378);exec 成功=write 端自动关=父进程 EOF;失败=errno 回传+_exit(-1)(WhyCantJohnnyExec :382-399);父进程 close(fail[1]) 后读(ProcessImpl_md.c:608,:634-643);posix_spawn 模式先写 CHILD_IS_ALIVE=65535 ping(JDK-8223777,glibc posix_spawn 不回报 exec 失败,:579-589,:611-632;childproc.c:322-327);jspawnhelper 在 unix/native/jspawnhelper/ 单独目录(非 libjava!),main :140-147 校验后 childProcess :150
> - **行号漂移**: forkAndExec 在 ProcessImpl_md.c:499 起(非 200-350);管道创建 :558-565;init(缓存 parentPathv+SIGCHLD SIG_DFL 非 SIG_IGN):202-208,:102-129;unix_getChildren :508-615(非 :100-400;opendir :546/readdir :570/atoi :576);getCurrentPid0 :301-305;childProcess childproc.c:316-400 ✓;vfork :362 ✓ fork :382 ✓;childproc.c 400 行 ✓ ProcessHandleImpl_unix.c 728 行 ✓
> - 悬念指向 03-class-io ✓(标题 "03. ClassLoader + I/O + TimeZone — 剩馀核心机制");实证: materials/commands/42-process-demo.txt(exitValue=7/destroy→143=128+15)与 42-process-reaper-thread.txt("process reaper (pid N)" daemon prio=10 阻塞 waitForProcessExit0)

### 1. "ProcessImpl — fork+execvp 管道重定向"

场景: `new ProcessBuilder("ls", "-la").start()` — fork() 创建子进程→子进程 closefrom(3) 关闭所有继承的 fd→dup2(pipe[1], STDOUT_FILENO) 重定向→execvp("ls", ["ls","-la"]) 执行命令。

**ProcessImpl_md.c** (`ProcessImpl_md.c:350-550 + childproc.c:317-400`):
```
Java_java_lang_ProcessImpl_forkAndExec(env, cmdarray, envp, dir, fds, redirectErrorStream) (line 500):
  → 创建 pipe pairs: stdin[2]/stdout[2]/stderr[2] + fail_pipe(父子通信)
  → resultPid = vfork()  (line 362, Linux 优先) or fork() (line 382, Solaris)
  → 子进程(pid==0):
      childProcess(c) (childproc.c:317):
        → closeSafely(parent-side pipes) — 关闭父进程端的 pipe fds
        → moveDescriptor(child-in, STDIN_FILENO) — 重映射到标准 fd 0/1/2
        → moveDescriptor(child-out, STDOUT_FILENO)
        → moveDescriptor(child-err, STDERR_FILENO)
        → closeDescriptors() (childproc.c:365)— 关闭除 stdin/stdout/stderr/fail 外的所有继承 fd
        → fallback: for fd in 4..max_fd: close(fd) (如果 closeDescriptors 失败)
        → chdir(p->pdir) — 切换工作目录
        → execvp(cmd[0], cmd) — 执行命令
        → _exit(1) — exec 失败(不会返回到 Java)
  → 父进程: close child-side pipes, return pid
[C++: ProcessImpl_md.c:683行 + childproc.c:400行——vfork() 比 fork() 快(addrs space 不复制 COW pages)]
```
- 源码: `ProcessImpl_md.c:200-350` (forkAndExec→create pipes→fork) + `ProcessImpl_md.c:350-500` (子进程→closefrom+dup2+execvp、父进程关闭子端)

- 关键设计: **vfork() vs fork()** — Linux 上优先用 `vfork()`(`ProcessImpl_md.c:362`): 父进程的地址空间在子进程 execve 前与子进程共享(不复制 COW pages)→比 fork() 快(省去 page table copy)。子进程必须立即 exec 或 _exit——不能修改全局变量/return(因为 vfork 阻塞父进程+共享栈)。Solaris 回退到 `fork()`(line 382)。**closeDescriptors() 安全** — `childproc.c:365` 用 `fcntl(F_CLOSEM)` 或 `close_range`(Linux 5.9+) 关闭所有 fd→避免 inherited fd leak——fallback 是线性 close loop(fd=4..max_fd)。**moveDescriptor** — 用 `dup2` 将 pipe fd 映射到标准 fd 0/1/2——如果 pipe fd 本身是 <4 的数字→先 dup 到临时位置→再 dup2 到目标。

### 2. "ProcessHandle — 读取 /proc 遍历进程"

场景: `ProcessHandle.allProcesses()` → Java Stream<ProcessHandle>→C 层 `os::opendir("/proc")`→`readdir`→过滤数字目录(PID)→读取 `/proc/<pid>/stat` + `/proc/<pid>/cmdline`→构造 ProcessHandle。

**ProcessHandleImpl_unix** (`ProcessHandleImpl_unix.c:100-400`):
```
Java_java_lang_ProcessHandleImpl_getCurrentPid0:
  → getpid() → return (jlong)pid

Java_java_lang_ProcessHandleImpl_getProcessPids0:
  → opendir("/proc") → 遍历 readdir→filter 数字文件名(PID dirs)
  → 返回 jlongArray[pid1, pid2, ...]

Java_java_lang_ProcessHandleImpl_isAlive0(pid):
  → kill(pid, 0) → errno==ESRCH? false : true

Java_java_lang_ProcessHandleImpl_destroy0(pid, force):
  → normal: kill(pid, SIGTERM) + waitpid(pid, status, WNOHANG)
  → force: kill(pid, SIGKILL) + waitpid(pid, status, WNOHANG)
[C++: ProcessHandleImpl_unix.c:728行——/proc/filesystem 是 Linux 特有的—其他 Unix 用 kvm_getprocs/sysctl]
```
- 源码: `ProcessHandleImpl_unix.c:100-200` (getCurrentPid0 + getProcessPids0) + `ProcessHandleImpl_unix.c:300-500` (isAlive→kill(pid,0) + destroy→kill(pid,SIGTERM/SIGKILL))

- 关键设计: **kill(pid, 0) 不发送信号** — 但 kernel 仍检查 pid 是否存在+调用者是否有权限→isAlive() 通过 `errno==ESRCH` 判断进程已死——不需要解析 `/proc/<pid>/stat`。**destroy(force=true) 直接 SIGKILL** — 不等待进程退出——Java 层 Process.destroyForcibly() 调用此路径——可能留下未清理资源。

---

### 核心悬念

**"Runtime.exec()→forkAndExec(pipe pairs+closefrom(3)+execvp)→父进程读 pipe 获取子进程 stdout/stderr。ProcessHandle.allProcesses()→opendir(/proc)→readdir(数字 PID)→isAlive→kill(pid,0)→destroy→kill(pid,SIGTERM/SIGKILL)。"** — 下一篇: Class + I/O + TimeZone。

> → [03-class-io.md](03-class-io.md)
