# 02. 从编译帧回到解释器——unpack 帧重建

> **前置依赖**:[22-deoptimization/01 — 编译代码什么时候回退？— Deopt 决策表](openjdk/vol-02/22-deoptimization/01-deopt-decision.md):决策做完,本篇拆执行;[16-code-cache/05 — Dependencies 与 Deopt — JIT 的乐观假设与自救](openjdk/vol-02/16-code-cache/05-dependencies-deopt.md):ScopeDesc 与内联树;[24-frame/03 — Deopt 与 GC 扫描](openjdk/vol-02/24-frame/03-deopt-gc-scan.md):编译帧的寄存器图与 oop 扫描
> → **后续**:[26-g1-gc/01 — 堆被切成 2048 块 — HeapRegion + G1CollectedHeap](openjdk/vol-02/26-g1-gc/01-heapregion.md):22 域收官,第 7 批进入 G1
> 关联域: 21-shared-runtime(DeoptimizationBlob)、08-interpreter(解释器帧布局)、24-frame(virtual frame)

## deopt 之后,栈上发生了什么

[22-01 的实证](planning/outlines/00-jvm-tools/materials/commands/22-deopt-type-demo.txt)展示了决策侧: 类型切换 → 旧 nmethod made not entrant → 双路重编译。执行侧的**计时对照**(33 域以来的惯例,本次直接测):

```
compiled 10M: 0ms      # 热调用 Square: C2 内联后 1000 万次接口调用 ≈ 0ms
after-switch 10M: 8ms  # 换成 Circle: deopt 后先回解释器(慢),重编译完成后恢复
recompiled 10M: 0ms    # 双路内联恢复
```

中间那个 8ms 就是"栈顶还停在旧编译帧里"的窗口——**必须先把编译帧换成解释器帧链,才能继续执行**。这篇拆 unpack 的工程: 怎么把 1 个编译帧(内含 3 层内联)变成 3 个解释器帧,并且从正确的字节码位置继续。

## 1. 两阶段: 打包(pack)与拆包(unpack)

deopt 的执行是"编译帧 → 中间表示 → 解释器帧"的两段式:

1. **打包(fetch_unroll_info)**: 编译代码跳进 deopt stub,`fetch_unroll_info`(deoptimization.cpp:139,JRT_BLOCK_ENTRY)→ `fetch_unroll_info_helper`(:158): 沿 ScopeDesc 收集所有内联层的局部变量/表达式/监视器(compiledVFrame 列表),建 **vframeArray**(虚拟帧数组)与 **UnrollBlock**(帧尺寸预算);
2. **拆包(unpack_frames)**: `unpack_frames`(:623,JRT_LEAF): 取线程的 vframeArray → `array->unpack_to_stack(stub_frame, exec_mode, ...)`(vframeArray.cpp:567)把虚拟帧逐个铺成真实解释器帧 → 返回 return_type 给 deopt blob,控制权交给解释器。

两段之间,DeoptimizationBlob 的汇编(21-01)根据 UnrollBlock 的尺寸**在栈上先分配一片空白骨架帧**(可走查但不完整),unpack 阶段往里面填内容——这就是 22-01 悬念的"从断点继续"的物理基础。

## 2. vframeArray: 编译帧的快照

`class vframeArray`(vframeArray.hpp:121)是编译帧在 C-heap 的完整快照,类内注释(:127-140)画了布局——固定部分(原帧描述、`_frames` 数、**callee 寄存器保存区**)+ 变长部分(每内联层一个 `vframeArrayElement`)。`vframeArrayElement`(:50)每层含: iframe(指向栈上骨架帧)、locals/expressions 数组、monitors 数组。

创建在 `create_vframeArray`(deoptimization.cpp:1169): 沿 compiledVFrame 链逐个 `fill_in`(vframeArray.cpp:60)——**ScopeValue 在这里从"编译时的寄存器/栈槽描述"变成"数值"**: LocationValue(寄存器/栈偏移/常量)、ConstantOopWriteValue(嵌入常量 oop)、ObjectValue(C2 标量替换拆开的对象——需要**递归展开子字段重建完整对象**,大纲这点对)。打包的中间还有 `NoSafepointVerifier`(:308)——**指针进了 vframeArray 后不能再有 safepoint**,否则 GC 扫不到这中间的 Java 状态。

## 3. UnrollBlock: 帧尺寸的预算

`fetch_unroll_info_helper` 的第二个产出是每帧的尺寸(:381-460): `frame_sizes[i] = BytesPerWord * element(i)->on_stack_size(callee_parameters, callee_locals, ...)`——注意注释强调的**索引方向**: frame_sizes[0] 是**最老**(最外层)的帧,与 vframeArray 的元素方向相反(:439-440,汇编端按这个顺序在栈上铺骨架)。每帧的 pc 先用 `Interpreter::deopt_entry(vtos, 0) - frame::pc_return_offset` 占位(骨架可走查即可,正确的 pc 在 unpack 时才填,:447-449)。`UnrollBlock`(deoptimization.hpp:178)把这些尺寸+caller 调整打包,deopt blob 按它分配栈空间。

## 4. unpack_to_stack: 逐帧填充

`unpack_to_stack`(vframeArray.cpp:567-630)两步: 先把每个 element 的 iframe 指向栈上的骨架帧(从 `unpack_frame.sender()` 开始逐层 sender,:580-586);然后**从最老到最年轻**(frames()-1 → 0)逐层 `unpack_on_stack`(:591-619)——注意方向: 栈向低地址增长,最内层(年轻)帧在高地址,**先铺最老帧还是先铺最内帧?** 实际是反过来的: 骨架已由汇编按 UnrollBlock 铺好,unpack 只是填充,方向不影响布局;但 `callee_parameters/callee_locals` 的传递必须从外到内(每层知道自己调用点参数个数,:593-604)。

`unpack_on_stack`(:171)是单帧填充,核心四件事:

**①确定 bcp/pc——解释器从哪继续**(:183-201):

```cpp
// vframeArray.cpp:178-201(截取核心,逐字)
  if (raw_bci() == SynchronizationEntryBCI) {
    // We are deoptimizing while hanging in prologue code for synchronized method
    bcp = method()->bcp_from(0); // first byte code
    pc  = Interpreter::deopt_entry(vtos, 0); // step = 0 since we don't skip current bytecode
  } else if (should_reexecute()) { //reexecute this bytecode
    assert(is_top_frame, "reexecute allowed only for the top frame");
    bcp = method()->bcp_from(bci());
    pc  = Interpreter::deopt_reexecute_entry(method(), bcp);
  } else {
    bcp = method()->bcp_from(bci());
    pc  = Interpreter::deopt_continue_after_entry(method(), bcp, callee_parameters, is_top_frame);
    use_next_mdp = true;
  }
```

三种入口(abstractInterpreter.hpp:178-194): `deopt_entry`(从该 bci **重新执行**,uncommon trap 重做语义)/`deopt_reexecute_entry`(明确重执行该字节码)/`deopt_continue_after_entry`(从**下一条**继续)——**"精确恢复"**: 已执行的字节码绝不重跑。exec_mode 还会覆盖 pc(:262-283): `Unpack_exception` → `SharedRuntime::raw_exception_handler_for_return_address`(21-03 的返回点寻路,异常改道到 handler);`Unpack_uncommon_trap/reexecute` → deopt_entry 重做。

**②布局帧**(:292-300): `Interpreter::layout_activation(method, temps+callee_parameters, ..., locks, caller_actual_parameters, callee_parameters, callee_locals, caller, iframe(), ...)`(abstractInterpreter_x86.cpp:57)——**解释器帧怎么排由解释器侧决定**(locals 区/表达式栈/监视器区的偏移),unpack 只提供参数。

**③复制监视器**(:312-319): 每个 `BasicObjectLock` 从源 `move_to` 新帧——deopt 前持有的锁必须在新解释器帧里重建(锁对象+displaced header)。

**④设 bcp/mdp**(:322-330): 帧的字节码指针指向继续点,mdp(方法数据指针,ProfileInterpreter 时)指向对应 bci 的 slot——**解释器恢复执行时,profiling 也在断点处接续**。

最老帧收尾还有 `unwind_callee_save_values`(:615,把 callee-saved 寄存器恢复到 vframeArray 保存区)。

## 5. 控制权交接与验证

unpack_frames 尾部(:655-700): 取 `info->return_type()`(最内层调用点返回值类型,供 deopt blob 恢复 rax/浮点寄存器;`Unpack_exception` 时强制 T_OBJECT 防 exception_oop 被覆盖 :660-663)→ `cleanup_deopt_info` 清线程 deopt 数据 → 返回。汇编端按 return_type 恢复寄存器后,跳到解释器入口——第一个解释器帧从 `continue_after` 的 bcp 开始 dispatch。`VerifyStack`(develop)下还会逐帧对照 InterpreterOopMap(:667-700)验证 locals/表达式栈形态——*发布构建没有这层校验,正确性全靠 layout_activation 与 ScopeDesc 的一致性*。

## 核心悬念

22 域收官。unpack 帧重建拆完: 两段式(pack=fetch_unroll_info 建 vframeArray+UnrollBlock / unpack=unpack_frames→unpack_to_stack 逐帧填充);vframeArray 是 C-heap 快照(ScopeValue 三种子类型,ObjectValue 递归展开标量替换对象);UnrollBlock 给汇编端铺骨架帧的尺寸预算;unpack_on_stack 四件事(bcp/pc 精确恢复→layout_activation→复制监视器→设 bcp/mdp);exec_mode 决定异常/重做/继续三种续点。至此"乐观优化→假设破→决策→回退→精确继续"的闭环完整。第 7 批下一个域离开运行时机制,回到**内存**: G1 的堆怎么被切成 region、并发标记怎么跑、RSet 怎么记账。下一篇: HeapRegion 与 G1CollectedHeap。

> → [26-g1-gc/01 — 堆被切成 2048 块 — HeapRegion + G1CollectedHeap](openjdk/vol-02/26-g1-gc/01-heapregion.md)
