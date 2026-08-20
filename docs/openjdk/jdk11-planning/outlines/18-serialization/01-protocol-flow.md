# 01. 序列化协议与流程 — STREAM_MAGIC、TC_ 标记、引用跟踪

> 🔴 Deep | 域 18 序列化第 1 篇 | Layer 3
> 读者处境: 面试"循环引用能序列化吗""序列化格式什么样"——线协议与对象图写读,从常量到流程。

### 1. "序列化流长什么样？" — 魔数与类型标记

场景: 序列化后的字节流——第一眼看到什么?

- `ObjectStreamConstants.java:39` — `STREAM_MAGIC = 0xaced` — **魔数**(流的身份)
- `ObjectStreamConstants.java:44` — `STREAM_VERSION = 5`
- TC_ 类型标记(57-130): TC_NULL(0x70)/TC_OBJECT(0x73)/TC_CLASSDESC(0x72)/TC_STRING(0x74)/TC_ARRAY(0x75)/TC_ENUM(0x7E)/TC_REFERENCE(循环引用引用句柄)
- SC_ 标志(150-170): SC_SERIALIZABLE/SC_EXTERNALIZABLE/SC_WRITE_METHOD(有自定义 writeObject 数据)
- 关键设计 (斜体): *"魔数 + 版本 + 类型标记"是二进制协议的通用骨架(与 jimage/zip 同构,内部卷 41);TC_ 标记让读取方"边读边分派"——readObject0 就是按标记的 switch(域 18 第 2 节)*
- 面试: "序列化流怎么识别类型?"——TC_CLASSDESC 后跟类名+UID;协议自描述
- [关联: 内部卷 41-zip-jimage(二进制格式设计);域 17 流]

### 2. "writeObject0/readObject0 怎么分派？" — 类型路由

场景: `oos.writeObject(obj)` — 不同类型走什么路径?

- `ObjectOutputStream.java:339` `writeObject` → `writeObject0`(1096):
  - 字符串/枚举/类描述/数组 → 各自专用路径(writeString/writeEnum/writeClassDesc/writeArray)
  - 普通对象 → `writeOrdinaryObject`(1404): 写描述符 + 字段 + 自定义数据
- `ObjectInputStream.java:445` `readObject` → `readObject0`(1619): **按 TC_ 标记 switch**——TC_OBJECT→readOrdinaryObject(2194)/TC_CLASSDESC→readClassDesc(1852,代理 1891/非代理 1979)
- 关键设计 (斜体): *"写按 Java 类型分派,读按协议标记分派"——两套路由在 TC_ 标记上对齐;协议自描述(读方无需提前知道类型);面试画"读写对称流程"是加分项*
- 面试: "反序列化时类加载器谁负责?"——目标类的加载(域 07 类加载,类名→ClassLoader.loadClass)

### 3. "循环引用会死循环吗？" — HandleTable 引用跟踪

场景: A→B→A 互相引用——序列化会不会栈溢出?

- `ObjectOutputStream.java:176` — `private final HandleTable handles` — **引用句柄表**(已写对象 → 句柄号)
- 机制: 每写一个对象先 `handles.assign`(1205/1239/1267)登记;再次遇到同一对象 → 只写 **TC_REFERENCE + 句柄号**(writeHandle,1096-1170 区域)
- 效果: 循环引用/共享引用只序列化一次,还原后**保持引用同一性**(反序列化回来 A 还是指向同一个 B)
- 关键设计 (斜体): *"对象图"而非"对象流"——序列化保留图结构(引用共享);面试"两个列表共享同一个对象,反序列化后还共享吗?"——是(句柄机制保证);TC_REFERENCE 是循环引用的解*
- 面试: "不写句柄会怎样?"——无限递归/重复对象;句柄表是 O(1) 判定

### 4. "默认序列化写什么？" — 字段与瞬态

场景: `implements Serializable` 后默认序列化哪些字段?

- 默认机制: 写所有 **非 transient 非 static** 的字段(Serializable.java 注释 92 附近)
- `transient`: 跳过(不写);`static`: 类级不写(类描述共享)
- 字段按 ObjectStreamClass.fields(172)描述写入——类型签名(原始/对象)
- 关键设计 (斜体): *"默认序列化 = 实例状态快照"——transient 是"不持久状态"(缓存/连接/密码);面试"哪些字段不序列化"——transient + static + 无参构造约束(反序列化不走构造器)*
- 面试: "反序列化会调用构造器吗?"——**不会**(allocateInstance,域 32)——校验逻辑在 readObject 里(安全相关,第 3 篇)

---

### 核心悬念

协议通了大半——但**类版本不匹配**怎么办?`serialVersionUID` 怎么计算?不写会怎样?`writeObject` 私有方法怎么被调用?`readResolve` 干什么?——下一篇: 版本控制与自定义序列化。

> → [02-serialversion-custom.md](02-serialversion-custom.md)
