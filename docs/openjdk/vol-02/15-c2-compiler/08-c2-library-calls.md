# 08. library_call.cpp — 6991 行的 intrinsic 世界

> **前置依赖**:[15-c2-compiler/02 — Parse + GraphKit: 字节码→Ideal Graph](openjdk/vol-02/15-c2-compiler/02-c2-parse-graphkit.md):do_call→call_generator 决策链里 intrinsic 优先于内联,这里讲 intrinsic 本身;[15-c2-compiler/07 — PhaseMacroExpand: 高层抽象→低层 MachNode 展开](openjdk/vol-02/15-c2-compiler/07-c2-macro-intrinsics.md):arraycopy intrinsic 的落地(ArrayCopyNode→macroArrayCopy);[23-stub/02 — System.arraycopy 为什么能比手写循环快 3 倍?— Arraycopy 向量化](openjdk/vol-02/23-stub/02-arraycopy.md):intrinsic 依赖的运行时桩;[39-runtime-monitoring/02 — Timer + Monitoring Services](openjdk/vol-02/39-runtime-monitoring/02-timer-stats.md):nanoTime 的真实实现
> → **后续**:[16-code-cache/01 — 机器码的家: CodeBlob 与 CodeHeap](openjdk/vol-02/16-code-cache/01-codeblob-heap.md):编译产物住进 CodeCache
> 关联域: 13-jit-framework(编译入口)、23-stub(运行时桩)、39-runtime-monitoring(计时)

## JIT 理解语义的时刻

`Math.sin(x)` 的字节码是 `invokestatic Math.sin`(native 方法)——普通 JIT 只能发一条 JNI 调用(Java→C→Java 来回几百纳秒)。C2 的不同: **它认识这个方法**——方法在 `vmSymbols.hpp` 的 `VM_INTRINSICS_DO` 表里注册了 intrinsic ID(`do_intrinsic(_dsin, java_lang_Math, sin_name, ...)`,vmSymbols.hpp:778),`Parse` 期 call_generator 的 `find_intrinsic` 命中后,不建普通调用,而是进入 **`LibraryCallKit`**(library_call.cpp:94,GraphKit 子类)按 ID 生成专用理想图子图。intrinsic = **JIT 理解语义 → 发射专用代码**。library_call.cpp 是 opto 最大的源文件(6991 行),`try_to_inline`(:519)里一个巨型 switch 把 300+ 个 ID 分派到 `inline_xxx` 实现(:536 起)。顺带纠正大纲四处: intrinsic 触发在 **Parse 期**(不是"IGVN 阶段");`MathIntrinsicNode` 不存在——sin/cos 走 `runtime_math`(调用 StubRoutines 桩,不是直接 FSIN);`System.nanoTime` 是运行时调用 `os::javaTimeNanos` 不是 RDTSC;StrictMath 没有 intrinsic(不存在"开关跳过")。

## 1. 机制: 从方法 ID 到专用图

触发链(02 篇的决策链里已见过一环): `do_call` → `Compile::call_generator` → `find_intrinsic(callee, ...)`(doCall.cpp:118)。`Compile::find_intrinsic`(compile.cpp:150): 先查缓存表 `_intrinsics`(首次命中后 `register_intrinsic` 缓存,:160-163),未命中且 `m->intrinsic_id() != _none` 时 `make_vm_intrinsic` 创建(library_call.cpp:350)。ID 的来源: `VM_INTRINSICS_DO` 宏表展开出 **300+ 个 `do_intrinsic` 条目**(vmSymbols.hpp),每个条目把"类+方法名+签名"绑定到一个 `vmIntrinsics::ID`;方法加载时 ciMethod 记录 intrinsic_id,编译期据此分发。

`LibraryCallKit::try_to_inline`(:519)是分发中枢:

```cpp
// library_call.cpp:535-559(截取核心,逐字)
  switch (intrinsic_id()) {
  case vmIntrinsics::_hashCode:                 return inline_native_hashcode(intrinsic()->is_virtual(), !is_static);
  case vmIntrinsics::_identityHashCode:         return inline_native_hashcode(/*!virtual*/ false,         is_static);
  case vmIntrinsics::_getClass:                 return inline_native_getClass();

  case vmIntrinsics::_ceil:
  case vmIntrinsics::_floor:
  case vmIntrinsics::_rint:
  case vmIntrinsics::_dsin:
  case vmIntrinsics::_dcos:
  case vmIntrinsics::_dtan:
  case vmIntrinsics::_dabs:
  case vmIntrinsics::_fabs:
  case vmIntrinsics::_iabs:
  case vmIntrinsics::_labs:
  case vmIntrinsics::_datan2:
  case vmIntrinsics::_dsqrt:
  case vmIntrinsics::_dexp:
  case vmIntrinsics::_dlog:
  case vmIntrinsics::_dlog10:
  case vmIntrinsics::_dpow:
  case vmIntrinsics::_dcopySign:
  case vmIntrinsics::_fcopySign:
  case vmIntrinsics::_dsignum:
  case vmIntrinsics::_fsignum:                  return inline_math_native(intrinsic_id());
```

每个 `inline_xxx` 返回 bool(成功/放弃);失败则退回普通调用(02 篇的 cg->generate 兜底)。intrinsic 与普通内联共享同一张图——生成的都是理想节点,后续 IGVN/Matcher 照常处理,没有特殊通道。

## 2. String intrinsics — 把字符扫描变成 SIMD

`str.indexOf('e')` 的 Java 实现是逐 char 循环。intrinsic 版 `inline_string_indexOf`(library_call.cpp:1294): 先 `Matcher::match_rule_supported(Op_StrIndexOf)` 检查架构支持(:1296),null 检查后 `make_indexOf_node`(:1323)生成 `StrIndexOfNode`——这是理想节点,Matcher 把它匹配成 x86 的 `string_indexof` 桩调用(macroAssembler_x86.cpp:6030 起,函数内注释 "This method uses the pcmpestri instruction with bound registers" :6038——**SSE 4.2 的 pcmpestri 一次比较多个字符**,pcmpestri 宏在 :3852)。配套的 equals/compareTo/hasNegatives 在 :1160/:1139/:1221。**compact string 双编码**由 `StrIntrinsicNode::ArgEnc` 表达: 同一逻辑按 `LL/UU/LU/UL`(Latin1/UTF16 的四种组合)分派(:592-598)——JDK9+ 的 compact strings 让 intrinsic 家族翻倍。

门控细节: `UseSSE42Intrinsics` 默认值是 **false**(globals_x86.hpp:208),但 CPU 探测时若支持 SSE4.2 就 `FLAG_SET_DEFAULT(true)`(vm_version_x86.cpp:1216-1217)——即"CPU 决定默认值"的 ergonomics;`match_rule_supported` 是编译期二次确认。大纲说"CPU 无 SSE4.2 退化为 scalar 慢 30x"方向对,但"默认 true"是错的(默认值在启动时由 CPU 决定)。

## 3. Math 与 Unsafe/Thread/System

`inline_math_native`(library_call.cpp:1873)暴露了数学 intrinsic 的真实形态——**不是直接发 FSIN**,而是**分三档**:

```cpp
// library_call.cpp:1873-1880(截取核心,逐字)
bool LibraryCallKit::inline_math_native(vmIntrinsics::ID id) {
#define FN_PTR(f) CAST_FROM_FN_PTR(address, f)
  switch (id) {
    // These intrinsics are not properly supported on all hardware
  case vmIntrinsics::_dsin:
    return StubRoutines::dsin() != NULL ?
      runtime_math(OptoRuntime::Math_D_D_Type(), StubRoutines::dsin(), "dsin") :
      runtime_math(OptoRuntime::Math_D_D_Type(), FN_PTR(SharedRuntime::dsin),   "SIN");
```

**①sin/cos/tan/log/exp/pow**: `runtime_math` 生成对 **StubRoutines::dsin()** 桩的调用(桩在启动时生成,fast_sin 的 SIMD 多项式实现见 macroAssembler_x86_sin.cpp:381;桩不可用时兜底 `SharedRuntime::dsin` 的 C 实现)——intrinsic 消除的是 JNI 来回,产物仍是 call(23-stub 域的桩);**②sqrt/abs/ceil/floor/rint**: `inline_double_math`/`inline_math` 直接匹配机器指令(`match_rule_supported(Op_SqrtD)` 等,:1913-1918);**③特例**: `pow(x, 2.0)` 折叠成 `x*x`(:1908-1914)。大纲的"MathIntrinsicNode"在源码里不存在。

Unsafe/Thread/System 三族: **`inline_unsafe_allocate`**(:2870): 拒绝静态调用、null 检查、`new_instance(kls, test)` 分配**不调构造器**(final 字段不初始化,所以仅限 Unsafe 语义)——"跳过 `<init>`"✓ 但大纲的"绕过安全模型"表述过强,实际省略的是类型/null/边界检查;**`inline_native_currentThread`**(:2991)→ `generate_current_thread`(:1093)建 `ThreadLocalNode` 读 threadObj 字段——ThreadLocalNode 在机器层映射为 **r15_thread 读取**(x86_64 的 JavaThread 专用寄存器,macroAssembler_x86.hpp:290 注释 "thread in the default location (r15_thread on 64bit)");**`inline_native_time_funcs`**(:772): `System.nanoTime` → **`os::javaTimeNanos` 运行时调用**(39-02 域已证 = CLOCK_MONOTONIC clock_gettime)——**不是 RDTSC**——大纲这条与 JDK 实际选择不符: RDTSC 会受跨核/频率漂移影响,JDK 用 `clock_gettime(CLOCK_MONOTONIC)`(39-02 域实证过)。CAS 家族(`_compareAndSetObject` → `inline_unsafe_load_store`(:2638,LS_cmp_swap 分派,:703))生成原子比较交换节点,经 x86 匹配成 `lock cmpxchg`。

**实证**([素材](openjdk/planning/outlines/00-jvm-tools/materials/commands/15-c2-macro-demo.txt)第 1 段,复用 07 篇): PrintInlining 里 `System.arraycopy → intrinsic`(0 字节 native 被替换)与 `lockElim` 整体内联——intrinsic 决策的直接证据。`PrintIntrinsics` 是 diagnostic flag(c2_globals.hpp:657)可开可关;`UseSSE42Intrinsics`/`UseAESIntrinsics` 是 product 但默认值受 CPU 探测影响(实证时先 `-XX:+PrintFlagsFinal` 确认当前值)。

*关键设计: intrinsic 是"方法级语义的图级展开"——它不是特殊通道,而是**生成普通理想节点,交给同一套 IGVN/Matcher 管线**;这让 intrinsic 与普通代码无缝混合(参数折叠、死代码消除照常发生)。形态分级也体现成本权衡: 能匹配指令的(平方根/绝对值)直接内联,要精度保证的(sin/exp)调用启动期生成的专用桩,既不付 JNI 也没牺牲正确性。*

## 核心悬念

15 域收官——C2 的全景终于完整: **Parse**(字节码→理想图,inline 决策链里 intrinsic 优先)→ **三引擎**(IGVN/CCP/EA)→ **循环**(三循环+向量化)→ **Matcher**(.ad 选指令)→ **Chaitin**(图着色)→ **PhaseMacroExpand**(宏节点审判)→ **intrinsic**(library_call.cpp: 300+ ID,按语义生成专用图——String 的 pcmpestri 扫描、Math 的桩调用分级、Unsafe 的直分配、nanoTime 的运行时调用)。编译的终点是 nmethod——它住进 CodeCache(16 域),被解释器/编译代码调用,在依赖失效时被标记失效、被 sweeper 回收。下一篇: 机器码的家。

> → [16-code-cache/01 — 机器码的家: CodeBlob 与 CodeHeap](openjdk/vol-02/16-code-cache/01-codeblob-heap.md)
