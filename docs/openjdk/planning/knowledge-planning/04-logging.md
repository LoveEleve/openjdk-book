# 域 04: Logging — 知识规划

> 源码路径: hotspot/share/logging/
> 源码量: 37 文件 / 5,292 行 | 非巨型域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| logTag.hpp:50-120 + logTag.cpp | **LogTag — 层次化标签体系**: 60+ 标签(add/age/alloc/annotation/aot/arguments/attach/barrier/biasedlocking/bytecode/cds/census/ci/class/classhisto/cleanup/codecache/compaction/compilation/constraints/container/coops/cpu/cset/dcmd/defaultmethods/director/ergo/exceptions/exit/freelist/gc/gc+heap/gc+region/gc+task/heap/heapdump/ihem/jfr/jit/jni/jvmti/liveness/load/loader/malloc/metadata/metaspace/memops/memprofiler/memtrack/methodcomparator/methodhandles/module/monitorinflation/monitormismatch/nmt/null+provocation/objecttagging/obsolete+method/os/padding/page/pagesize/parser/path/pathtree/perf/phases/plab/preorder/verification/promotion/protectiondomain/purge/redefine/ref/remset/resize/safepoint/sampling/scavenge/smc/stacktrace/start/startuptime/state/stats/stringdedup/stringtable/subtaskset/survivor/sweep/task/thread/thread+smr/time/tlab/unloading/update/verification/vmoperation/vtables/workgang) | High |
| logTagSet.hpp:40-140 + logTagSet.cpp + logTagSetDescriptions.* | **LogTagSet — 标签集合与匹配**: LogTagSet(5个标签上限), 标签集合的声明和描述, 支持 tagset=gc+region+task 复合查询 | High |
| logLevel.hpp + logLevel.cpp | **LogLevel — 六级日志等级**: Trace/Debug/Info/Warning/Error/Off, level优先级比较(<=), LogLevelType枚举, 等级名解析 | High |
| logSelection.hpp + logSelection.cpp + logSelectionList.hpp + logSelectionList.cpp | **LogSelection — 标签+等级选择器**: "gc*=debug,class+load=info" 解析→LogSelectionList, 支持通配符(*=wildcard), 标签名解析 | High |
| logOutput.hpp + logOutput.cpp + logOutputList.hpp + logOutputList.cpp | **LogOutput — 多输出目标**: LogOutput(抽象基类, fd/describe/config_string), LogOutputList(多输出链表), decorator装饰器前置+output+后置清理 | High |
| logFileOutput.hpp + logFileOutput.cpp + logFileStreamOutput.hpp + logFileStreamOutput.cpp | **FileOutput — 文件输出 + 轮转**: LogFileOutput(单文件), LogFileStreamOutput(流式), rotate(日志轮换——size/信号驱动), 文件名模板解析(%p=pid, %t=time) | High |
| logDecorations.hpp + logDecorations.cpp + logDecorators.hpp + logDecorators.cpp | **LogDecorations — 日志装饰**: 13种装饰(level/tags/time/uptime/uptimemillis/timemillis/timenanos/pid/tid/hostname/decorations), 装饰格式化和缓存 | High |
| logConfiguration.hpp + logConfiguration.cpp | **LogConfiguration — 运行时重配置**: configure_outputs, parse_log_arguments, 从 -Xlog 参数→LogSelectionList→LogOutput配置, 支持运行时 jcmd 修改 | High |
| logMessageBuffer.hpp + logMessage.hpp + logMessageBuffer.cpp | **LogMessage — 日志消息缓冲**: LogMessageBuffer(1024B栈上buffer), LogMessage(流式消息构建器), 序列化/异步写入 | Medium |
| logStream.hpp + logStream.cpp | **LogStream — 异步日志流**: outputStream→LogStream适配, 多行日志的缓冲收集, flush机制 | Medium |
| logHandle.hpp | **LogHandle — 每TagSet的便捷句柄**: LogTargetHandle(模板), 在编译时指定tags, 避免运行时tag字符串查找 | Medium |
| logDiagnosticCommand.hpp + logDiagnosticCommand.cpp | **LogDiagnosticCommand — jcmd VM.log集成**: 运行时修改LogConfiguration, jcmd VM.log list/disable/enable/output/decorators/what | Medium |
| logPrefix.hpp | **LogPrefix — 前缀生成**: 装饰器前缀的生成和缓存 | Low |

*13 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识 (≥5 文件)

| KP | 出现文件 |
|----|---------|
| LogTag 层次体系 + TagSet | logTag.hpp.cpp, logTagSet.hpp.cpp, logTagSetDescriptions.*, logSelection.hpp.cpp, logConfiguration.cpp — 作为所有日志过滤的主索引 |
| LogOutput 多输出目标 | logOutput.hpp.cpp, logOutputList.*, logFileOutput.*, logFileStreamOutput.*, logConfiguration.cpp — 所有日志消息的最终输出点 |

### P2 — 局部重要 (2-4 文件)

| KP | 出现文件 |
|----|---------|
| LogLevel 六级等级 | logLevel.hpp.cpp, logSelection.cpp, logDecorators.cpp |
| LogSelection 解析器 | logSelection.hpp.cpp, logSelectionList.*, logConfiguration.cpp |
| LogDecorations 装饰体系 | logDecorations.hpp.cpp, logDecorators.hpp.cpp, logPrefix.hpp |
| LogConfiguration 运行时重配置 | logConfiguration.hpp.cpp, logDiagnosticCommand.* |
| LogMessage 消息缓冲 | logMessageBuffer.*, logMessage.hpp, logStream.* |

### P3 — 孤立 (1 文件)

| KP | 文件 |
|----|------|
| LogHandle 便捷句柄 | logHandle.hpp |
| LogDiagnosticCommand | logDiagnosticCommand.hpp.cpp |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (3 KP)

| KP | 为什么 🔴 |
|----|---------|
| LogTag 层次体系 + TagSet | **架构决策**: 为什么用标签(tag)而不是模块(module)？→ GC 的日志可能跨多个子系统(heap+region+task)——标签组合(tagset)比单一模块名更灵活。60+ 标签的层次化组织——gc 大类下有 gc+heap, gc+region, gc+task 子标签——比固定模块列表更易扩展。为什么 TagSet 限制 5 个标签？→ 大多数日志场景 2-3 个标签足够, 5 个上限控制了匹配复杂度 |
| LogSelection + LogOutput 管道 | **选择+输出分离**: "gc*=debug:gc.log::filesize=10M" 的解析流程——标签选择器(哪些消息要输出)→等级过滤器(debug及以上)→输出目标(file/stderr/stdout)→输出选项(轮转大小/文件数)。整个管道的前端(选择)和后端(输出)完全解耦——新增输出目标不影响选择器 |
| LogConfiguration 运行时重配置 | **热修改**: jcmd VM.log 修改配置而不重启——为什么不用日志库(如 log4j)？→ JVM 启动早于任何 JVM-based 日志库, 且需要 OS-level 信号驱动日志轮转 (SIGUSR1/SIGUSR2) |

### 🟡 Working — 有设计但非核心 (5 KP)

| KP | 说明 |
|----|------|
| LogDecorations 13种装饰 | 灵活但简单——格式化的装饰系统 |
| LogFileOutput + rotate | 日志文件轮转——size/signal两种触发 |
| LogMessageBuffer 栈上缓冲 | 1024B固定缓冲区——避免malloc |
| LogStream 异步流 | outputStream适配——非阻塞 |
| LogDiagnosticCommand | jcmd集成——标准的DiagnosticCommand子类 |

### 🟢 Surface — 了解即可 (5 KP)

| KP | 说明 |
|----|------|
| LogLevel 六级 | 标准日志等级——无需深挖 |
| LogHandle 模板 | 语法糖——编译时TagSet绑定 |
| LogPrefix | 前缀生成簿记 |

## 04 聚类 — 教学顺序与文章拆分

### 依赖图

```
A: LogTag体系 — 无前置
  └─ B: LogSelection — 依赖A (tag=value语法解析)
       └─ C: LogOutput — 依赖B (选择的标签+等级决定哪些消息到哪些输出)
            └─ D: LogDecorations — 依赖C (输出前的装饰)
                 └─ E: LogConfiguration — 依赖B+C+D (组合选择+输出+装饰)

F: 辅助 — LogHandle/LogDiagnosticCommand — 依赖整个体系
```

### 教学顺序

```
1. Tag体系 + Selection — 标签定义 + 过滤语法 (A+B)
2. Output + Decorations + Configuration — 输出管道 + 装饰 + 运行时管理 (C+D+E+F)
```

### 文章拆分建议

2 篇（37文件/5292行, 小型域）:

- **01-tag-and-selection.md** — Tag体系 + LogLevel + LogSelection 解析器
- **02-output-and-configuration.md** — Output管道 + Decorations + Configuration + jcmd集成
