# PROMPT: 请撰写 09-JVM-JavaThread-System.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**"守护者"全景 — 10 个系统 JavaThread 的创建入口、C++/Java 调度循环与死亡后果**

### 核心故事线（禁止做源码翻译机！）

前四篇文章 [05][06][07][08] 已经覆盖了线程全景、JavaThread 生命周期、VMThread 事件循环、WorkerThread 并行军团。现在要回答一个面试级的问题：**除了你 `new Thread().start()` 创建的应用线程，JVM 自己还悄悄创建了哪些 JavaThread？**

用户运行一个最小 JVM（只有 `main()` 里 `synchronized(new Object())`），`jstack` 一看 — 17 个线程！除了 NonJavaThread 那 7 个（VMThread / GC Worker / ConcurrentGC），还有 10 个 JavaThread。这篇文章的任务就是对这 10 条线程逐条深度分析。

**本文的核心叙事线**是一条追问链：

1. **startup 4 线程为什么在 `Threads::create_vm()` 中创建？**— 它们的创建顺序有没有约束？Finalizer 为什么必须在 ReferenceHandler 之后？为什么 main 是唯一 non-daemon？
2. **runtime 6 线程为什么延迟创建？**— 都不创建行不行？CompilerThread 不创建 = 纯解释执行但程序不崩；ReferenceHandler 不创建 = Reference 不到达 → OOM
3. **CompilerThread 为何在 JavaThread 分支？**— 编译器线程明明是"系统线程"，为什么不是 NonJavaThread？本质原因是「访问 Java 堆的权利 = 必须参与 safepoint」
4. **ServiceThread 挂了有自愈机制？**— VMThread 挂了 JVM 死，Worker 挂了 GC hang，ServiceThread 挂了能自动重新创建 → 为什么？怎么做到的？
5. **每条线程的 daemon 标记 + 死亡后果**— main 是唯一 non-daemon → main 返回 → JVM exit → 其他线程被通知终止。如果 AttachListener 悄悄死了 → jcmd 连不上但不影响 JVM

### 禁止行为

- ❌ 把 10 条线程写成"定义 + 用途"的流水账 — 这是博客水平，不是 P9
- ❌ 罗列函数调用链不解释设计意图
- ❌ 忽略线程的鲁棒性 — "挂了怎么办" 是面试高频追问
- ❌ 忽略分类理由 — 为什么 CompilerThread 归 JavaThread 而 WatcherThread 归 NonJavaThread？

### 要求行为

- ✅ 每条线程回答 6 个问题：创建入口(文件:行号)、Java 入口(方法名)、C++ 循环(如有)、daemon 标记、死亡后果、分类理由
- ✅ **核心对比线**：CompilerThread(JavaThread) vs WatcherThread(NonJavaThread) — "访问 Java 堆的权利 = safepoint 的负担"
- ✅ startup 4 线程的创建顺序约束 + 为什么顺序不能乱
- ✅ 全链路 jstack 实战对照（理论 vs GDB 验证）
- ✅ 交叉引用 [05][06][07][08] 的相关概念（继承链、lifecycle、safepoint 行为、WorkGang）

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- **默认 mixed mode**（解释器 + C1/C2 JIT，Tiered Compilation 开启）
  对比 `-Xint` 纯解释模式: CompilerThread + Sweeper 不会创建，10 线程 → 8 线程
- 64 位 Linux x86

## 三、聚焦源文件

| # | 文件 | 完整路径 | source_index | 核心类/函数 | 本文角色 |
|---|------|---------|-------------|------------|---------|
| 1 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | 02-runtime:#126 | `Threads::create_vm()` | ★ startup 4 线程的创建入口 — 搜索所有 `new JavaThread` |
| 2 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | 02-runtime:#127 | `JavaThread` / `Threads::_thread_list` | ★ 类定义 + `JavaThreadState` + `_daemon` 字段映射 |
| 3 | `jvm.cpp` | `src/hotspot/share/prims/jvm.cpp` | 09-prims:#12 | `JVM_StartThread()` | `new Thread().start()` 的 JVM 层入口 |
| 4 | `serviceThread.cpp/.hpp` | `src/hotspot/share/runtime/serviceThread.cpp` | 02-runtime:#101 | `ServiceThread::service_thread_entry()` | ★ 低内存检测 + JNI 周期检查 |
| 5 | `compileBroker.cpp` | `src/hotspot/share/compiler/compileBroker.cpp` | 07-compiler:#7 | `CompileBroker::compiler_thread_loop()` | ★ C1/C2 编译线程的调度循环 |
| 6 | `compilerThread.cpp/.hpp` | `src/hotspot/share/compiler/compilerThread.cpp` | 07-compiler:#9 | `CompilerThread` 类定义 | ★ CompilerThread 构造函数 — 4MB stack 设置位置 |
| 7 | `codeCacheSweeperThread.cpp` | `src/hotspot/share/runtime/codeCacheSweeperThread.cpp` | 02-runtime:#2109 | `CodeCacheSweeperThread::run()` | 清理 zombie/not_entrant nmethod |
| 8 | `signalDispatcher.hpp` | `src/hotspot/share/runtime/signalDispatcher.hpp` | 02-runtime:#105 | `SignalDispatcher` | 信号分发线程 — 类定义 |
| 9 | `attachListener.cpp` | `src/hotspot/share/services/attachListener.cpp` | 10-services:#2 | `AttachListener::attach_listener_thread_entry()` | ★ jcmd/jstack/jmap 连接入口 + UNIX socket |
| 10 | `referenceProcessor.cpp/.hpp` | `src/hotspot/share/gc/shared/referenceProcessor.cpp` | 06-gc:#118 | `ReferenceProcessor::process_discovered_references()` | ReferenceHandler 的引用处理逻辑 |
| 11 | `javaClasses.cpp/.hpp` | `src/hotspot/share/runtime/javaClasses.cpp` | 02-runtime:#41 | `java_lang_Thread` | Java Thread 对象的字段映射 — `threadStatus` / `daemon` |
| 12 | `os/linux/os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | 12-os-cpu:#12 | `os::create_thread()` | OS 线程创建 — 4 种 `ThreadType` 与 stack_size 对应 |

## 四、必须深度走读的核心概念

> ★★★ **读码顺序铁律**（违反必翻车）:
> 1. 先读 `thread.cpp` — 搜索 `Threads::create_vm()` 中所有 `new JavaThread` 出现位置
> 2. 再逐个追踪每条线程的 Java 入口方法（`java_lang_Thread` 映射 + `JVM_StartThread` 入口）
> 3. 对有 C++ 循环的线程，先读 `.hpp`（类定义）→ 再读 `.cpp`（`run()` 实现）
> 4. ★ 先在 create_vm 中穷举完所有线程 → 再在 runtime 创建中补全 → 最后 jstack 验证

### 4.1 10 线程总览 — 创建时机 + 生命周期

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   10 个系统 JavaThread 全景                                   │
├─────────────────┬──────────────┬──────────┬──────────┬──────────────────────┤
│ 线程名 (jstack)  │ 创建时机      │ daemon   │ 有 C++    │ 挂了后果             │
│                 │              │          │ 循环?     │                     │
├─────────────────┼──────────────┼──────────┼──────────┼──────────────────────┤
│ main            │ create_vm    │ false ★  │ 否       │ JVM exit            │
│ ReferenceHandler│ create_vm    │ true     │ 否       │ Ref 泄漏 → OOM      │
│ Finalizer       │ create_vm    │ true     │ 否       │ finalize 不执行      │
│ SignalDispatcher│ create_vm    │ true     │ 否       │ SIGINT 无响应        │
│ ServiceThread   │ create_vm 尾 │ true     │ 是       │ 需验证: 自愈或挂掉?  │
│ C2 CompilerThr0 │ 首次 JIT     │ true     │ 是       │ 纯解释，不崩溃       │
│ C1 CompilerThr0 │ 首次 JIT     │ true     │ 是       │ 纯解释，不崩溃       │
│ Sweeper thread  │ NMthdSweeper │ true     │ 是       │ 僵尸 nmethod 累积    │
│                 │ ::start()    │          │          │ CodeCache 满→JIT停止 │
│ Common-Cleaner  │ JDK 9+ 内置  │ true     │ 否       │ DirectBuf泄漏(fallback│
│ Attach Listener │ 首次 jcmd    │ true     │ 否       │ jcmd 连不上          │
└─────────────────┴──────────────┴──────────┴──────────┴──────────────────────┘
```

### 4.2 startup 4 线程 — `Threads::create_vm()` 中顺序创建

```
★★★ 创建顺序约束链:

Threads::create_vm():
  │
  ├─ 1. main → new JavaThread("main") → 执行 main() 方法
  │     ★ main 是唯一 non-daemon → main 返回 → JVM exit
  │     ★ 不是通过 JVM_StartThread 创建，是在 create_vm 末尾直接创建并启动
  │
  ├─ 2. ReferenceHandler → JVM_StartThread(ReferenceHandler$ReferenceHandler)
  │     Java 入口: ReferenceHandler.run()
  │       → 死循环: ReferenceQueue.removeLocked() → processPendingReferences()
  │     ★ 为什么先于 Finalizer? → Finalizer 依赖 ReferenceHandler 先完成 Reference 入队
  │     ★ 为什么是 JavaThread? → 全 Java 实现，无 C++ 特殊逻辑
  │     挂了: SoftRef 永远不入队 → IndirectBuffer 泄漏 → Native OOM!
  │
  ├─ 3. Finalizer → JVM_StartThread(Finalizer$FinalizerThread)
  │     Java 入口: FinalizerThread.run()
  │       → 死循环: ReferenceQueue.remove() → obj.finalize()
  │     ★ JDK 9+ 已用 Cleaner 渐取代 — 更可控
  │     挂了: finalize() 永不调用 → 但 Cleaner 已接管大部分职责
  │
  └─ 4. SignalDispatcher → os::signal_init() → 创建 + start
        Java 入口: waitForSignal() → signalArrived() → dispatch()
        ★ 为什么是 JavaThread? 
          → `sun.misc.Signal.handle()` 在 Java 层注册回调 → native 层 os::signal()
          捕获到信号后 → 通过 SignalDispatcher 线程分发 → 调用 Java 层的
          `Signal.dispatch()` → 最终执行用户注册的 `SignalHandler.handle()`。
          这条调用链需要 Java 栈帧 → JNI HandleBlock → Java 调用约定
          → 必须继承 JavaThread（不能是 NonJavaThread，因为没有 Java 栈帧）。
          → 同等原因也适用于 ShutdownHook: `Runtime.addShutdownHook()` 注册的
          Java 线程也需要 SignalDispatcher 在收到 SIGTERM 后触发。
        挂了: Ctrl+C/SIGTERM 无响应 → 必须 kill -9

❓ 为什么 main 是唯一 non-daemon？
   → daemon 标记存储在 java.lang.Thread._daemon 字段（javaClasses 映射到 C++）
   → main 方法不需要显式 setDaemon(false) — 默认创建就是 false
   → 所有其他系统 JavaThread 在 JVM_StartThread 后显式 setDaemon(true)
   → JVM 退出条件: 所有 non-daemon JavaThread 都死亡 → destroy_vm

❓ 为什么 ReferenceHandler 必须在 Finalizer 之前创建？
   → 创建顺序 = start 顺序（pthread_create 即 start）
   → ReferenceHandler 先把 Reference 从 pending list 入队到各自的 ReferenceQueue
   → Finalizer 从 FinalizerReferenceQueue 中取 Reference → 调用 finalize()
   → 如果 Finalizer 先启动 → 队列为空 → 空转 → 等 ReferenceHandler 入队后才能工作
   → 但这个"错误顺序"不会导致崩溃 — 只是因为入队没完成而多空转几个周期
```

### 4.3 runtime 6 线程 — 延迟创建 + 按需创建

```
⑤ ServiceThread — 自愈机制的金丝雀

  创建: Threads::create_vm() 尾部 → new ServiceThread()
  循环 (serviceThread.cpp):
    service_thread_entry() → 主循环 → 周期执行:
      - check_for_jvmti_events()
      - low_memory_detection()      ← 检查 Java 堆
      - jni_periodic_check()
      - triggered_task 等
    每次循环 sleep(ServiceThreadSleepTime)
  ★ 为什么是 JavaThread?
    → low_memory_detection 需要创建 Java OutOfMemoryError 对象
    → 对象在 Java 堆上 → 需要访问堆
  ★ 自愈机制（需验证源码）:
    ServiceThread 是 10 条线程中在 `create_vm()` 尾部通过 `ServiceThread::start()` 启动的。
    ★ 关键问题: 如果 ServiceThread 在处理 OOP 时 crash，JVM 是否能自动重新创建?
    → 需要验证 `ServiceThread` 源码中是否真的有"检测死亡→重新创建"的逻辑，
    还是只是 `start()` 被调用一次后靠 `service_thread_entry()` 内部循环保证存活。
    → 提示: `Threads::create_vm()` 中可能只调用一次 `ServiceThread::start()`，
    没有独立的 watchdog 做重启。如果有自愈机制，应该在 `ServiceThread` 类中搜索
    `restart` / `recreate` / `start` 的调用位置。
    → 对比: WorkerThread 的 crash 会导致 GC hang（[08 §五]），因为 signal_task_done()
    不会被调用。ServiceThread 的 crash 后果需要按源码实际情况描述，不可推测。

⑥⑦ C1/C2 CompilerThread

  默认数量: Tiered Compilation 开启 → C1 × 1 + C2 × 1（JDK 8+ 默认）
          单 C2 模式（-XX:-TieredCompilation）→ C2 × 1
          可通过 -XX:CICompilerCount=N 调整
  创建: 第一次 JIT 编译时 → CompileBroker::init_compiler_threads()
  创建代码位置: compilerThread.cpp → CompilerThread 构造函数中设置 stack_size
  循环 (compileBroker.cpp):
    compiler_thread_loop():
      while (!_terminating) {
        CompileTask* task = compile_queue()->get();  // 从 CompileQueue 取
        if (task == NULL) { wait/sleep; continue; }
        task->compile();  // C1 或 C2 编译
      }
  ★ 为什么是 JavaThread? → ★★★ 本文最核心的对比点
    CompilerThread 需要访问:
      - 类元数据 (InstanceKlass) → 在 Java 堆上
      - 常量池 (ConstantPool) → 在 Java 堆上
      - 方法数据 (Method/MethodData) → 在 Java 堆上
    → GC 期间这些数据可能被移动（Evacuation / Compaction）
    → 如果 CompilerThread 是 NonJavaThread:
        → GC 移动对象 → CompilerThread 持有 dangling pointer → CRASH
    → 所以 CompilerThread 必须是 JavaThread:
        → GC 前被 safepoint 暂停 → GC 完成后恢复 → 永远不会看到移动中的对象
    → 代价: 编译期间可能被 GC 卡住（但优先保证正确性）

  ★ OS 线程类型: os::compiler_thread → stack_size = 4MB (compiler_thread)
    对比: 其他 9 条系统 JavaThread 用 os::java_thread → stack_size = 1MB
    为什么 CompilerThread 要 4MB? → 编译器栈帧深:
      - IR 构建（理想图 IdealGraph → 递归遍历）
      - 寄存器分配（Chaitin-Briggs 图着色 → 深度优先遍历）
      - 内联分析（递归展开虚方法调用链）

⑧ Sweeper (CodeCacheSweeperThread)

  创建: NMethodSweeper::start() 在 create_vm 末尾或按需
  循环:
    while (!_stop) {
      _sweeper_started.wait();  // 被通知才开始扫
      CodeCache::sweeper()->sweep();  // 遍历 nmethod, 清理 zombie
      _sweeper_started.set(0);
    }
  ★ 为什么是 JavaThread? → 同 CompilerThread — 需要访问类元数据/方法数据
    被困在 JavaThread 分支的"系统线程" — 看似"内部", 实则因堆访问权被归入 Java
  挂了: zombie nmethod 累积 → CodeCache 满 → JIT 停止 → 纯解释 → 性能退化

⑨ Common-Cleaner (JDK 9+)

  创建: JDK 层 → Cleaner 机制驱动 (java.lang.ref.Cleaner)
  Java 入口: Cleanable.clean() 死循环
  daemon: true
  挂了: DirectByteBuffer 泄漏 → Cleaner 挂了后，DirectByteBuffer 分配失败时
    会触发 fallback: `java.nio.Bits.reserveMemory()` → `System.gc()` 尝试回收，
    但这是最后手段，正常情况下不该依赖 fallback。
    → 源码定位: `java.base/java/nio/Bits.java:reserveMemory()`
  ★ 为什么新增? → 替代 Finalizer:
    - Finalizer 不可控（用户重写 finalize() 可能卡住或抛异常）
    - Cleaner 是显式注册的 Runnable → 生命周期可管理
    - Cleaner 用的是 PhantomReference，不是 FinalReference

⑩ AttachListener

  创建: 首次 jcmd/jstack 连接 → AttachListener::init()
  循环:
    attach_listener_thread_entry():
      while (!_terminating) {
        fd = accept();              // UNIX socket accept
        if (fd < 0) continue;
        execute_command(fd);        // jcmd/jstack/jmap 命令解析+执行
      }
  ★ 为什么是 JavaThread? → jcmd 命令执行时需要触发 VMOperation (线程 dump 等)
    → 需要在 JavaThread 上下文中才能正确切换线程状态
  挂了: jcmd 连不上 → 不影响 JVM 核心功能 → 超时后重新创建
  可以单独终止: attach_listener_thread 可被 OOM 等终止 → 不影响 JVM
```

### 4.4 核心对比线 — CompilerThread vs WatcherThread

```
★★★ 为什么 CompilerThread 归 JavaThread 而 WatcherThread 归 NonJavaThread?

┌─────────────────────┬──────────────────────┬───────────────────────────┐
│ 维度                  │ CompilerThread       │ WatcherThread              │
│                      │ (JavaThread)         │ (NonJavaThread)            │
├─────────────────────┼──────────────────────┼───────────────────────────┤
│ 访问 Java 堆          │ ★ 是 — 类元数据/常量池│ 否 — 只访问 JVM C heap    │
│ safepoint 行为        │ ★ 被暂停 — 必须停止   │ 不受影响 — 继续执行        │
│ _thread_list 上?      │ ★ 是 — ThreadSMR 保护│ 否 — 自行管理              │
│ 执行 Java 代码        │ 否 — 全 C++ 代码    │ 否 — 全 C++ 代码           │
│ 分类的本质原因         │ "需要访问 Java 堆"    │ "不需要，避免被 GC 卡住"    │
│ 守护标记              │ Java daemon          │ 不适用                    │
│ 挂了                  │ 纯解释(不崩溃)        │ PeriodicTask 不执行         │
│ stack_size            │ 4MB (compiler_thread)│ 512KB (watcher_thread)     │
└─────────────────────┴──────────────────────┴───────────────────────────┘

❓ 核心认知:
  一个线程归 JavaThread 还是 NonJavaThread，不取决于"是不是系统线程"，
  而取决于「是否需要访问 Java 堆」。
  CompilerThread 和 Sweeper 虽然是 JVM 自己创建的"系统线程"，
  但它们的 C++ 代码需要读取 InstanceKlass/ConstantPool/MethodData，
  这些都在 Java 堆上。GC 期间堆对象会被移动 — 如果它们是 NonJavaThread，
  就会持有 dangling pointer。
  所以它们被迫继承 JavaThread — 获得「堆访问权」的代价是「被 safepoint 暂停的负担」。
```

### 4.5 ThreadType 与 stack_size — 同样是 JavaThread，栈大小差 4 倍

```
★★★ os::create_thread() 的 4 种 ThreadType:

┌──────────────────────┬────────────┬──────────────┬────────────────────┐
│ ThreadType            │ stack_size │ 使用者        │ 为什么这个大小      │
├──────────────────────┼────────────┼──────────────┼────────────────────┤
│ os::java_thread      │ 1MB        │ 9/10 系统      │ 普通 Java 代码     │
│                      │            │ JavaThread     │ 不需要深层递归     │
│ os::compiler_thread  │ 4MB ★      │ CompilerThread │ IR构建 + 寄存器分配│
│                      │            │                │ 递归深度可达数百帧  │
│ os::gc_thread        │ 512KB      │ GC Worker      │ [08] 纯 C++ 代码  │
│                      │            │ (NonJavaThread)│ 无 Java 栈帧       │
│ os::watcher_thread   │ 512KB      │ WatcherThread  │ [10] 纯 C++ 定时   │
│                      │            │ (NonJavaThread)│ 简单调用栈          │
└──────────────────────┴────────────┴──────────────┴────────────────────┘

★ 同一个 JavaThread 类，栈大小由 ThreadType 决定 — 不是由「是不是 JavaThread」决定!
  → 在 CompilerThread 构造函数中传入 os::compiler_thread → 4MB
  → 在 JVM_StartThread 中传入 os::java_thread → 1MB
  → 这是一个容易被忽略的设计差异 — 面试追问："JavaThread 栈大小默认多少?"
    → 错误答案: 1MB → 正确答案: 取决于 ThreadType! CompilerThread 是 4MB。
```

### 4.6 jstack 线程名 ↔ prompt 简称映射

```
★★★ §一开头必须直接贴 jstack 输出，然后再用简称分析:

jstack 输出 (minimal JVM, 8GB, G1GC, mixed mode):
┌──────┬───────────────────────────────┬──────────────┐
│ #    │ jstack 线程名                   │ 分类          │
├──────┼───────────────────────────────┼──────────────┤
│ #1   │ "main"                        │ startup       │
│ #2   │ "Reference Handler"           │ startup       │
│ #3   │ "Finalizer"                   │ startup       │
│ #4   │ "Signal Dispatcher"           │ startup       │
│ #5   │ "Service Thread"              │ runtime       │
│ #6   │ "C2 CompilerThread0"          │ runtime       │
│ #7   │ "C1 CompilerThread0"          │ runtime       │
│ #8   │ "Sweeper thread"              │ runtime       │
│ #9   │ "Common-Cleaner"              │ runtime       │
│ #10  │ "Attach Listener"             │ runtime       │
└──────┴───────────────────────────────┴──────────────┘

此后全文可用简称 (main, RefHandler, Finalizer, SigDispatcher,
ServiceThread, C2/C1, Sweeper, Cleaner, AttachListener)。

### 4.7 daemon 标记 + JVM 退出协议

```
★★★ JVM 退出条件:
  JVM 启动后，所有 non-daemon JavaThread 全部死亡 → destroy_vm → JVM exit

  main 是唯一 non-daemon:
    main() 返回 → JavaThread::exit():
      → Threads::remove() → 检查 remaining non-daemon count
      → remaining == 0 → 触发 destroy_vm:
        → 通知所有守护线程 (daemon JavaThread + NonJavaThread)
        → WatcherThread::stop() → _should_terminate = true
        → WorkerThread::stop() → _should_terminate = true
        → G1ConcurrentMarkThread::stop() → _should_terminate = true
        → ...
        → 等所有线程退出 → _exit(0)

❓ 如果 main 线程死循环不退出怎么办?
  → JVM 永不退出（即使其他 daemon 线程都已结束）
  → 需要 kill -9 强制终止 → 这是用户代码的 bug，不是 JVM 的问题

❓ 为什么其他 9 条线程是 daemon？
  → 它们的存在是为了"服务"JVM 的生命周期 — JVM 退出时它们不需要被显式等待
  → 如果它们是 non-daemon → main 返回后 JVM 等它们全部死完 → 永远不退出
    （比如 AttachListener 永远在 accept 阻塞）

❓ daemon 标记存储在哪里？
  → java.lang.Thread._daemon (Java 字段)
  → 通过 java_lang_Thread::is_daemon(thread) 在 C++ 层访问
  → JVM_StartThread 中: set_daemon(thread) → 设置 _daemon = true
  → 对于直接 new JavaThread("main") 的场景: _daemon 默认 false
```

## 五、文章结构

```
§〇 源文件清单（跨 runtime/compiler/services/gc/prims/classfile）
  → 搜索不到时回退到 source_index/ 索引

§一 10 线程全景图
  ★ 开头即贴 jstack 实测输出（见 §4.6 表格）→ 每个线程名溯源到 create_vm 源码
  ❓ 为什么需要"系统 JavaThread"？
  ❓ 10 条线程怎么被发现的？(jstack 输出 → 溯源源码)
  1.1 创建时机矩阵: startup 4 + runtime 6
  1.2 daemon 标记总表: main 唯一 non-daemon → JVM exit 协议
  1.3 ThreadType 全景: 同样是 JavaThread，栈 1MB vs 4MB 怎么决定？
  1.4 为什么 CompilerThread/Sweeper 虽然是"系统线程"却是 JavaThread？

§二 startup 4 线程 — Threads::create_vm() 走读
  ❓ 创建顺序有约束吗？Finalizer 必须在 ReferenceHandler 之后？
  2.1 main: 唯一 non-daemon，JVM exit 的触发器
  2.2 ReferenceHandler: ReferenceQueue 消费者，挂了 → OOM
  2.3 Finalizer: finalize() 执行器，JDK 9+ 被 Cleaner 替代
  2.4 SignalDispatcher: 信号分发，挂了 → Ctrl+C 无响应
  2.5 ★ 创建顺序约束分析

§三 runtime 6 线程 — 延迟/按需创建
  ❓ 都不创建行不行？
  3.1 ServiceThread: 自愈机制 — 挂了自动重建
  3.2 C1/C2 CompilerThread: ★ 为什么是 JavaThread？— 堆访问权
  3.3 Sweeper: 被"冤枉"为 JavaThread 的扫雪工
  3.4 Common-Cleaner: JDK 9+ Finalizer 替代品
  3.5 AttachListener: UNIX socket → jcmd 命令解析

§四 ★ 核心对比线 — CompilerThread vs WatcherThread
  ❓ 两条"系统线程"，一条归 JavaThread、一条归 NonJavaThread — 凭什么？
  4.1 堆访问权 = safepoint 的负担 — 这是一个 tradeoff
  4.2 如果 CompilerThread 是 NonJavaThread → GC 期间访问移动中的对象 → crash
  4.3 如果 WatcherThread 是 JavaThread → GC 卡住 PeriodicTask → 定时任务不准

§五 死亡后果分析矩阵
  ❓ 10 条线程各自挂了有什么影响？
  5.1 致命死亡: main → JVM exit
  5.2 功能退化: ReferenceHandler 死 → OOM; Sweeper 死 → CodeCache 满
  5.3 无感死亡: AttachListener 死 → jcmd 连不上 (可重新创建)
  5.4 自愈: ServiceThread 死 → 自动重建
  5.5 不可用: CompilerThread 死 → 纯解释 (性能退化但不崩溃)

§六 GDB 验证 + 可证伪断言（≥8 条，每条含命令 + 预期值）

  断言 1 — 验证 create_vm 中 startup 线程创建次数:
    (gdb) break Threads::create_vm
    → 单步搜索每次 new JavaThread 调用 → 预期: 4-5 次
    （main + ReferenceHandler + Finalizer + SignalDispatcher + ServiceThread）

  断言 2 — 验证 daemon 标记:
    (gdb) p java_lang_Thread::is_daemon(main_thread->threadObj())
    → 预期: false
    (gdb) p java_lang_Thread::is_daemon(referenceHandler->threadObj())
    → 预期: true

  断言 3 — 验证 CompilerThread stack_size:
    (gdb) break CompilerThread::CompilerThread
    (gdb) p stack_size
    → 预期: 4 * 1024 * 1024 = 4194304 (4MB)

  断言 4 — 验证 _thread_list 上全是 JavaThread:
    (gdb) p Threads::_thread_list
    → 遍历 _next 链 → 预期: 约 10 个 JavaThread, 名字以 §4.6 表格为准
    (gdb) p Threads::number_of_threads()
    → 预期: ≈10（不含 NonJavaThread）

  断言 5 — 验证 -Xint 下 CompilerThread 不存在:
    (gdb) break CompileBroker::compiler_thread_loop
    → 用 -Xint 启动 → 预期: 断点永不触发

  断言 6 — 验证 ThreadType enum 值:
    (gdb) p /d os::java_thread
    → 预期: 0 (或枚举第一个值)
    (gdb) p /d os::compiler_thread
    → 预期: 与前一个不同

  断言 7 — 验证 Cleaner 和 Finalizer 共存:
    JDK 9+ 下用 -XX:-Finalize (禁用 Finalizer) → jstack 输出只有 Cleaner 无 Finalizer

  断言 8 — 验证 AttachListener 延迟创建:
    (gdb) break AttachListener::init
    → 启动 JVM 后不执行 jcmd → 预期: 断点不触发
    → 执行 jcmd → 预期: 断点触发
```

## 六、写作要求

1. **枚举完整性**: 穷举全部 10 条线程，不允许遗漏
2. **6 问题标配**: 每条线程必须回答创建入口、Java 入口、C++ 循环、daemon、死亡后果、分类理由
3. **★ 核心对比线**: CompilerThread(JavaThread) vs WatcherThread(NonJavaThread) — 回答"凭什么分类不同"
4. **鲁棒性优先**: "挂了会怎样"是面试高频追问 — 每条线程必须有死亡后果分析
5. **创建顺序约束**: startup 4 线程的创建顺序不是偶然的 — 要分析依赖关系
6. **jstack 实战对照**: §一用 jstack 实测输出作为开头 → 每个线程名溯源到源码
7. **交叉引用**: [05] 继承链 + daemon 字段, [06] 线程分类全景, [07][08] NonJavaThread 对比

## 七、输出格式

- Markdown 文件，命名为 `09-JVM-JavaThread-System.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 [06][05] + 关联 [07][08] + 阅读收益）
