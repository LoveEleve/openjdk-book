# 4.3 bytecodes_init — JVM 字节码表的初始化

4.2 节讲了 `management_init`——注册 JMX 管理的 C++ 侧地基。本节讲 `init_globals()` 的第二项 `bytecodes_init()`——初始化 JVM 字节码表。

`bytecodes_init()` 本身只有 3 行：

```cpp
/* === src/hotspot/share/interpreter/bytecodes.cpp === */

void bytecodes_init() {
  Bytecodes::initialize();
}
```

但它背后是整个 JVM 字节码体系：239 个字节码的定义、格式串编码（`_flags` 双页结构 + `_lengths` 高低 4 位编码）、Bytecode class 体系（11 个子类解析已加载方法的字节码）、Rewriter 改写机制（类加载时把 CP 索引改成 CP cache 索引 + native 字节序）、fast/nofast 变体（36 个 JVM 内部字节码）。

---

## 为什么要初始化字节码表

JVM 要执行 Java 字节码，必须先知道每个字节码的"长相"——多长、操作数是什么类型、执行后栈怎么变、会不会抛异常。这些信息在 JVM 规范里定义，但 HotSpot 不能每次执行都查规范，所以启动时把所有字节码的元信息填进静态表，后续直接查表。

举个例子：解释器执行到 `0xb6`（invokevirtual）时，要回答几个问题：
- 这条指令多长？（3 字节——1 操作码 + 2 索引）
- 操作数是什么？（2 字节 CP cache 索引，native 字节序）
- 执行后栈深度怎么变？（-1——弹 receiver+参数，压返回值）
- 会抛异常吗？（会——NPE、链接错误）
- 有 fast 变体吗？（有——_fast_invokevfinal）

这些答案在 `Bytecodes::initialize()` 里通过 239 次 `def()` 调用填进 6 张静态表。

---

## Bytecodes::initialize() 全貌源码

`bytecodes_init()` 调用的 `Bytecodes::initialize()`（`bytecodes.cpp:278-567`）是个约 290 行的大函数，核心是 239 次 `def()` 调用：

```cpp
/* === src/hotspot/share/interpreter/bytecodes.cpp:278-281 === */

void Bytecodes::initialize() {
  if (_is_initialized) return;                    // 幂等保护
  assert(number_of_codes <= 256, "too many bytecodes");
  // ...
  // 下面是 239 次 def() 调用：
  //   203 个 Java 标准字节码（_nop 到 _breakpoint）
  //   36 个 JVM 内部字节码（_fast_agetfield 到 _shouldnotreachhere）
  // ...
  _is_initialized = true;                         // 标记已完成
}
```

`_is_initialized` 标志防止重复初始化——`init_globals()` 理论上只调一次，但幂等保护更安全。

---

## 6 张静态表

`Bytecodes` 类（复数，`AllStatic`）持有 6 张静态表，`def()` 往里填数据：

| 表名 | 类型 | 大小 | 存什么 |
|------|------|------|--------|
| `_name[]` | `const char*` | 239 | 字节码名字（如 `"invokevirtual"`） |
| `_result_type[]` | `BasicType` | 239 | 执行后栈顶元素的类型（如 `T_INT`） |
| `_depth[]` | `s_char` | 239 | 执行后栈深度的净变化量（如 `iconst_1` 是 +1） |
| `_lengths[]` | `u_char` | 239 | 指令长度（低 4 位普通，高 4 位 wide） |
| `_java_code[]` | `Code` | 239 | JVM 内部字节码对应的 Java 标准字节码 |
| `_flags[]` | `jchar` | **512** | 格式 flags（双页：普通 256 + wide 256） |

前 5 张表用 `number_of_codes`（= 239）作大小，`_flags` 用 512——因为要分两页存普通和 wide 两种格式。

---

## def() 函数

每次 `def()` 调用填一个字节码的元信息。函数签名（`bytecodes.cpp:162-185`）：

```cpp
void Bytecodes::def(Code code, const char* name, const char* format,
                    const char* wide_format, BasicType result_type,
                    int depth, bool can_trap, Code java_code) {
  int len  = (format      != NULL ? (int) strlen(format)      : 0);
  int wlen = (wide_format != NULL ? (int) strlen(wide_format) : 0);
  _name         [code] = name;
  _result_type  [code] = result_type;
  _depth        [code] = depth;
  _lengths      [code] = (wlen << 4) | (len & 0xF);     // 长度编码
  _java_code    [code] = java_code;
  int bc_flags = 0;
  if (can_trap)           bc_flags |= _bc_can_trap;
  if (java_code != code)  bc_flags |= _bc_can_rewrite;  // fast 变体标记
  _flags[code + 0*256] = compute_flags(format,      bc_flags);  // 普通页
  _flags[code + 1*256] = compute_flags(wide_format, bc_flags);  // wide 页
}
```

参数含义：

| 参数 | 含义 | 例子（invokevirtual） |
|------|------|----------------------|
| `code` | 字节码枚举值 | `_invokevirtual`（182） |
| `name` | 名字字符串 | `"invokevirtual"` |
| `format` | 普通格式串 | `"bJJ"` |
| `wide_format` | wide 格式串（NULL = 无 wide） | `NULL` |
| `result_type` | 栈顶类型 | `T_ILLEGAL`（取决于方法签名） |
| `depth` | 栈深度变化 | `-1` |
| `can_trap` | 是否可能抛异常 | `true` |
| `java_code` | 对应的 Java 标准字节码 | `_invokevirtual`（自己） |

---

## 格式串（format string）

格式串是 `def()` 的核心参数——用一串字符描述字节码的内存布局。格式串的长度 = 字节码的长度，每个字符代表 1 字节。

### 字符含义

```cpp
/* === src/hotspot/share/interpreter/bytecodes.cpp:188-204 === */

// Format strings interpretation:
//
// b: bytecode（操作码本身）
// c: signed constant, Java byte-ordering（有符号常量）
// i: unsigned local index, Java byte-ordering（局部变量索引）
// j: unsigned CP cache index, Java byte-ordering（常量池缓存索引）
// k: unsigned CP index, Java byte-ordering（常量池索引）
// o: branch offset, Java byte-ordering（分支偏移）
// _: unused/ignored（填充字节）
// w: wide bytecode（wide 前缀）
//
// 大写 = native byte order（Rewriter 改写后的字段）
```

| 字符 | 含义 | 大写 | 区别 |
|------|------|------|------|
| `b` | 操作码 | — | — |
| `c` | 有符号常量 | — | — |
| `i` | 局部变量索引 | `I` | native 字节序 |
| `j` | 常量池缓存索引 | `J` | native 字节序 |
| `k` | 常量池索引 | `K` | native 字节序 |
| `o` | 分支偏移 | `O` | native 字节序 |
| `_` | 填充字节 | — | — |
| `w` | wide 前缀 | — | — |

**为什么有大小写？** Rewriter 在类加载时把 `getfield`/`invokevirtual` 等字节码后面的常量池索引改写成常量池缓存索引，同时把字节序从 Java big-endian 改成 native（x86 小端）。格式串里小写表示 Java 字节序（class 文件原始形式），大写表示 native 字节序（Rewriter 改写后的形式）。

### 典型字节码的格式串

| 字节码 | 格式串 | 长度 | 含义 |
|--------|--------|------|------|
| `nop` | `"b"` | 1 | 仅操作码 |
| `bipush` | `"bc"` | 2 | 操作码 + 1 字节常量 |
| `sipush` | `"bcc"` | 3 | 操作码 + 2 字节常量 |
| `ldc` | `"bk"` | 2 | 操作码 + 1 字节 CP 索引 |
| `iload` | `"bi"` | 2 | 操作码 + 1 字节局部索引 |
| `iload`（wide） | `"wbii"` | 4 | wide 前缀 + 操作码 + 2 字节局部索引 |
| `ifeq` | `"boo"` | 3 | 操作码 + 2 字节偏移 |
| `goto_w` | `"boooo"` | 5 | 操作码 + 4 字节偏移 |
| `getfield` | `"bJJ"` | 3 | 操作码 + 2 字节 native CP cache 索引 |
| `invokevirtual` | `"bJJ"` | 3 | 同上 |
| `invokedynamic` | `"bJJJJ"` | 5 | 操作码 + 4 字节 native CP cache 索引 |
| `new` | `"bkk"` | 3 | 操作码 + 2 字节 CP 索引 |
| `multianewarray` | `"bkkc"` | 4 | 操作码 + 2 字节 CP 索引 + 1 字节维数 |
| `tableswitch` | `""` | 变长 | 运行时计算 |
| `lookupswitch` | `""` | 变长 | 运行时计算 |

---

## _lengths[] 编码：一个字节存两个长度

`_lengths[]` 是 `u_char`（8 位）数组，每个字节码占 1 字节——但一个字节码有两种形式（普通 + wide），两个长度怎么塞进 1 字节？

**答案：低 4 位存普通长度，高 4 位存 wide 长度**。

```cpp
// bytecodes.cpp:174
_lengths[code] = (wlen << 4) | (len & 0xF);
```

以 `iload` 为例：普通格式 `"bi"` 长度 2，wide 格式 `"wbii"` 长度 4：

```
_lengths[_iload] = (4 << 4) | (2 & 0xF) = 0x42
                                              ^^ 低 4 位 = 2（普通长度）
                                            ^^   高 4 位 = 4（wide 长度）
```

读取时：

```cpp
// bytecodes.hpp:397-398
static int length_for     (Code code) { return _lengths[code] & 0xF; }  // 取低 4 位
static int wide_length_for(Code code) { return _lengths[code] >> 4;  }  // 取高 4 位
```

因为字节码最长 6 字节（如 wide 的 `"wbiicc"`），都在 0-15 范围内，4 位够用。

---

## _flags[] 双页结构

`_flags[]` 是 `jchar`（16 位）数组，大小 512——分两页：

- **第一页**（索引 0-255）：普通格式的 flags
- **第二页**（索引 256-511）：wide 格式的 flags

```cpp
// bytecodes.cpp:179-180
_flags[code + 0*256] = compute_flags(format,      bc_flags);  // 普通页
_flags[code + 1*256] = compute_flags(wide_format, bc_flags);  // wide 页
```

读取时通过 `is_wide` 参数选页：

```cpp
// bytecodes.hpp:432-435
static int flags(int code, bool is_wide) {
  return _flags[code + (is_wide ? 256 : 0)];
}
```

### 16 个 flag 位

`_flags` 的 16 位分成语义标志（2 位）和格式位（10 位）：

```cpp
/* === src/hotspot/share/interpreter/bytecodes.hpp:310-336 === */

// 语义标志（由 def() 参数传入）：
_bc_can_trap      = 1<<0,    // 执行时可能抛异常（如 idiv 除零）
_bc_can_rewrite   = 1<<1,    // 会被 Rewriter/模板表改写（fast 变体标记）

// 格式位（由格式串派生）：
_fmt_has_c        = 1<<2,    // 含有符号常量（如 bipush "bc"）
_fmt_has_j        = 1<<3,    // 含 CP cache 索引（如 getfield "bJJ"）
_fmt_has_k        = 1<<4,    // 含 CP 索引（如 ldc "bk"）
_fmt_has_i        = 1<<5,    // 含局部变量索引（如 iload "bi"）
_fmt_has_o        = 1<<6,    // 含分支偏移（如 ifeq "boo"）
_fmt_has_nbo      = 1<<7,    // 操作数是 native 字节序（大写字母）
_fmt_has_u2       = 1<<8,    // 含 2 字节字段（连续 2 个相同字符）
_fmt_has_u4       = 1<<9,    // 含 4 字节字段（连续 4 个相同字符）
_fmt_not_variable = 1<<10,   // 非变长（定长指令）
_fmt_not_simple   = 1<<11,   // 非简单（wide 或变长）
```

`compute_flags()` 函数（`bytecodes.cpp:206-276`）解析格式串，把字符转成对应的 flag 位。例如 `"bJJ"` 会生成：`_fmt_not_variable | _fmt_has_j | _fmt_has_u2 | _fmt_has_nbo`。

---

## 239 个字节码

HotSpot 定义了 239 个字节码，分两组：

**203 个 Java 标准字节码**（码值 0-202）：和 JVM 规范一一对应，从 `_nop = 0` 到 `_breakpoint = 202`。这些出现在 class 文件里。

**36 个 JVM 内部字节码**（码值 203-238）：不出现在 class 文件里，是 Rewriter 或运行时模板表改写后的形式。按功能分组：

| 分组 | 数量 | 例子 | 原 Java 字节码 |
|------|------|------|---------------|
| fast_*getfield | 8 | `_fast_agetfield`/`_fast_igetfield`... | `_getfield` |
| fast_*putfield | 9 | `_fast_aputfield`/`_fast_zputfield`... | `_putfield` |
| fast_aload_0 + fast_*access_0 | 4 | `_fast_aload_0`/`_fast_iaccess_0`... | `_aload_0` |
| fast_iload 系列 | 3 | `_fast_iload`/`_fast_iload2`/`_fast_icaload` | `_iload` |
| fast_invokevfinal | 1 | `_fast_invokevfinal` | `_invokevirtual`（final 方法） |
| fast_switch | 2 | `_fast_linearswitch`/`_fast_binaryswitch` | `_lookupswitch` |
| fast_aldc | 2 | `_fast_aldc`/`_fast_aldc_w` | `_ldc`/`_ldc_w`（引用类型） |
| return_register_finalizer | 1 | `_return_register_finalizer` | `_return`（Object.<init>） |
| invokehandle | 1 | `_invokehandle` | `_invokevirtual`（签名多态） |
| nofast_* | 4 | `_nofast_getfield`/`_nofast_putfield`... | CDS 用 |
| shouldnotreachhere | 1 | `_shouldnotreachhere` | 调试用 |

---

## Bytecode class 体系（11 个子类）

上面讲的 `Bytecodes`（复数）是"字典"——声明所有字节码的格式。但运行时解析某条具体的字节码需要另一套类：`Bytecode`（单数）及其子类。

### Bytecodes 和 Bytecode 的分工

| | Bytecodes（复数） | Bytecode（单数） |
|---|---|---|
| 性质 | `AllStatic` 纯静态工具类 | `StackObj` 栈上对象 |
| 持有状态 | 全局静态表（`_name`/`_flags`/`_lengths`...） | `_bcp`（字节码指针）+ `_code`（当前字节码） |
| 用途 | **声明**字节码的格式约定 | **解析**某条具体的字节码 |
| 何时用 | 启动时 `initialize()` 填表 | 运行时每次解析字节码 |

**一句话：Bytecodes 是字典，Bytecode 是读者**。

### 11 个子类

`Bytecode` 基类（`bytecode.hpp:40`）提供通用的字节读取方法。11 个子类按字节码类型分组：

```
Bytecode (StackObj)
├── Bytecode_lookupswitch      // lookupswitch 变长指令
├── Bytecode_tableswitch       // tableswitch 变长指令
├── Bytecode_member_ref        // 中间基类（protected 构造）
│   ├── Bytecode_invoke        // invokevirtual/special/static/interface/dynamic/handle
│   └── Bytecode_field         // getfield/putfield/getstatic/putstatic
├── Bytecode_checkcast         // checkcast
├── Bytecode_instanceof        // instanceof
├── Bytecode_new               // new
├── Bytecode_multianewarray    // multianewarray
├── Bytecode_anewarray         // anewarray
└── Bytecode_loadconstant      // ldc/ldc_w/ldc2_w
```

每个子类提供类型安全的访问方法。例如 `Bytecode_invoke`（`bytecode.hpp:204`）：

```cpp
class Bytecode_invoke: public Bytecode_member_ref {
 public:
  methodHandle static_target(TRAPS);    // 静态解析目标方法
  bool is_invokevirtual() const;       // 判断 invoke 类型
  bool has_receiver() const;           // 是否有 receiver
  int size_of_parameters() const;      // 参数个数
  // ...
};
```

### 完整例子：invokevirtual 的声明和解析配合

**声明**（`bytecodes.cpp:476`）：
```cpp
def(_invokevirtual, "invokevirtual", "bJJ", NULL, T_ILLEGAL, -1, true);
```

**解析**（运行时）：
```cpp
Bytecode_invoke invoke(method, bci);    // 构造，_code = _invokevirtual
methodHandle callee = invoke.static_target(thread);  // 解析目标方法
```

`static_target` 内部调 `index()` → `get_index_u2_cpcache(_invokevirtual)` → `Bytes::get_native_u2(bcp+1)` 读 2 字节 native 字节序的 CP cache 索引。这个读法正好对应格式串 `"bJJ"` 的大写 J（native 字节序的 CP cache 索引）。

---

## Rewriter 改写机制

Rewriter 在类**链接阶段**（verify 之后、首次执行之前）运行，把 class 文件里的"未解析形式"字节码改写成"更高效的已解析形式"。

### Rewriter 改写什么

| 改写 | 何时 | 做什么 |
|------|------|--------|
| CP 索引 → CP cache 索引 | Rewriter（类加载时） | 把 getfield/invoke 等后面的 CP 索引改成 CP cache 索引 + native 字节序 |
| ldc → fast_aldc | Rewriter | 引用类型（String/MH/MT）的 ldc 改成 fast_aldc，索引换成 resolved_references 数组下标 |
| lookupswitch → fast_linearswitch/binaryswitch | Rewriter | 按 pairs 数选算法（<5 线性，≥5 二分） |
| return → return_register_finalizer | Rewriter | 仅 Object.<init> 末尾的 return |
| invokevirtual → invokehandle | Rewriter | 签名多态方法（MethodHandle.invokeExact 等） |
| getfield → fast_Xgetfield | **运行时模板表** | 首次执行时按字段类型改写（不在 Rewriter 里） |
| aload_0 → fast_aload_0/access_0 | **运行时模板表** | 频繁对合并（RewriteFrequentPairs 控制） |
| iload → fast_iload/iload2/icaload | **运行时模板表** | 频繁对合并 |

**关键区分**：Rewriter 只做"非频繁对"的改写（CP 索引、ldc、switch、return、invokehandle）。fast_*getfield/putfield/aload_0/iload 这些"频繁对"改写是**运行时模板表**通过 `patch_bytecode` 完成的，由 `RewriteBytecodes`/`RewriteFrequentPairs` 开关控制。

### 改写前后字节码流的变化

以 `getfield` 为例（CP 索引 5 → CP cache 索引 3）：

**改写前**（class 文件原始形式）：
```
0xB4  0x00 0x05    // getfield, CP 索引 = 5（Java big-endian）
```

**改写后**（Rewriter 处理）：
```
0xB4  0x03 0x00    // getfield, CP cache 索引 = 3（native little-endian）
```

操作码不变（仍是 `0xB4`），但 2 字节索引从 Java 序变成 native 序，数值从 CP 索引变成 CP cache 索引。

**运行时首次执行后**（模板表 patch_bytecode）：
```
0xCB  0x03 0x00    // fast_agetfield（假设字段是对象类型）
```

操作码从 `0xB4`（getfield）变成 `0xCB`（fast_agetfield），索引不变。

---

## nofast_* 变体和 CDS

CDS（Class Data Sharing）把类的元数据（含字节码流）归档到共享文件，运行时 mmap 到只读段。如果运行时还要修改字节码（patch_bytecode 改成 fast_*），会触发对只读段的写操作——段错误。

**解决方案**：CDS dump 时把 `_getfield`/`_putfield`/`_aload_0`/`_iload` 改成 `_nofast_*` 版本（`metaspaceShared.cpp:526-543`）。`_nofast_*` 执行时走和原版完全相同的逻辑，但 `may_not_rewrite` 永不调 `patch_bytecode`——字节码保持不变，ConstMethod 可以安全放在只读段。

---

## 小结

`bytecodes_init()` 做的事：调 `Bytecodes::initialize()`，通过 239 次 `def()` 调用把所有字节码的元信息填进 6 张静态表：

1. **`_name[]`** — 字节码名字
2. **`_result_type[]`** — 栈顶类型
3. **`_depth[]`** — 栈深度变化
4. **`_lengths[]`** — 指令长度（低 4 位普通，高 4 位 wide）
5. **`_java_code[]`** — fast 变体对应的 Java 标准字节码
6. **`_flags[]`** — 格式 flags（双页 512 个，普通 + wide）

这套表是后续解释器、JIT 编译器、字节码验证器的基础——它们都靠查这些表知道每个字节码的格式和行为。

`bytecodes_init` **不**负责：
- 创建字节码实例（`Bytecode` 子类是运行时按需构造的栈上对象）
- 改写字节码流（Rewriter 在类加载时做，模板表在运行时做）
- 生成模板表（`templateTable_init()` 在后续 `init.cpp:120` 做）

下一节（4.4）讲 `classLoader_init1()` 的边界——它只有 3 行，但要讲清楚它**不**初始化 ClassLoaderData（那在 `universe_init` 里），以及 `os_init_globals` 是个空 hook。
