# 14-JVM-CompilerThread: 方法为什么能越跑越快？

> **Tiered Compilation 全周期：C1/C2 CompilerThread + CodeCacheSweeperThread + MethodData profiling 桥梁**
>
> **标准环境**: OpenJDK 11 slowdebug build | `-Xms8g -Xmx8g -XX:+UseG1GC` | 64 位 Linux x86 | Tiered Compilation 开启
>
> **前置文档**: [09-JavaThread 系统线程全景 §3.2] CompilerThread 创建入口 | [06-Thread-Architecture §4.4-4.5] 完整继承链 + 4MB 栈原因 | [10-NonJavaThread] safepoint 行为对比 | [12-ServiceThread] 同为 daemon 但设计哲学不同 | [13-ReferenceHandler+Finalizer] 同为 JavaThread 但任务模型完全不同
>
> **关联**: CompileBroker (AllStatic) → C1/C2 CompileQueue → CompilerThread 主循环 → ciEnv 编译接口 → MethodData profiling → nmethod (in_use/not_entrant/zombie) → CodeCacheSweeperThread → Deoptimization
>
> **阅读收益**: 你将理解 Tiered Compilation 的完整调度链路：从解释器的 counter++ → CompilationPolicy 决策 → CompileBroker 入队 → CompilerThread 唤醒 → ciEnv 封装 → C1/C2 编译 → nmethod 安装 → profiling 数据流 → Sweeper 异步清理 → deopt 回退的全周期。

---

## §〇 源文件清单

| # | 文件 | 核心类/函数 | 本文角色 |
|---|------|------------|---------|
| 1 | `compiler/compileBroker.hpp` | `CompileBroker`(L139), `CompileQueue`(L80), `CompileTaskWrapper`(L130) | ★★★ 编译调度架构 — AllStatic broker + 双队列 |
| 2 | `compiler/compileBroker.cpp` | `compiler_thread_loop()`(L1828), `make_thread()`(L784), `init_compiler_sweeper_threads()`(L864), `invoke_compiler_on_method()`(L2100) | ★★★ 全文核心 — 编译器线程主循环 + 任务调度 |
| 3 | `runtime/thread.hpp` | `CompilerThread`(L2130), `CodeCacheSweeperThread`(L2109) | ★ 类定义 — 字段含义 + 继承链 |
| 4 | `runtime/compilationPolicy.hpp` | `CompilationPolicy`, `SimpleCompPolicy`, `NonTieredCompPolicy` | ★ 编译策略接口 |
| 5 | `runtime/compilationPolicy.cpp` | `compilationPolicy_init()`(L61), `SimpleCompPolicy::method_invocation_event()` | ★ 策略选择 + Tiered vs Non-Tiered 触发 |
| 6 | `runtime/tieredThresholdPolicy.hpp` | `TieredThresholdPolicy`(L165) | ★★★ Tiered 策略 — 5 级状态机 |
| 7 | `runtime/tieredThresholdPolicy.cpp` | `call_predicate_helper()`(L45), `loop_predicate_helper()`(L66), `common()` | ★ 0→3→4 的数学条件 |
| 8 | `compiler/compilerDefinitions.hpp` | `CompLevel` enum(L54-L63) | ★ Tiered 编译级别定义 |
| 9 | `oops/methodCounters.hpp` | `MethodCounters` (_invocation_counter, _backedge_counter) | ★ 计数器对象 — 与 MethodData 独立 |
| 10 | `oops/methodData.hpp` | `MethodData`, `DataLayout`, `ProfileData` | ★★ Profiling 数据存储 — C1 输出 → C2 输入 |
| 11 | `code/nmethod.hpp` | `nmethod`, _state 枚举 (in_use/not_entrant/zombie) | ★ 编译产物 + 三种死亡状态 |
| 12 | `runtime/sweeper.hpp` | `NMethodSweeper` | ★ Sweeper 接口 + 状态转换 |
| 13 | `runtime/sweeper.cpp` | `sweeper_loop()`(L265), `possibly_sweep()` | ★ Sweeper 主循环 |
| 14 | `code/codeCache.hpp` | `CodeCache` | CodeCache 管理 |
| 15 | `runtime/thread.cpp` | `CompilerThread::CompilerThread()`(L3618), `compilation_init_phase1` | 构造 + 栈大小 + 创建时机 |
| 16 | `ci/ciEnv.hpp` | `ciEnv`, `ciMethod`, `ciKlass` | ★ 编译器-JVM 隔离墙 |

---

## §一 CompilerThread 体系全景 — 方法为什么越跑越快？

### 1.0 jstack 中的 CompilerThread 全家福

```text
"C2 CompilerThread0" #7 daemon prio=9 os_prio=0 cpu=123.45ms tid=0x7f... nid=0x1234 waiting on condition [0x...]
   java.lang.Thread.State: RUNNABLE
   ...(no Java stack, thread is native)

"C1 CompilerThread0" #8 daemon prio=9 os_prio=0 cpu=45.67ms tid=0x7f... nid=0x1235 waiting on condition [0x...]
   java.lang.Thread.State: RUNNABLE

"Sweeper thread"     #9 daemon prio=9 os_prio=0 cpu=1.23ms tid=0x7f... nid=0x1236 waiting on condition [0x...]
   java.lang.Thread.State: RUNNABLE
```

先回答核心问题：**Java 程序运行一段时间后，为什么变快了？**

答案不是"JIT 编译"四个字——这等于没说。真正的答案是 **"解释→C1+profiling→C2 三阶段的渐进优化流水线"**：

1. **阶段 1（解释+计数）**：方法首次被调用，解释器执行，`MethodCounters::_invocation_counter` 原子递增。计数器达到 `Tier3InvocationThreshold`（默认 200），`TieredThresholdPolicy` 决定："这个方法值得编译"。

2. **阶段 2（C1+profiling）**：C1 CompilerThread 取出编译任务，快速生成机器码（每个方法 10-50ms），同时在生成的机器码中**嵌入 profiling 自增指令**。每次执行到 call site，机器码自动更新 `MethodData` 对象中的 `TypeProfileData` — "这个虚调用 95% 调的是 ArrayList"。

3. **阶段 3（C2 基于 profiling 深度优化）**：当 profiling 数据足够丰富，`TieredThresholdPolicy` 决定触发 Level 4 编译。C2 CompilerThread 读取 `MethodData` 做**激进优化**：去虚化（"95% ArrayList → 直接内联 ArrayList 方法"）、逃逸分析（"从不逃逸 → 栈上分配"）、分支重排（"80% 走 true → CPU 分支预测命中率高"）。

### 1.1 解释 → C1 → C2 三阶段渐进优化

以下是完整数据流：

```
┌─ 阶段 1: 解释 + 计数 ──────────────────────────────────────────────────────┐
│                                                                           │
│  应用线程 → 方法入口/循环回边                                               │
│    → MethodCounters::_invocation_counter += 8 (不是 +1, 详见 §2.1)         │
│    → MethodCounters::_backedge_counter += 8   (OSR 触发)                   │
│    → 每 ~1024 次递增 (invoke_mask 控制) → 通知 Runtime                     │
│      → InterpreterRuntime::frequency_counter_overflow()                   │
│    → TieredThresholdPolicy 评估:                                           │
│       if (i > Tier3InvocationThreshold * scale) → 预判 Level 3            │
│    → ★ MethodData 尚未分配！（分配在编译触发之后、C1 编译之前）               │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ↓
┌─ 阶段 2: C1 + 完整 profiling (Level 3) ───────────────────────────────────┐
│                                                                           │
│  CompileBroker::compile_method(method, level=3)                           │
│    → create_compile_task() → _c1_compile_queue->add(task)                 │
│    → MethodCompileQueue_lock->notify_all()                                │
│                                                                           │
│  C1 CompilerThread 被唤醒:                                                 │
│    → queue->get() → task                                                   │
│    → invoke_compiler_on_method(task)                                      │
│      → ciEnv 封装 Java 对象                                               │
│      → C1: 图形IR → LIR → 机器码                                          │
│        ★ 在机器码中嵌入 profiling 自增指令:                                 │
│          mov rax, [MethodData + type_profile_offset]                       │
│          inc rax                                                           │
│          mov [MethodData + type_profile_offset], rax                       │
│      → 生成 nmethod (CodeCache 中)                                        │
│    → post_compile() → CodeCache::commit(nm)                               │
│    → method->set_code(nm)  ← 方法指向 C1 机器码                            │
│                                                                           │
│  下次调用此方法 → 跳转到 C1 机器码 → profiling 自增指令持续填充 MethodData  │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ↓
┌─ 阶段 3: C2 深度优化 (Level 4) ────────────────────────────────────────────┐
│                                                                           │
│  C1 机器码中的 profiling 自增指令持续填充 MethodData:                        │
│    → TypeProfileData: "call site 95% 调了 ArrayList"                       │
│    → BranchData: "if 分支 80% 走 true"                                     │
│    → VirtualCallData: "虚调用接收者类型分布"                                 │
│                                                                           │
│  TieredThresholdPolicy 再次评估:                                           │
│    if (MethodData::invocation_count > Tier4InvocationThreshold) → Level 4 │
│                                                                           │
│  CompileBroker::compile_method(method, level=4)                           │
│    → _c2_compile_queue->add(task)                                         │
│                                                                           │
│  C2 CompilerThread 被唤醒:                                                 │
│    → 构建 ciMethod (通过 ciEnv)                                            │
│    → 读取 MethodData:                                                     │
│      - "95% ArrayList" → CHA (Class Hierarchy Analysis) → 直接内联         │
│      - "80% true" → 指令重排, 预测友好                                      │
│      - "从未逃逸" → 栈上分配 + 标量替换                                      │
│    → 生成超优化机器码 → nmethod_C2                                         │
│    → method->set_code(nm_C2)                                              │
│    → 旧 C1 nmethod → make_not_entrant() → Sweeper 最终回收                 │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

**关键洞察**：三个阶段不是"被动发生"的 — 每一步都是由 `TieredThresholdPolicy` 基于计数器阈值**主动决策**的。决策输入是计数器（`MethodCounters`）和 profiling 数据（`MethodData`）；决策输出是编译级别（CompLevel）。

### 1.2 ★ Method 完整生命周期（7 阶段，含 OSR）

```
阶段 1: 出生 (Class Loading)
  ClassFileParser::parse_methods() → new Method()
  Method::_code = NULL        (没有编译版本)
  Method::_method_counters = NULL  (计数器还未分配)
  Method::_method_data = NULL     (profiling 数据还未分配)
  状态: 只能解释执行

阶段 2: 计数开启 (MethodCounters 分配)
  解释器执行 → invocation_counter 超过阈值
  → Method::build_method_counters() → new MethodCounters(mh)
  → _invocation_counter 和 _backedge_counter 在 MethodCounters 中
    ★ 注意: MethodCounters 继承自 Metadata, 分配在 Metaspace（不在 Java 堆！）
  → 状态: 解释 + 计数

阶段 3: profiling 开启 (MethodData 分配)
  继续解释执行 → invocation_counter 超过 ProfileInterpreterTieredThreshold
  OR TieredThresholdPolicy::should_create_mdo() 返回 true
  → Method::build_method_data() → MethodData::allocate()
    ★ MethodData 分配在 Java 堆的 TLAB 中（和普通 oop 一样！）
    ★ 这意味着 GC 会移动它（编译器必须 safepoint）
  状态: 解释 + profiling (MethodData 已存在但数据稀疏)

阶段 4: C1 编译 (Level 3, 完整 profiling)
  TieredThresholdPolicy::call_event() → 目标 Level 3
  → C1 CompilerThread 编译 → nmethod_C1 (含 profiling 自增指令)
  → method->set_code(nm_C1)
  状态: C1 + profiling (执行速度快于解释器, 同时收集 profiling)

  特殊情况: 简单方法 (accessor/constant_getter) → Level 1 (纯 C1, 无 profiling)
  特殊情况: C2 队列太满 → Level 2 (轻量 C1, 先过渡)

阶段 5: C2 巅峰 (Level 4, 基于 profiling 深度优化)
  TieredThresholdPolicy::call_event() → 目标 Level 4
  → C2 CompilerThread 读取 MethodData → 去虚化/内联/逃逸分析
  → nmethod_C2 → method->set_code(nm_C2)
  → 旧 C1 nmethod → make_not_entrant()
  状态: C2 巅峰性能

阶段 6: 衰老期 (Deoptimization)
  触发原因:
    - C2 基于 "只调 ArrayList" 做了内联 → 出现了 LinkedList 调用
      → 依赖失效 → uncommon trap → deoptimize
    - 新的类加载改变了类型层次 → CHA 假设失效
    - 反射修改了 final 字段 → 常量折叠失效
  → Deoptimization::deoptimize():
    → nmethod_C2 → make_not_entrant()
    → 当前栈帧 → 解释器帧 (重新解释执行)
    → 热度足够 → 重新走 0→3→4 路径
  状态: 退回到解释/C1, 等待重新编译

阶段 7: 死亡 (CodeCache 清理)
  → nmethod 在 not_entrant 状态
  → CodeCacheSweeperThread → 检查所有线程已离开此 nmethod
  → nmethod → make_zombie() → CodeCache::free()
  → nmethod 对象本身等 GC 回收
  状态: 彻底清除

★★ OSR 特例：长循环方法的编译路径
  如果方法入口只被调一次，但内部有长循环:
    → _invocation_counter 可能永远达不到阈值
    → 但 _backedge_counter 会持续递增
    → TieredThresholdPolicy::loop_event() → OSR 编译
    → 只编译循环体，生成 osr_nmethod (entry_bci != InvocationEntryBci)
    → 在栈上直接替换当前解释器帧为 OSR 编译帧
```

### 1.3 CompilerThread 的创建时机

```cpp
// thread.cpp — create_vm() 中 (顺序体现依赖关系):
//
// ...初始化 SystemDictionary, Universe...
// ...init_globals() -> compilationPolicy_init()  ★ 决定 Tiered/Non-Tiered
//    policy->initialize() → 设置 _c1_count / _c2_count
//
// ...ServiceThread::initialize()    // ★ 先创建 ServiceThread
// ...ReferenceProcessor 初始化       //   为 JVMTI agent loading 准备
//
// CompileBroker::compilation_init_phase1()   // ★ 创建 CompilerThread(s)
//   → init_compiler_sweeper_threads() // compileBroker.cpp:864
//     → 创建 _c2_compile_queue + _c2_count 条 C2 线程
//     → 创建 _c1_compile_queue + _c1_count 条 C1 线程
//     → 创建 CodeCacheSweeperThread (1 条)
//
// ...JSR292 (MethodHandle) 初始化      // ★ 在编译线程之后
// ...JVMTI agent 加载
// ...SystemDictionary::initialize() -> 加载 java.lang.Class, Thread, etc.
```

**创建顺序的核心约束**：CompilerThread 必须在 JSR292 之前创建（因为 MethodHandle intrinsics 需要编译），但在 ServiceThread 之后（因为 ServiceThread 管理 JVMTI deferred events）。

### 1.4 ★ 为什么 C1 和 C2 必须是两条独立线程？

这不是"能不能合并"的问题——如果合并会导致性能灾难：

```
如果合并为一条线程:
  假设 C2 编译一个复杂方法需要 3 秒 (深度内联 + 逃逸分析 + 循环展开)
  → 在此期间，新加载类的所有方法继续解释执行（~50x 慢于 C1）
  → 用户感知：启动后 3 秒内应用响应延迟剧增
  → 更糟: C2 可能连续编译多个热点方法 → 累计阻塞数十秒

正确设计（两条独立线程，按 1:2 比例分配）:
  4 核机器: _c1_count=1, _c2_count=2
  → C1 线程: 每个方法 10-50ms → 启动阶段快速覆盖大量方法
  → C2 线程: 每个方法 100ms-5s → 后台慢慢优化热点方法
  → 不互相阻塞 → 分层渐进优化，平滑过渡

追问: 为什么 C1:C2 = 1:2 的默认比例？
  → 公式: N = max(log2(NCPUS)+1, 2) × CICompilerCountPerCPU
  → 4 核: N = max(3, 2) × 1 = 3 → c1=ceil(3×0.33)=1, c2=2
  → 因为 C2 编译更耗时 → 需要更多线程消化队列 → 避免 C2 成为瓶颈
```

**时延敏感型 (C1) vs 吞吐优先型 (C2)** — 这是 Tiered Compilation 的核心设计哲学。C1 的编译速度确保启动响应；C2 的编译质量确保长期吞吐。

---

## §二 ★★ CompileBroker 编译调度系统

### 2.1 编译触发：从 counter++ 到 compile_method()

```
谁决定编译哪个方法？不是随机、不是轮询、不是定时器！

触发入口在解释器执行过程中:

  方法调用路径:
    TemplateInterpreter::invoke_return_entry()
      → InterpreterRuntime::frequency_counter_overflow()  // ★ 不是每次调用都触发!
        → 只有 (counter & invoke_mask) == 0 时才触发
        → 默认 Tier0InvokeNotifyFreqLog=10 → mask = 2^10-1 = 1023
        → 即每 ~1024 次调用才通知一次 Runtime（性能优化）
      → CompilationPolicy::event(method, ...)
        → TieredThresholdPolicy::event()  // Tiered 模式
          → method_invocation_event() 或 method_back_branch_event()

  循环回边路径 (OSR):
    每次循环回边 → InterpreterRuntime::frequency_counter_overflow()
      → 同上 event() → method_back_branch_event()

★★ InvocationCounter 的位域设计（不是简单的 int 自增）:
  _counter 是 32 位位域: [count 29位][carry 1位][state 2位]
  每次递增 +8 (count_increment = 1 << count_shift = 8)，因为低 3 位被 state+carry 占用

  carry 位是粘性标志：一旦 count 溢出过一次，carry 永久置 1
    → TieredThresholdPolicy::set_carry_if_necessary() 将 carry=1 视为"无限热"
    → 跳过后续计数检查，直接触发更高层级的编译

  阈值也是 << count_shift 的: InterpreterInvocationLimit = 10000 << 3 = 80000
    → 所以"实际计数器值 / 8"才等于"调用次数"
    → 计数器回绕（32bit overflow）后 carry 位保证不会丢失编译机会
```

#### 2.1.1 Non-Tiered 模式: SimpleCompPolicy

```cpp
// compilationPolicy.cpp — SimpleCompPolicy
// 只有 解释→C2 两步，没有 C1 中间层

void SimpleCompPolicy::method_invocation_event(const methodHandle& m, JavaThread* thread) {
  // 1. 获取计数器（在 MethodCounters 中）
  int hot_count = m->invocation_count();  // 方法调用次数
  reset_counter_for_invocation_event(m);  // 计数器减半（防止频繁触发）

  // 2. 阈值判断
  const int comp_level = CompLevel_highest_tier;  // = Level 4 (C2)
  if (hot_count >= CompileThreshold) {  // 默认 10000
    // 3. 提交编译请求
    CompileBroker::compile_method(m, InvocationEntryBci, comp_level,
                                  m, hot_count, "hot method", thread);
  }
}

// 关键设计: ★ 为什么计数器减半而不是清零?
// ──────────────────────────────────────────────────────
// 清零 → 一次性峰值触发编译 → 之后方法冷却 → 浪费 CodeCache + 无法重编译
// 减半 → 低通滤波器效果:
//   持续热点 → 很快再次达到阈值 → 不断提交编译请求(各层级渐进)
//   非持续热点 → count 逐次衰减(5000→2500→1250→...) → 不再占用编译资源
//
// 这保证了编译器线程的 CPU 时间只投给"真正的热点方法"
```

#### 2.1.2 ★ Tiered 模式: TieredThresholdPolicy — 为什么默认 0→3→4？

```cpp
// tieredThresholdPolicy.hpp 头注释中写得很清楚 (L37-L82):
//
// "Levels 0, 2 and 3 periodically notify the runtime about the current
//  value of the counters. These notifications are used by the policy
//  to decide what transition to make."
//
// 默认路径: Level 0 (解释) → Level 3 (C1+完整profiling) → Level 4 (C2)
//
// 为什么跳过 Level 1 和 Level 2?
// ──────────────────────────────────────────────────────────
// Level 1 = C1 无 profiling    → 数据太少，C2 不敢做激进优化
// Level 2 = C1 轻量 profiling   → 只有调用计数，没有类型分布
//
// Level 3 = C1 完整 profiling   → 分支概率 + 类型 feedback + 调用计数
// → C2 需要这些数据做:
//    - CHA 去虚化: "这个 call site 95% 调 ArrayList → 直接内联"
//    - 逃逸分析: "这个对象从未逃逸 → 栈上分配"
//    - 分支预测: "if 分支 80% 走 true → 按此重排指令"

// 0→3 的数学条件 (tieredThresholdPolicy.cpp:55-57):
template<CompLevel level>
bool call_predicate_helper(int i, int b, double scale, Method* method) {
  // level = CompLevel_none (Level 0 → Level 3 使用此 predicate)
  // i = invocation counter, b = backedge counter
  return (i >= Tier3InvocationThreshold * scale) ||
         (i >= Tier3MinInvocationThreshold * scale && i + b >= Tier3CompileThreshold * scale);
}

// 默认值:
// Tier3InvocationThreshold = 200    → "调用 200 次就触发 C1"
// Tier3MinInvocationThreshold = 100 → "至少 100 次才能触发"
// Tier3CompileThreshold = 2000      → "如果调用不够多但循环够多 (i+b>=2000)"
//
// scale = queue_size_X / (TierXLoadFeedback * compiler_count_X) + 1
//  → 编译器越忙，scale 越大 → 阈值越宽容 → 减少新编译请求

// 3→4 的数学条件 (tieredThresholdPolicy.cpp:58-60):
//   CompLevel_full_profile = Level 3
// 使用 Tier4* 阈值（而非 Tier3*）:
//   Tier4InvocationThreshold = 5000
//   Tier4MinInvocationThreshold = 2000
//   Tier4CompileThreshold = 15000
//  → 要求热点更充分才触发 C2（因为 C2 编译代价更高）

// ★★★ 完整决策树 — common() 函数 (tieredThresholdPolicy.cpp:716-790):
//
// CompLevel_none (L0 — 解释器):
//   → 先递归检查: 如果以 L3 为起点会直接跳到 L4，则 L0→L4 (跳过 C1!)
//   → elif call_predicate 满足:
//       if C2_queue > Tier3DelayOn * c2_count → L2 (C2拥堵, 先缓冲区)
//       else → L3 (正常路径 0→3)
//
// CompLevel_limited_profile (L2):
//   → if 解释器已完成 profiling → L4 (直接跳到 C2)
//   → elif C2_queue ≤ Tier3DelayOff && predicate 满足 → L3 (恢复 profiling)
//   → else → L4 (没什么值得 profile 的)
//
// CompLevel_full_profile (L3):
//   → if is_trivial(method) → L1 (getter/setter, C1=C2 没区别)
//   → elif mdo_predicate 满足 → L4 (profiling 充分，触发 C2)
//     ★ 注意: 3→4 用的是 MDO 的计数器，不是 MethodCounters 的!
//     ★ MDO 计数器排除了 profiling 开销中的重复计数，更准确
//   → elif 没什么值得继续 profile → L4
//
// ★★★ 0→2 而不是 0→3 的条件 (Tier3Delay* 背压机制):
//   当 C2 队列太满 (C2 queue / c2_count > Tier3DelayOn)
//   → policy 不再做 0→3，改做 0→2 (轻量 C1 先过渡)
//   等 C2 队列减轻 (C2 queue / c2_count < Tier3DelayOff)
//   → 恢复 0→3 行为
//   这是"背压"机制 — 用 C1 轻度优化避免 C2 队列爆炸
//   ★ Level 2 比 Level 3 快约 30% (无 profiling 写入 MDO 的开销)
```

### 2.2 ★★ OSR (On-Stack Replacement) — _backedge_counter 的独立编译路径

为什么无限循环的方法也能被编译？因为 OSR 走的是 `_backedge_counter` 路径，和 `_invocation_counter` 无关：

```
问题场景:
  void busyLoop() {
    while (true) {
      doWork();  // 循环体执行 100 万次，但 busyLoop 只被调用 1 次
    }
  }
  → MethodCounters::_invocation_counter = 1 (永远不会 > CompileThreshold)
  → 但 _backedge_counter = 1000000

OSR 触发机制:
  每次循环回边 → _backedge_counter++ (原子递增)
  → 超过 loop_predicate_helper(CompLevel_none):
      b >= Tier3BackEdgeThreshold * scale  (默认 ~14000 次回边)
  → TieredThresholdPolicy::loop_event() → 目标 OSR Level 3
  → CompileBroker::compile_method(method, osr_bci, level=3, ...)
    → osr_bci = 循环头的字节码偏移 (非 -1!)
  → C1 CompileThread 编译 → 只编译循环体 → osr_nmethod
  → osr_nmethod._entry_bci = osr_bci (≠ InvocationEntryBci!)

OSR 帧替换:
  → 下次循环回边时，解释器检测到 osr_nmethod 已就绪
  → 在当前栈上把解释器帧替换为 OSR 编译帧
  → "在线替换" — 不等方法退出，不等下次调用

OSR vs 标准编译的区别:
  标准编译: _invocation_counter 触发 → 编译整个方法 → 下次调用生效
  OSR 编译:  _backedge_counter 触发  → 只编译循环体   → 当前执行中生效
```

关键源码验证：

```cpp
// tieredThresholdPolicy.cpp:66-81
template<CompLevel level>
bool loop_predicate_helper(int i, int b, double scale, Method* method) {
  switch(level) {
  case CompLevel_none:
  case CompLevel_limited_profile:
    return b >= Tier3BackEdgeThreshold * scale;   // OSR → Level 3
  case CompLevel_full_profile:
    return b >= Tier4BackEdgeThreshold * scale;   // OSR → Level 4
  }
  return true;
}

// nmethod.hpp:63 — 区分 OSR nmethod:
int _entry_bci;  // != InvocationEntryBci if this nmethod is an OSR method

// nmethod.hpp:270:
bool is_osr_method() const { return _entry_bci != InvocationEntryBci; }

// nmethod.hpp:418:
int osr_entry_bci() const { assert(is_osr_method(), "wrong kind"); return _entry_bci; }
address osr_entry() const { assert(is_osr_method(), "wrong kind"); return _osr_entry_point; }
```

### 2.3 CompileBroker::compile_method() — 任务创建与入队

```cpp
// compileBroker.hpp:296-302 — 对外接口
static nmethod* compile_method(const methodHandle& method,
                               int osr_bci,         // -1 = 标准编译, ≥0 = OSR
                               int comp_level,       // 目标 CompLevel
                               const methodHandle& hot_method,
                               int hot_count,
                               CompileTask::CompileReason compile_reason,
                               Thread* thread);

// 内部流程 (compile_method_base → compile_method):
//
// Step 1: 防重复检查
//   检查 method 是否已在某个编译队列中 (method->queued_for_compilation())
//   检查是否已有相同 (method, comp_level, osr_bci) 的编译完成
//
// Step 2: 创建 CompileTask
//   create_compile_task(queue, compile_id, method, osr_bci, comp_level, ...)
//
// Step 3: 选择队列 + 入队
//   compile_queue(comp_level) → c1_compile_queue 或 c2_compile_queue
//   → queue->add(task)
//     → 尾插法 (追加到 _last)
//     → method->set_queued_for_compilation()
//     → MethodCompileQueue_lock->notify_all()  ★ 唤醒编译器线程
//
// Step 4: 如果 blocking=true → 等待编译完成
//   wait_for_completion(task) — 调用线程阻塞直到编译结束
```

```cpp
// compileBroker.cpp:366-399 — CompileQueue::add() 尾插法
void CompileQueue::add(CompileTask* task) {
  assert(MethodCompileQueue_lock->owned_by_self(), "must own lock");
  task->set_next(NULL);
  task->set_prev(NULL);
  if (_last == NULL) {
    _first = task; _last = task;
  } else {
    _last->set_next(task);  // 追加到队尾
    task->set_prev(_last);
    _last = task;
  }
  ++_size;
  task->method()->set_queued_for_compilation();  // 标记"在队列中"
  MethodCompileQueue_lock->notify_all();  // ★ 唤醒等待的 CompilerThread
}
```

### 2.4 ★★ compiler_thread_loop() 主循环逐行分析

```cpp
// compileBroker.cpp:1828-1928
void CompileBroker::compiler_thread_loop() {
  CompilerThread* thread = CompilerThread::current();
  CompileQueue* queue = thread->queue();  // ★ 每条线程绑定一个队列 (C1 或 C2)
  ResourceMark rm;

  // ===== 初始化阶段 (只执行一次) =====

  // Step 0: 初始化 ciObjectFactory (首个线程执行)
  {
    ASSERT_IN_VM;
    MutexLocker only_one(CompileThread_lock, thread);
    if (!ciObjectFactory::is_initialized()) {
      ciObjectFactory::initialize();  // ★ 建立 ciMethod/ciKlass 对象池
    }
  }

  // Step 1: 初始化编译器运行时
  if (!init_compiler_runtime()) {
    return;  // 初始化失败 → 线程退出 (如 CodeCache 空间不足)
  }

  thread->start_idle_timer();

  // ===== 主循环: 永不退出的编译循环 =====

  while (!is_compilation_disabled_forever()) {  // ★ 守护条件
    HandleMark hm(thread);

    // ★★★ Step 2: 阻塞等待任务 (核心)
    CompileTask* task = queue->get();
    // 内部: while(_first==NULL) → MethodCompileQueue_lock->wait(5s)
    // 被 CompileQueue::add() 中的 notify_all() 唤醒
    // ★ 等待期间 safepoint check 开启 (!_no_safepoint_check_flag=true)
    //   → GC 发起 safepoint 时编译器线程会先响应 safepoint，再继续 wait

    if (task == NULL) {
      // DynamicNumberOfCompilerThreads: 如果长时间空闲 → 可以退出
      if (UseDynamicNumberOfCompilerThreads) {
        MutexLocker only_one(CompileThread_lock);
        if (can_remove(thread, true)) {
          return; // ★ 此线程退出 (空闲编译器线程回收)
        }
      }
      continue; // 超时唤醒但无任务 → 继续等待
    }

    // ★★★ Step 3: safepoint 协调
    // CompileTaskWrapper 构造时会调用 StackWatermark 检查
    // 如果 GC 正在请求 safepoint → 编译器线程响应
    CompileTaskWrapper ctw(task);
    nmethodLocker result_handle;
    task->set_code_handle(&result_handle);
    methodHandle method(thread, task->method());

    if (method()->number_of_breakpoints() == 0) {
      if (CompileBroker::should_compile_new_jobs()) {
        // ★★★ Step 4: 执行编译
        invoke_compiler_on_method(task);
        // 内部详细流程:
        //   1. 创建 ciEnv (编译器环境)
        //   2. 获取 ciMethod (通过 ciEnv::get_method_from_handle)
        //   3. ★ ThreadToNativeFromVM ttn(thread)
        //      → 线程状态 _thread_in_vm → _thread_in_native
        //      → GC safepoint 不会等待编译器线程（编译可持续数百 ms）
        //      → 如果留在 _thread_in_vm → 每次 GC 都等编译器 → STW 爆炸
        //   4. comp->compile_method(&ci_env, target, osr_bci, directive)
        //      → C1: c1_Compiler::compile_method()
        //      → C2: C2Compiler::compile_method()
        //   5. ~ThreadToNativeFromVM → 恢复 _thread_in_vm
        //   6. post_compile() — 安装 nmethod
        thread->start_idle_timer();  // 重置空闲计时器
      } else {
        method->clear_queued_for_compilation();
        task->set_failure_reason("compilation is disabled");
      }
    }
  }

  shutdown_compiler_runtime(thread->compiler(), thread);
}
```

**关键设计点**：

1. **阻塞等待而非轮询**：`queue->get()` 在 `MethodCompileQueue_lock` 上 `wait()`，不消耗 CPU。编译器线程唯一被唤醒的时机是 `CompileQueue::add()` 中的 `notify_all()`。

2. **wait 期间 safepoint check 开启**：`MethodCompileQueue_lock->wait(!_no_safepoint_check_flag, 5*1000)` — `!_no_safepoint_check_flag` = `!true` = `false` → `wait(no_safepoint_check=false)` 意味着 safepoint check 开启。wait 期间如果 GC 发起 safepoint，编译器线程**先响应 safepoint、再继续 wait**。

3. **编译期间线程状态为 native**（`ThreadToNativeFromVM`）：编译器执行 `comp->compile_method()` 时线程处于 `_thread_in_native` 状态，GC safepoint 不会等待编译器线程。如果线程留在 `_thread_in_vm` 状态，每次 GC 都要等编译器编译完一个方法才能进入 STW——这意味着 STW 时间可能长达数秒。

4. **空闲线程可退出**（DynamicNumberOfCompilerThreads）：如果 compiler thread 长时间（5s+）没有任务，且队列为空，线程可以退出。CompilerThread 的数量是**动态可伸缩**的。

### 2.5 ★ CompileTask 完整生命周期

```
CompileTask 生命周期 6 个阶段:

  [1. 创建] CompileBroker::create_compile_task(queue, ...)
    → 检查是否已有相同编译 task 在队列中 (method->queued_for_compilation())
    → 从 CompileTask freelist 或 C-Heap 分配 (非 Java 堆)
    → 设置: _method, _osr_bci, _comp_level, _compile_id, _hot_method, _hot_count

  [2. 入队] compile_queue->add(task)
    → 尾插法追加到双向链表
    → method->set_queued_for_compilation() — 防重复标记

  [3. 出队] queue->get() → CompilationPolicy::select_task() → task->select_for_compilation()
    → ★ Tiered 模式下不是 FIFO!
    → select_task() 按 event rate (d(i+b)/dt) 排序 — "最热的方法先编译"
    → stale 方法（长时间不活动）被移除

  [4. 编译] invoke_compiler_on_method(task)
    → 成功 → nmethod 生成 → task->set_code(nm)
    → 失败 → task->set_failure_reason():
      - transient (CodeCache 满) → 可能重试
      - permanent (类结构不支持) → 方法标记为不可编译

  [5. 安装] post_compile():
    → task->mark_success()
    → CodeCache 已经 commit (在 comp->compile_method() 内部)
    → 旧 nmethod → make_not_entrant()
    → 日志记录 (LogCompilation)

  [6. 清除] ~CompileTaskWrapper → task 归还 freelist 或 C-Heap 释放

  ★ 特殊情况: 如果编译失败且是可重试类型 → task 可能重新入队
```

---

## §三 ★★ MethodData profiling — C1→C2 的数据桥梁

### 3.1 MethodCounters vs MethodData — 两个独立对象

这是全文最重要的概念区分：

| 维度 | MethodCounters | MethodData |
|------|---------------|------------|
| **继承** | `Metadata` (Metaspace) | `Metadata` → 但数据本身在 Java 堆 |
| **分配位置** | Metaspace (不受 GC 移动) | TLAB (Java 堆, GC 会移动) |
| **分配时机** | `Method::build_method_counters()` — 方法被调一定次数后 | `Method::build_method_data()` — 解释器持续执行后 |
| **核心字段** | `_invocation_counter`, `_backedge_counter` | `_data[]` (DataLayout 数组), `_invocation_counter`(独立) |
| **用途** | 决定"是否编译" (阈值判定) | 决定"如何优化" (分支概率, 类型分布, 去虚化) |
| **写入者** | 解释器原子递增 | 解释器 + C1 机器码中的 profiling 指令 |
| **读取者** | `TieredThresholdPolicy` 策略评估 | C2 编译器做激进优化决策 |

```cpp
// methodCounters.hpp:35-72 — MethodCounters 定义
class MethodCounters : public Metadata {
  InvocationCounter _invocation_counter;   // ★ 每次方法入口递增
  InvocationCounter _backedge_counter;     // ★ 每次循环回边递增
  int _interpreter_invocation_limit;       // per-method CompileThreshold
  int _interpreter_backward_branch_limit;  // per-method OSR threshold
  int _nmethod_age;                        // Sweeper 热度检测

#ifdef TIERED
  float _rate;                    // Events per millisecond
  jlong _prev_time;               // Last rate acquisition time
  u1    _highest_comp_level;      // 此方法达到的最高编译级别
  u1    _highest_osr_comp_level;  // OSR 版本的最高编译级别
#endif
};

// ★ 构造函数中 (methodCounters.hpp:74-113):
// _interpreter_invocation_limit = compile_threshold << count_shift
//   → 默认: 10000 << 3 = 80000 (实际计数器值需要这么高)
//   → 解释器每 N 次调用才检查一次 (由 invoke_mask 控制)
// _interpreter_backward_branch_limit = (10000 * 140 / 100) << shift
//   → 默认 OnStackReplacePercentage=140 → OSR 阈值更高
```

```cpp
// methodData.hpp:44-60 — MethodData 的设计哲学
// "The MethodData object collects counts and other profile information
//  during zeroth-tier (interpretive) and first-tier execution."
//
// "All data in the profile is approximate. It is expected to be accurate
//  on the whole, but the system expects occasional inaccuracies,
//  due to counter overflow, multiprocessor races, space limitations..."
//
// ★ 关键: profiling 数据是近似值! 不需要精确 — 因为 C2 只是用它做启发式决策

class MethodData : public Metadata {
  Method*   _method;              // 指向被监控的方法
  int       _compiler_counters[]; // C1/C2 嵌入的计数器
  intptr_t  _data[1];            // ★ DataLayout 数组 (可变长度)
  int       _size;                // _data[] 的字节数
  int       _invocation_counter;  // ★ 和 MethodCounters 独立!
  int       _backedge_counter;    // ★ 独立计数
  int       _creation_mileage;    // "出生里程" — 评估 profiling 成熟度
};
```

### 3.2 MethodData 的内部结构

```
MethodData 内存布局:
┌──────────────────────────────────────────────────┐
│ Method* _method              (8 bytes)           │ ← 指向 Metaspace 中的 Method
│ int _size                    (4 bytes)           │
│ int _invocation_counter      (4 bytes)           │ ← MDO 自己的调用计数
│ int _backedge_counter        (4 bytes)           │
│ int _creation_mileage        (4 bytes)           │ ← 分配时的时间戳
│ int _invocation_counter_old  (4 bytes)           │
│ ...                                              │
│ DataLayout _data[0]:                             │ ← 可变长度数组
│   ┌─ header: {u1 tag, u1 flags, u2 bci, u4 traps}│
│   └─ cells[]: 每格 8 bytes                       │
│                                                   │
│   ★ TypeProfileData:                             │
│     ┌─ tag = receiver_type_data                  │
│     ├─ bci = call site 的字节码偏移               │
│     └─ cells:                                     │
│        ├─ cell[0]: 调用总次数                     │
│        ├─ cell[1]: receiver 类型 A 的次数         │
│        ├─ cell[2]: receiver 类型 B 的次数         │
│        └─ ...最多 8 种类型                        │
│                                                   │
│   ★ BranchData:                                  │
│     ┌─ tag = branch_data                         │
│     ├─ bci = if 指令的字节码偏移                  │
│     └─ cells:                                     │
│        ├─ cell[0]: 走到此分支的次数               │
│        └─ cell[1]: 没走到此分支的次数             │
│                                                   │
│   ★ VirtualCallData:                             │
│     类似 TypeProfileData, 但用于虚调用点          │
│                                                   │
└──────────────────────────────────────────────────┘
```

### 3.3 MethodData 的创建时机

```
MethodData 不是在 C1 编译时分配的！分配时机在解释执行期间:

  解释器执行方法 → invocation_counter 持续递增
  → TieredThresholdPolicy::should_create_mdo() 返回 true
  → Method::build_method_data()
    → MethodData::allocate(mh, CHECK)
      → 在 TLAB 中分配 (和普通 Java 对象一样!)
      → _invocation_counter = 0
      → _backedge_counter = 0
      → _creation_mileage = 当前编译里程
  → 解释器遇到 call site → MethodData::bci_to_data(bci) → 写类型信息

  后续 C1 编译时:
  → MethodData 已存在 (有解释器填充的基础数据)
  → C1 在生成的机器码中嵌入 profiling 指令 → 继续填充 MethodData
  → C2 编译时 → 拿到的是 (解释器 + C1) 共同填充的完整数据
```

### 3.4 ★ C1 如何在机器码中嵌入 profiling 自增指令

```
C1 编译器在生成代码时，为每个 call site / branch 生成类似以下指令:

  // 伪代码: C1 为虚调用点生成的 profiling 代码
  mov rax, [rsi + MethodData_offset]   // 找到 TypeProfileData 的 cell 地址
  lock inc qword [rax + cell_offset]   // ★ 原子递增该 cell
  // 注意: lock inc 确保多线程并发安全

不需要 C1 线程参与 — 这是生成好的机器码在执行时做的事。
C1 的输出不仅是机器码，还有一个持续被填充的 MethodData 对象。
```

### 3.5 ★ C2 如何读 profiling 数据做决策

```
C2 编译过程:

  Step 1: 构建优化 IR (Ideal Graph)
    → ciEnv::get_method_from_handle() → ciMethod

  Step 2: 读取 profiling 数据
    → MethodData::bci_to_data(bci) → 获取特定 bci 的 DataLayout
    → 例如 VirtualCallData:
        receiver_count[ArrayList] = 95
        receiver_count[LinkedList] = 5
        → 识别为"单态调用" (monomorphic call)

  Step 3: 基于 profiling 做激进优化
    → CHA 去虚化:
        "95% 是 ArrayList → 生成 if (receiver == ArrayList) → inline ArrayList.method()"
        "如果 receiver 是其他的 → uncommon trap → deoptimize"
    → 逃逸分析:
        TypeProfileData 显示此对象从未逃逸 → 栈上分配
    → 分支预测:
        BranchData 显示 80% 走 true → 重排基本块 → 减少分支预测失败
    → 内联决策:
        "调用次数 > MaxInlineSize → 内联"
        "调用次数太少 → 不内联 (节省 CodeCache)"

  ★ C2 的"激进"必须有退路:
    CHA 去虚化的退路是 uncommon trap → deoptimize → 回到解释器
    "激进"是基于 profiling 数据的信心 — 95% 确率才敢走捷径
```

---

## §四 ★ ciEnv 编译接口层 + CompileTask 完整状态机

### 4.1 ★ ciEnv — 编译器和 JVM 之间的隔离墙

```
为什么 C1/C2 不能直接读 JVM 的 oop 对象?

原因 1: oop 是原始指针 → GC 可能移动对象
  → 编译器正在读 Method._constMethod → Full GC compact → Method 移动
  → 编译器拿到 stale pointer → crash

原因 2: JVM 内部结构（Method, Klass, ConstantPool）是 HotSpot 专有格式
  → 如果每个编译器都直接 depend on HotSpot 内部结构 → 难以维护
  → JVMCI (Graal) 就做不了

ciEnv 的设计:
  ┌─────────────────────────────────────────────────────┐
  │                    ciEnv                             │
  │  ┌─────────┐  ┌──────────┐  ┌──────────────┐        │
  │  │ ciMethod │  │ ciKlass  │  │ ciObjectFactory│      │
  │  │ (代理)   │  │ (代理)   │  │ (对象池)      │      │
  │  └────┬─────┘  └────┬─────┘  └──────┬───────┘      │
  │       │             │               │                │
  │       ↓             ↓               ↓                │
  │  ┌────────┐  ┌──────────┐  ┌─────────────────┐     │
  │  │ Method │  │ InstanceKlass│  │ JVM oop objects │   │
  │  │(oop)   │  │(oop)        │  │                 │   │
  │  └────────┘  └──────────┘  └─────────────────┘     │
  └─────────────────────────────────────────────────────┘

ciEnv 的三重职责:
  1. 转换: JVM oop → ci 对象 (make_method, make_klass)
  2. 同步: safepoint 后重新验证 ci 对象 (GC 可能移动了原始 oop)
  3. 缓存: ciObjectFactory 管理 ci 对象池, 避免重复创建

★ ciEnv 的创建 (invoke_compiler_on_method):
  ciEnv ci_env(task);
  assert(thread->env() == &ci_env, "set by ci_env");
  // 编译器线程的 _env 字段指向当前 ciEnv
  // ~CompileTaskWrapper 时清除

// compileBroker.cpp:2188-2218 — C1/C2 调用:
ciEnv ci_env(task);
ciMethod* target = ci_env.get_method_from_handle(target_handle);
comp->compile_method(&ci_env, target, osr_bci, directive);
// ★ 编译器只能通过 ciEnv 和 ciMethod 间接访问 JVM 对象!
```

### 4.2 ciObjectFactory — ci 对象池

```
ciObjectFactory 维护各种 ci 对象的缓存:
  - ciMethod 池 (避免为同一 Method 重复创建 ciMethod)
  - ciKlass 池 (避免为同一 Klass 重复创建 ciKlass)
  - ciInstance 池 (缓存常用常量对象)

初始化时机:
  compiler_thread_loop() 启动后，第一个 CompilerThread 获得 CompileThread_lock:
    ciObjectFactory::initialize()
  → 预加载常用类型 (java.lang.Object, java.lang.String, etc.)

safepoint 同步:
  GC 后 ci 对象可能"过期" → ciEnv::ensure_metadata_alive()
  → 重新从 JVM 获取元数据
```

---

## §五 ★★ CodeCacheSweeperThread — nmethod 的"GC"

### 5.1 nmethod 的三种死亡状态

```
nmethod 状态机 (nmethod.hpp:128 — _state 字段):

  ┌──────────┐  新编译完成   ┌──────────┐
  │ not_installed │ ────────→ │  in_use  │
  └──────────┘               └────┬─────┘
                                  │
                  方法重新编译/     │
                  deoptimization   │
                                  ↓
                             ┌──────────────┐
                             │ not_entrant  │ ← 不再接受新调用
                             └──────┬───────┘
                                    │
                    所有线程离开      │
                    此 nmethod        │
                                    ↓
                             ┌──────────┐
                             │  zombie  │ ← 可以释放 CodeCache 空间
                             └────┬─────┘
                                  │
                    unload (class    │
                    unloading)      │
                                  ↓
                             ┌──────────┐
                             │ unloaded │ ← 彻底卸载
                             └──────────┘

状态判断 (nmethod.hpp:320-325):
  bool is_in_use()      const { return _state <= in_use; }    // ★ ≤ 0 (含 not_installed=-1)
  bool is_alive()       const { return _state < zombie; }     // ★ < 3 (in_use + not_entrant)
  bool is_not_entrant() const { return _state == not_entrant; }
  bool is_zombie()      const { return _state == zombie; }
  bool is_unloaded()    const { return _state == unloaded; }

状态枚举值 (compiledMethod.hpp:188-196):
  _state 类型为 volatile signed char
  not_installed = -1  (正在构造，只有构造者能访问)
  in_use        =  0  (可执行的 nmethod)
  not_used      =  1  (★ 标记为不可进入，但可复活——调用计数不够时 C2→C1 回退使用)
  not_entrant   =  2  (标记去优化，但还有活跃调用栈帧——等栈帧全部退出后转 zombie)
  zombie        =  3  (所有线程已离开，可释放 CodeCache)
  unloaded      =  4  (类卸载，立即转为 zombie)
  ★ is_in_use() 返回 _state ≤ 0 → not_installed(-1) 和 in_use(0) 都满足
  ★ is_alive()  返回 _state < 3 → in_use(0), not_used(1), not_entrant(2) 都满足
  ★ not_used=1 不是"留空隔离"，而是独立的状态——比 not_entrant(2) 更轻量，保留复活可能
```

### 5.2 ★ Sweeper 主循环

```cpp
// sweeper.cpp:265-278 — sweeper_loop()
void NMethodSweeper::sweeper_loop() {
  bool timeout;
  while (true) {
    {
      ThreadBlockInVM tbivm(JavaThread::current());  // ★ 转为 VM 线程状态
      MutexLockerEx waiter(CodeCache_lock, Mutex::_no_safepoint_check_flag);
      const long wait_time = 60*60*24 * 1000;  // 24 小时!
      timeout = CodeCache_lock->wait(Mutex::_no_safepoint_check_flag, wait_time);
      // ★ 不是定时扫描! 24h 只是"永不超时"的安全网
      // 正常运行时被 NMethodSweeper::notify() 或 force_sweep() 唤醒
    }
    if (!timeout) {
      possibly_sweep();  // ★ 执行增量清扫
    }
  }
}

// ★★★ 两阶段清扫设计 — mark_active_nmethods() + sweep_code_cache()
//
// 阶段 1: mark_active_nmethods() — 在 safepoint 中调用
//   → 遍历所有 JavaThread 的栈帧
//   → 对栈上每个 nmethod → nm->mark_as_seen_on_stack()
//     → 设置 nm->_stack_traversal_mark = NMethodSweeper::_traversals
//   → _traversals++ (每次 safepoint 递增)
//
// 阶段 2: possibly_sweep() → sweep_code_cache() — 非 safepoint
//   → 遍历 CodeCache 中所有 nmethod
//   → 对每个 not_entrant nmethod:
//       if (nm->_stack_traversal_mark < _traversals)
//         → 上次 safepoint 没在任何栈上看到此 nmethod
//         → 可以安全转为 zombie → 释放 CodeCache 空间
//
// ★ 为什么 _stack_traversal_mark < _traversals 等价于"无人执行"?
//   每次 safepoint → _traversals++
//   所有正在执行的线程 → 必然在最后这次 safepoint 被 mark
//   如果 mark < current traversal → 说明上次 safepoint 没人跑这个方法
//
// 触发时机 (谁唤醒 sweeper):
//   CodeCache::allocate() 发现空间不足 → NMethodSweeper::notify(type)
//   → if (CodeCache::reverse_free_ratio >= aggressive_threshold)
//     → CodeCache_lock->notify() → 唤醒 sweeper_loop()
//   nmethod 被 make_not_entrant() → notify() → 立即尝试回收没用的 nmethod
//
// ★ 每次完整清理至少 3 次 sweep + 中间的 safepoint:
//   Sweep 1: in_use → not_entrant (标记)
//   等待 mark_active_nmethods() (at safepoint) 确认无人使用
//   Sweep 2: not_entrant → zombie (确认安全)
//   Sweep 3: zombie → flush (释放空间)
```

### 5.2b ★ make_not_entrant_or_zombie() — 状态转换的完整协议

```cpp
// nmethod.cpp:1161-1241 — 核心状态转换函数
bool nmethod::make_not_entrant_or_zombie(int state) {
  // ★ 防重入: 如果已是目标状态 → 直接返回 false
  if (_state == state) return false;

  nmethodLocker nml(this);
  methodHandle the_method(method());
  NoSafepointVerifier nsv;

  {
    // ★ 用 Patching_lock 保护（不是 CodeCache_lock!）
    //   Patching_lock 是编译器的专项锁，粒度小，不会和 GC 竞争
    MutexLockerEx pl(Patching_lock, Mutex::_no_safepoint_check_flag);

    // ★ 防竞争: 另一个线程可能已经做了这个转换
    if (_state == state) return false;

    // ★ 先 patch entry point → 指向 handle_wrong_method_stub
    //   所有新调用者自动跳转到 handle_wrong_method → 抛异常或 deopt
    if (!is_osr_method() && !is_not_entrant()) {
      NativeJump::patch_verified_entry(entry_point(), verified_entry_point(),
                  SharedRuntime::get_handle_wrong_method_stub());
    }

    // ★ not_entrant 转换前用 storestore() 屏障
    //   确保 _stack_traversal_mark 先于 _state 被 Sweeper 看到
    if (state == not_entrant) {
      mark_as_seen_on_stack();
      OrderAccess::storestore(); // ★ _stack_traversal_mark 和 _state 的排序
    }

    // ★ 简单赋值，不是 CAS — Patching_lock 已在手上
    _state = state;
  }

  // ★ 如果是 zombie → 通知 GC 取消注册此 nmethod 的 oops
  if (state == zombie && !is_unloaded()) {
    // 延迟到锁外执行（避免 Patching_lock 和 CodeCache_lock 死锁）
  }
}
```

**关键设计点**：

- **不是 CAS 而是 mutex**：`Patching_lock` 是编译器专用锁，粒度小，不会和 GC 的 `CodeCache_lock` 竞争导致死锁
- **先 patch entry point，再改 state**：调用者通过 `verified_entry_point` 跳转 → patch 后自动进 `handle_wrong_method_stub` → 安全停止调用
- **storestore() 屏障**：`mark_as_seen_on_stack()` 写 `_stack_traversal_mark`，`_state = state` 写状态。`storestore()` 确保 Sweeper 先看到 mark 后看到 state——如果顺序反了，Sweeper 可能漏掉这个 nmethod
- **not_used=1 是什么？**— JDK 源码注释: "not entrant, but revivable"（不可进入但可复活）。当 C2 编译失败回退到 C1、或调用计数不足时使用。与 not_entrant(2) 的区别: not_entrant 会等所有栈帧退出后转为 zombie 释放空间；not_used 保留了 nmethod 的 CodeCache 空间，可在未来重新激活。`is_alive()` 返回 `_state < 3` → not_used(1) 也是 alive。"值 1 留空"是错误理解。

### 5.3 ★ 为什么 Sweeper 不能嵌入编译器线程或 GC？

```
如果嵌入编译器线程:
  编译器编译新方法 → CodeCache 满 → 需要清理旧 nmethod
  → 但旧 nmethod 可能在等待所有线程离开 (not_entrant→zombie)
  → 如果线程 A 正在执行旧 nmethod → 不能清理
  → 编译器线程阻塞等待 → 可能死锁:
    编译器等清理 → 清理等线程退出 → 线程在等编译的新方法

如果嵌入 GC (如 G1 Remark 期间顺便清理):
  → Remark 是 STW 阶段 → 清理 nmethod 需要遍历 CodeCache
  → CodeCache 可能有数千个 nmethod → 遍历很耗时
  → STW 时间增长 → 用户感知延迟

正确设计（独立 Sweeper 线程）:
  → 被动 + 非阻塞: 能清多少清多少, 不能清的跳过
  → 不影响编译: Sweeper 不在关键路径上
  → 不影响 GC: STW 阶段代码不需要清理 CodeCache (只需要 mark_active_nmethods)
```

### 5.4 编译降级 — Deoptimization 的触发原因

```
四种 deoptimization 原因:

1. 类型假设失效 (最常见):
   C2 基于 "这个 call site 只调 ArrayList" 做了内联
   → 出现了 LinkedList 调用 → uncommon trap → deoptimize

2. 类层次变化:
   新加载的子类改变了 CHA (Class Hierarchy Analysis) 的假设
   → C2 的 devirtualization 决策失效

3. 依赖失效:
   nmethod 的 dependencies 中包含 "final 字段的值"
   → 反射修改了 final 字段 → 依赖失效 → deoptimize

4. 显式 deoptimization:
   通过 JVMTI / java.lang.invoke 等 API 显式请求 deoptimize

deoptimization 后果:
  → nmethod → make_not_entrant()
  → 当前栈帧 → 解释器帧 (重建解释器状态)
  → method->set_code(NULL) 或 set_code(C1_version)
  → 热度足够 → 重新走 0→3→4 路径
```

---

## §六 ★ 四线程对比: CompilerThread vs ServiceThread vs ReferenceHandler vs FinalizerThread

| 维度 | C2 CompilerThread | C1 CompilerThread | ServiceThread | ReferenceHandler |
|------|------------------|-------------------|---------------|-----------------|
| **创建时机** | create_vm → compilation_init_phase1 | 同上 | create_vm → ServiceThread::initialize | create_vm → Reference.\<clinit\> |
| **Java 优先级** | NearMaxPriority (~9) | NearMaxPriority (~9) | NearMaxPriority (~9) | MAX_PRIORITY (10) |
| **OS 优先级** | CriticalPriority 或 NearMaxPriority | 同上 | NearMaxPriority | MAX_PRIORITY |
| **栈大小** | **4MB** | **4MB** | ~1MB | ~1MB |
| **daemon** | true | true | true | true |
| **任务模型** | 从 CompileQueue 拉取 + 编译方法 | 同上 (支持任务窃取) | 5-condition 复合等待 | pending list 消费 (头插法) |
| **阻塞点** | `queue->get()` on MethodCompileQueue_lock | 同上 | `Service_lock->wait()` | `Heap_lock.wait()` |
| **为什么是 JavaThread** | 读 Method/ConstantPool/Class → 读堆对象 → 需 safepoint | 同上 | 读 Java 堆 + JVMTI agent | 需要执行 Java 方法 |
| **死亡后果** | 新方法无 C2 → 性能退化 (不崩溃) | 新方法无 C1 → 解释变慢 | JVMTI 事件不处理 + StringTable 不清理 | Cleaner 不执行 → Native OOM |
| **任务耗时** | 100ms ~ 5s | 10ms ~ 100ms | 不定 | ~μs 级别 |

**核心差异总结**：

- **CompilerThread 和 ServiceThread** 都是"后台服务线程" — 但它们设计哲学完全不同：ServiceThread 是**多路事件分发器**（一个线程处理 5 种不相关事务），CompilerThread 是**单一任务流水线**（多条线程专精编译）。
- **CompilerThread 和 ReferenceHandler** — 栈大小差异（4MB vs 1MB）揭示了它们的本质：CompilerThread 需要容纳 C2 编译时的深度递归（数百层方法内联 + IR 构建），而 ReferenceHandler 只做链表操作和 `enqueue()`。
- **CompilerThread 为什么是 JavaThread** — 和 [10-NonJavaThread] 对比：编译器必须读 Java 堆上的 `Method`、`ConstantPool`、`InstanceKlass` 对象。这些对象在 GC compact 阶段会移动。如果编译器是 NonJavaThread（不参与 safepoint），GC 移动对象期间编译器可能访问 stale pointer → crash。作为 JavaThread，编译器在 `compiler_thread_loop()` 的阻塞等待期间自动参与 safepoint。

---

## §七 GDB 验证 + 可证伪断言

### 7.1 GDB 验证命令（14 条）

```bash
# ──── 线程存在性验证 ────

# 断言 1: 验证 C1/C2 CompilerThread 存在
(gdb) info threads | grep "Compiler"
# 预期输出:
#   7    Thread 0x7f... (LWP 1234) "C2 CompilerThread0"
#   8    Thread 0x7f... (LWP 1235) "C1 CompilerThread0"

# 断言 2: 验证 Sweeper 线程存在
(gdb) info threads | grep "Sweeper"
# 预期输出:
#   9    Thread 0x7f... (LWP 1236) "Sweeper thread"

# ──── 队列深度验证 ────

# 断言 3: C1 编译队列深度
(gdb) p CompileBroker::_c1_compile_queue->size()
# 预期: 整数 (可能为 0, 表示没有等待编译的任务)

# 断言 4: C2 编译队列深度
(gdb) p CompileBroker::_c2_compile_queue->size()
# 预期: 整数

# ──── 编译进度验证 ────

# 断言 5: 当前编译 ID (递增计数器)
(gdb) p CompileBroker::_compilation_id
# 预期: 非 0 整数 (如 1234, 表示已完成编译的方法数量)

# ──── 栈大小验证 ────

# 断言 6: CompilerThread 的栈大小
(gdb) thread <CompilerThread_tid>
(gdb) p CompileBroker::_c1_count
# 预期: 1 (4 核机器)
(gdb) p CompileBroker::_c2_count
# 预期: 2 (4 核机器)

# ──── CodeCache 状态验证 ────

# 断言 7: CodeCache 中的 nmethod 数量
(gdb) p CodeCache::_number_of_blobs
# 预期: 非 0 (编译一段时间后)

# ──── nmethod 状态验证 ────

# 断言 8: 查看某个 nmethod 的状态
(gdb) p ((nmethod*)0x...)->_state
# 预期: 0 (in_use), 2 (not_entrant), 或 3 (zombie)
# ★ 注意: not_entrant=2 不是 1, zombie=3 不是 2!
# enum: not_installed=-1, in_use=0, not_entrant=2, zombie=3, unloaded=4

# 断言 9: 查看 nmethod 的编译级别
(gdb) p ((nmethod*)0x...)->_comp_level
# 预期: 3 (C1) 或 4 (C2)

# ──── 计数器验证 ────

# 断言 10: 查看 MethodCounters 的调用计数
(gdb) p ((MethodCounters*)0x...)->_invocation_counter
# 预期: 非 0 (方法已被调用多次)

# 断言 11: 对比 MethodData 的调用计数
(gdb) p ((MethodData*)0x...)->_invocation_counter
# 预期: 非 0 (和 MethodCounters 独立的值)

# ──── OSR 验证 ────

# 断言 12: 查看 OSR nmethod 的入口 bci
(gdb) p ((nmethod*)0x...)->_entry_bci
# 预期: != -1 (InvocationEntryBci) → 这是 OSR 编译
# 断言 12b: 验证 is_osr_method()
(gdb) p ((nmethod*)0x...)->is_osr_method()
# 预期: true (如果 _entry_bci != -1)

# ──── Sweeper 断点 ────

# 断言 13: 断点验证 Sweeper 触发
(gdb) break NMethodSweeper::possibly_sweep
(gdb) continue
# 预期: 在 CodeCache 使用率超阈值时断住

# 断言 14: 验证 c1/c2 线程数量比例
(gdb) p CompileBroker::_c1_count
(gdb) p CompileBroker::_c2_count
# 预期 (4 核): _c1_count=1, _c2_count=2
# 计算公式: N = max(log2(4)+1, 2) = 3, c1=ceil(3*0.33)=1, c2=3-1=2
```

### 7.2 可证伪断言（7 条）

**断言 1**: C2 CompilerThread crash → 所有方法留在 C1 Level → 性能下降约 30% 但 JVM 不崩溃
- 验证: `kill -9 <C2_pid>` → jstack 仍然显示 JVM 进程存活 → `PrintCompilation` 只有 Level 3 以下编译

**断言 2**: C1 CompilerThread crash → 新方法无 C1 过渡 → 解释执行等待 C2 编译 → 启动阶段性能显著下降，但长期峰值影响有限
- 验证: `kill -9 <C1_pid>` → jstack 无 C1 → Level 1-3 编译消失

**断言 3**: CodeCacheSweeperThread crash → CodeCache 满 → `handle_full_code_cache()` 被调用 → `UseCompiler=false` → 所有方法退回解释 → 性能退化 10-50x
- 验证: 持续编译新方法 + 启动时 `/tmp/hsperfdata_*/` 中查看 `sun.ci.total_compiles` 停滞

**断言 4**: 关闭 TieredCompilation (`-XX:-TieredCompilation`) → 只有 C2 CompilerThread（无 C1）→ 编译延迟增加但峰值可达
- 验证: `java -XX:-TieredCompilation -XX:+PrintCompilation` → 所有编译输出标记为 Level 4

**断言 5**: MethodData 对象在 Java 堆上 → Full GC compact 阶段 MethodData 会移动 → 编译器必须 safepoint
- 验证: GDB 在 GC 前后分别 `p method->_method_data`，验证地址变化

**断言 6**: MethodCounters 和 MethodData 是两个独立对象
- 验证: `Method::build_method_counters()` 调用时机早于 `build_method_data()`
- GDB: `p method->_method_counters` 和 `p method->_method_data` → 两个不同地址，可能 counters 有值但 data 为 NULL

**断言 7**: OSR 编译只编译循环体，不编译整个方法
- 验证: osr_nmethod 的 `_entry_bci` = 循环头 bci (非 -1)；`_osr_entry_point` 指向循环体代码而非方法头
- GDB: `p ((nmethod*)0x...)->_entry_bci` → 具体字节码偏移值

### 7.3 JVM 参数验证

```bash
# 验证 1: PrintCompilation — 方法编译日志
java -XX:+PrintCompilation -jar YourApp.jar
# 预期输出例:
#  1234  1       3       java.util.HashMap::getNode (153 bytes)
#  ↑     ↑       ↑       ↑
#  |     |       |       └─ 方法名和大小
#  |     |       └─ 编译级别 (3 = C1 + full profiling)
#  |     └─ 编译 ID (第 N 次编译)
#  └─ 时间戳 (ms)
#
# 进阶: PrintInlining — 内联决策日志
java -XX:+PrintCompilation -XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining MyApp
# 输出: @ 47  java.util.HashMap::hash (20 bytes)  inline (hot)

# 验证 2: TieredStopAtLevel — 限制编译级别
java -XX:TieredStopAtLevel=1 -jar YourApp.jar
# → jstack 中只有 C1 CompilerThread → 无 C2 → 所有方法停止在 Level 1

java -XX:TieredStopAtLevel=3 -jar YourApp.jar
# → jstack 中有 C1 CompilerThread → 无 C2 → 所有方法停止在 Level 3

# 验证 3: 关闭 Tiered
java -XX:-TieredCompilation -XX:+PrintCompilation -jar YourApp.jar
# → jstack 中只有 C2 CompilerThread → 无 C1 → 直接 Level 0→4

# 验证 4: CICompilerCount — 调整编译线程数
java -XX:CICompilerCount=4 -XX:+PrintCompilation -jar YourApp.jar
# → c1=2, c2=2 (4 × 0.33=1.32→2, 4-2=2)
```

---

## 核心数据结构速查表

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Tiered Compilation 数据流                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Method (Metaspace)                                                 │
│   ├─ _method_counters → MethodCounters (Metaspace)                  │
│   │   ├─ _invocation_counter  ← 解释器原子递增，决策"是否编译"         │
│   │   ├─ _backedge_counter    ← 同上，OSR 触发路径                   │
│   │   ├─ _interpreter_invocation_limit  ← 当前级别的编译阈值         │
│   │   └─ _highest_comp_level   ← 此方法达到的最高 CompLevel          │
│   │                                                                 │
│   ├─ _method_data → MethodData (Java Heap TLAB)                     │
│   │   ├─ _invocation_counter  ← MD 自己的调用计数 (独立)              │
│   │   ├─ _backedge_counter    ← MD 自己的回边计数                     │
│   │   └─ _data[] → DataLayout[]                                     │
│   │        ├─ TypeProfileData  ← "95% ArrayList"                    │
│   │        ├─ BranchData       ← "80% 走 true"                       │
│   │        └─ VirtualCallData  ← 虚调用接收者分布                     │
│   │                                                                 │
│   └─ _code → CompiledMethod (nmethod, CodeCache)                    │
│        ├─ _entry_point    ← 编译后的机器码入口                        │
│        ├─ _osr_entry_point ← OSR 入口 (OSR nmethod 专用)            │
│        ├─ _comp_level     ← 3 (C1) 或 4 (C2)                        │
│        ├─ _state           ← in_use / not_entrant / zombie           │
│        └─ _compile_id     ← 递增的编译 ID                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 参考文献

- [09-JavaThread 系统线程全景 §3.2] — CompilerThread 创建入口 + jstack 输出
- [06-Thread-Architecture §4.4-4.5] — CompilerThread 完整继承链 + 4MB 栈原因
- [10-NonJavaThread] — NonJavaThread 的 safepoint 行为对比
- [12-ServiceThread] — ServiceThread 的 5-condition 复合等待 vs CompilerThread 单一队列
- [13-ReferenceHandler+Finalizer] — ReferenceHandler 的 pending list 消费 vs CompilerThread 编译队列拉取
- `src/hotspot/share/compiler/compileBroker.hpp:139` — CompileBroker 类定义
- `src/hotspot/share/compiler/compileBroker.cpp:1828` — compiler_thread_loop() 主循环
- `src/hotspot/share/runtime/tieredThresholdPolicy.hpp:165` — TieredThresholdPolicy 完整注释
- `src/hotspot/share/runtime/tieredThresholdPolicy.cpp:45` — call_predicate_helper() 0→3→4 数学条件
- `src/hotspot/share/oops/methodCounters.hpp:35` — MethodCounters 类定义（独立于 MethodData）
- `src/hotspot/share/oops/methodData.hpp:44` — MethodData 设计哲学注释
- `src/hotspot/share/code/nmethod.hpp:128` — _state 字段 (in_use/not_entrant/zombie)
- `src/hotspot/share/runtime/sweeper.hpp:35` — NMethodSweeper 双阶段设计注释
- `src/hotspot/share/runtime/sweeper.cpp:265` — sweeper_loop() 主循环
- `src/hotspot/share/runtime/thread.cpp:3618` — CompilerThread 构造函数 + 4MB 栈分配
