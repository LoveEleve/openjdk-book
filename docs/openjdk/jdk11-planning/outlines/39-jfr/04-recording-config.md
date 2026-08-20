# 04. 录制与配置 — Recording 生命周期、Configuration、事件设置

> 🔴 Deep | 域 39 JFR 第 4 篇(巨型域 6 篇之四)| Layer 4
> 读者处境: 生产"开启 JFR"——Recording 的配置项与预置方案,事件级设置。

### 1. "Recording 的生命周期" — 会话管理

场景: `new Recording(cfg).start()` — 之后怎么控制?

- `Recording.java:120` 构造(可带 Configuration)/`168` `start()`/`341` `close()`/`setDestination(462,写文件)`
- 配置: `setMaxSize`(409,环形缓冲上限)/setMaxAge(时间上限)/setName
- 生命周期: 构造(空)→ start(采集开始)→ stop/dump → close(释放)
- 关键设计 (斜体): *"Recording = 配置 + 时间窗口"——start/stop 界定录制,close 释放(域 03 资源规范);面试"怎么导出录制"——setDestination + stop*
- 生产: jcmd JFR.start name=x duration=60s → 自动产出 .jfr 文件

### 2. "Configuration 预置方案" — 配置模板

场景: default/profile 配置——settings 是什么?

- `Configuration.java:44` — **设置集合**(name/label/描述 + `Map<String,String> settings` 49/62)
- 预置: default(默认低开销)/profile(详细)— `Configuration.getConfiguration("default")`
- settings 格式: `"jdk.GC#enabled" = "true"` 等事件级键值
- 关键设计 (斜体): *"配置 = 事件设置的集合"——按场景选模板(default 低开销/profile 详细);面试"default vs profile 区别"——启用的事件与阈值不同*
- 生产: 常规监控 default;问题定位 profile

### 3. "事件级设置" — EventSettings 链式

场景: 只开某个事件/调整阈值——EventSettings API

- `EventSettings.java` — 链式: `enable(Class)`/`disable`(关闭)+ `withThreshold(114,低于该时长的丢弃)`/`withPeriod(103,周期事件频率)`/`withStackTrace(69,是否抓栈)`
- 用法: `recording.enable(MyEvent.class).withThreshold(10ms).withStackTrace()`
- 关键设计 (斜体): *"事件设置 = 录制级过滤"——开关/阈值/周期/栈四类;面试"阈值干什么"——减少低价值事件(性能开销控制)*
- 生产: 业务事件默认开 + 阈值过滤噪音

### 4. "缓冲与磁盘" — 数据去向

场景: 录制的数据在哪?内存还是磁盘?

- 默认: 环形缓冲(内存,可 setToDisk 落盘)+ 后台线程刷盘(内部卷 32)
- `setMaxSize`(409)/setMaxAge: 缓冲上限(环形覆盖或停止)
- 失败语义: 缓冲满 → 按策略覆盖(旧事件丢弃)
- 关键设计 (斜体): *"环形缓冲 + 异步刷盘"是 JFR 不阻塞业务的关键——写入线程本地缓冲,后台持久化;面试"JFR 数据存哪"——内存环形缓冲→文件*
- [内部卷: 32-jfr(缓冲结构/刷盘线程)]

---

### 核心悬念

录完了——**.jfr 文件怎么读**?`RecordingFile` 的流式解析、RecordedEvent/RecordedObject 的字段访问、文件内部结构(Chunk/Parser)——下一篇: 消费者 API。

> → [05-consumer-api.md](05-consumer-api.md)
