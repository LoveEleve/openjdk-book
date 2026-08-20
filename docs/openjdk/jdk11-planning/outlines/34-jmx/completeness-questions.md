# 域 34: JMX — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "JMX 是什么/架构" — 01 篇 §1-2(MBeanServer.java:806/373, Interceptor:113)
- [x] "MBean 三种类型区别" — 01 篇 §3/03 篇 §1-3(StandardMBean:126, DynamicMBean, MXBean:67)
- [x] "ObjectName 格式/模式匹配" — 02 篇 §1-2(ObjectName.java:1404/1470/1618)
- [x] "registerMBean 流程" — 02 篇 §4(Interceptor:305)
- [x] "MXBean 开放类型(CompositeData)" — 03 篇 §3(DefaultMXBeanMappingFactory)
- [x] "通知机制(推送 vs 拉取)" — 04 篇 §1-2(Notification:183, NBS:227/248/328)
- [x] "JConsole 原理" — 05 篇 §3
- [x] "JMX 安全(认证/SSL)" — 06 篇 §4
- [x] "怎么暴露业务指标" — 06 篇 §3

## 身份 2: 生产工程师
- [x] 内存/GC 监控(平台 MBean)— 06 篇 §1
- [x] 远程 jcmd(DiagnosticCommand)— 06 篇 §2
- [x] JMX 远程配置与安全 — 06 篇 §4
- [x] 自定义指标暴露 — 06 篇 §3

## 身份 3: 框架工程师
- [x] 可观测性设计(MBean 暴露)— 06 篇 §3
- [x] 事件通知模式 — 04 篇

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 MBeanServer.java:373/404/419/425/440/454/489, MBeanServerFactory.java:191/228/272, DefaultMBeanServerInterceptor.java:113/305/615/799, Repository.java:52/84/508, ObjectName.java:1404/1470/1618, Notification.java:183/304, NotificationBroadcasterSupport.java:175/183/227/235/248/328/331/334, StandardMBean.java:126/415-426, MXBean.java:67, Introspector.java:240/253, DefaultMXBeanMappingFactory.java:286/304/518, CounterMonitor.java:79, Monitor.java:75, JMXConnectorServer.java:65, MemoryImpl.java:46, DiagnosticCommandImpl.java:60/151-170/418)/关键设计/跨层([内部卷 33]/[关联])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 巨型域 6 篇分段写作:1-3 批自查通过→4-6 批

## 身份 5: 完整性缺口检查
- [x] 架构(01)/注册(02)/类型(03)/通知(04)/远程(05)/实践(06)六篇覆盖域全部面试主战场
- [x] remote 的 RMI 协议(域 37 已删)概念引用,不展开
- [x] openmbean/relation/modelmbean 子包(🟢)不入篇
- [x] 未覆盖确认: MBeanServer 的多域/委托细节、MLet 类加载(面试低频)——写作时按需
- [x] 二次 review 修正: MBeanServer 实现类为 **JmxMBeanServer**(com/sun/jmx/mbeanserver/JmxMBeanServer.java:92,非"MBeanServerImpl");RMI 协议位于 java.management.rmi 模块(已删,概念引用已注明);NBS defaultExecutor 为 DirectExecutor 同步执行(334-340)确认
- [ ] 待办: 写作时验证 GarbageCollectorExtImpl 通知细节、sun.management 的 MemoryImpl 轮询实现、JMX 远程协议栈(RMIConnector 路径)
