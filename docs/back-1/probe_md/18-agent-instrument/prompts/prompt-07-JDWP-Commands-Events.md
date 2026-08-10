# PROMPT: 请撰写 07-JDWP-Commands-Events.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**症状**：使用 IDE 调试 Java 应用时，断点不命中、单步调试行为异常、或变量查看显示 `"Object has been collected"`。

```
# IDE 日志中的典型错误
JDWP exit error AGENT_ERROR_INTERNAL(200): unexpected JDWP error: 112
# 或
Step request failed: JVMTI_ERROR_INVALID_THREAD (10)
```

**根因分析**：JDWP 命令处理涉及 4 层：

1. **debugDispatch** (`debugDispatch.c:94`): 两级数组查找 CommandSet → Command → Handler
2. **Handler 实现** (17 个 `*Impl.c` 文件): 每个 handler 调用 JVMTI 函数或 JNI 函数
3. **eventHandler** (`eventHandler.c:541`): JVMTI 事件回调 → 事件过滤 → JDWP 事件包
4. **threadControl** (`threadControl.c:793`): 断点/单步事件后的线程挂起控制

最常见的问题：
- **断点不命中**: eventHandler 的 `event_callback` 中过滤条件不匹配——ClassFilter/ThreadFilter 错误配置
- **单步异常**: stepControl 的 `stepControl_handleStep` 中深度计数器溢出或 JVMTI 错误
- **变量不可见**: ObjectReference handler 中对象被 GC 回收——JNI weak reference 失效

**三步诊断**：

```bash
# 1. 启用 JDWP 详细日志
java -agentlib:jdwp=transport=dt_socket,address=8000,server=y,suspend=n -Xlog:jdwp=trace

# 2. 检查 JVMTI 事件是否被注册
# 在 IDE 中设置断点后，检查 JVM 事件
jcmd <pid> VM.jvmti_events | grep -E "BREAKPOINT|SINGLE_STEP"

# 3. GDB 断点验证事件处理
gdb -ex "break eventHandler.c:541" \
    -ex "break threadControl.c:793" \
    -ex "break stepControl.c:511" \
    -ex "run" \
    -ex "print eventIndex" \
    --args java -agentlib:jdwp=transport=dt_socket,address=8000,server=y app.jar
```

**反事实**：如果 JDWP 事件不经过 threadControl 的挂起机制——断点命中后线程继续执行 → 调试器收到断点事件时线程已经执行了后续代码 → 变量值已经改变 → 调试器显示的是"未来"的变量状态。threadControl 在 `onHook` 回调中调用 `suspendAll`——确保所有线程在事件报告前暂停，调试器看到的变量状态是断点时刻的快照。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that covers the JDWP command dispatch system—the 17 CommandSet implementations, the event handler pipeline from JVMTI callback to JDWP Composite Event, and the thread/step control mechanisms. This is NOT a reference for all 200+ JDWP commands—it's ENGINEERING documentation on HOW the JDWP agent translates JVMTI events into debugger-visible operations.

Reader completed **06-JDWP-Transport-Init**（JDWP 启动, transport, debugLoop, debugDispatch）. This doc: **how debugLoop dispatches commands to 17 CommandSet handlers, how JVMTI breakpoint/step events become JDWP events, and how threadControl manages the suspend/resume lifecycle** — from `event_callback` at eventHandler.c:541 to `stepControl_endStep` at stepControl.c:879.

### Interview Story Format Answer（必须出现在 §一 末尾）

"When the IDE sets a breakpoint at `Foo.java:42`, it sends a JDWP `Set` command (EventRequest CommandSet=15, Command=1) specifying `EventKind=BREAKPOINT(2)` with a `LocationOnly` modifier containing the class and method. The handler at EventRequestImpl.c parses the request, and the eventHandler at eventHandler.c:1429 registers a JVMTI breakpoint via `SetBreakpoint`. Later, when the interpreter hits that location, JVMTI fires `JVMTI_EVENT_BREAKPOINT`. The callback `event_callback` at eventHandler.c:541 converts it: `jvmti2EventIndex(JVMTI_EVENT_BREAKPOINT)` → `EI_BREAKPOINT` → checks if any debugger requested this event → runs filters (ClassFilter, ThreadFilter, CountFilter) → if matched, calls `threadControl_onHook` at threadControl.c:793. This is the critical point—`threadControl_onHook` calls `suspendAll` at :1493 to pause all Java threads, then suspends the current thread (the one that hit the breakpoint) via JVMTI `SuspendThread`. The event is then queued via `eventHelper_reportEvents` at eventHelper.c:1001, which serializes it as a JDWP `Composite` event containing the `BREAKPOINT` event with thread, location, and reference type IDs. The next time `debugLoop_run` processes a command from the debugger, it sends this pending event. When the debugger sends `Resume` (ThreadReference CommandSet=11, Command=2), `threadControl_resumeAll` at threadControl.c:1572 resumes all suspended threads. For single-stepping, `stepControl_beginStep` at stepControl.c:787 sets JVMTI `SingleStep` event notification and records the starting frame depth and location—`stepControl_handleStep` at :511 fires on each bytecode instruction and checks whether the step is 'complete' (line changed for STEP_LINE, method entered/exited for STEP_INTO/STEP_OVER/STEP_OUT)."

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **JVMTI 事件 → JDWP 事件转换**: `util.h:147-170` 定义 `EventIndex` 枚举（EI_SINGLE_STEP=0..EI_VM_DEATH=19），`util.c:1962-1981` 的 `index2jvmti[]` 数组映射 EventIndex → JVMTI_EVENT，`eventIndex2jdwp()` (:2005) 映射 EventIndex → JDWP EventKind。JVMTI 事件进入 `event_callback` 后，switch-case 分派到 EventIndex，再转换为 JDWP 事件。Source: `util.c:1962-2118`.

2. **eventHandler 的事件过滤管道**: 当调试器发送 `Set` 命令注册事件时，`eventHandler` 创建 `HandlerNode` 链表——每个节点包含事件类型、过滤器列表（ClassFilter, ThreadFilter, CountFilter, LocationFilter, InstanceFilter, StepFilter, ExceptionFilter）。`event_callback` 触发时遍历所有 HandlerNode，对每个节点运行所有过滤器——全部通过才报告事件。Source: `eventHandler.c, eventFilter.c`.

3. **threadControl 的挂起/恢复模型**: JDWP 使用 JVMTI `SuspendThread`/`ResumeThread` 实现调试暂停。`threadControl_onHook` (threadControl.c:793) 在断点/单步事件时挂起所有线程（suspendAll），然后恢复当前线程（让它停在断点处等待调试器检查）。`threadControl_suspendAll` (:1493) 遍历所有 JavaThread 调用 `SuspendThread`，`threadControl_resumeAll` (:1572) 调用 `ResumeThread`。Source: `threadControl.c`.

4. **stepControl 的深度计数**: `stepControl_beginStep` (stepControl.c:787) 记录起始帧深度和位置。`stepControl_handleStep` (:511) 在每次 JVMTI SingleStep 事件时检查：(1) STEP_INTO——任何新指令，(2) STEP_OVER——同深度或更浅，(3) STEP_OUT——深度减少，(4) STEP_LINE——行号改变。如果满足条件 → 结束单步 → `stepControl_endStep` (:879) 清除 JVMTI SingleStep 通知。Source: `stepControl.c`.

5. **eventHelper 的 Composite Event**: JDWP 规范要求多个事件可以打包为一个 `Composite` 事件。`eventHelper_reportEvents` (eventHelper.c:1001) 将待发送事件列表序列化：outStream_writeInt(count) + for each event: outStream_writeByte(eventKind) + outStream_writeInt(requestID) + 事件特定数据。这减少了网络往返次数。Source: `eventHelper.c:1001-1145`.

6. **commonRef 的对象引用管理**: JDWP 使用 `ObjectReference` 和 `ReferenceType` ID 引用 JVM 中的对象。`commonRef` (commonRef.c) 管理 JNI global reference 的生命周期——`commonRef_idToRef` 将 ID 映射到 JNI reference，`commonRef_refToID` 反之。ID 是单调递增的 jlong——每次创建新引用时分配。Source: `commonRef.c`.

7. **error_messages 的错误码映射**: JDWP 定义 ~47 个错误码（JDWPCommands.h:143-201）：`NONE(0)`, `INVALID_THREAD(10)`, `INVALID_OBJECT(20)`, `NOT_IMPLEMENTED(99)`, `VM_DEAD(112)`, `INTERNAL(113)`。JVMTI 错误码通过 `jvmtiErrorToJDWPError` 映射到 JDWP 错误码。`jdwpErrorText` (error_messages.h:43) 将错误码转换为可读文本。Source: `error_messages.c`.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux。

Source roots:
- `src/jdk.jdwp.agent/share/native/libjdwp/eventHandler.c` — event_callback (:541), eventHandler_initialize (:1429)
- `src/jdk.jdwp.agent/share/native/libjdwp/eventHelper.c` — eventHelper_reportEvents (:1001)
- `src/jdk.jdwp.agent/share/native/libjdwp/eventFilter.c` — 事件过滤
- `src/jdk.jdwp.agent/share/native/libjdwp/threadControl.c` — threadControl_onHook (:793), suspendAll (:1493), resumeAll (:1572)
- `src/jdk.jdwp.agent/share/native/libjdwp/stepControl.c` — stepControl_beginStep (:787), handleStep (:511), endStep (:879)
- `src/jdk.jdwp.agent/share/native/libjdwp/standardHandlers.c` — onConnect/onDisconnect
- `src/jdk.jdwp.agent/share/native/libjdwp/commonRef.c` — 对象引用管理
- `src/jdk.jdwp.agent/share/native/libjdwp/invoker.c` — 方法调用
- `src/jdk.jdwp.agent/share/native/libjdwp/util.c` — EventIndex 枚举 + 映射表 (:1962-2118)
- `build/.../support/headers/jdk.jdwp.agent/JDWPCommands.h` — CommandSet 宏 + 错误码
- 17 个 `*Impl.c` 文件 — CommandSet 1-18 的实现

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjdwp.so`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **eventHandler.c** | `src/jdk.jdwp.agent/share/native/libjdwp/eventHandler.c` | 1714 | event_callback(:541), initialize(:1429), cbVMInit(:1207) | 🔥 事件处理核心 |
| 2 | **eventHelper.c** | `src/jdk.jdwp.agent/share/native/libjdwp/eventHelper.c` | 1172 | reportEvents(:1001), reportVMInit(:1145) | Composite Event 组合 |
| 3 | **eventFilter.c** | `src/jdk.jdwp.agent/share/native/libjdwp/eventFilter.c` | 1361 | ClassFilter, ThreadFilter, CountFilter 等 | 事件过滤 |
| 4 | **threadControl.c** | `src/jdk.jdwp.agent/share/native/libjdwp/threadControl.c` | 2556 | onHook(:793), suspendAll(:1493), resumeAll(:1572), popFrames(:1929) | 🔥 线程控制 |
| 5 | **stepControl.c** | `src/jdk.jdwp.agent/share/native/libjdwp/stepControl.c` | 926 | beginStep(:787), handleStep(:511), endStep(:879) | 单步调试 |
| 6 | **commonRef.c** | `src/jdk.jdwp.agent/share/native/libjdwp/commonRef.c` | 620 | idToRef, refToID | 对象引用管理 |
| 7 | **util.c** | `src/jdk.jdwp.agent/share/native/libjdwp/util.c` | 2886 | index2jvmti(:1962), eventIndex2jdwp(:2005) | JVMTI↔JDWP 事件映射 |
| 8 | **error_messages.c** | `src/jdk.jdwp.agent/share/native/libjdwp/error_messages.c` | 335 | jdwpErrorText, jvmtiErrorText | 错误码映射 |
| 9 | **invoker.c** | `src/jdk.jdwp.agent/share/native/libjdwp/invoker.c` | 891 | InvokeMethod handler | 方法调用 |
| 10 | **standardHandlers.c** | `src/jdk.jdwp.agent/share/native/libjdwp/standardHandlers.c` | 184 | onConnect/onDisconnect | 标准事件处理 |

17 个 CommandSet 实现文件见 §四.7。

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ event_callback — JVMTI 事件入口

```
问题：
  ① event_callback (eventHandler.c:541) 如何处理 JVMTI 事件？
      答案方向:
        1. callbackLock 加锁 → active_callbacks++
        2. 根据 JVMTI event type switch-case:
           JVMTI_EVENT_BREAKPOINT → EI_BREAKPOINT
           JVMTI_EVENT_SINGLE_STEP → EI_SINGLE_STEP
           JVMTI_EVENT_CLASS_PREPARE → EI_CLASS_PREPARE
           ... (20 个事件类型)
        3. 调用 eventHandler_handleEvent(EI, ...)
        4. 查找该 EI 的所有 HandlerNode（调试器注册的事件请求）
        5. 对每个 HandlerNode → 运行所有过滤器
        6. 所有过滤器通过 → 添加到 pending event 列表
        7. active_callbacks-- → callbackLock 解锁
      
      追问: 为什么需要 callbackLock？
      → 多个线程可能同时触发事件（多线程断点）→ eventHandler 的链表操作需要互斥。
        callbackLock 保护 HandlerNode 链表的并发访问。

  ② Counterfactual: 如果事件处理在 JVMTI 回调线程中直接发送 JDWP 包？
      答案方向: JVMTI 回调线程是 JVM 内部线程（如解释器线程）→ 不能阻塞
        在 socket write 上（可能阻塞等待调试器接收）→ 死锁风险。
        事件先排队（pending events），主循环线程（debugLoop）负责发送——
        解耦了事件触发和事件发送。
```

### 4.2 ★★★ threadControl_onHook — 断点命中后的线程挂起

```
问题：
  ① threadControl_onHook (threadControl.c:793) 的挂起逻辑是什么？
      答案方向:
        1. 检查调试器是否已连接（onConnect 回调中设置标志）
        2. 检查事件是否需要挂起（invoke 完成事件不挂起）
        3. threadControl_suspendAll() → 遍历所有 JavaThread → JVMTI SuspendThread
        4. 检查当前线程是否应该挂起：
           a. 如果挂起策略是 SUSPEND_EVENT_THREAD → 挂起当前线程
           b. 如果挂起策略是 SUSPEND_ALL → 挂起所有线程
           c. 如果挂起策略是 SUSPEND_NONE → 不挂起
        5. 当前线程自挂起 → JVMTI SuspendThread(current)
        
      追问: 为什么先 suspendAll 再根据策略决定？
      → 为了获取一致的线程状态快照。如果先检查策略再挂起 → 策略检查期间
        其他线程可能修改共享状态 → 调试器看到的线程状态不一致。

  ② Counterfactual: 如果使用 safepoint 替代 JVMTI SuspendThread？
      答案方向: Safepoint 暂停所有 Java 线程（包括 JIT 编译线程、GC 线程）
        → 调试器无法检查线程状态（所有线程都停在 safepoint 桩，不在业务代码中）
        → 无法获取调用栈、局部变量 → 调试功能完全失效。
        JVMTI SuspendThread 是"软暂停"——线程停在当前字节码位置，保持完整栈帧。
```

### 4.3 ★★★ stepControl — 单步调试

```
问题：
  ① stepControl_beginStep (stepControl.c:787) 如何设置单步？
      答案方向:
        1. 计算当前帧深度（stack depth）
        2. 记录起始位置（method + location/bci）
        3. 设置 step 类型：STEP_INTO / STEP_OVER / STEP_OUT / STEP_LINE
        4. JVMTI SetEventNotificationMode(ENABLE, SINGLE_STEP, thread)
        5. 进入纯解释模式（interp_only_mode）——禁止 JIT 编译
        
      追问: 为什么需要进入纯解释模式？
      → JIT 编译的方法没有逐条指令的 SingleStep 事件——编译器优化了指令序列。
        纯解释模式保证每条字节码指令都触发 SingleStep 事件，stepControl 才能
        精确判断"是否跨过了行边界"或"是否进入了新方法"。

  ② Counterfactual: 如果不进入纯解释模式——允许 JIT 编译？
      答案方向: JIT 编译的方法 → SingleStep 事件在编译代码中不触发
        → stepControl_handleStep 永远等不到事件 → 单步卡住不动
        → 调试器超时。纯解释模式是单步调试正确性的必要代价。
```

### 4.4 ★★★ eventHelper_reportEvents — Composite Event 组合

```
问题：
  ① eventHelper_reportEvents (eventHelper.c:1001) 如何组合多个事件？
      答案方向:
        1. 收集所有 pending events 到列表
        2. outStream_initCommand → 创建命令包（cmdSet=64, cmd=100 = Composite）
        3. outStream_writeInt(eventCount) → 事件数量
        4. for each event:
           outStream_writeByte(eventKind) → JDWP EventKind
           outStream_writeInt(requestID) → 事件请求 ID
           写入事件特定数据（断点→thread+location, 类加载→thread+refType+signature）
        5. outStream_send → 发送 Composite 事件包
      
      追问: 为什么 Composite 的 cmdSet=64？
      → cmdSet=64 是 JDWP 规范中的保留范围（64-127 = vendor extension）。
        Composite(100) 是 JDWP 规范定义的特殊命令——不是任何 CommandSet 的一部分，
        而是事件通知机制。

  ② Counterfactual: 如果每个事件单独发送一个包？
      答案方向: 3 个断点同时命中 → 3 个独立包 → 3 次 socket write
        → 3 次 TCP 往返（如果有确认）→ 延迟 ×3。
        Composite 打包一次发送 → 1 次 socket write → 更低延迟。
```

### 4.5 ★★★ commonRef — 对象引用 ID 管理

```
问题：
  ① commonRef (commonRef.c) 如何管理 JNI global reference？
      答案方向:
        1. commonRef_idToRef(id) → hash 表查找 id → JNI NewLocalRef → jobject
        2. commonRef_refToID(ref) → 检查是否已有 id → 是则返回，否则分配新 id + JNI NewGlobalRef
        3. commonRef_releaseID(id) → JNI DeleteGlobalRef → 从 hash 表删除
        4. ID 是单调递增的 jlong——每次分配 +1
      
      追问: 为什么使用 JNI GlobalRef 而非普通指针？
      → JNI GlobalRef 阻止 GC 回收对象 → 调试器持有对象引用期间对象不会被回收
        → 调试器可以安全地检查对象字段。但 GlobalRef 是强引用 → 可能导致内存泄漏
        → 调试器断开时必须调用 commonRef_releaseAll。

  ② Counterfactual: 如果使用 Weak GlobalRef（允许 GC 回收）？
      答案方向: 调试器持有 ObjectReference ID → GC 回收对象 → 调试器发送
        GetValues 命令 → commonRef_idToRef 返回 NULL → "Object has been collected"
        错误 → 调试器显示空变量 → 用户体验差但内存安全。
        当前设计选择强引用——调试期间优先正确性，断开时统一清理。
```

### 4.6 ★★★ 17 个 CommandSet 概览

```
问题：
  ① 17 个 CommandSet 各负责什么功能？分发机制是什么？
      答案方向: 两级分发表 debugDispatch.c:69-86 注册：
        CommandSet  1 — VirtualMachine: Version, ClassesBySignature, AllClasses, AllThreads, TopLevelThreadGroups, Dispose, IDSizes, Suspend, Resume, Exit, CreateString, Capabilities, ClassPaths, DisposeObjects, HoldEvents, ReleaseEvents, CapabilitiesNew, RedefineClasses, SetDefaultStratum, AllClassesWithGeneric, InstanceCounts
        CommandSet  2 — ReferenceType: Signature, ClassLoader, Modifiers, Fields, Methods, GetValues, SourceFile, NestedTypes, Status, Interfaces, ClassObject, SourceDebugExtension, SignatureWithGeneric, FieldsWithGeneric, MethodsWithGeneric, Instances, ClassFileVersion, ConstantPool, Module
        CommandSet  3 — ClassType: Superclass, SetValues, InvokeMethod, NewInstance
        CommandSet  4 — ArrayType: NewInstance
        CommandSet  5 — InterfaceType: (无独立命令，通过 ReferenceType)
        CommandSet  6 — Method: LineTable, VariableTable, Bytecodes, IsObsolete, VariableTableWithGeneric
        CommandSet  8 — Field: (通过 ReferenceType.GetValues/SetValues)
        CommandSet  9 — ObjectReference: ReferenceType, GetValues, SetValues, MonitorInfo, InvokeMethod, DisableCollection, EnableCollection, IsCollected, ReferringObjects
        CommandSet 10 — StringReference: Value
        CommandSet 11 — ThreadReference: Name, Suspend, Resume, Status, ThreadGroup, Frames, FrameCount, OwnedMonitors, CurrentContendedMonitor, Stop, Interrupt, SuspendCount, OwnedMonitorsStackDepthInfo, ForceEarlyReturn
        CommandSet 12 — ThreadGroupReference: Name, Parent, Children
        CommandSet 13 — ArrayReference: Length, GetValues, SetValues
        CommandSet 14 — ClassLoaderReference: VisibleClasses
        CommandSet 15 — EventRequest: Set, Clear, ClearAllBreakpoints
        CommandSet 16 — StackFrame: GetValues, SetValues, ThisObject, PopFrames
        CommandSet 17 — ClassObjectReference: ReflectedType
        CommandSet 18 — ModuleReference: Name, ClassLoader, CanRead, etc.
        
      追问: 为什么没有 CommandSet 7？
      → JDWP 规范为将来扩展预留。CommandSet 编号从 1 开始，7 从未被分配。
        类似地，EventKind 编号也有间隙（如 3 未使用）。

  ② Counterfactual: 如果使用 hash map 替代两级数组？
      答案方向: CommandSet 和 Command 都是小整数（1-18, 1-20+）→ 两级数组 O(1) 索引
        比 hash map 更快（无 hash 计算、无碰撞处理）。CommandSet 18 × Command 20 = 360 个条目
        → 指针数组 ~2.8KB → 内存开销可接受。
```

---

## §五 Article Structure

```
§〇 生产场景 — 断点不命中 / 单步异常 错误诊断
  ★ 真实错误 + 三步诊断
  ★ 反事实: 无 threadControl 挂起 → 变量值不是断点时刻快照

§一 ★★★ JDWP 命令与事件全链路源码走读
  1.1 debugDispatch.c:94 两级分发表 → 17 CommandSet 概览
  1.2 eventHandler.c:541 event_callback → JVMTI 事件入口
  1.3 util.c:1962 JVMTI↔JDWP 事件映射表
  1.4 eventFilter.c — 事件过滤管道
  1.5 threadControl.c:793 onHook → 断点命中后挂起
  1.6 threadControl.c:1493/1572 suspendAll/resumeAll
  1.7 stepControl.c:787/511/879 beginStep/handleStep/endStep
  1.8 eventHelper.c:1001 reportEvents → Composite Event
  1.9 commonRef.c — 对象引用管理
  1.10 ★ Mermaid: 事件处理序列图 — 6 lanes: Debugger / debugLoop / eventHandler / threadControl / JVMTI / Interpreter
  1.11 ★ 面试 Story Format 答案

§二 ★★★ 7 Beginner Callout 框
  2.1 JVMTI→JDWP 事件转换
  2.2 eventHandler 事件过滤管道
  2.3 threadControl 挂起/恢复模型
  2.4 stepControl 深度计数
  2.5 eventHelper Composite Event
  2.6 commonRef 对象引用管理
  2.7 error_messages 错误码映射

§三 ★★ 性能剖析
  3.1 事件处理: JVMTI 回调 ~5µs + 过滤 ~2µs + threadControl ~20µs
  3.2 单步: 每条字节码指令 ~10µs（纯解释模式）
  3.3 Composite Event: N 事件打包 ~1 次网络往返

§四 ★ GDB 断点验证 — 7 断点
  断言 1: eventHandler.c:541 event_callback → verify JVMTI event
  断言 2: util.c:2005 eventIndex2jdwp → verify mapping
  断言 3: threadControl.c:793 onHook → verify suspendAll
  断言 4: stepControl.c:511 handleStep → verify step logic
  断言 5: eventHelper.c:1001 reportEvents → verify composite
  断言 6: debugDispatch.c:94 getHandler → verify dispatch
  断言 7: commonRef.c idToRef → verify reference management

§五 ★ Cross-Reference
  ❓ 06-JDWP-Transport-Init — debugLoop + debugDispatch
  ❓ 05-JVMTI-Core — JVMTI 事件系统 + TagMap
  ❓ 04-Redefine-Classes — RedefineClasses 命令 (CommandSet 1)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY**.

2. **3-5 lines source code per claim**.

3. **Mermaid** — 事件处理序列图。6 lanes: Debugger / debugLoop / eventHandler / threadControl / JVMTI / Interpreter。

4. **GDB session** — 7 breakpoints.

5. **7 Beginner callout boxes**.

6. **Cross-reference at three points**.

7. **Story-format interview answer**.

8. **"不要写成→应该写成" 对照表**:
   | 不要写成 | 应该写成 |
   |---------|---------|
   | "JVMTI breakpoint becomes JDWP event" | "event_callback at eventHandler.c:541 receives JVMTI_EVENT_BREAKPOINT → switch-case maps to EI_BREAKPOINT → eventHandler_handleEvent finds matching HandlerNodes → runs ClassFilter/ThreadFilter/CountFilter → if passed, adds to pending list → eventHelper_reportEvents at eventHelper.c:1001 serializes as Composite event with EventKind=BREAKPOINT" |
   | "threadControl suspends threads on breakpoint" | "threadControl_onHook at threadControl.c:793 calls suspendAll at :1493 — iterating all JavaThreads and calling JVMTI SuspendThread — then suspends the current thread. This freezes all threads at their current bytecode positions, preserving the exact state for the debugger" |
   | "stepControl manages single-stepping" | "stepControl_beginStep at stepControl.c:787 records starting frame depth and location, sets JVMTI SingleStep notification, and enters interp_only_mode. stepControl_handleStep at :511 fires on each bytecode instruction and checks depth/location against step type (INTO/OVER/OUT/LINE)" |
   | "commonRef manages object references" | "commonRef_idToRef at commonRef.c maps monotonically increasing jlong IDs to JNI GlobalRefs via hash table lookup. GlobalRefs prevent GC from collecting objects the debugger is inspecting — released via commonRef_releaseAll when the debugger disconnects" |
   | "debugDispatch routes commands to handlers" | "debugDispatch_getHandler at debugDispatch.c:94 performs O(1) two-level array lookup: l1Array[cmdSet] → l2Array[cmd] → Handler function pointer. 17 CommandSets registered at :69-86 with ~200 total commands" |

---

## §七 Output Format

- Markdown file, named `07-JDWP-Commands-Events.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/18-agent-instrument/docs/`
- 元信息头: 包含阶段、前置、配套、后续依赖、阅读收益
- 目标行数: 400+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "JDWP handles commands" 而不展示两级分发表和 eventHandler 管道
- ❌ 不解释 JVMTI→JDWP 事件映射 — 必须展示 EventIndex + index2jvmti[] + eventIndex2jdwp
- ❌ 忽略 threadControl 挂起模型 — 必须展示 suspendAll + SuspendThread
- ❌ 不解释 stepControl 深度计数 — 必须展示 INTO/OVER/OUT/LINE 四种模式
- ❌ 不展示 eventHelper Composite Event 组合
- ❌ 忽略 commonRef 的 JNI GlobalRef 管理
- ❌ 不做 GDB 断点 trace — 至少 7 个断点
- ❌ 不要写成 JDWP 协议参考手册

---

## §九 Required（≥8）

- ✅ **★ Mermaid 事件处理序列图** — 6 lanes
- ✅ **★ event_callback 完整源码** — JVMTI 事件入口
- ✅ **★ threadControl_onHook 源码** — 断点挂起逻辑
- ✅ **★ stepControl 三种方法源码** — beginStep/handleStep/endStep
- ✅ **★ eventHelper_reportEvents 源码** — Composite Event
- ✅ **★ 17 CommandSet 概览表** — 每个 CommandSet 的核心命令
- ✅ **★ 7 Beginner Callout 框**
- ✅ **★ 面试 Story Format 答案**
- ✅ **★ GDB 断点 ≥7 条**
- ✅ **★ "不要写成→应该写成" 对照表** — ≥5 行
- ✅ **★ 交叉引用** — 06, 05, 04

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: event_callback (eventHandler.c:541)
  (gdb) break eventHandler.c:541
  (gdb) print event_type → 期望: JVMTI_EVENT_BREAKPOINT 或其他
  (gdb) print active_callbacks → 期望: 递增中

断言 2: eventIndex2jdwp 映射 (util.c:2005)
  (gdb) break util.c:2005
  (gdb) print eventIndex → 期望: EI_BREAKPOINT (2)
  (gdb) print jdwpEventKind → 期望: JDWP_EventKind_BREAKPOINT

断言 3: threadControl_onHook (threadControl.c:793)
  (gdb) break threadControl.c:793
  (gdb) print suspendPolicy → 期望: SUSPEND_EVENT_THREAD 或 SUSPEND_ALL

断言 4: stepControl_handleStep (stepControl.c:511)
  (gdb) break stepControl.c:511
  (gdb) print step->depth → 期望: 起始帧深度
  (gdb) print currentDepth → 期望: 当前帧深度
  (gdb) print step->type → 期望: STEP_INTO/OVER/OUT/LINE

断言 5: eventHelper_reportEvents (eventHelper.c:1001)
  (gdb) break eventHelper.c:1001
  (gdb) print pending_event_count → 期望: >0
  (gdb) continue → Composite event 发送

断言 6: debugDispatch_getHandler (debugDispatch.c:94)
  (gdb) break debugDispatch.c:94
  (gdb) print cmdSet → 期望: 1-18
  (gdb) print cmd → 期望: 具体命令编号
  (gdb) print handler → 期望: 非 NULL 函数指针

断言 7: commonRef_idToRef (commonRef.c)
  (gdb) break commonRef.c:idToRef
  (gdb) print id → 期望: 有效的对象 ID
  (gdb) continue → 返回 JNI local ref
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §一 承接**：本文展开 "07 — JDWP 命令+事件: 17 CommandSet → eventHandler → threadControl → stepControl"——JDWP 命令处理和事件系统的完整代码级解答。

2. **同组边界**: 06 覆盖 JDWP 启动和 transport；07 覆盖命令处理和事件系统。两篇合起来覆盖了 libjdwp.so 的全部核心功能。
