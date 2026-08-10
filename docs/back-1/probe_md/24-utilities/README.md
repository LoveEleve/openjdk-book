# 24 — 基础数据结构与诊断工具 — libjvm.so (utilities/)

## §〇 概述

分析 HotSpot 基础工具库，101 个源文件 (~26K 行)。被几乎所有子系统共享依赖（GrowableArray 出现 4,700+ 次引用，Hashtable 800+ 次）。

**源码路径**：`src/hotspot/share/utilities/`

### BUILD_LIBRARY

属于 libjvm.so 内部编译：
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

---

## §一 架构概览

```
utilities/ (101 files, ~26K lines)
│
├── 核心容器 (6,531 lines) ── 被全部子系统依赖
│   growableArray      645行  动态数组 (GenericGrowableArray → GrowableArray)
│   hashtable           917行  哈希表基类 (BasicHashtable → Hashtable)
│   concurrentHashTable 1820行 无锁并发哈希表 (ConcurrentHashTable + MultiGet)
│   linkedlist          421行  双向链表模板
│   stack               490行  栈容器
│   bitMap             1501行  位图 (BitMap + ArenaBitMap + CHeapBitMap)
│   globalCounter       214行  全局纪元计数器 (RCU 退化版)
│   singleWriterSynchronizer 222行 单写者同步器
│   resourceHash        179行  Resource Obj 哈希
│   chunkedList          81行  分块链表
│   pair                 41行  Pair 值对
│
├── 流式输出 (4,653 lines)
│   ostream            1451行  输出流体系 (outputStream → stringStream/bufferedStream/fdStream)
│   xmlstream           702行  XML 流输出
│   json                800行  JSON 格式化
│   macros              674行  位操作/对齐/断言宏
│   utf8                658行  UTF-8 编解码
│   formatBuffer        157行  格式化缓冲区 (%d/%s)
│   stringUtils         112行  字符串工具
│   defaultStream        99行  默认流 (tty/stdout)
│   align               152行  对齐原语
│   bytes                53行  字节序交换
│   quickSort           130行  快排模板
│   copy                622行  memcpy 包装
│
└── 调试诊断 (6,525 lines)
    debug               989行  断言框架 (assert/guarantee/fatal)
    vmError            2072行  hs_err 崩溃报告 (步骤引擎+20个子步骤)
    elfFile             568行  ELF 文件解析器
    elfSymbolTable      182行  符号表查找
    elfFuncDescTable    224行  函数描述符表 (ppc64)
    elfStringTable      151行  字符串表
    decoder             289行  地址→符号解码
    decoder_elf         134行  ELF 特定解码
    nativeCallStack     231行  原生调用栈
    events              410行  事件记录
    ticks               387行  纳秒时间戳
    spinYield           148行  自旋等待
    histogram           202行  直方图
    intHisto            142行  整数直方图
    numberSeq           396行  数值序列
```

---

## §二 文档拆分规划

| 编号 | 标题 | 源文件数 | 源码行数 | 状态 |
|:---:|------|:---:|:---:|:---:|
| 00 | Core Containers & Concurrent | 11 | ~6,500 | 待开始 |
| 01 | Streams & Output | 12 | ~4,650 | 待开始 |
| 02 | Debug & Diagnostic | 15 | ~6,500 | 待开始 |

### doc-00 详情：Core Containers & Concurrent

growableArray, hashtable, concurrentHashTable, linkedlist, stack, bitMap, globalCounter, singleWriterSynchronizer, resourceHash, chunkedList, pair

**关键问题**：
- Hashtable vs ConcurrentHashTable 的并发设计哲学差异
- GrowableArray 的 2× 扩容策略与内存碎片
- BitMap 的三层阶梯 (BitMap→ArenaBitMap→CHeapBitMap)
- globalCounter 作为退化 RCU 的写端临界区
- singleWriterSynchronizer 的 lock-free 读者保证

### doc-01 详情：Streams & Output

ostream, xmlstream, json, formatBuffer, macros, utf8, stringUtils, defaultStream, align, bytes, quickSort, copy

**关键问题**：
- outputStream 虚函数体系 (write()/flush()/position() 多态)
- stringStream 与 bufferedStream 的差异
- fdStream 的 POSIX write(2) 包装
- xmlstream/json 的 SAX 式非缓冲输出
- macros.hpp 的位操作实现 (exact_log2/round_up_power_of_2)

### doc-02 详情：Debug & Diagnostic

debug, vmError, elfFile, elfSymbolTable, elfFuncDescTable, elfStringTable, decoder, decoder_elf, nativeCallStack, events, ticks, spinYield, histogram, intHisto, numberSeq

**关键问题**：
- assert/guarantee/fatal 的三层严重级别与 os::abort 路径
- vmError 的步骤引擎 (20+ 子步骤) 和信号安全保证
- ELF 解析器的 dladdr() 替代方案
- decoder 的多后端架构 (ELF/demangle/frame pointer)
- nativeCallStack 的栈行走实现

---

## §三 旧文档重叠

- `libjvm-analysis/` 大量引用 GrowableArray/Hashtable/BitMap 但从未分析它们的内部实现
- `libjvm-analysis/10-services-diag/04-VMError-hs_err.md` 跟 vmError.cpp 重叠——需标记互补关系
- 新文档覆盖 utilities/ 源码内部实现，旧引用标记互补

---

## §四 待完成

- [x] 分类 101 文件
- [x] 确定 BUILD_LIBRARY 引用 (CompileJvm.gmk:153)
- [ ] 写 prompt（并行 3 篇）
- [ ] 新会话生成文档
- [ ] Review
