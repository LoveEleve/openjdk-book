# 02. Parse + GraphKit — 字节码→Ideal Graph

> 🔴 Deep | 16 KP 中的 2 个核心机制——字节码到 C2 IR
> 读者处境: C2 开始编译→Parse 逐 bytecode 构建 C2 Node。inline 决策——`do_call()`→`should_inline()`→递归 `new Parse(callee_method)`→callee 的 Node 内联到此方法。GraphKit 提供 node factory——每个 new Node 自动连 control/memory/i_o state。

### 1. "Parse — 逐字节码→C2 Node"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"iload_1→do_load(Bci)→LocalNode→push(value)" 编造**: 无 do_load/LocalNode;iload 系列直接 `push(local(n))`(parse2.cpp:2014-2033,局部变量 Value 压栈零成本,与 01 篇 load_local 一致)
> - **"do_arith()" 编造**: 无此函数;iadd 等在 do_one_bytecode switch 内联 `push(_gvn.transform(new AddINode(a,b)))`(parse2.cpp:2250-2253)
> - **"Parse::do_inline()" 编造**: 无此函数;内联递归=ParseGenerator::generate→`Parse parser(jvms, method(), _expected_uses)`(callGenerator.cpp:84-111)
> - **"Parse::Parse (line 390)" 对**: parse1.cpp:390 ✓;但**块驱动非线性读**: do_all_blocks RPO(:632-733)→do_one_block(:1465)→do_one_bytecode switch(parse2.cpp:1907);ciTypeFlow 先行(_flow=get_flow_analysis parse1.cpp:427→ciMethod.cpp:352-359 do_flow)
> - **文件归属错**: do_call 在 **doCall.cpp:423**(非 parse1.cpp);字段访问 do_field_access 在 **parse3.cpp:76**(非 parse2.cpp:200-500)
> - **补充机制**: do_if/do_ifnull(parse2.cpp:1449/:1529)=BoolNode→create_and_xform_if→IfTrue/IfFalse set_control→merge;do_method_entry(parse1.cpp:1183-1226)四件事(dtrace/FastLock/参数 profiling/计数器);uncommon_trap 随时切断路径(:1511-1518)


场景: bytecode `iload_1`→`Parse::do_load(Bci)→LocalNode(value=locals[1])→push(value)`。`invokevirtual`→`do_call()`→inline decision→build callee graph→C2 Node→push result。整个方法从 Bci 0 开始逐条 bytecode→构建 Node→直到 RETURN。

**Parse** (`parse1.cpp:390-800 + parse2.cpp`):
```
Parse::Parse(caller, parse_method, expected_uses) (line 390):
  → 遍历 bytecodes with RawBytecodeStream
  → switch(opcode):
      iload_1      → do_load() → LocalNode → push(Local)
      iadd         → do_arith() → AddINode → pop+pop+push
      invokevirtual → do_call() → inline decision
      ifeq         → do_if() → IfNode → split control flow(True/False paths)
      return       → ReturnNode → finalize graph

Inline 递归 (parse1.cpp:800-1200):
  do_call():
    → InlineTree::should_inline(method, caller) — 检查 bytecode size(<MaxInlineSize=35)
    → check max inline depth(default 9) + frequency
    → if ok: Parse::do_inline() → new Parse(callee_method, this)
    → 返回——callee 的全部 Node 现在是 caller graph 的一部分
[C++: parse1.cpp+parse2.cpp+parse3.cpp——三个文件按 bytecode 类型分: load/store/arithmetic→call/invoke/new→branch/return/exception]
```
- 源码: `parse1.cpp:390-600` (Parse constructor→bytecode loop) + `parse1.cpp:800-1200` (do_call→inline decision) + `parse2.cpp:200-500` (do_field/do_array→LoadNode/StoreNode)

- 关键设计: **C2 inline 远比 C1 激进**——C1 只 inline tiny methods(bytecode size < 35, depth ≤ 2)。C2 inline: MaxInlineSize=35(默认), MaxInlineDepth=9, 高频方法优先。递归 inline——`do_call()`→`should_inline()`→如果 yes→`Parse::do_inline()`→递归 `new Parse(callee_method, this)`→callee graph 构建→merge 到 caller graph。**OSR(On-Stack Replacement)**: from interpreter→compile at loop bci→从 OSR entry 开始构建 graph→循环变量 from interpreter frame。

### 2. "GraphKit — Node factory + state wiring"
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"max inline depth(default 9)" 错**: 真实 **MaxInlineLevel=15**(globals.hpp:1692);深度检查 `inline_level()>_max_inline_level`→"inlining too deep"(bytecodeInfo.cpp:400-407);递归 MaxRecursiveInlineLevel=1(:436-439)
> - **"C1 只 inline tiny methods(bytecode size<35, depth≤2)" 错**: C1 同样用 MaxInlineSize/MaxInlineLevel/MaxRecursiveInlineLevel(c1_GraphBuilder.cpp:3801-3803),另有 **NestedInliningSizeRatio=90% 逐层衰减**(c1_globals.hpp:177,:700-705)——实证: C1 树里 7 字节 d6 也 "callee is too large"
> - **"should_inline(method, caller)→new Parse(callee_method, this)" 简化**: 真实决策链=Compile::call_generator(doCall.cpp:65): ①intrinsic(find_intrinsic)②MH 特例③ok_to_inline(bytecodeInfo.cpp:547)→try_to_inline→should_inline(:115)/should_not_inline+WarmCallInfo 热度→ParseGenerator(callGenerator.cpp:263-266)
> - **MaxInlineSize=35 对**(globals.hpp:1710);高频放宽 **FreqInlineSize=325**(x86_64,c2_globals_x86.hpp:47;bump 逻辑 bytecodeInfo.cpp:170-182);"too big"/"hot method too big"(:191-198);冷点中等已编译方法检查(:183-190)
> - **OSR 基本对**: StartOSRNode(callnode.hpp:91-98)+load_interpreter_state(parse1.cpp:570-574)+OSR 专用 tf(:521);实证 "%" 标记+回边 bci(OSRDemo)


场景: Parse 做高层语义(bytecode→什么 Node 类型)→GraphKit 做底层 graph wiring——`add_node(n)` 自动连 control edge + memory edge + i_o edge 到当前 state。每次 new Node→`gvn().transform(n)`→IGVN 优化。

**GraphKit** (`graphKit.hpp:100-300 + graphKit.cpp:100-400`):
```
GraphKit 核心功能:
  add_node(Node*) → add to current block → set_preferences(control/mem/io edges)
  gvn() → PhaseIterGVN& → transform() each new Node(immediate IGVN pass)

State 保持:
  control()    → 当前 control node(最近的分支/merge)
  memory(idx)  → 当前 memory state(MergeMem——每个 alias category 一个 memory slice)
  i_o()        → I/O state(最近的可观测操作→safepoint/System call)

SafePoint: add_safepoint() → OopMap recording 在 GC 时需要的寄存器/oops
[C++: graphKit.hpp——GraphKit 持有 Parse 的 JVMState——当前 bci/method/callee/locals/monitors——自动附加到 safe point]
```
- 源码: `graphKit.hpp:100-250` (GraphKit 类定义) + `graphKit.cpp:100-300` (add_node/safepoint/OopMap) + `graphKit.cpp:300-500` (memory slice management)

- 关键设计: **MergeMem = multi-slice memory state**——不同于 C1 的单一 memory state。MergeMem 为每个 Java 内存别名类别(Java heap/static fields/instance fields/array elements)保持独立 memory slice——load/store 操作匹配相应 slice→修改局部 slice→不影响其他类别。Alias Analysis(将两个内存访问归入同一 slice 或不同 slice)→决定是否可以 reorder load/store。**add_safepoint**——GC 需要知道 compiled code 中哪些寄存器/栈位置含有 oop→SafePointNode 记录当前 OopMap→GC 扫描时通过它找到 oops。

---

### 核心悬念
> ⚠️ 写作期修正(2026-08-15, vol-02/15-c2-compiler/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"add_node(n) 自动连 control/memory/io edges" 编造**: GraphKit 无 add_node;建节点=`_gvn.transform(new XxxNode(...))`+必要时 record_for_igvn;连边=构造显式传参(make_load 的 ctl/mem/adr,graphKit.cpp:1514-1534);map 三类槽由 Parse set_control/set_memory 更新
> - **"gvn() → PhaseIterGVN&" 错**: gvn() 返回 **PhaseGVN&**(graphKit.hpp:93)——Parse 期是单遍 GVN,IGVN 在 Parse 后
> - **"SafePointNode 记录当前 OopMap" 错位(重要)**: parse 期 safepoint 捕获 **JVMState**(locals/stack/monitors 作为节点,add_safepoint_edges);机器级 OopMap 在**寄存器分配后**由 BuildOopMaps 构建(buildOopMap.cpp:566,文件头注释 :39 "after all scheduling is done")
> - **补充机制**: ①GraphKit 核心=SafePointNode* _map(graphKit.hpp:64)+JVMState 槽位布局(loc/stk/arg/mon/scl,callnode.hpp:194-293);机器状态槽 Control/I_O/Memory/FramePtr/ReturnAdr(type.hpp:1519-1525);②MergeMem 多切片(memnode.hpp:1403+,memory_at/set_memory_at :1423-1430,AliasIdxBot base/AliasIdxTop 哨兵 :1432-1436);memory(alias_idx)(graphKit.cpp:1477-1482);③safepoint: maybe_add_safepoint 仅回边(parse.hpp:493-497);add_safepoint(parse1.cpp:2234)四件事: Call/SafePoint 后去重(:2246-2251)/MergeMemNode 克隆内存(:2273-2275)/轮询地址 thread-local 或全局页(:2286-2296)/add_safepoint_edges 挂 JVMState 链(:2299)+root prec 保活(:2305-2308);④异常: do_exceptions(parse1.cpp:905-932)双路=无 handler→throw_to_exit/有 handler→catch_inline_exceptions;内联异常 transfer_exceptions_into_jvms(callGenerator.cpp:110);⑤深度计数 inline_level()=caller_jvms->depth()(parse.hpp:96-97)


**"Parse(bytecode→Node, 逐条构建)→Inline(递归 do_call, depth 9, size 35)→GraphKit(add_node 自动 wiring control+memory+io state, gvn transform 即时优化)。C2 inline 将 callee graph 内联到 caller→海量 Node 网→等待 IGVN 优化。"** — 下一篇: IGVN + CCP + Escape Analysis——优化这个海量图。

> → [03-c2-optimizations.md](03-c2-optimizations.md)
