# 02. 为什么先 C1 再 C2？— TieredThresholdPolicy 5 层编译策略

> **前置依赖**:[13-jit-framework/01 — 谁决定编译、怎么排队、谁执行？— CompileBroker 编译队列](01-compile-broker-queue.md):策略的 `compile()` 落到 broker 的队列;[08-interpreter/03 — 解释器怎么安全地调 C++？— InterpreterRuntime](openjdk/vol-02/08-interpreter/03-interpreter-runtime.md):计数与溢出——事件从哪来;[12-ci/02 — 编译器怎么知道"类型"与"逃逸"？— ciTypeFlow + bcEscapeAnalyzer](openjdk/vol-02/12-ci/02-ci-typeflow-escape.md):C1 的 full profile 采集的就是 ciMethodData 那批数据
> → **后续**:[14-c1-compiler/01 — C1 管线 + HIR — 字节码→编译图](openjdk/vol-02/14-c1-compiler/01-c1-pipeline-ir.md):本篇说"编译到 level 3",下一篇看 C1 内部怎么做
> 关联域: 16-code-cache(nmethod 生命周期)、22-deopt(降级与重编译)

## 为什么不能一步到 C2

C2 是很好的优化器,但它慢: 一个中等方法动辄几百毫秒,启动阶段如果每个热点都直接上 C2,程序会卡在"预热"上。C1 是快的编译器(毫秒级),但优化有限。**分层的妥协**: 先用快编译器让热点尽早跑上机器码,同时用便宜的方式收集 profile,成熟后再让慢编译器做重优化。这就是 TieredCompilation 的 5 层阶梯——本篇拆它的"调度大脑": `TieredThresholdPolicy`。

## 1. 五层,以及"常规路径没有 L1"

层级定义在 `CompLevel` 枚举(compilerDefinitions.hpp:54-62):

```cpp
// compilerDefinitions.hpp:54-63(截取核心,逐字)
enum CompLevel {
  CompLevel_any               = -2,
  CompLevel_all               = -2,
  CompLevel_aot               = -1,
  CompLevel_none              = 0,         // Interpreter
  CompLevel_simple            = 1,         // C1
  CompLevel_limited_profile   = 2,         // C1, invocation & backedge counters
  CompLevel_full_profile      = 3,         // C1, invocation & backedge counters + mdo
  CompLevel_full_optimization = 4          // C2 or JVMCI
};
```

注意 C1 占三层: **1=无 profile 的纯 C1、2=C1+调用/回边计数、3=C1+完整 MDO profile**。分层策略的核心是**状态转换函数 `common`**(tieredThresholdPolicy.cpp:715-816),源码注释给出了权威的转换图(:676-712):

- **a. 0→3→4: 最常见路径**——解释器 → C1 full profile → C2;
- **b. 0→2→3→4: C2 队列负载高时**——先编 level 2(只有计数、便宜),等 C2 队列空下来再升 3(注释: full profile 代码比 limited profile 慢约 30%,C2 忙时不该让大家泡在慢代码里);
- **c. 0→(3→2)→4**: 已入队 level 3 的任务,因 C1 队列长、profile 已在解释器完成,降级为 2;
- **d. 0→3→1 或 0→2→1**: **trivial 方法(accessor/constant getter,`is_trivial` :84-90)或 C2 编不了但 C1 能编的方法**才到 level 1;
- **e. 0→4**: C1 编译失败(仍在解释器 profile)或无需重新 profile。

**大纲的"L0→L1→L2→L3→L4 阶梯"是错的**: 常规转换里根本没有"先到 L1"这一步——L1 是 trivial 方法的专属终点。`common` 里 `is_trivial` 直接返回 `CompLevel_simple`(:720-721),普通方法从 0 出发要么 3 要么 2。

```cpp
// tieredThresholdPolicy.cpp:720-767(截取核心,逐字)
  if (is_trivial(method)) {
    next_level = CompLevel_simple;
  } else {
    switch(cur_level) {
      default: break;
      ...
    case CompLevel_none:
      // If we were at full profile level, would we switch to full opt?
      if (common(p, method, CompLevel_full_profile, disable_feedback) == CompLevel_full_optimization) {
        next_level = CompLevel_full_optimization;
      } else if ((this->*p)(i, b, cur_level, method)) {
        ...
          // C1-generated fully profiled code is about 30% slower than the limited profile
          // code that has only invocation and backedge counters. The observation is that
          // if C2 queue is large enough we can spend too much time in the fully profiled code
          // while waiting for C2 to pick the method from the queue. To alleviate this problem
          // we introduce a feedback on the C2 queue size. If the C2 queue is sufficiently long
          // we choose to compile a limited profiled version and then recompile with full profiling
          // when the load on C2 goes down.
          if (!disable_feedback && CompileBroker::queue_size(CompLevel_full_optimization) >
              Tier3DelayOn * compiler_count(CompLevel_full_optimization)) {
            next_level = CompLevel_limited_profile;
          } else {
            next_level = CompLevel_full_profile;
          }
```

注释还暴露了另一个聪明的细节: **level 2 的存在就是为了"排队减速"**——full profile 代码比 limited profile 慢约 30%,所以 C2 队列长时先编便宜的 2,等 C2 有空再升 3 补 profile。

## 2. 阈值: 两档 predicate

"该升了吗"由两个 predicate 判定:`call_predicate`(调用入口)与 `loop_predicate`(回边/OSR),底层是同一个模板(按当前级别选档):

```cpp
// tieredThresholdPolicy.cpp:44-63(截取核心,逐字)
bool TieredThresholdPolicy::call_predicate_helper(int i, int b, double scale, Method* method) {
  double threshold_scaling;
  if (CompilerOracle::has_option_value(method, "CompileThresholdScaling", threshold_scaling)) {
    scale *= threshold_scaling;
  }
  switch(level) {
  case CompLevel_aot:
    return (i >= Tier3AOTInvocationThreshold * scale) ||
           (i >= Tier3AOTMinInvocationThreshold * scale && i + b >= Tier3AOTCompileThreshold * scale);
  case CompLevel_none:
  case CompLevel_limited_profile:
    return (i >= Tier3InvocationThreshold * scale) ||
           (i >= Tier3MinInvocationThreshold * scale && i + b >= Tier3CompileThreshold * scale);
  case CompLevel_full_profile:
   return (i >= Tier4InvocationThreshold * scale) ||
          (i >= Tier4MinInvocationThreshold * scale && i + b >= Tier4CompileThreshold * scale);
  }
  return true;
}
```

判定是"**单计数达标 或 双计数协同达标**": `i >= TierXInvocationThreshold || (i >= TierXMinInvocationThreshold && i+b >= TierXCompileThreshold)`。一个容易被忽略的细节: **level 3→4 的判定看的是 MDO 的计数增量**(common 的 full_profile 分支: `mdo->invocation_count_delta()`/`backedge_count_delta()`,tieredThresholdPolicy.cpp:802-803——即 level 3 编译代码运行期间新增的计数,而非方法原始计数);`would_profile()` 返回 false(MDO 已收够数据)时更是直接升 4(:807-809)。默认值([实证:](planning/outlines/00-jvm-tools/materials/commands/13-jit-tiered-demo.txt) PrintFlagsFinal):

- **解释器→C1(Tier3 档)**: `Tier3InvocationThreshold=200`、`Tier3MinInvocationThreshold=100`、`Tier3CompileThreshold=2000`——调用 200 次,或 100 次后调用+回边共 2000;
- **C1→C2(Tier4 档)**: `Tier4InvocationThreshold=5000`、`Tier4MinInvocationThreshold=600`、`Tier4CompileThreshold=15000`;
- **回边(OSR)档**: `Tier3BackEdgeThreshold=60000`、`Tier4BackEdgeThreshold=40000`——循环热点按回边计数触发;
- 全部经 `scale` 缩放: ①`CompileThresholdScaling` 指令可按方法覆盖;②**队列负载反馈 `threshold_scale`**(tieredThresholdPolicy.cpp:558-574): `k = queue_size/(Tier3LoadFeedback=5 × compiler_count) + 1`——C1/C2 队列越长阈值越高(排队越久越要"够热才编");code cache 压力大时 C1 阈值再指数抬升(给 C2 留空间)。

08-03 说过的"CompileThreshold=10000"是非 tiered 的旧值;tiered 模式下真正的触发点是上面这五六个数。

## 3. 事件处理: 从计数器溢出到编译请求

08-03 拆过: 解释器计数器溢出 → `InterpreterRuntime::frequency_counter_overflow` → `policy->event()`。`TieredThresholdPolicy::event`(tieredThresholdPolicy.cpp:371)按事件来源分两路(:392-403):

```cpp
// tieredThresholdPolicy.cpp:392-405(截取核心,逐字)
  if (bci == InvocationEntryBci) {
    method_invocation_event(method, inlinee, comp_level, nm, thread);
  } else {
    // method == inlinee if the event originated in the main method
    method_back_branch_event(method, inlinee, bci, comp_level, nm, thread);
    // Check if event led to a higher level OSR compilation
    nmethod* osr_nm = inlinee->lookup_osr_nmethod_for(bci, comp_level, false);
    if (osr_nm != NULL && osr_nm->comp_level() > comp_level) {
      // Perform OSR with new nmethod
      return osr_nm;
    }
  }
  return NULL;
}
```

- **method_invocation_event(:884)**: 先 `create_mdo`(需要 profile 就现场建 MDO,:886-888,12-ci/03 的 `build_interpreter_method_data` 在这里被调)——注意判定条件是 `should_create_mdo`(:638-648): 方法**还在解释器、且计数达到 C1 阈值的 `Tier0ProfilingStartPercentage`=200%**(足够"老")时,就在解释器里提前建 MDO 开 profile——不用等 C1 版本到场(注释 "start profiling without waiting for the compiled method to arrive");→ `call_event`(:889)算下一级 → 级别变了且编译可用 → `compile(mh, InvocationEntryBci, next_level)`(:896)——**普通编译**,入口是方法入口;
- **method_back_branch_event(:903)**: 回边溢出——`loop_event` 算下一级 → `compile(imh, bci, next_osr_level)`(:918)——**OSR 编译**,入口是回边的 bci;顺带借这个事件检查"该不该顺便普通编译"(:921-932);**编译完成且级别更高时直接把新 nmethod 交给解释器跳转**(:398-402,OSR 的执行入口);
- `call_event` 里有个巧妙的**级别均衡**(:827-834): 方法已有 C2 OSR 版本时,把普通编译级别提到 C2——否则每次调用都 OSR 一次(注释: "avoid OSRs during each invocation")。

**计数重置**: `handle_counter_overflow`(:273)把溢出计数**打上 carry 标志**(`set_carry_if_necessary`,:266-269,计数过半就置位)——防止刚编译完又立刻触发。

[实证:](planning/outlines/00-jvm-tools/materials/commands/13-jit-tiered-demo.txt) `CiDemo::work` 的完整 tier 链(PrintCompilation): `%3`(OSR 到 tier3)→ `3`(普通 tier3)→ `%4`(OSR 到 tier4)→ `4`(普通 tier4),旧的 `%3`/`%4` 依次 `made not entrant`——与 08-03 的 CounterDemo 链(tier3→`%`tier4@4→tier4→made not entrant)同款。注意实证里先出现 `%3` 再出现 `3`——**循环热点先走 OSR**,普通入口随后补上,正是本篇两条事件路的实况。

## 4. TieredStopAtLevel: 把阶梯砍短

`TieredStopAtLevel`(默认 4)决定最高允许的级别——`common` 返回前 `MIN2(next_level, TieredStopAtLevel)`(:815)。[实证:](planning/outlines/00-jvm-tools/materials/commands/13-jit-tiered-demo.txt) `-XX:TieredStopAtLevel=1` 时 CiDemo::work 只编出 `%1`/`1`(纯 C1,无 profile,就是大纲设想的 L1 形态——但它不是"阶梯的一级",而是"砍到只剩一级");`=3` 时最高 `%3`/`3`(full profile 封顶,不碰 C2)。调试/对比编译器行为时这是最常用的旋钮。

## 核心悬念

分层策略拆完了: 5 层(0 解释器/1 C1 无 profile/2 C1 计数/3 C1 全 profile/4 C2);**常规路径是 0→3→4**(C2 队列忙时走 0→2→3→4,trivial 方法才碰 1);两档阈值(200/100+2000 到 C1,5000/600+15000 到 C2,回边 60000/40000)+ 队列负载反馈缩放;事件两路(调用→普通编译、回边→OSR 编译 + 级别均衡);TieredStopAtLevel 砍阶梯。一句话: **快编译器负责"早点跑起来 + 便宜地攒 profile",慢编译器负责"等数据成熟后做重活"——两个队列、两套阈值、一条成熟度曲线。**

但"编译到 level 3"只是说 C1 接手了——C1 内部怎么把字节码变成机器码?它和 C2 的管线有什么不同,才让它快一个量级?下一篇进入编译器内部: C1 的 6 步管线。

> → [14-c1-compiler/01 — C1 管线 + HIR — 字节码→编译图](openjdk/vol-02/14-c1-compiler/01-c1-pipeline-ir.md)
