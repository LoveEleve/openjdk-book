# 05. 消费者 API — RecordingFile 解析、RecordedEvent 访问

> **前置依赖**: [39-jfr/04 — 录制与配置](04-recording-config.md)(Recording 与 .jfr 文件)
> → **后续**: [06-production-practice.md](06-production-practice.md)
> 关联: 内部卷 32-jfr(文件格式的 native 侧)

## .jfr 文件怎么读

前四篇讲完了录制侧——这一篇看消费侧: 怎么流式读取 .jfr 文件、事件数据怎么取、解析器怎么组织、以及分析工具链。

## 1. "RecordingFile 流式读取" — 解析入口

### 1.1 API 入口

`RecordingFile`(`jdk/jfr/consumer/RecordingFile.java`):

| 方法 | 锚点 | 作用 |
|------|------|------|
| `RecordingFile(Path)` | `:105` | 打开 .jfr 文件 |
| `readEvent()` | `:121` | 读下一个事件(无则抛 EOFException——Javadoc `:117-118`) |
| `hasMoreEvents()` | `:143` | 是否还有事件 |
| `readAllEvents(Path)`(静态) | `:239` | 一次读全部 |

**流式**: 逐个事件读,不整文件加载——大文件内存友好。

### 1.2 底层解析器族

consumer 包: `ChunkParser`(分块)/`EventParser`(事件记录)/`Parser`(值)/`ParserFactory`(类型→解析器)/`ConstantMap`(常量池)。

JFR 文件按 **Chunk** 组织(时间分块)。

面试"JFR 文件结构": Chunk + 事件记录;生产: 批量分析脚本(读事件 → 统计)。

关键设计(斜体):*"流式读取 = 逐事件解析"——JFR 文件按 Chunk 组织(时间分块),解析器流式展开(事件级按需解析)。面试"JFR 文件结构": Chunk + 事件记录;生产: 批量分析脚本(读事件 → 统计)。*

## 2. "RecordedEvent 访问" — 事件数据

### 2.1 只读视图

`RecordedEvent`(`RecordedEvent.java:41`,extends `RecordedObject`)——已解析事件的只读视图: `getStartTime()`(`:91`)/`getEndTime()`(`:102`)/`getDuration()`(`:111`)。

### 2.2 字段访问

`RecordedObject`(`RecordedObject.java:52`)提供按名访问: `getValue(String)`(泛型 `<T> T`,按名取值——`:166`;Javadoc 示例 `:141`)/类型化取值家族(`getBoolean` `:328`/`getInt` `:464`/`getString` `:668`/`getDuration` `:695` 等)/`hasField`(`:102`);嵌套字段(点号路径)经 `getValue` 递归查找(`:114`)。

面试"事件数据怎么读": getValue 家族(按名访问);生产: 统计脚本/自定义分析工具。

关键设计(斜体):*"RecordedEvent = 已解析事件的只读视图"——字段按名访问。面试"事件数据怎么读": getValue 家族;生产: 统计脚本/自定义分析工具。*

## 3. "解析架构" — consumer 包

### 3.1 值数组视图

`RecordedObject` 持有 `Object[] objects`(`RecordedObject.java:66`,构造 `:71` 传入)——字段值在**事件解析时已全部解码**(`EventParser` 解码后构造,`EventParser.java:67`),RecordedObject 是**值数组的只读视图**;嵌套对象(RecordedClass 等)在访问时包装。

### 3.2 文件自描述

结构: 类型表(常量池,`ConstantMap`)→ 事件记录(引用类型 id)。

面试"为什么 JFR 文件小": 类型表 + 常量池 + 紧凑编码(内部卷 32-jfr);面试"RecordedObject vs RecordedEvent": 基类/子类——RecordedEvent 事件特有方法(startTime/duration 等)。

关键设计(斜体):*"解析器按类型表 + 事件流组织"——JFR 文件是自描述的(类型定义在事件前)。面试"为什么 JFR 文件小": 类型表 + 常量池 + 紧凑编码;面试"RecordedObject vs RecordedEvent": 基类/子类(事件特有方法)。*

## 4. "分析工具链" — 产出与展示

### 4.1 工具

- **jfr 工具**: JDK 自带命令行(`jdk/jfr/internal/tool/Main.java:36`)——汇总事件
- **JMC**(JDK Mission Control,域外工具)— 可视化分析(GC/锁/分配)
- **程序内**: RecordingFile API 自定义分析

面试"JFR 怎么分析": JMC 打开 .jfr 或 API 读取;生产: 事故复盘先看 JFR(事件回放)。

关键设计(斜体):*"JFR 是采集,分析靠工具"——JMC/脚本双通道。面试"JFR 怎么分析": JMC 打开 .jfr 或 API 读取;生产: 事故复盘先看 JFR(事件回放)。*

跨层标注: [内部卷 32-jfr——文件格式(native 写入侧)与紧凑编码;39/04 §4——录制数据落盘与 .jfr 文件]

## 核心悬念

API 全通了——**生产怎么落地**?jcmd 开录制、飞行记录怎么用、JFR 的性能开销到底多少、与监控系统怎么集成——下一篇: 生产实践。

> → [06-production-practice.md](06-production-practice.md)