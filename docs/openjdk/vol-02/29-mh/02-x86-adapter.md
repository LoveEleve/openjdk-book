# 02. ricochet frame 怎么传参数？— x86 Adapter Stubs

> **前置依赖**:[29-mh/01 — invokeExact 怎么做到 50x faster than reflection？— MH invoke 链路](openjdk/vol-02/29-mh/01-invoke-chain.md):链接器链(签名多态入口/jump_to_lambda_form/MemberName→Method*)已拆;[21-shared-runtime/02 — 从编译跳到解释——c2i/i2c Adapter](openjdk/vol-02/21-shared-runtime/02-c2i-i2c-adapter.md):调用约定适配的对照先例;[28-jvmti/01 — JVMTI Agent 怎么工作？— Agent 架构与事件系统](openjdk/vol-02/28-jvmti/01-agent-architecture.md):interp_only_mode(单步/方法事件强制解释执行)已讲
> → **后续**:[33-jmx/01 — JConsole 怎么知道 Eden 用了多少？— MemoryService + MemoryPool](openjdk/vol-02/33-jmx/01-memory-service.md)
> 关联域: 29-mh(调用链)、21-shared-runtime(adapter 对照)、28-jvmti(interp_only)

## 标题问的是 JDK8 的问题

"ricochet frame 怎么传参数"是 JDK 8 时代的问法——JDK 11 的答案是 **"不需要传"**。[实证](materials/commands/29-mh-adapter-demo.txt)(素材 A): 在 jdk11u 源码里 `grep -c ricochet` **hotspot 侧 methodHandles.cpp/hpp 与 x86 汇编全部零命中**,Java 侧 java.lang.invoke 也零命中。大纲描述的"ricochet frame 结构 + argument shuffling(methodHandles_x86.cpp:40-500)"是 JDK8 的手写汇编 adapter,JDK11 已整体移除。本篇拆 JDK11 的真实答案: **链接器层零搬运**(§1: 调用约定共享,参数根本不用重排)、**Java 层 LF 变换**(§2: asType/permute 等用 LambdaFormEditor 编辑生成的小方法)、**设计演进**(§3: 为什么汇编 adapter 被字节码取代)。

## 1. 链接器层 — 参数零搬运,只有一次跳转

29-01 的链接器链最后一步是 `jump_from_method_handle`(methodHandles_x86.cpp:120-155),它回答了"参数怎么摆":

```cpp
// methodHandles_x86.cpp:120-155(截取核心,逐字)
void MethodHandles::jump_from_method_handle(MacroAssembler* _masm, Register method, Register temp,
                                            bool for_compiler_entry) {
  assert(method == rbx, "interpreter calling convention");

   Label L_no_such_method;
   __ testptr(rbx, rbx);
   __ jcc(Assembler::zero, L_no_such_method);

  __ verify_method_ptr(method);

  if (!for_compiler_entry && JvmtiExport::can_post_interpreter_events()) {
    Label run_compiled_code;
    // JVMTI events, such as single-stepping, are implemented partly by avoiding running
    // compiled code in threads for which the event is enabled.  Check here for
    // interp_only_mode if these events CAN be enabled.
    ...
    __ cmpb(Address(rthread, JavaThread::interp_only_mode_offset()), 0);
    __ jccb(Assembler::zero, run_compiled_code);
    __ jmp(Address(method, Method::interpreter_entry_offset()));
    __ BIND(run_compiled_code);
  }

  const ByteSize entry_offset = for_compiler_entry ? Method::from_compiled_offset() :
                                                     Method::from_interpreted_offset();
  __ jmp(Address(method, entry_offset));

  __ bind(L_no_such_method);
  __ jump(RuntimeAddress(StubRoutines::throw_AbstractMethodError_entry()));
}
```

三个要点:

1. **参数不摆**——链接器不搬运任何参数: 调用点与目标方法**共享同一调用约定**(解释器槽/寄存器布局一致),找到 Method* 后直接 `jmp [Method::from_compiled/from_interpreted_offset]`(:149-151)跳进目标入口,参数原地就是目标期望的布局。这与 21-02 的 c2i/i2c adapter 形成对照: **c2i/i2c 是两种调用约定之间的搬运(解释器栈槽 ↔ 寄存器),而 MH 链接器路径两端约定相同,无需 adapter**;
2. **interp_only 检查**(:130-147)——28-01 §4 的机制在此落地: JVMTI 单步/方法事件可能启用时(`can_post_interpreter_events`),检查线程的 `interp_only_mode`,非零则 `jmp [interpreter_entry]` 强制走解释器——MH 调用同样遵守"方法级事件线程只跑解释器"的铁律;
3. **空 Method\* → throw_AbstractMethodError 桩**(:153-154)——链接失败的兜底。

*关键设计: "零搬运"不是偷懒,是调用约定统一的红利。解释器入口和编译代码入口都从"调用点约定"读取参数(MH 调用点传的就是这些参数),链接器只需把 Method\* 换成目标方法即可。JDK8 需要 ricochet frame 是因为它的 adapter 链要在每次 hop 之间重排参数;JDK11 把"重排"挪到了 Java 侧(§2),链接器只剩跳转。*

## 2. Java 侧 adapter — 参数变换是编辑 LambdaForm

大纲的 "adapter 类型: asType/permuteArguments/asCollector/asSpreader/guardWithTest/filterReturn" 名单没错,但实现不是"每个 adapter 在 x86 stub 中有对应的 hand-written assembly"——它们全是 **Java API + LambdaFormEditor 编辑 LF**:

- **asType**(MethodHandle.java:836-852): 三级路径——`newType == type` 直接返回 this(fast path)→ `asTypeCache` 记忆化(同类型转换缓存,`asTypeCached` :847-852)→ `asTypeUncached`(:851-855)→ `MethodHandleImpl.makePairwiseConvert`(:250-255)→ `makePairwiseConvertByEditor`(:266+): `computeValueConversions` **逐参数计算转换**,每个转换绑定成一个 filter(如 int→long 的扩宽、引用转型的 CheckCast);
- **参数重排/展开/收集**(LambdaFormEditor.java:45 起的变换工厂): `permuteArgumentsForm`(:848)/`spreadArgumentsForm`(:510)/`collectArgumentsForm`(:555)/`filterArgumentForm`(:627)——**编辑 LF 的 names 数组**(变换"参数怎么流动"),不是生成新汇编;
- **guardWithTest**(MethodHandleImpl.java:768,`makeGuardWithTestForm` :947): 测试/真/假三个分支的 LF 变换。

这些变换 LF 就是 29-01 讲过的普通小方法: `vmentry` 懒准备 → InvokerBytecodeGenerator 编成字节码 → CodeCache → **C2 当普通方法内联**。所以 asType 之后的 MH 调用,其"类型转换逻辑"在编译后变成内联的几条指令(扩宽/转型)——机制与 29-01 的常量折叠同源(实证未单独测 asType 场景,不套用 1.11 倍数字)。

## 3. 设计演进 — 为什么汇编 adapter 被字节码取代

JDK8 的 MethodHandlesAdapterBlob(固定大小的 BufferBlob,codeBlob.hpp:452-454;JDK11 的 `adapter_code_size` 在 methodHandles_x86.hpp:30,LP64=32000 字节)里有大量手写 adapter 汇编: ricochet frame(每次 adapter hop 重排参数的专用临时帧,帧头含 MethodHandle\*+MemberName\*+下一目标)+ argument shuffling(纯 mov 序列)。JDK11 的 blob **只剩 6 个签名多态入口**(29-01 §3),asType/permute 等全部移到 Java 侧。

演进动机(机制层面的推断,源码无注释直证;素材 E 的对照): ①**可移植性**——手写汇编每平台一份,LF 字节码一次生成处处可编译;②**可优化性**——汇编 adapter 是不可内联的黑盒,而 LF 字节码是普通 Java 方法,进 CodeCache 后被 C2 完全内联/常量折叠;③**可组合性**——LambdaFormEditor 的变换是数据(编辑 LF),可缓存/可复用。

*关键设计: JDK 的 adapter 哲学从"汇编模板"转向"生成的小方法"。这与 29-01 的 LambdaForm 是同一设计的两面: 调用形态(LF)和参数变换(编辑 LF)都是数据,最终统一编译成普通方法——运行时只剩一个可内联的方法体。*

## 核心悬念

29 域收官。参数传递的真相: **JDK11 没有 ricochet frame**——链接器零搬运(调用约定共享,一次 jmp),参数变换是 Java 侧 LambdaFormEditor 的 LF 编辑(可内联小方法),JDK8 的手写汇编 adapter 被字节码取代。方法句柄的调用链至此闭环: 签名多态 → 常量折叠/链接器 → LF 小方法 → 目标方法。29 域拆的是"怎么把方法变成值再调回去"——下一个域问的是"怎么把 VM 内存内部暴露给外部": JConsole 看到的 Eden/Survivor/Old 使用量从哪来?

> → [33-jmx/01 — JConsole 怎么知道 Eden 用了多少？— MemoryService + MemoryPool](openjdk/vol-02/33-jmx/01-memory-service.md)
