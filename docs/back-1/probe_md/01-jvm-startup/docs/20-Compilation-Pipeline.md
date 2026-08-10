# 20-Compilation-Pipeline — init_globals 编译系统全链路：计数器→策略→调度→CodeCache

> **Phase**: 01-jvm-startup
> **覆盖 init_globals 调用**: #4 `compilationPolicy_init` + #12 `invocationCounter_init` + #27 `compileBroker_init`
> **前置**: [01-CodeCache]（codeCache_init #5 在编译管线之前）、[14-Interpreter-Bytecodes-TemplateTable]（解释器执行方法时调用计数器）
> **后续依赖本文**: Stage 8 `compilation_init_phase1/2`（创建编译器线程 + CompileQueue）
> **阅读收益**: 以 init_globals 执行顺序为主线，完整追踪一个 Java 方法从"解释执行"到"JIT 编译"的全过程——§1 计数器如何编码方法热度（32 位 state+carry+count）、§2 编译策略如何决定编译什么（3 策略 switch + 5 级状态机）、§3 编译调度中心如何管理编译任务（CompileQueue + DirectivesStack + freelist）。全文 22 个 Callout 标注关键设计决策

---

## §〇 Production Scenario — 编译系统出问题的 3 个典型场景

### 场景 1: 启动后长时间无编译 → `-XX:-DelayCompilationDuringStartup` 解决

```bash
java -XX:+PrintCompilation -jar app.jar 2>&1 | head -5
# 启动后前 30 秒看不到任何编译输出
```

根因链：`invocationCounter_init()` (`invocationCounter.cpp:201`) → `reinitialize(true)` → `wait_for_compile` 状态 action=do_decay (`invocationCounter.cpp:160`) → 每次计数器溢出后 `count() >> 1` 减半 (`invocationCounter.cpp:128-135`) → 方法永远无法稳定达到溢出状态 → `CompilationPolicy::event()` 永不被调用。

**三步诊断**：
```bash
# 1. 确认启动延迟状态
java -XX:+PrintFlagsFinal -version 2>&1 | grep DelayCompilationDuringStartup

# 2. GDB 验证 do_decay 是否触发
gdb -ex "break invocationCounter.cpp:122" \
    -ex "run" -ex "print count()" -ex "finish" -ex "print count()" \
    --args java -jar app.jar

# 3. 禁用启动延迟对比
java -XX:-DelayCompilationDuringStartup -XX:+PrintCompilation -jar app.jar
```

**反事实**：如果启动期间不延迟编译 → 启动时大量类加载和方法调用 → 每个方法都触发 C1/C2 编译 → 编译时间 + CodeCache 分配 → 启动时间增加 2-5× → 对微服务和短生命周期命令行工具不可接受。

### 场景 2: `-XX:CompilationPolicyChoice=2` 在无 TIERED 构建中 crash

```bash
java -XX:CompilationPolicyChoice=2 -jar app.jar
# Error: Unimplemented() in compilationPolicy_init
```

根因：`compilationPolicy_init()` (`compilationPolicy.cpp:61-100`) 的 `case 2` 受 `#ifdef TIERED` 保护。如果构建时 `--disable-tiered-compilation` → `TIERED` 未定义 → `case 2` 走 `default` → `fatal()`。

更隐蔽的场景：`TieredCompilation=true` 标志在 `compilerDefinitions.cpp:200-201` 强制 `FLAG_SET_DEFAULT(CompilationPolicyChoice, 2)` → 如果 `TIERED` 未编译 → 启动 crash。

**反事实**：如果不验证范围 → `CompilationPolicy::_policy` 为 NULL → 后续 16 个调用点访问空指针 → SIGSEGV。

### 场景 3: 编译指令文件解析失败 → JVM 启动失败

```bash
java -XX:CompilerDirectivesFile=/path/to/broken.json -jar app.jar
# Error: Could not parse compiler directives file → JNI_EINVAL
```

根因：`compileBroker_init()` (`compileBroker.cpp:244-245`) 调用 `DirectivesParser::parse_from_flag()` → JSON 解析失败 → 返回 false → `init_globals()` 返回 `JNI_EINVAL` (`init.cpp:177-179`)。这是 `compileBroker_init` **唯一的失败路径**。

---

## §一 计数器：InvocationCounter — 方法热度如何编码

> **init_globals 调用 #12** (`init.cpp:148`): `invocationCounter_init()`

### 1.1 入口：invocationCounter_init() — 双状态机定义

```cpp
// src/hotspot/share/interpreter/invocationCounter.cpp:201-207
void invocationCounter_init() {
  InvocationCounter::reinitialize(DelayCompilationDuringStartup);
}
```

`DelayCompilationDuringStartup` 默认 `true` → `wait_for_compile` 状态的 action 是 `do_decay`（衰减而非立即编译）。

### 1.2 核心：32 位单字编码

```cpp
// src/hotspot/share/interpreter/invocationCounter.hpp:44-57
// _bit layout (32-bit unsigned int _counter):
//   ┌────────────────────────────────────┬───┬──────┐
//   │ bit 31 .. bit 3 (29 bits)          │ 2 │ 1  0 │
//   │ count (shifted by 3)               │carry│state │
//   └────────────────────────────────────┴───┴──────┘
```

关键常量（`invocationCounter.hpp:47-72`）：

| 常量 | 值 | 含义 |
|------|-----|------|
| `number_of_state_bits` | 2 | state 占 2 位 |
| `number_of_carry_bits` | 1 | carry 占 1 位 |
| `number_of_noncount_bits` | 3 | 非计数位总数 |
| `count_grain` | 8 | 每次 `increment()` 加 8 |
| `count_shift` | 3 | `count()` 读取时右移 3 位 |
| `carry_mask` | `0x04` | carry 位掩码（bit2） |
| `state_mask` | `0x03` | state 位掩码（bit0-1） |
| `count_mask` | `~0x07` | 计数位掩码（bit3-31） |

核心方法（`invocationCounter.hpp:96-121`）：
```cpp
int count() const    { return _counter >> count_shift; }  // 右移 3 位
void increment()     { _counter += count_grain; }          // 加 8
bool carry() const   { return (_counter & carry_mask) != 0; }
State state() const  { return (State)(_counter & state_mask); }
```

> **Callout 1: 为什么 increment() 加 8 而不是加 1？**  
> `count_grain=8` 意味着每次递增跳过 bit0-2（被 state+carry 占用）。`count()` 读取时右移 3 位 = 除以 8。32 位计数器可以表示 2^29 = 5.3 亿次调用——对 JVM 生命周期内的任何方法都足够了。这是"在位域上做算术"的经典技巧——一次 `_counter += 8` 既更新计数又不影响低 3 位的 state+carry。

### 1.3 状态机：两个状态 + 三个 action

```cpp
// src/hotspot/share/interpreter/invocationCounter.hpp:74-78
enum State { wait_for_nothing, wait_for_compile };

// src/hotspot/share/interpreter/invocationCounter.cpp:156-161
def(wait_for_nothing, 0, do_nothing);     // 状态 0: 永不触发编译
if (delay_overflow) {
  def(wait_for_compile, 0, do_decay);     // 启动期间: 衰减
} else {
  def(wait_for_compile, 0, dummy_invocation_counter_overflow); // 正常运行: 立即编译
}
```

三个 action 函数：

```cpp
// invocationCounter.cpp:112-118
static void do_nothing(...) {
  _counter = 0; set_state(wait_for_nothing);  // 此方法永不编译
}

// invocationCounter.cpp:122-137
static void do_decay(...) {
  int c = count();
  int new_count = c >> 1;     // ★ 减半
  if (c > 0 && new_count == 0) new_count = 1;
  set(state(), new_count);    // 保留 state，保留 carry
}

// invocationCounter.cpp:148-150
static void dummy_invocation_counter_overflow(...) {
  ShouldNotReachHere();  // 被 event() 覆盖，实际不会被调用
}
```

> **Callout 2: do_decay 为什么能延迟编译？**  
> 每次计数器溢出后 `do_decay` 将计数减半：溢出 → 减半 → 再次累积 → 再次溢出 → 再次减半。结果是计数器永远无法稳定达到溢出状态。只有 `completed_vm_startup()` 切换 action 为 `dummy` 后，溢出才会真正触发 `CompilationPolicy::event()`。这是启动延迟编译的核心机制——不是"不计数"，而是"让计数永远不够"。

### 1.4 carry flag 的粘性语义

```cpp
// src/hotspot/share/interpreter/invocationCounter.cpp:46-59
void InvocationCounter::set_carry() {
  set_carry_flag();              // _counter |= carry_mask (bit2=1)
  int old_count = count();
  int new_count = MIN2(old_count, (int)(CompileThreshold / 2));
  if (new_count == 0) new_count = 1;  // 防止归零
  if (old_count != new_count) set(state(), new_count);
}

// invocationCounter.cpp:61-68
void InvocationCounter::set_state(State state) {
  int carry = (_counter & carry_mask);     // ★ carry 粘性！保留原 carry 位
  _counter = (init << 3) | carry | state;
}
```

`set_state()` 和 `set()` 都保留 `carry_mask` 位——一旦 `set_carry()` 被调用，carry flag 永远为 1。这标记"该方法已被编译策略处理过"——后续 `invocation_count()`、`backedge_count()`、`was_executed_more_than()` 都依赖此标志。

> **Callout 3: carry 粘性的设计意图**  
> 如果 carry 不粘性 → 方法每次计数器重置后都可以重新触发编译 → 编译器反复编译同一个方法 → CodeCache 被同一方法的多个版本填满。carry 粘性确保每个方法只被编译策略处理一次——除非 `reset_counter_for_invocation_event()` 显式重新设置。

### 1.5 阈值计算公式

```cpp
// src/hotspot/share/interpreter/invocationCounter.cpp:163-174
InterpreterInvocationLimit = CompileThreshold << count_shift;
// C2: 10000 << 3 = 80000 (原始 _counter 值)
// 实际调用次数: 80000 >> 3 = 10000 次方法调用后触发编译

InterpreterProfileLimit = ((CompileThreshold * InterpreterProfilePercentage) / 100) << count_shift;
// C2: ((10000*33)/100) << 3 = 26400, 即 3300 次调用后开始 profiling

// OSR 回边阈值
if (ProfileInterpreter) {
  InterpreterBackwardBranchLimit = (CompileThreshold * (OnStackReplacePercentage - InterpreterProfilePercentage)) / 100;
  // C2: 10000*(140-33)/100 = 10700
} else {
  InterpreterBackwardBranchLimit = ((CompileThreshold * OnStackReplacePercentage) / 100) << count_shift;
  // C2: (10000*140/100) << 3 = 112000
}
```

| Flag | C1 默认值 | C2 默认值 | 定义位置 |
|------|----------|----------|---------|
| `CompileThreshold` | 1500 | 10000 | `c1_globals_x86.hpp:43` / `c2_globals_x86.hpp:43` |
| `OnStackReplacePercentage` | **933%** | 140% | `c1_globals_x86.hpp:45` / `c2_globals_x86.hpp:45` |
| `InterpreterProfilePercentage` | 33% | 33% | `globals.hpp:2372` |

> **Callout 4: C1 的 OnStackReplacePercentage=933% 不是 bug**  
> C1 编译快（毫秒级）但代码质量低。如果 OSR 阈值太低（如 140%）→ 方法在 C1 编译完成前就触发了 OSR → 生成低质量的 OSR 代码 → 方法很快就需要重新编译 → 编译资源浪费。933% 确保方法在 C1 编译完成前不会触发 OSR——大部分循环等到方法入口编译后自然被内联。C2 的 140% 较低是合理的——C2 代码质量高，值得提前 OSR。

### 1.6 reached_InvocationLimit() — 双计数器联动溢出判断

```cpp
// src/hotspot/share/interpreter/invocationCounter.hpp:106-109
bool reached_InvocationLimit(InvocationCounter *back_edge_count) {
  return (_counter & count_mask) + (back_edge_count->_counter & count_mask)
      >= (unsigned int) InterpreterInvocationLimit;
}
```

> **Callout 5: 为什么 invocation + backedge 之和判断溢出？**  
> 单独用 invocation_counter 判断：方法被调用 10000 次才触发编译——但方法内部有循环，100 次调用 + 100 次循环迭代 = 200 次"热度"。双计数器联动更准确地反映方法的真实热度——被频繁调用但没有循环的方法（高 invocation + 低 backedge）和被少次调用但有深循环的方法（低 invocation + 高 backedge）都可以触发编译。

### 1.7 MethodCounters — 每方法计数器容器

```cpp
// src/hotspot/share/oops/methodCounters.hpp:35-113
class MethodCounters : public Metadata {
  InvocationCounter _invocation_counter;    // 方法入口计数器
  InvocationCounter _backedge_counter;      // 回边计数器（OSR 用）
  int _nmethod_age;                         // nmethod 热度（sweeper 用）
  int _interpreter_invocation_limit;        // 每方法独立阈值
  int _interpreter_backward_branch_limit;
  int _interpreter_profile_limit;
};
```

`MethodCounters` 是懒创建的（`method.hpp:941`）——大多数方法永远不会被调用，不需要分配计数器。构造函数支持 `CompileThresholdScaling` 每方法阈值缩放。

---

## §二 策略：CompilationPolicy — 谁决定编译什么

> **init_globals 调用 #4** (`init.cpp:124`): `compilationPolicy_init()`
> 
> **前置依赖**: 无强依赖（compilationPolicy_init 在 init_globals 中第 4 个调用，仅需基本内存分配）。但运行时依赖 §一 的 InvocationCounter 提供方法热度数据。

### 2.1 入口：compilationPolicy_init() — 3 策略 switch

```cpp
// src/hotspot/share/runtime/compilationPolicy.cpp:61-100
void compilationPolicy_init() {
  CompilationPolicy::set_in_vm_startup(DelayCompilationDuringStartup);
  switch(CompilationPolicyChoice) {
  case 0: set_policy(new SimpleCompPolicy()); break;
#ifdef COMPILER2
  case 1: set_policy(new StackWalkCompPolicy()); break;
#endif
#ifdef TIERED
  case 2: set_policy(new TieredThresholdPolicy()); break;
#endif
  default: fatal("CompilationPolicyChoice must be in the range: [0-2]");
  }
  CompilationPolicy::policy()->initialize();
}
```

`CompilationPolicyChoice` 的默认值在 `compilerDefinitions.cpp:200-201` 被 Tiered 模式强制覆盖：
```cpp
if (FLAG_IS_DEFAULT(CompilationPolicyChoice) && TieredCompilation) {
  FLAG_SET_DEFAULT(CompilationPolicyChoice, 2);  // Tiered → 策略 2
}
```

### 2.2 类层次

```
CompilationPolicy (CHeapObj<mtCompiler>)          ← 抽象基类
├── NonTieredCompPolicy                           ← 共享 reset_counter 逻辑
│   ├── SimpleCompPolicy                          ← 策略0：纯计数器
│   └── StackWalkCompPolicy (COMPILER2 only)      ← 策略1：栈遍历
└── TieredThresholdPolicy (TIERED only)           ← 策略2：分层阈值（默认）
```

全局静态变量（`compilationPolicy.hpp:40-45`）：

| 变量 | 类型 | 用途 |
|------|------|------|
| `_policy` | `CompilationPolicy*` | 策略单例指针 |
| `_accumulated_time` | `elapsedTimer` | 策略决策累计耗时 |
| `_in_vm_startup` | `bool` | VM 启动中标志 |

> **Callout 6: 为什么策略初始化（#4）在计数器初始化（#12）之前？**  
> `compilationPolicy_init()` 是 init_globals #4，`invocationCounter_init()` 是 #12。策略的 `initialize()` 设置的是编译器线程数和全局阈值——不依赖计数器。计数器在解释器执行方法时才被懒创建（`MethodCounters`）。策略先就绪，计数器后用——"注册回调"模式避免了循环依赖。

### 2.3 SimpleCompPolicy — 纯计数器决策

```cpp
// src/hotspot/share/runtime/compilationPolicy.cpp:533-549
nmethod* SimpleCompPolicy::method_invocation_event(const methodHandle& m, ...) {
  int hot_count = m->invocation_count();          // ← 读 §1 的计数器
  reset_counter_for_invocation_event(m);          // → set_carry (见 §1.4)
  if (is_compilation_enabled()                    // 全局开关 + 启动延迟
      && can_be_compiled(m, comp_level)           // 方法状态（未标记不可编译）
      && m->code() == NULL) {                     // 尚未编译
    CompileBroker::compile_method(m, InvocationEntryBci,
        CompLevel_highest_tier, m, hot_count,
        CompileTask::Reason_InvocationCount, thread);  // → §3 的 CompileBroker
  }
  return NULL;
}
```

**回边事件** (`compilationPolicy.cpp:551-564`)：使用 `backedge_count()` 替代 `invocation_count()`，使用 `can_be_osr_compiled()` 替代 `can_be_compiled()`，`bci` 是循环回边的具体字节码索引而非 `InvocationEntryBci`。

**计数器重置机制** (`compilationPolicy.cpp:334-360`)：
```cpp
void NonTieredCompPolicy::reset_counter_for_invocation_event(const methodHandle& m) {
  m->method_counters()->invocation_counter()->set_carry();  // carry 粘性 + 钳制到 CT/2
  m->method_counters()->backedge_counter()->set_carry();
}

void NonTieredCompPolicy::reset_counter_for_back_branch_event(const methodHandle& m) {
  m->method_counters()->invocation_counter()->set(state, CompileThreshold);     // 抬高调用计数
  m->method_counters()->backedge_counter()->set(state, CompileThreshold / 2);   // 回边更容易再次 OSR
}
```

### 2.4 StackWalkCompPolicy — 栈遍历找最佳调用者

```cpp
// src/hotspot/share/runtime/compilationPolicy.cpp:572-612
nmethod* StackWalkCompPolicy::method_invocation_event(const methodHandle& m, ...) {
  reset_counter_for_invocation_event(m);
  // 构建调用栈帧链
  GrowableArray<RFrame*>* stack = new GrowableArray<RFrame*>(50);
  for (javaVFrame* vf = thread->last_java_vframe(...); vf; vf = vf->java_sender()) {
    stack->push(new InterpretedRFrame(vf, i++, NULL));
  }
  // ★ 向上遍历找最应该编译的调用者（而非 m 本身）
  RFrame* top = findTopInlinableFrame(stack);
  CompileBroker::compile_method(top->top_method(), InvocationEntryBci, ...);  // → §3
  return NULL;
}
```

> **Callout 7: StackWalkCompPolicy 为什么编译调用者而非热点方法？**  
> 假设 A→B→C，C 是热点循环。SimpleCompPolicy 编译 C（OSR），但 C 可能是简单的 getter——真正热的是 B 对 C 的调用路径。StackWalkCompPolicy 从 C 向上遍历栈，找到 B（被多次调用且可内联 C）→ 编译 B → B 内联 C → 消除调用开销。这种"编译调用者"的策略比 OSR 编译循环体更有效。但 `findTopInlinableFrame()` 有 10+ 个停止条件（`compilationPolicy.cpp:624-737`），防止编译到冷的调用者。

### 2.5 TieredThresholdPolicy — 分层编译（现代 JVM 默认）

**5 级编译状态机** (`common()` — `tieredThresholdPolicy.cpp:716-817`)：

| cur_level | 决策逻辑 |
|-----------|---------|
| `CompLevel_none` (0) | `is_trivial(m)` → `CompLevel_simple` (1); 否则 C2 队列长 → `CompLevel_limited_profile` (2); 否则 → `CompLevel_full_profile` (3) |
| `CompLevel_limited_profile` (2) | MDO 已充分 profile → `CompLevel_full_optimization` (4); 否则 → `CompLevel_full_profile` (3) |
| `CompLevel_full_profile` (3) | `call_predicate + loop_predicate` 满足 → `CompLevel_full_optimization` (4) |

> **Callout 8: 5 级编译的语义**  
> | 等级 | 编译器 | 特点 |
> |------|--------|------|
> | 0: none | 解释器 | 所有方法的起点 |
> | 1: simple | C1 | 无 profiling，用于 trivial 方法（getter/setter） |
> | 2: limited_profile | C1 | 快速 profiling，只收集调用计数 |
> | 3: full_profile | C1 | 完整 MDO，收集类型/分支信息 |
> | 4: full_optimization | C2/JVMCI | 使用 MDO 数据做激进优化（内联、逃逸分析） |

**反馈调节** — `threshold_scale()` (`tieredThresholdPolicy.cpp:559-575`)：
```cpp
double threshold_scale(CompLevel level, int feedback_k) {
  double k = CompileBroker::queue_size(level) / (feedback_k * compiler_count(level)) + 1;
  // 队列越长 → k 越大 → 阈值越高 → 减缓提交
  if (level <= CompLevel_full_profile) {
    double reverse_free_ratio = CodeCache::reverse_free_ratio();
    if (reverse_free_ratio > _increase_threshold_at_ratio) {
      k *= exp(reverse_free_ratio - _increase_threshold_at_ratio);  // ★ 指数级放大
    }
  }
  return k;
}
```

> **Callout 9: threshold_scale 的指数级反馈是防止 CodeCache 雪崩的关键**  
> CodeCache 使用率超过 50%（`IncreaseFirstTierCompileThresholdAt` 默认值）后，C1 编译阈值**指数级**增长。只有最热的方法才能触发 C1 编译 → 防止 CodeCache 满 → sweeper 频繁触发 → 新编译代码被 sweep → 性能抖动的恶性循环。C2 阈值不受此影响——C2 代码质量高，空间效率好。

### 2.6 编译触发桥接：InvocationCounter → CompilationPolicy → CompileBroker

```
解释器方法入口
  │
  ├── InvocationCounter::increment()  [每次调用 _counter += 8]
  │     └── reached_InvocationLimit(backedge)?  [invocation + backedge 之和]
  │           └─ 溢出 → InterpreterRuntime::frequency_counter_overflow()
  │
  ├── CompilationPolicy::policy()->event(m)  [策略入口，#4 初始化]
  │     │
  │     ├── [SimpleCompPolicy]
  │     │   └── method_invocation_event(m)
  │     │       ├── reset_counter_for_invocation_event(m) → set_carry()
  │     │       ├── is_compilation_enabled() → delay_compilation_during_startup()
  │     │       └── CompileBroker::compile_method(...) → §3
  │     │
  │     └── [TieredThresholdPolicy]
  │         └── event(m)
  │             ├── handle_counter_overflow(m) → set_carry_if_necessary()
  │             ├── call_event(m) / loop_event(m)
  │             ├── common(m, bci, level) [5 级状态机]
  │             └── submit_compile(m, next_level, ...) → §3
  │
  └── CompileBroker::compile_method()  [§3 编译调度中心]
```

---

## §三 调度：CompileBroker — 编译任务如何管理

> **init_globals 调用 #27** (`init.cpp:177`): `compileBroker_init()`
> 
> **前置依赖**: compilerOracle_init (#25, 解析 `-XX:CompileCommand`) 必须在 compileBroker_init 之前。

### 3.1 入口：compileBroker_init() — 极轻初始化

```cpp
// src/hotspot/share/compiler/compileBroker.cpp:236-252
bool compileBroker_init() {
  if (LogEvents) { _compilation_log = new CompilationLog(); }  // 编译事件日志
  DirectivesStack::init();  // 创建默认 "*.*" 指令，压入指令栈
  if (DirectivesParser::has_file()) {
    if (!DirectivesParser::parse_from_flag()) {
      return false;  // ★ 唯一失败路径 → init_globals 返回 JNI_EINVAL
    }
  }
  return true;
}
```

> **Callout 10: compileBroker_init 不创建线程**  
> 它只做三件事：CompilationLog + DirectivesStack + 指令文件解析。编译器线程在 `create_vm()` Stage 8 的 `compilation_init_phase1/2` 中创建——此时指令栈已就绪，线程可以直接使用已解析的指令。这是"先准备数据，再启动线程"的设计模式。

### 3.2 DirectivesStack — 层级指令栈

```cpp
// src/hotspot/share/compiler/compilerDirectives.cpp:457-474
void DirectivesStack::init() {
  CompilerDirectives* d = new CompilerDirectives();
  d->add_match("*.*");          // 匹配所有类和方法
  d->c1_store()->EnableOption = EnableC1;
  d->c2_store()->EnableOption = EnableC2;
  push(d);  // _bottom = _top = d（永不移除）
}
```

每个 `CompilerDirectives` 含 `DirectiveSet`（`_c1_store` + `_c2_store`），包含所有可调参数：内联策略、编译阈值、Intrinsic 禁用等。

> **Callout 11: DirectivesStack 的 push/pop 作用域模式**  
> 支持 `push({inline=false})` → 编译此范围内的代码 → `pop()` 恢复默认。这是为 GraalVM/JVMCI 等需要"编译作用域"的场景设计的。默认指令 `*.*` 永远在栈底，不会被弹出。`getMatchingDirective(method)` 从栈顶向栈底遍历，返回第一个匹配的指令。

### 3.3 CompileQueue — 双向链表 + 5s 超时阻塞

```cpp
// src/hotspot/share/compiler/compileBroker.hpp:80-124
class CompileQueue : public CHeapObj<mtCompiler> {
  const char*  _name;           // "C1" 或 "C2"
  CompileTask* _first;          // 队首
  CompileTask* _last;           // 队尾
  CompileTask* _first_stale;    // 过期任务回收链表
  int          _size;           // 当前任务数
};
```

**add()** (`compileBroker.cpp:366-399`) — 标准双向链表追加 + `notify_all()` 唤醒等待线程。

**get()** (`compileBroker.cpp:433-491`) — 编译器线程的主获取点：
```cpp
CompileTask* CompileQueue::get() {
  while (_first == NULL) {
    if (is_compilation_disabled_forever()) return NULL;  // CodeCache 满 → 退出
    MethodCompileQueue_lock->wait(5*1000);  // ★ 5 秒超时
    if (UseDynamicNumberOfCompilerThreads && _first == NULL) {
      if (can_remove(thread)) return NULL;  // 动态缩减线程数
    }
  }
  // 策略选择任务 + 过期回收
  task = CompilationPolicy::select_task(this);  // ← 回调 §2 的策略
  remove(task);
  purge_stale_tasks();  // 回收 _first_stale 链表
  return task;
}
```

> **Callout 12: 5 秒超时阻塞的双重用途**  
> 1. **防止死锁**：如果 `notify_all()` 丢失（极端情况），线程不会永久阻塞
> 2. **动态线程缩减**：`UseDynamicNumberOfCompilerThreads=true` 时，空闲 5 秒的线程可以安全退出——减少资源占用
> 正常运行时，`add()` 中的 `notify_all()` 会立即唤醒等待线程，5 秒超时几乎不会触发。

### 3.4 CompileTask — freelist 复用

```cpp
// src/hotspot/share/compiler/compileTask.hpp:76-103
class CompileTask : public CHeapObj<mtCompiler> {
  Monitor*      _lock;           // 每个 task 独立的锁
  uint          _compile_id;     // 全局唯一编译 ID（自增）
  Method*       _method;         // 被编译的方法
  int           _osr_bci;        // OSR 入口 BCI（-1 = 非 OSR）
  bool          _is_complete;    // 编译是否完成
  CompileTask*  _next, *_prev;   // 双向链表指针
  bool          _is_free;        // 是否在 freelist 中
  CompileReason _compile_reason; // 触发原因
};
```

**freelist 分配** (`compileTask.cpp:40-60`)：
```cpp
CompileTask* CompileTask::allocate() {
  if (_task_free_list != NULL) {
    task = _task_free_list; _task_free_list = task->next();  // LIFO 取头部
  } else {
    task = new CompileTask();  // 首次分配才 new
  }
  return task;
}
```

**freelist 回收** (`compileTask.cpp:65-83`)：插入 freelist 头部（LIFO）。

> **Callout 13: freelist 为什么用 LIFO 而不是 FIFO？**  
> LIFO 利用 CPU 缓存局部性——最近释放的 task 对象仍在 L1/L2 cache 中，下次 `allocate()` 时可以直接命中缓存。FIFO 每次取的都是最老的 task → 大概率已被换出缓存 → 内存访问延迟增加。

### 3.5 编译器线程创建（Stage 8，非 compileBroker_init）

```
create_vm() Stage 8:
  compilation_init_phase1() → 计算线程数 + new CompileQueue + 创建 SweeperThread
  compilation_init_phase2() → init_compiler_threads_of_type()
    → for (i=0; i<c1_count; i++): new CompilerThread → os::create_thread
    → for (i=0; i<c2_count; i++): new CompilerThread → os::create_thread
      → compiler_thread_entry → CompileBroker::compiler_thread_loop()
        → 无限循环: CompileQueue::get() → invoke_compiler_on_method() → post_compile()
```

> **Callout 14: 编译器线程数的计算公式**  
> `count = MAX2(log2(cpu) * log2(log2(cpu)) * 3/2, 2)`  
> `c1_count = MAX2(count/3, 1)`  
> `c2_count = count - c1_count`  
> 16 核 CPU → `4*2*1.5=12, c1=4, c2=8`。C1:C2 ≈ 1:2 比例——C1 编译快（毫秒级），少量线程即可处理所有 C1 请求；C2 编译慢（秒级），需要更多线程并行处理。

---

## §四 编译全链路数据流

```
init_globals() @ init.cpp:109
  │
  ├──[#4]  compilationPolicy_init()  ──→ 设置策略单例 (§2)
  ├──[#12] invocationCounter_init()  ──→ 设置状态机 + 阈值 (§1)
  └──[#27] compileBroker_init()     ──→ 设置指令栈 + 日志 (§3)

... Stage 8: 创建 CompileQueue + 编译器线程 ...

运行时:
  解释器方法入口
    ├── InvocationCounter::increment()  [_counter += 8]
    │     └── reached_InvocationLimit() → 溢出?
    │
    └── [溢出] InterpreterRuntime::frequency_counter_overflow()
          → CompilationPolicy::policy()->event(m)  [策略决策]
            → [SimpleCompPolicy] method_invocation_event()
              → is_compilation_enabled() + can_be_compiled()
            → [TieredThresholdPolicy] common(m, bci, level)
              → threshold_scale(level) [反馈调节]
          → CompileBroker::compile_method()
            → compile_method_base() [校验+去重+分配ID]
            → create_compile_task() [CompileTask::allocate() ← freelist]
            → CompileQueue::add() [双向链表入队 + notify_all]
          → CompilerThread::compiler_thread_loop()
            → CompileQueue::get() [5s 超时阻塞]
            → invoke_compiler_on_method() [ciEnv + C1/C2/JVMCI 编译]
            → post_compile() [安装 nmethod 到 CodeCache]
```

---

## §五 关键全局标志速查

| Flag | 默认值 | 位置 | 影响 |
|------|--------|------|------|
| `CompileThreshold` | C1:1500, C2:10000 | `c1/c2_globals_x86.hpp:43` | §1 阈值计算基准 |
| `OnStackReplacePercentage` | C1:933%, C2:140% | `c1/c2_globals_x86.hpp:45` | §1 OSR 补偿因子 |
| `InterpreterProfilePercentage` | 33% | `globals.hpp:2372` | §1 profiling 开始百分比 |
| `DelayCompilationDuringStartup` | true | product flag | §1 do_decay vs dummy |
| `CompilationPolicyChoice` | 0(→Tiered:2) | `globals.hpp:1168` | §2 策略选择 |
| `TieredCompilation` | true | product flag | §2 强制设为策略 2 |
| `CICompilerCount` | auto | 计算公式 | §3 C1:C2 ≈ 1:2 |
| `UseDynamicNumberOfCompilerThreads` | true (JDK 11+) | product flag | §3 动态线程缩减 |
| `IncreaseFirstTierCompileThresholdAt` | 50% | product flag | §2 CodeCache 反馈调节触发点 |

---

## §六 边缘场景与错误路径

### 6.1 compileBroker_init 的唯一失败路径

```cpp
// compileBroker.cpp:244-245
if (!DirectivesParser::parse_from_flag()) {
  return false;  // → init_globals 返回 JNI_EINVAL → JVM 退出
}
```

指令文件 JSON 格式错误或文件不存在 → `parse_from_flag()` 失败 → `JNI_EINVAL`。这是 `compileBroker_init` 的唯一失败路径。

### 6.2 CodeCache 满 → 永久禁用编译

`CodeCache::allocate()` 失败 → `handle_full_code_cache()` → `disable_compilation_forever()` → `_should_compile_new_jobs = shutdown` → `CompileQueue::get()` 检测到此标志 → 返回 NULL → 编译器线程退出。

### 6.3 动态编译器线程缩减

`UseDynamicNumberOfCompilerThreads=true` → 编译器线程在 `get()` 中 5 秒未获取到任务 → `can_remove()` 检查 → 如果还有足够线程 → 返回 NULL → 线程退出。当编译负载增加时，`possibly_add_compiler_threads()` 创建新线程。

---

## §七 诊断工具

```bash
# 1. 查看计数器阈值
java -XX:+PrintFlagsFinal -version 2>&1 | grep -E "CompileThreshold|OnStackReplace|InterpreterProfile"

# 2. 查看编译策略
java -XX:+PrintFlagsFinal -version 2>&1 | grep CompilationPolicyChoice

# 3. 查看编译队列
jcmd <pid> Compiler.queue

# 4. 查看编译统计
jcmd <pid> Compiler.codecache

# 5. 打印所有编译事件
java -XX:+PrintCompilation -XX:+PrintTieredEvents -jar app.jar

# 6. GDB 验证计数器溢出
gdb -ex "break compilationPolicy.cpp:533" \
    -ex "run" -ex "print m->name_and_sig_as_C_string()" \
    -ex "print hot_count" --args java -jar app.jar

# 7. GDB 验证编译队列
gdb -ex "attach <pid>" \
    -ex "print CompileBroker::_c2_compile_queue->_size"
```

---

## §八 源码文件

| 文件 | 关键行号 | 内容 |
|------|---------|------|
| `src/hotspot/share/interpreter/invocationCounter.cpp` | :35-207 | `init()`/`reset()`/`set_carry()`/`reinitialize()` |
| `src/hotspot/share/interpreter/invocationCounter.hpp` | :44-153 | 位布局 + 内联方法 + 状态机 |
| `src/hotspot/share/oops/methodCounters.hpp` | :35-267 | `MethodCounters` 类 |
| `src/hotspot/share/runtime/compilationPolicy.cpp` | :61-100 | `compilationPolicy_init()` |
| `src/hotspot/share/runtime/compilationPolicy.cpp` | :334-360 | `reset_counter_for_*_event()` |
| `src/hotspot/share/runtime/compilationPolicy.cpp` | :430-486 | `NonTieredCompPolicy::event()` |
| `src/hotspot/share/runtime/compilationPolicy.cpp` | :533-737 | 三种策略的 `method_*_event()` |
| `src/hotspot/share/runtime/tieredThresholdPolicy.cpp` | :45-81 | `call_predicate` / `loop_predicate` |
| `src/hotspot/share/runtime/tieredThresholdPolicy.cpp` | :203-265 | `TieredThresholdPolicy::initialize()` |
| `src/hotspot/share/runtime/tieredThresholdPolicy.cpp` | :559-575 | `threshold_scale()` |
| `src/hotspot/share/runtime/tieredThresholdPolicy.cpp` | :716-817 | `common()` 核心状态机 |
| `src/hotspot/share/compiler/compileBroker.cpp` | :236-252 | `compileBroker_init()` |
| `src/hotspot/share/compiler/compileBroker.cpp` | :366-491 | `CompileQueue::add()` + `get()` |
| `src/hotspot/share/compiler/compileTask.cpp` | :40-83 | `CompileTask::allocate()` + `free()` |
| `src/hotspot/share/compiler/compilerDirectives.cpp` | :457-535 | `DirectivesStack::init()` + `push()` |

---

## §九 总结

编译系统是 init_globals 中**唯一完整覆盖的三步流水线**——§1 计数器编码热度、§2 策略决定编译目标、§3 调度管理编译任务。三个调用在 init_globals 中的执行顺序（#4 策略 → #12 计数器 → #27 调度）与运行时数据流（计数器溢出 → 策略决策 → 调度提交）方向相反——这是"先注册回调，后产生事件"的设计模式：

1. **#4 compilationPolicy_init**: 注册策略回调（`_policy` 单例）——"收到溢出事件时应该做什么"
2. **#12 invocationCounter_init**: 设置计数器阈值和状态机——"何时产生溢出事件"
3. **#27 compileBroker_init**: 初始化编译调度基础设施——"收到编译请求后如何管理任务"

运行时数据流：方法热度累积 → 计数器溢出 → 回调策略 → 提交编译请求 → 入队调度 → 编译器线程执行 → 安装到 CodeCache。
