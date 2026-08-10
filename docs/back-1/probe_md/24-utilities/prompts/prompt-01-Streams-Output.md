# prompt-01 — Streams & Output: 输出流体系与格式化工具

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1 — GC 日志淹没磁盘**：生产环境配置 `-Xlog:gc*:file=/var/log/jvm/gc.log`，gc.log 意外增长到 2GB。运维想知道：为什么 outputStream 体系不内置 rotate？（答案：rotate 在 logging 层实现，outputStream 层是纯输出通道）追问：如果用 fdStream 直接写 raw fd，能和 LogFileOutput 的 rotate 共存吗？

**场景 2 — hs_err 写入失败排查**：JVM crash 后 hs_err_pid.log 只有 0 字节。用 `strace -e write` 重放发现 fdStream::write() 返回 EAGAIN。文档需解释 fdStream 的 async-safe 设计：为什么不用 FILE*？为什么错误处理是静默的？如果 fd 被 close 了会怎样？

**场景 3 — XML dump 缺失字段**：jcmd `VM.class_hierarchy` 用 xmlStream 输出 XML。一个字段在输出中消失——根源是 xmlStream 的单行 SAX 模式，closing tag 的文本被 flush 后不可回溯修改。

**反事实（Counterfactual）**：如果 JVM 用 std::ostream 而非自研 outputStream，后果如何？（答：无 async-safe fd 写入、无 ttyLocker 协议、无 vmError 步骤集成、C++ 异常安全问题）

---

## §一 Task + Narrative + Beginner Callouts

### Task
为 `24-utilities` Phase 生成第 1 篇文档 `01-Streams-Output.md`。本文档覆盖 utilities/ 中**所有流式输出和格式化工具**，共 12 个源文件 ~4650 行源码。

### Narrative（叙事线索）
文档应遵循从"使用侧→实现侧→底层侧"的叙事结构：
1. **从 tty->print() 出发** — 用户最熟悉的入口
2. **下潜到 outputStream 虚函数体系** — print→do_vsnprintf→write() 的调用链
3. **展开子类实现** — stringStream 的 48 字节小缓冲区优化 → bufferedStream 的大缓冲 → fileStream 的 FILE* → fdStream 的 raw write(2)
4. **拓展格式化层** — xmlStream 的 SAX 非缓冲、jsonStream 的树形写入、formatBuffer 的 %d/%s
5. **底层基础** — macros.hpp 的位操作/字符串化宏、align.hpp 的对齐原语、utf8 编解码

### Beginner Callouts（至少 7 个，文档 §一 内嵌，`> **` 格式）

1. **`> **tty 是全局唯一实例** — `tty` 是 `extern outputStream* tty`，初始化为 defaultStream，指向 stdout/stderr。理解 tty 的指向是所有日志输出的起点。**
2. **`> **virtual write() 是多态核心** — outputStream 自身不定义写入目标，子类通过重写 write(const char*, size_t) 决定字节流向。这就是为什么 print_cr("gc") 在不同子类上写入不同位置。**
3. **`> **48 字节小缓冲区优化** — stringStream 内嵌 _small_buffer[48]（约一行），小于此尺寸不触发 malloc，避免短字符串构造的堆分配开销。**
4. **`> **fdStream 是信号安全的** — fdStream::write() 直接调用 `::write(_fd, s, len)`，不通过 FILE* 缓冲层。vmError 崩溃处理就是利用这个特性在信号处理器中安全写入。**
5. **`> **xmlStream 和 jsonStream 都是非缓冲输出** — 每个 write() 立即传递到下游，不支持回退和修改。这就是为什么 SAX 模式适合流式 dump 但无法事后补字段。**
6. **`> **O_BUFLEN=2000 的硬限制** — 所有 outputStream::print(format, ...) 调用共享这个缓冲区上限。超过 2000 字节的格式化输出会被截断并触发 DEBUG 模式 warning。**
7. **`> **ttyLocker 的 advisory 锁** — tty 是多线程共享资源，ttyLocker 提供 RAII 风格的排他访问。但它是 advisory（建议性）不是 mandatory（强制性），不遵守者仍可绕过。**

---

## §二 Standard Environment

### Source Roots
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM（libjvm.so 编译入口）
src/hotspot/share/utilities/ostream.cpp:1-1138
src/hotspot/share/utilities/ostream.hpp:1-313
src/hotspot/share/utilities/xmlstream.cpp:1-515
src/hotspot/share/utilities/xmlstream.hpp:1-187
src/hotspot/share/utilities/json.cpp:1-688
src/hotspot/share/utilities/json.hpp:1-112
src/hotspot/share/utilities/macros.hpp:1-674
src/hotspot/share/utilities/utf8.cpp:1-539
src/hotspot/share/utilities/utf8.hpp:1-119
src/hotspot/share/utilities/align.hpp:1-152
src/hotspot/share/utilities/defaultStream.hpp:1-99
src/hotspot/share/utilities/formatBuffer.cpp:1-38
src/hotspot/share/utilities/formatBuffer.hpp:1-119
src/hotspot/share/utilities/stringUtils.cpp:1-67
src/hotspot/share/utilities/stringUtils.hpp:1-45
```

### Build Commands
```bash
# Slow debug build (for GDB)
bash configure --with-debug-level=slowdebug --with-native-debug-symbols=internal
make images

# Binary location
build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so
```

### Binary Paths
- `libjvm.so` — 包含 outputStream 虚函数表及所有子类
- `hs_err_pid<pid>.log` — vmError 通过 fdStream 生成

### Syscall 速查表（outputStream 直接涉及的）

| Function | man page | Used by | 说明 |
|----------|----------|---------|------|
| write(2) | `man 2 write` | fdStream::write | raw fd 写入，async-safe |
| fopen(3) | `man 3 fopen` | fileStream::fileStream | FILE* 打开文件 |
| fwrite(3) | `man 3 fwrite` | fileStream::write | 缓冲文件写入 |
| fflush(3) | `man 3 fflush` | fileStream::flush | 刷新 FILE 缓冲 |
| fclose(3) | `man 3 fclose` | fileStream::~fileStream | 关闭文件 |
| fread(3) | `man 3 fread` | fileStream::read | 读取文件 |
| feof(3) | `man 3 feof` | fileStream::eof | 检测 EOF |
| fseek(3) | `man 3 fseek` | fileStream::fileSize | 获取文件大小 |
| vsnprintf(3) | `man 3 vsnprintf` | outputStream::do_vsnprintf | 格式化引擎 |
| memcpy(3) | `man 3 memcpy` | stringStream::write | 缓冲区拷贝 |
| connect(2) | `man 2 connect` | networkStream::connect | Socket 连接（PRODUCT only）|
| socket(2) | `man 2 socket` | networkStream::networkStream | 创建 socket |
| close(2) | `man 2 close` | networkStream::close | 关闭 socket |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Functions/Roles |
|------|-----------|:----:|---------------------|
| ostream.hpp | src/hotspot/share/utilities/ostream.hpp | 313 | outputStream 基类 + 6 子类声明 + ttyLocker/streamIndentor |
| ostream.cpp | src/hotspot/share/utilities/ostream.cpp | 1138 | do_vsnprintf + print 引擎 + stringStream/fileStream/fdStream/bufferedStream 实现 + make_log_name_internal + *defaultStream init |
| defaultStream.hpp | src/hotspot/share/utilities/defaultStream.hpp | 99 | defaultStream 类（_writer_thread + _log_file 管理）|
| xmlstream.hpp | src/hotspot/share/utilities/xmlstream.hpp | 187 | xmlStream 声明（SAX 模式 element/attr/text/head/done）|
| xmlstream.cpp | src/hotspot/share/utilities/xmlstream.cpp | 515 | xmlStream 实现 + 全局 xtty 实例 |
| json.hpp | src/hotspot/share/utilities/json.hpp | 112 | JSON 格式化器（object/array 树形写入）|
| json.cpp | src/hotspot/share/utilities/json.cpp | 688 | JSON 嵌套展开 + quote 转义 |
| macros.hpp | src/hotspot/share/utilities/macros.hpp | 674 | STR/XSTR 宏 + PASTE_TOKENS + CONDITIONAL INCLUDE + align/power_of_2 + C++ version compat |
| utf8.hpp | src/hotspot/share/utilities/utf8.hpp | 119 | UTF-8 decode/encode API |
| utf8.cpp | src/hotspot/share/utilities/utf8.cpp | 539 | QUOTE_EMPTY + UNICODE_REPLACEMENT + 解码器状态机 |
| align.hpp | src/hotspot/share/utilities/align.hpp | 152 | is_aligned/align_up/align_down 宏和模板 |
| formatBuffer.hpp | src/hotspot/share/utilities/formatBuffer.hpp | 119 | formatBuffer 模板类（snprintf 包装）|
| formatBuffer.cpp | src/hotspot/share/utilities/formatBuffer.cpp | 38 | formatBuffer 构造函数实现 |
| defaultStream.hpp | src/hotspot/share/utilities/defaultStream.hpp | 99 | defaultStream（tty 实现）—— _writer_thread 异步写 |
| stringUtils.hpp | src/hotspot/share/utilities/stringUtils.hpp | 45 | 字符串工具（strcmp/strncmp/strchr_nr 等）|
| stringUtils.cpp | src/hotspot/share/utilities/stringUtils.cpp | 67 | 字符串工具实现 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 outputStream 虚函数体系：为什么需要两个写入路径？

① `print()` 和 `write()` 的分工是什么？（提示：ostream.cpp:144-156 的 print/vprint_cr 走 do_vsnprintf_and_write 格式化路径，而 ostream.cpp:183 的 put 直接调用 write()。为什么 put 不经过格式化？）

② stringStream::write() (ostream.cpp:352-383) 中 _is_fixed 模式截断 vs 动态 grow Mode 的区别。为什么动态 Mode 用 `MAX2(needed, _capacity * 2)` 而非精确 `needed`？（提示：减少 realloc 次数）

③ 为什么 bufferedStream (ostream.hpp:272-289) 需要独立的 buffer_pos/buffer_max/buffer_length 三层长度？

④ 为什么 fdStream::flush() (ostream.hpp:262) 是空实现？（提示：raw fd 无缓冲层，write() 立即生效）

**Counterfactual**：如果 outputStream 不用 virtual write() 而用 `std::function` 回调，会节省多少表查询开销？为什么 HotSpot 没选？（A: vtable 单次间接跳转 ~2-3 CPU cycles vs function<T> ~10-15 cycles；JVM 内部极热的日志路径需要最低开销）

### 4.2 do_vsnprintf 的三重优化：格式化如何做到最低开销？

① 为什么 do_vsnprintf (ostream.cpp:83-121) 有三个快速路径：constant format → trivial %s → full vsnprintf？（提示：gc="%s": "%s","%s" 式日志中 90%+ 是 trivial 路径）

② add_cr 的处理为什么有两种分支（result in-place vs buffer memcpy + append）？

③ O_BUFLEN=2000 (ostream.hpp:291) 的设计依据是什么？超过此限制后 DEBUG 模式 warning 如何帮助发现 bug？

**Counterfactual**：如果全部无条件走 vsnprintf(3)，不做预处理，每秒 10 万条日志会多消耗多少 CPU？（A: 每次 vsnprintf 至少解析一次 format string + va_arg 遍历 — 2-3× CPU 消耗，GC 日志密集时可见 GC pause 增长）

### 4.3 stringStream 的 48 字节栈缓冲优化：小字符串的零分配路径

① _small_buffer[48] (ostream.hpp:198) 的大小为什么是 48 而不是 64 或 128？

② grow() (ostream.cpp:335-350) 在首次超过 _small_buffer 时的 `NEW_C_HEAP_ARRAY + memcpy` 路径 vs 后续 `REALLOC_C_HEAP_ARRAY` 的区别。

③ stringStream::as_string() (ostream.cpp:397-402) 创建的 RESOURCE_AREA copy 为什么是必要的？

**Counterfactual**：如果用 `std::stringstream` 替代，每次构造的分配次数？（A: ~3 次（basic_stringbuf + locale + sentry）+ iostream 异常安全开销；stringStream 最优路径 0 分配）

### 4.4 fdStream 的 async-safe 保证：为什么 crash handler 依赖它？

① fdStream::fdStream(int fd=-1) (ostream.hpp:256) 为什么默认接受已打开的 fd？

② write() 实现（用 `::write(fd, s, len)` 而非 `::fwrite`）的 async-safe 保证范围。如果 `::write()` 返回 EAGAIN，fdStream 如何表现？

③ 为什么 vmError (vmError.cpp) 使用 fdStream 而非 logging 系统写 hs_err 日志？

**Counterfactual**：如果 crash handler 使用 fileStream（FILE*），会引入哪些信号安全性问题？（A: FILE* 内部有 mutex 锁、缓冲 malloc 可能触发堆锁 — 信号处理器中调用 malloc 是未定义行为）

### 4.5 xmlStream 的 SAX 模式：为什么 XML 输出不可回溯？

① xmlStream 每个 write() 立即传递到 _out 的实际 outputStream（xmlstream.cpp:1-515）。为什么不用 DOM 模式（build tree → serialize）？

② xmlStream::head() 和 xmlStream::done() 的生命周期管理——head 输出 `<tag>`，done 输出 `</tag>`。如果中间出错跳过 done() 的后果？

③ 全局 `xtty` 实例 (ostream.cpp:410: `xmlStream* xtty;`) 的初始化时机和与 tty 的区别。

**Counterfactual**：如果 JVM dump 改用 JSON 而非 XML+JSON 双格式，哪个更适合机读？（A: JSON 更适合，XML 有 schema 验证优势但开销大；当前双支持是因为不同工具链偏好不同格式）

### 4.6 macros.hpp 的位操作：为什么不用 `<bit>` 标准库？

① `is_power_of_2()` 和 `round_up_power_of_2()` 的位运算实现原理（`n & (n-1)` 和 `1 << log2_intptr(n)`）。

② `PASTE_TOKENS(x,y)` 为什么需要两级间接？（macros.hpp:45-47 — C 预处理器 ## 阻止参数展开，需要 XSTR→STR 的经典模式）

③ `COMMA` 宏 (macros.hpp:38) 的作用——解决宏参数中的逗号歧义。

**Counterfactual**：如果 C++14 可用 `std::has_single_bit()` 和 `std::bit_ceil()` 替代手写位操作，JVM 为什么不升级？(A: 历史兼容：JVM 的 C++ 标准滞后于 OS 编译器支持，且在极热的代码路径中，宏展开 0 开销而 `constexpr` 函数可能不内联)

### 4.7 utf8 编解码：JVM 的 UTF-8 转换为什么是自研而非 ICU？

① utf8.cpp 中的解码状态机：单字节 ASCII (0x00-0x7F) → 2-byte → 3-byte → 4-byte。为什么 NOT PRODUCE 但有 UNICODE_REPLACEMENT？

② utf8::convert_to_unicode() 和 utf8::convert_from_unicode() 的内存语义：调用方负责分配足够的输出缓冲。

③ 为什么判断字节数的宏 `BYTES_FOR_CHAR(c)` 基于前导位掩码？（提示：UTF-8 自同步特性 — 0xxxxxxx/110xxxxx/1110xxxx/11110xxx）

**Counterfactual**：如果 JVM 内部全部用 UTF-16 (wchar_t) 而非 UTF-8，内存开销？（A: 拉丁文字符集 ~2× 内存，但 ASCII 路径 1→2×；Class 文件内部 ConstantPool 已用 Modified UTF-8，切换代价高）

### 4.8 align.hpp 的对齐原语：为什么需要两种实现（宏 + 模板）？

① `align_up(x, a)` 宏与 `align_up(uintptr_t x, uintptr_t a)` 模板的差异。为什么宏版本用于编译期常量？

② `is_aligned(x, a)` 的位运算实现 `(x & (a-1)) == 0` 的前提条件（a 必须是 2 的幂）。

③ `align_down_waste` / `align_up_waste` 的语义：计算对齐产生的浪费字节。

**Counterfactual**：如果所有对齐都用 C++ `alignas` + `std::align` 替代手写宏，能提高类型安全性吗？（A: `std::align` 是运行时函数，不适合内存分配器的热路径；HotSpot 的 Arena::Amalloc 直接用宏计算对齐偏移 — 在 1B 次/秒分配场景下，宏 vs 函数调用的差异可测量）

---

## §五 Article Structure（建议文档章节结构）

```
§〇 生产场景与反事实
§一 全景架构 — outputStream 体系地图（类继承关系 + Mermaid 图）
§二 Source Files Table + Standard Environment
§三 outputStream 内核 — print→do_vsnprintf→write 调用链
§四 stringStream vs bufferedStream — 两种缓冲策略对比
§五 fileStream & fdStream — FILE* vs raw fd
§六 xmlStream — SAX XML 非缓冲输出
§七 JSON formatter — 树形写入语法
§八 macros.hpp & align.hpp — 位操作与编译期常量
§九 utf8 — JDK 内部字符集桥接
§十 formatBuffer & stringUtils — 工具层
§十一 不要写成→应该写成对照表
§十二 GDB 断点验证
§十三 Cross-Reference
```

---

## §六 Writing Requirements（≥8 行 "不要写成→应该写成" 对照表）

| # | 不要写成 | 应该写成 |
|---|---------|---------|
| 1 | 机械列出 outputStream 每个成员函数的源码翻译 | 解释核心调用链：`print("%s",x)` → do_vsnprintf 三重快速路径 → 子类 write()。用 `ostream.cpp:83-121` 的 3 路径决策树驱动叙事 |
| 2 | 列举所有子类的 write() 实现（字面对比） | 对比不同子类的"写入目的地"差异：stringStream→C heap buffer, bufferedStream→fixed buffer, fileStream→FILE*, fdStream→raw fd。用使用场景驱动解释 WHY |
| 3 | 把 macros.hpp 写成宏定义目录 | 选中 3 类核心宏展开：字符串化 (XSTR/STR)、拼接 (PASTE_TOKENS)、位操作 (is_power_of_2/round_up)。每类解释 C 预处理器边界案例 |
| 4 | 把 align.hpp 写成对齐原语词典 | 解释为什么 `is_aligned(x, a)` 仅在 a 为 2 的幂时有效，并在评论区展示反例（`is_aligned(7, 3)` → `7 & 2 = 2 != 0` → 误报不齐） |
| 5 | 把 xmlstream/json 写成 API 清单 | 解释 SAX 模式为何不可回溯 — 所有 write() 调用立即传递到下游，closing tag 输出后无法修改。用 `jcmd VM.class_hierarchy` 的真实输出做样例 |
| 6 | 忽略 stringStream 的 48 字节小缓冲优化 | 需要在 `ostream.cpp:310-321` 源码基础上，量化`_small_buffer` 对短字符串创建的消除：`tty->print("startup")` 需要 7 字节→0 次 malloc |
| 7 | 忽略 fdStream 的 async-safe 保证与 vmError 的依赖 | 展示 vmError 的 crash 路径如何通过 fdStream::fdStream(2) 写 stderr。用 GDB bp 验证 `fdStream::write` 在信号处理器调用栈中的位置 |
| 8 | 讨论 json 但不解释 object/array 嵌套状态机 | 用 `json.cpp:1-688` 源码，解释 writer 内部 `_depth` 栈和 `_comma_needed` 标志如何管理嵌套结构的 `{ }` 和 `,` 分隔符 |
| 9 | 忽略 utf8 的自同步特性与 HotSpot 为什么自研 | 对比 ICU（~2MB 依赖）vs 自研 UTF-8 codec（~500 行）。展示 Modified UTF-8（JVM 特有）的 `\0` 编码为 0xC0 0x80 的特殊规则 |

---

## §七 Output Format

文档格式：
- 标题：`# 01-Streams & Output — 输出流体系与格式化工具`
- 每个 § 子标题用 `## §X Title`
- 每个技术断言标注 `file:line` 来源
- Beginner callout 用 `> **callout N — 内容**` 内嵌在 §一 各小节
- 代码片段用 fenced code block，`line:start-end` 注释
- 诊断命令用 bash code block
- Mermaid 序列图用 `` ```mermaid ``

---

## §八 Prohibited（≥8 条）

1. **禁止把 outputStream 成员函数写成 APIDoc 式列表** — 必须按调用链叙事（print→do_vsnprintf→write→子类）
2. **禁止把 macros.hpp 写成 674 行宏定义的机械翻译** — 只选 3 类核心模式，每类解释 C preprocessor WHY
3. **禁止写成 "filename.cpp has N functions" 的代码统计报告** — 需要设计原理 + 使用场景
4. **禁止忽略 stringStream 的 48 字节小缓冲区优化** — 这是 HotSpot 避免日志产生堆分配的关键设计
5. **禁止忽略 fdStream 与 vmError 的耦合关系** — fdStream 几乎是专为 crash handler 设计的
6. **禁止忽略 xmlStream/json 的非缓冲 SAX 语义** — 这对理解 jcmd dump 的不完整性至关重要
7. **禁止不标注 man 手册引用** — 所有涉及 POSIX 函数（write/fwrite/fflush/vsnprintf/fopen/fclose/fread/connect/socket）必须标注 man section
8. **禁止不加 errno 讨论** — fdStream::write 和 fileStream::write 的错误路径（write return -1, fwrite return 0）必须讨论 errno
9. **禁止用"显然"、"众所周知"等不精确词汇** — 每个断言必须是可验证的（file:line 或可执行命令）
10. **禁止引用本文档不存在的 section** — Cross-Reference 只能引用 doc-00/doc-02 以及已存在的 Phase 文档

---

## §九 Required（≥8 条）

1. **完整的 outputStream 继承体系 Mermaid 图** — 父类 outputStream → stringStream/bufferedStream/fileStream/fdStream/networkStream/xmlStream
2. **print→do_vsnprintf→write 调用链的源码走读** — ostream.cpp:144-148 (print) → ostream.cpp:136-142 (do_vsnprintf_and_write) → ostream.cpp:83-121 (do_vsnprintf) → 子类 write()
3. **stringStream 的 48 字节优化 + grow 策略** — ostream.cpp:310-321 (构造) + ostream.cpp:335-350 (grow) + ostream.cpp:352-383 (write)
4. **fileStream vs fdStream 对照** — FILE* 缓冲 vs raw fd 的互斥设计意图
5. **xmlStream 完整示例** — `jcmd <pid> VM.class_hierarchy` 输出作为 xmlStream 的 SAX 模式产品
6. **macros.hpp is_power_of_2 + round_up 的数学推导** — `n & (n-1) == 0` 为什么等价于 2 的幂
7. **至少 7 个 Beginner Callout** — 内嵌在 §一 各小节，`> **` 格式
8. **JSON formatter 的单行/压缩格式选择** — json.cpp:1-688 中 `_print_comma` 和缩进控制的源码片段
9. **utf8 decode 状态机的 4 字节路径** — utf8.cpp 的解码分支表 + UNICODE_REPLACEMENT 用途
10. **GDB 验证 ≥8 断言**
11. **与 doc-00 (Core Containers) 和 doc-02 (Debug & Diagnostic) 的交叉引用**
12. **不要写成→应该写成对照表** — §六 的 9 行必须体现在文档中

---

### 4.9 formatBuffer：为什么需要模板化缓冲区大小？

① formatBuffer (formatBuffer.hpp:1-119) 是模板类 `template <size_t bufsz> class formatBuffer`。为什么用模板参数而非运行时大小？（提示：编译期栈分配 — 缓冲区在调用者的栈上，零堆分配）

② formatBuffer::append(const char* format, ...) 为什么用 `os::vsnprintf` 而非 `outputStream::do_vsnprintf`？（A: formatBuffer 返回格式化的 `const char*` 而非写入流中 — 语义不同）

③ 为什么在 vmError 和 hs_err 生成中大量使用 formatBuffer 而非 stringStream？（提示：栈分配 = 信号安全）

**Counterfactual**：如果用 `std::string + sprintf` 替代 formatBuffer，分配次数？（A: std::string 至少 1 次堆分配 + SSO 小字符串优化也不如栈分配确定性）

### 4.10 defaultStream 的异步 writer thread：为什么需要专用线程？

① defaultStream (defaultStream.hpp:1-99) 的 `_writer_thread` 是什么？为什么需要异步写入 tty？（提示：避免 GC pause 期间持有 ttyLocker 阻塞日志）

② `_log_file` 成员如何与 -XX:LogFile 参数交互？为什么 defaultStream 可以同时写 stdout 和文件？

③ ostream_init() (ostream.cpp 末尾) 的初始化顺序：为什么 defaultStream 必须在 Threads::create_vm() 之前初始化？

**Counterfactual**：如果 tty 不用 writer thread，而是在每个 print_cr 中直接 fwrite，GC pause 期间会怎样？（A: VM thread 持 ttyLocker → Java thread 阻塞在 tty->print_cr → 级联阻塞）

---

## §十 GDB Verification（≥8 assertions）

```bash
# 1. 验证 tty 的类型 — 运行时是 defaultStream*
(gdb) p tty
# → 应显示 (defaultStream *) 0x...

# 2. 验证 outputStream 虚函数表 — 确认 write() 位置
(gdb) info functions outputStream::write
# → outputStream::write() 是纯虚，不应有实现
(gdb) info functions stringStream::write
(gdb) info functions fdStream::write

# 3. 验证 stringStream 的小缓冲优化
(gdb) b stringStream::stringStream(size_t)
(gdb) info locals
# → _buffer == _small_buffer (初始时)
# → _capacity == sizeof(_small_buffer) == 48

# 4. 验证 fdStream::write 调用 ::write(2)
(gdb) b fdStream::write
# → 断在 assert(len > 0)
(gdb) p _fd
# → 应为 2 (stderr) 或 hs_err 的 fd

# 5. 验证 do_vsnprintf 的快速路径（常量字符串）
(gdb) b outputStream::do_vsnprintf
(gdb) p format
# 如果是纯常量（如"hello"）应走 strchr('%')==NULL 分支跳过 os::vsnprintf

# 6. 验证 make_log_name_internal 的 %p/%t 替换
(gdb) b make_log_name_internal
(gdb) p log_name
# → 应显示包含 %p 或 %t 的原始模板字符串

# 7. 验证 xtty 全局实例
(gdb) p xtty
# → 应为 xmlStream * 实例

# 8. 验证 ttyLocker 的 RAII
(gdb) b ttyLocker::hold_tty
(gdb) bt
# → 调用栈应包含使用 tty->print_cr() 的线程代码

# 9. 验证 bufferedStream 的无锁写入
(gdb) b bufferedStream::write
(gdb) p buffer_pos
# → 写入前后 buffer_pos 的变化

# 10. 验证 xmlStream::write 的直接传递语义
(gdb) b xmlStream::write
(gdb) p len
(gdb) p _out
# → _out 应指向实际的输出流（如 tty 或 stringStream）
```

---

## §十一 与 README 和同组 prompt 的连续性

### 与 README 的关系
- 本文档对应 README §二 的 "doc-01：Streams & Output"
- 覆盖 ostream/xmlstream/json/formatBuffer/macros/utf8/align/stringUtils/defaultStream 共 12 文件
- 源码总行数 ~4650 行

### 与前一篇 prompt-00 的关系
- doc-00 建立了 GrowableArray/Hashtable/BitMap 等核心容器——本文档的 outputStream 体系使用这些容器
- stringStream::write() 使用 memcpy (来自 copy.hpp，已在 doc-00 基础层）
- doc-00 的 BitMap 的 set/clear 操作使用 align.hpp 的对齐原语
- outputStream 继承自 ResourceObj（已在 doc-00 的 resourceHash 区域讨论）

### 与后一篇 prompt-02 的关系
- doc-02 (Debug & Diagnostic) 中的 vmError 使用 fdStream 写 hs_err 日志
- doc-02 的 nativeCallStack → decoder → elfFile 路径可能使用 outputStream 输出符号表
- doc-02 的 events.hpp 使用 outputStream 记录事件
- doc-02 的 debug 断言系统内部使用 tty->print_cr 输出 assert 失败信息

### 与 Phase 23-logging 的关系
- 23-logging/docs/01-Output-Pipeline.md 覆盖了 LogFileOutput::write() 的内部实现
- 该文档的 LogFileOutput 最终通过 fileStream::write() → ::fwrite() 写入磁盘
- 本文档解释 fileStream 和 fdStream 的底层 write(2)/fwrite(3) 调用——这是日志输出的物理层
- 读者可交叉阅读：23-logging 的 logFileStreamOutput 继承自 logFileOutput 但内部也使用了 outputStream 的基类抽象

### 文档交叉引用建议
- 如果读者不理解 BitMap 的 `set_intersection`，回到 doc-00 §三
- 如果读者想了解 vmError 如何用 fdStream 写 hs_err，前向阅读 doc-02 §二
- 如果读者想追踪 logging 层的 write 如何通过 LogOutput 最终到 fdStream，回到 probe_md/23-logging/docs/01-Output-Pipeline.md
- 如果读者好奇 GrowableArray 的输出（如 `-XX:+PrintFlagsFinal`），回到 doc-00 §二

---

## §十二 文档生成提示

### 必须强调的全局概念

1. **outputStream 不是 std::ostream** — HotSpot 自研的 outputStream 体系有四点独特设计：
   - 无异常（所有 write 返回 void）
   - 信号安全（fdStream 无缓冲、无 malloc）
   - 虚拟分派（write() 纯虚 — ~2-3 cycles 间接跳转）
   - ttyLocker 协议（advisory lock RAII）

2. **三层格式化路径的性能权衡**：
   - 常量字符串 → 零开销（直接 strlen + write）
   - 纯 %s → 一次 va_arg + strlen + write
   - 通用格式 → os::vsnprintf (可能触发 locale/浮点转换)

3. **SAX 语义的代价**：xmlStream 和 jsonStream 的不可回溯性意味着：
   - 每个 tag 的输出时机必须精确
   - 无法事后添加属性或子元素
   - 输出错误（如未闭合 tag）不可修复

4. **48 字节小缓冲的意义**：对于单行日志（通常 <48 字节），stringStream 零分配。这是 JVM 日志系统高性能的基础——避免日志本身成为 GC root 或触发 GC。

### Mermaid 图要求

```
```mermaid
classDiagram
    class outputStream {
        <<abstract>>
        +print(format, ...)
        +write(str, len)*
        +flush()
        -do_vsnprintf()
        #position, width, indentation
    }
    class stringStream {
        +write()
        -_small_buffer[48]
        -_written, _capacity
        -grow()
    }
    class bufferedStream {
        +write()
        -buffer_pos, buffer_max
        -buffer_fixed, truncated
    }
    class fileStream {
        +write()
        -_file : FILE*
        +flush() : fflush
    }
    class fdStream {
        +write()
        -_fd : int
        +flush() : {}
    }
    class xmlStream {
        +write()
        +head(), done()
        +text(), cr()
        -_out : outputStream*
    }
    outputStream <|-- stringStream
    outputStream <|-- bufferedStream
    outputStream <|-- fileStream
    outputStream <|-- fdStream
    outputStream <|-- xmlStream
```
```

### 文档长度建议
本文档目标 1000-1500 行。核心内容分布：
- §三 outputStream内核 ~200-250 行
- §四 stringStream/bufferedStream ~150-200 行
- §五 fileStream/fdStream ~150-200 行
- §六 xmlStream ~120-150 行
- §七 JSON ~100-120 行
- §八 macros/align ~120-150 行
- §九 utf8 ~100-120 行
- §十 formatBuffer/stringUtils ~80-100 行
- §十二 GDB验证 ~100 行
