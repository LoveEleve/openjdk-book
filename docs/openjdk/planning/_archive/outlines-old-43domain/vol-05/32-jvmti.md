# JVMTI — 文章大纲

> vol-05 · 域 32 · 🟡 B
>
> **→ 从 MethodHandles (vol-04)**：vol-04 完整讲述了 Java 代码从 class 文件到 JVM 执行再到 JIT 优化的全过程。现在换一个视角：不执行代码，而是**观察**代码怎么执行——JVMTI (JVM Tool Interface) 是 JVM 对外部 agent（调试器/Profiler/APM）开放的标准观测接口。

## 概念依赖

先修：Interpreter（JVMTI 在解释器执行关键点时回调 agent）、ClassFile（ClassFileLoadHook 在类加载前可修改字节码）、ServiceThread（JVMTI 事件的延迟投递用 ServiceThread）。

JVMTI 是 JVM 的"可观测性基础层"——jstack/jmap/JFR 都建立在 JVMTI 之上或与它平行。Agent 通过 JVMTI 可以：(1) 收到事件通知，(2) 查询/修改 JVM 状态，(3) 通过字节码插桩注入代码。

## 叙事计划

**开篇场景**：线上接口慢了，你想知道是哪个方法在消耗 CPU——但不改代码、不重启服务。`async-profiler` 通过 JVMTI agent 动态 attach 到 JVM：声明需要 `can_generate_method_entry_events` 能力 → 开启 MethodEntry 事件 → 每次方法入口 agent 收到回调 → agent 记录时间戳 → 构建火焰图。这就是 JVMTI 的核心价值：在运行时**不影响代码**的前提下观察运行状态。

**第一层：Agent 生命周期 — 从 attach 到 detach**

JVMTI agent 是一个本地库（.so/.dylib），通过 `-agentpath` 启动参数或 `Attach API` 动态加载。三个阶段：

1. **OnLoad**：JVM 启动时加载 agent → agent 调用 `SetEventCallbacks()` 注册回调函数 → `SetEventNotificationMode()` 选择要接收的事件
2. **OnAttach**：运行时通过 Attach API 动态 attach → 同上注册+选择
3. **OnUnload**：JVM 关闭或 agent detach → 释放资源

关键约束：agent 的 `Agent_OnLoad()` 函数在 JVM 的**非常早期**被调——此时很多 JVM 设施（class loading、Thread）尚未就绪。agent 只能做最基本的初始化（分配内存、注册回调）。`Agent_OnAttach()` 在运行时被调——JVM 已完全就绪，agent 可以直接查询任何 JVM 状态。

**第二层：事件模型 — JVM 的"发布-订阅"**

JVMTI 的事件机制是"能力声明+事件订阅"的双层门禁：

- **Capability**：agent 声明需要的能力（如 `can_generate_method_entry_events`）。JVM 在启动时检查——如果当前模式不支持（如只在 `-Xcomp` 下需要 NativeMethodBind），能力申请失败。
- **Event Notification**：agent 调用 `SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_METHOD_ENTRY)` 订阅事件。只有 agent 订阅的事件才会触发回调。

核心事件类型：ClassFileLoadHook（类加载前可改字节码→插桩基础）、MethodEntry/MethodExit（方法调用 trace→Profiler）、Breakpoint（调试器断点）、FieldAccess/FieldModification（字段监控）、CompiledMethodLoad/Unload（JIT 编译通知）。

`_should_post_*` 标志位（`jvmtiExport.hpp:83-105`）做快速路径优化——每个事件类型有一个全局 flag。解释器在每个可能触发事件的关键点检查 flag——如果 flag=false，零开销跳过。这避免了 agent 不订阅时的不必要检查开销。

**第三层：ClassFileLoadHook — 字节码注入的入口**

JVMTI 最强大的事件是 `ClassFileLoadHook`——在类加载完成前，agent 可以收到原始字节码并返回**修改后的**字节码。JVM 用修改后的版本定义类——原始字节码被替换。

这是所有 Java APM 工具（SkyWalking/NewRelic/Datadog）的核心机制：agent 在类加载时注入监控代码（如方法入口埋点 `Tracer.enter()`），后续所有调用自动拥有 tracing。不需要修改应用代码、不需要编译期处理——类加载时"热插"。

**第四层：类重定义 — 不停机修改代码**

`RetransformClasses` / `RedefineClasses` 允许 agent 在运行时修改已加载的类。JVM 对目标类的所有活跃栈帧执行 deoptimization——把它们退回到解释器——然后用新版本的字节码重新执行。

`jvmtiRedefineClasses.cpp` 处理重定义的复杂性：(1) 新旧常量池的合并，(2) 已经 JIT 编译的 nmethod 需要失效，(3) 活跃栈帧中的旧对象引用需要保持有效。这是 JVMTI 中最复杂的子系统——涉及到 class metadata 的原地更新、biased lock 的 revocation、method re-resolution。

**第五层：JVMTI 与 JIT 的协作**

JVMTI 和 JIT 编译器是"对立协作"关系。当 agent 开启 MethodEntry 事件时：

1. 所有方法在每次入口都向 agent 回调——不再是透明优化
2. JIT 编译器不能内联这些方法（内联后"方法入口"概念消失）
3. `can_post_on_exceptions` 开启 → C2 必须保留所有隐式异常的精确抛出点（不能合并或延迟）

JVMTI agent 的存在本质上是**降低** JIT 优化级别——agent 越活跃，JIT 越保守。`CompiledMethodLoad` 事件是少数不降低优化的事件——它只在 JIT 完成后通知，不改变编译逻辑。

**第六层：延迟事件投递 — ServiceThread 的角色**

某些 JVMTI 事件不能在当前线程上下文中直接投递（如在 safepoint 期间不能调 agent 的函数——agent 可能触发类加载导致死锁）。这些事件通过 `ServiceThread` 延迟投递：

1. 事件发生时记录数据到 `JvmtiDeferredEvent`
2. 事件放入 ServiceThread 的待处理队列
3. ServiceThread 在安全上下文中调用 agent 的回调

延迟投递的典型事件：DynamicCodeGenerated（在 CodeCache 更新时需要，但此时持有 CodeCache_lock）、CompiledMethodUnload（nmethod 卸载后）。

## 设计权衡

一、**能力声明 vs 按需查询**。JVMTI 要求 agent 预先声明能力——JVM 在启动时分配数据结构（如方法入口跟踪表）。优点是运行时事件投递零分配（数据结构已就绪），缺点是能力申请失败时 agent 无法工作。

二、**ClassFileLoadHook 的安全边界**。字节码注入是强大但危险的能力——一个错误的 ClassFileLoadHook 实现可以让所有类无法加载（JVM 启动直接崩溃）。JVM 对修改后的字节码做验证（StackMapTable 等），但验证失败是致命错误。

## 核心悬念

**怎么在不改应用代码的前提下"看见"JVM 内部——agent 通过 JVMTI 声明能力+订阅事件，JVM 在解释器/编译器的关键执行点检查 flag 并回调 agent，整个过程对应用代码透明。**

→ 下一域：JVMTI 是面向 agent 的可编程接口。JMX 是面向运维的标准化监控——MBean 注册、jconsole 查询、平台 MXBeans 的 Thread/Memory 统计。JMX 篇见。

## 预估

1 篇，6 层递进 + 2 设计权衡，1500-2000 行（🟡B）。
