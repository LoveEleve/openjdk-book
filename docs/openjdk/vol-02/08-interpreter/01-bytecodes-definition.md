# 01. 一条字节码的"档案"在哪？— Bytecode 定义表

> **前置依赖**:[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):方法体的字节码从 ClassFile 进入 Method,这一篇解决"这些字节是什么";[24-frame/01 — Physical Frame](openjdk/vol-02/24-frame/01-physical-frame.md):解释器帧的 bcp 寄存器、per-Klass 的 oopMapCache 都是本篇表格的消费者;[24-frame/03 — Deopt 重建 + GC 扫描](openjdk/vol-02/24-frame/03-deopt-gc-scan.md):按 bci 选解释器入口重建帧,前提是先知道每条指令有多长
> → **后续**:[08-interpreter/02 — 字节码→x86 机器码](02-template-interpreter.md):定义表只是"档案",下一篇看每条字节码怎么被翻译成 x86 机器码
> 关联域: 24-frame(deopt/栈图)、16-code-cache(解释器代码的载体)、07-classfile(方法体来源)

## 一条指令,VM 需要知道四件事

`javap -c` 把方法体打印成带偏移的助记符行——`0: iconst_0`、`1: istore_1`、`4: iload_2`……但 JVM 运行时看到的只是一串裸字节: `03 3a 1c 1a`。从裸字节到"这条指令叫什么、后面还跟着几个字节、执行后栈深怎么变、会不会抛异常",VM 需要一个查得到的地方。这一篇拆的就是这个地方: `bytecodes.hpp/cpp` 里那张 239 个已定义成员的静态定义表。

[实证:] 用 javac 编一个覆盖常量/局部变量/算术/分支/switch/新建/调用/数组的方法集,`javap -c` 反汇编后把每条指令的偏移差与源码定义表逐条核对(materials/commands/08-bytecodes-javap.txt,OpenJDK 11 Temurin 11.0.32): 76 条固定长度指令的实测长度全部与定义表一致——这正是本篇要拆的机制;而唯一一条对不上的 `lookupswitch`,它的长度是运行时才算的,原因在本篇第四节。

## 1. Code 枚举: opcode 就是下标

### 203 个枚举成员 + 36 条私有指令

字节码的目录从枚举开始(bytecodes.hpp:38-39,截取核心,逐字):

```cpp
// bytecodes.hpp:38-39(截取核心,逐字)
  enum Code {
    _illegal              =  -1,
```

从 `_nop = 0` 到 `_breakpoint = 202`(0x00-0xCA)共 203 个枚举成员,把 JVM 规范里保留给实现者的 `wide`(0xC4)与 `breakpoint`(0xCA)也列了进来;规范在 0xCB-0xFF 预留的未分配区里,HotSpot 只用了 0xCB-0xEE(私有 fast 系列,见下),**0xEF-0xFF 共 17 个值不定义**,方法体里出现即非法。`number_of_java_codes` 是第一个哨兵(bytecodes.hpp:246)。这之后是 HotSpot 私有的"重写"字节码(bytecodes.hpp:249-303),共 36 条: 29 条 `_fast_*`(getfield/putfield 各 8 个类型版本、access 快捷、线性/二分 switch、`fast_aldc` 等)+ `_return_register_finalizer` + `_invokehandle` + 4 条 `_nofast_*` + `_shouldnotreachhere`;第二个哨兵 `number_of_codes` 在 :306。启动断言 `number_of_codes <= 256`(bytecodes.cpp:280)——枚举值必须全部塞进一个字节,因为运行时取指令就是 `(Code)*bcp`。

**关键设计 (斜体)**: *枚举值 = opcode 值本身,不是分开的两套编号——"名字 → 字节"是恒等映射。这是后面所有表的下标规则: `_name[_iload]` 就是 `_name[21]`。*

### code_at: 从字节到 Code,还要揭开 breakpoint 的伪装

`code_at(method, bcp)`(bytecodes.hpp:369-374)取 `*bcp` 一个字节转成 Code;但调试器把断点字节 `_breakpoint`(0xCA)覆盖进方法体后,原始指令被挪到 Method 的 `orig_bytecode_at` 里——`code_at` 检测到 breakpoint 就调用 `non_breakpoint_code_at`(bytecodes.cpp:84-88)去原表取真身,所以**迭代器永远看不到断点**。注释明确说 CI 用 `code_at(NULL, bcp)` 直接取,因为编译器扫描的代码不可能有断点。

## 2. 六张表,没有 format 表

### 声明

所有属性是六条静态数组(bytecodes.hpp:339-346,截取核心,逐字):

```cpp
// bytecodes.hpp:339-346(截取核心,逐字)
  static bool        _is_initialized;
  static const char* _name          [number_of_codes];
  static BasicType   _result_type   [number_of_codes];
  static s_char      _depth         [number_of_codes];
  static u_char      _lengths       [number_of_codes];
  static Code        _java_code     [number_of_codes];
  static jchar       _flags         [(1<<BitsPerByte)*2]; // all second page for wide formats
```

`_name` 助记符、`_result_type` 栈顶结果类型、`_depth` 栈深变化、`_lengths` 长度、`_java_code` 重写前的原始指令、`_flags` 位标志。注意三点:

- **没有 `_format` 数组**。大纲/规划里常写的"format 表"不存在——格式字符串在初始化时被 `compute_flags` 预编译成 `_flags` 里的位组合(第三节),运行时查的是位而不是字符串。
- `_lengths` 一个字节塞两个长度: 低 4 位是短格式长度,高 4 位是 wide 格式长度(`length_for` = `_lengths[code] & 0xF`,`wide_length_for` = `_lengths[code] >> 4`,bytecodes.hpp:397-398)。`goto_w` 有 5 个字符("boooo"),低 4 位最大 15,放得下。
- `_flags` 是 512 槽的双页结构: 低 256 槽存普通格式的 flags,高 256 槽(下标 +256)存 wide 格式的 flags(`flags(code, is_wide)` 按 is_wide 选页,bytecodes.hpp:432-435)。

### def: 一条记录语句,六个下标赋值

这些数组不是用大括号静态初始化,而是启动时由 `Bytecodes::initialize()`(bytecodes.cpp:278)逐条 `def()` 填充。def 的实现(bytecodes.cpp:167-185,截取核心,逐字):

```cpp
// bytecodes.cpp:167-185(截取核心,逐字)
void Bytecodes::def(Code code, const char* name, const char* format, const char* wide_format, BasicType result_type, int depth, bool can_trap, Code java_code) {
  assert(wide_format == NULL || format != NULL, "short form must exist if there's a wide form");
  int len  = (format      != NULL ? (int) strlen(format)      : 0);
  int wlen = (wide_format != NULL ? (int) strlen(wide_format) : 0);
  _name          [code] = name;
  _result_type   [code] = result_type;
  _depth         [code] = depth;
  _lengths       [code] = (wlen << 4) | (len & 0xF);
  _java_code     [code] = java_code;
  int bc_flags = 0;
  if (can_trap)           bc_flags |= _bc_can_trap;
  if (java_code != code)  bc_flags |= _bc_can_rewrite;
  _flags[(u1)code+0*(1<<BitsPerByte)] = compute_flags(format,      bc_flags);
  _flags[(u1)code+1*(1<<BitsPerByte)] = compute_flags(wide_format, bc_flags);
  assert(is_defined(code)      == (format != NULL),      "");
  assert(wide_is_defined(code) == (wide_format != NULL), "");
  assert(length_for(code)      == len, "");
  assert(wide_length_for(code) == wlen, "");
}
```

参数顺序是 (code, name, format, wide_format, result_type, depth, can_trap, java_code),另一个 7 参数重载(bytecodes.cpp:162-164)只是让 `java_code = code`——"我自己就是原始指令"。`format` 为 NULL 表示该指令不存在这一形态(`is_defined(code) == (format != NULL)`,bytecodes.hpp:390);`wide_format` 为 NULL 表示没有 wide 版。每条 def 末尾还有四句断言把写进去的值立刻读回来——表是手写的,启动时靠断言自检。

实际表长这样(bytecodes.cpp:294-299,截取核心,逐字):

```cpp
// bytecodes.cpp:294-299(截取核心,逐字)
  def(_nop                 , "nop"                 , "b"    , NULL    , T_VOID   ,  0, false);
  def(_aconst_null         , "aconst_null"         , "b"    , NULL    , T_OBJECT ,  1, false);
  def(_iconst_m1           , "iconst_m1"           , "b"    , NULL    , T_INT    ,  1, false);
  def(_iconst_0            , "iconst_0"            , "b"    , NULL    , T_INT    ,  1, false);
  def(_iconst_1            , "iconst_1"            , "b"    , NULL    , T_INT    ,  1, false);
  def(_iconst_2            , "iconst_2"            , "b"    , NULL    , T_INT    ,  1, false);
```

**关键设计 (斜体)**: *`_aload_0` 在表里的 can_trap 是 true(bytecodes.cpp:336,注释 "rewriting in interpreter")——它的模板会按下一个字节把指令本身 patch 成 `_fast_aload_0`/`_fast_*access_0`(templateTable_x86.cpp:973),trap 位不是单纯的"会不会抛异常"。这类细节只能逐条写在 def 里,所以注释才说"didn't use static array initializers ... so we can do additional consistency checks and init-code is independent of actual bytecode numbering"(bytecodes.cpp:282-284)。*

## 3. format 字符串: 指令布局的语言

### 七个字母定义全部操作数形态

格式字符串写在 def 调用的第三、四参数里,它的语法在源码注释里一次性讲清(bytecodes.cpp:188-204,截取核心,逐字):

```cpp
// bytecodes.cpp:188-204(截取核心,逐字)
// Format strings interpretation:
//
// b: bytecode
// c: signed constant, Java byte-ordering
// i: unsigned local index, Java byte-ordering (I = native byte ordering)
// j: unsigned CP cache index, Java byte-ordering (J = native byte ordering)
// k: unsigned CP index, Java byte-ordering
// o: branch offset, Java byte-ordering
// _: unused/ignored
// w: wide bytecode
//
// Note: The format strings are used for 2 purposes:
//       1. to specify the length of the bytecode
//          (= number of characters in format string)
//       2. to derive bytecode format flags (_fmt_has_k, etc.)
//
// Note: For bytecodes with variable length, the format string is the empty string.
```

关键规则: **`b` 是 opcode 本身**,后面每个字母代表一个操作数,指令长度 = 字符串字符数;字母大小写表示字节序——小写是 Java 字节序(大端),大写是原生字节序(小端),那是 Rewriter 重写过的痕迹(08-04 的 `rewrite_member_reference` 把 CP 索引换成 cpCache 索引并翻转字节序)。对照真实指令:

| 指令 | format | 长度 | 操作数含义 |
|---|---|---|---|
| `bipush` | `bc` | 2 | c = 1 字节有符号常量 |
| `sipush` | `bcc` | 3 | cc = 2 字节有符号常量 |
| `iload`/`istore` | `bi` | 2 | i = 1 字节局部变量下标 |
| `iinc` | `bic` | 3 | i = 下标,c = 增量(bytecodes.cpp:426) |
| `ifeq`…`ifle` | `boo` | 3 | oo = 2 字节分支偏移(bytecodes.cpp:447-452) |
| `goto_w` | `boooo` | 5 | oooo = 4 字节分支偏移(bytecodes.cpp:494) |
| `getfield` | `bJJ` | 3 | JJ = 2 字节原生序 cpCache 下标(bytecodes.cpp:474) |
| `invokeinterface` | `bJJ__` | 5 | 2 字节 cpCache 下标 + 2 字节保留(bytecodes.cpp:479) |
| `invokedynamic` | `bJJJJ` | 5 | 4 字节 cpCache 下标(bytecodes.cpp:480) |
| `tableswitch`/`lookupswitch` | `""` | 变长 | 数据对齐 4 字节,运行时才算长度(bytecodes.cpp:464-465) |

[实证:] javap 的偏移序列就是活证据(materials/commands/08-bytecodes-javap.txt): `14: invokedynamic #11, 0` 到 `19: invokevirtual` 差 5 字节 = `bJJJJ`;`20: bipush 42` 到 `22: iastore` 差 2 字节 = `bc`;`28: iinc 2, 1` 到 `31: goto` 差 3 字节 = `bic`。

### compute_flags: 启动时把字符串编译成位掩码

`_flags` 里的位不是手填的,是 `compute_flags` 从 format 字符串推出来的(bytecodes.cpp:210-224,截取核心,逐字):

```cpp
// bytecodes.cpp:210-224(截取核心,逐字)
  switch (*fp) {
  case '\0':
    flags |= _fmt_not_simple; // but variable
    break;
  case 'b':
    flags |= _fmt_not_variable;  // but simple
    ++fp;  // skip 'b'
    break;
  case 'w':
    flags |= _fmt_not_variable | _fmt_not_simple;
    ++fp;  // skip 'w'
    guarantee(*fp == 'b', "wide format must start with 'wb'");
    ++fp;  // skip 'b'
    break;
  }
```

首字符分类定"形"(`""`=变长、`b`=简单定长、`wb`=wide 定长),随后逐字符扫: `j`/`k`/`i`/`c`/`o` 各置一个 `_fmt_has_*` 位,连续重复 2 次置 `_fmt_has_u2`、4 次置 `_fmt_has_u4`,大写置 `_fmt_has_nbo`(bytecodes.cpp:237-257);"既有大端又有小端"直接 guarantee 崩掉(bytecodes.cpp:255),操作数尺寸只允许递减到最后一个字段(bytecodes.cpp:270-273)。`_fmt_not_variable`/`_fmt_not_simple` 组合出三类形态: 简单、wide、变长。**运行时问"这条指令能不能重写/是否含偏移/有几个字节的操作数",答的都是这些位**——没有一次 lookup 是现场解析字符串的。

**关键设计 (斜体)**: *格式字符串是"源代码",位掩码是"编译产物"——initialize() 是编译器,`_flags` 是只读的机器码。把格式知识压成 16 位的原因很朴素: 字节码工具链(迭代器、栈图计算、模板生成)每处理一条指令都要查这些属性,位测试是单条与指令,字符串解析则是不可能的开销。*

## 4. 长度: 查表,但有三条指令表里没有

### 固定长度 vs 变长

`length_for(code)` 直接返回 `_lengths[code] & 0xF`——对绝大多数指令,这一步就完了。但 format 为空的指令——`wide`、`tableswitch`、`lookupswitch`——长度必须看操作数本身,走 `special_length_at`(bytecodes.cpp:90-137);`breakpoint` 不在它的 case 里(返回 0),因为普通迭代器根本见不到它——code_at 先把它伪装成原指令再查原指令的长度,只有 RawBytecodeStream(验证器用)走 `raw_special_length_at` 按 1 字节算(bytecodes.cpp:151-158):

- **`wide`**: 读第二字节,返回被修饰指令的 wide 长度(bytecodes.cpp:92-96)——`wide iload` 是 `wbii` 共 4 字节,`wide iinc` 是 `wbiicc` 共 6 字节,答案在 `_lengths` 的高 4 位里;
- **`tableswitch`**: 操作数 4 字节对齐——`align_up(bcp + 1, jintSize)`(bytecodes.cpp:98),对齐空隙不算进表索引;之后是 default/lo/hi 三个 4 字节 + `hi-lo+1` 个 4 字节跳转表,长度 = 对齐补齐 + 表主体(bytecodes.cpp:103-105);
- **`lookupswitch`**: 同样 4 字节对齐,但跳转对是稀疏的——npairs 个 (key, offset) 对,长度 = 对齐补齐 + 8 + npairs×8(bytecodes.cpp:119-124)。

对齐逻辑一上来就提升成 64 位计算(`jlong`,源码注释 "Promote calculation to signed 64 bits")——因为 `hi - lo` 可能溢出 int;`end` 参数用于"读不过代码缓冲区末尾"的越界保护(bytecodes.cpp:93-94,99-100)。

### 迭代器怎么消费: 先查表,查不到再算

`BytecodeStream::next()`(bytecodeStream.hpp:189-207)是典型消费者: 先 `code_at` 取字节 → `java_code` 归一成原始指令(重写过的 `fast_*` 一律折算回 `_getfield` 等再查属性)→ `length_for` 查固定长度;**只有查到 0(变长)才调 `length_at` 走 special_length_at**——固定长度是绝对多数,热路径永远只命中第一条(bytecodeStream.hpp:205-207)。这个迭代器是解释器之外所有字节码消费者(验证器、OopMap 计算、CI、Rewriter)的共同底座,08-04 的 Rewriter 就是逐条走它改字节的。

[实证:] `lookupswitch` 在 javap 里从 bci 1 开始(materials/commands/08-bytecodes-javap.txt,classify 方法): 操作数从 `align_up(1+1, 4) = 4` 起,4 个 case 对 + default,总长 = (4-1) + (2 + 2×4)×4 = 43 → 下一条指令在 1+43 = 44——javap 打印的下一行正是 `44: ldc`。对齐的 2 个填充字节在源码层面不可见,但偏移链证明它们存在。

## 5. 栈怎么变: 静态 depth,以及"说不准"的结果类型

### depth: 编译时就知道的栈深变化

`_depth` 是**静态值**: 每条指令执行后栈深的变化,与运行状态无关。`iload` +1、`istore` -1、`swap` 0(2 pop 2 push)、`ladd` -2(long 占 2 槽: pop 4 push 2)、`iaload` -1(pop 2 push 1)、`laload` 0(pop 2 push 2,bytecodes.cpp:341)、`lcmp` -3(bytecodes.cpp:442)。long/double 的一切都按 2 槽记: `lconst_0` +2、`lstore` -2、`lreturn` -2。类型转换按净变化记: `i2l` +1、`i2f` 0、`f2i` 0(bytecodes.cpp:427-428,433)。

调用系列是特例: `invokevirtual`/`invokespecial`/`invokeinterface` 的 depth = **-1**,`invokestatic`/`invokedynamic` = 0(bytecodes.cpp:476-480)——这只是"pop 掉 receiver"的近似,真实栈效果(参数 N 个 pop、返回 M 个 push)取决于被调方法的 descriptor,要等解析之后才拿得到,表里不记。

### result_type: T_ILLEGAL 是"说不准"

`_result_type` 记"执行后栈顶的类型",def 表里大量条目是 `T_ILLEGAL`——注释解释了这个哨兵的含义(bytecodes.cpp:289-291,截取核心,逐字):

```cpp
// bytecodes.cpp:289-291(截取核心,逐字)
  // Note 2: The result type is T_ILLEGAL for bytecodes where the top of stack
  //         type after execution is not only determined by the bytecode itself.
```

`ldc` 的结果是 int 还是引用,取决于常量池条目;`invokevirtual` 的结果类型取决于方法签名;`getfield` 取决于字段类型——这些指令自己无法决定栈顶类型,`T_ILLEGAL` 表示"去问上下文"。纯算术/压栈指令则给死类型: `iconst_*` → T_INT、`lconst_*` → T_LONG、`aload` → T_OBJECT、`i2b` → T_BYTE(bytecodes.cpp:439)。

**关键设计 (斜体)**: *"静态已知"与"上下文决定"的边界划得很清楚: depth 是执行前 100% 确定的(栈深是结构属性),result_type 经常要等解析。下一篇 02 的 tosState(栈顶类型状态)机制处理的正是这个边界——但它是模板生成期的约定,不是这张表的直接产物。*

## 6. can_trap 与 can_rewrite: 两个影响全局的位

### Flags: 语义位 + 格式位

`_flags` 的位定义在 bytecodes.hpp:310-325(截取核心,逐字):

```cpp
// bytecodes.hpp:310-325(截取核心,逐字)
  enum Flags {
    // semantic flags:
    _bc_can_trap      = 1<<0,     // bytecode execution can trap or block
    _bc_can_rewrite   = 1<<1,     // bytecode execution has an alternate form

    // format bits (determined only by the format string):
    _fmt_has_c        = 1<<2,     // constant, such as sipush "bcc"
    _fmt_has_j        = 1<<3,     // constant pool cache index, such as getfield "bjj"
    _fmt_has_k        = 1<<4,     // constant pool index, such as ldc "bk"
    _fmt_has_i        = 1<<5,     // local index, such as iload
    _fmt_has_o        = 1<<6,     // offset, such as ifeq
    _fmt_has_nbo      = 1<<7,     // contains native-order field(s)
    _fmt_has_u2       = 1<<8,     // contains double-byte field(s)
    _fmt_has_u4       = 1<<9,     // contains quad-byte field
    _fmt_not_variable = 1<<10,    // not of variable length (simple or wide)
    _fmt_not_simple   = 1<<11,    // either wide or variable length
```

前两位是语义位(由 def 参数直接设置),后面全是格式位(compute_flags 推出来的)。格式位能反推出操作数形态: `_fmt_has_j` 意味着"这条指令读 cpCache"(`uses_cp_cache`,bytecodes.hpp:404)、`_fmt_has_o` 意味着"含分支偏移"。

### can_trap: 决定"有没有异常边"

`can_trap` 不是给循环优化用的——它的真实消费者是**栈图计算**。解释器帧的 OopMap 计算器 `GenerateOopMap::do_exception_edge` 第一行就按它剪枝(generateOopMap.cpp:1177-1179,截取核心,逐字):

```cpp
// generateOopMap.cpp:1177-1179(截取核心,逐字)
  // Only check exception edge, if bytecode can trap
  if (!Bytecodes::can_trap(itr->code())) return;
```

can_trap=false 的指令(纯算术、栈操作)不可能抛异常,就不会有"异常边",异常处理器的栈图不需要为它做合并;can_trap=true 的指令(数组访问、div/rem、字段访问、invoke、new、checkcast……)运行时可抛异常,数据流分析必须把异常边上的栈状态并进异常处理器的状态,解释器的 OopMap 才能覆盖到跳进 handler 时的每个槽。这条链通到 24-01 铺垫的解释器 oopmap: `Method::mask_for` → `OopMapCache::compute_one_oop_map`(oopMapCache.cpp:597)→ `OopMapForCacheEntry`(:72,GenerateOopMap 的子类)对方法从头到尾做一遍指令流分析,中途每过一个 can_trap 点都按 do_exception_edge 合并异常边状态,最终得到每个 bci 的栈图。**can_trap 判断错了,解释器的栈图就错了**——所以 def 表末尾有断言保证重写后的指令 can_trap 是原指令的子集(bytecodes.cpp:553-563,截取核心,逐字):

```cpp
// bytecodes.cpp:553-563(截取核心,逐字)
  #ifdef ASSERT
    { for (int i = 0; i < number_of_codes; i++) {
        if (is_defined(i)) {
          Code code = cast(i);
          Code java = java_code(code);
          if (can_trap(code) && !can_trap(java))
            fatal("%s can trap => %s can trap, too", name(code), name(java));
        }
      }
    }
  #endif
```

C1 编译器并不直接用这张表——它维护自己的 `_can_trap` 数组,且刻意从清单里剔除了 return/monitorexit 等(c1_GraphBuilder.cpp:2976-3034,注释: "monitor pairing proved that they succeed")。ciTypeFlow 则复用 `Bytecodes::can_trap` 再叠加自己的特例(ciTypeFlow.cpp:2171)。

### can_rewrite: 有"快速形态"的指令

`_bc_can_rewrite` 由 def 自动设置:`java_code != code` 时置位(bytecodes.cpp:178)——即"我有另一个形态"。fast 系列与原始指令的对应关系都记在 `_java_code` 数组里(bytecodes.cpp:501-546,截取核心,逐字):

```cpp
// bytecodes.cpp:501-502(截取核心,逐字)
  def(_fast_agetfield      , "fast_agetfield"      , "bJJ"  , NULL    , T_OBJECT ,  0, true , _getfield       );
  def(_fast_bgetfield      , "fast_bgetfield"      , "bJJ"  , NULL    , T_INT    ,  0, true , _getfield       );
```

重写发生在两个不同阶段,别混淆: **类加载期** Rewriter 把类文件里的 CP 索引批量换成 cpCache 索引并翻转字节序(08-04 的主题);**运行时**解释器解析完一条指令后还会把指令字节本身替换成 fast 形态——`getfield` 首次执行发现 cpCache 未解析,调 VM 解析后模板就把指令 patch 成 `fast_igetfield`(templateTable_x86.cpp:2929 的 `patch_bytecode(Bytecodes::_fast_igetfield, ...)`),后续执行不再重复解析。def 表里 `getfield` 的 format 就是 `bJJ`(大写 J = 原生字节序),因为这张表描述的是**内存形态**(Rewriter 之后的形态),不是类文件形态;CDS 归档时则把字节码恢复成 `_nofast_*` 形态,保证归档的字节码与运行时可重写版一致(bytecodes.hpp:290-302 注释)。compute_flags 里大写分支目前实际只会遇到 `J` 一种(bytecodes.cpp:244 注释 "actually, only the 'J' case happens currently")——因为只有 cpCache 索引被重写成原生序。

**关键设计 (斜体)**: *`_java_code` 这张"回到原始指令"的表是三条机制的地基: 迭代器 `java_code()` 归一后查长度、OopMap 断言验证 trap 一致性、调试器/字节码追踪把 fast 形态还原成人类认识的指令。表与表之间靠它互相校验。*

## 7. 分组: 谓词函数,不是位运算

大纲常有"opcode 高 4 位编码指令分组"的说法——这不是 HotSpot 的机制: opcode 空间的段布局(0x00-0x0f 常量、0x1a-0x35 局部变量/数组、0x60-0x83 算术、0x99-0xa9 控制流、0xb2-0xc5 引用)是 JVM 规范的历史安排,HotSpot 的分组是**区间谓词函数**(bytecodes.hpp:415-425,截取核心,逐字):

```cpp
// bytecodes.hpp:415-425(截取核心,逐字)
  static bool        is_aload       (Code code)    { return (code == _aload  || code == _aload_0  || code == _aload_1
                                                                             || code == _aload_2  || code == _aload_3); }
  static bool        is_astore      (Code code)    { return (code == _astore || code == _astore_0 || code == _astore_1
                                                                             || code == _astore_2 || code == _astore_3); }

  static bool        is_store_into_local(Code code){ return (_istore <= code && code <= _astore_3); }
  static bool        is_const       (Code code)    { return (_aconst_null <= code && code <= _ldc2_w); }
  static bool        is_zero_const  (Code code)    { return (code == _aconst_null || code == _iconst_0
                                                           || code == _fconst_0 || code == _dconst_0); }
  static bool        is_return      (Code code)    { return (_ireturn <= code && code <= _return); }
  static bool        is_invoke      (Code code)    { return (_invokevirtual <= code && code <= _invokedynamic); }
```

`is_return` = `_ireturn <= code <= _return`(区间判定),`is_aload` 则逐个点名——因为 `_aload`(25)与 `_aload_0`(42)之间隔着 iload_0 到 dload_3 共 16 个枚举成员,写不了区间。这类谓词是验证器与编译器的公共判断工具: 验证器在 store 指令处用 `is_store_into_local` 判断"这条会改变类型状态的指令是否在异常处理器覆盖区内"——若是,先用 JVM 规范要求的进入类型状态校验 handler 目标(verifier.cpp:754,校验必须在局部变量加入之前做);模板生成器用 `is_invoke` 把调用指令单独领走处理(templateInterpreter.cpp:254),deopt 重建 vframeArray 时用 `is_invoke` 识别调用点——调用指令的 debug info 是"执行前"状态的,参数大小必须直接查 invoke 的 descriptor,而普通指令走 `falls_through` 推下一条的栈图(deoptimization.cpp:705-722,与 24-03 的 unpack 同源)。它们依赖的是**枚举的排序约定**——`is_const` 能写区间,是因为 0x01-0x14 恰好连续。load/store 家族实数: 5 种类型(iload/lload/fload/dload/aload)×(1 条基本 + 4 条 short 形式)= 25 条 load,对称 25 条 store——共 50 条,不是"~60 条"。

## 核心悬念

定义表拆完了: 203 个标准成员 + 36 条私有指令,启动时由 `initialize()` 的 239 条 def 调用一次性填进六张静态数组(`_name/_result_type/_depth/_lengths/_java_code/_flags`),format 字符串预编译成位掩码,运行时全是 O(1) 查表——查名字、查长度、查栈效果、查陷阱点。这张表是纯"档案",它自己不执行任何指令;但它是一切执行者的公共前提: BytecodeStream 靠它走步,OopMap 计算靠它找异常边,deopt 重建靠它定位指令边界(24-03 的 unpack_on_stack 三态入口正是按 bci 落在哪条指令上选的)。

下一个问题顺理成章: 档案有了,**执行从哪来**?HotSpot 的解释器不是 switch 循环,而是给每条字节码预先生成一段 x86 机器码,存进 CodeCache 的 271 个 codelet(24-01 的 PrintInterpreter 实证),执行就是跳进对应段——下一篇拆 TemplateInterpreter: 定义表怎么变成机器码,dispatch 怎么做到单条间接跳转。

> → [08-interpreter/02 — 字节码→x86 机器码](02-template-interpreter.md)
