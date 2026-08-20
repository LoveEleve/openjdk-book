# 34-jmx/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `StandardMBean`、`DynamicMBean`、`MXBean`、`Introspector`、`DefaultMXBeanMappingFactory`。本文聚焦三类 MBean 的描述来源、合规识别与开放类型映射；通知机制放到下一篇。
> 目标：把“MBean 类型与 MXBean”改写成一篇围绕“JMX 三类 MBean 的根本差异，不是写法风格，而是管理描述究竟从哪里来、以及这个描述里的数据是否能稳定跨进程传输”展开的机制文章。

## 1. 读者困惑

- 注册一个对象时，JMX 到底怎么知道哪些方法是属性、哪些是操作？
- 标准 MBean、动态 MBean、MXBean 看起来都能注册，真正差在哪？
- 为什么标准 MBean 说“约定优于配置”，而动态 MBean 却要自己报 `MBeanInfo`？
- MXBean 为什么经常被推荐给自定义监控指标，它到底解决了什么额外问题？
- `CompositeData`、开放类型映射这些看起来很重的机制，为什么是远程管理所必需的？

## 2. 一句话顿悟

**三类 MBean 的根本差异在于“管理描述从哪里来”。标准 MBean 靠接口命名约定和反射内省自动生成描述；动态 MBean 由对象自己通过 `getMBeanInfo()` 完全自报；MXBean 则在标准接口模型之上，再把复杂 Java 类型映射成开放类型，让远程客户端无需业务类也能稳定理解这些数据。**

## 3. 旧稿优点与问题

### 保留

- 已抓到标准 MBean 命名约定、`StandardMBean` 缓存、`Introspector` 合规检查、MXBean 映射工厂和 DynamicMBean 四方法。
- 已把 `CompositeData` 放回远程传输语境，而不是孤立概念。
- 已给出“三句口诀”式对照，方向是对的。

### 必须重写

- 旧稿偏知识卡片，需要先立住总问题：管理描述到底从哪里来。
- 标准/动态/MXBean 要统一到“描述来源 + 远程数据表示”这条主线上。
- `StandardMBean` 和 `Introspector` 的关系要讲成“约定接口如何被翻译成管理契约”。
- MXBean 的价值要更明确落到“复杂类型跨进程可解释”，而不是只列映射表。

## 4. 理解路径

### 第一节：从“JMX 怎么知道你有哪些属性和操作”开场

承接前两篇：名字和注册都已有了，继续追问——管理描述从哪来。先立住总问题：JMX 必须先得到一份管理契约，才能注册和调用。

### 第二节：标准 MBean 为什么是“约定接口 + 反射内省”

证据：
- `Introspector.java:148/253/381/525`
- `StandardMBean.java:126/430/464/811`

主线：
- `XxxMBean` 接口 + `Xxx` 实现类这套约定让 JMX 能识别接口。
- `Introspector` 负责合规检查和接口识别。
- `StandardMBean` 负责把反射得到的描述翻译成 `MBeanInfo` 并缓存。

### 第三节：为什么 `MBeanInfo` 是真正的管理契约

证据：
- 旧稿中的 `MBeanInfo` 四数组结构线索
- `DynamicMBean.java:120`

主线：
- 属性、操作、构造器、通知都要在描述里明确下来。
- 没有这份契约，管理端无法稳定调用对象。
- 这解释了为什么 JMX 不是“看到方法就直接远程反射”。

### 第四节：动态 MBean 为什么把描述权完全交给对象自己

证据：
- `DynamicMBean.java:36/52/68/110/120`

主线：
- 对象自己实现 get/set/invoke/getMBeanInfo。
- 适用于结构运行时变化、约定接口表达不了的场景。
- 自由度高，但也要求实现者自己维护描述与行为一致性。

### 第五节：MXBean 为什么不是“标准 MBean 多个注解”，而是解决远程类型表示问题

证据：
- `MXBean.java:1187`
- `Introspector.java:240`
- `DefaultMXBeanMappingFactory.java:122/497/518/545/601/685/807`

主线：
- MXBean 仍然从接口出发，但额外引入开放类型映射。
- 简单类型原样，枚举/数组/集合/引用/复合对象各有映射器。
- 真正核心是把复杂对象压成客户端都能理解的开放数据结构。

### 第六节：为什么 `CompositeData` 是 MXBean 价值的中心证据

主线：
- 本地 Java 自定义类如果直接远程暴露，客户端未必有这个类定义。
- CompositeData 把复杂对象变成“带描述的结构化数据”。
- 这使得 JConsole、监控系统和其他语言客户端都能消费同一份管理数据。

## 5. 失败方案清单

1. 把三类 MBean 当成语法风格不同的同义写法。
2. 认为标准 MBean 不需要管理描述，只要有接口就能远程调。
3. 用动态 MBean 却不维护 `getMBeanInfo()` 与真实行为一致性。
4. 直接把业务自定义复杂类型暴露给远程客户端，忽略跨进程可解释性。
5. 误以为 MXBean 只是比标准 MBean 多一个注解而已。

## 6. 误解清单

1. getter/setter 被识别成属性只是 JConsole 的显示规则，不是 JMX 契约的一部分。
2. `StandardMBean` 只是一个可选基类，与合规识别关系不大。
3. 动态 MBean 更底层，所以天然比标准 MBean 更适合所有场景。
4. `CompositeData` 只是 Java 端的 Map 语法糖。
5. 远程客户端理解 MXBean 数据时必须依赖业务类字节码。

## 7. 证据清单

- `Introspector.java:148/240/253/381/525`
- `StandardMBean.java:126/430/464/811`
- `DynamicMBean.java:36/52/68/110/120`
- `MXBean.java:1187`
- `DefaultMXBeanMappingFactory.java:122/497/518/545/601/685/807`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇讲三类 MBean 的描述来源和开放类型，不展开通知分发线程模型。
- `ModelMBean` 只做边界说明，不深入其 Descriptor 体系。
- 不扩展到 ByteBuddy/ASM 这类字节码增强工具，它们不在 JMX 类型体系内部。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“管理描述从哪来 → 标准 MBean 如何靠约定和内省生成契约 → 动态 MBean 如何自报契约 → MXBean 为什么要把复杂类型映射成开放类型 → CompositeData 为什么让远程客户端不依赖业务类也能理解数据”。
- 必须把三类 MBean 讲成‘描述来源差异 + 远程表示差异’。
- 必须自然引到 `04-notification.md`。
