# JIT Framework (JIT 编译框架) — 文章大纲

> vol-04 · 域 26 · 🔴 A | 基于 Pass 0+1 探索笔记
> Pass 1 产出：10 基本元素 / 9 标记问题
>
> **→ 从 ci**：ci 给了编译器看 VM 状态的 immutable 快照窗口——但编译器自己怎么做决策？什么时候编译、编译优先级怎么排、分层编译 C0→C1→C2 怎么调度？JIT Framework 篇见。

## 概念依赖

先修：Interpreter（调用计数器在解释器中递增）、ci（ciEnv 在每次编译时创建）、CodeCache（编译结果存哪里尚未交代——取依赖方向：从 ci 和 Interpreter 来的触发，向 CodeCache 和 C1/C2 去的产出）。

JIT Framework 是"调度的层次"——它不生成字节码也不生成机器码，它回答"谁、什么时候、用什么编译器、编译谁的什么方法"。

## 叙事计划

**开篇场景**：`java -jar app.jar` 启动后，解释器在慢慢执行字节码。但有些方法被反复调用（hot loops），有些方法一启动就该编译（`-Xcomp`）。谁来发出"该编译了"的信号？谁来决定用 C1 还是 C2？如果 C2 队列太长怎么办？

**第一层：CompileBroker — 编译系统的"前台"**

`CompileBroker`（`compileBroker.hpp:138`）是一个 `AllStatic` 的全局调度器——JVM 中只有一个 CompileBroker，没有实例。它持有两个 `AbstractCompiler*`（`_compilers[0]` = C1，`_compilers[1]` = C2），两个 `CompileQueue*`（对应的编译等待队列），管理编译器线程的创建和关闭。

唯一的外部入口是 `CompileBroker::compile_method()`（`compileBroker.cpp:1220`）。无论谁想编译一个方法——解释器触发的、JVMCI 的、WhiteBox API 的——都走同一个入口。内部调用 `compile_method_base()` 创建 `CompileTask`、入队、可能阻塞等待（blocking 模式，如 `-Xcomp` 或 JVMCI bootstrap）。

CompileBroker 内置三道"不编译"的防护：

1. **已编译检查**：`compilation_is_complete()` → 如果方法已经有了当前 level 的 `nmethod`，直接返回，不入队。
2. **队列去重**：`compilation_is_in_queue()` → 如果方法已经在队列中等待编译，本次请求静默返回，不重复入队。
3. **`not_compilable` 永久标记**（`method.hpp:926`）：方法连续编译失败超过阈值后，调用 `set_not_compilable(comp_level)` 在方法对象上打永久标记。后续对该方法的编译请求自动被 `compilation_is_prohibited()`（`compileBroker.cpp:1437`）拦截——不再浪费编译资源。

第四道防护是 **VM 启动延迟编译**：`delay_compilation_during_startup()`（`compilationPolicy.hpp:53`）在 VM 启动阶段返回 true，编译策略会在这期间跳过编译，等 `completed_vm_startup()` 后再正常启动。

**第二层：CompLevel — 5 级的执行层级体系**

`CompLevel`（`compilerDefinitions.hpp:54-63`）定义了 JVM 的 5 级分层体系：

| Level | 名称 | 谁 | Profiling 强度 |
|:--:|------|:--:|------|
| 0 | `CompLevel_none` | 解释器 | 无（但从 JDK8+ 可做 profiled interpreter） |
| 1 | `CompLevel_simple` | C1 | 无 profiling — 纯编译，最快速度 |
| 2 | `CompLevel_limited_profile` | C1 | 调用计数 + 回边计数 |
| 3 | `CompLevel_full_profile` | C1 | Level 2 + MDO（全 profiling 数据） |
| 4 | `CompLevel_full_optimization` | C2 | 消费 MDO 数据做激进优化 |

`is_c1_compile(level)` → level ∈ {1, 2, 3}，`is_c2_compile(level)` → level == 4。`CompLevel_highest_tier` 默认为 4（除非 `-XX:TieredStopAtLevel=N`）。

**第三层：TieredThresholdPolicy — 升层决策的"大脑"**

`TieredThresholdPolicy`（`tieredThresholdPolicy.hpp:165`）是分层编译的核心策略类。主入口 `event()` 收到解释器通知后调用 `call_event()`（普通方法调用）或 `loop_event()`（回边→OSR 候选）决定是否升层。

升层判断公式（`tieredThresholdPolicy.hpp:98`）：

```
i >= Tier3InvocationThreshold × s || (i >= Tier3MinInvocationThreshold × s && i + b >= Tier3CompileThreshold × s)
```

其中 `i` = 方法调用次数，`b` = 回边次数，`s` = 队列负载反馈系数。源码实际用 `>=` 而非 `>`（`call_predicate_helper` at `tieredThresholdPolicy.cpp:55-56`）。0→3 过渡用 Tier3 阈值，3→4 过渡用 Tier4 阈值。理解设计意图：用两个条件均衡每个方法在 profiling 上花费的时间——调用次数足够多就升层（第一个条件），或者调用+回边都足够就升层（第二个条件）。两个条件的区别：`TierXMinInvocationThreshold` < `TierXInvocationThreshold`，给回边辅助加速的分支。

关键设计：0→3 和 3→4 过渡用相同的公式但阈值不同——而且 `i` 和 `b` 的来源也不同：0→3 来自 `method->invocation_count()` / `backedge_count()`（Method 计数器的累积值），3→4 来自 `mdo->invocation_count_delta()` / `backedge_count_delta()`（MethodData 的增量值——每次编译事件后重置）。这种 source 差异意味着 0→3 看的是"从方法创建以来的总热度"，3→4 看的是"自上次编译以来的增量热度"。

**第四层：C2 队列拥堵的自动降级（Tier3Delay）**

分层编译的一个核心难题：Level 3（C1+全 profiling）比 Level 2（C1+计数器）慢约 30%。正常路径 0→3→4 是优先路径，但如果 C2 队列堵了，方法停在 Level 3 很久——慢 30% 但只能干等。

Tier3Delay 机制（`tieredThresholdPolicy.hpp:127-142`）解决这个问题：当 `C2_queue_size > Tier3DelayOn × c2_count` 时，跳过 0→3 改走 0→2（不创建 MDO，更快运行）。当 C2 队列降到 `Tier3DelayOff × c2_count` 以下时恢复 0→3。Tier3DelayOn > Tier3DelayOff 形成滞后（hysteresis）——防止在临界点来回抖动。

这是 "feedback control loop" 的设计——不是固定策略，而是根据 C2 队列长度动态调整行为。同类设计：`threshold_scale()` 根据 `queue_size / (TierXLoadFeedback × compiler_count)` 动态伸缩升层阈值——编译器越忙，升层门槛越高。

**第五层：CompileQueue — 优先级调度 + Stale 检测**

`CompileQueue`（`compileBroker.hpp:79`）不是简单的 FIFO。`get()` 委托给 `CompilationPolicy::policy()->select_task()`（`compileBroker.cpp:464`），后者遍历整个队列，计算每个等待方法的 event rate（d(i+b)/dt），选择速率最高的返回。核心逻辑：

```
1. select_task() 遍历队列（双向链表 _first → _last）
2. is_stale(): 某方法 event rate=0 且持续超过 TieredCompileTaskTimeout → remove_and_mark_stale() 移入 _first_stale
3. update_rate() + compare_methods() 计算每个方法的权重 → 选最大权重的
4. 将此任务从队列取出返回给编译线程
5. purge_stale_tasks() 清理 _first_stale 链表
```

为什么用 event rate 而不是等待时间？因为编译队列中的方法可能因为应用行为变化（用户走了冷路径）而不再热——继续编译它浪费 CodeCache 空间。stale detection 让这些"冷却"方法不进入编译。

`CompileTask::can_become_stale()` 限制：非 blocking 编译 + Reason 为 InvocationCount/BackedgeCount/Tiered 时才可能 stale。`Reason_MustBeCompiled`（`-Xcomp`）和 `Reason_Whitebox` 永不 stale。

**第六层：MethodData — Profiling 数据的容器**

`MethodData`（`methodData.hpp:2495 行`）是 JIT 决策的数据基础。核心设计：`DataLayout` 用**变长行编码**替代 C++ 多态类——每个 ProfileData 子类（CounterData/BranchData/ReceiverTypeData 等）指定自己的行宽（以 cell 为单位），DataLayout 的 header cell 存储行类型和长度，后续 cell 存储具体数据。

为什么不用虚函数类继承？一个方法可能有几百个 profiling 数据点——如果用 C++ 多态（每个数据点一个 vtable 指针），浪费大量内存。变长行编码把单字节码的 profiling 开销压缩到一个 intptr_t 数组行中，读写通过 DataLayout 的 bit mask 操作。

ProfileData 层级：
- `CounterData`（header + count cell）— 方法调用计数
- `BranchData`（header + 2 branch counts）— 条件分支 taken/not-taken 频率
- `ReceiverTypeData`（header + 多 receiver Klass 记录）— 虚调用点 receiver 类型分布
- `CallTypeData`（header + arguments + return type）— 方法调用的参数/返回值类型

**第七层：OSR — 循环中插队编译**

OSR（On-Stack Replacement）允许已在执行的循环"插队编译"——不用等到下次调用方法时才用编译版本。触发：`Reason_BackedgeCount`（回边计数器溢出）。策略：`loop_event()` 检查 `b >= TierXBackEdgeThreshold × s`（`tieredThresholdPolicy.cpp:75`，与 call_predicate 一致的 `>=`）。

与普通编译的关键区别：OSR 编译的入口点是循环的回边 `bci`，不是方法开头。这意味着编译生成的 `nmethod` 带 `osr_entry_bci` 字段——调用方不需要重新调用方法，而是在安全点把解释器帧替换为编译帧并跳转到 OSR 入口。

**第八层：编译器线程管理**

`CompileBroker::compilation_init_phase1()`（`compileBroker.cpp:603`）设置编译线程。线程数量由 `-XX:CICompilerCount` 控制（不设置时自动计算 = `MAX2(log2(N) × log2(log2(N)) × 3/2, 2)`，`tieredThresholdPolicy.cpp:212-214`）。C1 和 C2 各有独立的线程池——`_c1_count` 和 `_c2_count` 分别计数。

支持动态调整：`possibly_add_compiler_threads()` 懒创建（`UseDynamicNumberOfCompilerThreads` 开启时，同时检查可用内存和 CodeCache 剩余空间，`compileBroker.cpp:927-936`）。`can_remove()` 检查是否可以安全移除编译器线程：`ReduceNumberOfCompilerThreads` 开启 + 每种编译器至少保留 1 个线程 + C1 需 idle ≥500ms、C2 需 idle ≥100ms（`compileBroker.cpp:306-318`，C2 反而可以更快移除——因为 C2 编译耗时更长，idle 时间长说明确实空闲）。

编译器线程循环（`compiler_thread_loop()`）：从队列 `get()` 一个 CompileTask → 获取 ciEnv → 调用 `invoke_compiler_on_method()` → `comp->compile_method()` → `post_compile()` 记录结果 → 循环。

## 设计权衡

一、**event rate 调度 vs FIFO**。Event rate 优先编译最热方法——加速启动时间。代价是遍历整个队列计算 rate（O(n)），在队列很大时可能成为瓶颈。权衡：方法是"编译的频率低，但每次编译的收益大" vs "编译的频率高，但 FIFO 更简单"。

二、**Tier3Delay 的滞后设计**。Tier3DelayOn > Tier3DelayOff 形成滞后——防止在临界点来回切换（0→3 vs 0→2）。代价是存在一个"死区"区间不会及时响应变化——但 jitter 比短暂的响应延迟更影响用户体验。

三、**变长行编码 vs C++ 多态**。DataLayout 的变长行编码省内存但增加访问复杂度——bit mask 操作比虚函数调用更难读和理解。权衡：profiling 数据点在运行时可能有数十万个（每个方法几百个×数百个被 profiled 方法）→ 每个数据点省 8 字节（vtable 指针）意味着省 MB 级内存。

四、**分层编译的 profiling 开销 vs 短生命周期方法**。分层编译给每个方法额外的 profiling 开销（计数器检查、MDO 创建和维护）。这种开销对于短生命周期方法来说是浪费。策略通过 `is_trivial()`（`tieredThresholdPolicy.cpp:84-89`）过滤——`is_accessor()` 或 `is_constant_getter()` 方法在 `common()` 入口处直接跳 Level 1（不创建 MDO）。注意 `is_trivial()` 在 `common()` 的 switch 之前检查，对所有当前层级生效——不仅是 Level 0。

## 核心悬念

**JVM 怎么知道一段解释执行的字节码"热"到该编译了——不检查是否热、不做无用 profiling、C2 队列堵的时候降级而不僵住？**

**→ 下一域**：CompilerBroker 调好了 C1 还是 C2 编译器，但解释器的调用约定（Java 栈帧、局部变量表、操作数栈）和编译器的调用约定（寄存器分配、native 栈帧）完全不同。一个解释器帧怎么跳到编译后的机器码？编译怎么回退到解释器？SharedRuntime 篇见。

## 预估

1 篇，7 层递进 + 4 个设计权衡，预估 2200-2800 行。
