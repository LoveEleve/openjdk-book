# 02. TemplateInterpreter — 字节码→x86 机器码

> 🔴 Deep | 13 KP 中的 2 个核心机制
> 读者处境: `iload_0` 是 1B opcode——TemplateInterpreter 生成 ~10B x86 码——存在 CodeCache——每次执行跳过去。

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
