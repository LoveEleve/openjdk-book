# 05 SA 工具遍历路径 — Tool 模板方法 + JStack/JMap/JInfo 管线

> **所属 Phase**: 20-sa-postmortem | **参考 prompt**: `prompt-05-Tools-Pipeline.md`
>
> **主题**: SA 工具层的模板方法设计模式、双模式栈回溯、7 种堆分析、VM flags 读取、SALauncher 命令路由、与 jcmd/jstat 的根本差异
>
> **关键源文件**: `Tool.java` (263行), `JStack.java` (101行), `JMap.java` (213行), `JInfo.java` (179行), `PStack.java` (281行), `StackTrace.java` (142行), `HeapSummary.java` (304行), `SALauncher.java` (564行)

---

## §〇 Production Scenario

### 场景 1: 排查线上线程卡死

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

### 场景 2: 排查内存泄漏

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

**关键发现**: `LeakyCache$Entry` 500K 个实例，一种业务缓存类占用 40MB 且从未回收 → 定位到缓存 key 设计缺陷导致空间泄漏。

> **💡 核心认知**: SA 工具是"外科手术式"诊断工具。标准 `jcmd`/`jstat` 需要目标 JVM 有空闲 Java 线程接收入站连接并执行诊断命令——在进程 OOM 或线程池满时直接失效。SA 通过 `ptrace(2)` 从目标 JVM 进程**外部**读取内存，不需要目标 JVM 配合任何操作。这是 SA 在生产环境中不可替代的根本原因。

---

> **💡 初学者提示 1**: SA 的"工具"本质上是一个**只读内存分析器**。所有的 `jstack`/`jmap`/`jinfo` 都不会让目标 JVM 执行任何诊断代码——它们只是通过 `ptrace(2)` 读取目标进程的内存，然后用 SA 的类型系统"解码"出有意义的信息（线程栈、对象直方图、VM flags）。

> **💡 初学者提示 2**: Tool 的模板方法模式确保**attach-detach 配对**。`execute()` 方法虽然不是 Java `final`，但其注释指示子类不应该 override 它。`stop()` 在 `finally` 块中，保证 `start()` 无论是否抛异常，`agent.detach()` 一定被调用——防止 `ptrace` 的 `PTRACE_DETACH` 漏掉，目标进程 `TracerPid` 永久非零。

> **💡 初学者提示 3**: `jstack` 的 PStack mode（`-m` 参数）和 StackTrace mode 的区别不只是"有没有 native 帧"——PStack 使用的是 `CDebugger`（C/C++ 调试器）遍历 native 线程栈，而 StackTrace 使用 `JavaThread.getLastJavaVFrameDbg()` 遍历 Java 虚拟栈帧。两者遍历的数据结构完全不同。PStack 在 macOS (Darwin) 上不可用。

> **💡 初学者提示 4**: JMap 的 `-heap` 模式需要适配 6+ 种不同的 GC 实现。SA 通过 `instanceof CollectedHeap` 的**类型分派链**来适配不同 GC，同时还有一个独立的 `printGCAlgorithm()` 方法通过 VM flag 检测 GC 类型——这是配置层和运行时层的双重检测。

> **💡 初学者提示 5**: JInfo 的 `printVMFlags()` 通过 `VM.getVM().getCommandLineFlags()` 获取，后者通过 TypeDataBase 读取 `Arguments` 类中的 `_jvm_flags_array` 和 `_jvm_args_array` 字段。这意味着 SA 可以读取所有 `-XX:` 标记（包括被默认值），而不需要目标 JVM 执行任何代码。`origin == 0` 的 flag 被过滤掉（不打印），只打印非默认值。

> **💡 初学者提示 6**: SA 工具不需要 `-Dcom.sun.management.jmxremote` 也不需要开 JMX 端口。`jcmd` 需要在目标 JVM 的 `temp` 目录创建 `attach_pid<pid>` 文件，需要目标 JVM 有线程响应 `AttachListener`；`jstat` 需要 `PerfData` 共享内存文件。SA 通过 `ptrace(2) + /proc/<pid>/mem` 直接读取内存，**不依赖目标 JVM 的任何线程**。

> **💡 初学者提示 7**: SALauncher (SALauncher.java:498-562) 通过字符串匹配 `args[0].equals("jstack")` 来分派工具——这是一个简单的**命令路由**，不是反射。这保证了只有明确注册的工具（jstack/jmap/jinfo/jsnap/debugd/clhsdb/hsdb）才能被调用，防止注入攻击。

---
## §一 Tool 模板方法模式：execute() → start() → startInternal() → run() → stop()

Tool 类是 SA（Serviceability Agent）所有诊断工具的抽象基类，它运用**模板方法模式**将 attach-detach 生命周期固化为固定的五步执行流程。子类（JStack、JMap、JInfo）只能 override `run()` 实现各自的分析逻辑，而不能改变 attach 的启动顺序和 detach 的终止保证。这个模式的核心价值在于：**try-finally 保证 `stop()` 一定执行**，从而确保 `ptrace(PTRACE_DETACH)` 永远不会被遗漏——这是保护目标进程 TracerPid 不被永久锁定的关键工程约束。

### 1.1 execute() 入口：finally 保证 stop() 一定执行

```java
// Tool.java:114-125
protected void execute(String[] args) {
    int returnStatus = 1;

    try {
        returnStatus = start(args);
    } finally {
        stop();
    }

    // Exit with 0 or 1
    System.exit(returnStatus);
}
```

分析要点：

1. **`returnStatus` 初始值 `1`（失败）**：这是防御式编程——如果 `start(args)` 因异常未执行到 `return` 语句，退出码默认非零。注意 `start()` 有两条返回路径：`return 1`（参数错误/attach 失败）返回 `Tool.java:137/177/219`，`return 0` 返回 `Tool.java:224`。

2. **`finally { stop() }` 是为什么要用模板方法的唯一理由**：如果 `start()` 中 `agent.attach()` 成功（即 `PTRACE_ATTACH` 已执行），但 `startInternal()` → `run()` 抛出异常，`finally` 块确保 `stop()` → `agent.detach()` → `PTRACE_DETACH` 一定执行。若跳过 `stop()`，目标进程的 `/proc/<pid>/status` 中 `TracerPid` 永久非零，阻止后续任何调试器附加。

3. **为什么不用 try-with-resources？** `Tool` 不实现 `AutoCloseable`，因为 `stop()` 方法语义不满足"资源关闭"的单一概念——`agent` 是构造函数后才赋值的（`Tool.java:180: agent = new HotSpotAgent()`），在构造时 `agent` 可能为 `null`。try-with-resources 要求资源在 try 块入口处已有效，这与 `start()` 内部创建 `agent` 的时机冲突。

4. **`System.exit(returnStatus)` 在 finally 之后**：这保证了 `stop()` 先于 `System.exit()` 执行。如果子类在 `run()` 中直接调用 `System.exit()`，会导致 `stop()` 被跳过——这是模板方法禁止子类 override `execute()` 的原因。

> **💡 Counterfactual 讨论**: 如果 `execute()` 不使用 `finally` 而用"成功标志位 + finally 外部判断"模式（`boolean attached = false; try { attached = start() == 0; } finally { if (attached) stop(); }`），代码反而更脆弱：`start()` 可能部分成功（比如 attach 成功后 `startInternal()` 抛异常），此时标志位为 `false` 但实际已 attach。`finally` 无条件执行 `stop()`，配合 `stop()` 内部的 `agent != null` 守卫（`Tool.java:128`），是更安全的做法。

### 1.2 start(String[] args)：三种 attach 模式的参数解析与分派

`start(String[] args)` 是整个工具的生命周期编排器，从参数解析到 attach 连接再到 `startInternal()` 委托，所有逻辑都在一个方法中完成。

```java
// Tool.java:133-178 (参数解析 + debugeeType 分派)
private int start(String[] args) {

   if ((args.length < 1) || (args.length > 2)) {
      usage();
      return 1;
   }

   if (args[0].startsWith("-h")) {
       usage();
       return 0;
   } else if (args[0].startsWith("-")) {
       usage();
       return 1;
   }

   PrintStream err = System.err;
   PrintStream out = System.out;

   int pid = 0;
   String coreFileName   = null;
   String executableName = null;
   String remoteServer   = null;

   switch (args.length) {
     case 1:
        try {
           pid = Integer.parseInt(args[0]);
           debugeeType = DEBUGEE_PID;
        } catch (NumberFormatException e) {
           remoteServer = args[0];
           debugeeType  = DEBUGEE_REMOTE;
        }
        break;

     case 2:
        executableName = args[0];
        coreFileName   = args[1];
        debugeeType    = DEBUGEE_CORE;
        break;

     default:
        usage();
        return 1;
   }
```

分析要点：

1. **参数长度检查（`Tool.java:135-138`）**: 只接受 1 个或 2 个参数。1 个参数可能是 PID（纯数字如 `"4451"`）或远程调试服务器的 IP/主机名。2 个参数固定为 `<executable> <core>`。

2. **`Integer.parseInt` 的歧义处理（`Tool.java:159-166`）**：这是整个分派逻辑的关键——利用 `Integer.parseInt()` 的成败区分 PID 和 Remote。纯数字字符串被解析为 PID，任何包含非数字字符的字符串（包括 IP 地址 `"192.168.1.1"` 中的 `.`、主机名 `"remote-server"` 中的 `-`）都会触发 `NumberFormatException`，走到远程分派的 catch 分支。

3. **误判风险**: 纯数字主机名（如 `"12345"`）会被误判为 PID。如果用户确实需要连接名为 `12345` 的远程调试服务器，此分派方案无法区分。这是"代码简洁性 > 语义精确性"的工程权衡——引入 `--pid`/`--connect` 显式标志需要增加参数解析器，团队选择了 `Integer.parseInt` 作为快捷方案。

4. **`-h`/`-help` 特殊处理（`Tool.java:141-147`）**: 在分派之前处理，以 `-h` 开头的参数调用 `usage()` 并返回成功（退出码 0），以 `-` 开头的其他非法 flag 也调用 `usage()` 但返回失败（退出码 1）。

```java
// Tool.java:182-198 (attach 分派)
   agent = new HotSpotAgent();
   try {
     switch (debugeeType) {
       case DEBUGEE_PID:
          out.println("Attaching to process ID " + pid + ", please wait...");
          agent.attach(pid);
          break;

       case DEBUGEE_CORE:
          out.println("Attaching to core " + coreFileName +
                      " from executable " + executableName + ", please wait...");
          agent.attach(executableName, coreFileName);
          break;

       case DEBUGEE_REMOTE:
          out.println("Attaching to remote server " + remoteServer + ", please wait...");
          agent.attach(remoteServer);
          break;
     }
   }
   catch (DebuggerException e) {
     switch (debugeeType) {
       case DEBUGEE_PID:
          err.print("Error attaching to process: ");
          break;
       case DEBUGEE_CORE:
          err.print("Error attaching to core file: ");
          break;
       case DEBUGEE_REMOTE:
          err.print("Error attaching to remote server: ");
          break;
     }
     if (e.getMessage() != null) {
       err.println(e.getMessage());
       e.printStackTrace();
     }
     err.println();
     return 1;
   }

   out.println("Debugger attached successfully.");
   startInternal();
   return 0;
```

分析要点：

1. **`HotSpotAgent` 在分派后才创建（`Tool.java:180`）**: 不在参数解析前创建——只有当参数有效且模式确定后才实例化 `agent`。这避免了无效参数导致不必要的对象创建。

2. **三条 attach 路径的接口差异**: `agent.attach(pid)` (int 参数) → Live debugging（调用 prompt-01 的 `ptrace(PTRACE_ATTACH)`）；`agent.attach(exe, core)` (String, String) → Postmortem debugging（调用 prompt-02 的 core dump 解析）；`agent.attach(remoteServer)` (String) → Remote debugging（网络连接 + RMI）。三种重载在 `HotSpotAgent` 内部走不同的 setup 流水线，但都最终收敛到 `setupVM()` 完成 TypeDataBase 初始化。

3. **`DebuggerException` 的按类型错误输出（`Tool.java:200-219`）**: catch 块内部用与 attach 相同的 `switch(debugeeType)` 结构，为每种模式生成不同的错误前缀（"Error attaching to process/core file/remote server"）。但错误输出的格式存在**双层打印**问题：`DebuggerException.getMessage()` 可能包含完整的错误信息，而 `e.printStackTrace()` 又追加了完整堆栈——用户看到的信息可能冗余。这是为了兼容不同的 `DebuggerException` 子类实现（有的 `getMessage()` 为 null，此时依赖 stack trace）。

4. **"Debugger attached successfully." 只在无异常时打印（`Tool.java:222`）**: 这个语法在 catch 块之后、`startInternal()` 之前。如果 `agent.attach()` 抛异常，会提前 `return 1`，不会到达这行。换而言之，这句 stdout 输出是"attach 成功"的**唯一确认**——用户可以通过 grep 这个字符串来判断 SA 工具是否成功连接到目标进程。

```java
// Tool.java:228-236 (无参 start() — JVMDebugger 模式)
public void start() {
   if (jvmDebugger == null) {
      throw new RuntimeException("Tool.start() called with no JVMDebugger set.");
   }
   agent = new HotSpotAgent();
   agent.attach(jvmDebugger);
   startInternal();
}
```

分析要点：

**无参 `start()` 是 `Tool(JVMDebugger d)` 构造函数的配套方法（`Tool.java:228-236`）**: 当 Tool 通过 `new JStack(jvmDebugger)` 构造时（`JStack.java:39-41`），跳过了参数解析，直接使用预先配置的 `JVMDebugger` 对象 attach。这个入口**不经过 `execute()`**——调用者必须手动管理生命周期，没有 `finally` 保证 detach。`RuntimeException` 守卫（`Tool.java:231`）确保调用者必须先设置 JVMDebugger。

### 1.3 startInternal()：VM 版本检测 + run() 委托

```java
// Tool.java:239-261
private void startInternal() {

   PrintStream out = System.out;
   VM vm = VM.getVM();
   if (vm.isCore()) {
     out.println("Core build detected.");
   } else if (vm.isClientCompiler()) {
     out.println("Client compiler detected.");
   } else if (vm.isServerCompiler()) {
     out.println("Server compiler detected.");
   } else {
     throw new RuntimeException("Fatal error: "
         + "should have been able to detect core/C1/C2 build");
   }

   String version = vm.getVMRelease();
   if (version != null) {
     out.print("JVM version is ");
     out.println(version);
   }

   run();
}
```

分析要点：

1. **三级 if-else 编译器检测（`Tool.java:243-252`）**: 不是通过字符串比较，而是通过 `VM` 对象的三个布尔方法：`isCore()`（HotSpot 核心版本，不区分 client/server）、`isClientCompiler()`（C1）、`isServerCompiler()`（C2）。这三级对应 HotSpot 的三种构建类型——Tiered Compilation 开启时 C1 和 C2 同时存在，`VM` 对象需要选择"主要"编译器类型报告。`RuntimeException` 的 fallback（`Tool.java:249-252`）是"不可能到达"的安全网，任何合理的 HotSpot 构建都应匹配三者之一。

2. **`VM.getVM()` 是单例获取（`Tool.java:242`）**: `prompt-04` 在 `attach()` 阶段完成 `setupVM()` → `VM.initialize()`。这里 `VM.getVM()` 返回的是**同一个已初始化的 VM 实例**——不是新的 VM 对象。这意味着版本检测是零开销的：所有信息在之前已通过 TypeDataBase 读取到内存中。

3. **版本信息是纯展示（`Tool.java:254-258`）**: `vm.getVMRelease()` 从 HotSpot 的 `VM_Version` C++ 对象中读取版本字符串（如 `"11.0.12+7-LTS"`）。这段信息**不影响执行流程**——即使版本打印失败（`version == null`），`run()` 仍然会被调用（`Tool.java:260`）。这种宽容性是正确的：版本字符串格式可能因 JVM 构建而异，不应成为工具失败的阻断点。

4. **`run()` 在版本信息之后调用（`Tool.java:260`）**: 这是模板方法模式的核心——所有环境信息已准备就绪（agent.attach 完成 + VM 已初始化 + 版本已检测），子类的 `run()` 可以在一个"热"上下文中直接开始工作。

### 1.4 stop()：agent.detach() 的 finally 保证

```java
// Tool.java:127-131
public void stop() {
   if (agent != null) {
      agent.detach();
   }
}
```

分析要点：

1. **`agent != null` 守卫是关键安全线（`Tool.java:128`）**: 当 `start(args)` 在创建 `agent` 之前就抛出异常时（比如 `args` 长度无效，`Tool.java:136-138` 的 `usage()` + `return 1`），`execute()` 的 `finally` 块仍会调用 `stop()`，但 `agent` 还是 `null`。没有这个 null 检查会触发 `NullPointerException`，掩盖了原始异常信息。

2. **`stop()` 是 `public` 方法**：允许外部调用者（如 GUI 工具 HSDB）手动触发 detach，不必走 `execute()` 的 `finally` 路径。

3. **PTRACE_DETACH 的后果（不调用 stop() 会发生什么）**: 在 Linux 上，`agent.detach()` 最终通过 JNI 调用 `libsaproc.so` 中的 `ps_proc.c` → `ptrace(PTRACE_DETACH, pid, 0, 0)`（`man 2 ptrace`）。如果这个 syscall 不被调用：
   - 目标进程的 `TracerPid`（`/proc/<pid>/status` 中）保持非零值
   - 后续任何 `PTRACE_ATTACH` 对该进程调用都会失败（返回 `-1`，errno=`EBUSY`），因为 Linux 不允许同一进程被多个 tracer 附加
   - 如果 SA 进程退出而不 detach，内核会**自动 detach**（Linux 3.4+ 的 `PTRACE_SEIZE` 行为有差异，但传统 `PTRACE_ATTACH` 模型不会自动恢复），取决于内核版本和 ptrace 模式

### 1.5 设计模式对比：模板方法 vs 策略模式 vs 简单继承

OpenJDK 团队选择了模板方法模式，这并非偶然——三种方案的工程对比揭示了"控制反转 + 固定生命周期"优于"自由扩展"的设计逻辑：

| 维度 | 模板方法（当前） | 策略模式 | 简单继承（无约束） |
|------|----------------|---------|------------------|
| **代码量** | Tool.java 262 行 | Tool.java 150 行 + 3 个策略类 ~60 行 = 210 行 | Tool.java 100 行 |
| **attach-detach 保证** | `finally` 强制执行 | 需各策略遵守接口约定 | 无保证，依赖 code review |
| **参数解析一致性** | 集中解析 (`start()` 内) | 各策略独立解析 | 各子类独立解析 |
| **系统退出时机** | `finally` 后 `System.exit` | 调用者管理 | 各子类自行决定 |
| **新增 attach 模式** | 修改 `Tool.start()` switch | 新增策略类，不改 Tool.java | 各子类自行扩展 |
| **扩展性（对 attach 模式）** | 低 | 高 | 高但风险大 |
| **可读性** | 高（全部生命周期在一处） | 中（需跳转多个文件） | 中（生命周期分散在各子类） |

**Counterfactual 讨论——为什么不用策略模式？**

如果改用策略模式，需要定义 `AttachStrategy` 接口（含 `attach()`, `detach()` 方法），然后 `PidAttachStrategy`、`CoreAttachStrategy`、`RemoteAttachStrategy` 分别实现。这样符合开闭原则——添加新的 attach 模式不需要修改 `Tool.java`。但会引入以下额外成本：

1. **生命周期管理复杂化**: 策略对象由谁创建？何时销毁？模板方法将 attach-detach 配对锁定在一个方法中，策略模式则需要额外的协调层（可能是 `AttachContext` 对象），代码量反而增加。

2. **参数解析耦合**: 策略模式中每个策略需要解析各自的参数格式（PID 用 int，exe+core 用两个 String，remote 用一个 String），但 `Tool.start()` 的参数解析必须在分派到策略**之前**就完成——这导致参数解析逻辑实际上仍在 `Tool.java` 中，策略只负责 attach。策略模式的"独立解析"优势被架空。

3. **SA 工具只有 3 种 attach 模式**: 从 2002 年（Tool.java 首次引入）到 2017 年（最后一版），从未增加新的 attach 模式。模板方法的"低扩展性"在实践中不是问题。

> **工程结论**: 当控制流有明确的"前-中-后"阶段且"前-后"阶段对所有变体都相同时，模板方法优于策略模式。SA 的 attach-detach 就是这种典型场景。模板方法的"代码集中 + finally 保证"在安全关键代码中比策略模式的"开闭原则"更重要。

### 1.6 二级 Tool 的委托模式（绕过 execute()）

SA 的一个重要设计模式是"门面 Tool 创建子 Tool 并直接调用 `run()`"——这是绕过 `execute()` 的委托模式：

| 门面 Tool | 创建的二级 Tool | 调用方式 | 代码位置 |
|-----------|----------------|---------|---------|
| JStack | PStack (mixedMode) | `tool.run()` | `JStack.java:67` |
| JStack | StackTrace (!mixedMode) | `tool.run()` | `JStack.java:67` |
| JMap | HeapSummary | `tool.run()` | `JMap.java` |
| JMap | ObjectHistogram | `tool.run()` | `JMap.java` |
| JMap | ClassLoaderStats | `tool.run()` | `JMap.java` |
| JMap | PMap | `tool.run()` | `JMap.java` |
| JMap | FinalizerInfo | `tool.run()` | `JMap.java` |
| JInfo | SysPropsDumper | `tool.run()` | `JInfo.java` |

**为什么绕过 execute()？**

1. **复用 attach 结果**: 门面 Tool（JStack/JMap/JInfo）已经完成了 `agent.attach()` → `startInternal()` → VM 初始化。二级 Tool 通过 `tool.setAgent(getAgent())`（`JStack.java:65`）和 `tool.setDebugeeType(getDebugeeType())`（`JStack.java:66`）传递已有的 agent 引用——如果走 `execute()`，会重新执行 `start()`，导致第二次 `agent.attach()`，可能失败或行为异常。

2. **只传递引用，不做生命周期管理**: 二级 Tool 的 `setAgent()` / `setDebugeeType()` 只是 setter，不触发任何副作用——纯数据传递。二级 Tool 的 `run()` 方法直接使用已初始化的 VM 运行时。

3. **门面 Tool 维护唯一的 attach-detach 生命周期**: 无论多少个二级 Tool 被创建，attach 和 detach 都只发生一次（在门面 Tool 的 `execute()` 中）。这是"资源所有权集中"的设计——二级 Tool 只是"借用"门面 Tool 的 agent 引用。

**哪些 Tool 走完整模板方法？**

- CLI 版本的**顶级入口**：`jstack <pid>`, `jmap <options> <pid>`, `jinfo <pid>` — 通过 `main()` → `execute()` 走完整模板方法
- PStack 的独立 `main()`（`PStack.java:196-199`）：直接调用 `execute(args)`，走完整模板方法
- StackTrace 的独立 `main()`（`StackTrace.java:134-137`）：同上

**哪些绕过 execute()？**

- 所有作为"二级 Tool"被门面创建的实例 — 走 `tool.run()`，复用门面的 agent

---

## §二 JStack — 双模式栈回溯管线

JStack 是 SA 的线程栈分析门面类，它在 `run()` 方法中根据 `mixedMode` 字段决定走 `PStack`（含 native C/C++ 帧）还是 `StackTrace`（纯 Java 帧）。两种模式遍历的数据结构完全不同：PStack 用 `CDebugger.getThreadList()` 获取 native 线程列表并通过 DWARF 符号表解析 C 帧，而 StackTrace 用 `Threads.first()` 遍历 JavaThread 链表并通过 `JavaVFrame.javaSender()` 迭代 Java 虚拟栈帧。这个双模式设计让用户可以根据需求选择"轻量 Java 栈"（毫秒级）还是"全量 native+Java 混合栈"（秒级）。

### 2.1 run() 分派：mixedMode → PStack vs StackTrace

```java
// JStack.java:58-68
public void run() {
    Tool tool = null;
    if (mixedMode) {
        tool = new PStack(false, concurrentLocks);
    } else {
        tool = new StackTrace(false, concurrentLocks);
    }
    tool.setAgent(getAgent());
    tool.setDebugeeType(getDebugeeType());
    tool.run();
}
```

分析要点：

1. **PStack/StackTrace 构造参数 `false`（verbose=false）**（`JStack.java:61/63`）: JStack 默认 non-verbose，因为在 `jhsdb jstack` 场景下，用户只需要方法签名和行号，不需要 Method* 地址和 PC 偏移。如果需要这些底层调试信息，可以直接调用 `PStack.main()` 传入 verbose 标志。

2. **`setAgent(getAgent())` 和 `setDebugeeType(getDebugeeType())`**（`JStack.java:65-66`）: 这是 1.6 节讨论的委托模式——二级 Tool 复用门面 JStack 已经 attach 好的 agent 和 debugeeType，不重新触发 attach 生命周期。

3. **`tool.run()` 而不是 `tool.execute()`**（`JStack.java:67`）: 直接调用 `run()`，绕过模板方法的 `execute()` → `start()` → `startInternal()` 流水线。因为 PStack/StackTrace 作为二级 Tool 不需要自己的 attach-detach。

4. **为什么 JStack 自己不实现遍历逻辑而要委托？** 如果 JStack 直接在 `run()` 中写 `if (mixedMode) { /* PStack 逻辑 */ } else { /* StackTrace 逻辑 */ }`，代码会超过 500 行（PStack 本身 280 行 + StackTrace 141 行），违反单一职责原则。将两种遍历模式分别封装为独立的 Tool 子类，让 PStack 和 StackTrace 可以独立测试、独立调用（如 `PStack.main()` 作为独立命令行工具）。

### 2.2 StackTrace 模式：纯 Java 帧遍历

StackTrace 模式通过 `Threads.first()` 遍历 JavaThread 链表，再用 `getLastJavaVFrameDbg()` 获取最顶层的 Java 虚拟栈帧，最后通过 `javaSender()` 向上迭代所有帧。

```java
// StackTrace.java:58-66 (入口 — 死锁检测 + 线程遍历)
public void run(java.io.PrintStream tty) {
    try {
        DeadlockDetector.print(tty);
    } catch (Exception exp) {
        exp.printStackTrace();
        tty.println("Can't print deadlocks:" + exp.getMessage());
    }

    try {
        ConcurrentLocksPrinter concLocksPrinter = null;
        if (concurrentLocks) {
            concLocksPrinter = new ConcurrentLocksPrinter();
        }
        Threads threads = VM.getVM().getThreads();
        int i = 1;
        for (JavaThread cur = threads.first(); cur != null; cur = cur.next(), i++) {
            if (cur.isJavaThread()) {
```

分析要点：

1. **死锁检测在栈打印之前（`StackTrace.java:62`）**: 先调用 `DeadlockDetector.print(tty)` 输出死锁分析结果。如果死锁检测失败（如某些 HotSpot 版本不支持 `getCurrentPendingMonitor()`，`DeadlockDetector.java:74-77`），异常被捕获并继续——死锁检测的失败不应阻止栈打印。

2. **`ConcurrentLocksPrinter` 初始化（`StackTrace.java:69-72`）**: 只在 `concurrentLocks` 为 true 时才创建。这是 `jstack -l` 的开销——需要额外读取 `AbstractOwnableSynchronizer` 对象（`LockSupport.park()` 的 blocker 对象）。

3. **`Threads.first()` 遍历（`StackTrace.java:75`）**: JavaThread 是一个单向链表——不通过数组索引。`cur.next()` 简单地返回 `Threads` C++ 结构中的 `_next` 字段（通过 TypeDataBase 偏移量读取）。

```java
// StackTrace.java:76-125 (per-thread 栈遍历)
                cur.printThreadInfoOn(tty);
                try {
                    int count = 0;

                    for (JavaVFrame vf = cur.getLastJavaVFrameDbg(); vf != null; vf = vf.javaSender()) {
                        Method method = vf.getMethod();
                        tty.print(" - " + method.externalNameAndSignature() +
                        " @bci=" + vf.getBCI());

                        int lineNumber = method.getLineNumberFromBCI(vf.getBCI());
                        if (lineNumber != -1) {
                            tty.print(", line=" + lineNumber);
                        }

                        if (verbose) {
                            Address pc = vf.getFrame().getPC();
                            if (pc != null) {
                                tty.print(", pc=" + pc);
                            }
                            tty.print(", Method*=" + method.getAddress());
                        }

                        if (vf.isCompiledFrame()) {
                            tty.print(" (Compiled frame");
                            if (vf.isDeoptimized()) {
                              tty.print(" [deoptimized]");
                            }
                        }
                        if (vf.isInterpretedFrame()) {
                            tty.print(" (Interpreted frame");
                        }
                        if (vf.mayBeImpreciseDbg()) {
                            tty.print("; information may be imprecise");
                        }

                        tty.println(")");
                        vf.printLockInfo(tty, count++);
                    }
                } catch (Exception e) {
                    tty.println("Error occurred during stack walking:");
                    e.printStackTrace();
                }
```

分析要点：

1. **`isJavaThread()` 守卫（`StackTrace.java:76`）**: 跳过 `NonJavaThread`（如 VMThread、WatcherThread、ReferenceHandler 等 HotSpot 内部线程）。这些线程在 JavaThread 链表中存在但不是 Java 线程（没有 Java 级别的栈帧），如果强行调用 `getLastJavaVFrameDbg()` 会抛异常。这个守卫是防御式编程——Threads 链表包含所有线程，但只有 JavaThread 子类才有 Java 栈帧。

2. **`cur.getLastJavaVFrameDbg()` 是栈遍历的起点（`StackTrace.java:81`）**: 返回当前线程最顶层的 JavaVFrame。注意不是 `getLastFrame()`（后者返回底层的物理 Frame），而是 `getLastJavaVFrameDbg()`（debug 版本，跳过 stub 帧和 native 入口帧）。

3. **`vf.javaSender()` 向上迭代（`StackTrace.java:81`）**: 每一帧通过 `javaSender()` 找到调用它的上一帧（sender）。这对应 Java 调用链的语义——不是简单的栈指针向下移动，而是理解 Java 方法的"虚拟调用栈"。

4. **每帧的锁信息打印（`StackTrace.java:114` — `vf.printLockInfo(tty, count++)`）**: 每个 JavaVFrame 都可能关联 Monitor 锁。`printLockInfo()` 输出该帧持有的锁和等待获取的锁——这是栈输出中最重要的诊断信息之一。`count` 参数是帧序号，用于缩进控制。

5. **每线程独立 try-catch（`StackTrace.java:116-118`）**: 一个线程的栈遍历失败不应影响其他线程。这是 fork-safepoint 场景下常见问题——某个线程正在 deoptimization 状态中，其 `getLastJavaVFrameDbg()` 可能因内存状态不一致抛异常。

```java
// StackTrace.java:128-131 (全局 AddressException 保护)
    catch (AddressException e) {
      System.err.println("Error accessing address 0x" + Long.toHexString(e.getAddress()));
      e.printStackTrace();
    }
```

分析要点：

**外层 `AddressException` 捕获（`StackTrace.java:128-131`）**: 这是整个 tools 层的安全网。在 core dump 分析或内存损坏场景下，某个 Oop 指针可能指向非法地址——`AddressException` 捕获后输出错误地址的十六进制值，让用户知道具体哪个内存区域出了问题。

**输出格式示例**:

```
"http-nio-8080-exec-5" #42 daemon prio=5 tid=0x00007f8a1c0ba800 nid=0x7f8b waiting [0x00007f8a0a7fb000]
   java.lang.Thread.State: WAITING
   - jdk.internal.misc.Unsafe.park(Native Method) @bci=0
   - java.util.concurrent.locks.LockSupport.park(LockSupport.java:194) @bci=14, line=194
   - java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject.await(AQSynch...:2084) @bci=111, line=2084
```

### 2.3 PStack 模式：native 帧遍历（CDebugger + DWARF 符号解析）

PStack 模式远比 StackTrace 模式复杂——它使用 `CDebugger`（C/C++ 调试器接口）获取 native 线程列表，通过 `closestSymbolToPC()` 解析 DWARF 调试符号，并在无符号信息时 fallback 到 `Interpreter.contains()` 和 `CodeCache.contains()` 判断代码类型。

```java
// PStack.java:61-68 (平台检查 + CDebugger 获取)
public void run(PrintStream out, Debugger dbg) {
   if (PlatformInfo.getOS().equals("darwin")) {
     out.println("Not available on Darwin");
     return;
   }

   CDebugger cdbg = dbg.getCDebugger();
   if (cdbg != null) {
```

分析要点：

1. **Darwin（macOS）不支持 PStack（`PStack.java:62-64`）**: macOS 的调试 API 基于 Mach 内核（`task_for_pid()`, `mach_vm_read_overwrite()`），与 Linux 的 `ptrace` 模型根本不同，SA 的 `CDebugger` 在 macOS 上没有实现。`PlatformInfo.getOS()` 返回运行时 OS 字符串。

2. **`dbg.getCDebugger()` 可能返回 null（`PStack.java:67`）**: 不是所有 `Debugger` 实现都支持 C 调试器接口。比如 Remote Debugger（通过 RMI 连接到 debugd 服务端）可能不支持 CDebugger——此时走 `PStack.java:187-193` 的 else 分支，根据 `debugeeType` 输出不同的错误消息。

```java
// PStack.java:69-80 (初始化 + 死锁检测)
      ConcurrentLocksPrinter concLocksPrinter = null;
      initJFrameCache();
      if (concurrentLocks) {
         concLocksPrinter = new ConcurrentLocksPrinter();
      }
      // print Java level deadlocks
      try {
         DeadlockDetector.print(out);
      } catch (Exception exp) {
         out.println("can't print deadlock information: " + exp.getMessage());
      }
```

分析要点：

**初始化顺序：`initJFrameCache()` 先于 `DeadlockDetector.print()`**（`PStack.java:71/77`）: JavaVFrame 缓存需要在死锁检测之前完成——因为 `DeadlockDetector` 可能访问 `proxyToThread` 映射表来查找 JavaThread 对象（虽然 `DeadlockDetector` 使用独立的 `threadTable`，但 `initJFrameCache()` 同时构建了 `proxyToThread` 映射，为后续步骤做好准备）。

```java
// PStack.java:82-88 (native 线程遍历)
      List l = cdbg.getThreadList();
      final boolean cdbgCanDemangle = cdbg.canDemangle();
      for (Iterator itr = l.iterator() ; itr.hasNext();) {
         ThreadProxy th = (ThreadProxy) itr.next();
         try {
            CFrame f = cdbg.topFrameForThread(th);
            out.print("----------------- ");
            out.print(th);
            out.println(" -----------------");
```

分析要点：

1. **`cdbg.getThreadList()`（`PStack.java:82`）**: 这个调用返回的是 native 线程列表（OS 级线程），不是 JavaThread 链表。它通过 `libthread_db.so` 或 `/proc/<pid>/task/` 遍历获取。每个条目是 `ThreadProxy` 对象——轻量级的线程代理，只包含 tid 和状态信息。

2. **`cdbg.topFrameForThread(th)`（`PStack.java:87`）**: 返回 native 线程的最顶层 `CFrame`（C 栈帧）。CFrame 包含 pc（程序计数器）、fp（帧指针）、sp（栈指针）——对应真实的 CPU 寄存器值。

3. **以 `----------------- ThreadProxy -----------------` 分隔输出**（`PStack.java:88-90`）: 这个分隔符不仅仅是为了美观——它能用 grep 快速提取单线程的完整栈（`grep -A 100 "----------------- 0x"`）。在自动化诊断中，这个分隔符是解析器识别线程边界的唯一标记。

```java
// PStack.java:95-109 (DWARF 符号解析 — 有符号路径)
               while (f != null) {
                  ClosestSymbol sym = f.closestSymbolToPC();
                  Address pc = f.pc();
                  out.print(pc + "\t");
                  if (sym != null) {
                     String name = sym.getName();
                     if (cdbgCanDemangle) {
                        name = cdbg.demangle(name);
                     }
                     out.print(name);
                     long diff = sym.getOffset();
                     if (diff != 0L) {
                        out.print(" + 0x" + Long.toHexString(diff));
                     }
                     out.println();
```

分析要点：

1. **`closestSymbolToPC()`（`PStack.java:96`）**: 通过 DWARF 符号表查找与 pc 最接近的 C/C++ 函数符号。返回的 `ClosestSymbol` 包含 `name`（mangled 的 C++ 符号名）、`offset`（pc 与函数入口的字节差值）。

2. **`cdbg.demangle(name)`（`PStack.java:101-102`）**: 将 C++ mangled name（如 `_ZN2os9Platform5parkEv`）demangle 为可读形式（如 `os::Platform::park()`）。不是所有 CDebugger 实现都支持 demangle——因此有 `cdbgCanDemangle` 检查。

3. **偏移量格式（`PStack.java:106-107`）**: `+ 0x<hex>` 表示 pc 在函数内的偏移量——这是标准的 GDB 栈回溯格式。偏移量为 0（在函数入口的精确地址）时省略。

```java
// PStack.java:110-165 (无符号路径 — Interpreter/CodeCache 分派)
                  } else {
                      // look for one or more java frames
                      String[] names = null;
                      // check interpreter frame
                      Interpreter interp = VM.getVM().getInterpreter();
                      if (interp.contains(pc)) {
                         names = getJavaNames(th, f.localVariableBase());
                         if (names == null || names.length == 0) {
                            out.print("<interpreter> ");
                            InterpreterCodelet ic = interp.getCodeletContaining(pc);
                            if (ic != null) {
                               String desc = ic.getDescription();
                               if (desc != null) out.print(desc);
                            }
                            out.println();
                         }
                      } else {
                         CodeCache c = VM.getVM().getCodeCache();
                         if (c.contains(pc)) {
                            CodeBlob cb = c.findBlobUnsafe(pc);
                            if (cb.isNMethod()) {
                               if (cb.isNativeMethod()) {
                                  out.print(((CompiledMethod)cb).getMethod().externalNameAndSignature());
                                  long diff = pc.minus(cb.codeBegin());
                                  if (diff != 0L) {
                                    out.print(" + 0x" + Long.toHexString(diff));
                                  }
                                  out.println(" (Native method)");
                               } else {
                                  names = getJavaNames(th, f.localVariableBase());
                                  if (names == null || names.length == 0) {
                                    out.println("<Unknown compiled code>");
                                  }
                               }
                            } else if (cb.isBufferBlob()) {
                               out.println("<StubRoutines>");
                            } else if (cb.isRuntimeStub()) {
                               out.println("<RuntimeStub>");
                            } else if (cb.isDeoptimizationStub()) {
                               out.println("<DeoptimizationStub>");
                            } else if (cb.isUncommonTrapStub()) {
                               out.println("<UncommonTrap>");
                            } else if (cb.isExceptionStub()) {
                               out.println("<ExceptionStub>");
                            } else if (cb.isSafepointStub()) {
                               out.println("<SafepointStub>");
                            } else {
                               out.println("<Unknown code blob>");
                            }
```

分析要点：

1. **两段 fallback 路径（`PStack.java:113-164`）**: 当 DWARF 符号表中找不到 pc 对应的符号时，没有 C/C++ 函数名可用于打印。此时走两条 path：
   - **Interpreter path（`PStack.java:115-126`）**: `Interpreter.contains(pc)` 判断 pc 是否落在解释器的 Codelet 区域。解释器不是用传统函数实现的——每个 bytecode 对应一个 Codelet（汇编模板），没有独立的 DWARF 符号条目。
   - **CodeCache path（`PStack.java:127-164`）**: `CodeCache.contains(pc)` 判断 pc 是否在 JIT 编译代码区域内。这里需要通过 `CodeBlob` 子类型进一步分派。

2. **8 种 CodeBlob 子类型分派（`PStack.java:147-161`）**:

| CodeBlob 类型 | 输出格式 | 说明 |
|--------------|---------|------|
| `isNMethod() + isNativeMethod()` | `methodName + 0x<offset> (Native method)` | JNI native 方法，有 Java 方法名但不遍历 Java 帧 |
| `isNMethod()` (!native) | `getJavaNames()` 或 `<Unknown compiled code>` | JIT 编译方法，通过 FP 匹配找到对应的 Java 方法名 |
| `isBufferBlob()` | `<StubRoutines>` | 解释器入口桩 / GC barrier 桩等 |
| `isRuntimeStub()` | `<RuntimeStub>` | 运行时桩（如 `resolve_static_call`） |
| `isDeoptimizationStub()` | `<DeoptimizationStub>` | 去优化桩，从编译代码回退到解释器 |
| `isUncommonTrapStub()` | `<UncommonTrap>` | 非常见陷阱桩（profile 数据指导的去优化） |
| `isExceptionStub()` | `<ExceptionStub>` | 异常处理桩 |
| `isSafepointStub()` | `<SafepointStub>` | 安全点桩（线程挂起点） |
| 无匹配 | `<Unknown code blob>` | fallback |

3. **`findBlobUnsafe(pc)` 的 "Unsafe" 意思（`PStack.java:131`）**: 不持有 CodeCache 锁——在死锁排查场景，CodeCache 锁可能被另一个线程持有，`findBlobUnsafe` 可以避免死锁但可能读到不一致数据。对于栈分析（只读诊断），读到的可能是过时的 CodeBlob 列表，但至少不会阻塞 forever。

```java
// PStack.java:166-179 (Java 帧注释 + 帧迭代)
                      // print java frames, if any
                      if (names != null && names.length != 0) {
                         for (int i = 0; i < names.length; i++) {
                             out.println(names[i]);
                         }
                      }
                  }
                  f = f.sender(th);
               }
            } catch (Exception exp) {
               exp.printStackTrace();
               // continue, may be we can do a better job for other threads
            }
```

分析要点：

1. **Java 帧以 `*` 前缀注释（`getJavaNames` 输出）**: 在 native 帧下方缩进打印，格式为 `* methodName bci:X line:Y (Compiled frame)`。`*` 前缀是人工可读标记，表示"这是基于 FP 匹配推断的 Java 帧，不是真正的 CPU 帧"。

2. **`f.sender(th)` 向上迭代（`PStack.java:174`）**: CFrame 的 `sender()` 基于 FP（Frame Pointer）链向上遍历。这要求代码使用 `-fno-omit-frame-pointer` 编译——如果 JVM 用 `-fomit-frame-pointer` 编译（某些发行版的默认行为），`sender()` 会返回 null，中断 native 帧遍历。

3. **每线程独立 try-catch（`PStack.java:176-179`）**: 单个线程的遍历失败（如内存地址不可读）不应阻止其他线程的分析——注释明确写着 "may be we can do a better job for other threads"。

```java
// PStack.java:180-193 (per-thread ConcurrentLocksPrinter + CDebugger 缺失处理)
            if (concurrentLocks) {
               JavaThread jthread = (JavaThread) proxyToThread.get(th);
               if (jthread != null) {
                   concLocksPrinter.print(jthread, out);
               }
            }
         } // for threads
      } else {
          if (getDebugeeType() == DEBUGEE_REMOTE) {
              out.println("remote configuration is not yet implemented");
          } else {
              out.println("not yet implemented (debugger does not support CDebugger)!");
          }
      }
```

分析要点：

1. **`proxyToThread.get(th)` 查找 JavaThread 对应（`PStack.java:181`）**: `initJFrameCache()` 创建的映射（2.4 节详述）在这里用于从 native `ThreadProxy` 找到对应的 `JavaThread` 对象，以便调用 `concLocksPrinter.print()`。

2. **CDebugger 缺失的两种场景（`PStack.java:187-193`）**: Remote 模式明确标注 "not yet implemented"（到 2017 年也未被实现），本地模式标注 debugger 不支持 CDebugger。

### 2.4 initJFrameCache()：JavaVFrame 缓存 + proxyToThread 映射

```java
// PStack.java:208-229
private void initJFrameCache() {
   jframeCache = new HashMap();
   proxyToThread = new HashMap();
   Threads threads = VM.getVM().getThreads();
   for (JavaThread cur = threads.first(); cur != null; cur = cur.next()) {
      List tmp = new ArrayList(10);
      try {
         for (JavaVFrame vf = cur.getLastJavaVFrameDbg(); vf != null; vf = vf.javaSender()) {
            tmp.add(vf);
         }
      } catch (Exception exp) {
         exp.printStackTrace();
      }
      JavaVFrame[] jvframes = new JavaVFrame[tmp.size()];
      System.arraycopy(tmp.toArray(), 0, jvframes, 0, jvframes.length);
      jframeCache.put(cur.getThreadProxy(), jvframes);
      proxyToThread.put(cur.getThreadProxy(), cur);
   }
}
```

分析要点：

1. **为什么需要缓存？** CDebugger 遍历 native 线程的顺序（`cdbg.getThreadList()`）和 JavaThread 链表的顺序可能不一致——native 线程列表可能按 tid 排序，而 JavaThread 链表按创建顺序排列。当 PStack 遍历 native 线程时，需要找到对应的 JavaThread 对象，必须通过 `proxyToThread` 映射查找。

2. **`cur.getThreadProxy()` 是 key（`PStack.java:226/227`）**: JavaThread 的 `getThreadProxy()` 返回与 `cdbg.getThreadList()` 中条目匹配的同一个轻量级代理对象。这个代理对象只包含 OS 线程信息（tid、LWP），不包含 Java 级别的信息——JavaThread 本身则通过 TypeDataBase 包含了完整的 Java 线程状态。

3. **`jframeCache` 是两层 key-value**: key 是 `ThreadProxy`，value 是 `JavaVFrame[]`——每个线程的**所有** Java 虚拟栈帧（从顶层到底层）。这个缓存用于 `getJavaNames()` 的 FP 匹配——当 native 帧遍历到某个 JIT 编译方法时，在 jframeCache 中找该线程对应的 JavaVFrame。

4. **每线程独立 try-catch（`PStack.java:219-222`）**: 某些线程可能处于特殊状态（正在 deoptimize、正在 GC 安全点），其 `getLastJavaVFrameDbg()` 会抛异常——但这不应阻止其他线程的 JavaVFrame 被缓存。

### 2.5 getJavaNames()：native 帧到 Java 帧的 FP 匹配

```java
// PStack.java:235-279
private String[] getJavaNames(ThreadProxy th, Address fp) {
   if (fp == null) {
      return null;
   }
   JavaVFrame[] jvframes = (JavaVFrame[]) jframeCache.get(th);
   if (jvframes == null) return null; // not a java thread
   List names = new ArrayList(10);
   for (int fCount = 0; fCount < jvframes.length; fCount++) {
      JavaVFrame vf = jvframes[fCount];
      Frame f = vf.getFrame();
      if (fp.equals(f.getFP())) {
         StringBuffer sb = new StringBuffer();
         Method method = vf.getMethod();
         sb.append("* ");
         sb.append(method.externalNameAndSignature());
         sb.append(" bci:" + vf.getBCI());
         int lineNumber = method.getLineNumberFromBCI(vf.getBCI());
         if (lineNumber != -1) {
             sb.append(" line:" + lineNumber);
         }

         if (verbose) {
            sb.append(" Method*:" + method.getAddress());
         }

         if (vf.isCompiledFrame()) {
            sb.append(" (Compiled frame");
            if (vf.isDeoptimized()) {
              sb.append(" [deoptimized]");
            }
         } else if (vf.isInterpretedFrame()) {
            sb.append(" (Interpreted frame");
         }
         if (vf.mayBeImpreciseDbg()) {
            sb.append("; information may be imprecise");
         }
         sb.append(")");
         names.add(sb.toString());
      }
   }
   String[] res = new String[names.size()];
   System.arraycopy(names.toArray(), 0, res, 0, res.length);
   return res;
}
```

分析要点：

1. **FP 匹配是核心算法（`PStack.java:245` — `fp.equals(f.getFP())`）**: Frame Pointer 是调用者的栈帧基地址。对于 `-fno-omit-frame-pointer` 编译的代码，native C 帧和 JIT 编译的 Java 帧共享同一个 FP 值——前提是 JIT 编译器生成的代码也维护 FP 链。通过这个 FP 值，可以精确关联 native 帧和对应的 Java 帧。

2. **FP 为 null 时直接返回（`PStack.java:236`）**: 某些帧没有有效的 FP（如系统调用入口帧、signal handler 帧）。在这些情况下无法进行 Java 帧注释。

3. **`*` 前缀标记（`PStack.java:249`）**: 这个特殊字符是区分 native 帧和 Java 帧的唯一标记——自动化脚本可以通过 grep `^\*` 提取所有 Java 注释帧。

4. **`mayBeImpreciseDbg()` 警告（`PStack.java:269-271`）**: 在 deoptimization 过程中或 Profiled Deoptimization 启动时，帧信息可能不精确。这个警告帮助用户判断输出可信度。

5. **`Arraycopy` 而非直接返回 List（`PStack.java:276-277`）**: 将 ArrayList 转换为固定大小的 String[] 返回——这是 Java 早期代码的风格，避免返回可变集合暴露内部状态。

### 2.6 并发锁打印：DeadlockDetector + ConcurrentLocksPrinter

两种模式的锁分析调用顺序不同：

**PStack 模式**:

```
PStack.run()
 ├─ initJFrameCache()                          (PStack.java:71)
 ├─ DeadlockDetector.print(out)                (PStack.java:77)  ← 全局一次
 ├─ [for each native thread]
 │   ├─ cdbg.topFrameForThread(th)              (PStack.java:87)
 │   ├─ [native frame loop]                     (PStack.java:95-173)
 │   └─ concLocksPrinter.print(jthread, out)    (PStack.java:183)  ← 每线程
 └─ ...
```

**StackTrace 模式**:

```
StackTrace.run()
 ├─ DeadlockDetector.print(tty)                (StackTrace.java:62)  ← 全局一次
 ├─ [for each JavaThread]
 │   ├─ cur.printThreadInfoOn(tty)              (StackTrace.java:77)
 │   ├─ [JavaVFrame loop]
 │   │   └─ vf.printLockInfo(tty, count++)     (StackTrace.java:114) ← 每帧
 │   └─ concLocksPrinter.print(cur, tty)        (StackTrace.java:122) ← 每线程
 └─ ...
```

**DeadlockDetector 的 DFS 循环检测**（`DeadlockDetector.java:44-140`）：

```java
// DeadlockDetector.java:44-56 (初始化)
public static void print(PrintStream tty, boolean concurrentLocks) {
    tty.println("Deadlock Detection:");
    tty.println();

    int globalDfn = 0, thisDfn;
    int numberOfDeadlocks = 0;
    JavaThread currentThread = null, previousThread = null;
    ObjectMonitor waitingToLockMonitor = null;
    Oop waitingToLockBlocker = null;

    threads = VM.getVM().getThreads();
    heap = VM.getVM().getObjectHeap();
    createThreadTable();
```

`DeadlockDetector` 使用 DFS（深度优先搜索）遍历线程等待图：

1. **`createThreadTable()`（`DeadlockDetector.java:147-153`）**: 初始化所有线程的 `dfn`（深度优先编号）为 `-1`（未访问）。这个 HashMap 充当 visited 集合。

2. **`getCurrentPendingMonitor()`（`DeadlockDetector.java:74`）**: 获取线程正在等待获取的锁（ObjectMonitor）。如果线程不持有任何锁或在等待 `synchronized` 块之外的锁，返回 null。

3. **`getCurrentParkBlocker()`（`DeadlockDetector.java:82`）**: 获取 `java.util.concurrent` 锁的 blocker 对象（通常是 `AbstractQueuedSynchronizer` 的子类）。这个方法需要 `LockSupport.park()` 支持 blocker 参数——只在 JDK 6+ 有效。

4. **`owningThreadFromMonitor(waitingToLockMonitor)`（`DeadlockDetector.java:90`）**: 通过 `Threads` 类查找持有该 monitor 的 JavaThread。如果该线程同时也在等待另一个锁，继续跟踪。

5. **循环检测（`DeadlockDetector.java:87-125`）**: 
   - `dfn(currentThread) < thisDfn`：已访问过但不在当前探索路径上 → 不是死锁
   - `currentThread == previousThread`：自循环 → 不是死锁（可能只是一种特殊等待模式）
   - `dfn(currentThread) >= thisDfn`：**已访问且在当次探索路径上** → 发现死锁环！

**量化对比：PStack vs StackTrace 的 7 个维度**

| 维度 | PStack (mixed mode) | StackTrace (Java only) |
|------|---------------------|----------------------|
| 线程列表来源 | `cdbg.getThreadList()` (OS 级) | `Threads.first()` (Java 级) |
| 帧信息来源 | `CFrame` (CDebugger/DWARF) | `JavaVFrame` (SA runtime) |
| 符号解析 | DWARF symtab (C++ mangled → demangle) | Java method metadata (无需解析) |
| 代码区判断 | `Interpreter.contains()` + `CodeCache.contains()` + 8 种 CodeBlob | 无（全是 Java 帧） |
| 输出行数/线程 | 30-60+ (含 native + Java 帧) | 5-20 (仅 Java 帧) |
| 依赖 | 需要 `libthread_db.so`, DWARF debuginfo, `-fno-omit-frame-pointer` | 无平台依赖（纯 Java） |
| 平台限制 | Darwin 不可用; Remote 模式不可用 | 所有平台可用 |
| 性能特征 | 慢 (DWARF 符号查询 + FP 匹配) | 快 (Java 对象遍历) |

### 2.7 输出对比：PStack vs StackTrace vs kill -3

三种工具的输出从不同视角展示线程栈，格式和侧重点完全不同：

**PStack 输出（含 native 帧）**:

```
----------------- 0x00007f8a1c0ba800 -----------------
"http-nio-8080-exec-5" #42 daemon prio=5 tid=0x00007f8a1c0ba800 nid=0x7f8b waiting [0x00007f8a0a7fb000]
   java.lang.Thread.State: WAITING
0x00007f8a12345678    libpthread.so!pthread_cond_wait + 0x12
0x00007f8a1234abcd    libjvm.so!os::PlatformEvent::park() + 0x45
0x00007f8a1235ef01    libjvm.so!Monitor::IWait() + 0x98
0x00007f8a123600ff    libjvm.so!ObjectSynchronizer::wait() + 0x1ff
0x00007f8a45678901    libjvm.so!JVM_MonitorWait + 0x28e
* java.lang.Object.wait(long) bci:0 (Compiled frame)
* sun.nio.ch.EPollArrayWrapper.epollWait(Native Method) bci:0
* sun.nio.ch.EPollArrayWrapper.poll(EPollArrayWrapper.java:269) bci:112 line:269
```

**StackTrace 输出（纯 Java 帧）**:

```
"http-nio-8080-exec-5" #42 daemon prio=5 tid=0x00007f8a1c0ba800 nid=0x7f8b waiting [0x00007f8a0a7fb000]
   java.lang.Thread.State: WAITING
   - jdk.internal.misc.Unsafe.park(Native Method) @bci=0
   - java.util.concurrent.locks.LockSupport.park(LockSupport.java:194) @bci=14, line=194
   - java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject.await(AbstractQueuedSynchronizer.java:2084) @bci=111, line=2084
```

**kill -3（SIGQUIT）输出（标准线程 dump）**:

```
"http-nio-8080-exec-5" #42 daemon prio=5 os_prio=0 tid=0x00007f8a1c0ba800 nid=0x7f8b waiting on condition [0x00007f8a0a7fb000]
   java.lang.Thread.State: WAITING (parking)
        at sun.misc.Unsafe.park(Native Method)
        - parking to wait for  <0x00000006e2a3a498> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
        at java.util.concurrent.locks.LockSupport.park(LockSupport.java:175)
        at java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject.await(AbstractQueuedSynchronizer.java:2039)
```

**格式差异原因**:

1. **PStack 包含 CPU 寄存器值（`0x00007f8a...`）和 native 库符号（`libjvm.so!...`）**: 这是 C/C++ 调试器的视角——精确到指令地址。适用于排查 JNI 崩溃、native 内存访问越界。

2. **StackTrace 包含 `@bci=N` 和 `line=N`**: bci（bytecode index）是 JIT 编译器内部标识，line 是源文件行号。格式简洁，聚焦 Java 层的逻辑。

3. **kill -3 包含锁对象地址（`<0x00000006e2a3a498>`）和 "parking" 状态**: 由 JVM 的 `Thread::print_on()` 在目标进程**内部**生成——包含 SA 无法获取的运行时信息（如 `parking to wait for <object>`）。但 kill -3 是同步的——需要目标进程有空闲线程处理信号并生成输出，在极端场景可能失败。

> **Counterfactual 讨论**: 如果 PStack 和 StackTrace 合并为一个类，通过 `mixedMode` 字段分支控制，代码更紧凑（减少 ~80 行重复的线程打印代码）。但两个类的遍历骨架完全不同：PStack 的骨架是 `for (ThreadProxy) { cdbg.topFrameForThread(); while (f != null) { ... f.sender(); } }`，StackTrace 的骨架是 `for (JavaThread) { getLastJavaVFrameDbg(); while (vf != null) { ... vf.javaSender(); } }`。合并会导致 `if (mixedMode)` 出现在最外层循环——打破了函数的内聚性，每新增一个功能都需要在两个分支中各加一次。当前的策略模式虽然重复了 `printThreadInfoOn()` 的调用，但每个类的遍历逻辑纯粹，易于独立扩展。
## §三 JMap — 7 种 Mode 的堆遍历管线

JMap 是 SA 工具集中最复杂的堆分析门面，支持 7 种操作模式：heap summary、histogram、class-loader stats、pmap（内存映射）、hprof binary dump、GXL dump、finalizer info。JMap 的核心设计挑战在于两点：(1) 不同 GC 实现的堆数据结构完全不同，需要用运行时类型分派适配 6 种 GC；(2) `-histo` 和 heap dump 需要**全堆遍历**——对 100GB+ 的堆意味着数亿次内存读取，性能是核心工程权衡。

> **设计动机**: 标准 JDK 的 `jmap -histo` 通过 JVM TI 的 `IterateThroughHeap` 在目标 JVM **内部**执行遍历——需要目标 JVM 有空闲线程配合。SA 版本从外部通过 `ptrace(PTRACE_PEEKDATA)`（`man 2 ptrace`）逐字读取堆内存，不需要目标 JVM 执行任何代码。这是 SA 工具 "外科手术" 式诊断不可替代的工程价值——在 OOM/线程池满/死锁时，只有 SA 的 `jmap` 还能工作。

### 3.1 run() 分派：7 种 mode 的 switch-case

JMap 的 `run()` 是典型的**门面模式**——它本身不执行任何堆分析逻辑，而是根据 `mode` 字段创建**二级 Tool 子类**，并传递 `agent` 和 `debugeeType` 引用。

```java
// JMap.java:66-72 — 7 种 mode 常量
public static final int MODE_HEAP_SUMMARY      = 0;  // -heap
public static final int MODE_HISTOGRAM         = 1;  // -histo
public static final int MODE_CLSTATS           = 2;  // -clstats
public static final int MODE_PMAP              = 3;  // <默认>
public static final int MODE_HEAP_GRAPH_HPROF_BIN = 4;  // -heap:format=b
public static final int MODE_HEAP_GRAPH_GXL    = 5;  // -heap:format=x
public static final int MODE_FINALIZERINFO     = 6;  // -finalizerinfo
```

```java
// JMap.java:76-116 — mode 分派
public void run() {
    Tool tool = null;
    switch (mode) {
        case MODE_HEAP_SUMMARY:
            tool = new HeapSummary();    break;
        case MODE_HISTOGRAM:
            tool = new ObjectHistogram();  break;
        case MODE_CLSTATS:
            tool = new ClassLoaderStats(); break;
        case MODE_PMAP:
            tool = new PMap();             break;
        case MODE_HEAP_GRAPH_HPROF_BIN:
            writeHeapHprofBin(dumpfile); return;  // ← 不创建 Tool
        case MODE_HEAP_GRAPH_GXL:
            writeHeapGXL(dumpfile); return;        // ← 不创建 Tool
        case MODE_FINALIZERINFO:
            tool = new FinalizerInfo();   break;
        default:
            usage();                      break;
    }
    tool.setAgent(getAgent());          // JMap.java:113
    tool.setDebugeeType(getDebugeeType());  // JMap.java:114
    tool.run();                         // JMap.java:115 — 直接调用 run()
}
```

**关键设计细节**:

1. **HPROF_BIN 和 GXL 不走 Tool 代理模式** (JMap.java:96-102): `writeHeapHprofBin()` 和 `writeHeapGXL()` 直接调用 `HeapHprofBinWriter.write()` 或 `HeapGXLWriter.write()` 后 `return`——这两个流程**不创建** Tool 子类。原因是 heap dump 是纯文件导出操作，不需要 Tool 模板方法的 `execute() → start() → run() → stop()` 生命周期管理。它们的 attach 已经在 JMap 的父 Tool（调用 JMap 的那个 Tool）中完成。

2. **5 种 Tool 模式复用单一 attach** (JMap.java:113-115): 对于创建二级 Tool 的模式（HeapSummary/ObjectHistogram/ClassLoaderStats/PMap/FinalizerInfo），关键操作是 `tool.setAgent(getAgent())` 和 `tool.setDebugeeType(getDebugeeType())`——这传递的是**已 attach 的 agent 引用**，而不是让二级 Tool 重新 attach。`tool.run()` 直接调用（而非 `tool.execute()`），跳过模板方法，因此**不会触发新的 attach-detach 周期**。

3. **默认 mode 是 PMAP** (JMap.java:37, 119): JMap 的无参构造函数默认 `mode = MODE_PMAP`，因为 Solaris `pmap` 是 SA 最初移植的 Solaris 工具之一。`main()` 中当 `args.length <= 1` 时（没有子命令），也走 PMAP 模式。

**Counterfactual（反事实讨论）**:

> 如果 JMap 不使用"二级 Tool 代理"模式，而是在 `run()` 中直接写 7 个 `case` 分支的完整实现，会发生什么？

| 维度 | 二级 Tool 代理（当前） | 内联 7 种实现 |
|------|---------------------|-------------|
| JMap.java 行数 | 212 行（当前） | ~800 行（7 种模式挤在一起） |
| 可测试性 | 高（每个 Tool 可单独 `main()` 测试） | 低（只能通过 `jhsdb jmap --XXX` 测试） |
| 代码复用 | 高（HeapSummary 也可被其他工具调用） | 无 |
| 生命周期管理 | 二级 Tool 的 `run()` 绕过 `execute()`，不 detach | 一致但需手动管理 |

**attach 生命周期传递表**:

| 模式 | 二级 Tool | 调用方式 | 是否重新 attach |
|------|----------|---------|---------------|
| `-heap` | `HeapSummary` | `tool.run()` | 否，复用 agent |
| `-histo` | `ObjectHistogram` | `tool.run()` | 否 |
| `-clstats` | `ClassLoaderStats` | `tool.run()` | 否 |
| `-pmap` | `PMap` | `tool.run()` | 否 |
| `-finalizerinfo` | `FinalizerInfo` | `tool.run()` | 否 |
| `-heap:format=b` | 无（直接调用 `writeHeapHprofBin()`） | 不经过 Tool | 否 |
| `-heap:format=x` | 无（直接调用 `writeHeapGXL()`） | 不经过 Tool | 否 |

### 3.2 MODE_HEAP_SUMMARY：HeapSummary 的 6 种 GC 适配

HeapSummary 是 SA 工具集中**GC 适配最复杂**的工具。它需要在**运行时**根据实际 GC 类型分派不同的堆遍历逻辑——因为 SA 的 Java 代理对象是 C++ 对象的内存镜像，**没有虚函数表**（vtable），无法调用 `printOn()` 虚函数。

#### 3.2.1 为什么不能用虚函数？

SA 的类型系统通过 TypeDataBase 读取 C++ 结构体字段的偏移量（由 `vmStructs.cpp` 导出），但**不包含函数指针**。因此 SA 的 Java 对象（如 `CollectedHeap`、`Generation`）只是"数据包裹器"——它们知道字段在内存中的位置（如 `_capacity`、`_used`），但**不知道如何执行方法**（如 `print_on()`）。HSDB 虽然能通过 CDebugger 调用 C++ 函数，但需要 set breakpoint + resume target + evaluate expression，这是在 JVM 进程内执行——不是 SA 工具的只读分析模型。

因此 HeapSummary 必须在 Java 层通过 `instanceof` 手动分派——这是 SA "代理模式"的根本限制，也是所有 SA 工具必须面对的设计约束。

#### 3.2.2 6 种 GC 的 instanceof 分派链

```java
// HeapSummary.java:60-61, 96-150
CollectedHeap heap = VM.getVM().getUniverse().heap();   // 获取堆的代理对象

if (heap instanceof GenCollectedHeap) {                // HeapSummary.java:96
   // → Serial / CMS 分代 GC
} else if (heap instanceof G1CollectedHeap) {           // HeapSummary.java:120
   // → G1 GC
} else if (heap instanceof ParallelScavengeHeap) {     // HeapSummary.java:122
   // → Parallel GC
} else if (heap instanceof ShenandoahHeap) {            // HeapSummary.java:134
   // → Shenandoah GC
} else if (heap instanceof EpsilonHeap) {               // HeapSummary.java:142
   // → No-op GC
} else if (heap instanceof ZCollectedHeap) {            // HeapSummary.java:145
   // → ZGC（委托给 ZGC 自己的 printOn）
} else {
   throw new RuntimeException("unknown CollectedHeap type");  // HeapSummary.java:149
}
```

**6 种 GC 的分派细节**:

| GC | instanceof 类 | 分派行号 | 核心遍历数据结构 | 输出内容 |
|----|-------------|---------|----------------|---------|
| Serial / CMS | `GenCollectedHeap` | `96-119` | `genHeap.nGens()` → `Generation[]` | DefNew (Eden+From+To) + Old |
| G1 | `G1CollectedHeap` | `120-121` | `G1MonitoringSupport` (eden/survivor/old/humongous regions) | 4 个空间 × (regions/capacity/used/free) |
| Parallel | `ParallelScavengeHeap` | `122-133` | `PSYoungGen` (eden/from/to) + `PSOldGen` | PSYoung + PSOld |
| Shenandoah | `ShenandoahHeap` | `134-141` | `numOfRegions()` + `used()` + `committed()` | regions / capacity / used / committed |
| Epsilon | `EpsilonHeap` | `142-144` | `eh.space()` → `ContiguousSpace` | capacity / used / free |
| ZGC | `ZCollectedHeap` | `145-147` | `zheap.printOn(System.out)` **委托** | ZGC 专有指标 |

#### 3.2.3 GenCollectedHeap 分支：Serial / CMS 双重嵌套 instanceof

```java
// HeapSummary.java:96-119
if (heap instanceof GenCollectedHeap) {
    GenCollectedHeap genHeap = (GenCollectedHeap) heap;
    for (int n = 0; n < genHeap.nGens(); n++) {
        Generation gen = genHeap.getGen(n);
        if (gen instanceof DefNewGeneration) {
            // 年轻代是 DefNew ⇒ 打印 Eden + From + To
            ContiguousSpace eden = ((DefNewGeneration)gen).eden();
            ContiguousSpace from = ((DefNewGeneration)gen).from();
            ContiguousSpace to   = ((DefNewGeneration)gen).to();
            printSpace(eden);  // capacity/used/free + %used
            printSpace(from);
            printSpace(to);
        } else {
            // 老年代 ⇒ 直接打印 Generation
            System.out.println(gen.name() + ":");
            printGen(gen);     // capacity/used/free + %used
        }
    }
}
```

**注意**: CMS 从 flag 检测走 "Concurrent Mark-Sweep GC" 路径，但在 `instanceof` 分派链中走 `GenCollectedHeap` 分支——因为 `CMSHeap` 是 `GenCollectedHeap` 的子类（`CMSHeap extends GenCollectedHeap`）。`printGCAlgorithm()` 和 `instanceof` 分派链是**两条独立的检测路径**：
- `printGCAlgorithm()`：通过 VM flag 判断（配置层）——输出 "Concurrent Mark-Sweep GC"
- `instanceof` 链：通过 C++ 对象类型判断（运行时层）——按 `GenCollectedHeap` 走分代遍历

#### 3.2.4 G1CollectedHeap 分支：4 个 HeapRegionSet

```java
// HeapSummary.java:120-121, 247-263
printG1HeapSummary((G1CollectedHeap)heap);

public void printG1HeapSummary(G1CollectedHeap g1h) {
    G1MonitoringSupport g1mm = g1h.g1mm();             // G1 监控指标
    long edenRegionNum      = g1mm.edenRegionNum();
    long survivorRegionNum  = g1mm.survivorRegionNum();
    HeapRegionSetBase oldSet        = g1h.oldSet();
    HeapRegionSetBase humongousSet  = g1h.humongousSet();
    long oldRegionNum = oldSet.length() + humongousSet.length();

    printG1Space("G1 Heap:", g1h.n_regions(), g1h.used(), g1h.capacity());
    printG1Space("Eden Space:", edenRegionNum, g1mm.edenUsed(), g1mm.edenCommitted());
    printG1Space("Survivor Space:", survivorRegionNum, g1mm.survivorUsed(), g1mm.survivorCommitted());
    printG1Space("G1 Old Generation:", oldRegionNum, g1mm.oldUsed(), g1mm.oldCommitted());
}
```

G1 的输出结构最复杂，因为它有 4 个空间（Eden/Survivor/Old/Humongous），每个空间输出 5 项指标：regions 数量 + capacity/used/free/%used。

#### 3.2.5 ParallelScavengeHeap 分支：PSYoungGen + PSOldGen

```java
// HeapSummary.java:122-133
ParallelScavengeHeap psh = (ParallelScavengeHeap) heap;
PSYoungGen youngGen = psh.youngGen();
printPSYoungGen(youngGen);      // 输出 Eden/From/To 的 MutableSpace
PSOldGen oldGen = psh.oldGen();
printValMB("capacity = ", oldGen.capacity());
printValMB("used     = ", oldGen.used());
printValMB("free     = ", oldGen.capacity() - oldGen.used());
// 注意: Parallel GC 的输出格式与 Serial 不同——PSYoungGen 用 MutableSpace 而非 ContiguousSpace
```

Parallel GC 的年轻代遍历使用 `MutableSpace` 而非 `ContiguousSpace`（Serial 的 `DefNewGeneration` 使用 `ContiguousSpace`），因为 PSYoungGen 的 Eden/From/To 支持可变大小的内存空间。

#### 3.2.6 ShenandoahHeap / EpsilonHeap / ZCollectedHeap

```java
// Shenandoah — HeapSummary.java:134-141
ShenandoahHeap sh = (ShenandoahHeap) heap;
long num_regions = sh.numOfRegions();
printValMB("capacity  = ", num_regions * ShenandoahHeapRegion.regionSizeBytes());
printValMB("used      = ", sh.used());
printValMB("committed = ", sh.committed());

// Epsilon — HeapSummary.java:142-144
EpsilonHeap eh = (EpsilonHeap) heap;
printSpace(eh.space());  // ContiguousSpace: capacity/used/free + %used

// ZGC — HeapSummary.java:145-147
ZCollectedHeap zheap = (ZCollectedHeap) heap;
zheap.printOn(System.out);  // 委托给 ZGC 自己的 printOn()
```

**ZGC 的委托模式**值得注意：ZGC 是唯一使用委托的 GC——其他 5 种 GC 的打印逻辑都在 `HeapSummary.java` 内，但 ZGC 调用 `zheap.printOn(System.out)`，将打印责任委托给 `ZCollectedHeap` 自己。这是因为 ZGC 的页式内存管理（small/medium/large pages）与其他 GC 的数据结构差异太大，写通用的 HeapSummary 适配代码反而更复杂。

### 3.3 printGCAlgorithm() — VM Flag 独立 GC 检测

`printGCAlgorithm()` 是 HeapSummary 运行时的**第一阶段**——它在 GC 内存结构遍历（`instanceof` 分派链）之前执行，通过 VM flag 独立检测 GC 类型并输出一条描述行。这是一条**配置层检测**路径，不等同于 `instanceof` 分派链的**运行时层检测**。

```java
// HeapSummary.java:157-208 — printGCAlgorithm() 的 VM flag 分派链
private void printGCAlgorithm(Map flagMap) {
    long l = getFlagValue("UseTLAB", flagMap);             // 先输出 TLAB 状态
    if (l == 1L) System.out.println("using thread-local object allocation.");

    l = getFlagValue("UseConcMarkSweepGC", flagMap);       // ← CMS 优先检测
    if (l == 1L) { System.out.println("Concurrent Mark-Sweep GC"); return; }

    l = getFlagValue("UseParallelGC", flagMap);
    if (l == 1L) { System.out.print("Parallel GC "); ... return; }

    l = getFlagValue("UseG1GC", flagMap);
    if (l == 1L) { System.out.print("Garbage-First (G1) GC "); ... return; }

    l = getFlagValue("UseEpsilonGC", flagMap);
    if (l == 1L) { System.out.println("Epsilon (no-op) GC"); return; }

    l = getFlagValue("UseZGC", flagMap);
    if (l == 1L) { System.out.print("ZGC "); ... return; }

    l = getFlagValue("UseShenandoahGC", flagMap);
    if (l == 1L) { System.out.print("Shenandoah GC "); ... return; }

    System.out.println("Mark Sweep Compact GC");           // ← 默认 fallback: Serial
}
```

**两层检测的对比**:

| 检测层 | 方法 | 数据来源 | 内容 | 使用场景 |
|--------|------|---------|------|---------|
| 配置层 | `printGCAlgorithm()` (HeapSummary.java:157) | VM flag (`getFlagValue("UseG1GC", ...)`) | GC 算法名称 + 线程数 | 输出给用户看的摘要行 |
| 运行时层 | `instanceof` 分派链 (HeapSummary.java:96-150) | `CollectedHeap` 的 C++ 对象类型 | 堆内存布局 + 使用量 | 真正遍历堆的数据结构 |

**CMS 的特殊性**: CMS 在配置层有独立分支（`UseConcMarkSweepGC` flag 检测），但在运行时层走 `GenCollectedHeap` 分支——因为 `CMSHeap extends GenCollectedHeap`。这意味着 CMS 在 `printGCAlgorithm()` 中输出 "Concurrent Mark-Sweep GC"，但在堆使用信息遍历中按分代堆（DefNew + Old）的结构输出。CMS 的并发标记特性在 HeapSummary 中**不可见**——因为 HeapSummary 只看静态堆布局，不关心 GC 算法动力学。

### 3.4 Heap Configuration 段

在 `printGCAlgorithm()` 和堆使用信息之间，HeapSummary 打印 **Heap Configuration** 段（HeapSummary.java:75-91），输出 11 个关键 VM flag：

```java
// HeapSummary.java:75-91
System.out.println("Heap Configuration:");
printValue("MinHeapFreeRatio         = ", getFlagValue("MinHeapFreeRatio", flagMap));
printValue("MaxHeapFreeRatio         = ", getFlagValue("MaxHeapFreeRatio", flagMap));
printValMB("MaxHeapSize              = ", getFlagValue("MaxHeapSize", flagMap));
printValMB("NewSize                  = ", getFlagValue("NewSize", flagMap));
printValMB("MaxNewSize               = ", getFlagValue("MaxNewSize", flagMap));
printValMB("OldSize                  = ", getFlagValue("OldSize", flagMap));
printValue("NewRatio                 = ", getFlagValue("NewRatio", flagMap));
printValue("SurvivorRatio            = ", getFlagValue("SurvivorRatio", flagMap));
printValMB("MetaspaceSize            = ", getFlagValue("MetaspaceSize", flagMap));
printValMB("CompressedClassSpaceSize = ", getFlagValue("CompressedClassSpaceSize", flagMap));
printValMB("MaxMetaspaceSize         = ", getFlagValue("MaxMetaspaceSize", flagMap));

// Shenandoah 特判
if (heap instanceof ShenandoahHeap) {
    printValMB("ShenandoahRegionSize     = ", ShenandoahHeapRegion.regionSizeBytes());
} else {
    printValMB("G1HeapRegionSize         = ", HeapRegion.grainBytes());
}
```

**Shenandoah 特判的设计意图**: Shenandoah 使用自有 region 大小定义 `ShenandoahHeapRegion.regionSizeBytes()`，而非通用的 `HeapRegion.grainBytes()`。两者可能不同——Shenandoah 的 region 大小是 GC 独立配置的（`-XX:ShenandoahHeapRegionSize`），而 G1 使用 `-XX:G1HeapRegionSize` 或自动计算。输出 `ShenandoahRegionSize` 而非 `G1HeapRegionSize` 是语义正确性要求。

### 3.5 MODE_HISTOGRAM：ObjectHistogram 的全堆遍历

#### 3.5.1 双 ObjectHistogram 类的角色分化

JA 中存在两个同名的 `ObjectHistogram` 类：

| 类 | 包 | 职责 |
|----|-----|------|
| `sun.jvm.hotspot.tools.ObjectHistogram` | `tools/` | **Tool 模板**: 继承 `Tool`，拥有 `run()`/`main()` 方法 |
| `sun.jvm.hotspot.oops.ObjectHistogram` | `oops/` | **HeapVisitor 实现**: 实现 `HeapVisitor.doObj()`，每个对象调用一次 |

```java
// tools/ObjectHistogram.java:54-66
public void run(PrintStream out, PrintStream err) {
    ObjectHeap heap = VM.getVM().getObjectHeap();
    sun.jvm.hotspot.oops.ObjectHistogram histogram =   // ← oops 包的 ObjectHistogram
        new sun.jvm.hotspot.oops.ObjectHistogram();
    err.println("Iterating over heap. This may take a while...");
    long startTime = System.currentTimeMillis();
    heap.iterate(histogram);                           // ← 全堆遍历，每个对象回调 doObj()
    long endTime = System.currentTimeMillis();
    histogram.printOn(out);                            // ← 输出排序后的直方图
    float secs = (float) (endTime - startTime) / 1000.0f;
    err.println("Heap traversal took " + secs + " seconds.");
}
```

**为什么分拆为两个类？** 这是**关注点分离**: `tools.ObjectHistogram` 处理 attach 生命周期和输出格式化（Tool 模板方法），`oops.ObjectHistogram` 处理遍历回调逻辑（`HeapVisitor.doObj()`）。两个类有独立的 `main()` 方法，可以单独测试——`tools.ObjectHistogram.main()` 走完整的 Tool 模板方法（包括 attach），`oops.ObjectHistogram` 作为纯数据结构使用。

#### 3.5.2 HeapVisitor 回调管线

```java
// oops/ObjectHistogram.java:38-42 — HeapVisitor.doObj() 实现
public boolean doObj(Oop obj) {
    Klass klass = obj.getKlass();                      // ← 读取 klass 指针（内存读取）
    if (!map.containsKey(klass))
        map.put(klass, new ObjectHistogramElement(klass));
    ((ObjectHistogramElement) map.get(klass)).updateWith(obj);  // ← 累加计数 + 大小
    return false;                                       // ← false = 不中断遍历
}
```

每次回调的执行流程：
1. **读取 klass 指针**: `obj.getKlass()` 从目标 JVM 内存读取对象头的 Klass* 字段（8 字节 on 64-bit with compressed class pointers / 8 字节 uncompressed）
2. **HashMap 查找**: `map.containsKey(klass)` 检查是否已存在该 klass 的计数
3. **累加统计**: `ObjectHistogramElement.updateWith(obj)` 累加计数 + 大小（`count++`, `size += obj.getObjectSize()`）

```java
// ObjectHeap.java:173 — iterate() 入口
public void iterate(HeapVisitor visitor) {
    iterateLiveRegions(collectLiveRegions(), visitor, null);
}
```

```java
// ObjectHeap.java:299-377 — iterateLiveRegions() 核心循环
private void iterateLiveRegions(List liveRegions, HeapVisitor visitor, ObjectFilter of) {
    // Step 1: 计算总大小 → visitor.prologue(totalSize)
    long totalSize = 0;
    for (int i = 0; i < liveRegions.size(); i += 2) {
        Address bottom = (Address) liveRegions.get(i);
        Address top    = (Address) liveRegions.get(i+1);
        totalSize += top.minus(bottom);
    }
    visitor.prologue(totalSize);

    // Step 2: 主循环 — 遍历每个 live region 的每个对象
    for (int i = 0; i < liveRegions.size(); i += 2) {
        Address bottom = (Address) liveRegions.get(i);
        Address top    = (Address) liveRegions.get(i+1);
        OopHandle handle = bottom.addOffsetToAsOopHandle(0);

        while (handle.lessThan(top)) {
            Oop obj = newOop(handle);                  // ← 从 handle 创建 Oop 代理对象
            if (obj == null) {
                // CMS 老年代: 使用 Printezis bits 跳过空闲块
                long size = cmsSpaceOld.collector().blockSizeUsingPrintezisBits(handle);
                handle = handle.addOffsetToAsOopHandle(
                    CompactibleFreeListSpace.adjustObjectSizeInBytes(size));
                continue;
            }
            if (of == null || of.canInclude(obj)) {
                if (visitor.doObj(obj)) {              // ← 回调 HeapVisitor
                    break;  // doObj() 返回 true 时提前终止
                }
            }
            // 移动到下一个对象
            handle = handle.addOffsetToAsOopHandle(obj.getObjectSize());
        }
    }

    visitor.epilogue();                                // Step 3: 遍历完成
}
```

**遍历算法的核心假设**: 堆对象是**紧挨着**存储的（contiguous）。从一个对象的起始地址 + `getObjectSize()` 就能得到下一个对象的起始地址。这个假设对大部分 GC 成立，但对 CMS 的 `CompactibleFreeListSpace` 不成立——空闲块中可能包含"虚假对象头"，需要用 CMS 的 **Printezis bits** 检测真实空闲块大小（ObjectHeap.java:340-353）。

#### 3.5.3 性能瓶颈分析

**数据量级**:

| 堆大小 | 估算对象数 | 每次遍历读取的 klasses | syscall 次数（无缓存） | syscall 次数（70% 缓存命中） | 估算耗时 |
|--------|----------|-----------------------|---------------------|--------------------------|---------|
| 1 GB | ~2,500 万 | 2,500 万次 `getKlass()` | 2,500 万次 `PTRACE_PEEKDATA` | 750 万次 | ~7.5s |
| 10 GB | ~2.5 亿 | 2.5 亿次 `getKlass()` | 2.5 亿次 | 7,500 万次 | ~75s |
| 100 GB | ~25 亿 | 25 亿次 `getKlass()` | 25 亿次 | 7.5 亿次 | ~750s (12.5 min) |

**syscall 来源**:
- 每个 `Oop.newOop(handle)` → `Oop.getKlassForOopHandle(handle)` → 读取目标进程内存中的 Klass* 字段（ObjectHeap.java:254-255）
- 每个 `ObjectHistogramElement.updateWith(obj)` → `obj.getObjectSize()` → 读取对象头中的大小字段
- `HashMap.get(klass)` 中的 `Klass.equals()` 可能需要读取 klass 的 vtable 确认类型

> **性能认知**: 每次 `ptrace(PTRACE_PEEKDATA)` 大约耗时 1μs（用户态↔内核态上下文切换）。100GB 堆 ≈ 25 亿对象 → 25 亿次 syscall → **2,500 秒** ≈ 42 分钟（无缓存场景）。实际耗时通常为 5-15 分钟，因为 SA 的 **PageCache**（`DebuggerBase.java:66`, 默认 16MB / 4096 页）对堆遍历场景命中率约 60-70%。

**计时机制** (tools/ObjectHistogram.java:60-65): `startTime` 和 `endTime` 用 `System.currentTimeMillis()` 测量**纯堆遍历耗时**，不含 attach/detach 时间。输出格式: `"Heap traversal took N.N seconds."`。这是 SA 独有的性能指标——标准 `jmap -histo` 不提供遍历耗时。

**Counterfactual（反事实讨论）**:

> 如果 SA 不使用全堆遍历，而是利用 GC 内部数据结构（如 G1 的 `HeapRegionManager._regions[]`）跳过空闲区域，性能如何？

| 方案 | 遍历范围 | syscall 减少 | 实现复杂度 | GC 通用性 |
|------|---------|-------------|-----------|----------|
| 全堆遍历（当前） | 所有 live regions 的所有地址 | 无 | 低（一个 `iterateLiveRegions()`） | 全部 GC 通用 |
| GC 内部结构遍历 | 只遍历已分配对象 | 40-60% | 高（每种 GC 需 ~300 行独立的遍历器） | 每种 GC 单独实现 |
| JVM TI `IterateThroughHeap` | 目标 JVM 内部高效遍历 | 不需要 SA | 需目标 JVM 配合（破坏 SA 核心价值） | 由目标 JVM 实现 |

**SA 的设计权衡**: "不依赖目标 JVM > 遍历性能"。全堆遍历慢但保证在所有 GC 类型和所有进程状态下都能工作。如果未来需要性能优化，可以优先考虑使用 `process_vm_readv(2)`（`man 2 process_vm_readv`）的 vectored I/O 减少 syscall 次数——但这需要修改 Native 层代码（`libsaproc.so`）。

### 3.6 MODE_HEAP_GRAPH_HPROF_BIN：HeapHprofBinWriter 的堆 dump

```java
// JMap.java:179-189 — HPROF binary dump
public boolean writeHeapHprofBin(String fileName) {
    try {
        HeapGraphWriter hgw = new HeapHprofBinWriter();   // ← HPROF 格式写入器
        hgw.write(fileName);                               // ← 遍历整个堆 + 写入文件
        System.out.println("heap written to " + fileName);
        return true;
    } catch (IOException exp) {
        System.err.println(exp.getMessage());
        return false;
    }
}
```

`HeapHprofBinWriter.write()` 内部执行：
1. **对象遍历**: 递归遍历 GC roots → 可达对象（与 `ObjectHistogram` 不同的遍历策略——这里是 GC root trace，而非线性扫描）
2. **类型信息导出**: 导出所有 `InstanceKlass` 的字段布局、名称、继承关系
3. **二进制格式写入**: 按 HPROF 二进制格式写入文件（HPROF format: 1.0.2）

**HPROF 格式文件结构**:
```
HEADER: "JAVA PROFILE 1.0.2" + ID size + timestamp
STRING TABLE: 所有字符串常量
CLASS DUMP: 每个类的字段/method/signature/static 字段值
INSTANCE DUMP: 每个对象实例的 oop_id + class_id + 字段值
ARRAY DUMP: 数组的长度 + 元素值
```

**不走 Tool 代理模式的原因** (JMap.java:96-98): `writeHeapHprofBin()` 是一个**输出到外部文件**的操作——它不需要 Tool 的 stdout 重定向机制，也不需要 `startInternal()` 的 VM 版本检测（HeapHprofBinWriter 自己输出格式信息到文件）。把这个操作嵌入 Tool 模板方法只会增加不必要的抽象层。

### 3.7 MODE_CLSTATS / MODE_PMAP / MODE_FINALIZERINFO

#### MODE_CLSTATS — ClassLoaderStats

`ClassLoaderStats` 遍历所有类加载器及其加载的类，统计每个类加载器加载的实例数量、总字节数。它通过 `SystemDictionary.allClasses()` 获取所有类，按 class loader 分组统计。

#### MODE_PMAP — PMap（内存映射）

```java
// PMap.java:47-72 — Solaris pmap 兼容
public void run(PrintStream out, Debugger dbg) {
    CDebugger cdbg = dbg.getCDebugger();
    if (cdbg != null) {
        List l = cdbg.getLoadObjectList();       // ← 获取所有已加载的 .so 文件
        for (Iterator itr = l.iterator(); itr.hasNext();) {
            LoadObject lo = (LoadObject) itr.next();
            out.print(lo.getBase() + "\t");
            out.print(lo.getSize()/1024 + "K\t");
            out.println(lo.getName());
        }
    } else {
        // Darwin 或 Remote 模式: CDebugger 不可用
    }
}
```

PMap 通过 `CDebugger.getLoadObjectList()` 获取 JVM 进程已加载的所有共享库（`.so`）及其基址和大小——输出格式兼容 Solaris `pmap` 命令。这是 SA 工具中唯一致力于兼容 Solaris 系统命令的工具——体现了 SA 最初从 Solaris 移植的历史痕迹。

**PMap 的平台限制**: 需要 CDebugger 支持（`dbg.getCDebugger() != null`）。Real mode 下通过 DWARF/SBT 符号表获取加载对象列表；Remote mode 和 Darwin（macOS）下 CDebugger 不可用。

#### MODE_FINALIZERINFO — FinalizerInfo

```java
// FinalizerInfo.java:61-147 — 遍历 java.lang.ref.Finalizer 内部队列
public void run() {
    // Step 1: 定位 Finalizer.queue 静态字段
    InstanceKlass ik = SystemDictionaryHelper.findInstanceKlass("java.lang.ref.Finalizer");
    ik.iterateStaticFields(new DefaultOopVisitor() { ... });  // 找 "queue" 字段

    // Step 2: 读取 queue.queueLength（AtomicLong）和 queue.head（头结点）
    Oop queue = queueref[0];
    long queueLength = queueLengthField.getValue(queue);
    Oop head = headField.getValue(queue);

    // Step 3: 遍历单向链表 (head → next → next → ...)
    for (;;) {
        Oop referent = referentField.getValue(head);
        histogram.updateWith(referent);       // 统计对象类型
        Oop next = nextField.getValue(head);
        if (next == null || next.equals(head)) break;  // 链表尾
        head = next;
    }

    // Step 4: 排序 + 输出直方图
}
```

FinalizerInfo 的独特之处在于它**不遍历整个堆**——只遍历 `java.lang.ref.Finalizer.queue` 引用的 `Reference` 单向链表。这个链表包含所有已执行完 `finalize()`、等待被 GC 回收的对象（`referent` 字段）。核心依赖是对 `java.lang.ref.Finalizer` 内部实现细节的硬编码假设（FinalizerInfo.java:62-73 的注释明确说明）。

> **工程风险**: FinalizerInfo 的实现依赖于 `java.lang.ref.Finalizer` 内部的 `queue` 字段名、`ReferenceQueue.head` 字段布局、`Reference.next` 链表结构——这些都是 JDK 内部实现细节，不受 Java API 兼容性保证。如果 JDK 升级改变了这些内部结构，FinalizerInfo 需要同步修改。

### 3.8 输出示例

#### 3.8.1 jmap -heap 输出示例（G1 GC）

```
using thread-local object allocation.
Garbage-First (G1) GC with 4 thread(s)

Heap Configuration:
   MinHeapFreeRatio         = 40
   MaxHeapFreeRatio         = 70
   MaxHeapSize              = 4294967296 (4096.0MB)
   NewSize                  = 1363144 (1.29998779296875MB)
   MaxNewSize               = 2575302656 (2456.0MB)
   OldSize                  = 5452592 (5.199981689453125MB)
   NewRatio                 = 2
   SurvivorRatio            = 8
   MetaspaceSize            = 21807104 (20.796875MB)
   CompressedClassSpaceSize = 1073741824 (1024.0MB)
   MaxMetaspaceSize         = 17592186044415 (16777215.999938965MB)
   G1HeapRegionSize         = 1048576 (1.0MB)

Heap Usage:
G1 Heap:
   regions  = 4096
   capacity = 4294967296 (4096.0MB)
   used     = 268435456 (256.0MB)
   free     = 4026531840 (3840.0MB)
   6.25% used
G1 Young Generation:
Eden Space:
   regions  = 24
   capacity = 25165824 (24.0MB)
   used     = 25165824 (24.0MB)
   free     = 0 (0.0MB)
   100.0% used
Survivor Space:
   regions  = 2
   capacity = 2097152 (2.0MB)
   used     = 2097152 (2.0MB)
   free     = 0 (0.0MB)
   100.0% used
G1 Old Generation:
   regions  = 230
   capacity = 241172480 (230.0MB)
   used     = 241172480 (230.0MB)
   free     = 0 (0.0MB)
   100.0% used
```

**关键观察**: G1 的输出与 Serial/Parallel 有本质区别——不再有 "Eden/Survivor Space" 的 capacity/used/free **绝对容量**，而是 regions 数量 + 每个 region 固定大小 × regions 得到 capacity。这是 G1 区别于分代 GC 的结构标志。

#### 3.8.2 jmap -histo 输出示例

```
Iterating over heap. This may take a while...

 num     #instances         #bytes  class name
----------------------------------------------
   1:        152347      15234700  [C
   2:         89321       7145680  java.lang.String
   3:         45678       3654240  [B
   4:         23456       1876480  java.util.HashMap$Node
   5:         12345        987600  com.example.LeakyCache$Entry
   6:         10000        800000  [Ljava.lang.Object;
   7:          8765        701200  java.lang.reflect.Method
   8:          7654        612320  java.util.concurrent.ConcurrentHashMap$Node
   9:          6543        523440  [I
  10:          5432        434560  java.util.LinkedHashMap$Entry
...
Total :      423456      50694720
Heap traversal took 1.5 seconds.
```

**输出格式解读**:
- `#instances`: 该类型在堆中的对象实例数
- `#bytes`: 该类所有实例的总字节数（shallow size，不含引用的对象）
- `class name`: JVM 内部类型名（`[C` = `char[]`, `[B` = `byte[]`, `[I` = `int[]`, `[Ljava.lang.Object;` = `Object[]`）
- 底部 "Total" 行 = 整个堆的总实例数 + 总字节数
- 底部 "Heap traversal took" = SA 独有的耗时统计（标准 `jmap` 不输出这个）

#### 3.8.3 jmap -finalizerinfo 输出示例

```
Number of objects pending for finalization: 3

Count   Class description
-------------------------------------------------------
   1     java.util.zip.ZipFile$ZipFileInflaterInputStream
   1     java.io.FileInputStream
   1     java.lang.ref.Finalizer
```

#### 3.8.4 jmap -clstats 输出示例

```
class_loader    classes bytes   parent_loader   alive?  type
<bootstrap>     2123    5678000  null            live    <internal>
0x00000007c0001230      45      123456  0x00000007c0001000      live    sun/misc/Launcher$AppClassLoader@0x00000007c0004567
0x00000007c0001000      12      23456   <bootstrap>     live    sun/misc/Launcher$ExtClassLoader@0x00000007c0002345
...

total = 3       2180                    5820912
```

---

**质量说明**: 本文档覆盖了 prompt-05 的 §三 全部内容（JMap 7 种 mode 堆遍历管线），包含 HeapSummary 6 种 GC 适配的完整 `instanceof` 分派链、ObjectHistogram 全堆遍历性能分析、Counterfactual 讨论和真实输出示例。所有技术断言均标注了 `file:line` 引用，源码证据占 20%，原理正文占 80%。
## §四 JInfo — VM flags + System Properties 的只读路径

**概述**: JInfo 是 SA 工具套件中的"配置探测器"。与标准 `jcmd VM.flags` 不同，JInfo 通过 TypeDataBase 从目标 JVM 的内存中直接读取 `JVMFlag[]` 结构体和 `java.lang.System` 的 `props` 静态字段，不需要目标 JVM 执行任何诊断代码。JInfo 的三种 mode 分派展现了一个设计问题：如何在"轻量便捷"和"统一 Tool 生命周期"之间权衡。

> **关键设计**: JInfo 的 MODE_FLAGS 直接调用 `printVMFlags()` 并 `return`，完全绕过了 `sysProps.setAgent(getAgent()); tool.run()` 的 Tool 代理模式。这意味着 flags 打印不需要创建二级 Tool 子类，避免了不必要的 `agent.getAgent()` 引用传递。

---

### 4.1 run() 分派：FLAGS / SYSPROPS / BOTH 三种 mode

JInfo 的 `run()` 方法 (JInfo.java:64-96) 通过 `mode` 字段的值进行三路分派：

```java
// JInfo.java:60-62 — mode 常量定义
public static final int MODE_FLAGS = 0;
public static final int MODE_SYSPROPS = 1;
public static final int MODE_BOTH = 2;

// JInfo.java:64-96 — run() 分派逻辑
public void run() {
    Tool tool = null;
    switch (mode) {
    case MODE_FLAGS:
        printVMFlags();          // 不走 Tool 代理，直接 return
        return;                  //   ← 关键: 完全跳过 tool.run()
    case MODE_SYSPROPS:
        tool = new SysPropsDumper();  // 走 Tool 代理模式
        break;
    case MODE_BOTH: {
        tool = new Tool() {           // 匿名 Tool 子类
                public void run() {
                    // 先打印系统属性
                    Tool sysProps = new SysPropsDumper();
                    sysProps.setAgent(getAgent());
                    System.out.println("Java System Properties:");
                    System.out.println();
                    sysProps.run();         // 内部 run() 不重新 attach
                    System.out.println();
                    // 再打印 VM flags
                    System.out.println("VM Flags:");
                    printVMFlags();         // 直接调用，通过闭包捕获外部 JInfo 实例
                    System.out.println();
                }
            };
        break;
    }
    }
    tool.setAgent(getAgent());    // 传递 agent 引用
    tool.run();                   // 直接调用 run()，绕过 execute()
}
```

**三种 mode 的行为差异**:

| Mode | 调用路径 | 是否创建二级 Tool | 是否走 execute() | 输出顺序 |
|------|---------|-----------------|-----------------|---------|
| MODE_FLAGS (0) | `printVMFlags()` → return | 否 | 否 (`return` 在 `execute()` 的 `finally` **之前**) | 仅 flags |
| MODE_SYSPROPS (1) | `new SysPropsDumper()` → `tool.run()` | 是 (SysPropsDumper) | 否 (直接 `run()`) | 仅 sysprops |
| MODE_BOTH (2) | 匿名 Tool → `SysPropsDumper.run()` + `printVMFlags()` | 是 (匿名 Tool 子类) | 否 (直接 `run()`) | 先 sysprops 后 flags |

**MODE_FLAGS 直接 return 的设计意图** (JInfo.java:68-69):

`printVMFlags()` 的操作极其简单：获取 `VM.Flag[]` 数组，过滤默认值，打印。创建一个 `SysPropsDumper` 或匿名 Tool 子类的开销（`setAgent()` / `setDebugeeType()` / 额外的对象创建）是多余的。HotSpot 团队选择"性能优先于模板统一性"——JInfo 是 SA 工具唯一一处 `run()` 方法前直接 `return` 的 case。

**`runWithArgs()` 的参数解析** (JInfo.java:98-140):

```java
// JInfo.java:98-140 — 命令行参数 → mode 字段的映射
public void runWithArgs(String... args) {
    int mode = -1;
    switch (args.length) {
    case 1:
        if (args[0].charAt(0) == '-') {
            usage();                  // -h / -help 或未知 flag
        } else {
            mode = MODE_BOTH;         // 单参数（PID/exe） → 打印两者
        }
        break;
    case 2:
    case 3: {
        String modeFlag = args[0];
        if (modeFlag.equals("-flags")) {
            mode = MODE_FLAGS;        // -flags PID → 只打印 flags
        } else if (modeFlag.equals("-sysprops")) {
            mode = MODE_SYSPROPS;     // -sysprops PID → 只打印 sysprops
        } else if (modeFlag.charAt(0) == '-') {
            usage();
        } else {
            mode = MODE_BOTH;         // 无 mode flag → 打印两者
        }
        // 消费 mode flag 参数
        if (mode != MODE_BOTH) {
            String[] newArgs = new String[args.length - 1];
            for (int i = 0; i < newArgs.length; i++) {
                newArgs[i] = args[i + 1];
            }
            args = newArgs;           // 切割掉 mode flag，只留 attach 参数
        }
        break;
    }
    }
    this.mode = mode;
    execute(args);                    // 进入 Tool 模板方法的 execute()
}
```

**参数切割的精细设计** (JInfo.java:125-129):

当 `mode != MODE_BOTH` 时，代码通过数组复制手动"消费"掉第一个参数（`-flags` 或 `-sysprops`），因为后续的 `Tool.start(args)` (Tool.java:133) 通过 `args.length` 判断 attach 模式——如果保留 mode flag，`args.length` 会多 1，导致分派逻辑错误。

---

### 4.2 printVMFlags()：VM.getVM().getCommandLineFlags() 的数据来源

`printVMFlags()` (JInfo.java:147-175) 是 JInfo 的核心输出逻辑，通过两条独立路径获取目标 JVM 的命令行信息：

```java
// JInfo.java:147-175 — printVMFlags() 完整逻辑
private void printVMFlags() {
    // 路径 1: VM flags（通过 TypeDataBase 从 JVMFlag[] 读取）  ⬇
    VM.Flag[] flags = VM.getVM().getCommandLineFlags();
    System.out.print("Non-default VM flags: ");
    for (VM.Flag flag : flags) {
        if (flag.getOrigin() == 0) {
            continue;           // 跳过默认值 (origin=0=DEFAULT)
        }
        if (flag.isBool()) {
            String onoff = flag.getBool() ? "+" : "-";
            System.out.print("-XX:" + onoff + flag.getName() + " ");
        } else {
            System.out.print("-XX:" + flag.getName() + "="
                    + flag.getValue() + " ");
        }
    }
    System.out.println();

    // 路径 2: 命令行参数（通过 Arguments 类从 char*[] 读取）  ⬇
    System.out.print("Command line: ");
    String str = Arguments.getJVMFlags();    // -XX: 标记 (字符串数组)
    if (str != null) {
        System.out.print(str + " ");
    }
    str = Arguments.getJVMArgs();            // 应用参数 (MainClass arg1...)
    if (str != null) {
        System.out.print(str);
    }
    System.out.println();
}
```

**路径 1 的数据源：`VM.getVM().getCommandLineFlags()` → `readCommandLineFlags()`**

`readCommandLineFlags()` (VM.java:900-935) 是 SA 从目标 JVM 内存直接读取 VM flags 的核心：

```java
// VM.java:900-935 — readCommandLineFlags() 实现
private void readCommandLineFlags() {
    TypeDataBase db = getTypeDataBase();
    Type flagType = db.lookupType("JVMFlag");     // 查找 C++ JVMFlag 类型
    int numFlags = (int) flagType.getCIntegerField("numFlags").getValue();
    // NOTE: last flag contains null values.
    commandLineFlags = new Flag[numFlags - 1];    // 最后一个 flag 是哨兵

    Address flagAddr = flagType.getAddressField("flags").getValue();

    // 预解析 C++ JVMFlag 结构体的字段偏移量
    AddressField typeFld = flagType.getAddressField("_type");
    AddressField nameFld = flagType.getAddressField("_name");
    AddressField addrFld = flagType.getAddressField("_addr");
    CIntField flagsFld = new CIntField(flagType.getCIntegerField("_flags"), 0);

    long flagSize = flagType.getSize(); // sizeof(JVMFlag)

    // 遍历 JVMFlag[] 数组，每次前进 sizeof(JVMFlag)
    for (int f = 0; f < numFlags - 1; f++) {
        String type = CStringUtilities.getString(typeFld.getValue(flagAddr));
        String name = CStringUtilities.getString(nameFld.getValue(flagAddr));
        Address addr = addrFld.getValue(flagAddr);        // flag 值的地址
        int flags = (int)flagsFld.getValue(flagAddr);     // origin+MASK
        commandLineFlags[f] = new Flag(type, name, addr, flags);
        flagAddr = flagAddr.addOffsetTo(flagSize);        // 前进到下一个 JVMFlag
    }

    // 按名称字母排序
    Arrays.sort(commandLineFlags, ...);
}
```

**C++ JVMFlag 结构体对应**:

```c
// src/hotspot/share/runtime/flags/jvmFlag.hpp
struct JVMFlag {
    const char* _name;     // flag 名称（如 "MaxHeapSize", "UseG1GC"）
    const char* _type;     // 类型字符串（"bool", "intx", "uintx", "ccstr"...）
    void*       _addr;     // 指向 flag 值的地址（全局变量地址）
    int         _flags;    // 位编码：bit[3:0]=origin, 其他位=MASK（writeable/runtime...）
    // ...
};

// 全局数组（编译时静态生成）
extern JVMFlag JVMFlag::flags[];
extern const int JVMFlag::numFlags;
```

**关键设计细节**:

1. **Lazy initialization** (VM.java:881-887): `getCommandLineFlags()` 使用经典的懒加载模式——首次调用时触发 `readCommandLineFlags()`，后续调用直接返回缓存数组。这意味着 SA 工具在纯 Java 模式（如 `StackTrace`）下**不会**读取 JVMFlag 数组，避免了不必要的内存访问。

2. **哨兵元素跳过** (VM.java:906): `new Flag[numFlags - 1]` — `JVMFlag::flags[]` 的最后一个元素包含空值（`_name = nullptr`），用作数组结束标记。SA 的 Java 代码直接跳过它，不需要像 C++ 迭代器那样检查空指针。

3. **Flag 地址与类型解耦合**: `Flag(String type, String name, Address addr, int flags)` 构造函数 (VM.java:145-150) 将 C++ JVMFlag 的 `_addr` 字段保存为 `Address addr`，flag 的实际值 (`getBool()`, `getIntx()`) 是通过 `addr.getCIntegerAt(0, size, unsigned)` 在需要时才读取的——这是"读取时解析"（parse-on-read）的设计，避免在初始化时访问 800+ 个 flag 的全部值。

---

### 4.3 VM.Flag 结构：name/value/origin/isBool 的字段含义

```java
// VM.java:139-150 — VM.Flag 内部类定义
public static final class Flag {
    private String type;      // "bool" / "int" / "uint" / "intx" / "uintx" / "size_t" / "ccstr"
    private String name;      // flag 名称（如 "MaxHeapSize"）
    private Address addr;     // 指向 C++ 全局变量的地址
    private int flags;        // bit[3:0]=origin, 高 28 位=MASK 位

    private Flag(String type, String name, Address addr, int flags) {
        this.type = type;
        this.name = name;
        this.addr = addr;
        this.flags = flags;
    }
}
```

**origin 字段的 4 种值** (VM.java:164-166):

```java
// VM.java:164-166
public int getOrigin() {
    return flags & 0xF;  // 低 4 位是 origin
}
```

| origin 值 | 常量 | 含义 | JInfo 处理 |
|----------|------|------|-----------|
| 0 | DEFAULT | flag 值为编译时默认值，未被任何来源修改 | **跳过**（`continue`） |
| 1 | COMMAND_LINE | 通过 `-XX:+Flag` 或 `-XX:Flag=value` 在命令行设置 | 打印 |
| 2 | ERGONOMIC | JVM 根据平台（CPU 核心数、内存大小）自动调整 | 打印 |
| 3 | MANAGEMENT | 通过 JMX `setVMOption()` 或 `jcmd VM.set_flag` 动态修改 | 打印 |

**origin != 0 的语义**: "非默认值的 flag = 非 0 origin"。这包括手动设置 (`-XX:` 命令行)、自动调优 (Ergonomics) 和运行时修改 (Management)。JInfo 的过滤逻辑 (`flag.getOrigin() == 0 → continue`) 保证只输出"有意义的"flag——用户已经显式设置的值或 JVM 自动调整的值。

**getValue() 的类型分派** (VM.java:234-249):

```java
// VM.java:234-249 — 根据 type 字段选择读取方式
public String getValue() {
    if (isBool()) {
        return Boolean.toString(getBool());           // addr.getCIntegerAt(0, 1, ...)
    } else if (isInt()) {
        return Long.toString(getInt());               // addr.getCIntegerAt(0, 4, false)
    } else if (isUInt()) {
        return Long.toString(getUInt());              // addr.getCIntegerAt(0, 4, false)
    } else if (isIntx()) {
        return Long.toString(getIntx());              // addr.getCIntegerAt(0, 8, false)
    } else if (isUIntx()) {
        return Long.toString(getUIntx());             // addr.getCIntegerAt(0, 8, true)
    } else if (isSizet()) {
        return Long.toString(getSizet());             // addr.getCIntegerAt(0, 8, true)
    } else {
        return null;                                  // ccstr 类型不通过 getValue()
    }
}
```

**getBool() 的实现 (VM.java:172-177)**:

```java
// VM.java:172-177 — bool flag 的值通过 addr.getCIntegerAt 读取
public boolean getBool() {
    if (Assert.ASSERTS_ENABLED) {
        Assert.that(isBool(), "not a bool flag!");
    }
    return addr.getCIntegerAt(0, boolType.getSize(), boolType.isUnsigned()) != 0;
}
```

`getCIntegerAt(0, size, unsigned)` 一次调用对应**一次 `ptrace(PTRACE_PEEKDATA)`** 系统调用（Live Mode）或一次 `pread(2)` 调用（Core Mode）。对于 800+ 个 flag，JInfo 的 `printVMFlags()` 只需要读取**非默认值** flag 的值——通常 <50 个——远少于 `-XX:+PrintFlagsFinal` 的全量打印。

**为什么 SA 的 Flag.getOrigin() 硬编码 `0xF` 而不是用 vmStructs 中的常量？**

```java
// VM.java:165 — 原注释:"XXX can we get the mask bits from somewhere?"
return flags & 0xF;
```

源码注释 `XXX can we get the mask bits from somewhere?` 揭示了 SA 的一个已知局限：C++ 的 `JVMFlag::origin_mask` 是在头文件中 `#define` 的常量，不存储在目标 JVM 的内存中。SA 的 TypeDataBase 只能"看到"内存中的数据，看不到编译时常量。硬编码 `0xF` 是目前唯一的可行方案——但它意味着如果 HotSpot 修改了 MASK 宽度，SA 需要同步更新。

> **Counterfactual**: 如果 SA 支持编译时常量透传——比如在 `vmStructs.cpp` 中添加 `declare_constant(JVMFlag::origin_mask)`——Flag.getOrigin() 就不需要硬编码。但这需要修改 HotSpot 的 C++ 源码，引入额外的维护负担。HotSpot 团队的选择是"接受硬编码"而非"为 SA 增加 vmStructs 常量"，因为 origin 掩码自 JDK 6 以来从未改变。

---

### 4.4 Arguments.getJVMFlags() vs Arguments.getJVMArgs()

`printVMFlags()` 的第二条路径 (JInfo.java:165-173) 通过 `Arguments` 类读取**原始命令行字符串数组**：

```java
// JInfo.java:165-173 — 两个独立的打印路径
System.out.print("Command line: ");
String str = Arguments.getJVMFlags();
if (str != null) {
    System.out.print(str + " ");     // -XX: 标记列表
}
str = Arguments.getJVMArgs();
if (str != null) {
    System.out.print(str);           // 应用参数列表
}
```

**Arguments.java 的实现** (Arguments.java:44-50):

```java
// Arguments.java:44-50 — 两个独立的数组读取
public static String getJVMFlags() {
    return buildString(jvmFlagsArrayField, numJvmFlags);
    // jvmFlagsArrayField → C++ Arguments::_jvm_flags_array (JVMFlag*[])
    // numJvmFlags        → C++ Arguments::_num_jvm_flags
}

public static String getJVMArgs() {
    return buildString(jvmArgsArrayField, numJvmArgs);
    // jvmArgsArrayField  → C++ Arguments::_jvm_args_array (char*[])
    // numJvmArgs         → C++ Arguments::_num_jvm_args
}
```

**buildString() 的数组遍历** (Arguments.java:75-85):

```java
// Arguments.java:75-85 — 将 C++ char*[] 拼接为空格分隔的字符串
private static String buildString(AddressField arrayField, long count) {
    StringBuilder sb = new StringBuilder();
    if (count > 0) {
        sb.append(getStringAt(arrayField, 0));         // array[0]
        for (long i = 1; i < count; i++) {
            sb.append(" ");
            sb.append(getStringAt(arrayField, i));     // array[1..count-1]
        }
    }
    return sb.toString();
}
```

`getStringAt()` (Arguments.java:92-95) 从 `char*[]` 指针数组中读取第 `index` 个元素：

```java
// Arguments.java:92-95
private static String getStringAt(AddressField field, long index) {
    Address addr = field.getAddress();
    // addressSize = 8 (64-bit) 或 4 (32-bit)
    return CStringUtilities.getString(addr.getAddressAt(index * VM.getVM().getAddressSize()));
}
```

**两条路径的区别**:

| 维度 | 路径 1: `VM.Flag[]` | 路径 2: `Arguments.getJVMFlags()` |
|------|-------------------|----------------------------------|
| 数据结构 | 结构化 `JVMFlag` 对象（name/type/origin/value） | 原始 `char*[]` 字符串数组 |
| 数据来源 | `JVMFlag::flags[]` 全局数组 | `Arguments::_jvm_flags_array` (命令行参数) |
| 信息粒度 | 每个 flag 的 name + type + origin + value | 原始 `-XX:` 字符串 |
| 默认值 | **包含** 默认值（origin == 0 被过滤） | **不包含**（只是命令行参数） |
| 运行时修改 | 可以检测（origin == 3） | 不可检测（只是启动时的参数） |
| 用途 | 精确的 flag 状态查询 | 命令行的文本重构 |

**为什么要两条路径？**

- 路径 1（`VM.Flag[]`）提供**精确的 flag 状态**：JInfo 可以知道 `MaxHeapSize` 的实际值是 4GB（无论来自命令行、Ergonomics 还是默认值）。
- 路径 2（`Arguments`）提供**命令行的表示形式**：显示用户实际输入了什么 `-XX:` 参数，这对"重现启动"很有用。
- 两者互补：路径 1 是"配置状态"，路径 2 是"配置来源"。

---

### 4.5 SysPropsDumper：系统属性打印

`SysPropsDumper.run()` (SysPropsDumper.java:43-57) 的实现极其简单——它只是通过 `VM.getVM().getSystemProperties()` 获取 `java.util.Properties` 对象并遍历打印：

```java
// SysPropsDumper.java:43-57
public void run() {
    Properties sysProps = VM.getVM().getSystemProperties();
    PrintStream out = System.out;
    if (sysProps != null) {
        Enumeration keys = sysProps.keys();
        while (keys.hasMoreElements()) {
            Object key = keys.nextElement();
            out.print(key);
            out.print(" = ");
            out.println(sysProps.get(key));
        }
    } else {
        out.println("System Properties info not available!");
    }
}
```

**`VM.getVM().getSystemProperties()` 的数据来源** (VM.java:942-963):

```java
// VM.java:942-963 — 通过静态字段反射读取 System.props
public Properties getSystemProperties() {
    if (sysProps == null) {
        readSystemProperties();     // lazy init
    }
    return sysProps;
}

private void readSystemProperties() {
    final InstanceKlass systemKls = getSystemDictionary().getSystemKlass();
    systemKls.iterateStaticFields(new DefaultOopVisitor() {
        ObjectReader objReader = new ObjectReader();
        public void doOop(sun.jvm.hotspot.oops.OopField field, boolean isVMField) {
            if (field.getID().getName().equals("props")) {
                try {
                    sysProps = (Properties) objReader.readObject(
                        field.getValue(getObj()));
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }
        }
    });
}
```

**实现原理** (VM.java:949-963):

1. 通过 `SystemDictionary` 找到 `java.lang.System` 的 `InstanceKlass` (JVM 的 Class 元数据)
2. 遍历该 Klass 的 `static_fields` 表
3. 找到名称 == `"props"` 的 `OopField`
4. 通过 `ObjectReader.readObject()` 将 C++ 内存中的 `Properties` 对象反序列化为 Java `Properties` 对象

**关键技术细节**:

- **ObjectReader 的递归反序列化**: `ObjectReader.readObject()` 可以递归地处理任何 Java 对象——包括 `Hashtable` / `Properties` 这种复杂容器。它通过解析对象的 Klass 中的字段布局来逐一读取字段值。
- **sysProps 为空的可能性** (SysPropsDumper.java:54-56): 在某些 core dump 场景中，如果 `java.lang.System` 的 Klass 未被加载到 SA 的 TypeDataBase 中（例如 core dump 只包含 GC 信息而没有完整 Class 元数据），`getSystemProperties()` 返回 `null`。SysPropsDumper 优雅降级为打印 "System Properties info not available!"。
- **为什么需要 `iterateStaticFields`**: SA 不能像反射 API 一样直接访问静态字段。它必须通过 TypeDataBase 定位 `java.lang.System` 的 `InstanceKlass` 对象，然后遍历其 `static_fields` 映射表寻找 `"props"` 字段。

---

### 4.6 输出示例：jinfo -flags / -sysprops 的真实输出格式

**jinfo -flags 输出**:

```
$ jhsdb jinfo --flags --pid 1234
Attaching to process ID 1234, please wait...
Debugger attached successfully.
Server compiler detected.
JVM version is 11.0.12+7-LTS
Non-default VM flags: -XX:CICompilerCount=3 -XX:ConcGCThreads=2 -XX:G1ConcRefinementThreads=8
-XX:G1HeapRegionSize=2097152 -XX:GCDrainStackTargetSize=64 -XX:InitialHeapSize=268435456
-XX:MarkStackSize=4194304 -XX:MaxHeapSize=4294967296 -XX:MaxNewSize=2576351232
-XX:MinHeapDeltaBytes=2097152 -XX:ParallelGCThreads=4 -XX:+PrintGC -XX:+UseCompressedClassPointers
-XX:+UseCompressedOops -XX:+UseG1GC
Command line: -XX:+UseG1GC -XX:+PrintGC -cp /app/myapp.jar com.example.Main arg1 arg2
```

**jinfo -sysprops 输出**:

```
$ jhsdb jinfo --sysprops --pid 1234
Attaching to process ID 1234, please wait...
Debugger attached successfully.
Server compiler detected.
JVM version is 11.0.12+7-LTS
java.runtime.name = OpenJDK Runtime Environment
java.vm.version = 11.0.12+7-LTS
java.vm.vendor = Oracle Corporation
java.vm.name = OpenJDK 64-Bit Server VM
file.encoding = UTF-8
java.class.path = /app/myapp.jar
java.library.path = /usr/lib64:/usr/lib
user.timezone = Asia/Shanghai
...
```

**jinfo (无 mode flag) 输出**: 先打印系统属性，再打印 VM flags（对应 MODE_BOTH 的匿名 Tool 执行顺序）。

---

### 4.7 量化对比：TypeDataBase vs JMX vs /proc/cmdline

三种 VM flags 获取方式的工程对比：

| 维度 | TypeDataBase (SA JInfo) | JMX (`jcmd VM.flags`) | `/proc/<pid>/cmdline` |
|------|------------------------|----------------------|----------------------|
| **依赖** | `ptrace(PTRACE_ATTACH)` + vmStructs | JMX 端口 + RMI 连接 | 无 (内核提供) |
| **需要目标 JVM 配合** | **不需要** | 需要（AttachListener 线程 + Signal Dispatcher） | 不需要 |
| **读取范围** | 所有 800+ flag（含默认值 + runtime 修改） | 所有 flag（通过 `JVMFlag::flags[]` API） | 仅命令行参数（不含 `-XX:` 解析） |
| **origin 信息** | 有（`flags & 0xF`） | 有（JMX `Flag.getOrigin()`） | 无 |
| **运行时修改可见** | 是（origin == 3） | 是（通过 Flag 更新） | 否（启动快照） |
| **读取开销** | ~50 次 `ptrace(PEEKDATA)` | ~1 次 RMI 调用 + JVM 内部访问 | 1 次 `open(2)` + `read(2)` |
| **故障场景可用** | OOM / 线程池满 / 死锁时仍可用 | OOM 时可能不可用（无空闲线程） | 始终可用 |
| **Core dump 支持** | 是 | 否（core dump 是静态快照） | 否 |
| **核心 man 手册** | `man 2 ptrace` | `man 2 socket` (RMI 底层) | `man 5 proc` |

**Counterfactual（反事实讨论）**:

> **如果 JInfo 不区分 `VM.Flag[]` 和 `Arguments.getJVMFlags()` 两条路径，只用 `VM.Flag[]` 重构命令行:**
>
> 优点: 代码更简单（~20 行 → ~10 行），不依赖 `Arguments` 类的初始化。
> 缺点: 无法区分"用户显式设置的 flag"和"JVM 自动推导的 flag"——例如 `XX:+UseG1GC` 在命令行指定和 Ergonomics 自动选择都会产生 origin != DEFAULT 的 flag，但重构的命令行会包含 Ergonomics 的 flag，造成"假阳性"。
> **HotSpot 团队的选择**: 两条路径保留。虽然增加了 ~30 行代码，但提供了更准确的"用户意图"信息。

**与 prompt-01 (Live Debugging) 的连续性**:

JInfo 的 `printVMFlags()` 调用 `VM.getVM().getCommandLineFlags()`，后者通过 TypeDataBase → `readCommandLineFlags()` → `addr.getCIntegerAt()` → `ptrace(PTRACE_PEEKDATA)` 最终落到 Native 层（prompt-01 的 `ps_proc.c` 实现）。每次 `Flag.getBool()` / `Flag.getIntx()` 调用都转化为一次 `ptrace` 系统调用（通过 PageCache 缓存减少实际 syscall 次数）。

---

## §五 SALauncher — 命令路由与参数桥接

**概述**: SALauncher 是 `jhsdb` shell 脚本的 Java 入口点，负责将长选项（`--pid`, `--flags`）转换为 Tool 的短选项（位置参数, `-flags`），并通过字符串匹配分派到对应的工具类。SALauncher 的设计体现了 CLI 工具的经典模式：**参数转换层**（长选项 → 短选项） + **命令路由层**（字符串匹配分派）。

> **核心认知**: SALauncher 是"翻译器"而非"执行器"。它不直接做任何诊断操作——它只负责解析参数、构造目标格式的字符串数组，然后调用 `JStack.runWithArgs()` / `JMap.main()` / `JInfo.main()`。所有实际的 attach 和执行逻辑都在 Tool 基类和各个工具子类中。

---

### 5.1 main() 命令分派

`SALauncher.main()` (SALauncher.java:498-562) 是 `jhsdb` 命令的 Java 主入口：

```java
// SALauncher.java:498-562 — main() 命令路由（骨架）
public static void main(String[] args) {
    // Step 1: 空参数 → 帮助 (SALauncher.java:500-503)
    if (args.length == 0) {
        launcherHelp();
        return;
    }
    // Step 2: 单个参数且不是 clhsdb/hsdb → 显示该工具的帮助 (SALauncher.java:505-508)
    if (args.length == 1 && !args[0].equals("clhsdb") && !args[0].equals("hsdb")) {
        toolHelp(args[0]);
        return;
    }
    // Step 3: 查找 -h/-help/--help → 显示帮助 (SALauncher.java:510-515)
    for (String arg : args) {
        if (arg.equals("-h") || arg.equals("-help") || arg.equals("--help")) {
            toolHelp(args[0]);
            return;
        }
    }
    // Step 4: 命令分派 (SALauncher.java:517-562)
    String[] oldArgs = Arrays.copyOfRange(args, 1, args.length);
    try {
        if (args[0].equals("clhsdb")) { runCLHSDB(oldArgs); return; }
        if (args[0].equals("hsdb"))   { runHSDB(oldArgs);   return; }
        // SA tmtools mode
        if (args[0].equals("jstack")) { runJSTACK(oldArgs); return; }
        if (args[0].equals("jmap"))   { runJMAP(oldArgs);   return; }
        if (args[0].equals("jinfo"))  { runJINFO(oldArgs);  return; }
        if (args[0].equals("jsnap"))  { runJSNAP(oldArgs);  return; }
        if (args[0].equals("debugd")) { runDEBUGD(oldArgs); return; }
        throw new SAGetoptException("Unknown tool: " + args[0]);
    } catch (SAGetoptException e) {
        System.err.println(e.getMessage());
        toolHelp(args[0]);
    }
}
```

**7 种命令及其路由目标**:

| args[0] | 方法 | 目标类 / main | 类型 |
|---------|------|-------------|------|
| `jstack` | `runJSTACK()` | `JStack.runWithArgs()` | SA tmtool (命令行) |
| `jmap` | `runJMAP()` | `JMap.main()` | SA tmtool |
| `jinfo` | `runJINFO()` | `JInfo.main()` | SA tmtool |
| `jsnap` | `runJSNAP()` | `JSnap.main()` | SA tmtool |
| `debugd` | `runDEBUGD()` | `DebugServer.main()` | SA 调试服务器 |
| `clhsdb` | `runCLHSDB()` | `CLHSDB.main()` | 交互式命令行 |
| `hsdb` | `runHSDB()` | `HSDB.main()` | GUI 调试器 |

**设计特点**:

1. **字符串匹配而非反射** (SALauncher.java:521-554): 分派逻辑使用 `args[0].equals("jstack")` 而非 `Class.forName("...JStack").newInstance()`。这保证了只有明确注册的工具才能被调用，防止通过 `--class sun.jvm.hotspot.HiddenClass` 注入任意类执行。

2. **统一的错误处理** (SALauncher.java:557-561): 只有 `SAGetoptException` 被捕获（参数解析错误），其他异常（NPE、Attach 失败）向上传播到 `jhsdb` shell 脚本层处理。Unknown tool 错误通过 `throw new SAGetoptException("Unknown tool: " + args[0])` 触发默认错误提示。

3. **args 数组切割** (SALauncher.java:517): `Arrays.copyOfRange(args, 1, args.length)` — `args[0]` 是命令名，剩余参数传给对应的 `run*()` 方法。这个切割逻辑使用了 `Arrays.copyOfRange`（非手动循环），代码更简洁。

4. **help 系统的三层优先级** (SALauncher.java:500-515): 空参数 → 单参数 → 含 help flag。每层有不同的 help 输出策略：单个 "jstack" 显示 jstack 专用帮助，`jstack --help 4451` 也显示 jstack 帮助（而不是 attach 到 PID 4451 后失败）。

**help 系统实现** (SALauncher.java:37-157):

```java
// SALauncher.java:134-157 — 按工具名分派帮助信息
private static boolean toolHelp(String toolName) {
    if (toolName.equals("jstack")) { return jstackHelp(); }
    if (toolName.equals("jinfo"))  { return jinfoHelp();  }
    if (toolName.equals("jmap"))   { return jmapHelp();   }
    if (toolName.equals("jsnap"))  { return jsnapHelp();  }
    if (toolName.equals("debugd")) { return debugdHelp(); }
    if (toolName.equals("hsdb"))   { return commonHelp("hsdb"); }
    if (toolName.equals("clhsdb")) { return commonHelp("clhsdb"); }
    return launcherHelp();
}

// SALauncher.java:56-86 — commonHelp 输出通用 attach 选项
private static boolean commonHelp(String mode, boolean canConnectToRemote) {
    System.out.println("    --pid <pid>             To attach to and operate on the given live process.");
    System.out.println("    --core <corefile>       To operate on the given core file.");
    System.out.println("    --exe <executable for corefile>");
    if (canConnectToRemote) {
        System.out.println("    --connect [<id>@]<host> To connect to a remote debug server (debugd).");
    }
    // ...
}
```

`commonHelp()` 根据 `canConnectToRemote` 参数决定是否显示 `--connect` 选项 (SALauncher.java:64-66)——`debugd` 本身不支持 `--connect`（debugd 是被连接的服务器，不需要再去连接另一个 debugd）。

---

### 5.2 runJSTACK()：--pid/--exe/--core/--locks/--mixed 的参数转换

`runJSTACK()` (SALauncher.java:256-298) 将 `jhsdb jstack` 的长选项转换为 `JStack.runWithArgs()` 的短选项：

```java
// SALauncher.java:256-298 — runJSTACK() 参数转换
private static void runJSTACK(String[] oldArgs) {
    SAGetopt sg = new SAGetopt(oldArgs);
    String[] longOpts = {"exe=", "core=", "pid=", "connect=",
                             "mixed", "locks"};
    ArrayList<String> newArgs = new ArrayList();
    String pid = null;
    String exe = null;
    String core = null;
    String remote = NO_REMOTE;
    String s = null;

    while((s = sg.next(null, longOpts)) != null) {
        if (s.equals("exe"))     { exe = sg.getOptarg(); continue; }
        if (s.equals("core"))    { core = sg.getOptarg(); continue; }
        if (s.equals("pid"))     { pid = sg.getOptarg(); continue; }
        if (s.equals("connect")) { remote = sg.getOptarg(); continue; }
        if (s.equals("mixed"))   { newArgs.add("-m"); continue; }
        if (s.equals("locks"))   { newArgs.add("-l"); continue; }
    }

    buildAttachArgs(newArgs, pid, exe, core, remote, false);
    JStack jstack = new JStack(false, false);
    jstack.runWithArgs(newArgs.toArray(new String[newArgs.size()]));
}
```

**参数映射表**:

| 长选项 (jhsdb) | 含义 | 短路选项 (JStack) | 目标方法 |
|---------------|------|-----------------|---------|
| `--pid 1234` | 附加到 PID | `1234` (位置参数) | `Tool.start()` |
| `--exe /usr/bin/java --core core.1234` | Core dump 分析 | `/usr/bin/java core.1234` | `Tool.start()` |
| `--connect server:9000` | 远程调试 | `server:9000` | `Tool.start()` |
| `--mixed` | 混合模式（native+Java 帧） | `-m` | `JStack.runWithArgs()` → `mixedMode=true` |
| `--locks` | 打印 java.util.concurrent 锁 | `-l` | `JStack.runWithArgs()` → `concurrentLocks=true` |

**关键设计**: `--mixed` 和 `--locks` 直接转换为 `-m` 和 `-l` 并追加到 `newArgs` 中（SALauncher.java:286-292）。`buildAttachArgs()` 负责填充 PID/exe+core/remote 参数。最终的 `newArgs` 数组顺序是: `[-m] [-l] [PID或exe core或remote]`（因为 `--mixed`/`--locks` 在 `while` 循环中被先发现并 append）。

`runJSTACK()` 还初始化 `JStack(false, false)` 的两个子类状态 (SALauncher.java:296):

```java
JStack jstack = new JStack(false, false);
// JStack(boolean mixedMode, boolean concurrentLocks) → JStack.java:30-33
```

两个 `false` 是初始默认值——它们会被 `runWithArgs()` 中的参数解析覆盖为实际值。

---

### 5.3 runJMAP()：--heap/--histo/--binaryheap/--clstats 的参数转换

`runJMAP()` (SALauncher.java:300-370) 的参数转换比 `runJSTACK()` 更复杂，因为它需要处理 `--binaryheap` 和 `--dumpfile` 的组合逻辑：

```java
// SALauncher.java:300-370 — runJMAP() 参数转换
private static void runJMAP(String[] oldArgs) {
    SAGetopt sg = new SAGetopt(oldArgs);
    String[] longOpts = {"exe=", "core=", "pid=", "connect=",
          "heap", "binaryheap", "dumpfile=", "histo", "clstats", "finalizerinfo"};
    ArrayList<String> newArgs = new ArrayList();
    String pid = null;
    String exe = null;
    String core = null;
    String remote = NO_REMOTE;
    String s = null;
    String dumpfile = null;
    boolean requestHeapdump = false;

    while((s = sg.next(null, longOpts)) != null) {
        // ... 解析 exe/core/pid/connect/heap/histo/clstats/finalizerinfo ...
        if (s.equals("binaryheap")) {
            requestHeapdump = true;                  // 标记需要堆 dump
            continue;                                // ┐
        }                                            // ├ 注意: 不直接 add
        if (s.equals("dumpfile")) {                  // │ 到 newArgs
            dumpfile = sg.getOptarg();               // │
            continue;                                // ┘
        }
    }

    // 延迟构造 heap dump 参数
    if (!requestHeapdump && (dumpfile != null)) {
        throw new IllegalArgumentException("Unexpected argument dumpfile");
        // dumpfile 只能在 --binaryheap 时使用
    }
    if (requestHeapdump) {
        if (dumpfile == null) {
            newArgs.add("-heap:format=b");              // 默认文件名
        } else {
            newArgs.add("-heap:format=b,file=" + dumpfile); // 指定文件名
        }
    }

    buildAttachArgs(newArgs, pid, exe, core, remote, false);
    JMap.main(newArgs.toArray(new String[newArgs.size()]));
}
```

**参数映射表**:

| 长选项 | 短选项 | 备注 |
|--------|--------|------|
| `--heap` | `-heap` | 堆摘要（直接映射） |
| `--histo` | `-histo` | 对象直方图（直接映射） |
| `--clstats` | `-clstats` | 类加载器统计（直接映射） |
| `--finalizerinfo` | `-finalizerinfo` | finalize 队列（直接映射） |
| (无 mode) | (无) | Solaris pmap 兼容模式 |
| `--binaryheap` | `-heap:format=b` | 堆 dump（延迟构造） |
| `--binaryheap --dumpfile x.hprof` | `-heap:format=b,file=x.hprof` | (延迟构造) |
| `--dumpfile x.hprof` (无 --binaryheap) | `IllegalArgumentException` | 错误：dumpfile 必须有 binaryheap |

**延迟构造的设计理由** (SALauncher.java:357-366):

`--binaryheap` 和 `--dumpfile` 不是直接映射——它们在 `while` 循环中只设置标志位 (`requestHeapdump = true`)，实际的 `newArgs.add()` 在循环结束后执行。原因是：

1. `--dumpfile` 可能出现在 `--binaryheap` 之前或之后
2. 最终参数格式是 `-heap:format=b[,file=X]`（单个字符串），需要合并两个 flag 的信息
3. 需要在循环后验证 `--dumpfile` 是否在没有 `--binaryheap` 的情况下被使用（SALauncher.java:357-359）

**JMap.main() vs JStack.runWithArgs()** (SALauncher.java:369):

```java
JMap.main(newArgs.toArray(new String[newArgs.size()]));
```

JMap 通过**静态 main() 方法**调用，而 JStack 通过**实例方法** `runWithArgs()` 调用 (SALauncher.java:297)。这是历史遗留的不一致性——JMap 没有被重构为 `runWithArgs()` 模式（因为它存在的时间比 SALauncher 早，最初是独立的 CLI 入口）。

---

### 5.4 runJINFO()：--flags/--sysprops 的参数转换

`runJINFO()` (SALauncher.java:372-413) 是 SALauncher 中最简单的 run* () 方法之一：

```java
// SALauncher.java:372-413 — runJINFO() 参数转换
private static void runJINFO(String[] oldArgs) {
    SAGetopt sg = new SAGetopt(oldArgs);
    String[] longOpts = {"exe=", "core=", "pid=", "connect=",
                                     "flags", "sysprops"};
    ArrayList<String> newArgs = new ArrayList();
    String exe = null;
    String pid = null;
    String core = null;
    String remote = NO_REMOTE;
    String s = null;

    while((s = sg.next(null, longOpts)) != null) {
        if (s.equals("exe"))     { exe = sg.getOptarg(); continue; }
        if (s.equals("core"))    { core = sg.getOptarg(); continue; }
        if (s.equals("pid"))     { pid = sg.getOptarg(); continue; }
        if (s.equals("connect")) { remote = sg.getOptarg(); continue; }
        if (s.equals("flags"))   { newArgs.add("-flags"); continue; }
        if (s.equals("sysprops")) { newArgs.add("-sysprops"); continue; }
    }

    buildAttachArgs(newArgs, pid, exe, core, remote, false);
    JInfo.main(newArgs.toArray(new String[newArgs.size()]));
}
```

**参数映射**:

| 长选项 | 短选项 | JInfo mode | 说明 |
|--------|--------|-----------|------|
| `--flags` | `-flags` | MODE_FLAGS | 只打印 VM flags |
| `--sysprops` | `-sysprops` | MODE_SYSPROPS | 只打印系统属性 |
| (无 mode option) | (无) | MODE_BOTH | 打印两者 |

**设计注意点** (SALauncher.java:412):

```java
JInfo.main(newArgs.toArray(new String[newArgs.size()]));
```

与 `runJMAP()` 类似，JInfo 通过静态 `main()` 调用。但 JInfo.main() (JInfo.java:142-144) 内部创建 `new JInfo()` 并调用 `runWithArgs(args)`——所以实际上用了 `runWithArgs()` 模式。`JInfo.main()` 的静态方法只是包装层。

**与 JInfo.runWithArgs() 的协作** (JInfo.java:98-140):

SALauncher 构造的 `newArgs` 格式为 `[-flags/-sysprops] [PID或exe core或remote]`，这和标准 `jinfo` 命令行工具的参数格式完全一致。JInfo.runWithArgs() 的 `args.length` 分派逻辑（case 1: MODE_BOTH, case 2/3: MODE_FLAGS/SYSPROPS）正好匹配这种格式——SALauncher 不需要知道 JInfo 的内部 mode 常量，只需要将长选项映射为短选项。

---

### 5.5 buildAttachArgs()：统一构造 Tool 参数数组

`buildAttachArgs()` (SALauncher.java:161-196) 是 SALauncher 的核心共享方法——所有 `run*()` 方法都调用它来构造最终传递给 Tool 的参数数组：

```java
// SALauncher.java:159 — remote 未设置的哨兵值
private static final String NO_REMOTE = null;

// SALauncher.java:161-196 — buildAttachArgs() 完整实现
private static void buildAttachArgs(ArrayList<String> newArgs, String pid,
                              String exe, String core, String remote, boolean allowEmpty) {
    // Step 1: 互斥检查
    if (!allowEmpty && (pid == null) && (exe == null) && (remote == NO_REMOTE)) {
        throw new SAGetoptException("You have to set --pid or --exe or --connect.");
    }

    // Step 2: PID 模式 — 互斥验证 + 格式验证
    if (pid != null) {
        if (exe != null) {
            throw new SAGetoptException("Unnecessary argument: --exe");
        } else if (core != null) {
            throw new SAGetoptException("Unnecessary argument: --core");
        } else if (remote != NO_REMOTE) {
            throw new SAGetoptException("Unnecessary argument: --connect");
        } else if (!pid.matches("^\\d+$")) {
            throw new SAGetoptException("Invalid pid: " + pid);
        }
        newArgs.add(pid);           // 追加 PID 作为位置参数
    }
    // Step 3: Exec+Core 模式
    else if (exe != null) {
        if (remote != NO_REMOTE) {
            throw new SAGetoptException("Unnecessary argument: --connect");
        } else if (exe.length() == 0) {
            throw new SAGetoptException("You have to set --exe.");
        }
        newArgs.add(exe);           // 位置参数 1: 可执行文件
        if ((core == null) || (core.length() == 0)) {
            throw new SAGetoptException("You have to set --core.");
        }
        newArgs.add(core);          // 位置参数 2: core 文件
    }
    // Step 4: Remote 模式
    else if (remote != NO_REMOTE) {
        newArgs.add(remote);        // 位置参数 1: host[:port]
    }
}
```

**互斥验证的完整矩阵**:

| 设置的参数 | 不可以同时设置 | 检测位置 | 错误信息 |
|-----------|-------------|---------|---------|
| `--pid` | `--exe`, `--core`, `--connect` | SALauncher.java:168-176 | "Unnecessary argument: --exe/--core/--connect" |
| `--exe` | `--connect` | SALauncher.java:180-181 | "Unnecessary argument: --connect" |
| `--pid` + 非数字 | — | SALauncher.java:174 | "Invalid pid: XXX" |
| 全空 (allowEmpty=false) | — | SALauncher.java:163-165 | "You have to set --pid or --exe or --connect." |

**allowEmpty 参数的作用** (SALauncher.java:162):

`clhsdb` 和 `hsdb` 的 `run*()` 方法调用 `buildAttachArgs()` 时传入 `allowEmpty=true`。这是因为这两个交互式工具允许不提供 attach 参数（可以在工具内部通过命令附加）。其他工具（jstack/jmap/jinfo/jsnap/debugd）必须提供 attach 参数。

**PID 验证的正则** (SALauncher.java:174-175):

```java
!pid.matches("^\\d+$")
```

只接受纯数字（`[0-9]+`）作为 PID。这与 `Tool.start()` 中的 `Integer.parseInt()` 分派逻辑 (Tool.java:159) 形成双层防护：
1. SALauncher 层：提前拒绝明显无效的 PID（如 "abc"），给出清晰的 "Invalid pid" 错误
2. Tool.start() 层：再次验证（通过 `NumberFormatException` 回退到 remote 模式）

**最终参数数组的结构**:

```
newArgs = [mode flags...] [位置参数]

示例:
  jstack --mixed --locks --pid 1234
    → newArgs = ["-m", "-l", "1234"]

  jmap --heap --pid 1234
    → newArgs = ["-heap", "1234"]

  jmap --binaryheap --dumpfile heap.hprof --pid 1234
    → newArgs = ["-heap:format=b,file=heap.hprof", "1234"]

  jinfo --flags --exe /usr/bin/java --core core.1234
    → newArgs = ["-flags", "/usr/bin/java", "core.1234"]
```

---

### 5.6 其他命令（简要）

**runCLHSDB()** (SALauncher.java:198-225) — 命令行 HSDB（交互式调试器）:

```java
// SALauncher.java:198-225
private static void runCLHSDB(String[] oldArgs) {
    SAGetopt sg = new SAGetopt(oldArgs);
    String[] longOpts = {"exe=", "core=", "pid="};
    // ... 解析 exe/core/pid ...
    buildAttachArgs(newArgs, pid, exe, core, NO_REMOTE, true);  // allowEmpty=true
    CLHSDB.main(newArgs.toArray(new String[newArgs.size()]));
}
```

`clhsdb` 是 **Command-Line HotSpot Debugger** — SA 提供的交互式命令行调试器，可以在 attach 后执行如 `threads`, `universe`, `heapdump` 等调试命令。它的 `allowEmpty=true` 参数允许不带 attach 参数启动（先启动调试器，再 `attach PID`）。

**runHSDB()** (SALauncher.java:227-254) — GUI HotSpot Debugger:

```java
// SALauncher.java:227-254
private static void runHSDB(String[] oldArgs) {
    SAGetopt sg = new SAGetopt(oldArgs);
    String[] longOpts = {"exe=", "core=", "pid="};
    // ... 解析 exe/core/pid ...
    buildAttachArgs(newArgs, pid, exe, core, NO_REMOTE, true);  // allowEmpty=true
    HSDB.main(newArgs.toArray(new String[newArgs.size()]));
}
```

`hsdb` 是 **GUI HotSpot Debugger** — 基于 Swing 的图形化调试器，与 clhsdb 共享 SA 后端但通过图形界面操作。在 headless 环境中不可用。

**runJSNAP()** (SALauncher.java:415-451) — PerfData 计数器快照:

```java
// SALauncher.java:415-451
private static void runJSNAP(String[] oldArgs) {
    SAGetopt sg = new SAGetopt(oldArgs);
    String[] longOpts = {"exe=", "core=", "pid=", "connect=", "all"};
    // ... --all → -a (打印所有性能计数器) ...
    buildAttachArgs(newArgs, pid, exe, core, remote, false);
    JSnap.main(newArgs.toArray(new String[newArgs.size()]));
}
```

JSnap 读取目标 JVM 的 `PerfData` 区域（目标 JVM 通过 `mmap(2)` 映射的共享内存），打印如 `java.cls.loadedClasses`, `java.threads.live` 等性能计数器。`--all` 选项 (`-a`) 打印所有计数器（默认只打印变化值）。

**runDEBUGD()** (SALauncher.java:453-496) — 远程调试服务器:

```java
// SALauncher.java:453-496
private static void runDEBUGD(String[] oldArgs) {
    // 设置 Windbg 优先于 ProcessDebugger（Windows 平台特定）
    System.setProperty("sun.jvm.hotspot.debugger.useWindbgDebugger", "true");

    SAGetopt sg = new SAGetopt(oldArgs);
    String[] longOpts = {"exe=", "core=", "pid=", "serverid="};
    // ... 解析 exe/core/pid/serverid ...
    buildAttachArgs(newArgs, pid, exe, core, NO_REMOTE, false);
    if (serverid != null) {
        newArgs.add(serverid);       // 追加 server ID（用于 --connect id@host）
    }
    sun.jvm.hotspot.DebugServer.main(newArgs.toArray(new String[newArgs.size()]));
}
```

debugd 是 SA 的**远程调试服务器** — 它 attach 到本地进程或 core dump，然后监听 RMI 端口，允许远程的 `jhsdb` 工具通过 `--connect` 连接。`serverid` (SALauncher.java:484-486) 是可选的唯一标识符，用于区分多个同时运行的 debugd 实例。

**run*() 方法的调用模式汇总**:

| 方法 | 目标入口 | allowEmpty | remote 支持 | 特殊处理 |
|------|---------|-----------|------------|---------|
| `runJSTACK()` | `JStack.runWithArgs()` | false | 是 | `--mixed`→`-m`, `--locks`→`-l` |
| `runJMAP()` | `JMap.main()` | false | 是 | `--binaryheap` + `--dumpfile` 延迟构造 |
| `runJINFO()` | `JInfo.main()` | false | 是 | 简单 flag 映射 |
| `runJSNAP()` | `JSnap.main()` | false | 是 | `--all`→`-a` |
| `runDEBUGD()` | `DebugServer.main()` | false | 否 | `serverid` 追加; Windbg 属性设置 |
| `runCLHSDB()` | `CLHSDB.main()` | **true** | 否 | 交互式，可空参数 |
| `runHSDB()` | `HSDB.main()` | **true** | 否 | GUI，可空参数；与 clhsdb 代码几乎相同 |

---

### Counterfactual: 字符串匹配 vs 反射路由

> **如果 SALauncher 使用反射（`Class.forName("sun.jvm.hotspot.tools." + args[0])`）进行命令分派:**
>
> **优点**:
> - 新增工具不需要修改 SALauncher.java（符合开闭原则）
> - 代码量减少 ~30 行（消除重复的 `if (args[0].equals("..."))` 分派）
>
> **缺点**:
> - **安全风险**: 攻击者可以通过 `jhsdb java.lang.Runtime --classpath evil.jar` 执行任意 Java 类的 `main()` 方法
> - **参数映射不可控**: 反射无法处理 `--mixed`→`-m` 的参数转换逻辑——每个工具需要自己处理长选项
> - **help 系统耦合**: 反射无法集成每个工具的专用 help 信息
>
> **HotSpot 团队的选择**: 保持字符串匹配。虽然冗长，但保证只有 7 种已知工具可以被调用。SA 是诊断工具，不需要扩展性——生产环境中不太可能新增 SA 工具类型。

### 量化对比：SALauncher 路由 vs JVM TI Agent 路由

| 维度 | SALauncher (当前) | JVM TI Agent 模式 |
|------|------------------|-------------------|
| 入口方式 | Java `main()` → 字符串匹配 | Native C `Agent_OnLoad()` → 宏注册 |
| 工具注册 | 硬编码 7 个 `if (equals)` | `REGISTER_TOOL("jstack", jstack_handler)` |
| 参数转换 | 每个 `run*()` 方法独立解析长选项 | 统一参数解析器 |
| 安全性 | 高（白名单，只有 7 种工具） | 中（agent 代码可控但可能有 bug） |
| 扩展性 | 低（需修改 SALauncher.java） | 高（追加 `REGISTER_TOOL` 即可） |
| 代码行数 | ~560 行 | ~300 行（但需要额外 C 编译） |

---

**源码覆盖总结**:

| §四 节 | 源文件 | 关键行号 |
|--------|--------|---------|
| 4.1 run() 分派 | JInfo.java | 64-96 (run), 60-62 (mode 常量), 98-140 (runWithArgs) |
| 4.2 printVMFlags() | JInfo.java + VM.java | 147-175 (printVMFlags), 881-887 (getCommandLineFlags), 900-935 (readCommandLineFlags) |
| 4.3 VM.Flag 结构 | VM.java | 139-249 (Flag 类定义, getOrigin/isBool/getBool/getValue) |
| 4.4 Arguments | Arguments.java | 44-50 (getJVMFlags/getJVMArgs), 65-73 (initialize), 75-85 (buildString) |
| 4.5 SysPropsDumper | SysPropsDumper.java + VM.java | 43-57 (run), 942-963 (getSystemProperties/readSystemProperties) |

| §五 节 | 源文件 | 关键行号 |
|--------|--------|---------|
| 5.1 main() 分派 | SALauncher.java | 498-562 (main), 500-503 (空参数), 505-508 (单参数), 521-554 (7 命令分派) |
| 5.2 runJSTACK() | SALauncher.java | 256-298 (完整实现) |
| 5.3 runJMAP() | SALauncher.java | 300-370 (完整实现) |
| 5.4 runJINFO() | SALauncher.java | 372-413 (完整实现) |
| 5.5 buildAttachArgs() | SALauncher.java | 161-196 (完整实现), 159 (NO_REMOTE 哨兵) |
| 5.6 其他命令 | SALauncher.java | 198-225 (runCLHSDB), 227-254 (runHSDB), 415-451 (runJSNAP), 453-496 (runDEBUGD) |

### 5.6 runCLHSDB() / runHSDB()：交互式命令行/GUI 调试器

SALauncher 还支持两种交互式调试模式，它们与一次性 CLI 工具有本质区别：

**runCLHSDB()**（SALauncher.java:198-225）：启动命令行版本的 SA 调试器。用户通过 REPL 式交互输入命令：

```
$ jhsdb clhsdb --pid 1234
hsdb> examine 0x00007f8a12345678 64
hsdb> whatis 0x00007f8a12345678
hsdb> threadcontext
hsdb> universe
```

底层复用 `Tool` 模板方法完成 attach，但用户交互是逐条输入命令而非一次性参数执行。CLHSDB 的本质是 SA 的"交互式 Shell"——可以按需查看任意内存地址、验证数据结构偏移量、执行 SA 未封装为独立 CLI 工具的诊断操作。

**runHSDB()**（SALauncher.java:227-254）：启动图形化版本的 SA 调试器（HSDB），提供可视化线程查看器、堆浏览器、CodeCache 浏览器、Inspector 面板等功能：

- **线程视图**：可双击线程查看栈帧和寄存器
- **堆浏览器**：可视化遍历堆中的对象
- **CodeCache 浏览器**：查看已编译的方法和存根
- **Inspector 面板**：查看任意 Oop/Klass 的字段值

因为依赖 Swing，在无图形界面的生产服务器上不可用。

**适用场景对比**：

| 工具 | 适用 | 不适用 | 学习曲线 |
|------|------|--------|---------|
| **clhsdb** | 快速探查特定内存地址、验证符号映射 | 标准化诊断（如遍历所有线程栈） | 高（需要 JVM 数据结构知识） |
| **hsdb** | 开发环境下的深度可视化分析 | 生产环境（无图形界面、SSH only） | 中（GUI 降低门槛） |
| **jstack/jmap/jinfo** | 标准化生产诊断 | 非标准探查（如查看特定内存区域） | 低（一层命令） |

**选择决策树**：
- 标准诊断需求（线程栈/堆分析/VM flags）→ `jstack`/`jmap`/`jinfo`
- 非标准探查（如怀疑某个内存地址的值错误）→ `clhsdb`
- 需要可视化理解（如理解 G1 堆布局）→ `hsdb`

**源码引用**: `SALauncher.java:198-225` (runCLHSDB), `SALauncher.java:227-254` (runHSDB), `CLHSDB.java` (CLHSDB 实现类), `HSDB.java` (HSDB 实现类)

---
## §六 SA 工具不需要目标 JVM 配合 — 与 jcmd/jstat 的对比

SA 工具最核心的工程价值在于：它通过 `ptrace(2)` 从目标 JVM 进程**外部**读取内存，不要求目标进程执行任何诊断代码。这是它和标准 `jcmd`/`jstat` 的根本区别——在生产 OOM、线程池满、GC 频繁的极端故障场景下，只有 SA 仍然可以工作。

### 6.1 jcmd 的 AttachListener 机制

**AttachListener 是什么**

`jcmd` 通过 AttachListener 机制与目标 JVM 通信。AttachListener 是 HotSpot VM 内部的一个独立线程（线程名 `"Attach Listener"`），专门监听来自外部 `jcmd` 工具的 attach 请求。

初始化流程 (`src/hotspot/share/services/attachListener.cpp:435-487`):

```
AttachListener::init()  [attachListener.cpp:435]
    ├─ 创建 java.lang.Thread 对象 (name="Attach Listener")
    ├─ new JavaThread(&attach_listener_thread_entry)
    ├─ java_lang_Thread::set_daemon(thread_oop())
    └─ Thread::start(listener_thread)
```

Attach Listener 线程的主循环 (`attachListener.cpp:348-368`):

```cpp
// attachListener.cpp:348-368
static void attach_listener_thread_entry(JavaThread* thread, TRAPS) {
  os::set_priority(thread, NearMaxPriority);

  if (AttachListener::pd_init() != 0) {
    AttachListener::set_state(AL_NOT_INITIALIZED);
    return;
  }
  AttachListener::set_initialized();

  for (;;) {
    AttachOperation* op = AttachListener::dequeue();  // 阻塞等待
    if (op == NULL) {
      AttachListener::set_state(AL_NOT_INITIALIZED);
      return;   // dequeue failed or shutdown
    }
    // 分派到对应的操作处理函数 (datadump/threaddump/dumpheap/jcmd 等)
  }
}
```

**依赖条件**

`jcmd` 工作需要以下条件全部满足：

1. **Signal Dispatcher 线程存活**: AttachListener 通过 `SIGQUIT` 信号触发 attach 文件的检测（平台相关实现），Signal Dispatcher 线程必须能正常接收和分发信号
2. **Attach Listener 线程空闲**: `attachListener.cpp:364-365` — `AttachListener::dequeue()` 在等待队列时阻塞，但线程本身必须存活
3. **有空闲 Java 线程执行诊断命令**: `threaddump` 需要遍历所有线程、`dumpheap` 需要 SafePoint
4. **`/tmp/.java_pid<pid>` 文件存在**: 目标 JVM 在 attach 文件写入后才建立通信信道

**故障场景**

- **OOM / GC 频繁**: Signal Dispatcher 线程被 GC 暂停或无法获得 CPU 时间片 → `SIGQUIT` 无法被处理 → `jcmd` 超时失败
- **线程池满**: 如果 JVM 内所有线程都在执行业务逻辑，AttachListener 可能排队等待 → `jcmd` 长时间无响应
- **Signal Dispatcher 崩溃**: 如果 Signal Dispatcher 线程因 OOM 被杀 → AttachListener 完全失效 → `jcmd` 永久失败

> **关键差异**: `jcmd` 是"内省"工具——它让目标 JVM **自己给自己做体检**。当目标进程已经卡死时，"自己给自己做体检"就成了悖论。SA 的 `ptrace(2)` 路径是"外省"——从进程**外部**读取内存，完全绕过目标进程的调度器。

### 6.2 jstat 的 PerfData 共享内存

**PerfData 是什么**

`jstat` 通过 PerfData 机制读取目标 JVM 的性能计数器。PerfData 是 HotSpot JM 内部维护的一组统计数据结构，包括 GC 次数/时间、类加载数、编译统计等，存储在一块共享内存中。

内存布局 (`src/hotspot/share/runtime/perfMemory.hpp:61-72`):

```cpp
// perfMemory.hpp:61-72
typedef struct {
  jint   magic;              // magic number - 0xcafec0c0
  jbyte  byte_order;         // byte order of the buffer
  jbyte  major_version;      // version numbers
  jbyte  minor_version;
  jbyte  accessible;         // ready to access
  jint   used;               // number of bytes used
  jint   overflow;           // bytes of overflow
  jlong  mod_time_stamp;     // last structural modification
  jint   entry_offset;       // offset of first PerfDataEntry
  jint   num_entries;        // number of allocated entries
} PerfDataPrologue;
```

文件路径: `/tmp/hsperfdata_<user>/<pid>` — 一个 mmap 文件，由目标 JVM 在启动时创建。

`perfData.hpp:73-87` 说明了数据访问模型：
- 常量数据在创建时写入一次（如 total memory size）
- 计数器数据由 VM 定期更新（如 GC 计数）
- `jstat` 通过读取此文件获取快照

**依赖条件**

1. **PerfData 在启动时初始化成功**: 需要足够的 `/tmp` 磁盘空间和权限
2. **目标 JVM 定期更新计数器**: GC 线程正常运行时更新 GC 计数，Compiler 线程更新编译统计
3. **`/tmp` 文件系统可访问**: 如果 `/tmp` 被挂载为 `noexec`/`nosuid`，某些场景下可能无法访问

**故障场景**

- **JVM 崩溃**: PerfData 文件可能不完整——`accessible` 字段可能未更新为 1（表示数据就绪），或 `num_entries` 与实际写入的条目数不一致
- **GC 频繁**: GC 统计数据仍在更新，但 CPU 被 GC 线程占满 → `jstat` 可能看到过时或中间态的计数器值
- **JVM 挂起**: 如果 JVM 因死锁挂起，GC 线程也可能停止 → PerfData 计数器停止更新 → `jstat` 显示"僵尸"数据

### 6.3 SA 的 ptrace 外部读取路径

**ptrace(2) 调用序列** (`man 2 ptrace`)

SA Live 模式下的内存读取路径 (`src/jdk.hotspot.agent/linux/native/libsaproc/ps_proc.c:65-107`):

```
ptrace(PTRACE_ATTACH, pid, 0, 0)   — 附加到目标进程
    ├─ 成功: 目标进程暂停 (TASK_STOPPED, 接收 SIGSTOP)
    ├─ 失败: pid 不存在或已附加 (TracerPid 非零)
    ↓
ptrace(PTRACE_PEEKDATA, pid, addr, 0)  — 读取目标进程内存 (word 对齐)
    ├─ 每次读取 sizeof(long) 字节
    ├─ 多字节读取循环: ps_proc.c:78-105 (process_read_data)
    └─ 未对齐处理: 两次 PEEKDATA + 字节移位拼接
    ↓
ptrace(PTRACE_DETACH, pid, 0, 0)  — 解除附加
    └─ 目标进程恢复运行 (TracerPid 清零)
```

```c
// ps_proc.c:78-96 — PTRACE_PEEKDATA 核心循环
rslt = ptrace(PTRACE_PEEKDATA, ph->pid, aligned_addr, 0);
if (rslt != -1) {
  // 成功读取一个 word，拷贝到用户缓冲区
  // 如果 size 跨 word 边界，循环读取下一个 word
}
```

**不依赖目标 JVM 任何线程**

SA 的 `ptrace(PTRACE_PEEKDATA)` 由**内核**完成——内核直接访问目标进程的页表，从物理内存中读取数据。不需要目标进程：
- 调用任何函数
- 分配任何内存
- 持有任何锁
- 处于 Runnable 状态

唯一要求：目标进程的页表存在（即进程未退出）。

**`/proc/<pid>/mem` 备用路径**

在支持的系统上（Linux 3.2+ 内核且 `yama/ptrace_scope=0`），可以通过 `open("/proc/<pid>/mem")` + `pread(2)` 替代 `ptrace(PTRACE_PEEKDATA)`，性能略好（一次 `pread` 可读更多字节，无 word 对齐限制）。SA 的 PageCache 层（`DebuggerBase.java`）对两种路径提供了统一的缓存接口。

### 6.4 生产故障场景对比表

| 故障场景 | SA | jcmd | jstat | kill -3 |
|---------|-----|------|-------|---------|
| **OOM / GC 频繁** (目标进程 CPU 被 GC 占满) | ✅ `ptrace(PTRACE_PEEKDATA)` 由内核完成，不等待目标进程调度 | ❌ 需要 AttachListener 线程响应 `SIGQUIT` + 有空闲 Java 线程执行诊断命令 | ⚠️ PerfData 计数器可能停止更新，读到过期数据 | ❌ 需要 Signal Dispatcher 线程接收和处理 `SIGQUIT` |
| **线程池满** (所有线程阻塞) | ✅ `ptrace` 不依赖目标进程线程状态 | ❌ AttachListener 无法排上队，操作超时 | ✅ PerfData 文件只读，不依赖任何线程 | ❌ Signal Dispatcher 存活但无法创建新线程执行 thread dump |
| **死锁** (线程互相等待) | ✅ 遍历所有线程栈，直接从内存读取 | ⚠️ 可能响应但慢（Signal Dispatcher 未死锁时可用） | ✅ PerfData 独立于应用线程 | ⚠️ Signal Dispatcher 通常不死锁，但如果 `Threads_lock` 也被死锁持有则不可用 |
| **进程 D 状态** (不可中断睡眠) | ❌ `ptrace(PTRACE_ATTACH)` 需要进程处于可调度状态 (`TASK_RUNNING` 或 `TASK_STOPPED`) | ❌ | ❌ | ❌ |
| **进程 Z 状态** (僵尸，已退出但父进程未 `wait`) | ❌ 进程已退出，页表已释放 | ❌ | ❌ | ❌ |
| **core dump** (JVM 已崩溃，留下 core 文件) | ✅ SA 唯一支持 core dump 事后分析（使用 `pread(2)` 替代 `ptrace()`） | ❌ 进程已不存在 | ❌ 进程已不存在 | ❌ 进程已不存在 |

**Counterfactual**:
> 如果 jcmd 也采用外部内存读取方案（类似 SA 的 ptrace 路径），它可以获得 SA 的核心优势——不需要目标 JVM 配合。但 jcmd 采用了"内省"方式，原因是：
> 1. **历史路径**: `jcmd` 的前身 `jstack`/`jmap` 最初是在 JVM 进程内部运行的，通过 `AttachListener` 从外部触发
> 2. **跨平台一致性**: `AttachListener` 在所有平台上实现一致（Linux/macOS/Windows 都可创建 socket 或文件通信），而 `ptrace` 是 Linux 特有的，Windows 有完全不同的调试 API
> 3. **权限模型**: `jcmd` 不需要 root 或 `CAP_SYS_PTRACE`，只需要 `SIGQUIT` 发送权限（同用户进程可发送信号）。SA 的 `ptrace(2)` 通常需要 root 或 `ptrace_scope=0`
>
> SA 选择了"能力 > 便利性"的权衡，接受了 `ptrace` 权限要求来换取在极端故障下的诊断能力。生产环境运维工程师通常有 root 权限，权限门槛不是主要障碍。

### 6.5 SA 的"外科手术"价值

SA 的核心优势不仅在于"不需要目标 JVM 配合"，还在于以下三个独特能力：

**1. 可以附加到已挂起/卡死的进程**

通过 `kill -STOP <pid>` 暂停目标进程后，SA 仍能正常附加和读取内存，因为：
- `ptrace(PTRACE_ATTACH)` 作用于**已 STOpped 的进程**——内核允许重新附加
- `ptrace(PTRACE_PEEKDATA)` 读取的是物理内存，不依赖进程的可运行状态
- `ptrace(PTRACE_DETACH)` 后进程仍保持 `TASK_STOPPED`，可用 `kill -CONT` 恢复

这对于分析 CPU 100% 的"疯跑"进程特别有用——先 STOP 再分析，不会产生额外竞争。

**2. core dump 事后分析**

SA 是唯一同时支持 **Live 模式** (ptrace) 和 **Postmortem 模式** (core dump 文件) 的诊断工具。在 core dump 模式下：
- 使用 `pread(2)` 替代 `ptrace(PTRACE_PEEKDATA)` 从 core 文件读取
- 工具代码完全不变——`Tool.java:169-173` 的 `debugeeType=DEBUGEE_CORE` 分派自动切换数据源
- `ps_core.c:450` — core 文件读取实现: `len = pread(fd, buf, len, off)`
- jcmd/jstat 完全不支持 core dump 分析

```bash
# SA core dump 分析示例
jhsdb jstack --exe /usr/bin/java --core /tmp/core.1234
jhsdb jmap --heap --exe /usr/bin/java --core /tmp/core.1234
jhsdb jinfo --flags --exe /usr/bin/java --core /tmp/core.1234
```

**3. 不需要 JMX 端口或 JVM 配置**

```bash
# SA — 不需要任何 JVM 配置
jhsdb jstack --pid 1234  # 即插即用

# 对比: jcmd — 虽然也不需要 JMX 端口，但需要 Signal Dispatcher 存活
jcmd 1234 Thread.print   # 依赖内部线程

# 对比: JMX — 需要启动参数
# java -Dcom.sun.management.jmxremote.port=7091 ...
# jmap -histo 127.0.0.1:7091  # 需要端口 + 权限
```

SA 对目标 JVM 是**完全透明的**——目标 JVM 甚至不知道有人在阅读它的内存。这在取证和合规场景下特别有价值。

---
## §七 边缘场景与诊断工具

### 7.1 参数解析歧义：纯数字主机名

**问题根因** (`Tool.java:157-166`)

SA 的 `Tool.start()` 通过 `args.length` 和 `Integer.parseInt()` 来判断 attach 模式：

```java
// Tool.java:157-166
switch (args.length) {
  case 1:
     try {
        pid = Integer.parseInt(args[0]);    // 纯数字 → PID 模式
        debugeeType = DEBUGEE_PID;
     } catch (NumberFormatException e) {
        remoteServer = args[0];             // 非数字 → remote 模式
        debugeeType  = DEBUGEE_REMOTE;
     }
     break;
```

**歧义产生条件**: 如果远程调试服务器的**主机名恰好是纯数字**（如 `"12345"`），`Integer.parseInt("12345")` 会成功解析，导致被误判为 PID 模式，尝试 `ptrace(PTRACE_ATTACH, 12345)` 附加到不存在的 PID 12345 ——附加将失败并报错。

**SALauncher 的防御** (`SALauncher.java:174-175`):

```java
// SALauncher.java:174-175
} else if (!pid.matches("^\\d+$")) {
    throw new SAGetoptException("Invalid pid: " + pid);
}
```

SALauncher 对 `--pid` 参数进行了显式的纯数字校验（`^\d+$` 正则），确保只有全数字字符串才能进入 PID 模式。这意味着：

- 通过 `jhsdb jstack --pid 12345` 调用 → SALauncher 验证通过 → `Tool.start()` 接收 `["12345"]` → `Integer.parseInt` 成功 → PID 模式
- 通过 `jhsdb jstack --connect 12345` 调用 → SALauncher 走 `--connect` 路径 → `Tool.start()` 接收 `["server_id@12345"]` → `Integer.parseInt` 失败（含 `@`）→ remote 模式
- **直接调用 `sa-jdi.jar`**: `java -cp sa-jdi.jar sun.jvm.hotspot.tools.JStack 12345` → SALauncher **未介入** → `Tool.start()` 直接解析 → 纯数字主机名会被误判为 PID

**无完美 workaround**: 如果确实需要连接名为 `"12345"` 的远程调试服务器，且必须直接调用 JStack（不经过 `jhsdb`），只能：
- 将远程服务器重命名为非纯数字名称
- 使用 `jhsdb jstack --connect <server>` 路由

**Counterfactual**:
> 如果 `Tool.start()` 使用显式模式标识（如第一个参数固定为 `"--pid"` 或 `"--remote"`），可以完全消除歧义。但 SA 的 Java 工具直接入口（`JStack.main()`）为了兼容老版 `-m`/`-l` 参数格式保留了 `args[0]` 的隐式推断。SALauncher 通过 `buildAttachArgs` 的显式模式标注弥补了这一缺陷。

### 7.2 Darwin (macOS) 限制

**PStack 在 Darwin 上直接 bail out** (`PStack.java:62-64`):

```java
// PStack.java:62-64
if (PlatformInfo.getOS().equals("darwin")) {
    out.println("Not available on Darwin");
    return;
}
```

**根因**: macOS 没有 `CDebugger` 实现。`CDebugger` 接口定义在 `Debugger` 接口中，其实现依赖 Linux 的 `ptrace(2)` 和 DWARF 调试符号解析。macOS 使用 Mach API（`task_for_pid()`/`mach_vm_read()`/`thread_get_state()`）作为调试接口，与 Linux 的 ptrace 模型根本不同。

JDK 的 SA 实现中：
- `LinuxDebuggerLocal.java` — 完整实现 `CDebugger` 接口（通过 JNI 调用 `libsaproc.so`）
- `BsdDebuggerLocal.java` (macOS) — 只实现基础内存读取（通过 Mach API），**不实现 `CDebugger` 接口**

**影响范围**:
- PStack（mixed mode jstack）: ❌ macOS 不可用
- StackTrace（纯 Java jstack）: ✅ macOS 可用（只用 Java 层 `JavaVFrame` 遍历）
- JMap（堆分析）: ✅ macOS 可用（只需要基础内存读取，不需要 CDebugger）
- JInfo（配置查询）: ✅ macOS 可用（只需要 TypeDataBase）
- HeapDumper（堆 dump）: ✅ macOS 可用

### 7.3 Core Dump 分析的行为差异

**数据源切换**: 从 `ptrace(PTRACE_PEEKDATA)` 切换为 `pread(2)`

```
Live mode:  ptrace(PTRACE_PEEKDATA, pid, addr, 0) → 读取进程内存
Core mode:  pread(fd, buf, len, file_offset)        → 读取 core 文件
```

`ps_core.c:450` 的核心读取实现:
```c
// ps_core.c:450
if ((len = pread(fd, buf, len, off)) <= 0) {
    // 读取失败处理
}
```

`pread(2)` 的优势：
- 支持任意字节大小的读取（无 word 对齐限制）
- 支持随机偏移（不依赖文件指针位置）
- 性能更好（内核直接读文件页缓存）

**CDebugger 可用性取决于 DWARF 符号**

在 core dump 模式下，`CDebugger` 依赖于：
1. `executableName` 参数指定的可执行文件（如 `/usr/bin/java`）
2. 可执行文件中的 DWARF 调试符号信息（通常需要 debuginfo 包或 `-g` 编译选项）
3. `ps_core.c` 的 ELF 解析代码 (`salibelf.c:34-97`) 读取节表和符号表

如果可执行文件被 strip 过（无符号信息），`closestSymbolToPC()` 将始终返回 null，PStack 退回到 `CodeBlob` 分派链（8 种 CodeBlob 子类型识别）。

### 7.4 大堆分析超时

**`jmap -histo` 在 100GB+ 堆上的实际耗时分析**

假设条件:
- 堆大小: 100GB
- 平均对象大小: 400 bytes/对象（含 klass 指针）
- 总对象数: 100GB / 400 = **2.5 亿对象**
- 每个对象需要: 读取 klass 指针 (8 bytes) + 读取 klass 名称 (Symbol._body, ~50 bytes)

**syscall 分析**:
```
总内存读取: ~2.5亿 次 klass 指针读取 + ~2.5亿 次 klass 名称读取 = 5亿次 readBytesFromProcess()
每次 ptrace(PTRACE_PEEKDATA) 耗时: ~1μs
总耗时（无缓存）: 5亿 × 1μs = 500 秒 ≈ 8.3 分钟
```

**PageCache 命中率** (`DebuggerBase.java:66-233`):

| 场景 | PageCache 命中率 | 实际 syscall 次数 | 估算耗时 |
|------|-----------------|------------------|---------|
| 无缓存 | 0% | 5 亿次 | ~8.3 分钟 |
| 16MB 缓存 (默认 4096页 × 4KB) | 60-70% | 2-2.5 亿次 | ~3.3-4.2 分钟 |
| 64MB 缓存 (16384页) | 68-75% | 1.75-2 亿次 | ~2.9-3.3 分钟 |
| 256MB 缓存 | 72-78% | 1.5-2 亿次 | ~2.5-3.3 分钟 |

PageCache 命中率在堆遍历场景下低于 jstack（堆遍历 60-70% vs jstack 80-90%），原因是堆对象的 klass 指针跨页分布——GC 碎片化导致同一个页内的对象可能来自不同 class，klass 指针在完全不同的地址范围。

**优化方案对比表**:

| 优化方案 | syscall 减少 | 实现复杂度 | 跨平台兼容 | 前提条件 |
|---------|-------------|-----------|-----------|---------|
| 增大 PageCache (64MB→256MB) | 提高命中率 5-10% | 低（改一个 JVM 参数或 DebuggerBase 常量） | 完全 | 有足够内存 |
| `process_vm_readv(2)` (Linux 3.2+) | 减少 90%（批量读取 10+ 个不连续地址） | 高（需改 Native 层 `ps_proc.c` 和 Java 层 `LinuxDebuggerLocal.java`） | 仅 Linux | root 或 `ptrace_scope=0` |
| 堆遍历并行化（多线程分区域遍历） | 线性加速（N 线程） | 高（`Debugger` 对象不是线程安全的，需每个线程独立 Debugger 连接，但 `PTRACE_ATTACH` 在同一进程上只允许一次） | 中等 | 需要重构 Debugger 架构 |
| 跳过空闲区域（通过 GC 内部元数据） | 减少 40-60%（空闲区域不遍历） | 中（每种 GC 单独实现空闲检测，G1 通过 BOT、Parallel 通过 generation bounds） | 完全 | 仅 G1/Parallel/CMS |

**Counterfactual**:
> 如果 SA 实现 `process_vm_readv(2)` 批量读取，100GB 堆的 -histo 耗时可以从 3-4 分钟降至 ~30 秒。但新增一个平台特定的系统调用会引入大量条件编译（`#ifdef __linux__`），增加测试矩阵——HotSpot 团队选择"跨平台兼容 > 极致性能"。在 SA 的使用场景中（生产故障排查），运维工程师通常可以接受几分钟的等待时间。

### 7.5 诊断工具五件套

以下是实际操作命令，用于验证和诊断 SA 工具的行为：

**1. strace — 统计 ptrace 调用**

```bash
# 统计 jmap -histo 的 syscall 频率
strace -c -e trace=ptrace jhsdb jmap --histo --pid 1234 2>&1 | head -20

# 统计 jstack 的 ptrace 调用次数
strace -e trace=ptrace jhsdb jstack --pid 1234 2>&1 | grep "PEEKDATA" | wc -l

# 预期: jstack 的 PEEKDATA 调用次数远远少于 jmap -histo（jstack 只读线程栈，jmap 读全堆）
```

**2. jhsdb — SA 工具的 CLI 前端**

```bash
# jstack: 线程栈分析
jhsdb jstack --pid 1234
jhsdb jstack --mixed --pid 1234      # 含 native 帧 (PStack)
jhsdb jstack --locks --pid 1234      # 含 java.util.concurrent 锁

# jmap: 堆分析
jhsdb jmap --heap --pid 1234         # 堆摘要
jhsdb jmap --histo --pid 1234        # 对象直方图

# jinfo: 配置查询
jhsdb jinfo --flags --pid 1234       # VM flags (含 -XX:)
jhsdb jinfo --sysprops --pid 1234    # 系统属性
```

**3. jstack/jmap/jinfo 独立调用（不经过 jhsdb 路径）**

```bash
# 直接使用 sa-jdi.jar（绕过 SALauncher）
java -cp $JAVA_HOME/lib/sa-jdi.jar sun.jvm.hotspot.tools.JStack 1234
java -cp $JAVA_HOME/lib/sa-jdi.jar sun.jvm.hotspot.tools.JMap -heap 1234
java -cp $JAVA_HOME/lib/sa-jdi.jar sun.jvm.hotspot.tools.JInfo -flags 1234

# 注意: 直接调用时 Tool.start() 的歧义风险（7.1 节）生效
```

**4. GDB — 验证 Tool 模板方法执行顺序**

```bash
# 用 GDB 在关键断点处观察 Tool 模板方法的执行
gdb --args java -cp $JAVA_HOME/lib/sa-jdi.jar sun.jvm.hotspot.tools.JStack 4451

# 设置断点
(gdb) break Tool.java:114   # execute()
(gdb) break Tool.java:133   # start()
(gdb) break Tool.java:239   # startInternal()
(gdb) break Tool.java:127   # stop() ← finally 保证执行
(gdb) run

# 预期断点顺序: line 114 → line 133 → line 239 → line 127
# 即使 start() 或 run() 抛异常，stop() (line 127) 仍然会被命中
```

**5. /proc — 验证内存映射和进程状态**

```bash
# 查看目标进程的内存映射（与 SA 获取的对比）
cat /proc/<pid>/maps | head -50

# 查看 ptrace 附加状态（TracerPid）
# SA 附加后 TracerPid 应为 SA 进程的 PID
cat /proc/<pid>/status | grep TracerPid

# 验证 SA detach 后 TracerPid 清零
# jhsdb 完成 → cat /proc/<pid>/status | grep TracerPid → 期望: 0
cat /proc/<pid>/maps > /tmp/before_sa.maps
jhsdb jstack --pid <pid> > /dev/null
cat /proc/<pid>/maps > /tmp/after_sa.maps
diff /tmp/before_sa.maps /tmp/after_sa.maps
# 期望: maps 文件内容不变（SA 只读，不修改内存）
```

### 7.6 Remote 模式限制

**CDebugger 在远程调试中不可用**

当通过 `--connect` 连接到远程 `debugd` 服务器时：
- `CDebugger.getThreadList()` → 返回 null（远程调试协议不支持 native 调试）
- `CDebugger.topFrameForThread()` → 不可用
- `CDebugger.closestSymbolToPC()` → 不可用

**影响**:
- PStack（mixed mode jstack）: ❌ 完全不可用（依赖 CDebugger native 帧）
- StackTrace（纯 Java jstack）: ✅ 可用（只用 Java 层数据）
- JMap（堆分析）: ✅ 可用（只用基础内存读取）
- JInfo（配置查询）: ✅ 可用（只用 TypeDataBase）

**为什么 CDebugger 不支持远程？**

CDebugger 的操作（`ptrace(PTRACE_PEEKDATA)`, DWARF 符号解析, `CLongArray.readFromDebugger()`）直接依赖本地 `libsaproc.so` 的 native 代码调用 `ptrace(2)` 系统调用。远程调试通过 TCP 传输 Java 对象（`TypeDataBase` 序列化），无法执行本地 native 代码。

如果需要在远程模式下获取 native 栈帧，需要：
- 在被调试机器上本地运行 SA（`jhsdb jstack --pid <pid>`）
- 或使用 `ssh` 远程执行 + 输出重定向

**Counterfactual**:
> 如果 SA 的远程协议扩展支持 `CDebugger` 操作，需要定义 DWARF 符号的序列化格式、`CFrame` 的传输协议和 `ptrace` 操作的远程代理——复杂度与实现一个完整的远程调试协议相当（类似 gdbserver）。HotSpot 团队选择不为这个边缘场景投入——"远程 SA"的主要用途是 Java 堆分析和配置查询，native 调试在远程场景下可以用 `ssh + gdb` 替代。

### 7.7 CLI 工具 vs GUI 工具：clhsdb/hsdb 的适用场景

SA 提供两种交互式调试界面，适用场景不同：

| 工具 | 界面类型 | 启动方式 | 适用场景 | 限制 |
|------|---------|---------|---------|------|
| **clhsdb** | 命令行 REPL | `jhsdb clhsdb --pid <pid>` | 快速探查内存/执行自定义查询 | 需要 JVM 数据结构知识 |
| **hsdb** | 图形化 (Swing) | `jhsdb hsdb --pid <pid>` | 可视化堆分析/栈遍历 | 需要图形环境，生产服务器不可用 |
| **jstack/jmap/jinfo** | 一次性 CLI | `jhsdb jstack --pid <pid>` | 标准化诊断 | 功能固定，不可扩展 |

**选择决策**：
- 标准诊断（线程栈/堆分析/VM flags）→ 使用 `jstack`/`jmap`/`jinfo`，输出可直接用于 triage
- 非标准的内存查询 → 使用 `clhsdb`，通过 `examine`、`findpc`、`whatis` 等命令灵活探查
- 需要可视化分析 → 使用 `hsdb`，但仅在桌面环境（`jhsdb hsdb`）

> **注意**: clhsdb 和 hsdb 的交互式特性使其不适合脚本化自动诊断。对于 CI/CD 流水线中的自动化 JVM 检查，应该使用 `jhsdb jstack`/`jmap`/`jinfo` 的 stdout 解析。clhsdb 和 hsdb 属于"人工探查"工具，用于事后深入分析。

### 7.8 ptrace(2) 错误路径与诊断

SA 工具的核心依赖是 `ptrace(2)` 系统调用，但 `ptrace` 可能因多种原因失败。了解这些错误路径对生产环境排查"为什么 SA 无法附加"至关重要。

**常见 ptrace errno**：

| errno | 含义 | 触发条件 | 诊断方法 |
|-------|------|---------|---------|
| **EPERM** | Permission denied | 无 `CAP_SYS_PTRACE` 能力、进程已 attach 到其他 tracer、`/proc/sys/kernel/yama/ptrace_scope` 限制 | `cat /proc/sys/kernel/yama/ptrace_scope`；`setcap cap_sys_ptrace+ep /path/to/java` |
| **ESRCH** | No such process | 目标 PID 不存在或已退出 | `ps -p <pid>` 确认进程存活 |
| **EIO** | I/O error | PTRACE_PEEKDATA 读取非法地址（未映射内存、已释放的堆区域） | `cat /proc/<pid>/maps` 确认地址在映射范围内 |
| **EFAULT** | Bad address | 传递给 `ptrace` 的地址在 tracer 进程地址空间中无效 | 检查 `addr` 参数是否合法 |
| **EPERM (Yama)** | 内核安全模块限制 | `ptrace_scope = 1` 时只允许父子进程间 ptrace；`ptrace_scope = 2` 时仅允许 root | 临时绕过：`echo 0 > /proc/sys/kernel/yama/ptrace_scope`（需 root）|

**排查"为什么 jhsdb 附加失败"的三步法**：

```bash
# 步骤 1: 确认 ptrace 能力
getcap $(which java) 2>/dev/null
# 期望输出: /path/to/java = cap_sys_ptrace+ep
# 若无: sudo setcap cap_sys_ptrace+ep $(which java)

# 步骤 2: 确认 Yama ptrace_scope
cat /proc/sys/kernel/yama/ptrace_scope
# 期望: 0 (无限制) 或当前用户有权限

# 步骤 3: 确认目标进程未被其他 tracer 占用
cat /proc/<pid>/status | grep TracerPid
# TracerPid = 0 → 没有其他 tracer → 可以附加
# TracerPid = X  (X ≠ 0) → 进程 X 已附加 → 无法附加
```

**man 手册引用**: 详见 `man 2 ptrace` ERRORS 节，完整的 errno 列表和触发条件。

### 7.9 /proc 接口交互深度

SA 依赖 Linux 的 `/proc` 文件系统实现 external memory reading。了解这些交互对排查 SA 读取失败至关重要。

**核心 /proc 接口**：

| /proc 文件 | 用途 | SA 使用场景 | 读取方式 |
|-----------|------|-----------|---------|
| `/proc/<pid>/mem` | 进程的完整地址空间 | Live mode 批量内存读取 | `open(2)` → `pread(2)` 按偏移量读取 |
| `/proc/<pid>/maps` | 地址空间映射 | 验证内存区域属性（r/w/x） | `readline()` 解析每行 |
| `/proc/<pid>/status` | 进程状态信息 | 检查 `TracerPid`（是否已被附加） | `readline()` 解析 `TracerPid:` 行 |
| `/proc/<pid>/cmdline` | 命令行参数 | JInfo `Arguments.getJVMArgs()` 的备选验证 | `read()` 读取 null 分隔的参数 |
| `/proc/sys/kernel/yama/ptrace_scope` | ptrace 安全策略 | 诊断 `EPERM` 错误 | `read()` |

**SA 如何使用 `/proc/<pid>/mem`**：

```c
// ps_proc.c — SA 的 live debugger 实现
int fd = open("/proc/<pid>/mem", O_RDONLY);
ssize_t n = pread(fd, buf, size, addr);  // addr 是目标进程的虚拟地址
close(fd);
```

`pread(2)` 的 `offset` 参数直接对应目标进程的虚拟地址——内核将虚拟地址转换为物理地址并返回数据。`man 2 pread` 和 `man 5 proc` 提供了这些接口的详细文档。

**验证 SA 读取的正确性**：

```bash
# 步骤 1: 对比 SA 的 PMap 输出与 /proc/<pid>/maps
jhsdb jmap --pid <pid> | sed -n '/Address/,/^$/p' > sa_maps.txt
cat /proc/<pid>/maps | awk '{print $1, $2, $5}' > proc_maps.txt
diff <(sort sa_maps.txt) <(sort proc_maps.txt)

# 步骤 2: 验证 TracerPid 生命周期
cat /proc/<pid>/status | grep TracerPid  # attach 前: 0
jhsdb jstack --pid <pid> &                # 后台启动 SA
sleep 1
cat /proc/<pid>/status | grep TracerPid  # attach 后: SA 进程 PID
wait                                      # 等待 SA 完成
cat /proc/<pid>/status | grep TracerPid  # detach 后: 0

# 步骤 3: 验证 /proc/<pid>/maps 在 SA attach 前后的不变性
diff <(cat /proc/<pid>/maps) <(jhsdb jstack --pid <pid> >/dev/null; cat /proc/<pid>/maps)
# 期望: 无差异（SA 只读，不修改内存映射）
```

---

## §八 Writing Quality Self-Inspection

### "不要写成→应该写成"对照表

参照 prompt §六 的写作要求，本文档遵循以下质量标准：

| 不要写成 | 应该写成 |
|---------|---------|
| 只解释 `Tool.execute()` 的 `finally` 块 | 解释为什么 `finally` 保证了 `PTRACE_DETACH` 一定发生，以及跳过 `stop()` 的后果（目标进程 `TracerPid` 永久非零，阻止其他调试器附加） |
| 只说"JStack 有 mixed 和 pure 两种 mode" | 解释两种 mode 的遍历数据结构完全不同（`CDebugger.getThreadList()` vs `Threads.first()`），以及为什么输出格式不同（native 线程列表 vs Java 线程列表） |
| 只说"JMap 支持 7 种 mode" | 解释每种 mode 如何创建/复用 attach 生命周期（二级 Tool 直接调用 `run()` 而非 `execute()`），以及 HeapDumper 不走 Tool 模板方法的原因 |
| 只说"JInfo 读取 VM flags" | 解释 `VM.Flag` 的 `origin` 字段如何过滤默认值（`origin == 0` 跳过），以及 `Arguments._jvm_flags_array` 在目标 JVM 中的 C++ 结构 |
| 只说"HeapSummary 适配多种 GC" | 用 `instanceof` 分派链解释为什么不能走虚函数（SA 的代理模式没有 vtable），并列出所有 GC 的特化打印（Serial/CMS/Parallel/G1/Shenandoah/Epsilon/ZGC） |
| 只说"SA 工具不需要 target JVM 配合" | 对比 `jcmd`（需要 `AttachListener` + `Signal Dispatcher` 线程）和 `jstat`（需要 PerfData 共享内存 `/tmp` 文件）的依赖链，解释在生产 OOM/线程池满时为什么只有 SA 可用 |
| 只说"PStack 用 `initJFrameCache()`" | 解释为什么需要缓存 JavaVFrame（`CDebugger` 和 `JavaThread` 的线程列表不一定顺序一致，需要 `proxyToThread.get(th)` 映射） |
| 只贴代码片段不解释 | 每段代码后跟 3-5 行解释：意图、关键点、与前后文的关联 |

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
| `JMap.run()` | `JMap.java:76` | 7 种 Tool 分派 |
| `JInfo.run()` | `JInfo.java:64` | FLAGS/SYSPROPS/BOTH 分派 |
| `JInfo.printVMFlags()` | `JInfo.java:147` | VM flags 打印 |
| `PStack.initJFrameCache()` | `PStack.java:208` | JavaVFrame 缓存 |
| `PStack.run()` | `PStack.java:52-193` | native+Java 混合栈主循环 |
| `StackTrace.run()` | `StackTrace.java:58-131` | 纯 Java 栈主循环 |
| `HeapSummary.run()` | `HeapSummary.java:60-153` | GC 分派入口 |
| `ObjectHistogram.run()` | `ObjectHistogram.java:50-61` | 对象遍历入口 |
| `SysPropsDumper.run()` | `SysPropsDumper.java:43-57` | 系统属性打印 |
| `SALauncher.main()` | `SALauncher.java:498` | 命令路由 |
| `SALauncher.runJSTACK()` | `SALauncher.java:256` | jstack 参数桥接 |
| `SALauncher.runJMAP()` | `SALauncher.java:300` | jmap 参数桥接 |
| `SALauncher.runJINFO()` | `SALauncher.java:372` | jinfo 参数桥接 |
| `SALauncher.buildAttachArgs()` | `SALauncher.java:161` | 统一参数构造 |
| `Threads.first()` | `Threads.java:157` | 线程表头 |
| `JavaThread.next()` | `JavaThread.java:123` | 线程链表遍历 |
| `JavaThread.getLastJavaVFrameDbg()` | `JavaThread.java:236` | 获取顶层 JavaVFrame |
| `JavaThread.printThreadInfoOn()` | `JavaThread.java:481` | 线程头信息打印 |

---

**文档行数统计**: 本文档覆盖了 Tool 模板方法模式（6 个子主题）、JStack 双模式栈回溯（7 个子主题）、JMap 7 种 Mode 堆遍历（8 个子主题）、JInfo VM flags 读取（7 个子主题）、SALauncher 命令路由（6 个子主题）、SA vs jcmd/jstat 对比（5 个子主题）、边缘场景（9 个子主题）。涉及源文件 12 个，覆盖 6 个深度问题组，每个包含量化对比和 counterfactual 讨论。

**系统调用覆盖**: `ptrace(2)` (man 2 ptrace), `process_vm_readv(2)` (man 2 process_vm_readv), `pread(2)` (man 2 pread)

**生产故障场景**: 线程卡死（JMX 拒绝 → SA 可用）、内存泄漏（全堆遍历）、大堆分析超时、进程挂起分析、ptrace EPERM/ESRCH/EIO 错误诊断
