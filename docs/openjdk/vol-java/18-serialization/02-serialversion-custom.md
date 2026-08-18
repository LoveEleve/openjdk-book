# 02. serialVersionUID 与自定义序列化 — 版本兼容、writeObject/readResolve

> **前置依赖**: [18-serialization/01 — 序列化协议与流程](01-protocol-flow.md)(TC_ 标记与读写流程)、[04-reflection-annotation/01 — Class 与反射](../04-reflection-annotation/01-class-member-access.md)(getDeclaredMethod/setAccessible)
> → **后续**:[18-serialization/03 — 反序列化安全](03-security-filter.md)
> 关联: 域 32 Unsafe(对象创建);内部卷 41-zip-jimage(二进制格式)

## 数据存了一年,突然读不出来了

生产最经典的序列化事故: 对象存进数据库/Redis,几个月后类加了个字段,再读老数据——`InvalidClassException: local class incompatible`。为什么?serialVersionUID 对不上。这一篇把版本指纹、字段兼容规则、四个私有钩子(writeObject/readObject/writeReplace/readResolve)讲透——写完你就知道"加字段为什么崩、怎么加才不崩"。

## 1. "serialVersionUID 是什么？" — 类的版本指纹

### 1.1 不匹配的后果

`Serializable` 的类注释把规则写得很清楚(`Serializable.java:137-144`):

```java
// Serializable.java:137-144(截取核心,逐字)
 * The serialization runtime associates with each serializable class a version
 * number, called a serialVersionUID, which is used during deserialization to
 * verify that the sender and receiver of a serialized object have loaded
 * classes for that object that are compatible with respect to serialization.
 * If the receiver has loaded a class for the object that has a different
 * serialVersionUID than that of the corresponding sender's class, then
 * deserialization will result in an {@link InvalidClassException}.  A
```

**UID 是"类的版本号"**: 序列化时写进流(写的是类描述符的一部分),反序列化时读方类要提供同一个值——对不上直接 `InvalidClassException`。检查在 `ObjectStreamClass.initNonProxy` 里(`ObjectStreamClass.java:555-562`):

```java
// ObjectStreamClass.java:553-562(截取核心,逐字)
            if (model.serializable == osc.serializable &&
                    !cl.isArray() &&
                    suid != osc.getSerialVersionUID()) {
                throw new InvalidClassException(osc.name,
                        "local class incompatible: " +
                                "stream classdesc serialVersionUID = " + suid +
                                ", local class serialVersionUID = " +
                                osc.getSerialVersionUID());
            }
```

### 1.2 两个来源:显式声明 or 默认计算

`getSerialVersionUID`(`ObjectStreamClass.java:258-270`)的取值逻辑: 类初始化时先试**显式声明**(`suid = getDeclaredSUID(cl)`,`ObjectStreamClass.java:367`),得到 null 则在 `getSerialVersionUID` 首次调用时**懒计算**默认值(存到 suid 字段,只算一次):

```java
// ObjectStreamClass.java:258-270(截取核心,逐字)
public long getSerialVersionUID() {
    // REMIND: synchronize instead of relying on volatile?
    if (suid == null) {
        suid = AccessController.doPrivileged(
            new PrivilegedAction<Long>() {
                public Long run() {
                    return computeDefaultSUID(cl);
                }
            }
        );
    }
    return suid.longValue();
}
```

**显式声明**的检测在 `getDeclaredSUID`(`ObjectStreamClass.java:1631-1644`): 反射找名为 `serialVersionUID` 的字段,要求 **static + final**(`ObjectStreamClass.java:1634-1635` 的 mask 检查),满足才 `f.getLong(null)` 取值;否则返回 null 走默认计算。

### 1.3 默认算法:类的结构指纹(SHA 摘要)

`computeDefaultSUID`(`ObjectStreamClass.java:1647`)把**类的结构信息拼成一个字节流,做 SHA-1 摘要,取前 8 字节作 long**:

```java
// ObjectStreamClass.java:1774-1782(截取核心,逐字)
            dout.flush();

            MessageDigest md = MessageDigest.getInstance("SHA");
            byte[] hashBytes = md.digest(bout.toByteArray());
            long hash = 0;
            for (int i = Math.min(hashBytes.length, 8) - 1; i >= 0; i--) {
                hash = (hash << 8) | (hashBytes[i] & 0xFF);
            }
            return hash;
```

摘要输入(`ObjectStreamClass.java:1657-1772`)按固定顺序写入:

1. **类名**(`writeUTF(cl.getName())`,`:1657`)
2. **类修饰符**(PUBLIC/FINAL/INTERFACE/ABSTRACT 四位,`:1659-1661`,接口的 ABSTRACT 位有 javac bug 补偿 `:1663-1672`)
3. **接口名**(排序后逐个 writeUTF,`:1681-1689`)
4. **字段签名**(非 private,或 private 但非 static 非 transient 的字段——`:1708-1710` 的过滤规则;按名字排序 `:1697-1701`)
5. **静态初始化器**(有 `<clinit>` 则写,`:1717-1721`)
6. **构造器签名**(非 private,按签名排序,`:1733-1745`)
7. **方法签名**(非 private,按名字+签名排序,`:1760-1772`)

关键点: **private static/private transient 字段不参与**(`:1708-1710` 的过滤条件: private 且 (static 或 transient) 就跳过);**private 方法、private 构造器也不参与**(`:1740`/`:1767` 的 `(mods & Modifier.PRIVATE) == 0` 过滤)——因为 private 成员不影响序列化格式,也不影响外部可观察行为。其余任何一个元素变化(加 public 方法、改字段类型),摘要就变,UID 就变。

### 1.4 面试点:不写 serialVersionUID 会怎样

- 编译器警告(IDE 可配置强制)
- 运行期按默认算法算——**类结构一变,UID 就变,老数据立刻 InvalidClassException**
- 而"类结构"非常敏感: 加一个 public/protected 方法都变(非 private 方法签名参与摘要;private 方法、private static/private transient 字段不参与)。所以**一律显式声明**: `private static final long serialVersionUID = 1L;`——声明后,类怎么改,UID 不变,兼容性由字段匹配规则(§2)决定

关键设计(斜体):*UID 是"类的结构指纹"——默认算法把类名/修饰符/字段/方法/构造器全部哈希进去,任何结构变化都导致旧数据失效;显式声明把"结构变化"与"数据失效"解耦,让可控演进成为可能。面试"为什么必须声明": 默认计算对编译器实现敏感、对结构变化敏感(加个方法都变),声明后 UID 恒定,兼容与否完全由字段规则决定。生产铁律: 显式声明 + 只加字段不删字段。*

## 2. "版本兼容规则" — 字段按名匹配

### 2.1 对齐规则:按名字,不按位置

老数据用老类序列化,新类反序列化——字段怎么对齐?**按字段名匹配**。实现是 `matchFields`(`ObjectStreamClass.java:2161-2200`): 流字段 `f` 在本地字段里找同名 `lf`(`f.getName().equals(lf.getName())`,`:2184`),匹配规则:

- **新类多出的字段**(本地有、流里没有)→ 赋默认值(null / 0 / false)——老数据里没有它的值
- **新类少了的字段**(本地没有、流里有)→ **忽略**——流里的数据被读出后直接丢弃
- **类型不匹配**(同名不同型)→ `InvalidClassException("incompatible types for field")`(`:2186-2189`;注意只有原始类型才查类型码,对象字段允许不同具体类)

所以协议层面**加字段、删字段都是兼容的**——一个是补默认值,一个是丢弃多余数据。真正不兼容的只有三类: 字段改名、字段改类型、UID 不匹配。生产上"只加不删"的建议是**业务语义**考量: 删字段后,老代码读新数据时该字段取默认值(null),如果老代码假定它非空,照样 NPE——协议兼容,业务不兼容。

### 2.2 readObjectNoData:类层次数据缺失的回调

还有一种缺口: **类层次结构变了**——流里没有把某个父类列为序列化超类(典型: 老版本里父类不是 Serializable,新版本变成了;或父类从序列化层次里删掉)。`Serializable` 的 Javadoc 原话: "in the event that the serialization stream does not list the given class as a superclass of the object being deserialized"(`Serializable.java:101-104`)。`readObjectNoData`(`ObjectStreamClass.java:387-388` 探测,private 方法,签名 `readObjectNoData()`)在此时被回调——类自己决定怎么补(设默认值、抛异常)。

### 2.3 生产兼容策略

- **只加字段**: 新字段给业务默认值,老数据能读
- **显式 UID 恒定**: 结构随便改,UID 不动
- **必要时 readObject 迁移**: 老字段删了/改了,在 readObject 里做数据迁移(§3 的钩子)

关键设计(斜体):*"字段名匹配 + 缺失补默认"是演进的基础——但"默认值"往往是 null/0,业务上可能无效,所以迁移逻辑要自己在 readObject 里补。面试"新增字段老数据能读吗": 能,新字段取默认值;"删除字段呢": 协议上也兼容(多余数据被忽略),但老代码读新数据时被删字段取 null,业务上可能 NPE——所以生产建议只加不删。真正的雷区: 字段改名、改类型、UID 不匹配。*

## 3. "writeObject/readObject 私有方法" — 自定义钩子

### 3.1 框架怎么"找到"私有方法:反射探测

自定义序列化不靠接口,靠**协议约定的私有方法签名**。`ObjectStreamClass` 在初始化时用 `getPrivateMethod`(`ObjectStreamClass.java:1447-1463`)探测:

```java
// ObjectStreamClass.java:1447-1463(截取核心,逐字)
    private static Method getPrivateMethod(Class<?> cl, String name,
                                           Class<?>[] argTypes,
                                           Class<?> returnType)
    {
        try {
            Method meth = cl.getDeclaredMethod(name, argTypes);
            meth.setAccessible(true);
            int mods = meth.getModifiers();
            return ((meth.getReturnType() == returnType) &&
                    ((mods & Modifier.STATIC) == 0) &&
                    ((mods & Modifier.PRIVATE) != 0)) ? meth : null;
        } catch (NoSuchMethodException ex) {
            return null;
        }
    }
```

三个硬条件: **非 static + private + 返回类型匹配**(writeObject 返回 void、readObject 返回 void)。探测到的结果缓存在 ObjectStreamClass 字段(`ObjectStreamClass.java:381-386`):

```java
// ObjectStreamClass.java:380-386(截取核心,逐字)
                        cons = getSerializableConstructor(cl);
                        writeObjectMethod = getPrivateMethod(cl, "writeObject",
                            new Class<?>[] { ObjectOutputStream.class },
                            Void.TYPE);
                        readObjectMethod = getPrivateMethod(cl, "readObject",
                            new Class<?>[] { ObjectInputStream.class },
                            Void.TYPE);
```

### 3.2 调用时机:数据布局的两段式

探测到 writeObject → 类描述符打上 **SC_WRITE_METHOD** 标志(域 18 第 1 篇 §1.3)→ 写入时框架只做一件事(`ObjectOutputStream.java:1485-1489`): **进入块数据模式,invoke 你的 writeObject,块尾写 TC_ENDBLOCKDATA**——方法内部先调 defaultWriteObject(写默认字段)再写自定义数据,是惯例而非框架强制(§3.3):

```java
// ObjectOutputStream.java:1485-1489(截取核心,逐字)
curContext = new SerialCallbackContext(obj, slotDesc);
bout.setBlockDataMode(true);
slotDesc.invokeWriteObject(obj, this);
bout.setBlockDataMode(false);
bout.writeByte(TC_ENDBLOCKDATA);
```

自定义数据以 `TC_ENDBLOCKDATA` 结束(`ObjectStreamConstants.java:98`)。读侧对称: `readObject` 里先 `defaultReadObject()`(恢复默认字段)再读自定义数据。

### 3.3 面试点:defaultWriteObject 调不调?

- **调**:保留默认字段序列化(默认字段在前),自定义数据附加在后——最常见的"加密/压缩/版本迁移"模式: 敏感字段标 transient,writeObject 里加密写入,readObject 里解密恢复
- **不调**:默认字段完全不写,所有字段自己 `writeInt/writeObject` 手写——完全自定义格式

判断依据: SC_WRITE_METHOD 标志只表示"有 writeObject 方法",**不代表默认字段会写**——写不写取决于方法里调不调 defaultWriteObject。读侧对称: readObject 里调 defaultReadObject 才读默认字段。

关键设计(斜体):*"默认机制 + 私有钩子"是序列化的扩展点设计——钩子不是接口方法而是**协议约定的私有签名**(反射查找,域 04),好处是: 不污染继承体系、子类可自由选择是否继承行为。面试"怎么加密敏感字段": transient + writeObject 手动加密 + readObject 解密恢复,三件套;再问"writeObject 必须调 defaultWriteObject 吗": 调=保留默认字段,不调=全自定义。*

跨层标注: [域 04: 01-class-member-access——getDeclaredMethod/setAccessible 的反射机制,getPrivateMethod 是"按协议反射私有方法"的标准用例;域 32 Unsafe——反序列化对象创建(newConstructorForSerialization)与钩子的先后顺序]

## 4. "writeReplace/readResolve 与 Externalizable" — 对象替换与完全自控

### 4.1 替换钩子:序列化形态 ≠ 内存形态

`writeReplace`/`readResolve`(`Serializable.java:117-135` 的签名约定,`ObjectStreamClass.java:392-395` 探测)是"对象级"钩子:

- **`writeReplace`**(写前):返回一个**替换对象**去序列化——内存里的对象 A 变成流里的对象 B
- **`readResolve`**(读后):返回一个**替换对象**给调用方——流里的对象 B 变成内存里的对象 C

探测用的是 `getInheritableMethod`(`ObjectStreamClass.java:1411-1441`)——**沿继承链向上找**,且访问权限规则复杂(PUBLIC/PROTECTED 直接用、PRIVATE 只认本类、包私有要求同包)。

最经典用途:**单例序列化安全**。单例类序列化再反序列化,默认会造一个新实例——违反单例。解法:

```java
// 用法示意(API 形式,非源码片段)
private Object readResolve() throws ObjectStreamException {
    return INSTANCE;   // 无论流里是什么,返回唯一的单例
}
```

`readOrdinaryObject` 的调用时机(`ObjectInputStream.java:2233-2251`): 字段恢复完成后,若有 readResolve 方法则调用,返回值替换原对象(且会更新句柄表,后续引用保持一致)。

### 4.2 Externalizable:完全自控协议

`Externalizable`(`Externalizable.java:66`)extends Serializable,但语义完全不同(`Externalizable.java:82` 的 writeExternal/`:96` 的 readExternal): **没有默认字段机制**——所有字段都由你自己 `writeInt/writeObject` 手写,读方 `readExternal` 按相同顺序读回。写入侧判定在 `writeOrdinaryObject` 的 `desc.isExternalizable()` 分支(域 18 第 1 篇 §2.2,`ObjectOutputStream.java:1420-1421`),构造器则取 `getExternalizableConstructor`(`ObjectStreamClass.java:378`)。

对比:

| | Serializable 默认 | 私有 writeObject | Externalizable |
|--|------|------|------|
| 字段写入 | 自动(非 transient) | defaultWriteObject + 自定义 | 完全手写 |
| 接口 | 无(标记) | 无(私有约定) | writeExternal/readExternal |
| 灵活性 | 最低 | 中(两段式) | 最高(全自控) |
| 类要求 | 无参构造 | 无参构造 | **public 无参构造** |

### 4.3 生产组合:DTO 脱敏与迁移

- **DTO 脱敏**: 内存 DTO 里放明文,writeReplace 换成脱敏 DTO 序列化,readResolve 再换回
- **旧格式迁移**: 老版本类读老数据 → readObject 迁移到新字段 → 新版本写新格式
- **枚举**: 枚举有 TC_ENUM 专用协议(域 18 第 1 篇),自带"按名字匹配"语义,天然防"反射造新实例"

关键设计(斜体):*"替换钩子"是序列化的 AOP——writeReplace 在写前、readResolve 在读后,实现"序列化形态 ≠ 内存形态"(脱敏、单例、迁移);Externalizable 是"自己写协议"(紧凑/性能/完全控制)。面试"单例序列化安全": readResolve 返回单例必答,再加"枚举天然安全(TC_ENUM 按名匹配)"就是高分。*

## 核心悬念

协议、版本、钩子都讲完了——但序列化是 Java 最大的**攻击面**: 反序列化 RCE 漏洞怎么来的?一条精心构造的字节流怎么在你的 JVM 里执行任意代码(gadget 链)?`ObjectInputFilter` 怎么防?为什么白名单才是王道?——下一篇: 反序列化安全。

> → [18-serialization/03 — 反序列化安全](03-security-filter.md)
