# 4.3 bytecodes_init — JVM 字节码表的初始化

4.2 节讲了 `management_init`——注册 JMX 管理的 C++ 侧地基。本节讲 `init_globals()` 的第二项 `bytecodes_init()`——初始化 JVM 字节码表。

---

## 从一个真实的 class 文件说起

项目里有个 `/data/workspace/demo/HelloWorld.java`：

```java
public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
```

`javac` 编译后生成 `HelloWorld.class`，427 字节。但这个 class 文件里到底存了什么？用 `javap -v` 看它的完整结构：

```
$ javap -v HelloWorld.class
Classfile /data/workspace/demo/HelloWorld.class
  Last modified Jun 26, 2026; size 427 bytes
  Compiled from "HelloWorld.java"
public class HelloWorld
  minor version: 0
  major version: 55                          // JDK 11
  flags: (0x0021) ACC_PUBLIC, ACC_SUPER
  this_class: #5   // HelloWorld
  super_class: #6  // java/lang/Object
  interfaces: 0, fields: 0, methods: 2, attributes: 1

Constant pool:                               // 常量池，28 项
   #1 = Methodref       #6.#15    // java/lang/Object."<init>":()V
   #2 = Fieldref        #16.#17   // java/lang/System.out:Ljava/io/PrintStream;
   #3 = String          #18       // Hello, World!
   #4 = Methodref       #19.#20   // java/io/PrintStream.println:(Ljava/lang/String;)V
   #5 = Class           #21       // HelloWorld
   #6 = Class           #22       // java/lang/Object
   ...（共 28 项）

{
  public HelloWorld();                       // 构造方法
    Code:
       0: aload_0
       1: invokespecial #1   // Object."<init>"
       4: return

  public static void main(java.lang.String[]);  // main 方法
    Code:
       0: getstatic     #2    // Field java/lang/System.out
       3: ldc           #3    // String Hello, World!
       5: invokevirtual #4    // Method println
       8: return
}
```

class 文件不只是一串字节码——它有**完整的结构**，包含：

| 段 | 内容 | HelloWorld 里的值 |
|----|------|------------------|
| **magic** | 魔数（标识这是 class 文件） | `0xCAFEBABE` |
| **version** | 版本号（major=55 表示 JDK 11） | minor=0, major=55 |
| **constant_pool** | 常量池（类名/方法名/字段名/字符串常量等） | 28 项 |
| **access_flags** | 类的访问标志 | `ACC_PUBLIC, ACC_SUPER` |
| **this_class / super_class** | 本类和父类 | HelloWorld / Object |
| **fields** | 字段表 | 0 个 |
| **methods** | 方法表（每个方法含 Code 属性，字节码就在 Code 里） | 2 个（`<init>` + `main`） |
| **attributes** | 类级属性 | 1 个（SourceFile） |

**字节码只是 class 文件的一部分**——它存在每个方法的 `Code` 属性里。字节码里引用的 #2、#3、#4 等编号，是**常量池索引**——指向常量池里的 Methodref/Fieldref/String 项。

用 hexdump 看 class 文件的二进制，开头 4 字节就是魔数 `CAFEBABE`：

```
00000000: cafe babe 0000 0037 001d ...
         ^^^^^^^^^^ ^^^^^^^^^ ^^^^
         魔数        版本号    常量池项数(28+1=29)
```

main 方法的字节码在文件偏移 388 处（在 Code 属性里）：

```
偏移 388:  b2 00 02 12 03 b6 00 04 b1
```

逐字节对照 `javap` 的输出：

| 二进制 | 操作码 | 指令 | 操作数 | 含义 |
|--------|--------|------|--------|------|
| `b2` `00 02` | 0xB2 = getstatic | getstatic | #2 | 取 System.out 字段（常量池第 2 项） |
| `12` `03` | 0x12 = ldc | ldc | #3 | 加载 "Hello, World!" 字符串（常量池第 3 项） |
| `b6` `00 04` | 0xB6 = invokevirtual | invokevirtual | #4 | 调用 println 方法（常量池第 4 项） |
| `b1` | 0xB1 = return | return | — | 方法返回 |

每条字节码由**操作码**（opcode，1 字节）+ **操作数**（0-N 字节）组成。操作数里的 `#2`/`#3`/`#4` 就是常量池索引——指向常量池里的 Fieldref/String/Methodref 项。JVM 解释器执行 `getstatic #2` 时，要回答几个问题：

- 读到 `0xb2`，怎么知道这是 `getstatic`？
- `getstatic` 指令多长？——3 字节（1 操作码 + 2 操作数），所以下一条指令从偏移 3 开始
- 后面 2 字节 `00 02` 是什么？——常量池索引 #2
- 执行后操作数栈怎么变？——压入 1 个值（PrintStream 对象引用）
- 这条指令会抛异常吗？——可能（如果 System 类没初始化成功）

这些答案**不在 class 文件里**——class 文件只存了二进制指令本身。JVM 必须自己知道每个字节码的"长相"。**答案就是字节码表**——JVM 启动时把所有字节码的元信息填进一张表，后续解释器查表就知道每个字节码的格式和行为。`bytecodes_init()` 就是初始化这张表。

---

## 什么是字节码表

字节码表是一组**静态数组**，每个字节码占一个槽位，记录它的"元信息"——名字、长度、格式、栈变化、能否抛异常等。

JVM 有 239 个字节码，分两类：

**203 个 Java 标准字节码**（码值 0-202）：这些是 JVM 规范定义的、出现在 class 文件里的字节码。你在 class 文件里看到的 `0x00`（nop）、`0x01`（aconst_null）、... `0xb6`（invokevirtual）等都是这一类。

**36 个 JVM 内部字节码**（码值 203-238）：这些**不出现在 class 文件里**，是 JVM 在类加载时或运行时把标准字节码"改写"后的加速版本（如 `fast_agetfield` 是 `getfield` 的加速版）。我们稍后讲 Rewriter 时再展开。

`bytecodes_init()` 做的事就是：对这 239 个字节码，逐个调用 `def()` 填进 6 张静态表。

---

## bytecodes_init() 全貌源码

`bytecodes_init()` 本身只有 3 行：

```cpp
/* === src/hotspot/share/interpreter/bytecodes.cpp === */

void bytecodes_init() {
  Bytecodes::initialize();
}
```

它委托给 `Bytecodes::initialize()`（`bytecodes.cpp:278-567`），后者是个约 290 行的函数，核心是 239 次 `def()` 调用：

```cpp
/* === src/hotspot/share/interpreter/bytecodes.cpp:278-281 === */

void Bytecodes::initialize() {
  if (_is_initialized) return;                    // 防止重复初始化
  assert(number_of_codes <= 256, "too many bytecodes");
  // ...
  // 下面是 239 次 def() 调用：
  //   203 个 Java 标准字节码（_nop 到 _breakpoint）
  //   36 个 JVM 内部字节码（_fast_agetfield 到 _shouldnotreachhere）
  // ...
  _is_initialized = true;
}
```

---

## 6 张静态表

每次 `def()` 往 6 张表里填数据：

| 表名 | 存什么 | 例子（getfield） |
|------|--------|-----------------|
| `_name[]` | 字节码名字 | `"getfield"` |
| `_result_type[]` | 执行后栈顶类型 | `T_ILLEGAL`（取决于字段类型） |
| `_depth[]` | 栈深度变化 | `+1`（弹出对象引用，压入字段值） |
| `_lengths[]` | 指令长度 | `3`（1 操作码 + 2 索引） |
| `_java_code[]` | fast 变体对应的 Java 标准字节码 | `_getfield`（自己映射到自己） |
| `_flags[]` | 格式信息（操作数类型、字节序等） | 见下文 |

解释器执行某条字节码时，就查这些表——比如查 `_lengths[getfield]` 得知这条指令 3 字节长，就知道下一条指令从哪里开始。

---

## def() 函数：每个字节码怎么填表

`def()` 的签名（`bytecodes.cpp:162-185`）：

```cpp
void Bytecodes::def(Code code, const char* name, const char* format,
                    const char* wide_format, BasicType result_type,
                    int depth, bool can_trap, Code java_code);
```

参数含义：

| 参数 | 含义 | getfield 的值 |
|------|------|--------------|
| `code` | 字节码编号 | `_getfield`（180） |
| `name` | 名字 | `"getfield"` |
| `format` | **格式串**（描述内存布局） | `"bJJ"` |
| `wide_format` | wide 形式格式串 | `NULL`（getfield 无 wide 形式） |
| `result_type` | 栈顶类型 | `T_ILLEGAL` |
| `depth` | 栈深度变化 | `+1` |
| `can_trap` | 能否抛异常 | `true`（可能 NPE） |
| `java_code` | 对应的 Java 标准字节码 | `_getfield`（自己） |

最关键的是 `format` 参数——**格式串**描述字节码的内存布局。

---

## 格式串：用字符描述字节码的内存布局

格式串是一串字符，每个字符代表 1 字节。格式串的长度 = 字节码的长度。

### 字符含义

| 字符 | 含义 | 例子 |
|------|------|------|
| `b` | 操作码本身（1 字节） | 每个字节码都有 |
| `c` | 有符号常量（如 bipush 的立即数） | `bipush "bc"` = 操作码 + 1 字节常量 |
| `i` | 局部变量表索引 | `iload "bi"` = 操作码 + 1 字节索引 |
| `j` | 常量池缓存索引 | `getfield "bJJ"` = 操作码 + 2 字节缓存索引 |
| `k` | 常量池索引（直接索引，不走缓存） | `ldc "bk"` = 操作码 + 1 字节 CP 索引 |
| `o` | 分支跳转偏移 | `ifeq "boo"` = 操作码 + 2 字节偏移 |
| `_` | 填充字节（忽略） | `invokeinterface "bJJ__"` 的尾部 2 字节 |
| `w` | wide 前缀 | `iload` 的 wide 形式 `"wbii"` |

### 大写 = native 字节序

字符有大小写之分。**小写**表示 Java big-endian（class 文件原始形式），**大写**表示 native 字节序（JVM 改写后的形式）。

什么是"字节序"？Java class 文件用 big-endian（大端序）存储多字节数值——高位字节在前。但 x86 CPU 用 little-endian（小端序）——低位字节在前。如果 JVM 每次读操作数都要做字节翻转，有性能开销。

所以 JVM 在类加载时（通过 Rewriter）把某些字节码的操作数从 Java big-endian 改成 native little-endian，这样运行时直接读不用翻转。格式串里用**大写字母**标记这些已被改写的字段：

- `j` = CP cache 索引，Java big-endian（未改写）
- `J` = CP cache 索引，native 字节序（已改写）

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
| `tableswitch` | `""` | 变长 | 运行时计算长度 |
| `lookupswitch` | `""` | 变长 | 运行时计算长度 |

注意 `getfield` 用大写 `J`（native 字节序），`ldc` 用小写 `k`（Java 字节序）——因为 Rewriter 会改写 getfield 的操作数但不改写 ldc 的（ldc 的改写走另一条路径）。

---

## _lengths[]：一个字节存两个长度

有些字节码有 wide 形式——用 `wide` 前缀扩展操作数宽度。比如 `iload` 普通形式 2 字节（`"bi"`），wide 形式 4 字节（`"wbii"`）。

`_lengths[]` 是 `u_char`（8 位）数组，每个字节码占 1 字节——但一个字节码有两个长度（普通 + wide），怎么塞进 1 字节？

**低 4 位存普通长度，高 4 位存 wide 长度**：

```cpp
// bytecodes.cpp:174
_lengths[code] = (wlen << 4) | (len & 0xF);
```

以 `iload` 为例：普通长度 2，wide 长度 4：

```
_lengths[_iload] = (4 << 4) | (2 & 0xF) = 0x42
                                             ^^ 低 4 位 = 2（普通）
                                           ^^   高 4 位 = 4（wide）
```

读取时取低 4 位或高 4 位：

```cpp
static int length_for     (Code code) { return _lengths[code] & 0xF; }  // 普通长度
static int wide_length_for(Code code) { return _lengths[code] >> 4;  }  // wide 长度
```

因为字节码最长 6 字节，4 位（0-15）够用。

---

## _flags[]：格式信息双页结构

`_flags[]` 是 `jchar`（16 位）数组，大小 **512**——比其他表大。为什么要 512？因为要分两页存普通和 wide 两种格式：

- **第一页**（索引 0-255）：普通格式的 flags
- **第二页**（索引 256-511）：wide 格式的 flags

```cpp
// bytecodes.cpp:179-180
_flags[code + 0*256] = compute_flags(format,      bc_flags);  // 普通页
_flags[code + 1*256] = compute_flags(wide_format, bc_flags);  // wide 页
```

`compute_flags()` 函数解析格式串，把字符转成 flag 位。比如 `"bJJ"` 会生成：`_fmt_not_variable | _fmt_has_j | _fmt_has_u2 | _fmt_has_nbo`。

### 16 个 flag 位

```cpp
/* === src/hotspot/share/interpreter/bytecodes.hpp:310-336 === */

// 语义标志（由 def() 参数传入）：
_bc_can_trap      = 1<<0,    // 可能抛异常（如 getfield 可能 NPE）
_bc_can_rewrite   = 1<<1,    // 会被改写（fast 变体标记）

// 格式位（由格式串派生）：
_fmt_has_c        = 1<<2,    // 含有符号常量（bipush "bc"）
_fmt_has_j        = 1<<3,    // 含 CP cache 索引（getfield "bJJ"）
_fmt_has_k        = 1<<4,    // 含 CP 索引（ldc "bk"）
_fmt_has_i        = 1<<5,    // 含局部变量索引（iload "bi"）
_fmt_has_o        = 1<<6,    // 含分支偏移（ifeq "boo"）
_fmt_has_nbo      = 1<<7,    // 操作数是 native 字节序（大写字母）
_fmt_has_u2       = 1<<8,    // 含 2 字节字段（连续 2 个相同字符）
_fmt_has_u4       = 1<<9,    // 含 4 字节字段（连续 4 个相同字符）
_fmt_not_variable = 1<<10,   // 非变长（定长指令）
_fmt_not_simple   = 1<<11,   // 非简单（wide 或变长）
```

这些 flag 位让解释器和 JIT 编译器快速判断字节码的格式特征——比如查 `_fmt_has_nbo` 知道要不要用 native 字节序读，查 `_fmt_has_j` 知道操作数是 CP cache 索引还是原始 CP 索引。

---

## Bytecodes（复数）和 Bytecode（单数）

现在讲一个容易混淆的点：有两个名字几乎一样的类。

**`Bytecodes`（复数）**——就是上面讲的"字典"，`AllStatic` 纯静态工具类，持有 6 张静态表。`bytecodes_init()` 初始化的就是它。

**`Bytecode`（单数）**——运行时解析某条具体字节码的栈上对象。它持有 `_bcp`（字节码指针，指向字节码字节流的某个位置）和 `_code`（当前字节码编号），提供类型安全的读取方法。

| | Bytecodes（复数） | Bytecode（单数） |
|---|---|---|
| 性质 | 静态工具类 | 栈上对象 |
| 持有什么 | 6 张全局静态表 | `_bcp` 指针 + `_code` 字节码编号 |
| 做什么 | **声明**所有字节码的格式 | **解析**某条具体的字节码 |
| 何时用 | 启动时初始化一次 | 运行时每次解析字节码 |

**一句话：Bytecodes 是字典，Bytecode 是读者**。

### 11 个 Bytecode 子类

`Bytecode` 基类提供通用的字节读取方法。11 个子类按字节码类型分组，每个子类对应一类字节码，提供类型安全的访问方法：

```
Bytecode (基类)
├── Bytecode_invoke          // invokevirtual/special/static/interface/dynamic
├── Bytecode_field           // getfield/putfield/getstatic/putstatic
├── Bytecode_checkcast       // checkcast
├── Bytecode_instanceof      // instanceof
├── Bytecode_new             // new
├── Bytecode_multianewarray  // multianewarray
├── Bytecode_anewarray       // anewarray
├── Bytecode_loadconstant    // ldc/ldc_w/ldc2_w
├── Bytecode_lookupswitch    // lookupswitch（变长）
├── Bytecode_tableswitch     // tableswitch（变长）
└── Bytecode_member_ref      // 中间基类（invoke 和 field 的公共逻辑）
```

比如 `Bytecode_invoke`（`bytecode.hpp:204`）提供 `static_target()`（解析目标方法）、`has_receiver()`（是否有 receiver）等方法。运行时代码这样用：

```cpp
Bytecode_invoke invoke(method, bci);          // 构造，_code = _invokevirtual
methodHandle callee = invoke.static_target(); // 解析目标方法
```

`static_target()` 内部调 `index()` 读取操作数——按 `Bytecodes` 表里 `"bJJ"` 声明的格式，用 native 字节序读 2 字节 CP cache 索引。**字典声明格式，读者按格式读**——两者通过 `_flags[]` 的 flag 位串起来。

---

## Rewriter 改写：把 class 文件字节码改成运行时字节码

现在讲最后一块——Rewriter。它是连接 `Bytecodes`（声明）和 `Bytecode`（读取）的关键。

### 为什么要改写

class 文件里的字节码是"未解析形式"——操作数是**原始常量池索引**（Java big-endian）。但运行时用**常量池缓存索引**（ConstantPoolCache）更快——缓存里已经存好了解析结果（字段的偏移量、方法入口等），不用每次都查常量池解析。

所以 JVM 在类加载的**链接阶段**（验证之后、首次执行之前）运行 Rewriter，把字节码操作数从"原始 CP 索引 + Java 字节序"改成"CP cache 索引 + native 字节序"。

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

操作码不变（仍是 `0xB4`），但 2 字节操作数从 Java 序变成 native 序，数值从 CP 索引变成 CP cache 索引。这正好对应格式串 `"bJJ"` 的大写 J——native 字节序的 CP cache 索引。

### fast 变体：运行时进一步加速

除了 Rewriter 的 CP 索引改写，还有一类改写是**运行时模板表**做的——把标准字节码替换成 fast 变体，按类型特化加速：

| 原字节码 | fast 变体 | 加速什么 |
|---------|----------|---------|
| `getfield`（对象类型） | `fast_agetfield` | 跳过运行时类型判断 |
| `getfield`（int 类型） | `fast_igetfield` | 跳过运行时类型判断 |
| `putfield`（对象类型） | `fast_aputfield` | 跳过运行时类型判断 |
| `invokevirtual`（final） | `fast_invokevfinal` | 跳过虚方法分派 |
| `ldc`（引用类型） | `fast_aldc` | 直接指向 resolved references |
| `lookupswitch` | `fast_linearswitch`/`fast_binaryswitch` | 按 pairs 数选算法 |
| `aload_0` + 后续 | `fast_aload_0`/`fast_iaccess_0` | 合并两条指令减少分派 |
| `return`（Object.<init>） | `return_register_finalizer` | 注册 finalizer |

这 36 个 fast 变体不出现在 class 文件里，是 JVM 内部字节码（码值 203-238），在 `Bytecodes::initialize()` 里也有对应的 `def()` 声明。

### nofast 变体：CDS 的只读保护

CDS（Class Data Sharing）把类的字节码归档到共享文件，运行时 mmap 到只读段。如果运行时还要改写字节码（改成 fast 变体），会触发对只读段的写操作——段错误。

解决方案：CDS dump 时把 `_getfield`/`_putfield`/`_aload_0`/`_iload` 改成 `_nofast_*` 版本。`_nofast_*` 执行时走和原版完全相同的逻辑，但**永不调 `patch_bytecode`**——字节码保持不变，ConstMethod 可以安全放在只读段。

---

## 小结

`bytecodes_init()` 做的事很简单——调 `Bytecodes::initialize()`，通过 239 次 `def()` 调用把所有字节码的元信息填进 6 张静态表：

| 表 | 存什么 |
|----|--------|
| `_name[]` | 字节码名字 |
| `_result_type[]` | 栈顶类型 |
| `_depth[]` | 栈深度变化 |
| `_lengths[]` | 指令长度（低 4 位普通，高 4 位 wide） |
| `_java_code[]` | fast 变体对应的 Java 标准字节码 |
| `_flags[]` | 格式信息（双页 512 个，普通 + wide） |

这套表是后续解释器、JIT 编译器、字节码验证器的基础——它们都靠查这些表知道每个字节码的格式和行为。

`bytecodes_init` **不**负责：
- 创建字节码实例（`Bytecode` 子类是运行时按需构造的栈上对象）
- 改写字节码流（Rewriter 在类加载时做，模板表在运行时做）
- 生成模板表（`templateTable_init()` 在后续 `init.cpp:120` 做）

下一节（4.4）讲 `classLoader_init1()` 的边界——它只有 3 行，但要讲清楚它**不**初始化 ClassLoaderData（那在 `universe_init` 里），以及 `os_init_globals` 是个空 hook。
