# 04. UTF-8 + JSON + ELF decoder — 编解码与栈回溯

> 🟡 Working | modified UTF-8、JSON 解析、ELF 符号
> 读者处境: JVM 内部用 **modified UTF-8**(null→0xC0 0x80,surrogate 3 字节/unit)。CompilerDirectives 文件是 JSON。crash 栈回溯→ElfFile 解析 ELF 符号表→addr→function name+offset。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/48-utilities/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"JSONWriter 输出 JFR" 错误**: json.cpp(688 行)是 **JSON 解析器**(JSON 类,回调式: parse_json_value/object/array/string/number@64-348,callback 纯虚@json.hpp:95),用于 CompilerDirectives(directivesParser.hpp:51 DirectivesParser : public JSON);JFR 录制输出不是 JSON
> - **"dladdr" 错误**(与 48域01 深审一致): Linux 是 ElfDecoder + **ElfFile 自解析 ELF**(elfFile.cpp:351 行,parse_elf@168/load_tables@189/魔数校验@180-187/SHT_STRTAB+SYMTAB|DYNSYM@215-229/decode@290),不依赖动态链接器
> - 行号漂移: utf8_write@utf8.cpp:145、convert_to_unicode@169、as_utf8@451、convert_to_utf8@491;JSON::error@json.cpp:642;ElfSymbolTable::lookup@elfSymbolTable.cpp:70

### 1. "Modified UTF-8"

场景: JVM class file 中字符串(mUTF-8)不同于标准 UTF-8: NUL(U+0000)→0xC0 0x80,supplementary→两个 surrogate 各 3 字节(6 字节,标准 4 字节)。

**UTF-8 编解码** (`utf8.cpp:145-184` + `451-496`):
```
utf8_write(145-167): jchar → 1/2/3 字节
  → ch==0 走 0x7FF 分支: 0|0xC0=0xC0, 0|0x80=0x80 → NUL = 0xC0 0x80
  → surrogate(U+D800-DFFF)走三字节: 0xED A0 80-0xED BF BF(每 UTF-16 unit 3 字节,2 unit = 6 字节)
as_utf8(jbyte)(473-489): 注释 485-486 "0x00 which should be encoded as 0xC080 in 'modified' UTF8"
convert_to_unicode(169-184): ASCII 快速循环(176-179) + UTF8::next(30) 逐字符解码
unicode_length(123-142): 字符数 + latin1/多字节检测(字符串压缩探测器,域06伏笔)
[C++: utf8.cpp:543行——modified UTF-8 是 JVM Spec 定义——class file CONSTANT_Utf8_info 使用]
```
- 源码: `utf8.cpp:145-167` (utf8_write) + `169-184` (convert_to_unicode) + `451-496` (as_utf8/convert_to_utf8)

- 关键设计: **mUTF-8 的两个偏离都源于"UTF-16 code unit 数组 + C 字符串 0x00 终止"**: ① NUL→0xC0 0x80 避免 C 字符串截断; ② surrogate 按 code unit 编码(每 unit 3 字节)保索引一一对应,标准 UTF-8 的 4 字节要求合并 surrogate,索引会错位。代价是与标准 UTF-8 不兼容(互操作需转换)。

### 2. "JSON 解析器 — CompilerDirectives 的语法"

场景: `-XX:CompilerDirectivesFile=directives.json` → DirectivesParser 解析。

**JSON**(`json.cpp:44-448` + `json.hpp:95`):
```
JSON 类(44): parse(50) → parse_json_value(64) → parse_json_object(151)/array(215)/string(264)/number(348)
  → 每解析一个 value 调纯虚 callback(JSON_TYPE t, JSON_VAL* v, uint level)(json.hpp:95)
DirectivesParser : public JSON(directivesParser.hpp:51)——构造传文本并 parse()(directivesParser.cpp:136)
错误定位: expect_any(json.cpp:448) / error(json.cpp:642) "Syntax error, expecting one of ..."
[C++: json.cpp:688行——事件驱动(SAX 风格)解析器,非 DOM;自研零依赖]
```
- 源码: `json.cpp:44-348` (解析主链) + `directivesParser.hpp:51` (用途)

- 关键设计: **回调式解析器(SAX 风格)** — 解析即处理,不需要先建 DOM 再遍历;DirectivesParser 解析到指令直接安装进 DirectivesStack。自研原因:零依赖 + 错误信息可控("这一位期待什么")。注意:**这是解析器**,JFR 录制输出走 JFR 自己的格式,不是 JSON。

### 3. "ELF 符号 — 地址到函数名"

场景: hs_err native frames 的 `函数名+offset`(48域01 的 Decoder/ElfDecoder 底层)。

**ElfFile**(`elfFile.cpp:168-229` + `290-322`):
```
parse_elf(168-177): fopen → load_tables
load_tables(189-229): 读 ELF 头 → 魔数校验(is_elf_file 180-187: \x7fELF + 类别/字节序) → 遍历 section headers
  → SHT_STRTAB 建字符串表(215-217); SHT_SYMTAB||SHT_DYNSYM 建符号表(227-229)
decode(290-322): 逐符号表 lookup(elfSymbolTable.cpp:70 起,线性扫描+地址区间比较) → 字符串表取名字 + off
[C++: elfFile.cpp:351行——自研 ELF 解析,非 dladdr(可查 .symtab 完整符号 + 错误处理线程安全)]
```
- 源码: `elfFile.cpp:168-229` (加载) + `290-322` (decode) + `elfSymbolTable.cpp:70` (lookup)

- 关键设计: **自研 ELF 解析 vs dladdr(3)** — dladdr 只查动态符号(.dynsym);ElfFile 自己解析,`.symtab`(strip 前调试符号)也能查。可靠性理由(与 48域01 呼应):崩溃现场动态链接器状态不可信,纯 libc 操作可优雅降级(NullDecoder::is_error 状态机)。诊断工具的可靠性优先级高于完整性。

---

### 核心悬念

**"mUTF-8: NUL→0xC0 0x80、surrogate 3 字节/unit(CESU-8 同族)。JSON: 回调式解析器(parse_json_* + callback),CompilerDirectives 用。ELF: ElfFile 自解析符号表(非 dladdr)。"** — 第 1 批(地基)完结!下一篇: 第 2 批 02-assembler(MacroAssembler——45域02 的代码生成器底层)。

> → 第 2 批 [02-assembler](../02-assembler/01-*.md)
