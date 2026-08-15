# 01. 编译代码遇到问题——向谁求助?— Runtime Stubs

> **前置依赖**:[16-code-cache/04 — 重定位与内联缓存: IC 的形态与修补](openjdk/vol-02/16-code-cache/04-relocation-ic.md):IC miss 改的就是它讲的 CompiledIC; [15-c2-compiler/02 — Parse + GraphKit: 字节码→Ideal Graph](openjdk/vol-02/15-c2-compiler/02-c2-parse-graphkit.md):虚调用决策链里 call_generator 的另一半(不内联的调用怎么落地);[23-stub/01 — StubRoutines 全局桩](openjdk/vol-02/23-stub/01-stub-entry.md):桩的生成机制与 CodeBlob 家族
> → **后续**:[21-shared-runtime/02 — 从编译跳到解释: c2i/i2c Adapter](openjdk/vol-02/21-shared-runtime/02-c2i-i2c-adapter.md)
> 关联域: 16-code-cache(CompiledIC/nmethod)、15-c2(编译代码的调用形态)、24-frame(deopt 重建)

## 编译代码的"求救电话"

编译代码被设计成"能自己跑就自己跑"——但它会撞上自己解决不了的事: 内联缓存没命中(IC miss)、缓存的方法失效(wrong method)、符号还没解析、优化假设破产(deopt)、轮询页被保护(safepoint)。这些场景的共同出路是 **SharedRuntime 的桩**: 一段预生成的汇编,保存现场 → 调 C++ 处理 → 恢复现场 → 跳到正确目标,**调用者全程无感知**。这篇拆桩的清单与生成、IC miss 的处理链、deopt 的 unpack。顺带纠正大纲三处: `generate_stubs` 在 sharedRuntime.cpp:99 而非 280-400,且顺序是先 3 个 wrong/ic_miss resolve 再 3 个 resolve;`handle_ic_miss_helper` 实现 :1552 而非 1100-1300;"IC 三态"的实际状态机在 16-code-cache/04 域的 CompiledIC 里,本函数处理的是其中几个特例分支。

## 1. 桩的清单与生成

桩在启动期由 `SharedRuntime::generate_stubs`(sharedRuntime.cpp:99)一次性生成,全部是 CodeCache 里的 RuntimeStub/SafepointBlob/DeoptimizationBlob。清单(sharedRuntime.hpp:57-68 的静态成员):

```cpp
// sharedRuntime.cpp:99-106(截取核心,逐字)
void SharedRuntime::generate_stubs() {
  _wrong_method_blob                   = generate_resolve_blob(CAST_FROM_FN_PTR(address, SharedRuntime::handle_wrong_method),          "wrong_method_stub");
  _wrong_method_abstract_blob          = generate_resolve_blob(CAST_FROM_FN_PTR(address, SharedRuntime::handle_wrong_method_abstract), "wrong_method_abstract_stub");
  _ic_miss_blob                        = generate_resolve_blob(CAST_FROM_FN_PTR(address, SharedRuntime::handle_wrong_method_ic_miss),  "ic_miss_stub");
  _resolve_opt_virtual_call_blob       = generate_resolve_blob(CAST_FROM_FN_PTR(address, SharedRuntime::resolve_opt_virtual_call_C),   "resolve_opt_virtual_call");
  _resolve_virtual_call_blob           = generate_resolve_blob(CAST_FROM_FN_PTR(address, SharedRuntime::resolve_virtual_call_C),       "resolve_virtual_call");
  _resolve_static_call_blob            = generate_resolve_blob(CAST_FROM_FN_PTR(address, SharedRuntime::resolve_static_call_C),        "resolve_static_call");
```

继续: safepoint 轮询 handler 三个变体(`POLL_AT_RETURN`/`POLL_AT_LOOP`/`POLL_AT_VECTOR_LOOP`,后者 COMPILER2_OR_JVMCI 门控,:108-116)→ `generate_deopt_blob`(:118)→ `generate_uncommon_trap_blob`(COMPILER2,:121)。**generate_resolve_blob 是模板**: 6 个 resolve 桩共用同一结构(保存全部寄存器 → 调 C 入口 → 恢复 → 跳目标),差异只是 C 函数指针;**generate_handler_blob** 生成 safepoint 轮询响应代码。桩地址在 StubRoutines 里编译期确定,编译代码对桩是直接 `call`(rel32,5 字节)——不需要查表,这是"求救电话"打得快的原因。大纲的 `generate_stubs 280-400` 与"deopt 第一步"的顺序都是规划期估算,实际以 :99-123 为准。

## 2. IC miss — 缓存没命中怎么透明补救

`invokeinterface/invokevirtual` 的编译代码用内联缓存(16-code-cache/04 域)记录"上次的 receiver klass → 目标方法"。receiver 变成别的类时缓存失效,跳到 `_ic_miss_blob`。它的 C 入口是 `handle_wrong_method_ic_miss`(sharedRuntime.cpp:1421):

```cpp
// sharedRuntime.cpp:1421-1440(截取核心,逐字)
JRT_BLOCK_ENTRY(address, SharedRuntime::handle_wrong_method_ic_miss(JavaThread* thread))
#ifdef ASSERT
  RegisterMap reg_map(thread, false);
  frame stub_frame = thread->last_frame();
  assert(stub_frame.is_runtime_frame(), "sanity check");
  frame caller_frame = stub_frame.sender(&reg_map);
  assert(!caller_frame.is_interpreted_frame() && !caller_frame.is_entry_frame(), "unexpected frame");
#endif /* ASSERT */

  methodHandle callee_method;
  JRT_BLOCK
    callee_method = SharedRuntime::handle_ic_miss_helper(thread, CHECK_NULL);
    // Return Method* through TLS
    thread->set_vm_result_2(callee_method());
  JRT_BLOCK_END
  // return compiled code entry point after potential safepoints
  assert(callee_method->verified_code_entry() != NULL, " Jump to zero!");
  return callee_method->verified_code_entry();
JRT_END
```

处理在 `handle_ic_miss_helper`(:1552,大纲的 :1100-1300 是错的): ①`find_callee_info`(:1559)从栈帧解析出 receiver/字节码/解析结果;②**可静态绑定特例**——`can_be_statically_bound` 时走 `reresolve_call_site`(:1571-1583,注释解释 C1 可能产生"实际上可静态绑定的虚调用点",直接重解析转优化虚调用);③`CompiledIC_lock` 下更新调用点的 CompiledIC(:1617+),处理 `is_optimized`/`is_icholder_call`/普通 miss 各分支(:1625-1641)——**状态机本体(monomorphic/icholder/megamorphic)在 16-code-cache/04 域的 CompiledIC 里**,这里只是按当前状态做对应修补;其中 icholder 分支正是 16-04 篇的 **"FALSE IC miss converting to compiled call"** 场景(TraceCallFixup 字符串 :1644——缓存的是 holder_klass,receiver 匹配且编译代码就绪,转 monomorphic 编译调用);④结果经 **`set_vm_result_2` TLS 返回**——与 Runtime1/解释器的 vm_result 通道同族,返回 `verified_code_entry()`(编译入口或解释器入口)。

**实证**([素材](planning/outlines/00-jvm-tools/materials/commands/21-runtime-stubs-demo.txt)第 1/2 段): 接口调用的两种命运由 **receiver 类型画像**决定——**双态**(Circle/Square 各半): PrintInlining 显示 `TypeProfile (20650/41300 counts)` 两个 receiver 都 `inline (hot)`,C2 生成类型测试 + 两路内联体;三态(再加 Tri): `virtual call`——调用点保持虚调用(IC miss 每轮换 receiver,CompiledIC 升到 megamorphic 后走 vtable/itable 桩——16-04 篇的 set_to_megamorphic;接口调用本就在 itable 语义下)。TraceCallFixup 是 develop(globals.hpp:486)、ICMissHistogram 是 notproduct(:1453)——**IC miss 的直接日志在 release 不可用**,PrintInlining 的类型画像与 virtual call 标记是最近的观察窗。

## 3. DeoptBlob — 优化假设破产后的逃生

C2 基于依赖假设(16-code-cache/05 域)做的激进优化在运行时可能被证伪(新类加载覆盖了"final"假设)——nmethod 被标记失效,但栈上正在执行它的帧必须**当场拆回解释器**。入口是 `DeoptimizationBlob`(codeBlob.hpp:554),它的四个 unpack 偏移(codeBlob.hpp:558-562)对应四种场景:

- `_unpack_offset`: 常规 deopt——PC → scopeDesc → 重建解释器帧(24-frame/03 域的 deopt 机制在这里被调用);
- `_unpack_with_exception`: deopt + 抛出异常;
- `_unpack_with_reexecution`: deopt 后**重执行当前字节码**(陷阱修复路径);
- `_unpack_with_exception_in_tls`: C1 专用,异常与 PC 放 TLS。

unpack 本体是 **x86 层的手写汇编**(`generate_deopt_blob`,sharedRuntime_x86_64.cpp:2810——大纲说"交给 cpu/x86 层"✓): 保存寄存器 → 从 PC 定位 nmethod → 遍历 scopeDesc 内联树 → 逐层重建解释器帧(分配 locals/monitors、把编译帧的值拷进去)→ 切换 RSP → 跳解释器。大纲"栈溢出边缘不调 C++"的推断有合理性(unpack 在可能没有足够栈空间的边缘运行,只能用手写汇编+最小栈操作),但源码没有直证注释,正文不展开; 重执行与异常变体走 `Deoptimization::fetch_unroll_info` 等 C++ 侧准备、汇编侧落地。

*关键设计: 所有桩共享"**保存现场 → 调 VM → 恢复 → 跳转**"的模板——这个模板让 C++ 侧可以安全地做任意复杂的事(锁、解析、GC、deopt),而编译代码的调用点永远只付一次 call 的成本。桩与编译代码在同一个 CodeCache 虚拟地址空间,rel32 一跳即达。*

## 核心悬念

Runtime Stubs 是编译代码的"外部世界接口": 6 个 resolve 桩(IC miss/wrong method/静态虚调用解析)+ 3 个 safepoint 轮询 handler + deopt/uncommon trap 桩,全部由 generate_stubs 一次生成、模板复用。IC miss 链在 CompiledIC_lock 下把调用点从"未解析"推进到"monomorphic/megamorphic",deopt 链在汇编层把编译帧拆回解释器。但桩的入口地址有个前提——**编译代码与解释器之间要能互相跳转**: C2 代码里的解释器调用、解释器里的编译代码调用,入口形态完全不同。下一篇: c2i/i2c adapter。

> → [21-shared-runtime/02 — 从编译跳到解释: c2i/i2c Adapter](openjdk/vol-02/21-shared-runtime/02-c2i-i2c-adapter.md)
