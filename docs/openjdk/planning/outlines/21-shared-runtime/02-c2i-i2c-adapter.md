# 02. 从编译跳到解释——c2i/i2c Adapter

> 🔴 Deep | 3 KP 中的调用桥
> 读者处境: 编译代码调用了一个还未编译的方法→需要从编译栈帧切到解释器栈帧。寄存器里存着编译代码的参数——但解释器期望参数在局部变量表中。谁做这个翻译？

### 1. "编译和解释的两种世界" — 调用约定差异

场景: 编译代码跑在 x86_64 上——参数在 rdi/rsi/rdx/rcx/r8/r9 中。解释器期望参数在局部变量表的 slot 0..N 上(栈底)。需要 adapter 做翻译。

**两种 adapter** (`sharedRuntime_x86_64.cpp:500-1200`):
```
c2i (compiled-to-interpreter):
  编译代码调一个 interpreted 方法
  → 释放编译帧的 callee-saved 寄存器 → 建解释器帧
  → 设 locals(参数从编译寄存器 copy 进解释器 local slots)
  → 设 bcp=0, method=callee
  → jmp 解释器 entry(BytecodeInterpreter:run或TemplateInterpreter)

i2c (interpreter-to-compiled):
  解释器调一个 compiled 方法
  → 存 callee target Method* 
  → 设编译帧的 register arguments(rdi/rsi/参数位)
  → jmp compiled entry(verified或unverified)
```
- 源码: `sharedRuntime_x86_64.cpp:500-1200` generate_c2i_adapter + generate_i2c_adapter
- 关键设计: c2i 和 i2c 不对称——c2i 更重(因为要刷洗编译寄存器→建解释器帧→copy 参数→设 bcp)。i2c 更轻(方法已经在局部变量表→只需 copy 到寄存器→跳编译入口)。c2i 的开销是 ~200 instructions，i2c 是 ~40 instructions

**adapter 的 OopMap** (`sharedRuntime_x86_64.cpp:700-800`):
```
c2i adapter 需要 OopMap——因为在 c2i 帧中有 GC root:
  - receiver oop(rdi 中存着)
  - parameter oops(如果需要存储到栈)
  - callee Method*(methodOop 需要被 GC 跟踪)
OopMap 标注这些位置(寄存器/栈偏移)→GC 知道哪些 slot 存了 oop
```
- [x86: OopMap 是编译时生成的 bitmask——每个 slot 1 bit(oop vs non-oop)。GC worker 遍历栈帧→对每个 slot: check OopMap bit→1→mark oop。adapter 的 OopMap 很小——只有 receiver+method 两个 oop root]

### 2. "改朝换代——栈帧怎么切？" — Frame Layout

场景: 编译代码调解释器——当前 RSP 在编译帧的底部。解释器帧需要在当前帧上面建(new frame with lower RSP)。

**c2i 的栈帧切換** (`sharedRuntime_x86_64.cpp:800-1000`):
```
编译帧 (caller):
  [args...] [return pc] [saved rbp] [callee-saved regs] [locals...]
                                  ↑ RSP (caller's RSP after call)
c2i adapter:
  1. push callee Method* (解释器的当前方法)
  2. push return address (解释器中如果 callee 返回→回到编译代码)
  3. allocate local slots(从编译寄存器 move 参数)
  4. set bcp = 0 (解释器从 bytecode 0 开始)
  5. jmp interpreter entry
```
- [x86: `push rbp; mov rbp, rsp` = 建新帧。adapter 的帧在编译帧下方——RSP 减小对 GC 安全(没有 overrun padding)。caller's RBP 链: 编译帧 RBP → c2i 帧 RBP → NULL(解释器帧用不同的 framing)]

**i2c 的帧切換**:
```
解释器帧 (caller):
  [locals][bcp][method][monitors]...
  RSP → [push compiled entry args in registers]
  jmp compiled_entry
```
- 关键设计: i2c 不建新帧——直接在解释器帧底部压参数→jmp。因为解释器帧已经在编译代码上方(RSP 小于编译帧)且解释器帧不需要被 GC 扫描调用端——编译代码用自己的 OopMap

### 3. "reg 参数怎么对应 local？" — 参数寄存器映射

场景: `foo(int a, long b, Object c)` —— x86_64 前 6 参数在寄存器。c2i adapter 要把它们 copy 到解释器的 local slots。

**x86_64 calling convention**:
```
rdi = receiver (this)    // 非静态方法
rsi = arg0 / local[0]
rdx = arg1 / local[1]
rcx = arg2 / local[2]
r8  = arg3 / local[3]
r9  = arg4 / local[4]
[stack] = arg5+         // regs 超6→栈传递
```
- 源码: `sharedRuntime_x86_64.cpp:300-500` 参数 mapping 逻辑
- 关键设计: c2i adapter 用 `mov [rsp+offset], reg` copy 每个寄存器参数到对应的栈位置。x86_64 中一个 long(64-bit) 存储在单个 64-bit 寄存器中(如 rdx)→对应解释器的一个 local slot(在 64-bit JVM 中 slot=intptr_t=8 bytes)。而 int(32-bit) 同样占一个 slot——slot 大小统一。double 存在 xmm0-xmm7 中→需 `movsd [rsp+offset], xmmN` 存到栈
- [C++: 解释器用 `locals()[i].set_int(val)` / `locals()[i].set_long(val)` 存储——64-bit JVM 中每个 slot 是 intptr_t(8 bytes)。与 32-bit JVM 不同——32-bit JVM 中 slot=4 bytes→long 占 2 slots, double 占 2 slots→参数 copy 要拆两次]

---

### 核心悬念

**"c2i/i2c adapter 是编译↔解释栈帧切换的手写汇编桥——c2i 刷洗寄存器+建解释器帧+copy 参数(200 insn)，i2c 轻量 copy 参数+跳编译(40 insn)。x86_64 前 6 参数在寄存器→copy 到 local slots。"** — 但编译代码里抛异常了怎么办？下一篇: 异常处理。

> → [03-exception-handling.md](03-exception-handling.md)
