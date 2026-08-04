# 16 解释器模板系统上架——interpreter_init 与 templateTable_init

> **本文定位**：`init_globals()` 第 11、14 步——解释器的全部汇编代码生成。这不是一两个函数调用，而是 `TemplateInterpreterGenerator::generate_all()` 所完成的一整套 Codelet 生成：方法入口、返回、调用分派、异常处理、安全点、去优化，以及将 202 条字节码模板逐个生成为可执行的汇编代码。这是 `universe_init` 之后 **JVM 真正的"代码生成"阶段**。
>
> **前置依赖**：ch13（JIT 阈值设立）、ch12（三表就绪）、ch10（G1 BarrierSet）、ch09（universe_init 序列总览）

---

## 0. 全景——解释器生成的全部内容

```
init_globals()（runtime/init.cpp:101）:
  10: gc_barrier_stubs_init()     ← ch13
  11: interpreter_init()           ← 本章 §1——TemplateInterpreter::initialize()
  12: invocationCounter_init()     ← ch13
  13: accessFlags_init()           ← ch13
  14: templateTable_init()         ← 本章 §2——已在步骤(2)中调用，此为冗余
```

`interpreter_init` 的核心是 `TemplateInterpreterGenerator::generate_all()`——**一个函数生成了解释器的全部汇编代码**。按生成的代码类型分类：

| 阶段 | generate_all() 中生成的桩 | 用途 |
|------|--------------------------|------|
| ① | 慢速签名处理 | 方法参数列表的通用适配 |
| (2) | 返回入口点（10 种 TosState） | 方法返回到调用者 |
| (3) | invoke 返回入口点（3 种 × 10 种 TosState） | invokevirtual / invokeinterface / invokedynamic 的返回处理 |
| (4) | 早期返回入口点 | JVMTI PopFrame / ForceEarlyReturn |
| (5) | 原生调用结果处理器 | JNI 返回值的类型转换 |
| (6) | 安全点入口点（10 种 TosState） | Safepoint 时保存解释器状态 |
| (7) | 异常处理器（6 种异常类型） | NullPointer / ArrayIndex / ClassCast 等 |
| (8) | 方法入口点（20+ 种 method kind） | zerolocals / synchronized / native / Math intrinsic 等 |
| (9) | **字节码模板表**（202 条） | 每条 JVM 字节码生成一段 Codelet |
| (10) | 去优化入口点 | C2 去优化时切换回解释器执行 |

---

## 1. TemplateInterpreter::initialize()——五步初始化

```cpp
// templateInterpreter.cpp:42
void TemplateInterpreter::initialize() {
  if (_code != NULL) return;

  AbstractInterpreter::initialize();                          // (1) 基类初始化

  TemplateTable::initialize();                                // (2) 注册 202 条字节码模板

  { ResourceMark rm;
    _code = new StubQueue(new InterpreterCodeletInterface,   // (3) 创建 CodeBuffer
                          InterpreterCodeSize, NULL, "Interpreter");

    TemplateInterpreterGenerator g(_code);                    // (4) 生成全部汇编代码
    _code->deallocate_unused_tail();                          //    回收未用尾部空间
  }

  _active_table = _normal_table;                              // (5) 激活 dispatch 表
}
```

### 1.1 Template——字节码模板的载体

`Template` 类（templateTable.hpp:44）是 5 个字段的微型结构：

```cpp
class Template {
  int      _flags;       // 四个标志位（ubcp / disp / clvm / iswd——位域编码）
  TosState _tos_in;      // 操作数栈期望输入类型（如 itos=栈顶是 int）
  TosState _tos_out;     // 操作数栈输出类型（模板执行后的栈顶类型）
  generator _gen;         // 汇编生成器——函数指针，签名为 void (*generator)(int arg)
  int      _arg;          // 传给生成器的参数（如常量索引、比较条件）
};
```

`TemplateTable::_template_table[202]` 是一个静态数组——每个 JVM 字节码在该数组中对应一个 `Template` 对象。`def` 调用就是往 `_template_table[code]` 的槽位置填入五个字段的值。

### 1.2 CodeletMark——Codelet 的创建与生命周期

`CodeletMark`（interpreter.cpp:84）是一次 RAII 守卫：构造时从 `StubQueue` 请求代码空间、创建 `InterpreterMacroAssembler`；析构时将生成的汇编代码提交到 `StubQueue`。每个 `CodeletMark` 生成一个 `InterpreterCodelet`——它在 `StubQueue` 中分配一段连续的 `_size` 字节空间，并在 `StubQueue` 内部链表中串起下一个 Codelet。

---

## 2. TemplateInterpreterGenerator::generate_all()——生成全部汇编代码

`templateInterpreterGenerator.cpp:57` 是一个 200+ 行的巨大函数——它调用的每个生成器（`generate_*`）都通过 `CodeletMark` 生成一段独立的汇编代码桩。

### 2.1 方法入口点（method kinds）

`method_entry(kind)` 宏（第 186-190 行）为每种 `method kind` 生成一个入口桩，填入 `Interpreter::_entry_table[kind]`：

```
zerolocals        ← 普通方法（零局部变量槽优化）
zerolocals_synchronized ← synchronized 方法
empty             ← 空方法体
accessor          ← 字段访问器方法
abstract          ← 抽象方法——抛 AbstractMethodError
native            ← JNI 原生方法
native_synchronized ← synchronized native 方法
8 个 Math intrinsic  ← 直接 CPU 指令实现（sin/cos/tan/log 等）
java_lang_ref_reference_get ← Reference.get() 特殊入口
3 个 CRC32 intrinsic
Float.intBitsToFloat 等静态 intrinsic
```

`Interpreter::update_cds_entry_table(kind)` 在 CDS 启用时更新归档入口表（ch12 已讲过共享表概念——默认不开启，此行为 no-op）。

### 2.2 返回与调用入口

- **返回入口 `_return_entry[i]`**（1..5 个返回地址的 10 种 TosState）：方法返回到调用者，恢复调用者栈帧
- **invoke 返回入口** `_invoke_return_entry` / `_invokeinterface_return_entry` / `_invokedynamic_return_entry`：三种 invoke 指令的返回处理——构造栈帧、更新 bcp 指针到调用指令之后的下一条字节码
- **早期返回入口** `_earlyret_entry`：JVMTI 的 `PopFrame` 和 `ForceEarlyReturn` 使用——不等方法正常返回，提前释放栈帧

### 2.3 异常处理

`generate_throw_exception()`——生成通用的 `athrow` 字节码处理：查询异常表、展开栈帧、跳转到 handler。`_throw_*_entry` 系列生成 6 种常见异常的快速抛出（NullPointerException、ArrayIndexOutOfBoundsException 等）——不经过通用 `athrow` 路径，直接走快速抛出。

### 2.4 安全点与去优化

- **安全点入口** `_safept_entry`（10 种 TosState）：Safepoint 时保存解释器当前字节码状态——GC 可由此扫描当前方法的所有活跃引用
- **去优化入口** `_deopt_entry[i..5]`：C2 去优化时保存编译后的状态，切换回解释器——在栈帧中重建解释器的 bcp/locals/操作数栈

`safepoint_entry_for()` 的第二个参数 `InterpreterRuntime::at_safepoint` 是 JVM 的 C++ 运行时入口——安全点到达后调此函数等待 GC 完成。

---

## 3. TemplateTable::initialize()——202 条字节码模板的注册

### 3.1 def 的五种重载

`TemplateTable::def` 有五个重载（templateTable.cpp:180-222），分别对应生成器函数的不同签名：

```cpp
// 重载 1：无额外参数（如 _nop、栈操作）
void def(Code code, int flags, TosState in, TosState out, void (*gen)());

// 重载 2：int 参数（如 _iconst 的常量值 -1..5、_getfield 的 f1_byte/f2_byte 标记）
void def(Code code, int flags, TosState in, TosState out, void (*gen)(int arg), int arg);

// 重载 3：Condition 参数（如 _if_icmpeq 的比较条件 equal/not_equal 等）
void def(Code code, int flags, TosState in, TosState out, void (*gen)(Condition cc), Condition cc);

// 重载 4：Operation 参数（如 _iadd 的 add 操作——算术运算符）
void def(Code code, int flags, TosState in, TosState out, void (*gen)(Operation op), Operation op);

// 重载 5：bool 参数（如 _ldc 的 wide=true 标记区分 ldc_w vs ldc）
void def(Code code, int flags, TosState in, TosState out, void (*gen)(bool arg), bool arg);
```

### 3.2 两个模板表——normal + wide

```cpp
static Template _template_table     [202];  // 普通字节码模板
static Template _template_table_wide[202];  // wide 字节码模板
```

wide 版本用于字节码的 `wide` 前缀扩展——如 `iload_w` 有 2 字节局部变量索引而非 1 字节。两个表在 `def` 调用中通过 `iswd` 标志位区分——设置了 `wide_bit` 的 `def` 调用填充 `_template_table_wide`。

### 3.3 set_entry_points_for_all_bytes()

`generate_all()` 最后一步——`set_entry_points_for_all_bytes()` 遍历 `_template_table[202]`，对每个有效的 `Template` 调 `template_for(code)->generate(masm)`。结果：每个字节码在 `_normal_table` 的对应槽位置获得一个 Codelet 入口地址——解释器取指时 `_active_table[bytecode]` 跳转。

---

## 4. DispatchTable——三种分派表

```cpp
// templateInterpreter.hpp:131-133
static DispatchTable _active_table;   // 当前使用的表（指向 _normal_table 或 _safept_table）
static DispatchTable _normal_table;   // 正常执行模式——完整的字节码入口表
static DispatchTable _safept_table;   // 安全点模式——每字节码跳转到安全点检查桩
```

三种表的关系：

```
运行时:
  正常执行: _active_table = _normal_table
           → _active_table[bytecode] = 字节码 Codelet 入口

  Safepoint: 全局设置 _active_table = _safept_table
             → _active_table[bytecode] = 安全点守护桩
             → 守护桩执行: 保存字节码状态 → 等待 GC → 恢复 → 跳回 _normal_table
```

`safepoint_entry_for(state, handler)` 生成的守护桩将当前字节码的 bcp 保存到栈帧、调用 `InterpreterRuntime::at_safepoint` 等待 GC，然后恢复分派到原字节码。

---

## 5. 小结——解释器生成的全景

`generate_all()` 按生成代码的类型分组：

```
解释器桩代码全景:
  方法入口    → 20+ 种 method kind 的入口桩（_entry_table）
  返回桩      → 10 种 TosState × (普通返回 + 3 种 invoke 返回)
  字节码模板  → 202 条 Template → set_entry_points_for_all_bytes() → dispatch 表
  异常桩      → 通用 athrow + 6 种快速 throw
  安全点守护  → 10 种 TosState × 安全点入口
  去优化入口  → 5 种返回地址的 deopt 入口
  JVMTI 桩    → 早期返回 + native 调用结果转换
```

三张 dispatch 表控制了执行流在安全点和正常模式之间的切换。

> **下一篇**：[ch17 SharedRuntime::generate_stubs](runtime_stubs.md)——运行时桩生成：方法调用解析、安全点处理、去优化桩。
