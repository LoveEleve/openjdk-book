# 01. 不能重启 JVM 时，采样器怎样进门 —— CLI、attach 与权限桥

> **前置依赖**：知道 async-profiler 是运行在 JVM 外部与 JVM 内部 native agent 协作的采样器；不要求先了解 JVMTI 或 perf 的细节。
> → **后续**：[事件、格式与参数结构](./02-arguments-struct.md)：进入 agent 之后，逗号协议怎样变成 `Arguments` 配置快照。
>
> 本篇基于当前 async-profiler 源码，重点讨论 Linux 下的 CLI 进门链。这里的“当前实现”不能外推为所有平台、所有 JVM 或所有 profiler 工具的统一行为。

## 线上不能重启，第一件事不是采样而是进门

场景：线上 JVM 正在处理请求，CPU 已经持续升高，但重启服务会丢失现场，甚至会扩大故障。你执行 `asprof start -e cpu <pid>`，表面上只是在命令行里输入一个采样命令，实际上却要先解决一个更基础的问题：**一个原本运行在 JVM 外部的 profiler，怎样把自己的 agent 交付给已经运行的目标 JVM？**

如果把这一步跳过去，后面的 CPU、alloc、lock 和 wall-clock 都无从谈起。采样器不能凭空读取另一个进程的 Java 栈，也不能因为 CLI 进程知道目标 PID，就直接访问目标 JVM 内部对象。它必须先通过 JVM 的动态 attach 通道，把 native agent 装进目标进程；agent 在目标进程内建立 JVM 集成之后，才有机会启动事件引擎。

因此，本篇先不解释一次样本怎样走过 `recordSample()`，也不解释火焰图怎样绘制。先把“进门”这件事拆开：

```text
外部命令
  → CLI 控制面识别动作和选项
    → 组装 agent 请求
      → jattach 向目标 JVM 发起 load
        → agent 在目标进程内接收请求
          → 参数解析与 profiler 初始化
            → 事件引擎开始产生样本
```

这张图里最容易被忽略的是最后三步。`jattach` 成功，说明 attach 客户端已经完成连接、发送 load 请求，并通过 HotSpot 的响应解析拿到了成功结果；它仍不等于事件引擎已经产生样本、样本已经存储或输出文件已经写完。HotSpot 的 load 响应还要经过 `jattach_hotspot.c:141-163` 的 `Agent_OnAttach` 返回码解析，JDK 21 还可能出现命令返回 0、正文携带错误信息的情况。后面所有故障定位，都要保留这些阶段的边界。

*关键设计（斜体）：* *async-profiler 把“把 agent 送进 JVM”和“agent 进入后如何采样”拆成两个阶段。外部 CLI 负责控制面，目标 JVM 内的 native agent 才负责采样内核。* [模式: 两阶段启动链]

## 先推演三个看似简单、实际不成立的办法

### 直接在 CLI 进程里开始采样

最直觉的想法是：CLI 已经拿到了 PID，直接在自己的进程里创建采样线程，读取目标进程的栈，然后把结果写出来。这个办法把“知道目标是谁”误当成了“拥有目标 JVM 的运行时上下文”。

目标进程的 Java 栈、线程状态和 HotSpot 内部结构属于目标 JVM。一个独立的 CLI 进程即使能够通过操作系统看到目标 PID，也没有目标 JVM 内部的 `JNIEnv`、JVMTI 环境和 profiler 全局状态。它可以发送控制请求，却不能替代已经加载到目标 JVM 中的 agent。

所以 CLI 的合理职责不是承担采样，而是完成控制面工作：识别动作、找到目标 PID、确定 native 库路径、组装请求，再把请求交给 attach 通道。真正的采样对象和采样上下文必须在目标 JVM 一侧建立。

### 为 `start`、`stop`、`dump` 各造一条 attach 链

第二个想法是：`start` 有一套连接代码，`stop` 再写一套，`dump` 和 `status` 继续复制。这样每个动作看起来更直接，却会把最容易出错的部分复制很多遍：目标进程连接、身份切换、namespace 处理、错误码回传、日志读取和临时文件清理都要反复实现。

当前实现对 profiler 自身的动作选择了另一条路。CLI 先识别动作，但在非 `jattach_action` 分支中，真正交付给目标 JVM 时，把 profiler 相关动作统一放进 `load` 请求。不同动作的差异作为命令载荷传入 agent，而不是在外部为每个 profiler 动作维护一条完全独立的 attach 协议；`load`、`jcmd`、`threaddump` 等直接 jattach 动作仍由 `main.cpp:567-572` 单独调用 `jattach()`。

这并不意味着所有动作都变成了同一个语义。`start` 仍然是启动，`stop` 仍然是停止，差异只是被移动到目标 agent 接收请求之后解释。外部连接和交付机制复用，内部动作语义保留。

### 让目标进程自己申请所有 perf 资源

第三个想法是：既然 agent 已经进了目标 JVM，就让它自己调用 `perf_event_open()`，自己映射 perf ring buffer。这个办法在权限宽松的环境里可能工作，但在容器、受限宿主机或不同用户身份下，目标应用不一定具备创建 perf 事件和映射缓冲区所需的权限。

async-profiler 的 Linux 实现为这个边界提供了按需的 `fdtransfer` 桥：一个辅助服务端代替目标 agent 完成特定的低层资源申请，再通过 Unix socket 的 `SCM_RIGHTS` 把文件描述符传回去。它不是第二次 attach，也不是所有事件都必须经过的路径，而是把资源申请放到另一个进程中；这个进程是否具备目标环境所需权限，仍取决于实际运行身份和系统配置。

到这里，三个失败方案共同指向一个结论：

```text
CLI 不承担目标 JVM 内采样
动作不复制 attach 协议
目标 agent 不必独自承担所有低层权限
```

## 第一层：`main()` 是控制面，不是采样引擎

读者此时可能会问：既然 CLI 不采样，那它到底做了多少工作？答案要从真实入口看，而不是从脚本名称猜。

async-profiler 的 CLI 入口在 `src/main/main.cpp` 的 `main()`。当前实现先创建 `Args`，然后循环读取命令行参数。在 `main.cpp:415-426`，它识别 `start`、`resume`、`stop`、`dump`、`status`、`metrics`、`list`、`collect` 等 profiler 动作；`load`、`jcmd`、`threaddump` 等则标记为更直接的 jattach 动作。

这一步建立的是控制面状态：当前请求想做什么、目标 JVM 是谁、是否需要直接调用 jattach。它还没有触碰 `Profiler::recordSample()`，也没有生成任何调用栈样本。

随后，CLI 对若干选项做有限的预处理。在 `main.cpp:436-458`，`-d` 和 `-f` 分别保存 duration 与输出文件，`-o` 保存输出类型，`-e` 处理事件名。事件名通常被拼入 `params`；如果是带逗号的 PMU 事件，CLI 会把逗号替换成冒号后再交付；如果是 tracepoint，则尝试先解析成数值 ID，再拼成 `event:数字`。

这里的“预处理”要准确理解。CLI 负责把命令行短选项变成 agent 请求可以接收的片段，但并没有因此成为所有参数语义的最终权威。例如 `--alloc`、`--wall`、`--cstack`、`--memlimit` 等参数在 `main.cpp:511-528` 被拼入 `params`；`--fdtransfer` 则创建一个 Unix socket 名称，并把 `fdtransfer=...` 一并放入请求（`main.cpp:535-542`）。真正的字段、默认值、单位与互斥关系，仍由目标 agent 内的 `Arguments::parse()` 解释。

> 这里先记住一个路标：`main()` 只回答“用户想把什么请求送到哪个目标”，不回答“目标 JVM 怎样完成一次采样”。从这一节开始，代码证据只用来证明控制面行为，不要把它当成采样主线。

`main.cpp:544-554` 还处理目标识别：纯数字参数作为 PID，`jps` 触发进程查询，最后一个非选项参数可以作为应用名交给 `jps` 查询。这说明 CLI 还承担了目标发现，但目标发现依旧只是进门前的准备，不是 JVM 集成。

*关键设计（斜体）：* *外部入口只把人类命令转换成结构化请求；它不把目标 JVM 的运行时责任搬到 CLI 进程。* [模式: 控制面与数据面分离]

## 第二层：`run_jattach()` 把请求交给目标 JVM

### 从字符串到 `load` 请求

CLI 已经确定了目标 PID、动作和参数，下一步是把请求真正送出去。这里需要区分两个角色：`run_jattach()` 是 async-profiler CLI 里的外部编排函数，`jattach()` 是负责向目标 JVM 发起动态 attach 的底层函数。两者不能写成同一个“agent 入口”。

`run_jattach()` 位于 `src/main/main.cpp:365-383`。它先 `fork()`，子进程构造四个参数：

```cpp
const char* argv[] = {"load", libpath.str(), libpath.str()[0] == '/' ? "true" : "false", cmd.str()};
exit(jattach(pid, 4, argv, 0));
```

这段代码只证明一件事：对 profiler 动作，外部 CLI 把请求归约为一次 `load`，并把 native 库路径、路径属性和命令载荷交给 `jattach`。它没有证明 agent 已经初始化，也没有证明采样已经开始。

父进程通过 `wait_for_exit()` 等待子进程完成；如果返回非零状态，就读取日志文件并退出；成功时也会把日志或临时输出文件回传给调用者（`main.cpp:375-383`）。因此外部层不仅负责发请求，还负责把目标侧执行结果转回 CLI 用户。

为什么要把 profiler 动作统一放进 `load`？从当前结构可以观察到，attach 的共性在于“把 agent 和命令载荷送到目标 JVM”，而不是动作名字本身。`start`、`stop`、`dump` 和 `status` 的差异都可以作为 `cmd` 的第一段传给 agent。这样外部层复用一条 profiler attach/load 的连接与错误处理路径，目标 agent 再依据命令选择启动、停止、导出或查询动作；这只是当前实现呈现出的结构效果，不把它扩大解释成未经源码证明的作者意图。

### `collect` 与 `start/stop` 的外部编排

`main.cpp:580-606` 把一次性采集和显式动作分成两种外部工作流。`collect` 先启动 fdtransfer（如果启用），再用 `start,quiet,...` 发送启动请求；CLI 等待 duration 到期或收到终止信号，最后发送 `stop,...`。显式 `start` 与 `resume` 也会在发送请求前启动 fdtransfer；其他 profiler 动作则通过 `run_jattach()` 交付。`load`、`jcmd`、`threaddump` 等被标记为 `jattach_action` 的动作不经过这个分支，而是在 `main.cpp:567-572` 直接调用 `jattach()`。

这段编排解释了一个常见现象：`asprof collect -d 30` 看起来像 CLI 自己“采了 30 秒”，其实 CLI 主要负责计时和发送开始/停止两个控制请求。样本产生在目标 JVM 内；CLI 只是等待窗口结束并再次发出停止命令。

而 `jattach.c:21-55` 进一步说明了 attach 的系统边界。`jattach()` 先读取目标进程信息，取得目标用户、组和 namespace 信息；对容器目标，它会切换到目标的 network、IPC 和 mount namespace；对 HotSpot 动态 attach，它还会把自身有效用户和组切换到目标进程身份。最后根据目标是否为 OpenJ9，分流到 `jattach_openj9()` 或 `jattach_hotspot()`。HotSpot 分支在 `jattach_hotspot.c:189-214` 中必要时先启动 Attach listener，再连接 `.java_pid` Unix socket、写入命令并读取响应；`jattach_hotspot.c:141-163` 对 `load` 响应继续解析 `Agent_OnAttach` 返回码。因此这里的“请求送达”包含了 attach 协议和 agent 返回结果，但仍不等于后续事件引擎已经开始产生样本。

这条链说明“attach”不是普通 TCP 连接。它包含目标进程身份、namespace 和 JVM 实现差异。也因此，`run_jattach()` 返回失败时，故障可能发生在目标不存在、身份不匹配、namespace 处理、HotSpot attach 通道、agent load 或 `Agent_OnAttach` 返回错误，而不是简单的“采样算法错误”。

> 路标：到这里为止只完成了“请求送达”问题。下一层要回答的是：请求交给谁解释？答案不是 `main()`，而是目标 JVM 里已经被加载的 native agent。

## 第三层：请求送达后，native 才接管参数语义

attach 通道的任务是把库和命令送进目标 JVM；HotSpot 的 load 请求最终由目标 JVM 调用 `Agent_OnAttach()`（入口位于 `src/vmEntry.cpp:489`），agent 内部再把命令交给 native 运行时。命令字符串的最终解释发生在 `Arguments::parse()`：`src/arguments.cpp:41-60` 会复制可修改的参数串，用逗号切段，再按 `=` 分割 key/value，随后进入 CASE 表。`arguments.cpp:62-285` 负责把动作、事件、输出和运行参数映射到 `Arguments` 字段。本篇只点出 `Agent_OnAttach()` 作为交付终点，不展开它的 JVMTI 初始化细节。

这形成了两层协议：

```text
main.cpp
  → 把 --event cpu、--output html 等 CLI 写法拼成请求片段
    → agent 接收请求
      → Arguments::parse()
        → native 运行时配置
```

为什么不让 CLI 直接拥有完整参数语义？因为 async-profiler 不只有 CLI。Java API、C API 和目标 JVM 内的 agent 都需要进入同一套 native 配置模型。如果每个入口各自解释事件、输出、单位和默认值，三套语义迟早会漂移。

C API 是这个边界的反例证明。`src/asprof.cpp:26-52` 的 `asprof_execute()` 不经过 `main()` 和 `jattach()`：它直接构造 `Arguments`，调用 `args.parse(command)`，再执行 `Profiler::instance()->runInternal(args, out)`。这条路径绕过了外部 attach，但没有绕过 native 语义中心。

因此应当把两个结论同时记住：

- CLI 入口需要 attach，因为它要控制另一个已经运行的 JVM。
- C API 可以直接进入 native profiler，因为调用者已经处在能够使用该 native 库的进程上下文中。

入口可以不同，内核仍然可以相同。后续的参数结构篇会继续说明 `Arguments` 如何保存枚举、阈值、单位和输出设置；本篇只需要确认：**attach 负责交付，请求进入 native 后才负责解释。**

*关键设计（斜体）：* *把“请求传输协议”和“参数语义协议”分开：前者解决如何进 JVM，后者解决进入后如何得到一致配置。* [模式: 传输层与语义层分离]

## 第四层：`fdtransfer` 把 Linux 特权动作隔离出去

### 为什么 attach 进来了，perf 仍可能失败

即使 agent 已经进入目标 JVM，CPU 事件还可能卡在更底层：目标进程是否有权限创建 perf event。async-profiler 的使用者常把“attach 权限”和“perf 权限”混成一件事，但源码把它们分开了。`jattach` 解决的是把请求送到 JVM；`fdtransfer` 解决的是特定 Linux 资源申请的权限边界。

CLI 在 `main.cpp:538-542` 看到 `--fdtransfer` 后，会生成类似 `@asprof-...` 的 Unix socket 地址，并把地址作为 `fdtransfer=...` 放入 native 参数。`run_fdtransfer()` 在 `main.cpp:347-363` 中另起子进程运行 `FdTransferServer::runOnce()`；`runOnce()` 又在 `fdtransferServer_linux.cpp:294-300` 中 fork，让父侧立即返回、子侧继续接收请求，因此 CLI 等待到的是服务端完成启动准备，而不是整个 fdtransfer 服务生命周期结束。这个服务端与 attach 是两条并行的准备链：一个为 agent 交付请求，一个为 agent 预备可申请低层资源的辅助端点。

### 服务端先验证“谁在请求”

`FdTransferServer::bindServer()` 在 `fdtransferServer_linux.cpp:31-61` 创建 Unix `SOCK_SEQPACKET` socket、绑定地址并监听。`acceptPeer()` 在 `:63-89` 接收连接后，通过 `SO_PEERCRED` 获取对端 PID；如果调用方已经指定了预期 PID，就拒绝不匹配的连接，否则记录实际对端 PID。

这不是多余的安全装饰。一个能代替别人调用 `perf_event_open()` 的辅助进程，必须先确认请求来自预期目标，否则权限桥会把特权能力暴露给任意连接者。

### perf 请求怎样往返

目标 agent 建立 fdtransfer 客户端连接时，`FdTransferClient::connectToServer()`（`src/fdtransferClient_linux.cpp:23-47`）创建 Unix `SOCK_SEQPACKET` socket，设置十秒接收超时，再连接服务端。真正申请 perf fd 时，`requestPerfFd()` 在 `:50-75` 填写线程 ID、目标 CPU、`perf_event_attr` 和 probe 名称，通过 `send()` 发送请求，再用 `recvFd()` 接收响应。

服务端在 `fdtransferServer_linux.cpp:91-113` 循环接收请求。遇到 `PERF_FD` 后，先在 `:124-132` 检查请求线程是否属于目标进程：如果 `peer_pid == 0`，允许所有请求；否则通过 `tgkill(peer_pid, request->tid, 0)` 检查该 TID 是否仍属于目标 PID。检查通过后，服务端调用裸 `perf_event_open`（`:126-128`）。

接下来是权限桥最关键的细节。服务端在 `:134-151` 尝试映射 perf buffer：注释说明，映射 perf fd 可能需要目标应用没有的权限，而辅助服务端可能具备这些权限；如果页面已经映射，目标 agent 再映射时可以复用相同物理页。当前代码忽略 `mmap()` 的返回错误，仍把映射结果保存到环形数组，并继续在 `:153-159` 填响应、通过 `sendFd()` 返回 fd；因此 mmap 失败不是在这里转换成清晰错误，而可能留到目标 profiler 后续再次映射或使用时暴露。服务端最后关闭自己的 fd。

客户端的 `recvFd()`（`fdtransferClient_linux.cpp:96-138`）通过 `recvmsg()` 接收响应，检查响应类型和错误码，并从 `SCM_RIGHTS` 控制消息中取出新的文件描述符。也就是说，fdtransfer 不是把 perf 数据复制成一段普通消息，而是把可操作的内核文件描述符交给 agent。

### 这条路径的边界

`Profiler::runInternal()` 在 `profiler.cpp:897-901` 看到 `args._fdtransfer` 后，才调用 `FdTransferClient::connectToServer()`；连接失败会返回 `Failed to initialize FdTransferClient`。这证明 fdtransfer 是由参数开关控制的可选路径，不是每次 attach 的隐藏必经步骤。

同样，`fdtransferServer_linux.cpp` 只能证明当前 Linux 服务端的行为，不能外推为 macOS 或其他平台的实现。它也不能证明所有事件都需要 perf fd：alloc、lock、wall 等事件拥有各自的前端路径；fdtransfer 主要服务于需要这些低层资源的场景。

服务端还处理 `KALLSYMS_FD`（`fdtransferServer_linux.cpp:162-179`）：因为旧版 Linux 对 `/proc/kallsyms` 的权限检查可能发生在每次读取时，代码选择把文件复制到临时路径，打开副本后立即 unlink，再把 fd 传出去。这个细节说明权限桥不仅服务于 perf，也可服务于某些符号解析所需的文件访问；但它仍然是 Linux 辅助路径，不应写成 profiler 的通用启动步骤。

*关键设计（斜体）：* *fdtransfer 不改变 profiler 的采样语义，只把“需要特权的资源申请”从受限目标进程旁路到受控辅助进程。* [模式: 最小权限桥 + 文件描述符传递]

## 第五层：多入口共享内核，但不共享进门方式

现在可以重新看 CLI、C API 和 Java API 的关系。

CLI 适合控制一个已经运行的目标 JVM：它需要目标 PID，需要 `jattach`，必要时还需要 namespace 和身份处理。它的链路是：

```text
外部 CLI
  → jattach load
    → 目标 JVM 内 agent
      → Arguments / Profiler / Engine
```

C API 适合调用者已经能够加载 async-profiler native 库的场景。`asprof_execute()` 直接解析命令并调用 `runInternal()`，没有“进入另一个 JVM”这一步：

```text
C 调用者
  → Arguments::parse()
    → Profiler::runInternal()
```

Java API 则是另一层桥接：`src/javaApi.cpp:56-116` 中的 JNI 方法把命令或强类型选项解析成 `Arguments`，再调用 `Profiler::instance()->runInternal()`；它可以运行在目标 JVM 内，却不因此改变 native 采样后端的职责。Java API 的详细加载、注册和 helper 关系留给 AP-6，本篇只用它说明一个边界：**入口方式可以不同，至少 CLI、C API 和 Java JNI 入口会在 native `Profiler` 运行路径汇合；call trace storage 和各类输出后端的完整共享关系留给后文展开。**

错误的理解是：“既然 C API 不需要 attach，那 CLI attach 只是多余包装。”这忽略了调用上下文。C API 调用者已经在拥有目标运行时的进程中；CLI 则位于另一个进程，必须先把 agent 送入目标 JVM。attach 不是 profiler 算法的组成部分，却是跨进程使用 profiler 的必要前提。

## 收网：把一次 `asprof` 命令拆成六个可诊断阶段

到这里，可以把“采样器进门”收成一张排障图：

```text
1. 目标发现
   main.cpp：PID / jps / 应用名
      ↓
2. 控制面解析
   动作、事件、输出和参数片段
      ↓
3. attach/load 交付
   run_jattach → jattach → HotSpot/OpenJ9 attach
      ↓
4. agent 接收与 native 解析
   Arguments::parse → Profiler 初始化
      ↓
5. 事件引擎与资源准备
   必要时 FdTransferClient → perf fd / kallsyms fd
      ↓
6. 样本记录与输出
   engine → recordSample 等记录链 → writer / recorder
```

这六步不是一个整体成功条件。可以分别出现：

- PID 找错或目标不存在：还没有开始 attach。
- jattach 无法启动或连接 Attach listener：请求没有进入目标 JVM，先查身份、namespace 和目标 JVM attach 状态。
- attach 已连接但 `Agent_OnAttach` 返回错误：load 请求已经抵达目标 JVM，但 agent 初始化没有成功。
- agent 已加载但参数解析失败：进门成功，配置不成功。
- fdtransfer 连接失败或 perf 资源申请失败：agent 已经进来，但某个低层能力不可用。
- engine 启动成功但输出失败：采样可能发生了，结果交付仍然失败。
- `collect` 等待结束后 stop 失败：采样窗口已经存在，但收尾和文件输出不完整。

本篇的一句话困惑是：**不能重启目标 JVM 时，async-profiler 怎样把一个外部命令变成目标进程内可运行的采样器？**

本篇的一句话顿悟是：**CLI 先识别并组装请求，`run_jattach()` 统一把 profiler 动作交给 JVM attach 的 `load` 通道；agent 进入目标 JVM 后才解析参数、启动引擎，Linux 下再按需通过 `fdtransfer` 获取受限的 perf 或文件描述符能力。**

*关键设计（斜体）：* *进门、解析、资源准备、采样和输出必须分层诊断；把它们混成“命令成功”会让线上故障定位失真。* [模式: 分阶段交付 + 共享 native 内核]

[跨层标注：C++ `main.cpp`/`run_jattach`——外部控制面；JVM Attach——跨进程 agent 交付；Linux Unix socket/`SCM_RIGHTS`——权限与 fd 桥；perf_events——低层采样资源；C++ `Arguments`/`Profiler`——native 语义与记录内核；Java/C API——同一 native 内核的其他入口]

## 下一篇：参数为什么最终落在 `Arguments`

进门链已经清楚，下一篇继续追踪请求进入 agent 之后发生的变化：

- `start,event=cpu,file=...,timeout=30s` 怎样被拆成 key/value；
- `Arguments` 为什么要用枚举、位标志和显式默认值承载配置；
- `timeout`、单位和输出格式怎样在 native 侧归一化；
- 为什么后续 engine、writer 和 recorder 只读取配置快照，而不再重复解释原始字符串。

**→ 下一篇：[事件、格式与参数结构](./02-arguments-struct.md)。**
