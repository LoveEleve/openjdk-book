# 15 · 异常、反射、StackWalk 与运行时调用边界：专家答案锚点

## 1. 隐式异常是用一次硬件陷阱换掉每条指令的检查

编译代码不在每个字段/数组访问前先生成显式 null check，而是直接执行访问指令；当引用确实是 null 且访问位移落在第一个页面内时，CPU 触发 SIGSEGV，信号处理器再把这解读为 Java NPE。

`needs_explicit_null_check`（`share/asm/assembler.cpp:300`）判断访问位移是否仍在可隐式爆炸的范围内；如果位移太大，编译器必须改生成显式检查，因为那时 null+offset 不再必然 SIGSEGV。信号处理器按 `si_addr` 与 faulting pc 归属区分 STACK_OVERFLOW / IMPLICIT_NULL / IMPLICIT_DIVIDE_BY_ZERO（`os_cpu/linux_x86/os_linux_x86.cpp:358`），再交给 `SharedRuntime::continuation_for_implicit_exception`（`share/runtime/sharedRuntime.cpp:796`）决定解释器/编译代码/桩各自怎么继续。

nmethod 借助 `ImplicitExceptionTable` 把 PC 偏移翻译成 continuation PC（`share/code/nmethod.cpp:1986`）。

## 2. 显式异常是逐帧向外寻找入场资格

C2 在 doCall 阶段会把调用点的可匹配 catch 直接内联进编译代码，只有所有 handler 都不匹配时，才把异常交给运行时。逃逸的异常用 `RethrowNode`/`rethrow_C` 表达（`share/opto/runtime.cpp:1447`）：此时 callee 帧已移除，当前帧是 caller，所以把返回地址交给 `raw_exception_handler_for_return_address`（`share/runtime/sharedRuntime.cpp:454`）按归属分派。

exception blob（`cpu/x86/sharedRuntime_x86_64.cpp:3900`）是 C2 的通用异常分发器：保存/恢复 TLS 中的 exception oop/pc，调用 `handle_exception_C` 完成 handler 查找。查到就拿 handler 地址继续；查不到就回到方法级 rethrow 出口进入下一帧。如果 handler 所在 nmethod 在查找期间被 deopt，则改走 `unpack_with_exception`，保证语义从编译帧回落到解释器/反优化帧仍然成立。

## 3. 网关的可靠性来自“查表命中 → Java 异常；查不到 → 崩溃报告”

SIGSEGV 本身无法区分空指针与 VM 写崩。可靠性的边界在于：只有真正落在某个已知代码结构（解释器、nmethod、桩）中、且异常表有对应 continuation 的 fault，才被解读成 Java 异常；否则按真正崩溃走 hs_err。

这里要区分两张不同的表，不能混用：

- `ImplicitExceptionTable`（`share/code/nmethod.cpp:1986`）：把隐式异常的发生 PC 偏移翻译成 continuation PC。对隐式异常路径，`cont_offset == 0`（查不到）就返回 NULL，信号处理器据此走崩溃报告；
- `ExceptionCache`（`share/code/compiledMethod.hpp:43`）：显式异常查找 handler 的只读快路径。它允许假阴性——miss 时重新完整计算 handler，不会破坏正确性。

所以“查不到”既可以代表“真崩溃”（隐式异常的 continuation 表 miss），也可以代表“缓存 miss 后重新计算”（显式异常的 ExceptionCache miss）；关键区别是 fault 是否还落在某个可归属的代码结构内。

## 4. 反射的 JVM 侧并不“重造”调用器，而是复用 JavaCalls

`Method.invoke` 的 Java 侧入口最终走向 `JVM_InvokeMethod`（`share/prims/jvm.cpp:3571`），再进 `Reflection::invoke_method`（`share/runtime/reflection.cpp:1257`）与共享的 `invoke`（`:1072`）。

关键点是：

- `Method` 镜像保存 slot 编号，`invoke` 直接用 `method_with_idnum(slot)` 定位，不走名字/签名重新解析；
- 访问检查已经由 Java 侧 `Reflection.verifyAccess` 完成，JVM 侧不再重复判定权限；
- 参数按五段处理：方法解析、个数检查、拆箱/扩宽/打包、`JavaCalls::call`、`InvocationTargetException` 包装；
- 结果按对称规则 narrow/box 回 Java 侧。

因此反射并不是“另一套调用协议”，而是在 JavaCalls 之上做参数适配、语义包装和异常翻译的薄层。

## 5. `JVM_GetCallerClass` 依赖“跳过内部帧”的安全遍历

普通栈遍历会包含反射辅助帧、MethodAccessorImpl 和 LambdaForm。`security_next` 遍历在 `JVM_GetCallerClass`（`share/prims/jvm.cpp:706`）中跳过 `Method.invoke`（intrinsic `_invoke`）、`MethodAccessorImpl` 子类以及 MethodHandle 内部适配帧（`share/oops/method.cpp:1268` 的 `is_ignored_by_security_stack_walk`）。

同时它有严格的前置约束：frame 0 必须是 `_getCallerClass` intrinsic，frame 0/1 都必须带 `@CallerSensitive`，之后第一个未被忽略的帧的持有者类就是调用者。`@CallerSensitive` 信息在类文件解析时被收集（`share/classfile/classFileParser.cpp:2172`）。因此它返回的是“权限/安全语义真正关心的调用者”，而不是机器栈上的最近帧。

## 6. StackWalker 的双轨过滤来自“谁更能判断这一类帧”

`JVM_CallStackWalk`/`StackWalk::walk`（`share/prims/stackwalk.cpp:332`）先跳过 StackWalker 自身帧，再按模式决定是否跳过隐藏帧。HotSpot 侧的 `skip_hidden_frames` 只跳过 `is_hidden()`，即被 `@LambdaForm.Hidden` 标记的方法（`stackwalk.cpp:123`）；反射帧则交给 Java 侧 `StackStreamFactory` 按类名判断（`java.base/share/classes/java/lang/StackStreamFactory.java:249`）。

这样分工的原因是：LambdaForm 的内部方法可以通过字节码/注解元数据天然标记为 hidden，而反射辅助帧是普通 JDK 类方法，硬塞进 HotSpot 的 hidden 判定会破坏更广的语义。默认模式二者都过滤；`SHOW_HIDDEN_FRAMES` 则暴露 LambdaForm，但反射帧仍需由 Java 侧按需再控制。

## 7. 语义保鲜的支撑是“帧链可双向还原”

异常发生在解释器或编译代码中，栈遍历要能在解释器帧和编译帧之间往返：编译帧通过 `scope_desc_at` 还原回字节码层语义，解释器帧本身携带 bci/method，异常查找据此逐帧找 handler。反射调用则通过 `JavaCallArguments` 把对象参数以 Handle 形式打包，避免 GC 搬移后参数失去有效引用。

因此异常与反射并不是两条平行世界，而是共享同一条帧链和同一套“机器状态 → 字节码/语义状态”的还原协议。这也是 c2i/i2c adapter、deopt、StackWalker、`JVM_GetCallerClass` 能和异常处理协作而不互相破坏的根本原因。

## 评分锚点

- **合格**：能说清隐式异常、反射 invoke 五段、StackWalker 过滤的基本流程。
- **良好**：能区分“可挽救 Java 异常”与“崩溃报告”的边界，以及反射访问检查、参数打包、结果装箱各自在哪一侧。
- **专家级**：能用“机器帧可双向还原成语义帧”这一条主线，说明异常在解释/编译世界之间逐帧逃逸、反射复用 JavaCalls、StackWalker 双轨过滤这三件事为什么都成立。