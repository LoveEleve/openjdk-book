# SA Postmortem (libsaproc) — 文章大纲

> vol-06 · 域 43 · 🟡 B | JDK Native | 基于 Pass 0+1
>
> **→ 从 NIO Network**：网络跑着——JVM 死锁/hang/OOM 时不能靠网络诊断。SA 通过 ptrace 强读目标进程——零协作诊断。

## 叙事计划

**开篇场景**：线上 JVM 卡死——HTTP 不响应、JMX 连不上。`jstack -F <pid>` 通过 SA 强制附加：`PTRACE_ATTACH` → 暂停目标 → `PTRACE_GETREGS`(读寄存器) → `PTRACE_PEEKDATA`(读内存) → 从栈中还原 Java 调用链。整个过程目标 JVM 不执行任何代码。

**第一层：Live Mode — ptrace 强读**：`ps_proc.c`(`jdk.hotspot.agent/linux/native/libsaproc/ps_proc.c`, 527行) 用 `PTRACE_ATTACH` 附加→`/proc/<pid>/maps` 读布局→`PTRACE_PEEKDATA` 逐字读内存。通过 JNI 向 Java 暴露 `read_memory()`/`get_thread_regs()`。

**第二层：Postmortem — ELF core dump**：`ps_core.c`(1134行) 解析 core dump——无需运行中进程。`add_map_info`(`:124`)读 LOAD segments→重建地址空间→`symtab.c`(607行) ELF symtab→函数名。完全离线。

**第三层：vmStructs.cpp — 布局字典**：`vmStructs.cpp`(`runtime/vmStructs.cpp`, 275KB) 编译 HotSpot 类型(`Klass`/`oopDesc`/`Method`)的字段偏移量→常量表。SA 运行时读表→知道每个内存地址的含义——从原始字节还原对象语义。

## 核心悬念

**JVM 死了怎么诊断？ps_proc.c ptrace→ps_core.c core dump→vmStructs.cpp 布局解码——三重机制在任何状态下都能"看见"JVM 内部。**

→ vol-06 完。43 域结束。

## 预估

1 篇，3 层递进，1200-1600 行。
