# 01. 编译代码遇到问题——向谁求助？— Runtime Stubs

> 🔴 Deep | 3 KP 中的运行时桩分发
> 读者处境: 编译后的代码在跑——突然遇到 "inline cache miss"——缓存的 Klass 和当前 receiver 不匹配。它不能继续执行——需要回到 VM 重新解析调用目标。这个"回 VM"的入口是一系列 runtime stub。

### 1. "8 个求助入口" — Runtime Stubs 全景
> ⚠️ 写作期修正(2026-08-15, vol-02/21-shared-runtime/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"generate_stubs (sharedRuntime.cpp:280-400)" 行号错(重要)**: 真实 **sharedRuntime.cpp:99-123**;顺序=wrong_method/abstract/ic_miss(3 个 resolve_blob :100-102)→resolve_opt_virtual/virtual/static(:103-105)→**polling handler 3 变体**(POLL_AT_RETURN/LOOP/VECTOR_LOOP,COMPILER2_OR_JVMCI 门控 :108-116)→generate_deopt_blob(:118)→generate_uncommon_trap_blob(COMPILER2 :121);大纲"deopt 第一步"顺序错
> - **"generate_resolve_blob 模板"** ✓(6 个 resolve 桩共用);**"generate_handler_blob"** ✓(:112-116 safepoint 轮询响应)
> - **"x86 call [rip+offset] 5 bytes"** ✓ rel32;但"1 cycle"无据删;桩地址 StubRoutines 编译期确定 ✓
> - **"sharedRuntime.hpp:57-73 清单"** ✓(:57-68 实际 10 个成员)


场景: 编译代码执行时可能遇到 5 种"需要 VM 帮忙"的情况: IC miss(没有缓存正确的调用目标)、wrong method(缓存的方法过时了)、未解析符号引用(还没 link)、deopt(假设破产)、safepoint(需要全局停顿)。

**SharedRuntime 的 stub 清单** (`sharedRuntime.hpp:57-73`):
```
_ic_miss_blob                     → IC miss——vtable traversal + IC upgrade
_wrong_method_blob                → IC 中方法不匹配——resolve + patch
_wrong_method_abstract_blob       → 调了抽象方法——抛 AbstractMethodError
_resolve_static_call_blob         → 静态方法首次调用——符号引用→直接引用
_resolve_virtual_call_blob        → 虚方法首次调用——vtable lookup + patch
_resolve_opt_virtual_call_blob    → 优化虚方法——用 CHA 结果直接内联
_deopt_blob                       → 逆优化——unpack→重建解释栈帧→回解释器
_polling_page_safepoint_handler_* → SIGSEGV→进 safepoint
```
- 源码: `sharedRuntime.hpp:57-73` 静态成员声明
- 关键设计: 每个 stub 是一个 RuntimeStub 对象(存进 CodeCache 的 CodeBlob)——有独立的入口地址。从编译代码到 stub 的跳转是直接 call(无 vtable 查)——因为 stub 地址在 StubRoutines 中是编译时确定的
- [x86: 编译代码→stub 是 `call [rip+offset]`(5 bytes)。stub 地址在 CodeCache 初始段——与所有编译代码在同一虚拟地址空间——跳转距离 <2GB→用 rel32 call→1 cycle 跳转]

**stub 生成流程** (`sharedRuntime.cpp:280-400`):
```
SharedRuntime::generate_stubs():
  1. generate_deopt_blob()           // 交给 cpu/x86 层
  2. generate_handler_blob(rbp, POLL_AT_RETURN)      // safepoint handlers
  3. generate_handler_blob(rbp, POLL_AT_LOOP)
  4. generate_handler_blob(rbp, POLL_AT_VECTOR_LOOP)
  5. generate_resolve_blob(resolve_static_call)        // resolve stubs
  6. generate_resolve_blob(resolve_virtual_call)
  7. generate_resolve_blob(resolve_opt_virtual_call)
```
- 源码: `sharedRuntime.cpp:280-400` generate_stubs
- 关键设计: generate_resolve_blob 是模板——3 个 resolve stub 共用同一结构但指向不同的 resolve 入口(resolve_static_call vs resolve_virtual_call vs resolve_opt_virtual_call)。generate_handler_blob 生成 safepoint 轮询响应代码

### 2. "我找谁？" — IC miss → resolve 链
> ⚠️ 写作期修正(2026-08-15, vol-02/21-shared-runtime/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"handle_ic_miss_helper (sharedRuntime.hpp:335)" 声明对** ✓;**(sharedRuntime.cpp:1100-1300) 实现行号错**: 真实 **:1552**
> - **"find_callee_method" 名字错(归属)**: handle_ic_miss_helper 用 **find_callee_info**(:1559,返回 receiver/bc/CallInfo);find_callee_method(:1213)是**入口帧(entry frame)场景**的另一函数(JavaCalls 调用者查找)
> - **"IC 状态 Clean→Monomorphic→Megamorphic 三步" 简化错(重要)**: 状态机本体在 **16-code-cache/04 域的 CompiledIC**(monomorphic/icholder/optimized/megamorphic);handle_ic_miss_helper 只处理特例分支——**can_be_statically_bound→reresolve_call_site**(:1571-1583,注释解释 C1 可产生"可静态绑定的虚调用点")/is_optimized(:1625-1632)/is_icholder_call(:1633-1641);patch 在 CompiledIC_lock 下(:1617)
> - **"IC stub 保存寄存器→调 VM→resolve→patch→恢复→jmp"** ✓(JRT_BLOCK_ENTRY 模板);**结果经 set_vm_result_2 TLS 返回**(:1435-1438,与 Runtime1 同族);返回 verified_code_entry()
> - **实证**: 双态调用点 TypeProfile 双内联 vs 三态 virtual call(素材第 1/2 段);TraceCallFixup develop(globals.hpp:486)/ICMissHistogram notproduct(:1453)——IC miss 直接日志 release 不可用


场景: 编译代码的 IC 说 "call Foo.bar()"，但 receiver 是 Baz(Foo 的子类)。IC 存的是 Klass=Foo——不匹配→call ic_miss_stub。

**handle_ic_miss_helper** (`sharedRuntime.hpp:335`):
```
IC miss 处理流程:
  1. call _ic_miss_blob (x86 手写 stub——保存寄存器→调 SharedRuntime)
  2. SharedRuntime::handle_ic_miss_helper(thread)
     → find_callee_method(thread)  // 从栈帧找到调用者方法
     → linkResolver::resolve(wt_receiver, receiver klass)
     → 找到实际方法 Method*
  3. 判断 IC 状态:
     - 当前是 Clean → 升级到 Monomorphic(存新 Klass+Method)
     - 当前是 Monomorphic → receiver 不同→升级到 Megamorphic
  4. patch call site (改 IC 的 target address)
  5. 跳转到新方法——透明完成(调用者无感知)
```
- 源码: `sharedRuntime.cpp:1100-1300` handle_ic_miss_helper
- 关键设计: IC miss 的处理是透明的——调用者不知道"我刚才调了一个要解析的方法"。IC stub 保存所有寄存器(callee-saved+caller-saved)→调 VM→resolve→patch→恢复寄存器→jmp 到新 target。中间发生的 GC/deopt 都被隔离——调用者仍在 "call 方法" 的抽象中

**wrong_method 处理** (`sharedRuntime.hpp:54-55`):
```
wrong method 不同于 IC miss:
  - IC miss: receiver klass 变了→caller 缓存的方法对但 receiver 不对
  - wrong method: 缓存的 Method 对象本身失效了(类重定义/deopt)→caller 需要完全不同的方法
  - 处理: _wrong_method_blob → find_callee_method(重新找方法+class)→重新 resolve→patch
```

### 3. "我不行了——回解释器" — deopt_blob
> ⚠️ 写作期修正(2026-08-15, vol-02/21-shared-runtime/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"DeoptimizationBlob (sharedRuntime.hpp:65)"** ✓(_deopt_blob 声明);**codeBlob.hpp:554-634** ✓(class DeoptimizationBlob :554)
> - **"4 个 unpack 变体"** ✓(_unpack_offset/_unpack_with_exception/_unpack_with_reexecution/_unpack_with_exception_in_tls,codeBlob.hpp:558-562)
> - **"generate_deopt_blob 交给 cpu/x86 层"** ✓(sharedRuntime_x86_64.cpp:2810)
> - **"栈溢出边缘不调 C++" 是推断**: unpack 手写汇编属实,但"nested SIGSEGV"动机无源码注释直证——正文明确标注为推断不展开;"safe read 触碰页"无据删
> - **unpack 流程**: PC→nmethod→scopeDesc 内联树→重建解释器帧(24-frame/03 域的 deopt 机制);重执行/异常变体=Deoptimization::fetch_unroll_info C++ 准备+汇编落地


场景: C2 编译的方法基于"Foo 是 final"做激进内联→运行时新加载了 Bar(覆盖 Foo::bar)。依赖假设破了→需要 deopt 回解释器。

**deopt_blob 结构** (`sharedRuntime.hpp:65`):
```
DeoptimizationBlob:
  - unpack() — 正常 deopt: PC→scope→重建解释器帧
  - unpack_with_exception — deopt + 抛异常
  - unpack_with_reexecution — deopt + 重执行(rare trap 修复后)
  - unpack_with_exception_in_tls — C1 专用(exception/pc 在 TLS)
```
- 源码: `sharedRuntime.hpp:65` + `code/codeBlob.hpp:554-634` DeoptimizationBlob 完整定义
- 关键设计: deopt_blob 是一段手写汇编——不调 C++(因为 deopt 可能发生在栈溢出边缘——调 C++ 导致 nested SIGSEGV)。直接从 PC 找到 nmethod→scopeDesc 遍历内联树→重建解释器帧(每个 scope 分配 local array+monitor array)→RSP 切到解释器帧→jmp 解释器
- [x86: unpack 的汇编: push saved registers from nmethod→find scope at pc→for each inline level: allocate locals→copy values from compiled frame→link new frame to previous→restore bcp→jmp interpreter entry。在栈溢出场景中 RSP 可能低于 guard page→unpack 用 safe read(volatile load)触碰每个分配页避免 SIGSEGV]

---

### 核心悬念

**"SharedRuntime 的 8+ 个 stub 覆盖编译代码的全生命周期——IC miss→resolve→patch、wrong method→re-resolve、deopt→unpack→解释器。所有 stub 通过 'save all regs→call VM→restore→jmp' 的模板隔离调用者。"** — 但方法怎么从编译跳到解释？下一篇: c2i/i2c adapter。

> → [02-c2i-i2c-adapter.md](02-c2i-i2c-adapter.md)
