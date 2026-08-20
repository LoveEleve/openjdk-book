# 03-object-system/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.base`；进程创建以 Unix/Linux 的 `ProcessImpl` 为主，信号以 Unix/Linux 的 `Terminator` 为主。
> 目标：把 `ProcessBuilder.start()` 重写成一篇解释“Java 如何把命令、环境和三个标准流交给操作系统，并通过异步退出通知收回结果”的机制文章；VM 初始化和信号只保留能服务主线的部分。

## 1. 读者困惑

- `new ProcessBuilder(...).start()` 为什么不是简单执行一个字符串？
- 子进程的 stdin/stdout/stderr 管道是谁创建的，为什么不读输出会把整个流程卡死？
- Java 代码如何跨过 `ProcessBuilder`、平台实现和 native，真正创建操作系统进程？
- `waitFor()` 为什么不需要 Java 线程不断轮询 `waitpid`？
- `SIGTERM` 和 `SIGKILL` 为什么一个能触发清理，一个完全不给 JVM 机会？

## 2. 一句话顿悟

**ProcessBuilder 负责描述一次进程启动，Unix 平台的 ProcessImpl 负责把描述编码成参数、环境和文件描述符，native 层负责创建并执行子进程；Java 侧再用管道承载 I/O、用退出回调完成 wait/notify，而不是把 OS 进程伪装成 Java 线程。**

## 3. 旧稿优点与问题

### 保留

- 已经覆盖 `ProcessBuilder` 参数校验、平台实现、`std_fds`、`forkAndExec`、`waitFor`、VM 初始化和信号。
- 生产问题抓得准：不消费子进程输出可能阻塞，`SIGTERM` 与 `SIGKILL` 语义不同。
- `ProcessImpl` 平台目录边界已经标明，没有把 Unix 实现直接写成所有平台实现。

### 必须重写

- 当前按“第一层、第二层、第三层”平铺源码，读者还没有先建立“父进程、子进程、管道、退出观察者”的角色图。
- `fork + exec` 被讲成固定实现，但 JDK 11 的 Unix `ProcessImpl` 明确支持 `fork/exec`、`posix_spawn`、`vfork/exec` 三类启动机制；Linux 默认机制需要以实际枚举和构建条件为准，不能把某条路径写成 Java API 必然行为。
- “管道缓冲区约 64KB”是平台/内核相关经验，不能作为 JDK 11 源码结论硬写；应改成“有限缓冲区写满后，子进程写端会阻塞”，必要时另标 Linux 实验条件。
- VM 初始化部分容易抢走文章主线，应压缩成“进程启动 API与 VM/native 边界”的补充段，不再把“第一个 Java 代码”当主标题。
- 信号部分必须区分 JDK 11 Unix `Terminator.setup()` 注册的 `HUP/INT/TERM` 与 `SIGKILL` 的内核不可捕获语义，并标明 `-Xrs` 会改变 JVM 对部分信号的处理责任。

## 4. 理解路径

### 第一节：一个 `start()` 为什么会把业务卡死

用生产场景开场：父进程启动外部命令，等待结果时同时遇到两类问题：子进程输出没人消费导致管道写满，父进程只调用 `waitFor()` 却没有处理 stdout/stderr。先给出角色图：父进程、子进程、三条标准流、进程退出观察者。

### 第二节：ProcessBuilder 不是执行器，而是启动描述

回答“Java 先校验什么”：命令列表复制、空参数、`SecurityManager.checkExec`、NUL 字符拒绝、工作目录和重定向配置。强调命令数组不是 shell 字符串，`ProcessBuilder` 不自动替调用者解释 shell 语法。

失败方案：把整条命令拼成一个字符串，期待 Java 自动完成 shell 解析、转义和重定向；解释为什么参数边界和安全责任会变得模糊。

### 第三节：重定向如何变成三个文件描述符

先画：

```text
stdin  : 父进程写端 → 子进程 fd 0
stdout : 子进程 fd 1 → 父进程读端
stderr : 子进程 fd 2 → 父进程读端
```

再讲 `ProcessImpl.start`：参数编码为连续 `argBlock`，环境编码为 `envBlock`，`Redirect.PIPE` 用 `-1` 表示“由 native 创建管道”，`INHERIT` 使用 0/1/2，文件重定向先打开文件取得 fd。说明 JDK 注释给出的取舍：参数在 Java 中管理内存比在 C 中管理更容易。

失败方案：让 Java 层分别创建管道、fork、配置 fd、exec，并在每一步处理失败回滚；说明平台相关状态集中进入 native 封装更容易保持一致。

### 第四节：一次 native 调用如何跨过 fork/exec 边界

说明 `forkAndExec` 的 `mode` 可选择三类 Unix 机制，不把 Linux 默认值写成跨平台保证。解释 POSIX 语义：fork/vfork/posix_spawn 创建或准备子进程，exec 替换程序映像；父进程拿到 pid 与管道 fd，Java 再创建 `ProcessPipeInputStream` / `ProcessPipeOutputStream`。

总图：

```text
ProcessImpl
   → argBlock/envBlock/std_fds
   → forkAndExec(mode, ...)
   → pid + parent-side pipe fds
   → ProcessHandle + Java streams
```

### 第五节：waitFor 为什么是通知模型，不是轮询

从 `ProcessImpl.waitFor` 的 `while (!hasExited) wait()` 开始，先让读者猜“谁设置 `hasExited`”。再看 `ProcessHandleImpl.completion(pid, true)` 完成回调：设置退出码、标记 `hasExited`、`notifyAll()`，并调用三条进程管道流的 `processExited()`。

失败方案：Java 线程定时轮询子进程状态；说明轮询会浪费线程和引入延迟，JDK 选择由进程句柄完成机制负责观察退出，再用条件等待唤醒调用者。

补充生产规则：必须并行消费 stdout/stderr，使用 `redirectErrorStream(true)`、重定向到文件或专门的消费线程；不要把“先 `waitFor`、之后再读输出”当通用安全顺序。

### 第六节：VM 初始化与信号只作为边界收束

压缩 VM 初始化：`System` 静态块注册 natives，`System.initPhase1` 由 VM 注入属性并建立内部快照；只解释这对 Process API 的意义——Java 进程本身也必须先完成 VM/native 握手，才能提供后续系统边界能力。

信号只讲事实链：Unix `Terminator.setup()` 注册 `HUP`、`INT`、`TERM`，处理器调用 `Shutdown.exit`；`SIGKILL` 不能捕获、阻塞或忽略；`-Xrs` 时由用户负责通过 `System.exit()` 触发 hook。Kubernetes 优雅终止窗口作为实践场景，不把默认秒数写成 JVM 保证。

### 第七节：收网与下一篇钩子

回到“为什么不读输出会卡死”：Process 是 OS 进程，不是 Java 线程；I/O 管道有容量，退出通知和 I/O 消费是两条必须同时推进的链。收束为启动、通信、等待、强制终止四条规则，并引出类加载器之前需要先理解 Java 进程本身的启动与运行边界。

## 5. 失败方案清单

1. 把命令拼成一个字符串，期待 `ProcessBuilder` 自动完成 shell 解析。
2. 只调用 `waitFor()`，不消费 stdout/stderr。
3. 把 stdout 和 stderr 串行读取，导致另一条管道先被写满。
4. 在 Java 层手工拆分 pipe、fork、fd 配置和 exec，并自行维护失败回滚。
5. 把 `fork + exec` 写成 JDK 11 所有平台唯一实现。
6. 让 Java 线程周期性轮询子进程，替代完成回调与 `wait/notify`。
7. 把 `SIGTERM`、`SIGKILL` 和 `System.exit` 当作同一种退出通知。

## 6. 误解清单

1. `ProcessBuilder` 接收的是 shell 命令字符串；实际核心 API 是参数列表，shell 需要显式启动。
2. `Process` 是 Java 线程；实际它代表子进程，Java 通过 fd/管道和进程句柄交互。
3. `waitFor()` 会自动帮忙消费输出；实际它只等待退出状态，I/O 仍需调用者处理。
4. `forkAndExec` 在所有系统都等于固定的 `fork` 后 `execve`；JDK 11 Unix 实现支持多种启动机制。
5. `SIGTERM` 一定能跑完 hook；外部超时、`-Xrs`、进程崩溃和 `SIGKILL` 都会改变结果。
6. 管道容量是 JDK API 固定的 64KB；容量取决于平台和内核配置。
7. `waitFor` 通过 Java 线程不断调用 `waitpid`；JDK 11 的 Java 层使用进程句柄完成回调更新状态。

## 7. 总图、角色与时序

```text
调用者
  │ 配置命令、环境、目录、重定向
  ▼
ProcessBuilder
  │ 校验并委托
  ▼
ProcessImpl（Unix/Linux 平台实现）
  │ argBlock + envBlock + std_fds
  ▼
forkAndExec(mode)
  ├── 子进程：准备 fd → exec 新程序映像
  └── 父进程：得到 pid 与管道 fd
          ├── Java stream：承载 stdin/stdout/stderr
          └── ProcessHandle completion：感知退出
                         ▼
              hasExited + exitcode + notifyAll
```

## 8. 证据清单

- `ProcessBuilder.java:1070-1072`：`start()` 入口。
- `ProcessBuilder.java:1082-1111`：命令复制、空值检查、安全检查、NUL 检查与委托。
- `ProcessImpl.java:187-213`：参数块和环境块编码。
- `ProcessImpl.java:215-265`：三条标准流的 `std_fds` 组装。
- `ProcessImpl.java:303-329`：三种 native 创建机制与 `forkAndExec` 声明。
- `ProcessImpl.java:340-357`：native 返回后建立进程句柄并初始化流。
- `ProcessImpl.java:373-406`：管道流与退出完成回调。
- `ProcessImpl.java:493-498`：`wait/notify` 等待退出。
- `System.java:101-104`：native 注册静态块。
- `System.java:1954-1981`：VM 注入属性与启动初始化。
- `Terminator.java:47-69`：Unix 下 `HUP/INT/TERM` 到 `Shutdown.exit` 的绑定。
- `VM.java:93-111`：启动和 shutdown 状态查询。

## 9. 版本、平台与证据边界

- 正文以 JDK 11 源码为准；`ProcessImpl` 路径是 Unix/Linux 实现，不代表 Windows 实现细节。
- `fork`、`vfork`、`posix_spawn` 的实际选择受平台、JDK 构建和启动选项影响；只能说 JDK 11 Unix 实现提供这些模式。
- 管道容量、具体系统调用和 fd 行为属于操作系统实现；除非给出实验平台，不写固定容量。
- `SIGTERM` 的 shutdown 路径是 JDK 11 Unix `Terminator` 实现；`SIGKILL` 不可捕获是 Unix 内核语义。
- `waitFor` 的 Java 层状态更新来自 JDK 11 `ProcessImpl`；native 如何等待子进程属于平台实现，不在 Java 源码中臆测具体 `waitpid` 调用位置。
- `System` 的 `registerNatives` 与 `initPhase1` 只能证明 Java/native 初始化边界，不能据此断言全部 VM 启动步骤的严格全局顺序。

## 10. 删除代码测试与最终验收标准

- 删除全部代码块后，读者仍能复述“配置 → fd/管道 → native 创建 → Java 流 → 退出回调”的主线。
- 小标题能够还原“事故 → 失败方案 → 角色图 → 机制 → 收网”。
- 至少解释两个失败方案：不消费输出、把命令拼成字符串；重大机制再解释 native 分层、轮询等待和固定 fork 假设。
- 每个关键结论都有真实 JDK 11 `file:line` 证据，并明确 Java 契约、JDK 当前实现、Unix/Linux 实现和经验规则的边界。
- 不使用禁用词，不把固定管道容量、Linux 默认启动机制或 Kubernetes 秒数写成跨平台规范。
- 结尾回到“为什么 `waitFor` 可能配合错误的 I/O 使用而卡死”，并自然衔接类加载器主题。
