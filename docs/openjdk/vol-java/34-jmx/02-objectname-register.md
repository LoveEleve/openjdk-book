# 02. ObjectName 与注册机制 — 寻址格式、模式匹配、Repository

> **前置依赖**: [34-jmx/01 — JMX 架构全景](01-jmx-architecture.md)(拦截器、主流程)、[08-collections/01 — ArrayList](../08-collections/01-arraylist.md)(集合结构)
> → **后续**: [34-jmx/03 — MBean 类型与 MXBean](03-mbean-types-mxbean.md)
> 关联: 域 08 集合(嵌套 Map 结构);域 06 异常(异常层次体系)

## "java.lang:type=Memory" 是什么

JConsole 左侧的树里,每个节点都是一个地址——`java.lang:type=Memory` 是 domain `java.lang` 下、type 属性为 Memory 的那个 MBean。这一篇讲这个地址的格式与规范化、通配模式查询、注册表的双层 Map 结构,以及 registerMBean 的完整流程。

## 1. "ObjectName 的格式" — domain:key=value

### 1.1 结构与构造

`ObjectName`(`javax/management/ObjectName.java`,2169 行)的字符串形式:

```
java.lang:type=Memory,name=Heap
└─domain─┘ └─────properties─────┘
```

- **domain**: 命名空间(如 java.lang)——同一 domain 内名称唯一
- **properties**: `key=value` 列表(`,` 分隔)——MBean 定位属性

构造(`ObjectName.java:1404-1407`):

```java
// ObjectName.java:1404-1407(逐字)
    public ObjectName(String name)
        throws MalformedObjectNameException {
        construct(name);
    }
```

`construct` 解析并**规范化**: 属性按键排序(源码注释 "now assigns _ca_array to the sorted list of keys",`ObjectName.java:803`),结果存进 `_canonicalName` 字段(`:363`),`getCanonicalName()`(`:1618-1620`)返回的就是这个规范形式:

```java
// ObjectName.java:1618-1620(逐字)
    public String getCanonicalName()  {
        return _canonicalName;
    }
```

规范化保证"同一名称唯一表示"——`type=Memory,name=Heap` 与 `name=Heap,type=Memory` 是同一个 ObjectName。

### 1.2 唯一性

同一 domain + 同一属性集只对应一个 MBean——重复注册抛 `InstanceAlreadyExistsException`(§4)。

面试"为什么用字符串名": 跨进程可传、可日志、可查询(ObjectName 本身是不可变值对象)。

关键设计(斜体):*ObjectName = "管理命名空间里的地址"——domain 分域 + 属性寻址;规范化保证同一名称唯一表示。面试"ObjectName 唯一性": 同 domain 同属性集唯一,重复注册抛 InstanceAlreadyExistsException。*

## 2. "模式匹配" — 通配查询

### 2.1 模式识别

`isPattern()`(`ObjectName.java:1470-1472`): 用压缩存储的位标志判断是否含通配:

```java
// ObjectName.java:1470-1472(逐字)
    public boolean isPattern() {
        return (_compressed_storage & FLAG_MASK) != 0;
    }
```

模式形态: domain 通配(`*:type=Memory`)、属性值通配(`name=*`/`?`)、属性列表通配(`*:*`)。

### 2.2 查询链路

`queryNames(pattern, query)`(`MBeanServer.java:404`)→ 拦截器实现(`DefaultMBeanServerInterceptor.java:512`)→ `repository.query(name, query)`(`Repository.java:508`)——按 ObjectName 模式匹配 + QueryExp 过滤。

面试"怎么列出所有 MBean": `queryNames(new ObjectName("*:*"))`——JConsole 左侧树就是这么来的。

关键设计(斜体):*"模式查询 = 管理端批量寻址"——JConsole 左侧树是 queryNames("*:*") 的结果。面试"怎么列出所有 MBean": queryNames(new ObjectName("*:*"));生产: 监控系统按 domain/type 批量发现 MBean。*

## 3. "Repository 的结构" — 双层 Map

### 3.1 domainTb: 双层嵌套

`Repository`(`com/sun/jmx/mbeanserver/Repository.java`,674 行)的核心字段(`:84`,注释摘录: "A Hashtable is used for storing the different domains. For each domain, a hashtable contains the instances with canonical key property list string as key"):

```java
// Repository.java:78-84(注释摘录 + 字段,逐字)
     * The structure for storing the objects is very basic.
     * A Hashtable is used for storing the different domains
     * For each domain, a hashtable contains the instances with
     * canonical key property list string as key and named object
     * aggregated from given object name and mbean instance as value.
     */
    private final Map<String,Map<String,NamedObject>> domainTb;
```

**外层 key = domain,内层 key = canonicalKeyPropertyListString(规范化属性串),value = NamedObject(MBean 包装)**。(注释里的 Hashtable 是历史措辞,实际是 HashMap——`domainTb = new HashMap<>(5)`(`:328`)。)

定位(`retrieveNamedObject`,`:286-303`): 先 `domainTb.get(dom)`(`:299`)取 domain 桶,再 `moiTb.get(name.getCanonicalKeyPropertyListString())`(`:302`)取对象——两层 O(1)。

### 3.2 并发与查询复杂度

- 并发保护: 构造里 `lock = new ReentrantReadWriteLock(fairLock)`(`:322`)——**读写锁**(读并发、写独占),不是简单 synchronized
- 查询复杂度: 精确寻址 O(1);模式匹配要遍历(`repository.query`,`:508`)O(n)

面试"Repository 为什么两层": domain 分桶 + 名称索引——domain 隔离 + O(1) 定位;面试"查询复杂度": 精确 O(1),模式匹配 O(n)。

关键设计(斜体):*"双层 Map"是命名空间的标准实现——domain 分桶 + canonical 名称索引。面试"Repository 为什么两层": domain 隔离 + O(1) 定位;并发用 ReentrantReadWriteLock(读多写少)。*

## 4. "registerMBean 的完整流程" — 校验与钩子

`DefaultMBeanServerInterceptor.registerMBean`(`:305-321`)四步(第 1 篇已展示骨架):

1. **类型校验**: `Introspector.checkCompliance(theClass)`(`:313`)——非法形态抛 `NotCompliantMBeanException`
2. **权限检查**: `checkMBeanPermission`(`:317`)+ `checkMBeanTrustPermission`(`:318`)
3. `registerObject`(`:320`)——生命周期核心(截取,逐字):

```java
// DefaultMBeanServerInterceptor.java:908 + 949 + 963(截取,逐字)
        ObjectName logicalName = preRegister(mbean, server, name);
...
            context = registerWithRepository(resource, mbean, logicalName);
...
                postRegister(logicalName, mbean, registered, registerFailed);
```

- `preRegister`(`:908`): **注册前钩子**——MBeanRegistration 接口,可以改 ObjectName、抛异常拒绝注册
- `registerWithRepository`(`:949`): 入表(调 Repository.addMBean,`:384`)
- `postRegister`(`:963`): **注册后钩子**——通知 MBean 注册结果

4. 重复注册: `Repository` 检测到 canonical 名称已存在 → `InstanceAlreadyExistsException`(异常体系见域 06)

面试"注册流程": 校验 → preRegister 钩子 → 入表 → postRegister 钩子四阶段;生产: MBean 生命周期管理(启动注册/关闭 `unregisterMBean`)。

关键设计(斜体):*"校验 + 生命周期钩子 + 入表"三步——preRegister/postRegister 让 MBean 感知自己的生命周期(可改名/可拒绝/可清理)。面试"注册流程": 校验/钩子/入表;生产: 生命周期管理(启动注册、关闭注销)。*

跨层标注: [域 08 集合——domainTb 的嵌套 Map 结构与 HashMap 同源;域 06 异常——InstanceAlreadyExistsException/NotCompliantMBeanException 是异常层次的一部分]

## 核心悬念

注册讲完了——**MBean 的描述从哪来**?标准 MBean 怎么"自动发现"属性和操作?`Introspector` 的反射转换怎么生成 MBeanInfo?MXBean 的开放类型映射(复杂对象怎么跨网络传输)——下一篇: MBean 类型与 MXBean。

> → [34-jmx/03 — MBean 类型与 MXBean](03-mbean-types-mxbean.md)
