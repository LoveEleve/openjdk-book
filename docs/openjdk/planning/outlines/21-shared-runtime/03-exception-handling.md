# 03. 编译代码里抛了异常——JVM 怎么找 handler？— 异常处理 + 辅助

> 🔴 Deep | 3 KP 中的异常链路 + 辅助设施
> 读者处境: 编译代码执行 `a.length`——a 是 null→SIGSEGV。signal handler 发现这是个 compiled frame 中的隐式 NPE→需要决定: 抛 NPE 让 caller 处理，还是可以从这里恢复？

### 1. "这条指令抛了什么异常？" — Implicit Exceptions
> ⚠️ 写作期修正(2026-08-15, vol-02/21-shared-runtime/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **enum ImplicitExceptionKind (sharedRuntime.hpp:188-192)** ✓ 行号对
> - **"continuation_for_implicit_exception (sharedRuntime.cpp:1600-1750)" 行号错**: 真实 **:796-965**;`continuation_for_implicit_exception` 声明 sharedRuntime.hpp:201-203 ✓
> - **"SIGSEGV handler 读 cr2 寄存器" 错**: Linux 用 `info->si_addr`(os_linux_x86.cpp:359);三路判据=SIGSEGV 栈区(yellow/reserved+_thread_in_Java)→SOE(:364-387)/SIGFPE FPE_INTDIV|FLTDIV(:447-454)→div0/SIGSEGV !needs_explicit_null_check(:482-486)→NPE
> - **"查 nul_chk_table[pc] → 没有 → vm_abort" 半对**: 查表在 `nmethod::continuation_for_implicit_exception`(nmethod.cpp:1986-2012,ImplicitExceptionTable 偏移对表,exceptionHandlerTable.hpp:132-138);查不到返回 **NULL→走正常崩溃报告**(非直接 vm_abort);表填充=C2 MachNullCheck(output.cpp:1658-1663)+C1 DivByZeroStub/ImplicitNullCheckStub(c1_CodeStubs_x86.cpp:148/:452),存 nmethod nul_chk_table 段(nmethod.cpp:745-746)
> - **STACK_OVERFLOW 编译路径不查表**: 直接 `StubRoutines::throw_StackOverflowError_entry`(:816-830);解释器路径返回 `Interpreter::throw_*_entry`(:807-812;入口生成 templateInterpreterGenerator.cpp:175-182,generate_exception_handler_common x86:142-173);**解释器显式检查也跳这些入口**(arraylength null_check templateTable_x86.cpp:4164-4168/ldiv testq :1416-1427)
> - **"两阶段: 设 reserved zone 3 页=12KB" 错**: reserved 区默认 **1 页**(globals_x86.hpp:57-69 red1/yellow2/reserved1/shadow20);两阶段真实机制=@ReservedStackAccess 逃生窗——信号 handler 找到 annotated 帧→disable reserved zone 守卫+设 reserved_stack_activation(os_linux_x86.cpp:366-381)→方法入口 reserved_stack_check(macroAssembler_x86.cpp:1094-1108)在 **rsp ≥ activation(回到逃生窗之上)时** enable+跳 delayed SOE 桩;SOE 构造绕开 Java 栈(throw_StackOverflowError_common :768-785)
> - **throw 桩统一骨架**: generate_throw_exception(stubGenerator_x86_64.cpp:5758-5832)→尾部 jump forward_exception_entry(:5830-5832,同文件 :494-550 调 exception_handler_for_return_address 寻路)
> - **实证**: -Xlog:exceptions=info 可用;NPE "thrown [sharedRuntime.cpp, line 606]" + "thrown in C1 compiled method" + "continuing at PC"(c1_Runtime1.cpp:608-611);SOE 同一 oop 沿栈逐帧传播 24395 帧(素材 21-exception-handling-demo.txt)

场景: 编译代码不显式做 null check——直接用 `mov rdi, [rsi+12]`(rsi=null→SIGSEGV)。signal handler 需要区分是"真正的 crash" 还是 "JVM 可以恢复的隐式异常"。

**三种 ImplicitExceptionKind** (`sharedRuntime.hpp:188-192`):
```cpp
enum ImplicitExceptionKind {
  IMPLICIT_NULL,              // 解引用 NULL→伪装成 NPE
  IMPLICIT_DIVIDE_BY_ZERO,   // idiv with 0→SIGFPE→伪装成 ArithmeticException
  STACK_OVERFLOW              // 栈撞 guard page→SIGSEGV→伪装成 StackOverflowError
};
```
- 源码: `sharedRuntime.hpp:188-192` enum
- 关键设计: 编译代码不生成显式 null check——节省 instructions。代替: 用 SIGSEGV handler 检测 faulting PC 是否对应一个 "implicit null check site"。nmethod 的 `nul_chk_table` 记录了 "哪些 PC 有隐式 null check" →handler 检查 faulting_pc 是否在表中→是→抛 NPE；否→真正的 crash→vm_abort

**continuation_for_implicit_exception** (`sharedRuntime.hpp:201-203`):
```
SIGSEGV handler → SharedRuntime::continuation_for_implicit_exception():
  case IMPLICIT_NULL:
    → 查 nmethod 的 nul_chk_table[pc] → 有 → throw_NullPointerException()
    → 没有 → 真正的 segfault → vm_abort
  case IMPLICIT_DIVIDE_BY_ZERO:
    → throw_ArithmeticException()
  case STACK_OVERFLOW:
    → 先试 reserved zone(throw_delayed_StackOverflowError → enable_stack_reserved_zone)
    → 如果 reserved zone 也溢出 → throw_StackOverflowError_common(delayed=false)
```
- 源码: `sharedRuntime.cpp:1600-1750` continuation_for_implicit_exception
- [x86: SIGSEGV handler 读 cr2 寄存器(出错的地址)——如果 cr2=0→很可能 NULL 解引用。读 faulting instruction 的 opcode——如果是 `mov` 且 src=cr2→验证是 null check。误判的风险: 真正的 null deref 也被当成 NPE——但 Java 语义中 "null.foo = X" 就是 NPE——所以语义正确不需要区分]

**Stack overflow 两阶段** (`sharedRuntime.hpp:198-200`):
```
Phase 1: throw_delayed_StackOverflowError()
  → 设 reserved zone(额外 3 页 = 12KB) → enable_stack_reserved_zone
  → 给线程一个"逃生窗"来 unwind 当前帧
Phase 2: throw_StackOverflowError()  
  → reserved zone 也碰撞了 → 无法恢复 → throw StackOverflowError
```
- 关键设计: 两阶段因为帧 unwind 本身需要栈空间(调 exception handler→建异常对象→copy stack trace→print)——如果初始栈已经溢出→unwind 过程再次溢出。reserved zone 给了 unwind 足够空间

### 2. "handler 在哪？" — exception_handler 查找链
> ⚠️ 写作期修正(2026-08-15, vol-02/21-shared-runtime/03 已按真实源码成文;第 3 轮 REVIEW 重大修正——**两代编译器的异常出口设计不同**):
> - **"raw_exception_handler_for_return_address (sharedRuntime.cpp:1400-1550)" 行号错**: 真实 **:454-515**;hpp:182-183 ✓。**功能描述错**: 它**不查异常表**——只按返回地址寻路(find_blob→is_deopt_pc→unpack_with_exception/exception_begin;returns_to_call_stub→catch_exception_entry;解释器→rethrow_exception_entry;查不到 ShouldNotReachHere,非"返回 NULL 交给 caller")
> - **C1 编译代码异常出口(第 3 轮补全)**: exception_begin(c1_LIRAssembler_x86.cpp:388-414)=直接 call Runtime1::handle_exception_from_callee_id(**不是 jump exception_blob**);c1_Runtime1::handle_exception(c1_Runtime1.cpp:496+): trace("thrown in C1 compiled method" :522-529)/缓存(:563)/compute(:587)/回填(:597-599)/"continuing at PC" 日志(:606-611);无 handler → unwind_handler_begin(展开出口: remove_frame+jump Runtime1::unwind_exception,c1_LIRAssembler_x86.cpp:415-478)
> - **C2 编译代码异常出口(第 3 轮补全,重要)**: ①调用点有 handler → **编译代码内联 catch**(doCall.cpp:836 catch_inline_exceptions: gen_subtype_check+CheckCastPP+merge_exception,:913-943)——异常不进任何运行时;②逐个 handler 不匹配/无 handler → make_runtime_call(rethrow_stub :965-971)或 throw_to_exit(parse1.cpp:906-930)→**方法级 RethrowNode**(parse1.cpp:883-895)→jmp rethrow_stub(x86_64.ad:12941-12955,enc_rethrow :2810);③**逐帧逃逸链**: rethrow_C(opto/runtime.cpp:1447-1466,callee 帧已移除)→raw_exception_handler→caller 编译→caller->exception_begin→**exception_blob**(sharedRuntime_x86_64.cpp:3900-4002,rax=oop/rdx=pc 由 TailJump popq rdx 准备,x86_64.ad:12914-12925;oop 经 TLS vm_result 回 rax,generateOptoStub pass_tls)→handle_exception_C(opto/runtime.cpp:1390-1423)→helper(:1269-1381,失败 trace 在 :1287-1292)→命中默认条目=方法级 rethrow 出口→**逐帧循环**
> - **查表三段(大纲"ExceptionCache→异常表"漏缓存)**: ①ExceptionCache 缓存(compiledMethod.cpp:137-150,16 槽/链,读不锁假阴性;实测 29 次逃逸 27 次缓存命中)②compute_compiled_exc_handler(:632-734)=ScopeDesc→Method::fast_exception_handler_bci_for(method.cpp:200-235 扫字节码四元组表+子类型检查)→ExceptionHandlerTable.entry_for(exceptionHandlerTable.cpp:110-120 按 catch_pco 子表+bci/scope_depth;子表由 CatchNode 生成 output.cpp:1652-1654,默认 handler 条目恒追加 doCall.cpp:759-761;无 handler 方法无 CatchNode,异常直接 throw_to_exit)③回填缓存(add_handler_for_exception_and_pc :152-166)
> - **"栈展开: pop compiled frame 逐帧" 表述错**: 内联多层是**虚拟帧展开**——sd->sd->sender() 沿 ScopeDesc 链上溯(:688-695),非物理 pop;C1 无 handler 时返回 unwind_handler_begin(:714-718)
> - **解释器接盘**: throw_exception_entry(templateInterpreterGenerator_x86.cpp:1519-1539)→InterpreterRuntime::exception_handler_for_exception(interpreterRuntime.cpp:470+)→handler 或 remove_activation_entry(注释 :1541-1543)
> - **raw_exception_handler 调用点**: rethrow_C(opto/runtime.cpp:1447-1466)+vframeArray.cpp:268+forward_exception_entry(汇编侧)
> - **实证(第 3 轮重大发现)**: ①"C2 编译代码异常无 'thrown in' 日志"之谜=内联 catch+rethrow 路径不打 trace(escape 场景只有解释器侧日志);②"thrown in C1 compiled method"=c1_Runtime1.cpp:522-529;"continuing at PC"=:608-611;③**"N [Exception (...)" = handle_exception_C 的 trace(OptoRuntime::trace_exception,opto/runtime.cpp:1672-1691),每条=异常穿过一个编译帧的 exception_blob——SOE 素材的 24395 条=递归编译帧数(原解读"逐帧传播记录"修正)**;④gdb 实证 C2EscapeDemo: rethrow_C 57/raw handler 命中/handle_exception_C 29 次(=29 次逃逸)/compute 只 2 次(缓存命中)——C2 逃逸链闭环
> - **悬念指向错(重要)**: "下一篇 域22 Deoptimization" 过期——deopt 重建已在 24-frame/03,写作顺序 21→**25-gc-framework/01**

场景: compiled 代码中出了异常→需要找 handler。handler 可能在: (a) 同一 nmethod 的事处理表。(b) caller 的 nmethod。(c) interpreter frame。

**exception_handler_for_return_address** (`sharedRuntime.hpp:182-183`):
```
raw_exception_handler_for_return_address(thread, return_address):
  1. CodeCache::find_nmethod(return_address) → nmethod*
  2. nmethod->handler_table_begin → 查表: bci在异常范围?→handler pc
  3. 找到 → return handler address
  4. 未找到 → return NULL(交给 caller 处理)
```
- 源码: `sharedRuntime.cpp:1400-1550` raw_exception_handler_for_return_address
- [C++: handler_table 是异常表编码——每个 entry: {start_bci, end_bci, handler_bci, catch_type}——but compiled to {start_pc, end_pc, handler_pc, catch_type_index}。运行时解引用 catch_type_index→oop table→Klass check→匹配→跳 handler pc]

**compute_compiled_exc_handler** (`sharedRuntime.hpp:186-187`):
```
compiled 帧中异常处理:
  1. 同上找 nmethod handler table
  2. 找到 → return handler address(在同一个 nmethod 中)
  3. 未找到 → 栈展开: pop compiled frame → 在 caller 的 frame 继续查
     - 如果 caller 是 compiled → 回到步骤1
     - 如果 caller 是 interpreted → interpreter 接管异常处理
```
- 关键设计: 栈展开的迭代——每一帧都独立处理。"一次性扫描所有帧"比"逐帧 pop"更安全但更慢——JVM 选逐帧因为异常路径本身就罕见

### 3. "打不过，找帮手" — monitor helpers + math support
> ⚠️ 写作期修正(2026-08-15, vol-02/21-shared-runtime/03 已按真实源码成文):
> - **monitor_enter_helper 声明 (sharedRuntime.hpp:340-341)** ✓;实现 **sharedRuntime.cpp:2035-2064**: 先 quick_enter(:2040,非 safepoint 同步中)→UseBiasedLocking 时 fast_enter 否则 slow_enter;exit :2071-2082("Exit must be non-blocking...no exceptions can be thrown");**synchronizer.cpp 行号错**: fast_enter :264/slow_enter :339(大纲 80-240);调用方=C2 complete_monitor_locking_Java(macro.cpp:2465-2466)/C1 c1_Runtime1.cpp:702
> - **math 归属错(重要)**: dsin/dcos/dtan 在 **sharedRuntimeTrig.cpp:760/818/875**,dlog/dexp/dpow 在 sharedRuntimeTrans.cpp:165/233/369/658(大纲"sharedRuntimeTrans.cpp:50-400 dsin 泰勒级数"双错);**不是 Intel libm fork——fdlibm 的拷贝**(文件头注释 :30-37: Intel CPU 不满足 Java sin/cos 规范+绕过 libjava.so 间接调用快 ~15%);桩生成条件 supports_sse2&&UseLibmIntrinsic&&InlineIntrinsics(stubGenerator_x86_64.cpp:5959-5967 generate_libmSin 等);montgomery_multiply 在 sharedRuntime_x86_64.cpp:3811
> - 悬念方向见 §2 ⚠️(→ 25-gc-framework/01)

场景: 编译代码可以 inline 轻量锁(fast_enter cmpxchg)——但遇到 inflation 或 biased lock revoke 需要走 VM 慢路径。

**monitor_enter_helper** (`sharedRuntime.hpp:340-341`):
```
编译代码:
  cmpxchg → 成功 → return (fast path, ~20 cycles)
  cmpxchg → 失败 → call monitor_enter_helper(obj, lock, thread)
    → ObjectSynchronizer::fast_enter(处理 biased/BasicLock 升级)
    → ObjectSynchronizer::slow_enter(ObjectMonitor enter)
```
- 源码: `sharedRuntime.hpp:340-341` + `synchronizer.cpp:80-240` fast_enter/slow_enter
- 关键设计: monitor 入口是编译代码生成的——不是 SharedRuntime 独有的。SharedRuntime 只是提供了"慢路径进入 VM"的统一 wrapper

**Math transcendental 函数** (`sharedRuntime.hpp:137-143` + `sharedRuntimeTrans.cpp` + `sharedRuntimeTrig.cpp`):
```
dsin/dcos/dtan/dlog/dexp/dpow — 软件实现(当 CPU 无指令时)
f2i/d2l — IEEE 754 舍入模式设置后转换
montgomery_multiply — RSA crypto openSSL alternative
```
- 源码: `sharedRuntimeTrans.cpp:50-400` dsin 实现(泰勒级数)
- 关键设计: 这些是 Intel libm 的 fork——保留了精度但不依赖外部库。除零和 NaN 处理与 IEEE 754 一致

---

### 核心悬念

**"SharedRuntime 的异常处理通过 continuation_for_implicit_exception 区分隐式异常和真 crash——stack overflow 分两阶段(unwind 有逃生窗)。exception_handler 通过 nmethod 异常表查找 handler→未找到→逐帧展开。"** — 下一篇: 域25 GC Framework(写作顺序 21→25;deopt 重建已在 24-frame/03)。

> → 域25 GC Framework(planning/outlines/25-gc-framework/)
