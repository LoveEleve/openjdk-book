# NMT (Native Memory Tracking) — 文章大纲

> vol-05 · 域 34 · 🟡 B
>
> **→ 从 JMX**：JMX 告诉你 Java 堆用了多少内存。NMT 回答另一个问题：JVM 的 **native (C++) 内存** 用了多少——mmap 的 CodeCache、malloc 的 compiler buffer、Metaspace 的虚拟空间——这些 Java 堆之外的内存占用量可能比堆还大。

## 叙事计划

**开篇场景**：Java 堆只用了 2GB，但操作系统报告进程用了 8GB RSS——"剩余 6GB 花在哪了？" NMT 回答：1.5GB 是 `mtClass`（类元数据）、1.2GB 是 `mtCode`（编译代码的 CodeCache）、800MB 是 `mtGC`（G1 remembered set）、600MB 是 `mtThread`（线程栈）……每一笔都带标签。

**三档追踪**：`off`（关—零开销）、`summary`（按分类汇总计数）、`detail`（每个 malloc 调用点记录——包括调用栈）。`-XX:NativeMemoryTracking=detail` 启后，`jcmd <pid> VM.native_memory summary` 输出分类报表。

**拦截机制**：NMT 通过 `os::malloc()`/`os::realloc()`/`os::free()` 的替换宏拦截所有 HotSpot 内部的内存分配。`MEMFLAGS` 枚举（mtClass/mtThread/mtGC/...）标记每次分配的"用途分类"。`MallocTracker` 在 detail 模式下记录调用栈地址（`MallocSiteTable` 哈希表）。

**虚拟内存跟踪**：`VirtualMemoryTracker` 记录通过 `os::reserve_memory()`/`os::commit_memory()` 分配的虚拟内存区域——按 `MEMFLAGS` 分类汇总 reserved/committed 量。与 malloc 跟踪互补——malloc 覆盖小块分配，virtual memory 覆盖大块（如 CodeCache heap）。

**设计权衡**：detail 模式的性能开销——每次 malloc/free 需要查哈希表、记录调用栈、更新计数器。估算 ~5-10% 的吞吐量损失。生产环境通常只用 summary 模式。

## 核心悬念

**"Java 堆只用 2GB，进程 RSS 却 8GB——剩余 6GB 花在哪了？" NMT 通过拦截 HotSpot 内部的所有 malloc/mmap，给每一块 native 内存打上用途标签（mtClass/mtCode/mtGC...），让你像分析 Java 堆一样分析 native 堆。**

→ 下一域：NMT 通过 `jcmd` 命令查询——但 `jcmd` 本身怎么和运行中的 JVM 通信？Attach API 提供了信号/pipe 的通信通道——`jcmd <pid> <command>` 本质上是向目标 JVM 发送命令并读回结果。

## 预估

1 篇，4 层递进，1200-1500 行。
