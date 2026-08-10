# 01. Bytecodes — 256 条 JVM 字节码的定义表

> 🔴 Deep | 13 KP 中的 2 个核心机制
> 读者处境: `javap -c` 的每行是一个 opcode。256 条——每条有 format/length/stack effect。这些不是运行时 switch——是**编译时预计算**的静态数组。

### 1. Bytecodes — 静态定义表

场景: ClassFileParser 读到 `0x1A`——binary opcode。这是什么？`Bytecodes::code_at(0x1A)`→`_iload_0`→length=1, format="", depth=1, flags=load/local/...

**字节码定义表** (`bytecodes.hpp:100-500` + `bytecodes.cpp:60-200`):
- 256 条: `Code` 枚举(0=nop, 1=aconst_null, ..., 255=impdep2) + `_name[256]` + `_length[256]` + `_format[256]` + `_flags[256]` + `_depth[256]`
- [C++: `Bytecodes::initialize()`——在 JVM 启动时一次性初始化所有 256 个静态数组。`def(_nop, "nop", "b", 1, 0, T_ILLEGAL, true)`——宏展开为 9 个数组的 index 赋值。不是运行时 lookup——编译后全在 .data section——零初始化开销]
- [JVM Spec: §6.5 Instructions — 每条字节码的 mnemonic/opcode/format/operands/stack effect/description。iload = 0x15 (1B opcode) + index (1B, 0-255)。wide iload = 0xc4 (1B wide opcode) + 0x15 (1B iload) + index (2B, 0-65535)]
- Format: ""(无)/"b"(1B signed byte)/"c"(1B constant pool index)/"i"(2B)/"j"(4B branch offset)——确定 operands 数量+大小

**字节码分组** (`bytecodes.hpp:200-350`):
- Load/Store: iload/istore/aload/astore/dload/dstore/fload/fstore/lload/lstore——5 种类型 × 2 操作 = 10 basic + `_0/_1/_2/_3` short forms (6 种 × 4 = 24) + wide——共 ~60 条。每条格式相同——仅类型名和 opcode 不同
- 算术: iadd/isub/imul/idiv/irem + l/f/d variants——全部类型的 +-*/%——每次推 2 pop 2 push 1
- 控制流: ifeq(0x99)/ifne(0x9a)/iflt(0x9b)/ifge(0x9c)/ifgt(0x9d)/ifle(0x9e)——每 6 条一组，2B offset。if_icmp*——比较两个 int。tableswitch(0xaa)/lookupswitch(0xab)——复杂的多路分支——0-3B padding→4B default+low+high+offsets
- 对象: new(0xbb)/newarray(0xbc)/anewarray(0xbd)/checkcast(0xc0)/instanceof(0xc1)/monitorenter(0xc2)/monitorexit(0xc3)
- 方法: invokevirtual(0xb6)/invokespecial(0xb7)/invokestatic(0xb8)/invokeinterface(0xb9)/invokedynamic(0xba)——各不同 call semantics
- [x86: opcode 的 upper 4 bits 编码指令分组——0x00-0x0F=nop/aconst/null/iconst/bipush/sipush/ldc, 0x10-0x1F=bipush/sipush, 0x30-0x3F=iload/lload/fload/dload/aload+index, 0xA0-0xBF=if_icmp/goto/jsr/ret/tableswitch/lookupswitch/return——不是随机的——分组让 dispatch 用查表]

### 2. Flags + Stack Effect

**flags** (`bytecodes.cpp:100-150`):
- `Bytecodes::Flags`: 每个 bytecode 的标志组合——`_is_load`/`_is_store`/`_is_branch`/`_is_trap`/`_can_trap`/`_is_wide`
- [C++: flags 预处理——`Bytecodes::can_trap(opc)`→false for 纯栈操作(swap/dup/pop), true for 可能 throw(div/idiv/new/checkcast)。在 loop optimization 中——can_trap=false 的 bytes 不影响循环结构]

**stack effect** (`bytecodes.cpp:60-120`):
- `_depth[256]`: 每条字节码的栈深度变化。static: iload=+1, istore=-1, swap=0 (2 pop + 2 push)。runtime: invokevirtual=?? (需要解析 descriptor——参数 N→pop N+1, return M→push M)——返回 `_unknown_depth`
- [C++: `Bytecodes::depth(opc)` 和 `Bytecodes::stack_effect(opc, bci)` 的区别——前者是静态 depth 值 (编译时已知)，后者考虑实际情况——比如 invoke——需要查 cpCache→method→descriptor→计算 ]

---

### 核心悬念

**"256 条字节码——不是 switch dispatch——是 5 个静态数组: names/lengths/formats/flags/depths。"** — 全部预计算在编译时——JVM 启动时 `initialize()` 一次性赋完。下一个: TemplateInterpreter——每条字节码怎么变成 x86 机器码？

> → [02-template-interpreter.md](02-template-interpreter.md)
