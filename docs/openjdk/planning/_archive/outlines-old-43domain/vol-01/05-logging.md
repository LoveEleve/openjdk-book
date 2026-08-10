# Logging（日志系统）— 文章大纲

> vol-01 · 域 05 · 🟡 B | 2026-08-07 | 拓扑排序 #5
> 依赖：OS 抽象层（文件输出）+ Arguments（-Xlog 命令行解析）

## 叙事计划

**开篇场景**：JDK 8 的 GC 日志用 `-XX:+PrintGCDetails`，JDK 9+ 用 `-Xlog:gc*=info`。换的不只是语法——整个日志框架在 JDK 9 被重写了（JEP 158/271）。之前每个子系统各写各的日志，新框架统一了标签、级别、输出、格式四层，加一个 `-Xlog:gc+heap=debug:file=gc.log::filecount=5` 全搞定。

**第一层：标签与级别——怎么写和写什么**

`LogTagSet` 是标签的组合，每个 GC 日志行标记为 `[gc,heap]`。`LogLevel` 六档：`Trace < Debug < Info < Warning < Error < Off`。`-Xlog:gc+heap=debug` = 标签匹配 `gc` 且 `heap`，且级别 ≥ `debug` 的才输出。标签和级别的 AND/OR 组合逻辑由 `LogSelection` 解析。

**第二层：Decorator——每行的前缀**

`LogDecorators`：`time`（启动时间 ms）| `uptime`（运行时间）| `timemillis`（绝对时间）| `tid`（线程 ID）| `level`（级别）| `tags`（标签）。`-Xlog:gc*=info:stdout:time,level,tags` 控制输出格式。Decorator 是模板化的——编译期确定哪些字段可用，运行时按配置组合。

**第三层：Output——日志往哪去**

`LogOutput` 是抽象输出目标。`LogFileOutput` 写文件，支持轮转（`filecount=5,filesize=10M`）。`LogStdoutOutput` / `LogStderrOutput` 写终端。`LogOutputList` 让一个日志流同时到多个输出目标。注意坑：`-Xlog::file` 不支持命名管道（JDK-8215699）。

**第四层：生命周期——什么时候初始化**

`LogConfiguration::initialize()`（`logConfiguration.hpp:91`）在 `Arguments::parse()` 之前调用——需要日志来输出参数解析的错误。`post_initialize()`（`:95`）在 JVM 初始化完成后调用，此时 `-Xlog` 的最终配置生效。`parse_log_arguments()`（`:112`）解析 `-Xlog` 选项字符串——标签表达式、级别、decorator、输出目标都在这一步解析完。

**设计权衡**

一、统一框架 vs 分散开关。`-XX:+PrintGCDetails` 是分散的 bool 开关——每加一种日志加一个 flag。`-Xlog` 统一为 `tag+level+output` 三层语法，新增标签不需要新 flag。代价是旧的 GC 日志脚本要全部重写。

> **注**：异步日志（`AsyncLogWriter`/`-Xlog:async`）是本域在 JDK17+ 才引入的特性——JDK11 的 JEP 158 统一日志框架仅支持同步写入。JDK11 源码中 `grep -rn AsyncLog` 返回 0 结果。

## 核心悬念

**一行 `-Xlog:gc+heap=debug:file=gc.log::filecount=5` 怎么被解析成"什么级别的什么标签写到什么文件、最多保留几个"？**

**→ 下一域**：日志告诉你"GC 花了 5ms"，但你想知道"过去 10 秒 GC 累计花了多少时间"——jstat 的 `-gc` 就是干这个的。它不走网络、不调 RPC，靠一个 mmap 共享内存文件。PerfData 篇见。

## 预估

1 篇，4 层递进，预估 1000-1500 行。
