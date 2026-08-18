# 02. Instrumentation 与字节码增强 — 转换链、retransform、APM 原理

> **前置依赖**: [25-agent-diagnostic/01 — Attach 机制](01-attach-mechanism.md)(attach/loadAgent 链路)、[04-reflection-annotation/02 — MethodAccessor](../04-reflection-annotation/02-methodaccessor.md)(字节码改写对照)
> → **后续**: [03-diagnostic-tools.md](03-diagnostic-tools.md)
> 关联: 域 39 JFR 字节码注入(同族技术)

## agent 拿到的到底是什么

attach 或 `-javaagent` 成功后,真正交到 agent 手里的核心能力不是某个 ClassLoader,而是 `Instrumentation`。

## 1. "Instrumentation 是什么?" — 类修改入口

### 1.1 核心接口

`Instrumentation`(`java.lang.instrument.Instrumentation.java:71`)是 JVM 暴露给 agent 的类修改入口。

关键方法:

- `addTransformer(..., boolean)`(`:99`)——注册转换器
- `retransformClasses`(`:260`)——对**已加载类**重新走转换链
- `redefineClasses`(`:351` 附近注释/定义区)——直接替换字节码
- `isModifiableClass`——检查类是否可改

### 1.2 获取方式

- 启动期: `premain(String, Instrumentation)`
- 运行中 attach: `agentmain(String, Instrumentation)`

JVM 不是让 agent 主动去“找” Instrumentation,而是把它作为参数注入进去。

关键设计(斜体):*Instrumentation = 类字节修改的总入口。面试"agent 拿到什么": 不是反射句柄,而是能注册 transformer、重放转换或直接换字节的 Instrumentation 实例。*

## 2. "TransformerManager" — 转换器链

### 2.1 注册顺序

`TransformerManager`(`sun/instrument/TransformerManager.java:41`)管理转换器列表。源码注释明确指出数组按 `addTransformer` 添加顺序保存(`:69`)。

`addTransformer`(`:93`)会把 transformer 追加到快照数组尾部。

### 2.2 transform 流程

`transform`(`:169`)会获取当前 transformer 快照(`:177`),再按顺序依次调用 `transformer.transform(...)`(`:188`)。

- 返回 `null` → 不修改,继续后一个
- 返回 `byte[]` → 把结果作为新的 `bufferToUse`,继续传给后续 transformer
- 单个 transformer 出错不会让整条链立即失效,管理器会隔离异常影响

所以它不是"第一个返回非 null 就终止",而是**按注册顺序链式叠加修改**。

关键设计(斜体):*转换器链 = 责任链 + 叠加变换。面试"多个 transformer 按什么顺序执行": 注册顺序;返回 null 表示放行,返回字节表示替换当前输入并继续传递。*

## 3. "retransform vs redefine" — 两种修改

### 3.1 retransform

`retransformClasses`(`Instrumentation.java:260`)适合“已加载类重新走现有转换器链”。底层进入 `InstrumentationImpl.retransformClasses0`(`InstrumentationImpl.java:167`,native)。

### 3.2 redefine

`redefineClasses` 则直接给出新的 `ClassDefinition` 字节数组,底层进入 `redefineClasses0`(`InstrumentationImpl.java:193`,native)。

两者都能修改已加载类,但语义不同:

- retransform = 重新执行 transformer 规则
- redefine = 直接替换成你给的新字节

### 3.3 边界

JDK 对已加载类修改有边界,例如类结构变更通常受限,不能任意增删字段/方法。

关键设计(斜体):*retransform 是“重放转换逻辑”,redefine 是“直接换字节”。面试"已加载类怎么增强": 先区分这两条路。*

## 4. "agent 的启动" — premain/agentmain

### 4.1 启动与热挂

`InstrumentationImpl` 中:

- `loadClassAndCallPremain` 最终走 `loadClassAndStartAgent(..., "premain", ...)`(`InstrumentationImpl.java:525`)
- `loadClassAndCallAgentmain` 最终走 `loadClassAndStartAgent(..., "agentmain", ...)`(`:535`)

这就是 `-javaagent` 与 attach 热挂的双入口差异。

### 4.2 实战理解

- APM 启动挂: 进程启动前就注册 transformer
- Arthas/热修复类工具: 运行中 attach 后拿到 agentmain,再做 retransform/redefine

关键设计(斜体):*agent = 双入口: premain 解决“启动即接管”,agentmain 解决“运行中热挂”。面试"premain vs agentmain": 启动时 vs 运行时。*

## 核心悬念

机制讲完了——**工具怎么用**?`jcmd/jstack/jmap/jstat` 各做什么,怎么选,与 JFR/JMX 怎么配合——下一篇: 诊断工具族与生产规范。