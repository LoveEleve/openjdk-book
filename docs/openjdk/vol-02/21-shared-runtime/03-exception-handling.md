# 03. 编译代码里抛了异常——JVM 怎么找 handler?— 异常处理

> **前置依赖**:[21-shared-runtime/01 — 编译代码遇到问题——向谁求助?— Runtime Stubs](openjdk/vol-02/21-shared-runtime/01-runtime-stubs.md):IC miss/resolve/deopt 桩网络是这篇"求助电话"的另一半,`unpack_with_exception` 变体在异常处理里反复出现;[23-stub/01 — JVM 启动时预生成哪些汇编例程?— StubRoutines 全局桩](openjdk/vol-02/23-stub/01-stub-entry.md):`generate_throw_exception` 生成的 throw stub 家族是 StubRoutines 的成员;[21-shared-runtime/02 — 从编译跳到解释: c2i/i2c Adapter](openjdk/vol-02/21-shared-runtime/02-c2i-i2c-adapter.md):异常穿越编译↔解释接缝的落点;[24-frame/03 — deopt 怎么从编译帧重建解释器帧?— Deopt 重建 + GC 扫描](openjdk/vol-02/24-frame/03-deopt-gc-scan.md):异常处理中"帧被丢弃"与 deopt 重建同源的 RegisterMap;[19-sync/01 — synchronized 三步曲](openjdk/vol-02/19-sync/01-lock-hierarchy.md):monitor helper 的被调方
> → **后续**:[25-gc-framework/01 — GC 怎么在每次 oop 访问时悄悄插入 barrier?— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md)
> 关联域: 24-frame(帧展开)、08-interpreter(解释器异常分派)、16-code-cache(nmethod 异常表)、15-c2(编译代码的异常节点)

## 编译代码里的一行空指针

```java
int len = a.length;   // a 是 null
```

解释器会先判空再取字段——`arraylength` 模板带显式 null 检查。编译代码(特别是 C2)不做这件事:它直接把 `a` 的引用放进寄存器,生成一条形如 `movl r10d, [rsi+12]` 的指令——`rsi` 是 null,这条指令在执行时**物理崩溃**:CPU 抛 SIGSEGV。

问题就来了:信号处理器怎么知道这个 SIGSEGV 是"JVM 可以挽救的 Java 空指针",而不是"VM 自己写崩了"?这就是本篇文章的主题:**编译代码的异常从发生到被 handler 接住,穿过信号处理器、异常表、以及一整套"继续执行"的机械装置**。上一篇封好了编译↔解释的调用接缝,本篇封好"出错"的通道。

## 1. 隐式异常 — 把 SIGSEGV 翻译成 NPE

**三种可恢复的"硬件陷阱"**(`sharedRuntime.hpp:188-192`):

```cpp
// sharedRuntime.hpp:188-192(截取核心,逐字)
  enum ImplicitExceptionKind {
    IMPLICIT_NULL,
    IMPLICIT_DIVIDE_BY_ZERO,
    STACK_OVERFLOW
  };
```

*关键设计: 编译代码不生成显式 null check——省下每条指令的检查代价;代替它的是 SIGSEGV handler 的一次查表。前提是访问位移必须落在**第一个页内**(`0 ≤ offset < 页大小` 才可能隐式,`MacroAssembler::needs_explicit_null_check`,assembler.cpp:300-314: null+offset 才必然 SIGSEGV;窄 oop 时 offset 还要按 heap base 归一化),位移超出则编译器插显式检查。隐式区内的 null 解引用必崩,崩了由信号系统接管。*

### 信号处理器三路分派

x86_64 的 SIGSEGV/SIGBUS/SIGFPE 处理器主入口在 `os_linux_x86.cpp`(18-02 篇的轮询页 SIGSEGV 也在这里分派):

```cpp
// os_linux_x86.cpp:358-392(截取核心,逐字)
    if (sig == SIGSEGV) {
      address addr = (address) info->si_addr;
      // check if fault address is within thread stack
      if (thread->on_local_stack(addr)) {
        // stack overflow
        if (thread->in_stack_yellow_reserved_zone(addr)) {
          if (thread->thread_state() == _thread_in_Java) {
            ...
            // Throw a stack overflow exception.  Guard pages will be reenabled
            // while unwinding the stack.
            thread->disable_stack_yellow_reserved_zone();
            stub = SharedRuntime::continuation_for_implicit_exception(thread, pc, SharedRuntime::STACK_OVERFLOW);
          } else {
            // Thread was in the vm or native code.  Return and try to finish.
            thread->disable_stack_yellow_reserved_zone();
            return 1;
          }
```

三个判据(全部基于 `info->si_addr`——**Linux 把出错地址放在 siginfo 里,不是读 cr2 寄存器**):

| 信号 | 判据 | 隐式异常种类 |
|---|---|---|
| SIGSEGV | `thread->on_local_stack(addr)` 且落在 yellow/reserved zone,且 `_thread_in_Java` | `STACK_OVERFLOW`(os_linux_x86.cpp:364-387) |
| SIGFPE | `si_code == FPE_INTDIV \|\| si_code == FPE_FLTDIV` | `IMPLICIT_DIVIDE_BY_ZERO`(AMD64 分支 :447-454) |
| SIGSEGV | `!MacroAssembler::needs_explicit_null_check(addr)` | `IMPLICIT_NULL`(:482-486) |

### continuation_for_implicit_exception — 给一个"继续点"

`SharedRuntime::continuation_for_implicit_exception`(sharedRuntime.cpp:796-965)按 faulting pc 的归属地给答案:

- **解释器代码**(`Interpreter::contains(pc)`): 返回 `Interpreter::throw_NullPointerException_entry` 等入口(:807-812)——解释器的异常入口在模板生成期就备好了(templateInterpreterGenerator.cpp:175-182,`generate_exception_handler_common` x86 层 :142-173: 建异常对象→jump `throw_exception_entry`;共享层包装 templateInterpreterGenerator.hpp:46-48)。**解释器的显式检查也跳这些入口**: `arraylength` 模板先 `null_check`(templateTable_x86.cpp:4164-4168),ldiv/lrem 模板先 `testq`+jump(:1416-1427,"generate explicit div0 check")——解释器宁可显式检查也不等信号。
- **编译代码**(重点):

```cpp
// sharedRuntime.cpp:816-830(截取核心,逐字)
      case STACK_OVERFLOW: {
        // Stack overflow only occurs upon frame setup; the callee is
        // going to be unwound. Dispatch to a shared runtime stub
        // which will cause the StackOverflowError to be fabricated
        // and processed.
        ...
        assert(thread->deopt_mark() == NULL, "no stack overflow from deopt blob/uncommon trap");
        Events::log_exception(thread, "StackOverflowError at " INTPTR_FORMAT, p2i(pc));
        return StubRoutines::throw_StackOverflowError_entry();
      }
```

- `STACK_OVERFLOW` → 直接 `throw_StackOverflowError_entry` stub(不查表——栈撞穿就必然是 SOE);
- `IMPLICIT_NULL` → 按 faulting pc 的归属细分(:832-918): ①vtable stub 里(`VtableStubs::contains`)→ 未进 callee 帧,`throw_NullPointerException_at_call_entry`(abstract method 则回 wrong_method 再 resolve);②adapter 类 blob(非编译,`is_adapter_blob`/`is_method_handles_adapter_blob`)→ at_call,其他非编译 blob 返回 NULL 走崩溃报告;③IC check 代码(`inlinecache_check_contains`)→ 未激活帧同 at_call;④MH 适配器 → at_call;**⑤普通 nmethod → `nm->continuation_for_implicit_exception(pc)`**(:908);
- `IMPLICIT_DIVIDE_BY_ZERO` → 同样查 nmethod 表(:921-940)。

### nmethod 的隐式异常表

`nmethod::continuation_for_implicit_exception`(nmethod.cpp:1986-2012):

```cpp
// nmethod.cpp:1986-2012(截取核心,逐字)
address nmethod::continuation_for_implicit_exception(address pc) {
  // Exception happened outside inline-cache check code => we are inside
  // an active nmethod => use cpc to determine a return address
  int exception_offset = pc - code_begin();
  int cont_offset = ImplicitExceptionTable(this).at( exception_offset );
  ...
  if (cont_offset == 0) {
    // Let the normal error handling report the exception
    return NULL;
  }
  return code_begin() + cont_offset;
}
```

`ImplicitExceptionTable` 是**PC 偏移对表**(exceptionHandlerTable.hpp:132-138 注释):"Maps an exception PC offset to a continuation PC offset...pairs of <excp-offset, const-offset>"。**查不到(cont_offset==0)就返回 NULL——信号处理器据此走正常崩溃报告**(hs_err),而不是 Java 异常——这就是"真 crash 与隐式异常"的界线。表由编译器生成时填充:C2 在发码阶段收集 `MachNullCheck` 节点(output.cpp:1658-1663 `_inc_table.append(...)`),C1 的 `DivByZeroStub`/`ImplicitNullCheckStub` 在 emit_code 时记录(c1_CodeStubs_x86.cpp:148/:452),最终作为 nmethod 的 `nul_chk_table` 段存进 CodeCache(nmethod.cpp:745-746)。

### 栈溢出: 一条 bang 链 + 两阶段救援

Java 线程栈顶往下依次是 **red/yellow/reserved/shadow** 四区(thread.hpp:1550-1593 的布局图;x86 默认 1/2/1/20 页,globals_x86.hpp:57-69)。编译方法入口用 `bang_stack_size`(macroAssembler_x86.cpp:1069-1092)**一页一页往下写**,栈快耗尽时这一写就撞进 yellow/reserved 区 → SIGSEGV → 上面看到的 STACK_OVERFLOW 分派。两个逃生设计:

1. **@ReservedStackAccess 逃生窗**:栈撞进保留区时,信号处理器若找到栈上带 `@ReservedStackAccess` 注解的方法,就 **disable reserved zone 的守卫页**(把保留页变成可用栈空间)并把它设为 `reserved_stack_activation`(os_linux_x86.cpp:366-381)。每个方法入口的 `reserved_stack_check`(macroAssembler_x86.cpp:1094-1108)检查 `rsp` 与 `reserved_stack_activation`:**`rsp` 已回到逃生窗之上**(annotated 方法返回、栈不再需要保留)时,`enable_stack_reserved_zone` 恢复守卫,再跳 `throw_delayed_StackOverflowError_entry` 桩——异常消息标记为 delayed(sharedRuntime.cpp:764-766)。
2. **SOE 构造绕开 Java 栈**:`throw_StackOverflowError_common`(sharedRuntime.cpp:768-785)不用正常异常构造(注释 "we avoid using the normal exception construction in this case because it performs an upcall to Java, and we're already out of stack space")——直接 `allocate_instance`+`fill_in_stack_trace`。

这些 throw 桩都是 `generate_throw_exception`(stubGenerator_x86_64.cpp:5758-5832)生成的统一骨架: enter 建栈帧 → `set_last_Java_frame` → 调 runtime(如 `SharedRuntime::throw_NullPointerException`)→ OopMap → 尾部 jump `forward_exception_entry`(:5830-5832)——这个桩(同文件 :494-550)把返回地址当 throwing pc,`call_VM_leaf exception_handler_for_return_address`(raw 实现的 JRT_LEAF 包装,sharedRuntime.cpp:518-520)寻路,取回 pending exception 后 jmp 到 handler。同骨架的还有 AbstractMethodError/IncompatibleClassChangeError/NullPointerException at call(stubGenerator_x86_64.cpp:5977-5993)。

**[实证](materials/commands/21-exception-handling-demo.txt)**: `-Xlog:exceptions=info`(LogTarget 真实存在于 sharedRuntime.cpp:1287)直接看见整条链——NPE 由 `sharedRuntime.cpp:606`(throw_and_post_jvmti_exception → Exceptions::_throw)构造,标注 "thrown in C1 compiled method" + 固定 throwing PC;随后 "continuing at PC ... for exception thrown at PC ..." 就是 continuation 落地。除零同构(SIGFPE 路径),栈溢出场景里**同一个 SOE oop 沿栈逐帧传播**(素材 E 段,24395 帧同地址)。

## 2. 显式异常 — handler 查找链

信号路径处理"硬件陷阱";`athrow`/异常传播走另一条: **编译代码的异常入口 → C++ 查表 → 跳 handler 或展开帧**。

### 编译代码的异常入口: exception_blob

C2 发码时给每个方法生成异常处理入口 `HandlerImpl::emit_exception_handler`(x86.ad:1318-1333,offset 记入 `CodeOffsets::Exceptions`,output.cpp:1535)——就一条 `jump OptoRuntime::exception_blob()->entry_point()`。`generate_exception_blob`(sharedRuntime_x86_64.cpp:3900-4002)是**通用异常分发器**,注释写明协议:

```cpp
// sharedRuntime_x86_64.cpp:3885-3894(截取核心,逐字)
// This code is entered with a jmp.
// Arguments:
//   rax: exception oop
//   rdx: exception pc
// Results:
//   rax: exception oop
//   rdx: exception pc in caller or ???
//   destination: exception handler of caller
```

内部: 存 `Thread::exception_oop/exception_pc`(因 C++ 调用帧尺寸不定,不能传参)→ `call OptoRuntime::handle_exception_C`(:3949)→ 恢复 rbp/rsp → 从 TLS 取回 oop/pc → `jmp r8`(handler 地址,可能是 deopt blob)。

### 查表: 缓存 → ScopeDesc → 字节码异常表 → 编译异常表

`handle_exception_C` 入口无 JRT 包装(opto/runtime.cpp:1390-1423,注释 "We are entering here from exception_blob...Note we enter without the usual JRT wrapper"),内部调 `handle_exception_C_helper`(:1269-1381)完成查找,出 VM 后**还要复查**: 若 handler 所在 nmethod 在查找期间被 deopt(`caller.is_deoptimized_frame()`),改走 `unpack_with_exception`(:1412-1421)。查找本身三段:

1. **缓存优先**:`nm->handler_for_exception_and_pc(exception, pc)`(compiledMethod.cpp:137-150)——nmethod 挂 `ExceptionCache` 链(compiledMethod.hpp:43-75,每缓存 16 槽 `<exception_type, pc[], handler[]>`;读不锁,只允许假阴性:"it can only happen during the first few exception lookups")。
2. **未中 → `compute_compiled_exc_handler`**(sharedRuntime.cpp:632-734)。它先经 `nm->scope_desc_at(ret_pc)` 拿到抛出点的 ScopeDesc(24-frame/02 的虚拟帧),在**字节码层**找 handler bci:

```cpp
// sharedRuntime.cpp:658-696(截取核心,逐字)
  if (!force_unwind) {
    int bci = sd->bci();
    ...
      handler_bci = Method::fast_exception_handler_bci_for(mh, ek, bci, THREAD);
    ...
      if (!top_frame_only && handler_bci < 0 && !skip_scope_increment) {
        sd = sd->sender();
        if (sd != NULL) {
          bci = sd->bci();
        }
        ++scope_depth;
      }
```

`fast_exception_handler_bci_for`(method.cpp:200-235)扫**字节码异常表**(四元组 `(beg_bci, end_bci, handler_bci, klass_index)`,method.hpp:1138+)——范围覆盖 + catch 类型 `is_subtype_of` 检查。**内联多层的妙处**: 同一物理帧里,异常沿 `ScopeDesc::sender()` 一层层往上找——"逐帧展开"其实是虚拟帧展开。

3. **查编译异常表拿 PC**:`ExceptionHandlerTable table(nm)` + `entry_for(catch_pco, handler_bci, scope_depth)`(exceptionHandlerTable.cpp:110-120)——布局是**子表**: 每条 catch 点(调用返回偏移)一个表头,表内条目 `(handler_bci, scope_depth) → pco`(output.cpp:1652-1654 由 CatchNode 生成)。命中 → `nm->code_begin() + t->pco()`。C1 还有两个特例: 允许"简表"(abbreviated catch tables,sharedRuntime.cpp:703-711,同步方法内联需要的合成 handler);真查不到返回 `unwind_handler_begin`(:714-718)——**没有 Java handler 也有"展开出口"**,恢复 callee-saved 后把异常推给上一帧。
4. **回填缓存**:`add_handler_for_exception_and_pc`(compiledMethod.cpp:152-166,ExceptionCache_lock 保护;C1 侧 c1_Runtime1.cpp:592-599)。

### 解释器接盘

异常逃出编译帧后,若 caller 是解释器帧,由解释器的统一入口接: `throw_exception_entry`(templateInterpreterGenerator_x86.cpp:1519-1539)清空表达式栈 → `call_VM InterpreterRuntime::exception_handler_for_exception`(interpreterRuntime.cpp:470+)→ 返回 handler 地址或 `remove_activation_entry`(本帧无 handler,pop 帧并 rethrow,注释 :1541-1543)。`raw_exception_handler_for_return_address`(sharedRuntime.cpp:454-515)是**返回点寻路器**: 返回地址在编译方法 → deopt pc 就进 `unpack_with_exception`,否则回 `nm->exception_begin`;返回地址在调用桩 → `catch_exception_entry`;在解释器 → `rethrow_exception_entry`。它有两处 C++ 调用点——C2 的 RethrowNode 尾部 `rethrow_C`(opto/runtime.cpp:1447-1466,汇编展开帧后把返回地址交它寻路)与 deopt 重建(vframeArray.cpp:268);汇编侧 `forward_exception_entry`(§1)也调它——异常穿越三层代码形态只靠这一个函数。

**[实证](materials/commands/21-exception-handling-demo.txt)**: 编译代码 try-catch(素材 B 段)——throwing PC 恒定、handler PC 与抛点仅 16 字节(异常表查找落地;throwing PC 恒定是异常表与内联结果稳定的证据);跨帧逃逸(素材 D 段)——escape 被编译后,异常在编译代码抛出,解释器 escapeMain 在 invoke 处 bci 8 重新分派并接住,日志 "thrown in interpreter method ... at bci 8" 是 InterpreterRuntime 的 trace(interpreterRuntime.cpp:525 起)。

## 3. 辅助设施 — monitor 慢路径与数学库

21 域剩余的两个"编译代码后援"也住在 SharedRuntime:

**monitor_enter_helper**(sharedRuntime.cpp:2035-2064): 编译代码的锁慢路径——C2 的锁展开经 `OptoRuntime::complete_monitor_locking_Java`(= `complete_monitor_locking_C` :2067,macro.cpp:2465-2466)调它;C1 的 monitorenter 桩直接调 helper(c1_Runtime1.cpp:702,14-c1/04 篇)。顺序: 非 safepoint 同步中先试 `quick_enter`(最快)→ `UseBiasedLocking` 时 `fast_enter`(偏置重试)→ 否则 `slow_enter`——**三档递进与 19-sync 的三步曲同源**;退出侧 `monitor_exit_helper`(:2071-2082,注释 "Exit must be non-blocking, and therefore no exceptions can be thrown")。

**超越函数**(sharedRuntimeTrans.cpp/Trig.cpp): `dsin/dcos/dtan`(Trig:760/818/875)、`dlog/dlog10/dexp/dpow`(Trans:165/233/369/658)。文件头注释讲清了为什么放 JVM 里(:30-37): "This file contains copies of the fdlibm routines used by StrictMath...the Intel CPU doesn't meet the Java specification for sin/cos outside a certain limited argument range...avoiding the indirect call through function pointer out to libjava.so in SharedRuntime speeds these routines up by roughly 15%"——**fdlibm 的拷贝,不是 Intel libm**;x86 上 `supports_sse2 && UseLibmIntrinsic && InlineIntrinsics` 时用 `generate_libmSin` 等生成桩(stubGenerator_x86_64.cpp:5959-5967),C2 的 `runtime_math` intrinsic(15-c2/08 篇)优先调这些桩。另有一个 RSA 加速件 `montgomery_multiply`(sharedRuntime_x86_64.cpp:3811)。

## 核心悬念

异常这条通道封好了: **隐式异常**(SIGSEGV/SIGFPE → `continuation_for_implicit_exception` → nmethod 隐式异常表 → 继续点)、**显式异常**(exception_blob → 缓存/字节码表/编译异常表 → handler 或展开)、**栈溢出两阶段**(bang 链 + reserved 逃生窗)。但全文反复出现两个"幽灵": 异常 oop 挂在 `Thread` 上经过 GC 才安全(`Handle`/`oop` 与 TLS 之间的来回),异常对象与栈上值在被扫描时都需要知道**哪些位置是引用**——这正是 GC 每次读写的屏障和堆对象分配要回答的问题。下一篇进入 GC Framework。

> → [25-gc-framework/01 — GC 怎么在每次 oop 访问时悄悄插入 barrier?— BarrierSet + Access API](openjdk/vol-02/25-gc-framework/01-barrier-access.md)
