# 01. 编译代码什么时候回退？— Deopt 决策表

> 🔴 Deep | 2 KP 中的运行时决策
> 读者处境: C2 编译 `obj.foo()` 时假设 obj 一直是 Foo 类型——直接内联 Foo.foo()。运行时 obj 是 Bar(Foo子类)——IC 发现不匹配——需要"逆优化"回解释器。

> ⚠️ 写作期修正(2026-08-16,22-deoptimization/01 完成,第 7 批开篇):
> - **"Reason→Action 映射表 (deoptimization.cpp:200-350) + action_for_reason" 编造(重要)**: 都不存在;action 是**编译器在生成 trap 代码时选的**——C2 的 GraphKit::uncommon_trap(reason, action, ...)(graphKit.hpp:733-740)显式带 action;运行时 uncommon_trap_inner(deoptimization.cpp:1526)按 action switch(:1797-1837)+MDO 计数做 hysteresis
> - **"trap_state 31-bit [action:3][reason:5][debug_id:23] 存 MethodData" 混淆(重要)**: 31 位 action+reason+debug_id 是 **trap_request**(一次调用的编码,deoptimization.hpp:117-125 位域常量,_action_shift=0/_reason_shift=3/_debug_id_shift=8;补码 ~ 编码,:304-347 解包;大纲的 "trap_bits >> 24=action" 全错);**trap_state 是另一回事**=DataLayout::trap_bits **1+31 位**(methodData.hpp:139-142): 1 位 recompile + 31 位 reason 格(0=无/reason/Reason_many 格底,trap_state_reason :2118/trap_state_add_reason :2149)——per-bci 只有 1 位计数(注释 :1879-1883 "{0,1,(per-method count)}")
> - **"PerBytecodeTrapLimit 默认 100" 错**: 默认 **4**(globals.hpp:1788);PerMethodTrapLimit=**100**(:1779)/PerMethodSpecTrapLimit=5000(:1783)/PerBytecodeRecompilationCutoff=**200**(:1775)/PerMethodRecompilationCutoff=**400**(:1771);per_method_trap_limit(deoptimization.hpp:408-411)
> - **"100 次反复 deopt→永久禁用 JIT" 简化**: 真实=**三种防死循环措施**(deoptimization.cpp:1745-1769 注释): ①同点同因二次重编译→调整 reinterpret+overflow_recompile_count(:1750-1756);②overflow_recompile_count>PerBytecodeRecompilationCutoff→make_not_compilable(:1960-1966 set_not_compilable :1980);③PerMethodRecompilationCutoff 大限(:1765-1769);per-bci 达 PerBytecodeTrapLimit 就 make_not_entrant(:1875-1883)
> - **"null_check→Action_maybe_recompile 映射" 是编译器的选择**: parse2.cpp 的 uncommon_trap(reason, ...)(:150/:190/:245)带 action 参数;运行时只管执行
> - **per-method 计数**: _trap_hist u1 数组 per reason(methodData.hpp:1986-2007,tenured 除外)+_nof_overflow_traps;MethodData::trap_count(:2384)
> - **DeoptReason 行号 ✓**(deoptimization.hpp:42-106: per-bytecode 8 个注释 :45-46/null_check :52/tenured=TRAP_HISTORY_LENGTH :96/RECORDED_LIMIT :103);DeoptAction ✓(:108-115)
> - **悬念指向** ✓(02-unpack-frames);素材: 22-deopt-type-demo.txt(类型切换三次: 75 % 4 内联 Square→74 3 made not entrant+201 % 4 双路内联→200 3 made not entrant+202 4)

### 1. "为什么我挂了？" — 20 种 DeoptReason

场景: JIT 编译了 1000 个方法——每秒钟可能有 0.1 个需要 deopt。deopt 的原因不是统一的——有的是 null 出现了(不常见但合法)，有的是类型假设彻底破了(需要重新编译)。

**DeoptReason 分类** (`deoptimization.hpp:42-104`):
```
Per-bytecode (记录在 MethodData trap_bits):
  Reason_null_check     — 预期非null→null
  Reason_null_assert    — 预期null→非null
  Reason_range_check    — 数组索引越界
  Reason_class_check    — 对象类型不匹配(checkcast/instanceof预测)
  Reason_array_check    — 数组类型不匹配(aastore)
  Reason_intrinsic      — intrinsic操作数不符合预期
  Reason_bimorphic      — 预测有2个target,实际是第3个
  Reason_profile_predicate — loop profile预测失败

Per-method (记录在 nmethod 全局):
  Reason_unloaded       — 类被卸载
  Reason_uninitialized  — 类未初始化完毕
  Reason_unreached      — 编译生成的死代码
  Reason_constraint     — 运行时约束违反(如被final字段限制)
  Reason_age            — nmethod 太旧(分层编译降级)
  Reason_loop_limit     — 循环次数悖反编译假设
  Reason_unstable_if    — 编译器预测永远不走的branch走了
  Reason_tenured        — nmethod 到达寿命上限
```
- 源码: `deoptimization.hpp:42-104` enum DeoptReason
- 关键设计: per-bytecode vs per-method 的两层——null_check(特定bci偶发异常) vs unloaded(全局类失效)。per-bytecode 记录在 MethodData 的 DataLayout::trap_bits(31 bit per bci)——让 JIT 知道"这个 bci 的 null 预测失败过几次"→ 决定重编译时的保守度

### 2. "我该怎么办？" — 5 种 DeoptAction

场景: null 出现了一次——不需要失效 nmethod。但如果 class_check 失败了(类型破产)→失效 nmethod→重新编译更保守的版本。

**DeoptAction 决策** (`deoptimization.hpp:108-115`):
```
Action_none          → 只有 deoptimize，不失效 nmethod(下次可能成功)
Action_maybe_recompile → 保留 nmethod，标记重编译(precompile if hot)
Action_reinterpret   → 失效 nmethod、重置 IC、可能重编译
Action_make_not_entrant → 失效 nmethod(not_entrant)、重编译(可能用不同假设)
Action_make_not_compilable → 失效 nmethod + 永久不编译该方法的该level
```
- 源码: `deoptimization.hpp:108-115` enum DeoptAction
- 关键设计: Action 层级递增——none 最轻(profiling data 收集)，not_compilable 最重(trap_count > PerBytecodeTrapLimit)。中间三层 (maybe_recompile/reinterpret/make_not_entrant) 根据原因历史动态选择

**Reason→Action 映射** (`deoptimization.cpp:200-350`):
```
null_check     → Action_maybe_recompile (偶发异常，保留nmethod)
class_check    → Action_make_not_entrant (类型破产，必须重编)
unloaded       → Action_make_not_entrant (类没了，nmethod 废了)
tenured        → Action_make_not_compilable (老化，不要编译了)
loop_limit     → Action_reinterpret (循环假设破了，重置IC)
unstable_if    → Action_maybe_recompile (分支预测错了，profiling 修正)
```
- 关键设计: 不是每种 deopt 都会使编译代码失效——JVM 根据"假设是否永久破产"和"是否值得重编译"两个维度决定 Action。null_check 是偶发的——留着 nmethod 继续跑。class_check 是永久性的——这条 nmethod 运行的假设基础已经变了
- [C++: `Deoptimization::uncommon_trap()` 调用 `action_for_reason()` switch on DeoptReason→返回DeoptAction。如果返回 none→不记录 trap→nmethod 不受影响。如果是 not_entrant→调 nmethod::make_not_entrant()→从IC清掉→CompileBroker可能重新编译]

### 3. "给你记一笔" — trap_state 31-bit 编码

场景: JIT 编译方法时看 MethodData——"这个 bci 的 null_check 失败过多少次？"。每个 bci 有一个 trap counter——存在 31-bit 压缩格式的 trap_state 中。

**trap_state 31-bit 格式** (`deoptimization.hpp:117-130`):
```
trap_state = [action:3bit][reason:5bit][debug_id:23bit]
  action: 5种 → 3 bit (8值足够)
  reason: 20+ → 5 bit (32值足够)
  debug_id: 23 bit → record nmethod compile_id(可选)
```
- 源码: `deoptimization.hpp:117-130` 字段定义
- 关键设计: 全压缩到 32-bit——存进 MethodData 的 DataLayout(每个 hot bci 的 profiling slot)。不是每 trap 一个新 slot→而是覆盖写入→最新 trap 覆盖之前。rare traps 不被记录(none action)→节省 profiling 空间
- [C++: 3+5+23=31 bit packed into one int32. Per-bytecode record→每个频繁执行的 bci 有一个 DataLayout(分配在 MethodData 的 VariableSizedSegment 中) `trap_bits` 字段存这个压缩值。用 bitmask 提取对应部分: `trap_bits >> 24`=action, `(trap_bits >> 19) & 0x1F`=reason, `trap_bits & 0x7FFFF`=debug_id]

**PerBytecodeTrapLimit** (`deoptimization.cpp:1875-1920`):
```
trap_count[this_bci] += 1
if trap_count > PerBytecodeTrapLimit(默认 100):
  → Action_make_not_compilable  // 这个bci太折腾了，放弃JIT
```
- 关键设计: limit=100 不是"100次 trap 就禁"——是"100次 deopt 返回 Action_reinterpret 以上"——每 deopt 都重新编译。连续重复 deopt→count递增→100后→放弃JIT→解释器老实用

---

### 核心悬念

**"Deopt 有两种决策维度——20+ 原因(为什么坏了)+5种动作(怎么办)。null_check 保留 nmethod(偶发的)，class_check 使 nmethod 失效(类型破产)。100次反复 deopt→永久禁用 JIT。"** — 但 deopt 怎么实际执行？下一篇: unpack 帧重建。

> → [02-unpack-frames.md](02-unpack-frames.md)
