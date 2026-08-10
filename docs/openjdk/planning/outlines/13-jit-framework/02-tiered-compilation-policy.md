# 02. TieredThresholdPolicy — 5 层编译策略

> 🔴 Deep | 8 KP 中的 2 个核心机制
> 读者处境: 一个方法: 解释器跑→C1 no profiling→C1 profiling→C2。不是一步到 C2——分层编译——速度与优化的阶梯。

### 1. TieredCompilation — 5 层阶梯

场景: `int sum(int[] arr)`——JVM 启动→L0 解释器解释→跑 5000 次→InvocationCounter 0→L1 (C1 no profiling)——快速编译不收集数据→再跑 5000→L2 (C1 basic profiling)——收集 branch probability→再跑 15000→L4 (C2 full optimization)——做激进 inline+scalar replacement。

**TieredThresholdPolicy** (`tieredThresholdPolicy.hpp.cpp`):
- L0: 解释器——counter `Tier0InvokeNotifyFreq` (default=0?) 触发 C1
- L1: C1 no profiling——`Tier0BackedgeNotifyFreq` + `Tier0ProfilingStartPercentage`。counter=5000。快速编译——无 profiling data——编译器 baseline
- L2: C1 basic profiling——counter=5000。收集 invocation counter+backedge counter——为 C2 准备
- L3: C1 full profiling——counter=15000。收集 counter+type profile+receiver type+call target。C2 的 profiling 数据全在此采集——**没有 L3→C2 优化降级**
- L4: C2 full optimization——counter=15000 (或从 L3 提升)。做全部激进优化 (inline/escape analysis/scalar replacement/loop unswitching)
- [C++: 为什么分层？— L0→L1→L2→L3→L4。每一步编译开销递增——编译速度递减——优化质量递增。好处: 快速启动 (L1 毫秒级)→优化质量 (L4 秒级)。没有 Tiered——直接 L0→L4→启动慢——C2 编译 500ms+ for medium method]
- `event(Method*, bci, CompLevel, ...)`: 在 invocation counter 归零时调用——`Method::invocation_counter`→检查当前层级→决定下一层级→如果允许→`CompileBroker::compile_method()`→queue

**OSR 策略** (`tieredThresholdPolicy.cpp:200-400`):
- 循环体内→backedge counter 触发→OSR——在循环**中间**切换 JIT
- L0→L1 OSR: 循环执行 N 次→backedge counter 0→编译 OSR version→下一次循环顶部跳转到编译代码
- L1→L4 OSR: profiling data——loop trip count→C2 OSR——用 loop unrolling based on trip count
- [C++: OSR entry——`osr_bci` ≠ 0——compiled method 的入口在循环头顶——不是方法入口。调用者继续走解释器——被调方法在 OSR compiled code 执行。下次方法入口调用→`_from_interpreted_entry`——c2i adapter——可能已有对应的 compiled method——直接跳]

### 2. CompilerDirectives + CompileLog

**CompilerDirectives** (`compilerDirectives.hpp.cpp` + `directivesParser.hpp.cpp`):
- `-XX:CompileCommand=exclude,java/lang/String.length`: 排除方法——不编译——只解释
- `-XX:CompileCommand=inline,org/example/Foo.bar`: 强制 inline——C2 必须 inline 这个方法
- `-XX:CompileCommand=compileonly,org/example.*`: 只编译匹配的方法——其他全部解释器
- [C++: `DirectivesParser::parse_file(directives_file)`——读 directives.json→`CompilerDirectives::_directives[]`——`MethodMatcher::matches(method)`→命中→`DirectiveSet::_option[]` 覆盖通用 options]
- [C++: MethodMatcher——`*` 通配符——`org/example.*`→匹配所有 org.example 包方法。不是 regex——是 `strncmp` 前缀+通配符分段——简单但足够]

**CompileLog** (`compileLog.hpp.cpp`):
- `CompileLog::log_compile_id(compile_id, method)`: 格式——`<task compile_id='123' method='java/lang/String length ()I' bytes='14' count='15234' backedge_count='0' osr_bci='0' level='4' stamp='123.456'/>`
- jitwatch 工具消费此 XML——可视化编译流程——哪些方法被编译、时间、层级、inline 决策

---

### 核心悬念

**"分层编译: L0→L1(5000)→L2(5000)→L4(15000)——不是一步 C2——让快速启动+极致优化共存。"** — L2/L3 的 profiling data 是 C2 的优化输入——branch probability→biased branch——receiver type→inline with guard——loop trip count→unrolling。没有 L3→C2 变成不是"超优化"——只是 C1 baseline 的 recompilation。域 13 完成——Group 5 执行引擎继续。下一篇: C1——C1 编译器的完整 pipeline。

> → domain 14: [C1 Compiler — C1 的 6 步编译管线: parse→build HIR→optimize→LIR→register→code emit](../14-c1-compiler/01-c1-pipeline.md)
