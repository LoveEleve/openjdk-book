# 第三卷：解释器 — 字节码执行的微观世界

> **《OpenJDK HotSpot 源码深度分析》第 3 卷 / 共 8 卷**
> 覆盖：256 条字节码定义 → 模板解释器 → 机器码生成 → wide 分派 → GC 屏障 → JSR 292 invokedynamic

---

## §〇 卷定位与依赖

### 定位

本卷聚焦 HotSpot **模板解释器（Template Interpreter）**的完整链路：从字节码的静态定义（`Bytecodes::def()` × ~200 次）到每个字节码的动态机器码生成（`TemplateTable::_xxx()` → x86 汇编），是理解 JVM 执行引擎的基石。

### 前置依赖

| 依赖 | 卷/章 | 关键知识点 |
|------|-------|-----------|
| CodeCache 分配 | Vol.1 Ch.3 §3.5 | StubQueue + BufferBlob 为解释器分配 CodeHeap 空间 |
| 类型系统 | Vol.1 Ch.4 §4.2 | Klass/Oop/Method 对象是解释器操作的载体 |
| 线程模型 | Vol.2 | JavaThread 状态机、栈帧结构 |
| 常量池解析 | Vol.1 Ch.3 §3.8 | ConstantPoolCache 是 invoke/field 字节码的运行时缓存 |
| safepoint 机制 | Vol.1 Ch.1 §1.5 | dispatch_next() 在每个字节码之间检查 safepoint |

### 后续依赖本文的卷

| 后续卷 | 如何依赖 |
|--------|---------|
| JIT 编译器 (C1/C2) | 编译阈值由 InvocationCounter 触发 → 字节码→编译的转换点 |
| JVM TI + Debug | 字节码断点、单步、JSR 重写均由解释器路径支持 |
| GC 子系统 | 解释器中的 oop store/load 包含 GC 屏障 |

---

## §一 卷架构：五章设计

```
第 1 章 ─── 解释器整体框架（类型系统 + 分派机制 + StubQueue + 初始化）
              ↓
第 2 章 ─── 字节码定义表（Bytecodes 6 数组 + format 字符串 + Rewriter 重写）
              ↓
第 3 章 ─── Template→机器码生成（Template::def → generate() → InterpreterMacroAssembler → x86 汇编）
              ↓
第 4 章 ─── 逐类字节码汇编生成（14 类字节码，每类 1-3 个代表性案例完整链路）
              ↓
第 5 章 ─── GC 屏障 + JSR 292 + 调用链接（解释器中的 GC 屏障、invokedynamic、CR AbstractInterpreter 接口）
```

---

## §二 详细章节规划

---

### 第 1 章：解释器整体框架 — TemplateInterpreter 架构与 7 调用初始化

#### 1.1 两种解释器模式

> **C++ 解释器**（`CC_INTERP` 宏，纯 C++ switch-case 虚拟机）
> **模板解释器**（`TEMPLATE_INTERP`，x86/arm64 默认，本卷主角）

- `bytecodeInterpreter.cpp` (3503 行)：C++ 解释器主循环——用一个巨大的 `switch(opcode)` 实现 256 字节码的纯软件仿真。`#ifdef CC_INTERP` 时启用，Zero 端口和调试场景使用。
- `templateInterpreter.cpp` (372 行)：模板解释器初始化入口——`TemplateInterpreter::initialize()` 分配 StubQueue、生成所有 codelet、初始化 TemplateTable。
- `interpreter.hpp` vs `abstractInterpreter.hpp`：`Interpreter` 是工厂类，`AbstractInterpreter` 是抽象基类——提供 `code()` 获取 StubQueue、`entry_for_method()` 获取方法入口 codelet。

#### 1.2 解释器 Codelet 分派架构

- **Codelet**：解释器执行的基本单位——每个字节码 + 方法入口 + 返回入口 + 异常入口都是一个 codelet，存在 CodeCache 的 StubQueue 中。
- **分派循环**：`dispatch_next()` 在每个 codelet 末尾执行——`movzbl (%r13), %ebx; jmp *(r10, rbx, 8)`（LOAD + TABLEJUMP）。
- **TosState 缓存**：操作数栈顶缓存在寄存器（itos→rax, ftos→xmm0, dtos→xmm0, atos→rax, ltos→rax:rdx, vtos→无缓存），避免频繁内存读写。
- **寄存器约定**（x86_64）：`r13 = bcp`, `r14 = locals`, `rsp = expression stack`, `rax = tos cache`。

#### 1.3 TemplateInterpreter::initialize() 全链路

```
interpreter_init() → Interpreter::initialize() → TemplateInterpreter::initialize()
  ├── (1) StubQueue::StubQueue(InterpreterCodelet, &code, interpreter_code_size)
  │         └→ BufferBlob::create("Interpreter", code_size)
  │              └→ CodeCache::allocate(code_size)  // NonNMethod segment
  ├── (2) TemplateInterpreterGenerator gen(code)
  │         └→ gen.generate_all()
  │              ├── set_entry_points_for_all_bytes()     // 256 字节码 codelet
  │              ├── set_safepoints_for_all_bytes()       // safepoint 查询
  │              ├── generate_normal_entry(false)         // 正常入口
  │              ├── generate_normal_entry(true)          // Synchronized 入口
  │              ├── generate_native_entry(false)         // 本地方法入口
  │              ├── generate_return_entry_for(itos, 0) .. (vtos, 1)  // 10 种返回入口
  │              ├── generate_earlyret_entry_for(itos..vtos)          // JVM TI 提前返回
  │              ├── generate_throw_exception()                       // 异常抛出入门
  │              ├── generate_continuation_for(itos..vtos)            // 栈帧续接
  │              └── generate_safept_entry_for(itos..vtos)            // safepoint 入口
  └── (3) TemplateTable::initialize()
           └→ def() × ~270 次 // 普通 + wide + JVM 内部 + 平台特定字节码
```

#### 1.4 InvocationCounter — 编译阈值触发

- `invocationCounter.cpp` (207 行)：2 状态状态机 (`wait_for_nothing` → `do_nothing`, `wait_for_compile` → `do_decay`/`overflow`)。
- `CompileThreshold` 和 `TieredCompileThreshold` 的区别。
- `DelayCompilationDuringStartup` 的 `do_decay()` 机制：每次溢出计数右移 1 位（除以 2），避免启动时瞬时编译风暴。

#### 1.5 InterpreterMacroAssembler — 解释器专用的汇编器

- `interp_masm_x86.cpp` (2044 行) + `interp_masm_x86.hpp` (301 行)：扩展 `MacroAssembler`，提供解释器专用方法。
- 关键方法：`dispatch_next()`、`dispatch_via()`、`lock_method()`、`unlock_method()`、`call_VM()`、`notify_method_entry()`。
- `call_VM()` 的安全转换：Java 栈帧 → C 栈帧 → 调用 VM 运行时 → 恢复 Java 栈帧。

---

### 第 2 章：字节码定义表 — Bytecodes 6 数组与 Rewriter 重写

#### 2.1 Bytecodes::Code 枚举（256 + 内部字节码）

- `bytecodes.hpp` 中的 `enum Code` (line 38-298)：203 个标准 Java 字节码 + ~50 个 HotSpot 内部字节码。
- `_illegal = -1` 作为无效字节码标记。
- `number_of_java_codes = 203` 之后是 JVM 内部字节码（`_fast_agetfield` 等）。

#### 2.2 def() 的 6 个静态数组

> `bytecodes.cpp:157-175` — 核心 8 参数重载

| 数组 | 类型 | 大小 | 说明 |
|------|------|------|------|
| `_name[256]` | `const char*` | ~2KB | 字节码名称字符串 |
| `_result_type[256]` | `BasicType` | ~1KB | TOS 类型 (T_INT/T_LONG/T_FLOAT/T_DOUBLE/T_OBJECT/T_VOID) |
| `_depth[256]` | `int` | ~1KB | 栈深度变化（-1=弹出1净, 0=不变, 1=压入1） |
| `_lengths[256]` | `int` | ~1KB | `(wide_len << 4) \| (len & 0xF)` — 压缩编码 |
| `_java_code[256]` | `Code` | ~1KB | HotSpot 内部字节码→标准字节码的映射 |
| `_flags[512]` | `jchar` | ~1KB | 前 256 普通 + 后 256 wide 变体 |

**总内存**: ~8KB 静态表，所有 Method 共享。

#### 2.3 compute_flags() 格式字符串解析

> `bytecodes.cpp:196-265`

- 格式字符串字符含义：`b` = 单字节, `i` = 局部变量索引, `j` = CP cache 索引, `k` = CP 索引, `c` = 有符号常量, `o` = 分支偏移。
- 重复字符编码：`jj` = 2 字节（`_fmt_has_j | _fmt_has_u2`）, `jjjj` = 4 字节。
- 标志位：`_fmt_has_j` (CP cache), `_fmt_has_k` (CP index), `_fmt_has_i` (local), `_fmt_has_c` (constant), `_fmt_has_o` (offset), `_bc_can_trap`, `_bc_can_rewrite`。

#### 2.4 Rewriter — 类加载时的字节码重写

> `rewriter.cpp` (630 行) FIXME: 实际 ~24,600 行源码, 待确认行数

- `Rewriter::rewrite()` (`rewriter.cpp` 入口): 遍历类中每个方法的字节码。
- **重写类型**：
  - `getfield → _fast_agetfield`（对象类型字段快速访问, 跳过类型检查）
  - `iload_0 → _fast_iaccess_0`（方法与字段访问混合的模式重写）
  - `tableswitch → _fast_linearswitch` / `lookupswitch → _fast_binaryswitch`（开关表优化）
  - `invokevirtual → _fast_invokevfinal`（final 方法去虚化）
- **重写安全**: `_bc_can_rewrite` 标志 + `Rewriter::rewrite_method()` 中的宽度检查——重写前后字节码长度必须一致，否则用 `nofast_*` 回退。
- **CDS 影响**: CDS dump 时重写预执行, 运行时跳过已重写方法（避免修改 ReadOnly 区域）。

#### 2.5 BytecodeStream — 字节码遍历引擎

> `bytecodeStream.cpp` (2811 行) FIXME: 实际 28 行, 需确认

- `BytecodeStream::next()`: 遍历 Method 字节码, 使用 `Bytecodes::length_for()` 计算下一条位置。
- `Bytecodes::wide_length_for()`: wide 前缀后读取 2 字节索引 → `length_for(code, true)`。

#### 2.6 BytecodeTracer — 字节码追踪器

> `bytecodeTracer.cpp` (602 行)

- `BytecodeTracer::trace()`: 执行每条字节码时打印操作码 + 操作数（调试用）。
- `-XX:+TraceBytecodes` 启用——输出格式：`[thread-id] 0xbcp: opcode [args]`。

---

### 第 3 章：Template→机器码生成 — 从描述符到 x86 汇编的完整链路

#### 3.1 Template 描述符 —— 字节码的元数据

> `templateTable.hpp` (359 行)

```cpp
class Template {
  int       _flags;      // uses_bcp | does_dispatch | calls_vm | wide
  TosState  _tos_in;     // 执行前 TOS 状态
  TosState  _tos_out;    // 执行后 TOS 状态
  generator _gen;        // 机器码生成函数指针
  int       _arg;        // 传递给生成器的参数
};
```

- `Template::def()` 的 5 种重载: 支持 `int`, `bool`, `TosState`, `Operation`, `Condition` 参数。
- `Template::generate(InterpreterMacroAssembler* masm)`: 设置 `_desc` + `_masm` → 调用 `_gen(_arg)` → `masm->flush()`。

#### 3.2 CodeletMark — RAII 代码提交

> `templateInterpreterGenerator.cpp` (share, 604 行 + x86 平台, 1884 行)

```cpp
class CodeletMark {
  StubQueue* _queue;        // AbstractInterpreter::code()
  InterpreterCodelet* _clet; // Stub 包装, 记录 name+size
  CodeletMark(InterpreterMacroAssembler*& masm):
    // 1. InterpreterCodelet* clet = code()->request(codelet_size)
    // 2. masm = new InterpreterMacroAssembler(clet->code_begin(), clet->code_end())
};
~CodeletMark() {
    // 析构时: code()->commit(clet->code_end() - clet->code_begin())
    //         AbstractInterpreter::set_entry(bytecode, clet->code_begin())
}
```

**关键**：`generate_all()` 中 ~300+ 个 `CodeletMark` 实例——每个生成一个 codelet，析构时自动提交到 StubQueue 并注册入口地址。

#### 3.3 generate_normal_entry() — 方法入口 codelet

> x86 版本: `templateInterpreterGenerator_x86.cpp`

- 分配栈帧: `enter()` → 分配 `frame::sender_sp_offset + method_offset + ...`
- `count_calls()` → 增量 `InvocationCounter::_counter`。
- `lock_method()` → 同步方法的 Monitor 获取（如果是 `ACC_SYNCHRONIZED`）。
- `dispatch_next()` → 跳转到第一条字节码的 codelet。

#### 3.4 分派机制: dispatch_next / dispatch_via

> `interp_masm_x86.cpp`

```asm
// dispatch_next() 的 x86_64 实现:
movzbl 0x0(%r13), %ebx         // 读当前 bcp 的字节码
jmp *(Address(r10, rbx, 8))    // dispatch_table[opcode]
```

- `dispatch_table`: `_active_table` → 256 个 `address` 条目，指向每个字节码的 codelet。
- `dispatch_only()` vs `dispatch_next()`: `dispatch_only` 不推进 bcp、不检查 safepoint，用于 `_goto` 等自己推进 bcp 的字节码。
- `dispatch_via(TosState)`: 根据 TOS 类型选择分发表——`itos/atos/ftos/dtos/vtos` 各一份表。

#### 3.5 InterpreterCodelet 与 StubQueue

> `templateInterpreter.hpp`

```cpp
class InterpreterCodelet: public Stub {
  const char* description() const { return _description; }
  Bytecodes::Code code() const    { return _bytecode; }
  // code_begin(), code_end()  from Stub
};
```

- 每个 codelet 在 `CodeCache::allocate()` 分配的 `NonNMethod` segment 中。
- `StubQueue::request()` + `commit()` 管理工作指针 `_stub_buffer`。
- `codelet_size` 通过 `AbstractInterpreter::code()->available_space()` 动态决定。

---

### 第 4 章：逐类字节码汇编生成 — 14 类字节码 Template → x86 汇编深度剖析

> **本章是全书特色章节**——不是字节码百科，而是选代表性字节码展示 **Template::def → generate() → x86 汇编** 的完整生成链路。

#### 字节码分类总览

| 类别 | 字节码范围 | 数量 | 代表性字节码（深度展开） |
|------|----------|------|----------------------|
| **4.1 常量** | nop..dconst_3, bipush, sipush, ldc | ~21 | `iconst_3`, `ldc`, `ldc2_w` |
| **4.2 加载** | iload..saload + iload_0..aload_3 | ~33 | `iload`, `iload_0`, `aaload` |
| **4.3 存储** | istore..sastore + istore_0..astore_3 | ~33 | `istore`, `iastore` |
| **4.4 栈操作** | pop..swap | 9 | `dup`, `dup_x1`, `swap` |
| **4.5 算术** | iadd..lxor + ineg..dneg | ~36 | `iadd`, `idiv` (除零处理), `lmul` |
| **4.6 类型转换** | i2l..i2s | 15 | `i2l`, `d2i` (NaN 处理) |
| **4.7 比较** | lcmp..dcmpg | 5 | `lcmp`, `fcmpl` (NaN 无序处理) |
| **4.8 控制流** | ifeq..jsr_w, ret, tableswitch, lookupswitch, goto_w | ~24 | `ifeq`, `tableswitch`, `lookupswitch` |
| **4.9 返回** | ireturn..return | 6 | `ireturn`, `return` |
| **4.10 字段访问** | getstatic..putfield + fast_* | 4 + ~20 | `getfield`, `putfield`, `getstatic` |
| **4.11 方法调用** | invokevirtual..invokedynamic + invokehandle | 6 + 2 | `invokevirtual`, `invokedynamic`, `invokeinterface` |
| **4.12 对象创建** | new, newarray, anewarray, multianewarray | 4 | `new`, `anewarray` |
| **4.13 同步/异常/类型检查** | monitorenter/exit, athrow, checkcast, instanceof | 6 | `monitorenter`, `athrow`, `checkcast` |
| **4.14 杂项** | wide, breakpoint, ifnull, ifnonnull | 4 | `wide`, `breakpoint` |

#### 每类字节码的标准分析框架

对每类字节码，选取 **1-3 个代表性字节码**，按以下链路展开：

```
Bytecodes::def() 静态描述
  → TemplateTable::def() 注册 Template 描述符
    → TemplateTable::_xxx() 平台无关的模板逻辑 (templateTable.cpp)
      → TemplateTable::_xxx() x86 汇编生成 (templateTable_x86.cpp)
        → InterpreterMacroAssembler 辅助方法 (interp_masm_x86.cpp)
          → 最终的 x86 机器码指令序列
```

每个代表性字节码必须展示：
1. `Bytecodes::def()` 调用的参数含义（format 字符串、result_type、depth）
2. `TemplateTable::def()` 的 flags + TosState 转换
3. 生成函数的源码逐段分析（栈操作、CP 解析、VM 调用）
4. 最终生成的 x86 汇编伪代码（关键指令序列）
5. Counterfactual：如果不用模板而用 switch-case 会怎样？如果改用寄存器约定会怎样？

#### 4.1 常量字节码

**`iconst_3`** — 简单常量加载的代表
- `Bytecodes::def(_iconst_3, "iconst_3", "b", NULL, T_INT, 1, false, Bytecodes::_illegal)` → result_type=T_INT, depth=1
- `TemplateTable::def(Bytecodes::_iconst_3, ____|____|____|____, vtos, itos, iconst, 3)` → vtos→itos, 生成器参数=3
- 生成器: `TemplateTable::iconst(int value)` → `__ movl(rax, value)` → 单条 x86 指令！
- 反事实: switch-case 需要 `case _iconst_3: push(3); break;` → 内存写入操作数栈 → ~2-3 cycles 额外开销 per 常量字节码 → 热点代码 10000 次 × 2 cycles = 20µs 额外。

**`ldc`** — 常量池访问的代表
- 需要 `call_VM()` 路径：`ldc` 解析 ConstantPool 条目可能触发类加载 / 字符串拘留 / MethodType 创建。
- `ubcp | clvm` flags → 使用 bcp 且调用 VM。
- 两种路径：快速路径（缓存命中，直接加载）vs 慢速路径（VM 调用解析）。

**`ldc2_w`** — 双槽常量（long/double）的特殊处理
- 为何 `_depth = 2`（压入 2 个槽位）
- ConstantPoolCache 的 2 槽位存储约定。

#### 4.2 加载字节码

**`iload`** (含 wide 变体) — 局部变量加载的代表
- `Bytecodes::def(_iload, "iload", "bi", ...)` → format="bi"=byte+index, depth=1
- `TemplateTable::def(_iload, ubcp|____|clvm|____, vtos, itos, iload, _)` → 使用 bcp, 调用 VM
- 普通路径: `locals_index()` → `__ movl(rax, iaddress(n))` → 从局部变量区加载到 rax
- Wide 路径: `TemplateTable::def(_iload, ubcp|____|____|iswd, vtos, itos, wide_iload, _)` → iswd 标志, 使用 `_template_table_wide[]`
- 字节码重写: `iload → _fast_iload`（当 mode=tos 时）→ 跳过局部索引字段读取，直接使用固定偏移

**`iload_0`** — 隐式索引快捷加载的代表
- 不需要读 bcp 中的索引字节，直接 `__ movl(rax, iaddress(0))`
- 跟 `iconst_0` 的区别：`iconst_0` 是常量 0，`iload_0` 是读取局部变量 0

**`aaload`** — 对象数组加载的代表（含 GC 屏障）
- 数组边界检查: `index >= length → ArrayIndexOutOfBoundsException`
- oop 加载必须经过 `BarrierSet::barrier_set()->load_barrier()`（ZGC 加载屏障, 后详）

#### 4.3 存储字节码

**`istore`** — 局部变量存储的代表
- `TemplateTable::def(_istore, ubcp|____|clvm|____, itos, vtos, istore, _)` → itos→vtos
- 存储路径: `locals_index()` → `__ movl(iaddress(n), rax)` → 写入局部变量区

**`iastore`** — 数组元素存储的代表
- 数组边界检查 → `ArrayStoreException` 检查（对对象数组）
- 基本类型直接用 `movl/%xmm` 写入；对象类型触发 `oop_store` → GC 屏障

#### 4.4 栈操作字节码

**`dup`** — 栈复制
- x86 实现: `__ load_ptr(0, rax); __ push_ptr(rax);` — 从栈顶加载再压回
- 性能: 2 条 x86 指令，无分支，~2 CPU cycles

**`dup_x1`** — 更复杂的栈操作模式
- 栈变换: `..., value2, value1 → ..., value1, value2, value1`
- x86 实现中使用临时寄存器 `rcx` 中转

#### 4.5 算术字节码

**`iadd`** — 整数加法的代表, 展示 Operation 参数传递
- `def(Bytecodes::_iadd, ____|____|____|____, itos, itos, iop2, add)` → `_gen = iop2, _arg = add`
- 生成器: `iop2(Operation op)` → `switch (op) { case add: __ addl(rax, rdx); break; ... }`
- 最终 x86 指令: `pop(rdx); addl rax, rdx;` → 2 条指令

**`idiv`** — 除法特殊处理（除零检查 + 符号扩展）
- 除零分支: `testl rdx, rdx; jz handle_zero_divisor`
- `cdq` 符号扩展: `eax → edx:eax`（因为有符号除法的商和余数在不同寄存器）

**`lmul`** — 64 位乘法的代表（特殊 x86 指令序列）
- `imulq` 单指令可乘，但需要处理寄存器配对

#### 4.6 类型转换字节码

**`i2l`** — 窄类型转宽类型（符号扩展）
- `__ movslq(rax, rax)` — x86 一条指令搞定

**`d2i`** — 浮点转整数（NaN/溢出处理）
- `__ cvttsd2sil(rax, xmm0)` — 带截断的转换
- NaN → `Integer.MIN_VALUE` (0x80000000)
- 溢出 → 饱和值

#### 4.7 比较字节码

**`lcmp`** — 64 位整数比较（两寄存器操作数）
- 64 位值在 rax:rdx, rcx:rbx → `cmpq` + 条件码传播

**`fcmpl`** — 浮点比较（NaN 无序处理）
- `ucomiss xmm0, xmm1` → PF (Parity Flag) 指示 NaN
- NaN 情况: 返回 -1 (fcmpg 返回 1)

#### 4.8 控制流字节码

**`ifeq`** — 条件分支的代表
- `testl rax, rax; jz branch_target` → branch 调用 `dispatch_only()` 跳转
- `branch()` 函数: 计算目标 bcp = `bcp + offset` → `dispatch_only()` = `jmp dispatch_table[target_bytecode]`
- **为什么不是直接 jmp 到目标地址?** → 因为 JVM 在执行每条字节码时都可能需要 GC safepoint 检查

**`tableswitch`** — 开关跳转的密集优化
- 默认使用二分搜索 `lookupswitch`, Rewriter 可重写为 `_fast_linearswitch`（当 case 密集时）
- `_fast_linearswitch` x86 实现: 直接用 case 值作为索引跳转到 jump table

**`lookupswitch`** — 开关跳转的稀疏优化
- 可重写为 `_fast_binaryswitch`
- `_fast_binaryswitch` x86 实现: 对排序后的 key 值进行二分搜索

#### 4.9 返回字节码

**`ireturn`** — 值返回的代表
- 共享 `_return(TosState state)` 生成器
- 步骤: 弹出调用者帧 → 恢复 bcp/locals → 检查 safepoint → `dispatch_via(state)` → 跳转到调用者的下一条字节码

**`return`** (void 返回)
- 无需处理返回值（vtos），但需要检查是否需要执行 finalizer: `_return_register_finalizer` codelet

#### 4.10 字段访问字节码

**`getfield`** — 字段读取的代表
- `Bytecodes::def(_getfield, "getfield", "bjj", ...)` → 3 字节操作码
- `resolve_cache_and_index()` 从 ConstantPoolCache 获取 `offset`（字段偏移量）
- 生成代码: `movq obj_ref, rax; movq (rax, offset), rax` — 从对象偏移处读取字段
- 可重写为 `_fast_agetfield`（当字段类型确定时）→ 直接用固定偏移，跳过 CP 查找

**`putfield`** — 字段写入的代表 (含 GC 写屏障)
- 类似 getfield，但写入时触发 GC 屏障
- `BarrierSet::barrier_set()->store_barrier()` 处理卡表标记 (G1) 或 SATB 缓冲区 (G1/Shenandoah)

**`getstatic` / `putstatic`** — 静态字段访问
- 区别在于对象引用是 `java_mirror` (Class 对象) 而非实例

#### 4.11 方法调用字节码

**`invokevirtual`** — 虚方法调用的代表
- `resolve_cache_and_index()` → `load_invoke_cp_cache_entry()` — 从 CP Cache 获取 Method* 和 vtable_index
- 虚方法分派: `movq (klass, vtable_start), method_ptr; movq (method_ptr, vtable_index*8), entry_point`
- 可重写为 `_fast_invokevfinal`（final 方法去虚化）→ 直接跳转到 known entry point

**`invokedynamic`** — JSR 292 动态调用的代表
- GCJ: `Appendix::BootstrapSpecifier` → `CallSite` 绑定
- `invokedynamic()` 模板: `call_VM()` 解析调用点 → 从 CP Cache 获取 `MethodHandle` → 通过 `MethodHandles::jump_from_method_handle()` 适配
- 详见 §第五章 JSR 292 专题

**`invokeinterface`** — 接口调用的代表
- itable 搜索: 遍历 `klass->itable_length()` 查找匹配方法
- 与 `invokevirtual` 的差异: vtable 是固定索引（编译期确定），itable 是运行时搜索

#### 4.12 对象创建字节码

**`new`** — 对象实例化的代表
- 快速路径: TLAB (Thread Local Allocation Buffer) 分配 → `movq rax, tlab_top; addq tlab_top, size` → 无锁分配
- 慢速路径: `call_VM()` 走 Eden 分配 + 可能触发 GC
- 初始化: 归零对象内存 → 设置 MarkWord → 设置 Klass 指针

**`anewarray`** — 引用类型数组创建
- 类似 `new` + 额外的数组长度字段 + 数组元素初始化为 NULL

#### 4.13 同步/异常/类型检查字节码

**`monitorenter`** — 轻量级锁的代表
- 快速路径: `lock cmpxchg` 偏向锁 / 轻量级锁的 CAS
- 慢速路径: `call_VM(InterpreterRuntime::monitorenter())` — 锁膨胀到重量级锁

**`athrow`** — 异常抛出的代表
- `call_VM(InterpreterRuntime::exception_handler_for_exception())` — 查找异常处理器
- 找到处理器 → `dispatch_via()` 跳转到处理器第一条字节码
- 找不到 → unwind 栈帧 → 重复查找 → 直到栈顶或 JVM 退出

**`checkcast`** — 类型检查的代表
- 快速路径: `subclass_check()` 宏 → `cmpb secondary_super_cache` → 命中则通过
- 慢速路径: `call_VM()` 遍历 secondary_supers 数组

#### 4.14 杂项字节码

**`wide`** — 扩展字节码的前缀
- 执行后切换到 `_template_table_wide[]` 分发表
- `wide_iinc`: 本地变量索引为 2 字节 → 直接更新 2 字节常量值
- 为什么 wide 使用独立分发表 → 宽字节码执行频率极低，不值得为 5 种 TosState 各维护一份 wide 表

**`breakpoint`** — JVM TI 断点的实现基础
- `call_VM(InterpreterRuntime::breakpoint())` — 通知 JVM TI agent
- 与 `_shouldnotreachhere` 的区别: breakpoint 是外部可控的，shouldnotreachhere 是内部 sanity check

---

### 第 5 章：GC 屏障 + JSR 292 + 调用链接 — 解释器的高级主题

#### 5.1 解释器中的 GC 屏障

> 解释器负责 Java 语义，而 GC 语义通过 `BarrierSet` 抽象层注入到模板代码中

##### 5.1.1 BarrierSet 抽象层

- `TemplateTable::_bs = BarrierSet::barrier_set()` — 在 `TemplateTable::initialize()` 时缓存当前 GC 的屏障集
- `AccessBarrier` 接口: `load_barrier()`, `store_barrier()`, `resolve_barrier()`, `clone_barrier()`
- 解释器通过 `TemplateTable::patch_bytecode()` 在 `_fast_*` 重写字节码中插入屏障调用

##### 5.1.2 G1 写屏障 — SATB + 卡表

- SATB (Snapshot At The Beginning) 写前屏障: `oop_store` 前记录旧值到 SATB 队列
- 卡表 (Card Table) 写后屏障: `oop_store` 后标记卡表字节
- `TemplateTable::putfield()` 中的 G1 屏障:
  ```asm
  // Pre-barrier (SATB)
  movq %rax, old_value
  call g1_write_barrier_pre
  // Actual store
  movq new_value, (obj, offset)
  // Post-barrier (Card Table)
  shrl obj, CardTable::card_shift
  movb card_table_base(obj), 0
  ```
- `TemplateTable::aastore()` 中的 G1 屏障: 同上，但额外有 `ArrayStoreException` 检查

##### 5.1.3 Parallel GC 写屏障 — 仅卡表

- 无 SATB（Parallel GC 不使用快照算法）
- 仅需写后卡表标记:
  ```asm
  shrq rbx, CardTable::card_shift
  movb (CardTable::byte_map_base, rbx), 0
  ```

##### 5.1.4 ZGC 加载屏障 — 染色指针

- ZGC 染色指针在 `aload`/`aaload`/`getfield` 时触发加载屏障
- `TemplateTable::aload()` 中 ZGC 加载屏障:
  ```asm
  movq rax, (locals, offset)      // 加载 oop
  testq rax, ZAddressMetadataMask  // 检查染色位
  jz done                          // 未染色，跳过屏障
  call ZBarrier::load_barrier_on_oop_field_preloaded  // 自愈
  ```
- 问题: ZGC 屏障在解释器中的频率远高于编译代码 → 因为编译代码可通过 JIT 屏障消除优化

##### 5.1.5 Shenandoah GC 屏障 — Brooks Pointer

- Brooks Pointer 间接访问: `oop = *(oop + brooks_offset)` — 每次 `aload` 都解引用
- 解释器在 `TemplateTable::aload()` 中的 Shenandoah 屏障:
  ```asm
  movq rax, (locals, offset)         // 加载 oop
  movq rax, (rax, brooks_offset)     // Brooks 间接
  ```

##### 5.1.6 GC 屏障诊断

```bash
# 1. 确认当前 GC 使用的屏障集
jcmd <pid> VM.flags -all | grep -i "barrier\\|barrierset"

# 2. GDB 查看屏障集实例
gdb -ex "print BarrierSet::barrier_set()" \
    -ex "print ((G1BarrierSet*)BarrierSet::barrier_set())->_satb_mark_queue_set" \
    --pid <pid>

# 3. strace 观察 ZGC 加载屏障的多页映射
strace -e mmap,mprotect -f java -XX:+UseZGC -jar app.jar 2>&1 | head -20
```

#### 5.2 JSR 292 (invokedynamic) — 解释器中的动态调用

##### 5.2.1 invokedynamic 字节码的执行路径

- `Bytecodes::def(_invokedynamic, "invokedynamic", "bj", ...)` → 省略的第三个操作数为 0（JVM 规范要求）
- `TemplateTable::invokedynamic(int byte_no)`:
  1. `resolve_cache_and_index(byte_no, cache, index, 4)` → 获取 4 字节 CP 索引
  2. `load_invoke_cp_cache_entry()` → 从 CP Cache 获取 `MemberName` + `MethodType` + `Appendix`
  3. 判断 `appendix` 是否为 `MethodHandle`: 若否 → `InvokeDynamic` 工厂创建；若是 → 直接调用
  4. 调整栈帧: 转换调用者参数栈 → MethodHandle 期望的栈布局
  5. 通过 `MethodHandles::jump_from_method_handle()` 跳转到目标方法

##### 5.2.2 invokehandle — 显式 MethodHandle 调用

- `Bytecodes::def(_invokehandle, "invokehandle", "bjj", ...)` — HotSpot 内部字节码，由 `invokevirtual MethodHandle.invokeExact` 重写而来
- `TemplateTable::invokehandle(int byte_no)`: 类似 invokedynamic 的逻辑，但不经过 `CallSite` 绑定

##### 5.2.3 LambdaForm 解释器执行

- `MethodHandles::generate_adapters()` → 为 MethodHandle 的组合生成 LambdaForm 解释器模板
- LambdaForm 在执行时表现为一系列 `MemberName` 的链式调用
- 解释器中的 `MethodHandles::jump_from_method_handle()` 处理参数转换 → invoke → 结果适配

##### 5.2.4 invokedynamic 诊断

```bash
# 1. 查看 invokedynamic 调用点
jcmd <pid> Compiler.directives_print  # 查看 lambda 相关编译指令

# 2. GDB 断点 invokedynamic 解析
gdb -ex "break interpreterRuntime.cpp:resolve_invoke" \
    -ex "condition 1 strcmp(method()->name()->as_C_string(), \"myLambda\") == 0" \
    --args java -jar app.jar

# 3. 查看 MethodHandle 链
jcmd <pid> VM.print_methods | grep "LambdaForm"
```

#### 5.3 调用链接 (Call Linkage) — 从解释器到编译代码

##### 5.3.1 i2c / c2i adapter

- `generate_all()` 中生成 `i2c` (interpreter to compiled) 和 `c2i` (compiled to interpreter) adapter
- `i2c`: 转换解释器寄存器约定 → 编译代码的 JavaCall 约定 → 跳转到 nmethod verified entry
- `c2i`: 保存编译代码状态 → 重建解释器栈帧 → 跳转到字节码 codelet

##### 5.3.2 方法调用入口选择

- `Method::_from_interpreted_entry`: 首次调用 → `generate_normal_entry()`
- `Method::_from_compiled_entry`: 调用计数器溢出后 → CompileBroker 编译 → `nmethod->verified_entry_point()`

##### 5.3.3 Transition 类型状态矩阵

- `TosState` 枚举（10 种状态）: `itos, atos, vtos, ltos, ftos, dtos, btos, ztos, ctos, stos`
- 每个 transition 对应一个入口 adapter
- `generate_return_entry_for()` 生成返回时恢复状态的 codelet

##### 5.3.4 编译阈值触发

- `InvocationCounter::InterpreterInvocationLimit` → 调用 `InterpreterRuntime::frequency_counter_overflow()`
- OSR (On-Stack Replacement): `Method::_from_interpreted_entry → osr_adapter` 将解释器栈帧转换为编译栈帧

#### 5.4 AbstractInterpreter — CR (Compact Representation) 接口

> `abstractInterpreter.hpp` + `abstractInterpreter.cpp` (448 行) FIXME: 实际文件为 18434+16841

- `AbstractInterpreter::MethodKind`: 17 种入口类型（`zerolocals`, `zerolocals_synchronized`, `native`, `java_lang_math_sin` ...）
- `AbstractInterpreter::entry_for_kind()`: 获取特定 kind 的入口 address
- `AbstractInterpreter::entry_for_method()`: `entry_for_kind(method_kind(method))`
- `AbstractInterpreter::size_top_interpreter_activation()`: 解释器激活的最大栈帧大小
- `StackKindTable`: 管理 17 种入口 → TosState 映射 → 代码生成时的排序

#### 5.5 OopMapCache — 解释器栈帧的 GC 根源

> `oopMapCache.cpp` (604 行)

- 解释器没有编译代码的显式 OopMap → 使用 `OopMapCache` 动态查找活动 oop
- `OopMapCache::lookup_mask(method, bci, comp_mask)`: 根据 Method + bci 返回该位置的活跃 oop 位图
- GC 在 safepoint 时遍历解释器栈帧: `frame::oops_interpreted_do()` → 对每个 bci 调用 `OopMapCache::compute_one_oop_map()`
- `InterpreterOopMap` 结构: `_bit_mask[]` + `_num_entries` — 压缩位图表示哪些局部变量/栈槽位包含 oop

#### 5.6 诊断工具五件套

| 工具 | 命令 | 用途 |
|------|------|------|
| strace | `strace -e trace=mmap,mprotect -f java -Xint -jar app.jar` | 观察解释器 codelet 的内存分配 |
| jcmd | `jcmd <pid> Compiler.queue` | 查看哪些方法的计数器已溢出 |
| jstack | `jstack <pid> \| grep -A5 "Interpreted frame"` | 查看解释器栈帧 |
| GDB | `gdb -ex "break TemplateTable::initialize" -ex "run" -ex "bt" --args java` | 断点解释器初始化 |
| /proc | `cat /proc/<pid>/maps \| grep CodeCache` | 查看解释器 codelet 的虚拟地址范围 |

---

## §三 源文件映射 — 与前面 14-Interpreter-Bytecodes-TemplateTable.md 的关系

### 已有分析资产

| 已有文档 | 行数 | 覆盖内容 | 本卷扩展 |
|---------|------|---------|---------|
| `01-jvm-startup/docs/14-Interpreter-Bytecodes-TemplateTable.md` | 1538 | 初始化全链路（7 调用）、Bytecodes 6 数组、TemplateTable def()、InvocationCounter、VMRegImpl | 扩展为 5 章完整分析——深度展开 14 类字节码的机器码生成、GC 屏障、JSR 292 |

### 第 1 章：解释器整体框架 — 源文件

| 文件 | 路径 | 行数 | 使用范围 |
|------|------|------|---------|
| interpreter.cpp | `share/interpreter/` | 138 | 全部 — `interpreter_init()` 入口 |
| interpreter.hpp | `share/interpreter/` | 168 | `Interpreter` 类声明, 入口方法 |
| abstractInterpreter.cpp | `share/interpreter/` | 448 | `MethodKind` 映射 (line 50-200), entry_for_kind() (line 300-447) |
| abstractInterpreter.hpp | `share/interpreter/` | 336 | `AbstractInterpreter` 基类, StackKindTable (line 180-335) |
| templateInterpreter.cpp | `share/interpreter/` | 372 | `TemplateInterpreter::initialize()` (line 42-371) |
| templateInterpreter.hpp | `share/interpreter/` | 203 | `TemplateInterpreter` 类, InterpreterCodelet (line 60-200) |
| templateInterpreterGenerator.hpp | `share/interpreter/` | 132 | `TemplateInterpreterGenerator` 声明 |
| templateInterpreterGenerator.cpp | `share/interpreter/` | 604 | `generate_all()` (line 48-603) |
| templateInterpreterGenerator_x86.cpp | `cpu/x86/` | 1884 | x86 codelet 生成实现 |
| templateInterpreterGenerator_x86_64.cpp | `cpu/x86/` | 457 | x86_64 特定入口生成 |
| interp_masm_x86.cpp | `cpu/x86/` | 2044 | `dispatch_next()` (line 100-180), `call_VM()` (line 200-500) |
| interp_masm_x86.hpp | `cpu/x86/` | 301 | `InterpreterMacroAssembler` 声明 |
| invocationCounter.cpp | `share/interpreter/` | 207 | `reinitialize()` (line 153-199), `do_decay()` (line 122-138) |
| invocationCounter.hpp | `share/interpreter/` | 156 | `InvocationCounter` 类声明 |
| cppInterpreter.cpp | `share/interpreter/` | ~2961 | CC_INTERP 参考（不做深度分析）|
| cppInterpreterGenerator.cpp | `share/interpreter/` | ~5259 | CC_INTERP 生成器（不做深度分析）|
| interpreterRuntime.cpp | `share/interpreter/` | 1650 | VM 调用目标函数: `monitorenter()` (line ~300), `athrow()` (line ~500), `frequency_counter_overflow()` (line ~700) |

### 第 2 章：字节码定义表 — 源文件

| 文件 | 路径 | 行数 | 使用范围 |
|------|------|------|---------|
| bytecodes.cpp | `share/interpreter/` | 568 | `def()` (line 157-175), `initialize()` (line 268-560), `compute_flags()` (line 196-265) |
| bytecodes.hpp | `share/interpreter/` | 445 | `enum Code` (line 38-298), 标志位 (line 305-340), 静态数组声明 (line 340-355) |
| bytecode.hpp | `share/interpreter/` | 345 | `Bytecode` 基类 (line 45-340) |
| bytecode.cpp | `share/interpreter/` | 268 | 字节码参数访问 (line 50-267) |
| bytecode.inline.hpp | `share/interpreter/` | 44 | 内联 getter 方法 |
| bytecodeStream.hpp | `share/interpreter/` | 230 | `BytecodeStream` 类 (line 40-229) |
| bytecodeStream.cpp | `share/interpreter/` | ~2811 | FIXME: 实际为 28 行，需核实文件大小 |
| bytecodeHistogram.cpp | `share/interpreter/` | 189 | 字节码频率统计 |
| bytecodeHistogram.hpp | `share/interpreter/` | 82 | Histogram 类 |
| bytecodeTracer.cpp | `share/interpreter/` | 602 | `BytecodeTracer::trace()` (line 50-601) |
| bytecodeTracer.hpp | `share/interpreter/` | ~2559 | FIXME: 行数异常，需核实 |
| rewriter.cpp | `share/interpreter/` | 630 | `rewrite()` (line 50-629), `rewrite_method()` (line 300-500) |
| rewriter.hpp | `share/interpreter/` | 216 | `Rewriter` 类声明 |

### 第 3 章：Template→机器码生成 — 源文件

| 文件 | 路径 | 行数 | 使用范围 |
|------|------|------|---------|
| templateTable.hpp | `share/interpreter/` | 359 | `Template` 类 (line 44-75), `TemplateTable` 类 (line 81-356) |
| templateTable.cpp | `share/interpreter/` | 555 | `Template::generate()` (line 58-65), `TemplateTable::def()` × 5 (line 180-223), `TemplateTable::initialize()` (line 244-531) |
| templateInterpreterGenerator.cpp | `share/interpreter/` | 604 | `generate_all()` 结构, `CodeletMark` RAII |
| templateInterpreterGenerator_x86.cpp | `cpu/x86/` | 1884 | x86 codelet 生成: `generate_normal_entry()` (line 200-400), `generate_return_entry_for()`, `generate_throw_exception()` |
| templateInterpreterGenerator_x86_64.cpp | `cpu/x86/` | 457 | x86_64: `generate_math_entry()`, `generate_CRC32_update_entry()` |
| interp_masm_x86.cpp | `cpu/x86/` | 2044 | `dispatch_next()` (line 100-180), `dispatch_via()` (line 180-250), `lock_method()` (line 300-400), `unlock_method()` (line 400-500) |
| interp_masm_x86.hpp | `cpu/x86/` | 301 | `InterpreterMacroAssembler` 声明 |
| interpreterRuntime.hpp | `share/interpreter/` | 199 | VM 调用函数声明 |
| interpreterRuntime.cpp | `share/interpreter/` | 1650 | VM 调用函数实现: `exception_handler_for_exception()` (line ~100), `frequency_counter_overflow()` (line ~600) |

### 第 4 章：逐类字节码汇编生成 — 源文件

| 文件 | 路径 | 行数 | 覆盖字节码 |
|------|------|------|----------|
| **常量** | | | |
| templateTable_x86.cpp | `cpu/x86/` | 4525 (总) | `iconst()` (line ~100), `bipush()` (line ~150), `sipush()` (line ~180), `ldc()` (line ~200-350), `ldc2_w()` (line ~350-450) |
| **加载/存储** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `iload()` (line ~500-600), `lload()` (line ~600-700), `aload()` (line ~700-900), `istore()` (line ~900-1000), `astore()` (line ~1000-1100), `wide_iload()` (line ~1100-1200) |
| **数组加载/存储** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `iaload()` (line ~1200-1300), `aaload()` (line ~1300-1500), `iastore()` (line ~1500-1600), `aastore()` (line ~1600-1800) |
| **栈操作** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `dup()` (line ~1800-1850), `dup_x1()` (line ~1850-1950), `swap()` (line ~1950-2000) |
| **算术** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `iop2()` (line ~2000-2100), `fop2()` (line ~2100-2200), `idiv()` (line ~2200-2350), `lmul()` (line ~2350-2500), `lshl()` (line ~2500-2600) |
| **类型转换** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `convert()` (line ~2600-2800) — handles all 15 conversions |
| **比较/控制流** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `lcmp()` (line ~2800-2900), `float_cmp()` (line ~2900-3000), `if_0cmp()` (line ~3000-3050), `if_icmp()` (line ~3050-3100), `tableswitch()` (line ~3100-3300), `lookupswitch()` (line ~3300-3500) |
| **返回** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `_return()` (line ~3500-3700) — handles all 6 return types |
| **字段访问** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `getfield_or_static()` (line ~3700-3900), `putfield_or_static()` (line ~3900-4100), `fast_accessfield()` (line ~4100-4300) |
| **方法调用** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `invokevirtual()` (line ~4300-4400), `invokespecial()` (line ~4400-4450), `invokestatic()` (line ~4450-4500), `invokeinterface()` (line ~4500+), `invokedynamic()` (line ~4525+), 可能需要 `invokehandle()` |
| **对象创建** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `_new()` (~100 行), `newarray()`, `anewarray()`, `multianewarray()` |
| **同步/异常/类型检查** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `monitorenter()` (~200 行), `monitorexit()`, `athrow()` (~150 行), `checkcast()` (~100 行), `instanceof()` |
| **杂项** | | | |
| templateTable_x86.cpp | `cpu/x86/` | | `wide()`, `_breakpoint()`, `shouldnotreachhere()` |
| 平台无关模板 | | | |
| templateTable.cpp | `share/interpreter/` | 555 | `_goto()` (line 134), `jsr()` (line 146), `branch()` (line ~134), `float_cmp()` (line 122), `double_cmp()` (line 128) |

### 第 5 章：GC 屏障 + JSR 292 + 调用链接 — 源文件

| 文件 | 路径 | 行数 | 使用范围 |
|------|------|------|---------|
| **GC 屏障** | | | |
| barrierSet.hpp/inline.hpp | `gc/shared/` | — | `BarrierSet` 基类, `AccessBarrier` 模板 |
| g1BarrierSet.hpp/cpp | `gc/g1/` | — | G1 SATB + Card Table 屏障实现 |
| zBarrierSet.hpp/cpp | `gc/z/` | — | ZGC 加载屏障 (染色指针自愈) |
| shenandoahBarrierSet.hpp/cpp | `gc/shenandoah/` | — | Brooks Pointer 间接访问 |
| parallelScavengeHeap.hpp | `gc/parallel/` | — | 卡表写后屏障参考 |
| templateTable.cpp | `share/interpreter/` | 555 | `_bs = BarrierSet::barrier_set()` (line 250) |
| templateTable_x86.cpp | `cpu/x86/` | 4525 | 屏障调用 (内联在 `putfield`, `aastore`, `aload`, `aaload` 等模板中) |
| **JSR 292** | | | |
| abstractInterpreter.cpp/hpp | `share/interpreter/` | — | `MethodKind` 包含 `invokehandle`, `invokedynamic` (line ~100-180) |
| templateTable_x86.cpp | `cpu/x86/` | 4525 | `invokedynamic()` (line ~4525+), `invokehandle()` |
| interpreterRuntime.cpp/hpp | `share/interpreter/` | — | `resolve_invoke()` (line ~100), `resolve_invokedynamic()` |
| linkResolver.cpp | `share/interpreter/` | 1934 | `resolve_invoke()` series (line 100-600), `resolve_invokedynamic()` (line ~1900) |
| methodHandles.cpp/hpp | `prims/` | — | `jump_from_method_handle()`, `MethodHandles::generate_adapters()` |
| rewriter.cpp | `share/interpreter/` | 630 | `_invokehandle` 字节码重写 (由 `invokevirtual MethodHandle.invokeExact` 而来) |
| **调用链接** | | | |
| abstractInterpreter.cpp/hpp | `share/interpreter/` | — | `entry_for_method()` (line ~350-447), `method_kind()` |
| templateInterpreterGenerator_x86.cpp | `cpu/x86/` | 1884 | i2c/c2i adapter, `generate_return_entry_for()` |
| interpreterRuntime.cpp | `share/interpreter/` | 1650 | `frequency_counter_overflow()` (line ~600-800) — OSR 触发 |
| sharedRuntime.cpp | `share/runtime/` | — | `SharedRuntime::generate_i2c2i_adapters()` — i2c adapter 生成 |
| **OopMapCache** | | | |
| oopMapCache.cpp | `share/interpreter/` | 604 | `compute_one_oop_map()` (line 100-500), `lookup_mask()` (line 50-100) |
| oopMapCache.hpp | `share/interpreter/` | 179 | `InterpreterOopMap` 结构 |
| frame.cpp/hpp | `share/runtime/` | — | `frame::oops_interpreted_do()` — 遍历解释器栈帧的 oop |

---

## §四 与已分析资产关系

```
已有分析: 01-jvm-startup/docs/14-Interpreter-Bytecodes-TemplateTable.md (1538 行)
         ↓ 覆盖
         解释器初始化 7 调用的全链路 (init_globals 上下文)
         Bytecodes::initialize: def() → 6 个静态数组
         TemplateInterpreter::initialize: StubQueue + generate_all → 256 codelet
         TemplateTable::initialize: 256 Template 描述符 (flags + TosState + generator)
         InvocationCounter: 2 状态状态机 + 3 阈值计算
         VMRegImpl: 569 条目寄存器名映射

本卷扩展:
  ┌── 第 1 章: 在已有 init 分析基础上, 加入 InterpreterMacroAssembler 汇编器、
  │            CodeletMark RAII 机制、分派循环 dispatch_next 的汇编实现
  │
  ├── 第 2 章: 在已有 Bytecodes def() 基础上, 加入 Rewriter 字节码重写机制、
  │            BytecodeStream 遍历引擎、BytecodeTracer 追踪器
  │            将 compute_flags() 格式字符串扩展到所有类型字符的完整解析
  │
  ├── 第 3 章: Template::def → generate() → x86 汇编 的完整链路 (新内容)
  │            CodeletMark RAII、generate_all() 的 8 个子步、
  │            dispatch_next/dispatch_via 的分派机制
  │
  ├── 第 4 章: 14 类字节码 × 1-3 代表性案例 → 完整 x86 机器码生成 (核心扩展)
  │            已有分析只提到"generate_all 生成 256 codelet"
  │            本卷深入每个 codelet 内部: C++ 模板逻辑 → InterpreterMacroAssembler → x86 指令序列
  │
  └── 第 5 章: GC 屏障 + JSR 292 + OopMapCache + i2c/c2i adapter (全新内容)
               已有分析完全不涉及这些
```

---

## §五 分析边界 (Scope Limits)

### 本卷不覆盖

| 不覆盖的内容 | 理由 |
|------------|------|
| **C1/C2 JIT 编译器源码** | 属于第 5 卷 "编译器" |
| **GC 子系统内部实现** | 属于第 6 卷 "垃圾回收"，本卷只覆盖解释器中的 GC 屏障调用点 |
| **类加载器完整实现** | 属于第 2 卷 "类加载与验证" |
| **JVM TI 完整接口** | 属于第 8 卷 "诊断与监控"，本卷只覆盖 breakpoint 字节码和 JVM TI 在解释器中的入口 |
| **精确的 x86 汇编机器码字节** | 只展示助记符级伪代码，不做二进制级编码 |
| **ARM64/AArch64 平台解释器** | 只覆盖 x86_64，（`templateTable_aarch64.cpp` 等不在本卷范围） |
| **Zero 解释器 (C++ 解释器)** | 仅在第 1 章概览中对比提及 |
| **模板解释器初始化时序的完整分析** | 已在 Vol.1 第 3 章 §3.2 和第 14 文档中完成 |

### 本卷与 Vol.1 第 3 章 §3.2 的关系

Vol.1 Ch.3 §3.2 在 **init_globals 上下文** 中分析了解释器初始化的调用顺序和依赖 DAG。
本卷在 Vol.1 基础上：
- **不重复** 初始化时序和依赖关系
- **展开** 每个初始化调用的内部实现（`generate_all()` 内部、`TemplateTable::initialize()` 内部）
- **扩展** 到运行时行为（codelet 分派、机器码生成、GC 屏障、JSR 292）

---

## §六 写作约定

### 字节码展示格式

```
iload [局部变量索引]
├── Bytecodes::def: format="bi", result_type=T_INT, depth=1
├── TemplateTable::def: flags=ubcp|clvm, tos_in=vtos, tos_out=itos
├── 生成器: TemplateTable::iload()
│   ├── locals_index(rdx)           // 从 bcp 读取局部变量索引
│   └── movl(rax, iaddress(rdx))    // 从局部变量区加载
└── x86 结果: movzbl 1(%r13), %edx; movl (%r14, %rdx, 8), %eax
```

### 汇编展示格式

使用 AT&T 语法（与 HotSpot 内联汇编一致）：
```asm
movzbl 0x0(%r13), %ebx        // 读 bcp 的字节码
jmp *(%r10, %rbx, 8)          // 跳转到 codelet
```

### 引用格式

- 源码引用：`bytecodes.cpp:157-175`（文件:起始行号-结束行号）
- 关键函数参数按实际调用传参展示

---

## §尾 预期行数与容量

| 章 | 预估行数 | 说明 |
|----|---------|------|
| 第 1 章 | 2000-3000 | 7 调用初始化 + 分派机制 + InterpreterMacroAssembler |
| 第 2 章 | 1500-2500 | Bytecodes 6 数组 + Rewriter + BytecodeStream |
| 第 3 章 | 1500-2500 | Template→机器码生成链路 |
| 第 4 章 | 3000-5000 | **特色章节** — 14 类字节码 × 1-3 案例 × 每案例 150-300 行 |
| 第 5 章 | 2500-4000 | GC 屏障 × 4 种 GC + JSR 292 + OopMapCache + i2c adapter |
| **总计** | **10500-16500** | |

---

**规划完成时间**: 2026-06-20
**下一阶段**: 在新会话中基于本 README 规划撰写 5 篇精细 prompt（每章 1 prompt）
