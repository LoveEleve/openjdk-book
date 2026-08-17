# 02. 怎么在运行时动态加载 JVMTI agent?— JDK Attach API + loadAgent

> **前置依赖**:[36-attach/01 — jcmd 怎么连接到运行中的 JVM?— AttachListener + Socket IPC](01-attach-listener.md):服务端的触发、socket、操作循环都在上一篇
> → **后续**:[37-heap-dumper/01 — jmap -dump 怎么工作?— HeapDumper + hprof 格式](openjdk/vol-02/37-heap-dumper/01-heap-dumper.md):dumpheap 操作的服务端实现是 attachListener.cpp:220-242
> 关联域: 28-jvmti(JVMTI 接口)、35-dcmd(DCmd 的 agent 加载命令)

## 工具侧: 三层封装与两条 agent 形态

01 篇把服务端拆完——触发握手、socket、10 个操作。这篇转向**工具侧**: `jcmd`/`jconsole` 背后其实是 `jdk.attach` 模块——`VirtualMachine` 这个公共 API 把握手、协议、错误处理全部封装起来,`jcmd` 只是它的一个薄壳。然后回答本篇标题的问题: **运行时动态加载 JVMTI agent**——attach 的 `load` 操作如何把 agent 库 dlopen 进运行中的 JVM 并调用 `Agent_OnAttach`。最后会看到 **Java agent 与 native agent 是两条完全不同的形态**(JAR 与 .so),以及 attach 加载与启动时 `-agentpath` 加载的关键差异。

## 1. jdk.attach 模块: attach 的 Java 封装

`jdk.attach` 模块分三层: 公共 API `com.sun.tools.attach`(VirtualMachine 抽象类/AttachProvider/异常),内部实现 `sun.tools.attach`(HotSpotVirtualMachine 基类 + 平台 VirtualMachineImpl),native 库 `libattach`(socket 读写)。入口 `VirtualMachine.attach(id)`(VirtualMachine.java:194-215)不直接连进程——**遍历所有已安装的 AttachProvider**,逐个 `attachVirtualMachine(id)`,第一个成功的返回。Linux 的 provider(`AttachProviderImpl.java`): name="sun"、type="socket";先 `checkAttachPermission`(AttachPermission 安全检查)与 `testAttachable`,再 `new VirtualMachineImpl(this, vmid)`。

`VirtualMachineImpl` 的构造(linux,01 篇握手全流程的 Java 封装): `getNamespacePid`(读 `/proc/<pid>/status` 的 NSpid,:326-355)→ `findSocketFile`(`/proc/<pid>/root/tmp/.java_pid<ns_pid>`,:270-276)→ 不存在则 `createAttachFile`(`/proc/<pid>/cwd/` 优先 fallback `/tmp`,:282-302)+ `sendQuitTo`(SIGQUIT,:120-126)+ 递增延迟轮询(`attachTimeout` 默认 10000ms,:80-97)→ `checkPermissions`(native,stat 校验属主与权限,:133-149)→ `connect` 试连。**自 attach 检查**在基类 HotSpotVirtualMachine 构造里(:56-57/:74-76):

```java
// HotSpotVirtualMachine.java:72-76(截取核心,逐字)
        // The tool should be a different VM to the target. This check will
        // eventually be enforced by the target VM.
        if (!ALLOW_ATTACH_SELF && (pid == 0 || pid == CURRENT_PID)) {
            throw new IOException("Can not attach to current VM");
        }
```

`jdk.attach.allowAttachSelf` 系统属性默认 false(:56-57)——34-nmt/02 里"自 attach 被 JDK 禁止"的实证正是这个检查;[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/36-attach-loadagent-demo.txt)里加上 `-Djdk.attach.allowAttachSelf=true` 后自 attach 成功(`attached: id=..., provider=sun/socket`)。`execute`(:145-231)实现 01 篇的 NUL 分隔协议: `writeString` 4 个字符串(协议版本 "1"、命令、3 个参数,UTF-8+NUL,:308-321),读回 `completionStatus`(int),非 0 时读错误消息(101 特判 "Protocol mismatch",`load` 命令特判 AgentLoadException)。

## 2. API → 操作名: 一张映射表

HotSpotVirtualMachine 把公共 API 映射到服务端 10 个操作名(01 篇的函数表): `loadAgentLibrary`/`loadAgentPath` → `"load"`;`loadAgent` → `"load"` + "instrument";`executeJCmd` → `"jcmd"`;`getSystemProperties`/`getAgentProperties` → `"properties"`/`"agentProperties"`;`dumpHeap` → `"dumpheap"`;`heapHisto` → `"inspectheap"`;`remoteDataDump` → `"threaddump"`;`localDataDump` → `"datadump"`;`setFlag`/`printFlag` → `"setflag"`/`printflag"`(:186-292)。`startManagementAgent` 是把 `com.sun.management.*` 属性翻译成 `ManagementAgent.start` DCmd 串(:226-238)——**attach 通道的 DCmd 入口实证**: [实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/36-attach-loadagent-demo.txt)里 `startLocalManagementAgent()` 返回了 JMX RMI 地址。

## 3. loadAgent: 全链路与两条 agent 形态

**native agent**(.so)走 `loadAgentLibrary`/`loadAgentPath`——后者传绝对路径。客户端:

```java
// HotSpotVirtualMachine.java:93-110(截取核心,逐字)
        String msgPrefix = "return code: ";
        InputStream in = execute("load",
                                 agentLibrary,
                                 isAbsolute ? "true" : "false",
                                 options);
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in))) {
            String result = reader.readLine();
            if (result == null) {
                throw new AgentLoadException("Target VM did not respond");
            } else if (result.startsWith(msgPrefix)) {
                int retCode = Integer.parseInt(result.substring(msgPrefix.length()));
                if (retCode != 0) {
                    throw new AgentInitializationException("Agent_OnAttach failed", retCode);
                }
            } else {
                throw new AgentLoadException(result);
            }
        }
```

服务端 `load_agent`(attachListener.cpp:108-135)把 arg(0)=agent、arg(1)=absParam、arg(2)=options 交给 `JvmtiExport::load_agent_library`(jvmtiExport.cpp:2638-2722),加载流程: **①静态 agent 检查**(`os::find_builtin_agent`,找进程符号表里的 `Agent_OnAttach_<库名>`);②非绝对路径先 `os::dll_locate_lib`(JVM dll 目录)再 `os::dll_build_name`(OS 默认库路径);③`os::dll_load` = **dlopen 封装**(os_linux.cpp:1872+——先检查库是否声明 noexecstack,若会改变栈可执行性则走 `VM_LinuxDllLoad` VM 操作在 safepoint 修复栈守卫页);④`os::find_agent_function`(os.cpp:574-610)按 `AGENT_ONATTACH_SYMBOLS = {"Agent_OnAttach"}`(jvm_md.h:45)做 **dlsym**;⑤`(*on_attach_entry)(&main_vm, (char*)options, NULL)` 调用 **Agent_OnAttach**;⑥`JNI_OK` 则 `Arguments::add_loaded_agent`(记入 agent 列表,退出时 `shutdown_vm_agents` 调 Agent_OnUnload);⑦**`st->print_cr("return code: %d", result)`**(:2708)——客户端读到的 "return code: N" 就是这行。`Agent_OnAttach` 返回非零 → 客户端抛 **AgentInitializationException**(含 rc)。

**Java agent**(JAR)是另一条路: `loadAgent("agent.jar", options)`(HotSpotVirtualMachine.java:135-172)把参数拼成 `"agent.jar=options"` 后 **`loadAgentLibrary("instrument", args)`**——加载的不是 agent 本身,而是 **JPLIS(instrument 库)**,由它再解析 JAR 的 `Agent-Class` 清单并调 `agentmain`;错误码按 JPLIS 约定翻译(`ATTACH_ERROR_BADJAR=100`/`NOTONCP=101`/`STARTFAIL=102`,:177-180)。所以 **`VirtualMachine.loadAgent` 的名字有误导性——它只接受 JAR**,native .so 必须走 `loadAgentLibrary`/`loadAgentPath`。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/36-attach-loadagent-demo.txt): 自定义 agent 的 `Agent_OnAttach` 收到 `options='hello-attach'`;返回 `-1` 时客户端抛 `AgentInitializationException rc=-1`;进程退出时 `Agent_OnUnload` 被调用——全链路(Java API → NUL 协议 → socket → load 操作 → dlopen → dlsym → Agent_OnAttach)逐环打通。

## 4. 与启动 agent 的对比: 同一个符号,两个时机

启动时的 `-agentpath:`/`-agentlib:` 也走 JVMTI,但是**另一条路径**: 参数记入 `Arguments::agents()`,启动后期 `Threads::create_vm_init_agents`(thread.cpp:4209-4237)遍历列表,**按 `AGENT_ONLOAD_SYMBOLS = {"Agent_OnLoad"}`(jvm_md.h:43)找符号并调用**——失败直接 `vm_exit_during_initialization`(JVM 启动失败);而 attach 路径找 **`Agent_OnAttach`**,失败只把错误码送回客户端(JVM 继续跑)。**同一个 agent 库可以同时导出两个符号**,分别对应两种时机;JVMTI 语义上 `Agent_OnAttach` 在 VM 已 fully initialized 时被调用,此时很多 JVMTI 能力已定型(比如无法再进入 onload 阶段)。另外还有第三条通道: DCmd 的 **`JVMTI.agent_load`** 命令(`JVMTIAgentLoadDCmd`,diagnosticCommand.cpp:315-353,按 .jar 后缀分流 instrument 或直接库)也调 `load_agent_library`——jcmd 工具就是这样发 agent 加载命令的。约束继承 01 篇: `EnableDynamicAgentLoading` 门控 load 操作、`DisableAttachMechanism` 全关。

## 核心悬念

36 域收官: 服务端是"文件+信号"的按需触发与 10 操作循环(01 篇),客户端是 jdk.attach 三层封装——`VirtualMachine.attach` 遍历 provider、构造里完成 NSpid/文件/信号/轮询/权限/连接(自 attach 受 `jdk.attach.allowAttachSelf` 门控),`execute` 走 NUL 分隔协议;`load` 操作把 native agent dlopen+dlsym 调 `Agent_OnAttach`("return code: N" 协议回传),Java agent 则是加载 instrument 库再解析 JAR 的 `agentmain`;启动与 attach 分别找 `Agent_OnLoad`/`Agent_OnAttach`,失败后果不同(退出 vs 报错)。[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/36-attach-loadagent-demo.txt)把整条链打了一遍。而 01 篇的操作表里有一个没展开的: **`dumpheap`**——`HeapDumper` 在 attach 通道后面等着,`jmap -dump` 的 hprof 文件就是它产的。下一篇: HeapDumper 与 hprof 格式。

> → [37-heap-dumper/01 — jmap -dump 怎么工作?— HeapDumper + hprof 格式](openjdk/vol-02/37-heap-dumper/01-heap-dumper.md)
