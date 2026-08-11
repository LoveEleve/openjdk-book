# 02. 进程管理 — Runtime.exec() 的 fork+exec+wait

> 🔴 Deep | ProcessBuilder→ProcessImpl + ProcessHandle(children/live/destroy)
> 读者处境: `Runtime.getRuntime().exec("ls -la")`→ProcessBuilder→fork+execvp→redirect stdin/stdout/stderr→waitpid→exit code。`ProcessHandle.allProcesses()` 遍历 `/proc`→返回所有进程。`process.destroy()`→kill(SIGTERM)。

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
