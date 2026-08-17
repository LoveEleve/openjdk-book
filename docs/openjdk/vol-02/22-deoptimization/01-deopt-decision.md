# 01. 编译代码什么时候回退？— Deopt 决策表

> **前置依赖**:[16-code-cache/05 — Dependencies 与 Deopt — JIT 的乐观假设与自救](openjdk/vol-02/16-code-cache/05-dependencies-deopt.md):nmethod 的依赖失效(deopt 的另一大入口)与 made not entrant 状态;[13-jit-framework/02 — 为什么先 C1 再 C2？— TieredThresholdPolicy 5 层编译策略](openjdk/vol-02/13-jit-framework/02-tiered-compilation-policy.md):分层编译的升级/降级,[21-shared-runtime/01 — 编译代码遇到问题——向谁求助?— Runtime Stubs](openjdk/vol-02/21-shared-runtime/01-runtime-stubs.md):UncommonTrapBlob 与 deopt blob 的生成
> → **后续**:[22-deoptimization/02 — 从编译帧回到解释器——unpack 帧重建](02-unpack-frames.md)
> 关联域: 16-code-cache(nmethod 状态机)、13-jit-framework(编译策略)、28-jvmti(类重定义的 deopt)

## 一次类型切换,两次回退

[实证](openjdk/planning/outlines/00-jvm-tools/materials/commands/22-deopt-type-demo.txt)让 `DeoptDemo` 先热调用 `Square.area()`(接口调用),切换成 `Circle`,再切回:

```
# 阶段 1: 热调用 Square——C2 内联 Square.area(compile_id 75, level 4)
[0.040s][debug][jit,compilation]   75 %     4       DeoptDemo::hot @ 2 (30 bytes)
[0.040s][debug][jit,inlining   ]                               @ 13   Square::area (3 bytes)   inline (hot)

# 阶段 2: 切换 Circle——旧 nmethod 失效,重编译成双路内联
[0.557s][debug][jit,compilation]   74       3       DeoptDemo::hot (30 bytes)   made not entrant
[0.557s][debug][jit,compilation]  201 %     4       DeoptDemo::hot @ 2 (30 bytes)
[0.557s][debug][jit,inlining   ]                               @ 13   Square::area (3 bytes)   inline (hot)
[0.557s][debug][jit,inlining   ]                               @ 13   Circle::area (4 bytes)   inline (hot)

# 阶段 3: 切回 Square——再次失效重编译
[0.562s][debug][jit,compilation]  200       3       DeoptDemo::hot (30 bytes)   made not entrant
[0.560s][debug][jit,compilation]  202       4       DeoptDemo::hot (30 bytes)
```

编译代码内联了 `Square.area`——这是**乐观假设**(调用点始终是 Square);阶段 2 换类型后,调用点实际类型与假设不符,代码无法继续执行,必须**回退到解释器**并从正确的字节码位置继续——旧 nmethod 随后 made not entrant,重编译学乖了(双路内联)。这篇拆"决策"这半边: 为什么会回退(Reason)、回退后怎么办(Action)、决策怎么记账(trap 历史)——执行部分(unpack 帧重建)是下一篇。

## 1. 两个维度: 为什么(Reason)与怎么办(Action)

`deoptimization.hpp` 开篇就是两张枚举。**DeoptReason**(:42-106)把原因分成两类,注释 :45-46 是权威分界——"Next 8 reasons are recorded per bytecode in DataLayout::trap_bits":

- **per-bytecode 8 个**(`Reason_null_check`/`null_assert`/`range_check`/`class_check`/`array_check`/`intrinsic`/`bimorphic`/`profile_predicate`): 记录在**具体字节码**的 profiling 槽里——"这个 bci 的 null 假设破了";
- **per-method 一批**(`unloaded`/`uninitialized`/`unreached`/`unhandled`/`constraint`/`div0_check`/`age`/`predicate`/`loop_limit_check`/`speculate_class_check`/`speculate_null_check`/`rtm_state_change`/`unstable_if`/`unstable_fused_if`): 全局性的失效(类卸载、代码老化);
- 尾巴上 `Reason_tenured`(=Reason_TRAP_HISTORY_LENGTH,代码老化到寿命上限,:96)单独计数,`Reason_RECORDED_LIMIT = profile_predicate`(:103,per-bytecode 记录的上限)。

**DeoptAction**(:108-114)是五种"怎么办":

```cpp
// deoptimization.hpp:108-115(截取核心,逐字)
  enum DeoptAction {
    Action_none,                  // just interpret, do not invalidate nmethod
    Action_maybe_recompile,       // recompile the nmethod; need not invalidate
    Action_reinterpret,           // invalidate the nmethod, reset IC, maybe recompile
    Action_make_not_entrant,      // invalidate the nmethod, recompile (probably)
    Action_make_not_compilable,   // invalidate the nmethod and do not compile
    Action_LIMIT
  };
```

*关键设计: action 不是运行时从 reason 查表算出来的*——**是编译器在生成 trap 代码时选的**。C2 的 `GraphKit::uncommon_trap(reason, action, ...)`(graphKit.hpp:733-739)在每次"这里可能失败"的假设处显式带上 action: 类型检查假设→make_not_entrant,循环谓词→maybe_recompile,等等。大纲的"Reason→Action 映射表(deoptimization.cpp:200-350)"与 `action_for_reason()` 都不存在——运行时拿到的 action 是编译代码里编码好的。

## 2. trap_request: 一次调用的编码

假设被打破时,编译代码跳 `UncommonTrapBlob`(codeBlob.hpp:642,21-01 的 generate_uncommon_trap_blob 生成),把"要什么 action、为什么、哪个类"编码进一个 int 传进 `Deoptimization::uncommon_trap(thread, trap_request, exec_mode)`(:2095)。编码在位域里(:117-124):

```cpp
// deoptimization.hpp:117-125(截取核心,逐字)
  enum {
    _action_bits = 3,
    _reason_bits = 5,
    _debug_id_bits = 23,
    _action_shift = 0,
    _reason_shift = _action_shift+_action_bits,
    _debug_id_shift = _reason_shift+_reason_bits,
  };
```

**action 3 位(低位)+ reason 5 位 + debug_id 23 位**——共 31 位,用补码(`~`)编码(0/负值区分"无 trap"与"有 trap",`trap_request < 0` 表示真正的 trap,:304-306)。解包是 `trap_request_reason/action/debug_id`(:304-347),位提取即 `(~trap_request >> _reason_shift) & right_n_bits(_reason_bits)` 之类。

注意大纲把两件事混为一谈了: **trap_request 是"这次调用"的 31 位编码(运行时参数)**;**trap_state 是"这个 bci 的历史"**(下节)——它存在 MethodData 里,不是 31 位 action+reason+debug_id。

## 3. 运行时: uncommon_trap_inner 的决策

`uncommon_trap_inner`(:1526)是真正的决策中心。先做一堆准备工作(解包 reason/action/debug_id、取 trap scope、日志、必要时加载类,:1526-1740),然后进入核心——:1745 起的大注释"Flush the nmethod if necessary and desirable"是设计文档,讲了**防 deopt-重编译死循环的三种措施**: ①同点同因第二次重编译→action 调整为 reinterpret,给解释器时间(:1755-1757);②overflow_recompile_count 超限→make_not_compilable,放弃该方法(:1758-1763);③PerMethodRecompilationCutoff 大限(:1765-1769)。

决策本身是**按 action 的 switch**(:1797-1837)+ **MDO 计数的 hysteresis**:

```cpp
// deoptimization.cpp:1802-1837(截取核心,逐字)
    case Action_maybe_recompile:
      // Do not need to invalidate the present code, but we can
      // initiate another
      // Start compiler without (necessarily) invalidating the nmethod.
      // The system will tolerate the old code, but new code should be
      // generated when possible.
      break;
    case Action_reinterpret:
      // Go back into the interpreter for a while, and then consider
      // recompiling form scratch.
      make_not_entrant = true;
      // Reset invocation counter for outer most method.
      reprofile = true;
      break;
    case Action_make_not_entrant:
      // Request immediate recompilation, and get rid of the old code.
      make_not_entrant = true;
      break;
    case Action_make_not_compilable:
      // Give up on compiling this method at all.
      make_not_entrant = true;
      make_not_compilable = true;
      break;
```

然后 MDO 计数介入(:1852-1918): `query_update_method_data` 更新 per-bci 的 trap 历史并取回 `this_trap_count`;对 per-bytecode 原因,**`this_trap_count >= PerBytecodeTrapLimit`(默认 4,globals.hpp:1788)就强制 make_not_entrant**(:1875-1883,注释还点破一个细节: per-bci 只有 1 位计数器,可能的计数是 {0, 1, per-method count}——多位点会互相抢功);再检查 `per_method_trap_limit(reason)`(=PerMethodTrapLimit 100,speculate 用 5000,:408-411)兜底(:1907)。

落地动作(:1925-1982): `make_not_entrant → nm->make_not_entrant()`(:1929,类型切换场景的失效走的就是这条路;实证里阶段 1 的 OSR 版本失效是替换导致)→ 在 pdata 记 recompile 位;`overflow_recompile_count > PerBytecodeRecompilationCutoff(200)`→`set_not_compilable`(:1960-1966);`reprofile → CompilationPolicy::reprofile`(:1974)重置计数器;`make_not_compilable → method->set_not_compilable`(:1980)。**注意: Action_none 时 update_trap_state=false,什么都不记、什么也不失效**——trap 结果只是多跑几遍解释器。

## 4. trap 历史: MDO 里的账

编译器下次编译时怎么知道"这个 bci 老出事"?——**MethodData**。两个记账点:

**per-bci: `DataLayout::trap_bits`(methodData.hpp:139-142)= 1+31 位**——1 位 recompile + 31 位 reason(格)。trap_state 的语义是**格**(trap_state_reason :2118): 0=无 trap、某个 reason 值、reason 字段全 1(=`DS_REASON_MASK`,deoptimization.cpp:2113)时解码为 `Reason_many`(格底,多个原因);高位 `DS_RECOMPILE_BIT`(:2114)表示"这里重编译过"。`trap_state_add_reason`(:2149)把新 reason 并入格(不同 reason→掉到格底)。**这不是 3+5+23 的压缩计数器,而是"最近一次原因+是否重编译过"的格**——大纲的 31 位 action+reason+debug_id 编码与位提取公式全是对 trap_request 的误植。

**per-method: `_trap_hist`(methodData.hpp:1986-2007)**——`u1 _array[Reason_TRAP_HISTORY_LENGTH]`,每个 reason 一字节计数(tenured 除外),加 `_nof_overflow_traps`/`overflow_recompile_count`;`MethodData::trap_count(reason)`(:2384)读它。per-bci 的 1 位 + per-method 的多字节,合起来给编译器"重编译时保守多少"的输入。

*关键设计: 决策是"编译器预设 + 运行时计数微调"的两层*——action 定基调(编译期假设有多乐观),MDO 计数做 hysteresis(同一个 bci 反复出问题才升级,防抖动)。

## 核心悬念

Deopt 决策半边拆完: 两个维度(per-bytecode/per-method 的 20+ 原因 + 5 种动作,action 由编译器在 GraphKit::uncommon_trap 里预设);trap_request 用 3+5+23 位编码一次调用;运行时 uncommon_trap_inner 按 action switch + MDO 计数做 hysteresis(PerBytecodeTrapLimit=4/PerMethodTrapLimit=100/RecompilationCutoff 200/400,三种防死循环措施);trap 历史分 per-bci 的 1+31 位格与 per-method 的计数数组。但"回退"说了决策没说执行——**决策之后,编译栈帧怎么变回解释器帧链**?ScopeDesc 怎么还原局部变量、内联层怎么拆、解释器从哪个 bci 继续?下一篇: unpack 帧重建。

> → [22-deoptimization/02 — 从编译帧回到解释器——unpack 帧重建](02-unpack-frames.md)
