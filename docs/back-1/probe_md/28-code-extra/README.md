# 28 — 代码缓存剩余 — libjvm.so (code/)

## §〇 概述

补充分析 code/ 中 47 文件（~25K 行）里尚未深度覆盖的 compiled code 内部机制。

**源码路径**：`src/hotspot/share/code/`

### BUILD_LIBRARY

属于 libjvm.so 内部编译：
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

---

## §一 已覆盖 vs 待覆盖

```
code/ (47 files, ~25K lines)

✅ 已覆盖:
  codeCache.cpp/hpp (1,768+414)    → 01-jvm-startup/01-CodeCache.md
  codeBlob.cpp/hpp (681+729)       → 部分在 CodeCache 文档
  stubs.cpp/hpp (242+218)          → 部分在 stub 文档
  compiledMethod 高层               → 已被引用但实现未深入

⏳ 待覆盖 — Phase 28 目标:
  nmethod.cpp/hpp              2995+671   nmethod 完整布局 + 生命周期
  compiledMethod.cpp/hpp/inline   636+423   CompiledMethod 中间层
  dependencies.cpp/hpp          2185+815   编译依赖管理系统
  dependencyContext.cpp/hpp      273+154   依赖上下文
  compiledIC.cpp/hpp             720+437   编译后内联缓存 (IC stub)
  icBuffer.cpp/hpp               234+146   IC 缓冲区
  exceptionHandlerTable.cpp/hpp  231+166   异常处理表编码
  debugInfo.hpp/cpp              304+289   调试信息抽象
  debugInfoRec.hpp/cpp           211+441   调试信息记录器
  scopeDesc.hpp/cpp               137+259   Scope 描述符 (内联帧)
  pcDesc.hpp/cpp                  99+63    PC → Scope 映射
  oopRecorder.hpp/cpp            260+204   Oop 记录器
  compressedStream.hpp/cpp       160+252   压缩流编码
  relocInfo.hpp/cpp             1394+991   重定位信息
  codeHeapState.hpp/cpp          240+2563  CodeHeap 状态分析
  vtableStubs.hpp/cpp            184+328   Vtable 桩代码
```

---

## §二 文档拆分规划

| 编号 | 标题 | 源文件数 | 源码行数 | 状态 |
|:---:|------|:---:|:---:|:---:|
| 00 | nmethod Layout & Lifecycle | 4 | ~5,500 | 待开始 |
| 01 | Debug Info & Metadata | 9 | ~3,500 | 待开始 |
| 02 | Dependencies, IC & Exceptions | 7 | ~5,500 | 待开始 |

### doc-00: nmethod Layout & Lifecycle

nmethod.cpp/hpp + compiledMethod.cpp/hpp/inline + codeBlob 剩余

**关键问题**：
- nmethod 三段内存布局：header (nmethod struct) → code section → metadata section (scopes, dependencies, oopmap, reloc)
- nmethod 状态机：in_use → not_entrant → zombie → unloaded
- make_not_entrant/make_zombie() 的 GC safepoint 协作
- CompiledMethod::cleanup_inline_caches() 和 flush_dependencies()

### doc-01: Debug Info & Metadata

debugInfo.hpp/cpp + debugInfoRec.hpp/cpp + scopeDesc.hpp/cpp + pcDesc.hpp/cpp + oopRecorder.hpp/cpp + compressedStream.hpp/cpp + relocInfo.hpp/cpp

**关键问题**：
- debugInfoRec::describe_scope() 的递归 scope 记录
- scopeDesc 树形内联帧 → PC → Java 栈帧映射
- pcDesc 的二分查找：find_pc_desc() → ScopeDesc → vframeArray
- relocInfo 的 8 种重定位类型和紧凑编码
- compressedStream 的 4 字节对齐无损压缩

### doc-02: Dependencies, IC & Exceptions

dependencies.cpp/hpp + dependencyContext.cpp/hpp + compiledIC.cpp/hpp + icBuffer.cpp/hpp + exceptionHandlerTable.cpp/hpp

**关键问题**：
- Dependencies 类型系统：20+ DepType (evol_method, leaf_type, unique_concrete_method...)
- dependencies::DepStream 的状态机解码
- dependencyContext::find_dependency() 的线性搜索
- compiledIC 的 IC stub 补丁机制 (MonomorphicIC/MegamorphicIC)
- icBuffer 的 stub 分配和 patching
- exceptionHandlerTable 的变长编码格式

---

## §三 旧文档重叠

- `libjvm-analysis/05-jit-compiler/04-CodeCache-Sweeper.md` — nmethod 生命周期高层
- `libjvm-analysis/05-jit-compiler/06-OopMap-GC-Roots.md` — OopMap GC 扫描
- 新文档覆盖 code/ 内部数据结构和编码格式，旧引用互补

---

## §四 待完成

- [x] 遍历 code/ 确认遗漏文件
- [x] BUILD_LIBRARY 确认
- [x] 写 prompt（并行 3 篇）— 2026-06-20 完成
- [x] 新会话生成文档 — 3 agent 并行生成
- [x] Review — 3 agent 审计 + 3 agent 修复
