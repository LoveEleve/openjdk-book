# 第八卷：基础设施 — 日志/诊断/JFR/SA/构建/NMT

> **开源电子书第 8 卷** — 统一日志、JMX 管理、JFR 录制、SA 后分析、Agent 机制、构建裁剪、基础数据结构
>
> **这是最能展示开源电子书优势的一卷。** 纸质书最多给 JFR 20 页、SA 10 页——而本书以 67,060 行源码级分析为基础，让读者真正理解每一项基础设施的**完整内部实现**。

---

## §〇 分析资产总览

### 资产矩阵

| Phase | 子系统 | 文档数 | 分析行数 | .so 映射 |
|:---:|------|:---:|:---:|------|
| **23** | 统一日志框架 (UL) | 3 | 3,910 | libjvm.so (logging/) |
| **17** | JMX Management | 5 | 9,528 | libmanagement.so + libmanagement_ext.so + libmanagement_agent.so |
| **25** | JFR | 3 | 6,061 | libjvm.so (jfr/) |
| **20** | Serviceability Agent | 6 | 15,366 | libsaproc.so + sa-jdi.jar |
| **18** | Agent & Instrument | 7 | 7,380 | libinstrument.so + libattach.so + libdt_socket.so + libjdwp.so |
| **19** | Signal Chaining | 3 | 2,837 | libjsig.so + libjvm.so |
| **29** | 构建与裁剪 | 3 | 7,466 | Makefile 系统 (make/) |
| **24** | 基础数据结构 | 3 | 5,644 | libjvm.so (utilities/) |
| **27** | 内存管理剩余 | 3 | 4,435 | libjvm.so (memory/) |
| **28** | 代码缓存剩余 | 3 | 4,433 | libjvm.so (code/) |
| **合计** | 10 Phase | 39 | **67,060** | 7 个独立 .so + 4 个已编译入 libjvm.so |

### 各文档行数明细

```
Phase 20 SA:          3,923 + 2,532 + 1,720 + 1,966 + 1,976 + 3,249 = 15,366
Phase 17 JMX:         1,507 + 2,003 + 2,010 + 2,004 + 2,004 = 9,528
Phase 29 Build:       2,484 + 2,515 + 2,467 = 7,466
Phase 18 Agent:       1,104 + 1,007 + 1,377 + 283 + 1,118 + 1,000 + 1,491 = 7,380
Phase 25 JFR:         2,114 + 1,914 + 2,033 = 6,061
Phase 24 Utilities:   2,607 + 1,502 + 1,535 = 5,644
Phase 27 Memory:      1,457 + 1,463 + 1,515 = 4,435
Phase 28 Code:        1,204 + 1,643 + 1,586 = 4,433
Phase 23 Logging:     960 + 1,385 + 1,565 = 3,910
Phase 19 Signal:      944 + 791 + 1,102 = 2,837
```

---

## §一 第8卷特有优势

### 纸质书的物理极限

一本 400 页纸质书如果要覆盖本卷内容，必须有如下取舍：

| 子系统 | 纸质书可分配 | 本书实际 | 压缩比 |
|--------|:---:|:---:|:---:|
| JFR | ~15 页 | ~6,000 行 ≈ 60-80 页 | **4-5×** |
| SA (Serviceability Agent) | ~8 页 | ~15,000 行 ≈ 150-200 页 | **20×** |
| JMX Management | ~10 页 | ~9,500 行 ≈ 100-130 页 | **10-13×** |
| 构建系统 | ~5 页 | ~7,500 行 ≈ 80-100 页 | **16-20×** |
| Agent/JVMTI/JDWP | ~8 页 | ~10,000 行 ≈ 100-130 页 | **12-16×** |
| 统一日志框架 | ~5 页 | ~3,900 行 ≈ 40-50 页 | **8-10×** |
| 基础数据结构 | 省略 | ~14,500 行 ≈ 150-200 页 | **∞** |

> **纸质书总容量**: ~50 页 → **本书实际**: ~700-850 页，且每页都是 `file:line` 级别源码分析。

### 开源电子书优势体现在本卷的 3 个维度

1. **体量无限制**
   - SA 的 15,366 行分析包含 ptrace/core dump/ELF 解析/symtab 等全部 Linux 系统调用链
   - 纸质书不可能展示 `ps_proc.c:527` 中 `PTRACE_ATTACH → waitpid → PTRACE_PEEKDATA` 的完整追踪

2. **可执行验证**
   - 构建系统章节附完整编译脚本：从 `bash configure` 到 `make images`，读者可裁剪出 16MB JVM
   - JFR 章节附二进制 chunk 格式解析脚本，读者可直接解码 `.jfr` 文件

3. **随时更新**
   - JDK 版本升级后仅需更新受影响章节，而无需整书重写
   - 通过 Git 分支 JDK 11/17/21 三版本并行维护

---

## §二 7 章详细规划

---

### 第34章：统一日志框架 — `-Xlog` 背后的 C++ 引擎

> **资产**: Phase 23-logging（3 篇，3,910 行）  
> **角色**: 贯穿 JVM 所有子系统的诊断基础设施  
> **阅读收益**: 理解 `-Xlog:gc*=debug:file=gc.log:time,level,tags` 的完整解析和执行路径

#### 34.1 为什么需要统一日志
- 旧日志系统的碎片化：`-XX:+PrintGC` vs `-XX:+TraceClassLoading` vs `-XX:+LogCompilation`
- UL 的统一模型：Tag + Level + Selection + Output + Decoration 五元组
- 架构全景：选择层（what）→ 消息层（how）→ 输出层（where）

#### 34.2 标签系统：LogTag 的生命周期
- LogTag 枚举定义：从 `logTag.hpp:221` 的 `#define LOG_TAG_LIST` 宏展开
- LogTagSet：标签组合的匹配引擎（`logTagSet.cpp:180`）
- `LogTagSet::log_is_enabled()` — 判断某条日志是否应该输出的热路径优化
- 扩展 Tag 机制：`logTag_ext.hpp` 为 JFR 等子系统预留扩展位

#### 34.3 级别系统：从 Trace 到 Error 的梯度
- LogLevel 枚举的 7 级定义（`logLevel.hpp:82`）
- 级别的包含关系：Trace ⊂ Debug ⊂ Info ⊂ Warning ⊂ Error
- `LogLevel::finer_or_equal()` 的比较逻辑

#### 34.4 选择器引擎：解析 `-Xlog` 参数
- `LogSelection::parse()` — 字符串解析成结构化选择（`logSelection.cpp:351`）
- 语法：`tag1+tag2*=level` 的通配符匹配
- `LogSelectionList` — 多个选择的优先级裁决（`logSelectionList.cpp:101`）

#### 34.5 配置管理：从命令行到运行时
- `LogConfiguration::configure_output()` — 输出描述的解析（`logConfiguration.cpp:607`）
- `LogConfiguration::parse_log_arguments()` — `-Xlog` 参数的 5 字段解析
- 动态重配置：`VM.log` DCmd 的运行时日志开关（`logDiagnosticCommand.cpp:97`）
- 启动时的异步配置切换：`LogConfiguration::initialize()` 的 phase 切换机制

#### 34.6 输出管道：三条路径的完整追踪
- `LogOutput` 抽象基类（`logOutput.hpp:104`）
- `LogFileOutput` — 文件输出 + rotate（大小/数量轮转）(`logFileOutput.hpp:99`)
- `LogFileStreamOutput` — stdout/stderr 默认流（`logFileStreamOutput.hpp:93`）
- 异步日志：环形缓冲区的无锁实现
- 输出代理：`LogOutputList` 的并行分发（`logOutputList.cpp:128`）

#### 34.7 消息组装：从宏到字符串
- `LogMessage` 的延迟格式化：先判定再格式化（`logMessage.hpp:105`）
- `LogStream` — 类 ostream 的日志写入接口（`logStream.cpp:123`）
- `log.hpp` 中的宏体系：`LogTarget(LogTag::_gc) log_debug(gc)("...")` 展开全路径
- `LogHandle` — 每使用者的日志句柄（`logHandle.hpp:104`）
- `LogMessageBuffer` — 日志行缓冲区管理（`logMessageBuffer.cpp:146`）

#### 34.8 装饰器：日志前缀的格式化
- `LogDecorators` — 装饰器枚举（时间/级别/标签/PID/TID）（`logDecorators.cpp:83`）
- `LogDecorations::create_decorations()` — 前缀字符串组装
- `LogPrefix` — 跨行日志的统一前缀协议（`logPrefix.hpp:119`）

#### 34.9 运维与诊断
- 诊断工具：`jcmd <pid> VM.log` 的完整选项
- GDB 验证：在 `LogOutput::write()` 设断点观察日志流
- strace 验证：观察日志文件的 write() 系统调用
- 性能考量：`log_is_enabled()` 的 inline 优化消除未启用日志开销

---

### 第35章：JMX 管理接口 — JVM 的"数据总线"

> **资产**: Phase 17-jmx-management（5 篇，9,528 行）  
> **角色**: JVM 内部状态向外暴露的标准接口，jconsole/zabbix/prometheus 的数据来源  
> **阅读收益**: 理解 jconsole 连接时 JVM 内部发生了什么——从 RMI 握手到 Native vtable 调用

#### 35.1 JMX 核心概念：不只是一堆 getter
- JMX 不是简单的 getter/setter——它是一套 3 层桥接架构
- MBean/MBeanServer/JMX Connector 的直观类比
- 两条数据通路：JMX Connector (jconsole) vs Attach API (jcmd)——区别和汇合点
- 3 个 .so 角色：libmanagement.so(标准仪表盘) / libmanagement_ext.so(高级诊断) / libmanagement_agent.so(文件权限)

#### 35.2 jmm_interface — 36 个函数指针的 vtable
- `jmm_interface` 的 C 风格 vtable 设计（`jmm.h:221-342`，37 槽位含 2 reserved）
- `management.cpp:2232-2272` — 36 个 jmm_* 函数指针的完整初始化
- `JVM_GetManagement(JMM_VERSION)` → `Management::get_jmm_interface()` 的版本检查
- 为什么用 C vtable 而不是 C++ 虚函数？（ABI 稳定 + 二进制兼容）
- `JVM_ENTRY` vs `JVM_LEAF` 宏的线程状态转换差异

#### 35.3 JNI_OnLoad — 3 个 .so 的加载入水口
- `management.c:39-55` — `DEF_JNI_OnLoad` → `JVM_GetManagement()` 获取 vtable
- `management_ext.c` — 同样的获取模式
- 每个 JNI 函数只做 1 行：`return jmm_interface->Xxx(env, ...)`
- 这层薄包装的深意：.so 不需要重新编译即可适配 JVM 内部重构

#### 35.4 内存池监控：从 GC 到 jconsole 的全链路
- MemoryPool 类型体系：CollectedMemoryPool / CodeHeapPool / MetaspacePool / CompressedKlassSpacePool
- `jmm_GetMemoryUsage(management.cpp:738)` — 堆/非堆聚合使用量计算
- `MemoryService::set_universe_heap(memoryService.cpp:70)` — 内存池注册初始化
- GC 回调机制：`TraceMemoryManagerStats` RAII → `gc_begin()` → pool usage 更新 → `gc_end()`

#### 35.5 阈值检测：SensorInfo 的滞回逻辑
- `ThresholdSupport` — 高低阈值对（`lowMemoryDetector.hpp:67`）
- `SensorInfo::set_gauge_sensor_level(lowMemoryDetector.cpp:206)` — Gauge 模式的继续检测
- `SensorInfo::set_counter_sensor_level(lowMemoryDetector.cpp:261)` — Counter 模式的 GC 后检测
- 滞回机制：使用量 80% 触发 → 降回 50% 才清除，防止通知风暴
- Gauge vs Counter 两种模式的适用场景（CodeCache vs Eden）

#### 35.6 GC 通知的两阶段异步化
- Phase 1 (safepoint 内): `GCNotifier::pushNotification(gcNotifier.cpp:45)` — 仅链表插入，O(1)
- Phase 2 (ServiceThread): `GCNotifier::sendNotification(gcNotifier.cpp:165)` — 构造 Java 对象 + JNI 回调
- 为什么不能全部在 safepoint 完成？（延长 STW 时间）
- `LowMemoryDetector::process_sensor_changes()` — ServiceThread 的异步 Sensor 回调

#### 35.7 线程监控与死锁检测
- `jmm_GetThreadInfo` 的双路径：
  - `maxDepth==0` — 无需 safepoint（ThreadsListHandle 轻量快照）
  - `maxDepth>0` — `VM_ThreadDump` → safepoint 全局栈遍历
- `ThreadsListHandle` 如何保证线程列表一致性（Thread-SMR 机制）
- `FindMonitorDeadlockedThreads` vs `FindDeadlockedThreads` — monitor 锁 vs JSR-166 synchronizer
- locked monitor + JNI locked monitor + synchronizer 的深度提取

#### 35.8 VM Flag 的动态管理
- `jmm_GetVMGlobals(management.cpp:1536)` — 遍历全球 `JVMFlag` 数组
- `jmm_SetVMGlobal(management.cpp:1601)` — 动态修改 flag
- `WriteableFlags::set_flag(writeableFlags.cpp:238)` — 类型分发（bool/intx/ccstr/double/uintx）
- 三入口汇合：JMX(`Flag.setLongValue`) + jcmd(`VM.set_flag`) + attach API
- `JVMFlag::FlagOrigin` 枚举 — DEFAULT/COMMAND_LINE/MANAGEMENT/ERGONOMIC/ATTACH_ON_DEMAND

#### 35.9 OS 指标查询 — 5 平台的统一接口
- `OperatingSystemImpl.c(unix, 470行)` — Linux/macOS/Solaris/AIX 共享
- `/proc/self/stat` 字段 23 — 虚拟内存大小（`OperatingSystemImpl.c:127`）
- `/proc/self/fd` 遍历 — 打开文件描述符计数（`OperatingSystemImpl.c:220-250`）
- `sysinfo()` — Swap 空间查询
- `UnixOperatingSystem.c` — CPU load 查询（`/proc/stat` 解析 + 差值计算）

#### 35.10 JMX 代理启动全流程
- `Management::init(management.cpp:97)` — VM 早期初始化（创建 PerfCounter）
- `Management::initialize(management.cpp:174)` — Java 层初始化（加载 MXBean 类 + 执行 <clinit>）
- JMX agent 启动：`Agent.startAgent()` → `ConnectorBootstrap.startRemoteConnectorServer()`
- jconsole 连接时的完整调用链：RMI → MBeanServerConnection.getAttribute → native getMemoryUsage0 → jmm_interface 分发

---

### 第36章：JFR — 零开销的生产级事件录制 ⭐ 本卷亮点

> **资产**: Phase 25-jfr（3 篇，6,061 行）  
> **角色**: JDK Flight Recorder — JVM 的事件记录黑匣子，<1% 性能开销的持续诊断  
> **阅读收益**: 理解 JFR 录制文件（.jfr）的二进制格式内部结构，读懂事件从 Java 提交到磁盘写入的每一步

#### 36.1 JFR 架构全景
- 三大子系统：Recorder Engine(录制引擎) + Event System(事件系统) + Leak Profiler(泄漏分析器)
- 215 源文件 ~34K 行源码的模块划分
- 数据流：Java Event.commit() → JNI 桥接 → JfrBuffer(环形缓冲) → ChunkWriter(磁盘)
- `--with-jfr` configure 选项控制是否编译进 libjvm.so

#### 36.2 录制引擎：JfrRecorder 的生命周期
- 状态机：NEW → CREATED → RUNNING → CLOSED（`recorder/service/` 13文件 2786行）
- `JfrRecorder::start()` — 启动录制的完整初始化序列
- `JfrRecorder::stop()` — 安全停止，排空缓冲区
- `JfrRecorder::rotate()` — Chunk 轮转，生成新的录制文件
- Chunk 生命周期管理：创建 → 写入 → 关闭 → 存储（`recorder/repository/` 10文件 1223行）

#### 36.3 环形缓冲区：JfrBuffer 的无锁设计
- `recorder/storage/` 13 文件 3037 行 — 核心内存结构
- JfrBuffer 的环形布局：header + data region + epoch 标记
- 多线程并发写入：每个线程独立的 thread-local buffer
- Epoch 老化机制：旧 epoch 的 buffer 被回收，新 epoch 的 buffer 被激活
- Buffer 的生命周期：allocate → write → commit → retire → reuse

#### 36.4 检查点序列化：类型系统的增量写入
- `recorder/checkpoint/` 25 文件 4895 行
- TypeSet — JFR 类型注册表，包含所有事件类型的元数据
- TraceId — 每个类型的全局唯一标识符
- 常量池去重：字符串/类名/方法签名只写一次
- 增量写入策略：只有新增的类型被写入新的 checkpoint——减少 chunk header 大小

#### 36.5 事件写出：类型安全的 buffer 写入
- `writers/` 20 文件 2491 行 — EventWriter 模板体系
- struct field → buffer offset 的类型安全映射
- 每个事件类型的写出器由 `@Name("jdk.GCPhasePause")` 注解驱动代码生成
- 固定大小的快速路径 vs 可变大小的慢路径

#### 36.6 JNI 桥接：从 Java Event 到 C++ Buffer
- `jni/` 12 文件 2296 行 — Java→C++ 事件提交的完整路径
- `jdk.jfr.internal.EventWriter.put<Type>(value)` → native → JfrEvent::commit()
- 事件提交的 3 个阶段：begin → put fields → commit
- 线程局部缓冲区的获取与释放 — JfrThreadLocal 的 TLAB 类似物

#### 36.7 周期事件：JVM 状态的定时采样
- `periodic/` 15 文件 2466 行 — 15 类周期事件
- PeriodicType 调度框架：每个周期的执行时间点
- GC 周期事件：GCPhasePause/GCPhaseParallel/G1HeapSummary
- 线程周期事件：ThreadAllocationStatistics/ThreadCPULoad
- OS 周期事件：CPULoad/PhysicalMemory/NetworkUtilization
- 类加载周期事件：ClassLoadingStatistics/ClassLoaderStatistics

#### 36.8 Chunk 文件格式：.jfr 文件的二进制结构
- ChunkWriter — 文件写入引擎（`recorder/repository/`）
- Chunk 的 4 个区域：Header + Constant Pool + Metadata + Events
- Header 格式：magic number + version + chunk size + timestamp range
- Constant Pool 的增量编码：只存储新增的类型信息
- Event 区域的紧凑编码：LEB128 变长整数 + 相对时间戳

#### 36.9 泄漏分析器：对象生命周期的全记录
- `leakprofiler/` 47 文件 ~8K 行
- ObjectSampler — 基于弱引用的对象采样器
- BFS 引用链构建：从 GCRoot → target object 的最短路径
- BCI 插桩：ClassFileLoadHook → 字节码改写跟踪对象分配
- Leak Profiler 的性能开销及其控制（采样率调节）

#### 36.10 JFR 运维与诊断
- `jcmd <pid> JFR.start` — 启动录制（duration/filename/maxsize 参数）
- `jcmd <pid> JFR.dump` — 导出当前缓冲区
- `jcmd <pid> JFR.check` — 检查录制状态
- `-XX:StartFlightRecording` — JVM 启动即录制
- JFR 性能开销验证：`-XX:+UnlockDiagnosticVMOptions -XX:+DebugNonSafepoints`

---

### 第37章：Serviceability Agent — 零协作的"后门"调试器

> **资产**: Phase 20-sa-postmortem（6 篇，15,366 行——全卷最大单项分析）  
> **角色**: SA 是调试已挂起 JVM 的"最后希望"——不需要目标 JVM 配合即可读取其内存状态  
> **阅读收益**: 理解为什么 SA 能在 JVM 死锁/OOM/GC hang 时仍可分析，以及 ptrace/core dump 的完整 Linux 系统调用链

#### 37.1 SA 的"零协作"哲学
- SA 不需要目标 JVM 配合（无 JVM TI/attach API/信号依赖）
- 两模式：Live Mode (ptrace 附加运行中 JVM) vs Postmortem Mode (core dump 离线分析)
- 三 Debugger 后端：LinuxDebuggerLocal (JNI→libsaproc) / ProcDebuggerLocal (/proc 直读) / RemoteDebugger (RMI)
- SA 架构全景：`libsaproc.so` (native) + `sa-jdi.jar` (Java) → jhsdb 工具集

#### 37.2 Native 核心：libsaproc.so 的 7 个源文件
- `ps_proc.c(527行)` — Live Mode：`PTRACE_ATTACH → waitpid → PTRACE_PEEKDATA` 的完整 ptrace 流程
- `ps_core.c(1134行)` — Postmortem Mode：ELF core dump 解析（NT_PRSTATUS/NT_FPREGSET/NT_AUXV 等 note 类型）
- `symtab.c(607行)` — ELF 符号表解析（.symtab / .dynsym 的完整遍历）
- `LinuxDebuggerLocal.c(580行)` — JNI 桥接层：Java↔C 方法注册与实现
- `libproc_impl.c(421行)` — 进程句柄管理、库加载、线程扫描
- `salibelf.c(126行)` — ELF 文件读取工具
- `sadis.c(344行)` — 反汇编器桥接（hsdis 集成）

#### 37.3 Live Debugging：ptrace 的完整流程
- `Pgrab(pid)` → `PTRACE_ATTACH` → `waitpid()` 等待目标进程停止
- `lookup_symbol(handle, name)` → ELF .dynsym → GOT/PLT 解析
- `ps_pdread(handle, addr, buf, size)` → `PTRACE_PEEKDATA` 按字读取（64位每字8字节）
- 读取限制：ptrace 一次只能读一个字 → 大对象读取需要批量 PEEKDATA 循环
- `ps_pglobal_lookup()` → 解析 JVM 内部全局符号（`Universe::_collectedHeap` 等）
- `Prelease(handle)` → `PTRACE_DETACH` → 目标进程继续运行

#### 37.4 Postmortem Debugging：从 core dump 重建 JVM 世界
- `Pgrab_core(filename)` → `open + ELF 头解析 → 遍历 program headers`
- `PT_NOTE` segment 解析：NT_PRSTATUS(寄存器) / NT_PRPSINFO(进程信息) / NT_AUXV(辅助向量)
- `PT_LOAD` segment：可加载的内存区域（堆/栈/代码/数据段）
- core dump 的虚拟地址 → 文件偏移映射（`phdr.p_offset → phdr.p_vaddr`）
- HotSpot 类型系统映射：`vmStructs.cpp(3210行)` 定义 500+ 字段到 core dump 偏移的映射
- OOP 重建：从 core dump 的裸内存中重建 Java 对象的类型信息

#### 37.5 JNI 桥接：Java 层如何调用 Native libsaproc
- `LinuxDebuggerLocal.c` — 注册 20+ native 方法：`attach0/detach0/lookupByName0/readBytesFromProcess0`
- `ps_prochandle` — 核心进程句柄 vtable（`libproc_impl.h`）
- `ps_prochandle_ops` — 平台相关的操作集：`p_pread/p_pwrite/p_lookup/p_get_lwp_regs`
- Java↔C 类型转换：Java long → C pointer，`jbyteArray` → core dump 字节块

#### 37.6 SA 的工具集：从 jstack 到 CLHSDB
- `jhsdb jstack` — 从 core dump 重建所有线程的 Java 栈轨迹
- `jhsdb jmap` — 堆对象图遍历（从 root → reachable objects）
- `jhsdb jinfo` — 提取 JVM 标志和系统属性
- `jhsdb jsnap` — 导出 JVM 内部性能计数器
- `jhsdb clhsdb` — 交互式命令行调试器（printas/printstatics/threads/where 等命令）
- 每种工具如何通过 SA Debugger 抽象层访问 native 数据

#### 37.7 符号解析：从地址到函数名的完整路径
- ELF .dynsym vs .symtab — 动态符号 vs 调试符号
- `symtab.c` 的线性扫描查找算法
- debuginfo 包的作用：在线 RPM `java-<ver>-openjdk-debuginfo` 提供 `.symtab`
- 没有符号表时的回退：通过 `vmStructs` 中的偏移量硬编码关键地址

#### 37.8 SA 的限制与边界
- ptrace 的竞态：目标 JVM 可能在 `PTRACE_PEEKDATA` 间隙执行 GC
- 内存一致性：SA 读取的是瞬时快照，不是原子快照
- Postmortem 的局限：core dump 只捕获用户态内存，内核态文件描述符表不可见
- 大堆的 SA 性能：遍历百万对象可达数分钟

---

### 第38章：Agent、Attach 与调试协议 — JVM 的运行时"手术刀"

> **资产**: Phase 18-agent-instrument（7 篇，7,380 行） + Phase 19-signal-chaining（3 篇，2,837 行）  
> **角色**: JVM 的另一套"插件系统"——Java Agent + Attach API + JVMTI + JDWP 调试协议  
> **阅读收益**: 理解 `-javaagent` 如何注入、premain/agentmain 的区别、以及调试器如何控制 JVM 执行

#### 38.1 架构全景：5 个 .so 的协作
- libinstrument.so — Java Agent 加载引擎（`-javaagent:myagent.jar`）
- libattach.so — Attach API（`jcmd <pid> load`）
- libdt_socket.so — JDWP 传输层（Unix Domain Socket）
- libjdwp.so — Java Debug Wire Protocol 实现（17 个 CommandSet）
- libmanagement_agent.so — JMX Agent 权限检查（仅 74 行）
- JVMTI 核心编译进 libjvm.so（`JvmtiEnv` 300+ 函数）

#### 38.2 Agent 加载：从命令行到 premain
- `-javaagent:myagent.jar=args` → `Arguments::parse_each_javaagent_option()` 解析参数
- `JPLISAgent` — Agent 的 C++ 表示（状态机：CREATED → LOADED → STARTED）
- `Agent_OnLoad(JavaVM*, char* options, void* reserved)` → `createNewJPLISAgent()`
- `eventHandlerVMInit()` → `sun.instrument.InstrumentationImpl.loadClassAndCallPremain()`
- Agent 的隔离模型：每个 Agent 独立的 ClassLoader → 同名类互不干扰

#### 38.3 ClassFileLoadHook：字节码级别的拦截
- `eventHandlerClassFileLoadHook()` — JVMTI 事件回调
- `transformClassFile()` → `sun.instrument.InstrumentationImpl.transform()` → Java Transformer
- 多 Transformer 的链式调用：每个 Transformer 处理后传给下一个
- ClassFileLoadHook 的性能影响：每次类加载都额外消耗

#### 38.4 Attach API：动态附加的运行机制
- `VirtualMachine.attach(pid)` → Unix Domain Socket 连接（`/tmp/.java_pid<pid>`）
- `AttachListener::init()` → 创建 listener 线程，监听 socket
- `SIGQUIT` 机制：首次 attach 时发送 SIGQUIT 唤醒目标 JVM（仅无 listener 时）
- `loadAgent(agentPath, options)` → `dlopen(libinstrument.so)` → `Agent_OnAttach()`
- agentmain vs premain：运行时加载 vs 启动时加载的生命周期差异

#### 38.5 Redefine/Retransform：类的运行时替换
- `VM_RedefineClasses` — VM Operation：在 safepoint 内执行类替换
- `redefine_single_class()` — 单类的完整替换流程
- 旧类的 "scratch class"：旧版本类被标记为 `is_scratch_class`，等待 GC
- 限制：不能添加/删除字段（可以修改方法体）
- `RetransformClasses` vs `RedefineClasses` — 使用原始 class 文件的区别

#### 38.6 JVMTI 核心：300+ 函数的完整接口
- `JvmtiEnv` — JVMTI 环境的 C++ 实现
- 事件控制器：`SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_CLASS_FILE_LOAD_HOOK, NULL)`
- Capabilities 管理：`AddCapabilities()` → 位图标记 → `JvmtiExport` 全局启用
- TagMap — 对象标记（mark-and-sweep 风格的 JVMTI 标记）
- `JVMTI_EVENT_CLASS_FILE_LOAD_HOOK` 的完整调用链

#### 38.7 JDWP 调试协议：调试器如何控制 JVM
- `dt_socket` transport — `debugInit()` → `dbgsysListen(sockfd)` → `accept()`
- `debugLoop()` 主循环 — 接收 JDWP 命令包 → 解析 → 分派 → 发送响应
- 17 个 CommandSet：VirtualMachine/ReferenceType/ClassType/ArrayType/Method/Field/Thread/ThreadGroupReference/StackFrame/ObjectReference/StringReference/ClassObjectReference/EventRequest/...
- 事件系统：`eventHandler` — 断点/单步/方法入口/异常事件的注册和触发
- 线程控制：`threadControl` — `suspendAllThreads/resumeThread/stepControl`
- 单步执行：`stepControl` — JVMTI `SingleStep` 事件的启用和停用

#### 38.8 Signal Chaining：JVM 与第三方库的信号共存
- `libjsig.so` — LD_PRELOAD 拦截 `sigaction()/signal()` 调用（`jsig.c:342`）
- 三阶段协议：
  1. jsig 拦截：保存第三方处理器到 `sact[]` 数组
  2. JVM 安装：`set_signal_handler()` 三路决策（直接安装/jsig保存/posix保存）
  3. JVM 分派：`JVM_handle_linux_signal()` → 未识别信号 → `chained_handler()` → `call_chained_handler()`
- 6 个信号的逐个安装：SIGSEGV/SIGBUS/SIGFPE/SIGPIPE/SIGILL/SIGTRAP
- `SignalHandlerMark` RAII — 在信号处理期间标记"我们正在处理中"
- 跨 CPU 平台的信号识别：x86_64 SIGSEGV 的 `si_addr` 解读

---

### 第39章：构建与裁剪 — 造一把自己的 JVM

> **资产**: Phase 29-build-customize（3 篇，7,466 行）  
> **角色**: 从 `bash configure` 到 `make images` 的完整构建管线——学会编译、理解、裁剪自己的 JVM  
> **阅读收益**: 理解 `make jdk-image` 背后编译一个 HotSpot 的完整过程，以及如何裁剪出一个最小化的 16MB JVM

#### 39.1 构建系统总览
- make/ 目录结构：220 文件 ~124K 行
- GNU Make 为基础的构建体系
- `make/Main.gmk` — 7 阶段主构建管线
- `make/autoconf/` — configure 系统（autoconf .m4）

#### 39.2 configure 系统：从检测到生成
- `autoconf/hotspot.m4` — JVM 特性检测（JVM_FEATURES、compiler、CPU）
- `autoconf/platform.m4` — 平台检测（Linux/macOS/Windows）
- `autoconf/toolchain.m4` — 编译器检测（gcc/clang/msvc 版本和标志）
- `bash configure --with-jvm-variants=server --with-jvm-features=compiler1,compiler2,g1gc`
- `spec.gmk` 生成 — 构建参数固化

#### 39.3 Main.gmk 的 7 阶段构建管线
- 阶段 1：`java.base` — 核心 Java 类编译
- 阶段 2：`hotspot` — HotSpot JVM 编译
- 阶段 3：Java 模块 — 全部 JDK 模块编译
- 阶段 4：Copy — 文件复制（native libraries、配置文件）
- 阶段 5：jmod — Java 模块打包
- 阶段 6：jlink — 运行时镜像创建
- 阶段 7：Images — 最终 JDK 镜像组装（jdk + jre）

#### 39.4 HotSpot 编译 — libjvm.so 如何诞生
- `make/hotspot/lib/CompileJvm.gmk:153` — `BUILD_LIBJVM` 目标
- `make/hotspot/lib/JvmFeatures.gmk` — 22 个 `ifeq` 的 5 层过滤级联
- JVM_FEATURES 开关：compiler1/compiler2/g1gc/jvmti/jfr/cds/...
- 源文件编译：share + os + os_cpu + cpu 的 4 层源码结构
- 链接：`g++ -shared -o libjvm.so` 包含所有编译的 .o 文件
- 其他 .so 的编译：`make/hotspot/lib/CompileLibraries.gmk`

#### 39.5 镜像组装：jmod → jlink → exploded image
- `make/Images.gmk` — 最终镜像组装
- jmod 打包：每个模块编译为 .jmod 文件
- jlink 运行时构建：从 .jmod 生成定制 JRE
- exploded image：未打包的开发目录结构（用于本地测试）
- `JAVA_HOME` 结构：bin/lib/conf 的完整目录映射

#### 39.6 自定义裁剪实战
- JVM_FEATURES 选择：
  - `--with-jvm-features=compiler2,g1gc,jvmti,jfr` — 生产 JVM
  - `--with-jvm-features=compiler2,g1gc` — 最小裁剪 JVM
  - `--with-jvm-features=minimal` — 极致最小（仅 serial gc + C1）
- JVM_VARIANTS 配置：`server/client/minimal/zero/core`
- 模块裁剪：`--with-jmod-compress` 的压缩级别
- 实测效果：从 250MB 完整 JDK → 裁剪到 16MB 最小 JVM
- 常见坑：去掉 compiler2 导致启动变慢、去掉 g1gc 无法使用 `-XX:+UseG1GC`

---

### 第40章：基础数据结构与实用工具 — JVM 的内部"标准库"

> **资产**: Phase 24-utilities（5,644 行） + Phase 27-memory-extra（4,435 行） + Phase 28-code-extra（4,433 行）  
> **角色**: 被 JVM 所有子系统共享的基础设施——GrowableArray 引用 4,700+ 次、Hashtable 800+ 次  
> **阅读收益**: 理解 JVM 内部数据结构的实现细节，以及为什么这些"平凡"结构支撑了 JVM 所有复杂子系统

#### 40.1 核心容器：JVM 的动态内存基石

##### 40.1.1 GrowableArray — 动态数组
- `GenericGrowableArray` → `GrowableArray<T>` 模板（`growableArray.hpp:645`）
- 扩容策略：×2 倍增 + 4 最小容量
- 用 CHeap 内存还是 Arena 内存？（`GrowableArray<T>::on_C_heap()`）
- 截断：`trunc_to()` 只用 O(1) 将 `_len` 降低

##### 40.1.2 Hashtable — 哈希表基类
- `BasicHashtable` → `Hashtable<K,V>` → `TwoOopHashtable<K,V>` 三层继承
- 桶数组 + 单向链表的布局
- `hash_to_index()` — `hash % table_size` 的取模
- 扩容：`double_table_size()` → `basic_hashtable::bulleted_move()`

##### 40.1.3 ConcurrentHashTable — 无锁并发哈希表
- 被 `StringTable` 和 `SymbolTable` 使用
- `MultiGet` — 批量并发读取
- `ConcurrentHashTable::insert()` — CAS 无锁插入
- 并发删除：`delete()` 使用延迟回收
- `GlobalCounter` — RCU 退化版（`globalCounter.hpp:214`）→ 等待所有读者退出

##### 40.1.4 BitMap — 位图
- `BitMap` → `ArenaBitMap` → `CHeapBitMap`
- 基础操作：`set_bit/clear_bit/par_set_bit`
- 位图迭代器：`BitMap::iterate()` 遍历 set bit
- `CBM[Concurrent]BitMap` — 并发安全的位图（用于 GC 标记）

##### 40.1.5 其他容器
- `LinkedList` — 双向链表模板（421行）
- `Stack` — 栈容器（490行）
- `SingleWriterSynchronizer` — 单写者同步器（222行）
- `ChunkedList` — 分块链表（81行）
- `Pair` — 值对模板（41行）

#### 40.2 流式输出：从 outputStream 到 JSON

##### 40.2.1 outputStream 体系
- `outputStream` 抽象基类（`ostream.hpp:1451`）
- `stringStream` — 内存字符串流（`jstack` 输出目标）
- `bufferedStream` — 缓冲流（`VM.info` 输出）
- `fdStream` — 文件描述符流（`tty/stdout/stderr`）
- `networkStream` — Socket 输出流（attach API 响应）

##### 40.2.2 XML/JSON 格式化
- `xmlStream` — XML 元素/属性/嵌套输出（702行）
- `jsonStream` — JSON 格式化输出（800行）
- 格式化缓冲区：`FormatBuffer` — `%d/%s/%p` 的 printf 风格（157行）

##### 40.2.3 字符串与编码
- `UTF8` — UTF-8 编解码（658行）
- `StringUtils` — 字符串工具（112行）
- `Bytes` — 字节序交换（53行）

#### 40.3 调试与诊断：hs_err 崩溃报告

##### 40.3.1 断言框架
- `assert/guarantee/fatal/should_not_reach_here` — 4 级断言（`debug.hpp:989`）
- `ASSERT` vs `#ifdef ASSERT` — product vs debug 构建
- 断言的性能影响：product 构建中被编译器消除

##### 40.3.2 hs_err 崩溃报告引擎
- `VMError::report_and_die()` — 崩溃时的步骤引擎（`vmError.cpp:2072`）
- 20 个子步骤：信号信息 → 寄存器 → 栈帧 → 编译任务 → GC 堆 → 动态库 → 系统信息
- `ErrorLogReport` — 写入 `hs_err_pid<pid>.log`
- 信号处理中的安全保证：仅使用 async-signal-safe 函数

##### 40.3.3 ELF 解码器
- `ElfFile` — ELF 文件解析器（568行）
- `ElfSymbolTable` — 符号表查找（182行）
- `Decoder` — 地址→符号解码（289行）
- `NativeCallStack` — 原生调用栈解析（231行）
- `Events::log()` — JVM 事件记录（410行）

#### 40.4 虚拟空间与分配器：内存的底层支撑

##### 40.4.1 VirtualSpace 层次
- `ReservedSpace` → `ReservedSpace::release/reserve/align`（`virtualspace.hpp:1580`）
- `VirtualSpace` → `expand_by/expand_into/shrink_by`
- `CommittedRegion` → commit/uncommit 粒度管理（2MB/1GB large page）
- VirtualSpaceList — 虚拟空间链表（metaspace 后端）
- VirtualSpaceNode — 虚拟空间节点（`metaspace/virtualSpaceNode.cpp:662`）

##### 40.4.2 Arena 分配器
- `Arena::Amalloc(size)` — bump-pointer 分配（`arena.hpp:525`）
- `Arena:: grow()` — Chunk 链扩展
- `ResourceArea` — thread-local Mag + Nest 机制（`resourceArea.hpp:89`）
- `ARENA_OBJ` vs `C_HEAP_OBJ` 宏 — 两种分配策略（`allocation.hpp:297`）

##### 40.4.3 Metaspace 内部分配器
- `ChunkManager` — 3 级空闲链表（`metaspace/chunkManager.cpp:732`）
- `SpaceManager` — Block-level 分配器（`metaspace/spaceManager.cpp:540`）
- `BlockFreelist` — 已释放块的再利用（`metaspace/blockFreelist.cpp:109`）
- `OccupancyMap` — 占位图（`metaspace/occupancyMap.hpp:135`）
- `BinaryTreeDictionary` — CMS 空闲列表的管理结构

#### 40.5 nmethod 与编译产物管理

##### 40.5.1 nmethod 内存布局
- `nmethod.hpp:2995` — header + reloc + scopes + metadata 的完整布局
- `CompiledMethod` 中间层 — 共享 compiled IC/dependency/exceptions（`compiledMethod.hpp:636`）
- `nmethod::header_size()` — 物理帧（align 到 wordSize）
- relocation + metadata + scopes_pcs scopes 的紧凑编码

##### 40.5.2 调试信息元数据
- `DebugInfoRecorder` — C2 编译器使用的调试信息记录器（`debugInfoRec.hpp:211`）
- `ScopeDesc` — 内联帧的 PC→Scope 映射（`scopeDesc.hpp:137`）
- `PcDesc` — PC→调试信息索引
- `CompressedStream` — 压缩流编码（LEB128 变长整数）
- `OopRecorder` — Oop 元数据记录器

##### 40.5.3 依赖管理
- `Dependencies` — 编译依赖系统（`dependencies.hpp:2185`）
- 依赖类型：`leaf_type/unique_concrete_method/abstract_with_unique_concrete_subtype`
- `DependencyContext` — 依赖上下文（273行）
- deoptimization 触发：编译时的假设被打破 → 标记 nmethod 为 not_entrant

##### 40.5.4 内联缓存 (IC)
- `CompiledIC` — monomorphic/bimorphic/polymorphic IC（`compiledIC.hpp:720`）
- IC 桩代码：`compiledIC::set_to_megamorphic()` 的桩切换
- `ICBuffer` — IC 缓冲区管理（234行）
- `CompiledStaticCall` — 静态调用的 IC

#### 40.6 异常处理与重定位

##### 40.6.1 异常处理表
- `ExceptionHandlerTable` — 异常处理编码（`exceptionHandlerTable.hpp:231`）
- PC 范围 + handler 类型的紧凑编码
- 异常查找：`handler_for(pc, handler_bci)` → 二分查找已排序的表

##### 40.6.2 重定位信息
- `RelocInfo` — 重定位信息编码（`relocInfo.hpp:1394`）
- 重定位类型：`oop_type/metadata_type/call_type/poll_type/...`
- `CodeBlob::relocInfo()` → `RelocIterator` 遍历
- nmethod 加载时的重定位应用：调整 function/oop 的绝对地址

---

## §三 章节间依赖与阅读路径

### 阅读路径建议

```
第34章 (日志)     ──→  第35章 (JMX)     ──→  第36章 (JFR)     ──→  第37章 (SA)
     │                      │                      │                    │
     │                      │                      │                    │
     │                      ├──→  第38章 (Agent)  ←─┤                    │
     │                      │                      │                    │
     └──────────────────────┴──────────────────────┴────────────────────┘
                                        │
                                        ▼
                                  第39章 (构建)
                                        │
                                        ▼
                                  第40章 (数据结构)
```

- **线性阅读**: 34 → 35 → 36 → 37 → 38 → 39 → 40（从应用层到底层）
- **工具使用者**: 34(日志) + 35(JMX) + 39(构建) — 理解如何配置和构建 JVM
- **调试工程师**: 37(SA) + 38(Agent) + 36(JFR) — 理解 JVM 诊断工具链
- **JVM 开发者**: 40(数据结构) + 36(JFR) + 37(SA) — 理解 JVM 内部基础设施

### 跨章节交叉引用

| 源章节 | 目标章节 | 内容 |
|--------|---------|------|
| 34 (UL) | 35 (JMX) | JMX 使用 `log_debug(management)` 输出诊断日志 |
| 35 (JMX) | 38 (Agent) | JMX 和 attach API 共享 `WriteableFlags::set_flag()` 路径 |
| 36 (JFR) | 34 (UL) | JFR 事件含日志事件，`-Xlog` 和 JFR 是互补诊断 |
| 37 (SA) | 38 (Agent) | SA 不使用 attach/JVMTI——对比两个"插件系统" |
| 38 (Agent) | 35 (JMX) | `jmm_interface` vtable 模式 vs JVMTI 接口模式对比 |
| 39 (Build) | 36 (JFR) | `--with-jfr` 开关控制 JFR 编译到 libjvm.so |
| 40 (DS) | 全部 | GrowableArray/Hashtable 被所有子系统依赖 |

---

## §四 质量锚点与写作优先级

### 各章质量锚点

| 章节 | 锚点文档 | 行数 | 质量基准 |
|:---:|------|:---:|------|
| 34 | `probe_md/23-logging/docs/00-Tag-Level-Selection-Configuration.md` | 960 | 函数级 + syscall + 反事实 |
| 35 | `probe_md/17-jmx-management/docs/01-management-jmm-interface.md` | 2,003 | file:line 全覆盖 |
| 36 | `probe_md/25-jfr/docs/00-JFR-Recorder-Engine.md` | 2,114 | 二进制格式深度 |
| 37 | `probe_md/20-sa-postmortem/docs/04-SA-Bootstrap.md` | 3,923 | 本卷最长 |
| 38 | `probe_md/18-agent-instrument/docs/05-JVMTI-Core.md` | 1,118 | 依赖最长链 |
| 39 | `probe_md/29-build-customize/docs/00-Configure-System.md` | 2,484 | 构建管线 |
| 40 | `probe_md/24-utilities/docs/00-Core-Containers-Concurrent.md` | 2,607 | 4,700+ 引用 |

### 各章写作目标行数（书籍化后）

| 章节 | 当前分析 | 书籍化后估计 |
|:---:|:---:|:---:|
| 34 (日志) | 3,910 | ~5,000 |
| 35 (JMX) | 9,528 | ~12,000 |
| 36 (JFR) | 6,061 | ~10,000 |
| 37 (SA) | 15,366 | ~18,000 |
| 38 (Agent) | 10,217 | ~15,000 |
| 39 (构建) | 7,466 | ~10,000 |
| 40 (数据结构) | 14,512 | ~18,000 |
| **合计** | **67,060** | **~88,000** |

---

## §五 与现有分析的差异点（需补充/强化）

### 需补充的分析

1. **PerfData / hsperfdata** — 目前仅 Phase 01 中 100 行，在 JMX 章节需深度展开
2. **jstat 工具链** — `jstat -gc/-class/-compiler` 如何读取 PerfData 的完整链路
3. **JFR Java 层** — 现有文档偏 C++ 实现，需补充 Java 层 `jdk.jfr.*` 的 API 设计
4. **CDS (Class Data Sharing)** — 已有部分分析但未纳入第8卷，需评估归属
5. **hs_err 文件格式** — Phase 24 有 `vmError.cpp` 但 jcmd 解读 hs_err 文件的工具链不完整

### 需强化的部分

| 领域 | 当前状态 | 书籍化强化 |
|------|---------|-----------|
| JFR .jfr 二进制格式 | 文档提及但未逐字段 | 添加逐字节的 .jfr 解码脚本（Python） |
| SA 工具实战案例 | 源码分析为主 | 添加 3 个完整实战案例（OOM/死锁/GC hang） |
| 构建裁剪结果对比 | 文档提及但无基准 | 列出裁剪前/后 libjvm.so 大小+启动时间表格 |
| 基础数据结构的性能 | 无基准 | 添加 GrowableArray vs C++ vector、ConcurrentHashTable vs std::unordered_map 的微观基准 |

---

## §六 本卷写作注意事项

1. **SA 精简不删减**: 15,366 行是最大的单项分析——保留 ptrace/core dump 的完整系统调用链，但合并重复的模式描述
2. **JFR 作为亮点**: 需要单独制作 "JFR 数据流示意图" 和 "JFR chunk 文件的逐字节编码表"
3. **构建系统实战导向**: 让读者能复制粘贴 `bash configure ... && make images` 命令并得到可用的裁剪 JVM
4. **Agent 章节的依赖图**: 5 个 .so 的协作关系复杂——需要精准的架构图
5. **数据结构章节的交叉引用**: 在每处使用 GrowableArray / Hashtable 的地方标注"详见第40章"，让读者建立内部库心智模型
6. **GDB 验证脚本**: 每章至少 3 个可运行的 GDB 断言——读者可以在自己的 JVM 上复现分析

## §七 统计总结

| 指标 | 数值 |
|------|:---:|
| 分析 Phase 数 | 10 |
| 文档总数 | 39 |
| 现有分析行数 | 67,060 |
| 独立 .so 数量 | 7 |
| 编译进 libjvm.so 的模块 | 4 |
| 计划章节数 | 7 (From 第34章 to 第40章) |
| 估计书籍化后总行数 | ~88,000 |
| 估计页数 (中文) | ~700-900 页 |
