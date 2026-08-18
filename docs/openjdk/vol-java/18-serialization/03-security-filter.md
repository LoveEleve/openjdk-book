# 03. 反序列化安全 — 攻击面、ObjectInputFilter、生产规范

> **前置依赖**: [18-serialization/01 — 序列化协议与流程](01-protocol-flow.md)(readObject0 分派与钩子调用)、[18-serialization/02 — serialVersionUID 与自定义序列化](02-serialversion-custom.md)(readObject/readResolve 钩子)
> → **后续**: 域 19 Buffer 与 Channel(按写作顺序)
> 关联: 域 07 类加载(反序列化目标类加载);域 06 异常(InvalidClassException);域 04 反射(gadget 链的 invoke)

## 一段字节流,怎么变成代码执行

前两篇把序列化的协议、版本、钩子讲透了。这一篇讲它的另一面: 为什么"反序列化不可信数据"被安全指南列为头号危险?一条精心构造的字节流,能让你的 JVM 执行任意命令——不需要任何权限,只要有人调用了 `readObject()`。这一篇拆三件事: 攻击原理(gadget 链)、JDK9+ 的官方防线(ObjectInputFilter)、以及生产安全规范。

## 1. "反序列化漏洞怎么来的？" — gadget 链

### 1.1 漏洞本质:数据驱动代码执行

回顾第 1 篇的机制: `readObject0` 按 TC_ 标记**无脑造对象**(`ObjectInputStream.java:1619` 的 switch 分派),类名由**字节流提供**;造完对象后,`readObject`/`readResolve` 钩子**自动被调用**(域 18 第 2 篇)。两个事实叠加:

1. **类名来自数据**——攻击者可以在字节流里写任意类的描述符,反序列化框架负责加载并实例化它
2. **钩子自动执行**——只要目标类有 readObject/readResolve(或构造函数有副作用),反序列化就会调用

所以反序列化的本质是: **外部数据驱动类实例化与钩子调用**——数据变成代码。这不是"bug",是机制本身。

### 1.2 gadget 链:从 readObject 到 RCE

单个类的 readObject 一般没危险(它只是恢复字段)。真正的攻击是**gadget 链**: 把多个类串起来,每一环的"合法行为"组合成恶意效果:

```
恶意字节流 → HashMap.readObject(触发 hashCode) → 
   → 某些集合类的特殊方法 → 反射 invoke → Runtime.exec → RCE
```

经典案例是 **CommonsCollections 链**(ysoserial 工具公开): 利用 Apache Commons Collections 的 `TransformedMap`/`InvokerTransformer` 等类的变换器(Transformer)机制,配合其他类的 readObject 触发点,构造一条从"反序列化"到"反射调用任意方法"的链条,最终执行系统命令。**Gadget 库本身是合法依赖**(很多应用都在用),攻击者只是把它们的类组合成了链条。

攻击前提只有两个:
1. **接受不可信字节流**——任何反序列化用户输入/网络数据的入口
2. **类路径存在 gadget 库**——CommonsCollections、Spring、Groovy 等都有历史 gadget

两个前提在大型应用里几乎总是满足——所以这不是"小众漏洞",是普遍攻击面。

关键设计(斜体):*"反序列化 = 由外部数据驱动类实例化与钩子调用"——readObject0 按 TC_ 标记无脑造对象,钩子(readObject/readResolve)被自动调用,这就是**数据驱动代码执行**的根源。面试讲清"gadget 链"即理解攻击面: 单个 readObject 无害,多个类的合法行为组合成恶意链条才致命;两个前提(不可信输入 + gadget 库)缺一不可。*

跨层标注: [域 04: 02-methodaccessor——gadget 链的最后一环通常是反射 invoke;域 07 类加载——反序列化按类名加载目标类,类加载器无法区分"合法类"与"gadget 类"]

## 2. "ObjectInputFilter 是什么？" — JDK9+ 官方防线

### 2.1 接口:checkInput 三态裁决

`ObjectInputFilter`(JDK9+,`ObjectInputFilter.java:104`)是函数式接口,核心方法 `checkInput`(`ObjectInputFilter.java:119`):

```java
// ObjectInputFilter.java:103-119(截取核心,逐字)
@FunctionalInterface
public interface ObjectInputFilter {

    /**
     * Check the class, array length, number of object references, depth,
     * stream size, and other available filtering information.
     ...
     */
    Status checkInput(FilterInfo filterInfo);
```

`FilterInfo`(`ObjectInputFilter.java:126-176`)提供五维信息: `serialClass()`(当前类,可能 null)、`arrayLength()`、`depth()`(嵌套深度)、`references()`(已建对象引用数)、`streamBytes()`(已读字节数)。返回值三态(`ObjectInputFilter.java:184-197`):

```java
// ObjectInputFilter.java:184-197(截取核心,逐字)
    enum Status {
        /**
         * The status is undecided, not allowed and not rejected.
         */
        UNDECIDED,
        /**
         * The status is allowed.
         */
        ALLOWED,
        /**
         * The status is rejected.
         */
        REJECTED;
    }
```

**三态设计是关键**: UNDECIDED 让过滤器可以"只管自己关心的维度,其余交棒"——比如只拒 Remote 类的过滤器对其他类返回 UNDECIDED,不破坏其他过滤器的判断(类注释的示例代码,`ObjectInputFilter.java:78-94`,Remote 拒绝在 `:88-90`)。

### 2.2 设置:实例级 + 进程级

两层设置:

- **实例级**: `ObjectInputStream.setObjectInputFilter(filter)`(`ObjectInputStream.java:1300`)——只影响这一个流
- **进程级**: `ObjectInputFilter.Config.setSerialFilter(filter)`(`ObjectInputFilter.java:306`)——影响所有没设自己过滤器的流

进程级的初始化链(`ObjectInputFilter.java:257-282`): 静态块里**先查系统属性 `jdk.serialFilter`,没配再查 `java.security.Security` 的 `jdk.serialFilter` 属性**,任一命中即用其创建过滤器。`setSerialFilter` 只能设置一次(源码 312-315 的锁 + `IllegalStateException("Serial filter can only be set once")`);`setObjectInputFilter` 也限制**不能在读对象之后设置**(`ObjectInputStream.java:1310-1313` 的 "filter can not be set after an object has been read")。

### 2.3 模式串:createFilter 的四类限制

`Config.createFilter(pattern)`(`ObjectInputFilter.java:383`)把"模式串"编译成过滤器。模式分两类(`ObjectInputFilter.java:325-365` 的 Javadoc):

**限制类**(`parseLimit`,`ObjectInputFilter.java:575-594`):

| 模式 | 限制 | 源码 |
|------|------|------|
| `maxdepth=N` | 对象图最大深度 | `:582` |
| `maxarray=N` | 数组最大长度 | `:584` |
| `maxrefs=N` | 最大引用数 | `:586` |
| `maxbytes=N` | 流最大字节数 | `:588` |

**类匹配类**: 无 `!` 前缀的模式匹配到即允许(白名单),`!` 开头的模式匹配到即拒绝(黑名单);`.*`/`.**`/`*` 是包/子包/前缀通配,数组按元素类型匹配。执行时(`Global.checkInput`,`ObjectInputFilter.java:615-656`): **先查四类限制,超限 REJECTED;再按从左到右第一个匹配的模式裁决,无匹配则 UNDECIDED**。

实际检查发生在 `filterCheck`(`ObjectInputStream.java:1329`)——每个对象/数组创建时调用,REJECTED 抛 `InvalidClassException("filter status: ...")`(`ObjectInputStream.java:1368-1369`)。

关键设计(斜体):*过滤器是"深度/大小/类名"三层护栏——maxdepth/maxrefs/maxbytes 限制资源消耗,类模式限制攻击面(gadget 类被拒)。但**黑名单不可靠**: 新 gadget 层出不穷,拒了 CommonsCollections 还有别的库。面试"黑白名单取舍": 白名单(只允许业务类)才是安全基线,黑名单只能做辅助。*

跨层标注: [域 07 类加载——filterCheck 在类描述符加载后、实例化前调用(`ObjectInputStream.java:2013` 的 readNonProxyDesc 时机),拦截发生在"类加载完成、对象创建之前"]

## 3. "深度炸弹与资源攻击" — DoS 面

### 3.1 攻击:不 RCE,但让 JVM 崩溃

gadget 链要 RCE,还要凑链;**资源耗尽攻击**简单得多——恶意字节流合法得不能再合法:

- **深度炸弹**: 嵌套 10 万层的对象图——readObject 递归实例化,栈溢出(StackOverflowError);或每层都是大对象,堆被撑爆(OOM)
- **大数组声明**: 字节流里写一个 `new int[Integer.MAX_VALUE]` 的描述符——`readArray` 读长度后 `filterCheck` 若不过滤,直接分配巨型数组,内存耗尽
- **引用风暴**: 海量小对象 + 句柄表膨胀——GC 压力与内存消耗

### 3.2 防线:同一套过滤器

四类限制正好覆盖四类攻击:

- `maxdepth` → 防深度炸弹(栈溢出)
- `maxarray` → 防大数组(内存耗尽)
- `maxrefs` → 防引用风暴(句柄表膨胀)
- `maxbytes` → 防超大流(带宽/内存)

`readHandle` 里的"无类检查"(`ObjectInputStream.java:1819` 的 `filterCheck(null, -1)`)就是专门为引用/深度/字节数这类**与类无关**的维度设计的——即使这次不是新对象,限制依然生效。

### 3.3 JDK 默认值:有,但不够

ObjectInputStream 本身有一些内置校验: 类加载失败/权限不足会抛异常、句柄号越界抛 `StreamCorruptedException`(`ObjectInputStream.java:1803-1805`)。**但没有深度/大小上限**——这是应用层要配的(设计考量: 合法的业务流也可能很大,框架无法替应用决定通用上限)。

关键设计(斜体):*序列化攻击两形态: 代码执行(gadget)与资源耗尽(炸弹)——过滤器两个都防: 类模式管代码执行,四类限制管资源消耗。面试"反序列化 DoS": 深度/数组/引用/字节数四维限制缺一不可;再问"为什么框架不默认限制": 合法流量大小应用才知道,框架给不了通用上限。*

## 4. "生产规范" — 安全清单

代码评审反序列化入口时的 checklist:

**① 不可信输入:禁用 Java 序列化**
安全指南的第一条建议(`ObjectInputFilter.java:43-49` 的 Javadoc 原文): "Deserialization of untrusted data is inherently dangerous and should be avoided"。跨系统/跨网络的不可信数据,用 JSON/Protobuf/Kryo 等格式替代(域外)——**序列化是自描述的对象图,替代格式是自描述的纯数据,没有"钩子自动调用"的机制**。

**② 必须用时:白名单 + 限制 + 精简类路径**
- 白名单过滤器: 只允许业务包(如 `java.base/*;com.example.dto.*`),其余全拒
- 四类限制: maxdepth/maxarray/maxrefs/maxbytes 按业务量级配置
- 类路径精简: 移除未使用的 gadget 候选库(CommonsCollections 没在用就删掉)

**③ 内部可信场景:版本与加密**
显式 UID(域 18 第 2 篇)+ 字段兼容管理 + 敏感字段 transient 或加密。

**④ 监控:失败即告警**
反序列化异常率、`InvalidClassException`/`StreamCorruptedException` 类型分布——异常暴增往往是攻击尝试的信号。

关键设计(斜体):*"最小攻击面"原则: 能不用就不用(禁用)、用则白名单(只许业务类)、不可信即隔离(网络边界不许 Java 序列化)。面试"反序列化安全最佳实践": 禁用/白名单/限制三连;生产上网关、消息队列消费侧、缓存反序列化入口是重点审查对象——每一个 `readObject(用户数据)` 都是潜在 RCE。*

## 核心悬念

序列化收官——对象"整体"进出字节流有了。但**字节缓冲与通道**呢?NIO 的 ByteBuffer 怎么管理?DirectByteBuffer 与堆内 Buffer 怎么协同?FileChannel 的 mmap 是什么?那些高吞吐 IO 的底层机制,下一站: 域 19 Buffer 与 Channel。

> → 域 19 Buffer 与 Channel(19-buffer-channel 系列)| 关联: 域 07 类加载(反序列化目标类)
