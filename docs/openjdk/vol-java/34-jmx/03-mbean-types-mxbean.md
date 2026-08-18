# 03. MBean 类型与 MXBean — 标准约定、动态描述、开放类型映射

> **前置依赖**: [34-jmx/01 — JMX 架构全景](01-jmx-architecture.md)(注册与合规校验)、[04-reflection-annotation/01 — Class 与成员访问](../04-reflection-annotation/01-class-member-access.md)(反射基础)
> → **后续**: [34-jmx/04 — 通知机制](04-notification.md)
> 关联: 域 04 反射(Method/注解读取);域 08 集合(映射容器)

## MBean 的描述从哪来

注册一个 MBean 时,JMX 怎么知道它有哪些属性、哪些操作?答案是: 三种形态,三种描述来源——标准 MBean 靠**接口命名约定 + 反射**,动态 MBean 靠**代码自报**,MXBean 在标准基础上加**开放类型映射**让复杂对象能跨网络传输。这一篇是自定义监控的关键。

## 1. "标准 MBean 的约定" — 接口命名 + 反射内省

### 1.1 命名约定

约定:`XxxMBean` 接口 + `Xxx` 实现类:

```java
// 用法示意(API 形式,非源码片段)
public interface CounterMBean {
    long getCount();     // getter → 属性 count(只读)
    void reset();        // 其他方法 → 操作
}
public class Counter implements CounterMBean { ... }
```

- **getter/setter → 属性**(getXxx/setXxx 前缀方法)
- **其他方法 → 操作**(方法调用)

约定在源码里的实现: `Introspector.implementsMBean` 用 `clName + "MBean"` 拼接后与接口名匹配(`Introspector.java:526-527`)——所以实现类叫 `Counter`,接口必须叫 `CounterMBean`。

### 1.2 StandardMBean: 适配层

`StandardMBean`(`javax/management/StandardMBean.java`,1234 行)是实现 `DynamicMBean` 的**适配层**(`:126`,`implements DynamicMBean, MBeanRegistration`)——把约定接口翻译成管理描述。`getMBeanInfo()`(`:430` 起)先查缓存,没有则构建并 `cacheMBeanInfo`(`:464`)——**内省只做一次,之后走缓存**(`cacheMBeanInfo` 定义在 `:811`)。

面试"属性 vs 操作": get/set 前缀方法 = 属性(可读/可写由 setter 有无决定);其他方法 = 操作。

关键设计(斜体):*"约定优于配置"——getXxx 变属性 xxx、setXxx 变可写属性、其余方法变操作;MBeanInfo 构建一次后缓存。面试"标准 MBean 属性怎么定": getter/setter 命名约定;面试"为什么标准 MBean 简单": 描述是反射自动生成的。*

## 2. "Introspector" — 反射内省器

### 2.1 合规校验

`Introspector`(`com/sun/jmx/mbeanserver/Introspector.java`,698 行)是 MBean 的"反射编译器":

- `checkCompliance(baseClass)`(`:148`,注册时调用,第 1 篇 §4.1)
- `testComplianceMXBeanInterface`(`:240`)/`testComplianceMBeanInterface`(`:253`)——接口形态校验,非法抛 `NotCompliantMBeanException`
- `testCompliance(Class)`(`:218`)返回构建好的 MBeanInfo

### 2.2 MBeanInfo 结构

`MBeanInfo`(`javax/management/MBeanInfo.java`,类 `:107`)四个数组字段(`:131-146`):

| 字段 | 源码 | 内容 |
|------|------|------|
| `attributes` | `:131` | 属性(类型/可读/可写) |
| `operations` | `:136` | 操作(参数/返回) |
| `constructors` | `:141` | 构造器 |
| `notifications` | `:146` | 可发出通知的类型 |

反射来源(域 04): 接口的 Method 元数据 → `MBeanAttributeInfo`/`MBeanOperationInfo`。

面试"MBeanInfo 是什么": MBean 的完整管理契约(四元素);面试"Introspector 干什么": 接口签名 → 管理描述(反射编译器)。

关键设计(斜体):*Introspector = "MBean 的反射编译器"——接口签名转成管理描述,合规校验在注册时把关。面试"MBeanInfo 是什么": MBean 的完整管理契约(属性/操作/构造器/通知四元素);面试"标准 MBean 怎么被识别": XxxMBean/XxxMXBean 接口约定。*

## 3. "MXBean 的开放类型" — CompositeData

### 3.1 识别与注解

MXBean 两种声明方式: 接口名后缀 `XxxMXBean`,或显式 `@MXBean` 注解(`javax/management/MXBean.java`):

```java
// MXBean.java:1187-1192(逐字)
public @interface MXBean {
    boolean value() default true;
}
```

(注解的 Javadoc 示例里 `@MXBean(true)` 出现在 `:67`,定义在 `:1187`。)

### 3.2 开放类型映射

MXBean 的复杂返回类型会被映射成**开放类型**(open type)——任何客户端无需业务类就能解释的数据结构。映射规则集中在 `DefaultMXBeanMappingFactory`(`com/sun/jmx/mbeanserver/DefaultMXBeanMappingFactory.java`):

| 映射类 | 源码 | 规则 |
|--------|------|------|
| `IdentityMapping` | `:497` | 基本类型/字符串等原样 |
| `EnumMapping` | `:518` | 枚举 → 字符串 |
| `ArrayMapping` | `:545` | 数组 → 开放类型数组 |
| `CollectionMapping` | `:601` | 集合 → 数组 |
| `MXBeanRefMapping` | `:685` | 引用其他 MXBean |
| `CompositeMapping` | `:807` | **自定义对象 → CompositeData** |

核心在 `CompositeData`: 开放类型的**键值容器**——"描述 + 数据"分离的结构化数据(类似 map,但带类型描述)。

意义: MXBean 返回 `MemoryUsage` 这样的自定义对象时,映射成 CompositeData 后**任何客户端**(JConsole/监控系统/其他语言的 JMX 客户端)都能解释;标准/动态 MBean 的自定义类型无法远程传输。

面试"MXBean 解决了什么": 自定义类型跨网络传输(开放类型映射);面试"CompositeData 是什么": 开放类型的键值容器(描述+数据分离)。

关键设计(斜体):*"MXBean = 类型安全的远程 MBean"——复杂对象映射为开放类型(CompositeData),任何客户端都能解释。面试"MXBean 解决了什么": 自定义类型跨网络传输;面试"映射规则在哪": DefaultMXBeanMappingFactory 的映射族(CompositeMapping/EnumMapping 等)。*

## 4. "动态 MBean 与 ModelMBean" — 完全自控

### 4.1 DynamicMBean: 自描述自实现

`DynamicMBean`(`javax/management/DynamicMBean.java`,接口 `:36`)没有命名约定,四个方法全部自己实现:

| 方法 | 源码 | 作用 |
|------|------|------|
| `getAttribute` | `:52` | 读属性(自己分派) |
| `setAttribute` | `:68` | 写属性 |
| `invoke` | `:110` | 调操作 |
| `getMBeanInfo` | `:120` | **自报管理描述** |

适用: 属性集运行时变化(如统计 MBean 动态增删指标)——描述权完全交给实现。

### 4.2 ModelMBean(简述)

`modelmbean` 包: 完全由描述符(Descriptor)驱动——属性/操作/通知全在描述符里声明。一般不用,面试低频。

面试"MBean 三种类型怎么选": 固定结构用标准,动态结构用动态,远程传输用 MXBean;生产里 90% 场景 MXBean 足够。

关键设计(斜体):*"标准 = 反射约定,动态 = 代码自报"——动态 MBean 把描述权交给实现(四个方法全自实现)。面试"MBean 三种类型怎么选": 固定结构用标准,动态结构用动态,远程传输用 MXBean;生产: 90% 场景 MXBean 足够。*

跨层标注: [域 04 反射——Introspector 的 Method/注解读取与反射元数据同源;域 08 集合——CompositeData 的键值容器结构;开放类型是远程连接器跨进程传输的基础]

## 核心悬念

MBean 暴露了属性和操作——**变化怎么通知**?`Notification` 的 type/sequenceNumber 结构、`NotificationBroadcasterSupport` 的并发分发、listener 的过滤与线程模型——下一篇: 通知机制。

> → [34-jmx/04 — 通知机制](04-notification.md)
