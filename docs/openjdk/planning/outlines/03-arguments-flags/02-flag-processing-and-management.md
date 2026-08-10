# 02. 解析 → Ergo → 约束 → jcmd — Flag 的完整生命周期

> 🔴 Deep | 12 KP 中的 4 个处理+管理机制
> 读者处境: Flag 定义好了——启动时怎么从命令行字符串变成 C++ 值？运行时 jcmd 怎么改？

### 1. 命令行解析 — 三种语法，单遍扫描

场景: `-XX:+UseG1GC -Xms4g -XX:ParallelGCThreads=4`——三个 flag，三种语法——一次 parse。

**parse_each_vm_init_arg** (`arguments.cpp:2400`):
- `-XX:+Flag`: 查 JVMFlag 对象→set_bool(true, ARG)
- `-XX:-Flag`: set_bool(false, ARG)
- `-XX:Flag=value`: 字符串→类型转换 (strtol/strtod)→set (ARG)
- [C++: JVMFlag::flag_from_str("UseG1GC") — O(n) 线性搜索 800+ flag 的全局列表。不用 hash——flag 名可能有别名 (UseParallelGC 同时代表 UseParallelOldGC)——线性搜索可以在别名链上继续。parse 时只解析不验证——约束推迟到 AfterParse phase]
- 聚合参数互斥: UseParallelGC=true → 自动设 UseConcMarkSweepGC=false (互斥标志)
- [C++: `Arguments::set_aggressive_opts_flags()` (`arguments.cpp:2950`)——处理 "聚合 flag"——一个 flag 影响多个。UseSerialGC → 设 ParallelGC=false, UseG1GC=false, UseConcMarkSweepGC=false]

**System.setProperty 同步** (`arguments.cpp:3070`):
- `-Dkey=value` → `Arguments::add_property("key", "value")` → `System::set_property("key", "value")`
- 所有 `-D` flag 同步到 JVM System Properties——Java 代码通过 `System.getProperty` 读取

### 2. Ergonomics — 平台自适应

场景: 你没指定 `-XX:ParallelGCThreads`——JVM 自己算。怎么算的？

**ParallelGCThreads 公式** (`arguments.cpp:3700`):
- CPU ≤ 8: GC 线程 = CPU 数
- CPU > 8: GC 线程 = 8 + (CPU-8) * 5/8
- [C++: 为什么 8 是阈值？→ empirical: STW GC 在 8 线程以下接近线性加速，超过 8 线程 CPU 饱和 (GC 线程间的 work stealing 竞争)——以上多线程收益递减]

**InitialHeapSize / MaxHeapSize** (`arguments.cpp:3820`):
- Xms = PhysicalMemory/64 (最少 8MB) → DefaultInitialRAMFraction=64
- Xmx = Min(PhysicalMemory/4, MaxRAMFraction) → DefaultMaxRAMFraction=4
- Container 感知覆盖: 如果 cgroup memory_limit 有效，替代 PhysicalMemory

**TieredCompilation**: server class machine (≥2 CPU + ≥2GB RAM) → 自动启用

*关键设计: Ergo 在 parse 之后——因为 Ergo 值 Origin=ERGONOMIC < ARG。用户显式设置 (-XX:ParallelGCThreads=4) 的 Origin=ARG——Ergo 算出的值被 ignore。parse→ergo 两阶段="用户显式指定 > 平台自适应"*

### 3. jcmd 运行时管理

场景: JVM 跑了 3 天——GC 日志太吵——想关掉 PrintGC。不能重启——jcmd。

**jcmd VM.flags** (`writeableFlags.cpp:68-130`):
- 遍历所有 JVMFlag → format(type+name+value+origin) → outputStream
- [C++: DiagnosticCommand 框架——jcmd 命令通过 DCmdFactory 查找→DCmd::execute→遍历 800+ flag→format→outputStream→返回结果]
- PrintFlagsFinal vs PrintFlagsInitial (`arguments.cpp:3100`):
  - Initial = Ergo 前的值; Final = Ergo 后的值
  - diff → 揭示 Ergo 悄悄改了哪些 flag (典型 ~28 个)
  - [C++: `os::print_flag_differences(PrintFlagsInitial, PrintFlagsFinal)`——逐 flag 比较两份输出的字符串。同一 flag 的 "=" 后不同 = Ergo 改动]

**jcmd VM.set_flag** (`jvmFlagWriteableList.cpp:40`):
- 只有 MANAGEABLE flag 可改——`Flag_writelock` mutex 保护 (`jvmFlag.cpp:200`)
- [C++: pthread_mutex_lock——修改 flag 时持有写锁，VM 线程读取 flag 时使用读锁。写锁阻塞所有读——修改期间所有 flag 读取被暂停——保证 flag 值的一致性]
- 为什么不是所有 flag 可写？→ UseG1GC 改变需要重启 GC——运行中切换 GC 算法→所有对象的管理方式需要立即改变→不可能

---

### 核心悬念

**"`-XX:+PrintFlagsFinal` 和 `-XX:+PrintFlagsInitial` 的 diff——是 JVM 调优最快的诊断。"** — Ergo 自动调整了 ~28 个 flag。GC 延迟突然恶化？先跑 diff 检查 ParallelGCThreads 是否因为 docker CPU quota 变化从 8 被调到了 2。800+ flag 的宏体系保证没有一个能绕过类型/范围/约束/Ergo/jcmd 五道关卡。

> → domain 4: [Logging — flag 驱动 JVM 行为，但日志怎么控制输出什么？60+ 标签的层次化过滤](../04-logging/01-tag-and-selection.md)
