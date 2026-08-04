# 16 解释器模板系统上架——interpreter_init 与 templateTable_init

> **本文定位**：`init_globals()` 第 11、14 步——解释器的全部汇编代码生成。`TemplateInterpreterGenerator::generate_all()` 一个函数生成了解释器的整套代码：方法入口、返回、调用分派、异常处理、安全点、去优化，以及将 202 条字节码模板逐个生成可执行的汇编 Codelet。这是 `universe_init`（宇宙创造完毕）之后 **JVM 真正开始生成机器指令**的时刻。
>
> **前置依赖**：[ch13 JIT 阈值设立](openjdk/vol-01/ch13/01-init-globals-facade.md)、[ch12 三表就绪](openjdk/vol-01/ch12/02-string-table-create.md)、[ch10 G1 BarrierSet](openjdk/vol-01/ch10)、[ch09 universe_init](openjdk/vol-01/ch09)

---

## 0. 全景——本章讲的是两个 init 函数

`interpreter_init`（第 11 步，interpreter.cpp:115）是整个解释器的入口——它调 `Interpreter::initialize()`，最终进入 `TemplateInterpreter::initialize()`。`templateTable_init`（第 14 步，templateTable.cpp:547）是一个**无操作**的冗余调用——它内部做的 `TemplateTable::initialize()` 在 `TemplateInterpreter::initialize()` 的步骤(2)中**已被调用过**，参数完全一致，第二次调用被 `_is_initialized` 标志直接返回。

因此本章实质只讲一个东西——`TemplateInterpreter::initialize()`（templateInterpreter.cpp:42）：

```
interpreter_init()                   ← init_globals 第 11 步
  +- Interpreter::initialize()
  |    +- TemplateInterpreter::initialize()   ← 本章全部内容
  |         +- §1 五步初始化流程
  |         +- §2 generate_all()——生成全部桩代码
  |         |    +- 方法入口
  |         |    +- 返回桩
  |         |    +- 异常桩
  |         |    +- 安全点与去优化
  |         +- §3 TemplateTable::initialize()——注册 202 条字节码模板
  |         +- §4 DispatchTable 三表切换
  +- Forte::register_stub          ← Profiling 工具注册解释器代码区为"桩"
  +- JvmtiExport::post_dynamic_code_generated ← JVMTI 代理收到通知（动态代码生成）
```

### 0.1 generate_all() 按生成类型分为 9 组

| 组 | 生成的桩 | 用途 |
|----|---------|------|
| (1) 慢速签名处理 | `_slow_signature_handler` | 方法参数列表的通用适配器 |
| (2) 返回入口 | `_return_entry[1..5]` × 10 种 TosState | 方法返回到调用者 |
| (3) invoke 返回入口 | 3 种 invoke × 10 种 TosState | invokedynamic / invokevirtual / invokeinterface 的返回 |
| (4) native 结果处理器 | `_native_abi_to_tosca[10]` | JNI 返回值的类型转换 |
| (5) 安全点入口 | `_safept_entry` × 10 种 TosState | Safepoint 时保存并恢复解释器状态 |
| (6) 异常处理器 | 通用 athrow + 6 种快速抛出 | NPE / AIOOBE / ASE / AE / CCE / SOE |
| (7) 方法入口 | 28 种 method kind（`_entry_table[kind]`） | 所有方法类型的第一条指令 |
| (8) **字节码模板表** | 202 条字节码 × 生成器 → dispatch 表 | 每条字节码一个 Codelet，构成解释器的取指-执行循环 |
| (9) 去优化入口 | `_deopt_entry[1..5]` × 10 种 TosState | C2 去优化时切换回解释器 |

---

`interpreter_init`（interpreter.cpp:115）除了调 `Interpreter::initialize()` 之外，还有两行兼容性代码：`Forte::register_stub` 是 Oracle Solaris Studio profiler 的遗留接口，Linux/JDK 11 上无实际效果，可忽略；`JvmtiExport::post_dynamic_code_generated` 向 JVMTI 代理发出动态代码生成通知。线程 profiling 和调试工具依赖这两行来追踪解释器生成的代码。本章聚焦 `Interpreter::initialize()` 的主流程。

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

五个步骤从"空壳"走到"可执行解释器"：

| 步 | 做什么 | 产出 |
|---|--------|------|
| (1) | `AbstractInterpreter::initialize()` | 基类初始化——字节码计数器重置 + `InvocationCounter::reinitialize`（ch13 §2.4 已讲） |
| (2) | `TemplateTable::initialize()` | 注册 202 个字节码模板——为每个字节码绑定生成器函数和操作数栈转型规则（§3） |
| (3) | `new StubQueue(...)` | 创建 CodeBuffer，分配 `InterpreterCodeSize` 字节的代码空间——所有 Codelet 的汇编代码存于此 |
| (4) | `TemplateInterpreterGenerator g(_code)` | 构造触发 `generate_all()`——遍历模板 + 生成全部桩代码（§2） |
| (5) | `_active_table = _normal_table` | 激活 dispatch 表——`_active_table` 指向 `_normal_table`，解释器取指时用（§4） |

`Interpreter::initialize()` 进入 `TemplateInterpreter::initialize()`（静态方法，templateInterpreter.cpp:42）——HotSpot 在编译时通过 `#include "templateInterpreter.hpp"` 确定了解释器的具体实现。

---

## 1.1 Template——字节码的"生成配方"

`Template` 类（templateTable.hpp:44）不是代码——是**配方**：描述某个字节码对应的 Codelet 应该由谁来生成、带什么参数、执行前后操作数栈的类型如何变化。

```cpp
class Template {
  int      _flags;       // 标志位：ubcp / disp / clvm / iswd
  TosState _tos_in;      // 操作数栈期望输入类型（itos=栈顶是int，vtos=不关心）
  TosState _tos_out;     // 操作数栈输出类型（模板执行后栈顶变成什么）
  generator _gen;        // 生成器函数指针——签名为 void (*)(int arg)
  int      _arg;         // 生成器参数（常量值、比较条件等）
};
```

步骤(2)中调用了 `TemplateTable::initialize()`——它的内部是 200+ 行 `def` 函数调用。`def` 是 `TemplateTable::def()`，一个注册函数，每调用一次就往 `_template_table[202]` 数组的某个槽位填入一个 `Template` 对象——"每个字节码的配方"。以 `_iconst_2` 为例，`initialize()` 中有一行：

```cpp
def(Bytecodes::_iconst_2, ____|____|____|____, vtos, itos, iconst, 2);
```

这行 `def` 的 6 个入参和它们最终存入 `Template` 的对应关系（`_iconst_2` 是 `Bytecodes::Code` 枚举成员——202 个 JVM 字节码各对应一个枚举值，`def` 以此值作为 `_template_table` 的数组下标）：

| 入参 | 值 | 存入 Template 的什么 | 含义 |
|------|----|-------------------|------|
| 第 1 个 | `_iconst_2` | 数组索引（非字段） | 配方放在 `_template_table[_iconst_2]` 槽位 |
| 第 2 个 | `____\|____\|____\|____` | `_flags` = 0 | 四个标志位全不设：不需读 bcp（无操作数）、不调 VM、自行分派 |
| 第 3 个 | `vtos` | `_tos_in` | 执行前不关心栈顶类型 |
| 第 4 个 | `itos` | `_tos_out` | 执行后栈顶变成 int（压入了 2） |
| 第 5 个 | `iconst` | `_gen` | 生成器函数——调它产生对应汇编代码 |
| 第 6 个 | `2` | `_arg` | 生成器参数——"压入常量 2" |

`____` 是宏常量 0——四个位置对应四个标志位，每个标志控制该字节码对应的 Codelet 在**生成时和运行时**的一种特殊行为。四个位的含义和各字节码的取值情况在 §3.2 完整展开，这里先用 `_iconst_2` 逐一说明为什么全是 0：

| 标志位 | 含义 | 为何 `_iconst_2` 为 0 |
|--------|------|----------------------|
| `ubcp`（uses_bcp） | 该字节码需要**读取 bcp 后面的操作数**——bcp 是解释器的"程序计数器"，指向当前字节码。`_bipush` 设 `ubcp`，因为要读 bcp 后面的 1 个字节作为压入的数值 | `_iconst_2` 压入的常量 2 是编译期已知的——不需要读操作数 |
| `disp`（does_dispatch） | 该 Codelet 执行完后**自行跳转到下一条字节码**（不设则靠 dispatch 表兜底）。绝大多数设此位——解释器不希望每个 Codelet 末尾多一条 dispatch 查表指令 | `_iconst_2` 功能极简（压栈后返回），但也设了此位（实际源码中此位为 false——见注） |
| `clvm`（calls_vm） | 该 Codelet 内部可能通过 `call_VM` 宏**进入 C++ 运行时**——需要处理 JNI、safepoint、OopMap 等。`_invokevirtual`、`_new`、`_ldc` 等涉及类加载/方法解析的字节码设此位 | `_iconst_2` 纯数学压栈，不需要 VM 帮助 |
| `iswd`（wide_bit） | 该模板是字节码的 **wide 版本**——wide 前缀把局部变量索引从 1 字节扩展为 2 字节（如 `_iload_w` 用 2 字节索引） | `_iconst_2` 没有 wide 形式 |

四个标志位全为 0 时的表示：`____|____|____|____`。当某一位被设时，该位的位置用对应的标志常量替代。`_invokevirtual` 需要三个标志，所以其 `def` 调用的第二参数为 `ubcp|disp|clvm|____`——前三个设了，第四位保持 `____`。（§3.2 完整展开 202 个字节码的标志位组合。）

这行 `def` 调用完成后，`_template_table[_iconst_2]` 数组槽位被填入一个 `Template` 对象。`def` 内部将收到的 6 个入参按顺序填充：第 1 个（`_iconst_2`）是数组下标——决定填入哪个槽位，不存入 Template；第 2-6 个依次填入 Template 的五个字段——`_flags`（=0）、`_tos_in`、`_tos_out`、`_gen`、`_arg`。五个字段**全部填充**，`_flags` = 0 不等于"没填"——它是"四个标志位全关"的具体值。

关于 `_gen` 的值 `iconst`：它是 `TemplateTable` 类的一个**静态成员函数**的地址——C++ 中函数名可以直接转成函数的内存地址，`Template._gen` 存的就是这个地址。`generate_all()`（§2）在后面会逐个取出每个 Template 的 `_gen`，按地址调用生成器产生该字节码的机器码。完整的 202 个字节码的 `def` 注册过程见 §3。

`TemplateTable::_template_table[202]` 是一个静态数组——每个 JVM 字节码在该数组中对应一个 `Template` 对象。Template 是"字节码 → 汇编生成器"的映射表条目。（§3 将展示全部 202 个字节码的 def 如何被注册。）

---

## 1.2 CodeletMark——Codelet 的诞生与提交

**Codelet 是什么**。`InterpreterCodelet` 是解释器生成的一小段汇编代码——每个 JVM 字节码对应一个 Codelet。它在 `StubQueue` 中占一段连续空间，头部存元数据（`_size` 代码长度、`_description` 描述字符串、`_bytecode` 字节码编号），体部是生成器产出的机器指令。解释器执行字节码的过程就是：取当前字节码 → 查 dispatch 表找到对应的 Codelet 地址 → 跳转执行 → 该 Codelet 的最后一条指令跳到下一条字节码的 Codelet——**从一个 Codelet 跳到另一个 Codelet，直到方法返回**。

每个 `Codelet` 的生成都由 `CodeletMark` 守卫（interpreter.cpp:84）。它解决一个问题：`generate_all()` 里有几十个独立的 `generate_*()` 调用——每个都需要自己的代码缓冲区、汇编器、以及"生成完了把机器码提交到 StubQueue"的步骤。如果没有 `CodeletMark`，这几十个函数都得手动重复这三步。

```cpp
class CodeletMark {
  InterpreterCodelet* _clet;              // 从 StubQueue 切出的空间片段
  CodeBuffer          _cb;               // 把 _clet 包装为 CodeBuffer 供汇编器写入
  InterpreterMacroAssembler** _masm;     // 二级指针——构造时将汇编器地址写回给调用者

public:
  CodeletMark(InterpreterMacroAssembler*& masm, const char* description, Bytecodes::Code bytecode);
  ~CodeletMark();
};
```

三个字段的协作：

- **`_clet`**（`InterpreterCodelet*`）：从 `StubQueue` 用 `request(codelet_size())` 切出的一块空间。构造后它不是普通的 `malloc` 内存——`StubQueue` 内部有链表/队列管理它的位置
- **`_cb`**（`CodeBuffer`）：将 `_clet` 包装为标准 `CodeBuffer` 接口——汇编器（`InterpreterMacroAssembler`）只认识 `CodeBuffer`，不直接认识 `InterpreterCodelet`
- **`_masm`**（`InterpreterMacroAssembler**`）：一个**二级指针**——构造时 `new InterpreterMacroAssembler(&_cb)`，将汇编器地址写入 `*_masm`。调用者在 `CodeletMark` 作用域内通过这个 `masm` 引用调用 `_masm->push()、_masm->mov()、...` 生成机器码

二级指针是关键技巧——`generate_all()` 中的用法展示了这个模式：

```cpp
void TemplateInterpreterGenerator::generate_all() {
  InterpreterMacroAssembler* _masm = NULL;  // 初始为空

  { CodeletMark cm(_masm, "slow signature handler");
    AbstractInterpreter::_slow_signature_handler = generate_slow_signature_handler();
  }  // cm 析构 → 生成的代码被提交，_masm 被置为 NULL
```

`CodeletMark` 构造时将 `new InterpreterMacroAssembler(&_cb)` 的地址写入 `_masm`——之后 `generate_slow_signature_handler()` 内部通过 `_masm` 生成机器码。析构时对齐、flush、commit、将 `_masm` 置为 NULL——防止作用域外的代码意外持有悬空汇编器指针。

构造时（interpreter.cpp:84）三步：
1. `AbstractInterpreter::code()->request(codelet_size())`——从 CodeBuffer 切出空间（默认：可用空间 - 2K，interpreter.hpp:98-107）
2. `_clet->initialize(description, bytecode)`——标记 Codelet 的名字和字节码编号（调试打印用）
3. `new InterpreterMacroAssembler(&_cb)`——创建汇编器，传入 Codelet 的代码缓冲区

析构时（interpreter.cpp:99）三步：
1. 对齐 + flush——保证机器码按字边界对齐、全部写入 CodeBuffer
2. `AbstractInterpreter::code()->commit(committed_code_size, ...)`——将实际生成的机器码大小提交给 StubQueue，更新其内部指针
3. `*_masm = NULL`——防止 Codelet 外部继续持有汇编器引用

`codelet_size()` 实际分配的量不固定——它取 `StubQueue::available_space() - 2K`，保证 CodeBuffer 中有足够空间容纳当前 Codelet。debug 构建中所有分配乘以 4（`InterpreterCodeSize * 4`），为调试断言和边界检查留额外空间。

> `StubQueue` 通过 `BufferBlob::create()` 从 CodeCache（CodeHeap）分配内存——与 JIT 编译产物共享同一个可执行代码池（`BufferBlob` 结构见 ch09/03）。`StubQueue` 在 `init_globals` 期间一次性分配，其后永不清除。

---

## 2. generate_all()——生成全部汇编代码

`generate_all()`（templateInterpreterGenerator.cpp:57）按代码类型分节生成。每一组代码通过 `CodeletMark` 生成一段或一组 Codelet。

### 2.1 方法入口点——`_entry_table`

`method_entry(kind)` 宏（第 186 行）为每种方法类型生成一个入口 Codelet：

```cpp
#define method_entry(kind)                                              \
  { CodeletMark cm(_masm, "method entry point (kind = " #kind ")"); \
    Interpreter::_entry_table[Interpreter::kind] = generate_method_entry(Interpreter::kind); \
    Interpreter::update_cds_entry_table(Interpreter::kind); \
  }
```

28 种 method kind 分为四组：

```
非原生方法:
  zerolocals                    ← 普通方法（零局部变量槽优化）
  zerolocals_synchronized       ← synchronized 方法
  empty                         ← 空方法体——立即返回
  accessor                      ← 字段访问器——读字段后返回
  abstract                      ← 抽象方法——抛 AbstractMethodError

Math intrinsic:                 ← 直接 CPU 指令实现（因性能关键，跳过 JIT）
  sin, cos, tan, abs, sqrt, log, log10, exp, pow, fmaF, fmaD
  共计 11 种

原生方法:                       ← 必须是连续块（_native_entry_begin / _native_entry_end）
  native                        ← JNI 原生方法
  native_synchronized           ← synchronized JNI 方法

其他 intrinsic:
  Reference.get                 ← Reference 处理
  CRC32_update, CRC32_updateBytes, CRC32_updateByteBuffer,
  CRC32C_updateBytes, CRC32C_updateDirectByteBuffer  ← 5 种 CRC32/CRC32C
  Float.intBitsToFloat, Float.floatToRawIntBits      ← 2 种 Float
  Double.longBitsToDouble, Double.doubleToRawLongBits ← 2 种 Double
  共计 10 种
```

`update_cds_entry_table` 在 CDS 启用时更新归档入口表（默认不开启，no-op）。

### 2.2 返回与调用入口

`generate_all()` 生成三类返回 Codelet：

- **普通返回 `_return_entry[i]`**（1..5 个返回地址，10 种 TosState）：每个返回地址对应 `tableswitch` / `lookupswitch` 的跳转位置。返回时恢复调用者的 bcp、locals、操作数栈
- **invoke 返回 `_invoke_return_entry` / `_invokeinterface_return_entry` / `_invokedynamic_return_entry`**：三种 invoke 指令的长度不同（3 / 5 / 5 字节），返回时需要把 bcp 指针拨到调用指令之后的下一条字节码
- **早期返回 `_earlyret_entry`**：JVMTI 的 `ForceEarlyReturn`——不等方法正常结束，从栈帧中取出指定值并返回

### 2.3 异常处理

```cpp
// generate_all() 中的异常桩生成
generate_throw_exception();                                    // 通用 athrow
_throw_NullPointerException_entry = generate_exception_handler(...);
_throw_ArrayIndexOutOfBoundsException_entry = ...;             // +5 种
_throw_StackOverflowError_entry = generate_StackOverflowError_handler();
```

通用 `athrow` 生成器执行完整路径：查异常表 → 逐帧展开 → 跳转到 handler。6 种快速抛出走的是预生成的特殊桩——不查异常表，直接跳到对应 handler。两者都通过 `_safept_entry` 兼容安全点。

### 2.4 安全点与去优化

- **安全点入口 `_safept_entry`**：10 种 TosState 各一个。Safepoint 时 `_active_table` 切换到 `_safept_table`（§4）——解释器下次取指时进入安全点守护桩。守护桩保存 bcp、等待 GC 完成、然后跳回原字节码的正常 Codelet
- **去优化入口 `_deopt_entry[i]`**：C2 去优化时恢复解释器状态——在栈帧中重建 bcp / locals / 操作数栈，然后按正常的 dispatch 流程继续执行

`safepoint_entry_for()` 的第二个参数是 `InterpreterRuntime::at_safepoint`——安全点进入 JVM 的 C++ 运行时，等待 GC 线程完成标记/清理。

---

## 3. TemplateTable::initialize()——202 条字节码模板的注册

`TemplateTable::initialize()`（templateTable.cpp:244）是 200+ 行的 `def` 调用序列。每个 `def` 调用往 `_template_table[code]` 的槽位置填入一个字节码的全部注册信息。步骤(4)中 `generate_all()` 遍历这些槽位生成 Codelet。

### 3.1 def 的五种重载

`def` 有五个重载（templateTable.cpp:180-222），对应生成器函数的不同签名：

```cpp
// 重载 1：无额外参数（如 _nop、栈操作 dup/swap）
void def(Code code, int flags, TosState in, TosState out, void (*gen)());

// 重载 2：int 参数（如 _iconst 的常量值 -1..5、_getfield 的 f1_byte/f2_byte 标记）
void def(Code code, int flags, TosState in, TosState out, void (*gen)(int arg), int arg);

// 重载 3：Condition 参数（如 _if_icmpeq 的比较条件 equal/not_equal）
void def(Code code, int flags, TosState in, TosState out, void (*gen)(Condition cc), Condition cc);

// 重载 4：Operation 参数（如 _iadd 的 add 操作——加/减/乘/除等算术符）
void def(Code code, int flags, TosState in, TosState out, void (*gen)(Operation op), Operation op);

// 重载 5：bool 参数（如 _ldc 的 wide=true 标记区分 ldc_w 和 ldc）
void def(Code code, int flags, TosState in, TosState out, void (*gen)(bool arg), bool arg);
```

每个 `def` 的五个字段含义：

| 字段 | 含义 | 示例（`_iconst_2`） |
|------|------|---------|
| `code` | JVM 字节码操作码 | `Bytecodes::_iconst_2` |
| `flags` | `ubcp \| disp \| clvm \| iswd` 的按位或 | 0（不需要 bcp、不调 VM、自行分派） |
| `in` | 操作数栈期望输入类型 | `vtos`（不关心栈顶类型） |
| `out` | 操作数栈输出类型 | `itos`（推入一个 int） |
| `gen` | 汇编生成器函数指针 | `iconst`（`TemplateTable::iconst()` 的地址） |
| `arg` | 传递给生成器的参数 | 2（常量值 2） |

### 3.2 两个模板表

```cpp
static Template _template_table     [202];  // 普通字节码
static Template _template_table_wide[202];  // wide 字节码（如 _iload_w）
```

设置 `iswd` 标志的 `def` 调用填充 `_template_table_wide`——wide 版本用 2 字节局部变量索引而非 1 字节。

### 3.3 set_entry_points_for_all_bytes()

`generate_all()` 的最后一步（第 233 行）——遍历 `_template_table[202]`，对每个有效的 `Template` 生成 Codelet 并写入 dispatch 表：

```cpp
// templateInterpreterGenerator.cpp:276
void TemplateInterpreterGenerator::set_entry_points_for_all_bytes() {
  for (int i = 0; i < DispatchTable::length; i++) {
    Bytecodes::Code code = (Bytecodes::Code)i;
    if (Bytecodes::is_defined(code)) {
      set_entry_points(code);           // 调 Template::generate + _normal_table.set_entry
    } else {
      set_unimplemented(i);             // 未定义的字节码——挂未实现错误桩
    }
  }
}
```

每个字节码获得一个 entry——`_normal_table` 的对应槽位指向该 Codelet 的入口地址。`_active_table` 在工作时指向 `_normal_table`，解释器执行 `_active_table[bytecode]` 跳转。

---

## 4. DispatchTable——三种分派表

```cpp
// templateInterpreter.hpp:131-134
static DispatchTable _active_table;       // 当前活动的表（指向 _normal_table 或 _safept_table）
static DispatchTable _normal_table;       // 正常执行——完整的字节码入口表
static DispatchTable _safept_table;       // 安全点模式——每字节码入口跳转到安全点守护桩
static address       _wentry_point[DispatchTable::length]; // wide 指令的独立入口
```

`DispatchTable` 是一个大小为 202 的地址数组——每个槽位存一个 Codelet 入口地址。

**运行时切换**：

```
正常执行:
  解释器取指: bytecode = *bcp
  跳转: jmp _active_table[bytecode]   ← 此时 _active_table == _normal_table
  执行: 该字节码的 Codelet → 下一条字节码

Safepoint 发生:
  全局切换: _active_table = _safept_table
  解释器取指: ... → _active_table[bytecode] → 安全点守护桩
  守护桩: 保存 bcp → InterpreterRuntime::at_safepoint() → 等待 GC
  GC 完成: 恢复 bcp → 跳回 _normal_table[bytecode] → 继续执行
```

`_safept_table` 的每个条目由 `set_safepoints_for_all_bytes()` 填充——它调 `safepoint_entry_for(state, handler)`，生成的守护桩在保存当前状态后进入 `InterpreterRuntime::at_safepoint` 等待 GC。正常执行时 `_active_table == _normal_table`，只在安全点间隙切换到 `_safept_table`。

`_wentry_point` 是 wide 指令的专用入口表——与普通指令不同，wide 指令的局部变量索引是 2 字节，需要独立的栈帧布局逻辑。

---

## 5. 小结——解释器生成的全景与执行循环

`init_globals` 第 11 步完成后，JVM 拥有了完整的解释器。整个生成过程只有一个函数——`generate_all()`，它按代码类型分组产生：

```
方法入口     → 28 种 method kind（_entry_table）
返回桩       → 10 种 TosState × (普通 + 3 种 invoke)
字节码模板   → 202 条 × 生成 Codelet → dispatch 表
异常桩       → 通用 athrow + 6 种快速 throw
安全点守护   → 10 种 TosState × safepoint
去优化入口   → 5 种返回地址 × 10 种 TosState
```

解释器执行字节码的循环极简：

```
取指: bytecode = *bcp
查表: entry = _active_table[bytecode]
跳转: jmp entry
执行: Codelet 的汇编代码（操作数栈、局部变量、调用/返回）
分派: jmp 下一条字节码的 entry
```

202 种字节码的 Codelet 组成了"取指-跳转"循环的全部内容。这是 JVM 在启动后执行任何 Java 代码之前的最后一步——从此 `init_globals` 不再生成新的代码，控制权移交给 Java 程序的执行。

> **下一篇**：[ch17 SharedRuntime::generate_stubs](runtime_stubs.md)<!-- 404: target not found, 请作者补正文 -->——运行时桩生成：方法调用解析、安全点处理、去优化桩。
