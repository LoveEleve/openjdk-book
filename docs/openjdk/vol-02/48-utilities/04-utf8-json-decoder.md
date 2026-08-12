# 04. 三种格式工具 — modified UTF-8、JSON 解析、ELF 符号

> **前置依赖**:[48-utilities/01 — vmError 引擎](01-vmerror.md):Decoder/ElfDecoder 的名字链——本篇拆它的底层 ELF 解析;48-utilities/02 — 并发数据结构
> → **后续**:第 2 批 [02-assembler](openjdk/vol-02/02-assembler/01-*.md):MacroAssembler——45-02 的代码生成器就站在它肩上
> 关联域: 07-classfile(CONSTANT_Utf8_info)、13-jit(CompilerDirectives)、06-oops(字符串压缩)、23-stub

## 三种"格式",三个工具

JVM 要和三类外部格式打交道:class file 里的字符串(**modified UTF-8**)、CompilerDirectives 配置文件(**JSON**)、可执行文件(**ELF** 符号表)。三者的工具实现都在 `share/utilities/`:utf8.cpp(543 行)、json.cpp(688 行)、elfFile.cpp(351 行)。这篇收尾第 1 批——它们是"地基"的最后一块。

## 1. modified UTF-8:JVM 的私有字符串编码

### 1.1 场景:为什么 class file 的字符串和标准 UTF-8 不一样

class file 的 `CONSTANT_Utf8_info` 用 **modified UTF-8**(mUTF-8,JVM 规范定义):NUL(U+0000)编码成两字节 `0xC0 0x80`,而 supplementary 字符(超过 BMP)用**两个 3 字节的 surrogate 编码**(共 6 字节)——标准 UTF-8 是 4 字节。编码核心是 `utf8_write`(utf8.cpp:145-167):

```cpp
// utf8.cpp:145-167(截取核心,逐字)
// Writes a jchar as utf8 and returns the end
static u_char* utf8_write(u_char* base, jchar ch) {
  if ((ch != 0) && (ch <=0x7f)) {
    base[0] = (u_char) ch;
    return base + 1;
  }

  if (ch <= 0x7FF) {
    /* 11 bits or less. */
    unsigned char high_five = ch >> 6;
    unsigned char low_six = ch & 0x3F;
    base[0] = high_five | 0xC0; /* 110xxxxx */
    base[1] = low_six | 0x80;   /* 10xxxxxx */
    return base + 2;
  }
  /* possibly full 16 bits. */
  char high_four = ch >> 12;
  char mid_six = (ch >> 6) & 0x3F;
  char low_six = ch & 0x3f;
  base[0] = high_four | 0xE0; /* 1110xxxx */
  base[1] = mid_six | 0x80;   /* 10xxxxxx */
  base[2] = low_six | 0x80;   /* 10xxxxxx */
  return base + 3;
}
```

注意 `ch <= 0x7FF` 分支的边界:`ch == 0` 走不进第一个分支(`ch != 0` 条件),于是 NUL 走进 0x7FF 分支——`0 | 0xC0 = 0xC0`,`0 | 0x80 = 0x80`,得到 `0xC0 0x80`。而代理项(surrogate code unit,U+D800-DFFF)不属于 `<= 0x7FF`,走三字节分支:高代理 `0xED A0 80`-`0xED AF BF`,低代理 `0xED B0 80`-`0xED BF BF`——**每个 UTF-16 code unit 原样 3 字节**,两个 code unit 就是 6 字节。jbyte(Latin-1)方向的 `as_utf8`(473-489)注释把这个设计说得更直白:

```cpp
// utf8.cpp:485-486(注释逐字)
      // Non-ASCII character or 0x00 which should
      // be encoded as 0xC080 in "modified" UTF8.
```

解码方向是 `convert_to_unicode`(169-184):先走 ASCII 快速循环(176-179 行,`ch > 0x7F` 才跳出),剩余字节逐个交给 `UTF8::next`(30 行起)解码。配套的 `unicode_length`(123-142)还顺带检测字符串是否纯 Latin-1——**这是字符串压缩的探测器**(jchar 数组能否压成 jbyte 数组,域 06 的伏笔)。

**关键设计 (斜体)**: *mUTF-8 的两个偏离都源于一个事实:JVM 的字符串是 UTF-16(code unit 数组),且 C 字符串用 0x00 终止。① NUL 必须编码成 0xC0 0x80——否则字符串里的空字符会把 C 字符串提前截断;② surrogate 按 code unit 编码(每 unit 3 字节)——因为 Java 字符串的索引是 code unit 粒度,解码到 jchar 数组**一一对应、零重排**,而标准 UTF-8 的 4 字节形式要求先合并 surrogate 再解码,索引会错位。代价是 mUTF-8 与标准 UTF-8 不完全兼容(互操作时要转换),JVM 选择"内部一致性优先"。*

## 2. JSON:一个回调式解析器

### 2.1 场景:-XX:CompilerDirectivesFile 的 JSON 文件怎么读

JIT 指令文件(CompilerDirectives,-XX:CompilerDirectivesFile=directives.json)是 JSON 格式。解析器在 json.cpp(688 行)——它是一个**事件驱动的回调式解析器**,不是 DOM 树构建器:

```cpp
// json.hpp:95(逐字)
  virtual bool callback(JSON_TYPE t, JSON_VAL* v, uint level) = 0;
```

`JSON` 类(json.cpp:44)负责词法与语法:parse(50)→ parse_json_value(64)按 token 分派 → parse_json_object(151)/parse_json_array(215)/parse_json_string(264)/parse_json_number(348)递归解析;每解析出一个 value,就调用**纯虚 `callback`** 通知子类。具体语义完全由子类决定——CompilerDirectives 的解析器正是这么用的:

```cpp
// directivesParser.hpp:51(逐字)
class DirectivesParser : public JSON {
```

`DirectivesParser`(directivesParser.cpp:136)构造时把文本交给 `JSON(text, silent, st)` 并调用 `parse()`——之后每个 JSON 值都以 callback 形式回调进来,由它组装成 CompilerDirectives 指令栈(装进 DirectivesStack)。解析器自身还带精细的错误定位:`expect_any`(json.cpp:448)/`error`(json.cpp:642)输出 `"Syntax error, expecting one of ..."` 并带行号。

**关键设计 (斜体)**: *为什么自研解析器而不是引第三方 JSON 库?① 零依赖——JVM 的 native 部分只依赖 libc/libjvm,任何外部库都进不了 hotspot;② 回调式(SAX 风格)天然适配"解析即处理"——DirectivesParser 不需要先建整棵 DOM 再遍历,解析到一条指令就直接安装,内存和延迟都省;③ 错误信息可控——`expect_any` 能说出"这一位期待什么",这对配置文件排错很重要。注意这是**解析器**,JFR 的录制输出走的是 JFR 自己的二进制/自定义格式,不是 JSON(规划文档里的 "JSONWriter 输出 JFR" 是张冠李戴)。*

## 3. ELF 符号:地址到函数名的最后一步

### 3.1 场景:hs_err 的 native frames 背后

48-01 篇讲过:crash 栈打印时 `Decoder` 把地址翻译成 `函数名+偏移`,Linux 平台是 `ElfDecoder`(decoder_elf.cpp:38)。它的底层是 **ElfFile**(elfFile.cpp:351 行)——**自己解析 ELF 文件**,不依赖 dladdr:

```cpp
// elfFile.cpp:180-187(截取核心,逐字)
//Check elf header to ensure the file is valid.
bool ElfFile::is_elf_file(Elf_Ehdr& hdr) {
  return (ELFMAG0 == hdr.e_ident[EI_MAG0] &&
      ELFMAG1 == hdr.e_ident[EI_MAG1] &&
      ELFMAG2 == hdr.e_ident[EI_MAG2] &&
      ELFMAG3 == hdr.e_ident[EI_MAG3] &&
      ELFCLASSNONE != hdr.e_ident[EI_CLASS] &&
      ELFDATANONE != hdr.e_ident[EI_DATA]);
}
```

`parse_elf`(168-177)打开文件 → `load_tables`(189-224)读 ELF 头、校验魔数(就是上面这段,`\x7fELF` + 类别/字节序检查)、然后**遍历 section headers**:`SHT_STRTAB` 建字符串表(215-217)、`SHT_SYMTAB || SHT_DYNSYM` 建符号表(227-229)。查符号时 `ElfFile::decode`(290-320)逐个符号表 `lookup`(elfSymbolTable.cpp:70 起,线性扫描 + 地址区间比较),命中后从字符串表取出名字,`*offset = off` 给出函数内偏移:

```cpp
// elfFile.cpp:315-319(截取核心,逐字)
  if (string_table == NULL) {
    _status = NullDecoder::file_invalid;
    return false;
  }
  if (offset) *offset = off;
```

- [C++: 与 dladdr 的取舍:dladdr(3) 由动态链接器实现,只查**动态符号表(.dynsym)**;ElfFile 自己解析,`SHT_SYMTAB`(完整符号表)和 `SHT_DYNSYM` 都能查——strip 前的调试符号(.symtab)也能出名字。代价是几百行 ELF 解析代码,换来零依赖 + 符号范围更全]
- [man 5 elf:ELF 头 `e_ident` 前 4 字节是魔数 `\x7f E L F`;`e_shoff` 指向节表起始、`e_shnum` 是节数量;节头 `sh_type` 区分 STRTAB/SYMTAB/DYNSYM]

**关键设计 (斜体)**: *为什么错误处理场景要自研 ELF 解析?除了符号范围,还有可靠性的理由(与 48-01 的 Decoder 安全模式呼应):崩溃现场里动态链接器的内部状态不可信,而"打开文件、读头、扫节表"是纯 libc 操作,任何一步失败都能优雅降级(`NullDecoder::is_error` 状态机,decode 时直接放弃)。**诊断工具的可靠性优先级高于完整性**——宁可少一行符号,不能崩在解析符号的代码里。*

## 核心悬念

"第 1 批(地基)收尾:OS、CPU、数学库、工具类——JVM 的地基全部就位。第 2 批从 **02-assembler** 开始:45-02 篇那个'把 C++ 的 `__ mulsd(...)` 调用解释成机器码'的生成器,它的底层是 assembler 抽象——`MacroAssembler` 如何成为 JVM 的'运行时汇编器',指令编码、重定位、CodeBuffer 的内存模型,这些是 JIT 编译器的地基。"

> → 第 2 批 [02-assembler](openjdk/vol-02/02-assembler/01-*.md):MacroAssembler、指令编码与 CodeBuffer
