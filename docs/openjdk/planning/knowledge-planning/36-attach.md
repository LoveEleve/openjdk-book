# 域 36: Attach API — 知识规划

> 源码: services/attachListener.* + dtraceAttacher.* + os/linux/attachListener_linux.cpp + jdk.attach/ (30文件C) | 35文件 | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| services/attachListener.hpp/cpp | **AttachListener — JVM 侧 attach**: attach_listener_thread(loop wait for attach request), AttachOperation(name+arguments→pipe), IPC: Linux用Unix domain socket/tmp/.java_pid1234, AttachOperationFunctionTable(find operation by name→execute) | High |
| os/linux/attachListener_linux.cpp | **Linux attach**: SIGQUIT 信号触发→创建 Unix domain socket→client(jdk.attach) connect→transmit command→JVM process | High |
| jdk.attach/ (30文件C, libattach) | **JDK Attach API (C)**: AttachProvider(socket connect to target JVM), VirtualMachine(attach/detach/dataDumpRequest/startManagementAgent), loadAgent/loadAgentPath(dynamic agent attachment) | Medium |
| dtraceAttacher.hpp/cpp | **DTrace attach**: Solaris/MacOS DTrace attach provider | Low |

*4 知识点*

## 02 聚合 — P1/P2

### P1
| KP | 出现文件 |
|----|---------|
| AttachListener + Linux IPC | attachListener.*, os/linux/attachListener_linux.cpp, jdk.attach/ |

### P2
| KP | 出现文件 |
|----|---------|
| JDK Attach API (loadAgent/dataDump) | jdk.attach/(30文件C) |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| AttachListener + Unix Domain Socket IPC | jcmd/jconsole/JFR 远程 attach 的唯一入口——JVM 在启动时创建 attach listener thread→在 `/tmp/.java_pid<PID>` 上监听 Unix domain socket→client(jdk.attach) connect→write "COMMAND\narg1=val1\n..."→JVM process read→AttachOperation parsed→dispatch to DCmd(域35)或 loadAgent。socket 访问受 Unix file permissions 保护——只能本机 attaches |

### 🟡 Working (1 KP)
| KP | 说明 |
|----|------|
| JDK jdk.attach C library | VirtualMachine attach/detach/loadAgent——thin wrapper on socket IPC |

### 🟢 Surface
| KP | 说明 |
|----|------|
| DTrace attacher | Solaris/MacOS only |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | AttachListener + Socket IPC | "jcmd 怎么连接到运行中的 JVM？Unix domain socket 怎么建立？" |
| 2 | JDK Attach API + loadAgent | "怎么在运行时动态加载一个 JVMTI agent？" |
