# 17 · JVM 生命周期、初始化与退出：专家答案锚点

## 1. Launcher 只是进程入口，`JNI_CreateJavaVM` 才是 VM 创建入口

操作系统先把控制权交给 launcher；launcher 解决参数预处理（`src/java.base/share/native/launcher/main.c:97`）、JLI 主流程（`src/java.base/share/native/libjli/java.c:241`）、动态加载 `libjvm.so` 与 `InvocationFunctions` 绑定（`src/java.base/unix/native/libjli/java_md_solinux.c:553`），然后才进入 `JNI_CreateJavaVM`（`share/prims/jni.cpp:4070`）。这三层入口不能混为一谈：

- `main` 是操作系统进程入口；
- `JLI_Launch` 是 JDK 启动器协议入口；
- `JNI_CreateJavaVM` 才是 HotSpot 生命周期开启点。

因此 `LoadJavaVM` 失败不应被描述成“JVM 启动失败”，因为严格地说 JVM 还没被创建出来。launcher 的职责是把运行时环境变成一个“可尝试创建 VM”的状态，而不是 VM 本体的一部分。

## 2. `Threads::create_vm` 是按依赖顺序点亮世界

`Threads::create_vm` 不是大构造函数，而是一段启动脚本。它的本质是逐步把“还不能承受并发、还没有完整 Java 世界”的进程，推进到“可以让 Java 主线程和后台线程共同运行”的状态。

顺序之所以重要，是因为：

- heap/metaspace/Universe 先提供物理和逻辑地基（`share/memory/universe.cpp:675` 的 `universe_init`）；
- 解释器、stubs、符号和基础类镜像再提供执行世界的最小骨架（`share/interpreter/interpreter.cpp:115` 的 `interpreter_init`）；
- 后台线程只能在依赖的锁、表、队列和内存区域就绪后启动（`Threads::create_vm` 主体在 `share/runtime/thread.cpp:3702`，AttachListener 启动序列在 `:3936`）；
- fully initialized Java world 与“已经能分配某些对象”不是一回事（`JvmtiExport::enter_start_phase`/`enter_live_phase` 在 `share/runtime/thread.cpp:4002`/`:4029`）。

所以启动阶段到处出现 `vm_exit_during_initialization`，不是保守，而是因为在这个阶段“部分继续运行”通常比直接放弃更危险。

## 3. JVM phase 保护的是工具与运行时时序语义

ONLOAD、PRIMORDIAL、START、LIVE、DEAD 不是装饰性的状态名。它们分别切开：

- agent 能否声明某些能力；
- 事件现在是否允许发布；
- Java 线程、类镜像、解释器入口和后台服务是否已经完整可用；
- 当前 VM 是否还能被当作一个活的 Java 运行时使用。

`JvmtiExport::is_early_phase()`（`share/prims/jvmtiExport.cpp:998`）只对 PRIMORDIAL 之前做“early phase”判定；`enter_onload_phase`/`enter_start_phase`/`enter_live_phase` 分布在 `share/runtime/thread.cpp:4213`/`:4002`/`:4029`。如果把 START/LIVE 等阶段混掉，就会把“VM 已经起来了”和“应用世界已经稳定可观测了”混成一句模糊的话。工具接口真正依赖的是这条时序边界，而不是一个泛泛的“JVM 正在运行”。

## 4. 正常退出的难点不是退出，而是只允许一个线程代表全局执行收尾

`before_exit`（`share/runtime/java.cpp:445`）的关键不是做多少事情，而是**谁有权做**。退出时，JVM 需要保证 shutdown hooks、JVMTI/JFR 通知、agent unload、后台线程终止和 VM 资源清理只按一个全局顺序发生，`Threads::shutdown_vm_agents` 是其中的 agent 收尾步（声明于 `share/runtime/thread.hpp:2234`）。让多个线程并行执行“全局退出”会立刻碰到重入、死锁和重复通知问题。

因此 HotSpot 用一个只允许一次进入的退出协议：一个线程执行真正的 `before_exit`，其余线程等待结果。这保证“JVM 退出”在语义上仍然是一件单线程全局动作，而不是多个局部线程各自打扫自己的一亩三分地。

## 5. 初始化期失败与运行期 fatal error 的目标根本不同

`vm_exit_during_initialization`（`share/runtime/java.cpp:649`、`:681`）处理的是“世界还没完全搭好时，发现前提不成立”的失败：参数、内存布局、共享归档、类布局、模块状态、基础库加载等。此时应该尽早、明确地放弃，不去假装 JVM 还能部分继续。

运行期 fatal error（`VMError::report_and_die`，`share/utilities/vmError.cpp:1272`）则发生在 VM 已经活起来、线程/堆/代码/工具都可能处于不一致或损坏状态之后。此时最重要的目标不是优雅退出，而是尽量留下诊断证据：寄存器、线程栈、CodeCache、信号、内存上下文。

所以前者是“有序放弃启动”，后者是“故障现场保全”。把两者混成同一条错误路径，会要么损失诊断证据，要么在初始化期引入没有必要的崩溃处理复杂度。

## 6. 线程点亮顺序定义了“谁此刻代表整个 VM”

Java main thread、VMThread、WatcherThread、ServiceThread 不是并排被创建的后台角色；它们按顺序获得不同的控制权：

- launcher/JNI 创建期，控制权还在本地启动器与主创建线程；
- VMThread 就绪后，才有统一的全局 VM operation 执行者；
- Java main thread 进入后，用户 Java 世界才真正开始；
- WatcherThread/ServiceThread 启动后，周期任务、延迟任务和服务性工作才成为运行时常态。

因此线程创建顺序本质上是在回答：**当前是谁有资格代表整个 VM 做全局决定**。如果这个顺序乱了，不是“后台线程晚一点工作”这么简单，而可能是让某个线程在所依赖的世界尚未存在时先行动。

## 7. JVM 进入 destroy 路径后，很多能力已经不可逆地失效

“进程还在”不等于“JVM 还活着”。一旦进入 `before_exit`/`destroy_vm` 路径，至少有三类不可逆变化：

1. 生命周期语义已经从“正常运行”切到“清理退出”（`before_exit` 在 `share/runtime/java.cpp:445`，`post_vm_death` 设 phase 为 DEAD 在 `share/prims/jvmtiExport.cpp:716`）；
2. 服务线程和工具入口可能已被停止或不再保证一致性；
3. phase 已走向 DEAD，许多 JVMTI/JFR/Attach 行为不再合法。

这就是为什么面试中不能把“只要 PID 还在就还能 attach/heap dump/jstack”当作默认前提。JVM 的死亡是语义死亡，不只是进程最后一条指令尚未退出。

## 评分锚点

- **合格**：能把 launcher、VM 创建、初始化、正常退出、fatal error 区分开。
- **良好**：能讲清 `Threads::create_vm` 的分阶段点亮和 `before_exit` 的单线程全局语义。
- **专家级**：能用“控制权在谁手里、世界当前是否足够稳定、哪些状态已经不可逆”这条主线，把启动、phase、线程点亮和退出路径贯穿起来。
