# 17.2 TemplateTable::initialize()——251 个模板的批量注册

> **本文定位**：逐段 walkthrough `TemplateTable::initialize()` 的 288 行代码，解读防重入机制、flag 常量、203 个标准字节码的模板注册、12 个 wide 模板注册、36 个 JVM 内部字节码模板注册，以及平台相关的 `pd_initialize()`。
>
> **前置依赖**：[17.1 Template 描述符](01-template-descriptor.md)——理解 Template 类的 5 字段结构和 `def()` 的 6 个重载。
>
> **JDK 版本**：本文基于 **OpenJDK 11u、x86-64、正常启用 Template Interpreter 的 HotSpot 构建**。

---

## 1. 防重入机制与 flag 常量

`TemplateTable::initialize()` 的开头：

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:244-258 === */

void TemplateTable::initialize() {
  if (_is_initialized) return;          // ← 幂等保证

  TraceTime timer("TemplateTable initialization", TRACETIME_LOG(Info, startuptime));

  _bs = BarrierSet::barrier_set();

  const char _    = ' ';
  const int  ____ = 0;
  const int  ubcp = 1 << Template::uses_bcp_bit;
  const int  disp = 1 << Template::does_dispatch_bit;
  const int  clvm = 1 << Template::calls_vm_bit;
  const int  iswd = 1 << Template::wide_bit;
```

三件事同时发生：

### 1.1 `_is_initialized` 防重入

`TemplateTable::initialize()` 被设计为**可被多次安全调用**。在 `init_globals()` 中它被调用两次：

1. 第一次：`TemplateInterpreter::initialize()` → `TemplateTable::initialize()`（真正注册 251 个模板）
2. 第二次：`templateTable_init()` → `TemplateTable::initialize()`（`_is_initialized = true`，直接返回）

第二次调用是一行 trivial 委托（`templateTable.cpp:547-549`）——它的存在是因为 `init_globals()` 的调用顺序要求 `templateTable_init()` 出现在 `interpreter_init()` 之后，但实际注册工作早已完成。

### 1.2 `_` / `____`——提高可读性的常量

```cpp
const char _    = ' ';
const int  ____ = 0;
```

`_` 是空格字符 `' '`——在 `def()` 调用中用作无参 generator 的 filler char。`____` 是 `0`——在 flag 位域中表示"无 flag"。这两个常量纯粹为可读性服务——`____|____|____|____` 比 `0|0|0|0` 更直观地传达"四个 flag 位全为 0"。

在 [17.1 Section 4](01-template-descriptor.md) 中提到，`def()` 的核心版本（重载 2）内部**再次**定义了这四个 flag 常量。这里的定义供 `initialize()` 函数作用域使用，与 `def()` 内的定义值相同——都是 `1 << Template::*_bit`。

### 1.3 `_bs`——缓存 BarrierSet

```cpp
_bs = BarrierSet::barrier_set();
```

`_bs` 是 `TemplateTable` 的静态成员（`templateTable.hpp:96`），缓存当前的 GC 屏障集。在 x86 generator 代码中，`_bs` 用于判断是否需要生成写屏障指令——例如 `aastore` 模板需要根据 GC 类型决定 `__ store_check()` 的行为。

---

## 2. 标准 Java 字节码注册（203 个）

标准字节码的注册从 `_nop`（字节码 0）到 `_jsr_w`（字节码 201），加上 `_breakpoint`（字节码 202）在 wide 代码段中单独注册，总计 **203 个**。

源码将 203 个 `def()` 调用按语义分组排列，我们逐组解读。

### 2.1 常量压栈（_nop → _ldc2_w）

```cpp
def(Bytecodes::_nop     , ____|____|____|____, vtos, vtos, nop    ,  _   );  // 无操作
def(Bytecodes::_ldc     , ubcp|____|clvm|____, vtos, vtos, ldc    , false);  // 从常量池加载
def(Bytecodes::_ldc_w   , ubcp|____|clvm|____, vtos, vtos, ldc    , true );  // 宽索引版本
```

flag 规律：
- `iconst_*` / `lconst_*` / `fconst_*` / `dconst_*`——纯栈操作，**无 flag**，因为不需要 bcp、不自行 dispatch、不调 VM、不 wide。
- `bipush` / `sipush`——`ubcp`：需要读取 bcp 后面的 1 或 2 字节立即数。
- `ldc` / `ldc_w` / `ldc2_w`——`ubcp | clvm`：需要 bcp 读取常量池索引，且需要调用 `InterpreterRuntime::ldc()`。

一个有意思的细节：`ldc` 和 `ldc_w` 共用同一个 generator `ldc`，用 `_arg`（`false` / `true`）区分是否使用 wide 索引。这与我们在 17.1 中看到的 `_arg` 参数多态一致——generator 内部 `if (wide)` 分支。

### 2.2 局部变量加载（_iload → _saload）

标准版的 `iload/lload/fload/dload/aload` 全部带 `ubcp`——因为 short 版本的加载需要用 1 字节 bcp 索引获取局部变量编号。

带下标的版本（`_iload_0` ~ `_aload_3`）没有 flag——索引号硬编码在 `_arg` 中（0/1/2/3），不需要读 bcp。

数组加载（`_iaload` ~ `_saload`）全部无 flag——数组引用和下标来自操作数栈，不需要 bcp。

一个值得注意的 flag 差异：`_aload` 和 `_aload_0` 带有 `clvm` flag（调用 VM），而 `_iload` 也带 `clvm`。原因：`aload` 和 `iload` 的 generator `aload()` / `iload()` 会检查 `RewriteFrequentPairs` 并可能重写字节码——重写需要修改字节码流，涉及 VM 调用。

### 2.3 局部变量存储（_istore → _sastore）

存储类字节码的 TosState 规律：
- `_tos_in` 对应存储值的类型（`istore = itos`, `lstore = ltos` 等等）。唯一例外是 `_astore`——`_tos_in = vtos`，因为 astore 的 generator 通过寄存器参数传入待存储的引用，不经过 TOS 寄存器。
- `_tos_out = vtos`——存储操作不产生值

与加载类对称：short 版本带 `ubcp`，下标版无 flag，数组存储无 flag。`_astore` 和 `_aastore` 额外带 `clvm`——对象引用存储可能触发 GC 写屏障，需要 VM 运行时支持。

**重要纠正**：标准字节码段注册的 `_iload` 是 **short 版本**（1 字节索引）。wide 版本（2 字节索引）在 Section 3 单独注册到 `_template_table_wide`。

### 2.4 操作数栈（_pop → _swap）

9 个栈操作字节码全部无 flag——纯栈操作，不涉及 bcp、不需要 dispatch、不调用 VM。`_tos_in = vtos`（不确定栈顶当前缓存的状态），`_tos_out = vtos`（调整后的栈顶同样不确定）。

### 2.5 算术运算（_iadd → _dneg）

关键规律——共用 generator + 参数多态：
- `_iadd / _isub / _imul / _ishl / _ishr / _iushr / _iand / _ior / _ixor` → 共 9 个字节码共用 `iop2(Operation)`，`_arg` 分别是 `add/sub/mul/shl/shr/ushr/_and/_or/_xor`。
- `_idiv` 和 `_irem` 用了独立的 `idiv` / `irem` generator——因为它们需要零除检查和硬件异常处理。

`_lmul` 也没有用 `lop2` 而是用了独立 `lmul`——`lop2` 只覆盖 `add/sub/_and/_or/_xor`，不覆盖乘法。

浮点运算 `_fadd/fsub/fmul/fdiv/frem` 共用 `fop2(Operation)`，`_fneg` 独立。

**`_tos_in` 与 `_tos_out` 决定 dispatch 入口**：算术运算的 `_tos_in` 总是与 `_tos_out` 相同（例如 `_iadd` 的 `itos, itos`）——运算结果与输入同类型，TOS 寄存器状态不变。但 `_lshl` / `_lshr` / `_lushr` 例外：`_tos_in = itos`（移位量是 int），`_tos_out = ltos`（结果是 long）。

### 2.6 位运算与移位（_iand → _lxor）

int 版本的位运算被 `iop2` 覆盖（见上节）。long 版本的 `_land / _lor / _lxor` 共用 `lop2(Operation)`。

#### 自增：_iinc

```cpp
def(Bytecodes::_iinc, ubcp|____|clvm|____, vtos, vtos, iinc, _);
```

`_iinc` 带 `ubcp`（读取局部变量索引和增量）、`clvm`（可能触发字节码重写）。特别之处：`_tos_in = vtos, _tos_out = vtos`——自增不经过操作数栈，直接修改局部变量。

### 2.7 类型转换（_i2l → _i2s）

15 个转换字节码全部调用同一个 `convert()` generator，`_tos_in` 和 `_tos_out` 各不相同——`convert()` 内部根据源类型和目标类型生成对应的 x86 转换指令（`cvtsi2sd`、`cvttsd2si` 等）。

### 2.8 比较（_lcmp → _dcmpg）

- `_lcmp`：独立 generator `lcmp`。
- `_fcmpl` / `_fcmpg`：共用 `float_cmp`，`_arg = -1` / `_arg = 1` 区分 NaN 处理。
- `_dcmpl` / `_dcmpg`：共用 `double_cmp`，同上。

比较操作的 `_tos_in` 是待比较的类型，`_tos_out = itos`——比较结果总是 int（-1/0/1）。

### 2.9 条件跳转（_ifeq → _ifnonnull）

**模式 1——零值比较**：`ifeq/ifne/iflt/ifge/ifgt/ifle` 共用 `if_0cmp(Condition)`——`_tos_in = itos`，condition 通过 `_arg` 传入。

**模式 2——整型比较**：`if_icmpeq/ne/lt/ge/gt/le` 共用 `if_icmp(Condition)`——`_tos_in = itos`。

**模式 3——引用比较**：`if_acmpeq/ne` 共用 `if_acmp(Condition)`——`_tos_in = atos`。

**模式 4——null 比较**：`ifnull/ifnonnull` 共用 `if_nullcmp(Condition)`——`_tos_in = atos`。

所有条件跳转都带 `ubcp | clvm`——bcp 读取跳转偏移，`clvm` 是因为 profiling 代码可能需要调用运行时。`_tos_out = vtos`——跳转本身不产生值。

### 2.10 无条件跳转与子程序（_goto → _jsr_w）

```cpp
def(Bytecodes::_goto , ubcp|disp|clvm|____, vtos, vtos, _goto , _  );
def(Bytecodes::_jsr  , ubcp|disp|____|____, vtos, vtos, jsr   , _  );
def(Bytecodes::_ret  , ubcp|disp|____|____, vtos, vtos, ret   , _  );
def(Bytecodes::_goto_w, ubcp|____|clvm|____, vtos, vtos, goto_w, _);
def(Bytecodes::_jsr_w , ubcp|____|____|____, vtos, vtos, jsr_w , _  );
```

`_goto` / `_jsr` / `_ret` 都带 `disp`——它们自行控制转移，不需要默认的 dispatch epilog 跳到下一条字节码。

`_goto_w` 和 `_jsr_w` 不带 `disp`——它们虽然是跳转，但它们的模板可能走 profiling 路径后再执行跳转，profiling 阶段依赖默认 dispatch。

### 2.11 表跳转（_tableswitch / _lookupswitch）

```cpp
def(Bytecodes::_tableswitch , ubcp|disp|____|____, itos, vtos, tableswitch , _);
def(Bytecodes::_lookupswitch, ubcp|disp|____|____, itos, itos, lookupswitch, _);
```

`_tableswitch` 和 `_lookupswitch` 带 `ubcp | disp`——bcp 用于读取跳转表数据，disp 因为跳转目标由表决定。`_tos_in = itos`——key 在操作数栈上。

注意 `_tableswitch` 的 `_tos_out = vtos`（pop key 后栈顶为空），而 `_lookupswitch` 的 `_tos_out = itos`（保留 key 用于非匹配值的 fallthrough）。

### 2.12 返回（_ireturn → _return）

6 个返回字节码共用 `_return(TosState)` generator，`_arg` = 返回值的 TosState。`_tos_in` 等于 `_tos_out`——返回值类型一致。全部带 `disp | clvm`——return 自行离开当前方法，profiling 需要 VM 调用。

### 2.13 字段访问（_getstatic → _putfield）

```cpp
def(Bytecodes::_getstatic , ubcp|____|clvm|____, vtos, vtos, getstatic , f1_byte);
def(Bytecodes::_putstatic , ubcp|____|clvm|____, vtos, vtos, putstatic , f2_byte);
def(Bytecodes::_getfield  , ubcp|____|clvm|____, vtos, vtos, getfield  , f1_byte);
def(Bytecodes::_putfield  , ubcp|____|clvm|____, vtos, vtos, putfield  , f2_byte);
```

字段访问的 `_arg` 使用 `f1_byte`（=1）或 `f2_byte`（=2）——对应常量池缓存（ConstantPoolCache）中的 `f1` 和 `f2` 偏移。`getstatic/getfield` 用 `f1`（缓存字段地址），`putstatic/putfield` 用 `f2`（校验 + 写入）。全部带 `ubcp | clvm`——bcp 读取字段引用索引，clvm 用于解析和 GC 屏障。

### 2.14 方法调用（_invokevirtual → _invokedynamic）

```cpp
def(Bytecodes::_invokevirtual   , ubcp|disp|clvm|____, vtos, vtos, invokevirtual   , f2_byte);
def(Bytecodes::_invokespecial   , ubcp|disp|clvm|____, vtos, vtos, invokespecial   , f1_byte);
def(Bytecodes::_invokestatic    , ubcp|disp|clvm|____, vtos, vtos, invokestatic    , f1_byte);
def(Bytecodes::_invokeinterface , ubcp|disp|clvm|____, vtos, vtos, invokeinterface , f1_byte);
def(Bytecodes::_invokedynamic   , ubcp|disp|clvm|____, vtos, vtos, invokedynamic   , f1_byte);
```

所有调用字节码带 `ubcp | disp | clvm`（三个 flag 全部启用）：
- `ubcp`——读取方法引用索引
- `disp`——调用后自行离开当前字节码路径
- `clvm`——需要 `InterpreterRuntime::resolve_invoke()` 解析方法

`_invokevirtual` 的 `_arg = f2_byte`（从 CP cache 的 f2 读取 vtable index），其余四种用 `f1_byte`（从 f1 读取 Method* / Klass*）。

### 2.15 对象操作（_new → _multianewarray）

```cpp
def(Bytecodes::_new      , ubcp|____|clvm|____, vtos, atos, _new      , _);
def(Bytecodes::_newarray , ubcp|____|clvm|____, itos, atos, newarray  , _);
def(Bytecodes::_athrow   , ____|disp|____|____, atos, vtos, athrow    , _);
```

对象操作统一带 `clvm`——创建对象需要 `InterpreterRuntime::_new()`、分配数组需要 `InterpreterRuntime::multianewarray()`，athrow 需要运行时异常处理。

`_athrow` 额外带 `disp`——抛出异常后不再返回到正常的字节码 dispatch。

---

## 3. Wide 字节码注册（12 个）

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:464-477 === */

// wide Java spec bytecodes
def(Bytecodes::_iload , ubcp|____|____|iswd, vtos, itos, wide_iload , _);
def(Bytecodes::_lload , ubcp|____|____|iswd, vtos, ltos, wide_lload , _);
def(Bytecodes::_fload , ubcp|____|____|iswd, vtos, ftos, wide_fload , _);
def(Bytecodes::_dload , ubcp|____|____|iswd, vtos, dtos, wide_dload , _);
def(Bytecodes::_aload , ubcp|____|____|iswd, vtos, atos, wide_aload , _);
def(Bytecodes::_istore, ubcp|____|____|iswd, vtos, vtos, wide_istore, _);
def(Bytecodes::_lstore, ubcp|____|____|iswd, vtos, vtos, wide_lstore, _);
def(Bytecodes::_fstore, ubcp|____|____|iswd, vtos, vtos, wide_fstore, _);
def(Bytecodes::_dstore, ubcp|____|____|iswd, vtos, vtos, wide_dstore, _);
def(Bytecodes::_astore, ubcp|____|____|iswd, vtos, vtos, wide_astore, _);
def(Bytecodes::_iinc  , ubcp|____|____|iswd, vtos, vtos, wide_iinc  , _);
def(Bytecodes::_ret   , ubcp|disp|____|iswd, vtos, vtos, wide_ret   , _);
def(Bytecodes::_breakpoint, ubcp|disp|clvm|____, vtos, vtos, _breakpoint, _);
```

12 个 wide 模板统一带 `iswd`，注册到 `_template_table_wide[]`。

值得注意的两点：

1. **`_tos_in = vtos`**：所有 wide 指令的入口 TosState 都是 `vtos`。注释解释："wide instructions have a vtos entry point only"——wide 指令执行频率极低，不值得为 5 种 TosState 各建 dispatch 表。

2. **`_ret` 同时有 standard 和 wide 版本**：`_ret` 在第 430 行注册到 `_template_table`（无 `iswd`），在第 476 行注册到 `_template_table_wide`（有 `iswd`）。这两个模板使用不同的 generator（`ret` vs `wide_ret`），记录在不同的数组中。

3. **`_breakpoint` 是一个特例**：它在代码中位于 "wide Java spec bytecodes" 注释段内，但**没有 `iswd` flag**——所以它注册到 `_template_table`（标准数组），不是 `_template_table_wide`。这是 203 个标准字节码中的第 203 个。

---

## 4. JVM 内部字节码注册（36 个）

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:479-526 === */

// JVM bytecodes
```

JVM 内部字节码从 `_fast_agetfield`（值 = `number_of_java_codes` = 203）开始。这些字节码不是 Java 虚拟机规范定义的——它们是 HotSpot 为提高解释执行性能而内部的字节码，通常在字节码重写（bytecode rewriting）或 profiling 过程中替换原始字节码。

### 4.1 __fast_ accessfield / storefield（17 个）——快速字段访问

8 个 getfield 变体 + 9 个 putfield 变体：

- `_fast_agetfield` / `_fast_bgetfield` / `_fast_cgetfield` / `_fast_dgetfield` / `_fast_fgetfield` / `_fast_igetfield` / `_fast_lgetfield` / `_fast_sgetfield`——8 个 getter，每个对应一种字段类型。注意**没有 `_fast_zgetfield`**——boolean 类型用 `btos` 或 `itos` 处理。
- `_fast_aputfield` ~ `_fast_sputfield`——9 个 putter，包含 `_fast_zputfield`（boolean）。

全带 `ubcp`——读取字段索引。`_arg` 区分 get/put 和字段类型——`fast_accessfield(atos)` 生成 object 字段的 get 代码，`fast_storefield(itos)` 生成 int 字段的 put 代码。

### 4.2 快速局部变量访问（7 个）

- `_fast_aload_0`：等同于 `aload_0` 但走快速路径。
- `_fast_iaccess_0` / `_fast_aaccess_0` / `_fast_faccess_0`：快速 accessor（getter）方法专用——在 accessor rewriting 后使用。
- `_fast_iload` / `_fast_iload2` / `_fast_icaload`：`iload` 的 rewritten 版本——`iload + iload → fast_iload2`（合并两次加载），`iload → fast_iload`（跳过 rewriting 检查）。

### 4.3 其他内部字节码（12 个）

- `_fast_invokevfinal`：`invokevirtual` 的 final 方法快速路径。带 `ubcp | disp | clvm`。
- `_fast_linearswitch` / `_fast_binaryswitch`：`tableswitch` / `lookupswitch` 的 rewritten 版本。`_fast_linearswitch` 的 `_tos_out = vtos` 与 `tableswitch` 一致；`_fast_binaryswitch` 的 `_tos_out = vtos` 与标准版 `lookupswitch`（`itos`）不同——fast 版本统一 pop key。
- `_fast_aldc` / `_fast_aldc_w`：`ldc` / `ldc_w` 的快速路径。`_arg` = `false` / `true` 区分宽度。
- `_return_register_finalizer`：`return` 的特殊版本——返回前注册 finalizer。带 `disp | clvm`。
- `_invokehandle`：`invokedynamic` 的 MethodHandle 路径。带 `ubcp | disp | clvm`。
- `_nofast_getfield` / `_nofast_putfield`：禁用快速字段访问时的 fallback 路径。
- `_nofast_aload_0` / `_nofast_iload`：禁用快速局部变量加载时的 fallback。
- `_shouldnotreachhere`：调试用字节码——触发 `__ stop("shouldnotreachhere bytecode")`。

---

## 5. pd_initialize()——平台特定的初始化

```cpp
/* === src/hotspot/cpu/x86/templateTable_x86.cpp:50-52 === */

void TemplateTable::pd_initialize() {
  // No x86 specific initialization
}
```

`pd_initialize()` 在标准注册结束后调用（第 528 行），为架构提供注册额外平台相关模板的 hook。x86 不需要额外初始化。

最后一步：

```cpp
_is_initialized = true;  // line 530
```

至此，251 个模板全部注册完毕。后续 `set_entry_points_for_all_bytes()` 遍历 `_template_table` 数组，对 `is_defined(code)` 且 `is_valid()` 的模板调用 `generate_and_dispatch()`，将 C++ 描述符转化为 x86 机器码。

---

## 6. 小节

`TemplateTable::initialize()` 的结构可以概括为 7 个步骤：

```
1. 防重入检查          → _is_initialized? return
2. flag 常量定义       → _ / ____ / ubcp / disp / clvm / iswd
3. 标准字节码注册      → 203 个 def()，按语义分组（常量/加载/存储/栈/算术/移位/位/自增/转换/
                         比较/条件跳转/无条件跳转/表跳转/返回/字段/调用/对象）
4. Wide 字节码注册     → 12 个 def()，全部 iswd，注册到 _template_table_wide
5. JVM 内部字节码注册  → 36 个 def()，含快速字段/局部变量/调用/re-written 字节码
6. pd_initialize()     → x86 空函数，其他架构的扩展点
7. 标志完成            → _is_initialized = true
```

关键统计：

| 类别 | 数量 | 写入目标 | flag 规律 |
|------|------|----------|-----------|
| 标准 Java 字节码 | 203 | `_template_table[]` | 无 add/sub/shift 等日常运算无 flag；控制流带 `disp`；需要运行时支持的带 `clvm`；读立即数/索引的带 `ubcp` |
| Wide 字节码 | 12 | `_template_table_wide[]` | 全部 `iswd`，`_tos_in` 固定为 `vtos` |
| JVM 内部字节码 | 36 | `_template_table[]` | 与对应的标准字节码 flag 类似 |

下一篇（[17.3](03-generator-structure.md)）展示这些描述符如何驱动 x86 generator 生成实际的机器码——从 nop 的极简模式到 invokevirtual 的多步骤复杂模式，最终回到 `generate_and_dispatch()` 的完整闭环。
