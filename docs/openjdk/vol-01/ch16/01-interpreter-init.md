# 16 解释器模板系统上架——interpreter_init 与 templateTable_init

> **本文定位**：`init_globals()` 第 11、14 步——解释器的全部汇编代码生成。`TemplateInterpreterGenerator::generate_all()` 一个函数生成了解释器的整套代码：方法入口、返回、调用分派、异常处理、安全点、去优化，以及将 202 条字节码模板逐个生成可执行的汇编 Codelet。这是 `universe_init`（宇宙创造完毕）之后 **JVM 真正开始生成机器指令**的时刻。
>
> **前置依赖**：ch15（JIT 阈值设立）、ch14（三表就绪）、ch11（G1 BarrierSet）、ch10（universe_init 序列总览）

---

## 0. 全景——本章讲的是两个 init 函数

`interpreter_init`（第 11 步，interpreter.cpp:115）是整个解释器的入口——它调 `Interpreter::initialize()`，最终进入 `TemplateInterpreter::initialize()`。`templateTable_init`（第 14 步，templateTable.cpp:547）是一个**无操作**的冗余调用——它内部做的 `TemplateTable::initialize()` 在 `TemplateInterpreter::initialize()` 的步骤②中**已被调用过**，参数完全一致，第二次调用被 `_is_initialized` 标志直接返回。

因此本章实质只讲一个东西——`TemplateInterpreter::initialize()`（templateInterpreter.cpp:42）：

```
interpreter_init()                   ← init_globals 第 11 步
  ├─ Interpreter::initialize()
  │    └─ TemplateInterpreter::initialize()   ← 本章全部内容
  │         ├─ §1 五步初始化流程
  │         ├─ §2 generate_all()——生成全部桩代码
  │         │    ├─ 方法入口
  │         │    ├─ 返回桩
  │         │    ├─ 异常桩
  │         │    └─ 安全点与去优化
  │         ├─ §3 TemplateTable::initialize()——注册 202 条字节码模板
  │         └─ §4 DispatchTable 三表切换
  ├─ Forte::register_stub          ← Profiling 工具注册解释器代码区为"桩"
  └─ JvmtiExport::post_dynamic_code_generated ← JVMTI 代理收到通知（动态代码生成）
```

### 0.1 generate_all() 按生成类型分为 9 组

| 组 | 生成的桩 | 用途 |
|----|---------|------|
| ① 慢速签名处理 | `_slow_signature_handler` | 方法参数列表的通用适配器 |
| ② 返回入口 | `_return_entry[1..5]` × 10 种 TosState | 方法返回到调用者 |
| ③ invoke 返回入口 | 3 种 invoke × 10 种 TosState | invokedynamic / invokevirtual / invokeinterface 的返回 |
| ④ native 结果处理器 | `_native_abi_to_tosca[10]` | JNI 返回值的类型转换 |
| ⑤ 安全点入口 | `_safept_entry` × 10 种 TosState | Safepoint 时保存并恢复解释器状态 |
| ⑥ 异常处理器 | 通用 athrow + 6 种快速抛出 | NPE / AIOOBE / ASE / AE / CCE / SOE |
| ⑦ 方法入口 | 28 种 method kind（`_entry_table[kind]`） | 所有方法类型的第一条指令 |
| ⑧ **字节码模板表** | 202 条字节码 × 生成器 → dispatch 表 | 每条字节码一个 Codelet，构成解释器的取指-执行循环 |
| ⑨ 去优化入口 | `_deopt_entry[1..5]` × 10 种 TosState | C2 去优化时切换回解释器 |

---

`interpreter_init`（interpreter.cpp:115）除了调 `Interpreter::initialize()` 之外，还有两行兼容性代码：`Forte::register_stub` 是 Oracle Solaris Studio profiler 的遗留接口，Linux/JDK 11 上无实际效果，可忽略；`JvmtiExport::post_dynamic_code_generated` 向 JVMTI 代理发出动态代码生成通知。线程 profiling 和调试工具依赖这两行来追踪解释器生成的代码。本章聚焦 `Interpreter::initialize()` 的主流程。

## 1. TemplateInterpreter::initialize()——五步初始化

```cpp
// templateInterpreter.cpp:42
void TemplateInterpreter::initialize() {
  if (_code != NULL) return;

  AbstractInterpreter::initialize();                          // ① 基类初始化

  TemplateTable::initialize();                                // ② 注册 202 条字节码模板

  { ResourceMark rm;
    _code = new StubQueue(new InterpreterCodeletInterface,   // ③ 创建 CodeBuffer
                          InterpreterCodeSize, NULL, "Interpreter");

    TemplateInterpreterGenerator g(_code);                    // ④ 生成全部汇编代码
    _code->deallocate_unused_tail();                          //    回收未用尾部空间
  }

  _active_table = _normal_table;                              // ⑤ 激活 dispatch 表
}
```

五个步骤从"空壳"走到"可执行解释器"：

| 步 | 做什么 | 产出 |
|---|--------|------|
| ① | `AbstractInterpreter::initialize()` | 基类初始化——字节码计数器重置 + `InvocationCounter::reinitialize`（ch15 §2.4 已讲） |
| ② | `TemplateTable::initialize()` | 注册 202 个字节码模板——为每个字节码绑定生成器函数和操作数栈转型规则（§3） |
| ③ | `new StubQueue(...)` | 创建 CodeBuffer，分配 `InterpreterCodeSize` 字节的代码空间——所有 Codelet 的汇编代码存于此 |
| ④ | `TemplateInterpreterGenerator g(_code)` | 构造触发 `generate_all()`——遍历模板 + 生成全部桩代码（§2） |
| ⑤ | `_active_table = _normal_table` | 激活 dispatch 表——`_active_table` 指向 `_normal_table`，解释器取指时用（§4） |

`Interpreter::initialize()` 进入 `TemplateInterpreter::initialize()`（静态方法，templateInterpreter.cpp:42）——HotSpot 在编译时通过 `#include "templateInterpreter.hpp"` 确定了解释器的具体实现。

---

## 1.1 Template——字节码模板的载体

`Template` 类（templateTable.hpp:44）是一个微型结构，5 个字段：

```cpp
class Template {
  int      _flags;       // 四个标志位——ubcp / disp / clvm / iswd（位域编码）
  TosState _tos_in;      // 操作数栈期望输入类型（如 itos=栈顶是 int，vtos=不关心类型）
  TosState _tos_out;     // 操作数栈输出类型（模板执行后栈顶的类型变化）
  generator _gen;        // 汇编生成器函数指针——签名为 void (*)(int arg)
  int      _arg;         // 传给生成器的参数（如常量索引、比较条件）
};
```

`TemplateTable::_template_table[202]` 是一个静态数组——每个 JVM 字节码在该数组中对应一个 `Template` 对象。步骤②中 `TemplateTable::initialize()` 填充了每个槽位的五个字段（§3），步骤④中 `generate_all()` 遍历这些槽位，对每个 `Template` 调 `_gen` 生成对应的 Codelet。

---

## 1.2 CodeletMark——Codelet 的诞生与提交

每个 `Codelet` 的生成都由 `CodeletMark` 守卫（interpreter.cpp:84）：

```cpp
class CodeletMark {
  InterpreterCodelet* _clet;              // 从 StubQueue 分配的空间
  CodeBuffer          _cb;               // 代码缓冲区包装器
  InterpreterMacroAssembler** _masm;     // 汇编器——生成机器指令的入口

public:
  CodeletMark(InterpreterMacroAssembler*& masm, const char* description, Bytecodes::Code bytecode);
  ~CodeletMark();
};
```

这是一个 RAII 守卫——构造时从 `StubQueue` 请求代码空间、创建汇编器；析构时将生成的机器码提交到 `StubQueue`。

构造时（interpreter.cpp:84）：
1. `AbstractInterpreter::code()->request(codelet_size())`——从 CodeBuffer 中切出 `codelet_size()` 字节空间（默认：可用空间 - 2K，interpreter.hpp:98-107）
2. `_clet->initialize(description, bytecode)`——标记 Codelet 的名字和字节码编号（调试打印用）
3. `new InterpreterMacroAssembler(&_cb)`——创建汇编器，传入 Codelet 的代码缓冲区。汇编器是平台相关的——在 x86-64 上，`InterpreterMacroAssembler` 继承自 `MacroAssembler`，为解释器定制了 bcp 寄存器（r13）和 locals 寄存器（r14）

析构时（interpreter.cpp:99）：
1. 对齐 + flush——保证机器码按字边界对齐、全部写入 CodeBuffer
2. `AbstractInterpreter::code()->commit(committed_code_size, ...)`——将实际生成的机器码大小提交给 StubQueue，更新其内部指针
3. `*_masm = NULL`——防止 Codelet 外部继续持有汇编器引用

`codelet_size()` 实际分配的量不固定——它取 `StubQueue::available_space() - 2K`，保证 CodeBuffer 中有足够空间容纳当前 Codelet。debug 构建中所有分配乘以 4（`InterpreterCodeSize * 4`），为调试断言和边界检查留额外空间。

> `StubQueue` 是解释器专用的代码缓冲区，与 JIT 用的 `CodeCache`（ch09/03）是两个独立系统：`CodeCache` 存编译后的本地代码（动态创建、可被 sweeper 回收），`StubQueue` 只在 `init_globals` 期间分配一次，大小固定、永不清除。

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

`TemplateTable::initialize()`（templateTable.cpp:244）是 200+ 行的 `def` 调用序列。每个 `def` 调用往 `_template_table[code]` 的槽位置填入一个字节码的全部注册信息。步骤④中 `generate_all()` 遍历这些槽位生成 Codelet。

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

> **下一篇**：[ch17 SharedRuntime::generate_stubs](runtime_stubs.md)——运行时桩生成：方法调用解析、安全点处理、去优化桩。
