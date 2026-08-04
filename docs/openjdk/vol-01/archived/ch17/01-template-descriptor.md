# 17.1 Template 描述符——极简的数据结构

> **本文定位**：介绍 `Template` 类的 5 字段设计、`bytecode()` 的指针减法、`_template_table` / `_template_table_wide` 静态数组结构、`def()` 的 6 个重载注册机制，以及 `_desc` 和 `transition()` 的作用。为 17.2 的完整注册流程和 17.3 的代码生成闭环建立概念基础。
>
> **前置依赖**：[16.1 interpreter_init](../ch14/01-interpreter-initialization.md)——理解 Template Interpreter 的初始化链和 `StubQueue`/`InterpreterCodelet` 存储结构。
>
> **JDK 版本**：本文基于 **OpenJDK 11u、x86-64、正常启用 Template Interpreter 的 HotSpot 构建**。

---

## 1. Template 类：五个字段，没有冗余

在 [16.2 从 Template 描述符到 Codelet](../ch14/02-codelet-generation.md) 中，我们看到一个字节码的模板描述符经过 `CodeletMark → Template::generate()` 变成了可执行的机器码片段。这一节回到描述的起点：**Template 本身存了什么**。

```cpp
/* === src/hotspot/share/interpreter/templateTable.hpp:44-75 === */

class Template {
 private:
  enum Flags {
    uses_bcp_bit,                                // bit 0: template needs bcp pointing to bytecode
    does_dispatch_bit,                           // bit 1: template dispatches on its own
    calls_vm_bit,                                // bit 2: template calls the vm
    wide_bit                                     // bit 3: template belongs to a wide instruction
  };

  typedef void (*generator)(int arg);

  int       _flags;                              // describes interpreter template properties
  TosState  _tos_in;                             // tos cache state before template execution
  TosState  _tos_out;                            // tos cache state after  template execution
  generator _gen;                                // template code generator
  int       _arg;                                // argument for template code generator

  void      initialize(int flags, TosState tos_in, TosState tos_out, generator gen, int arg);

  friend class TemplateTable;

 public:
  Bytecodes::Code bytecode() const;
  bool      is_valid() const                     { return _gen != NULL; }
  bool      uses_bcp() const                     { return (_flags & (1 << uses_bcp_bit     )) != 0; }
  bool      does_dispatch() const                { return (_flags & (1 << does_dispatch_bit)) != 0; }
  bool      calls_vm() const                     { return (_flags & (1 << calls_vm_bit     )) != 0; }
  bool      is_wide() const                      { return (_flags & (1 << wide_bit         )) != 0; }
  TosState  tos_in() const                       { return _tos_in; }
  TosState  tos_out() const                      { return _tos_out; }
  void      generate(InterpreterMacroAssembler* masm);
};
```

Template 类总共只有 **5 个数据字段**——这是刻意为之的极简设计。逐一来看：

### 1.1 `_flags`（4-bit 行为标记）

`_flags` 是 `int` 类型，实际使用只用了低 4 位。四种 flag 编码了这个字节码模板的**行为特征**，而不是存储字节码的标识：

| bit | 名称 | 含义 | 示例 |
|-----|------|------|------|
| 0 | `uses_bcp` | 生成代码时需要 bytecode pointer | `bipush` 需要读取立即数操作数 |
| 1 | `does_dispatch` | 模板自己负责控制转移 | `goto` 直接跳转，不依赖 dispatch table |
| 2 | `calls_vm` | 模板会调用 VM 运行时 | `new` 需要 `InterpreterRuntime::_new()` |
| 3 | `wide` | 模板属于 wide 指令 | `wide_iload` 注册到 `_template_table_wide` |

这四个 bit 精确描述了 HotSpot 代码生成器（`generate_and_dispatch`）需要知道的核心行为。例如 `does_dispatch()` 为 true 的模板，`generate_and_dispatch()` 就**不会在模板末尾补上自动 dispatch**——模板自己决定下一步去哪里。

反直觉的设计：**Template 不存储 bytecode ID**。`_flags` 只编码行为类别，不是 `if (code == _nop) ...` 这种 match。bytecode ID 的获取走另一条完全不同的路径——指针减法。

### 1.2 `_tos_in` / `_tos_out`（TosState 缓存状态）

`TosState` 是定义在 `src/hotspot/share/utilities/globalDefinitions.hpp:819` 的 12 值枚举：

```cpp
enum TosState {
  btos = 0,        // byte
  ztos = 1,        // boolean
  ctos = 2,        // char
  stos = 3,        // short
  itos = 4,        // int
  ltos = 5,        // long
  ftos = 6,        // float
  dtos = 7,        // double
  atos = 8,        // object reference
  vtos = 9,        // void（栈顶无缓存值）
  number_of_states,
  ilgl             // illegal
};
```

`TosState` 描述的是**解释器 dispatch 边界处的栈顶缓存状态**——不是在 Java 栈帧上维护的值类型，而是在 TOS（Top of Stack）寄存器中缓存的值的类别。

- `vtos`（void tos）：栈顶没有缓存值。绝大多数字节码的入口状态是 `vtos`——`_tos_in = vtos` 表示执行这条字节码时不需要先从 TOS 寄存器弹出输入值。
- `itos` / `ltos` / `ftos` / `dtos` / `atos`：栈顶缓存了一个对应类型的值。例如 `iadd` 的 `_tos_in = itos`，`_tos_out = itos`——表示执行前 TOS 寄存器缓存了 int，执行后仍然缓存 int（运算结果）。
- `btos` / `ztos` / `ctos` / `stos`：byte/boolean/char/short。HotSpot 内部实际上用 `itos` 统一处理——生成代码时 `set_short_entry_points()` 会断言 `btos/ctos/stos` 应该走 `itos`（`ShouldNotReachHere()`）。

`_tos_in` 和 `_tos_out` 共同决定了 dispatch table 中**使用哪个入口**（`set_short_entry_points` 根据 `_tos_in` 在 Codelet 内生成不同的 pop + dispatch 入口），以及 dispatch 出站时**栈顶寄存器是什么状态**（dispatch epilog 依赖于 `_tos_out` 推进 BCP 和索引 dispatch table）。

### 1.3 `_gen`（函数指针）与 `_arg`（参数）

```cpp
typedef void (*generator)(int arg);

generator _gen;   // 指向生成器函数
int       _arg;   // 传给生成器的参数
```

`_gen` 是一个函数指针，指向 x86 平台上的实际代码生成函数（定义在 `src/hotspot/cpu/x86/templateTable_x86.cpp`）。例如：

- `_gen = &TemplateTable::nop`，`_arg = 0`
- `_gen = &TemplateTable::iop2`，`_arg = add`

同一个 generator 可以被多个字节码共用，用不同的 `_arg` 区分行为。`iop2(add)`、`iop2(sub)`、`iop2(mul)` 等等——generator 内部用 `switch (op)` 分发到不同指令片段。`_arg` 参数的多态转换由 `def()` 的重载透明处理（见第 4 节）。

### 1.4 `initialize()`——五字段赋值

初始化是最简单的操作：

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:42-48 === */

void Template::initialize(int flags, TosState tos_in, TosState tos_out, generator gen, int arg) {
  _flags   = flags;
  _tos_in  = tos_in;
  _tos_out = tos_out;
  _gen     = gen;
  _arg     = arg;
}
```

五字段一对一赋值，没有额外的校验逻辑。`is_valid()` 只判空 `_gen != NULL`——模板描述符的有效性就等价于"是否分配了 generator"。

---

## 2. bytecode()——不需要存储 bytecode ID 的理由

上一节提到 Template 的 `_flags` 不存 bytecode ID。那如果代码需要知道"这个模板对应哪个字节码"怎么办？

答案在 `Template::bytecode()`：

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:51-55 === */

Bytecodes::Code Template::bytecode() const {
  int i = this - TemplateTable::_template_table;
  if (i < 0 || i >= Bytecodes::number_of_codes) i = this - TemplateTable::_template_table_wide;
  return Bytecodes::cast(i);
}
```

逻辑是：

1. **指针减法**：`this - TemplateTable::_template_table`——用当前 Template 对象的地址减去 `_template_table` 数组的首地址，得到当前模板在数组中的**下标**。
2. 如果下标在 `[0, number_of_codes)` 范围内，说明这个模板来自普通表（`_template_table`）。
3. 如果不在范围内（索引越界）或小于 0，`this` 就在 `_template_table_wide` 中——再次做指针减法得到 wide 表中的下标。
4. `Bytecodes::cast(i)` 将下标转为 `Bytecodes::Code` 枚举值。

因为 `Bytecodes::Code` 枚举的值与数组下标一致（`_nop = 0`, `_aconst_null = 1`, ...），所以下标 == bytecode ID。**Template 不做任何额外存储，bytecode ID 是算出来的。**

这也是为什么 Template 的构造函数和 `initialize()` 都不需要传 bytecode 参数：注册时 `def()` 会把模板填入数组的 `[code]` 位置，后续查询时用指针减法即可反推。

---

## 3. `_template_table` 与 `_template_table_wide`——两块模板数组

```cpp
/* === src/hotspot/share/interpreter/templateTable.hpp:89-91 === */

static Template        _template_table     [Bytecodes::number_of_codes];
static Template        _template_table_wide[Bytecodes::number_of_codes];
```

两块数组大小相同，都是 `Bytecodes::number_of_codes = 239`：

- `_template_table[i]`：存储字节码 `i` 的**普通（short）模板**。例如 `_template_table[_iadd]` 是 1 字节宽度的 `iadd` 模板。
- `_template_table_wide[i]`：存储字节码 `i` 的 **wide 版本**模板。例如 `_template_table_wide[_iload]` 是 wide 宽度的 `iload` 模板（用 2 字节索引局部变量）。

这 239 个槽位中，未注册的模板 `_gen == NULL` → `is_valid() == false`。例如 `_illegal = -1`（不在数组范围内）、部分未使用的内部字节码槽位。

`TemplateTable` 提供两个访问器：

```cpp
/* === src/hotspot/share/interpreter/templateTable.hpp:350-351 === */

static Template* template_for     (Bytecodes::Code code)  { Bytecodes::check     (code); return &_template_table     [code]; }
static Template* template_for_wide(Bytecodes::Code code)  { Bytecodes::wide_check(code); return &_template_table_wide[code]; }
```

`template_for()` 和 `template_for_wide()` 是 `def()` 的核心依赖——`def()` 通过 `iswd` flag 决定调用哪一个，然后用 `t->initialize()` 填充五字段。

---

## 4. def()——六个重载，一个核心

`def()` 是 Template 描述符注册的唯一入口。它的 6 个重载全部定义在 `templateTable.cpp` 中：

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:180-222 === */

// 重载 1：无参 generator（char filler 仅用于区分重载签名）
void TemplateTable::def(Bytecodes::Code code, int flags, TosState in, TosState out,
                        void (*gen)(), char filler) {
  assert(filler == ' ', "just checkin'");
  def(code, flags, in, out, (Template::generator)gen, 0);
}

// 重载 2：核心版本——所有其他重载最终都转发到这里
void TemplateTable::def(Bytecodes::Code code, int flags, TosState in, TosState out,
                        void (*gen)(int arg), int arg) {
  const int ubcp = 1 << Template::uses_bcp_bit;
  const int disp = 1 << Template::does_dispatch_bit;
  const int clvm = 1 << Template::calls_vm_bit;
  const int iswd = 1 << Template::wide_bit;

  bool is_wide = (flags & iswd) != 0;
  assert(in == vtos || !is_wide, "wide instructions have vtos entry point only");
  Template* t = is_wide ? template_for_wide(code) : template_for(code);
  t->initialize(flags, in, out, gen, arg);
  assert(t->bytecode() == code, "just checkin'");
}

// 重载 3：Operation 参数 → cast 为 int
void TemplateTable::def(..., void (*gen)(Operation op), Operation op) {
  def(code, flags, in, out, (Template::generator)gen, (int)op);
}

// 重载 4：bool 参数 → cast 为 int
void TemplateTable::def(..., void (*gen)(bool arg), bool arg) {
  def(code, flags, in, out, (Template::generator)gen, (int)arg);
}

// 重载 5：TosState 参数 → cast 为 int
void TemplateTable::def(..., void (*gen)(TosState tos), TosState tos) {
  def(code, flags, in, out, (Template::generator)gen, (int)tos);
}

// 重载 6：Condition 参数 → cast 为 int
void TemplateTable::def(..., void (*gen)(Condition cc), Condition cc) {
  def(code, flags, in, out, (Template::generator)gen, (int)cc);
}
```

6 个重载的设计思路：

1. **重载 1** 处理无参 generator（如 `nop`、`aconst_null`）。`char filler` 纯粹是 C++ 签名区分技巧——无参函数指针和 `int` 参数版在重载决议中容易歧义，加入一个永远不会被实际使用的 char 参数消除歧义。实际调用时传入 `' '` 或 `_`（值为 `' '`）。
2. **重载 2** 是核心版本，所有其他重载最终都 `cast` 参数后调用它。
3. **重载 3-6** 分别处理 `Operation`、`bool`、`TosState`、`Condition` 四种 generator 参数类型——全部 `(int)cast`，在 generator 内部用 `switch` 恢复语义。

核心版本（重载 2）的流程：

```
def(code, flags, in, out, gen, arg)
  ├─→ (flags & iswd) ? template_for_wide(code) : template_for(code)
  │      └─→ 选择 _template_table_wide[code] 或 _template_table[code]
  ├─→ t->initialize(flags, in, out, gen, arg)
  │      └─→ 五字段赋值
  └─→ assert(t->bytecode() == code)
         └─→ 指针减法验证一致性
```

核心版本内部重复定义了 `ubcp/disp/clvm/iswd` 四个 flag 常量——这些常量也会在 `TemplateTable::initialize()` 中定义一次。`def()` 里定义是为了让 `def()` 本身自包含（不需要依赖外部常量），但两者的值永远相同（`1 << bit_position`）。

---

## 5. `_desc` 与 `transition()`——生成时的全局状态

### 5.1 `_desc`——指向当前正在生成的模板

```cpp
/* === src/hotspot/share/interpreter/templateTable.hpp:93-94 === */

static Template*       _desc;    // the current template to be generated
static Bytecodes::Code bytecode() { return _desc->bytecode(); }
```

`_desc` 是一个指向 `Template` 的静态指针。它不拥有内存——指向的对象是 `_template_table[]` 或 `_template_table_wide[]` 数组中的某个元素。

`_desc` 的赋值时机在 `Template::generate()` 中：

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:58-65 === */

void Template::generate(InterpreterMacroAssembler* masm) {
  TemplateTable::_desc = this;    // ← 设置当前生成中的模板
  TemplateTable::_masm = masm;    // ← 同时设置汇编器
  _gen(_arg);                     // ← 调用 generator 发射机器码
  masm->flush();
}
```

注意：`_desc` **不会被显式置 NULL**。每次调用 `generate()` 时用新的 `this` 覆盖旧值。代码生成期间，`_desc` 始终保持有效（指向当前正在生成的模板），生成结束后仍指向最后一次调用的模板。

`_desc` 的主要消费者是 `transition()`（下节）和 `unimplemented_bc()`——它们需要知道"当前是哪个字节码在生成代码"来产生有效的错误信息。

### 5.2 `transition()`——仅在开发期生效的断言

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:162-165 === */

void TemplateTable::transition(TosState tos_in, TosState tos_out) {
  assert(_desc->tos_in()  == tos_in , "inconsistent tos_in  information");
  assert(_desc->tos_out() == tos_out, "inconsistent tos_out information");
}
```

`transition()` 是每个 x86 generator 函数的第一行调用（例如 `nop()` 的 `transition(vtos, vtos)`）。它的作用**仅**是在开发/调试模式下做一致性断言——检查 `def()` 注册时声明的 `tos_in` / `tos_out` 与 generator 函数中硬编码的 `tos_in` / `tos_out` 是否一致。

两个场景下这个断言会触发：

1. **`def()` 注册时写错了 TosState**：比如把 `_tos_in = itos` 写成了 `atos`，但 generator 里写的是 `transition(itos, ...)`，运行时会触发断言。
2. **generator 函数里 transition 参数写错了**：比如 def 注册了 `_tos_in = vtos`，但 generator 中写了 `transition(itos, vtos)`。

这两个断言**在 product build 中不生成任何代码**——它们定义了 `#ifndef PRODUCT` 或者是 `assert()`（在 `ASSERT` 宏开启时生效）。运行时性能不受影响。

`transition()` 通过 `_desc` 获取"当前模板"的注册 TosState，与 generator 中传入的值对比。这就是为什么 `_desc` 必须在 `generate()` 开始时就被设置为 `this`——如果 `_desc` 指向错误的模板，`transition()` 的断言就会失效。

---

## 6. 小节

Template 描述符的设计极简，但每个字段都服务于明确的目的：

1. **`_flags`（4 bits）**：编码模板的**行为特征**（是否需要 bcp / 是否自行 dispatch / 是否调用 VM / 是否 wide），不是字节码标识。代码生成器根据 flag 决定 dispatch 策略。
2. **`_tos_in` / `_tos_out`**：描述符 + dispatch table 入口的依据。`_tos_in` 决定生成哪些 pop 路径，`_tos_out` 决定 dispatch exit 时的寄存器状态和 table 偏移。
3. **`_gen` / `_arg`**：将 C++ 数据结构与 x86 机器码生成连接起来。同一个 generator 可以被多个字节码共用（`_arg` 区分），参数类型通过 `def()` 重载透明 cast。
4. **`bytecode()` 指针减法**：Template 用 `this - _template_table` 反推出 bytecode ID，不需要额外存储。这是 `Bytecodes::Code` 枚举值与数组下标一致性的直接产物。
5. **`_desc` + `transition()`**：开发期安全网。生产环境不产生任何开销。

下一篇（[17.2](02-templatetable-initialize.md)）进入 `TemplateTable::initialize()`——288 行代码如何调用 251 次 `def()`，为所有字节码批量注册这些描述符。
