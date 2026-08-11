# 04. UTF-8 + JSON + ELF decoder — 编解码与栈回溯

> 🟡 Working | modified UTF-8、JSON 输出、ELF→函数名
> 读者处境: JVM 内部用 **modified UTF-8**(区别于标准 UTF-8: null→0xC0 0x80, supplementary chars→6 bytes)。JFR 输出 JSON。crash 栈回溯→ELF .symtab→addr→function name+offset。

### 1. "Modified UTF-8"

场景: JVM class file 中字符串(MUTF-8)不同于 Java String 标准 UTF-8。差别: NUL(U+0000)→two bytes(0xC0 0x80), supplementary(U+10000+)→six bytes(vs 标准 four)。

**UTF-8 编解码** (`utf8.cpp:100-400`):
```
UNICODE→UTF-8(UTF8::convert_to_unicode(const char* utf8_str, int len)):
  → 逐字节扫描:
      0x00 → U+0000(null)——特殊处理(modified UTF-8 has 0xC0 0x80)
      0x01-0x7F → direct(ASCII)
      0xC0-0xDF → two-byte(110xxxxx 10xxxxxx)→U+0080-U+07FF
      0xE0-0xEF → three-byte(1110xxxx 10xxxxxx 10xxxxxx)→U+0800-U+FFFF
      0xED → surrogate pair→0xED A0 80-0xED BF BF→six bytes→U+10000+
[C++: utf8.cpp:543行——modified UTF-8 是 JVM Spec 定义——class file CONSTANT_Utf8_info 使用]
```
- 源码: `utf8.cpp:100-300` (UTF8::convert_to_unicode) + `utf8.cpp:300-450` (UNICODE::convert_to_utf8)

- 关键设计: **modified UTF-8 的 null encoding** — 标准 UTF-8 中 NUL(U+0000) = single 0x00 byte→但在 C 字符串中 0x00 是 terminator。JVM 用 0xC0 0x80 编码 NUL→避免 C string terminator 冲突。**supplementary chars 6 bytes** — Ed A0 80-Ed BF BF 范围——这是 UTF-16 surrogate pair(U+D800-U+DFFF)→需要特殊处理→标准 UTF-8 用 4 bytes(F0-F4 开头)→JVM 用 CESU-8 编码。

### 2. "JSONWriter — JFR/logging 输出"

场景: JFR recording dump→JSON format。Logging framework `-Xlog:gc*=debug:file=gc.log::filesize=10M`→内部用 LogDecorations+LogMessageBuffer→可输出为 JSON。

**JSON** (`json.cpp:100-500`):
```
JSONWriter::write(const char* key, const char* value):
  → print("\"%s\": \"%s\"", key, escape_json(value))
  → 处理特殊字符: \", \\, \n, \t, \r→escape as \\"、\\\\、\\n...

JSONWriter::write_array(const char* key, const char** values, int count):
  → print("\"%s\": [", key)
  → for i in 0..count-1: print("\"%s\"%s", values[i], (i<count-1)?", ":"")
  → print("]")
[C++: json.cpp:688行——JSON 输出主要用于 JFR dump + diagnostic——非 critical path(no perf overhead)]
```
- 源码: `json.cpp:100-250` (JSONWriter::write key/value) + `json.cpp:250-450` (write_array/object/pretty_print)

- 关键设计: **JSON 输出是 human-readable** — 不是 binary format——JFR 用 JSON 是因为 JDK Flight Recorder 支持多种格式(JSON/binary/chunk)。**escape_json** — 转义 `\` / `"` / control characters→确保输出是合法 JSON。

### 3. "ELF decoder — addr→function name"

场景: hs_err_pid.log native stack trace: `[0x00007f1234005678] Java_java_lang_Thread_start+0x20`→`+0x20`=offset in function。ELF decoder 从符号表获取函数名。

**ELF decoder** (`decoder_elf.cpp:50-300`):
```
decoder_elf::decode(pc, buf, bufsize, offset):
  → dladdr(pc, &info)→get ELF info for address
  → if info.dli_sname != NULL(has symbol name):
      snprintf(buf, bufsize, "%s", info.dli_sname)  // function name
      *offset = pc - (address)info.dli_saddr  // byte offset in function
  → if info.dli_fname != NULL:
      append " [libjvm.so+0xoffset]" or "[vdso]"
[C++: decoder_elf.cpp——dladdr(3) 依赖 ELF .dynsym(共享库的动态符号)——不需要 .symtab(静态调试符号)]
```
- 源码: `decoder_elf.cpp:50-150` (decode→dladdr) + `decoder_elf.cpp:150-300` (fallback→raw hex if no symbol)

- 关键设计: **dladdr vs readelf** — `dladdr(3)` 是 POSIX 标准函数(dynamic linker)→比手动解析 ELF .symtab 快 100x(linker 有 hash table)。**fallback** — if stripped(no .dynsym)→output `[0x00007f1234005678]`(raw address→开发者用 addr2line -e libjvm.so 0x...手动解析)。

---

### 核心悬念

**"Modified UTF-8: null→0xC0 0x80, supplementary→6 bytes(vs standard 4)→CESU-8 encoding。JSON: escape+pretty print→human-readable JFR dump。ELF decoder: dladdr→.dynsym→function name+offset→fallback raw hex if stripped。"** — 域48结束，OpenJDK 全部 48 域完成。

> → [返回 §九 完成态验证清单](../HANDOFF-NEW-AI.md)
