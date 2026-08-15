# 02. 怎么在运行时动态加载 JVMTI agent？— JDK Attach API + loadAgent

> 🟡 Working | 1 KP 中的 JDK 侧 API
> 读者处境: `jcmd <pid> JVMTI.agent_load /path/to/agent.so` → JDK Attach API 通过 socket 发送 loadAgent 命令→JVM attach listener→load agent。

> ⚠️ 写作期修正(2026-08-15, vol-02/36-attach/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"jdk.attach 是纯 C library / JVM_AttachCurrentThread" 错(重要)**: `JVM_AttachCurrentThread` **零命中编造**;jdk.attach 模块三层=公共 API com.sun.tools.attach(VirtualMachine 抽象/AttachProvider/异常)+ 内部 sun.tools.attach(HotSpotVirtualMachine 基类 :48-406 + 平台 VirtualMachineImpl)+ native libattach(VirtualMachineImpl.c);模块路径 src/jdk.attach/share/classes 等,非 "jdk.attach/src/jdk/attach.c"
> - **"write(fd, 'COMMAND\narg1=val1\n\n')" 协议格式错**: JDK11=NUL 分隔 `<ver>0<cmd>0<arg>0<arg>0<arg>0`(01 篇已回填;客户端 writeString UTF-8+NUL,HotSpotVirtualMachine.execute :145-231/:308-321;读回 completionStatus int,101 特判 "Protocol mismatch",load 特判 AgentLoadException :203-227)
> - **"loadAgent → cmd='load'" 半对**: 分两条形态——**native .so** 走 loadAgentLibrary/loadAgentPath→execute("load", path, isAbsolute, options)(:86-129);**Java JAR** 的 `VirtualMachine.loadAgent("jar", opts)`(:135-172)拼 `"jar=opts"` 后 **loadAgentLibrary("instrument", ...)**——加载的是 JPLIS(instrument 库)再由它调 agentmain,错误码翻译 ATTACH_ERROR_BADJAR=100/NOTONCP=101/STARTFAIL=102(:177-180)
> - **"attachListener.cpp:200-400" 行号错**: load_agent 在 attachListener.cpp:**108-135**(arg0=agent/arg1=absParam/arg2=options→JvmtiExport::load_agent_library)
> - **"dlopen RTLD_LAZY" 半对**: os::dll_load(os_linux.cpp:1872+)=dlopen 封装,先检查库是否 noexecstack(可能禁栈守卫→VM_LinuxDllLoad VM 操作 safepoint 修复);dlsym 用 os::find_agent_function(os.cpp:574-610)按 AGENT_ONATTACH_SYMBOLS={"Agent_OnAttach"}(jvm_md.h:45)
> - **"Agent_OnLoad 不作为" 对**: attach 只调 Agent_OnAttach;**启动 -agentpath/-agentlib 才走 Agent_OnLoad**(create_vm_init_agents thread.cpp:4209-4237,失败 vm_exit_during_initialization;attach 失败只回错误码客户端)——同一库可同时导出两符号
> - **缺机制(重要)**: ①VirtualMachine.attach 遍历 AttachProvider.providers(VirtualMachine.java:194-215),provider name="sun"/type="socket"(AttachProviderImpl.java),checkAttachPermission/testAttachable;②**自 attach 检查**: jdk.attach.allowAttachSelf 属性默认 false,pid==CURRENT_PID 抛 "Can not attach to current VM"(HotSpotVirtualMachine.java:56-57/:72-76)——34-nmt/02 的 AttachSelf 失败根因,本篇加属性成功实证;③"return code: N" 协议(jvmtiExport.cpp:2708 st->print_cr)→ 客户端解析→非 0 抛 AgentInitializationException(:93-110);④JNI_OK→Arguments::add_loaded_agent→退出 shutdown_vm_agents 调 Agent_OnUnload(thread.cpp:4230-4256);⑤第三通道 DCmd JVMTIAgentLoadDCmd "JVMTI.agent_load"(diagnosticCommand.cpp:315-353,.jar 后缀分流)也调 load_agent_library;⑥API→操作名映射表(loadAgentLibrary/loadAgentPath→load,executeJCmd→jcmd,getSystemProperties→properties,dumpHeap→dumpheap,startManagementAgent→"ManagementAgent.start" DCmd :226-238)
> - **实证**: 36-attach-loadagent-demo.txt(自 attach+loadAgentPath 全链路: Agent_OnAttach 收到 options='hello-attach';返回 -1→AgentInitializationException rc=-1;properties/DCmd 走 attach 通道;退出 Agent_OnUnload)
> - **悬念指向 37 Heap Dumper ✓**(正确,写作顺序 36→37;dumpheap 操作 attachListener.cpp:220-242 是 37 域入口)

### 1. "JDK Attach API — VirtualMachine"

场景: JDK 代码 `VirtualMachine.attach("1234")` → jdk.attach C library→Unix socket connect→send command→read response。

**VirtualMachine (jdk.attach)** (`jdk.attach/src/jdk/attach.c:40-300`):
```c
JVM_AttachCurrentThread(env, args);
int fd = socket_connect(target_pid);     // connect to /tmp/.java_pid<PID>
write(fd, "COMMAND\narg1=val1\n\n", len); // send command
char buf[BUFSIZ];
read(fd, buf, BUFSIZ);                   // read JVM response
```
- 源码: `jdk.attach/src/jdk/attach.c:40-300`
- 关键设计: jdk.attach 是纯 C library——通过 `libattach`(动态库) link 到 JDK。Socket 连接→write command→read response(同步阻塞)。Error handling: socket_connect 失败→throw AttachNotSupportedException

### 2. "loadAgent — 动态 JVMTI agent 加载"

场景: `VirtualMachine.loadAgent("/path/to/agent.so", "options")` → socket→cmd="load\ninstrument=false\n\n"→JVM attach listener→JvmtiAgent→Agent_OnAttach。

**loadAgent flow** (`attachListener.cpp:200-400`):
```
AttachOperation: "load"
  → AttachListener::load_agent(agent_path, options)
    → JvmtiExport::load_agent_library(agent_path, options, false)
      → dlopen(agent_path, RTLD_LAZY)
      → dlsym(handle, "Agent_OnAttach")          // 找 JVMTI agent 入口
      → Agent_OnAttach(vm, options)               // 调用 agent
      → JvmtiEnv::add_capabilities(agent declares)
```
- 源码: `attachListener.cpp:200-400` + `jvmtiExport.cpp:agent_loading`
- 关键设计: loadAgent 可以在 JVM 运行时动态添加 JVMTI agent——不同于 `-agentpath:`(VM start)。`Agent_OnAttach` 在 JVM 已经 fully initialized 后被调用∈ agent 需要注意 state(某些 capabilities 在 live 阶段不可添加)
- [C++: `dlopen` with `RTLD_LAZY`→agent .so 加载→`dlsym` 找 `Agent_OnAttach` 函数指针。如果 agent 也导出 `Agent_OnLoad` → 不作为(只有 OnAttach 在 loadAgent 路径被调用)]

---

### 核心悬念

**"jdk.attach C library 通过 Unix socket→write load command→JVM attach listener→dlopen agent→Agent_OnAttach。支持运行时动态加载 JVMTI agent。"** — 下一篇: 域37 Heap Dumper。

> → 域37 Heap Dumper
