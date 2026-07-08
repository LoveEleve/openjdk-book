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

`javac` 编译后生成 `HelloWorld.class`，427 字节。这个文件里存了什么？

### ClassFile 结构

JVM 规范（JVMS §4.1）定义了 class 文件的格式——一个 `ClassFile` 结构：

```
ClassFile {
    u4             magic;                  // 魔数
    u2             minor_version;          // 次版本号
    u2             major_version;          // 主版本号
    u2             constant_pool_count;    // 常量池项数
    cp_info        constant_pool[];        // 常量池
    u2             access_flags;           // 访问标志
    u2             this_class;             // 本类
    u2             super_class;            // 父类
    u2             interfaces_count;       // 接口数
    u2             interfaces[];           // 接口表
    u2             fields_count;           // 字段数
    field_info     fields[];               // 字段表
    u2             methods_count;          // 方法数
    method_info    methods[];              // 方法表
    u2             attributes_count;       // 属性数
    attribute_info attributes[];           // 属性表
}
```

`u4` 是 4 字节无符号整数，`u2` 是 2 字节。class 文件就是按这个顺序依次存储的。HelloWorld.class 对应每个字段的值：

| 字段 | 类型 | HelloWorld 的值 | 含义 |
|------|------|-----------------|------|
| `magic` | u4 | `0xCAFEBABE` | 魔数，标识这是 class 文件 |
| `minor_version` | u2 | `0` | 次版本号 |
| `major_version` | u2 | `55` | 主版本号 55 = JDK 11 |
| `constant_pool_count` | u2 | `29` | 28 项常量 + 1（从 1 开始计数） |
| `constant_pool[]` | 变长 | 28 项 | 类名/方法名/字段名/字符串常量等 |
| `access_flags` | u2 | `0x0021` | `ACC_PUBLIC \| ACC_SUPER` |
| `this_class` | u2 | `#5` | 指向常量池第 5 项 = HelloWorld |
| `super_class` | u2 | `#6` | 指向常量池第 6 项 = java/lang/Object |
| `interfaces_count` | u2 | `0` | 无接口 |
| `fields_count` | u2 | `0` | 无字段 |
| `methods_count` | u2 | `2` | 两个方法：`<init>` 和 `main` |
| `attributes_count` | u2 | `1` | 一个类级属性：SourceFile |

### 二进制对照

用 hexdump 看 class 文件的二进制，对照上面的结构：

```
偏移   二进制                              字段
0x0000 cafe babe                           magic = 0xCAFEBABE
0x0004 0000                                minor_version = 0
0x0006 0037                                major_version = 55 (JDK 11)
0x0008 001d                                constant_pool_count = 29 (28项+1)
0x000a 0a 0006 000f 09 0010 0011 ...       constant_pool[1..28] (0x0a-0x136)
       ...                                 (常量池存了 Object.<init>、System.out、
       ...                                  "Hello, World!"、println 等引用)
0x0137 0021                                access_flags = ACC_PUBLIC|ACC_SUPER
0x0139 0005                                this_class = #5 (HelloWorld)
0x013b 0006                                super_class = #6 (Object)
0x013d 0000                                interfaces_count = 0
0x013f 0000                                fields_count = 0
0x0141 0002                                methods_count = 2
0x0143 ...                                 methods[0]: <init>
0x016e ...                                 methods[1]: main
0x01a9 0001 000d                           attributes_count=1, SourceFile
```

**字节码在 `methods[]` 里**——每个方法的 `method_info` 结构含一个 `Code` 属性，Code 属性里存着该方法的字节码。所以**字节码只是 class 文件的一部分**，不是全部。

### 两个方法的字节码

HelloWorld 有两个方法，每个方法的 Code 属性里存着字节码：

**方法 1：`<init>`（构造方法）**——5 字节字节码，在文件偏移 0x0159：

```
2a       aload_0          // 把 this 压入栈
b7 0001  invokespecial #1 // 调用 Object.<init>()
b1       return           // 返回
```

**方法 2：`main`**——9 字节字节码，在文件偏移 0x0184：

```
b2 0002  getstatic #2     // 取 System.out（常量池第 2 项）
12 03    ldc #3           // 加载 "Hello, World!"（常量池第 3 项）
b6 0004  invokevirtual #4 // 调用 println（常量池第 4 项）
b1       return           // 返回
```

操作数里的 `#2`/`#3`/`#4` 是**常量池索引**——指向常量池里的 Fieldref（System.out）、String（"Hello, World!"）、Methodref（println）。

> **常量池是什么？** 常量池是 class 文件里的一张"符号表"——存了类名、方法名、字段名、字符串常量等。字节码不直接写 "System.out" 这样的名字，而是写一个索引 #2，指向常量池第 2 项。运行时 JVM 查常量池才知道 #2 是 "java/lang/System.out"。常量池在 JVM 内部有完整的实现（`ConstantPool` 类、`ConstantPoolCache` 类等），后续在讲 universe_init 的章节（ClassLoaderData 部分）和讲符号表的章节（SymbolTable + StringTable）会单独展开，本节只需要知道"字节码操作数是常量池索引"即可。

### JVM 执行字节码时需要知道什么

每条字节码由**操作码**（opcode，1 字节）+ **操作数**（0-N 字节）组成。JVM 解释器执行 `getstatic #2` 时，要回答几个问题：

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

参数含义（按位置对应，实际调用不写参数名）：

| 位置 | 参数 | 含义 | getfield 的值 |
|------|------|------|--------------|
| 1 | `code` | 字节码编号（`Bytecodes::Code` 枚举值，如 `_getfield = 180` 对应 `0xB4`） | `_getfield` |
| 2 | `name` | 名字字符串 | `"getfield"` |
| 3 | `format` | **格式串**（描述内存布局） | `"bJJ"` |
| 4 | `wide_format` | wide 形式格式串 | `NULL`（getfield 无 wide 形式） |
| 5 | `result_type` | **执行后栈顶元素的类型**（不是方法返回值类型——是这条字节码执行完后操作数栈顶放的是什么类型的东西；当类型不能仅由字节码本身决定时设为 `T_ILLEGAL`，如 getfield 取出的字段类型取决于字段声明） | `T_ILLEGAL` |
| 6 | `depth` | 执行后栈深度的变化量 | `0` |
| 7 | `can_trap` | 能否抛异常 | `true`（可能 NPE） |
| 8 | `java_code` | 对应的 Java 标准字节码（JVM 内部 fast 变体才需要，标准字节码默认等于自己） | `_getfield`（自己） |

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

### 所有格式串全览

从 `bytecodes.cpp` 的 239 个 `def()` 调用中提取，实际只有 **19 种不同的格式串组合**。每种格式串对应一类字节码的内存布局：

#### 1 字节：`"b"` —— 仅操作码

| 格式串 | 含义 | 对应字节码 |
|--------|------|-----------|
| `"b"` | 只有操作码，无操作数 | `nop`、`iconst_1`、`aload_0`、`return`、`areturn` 等大部分单字节指令 |

字节码示例：`b1` = return，1 字节。

#### 2 字节：`"bc"` / `"bk"` / `"bi"` / `"bj"`

| 格式串 | 含义 | 对应字节码 |
|--------|------|-----------|
| `"bc"` | 操作码 + 1 字节有符号常量 | `bipush`（压入立即数）、`newarray`（数组类型） |
| `"bk"` | 操作码 + 1 字节常量池索引 | `ldc`（加载常量，索引 0-255） |
| `"bi"` | 操作码 + 1 字节局部变量索引 | `iload`、`istore`、`aload`、`ret`（索引 0-255） |
| `"bj"` | 操作码 + 1 字节 CP cache 索引 | `fast_aldc`（JVM 内部 ldc 加速版） |

字节码示例：`bipush 42` = `10 2a`（0x10=bipush，0x2a=42），2 字节。

#### 3 字节：`"bcc"` / `"bkk"` / `"bJJ"`

| 格式串 | 含义 | 对应字节码 |
|--------|------|-----------|
| `"bcc"` | 操作码 + 2 字节有符号常量 | `sipush`（压入短整数） |
| `"bkk"` | 操作码 + 2 字节常量池索引 | `ldc_w`、`ldc2_w`、`new`、`checkcast`、`getstatic`、`invokestatic` 等 |
| `"bJJ"` | 操作码 + 2 字节 native CP cache 索引 | `getfield`、`putfield`、`invokevirtual`、`invokespecial`、`fast_*getfield` 等 |

字节码示例：
- `sipush 1000` = `11 03 e8`（0x11=sipush，0x03e8=1000），3 字节
- `getfield #2` = `b4 00 02`（class 文件原始形式，Java big-endian），3 字节
- `getfield #3` = `b4 03 00`（Rewriter 改写后，native little-endian），3 字节

**`"bkk"` 和 `"bJJ"` 的区别**：`bkk` 用小写 k（常量池索引，Java 字节序，未被 Rewriter 改写）；`bJJ` 用大写 J（CP cache 索引，native 字节序，已被 Rewriter 改写）。`getstatic`/`invokestatic` 用 `bkk`（不走 CP cache），`getfield`/`invokevirtual` 用 `bJJ`（走 CP cache）。

#### 4 字节：`"boooo"` / `"bkkc"` / `"b_JJ"` / `"bi_i"` / `"bi_"` / `"wbiicc"`

| 格式串 | 含义 | 对应字节码 |
|--------|------|-----------|
| `"boooo"` | 操作码 + 4 字节分支偏移 | `goto_w`（宽跳转）、`jsr_w` |
| `"bkkc"` | 操作码 + 2 字节 CP 索引 + 1 字节维数 | `multianewarray` |
| `"b_JJ"` | 操作码 + 1 填充字节 + 2 字节 native CP cache 索引 | `fast_iaccess_0` 等（aload_0 + getfield 合并） |
| `"bi_i"` | 操作码 + 1 字节索引 + 1 填充 + 1 字节索引 | `fast_iload2`（iload + iload 合并） |
| `"bi_"` | 操作码 + 1 字节索引 + 1 填充字节 | `fast_icaload`（iload + caload 合并） |
| `"wbiicc"` | wide 前缀 + 操作码 + 1 字节索引 + 1 字节常量 | `iinc` 的 wide 形式 |

字节码示例：`goto_w 100` = `c8 00 00 00 64`（0xc8=goto_w，0x00000064=100），5 字节。

#### 5 字节：`"bJJJJ"` / `"bJJ__"`

| 格式串 | 含义 | 对应字节码 |
|--------|------|-----------|
| `"bJJJJ"` | 操作码 + 4 字节 native CP cache 索引 | `invokedynamic` |
| `"bJJ__"` | 操作码 + 2 字节 native CP cache 索引 + 1 字节 count + 1 字节 0 | `invokeinterface` |

字节码示例：`invokedynamic #5` = `ba 00 00 00 05`（4 字节索引），5 字节。

`invokedynamic` 为什么用 4 字节索引而不是 2 字节？因为它每个调用点需要一个独立的 CP cache entry（不是共享的），2 字节索引不够用。

#### wide 形式：`"wbii"` / `"wbiicc"`

| 格式串 | 含义 | 对应字节码 |
|--------|------|-----------|
| `"wbii"` | wide 前缀 + 操作码 + 2 字节局部索引 | `iload`/`istore`/`aload`/`astore`/`lload` 等 wide 形式 |
| `"wbiicc"` | wide 前缀 + 操作码 + 2 字节索引 + 2 字节常量 | `iinc` 的 wide 形式 |

字节码示例：`wide iload 300` = `c4 15 01 2c`（0xc4=wide，0x15=iload，0x012c=300），4 字节。

wide 形式把 1 字节局部变量索引扩展为 2 字节，支持超过 255 个局部变量的方法。

#### 变长：`""`（空字符串）

| 格式串 | 含义 | 对应字节码 |
|--------|------|-----------|
| `""` | 变长指令，长度运行时计算 | `tableswitch`、`lookupswitch`、`wide`、`breakpoint` |

`tableswitch` 的内存布局：
```
[opcode] [0-3 字节对齐填充] [default: 4字节] [low: 4字节] [high: 4字节] [offset_0, offset_1, ..., offset_(high-low)]
```
长度 = 1 + 对齐填充 + (3 + high - low + 1) × 4，运行时才知道有多少个 case。

#### 对照 HelloWorld 的 4 条字节码

回到前面的 HelloWorld main 方法，4 条字节码的格式串：

| 字节码 | 二进制 | 格式串 | 格式解读 |
|--------|--------|--------|---------|
| `getstatic #2` | `b2 00 02` | `"bJJ"` | b=getstatic, JJ=native CP cache 索引 #2 |
| `ldc #3` | `12 03` | `"bk"` | b=ldc, k=常量池索引 #3 |
| `invokevirtual #4` | `b6 00 04` | `"bJJ"` | b=invokevirtual, JJ=native CP cache 索引 #4 |
| `return` | `b1` | `"b"` | b=return，无操作数 |

注意：class 文件原始形式里 `getstatic` 的操作数是 `00 02`（Java big-endian 的 CP 索引 #2），Rewriter 改写后变成 native little-endian 的 CP cache 索引。`ldc` 的 `k` 仍是 Java 字节序的 CP 索引（因为 ldc 的改写走另一条路径，改成 `fast_aldc`）。

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


> **Bytecode 子类、Rewriter 改写、fast/nofast 变体不在本节展开**——它们都是运行时的事，不属于 init_globals 阶段：
>
> - **Bytecode 子类体系**（11 个子类，运行时按需构造的栈上解析器）——在解释器章节展开
> - **Rewriter 改写**（类加载时把 CP 索引改成 CP cache 索引 + native 字节序）——在类加载章节展开
> - **fast/nofast 变体**（36 个 JVM 内部字节码，Rewriter/模板表改写的产物）——跟着 Rewriter 走
>
> 本节聚焦 bytecodes_init 做的事：启动时填 6 张静态表。
## 小结

`bytecodes_init()` 做的事很简单——调 `Bytecodes::initialize()`，通过 239 次 `def()` 调用把所有字节码的元信息填进 6 张静态表：

| 表 | 存什么 |
|----|--------|
| `_name[]` | 字节码名字 |
| `_result_type[]` | 执行后栈顶元素类型 |
| `_depth[]` | 栈深度变化 |
| `_lengths[]` | 指令长度（低 4 位普通，高 4 位 wide） |
| `_java_code[]` | JVM 内部字节码对应的 Java 标准字节码 |
| `_flags[]` | 格式信息（双页 512 个，普通 + wide） |

这套表是后续解释器、JIT 编译器、字节码验证器的基础——它们都靠查这些表知道每个字节码的格式和行为。

`bytecodes_init` **不**负责：
- 创建字节码实例（`Bytecode` 子类是运行时按需构造的栈上对象）
- 改写字节码流（Rewriter 在类加载时做，模板表在运行时做）
- 生成模板表（`templateTable_init()` 在后续 `init.cpp:120` 做）

下一节（4.4）讲 `classLoader_init1()` 的边界——它只有 3 行，但要讲清楚它**不**初始化 ClassLoaderData（那在 `universe_init` 里），以及 `os_init_globals` 是个空 hook。
