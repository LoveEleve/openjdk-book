# 05. 消费者 API — RecordingFile 解析、RecordedEvent 访问

> 🟡 Working | 域 39 JFR 第 5 篇(巨型域 6 篇之五)| Layer 4
> 读者处境: 生产自动化分析 .jfr 文件——读取与解析,事件数据怎么取。

### 1. "RecordingFile 流式读取" — 解析入口

场景: 脚本读 .jfr 文件——API 怎么用?

- `consumer/RecordingFile.java:105` 构造(Path)/`121` `readEvent()`/`143` `hasMoreEvents()`/`239` `readAllEvents(静态)`
- 流式: 逐个事件读(不整文件加载)——大文件内存友好
- 底层: 解析器族(consumer 包: Parser/EventParser/ChunkParser/ConstantMap)
- 关键设计 (斜体): *"流式读取 = 逐事件解析"——JFR 文件按 Chunk 组织(时间分块),解析器惰性展开;面试"JFR 文件结构"——Chunk + 事件记录*
- 生产: 批量分析脚本(读事件 → 统计)
- [关联: 内部卷 32-jfr(文件格式的 native 侧)]

### 2. "RecordedEvent 访问" — 事件数据

场景: 拿到事件后怎么取字段?

- `consumer/RecordedEvent.java` — `getStartTime()`(91)/`getValue(String)`/`getString("field")`/`getEventType()`
- `RecordedObject` — 字段访问基类(按名称/索引)
- 类型: getDuration/getInt/getClass 等按需转换
- 关键设计 (斜体): *"RecordedEvent = 已解析事件的只读视图"——字段按名访问;面试"事件数据怎么读"——getValue 家族*
- 生产: 统计脚本/自定义分析工具

### 3. "解析架构" — consumer 包

场景: 读取的性能与结构——解析器怎么组织?

- `consumer/` 内部: Parser(值解析)/EventParser(事件记录解析)/ChunkParser(分块)/ParserFactory(类型→解析器)/ConstantMap(常量池)
- 结构: 类型表(ConstantPool)→ 事件记录(引用类型 id)
- 惰性: 只解析被访问的字段(部分字段访问优化)
- 关键设计 (斜体): *"解析器按类型表 + 事件流组织"——JFR 文件是自描述的(类型定义在事件前);面试"为什么 JFR 文件小"——类型表 + 常量池 + 紧凑编码*
- 面试: "RecordedObject vs RecordedEvent"——基类/子类(事件特有方法)

### 4. "分析工具链" — 产出与展示

场景: .jfr 文件怎么变成可读报告?

- jfr 工具(jdk.jfr 模块内含命令行,JDK 自带): 汇总事件
- JDK Mission Control(JMC,内部卷 00 工具域)— 可视化分析(GC/锁/分配火焰图)
- 程序内: RecordingFile API 自定义分析
- 关键设计 (斜体): *"JFR 是采集,分析靠工具"——JMC/脚本双通道;面试"JFR 怎么分析"——JMC 打开 .jfr 或 API 读取*
- 生产: 事故复盘先看 JFR(事件回放)
- [内部卷: 00-jvm-tools(JMC)]

---

### 核心悬念

API 全通了——**生产怎么落地**?jcmd 开录制、飞行记录怎么用、JFR 的性能开销到底多少、与监控系统怎么集成——下一篇: 生产实践。

> → [06-production-practice.md](06-production-practice.md)
