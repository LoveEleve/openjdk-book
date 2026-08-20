# 03. MBean 类型与 MXBean — 标准约定、动态描述、开放类型映射

> 🔴 Deep | 域 34 JMX 第 3 篇(巨型域 6 篇之三)| Layer 4
> 读者处境: 面试"MBean 类型区别/MXBean 是什么"——描述生成与类型映射,自定义监控的关键。

### 1. "标准 MBean 的约定" — 接口命名 + 反射内省

场景: `interface MemoryMXBean { long getHeapMemoryUsage(); }` — 属性和操作怎么被发现?

- 约定: 接口名 `XxxMBean`/`XxxMXBean` + 实现类 `Xxx`——**getter/setter → 属性,其他方法 → 操作**
- `StandardMBean.java:126` — 实现 DynamicMBean(适配层): 把约定接口转换为 MBeanInfo
- `cacheMBeanInfo`(415-426 区域)— MBeanInfo **缓存**(内省一次)
- 关键设计 (斜体): *"约定优于配置"——getXxx 变属性 xxx、setXxx 变可写属性、其余方法变操作;面试"标准 MBean 属性怎么定"——getter/setter 命名约定*
- 面试: "属性 vs 操作"——get/set 前缀方法 = 属性;其他 = 操作(方法调用)

### 2. "Introspector" — 反射内省器

场景: 接口怎么变成 MBeanInfo(属性/操作/通知列表)?

- `com/sun/jmx/mbeanserver/Introspector.java` — `testComplianceMXBeanInterface`(240)/`testComplianceMBeanInterface`(253)— **合规校验**(非法接口抛 NotCompliantMBeanException)
- MBeanInfo 结构: attributes(属性:类型/可读/可写)+ operations(操作:参数/返回)+ constructors + notifications
- 反射来源(域 04): Method/Field 元数据 → MBeanAttributeInfo/MBeanOperationInfo
- 关键设计 (斜体): *"Introspector = MBean 的反射编译器"——接口签名 → 管理描述;面试"MBeanInfo 是什么"——MBean 的完整管理契约(四元素)*
- [关联: 域 04 反射(Method/注解读取)]

### 3. "MXBean 的开放类型" — CompositeData

场景: MXBean 返回自定义对象——跨网络怎么传?

- `MXBean.java:67` — `@MXBean(true)` 注解(或接口名 XxxMXBean)
- **开放类型映射**(`DefaultMXBeanMappingFactory`): 复杂类型 → CompositeData(键值结构)/枚举 → 字符串/集合 → 数组
- `EnumMapping`(518)/基本类型直映——**映射规则集中**
- 意义: 返回类型可跨连接器传输(标准/动态 MBean 的自定义类型无法远程)
- 关键设计 (斜体): *"MXBean = 类型安全的远程 MBean"——复杂对象映射为开放类型(CompositeData),任何客户端都能解释;面试"MXBean 解决了什么"——自定义类型跨网络传输*
- 面试: "CompositeData 是什么"——开放类型的键值容器(描述+数据分离)
- [关联: 域 34 第 5 篇 远程传输]

### 4. "动态 MBean 与 ModelMBean" — 完全自控

场景: 运行时动态变化的 MBean——DynamicMBean

- `DynamicMBean.java` — 接口: `getMBeanInfo()/getAttribute/setAttribute/invoke` — **自描述自实现**(无约定)
- 适用: 属性集运行时变化(如统计 MBean 动态加指标)
- ModelMBean(modelmbean 包): 完全由描述符驱动(一般不用,面试低频)
- 关键设计 (斜体): *"标准=反射约定,动态=代码自报"——动态 MBean 把描述权交给实现;面试"MBean 三种类型怎么选"——固定结构用标准,动态结构用动态,远程传输用 MXBean*
- 生产: 90% 场景 MXBean 足够;动态 MBean 用于特殊动态管理

---

### 核心悬念

MBean 暴露了属性和操作——**变化怎么通知**?`Notification` 的 type/sequenceNumber 结构、`NotificationBroadcasterSupport` 的并发分发、listener 的过滤与线程模型——下一篇: 通知机制。

> → [04-notification.md](04-notification.md)
