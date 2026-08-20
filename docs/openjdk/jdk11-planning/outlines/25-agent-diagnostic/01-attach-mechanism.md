# 01. Attach 机制 — 进程连接、套接字协议、SPI 架构

> 🔴 Deep | 域 25 Agent 与诊断第 1 篇 | Layer 5
> 读者处境: 面试"Arthas 怎么 attach 到 JVM"——套接字文件与协议,诊断工具的地基。

### 1. "attach 是什么？" — 跨进程连接

场景: jstack/Arthas 怎么连到运行中的 JVM?

- `VirtualMachine.attach(id)`(`jdk.attach VirtualMachine.java:194`)— 连接目标 JVM
- 流程(194-212): 校验 id → `AttachProvider.providers()`(域 07 SPI 加载)→ 逐个 `attachVirtualMachine(id)` 尝试
- `AttachProvider`(spi 包): `name()/type()/attachVirtualMachine()`(101/108/151)——**平台 SPI**
- 关键设计 (斜体): *"attach = 工具进程连目标 JVM"——JVM 默认支持(JDK 工具/Arthas 都走它);SPI 让平台实现可插拔(linux/windows 不同实现);面试"attach 是什么"——进程间管理通道*
- 面试: "哪些工具用 attach"——jcmd/jstack/jmap/Arthas/JConsole(域 34 的 JMX 是另一通道)
- [关联: 域 07 SPI 加载;内部卷 36-attach(native 侧)]

### 2. "linux 的套接字实现" — .java_pid

场景: linux 上 attach 走什么通道?

- `jdk.attach/linux/classes/sun/tools/attach/VirtualMachineImpl.java:50` — `String socket_path`
- `findSocketFile`(73)→ `/tmp/.java_pid<pid>`(275 拼接)— **目标 JVM 的 Unix 域套接字**
- 目标未监听 → 向目标发 **QUIT 信号触发 attach 机制**(VirtualMachineImpl.java:71 注释 "sending it a QUIT signal")→ JVM 建套接字
- 握手: `writeString(s, PROTOCOL_VERSION)`(172)+ 命令 + 参数(带长度前缀)
- 关键设计 (斜体): *"attach 走 /tmp 套接字 + 文本协议"——版本号(1)握手防协议不匹配;面试"attach 通道"——Unix 域套接字(/tmp/.java_pid)*
- 生产: /tmp 权限问题导致 attach 失败(经典坑: 不同用户/挂载)
- [内核: Unix domain socket;内部卷 36-attach]

### 3. "命令协议" — HotSpotVirtualMachine

场景: attach 后怎么发命令(thread dump 等)?

- `HotSpotVirtualMachine.java:301` — `abstract InputStream execute(String cmd, Object... args)` — **命令执行抽象**(平台实现)
- 协议: 写版本+命令+参数 → 读响应流(字节输出)
- `loadAgentLibrary`(86): `execute("load", ...)`(94)— **加载 agent 库**
- 关键设计 (斜体): *"execute 协议 = attach 通道上的 RPC"——命令名+参数+响应流;工具(jcmd/jstack)全走它;面试"attach 后怎么交互"——execute 命令*
- 面试: "attach 能干什么"——加载 agent/执行命令(线程 dump/堆 dump/GC 等)
- [关联: 域 25 第 2 篇 loadAgent → Instrumentation]

### 4. "attach 的完整链路" — 时序

场景: `jstack pid` — 一步步发生什么?

1. JStack 解析参数 → `VirtualMachine.attach(pid)`(JStack.java:117)
2. attach: providers → linux impl → 找/触发套接字 → 握手
3. `vm.execute("thread_print")` → 目标 JVM 的 attach listener 处理
4. 流式读取响应 → 打印
- 关键设计 (斜体): *"工具 = attach + 命令"——所有诊断工具都是 attach 的客户端;面试画"jstack 时序图"是加分项*
- 面试: "attach listener 是谁"——JVM 内部线程(内部卷 36-attach)

---

### 核心悬念

attach 通道通了——**加载 agent 后干什么**?`Instrumentation` 的 addTransformer 怎么拦类加载?`retransformClasses` 怎么改已加载类?APM/Arthas 的字节码增强原理——下一篇: Instrumentation 与字节码增强。

> → [02-instrumentation.md](02-instrumentation.md)
