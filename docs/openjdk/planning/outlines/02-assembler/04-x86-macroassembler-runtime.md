# 04. MacroAssembler — call_VM / safepoint / AES-NI / Math

> 🔴 Deep | 15 KP 中的 2 个运行时机制 + Math/Crypto Intrinsics
> 读者处境: 单条 x86 指令你会了。call_VM —— 从 JIT 代码调 C++ 函数 —— 怎么做到的？

### 1. call_VM — JIT→C++ 调用桥

**Linux SystemV AMD64 传参** (`macroAssembler_x86.hpp:120`):
- c_rarg0 (RDI), c_rarg1 (RSI), c_rarg2 (RDX), c_rarg3 (RCX), c_rarg4 (R8), c_rarg5 (R9)
- [x86: SystemV calling convention —— 前 6 个整数参数用寄存器 (RDI~R9)，更多用栈。浮点参数用 XMM0~XMM7。Callee-saved: RBX/RBP/R12-R15 (被调函数保证不破坏)。JIT 代码是 caller —— 必须保存 caller-saved 寄存器 (RAX/RCX/RDX/RSI/RDI/R8-R11/XMM0-XMM15)]
- [man 2 syscall] [man 7 syscalls]

**volatile 寄存器保存** (`macroAssembler_x86.cpp:1620`):
- C++ 函数可能覆写 RAX/RCX/RDX/RSI/RDI/R8-R11 和 XMM0-XMM15
- 保存到栈，调 C++，恢复——全部汇编代码，没有 C++ wrapper

**OOPMap** (`macroAssembler_x86.cpp:1690`):
- 记录哪些寄存器/栈槽持有 OOP——GC safepoint 扫描的根
- [x86: OOPMap 是编译到代码中的元数据——不是在栈上动态生成。GC 扫描时通过 OOPMap 知道 "这个线程的 R12 存了一个 String 引用"。没有 OOPMap → GC 无法找到活对象 → 回收错误]

### 2. safepoint_poll + verified_entry

**safepoint_poll = 4 字节** (`macroAssembler_x86.cpp:4249`):
- `test [polling_page], rax` — 1 cycle 正常，PROT_NONE → SIGSEGV → safepoint
- [x86: test [mem], reg = 读 mem 但丢弃 reg 值 = 4B。cmp+jne = 7B。4B vs 7B 在每个方法头和 loop back edge 节省 3B * ~1000 个 check point = 节省 3KB——少一次 icache miss]

**verified_entry** (`macroAssembler_x86.cpp:3420`):
- check method/klass 一致性 + stack overflow guard
- [C++: verified_entry 是 JIT 方法的入口屏障——在方法的实际代码之前。如果 klass 指针改变 (redefine class) → 跳转到 runtime 重新解析。正常情况 1 cycle: cmp + jne (预测正确)]

**stack_bang** (`macroAssembler_x86.cpp:2090`):
- 写栈页 → 触发 page fault → OS 分配栈内存
- 防止无限递归用尽栈——在栈足够深之前提前触发栈扩展

### 3. OOP 压缩 — narrow_oop 编解码

**encode_heap_oop** (`macroAssembler_x86.cpp:2580`):
- `shrq $3, rax` → narrow_oop (32-bit)
- 为什么移 3 位？→ 堆中所有对象都是 8 字节对齐 (对象头后第一个字段)——低 3 位永远是 000
- [x86: shrq 3 = 逻辑右移 3 位——移除对齐位。shlq 3 = 左移 3 位——恢复对齐位。RISC CPU 用专门的 BITEXTRACT 指令]
- heap_base: 如果堆 >4GB，narrow_oop 是相对于 heap_base 的偏移——不是绝对地址

**decode_heap_oop** (`macroAssembler_x86.cpp:2620`):
- `shlq $3, rax; addq heap_base, rax` — 恢复为 64-bit raw pointer
- [x86: 三步解码——1) shlq 扩展 32→35-bit，2) addq 加堆基址，3) GC 验证指针在堆范围内。正常路径 2 条指令 = 4 cycles]

### 4. Math Intrinsics — fsin/fcos/fyl2x/f2xm1

**超越函数** (`macroAssembler_x86_sin.cpp:454`):
- sin/cos: fsin/fcos + fyl2x + f2xm1
- [x86: x87 80-bit extended precision — 为什么不用 SSE？→ SSE 只有 64-bit double，IEEE 754 要求 sine 误差 ≤1 ULP——64-bit 做不到。x87 内部 80-bit (64-bit mantissa) 才满足。代价: x87 需要 `fstp` (store 和 pop) 操作浮点栈——比 SSE 慢但精度够]
- log/exp: FYL2X (2为底对数) + F2XM1 (2^x-1) (`macroAssembler_x86_log.cpp:545`)

### 5. Crypto Intrinsics — AES-NI / SHA

**AES-NI 5 条指令** (`macroAssembler_x86_aes.cpp:174`):
- aesenc/aesenclast/aesdec/aesdeclast/aeskeygenassist
- [x86: AES-NI — 一条指令做一整轮 AES (SubBytes+ShiftRows+MixColumns+AddRoundKey)。vs C AES 库——10-14 轮 * 4 种操作 = 40-56 次 memory access (查 S-box 表)。AES-NI = 0 memory access → constant-time → 消除 cache timing side-channel]
- [x86: constant-time 密码——不依赖输入数据的执行路径。C 库的 AES (lookup table) 的 S-box 索引依赖密钥+明文→不同的 cache miss 组合→时序分析→密钥泄漏。AES-NI 指令固定 N cycles——不泄漏任何信息]

**SHA-NI** (`macroAssembler_x86_sha.cpp:198`):
- sha1rnds4/sha256rnds2 — 硬件 hash 轮

---

### 核心悬念

**"JVM 调 Math.sin() → 5 条 fsin 指令 → 完整结果——没有 JNI，没有解释器，没有分支。"** — MacroAssembler 让 Java 的 Math API 变成 100% 汇编。safepoint_poll = 4B 的协作点，AES = 0-branch 的硬件适配。这一切建立在 Assembler 的 400+ 条指令之上——给 C1/C2/StubRoutines 提供"建筑机器码的砖块"。

> → domain 3: [Arguments & Flags — 这些 JVM flag 怎么驱动 Assembler 的代码生成？UseSHA 打开后 C2 调用 StubRoutines::sha_impl()](../03-arguments-flags/01-flag-definition-system.md)
