# 04. 录制与配置 — Recording 生命周期、Configuration、事件设置

> **前置依赖**: [39-jfr/01 — JFR 全景与事件模型](01-jfr-overview-event-model.md)(Recording 会话,§2)、[39-jfr/03 — 字节码增强机制](03-bytecode-instrumentation.md)(事件提交路径)
> → **后续**: [05-consumer-api.md](05-consumer-api.md)
> 关联: 内部卷 32-jfr(缓冲结构/刷盘线程)

## 录制怎么配置

前三篇讲了事件机制——这一篇看会话管理: Recording 生命周期怎么控制、预置配置模板是什么、事件级设置怎么链式调整、数据落在内存还是磁盘。

## 1. "Recording 的生命周期" — 会话管理

### 1.1 构造三形态

`Recording` 构造三种(`Recording.java`): `Recording(Map<String,String> settings)`(`:96`)/`Recording()`(`:120`)/`Recording(Configuration configuration)`(`:150`,带预置模板)。

### 1.2 生命周期

| 阶段 | 方法 | 锚点 |
|------|------|------|
| 构造 | 空 Recording(NEW 状态,Javadoc `:135`) | `:120` |
| 开始 | `start()` | `:168` |
| 停止 | `stop()` | `:209` |
| 导出 | `setDestination(Path)`(停止时自动写文件的位置,Javadoc `:449-450`)/ `dump(Path)`(手动立即导出) | `:462` / `:374` |
| 释放 | `close()` | `:341` |

配置项: `setMaxSize`(`:409`,磁盘仓库数据量上限,超限移除最旧 chunk)/`setMaxAge`(`:432`,磁盘数据保留时长上限)/`setName`。

面试"怎么导出录制": setDestination + stop——会话自动结束写文件;生产: jcmd JFR.start name=x duration=60s → 自动产出 .jfr 文件。

关键设计(斜体):*"Recording = 配置 + 时间窗口"——start/stop 界定录制,close 释放资源。面试"怎么导出录制": setDestination + stop;生产: jcmd JFR.start name=x duration=60s → 自动产出 .jfr 文件。*

## 2. "Configuration 预置方案" — 配置模板

### 2.1 结构

`Configuration`(`jdk/jfr/Configuration.java:48`)——**设置集合**(name/label/描述 + `Map<String,String> settings`(`:49`,构造 `:57`));`getConfiguration(String name)`(`:181`)按名获取预置方案。

### 2.2 预置方案

- **default** — 默认低开销
- **profile** — 详细(更多事件/更低阈值)

文件在 `jdk.jfr/share/conf/jfr/`(`default.jfc`/`profile.jfc`,XML,141 个事件条目),经 `JFC.getPredefined` 加载(`Configuration.getConfiguration`——`:181`),转成 `Map<String,String>` 设置键值——**API 层格式**: `"jdk.GC#enabled" = "true"` 等事件级键值。

面试"default vs profile 区别": 启用的事件与阈值不同;生产: 常规监控 default,问题定位 profile。

关键设计(斜体):*"配置 = 事件设置的集合"——按场景选模板(default 低开销/profile 详细)。面试"default vs profile 区别": 启用的事件与阈值不同;生产: 常规监控 default,问题定位 profile。*

## 3. "事件级设置" — EventSettings 链式

### 3.1 链式 API

`EventSettings`(`jdk/jfr/EventSettings.java:56`,抽象类)提供链式方法:

- `withThreshold(Duration)`(`:114`)——低于该时长的事件丢弃
- `withPeriod(Duration)`(`:103`)——周期事件频率
- `withStackTrace()`(`:69`)——是否抓栈

用法: `recording.enable(MyEvent.class).withThreshold(Duration.ofMillis(10)).withStackTrace()`;入口 `Recording.enable`——`enable(String)`(`:602`,按名称启用,同名事件全开——Javadoc `:590-596`)/`enable(Class)`(`:640`,按类精确启用)。

面试"阈值干什么": 减少低价值事件(性能开销控制);生产: 业务事件默认开 + 阈值过滤噪音。

关键设计(斜体):*"事件设置 = 录制级过滤"——开关/阈值/周期/栈四类。面试"阈值干什么": 减少低价值事件(性能开销控制);生产: 业务事件默认开 + 阈值过滤噪音。*

## 4. "缓冲与磁盘" — 数据去向

### 4.1 数据路径

**默认落盘**: 录制数据持续刷到磁盘仓库(`PlatformRecording.toDisk` 默认 `true`——`jdk/jfr/internal/PlatformRecording.java:70`);`setToDisk(false)` 则数据限于内存缓冲(`setToDisk` Javadoc——`Recording.java:531`)。

写入路径: 线程本地缓冲(内存环形,第 3 篇 §3)→ 后台线程刷盘(内部卷 32-jfr)。

### 4.2 上限语义

`setMaxSize`(`:409`)/`setMaxAge`(`:432`)限定**磁盘数据**的量/时长——超限或超龄时 JVM **移除最旧 chunk**(Javadoc: "removes the oldest chunk to make room for a more recent chunk",`:397`);两者都不设则数据无限增长(Javadoc `:424`)。

面试"JFR 数据存哪": 默认磁盘仓库(可切内存缓冲),线程本地缓冲 → 文件;面试"JFR 不阻塞业务的关键": 线程本地缓冲写入 + 后台持久化。

关键设计(斜体):*"环形缓冲 + 异步刷盘"是 JFR 不阻塞业务的关键——写入线程本地缓冲,后台持久化;默认落盘仓库(`PlatformRecording.java:70`),可切纯内存缓冲。面试"JFR 数据存哪": 线程本地缓冲 → 磁盘仓库文件。*

跨层标注: [内部卷 32-jfr——缓冲结构/刷盘线程/文件格式;第 1 篇 §2——Recording 会话与 getDuration 回指]

## 核心悬念

录完了——**.jfr 文件怎么读**?`RecordingFile` 的流式解析、RecordedEvent/RecordedObject 的字段访问、文件内部结构(Chunk/Parser)——下一篇: 消费者 API。

> → [05-consumer-api.md](05-consumer-api.md)