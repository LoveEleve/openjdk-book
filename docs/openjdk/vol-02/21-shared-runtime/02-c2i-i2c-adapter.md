# 02. 从编译跳到解释——c2i/i2c Adapter

> **前置依赖**:[21-shared-runtime/01 — 编译代码遇到问题——向谁求助?— Runtime Stubs](openjdk/vol-02/21-shared-runtime/01-runtime-stubs.md):IC miss 桩与调用点修补,adapter 的"未验证入口"从这里兜底;[15-c2-compiler/02 — Parse + GraphKit: 字节码→Ideal Graph](openjdk/vol-02/15-c2-compiler/02-c2-parse-graphkit.md):`from_interpreted_entry`(i2c/i2i)是这里的姊妹字段;[16-code-cache/04 — 重定位与内联缓存](openjdk/vol-02/16-code-cache/04-relocation-ic.md):c2i 未验证入口做的 holder 检查就是 IC 语义
> → **后续**:[21-shared-runtime/03 — 编译代码里抛了异常: JVM 怎么找 handler?— 异常处理](openjdk/vol-02/21-shared-runtime/03-exception-handling.md)
> 关联域: 24-frame(栈帧布局)、08-interpreter(解释器帧)、16-code-cache(调用点修补)

## 两种世界的接缝

编译代码的参数在寄存器里(rdi/rsi/rdx/rcx/r8/r9 + xmm0-7),解释器要的参数在局部变量槽里;编译代码有 RBP 链,解释器有 sender_sp。同一台机器上两种代码互调,中间需要一段**接缝代码**——c2i(i2c)adapter: 编译→解释(i2c 反方向)。它们由 `generate_i2c2i_adapters`(sharedRuntime_x86_64.cpp:943)按方法签名一次性生成,`AdapterHandlerLibrary::new_entry` 返回带指纹(fingerprint)的三个入口(:991)。顺带纠正大纲四处: 函数叫 `gen_c2i_adapter`/`gen_i2c_adapter`(:585/:733)不是 `generate_*`;adapter 是 **frameless 的**——大纲"push rbp; mov rbp,rsp 建新帧"是错的(源码注释明说 adapter 无帧,理由正是它不能无限组合);"c2i adapter 需要 OopMap" 不存在(OopMap 只属于桩的 save_live_registers 与 native wrapper,adapter 纯汇编 repack 没有 GC 点);"c2i 200 条指令/i2c 40 条"无任何源码统计,删。

## 1. 三个入口一次生成

`generate_i2c2i_adapters`(sharedRuntime_x86_64.cpp:943)按顺序生成三段代码:

```cpp
// sharedRuntime_x86_64.cpp:949-991(截取核心,逐字)
  address i2c_entry = __ pc();

  gen_i2c_adapter(masm, total_args_passed, comp_args_on_stack, sig_bt, regs);

  // -------------------------------------------------------------------------
  // Generate a C2I adapter.  On entry we know rbx holds the Method* during calls
  // to the interpreter.  The args start out packed in the compiled layout.  They
  // need to be unpacked into the interpreter layout.  This will almost always
  // require some stack space.  We grow the current (compiled) stack, then repack
  // the args.  We  finally end in a jump to the generic interpreter entry point.
  // On exit from the interpreter, the interpreter will restore our SP (lest the
  // compiled code, which relys solely on SP and not RBP, get sick).

  address c2i_unverified_entry = __ pc();
  Label skip_fixup;
  Label ok;

  Register holder = rax;
  Register receiver = j_rarg0;
  Register temp = rbx;

  {
    __ load_klass(temp, receiver);
    __ cmpptr(temp, Address(holder, CompiledICHolder::holder_klass_offset()));
    __ movptr(rbx, Address(holder, CompiledICHolder::holder_metadata_offset()));
    __ jcc(Assembler::equal, ok);
    __ jump(RuntimeAddress(SharedRuntime::get_ic_miss_stub()));

    __ bind(ok);
    // Method might have been compiled since the call site was patched to
    // interpreted if that is the case treat it as a miss so we can get
    // the call site corrected.
    __ cmpptr(Address(rbx, in_bytes(Method::code_offset())), (int32_t)NULL_WORD);
    __ jcc(Assembler::equal, skip_fixup);
    __ jump(RuntimeAddress(SharedRuntime::get_ic_miss_stub()));
  }

  address c2i_entry = __ pc();

  gen_c2i_adapter(masm, total_args_passed, comp_args_on_stack, sig_bt, regs, skip_fixup);
```

**i2c_entry**(:949): 解释器→编译; **c2i_unverified_entry**(:962): 编译→解释,但先验证调用点——`rax` 里是 IC holder,检查 receiver 的 klass 与 holder_klass 是否匹配(:970-974,不匹配跳 IC miss 桩),再检查方法是否已编译(`Method::code_offset` 非空则跳 IC miss——注释 :978-979 "Method might have been compiled since the call site was patched to interpreted"——调用点该 patch 成编译调用)——**未验证入口就是 IC 语义的汇编落地点**(21-01 篇的 IC miss 链从这里进); **c2i_entry**(:986): 已验证入口,直接 gen_c2i_adapter。指纹(fingerprint)让同签名方法共享同一套 adapter。

## 2. Frameless 的接缝 — 帧是怎么"不建"的

大纲说"push rbp; mov rbp,rsp 建新帧"——源码注释恰好解释为什么 adapter 必须**无帧**:

```cpp
// sharedRuntime_x86_64.cpp:748-763(截取核心,逐字)
  // Adapters can be frameless because they do not require the caller
  // to perform additional cleanup work, such as correcting the stack pointer.
  // An i2c adapter is frameless because the *caller* frame, which is interpreted,
  // routinely repairs its own stack pointer (from interpreter_frame_last_sp),
  // even if a callee has modified the stack pointer.
  // A c2i adapter is frameless because the *callee* frame, which is interpreted,
  // routinely repairs its caller's stack pointer (from sender_sp, which is set
  // up via the senderSP register).
  // In other words, if *either* the caller or callee is interpreted, we can
  // get the stack pointer repaired after a call.
  // This is why c2i and i2c adapters cannot be indefinitely composed.
  // In particular, if a c2i adapter were to somehow call an i2c adapter,
  // both caller and callee would be compiled methods, and neither would
  // clean up the stack pointer changes performed by the two adapters.
  // If this happens, control eventually transfers back to the compiled
  // caller, but with an uncorrected stack, causing delayed havoc.
```

**栈指针修复的职责归解释器**: i2c 场景,解释器调用者用 `interpreter_frame_last_sp` 自修栈;c2i 场景,解释器被调者用 `sender_sp` 修调用者的栈。正因为"至少一端是解释器才能修栈",adapter **不能无限组合**——两个编译方法之间的适配若经由 adapter 就会栈错乱,这正是 `VerifyAdapterCalls`(:768-793)检查 "i2c adapter must return to an interpreter frame" 的原因。

c2i 的具体动作(gen_c2i_adapter,:585): 先 `patch_callers_callsite`(:596,注释 "Check for a compiled target. If there is one, we need to patch the caller's call"——若方法已有编译版本,把调用点 patch 成编译调用,下次不再走解释器);然后 `pop rax` 取返回地址、`mov r13, rsp` 设 senderSP、`subptr rsp, extraspace` 扩栈(extraspace = `total_args * stackElementSize + wordSize`,:606-614)、把参数按**解释器布局**重新铺进新空间(compiled layout → interpreter layout,:955-958 注释)、尾部 `movptr(rcx, Method::interpreter_entry_offset()); jmp(rcx)`(:716-717)——**直接跳解释器入口**,`rbx` 一路持有 Method*(:954 注释 "On entry we know rbx holds the Method*")。

i2c 更轻(gen_i2c_adapter,:733): 入口 `r13` 是 senderSP(:739 注释),保存原 SP 后 `andptr rsp, -16` 对齐编译代码要求的 16 字节(:816),`movptr(r11, Method::from_compiled_offset())` 取编译入口(:828)——**from_compiled_entry 是 15-c2/02 篇 from_interpreted_entry 的姊妹字段**(method.hpp:697/:709 相邻定义),然后按 VMRegPair 把解释器槽里的参数搬进寄存器,跳编译入口。

## 3. 参数搬运 — 寄存器约定到解释器槽

x86_64(非 Windows)调用约定在 `c_calling_convention`(sharedRuntime_x86_64.cpp:994): 前 6 个整型/引用参数进 `c_rarg0-5`(即 rdi/rsi/rdx/rcx/r8/r9,:1011-1013),浮点进 8 个 `c_farg0-7`(xmm0-7,:1014-1017),超出的走栈(每参数 2 个 VMReg 槽,:1040-1041)。**c2i 的输入是栈上的编译布局**(gen_c2i_adapter :603 注释 "Since all args are passed on the stack"——编译代码调解释器目标时参数已压栈,adapter 做的是栈内重排而非寄存器搬运);i2c 反向把解释器槽的值搬进 `c_rarg0-5`/`c_farg0-7` 与栈槽。64-bit JVM 的 interpreter slot 是 8 字节——**64-bit JVM 的 interpreter slot 是 8 字节**(`Interpreter::stackElementSize`,abstractInterpreter.hpp:236),long/double 占 1 个槽(寄存器里是 64 位,一次 `mov` 落地);int/float 也占 1 槽(零扩展/截断写)。大纲的"32-bit JVM long 占 2 slots"是另一套布局,本篇以 64-bit 源码为准不展开。

*关键设计: adapter 的存在让"编译↔解释互调"成为一条指令级别的最短路径——参数只做一次搬运,不经过任何运行时层;frameless 设计把栈修复责任推给解释器,换来"零帧开销";未验证入口把 IC 语义接到汇编层,调用点该转编译时立即转。这是 JIT 分层(08/13 域)能无缝运转的机械基础。*

## 核心悬念

编译↔解释的接缝封好了: **三个入口一次生成**(i2c_entry/c2i_unverified_entry(holder 检查+编译检查+IC miss 兜底)/c2i_entry)、**frameless 设计**(栈修复归解释器,adapter 不能无限组合——VerifyAdapterCalls 把关)、**参数一次搬运**(6 整型寄存器+8 XMM+栈,repack 成解释器槽)。但接缝只解决了"怎么跳过去"——跳过去之后,解释器或编译代码**抛出异常**时,handler 怎么找?异常表怎么查?编译代码的异常还要把"逃逸"的栈帧处理好。下一篇: 异常处理。

> → [21-shared-runtime/03 — 编译代码里抛了异常: JVM 怎么找 handler?— 异常处理](openjdk/vol-02/21-shared-runtime/03-exception-handling.md)
