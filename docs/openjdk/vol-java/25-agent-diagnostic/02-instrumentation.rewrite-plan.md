# 25-agent-diagnostic/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.lang.instrument.Instrumentation`、`sun.instrument.InstrumentationImpl`、`TransformerManager`。本文聚焦 agent 双入口、transformer 链、retransform/redefine 能力边界；具体工具组合放到下一篇。
> 目标：把“Instrumentation 与字节码增强”改写成一篇围绕“Attach 或 `-javaagent` 成功后，agent 真正拿到的不是某个 ClassLoader 控制权，而是 JVM 通过 `Instrumentation` 显式交付的一组类改写能力：注册转换器、让已加载类重走转换链、或直接替换字节码”展开的机制文章。

## 1. 读者困惑

- agent 成功进入 JVM 之后，到底拿到了什么能力，为什么不是直接去改类加载器？
- `premain` 和 `agentmain` 到底差在哪，为什么要分两个入口？
- 多个 transformer 是谁管理的，为什么它们会按顺序叠加而不是互相覆盖？
- `retransformClasses` 和 `redefineClasses` 看起来都能改已加载类，语义到底差在哪？
- 为什么字节码增强工具一定绕不开 Instrumentation，而不是纯靠反射或自定义类加载器？

## 2. 一句话顿悟

**agent 真正拿到的核心不是“一个能随便进 JVM 各处的句柄”，而是 JVM 明确交给它的一组类改写控制权：`Instrumentation` 负责注册 transformer、驱动类在加载或重转换时走增强链，并在受限边界内支持重转换或直接重定义。`premain` 和 `agentmain` 的区别只在入口时机不同，真正的能力中心始终是同一个 `Instrumentation` 实例。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 `Instrumentation` 接口、`TransformerManager`、`retransform/redefine` 与 `premain/agentmain` 的关键落点。
- 已明确 transformer 链是按注册顺序叠加，这是很重要的细节。
- 已把 Arthas/APM 场景回扣到入口差异，方向正确。

### 必须重写

- 旧稿偏功能卡片，需要先立住总问题：agent 进入 JVM 后到底拿到了什么“受控能力”。
- `premain/agentmain`、transformer 链、retransform/redefine 要统一到“Instrumentation 是能力总入口”这条主线上。
- `TransformerManager` 要讲成“转换链调度器”，而不是源码摘录。
- retransform/redefine 的差异要讲成“重放规则 vs 直接换字节”的两种控制方式。

## 4. 理解路径

### 第一节：从“agent 进门后真正拿到的是什么”开场

承接上一篇：Attach 只解决进门问题。继续追问：进门之后 JVM 到底交了什么钥匙给 agent。先立住总问题：能力中心是 `Instrumentation`，不是随意改 JVM。

### 第二节：`Instrumentation` 为什么是统一能力入口

证据：
- `Instrumentation.java:71`
- `Instrumentation.java:99/111`：`addTransformer`
- `Instrumentation.java:147/260`：`isRetransformClassesSupported` / `retransformClasses`
- `Instrumentation.java:279/351`：`isRedefineClassesSupported` / `redefineClasses`

主线：
- Instrumentation 统一暴露“注册转换器、重放转换、直接重定义、检查边界”。
- 这说明 agent 能做什么，不靠私下摸 JVM，而靠 JVM 明确授权的接口集合。

### 第三节：`premain` / `agentmain` 为什么只是两种入口时机

证据：
- `InstrumentationImpl.java:425`
- `InstrumentationImpl.java:521/525`
- `InstrumentationImpl.java:531/535`

主线：
- `premain` 对应启动期进入；`agentmain` 对应运行中 attach 热挂。
- 二者最终都落到 `loadClassAndStartAgent(...)`，说明差别主要在进入时机，不在能力中心。

### 第四节：为什么多个 transformer 会形成一条叠加转换链

证据：
- `TransformerManager.java:41/76/84`
- `TransformerManager.java:93/102`
- `TransformerManager.java:165/169/188`

主线：
- TransformerManager 用快照数组维护注册顺序。
- transform 时按顺序逐个调用，前一个返回的新字节会成为后一个输入。
- 这解释了为什么 APM、监控和诊断增强能形成责任链而不是单点替换。

### 第五节：`retransform` 和 `redefine` 为什么是两条不同的已加载类修改路径

证据：
- `Instrumentation.java:260/351`
- `InstrumentationImpl.java:167/193`
- `InstrumentationImpl.java:381/384`

主线：
- retransform = 让已加载类重新走当前 transformer 规则；
- redefine = 直接给出新的 ClassDefinition 字节；
- 都能改已加载类，但控制方式和使用语义不同。

### 第六节：为什么能力很强,边界却依然受 JVM 控制

主线：
- Instrumentation 不等于任意类结构都能无限改。
- 是否支持 retransform/redefine 先要显式查询；具体结构修改也有限制。
- 这再次回扣“agent 拿到的是受控能力，不是无限特权”。

## 5. 失败方案清单

1. 把 agent 能力理解成“拿到一个 JVM 后门，可以随便改任何类”。
2. 把 `premain` 和 `agentmain` 当成两套不同增强体系。
3. 假设多个 transformer 是互斥的，后注册的会完全覆盖前面的逻辑。
4. 把 `retransform` 和 `redefine` 混为同一种操作。
5. 不检查能力支持与结构边界，就假定所有已加载类都能任意改写。

## 6. 误解清单

1. agent 进入 JVM 后最重要的是先拿到某个 ClassLoader。
2. `Instrumentation` 只是提供类列表查询，真正改类靠别的隐藏接口。
3. transformer 返回非 null 后，后续 transformer 就不会再执行。
4. `retransformClasses` 本质上就是直接覆盖新字节。
5. attach 热挂 agent 的能力一定弱于 `-javaagent` 启动挂。

## 7. 证据清单

- `Instrumentation.java:71/99/111/147/260/279/351`
- `InstrumentationImpl.java:59/167/193/381/384/425/521/525/531/535`
- `TransformerManager.java:41/76/84/93/102/165/169/188`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦 Instrumentation 机制，不展开 ASM/ByteBuddy 具体字节码生成细节。
- 工具选型与诊断命令族留到下一篇。
- 不扩展到 JVMTI 全景，只保持在 java.lang.instrument 这层能力边界。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“agent 进入 JVM 后真正拿到的是 Instrumentation → `premain/agentmain` 只是时机差异 → transformer 为什么形成按顺序叠加的转换链 → `retransform` 与 `redefine` 的控制方式差异 → agent 能力为什么依然受 JVM 边界约束”。
- 必须把 Instrumentation 讲成‘受控类改写总入口’。
- 必须自然引到 `03-diagnostic-tools.md`。
