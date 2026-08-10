# PROMPT: 请撰写 14-JVM-CompilerThread.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**"方法为什么能越跑越快？" — C1/C2 CompilerThread + CodeCacheSweeperThread 的 Tiered 编译全周期**

### 核心故事线（禁止做源码翻译机！）

前十三篇文章已经覆盖了锁膨胀 [01-04]、线程架构 [05-06]、VMThread [07]、WorkerThread [08]、10 个 JavaThread [09]、NonJavaThread [10]、AttachListener [11]、ServiceThread [12]、ReferenceHandler+Finalizer [13]。在 [09] 的 jstack 输出中，你见到了 `"C1 CompilerThread0"` 和 `"C2 CompilerThread0"`——它们是**按需创建**的 JavaThread，stack=4MB（四倍于普通线程），优先级 NearMaxPriority 或 CriticalPriority，daemon=true。

现在要回答一个面试级问题：**Java 程序运行一段时间后，为什么变快了？**

答案不是"JIT 编译"四个字——这等于没说。真正的问题是：

1. **谁"决定"编译哪个方法？**— 不是靠计时器或者定时扫描。HotSpot 维护了两套计数器，都在 `MethodCounters` 对象中（不是 `MethodData`！）：`_invocation_counter` 记录方法被调用的次数，`_backedge_counter` 记录循环回边的次数。两者由解释器在每次方法入口/循环回边时**原子递增**。当 `_invocation_counter` 超过 `CompileThreshold`（Tiered 模式下由 `AdvancedThresholdPolicy` 接管），触发标准编译；当 `_backedge_counter` 超过 `OnStackReplacePercentage` 相关的阈值，触发 **OSR 编译**——只编译当前循环体而不等下次方法调用。`MethodCounters` 是一个独立于 `MethodData` 的对象——前者管计数、后者管 profiling 类型数据。

2. **C1 和 C2 为什么不是一条线程？**— C1（Client Compiler）追求**最低启动延迟**，C2（Server Compiler）追求**最高峰值性能**。如果它们共享一条线程，C2 编译一个复杂方法可能花几秒钟，期间 C1 无法编译任何新方法 → 启动阶段严重卡顿。两条线程的本质是**时延敏感型（C1）vs 吞吐优先型（C2）的分离**——这是 Tiered Compilation 的核心设计。

3. **★★★ Tiered Compilation 为什么是 0→3→4，不是 0→1→2→3→4？**— 默认路径跳过了 Level 1 和 Level 2，直接 Level 0（解释器）→ Level 3（C1 + 完整 profiling）→ Level 4（C2 基于 profiling 数据深度优化）。为什么 Level 1 和 2 被跳过？因为 `TieredStopAtLevel=4` 下的默认策略认为：Level 3 的 profiling 数据质量最高，C2 可以直接利用 C1 的 profiling feedback 做激进优化（内联、去虚化、逃逸分析）。Level 1 和 2 只在分层降级或特殊配置时使用。

4. **★ profiling 数据记在什么地方？**— 不是在 C1 线程的堆栈上！Profiling 数据存储在 `MethodData` 对象中——这是 Java 堆上的一个特殊对象，每个方法在 TLAB 中分配。C1 编译方法时在生成的机器码中嵌入 counter 自增指令；C2 编译时读取这些 counter 做决策。所以**C1 的"输出"不仅是机器码，还有一个装满 profiling 数据的 MethodData 对象**——这是 C2 的"输入"。

5. **★★ CodeCacheSweeperThread 为什么必须是独立线程？**— nmethod（编译产物）有三种死亡状态：`in_use → not_entrant → zombie`。当一个类被卸载或方法被重新编译时，旧的 nmethod 先标记为 `not_entrant`（不再接受新调用），等待所有正在执行的调用栈退出后，Sweeper 将其标记为 `zombie`，然后释放 CodeCache 空间。如果编译器线程自己负责清理 → 编译线程阻塞 → 新方法无法编译 → 性能退化。SweeperThread 的核心价值是**GC 式的异步清理**。

6. **★★ 编译器线程和 GC 线程之间有什么隐式交互？**— 编译器必须读取 Java 堆上的 `Method`、`ConstantPool`、`InstanceKlass` 等对象。这些对象在 GC 期间可能移动（如 Full GC 的 compact 阶段）。所以编译器线程**必须是 JavaThread**——它必须参与 safepoint：当 GC 发起 safepoint 时，CompilerThread 在 safepoint poll 处停下（在 `compiler_thread_loop` 的 `maybe_block()` 中检查），等 GC 完成后再继续编译。它的栈大小（4MB）是为了容纳深度内联后的复杂编译。

7. **Method 的整个生命周期**：从"出生"（ClassLoader 加载 `Method` 对象）→ "婴幼儿期"（解释器执行，MethodData 为空）→ "成长期"（C1 编译，MethodData 记录 profiling）→ "巅峰期"（C2 基于 profiling 深度优化，deoptimization 回退）→ "衰老期"（not_entrant → zombie → CodeCache 清理）。每一条路径的背后都是 CompilerThread 和 SweeperThread 的协作。

8. **为什么 jstack 中 CompilerThread 占两条（C1 + C2）？**— Tiered 模式下根据 `CICompilerCount`（由 CPU 核数自动计算）分配 C1/C2 比例：`_c1_count = ceil(N × 0.33)`，`_c2_count = N - _c1_count`。4 核机器上是 1 条 C1 + 2 条 C2——因为 C2 编译更耗时，需要更多线程消化队列。可以通过 `-XX:CICompilerCount=N` 调整。

### 禁止行为

- ❌ 把 Tiered Compilation 的 5 个 level 写成字典——"Level 0 解释器, Level 1 C1..." 这是 JVM 文档，不是源码分析
- ❌ 忽略 C1/C2 为什么需要两条独立线程——要追问"如果合并会怎样？" → 启动阶段 C2 编译阻塞 C1 → 启动延迟剧增
- ❌ 忽略 profiling 数据怎么从 C1 传递到 C2——MethodData 对象的 TLAB 分配 + counter 嵌入机器码的机制是全文核心
- ❌ 忽略编译器线程为什么是 JavaThread 而不是 NonJavaThread——要解释 safepoint 协调的深层原因
- ❌ 忽略 CodeCache Sweeper 的 zombie 状态转换——三种死亡状态的迁移条件 + 重新编译触发
- ❌ 忽略 `CompileThreshold` 和 `TieredCompilation` 的交互——默认模式下 `TieredCompilation=true`，`CompileThreshold` 被忽略
- ❌ 不画"解释 → C1 → C2 → Deoptimization"的完整生命周期图
- ❌ 混淆 `MethodCounters`（计数器）和 `MethodData`（profiling 数据）——这是两个独立对象，分配时机和用途完全不同
- ❌ 忽略 OSR（On-Stack Replacement）——长循环方法的编译路径完全不同于普通方法调用

### 要求行为

- ✅ **★★★ CompileBroker 编译调度全链路**：`compile_method()` → `CompileQueue::add()` → `compiler_thread_loop()` → `CompileQueue::get()`（阻塞） → `invoke_compiler_on_method()` → C1/C2 编译器 → `post_compile()` 安装 nmethod
- ✅ **★★ C1/C2 两队列设计**：`_c1_compile_queue` vs `_c2_compile_queue` — 为什么不共用？队列负载均衡策略
- ✅ **★ MethodData profiling**：MethodData 的创建时机（TLAB 分配） → C1 编译时嵌入 counter 自增 → C2 读 counter 做决策（内联、去虚化、逃逸分析）
- ✅ **★ Tiered Compilation 状态机**：Level 0→3→4 默认路径 + Level 1/2 的触发条件 + Deoptimization 回退原因
- ✅ **★ CodeCacheSweeperThread**：not_entrant → zombie → free 的三种状态迁移 + 触发清理的阈值（CodeCache 使用率）
- ✅ **★ CompilerThread 的 safepoint 协调**：`maybe_block()` 检查 + 4MB stack 原因 + 为什么必须是 JavaThread
- ✅ **★★ OSR (On-Stack Replacement)**：`_backedge_counter` 触发 → 只编译循环体 → 替换当前栈帧的入口。解释"为什么无限循环的方法也能被编译？"——这是 `_invocation_counter` 路径覆盖不到的场景
- ✅ **★ ciEnv 编译器接口层**：C1/C2 不直接读 JVM oop → 通过 `ciMethod`/`ciKlass` 等安全代理 → `ciEnv` 负责和 JVM 同步。这是"编译器和 JVM 之间的隔离墙"
- ✅ **★ CompileTask 完整生命周期**：创建 → 入队 → 窃取（其他线程抢先） → 编译 → 安装 nmethod 或失败回退 → 重试机制
- ✅ **★ Tiered vs Non-Tiered 策略区分**：`-XX:+TieredCompilation` → `AdvancedThresholdPolicy`；`-XX:-TieredCompilation` → `SimpleCompPolicy` 或 `StackWalkCompPolicy`。两种模式下的 counter 阈值完全不同
- ✅ **★ Method 完整生命周期图**：加载 → 解释（MethodCounters 先分配）→ profiling（MethodData 再分配）→ C1+profiling → C2 巅峰 → deopt → not_entrant → zombie → 清理 — 每一步标注触发条件
- ✅ 四线程对比线：CompilerThread vs ServiceThread vs ReferenceHandler vs FinalizerThread — 同为 JavaThread 但设计哲学完全不同
- ✅ GDB 验证：`info threads` 看 CompilerThread、`p CompileBroker::_compilation_id`、CodeCache 使用率、nmthod 状态枚举

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 默认 mixed mode（**Tiered Compilation 开启**）
- 64 位 Linux x86
- ★ C1/C2 CompilerThread 在 `CompileBroker::init_compiler_sweeper_threads()` 中创建（`compileBroker.cpp:864`）
- ★ 创建时机：`create_vm()` → `CompileBroker::compilation_init_phase1()` → `init_compiler_sweeper_threads()`（在 ServiceThread 之后、JSR292 初始化之前）
- ★ CompilerThread 栈大小 = 4MB（普通 JavaThread 默认 1MB，WatcherThread 只有 64KB）
- ★ C1 = `NearMaxPriority`，C2 = `NearMaxPriority`（两者同优先级，通过 `CompilationPriority` 设置；JVM 内部可能有调整，需从源码验证 `os::java_to_os_priority` 映射表）
- ★ CodeCacheSweeperThread = daemon=true，NearMaxPriority
- ★ 默认 `_c1_count = ceil(N × 0.33)`, `_c2_count = N - _c1_count`，其中 `N = max(log2(NCPUS)+1, 2) × CICompilerCountPerCPU`（默认 `CICompilerCountPerCPU=1`）。例如 4 核：`c1=1, c2=2`；2 核：`c1=1, c2=1`。可通过 `-XX:CICompilerCount=N` 覆盖

## 三、聚焦源文件

> ★★★ **读码顺序铁律**（违反必翻车）:
> 1. 先读 `compileBroker.hpp` — 理解 `CompileBroker`(AllStatic), `CompileQueue`, `CompileTask` — 编译调度系统架构
> 2. 再读 `thread.hpp` — 理解 `CompilerThread`, `CodeCacheSweeperThread` 类定义 — 字段含义 + 继承链
> 3. 再读 `compileBroker.cpp` — 理解 `compiler_thread_loop()` + `make_thread()` + `invoke_compiler_on_method()` — 这是全文核心
> 4. 再读 `compilationPolicy.hpp/.cpp` — 理解 `SimpleCompPolicy` vs `AdvancedThresholdPolicy` — Tiered/Non-Tiered 两种策略
> 5. 再读 `methodCounters.hpp` — 理解 `MethodCounters`（_invocation_counter + _backedge_counter）— 和 `MethodData` 的区别
> 6. 再读 `nmethod.hpp` — 理解 nmethod 状态枚举（in_use/not_entrant/zombie）+ make_not_entrant_or_zombie
> 7. 再读 sweeper 代码（`sweeper.hpp`, `nmethodSweeper.cpp`） — 理解 CodeCache 清理机制
> 8. ★ 最后理解 MethodData profiling 机制 + C1→C2 数据流 + OSR + ciEnv — 这是全文设计精髓

| # | 文件 | 完整路径 | 核心类/函数 | 本文角色 |
|---|------|---------|------------|---------|
| 1 | `compileBroker.hpp` | `src/hotspot/share/compiler/compileBroker.hpp` | `CompileBroker`(L139), `CompileQueue`(L80), `CompileTaskWrapper`(L130) | ★★★ 编译调度系统架构 — AllStatic broker + 双队列 |
| 2 | `compileBroker.cpp` | `src/hotspot/share/compiler/compileBroker.cpp` | `compiler_thread_loop()`(L1828), `make_thread()`(L784), `init_compiler_sweeper_threads()`(L864), `invoke_compiler_on_method()`(L2100) | ★★★ 全文核心 — 编译器线程主循环 + 任务调度 + 线程创建 |
| 3 | `thread.hpp` | `src/hotspot/share/runtime/thread.hpp` | `CompilerThread`(L2130), `CodeCacheSweeperThread`(L2109) | ★ 类定义 — 字段含义 + 继承链 |
| 4 | `compilationPolicy.hpp` | `src/hotspot/share/runtime/compilationPolicy.hpp` | `CompilationPolicy`, `SimpleCompPolicy`, `StackWalkCompPolicy` | ★ 编译策略 — "什么方法值得编译" |
| 5 | `compilationPolicy.cpp` | `src/hotspot/share/runtime/compilationPolicy.cpp` | `CompilationPolicy::policy()`, `SimpleCompPolicy::method_invocation_event()` | ★ 编译触发条件 — counter 阈值 |
| 6 | `nmethod.hpp` | `src/hotspot/share/code/nmethod.hpp` | `nmethod`, 状态枚举（in_use/not_entrant/zombie） | ★ 编译产物的数据结构 + 三种死亡状态 |
| 7 | `sweeper.hpp` | `src/hotspot/share/runtime/sweeper.hpp` | `NMethodSweeper` | ★ Sweeper 接口 + 状态转换条件 |
| 8 | `compilerDefinitions.hpp` | `src/hotspot/share/compiler/compilerDefinitions.hpp` | `CompLevel` enum（Level 0-4） | ★ Tiered Compilation 级别定义 |
| 9 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | `create_vm()` 中 `compilation_init_phase1()` 的调用位置 | ★ 创建时机 — 在 ServiceThread 之后、JSR292 之前 |
| 10 | `methodData.hpp` | `src/hotspot/share/oops/methodData.hpp` | `MethodData`, `DataLayout`, `ProfileData` | ★★ Profiling 数据存储 — C1 输出 → C2 输入 |
| 11 | `methodCounters.hpp` | `src/hotspot/share/oops/methodCounters.hpp` | `MethodCounters` (_invocation_counter, _backedge_counter) | ★ 计数器对象 — 和 MethodData 是两个独立对象 |
| 12 | `globals.hpp` | `src/hotspot/share/runtime/globals.hpp` | `TieredCompilation`, `CompileThreshold`, `CICompilerCount`, `OnStackReplacePercentage` | ★ JVM 参数默认值 + 约束 |
| 13 | `codeCache.hpp` | `src/hotspot/share/code/codeCache.hpp` | `CodeCache` | CodeCache 管理 — nmethod 存储空间 |
| 14 | `deoptimization.hpp` | `src/hotspot/share/runtime/deoptimization.hpp` | `Deoptimization` | ★ 逆优化入口 — C2→解释 回退机制 |
| 15 | `compilerInterface.hpp.inline.hpp` (或 `ciEnv.hpp`) | `src/hotspot/share/ci/` | `ciEnv`, `ciMethod`, `ciKlass` | ★ 编译器接口层 — 编译器和 JVM 的隔离墙 |

## 四、必须深度走读的核心概念

### 4.1 ★★★ CompileBroker 编译调度全链路 — 全文核心

```
┌─★★★ 任务提交 ────────────────────────────────────────────────────────────────┐
│                                                                               │
│  应用线程（解释器执行中）:                                                       │
│    方法调用 → MethodCounters::_invocation_counter++ (原子递增)                  │
│    循环回边 → MethodCounters::_backedge_counter++ (OSR 触发)                    │
│    → 超过 CompilationPolicy 阈值 (Tiered: AdvancedThresholdPolicy)              │
│    → method_invocation_event():                                                │
│      → 评估当前 CompLevel + 方法热度 + counter 值                                │
│      → 决定目标 CompLevel (0→3 或 3→4 或 OSR 编译)                               │
│    → CompileBroker::compile_method(method, level, ...)                        │
│      → 检查是否已有相同编译(防重复)                                              │
│      → create_compile_task() → new CompileTask(method, level, ...)            │
│      → compile_queue->add(task)  ★ 加入相应队列 (C1或C2)                        │
│      → compile_queue->notify_all()  ★ 唤醒编译器线程                            │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ↓
┌─★★★ 编译线程主循环 (compiler_thread_loop) ─────────────────────────────────────┐
│                                                                               │
│  CompilerThread::run() → compiler_thread_loop():                              │
│                                                                               │
│    while (!is_compilation_disabled_forever()) {                               │
│      // ★ Step 1: 阻塞等待任务                                                 │
│      task = queue->get();                                                     │
│      // 内部: 在 MethodCompileQueue_lock 上 wait()                            │
│      // 被 CompileBroker::compile_method() 中的 notify 唤醒                    │
│                                                                               │
│      // ★ Step 2: safepoint 协调                                              │
│      if (SafepointSynchronize::is_synchronizing()) {                          │
│        // 参与 safepoint — 编译器线程是 JavaThread, 必须在暂停点响应            │
│        SafepointSynchronize::block(this);                                     │
│        continue;                                                              │
│      }                                                                        │
│                                                                               │
│      // ★ Step 3: 执行编译                                                    │
│      invoke_compiler_on_method(task):                                         │
│        → 分配 ciEnv (编译器环境)                                               │
│        → 构建 IR (中间表示)                                                    │
│        → C1: 快速代码生成 (图形IR → LIR → 机器码)                               │
│        → C2: 深度优化 (内联, 逃逸分析, 循环展开, 向量化)                         │
│        → 生成 nmethod (编译产物, 存在 CodeCache)                                │
│                                                                               │
│      // ★ Step 4: 安装 nmethod                                                │
│      post_compile():                                                          │
│        → CodeCache::commit(nm) ← 将 nmethod 纳入 CodeCache                     │
│        → method->set_code(nm)  ← 让方法指向新机器码                             │
│        → deopt 检查: 是否需要 deoptimize 旧版本?                               │
│        → 通知 JVMTI (如果有 agent 监听编译事件)                                  │
│    }                                                                          │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

**★★★ 追问：为什么 C1/C2 是两条独立线程，不是一条线程做两级编译？**

```
如果合并为一条线程:
  → C2 编译一个复杂方法可能花 1-5 秒（深度内联+逃逸分析+循环展开）
  → 在此期间 C1 无法编译任何新方法
  → 新加载的类中的方法继续解释执行（慢）
  → 启动延迟剧增（用户感知: 应用启动后需要更久才能达到峰值性能）

正确设计（两条独立线程）:
  → C1 线程: 快速编译, 每个方法 ~10ms → 启动阶段快速覆盖大量方法
  → C2 线程: 深度编译, 每个方法 ~100ms-5s → 后台慢慢优化热点方法
  → 不互相阻塞 → 分层渐进优化

追问: 那为什么不是 3 条、4 条？
  → 可以通过 -XX:CICompilerCount=N 调整
  → 默认: _c1_count=ceil(N*0.33), _c2_count=N-_c1_count
  → C1/C2 = 1:2 的比例是因为 C2 编译更耗时, 需要更多线程来消化队列
```

### 4.2 ★ Tiered Compilation: 为什么默认是 0→3→4, 不是 0→1→2→3→4?

```
5 个编译级别 (compilerDefinitions.hpp):

  Level 0: 解释器 (纯解释, 零编译, 有 profiling 计数)
  Level 1: C1, 无 profiling (纯 C1, 简单方法用)
  Level 2: C1, 轻量 profiling (只记录方法调用计数)
  Level 3: C1, 完整 profiling ★ (记录: 分支概率, 类型 feedback, 调用计数)
  Level 4: C2, 基于 profiling 数据深度优化 ★

默认路径: Level 0 → Level 3 → Level 4

为什么跳过 Level 1 和 Level 2?
  → Level 3 的 profiling 最完整（分支预测 + 类型 profile + 调用计数）
  → C2 需要这些数据做激进优化:
    - 去虚化 (CHADevirtualization): "这个方法 90% 调用的是 ArrayList → 可以内联"
    - 逃逸分析: "这个对象从没逃逸 → 栈上分配 / 标量替换"
    - 分支预测: "这个 if 分支 80% 走 true → 按此优化指令布局"
  → Level 1 和 2 的数据不完整, C2 不敢做太多激进优化

Level 1/2 何时使用?
  → -XX:TieredStopAtLevel=1 或 =2（限制最高编译级别）
  → 或者 C2 队列太满时, 选择 Level 2 作为过渡（先做基础 C1, 等 C2 队列空再做 Level 4）
  → 简单方法（getter/setter）: C1 Level 1 就够了 → C2 不值
```

### 4.2b ★ Tiered vs Non-Tiered 的策略区别

```
Tiered 模式 (默认: -XX:+TieredCompilation):
  → AdvancedThresholdPolicy: 5 级状态机
  → Counter 阈值由公式自动计算（不是固定 CompileThreshold）
  → 根据不同 Level 有不同的 CompileThresholdScaling

Non-Tiered 模式 (-XX:-TieredCompilation):
  → SimpleCompPolicy: 只有 Level 0 → Level 4 两条路
  → _invocation_counter > CompileThreshold (默认 10000) → 触发 C2
  → StackWalkCompPolicy: 增强版, 不仅统计调用次数还"看"调用上下文
  → 只有 C2 CompilerThread (无 C1)

两者的核心区别:
  Tiered:  先 C1 快速编译 → profiling → C2 深度优化 (分层渐进)
  Non-Tiered: 解释足够热 → 直接 C2 (一步到位, 但启动慢)
```

### 4.2c ★★ OSR (On-Stack Replacement) — 长循环方法的编译路径

```
问题: 一个方法里有无限循环, 方法入口只被调用一次:
  void busyLoop() {
    while (true) {
      doWork();  // 循环体执行 1000000 次
    }
  }
  → MethodCounters::_invocation_counter = 1 (只调了一次!)
  → 永远不会 > CompileThreshold
  → ★ 这个方法永远不会被编译？→ 错误！因为有 OSR

OSR 机制:
  → 每次循环回边 → MethodCounters::_backedge_counter++ (原子递增)
  → 超过阈值 (OnStackReplacePercentage × CompileThreshold)
  → 触发 OSR 编译: 只编译循环体 (hot loop), 不编译整个方法
  → 生成 osr_nmethod (特殊的 nmethod, 入口是循环起点的解释器帧)
  → 在当前线程下次到达循环回边时 → osr_nmethod 替换解释器帧

OSR vs 标准编译的区别:
  标准编译: MethodCounters::_invocation_counter 触发 → 编译整个方法 → 下次调用生效
  OSR 编译:  MethodCounters::_backedge_counter 触发 → 只编译循环体 → 当前执行中生效

★ OSR 是"在线替换"——不等方法退出, 不等下次调用, 直接在栈上把解释器帧换成编译帧
```


### 4.3 ★★ MethodData profiling — C1→C2 的数据桥梁

```
MethodData 对象结构 (methodData.hpp):
  ┌──────────────────────────────────────┐
  │ MethodData                           │
  │  ├─ _method          (Method*)       │ ← 指向被监控的方法
  │  ├─ _invocation_counter (int)        │ ← 方法调用总次数
  │  ├─ _backedge_counter   (int)        │ ← 循环回边次数
  │  ├─ DataLayout[] _data               │ ← profiling 数据数组
  │  │    ├─ TypeProfileData (分支类型)   │    "这个 call site 调用了哪些类?"
  │  │    ├─ BranchData (分支概率)        │    "if 走 true 的比例"
  │  │    ├─ JumpData (跳转频率)          │    "循环体执行了多少次?"
  │  │    └─ VirtualCallData (虚调用)     │    "哪个子类被调用了?"
  │  └─ ...                              │
  └──────────────────────────────────────┘

C1 如何写 profiling 数据?
  → C1 编译方法时, 在生成的机器码中嵌入 counter 自增指令:
    // 伪代码: C1 为每个 call site 生成的指令
    mov rax, [MethodData + offset]   // 读当前计数
    inc rax                           // 自增
    mov [MethodData + offset], rax   // 回写
  → 每次方法执行 → counter 在 Java 堆上原子递增
  → 不需要 C1 线程参与 — 是生成好的机器码在做

C2 如何读 profiling 数据?
  → C2 编译时调用 MethodData::bci_to_data(bci):
    获取特定字节码位置的 profiling 数据
  → 如果 TypeProfileData 显示 "95% 是 ArrayList" → CHA 去虚化 → 直接内联 ArrayList 方法
  → 如果 BranchData 显示 "80% 走 true" → 按此预测重新排列代码块 → 减少分支预测失败
```

**★★ 追问: MethodData 什么时候被分配？**

```
不是 C1 编译时分配！而是在解释执行期间:
  → 解释器执行方法 → 检测到 invocation_counter 超过 ProfileInterpreterTieredThreshold
  → JVM 在 TLAB 中分配 MethodData 对象（和普通 Java 对象一样！）
  → 解释器遇到 call site → MethodData 中记录调用目标类型
  → C1 编译时 → MethodData 中已有基础 profiling 数据
  → C1 生成的代码继续填充 MethodData
  → C2 编译时 → 拿到的是 C1 + 解释器 共同填充的完整数据
```

### 4.4 ★★ CodeCache Sweeper — nmethod 的"GC"

```
nmethod 的三种死亡状态:

  in_use:
    - nmethod 被 method->code() 指向
    - 线程可以跳转到 nmethod 执行
    - CodeCache 中占空间

  not_entrant:
    - method->code() 不再指向此 nmethod（可能被新编译版本替换）
    - 正在此 nmethod 中执行的线程继续执行（on-stack replacement 除外）
    - 不再接受新的调用

  zombie:
    - 所有线程都已离开此 nmethod
    - Sweeper 确认安全 → 释放 CodeCache 空间
    - nmethod 对象本身在 JVM heap 中 → 等待 GC 回收

状态转换:
  新编译完成 → [in_use]
  方法重新编译 → [in_use] → 旧版本 → [not_entrant]
                              ↑ 新版本 → [in_use]
  Sweeper 扫描 → [not_entrant] → 检查 is_alive() → zombie → 释放
  Deoptimization → [in_use] → [not_entrant]（标记为不可用但不立即删除）

CodeCacheSweeperThread 主循环:
  while (true) {
    NMethodSweeper::possibly_sweep():
      → 扫描所有 nmethod
      → 对每个 not_entrant nmethod → 检查是否所有线程已离开
      → 安全的 → zombie → 释放 CodeCache 空间
      → 不安全的 → 跳过, 下次再检查
    wait(CodeCache_lock, sweep_interval);
  }
```

**★★★ 追问: 为什么 Sweeper 必须是独立线程，不能嵌入 GC？**

```
如果嵌入 GC（如 G1 Remark 期间顺便清理）:
  → Remark 是 STW 阶段 → 清理 nmethod 需要遍历 CodeCache
  → CodeCache 可能有数千个 nmethod → 遍历耗时
  → STW 时间增长 → 用户感知延迟

如果嵌入编译器线程:
  → 编译器在编译新方法 → 需要 CodeCache 空间
  → 空间不够 → 必须等待旧 nmethod 清理
  → 但旧的 nmethod 可能在等待所有线程离开（not_entrant→zombie）
  → 如果线程 A 正在执行旧 nmethod → 不能清理
  → 编译器线程阻塞 → 死锁（编译器等清理, 清理等线程退出, 线程在等编译的新方法）

正确设计（独立 Sweeper 线程）:
  → 被动 + 非阻塞: 能清多少清多少, 不太安全的跳过
  → 不影响编译: Sweeper 不是关键路径
  → 不影响 GC: STW 阶段代码不需要清理 CodeCache
```

### 4.5 ★ CompilerThread 为什么是 JavaThread？

```
直接原因: 编译器需要读取 Java 堆上的对象
  → Method 对象 (通过 methodHandle)
  → ConstantPool (解析符号引用)
  → InstanceKlass (类型层次分析)
  → Profiling 数据 (MethodData)
  → 这些都在 Java 堆上 → GC 会移动它们

如果 CompilerThread 是 NonJavaThread:
  → NonJavaThread 不参与 safepoint
  → 编译器正在读 Method._constMethod → GC Full GC compact → Method 移动了
  → 编译器拿到 stale pointer → crash

CompilerThread 是 JavaThread:
  → 在 compiler_thread_loop() 的 maybe_block() 中检查 safepoint
  → 当 GC 发起 safepoint → 编译器线程在 safe point poll 处停下
  → GC 完成 → 编译器线程恢复 → 此时堆已稳定

4MB 栈的原因:
  → C2 编译大方法 → 深度内联多个方法 → 递归构建 IR
  → 需要巨大的栈空间
  → 普通 JavaThread 的 1MB 栈 → C2 编译复杂方法 → StackOverflow → JVM crash
  → CompilerThread::CompilerThread() 构造中设置 stack_size=4*K*K
```

### 4.5b ★ ciEnv — 编译器和 JVM 之间的隔离墙

```
C1/C2 编译器不能直接读 JVM 内部的 oop 对象。原因:
  → oop 是原始指针 → GC 可能移动对象
  → JVM 内部数据结构（Method, Klass, ConstantPool）是 HotSpot 专有格式
  → 如果每个编译器都直接 depend on HotSpot 内部结构 → 极难维护

ciEnv (Compiler Interface Environment) 的作用:
  → 提供一套 "编译器接口对象":
    ciMethod     ← 映射到 JVM 的 Method
    ciKlass      ← 映射到 JVM 的 InstanceKlass
    ciField      ← 映射到 JVM 的 Field
    ciObject     ← 映射到 JVM 的 oop
  → 编译器只读 ci* 对象, 不碰 oop
  → ciEnv 负责:
    1. 将 JVM 对象转换为 ci 对象 (make_method, make_klass)
    2. 在 safepoint 期间重新同步（ci 对象可能在 GC 后失效）
    3. 管理 ciObjectFactory (对象池, 避免重复创建)

★ 这是 "编译器可移植性" 的关键设计 — 理论上可以插 C3/C4 编译器,
   只要实现同样的 ciEnv 接口即可（JVMCI 就是这么做的）
```

### 4.5c ★ CompileTask 的完整生命周期

```
CompileTask 不是简单的 new → add → poll:

  [创建] CompileBroker::create_compile_task(method, level)
    → 检查是否已有相同编译的 task 在队列中 (防重复)
    → 如果已有 task 但被标记为 failure → 允许重新提交
    → 从 C-Heap 分配 (非 Java 堆, 不受 GC 影响)

  [入队] compile_queue->add(task)
    → 双队列选择: C1 queue (level <= 3) 或 C2 queue (level == 4)
    → 头插法还是尾插法? 需从源码确认

  [窃取] 多线程编译时, 一个 CompilerThread 可以"窃取"另一个队列的任务
    → 如果 C1 队列空, C1 线程可以偷 C2 队列的任务中 level=3 的部分
    → 反之 C2 偷 C1 也是同理 (但 C2 偷 C1 level=3 不合理)

  [编译] invoke_compiler_on_method(task)
    → 成功 → nmethod 安装
    → 失败 → task->set_failure_reason()
      → 如果是 transient (如 CodeCache 满) → 可能重新入队
      → 如果是 permanent (如类结构不支持) → 不再重试

  [安装] post_compile():
    → CodeCache::commit(nm)
    → method->set_code(nm)
    → 旧 nmethod → make_not_entrant()
    → 通知 JVMTI / JFR

  [清除] task 对象在 C-Heap → compiler_thread_loop 结束后释放
```


### 4.6 ★ Method 完整生命周期（7 阶段, 含 OSR）

```
阶段 1: 出生 (Class Loading)
  ClassLoader.loadClass() → SystemDictionary::load_instance_class()
  → ClassFileParser::parse_methods() → new Method()
  → Method::_code = NULL (没有编译版本)
  → Method::_method_data = NULL (没有 profiling 数据)
  → 状态: 只能解释执行

阶段 2: 婴幼儿期 (解释 + 先计数再 profiling)
  解释器执行方法 → MethodCounters::_invocation_counter++ (原子递增)
  → 超过 ProfileInterpreterTieredThreshold
  → Method::build_method_counters() → 分配 MethodCounters 对象 (计数器)
  → 继续执行, counter 继续增长
  → 超过下一个阈值 → Method::build_method_data() → 分配 MethodData 对象 (profiling 数据)
  ★ MethodCounters 和 MethodData 是两个独立对象, 分配时机不同!
  ★ MethodCounters 管"调用多少次", MethodData 管"调用时发生了什么事"
  → 解释器向 MethodData 写入调用类型信息
  → 状态: 解释 + profiling

阶段 3: 成长期 (C1 编译)
  AdvancedThresholdPolicy::method_invocation_event():
    → 当前 Level 0, 方法够热 → 目标 Level 3
  → CompileBroker::compile_method(method, level=3)
    → C1 CompileQueue::add(task)
    → C1 CompilerThread 取出编译
    → C1 生成机器码 + 嵌入 profiling 自增指令 → nmethod_C1
    → method->set_code(nmethod_C1)
  → 下次调用 → 跳转到 C1 生成的机器码 → C1 代码中的 counter 继续填充 MethodData
  → 状态: C1 + profiling (快于解释器, 同时在收集数据)

阶段 4: 巅峰期 (C2 编译)
  AdvancedThresholdPolicy::method_invocation_event():
    → 当前 Level 3, 方法极热 → 目标 Level 4
  → CompileBroker::compile_method(method, level=4)
    → C2 CompileQueue::add(task)
    → C2 CompilerThread 取出编译
    → C2 读 MethodData → 去虚化, 内联, 逃逸分析, 循环展开
    → 生成超优化机器码 → nmethod_C2
    → method->set_code(nmethod_C2)
    → 旧 C1 nmethod → make_not_entrant()
  → 状态: C2 巅峰性能

阶段 5: 衰老期 (Deoptimization)
  触发原因:
    - C2 基于"这个 site 只调 ArrayList"做了内联 → 现在有线程调了 LinkedList
    - 类加载改变了类型层次 → C2 的 CHA 假设失效
    - 反射修改了 final 字段 → C2 的常量折叠失效
  → Deoptimization::deoptimize():
    → nmethod_C2 → make_not_entrant()
    → 当前栈帧 → 解释器帧
    → method->set_code(NULL)
    → 重新从 Level 0 开始（或 Level 3 C1, 取决于热度）
  → 状态: 退回到解释/C1

阶段 6: 死亡 (CodeCache 清理)
  → nmethod 在 not_entrant 状态 → Sweeper 检查所有线程已离开
  → nmethod → zombie → CodeCache::free(nm)
  → nmethod 对象等 GC 回收
  → 状态: 彻底清除
```

### 4.7 四线程对比：CompilerThread vs ServiceThread vs ReferenceHandler vs FinalizerThread

| 维度 | C2 CompilerThread | C1 CompilerThread | ServiceThread | ReferenceHandler |
|------|------------------|-------------------|---------------|-----------------|
| **创建时机** | create_vm → compilation_init_phase1 | 同上 | create_vm → ServiceThread::initialize | create_vm → Reference.\<clinit\> |
| **优先级** | NearMaxPriority (~9, 需源码验证) | NearMaxPriority (~9) | NearMaxPriority (~9) | MAX_PRIORITY (10) |
| **栈大小** | 4MB | 4MB | 默认 (~1MB) | 默认 (~1MB) |
| **任务模型** | 从 CompileQueue 拉取 + 编译方法 | 同上, 支持任务窃取 | 5-condition 复合等待 | pending list 消费 |
| **阻塞点** | `queue->get()` on MethodCompileQueue_lock | 同上 | `Service_lock->wait()` | `Heap_lock.wait()` |
| **为什么是 JavaThread** | 读 Method/ConstantPool/Class → 堆对象, 需 safepoint | 同上 | 读 Java 堆 + JVMTI agent | 需要执行 `queue.enqueue()` Java 方法 |
| **死亡后果** | 新方法无 C2 → 性能退化 (不崩溃) | 新方法无 C1 → 解释执行变慢 | JVMTI 事件 + StringTable 不清理 | Cleaner 不执行 → Native OOM |
| **任务耗时** | 100ms ~ 5s | 10ms ~ 100ms | 不定 | ~μs 级别（头插法） |

## 五、文章结构

```
§〇 源文件清单（跨 compiler + runtime + code + oops）
  → 搜索不到时回退到 source_index/ 索引

§一 CompilerThread 体系全景 — 方法为什么越跑越快？
  ★ 开头即贴 jstack 输出中 C1/C2 CompilerThread + SweeperThread
  ❓ 刚启动时慢、跑一阵后快 — JIT 编译到底干了什么？
  1.1 解释 → C1 → C2 三阶段渐进优化 — 时间换空间换性能
  1.2 ★ Method 完整生命周期图 — 6 个阶段的触发条件和数据流转
  1.3 CompilerThread 的创建时机 — compilation_init_phase1() 链
  1.4 ★ 为什么 C1 和 C2 必须是两条线程 — 延迟敏感 vs 吞吐优先

§二 ★★ CompileBroker 编译调度系统 (compileBroker.cpp)
  ❓ 谁决定编译哪个方法？不是随机、不是轮询、不是定时器！
  ❓ MethodCounters 和 MethodData 有什么区别？为什么分两个对象？
  2.1 CompilationPolicy::event() — 方法调用 → 编译请求的点火时机
  2.2 ★ TieredCompilation: 为什么默认是 0→3→4, 跳过 1/2？
  2.3 ★★ Tiered vs Non-Tiered 策略区分 — AdvancedThresholdPolicy vs SimpleCompPolicy
  2.4 ★★ OSR (On-Stack Replacement) — _backedge_counter 的独立编译路径
  2.5 CompileBroker::compile_method() — 编译任务的创建和入队
  2.6 ★ _c1_compile_queue vs _c2_compile_queue — 双队列设计 + CompileTask 生命周期
  2.7 ★★ compiler_thread_loop() 主循环逐行走读

§三 ★★ MethodData profiling — C1→C2 的数据桥梁
  ❓ C2 凭什么敢做激进优化（内联、去虚化、逃逸分析）？
  ❓ profiling 数据是谁收集的？存在哪？怎么传给 C2？
  ❓ MethodCounters 和 MethodData 的区别是什么？
  3.1 MethodCounters vs MethodData — 两个独立对象, 不同分配时机
  3.2 MethodData 数据结构 — DataLayout/TypeProfileData/BranchData
  3.3 MethodData 的创建时机 — TLAB 分配 + 解释器写入
  3.4 ★ C1 如何在机器码中嵌入 counter 自增指令
  3.5 ★ C2 如何读 profiling 数据做决策 — CHA 去虚化, 分支预测, 内联阈值

§四 ★ ciEnv 编译接口层 + CompileTask 生命周期
  ❓ C1/C2 编译器为什么不直接读 JVM 的 oop 对象？
  4.1 ★ ciEnv — 编译器和 JVM 之间的隔离墙 (ciMethod, ciKlass, ciField)
  4.2 ★ CompileTask 完整生命周期 — 创建 → 入队 → 窃取 → 编译 → 安装 → 清除

§五 ★★ CodeCacheSweeperThread — nmethod 的"GC"
  ❓ 旧编译方法怎么被回收？谁负责？什么时候？
  ❓ not_entrant 和 zombie 的区别？
  5.1 nmethod 的三种状态 — in_use / not_entrant / zombie
  5.2 ★ Sweeper 的主循环 — possibly_sweep() 的触发条件
  5.3 ★ 为什么 Sweeper 不能嵌入编译器线程或 GC？
  5.4 编译降级 — Deoptimization 的触发原因和后果

§六 ★ 对比线: CompilerThread vs ServiceThread vs ReferenceHandler vs FinalizerThread
  ❓ 四个都是 JavaThread, 都是 daemon — 为什么设计哲学完全不同？
  6.1 创建时机对比: compilation_init_phase1 vs initialization vs <clinit>
  6.2 优先级 + 栈大小对比: 4MB vs 1MB vs 1MB vs 1MB
  6.3 任务模型对比: 编译队列拉取 vs 5条件等待 vs 通知消费 vs 终结器
  6.4 死亡后果对比 — 为什么 CompilerThread 死了 JVM 不崩 (只变慢)

§七 GDB 验证 + 可证伪断言（≥10 条 GDB + ≥5 条断言）

  断言 1: (gdb) info threads | grep "Compiler" → 预期: 至少看到 C1 CompilerThread0 + C2 CompilerThread0
  断言 2: (gdb) info threads | grep "Sweeper" → 预期: CodeCacheSweeperThread 存在
  断言 3: (gdb) p CompileBroker::_c1_compile_queue->length() → 预期: 整数 (队列中等待编译的任务数)
  断言 4: (gdb) p CompileBroker::_c2_compile_queue->length() → 预期: 整数
  断言 5: (gdb) p CompileBroker::_compilation_id → 预期: 非 0 (当前编译 ID 递增中)
  断言 6: (gdb) thread <CompilerThread_tid> → p this->_stack_size → 预期: 4194304 (4MB)
  断言 7: (gdb) p CodeCache::_number_of_blobs → 预期: 非 0 (CodeCache 中编译产物数量, 字段名需从 codeCache.hpp 确认)
  断言 8: (gdb) break NMethodSweeper::possibly_sweep → (gdb) continue → 预期: 在 CodeCache 使用率超阈值时触发
  断言 9: java -XX:+PrintCompilation -XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining YourApp → 预期: 看到方法编译 + 内联决策日志
  断言 10: java -XX:-TieredCompilation -jar YourApp → 预期: jstack 中只有 C2 CompilerThread（无 C1）

  断言 11: java -XX:TieredStopAtLevel=3 -jar YourApp → 预期: jstack 中有 C1 CompilerThread, 无 C2 CompilerThread
  断言 12: 在 CompileBroker::compile_method 设断点 → bt → 预期: 调用栈来自解释器 (方法调用计数器超阈值)
  断言 13: (gdb) x/<nmethod_size> <nmethod_addr> → 查看 nmethod._state 字段 → 需从 nmethod.hpp 确认 _state 枚举值 (0=in_use, 1=not_entrant, 2=zombie)
  断言 14: (gdb) p MethodCounters::_invocation_counter → 预期: 非 0 (方法已被调用多次); 验证与 MethodData 是独立对象

  可证伪断言 1: C2 CompilerThread crash → 所有方法留在 C1 Level → 性能下降但 JVM 不崩溃
  可证伪断言 2: C1 CompilerThread crash → 新方法只能解释执行 → 性能大幅下降
  可证伪断言 3: CodeCacheSweeperThread crash → CodeCache 满 → 新编译失败 → 所有方法退回解释
  可证伪断言 4: 关闭 TieredCompilation → 只有 C2 编译 → 启动变慢但峰值可接受（-client 模式适用）
  可证伪断言 5: MethodData 存在 Java 堆上 → Full GC compact 时 MethodData 也会移动
  可证伪断言 6: MethodCounters 和 MethodData 是两个独立对象 — 验证: build_method_counters() 的调用时机早于 build_method_data()
  可证伪断言 7: OSR 编译只编译循环体, 不编译整个方法 — 验证: osr_nmethod 的入口地址指向循环体而非方法头
```

## 六、写作要求

1. **★ 编译调度全链路是全文灵魂**：从方法调用 counter++ → CompileBroker → CompileQueue → compiler_thread_loop → invoke_compiler_on_method → post_compile — 每步都要解释"为什么这个步骤不能省略"
2. **★ MethodData profiling 桥梁**：TLAB 分配 + C1 嵌入 counter + C2 读取做决策 — 这是 C1 和 C2 之间唯一的"交接点"
3. **★ Tiered 0→3→4 默认路径**：为什么跳过 Level 1/2？Level 3 的完整 profiling 数据是 C2 激进优化的前提
4. **★ CodeCache Sweeper 异步清理**：三个死亡状态的迁移条件和时序 — 为什么不能嵌入编译器或 GC
5. **★ CompilerThread 为什么是 JavaThread**：safepoint 协调 + 读堆对象 — 和 [10-NonJavaThread] 对比
6. **★ OSR (On-Stack Replacement)**：`_backedge_counter` 的独立编译路径 — 长循环方法的编译机制
7. **★ ciEnv 编译器接口层**：`ciMethod`/`ciKlass` 等安全代理 — C1/C2 不直接读 oop 的原因
8. **★ CompileTask 生命周期**：创建 → 入队 → 窃取 → 编译 → 安装 → 清除 — 完整状态机
9. **Method 完整生命周期 7 阶段图**（含 OSR）：从 new Method → 解释（MethodCounters）→ profiling（MethodData）→ C1+profiling → C2 巅峰 → deopt → zombie
10. **Tiered vs Non-Tiered 策略区分**：`AdvancedThresholdPolicy` vs `SimpleCompPolicy` — 两种模式下的 counter 阈值完全不同
11. **四线程对比**：CompilerThread vs ServiceThread vs ReferenceHandler vs FinalizerThread
12. **GDB 验证**：≥14 条（新增 OSR + MethodCounters），每条含命令 + 预期值；可证伪断言 ≥7 条
13. **交叉引用**：[09 §3.7] CompilerThread 创建入口 + [06] 生命周期 + [10] NonJavaThread 对比 + [12] ServiceThread 对比 + [13] ReferenceHandler 对比

## 七、输出格式

- Markdown 文件，命名为 `14-JVM-CompilerThread.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
- 元信息头（标准环境 + 源文件 + 前置 [09][12][13] + 关联 [06][10] + 阅读收益）
