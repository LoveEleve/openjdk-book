# 25-agent-diagnostic/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 Attach API，重点覆盖 `VirtualMachine`、`AttachProvider` SPI、Linux `VirtualMachineImpl`、`HotSpotVirtualMachine.execute`。本文聚焦“工具进程如何连上目标 JVM 并发命令”；Instrumentation 与字节码增强放到下一篇。
> 目标：把“Attach 机制”改写成一篇围绕“诊断工具不是凭空进入另一个 JVM，而是先通过 Attach API 打开一条跨进程管理通道；真正关键的问题不是 Java 对象调用，而是目标 JVM 怎样暴露一条平台相关、可握手、可发命令、可回流结果的控制连接”展开的机制文章。

## 1. 读者困惑

- `jstack`、`jcmd`、Arthas 这类工具到底是怎样和另一个 JVM 说上话的？
- 为什么 `VirtualMachine.attach(pid)` 不是简单的本地方法调用，而要走 provider SPI？
- Linux 上 `.java_pid<pid>` 套接字到底扮演什么角色，为什么还会用信号触发 listener？
- Attach 通道建立之后，命令是怎样发过去、结果又怎样回来的？
- 为什么 Attach 先解决的是“进程间管理通道”，而不是一上来就讲字节码增强？

## 2. 一句话顿悟

**Attach API 真正解决的不是“调用某个调试接口”，而是“让一个工具进程先连上另一个正在运行的 JVM”。`VirtualMachine` 只是跨平台门面，`AttachProvider` 负责选择平台实现；在 Linux 上，这条连接会落成 `/tmp/.java_pid<pid>` 这一类 Unix domain socket，并通过一个极简的命令-响应协议把 thread dump、jcmd 命令、agent 加载等操作都统一进同一条跨进程管理通道。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 `VirtualMachine.attach`、`AttachProvider` SPI、Linux `.java_pid` 套接字、`HotSpotVirtualMachine.execute` 这些关键落点。
- 已把 agent 加载放回 Attach 命令体系，而不是孤立知识点。
- 已点出 `/tmp` 权限、身份与容器环境故障，这是生产上很实用的边界。

### 必须重写

- 旧稿偏卡片式流程，需要先立住总问题：工具如何“进入”另一个 JVM。
- SPI、平台实现、套接字协议、execute/RPC 要放到同一条“打开管理通道”主线上统一讲。
- Linux 信号触发 attach listener 要讲成“目标 JVM 尚未监听时，工具先促使它把通道打开”，而不是只列实现细节。
- 完整链路要从“进程连接”角度收网，并自然引到 Instrumentation。

## 4. 理解路径

### 第一节：从“诊断工具怎么连到另一个 JVM”开场

用 jstack/jcmd/Arthas 这类最常见工具开场。先立住总问题：它们首先不是“拿到某个 Java 引用”，而是跨进程建立控制通道。

### 第二节：`VirtualMachine.attach` 为什么只是门面，而不是实际连接实现

证据：
- `VirtualMachine.java:99`：类定义
- `VirtualMachine.java:194/246`：`attach`
- 旧稿中的 `AttachProvider.java:247` 线索

主线：
- `VirtualMachine.attach` 先从 provider 列表里找平台实现。
- 这说明 Attach 天生就是平台 SPI，不可能只靠一套纯 Java 通用连接逻辑。
- 工具代码因此面对统一门面，平台差异藏在 provider 后面。

### 第三节：Linux 为什么会落成 `.java_pid<pid>` 套接字

证据：
- `VirtualMachineImpl.java:50`
- 旧稿中的 `findSocketFile`、`PROTOCOL_VERSION = "1"`、`writeString` 线索

主线：
- 平台实现先找目标 JVM 对应的 socket 文件。
- 如果目标还没监听，工具会触发它打开 Attach listener。
- 找到 socket 后，真正的跨进程通道才建立起来。

### 第四节：为什么要先握手版本，再发命令和参数

证据：
- 旧稿中的 `PROTOCOL_VERSION = "1"`
- `writeString(s, PROTOCOL_VERSION/cmd)` 线索
- `HotSpotVirtualMachine.java:301`

主线：
- Attach 通道不是“连上就直接调方法”，而是显式协议：版本、命令、参数、响应。
- 这让 thread dump、属性读取、agent 加载都能共享同一条命令通道。

### 第五节：为什么 `execute` 本质上是一条极简 RPC

证据：
- `HotSpotVirtualMachine.execute(String, Object...)`：`301`
- `loadAgentLibrary` / `execute("load", ...)` 的旧稿线索

主线：
- 工具侧写入命令与参数，目标 JVM 侧执行，再把结果通过流回传。
- Attach 的本体不是诊断逻辑本身，而是承载诊断逻辑的 RPC 通道。
- agent 加载因此只是 Attach 上的一种命令，不是另一套完全不同机制。

### 第六节：完整链路为什么必须先 Attach，再 Instrumentation

主线：
- 先建立进程间控制通道，才能谈后续的 agent 注入、类转换和诊断命令。
- 这解释了为何本篇先讲连接机制，下一篇才讲 Instrumentation。

## 5. 失败方案清单

1. 把 Attach 理解成 JVM 内部对象之间的普通方法调用。
2. 以为 `VirtualMachine.attach` 本身就包含所有平台连接细节。
3. 忽略 `.java_pid<pid>` / 套接字监听状态，只在 Java 代码层找失败原因。
4. 把 agent 加载当成完全独立机制，不看它本质上也是 Attach 命令。
5. 诊断失败时只看目标 JVM，不检查 `/tmp`、权限、用户与容器隔离。

## 6. 误解清单

1. Attach API 就是为了加载 agent，其他工具只是顺便复用。
2. 只要知道 PID，工具就能直接操作 JVM 内部状态。
3. Attach 是纯 Java 协议，不依赖平台特定实现。
4. 连接建立后工具和 JVM 之间是在共享内存里直接交互。
5. Attach 成功就自动意味着 Instrumentation 一定可用。

## 7. 证据清单

- `VirtualMachine.java:99/194/246/507/535`
- `AttachProvider.java:247`（沿旧稿线索）
- `VirtualMachineImpl.java:50` 及旧稿中的 `findSocketFile` / `PROTOCOL_VERSION` / `writeString` 线索
- `HotSpotVirtualMachine.java:301/86/94`（沿旧稿线索）

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 Attach 通道建立与命令协议，不展开 Instrumentation transformer 细节。
- Linux 平台实现作为主证据；其他平台只保留 SPI 差异这一层结论。
- 不扩展到 native attach listener 的完整 C/C++ 细节。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么诊断工具要先建立跨进程管理通道 → `VirtualMachine.attach` 如何通过 provider 找平台实现 → Linux 上怎样落成 `.java_pid<pid>` 套接字 → 通道建立后怎样用命令/响应协议交互 → 为什么 agent 加载也只是 Attach 上的一种命令”。
- 必须把 Attach 讲成‘管理通道建立机制’，而不是 API 列表。
- 必须自然引到 `02-instrumentation.md`。
