# 03. 字节码增强机制 — EventInstrumentation、ASM 注入、性能设计

> **前置依赖**: [39-jfr/01 — JFR 全景与事件模型](01-jfr-overview-event-model.md)(commit 空实现,§3)、[39-jfr/02 — 自定义事件与注解](02-custom-event-annotation.md)(事件子类)
> → **后续**: [04-recording-config.md](04-recording-config.md)
> 关联: 内部卷 32-jfr(缓冲与写入引擎);[04-reflection-annotation/02 — MethodAccessor](../04-reflection-annotation/02-methodaccessor.md)(字节码生成的另一路)

## commit 之后发生了什么

前两篇说事件类的方法默认是空实现——这一篇揭真相: 事件类的字节码被谁改写、用什么技术、为什么注入后"有行为"。

## 1. "事件类被改写了?" — EventInstrumentation

### 1.1 回调链

JVM 在类重转换时回调 `JVMUpcalls.onRetransform(long, boolean, Class, byte[])`(`JVMUpcalls.java:53`,签名注释"class being retransformed"——`:47`):

- 判断: `jdk.internal.event.Event.class.isAssignableFrom(clazz)` 且非抽象(`:55`)——**事件子类才注入**
- 日志: "Adding instrumentation to event class ... using retransform"(`:62`)——**retransform 机制**
- 注入: `new EventInstrumentation(clazz.getSuperclass(), oldBytes, traceId)`(`:63`)→ `buildInstrumented()`(`:64`)→ 返回新字节替换旧字节(`:66`)

非事件类走内建事件分支 `JDKEvents.retransformCallback`(`:68`)。

### 1.2 增强目标

`EventInstrumentation`(`jdk/jfr/internal/EventInstrumentation.java:60`)把事件类空的 begin/end/commit/isEnabled/shouldCommit 替换为**真实实现**(调用内部 handler);`writeMethod`(`:118`)是事件 handler 的写入方法(import `jdk.jfr.internal.handlers.EventHandler`,`:54`)。

面试"事件怎么被激活": 类加载/重转换时 ASM 改写——事件基类空方法被真实实现替换。

关键设计(斜体):*"事件基类方法是空的(第 1 篇 §3,`:121` 空实现)——真实逻辑靠字节码注入"——这是 JFR 的巧妙设计: 未注入前零开销,注入后按需启用。面试"事件怎么被激活": 类加载时 ASM 改写;关联: 字节码替换(ClassFileLoadHook 同族机制,域外)。*

## 2. "ASM 怎么注入?" — ClassWriter 改写

### 2.1 内置 ASM

JDK 内置 ASM 库:`import jdk.internal.org.objectweb.asm.ClassReader/ClassWriter`(`EventInstrumentation.java:37-38`)。

### 2.2 改写流程

- 读入: `createClassNode`——`new ClassReader(bytes)` 解析旧字节码为 `ClassNode`(`:152-153`)
- 改写: 遍历方法节点,替换事件方法体(注入 handler 调用——`getEventHandler(methodVisitor)`(`:333`)注入 handler 字段/方法)
- 写出: `toByteArray`——`new ClassWriter(ClassWriter.COMPUTE_FRAMES)`(`:315`)重新生成字节码(COMPUTE_FRAMES 自动计算栈帧)

面试"ASM 干什么": 方法体生成/类结构修改——JFR 用它给每个事件类"补全"实现。

关键设计(斜体):*"ASM = 运行时改写字节码的库"——JFR 用它给每个事件类"补全"实现。面试"ASM 干什么": 方法体生成/类结构修改;关联: 域 04 反射——MethodAccessor 是字节码生成的另一路(动态代理/访问器,与 ASM 同族)。*

## 3. "性能设计" — 注入后的事件路径

### 3.1 提交路径

注入后的 commit → 调用事件 handler 的写入方法(`writeMethod`,`EventInstrumentation.java:118`)→ handler **判断启用**(`EventHandler.isEnabled()`——`jdk/jfr/internal/handlers/EventHandler.java:66`;阈值判断 `shouldWrite`——`:61`)→ 写线程本地缓冲(无锁,内部卷 32-jfr)。

### 3.2 两级成本

- **未启用**: commit 判断后直接返回——极小开销
- **启用**: 事件数据序列化进缓冲——免对象分配的设计(字段直接写)

面试"事件数据怎么进文件": 缓冲 → 后台线程刷盘(内部卷 32-jfr)。

关键设计(斜体):*"启用判断前置 + 无锁缓冲写入"——JFR 低开销的工程实现。面试"JFR 为什么快": 注入优化 + 环形缓冲 + 无对象分配;面试"事件数据怎么进文件": 缓冲 → 后台线程刷盘(内部卷 32)。*

## 4. "内建事件" — jdk.jfr.events

### 4.1 位置与来源

`jdk/jfr/events/` 子包(`jdk.jfr/share/classes/jdk/jfr/events/`,19 个事件类: `FileReadEvent.java`/`SocketWriteEvent.java`/`ExceptionThrownEvent.java` 等)——部分内建事件(Java 层)。

### 4.2 两类来源

- **Java 层内建**: 经 `JDKEvents.retransformCallback` 分支处理(`JVMUpcalls.java:68`)
- **JVM native 直写**: 子包中**没有 GC 事件类**——GC 事件/分配事件等由 JVM native 直接生成,不经 Java 注入(内部卷 32-jfr)

面试"GC 事件谁发的": JVM native 直写——Java 层注入只服务自定义事件;生产: 内建事件开箱即用(GC/锁/IO),无需埋点。

关键设计(斜体):*"JVM 事件 = native 直写"——Java 层注入只服务自定义事件。面试"GC 事件谁发的": JVM native(内部卷 32);生产: 开箱即用(GC/锁/IO 事件),无需埋点。*

跨层标注: [内部卷 32-jfr——缓冲、刷盘与 native 事件直写;域 04 反射——MethodAccessor 字节码生成(另一路改写);域 34 JMX——DiagnosticCommand 与 JFR 同属生产诊断通道]

## 核心悬念

事件机制通了——**录制怎么配置**?Recording 的 startTime/destination、Configuration 的预置方案、事件级别的 Enabled/Threshold 设置——下一篇: 录制与配置。

> → [04-recording-config.md](04-recording-config.md)