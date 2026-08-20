# 01. 从 `Agent_OnLoad` 到 JVMTI 回调 —— async-profiler 的 JVM 集成总图

> **前置依赖**：[02-sampling-core/04 —— lock、wall-clock 与节流](../02-sampling-core/04-lock-wall-events.md)：知道事件引擎已经准备好把样本送入记录链
> → **后续**：BytecodeRewriter 与 JVMTI ClassFileLoadHook
>
> 本篇所有源码锚点均已回对 async-profiler 源码。

## native `.so` 进入 JVM 后，先拿什么

场景：async-profiler 可以通过 `-agentpath` 在 JVM 启动时加载，也可以由 asprof 运行期 attach。两条路径都要拿到 JVM Tool Interface，才能注册事件、访问 VM 结构和启动采样器。

async-profiler 的 JVM 集成要分成两条时序，不能压成一条直线：

```text
运行期 attach：
Agent_OnAttach
  → VM::init(vm, true)
    → ready()
      → capabilities / callbacks / 基础 notifications
        → RecordingAPI / loaded method IDs / GenerateEvents
          → Profiler::run(args)

启动期 bootstrap：
Agent_OnLoad
  → VM::init(vm, false)
    → capabilities / callbacks / 基础 notifications
      → 开启 VMInit notification
        → VMInit()
          → ready() / loaded method IDs
            → 按 _global_args._preloaded 决定是否 run(_global_args)
```

## 两个 agent 入口

`src/vmEntry.cpp:467-485` 是 `Agent_OnLoad()`，但它并不是无条件“现场 parse options”。当前实现先看 `_global_args._preloaded`：

- 只有不是 preloaded 时，才 `parse(options)` 并 `Log::open(_global_args)`；
- 然后调用 `VM::init(vm, false)`；
- 如果初始化失败，返回错误码。

这说明启动期 agent 有两种进入姿势：一种是普通 `-agentpath` 直接带参数启动；另一种是预加载路径已经在 `zInit.cpp:57-62` 把命令解析进 `_global_args` 并标记 `_preloaded`，`Agent_OnLoad()` 这里就不再重复解析。

`src/vmEntry.cpp:488-509` 是 `Agent_OnAttach()`：

- 创建临时 `Arguments` 并解析 options；
- 打开日志；
- 调 `VM::init(vm, true)`；
- 初始化成功后直接 `Profiler::instance()->run(args)`。

两者的关键差异在 `attach` 布尔值：启动加载路径需要等待 VMInit；运行期 attach 时 JVM 已经活着，可以在初始化后直接启动 profiler。

*关键设计（斜体）：* *启动期 agent 和运行期 attach 共用 VM 初始化，但启动时机不同。*[模式: 双入口 + 共享初始化] 入口差异只影响“何时开始”，不应该复制两套 JVMTI 注册和 profiler 初始化逻辑.

## `VM::init`：attach 路径先做 ready，随后再铺 JVMTI 能力与事件线

`VM::init` 的真实时序要先分 attach 与 bootstrap 两种情况。`src/vmEntry.cpp:226-236` 显示：如果 `attach == true`，它会先执行 `ready()`；只有随后才继续构造 `jvmtiCapabilities`、注册 callbacks 和开启基础 notification。也就是说，运行期 attach 不是简单的“能力 → 回调 → ready”，而是先做晚期初始化，再铺 JVMTI 能力与事件线。

`src/vmEntry.cpp:238-251` 中接着构造 `jvmtiCapabilities`，并调用 `_jvmti->AddCapabilities(&capabilities)`。能力包括：

- class hook / retransform；
- 读取字节码和 constant pool；
- source file name、line numbers；
- compiled method load；
- monitor events；
- garbage collection events；
- object tagging。

其中有些能力不是无条件相同：`can_retransform_any_class` 在 OpenJ9 上明确设为 0，`can_generate_vm_object_alloc_events` 则只在 OpenJ9 上设为 1（`vmEntry.cpp:239-243`）。这不是 JVM 随机缺能力，而是当前实现针对不同 JVM 类型主动提交了不同 capability 组合。

能力是“声明我想使用哪些 JVMTI 功能”，不等于每个 JVM 都一定能提供全部能力；更重要的是，这里的 `_jvmti->AddCapabilities(&capabilities)` 当前连返回值都没有检查，而不是“检查了但没有逐项展开处理”。真正使用某项能力时，相关模块还要通过运行时检查和失败分支决定是否降级。

接着构造 `jvmtiEventCallbacks callbacks = {0}`（`vmEntry.cpp:253`），把不同事件交给不同收件人：

- VMInit / VMDeath；
- ClassLoad / ClassPrepare；
- ClassFileLoadHook → `Instrument::ClassFileLoadHook`（这里只是把回调函数挂到接线板上，不等于启动时就持续开启通知）；
- CompiledMethodLoad / DynamicCodeGenerated → Profiler；
- ThreadStart / ThreadEnd → Profiler；
- MonitorContendedEnter/Entered → LockTracer；
- VMObjectAlloc → J9ObjectSampler；
- SampledObjectAlloc → ObjectSampler；
- GarbageCollectionStart → ObjectSampler；
- GarbageCollectionFinish → Profiler。

注册动作在 `vmEntry.cpp:253-269`，随后用 `SetEventCallbacks()` 提交给 JVMTI。这里的源码调用没有在当前函数中逐项检查返回值；同样，后面的多次 `SetEventNotificationMode()` 也主要体现“发出启用请求”，不能自动写成“每个 JVM 上都已成功打开”。具体能力不足通常在事件引擎或后续使用点暴露。

*关键设计（斜体）：* *回调注册表是 JVM 集成层的“接线板”。*[模式: 事件分派表 + 适配器] JVM 只负责发事件，具体引擎通过静态回调方法接收；LockTracer/ObjectSampler/Profiler 不需要自己重复初始化 JVMTI 回调表.

## 注册回调不等于开启通知

`SetEventCallbacks()` 只是把函数地址注册进去，真正打开事件还需要 `SetEventNotificationMode()`。

`VM::init` 在 `vmEntry.cpp:271-275` 开启 VMDeath、ClassLoad、ClassPrepare、DynamicCodeGenerated 和 GarbageCollectionFinish 等通知；编译事件还根据 HotSpot 版本与 CodeHeap 能力在 `:277-287` 处理。

其他事件则由各自引擎在 start 时按需开启：

- ObjectSampler 在 `objectSampler.cpp:177-180` 开启 sampled allocation/GC start；
- LockTracer 在 `lockTracer.cpp:56-63` 开启 monitor contention 和 Unsafe.park hook；
- `ClassFileLoadHook` 的 notification 也不是在 `VM::init` 里长期开着，而是后续 instrumentation 路径先执行 `initialize()`、`setupTargetClassAndMethod(args)`，把匹配目标准备好后，才在 `instrument.cpp:1096-1099` 开启 notification 并 retransformation；停止时再在 `:1103-1110` 撤销改写并关闭 notification；
- profiler 的具体事件引擎按 `Arguments` 决定是否启动。

这形成两级控制：

```text
回调函数注册 = 线路接好
事件通知开启 = 开关打开
```

*关键设计（斜体）：* *能力、回调和通知开关是三个不同层次。*[模式: 注册/启用分离] 这让 async-profiler 可以让所有模块共享回调表，却只在某个事件真正启动时打开对应通知.

## attach 与启动加载的初始化差异

当 `attach == true` 时，`VM::init` 的顺序其实是：

- 先在 `vmEntry.cpp:234-236` 调 `ready()` 做晚期初始化；
- 再铺 capabilities / callbacks / notification；
- 最后在 `:299-304` 绑定 Recording API、为已加载类加载 method IDs，并主动生成 dynamic code / compiled method 事件。

当 `attach == false` 时，它则在完成 capabilities / callbacks 等基础铺线后，于 `:305-307` 开启 VMInit 通知，把 `ready()` 与 delayed start 推迟到 JVM 正式初始化完成之后。

`VM::VMInit()` 在 `vmEntry.cpp:416-426`：

1. 调 `ready()`；
2. 加载现有方法 ID；
3. 如果 `_global_args._preloaded` 为假，就用已经准备好的全局参数调用 `Profiler::instance()->run(_global_args)`。

这里的 delayed start 更准确地说是：bootstrap 路径先把 `_global_args` 与 JVMTI 接线准备好，等 JVM 真正完成初始化后，再根据 `_global_args._preloaded` 决定是否调用 `Profiler::run(_global_args)`。它不是“到了 VMInit 再重新 parse 一遍参数”，也不是所有 bootstrap 场景都会在这里再次启动 profiler。

> 路标：到这里为止，主线真正分叉的是——运行期 attach 先 `ready()` 再补 JVMTI 接线；bootstrap 路径先铺接线，再等 `VMInit` 触发 `ready()` 和 delayed start。后面的 `ready()` 章节要看的，就是这一步到底补了哪些“必须在 JVM ready 之后才能碰”的设施。

## `ready()`：晚期初始化与重定义保护

`VM::ready()` 位于 `vmEntry.cpp:344-359`：

- 设置 profiler signal handlers；
- 让 `VMStructs` 解析并准备 VM 偏移；
- 取出 JVMTI function table；
- 保存原始 `RedefineClasses` / `RetransformClasses` 函数指针；
- 再把这两个表项替换成 async-profiler 的 hook。

这说明 `ready()` 做的不只是“晚期初始化”，还直接修改了 JVMTI function table。它与上面的 callbacks/notification 不是同一层：前者是把事件线路接好，`ready()` 则是拦截已有 JVMTI 函数入口，给后续 method-id 维护建立入口。`ready()` 本身没有返回错误状态，正文不把它写成“所有 VM 集成设施已经成功完成”的保证。

重定义 hook 在 `vmEntry.cpp:434-463`：只有原始 `RedefineClasses` / `RetransformClasses` 调用返回成功后，才逐个遍历本次传入且非空的受影响 class，调用 `loadMethodIDs()` 补建 method ID；它不是每次重定义后都全量重扫所有已加载类。

*关键设计（斜体）：* *JVM 集成不仅是“注册事件”，还要维护 JVM 动态重定义后的内部索引一致性。*[模式: 函数表拦截 + 失效后重建] 这为后续 BytecodeRewriter 和栈行走提供稳定的方法身份.

## 一条完整 JVM 集成链

```text
-agentpath / asprof attach
  → Agent_OnLoad / Agent_OnAttach
    → VM::init
      → AddCapabilities
        → SetEventCallbacks
          → SetEventNotificationMode
            → VMInit 或 Profiler::run
              → 各事件引擎启动
```

`vmEntry.cpp:312-341` 里的 `VM::tryAttach()` 还提供了一条旁路：如果当前代码运行在 native app 中，它会尝试查找已创建的 JavaVM，并在当前线程已经附着或可作为 daemon attach 到该 JVM 时直接调用 `VM::init(vm, true)`。这不是本篇主线的 agent 入口，但它提醒我们：JVM 集成并不只发生在 `Agent_OnLoad/OnAttach` 两个显式回调里；同进程 native 场景还有一条“发现现存 JVM 再附上 Tool Interface”的旁路。

这条链把 AP-1 的 attach、AP-2 的事件引擎和 AP-3 的 JVM 集成接起来：

- attach 解决 agent 怎么进来；
- JVMTI 解决能观察哪些 JVM 事件；
- event engine 决定具体如何采样；
- Profiler 后端负责记录和输出。

跨层标注：[JVMTI Agent_OnLoad/Agent_OnAttach——native agent 入口]；[JVMTI capabilities/callbacks——JVM 事件接线]；[VMStructs——HotSpot 内部偏移和方法身份]；[AP-2 Engine——事件引擎消费回调]

## 下一篇：ClassFileLoadHook 与 BytecodeRewriter

下一篇继续展开 JVM 集成里最容易被误读的一条线：ClassFileLoadHook 如何进入 `instrument.cpp`，为什么 async-profiler 需要改写字节码，以及这条改写和 Arthas ByteKit 的关系。

**→ 下一篇：BytecodeRewriter 与 ClassFileLoadHook。**
