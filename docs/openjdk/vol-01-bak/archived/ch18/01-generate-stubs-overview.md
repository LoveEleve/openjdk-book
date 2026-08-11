# 18.1 基础概念 —— 存根为什么存在、依赖哪些基础设施

> **本文定位**：建立所有存根共同依赖的基础概念。不涉及任何具体存根（resolve/safepoint/deopt），而是讲清楚**存根操作的每一块积木**——RegisterSaver、last_Java_frame、vm_result_2、forward_exception_entry、CodeBlob 类型、CodeBuffer/OopMap。后续 4 篇文章的每一个存根都是这些积木的组合。
>
> **前置依赖**：[ch09 stubRoutines_init1](../ch09/01-overview.md)（`forward_exception_entry` 已生成）、[ch07 codeCache_init](../ch07/01-overview.md)（CodeCache 已就绪）。
>
> **JDK 版本**：本文基于 **OpenJDK 11u、x86-64、正常启用 C2 的 HotSpot 构建**。

---

## 1. 为什么编译代码不能直接 call C++ 函数

`init_globals()` 走到 `SharedRuntime::generate_stubs()` 时，JVM 已经拥有了堆、元空间、解释器、GC 屏障存根。但是 JIT 编译代码还不能运行——它缺少一个关键基础设施：**和 VM 运行时的桥接层**。

JIT 编译器（C1/C2）生成的机器码，在运行时经常需要调用 HotSpot 的 C++ 函数。比如：

- 首次遇到 `invokevirtual` 时，需要解析目标方法
- 循环回边处需要检查 safepoint
- 编译假设失效后需要回退到解释器

这些需求都要求**编译代码调用 C++ 函数**。但编译代码不能直接 `call` 一个 C++ 函数——三个原因：

### 1.1 C ABI 与编译器寄存器分配冲突

x86-64 C ABI 规定这些是 **caller-save** 寄存器（被调用者可以随意修改）：

```
rax, rcx, rdx, rsi, rdi, r8-r11, xmm0-xmm15
```

编译器（C1/C2）在 call site 附近可能在任何寄存器中持有 live 值——包括 oop 引用、中间计算结果。如果编译代码直接 `call` 一个 C++ 函数，C ABI 允许该函数随意修改所有这些 caller-save 寄存器。编译器无法在 call site 处假设它们会被保留，而 C++ 函数又不可能知道编译代码用了哪些寄存器。

**唯一的办法**：在 call 之前，把**所有**寄存器（caller-save + callee-save）保存到栈上；call 返回后，再恢复。这个保存/恢复操作就是存根的核心职责。

### 1.2 GC 需要 oop map

编译代码在 call site 附近可能持有 live oop 引用。GC 发生时，需要知道"当前栈帧里哪些寄存器/栈槽存的是 oop 引用"——这就是 **oop map**。

```cpp
// 在存根中，call C++ 函数之后，注册一个 oop map：
oop_maps->add_gc_map(__ pc() - start, map);
```

这个 oop map 必须精确对应 call 指令的返回地址。如果编译代码直接 call C++ 函数而没有存根来注册 oop map，GC 就无法知道哪些寄存器是 oop——可能导致 GC 误回收正在使用的对象，或漏回收已经死亡的对象。

### 1.3 last_Java_frame 机制

HotSpot 使用 `last_Java_frame` 机制来追踪"VM 运行时正在操作哪个 Java 线程的栈帧"。当 GC 遍历栈时，它从 `last_Java_frame` 开始，沿着帧链表向上找到所有 Java 帧。

编译代码的帧结构（compiled frame）与 C++ 帧结构不同——VM 运行时函数内部需要知道调用者的帧布局。存根负责在调用 C++ 函数之前设置 `last_Java_frame`，并在返回后清除。

---

## 2. RegisterSaver —— 寄存器保存与恢复

所有存根的第一步都是保存寄存器。`RegisterSaver` 是完成这个任务的唯一方式。先看它定义了**什么**（数据结构），再看它**怎么用**（操作）。

### 2.1 数据结构：帧布局

`RegisterSaver` 在栈上建立一个固定布局的帧，每个寄存器有确定的位置。这个布局通过 `RegisterSaver::layout` 枚举定义：

```cpp
/* === src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:84-136 === */

class RegisterSaver {
  // 所有偏移量以 compiler stack slots 为单位（1 slot = 4 字节）
  enum layout {
    fpu_state_off  = frame::arg_reg_save_area_bytes / BytesPerInt, // 0 (Linux)
    xmm_off        = fpu_state_off + 160 / BytesPerInt,            // xmm 保存区在 fxsave 内的偏移
    // xmm0-xmm15 在 fxsave 区域中，偏移由 DEF_XMM_OFFS 宏定义
    DEF_XMM_OFFS(0),  // xmm0_off = xmm_off, xmm0H_off = xmm_off + 1
    DEF_XMM_OFFS(1),  // xmm1_off = xmm_off + 4, ...
    // ... xmm2-xmm15 在区间内隐含

    // YMM/ZMM 上半部分保存区（仅 save_wide_vectors 时使用）
    ymm_off  = xmm_off + (576 - 160) / BytesPerInt,
    zmm_off  = xmm_off + (1152 - 160) / BytesPerInt,
    zmm_upper_off = xmm_off + (1664 - 160) / BytesPerInt,

    // 整数寄存器（由 push_IU_state 压入，顺序由 pusha 指令决定）
    r15_off, r15H_off,
    r14_off, r14H_off,
    r13_off, r13H_off,
    r12_off, r12H_off,
    r11_off, r11H_off,
    r10_off, r10H_off,
    r9_off,  r9H_off,
    r8_off,  r8H_off,
    rdi_off, rdiH_off,
    rsi_off, rsiH_off,
    ignore_off, ignoreH_off,  // pusha 压入的 rbp（会被 enter() 的 rbp 覆盖）
    rsp_off, rspH_off,
    rbx_off, rbxH_off,
    rdx_off, rdxH_off,
    rcx_off, rcxH_off,
    rax_off, raxH_off,
    align_off, alignH_off,    // 16 字节对齐填充
    flags_off, flagsH_off,    // pushf 保存的 flags
    rbp_off, rbpH_off,        // enter() 保存的 rbp
    return_off, returnH_off,  // 返回地址（call 指令压入）
    reg_save_size              // 帧总大小
  };
```

帧在内存中的布局（从高地址到低地址，即压栈顺序）：

```
高地址  ┌──────────────────────┐
        │  return address       │  ← call 指令压入
        │  rbp (from enter())   │  ← enter() 压入
        │  flags (from pushf)   │  ← push_CPU_state 压入
        │  alignment            │
        │  rax                  │
        │  rcx                  │
        │  rdx                  │
        │  rbx                  │
        │  rsp                  │  ← push_IU_state 模拟 pusha 保存（x86-64 上逐个 push 16 个寄存器：
        │  rbp (pusha copy)     │      rax→rcx→rdx→rbx→(skip rsp)→rbp→rsi→rdi→r8→...→r15）
        │  rsi                  │
        │  rdi                  │
        │  r8                   │
        │  r9                   │
        │  r10                  │
        │  r11                  │
        │  r12                  │
        │  r13                  │
        │  r14                  │
        │  r15                  │
        ├──────────────────────┤
        │  FPU state (fxsave)   │  ← 512 字节，含 x87 + XMM0-15
        │  arg_reg_save_area    │  ← 可选（Windows 需要 32 字节）
低地址  └──────────────────────┘
```

`RegisterSaver` 还提供了几个静态辅助方法，用**字节偏移**访问特定寄存器：

```cpp
/* === src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:143-155 === */

static int rax_offset_in_bytes(void)    { return BytesPerInt * rax_off; }
static int rdx_offset_in_bytes(void)    { return BytesPerInt * rdx_off; }
static int rbx_offset_in_bytes(void)    { return BytesPerInt * rbx_off; }
static int xmm0_offset_in_bytes(void)   { return BytesPerInt * xmm0_off; }
static int return_offset_in_bytes(void) { return BytesPerInt * return_off; }
```

这些辅助方法在存根中被反复使用——例如 resolve stub 需要把 `vm_result_2` 中的 Method* 存到 rbx 的槽位，deopt blob 需要从 rax 槽位恢复返回值。

在进入 `save_live_registers` 之前，先补充两个贯穿全文的约定：

- **`r15_thread`**：x86-64 HotSpot 将 `r15` 寄存器**永久保留**为当前 `JavaThread*` 指针。所有访问线程字段的代码都用 `Address(r15_thread, offset)` 寻址，不需要每次调用 `Thread::current()`。
- **`noreg`**：表示"无效寄存器"，等价于不传参数。`set_last_Java_frame(noreg, noreg, NULL)` 的意思是"不指定 SP 和 FP 寄存器，默认用 rsp 作为 SP，不设 FP 和 PC"。
- **`CAST_FROM_FN_PTR`**：将 C++ 函数指针转换为 `address` 类型。C++ 标准不允许直接将函数指针转为 `void*`，这个宏绕过了限制。
- **`__`**：`_masm->` 的宏别名。在存根生成函数中，`masm` 是 `MacroAssembler*` 局部变量，`__` 让汇编代码更简洁。

### 2.2 操作：save_live_registers

```cpp
/* === src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:157-335 === */

OopMap* RegisterSaver::save_live_registers(MacroAssembler* masm,
    int additional_frame_words, int* total_frame_words, bool save_wide_vectors) {
```

**参数**：
- `masm`：x86 汇编器
- `additional_frame_words`：额外帧空间（通常为 0）
- `total_frame_words`：输出参数，返回帧总大小（word 单位）
- `save_wide_vectors`：是否保存 YMM/ZMM 上半部分（deopt blob 和 safepoint handler 可能需要）

**步骤**：

1. **确定 XMM 寄存器数量**：如果 `UseAVX < 3`，只保存 16 个 XMM（否则 32 个）。
2. **计算帧大小**：
   ```cpp
   int frame_size_in_bytes = align_up(reg_save_size * BytesPerInt, num_xmm_regs);
   int frame_size_in_words = frame_size_in_bytes / wordSize;
   *total_frame_words = frame_size_in_words;
   ```
3. **`__ enter()`**：`push rbp; mov rbp, rsp`。此时 rsp 16 字节对齐。
4. **`__ push_CPU_state()`**：
   - `push_IU_state()`：`pushf`（保存 flags），`subq(rsp, 8)`（16 字节对齐），`pusha()`（x86-64 上逐个 push 16 个通用寄存器：rax, rcx, rdx, rbx, 跳过 rsp, rbp, rsi, rdi, r8, r9, r10, r11, r12, r13, r14, r15）
   - `push_FPU_state()`：`subptr(rsp, FPUStateSizeInWords * wordSize)`，`fxsave`（保存 x87 + XMM0-15）
5. **可选 wide vector save**：如果 `save_wide_vectors = true`，用 `vextractf128` 保存 YMM0-15 上半部分，用 `vextractf64x4` 保存 ZMM0-15 上半部分，用 `evmovdqul` 保存 ZMM16-31。
6. **分配 arg_reg_save_area**：Windows x64 需要 32 字节的寄存器参数保存区。
7. **构建 OopMap**：
   ```cpp
   OopMap* map = new OopMap(frame_size_in_slots, 0);
   map->set_callee_saved(STACK_OFFSET(rax_off), rax->as_VMReg());
   map->set_callee_saved(STACK_OFFSET(rcx_off), rcx->as_VMReg());
   // ... 所有 16 个整数寄存器 + 16 个 XMM 寄存器
   ```
   `STACK_OFFSET(x)` 宏将栈槽偏移量（`int`）转换为 `VMReg`（HotSpot 内部寄存器编号）。`set_callee_saved` 将寄存器标记为 callee-saved——GC 扫描这个帧时，会认为这些栈槽中可能存有 oop 引用，GC 会追踪它们，不会误回收。

**关键细节**：`save_live_registers` 保存了**所有寄存器**（caller-save + callee-save），而不仅仅是 C ABI 要求的 callee-save。原因是：编译代码的 call site 可能在 caller-save 寄存器中持有 live oop，如果 C++ 函数修改了它们，GC 就丢失了这些引用。所以必须全部保存。

### 2.3 操作：restore_live_registers

```cpp
/* === src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:337-395 === */

void RegisterSaver::restore_live_registers(MacroAssembler* masm, bool restore_wide_vectors) {
```

与 `save_live_registers` 完全对称：
1. 释放 arg_reg_save_area
2. `vzeroupper`（清除 YMM 上半部分）
3. 恢复 wide vectors（如果保存了）
4. `__ pop_CPU_state()`：`pop_FPU_state()`（`fxrstor` + `addptr`），`pop_IU_state()`（`popa` + `addq 8` + `popf`）
5. `__ pop(rbp)`（对应 `enter()` 的 `push rbp`）

恢复后，所有寄存器回到进入存根前的状态，栈指针也回到进入存根前的状态。

### 2.4 操作：restore_result_registers

```cpp
/* === src/hotspot/cpu/x86/sharedRuntime_x86_64.cpp:397-413 === */

void RegisterSaver::restore_result_registers(MacroAssembler* masm) {
```

**只恢复三个寄存器**：
```cpp
__ movdbl(xmm0, Address(rsp, xmm0_offset_in_bytes())); // 浮点返回值
__ movptr(rax,  Address(rsp, rax_offset_in_bytes()));   // 整数返回值
__ movptr(rdx,  Address(rsp, rdx_offset_in_bytes()));   // long 返回值高位
__ addptr(rsp, return_offset_in_bytes());               // 弹出整个帧，只留返回地址
```

**为什么只恢复返回值寄存器**？这用于 deopt blob 的场景。反优化时，callee-save 寄存器的值已经被捕获在 `vframeArray` 中（在编译代码被标记为 `not_entrant` 时就已经保存了）。这些寄存器在反优化后的解释器帧中不需要恢复——解释器会从 `vframeArray` 中读取它们。只有返回值需要恢复，因为新帧需要这些值。

---

## 3. last_Java_frame —— 让 VM 知道 Java 栈在哪

### 3.1 数据结构：JavaThread 的三个字段

当编译代码通过存根调用 C++ 运行时函数时，VM 需要知道"调用者的 Java 帧在哪"。这通过 `JavaThread` 的三个字段实现：

```cpp
/* === src/hotspot/share/runtime/thread.hpp === */

class JavaThread : public Thread {
  // ...
  address _last_Java_sp;  // Java 帧的栈顶指针
  address _last_Java_fp;  // Java 帧的帧指针（可选，x86 上用 rbp）

  // JavaFrameAnchor 包含 _last_Java_pc
  JavaFrameAnchor _anchor;  // 内含 address _last_Java_pc;
};
```

访问偏移量：
```cpp
JavaThread::last_Java_sp_offset()     // _last_Java_sp 的偏移
JavaThread::last_Java_fp_offset()     // _last_Java_fp 的偏移
JavaThread::frame_anchor_offset() + JavaFrameAnchor::last_Java_pc_offset()  // _last_Java_pc 的偏移
```

### 3.2 操作：set_last_Java_frame

```cpp
/* === src/hotspot/cpu/x86/macroAssembler_x86.cpp:781-805 === */

void MacroAssembler::set_last_Java_frame(Register last_java_sp,
                                         Register last_java_fp,
                                         address  last_java_pc) {
  vzeroupper();
  if (!last_java_sp->is_valid()) last_java_sp = rsp;
  if (last_java_fp->is_valid()) {
    movptr(Address(r15_thread, JavaThread::last_Java_fp_offset()), last_java_fp);
  }
  if (last_java_pc != NULL) {
    Address java_pc(r15_thread,
        JavaThread::frame_anchor_offset() + JavaFrameAnchor::last_Java_pc_offset());
    lea(rscratch1, InternalAddress(last_java_pc));
    movptr(java_pc, rscratch1);
  }
  movptr(Address(r15_thread, JavaThread::last_Java_sp_offset()), last_java_sp);
}
```

三个参数都可以是"无效"的：
- `last_java_sp` 无效 → 默认用 `rsp`（当前栈指针）
- `last_java_fp` 无效 → 不设置（清零时保留原值）
- `last_java_pc` 为 NULL → 不设置

在存根中，典型调用方式是：
```cpp
__ set_last_Java_frame(noreg, noreg, NULL);  // SP=rsp, 不设 FP, 不设 PC
```

因为存根已经通过 `RegisterSaver` 保存了所有寄存器，`rsp` 指向的就是 RegisterSaver 帧的底部——这正是 GC 遍历栈时需要知道的"Java 帧边界"。

### 3.3 操作：reset_last_Java_frame

```cpp
/* === src/hotspot/cpu/x86/macroAssembler_x86.cpp:767-779 === */

void MacroAssembler::reset_last_Java_frame(bool clear_fp) {
  movptr(Address(r15_thread, JavaThread::last_Java_sp_offset()), NULL_WORD);
  if (clear_fp) {
    movptr(Address(r15_thread, JavaThread::last_Java_fp_offset()), NULL_WORD);
  }
  movptr(Address(r15_thread, JavaThread::last_Java_pc_offset()), NULL_WORD);
  vzeroupper();
}
```

`clear_fp` 参数控制是否清除 `last_Java_fp`。在大多数存根中传 `false`（保留旧值），但在 deopt blob 中重建解释器帧后传 `true`（完全清除）。

### 3.4 为什么存根必须在 call 之前设置它

GC 可能在 C++ 函数内部的任何 safepoint 处发生（例如 `resolve_helper` 中可能触发类加载，类加载需要 GC）。GC 遍历栈时，从 `last_Java_frame` 开始：

```text
thread->last_Java_sp()
  │
  ▼
RegisterSaver 帧（在存根中）→ 包含所有寄存器的 oop map
  │
  ▼
编译帧（caller）→ 包含编译器生成的 oop map
  │
  ▼
... 更多 Java 帧
```

如果存根没有设置 `last_Java_frame`，GC 就无法找到编译帧，也无法找到编译帧中的 live oop。

---

## 4. vm_result_2 —— C++ 如何把 Method* 传回汇编

### 4.1 数据结构

```cpp
/* === src/hotspot/share/runtime/thread.hpp === */

class JavaThread : public Thread {
  // ...
  Metadata* _vm_result_2;  // 用于传递 metadata 指针（如 Method*）
};
```

这是一个简单的 `Metadata*` 字段。C++ 运行时函数通过 `thread->set_vm_result_2(ptr)` 写入，汇编存根通过 `get_vm_result_2` 读取。

> **命名由来**：HotSpot 还有 `vm_result`（单数），用于传递 oop 返回值（如 `Universe::out_of_memory_error_java_heap()` 等预分配异常对象）。`vm_result_2` 是第二个 result 槽位，专门用于传递 metadata 指针（`Method*`、`Klass*` 等），与 oop 返回值分离。

### 4.2 操作：get_vm_result_2

```cpp
/* === src/hotspot/cpu/x86/macroAssembler_x86.cpp:2677-2680 === */

void MacroAssembler::get_vm_result_2(Register metadata_result, Register java_thread) {
  movptr(metadata_result, Address(java_thread, JavaThread::vm_result_2_offset()));
  movptr(Address(java_thread, JavaThread::vm_result_2_offset()), NULL_WORD);
}
```

读取后立即清零——防止后续代码误用旧值。

### 4.3 为什么用 vm_result_2 而不是 C 返回值

resolve stub 的 C++ 回调（如 `resolve_static_call_C`）需要返回两个东西：
1. **目标地址**（`verified_code_entry()`）——通过 `rax` 返回值传递
2. **resolved Method\***——用于后续 patch call site

但 C ABI 只能通过 `rax` 返回一个值。`vm_result_2` 解决了这个限制——C++ 函数将 Method* 写入 thread 字段，汇编存根通过 `get_vm_result_2` 读取。

```cpp
// C++ 侧：
JRT_BLOCK_ENTRY(address, SharedRuntime::resolve_static_call_C(JavaThread *thread))
  methodHandle callee_method;
  JRT_BLOCK
    callee_method = SharedRuntime::resolve_helper(thread, false, false, CHECK_NULL);
    thread->set_vm_result_2(callee_method());  // ← 写入 Method*
  JRT_BLOCK_END
  return callee_method->verified_code_entry();  // ← 通过 rax 返回目标地址
JRT_END

// 汇编侧（resolve stub）：
__ call(RuntimeAddress(destination));            // call C++ 函数
oop_maps->add_gc_map(__ pc() - start, map);     // 注册 oop map
__ reset_last_Java_frame(false);                 // 清除 last_Java_frame
__ get_vm_result_2(rbx, r15_thread);             // ← 读取 Method*
__ movptr(Address(rsp, RegisterSaver::rbx_offset_in_bytes()), rbx); // 存到 rbx 槽位
__ movptr(Address(rsp, RegisterSaver::rax_offset_in_bytes()), rax); // 存到 rax 槽位（目标地址）
RegisterSaver::restore_live_registers(masm);     // 恢复所有寄存器
__ jmp(rax);                                     // 跳转到目标
```

`rax` 现在是目标地址，`rbx` 是 resolved Method*（已在恢复时加载到 rbx 寄存器）。

---

## 5. forward_exception_entry —— 所有存根共享的异常出口

### 5.1 数据结构

```cpp
/* === src/hotspot/share/runtime/stubRoutines.hpp === */

static address forward_exception_entry() { return _forward_exception_entry; }
```

`_forward_exception_entry` 是一个 `address`，指向 `StubGenerator::generate_forward_exception()` 在 ch09 生成的异常转发存根。这个存根的功能是：

1. 从 `JavaThread::pending_exception_offset()` 读取 pending exception oop
2. 查找异常处理器
3. 跳转到异常处理器

### 5.2 依赖关系

`generate_resolve_blob` 和 `generate_handler_blob` 都有：

```cpp
assert(StubRoutines::forward_exception_entry() != NULL,
       "must be generated before");
```

这是对 ch09 `stubRoutines_init1` 的硬依赖——`forward_exception_entry` 必须在 `generate_stubs()` 之前就绪。

### 5.3 使用模式

所有存根在 `reset_last_Java_frame` 之后，都会检查 pending exception：

```cpp
__ reset_last_Java_frame(false);

// 检查是否有 pending exception
Label noException;
__ cmpptr(Address(r15_thread, Thread::pending_exception_offset()), (int32_t)NULL_WORD);
__ jcc(Assembler::equal, noException);

// 有异常：恢复寄存器，跳转到 forward_exception_entry
RegisterSaver::restore_live_registers(masm);
__ jump(RuntimeAddress(StubRoutines::forward_exception_entry()));

// 无异常：继续正常流程
__ bind(noException);
```

**为什么是 forward_exception_entry 而不是直接抛异常**？C++ 运行时函数（如 `resolve_helper`）内部可能因为类加载失败、方法未找到等原因产生异常。这些异常被包装为 pending exception 存储在 `JavaThread` 中。C++ 函数返回后，存根不能直接处理异常——它需要恢复寄存器状态，然后让异常处理机制接管。`forward_exception_entry` 就是做这件事的。

---

## 6. CodeBlob 类型体系 —— 存根在 CodeCache 中的"身份证"

### 6.1 数据结构：CodeBlob

```cpp
/* === src/hotspot/share/code/codeBlob.hpp === */

class CodeBlob {
  const char* _name;                    // 存根名称，如 "wrong_method_stub"
  int         _size;                    // CodeBlob 总大小
  int         _header_size;            // 头部大小（C++ 对象 + 对齐）
  int         _frame_complete_offset;  // 帧完全建立时的 PC 偏移
  int         _frame_size;             // 帧大小（word 单位）
  address     _code_begin;             // 代码起始地址
  address     _code_end;               // 代码结束地址
  ImmutableOopMapSet* _oop_maps;       // 所有 oop map 的不可变集合
  // ...
};
```

创建时，`CodeBuffer` 中的代码和重定位信息被复制到 CodeBlob：

```cpp
/* === src/hotspot/share/code/codeBlob.cpp:146-157 === */

RuntimeBlob::RuntimeBlob(const char* name, CodeBuffer* cb, int header_size,
    int size, int frame_complete, int frame_size, OopMapSet* oop_maps,
    bool caller_must_gc_arguments)
  : CodeBlob(name, compiler_none,
             CodeBlobLayout((address) this, size, header_size, cb),
             cb, frame_complete, frame_size, oop_maps, caller_must_gc_arguments) {
  cb->copy_code_and_locs_to(this);  // ← 复制代码和重定位信息
}
```

### 6.2 数据结构：RuntimeBlob → RuntimeStub

```cpp
/* === src/hotspot/share/code/codeBlob.hpp:468-511 === */

class RuntimeStub: public RuntimeBlob {
  // 比 RuntimeBlob 多一个字段：
  // bool _caller_must_gc_arguments;  ← 由 RuntimeBlob 继承
  //   如果为 true，表示"调用者必须保证传入的参数是 GC 安全的"
  //   （即参数已经保存在 Handle 中，不会被 GC 移动）
  //   6 个 resolve stub 全部传 true——因为 C1/C2 生成的 call site
  //   已经保证了参数安全

  static RuntimeStub* new_runtime_stub(
    const char* stub_name, CodeBuffer* cb, int frame_complete,
    int frame_size, OopMapSet* oop_maps, bool caller_must_gc_arguments);

  bool is_runtime_stub() const { return true; }
  address entry_point() const { return code_begin(); }
};
```

6 个 resolve stub 都是 `RuntimeStub` 类型。创建时在 CodeCache 中分配内存（`NonNMethod` 类型），然后复制代码：

```cpp
/* === src/hotspot/share/code/codeBlob.cpp:366-384 === */

RuntimeStub* RuntimeStub::new_runtime_stub(const char* stub_name, CodeBuffer* cb,
    int frame_complete, int frame_size, OopMapSet* oop_maps,
    bool caller_must_gc_arguments) {
  RuntimeStub* stub = NULL;
  ThreadInVMfromUnknown __tiv;
  {
    MutexLockerEx mu(CodeCache_lock, Mutex::_no_safepoint_check_flag);
    unsigned int size = CodeBlob::allocation_size(cb, sizeof(RuntimeStub));
    stub = new (size) RuntimeStub(stub_name, cb, size, frame_complete,
                                   frame_size, oop_maps, caller_must_gc_arguments);
  }
  trace_new_stub(stub, "RuntimeStub - ", stub_name);
  return stub;
}
```

### 6.3 数据结构：SingletonBlob → SafepointBlob / DeoptimizationBlob / UncommonTrapBlob

```cpp
/* === src/hotspot/share/code/codeBlob.hpp:517-548 === */

class SingletonBlob: public RuntimeBlob {
  // 与 RuntimeBlob 的区别：frame_complete 固定为 frame_never_safe
  // 因为单例存根不期望在帧完全建立之前发生 GC
  SingletonBlob(const char* name, CodeBuffer* cb, int header_size,
                int size, int frame_size, OopMapSet* oop_maps)
    : RuntimeBlob(name, cb, header_size, size,
                  CodeOffsets::frame_never_safe, frame_size, oop_maps) {}
};
```

**SafepointBlob**（`codeBlob.hpp:703-726`）：
```cpp
class SafepointBlob: public SingletonBlob {
  static SafepointBlob* create(CodeBuffer* cb, OopMapSet* oop_maps, int frame_size);
  bool is_safepoint_stub() const { return true; }
};
```
`is_safepoint_stub()` 返回 `true`——信号处理器用它来识别 safepoint handler stub。

**DeoptimizationBlob**（`codeBlob.hpp:554-634`）：
```cpp
class DeoptimizationBlob: public SingletonBlob {
  int _unpack_offset;                    // normal deopt 入口（offset 0）
  int _unpack_with_exception;            // exception deopt 入口
  int _unpack_with_reexecution;          // reexecute 入口
  int _unpack_with_exception_in_tls;     // C1 的 exception_in_tls 入口
  // JVMCI 额外入口：
  int _uncommon_trap_offset;
  int _implicit_exception_uncommon_trap_offset;

  address unpack() const                          { return code_begin() + _unpack_offset; }
  address unpack_with_exception() const           { return code_begin() + _unpack_with_exception; }
  address unpack_with_reexecution() const         { return code_begin() + _unpack_with_reexecution; }
};
```
多入口：同一个 blob 的不同偏移处对应不同的反优化场景。

**UncommonTrapBlob**（`codeBlob.hpp:642-682`，C2 only）：
```cpp
class UncommonTrapBlob: public SingletonBlob {
  static UncommonTrapBlob* create(CodeBuffer* cb, OopMapSet* oop_maps, int frame_size);
  bool is_uncommon_trap_stub() const { return true; }
};
```

### 6.4 与 nmethod 的本质区别

| 维度 | 存根（CodeBlob 子类） | nmethod |
|------|----------------------|---------|
| 生命周期 | 永久，JVM 启动时创建，永不卸载 | 动态，编译后创建，可被卸载/反优化 |
| 分配时机 | `init_globals()` 阶段 6 | 运行时，通过 CompileBroker |
| 管理方式 | 静态字段持有引用 | CodeCache 全局管理，GC 时清理 |
| 编译策略 | 不经过编译策略 | 经过 CompilationPolicy 决策 |
| 代码来源 | 手写汇编（MacroAssembler） | 编译器生成（C1/C2） |

---

## 7. CodeBuffer 与 OopMap —— 代码生成的"画布"和"地图"

### 7.1 数据结构：CodeBuffer

```cpp
/* === src/hotspot/share/asm/codeBuffer.hpp === */

class CodeBuffer {
  // 两个 section：
  //   _insts  — 代码段（存根的主要代码写在这里）
  //   _stubs  — 存根段（trampoline、远跳转目标等）
  // 构造函数：
  CodeBuffer(const char* name, int code_size, int stub_size);
};
```

存根使用示例：
```cpp
CodeBuffer buffer("handler_blob", 2048, 1024);
// 2048 字节的 code section，1024 字节的 stub section
```

### 7.2 数据结构：MacroAssembler

```cpp
/* === src/hotspot/cpu/x86/macroAssembler_x86.hpp === */

class MacroAssembler: public Assembler {
  // 提供高级宏指令：
  //   enter(), leave()
  //   push_CPU_state(), pop_CPU_state()
  //   set_last_Java_frame(), reset_last_Java_frame()
  //   get_vm_result_2()
  //   ...
};
```

通过 `CodeBuffer` 构造：
```cpp
MacroAssembler* masm = new MacroAssembler(&buffer);
```

在存根代码中，`__` 是 `masm` 的别名：
```cpp
#define __ _masm->
```

### 7.3 数据结构：OopMap 和 OopMapSet

```cpp
/* === src/hotspot/share/oops/oopMap.hpp === */

class OopMap {
  // 一个 PC 偏移处的 oop 位置映射
  // "这个 PC 处，哪些栈槽/寄存器是 oop 引用"
  void set_callee_saved(VMReg reg, VMReg callee_saved);
};

class OopMapSet {
  // OopMap 的集合，最终转为 ImmutableOopMapSet 存储在 CodeBlob 中
  void add_gc_map(int pc_offset, OopMap* map);
};
```

### 7.4 操作：add_gc_map

```cpp
oop_maps->add_gc_map(__ pc() - start, map);
```

- `__ pc() - start`：当前 PC 相对于存根起始地址的偏移
- `map`：这个 PC 处的 OopMap（哪些寄存器/栈槽是 oop）

**为什么必须精确对应 call 指令的返回地址**？GC 只在 safepoint 处发生。在存根中，`call` C++ 函数之后就是 safepoint——C++ 函数可能在 safepoint 处阻塞，GC 可能在这时发生。GC 需要知道"如果线程的 PC 是这个 call 的返回地址，哪些寄存器是 oop"。所以 `add_gc_map` 必须在 `call` 指令之后立即调用。

---

## 8. generate_stubs() 全景

有了以上 7 节的基础概念，现在可以看 `generate_stubs()` 的全貌了。

### 8.1 在 init_globals() 中的位置

```cpp
/* === src/hotspot/share/runtime/init.cpp:122-123 === */

  VMRegImpl::set_regName();        // need this before generate_stubs
                                    // (for printing oop maps).
  SharedRuntime::generate_stubs();
```

前置依赖：
```
codeCache_init()          ← CodeCache 已就绪，存根可以在其中分配
stubRoutines_init1()      ← forward_exception_entry 已生成
interpreter_init()        ← 解释器已就绪
templateTable_init()      ← 模板表已在 interpreter_init 中完成注册
VMRegImpl::set_regName()  ← 寄存器名数组已设置（调试用）
```

### 8.2 12 个存根

```cpp
/* === src/hotspot/share/runtime/sharedRuntime.cpp:100-124 === */

void SharedRuntime::generate_stubs() {
  // 6 个 resolve stubs（RuntimeStub）
  _wrong_method_blob                = generate_resolve_blob(
      CAST_FROM_FN_PTR(address, SharedRuntime::handle_wrong_method),
      "wrong_method_stub");
  _wrong_method_abstract_blob       = generate_resolve_blob(
      CAST_FROM_FN_PTR(address, SharedRuntime::handle_wrong_method_abstract),
      "wrong_method_abstract_stub");
  _ic_miss_blob                     = generate_resolve_blob(
      CAST_FROM_FN_PTR(address, SharedRuntime::handle_wrong_method_ic_miss),
      "ic_miss_stub");
  _resolve_opt_virtual_call_blob    = generate_resolve_blob(
      CAST_FROM_FN_PTR(address, SharedRuntime::resolve_opt_virtual_call_C),
      "resolve_opt_virtual_call");
  _resolve_virtual_call_blob        = generate_resolve_blob(
      CAST_FROM_FN_PTR(address, SharedRuntime::resolve_virtual_call_C),
      "resolve_virtual_call");
  _resolve_static_call_blob         = generate_resolve_blob(
      CAST_FROM_FN_PTR(address, SharedRuntime::resolve_static_call_C),
      "resolve_static_call");
  _resolve_static_call_entry        = _resolve_static_call_blob->entry_point();

  // 3 个 safepoint handler stubs（SafepointBlob）
#if COMPILER2_OR_JVMCI
  if (is_wide_vector(MaxVectorSize)) {
    _polling_page_vectors_safepoint_handler_blob = generate_handler_blob(
        CAST_FROM_FN_PTR(address,
            SafepointSynchronize::handle_polling_page_exception),
        POLL_AT_VECTOR_LOOP);
  }
#endif
  _polling_page_safepoint_handler_blob = generate_handler_blob(
      CAST_FROM_FN_PTR(address,
          SafepointSynchronize::handle_polling_page_exception),
      POLL_AT_LOOP);
  _polling_page_return_handler_blob    = generate_handler_blob(
      CAST_FROM_FN_PTR(address,
          SafepointSynchronize::handle_polling_page_exception),
      POLL_AT_RETURN);

  // 1 个 deopt blob（DeoptimizationBlob）
  generate_deopt_blob();

  // 1 个 uncommon trap blob（UncommonTrapBlob，C2 only）
#ifdef COMPILER2
  generate_uncommon_trap_blob();
#endif
}
```

### 8.3 12 个静态字段

```cpp
/* === src/hotspot/share/runtime/sharedRuntime.hpp:57-72 === */

static RuntimeStub*        _wrong_method_blob;
static RuntimeStub*        _wrong_method_abstract_blob;
static RuntimeStub*        _ic_miss_blob;
static RuntimeStub*        _resolve_opt_virtual_call_blob;
static RuntimeStub*        _resolve_virtual_call_blob;
static RuntimeStub*        _resolve_static_call_blob;
static address             _resolve_static_call_entry;

static DeoptimizationBlob* _deopt_blob;

static SafepointBlob*      _polling_page_vectors_safepoint_handler_blob;
static SafepointBlob*      _polling_page_safepoint_handler_blob;
static SafepointBlob*      _polling_page_return_handler_blob;

#ifdef COMPILER2
static UncommonTrapBlob*   _uncommon_trap_blob;
#endif
```

### 8.4 存根的共同模式

虽然 12 个存根解决的问题各不相同，但它们共享同一套操作模式：

```
存根入口
  │
  ├─ 1. RegisterSaver::save_live_registers()   ← 保存所有寄存器
  │     └─ OopMap 标记所有寄存器为 callee-saved
  │
  ├─ 2. set_last_Java_frame(noreg, noreg, NULL) ← 设置 Java 帧边界
  │
  ├─ 3. call C++ 运行时函数                      ← 实际业务逻辑
  │     └─ oop_maps->add_gc_map()               ← 注册 GC 信息
  │
  ├─ 4. reset_last_Java_frame(false)             ← 清除 Java 帧边界
  │
  ├─ 5. 检查 pending_exception
  │     ├─ 无异常 → 恢复寄存器 → ret/jmp
  │     └─ 有异常 → 恢复寄存器 → jump(forward_exception_entry)
  │
  └─ 6. 存根返回
```

后续 4 篇文章就是在这个骨架上填入不同的"肉"——不同的 C++ 回调、不同的 post-call 处理、不同的帧结构。

---

## 9. 小节

本章建立了 7 个基础概念，它们是所有存根的共同积木：

| 概念 | 数据结构 | 核心操作 | 章节 |
|------|---------|---------|------|
| RegisterSaver | `layout` 枚举（偏移量） | save / restore / restore_result | 2 |
| last_Java_frame | `JavaThread` 的三个字段 | set / reset | 3 |
| vm_result_2 | `JavaThread::_vm_result_2` | get_vm_result_2 | 4 |
| forward_exception_entry | `StubRoutines` 中的一个地址 | 异常检测 + jump | 5 |
| CodeBlob 类型 | RuntimeStub / SafepointBlob / DeoptimizationBlob / UncommonTrapBlob | new_runtime_stub / create | 6 |
| CodeBuffer / OopMap | CodeBuffer / OopMapSet / OopMap | add_gc_map | 7 |
| generate_stubs() | 11 个静态字段 + 1 个快捷引用 | 25 行函数体 | 8 |

下一篇（[18.2](02-resolve-stubs.md)）开始，用这些积木搭建第一个存根——resolve stub。