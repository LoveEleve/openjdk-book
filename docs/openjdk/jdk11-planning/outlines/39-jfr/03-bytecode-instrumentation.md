# 03. 字节码增强机制 — EventInstrumentation、ASM 注入、性能设计

> 🟡 Working | 域 39 JFR 第 3 篇(巨型域 6 篇之三)| Layer 4
> 读者处境: 面试"事件 commit 怎么生效的"——ASM 字节码注入,事件类被"改造"的真相。

### 1. "事件类被改写了？" — EventInstrumentation

场景: `new MyEvent().commit()` — 调的是"原方法"吗?

- `jdk/jfr/internal/EventInstrumentation.java:60` — 事件类的**字节码增强器**
- 时机: 类加载时 JVM 检测 Event 子类 → `JVMUpcalls` 回调(JVM→Java)触发 **retransform 注入**(JVMUpcalls.java:62 "using retransform")——**类字节码被改写**
- 增强目标: 把空的 begin/end/commit/isEnabled/shouldCommit 替换为**真实实现**(调用内部 handler)
- 关键设计 (斜体): *"事件基类方法是空的(域 39 第 1 篇 121 空实现)——真实逻辑靠字节码注入"——这是 JFR 的巧妙设计: 未注入前零开销,注入后按需启用;面试"事件怎么被激活"——类加载时 ASM 改写*
- [关联: 域 25 Agent(ClassFileLoadHook 机制);ASM: jdk.internal.org.objectweb.asm]

### 2. "ASM 怎么注入？" — ClassWriter 改写

场景: 改字节码——用什么技术?

- `EventInstrumentation.java:315` — `new ClassWriter(COMPUTE_FRAMES)` — **ASM 字节码生成器**(JDK 内置)
- 注入内容: 方法体替换(begin/end/commit)→ 调用事件 handler(native 写入路径)
- 附加: 事件类的字段布局、handler 静态字段的注入
- 关键设计 (斜体): *"ASM = 运行时改写字节码的库"——JFR 用它给每个事件类"补全"实现;面试"ASM 干什么"——方法体生成/类结构修改(对比 CGLIB 的域外用法)*
- [关联: 域 04 反射(字节码生成的另一路);域 25 Agent 同族]

### 3. "性能设计" — 注入后的事件路径

场景: 事件提交的性能关键点

- 注入后的 commit → 判断启用 → 写线程本地缓冲(无锁,内部卷 32)
- 未启用: commit 判断后直接返回(极小开销)
- 启用: 事件数据序列化进缓冲(免对象分配的设计——字段直接写)
- 关键设计 (斜体): *"启用判断前置 + 无锁缓冲写入"——JFR 低开销的工程实现;面试"JFR 为什么快"——注入优化 + 环形缓冲 + 无对象分配*
- 面试: "事件数据怎么进文件"——缓冲 → 后台线程刷盘(内部卷 32)
- [内部卷: 32-jfr(缓冲与写入引擎)]

### 4. "内建事件" — jdk.jfr.events

场景: JVM 自己的事件(GC/锁/分配)——在哪?

- `jdk/jfr/events/` 子包: 部分内建事件(JVM 侧 native 产生)
- 大量事件由 **JVM native 直接生成**(不经过 Java 注入)——GC 事件/分配事件等(内部卷 32)
- 关键设计 (斜体): *"JVM 事件 = native 直写"——Java 层注入只服务自定义事件;面试"GC 事件谁发的"——JVM native(内部卷 32)*
- 生产: 开箱即用(GC/锁/IO 事件),无需埋点

---

### 核心悬念

事件机制通了——**录制怎么配置**?Recording 的 startTime/destination、Configuration 的预置方案、事件级别的 Enabled/Threshold 设置——下一篇: 录制与配置。

> → [04-recording-config.md](04-recording-config.md)
