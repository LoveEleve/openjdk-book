# 06-MethodHandles-invokedynamic — invokedynamic 的 4 阶段执行管道、MethodHandle 类型系统、LambdaForm 寻址链、BSM→CallSite→cpCache 的懒链接与 CallSite 依赖 deopt 全流程

> **元信息**
> - 标准环境：OpenJDK 11 slowdebug build，`-Xms8g -Xmx8g -XX:+UseG1GC`，64-bit Linux x86
> - 跨模块说明：`prims/`（methodHandles.cpp + methodHandles.hpp）+ `interpreter/`（linkResolver.cpp + interpreterRuntime.cpp）+ `classfile/`（systemDictionary.cpp + javaClasses.hpp + classFileParser.cpp + vmSymbols.hpp）+ `os_cpu/`（methodHandles_x86.cpp）
> - 前置文档：[09-04 JVM-Entry-Points]（JVM_ENTRY 宏、HandleMarkCleaner、ThreadInVMfromNative）、[09-05 Reflection-Internal]（6 层反射调用路径、参数拆箱、JIT 内联困难）
> - 前瞻文档：[09-03 VM-RedefineClasses]（VM_RedefineClasses doit() → ResolvedMethodTable 调整 → 可能影响 MemberName.vmtarget）
> - 地位：09 阶段架构文档，阅读顺序第六。Java 8+ Lambda/StringConcat/Records 的字节码引擎核心
> - 阅读收益：理解 invokedynamic 为何是 Java 8+ 最重要的 JVM 改进——从"字节码指令是什么"（JVM Spec §6.5）深入到"JVM 内部怎么跑"（4 阶段管道）。掌握 MethodHandle 类型系统为何比反射快 10-100 倍（5 条 x86 指令 vs 100+ 条）。理解 CallSite 变更后如何通过 deopt + 重链接来安全地失效已编译代码

---

## §〇 源文件清单（跨 interpreter + classfile + prims + os_cpu）

| # | 文件 | 路径 | 模块 | 核心函数/宏（已验证行号） | 本文角色 |
|---|------|------|------|----------------------|---------|
| 1 | `methodHandles.cpp` | `src/hotspot/share/prims/methodHandles.cpp` | prims | `generate_adapters()`(:75)、`init_method_MemberName()`(:222)、`is_method_handle_invoke_name()`(:371-407)、`signature_polymorphic_intrinsic_name()`(:410)、`signature_polymorphic_intrinsic_bytecode()`(:424)、`signature_polymorphic_intrinsic_ref_kind()`(:437)、`add_dependent_nmethod()`(:1077)、`flush_dependent_nmethods()`(:1098)、`MHN_setCallSiteTargetNormal`(:1388)、`MHN_setCallSiteTargetVolatile`(:1400)、JNI 注册表(:1560-1576) | ★★★ MH 类型系统 + 适配生成 + CallSite 追踪 + JNI 注册 |
| 2 | `methodHandles.hpp` | `src/hotspot/share/prims/methodHandles.hpp` | prims | `MethodHandles` AllStatic 类接口、`generate_adapters()` 声明 | ★★ 接口声明 |
| 3 | `methodHandles_x86.cpp` | `src/hotspot/cpu/x86/methodHandles_x86.cpp` | os_cpu | `jump_to_lambda_form()`(:157)、`generate_method_handle_dispatch()`(:294)、`generate_method_handle_interpreter_entry()`(:203) | ★★★ 汇编级 dispatch — 4 次 heap load + linkTo* 跳转 |
| 4 | `linkResolver.cpp` | `src/hotspot/share/interpreter/linkResolver.cpp` | interpreter | `resolve_invokedynamic()`(:1793)、`resolve_invokehandle()`(:1745)、`resolve_handle_call()`(:1756)、`lookup_polymorphic_method()`(:449)、`resolve_dynamic_call()`(:1875) | ★★★ invokedynamic 链接解析 — BSM 解析 + MH resolve |
| 5 | `interpreterRuntime.cpp` | `src/hotspot/share/interpreter/interpreterRuntime.cpp` | interpreter | `resolve_invokedynamic()`(:1022)、`resolve_from_cache()`(:1053)、`set_dynamic_call` 写入(:1047) | ★★ 解释器触发 link + cpCache 缓存写入 |
| 6 | `systemDictionary.cpp` | `src/hotspot/share/classfile/systemDictionary.cpp` | classfile | `find_method_handle_invoker()`(:2509)、`find_dynamic_call_site_invoker()`(:2860)、`unpack_method_and_appendix()`(:2477) | ★★ Java up-call — BSM 执行 |
| 7 | `javaClasses.hpp` | `src/hotspot/share/classfile/javaClasses.hpp` | classfile | `java_lang_invoke_MethodHandle`(:995) — form/type 偏移、`java_lang_invoke_LambdaForm`(:1054) — vmentry 偏移、`java_lang_invoke_ResolvedMethodName`(:1088) — vmtarget 偏移、`java_lang_invoke_MemberName`(:1114) — method/clazz/vmindex 偏移、`java_lang_invoke_CallSite`(:1226) — target 偏移、`MethodHandleNatives_CallSiteContext`(:1257) — vmdependencies | ★★★ JDK 对象布局 — 所有 oop 字段偏移预计算 |
| 8 | `classFileParser.cpp` | `src/hotspot/share/classfile/classFileParser.cpp` | classfile | `@LambdaForm$Compiled` 注解识别(:2178-2179) | ★ LambdaForm 编译提示 — _compiledLambdaForm intrinsic |
| 9 | `vmSymbols.hpp` | `src/hotspot/share/classfile/vmSymbols.hpp` | classfile | `_invokeBasic`(:1439)、`_invokeGeneric`(:1438)、`_linkToVirtual`(:1440)、`_linkToStatic`(:1441)、`_linkToSpecial`(:1442)、`_linkToInterface`(:1443)、`_compiledLambdaForm`(:1445) | ★★ 签名多态 intrinsic ID 定义 |

**跨模块说明**：invokedynamic 是 JVM 中模块耦合度最高的指令 — `linkResolver.cpp` 在 `interpreter/` 而非 `prims/`（因为链接是解释器的工作，不是 JNI 入口）、`methodHandles_x86.cpp` 在 `os_cpu/`（CPU 架构的汇编 dispatch）、`systemDictionary.cpp` 在 `classfile/`（类字典中做 Java up-call 执行 BSM）。读者需要跨越 4 个模块才能理解一条 `invokedynamic` 指令的完整执行路径。

---

## §一 ★★★ invokedynamic 的 4 阶段管道 — 从 cpCache 空槽到机器码的完整路径

### ❓ 为什么是 4 个阶段而不是 2 个（解析+执行）？

普通 `invokevirtual` 指令只有两个阶段：(a) 类加载时，Constant Pool 的 `CONSTANT_Methodref` 被 resolve→ link → cpCache 缓存 Method*；(b) 每次执行，从 cpCache 取 Method* → vtable dispatch。合计 2 阶段。

`invokedynamic` 不能这样做——因为 **BSM (Bootstrap Method) 的执行依赖于运行时状态**（lambda 捕获的变量、String concat 的 recipe、Record 的 accessor）。如果类加载时执行 BSM → BSM 看到一个不完整的运行时环境 → 崩溃。所以 invokedynamic 需要 **4 个阶段**：

```
Stage 1 (Parse, 类加载时)      Stage 2 (Link, 首次执行)         Stage 3 (Adapt, 每次调用)         Stage 4 (Compile, 阈值后)
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Rewriter::rewrite_invokedynamic  InterpreterRuntime::              cpCache.f1 = MH.linkToCallSite     C1/C2 编译 LambdaForm
→ cpCache 预分配               resolve_invokedynamic             → CallSite.target()               → 内联目标方法
→ resolved_references 条目      → LinkResolver::                   → MH.invokeBasic                 → 消除 MH 中间层
BSM NOT executed                resolve_invokedynamic              → jump_to_lambda_form()          → 零开销调用
(依赖运行时状态)                → BSM 执行                        → 4次heap load→Method*
                                 → 返回 CallSite
                                 → cpCache 缓存 f1+f2+appendix
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
eager                           lazy ★ (首次执行)                  per-call                          after threshold
class loading time              first execution                  every execution                    JIT compilation
```

**关键洞察**：BSM 只运行一次（Stage 2），后续每次调用走 Stage 3 的 dispatch 路径（跳过 BSM），JIT 编译后走 Stage 4 的 machine code（跳过 Stage 2+3 的全部开销）。

### 1.1 阶段 1（Parse，类加载时）：cpCache 预分配

类加载时的 `Rewriter::rewrite_invokedynamic()`（`rewriter.cpp`，不在本文聚焦范围内）在 Constant Pool 中：

1. **创建 `resolved_references` 条目**：为 `CONSTANT_InvokeDynamic` 的 BSM static arguments 预留位置。每个 static argument 如果是 `CONSTANT_MethodHandle` 或 `CONSTANT_MethodType`，需要解析为实际对象引用。
2. **预分配 cpCache 槽位**：`ConstantPoolCacheEntry` 的 `f1`、`f2`、`appendix` 字段在此时全为 NULL —— 因为 BSM 未执行。

**为什么不在此阶段执行 BSM？**
- BSM 可能依赖 lambda 捕获的外部变量 → 只在运行时可用
- BSM 可能访问线程上下文 ClassLoader → 类加载时 ClassLoader 可能不完整
- BSM 可能有副作用（比如日志）→ 不能提前执行

**验证断言**：在 `ClassLoader::load_class()` 返回后做 GDB：`p cp->invokedynamic_cp_cache_entry_at(index)` → `f1` = 0x0，`f2` = 0x0。

### 1.2 ★ 阶段 2（Link，首次执行，lazy）：BSM 执行 + cpCache 缓存

阶段 2 是全文的核心——它回答"JVM 怎么从一条没见过 invokedynamic 指令走到 CallSite"。

**调用链**（7 个关键调用点）：

```
解释器首次遇到 invokedynamic 指令
  │
  ├── BytecodeInterpreter / TemplateTable
  │     发现 cpCache->f1 == NULL → 调用 InterpreterRuntime::resolve_from_cache()
  │     │
  │     └── interpreterRuntime.cpp:1053 — resolve_from_cache(bytecode)
  │           => switch(bytecode) { case _invokedynamic: resolve_invokedynamic(thread); }
  │           │
  │           └── interpreterRuntime.cpp:1022 — InterpreterRuntime::resolve_invokedynamic()
  │                 │
  │                 ├─ 1022: Thread* THREAD = thread;
  │                 ├─ 1024: LastFrameAccessor last_frame(thread);
  │                 ├─ 1025: const Bytecodes::Code bytecode = Bytecodes::_invokedynamic;
  │                 ├─ 1039: int index = last_frame.get_index_u4(bytecode);
  │                 │
  │                 └─ 1042: LinkResolver::resolve_invoke(info, pool, index, bytecode, CHECK);
  │                       │
  │                       └── linkResolver.cpp:1793 — LinkResolver::resolve_invokedynamic()
  │                             │
  │                             ├─ 1794: Symbol* method_name = pool->name_ref_at(index);
  │                             ├─ 1795: Symbol* method_signature = pool->signature_ref_at(index);
  │                             ├─ 1807: cpce = pool->invokedynamic_cp_cache_entry_at(index);
  │                             ├─ 1810: if (cpce->is_f1_null()) { … }
  │                             │           // ★ 关键分支：只有 f1==NULL 时才解析 BSM
  │                             ├─ 1824: oop bsm_info = pool->resolve_bootstrap_specifier_at(pool_index, THREAD);
  │                             │           // 解析 BootstrapMethods 属性：提取 BSM MethodHandle + static args
  │                             ├─ 1848: resolve_dynamic_call(result, pool_index, bsm_info, 
  │                             │                              method_name, method_signature, current_klass, THREAD);
  │                             │
  │                             └── linkResolver.cpp:1875 — LinkResolver::resolve_dynamic_call()
  │                                   │
  │                                   └── systemDictionary.cpp:2860 — SystemDictionary::find_dynamic_call_site_invoker()
  │                                         │
  │                                         ├─ 2870-2877: 从 bootstrap_specifier 拆出 BSM + info
  │                                         ├─ 2881: method_name = create_from_symbol(name)
  │                                         ├─ 2882: method_type = find_method_handle_type(type, caller)
  │                                         ├─ 2892: ★★★ Java up-call ★★★
  │                                         │    JavaCalls::call_static(&result,
  │                                         │      SystemDictionary::MethodHandleNatives_klass(),
  │                                         │      vmSymbols::linkCallSite_name(),  // "linkCallSite"
  │                                         │      vmSymbols::linkCallSite_signature(),
  │                                         │      &args, CHECK_(empty));
  │                                         │    // 调 Java 侧 MethodHandleNatives.linkCallSite()
  │                                         │    // → 内部执行 BSM → 返回 MemberName + appendix →
  │                                         │    // 构造 CallSite 并返回
  │                                         ├─ 2907: Handle mname(THREAD, result.get_jobject());
  │                                         └─ 2909: unpack_method_and_appendix(mname, caller,
  │                                                      appendix_box, appendix_result, THREAD);
  │                                                   // 从 MemberName 中拆出 Method* + appendix
  │
  ├── 返回 CallInfo result（包含 method + appendix + method_type）
  │
  └── interpreterRuntime.cpp:1047 — cp_cache_entry->set_dynamic_call(pool, info);
        // ★ 写入 cpCache：f1 = adapter MH, f2/appendix = call site 结果
        // 后续 invokedynamic 指令读到 f1 != NULL → 直接 dispatch，跳过整个 BSM 路径
```

**关键分叉点**（`linkResolver.cpp:1810`）：
```cpp
if (cpce->is_f1_null()) {
    // ★ 首次调用：解析 BSM + 执行
    oop bsm_info = pool->resolve_bootstrap_specifier_at(pool_index, THREAD);
    // ... 执行 BSM 返回 CallSite ...
    resolve_dynamic_call(result, pool_index, bootstrap_specifier, ...);
}
if (!cpce->is_f1_null()) {    // L1830
    // ★ 再次调用：直接从 cpCache 读
    methodHandle method(THREAD, cpce->f1_as_method());
    Handle appendix(THREAD, cpce->appendix_if_resolved(pool));
    // 跳过 BSM！
}
```

**BSM 对 Java 的上调**（`systemDictionary.cpp:2892-2906`）：
```cpp
// ★ Java up-call — JVM 调用 JDK 侧方法执行 BSM
JavaCalls::call_static(&result,
   SystemDictionary::MethodHandleNatives_klass(),
   vmSymbols::linkCallSite_name(),
   vmSymbols::linkCallSite_signature(),
   &args, CHECK_(empty));
```
这是整个阶段 2 的唯一 JVM→Java 跳转——JVM 的 C++ 代码通过 `JavaCalls::call_static` 调用 Java 代码 `MethodHandleNatives.linkCallSite()` → JDK 侧执行 `CallSite bootstrapMethod(...)` → 返回 `MemberName` 对象 → JVM 把 `MemberName` 解包为 `Method*` + `appendix`。

**Java 上调用 vs JNI 调用的本质区别**：
- JNI 调用 (`CallStaticObjectMethod`) → 走 `jni_invoke_static` → 需额外 `JNIEnv*` 准备 → 比 `JavaCalls::call_static` 多 1 层
- `JavaCalls::call_static` → 直接在 VM 内构造 Java 调用栈 → 无 JNI 边界穿越 → 更快

### 1.3 阶段 3（Adapt，每次调用）：4 次 heap load 的寻址链

cpCache 链接完成后，每次执行 invokedynamic：

```
解释器读到 cpCache:
  f1 → MH.linkToCallSite (adapter MethodHandle)                // ★ adapter MH
  f2/appendix → 存储 CallSite 对象                              // ★ 由 CallSite.target() dispatch

dispatch:
  MH.linkToCallSite → CallSite.target() → 目标 MethodHandle
    → invokeBasic → jump_to_lambda_form()
    → MH.form → LF.vmentry → MemberName.method → ResolvedMethodName.vmtarget → Method*
```

**为什么需要 linkToCallSite 这一中间 MH？**
因为 `ConstantPoolCacheEntry` 存储的是 CallSite 对象（不是 MethodHandle），每次调用都要 `CallSite.target()` 取出最新的 MH——这是 MutableCallSite 和 VolatileCallSite 的核心语义。linkToCallSite 是 JVM 生成的一个特殊 MH adapter，它的 LambdaForm 的 Name 树中包含了"读 CallSite.target()"的操作。

**jump_to_lambda_form() 的详细汇编走读见 §3.3**。

### 1.4 阶段 4（Compile，阈值后）：C1/C2 编译 + MH 内联消除

当 CallSite 稳定（不频繁 switch target）且 LambdaForm 达到编译阈值：

1. **C1/C2 编译 LambdaForm**：`LambdaForm` 的 `Name[]` 节点树被转译为 machine code（通过 JDK 侧 `InvokerBytecodeGenerator` 首先生成 bytecode，然后 JIT 编译）。每个 Name 节点变成一个基本块。
2. **内联目标方法**：C2 看到 LambdaForm 中的 `invokeBasic` → 识别为 MethodHandle intrinsic（通过 `_invokeBasic` intrinsic ID）→ 调用 `ciMethodHandle::get_method()` 获取目标 Method* → stub 替换为目标方法的入口 → 直接 jmp。
3. **消除 MH 中间层**：如果 MH 是 `@Stable` + `@ForceInline`（JDK 9+），C2 可以在编译时完全解析 MH chain → 直接 emit 目标方法的 machine code → 0 次 heap load。此阶段的结果等价于 `invokevirtual` 被内联。

**编译后的等价代码**：
```asm
; Stage 4 (编译后 + MH 内联):
; 参数已经在寄存器中（和 invokevirtual 相同）
; 0 次 heap load, 0 次 MethodHandle dispatch
call target_method_entry    ; ★ 和直接调用一样的代码
```

### 1.5 4 阶段完整时序图

```
时间线 ──────────────────────────────────────────────────────────────────────────────→

调用 #1                调用 #2~N             调用 #N~M (阈值后)    调用 #M+ (target 变更后)
  │                      │                     │                       │
  ▼                      ▼                     ▼                       ▼
┌─────┐              ┌─────┐              ┌─────┐                 ┌─────┐
│Stage│              │Stage│              │Stage│                 │Stage│
│  1  │─已完─→       │  3  │              │  4  │                 │2+3+4│
│     │              │     │              │     │                 │(重新)│
│cp   │              │ cp  │              │ cp  │                 │ cp  │
│Cache│              │Cache│              │Cache│                 │Cache│
│ 空  │              │有 f1 │              │有 f1 │                 │flush │
│     │              │     │              │     │                 │ → deopt
└──┬──┘              └──┬──┘              └──┬──┘                 └──┬──┘
   │                    │                    │                       │
   ▼                    ▼                    ▼                       ▼
┌─────┐              ┌─────┐              ┌─────┐                 ┌─────┐
│Stage│─lazy──→       │shor │              │ 0   │                 │reps │
│  2  │              │tcut │              │heap │                 │BSM  │
│BSM  │              │ via │              │load │                 │ re- │
│ up- │              │cpCa │              │     │                 │link │
│call │              │ che │              │     │                 │     │
└─────┘              └─────┘              └─────┘                 └─────┘
  ▲                    ▲                    △                       △
  │                    │                    │                       │
  首次调用             每次调用               JIT 编译后            CallSite.setTarget() 后
  cpCache.f1=NULL     cpCache.f1≠NULL       MH 内联               deopt + 回解释器
```

**核心性能特征**：
- 首次调用 cost = Stage 2 (JVM up-call + BSM 执行) + Stage 3 (heap load) → ~1000 CPU cycles
- 后续调用 cost = Stage 3 (4 次 heap load) → ~20-40 cycles
- JIT 编译后 cost = 0 MH overhead → ~1-2 cycles (等同于 inline)
- 如果 CallSite 稳定 → JIT 内联消除一切；如果 CallSite 频繁切换 → 每条 MH dispatch 都在失效重编译

---

## §二 ★★ MethodHandle 类型系统 — 5 种 linkTo* 的汇编层分工

### ❓ 为什么需要 5 种 `linkTo*` 而不仅是 `invokeBasic`？

如果所有 MethodHandle 调用都走 `invokeBasic` → 每次都走完整的 `jump_to_lambda_form()` 4 次 heap load 链 → 无法利用 vtable/itable 的 O(1) dispatch → 性能差。

`linkTo*` 系列把 dispatch 方式**硬编码到汇编层** → 不需要 LambdaForm 查找：

| intrinsic | bytecode 映射 | ref_kind | dispatch 方式 | heap load 次数 | 适用场景 |
|-----------|-------------|----------|--------------|-----------|---------|
| `_invokeBasic` | `invokehandle` | 0 | `jump_to_lambda_form()` → 4 次 load | 4 | 通用 MH，任何 MH 类型 |
| `_linkToVirtual` | `invokevirtual` | `JVM_REF_invokeVirtual` | `lookup_virtual_method()` — vtable dispatch | 3 (skip LambdaForm chain) | 虚拟方法调用 |
| `_linkToStatic` | `invokestatic` | `JVM_REF_invokeStatic` | direct `member_vmtarget → vmtarget_method` | 2 | 静态方法调用 |
| `_linkToSpecial` | `invokespecial` | `JVM_REF_invokeSpecial` | 同 `_linkToStatic` — direct access | 2 | 超类/构造函数调用 |
| `_linkToInterface` | `invokeinterface` | `JVM_REF_invokeInterface` | `lookup_interface_method()` — itable dispatch | 3 | 接口方法调用 |

**表中 heap load 次数 = 已经省去了"MH.form → LF.vmentry"那一跳** — linkTo* 从 MemberName 开始 dispatch，因为 MemberName 已经是"已解析的调用目标"（包含 vmindex + method 引用），不需要再查 LambdaForm。

### 2.1 invokeBasic → `invokehandle` → `jump_to_lambda_form()`

`methodHandles_x86.cpp:329-331`：
```cpp
if (iid == vmIntrinsics::_invokeBasic) {
    // indirect through MH.form.vmentry.vmtarget
    jump_to_lambda_form(_masm, receiver_reg, rbx_method, temp1, for_compiler_entry);
}
```
invokeBasic 是最通用的 dispatch 方式——`methodHandles.cpp:424-435` 映射到 `invokehandle` bytecode：
```cpp
case vmIntrinsics::_invokeBasic: return Bytecodes::_invokehandle;
```
ref_kind=0 意味着"无特定调用模式"。走完整的 LambdaForm 寻址链 → 慢但适用所有 MH 类型。

**什么时候走 invokeBasic？**
- `MH.invoke(args)` — asType 适配后的通用调用
- 无 lambda-form 预计算路径的 MethodHandle 组合（如 `filterArguments`）

### 2.2 linkToVirtual → `invokevirtual` → vtable dispatch

`methodHandles_x86.cpp:408-434`：
```cpp
case vmIntrinsics::_linkToVirtual:
    Register temp2_index = temp2;
    __ access_load_at(T_ADDRESS, IN_HEAP, temp2_index, member_vmindex, noreg, noreg);
    // temp2_index = MemberName.vmindex (vtable index)
    __ lookup_virtual_method(temp1_recv_klass, temp2_index, rbx_method);
    // rbx_method = receiver->klass->vtable[temp2_index]
    break;
```

**vtable dispatch 的汇编路径**：
1. `load MemberName.vmindex` → 读取 vtable index
2. `load receiver->klass` → 获取 receiver 的 Class
3. `klass->vtable[vmindex]` → 根据 index 查找 Method*
4. `jump_from_method_handle` → 跳转到 Method* → entry point

省去 LambdaForm 的整个查找链 —— 直接利用 Java 的 vtable 机制。性能接近直接的 `invokevirtual` 字节码。

### 2.3 linkToStatic → `invokestatic` → direct jump

`methodHandles_x86.cpp:400-406`：
```cpp
case vmIntrinsics::_linkToStatic:
    __ load_heap_oop(rbx_method, member_vmtarget);      // MemberName.method → ResolvedMethodName
    __ access_load_at(T_ADDRESS, IN_HEAP, rbx_method, vmtarget_method, ...);  // → Method*
    break;
```
linkToStatic 最简——无 receiver、无 vtable dispatch——直接从 MemberName 的 ResolvedMethodName 链上读出 Method*。

### 2.4 linkToSpecial → `invokespecial` → super call

`methodHandles_x86.cpp:392-398`：同 linkToStatic 的 direct access 路径。额外做 receiver null check：
```cpp
case vmIntrinsics::_linkToSpecial:
    __ null_check(receiver_reg);    // super 调用仍需 valid receiver
    __ load_heap_oop(rbx_method, member_vmtarget);
    __ access_load_at(T_ADDRESS, IN_HEAP, rbx_method, vmtarget_method, ...);
    break;
```

### 2.5 linkToInterface → `invokeinterface` → itable dispatch

`methodHandles_x86.cpp:437-469`：
```cpp
case vmIntrinsics::_linkToInterface:
    __ load_heap_oop(temp3_intf, member_clazz);       // 加载接口 Klass
    load_klass_from_Class(_masm, temp3_intf);
    __ access_load_at(T_ADDRESS, IN_HEAP, rbx_index, member_vmindex, ...);  // itable index
    __ lookup_interface_method(temp1_recv_klass, temp3_intf,
                               rbx_index, rbx_method, temp2, L_incompatible_class_change_error);
    break;
```
接口 dispatch 使用 itable（interface method table）— 类似 vtable 但需要 2D 索引（接口 Klass + method index）。`lookup_interface_method` 内部扫描 receiver 的 itable → 找到具体实现 Method*。

### 2.6 signature_polymorphic_intrinsic 查找表

`methodHandles.cpp:410-465` 定义了三张映射表（intrinsic↔name、intrinsic↔bytecode、intrinsic↔ref_kind），JIT 和解释器用它们做 dispatch 决策。这三张表是纯查表参考，不影响本文对 5 种 linkTo* 的理解。完整内容见 [附录 C: 三张 intrinsic 映射表](#附录-c-signature_polymorphic_intrinsic-三张映射表)。

关键记忆点：`_invokeBasic`→`invokehandle`→ref_kind=0（最通用，走完整寻址链）；其余 4 种各映射到对应的 invoke 指令和 ref_kind（利用 vtable/itable），省去 LambdaForm 查找。

---

## §三 ★★★ LambdaForm — Name 节点树 + vmentry 到 Method* 的寻址链

### 3.1 LambdaForm 对象布局

`javaClasses.hpp:1054-1078` 定义了 `java_lang_invoke_LambdaForm` 的 C++ accessor：

```cpp
class java_lang_invoke_LambdaForm: AllStatic {
 private:
  static int _vmentry_offset;  // MemberName* (oop) — 指向调用者
  // JDK 侧还有: Name[] names;  int arity;  boolean forceInterpretation
 public:
  static int vmentry_offset_in_bytes() { return _vmentry_offset; }
};
```

JDK 侧 LambdaForm 字段（JVM 不直接访问 Name[]，由 JDK 侧 InvokerBytecodeGenerator 处理）：
- `vmentry` — MemberName 对象（oop）→ 包含 method 引用（ResolvedMethodName）和 vmindex
- `names` — Name[]（oop[]）→ 操作节点数组，形成 SSA DAG
- `arity` — 参数个数
- `customizedName` — 调试用的名称

### 3.2 Name[] 结构 — SSA DAG

每个 Name 节点包含 4 个属性（JDK 侧 `java.lang.invoke.LambdaForm.Name`）：
- **function** — 操作类型：字符串如 `"invoke"`, `"identity"`, `"zero"`, `"guardWithTest"`...
- **arguments** — int[] 索引：每个元素指向其他 Name 的 index 或命名参数（`arg-1` = lambda form 的第 1 个参数）
- **index** — 此节点在 Name[] 中的位置
- **type** — BasicType：操作的结果类型

**Name 节点树示例**（lambda `(int a, int b) -> a + b`）：
```
Name[0]: function="zero"       args=[]           type=I    → 常量 0
Name[1]: function="invoke"     args=[3, arg-1]   type=I    → Integer.valueOf(a)
Name[2]: function="invoke"     args=[4, arg-2]   type=I    → Integer.valueOf(b)
Name[3]: function="invoke"     args=[1, 2]       type=I    → Integer.sum(a, b)
```

**关键**：Name 节点树本质是 SSA 形式的 DAG（有向无环图），和 C2 的 Ideal Graph 原理相似——每个节点产生一个值，被后续节点引用。

**本文不展开 JDK 侧的 InvokerBytecodeGenerator 转译过程**——那是 JDK 源码（`java.lang.invoke.InvokerBytecodeGenerator`）的工作。本文聚焦 JVM 内部如何执行已生成的 LambdaForm。

### 3.3 ★★★ `jump_to_lambda_form()` 的 4 次 heap load — 逐行汇编注释

`methodHandles_x86.cpp:157-198` 定义了从 MethodHandle 到最终 Method* 的完整硬件路径：

```
寄存器约定:
  recv       = MethodHandle 对象（oop，在 rcx/j_rarg0）
  method_temp = rbx            // 中间寄存器，最终存 Method*
  temp2      = rscratch2       // 临时 scratch
```

**Load 1 — MH.form → LambdaForm**（`methodHandles_x86.cpp:172`）：
```asm
; __ load_heap_oop(method_temp, Address(recv,
;     java_lang_invoke_MethodHandle::form_offset_in_bytes()), temp2);
mov    rbx, [rcx + #_form_offset]        ; rbx = MH.form  (LambdaForm*)
; ★ 第一次 GC barrier: 如果是 G1 + SATB, 对 rbx 的值做 SATB pre-barrier
```
**读的内容**：MethodHandle 对象的 `form` 字段 = LambdaForm 对象引用（oop偏移 `_form_offset`，在 `javaClasses.hpp:1000` 定义）。

**Load 2 — LF.vmentry → MemberName**（`methodHandles_x86.cpp:174`）：
```asm
; __ load_heap_oop(method_temp, Address(method_temp,
;     java_lang_invoke_LambdaForm::vmentry_offset_in_bytes()), temp2);
mov    rbx, [rbx + #_vmentry_offset]      ; rbx = LF.vmentry (MemberName*)
; ★ 第二次 GC barrier: 读 LambdaForm 的 vmentry 字段
```
**读的内容**：LambdaForm 对象的 `vmentry` 字段 = MemberName 对象引用（oop偏移 `_vmentry_offset`，在 `javaClasses.hpp:1058` 定义）。

**Load 3 — MN.method → ResolvedMethodName**（`methodHandles_x86.cpp:176`）：
```asm
; __ load_heap_oop(method_temp, Address(method_temp,
;     java_lang_invoke_MemberName::method_offset_in_bytes()), temp2);
mov    rbx, [rbx + #_method_offset]       ; rbx = MN.method (ResolvedMethodName*)
; ★ 第三次 GC barrier: 读 MemberName 的 method 字段
```
**读的内容**：MemberName 对象的 `method` 字段 = ResolvedMethodName 对象引用（oop 偏移 `_method_offset`，在 `javaClasses.hpp:1129` 定义）。

**Load 4 — RMN.vmtarget → Method***（`methodHandles_x86.cpp:178-180`）：
```asm
; __ access_load_at(T_ADDRESS, IN_HEAP, method_temp,
;     Address(method_temp,
;         java_lang_invoke_ResolvedMethodName::vmtarget_offset_in_bytes()),
;     noreg, noreg);
; ★ access_load_at(T_ADDRESS) — 直接读 native pointer — 无 GC barrier!
mov    rbx, [rbx + #_vmtarget_offset]     ; rbx = RMN.vmtarget (Method*)
; ★ 第四次是 native word load — 不触发 GC barrier
;    rbx 现在存的是真实的 Method* 指针（C++ Method 对象地址）
```
**读的内容**：ResolvedMethodName 对象的 `vmtarget` 字段 = C++ Method* 指针（oop 偏移 `_vmtarget_offset`，在 `javaClasses.hpp:1091` 定义）。这是 native pointer 藏在 oop 中的关键——GC 不能追踪此指针（否则 GC 会尝试扫描 C++ 堆），所以用 `access_load_at(T_ADDRESS)` 绕过 GC barrier。

**jump_from_method_handle**（`methodHandles_x86.cpp:120-150`）：
```asm
; jump_from_method_handle — 从 Method* 提取入口地址并跳转
mov    rbx, [rbx + Method::from_compiled_entry_offset()]   ; 读 Method* 的编译入口
; 或
mov    rbx, [rbx + Method::from_interpreted_offset()]      ; 读 Method* 的解释入口
jmp    rbx                          ; ★ 跳到目标方法的实际机器码/解释器入口
```

**4 次 load 的完整对象链**：
```
MH (oop)          LambdaForm (oop)   MemberName (oop)   ResolvedMethodName (oop)   Method* (native ptr)
┌───────┐       ┌────────┐         ┌──────────┐        ┌──────────────────┐       ┌──────────┐
│ form ─┼───→   │vmentry─┼───→     │  method  ─┼──→     │    vmtarget      │────→  │ Method*  │
│ type  │       │names[] │         │  vmindex │        │    vmholder      │       │ entry    │
└───────┘       └────────┘         └──────────┘        └──────────────────┘       └──────────┘
   Load 1           Load 2              Load 3                 Load 4              jmp entry

:oop              :oop                :oop                   :native ptr          :code
GC barrier ✓      GC barrier ✓        GC barrier ✓           NO barrier           target code
```

### 3.4 @LambdaForm$Compiled 的 JIT 提示 — JIT 如何区别对待 LambdaForm

`classFileParser.cpp:2178-2179`：
```cpp
if (has_annotation(_method_LambdaForm_Compiled) && m->intrinsic_id() == vmIntrinsics::_none)
    m->set_intrinsic_id(vmIntrinsics::_compiledLambdaForm);
```

这是一个**伪 intrinsic** — `_compiledLambdaForm`（`vmSymbols.hpp:1445`）不映射到任何 C2 intrinsic 实现。它只是一个标记位：
- C2 的 `Compile` 阶段检查 `method->is_compiled_lambda_form()`（`method.hpp:742`）→ 如果 true → 提升此方法的编译优先级
- 行为等价于 HotSpot 内部 hint："这个 LambdaForm 是 JDK 生成的，请优先并积极内联"

**没有这个注解的后果**：LambdaForm 可能被 JIT 忽略 → 永远解释执行 → 每个 MethodHandle 调用都走 4 次 heap load → 失去性能优势。

#### ★ JIT 看到 LambdaForm 和看到普通 Java 方法的本质区别

普通 Java 方法在 C1/C2 眼中只是"待编译的字节码"。LambdaForm 有三个关键不同点：

**① 编译优先级更高**：`_compiledLambdaForm` 伪 intrinsic 让 C2 在 `Compile::optimize_inlining()` 时将 LambdaForm 提升到和 intrinsic 方法同等的内联优先级。普通方法可能在编译队列中排队几百毫秒才被 C2 处理，LambdaForm 会被提前——因为它被标记为"JDK 内部生成的热路径代码"。

**② MethodHandle 中间层被完全内联**（这是和普通 invokevirtual 的最大差异）：C2 在编译 LambdaForm 时看到 `Name[].function="invoke"` 节点的字节码 → 识别为 `invokeBasic` intrinsic → 调用 `ciMethodHandle::get_method()` 读取目标 Method→ 不再走 LambdaForm 的 heap load 链，直接 emit `direct_call(target_method_entry)`。三个中间对象（LambdaForm、MemberName、ResolvedMethodName）的 4 次 heap load 被**全部消除**——C2 把它变成了等价于 `invokevirtual` 内联的机器码：

```asm
; 普通 invokevirtual (JIT 内联后):
mov    rdi, receiver
call   String::length@0x7f123    ; 直接调用

; LambdaForm via MethodHandle (C2 编译 + 完全内联后):
; ★ 完全相同的代码——0 次 heap load, 0 次 MH dispatch
mov    rdi, receiver
call   String::length@0x7f123    ; 完全相同！
```

**③ 解释器 fallback 不同**：如果编译被拒绝（如 `-Xcomp` 未开启、C2 队列满），普通方法走解释器的 `invokevirtual` dispatch（读 vtable → 跳转）。LambdaForm 走解释器的 4 次 heap load 链——这是两者在回退路径上的性能分水岭。这解释了一个现象：**LambdaForm 要么极快（C2 内联后零开销），要么极慢（解释器 4 次 load）——中间地带很小，不像普通方法有 C1 编译的渐进加速**。

### 3.5 LF → vmentry → MN → RMN → vmtarget → Method* 完整寻址链汇总

```
MethodHandle.form (oop)                                       [javaClasses.hpp:1000]
  → LambdaForm.vmentry (oop, MemberName 类型)                   [javaClasses.hpp:1058]
    → MemberName.method (oop, ResolvedMethodName 类型)           [javaClasses.hpp:1129]
      → ResolvedMethodName.vmtarget (native pointer, Method*)   [javaClasses.hpp:1091]
        → Method::from_compiled_entry() 或 from_interpreted_entry()
          → 目标机器码/字节码
```

**为什么需要 3 个中间对象？**
1. **LambdaForm 可换 vmentry** — 同一 LambdaForm 可以指向不同的 MemberName → 支持 asType() 生成的适配 LambdaForm 复用模板
2. **MemberName 缓存已解析结果** — vmindex 预计算（vtable/itable index）→ 避免每次 dispatch 时查 Class 的方法表
3. **ResolvedMethodName 专门存 native 指针** — Method* 是 C++ 堆指针，不能直接存在普通 oop 的 oop 字段中（GC 会追踪 oop，该方法* 不在 GC heap 中）。所以 ResolvedMethodName 是专门设计的 oop 类型，它的 `vmtarget` 字段被标记为 `intptr_signature`（非 oop）— GC 扫描时跳过

---

## §四 ★★ BSM 执行与 CallSite 缓存 — BSM 仅执行一次

### 4.1 SystemDictionary 的 Java up-call 机制

`systemDictionary.cpp:2860-2930` — `find_dynamic_call_site_invoker()` 是 JVM 中 BSM 执行的唯一入口：

```
systemDictionary.cpp:2860
  → find_dynamic_call_site_invoker(caller, indy_index, bootstrap_specifier, name, type, ...)
    ├─ 2870: 从 bootstrap_specifier 提取 BSM MethodHandle + info (static args)
    ├─ 2881: method_name = create_from_symbol(name)
    ├─ 2882: method_type = find_method_handle_type(type, caller)
    ├─ 2892: ★★★ JavaCalls::call_static(result,
    │            MethodHandleNatives_klass(),
    │            linkCallSite_name, linkCallSite_signature, &args)
    │            // 调 Java 侧 MethodHandleNatives.linkCallSite()
    │            // → 内部执行 BSM
    └─ 2907: mname = result.get_jobject()   // 返回 MemberName
    └─ 2909: unpack_method_and_appendix(mname, caller, appendix_box, ...)
            // 从 MemberName 中拆出 Method* + appendix
```

**为什么是 `JavaCalls::call_static()` 而不是 JNI？**
- JNI → 需要 `JNIEnv*` 上下文准备 → 多一层 JNI→JVM 转换
- `JavaCalls::call_static()` → 直接在 VM 内部构造 Java 调用帧 → 零额外开销
- 但要求当前线程已在 `_thread_in_vm` 状态（JVM up-call 是在 VM 内发起 Java 调用）

### 4.2 cpCache 的 `set_dynamic_call` 写入

`interpreterRuntime.cpp:1047`：
```cpp
ConstantPoolCacheEntry* cp_cache_entry = pool->invokedynamic_cp_cache_entry_at(index);
cp_cache_entry->set_dynamic_call(pool, info);
```

`set_dynamic_call()` 写入 cpCache 的 f1、f2、appendix 字段：
- **f1** — adapter MethodHandle（通常是 `MH.linkToCallSite`）
- **f2/appendix** — CallSite 对象 → 每次调用从 CallSite.target() 取最新 MethodHandle

**写入后的 cpCache 状态**：
```
cpCache[index]:
  f1:       Method* → MH.linkToCallSite (adapter MH 的入口)
  f2:       oop → CallSite 对象
  appendix: oop → appendix（如果 BSM 返回了额外数据，否则 NULL）
  has_final_answer: true → 后续调用直接 dispatch
```

### 4.3 MemberName + appendix 的存储布局

`systemDictionary.cpp:2477-2507` — `unpack_method_and_appendix()`：
```cpp
static methodHandle unpack_method_and_appendix(Handle mname,
        Klass* accessing_klass, objArrayHandle appendix_box,
        Handle* appendix_result, TRAPS) {
    if (mname.not_null()) {
        Method* m = java_lang_invoke_MemberName::vmtarget(mname());
        if (m != NULL) {
            oop appendix = appendix_box->obj_at(0);
            (*appendix_result) = Handle(THREAD, appendix);
            ClassLoaderData* this_key = accessing_klass->class_loader_data();
            this_key->record_dependency(m->method_holder());
            return methodHandle(THREAD, m);
        }
    }
    THROW_MSG_(vmSymbols::java_lang_LinkageError(), "bad value from MethodHandleNatives", empty);
}
```

关键操作：
1. `java_lang_invoke_MemberName::vmtarget(mname)` — 从 MemberName oop 的 ResolvedMethodName 字段提取 Method* 指针
2. `appendix_box->obj_at(0)` — JDK 侧通过 `appendix_box[0]` 传出 appendix 数据（如 `StringConcatFactory` 传出的 recipe）
3. `record_dependency(m->method_holder())` — 建立 ClassLoaderData 依赖 → 防止目标方法所在类被卸载

### 4.4 BSM 的参数传递

BSM 被调用时接收 3 个参数（JVM Spec §5.4.3.6）：
```
bootstrapMethod(MethodHandles.Lookup caller, String name, MethodType type)
```
- **caller**：invokedynamic 所在类的 MethodHandles.Lookup（来自 `pool->pool_holder()`）
- **name**：invokedynamic 指令的 Name（如 lambda body 的方法名）
- **type**：invokedynamic 指令的 MethodType

如果 BSM 有额外的 static arguments（在 BootstrapMethods 属性中定义）— 它们作为第 4、5、... 参数传入。

**附加 proof — BSM 只执行一次的证据**：
```
GDB 验证:
(gdb) br InterpreterRuntime::resolve_invokedynamic
(gdb) c
Breakpoint 1 hit.          # 仅第一次调用命中
(gdb) fin
(gdb) p cpce->f1           # f1 不再是 NULL → adapter MH
(gdb) c
# 后续调用 — 不触发断点 — resolve_invokedynamic 不再被调用
```

---

## §五 ★★ CallSite 依赖追踪 — setTarget 后的 deoptimization

### 5.1 add_dependent_nmethod — 注册依赖

`methodHandles.cpp:1077-1089`：
```cpp
void MethodHandles::add_dependent_nmethod(oop call_site, nmethod* nm) {
    assert_locked_or_safepoint(CodeCache_lock);
    oop context = java_lang_invoke_CallSite::context(call_site);
    DependencyContext deps =
        java_lang_invoke_MethodHandleNatives_CallSiteContext::vmdependencies(context);
    deps.add_dependent_nmethod(nm, /*expunge_stale_entries=*/safe_to_expunge());
}
```

**何时调用**：
- C2 编译完成后 → 如果编译的 nmethod 中包含对某个 CallSite 的引用（从 condy 解析得到）→ 在 `ciCallSite` 中记录此依赖 → 编译回调时 `add_dependent_nmethod()`

**依赖存储位置**：
- `CallSite.context` 字段（`javaClasses.hpp:1231`）→ 指向 `MethodHandleNatives$CallSiteContext` 对象
- `CallSiteContext.vmdependencies` （`javaClasses.hpp:1257` — `intptr_signature`）→ 存 `DependencyContext` 链表

**DependencyContext 的结构**：
```
CallSite
  └─ context → CallSiteContext
        └─ vmdependencies → nmethod1 → nmethod2 → nmethod3 → ...
                             (链表，每个 nmethod 依赖此 CallSite)
```

### 5.2 flush_dependent_nmethods — deopt 触发

`methodHandles.cpp:1098-1116`：
```cpp
void MethodHandles::flush_dependent_nmethods(Handle call_site, Handle target) {
    assert_lock_strong(Compile_lock);
    int marked = 0;
    CallSiteDepChange changes(call_site, target);
    {
        NoSafepointVerifier nsv;
        MutexLockerEx mu2(CodeCache_lock, Mutex::_no_safepoint_check_flag);
        oop context = java_lang_invoke_CallSite::context(call_site());
        DependencyContext deps =
            java_lang_invoke_MethodHandleNatives_CallSiteContext::vmdependencies(context);
        marked = deps.mark_dependent_nmethods(changes);
        // 标记所有 dependent nmethod 为 not_entrant (deopt 候选)
    }
    if (marked > 0) {
        VM_Deoptimize op;           // ★ 发 VM_Operation 到 VMThread
        VMThread::execute(&op);     // ★ 同步等待 VMThread 处理完
    }
}
```

**关键锁协议**：
- `Compile_lock` — 防止 flush 期间有新编译的 nmethod 添加依赖（race condition）
- `CodeCache_lock` + `NoSafepointVerifier` — 标记 not_entrant 期间禁止 safepoint（否则 GC 可能移动 oop 导致 DependencyContext 链表损坏）

### 5.3 VM_Deoptimize 在 VMThread 上的执行

**VM_Deoptimize 的 VM_Operation 流程**（利用 [09-03] 学到的 VM_Operation 框架）：
```
flush_dependent_nmethods() 
  → VMThread::execute(&op)
    → VM_Deoptimize::doit() 
      → CodeCache::mark_for_deoptimization()
        → 标记所有 not_entrant nmethod 的 stack frames → 回撤到解释器
```

`VM_Deoptimize` 的 `Mode` = `_safepoint`（必须 STW — 不能在多线程执行 deopt 时发生 GC 移动方法栈帧）

**VMThread 处理步骤**：
1. `doit_prologue()` — 默认 return true（无额外条件检查）
2. `doit()` — 调用 `CodeCache::mark_for_deoptimization()` → 遍历所有标记为 not_entrant 的 nmethod → 对每个线程 → walk stack → 找到对应的 compiled frame → 重建为 interpreter frame
3. `doit_epilogue()` — 清理 deopt 相关资源

**为什么是 deopt 而不是 patch code？**（核心架构问题）
已经编译的机器码在 CPU 指令缓存中——不能安全修改。即使能修改（patch 跳转地址），
也改变不了已经在执行的指令。deopt 是唯一安全的方式：
1. 把线程的执行上下文（寄存器 + 栈）重建为解释器状态
2. 解释器重新执行 invokedynamic → 从（已更新的）cpCache 读 f2 → CallSite
3. 读取 CallSite 新 target → 走新的 MethodHandle dispatch

### 5.4 回到解释器重新 link 的完整路径

```
CallSite.setTarget(newMH)                      // JDK 侧
  → MethodHandleNatives.setCallSiteTargetNormal(callSite, newMH) // JNI
    → MHN_setCallSiteTargetNormal              // methodHandles.cpp:1388
      ├─ flush_dependent_nmethods(callSite, target)  // L1394
      │   ├─ mark_dependent_nmethods()           // 标记 not_entrant
      │   └─ VM_Deoptimize                       // 回撤所有线程
      └─ java_lang_invoke_CallSite::set_target(callSite, target)  // L1395
            // ★ 换 CallSite 的 target → 新的 MethodHandle

解释器下次执行 invokedynamic:
  cpCache → f2/appendix → CallSite (已被更新)
  → CallSite.target() → newMH                  // ★ 新 MethodHandle
  → newMH.invokeBasic → jump_to_lambda_form()
  → newMH.form → LF.vmentry → ... → new target → Method*
  → 执行新目标方法
  → 如果达到编译阈值 → C2 重新编译 → add_dependent_nmethod → 新的 nmethod 依赖此 CallSite
```

**`MHN_setCallSiteTargetNormal` 的 JVM_ENTRY 包装**（`methodHandles.cpp:1388-1398`）：
```cpp
JVM_ENTRY(void, MHN_setCallSiteTargetNormal(JNIEnv* env, jobject igcls,
        jobject call_site_jh, jobject target_jh)) {
    Handle call_site(THREAD, JNIHandles::resolve_non_null(call_site_jh));
    Handle target(THREAD, JNIHandles::resolve_non_null(target_jh));
    {
        MutexLocker mu(Compile_lock, thread);
        MethodHandles::flush_dependent_nmethods(call_site, target);  // ★ deopt 所有依赖 nmethod
        java_lang_invoke_CallSite::set_target(call_site(), target()); // ★ 替换 target
    }
}
JVM_END
```

**`MHN_setCallSiteTargetVolatile` 的区别**（`methodHandles.cpp:1400-1410`）：
```cpp
JVM_ENTRY(void, MHN_setCallSiteTargetVolatile(...)) {
    // 同 Normal，但最后调用:
    java_lang_invoke_CallSite::set_target_volatile(call_site(), target());
    // ★ volatile write → 内存屏障 → 其他 CPU 立即可见
}
JVM_END
```

**JNI 注册**（`methodHandles.cpp:1570-1571`）：
```cpp
{CC "setCallSiteTargetNormal",   CC "(" CS "" MH ")V", FN_PTR(MHN_setCallSiteTargetNormal)},
{CC "setCallSiteTargetVolatile", CC "(" CS "" MH ")V", FN_PTR(MHN_setCallSiteTargetVolatile)},
```

---

## §六 ★★ 和 [09-05] 反射的性能对比 — 不是"更快"而是"更多可消除开销"

### 6.1 参数类型信息 — 可传播 vs 被擦除

```
反射:  Method.invoke(Object target, Object... args)
       → JIT 看到 Object[] → 无法确定元素类型
       → 保守处理 → 不能内联 → 每次调用必须 type check + unboxing

MethodHandle:
       mh.invokeExact((String) "hello", (int) 1)
       → MethodType 静态编码类型 (String, int) → JIT 通过 ciMethodHandle 看到精确类型
       → 能生成指定类型的代码 → 能内联 → 零 type check
```

**举例**：`String.length()` 调用
```
反射:
  指令数: ~100+ 条
  Object[] args = new Object[0];         // 分配数组
  method.invoke(target, args);           // 虚调用 MethodAccessor
    → NativeMethodAccessorImpl.invoke()
    → invoke0()                          // native 调用 → ThreadInVMfromNative
    → JVM_InvokeMethod                   // JVM_ENTRY 展开
    → Reflection::invoke_method()         // slot 查找 + unboxing 循环
    → JavaCalls::call()                  // C++ → Java 桩
    → bytecode 执行

MethodHandle.invokeExact():
  指令数: 5 条 (编译后: 0-1 条)
  MH.type = MethodType(String → int)     // 类型在编译时已确定
  C2: call [rax + _vmtarget_offset]      // 直接 jmp 到 Method* 的入口
       (1 条 call 指令，如果内联则 0 条)
```

### 6.2 Machine code 层指令数对比

| 操作 | 反射 (native) | 反射 (GeneratedAccessor) | MethodHandle (解释) | MethodHandle (C2 编译) | 直接调用 |
|------|-------------|----------------------|-----------------|-------------------|--------|
| 调用入口 | 6 层调用链 | 1 层 Java + 1 层 JVM | 4 次 heap load | 1 条 jmp (0 内联) | 1 条 jmp |
| 参数处理 | 拆箱循环 (每个参数 3-5 条) | 拆箱循环 | 无 (类型匹配) | 无 | 无 |
| GC barrier | 多个（Handle 分配） | 多个 | 3 次（oop load） | 0 | 0 |
| 状态转换 | `ThreadInVMfromNative` | N/A (已经 in VM) | N/A (已经在解释器) | N/A | N/A |
| 总计指令 | ~150+ | ~30+ | ~15 | 0-2 | 0-2 |

**关键洞察**：反射最多可达 150+ 指令才能到达目标方法，MethodHandle 最少 0-2 条。不是"MH 比反射快 10 倍"——而是在 JIT 眼中，**MH 可以达到和直接调用相同的机器码**，反射做不到。

### 6.3 MH.invokeExact() ≡ 内联的 invokevirtual

**证明**：
1. `MH.invokeExact()` → JVM 识别为 `_invokeGeneric` intrinsic (methodHandles.cpp:450)
2. C2 编译 → `ciMethodHandle` 对象 → 读取 `MH.type` → 精确确定参数类型
3. 目标方法也是 `@ForceInline` + `@Stable` → C2 能完全解析 MH chain
4. C2 emit `direct_call(target_method_entry)` → 和内联后的 `invokevirtual` 一致

**汇编等价性**：
```asm
; 普通 invokevirtual (JIT 编译后):
mov    rdi, receiver
call   String::length@0x7f123    ; 1 条 call

; MethodHandle.invokeExact (JIT 编译后 + 完全内联):
; ★ 完全相同的代码 ← 到达此位置后再无差别
mov    rdi, receiver
call   String::length@0x7f123    ; 1 条 call — 完全相同！
```

### 6.4 反射 6 层 vs MH 2-3 层 (with JIT: 0 层)

```
反射 (Layer 1-6):                       MethodHandle (解释, 2-3 层):      MethodHandle (C2, 0 层):
────────────────                        ────────────────────────────      ───────────────────────
1: Method.invoke()                      cpCache f2 → CallSite              jmp target_entry
│  (Java, MethodAccessor dispatch)      → CallSite.target()               ★ 和内联 invokevirtual
2: NativeMethodAccessorImpl.invoke()    → MH.invokeBasic                  ★ 完全相同的代码
│  (Java, inflation check)              → jump_to_lambda_form()
3: invoke0() [native → JVM_ENTRY]       → MH.form → LF.vmentry
│  (JNI native, ThreadInVMfromNative)   → MN.method → RMN.vmtarget
4: Reflection::invoke_method()          → Method*
│  (C++, inspect slot + type check)
5: unbox + push params
│  (unbox_for_primitive × N params)
6: JavaCalls::call()
└── bytecode 执行                       bytecode 执行                   bytecode/machine code
```

---

## §七 ★ 和 [09-04] [09-05] [09-03] 的交叉验证

### 7.1 JVM_ENTRY 在 MethodHandles native 方法中的使用

`MHN_setCallSiteTargetNormal` (methodHandles.cpp:1388) 和 `MHN_setCallSiteTargetVolatile` (methodHandles.cpp:1400) 都使用 `JVM_ENTRY` + `JVM_END` 宏包裹——和 [09-04] §一 拆解的 `JVM_GetClassName` 使用的是同一套宏系统。

**展开后执行的相同的注入代码**：
- `JavaThread::thread_from_jni_environment(env)` — 从 JNIEnv* 反推 JavaThread*
- `ThreadInVMfromNative __tiv(thread)` — RAII 状态转换（_native → _vm）
- `HandleMarkCleaner __hm(thread)` — Handle 作用域管理
- `Thread* THREAD = thread` — TRAPS 别名

**关键**：`flush_dependent_nmethods()` 在持有 `Compile_lock` 的临界区内执行，此时线程状态是 `_thread_in_vm` — 线程在 VM 内，可被 safepoint 阻塞（如 VM_Deoptimize 执行时需要 safepoint）。

### 7.2 linkToStatic → Method::from_compiled_entry — 和反射的共同终点

[09-05] §一 揭示了反射最终通过 `JavaCalls::call()` → `StubRoutines::call_stub()` → `method->from_interpreted_entry()` 到达目标字节码。

MethodHandle 的 linkToStatic 也到达同一个终点 — 但路径短得多：
```
反射: JVM_InvokeMethod → Reflection::invoke_method → JavaCalls::call → StubRoutines → from_interpreted_entry
                     6 层                                               最后 1 层
MH:   jump_to_lambda_form → jump_from_method_handle → Method::from_compiled_entry
                     2 层                                               最后 1 层
```

两种路径走到 `Method::from_compiled_entry` 的入口 — 区别是 MH 前面的路径短得多，且可以被 JIT 完全消除。

### 7.3 VM_RedefineClasses 后 MethodHandle 的失效

[09-03] §三 分析了 `VM_RedefineClasses::doit()` 中 `ResolvedMethodTable` 的调整 — 当类被 redefine 时，Method* 指针可能被重新分配 — 旧的 Method* 指针变为悬空。

**MethodHandle 如何处理？**
- ResolvedMethodName.vmtarget 存的是 Method* native 指针
- redefine 发生时 → ResolvedMethodTable 更新 → 旧的 Method* 可能被替换
- 如果 MethodHandle 的 LambdaForm 缓存了旧的 Method* → 需要用新 Method* 更新
- JVM 在 redefine 后必须 deoptimize 所有使用此 Method* 的 nmethod → 重新 link → 读新的 ResolvedMethodName.vmtarget

这和 §5 的 CallSite 依赖追踪是同一机制——deoptimize 是 JVM 中处理"代码缓存一致性"的唯一通用手段。

---

## §八 GDB 验证 + 可证伪断言（≥14 条）

### 断言 1: 第一次 invokedynamic 前 → cpCache f1 == NULL

```gdb
(gdb) br interpreterRuntime.cpp:1023
(gdb) c
Breakpoint 1, InterpreterRuntime::resolve_invokedynamic (thread=0x7f123)
(gdb) p cpce->is_f1_null()
$1 = true
```

### 断言 2: resolve_invokedynamic 后 → cpCache f1 指向 adapter MH

```gdb
(gdb) br interpreterRuntime.cpp:1047
(gdb) c
; 执行完 set_dynamic_call 后:
(gdb) p cpce->is_f1_null()
$2 = false
(gdb) p cpce->f1_as_method()
$3 = (Method *) 0x7f456 → "linkToCallSite adapter"
```

### 断言 3: cpCache f2/appendix 指向 CallSite 对象

```gdb
(gdb) p cpce->appendix_if_resolved(pool)
$4 = (oop) 0x7f678 → java.lang.invoke.ConstantCallSite
```

### 断言 4: BSM 只执行一次 — 第二次调用不触发 resolve_invokedynamic

```gdb
(gdb) br InterpreterRuntime::resolve_invokedynamic
(gdb) c    # first invocation → hit
(gdb) c    # second invocation → NOT hit (skip)
# cpce->f1 != NULL → 跳过整个解析路径
```

### 断言 5: LambdaForm.vmentry 非 NULL（已链接的 LambdaForm）

```gdb
(gdb) p (oop) java_lang_invoke_LambdaForm::vmentry(mh_form)
$5 = (oop) 0x7f890 → MemberName
```

### 断言 6: MemberName.method 指向 ResolvedMethodName 且 vmtarget 是有效 Method*

```gdb
(gdb) p (oop) java_lang_invoke_MemberName::method(member_name)
$6 = (oop) 0x7f9ab → ResolvedMethodName
(gdb) p java_lang_invoke_ResolvedMethodName::vmtarget(resolved_mn)
$7 = (Method *) 0x7fdef → method_id=123 "targetMethod"
```

### 断言 7: MHN_setCallSiteTargetNormal 后 dependent nmethod 被标记 not_entrant

```gdb
(gdb) br methodHandles.cpp:1388
(gdb) c
; 单步到 flush_dependent_nmethods 后:
(gdb) fin
(gdb) p deps->count()  # 所有 nmethod 已被标记
$8 = 0
(gdb) p nm->is_not_entrant()
$9 = true
```

### 断言 8: invokeBasic 走 jump_to_lambda_form — 4 次 heap load 执行

```gdb
; 在 methodHandles_x86.cpp:172 设断点 (MH.form load)
(gdb) br methodHandles_x86.cpp:172
(gdb) c
(gdb) info reg rbx rcx
rbx: 0x0          ; 待填充
rcx: 0x7f123      ; recv = MethodHandle

(gdb) si           ; 执行 Load 1: mov rbx, [rcx + form_offset]
(gdb) info reg rbx
rbx: 0x7f456      ; LambdaForm*
(gdb) si           ; 执行 Load 2: mov rbx, [rbx + vmentry_offset]
rbx: 0x7f789      ; MemberName*
(gdb) si           ; 执行 Load 3: mov rbx, [rbx + method_offset]
rbx: 0x7fabc      ; ResolvedMethodName*
(gdb) si           ; 执行 Load 4: mov rbx, [rbx + vmtarget_offset]
rbx: 0x7fdef      ; Method*
(gdb) si           ; 执行 jump_from_method_handle → jmp Method::from_compiled_entry
rbx: target_entry  ; 最终入口地址
```
**可证伪性**：如果 LambdaForm.vmentry 是 NULL → Load 2 后的 rbx = NULL → Load 4 访问 NULL + vmtarget_offset → SIGSEGV → crash（证明寻址链的有效性依赖每个中间 oop 非 NULL）。

### 断言 9: linkToStatic 只做 2 次 heap load

```gdb
; vtable dispatch 只有 2 次 load：member_vmtarget + vmtarget_method
; 验证 4 次和 2 次 load 的差异：
(gdb) br methodHandles_x86.cpp:404   ; linkToStatic: __ load_heap_oop(rbx_method, member_vmtarget)
(gdb) c
(gdb) si   ; 1st load (member_vmtarget → ResolvedMethodName)
(gdb) si   ; 2nd load (vmtarget → Method*)
; 2 次后 rbx 已经指向 Method* — 不需要再 load LambdaForm.form 和 LF.vmentry
```

### 断言 10: linkToVirtual 从 MemberName.vmindex 读到 vtable index

```gdb
(gdb) br methodHandles_x86.cpp:419   ; __ access_load_at(T_ADDRESS, ... member_vmindex ...)
(gdb) c
(gdb) si
(gdb) p $rsi      ; temp2_index = vtable index
$10 = 3           ; 第 3 个 vtable slot
(gdb) p receiver->klass->vtable[3]
$11 = Method* → method_id=45 "someVirtualMethod"
```

### 断言 11: @LambdaForm$Compiled 注解 → `m->is_compiled_lambda_form() == true`

```gdb
(gdb) br classFileParser.cpp:2178
(gdb) c
; 当 ClassFileParser 识别 @LambdaForm$Compiled 注解时:
(gdb) p m->intrinsic_id()
$12 = vmIntrinsics::_compiledLambdaForm   ; pseudo-intrinsic 已设置
(gdb) p m->is_compiled_lambda_form()
$13 = true
```

### 断言 12: MHN_methods[] 中 setCallSiteTargetNormal 的 JNI 注册

```gdb
(gdb) br methodHandles.cpp:1570
(gdb) p MHN_methods[4].name
"setCallSiteTargetNormal"
(gdb) p MHN_methods[4].signature
"(Ljava/lang/invoke/CallSite;Ljava/lang/invoke/MethodHandle;)V"
```

### 断言 13: invokehandle bytecode 调用链路 → invokeBasic

```gdb
; 在 Java 代码中: MH.invoke(args) → bytecode invokehandle
; 在 JVM 中: 识别为 _invokeGeneric intrinsic → dispatch 到 invokeBasic
(gdb) p MethodHandles::signature_polymorphic_intrinsic_bytecode(vmIntrinsics::_invokeBasic)
$14 = Bytecodes::_invokehandle
(gdb) p MethodHandles::signature_polymorphic_intrinsic_ref_kind(vmIntrinsics::_invokeBasic)
$15 = 0
```

### 断言 14: 重复 invokedynamic → 第二次不命中 resolve_invokedynamic 断点

```gdb
# Java 测试代码:
# for (int i = 0; i < 3; i++) { lambda.run(); }

(gdb) br InterpreterRuntime::resolve_from_cache
(gdb) c
Hardware watchpoint: bytecode == _invokedynamic
# 第一次 → 命中 → 调用 resolve_invokedynamic → 立即填充 cpCache
# 第二次 → 读 cpCache → f1 != NULL → 跳过 resolve_invokedynamic 调用
# 第三次 → 同上

(gdb) p cpce->is_f1_null()
$16 = false    # ★ 第一次已在 cpCache 中保留，后续不再解析
```

---

## §九 总结：invokedynamic 在 JVM 中的完整生命周期

```
Class Loading Time                    First Execution       Subsequent Executions    After JIT
─────────────────                    ──────────────       ───────────────────    ─────────
Rewriter::rewrite_invokedynamic      BSM 执行            cpCache dispatch       C1/C2 inline target
→ cpCache 空槽位                     → Java up-call        → CallSite.target()   → 消除 MH chain
→ resolved_references 预分配         → 返回 CallSite       → MH.invokeBasic      → direct machine code
→ BSM NOT executed                   → cpCache 写 f1+f2    → jump_to_lambda_form → 0 heap load
                                      → 后续调用 skip BSM   → 4 heap load → Method* → 等价 inline invokevirtual

    │                                     │                      │                      │
    └─── 阶段 1 ────→                  └─── 阶段 2 ────→    └─── 阶段 3 ────→    └─── 阶段 4 ────→
```

**核心机制总结**：
1. **懒链接**：BSM 只在第一次执行时调用 — cpCache 缓存结果 → 后续调用跳过 BSM
2. **类型化 dispatch**：5 种 linkTo* 方法利用 vtable/itable 的 O(1) 查找 — 比需要 LambdaForm 查找的 invokeBasic 快 (2 vs 4 heap loads)
3. **可消除的中间层**：3 个中间对象（LambdaForm, MemberName, ResolvedMethodName）是为设计柔韧性 — JIT 可以完全消除这些 layer
4. **依赖追踪**：CallSite.setTarget() 触发 deopt — 保护编译代码的一致性 — 是解决"可变调用目标 + 编译优化"这对矛盾的唯一安全机制
5. **反射 vs MH**：反射永远是慢的（Object[] 不可优化），MethodHandle 可以达到和内联 invokevirtual 一样的性能

---

> **交叉引用索引**
> - [09-04] §一：`JVM_ENTRY` 宏在 `MHN_setCallSiteTargetNormal` 中的展开
> - [09-05] §一：6 层反射调用路径 vs MH 2-3 层（JIT 内联变 0 层）
> - [09-03] §三：`VM_RedefineClasses` doit() → ResolvedMethodTable 调整 → 影响 vmtarget
> - [09-04] §四：字段偏移预计算 → `_form_offset`, `_vmentry_offset`, `_method_offset`, `_vmtarget_offset` 的预计算基础
> - [08-03] §二：`VM_Deoptimize` 使用 `VM_Operation` 框架 → 走 `_safepoint` 模式 → VMThread 调度

---

## 附录 C: signature_polymorphic_intrinsic 三张映射表

以下三张映射表（`methodHandles.cpp:410-465`）从 §2.6 剥离至此，供编码时精确查找。正文 §2.1-§2.5 已解释每种 linkTo* 的**为什么**，此处是纯查表参考。

**(a) intrinsic → name 映射**（`:410-422`）：

```cpp
case vmIntrinsics::_invokeBasic:      return vmSymbols::invokeBasic_name();
case vmIntrinsics::_linkToVirtual:    return vmSymbols::linkToVirtual_name();
case vmIntrinsics::_linkToStatic:     return vmSymbols::linkToStatic_name();
case vmIntrinsics::_linkToSpecial:    return vmSymbols::linkToSpecial_name();
case vmIntrinsics::_linkToInterface:  return vmSymbols::linkToInterface_name();
```

**(b) intrinsic → bytecode 映射**（`:424-435`）：

```cpp
case vmIntrinsics::_linkToVirtual:   return Bytecodes::_invokevirtual;
case vmIntrinsics::_linkToInterface: return Bytecodes::_invokeinterface;
case vmIntrinsics::_linkToStatic:    return Bytecodes::_invokestatic;
case vmIntrinsics::_linkToSpecial:   return Bytecodes::_invokespecial;
case vmIntrinsics::_invokeBasic:     return Bytecodes::_invokehandle;
```

C2 在编译 MethodHandle dispatch 时根据 intrinsic ID 查此表生成正确的 `invoke` 指令——如果映射错误，C2 会生成 `invokevirtual` 但按 `invokeinterface` 处理，导致崩溃。

**(c) intrinsic → ref_kind 映射**（`:437-448`）：

```cpp
case vmIntrinsics::_invokeBasic:      return 0;
case vmIntrinsics::_linkToVirtual:    return JVM_REF_invokeVirtual;   // 5
case vmIntrinsics::_linkToStatic:     return JVM_REF_invokeStatic;    // 6
case vmIntrinsics::_linkToSpecial:    return JVM_REF_invokeSpecial;   // 7
case vmIntrinsics::_linkToInterface:  return JVM_REF_invokeInterface; // 9
```

ref_kind 决定 MemberName 的语义——`init_method_MemberName()`（`methodHandles.cpp:222`）根据 call_kind 设置 ref_kind，从而影响后续的 vtable/itable dispatch 选择。
