# 02. TieredThresholdPolicy — 5 层编译策略

> 🔴 Deep | 8 KP 中的 2 个核心机制
> 读者处境: 一个方法: 解释器跑→C1 no profiling→C1 profiling→C2。不是一步到 C2——分层编译——速度与优化的阶梯。

> ⚠️ 写作期修正(2026-08-13, vol-02/13-jit-framework/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"L0→L1→L2→L3→L4 阶梯" 错(重要)**: 权威转换图在注释 tieredThresholdPolicy.cpp:676-712——常规路径 **a. 0→3→4**(最常见);b. 0→2→3→4(C2 队列负载高,full profile 比 limited 慢 30%);c. 0→(3→2)→4(入队后降级);d. 0→3→1/0→2→1(**仅 trivial** accessor/constant getter,is_trivial :84-90,或 C2 编不了);e. 0→4(C1 失败)。**L1(CompLevel_simple)是终点不是阶梯**
> - **"5000/5000/15000" 编造**: 真实阈值(call_predicate_helper :44-63): 解释器→C1=Tier3InvocationThreshold **200**/Min **100**/Compile **2000**;C1→C2=Tier4 **5000**/**600**/**15000**;回边(OSR)档 Tier3BackEdge **60000**/Tier4BackEdge **40000**;判定=单计数达标或(i>=Min && i+b>=Compile);scale 缩放=CompileThresholdScaling 指令 + **队列负载反馈 threshold_scale(:558-574, k=queue_size/(Tier3LoadFeedback=5 或 Tier4LoadFeedback=3)×compiler_count + 1)+ code cache 压力指数抬 C1 阈值**
> - **"Tier0InvokeNotifyFreq default=0?" 无依据**: 真实 Tier0InvokeNotifyFreqLog=7/Tier0BackedgeNotifyFreqLog=10(2 的幂,解释器 notify);Tier0ProfilingStartPercentage=200(should_create_mdo :638-648: **解释器阶段提前建 MDO**,"start profiling without waiting for the compiled method to arrive")
> - **"L1 counter=5000/L2=5000/L3=15000" 无意义**: 每档阈值是上表两档 predicate,不是每层一个数
> - **"没有 L3→C2 优化降级" 表述含糊**: full_profile→full_optimization 走 mdo 计数 delta(call_predicate_helper<CompLevel_full_profile>),common :797-812
> - **事件机制补全**: event(:371)分派——method_invocation_event(:884: create_mdo→call_event→compile(InvocationEntryBci));method_back_branch_event(:903: loop_event→**compile(imh, bci, next_osr_level) OSR 入口=回边 bci** :918 + 借机检查普通编译 :921-932);**call_event OSR 均衡**(:827-834,已有 C2 OSR 版本则普通编译也提 C2,"avoid OSRs during each invocation");loop_event(:845);**OSR 新 nmethod 直接返回交给解释器跳转**(:398-402);handle_counter_overflow carry 防再触发(:266-269);compile(:408)→CompileBroker::compile_method
> - **CompilerDirectives/CompileLog 大纲第 2 节未展开**: CompileCommand 已散布本篇(CompileThresholdScaling/ExcludeOption/DirectiveSet 匹配);CompileLog/jitwatch 属工具域(卷 T),后续可补
> - **实证**: 13-jit-tiered-demo.txt(PrintFlagsFinal 阈值表;CiDemo::work 完整链 %3→3→%4→4→made not entrant——循环热点先 OSR 后普通;TieredStopAtLevel=1 只出 %1/1、=3 只出 %3/3);对照 08-interpreter-counterdemo.txt(tier3→%tier4@4→tier4→made not entrant)

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
