# Phase 18: Agent & Instrument 规划方案

## Phase 名称

**Agent & Instrument — libinstrument.so + libattach.so + libdt_socket.so + libjdwp.so + libmanagement_agent.so**

## 5 个 BUILD_LIBRARY 目标

| .gmk 文件 | NAME | .so |
|-----------|------|-----|
| `make/lib/Lib-java.instrument.gmk:40` | instrument | libinstrument.so |
| `make/lib/Lib-jdk.attach.gmk:38` | attach | libattach.so |
| `make/lib/Lib-jdk.jdwp.agent.gmk:31` | dt_socket | libdt_socket.so |
| `make/lib/Lib-jdk.jdwp.agent.gmk:54` | jdwp | libjdwp.so |
| `make/lib/Lib-jdk.management.agent.gmk:31` | management_agent | libmanagement_agent.so |

## 源码规模

| 子系统 | C/CPP | Header | Java | 总行数 |
|--------|-------|--------|------|--------|
| libinstrument.so | 4,426 | 935 | 2,437 | 7,798 |
| libattach.so | 265 | — | 771 | 1,036 |
| libdt_socket.so | 1,400 | 128 | — | 1,528 |
| libjdwp.so | 23,810 | 2,418 | — | 26,228 |
| libmanagement_agent.so | 74 | — | — | 74 |
| JVMTI 核心 (libjvm.so) | 22,163 | 4,350 | — | 26,513 |
| Agent 参数解析+CFLH | ~10,933 | — | — | ~10,933 |
| **总计** | **63,071** | **7,831** | **3,208** | **74,110** |

---

## 7 篇文档拆分方案（按执行流顺序）

### 01 — Agent 参数解析与 Agent_OnLoad 启动路径

- **覆盖 .so**: libinstrument.so
- **核心源码** (~4,700 行):
  - `src/hotspot/share/runtime/arguments.cpp` (AgentLibrary 参数解析, ~200 行)
  - `src/hotspot/share/runtime/arguments.hpp` (AgentLibrary/AgentLibraryList 数据结构, ~37 行)
  - `src/hotspot/share/runtime/thread.cpp` (create_vm_init_agents, ~72 行)
  - `src/java.instrument/share/native/libinstrument/InvocationAdapter.c` (DEF_Agent_OnLoad, 986 行)
  - `src/java.instrument/share/native/libinstrument/JPLISAgent.c` (create/initializeJPLISAgent, 1,604 行)
  - `src/java.instrument/share/native/libinstrument/JPLISAgent.h` (324 行)
  - `src/java.instrument/share/native/libinstrument/JarFacade.c` (140 行)
  - `src/java.instrument/share/native/libinstrument/Reentrancy.c` (165 行)
  - `src/java.instrument/share/classes/sun/instrument/InstrumentationImpl.java` (582 行)
  - `src/java.instrument/share/classes/java/lang/instrument/Instrumentation.java` (751 行)
- **核心符号**: `Arguments::add_instrument_agent`, `AgentLibrary`, `AgentLibraryList`, `Threads::create_vm_init_agents`, `DEF_Agent_OnLoad`, `createNewJPLISAgent`, `initializeJPLISAgent`, `eventHandlerVMInit`, `processJavaStart`
- **执行流**: `-javaagent:jar=opts` → `add_instrument_agent` → `create_vm_init_agents` → `DEF_Agent_OnLoad` → `createNewJPLISAgent` → 注册 VMInit 回调 → VMInit → `processJavaStart` → `premain()`
- **衔接**: 01 建立 agent 实例后，02 处理字节码转换

---

### 02 — ClassFileLoadHook 与字节码转换

- **覆盖 .so**: libinstrument.so + libjvm.so
- **核心源码** (~6,000 行):
  - `src/hotspot/share/classfile/klassFactory.cpp` (check_class_file_load_hook, 236 行)
  - `src/hotspot/share/prims/jvmtiExport.cpp` (post_class_file_load_hook, ~200 行)
  - `src/java.instrument/share/native/libinstrument/JPLISAgent.c` (transformClassFile/setLivePhaseEventHandlers/checkCapabilities, ~500 行)
  - `src/java.instrument/share/native/libinstrument/InvocationAdapter.c` (eventHandlerClassFileLoadHook/convertCapabilityAttributes, ~400 行)
  - `src/java.instrument/share/native/libinstrument/InstrumentationImplNativeMethods.c` (189 行)
  - `src/java.instrument/share/native/libinstrument/Reentrancy.c` (165 行)
  - `src/java.instrument/share/native/libinstrument/JavaExceptions.c` (419 行)
  - `src/java.instrument/share/native/libinstrument/Utilities.c` (110 行)
  - `src/java.instrument/share/native/libinstrument/EncodingSupport.c` (150 行)
  - `src/java.instrument/share/native/libinstrument/PathCharsValidator.c` (206 行)
  - `src/java.instrument/unix/native/libinstrument/FileSystemSupport_md.c` (181 行)
  - `src/java.instrument/share/classes/sun/instrument/TransformerManager.java` (254 行)
  - `src/java.instrument/share/classes/java/lang/instrument/ClassFileTransformer.java` (252 行)
- **核心符号**: `KlassFactory::check_class_file_load_hook`, `JvmtiExport::post_class_file_load_hook`, `eventHandlerClassFileLoadHook`, `transformClassFile`, `setLivePhaseEventHandlers`, `checkCapabilities`, `convertCapabilityAttributes`, `TransformerManager`
- **执行流**: 类加载 → `check_class_file_load_hook` → `post_class_file_load_hook` → `eventHandlerClassFileLoadHook` → `transformClassFile` → JNI 调用 `InstrumentationImpl.transform()` → Java Transformer 链 → 返回修改后字节码
- **衔接**: 01 建立了 agent，02 是 agent 的核心工作

---

### 03 — Attach API — 运行时动态加载 Agent

- **覆盖 .so**: libattach.so + libjvm.so + libmanagement_agent.so
- **核心源码** (~1,800 行):
  - `src/jdk.attach/linux/native/libattach/VirtualMachineImpl.c` (265 行)
  - `src/jdk.attach/share/classes/sun/tools/attach/HotSpotVirtualMachine.java` (395 行)
  - `src/jdk.attach/linux/classes/sun/tools/attach/VirtualMachineImpl.java` (376 行)
  - `src/hotspot/share/services/attachListener.cpp` (494 行)
  - `src/hotspot/share/services/attachListener.hpp` (195 行)
  - `src/hotspot/os/linux/attachListener_linux.cpp` (583 行)
  - `src/hotspot/share/prims/jvmtiExport.cpp` (load_agent_library, ~100 行)
  - `src/java.instrument/share/native/libinstrument/InvocationAdapter.c` (DEF_Agent_OnAttach/loadAgent, ~400 行)
  - `src/jdk.management.agent/unix/native/libmanagement_agent/FileSystemImpl.c` (74 行)
- **核心符号**: `VirtualMachineImpl.connect/sendQuitTo`, `HotSpotVirtualMachine.loadAgent`, `AttachListener::init`, `LinuxAttachListener`, `load_agent`, `JvmtiExport::load_agent_library`, `DEF_Agent_OnAttach`, `startJavaAgent`
- **执行流**: `VirtualMachine.attach(pid)` → SIGQUIT → JVM 启动 AttachListener → socket 连接 → `load agent.jar` → `load_agent_library` → `DEF_Agent_OnAttach` → `agentmain()`
- **衔接**: Attach 是 Agent 加载的第二条路径，与 01 的 OnLoad 路径对比
- **附**: libmanagement_agent.so (74 行 `isAccessUserOnly0`) 作为安全权限检查小节

---

### 04 — RedefineClasses 与 RetransformClasses — 运行时类重定义

- **覆盖 .so**: libjvm.so
- **核心源码** (~8,000 行):
  - `src/hotspot/share/prims/jvmtiRedefineClasses.cpp` (4,382 行)
  - `src/hotspot/share/prims/jvmtiRedefineClasses.hpp` (~150 行)
  - `src/hotspot/share/prims/jvmtiClassFileReconstituter.cpp` (960 行)
  - `src/hotspot/share/prims/jvmtiClassFileReconstituter.hpp` (~100 行)
  - `src/hotspot/share/prims/jvmtiEnvBase.cpp` (VM_RedefineClasses 相关, ~300 行)
  - `src/hotspot/share/prims/jvmtiManageCapabilities.cpp` (457 行)
  - `src/hotspot/share/prims/jvmtiManageCapabilities.hpp` (~80 行)
  - `src/hotspot/share/prims/jvmtiImpl.cpp` (DeferredEvent, ~200 行)
  - `src/java.instrument/share/native/libinstrument/JPLISAgent.c` (retransformableEnvironment, ~200 行)
- **核心符号**: `VM_RedefineClasses::doit_prologue/doit`, `jvmtiRedefineClasses::redefine_single_class`, `JvmtiClassFileReconstituter`, `JvmtiManageCapabilities::init_onload_capabilities`, `retransformableEnvironment`
- **执行流**: `retransformClasses()` → `VMThread::execute(VM_RedefineClasses)` → `doit_prologue()` (safepoint 外) → `SafepointSynchronize::begin()` → `doit()` (safepoint 内: lock_classes + load_new_class_versions + unlock_classes) → `SafepointSynchronize::end()`
- **衔接**: 04 是 02 (ClassFileLoadHook) 之后的第二个字节码修改机制，通过 VM_Operation 在 safepoint 内执行

---

### 05 — JVMTI 核心 — 事件系统与 300+ 函数

- **覆盖 .so**: libjvm.so
- **核心源码** (~14,000 行):
  - `src/hotspot/share/prims/jvmtiEnv.cpp` (3,733 行)
  - `src/hotspot/share/prims/jvmtiEnvBase.cpp` (1,593 行)
  - `src/hotspot/share/prims/jvmtiEnvBase.hpp` (~400 行)
  - `src/hotspot/share/prims/jvmtiExport.cpp` (2,999 行)
  - `src/hotspot/share/prims/jvmtiExport.hpp` (~500 行)
  - `src/hotspot/share/prims/jvmtiEventController.cpp` (1,086 行)
  - `src/hotspot/share/prims/jvmtiEventController.hpp` (~200 行)
  - `src/hotspot/share/prims/jvmtiImpl.cpp` (1,084 行)
  - `src/hotspot/share/prims/jvmtiImpl.hpp` (~300 行)
  - `src/hotspot/share/prims/jvmtiTagMap.cpp` (3,430 行)
  - `src/hotspot/share/prims/jvmtiTagMap.hpp` (~150 行)
  - `src/hotspot/share/prims/jvmtiThreadState.cpp` (434 行)
  - `src/hotspot/share/prims/jvmtiThreadState.hpp` (~200 行)
  - `src/hotspot/share/prims/jvmtiEnvThreadState.cpp` (318 行)
  - `src/hotspot/share/prims/jvmtiExtensions.cpp` (284 行)
  - `src/hotspot/share/prims/jvmtiGetLoadedClasses.cpp` (325 行)
  - `src/hotspot/share/prims/jvmtiCodeBlobEvents.cpp` (291 行)
  - `src/hotspot/share/prims/jvmtiRawMonitor.cpp` (429 行)
  - `src/hotspot/share/prims/jvmtiTrace.cpp` (312 行)
  - `src/hotspot/share/prims/jvmtiUtil.cpp` (46 行)
- **核心符号**: `JvmtiEnv`, `JvmtiEnvBase`, `JvmtiExport`, `JvmtiEventController`, `JvmtiEventControllerPrivate`, `JvmtiManageCapabilities`, `JvmtiThreadState`, `JvmtiEnvThreadState`, `JvmtiTagMap`, `JvmtiImpl`, `JvmtiRawMonitor`
- **执行流**: 无单一主线，是 300+ JVMTI 函数的基础设施层。文档需按功能分组：环境管理 → 事件控制 → 线程状态 → Tag 机制 → RawMonitor → 扩展 API
- **衔接**: 05 是 01-04 的底层基础设施，为所有 Agent 提供 JVMTI 函数

---

### 06 — JDWP Transport 与 Agent 初始化

- **覆盖 .so**: libdt_socket.so + libjdwp.so
- **核心源码** (~8,000 行):
  - `src/jdk.jdwp.agent/share/native/libdt_socket/socketTransport.c` (1,059 行)
  - `src/jdk.jdwp.agent/share/native/libdt_socket/socketTransport.h` (26 行)
  - `src/jdk.jdwp.agent/share/native/libdt_socket/sysSocket.h` (73 行)
  - `src/jdk.jdwp.agent/unix/native/libdt_socket/socket_md.c` (341 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/transport.c` (706 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/transport.h` (~50 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/debugInit.c` (1,413 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/debugInit.h` (~30 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/debugLoop.c` (313 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/debugDispatch.c` (116 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/inStream.c` (500 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/outStream.c` (514 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/util.c` (2,886 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/commonRef.c` (620 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/bag.c` (159 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/error_messages.c` (335 行)
  - `src/jdk.jdwp.agent/share/native/libjdwp/log_messages.c` (265 行)
  - `src/jdk.jdwp.agent/unix/native/libjdwp/exec_md.c` (126 行)
  - `src/jdk.jdwp.agent/unix/native/libjdwp/linker_md.c` (173 行)
- **核心符号**: `jdwpTransport_OnLoad`, `socketTransport_startListening/accept/writePacket/readPacket`, `transport_initialize`, `DEF_Agent_OnLoad` (debugInit.c), `debugInit_waitInitComplete`, `debugLoop_run`, `debugDispatch`, `inStream_read*`, `outStream_write*`
- **执行流**: `-agentlib:jdwp=transport=dt_socket,...` → `DEF_Agent_OnLoad` (debugInit.c) → `transport_initialize` → `dlopen("libdt_socket.so")` → `jdwpTransport_OnLoad` → `socketTransport_startListening` + `socketTransport_accept` → `debugInit_waitInitComplete` → 启动 `debugLoop_run` 线程 → while(shouldListen) { dequeue → dispatch → 写回 }
- **衔接**: 06 是 JDWP 的前半部分，初始化+主循环；07 是具体的命令和事件处理

---

### 07 — JDWP 命令处理与事件/线程控制

- **覆盖 .so**: libjdwp.so
- **核心源码** (~18,000 行):
  - **命令实现** (17 个 `*Impl.c`):
    - `VirtualMachineImpl.c` (951), `ReferenceTypeImpl.c` (648), `ClassTypeImpl.c` (358), `ArrayTypeImpl.c` (97)
    - `MethodImpl.c` (266), `FieldImpl.c` (152), `ObjectReferenceImpl.c` (498), `StringReferenceImpl.c` (73)
    - `ThreadReferenceImpl.c` (684), `ThreadGroupReferenceImpl.c` (144), `StackFrameImpl.c` (464)
    - `ClassObjectReferenceImpl.c` (82), `ClassLoaderReferenceImpl.c` (193), `ArrayReferenceImpl.c` (599)
    - `InterfaceTypeImpl.c` (63), `ModuleReferenceImpl.c` (52), `eventFilter.c` (1,361)
  - **事件系统**:
    - `eventHandler.c` (1,714), `eventHelper.c` (1,172), `EventRequestImpl.c` (352)
  - **线程控制**:
    - `threadControl.c` (2,556), `stepControl.c` (926), `invoker.c` (891)
  - **其他**:
    - `SDE.c` (740), `utf_util.c` (553), `classTrack.c` (238), `FrameID.c` (67)
- **核心符号**: `eventHandler_initialize/handleEvent`, `eventHelper_reportEvents`, `threadControl_initialize/suspendThread/resumeThread`, `stepControl_beginStep/endStep`, `invoker_doInvoke`, 各 `*Impl.c` 中的 `CommandHandler` 函数
- **执行流**: `debugDispatch` → 根据 CommandSet ID 路由 → 具体 `*Impl.c` CommandHandler → JVMTI 调用 → 写回 ReplyPacket；事件路径：JVMTI 事件回调 → `eventHandler` → `eventFilter` → `eventHelper_reportEvents` → 生成 Composite Event → 通过 Transport 发送
- **衔接**: 07 是 06 的延续，覆盖 debugLoop 内的命令处理和事件投递

---

## 文档依赖关系与推荐阅读顺序

```
01 (Agent 加载) ──→ 02 (ClassFileLoadHook) ──→ 04 (Redefine/Retransform)
  │                    │                              │
  │                    └────→ 05 (JVMTI 核心) ←───────┘
  │
  └──→ 03 (Attach API — 第二条加载路径)
        
06 (JDWP Transport + Init) ──→ 07 (JDWP 命令+事件)
```

**推荐阅读顺序**: 01 → 02 → 03 → 04 → 05 → 06 → 07

---

## libmanagement_agent.so 归属

74 行 `FileSystemImpl.c` (仅 `isAccessUserOnly0` 函数) 合并到 **03 (Attach API)** 作为安全权限检查小节，不独立成篇。

---

## 待创建目录结构

```
probe_md/18-agent-instrument/
├── README.md
├── prompts/
│   ├── prompt-01-Agent-Loading.md
│   ├── prompt-02-ClassFileLoadHook.md
│   ├── prompt-03-Attach-API.md
│   ├── prompt-04-Redefine-Classes.md
│   ├── prompt-05-JVMTI-Core.md
│   ├── prompt-06-JDWP-Transport-Init.md
│   └── prompt-07-JDWP-Command-Event.md
└── docs/
    ├── 01-Agent-Loading.md
    ├── 02-ClassFileLoadHook.md
    ├── 03-Attach-API.md
    ├── 04-Redefine-Classes.md
    ├── 05-JVMTI-Core.md
    ├── 06-JDWP-Transport-Init.md
    └── 07-JDWP-Command-Event.md
```
