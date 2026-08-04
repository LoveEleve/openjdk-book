# ch18 SharedRuntime::generate_stubs — 共享运行时存根写作规划

> **源码基线**：OpenJDK 11u，x86-64，正常启用 Template Interpreter 和 C2 的 HotSpot 构建。
>
> 本章不把结论泛化到所有架构；不同平台的 `generate_deopt_blob`、`generate_uncommon_trap_blob` 等实现差异较大。

## ch18 目标

读者读完 5 篇后，能够回答以下问题：

1. **为什么编译代码不能直接 call C++ 运行时函数？** — C ABI 与 Java 帧的寄存器约定不同，编译代码的 call site 不能假设 caller-save 寄存器不会被 C++ 破坏。存根负责保存/恢复所有 live 寄存器、设置 `last_Java_frame`、注册 oop map。

2. **`generate_stubs()` 一次生成了哪些存根？** — 12 个存根分为四类：6 个 resolve stubs（方法解析）、3 个 safepoint handler stubs（轮询页异常处理）、1 个 deopt blob（反优化）、1 个 uncommon trap blob（C2 专有）+ 1 个 static call entry。

3. **resolve stub 如何工作？** — `generate_resolve_blob` 生成一个 stub，保存所有 live 寄存器 → 设置 last_Java_frame → call C++ resolve 函数（如 `resolve_static_call_C`）→ 返回 resolved Method* → 恢复寄存器 → jmp 到目标地址。

4. **safepoint handler stub 如何工作？** — 编译代码中插入的 `test %eax, (%polling_page)` 指令触发 SEGV → 信号处理器识别为 polling page 异常 → 跳转到 handler stub → 保存寄存器 → call `SafepointSynchronize::handle_polling_page_exception` → 返回后跳过 poll 指令。

5. **deopt blob 和 uncommon trap blob 的区别是什么？** — deopt blob 处理所有反优化场景（normal/reexecute/exception），uncommon trap blob 专用于 C2 的 uncommon trap（编译器推测失败后回退到解释器），两者都调用 `Deoptimization::fetch_unroll_info` + `unpack_frames`。

**不要求掌握的内容**：

- `fetch_unroll_info` 和 `unpack_frames` 的完整实现细节（属于 Deoptimization 专题）；
- `RegisterSaver::save_live_registers` 的具体寄存器保存指令序列；
- `handle_wrong_method` / `resolve_*_call_C` 的完整 C++ 实现（属于 runtime resolution 专题）；
- 信号处理器的注册和分发机制（属于 OS 层专题）。

---

## ch18 与 ch17 的边界

ch17 讲完了 `TemplateTable::initialize()`——解释器的 251 个字节码模板已注册完毕。ch18 紧跟 `templateTable_init()` 之后：

```
init_globals()                               ← init.cpp
  ...
  ├─→ templateTable_init()                   ← ch17 章节名
  │     └─→ TemplateTable::initialize()       ← 幂等调用，直接返回
  │
  ├─→ VMRegImpl::set_regName()               ← 在 generate_stubs 之前设置寄存器名
  │
  └─→ SharedRuntime::generate_stubs()        ← ch18 核心
        ├─→ 6× generate_resolve_blob()        ← 方法解析存根
        ├─→ 3× generate_handler_blob()        ← Safepoint 处理存根
        ├─→ generate_deopt_blob()             ← 反优化存根
        └─→ generate_uncommon_trap_blob()     ← UncommonTrap 存根 (C2 only)
```

关键事实：`generate_stubs()` 是解释器初始化完成后、编译代码开始运行前的最后一步基础设施准备。它生成的存根不会在解释执行中使用——它们服务于 JIT 编译后的代码。

---

## 真实调用链

```
init_globals()                                   ← init.cpp:101
  │
  ...
  │
  ├─→ templateTable_init()                       ← init.cpp:120
  │     └─→ TemplateTable::initialize()           ← 防重入，直接返回
  │
  ├─→ VMRegImpl::set_regName()                   ← init.cpp:122
  │     └─→ 设置寄存器名数组（用于打印 oop map）
  │
  └─→ SharedRuntime::generate_stubs()            ← init.cpp:123
        │
        ├─→ generate_resolve_blob(handle_wrong_method, "wrong_method_stub")
        │     └─→ RuntimeStub::new_runtime_stub()
        │
        ├─→ generate_resolve_blob(handle_wrong_method_abstract, "wrong_method_abstract_stub")
        ├─→ generate_resolve_blob(handle_wrong_method_ic_miss, "ic_miss_stub")
        ├─→ generate_resolve_blob(resolve_opt_virtual_call_C, "resolve_opt_virtual_call")
        ├─→ generate_resolve_blob(resolve_virtual_call_C, "resolve_virtual_call")
        ├─→ generate_resolve_blob(resolve_static_call_C, "resolve_static_call")
        │
        ├─→ generate_handler_blob(handle_polling_page_exception, POLL_AT_VECTOR_LOOP)  [C2/JVMCI only]
        ├─→ generate_handler_blob(handle_polling_page_exception, POLL_AT_LOOP)
        ├─→ generate_handler_blob(handle_polling_page_exception, POLL_AT_RETURN)
        │
        ├─→ generate_deopt_blob()                ← 反优化存根（x86_64 约 370 行）
        │     └─→ DeoptimizationBlob::create()
        │
        └─→ generate_uncommon_trap_blob()        ← C2 only (x86_64 约 180 行)
              └─→ UncommonTrapBlob::create()
```

关键源码锚点：

- `src/hotspot/share/runtime/sharedRuntime.cpp:99-124` — `generate_stubs()` 函数体
- `src/hotspot/share/runtime/sharedRuntime.hpp:57-86` — 静态字段声明 + 函数声明
- `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:3533-3608` — `generate_resolve_blob` x86_64 实现
- `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:3372-3523` — `generate_handler_blob` x86_64 实现
- `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:2813-3182` — `generate_deopt_blob` x86_64 实现
- `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:3185-3363` — `generate_uncommon_trap_blob` x86_64 实现
- `src/hotspot/share/runtime/sharedRuntime.cpp:1422-1567` — `handle_wrong_method` / `resolve_*_call_C` C++ 实现
- `src/hotspot/share/runtime/sharedRuntime.cpp:1242-1267` — `resolve_helper`（含 JvmtiExport hotswap 重试循环）
- `src/hotspot/share/runtime/sharedRuntime.cpp:1271-1340` — `resolve_sub_helper`（实际方法解析）
- `src/hotspot/share/runtime/safepoint.cpp:951-967` — `handle_polling_page_exception`
- `src/hotspot/share/runtime/safepoint.cpp:1166-1255` — `ThreadSafepointState::handle_polling_page_exception`
- `src/hotspot/share/runtime/deoptimization.cpp:139-153` — `Deoptimization::fetch_unroll_info`
- `src/hotspot/share/runtime/deoptimization.cpp:2095-2108` — `Deoptimization::uncommon_trap`

---

## 理解顺序

```
generate_stubs() 在 init_globals() 中的位置和前置依赖是什么？
  ↓
为什么编译代码需要"存根"来桥接 VM 运行时？
  ↓
resolve stub 的通用模式是什么？6 个 resolve stub 各自解决什么问题？
  ↓
safepoint handler stub 如何工作？polling page 机制的全链路是什么？
  ↓
deopt blob 有哪几种入口？normal/reexecute/exception 的差异是什么？
  ↓
uncommon trap blob 与 deopt blob 的关系是什么？为什么 C2 需要单独处理？
```

---

## 文章结构（5 篇）

### 01 — 基础概念：存根为什么存在、依赖哪些基础设施

- [ ] **01-generate-stubs-overview.md**

  **定位**：本章不需要讲任何具体存根（resolve/safepoint/deopt），而是先建立所有存根共同依赖的**基础概念**。读者必须理解这些概念，才能看懂后续 4 篇文章中的任何一个存根。遵循"数据结构先于操作"的原则：先讲清楚每个类/字段是什么，再讲方法如何操作它们。

  **依赖链**：后续所有存根都依赖以下概念，按依赖顺序排列：
  - RegisterSaver（存根保存寄存器的唯一方式）
  - last_Java_frame（存根让 VM 知道 Java 栈在哪的方式）
  - vm_result_2（resolve stub 获取 resolved Method* 的方式）
  - forward_exception_entry（所有存根检测到异常后的统一出口）
  - CodeBlob 类型体系（存根是什么、存在哪）
  - CodeBuffer / OopMap（存根如何生成、GC 如何找到 oop）

  **Section 1. 为什么编译代码不能直接 call C++ 函数**
  - 三个原因：C ABI 寄存器冲突、GC 需要 oop map、last_Java_frame 机制
  - 存根是"编译代码 ↔ VM 运行时"的桥接层
  - 存根只在 init_globals() 阶段生成一次，永久存在于 CodeCache

  **Section 2. RegisterSaver —— 寄存器保存与恢复**
  - **数据结构**：`RegisterSaver::layout` 枚举（`sharedRuntime_x86_64.cpp:84-136`）
    - 每个寄存器的栈偏移常量：rax_off, rcx_off, rdx_off, rbx_off, rsi_off, rdi_off, r8_off-r15_off, xmm0_off-xmm15_off
    - 帧结构：从低地址到高地址依次是 FPU state → XMM regs → 整数 regs → rbp → return addr
    - reg_save_size：帧的总大小（compiler stack slots）
    - 静态辅助方法：rax_offset_in_bytes(), rdx_offset_in_bytes(), rbx_offset_in_bytes(), xmm0_offset_in_bytes(), return_offset_in_bytes()
  - **操作**：`save_live_registers`（`sharedRuntime_x86_64.cpp:157-335`）
    - 步骤：enter → push_CPU_state（pushf + pusha + fxsave）→ 可选 wide vector save → 分配 arg_reg_save_area → 构建 OopMap
    - OopMap 将每个寄存器标记为 callee-saved（让 GC 知道这些栈槽存的是 oop）
    - save_wide_vectors 参数：true 时额外保存 YMM/ZMM 上半部分
    - frame_size 计算：`align_up(reg_save_size * BytesPerInt, num_xmm_regs)`
  - **操作**：`restore_live_registers`（`sharedRuntime_x86_64.cpp:337-395`）
    - 与 save 完全对称：pop arg_reg_save_area → vzeroupper → pop_CPU_state → pop rbp
  - **操作**：`restore_result_registers`（`sharedRuntime_x86_64.cpp:397-413`）
    - 只恢复 rax（整数返回值）、xmm0（浮点返回值）、rdx（long 高位）
    - 然后 addptr(rsp, return_offset) 跳过整个帧，只保留 return address
    - 用于 deopt blob：callee-save 寄存器值已捕获在 vframeArray 中，不需要恢复

  **Section 3. last_Java_frame —— 让 VM 知道 Java 栈在哪**
  - **数据结构**：`JavaThread` 的三个字段
    - `last_Java_sp`：Java 帧的栈顶指针（`JavaThread::last_Java_sp_offset()`）
    - `last_Java_fp`：Java 帧的帧指针（`JavaThread::last_Java_fp_offset()`），可选
    - `last_Java_pc`：Java 代码的 PC（在 `JavaFrameAnchor` 中，`JavaThread::frame_anchor_offset() + JavaFrameAnchor::last_Java_pc_offset()`）
  - **操作**：`MacroAssembler::set_last_Java_frame`（`macroAssembler_x86.cpp:781-805`）
    - `vzeroupper` 清除 YMM 上半部分
    - 如果 last_java_sp 无效则用 rsp
    - 如果 last_java_fp 有效则写入 thread
    - 如果 last_java_pc 非 NULL 则写入 thread（用 lea 取地址）
    - 最后写入 last_java_sp
  - **操作**：`MacroAssembler::reset_last_Java_frame`（`macroAssembler_x86.cpp:767-779`）
    - 将 last_Java_sp 清零
    - 如果 clear_fp 则清零 last_Java_fp
    - 将 last_Java_pc 清零
    - `vzeroupper`
  - **为什么存根必须设置它**：GC 遍历栈时需要从 last_Java_frame 开始找 Java 帧；stack walker 用它定位编译帧

  **Section 4. vm_result_2 —— C++ 如何把 Method* 传回汇编**
  - **数据结构**：`JavaThread::vm_result_2`（`thread.hpp`）
    - 一个 `Metadata*` 字段，用于从 C++ 运行时向汇编存根传递 metadata 指针
  - **操作**：`MacroAssembler::get_vm_result_2`（`macroAssembler_x86.cpp:2677-2680`）
    - `movptr(dst, Address(thread, vm_result_2_offset()))` — 读取
    - `movptr(Address(thread, vm_result_2_offset()), NULL_WORD)` — 清零
  - **使用场景**：resolve stub 调用 resolve C++ 函数后，C++ 函数将 resolved Method* 写入 `thread->set_vm_result_2(callee_method())`，存根再通过 `get_vm_result_2` 读取
  - **为什么用 vm_result_2 而不是寄存器**：C++ 函数可能在 safepoint 中阻塞，GC 可能移动对象，通过 thread 字段传递更安全；且 C ABI 只保证 rax 返回值，无法传递额外的 metadata 指针

  **Section 5. forward_exception_entry —— 所有存根共享的异常出口**
  - **数据结构**：`StubRoutines::forward_exception_entry()`（ch09 生成）
    - 一个 `address`，指向 StubRoutines 中生成的异常转发存根
    - 功能：接收 pending exception oop，查找异常处理器，跳转到处理器
  - **依赖关系**：`generate_resolve_blob` 和 `generate_handler_blob` 都有 `assert(StubRoutines::forward_exception_entry() != NULL)` 前置断言
  - **使用模式**：所有存根在 `reset_last_Java_frame` 后检查 `Thread::pending_exception_offset()`，如果非 NULL 则恢复寄存器后 `jump(forward_exception_entry)`

  **Section 6. CodeBlob 类型体系 —— 存根在 CodeCache 中的"身份证"**
  - **数据结构**：`CodeBlob`（`codeBlob.hpp`）
    - 基类：`_name`, `_size`, `_header_size`, `_frame_complete_offset`, `_frame_size`, `_code_begin/_code_end`, `_relocation_begin/_relocation_end`, `_oop_maps`（ImmutableOopMapSet）
    - 构造函数调用 `cb->copy_code_and_locs_to(this)` 将 CodeBuffer 中的代码和重定位信息复制到 CodeBlob
  - **数据结构**：`RuntimeBlob` → `RuntimeStub`（`codeBlob.hpp:468-511`）
    - `RuntimeStub` 继承 `RuntimeBlob`，额外存储 `_caller_must_gc_arguments`
    - 创建：`new_runtime_stub(name, cb, frame_complete, frame_size, oop_maps, caller_must_gc_arguments)`
    - 标识：`is_runtime_stub()` 返回 true
    - `entry_point()` = `code_begin()`（存根从代码段起点开始执行）
  - **数据结构**：`SingletonBlob` → `SafepointBlob` / `DeoptimizationBlob` / `UncommonTrapBlob`（`codeBlob.hpp:517-703`）
    - `SingletonBlob`：只存在一个实例的存根基类，`frame_complete` 固定为 `CodeOffsets::frame_never_safe`
    - `SafepointBlob`：`is_safepoint_stub()` 返回 true，用于信号处理器识别
    - `DeoptimizationBlob`：多入口——`_unpack_offset`(0), `_unpack_with_exception`, `_unpack_with_reexecution`, `_unpack_with_exception_in_tls`, JVMCI 的 `_uncommon_trap_offset` 和 `_implicit_exception_uncommon_trap_offset`
    - `UncommonTrapBlob`：C2 only，`is_uncommon_trap_stub()` 返回 true
  - **与 nmethod 的本质区别**：存根永久存在、不可卸载、不经过编译策略、不参与 GC 清理

  **Section 7. CodeBuffer 与 OopMap —— 代码生成的"画布"和"地图"**
  - **数据结构**：`CodeBuffer`（`codeBuffer.hpp`）
    - 两个 section：code section（`insts`）和 stub section（`stubs`）
    - 构造函数：`CodeBuffer(name, code_size, stub_size)` 如 `CodeBuffer("handler_blob", 2048, 1024)`
    - 存根代码写在 code section，跳转目标（trampoline）可能需要 stub section
  - **数据结构**：`MacroAssembler`（`macroAssembler_x86.hpp`）
    - 包装 `Assembler`，提供高级宏指令（`enter`, `push_CPU_state`, `set_last_Java_frame` 等）
    - 通过 `CodeBuffer` 构造：`new MacroAssembler(&buffer)`
    - `__` 是 `masm` 的别名（`#define __ _masm->`）
  - **数据结构**：`OopMap` / `OopMapSet`（`oops/oopMap.hpp`）
    - `OopMap`：一个 PC 偏移处的 oop 位置映射——"这个 PC 处，哪些栈槽/寄存器是 oop"
    - `OopMapSet`：OopMap 的集合，最终转为 `ImmutableOopMapSet` 存储在 CodeBlob 中
    - `set_callee_saved(STACK_OFFSET(reg_off), reg->as_VMReg())`：将寄存器标记为 callee-saved（GC 认为这些位置存的是 oop）
  - **操作**：`oop_maps->add_gc_map(pc_offset, map)`
    - 在某条指令的 PC 偏移处注册一个 OopMap
    - GC 发生时，如果线程停在这个 PC，就用这个 OopMap 找到所有 live oop
    - 必须精确对应 call 指令的返回地址——因为 GC 只在 safepoint 发生，而 safepoint 在 call 指令处

  **Section 8. `generate_stubs()` 全景**
  - 在 `init_globals()` 中的位置：`templateTable_init()` 之后，`universe2_init()` 之前
  - 12 个存根分类：6 resolve + 3 safepoint handler + 1 deopt + 1 uncommon trap + 1 static call entry shortcut
  - 12 个静态字段（`sharedRuntime.hpp:57-72`）
  - 25 行函数体，生成 4 类存根
  - 存根永久存在于 CodeCache，不参与 GC 清理

  **关键源码**：
  - `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:84-413` — RegisterSaver 完整实现
  - `src/hotspot/cpu/x86/macroAssembler_x86.cpp:767-805` — set/reset_last_Java_frame
  - `src/hotspot/cpu/x86/macroAssembler_x86.cpp:2677-2680` — get_vm_result_2
  - `src/hotspot/share/code/codeBlob.hpp:468-703` — RuntimeStub/SafepointBlob/DeoptimizationBlob/UncommonTrapBlob
  - `src/hotspot/share/code/codeBlob.cpp:105-384` — CodeBlob 构造和创建
  - `src/hotspot/share/runtime/sharedRuntime.cpp:99-124` — generate_stubs() 函数体
  - `src/hotspot/share/runtime/sharedRuntime.hpp:57-86` — 静态字段声明

### 02 — 6 个 Resolve Stubs：方法解析的桥接

- [ ] **02-resolve-stubs.md**

  **定位**：深入 `generate_resolve_blob` 的通用模式，逐个分析 6 个 resolve stub 各自解决的问题。

  **Section 1. `generate_resolve_blob` 通用模式**
  - 接收 `destination`（C++ 函数指针）和 `name`（CodeBlob 名称）；
  - 在 CodeCache 分配 CodeBuffer（1000 bytes code + 512 bytes stub）；
  - `RegisterSaver::save_live_registers` 保存所有 caller-save 和 callee-save 寄存器；
  - `set_last_Java_frame` → `call(destination)` → `add_gc_map`；
  - `reset_last_Java_frame` → 检查 pending exception；
  - 无异常：`get_vm_result_2` 获取 resolved Method* → 恢复寄存器 → `jmp(rax)` 跳转到目标；
  - 有异常：恢复寄存器 → `jump(forward_exception_entry)` 转发异常。

  **Section 2. `_wrong_method_blob` 和 `_wrong_method_abstract_blob`**
  - `handle_wrong_method`：当 inline cache 指向的方法与实际 receiver 类型不匹配时调用；
  - 有两条路径：如果 caller 是 interpreted frame，直接返回 `callee->get_c2i_entry()`（走 compiled-to-interpreted 转换）；如果 caller 是 compiled frame，调用 `reresolve_call_site` 重新解析方法，返回 `verified_code_entry()`；
  - `handle_wrong_method_abstract`：方法被标记为 abstract 时的处理——调用 `LinkResolver::throw_abstract_method_error` 安装异常到线程，然后返回 `StubRoutines::forward_exception_entry()`（或直接返回 `throw_AbstractMethodError_entry`），由存根转发到异常处理器；
  - 两者都走同一套 resolve blob 框架，只是 C++ 回调不同。

  **Section 3. `_ic_miss_blob`**
  - `handle_wrong_method_ic_miss`：inline cache miss 的统计和重解析——调用 `handle_ic_miss_helper` 做实际的方法查找；
  - 与 `_wrong_method_blob` 的区别：`handle_ic_miss_helper` 会尝试通过 `find_callee_info` 找到正确的 callee，如果方法可以静态绑定则 fallback 到 `reresolve_call_site`，否则将 IC 更新为 megamorphic 状态；
  - 额外记录 IC miss 统计（`_ic_miss_ctr`）和直方图（`ICMissHistogram`），用于 `-XX:+PrintICMissHistogram` 诊断。

  **Section 4. `_resolve_static_call_blob` / `_resolve_virtual_call_blob` / `_resolve_opt_virtual_call_blob`**
  - `resolve_static_call_C`：解析静态方法调用（`invokestatic` 首次遇到）→ `resolve_helper(thread, false, false, ...)` → `resolve_sub_helper`；
  - `resolve_virtual_call_C`：解析虚方法调用（`invokevirtual` 首次遇到，但 receiver 已知）→ `resolve_helper(thread, true, false, ...)`；
  - `resolve_opt_virtual_call_C`：解析优化虚方法调用（C2 内联后的 fallback，可静态绑定）→ `resolve_helper(thread, true, true, ...)`；
  - `resolve_helper` 在 `resolve_sub_helper` 外包装了 JvmtiExport hotswap 重试循环（方法被 redefine 时重试最多 100 次）；
  - `resolve_sub_helper` 做实际的类加载 + 方法解析：通过 `find_callee_info` 获取 `CallInfo`，然后 patch 调用点、更新 inline cache；
  - `_resolve_static_call_entry` 是 `_resolve_static_call_blob` 的 entry_point 快捷引用，供 C1 编译器快速获取静态调用存根地址。

  **Section 5. 存根的使用场景**
  - 编译代码中，未解析的 call site 初始指向 resolve stub；
  - 第一次调用时通过 stub 解析方法，然后 patch call site 直接指向目标方法；
  - 后续调用不再经过 stub——这是"lazy resolution"的核心。

  **关键源码**：
  - `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:3533-3608`
  - `src/hotspot/share/runtime/sharedRuntime.cpp:1422-1567`

### 03 — 3 个 Safepoint Handler Stubs：Polling Page 的守护者

- [ ] **03-safepoint-handler-stubs.md**

  **定位**：深入 `generate_handler_blob` 和 polling page 机制全链路。

  **Section 1. Polling Page 机制概述**
  - `os::_polling_page` 是一页内存，正常时不可读；
  - 编译代码中插入 `test %eax, (%polling_page)` 指令——正常时 SEGV；
  - JVM 需要 safepoint 时，`os::make_polling_page_readable()` 让 poll 指令通过；
  - 线程到达 safepoint 后阻塞，等待 VM 操作完成；
  - 线程局部 polling（`SafepointMechanism::uses_thread_local_poll`）使用 thread-local 的 polling page。

  **Section 2. `generate_handler_blob` 通用模式**
  - 接收 `call_ptr`（C++ 函数指针）和 `poll_type`（POLL_AT_RETURN / POLL_AT_LOOP / POLL_AT_VECTOR_LOOP）；
  - `cause_return` 标志：POLL_AT_RETURN 时返回地址已压栈，不需要 push rbx；
  - `save_wide_vectors` 标志：POLL_AT_VECTOR_LOOP 时保存 YMM/ZMM 寄存器；
  - 核心流程：保存寄存器 → `set_last_Java_frame` → call `handle_polling_page_exception` → `add_gc_map` → `reset_last_Java_frame` → 检查异常；
  - 无异常时：跳过 poll 指令（`addptr(rbx, 2)`）→ 恢复寄存器 → `ret` 回到 poll 指令之后；
  - 有异常时：恢复寄存器 → `jump(forward_exception_entry)`。

  **Section 3. 跳过 Poll 指令的细节**
  - `NativeTstRegMem::instruction_code_memXregl` = `0x85`；
  - 可能的编码：`85 00`（test %eax,(%rax)）到 `41 85 07`（test %eax,(%r15)）共 13 种；
  - REX prefix 检测（`instruction_rex_b_prefix` = `0x41`）；
  - r12/r13/rbp/rsp 的 3 字节编码特殊处理（modrm 的 base 字段为 0x04 或 0x05）；
  - 最终 `addptr(rbx, 2)` 跳过 2 字节 poll 指令。

  **Section 4. 三种 Poll Type 的差异**
  - `POLL_AT_LOOP`：循环回边处的 poll，最常见的 safepoint 位置；
  - `POLL_AT_RETURN`：方法返回前的 poll——`cause_return = true`，不需要 push rbx 保存返回地址；
  - `POLL_AT_VECTOR_LOOP`：向量化循环中的 poll——`save_wide_vectors = true`，额外保存 YMM/ZMM 寄存器；
  - 只有 C2/JVMCI 生成 `POLL_AT_VECTOR_LOOP`（`is_wide_vector(MaxVectorSize)` 检查）。

  **Section 5. 从 SEGV 到 Handler Stub 的全链路**
  - 编译代码执行 poll 指令 → SEGV；
  - OS 信号处理器（`JVM_handle_linux_signal`）检查 fault address；
  - `os::is_poll_address(fault_address)` 判断是否为 polling page；
  - 如果是：调用 `SharedRuntime::get_poll_stub(pc)` 根据 poll 类型选择正确的 handler stub 入口：
    - `is_at_poll_return(pc)` → `_polling_page_return_handler_blob->entry_point()`
    - `has_wide_vectors()` → `_polling_page_vectors_safepoint_handler_blob->entry_point()`
    - 否则 → `_polling_page_safepoint_handler_blob->entry_point()`
  - 信号处理器设置线程的 `saved_exception_pc` 为 poll 指令地址，跳转到对应的 handler stub entry point；
  - handler stub 保存上下文 → call `SafepointSynchronize::handle_polling_page_exception`；
  - `ThreadSafepointState::handle_polling_page_exception` 内部两条子路径：
    - **poll_return 分支**：如果方法返回类型是 oop，用 Handle 保护返回值 → `SafepointMechanism::block_if_requested` → 恢复 oop 返回值；
    - **poll at loop 分支**：`set_at_poll_safepoint(true)` → `SafepointMechanism::block_if_requested` → `set_at_poll_safepoint(false)` → 检查 async condition（如有则 deoptimize frame）→ 检查 pending exception（如有则检查是否 pending deoptimization）；
  - handler stub 返回后跳过 poll 指令继续执行。

  **关键源码**：
  - `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:3372-3523`
  - `src/hotspot/share/runtime/sharedRuntime.cpp:523-562` — `get_poll_stub` 运行时 dispatch
  - `src/hotspot/share/runtime/safepoint.cpp:951-967` — `handle_polling_page_exception`
  - `src/hotspot/share/runtime/safepoint.cpp:1166-1255` — `ThreadSafepointState::handle_polling_page_exception`
  - `src/hotspot/share/runtime/os.cpp:74`
  - `src/hotspot/os/linux/os_linux.cpp`（信号处理）

### 04 — deopt_blob：反优化的统一入口

- [ ] **04-deopt-blob.md**

  **定位**：深入 `generate_deopt_blob`——三种反优化入口（normal/reexecute/exception）和反优化执行流程。

  **Section 1. 反优化（Deoptimization）概述**
  - 编译代码可能因为各种原因需要回退到解释器：类加载触发、编译假设失效、调试请求；
  - 反优化的核心任务：将编译帧"拆解"为一个或多个解释器帧，然后继续解释执行；
  - `DeoptimizationBlob` 是反优化的统一入口——所有反优化路径最终都进入这个 blob。

  **Section 2. deopt_blob 的三种入口**
  - **Normal deopt（offset 0）**：正常的反优化——编译代码被标记为 `not_entrant`，返回地址被 patch 为 deopt blob 入口；
  - **Reexecute（offset: reexecute_offset）**：重新执行当前字节码——从调用点重新开始解释执行，而非从下一字节码继续；
  - **Exception（offset: exception_offset）**：异常反优化——编译代码中抛出了异常，需要回退到解释器查找异常处理器；
  - JVMCI 额外入口：`implicit_exception_uncommon_trap_offset` 和 `uncommon_trap_offset`。

  **Section 3. Normal Deopt 执行流程**
  - 进入 deopt blob 时，返回地址和返回值已在寄存器中；
  - `RegisterSaver::save_live_registers` 保存所有寄存器（包括 `save_wide_vectors = true` 保存 YMM/ZMM）；
  - `movl(r14, Deoptimization::Unpack_deopt)` 设置 exec_mode；
  - `set_last_Java_frame` → call `fetch_unroll_info` → `add_gc_map`；
  - `fetch_unroll_info` 返回 `UnrollBlock*`：描述当前帧大小、替换帧的数组（frame_sizes/frame_pcs）、caller_adjustment、initial_info 等；
  - `reset_last_Java_frame` → `restore_result_registers` **只恢复返回值寄存器**（rax/xmm0 等，callee-save 寄存器已"blown"——值已捕获在 vframeArray 中）；
  - 弹出反优化帧 → 压入新的解释器帧（循环：push pc → enter → subptr → 设置 sender_sp/last_sp）→ 重新压入 self-frame（含完整的 RegisterSaver 帧）；
  - call `unpack_frames` 填充帧内容（返回新目标地址）；
  - `leave` + `ret` 跳转到解释器继续执行。

  **Section 4. Exception Deopt 的特殊处理**
  - 入口时 `rax` = exception oop，`rdx` = throwing pc；
  - 将 exception oop 和 throwing pc 保存到 `JavaThread` 的 TLS 字段；
  - `push(0)` 为返回地址预留空间（后续用 throwing pc 填充）；
  - `movl(r14, Deoptimization::Unpack_exception)` 设置 exec_mode = exception；
  - `unpack_frames` 完成后，解释器使用 `exception_pc` 查找异常处理器。

  **Section 5. Reexecute Deopt 的特殊处理**
  - 与 normal deopt 的区别：`exec_mode = Unpack_reexecute`；
  - `unpack_frames` 在填充解释器帧时，会将 BCP 设置为当前字节码（而非下一字节码）；
  - 解释器重新执行当前字节码，适用于编译假设失效后需要重新获取信息的场景。

  **Section 6. deopt_blob 与 stubRoutines 的关系**
  - `StubRoutines::forward_exception_entry()` 必须在 deopt blob 之前生成；
  - unpack_frames 后如果有 pending exception，会转发到 `forward_exception_entry`。

  **关键源码**：
  - `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:2813-3182`
  - `src/hotspot/share/runtime/deoptimization.cpp`

### 05 — uncommon_trap_blob：C2 的推测失败回退

- [ ] **05-uncommon-trap-blob.md**

  **定位**：深入 `generate_uncommon_trap_blob`——C2 UncommonTrap 机制和与 deopt blob 的对比。

  **Section 1. UncommonTrap 概述**
  - C2 编译器做激进优化（如类层次分析 CHA、profile-guided 内联）时，会插入 uncommon trap；
  - uncommon trap 是"推测失败时的逃生口"——如果运行时发现推测不成立，触发 trap 回退到解释器；
  - 与 deopt 的区别：uncommon trap 是 C2 主动插入的检查点，deopt 是外部因素（类加载、GC）触发的被动反优化；
  - uncommon trap 只存在于 C2 编译的代码中（`#ifdef COMPILER2`）。

  **Section 2. uncommon_trap_blob 与 deopt_blob 的对比**
  | 维度 | deopt_blob | uncommon_trap_blob |
  |------|-----------|-------------------|
  | 触发原因 | 外部因素（类加载、safepoint、调试） | C2 编译时主动插入的 trap |
  | 入口数量 | 3～5 个（normal/reexecute/exception + JVMCI） | 1 个 |
  | 保存寄存器 | `save_live_registers`（含 wide vectors） | 不保存（仅保存 rbp） |
  | 帧结构 | 使用 `RegisterSaver` 的完整帧 | 使用 `SimpleRuntimeFrame` 的轻量帧 |
  | C++ 回调 | `Deoptimization::fetch_unroll_info` | `Deoptimization::uncommon_trap`（内部也调用 `fetch_unroll_info_helper`） |
  | exec_mode | normal/reexecute/exception | 固定 `Unpack_uncommon_trap` |
  | 适用编译器 | 所有（C1/C2/JVMCI） | C2 only |

  **Section 3. uncommon_trap_blob 执行流程**
  - 进入时 `j_rarg0` = `unloaded_class_index`（C2 编译时预留的类索引）；
  - `subptr(rsp, SimpleRuntimeFrame::return_off << LogBytesPerInt)` 分配轻量帧；
  - 保存 rbp → `set_last_Java_frame`；
  - `movl(c_rarg1, j_rarg0)` 将 class index 移到正确参数位置；
  - `movl(c_rarg2, Deoptimization::Unpack_uncommon_trap)` 设置 exec_mode；
  - call `Deoptimization::uncommon_trap` → `add_gc_map`；
  - `uncommon_trap` 内部调用 `fetch_unroll_info_helper` 获取 `UnrollBlock*`（不经过 `fetch_unroll_info` 的 `JRT_BLOCK_ENTRY` 包装，因为 uncommon_trap 本身已经是 JRT 入口）；
  - 弹出 self-frame 和 deoptimized frame → 重建解释器帧 → call `unpack_frames`；
  - 最后跳转到解释器。

  **Section 4. 帧重建的细节**
  - 与 deopt blob 不同，uncommon trap blob 不使用 `RegisterSaver` 的完整帧；
  - 使用 `SimpleRuntimeFrame`（`rbp_off` + `return_off`）：只保存 rbp 和返回地址；
  - 因为 uncommon trap 由 C2 主动插入，编译器已经确保 trap 点没有 live oop 在寄存器中（或已通过 oop map 记录）；
  - 帧重建循环：`pushptr(return_addr)` → `enter()` → `subptr(rsp, frame_size)` → 设置 sender_sp 和 last_sp → 循环直到所有帧重建完毕。

  **Section 5. 为什么 C2 需要单独的 uncommon trap blob**
  - C2 编译器在编译时可以在任意位置插入 uncommon trap，不需要完整寄存器保存；
  - 使用独立的轻量 blob 减少 uncommon trap 的开销；
  - `exec_mode = Unpack_uncommon_trap` 告诉 `unpack_frames` 重新执行当前字节码（而非下一字节码）。

  **关键源码**：
  - `src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:3185-3363`
  - `src/hotspot/share/runtime/deoptimization.cpp`

---

## 写作进度

| 篇 | 状态 | 日期 |
|----|------|------|
| 01 `generate_stubs` 全景：为什么需要存根 | ✅ 已完成 | 2026-07-27 |
| 02 6 个 Resolve Stubs：方法解析的桥接 | — | — |
| 03 3 个 Safepoint Handler Stubs：Polling Page 的守护者 | — | — |
| 04 deopt_blob：反优化的统一入口 | — | — |
| 05 uncommon_trap_blob：C2 的推测失败回退 | — | — |

---

## 与前后章节的连接

```
ch17 templateTable_init
  │  TemplateTable::initialize() 已在 interpreter_init 中完成
  │  templateTable_init() 是幂等重复调用
  ▼
ch18 SharedRuntime::generate_stubs
  ├─ 01：全景：为什么需要存根 + 12 个存根全貌 + CodeBlob 类型体系
  ├─ 02：resolve stubs：方法解析桥接 + lazy resolution
  ├─ 03：safepoint handler stubs：polling page 全链路
  ├─ 04：deopt blob：反优化统一入口
  └─ 05：uncommon trap blob：C2 推测失败回退
  ▼
ch19 universe2_init
      加载 primordial classes，开始 Java 类加载
```

---

## 关键写作决策

### 为什么是 5 篇

1. **01 讲全景**：先建立全局认知——为什么需要存根、12 个存根全貌、CodeBlob 类型体系。
2. **02 讲 resolve stubs**：6 个 resolve stubs 共享同一套 `generate_resolve_blob` 框架，适合合并讲解。
3. **03 讲 safepoint handler stubs**：3 个 handler stubs 共享同一套 `generate_handler_blob` 框架，且 polling page 机制独立成题。
4. **04 讲 deopt blob**：deopt blob 是反优化的统一入口，代码量最大（~370 行），需要独立成篇。
5. **05 讲 uncommon trap blob**：C2 专有，与 deopt blob 有对比价值，独立成篇。

### 为什么不展开 `fetch_unroll_info` 和 `unpack_frames`

这两个函数属于 Deoptimization 专题，调用链深入 `vframeArray` 创建、`scopeDesc` 解析、`frame` 重建等，本章只追到它们在 deopt/uncommon trap blob 中的调用位置和参数。完整反优化机制留到后续专门的 Deoptimization 章节。

### 为什么不展开 `handle_wrong_method` 和 `resolve_*_call_C` 的完整实现

这些 C++ 函数涉及 class loading、method resolution、vtable/itable lookup、invokevirtual 语义等，跨度太大。本章只讲它们在 resolve stub 中的角色——作为 `generate_resolve_blob` 的回调目标。

### 为什么单独讲 polling page 全链路

polling page 机制涉及信号处理、OS 层、线程局部 polling 等多个层面，是理解 safepoint handler stub 的必要前置知识。单独成篇避免在主流程中分散注意力。

---

## 正文写作前的核对清单

- [ ] `generate_stubs()` 的 12 个存根分类正确，不遗漏 `_resolve_static_call_entry`
- [ ] `generate_resolve_blob` 的通用模式描述与 x86_64 源码一致
- [ ] `generate_handler_blob` 的 poll 指令跳过逻辑与 x86_64 源码一致
- [ ] `generate_deopt_blob` 的三种入口（normal/reexecute/exception）描述准确
- [ ] `generate_uncommon_trap_blob` 与 deopt blob 的对比表数据准确
- [ ] 不声称存根在解释执行中使用
- [ ] 不展开 `fetch_unroll_info` / `unpack_frames` 内部实现
- [ ] 不展开 `handle_wrong_method` / `resolve_*_call_C` 内部实现
- [ ] 不把 polling page 机制简化成"一个全局变量"
- [ ] 不使用 "stub" 和 "stub" 混淆——区分 `StubRoutines` 存根和 `SharedRuntime` 存根