# async-profiler 卷总览

> 状态：正式写作已完成 24 篇目录式文章；AP-0~AP-6 主题版图已全部收束，且 AP-1~AP-3、AP-4 前半、AP-5、AP-6 已完成至少一轮 `rewrite-plan -> deep review -> rewrite`；当前主战场已转为 `00-usage/*` 与 `04-stack-symbols/03-04` 的回炉，以及全卷一致性精修
> 位置：`openjdk-book/docs/openjdk/vol-async-profiler/`
> 主题：从 build/attach、事件选择、输出与 Arthas 衔接，到 native 采样、栈行走、符号解析、存储与输出链路的全链路

## 当前目录结构

### 00 使用与衔接

- [01. 先跑起来，再看原理 —— 构建、attach 与第一次采样](./00-usage/01-build-attach.md)
- [02. 先选问题类型，再选事件 —— 事件与采样参数](./00-usage/02-events-options.md)
- [03. 先决定给谁看，再决定输出什么 —— 输出格式与火焰图读法](./00-usage/03-output-flamegraph.md)
- [04. 先分清谁负责全景，谁负责下钻 —— 与 Arthas 的衔接与生产场景](./00-usage/04-arthas-integration.md)

### 01 启动与 attach

- [01. 不重启 JVM，先把采样器挂进去 —— 构建、attach 与入口总链](./01-startup-attach/01-build-attach.md)
- [02. 事件、格式与参数结构 —— `arguments.cpp` / `arguments.h` 的配置体系](./01-startup-attach/02-arguments-struct.md)
- [03. 不带 JDK 也能 attach —— `jattach`、`fdtransfer` 与权限桥](./01-startup-attach/03-attach-fdtransfer.md)

### 02 采样核心

- [01. 信号响起的一瞬间 —— 采样主路径与 `recordSample`](./02-sampling-core/01-sampling-core.md)
- [02. 事件从哪来？—— CPU、alloc、lock、wall 的引擎分流](./02-sampling-core/02-event-engines.md)
- [03. alloc 事件的两条轨道 —— JVM 分配事件与 native 分配钩子](./02-sampling-core/03-allocation-events.md)
- [04. 锁等待与墙钟阻塞 —— lock、wall-clock 与节流](./02-sampling-core/04-lock-wall-events.md)

### 03 JVM 集成

- [01. 从 `Agent_OnLoad` 到 JVMTI 回调 —— async-profiler 的 JVM 集成总图](./03-jvm-integration/01-agent-jvmti.md)
- [02. 手写字节码改写器 —— BytecodeRewriter 与重定位表](./03-jvm-integration/02-bytecode-rewriter.md)
- [03. 不写死 JVM 版本 —— VMStructs、三种栈行走与 CodeCache](./03-jvm-integration/03-vmstructs-stackwalk.md)
- [04. Java API 的 native 侧 —— execute0、execute1 与 RegisterNatives](./03-jvm-integration/04-java-api-bridge.md)

### 04 栈与符号

- [01. 只有 PC 和寄存器，怎么走出调用链？——寄存器访问与安全行走](./04-stack-symbols/01-register-walking.md)
- [02. 地址到符号名 —— ELF 解析、归属定位与 demangle](./04-stack-symbols/02-symbol-resolution.md)
- [03. 地址链变成人话 —— FrameName、Java 方法与类型后缀](./04-stack-symbols/03-frame-naming.md)
- [04. 信号里不能 malloc，采样数据放哪？——无锁存储、调用栈去重与溢出](./04-stack-symbols/04-storage-alloc.md)

### 05 输出格式

- [01. 采样数据怎样变成一张 HTML？——FlameGraph、压缩帧流与浏览器交互](./05-output-formats/01-flamegraph-html.md)
- [02. 不依赖 JDK API，怎样写出 JFR？——Recording、事件缓冲与 JfrSync](./05-output-formats/02-jfr-recorder.md)
- [03. 机器怎样读这些采样？——OTLP Profiles、手写 protobuf 与直接/离线两条转换链](./05-output-formats/03-otlp-converter.md)

### 06 Java API

- [01. 一次 `getInstance()`，怎么把 `.so` 变活？——Java API 入口、五级找库与字符串协议](./06-java-api/01-java-api.md)
- [02. native 注进去以后，Java 谁来接？——Instrument、LockTracer、Recording/Span 与 helper 闭环](./06-java-api/02-helper-closure.md)

## 写作约定

- 目录风格对齐 `vol-02` / `vol-java`：`主题目录/01-xx.md`
- 每篇保留：场景、源码锚点、关键设计、跨层标注、后续桥接
- 继续扩写时，优先按 `source-analysis/async-profiler/outlines/` 的主题目录推进

## 下一步建议

- 不要再补主题版图；优先把 `00-usage/*` 与 `04-stack-symbols/03-frame-naming.md`、`04-stack-symbols/04-storage-alloc.md` 纳入 `rewrite-plan -> deep review -> rewrite`。
- `05-output-formats/*` 与 `06-java-api/*` 已进入二轮 deep review / consistency pass 候选集，后续应以术语统一、桥接补强和残余结构修正为主。 
