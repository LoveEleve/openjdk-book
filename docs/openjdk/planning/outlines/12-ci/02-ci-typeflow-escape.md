# 02. ciTypeFlow + bcEscapeAnalyzer — 类型流与逃逸分析

> 🔴 Deep | 11 KP 中的 2 个核心机制
> 读者处境: C2 需要知道每个 bci 的栈+局部变量类型——从 bytecode 推导——处理分支/异常/循环。然后判断对象是否"逃逸"——决定能否栈上分配。

> ⚠️ 写作期修正(2026-08-13, vol-02/12-ci/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"common_type / ciType::top" 名字错**: 真实=StateVector::type_meet/type_meet_internal(ciTypeFlow.cpp:272),顶层元素=top_type(T_VOID 占位)/bottom(T_CONFLICT)/long2/double2/null(ciTypeFlow.hpp:175-187);meet 语义: top 吸收/null 恒等/原语互不相遇→bottom/接口与非接口→Object(注释 "This is what the verifier does",:299-303,44 域同源)/数组递归元素规则(:310-330)/两实例类→least_common_ancestor(:334)
> - **"两阶段 flow-sensitive + merge" 简化**: 真实=flow_types(ciTypeFlow.cpp:2727): 入口块 get_start_state(OSR 时取非 OSR 分析在 osr_bci 的块状态,:346 起)→DFS→循环头克隆 clone_loop_heads(仅 comp_level>=full_optimization,:2747-2762)→work list 迭代到 fixpoint(:2770-2782,flow_block :2326 内 can_trap 先流异常边 :2359-2362 再 apply_one_bytecode :2364,块尾 flow_successors :2426 对后继 meet 变化即入队 :2160-2166)
> - **"StateVector::meet" 存在但细节补**: meet(ciTypeFlow.cpp:438)逐格 type_meet 返回是否变化(:470-482);meet_exception(:492): locals 照常 meet,栈重置 stack_size=1 且 tos meet 异常类型(:499-501/:527-535)
> - **异常处理器机制补**: Block::compute_exceptions(ciTypeFlow.cpp:1790)用 ciExceptionHandlerStream 遍历异常表按 handler_bci 建块,catch-all→Throwable_klass(:1819-1823)
> - **"BCEscapeAnalyzer 输入含 ciTypeFlow 结果" 错**: 输入=ciMethod+ciMethodBlocks(do_analysis bcEscapeAnalyzer.cpp:1201 自己 iterate_blocks),与 ciTypeFlow 无关
> - **"ConnectionGraph 在 BCEscapeAnalyzer 里" 错(编造)**: ConnectionGraph 是 C2 opto/escape.cpp 的(:320 类定义);bcEscapeAnalyzer 是"fast, conservative analysis...at the bytecode level"(bcEscapeAnalyzer.hpp:38-40),输出=参数/返回值逃逸位图(VectorSet _arg_local/_arg_stack/_arg_returned + _return_local/_return_allocated/_allocated_escapes,:54-64);三档术语 NoEscape/ArgEscape/GlobalEscape 属于 ConnectionGraph(escape.hpp:155-160),不是 bcea
> - **"_arg_escapes[]/_alloc_escapes[]" 不存在**: 真实访问器 is_arg_local/is_arg_stack/is_arg_returned/is_return_local/is_return_allocated(bcEscapeAnalyzer.hpp:124-147)
> - **"ciMethod::scalar_replacement_possible()" 不存在(编造)**: 真实=C2 ConnectionGraph::scalar_replaceable(escape.cpp:256/273)+find_scalar_replaceable_allocs(:268),替换本体在 PhaseMacroExpand(macro.cpp)
> - **"输出 _alloc_escapes 三态" 简化**: 算法=乐观初始化(initialize bcEscapeAnalyzer.cpp:1233: 引用参数全标 local+stack,:1242-1254)+降级: putfield/putstatic 被写的值→set_global_escape、receiver→set_method_escape+set_modified(:876-888);aaload→set_method_escape+set_dirty(:488-492);invoke 被调方"栈逃逸未返回"→set_method_escape+记依赖、否则 global(:336-339);非单形态→全 global+_unknown_modified(:355-363);递归用 _parent/_level(is_recursive_call :90)
> - **缺机制**: ①依赖记录——bcea 的 _dependencies(bcEscapeAnalyzer.hpp:66,invoke 时 append 接收者/内联目标 :349-351,与 01 篇 Dependencies 呼应);②can_trap 特例(ciTypeFlow.cpp:2169-2197: ldc/aload_0/return/monitorexit 假设不抛,保 monitor 分析);③StateVector 类型格细节 push_translate(boolean/char/byte/short→int,:540-552)、long/double 双槽
> - **实证**: 12-ci-typeflow-escape-demo.txt(EscDemo: noEscape 400 万次 new Point=1ms vs escape 40 万次进 ArrayList=18ms;-XX:-EliminateAllocations 后 5ms/9ms 差异消失——开关对照证明标量替换;PrintCompilation 确认 noEscape %4 OSR 编译);CITraceTypeFlow/CIPrintTypeFlow 是 develop flag(globals.hpp:1139/1142)release 不可用,勿引用

### 1. ciTypeFlow — 字节码类型流推导

场景: `String.length()` 方法——C2 编译前需要知道: bci=0 栈是 empty, 局部变量=this(String)。bci=5 invokevirtual——需要 receiver 类型=String——来判断能否 devirtualize。ciTypeFlow 从 bytecode 推导所有 bci 的类型状态。

**ciTypeFlow** (`ciTypeFlow.hpp.cpp`):
- 输入: ciMethod + ciMethodBlocks (基本块)
- 输出: `StateVector`——每个 bci 的栈类型+局部变量类型——`ciType*` 数组
- [C++: ciTypeFlow 的两阶段——Phase 1: flow-sensitive 分析——从 bci=0 开始——每条字节码模拟其栈+局部变量影响——类似栈操作的抽象解释。Phase 2: merge—分支汇合 (if/else 后)—`ciType::common_type(t1, t2)` 取两个分支类型的共同父类——没找到→`ciType::top` (未知)—后续 C2 需要 safe point]
- 异常处理器 (exception handler): try block→handler——`catch(Exception e)`——handler bci 的局部变量=exception object (ciInstanceKlass of Exception)—其他 locals 是 try block 的 locals——栈深=1
- 循环: 循环头的入口类型——第一次从 predecessor 推导——后续 iterations 不变——达到 fixpoint→停止
- [C++: `StateVector::meet(StateVector other)`——两个分支汇合——取 `ciType::common_type(t1, t2)`——如果 t1=String, t2=StringBuilder→common=Object (近父类)→精确度下降。类型越精确→C2 可做的优化越多 (inline/devirtualize/field exact type)]

### 2. BCEscapeAnalyzer — 对象逃逸分析

场景: `Point p = new Point(1,2); return p.x + p.y;`——p 只在当前方法内使用——不"逃逸"到外部 (不存到静态字段/不返回给调用者/不传入其他方法作为参数)——C2 可以**不分配 p**——直接算 1+2——栈上分配。

**BCEscapeAnalyzer** (`bcEscapeAnalyzer.hpp.cpp`):
- 输入: ciMethod + ciTypeFlow 的结果 (每个 bci 的类型信息)
- 输出: `_arg_escapes[]` (参数逃逸) + `_alloc_escapes[]` (方法内分配逃逸)
- NoEscape: 对象不离开方法→可以 scalar replacement (栈上分配每个 field→消除堆分配)
- ArgEscape: 对象作为参数传出去→不能消除——但调用者可能没有存——需要 inter-procedural analysis
- GlobalEscape: 对象存到 static field→其他线程可见→完全不能消除
- [C++: ConnectionGraph——`BCEscapeAnalyzer::ConnectionGraph`——节点=分配点+参数+字段——边="引用" (赋值/传参/存字段)——从每个分配点出发——DFS 找所有可达的"逃逸点"(static field/return/argument to unknown method)——到达→标记为逃逸]
- `ciMethod::scalar_replacement_possible()`: 如果 NoEscape→C2 PhaseMacroExpand 做 scalar replacement——把 `new Point` 拆成两个局部变量 `x` 和 `y`——消除堆分配——GC 压力降

---

### 核心悬念

**"`Point p = new Point(1,2); return p.x + p.y;`——p 没有逃逸——C2 不分配堆对象——拆成两个局部变量——GC 零压力。"** — ciTypeFlow 提供每个 bci 的精确类型——BCEscapeAnalyzer 判断对象去向——connection graph DFS 找逃逸点。如果 `p` 被 `list.add(p)`——arg escape——不能消除——必须分配。下一次: ciObjectFactory——ciObject 怎么管理 GC 安全问题。

> → [03-ci-factory-runtime.md](03-ci-factory-runtime.md)
