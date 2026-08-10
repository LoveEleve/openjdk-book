# 23 — 统一日志框架 — libjvm.so (logging/)

## §〇 上手指南

**这是什么**：HotSpot 统一日志系统（Unified Logging, `-Xlog` 背后的 C++ 实现），36 个源文件 ~4,600 行。

**为什么重要**：
- 贯穿 JVM 所有子系统的诊断基础设施
- `-Xlog:gc*, -Xlog:jit+class=debug` 等被生产环境广泛使用
- 理解日志实现是理解 JVM 运行时行为的前提

**源码路径**：`src/hotspot/share/logging/`

### BUILD_LIBRARY

属于 `libjvm.so` 内部，编译入口：

```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
```

logging/ 的 `.cpp` 文件作为 libjvm.so 的一部分统一编译，无独立 `.so` 目标。

---

## §一 源文件清单

| 文件 | 行数 | 角色 |
|------|:---:|------|
| **logConfiguration.hpp/cpp** | 128/607 | 配置管理核心：解析 `-Xlog`、管理输出列表、监听回调 |
| **logTag.hpp/cpp** | 221/87 | Tag 定义（LogTag 枚举 + LogTagType 映射）|
| **logTag_ext.hpp** | 48 | 扩展 Tag 占位（jfr/等子系统加 tag）|
| **logTagSet.hpp/cpp** | 159/180 | TagSet 匹配引擎、判定日志是否输出 |
| **logTagSetDescriptions.hpp/cpp** | 36/42 | 列出所有已注册的 tag 集合 |
| **logLevel.hpp/cpp** | 82/59 | LogLevel 枚举 + 类型信息 |
| **logOutput.hpp/cpp** | 104/341 | 输出抽象基类 + 管理 |
| **logOutputList.hpp/cpp** | 145/128 | 输出列表容器 |
| **logFileOutput.hpp/cpp** | 99/454 | 文件输出（含 rotate 大小/数量）|
| **logFileStreamOutput.hpp/cpp** | 93/107 | 文件流输出（默认 stdout/stderr）|
| **logStream.hpp/cpp** | 108/123 | LogStream — 类似 ostream 的日志写入接口 |
| **log.hpp** | 201 | 日志宏定义层（LogTarget/LogMessage 体系）|
| **logHandle.hpp** | 104 | LogHandle — 每个使用者的日志句柄 |
| **logMessage.hpp** | 105 | LogMessage — 延迟格式化包装 |
| **logMessageBuffer.hpp/cpp** | 131/146 | 日志行缓冲区 |
| **logDecorations.hpp/cpp** | 67/136 | 日志装饰管理（time/level/tag/pid/tid）|
| **logDecorators.hpp/cpp** | 116/83 | 装饰器枚举 + 解析 |
| **logPrefix.hpp** | 119 | 前缀协议（跨行日志统一前缀）|
| **logSelection.hpp/cpp** | 74/351 | 选择器引擎：解析 `gc+class*=debug` |
| **logSelectionList.hpp/cpp** | 65/101 | 选择器列表 |
| **logDiagnosticCommand.hpp/cpp** | 69/97 | `VM.log` 诊断命令 |

---

## §二 架构概览

```
-Xlog:gc+class*=debug:file=gc.log:time,level,tags
  │            │       │          │        │
  Selection    Level   Output     Output   Decorations
  (what)       (when)  type       opts     (prefix)
                │
        ┌───────┼────────┐
        ▼                ▼
   LogSelection      LogSelectionList
        │                │
   ┌────┴────┐    ┌──────┴──────┐
   │ TagSet  │    │ Decoration[]│
   │ Level   │    │ Output[]    │
   └─────────┘    └─────────────┘
        │
   log_is_enabled()?
        │
        ▼ (YES)
   LogStream → logMessageBuffer → LogOutput::write()
```

**三层模型**：
1. **选择层**（what）— TagSet + Level 判定是否输出
2. **消息层**（how）— LogStream/LogMessage 构造消息文本
3. **输出层**（where）— LogOutput 子类写出消息

---

## §三 文档拆分规划

| 编号 | 标题 | 源文件 | 行数 | 状态 |
|:---:|------|------|:---:|:---:|
| 00 | Tag-Level-Selection-Configuration | logTag/Level/Set + logSelection + logConfiguration | ~1,700 | 待开始 |
| 01 | Output Pipeline | logOutput + logFileOutput + logFileStreamOutput | ~950 | 待开始 |
| 02 | Message Composition & Macros | logStream + logMessage + log.hpp + logHandle + logDecorations | ~870 | 待开始 |

**总源文件行数**（排除 .hpp 头，.cpp 实现）：~3,520 行

---

## §四 旧文档重叠

- `libjvm-analysis/01-jvm-startup/14-create_vm-Stage5-8-Deep-Dive.md` — 提及 LogConfiguration 在启动时的初始化切换
- 其他文档引用 `log_*` 宏使用但从不分析 logging 内部

新文档覆盖 logging/ 源码内部实现，旧引用标记为互补，不冲突。

---

## §五 待完成

- [x] 确定 BUILD_LIBRARY 引用（CompileJvm.gmk:153）
- [x] 统计源文件精确数量（36 文件, ~4,600 行）
- [ ] 写 prompt（并行 3 篇）
- [ ] 新会话生成文档
- [ ] Review
