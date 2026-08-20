# 39-jfr/05 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `RecordingFile`、`RecordedEvent`、`RecordedObject`、consumer 解析器族。本文聚焦流式读取、自描述元模型与消费接口；生产落地放到下一篇。
> 目标：把“消费者 API”改写成一篇围绕“`.jfr` 文件真正值钱的不是能被落盘保存，而是它把录制侧的事件流变成了一份可流式、可结构化、可程序消费的自描述历史；消费 API 的关键不是把文件全读成对象，而是按 Chunk 和事件 Schema 逐步解析”展开的机制文章。

## 1. 读者困惑

- `.jfr` 文件写出来之后，程序到底怎么把它重新读成事件？
- 为什么 `RecordingFile` 要强调流式读取，而不是一次把整文件都拉进内存？
- `RecordedEvent`、`RecordedObject` 和事件类本身是什么关系，为什么消费端不需要你的业务事件类源码？
- JFR 文件为什么说是“自描述的”，类型表和字段 Schema 在消费端如何发挥作用？
- `jfr` 命令行工具、JMC 和自定义脚本为什么都能围绕同一份 `.jfr` 文件工作？

## 2. 一句话顿悟

**JFR 录制的终点不是一个难以理解的二进制文件，而是一份可被统一消费的事件历史。`RecordingFile` 负责按 Chunk 流式推进，`EventParser` 把二进制记录解码成 `RecordedEvent`，`RecordedObject` 再把字段暴露成按名访问的结构化只读视图。消费端真正依赖的不是业务事件类本身，而是录制文件里已经携带的事件类型 Schema 和字段描述。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 `RecordingFile`、`RecordedEvent`、`RecordedObject`、`EventParser` 与 `jfr` 工具入口这些关键点。
- 已指出 `.jfr` 按 Chunk 组织、消费侧流式解析，这对理解大文件处理很重要。
- 已把 `RecordedEvent` / `RecordedObject` 关系和按名访问说出来，方向正确。

### 必须重写

- 旧稿偏 API/组件清单，需要先立住总问题：录制文件为什么能变成“可程序消费的事件历史”。
- `RecordingFile`、`RecordedEvent`、`RecordedObject`、解析器族要统一到“流式 + 自描述”这条主线上。
- 要更明确讲出：消费端不依赖业务事件类源码，而依赖文件里的 Schema。
- 工具链部分要服务于“同一份事件历史可被不同消费者解释”，而不是再列工具名。

## 4. 理解路径

### 第一节：从“`.jfr` 文件写出来之后为什么还值得专门讲消费 API”开场

承接前四篇：录制已经完成。继续追问——为什么 JFR 还要专门提供消费者 API，而不是只靠 JMC 打开文件。先立住总问题：JFR 的价值在于事件历史可以被程序化消费。

### 第二节：`RecordingFile` 为什么是流式入口，而不是整文件对象模型

证据：
- `RecordingFile.java:64/121/143/239/242/243`

主线：
- `hasMoreEvents` / `readEvent` 支持逐事件推进；
- `readAllEvents` 只是便捷口，不代表首选模型；
- 流式读取让大文件分析保持内存可控。

### 第三节：为什么 `RecordedEvent` / `RecordedObject` 是“事件视图”,而不是原始业务类实例

证据：
- `RecordedEvent.java:41/91/102/111`
- `RecordedObject.java:52/66/71/102/166/668/695`

主线：
- `RecordedEvent` 继承 `RecordedObject`，是在通用字段视图上补事件时间语义；
- `RecordedObject` 用字段描述 + 对象数组承载值；
- 按名访问说明消费端面向的是 Schema，不是面向原始事件类反射恢复对象。

### 第四节：为什么 JFR 文件是“自描述”的,这让消费端不依赖业务源码

证据：
- `EventParser.java:41`
- `RecordedObject.java:66/71`
- 旧稿中的 ConstantMap / 类型表线索

主线：
- 文件里不仅有事件值，还有事件类型和字段定义的元模型；
- 解析器按这些定义解码值数组，再包装成只读视图；
- 这解释了为什么离线工具和远程分析不必拥有事件类字节码。

### 第五节：为什么 `RecordedObject` 提供按名访问家族，而不是强制类型恢复

证据：
- `RecordedObject.java:102/166/668/695`
- 嵌套访问线索 `114/214`

主线：
- 按名访问让消费者围绕字段 Schema 编程；
- 嵌套字段支持让复杂事件结构也能被逐层消费；
- 这比强制恢复业务对象更稳，也更适合离线脚本和通用工具。

### 第六节：为什么 JMC、`jfr` 命令行和自定义脚本能共享同一份事件历史

证据：
- `jdk.jfr.internal.tool.Main.java:36`

主线：
- JMC、命令行和代码 API 面对的是同一份 `.jfr` 事件历史；
- 区别只在消费方式和呈现层，不在文件语义本身；
- 这把“录制”和“分析”真正解耦。

## 5. 失败方案清单

1. 把 `.jfr` 文件当成只能由 GUI 工具打开的黑盒格式。
2. 读取大文件时总想一次性全量载入，而不使用流式读取。
3. 试图把消费 API 恢复成原始业务事件类实例，忽略自描述 Schema 模型。
4. 忽视字段名和类型描述，直接按位置猜测事件数据。
5. 把 `jfr` 命令行、JMC 和脚本分析当成三套完全不同的格式体系。

## 6. 误解清单

1. `readAllEvents()` 才是 JFR 文件的标准读取姿势。
2. `RecordedEvent` 就是原始事件类的反序列化结果。
3. 没有业务事件类字节码，消费端无法理解自定义事件。
4. `RecordedObject` 只是个 Map 包装，没有稳定 Schema 意义。
5. `.jfr` 文件主要给人看，程序化消费只是附带能力。

## 7. 证据清单

- `RecordingFile.java:64/121/143/239/242/243`
- `RecordedEvent.java:41/91/102/111`
- `RecordedObject.java:52/66/71/102/114/166/214/668/695`
- `EventParser.java:41`
- `jdk.jfr.internal.tool.Main.java:36`
- 旧稿中的 ChunkParser / ParserFactory / ConstantMap 线索

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦消费者 API，不深入 `.jfr` 文件二进制格式细节。
- JMC 只作为消费端代表，不展开其 UI 功能。
- 生产实践、持续录制策略和成本评估放到下一篇。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 `.jfr` 值得被程序化消费 → `RecordingFile` 为什么走流式 → `RecordedEvent` / `RecordedObject` 为什么是基于 Schema 的只读视图 → 为什么消费端不依赖业务事件类源码 → 为什么 JMC/命令行/API 能共享同一份事件历史”。
- 必须把消费者 API 讲成‘对自描述事件历史的流式消费’，而不是文件读取小工具。
- 必须自然引到 `06-production-practice.md`。
