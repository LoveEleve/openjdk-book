# 01. JMX 架构全景 — MBeanServer、三物件模型、注册-查询-调用

> **前置依赖**: [04-reflection-annotation/01 — Class 与成员访问](../04-reflection-annotation/01-class-member-access.md)(反射基础)、[08-collections/01 — ArrayList](../08-collections/01-arraylist.md)(集合结构)
> → **后续**: [34-jmx/02 — ObjectName 与注册机制](02-objectname-register.md)
> 关联: 域 04 反射(Introspector 用反射生成描述);内部卷 33-jmx-management(平台 MBean 的 JVM 数据来源)

## JConsole 怎么看到堆内存

打开 JConsole,堆内存曲线、GC 次数、线程数一目了然——它没读什么日志文件,而是连上一个叫 **JMX** 的标准管理接口,问 JVM:"你的内存 MBean 现在什么值?"。这一篇画 JMX 的全景: 四角色分工、MBeanServer 的实现链(工厂 → 门面 → 拦截器)、MBean 三类形态、以及注册-查询-调用的主流程。

## 1. "JMX 是什么" — 管理框架

JMX(Java Management Extensions)是**管理"运行中对象"的标准框架**: 对象注册进服务器后,外部就能读属性、调操作、收通知,而不需要改应用代码。四个角色:

| 角色 | 职责 |
|------|------|
| `MBean` | 可管理对象——暴露"属性 + 操作 + 通知"三要素 |
| `MBeanServer` | 注册表 + 调用门面——所有管理操作都经它 |
| `ObjectName` | 寻址——"domain:key=value" 唯一定位一个 MBean |
| `Listener` | 通知——MBean 状态变化广播给监听者 |

面试"MBean 和普通对象区别": 普通对象谁也看不见;注册进 MBeanServer 才获得"可管理"的身份。

关键设计(斜体):*JMX = "运行时的可管理接口标准"——MBean 暴露"属性 + 操作 + 通知"三要素,ObjectName 寻址,Listener 收通知。面试"JMX 解决什么": 运行时管理(非代码级改造);面试"MBean 和普通对象区别": 注册进 MBeanServer 才能被管理。*

## 2. "MBeanServer 是什么" — 管理服务器

### 2.1 接口与实现链

`MBeanServer` 接口(`javax/management/MBeanServer.java`,806 行)定义管理操作全集,核心四个:

| 方法 | 源码 | 作用 |
|------|------|------|
| `registerMBean(object, name)` | `:373` | 注册 |
| `queryNames(name, query)` | `:404` | 查询(支持模式匹配) |
| `getAttribute(name, attr)` | `:425` | 读属性 |
| `invoke(name, op, params, sig)` | `:454` | 调操作 |

创建链(`javax/management/MBeanServerFactory.java`):

```
MBeanServerFactory.createMBeanServer()   // :191
  └─ MBeanServerBuilder.newMBeanServer   // :104
  └─ JmxMBeanServer(com/sun/jmx/mbeanserver/JmxMBeanServer.java:92)
      └─ new DefaultMBeanServerInterceptor(...)   // 构造器 :250-253
```

`JmxMBeanServer` 是门面,真正干活的是委托的 `DefaultMBeanServerInterceptor`。委托在构造器里建立:

```java
// JmxMBeanServer.java:250-253(截取,逐字)
        final Repository repository = new Repository(domain);
        this.mbsInterceptor =
            new DefaultMBeanServerInterceptor(outer, delegate, instantiator,
                                              repository);
```

每个管理方法都是一行委托:

```java
// JmxMBeanServer.java:518-523(截取,逐字)
    public ObjectInstance registerMBean(Object object, ObjectName name)
        throws InstanceAlreadyExistsException, MBeanRegistrationException,
               NotCompliantMBeanException  {

        return mbsInterceptor.registerMBean(object, cloneObjectName(name));
    }
```

### 2.2 拦截器模式

`DefaultMBeanServerInterceptor`(`com/sun/jmx/interceptor/DefaultMBeanServerInterceptor.java:113`)持有 `Repository`(注册表,`:128`),在转发前做**校验与横切**(合规检查/权限检查/钩子调用)。拦截器链允许插入自定义横切逻辑(安全/日志)。

面试"MBeanServer 单例吗": 可以有多个(domain 隔离),平台默认一个(管理平台 MBean 的那个)。

关键设计(斜体):*"MBeanServer = 注册表 + 调用门面"——所有管理操作(注册/查询/调用)都经它;实现是"工厂 → 门面 → 拦截器 → 注册表"四层。面试"管理操作怎么路由": ObjectName → 拦截器校验 → Repository 定位 → MBean 执行。*

## 3. "MBean 的三类形态" — 标准/动态/开放

写一个可管理的类,三种选择:

| 形态 | 机制 | 特点 |
|------|------|------|
| **标准 MBean** | 接口命名约定: `XxxMBean` 接口 + `Xxx` 实现类,Introspector 反射生成描述 | 约定优于配置,最常用 |
| **动态 MBean** | 实现 `DynamicMBean`,运行时 `getMBeanInfo()` 自报结构 | 完全自控,结构可变 |
| **MXBean** | `@MXBean` 或接口后缀 `XxxMXBean`——复杂类型映射为开放类型(CompositeData) | 类型安全 + 可远程传输 |

三句口诀: 标准 = 约定优于配置,动态 = 完全自控,MXBean = 类型安全 + 可远程。生产里自定义监控指标最常用 MXBean(类型映射友好,跨进程可传输)。

面试"MBean 类型区别": 按这三句答;问"标准 MBean 怎么被识别": Introspector 按 `XxxMBean`/`XxxMXBean` 接口约定反射(`Introspector.checkCompliance`,`DefaultMBeanServerInterceptor.java:313`)。

关键设计(斜体):*"标准 = 约定优于配置,动态 = 完全自控,MXBean = 类型安全 + 可远程"——三种形态对应不同复杂度。面试"MBean 类型区别": 按此三句答;生产: 自定义监控指标最常用 MXBean(开放类型映射友好,跨进程可传输)。*

## 4. "注册-查询-调用" — 主流程

### 4.1 注册: registerMBean

`DefaultMBeanServerInterceptor.registerMBean`(`:305-321`)四步:

1. `Introspector.checkCompliance(theClass)`(`:313`)——校验类型合法(MBean 形态是否成立)
2. 权限检查(`:317-318`)
3. `registerObject`(`:320`)——内部: `preRegister` 钩子(可改 ObjectName/拦注册,`:908`)→ `Repository.register` 入注册表 → `postRegister` 钩子(`:963`)

### 4.2 查询: queryNames

`queryNames`(接口 `:404`,拦截器实现 `:512`)把查询交给注册表: `repository.query(name, query)`(`:507`)——按 ObjectName 的模式匹配 + QueryExp 过滤。

### 4.3 调用: getAttribute/invoke

`getAttribute`(拦截器 `:615`)/`invoke`(`:799`): ObjectName 定位 MBean → 按形态分派(动态 MBean 走 `getMBeanInfo` 描述,标准 MBean 走反射)。

面试"getAttribute 怎么实现": ObjectName 定位 → 校验 → 按 MBean 形态分派(动态接口或反射)。

关键设计(斜体):*"注册(登记)→ 查询(寻址)→ 调用(分派)"三阶段是管理操作的完整生命周期。面试画 registerMBean 时序图: server → interceptor(校验)→ repository(登记)→ pre/postRegister 钩子;面试"getAttribute 怎么实现": ObjectName 定位 → 形态分派。*

跨层标注: [域 04 反射——Introspector 用反射从接口生成 MBeanInfo;内部卷 33-jmx-management——平台 MBean 的 JVM 数据来源(内存/GC 统计)]

## 核心悬念

MBean 注册进了**哪个容器**?`ObjectName("java.lang:type=Memory")` 的格式怎么解析?"domain:key=value" 怎么支持模式匹配?Repository 的 domainTb 双层 Map 怎么存?——下一篇: ObjectName 与注册机制。

> → [34-jmx/02 — ObjectName 与注册机制](02-objectname-register.md)
