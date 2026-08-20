# 34-jmx/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `MBeanServer`、`MBeanServerFactory`、`MBeanServerBuilder`、`JmxMBeanServer`、`DefaultMBeanServerInterceptor`、`Repository`。本文聚焦 JMX 的四角色、MBeanServer 实现链、三类 MBean 形态与注册-查询-调用主流程；ObjectName 细节放到下一篇。
> 目标：把“JMX 架构全景”改写成一篇围绕“JMX 不是一个监控面板，而是把运行中的 Java 对象注册成可寻址、可调用、可扩展通知的管理端点；MBeanServer 负责把名称解析、合规校验、注册存储和最终调用串成一条管理路径”展开的机制文章。

## 1. 读者困惑

- JConsole 为什么能看到 JVM 内存、GC、线程，它到底在访问什么？
- 普通 Java 对象和 MBean 的根本差异是什么，为什么注册后才变得“可管理”？
- `MBeanServer` 到底是注册表、调用门面，还是远程服务端？
- 一个 `registerMBean` 请求内部经过哪些层，为什么不是直接放进一个 Map？
- 标准 MBean、动态 MBean、MXBean 解决的是同一个问题还是不同问题？

## 2. 一句话顿悟

**JMX 的本质不是展示图表，而是给运行中对象建立一套“注册 → 寻址 → 调用/通知”的管理协议。`ObjectName` 负责地址，`MBeanServer` 负责统一入口，拦截器负责校验与分派，Repository 负责登记与查询；MBean 的不同形态则决定对象的管理描述是靠命名约定、运行时自描述，还是开放类型映射生成。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 JMX 四角色、MBeanServer 工厂→门面→拦截器→Repository 链路。
- 已覆盖标准/动态/MXBean 三种形态以及注册、查询、调用主流程。
- 已把 JConsole 与平台 MBean 的关系作为动机，方向正确。

### 必须重写

- 旧稿信息完整但偏“全景卡片”，需要先立住“运行中对象如何变成管理端点”的总问题。
- JMX 四角色要围绕管理生命周期组织，而不是平铺定义。
- MBeanServer 实现链要服务于“为什么不直接 Map + 反射”的解释。
- 三类 MBean 形态要落到“描述信息从哪里来”的统一对照上。

## 4. 理解路径

### 第一节：从“JConsole 看到的不是日志，而是注册过的运行时对象”开场

先建立最小模型：普通对象没有管理身份，注册进 MBeanServer 后才能被外部按 ObjectName 访问属性、操作和通知。

### 第二节：JMX 四角色为什么刚好组成一个管理协议

证据：
- `MBeanServer.java` 文档与接口方法
- 旧稿中的四角色表

主线：
- MBean = 被管理对象及其描述；
- ObjectName = 管理命名空间里的地址；
- MBeanServer = 注册、查询、调用的统一门面；
- Listener = 变化通知出口。

### 第三节：MBeanServer 为什么是“工厂→门面→拦截器→Repository”四层链

证据：
- `MBeanServerFactory.java:191/228/311/329`
- `MBeanServerBuilder.java:104/110`
- `JmxMBeanServer.java:92/252/518/617/674/797`
- `DefaultMBeanServerInterceptor.java:113/128/305/512/615/799`
- `Repository.java:52/478/508`

主线：
- 工厂/Builder 负责构造实现；
- JmxMBeanServer 是外部门面；
- Interceptor 负责校验、安全、生命周期钩子与分派；
- Repository 负责注册表存取与模式查询。
- 解释为什么不能简单地“注册到 Map，然后反射调用”。

### 第四节：三类 MBean 为什么本质是三种“管理描述来源”

主线：
- 标准 MBean：接口命名约定 + 内省；
- 动态 MBean：对象自己通过 `getMBeanInfo` 描述结构；
- MXBean：接口约定 + 开放类型映射，适合跨进程传输。
- 不在本文展开具体接口实现，下一篇再深入 ObjectName。

### 第五节：注册、查询、调用为什么是完整管理生命周期

证据：
- `DefaultMBeanServerInterceptor.registerMBean:305`
- `queryNames:512`
- `getAttribute:615`
- `invoke:799`

主线：
- 注册先做合规校验和权限，再跑生命周期钩子并写入 Repository；
- 查询通过 ObjectName 模式与 QueryExp 找对象；
- 调用先定位，再按 MBean 形态分派到属性/操作。

### 第六节：为什么平台 MBean 和自定义 MBean 可以共用同一套模型

主线：
- JVM 内存、GC、线程等平台对象只是预先注册好的 MBean。
- JConsole、程序内 ManagementFactory 和远程连接器都围绕同一 MBeanServer 模型工作。
- 这把“监控工具”和“自定义可观测对象”收束到同一协议上。

## 5. 失败方案清单

1. 把 JMX 当成只负责画图的监控 UI。
2. 以为普通 Java 对象天然可以被 JConsole 发现。
3. 把 MBeanServer 简化成一个 Map + 反射调用器。
4. 认为三类 MBean 只是三种命名风格，没有管理描述差异。
5. 忽略注册前校验、权限与生命周期钩子，直接讨论调用。

## 6. 误解清单

1. MBean 就是加了几个 getter 的普通对象。
2. ObjectName 只是展示字符串，不参与实际寻址。
3. MBeanServer 在整个 JVM 中只能存在一个。
4. 查询和调用只是 Repository 的简单 Map 查找。
5. JConsole 读到的平台指标来自日志或独立监控代理。

## 7. 证据清单

- `MBeanServer.java:37-51` 文档与核心接口语义
- `MBeanServerFactory.java:191/228/311/329`
- `MBeanServerBuilder.java:104/110`
- `JmxMBeanServer.java:92/252/518/617/674/797`
- `DefaultMBeanServerInterceptor.java:113/128/305/512/615/799`
- `Repository.java:52/478/508`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇讲 JMX 核心架构，不展开 ObjectName 规范化与模式匹配细节。
- 三类 MBean 只建立概念边界，详细类型适配放到后续专题。
- 远程连接器和 RMI 传输留到 `05-remote-tools.md`。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么普通对象注册后才可管理 → JMX 四角色如何组成协议 → MBeanServer 四层实现链各自负责什么 → 三类 MBean 的管理描述从哪里来 → 注册/查询/调用如何串成完整生命周期”。
- 必须把 JMX 讲成运行时管理协议，而不是监控 UI。
- 必须自然引到 `02-objectname-register.md`。
