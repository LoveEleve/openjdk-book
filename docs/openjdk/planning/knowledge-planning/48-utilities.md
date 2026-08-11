# 域 48: Utilities — 知识规划

> 源码: hotspot/share/utilities/ | ~101文件/~25426行 | 🟡 大域(4篇)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| vmError.cpp (1901行) | **Crash handler**: report_and_die→hs_err_pid.log, OS error info, native stack trace, VM version, thread dump, register dump, error reporting token(防止多线程 crash 覆盖日志) | High |
| ostream.cpp (1147行) | **Output streams**: tty(默认输出), gclog_or_tty, stringStream, bufferedStream, networkStream——抽象 JVM 内所有输出(GC log, error, diagnostics) | High |
| concurrentHashTable.hpp/ipp (534+1286行) | **并发哈希表**: ConcurrentHashTable——lock-free concurrent hash table for JFR/SymbolTable/StringTable, per-bucket mutex + CAS resize, concurrent insert/lookup/delete | High |
| bitMap.cpp (702行) | **位图**: BitMap——紧凑的 bit array(每个 bit 对应一个 heap word), set/clear/test/large iteration, G1 region mark/SATB/CardTable 全部依赖 BitMap | High |
| globalDefinitions.hpp (1404行) | **全局类型定义**: jint/jlong/jbyte/jchar/jfloat/jdouble/jboolean, uintptr_t/uintx/intx, align_up/align_down/round_to, is_power_of_2, ARRAY_SIZE macro | High |
| exceptions.cpp (549行) | **异常工具**: Exceptions::debug_check_abort, ThreadShadow exception stack, pending exception management(检查/抛出/清除)——所有 JVM 内部异常处理的 entry point | High |
| utf8.cpp (543行) | **UTF-8 编解码**: UNICODE→UTF-8, UTF-8→UNICODE, modified UTF-8(JVM 使用的变种——null encoded as 0xC0 0x80, supplementary chars use 6 bytes) | High |
| json.cpp (688行) | **JSON 输出**: JSONWriter→write key/value/array/object→pretty print→JFR dump/Logging config 使用 | Medium |
| growableArray.hpp (582行) | **可增长数组**: GenericGrowableArray→ResourceObj/template based——arena allocation, 自动扩容(2x), JVM 内所有动态数组的基础 | High |
| macros.hpp (678行) | **跨平台宏**: COMPILER1/COMPILER2, ZERO/SHARK, NOT_PRODUCT/PRODUCT/ASSERT, ATTRIBUTE_ALIGNED, RESTRICT | Medium |
| decoder_elf.cpp | **ELF 堆栈解码**: decoder→dladdr→ELF .symtab→function name+offset—栈回溯(StackWalker)的 native 层 | Medium |

*11 知识点*

## 02 聚合

### P1 (≥5文件) — 无

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| Crash handler + output | vmError.cpp, ostream.cpp, debug.cpp |
| 并发数据结构 | concurrentHashTable.hpp/ipp, bitMap.cpp |
| 异常 + 类型系统 | exceptions.cpp, globalDefinitions.hpp, macros.hpp |

### P3 (=1文件)
| KP | 出现文件 |
|----|---------|
| UTF-8 | utf8.cpp |
| JSON | json.cpp |
| Stack decoder(ELF) | decoder_elf.cpp |
| 可增长数组 | growableArray.hpp |

## 03 深度分类

### 🔴 Deep (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| vmError crash handler(1901行) | hs_err_pid.log 的全部生成逻辑——error reporting token(多线程 crash 只有一个线程写), OS error info(/proc/self/maps, dmesg, ulimit), native stack trace(unwind→function name+offset via elf decoder), Java thread dump, VM version+flags。JVM crash 时的唯一诊断——没有 vmError→hs_err_pid.log→无法诊断 SIGSEGV |
| ConcurrentHashTable(lock-free) | JFR/SymbolTable/StringTable 的底层——per-bucket mutex(非全局锁) + CAS resize(支持并发 insert 和 resize), 双重哈希(用于 grow 时 rehash)。Java String intern→SymbolTable→ConcurrentHashTable——intern 的性能依赖此实现 |

### 🟡 Working (2 KP)
| KP | 为什么 🟡 |
|----|---------|
| Output streams | tty/gclog_or_tty/stringStream——所有 GC log/error message/diagnostic 的管道 |
| BitMap + GrowableArray | 基础数据结构——广泛使用(GC/Graal编译器/Metaspace), 但非独立机制 |

### 🟢 Surface (3 KP)
| KP | 为什么 🟢 |
|----|---------|
| UTF-8/JNI 类型 | 字符编码、基本类型——JVM Spec 定义 |
| JSON/ELF decoder | 仅用于 JFR/Logging 输出——边缘用例 |
| macros.hpp | 编译期平台宏——无运行时逻辑 |

## 04 聚类 — 4篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | vmError crash handler | "JVM crash(SIGSEGV) → hs_err_pid.log 怎么生成？error reporting token 怎么防止多线程覆盖？" |
| 2 | ConcurrentHashTable + BitMap | "ConcurrentHashTable 怎么做到 lock-free insert/lookup？BitMap 怎么用 1 bit 标记 heap word？" |
| 3 | Output streams + 异常系统 | "tty/gclog/stringStream 抽象层——JVM 怎么管理所有输出管道？Exceptions::debug_check_abort 怎么挂调试器？" |
| 4 | UTF-8 + JSON + decoder | "JVM 怎么编码 UTF-8？JSON 怎么输出 JFR recording？ELF decoder 怎么从地址→函数名？" |

**聚类决策**: 核心四叉——(1)vmError 是 JVM crash 的唯一诊断(2)ConcurrentHashTable+BitMap 是所有并发场景的基础数据结构(3)Output+Exceptions 是 JVM 诊断输出的骨架(4)UTF-8+JSON+Decoder 是字符/格式/栈回溯的工具链。每篇40-60行——四篇覆盖 ~25K 行 utilities。
