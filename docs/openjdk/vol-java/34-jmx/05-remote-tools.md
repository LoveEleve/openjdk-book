# 05. JMX 远程与工具 — 连接器架构、RMI 传输、JConsole 原理

> **前置依赖**: [34-jmx/02 — ObjectName 与注册机制](02-objectname-register.md)(查询)、[34-jmx/03 — MBean 类型与 MXBean](03-mbean-types-mxbean.md)(开放类型)、[18-serialization/01 — 序列化协议与流程](../18-serialization/01-protocol-flow.md)(传输序列化)
> → **后续**: [34-jmx/06 — JMX 生产实践](06-production-practice.md)
> 关联: 域 18 序列化(远程传输);内部卷 33-jmx(平台 MBean 的 JVM 数据源)

## JConsole 怎么连到远程 JVM

本地的 `MBeanServer` 在 JVM 进程里——JConsole 在进程外,怎么操作它?答案是**连接器**: 服务端把 MBeanServer 暴露到网络上,客户端拿到一个"远程代理",调用的接口与本地一模一样。这一篇讲连接器架构、RMI 协议传输、JConsole 的原理,以及平台 MBean(内存/GC/线程)是谁提供的。

## 1. "JMX 远程怎么组织的" — 连接器架构

### 1.1 双端对称

| 角色 | 类 | 职责 |
|------|-----|------|
| 服务端 | `JMXConnectorServer` | 接受连接,把远程请求映射到**本地 MBeanServer** |
| 客户端 | `JMXConnector`(`JMXConnector.java:49`,接口) | JConsole/监控端——`getMBeanServerConnection()`(`:134`)返回 `MBeanServerConnection`,**接口与本地 MBeanServer 一致**(远程代理) |
| 工厂 | `JMXConnectorFactory.connect(url)`(`:227`) | 按 URL 协议分发到对应 Provider |

### 1.2 JMXServiceURL

连接地址的格式(`JMXServiceURL.java:59` 注释 `service:jmx:<protocol>:<sap>`,前缀校验在 `:162` `"service:jmx:"`):

```
service:jmx:rmi:///jndi/rmi://host:port/jmxrmi
└─前缀─┘ └─协议─┘ └───────地址(sap)───────┘
```

生产开启远程: `-Dcom.sun.management.jmxremote.port=9010`(attach 本地进程的 JMX 本地代理除外)。

面试"JMX 远程结构": connector server(服务端暴露)+ connector(客户端代理),双端接口对称,协议由 URL 决定。

关键设计(斜体):*"连接器 = 协议适配层"——服务端暴露,客户端代理,双端接口对称(JMXConnector 的 getMBeanServerConnection 与本地接口一致)。面试"JMX 远程结构": connector server/client + 协议分发(工厂按 URL 找 Provider)。*

## 2. "RMI 协议传输" — 请求-响应

### 2.1 实现位置与验证

RMI 协议实现位于 **java.management.rmi 模块**(`javax/management/remote/rmi/` 包)。注意: 本分析树**已裁剪掉该模块**,以下结构经系统 JDK 的 `javap` 验证(该 API 自 1.5 稳定,JDK11 与验证版本一致,不写行号锚点):

```
RMIConnector            implements JMXConnector, Serializable     (客户端代理)
RMIConnectorServer      extends JMXConnectorServer                (服务端)
```

`RMIConnector.getMBeanServerConnection()` 返回 `MBeanServerConnection`——一个 **RMI 远程代理**,本地接口不变。

### 2.2 请求-响应流程

```
JConsole ── getAttribute(name, "HeapMemoryUsage")
    │  RMIConnector(代理)
    │  RMI 远程调用
    ▼
RMIConnectorServer ── 映射到本地 MBeanServer.getAttribute
    │  结果(开放类型)回传
    ▼
JConsole 拿到值渲染
```

**序列化约束**: 参数/结果必须可序列化(域 18)或开放类型(第 3 篇)——这正是 MXBean 的意义: 复杂对象映射成 CompositeData 才能跨进程。

面试"为什么 MBean 返回类型要简单": 远程传输需要可序列化/开放类型;面试"JMX 远程安全": 认证/SSL(`com.sun.management.jmxremote.authenticate/ssl` 属性)。

关键设计(斜体):*"远程 = 代理转发 + 序列化"——JMX 的本地接口经 RMI 变成远程调用,接口不变、传输透明。面试"为什么 MBean 返回类型要简单": 远程传输需要可序列化/开放类型;生产: 远程开启要配认证/SSL。*

## 3. "JConsole 的原理" — 管理工具

JConsole 就是一个 **JMX 客户端**:

1. **连接**: `JMXConnectorFactory.connect(url)` → 远程 `MBeanServerConnection`
2. **左侧树**: `queryNames("*:*")`(第 2 篇)→ 按 domain/type 分组渲染
3. **面板**: Memory(内存池属性轮询)/Thread(线程数/线程 dump)/GC(GC 次数与耗时)——全是平台 MBean 的属性与操作

面试"JConsole 原理": 连接器 + 查询 + 属性轮询——它的所有面板都是 MBean 操作的封装。

关键设计(斜体):*"管理工具 = JMX 客户端"——JConsole 的所有面板都是 MBean 操作的封装(树=queryNames,面板=属性轮询)。面试"JConsole 原理": 连接器 + 查询 + 属性轮询;生产: 监控系统接入同理。*

## 4. "平台 MBean 的暴露" — 默认管理面

### 4.1 谁提供的

JConsole 看到的内存/GC/线程/类加载/操作系统,来自 **平台 MBean**(`java.lang` 域)——实现位于 `sun.management`(`java.management` 模块内),例如 `MemoryImpl`(`sun/management/MemoryImpl.java:46`,`extends NotificationEmitterSupport`)。

### 4.2 程序内访问

`ManagementFactory`(`java/lang/management/ManagementFactory.java`)暴露同一批 MBean:

| 方法 | 源码 | 返回 |
|------|------|------|
| `getMemoryMXBean()` | `:342` | 堆/非堆内存 |
| `getThreadMXBean()` | `:352` | 线程信息 |
| `getGarbageCollectorMXBeans()` | `:429` | GC 统计 |
| `getPlatformMBeanServer()` | `:475` | 平台 MBeanServer |

面试"怎么在代码里拿内存信息": `ManagementFactory.getMemoryMXBean()`——程序内 API 与 JConsole 读的是**同一个 MBeanServer**(同源)。

关键设计(斜体):*"平台 MBean = JVM 自带的监控接口"——JConsole 与程序内 API 同源(同一个平台 MBeanServer)。面试"怎么在代码里拿内存信息": ManagementFactory.getMemoryMXBean();生产: 内存/GC/线程监控都从这里来。*

跨层标注: [域 18 序列化——远程参数/结果的可序列化约束;域 34 第 3 篇开放类型——MXBean 跨进程传输的数据形态;内部卷 33-jmx——平台 MBean 的 JVM 数据来源]

## 核心悬念

架构与工具都通了——**生产怎么用**?GC/内存监控的指标怎么读?DiagnosticCommand 怎么执行 jcmd 命令?自定义业务指标怎么暴露?——下一篇: JMX 生产实践。

> → [34-jmx/06 — JMX 生产实践](06-production-practice.md)
