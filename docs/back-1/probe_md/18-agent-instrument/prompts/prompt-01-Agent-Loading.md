# PROMPT: 请撰写 01-Agent-Loading.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**症状**：启动 Java 应用时立即崩溃，错误消息：

```
Error occurred during initialization of VM
agent library failed to init: /path/to/agent.jar
```

或：

```
Could not find agent library premainagent on the library path, with error:
  /usr/lib/jvm/java-11/lib/libpremainagent.so: cannot open shared object file: No such file or directory
Module java.instrument may be missing from runtime image.
```

**根因分析**：`-javaagent:agent.jar=options` 参数经过 5 个阶段：
1. **参数解析** (`arguments.cpp:328`): `add_instrument_agent` 创建 `AgentLibrary(name, options, false, NULL, true)`，`is_instrument_lib=true` 标记此 agent 来自 `-javaagent`
2. **库查找** (`thread.cpp:4358`): `lookup_on_load` 三级查找——静态链接 → 绝对路径 `dlopen` → `os::dll_locate_lib` 在 `JAVA_HOME/lib/` 下查找 → `os::dll_build_name` 拼接 `lib<name>.so`
3. **符号解析** (`thread.cpp:4417`): `os::find_agent_function` 调用 `dlsym(handle, "Agent_OnLoad")`
4. **Agent 入口** (`InvocationAdapter.c:143`): `DEF_Agent_OnLoad` 解析 jar manifest → 读取 `Premain-Class` → 创建 `JPLISAgent`
5. **Premain 调用** (`JPLISAgent.c:382`): `processJavaStart` → `createInstrumentationImpl` → `setLivePhaseEventHandlers` → `startJavaAgent` → 反射调用 `premain(String, Instrumentation)`

崩溃最常见于第 2/3 步——`-agentpath` 路径错误或 JAR manifest 缺少 `Premain-Class` 属性。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认 agent jar 存在且 manifest 正确
unzip -p agent.jar META-INF/MANIFEST.MF | grep Premain-Class
# 期望输出: Premain-Class: com.example.MyAgent
# 无输出 → jar 缺失 Premain-Class → DEF_Agent_OnLoad 返回 JNI_ERR

# 2. 使用 -Xlog:agent 追踪 agent 加载
java -Xlog:agent=info -javaagent:agent.jar -version
# 输出: [agent][info] Agent_OnLoad entry at InvocationAdapter.c:143
# 输出: [agent][info] Premain-Class: com.example.MyAgent
# 无输出 → agent .so 未被找到 → 检查 -agentpath 或路径

# 3. GDB 断点验证加载链路
gdb -ex "break InvocationAdapter.c:143" \
    -ex "break JPLISAgent.c:204" \
    -ex "break JPLISAgent.c:382" \
    -ex "run" \
    -ex "print tail" \
    -ex "print premainClass" \
    --args java -javaagent:agent.jar=debug com.example.Main
```

**反事实**：如果 JVM 对 `-javaagent` 使用与 `-agentlib` 相同的纯 native agent 路径（只查找 `.so` 不解析 JAR manifest）→ Java instrumentation agent（99% 的 `-javaagent` 使用场景）无法加载 → 所有 APM 工具（New Relic, Datadog, SkyWalking）、字节码增强框架（ByteBuddy, ASM-based agents）、代码覆盖率工具（JaCoCo）全部失效。JVM 选择让 `libinstrument.so` 作为"翻译层"——Agent_OnLoad 返回后只注册 VMInit 回调，等到 Java 层就绪后才通过 `processJavaStart` 调用 premain——这个设计确保了 Java agent 可以访问完整的 Java 运行时环境（类加载器、反射、Instrumentation API）。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE execution path of `-javaagent` from JVM command-line parsing through Agent_OnLoad to premain() invocation. This is NOT a tutorial on "how to write a Java agent" — it's ENGINEERING documentation on HOW the JVM implements agent loading in source-code-specific detail.

Reader completed **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros, RegisterNatives), **03-object-model** (oop, Klass hierarchy), **01-jvm-startup** (JVM initialization flow through init_globals). This doc: **how -javaagent goes from a command-line string to executing user premain() code** — from `arguments.cpp:328` to `InstrumentationImpl.loadClassAndCallPremain()`.

### Interview Story Format Answer（必须出现在 §一 末尾）

"When you pass `-javaagent:agent.jar=options`, the JVM doesn't immediately load your agent class. Instead, `Arguments::add_instrument_agent` at arguments.cpp:328 parses the string into an `AgentLibrary` with `_is_instrument_lib=true` — a crucial flag that tells the loader to use `libinstrument.so` instead of treating the JAR as a native library. During `Threads::create_vm_init_agents()` at thread.cpp:4468, `lookup_on_load` performs a three-level search: static linkage check, absolute path dlopen, and finally library path lookup. The key insight is that `-javaagent` always loads `libinstrument.so` — the JAR filename becomes the `options` parameter to `Agent_OnLoad`. Inside `DEF_Agent_OnLoad` at InvocationAdapter.c:143, the JAR manifest is parsed via `readAttributes` to extract `Premain-Class`, and `createNewJPLISAgent` at JPLISAgent.c:204 creates the JPLISAgent structure that holds the JVMTI environment. Rather than calling premain immediately, the agent registers `eventHandlerVMInit` as a VMInit callback — deferring premain execution until the Java runtime (class loaders, reflection, system properties) is fully initialized. When VMInit fires at InvocationAdapter.c:586, the agent appends its JAR to the system classpath, then `processJavaStart` at JPLISAgent.c:382 creates the `InstrumentationImpl` Java object, switches event handlers to ClassFileLoadHook via `setLivePhaseEventHandlers`, and finally `startJavaAgent` at JPLISAgent.c:436 uses JNI reflection to invoke `premain(String, Instrumentation)`. The entire loading chain involves three address spaces: JVM C++ (arguments → thread → lookup), agent C (libinstrument.so: InvocationAdapter + JPLISAgent), and Java (InstrumentationImpl → user premain class)."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **AgentLibrary vs AgentLibraryList**: `AgentLibrary` (arguments.hpp:130) 是单个 agent 的数据结构——包含 name、options、absolute_path、os_lib handle、is_instrument_lib 标记。`AgentLibraryList` (arguments.hpp:171) 是单向链表容器——`_first` 和 `_last` 指针。`Arguments::_libraryList` 存储 `-Xrun` agent（旧式），`Arguments::_agentList` 存储 `-agentlib`/`-agentpath`/`-javaagent`（新式）。`convert_vm_init_libraries_to_agents` 负责将 `-Xrun` 库迁移到 agent 列表。

2. **JPLISAgent 结构体**: JPLISAgent (JPLISAgent.h) 是 `libinstrument.so` 的核心数据结构——`mJVM` (JavaVM*)、`mNormalEnvironment` (jvmtiEnv*)、`mRetransformEnvironment` (jvmtiEnv*，可选)、`mPremainCaller`/`mAgentmainCaller` (jmethodID 缓存)、`mJarfile` (JAR 路径)、`mAgentClassName`/`mOptionsString` (agent 类名和选项)、`mRedefineAvailable`/`mNativeMethodPrefixAvailable` 等 capability 标志。一个 JVM 进程可有多个 JPLISAgent（每个 `-javaagent` 一个），每个有独立的 JVMTI environment。

3. **JVMTI Phase 与 agent 加载时序**: JVMTI 定义了 phase 模型：`JVMTI_PHASE_ONLOAD`（Agent_OnLoad 执行期间）→ `JVMTI_PHASE_PRIMORDIAL`（VMInit 之前，agent 已加载但 Java 未就绪）→ `JVMTI_PHASE_LIVE`（VMInit 之后，Java 完全就绪）。`JvmtiExport::enter_onload_phase()` 在 `create_vm_init_agents` 开头调用，`JvmtiExport::enter_primordial_phase()` 在末尾调用。`eventHandlerVMInit` 只在 Live phase 才能调用 premain——因为在 Primordial phase 类加载器尚未初始化。

4. **OnLoadEntry_t 函数指针类型**: `typedef jint (JNICALL * OnLoadEntry_t)(JavaVM *, char *, void *)` (thread.cpp:4352)。`Agent_OnLoad` 的签名是 JVMTI 规范定义的：`jint Agent_OnLoad(JavaVM *vm, char *options, void *reserved)`。`DEF_Agent_OnLoad` 宏展开为 `Agent_OnLoad`——`DEF` 前缀是 JDK 的命名约定，表示"定义导出函数"（Definition of Exported Function）。`reserved` 参数始终为 NULL。

5. **dlopen + dlsym 三级查找**: `os::dll_load` 封装 `dlopen(3)` (man 3 dlopen)，`os::find_agent_function` 封装 `dlsym(3)` (man 3 dlsym)。三级查找策略：
   - Level 1: `os::find_builtin_agent` 检查 agent 是否静态链接到 JVM 可执行文件
   - Level 2: 如果 `agent->is_absolute_path()` 为 true，直接 `dlopen(path, RTLD_LAZY)`
   - Level 3: `os::dll_locate_lib(buffer, dll_dir, name)` 在 `JAVA_HOME/lib/` 下查找 `lib<name>.so`，失败则 `os::dll_build_name` 拼接标准 `lib<name>.so` 路径
   Source: thread.cpp:4364-4414, os_linux.cpp.

6. **Manifest 属性解析链**: `readAttributes(jarfile)` (JarFacade.c:97) 使用 `zip_open` 打开 JAR → `zip_fread` 读取 `META-INF/MANIFEST.MF` → 解析 key:value 对 → 返回 `jarAttribute*` 链表。关键属性：`Premain-Class`（premain 入口类）、`Agent-Class`（agentmain 入口类）、`Boot-Class-Path`（追加到 bootstrap classpath）、`Can-Redefine-Classes`/`Can-Retransform-Classes`/`Can-Set-Native-Method-Prefix`（capability 声明）。

7. **InstrumentationImpl 的 JNI 创建**: `createInstrumentationImpl` (JPLISAgent.c:477) 使用 JNI `NewObject` 创建 `sun.instrument.InstrumentationImpl` 实例——构造函数接收三个参数：`long nativeAgent`（JPLISAgent 指针转为 jlong，Java 层保存为 `mNativeAgent` 字段）、`boolean environmentSupportsRedefineClasses`、`boolean environmentSupportsNativeMethodPrefix`。这个 jlong 是 Java ↔ Native 的桥梁——所有 Instrumentation API 调用（addTransformer、retransformClasses 等）都通过 `mNativeAgent` 回传 native 层。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux。

Source roots:
- `src/hotspot/share/runtime/arguments.cpp` — add_instrument_agent (:328), add_init_agent (:324), add_init_library (:320)
- `src/hotspot/share/runtime/arguments.hpp` — AgentLibrary (:130), AgentLibraryList (:171)
- `src/hotspot/share/runtime/thread.cpp` — lookup_on_load (:4358), create_vm_init_agents (:4468), convert_vm_init_libraries_to_agents (:4441)
- `src/java.instrument/share/native/libinstrument/InvocationAdapter.c` — DEF_Agent_OnLoad (:143), eventHandlerVMInit (:586), parseArgumentTail (:65), convertCapabilityAttributes (:109)
- `src/java.instrument/share/native/libinstrument/JPLISAgent.c` — createNewJPLISAgent (:204), initializeJPLISAgent (:251), recordCommandLineData (:334), processJavaStart (:382), startJavaAgent (:436), createInstrumentationImpl (:477), setLivePhaseEventHandlers (:623)
- `src/java.instrument/share/native/libinstrument/JPLISAgent.h` — JPLISAgent 结构体 (:75-220), JPLISEnvironment (:56-69)
- `src/java.instrument/share/native/libinstrument/JarFacade.c` — readAttributes (:97), getAttribute (:132)
- `src/java.instrument/share/native/libinstrument/Reentrancy.c` — tryLock (:57)
- `src/java.instrument/share/classes/sun/instrument/InstrumentationImpl.java` — loadClassAndCallPremain (:521), constructor (:69)
- `src/java.instrument/share/classes/java/lang/instrument/Instrumentation.java` — 接口定义 (:71)

Build: `make jdk`

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libinstrument.so` — InvocationAdapter.c + JPLISAgent.c 编译
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — arguments.cpp + thread.cpp 编译

System calls: `dlopen` (man 3 dlopen), `dlsym` (man 3 dlsym), `mmap` (man 2 mmap, zip file mapping), `stat` (man 2 stat, jar file existence check)

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **arguments.cpp** | `src/hotspot/share/runtime/arguments.cpp` | 4380 | `add_instrument_agent`(:328), `add_init_agent`(:324), `add_init_library`(:320), `add_loaded_agent`(:333) | JVM 启动参数解析——将 -javaagent/-agentlib/-agentpath/-Xrun 转为 AgentLibrary |
| 2 | **arguments.hpp** | `src/hotspot/share/runtime/arguments.hpp` | 680 | `AgentLibrary`(:130-169), `AgentLibraryList`(:171-219) | Agent 数据结构——链表 + 字段语义 |
| 3 | **thread.cpp** | `src/hotspot/share/runtime/thread.cpp` | 5401 | `lookup_on_load`(:4358), `create_vm_init_agents`(:4468), `convert_vm_init_libraries_to_agents`(:4441), `shutdown_vm_agents`(:4494) | Agent 库查找 + 调用 Agent_OnLoad + shutdown |
| 4 | **InvocationAdapter.c** | `src/java.instrument/share/native/libinstrument/InvocationAdapter.c` | 986 | `DEF_Agent_OnLoad`(:143), `DEF_Agent_OnAttach`(:302), `eventHandlerVMInit`(:586), `parseArgumentTail`(:65), `convertCapabilityAttributes`(:109) | 🔥 Agent_OnLoad 入口 + VMInit 回调 |
| 5 | **JPLISAgent.c** | `src/java.instrument/share/native/libinstrument/JPLISAgent.c` | 1604 | `createNewJPLISAgent`(:204), `initializeJPLISAgent`(:251), `recordCommandLineData`(:334), `processJavaStart`(:382), `startJavaAgent`(:436), `createInstrumentationImpl`(:477), `setLivePhaseEventHandlers`(:623) | 🔥 JPLISAgent 生命周期——创建/初始化/启动 |
| 6 | **JPLISAgent.h** | `src/java.instrument/share/native/libinstrument/JPLISAgent.h` | 324 | `JPLISAgent` 结构体(:75), `JPLISEnvironment`(:56), `JPLISInitializationError` 枚举 | 数据结构定义 |
| 7 | **JarFacade.c** | `src/java.instrument/share/native/libinstrument/JarFacade.c` | 140 | `readAttributes`(:97), `getAttribute`(:132), `freeAttributes`(:116) | JAR manifest 解析 |
| 8 | **Reentrancy.c** | `src/java.instrument/share/native/libinstrument/Reentrancy.c` | 165 | `tryToAcquireReentrancyToken`(:105), `releaseReentrancyToken`(:147) | TLS-based 重入保护 |
| 9 | **InstrumentationImpl.java** | `src/java.instrument/share/classes/sun/instrument/InstrumentationImpl.java` | 582 | `loadClassAndCallPremain`(:521), `loadClassAndCallAgentmain`(:531), constructor(:69) | Java 层 agent 加载 + premain 调用 |
| 10 | **Instrumentation.java** | `src/java.instrument/share/classes/java/lang/instrument/Instrumentation.java` | 751 | `addTransformer`, `retransformClasses`, `redefineClasses`, etc. | Java Instrumentation API 接口 |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ AgentLibrary 数据结构与参数解析

```
问题：
  ① AgentLibrary (arguments.hpp:130-169) 的每个字段含义是什么？
      答案方向: 
        _name (char*): agent 名称——-agentlib:foo 的 "foo" 或 -javaagent:/path/to.jar 的完整路径
        _options (char*): agent 选项——等号后的字符串，由 Agent_OnLoad 的 options 参数接收
        _is_absolute_path (bool): options 是否为绝对路径（-agentpath 为 true）
        _os_lib (void*): dlopen 返回的句柄
        _os_lib_path (char*): 库文件的绝对路径（缓存）
        _valid (bool): 是否已成功 dlopen
        _is_static_lib (bool): 是否静态链接
        _is_instrument_lib (bool): 是否来自 -javaagent（需加载 libinstrument.so 而非 JAR 本身）
        _next (AgentLibrary*): 链表 next 指针
      
      追问: 为什么 AgentLibrary 需要 _is_instrument_lib 标记？
      → 在 lookup_on_load (thread.cpp:4358) 中，查找失败时错误消息不同：
        - 普通 agent: "Could not find agent library <name> on the library path"
        - instrument agent: 额外提示 "Module java.instrument may be missing from runtime image."
      → 这帮助用户区分"agent .so 找不到"和"java.instrument 模块缺失"

  ② Counterfactual: 如果 AgentLibrary 没有 _is_instrument_lib 标记——所有 agent 统一处理？
      答案方向: JVM 会尝试 dlopen("agent.jar") → 失败（JAR 不是 ELF 文件）→ 错误消息
      是 "Could not find agent library agent.jar on the library path" → 用户困惑：
      "为什么 JVM 把 JAR 当 .so 去加载？" _is_instrument_lib 标记让 JVM 知道需要加载
      libinstrument.so（而非 JAR 本身），并将 JAR 路径作为参数传给 Agent_OnLoad。
```

### 4.2 ★★★ lookup_on_load — 三级 dlopen 查找策略

```
问题：
  ① lookup_on_load (thread.cpp:4358-4423) 的三级查找逻辑是什么？
      答案方向: 
        Level 1 (static link, :4371): os::find_builtin_agent(agent, on_load_symbols, num_symbol_entries)
          → 遍历静态链接的 agent 列表（编译时嵌入 JVM 可执行文件的 agent）
          → 如果找到，library = agent->os_lib()（无需 dlopen）
        
        Level 2 (absolute path, :4373-4383): agent->is_absolute_path() 为 true
          → library = os::dll_load(name, ebuf, sizeof ebuf)  // dlopen(3) 直接打开
          → 失败 → vm_exit_during_initialization() 终止 JVM
        
        Level 3 (library path, :4384-4411): 标准库查找
          → os::dll_locate_lib(buffer, sizeof(buffer), Arguments::get_dll_dir(), name)
            在 JAVA_HOME/lib/ 下查找 lib<name>.so
          → 失败 → os::dll_build_name(buffer, sizeof(buffer), name)
            在标准库路径查找
          → 两次失败 → vm_exit_during_initialization() + 如果是 instrument lib 额外提示
        
        Level 4 (dlsym, :4417-4421): 库加载成功后
          → on_load_entry = os::find_agent_function(agent, false, on_load_symbols, num_symbol_entries)
          → dlsym(handle, "Agent_OnLoad") 或 dlsym(handle, "JVM_OnLoad")
      
      追问: 为什么需要三级查找而非单一 dlopen？
      → 安全性: 绝对路径 agent 不允许回退到库路径查找（避免 DLL 劫持）
      → 兼容性: -Xrun 旧参数可能对应静态链接的 agent（JVM 内置 profiler）
      → 灵活性: 标准库路径查找允许只指定 agent 名称（如 -agentlib:jdwp）

  ② Counterfactual: 如果只有 dlopen 一级查找——所有 agent 必须在标准库路径？
      答案方向: -agentpath:/opt/custom/libprofiler.so 将失败（绝对路径不在库搜索路径中）。
      用户必须将 agent 复制到 JAVA_HOME/lib/ → 需要 root 权限 + 污染 JVM 安装目录。
      三级查找是兼容性、安全性和易用性的平衡。
```

### 4.3 ★★★ create_vm_init_agents — Agent_OnLoad 调用循环

```
问题：
  ① create_vm_init_agents (thread.cpp:4468-4488) 的完整执行流是什么？
      答案方向:
        1. JvmtiExport::enter_onload_phase() (:4472)
           → 设置 JVMTI phase = JVMTI_PHASE_ONLOAD
           → 此时 agent 可以调用所有 JVMTI 函数（SetEventCallbacks, SetEventNotificationMode 等）
        
        2. for (agent = Arguments::agents(); agent != NULL; agent = agent->next()) (:4474)
           → 遍历 _agentList 链表
           → 按 -javaagent 命令行出现顺序依次加载
        
        3. on_load_entry = lookup_agent_on_load(agent) (:4475)
           → 内部调用 lookup_on_load(agent, AGENT_ONLOAD_SYMBOLS, ...)
           → AGENT_ONLOAD_SYMBOLS = {"Agent_OnLoad"} (或含平台特定前缀的变体)
        
        4. (*on_load_entry)(&main_vm, agent->options(), NULL) (:4479)
           → 调用 Agent_OnLoad(JavaVM*, char* options, void* reserved)
           → &main_vm 是 JVM 内部的 JavaVM_ 结构体（extern 声明）
           → agent->options() 是等号后的参数字符串
           → 返回值 jint: JNI_OK (0) 成功，非 0 失败
        
        5. JvmtiExport::enter_primordial_phase() (:4487)
           → 设置 JVMTI phase = JVMTI_PHASE_PRIMORDIAL
           → Agent 已加载但 Java 未就绪——agent 不能调用需要 Java 环境的 JVMTI 函数
      
      追问: 为什么 enter_onload_phase 和 enter_primordial_phase 包裹循环？
      → JVMTI 规范要求所有 Agent_OnLoad 在 OnLoad phase 执行，结束后统一进入 Primordial。
        这保证了：agent A 的 Agent_OnLoad 不能观察到 agent B 的 Agent_OnLoad 已返回。
        所有 agent 看到一致的 "OnLoad phase" 环境。

  ② Counterfactual: 如果每个 agent 独立管理 phase——agent A 已进入 Primordial 时 agent B 仍在 OnLoad？
      答案方向: Agent B 的 Agent_OnLoad 中调用 JVMTI 函数可能观察到 agent A 已注册的
      事件回调 → agent A 的回调在 Primordial phase 被触发 → 违反 JVMTI 规范：
      "No events shall be sent to an agent until its Agent_OnLoad function returns."
      统一 phase 管理避免了 agent 之间的时序依赖和竞态条件。
```

### 4.4 ★★★ DEF_Agent_OnLoad — JAR 解析与 Agent 初始化

```
问题：
  ① DEF_Agent_OnLoad (InvocationAdapter.c:143-286) 的完整执行流是什么？
      答案方向:
        1. createNewJPLISAgent(vm, &agent) (:149)
           → GetEnv(JVMTI_VERSION_1_1) → allocateJPLISAgent → initializeJPLISAgent
           → 注册 VMInit 回调: SetEventCallback(JVMTI_EVENT_VM_INIT, eventHandlerVMInit)
           → 缓存方法 ID: GetMethodID("loadClassAndCallPremain"), GetMethodID("loadClassAndCallAgentmain")
        
        2. parseArgumentTail(tail, &jarfile, &options) (:161)
           → 解析 "agent.jar=debug,timeout=5000" → jarfile="agent.jar", options="debug,timeout=5000"
        
        3. readAttributes(jarfile) (:175)
           → zip_open → 读取 META-INF/MANIFEST.MF → 解析为 jarAttribute* 链表
        
        4. getAttribute(attributes, "Premain-Class") (:183)
           → 必须存在 → 否则返回 JNI_ERR
        
        5. agent->mJarfile = jarfile (:194)
           → 保存 JAR 路径（用于后续 classpath 追加）
        
        6. UTF8 → Modified UTF8 转换 (:201-231)
           → modifiedUtf8LengthOfUtf8 计算转换后长度
           → 如果长度 > 0xFFFF → 返回错误（JVM class name 限制为 u2）
        
        7. getAttribute(attributes, "Boot-Class-Path") (:237-240)
           → 如果存在 → appendBootClassPath(agent, jarfile, bootClassPath)
        
        8. convertCapabilityAttributes(attributes, agent) (:245)
           → 解析 Can-Redefine-Classes/Can-Retransform-Classes 等
        
        9. recordCommandLineData(agent, premainClass, options) (:250)
           → 将类名和选项保存到 agent 结构体
      
      追问: 为什么 UTF8 → Modified UTF8 转换是必要的？
      → JAR manifest 使用标准 UTF8 编码，但 JVM 内部和 JNI 使用 Modified UTF8
        (man 3 JNI, "Modified UTF-8 Strings" section)。Modified UTF8 对 \u0000 使用
        双字节编码（0xC0 0x80），对 supplementary characters 使用代理对而非 4-byte UTF8。
        不转换会导致类名查找失败。

  ② Counterfactual: 如果 DEF_Agent_OnLoad 在此时就调用 premain 而非注册 VMInit 回调？
      答案方向: premain 方法需要 Instrumentation 实例（Java 对象）→ 需要 Java 堆存在
      → 需要类加载器可用 → 需要系统类已加载。在 Agent_OnLoad 阶段：
      - Java 堆尚未完全初始化（Universe::is_fully_initialized() == false）
      - 类加载器尚未创建（SystemDictionary 为空）
      - System Class 可能尚未加载
      → 任何 Java 代码调用（JNI FindClass, NewObject）都会失败。
      注册 VMInit 回调是一种"延迟执行"模式——等到 Java 运行时就绪后才执行 premain。
```

### 4.5 ★★★ initializeJPLISAgent — JVMTI 环境初始化

```
问题：
  ① initializeJPLISAgent (JPLISAgent.c:251-326) 做了哪些初始化？
      答案方向:
        1. agent->mJVM = vm (:260)
           → 保存 JavaVM* 指针（用于后续 JNI 调用）
        
        2. agent->mNormalEnvironment = jvmtiEnv (:261)
           → 保存主 JVMTI 环境
        
        3. SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_VM_INIT, NULL) (:285)
           → 启用 VMInit 事件
        
        4. SetEventCallback(JVMTI_EVENT_VM_INIT, eventHandlerVMInit) (:287)
           → 注册 VMInit 回调函数
        
        5. GetMethodID(InstrumentationImpl, "loadClassAndCallPremain", ...) (:299-306)
           → 缓存 premain 调用方法 ID（避免每次反射查找）
        
        6. GetMethodID(InstrumentationImpl, "loadClassAndCallAgentmain", ...) (:310-317)
           → 缓存 agentmain 调用方法 ID
        
        7. 初始化重入保护: agent->mReentrancyProvider = NULL (:321)
      
      追问: 为什么需要缓存 GetMethodID 的结果？
      → GetMethodID 涉及 JNI 查找（类名 → Class* → method table 遍历）→ ~500ns
        如果每次 premain 调用都查找，对启动性能有显著影响（多个 agent 时累积）。
        缓存 jmethodID 在 JPLISAgent 结构体中——O(1) 访问。

  ② Counterfactual: 如果不在 Agent_OnLoad 中启用 VMInit 事件而是在其他地方？
      答案方向: 只能在 OnLoad phase 调用 SetEventNotificationMode 启用事件。
      进入 Primordial phase 后，某些事件能力可能被限制。
      不在 Agent_OnLoad 中启用 → VMInit 永远不会触发 → premain 永远不会被调用
      → agent 加载成功但静默失败——用户看到 "agent loaded" 但 premain 未执行。
```

### 4.6 ★★★ processJavaStart — premain 调用链

```
问题：
  ① processJavaStart (JPLISAgent.c:382-433) 如何调用 premain？
      答案方向:
        1. initializeFallbackError(jnienv) (:393)
           → 创建 InternalError 备用对象（用于 premain 失败时的错误报告）
        
        2. createInstrumentationImpl(jnienv, agent) (:397)
           → JNI NewObject(sun.instrument.InstrumentationImpl, (jlong)agent, ...)
           → Java 层保存 native agent 指针为 mNativeAgent 字段
        
        3. setLivePhaseEventHandlers(agent) (:403)
           → 移除 VMInit handler → 注册 ClassFileLoadHook handler
           → 关键状态转换：从"等待 Java 就绪"到"活跃 transform 模式"
        
        4. startJavaAgent(agent, jnienv, classname, options, mPremainCaller) (:411)
           → commandStringIntoJavaStrings → 将类名和选项转为 Java String[]
           → invokeJavaAgentMainMethod → 调用 InstrumentationImpl.loadClassAndCallPremain
      
      追问: 为什么 setLivePhaseEventHandlers 必须在 startJavaAgent 之前调用？
      → premain 中可能调用 Instrumentation.addTransformer() 注册 ClassFileTransformer
      → 如果 ClassFileLoadHook handler 尚未注册 → 后续类加载不会触发 transform
      → 导致 premain 中注册的 transformer 对 premain 执行期间加载的类不生效
      → 先切换 handler 确保从 premain 开始的所有类加载都经过 transform 管道

  ② Counterfactual: 如果 createInstrumentationImpl 在 processJavaStart 之前调用？
      答案方向: 没有区别——processJavaStart 就是先创建再切换的顺序。
      但如果在 eventHandlerVMInit 之前创建 → Java 堆尚未就绪 → JNI NewObject 失败。
      eventHandlerVMInit 回调的触发时机保证了 Java 堆已初始化——这是 VMInit 事件的语义保证。
```

### 4.7 ★★★ InstrumentationImpl.loadClassAndCallPremain — Java 层反射调用

```
问题：
  ① loadClassAndCallPremain (InstrumentationImpl.java:521-530) 如何加载和调用 agent？
      答案方向:
        1. Class<?> clazz = Class.forName(classname) (:523)
           → 使用系统类加载器加载 agent 类
           → 如果 agent JAR 已追加到 classpath（eventHandlerVMInit 中 appendClassPath）→ 可找到
           → 如果 classpath 追加失败 → ClassNotFoundException
        
        2. Method premain = clazz.getMethod("premain", String.class, Instrumentation.class) (:524)
           → 反射查找 premain(String, Instrumentation) 方法
           → 如果 agent 类没有此方法 → NoSuchMethodException → 记录警告
        
        3. premain.invoke(null, optionsString, this) (:525)
           → 静态方法调用（第一个参数 null）
           → optionsString 是 -javaagent:jar=OPTIONS 中等号后的部分
           → this 是 InstrumentationImpl 实例（实现了 Instrumentation 接口）
      
      追问: 为什么 premain 是 static 方法？
      → JVMTI/java.lang.instrument 规范定义 premain 为 public static void。
        Static 意味着 agent 不需要实例化——不需要管理 agent 对象的生命周期。
        这简化了 agent 开发：只需一个静态入口方法，无需构造函数或单例模式。

  ② Counterfactual: 如果 premain 不是 static——需要实例化 agent 类？
      答案方向: JVM 需要调用 new MyAgent() 创建实例 → agent 必须有公共无参构造函数
      → agent 实例的生命周期管理（何时 GC？）→ 如果 agent 实例被 GC 但 JVM 仍持有
      Instrumentation 引用 → 悬空引用。Static 方法避免了所有这些问题——agent 类
      可以有自己的状态管理（静态字段），JVM 不参与 agent 对象的生命周期。
```

### 4.8 ★★★ -Xrun 兼容性转换

```
问题：
  ① convert_vm_init_libraries_to_agents (thread.cpp:4441-4463) 的转换逻辑是什么？
      答案方向:
        1. for (agent = Arguments::libraries(); ...) (:4445)
           → 遍历 _libraryList（-Xrun 旧参数列表）
        
        2. on_load_entry = lookup_jvm_on_load(agent) (:4447)
           → 查找 JVM_OnLoad 符号（旧式入口）
        
        3. if (on_load_entry == NULL) → lookup_agent_on_load(agent) (:4452)
           → 没有 JVM_OnLoad → 尝试查找 Agent_OnLoad
        
        4. if (Agent_OnLoad found) → Arguments::convert_library_to_agent(agent) (:4456)
           → 将 agent 从 _libraryList 移到 _agentList
           → 后续 create_vm_init_agents 会调用 Agent_OnLoad
        
        5. if (both NULL) → vm_exit_during_initialization (:4458)
           → 找不到任何入口 → 终止 JVM
      
      追问: 为什么需要 -Xrun 兼容性？
      → -Xrun 是 JDK 1.2-1.4 时代的 agent 加载参数（如 -Xrunhprof）。
        JDK 5 引入 -agentlib/-agentpath（JVMTI 规范）。convert 函数确保旧式 agent
        在新 JVM 上仍能加载。JVM_OnLoad 是旧式入口，Agent_OnLoad 是新式入口。

  ② Counterfactual: 如果移除 -Xrun 支持——旧 profiling agent 怎么办？
      答案方向: 所有使用 -Xrunhprof 的旧脚本和工具链全部失效。
      -Xrun 兼容层是向后兼容性的代价——仅 30 行代码（thread.cpp:4441-4463），
      但支持了 20 年的工具生态。Oracle 直到 JDK 9 才正式废弃 hprof agent。
```

---

## §五 Article Structure

```
§〇 生产场景 — "agent library failed to init" 错误诊断
  ★ 真实错误消息: "Could not find agent library premainagent on the library path"
  ★ Root cause: -javaagent 路径错误 / manifest 缺少 Premain-Class
  ★ 三步诊断: unzip manifest → Xlog:agent → GDB 断点验证
  ★ 反事实: 如果 -javaagent 使用纯 native agent 路径 → 所有 Java agent 工具失效

§一 ★★★ -javaagent 全链路源码走读
  ❓ 这不是 agent 开发教程——这是 JVM 如何从命令行字符串执行 premain()
  1.1 arguments.cpp:328 add_instrument_agent → AgentLibrary(is_instrument_lib=true)
  1.2 arguments.hpp:130 AgentLibrary 字段语义
  1.3 thread.cpp:4468 create_vm_init_agents → enter_onload_phase → 遍历 agent 链表
  1.4 thread.cpp:4358 lookup_on_load → 三级 dlopen 查找
  1.5 InvocationAdapter.c:143 DEF_Agent_OnLoad → JAR 解析 → manifest 读取
  1.6 JPLISAgent.c:204 createNewJPLISAgent → 注册 VMInit 回调
  1.7 JPLISAgent.c:251 initializeJPLISAgent → 缓存方法 ID + 启用 VMInit 事件
  1.8 InvocationAdapter.c:586 eventHandlerVMInit → appendClassPath → processJavaStart
  1.9 JPLISAgent.c:382 processJavaStart → createInstrumentationImpl → setLivePhaseEventHandlers → startJavaAgent
  1.10 ★ Mermaid: -javaagent 加载时序图 — 5 lanes: Command Line / JVM C++ / libinstrument C / JVMTI / Java
       Flow: -javaagent:jar=opts → add_instrument_agent → dlopen(libinstrument.so) → dlsym(Agent_OnLoad)
       → DEF_Agent_OnLoad → readAttributes → createNewJPLISAgent → SetEventCallback(VMInit)
       → VMInit → eventHandlerVMInit → processJavaStart → createInstrumentationImpl
       → setLivePhaseEventHandlers → startJavaAgent → premain(String, Instrumentation)
  1.11 ★ 面试 Story Format 答案 — 从 arguments.cpp:328 到 premain.invoke() 的完整叙事

§二 ★★★ 7 Beginner Callout 框
  2.1 AgentLibrary vs AgentLibraryList
  2.2 JPLISAgent 结构体
  2.3 JVMTI Phase 与 agent 加载时序
  2.4 OnLoadEntry_t 函数指针类型
  2.5 dlopen + dlsym 三级查找
  2.6 Manifest 属性解析链
  2.7 InstrumentationImpl 的 JNI 创建

§三 ★★ Agent 加载性能剖析
  ❓ -javaagent 对启动时间的影响
  ❓ 多个 agent 的加载顺序
  3.1 单 agent 加载开销: dlopen ~1ms + manifest 解析 ~0.5ms + premain 调用 ~5ms (典型)
  3.2 多个 agent: 串行加载——按命令行出现顺序，无并行化
  3.3 premain 中的类加载: 可能触发大量类加载 + ClassFileLoadHook 链 → 额外 ~50ms/transformer

§四 ★ GDB 断点验证 — 7 断点完整 agent 加载 trace
  断言 1: arguments.cpp:328 add_instrument_agent → verify AgentLibrary created
  断言 2: thread.cpp:4479 (*on_load_entry)(&main_vm, ...) → verify Agent_OnLoad called
  断言 3: InvocationAdapter.c:143 DEF_Agent_OnLoad entry → verify tail = "agent.jar=options"
  断言 4: JPLISAgent.c:204 createNewJPLISAgent → verify agent->mJVM set
  断言 5: JPLISAgent.c:285 SetEventNotificationMode(VM_INIT) → verify VMInit enabled
  断言 6: InvocationAdapter.c:586 eventHandlerVMInit → verify appendClassPath called
  断言 7: JPLISAgent.c:382 processJavaStart → verify InstrumentationImpl created

§五 ★ Cross-Reference
  ❓ 01-jvm-startup — JVM 初始化流程, create_vm_init_agents 的调用时机
  ❓ 09-native-interface — JNI_ENTRY/JVM_ENTRY 宏, RegisterNatives
  ❓ 03-object-model — oop, Klass, InstanceKlass 层次结构
  ❓ 02-ClassFileLoadHook (本文后续) — agent 加载后如何 transform 字节码
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because JVMTI requires all Agent_OnLoad calls to see the same phase, JvmtiExport::enter_onload_phase() is called BEFORE the agent loop..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from arguments.cpp / thread.cpp / InvocationAdapter.c / JPLISAgent.c, do not describe it.

3. **Mermaid** — -javaagent 加载时序图。5 lanes: Command Line / JVM C++ / libinstrument C / JVMTI / Java。完整流程: `-javaagent:jar=opts` → `add_instrument_agent` → `dlopen(libinstrument.so)` → `dlsym(Agent_OnLoad)` → `DEF_Agent_OnLoad` → `readAttributes` → `createNewJPLISAgent` → `SetEventCallback(VMInit)` → `VMInit` → `eventHandlerVMInit` → `processJavaStart` → `createInstrumentationImpl` → `setLivePhaseEventHandlers` → `startJavaAgent` → `premain(String, Instrumentation)`。Annotate every step with file:line.

4. **GDB session** — 7 breakpoints with exact file:line numbers:
   - `arguments.cpp:328` add_instrument_agent — verify AgentLibrary(is_instrument_lib=true) added to _agentList
   - `thread.cpp:4479` (*on_load_entry)(&main_vm, ...) — verify Agent_OnLoad function pointer
   - `InvocationAdapter.c:143` DEF_Agent_OnLoad entry — verify tail string
   - `JPLISAgent.c:204` createNewJPLISAgent — verify agent->mJVM assigned
   - `JPLISAgent.c:285` SetEventNotificationMode(VM_INIT) — verify event enabled
   - `InvocationAdapter.c:586` eventHandlerVMInit — verify jarfile added to classpath
   - `JPLISAgent.c:382` processJavaStart — verify InstrumentationImpl created + premain called
   Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一: AgentLibrary vs AgentLibraryList, JPLISAgent 结构体, JVMTI Phase, OnLoadEntry_t, dlopen/dlsym 三级查找, Manifest 属性解析链, InstrumentationImpl JNI 创建.

6. **Cross-reference at three points**:
   - At `create_vm_init_agents` → "→ 01-jvm-startup for JVM initialization flow and when this is called"
   - At `JNI NewObject` in `createInstrumentationImpl` → "→ 09-native-interface for JNI object creation mechanics"
   - At `eventHandlerVMInit` → "→ 02-ClassFileLoadHook for what happens after setLivePhaseEventHandlers"

7. **Story-format interview answer** — at §一末尾: 从 `java -javaagent:agent.jar=debug` 到 `premain("debug", instrumentation)` 的叙事。Three parts: "Command line to AgentLibrary" + "dlopen/dlsym to Agent_OnLoad" + "VMInit callback to premain invocation".

8. **"不要写成→应该写成" 对照表** (必须在 §六 中出现):
   | 不要写成 | 应该写成 |
   |---------|---------|
   | "Agent_OnLoad is called when the agent loads" | "thread.cpp:4479 `(*on_load_entry)(&main_vm, agent->options(), NULL)` invokes the function pointer obtained by dlsym at :4418" |
   | "JPLISAgent stores agent state" | "JPLISAgent (JPLISAgent.h:75) is a 200+ byte struct holding mJVM (JavaVM*), mNormalEnvironment (jvmtiEnv*), mPremainCaller (jmethodID), mAgentClassName (char*), and 8+ capability flags" |
   | "Manifest is parsed to find Premain-Class" | "readAttributes (JarFacade.c:97) opens the JAR via zip_open → reads META-INF/MANIFEST.MF → parses key:value pairs → getAttribute at :132 extracts 'Premain-Class'" |
   | "VMInit event triggers premain" | "eventHandlerVMInit (InvocationAdapter.c:586) receives the JVMTI callback → appends jar to classpath → calls processJavaStart which creates InstrumentationImpl via JNI NewObject (JPLISAgent.c:477) → setLivePhaseEventHandlers switches to CFLH mode → startJavaAgent invokes premain via reflection" |
   | "loadClassAndCallPremain loads the agent class" | "loadClassAndCallPremain (InstrumentationImpl.java:521) calls Class.forName(classname) → getMethod('premain', String.class, Instrumentation.class) → premain.invoke(null, optionsString, this) — three Java reflection calls" |

---

## §七 Output Format

- Markdown file, named `01-Agent-Loading.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/18-agent-instrument/docs/`
- 元信息头:

```
> **阶段**：[18-agent-instrument]
> **前置**：[01-jvm-startup]（JVM 初始化流程）、[09-native-interface]（JNI_ENTRY/JVM_ENTRY 宏机制）、[03-object-model]（oop, Klass 层次结构）
> **配套**：[02-ClassFileLoadHook]（agent 加载后的字节码转换）、[03-Attach-API]（运行时动态加载）、[05-JVMTI-Core]（JVMTI 核心基础设施）
> **后续依赖本文**：[02-ClassFileLoadHook]（transformClassFile 依赖本文创建的 JPLISAgent）、[04-Redefine-Classes]（retransformClasses 依赖本文的 capability 设置）
> **阅读收益**：追踪 -javaagent 从命令行参数到 premain() 执行的完整 8 步加载链——理解 AgentLibrary 数据结构的字段语义与 _is_instrument_lib 标记的作用、lookup_on_load 三级 dlopen/dlsym 查找策略、DEF_Agent_OnLoad 中 JAR manifest 解析与 JPLISAgent 初始化、JVMTI phase 模型如何保证 agent 加载时序正确性、eventHandlerVMInit 延迟回调如何确保 Java 运行时就绪后才执行 premain；掌握 "agent library failed to init" 错误的 5 步诊断路径
```

- 目标行数: 400+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "-javaagent loads an agent" 而不展示 JVM 内部的 AgentLibrary 数据结构和 dlopen 查找逻辑 — 必须从 arguments.cpp:328 到 thread.cpp:4479 完整源码
- ❌ 不解释 AgentLibrary 的字段语义 — 必须展示每个字段的用途，特别是 _is_instrument_lib 标记
- ❌ 不解释 dlopen/dlsym 三级查找 — 必须展示 static link → absolute path → library path 三个分支
- ❌ 忽略 JVMTI phase 模型 — 必须展示 OnLoad → Primordial → Live 的 phase 转换
- ❌ 不解释 DEF_Agent_OnLoad 为什么注册 VMInit 回调而非直接调用 premain — 必须展示 Java 堆尚未就绪的约束
- ❌ 不展示 JPLISAgent 结构体 — 必须展示 mJVM, mNormalEnvironment, mPremainCaller 等关键字段
- ❌ 不解释 convertCapabilityAttributes — 必须展示 Can-Redefine-Classes 等 manifest 属性如何转为 JVMTI capability
- ❌ 不做 GDB 断点 trace — 至少 7 个断点覆盖参数解析 → dlopen → Agent_OnLoad → VMInit → premain
- ❌ 忽略 -Xrun 兼容性转换 — 必须展示 convert_vm_init_libraries_to_agents 的兼容逻辑
- ❌ 不要写成 Java agent 开发教程
- ❌ 不要解释 C 语言基础或 JNI 基础

---

## §九 Required（≥8）

- ✅ **★ Mermaid 时序图** — 5 lanes: Command Line / JVM C++ / libinstrument C / JVMTI / Java — 完整 agent 加载流程
- ✅ **★ AgentLibrary 字段表** — arguments.hpp:130-169 每个字段的语义和用途
- ✅ **★ lookup_on_load 源码展示** — thread.cpp:4358-4423 完整三级查找逻辑
- ✅ **★ DEF_Agent_OnLoad 完整源码** — InvocationAdapter.c:143-286 从 JAR 解析到 recordCommandLineData
- ✅ **★ initializeJPLISAgent 源码** — JPLISAgent.c:251-326 完整初始化序列
- ✅ **★ processJavaStart 源码** — JPLISAgent.c:382-433 从 InstrumentationImpl 创建到 startJavaAgent
- ✅ **★ 7 Beginner Callout 框** — exact text from §一
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：命令行 → AgentLibrary → dlopen → Agent_OnLoad → JAR 解析 → VMInit 延迟 → premain
- ✅ **★ GDB 断点 ≥7 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ "不要写成→应该写成" 对照表** — §六 中 ≥5 行
- ✅ **★ 交叉引用** — 01-jvm-startup, 09-native-interface, 03-object-model, 02-ClassFileLoadHook
- ✅ **★ JVMTI Phase 转换图** — OnLoad → Primordial → Live 的完整时序

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: add_instrument_agent (arguments.cpp:328)
  (gdb) break arguments.cpp:328
  (gdb) print name → 期望: "/path/to/agent.jar" (完整 JAR 路径)
  (gdb) print options → 期望: "debug,timeout=5000" (等号后的选项)
  (gdb) print absolute_path → 期望: false (-javaagent 不是 absolute_path)
  (gdb) continue 经过 AgentLibrary 构造
  (gdb) print _agentList.first()->_is_instrument_lib → 期望: true

断言 2: lookup_on_load (thread.cpp:4358)
  (gdb) break thread.cpp:4371 (static link check)
  (gdb) break thread.cpp:4373 (absolute path dlopen)
  (gdb) break thread.cpp:4386 (library path locate)
  运行: java -javaagent:agent.jar -version
  (gdb) print agent->name() → 期望: "instrument" (-javaagent 始终加载 libinstrument.so)
  (gdb) print agent->is_instrument_lib() → 期望: true
  (gdb) continue → 应进入 library path 分支 (Level 3)
  (gdb) print library → 期望: 非 NULL (dlopen 成功)

断言 3: DEF_Agent_OnLoad entry (InvocationAdapter.c:143)
  (gdb) break InvocationAdapter.c:143
  (gdb) print tail → 期望: "agent.jar=debug,timeout=5000" (agent->options())
  (gdb) print reserved → 期望: NULL

断言 4: readAttributes 返回 (InvocationAdapter.c:175)
  (gdb) break InvocationAdapter.c:176
  (gdb) print attributes → 期望: 非 NULL jarAttribute* 链表
  (gdb) print jarfile → 期望: "agent.jar" (parseArgumentTail 解析结果)

断言 5: Premain-Class 提取 (InvocationAdapter.c:183)
  (gdb) break InvocationAdapter.c:184
  (gdb) print premainClass → 期望: "com.example.MyAgent" (manifest 中的 Premain-Class)
  (gdb) continue 经过 convertCapabilityAttributes
  (gdb) print agent->mRedefineAvailable → 期望: 1 (如果 Can-Redefine-Classes: true)
  (gdb) print agent->mNativeMethodPrefixAvailable → 期望: 1 (如果 Can-Set-Native-Method-Prefix: true)

断言 6: initializeJPLISAgent VMInit 注册 (JPLISAgent.c:285-287)
  (gdb) break JPLISAgent.c:285
  (gdb) continue → 应执行 SetEventNotificationMode(ENABLE, VM_INIT, NULL)
  (gdb) break JPLISAgent.c:287
  (gdb) continue → 应执行 SetEventCallback(VM_INIT, eventHandlerVMInit)
  (gdb) print agent->mPremainCaller → 期望: 非 NULL jmethodID

断言 7: processJavaStart (JPLISAgent.c:382)
  (gdb) break JPLISAgent.c:397 (createInstrumentationImpl 之后)
  (gdb) print agent->mInstrumentationImpl → 期望: 非 NULL jobject (JNI NewObject 结果)
  (gdb) break JPLISAgent.c:403 (setLivePhaseEventHandlers 之后)
  (gdb) print agent->mClassFileLoadHookSet → 期望: 1 (CFLH handler 已注册)
  (gdb) break JPLISAgent.c:411 (startJavaAgent 调用)
  (gdb) print classname → 期望: "com.example.MyAgent"
  (gdb) print options → 期望: "debug,timeout=5000"
  (gdb) continue → premain 被执行

断言 8: InstrumentationImpl.loadClassAndCallPremain (InstrumentationImpl.java:521)
  (gdb) break Class.forName (通过 JNI 断点)
  (gdb) print classname → 期望: "com.example.MyAgent"
  (gdb) continue 经过 premain.invoke()
  (gdb) print → 确认无异常 (JNI ExceptionCheck == NULL)
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §一 承接**：本文展开 README 中 "01 — Agent 参数解析与 Agent_OnLoad 启动路径"——从 `-javaagent:jar=opts` 到 `premain()` 的完整代码级解答。

2. **同组边界**: 本文覆盖 Agent 加载的启动路径（OnLoad）；02 覆盖 agent 加载后的 ClassFileLoadHook 字节码转换；03 覆盖 Attach API 动态加载（OnAttach 路径）；04 覆盖 Redefine/Retransform 运行时类重定义。

3. **全部文档共享 §一 开头语**: "Reader completed 01-jvm-startup (JVM initialization flow), 09-native-interface (JNI/JVM_ENTRY macros), 03-object-model (oop, Klass hierarchy). This doc: how -javaagent goes from a command-line string to executing user premain() code."
