# 域 39: JFR — 知识规划

> 源码路径: jdk.jfr/share/classes/(178 文件 27,811 行:jdk/jfr 公共 API + jdk/jfr/internal + jdk/jfr/consumer + jdk/jfr/events) + jdk.management.jfr/(14 文件)
> 源码量: ~192 文件 / ~40,000 行 | 🔴 巨型域(拆 6 篇)
> 写作层: Layer 4(前置: 域 11 线程、13 原子;可观测性收官)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| jdk/jfr/Event.java | **事件抽象**: begin(102)/end(110)/commit(121,最终写入)/isEnabled(131)/shouldCommit(144,阈值判断)/set(169) | High |
| jdk/jfr/FlightRecorder.java | **录制器门面**: getFlightRecorder(176)/register(133,注册事件类)/isAvailable(330)/createRecording | High |
| jdk/jfr/Recording.java | **录制会话**: start(168)/close(341)/setDestination(462,写文件)/getDuration(571)/事件配置 | High |
| jdk/jfr/EventType.java | **事件类型元数据**: 名称/标签/字段(ValueDescriptor 列表)/设置 | High |
| jdk/jfr/ValueDescriptor.java | **字段描述**: 名称/类型/注解(EventType 的字段模型) | Medium |
| jdk/jfr/AnnotationElement.java | **注解元数据**: 注解实例的 JFR 表示 | Medium |
| jdk/jfr/EventFactory.java | **动态事件**: 运行时创建事件类型(免写子类) | Medium |
| jdk/jfr/internal/JVM.java | **native 边界**: counterTime(91,纳秒计数)/getClassId(137)/getStackTraceId(157)/getThreadId(165)——事件写入的底层 | High |
| jdk/jfr/internal/EventInstrumentation.java | **字节码增强**: ASM(jdk.internal.org.objectweb.asm.ClassWriter 315)注入 begin/end 到事件类 | High |
| jdk/jfr/consumer/RecordedEvent.java | **消费事件**: getStartTime(91)/字段访问/类型查询 | High |
| jdk/jfr/consumer/RecordingFile.java | **录制文件读取**: 流式解析 JFR 文件 | Medium |
| 注解族(Label/Description/Timestamp/Period) | **事件注解**: 元数据声明(Label 48/Description 45/Timestamp 44/Period 43) | Medium |

*12 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | 事件模型(begin/end/commit) | 2 (Event/EventType) | 面试常问(自定义事件怎么写) |
| P1 | 录制生命周期 | 2 (Recording/FlightRecorder) | 生产(开启/停止/文件) |
| P1 | 字节码增强 | 2 (EventInstrumentation/internal) | 面试偶尔(ASM 注入);框架理解 |
| P1 | 消费者 API | 3 (consumer) | 生产(分析脚本) |
| P2 | native 边界 | 1 (JVM) | 衔接内部卷 32-jfr |
| P3 | 注解/EventFactory 细节 | 5 | 使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | 事件模型与自定义事件 | 面试常问(事件生命周期/注解);生产(业务埋点) |
| 🔴 Deep | 录制与配置 | 生产(JFR 开启/文件/分析) |
| 🟡 Working | 字节码增强 | 面试偶尔(理解事件为何快) |
| 🟡 Working | 消费者 API | 生产(自动化分析) |
| 🟢 Surface | 注解/Factory 细节 | 使用层 |

## 04 聚类

### 依赖图(域内)
```
Event(抽象) ←── 用户事件子类 ←── EventInstrumentation(ASM 注入)
FlightRecorder(门面) ←── Recording(会话) ←── Configuration(配置)
EventType(元数据) ←── ValueDescriptor/AnnotationElement
JVM(native) ←── Event 写入路径
consumer(RecordedEvent/RecordingFile) ←── 录制文件
jdk.management.jfr ←── JMX 管理(域 34 关联)
```

### 教学顺序与文章拆分(6 篇,巨型域)

1. **JFR 全景与事件模型** — FlightRecorder/Recording/Event 三物件、事件生命周期、isEnabled/shouldCommit/commit
2. **自定义事件与注解** — 事件子类写法、@Label/@Timestamp/@Period、EventType 元数据、EventFactory 动态事件
3. **字节码增强机制** — EventInstrumentation(ASM)、注入点(begin/end)、性能设计(无对象分配/无锁)
4. **录制与配置** — Recording 生命周期、Configuration/EventSettings、startTime/destination、磁盘/内存缓冲
5. **消费者 API** — RecordingFile 流式读取、RecordedEvent/RecordedObject、JFR 文件结构
6. **生产实践** — jcmd JFR.start/dump、飞行记录分析、与监控集成、性能开销评估

> 前置: 域 11/13(并发安全)、34(JMX 关联)。跨层: native 引擎(内部卷 32-jfr)、时间源(内部卷 01-os)
