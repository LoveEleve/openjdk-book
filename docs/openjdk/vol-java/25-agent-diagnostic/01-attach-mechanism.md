# 01. Attach 机制 — 进程连接、套接字协议、SPI 架构

> **前置依赖**: [07-classloader/01 — 双亲委派](../07-classloader/01-delegation-model.md)(SPI 类加载)、[17-io-streams/01 — 字节流](../17-io-streams/01-byte-streams.md)(命令响应流)
> → **后续**: [02-instrumentation.md](02-instrumentation.md)
> 关联: 内部卷 36-attach(native attach listener)

## 工具怎么连到运行中的 JVM

`jstack`、`jcmd`、Arthas 等工具首先要解决一个问题: **从另一个进程进入目标 JVM 的管理通道**。JDK Attach API 就是这条入口。

## 1. "Attach 是什么?" — 跨进程连接

### 1.1 VirtualMachine 门面

`VirtualMachine.attach(String)`(`VirtualMachine.java:194`)的流程是:

1. 获取 `AttachProvider.providers()`(`AttachProvider.java:247`)
2. 按顺序尝试每个 provider 的 `attachVirtualMachine(id)`
3. 第一个成功的 provider 返回对应 `VirtualMachine`
4. 全部失败则抛出 attach 相关异常

`AttachProvider` 是平台 SPI: provider 提供名称、类型和实际连接实现。

关键设计(斜体):*"Attach = 工具进程连接目标 JVM"——VirtualMachine 只定义跨平台门面,真正的连接细节由 SPI provider 决定。面试"Attach 是什么": 进程间管理通道,不是普通 Java 对象引用。*

## 2. "Linux 的套接字实现" — `.java_pid`

### 2.1 触发与路径

Linux 实现 `VirtualMachineImpl`(`jdk.attach/linux/classes/sun/tools/attach/VirtualMachineImpl.java:50`)保存 `socket_path`。

- `findSocketFile`(`:73`附近)寻找 `/tmp/.java_pid<pid>`
- 如果目标尚未监听,实现通过发送 `QUIT` 信号触发目标 JVM 启动 Attach 机制(`:71`)
- 找到套接字后,连接 Unix domain socket

### 2.2 握手与命令

协议版本常量是 `PROTOCOL_VERSION = "1"`(`:137`),发送时按顺序写入:

- 协议版本 `writeString(s, PROTOCOL_VERSION)`(`:172`)
- 命令名 `writeString(s, cmd)`(`:173`)
- 命令参数(带长度前缀)

关键设计(斜体):*"Attach = /tmp 套接字 + 文本字段协议"——先握手版本,再传命令与参数。生产常见故障包括 `/tmp` 权限、用户身份和容器挂载隔离。*

## 3. "命令协议" — HotSpotVirtualMachine

### 3.1 execute 抽象

`HotSpotVirtualMachine.execute(String, Object...)`(`HotSpotVirtualMachine.java:301`)定义命令执行抽象: 工具写入命令名与参数,拿到一个响应 `InputStream`。

`loadAgentLibrary`(`:86`)最终会调用 `execute("load", ...)`(`:94`),所以 agent 加载也是 Attach 命令的一种。

### 3.2 Attach 是 RPC 通道

命令名 + 参数 + 响应流构成了一个极简 RPC。线程 dump、类/堆诊断、agent 加载等工具操作都建立在这条通道上。

关键设计(斜体):*"execute 协议 = Attach 通道上的 RPC"——协议只约定命令与响应,具体能力由目标 JVM 的 Attach listener 实现。面试"Attach 后怎么交互": execute 命令,读取响应流。*

## 4. "完整链路" — 工具到 JVM

一个诊断命令的抽象时序:

1. 工具解析目标 PID
2. `VirtualMachine.attach(pid)` 通过 provider 找到平台实现
3. 平台实现找到/触发 Attach socket,完成握手
4. 工具执行命令并读取响应流
5. 断开连接,把结果转换为终端输出

## 核心悬念

Attach 通道通了——**加载 agent 后干什么**?`Instrumentation` 的 transformer、retransform 已加载类、APM/Arthas 字节码增强——下一篇: Instrumentation 与字节码增强。