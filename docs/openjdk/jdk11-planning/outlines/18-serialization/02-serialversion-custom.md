# 02. serialVersionUID 与自定义序列化 — 版本兼容、writeObject/readResolve

> 🔴 Deep | 域 18 序列化第 2 篇 | Layer 3
> 读者处境: 面试"serialVersionUID 是什么/不写会怎样";生产"老数据反序列化失败"——版本控制与定制钩子。

### 1. "serialVersionUID 是什么？" — 版本指纹

场景: 两端类不一致——JVM 怎么判断"能不能反序列化"?

- `Serializable.java` 注释(138-144): 发送方 UID ≠ 接收方 UID → **InvalidClassException**
- `ObjectStreamClass.java:258` `getSerialVersionUID` — 显式声明或**默认计算**
- 默认计算: `computeDefaultSUID`(`ObjectStreamClass.java:1647`)— 基于类名/修饰符/字段/方法/构造器签名的 **SHA-160 摘要**(`MessageDigest.getInstance("SHA")`,ObjectStreamClass.java:1776)
- 关键设计 (斜体): *UID 是"类的结构指纹"——任何字段/方法变化 → 默认 UID 变 → 旧数据失效;显式声明 UID 让"可控演进"(加字段仍兼容,删除字段需 readObject 兼容处理);面试"为什么必须声明"——默认计算的脆弱性*
- 生产: **一律显式声明**(IDE 生成),否则改类即断兼容;规范: 接口演进加字段可兼容,删字段/改类型不可
- 面试: "不写 serialVersionUID 会怎样?"——编译器警告,运行期按默认算法算——类一改就 InvalidClassException

### 2. "版本兼容规则" — 字段匹配

场景: 老版本序列化的数据,新版本类反序列化——字段怎么对齐?

- 匹配规则: 按**字段名**匹配(非位置);新版本多出的字段 → 默认值;少的字段 → 忽略
- 类型不匹配 → InvalidClassException;`ObjectStreamField`(354)描述字段类型
- `readObjectNoData`(ObjectStreamClass.java:388 探测)— 父类数据缺失时的回调
- 关键设计 (斜体): *"字段名匹配 + 缺失补默认"是演进基础——但"默认值"可能是 null/0(业务上需 readObject 校验);生产兼容策略: 只加字段 + 显式 UID + 必要时 readObject 迁移逻辑*
- 面试: "新增字段老数据能读吗?"——能(默认值);"删除字段呢?"——新读旧没问题,旧读新才出错

### 3. "writeObject/readObject 私有方法" — 自定义钩子

场景: 字段不想直接序列化(加密/压缩/版本迁移)——私有方法怎么被调用?

- `ObjectStreamClass.java:381-384` — `getPrivateMethod(cl, "writeObject"/"readObject")` — **反射探测私有方法**(反射调用,域 04)
- 探测到 writeObject → SC_WRITE_METHOD 标志(域 18 第 1 篇)→ 默认字段后追加自定义数据
- 对应 readObject: 恢复字段后回调(先 defaultReadObject 再自定义)
- 关键设计 (斜体): *"默认机制 + 私有钩子"是序列化的扩展点设计——私有方法不需要实现接口(协议约定反射查找);面试"怎么加密敏感字段"——transient + writeObject 手写 + readObject 恢复*
- [关联: 域 04 反射(getPrivateMethod 的反射调用);域 32 allocateInstance(反序列化绕过构造器创建对象)]
- 面试: "writeObject 里必须调 defaultWriteObject 吗?"——调=保留默认字段,不调=全自定义(需自己写全部字段)

### 4. "writeReplace/readResolve 与 Externalizable" — 对象替换与完全自控

场景: 序列化时想"换个对象"(单例/枚举安全)——钩子家族

- `ObjectStreamClass.java:392-394` — `writeReplace`(写前替换对象)/`readResolve`(读后替换对象)— **继承可及**方法
- 典型: 单例序列化——readResolve 返回单例(防止反射造新实例);枚举自带此语义(TC_ENUM)
- `Externalizable.java:97` — writeExternal/readExternal——**完全自控协议**(无默认字段,全自定义)
- 关键设计 (斜体): *"替换钩子"是序列化的 AOP——writeReplace 在写前、readResolve 在读后,实现"序列化形态 ≠ 内存形态";Externalizable 是"自己写协议"(性能/紧凑);面试"单例序列化安全"——readResolve 必答*
- 生产: DTO 脱敏/加密(替换对象)、单例守卫、旧格式迁移(替换为转换器)

---

### 核心悬念

协议与版本都讲完——但序列化是**攻击面**: 反序列化执行任意代码的 RCE 漏洞怎么来的?`ObjectInputFilter` 怎么防?为什么白名单才是王道?——下一篇: 反序列化安全。

> → [03-security-filter.md](03-security-filter.md)
