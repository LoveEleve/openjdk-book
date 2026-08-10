# Phase 20: Serviceability Agent — libsaproc.so + sa-jdi.jar

## .so 映射

| BUILD 目标 | .so/jar 文件 | 构建文件 | 归属模块 |
|-----------|-------------|---------|---------|
| `BUILD_LIBSA` | `libsaproc.so` | `make/lib/Lib-jdk.hotspot.agent.gmk:58` | `jdk.hotspot.agent` |
| （Java 编译） | `sa-jdi.jar` | `make/CompileJavaModules.gmk:311` | `jdk.hotspot.agent` |

## SA 系统架构概览

```
┌──────────────────────────────────────────────────────────────┐
│  诊断工具: jhsdb = jstack | jmap | jinfo | jsnap | clhsdb    │
│  Java 层 (1009 files, ~128K lines) — sa-jdi.jar              │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Tools     │ │ HSDB/CLI  │ │ Runtime  │ │ OOPs/GC/Code  │  │
│  └────┬─────┘ └────┬──────┘ └────┬─────┘ └───────┬───────┘  │
│       └────────────┼─────────────┼───────────────┘           │
│         ┌──────────▼─────────────▼──────────────┐            │
│         │  Debugger 抽象层 (Address/Debugger/   │            │
│         │  PageCache/MachineDescription)        │            │
│         ├── LinuxDebuggerLocal (JNI → libsaproc)│            │
│         ├── ProcDebuggerLocal (/proc 直读)      │            │
│         └── RemoteDebugger (RMI)                │            │
│         └──────────────┬────────────────────────┘            │
├────────────────────────┼─────────────────────────────────────┤
│  Native 层 (13 files, ~119K C) — libsaproc.so                 │
│  ┌────────────────────────────────────────────────────┐      │
│  │  Linux: ps_proc(ptrace) + ps_core(ELF core) +      │      │
│  │          symtab(符号表) + salibelf(ELF工具)          │      │
│  │  macOS: MacosxDebuggerLocal.m(task_for_pid)         │      │
│  │  Solaris: saproc.cpp(procfs)                        │      │
│  │  Windows: sawindbg.cpp(Debug API)                   │      │
│  │  share: sadis.c(反汇编桥接)                          │      │
│  └────────────────────────────────────────────────────┘      │
├─────────────────────────────┬───────────────────────────────┤
│  HotSpot 接口层                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  vmStructs.cpp(3210行) + 各 GC vmStructs_*.hpp      │    │
│  │  attachListener.cpp(494行) + _linux.cpp(583行)      │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

- **两模式**: Live Mode (ptrace 附加运行中 JVM) vs Postmortem Mode (ELF core dump 离线分析)
- **三 Debugger 后端**: LinuxDebuggerLocal (JNI→libsaproc), ProcDebuggerLocal (/proc 直读), RemoteDebugger (RMI)
- **零协作需求**: SA 不需要目标 JVM 配合（无 JVM TI/attach API 依赖），即使 JVM 已挂起（死锁、OOM、GC hang）也能工作

## 源码范围

仅分析 **Linux amd64** 平台，排除 macOS/Solaris/Windows 实现。

### Native 层 — libsaproc.so 源文件

| 文件 | 大小 | 行数 | 职责 |
|------|------|------|------|
| `src/jdk.hotspot.agent/linux/native/libsaproc/ps_proc.c` | 16K | 527 | **Live Mode**: ptrace + /proc 活动进程调试 |
| `src/jdk.hotspot.agent/linux/native/libsaproc/ps_core.c` | 36K | 1134 | **Postmortem Mode**: ELF core dump 解析 |
| `src/jdk.hotspot.agent/linux/native/libsaproc/symtab.c` | 20K | 607 | ELF 符号表解析 (.symtab / .dynsym) |
| `src/jdk.hotspot.agent/linux/native/libsaproc/LinuxDebuggerLocal.c` | 19K | 580 | **JNI 桥接层** — Java↔C 方法注册与实现 |
| `src/jdk.hotspot.agent/linux/native/libsaproc/libproc_impl.c` | 12K | 421 | 进程句柄管理、库加载、线程扫描 |
| `src/jdk.hotspot.agent/linux/native/libsaproc/salibelf.c` | 3.8K | 126 | ELF 文件读取工具 |
| `src/jdk.hotspot.agent/linux/native/libsaproc/libproc_impl.h` | 4.7K | — | 核心数据结构 (ps_prochandle, ps_prochandle_ops vtable, thread_info, lib_info, map_info, core_data) |
| `src/jdk.hotspot.agent/linux/native/libsaproc/libproc.h` | 3.3K | — | 公共 C API (Pgrab, Pgrab_core, Prelease, lookup_symbol, find_lib 等 15 个函数) |
| `src/jdk.hotspot.agent/linux/native/libsaproc/symtab.h` | 1.8K | — | 符号表 API |
| `src/jdk.hotspot.agent/linux/native/libsaproc/salibelf.h` | 2.0K | — | ELF 工具 API |
| `src/jdk.hotspot.agent/linux/native/libsaproc/proc_service.h` | 3.0K | — | proc service 接口（兼容 GDB） |
| `src/jdk.hotspot.agent/linux/native/libsaproc/elfmacros.h` | 1.8K | — | ELF 宏定义 |
| `src/jdk.hotspot.agent/share/native/libsaproc/sadis.c` | 11K | 344 | 反汇编器桥接 (hsdis) |

**Native 层总计**: ~119K C 代码, 7 .c (~3739 行) + 6 .h

### Java 层 — sa-jdi.jar 核心源文件

SA Java 层有 1009 个 .java 文件 (~128,000 行)，本 Phase 聚焦于**核心执行路径**，不覆盖全部辅助类。

| 子包 | 核心文件 | 职责 |
|------|---------|------|
| `sun/jvm/hotspot/` | HotSpotAgent.java (24K) | SA 最高层入口，管理 attach/detach |
| | HotSpotTypeDataBase.java (36K) | 从目标 libjvm.so 解析 C++ 类型布局 |
| | VM.java (964行) | SA 端 VM 单例，持有所有运行时引用 |
| `debugger/` | Debugger.java (198行) | 调试器抽象接口 |
| | DebuggerBase.java (20K) | 调试器基类，PageCache 支持 |
| | Address.java (11K) | JVM 地址抽象 |
| | OopHandle.java (2.1K) | OOP 句柄 |
| | ThreadProxy.java (3.4K) | 线程代理接口 |
| | MachineDescription.java (2.5K) | 平台机器描述 |
| `debugger/linux/` | LinuxDebuggerLocal.java (25K) | Linux JNI 包装核心 |
| `debugger/proc/` | ProcDebuggerLocal.java (26K) | /proc 直读调试器 |
| `debugger/posix/elf/` | ELFFileParser.java (1132行) | ELF 文件解析 (Java 侧) |
| `runtime/` | VM.java, JavaThread.java, Threads.java | 运行时结构映射 |
| `oops/` | ~100 files | OOP 对象模型映射 |
| `tools/` | Tool.java (7.1K), JStack.java, JMap.java | 诊断工具 |
| `classfile/` | SystemDictionary.java | 类数据 |
| `gc/` | 7 GC 子包 (~50 files) | GC 视图 |
| `command/` | CommandProcessor.java (82K) | CLI 命令处理器 |

**Java 层聚焦**: Debugger 抽象层 + HotSpotAgent 启动流水线 + Tools 遍历路径（约 15-20 个核心 .java 文件）

### HotSpot 接口层 — SA 所需接口

| 文件 | 路径 | 行数 | 职责 |
|------|------|------|------|
| `vmStructs.cpp` | `src/hotspot/share/runtime/` | 3210 | **SA 核心元数据** — 暴露给 SA 的 C++ 结构体/字段宏声明 |
| `vmStructs.hpp` | `src/hotspot/share/runtime/` | 302 | 宏定义框架 |
| `vmStructs_gc.hpp` | `src/hotspot/share/gc/shared/` | ~700 | GC 共享元数据 |
| `vmStructs_g1.hpp` | `src/hotspot/share/gc/g1/` | ~200 | G1 GC 元数据 |
| ... 11 个各 GC 子 vmStructs | | | |
| `vmStructs_linux.hpp` | `src/hotspot/os/linux/` | 45 | Linux 特定 |
| `vmStructs_x86.hpp` | `src/hotspot/cpu/x86/` | 80 | x86 特定 |
| `vmStructs_linux_x86.hpp` | `src/hotspot/os_cpu/linux_x86/` | 54 | Linux x86 组合 |
| `attachListener.cpp` | `src/hotspot/share/services/` | 494 | Attach 机制核心 |
| `attachListener_linux.cpp` | `src/hotspot/os/linux/` | 583 | Linux Attach (/tmp/.java_pid) |

## 文档拆分方案

**文档数**: 6 篇（由源码结构决定：Native 3层 + Java 2层 + Bridge 1 层）

```
probe_md/20-sa-postmortem/
├── README.md
├── prompts/
│   ├── prompt-00-SA-Architecture.md          # 架构全景 + Native 核心数据结构
│   ├── prompt-01-Live-Debugging.md           # Native 活进程调试 (ps_proc.c)
│   ├── prompt-02-Postmortem-Debugging.md     # Native Core dump 解析 (ps_core.c)
│   ├── prompt-03-JNI-Bridge-Symbol.md        # JNI 桥接 + 符号表解析
│   ├── prompt-04-SA-Bootstrap.md             # Java 层启动流水线 (HotSpotAgent→TypeDB→VM)
│   └── prompt-05-Tools-Pipeline.md           # Java 层工具遍历路径 (jstack/jmap/jinfo)
└── docs/
    ├── 00-SA-Architecture-Native-Core.md     # ~2000-3000 行
    ├── 01-Live-Debugging.md                  # ~2000-3000 行
    ├── 02-Postmortem-Debugging.md            # ~2500-3500 行
    ├── 03-JNI-Bridge-Symbol-Resolution.md    # ~2000-3000 行
    ├── 04-SA-Bootstrap-Type-System.md        # ~2500-3500 行
    └── 05-Tools-Pipeline.md                  # ~2500-3500 行
```

### 各文档详情

#### 00 - SA 架构全景 + Native 核心数据结构

**源文件**:
- `libproc_impl.h` — ps_prochandle 结构体 (pid/ops/vtable/libs/threads/core)
- `libproc_impl.c` — 核心管理函数 (add_lib_info, add_thread_info, init_libproc)
- `libproc.h` — 公共 API (Pgrab/Pgrab_core/Prelease/lookup_symbol/find_lib/get_lwp_regs/get_num_threads 等 15 个函数)
- `proc_service.h` — GDB 兼容接口 (ps_pdread, ps_pglobal_lookup 等)

**核心内容**:
1. SA 三层架构全景图 (Java Debugger → JNI libsaproc → OS Primitives)
2. 两模式对比表 (Live vs Postmortem: 入口函数/内存读/线程获取/符号查找/Worker线程)
3. ps_prochandle 结构体拆解: vtable 方法表 → 活进程实现 vs core dump 实现
4. lib_info 链表: maps 解析 (基址+size+路径+delta) → 符号查找基础
5. thread_info: 活进程从 /proc/task 扫描, core 从 NT_PRSTATUS 读取
6. PageCache 机制: DebuggerBase.java 中的 16MB 4096页缓存, 与 libsaproc 读操作的协调
7. 三 Debugger 后端对比: LinuxDebuggerLocal vs ProcDebuggerLocal vs RemoteDebugger

#### 01 - Native 活进程调试 (Live Mode)

**源文件**:
- `ps_proc.c` — 活动进程 ptrace 操作

**核心内容**:
1. `Pgrab(pid)` 启动流程: ptrace(PTRACE_ATTACH) → SIGSTOP → /proc/maps 解析 → /proc/task 扫描
2. `ptrace(PTRACE_PEEKDATA)` 读内存: 对齐处理 + 拼接 + 错误处理 (ESRCH/EIO/EPERM)
3. `ptrace(PTRACE_POKEDATA)` 写内存: 用例 + 安全性
4. `ptrace(PTRACE_GETREGS)` / `PTRACE_GETFPREGS`: 寄存器读取流程
5. `/proc/<pid>/maps` 解析: 构建 lib_info 链表 → grep libjvm.so 基址
6. `/proc/<pid>/task/` 线程枚举: 递归扫描所有 LWP → 为每个线程缓存 tid
7. 线程信号点: SIGSTOP/SIGCONT 的生命周期管理
8. `Prelease(pid)` 清理: ptrace(PTRACE_DETACH) → 释放 lib_info/thread_info 链表

#### 02 - Native Postmortem 调试 (Core dump)

**源文件**:
- `ps_core.c` — ELF core dump 解析
- `salibelf.c/h` — ELF 辅助函数

**核心内容**:
1. `Pgrab_core(execfile, corefile)` 启动: 打开 core + exec 文件 → ELF 验证
2. ELF core header 解析: ELF64 Ehdr → e_phoff → Program Headers 遍历
3. PT_LOAD 段: 虚拟地址 → core 文件偏移映射 (p_vaddr → p_offset 偏移表)
4. PT_NOTE 段解析: NT_PRSTATUS (寄存器) / NT_PRPSINFO (pid/comm) / NT_AUXV (辅助向量)
5. NT_FILE note: 共享库文件路径列表 → 构建 lib_info 链表 (无 maps 文件可用)
6. 虚拟内存重建: 多个 PT_LOAD 段如何拼回进程地址空间快照
7. `pread()` 读取 core 内存: offset 计算 → 跨段读取处理
8. 符号查找 vs 活进程的区别: dlopen 不可用 → 直接解析 ELF .dynsym 符号表
9. 线程提取: 多个 PRSTATUS → thread_info 链表建立
10. core 数据管理: core_data 结构体 (core_fd/exec_fd/num_notes/list etc.)

#### 03 - JNI 桥接 + 符号表解析

**源文件**:
- `LinuxDebuggerLocal.c` — JNI 函数注册与实现
- `symtab.c/h` — ELF 符号表解析
- `sadis.c` — 反汇编桥接

**核心内容**:
1. JNI 方法注册表: `JNI_OnLoad` → `methods[]` 数组 → 10 个原生方法映射
2. `Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_attach0`: Worker 线程创建 → Pgrab → 错误映射
3. `Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_readBytesFromProcess0`: Page 缓存 → raw read
4. `Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_lookupByName0`: 遍历 lib_info → 解析符号表 → 返回地址
5. `Java_sun_jvm_hotspot_debugger_linux_LinuxDebuggerLocal_getThreadIntegerRegisterSet0`: ptrace(GETREGS) → `regs[REG_COUNT]`
6. Worker 线程模式: 为什么需要? (ptrace 限定 attach 线程才能操作) → 消息队列 + 同步
7. `symtab.c` 符号表解析: `.symtab` vs `.dynsym` → Elf64_Sym 结构 → st_name/st_value/st_size/st_info
8. 符号查找算法: hash table 查找 → 动态符号 vs 调试符号 → fallback 逻辑
9. `sadis.c` 反汇编: `decode_instruction()` → hsdis 插件调用 → 指令字节流解码

#### 04 - SA 启动流水线 (Java 层)

**源文件**:
- `HotSpotAgent.java` — SA 最高层入场 (attach/detach/模式选择)
- `HotSpotTypeDataBase.java` — C++ 类型布局反序列化引擎
- `VM.java` — VM 单例初始化 (Universe/Threads/Heap/SystemDictionary/ObjectHeap)
- `MachineDescription.java` + AMD64/AArch64 实现
- `Debugger.java`, `DebuggerBase.java`
- `Address.java`, `OopHandle.java`

**核心内容**:
1. `HotSpotAgent.attach(pid)` 全流程: OS/CPU 检测 → setupDebugger (根据平台实例化) → attachDebugger → setupVM
2. `setupDebuggerLinux()`: `new LinuxDebuggerLocal(machDesc, useCache=true)` → `System.loadLibrary("saproc")` → `debugger.attach(pid)`
3. `HotSpotTypeDataBase` 初始化: `debugger.lookup(libjvm_base, "gHotSpotVMTypes")` → 读取 `VMTypeEntry*` 链表 → `debugger.lookup("gHotSpotVMStructs")` → 读取 `VMStructEntry*` 链表 → 反序列化每个 C++ 类型及其字段偏移
4. TypeDataBase 输出: `Type` 对象 (名称+大小+sizetointerf+子类信息) + `Field` 对象 (名称+类型+偏移)
5. `VM.initialize(db, debugger)` 流程: `VM.getVM()` → `new VM(db, debugger)` → 构造函数设基础常量和对齐 → 子系统通过懒加载 getter 按需创建 (Universe → ObjectHeap → SystemDictionary → Threads → JNIHandles → ObjectSynchronizer, 首次访问时实例化)
6. `MachineDescription` 作用: 字长 (4/8字节) + 字节序 (大/小端) + 寄存器名称映射 + `addressSize()`
7. `Address` / `OopHandle` 抽象: 如何通过地址读取任意 C++ 字段 (利用 TypeDataBase 中的偏移量)
8. `PageCache` (DebuggerBase): 4096 页 × 4KB 缓存 → LRU 淘汰 → 减少 ptrace/mmap 调用

#### 05 - SA 工具遍历路径

**源文件**:
- `Tool.java` — 所有 SA 工具的基类 (三种 attach 模式)
- `JStack.java` — 线程栈回溯
- `JMap.java` — 堆分析 (heap/histo/dump/clstats/finalizerinfo/pmap)
- `JInfo.java` — JVM flags + 系统属性
- `SALauncher.java` — jhsdb 分派入口 (+ `jhsdb jstack/jmap/jinfo/clhsdb/hsdb/debugd/jsnap`)
- `runtime/JavaThread.java`, `runtime/Threads.java`, `runtime/VM.java`

**核心内容**:
1. `Tool.execute()` 模板方法: `start(args)` → `startInternal()` → `agent.detach()`
2. 三种 attach 模式: PID 活进程 / `exec+core` postmortem / 远程 (连接 debugd)
3. `JStack.run()` — 栈回溯管线:
   - `Threads.first()` → JavaThread 链表遍历
   - `JavaThread.getStackFrame()` → vframe 迭代 (JavaVFrame / CompiledVFrame / DeoptimizedVFrame)
   - PStack mode (含 native 帧) vs StackTrace mode (纯 Java 帧)
   - 死锁检测: `DeadlockDetector.resourceTracker → isDeadlock()` → 循环等待图检测
4. `JMap.run()` — 堆分析管线:
   - MODE_HEAP_SUMMARY: `HeapSummary.run()` → GC 子系统统计 (分代/G1/ZGC)
   - MODE_HISTOGRAM: `ObjectHeap.iterate(histoVisitor)` → 按 Class 名聚合实例数和大小
   - MODE_CLSTATS: `ClassLoaderDataGraph.classesDo()` → 类加载器统计
   - MODE_HEAP_GRAPH: `HeapDumper.run()` → OOP 图遍历 → HPROF 二进制格式 → 文件写入
   - MODE_FINALIZERINFO: `FinalizerInfo.run()` → ReferenceQueue 链表遍历
   - MODE_PMAP: `PMap.run()` → 读取 lib_info 链表 → 打印内存映射
5. `JInfo.run()` — VM 信息管线:
   - flags: `VM.getCommandLineFlags()` → 读 Arguments::_jvm_flags_array
   - sysprops: `SystemDictionary` → `java.util.Properties` hashtable 遍历
6. OOP 遍历原理: `ObjectHeap.iterate()` → OopVisitor 回调 → InstanceKlass/ObjArrayKlass 识别
7. 性能考量: PageCache 命中率 → 大堆遍历的 I/O 成本 → 一次性读取策略

## 暂不覆盖（后续 Phase 或扩展考虑）

- **HSDB / clhsdb** (CommandProcessor.java 82K + HSDB.java 72K): CLI 解析引擎 + Swing GUI 极其庞大，单独篇章
- **vmStructs 系统** (vmStructs.cpp 3210行): 宏展开机制本身是一个独立系统，可在后续 Phase 覆盖
- **Remote Debugger** (RMI 远程调试): 网络传输协议 + 序列化机制，属于分布式调试
- **ProcDebuggerLocal** (/proc 直读): 与 LinuxDebuggerLocal 功能重叠，且已标记为不推荐使用
- **GC / OOP 完整 Java 视图**: 100+ 文件的详细遍历，可在后续 Phase 按 GC 子系统深化
- **Solaris / macOS / Windows 原生层**: 非本 Phase 关注范围

## 分析优先级

| 优先级 | 文档 | 理由 |
|--------|------|------|
| ⭐⭐⭐ | 00 SA Architecture | 必须先做完整体架构理解 |
| ⭐⭐⭐ | 01 Live Debugging | 最常见的 SA 使用场景 |
| ⭐⭐ | 02 Postmortem | Phase 名称 "sa-postmortem" 的核心 |
| ⭐⭐ | 03 JNI Bridge | 连接 C↔Java 的关键桥接 |
| ⭐⭐ | 04 Bootstrap | Java 层启动类型系统的核心 |
| ⭐ | 05 Tools | 诊断工具的遍历路径（依赖前几篇） |

## 后续操作

1. 用户确认本 README 的 .so 映射和文档拆分
2. 按优先级逐步写出 6 篇 prompt（≥450行/篇）
3. 在新会话中用 prompt 生成文档
4. Review 流程 (自检 12 项 Checklist + 修复 gap)
