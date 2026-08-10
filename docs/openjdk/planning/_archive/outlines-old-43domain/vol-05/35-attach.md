# Attach API — 文章大纲

> vol-05 · 域 35 · 🟡 B
>
> **→ 从 NMT**：NMT 的数据通过 `jcmd <pid> VM.native_memory` 查询——但 `jcmd` 怎么找到目标 JVM 并向它发命令？Attach API 提供了"运行中 JVM 接受外部命令"的通道。

## 叙事计划

**通信管道**：`jcmd/jstack/jmap` 通过 Attach API 与目标 JVM 通信——Linux 上用 SIGQUIT + UNIX socket（`/tmp/.java_pid<pid>`）。流程：Attach 客户端发 SIGQUIT → JVM 的 **Signal Dispatcher 线程**（`os::signal_wait()` 循环等待信号的专用线程）接收信号 → 创建 AttachListener 线程监听 socket → 客户端 connect 发命令 → 返回结果。

**DCmd 框架**：`diagnosticCommand.cpp` 实现命令注册+分派。每个 `DCmd` 子类声明自己的参数（`DCmdArgument` 描述 — 参数名/类型/默认值/描述）和执行逻辑。`jcmd <pid> help` 列出所有可用的诊断命令——`VM.native_memory`、`Thread.print`、`GC.run`、`JVMTI.data_dump` 等。

**常见的 Attach 工具**：
- `jcmd <pid> <command>` — 发送任意诊断命令
- `jstack <pid>` — 专用于线程 dump（实际调用 `Thread.print` DCmd）
- `jmap <pid>` — 堆 histogram / heap dump（实际调用 `GC.heap_dump` DCmd）
- `jinfo <pid>` — JVM flags 查询/动态修改

**设计权衡**：Attach 的安全性——任何具有相同 uid 的进程都可以 attach 到 JVM。生产环境中需要 restrict（`-XX:+DisableAttachMechanism` 或 ACL 控制的 socket 文件权限）。

## 核心悬念

**`jcmd`、`jstack`、`jmap` 是怎么"叫醒"运行中的 JVM 的？通过 SIGQUIT 信号触发 JVM 创建一个 `/tmp/.java_pid<pid>` socket——然后通过这个 socket 发送文本命令、读取文本结果。**

→ 下一域：`jmap -dump:live,file=heap.hprof <pid>` 通过 Attach API 触发 heap dump——但 HeapDumper 内部做了什么？HPROF 格式是什么？HeapDumper 篇见。

## 预估

1 篇，3 层递进，1000-1300 行。
