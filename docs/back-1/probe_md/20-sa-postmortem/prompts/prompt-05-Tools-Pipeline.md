# Prompt-05: SA 工具遍历路径 — Tool 模板方法 + JStack/JMap/JInfo 管线

> **目标文档**: `probe_md/20-sa-postmortem/docs/05-Tools-Pipeline.md`
>
> **预计篇幅**: 2500-3500 行
>
> **质量锚点**: `probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md` (521 行, 12 个 Section)

---

## §〇 Production Scenario

**场景 1: 排查线上线程卡死**

运维工程师发现线上 Java 应用的响应延迟骤然升高到 30s。使用 `jstack` 通过 JMX 连接被拒绝（进程压力大，JMX 线程无法响应）。改用 `jhsdb jstack --pid 4451`：

```bash
$ jhsdb jstack --pid 4451
Attaching to process ID 4451, please wait...
Debugger attached successfully.
Server compiler detected.
JVM version is 11.0.12+7-LTS

"nioEventLoop-3-1" #23 daemon prio=5 tid=0x00007f8a1c0ba800 nid=0x7f8b runnable [0x00007f8a0a7fb000]
   java.lang.Thread.State: RUNNABLE
   - sun.nio.ch.EPollArrayWrapper.epollWait(Native Method) @bci=0
   - sun.nio.ch.EPollArrayWrapper.poll(EPollArrayWrapper.java:269) @bci=112
   - sun.nio.ch.EPollSelectorImpl.doSelect(EPollSelectorImpl.java:93) @bci=189
   - sun.nio.ch.SelectorImpl.lockAndDoSelect(SelectorImpl.java:86) @bci=11
   ...
```

**关键发现**: 大量线程阻塞在 `epollWait`，但 Monitor 锁分析显示一个 I/O 线程持有全局写锁已 30 分钟——定位到问题线程。

**场景 2: 排查内存泄漏**

应用堆使用率持续增长，GC 频率逐日增加。使用 JMX 的 `jmap -histo` 需要目标 JVM 配合（JMX 端口 + 权限），但生产环境 JMX 端口未开通。改用 `jhsdb jmap --histo --pid 1234`：

```bash
$ jhsdb jmap --histo --pid 1234
Attaching to process ID 1234, please wait...
Debugger attached successfully.

Iterating over heap. This may take a while...
 num     #instances         #bytes  class name
----------------------------------------------
   1:       1234567      123456789  [C
   2:        987654       98765432  java.lang.String
   3:        456789       45678901  [B
   4:        500000       40000000  com.example.LeakyCache$Entry   <-- 异常大量
   ...
```

**关键发现**: `LeakyCache$Entry` 500K 个实例，单看一种业务缓存类占用 40MB 且从未回收 → 定位到缓存 key 设计缺陷导致空间泄漏。

**本文档目标**: 深入 SA 工具的遍历路径，解释：
1. Tool 基类的**模板方法模式**：`execute()` → `start()` → `startInternal()` → `run()` → `stop()`，为什么用模板方法而非策略模式？
2. `start()` 中的**三种 attach 模式分派**：PID / exec+core / remote 的分派逻辑
3. JStack 的**双模式栈回溯管线**：PStack（含 native 帧）vs StackTrace（纯 Java 帧）的实现差异
4. JMap 的**堆遍历 + 多 GC 适配**：HeapSummary 如何处理 6 种不同的 GC 实现？
5. JInfo 的**VM flags 读取路径**：`VM.getVM().getCommandLineFlags()` 如何通过 TypeDataBase 获取？
6. **SA 工具 vs 标准 jcmd/jstat 的根本差异**：为什么 SA 不需要目标 JVM 配合？（这是 SA 最核心的工程价值）

> **💡 核心认知**: SA 工具是"外科手术式"诊断工具。标准 `jcmd`/`jstat` 需要目标 JVM 有空闲 Java 线程接收入站连接并执行诊断命令——在进程 OOM 或线程池满时直接失效。SA 通过 `ptrace(2)` 从目标 JVM 进程**外部**读取内存，不需要目标 JVM 配合任何操作。这是 SA 在生产环境中不可替代的根本原因。

---

## §一 Task + Narrative + Beginner Callouts

### Task

写出一篇深度技术文档，覆盖：

1. **Tool 模板方法模式**: `execute()` (Tool.java:114) → `start(String[] args)` (Tool.java:133) → `startInternal()` (Tool.java:239) → `run()` (子类实现) → `stop()` (Tool.java:127) 的完整调用链 + 设计意图
2. **三种 attach 模式分派**: PID 解析 vs exec+core 解析 vs remote 解析的分派逻辑 (Tool.java:157-178)，以及 HotSpotAgent.attach() 的多态分派 (Tool.java:182-198)
3. **JStack 的双模式栈回溯**: PStack.java (含 native 帧，通过 CDebugger) vs StackTrace.java (纯 Java 帧，通过 JavaVFrame 迭代)，SALauncher.java 如何根据 `--mixed`/`--locks` flag 分派
4. **JMap 的堆遍历 + 多 GC 适配**: HeapSummary.java 如何通过 `instanceof CollectedHeap` 处理 6 种 GC (Serial/Parallel/G1/CMS/Shenandoah/Z/Epsilon)
5. **JInfo 的 VM flags 读取**: `VM.getVM().getCommandLineFlags()` 如何通过 `Arguments::_jvm_flags_array` 读取 VM flags
6. **SA 工具不需要目标 JVM 配合的根本原因**: 对比 `jcmd`/`jstat` 的协作模式（需要 JMX/target JVM 线程响应），SA 通过 `ptrace(2)` 从外部读取内存，不依赖目标进程内的任何代码执行

### Narrative

文档应该以**用户执行流**为主线：

```
$ jhsdb jstack --pid 4451
    ↓
SALauncher.main() [SALauncher.java:498-562]
    ├─ 解析 "jstack" 命令 → runJSTACK() [SALauncher.java:260-298]
    │   ├─ 解析 --pid/--exe/--core/--locks/--mixed
    │   └─ new JStack(false,false).runWithArgs(newArgs)
    ↓
JStack.runWithArgs() [JStack.java:70-91]
    ├─ 解析 -m (mixed mode) / -l (concurrent locks)
    └─ execute(args)  ← 调用 Tool 模板方法
    ↓
Tool.execute() [Tool.java:114-125]
    ├─ start(args)        ← 阶段1: 解析参数 + attach
    ├─ [finally] stop()   ← 阶段4: detach
    └─ System.exit(status)
    ↓
Tool.start() [Tool.java:133-225]
    ├─ 解析 args.length → 分派三种模式:
    │   ├─ case 1: pid 解析或 remote 解析 [Tool.java:157-166]
    │   └─ case 2: exe + core [Tool.java:169-173]
    ├─ HotSpotAgent.attach() → 执行 SA 启动流水线 (prompt-04)
    ├─ startInternal()   ← 阶段2: VM 版本检测
    │   ├─ VM.getVM().isCore()/isClientCompiler()/isServerCompiler()
    │   └─ run()         ← 阶段3: 子类实现的业务逻辑
    └─ return 0
    ↓
Tool.stop() [Tool.java:127-131]  ← finally 块保证执行
    └─ agent.detach()
    ↓
JStack.run() [JStack.java:58-68]
    ├─ if mixedMode → new PStack(false, concurrentLocks)
    │   ├─ initJFrameCache()   → Threads.first() 遍历 + JavaVFrame 缓存
    │   ├─ DeadlockDetector.print()  → 死锁检测
    │   └─ cdbg.getThreadList() → native 帧遍历 (通过 CDebugger)
    └─ else → new StackTrace(false, concurrentLocks)
        ├─ DeadlockDetector.print()  → 死锁检测
        ├─ Threads.first() → JavaThread 遍历 [StackTrace.java:73-126]
        └─ cur.getLastJavaVFrameDbg() → JavaVFrame 迭代
```

### Beginner Callouts (≥7 个，只在 §一 内)

> **💡 初学者提示 1**: SA 的"工具"本质上是一个**只读内存分析器**。所有的 `jstack`/`jmap`/`jinfo` 都不会让目标 JVM 执行任何诊断代码——它们只是通过 `ptrace(2)` 读取目标进程的内存，然后用 SA 的类型系统"解码"出有意义的信息（线程栈、对象直方图、VM flags）。

> **💡 初学者提示 2**: Tool 的模板方法模式确保**attach-detach 配对**。`execute()` 方法是 `final` 的（虽然没声明 final），子类不能 override 它，只能 override `run()`。这保证了 `start()` 和 `stop()` 一定配对执行（`stop()` 在 `finally` 块中），不会因为子类错误实现导致 `ptrace` 的 `PTRACE_DETACH` 漏掉。

> **💡 初学者提示 3**: `jstack` 的 PStack mode（`-m` 参数）和 StackTrace mode 的区别不只是"有没有 native 帧"——PStack 使用的是 `CDebugger`（C/C++ 调试器）遍历 native 线程栈，而 StackTrace 使用 `JavaThread.getLastJavaVFrameDbg()` 遍历 Java 虚拟栈帧。两者遍历的数据结构完全不同。

> **💡 初学者提示 4**: JMap 的 `-heap` 模式需要适配 6+ 种不同的 GC 实现。SA 通过 `instanceof CollectedHeap` 的**类型分派链**来适配不同 GC：`GenCollectedHeap`（Serial/CMS）→ `DefNewGeneration` + `Generation`；`G1CollectedHeap` → `G1MonitoringSupport`；`ParallelScavengeHeap` → `PSYoungGen`/`PSOldGen`；`ShenandoahHeap`/`EpsilonHeap`/`ZCollectedHeap` 各有专属打印逻辑。

> **💡 初学者提示 5**: JInfo 的 `printVMFlags()` 不在独立的 C++ 符号中——它通过 `VM.getVM().getCommandLineFlags()` 获取，后者通过 TypeDataBase 读取 `Arguments` 类中的 `_jvm_flags_array` 和 `_jvm_args_array` 字段。这意味着 SA 可以读取所有 `-XX:` 标记（包括被 `-XX:+PrintFlagsFinal` 隐藏的默认值），而不需要目标 JVM 执行任何代码。

> **💡 初学者提示 6**: SA 工具不需要 `-Dcom.sun.management.jmxremote` 也不需要开 JMX 端口。`jcmd` 需要在目标 JVM 的 `temp` 目录创建 `attach_pid<pid>` 文件，需要目标 JVM 有线程响应 `AttachListener`；`jstat` 需要 `PerfData` 共享内存文件。SA 通过 `ptrace(2) + /proc/<pid>/mem` 直接读取内存，**不依赖目标 JVM 的任何线程**。

> **💡 初学者提示 7**: SALauncher (SALauncher.java:498-562) 通过字符串匹配 `args[0].equals("jstack")` 来分派工具——这是一个简单的**命令路由**，不是反射。这保证了只有明确注册的工具才能被调用，防止注入攻击。

---

## §二 Standard Environment

### Source Roots

```
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/tools/          # 所有工具实现
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/                # SALauncher + HotSpotAgent
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/runtime/        # VM + Threads + JavaThread
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/oops/           # ObjectHeap + ObjectHistogram
src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/gc/             # GC 实现适配
```

### Key Classes

| 类 | 文件 | 行数 | 用途 |
|----|------|------|------|
| `Tool` | `tools/Tool.java` | 262 | **模板方法基类**: execute/start/startInternal/stop |
| `JStack` | `tools/JStack.java` | 100 | **线程栈**: PStack / StackTrace 分派 |
| `JMap` | `tools/JMap.java` | 212 | **堆分析**: 7 种 mode 分派 |
| `JInfo` | `tools/JInfo.java` | 178 | **配置查询**: flags / sysprops / both |
| `PStack` | `tools/PStack.java` | 280 | **混合模式栈**: CDebugger native 帧 + JavaVFrame 缓存 |
| `StackTrace` | `tools/StackTrace.java` | 141 | **纯 Java 栈**: JavaVFrame 迭代 |
| `HeapSummary` | `tools/HeapSummary.java` | 303 | **堆摘要**: 6 种 GC 适配 |
| `ObjectHistogram` | `tools/ObjectHistogram.java` | ~180 | **对象直方图**: ObjectHeap.iterate() |
| `SysPropsDumper` | `tools/SysPropsDumper.java` | 63 | **系统属性**: VM.getSystemProperties() |
| `SALauncher` | `SALauncher.java` | 563 | **命令路由**: main() 分派 jstack/jmap/jinfo |

### 模式常量

```java
// Tool.java:42-45
protected static final int DEBUGEE_PID    = 0;  // 附加到运行中的进程
protected static final int DEBUGEE_CORE   = 1;  // 分析 core dump
protected static final int DEBUGEE_REMOTE = 2;  // 远程调试服务器
```

### Build Command

```bash
# 全量构建 (产出 sa-jdi.jar)
make images

# 单独构建 sa-jdi.jar
make jdk.hotspot.agent-java

# 产出路径
images/jdk/lib/sa-jdi.jar
images/jdk/bin/jhsdb
```

### Running Commands

```bash
# JStack - 线程栈
jhsdb jstack --pid 1234                    # 纯 Java 栈（默认）
jhsdb jstack --mixed --pid 1234            # 含 native 帧
jhsdb jstack --locks --pid 1234            # 含 java.util.concurrent 锁
jhsdb jstack --mixed --locks --pid 1234    # 全量
jhsdb jstack --exe /usr/bin/java --core core.1234  # core dump 分析

# JMap - 堆分析
jhsdb jmap --heap --pid 1234               # 堆摘要（所有 GC）
jhsdb jmap --histo --pid 1234              # 对象直方图（内存泄漏排查）
jhsdb jmap --binaryheap --pid 1234         # 堆 dump (hprof binary)
jhsdb jmap --clstats --pid 1234            # 类加载器统计
jhsdb jmap --finalizerinfo --pid 1234      # 等待 finalize 的对象

# JInfo - 配置查询
jhsdb jinfo --flags --pid 1234             # VM flags (含 -XX:)
jhsdb jinfo --sysprops --pid 1234          # 系统属性
jhsdb jinfo --pid 1234                     # flags + sysprops
```

### 内部 Java 调用（从 SALauncher 桥接）

```
SALauncher.runJSTACK()  → JStack.runWithArgs()  → Tool.execute()
SALauncher.runJMAP()    → JMap.main()           → Tool.execute()
SALauncher.runJINFO()   → JInfo.runWithArgs()   → Tool.execute()
```

### Syscall 速查表

| Syscall | 用途 | 手册页 | 调用层 |
|---------|------|--------|--------|
| `ptrace(2)` | Live Mode: PTRACE_ATTACH + PEEKDATA + DETACH | `man 2 ptrace` | Native (`libsaproc.so`) |
| `pread(2)` | Core Mode: 文件偏移读取 | `man 2 pread` | Native (`libsaproc.so`) |
| `open(2)` | 打开 `/proc/<pid>/mem` 或 core 文件 | `man 2 open` | Native (`libsaproc.so`) |
| `mmap(2)` | PageCache 内存映射（可选） | `man 2 mmap` | `DebuggerBase.java` |

---

## §三 Source Files Table

| 文件 | 路径 | 行数 | 核心内容 |
|------|------|------|----------|
| `Tool.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/tools/` | 262 | **模板方法基类**: `execute()` (line 114), `start(String[])` (line 133), `startInternal()` (line 239), `stop()` (line 127), `debugeeType` 分派 (line 157-178) |
| `JStack.java` | `同上` | 100 | **栈回溯门面**: 构造函数 (line 30-33), `run()` (line 58-68) → PStack/StackTrace 分派, `runWithArgs()` (line 70-91) |
| `JMap.java` | `同上` | 212 | **堆分析门面**: 7 种 mode 常量 (line 66-72), `main()` 参数解析 (line 118-177), `run()` → 二级 Tool 分派 (line 76-116) |
| `JInfo.java` | `同上` | 178 | **配置查询门面**: mode 分派 (line 64-96), `printVMFlags()` (line 147-175), `runWithArgs()` (line 98-140) |
| `PStack.java` | `同上` | 280 | **混合栈**: `initJFrameCache()` (line 208-229), CDebugger native 帧遍历 (line 82-186), Java 帧匹配 (line 235-279) |
| `StackTrace.java` | `同上` | 141 | **纯 Java 栈**: `Threads.first()` 遍历 (line 73-126), `JavaThread.getLastJavaVFrameDbg()` (line 81), `JavaVFrame.javaSender()` 迭代 (line 81) |
| `HeapSummary.java` | `同上` | 303 | **堆摘要**: GC 分派 (line 96-150), G1 打印 (line 247-263), 内存格式化 (line 277-302) |
| `ObjectHistogram.java` | `同上` | ~180 | **对象直方图**: `ObjectHeap.iterate()` 遍历 + `ObjectHistogram.put()` 计数 |
| `SysPropsDumper.java` | `同上` | 63 | **系统属性**: `VM.getVM().getSystemProperties()` (line 44) |
| `SALauncher.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/` | 563 | **命令路由**: `main()` (line 498-562), `runJSTACK()` (line 260-298), `runJMAP()` (line 300-370), `runJINFO()` (line 372-410) |
| `Threads.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/runtime/` | 241 | **线程表**: `first()` (line 157-164), `createJavaThreadWrapper()` (line 173-182), VirtualConstructor 分派 (line 132-141) |
| `JavaThread.java` | `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/runtime/` | 510 | **Java 线程**: `next()` (line 123-130), `getLastFrame()` (line 200-205), `getLastJavaVFrameDbg()` (line 236-256), `printThreadInfoOn()` (line 481-509) |

---

## §四 Deep Dive Question Groups

### 问题组 1: Tool 模板方法模式 — execute() → start() → startInternal() → run() → stop()

**问题**: Why does the Tool base class use a template method pattern with the fixed sequence `execute() → start() → startInternal() → run() → stop()`? Why doesn't it use the strategy pattern where each tool implements `attachAndRun()` freely? What invariants does the template method guarantee?

**答案方向** (≥8 行):

**模板方法的完整调用流** (Tool.java:114-261):

```
execute(args)  [line 114, 子类调用]
    ↓
  try { start(args) } [line 118]
    ├─ 参数解析 + debugeeType 分派 [line 135-178]
    ├─ new HotSpotAgent() [line 180]
    ├─ switch(debugeeType) → agent.attach(...) [line 182-198]
    ├─ startInternal() [line 223]
    │   ├─ VM.getVM() 版本检测 [line 242-252]
    │   └─ run() ← 子类实现 [line 260]
    └─ return 0
    ↓
  finally { stop() } [line 120]
    └─ agent.detach() [line 128-130]
    ↓
  System.exit(status) [line 124]
```

**为什么用模板方法而非策略模式？**

1. **保证 attach-detach 配对**: `stop()` 在 `finally` 块中，确保无论 `start()` 是否抛异常，`agent.detach()` 一定被调用。如果改用策略模式（每个子类自由实现 `attachAndRun()`），某个子类可能忘记调用 `stop()`，导致 `ptrace(PTRACE_ATTACH)` 不复原——目标进程的 `TracerPid` 字段永久非零，阻止其他调试器附加。

2. **统一的参数解析**: `start()` 中的 switch-case 解析 `args.length` 来决定 attach 模式——这部分逻辑在所有工具中完全相同，模板方法消除了重复代码。如果每个工具自己解析参数，可能出现不一致的参数格式。

3. **版本检测在 r`un()` 之前**: `startInternal()` 输出 VM 版本、编译器类型（core/client/server），这是诊断输出的标准前缀——所有 SA 工具的 stdout 都以版本信息开头。

4. **统一退出码**: `execute()` 在 `finally` 块**之后**调用 `System.exit(returnStatus)`，保证 `stop()` 一定先于 `System.exit()` 执行。如果子类直接在 `run()` 中 `System.exit()`，会跳过 `stop()`。

**Counterfactual（反事实讨论）**:
> 如果 Tool 使用策略模式（定义 `AttachStrategy` 接口，`PidAttachStrategy`/`CoreAttachStrategy` 等），代码的**开闭原则**更好：添加新的 attach 模式不需要修改 `Tool.start()`。但这样会引入 `AttachStrategy` 的**生命周期管理**问题：谁负责创建？谁负责销毁？模板方法避免了这种复杂性——HotSpot 团队的工程权衡是"一致性 > 扩展性"，因为 SA 工具只有 3 种 attach 模式，不大可能新增。

**量化对比**:

| 方案 | 代码行数 | attach-detach 保证 | 参数解析一致性 | 扩展性 |
|------|---------|-------------------|---------------|--------|
| 模板方法（当前） | 150 行 | `finally` 保证 | 集中解析 | 低（新增 attach 需改 Tool.java） |
| 策略模式 | 200 行 | 需要各策略遵守约定 | 各策略独立解析 | 高（新增策略无需改 Tool.java） |
| 简单继承（无模板） | 120 行 | 无保证（靠代码 review） | 各子类独立 | 高但风险大 |

**源码引用**: `Tool.java:114-125` (`execute()`), `Tool.java:127-131` (`stop()`), `Tool.java:133-225` (`start()`), `Tool.java:239-261` (`startInternal()`)

---

### 问题组 2: 三种 Attach 模式的分派点 — PID / exec+core / remote

**问题**: `Tool.start()` 的 1 参数和 2 参数分派逻辑（Tool.java:157-178）如何处理 PID 与 remote 的歧义？如果用户传入主机名 `remote-server`，为什么不误解析为 PID？`HotSpotAgent.attach()` 的三个重载（PID/int、exec+core/String+String、remote/String）各自做了什么？（关联 prompt-04 的启动流水线）

**答案方向** (≥8 行):

**分派逻辑** (Tool.java:157-178):

```java
// Tool.java:157-166
switch (args.length) {
  case 1:
     try {
        pid = Integer.parseInt(args[0]);    // 尝试解析为整数
        debugeeType = DEBUGEE_PID;
     } catch (NumberFormatException e) {
        // 解析失败 → 认定为 remote
        remoteServer = args[0];
        debugeeType  = DEBUGEE_REMOTE;
     }
     break;

  case 2:
     executableName = args[0];
     coreFileName   = args[1];
     debugeeType    = DEBUGEE_CORE;
     break;
}
```

**歧义处理策略**:

1. **PID vs Remote 的歧义**: 依赖 `Integer.parseInt()` 的成败。如果参数是纯数字（`"4451"`）→ PID 模式；如果包含非数字字符（`"remote-server"` 或 `"192.168.1.1"`）→ Remote 模式。注意：IP 地址 `192.168.1.1` 虽然看起来像数字，但包含 `.` 分隔符，`Integer.parseInt()` 会失败，正确分派到 remote。

2. **潜在误判**:
   - 纯数字的主机名（如 `"12345"`）会被误判为 PID
   - 如果确实需要连接名为 `"12345"` 的远程调试服务器，用户必须使用 `server_id@12345` 格式（但当前实现不支持 `@` 语法）

**HotSpotAgent.attach() 的三条路径** (Tool.java:182-198):

```java
case DEBUGEE_PID:
   agent.attach(pid);                           // → HotSpotAgent.attach(int)
   // 内部调用: setupDebugger() → attachDebugger() → setupVM()
case DEBUGEE_CORE:
   agent.attach(executableName, coreFileName);  // → HotSpotAgent.attach(String,String)
   // 内部调用: setupDebugger() → attachDebugger(core) → setupVM()
case DEBUGEE_REMOTE:
   agent.attach(remoteServer);                  // → HotSpotAgent.attach(String)
   // 内部调用: setupDebugger(remote) → attachDebugger(remote) → setupVM()
```

**与 prompt-04 的连续性**: prompt-04 详述了 `HotSpotAgent` 的 `setupDebugger()` → `attachDebugger()` → `setupVM()` 三阶段。本文档的 `Tool.start()` 是这些方法的**调用者**——Tool 模板方法封装了 `attach()` 的参数解析和错误处理。

**Counterfactual**:
> 如果用一个统一的 `attach(AttachSpec spec)` 方法（`AttachSpec` 包含 `{type, pid, exe, core, remote}`），可以避免 `Integer.parseInt()` 的脆弱歧义解析。但需要引入新的类 `AttachSpec`，且 `HotSpotAgent` 需要根据 `type` 字段做内部分派——复杂度更高。当前方案虽然粗糙，但代码量少 30%。

**量化对比**:

| 方案 | 代码量 | 歧义风险 | 可读性 |
|------|--------|---------|--------|
| `Integer.parseInt` 分派（当前） | 20 行 | 中等（纯数字主机名误判） | 高（直观） |
| `AttachSpec` 统一抽象 | 50 行 | 低（显式 type 字段） | 高（显式） |
| `--pid`/`--exe`/`--remote` 显式 flag | 60 行（参数解析） | 无 | 最高 |

**源码引用**: `Tool.java:157-178` (分派逻辑), `Tool.java:182-198` (attach 分派), `HotSpotAgent.java:134` (attach(int pid)), `HotSpotAgent.java:380` (setupVM())

---

### 问题组 3: JStack 的栈回溯管线 — PStack（含 native 帧）vs StackTrace（纯 Java 帧）

**问题**: JStack 的 `-m` (mixed) 模式和纯 Java 模式的核心区别是什么？PStack 如何通过 `CDebugger.topFrameForThread()` 获取 native 帧，又如何通过 `initJFrameCache()` 注释 native 帧对应的 Java 方法？为什么 PStack 的输出格式（以 `----------------- thread -----------------` 分隔）与 StackTrace 不同？

**答案方向** (≥8 行):

**模式分派** (JStack.java:58-68):

```java
public void run() {
    Tool tool = null;
    if (mixedMode) {
        tool = new PStack(false, concurrentLocks);    // 含 native 帧
    } else {
        tool = new StackTrace(false, concurrentLocks); // 纯 Java 帧
    }
    tool.setAgent(getAgent());
    tool.setDebugeeType(getDebugeeType());
    tool.run();  // ← 绕过 Tool 模板方法，直接调用 run()
}
```

> **关键注意**: JStack.run() 创建的是**另一个 Tool 子类**（PStack 或 StackTrace），且直接调用 `tool.run()`，不经过 `execute()`。这意味着**没有自己的 attach-detach 生命周期**——它复用调用它的 Tool（JStack）已经完成的 `HotSpotAgent.attach()` 的结果。

**StackTrace 模式 — 纯 Java 帧** (StackTrace.java:73-126):

```
Threads.first() → JavaThread 遍历
    ↓
cur.printThreadInfoOn()  ← 输出线程头信息
    ↓
cur.getLastJavaVFrameDbg()  ← 获取最顶层的 JavaVFrame
    ↓
JavaVFrame.javaSender() 迭代  ← 遍历 Java 调用栈
    └─ vf.getMethod().externalNameAndSignature()
    └─ vf.getBCI() + method.getLineNumberFromBCI()
    └─ vf.printLockInfo()
    ↓
ConcurrentLocksPrinter.print()  ← 输出 java.util.concurrent 锁
```

**输出格式**:
```java
// StackTrace 输出示例 (StackTrace.java:76-125)
"http-nio-8080-exec-5" #42 daemon prio=5 tid=0x00007f8a1c0ba800 nid=0x7f8b waiting [0x00007f8a0a7fb000]
   java.lang.Thread.State: WAITING
   - jdk.internal.misc.Unsafe.park(Native Method) @bci=0
   - java.util.concurrent.locks.LockSupport.park(LockSupport.java:194) @bci=14, line=194
   - java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject.await(...) @bci=111, line=2084
```

**PStack 模式 — native + Java 混合** (PStack.java:61-194):

PStack 的流程比 StackTrace 复杂得多：

```
Step 1: initJFrameCache()  [PStack.java:208-229]
    ├─ Threads.first() → JavaThread 遍历
    ├─ cur.getLastJavaVFrameDbg() → 缓存所有线程的 JavaVFrame[]
    └─ proxyToThread.put(cur.getThreadProxy(), cur)

Step 2: DeadlockDetector.print()  [PStack.java:77]

Step 3: cdbg.getThreadList()  [PStack.java:82]  ← native 线程列表
    ├─ cdbg.topFrameForThread(th) → CFrame  [PStack.java:87]
    └─ while (f != null) 遍历 native 帧:
        ├─ f.closestSymbolToPC()  ← DWARF 符号解析
        │   ├─ 命中: 输出符号名 + 偏移量
        │   └─ 未命中 (无 DWARF 符号):
        │       ├─ Interpreter.contains(pc)?  → 打印解释器 codelet
        │       ├─ CodeCache.contains(pc)?     → 判断 CodeBlob 类型:
        │       │   ├─ isNMethod() + isNativeMethod() → "Native method"
        │       │   ├─ isNMethod() → getJavaNames() 关联 Java 帧
        │       │   ├─ isBufferBlob() → "<StubRoutines>"
        │       │   ├─ isRuntimeStub() → "<RuntimeStub>"
        │       │   ├─ isDeoptimizationStub() → "<DeoptimizationStub>"
        │       │   └─ ...
        │       └─ 否则 → printUnknown() [PStack.java:231-233]
        └─ f = f.sender(th)  ← 向上一帧
```

**getJavaNames() 的 Java 帧注释** (PStack.java:235-279):
- 遍历 `jframeCache` 中匹配的 `JavaVFrame[]`
- 通过 `f.getFP()` 匹配 native 帧和 Java 帧的 Frame Pointer
- 在 native 帧行下方打印带 `*` 前缀的 Java 方法签名

**PStack 输出格式**:
```
----------------- 0x00007f8a1c0ba800 -----------------
"http-nio-8080-exec-5" #42 daemon prio=5 tid=0x00007f8a1c0ba800 nid=0x7f8b waiting
...
0x00007f8a12345678    libpthread.so!pthread_cond_wait + 0x12
0x00007f8a1234abcd    libjvm.so!os::PlatformEvent::park() + 0x45
0x00007f8a1235ef01    libjvm.so!Monitor::IWait() + 0x98
* java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject.await() bci:111 line:2084 (Compiled frame)
```

**PStack 的平台限制 — Darwin 不支持** (PStack.java:62-64):

```java
if (PlatformInfo.getOS().equals("darwin")) {
    out.println("Not available on Darwin");
    return;
}
```

macOS (Darwin) 没有 CDebugger 实现，PStack 在 macOS 上直接 bail out。这是 SA 工具的一个重要限制 — root cause 是 macOS 的调试 API (Mach API) 与 Linux 的 ptrace 模型根本不同。

**8 种 CodeBlob 子类型分派** (PStack.java:147-161):

无 DWARF 符号时，PStack 通过 `CodeCache.findBlobUnsafe(pc)` 查找 CodeBlob 并分派：
- `isNMethod()` — 已编译方法（Java 或 native）
- `isBufferBlob()` → `<StubRoutines>` — 桩例程
- `isRuntimeStub()` → `<RuntimeStub>` — 运行时桩
- `isDeoptimizationStub()` → `<DeoptimizationStub>` — 去优化桩
- `isUncommonTrapStub()` → `<UncommonTrap>` — 非常见陷阱
- `isExceptionStub()` → `<ExceptionStub>` — 异常桩
- `isSafepointStub()` → `<SafepointStub>` — 安全点桩
- 无匹配 → `<Unknown code blob>`

**DeadlockDetector + ConcurrentLocksPrinter 调用顺序** (PStack.java:72-80, 180-185):

PStack 在主循环之前先调用 `DeadlockDetector.print(out)`（PStack.java:77），检测 Java 级死锁（通过 monitor 等待图 DFS）。主循环结束后为每个匹配到的 Java 线程调用 `concLocksPrinter.print(jthread, out)`（PStack.java:180-185），打印 `java.util.concurrent` 锁持有者信息。

**StackTrace 的附加细节** (StackTrace.java:76-128):

- **`isJavaThread()` 守卫** (StackTrace.java:76): 只打印 JavaThread，跳过 NonJavaThread（如 VMThread、WatcherThread）
- **每帧 `printLockInfo()`** (StackTrace.java:114): 每个 Java 帧都打印该帧持有的 Monitor 锁信息
- **外层 `AddressException` catch** (StackTrace.java:128-131): 整个线程遍历包裹在一个 `AddressException` catch 中，防止非法内存地址导致整个工具崩溃
- **死锁检测**: StackTrace 同样在主循环前调用 `DeadlockDetector.print(tty)` (StackTrace.java:62)

**为什么输出格式不同？**

PStack 的输出以 `CDebugger` 的 native 线程列表为锚点，Java 帧是"注释"。StackTrace 的输出以 `JavaThread` 的 Java 帧为主角。这是两种不同的"调试视角"：native 调试器视角（PStack）vs Java 调试器视角（StackTrace）。

**Counterfactual**:
> 如果合并 PStack 和 StackTrace 为一个类，用 `if (mixedMode)` 分支控制，代码会更紧凑（减少 ~100 行重复的线程信息打印代码）。但两个类的遍历逻辑完全不同：PStack 用 `CDebugger.getThreadList()`，StackTrace 用 `Threads.first()`。合并会引入大量嵌套 `if-else`，破坏可读性。当前**策略模式**的分拆虽然重复了 `printThreadInfoOn()` 和 `ConcurrentLocksPrinter`，但每个类的遍历逻辑清晰。

**量化对比**:

| 方面 | PStack (mixed mode) | StackTrace (Java only) |
|------|---------------------|----------------------|
| 线程列表来源 | `cdbg.getThreadList()` (native) | `Threads.first()` (Java) |
| 帧信息来源 | `CFrame` (CDebugger) | `JavaVFrame` (SA runtime) |
| 符号解析 | DWARF symtab (C++ symbols) | Java method metadata |
| 输出行数/线程 | 50+ (含 native 帧) | 10-20 (仅 Java 帧) |
| 性能 | 慢 (需解析 DWARF) | 快 |
| StackTrace 默认 | 否 | 是 |

**源码引用**: `JStack.java:58-68` (分派), `PStack.java:208-229` (initJFrameCache), `PStack.java:82-186` (native 帧遍历), `PStack.java:235-279` (getJavaNames), `StackTrace.java:73-126` (Java 帧遍历)

---

### 问题组 4: JMap 的堆遍历 + 多 GC 适配

**问题**: JMap 支持 7 种 mode（MODE_HEAP_SUMMARY / HISTOGRAM / CLSTATS / PMAP / HPROF_BIN / GXL / FINALIZERINFO），每种 mode 的实现类如何管理自己的 attach 生命周期？`HeapSummary` 如何通过 `instanceof CollectedHeap` 处理 6 种 GC？`ObjectHistogram.iterate()` 的遍历性能瓶颈是什么？

**答案方向** (≥8 行):

**7 种 Mode 分派** (JMap.java:76-116):

```java
public void run() {
    Tool tool = null;
    switch (mode) {
        case MODE_HEAP_SUMMARY:   tool = new HeapSummary();    break;
        case MODE_HISTOGRAM:      tool = new ObjectHistogram();  break;
        case MODE_CLSTATS:        tool = new ClassLoaderStats(); break;
        case MODE_PMAP:           tool = new PMap();           break;
        case MODE_HEAP_GRAPH_HPROF_BIN:
            writeHeapHprofBin(dumpfile); return;  // 不创建 Tool
        case MODE_HEAP_GRAPH_GXL:
            writeHeapGXL(dumpfile); return;       // 不创建 Tool
        case MODE_FINALIZERINFO:  tool = new FinalizerInfo();  break;
    }
    tool.setAgent(getAgent());       // 传递 agent 引用
    tool.setDebugeeType(getDebugeeType());
    tool.run();                      // ← 直接调用 run()，绕过 execute()
}
```

**关键设计**:
- `HeapDumper` (HPROF_BIN/GXL) 不创建 Tool 子类——它直接调用 `writeHeapHprofBin()`，后者创建 `HeapHprofBinWriter` 并调用 `write()`。堆 dump 的遍历逻辑与 Tool 模板方法无关。
- 其他 mode（HeapSummary/ObjectHistogram/ClassLoaderStats/PMap/FinalizerInfo）创建二级 Tool 子类，**绕过 `execute()`**，直接调用 `tool.run()`。这意味着不重新 attach-detach。

**HeapSummary 的 6 种 GC 适配** (HeapSummary.java:96-150):

```
VM.getVM().getUniverse().heap() → CollectedHeap
    ↓ instanceof 分派链:
    ├─ GenCollectedHeap     → Serial / CMS 分代 GC
    │   └─ genHeap.nGens() 遍历 Generation(s)
    │       ├─ DefNewGeneration → Eden + From + To
    │       └─ Generation → name() + capacity/used/free
    ├─ G1CollectedHeap      → G1 GC
    │   └─ G1MonitoringSupport → edenRegionNum/survivorRegionNum/oldSet
    ├─ ParallelScavengeHeap → Parallel GC
    │   └─ PSYoungGen (Eden + From + To) + PSOldGen
    ├─ ShenandoahHeap       → Shenandoah GC
    │   └─ numOfRegions / regionSizeBytes / used / committed
    ├─ EpsilonHeap          → No-op GC
    │   └─ eh.space() → ContiguousSpace
    └─ ZCollectedHeap       → ZGC
        └─ zheap.printOn(System.out)  ← 委托给 ZGC 自己的打印方法
```

**为什么用 `instanceof` 而不是虚函数分派？**

`CollectedHeap` 是 SA 的 Java 代理对象（wrapper），不是真正的 C++ 对象——它在 SA 的 TypeDataBase 中只有偏移量信息，**没有虚函数表**（vtable）。SA 无法通过 vtable 调用 `printOn()` 虚函数，必须在 Java 层通过 `instanceof` 手动分派。这体现了 SA 的"代理模式"限制：SA 的 Java 对象只包装了 C++ 对象的内存布局，没有方法。

**printGCAlgorithm() — 通过 VM Flag 独立检测 GC 类型** (HeapSummary.java:157-208):

在 GC 内存结构遍历之前，HeapSummary 还有一个**独立的 GC 算法检测**逻辑，通过 VM flag 判断（不等同于 `instanceof` 分派）：

```
UseConcMarkSweepGC → "Concurrent Mark-Sweep GC"
UseParallelGC      → "Parallel GC with N thread(s)"
UseG1GC            → "Garbage-First (G1) GC with N thread(s)"
UseEpsilonGC       → "Epsilon (no-op) GC"
UseZGC             → "ZGC with N thread(s)"
UseShenandoahGC    → "Shenandoah GC with N thread(s)"
fallback           → "Mark Sweep Compact GC" (Serial GC)
```

**重要**: `printGCAlgorithm()` 和 `instanceof` 分派链是**两条独立路径**：前者通过 flag 检测（配置层），后者通过内存结构检测（运行时层）。CMS 在 flag 检测中存在，但在 `instanceof` 链中走 `GenCollectedHeap` 分支（因为 CMSHeap 继承自 GenCollectedHeap）。

**Heap Configuration 段** (HeapSummary.java:75-91):

在 GC 算法检测和堆使用信息之间，HeapSummary 还打印了**Heap Configuration** 段，输出 11 个关键 VM flag：
- MinHeapFreeRatio, MaxHeapFreeRatio, MaxHeapSize
- NewSize, MaxNewSize, OldSize
- NewRatio, SurvivorRatio
- MetaspaceSize, CompressedClassSpaceSize, MaxMetaspaceSize
- Shenandoah 特判: `ShenandoahHeapRegion.regionSizeBytes()` vs 其他 GC 的 `HeapRegion.grainBytes()`

**ObjectHistogram 的遍历性能** (ObjectHistogram.java:50-61+):

```java
public void run(PrintStream out, PrintStream err) {
    ObjectHeap heap = VM.getVM().getObjectHeap();
    sun.jvm.hotspot.oops.ObjectHistogram histogram =
        new sun.jvm.hotspot.oops.ObjectHistogram();
    heap.iterate(histogram);  // 遍历整个堆的每个对象
    histogram.printOn(out);
}
```

**性能瓶颈**:
1. **全堆遍历**: 必须读取堆中每个 Oop 的 klass 指针 → 对于 10GB 堆和 1 亿对象，需要 1 亿次 `readBytesFromProcess()` → 1 亿次 PTRACE_PEEKDATA（无 PageCache 场景）或 ~2000 万次（80% 缓存命中率）
2. **PageCache 失效**: 堆对象分布在不同的 4KB 页上，GC 的碎片化会降低缓存命中率
3. **Klass 名字解析**: 每次 `histogram.put()` 需要读取 klass name（`InstanceKlass._name` → `Symbol._body`），又是一次内存读取

**Counterfactual**:
> 如果 SA 不走"全堆遍历"而是通过 GC 的内部数据结构（如 G1 的 `_hrs` 堆区域表），可以跳过空闲区域，减少 ~50% 的内存读取。但 G1/Parallel/CMS/Shenandoah 的内部数据结构各不相同，需要每种 GC 单独实现遍历器——代码量爆炸（~500 行/GC × 6 GCs）。当前全堆遍历虽然慢，但**对所有 GC 通用**。

**量化对比**:

| GC | HeapSummary 分派方式 | 输出内容 |
|----|---------------------|---------|
| Serial/CMS (`GenCollectedHeap`) | `genHeap.nGens()` 迭代 Generation | DefNew + Old 分代 + Eden/From/To |
| G1 (`G1CollectedHeap`) | `G1MonitoringSupport` 指标 | Eden/Survivor/Old/Humongous |
| Parallel (`ParallelScavengeHeap`) | `PSYoungGen`/`PSOldGen` 直接访问 | PSYoung (Eden/From/To) + PSOld |
| Shenandoah (`ShenandoahHeap`) | `numOfRegions()` + `used()` | regions / capacity / used / committed |
| Epsilon (`EpsilonHeap`) | `eh.space()` → ContiguousSpace | capacity / used / free |
| ZGC (`ZCollectedHeap`) | `zheap.printOn()` 委托 | ZGC 专有指标 |

**源码引用**: `JMap.java:76-116` ( mode 分派), `HeapSummary.java:96-150` (GC 分派), `HeapSummary.java:157-208` (printGCAlgorithm), `HeapSummary.java:75-91` (Heap Configuration), `ObjectHistogram.java:50-61` (遍历), `HeapSummary.java:247-263` (G1 打印)

---

### 问题组 5: JInfo 的 VM flags 读取 — printVMFlags() 的数据来源

**问题**: `JInfo.printVMFlags()` (JInfo.java:147-175) 如何通过 `VM.getVM().getCommandLineFlags()` 获取 VM flags？`VM.Flag` 对象的数据来源于目标 JVM 的哪个 C++ 结构？为什么 `Arguments.getJVMFlags()` 和 `Arguments.getJVMArgs()` 分开读取（`-XX:` flags vs application args）？

**答案方向** (≥8 行):

**printVMFlags() 的数据流** (JInfo.java:147-175):

```
printVMFlags()
    ↓
VM.getVM().getCommandLineFlags()  ← 返回 VM.Flag[]
    ↓ 内部实现 (VM.java, 通过 TypeDataBase):
Arguments 类的 _jvm_flags_array 字段
    ↓ 结构:
struct JVMFlag {
    const char* _name;     // flag 名称 ("MaxHeapSize", "UseG1GC")
    const char* _type;     // 类型 ("bool", "intx", "uintx", "ccstr")
    int         _origin;   // 来源 (0=DEFAULT, 1=COMMAND_LINE, 2=ERGONOMIC, 3=MANAGEMENT)
    union {
        bool   _bool;
        intx   _intx;
        uintx  _uintx;
    } _value;
};
```

**VM.Flag 对象结构** (Java 层):
```java
// VM.java 内部类
public static class Flag {
    private String name;
    private String value;
    private int    origin;
    private boolean isBool;

    public String getName()  { return name; }
    public String getValue() { return value; }
    public int getOrigin()   { return origin; }
    public boolean isBool()  { return isBool; }
    public boolean getBool() { return Boolean.parseBoolean(value); }
}
```

**printVMFlags() 的过滤逻辑** (JInfo.java:147-175):
```java
VM.Flag[] flags = VM.getVM().getCommandLineFlags();
for (VM.Flag flag : flags) {
    if (flag.getOrigin() == 0) {
        continue;  // 跳过默认值 (origin=0=DEFAULT)
    }
    if (flag.isBool()) {
        String onoff = flag.getBool() ? "+" : "-";
        System.out.print("-XX:" + onoff + flag.getName() + " ");
    } else {
        System.out.print("-XX:" + flag.getName() + "=" + flag.getValue() + " ");
    }
}
```

**为什么分开 `Arguments.getJVMFlags()` 和 `Arguments.getJVMArgs()`?** (JInfo.java:165-173):

- `Arguments.getJVMFlags()`: 读取 `Arguments::_jvm_flags_array`——**`-XX:` 启动参数**，如 `-XX:+UseG1GC -XX:MaxHeapSize=4294967296`
- `Arguments.getJVMArgs()`: 读取 `Arguments::_jvm_args_array`——**应用参数**（`-cp`, `MainClass`, `arg1`, `arg2`...）

两者在目标 JVM 中是**不同的数组**：`_jvm_flags_array` 是 `JVMFlag*[]`，`_jvm_args_array` 是 `char*[]`。分开读取是因为两者的结构体类型不同（`JVMFlag` vs `const char*`），SA 的 TypeDataBase 无法统一处理。

**JInfo 的三种 mode** (JInfo.java:64-96):

| Mode | 常量 | 实现 |
|------|------|------|
| MODE_FLAGS | 0 | 直接调用 `printVMFlags()`，不创建二级 Tool |
| MODE_SYSPROPS | 1 | 创建 `SysPropsDumper`，作为 Tool.run() 调用 |
| MODE_BOTH | 2 | 创建**匿名 Tool 子类**，依次调用 SysPropsDumper + printVMFlags() |

**Counterfactual**:
> 如果 JInfo 不通过 TypeDataBase 而通过 `ManagementFactory.getRuntimeMXBean().getInputArguments()` 获取 VM flags，代码更简单（一行 API 调用）。但 `ManagementFactory` 需要目标 JVM 响应 JMX 请求——这正是 SA 想要避免的依赖。SA 的 TypeDataBase 路径从目标进程内存中**直接读取** `Arguments` 对象，不需要目标 JVM 执行任何代码。

**量化对比**:

| 方案 | 依赖 | 需要目标 JVM 配合 | 读取范围 |
|------|------|-----------------|---------|
| TypeDataBase (SA 当前) | ptrace + vmStructs | 不需要 | 所有 flags 含默认值 |
| JMX (`ManagementFactory`) | JMX 端口 + RMI | 需要 | 仅命令行 flags |
| `/proc/<pid>/cmdline` | 无 | 不需要 | 仅命令行参数（无 `-XX:`） |

**源码引用**: `JInfo.java:147-175` (`printVMFlags()`), `JInfo.java:64-96` ( mode 分派), `VM.java` (getCommandLineFlags()), `Arguments.java` (需搜索 `src/jdk.hotspot.agent/share/classes/sun/jvm/hotspot/runtime/Arguments.java`)

---

### 问题组 6: SA 工具的性能瓶颈与优化

**问题**: 100GB+ 堆的 `jmap -histo` 为什么可能需要数分钟甚至数小时？PageCache 的 16MB 缓存（4096 页 × 4KB）在堆遍历场景下命中率有多高？`process_vm_readv(2)` 能否替代 `ptrace(PTRACE_PEEKDATA)` 来提升性能？SA 工具能否并行化？（如多线程遍历堆的不同区域）

**答案方向** (≥8 行):

**性能瓶颈的根因**:

1. **syscall 次数爆炸**:
   - 100GB 堆 ≈ 2.5 亿对象（假设平均 400 字节/对象）
   - 每个对象需要读取 `klass` 指针（8 字节）→ `readBytesFromProcess()` → `ptrace(PTRACE_PEEKDATA)`
   - 无缓存: 2.5 亿次 `ptrace` 调用
   - 每次 `ptrace(PTRACE_PEEKDATA)` 耗时 ~1μs → 总耗时: 2.5 亿 × 1μs = **250 秒**

2. **PageCache 实际命中率**:
   - 堆对象的 `klass` 指针分散在堆中，局部性差
   - 理论上 4KB 页可容纳 512 个 `klass` 指针（8 字节×512）
   - 但 GC 碎片化导致同一页内的对象来自不同 class → `klass` 指针可能跨越多个页
   - **实际命中率**: 60-70%（远低于 jstack 的 80-90%）
   - 2.5 亿 × 40% = 1 亿次 `ptrace` → 100 秒

3. **Klass name 解析的二次开销**:
   - 每次 `ObjectHistogram.put(klass)` 需要读取 `InstanceKlass._name` → `Symbol._body`
   - 虽然 `Symbol` 通常在同一页，但每次都是新的 `readBytesFromProcess()` 调用
   - 增加 ~50% 的额外 syscall

**优化方案**:

1. **增大 PageCache**: 从 16MB (4096 页) 增大到 64MB (16384 页) 或 256MB，对 100GB 堆的命中率提升有限（因为缓存只覆盖堆的 0.06-0.25%）

2. **使用 `process_vm_readv(2)`** (Linux 3.2+):
   - 单次 syscall 可读取多个不连续的地址区域（`struct iovec[]`）
   - SA 可以批量收集 N 个对象的 `klass` 指针地址，一次 syscall 全读出
   - 减少 syscall 次数: 2.5 亿 → 2500 万（每次读 10 个指针）→ 25 秒
   - **但**: SA 当前不支持 `process_vm_readv`，因为需要跨平台兼容性（macOS/Windows 没有对应系统调用）

3. **堆遍历并行化**:
   - 理论上可以多线程遍历堆的不同区域（G1 regions / ParallelGC generations）
   - **但**: SA 的 `Debugger` 对象不是线程安全的——多线程同时调用 `readBytesFromProcess()` 会导致 `ptrace` 交错
   - 需要每个线程维护独立的 `Debugger` 连接（`PTRACE_ATTACH` 在同一进程上只允许一次）

4. **跳过空闲区域**: 如果 GC 数据结构支持（如 G1 的 BOT - BlockOffsetTable），可以跳过未分配区域

**Counterfactual**:
> 如果 SA 不遍历整个堆，而是使用 JVM TI 的 `IterateThroughHeap` 回调，可以在 JVM 进程内部高效遍历——但需要目标 JVM 配合（JVMTI agent 加载），这破坏了 SA "不需要目标 JVM 配合"的核心优势。SA 的设计权衡是"不依赖目标 JVM > 性能"。

**量化对比**:

| 优化方案 | syscall 减少 | 实现复杂度 | 跨平台兼容 |
|---------|-------------|-----------|-----------|
| 增大 PageCache (64MB) | 提高命中率 5% | 低（改一个参数） | 完全 |
| `process_vm_readv(2)` | 减少 90% | 高（改 Native 层） | 仅 Linux |
| 堆遍历并行化 | 线性加速 (N 线程) | 高（Debugger 需线程安全） | 中等 |
| 跳过空闲区域 | 减少 40-60% | 中（每种 GC 单独实现） | 完全 |

**源码引用**: `DebuggerBase.java:66` (cache 字段), `DebuggerBase.java:222-233` (readBytes with cache), `ObjectHistogram.java:50-61` (遍历入口), `ObjectHeap.java` (iterate 实现，需搜索)

---

## §五 Article Structure

文档应按以下结构组织（`##` 表示一级章节，`###` 表示二级章节）：

```
# 05 SA 工具遍历路径 — Tool 模板方法 + JStack/JMap/JInfo 管线

### §一 Tool 模板方法模式：execute() → start() → startInternal() → run() → stop()
### 1.1 execute() 入口：finally 保证 stop() 一定执行
### 1.2 start(String[] args)：三种 attach 模式的参数解析与分派
### 1.3 startInternal()：VM 版本检测 + run() 委托
### 1.4 stop()：agent.detach() 的 finally 保证
### 1.5 设计模式对比：模板方法 vs 策略模式 vs 简单继承

### §二 JStack — 双模式栈回溯管线
### 2.1 run() 分派：mixedMode → PStack vs StackTrace
### 2.2 StackTrace 模式：纯 Java 帧遍历（Threads.first() + JavaVFrame 迭代）
### 2.3 PStack 模式：native 帧遍历（CDebugger + DWARF 符号解析）
### 2.4 initJFrameCache()：JavaVFrame 缓存 + proxyToThread 映射
### 2.5 getJavaNames()：native 帧到 Java 帧的 FP 匹配
### 2.6 并发锁打印：DeadlockDetector + ConcurrentLocksPrinter
### 2.7 输出示例：PStack 输出 vs StackTrace 输出 vs kill -3 输出

### §三 JMap — 7 种 Mode 的堆遍历管线
### 3.1 run() 分派：7 种 mode 的 switch-case
### 3.2 MODE_HEAP_SUMMARY：HeapSummary 的 6 种 GC 适配
### 3.3 MODE_HISTOGRAM：ObjectHistogram 的全堆遍历
### 3.4 MODE_HEAP_GRAPH_HPROF_BIN：HeapHprofBinWriter 的堆 dump
### 3.5 MODE_CLSTATS：ClassLoaderStats 的类加载器遍历
### 3.6 MODE_PMAP：PMap 的内存映射（Solaris pmap 兼容）
### 3.7 MODE_FINALIZERINFO：FinalizerInfo 等待 finalize 的对象列表
### 3.8 输出示例：jmap -heap / -histo 的真实输出格式

### §四 JInfo — VM flags + System Properties 的只读路径
### 4.1 run() 分派：FLAGS / SYSPROPS / BOTH 三种 mode
### 4.2 printVMFlags()：VM.getVM().getCommandLineFlags() 的数据来源
### 4.3 VM.Flag 结构：name/value/origin/isBool 的字段含义
### 4.4 Arguments.getJVMFlags() vs Arguments.getJVMArgs()：-XX: vs 应用参数
### 4.5 SysPropsDumper：VM.getVM().getSystemProperties() 实现
### 4.6 输出示例：jinfo -flags / -sysprops 的真实输出格式

### §五 SALauncher — 命令路由与参数桥接
### 5.1 main() 命令分派（jstack / jmap / jinfo / jsnap / debugd / clhsdb / hsdb）
### 5.2 runJSTACK()：--pid/--exe/--core/--locks/--mixed 的参数转换 + buildAttachArgs
### 5.3 runJMAP()：--heap/--histo/--binaryheap/--clstats 的参数转换
### 5.4 runJINFO()：--flags/--sysprops 的参数转换
### 5.5 buildAttachArgs()：统一构造 Tool 参数数组（互斥检查）
### 5.6 runCLHSDB() / runHSDB()：交互式命令行/GUI 调试器（简要说明）

### §六 SA 工具不需要目标 JVM 配合 — 与 jcmd/jstat 的对比
### 6.1 jcmd 的 AttachListener 机制：需要目标 JVM 有空闲线程响应
### 6.2 jstat 的 PerfData 共享内存：需要目标 JVM 初始化 PerfData
### 6.3 SA 的 ptrace 外部分析：不依赖目标 JVM 的任何线程
### 6.4 生产故障场景对比：OOM/线程池满/死锁时，谁还能工作？
### 6.5 SA 的"外科手术"价值：可以附加到已挂起的进程

### §七 边缘场景与诊断工具
### 7.1 工具参数解析的歧义：纯数字主机名被误判为 PID
### 7.2 工具对 core dump 的支持：exec+core 模式下的行为差异
### 7.3 Darwin (macOS) 限制：PStack 在 Darwin 上不可用（CDebugger 无实现）
### 7.4 大堆分析超时：jmap -histo 在 100GB+ 堆上的实际耗时
### 7.5 诊断工具五件套：strace + jhsdb + jstack + GDB + /proc
### 7.6 Remote 模式限制：CDebugger 在远程调试中不可用
### 7.7 CLI 工具 vs GUI 工具：clhsdb/hsdb 的适用场景
```

---

## §六 Writing Requirements

### 6.1 总体原则

1. **用户场景先行**: 每节的工作原理从用户看到的输出/命令开始，再逆向解释内部实现
2. **源码是证据（20%），原理是正文（80%）**: 不要逐行翻译代码，要解释"为什么这么设计"
3. **每个技术断言必须标注 file:line 引用**: 如 `Tool.java:157-166`
4. **对比标准 jcmd/jstat**: 这是本文档的独特价值——解释 SA 为什么不需要目标 JVM 配合
5. **包含真实输出示例**: jstack stdout、jmap -heap stdout、jmap -histo stdout、jinfo -flags stdout
6. **量化对比优先**: 用表格/数字说明性能差距、代码量、模式差异

### 6.2 "不要写成→应该写成"对照表

| 不要写成 | 应该写成 |
|---------|---------|
| 只解释 Tool.execute() 的 finally 块 | 解释为什么 `finally` 保证了 `PTRACE_DETACH` 一定发生，以及跳过 `stop()` 的后果（目标进程 TracerPid 永久非零） |
| 只说"JStack 有 mixed 和 pure 两种 mode" | 解释两种 mode 的遍历数据结构完全不同（`CDebugger.getThreadList()` vs `Threads.first()`），以及为什么输出格式不同（native 线程列表 vs Java 线程列表） |
| 只说"JMap 支持 7 种 mode" | 解释每种 mode 如何创建/复用 attach 生命周期（二级 Tool 直接调用 `run()` 而非 `execute()`），以及 HeapDumper 不走 Tool 模板方法的原因 |
| 只说"JInfo 读取 VM flags" | 解释 `VM.Flag` 的 `origin` 字段如何过滤默认值（`origin == 0` 跳过），以及 `Arguments._jvm_flags_array` 在目标 JVM 中的 C++ 结构 |
| 只说"HeapSummary 适配多种 GC" | 用 `instanceof` 分派链解释为什么不能走虚函数（SA 的代理模式没有 vtable），并列出所有 GC 的特化打印（Serial/CMS/Parallel/G1/Shenandoah/Epsilon/ZGC） |
| 只说"SA 工具不需要 target JVM 配合" | 对比 `jcmd` (需要 AttachListener + Signal Dispatcher 线程) 和 `jstat` (需要 PerfData 共享内存 /tmp 文件) 的依赖链，解释在生产 OOM/线程池满时为什么只有 SA 可用 |
| 只说"PStack 用 initJFrameCache()" | 解释为什么需要缓存 JavaVFrame（CDebugger 和 JavaThread 的线程列表不一定顺序一致，需要 `proxyToThread.get(th)` 映射） |
| 只贴代码片段不解释 | 每段代码后跟 3-5 行解释：意图、关键点、与前后文的关联 |

### 6.3 源码阅读要求

1. **读核心文件**: Tool.java → JStack.java → JMap.java → JInfo.java → PStack.java → StackTrace.java → HeapSummary.java
2. **追踪执行流**: 从 `jhsdb jstack --pid 4451` 到 SALauncher → JStack → Tool.execute() → start() → startInternal() → run() → PStack/StackTrace
3. **对比标准工具**: 搜索 `jcmd` 的 `AttachListener.cpp`（`src/hotspot/share/services/attachListener.cpp`），对比 SA 的 ptrace 路径
4. **验证 GC 适配**: 搜索每种 GC 的 SA 实现类（`G1CollectedHeap.java`, `ParallelScavengeHeap.java`, `ShenandoahHeap.java`），验证 HeapSummary 的 `instanceof` 分派链正确性

---

## §七 Output Format

### 7.1 文件格式

- **格式**: GitHub Flavored Markdown (`.md`)
- **编码**: UTF-8
- **行宽**: 100 字符（方便终端阅读）
- **标题**: `# 05 SA 工具遍历路径 — Tool 模板方法 + JStack/JMap/JInfo 管线`

### 7.2 代码块格式

```java
// 代码块必须标注文件路径和行号范围
// 示例：
// Tool.java:114-125

protected void execute(String[] args) {
    int returnStatus = 1;
    try {
        returnStatus = start(args);
    } finally {
        stop();
    }
    System.exit(returnStatus);
}
```

### 7.3 输出示例格式

SA 工具的真实输出必须用代码块呈现（带 `###` 标题解释）：

```
### StackTrace 输出示例

"http-nio-8080-exec-5" #42 daemon prio=5 tid=0x00007f8a1c0ba800 nid=0x7f8b waiting [0x00007f8a0a7fb000]
   java.lang.Thread.State: WAITING
   - jdk.internal.misc.Unsafe.park(Native Method) @bci=0
   - java.util.concurrent.locks.LockSupport.park(LockSupport.java:194) @bci=14, line=194
```

### 7.4 Callout 格式

使用 `> **💡 初学者提示 X**` 格式（仅在 §一 中，不重复）：

```markdown
> **💡 初学者提示 8**: 这是第 8 个 callout（如果需要超过 7 个）。
```

### 7.5 章节编号

使用 `## §一` `### 1.1` 格式，完成后运行 `rg '^## §' <file>.md` 验证连续无跳号。

---

## §八 Prohibited（≥8 条）

1. **禁止写成源码翻译**: 不要逐行解释代码，要提炼工具设计模式、attach 生命周期管理、遍历管线
2. **禁止遗漏 file:line 引用**: 每个技术断言必须标注源码位置
3. **禁止忽略 SA 不需要目标 JVM 配合的对比**: 必须与 jcmd/jstat 做详细对比（依赖链、故障场景可用性）
4. **禁止跳过 counterfactual 讨论**: §四 的每个问题组必须包含"如果选另一个方案会怎样"
5. **禁止在 §一 以外添加 Beginner Callout**: Callout 只能在 §一 内，避免重复
6. **禁止遗漏 man 手册引用**: 每个系统调用必须标注 `man 2 ptrace` / `man 2 process_vm_readv` 等
7. **禁止写成科普文**: 本文档的目标读者是有 Java 和 Linux 系统编程经验的工程师
8. **禁止遗漏真实输出示例**: JStack / JMap / JInfo 都必须包含 stdout 示例
9. **禁止混淆 attach 生命周期**: 明确标注二级 Tool 绕过 `execute()` 直接调用 `run()` 的影响
10. **禁止遗漏 GC 适配链的完整列表**: HeapSummary 节必须覆盖全部 6 种 GC

---

## §九 Required（≥8 条）

1. **必须包含 Tool 模板方法的完整调用链**: `execute()` → `start()` → `startInternal()` → `run()` → `stop()`
2. **必须解释三种 attach 模式的分派逻辑**: PID vs exec+core vs remote 的歧义处理
3. **必须包含 JStack 双模式的详细对比**: PStack 的 native 帧 vs StackTrace 的 Java 帧
4. **必须包含 JMap 的 7 种 mode 分派 + HeapSummary 的 6 种 GC 适配**
5. **必须解释 JInfo.printVMFlags() 的数据来源**: `Arguments._jvm_flags_array` 通过 TypeDataBase 读取
6. **必须对比 SA 工具与 jcmd/jstat 的根本差异**: 为什么 SA 不需要目标 JVM 配合
7. **必须包含真实输出示例**: jstack / jmap -heap / jmap -histo / jinfo -flags 的 stdout
8. **必须包含边缘场景 section**: ≥3 个场景（参数歧义 / Darwin 限制 / 大堆分析超时 / Remote 模式限制）
9. **必须使用 man 手册验证关键系统调用**: `ptrace(2)` (via `man 2 ptrace`), `process_vm_readv(2)` (via `man 2 process_vm_readv`)
10. **必须包含诊断工具五件套**: `strace` + `jhsdb` + `jstack` + `GDB` + `/proc`

---

## §十 GDB Verification（≥7 断言）

以下是可以实际运行和验证的断言：

### 断言 1: Tool.execute() 的模板方法执行顺序

```bash
# 用 GDB 在 Tool.execute() / start() / startInternal() / stop() 打断点
gdb --args java -cp $JAVA_HOME/lib/sa-jdi.jar sun.jvm.hotspot.tools.JStack 4451

# 断点顺序应为:
# 1. Tool.execute() [line 114]
# 2. Tool.start()   [line 133]
# 3. Tool.startInternal() [line 239]
# 4. JStack.run()    [line 58]
# 5. Tool.stop()     [line 127]  ← finally 保证执行
```

### 断言 2: 三种 attach 模式的实际分派

```bash
# Live mode:
jhsdb jstack --pid 1234
# 期望: Tool.start() 中 debugeeType=DEBUGEE_PID, agent.attach(pid)

# Core mode:
jhsdb jstack --exe /usr/bin/java --core core.1234
# 期望: debugeeType=DEBUGEE_CORE, agent.attach(exe, core)

# Remote mode (需要 debugd 运行中):
jhsdb jstack --connect remote-server:9000
# 期望: debugeeType=DEBUGEE_REMOTE, agent.attach(remote)
```

### 断言 3: jstack 输出与 kill -3 输出的对比

```bash
# 方法 1: SA jstack
jhsdb jstack --pid 1234 > sa_jstack.txt

# 方法 2: 标准 kill -3 (SIGQUIT)
kill -3 1234
# 输出到目标 JVM 的 stdout

# 验证: 两个输出的线程名和栈帧应该一致（格式略有不同）
diff <(grep -E '^"' sa_jstack.txt | sort) <(grep -E '^"' /path/to/jvm/stdout | sort)
```

### 断言 4: jmap -heap 的 GC 适配分派

```bash
# 用不同的 GC 启动 JVM
java -XX:+UseG1GC -jar app.jar &
PID1=$!
jhsdb jmap --heap --pid $PID1 | grep "Garbage-First"

java -XX:+UseParallelGC -jar app.jar &
PID2=$!
jhsdb jmap --heap --pid $PID2 | grep "Parallel GC"

java -XX:+UseSerialGC -jar app.jar &
PID3=$!
jhsdb jmap --heap --pid $PID3 | grep "Mark Sweep"
```

### 断言 5: jmap -histo 遍历的 syscall 统计

```bash
# 用 strace 统计 ptrace 调用次数
strace -c -e trace=ptrace jhsdb jmap --histo --pid 1234 2>&1 | grep -E "ptrace|total"

# 期望: 看到大量 PTRACE_PEEKDATA 调用（数量与堆大小成正比）
```

### 断言 6: jinfo -flags 输出中包含 -XX: 标记

```bash
# 启动时设置特殊 -XX: flag
java -XX:+UnlockDiagnosticVMOptions -XX:+PrintAssembly -jar app.jar &
PID=$!
jhsdb jinfo --flags --pid $PID | grep -E "\-XX:[+-]PrintAssembly"
# 期望: 输出 "-XX:+PrintAssembly" 或 "-XX:+UnlockDiagnosticVMOptions"
```

### 断言 7: Tool.stop() 在异常场景下仍然执行

```bash
# 故意传入无效 PID 触发异常
jhsdb jstack --pid 99999 2>&1
# 期望: 输出 "Error attaching to process: ..." 但仍然执行 stop()

# 用 strace 验证 PTRACE_DETACH 是否被调用
strace -e trace=ptrace jhsdb jstack --pid 99999 2>&1 | grep DETACH
# 如果没有 attach 成功，DETACH 不会出现——这是正确的
```

### 断言 8: PageCache 在重复读取同一地址时的命中

```bash
# 验证: 对同一个 PID 连续两次 jstack，第二次应该更快
time jhsdb jstack --pid 1234 > /dev/null  # 第一次: Cold cache
time jhsdb jstack --pid 1234 > /dev/null  # 第二次: Warm cache (部分命中)

# 期望: 第二次的 user time 显著减少（PageCache 命中）
```

---

## §十一 与 README 和同组 prompt 的连续性

### 11.1 与 README 的关系

本文档是 Phase 20 的第 05 篇，对应 `probe_md/20-sa-postmortem/README.md` 中的：

- **§§ 05 - SA 工具遍历路径** (`README.md` 待补充)
- 核心内容: Tool 模板方法 + JStack/JMap/JInfo 管线 + SALauncher 命令路由

**连续性保证**:
- 本文档覆盖 `tools/` 包的全部核心工具类 + `SALauncher` 命令路由
- 前文（prompt-04）覆盖了 `HotSpotAgent → TypeDataBase → VM` 的启动流水线，本文档**依赖** prompt-04 的 VM 初始化知识
- 后文（prompt-06）可能覆盖堆遍历深度分析（ObjectHeap.iterate() 实现），本文档提供入口和高层视图

### 11.2 与同组 prompt 的关系

| Prompt | 文件 | 与本文档的关系 |
|--------|------|---------------|
| prompt-00 | SA 架构 + Native 核心数据结构 | 本文档的 Java 工具层是 prompt-00 架构的"应用层" |
| prompt-01 | Live Debugging (ps_proc.c) | 本文档的 `start()` → `agent.attach(pid)` 调用 prompt-01 的 `ptrace(PTRACE_ATTACH)` |
| prompt-02 | Postmortem Debugging (ps_core.c) | 本文档的 `start()` 也支持 core dump 模式（调用 prompt-02） |
| prompt-03 | JNI Bridge + Symbol (LinuxDebuggerLocal.c) | 本文档的工具通过 JNI 调用 prompt-03 的符号查找 |
| prompt-04 | SA 启动流水线（Java 层） | **本文档的直接依赖**：Tool 模板方法调用 prompt-04 的 `HotSpotAgent.attach()` |
| prompt-05 (本文档) | SA 工具遍历路径 | 核心：Tool 模板方法 + JStack/JMap/JInfo 管线 |
| prompt-06 | 堆遍历深度分析 | 本文档提供 ObjectHistogram 入口，prompt-06 深入 `ObjectHeap.iterate()` 实现 |

### 11.3 避免重复

- **不与 prompt-04 重复**: 本文档不展开 `HotSpotAgent.attach()` 的内部细节（`setupDebugger()` / `setupVM()` 是 prompt-04 的内容），只解释 Tool 如何调用它
- **不与 prompt-00 重复**: 本文档不展开 Native 层 `ps_proc.c` / `ps_core.c` 细节，只标注调用关系
- **不与 prompt-06 重复**: 本文档只解释 JMap/ObjectHistogram 的入口，不深入 `ObjectHeap.iterate()` 的实现细节（那是 prompt-06 的内容）
- **不与 prompt-03 重复**: 本文档不展开 JNI 桥接层细节

---

## §十二 质量自检清单

写完文档后，逐项检查：

- [ ] §四 深度问题组 ≥6 组，每组含 counterfactual
- [ ] §八 Prohibited ≥8 条
- [ ] §九 Required ≥8 条
- [ ] §十 Verification ≥7 断言
- [ ] §四 答案方向 ≥8 行（随机抽取 3 个验证）
- [ ] Beginner Callout ≥7 个，且只在 §一 内
- [ ] man 手册引用覆盖所有核心 syscall (`ptrace(2)`, `process_vm_readv(2)`)
- [ ] 独立的边缘场景 section ≥3 场景
- [ ] §二 有 syscall/运行命令/关键类表
- [ ] 标题格式 `# 05 SA 工具遍历路径 — ...`
- [ ] 运行 `rg '^## §' file.md` 验证连续无跳号
- [ ] 总行数 ≥450 行（目标是 2500-3500 行）
- [ ] 包含真实输出示例：jstack / jmap -heap / jmap -histo / jinfo -flags
- [ ] 对比 SA 工具与 jcmd/jstat 的根本差异（§六）

---

## 附录: 关键源码位置速查

| 符号 | 文件:行号 | 说明 |
|------|----------|------|
| `Tool.execute()` | `Tool.java:114` | 模板方法入口 |
| `Tool.start(String[])` | `Tool.java:133` | 参数解析 + attach |
| `Tool.startInternal()` | `Tool.java:239` | VM 版本检测 + run() |
| `Tool.stop()` | `Tool.java:127` | agent.detach() |
| `JStack.run()` | `JStack.java:58` | PStack/StackTrace 分派 |
| `JStack.runWithArgs()` | `JStack.java:70` | -m/-l 参数解析 |
| `JMap.main()` | `JMap.java:118` | mode 常量设置 |
| `JMap.run()` | `JMap.java:76` | 6 种 Tool 分派 |
| `JInfo.run()` | `JInfo.java:64` | FLAGS/SYSPROPS/BOTH 分派 |
| `JInfo.printVMFlags()` | `JInfo.java:147` | VM flags 打印 |
| `PStack.initJFrameCache()` | `PStack.java:208` | JavaVFrame 缓存 |
| `PStack.run()` | `PStack.java:52-193` | native+Java 混合栈主循环 |
| `StackTrace.run()` | `StackTrace.java:58-131` | 纯 Java 栈主循环 |
| `HeapSummary.run()` | `HeapSummary.java:60-153` | GC 分派入口 |
| `ObjectHistogram.run()` | `ObjectHistogram.java:50-61` | 对象遍历入口 |
| `SysPropsDumper.run()` | `SysPropsDumper.java:43-57` | 系统属性打印 |
| `SALauncher.main()` | `SALauncher.java:498` | 命令路由 |
| `SALauncher.runJSTACK()` | `SALauncher.java:260` | jstack 参数桥接 |
| `SALauncher.runJMAP()` | `SALauncher.java:300` | jmap 参数桥接 |
| `SALauncher.runJINFO()` | `SALauncher.java:372` | jinfo 参数桥接 |
| `Threads.first()` | `Threads.java:157` | 线程表头 |
| `JavaThread.next()` | `JavaThread.java:123` | 线程链表遍历 |
| `JavaThread.getLastJavaVFrameDbg()` | `JavaThread.java:236` | 获取顶层 JavaVFrame |
| `JavaThread.printThreadInfoOn()` | `JavaThread.java:481` | 线程头信息打印 |

---

**END OF PROMPT**
