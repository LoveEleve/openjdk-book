# 03. 反序列化安全 — 攻击面、ObjectInputFilter、生产规范

> 🔴 Deep | 域 18 序列化第 3 篇 | Layer 3
> 读者处境: 生产"反序列化 RCE"是安全红线;面试"怎么防反序列化攻击"——从攻击原理到 JDK9+ 防线。

### 1. "反序列化漏洞怎么来的？" — gadget 链

场景: 攻击者发的字节流,怎么变成代码执行?

- 漏洞本质: readObject 递归实例化任意类(类名由字节流提供)+ **gadget**(可利用的 readObject/readResolve 方法链)
- 经典: CommonsCollections 链——readObject → 集合操作 → 反射/方法调用 → RCE
- 攻击前提: ① 接受不可信字节流 ② 类路径存在 gadget 库
- 关键设计 (斜体): *"反序列化 = 由外部数据驱动类实例化与钩子调用"——readObject0 按 TC_ 标记无脑造对象,钩子(readObject/readResolve)被自动调用——**数据驱动代码执行**是漏洞根源;面试讲清"gadget 链"即理解攻击面*
- 生产: 不可信输入禁用 Java 序列化(改用 JSON/Protobuf);必须用时白名单
- 面试: "为什么反序列化危险"——任意类实例化 + 自动钩子调用 = 数据变代码

### 2. "ObjectInputFilter 是什么？" — JDK9+ 防线

场景: 老代码无法改——怎么给反序列化加护栏?

- `ObjectInputFilter.java` — 接口(`checkInput(FilterInfo)` 返回 ALLOWED/REJECTED/UNDECIDED,61-64/79-82)
- 设置: `ObjectInputStream.setObjectInputFilter`(实例级,注释 184-191)/`ObjectInputFilter.Config.setSerialFilter`(进程级)
- 过滤维度: 类名/数组长度/对象深度/引用数/总字节数
- 关键设计 (斜体): *过滤器是"深度/大小/类名"三层护栏——限制攻击面(gadget 类被拒)、限制资源消耗(深度炸弹);但**黑名单不可靠**(新 gadget 层出不穷)——白名单才安全;面试"黑白名单取舍"是加分项*
- 生产: `jdk.serialFilter` 系统属性全局配置;允许列表模式(JDK17 的 SetSerialFilter)
- [关联: 域 07 类加载(目标类加载验证);域 06 异常(过滤拒绝抛 InvalidClassException)]

### 3. "深度炸弹与资源攻击" — DoS 面

场景: 恶意字节流不 RCE,但让 JVM OOM——深度炸弹

- 攻击: 深层嵌套对象图(readObject 递归)→ 栈溢出/OOM;大数组声明 → 内存耗尽
- 防线: 过滤器的 depth/array length/stream bytes 限制
- JDK 默认: ObjectInputStream 的 readObject 对类有校验(不可加载/权限),但深度与大小需显式过滤
- 关键设计 (斜体): *序列化攻击两形态: 代码执行(gadget)与资源耗尽(炸弹)——过滤器两个都防;面试"反序列化 DoS"——深度/数组/字节数限制*
- 生产: 反序列化入口统一设置深度+大小上限

### 4. "生产规范" — 安全清单

场景: 团队代码评审的反序列化 checklist

- ① 不可信输入:**禁用 Java 序列化**(JSON/Protobuf/Kryo 等替代,域外)
- ② 必须用:白名单过滤器 + 深度/大小限制 + 类路径精简(无 gadget 库)
- ③ 内部可信场景:显式 UID + 版本管理 + 加密(敏感字段)
- ④ 监控:反序列化失败率/异常类型告警
- 关键设计 (斜体): *"最小攻击面"原则: 能不用就不用、用则白名单、不可信即隔离;面试"反序列化安全最佳实践"——禁用/白名单/限制三连*
- 生产: 网关/消息队列消费侧反序列化入口是重点审查对象

---

### 核心悬念

序列化收官——对象"整体"进出有了,但**字节缓冲与通道**呢?NIO 的 ByteBuffer 怎么管理?DirectByteBuffer 与堆内 Buffer 怎么协同?FileChannel 的 mmap 是什么?——下一篇: 域 19 Buffer 与 Channel。

> → 下一篇: 域 19 Buffer 与 Channel(19-buffer-channel 系列) | 关联: 域 07 类加载(反序列化目标类)
