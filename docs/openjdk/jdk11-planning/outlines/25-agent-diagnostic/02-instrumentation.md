# 02. Instrumentation 与字节码增强 — 转换链、retransform、APM 原理

> 🔴 Deep | 域 25 Agent 与诊断第 2 篇 | Layer 5
> 读者处境: 面试"Arthas/APM 原理"——Instrumentation 的转换器机制与字节码增强。

### 1. "Instrumentation 是什么？" — 类修改的入口

场景: attach 后加载 agent——agent 拿到什么?

- `java/lang/instrument/Instrumentation.java` — agent 的核心接口
- 关键方法: `addTransformer`(99,注册转换器,可 canRetransform)/`retransformClasses`(260,**已加载类**重新转换)/`redefineClasses`(351,直接替换字节)/`isModifiableClass`(383,能否改)
- 获取: agent 启动时由 JVM 注入(premain/agentmain 参数)
- 关键设计 (斜体): *"Instrumentation = 类字节的修改入口"——transformer 在类加载/重定义时被调;面试"agent 拿到什么"——Instrumentation 实例(增删转换器/重定义类)*
- 面试: "Instrumentation vs 反射"——反射是运行时访问,Instrumentation 是改字节码(加载前/已加载)
- [关联: 域 04 反射对照;内部卷 28-jvmti(底层 JVMTI)]

### 2. "TransformerManager" — 转换器链

场景: 多个 transformer——按什么顺序执行?

- `sun/instrument/TransformerManager.java:41` — 管理转换器
- `TransformerManager.java:93` `addTransformer` — **按添加顺序**存数组(69 注释)
- `transform`(169-188): 依次调每个 `transformer.transform(module, className, ...)`——**第一个返回非 null 字节即生效**
- 关键设计 (斜体): *"转换器链 = 责任链"——每个 transformer 有机会改字节,先返回非 null 者胜;面试"多个 transformer 顺序"——注册顺序*
- 面试: "transform 返回 null 表示什么"——不改(放行);返回字节 = 替换
- [关联: 域 07 类加载(转换发生在 defineClass 前);域 39 字节码注入同族]

### 3. "retransform vs redefine" — 两种修改

场景: 已加载的类怎么改?

- `retransformClasses`(Instrumentation.java:260): **重新走转换器链**(已加载类再次 transform)——`InstrumentationImpl.retransformClasses0`(167,native)
- `redefineClasses`(351): 直接**替换为新字节**(不走转换器)——`redefineClasses0`(193)
- 限制: 不能改类结构(增删方法/字段)——`isModifiableClass`(383)先检查
- 关键设计 (斜体): *"retransform=重放转换器,redefine=直接换字节"——都能改已加载类;JDK 限制: 不可改结构(只能改方法体);面试"已加载类怎么增强"——retransform/redefine*
- 面试: "改类结构会怎样"——UnmodifiableClassException
- [内部卷: 28-jvmti(RedefineClasses 的 JVM 实现)]

### 4. "agent 的启动" — premain/agentmain

场景: agent jar 怎么被加载启动?

- 启动时: `-javaagent:agent.jar` → `premain(String, Instrumentation)`(Java 启动前)
- 动态: `vm.loadAgent("agent.jar")`(域 25 第 1 篇 535)→ `agentmain(String, Instrumentation)`(attach 后)
- 加载实现: `InstrumentationImpl.loadClassAndStartAgent(classname, "premain"/"agentmain", options)`(525/535)
- jar 规范: MANIFEST 的 Premain-Class/Agent-Class 属性
- 关键设计 (斜体): *"agent = 双入口"——premain(启动钩子)/agentmain(运行中注入);面试"premain vs agentmain"——启动时 vs attach 后;APM/Arthas 用 agentmain 热挂*
- 生产: SkyWalking/Arthas 的挂载原理(javaagent 启动挂或 attach 热挂)
- [关联: 域 25 第 1 篇 loadAgent 链路;域 39 JFR 的字节码注入同技术]

---

### 核心悬念

机制讲完了——**生产工具怎么用**?jcmd 的命令大全、jstack/jmap/jstat 的排查场景、与 JFR 的衔接——下一篇: 诊断工具族与生产规范。

> → [03-diagnostic-tools.md](03-diagnostic-tools.md)
