# 17 · JVM 生命周期、初始化与退出：深度题目

## 1. JVM 的真正入口为什么不是 `main`，也不是 `JNI_CreateJavaVM`？

从命令行执行 `java MyMain` 到 HotSpot 接管进程控制权，中间为什么必须经过 launcher、JLI、`libjvm.so` 动态加载和 `InvocationFunctions`？

回答必须覆盖：

- `main.c`、`JLI_Launch`、`LoadJavaVM`、`JVMInit` 的职责边界；
- 操作系统进程入口、JDK 启动器入口和 VM 创建入口不是同一层；
- 为什么 VM 不能假设自己一开始就已经被正确链接进进程；
- 启动参数、JRE 路径、VM 类型选择为什么发生在 `JNI_CreateJavaVM` 之前；
- 哪一层第一次拥有“是否继续启动”的决定权。

追问：如果把 launcher 全部挪进 libjvm，会失去哪种部署与版本边界？如果 `LoadJavaVM` 失败，为什么这还不算“JVM 启动失败”，而只是“JVM 尚未被创建”？

源码入口：`src/java.base/share/native/launcher/main.c:97`、`src/java.base/share/native/libjli/java.c:241`、`src/java.base/unix/native/libjli/java_md_solinux.c:553`、`share/prims/jni.cpp:4070`。

## 2. `Threads::create_vm` 为什么像一段“分阶段点亮世界”的脚本？

HotSpot 启动不是一次大构造，而是依次点亮 Universe、解释器、stubs、线程系统、监控、JVMTI/JFR、Java main thread。为什么必须这样分段？

回答必须覆盖：

- 哪些子系统先决于 heap/metaspace，哪些先决于线程或符号表；
- `vm_init_globals`、`universe_init`、`interpreter_init`、`universe2_init`、`javaClasses_init`、`universe_post_init` 这类阶段为什么不能调换；
- VMThread、WatcherThread、ServiceThread 等后台线程的点亮时机；
- “系统已经能分配对象”与“Java 世界已经 fully initialized”之间的区别；
- 启动阶段失败为什么大量使用 `vm_exit_during_initialization` 而不是普通异常传播。

追问：如果把后台线程提前到 Universe 完成前启动，最容易踩坏的是哪种全局状态？如果把 `javaClasses_init` 提前到最小类宇宙建立前，会在哪个依赖上先崩？

源码入口：`share/runtime/thread.cpp:3702`（`Threads::create_vm` 主体）、`share/runtime/init.cpp:90`（`vm_init_globals`）、`share/memory/universe.cpp:675`（`universe_init`）、`share/interpreter/interpreter.cpp:115`（`interpreter_init`）、`share/runtime/thread.cpp:3936`（AttachListener 启动序列）、`share/runtime/java.cpp:681`（`vm_exit_during_initialization`）。

## 3. JVM phase 为什么不是“onload/live/dead 三个标签”这么简单？

从 JVMTI/JFR/线程状态角度看，JVM 启动阶段为什么必须区分 ONLOAD、PRIMORDIAL、START、LIVE 和 DEAD？这些 phase 在保护什么？

回答必须覆盖：

- `Agent_OnLoad`、`post_vm_start`、`post_vm_initialized` 等钩子对应的真实阶段；
- phase 决定哪些事件和能力现在允许发生；
- “JVM 已创建”不等于“应用 main 已安全进入 Java 世界”；
- phase 与类加载、线程创建、工具事件发布之间的顺序关系；
- 为什么 phase 不只是日志标签，而是工具与服务性接口的前置条件。

追问：如果把 START 和 LIVE 混成一个阶段，会让哪类工具接口的时序语义变得含糊？如果 attach agent 试图获得 onload-only 能力，真正撞上的是什么边界？

源码入口：`share/prims/jvmtiExport.cpp:998`、`share/runtime/thread.cpp:4002`、`share/runtime/thread.cpp:4029`、`share/runtime/thread.cpp:4213`。

## 4. 正常退出为什么不能简单做成“最后一个 Java 线程 return 就退出进程”？

JVM 退出前为什么要经过 `before_exit`、shutdown hooks、thread end、JVMTI/JFR 通知、agent unload、守护线程收尾和 VM 销毁，而不是直接 `exit(0)`？

回答必须覆盖：

- “应用逻辑结束”与“JVM 生命周期结束”之间还有哪些资源和协议；
- `before_exit` 为什么要保证只能有一个线程真正执行，其余线程等待；
- shutdown hooks、工具事件、Attach/JVMTI/JFR、周期任务和后台线程的收尾顺序；
- `Threads::shutdown_vm_agents` 和普通 Java shutdown hook 的角色差异；
- 为什么退出路径本身也需要避免死锁和重入。

追问：如果两个线程同时触发退出，为什么不能让它们并行跑清理逻辑？如果跳过 `before_exit` 直接销毁 VM，哪类工具或 agent 最容易留下半状态？

源码入口：`share/runtime/java.cpp:445`、`share/runtime/java.cpp:536`、`share/runtime/thread.cpp:1902`、`share/runtime/thread.hpp:2234`。

## 5. `vm_exit_during_initialization` 和 fatal error 为什么必须分开？

启动期失败和运行期致命崩溃看起来都会终止 JVM。为什么 HotSpot 需要区分“初始化期有序放弃”和“运行期错误处理 + 尽量留证据”两套路径？

回答必须覆盖：

- 启动期哪些基础设施还没完全可用，错误路径不能依赖什么；
- 初始化期失败更多是配置、布局、依赖不满足，而不是堆/线程世界已经运行后的损坏；
- `vm_exit_during_initialization` 与 `VMError::report_and_die` 的目标差异；
- 一个要尽量回到“干净退出或报错退出”，另一个要尽量写出诊断证据；
- 为什么很多启动期错误宁可直接退出，也不尝试“部分继续”。

追问：如果把启动期错误都当 fatal crash 处理，会多付出什么复杂度？如果反过来把运行期 fatal error 也只做初始化式退出，又会失去哪类诊断信息？

源码入口：`share/runtime/java.cpp:649`、`share/runtime/java.cpp:681`、`share/utilities/vmError.cpp:1272`。

## 6. JavaThread/VMThread/WatcherThread/ServiceThread 的点亮顺序在保护什么控制权？

这些线程不是“启动时顺手创建”的后台角色。为什么它们的创建时机本身就是 VM 生命周期协议的一部分？

回答必须覆盖：

- Java main thread 何时才算进入可执行 Java 世界；
- VMThread 在什么时候成为全局操作执行者；
- WatcherThread/ServiceThread 为什么要在特定阶段后才能合法运行；
- 后台线程依赖的 heap、锁、symbol、Attach、PerfData、monitor 或任务表状态；
- 生命周期里“谁当前有资格代表整个 VM 做决定”这件事如何变化。

追问：如果在 AttachListener、PerfData、PeriodicTask 尚未准备好时就让对应线程工作，最容易出现的是空指针、时序竞态还是语义假阳性？

源码入口：`share/runtime/thread.cpp:3828`、`share/runtime/thread.cpp:3936`、`share/runtime/thread.cpp:1453`、`share/services/attachListener.cpp:423`。

## 7. “JVM 死亡”真正意味着哪些状态已经不可逆？

从工具、线程、GC、类元数据和 native 资源角度看，JVM 进入销毁路径后，哪些状态已经不能再恢复？这个边界为什么重要？

回答必须覆盖：

- daemon/non-daemon 线程结束与 destroy_vm 的关系；
- `before_exit` 之后哪些通知和清理已经不可逆；
- VMThread/WatcherThread/ServiceThread 停止后哪些服务能力不再存在；
- `DEAD` phase 对 JVMTI/JFR/Attach 语义意味着什么；
- 为什么“进程还没退出”不等于“JVM 仍然可被当作活 VM 使用”。

追问：如果一个工具在 `before_exit` 之后还尝试 attach 或请求 heap dump，语义上最可能撞在哪一道门？

源码入口：`share/runtime/java.cpp:445`、`share/runtime/thread.hpp:2235`、`share/prims/jvmtiExport.cpp:716`。
