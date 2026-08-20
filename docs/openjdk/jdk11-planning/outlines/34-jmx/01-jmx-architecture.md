# 01. JMX 架构全景 — MBeanServer、三物件模型、注册-查询-调用

> 🔴 Deep | 域 34 JMX 第 1 篇(巨型域 6 篇之一)| Layer 4
> 读者处境: 面试"JMX 是什么/怎么工作"——管理架构与核心流程,生产监控的地基。

### 1. "JMX 是什么？" — 管理框架

场景: JConsole 能看到堆内存/GC——JMX 怎么组织的?

- JMX(Java Management Extensions): **管理"运行中对象"的标准框架**——注册、暴露属性/操作、发通知
- 核心角色: **MBean**(可管理对象)+ **MBeanServer**(注册表/调度器)+ **ObjectName**(寻址)+ **Listener**(通知)
- 管理通道: JConsole/监控系统通过 connector 连 MBeanServer(域 34 第 5 篇)
- 关键设计 (斜体): *"JMX = 运行时的可管理接口标准"——MBean 暴露"属性+操作+通知"三要素;面试"JMX 解决什么"——运行时管理(非代码级)
- 面试: "MBean 和普通对象区别"——注册进 MBeanServer 才能被管理

### 2. "MBeanServer 是什么？" — 管理服务器

场景: 注册一个 MBean 后——它在哪、怎么被找到?

- `MBeanServer.java:806` — 接口: registerMBean(373)/queryNames(404)/getAttribute(425)/invoke(454)
- 实现链: `JmxMBeanServer`(com/sun/jmx/mbeanserver/JmxMBeanServer.java,由 MBeanServerFactory.createMBeanServer 191 创建)→ 委托 `DefaultMBeanServerInterceptor`(113)——**拦截器模式**(校验+转发)
- 工厂: `MBeanServerFactory`(191/228/272)
- 关键设计 (斜体): *"MBeanServer = 注册表 + 调用门面"——所有管理操作(注册/查询/调用)都经它;拦截器链允许横切(安全/日志);面试"管理操作怎么路由"——ObjectName → Repository → MBean*
- 面试: "MBeanServer 单例吗?"——可以有多个(domain 隔离);平台默认一个

### 3. "MBean 的三类形态" — 标准/动态/开放

场景: 写一个可管理的类——几种选择?

- **标准 MBean**: 接口命名约定(`XxxMBean` 接口 + `Xxx` 实现)——Introspector 反射生成 MBeanInfo(域 34 第 3 篇)
- **动态 MBean**(DynamicMBean): 运行时动态描述(getMBeanInfo 自报)
- **MXBean**: 开放类型映射(复杂类型 → CompositeData,跨进程可传输)
- 关键设计 (斜体): *"标准=约定优于配置,动态=完全自控,MXBean=类型安全+可远程"——三种形态对应不同复杂度;面试"MBean 类型区别"——按此三句答*
- 生产: 自定义监控指标最常用 MXBean(类型映射友好)
- [关联: 域 04 反射(Introspector 用反射生成描述)]

### 4. "注册-查询-调用" — 主流程

场景: `registerMBean(obj, name)` 到 `getAttribute(name, "X")` — 全链路

- `DefaultMBeanServerInterceptor.java:305` `registerMBean`: 校验(MBean 类型合法性/preRegister 钩子)→ `Repository.register`(域 34 第 2 篇)
- 查询: `queryNames`(MBeanServer:404)→ Repository 模式匹配
- 调用: `getAttribute`(Interceptor:615)/`invoke`(799)— 定位 MBean → 反射/动态分派
- 关键设计 (斜体): *"注册(登记)→ 查询(寻址)→ 调用(反射)"三阶段——管理操作的完整生命周期;面试画 registerMBean 时序图(server→interceptor→repository)*
- 面试: "getAttribute 怎么实现"——ObjectName 定位 → MBean.getAttribute(动态)或反射(标准)

---

### 核心悬念

MBean 注册进了**哪个容器**?`ObjectName("java.lang:type=Memory")` 的格式怎么解析?"domain:key=value" 怎么支持模式匹配?Repository 怎么存?——下一篇: ObjectName 与注册机制。

> → [02-objectname-register.md](02-objectname-register.md)
