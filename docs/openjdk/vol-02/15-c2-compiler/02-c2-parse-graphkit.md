# 02. Parse + GraphKit — 字节码→Ideal Graph

> **前置依赖**:[15-c2-compiler/01 — C2 Ideal Graph: Node + Type + IGVN](openjdk/vol-02/15-c2-compiler/01-c2-ideal-graph.md):Node/Type/IGVN 三支柱铺底,本篇讲图的出生;[12-ci/02 — ciTypeFlow 与 escape 分析](openjdk/vol-02/12-ci/02-ci-typeflow-escape.md):Parse 之前的类型流分析,块的骨架从它来;[13-jit-framework/01 — CompileBroker 编译队列](openjdk/vol-02/13-jit-framework/01-compile-broker-queue.md):C2 编译任务怎么进来
> → **后续**:[15-c2-compiler/03 — IGVN + CCP + Escape Analysis: C2 优化三引擎](openjdk/vol-02/15-c2-compiler/03-c2-optimizations.md)
> 关联域: 12-ci(ciTypeFlow/ci 镜像)、13-jit-framework(编译入口)、18-safepoint(回边轮询)

## 字节码怎么变成节点海

01 篇看到的是结果: 一张由 Node 组成、每节点顶着类型的图,IGVN 在图上迭代。这篇讲过程——**字节码怎么一步步长成这张图**。C2 的"编译前端"由两个层次组成: **Parse**(字节码语义→建什么节点)和 **GraphKit**(图工具: 当前 JVM 状态、控制/内存边、safepoint、异常)。顺带纠正大纲四处: 不存在 `do_load`/`do_arith`/`do_inline`/`add_node` 这些函数;`gvn()` 返回的是单遍 `PhaseGVN&` 不是 `PhaseIterGVN&`;内联深度默认 **MaxInlineLevel=15** 不是 9;OopMap 不在 Parse 期记录——parse 期 safepoint 捕获的是 JVMState,机器级 OopMap 在寄存器分配之后才构建。

## 1. Parse — 块驱动的逐字节码建图

Parse 不是"从 bci 0 一条条读到 RETURN"。它是**块驱动**的: 先由 ciTypeFlow 做完类型流分析(12-02 域),`Parse` 构造函数里 `_flow = method()->get_flow_analysis()`(parse1.cpp:427,内部 `ciTypeFlow::do_flow`,ciMethod.cpp:352-359)拿到块结构;`init_blocks()`(parse1.cpp:1230-1246)把它变成 Parse 自己的 Block 数组(含前驱/后继);然后 `do_all_blocks()` 按**逆后序(RPO)** 一遍遍扫,凡是"状态已合并、还没解析"的块就 `do_one_block()`(parse1.cpp:632-733):

```cpp
// parse1.cpp:1489-1545(截取核心,逐字)
  // Parse bytecodes
  while (!stopped() && !failing()) {
    iter().next();

    // Learn the current bci from the iterator:
    set_parse_bci(iter().cur_bci());

    if (bci() == block()->limit()) {
      // Do not walk into the next block until directed by do_all_blocks.
      merge(bci());
      break;
    }
    assert(bci() < block()->limit(), "bci still in block");

    ...
    do_one_bytecode();

    ...
    do_exceptions();

    ...
    // Fall into next bytecode.  Each bytecode normally has 1 sequential
    // successor which is typically made ready by visiting this bytecode.
    // If the successor has several predecessors, then it is a merge
    // point, starts a new basic block, and is handled like other basic blocks.
  }
```

`do_one_bytecode()` 是一个巨大的 switch(parse2.cpp:1907 起)。大纲说的 `do_load`/`do_arith` 并不存在——**大多数算术/加载字节码直接在 switch 里内联建节点**。iload 系列只是把局部变量的 Value 压栈,连节点都不建:

```cpp
// parse2.cpp:2014-2033(截取核心,逐字)
  case Bytecodes::_fload_0:
  case Bytecodes::_iload_0:
    push( local(0) );
    break;
  case Bytecodes::_fload_1:
  case Bytecodes::_iload_1:
    push( local(1) );
    break;
  ...
  case Bytecodes::_fload:
  case Bytecodes::_iload:
    push( local(iter().get_index()) );
    break;
```

iadd 建 `AddINode` 并**当场交给单遍 GVN 化简**(01 篇已证 `x+0` 在这就被 Identity 掉):

```cpp
// parse2.cpp:2250-2253(截取核心,逐字)
  case Bytecodes::_iadd:
    b = pop(); a = pop();
    push( _gvn.transform( new AddINode(a,b) ) );
    break;
```

控制流字节码走 `do_if`/`do_ifnull`(parse2.cpp:1449/:1529): 建 `BoolNode` → `create_and_xform_if` 建 `IfNode` → 真/假两支 `IfTrueNode`/`IfFalseNode` 分别 `set_control` 后**沿分支继续解析**,到块尾 `merge(target_bci)` 汇合——Region 与 Phi 在 merge_common 里按需生成(01 篇 §2 的 meet 场景就是在这里发生)。调用字节码(五种 invoke)统一走 `do_call()`(doCall.cpp:423)——下一节。方法入口 `do_method_entry()`(parse1.cpp:1183-1226)做四件事: dtrace 探针、synchronized 方法的 `FastLockNode`(shared_lock,:1216)、参数 profiling 喂给类型系统、以及最外层方法(depth==1)的调用计数器递增(:1223-1225)。编译事件里能看到 Parse 的另一个侧面([实证](planning/outlines/00-jvm-tools/materials/commands/15-c2-parse-graphkit-demo.txt)第 2 段): 每个 `d*` 方法被 C1 独立编译到 level 3——同一份字节码,C1 编译成独立 nmethod,C2 则把它的图铺进 main 的编译(第 1 段的内联树),两种消费方式。

**块驱动 vs 线性读取的意义**: 一条路径解析到一半可能"死掉"(比如某个分支类型矛盾变 TOP),`stopped()` 为真就立刻停;而块结构保证**合并点只处理一次**——后到的路径把状态 merge 进已有 Region/Phi,而不是重复解析。这正是 C2 能在一条异常路径上随时 `uncommon_trap` 停工的物理基础(parse1.cpp:1511-1518: 类型流预判的 trap 点直接进 `uncommon_trap` 不再解析)。

*关键设计: 建图与解析交错进行,而不是"先建块再填指令"。每个字节码处理完,当前"图状态"(控制点、内存状态、表达式栈、局部变量)就推进一格;merge 点用 Phi 冻结分歧。这让异常处理(uncommon_trap)能随时切断路径,也让 Parse 的产物天然是"图"而不是"块列表"。*

## 2. 内联递归 — 字节码建图的一键展开

`invokevirtual` 到 `do_call()`,真正决定"建 CallNode 还是把 callee 的图展开进来"的是 `Compile::call_generator`(doCall.cpp:65)。do_call 的骨架(doCall.cpp:548-555):

```cpp
// doCall.cpp:548-555(截取核心,逐字)
  dec_sp(nargs);              // Temporarily pop args for JVM state of call
  JVMState* jvms = sync_jvms();

  // ---------------------
  // Decide call tactic.
  // This call checks with CHA, the interpreter profile, intrinsics table, etc.
  // It decides whether inlining is desirable or not.
  CallGenerator* cg = C->call_generator(callee, vtable_index, call_does_dispatch, jvms, try_inline, prof_factor(), speculative_receiver_type);
```

`call_generator` 的决策链: ①intrinsic 表(find_intrinsic,如 Math/数组拷贝);②MethodHandle 特例;③`InlineTree::ok_to_inline`(bytecodeInfo.cpp:547)→ `try_to_inline` → 正过滤 `should_inline`(bytecodeInfo.cpp:115)+ 负过滤 `should_not_inline`,最后用 `WarmCallInfo`(调用点 profile 的热度模型)定"热/冷"。真正的内联决策是**门槛过滤 + 热度判定**的合成:

- **大小门槛**: 默认 `MaxInlineSize=35`(globals.hpp:1710);调用点高频(频率/计数超阈值或装箱/EA 构造)时放宽到 `FreqInlineSize`(x86_64 默认 **325**,c2_globals_x86.hpp:47;bytecodeInfo.cpp:170-182 的 bump 逻辑),超了报 `"too big"`/`"hot method too big"`(bytecodeInfo.cpp:191-198)。
- **深度门槛**: `inline_level() > MaxInlineLevel(默认 15,globals.hpp:1692)` 报 `"inlining too deep"`(bytecodeInfo.cpp:400-407);递归另有限制 `MaxRecursiveInlineLevel=1`(:436-439)。
- 冷点还有"已编译成中等大小方法则不内联"检查(bytecodeInfo.cpp:183-190,`InlineSmallCode/4` 阈值)。

决策通过后,`CallGenerator::for_inline`(callGenerator.cpp:263-266)返回 `ParseGenerator`,它的 `generate` 就是**递归建图**——大纲说的 `Parse::do_inline` 不存在,递归发生在 ParseGenerator 里:

```cpp
// callGenerator.cpp:84-111(截取核心,逐字)
JVMState* ParseGenerator::generate(JVMState* jvms) {
  Compile* C = Compile::current();
  C->print_inlining_update(this);

  if (is_osr()) {
    // The JVMS for a OSR has a single argument (see its TypeFunc).
    assert(jvms->depth() == 1, "no inline OSR");
  }

  if (C->failing()) {
    return NULL;  // bailing out of the compile; do not try to parse
  }

  Parse parser(jvms, method(), _expected_uses);
  // Grab signature for matching/allocation
  GraphKit& exits = parser.exits();

  ...
  // Simply return the exit state of the parser,
  // augmented by any exceptional states.
  return exits.transfer_exceptions_into_jvms();
}
```

`new Parse(...)` 从 caller 的 JVMState 出发,把 callee 的字节码全部展开成图——callee 的返回被接回调用点的表达式栈,异常状态也一并转交(`transfer_exceptions_into_jvms`)。callee 内部遇到调用,又递归走同一条链。**每进一层,jvms 的 depth 加一**——`Parse::_depth = 1 + caller->depth()`(parse1.cpp:397),`InlineTree` 的深度检查 `inline_level() = caller_jvms->depth()`(parse.hpp:96-97)读的正是同一个计数。

OSR 是另一种"从中间开始建图": 解释器在循环回边把控制权交给编译代码,`StartOSRNode`(callnode.hpp:91-98)的域里只放一个"OSR buffer"参数;parse1.cpp:570-574 把它交给 `load_interpreter_state`(:186+)——用 `fetch_interpreter_state` 逐槽恢复局部变量与监视器(BoxLockNode + 伪 FastLockNode,:221-250;buffer 的填充侧是解释器,`SharedRuntime::OSR_migration_begin` sharedRuntime.cpp:3036,注释明说依赖"interpreter local array and the monitors"的布局)。所以 OSR 编译从 `entry_bci` 起建图,`_tf = C->tf()` 换成 OSR 专用类型(parse1.cpp:521)。[实证](planning/outlines/00-jvm-tools/materials/commands/15-c2-parse-graphkit-demo.txt)第 5 段: 长循环方法被 OSR 编译两次(`1 % 3 OSRDemo::loop @ 5`——`%` 标记 + 回边 bci 5),替换后旧 OSR nmethod `made not entrant`。

**PrintInlining 把整条决策链摆上台面**([实证](planning/outlines/00-jvm-tools/materials/commands/15-c2-parse-graphkit-demo.txt)第 1 段): 低层级编译(C1)里 7 字节的 `d6` 也报 `"callee is too large"`——因为 C1 的嵌套有 `NestedInliningSizeRatio=90%` 逐层衰减(c1_globals.hpp:177,每层 max_inline_size 乘 0.9,c1_GraphBuilder.cpp:700-705);C2 的高频树里 139 字节的 `big` 反而 `inline (hot)`——高频调用点放宽到 FreqInlineSize=325;而 16 层缩进都成功内联之后,第 17 层的 `d3` 报 `"inlining too deep"`——深度从调用者 JVMState 计(`inline_level() = caller_jvms->depth()`,parse.hpp:96-97),`inline_level() > MaxInlineLevel=15` 首次成立。同一份源码、两代编译器,决策参数完全不同。

*关键设计: 内联不是"优化阶段"而是"建图方式"——callee 的字节码在 caller 的图上原地展开,调用边界消失,后续 IGVN/CCP 才能对跨方法的值做全局优化。C2 敢于高频放宽到 325 字节,因为图优化(而非代码体积)是编译期的真正成本,而深度限制 15 层防止"图爆炸"。*

## 3. GraphKit — 当前 JVM 状态与三类边

Parse 的每个动作都落在 GraphKit 上。`GraphKit` 的核心是一个 **`SafePointNode* _map`**(graphKit.hpp:64)——“JVM 状态到节点的映射”: 图里有个固定槽位布局,前几槽是机器状态(Control/I_O/Memory/FramePtr/ReturnAdr,type.hpp:1519-1525),往后依次是**局部变量区、表达式栈、监视器对、标量替换对象区**——布局在 `JVMState` 里用偏移量描述(callnode.hpp:231-232):

```cpp
// callnode.hpp:230-238(截取核心,逐字)
  // Access functions for the JVM
  // ... --|--- loc ---|--- stk ---|--- arg ---|--- mon ---|--- scl ---|
  //       \ locoff    \ stkoff    \ argoff    \ monoff    \ scloff    \ endoff
  uint              locoff() const { return _locoff; }
  uint              stkoff() const { return _stkoff; }
  uint              argoff() const { return _stkoff + _sp; }
  uint              monoff() const { return _monoff; }
  uint              scloff() const { return _scloff; }
  uint              endoff() const { return _endoff; }
```

`control()`/`i_o()` 直接读 map 对应槽(graphKit.hpp:471-472),`memory(alias_idx)` 从当前 **MergeMemNode** 取对应切片(graphKit.cpp:1477-1482):

```cpp
// graphKit.cpp:1477-1482(截取核心,逐字)
Node* GraphKit::memory(uint alias_idx) {
  MergeMemNode* mem = merged_memory();
  Node* p = mem->memory_at(alias_idx);
  _gvn.set_type(p, Type::MEMORY);  // must be mapped
  return p;
}
```

**MergeMemNode = 多切片内存状态**(memnode.hpp:1403+): 每个别名类别(Java 堆/静态字段/实例字段/数组元素…)一个切片槽(`memory_at`/`set_memory_at`,memnode.hpp:1423-1430),第 `AliasIdxBot` 槽是"base memory"、`AliasIdxTop` 槽是空哨兵(memnode.hpp:1432-1436)。读字段 = 从对应切片取内存输入;写字段 = 只更新对应切片再 `set_memory(st, alias_idx)`(graphKit.cpp:1571)。**切片的存在让"不同内存类别互不干扰"成为图的结构事实**——数组元素写不影响对象头读,IGVN/别名分析据此重排内存操作。大纲说"add_node 自动连 control/memory/io edges"是编造的——GraphKit 没有 add_node;**建节点就是 `_gvn.transform(new XxxNode(...))` + 必要时 `record_for_igvn`**,连边是节点构造时显式传参(如 make_load 的 `ctl, mem, adr`,graphKit.cpp:1514-1534),map 的三类槽由 Parse 自己 `set_control`/`set_memory` 更新。

safepoint 的机制也不是"OopMap recording in parse": Parse 只在需要时插 safepoint——`maybe_add_safepoint` 仅当 `UseLoopSafepoints && target_bci <= bci()`(回边)才插(parse.hpp:493-497),`add_safepoint`(parse1.cpp:2234)做了四件事:

```cpp
// parse1.cpp:2246-2301(截取核心,逐字)
    if( n0->is_Call() ) {
      if( n0->as_Call()->guaranteed_safepoint() )
        return;
    } else if( n0->is_SafePoint() && n0->req() >= parms ) {
      return;
    }
  }

  // Clear out dead values from the debug info.
  kill_dead_locals();

  // Clone the JVM State
  SafePointNode *sfpnt = new SafePointNode(parms, NULL);

  ...
  // Clone the current memory state
  Node* mem = MergeMemNode::make(map()->memory());

  mem = _gvn.transform(mem);

  // Pass control through the safepoint
  sfpnt->init_req(TypeFunc::Control  , control());
  // Fix edges normally used by a call
  sfpnt->init_req(TypeFunc::I_O      , top() );
  sfpnt->init_req(TypeFunc::Memory   , mem   );
  sfpnt->init_req(TypeFunc::ReturnAdr, top() );
  sfpnt->init_req(TypeFunc::FramePtr , top() );

  // Create a node for the polling address
  if( add_poll_param ) {
    Node *polladr;
    if (SafepointMechanism::uses_thread_local_poll()) {
      Node *thread = _gvn.transform(new ThreadLocalNode());
      Node *polling_page_load_addr = _gvn.transform(basic_plus_adr(top(), thread, in_bytes(Thread::polling_page_offset())));
      polladr = make_load(control(), polling_page_load_addr, TypeRawPtr::BOTTOM, T_ADDRESS, Compile::AliasIdxRaw, MemNode::unordered);
    } else {
      polladr = ConPNode::make((address)os::get_polling_page());
    }
    sfpnt->init_req(TypeFunc::Parms+0, _gvn.transform(polladr));
  }

  // Fix up the JVM State edges
  add_safepoint_edges(sfpnt);
  Node *transformed_sfpnt = _gvn.transform(sfpnt);
  set_control(transformed_sfpnt);
```

四件事: **①去重**——紧跟在 Call 或 SafePoint 之后就不插(它们本身是 safepoint,:2246-2251);②**克隆内存状态**成一个新的 MergeMemNode(:2273-2275),防止屏障/store 浮过 safepoint(注释 :2260-2270);③**连接口与轮询地址**——thread-local poll 时从线程对象读 `polling_page_offset`(18-02 域的轮询页在这里接线),全局模式用 `ConPNode::make(os::get_polling_page())`(:2286-2296);④**add_safepoint_edges 把整条 JVMState 链(各级调用者的 locals/stack/monitors)挂上**——这才是"GC 需要知道 oops"在 parse 期的全部内容: 它们是**节点**,不是机器寄存器。另外还从 root 加一条 precedence 边保活这个 safepoint,直到解析结束(:2305-2308)。机器级 OopMap(寄存器/栈槽 → oop 标记)要等寄存器分配完成后,由 `Compile::BuildOopMaps`(buildOopMap.cpp:566,文件头注释 "builds OopMaps after all scheduling is done" :39)做前向到达定义分析生成。

异常路径与 safepoint 并列构成图的"副作用骨架": 每个字节码后 `do_exceptions()`(parse1.cpp:905-932)检查有没有积累的异常状态——**无异常处理器**的方法直接 `throw_to_exit` 把异常状态转给调用者(向上传递);**有处理器**的走 `catch_inline_exceptions`(doCall.cpp:836)在图中接入 handler 块。内联方法的异常也经 `transfer_exceptions_into_jvms` 并入调用者(callGenerator.cpp:110)。

*关键设计: Parse 期的"JVM 状态"是图的一部分而非旁路数据——locals/stack/monitors 就是 SafePointNode 的输入边,所以 deopt 时解释器状态可以精确重建;而机器级 OopMap 推迟到寄存器分配后,因为只有那时才知道 oop 住哪个寄存器。safepoint 的"插不插"由回边与调用点决定(调用点天然是 safepoint,回边按需补插),配合 18-02 域的轮询机制,让编译代码的 GC 停顿与解释器语义一致。*

## 核心悬念

图的出生过程至此完整: **Parse** 用 ciTypeFlow 的块骨架做 RPO 驱动,逐字节码建节点(iload 零成本压栈、iadd 当场 GVN);**内联**是建图的一键展开——call_generator 用大小(35/325)与深度(15)门槛决策,ParseGenerator 递归 new Parse 把 callee 铺进 caller 的图,OSR 则从解释器帧的中间状态起建;**GraphKit** 用 SafePointNode/JVMState 的槽位布局管理控制/内存/表达式栈三类状态,MergeMem 切片隔离内存类别,safepoint 捕获 JVMState、OopMap 留到寄存器分配后。Parse 结束,一张"海量 Node 网"等着被优化——**IGVN 的第一轮全图迭代只是开胃菜,CCP 的常量传播与 Escape Analysis 的标量替换才是重头戏**。下一篇: 优化三引擎。

> → [15-c2-compiler/03 — IGVN + CCP + Escape Analysis: C2 优化三引擎](openjdk/vol-02/15-c2-compiler/03-c2-optimizations.md)
