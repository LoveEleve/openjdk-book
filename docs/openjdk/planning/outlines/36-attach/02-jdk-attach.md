# 02. 怎么在运行时动态加载 JVMTI agent？— JDK Attach API + loadAgent

> 🟡 Working | 1 KP 中的 JDK 侧 API
> 读者处境: `jcmd <pid> JVMTI.agent_load /path/to/agent.so` → JDK Attach API 通过 socket 发送 loadAgent 命令→JVM attach listener→load agent。

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
