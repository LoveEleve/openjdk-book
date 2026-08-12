# 03. x86 指令集 — JVM 的"常用字表"

> **前置依赖**:[02-assembler/02 — ModR/M → REX → VEX](02-x86-register-operand-encoding.md):操作数编码——本篇的每个字节都建立在那上面;45-math-library/01(SSE2 指令的实战)
> → **后续**:[04 — MacroAssembler 运行时](04-x86-macroassembler-runtime.md)
> 关联域: 05-cpu-primitives(原子与屏障)、13-jit、19-sync

## 400+ 条指令,JVM 的 JIT 只用其中一小撮

x86 有数百条指令(MMX/SSE/AVX/字符串/十进制调整/系统指令……),而 JIT 编译 Java 方法时反复用到的只是**一个小子集**:mov 家族搬数据、add/sub/imul/idiv 算数、cmp/jcc 比较分支、call/jmp 控制流、SSE 浮点、lock 原子。这篇从 assembler_x86.cpp(9501 行)里挑六个"常用字"看它们怎么编码,以及为什么 JIT 的词汇表这么小。

## 1. mov 家族与 lea:搬数据

### 1.1 场景:Java 的赋值语句编译成什么

`a = b` 编译成一条 `mov`。家族成员按**操作数宽度**命名(assembler_x86.cpp):

```cpp
// assembler_x86.cpp:2289-2291、3023-3031(截取核心,逐字)
void Assembler::mov(Register dst, Register src) {
  LP64_ONLY(movq(dst, src)) NOT_LP64(movl(dst, src));
}

void Assembler::movzbl(Register dst, Address src) { // movzxb
  ...
void Assembler::movzbl(Register dst, Register src) { // movzxb
```

`movzbl` 是"零扩展字节到 long":取 1 字节、扩展到 32 位(注释里的 "movzxb")——类似 Java 的 `(int)(byte & 0xFF)`,但一条指令完成。符号扩展版是 `movsbl`(2905)、`movslq`(9057,符号扩展 32→64)。

**cmovcc:条件移动,消灭分支**(1587-1600):

```cpp
// assembler_x86.cpp:1587-1598(截取核心,逐字)
void Assembler::cmovl(Condition cc, Register dst, Register src) {
  NOT_LP64(guarantee(VM_Version::supports_cmov(), "illegal instruction"));
  int encode = prefix_and_encode(dst->encoding(), src->encoding());
  emit_int8(0x0F);
  emit_int8(0x40 | cc);
  emit_int8((unsigned char)(0xC0 | encode));
}
```

`0F 40|cc`——cc 是 16 种条件(0-15),同一条指令编码出 cmove/cmovne/cmovg/cmovl……**条件移动 = 无条件执行两条路径之一**,没有跳转就没有分支预测失败。JIT 用它处理"不可预测的分支"(比如 `x = (a < b) ? 1 : 2`)。

**lea:不算内存的地址运算**(8109,内部转 leal@2252):

```cpp
// assembler_x86.cpp:8109-8112(截取核心,逐字)
void Assembler::lea(Register dst, Address src) {
  leal(dst, src);
}
```

`lea rax, [rbx + rcx*4 + 8]` 把地址表达式**当算术用**:rax = rbx + rcx*4 + 8——AGU(地址生成单元)算完就返回,**不访问内存**。JIT 常用它做"一条指令的多项式加法"(乘 2/4/8 免费,因为 scale)。

- [x86: cmov 与 jmp 的取舍:cmov 执行时间固定(无条件),jmp 依赖预测(命中 1 cycle、失败 ~20);分支可预测时 jmp 更快,不可预测时 cmov 更稳——JIT 的取舍是运行时 profile 决定的]
- [x86: lea 的 3 个源(base、index*scale、disp)一次算完,mov+add 需要两条;但 lea 不写 flags,需要 flags 的场景用 add]

**关键设计 (斜体)**: *mov 家族的宽度后缀(b/w/l/q)是 x86"一条指令一个操作数大小"的体现——JVM 的类型宽度(byte/short/int/long)直接映射到这些后缀;扩展类指令(movzbl/movslq)把"取窄值变宽值"压缩成一条。cmov 是"用执行换分支"的典型:两条路径都算,条件决定取哪条——在分支不可预测时,这比跳转便宜得多。*

## 2. 算术与原子:指令即原语

### 2.1 场景:JVM 的算术与并发原语

算数指令走 `emit_arith` 统一路径(addq@8567-8573):

```cpp
// assembler_x86.cpp:8567-8573(截取核心,逐字)
void Assembler::addq(Register dst, int32_t imm32) {
  (void) prefixq_and_encode(dst->encoding());
  emit_arith(0x81, 0xC0, dst, imm32);
}
```

`emit_arith`(257-269)是"加/减立即数"的统一路径——注意它内部的优化:**立即数能放进 8 位时,自动改用 sign-extended imm8 形式**(`op1 | 0x02`,261-264 行),一条 3 字节指令替代 6 字节,否则才发 imm32。乘法 `imulq`(8886-8906)用 0F AF 两操作数形式;除法 `idivq`(8880)是隐含操作数指令(商在 rax、余数在 rdx)。

**原子操作只有一条指令**——`lock` 前缀(2268-2270):

```cpp
// assembler_x86.cpp:2268-2270(逐字)
void Assembler::lock() {
  emit_int8((unsigned char)0xF0);
}
```

`lock cmpxchg` = `lock()` + `cmpxchg`——05-cpu 篇讲过的 LOCK 原子操作,在这里就是一行 `emit_int8(0xF0)`。JVM 所有的 CAS、fetch-and-add、safepoint 计数,最终都是这条前缀 + 一条指令。

- [x86: 算数指令的 opcode 家族:0x00-0x05(add 的 6 种组合)、0x81(立即数)、0x03(reg←mem)……JIT 只挑常用子集,`emit_arith` 把它们组织成一张表]

**关键设计 (斜体)**: *算术的编码由 `emit_arith` 一张表覆盖 4 种操作数组合,每条指令 2-4 字节。而对 JVM 而言更重要的是:**并发原语=一条指令**——`lock cmpxchg` 是唯一硬件原子,05-cpu 篇的整个 `Atomic` 抽象、48-02 篇的 ConcurrentHashTable 的 CAS,底层都是 `lock()` + `cmpxchg` 两个方法调用。指令集在这里不是"汇编课",是 JVM 并发正确性的物理根基。*

## 3. 控制流:jmp 三种编码,前向一律长格式

### 3.1 场景:跳转的距离决定编码

`jmp` 有三种形态(assembler_x86.cpp:2169-2199),**目标距离决定字节数**:

```cpp
// assembler_x86.cpp:2169-2199(截取核心,逐字)
void Assembler::jmp(Label& L, bool maybe_short) {
  if (L.is_bound()) {
    address entry = target(L);
    assert(entry != NULL, "jmp most probably wrong");
    InstructionMark im(this);
    const int short_size = 2;
    const int long_size = 5;
    intptr_t offs = entry - pc();
    if (maybe_short && is8bit(offs - short_size)) {
      emit_int8((unsigned char)0xEB);
      emit_int8((offs - short_size) & 0xFF);
    } else {
      emit_int8((unsigned char)0xE9);
      emit_int32(offs - long_size);
    }
  } else {
    // By default, forward jumps are always 32-bit displacements, since
    // we can't yet know where the label will be bound.  If you're sure that
    // the forward jump will not run beyond 256 bytes, use jmpb to
    // force an 8-bit displacement.
    InstructionMark im(this);
    L.add_patch_at(code(), locator());
    emit_int8((unsigned char)0xE9);
    emit_int32(0);
  }
}

void Assembler::jmp(Register entry) {
  int encode = prefix_and_encode(entry->encoding());
  emit_int8((unsigned char)0xFF);
  emit_int8((unsigned char)(0xE0 | encode));
}
```

- **0xEB rel8**(2 字节):±127 短跳
- **0xE9 rel32**(5 字节):±2GB
- **0xFF /r**(2 字节,间接):跳转地址在寄存器里(switch table 的 computed goto)

注释(2188-2192)重申了 01 篇的机制:**前向跳转固定 0xE9 长格式**——生成时不知道目标在哪,先占 5 字节槽,Label 绑定后回填;确定在 256 字节内的才用 `jmpb` 显式短跳。`call`(1530-1552)同构:`0xE8` + rel32 + **relocation 类型参数**——call 到 stub/VM 函数时,重定位记录"这里要填运行时地址",让 CodeBuffer 的 relocate 系统(01 篇)处理。

**关键设计 (斜体)**: *跳转的编码由"距离"决定,而距离在生成时常常未知——于是 JIT 的策略是"前向一律 5 字节,反向/短距才省"。"先占槽后回填"让生成器永远不需要回头重写,代价是每个前向跳转平均浪费 3 字节;method 小分支密集时,`jmpb`/`jccb` 显式短跳是手动的省字节手段。这是 01 篇 Label 补丁系统在指令层面的落地。*

## 4. SSE/AVX 与屏障:浮点与内存序

### 4.1 场景:double 运算与内存屏障

浮点加法的 SSE 版(assembler_x86.cpp:1274-1283)与整数指令风格一致:

```cpp
// assembler_x86.cpp:1274-1282(截取核心,逐字)
void Assembler::addsd(XMMRegister dst, XMMRegister src) {
  NOT_LP64(assert(VM_Version::supports_sse2(), ""));
  InstructionAttr attributes(AVX_128bit, /* rex_w */ VM_Version::supports_evex(), /* legacy_mode */ false, /* no_mask_reg */ true, /* uses_vl */ false);
  attributes.set_rex_vex_w_reverted();
  int encode = simd_prefix_and_encode(dst, dst, src, VEX_SIMD_F2, VEX_OPCODE_0F, &attributes);
  emit_int8(0x58);
  emit_int8((unsigned char)(0xC0 | encode));
}
```

`addsd`(双精度加)是 **SSE 破坏性**指令:dst = dst + src——注意即使走 VEX 编码,`simd_prefix_and_encode(dst, dst, src, ...)` 的 vvvv 字段填的仍是 dst(保持破坏性语义);前缀是 `VEX_SIMD_F2`(addsd 的 legacy 前缀就是 F2 0F 58)。而 AVX 的 `vaddsd` 用独立 src 填 vvvv:非破坏性 dst = src1 + src2——JIT 在支持 AVX 的机器上自动多一条"免拷贝"收益(编译期选 `UseAVX`,和 45-01 篇 mulsd 的调用链同源)。

内存屏障同样是指令(2282-2287):

```cpp
// assembler_x86.cpp:2282-2287(逐字)
// Emit mfence instruction
void Assembler::mfence() {
  NOT_LP64(assert(VM_Version::supports_sse2(), "unsupported");)
  emit_int8(0x0F);
  emit_int8((unsigned char)0xAE);
  emit_int8((unsigned char)0xF0);
}
```

`mfence` = `0F AE F0`(lfence 是 0F AE E8,2262-2266)。05-cpu 篇的 OrderAccess 四屏障,在 x86 上就是这几个字节的排列组合。

- [x86: TSO 内存模型下 mfence 是"最重"的屏障(全序);JVM 的 OrderAccess 在 x86 只需要 storeload 真屏障,其余编译器屏障即可(05-cpu 篇已拆);mfence/lfence/sfence 三个字节序列(0F AE F0/E8/F8)是 x86 的全部屏障字表]

**关键设计 (斜体)**: *SSE/AVX 的进化是"破坏性→非破坏性":SSE 的 dst 兼任操作数(AVX 之前要 `mov` 保存现场),AVX 用 VEX 的 vvvv 字段把源操作数独立出来——省一条 mov。JIT 的收益是编译期的指令选择(`UseAVX` 探测),运行期零成本。浮点与内存序在这里汇合:45-01 篇的 `mulsd`、05-cpu 篇的 `lock addl`,都是这几节讲过的指令字节。*

## 核心悬念

"常用字表到齐:mov/add/cmp/jmp/call/lock/SSE/mfence。但 JIT 生成的从来不是'一条指令',而是**模板**——调用 VM 函数要挂载 safepoint 检查、拿对象头要防 GC、switch 要建跳转表。下一篇:MacroAssembler——把指令拼成'运行时'的完整代码模板(call_VM、safepoint 轮询、卡表屏障)。"

> → [04-x86-macroassembler-runtime.md](04-x86-macroassembler-runtime.md)
