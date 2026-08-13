# 01. Bytecodes — 256 条 JVM 字节码的定义表

> 🔴 Deep | 13 KP 中的 2 个核心机制
> 读者处境: `javap -c` 的每行是一个 opcode。256 条——每条有 format/length/stack effect。这些不是运行时 switch——是**编译时预计算**的静态数组。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/08-interpreter/01 已按真实源码成文 308 行,本大纲为规划期产物,机制描述以文章为准):
> - **行号全漂移**: Code 枚举 bytecodes.hpp:38-307(_illegal=-1 起);数组声明 :339-346;def() 实现 bytecodes.cpp:167-185;initialize() :278-567;special_length_at :90-137;大纲 "hpp:100-500/cpp:60-200" 全错
> - **"5 个静态数组 names/lengths/formats/flags/depths" 错**: 6 个数组=_name/_result_type/_depth/_lengths/_java_code/_flags(hpp:339-346),**无 _format 数组**——format 字符串由 compute_flags(cpp:206-276)编译成 _flags 位;_lengths 一字节两用(低 4 位短长/高 4 位 wide 长,hpp:397-398);_flags=512 槽双页(低 256 普通/高 256 wide,hpp:345,432-435)
> - **"def(_nop, "nop", "b", 1, 0, T_ILLEGAL, true)——宏展开 9 数组" 错**: 是 C++ 静态函数(7/8 参数: code,name,format,wide_format,result_type,depth,can_trap[,java_code]),非宏;nop 实为 T_VOID/can_trap=false;239 条 def 调用,启动一次填充后只读
> - **"Format: b=1B signed byte/c=1B CP index/i=2B/j=4B branch offset" 全错**: 真实语义(cpp:188-204 注释)=b 是 opcode 本身、c=signed constant、i=local index、j=**2B CP cache index**、k=CP index、o=branch offset(ifeq "boo" 2B/goto_w "boooo" 4B)、_=忽略、w=wide 前缀;大写=原生字节序(实际只有 J 出现,cpp:244 注释);指令长度=format 字符串字符数;变长 format=""
> - **"256 条(255=impdep2)" 错**: 枚举=203 个成员(0x00-0xCA,含规范保留的 wide 0xC4/breakpoint 0xCA)+36 条私有 fast 系列(hpp:249-303,fast 29+return_register_finalizer+invokehandle+nofast 4+shouldnotreachhere)=number_of_codes 239;0xCB-0xFF 未分配区不定义
> - **"Load/Store ~60 条;short forms 6 种×4=24" 错**: 5 类型(iload/lload/fload/dload/aload)×(1 基本+4 short)=25 load+对称 25 store=50 条;short 5×4=20
> - **"opcode upper 4 bits 编码分组,分组让 dispatch 用查表" 编造**: opcode 段布局(常量/局部变量/算术/控制流/引用)是 JVM 规范历史安排;HotSpot 分组=**区间谓词函数**(hpp:415-429: is_aload 点名/is_const 区间/is_return 区间/is_invoke),真实消费者: verifier.cpp:754、templateInterpreter.cpp:254、deoptimization.cpp:705-722;dispatch 不用分组
> - **"flags 在 bytecodes.cpp:100-150;can_trap=false 的 bytes 不影响循环结构(loop optimization)" 编造**: Flags 枚举在 hpp:310-336(_bc_can_trap/_bc_can_rewrite+格式位);can_trap 真实消费者=GenerateOopMap::do_exception_edge(generateOopMap.cpp:1178,决定"异常边"→解释器 OopMap 栈图,24-01 oopMapCache 链)+ciTypeFlow.cpp:2171;C1 自建 _can_trap 表(c1_GraphBuilder.cpp:2976-3034,清单剔 return/monitorexit,"monitor pairing proved that they succeed")
> - **"stack_effect(opc,bci) 与 _unknown_depth" 编造**: 函数与值都不存在;depth 恒静态(invoke 系 depth=-1 近似 pop receiver,invokestatic/invokedynamic=0);"栈顶类型由上下文决定"由 result_type=T_ILLEGAL 表达(cpp:289-291 Note 2 注释)
> - **"编译后全在 .data 零开销" 半对**: 数组初始在 .bss,启动 initialize() 一次填完,之后只读;"编译时预计算"应说"启动时预填充"
> - **长度机制(大纲未提)**: 变长仅三条=wide(读第二字节查 _lengths 高 4 位)/tableswitch(align_up(bcp+1,4) 对齐,长=(补齐)+(3+hi-lo+1)*4,cpp:97-114)/lookupswitch(长=(补齐)+(2+2*npairs)*4,cpp:119-124);breakpoint 不在 special_length_at case 里(返 0),普通迭代器经 code_at 伪装成原指令(bytecodes.hpp:369-374),raw_special_length_at 才给 1(:151-158);迭代器先 length_for 查固定长、0 才 length_at(bytecodeStream.hpp:205-207);实测 76 条固定长全对 + lookupswitch 对齐(实证 08-bytecodes-javap.txt)
> - **第 3 轮 REVIEW 补充(2026-08-13)**: ①is_aload 逐个点名=枚举不连续(_aload=25 与 _aload_0=42 间隔 16 个成员),**与"被重写"无关**;②_aload_0 can_trap=true 与运行时快速化闭环: aload_0 模板按下一字节 patch 成 fast_aload_0/fast_*access_0(templateTable_x86.cpp:973,注释 "rewriting in interpreter");getfield 解析后 patch fast_igetfield(:2929);③verifier.cpp:754 真实语义=store 指令在异常处理器覆盖区内时,先按 JVM 规范"进入类型状态"校验 handler 目标(局部变量加入之前),非"检查覆盖区";④正文"六张表"实为 6 数组(含 _java_code),注意点 3 条

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
