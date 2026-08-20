# 42-core-native/02-process 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / libjava`
> 目标：解释 Java 的 `ProcessBuilder.start()` / `Runtime.exec()` 为什么不是“调个 fork+exec 就完了”，而是一套带参数打包、复制策略选择、子进程自我改造、失败回传和 pid 复用防误杀的完整协议

## 1. 选题判断

现稿已有很强事实基础：
- `ProcessImpl.start` 参数打包
- launch mechanism 枚举与 `MODE_*` 协议号
- `ProcessImpl_md.c` 对 fork/vfork/posix_spawn 的分析
- `childProcess` 的 fd 重排与 `closeDescriptors`
- fail pipe + FD_CLOEXEC 成败协议
- `ProcessHandle` 的 `/proc` 遍历与 `startTime` 防误杀

但当前正文更像“创建路径”和“观察路径”并排罗列。真正该打穿的读者困惑更集中：

**Java 层一行 `exec("ls -la")`，为什么底下不是简单的 `fork(); execvp();`？JDK 为什么还要自己打包参数块、设计 fail pipe、区分 vfork/posix_spawn、在 destroy 时还要拿 startTime 再验一次 pid？这些看起来过度复杂的步骤，到底分别在防什么坑？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**JDK 的进程面不是“帮你调系统调用”，而是在为 Java 世界补上一整套操作系统协议缺口：Java 参数/环境要先翻成 C 数组；fork 之后子进程必须在 exec 前把标准流、工作目录、继承 fd 清成目标形状；父进程还得拿到“exec 到底成没成”的准确结果；而到了查询和销毁阶段，又必须用 `(pid, startTime)` 而不是裸 pid 给进程做身份校验，避免 pid 复用误杀。**

## 3. 总图

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

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么 `exec` 背后要有一整套协议

目标约 1200 字。

- 从 `Runtime.exec("ls -la")` 或 `ProcessBuilder.start()` 切入
- 点出反直觉：不是两次系统调用，而是一整串协议动作
- 埋主线：JDK 要补的是 Java 世界和 Unix 进程世界之间的协议缺口

### 第二节：两个朴素方案为什么都不行

目标约 1800 字。

必须推演：
1. Java 侧字符串直接一路传下去，native 里临时拼 `argv/envp`
2. 直接 `fork + execvp`，失败就靠返回码，销毁就靠裸 pid

结论：
- 第一种会把参数/环境/重定向协议散落在 C 热路径上
- 第二种扛不住 exec 失败回传、继承 fd 清理、pid 复用误杀等现实问题

### 第三节：启动前打包——为什么参数块和 std_fds 要在 Java 层先压好

目标约 1900 字。

- `ProcessImpl.start`
- `argBlock` / `envBlock`
- `std_fds` 中 `-1/0/1/2/文件fd` 的协议
- `launchMechanism.ordinal() + 1` 与 `MODE_*` 同步
- 路标：这一步解决的是“Java 对象世界怎么翻成 childProcess 能消费的 C 协议”

### 第四节：复制自己——为什么要并存 fork / vfork / posix_spawn

目标约 2200 字。

- `ProcessImpl_md.c` 顶部四种策略分析
- Linux 默认 VFORK，其他 Unix 默认 POSIX_SPAWN
- `vforkChild` 的 noinline / volatile paranoia
- 为什么 JDK 不是“盲目追最快”，而是在不同风险间折中

### 第五节：子进程自我改造——为什么 child 不是一 fork 就 exec

目标约 2300 字。

- `childProcess`
- 关闭父端管道副本
- `moveDescriptor` / `dup2`
- `redirectErrorStream`
- `FAIL_FILENO`、`FD_CLOEXEC`
- `closeDescriptors` 的 `/proc/self/fd` 清场
- `chdir`
- 强调“exec 前的子进程是一间临时工地”

### 第六节：成败协议——为什么成功靠 EOF，失败回 errno

目标约 2100 字。

- `WhyCantJohnnyExec`
- fail pipe
- 父进程读 `fail[0]`
- posix_spawn 模式的 `CHILD_IS_ALIVE` ping
- `jspawnhelper` 只点关键边界
- 统一回“try 才知道成败，预测不可靠”

### 第七节：观察与销毁——为什么 `ProcessHandle` 把 `(pid, startTime)` 当身份

目标约 2200 字。

- `/proc` 扫描和 `os_getParentPidAndTimings`
- `waitForProcessExit0` 与 reaper 线程
- `destroy0`
- pid 复用与 startTime 校验
- `children()` / `info()` / `isAlive()` 都共享这套身份判断

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. `Runtime.exec` 是否就是一层 `execvp` 薄封装
2. posix_spawn 是否天然总优于 vfork/fork
3. fail pipe 是否只是错误日志通道
4. `ProcessHandle.allProcesses()` 是否是低成本常量时间操作
5. destroy 是否只靠 pid 就足够安全

## 5. 失败方案必须写进正文

1. 直接 `fork + execvp` 就够了
2. exec 失败可以靠退出码回传，不必单独建 fail pipe
3. 用裸 pid 做进程身份就够了，不必校验 startTime

## 6. 证据清单

- `src/java.base/unix/classes/java/lang/ProcessImpl.java:83`：`LaunchMechanism`
- `src/java.base/unix/classes/java/lang/ProcessImpl.java:92`：平台默认 launch mechanism
- `src/java.base/unix/classes/java/lang/ProcessImpl.java:196`：`argBlock` 打包
- `src/java.base/unix/classes/java/lang/ProcessImpl.java:223`：`std_fds` 协议
- `src/java.base/unix/classes/java/lang/ProcessImpl.java:340`：`forkAndExec(...)`
- `src/java.base/unix/native/libjava/ProcessImpl_md.c:51`：四种策略分析注释
- `src/java.base/unix/native/libjava/ProcessImpl_md.c:176`：`effectivePathv`
- `src/java.base/unix/native/libjava/ProcessImpl_md.c:202`：`ProcessImpl.init`
- `src/java.base/unix/native/libjava/ProcessImpl_md.c:342`：`vforkChild`
- `src/java.base/unix/native/libjava/ProcessImpl_md.c:499`：`forkAndExec`
- `src/java.base/unix/native/libjava/ProcessImpl_md.c:579`：posix_spawn alive ping 注释
- `src/java.base/unix/native/libjava/ProcessImpl_md.c:634`：父进程读 fail pipe 判成功/失败
- `src/java.base/unix/native/libjava/childproc.c:80`：`closeDescriptors`
- `src/java.base/unix/native/libjava/childproc.c:121`：`moveDescriptor`
- `src/java.base/unix/native/libjava/childproc.c:187`：`execve_as_traditional_shell_script`
- `src/java.base/unix/native/libjava/childproc.c:234`：`JDK_execvpe`
- `src/java.base/unix/native/libjava/childproc.c:252`：`We must search PATH (parent's, not child's)`
- `src/java.base/unix/native/libjava/childproc.c:316`：`childProcess`
- `src/java.base/unix/native/libjava/childproc.c:382`：`WhyCantJohnnyExec`
- `src/java.base/share/classes/java/lang/ProcessHandleImpl.java:84`：reaper executor
- `src/java.base/share/classes/java/lang/ProcessHandleImpl.java:123`：`completion`
- `src/java.base/unix/native/libjava/ProcessHandleImpl_unix.c:240`：`waitForProcessExit0`
- `src/java.base/unix/native/libjava/ProcessHandleImpl_unix.c:312`：`destroy0`
- `src/java.base/unix/native/libjava/ProcessHandleImpl_unix.c:508`：`unix_getChildren`
- `src/java.base/linux/native/libjava/ProcessHandleImpl_linux.c:74`：`os_getParentPidAndTimings`
- `src/java.base/linux/native/libjava/ProcessHandleImpl_linux.c:174`：`/proc/<pid>/exe`
- `src/java.base/linux/native/libjava/ProcessHandleImpl_linux.c:186`：`/proc/<pid>/cmdline`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / Linux / x86_64 / libjava`
- 本篇聚焦 Unix 路径，Windows 不展开
- ProcessBuilder Java 侧细枝末节不全铺，只保留与 native 协议相关的部分
- `/proc` 查询与进程创建是两个相反方向的协议，但都收回“身份与状态翻译”主线
- 后续篇章如果继续 core-native 域，应自然接进 ClassLoader/I/O/TimeZone 等更广的 libjava 面

## 8. 完成后 review

- 删除代码后，能否复述“JDK 的进程面是在补 Java 和 Unix 之间的协议缺口”
- 是否清楚区分启动协议、失败回传协议、进程身份协议三层
- 是否讲清 `vfork` / `posix_spawn` / `fork` 为什么并存
- 是否明确 `(pid, startTime)` 的防误杀意义
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
