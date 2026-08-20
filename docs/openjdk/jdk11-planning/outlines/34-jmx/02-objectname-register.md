# 02. ObjectName 与注册机制 — 寻址格式、模式匹配、Repository

> 🔴 Deep | 域 34 JMX 第 2 篇(巨型域 6 篇之二)| Layer 4
> 读者处境: 面试"ObjectName 格式"——domain:key=value 的解析与匹配,注册表结构。

### 1. "ObjectName 的格式" — domain:key=value

场景: `java.lang:type=Memory,name=Heap` — 各部分什么意思?

- `ObjectName.java:1404` 构造 — 解析 `domain:properties`:
  - **domain**: 命名空间(如 java.lang)——同一 domain 内名称唯一
  - **properties**: `key=value` 列表(`,` 分隔)——MBean 定位属性
  - 规范化: 构造时 canonicalize(排序/去空格)
- `getCanonicalName()`(1618)— 规范化形式
- `isPattern()`(1470)— 是否含通配符(*/?)
- 关键设计 (斜体): *"ObjectName = 管理命名空间里的地址"——domain 分域 + 属性寻址;规范化保证同一名称唯一表示;面试"为什么用字符串名"——跨进程可传/可日志*
- 面试: "ObjectName 唯一性"——同 domain 同属性集唯一(注册重复抛 InstanceAlreadyExistsException)

### 2. "模式匹配" — 通配查询

场景: 查所有 Memory 相关 MBean——queryNames 的模式

- 模式: domain 通配 `*:type=Memory`、属性值通配(`name=*`/`?`)
- `queryNames(ObjectName pattern, QueryExp)`(MBeanServer:404)— **模式匹配查询**
- 实现: Repository 遍历匹配(域 34 第 1 篇 404)
- 关键设计 (斜体): *"模式查询 = 管理端批量寻址"——JConsole 左侧树就是 queryNames("*:*")的结果;面试"怎么列出所有 MBean"——queryNames(new ObjectName("*:*"))*
- 生产: 监控系统按 domain/type 批量发现 MBean

### 3. "Repository 的结构" — 双层 Map

场景: 注册 1000 个 MBean——内存里怎么组织?

- `Repository.java:52` — `domainTb`(84): **Map<domain, Map<canonicalName, NamedObject>>** — 双层嵌套
- `register`/`retrieve`: 先 domain 后名称定位
- 并发: 内部 synchronized(注册/查询线程安全)
- 关键设计 (斜体): *"双层 Map"是命名空间的标准实现——domain 分桶 + 名称索引;面试"Repository 为什么两层"——domain 隔离 + O(1) 定位*
- 面试: "查询复杂度"——按 domain 过滤后遍历(模式匹配 O(n))

### 4. "registerMBean 的完整流程" — 校验与钩子

场景: `server.registerMBean(obj, name)` — 一步步发生什么?

- `DefaultMBeanServerInterceptor.java:305` `registerMBean`:
  1. 类型校验(标准/动态/MXBean 合法性,非法抛 NotCompliantMBeanException)
  2. `preRegister` 钩子(MBeanRegistration 接口,可改名/拒绝)
  3. `Repository.register`(放入 domainTb)
  4. `postRegister` 钩子(注册后通知)
- 重复注册: InstanceAlreadyExistsException
- 关键设计 (斜体): *"校验 + 生命周期钩子 + 入表"三步——preRegister/postRegister 让 MBean 感知生命周期;面试"注册流程"——校验/钩子/入表三阶段*
- 生产: MBean 生命周期管理(启动注册/关闭注销 unregisterMBean)
- [关联: 域 06 异常(InstanceAlreadyExistsException 族)]

---

### 核心悬念

注册讲完了——**MBean 的描述从哪来**?标准 MBean 怎么"自动发现"属性和操作?`Introspector` 的反射转换、MXBean 的开放类型映射(复杂对象怎么跨网络)——下一篇: MBean 类型与 MXBean。

> → [03-mbean-types-mxbean.md](03-mbean-types-mxbean.md)
