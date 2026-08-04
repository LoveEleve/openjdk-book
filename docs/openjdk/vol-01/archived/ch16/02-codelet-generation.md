# 16.2 从 Template 描述符到 Codelet

> **本文定位**：接续 [16.1 interpreter_init](./01-interpreter-initialization.md)，沿 `TemplateInterpreterGenerator::generate_all()` 向下追踪：一个字节码的 Template 描述符，怎样在 VM 启动期变成 `InterpreterCodelet` 中的机器码和 dispatch entry。
>
> **前置依赖**：理解 `CodeCache → BufferBlob.content ← StubQueue` 的管理关系，以及 `TosState` 表示 dispatch 边界处缓存的栈顶值状态。
>
> **JDK 版本**：本文基于 **OpenJDK 11u、x86-64、正常启用 Template Interpreter 的 HotSpot 构建**。

---

## 1. 从 `TemplateInterpreterGenerator` 构造函数开始

上一篇停在这一句：

```cpp
TemplateInterpreterGenerator g(_code);
```

看起来只是创建局部对象，实际上构造函数会立即生成主 Template Interpreter 代码：

```cpp
/* === src/hotspot/share/interpreter/templateInterpreterGenerator.cpp:38-42 === */

TemplateInterpreterGenerator::TemplateInterpreterGenerator(StubQueue* _code)
  : AbstractInterpreterGenerator(_code) {
  _unimplemented_bytecode    = NULL;
  _illegal_bytecode_sequence = NULL;
  generate_all();
}
```

所以生成发生在 VM 启动期，而不是应用方法第一次执行某条字节码时：

```text
TemplateInterpreter::initialize()
  └─ TemplateInterpreterGenerator g(_code)
       └─ generate_all()
            ├─ 生成公共 support entries
            ├─ 生成 method entries
            ├─ 遍历 dispatch table 域
            │    ├─ defined opcode → 生成对应 handler
            │    └─ undefined slot → 安装共享 error entry
            ├─ 安装 safepoint entries
            └─ 生成 deoptimization entries
```

本文下钻的主线是：

```text
Template 描述符
  → set_entry_points(code)
  → CodeletMark
  → short / wide entry generation
  → Template::generate(masm)
  → 模板自行 dispatch 或 generator 补 dispatch
  → CodeletMark flush / commit
  → 安装 normal / wide entry
```

这里的“生成”是 **eager generation**：所有 defined opcode 都在解释器初始化期间被处理。运行时做的是根据字节码与 `TosState` 跳入已经生成的地址。

---

## 2. Template 是“代码生成描述符”

### 2.1 Template 保存什么

`Template` 本身不保存最终机器码，而是描述生成机器码所需的信息：

```cpp
/* === src/hotspot/share/interpreter/templateTable.hpp:41-75（节选） === */

// A Template describes the properties of a code template for a given bytecode
// and provides a generator to generate the code template.
class Template {
 private:
  enum Flags {
    uses_bcp_bit,
    does_dispatch_bit,
    calls_vm_bit,
    wide_bit
  };

  typedef void (*generator)(int arg);

  int       _flags;
  TosState  _tos_in;
  TosState  _tos_out;
  generator _gen;
  int       _arg;

 public:
  bool      is_valid() const;
  bool      uses_bcp() const;
  bool      does_dispatch() const;
  bool      calls_vm() const;
  bool      is_wide() const;
  TosState  tos_in() const;
  TosState  tos_out() const;
  void      generate(InterpreterMacroAssembler* masm);
};
```

五类信息共同构成一张生成配方：

| 字段 | 含义 |
|---|---|
| `_flags` | 模板是否使用 BCP、是否自行 dispatch、是否调用 VM、是否属于 wide 形式 |
| `_tos_in` | 进入模板前，缓存栈顶的状态 |
| `_tos_out` | 模板完成后，缓存栈顶的状态 |
| `_gen` | 真正发射平台代码的 generator function |
| `_arg` | 传给 generator 的整数参数 |

`TosState` 不是整个 Java 操作数栈的类型快照。它描述解释器在 dispatch 边界处如何保存或缓存栈顶值，例如 `itos`、`atos`、`ltos`、`vtos`。

### 2.2 普通表与 wide 表

`TemplateTable` 保存两组描述符：

```cpp
/* === src/hotspot/share/interpreter/templateTable.hpp:88-94（节选） === */

static Template _template_table     [Bytecodes::number_of_codes];
static Template _template_table_wide[Bytecodes::number_of_codes];

static Template*       _desc;
static Bytecodes::Code bytecode() { return _desc->bytecode(); }
```

- `_template_table`：普通字节码形式；
- `_template_table_wide`：带 `wide` 前缀后的形式；
- 不是每个 opcode 都有 wide Template。

例如 `_iconst_0` 的普通描述符是：

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:264 === */

def(Bytecodes::_iconst_0,
    ____|____|____|____, vtos, itos, iconst, 0);
```

可以读成：

```text
bytecode  = _iconst_0
flags     = 无 uses_bcp / self-dispatch / calls_vm / wide
TosState  = vtos → itos
generator = iconst
argument  = 0
```

它不是 `_iconst_0` 的机器码。它表达的是：“生成 `_iconst_0` 时，调用 `iconst(0)`；模板前没有缓存栈顶值，模板后缓存一个 int。”

`_iload` 同时拥有普通和 wide 描述符：

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:282, 465 === */

// ordinary
 def(Bytecodes::_iload, ubcp|____|clvm|____,
     vtos, itos, iload, _);

// wide
 def(Bytecodes::_iload, ubcp|____|____|iswd,
     vtos, itos, wide_iload, _);
```

两者 opcode 相同，但 generator 和 flags 不同：普通 `_iload` 读取普通宽度的 local index；wide `_iload` 处理扩展后的 index。

### 2.3 `Template::generate()` 才真正调用配方

```cpp
/* === src/hotspot/share/interpreter/templateTable.cpp:58-65 === */

void Template::generate(InterpreterMacroAssembler* masm) {
  // parameter passing
  TemplateTable::_desc = this;
  TemplateTable::_masm = masm;
  // code generation
  _gen(_arg);
  masm->flush();
}
```

流程是：

1. `_desc = this`：让 `TemplateTable` 的 helper 知道当前生成哪一个 Template；
2. `_masm = masm`：让平台 generator 使用当前 `InterpreterMacroAssembler`；
3. `_gen(_arg)`：调用 `iconst(0)`、`iload(...)` 等 generator；
4. `masm->flush()`：刷新当前 assembler 缓冲。

因此必须区分：

```text
TemplateTable::initialize()
  → 注册描述符 / 配方

Template::generate(masm)
  → 执行配方，向 CodeBuffer 发射机器码
```

ch17 会深入第一步如何注册全部 Template。本文关注第二步如何把已经存在的配方变成 Codelet。

---

## 3. `generate_all()` 生成的不只是字节码 handler

### 3.1 真实顺序

`generate_all()` 从 `templateInterpreterGenerator.cpp:57` 开始，到 `:263` 结束。按源码顺序归类如下：

| 顺序 | 生成物 | 源码范围 |
|---:|---|---|
| 1 | slow signature handler | `:58-60` |
| 2 | unimplemented / illegal bytecode error exits | `:62-65` |
| 3 | 可选 bytecode tracing support | `:67-84` |
| 4 | return entries、invoke return entries、early return entries | `:86-138` |
| 5 | native result handlers | `:140-151` |
| 6 | safepoint entries | `:154-168` |
| 7 | 通用和专门的 exception entries | `:170-182` |
| 8 | 各种 `MethodKind` 的 method entries | `:186-230` |
| 9 | 所有字节码的 normal/wide entries | `:232-233` |
| 10 | 所有 defined bytecode 的 safepoint table entries | `:235-237` |
| 11 | deoptimization entries | `:239-261` |

每组通常由一个 `CodeletMark` 包围。例如最先生成两个共享错误出口：

```cpp
/* === templateInterpreterGenerator.cpp:62-65 === */

{ CodeletMark cm(_masm, "error exits");
  _unimplemented_bytecode    = generate_error_exit("unimplemented bytecode");
  _illegal_bytecode_sequence = generate_error_exit(
      "illegal bytecode sequence - method not verified");
}
```

这两个地址随后会成为 undefined opcode 和非法 `TosState` 组合的默认目标。

### 3.2 normal table 不是最后统一生成的

字节码阶段只有一行：

```cpp
// Bytecodes
set_entry_points_for_all_bytes();
```

但它内部会逐个 opcode 生成 Codelet，并立即写入 `_normal_table` 和 `_wentry_point`。所以真实过程是：

```text
生成 opcode A Codelet → 安装 A 的 normal/wide entries
生成 opcode B Codelet → 安装 B 的 normal/wide entries
生成 opcode C Codelet → 安装 C 的 normal/wide entries
...
```

不存在“先把所有字节码机器码生成完，再单独生成 normal dispatch table”的后置阶段。

`set_safepoints_for_all_bytes()` 确实稍后运行，但它填的是 `_safept_table`，不是 normal table。safepoint table 的运行时用途留到 16.3。

---

## 4. defined opcode 全部在启动期遍历

### 4.1 遍历的是完整 dispatch table 域

```cpp
/* === templateInterpreterGenerator.cpp:276-285 === */

void TemplateInterpreterGenerator::set_entry_points_for_all_bytes() {
  for (int i = 0; i < DispatchTable::length; i++) {
    Bytecodes::Code code = (Bytecodes::Code)i;
    if (Bytecodes::is_defined(code)) {
      set_entry_points(code);
    } else {
      set_unimplemented(i);
    }
  }
}
```

这段循环没有读取应用方法，也没有检查某条字节码未来是否会被使用。它遍历 `DispatchTable::length` 个 slot：

```text
slot i
  ├─ Bytecodes::is_defined(i) == true
  │    └─ set_entry_points(code) → 生成 opcode handler
  └─ false
       └─ set_unimplemented(i) → 安装共享错误地址
```

所以准确说法是：

> VM 启动时遍历 dispatch table 的完整 slot 域，为每个 defined opcode 生成入口；undefined slot 不生成独立 handler，而是指向共享 `_unimplemented_bytecode`。

不能写成“所有 200+ 字节码只有实际用到时才生成”。标准 JVM bytecode、HotSpot 内部 rewritten bytecode、defined slot 和 table capacity 是不同口径，不宜用一个模糊数字混在一起。

### 4.2 undefined slot 的所有状态共享一个地址

```cpp
/* === templateInterpreterGenerator.cpp:296-301 === */

void TemplateInterpreterGenerator::set_unimplemented(int i) {
  address e = _unimplemented_bytecode;
  EntryPoint entry(e, e, e, e, e, e, e, e, e, e);
  Interpreter::_normal_table.set_entry(i, entry);
  Interpreter::_wentry_point[i] = _unimplemented_bytecode;
}
```

`EntryPoint` 的十个 `TosState` 地址全部是同一个 `e`；wide entry 也是同一个错误出口：

```text
undefined slot i:
  btos ─┐
  ztos  │
  ctos  │
  ...   ├─→ _unimplemented_bytecode
  vtos  │
  wide ─┘
```

这已经说明：dispatch entry 与 Codelet 不是一一关系。多个 slot、多个状态都可以共享同一段错误代码。

---

## 5. 一个 defined opcode 怎样生成

### 5.1 `set_entry_points(code)` 的骨架

```cpp
/* === templateInterpreterGenerator.cpp:304-335 === */

void TemplateInterpreterGenerator::set_entry_points(Bytecodes::Code code) {
  CodeletMark cm(_masm, Bytecodes::name(code), code);

  address bep = _illegal_bytecode_sequence;
  address zep = _illegal_bytecode_sequence;
  address cep = _illegal_bytecode_sequence;
  address sep = _illegal_bytecode_sequence;
  address aep = _illegal_bytecode_sequence;
  address iep = _illegal_bytecode_sequence;
  address lep = _illegal_bytecode_sequence;
  address fep = _illegal_bytecode_sequence;
  address dep = _illegal_bytecode_sequence;
  address vep = _unimplemented_bytecode;
  address wep = _unimplemented_bytecode;

  if (Bytecodes::is_defined(code)) {
    Template* t = TemplateTable::template_for(code);
    assert(t->is_valid(), "just checking");
    set_short_entry_points(t, bep, cep, sep, aep, iep, lep, fep, dep, vep);
  }
  if (Bytecodes::wide_is_defined(code)) {
    Template* t = TemplateTable::template_for_wide(code);
    assert(t->is_valid(), "just checking");
    set_wide_entry_point(t, wep);
  }

  EntryPoint entry(bep, zep, cep, sep, aep, iep, lep, fep, dep, vep);
  Interpreter::_normal_table.set_entry(code, entry);
  Interpreter::_wentry_point[code] = wep;
}
```

可以分成四步：

1. 开启一个带 bytecode 名称和 tag 的 `CodeletMark` 范围；
2. 先把各状态地址设为共享 illegal/unimplemented entry；
3. 根据普通和 wide Template 生成有效入口；
4. 把最终地址写入 normal table 与 wide entry array。

### 5.2 为什么初始地址不全是 NULL

初始值分两类：

- `btos` 到 `dtos`：默认 `_illegal_bytecode_sequence`；
- `vtos` 和 wide：默认 `_unimplemented_bytecode`。

这样，即使某个状态组合不合法，dispatch table 仍有可诊断目标，而不是跳到 NULL。

`EntryPoint` 最终保留十种状态地址。哪些状态指向新生成入口、哪些保留共享 illegal/unimplemented 地址，由 `set_short_entry_points()` 和平台相关 helper 决定；不能只按局部变量是否存在来推断状态之间必然共享。

### 5.3 short entry 按 `tos_in` 生成

```cpp
/* === templateInterpreterGenerator.cpp:345-361（节选） === */

switch (t->tos_in()) {
  case atos:
    vep = __ pc(); __ pop(atos);
    aep = __ pc(); generate_and_dispatch(t);
    break;
  case itos:
    vep = __ pc(); __ pop(itos);
    iep = __ pc(); generate_and_dispatch(t);
    break;
  case ltos:
    vep = __ pc(); __ pop(ltos);
    lep = __ pc(); generate_and_dispatch(t);
    break;
  case ftos: /* 同类处理 */ break;
  case dtos: /* 同类处理 */ break;
  case vtos:
    set_vtos_entry_points(t, bep, cep, sep, aep, iep, lep, fep, dep, vep);
    break;
}
```

如果 Template 需要 `itos` 输入，可以从两种入口进入：

```text
vtos entry
  → 先从内存表达式栈 pop 出 int
  → 落到 itos entry
  → 生成模板主体

itos entry
  → int 已经在 TOS cache
  → 直接执行模板主体
```

因此一个 opcode 的 Codelet 内可以包含多个入口地址，而且这些入口之间可能共享后半段代码。

### 5.4 x86 如何处理 `vtos` 输入模板

`_iconst_0` 的 `tos_in` 是 `vtos`。x86 的 helper 会为其他缓存状态生成“先压回表达式栈，再汇合”的入口：

```cpp
/* === src/hotspot/cpu/x86/templateInterpreterGenerator_x86.cpp:1765-1791（节选） === */

void TemplateInterpreterGenerator::set_vtos_entry_points(Template* t,
    address& bep, address& cep, address& sep, address& aep,
    address& iep, address& lep, address& fep, address& dep,
    address& vep) {
  assert(t->is_valid() && t->tos_in() == vtos, "illegal template");
  Label L;
  aep = __ pc();  __ push_ptr();   __ jmp(L);
  fep = __ pc();  __ push_f(xmm0); __ jmp(L);
  dep = __ pc();  __ push_d(xmm0); __ jmp(L);
  lep = __ pc();  __ push_l();     __ jmp(L);
  bep = cep = sep =
  iep = __ pc();  __ push_i();
  vep = __ pc();
  __ bind(L);
  generate_and_dispatch(t);
}
```

其结构是：

```text
atos entry ─→ push cached oop ─┐
ftos entry ─→ push cached float│
dtos entry ─→ push cached double├─→ 公共 vtos 模板主体
ltos entry ─→ push cached long │
itos entry ─→ push cached int ─┘
vtos entry ────────────────────┘
```

`bep = cep = sep = iep` 还展示了多个整数型状态共享同一个地址。

所以“一个 opcode 对应一个 Codelet”最多描述生成范围；不能进一步简化为“一个 opcode 对应一个入口地址”。

### 5.5 wide entry 仍在同一个 opcode 生成范围

```cpp
/* === templateInterpreterGenerator.cpp:338-342 === */

void TemplateInterpreterGenerator::set_wide_entry_point(Template* t,
                                                         address& wep) {
  assert(t->is_valid(), "template must exist");
  assert(t->tos_in() == vtos, "only vtos tos_in supported for wide instructions");
  wep = __ pc();
  generate_and_dispatch(t);
}
```

如果 `_iload` 存在 wide Template，`set_entry_points(_iload)` 会先生成普通 `_iload` entries，再在同一个 `CodeletMark` scope 中记录 `wep` 并生成 `wide_iload`。

```text
CodeletMark("iload", _iload)
  ├─ ordinary iload entries
  │    └─ _normal_table[_iload][TosState]
  └─ wide_iload entry
       └─ _wentry_point[_iload]
```

`wide` 前缀自身也有普通 Template；它负责运行时识别并转到对应的 `_wentry_point`。该运行时跳转过程留到 16.3。

---

## 6. `CodeletMark`：request、生成、commit

### 6.1 构造函数申请最大候选空间

```cpp
/* === src/hotspot/share/interpreter/interpreter.cpp:84-97 === */

CodeletMark::CodeletMark(InterpreterMacroAssembler*& masm,
                         const char* description,
                         Bytecodes::Code bytecode) :
  _clet((InterpreterCodelet*)AbstractInterpreter::code()->request(codelet_size())),
  _cb(_clet->code_begin(), _clet->code_size()) {
  assert(_clet != NULL, "we checked not enough space already");

  _clet->initialize(description, bytecode);
  masm = new InterpreterMacroAssembler(&_cb);
  _masm = &masm;
}
```

构造过程是：

```text
StubQueue::request(codelet_size())
  → 得到候选 InterpreterCodelet 空间
  → initialize(description, bytecode)
  → 用 Codelet 的 code range 创建 CodeBuffer
  → 创建 InterpreterMacroAssembler
```

`request()` 申请的是候选上限，最终提交大小由实际生成的纯指令大小决定。

### 6.2 Template generator 向同一个 CodeBuffer 发射代码

在 `CodeletMark` 生命周期内，`_masm` 指向当前 `InterpreterMacroAssembler`。`set_short_entry_points()`、`set_wide_entry_point()`、`Template::generate()` 和 dispatch helper 都向同一个 `_cb` 追加指令。

```text
CodeletMark scope
  ├─ entry A: 记录 __ pc()
  ├─ 发射适配指令
  ├─ entry B: 记录 __ pc()
  ├─ Template::_gen(_arg)
  ├─ dispatch code
  └─ scope 结束
```

entry address 本质上是生成过程中特定时刻的当前 PC；它可以落在同一 Codelet 的不同偏移处。

### 6.3 析构函数按实际指令大小提交

```cpp
/* === src/hotspot/share/interpreter/interpreter.cpp:99-112 === */

CodeletMark::~CodeletMark() {
  (*_masm)->align(wordSize);
  (*_masm)->flush();

  int committed_code_size = (*_masm)->code()->pure_insts_size();
  if (committed_code_size) {
    AbstractInterpreter::code()->commit(
        committed_code_size, (*_masm)->code()->strings());
  }
  *_masm = NULL;
}
```

析构过程对应：

1. 对齐 Codelet 末尾；
2. flush assembler；
3. 读取实际 `pure_insts_size()`；
4. 非零时向 StubQueue commit；
5. 把调用方的 assembler 指针置 NULL。

最后一步表示当前 Codelet 生成上下文已经结束，后续代码不能继续把该指针当作有效生成器。它不是 C++ 语言层面的“之后使用必然 segfault”保证。

这里也没有 `delete _masm`。这套启动期生成对象按 VM 的资源/生命周期模型使用，不能把“置空外部指针”描述成“析构时释放 assembler”。

### 6.4 Codelet 是 allocation/metadata unit

`InterpreterCodelet` 记录 description、可选 bytecode tag 和 code range。它通常包含新生成的指令，但不能把它定义为“必定独占一段非空机器码”：

- 多个 entry 可以共享同一段代码；
- undefined/illegal 状态指向先前生成的共享 error Codelet；
- 某些生成项可能复用已有 entry；
- `CodeletMark` 只在 `committed_code_size != 0` 时 commit。

因此更准确的定义是：

> `InterpreterCodelet` 是解释器生成过程中的 StubQueue allocation/metadata unit；它按描述或 opcode 组织生成范围，通常承载机器指令，但与 dispatch address 不是严格一一关系。

---

## 7. `generate_and_dispatch()`：模板主体前后发生什么

### 7.1 完整控制结构

```cpp
/* === templateInterpreterGenerator.cpp:367-402（节选） === */

void TemplateInterpreterGenerator::generate_and_dispatch(Template* t,
                                                          TosState tos_out) {
  // 可选 histogram / count / trace / debug code
  int step = 0;
  if (!t->does_dispatch()) {
    step = t->is_wide()
      ? Bytecodes::wide_length_for(t->bytecode())
      : Bytecodes::length_for(t->bytecode());
    if (tos_out == ilgl) tos_out = t->tos_out();
    assert(step > 0, "just checkin'");
    __ dispatch_prolog(tos_out, step);
  }

  t->generate(_masm);

  if (t->does_dispatch()) {
#ifdef ASSERT
    __ should_not_reach_here();
#endif
  } else {
    __ dispatch_epilog(tos_out, step);
  }
}
```

分成两条路径。

### 7.2 普通模板：generator 补齐 dispatch 框架

```text
!t->does_dispatch()
  → 计算普通/wide 字节码长度 step
  → 确定 tos_out
  → dispatch_prolog(tos_out, step)
  → Template::generate(_masm)
  → dispatch_epilog(tos_out, step)
```

`dispatch_epilog()` 最终会进入平台相关的“取下一字节码并跳转”逻辑。具体 x86 寄存器和 `_active_table` 查表过程属于 16.3。

### 7.3 self-dispatch 模板：模板自己负责控制转移

如果 flags 包含 `does_dispatch_bit`：

```text
t->does_dispatch()
  → 不生成统一 dispatch_prolog
  → Template::generate(_masm)
  → 模板必须自行完成跳转、返回、抛异常或其他控制转移
```

ASSERT 构建还会在模板后放 `should_not_reach_here()`，用于捕获“声称自己 dispatch，却意外落穿”的错误。

因此不能写：

```text
错误：每一个字节码 Codelet 的末尾都执行完全相同的 dispatch_next
```

更准确的是：

> 普通非 self-dispatch Template 由 generator 添加统一 dispatch prolog/epilog；标记 `does_dispatch()` 的 Template 自己生成控制转移。

### 7.4 为什么使用 InterpreterMacroAssembler

`Template::_gen(_arg)` 最终调用 x86 `templateTable_x86.cpp` 中的 generator。这些函数不是直接写机器码字节，而是调用 `InterpreterMacroAssembler` 的高层操作：

```text
TemplateTable::iconst(0)
  → InterpreterMacroAssembler helper
  → MacroAssembler / Assembler
  → CodeBuffer 中的 x86 machine instructions
```

`InterpreterMacroAssembler` 还封装了解释器专用约定，例如表达式栈、BCP、locals、TOS cache 和 VM call。本文关注这层机制，不逐条翻译每个 x86 指令。

---

## 8. 两个例子串起完整链路

### 8.1 `_iconst_0`：普通 vtos → itos Template

描述符：

```cpp
def(Bytecodes::_iconst_0,
    /* no special flags */, vtos, itos, iconst, 0);
```

启动期生成链：

```text
set_entry_points(_iconst_0)
  → CodeletMark("iconst_0", _iconst_0)
  → TemplateTable::template_for(_iconst_0)
  → set_short_entry_points(tos_in = vtos)
  → x86 set_vtos_entry_points()
       ├─ 为非 vtos 状态生成“先把缓存值压回栈”的适配入口
       └─ 汇合到 vtos 模板主体
  → generate_and_dispatch()
       ├─ dispatch_prolog(tos_out = itos, step = 1)
       ├─ Template::generate(_masm)
       │    └─ TemplateTable::iconst(0)
       └─ dispatch_epilog(itos, 1)
  → 安装 _normal_table[_iconst_0]
  → CodeletMark 析构并 commit
```

运行时效果是把常量 0 放入解释器的 int TOS cache；但本文不需要虚构具体 `mov` 指令，因为实际 generator 可能根据平台约定选择寄存器和指令序列。

### 8.2 `_iload`：同一 opcode 的普通与 wide Template

描述符层：

```text
ordinary _iload:
  flags     = uses_bcp + calls_vm
  TosState  = vtos → itos
  generator = iload

wide _iload:
  flags     = uses_bcp + wide
  TosState  = vtos → itos
  generator = wide_iload
```

生成层：

```text
set_entry_points(_iload)
  └─ one CodeletMark scope
       ├─ template_for(_iload)
       │    └─ 生成 ordinary short entries
       │         └─ _normal_table[_iload][TosState]
       │
       └─ template_for_wide(_iload)
            └─ 生成 wide entry
                 └─ _wentry_point[_iload]
```

这个例子说明：

1. 普通和 wide 形式使用不同 Template/generator；
2. 它们在同一个 opcode 的 `CodeletMark` 范围内生成；
3. normal table 是 `TosState + opcode` 的入口集合；
4. wide entry 另存在 `_wentry_point[opcode]`；
5. “一个 opcode = 一个地址”显然不成立。

---

## 9. 从描述符到 Codelet 的完整图

```text
TemplateTable::initialize()
  └─ 注册 ordinary / wide Template descriptors
       │
       ▼
TemplateInterpreterGenerator::generate_all()
  └─ set_entry_points_for_all_bytes()
       │
       ├─ undefined slot
       │    └─ normal states + wide → shared unimplemented entry
       │
       └─ defined opcode
            └─ set_entry_points(code)
                 │
                 ├─ CodeletMark(description, bytecode)
                 │    ├─ StubQueue::request(codelet_size)
                 │    ├─ InterpreterCodelet::initialize
                 │    └─ new InterpreterMacroAssembler(CodeBuffer)
                 │
                 ├─ ordinary Template
                 │    └─ set_short_entry_points()
                 │         ├─ record TosState entry PCs
                 │         └─ generate_and_dispatch()
                 │              ├─ optional dispatch_prolog
                 │              ├─ Template::generate(_masm)
                 │              │    └─ _gen(_arg)
                 │              └─ optional dispatch_epilog
                 │
                 ├─ optional wide Template
                 │    └─ set_wide_entry_point()
                 │
                 ├─ install _normal_table[code]
                 ├─ install _wentry_point[code]
                 │
                 └─ CodeletMark::~CodeletMark()
                      ├─ align + flush
                      ├─ commit actual instruction size
                      └─ caller masm pointer = NULL
```

---

## 10. 本文结论

### 10.1 描述符不是机器码

`Template` 保存 flags、`TosState`、generator 和 argument。`TemplateTable::initialize()` 注册这些配方；`Template::generate()` 才调用平台 generator 发射机器码。

### 10.2 生成不是 lazy 的

`set_entry_points_for_all_bytes()` 在 VM 启动期遍历完整 dispatch table 域。defined opcode 立即生成，undefined slot 指向共享 error entry。

### 10.3 Codelet 不等于单个入口地址

一个 opcode 的 Codelet 生成范围内可能有：

- 多个 `TosState` entry；
- 多状态共享地址；
- 普通与 wide entry；
- 指向其他共享 error Codelet 的无效状态。

所以 Codelet、opcode 与 dispatch address 不是严格的一一一关系。

### 10.4 CodeletMark 管理生成事务

构造时 request 空间并创建 assembler；生命周期内发射代码；析构时 align、flush、按实际指令大小 commit，并清空调用方 assembler 指针。它不在析构函数中 `delete` assembler，也不承诺错误使用必然以某种方式崩溃。

### 10.5 dispatch 有两类责任边界

- 普通 Template：generator 添加 dispatch prolog/epilog；
- `does_dispatch()` Template：模板自己生成控制转移。

下一篇 **16.3 方法入口、Threaded Dispatch 与运行时边界** 将从已经安装的地址出发，解释：方法怎样选择 interpreter entry，运行时怎样以 `TosState + bytecode` 查询 `_active_table`，以及 safepoint table 和 OSR 怎样接入执行路径。

ch17 则回到生成前一步，深入 `TemplateTable::initialize()` 如何为每种字节码注册普通和 wide 描述符。
