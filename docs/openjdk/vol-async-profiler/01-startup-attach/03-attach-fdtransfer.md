# 03. agent 已经进 JVM，为什么 CPU 采样还可能起不来 —— `jattach`、`fdtransfer` 与双通道进门

> **前置依赖**：[02 —— 一条参数串怎样变成运行配置](./02-arguments-struct.md)：知道参数最终由 native `Arguments` 语义中心解释。
> → **后续**：[02-sampling-core/01 —— 信号响起的一瞬间](../02-sampling-core/01-sampling-core.md)：进入事件真正到来之后，样本如何进入记录链。
>
> 本篇基于当前 async-profiler Linux 实现。重点是 attach 控制通道与 fd 资源通道，不把它们混成一个 attach 黑箱，也不把 Linux 权限桥外推到其他平台。

## agent 已经 load 了，CPU 采样为什么还可能失败

场景：你执行 `asprof start -e cpu <pid>`，CLI 没有在 `run_fdtransfer()`、`run_jattach()` 或 load 返回码这几层直接报错；这通常说明外层编排至少没有在 attach/load 同步阶段失败。但真正进入采样时，CPU 事件仍然可能因为 perf 资源或符号文件准备失败而起不来。也就是说，**“外层命令没有在同步阶段失败”与“底层采样资源已经就绪”不是同一个成功条件。**

这正是第三篇要拆开的核心困惑。async-profiler 的进门链不是一根线，而是两条并行通道：

```text
控制通道：把命令送进 JVM
CLI
  → run_jattach()
    → jattach_hotspot/openj9
      → attach listener / .java_pid socket
        → load command
          → Agent_OnAttach / Arguments::parse()

资源通道：按需把底层 fd 送进目标进程
CLI
  → run_fdtransfer()
    → FdTransferServer::runOnce()
      → namespace 准备 + bind UDS + fork server
        → target-side FdTransferClient::connectToServer()
          → requestPerfFd / requestKallsymsFd
            → SCM_RIGHTS 传递 fd
```

第一条通道解决“目标 JVM 谁来接管这条命令”；第二条通道解决“目标进程有没有能力拿到 perf 或 kallsyms 这类底层资源”。如果把二者混成一个 attach 动作，后续排障就会变得非常模糊：你不知道失败发生在 JVM attach listener、`Agent_OnAttach`、perf fd 打开、kallsyms 访问，还是输出阶段。

*关键设计（斜体）：* *async-profiler 不是只把 agent 装进 JVM 就结束；它把“命令接管”和“资源准备”分成两条通道，再在 start/collect 的外层编排里重新汇合。* [模式: 双通道启动链]

## 先推翻四个最容易混淆的问题模型

### attach 成功就等于采样成功

这是最常见的误判。`jattach` 成功只能说明控制请求已经被目标 JVM 接住，而且 `load` 返回码没有失败；它不保证 CPU 事件一定拿到了 `perf_event_open` 所需的 fd，也不保证 `/proc/kallsyms` 一定可读，更不保证最终输出文件可写。

控制通道和资源通道正是为了解耦这两类失败：前者失败时，问题通常在 `.attach_pid`、`.java_pid` socket、身份或 `Agent_OnAttach`；后者失败时，问题通常在 perf 权限、namespace、kallsyms 访问或 fd 传递。

### `fdtransfer` 是第二次 attach 到 JVM

不是。`fdtransfer` 从来不向 JVM 发送 attach 命令，也不会唤醒 JVM attach listener。它建立的是 Unix domain socket 通道，传递的是已经打开的文件描述符。目标 JVM 使用的 profiler agent 通过 `FdTransferClient` 去请求这些 fd，但 JVM attach 协议本身完全不经过这条通道。

### Unix socket 上传的是采样结果或参数字符串

也不是。参数字符串走的是 `jattach(load)` 这条控制通道；采样结果则在输出阶段进入文件或 writer。`fdtransfer` 上传的是 `perf fd`、`/proc/kallsyms` fd 这类内核对象引用。接收方拿到的是已经打开的资源句柄，而不是采样数据正文。

### 所有动作都需要 `fdtransfer`

`status`、`dump`、`metrics` 这类动作本身不需要提前准备 perf fd。当前 CLI 只在 `collect`、`start` 和 `resume` 这些真正开始采样的路径前尝试 `run_fdtransfer()`（`src/main/main.cpp:580-606`）。如果把它写成“attach 必经第二阶段”，读者就会误以为任何一次 profiler 命令都要建立额外的 fd 资源通道。

到这里，必须先记住一个总判断：

```text
jattach / load   解决 JVM 接管命令
fdtransfer / fd  解决底层资源句柄进入目标进程
```

## 第一层：`run_jattach()` 统一的是 profiler 动作，不是所有 jattach 动作

### CLI 的两条外部分支

`src/main/main.cpp:420-426` 先把 `start`、`resume`、`stop`、`dump`、`status`、`metrics`、`list`、`collect` 识别为 profiler 动作；而 `load`、`jcmd`、`threaddump`、`dumpheap`、`inspectheap` 等则被标记成 `jattach_action`。

分支点在 `main.cpp:567-572`：一旦 `jattach_action` 为真，CLI 直接按原始动作名调用 `jattach(pid, argc, argv, 1)`；只有 profiler 自身动作才会进入后面的 `run_jattach()` 和 `run_fdtransfer()` 编排。因此不能简单写成“所有动作最后都被折叠成 load”。更准确的说法是：**async-profiler 自己那组 profiler 动作，在外部控制面上被统一成一条 `load` 通道；其他直接 jattach 动作仍然走原始命令分支。**

### `run_jattach()` 在做什么

`run_jattach()` 位于 `main.cpp:365-383`。它先 fork 出子进程，再构造：

```cpp
const char* argv[] = {"load", libpath.str(), libpath.str()[0] == '/' ? "true" : "false", cmd.str()};
exit(jattach(pid, 4, argv, 0));
```

这表明 profiler 自身动作在外层控制面被归约成：

1. attach 子命令是 `load`；
2. 载荷包含 native 库路径与“是否绝对路径”；
3. 真正的 profiler 动作如 `start`、`stop`、`dump`、`status` 继续以 `cmd.str()` 的参数串形式送入目标 JVM。

归约的好处不是“看起来统一”，而是把 JVM attach 这一层的连接、等待、返回码与日志处理复用起来。外部控制面只维护一条 profiler attach 协议，目标 JVM 内的 agent 再解释 `cmd` 里真正的 profiler 动作。

### `collect` 只是外层编排，不是新引擎

`main.cpp:580-603` 里的 `collect` 很能说明外层编排的角色：

1. 可选启动 `fdtransfer`；
2. 发送 `start,quiet,...`；
3. CLI 睡眠等待 duration；
4. 再发送 `stop,...`。

因此 `collect` 不是新的 native 采样模式，也不是新的 JVM 命令协议。它只是 CLI 帮用户把“开始采样 + 等待 + 停止导出”包成一条便利动作。底层仍然是两次 profiler `load` 请求，加上一条可能存在的资源通道。

*关键设计（斜体）：* *外层 CLI 可以组合更高层动作，但 attach 通道本身仍然只负责把 profiler 请求送进 JVM。* [模式: profiler 动作归约 + 外层编排]

## 第二层：没有完整 JDK，也能 attach，因为客户端自己实现了 attach 协议

### “不依赖 JDK”不等于“不依赖 attach”

现稿最容易被误读的一句话是“不带 JDK 也能 attach”。如果读者把它理解成“不需要 JVM attach 机制”，就会完全走偏。真实含义是：**async-profiler 没有依赖 JDK Java Attach API，但它自己实现了 attach 客户端。**

`src/jattach/jattach.c:21-55` 先读取目标进程信息，拿到目标 euid/egid 与 nspid；随后进入目标的 network、IPC 和 mount namespace；如果当前在 root 身份下，还会把自身有效用户/组切换到目标进程匹配的身份。最后根据 JVM 类型分流到 `jattach_hotspot()` 或 `jattach_openj9()`。

所以“自研 jattach”真正替代的是 JDK 侧的 Java 客户端工具，而不是 JVM attach 协议本身。

### HotSpot attach listener 是怎样被叫醒的

`src/jattach/jattach_hotspot.c:36-69` 展示了 HotSpot attach 触发链。若目标 JVM 还没有 `.java_pid` socket，`start_attach_mechanism()` 会尝试创建 `.attach_pid<nspid>` 文件：先试目标进程当前工作目录；如果文件所有权不可信，再退回 `/tmp`。创建完成后，它向目标进程发送 `SIGQUIT`，然后用逐渐增加的 sleep 周期轮询 `.java_pid` socket 是否出现。

这一步非常关键，因为它解释了“为什么一个外部 native 客户端能让 JVM 开始接收 attach 命令”：不是客户端直接注入内存，而是 HotSpot 自己在看到 `.attach_pid` 并收到 `SIGQUIT` 后，启动 attach listener。

### 真正的 load 请求如何发送

`jattach_hotspot.c:72-123` 的 `connect_socket()` 连接 `.java_pid<nspid>` Unix socket；`write_command()` 把协议版本和命令参数写入 socket。之后 `read_response()` 在 `:141-186` 读取 JVM 返回值；如果是 `load` 命令，还会继续解析 `Agent_OnAttach` 返回码，兼容 JDK 8、JDK 9+ 和 JDK 21 的不同响应形式。

因此 `jattach` 的成功并不只是“socket 连上了”。它还意味着：

- attach listener 已经启动；
- `load` 命令已经写入 JVM；
- `Agent_OnAttach` 返回值已经被当前客户端解析。

但它依然不等于 perf fd 已经准备好，更不等于 CPU 事件已经开始记录样本。那是另一条通道的职责。

*关键设计（斜体）：* *jattach 自己实现了 HotSpot attach 客户端：触发 listener、连接 `.java_pid` socket、写命令并解析 `Agent_OnAttach` 返回值；它替代的是客户端工具，不是 JVM attach 机制。* [模式: 协议自实现 + listener 唤醒]

## 第三层：为什么 `run_fdtransfer()` 返回了，服务却还没真正结束

### 为什么现稿容易把生命周期写错

CLI 里的 `run_fdtransfer()` 很容易让人误以为它会一直阻塞，直到整个 fd 传递服务结束。因为外层看上去是：fork 一个子进程，调用 `FdTransferServer::runOnce()`，父进程 `wait_for_exit()`。但关键在于 `runOnce()` 自己还会再 fork 一次。

### `runOnce()` 的真实启动过程

`src/main/fdtransferServer_linux.cpp:258-300` 先做三件准备：

1. 根据目标 PID 取 nspid；
2. 解析 Unix socket 路径；
3. 若是 abstract namespace UDS，则先进入目标 network namespace。

接着它 `bindServer()` 监听 socket，然后进入目标 PID namespace。因为 `CLONE_NEWPID` 只影响子进程，所以真正用于服务请求的进程要在 `:294-299` 再 fork：子进程执行 `acceptPeer(&nspid) && serveRequests(nspid)`，父进程立即返回 true，让调用者继续往下执行。

这意味着 `run_fdtransfer()` 在 `main.cpp:347-363` 等到的，不是“整个 fdtransfer 服务生命周期结束”，而是“服务端已经成功完成 bind、namespace 准备并 fork 出真正的服务子进程”。CLI 之所以能马上继续发送 `start`，正是因为父侧已经提前完成了启动阶段的同步屏障。

但这个同步屏障只覆盖“服务是否已经派生并进入可接收阶段”，并不保证真正服务请求的子进程后面一定成功：`acceptPeer()` 或 `serveRequests()` 仍可能在 `fdtransferServer_linux.cpp:295-299` 之后失败。所以 `run_fdtransfer()` 返回成功只能说明启动准备完成，不能说明后续连接、TID 校验或 fd 传递都已经成功。

### 为什么这样设计

如果 `run_fdtransfer()` 一直阻塞到服务结束，CLI 根本无法继续发送 `start`；但如果它完全不等待，又可能在目标 agent 试图 `connectToServer()` 之前，服务端还没 bind 好 socket。当前实现选择的是介于两者之间的启动屏障：等到服务端“已准备并已派生”，然后立刻让 CLI 继续。这样目标 JVM 中的 profiler agent 在处理 `fdtransfer=...` 时，能以较高概率立即连上那条 Unix socket。

## 第四层：fdtransfer 真正传进去的是 perf 与 kallsyms 的 fd

### 客户端闭环发生在目标进程里

`Profiler::start()` 在 `src/profiler.cpp:897-901` 看到 `args._fdtransfer` 后，才会在目标进程内调用 `FdTransferClient::connectToServer(args._fdtransfer_path)`。这点很重要：`connectToServer()` 不是 CLI 侧动作，而是 agent 已经通过 `jattach(load)` 进入 JVM、`Agent_OnAttach` 和参数解析也已经走完之后，才在目标进程上下文中建立到辅助服务端的 Unix socket 连接。

换句话说，两条通道的时间顺序不是完全并列的：CLI 先把 fdtransfer 服务端准备好，再把 `fdtransfer=...` 一并塞进 load 请求；目标 JVM 内的 profiler agent 接管命令后，才会主动回连这条资源通道。双通道是在 start/collect 这类动作里被编排到同一轮启动中，但真正汇合点发生在目标进程内的 `connectToServer()`。

`src/fdtransferClient_linux.cpp:23-47` 显示客户端创建 `SOCK_SEQPACKET` Unix socket，设置十秒接收超时，再调用 `connect()`。从这一步开始，资源通道的两端分别是：

- 已经完成 namespace/监听准备的 fdtransfer 服务子进程；
- 目标 JVM 里的 native profiler agent。

### perf fd 请求是怎样发过去的

`requestPerfFd()` 在 `fdtransferClient_linux.cpp:50-75` 构造 `perf_fd_request`：包含 TID、target CPU、`perf_event_attr` 和 probe 名称；随后用 `send()` 发送请求，再用 `recvFd()` 接收响应。响应里除了文件描述符，还有 error 与可能被重新写回的 TID。若服务端返回错误，客户端会在 `:64-69` 把响应中的 error 回填给 `errno`；也就是说，资源通道自己就带着一份最小错误协议，而不是简单地把失败吞掉。

服务端对应逻辑在 `fdtransferServer_linux.cpp:124-159`：

- 检查请求线程是否属于目标进程；
- 调用 `perf_event_open`；
- 尝试映射 perf buffer；
- 用 `sendFd()` 把 fd 经 `SCM_RIGHTS` 传回；
- 自己关闭那份 fd。

`perfEvents_linux.cpp:627-630` 则展示了消费点：如果 `FdTransferClient::hasPeer()`，`PerfEvents` 就通过 `requestPerfFd()` 拿 fd；否则直接在当前进程里调用 `perf_event_open`。这说明 fdtransfer 不是采样引擎的替代品，而是 perf 资源获取路径的替代前端。

### kallsyms 走的是同一条 fd 通道

fdtransfer 不是只服务 perf。`requestKallsymsFd()` 在 `fdtransferClient_linux.cpp:78-94` 构造 `KALLSYMS_FD` 请求；服务端在 `fdtransferServer_linux.cpp:162-185` 会把 `/proc/kallsyms` 复制到临时文件，打开后 unlink，再通过 `sendFd()` 传回。这里不能简单写成“也能传一个符号文件 fd”：服务端注释明确指出，旧内核对 `/proc/kallsyms` 的权限检查可能发生在每次 read，而不是只在 open 时做一次；因此直接把原 fd 交给目标进程并不可靠，才需要复制成临时文件后再传。消费点在 `symbols_linux.cpp:698-707`：有 peer 时走 `requestKallsymsFd()`，否则直接 `open("/proc/kallsyms")`。

这条线很关键，因为它证明 fdtransfer 解决的不是“CPU 采样专属问题”，而是“当前目标进程拿不到某些底层资源，但另一个辅助进程可以代为打开并传回句柄”的更一般机制。perf 和 kallsyms 只是两个具体消费者。

### `SCM_RIGHTS` 传的到底是什么

无论是 `requestPerfFd()` 还是 `requestKallsymsFd()`，客户端最终在 `recvFd()`（`fdtransferClient_linux.cpp:96-138`）里通过 `recvmsg()` 读取控制消息，从 `SCM_RIGHTS` 中取出新的 fd。若响应类型不匹配、控制消息里没有合法的 `SCM_RIGHTS`，或者服务端明确返回了错误，`recvFd()` 都会返回 `-1`，并让调用方继续按 `errno` 或告警路径处理。它获得的是同一个内核对象的引用，而不是“帮你把文件内容复制过来”。

所以这里的“数据通道”并不是采样样本流，更不是参数协议流。它传的是：**已经由另一侧打开好的内核资源句柄。**

*关键设计（斜体）：* *fdtransfer 把“谁能打开这个内核对象”与“谁来使用这个对象”拆开：服务端负责打开，目标进程负责消费。* [模式: 资源句柄通道 + SCM_RIGHTS]

## 第五层：namespace 与权限不是在同一处解决的

如果把 jattach 和 fdtransfer 都简单称为“高权限 attach”，仍然会混淆两者。

`jattach.c:21-55` 的 namespace 和身份切换，目的是让 attach 客户端能够按目标 JVM 的环境说话：进入 network/ipc/mnt namespace，必要时切换 euid/egid，然后连接 attach listener。它关心的是“如何与目标 JVM 的 attach 端点对话”。

`fdtransferServer_linux.cpp:277-299` 的 network/pid namespace 处理，则是为了让辅助服务端能在正确的 Unix socket 地址空间和 PID 视角下接住来自目标进程的请求。它关心的是“如何在目标进程视角里验证线程归属、接住 UDS 连接并代开资源”。这里还要再拆一层：namespace 解决的是“能否在正确视角里看见 socket 与 TID”，而 perf 或 kallsyms 访问权限解决的是“即使看见了这些对象，是否还能成功打开它们”。二者经常同时出现，但不是同一个问题。

二者都可能涉及 namespace，但解决的问题不同：

- jattach：让控制命令准确到达 JVM attach listener。
- fdtransfer：让资源请求准确到达辅助服务端，并在目标 PID 视角中校验 TID。

同样，“是否具备所需权限”也不是写死在某一端。源码只说明服务端可以代开某些资源，并在注释里指出目标应用未必具备相应权限；它没有承诺任何运行场景下服务端必然拥有这些权限。真正能否成功，仍由实际运行身份和系统配置决定。

## 收网：控制通道让 JVM 接住命令，资源通道让内核接住采样

把第三篇压缩成一句话：

```text
jattach 负责让 JVM 接住命令；
fdtransfer 负责让目标进程接住底层 fd；
start / collect 在 CLI 层把这两条通道编排到一次采样动作里。
```

换一种不看图的复述方式：控制通道先解决“JVM 听不听得见这条命令”，资源通道再解决“目标进程拿不拿得到 perf/kallsyms 这些句柄”；start/collect 只是把这两件事在同一次启动里排好顺序。即使跳过前面的总图，也要记住这个双通道判断。

因此，排障时至少要分四层看：

1. profiler 动作是否走进了 `run_jattach()`，还是其实是直接 jattach 动作；
2. HotSpot attach listener 是否被正确唤醒并接收了 `load`；
3. fdtransfer 服务端是否真的完成了 socket 与 namespace 的启动准备；
4. 目标 JVM 内的 profiler agent 是否连上服务端，并成功拿到 perf/kallsyms fd。

本篇的一句话困惑是：**为什么 agent 已经 load 成功，CPU 采样仍然可能因为底层资源问题失败？**

本篇的一句话顿悟是：**async-profiler 把“命令进入 JVM”与“底层 fd 进入目标进程”拆成两条通道：前者由 jattach 实现 attach 协议，后者由 fdtransfer 通过 `SCM_RIGHTS` 传递资源句柄；只有两条链在 start/collect 时都就绪，CPU 采样才真正有机会启动。**

*关键设计（斜体）：* *不要把 attach、权限、namespace 和 perf 资源压成一个“能不能连上”的问题；async-profiler 当前实现明确把它们拆成了控制通道与资源通道。* [模式: 控制接管 + 资源接管]

[跨层标注：`jattach`/HotSpot attach listener——JVM 控制通道；Unix domain socket/`SCM_RIGHTS`——内核资源句柄通道；PID/network/mount namespace——两条通道各自的环境对齐；`PerfEvents`/`Symbols`——fd 消费方；`Arguments`/`Agent_OnAttach`——命令进入目标 JVM 后的语义接管]

## 下一篇：事件真正到来时，样本如何进入记录链

到这里，目标 JVM 已经能接住命令，必要时也能拿到底层资源。下一篇进入真正的采样核心：

- 信号或事件回调怎样进入 `recordSample()`；
- `RateLimit`、`tryLock` 和错误帧为什么要先保护采样器自己；
- Java 栈、native 栈和事件帧怎样被拼成一条样本。

**→ 下一篇：[信号响起的一瞬间](../02-sampling-core/01-sampling-core.md)。**
