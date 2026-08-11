# 16.3 方法入口、Threaded Dispatch 与运行时边界

> **本文定位**：生成后的解释器如何运行——`MethodKind` 如何选择入口、`TosState + bytecode` 的 dispatch table 如何定位 handler、`dispatch_base` 中嵌入的 thread-local safepoint polling 机制、dispatch table 切换（`_normal_table` / `_safept_table` / `_active_table`）、以及 OSR 从解释执行到编译执行的过渡。
>
> **前置依赖**：[16.1](01-interpreter-initialization.md)——已经理解 `TemplateInterpreter::initialize()` 和代码生成顺序；[16.2](02-codelet-generation.md)——已经理解 Codelet、Template 和 `generate_all()`。
>
> **JDK 版本**：本文基于 **OpenJDK 11u、x86-64、正常启用 Template Interpreter 的 HotSpot 构建**。

---

## 1. MethodKind——不只是四种入口

### 1.1 教学分组 vs 源码枚举

通常的教学描述是"普通 / synchronized / native / abstract 四种方法入口"。这是简化的教学分组——源码中 `MethodKind`（`abstractInterpreter.hpp:59`）定义了更多种类：

```
zerolocals                     ← 普通 Java 方法
zerolocals_synchronized        ← synchronized 方法
native                          ← native 方法
native_synchronized             ← synchronized native 方法
abstract                        ← abstract 方法
empty                           ← 空方法体（快速返回）
accessor                        ← getter/setter 专用路径
java_lang_math_sin / cos / ...  ← Math 类的 intrinsic
java_lang_ref_reference_get     ← Reference.get() 的 intrinsic
method_handle_invoke_*           ← MethodHandle 调用（多个子类）
```

每个 `MethodKind` 对应 `AbstractInterpreter::_entry_table` 中的一个槽，在 `generate_all()` 时被 `TemplateInterpreterGenerator` 填充。

### 1.2 入口选择：从 Method 对象到 entry 地址

当需要执行一个方法时，入口选择分两步：

```
① Method 对象 → MethodKind
   Method 上的 access flags（ACC_NATIVE, ACC_SYNCHRONIZED, ACC_ABSTRACT, ...）
   → 映射到 MethodKind 枚举

② MethodKind → entry 地址
   Interpreter::entry_for_kind(method_kind)
   → AbstractInterpreter::_entry_table[method_kind]
   → 返回对应的 TemplateInterpreter 入口
```

源码路径（`abstractInterpreter.hpp:135`）：

```cpp
static address entry_for_kind(MethodKind k) {
  return _entry_table[k];
}
```

### 1.3 不是所有入口最终都进入字节码 dispatch

这是常见的误解——认为"所有方法都通过解释器 dispatch table 执行"。实际分类：

| 入口类别 | 进入字节码 dispatch？ | 实际路径 |
|---------|---------------------|---------|
| `zerolocals` | **是**——建解释器栈帧后进入 dispatch | `generate_normal_entry` → 分配 frame → 进入字节码循环 |
| `zerolocals_synchronized` | **是**——先 lock monitor，再进入 dispatch | monitor enter → 分配 frame → dispatch |
| `native` | **否**——直接进入 JNI transition | `generate_native_entry` → `Method::native_function` |
| `native_synchronized` | **否**——JNI + monitor | monitor enter → native call → monitor exit |
| `abstract` | **否**——直接抛异常 | `throw_AbstractMethodError` |
| `empty` / `accessor` / `intrinsic` | **否**——走专门快速路径 | 直接计算/返回，无字节码 |

只有 `zerolocals` 和 `zerolocals_synchronized` 真正进入了字节码 dispatch。native 和 abstract 是**完全不同**的执行路径。

---

## 2. TosState——栈顶缓存的类型状态

### 2.1 为什么需要 TosState

考虑同一个字节码 `_iload`——当解释器在两种不同状态下执行它：

```
场景 A: 上一个字节码是 _iconst_0 → 栈顶是 int (TosState = itos)
场景 B: 上一个字节码是 _aload_0  → 栈顶是 ref (TosState = atos)
```

在场景 A 中，栈顶的 int 存在 `rax` 寄存器中。在场景 B 中，栈顶的 ref 存在另一个寄存器中。同一个 `_iload` 字节码需要两种不同入口来正确处理这两种情况。

`TosState`（Top-of-Stack State）就是解释器对"当前栈顶是什么类型"的运行时抽象。

### 2.2 10 种 TosState

| TosState | 含义 | 栈占用 | x86 栈顶寄存器 |
|----------|------|--------|---------------|
| `btos` | byte | 1 slot | — |
| `ztos` | boolean | 1 slot | — |
| `ctos` | char | 1 slot | — |
| `stos` | short | 1 slot | — |
| `itos` | int | 1 slot | `rax` |
| `ltos` | long | 2 slots | `rax`(lo) + `rdx`(hi) |
| `ftos` | float | 1 slot | `xmm0` |
| `dtos` | double | 2 slots | `xmm0` |
| `atos` | reference | 1 slot | `rax` |
| `vtos` | void（栈空） | 0 slots | — |

注意 `itos` 和 `atos` 都用 `rax` 寄存器——但区分 TosState 是必要的，因为后续操作不同（int 做算术，ref 做 GC 安全处理）。

### 2.3 TosState 的维护——每个 Codelet 更新它

解释器在 `r13`（x86-64 的 `_bcp_register` 旁边的另一个专用寄存器）或某个栈槽中维护 `_tos_state`。每个 Codelet 在开始时根据上一个 TosState 选择入口，在结束时更新 TosState（因为刚执行的字节码改变了栈顶类型）。

```
_iconst_0 开始: TosState = vtos（栈空）
_iconst_0 结束: TosState = itos（栈顶是 int 0）
   ↓ dispatch: 用 itos 查下一个字节码的入口
_iload_1  开始: TosState = itos
_iload_1  结束: TosState = itos（还是 int——加载了 local[1] 到栈顶）
```

---

## 3. DispatchTable——TosState + bytecode 的二维索引

### 3.1 数据结构

```cpp
/* templateInterpreter.hpp:65-83 */

class DispatchTable {
  enum { length = 1 << BitsPerByte };        // 256（bytecode 维度）

  address _table[number_of_states][length];   // [10 种 TosState][256 种 bytecode]
                                              // = 10 × 256 = 2560 个 entry 槽
};
```

索引公式：`_table[current_tos_state][next_bytecode]`。

总共 2560 个槽——但大多数是**重复的**（同一个 Codelet 的不同 TosState 偏移指向同一段代码的不同位置）。

### 3.2 三种 dispatch table

```cpp
/* templateInterpreter.hpp:131-133 */

static DispatchTable _active_table;    // 当前使用的表
static DispatchTable _normal_table;    // 正常：指向字节码 Codelet
static DispatchTable _safept_table;    // safepoint：指向 safepoint handler
```

`_normal_table` 的 entry 指向字节码 Codelet 的对应 TosState 入口。`_safept_table` 的 entry 指向 safepoint handler——一段先让线程停住、safepoint 结束后再恢复执行的代码。

`_active_table` 在正常模式下指向 `_normal_table`，GC 需要 safepoint 时切换到 `_safept_table`。

```cpp
// templateInterpreter.cpp:70
_active_table = _normal_table;  // 初始化为正常模式
```

### 3.3 同一字节码的多个 TosState 入口

以 `_iload` 为例，`generate_all()` 完成后 dispatch table 的内容：

```
_normal_table[itos][_iload]  → iload 的 itos_entry
_normal_table[atos][_iload]  → iload 的 atos_entry
_normal_table[vtos][_iload]  → iload 的 vtos_entry
...
_normal_table[dtos][_iload]  → iload 的 dtos_entry
```

10 个 TosState 各有独立入口——但它们都指向**同一个 InterpreterCodelet** 内的不同偏移。Codelet 开头有一个 jump table（`EntryPoint`），根据 TosState 分发到不同实现。

---

## 4. Threaded Dispatch——`dispatch_next` 的真实 x86 实现

### 4.1 `dispatch_next`——三步完成

```cpp
/* interp_masm_x86.cpp:881-887 */

void InterpreterMacroAssembler::dispatch_next(TosState state, int step, bool generate_poll) {
  // ① 加载下一个 bytecode
  load_unsigned_byte(rbx, Address(_bcp_register, step));

  // ② 推进 BCP
  increment(_bcp_register, step);

  // ③ 查 dispatch table + 间接跳转（内嵌 safepoint polling）
  dispatch_base(state, Interpreter::dispatch_table(state), true, generate_poll);
}
```

概念上对应的 x86 机器指令（`_bcp_register` = `rsi`，`step` = 1）：

```asm
movzx  rbx, byte [rsi + 1]    ; ① 加载下一个 bytecode 到 rbx
add    rsi, 1                 ; ② 推进 BCP

; ③ dispatch_base(state, table) 部分——见下文
```

`rbx` 寄存器保存当前 bytecode——它会被用作 dispatch table 的索引。

### 4.2 `dispatch_base`——核心跳转 + 内嵌 safepoint polling

`dispatch_base` 才是真正的 dispatch 核心。完整解析（`interp_masm_x86.cpp:808-866`）：

```cpp
void InterpreterMacroAssembler::dispatch_base(TosState state,
                                               address* table,
                                               bool verifyoop,
                                               bool generate_poll) {
  // ① frame 完整性检查（仅在 VerifyActivationFrameSize 时）
  if (VerifyActivationFrameSize) {
    // 检查 rbp - rsp >= 最小帧大小
    cmpptr(rcx, min_frame_size);
    jcc(Assembler::greaterEqual, L);
    stop("broken stack frame");
  }

  // ② oop 验证（verifyoop = true 时）
  if (verifyoop) {
    verify_oop(rax, state);
  }

  // ③ ★ 核心：safepoint polling + dispatch 跳转
  //    在 LP64 (x86-64) 路径中
  Label no_safepoint, dispatch;

  if (uses_thread_local_poll() && table != safepoint_table && generate_poll) {
    // ③a. Thread-local safepoint poll
    testb(Address(r15_thread, Thread::polling_page_offset()),
          SafepointMechanism::poll_bit());
    jccb(Assembler::zero, no_safepoint);     // poll bit = 0 → 无需 safepoint

    // ③b. 需要 safepoint → 跳到 safepoint_table
    lea(rscratch1, ExternalAddress((address)safepoint_table));
    jmpb(dispatch);
  }

  bind(no_safepoint);
  lea(rscratch1, ExternalAddress((address)table));  // ③c. 不需要 safepoint → 跳到正常表
  bind(dispatch);
  jmp(Address(rscratch1, rbx, Address::times_8));   // ③d. 间接跳转: table[rbx*8]
}
```

概念上对应的 x86-64 机器指令（`generate_poll=true`, `table != safepoint_table` 时的 LP64 路径）：

```asm
; ③a. Thread-local safepoint poll
test    byte [r15 + Thread::polling_page_offset], SafepointMechanism::poll_bit
jz      no_safepoint              ; poll bit == 0 → 跳过 safepoint

; ③b. 需要 safepoint
lea     r11, [safepoint_table]     ; 加载 safepoint 表地址
jmp     dispatch

no_safepoint:
; ③c. 不需要 safepoint
lea     r11, [normal_table[tos*256]]  ; 加载正常表地址（按当前 TosState 切片的起始地址）

dispatch:
; ③d. 间接跳转——rbx = 下一个 bytecode
jmp     [r11 + rbx*8]              ; 跳到 table[rbx]
```

### 4.3 display_base 的设计要点

| 设计点 | 实现 | 原因 |
|--------|------|------|
| 间接跳转 | `jmp [r11 + rbx*8]` | 不是 `call`——无函数调用开销 |
| safepoint polling | `testb` 模式 | 访问 polling page → 如果 poll bit=1，触发 segfault → JVM 信号处理 → safepoint |
| 条件分支 | `jz no_safepoint` | 95%+ 的情况没有 safepoint → 直接走 no_safepoint 路径 |
| `generate_poll` 控制 | 只在 `branch`、`return` 等高频控制流点生成 poll | 不是每个 dispatch 都 poll——按需 |
| `table != safepoint_table` | 当 table 本身已经是 safepoint table 时不再递归 poll | 避免无限递归 |

### 4.4 `dispatch_only` 的不同变体

```cpp
// 正常 dispatch：用 _active_table（可能是 normal 或 safepoint）
void dispatch_only(TosState state, bool generate_poll) {
  dispatch_base(state, Interpreter::dispatch_table(state), true, generate_poll);
}

// 强制只用 normal table——跳过 safepoint
void dispatch_only_normal(TosState state) {
  dispatch_base(state, Interpreter::normal_table(state));
}

// normal table + 跳过 oop 验证
void dispatch_only_noverify(TosState state) {
  dispatch_base(state, Interpreter::normal_table(state), false);
}
```

### 4.5 默认 dispatch 与自行 dispatch

两个路径控制字节码间的转移：

- **默认 dispatch**：普通字节码（如 `_iload`、`_iadd`）的 Codelet 末尾由公共模板块 `dispatch_epilog()` 补上 `dispatch_next`。`dispatch_epilog` 本质上就是 `dispatch_next(state, step=1)`。

- **自行 dispatch**：`does_dispatch()` 标志的字节码（`_goto`、`_if*`、`_invoke*`、`_return`）自行生成控制转移——不走 `dispatch_epilog`。这些模板在 Codelet 生成时直接调用 `dispatch_only` 或 `dispatch_via` 来控制去向。

```cpp
// 自行 dispatch 的典型用法——_goto 模板
void TemplateTable::goto_() {
  // ... 计算跳转目标 BCP = _bcp_register + offset ...
  // 自己决定跳到哪个 bytecode——不通过 dispatch_epilog
  dispatch_only(vtos);
}
```

---

## 5. Safepoint 机制——表切换 + thread-local poll 双重保障

### 5.1 主机制：dispatch table 切换

当 GC 需要 safepoint 时，`SafepointSynchronize::begin()` 调用 `Interpreter::notice_safepoints()`（`templateInterpreter.hpp:183`），将 `_active_table` 切换到 `_safept_table`。

切换后，解释器线程在**下一次 dispatch** 时自动进入 safepoint handler——因为 dispatch table 的所有 entry 都指向了 safepoint handler，不再指向字节码 Codelet。

safepoint handler 的职责：
1. 保存当前线程状态（寄存器、BCP、局部变量表）
2. 通知 safepoint 协调器本线程已就绪
3. 等待所有线程到达 safepoint
4. safepoint 结束后恢复状态
5. 重新 dispatch——此时 `_active_table` 已切回 `_normal_table`

切换回 `_normal_table` 由 `Interpreter::ignore_safepoints()`（`templateInterpreter.hpp:184`）在 safepoint 结束后调用。

### 5.2 补充机制：thread-local polling

关键发现：**dispatch table 切换不能保证"立刻就进入 safepoint"**。如果线程当前正在执行一个耗时较长的 Codelet（如 `_multianewarray`），它可能很长时间都不做 dispatch。thread-local polling 解决了这个"长时间不 dispatch"的问题。

在"关键位置"（`generate_poll=true` 的 dispatch site）插入：

```asm
test    byte [r15 + Thread::polling_page_offset], SafepointMechanism::poll_bit
```

- `r15` = x86-64 的 `_thread` 寄存器（始终指向当前 JavaThread）
- `polling_page_offset` = `Thread` 对象中 polling page 地址的偏移
- `SafepointMechanism::poll_bit()` = 1

GC 需要 safepoint 时，将 polling page 的保护属性改为 `PROT_NONE`。`testb` 指令读这个地址 → SIGSEGV → JVM 信号处理器捕获 → 发现是 safepoint → 线程暂停。

`dispatch_base` 中 poll 只在 `generate_poll=true` 时才生成——即 **backedge**（循环返回边）和 **return** 处的 dispatch。这些位置保证"不会无限期不做 dispatch"。

### 5.3 两种机制的互补

| 机制 | 作用 | 时机 | 覆盖范围 |
|------|------|------|---------|
| dispatch table 切换 | 所有线程在下次 dispatch 时进入 safepoint | GC 开始 | 100% 覆盖 |
| thread-local poll | 对"长时间不 dispatch"的线程强制暂停 | GC 开始 + polling page 设 PROT_NONE | 仅 backedge/return dispatch 点 |

两种机制互补保证：
- 正常线程 → dispatch table 切换 → 下一条字节码就进入 safepoint ✅
- 长字节码线程 → thread-local poll → 在 backedge 处被强制暂停 ✅

---

## 6. 异常与反优化入口

### 6.1 异常入口——Codelet 中的预生成路径

`generate_all()` 在 `TemplateInterpreterGenerator` 中生成多个异常入口（`templateInterpreter.hpp:104-109`）：

```cpp
static address _throw_NullPointerException_entry;
static address _throw_ArithmeticException_entry;
static address _throw_ClassCastException_entry;
static address _throw_ArrayIndexOutOfBoundsException_entry;
static address _throw_ArrayStoreException_entry;
static address _throw_StackOverflowError_entry;
```

这些是**高频异常**的专用快速通道——不需要走通用的异常表查找。例如 `_throw_NullPointerException_entry` 直接创建 NPE 对象、填充栈回溯、跳转到 handler。

通用异常由 `_throw_exception_entry` 处理——遍历方法的异常表、匹配类型、跳转到 handler。

### 6.2 反优化入口——从编译帧回到解释器

```cpp
/* templateInterpreter.hpp:123 */
static EntryPoint _deopt_entry[number_of_deopt_entries];  // 反优化入口
```

当 `nmethod` 被标记为 `not_entrant` 后，运行中的编译代码需要切换回解释执行。`_deopt_entry` 接收来自 `SharedRuntime::fetch_unroll_info` 的反优化信息，负责：
1. 从编译帧重建解释器栈帧
2. 恢复 BCP 到正确的字节码位置
3. 跳转到对应的字节码 Codelet 继续解释执行

---

## 7. OSR——解释执行到编译执行的过渡

### 7.1 触发路径

OSR 的触发不像"发现热点立即在 safepoint 中编译"的教学简化——实际流程更长：

```
解释执行中
  ↓
字节码是 loop backedge（如 _goto 往后跳）
  ↓
TemplateTable::branch() → 更新 InvocationCounter + BackEdgeCounter
  ↓
counter overflow → InterpreterRuntime::frequency_counter_overflow()
  ↓
编译策略（CompilationPolicy）判断：
  ├─ 方法太短 → 不编译
  ├─ 还没热到阈值 → 不编译
  └─ 达到阈值 → 提交编译任务给 CompileBroker
       ↓
     编译可能在后台异步进行——不阻塞当前解释执行
       ↓
     编译器完成 → 生成 OSR nmethod
       ↓
     下一次 backedge：检测到有有效的 OSR nmethod
       ↓
     OSR migration（在 safepoint 中）
```

关键修正——**编译不一定在 safepoint 中**发生。OSR 编译与普通编译一样，可能异步排队。只有 OSR migration（从解释帧切换到编译帧）必须在 safepoint 中完成。

### 7.2 OSR Migration——从解释帧到编译帧

```cpp
// interpreterRuntime.cpp → SharedRuntime::OSR_migration_begin()

// 1. 打包解释器的 locals / expression stack / monitor 锁
//    → 写入 OSR migration buffer（在堆上分配的临时对象）
// 2. 验证 OSR nmethod 仍然有效
// 3. 返回 nmethod::osr_entry() 的地址
```

`OSR_migration_begin()` 完成返回后，执行流跳转到 `nmethod::osr_entry()`。从此这个方法在编译版本中运行——不再走解释器。

### 7.3 为什么 OSR nmethod 不直接复用正常编译入口

OSR nmethod 的编译起点不是方法入口——是 loop backedge 处的字节码偏移。编译后的代码需要假设"局部变量表已经填充、栈上有未完成的计算"。这与从方法入口编译不同（那时局部变量表是空的）。

所以 OSR nmethod 有专门的 `osr_entry()`——与 `verified_entry_point()` 分开。

---

## 8. 小结

```
解释器运行时的精确画像：

1. 方法入口选择:
   - MethodKind 枚举决定 entry，zerolocals/zerolocals_synchronized 走 dispatch
   - native/abstract/empty/accessor/intrinsic 各走专属路径

2. TosState + bytecode 二维 dispatch:
   - 10 种 TosState × 256 bytecode = 2560 个槽
   - dispatch_next: load bytecode → advance BCP → dispatch_base

3. dispatch_base 的内核:
   - safepoint poll (testb) → conditional jump to safepoint_table
   - 或 lea + jmp [table + rbx*8] → 间接跳转到目标 Codelet

4. Safepoint: 表切换（主）+ thread-local poll（补充）
   - _active_table 在 normal/safept 间切换
   - poll 只在 backedge/return dispatch 点生成

5. OSR: 解释→编译边界
   - counter overflow → compilation policy → OSR nmethod → migration
   - 编译可能异步，migration 必须在 safepoint 中
```

下一篇（ch17）深入 `TemplateTable::initialize()`——如何为每种字节码注册模板描述符。
