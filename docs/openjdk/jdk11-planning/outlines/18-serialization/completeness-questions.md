# 域 18: 序列化 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "serialVersionUID 是什么/不写会怎样" — 02 篇 §1(Serializable.java 注释 138-144, ObjectStreamClass.java:258/1647)
- [x] "transient/static 哪些不序列化" — 01 篇 §4(Serializable.java 注释 92)
- [x] "循环引用能序列化吗(句柄)" — 01 篇 §3(handles 176/assign 1205/1239/1267)
- [x] "反序列化会调用构造器吗" — 01 篇 §4(allocateInstance)
- [x] "新增字段老数据能读吗" — 02 篇 §2(字段名匹配)
- [x] "writeObject/readObject 私有方法怎么被调" — 02 篇 §3(getPrivateMethod 381-384)
- [x] "单例序列化安全(readResolve)" — 02 篇 §4(392-394)
- [x] "反序列化 RCE 原理(gadget)" — 03 篇 §1
- [x] "ObjectInputFilter 怎么防" — 03 篇 §2(61-64/79-82/184-191)
- [x] "深度炸弹/反序列化 DoS" — 03 篇 §3

## 身份 2: 生产工程师
- [x] 版本兼容演进(只加字段+显式 UID)— 02 篇 §2
- [x] 反序列化安全规范 — 03 篇 §4
- [x] 敏感字段加密(transient+钩子)— 02 篇 §3
- [x] 外部输入禁用 Java 序列化 — 03 篇 §4

## 身份 3: 框架工程师
- [x] DTO 脱敏/单例守卫(readResolve)— 02 篇 §4
- [x] RPC/消息序列化选型 — 03 篇 §4
- [x] 自定义协议(Externalizable)— 02 篇 §4

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 ObjectStreamConstants.java:39/44/57-130/140/150-170, ObjectInputStream.java:445/1619/1852/1891/1979/2194, ObjectOutputStream.java:176/240/339/1096/1205/1239/1267/1404, ObjectStreamClass.java:172/188-190/258/301/381-394/602/1647, Serializable.java:92/138-144, Externalizable.java:97, ObjectStreamField.java, ObjectInputFilter.java:61-64/79-82/184-191)/关键设计/跨层([内部卷]/[关联])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 接近巨型域(10K 行)按分段写作执行(3 篇全批自查)

## 身份 5: 完整性缺口检查
- [x] 协议(01)/版本自定义(02)/安全(03)三篇覆盖域全部面试主战场
- [x] Externalizable 并入 02 篇 §4;ObjectStreamField 并入 02 篇 §2
- [x] 未覆盖确认: ObjectStreamClass 缓存/类描述序列化的深层格式(写作时按需);Serializable 的 serialPersistentFields 字段(面试低频,写作时提)
- [x] 二次 review 修正: SUID 算法精确化(SHA-160,MessageDigest.getInstance("SHA"):1776);验证通过: TC_REFERENCE=0x71(62)、FilterInfo 四维度 arrayLength/depth/references/streamBytes(149/158/165/175)、jdk.serialFilter 属性(209-212/248)
- [ ] 待办: 写作时验证 readObject0 的 switch 完整分支、writeObject0 的字符串/枚举路径行号、handle 的 TC_REFERENCE 写入点
