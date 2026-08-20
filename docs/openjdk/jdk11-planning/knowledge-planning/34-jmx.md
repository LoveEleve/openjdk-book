# 域 34: JMX — 知识规划

> 源码路径: java.management/share/classes/(330 文件 97,875 行:javax/management + com/sun/jmx + 子包) + jdk.management/(23 文件) + jdk.management.jfr/(14 文件)
> 源码量: ~370 文件 / ~100,000 行 | 🔴 巨型域(拆 6 篇)
> 写作层: Layer 4(前置: 域 08 集合、11 线程;可观测性域)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| javax/management/MBeanServer.java (806) | **管理服务器接口**: registerMBean(373)/queryNames(404)/getMBeanCount(419)/getAttribute(425)/setAttribute(440)/invoke(454)/removeNotificationListener(489)——管理操作全集 | High |
| com/sun/jmx/interceptor/DefaultMBeanServerInterceptor.java | **拦截器实现**: registerMBean(305)/getAttribute(615)/invoke(799)——注册校验+转发 | High |
| com/sun/jmx/mbeanserver/Repository.java | **注册表**: domainTb(84,双层 Map:domain→名称→NamedObject)——MBean 存储 | High |
| javax/management/ObjectName.java (2169) | **对象名**: 构造(1404,domain:properties 解析)/isPattern(1470)/getCanonicalName(1618)——寻址与模式匹配 | High |
| javax/management/Notification.java (397) | **通知**: type/source/sequenceNumber(183 构造)——事件载体 | High |
| javax/management/NotificationBroadcasterSupport.java (367) | **通知分发**: addNotificationListener(175,ListenerInfo 列表 CopyOnWriteArrayList 183)/sendNotification(227)/notifyListeners(235) | High |
| javax/management/StandardMBean.java (1234) | **标准 MBean 适配**: 接口命名约定(实现类+XxxMBean)到 MBeanInfo 的反射转换 | Medium |
| javax/management/MXBean.java | **MXBean 注解**: @MXBean(true)(67)——开放类型映射 | High |
| com/sun/jmx/mbeanserver/Introspector.java | **MBean 内省**: 从类/接口生成 MBeanInfo(属性/操作/构造器/通知) | High |
| javax/management/monitor/* | **监视器**: CounterMonitor/GaugeMonitor/StringMonitor(轮询采样) | Low |
| javax/management/remote/* | **远程适配**: JMXConnectorServer/RMI 传输——JConsole 接入 | Medium |
| jdk.management/ | **平台实现**: GarbageCollectorExtImpl/GcInfoBuilder、DiagnosticCommand(内存/GC 管理) | Medium |

*12 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | MBeanServer 架构(注册/查询/调用) | 4 (MBeanServer/Interceptor/Repository/ObjectName) | 面试常问(注册流程/架构) |
| P1 | 通知机制 | 2 (Notification/Broadcaster) | 面试偶尔;生产(告警) |
| P1 | MBean 类型与 MXBean | 4 (StandardMBean/DynamicMBean/MXBean/Introspector) | 面试常问(MBean 类型区别/MXBean 作用) |
| P2 | 远程适配 | 2 (remote) | 生产(监控接入) |
| P2 | 平台管理(GC/内存) | 2 (jdk.management) | 生产(内存监控) |
| P3 | monitor/timer | 6 | 面试低频 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | MBeanServer 注册与调用链 | 面试常问(registerMBean 流程/MBeanServer 角色) |
| 🔴 Deep | ObjectName 与寻址 | 面试常问(格式/模式查询) |
| 🔴 Deep | MBean 类型与 MXBean | 面试常问(标准 vs 动态 vs MXBean);生产(自定义指标) |
| 🟡 Working | 通知机制 | 面试偶尔;生产(告警/变更通知) |
| 🟡 Working | 平台 MBean(内存/GC) | 生产(监控与排查) |
| 🟢 Surface | monitor/timer/remote 细节 | 使用层 |

## 04 聚类

### 依赖图(域内)
```
MBeanServer(接口) ←── MBeanServerInterceptor ←── Repository(注册表)
ObjectName(寻址) ←── registerMBean/queryNames
MBean 类型(Standard/Dynamic/MXBean) ←── Introspector(内省)
Notification ←── NotificationBroadcasterSupport(分发) ←── listener
remote(连接器) ←── MBeanServer(远程代理)
```

### 教学顺序与文章拆分(6 篇,巨型域)

1. **JMX 架构全景** — MBeanServer 角色、三物件模型、注册-查询-调用主流程、拦截器链
2. **ObjectName 与注册机制** — ObjectName 格式与规范化、模式匹配、Repository 双层 Map、registerMBean 流程
3. **MBean 类型与 MXBean** — 标准 MBean 约定、DynamicMBean、ModelMBean、MXBean 开放类型、Introspector
4. **通知机制** — Notification 结构、Broadcaster 分发(线程模型)、listener 过滤、monitor/timer
5. **JMX 远程与工具** — remote 连接器(RMI)、JConsole 接入原理、代理模式
6. **JMX 生产实践** — 内存/GC/线程平台 MBean、DiagnosticCommand、自定义指标、与监控系统集成

> 前置: 域 08(集合)、11(线程)。跨层: 平台 MBean 的 JVM 数据来源(内部卷 33-jmx-management)
