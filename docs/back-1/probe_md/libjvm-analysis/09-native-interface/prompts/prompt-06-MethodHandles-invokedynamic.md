# PROMPT: 请撰写 06-MethodHandles-invokedynamic.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**MethodHandles & invokedynamic — invokedynamic 指令的 4 阶段执行管道、MethodHandle 类型系统与 LambdaForm 结构、Lambda 表达式/String 拼接/Records 的底层引擎**

### 核心故事线（禁止做源码翻译机！）

Java 8 引入 Lambda 表达式时，大多数开发者以为 `() -> System.out.println("hello")` 会被编译成匿名内部类。但实际上 javac 生成了一个 `invokedynamic` 指令——这个指令在第一次执行时不做任何事，直到运行时才决定"这个 lambda 到底要调用什么方法"。真正的工作发生在 JVM 内部：**bootstrap method 调用 → 返回 CallSite → CallSite 包含 MethodHandle → MethodHandle 的 LambdaForm 链接到真实方法 → JIT 编译 LambdaForm → 最终和直接调用一样快**。

[09-05] 拆解了反射的 6 层调用路径——每一层都是开销。最乐观情况下（GeneratedMethodAccessor + JIT），反射仍要付参数拆箱的代价。但 MethodHandle 的设计目标是"在 JIT 眼中是透明的"——可以被完全内联，最终消除所有开销。**理解 invokedynamic 的 4 阶段管道，就是理解 Java 8+ 的字节码引擎的核心**。

本文的核心叙事不是"invokedynamic 的字节码规范"（那是 JVM Spec §6.5 的内容）——而是"JVM 内部如何处理 invokedynamic 指令，从 CallSite 找到方法、生成 LambdaForm、编译成机器码"。更关键的是：**MethodHandle 的类型系统和 LambdaForm 的 Name 节点树是理解这个处理过程的两把钥匙**——前者定义了"怎么调用"，后者定义了"调用什么"。

### 核心叙事线

1. **★ invokedynamic 的 4 阶段管道 — 不是 2 阶段不是 3 阶段** — (a) **解析阶段**（类加载时）：`Rewriter::rewrite_invokedynamic()` 在 Constant Pool 中创建 `resolved_references` 条目和 `cpCache` 槽位。此时不执行任何 BSM，只预留位置。(b) **链接阶段**（第一次执行，lazy）：`BytecodeInterpreter` / `TemplateTable` 看到 unresolved cpCache → 调用 `InterpreterRuntime::resolve_invokedynamic()`（`interpreterRuntime.cpp:1022`）→ `LinkResolver::resolve_invokedynamic()`（`linkResolver.cpp:1793`）→ 解析 BSM（`pool->resolve_bootstrap_specifier_at()`）→ `resolve_dynamic_call()`（`linkResolver.cpp:1875`）→ **Java up-call** `SystemDictionary::find_dynamic_call_site_invoker()`（`systemDictionary.cpp:2860`）→ **Java 侧执行 BSM** `MethodHandleNatives.linkCallSite()`（`systemDictionary.cpp:2892`）→ BSM 返回 CallSite → cpCache 缓存结果。(c) **适配阶段**（每次调用）：cpCache 的 f1 指向 `MH.linkToCallSite`（adapter MH）→ f2/appendix 存 CallSite → `CallSite.target()` 返回目标 MethodHandle → 调度到 `invokeBasic` → `jump_to_lambda_form()`（`methodHandles_x86.cpp:157`）→ MH.form → LF.vmentry → MemberName.method → ResolvedMethodName.vmtarget → **真正的 Method***。(d) **编译阶段**（达到阈值后）：C1/C2 编译 LambdaForm → 内联目标方法 → 消除 MethodHandle 中间层 → 和直接调用零开销。★ 追问：**CallSite 改变 target 后怎么通知 JIT？** → `MHN_setCallSiteTargetNormal`（`methodHandles.cpp:1388`）→ `flush_dependent_nmethods()`（`methodHandles.cpp:1098`）→ 所有依赖此 CallSite 的 nmethod 被 deoptimize → 下次调用走 interpret → 重新 link 到新 CallSite → evtl. 重新编译。

2. **★★ MethodHandle 类型系统 — invokeBasic / linkToVirtual / linkToStatic / linkToSpecial / linkToInterface 的分工** — `methodHandles.cpp:410-437` 的映射表定义了 5 种 signature-polymorphic 方法：(a) `_invokeBasic` → bytecode `invokehandle` → ref_kind = 0 → 通过 `jump_to_lambda_form()` dispatch → **最通用**，任何 MH 都可以走。(b) `_linkToVirtual` → bytecode `invokevirtual` → ref_kind = `JVM_REF_invokeVirtual` → 读取 `MemberName.vmindex`（vtable index）→ `__ lookup_virtual_method()` → 找到具体 Method*。(c) `_linkToStatic` → bytecode `invokestatic` → 直接跳到方法入口。(d) `_linkToSpecial` → bytecode `invokespecial` → 直接超类调用。(e) `_linkToInterface` → bytecode `invokeinterface` → 读取 `MemberName.vmindex`（itable index）→ `__ lookup_interface_method()`。追问：**为什么需要这么多 linkTo*？** → 如果只用 invokeBasic → 每次调用都要走 `jump_to_lambda_form()` → MH → LF → MemberName 的完整链 → 无法利用 vtable/itable 的 O(1) dispatch。linkToVirtual 把 vtable index 硬编码在 MemberName 中 → 汇编层直接 `jmp vtable[idx]` → 接近 invokevirtual 的性能。

3. **★★★ LambdaForm 结构 — Name 节点树的 IR 本质** — LambdaForm 是 MethodHandle 在 JVM 中的中间表示（Intermediate Representation）。`java_lang_invoke_LambdaForm`（`javaClasses.hpp:1054`）的关键字段：(a) `vmentry`（MemberName）→ `MemberName.method` → `ResolvedMethodName.vmtarget` → 最终的 Method*。**(b) `names`（Name[]）→ Name 节点树**：每个 Name 代表一个操作——参数绑定（`Argument`）、类型转换（`Conv`）、方法调用（`invoke`）、字段加载/存储等。Name 节点被解释执行（类似模板解释器），直到达到编译阈值。(c) `@LambdaForm$Compiled` annotation → `classFileParser.cpp:2178` 识别 → 设置 `_compiledLambdaForm` intrinsic（`vmIntrinsics::_compiledLambdaForm`）→ 强提醒 C1/C2 优先编译此 LambdaForm。追问：**LambdaForm 转译成 bytecode 的过程在哪？** → 在 Java 侧 `InvokerBytecodeGenerator`（JDK 源码，不在 HotSpot C++ 中）。生成的 bytecode 被 JIT 编译——所以 LambdaForm 在 JIT 眼中"和普通 Java 方法没有区别"。

4. **★★ `jump_to_lambda_form()` 的 x86 汇编实现 — 从 MH 到 Method* 的硬件级路径** — `methodHandles_x86.cpp:157-197`：**load 链**：(1) `__ load_heap_oop(method_temp, Address(recv, java_lang_invoke_MethodHandle::form_offset_in_bytes()))` — 读 MH.form（LambdaForm 引用）、(2) `__ load_heap_oop(method_temp, Address(method_temp, java_lang_invoke_LambdaForm::vmentry_offset_in_bytes()))` — 读 LF.vmentry（MemberName）、(3) `__ load_heap_oop(method_temp, Address(method_temp, java_lang_invoke_MemberName::method_offset_in_bytes()))` — 读 MemberName.method（ResolvedMethodName）、(4) `__ access_load_at(T_ADDRESS, IN_HEAP, method_temp, Address(method_temp, java_lang_invoke_ResolvedMethodName::vmtarget_offset_in_bytes()), ...)` — 读最终的 Method* 指针。(5) `jump_from_method_handle()`（`methodHandles_x86.cpp:120`）→ 从 Method* 的 `_from_interpreted_entry` 或 `_from_compiled_entry` 读取入口地址 → `jmp` 过去。追问：**这 4 次 heap load 有多大开销？** → 每次 load 可能触发 GC barrier（G1 的 SATB pre-barrier）→ 如果 MH 在 old gen 且引用的 LambdaForm 在 young gen → 需要 remset 扫描。但 JIT 编译后可能内联这些 load → 减少到 0。

5. **★★ `SystemDictionary::find_dynamic_call_site_invoker()` 的 Java up-call — BSM 返回的 CallSite 怎么存** — `systemDictionary.cpp:2860-2930`：构造一个 `CallInfo` → `find_dynamic_call_site_invoker()` → 内部调用 Java 侧 `MethodHandleNatives.linkCallSite(caller, bsm_index, bsm_handle, name, type, info)`（`systemDictionary.cpp:2892`）→ **执行 bootstrap method** → 返回 MemberName + appendix → `unpack_method_and_appendix()` → `result.set_handle(method, appendix, method_type)`。★ 关键发现：**BSM 不是每次都执行**——只有在 cpCache 未链接时才执行。第一次执行后 → cpCache 被填充 → f1 = adapter MH, f2/appendix = 调用结果（MemberName + appendix）。后续调用直接从 cpCache 读取 → 跳过整个 BSM 路径。追问：**CallSite appendix 是什么？** → 从 cpCache 的 appendix 字段读出的 `jobject`。not NULL 时 → 在 `interpreterRuntime.cpp:1039-1048` 的 `cpce->set_dynamic_call()` 被写入 f2。实际调用时 → `TemplateTable::invokedynamic()` 从 cpCache 取 f2 作为 MethodHandle 调用 → 这是 CallSite.getTarget() 的 MH。

6. **★★ MethodHandle 依赖追踪 — CallSite.setTarget() 后的 deoptimization** — `methodHandles.cpp:1077-1102`：当 nmethod 被编译后 → 如果 code 中包含对某个 CallSite 的引用 → 调用 `add_dependent_nmethod(call_site, nmethod)`（L1077）→ 把 nmethod 挂到 CallSite 的 `DependencyContext` 链表上。当 CallSite.setTarget() 被调用 → `MHN_setCallSiteTargetNormal`（L1388）→ `flush_dependent_nmethods(call_site)`（L1098）→ 遍历链表 → 对每个 dependent nmethod 调用 `nmethod::make_not_entrant()` → deoptimize。下次调用 → 重新走 invokedynamic 链接路径 → 用新 CallSite。追问：**为什么用 deoptimize 而不是更新 code？** → 更新已编译 code 中的 MethodHandle 引用太危险——可能在线程执行中间改变。deoptimize + 重新链接是唯一安全的方式。

7. **★★ 反射 vs MethodHandle 的性能对比 — 为什么 MH 能被 JIT 内联但反射不能** — 反射：`Method.invoke(Object target, Object... args)` → 参数总是 Object[] → JIT 无法证明 Object[] 中的类型 → 每次调用必须类型检查 + 拆箱 → 开销不可消除。MethodHandle：类型信息在 `MethodType` 中静态编码 — `MethodHandle mh = lookup.findVirtual(String.class, "length", methodType(int.class))` → `mh.invokeExact((String) "hello")` → JIT 看到 `invokeExact` + MethodType `(String)int` → 直接确定参数类型 → 可以内联 → **零开销调用**（和内联的 invokevirtual 一样）。追问：**invoke vs invokeExact 的区别？** → `invoke()` = `invokeBasic` → 每次调用做类型适配（asType()）→ 有转换开销。`invokeExact()` → 类型必须完全匹配 → 无适配开销 → 可以直接内联。

### 禁止行为

- ❌ 把 invokedynamic 的字节码规范当文章主题——这是 JVM Spec 的内容，不是源码分析
- ❌ 忽略 LambdaForm 的 Name 节点树结构——只说"LambdaForm 是 IR"不解释 Name 的编译树本质
- ❌ 对 linkTo* 系列只列名字不对比分工——每种 linkTo* 在汇编层的 dispatch 方式完全不同
- ❌ 忽略 [09-05] 的性能对比——必须区分"MethodHandle 为什么比反射快"和"为什么两者设计目标不同"
- ❌ 忽略 CallSite 的依赖追踪——`flush_dependent_nmethods()` 是理解 MutableCallSite/VolatileCallSite 的关键
- ❌ 不解释 `jump_to_lambda_form()` 的 4 次 heap load——这是 MH dispatch 的硬件开销路径
- ❌ 忽略 BSM 只执行一次这一事实——这是 invokedynamic = `lazy + cache once` 的核心语义
- ❌ 把 MethodHandle 解释成"函数指针"——MethodHandle 是类型化的、可内联的、和 JVM vtable 集成的引用

### 要求行为

- ✅ **★ invokedynamic 4 阶段管道图** — 每个阶段的输入/输出、执行线程、是否 lazy、关键函数
- ✅ **★ MethodHandle 类型系统表** — 5 种 linkTo* + invokeBasic 的 bytecode 映射、ref_kind、dispatch 方式
- ✅ **★ LambdaForm→Method* 的硬件级寻址链** — `jump_to_lambda_form()` 的 4 次 heap load 逐行汇编注释
- ✅ **★ BSM → CallSite → cpCache 的缓存机制** — 第一次 link 和后续调用的路径对比
- ✅ **★ CallSite.setTarget() → flush_dependent_nmethods() 的 deopt 全流程**
- ✅ **★ 和 [09-05] 反射的逐项性能对比** — 参数传递、类型检查、JIT 内联能力、可消除开销
- ✅ **★ GDB 可证伪断言 ≥10 条** — LambdaForm vmentry 追踪、cpCache f2/appendix 验证、dependent nmethod 链表
- ✅ **★ 和 [09-04][09-05] 的交叉引用** — MethodHandleNatives 的 native 注册、和反射的性能对比

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `methodHandles.cpp` | `src/hotspot/share/prims/methodHandles.cpp` | prims | `generate_adapters()`(:75)、`init_method_MemberName()`(:222)、`resolve_MemberName()`(:715)、`is_method_handle_invoke_name()`(:371)、`signature_polymorphic_intrinsic_name()`(:410)、`signature_polymorphic_intrinsic_bytecode()`(:424)、`add_dependent_nmethod()`(:1077)、`flush_dependent_nmethods()`(:1098)、`MHN_setCallSiteTargetNormal`(:1388) | ★★★ MethodHandle 核心 — 类型系统 + 适配生成 + CallSite 追踪 |
| 2 | `methodHandles.hpp` | `src/hotspot/share/prims/methodHandles.hpp` | prims | `MethodHandles` 类（AllStatic）、`signature_polymorphic_name_id()`、`generate_adapters()` 声明 | ★★ 接口定义 |
| 3 | `linkResolver.cpp` | `src/hotspot/share/interpreter/linkResolver.cpp` | interpreter | `resolve_invokedynamic()`(:1793)、`resolve_invokehandle()`(:1745)、`resolve_handle_call()`(:1756)、`lookup_polymorphic_method()`(:449) | ★★★ invokedynamic 链接 — BSM 解析 + MethodHandle 解析 |
| 4 | `systemDictionary.cpp` | `src/hotspot/share/classfile/systemDictionary.cpp` | classfile | `find_method_handle_invoker()`(:2532)、`find_dynamic_call_site_invoker()`(:2860)、`unpack_method_and_appendix()`(:2477) | ★★ Java up-call 实现 — BSM 执行 |
| 5 | `methodHandles_x86.cpp` | `src/hotspot/os_cpu/linux_x86/methodHandles_x86.cpp` | os_cpu | `jump_to_lambda_form()`(:157)、`generate_method_handle_dispatch()`(:294)、`generate_method_handle_interpreter_entry()`(:203) | ★★ 汇编级 dispatch — MH 到 Method* 的硬件路径 |
| 6 | `interpreterRuntime.cpp` | `src/hotspot/share/interpreter/interpreterRuntime.cpp` | interpreter | `resolve_invokedynamic()`(:1022)、`set_dynamic_call()`(:1039-1048) | ★★ 解释器触发 link + 缓存写入 |
| 7 | `javaClasses.hpp` | `src/hotspot/share/classfile/javaClasses.hpp` | classfile | `java_lang_invoke_MethodHandle`(:1040)、`java_lang_invoke_LambdaForm`(:1054)、`java_lang_invoke_MemberName`(:1075)、`java_lang_invoke_ResolvedMethodName`(:1085+)、`java_lang_invoke_CallSite`(:1030) | ★★ JDK 对象布局 — MH.form / LF.vmentry / MemberName.method / ResolvedMethodName.vmtarget |
| 8 | `classFileParser.cpp` | `src/hotspot/share/classfile/classFileParser.cpp` | classfile | `@LambdaForm$Compiled` 注解识别(:2178-2179)、`@LambdaForm$Hidden` 注解识别 | ★ LambdaForm 注解识别 — _compiledLambdaForm intrinsic 设置 |
| 9 | `vmSymbols.hpp` | `src/hotspot/share/classfile/vmSymbols.hpp` | classfile | `_invokeBasic`(:1439)、`_linkToVirtual`、`_linkToStatic`、`_linkToSpecial`、`_linkToInterface` 等 intrinsic 声明 | ★ 签名多态方法的 intrinsic ID 定义 |

**跨模块说明**：invokedynamic 的执行涉及 interpreter（link 解析）、classfile（LambdaForm/MemberName 对象布局）、prims（MethodHandle API）、os_cpu（汇编 dispatch）——是 JVM 中模块耦合度最高的指令。`linkResolver.cpp` 在 interpreter/ 模块是刻意设计的——链接是解释器的工作，不是 prims 层。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ invokedynamic 的 4 阶段管道

```
问题：
  ① 类加载阶段的 Rewriter 做了什么？为什么不是加载时就 resolve？
      线索: rewriter.cpp Rewriter::rewrite_invokedynamic()
      答案方向: 预分配 cpCache 槽位 + resolved_references 条目。不执行 BSM——因为 BSM 可能
      依赖运行时状态（如 lambda 捕获的变量）。resolve 必须在第一次执行时做。

  ② LinkResolver::resolve_invokedynamic() 返回什么？
      线索: linkResolver.cpp:1793-1873
      答案方向: 不返回 Java 对象——而是填充 CallInfo result。result 包含 resolved Method*（adapter method）
      + appendix（CallSite 对象）+ method_type。CallInfo 之后被 InterpreterRuntime 存入 cpCache。

  ③ SystemDictionary::find_dynamic_call_site_invoker() 内部做了什么 Java up-call？
      线索: systemDictionary.cpp:2860-2930
      答案方向: 通过 JavaCalls::call_static() 调用 MethodHandleNatives.linkCallSite(caller, bsm, name, type)
      → Java 侧执行 bootstrap method → 返回 MemberName + 可能的 appendix → unpack_method_and_appendix()
      分解返回值为 methodHandle + oop appendix。

  ④ BSM 只执行一次还是每次都执行？
      答案方向: ★ 只执行一次。第一次 resolve_invokedynamic 时 cpCache 未链接 → 执行 BSM →
      InterpreterRuntime::resolve_invokedynamic 的 L1047 写 cpCache → 后续调用直接从 cpCache 读 →
      跳过 BSM。如果 CallSite 的 target 改变 → deopt + 回交换 -> 但 CallSite 对象本身不重建 → BSM 不被重调。
```

### 4.2 ★★ MethodHandle 类型系统

```
问题：
  ① invokeBasic 和 linkToVirtual 在汇编层有什么本质区别？
      线索: methodHandles_x86.cpp:331 (invokeBasic) vs :294 (linkToVirtual)
      答案方向: invokeBasic 走 jump_to_lambda_form() — 4 次 heap load 找到 Method*。
      linkToVirtual 走 generate_method_handle_dispatch() — 读 MemberName.vmindex → 
      __ lookup_virtual_method(receiver, method_temp, ...) → 直接 jmp 到 Method*。少 3 次 heap load。
      追问: 为什么 linkTo* 可以更快？→ 因为 vmindex 已经预计算好 — 是 vtable index — 不需要
      通过 LambdaForm chain 去搜索。

  ② signature_polymorphic_intrinsic_bytecode() 的映射为什么重要？
      线索: methodHandles.cpp:424-435
      答案方向: 映射表将 VMENTRY (invokeBasic/linkTo*) 映射为 JVM 字节码 — JIT 利用此映射
      生成正确的 invoke 指令。如果不正确映射 → JIT 可能生成错误的调用指令 → 崩溃。

  ③ MethodHandles::is_method_handle_invoke_name() 的判断条件是什么？
      线索: methodHandles.cpp:371-408
      答案方向: (a) method->is_native(), (b) method->is_varargs(), (c) 只有一个 Object[] 参数,
      (d) 返回 Object。这四个条件全体成立 → JVM 判断为"调用者要 invoke MH"。
      追问: 如果 JDK 加了一个新签名 but miss 了 vmSymbols 注册 → method_handle_invoke 不识别
      → 走普通 native 解析 → NativeLookup 找不到实现 → UnsatisfiedLinkError。

  ④ ref_kind 字段的作用是什么？
      方法: memberName 的 ref_kind 在调用时的用途
      答案方向: MemberName 的 reference kind (JVM_REF_invokeVirtual / JVM_REF_invokeStatic 等)
      决定 dispatch 方式。生成适配器的汇编层根据 ref_kind 选择 generate_method_handle_dispatch()
      的不同路径。追问: MemberName 的 ref_kind 从哪来？→ 在 init_method_MemberName() 中
      (methodHandles.cpp:222) 从 CallInfo 的 call_kind() 推导。
```

### 4.3 ★★★ LambdaForm — Name 节点树的 IR

```
问题：
  ① LambdaForm.vmentry 的类型是什么？它和 Method* 的链路是什么？
      线索: javaClasses.hpp:1054-1073 的 java_lang_invoke_LambdaForm
      答案方向: vmentry 是 MemberName 对象 (oop)。MemberName.method 指向 ResolvedMethodName 对象 (oop)。
      ResolvedMethodName.vmtarget 才是 C++ 的 Method* (native pointer，存在 oop 的字段中)。
      三者链: LF → vmentry (MemberName oop) → method (ResolvedMethodName oop) → vmtarget (Method* native ptr)。

  ② Name[] 节点树是什么样的结构？
      线索: java_lang_invoke_LambdaForm 的 names 字段 + JDK LambdaForm 的 Name 类
      答案方向: Name[] 中的每个 Name 有 4 个属性: (a) function (操作类型—如 "invoke", "identity", "zero"),
      (b) arguments (参数索引数组—指向其他 Name 或命名参数), (c) index (在节点树中的位置),
      (d) type (结果的 BasicType)。多个 Name 构成 DAG — 编译器按拓扑序遍历执行。
      追问: 这和 MethodHandle 的编译器 IR 有什么相似？→ 类似 C2 的 Ideal Graph — 都是 SSA 形式的 DAG。

  ③ @LambdaForm$Compiled 注解对 JIT 意味着什么？
      线索: classFileParser.cpp:2178 + vmIntrinsics::_compiledLambdaForm
      答案方向: 这是一个**伪 intrinsic** — 不映射到任何 C2 intrinsic 实现。它只是一个标记 —
      C2 的 Compile 阶段检查此标记 → 如果 set → 提升此方法的编译优先级 → 内联友好。
      追问: 没有这个标记会怎样？→ C2 可能不编译此 LambdaForm → 永远解释执行 → 更慢。

  ④ LambdaForm 的 invoker 是怎么选择 MethodHandle 的？
      答案方向: 当 LambdaForm 被调用时 → invoker 检查类型匹配 → 如果匹配 → 直接执行 Name 树。
      如果不匹配 → asType 生成新的 LambdaForm → 做类型适配。追问: 这和 invoke vs invokeExact 的关系？
      → invokeExact 要求类型完全匹配 → 跳过 asType → 更快。
```

### 4.4 ★★★ jump_to_lambda_form() 的 4 次 heap load

```
问题：
  ① 为什么需要 3 个中间对象（LambdaForm, MemberName, ResolvedMethodName）才能到达 Method*？
      答案方向: 设计柔韧性 — (a) LambdaForm 可以切换 vmentry 来指向不同的 Method*，(b) MemberName
      可以缓存已解析的 Method*，避免每次都查 Symbol*，(c) ResolvedMethodName 是专门用来存 native 指针的
      oop—把 C++ 指针藏在 oop 中是微妙的（需要 GC 正确处理，不能扫到此地址）。

  ② 这 4 次 load 中有几次会产生 GC barrier？
      答案方向: 前 3 次 load heap oop → 如果是 G1 且引用的对象在 young gen → SATB enqueue → GC barrier。
      ★ 第 4 次是 access_load_at(T_ADDRESS) — 直接读 native word — 无 GC barrier。
      追问: Shenandoah 呢？→ 前 3 次 load 可能触发 Brooks pointer 重定向 — 每次 load ~10ns overhead。

  ③ jump_to_lambda_form() 的边界条件 — 如果 LF.vmentry 是 NULL 怎么处理？
      答案方向: 如果 vmentry 是 NULL → 会在第三次 `__ load_heap_oop` 加载时读到 NULL → 第 4 次
      `__ access_load_at(T_ADDRESS, ...)` 时访问 NULL 地址 → SIGSEGV → JVM 转成 NullPointerException
      （通过 [09-04]§二的 SIGSEGV→NPE 信号处理）→ 但如果 LF 不健全 → 这是一个 JVM bug → fatal error。

  ④ JIT 内联后这些 load 可以消除吗？
      答案方向: ★ 可以—这是 MethodHandle 设计的核心目标。C2 的 Compile 阶段通过 ciMethodHandle
      的 intrisic 识别 → 内联 MH chain → 直接 emit 目标方法的机器码 → 0 次 heap load。
      JDK 9+ 的 @Stable 注解 + @ForceInline 的 MethodHandle 实现 → 几乎保证内联成功。
```

### 4.5 ★★ CallSite 依赖追踪

```
问题：
  ① add_dependent_nmethod() 什么时候被调用？
      线索: methodHandles.cpp:1077-1089
      答案方向: 当 nmethod 编译完成后 → 如果其中引用了 MethodHandle (MH) 常量（从 condy 解析得到）
      → 在 ciMethod 或 C2 的 mach node 构建阶段 → 记录依赖 → 在编译完成回调中调用 add_dependent_nmethod()。
      追问: 这个依赖是 CallSite 粒度的还是 MemberName 粒度的？→ 是 CallSite 粒度的。

  ② 如果忘记注册依赖会怎样？
      答案方向: CallSite.setTarget() 改变目标 → 但旧 nmethod 没有 deoptimize → 仍然执行旧的 MH →
      执行旧的 target 方法 → 行为和程序逻辑不一致 → bug 或死循环。

  ③ flush_dependent_nmethods() 是立即生效还是延迟？
      线索: methodHandles.cpp:1098
      答案方向: 立即标记所有 dependent nmethod 为 not_entrant + 发 VM_Deoptimize → VMThread 处理 →
      停止所有相关线程序列 → deoptimize。这是同步操作 — 调用后返回 → 所有线程已回撤。

  ④ 为什么用 deoptimize (回撤到解释) 而不是 patch code?
      答案方向: 已经执行的 nmethod 中的机器码在 CPU 指令缓存中 — 不能安全修改。即使能修改
      也改变不了已经在执行的指令。deopt 是唯一安全的方式: 把执行上下文 (寄存器 + 栈) 重建为解释器状态
      → 解释器重新执行 invokedynamic → 读取新 CallSite → 用新 target。
```

### 4.6 ★★ 和 [09-05] 反射的性能对比

```
问题：
  ① 反射的 Object[] 参数和 MethodHandle 的 MethodType 参数在 JIT 眼中的区别？
      答案方向: 反射参数 → JIT 看到 Object[] 数组 → 无法确定元素类型 → 必须保守 → 不能内联。
      MethodHandle 的 MethodType → 参数类型静态编码在 MH 类型中 → JIT 通过 ciMethodHandle
      分析 → 看到精确的类型 → 可以生成指定类型的代码 → 内联。
      追问: 这就是"类型信息可传播"和"类型信息被擦除"的在 JIT 层的体现。

  ② MethodHandle.invoke() vs Method.invoke() 在机器码层的差异？
      答案方向: MH.invoke() → 5 个 x86 指令（load MH → load Method* → jmp entry）。
      Method.invoke() → 100+ 条指令（6 层调用 + 参数拆箱 + 类型检查）。
      追问: 两者最后都到 Method::from_compiled_entry() — 但 MH 更快因为前期开销几乎为零。

  ③ 为什么 MethodHandle 也有 invoke(invokeBasic) vs invokeExact 之分？
      答案方向: invokeExact 要求类型和 MethodType 完全匹配 → 无 asType 转换 → 可直接生成
      精确的调用指令。invoke (invokeBasic) 允许不匹配 → asType 生成适配 LambdaForm → 额外开销。
      所以 invokeExact 可和内联的 invokevirtual 一样快。
```

### 4.7 ★ BSM 参数解析与 condy 的关系

```
问题：
  ① resolve_bootstrap_specifier_at() 解析了什么？
      答案方向: 从 ConstantPool 的 BootstrapMethods 属性中读取 BSM index → 解析为 MethodHandle 常量 →
      读取 static arguments (condy 的 bootstrap arguments) → 返回 BootstrapInfo(bsm_mh, args, name, type)。
      追问: 这些 static arguments 是 BSM 的"配方" — 决定 BSM 返回什么样的 CallSite。

  ② condy (constant dynamics) 和 indy (invokedynamic) 的重大差异？
      答案方向: indy → 每次调用都从 CallSite.target() 拿 MethodHandle → 每次 dispatch。
      condy → 只解析一次 → 返回常量 → 替换 cpCache → 后续直接加载常量 → 零 dispatch。
      condy = indy 的"懒加载常量"版本。追问: 两者都走 resolve_dynamic_call() — 差别在上层语义。
```

## 五、文章结构

```
§〇 源文件清单（跨 interpreter + classfile + prims + os_cpu，标注模块归属和 pipeline 角色）

§一 ★★★ invokedynamic 的 4 阶段管道
  ❓ 为什么需要 4 个阶段而不是 2 个？
  ❓ 哪个阶段是 lazy 的？哪个是 eager？
  1.1 阶段 1（解析）: Rewriter::rewrite_invokedynamic — cpCache 预分配
  1.2 阶段 2（链接）★: BSM 执行 + cpCache 缓存 — 全文核心
  1.3 阶段 3（适配）: jump_to_lambda_form + MethodHandle dispatch
  1.4 阶段 4（编译）: C1/C2 编译 + MH 内联消除
  1.5 4 阶段完整时序图 — 标注每次调用的路径

§二 ★★ MethodHandle 类型系统 — 5 种 linkTo* 的汇编层分工
  ❓ 为什么需要 5 种 linkTo* 而不是 1 种 invokeBasic？
  ❓ 每种 linkTo* 的 ref_kind + bytecode 映射是什么？
  2.1 invokeBasic → invokehandle → jump_to_lambda_form
  2.2 linkToVirtual → invokevirtual → vtable dispatch
  2.3 linkToStatic → invokestatic → direct jump
  2.4 linkToSpecial → invokespecial → super call
  2.5 linkToInterface → invokeinterface → itable dispatch
  2.6 signature_polymorphic_intrinsic 查找表 (methodHandles.cpp:410-465)

§三 ★★★ LambdaForm — Name 节点树 + vmentry 到 Method* 的寻址链
  ❓ LambdaForm 的 Name 节点树怎么被编译成 machine code？
  ❓ 为什么 MethodHandle 需要 3 个中间对象才能找到 Method*？
  3.1 LambdaForm 对象布局 (javaClasses.hpp:1054-1073)
  3.2 Name[] 结构 — SSA DAG 中的 Name 节点
  3.3 ★ jump_to_lambda_form() 的 4 次 heap load 逐行汇编注释
  3.4 @LambdaForm$Compiled 的 JIT 提示
  3.5 LF → vmentry → MemberName → ResolvedMethodName → vmtarget → Method*

§四 ★★ BSM 执行与 CallSite 缓存
  ❓ BSM 每次调用都执行吗？怎么验证？
  ❓ CallSite 对象存在哪里？和 cpCache 的关系？
  4.1 SystemDictionary 的 Java up-call 机制
  4.2 cpCache 的 set_dynamic_call 写入
  4.3 MemberName + appendix 的存储布局
  4.4 BSM 的参数传递 (静态参数列表)

§五 ★★ CallSite 依赖追踪 — setTarget 后的 deoptimization
  ❓ CallSite.setTarget() 后，已经编译的代码怎么失效？
  ❓ 为什么是 deopt 而不是 patch？
  5.1 add_dependent_nmethod — 注册依赖
  5.2 flush_dependent_nmethods — deopt 触发
  5.3 VM_Deoptimize 在 VMThread 上的执行
  5.4 回到解释器重新 link 的完整路径

§六 ★★ 和 [09-05] 反射的性能对比
  ❓ 反射比 MH 慢多少？具体差在哪些操作？
  ❓ MH 为什么能被 JIT 完全内联而反射不能？
  6.1 参数类型信息可传播 vs 被擦除
  6.2 Machine code 层的指令数对比
  6.3 MethodHandle.invokeExact() 和 inline invokevirtual 的等价证明
  6.4 反射 6 层 vs MH 2-3 层 (with inlining: 0 层)

§七 ★ 和 [09-04][09-05][09-03] 的交叉验证
  ❓ MHN_init_Mem 的 JVM_ENTRY 宏 — [09-04] 的直接应用
  ❓ linkToStatic 和反射最终都走 JavaCalls::call — [09-05] 的承接
  7.1 JVM_ENTRY 在 MethodHandles native 方法中的使用
  7.2 linkToStatic → method::from_compiled_entry 和反射的共同终点
  7.3 VM_RedefineClasses 后 MethodHandle 是否需要失效（[09-03] 的 ResolvedMethodTable）

§八 GDB 验证 + 可证伪断言（≥12 条）
  断言 1: 第一次 invokedynamic 执行前 → cpCache 的 f1 == NULL
  断言 2: resolve_invokedynamic 后 → cpCache 的 f1 指向 MH.linkToCallSite
  断言 3: cpCache 的 f2/appendix 指向 CallSite 对象
  断言 4: LambdaForm.vmentry 非 NULL → MemberName.vmtarget 非 NULL
  断言 5: jump_to_lambda_form 的 4 次 heap load 演示 — 单步 GDB 执行
  断言 6: CallSite.setTarget 前 → add_dependent_nmethod 注册的 nmethod 列表
  断言 7: CallSite.setTarget 后 → 所有 dependent nmethod 被标记 not_entrant
  断言 8: BSM 返回后 → MethodHandleNatives.linkCallSite 的结果验证
  断言 9: MethodHandle.type() 和 MethodType 的对应关系
  断言 10: linkToStatic 的 BytecodeStream 验证 — invoke invokestatic in generated adapter
  断言 11: 重复执行 invokedynamic → 只命中一次 resolve_invokedynamic 断点（第 2 次不命中）
  断言 12: ClassFileParser 识别 @LambdaForm$Compiled 注解 → intrinsic 设置 → m->is_compiled_lambda_form() == true

  可证伪断言 1: 如果 cpCache 已链接 → InterpreterRuntime::resolve_invokedynamic 的 linkResolver 路径被跳过
  可证伪断言 2: flush_dependent_nmethods 后 → 所有相关 nmethod 不再在 code cache 中可执行
  可证伪断言 3: LambdaForm 的 Name[] 长度 ≥ 1 → 至少包含一个操作 Name 节点
  可证伪断言 4: linkToVirtual 的 memberName.vmindex 指向正确的 vtable slot
```

## 六、写作要求

1. **★ invokedynamic 4 阶段管道是核心交付物**：读者看完必须能区分"解析（类加载时）"和"链接（第一次执行时）"的差异——这是理解 invokedynamic 的关键。

2. **★ jump_to_lambda_form() 的汇编走读是必须的**：不是"有 4 次 heap load"，而是用 GDB 逐行跟踪这 4 条 x86 指令、每次 load 后寄存器的值、最终 jmp 到的地址。

3. **★ MethodHandle 类型系统表必须包含每种 linkTo* 的精确 ref_kind + bytecode + dispatch 方式的完整对比**。

4. **★ LambdaForm → Method* 的对象链图必须精确**：MH.form → LambdaForm → vmentry → MemberName → method → ResolvedMethodName → vmtarget。每个箭头标注 oop 还是 native ptr、offset 名称。

5. **★ CallSite 依赖追踪的完整故事**：从 nmethod 编译 → add_dependent_nmethod → CallSite.setTarget → flush_dependent_nmethods → deoptimize → 重新 link → 重新编译的完整闭环。

6. **★ 和 [09-05] 反射的性能对比必须具体**：不是"方法数少"，而是"x86 指令数 5 vs 100+，GDB 单步可验证"。

7. **★ GDB 断言必须可执行**：Lambda 表达式的 Java 测试代码 + 精确的 breakpoint + 预期输出。

8. **★ 明确区分"本文分析的是 JVM 源码"与"JDK LambdaForm 生成算法"**：LambdaForm 节点树的生成在 JDK 侧（InvokerBytecodeGenerator），不在此文范围。本文聚焦 JVM 如何执行已生成的 LambdaForm。

## 七、输出格式

- Markdown 文件，命名为 `06-MethodHandles-invokedynamic.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/09-native-interface/`
- 元信息头（标准环境 + 源文件清单 + 前置 [09-05] + 阅读收益 + "Java 8+ 字节码引擎的完整解析"的说明）
