# 05. JMX 远程与工具 — 连接器架构、RMI 传输、JConsole 原理

> 🟡 Working | 域 34 JMX 第 5 篇(巨型域 6 篇之五)| Layer 4
> 读者处境: 生产监控怎么连到 JVM——JMX 远程协议与 JConsole/监控工具接入。

### 1. "JMX 远程怎么组织的？" — 连接器架构

场景: JConsole 连本机 JVM——JMX 传输链是什么?

- `JMXConnectorServer`(remote 包): 服务端——接受连接,把远程请求映射到本地 MBeanServer
- `JMXConnector`(客户端): JConsole/监控端——**远程 MBeanServer 代理**(接口一致)
- `JMXConnectorFactory.connect(JMXServiceURL, ...)` — 协议分发
- `JMXServiceURL`: `service:jmx:rmi:///jndi/rmi://host:port/jmxrmi`
- 关键设计 (斜体): *"连接器 = 协议适配层"——服务端暴露,客户端代理,双端接口对称;面试"JMX 远程结构"——connector server/client + 协议*
- 生产: `-Dcom.sun.management.jmxremote.port=9010` 开启远程(域 34 第 6 篇)
- [关联: 域 34 第 3 篇 MXBean 开放类型——远程传输的基础]

### 2. "RMI 协议传输" — 请求-响应

场景: 远程 getAttribute — 网络包里是什么?

- 协议实现: RMI 传输位于 **java.management.rmi 模块**(com.sun.jmx.remote.protocol.rmi,**本规划已删该模块**,概念引用: RMIConnector/Server)— 客户端代理 → RMI 调用 → 服务端映射到 MBeanServer
- 请求: 客户端代理 → RMI 调用 → 服务端映射到 MBeanServer.getAttribute → 结果(开放类型)回传
- 序列化: 参数/结果需可序列化(域 18)或开放类型(域 34 第 3 篇)
- 关键设计 (斜体): *"远程 = 代理转发 + 序列化"——JMX 的本地接口经 RMI 变成远程调用;面试"为什么 MBean 返回类型要简单"——远程传输需要可序列化/开放类型*
- 面试: "JMX 远程安全"——认证/SSL(com.sun.management.jmxremote.authenticate/ssl)

### 3. "JConsole 的原理" — 管理工具

场景: JConsole 左侧树怎么来的?

- 连接: JMXConnectorFactory.connect → 远程 MBeanServer 代理
- 树: `queryNames("*:*")`(域 34 第 2 篇)→ 按 domain/type 分组
- 面板: Memory(内存池轮询)/Thread(线程 dump)/GC
- 关键设计 (斜体): *"管理工具 = JMX 客户端"——JConsole 的所有面板都是 MBean 操作的封装;面试"JConsole 原理"——连接器 + 查询 + 属性轮询*
- [关联: 内部卷 00-jvm-tools(jconsole 使用层,域 00)]

### 4. "平台 MBean 的暴露" — 默认管理面

场景: JConsole 看到的内存/GC/线程——谁提供的?

- `sun.management` 实现: MemoryImpl(46)等——**平台 MBean**(java.lang 域)
- `ManagementFactory.getMemoryMXBean()` — 程序内访问平台 MBean
- 平台 MBean 清单: 内存池/GC/线程/类加载/操作系统
- 关键设计 (斜体): *"平台 MBean = JVM 自带的监控接口"——JConsole 与程序内 API 同源;面试"怎么在代码里拿内存信息"——ManagementFactory*
- [关联: 内部卷 33-jmx-management(平台 MBean 的 JVM 数据源)]

---

### 核心悬念

架构与工具都通了——**生产怎么用**?GC/内存监控的指标怎么读?DiagnosticCommand 怎么执行 jcmd 命令?自定义业务指标怎么暴露?——下一篇: JMX 生产实践。

> → [06-production-practice.md](06-production-practice.md)
