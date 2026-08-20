# 34-jmx/05 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 远程 JMX 连接器接口，重点覆盖 `JMXConnector`、`JMXConnectorFactory`、`ManagementFactory`，并结合 JDK 稳定 RMI 连接器 API 结论解释远程代理模型。本文聚焦连接器双端架构、远程代理与平台 MBean 同源性；生产实践留到下一篇。
> 目标：把“JMX 远程与工具”改写成一篇围绕“本地 MBeanServer 只能管理进程内对象，JMX 远程真正做的不是复制一套服务器，而是用连接器把本地管理接口投影成一个远程代理；客户端看到的还是 `MBeanServerConnection`，只是调用已经跨进程”展开的机制文章。

## 1. 读者困惑

- JConsole 不在目标 JVM 进程里，它为什么还能像在本地一样读属性、调操作？
- `JMXConnector` 和 `MBeanServerConnection` 到底扮演什么角色，为什么接口看起来和本地几乎一样？
- `jmx:rmi` 这种 URL 真正决定了什么，它为什么能把调用导向特定协议实现？
- 为什么 MXBean/开放类型在远程场景里突然变得更重要？
- `ManagementFactory.getMemoryMXBean()` 和 JConsole 看到的内存信息，为什么说读的是同一个东西？

## 2. 一句话顿悟

**JMX 远程的核心不是“把 JVM 内部对象直接暴露到网络”，而是用连接器把本地 `MBeanServer` 的管理能力投影成一套远程代理。客户端通过 `JMXConnectorFactory.connect(url)` 拿到 `JMXConnector`，再从它获得 `MBeanServerConnection`；接口形状基本不变，但每次属性读取、操作调用、通知订阅都已经跨过了进程边界。MXBean 与开放类型之所以重要，是因为远程端必须在不依赖业务类定义的前提下也能解释这些数据。**

## 3. 旧稿优点与问题

### 保留

- 已抓到 connector server/client、`JMXConnector.getMBeanServerConnection()`、`JMXConnectorFactory.connect(...)`、平台 MBean 同源性这些关键点。
- 已把 JConsole 放回 JMX 客户端角色，而不是单独工具黑箱。
- 已明确远程传输受可序列化/开放类型约束，这对 MXBean 理解很关键。

### 必须重写

- 旧稿偏架构说明，需要先立住总问题：为什么本地管理接口能被远程“看起来不变”地使用。
- 连接器双端、URL、远程代理、平台 MBean 同源性要统一到“本地接口投影成远程代理”这条主线上。
- RMI 只作为默认协议实例，不宜喧宾夺主；重点仍是代理模型和数据约束。
- JConsole 原理要讲成“连接 + 查询 + 轮询”的客户端行为，而不是工具说明卡片。

## 4. 理解路径

### 第一节：从“JConsole 不在 JVM 里，为什么还能像本地一样看 MBean”开场

承接前四篇：名字、契约、通知都在 JVM 内建立好了。继续追问：这些本地管理接口怎样被推出进程边界。

### 第二节：`JMXConnector` / `MBeanServerConnection` 为什么是远程代理模型的核心

证据：
- `JMXConnector.java:49/134/172`
- `JMXConnectorFactory.java:166/227/264/270`

主线：
- 客户端先 connect，再从 connector 拿到 `MBeanServerConnection`。
- 远程端看到的是“像本地一样”的接口，真正差异藏在连接器与协议实现后面。
- 这说明 JMX 远程追求的是接口连续性，不是重新发明一套远程管理 API。

### 第三节：为什么 `JMXServiceURL` 和协议提供者让连接器成为“协议适配层”

证据：
- 旧稿中的 `JMXServiceURL` 线索与 `connect(url)` 工厂路径

主线：
- URL 决定用哪种协议 provider。
- 连接器工厂不自己硬编码传输细节，而是按协议分发。
- 这让 JMX 的本地管理模型可以被不同远程协议承载。

### 第四节：为什么 RMI 场景的本质不是“用了 RMI”，而是“有了一个远程 MBeanServerConnection 代理”

证据：
- 旧稿中 `RMIConnector` / `RMIConnectorServer` 的稳定 API 结论
- `JMXConnector.getMBeanServerConnection()` 公开接口锚点

主线：
- 客户端通过代理发起调用；
- 服务端把调用映射回本地 MBeanServer；
- 协议只是运输层，核心仍是管理接口投影。

### 第五节：为什么 MXBean/开放类型在远程场景里尤其关键

主线：
- 本地 Java 对象不等于远程端也有同样类定义。
- 远程调用结果必须可序列化或开放类型化。
- 这让前一篇的 MXBean 价值在远程场景里真正落地。

### 第六节：为什么 JConsole 和 `ManagementFactory` 读的是同一批平台 MBean

证据：
- `ManagementFactory.java:342/352/429/475`

主线：
- 程序内 API 和远程工具都围绕平台 MBeanServer 工作。
- 只是一个在 JVM 内直接拿接口，一个在 JVM 外经连接器拿代理。
- 这把“程序内管理 API”和“外部监控工具”收束为同源模型。

## 5. 失败方案清单

1. 把远程 JMX 理解成直接把 JVM 内部对象暴露到网络上。
2. 以为 `JMXConnector` 只是拿连接，不影响调用模型。
3. 忽略 URL/协议 provider，假设所有远程 JMX 都只有一种固定传输方式。
4. 在远程 MBean 接口里直接暴露难以序列化或难以解释的自定义复杂类型。
5. 把 JConsole 数据来源和 `ManagementFactory` 视为两套独立接口体系。

## 6. 误解清单

1. 远程 JMX 需要为客户端重新写一套不同于本地的管理接口。
2. `JMXConnectorFactory.connect(...)` 连接成功后就直接拿到 MBean 对象本身。
3. RMI 是 JMX 的本质，而不是一种常见承载协议。
4. 平台 MBean 只存在于 JConsole 里，程序内 API 读的是另一套状态。
5. MXBean 的开放类型映射主要是本地代码美观问题，与远程传输关系不大。

## 7. 证据清单

- `JMXConnector.java:49/134/172`
- `JMXConnectorFactory.java:166/227/264/270`
- `ManagementFactory.java:342/352/429/475`
- 旧稿中 `JMXServiceURL`、`RMIConnector`、`RMIConnectorServer` 的稳定 API 线索

## 8. 版本与边界

- 基于 JDK 11。
- 本篇重点在连接器代理模型，不展开所有远程安全参数和部署细节。
- RMI 仅作为默认协议实例，不把整篇写成 RMI 教程。
- JFR/JMX/JConsole 的协同只作定位说明，实战落到下一篇。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么本地 MBeanServer 需要被连接器投影成远程代理 → `JMXConnector` / `MBeanServerConnection` 如何保持接口连续性 → URL/协议 provider 如何承载远程调用 → 为什么远程场景更依赖 MXBean/开放类型 → 为什么 JConsole 和 `ManagementFactory` 读的是同一批平台 MBean”。
- 必须把远程 JMX 讲成‘本地管理接口的远程投影’，而不是工具/协议清单。
- 必须自然引到 `06-production-practice.md`。
