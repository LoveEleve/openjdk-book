# 02. 一条字节码怎么变成 x86 机器码？— Template Interpreter

> **前置依赖**:[08-interpreter/01 — Bytecode 定义表](01-bytecodes-definition.md):239 条字节码的定义表(格式/长度/栈效果)是生成器的输入;[24-frame/03 — Deopt 重建 + GC 扫描](openjdk/vol-02/24-frame/03-deopt-gc-scan.md):deopt 重建的解释器帧跳回 `deopt_reexecute_entry`/`continue_after_entry`——本篇拆这两个入口是谁生成的;[17-threads/02 — JavaThread 状态机](openjdk/vol-02/17-threads/02-javathread-state.md):本篇 dispatch 里的轮询点是 safepoint 机制的解释器侧
> → **后续**:[08-interpreter/03 — 解释器调 C++](03-interpreter-runtime.md):本篇的 `calls_vm` 指令(ldc/invoke/new)执行到要调 C++ 的入口——下一篇拆 InterpreterRuntime
> 关联域: 16-code-cache(解释器 codelet 是 CodeCache 里的 blob)、23-stub(桩的生成方式同款 CodeletMark)、24-frame(解释器帧布局)

## 执行一条字节码,代价只有两次跳转

01 篇拆完定义表: VM 知道每条字节码叫什么、多长、栈怎么变。但"执行"从哪来?JVM 启动时给 239 条字节码各生成一段 x86 机器码,存进 CodeCache——执行一条字节码 = **跳进预生成的机器码段,跑完再跳去下一条的机器码段**。没有任何 switch 循环。这一篇拆生成器: 机器码怎么生成、怎么组织、跳转怎么做到单条间接跳转,以及"栈顶值留在寄存器里"这个贯穿全部模板的核心约定。

[实证:] Temurin OpenJDK 11.0.32 的 `-XX:+PrintInterpreter`(materials/commands/08-interpreter-templates.txt): 解释器代码共 **271 个 codelet,平均 404 字节**;`iload` 192B、`iload_0` 96B、`iconst_0`~`iconst_5` 全是 96B、`iadd` 64B、`invokevirtual` 1280B——同一生成器产出的模板大小相同,不同生成器差别悬殊。这些数字是下面每个机制的直接证据。

## 1. 生成总入口: generate_all 的十一段

### 启动时一次性生成,没有运行时编译

解释器代码在 JVM 启动早期生成: `TemplateInterpreter::initialize()`(templateInterpreter.cpp:42-71)先初始化字节码表与模板表,然后 `new StubQueue(..., "Interpreter")`(:57)开出代码仓库,`TemplateInterpreterGenerator g(_code)`(:59)的构造函数一路执行 `generate_all()`——构造函数就是生成器(templateInterpreterGenerator.cpp:38-42)。生成完毕 `deallocate_unused_tail()` 把没用到的空间还给 CodeCache(:61)。`_active_table = _normal_table`(:70)挂上默认 dispatch 表。

`generate_all()`(templateInterpreterGenerator.cpp:57-263)不是大纲说的"三步",而是十一段,顺序如下:

| 段 | 生成内容 | 行号 |
|---|---|---|
| 1 | 慢签名处理器 + 两个错误出口(unimplemented/illegal sequence) | :58-65 |
| 2 | **return 入口**(按字节码长度分 5 档,索引 0 空置) | :86-105 |
| 3 | **invoke return 入口**(按栈顶状态分 10 档) | :107-122 |
| 4 | earlyret 入口(JVMTI 提前返回) | :124-138 |
| 5 | native 调用结果处理器(按返回类型) | :140-151 |
| 6 | **safepoint 入口**(每个都调 `InterpreterRuntime::at_safepoint`) | :154-168 |
| 7 | 异常处理代码 + 六个 throw 异常入口 | :170-182 |
| 8 | **方法入口**(28 种 MethodKind) | :186-230 |
| 9 | **字节码模板**(遍历 0-255) | :233 |
| 10 | 每字节码的 safepoint 表条目 | :237 |
| 11 | **deopt 入口**(按字节码长度分 7 档) | :239-261 |

**关键设计 (斜体)**: *return 入口按"长度"分档、invoke return 按"栈顶状态"分档、deopt 入口按"长度"分档——同一段代码被多个字节码共享,代价是按执行时的实际参数查表选入口。生成顺序本身是依赖序: 错误出口先于一切(set_entry_points 里默认值指向它们),normal 表先于 safepoint 表(deopt 入口复用 `_normal_table.entry(_return).entry(vtos)`,:258-260)。*

### 遍历 256: 定义过的进模板表,没定义的进错误出口

第 9 段是字节码模板的入口(set_entry_points_for_all_bytes,templateInterpreterGenerator.cpp:276-285,截取核心,逐字):

```cpp
// templateInterpreterGenerator.cpp:276-285(截取核心,逐字)
void TemplateInterpreterGenerator::set_entry_points_for_all_bytes() {
  for (int i = 0; i < DispatchTable::length; i++) {
    Bytecodes::Code code = (Bytecodes::Code)i;
    if (Bytecodes::is_defined(code)) {
      set_entry_points(code);
    } else {
      set_unimplemented(i);
    }
  }
}
```

`Bytecodes::is_defined`(01 篇的 `_flags` 表)决定走向: 有模板的(0x00-0xEE,239 条)生成代码,未定义的(0xEF-0xFF,17 个)整个入口家族指向 `_unimplemented_bytecode`——执行到就 `__ stop("unimplemented bytecode")`(set_unimplemented,templateInterpreterGenerator.cpp:296-301)。**方法体里出现未定义字节码 = 直接崩溃,而不是悄悄跳过**——注意 0xCB-0xEE 并非保留区: 36 条私有 fast 系列从 0xCB(203)起(01 篇的枚举表),真正无定义的只有 0xEF-0xFF。

## 2. 模板是什么: 一条记录 + 一个生成函数

### Template 结构与双表

每条字节码的"模板"是 `Template` 对象: 四个位标志(uses_bcp/does_dispatch/calls_vm/wide,templateTable.hpp:46-52)+ `tos_in`/`tos_out` 两个栈顶状态 + 生成函数指针 `_gen` + 参数 `_arg`。模板存在两张表里(templateTable.cpp:172-173,截取核心,逐字):

```cpp
// templateTable.cpp:172-173(截取核心,逐字)
Template                   TemplateTable::_template_table     [Bytecodes::number_of_codes];
Template                   TemplateTable::_template_table_wide[Bytecodes::number_of_codes];
```

不是大纲说的 `_itable[256]`——是 `_template_table`/`_template_table_wide` 双表,各 239 个槽(按 01 篇的枚举值索引)。def 用 `wide` 位决定进哪张表(templateTable.cpp:186-203,截取核心,逐字):

```cpp
// templateTable.cpp:186-203(截取核心,逐字)
void TemplateTable::def(Bytecodes::Code code, int flags, TosState in, TosState out, void (*gen)(int arg), int arg) {
  // should factor out these constants
  const int ubcp = 1 << Template::uses_bcp_bit;
  const int disp = 1 << Template::does_dispatch_bit;
  const int clvm = 1 << Template::calls_vm_bit;
  const int iswd = 1 << Template::wide_bit;
  // determine which table to use
  bool is_wide = (flags & iswd) != 0;
  // make sure that wide instructions have a vtos entry point
  // (since they are executed extremely rarely, it doesn't pay out to have an
  // extra set of 5 dispatch tables for the wide instructions - for simplicity
  // they all go with one table)
  assert(in == vtos || !is_wide, "wide instructions have vtos entry point only");
  Template* t = is_wide ? template_for_wide(code) : template_for(code);
  // setup entry
  t->initialize(flags, in, out, gen, arg);
  assert(t->bytecode() == code, "just checkin'");
}
```

**关键设计 (斜体)**: *wide 指令没有独立 dispatch 表——注释解释了理由: "executed extremely rarely, it doesn't pay out to have an extra set of 5 dispatch tables"。窄格式与 wide 格式共享同一套 10×256 dispatch 表,wide 入口单列 `_wentry_point[256]`(templateInterpreter.hpp:134)。*

### 同一生成函数,多个模板: 参数化共享

模板表最显眼的特征是**生成函数被大量复用**,差异靠 `_arg` 参数传入(templateTable.cpp:261-266 与 :287-290,截取核心,逐字):

```cpp
// templateTable.cpp:259-266(截取核心,逐字)
  //                                    interpr. templates
  // Java spec bytecodes                ubcp|disp|clvm|iswd  in    out   generator             argument
  def(Bytecodes::_nop                 , ____|____|____|____, vtos, vtos, nop                 ,  _           );
  def(Bytecodes::_aconst_null         , ____|____|____|____, vtos, atos, aconst_null         ,  _           );
  def(Bytecodes::_iconst_m1           , ____|____|____|____, vtos, itos, iconst              , -1           );
  def(Bytecodes::_iconst_0            , ____|____|____|____, vtos, itos, iconst              ,  0           );
  def(Bytecodes::_iconst_1            , ____|____|____|____, vtos, itos, iconst              ,  1           );
  def(Bytecodes::_iconst_2            , ____|____|____|____, vtos, itos, iconst              ,  2           );
```

`iconst_m1` 到 `iconst_5` 七个模板共用一个 `iconst` 生成函数,arg 是压入的常量;`iop2`/`fop2`/`dop2` 的 arg 是 Operation(add/sub/mul/div/rem/…),`if_0cmp` 的 arg 是 Condition(equal/less/…),`float_cmp` 的 arg 是 ±1,`fast_accessfield` 的 arg 是目标 TosState(templateTable.cpp:357,414-419,410-413,480-487)。`Template::generate` 就是把这个 arg 传给生成函数(templateTable.cpp:58-65,截取核心,逐字):

```cpp
// templateTable.cpp:58-65(截取核心,逐字)
void Template::generate(InterpreterMacroAssembler* masm) {
  // parameter passing
  TemplateTable::_desc = this;
  TemplateTable::_masm = masm;
  // code generation
  _gen(_arg);
  masm->flush();
}
```

[实证:] 七个 `iconst_*` codelet 全是 96 字节、`iadd` 64 字节、`fast_igetfield` 64 字节(08-interpreter-templates.txt)——同一生成函数产出的机器码布局相同,只有嵌入的常量不同。大纲"iload 和 fload 都用 itos→模板相同"是错的: 共享不是按 tosState,是按**生成函数**。

### transition 不是生成代码,是断言

模板生成函数第一行几乎都是 `transition(tos_in, tos_out)`——它不生成任何机器码,只是编译期检查 def 表登记的状态与生成函数内部的假设一致(templateTable.cpp:162-165,截取核心,逐字):

```cpp
// templateTable.cpp:162-165(截取核心,逐字)
void TemplateTable::transition(TosState tos_in, TosState tos_out) {
  assert(_desc->tos_in()  == tos_in , "inconsistent tos_in  information");
  assert(_desc->tos_out() == tos_out, "inconsistent tos_out information");
}
```

栈顶状态的真正处理在生成流程里(set_short_entry_points/set_vtos_entry_points,下一节)——**transition 只保证"登记状态"和"生成代码假设"一致**。

## 3. tosca: 栈顶值留在寄存器里

### 10 种栈顶状态

TosState 枚举定义在全局(globalDefinitions.hpp:819-832,截取核心,逐字):

```cpp
// globalDefinitions.hpp:819-832(截取核心,逐字)
enum TosState {         // describes the tos cache contents
  btos = 0,             // byte, bool tos cached
  ztos = 1,             // byte, bool tos cached
  ctos = 2,             // char tos cached
  stos = 3,             // short tos cached
  itos = 4,             // int tos cached
  ltos = 5,             // long tos cached
  ftos = 6,             // float tos cached
  dtos = 7,             // double tos cached
  atos = 8,             // object cached
  vtos = 9,             // tos not cached
  number_of_states,
  ilgl                  // illegal state: should not occur
};
```

每个状态对应"栈顶值的缓存位置"约定: itos→rax、ltos→rax:rdx、ftos/dtos→xmm0、atos→rax、vtos→没缓存(值在栈上)。**解释器执行任何指令,栈顶值都尽量留在这些寄存器里,不压栈**——"tosca" = Top-Of-Stack CAche(templateInterpreter.hpp:40 注释)。压栈只在栈顶确实需要进内存时发生(比如 `istore` 要把栈顶写进局部变量——注意 istore 的 tos_in 是 itos,直接从 rax 写)。

### 入口点家族: 同一模板,5 个入口

每条字节码在 dispatch 表里不是一个地址,是一个**入口点家族**(EntryPoint = 10 个状态地址,templateInterpreter.hpp:43-59)。模板生成时按 tos_in 分派(templateInterpreterGenerator.cpp:345-362,截取核心,逐字):

```cpp
// templateInterpreterGenerator.cpp:345-362(截取核心,逐字)
void TemplateInterpreterGenerator::set_short_entry_points(Template* t, address& bep, address& cep, address& sep, address& aep, address& iep, address& lep, address& fep, address& dep, address& vep) {
  assert(t->is_valid(), "template must exist");
  switch (t->tos_in()) {
    case btos:
    case ztos:
    case ctos:
    case stos:
      ShouldNotReachHere();  // btos/ctos/stos should use itos.
      break;
    case atos: vep = __ pc(); __ pop(atos); aep = __ pc(); generate_and_dispatch(t); break;
    case itos: vep = __ pc(); __ pop(itos); iep = __ pc(); generate_and_dispatch(t); break;
    case ltos: vep = __ pc(); __ pop(ltos); lep = __ pc(); generate_and_dispatch(t); break;
    case ftos: vep = __ pc(); __ pop(ftos); fep = __ pc(); generate_and_dispatch(t); break;
    case dtos: vep = __ pc(); __ pop(dtos); dep = __ pc(); generate_and_dispatch(t); break;
    case vtos: set_vtos_entry_points(t, bep, cep, sep, aep, iep, lep, fep, dep, vep);     break;
    default  : ShouldNotReachHere();                                                 break;
  }
}
```

比如 `iadd` 的 tos_in=itos: 模板生成两段——vep 入口先 `pop(itos)`(把栈顶值装进 rax),然后 iep 入口直接是模板本体(消费 rax 里的两个操作数)。**dispatch 表里 iadd 的 itos 行指向本体、vtos 行指向"先补载再进本体"的序言**——执行器按自己当前的栈顶状态选行,两条路径共享一份本体。

tos_in=vtos 的模板(如 `iload_0`,vtos 入、itos 出)走 set_vtos_entry_points(templateInterpreterGenerator_x86.cpp:1765-1794,截取核心,逐字):

```cpp
// templateInterpreterGenerator_x86.cpp:1765-1794(截取核心,逐字)
void TemplateInterpreterGenerator::set_vtos_entry_points(Template* t,
                                                         address& bep,
                                                         address& cep,
                                                         address& sep,
                                                         address& aep,
                                                         address& iep,
                                                         address& lep,
                                                         address& fep,
                                                         address& dep,
                                                         address& vep) {
  assert(t->is_valid() && t->tos_in() == vtos, "illegal template");
  Label L;
  aep = __ pc();  __ push_ptr();   __ jmp(L);
#ifndef _LP64
  fep = __ pc(); __ push(ftos); __ jmp(L);
  dep = __ pc(); __ push(dtos); __ jmp(L);
#else
  fep = __ pc();  __ push_f(xmm0); __ jmp(L);
  dep = __ pc();  __ push_d(xmm0); __ jmp(L);
#endif // _LP64
  lep = __ pc();  __ push_l();     __ jmp(L);
  bep = cep = sep =
  iep = __ pc();  __ push_i();
  vep = __ pc();
  __ bind(L);
  generate_and_dispatch(t);
}
```

**关键设计 (斜体)**: *模板本体的前置假设是"栈顶已在栈上"(这样本体只需操作栈,不用关心寄存器缓存)。vtos 入的指令,执行器可能带着任意缓存状态跳进来——入口家族负责把 atos/ltos/itos 等缓存寄存器"卸货"到栈,再进共享本体。这就是 dispatch 表 10×256 而不是 256 的原因: 同一指令,按进入时的栈顶状态,落到不同序言。*

## 4. iload 的两个生成器: 96 字节 vs 192 字节

### short 形式: 常量偏移直访

`iload_0`~`iload_3` 的 def 把生成函数登记为 **`iload(int n)`**(templateTable.cpp:287-290,arg=0..3)——注意 templateTable.hpp:164 的 `static void iload(int n)` 与 :139 的 `static void iload()` 是**两个不同函数**。int 版本只有三行(templateTable_x86.cpp:878-880,截取核心,逐字):

```cpp
// templateTable_x86.cpp:878-881(截取核心,逐字)
void TemplateTable::iload(int n) {
  transition(vtos, itos);
  __ movl(rax, iaddress(n));
}
```

`iaddress(n)` = `Address(rlocals, Interpreter::local_offset_in_bytes(n))`(templateTable_x86.cpp:55)——**编译期常量偏移直接访存**,一条 mov 完事;栈顶进 rax(itos),dispatch 时按 itos 行走。

### 普通形式: 重写检查 + 运行时取下标

`iload`(21)登记的是无参 `iload()`(templateTable.cpp:282),内部是 iload_internal(templateTable_x86.cpp:621-637): 先检查 RewriteFrequentPairs——读 bcp[1] 看下一条是否 iload/caload,决定把当前指令 patch 成 `fast_iload2`/`fast_icaload`/`fast_iload`(01 篇的运行时快速化,这里看到了模板侧);然后 `locals_index(rbx)` 读 bcp[1] 的下标再取局部变量。**普通形式有 1 字节下标操作数,short 形式没有——所以需要两个生成器,而不是共享一个**。

[实证:] `iload` 192 字节 vs `iload_0` 96 字节(08-interpreter-templates.txt)——多出的 96 字节正是重写检查块。大纲说"iload_0 的模板 = 读 bcp+1 的下标"是错的: iload_0 的机器码连 bcp 都不碰,`uses_bcp` 位也为 0(templateTable.cpp:287-290 的 flags 全空)。

## 5. dispatch: 单条间接跳转,外加内联轮询点

### dispatch_next: 先取字节,再推进 bcp

模板本体生成完毕,generate_and_dispatch 收尾(templateInterpreterGenerator.cpp:377-401): 不自己 dispatch 的模板(does_dispatch 位为 0),`step` = 指令长度,先 `dispatch_prolog(tos_out, step)`(x86 上空操作,interp_masm_x86.cpp:800-802),生成本体,再 `dispatch_epilog` → `dispatch_next(state, step)`。

dispatch_next(interp_masm_x86.cpp:881-886,截取核心,逐字):

```cpp
// interp_masm_x86.cpp:881-887(截取核心,逐字)
void InterpreterMacroAssembler::dispatch_next(TosState state, int step, bool generate_poll) {
  // load next bytecode (load before advancing _bcp_register to prevent AGI)
  load_unsigned_byte(rbx, Address(_bcp_register, step));
  // advance _bcp_register
  increment(_bcp_register, step);
  dispatch_base(state, Interpreter::dispatch_table(state), true, generate_poll);
}
```

注释里的 AGI(Address Generation Interlock)是 x86 流水线细节: 先读 `[bcp+step]` 再 `bcp += step`,避免地址依赖停顿。opcode 进 rbx,**bcp(r13)指向下一条指令的地址**,dispatch 按 rbx 查表。

### dispatch_base: 轮询点 + jmp [table + rbx*8]

真正的跳转在 dispatch_base(interp_masm_x86.cpp:808-843,_LP64 部分,截取核心,逐字):

```cpp
// interp_masm_x86.cpp:826-846(截取核心,逐字)
  address* const safepoint_table = Interpreter::safept_table(state);
#ifdef _LP64
  Label no_safepoint, dispatch;
  if (SafepointMechanism::uses_thread_local_poll() && table != safepoint_table && generate_poll) {
    NOT_PRODUCT(block_comment("Thread-local Safepoint poll"));
    testb(Address(r15_thread, Thread::polling_page_offset()), SafepointMechanism::poll_bit());

    jccb(Assembler::zero, no_safepoint);
    lea(rscratch1, ExternalAddress((address)safepoint_table));
    jmpb(dispatch);
  }

  bind(no_safepoint);
  lea(rscratch1, ExternalAddress((address)table));
  bind(dispatch);
  jmp(Address(rscratch1, rbx, Address::times_8));
```

**关键设计 (斜体)**: *两条机制挤在同一个间接跳转里。①dispatch 本体 = `jmp [table + rbx*8]`,一次内存访问 + 一次跳转——大纲说的"2 cycle indirect jump"大体如此,但表地址每次 lea(dispatch 表不在固定寄存器里,r13 是 bcp)。②safepoint 轮询点内联在**每一条字节码的 dispatch 前**: `testb [r15_thread + polling_page_offset]` 测轮询页,置位就改跳 safepoint_table——17-02 的轮询点机制在这里是解释器的主循环的一部分,24-02 的"锚点 pc = 轮询点"在这条 testb 上闭合。*

轮询页置位时跳往的 safepoint 表由第 6 段生成: 每个入口调 `InterpreterRuntime::at_safepoint`(templateInterpreterGenerator.cpp:154-168)。表的切换在 TemplateInterpreter::notice_safepoints(templateInterpreter.cpp:293-303,截取核心,逐字):

```cpp
// templateInterpreter.cpp:293-303(截取核心,逐字)
void TemplateInterpreter::notice_safepoints() {
  if (!_notice_safepoints) {
    log_debug(interpreter, safepoint)("switching active_table to safept_table.");
    // switch to safepoint dispatch table
    _notice_safepoints = true;
    copy_table((address*)&_safept_table, (address*)&_active_table, sizeof(_active_table) / sizeof(address));
  } else {
```

**整个 dispatch 表被整表替换**——`copy_table` 把 `_safept_table` 的内容拷进 `_active_table`(templateInterpreter.cpp:298,安全点内用 `disjoint_words` 直拷、安全点外用原子词拷贝, :282-291)。正在执行的模板不受影响,跑完 dispatch 时自然落入 safepoint 检查。这就是"解释器进入 safepoint 状态"的机制: 不用打断任何线程,下一轮 dispatch 就排队。

## 6. 方法入口与三个特殊入口家族

### 28 种方法入口

方法进入解释器不是走 dispatch 表,是走 `_entry_table[MethodKind]`(abstractInterpreter.hpp:59-61): zerolocals/zerolocals_synchronized/native/native_synchronized/empty/accessor/abstract/java_lang_math_* 11 种/java_lang_ref_reference_get/java_util_zip_CRC32* 5 种/java_lang_Float_*/java_lang_Double_* 4 种(共 28 种,method_handle_invoke_* 系列由 `initialize_method_handle_entries` 单独处理)。generate_all 第 8 段用 method_entry 宏逐个生成(templateInterpreterGenerator.cpp:186-230): `generate_method_entry` 按 kind 分派——zerolocals 走 generate_normal_entry(分配局部变量、初始化帧固定部分、随后进入第一条指令的 dispatch,templateInterpreterGenerator_x86.cpp:1335 起),native 走 generate_native_entry,math 系列走 generate_math_entry 等。**方法入口的差异全部集中在"进入解释器循环之前"**;进入后大家共用同一套 dispatch。

### return 入口与 deopt 入口

执行 `ireturn` 等返回指令时,模板知道**返回地址按什么方式跳回**(调用点指令的长度与栈顶类型),但不知道调用点的具体字节码——于是运行时按 (长度, 栈顶状态) 查 `_return_entry[6]`/`_invoke_return_entry[10]` 选返回入口(templateInterpreter.cpp:240-259)。deopt 同理: 24-03 拆过,unpack 重建的解释器帧按 bci 选 `deopt_entry(state, length)` 或 `deopt_reexecute_return_entry` 恢复执行——这些入口是 generate_all 第 11 段生成的(templateInterpreterGenerator.cpp:239-261): `_deopt_entry[7]` 按指令长度分档(1-6 字节 + reexecute 特例),每个档位家族覆盖 10 种栈顶状态;`_deopt_reexecute_return_entry` 复用 `_normal_table.entry(_return).entry(vtos)` 的返回入口(:258-260,保证 deopt 重执行后正常弹帧)。

## 核心悬念

模板解释器拆完了: 启动时 generate_all 的十一段生成 271 个 codelet——每个字节码一个"入口点家族"(10 种栈顶状态的序言 + 共享本体),dispatch 表 10×256 按 (栈顶状态, opcode) 定位,执行 = 跳进机器码段 + 跑完 `jmp [table + rbx*8]` 跳下一条;栈顶值全程留在寄存器(tosca),压栈由入口序言负责;safepoint 轮询与 deopt 入口都缝进了这套机制。生成成本只在启动时付一次,之后每条字节码的执行成本就是两次跳转。

但有一个明显的断层: `invokevirtual` 1280 字节、`ldc` 736 字节——比 `iadd` 的 64 字节大一个量级。这些是 `calls_vm` 位的指令: 模板自身解决不了符号解析、对象分配、异常检查,执行到关键步骤要**调 C++**。下一篇拆这个通道: InterpreterRuntime——解释器怎么安全地进入 VM 世界再回来。

> → [08-interpreter/03 — 解释器调 C++](03-interpreter-runtime.md)
