# 域 39: JFR — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "JFR 是什么/事件生命周期" — 01 篇 §1-3(Event.java:102/110/121/131/144)
- [x] "自定义事件怎么写" — 02 篇 §1(继承+字段+commit)
- [x] "JFR 注解有哪些" — 02 篇 §2(Label:48/Description:45/Timestamp:44/Period:43)
- [x] "事件怎么被激活(ASM 注入)" — 03 篇 §1-2(EventInstrumentation:60/315)
- [x] "JFR 为什么开销低" — 01 篇 §4/03 篇 §3(惰性+环形缓冲+无锁)
- [x] "Recording/Configuration" — 04 篇 §1-2(Recording.java:120/168/409, Configuration.java:44/49)
- [x] ".jfr 文件怎么读" — 05 篇 §1(RecordingFile:105/121)
- [x] "线上怎么开 JFR(jcmd)" — 06 篇 §1
- [x] "JFR 常开吗(开销)" — 06 篇 §3(<1% 目标)

## 身份 2: 生产工程师
- [x] 线上卡顿排查(GC/锁事件)— 06 篇 §2
- [x] jcmd 三命令 — 06 篇 §1
- [x] 业务埋点(自定义事件)— 02 篇 §1
- [x] 自动分析脚本(consumer API)— 05 篇

## 身份 3: 框架工程师
- [x] 可观测性设计(事件模型)— 01-02 篇
- [x] 字节码注入理解 — 03 篇

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Event.java:102/110/121/131/144/169, FlightRecorder.java:133/176/330, Recording.java:120/168/341/409/462/571, Configuration.java:44/49/57/62, EventSettings.java:69/103/114, EventInstrumentation.java:60/132/315, JVM.java:38/55/91/137/157/165, RecordingFile.java:105/121/143/211/239, RecordedEvent.java:91, Timestamp.java:44/Period.java:43/Label.java:48/Description.java:45)/关键设计/跨层([内部卷 32]/[关联])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 巨型域 6 篇分段写作:1-3 批自查→4-6 批

## 身份 5: 完整性缺口检查
- [x] 全景(01)/自定义事件(02)/注入(03)/录制配置(04)/消费者(05)/实践(06)六篇覆盖域全部面试主战场
- [x] jdk.management.jfr 并入 06 篇 §4(JMX 管理)
- [x] internal 包细节(🟢)归入 01/03 篇提及,深入在内部卷 32
- [x] 未覆盖确认: 事件设置的继承/作用域细节、JFR 文件压缩格式——写作时按需
- [x] 二次 review 修正: 自动注册机制精确化(类加载时 JVM 检测 Event 子类 + JVMUpcalls 回调 retransform 注入,JVMUpcalls.java:62);FlightRecorder.register/unregister(133/155);02 篇"首次实例化自动"改为准确表述
- [x] 验证通过: 注解族全存在(Enabled/Threshold/StackTrace/Category/Frequency/MemoryAddress/Name/Registered)、Configuration 预置 default/profile(79/172-173/181/191)
- [ ] 待办: 写作时验证 JVM 类的缓冲写入 API(counterTime 等使用点)、internal 的 PlatformRecording 结构、jfr 命令行工具实现
