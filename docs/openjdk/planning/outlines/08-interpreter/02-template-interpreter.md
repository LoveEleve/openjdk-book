# 02. TemplateInterpreter — 字节码→x86 机器码

> 🔴 Deep | 13 KP 中的 2 个核心机制
> 读者处境: `iload_0` 是 1B opcode——TemplateInterpreter 生成 ~10B x86 码——存在 CodeCache——每次执行跳过去。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/08-interpreter/02 已按真实源码成文 330 行,本大纲为规划期产物,机制描述以文章为准):
> - **"generate_all 三步(entry→bytecodes→return)" 错**: 真实=十一段(templateInterpreterGenerator.cpp:57-263): 慢签名+错误出口(:58-65)→return 入口按长度 5 档(_return_entry[6],0 空置,:86-105)→invoke return 按 TosState 10 档(:107-122)→earlyret(:124-138)→native 结果处理器(:140-151)→safepoint 入口(调 InterpreterRuntime::at_safepoint,:154-168)→异常+6 个 throw 入口(:170-182)→方法入口(method_entry 宏 28 种,:186-230)→set_entry_points_for_all_bytes 遍历 256(:233,:276-285)→set_safepoints_for_all_bytes(:237)→deopt 入口(_deopt_entry[7] 按长度,:239-261);顺序是依赖序
> - **"InterpreterMacroAssembler movl(rax,[rsi+offset])(rsi=locals)" 寄存器错**: x86_64 下 rlocals=r14、rbcp=r13(templateTable_x86.cpp:46-47,r13 是 bcp 不是 dispatch 表);locals_index 取到的是负 index(negptr);iaddress(n)=Address(rlocals, local_offset_in_bytes(n))(:55)
> - **"DispatchTable: _table[opcode]" 错**: 二维 **DispatchTable::_table[number_of_states][256]**(templateInterpreter.hpp:65-83),10 个栈顶状态 × 256 字节码;EntryPoint=10 状态地址家族(:43-59);set_entry 按状态逐个填(templateInterpreter.cpp:158-171)
> - **"jmp Address(r13, rbx*8)(rbx=DispatchTable)" 错**: dispatch_base(interp_masm_x86.cpp:808-843)=**lea rscratch1, ExternalAddress(table) + jmp [rscratch1+rbx*8]**(表地址每次 lea);dispatch_next 先 load [bcp+step] 再 bcp+=step(防 AGI,:881-887)
> - **"iload_0 模板: transition→movl→push(rax)→advance→dispatch_next" 错**: iload_0..3 的生成器是 **iload(int n)**(templateTable_x86.cpp:878-881,3 行: transition+movl(rax,iaddress(n)),**无 push 无 bcp 访问**);transition 只是断言不生成代码(templateTable.cpp:162-165);advance/dispatch 由 generate_and_dispatch 统一生成(templateInterpreterGenerator.cpp:377-401)
> - **"iload_0 ~20B/生成 ~10B" 错**: 实测 iload_0=96B、iload=192B(iload() 含 RewriteFrequentPairs 重写检查读 bcp[1],:621-637)、iconst 7 个全 96B、iadd 64B、ldc 736B、invokevirtual 1280B(08-interpreter-templates.txt,Temurin 11);271 codelets avg 404B
> - **"相同 tosState→共享 template(iload 和 fload 都 push 4B→模板相同)" 错**: 共享按**生成函数+arg 参数化**(iconst(arg)/iop2(Operation)/if_0cmp(Condition)/float_cmp(±1)/fast_accessfield(tos),templateTable.cpp:357,410-419,480-487),不是按 tosState;iload/fload 生成器不同
> - **"TemplateTable::_itable[256]" 错**: 真实=_template_table/_template_table_wide 双表各 239 槽(templateTable.cpp:172-173);def 用 iswd 位选表,:186-203 断言 "wide instructions have vtos entry point only";wide 入口单列 _wentry_point[256](templateInterpreter.hpp:134)
> - **入口点家族机制(大纲未提,核心)**: set_short_entry_points(templateInterpreterGenerator.cpp:345-362): tos_in!=vtos 时 vep=pop(state)+对应状态入口=本体(**pop 是从栈装载到寄存器**,interp_masm_x86.cpp:678-704);tos_in==vtos 走 set_vtos_entry_points(templateInterpreterGenerator_x86.cpp:1765-1794)=5 个压栈序言(aep push_ptr/fep push_f(xmm0)/lep push_l/iep push_i)+vep 共享本体;**栈顶值留在寄存器(tosca=Top-Of-Stack CAche,templateInterpreter.hpp:40)不压栈**;TosState 10 态在 globalDefinitions.hpp:819-832(btos=0..vtos=9)
> - **safepoint 轮询内联(大纲未提)**: dispatch_base 里 testb [r15_thread+polling_page_offset] 每字节码轮询一次,置位跳 safept_table(:826-834);notice_safepoints 用 copy_table **整表拷贝** safept→active(templateInterpreter.cpp:293-325,非指针换向;atomic 词拷贝 :282-291)——17-02/24-02 呼应
> - **"entry_points: _entry_table[MethodKind]——zerolocals/synchronized/native/accessor/empty" 部分对**: MethodKind 28 种(abstractInterpreter.hpp:59-61: zerolocals..abstract 7+math 11+reference_get 1+CRC32 5+Float/Double 4),method_handle_invoke_* 由 initialize_method_handle_entries 单独处理(templateInterpreterGenerator.cpp:211);generate_method_entry 分派(:405-486),zerolocals→generate_normal_entry(x86:1335)

### 1. TemplateInterpreter — 每条字节码的机器码生成

场景: JVM 启动→`TemplateInterpreterGenerator::generate_all()`→遍历 256 条字节码→每一生成**唯一的** x86 机器码 template→存入 CodeCache——命名为 "iload", "aload_0", "invokevirtual", ...

**generate_all** (`templateInterpreterGenerator.cpp:50-300`):
- 三步: 1) generate entry points (zerolocals/synchronized/native)→2) 遍历 0-255 generate bytecodes→3) generate return entries
- [C++: InterpreterCodelet——继承 CodeBlob——name/entry/description。`AbstractInterpreter::code()`→`StubQueue` (CodeCache 中的解释器码)。每个 codelet 有独立的入口点和大小]
- [x86: `InterpreterMacroAssembler`——同 Assembler domain 02 的宏汇编器——`movl(rax, Address(locals, index*4))`→生成 `mov eax, [rsi+offset]` (rsi=locals ptr)——`push(rax)`→生成 `push rax`——`jmp(Address(rbx, next_opcode*8))`→生成 `jmp [rbx+offset]` (rbx=DispatchTable)]
- DispatchTable: `_table[opcode] = codelet->entry_point()`。Dispatch: `jmp DispatchTable[next_opcode]`——2 cycle indirect jump。

**iload_0 的完整 template** (`templateTable_x86.cpp:200-600`):
- Step 1: `transition(vtos, itos)`——栈从 void→int——`push(rax)`——push 任意值初始化栈槽
- Step 2: `movl(rax, Address(rsi, 0))`——rsi = locals pointer (在 interpreter frame 中)——offset 0 = local variable 0——读 local
- Step 3: `push(rax)`——push 读取的值到栈
- Step 4: `advance(bcp, 1)`——bcp (bytecode pointer) += 1——下一条字节码
- Step 5: `dispatch_next(vtos)`——`movzbl(rbx, Address(bcp))` (load next opcode)→`jmp Address(r13, rbx*8)` (dispatch)
- [x86: 生成的完整 x86 序列: `push rax; mov eax, [rsi]; push rax; lea r14, [r14+1]; movzx ebx, byte [r14]; jmp [r13+rbx*8]`——约 20B——iload_0 是 short form——没有 index operand——简单]

**tosState 优化** (`templateInterpreter.hpp:60-100`):
- itos/atos/ltos/ftos/dtos/vtos——栈顶类型状态——决定栈顶寄存器 (`rax` for int, `rax:d` for long, `xmm0` for float)
- [x86: tosState dispatch——不同 tosState 下 `pop()` 生成不同代码: itos→`pop rax`, ltos→`pop rax; pop rdx` (high + low), vtos→no pop。JIT 的 c2i adapter 用 tosState 知道解释器帧的栈顶类型——决定 JIT 代码从哪里读被调方法的参数]
- 相同 tosState→共享 template: `iload` 和 `fload` 都是 push 4B→都用 itos→template 相同——省 50+ template

### 2. TemplateTable — 生成器函数表

**TemplateTable** (`templateTable.hpp:30-80` + `templateTable_x86.cpp`):
- `TemplateTable::iload()`→`transition(...)`→`locals_index_wide_or_byte(...)`→`push(rax)`→`advance(...)`→`dispatch_next(...)`
- [C++: TemplateTable::itable——`_itable[256]` = `Template*`——每bytecode 的生成函数。`templateTable_x86.cpp` 是 x86 特定实现——`locals_index_wide_or_byte()` 生成读 `bcp+1` (可能 wide+2)—→`mov rax, [rsi+index*8]`]
- entry_points: `_entry_table[MethodKind]`——zerolocals/synchronized/native/accessor/empty——不同 method kind 不同入口

---

### 核心悬念

**"iload_0 = 1B opcode→TemplateInterpreter 生成 20B x86 码→CodeCache→DispatchTable[opcode]→每次执行 jmp [r13+rax*8] (2 cycles)。"** — 不是 C++ switch(20-30 cycles)→直接 jump 到预生码。tosState 共享让 256 条字节码用 ~150 个 template (节省 40%)。下一个: InterpreterRuntime——解释器调 C++。

> → [03-interpreter-runtime.md](03-interpreter-runtime.md)
