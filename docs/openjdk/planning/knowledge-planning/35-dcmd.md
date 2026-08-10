# 域 35: Diagnostic Commands — 知识规划

> 源码: services/diagnosticArgument.* + diagnosticCommand.* + diagnosticFramework.* | 7文件 | 🟡 普通域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| services/diagnosticCommand.hpp/cpp + diagnosticCommand_ext.hpp | **DCmd — ~30 内置命令**: VM.version/VM.flags/GC.run/GC.class_histogram/Thread.print/JFR.start/VM.native_memory 等, DCmdFactory 注册所有命令, 每命令继承 DCmdWithParser | High |
| services/diagnosticFramework.hpp/cpp | **DCmd Framework**: DCmd(基类), DCmdParser(参数解析 DCmdArgument), DCmdRegistrant(命令注册), JMM interface for jcmd | High |
| services/diagnosticArgument.hpp/cpp | **DCmdArgument — 参数系统**: jlong/jboolean/string/array 多类型参数, 每个 argument 有 name+description+type+default value | Medium |

*3 知识点*

## 02 聚合 — P1/P2

### P1
| KP | 出现文件 |
|----|---------|
| DCmd Framework (register/parse/execute) | diagnosticFramework.*, diagnosticCommand.*(所有注册命令) |

### P2
| KP | 出现文件 |
|----|---------|
| DCmdArgument 参数系统 | diagnosticArgument.*, diagnosticCommand.cpp(各命令注册的参数) |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| DCmd Framework + 命令注册 | jcmd 的唯一实现——通过 DCmdFactory 静态注册所有 ~30 命令到全局 DCmd table, jcmd 输入文本→DCmdParser 解析→dispatch to command→execute()。每命令有 name+description+arguments, 框架处理参数验证+帮助输出+JMX 连接+输出流重定向 |

### 🟡 Working (1 KP)
| KP | 说明 |
|----|------|
| DCmdArgument 类型系统 | 多类型参数: jlong/jboolean/string/MemorySize/array |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | DCmd Framework | "jcmd <pid> Thread.print 怎么走到 DCmd 执行？命令怎么注册？" |
| 2 | 内置命令详解 | "jcmd 可以做什么？VM.flags/GC.run/JFR.start/Thread.print 怎么工作？" |
