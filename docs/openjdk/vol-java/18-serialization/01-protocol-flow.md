# 01. 序列化协议与流程 — STREAM_MAGIC、TC_ 标记、引用跟踪

> **前置依赖**: [13-atomic/03 — 引用原子与 FieldUpdater](../13-atomic/03-reference-updater.md)(不可变对象与引用替换)、[07-classloader/01 — 双亲委派模型](../07-classloader/01-delegation-model.md)(反序列化的类加载)
> → **后续**:[18-serialization/02 — serialVersionUID 与自定义序列化](02-serialversion-custom.md)
> 关联: 内部卷 41-zip-jimage(二进制格式设计);域 32 Unsafe(对象创建与内存分配)

## 一次 writeObject,字节流里发生了什么

`ObjectOutputStream.writeObject(obj)` 一行代码,把一个 Java 对象图变成一坨字节;`ObjectInputStream.readObject()` 再把它变回来。面试从 "循环引用能序列化吗""序列化格式长什么样" 问起——这篇把线协议拆开: 流的身份、类型标记、读写分派、以及引用跟踪怎么保证循环引用不死循环、还保住引用同一性。

## 1. "序列化流长什么样？" — 魔数与类型标记

### 1.1 流的身份:魔数 + 版本

序列化流的最前面是两个 short(`ObjectOutputStream.java:634-636`):

```java
// ObjectOutputStream.java:634-637(截取核心,逐字)
protected void writeStreamHeader() throws IOException {
    bout.writeShort(STREAM_MAGIC);
    bout.writeShort(STREAM_VERSION);
}
```

常量定义在 `ObjectStreamConstants`:

```java
// ObjectStreamConstants.java:39(截取核心,逐字)
static final short STREAM_MAGIC = (short)0xaced;
```

```java
// ObjectStreamConstants.java:44(截取核心,逐字)
static final short STREAM_VERSION = 5;
```

- **`STREAM_MAGIC = 0xaced`**(`ObjectStreamConstants.java:39`):魔数——"这是一条 Java 序列化流"的签名。`0xaced` 在字节流里就是 `AC ED` 两个字节,任何读方先看头两字节就知道流的身份
- **`STREAM_VERSION = 5`**(`ObjectStreamConstants.java:44`):协议版本。读方校验(`ObjectInputStream.java:929-937`): `s0 != STREAM_MAGIC || s1 != STREAM_VERSION` 直接抛 `StreamCorruptedException("invalid stream header")`——**两端协议版本不一致直接拒绝,防跨版本误读**

魔数 + 版本是二进制协议的通用骨架——jimage、zip、class 文件全是这个思路(内部卷 41-zip-jimage)。

### 1.2 TC_ 类型标记:流里的"指令集"

流里每个条目(对象/字符串/数组/类描述/null)前都有一个**类型标记字节** TC_(Type Code)。核心几个(`ObjectStreamConstants.java:57-130`):

| 常量 | 值 | 含义 |
|------|:--:|------|
| `TC_NULL` | `0x70` | null 引用 |
| `TC_REFERENCE` | `0x71` | **引用已写过的对象**(句柄,§3) |
| `TC_CLASSDESC` | `0x72` | 类描述符 |
| `TC_OBJECT` | `0x73` | 普通对象 |
| `TC_STRING` | `0x74` | 字符串 |
| `TC_ARRAY` | `0x75` | 数组 |
| `TC_ENUM` | `0x7E` | 枚举常量(JDK1.5+) |

流是**自描述的**: 读方不需要提前知道"下一个是什么类型",跟着 TC_ 标记走就行。类描述符(TC_CLASSDESC)后面跟类名、serialVersionUID、字段清单——这就是"序列化流怎么识别类型"的答案: 类型信息随流走。

### 1.3 SC_ 标志:类的序列化能力

类描述符里还有一组能力标志(`ObjectStreamConstants.java:150-176`):

- **`SC_SERIALIZABLE = 0x02`**(`:165`):实现了 Serializable
- **`SC_EXTERNALIZABLE = 0x04`**(`:170`):实现了 Externalizable(完全自定义,字段由 writeExternal/readExternal 自控)
- **`SC_WRITE_METHOD = 0x01`**(`:150`):**类定义了私有 writeObject 方法**(有自定义数据块)
- **`SC_BLOCK_DATA = 0x08`**(`:160`):Externalizable 数据按块写入(协议版本 2)
- **`SC_ENUM = 0x10`**(`:176`):枚举类型

读方拿到这些标志就知道: 字段怎么读、后面还有没有自定义数据块、要不要调用 readObject 方法。

关键设计(斜体):*"魔数 + 版本 + 类型标记"是二进制协议的通用骨架——magic 识别格式、version 拒绝跨版本误读、TC_ 标记让读取方"边读边分派"。序列化流的"自描述"特性是它的核心设计: 读方无需预知类型,跟着标记走;代价是每条数据都有标记开销(流更胖)。面试"序列化流怎么识别类型": 答 TC_CLASSDESC 后跟类名 + UID + 字段清单,协议自描述,就抓住了。*

## 2. "writeObject0/readObject0 怎么分派？" — 读写路由

### 2.1 写:按 Java 类型分派

`writeObject`(`ObjectOutputStream.java:339`)把工作交给 `writeObject0`(`ObjectOutputStream.java:1096`)。核心是"先查替换与句柄,再按类型路由"(`ObjectOutputStream.java:1102-1116`):

```java
// ObjectOutputStream.java:1102-1116(截取核心,逐字)
// handle previously written and non-replaceable objects
int h;
if ((obj = subs.lookup(obj)) == null) {
    writeNull();
    return;
} else if (!unshared && (h = handles.lookup(obj)) != -1) {
    writeHandle(h);
    return;
} else if (obj instanceof Class) {
    writeClass((Class) obj, unshared);
    return;
} else if (obj instanceof ObjectStreamClass) {
    writeClassDesc((ObjectStreamClass) obj, unshared);
    return;
}
```

四道检查的次序: ① **`subs.lookup`**(`ObjectOutputStream.java:178` 的 `ReplaceTable`,替换表——对象被 writeReplace 替换过则返回替换品,替换成 null 就写 TC_NULL)② **`handles.lookup`**——已写过则写句柄(§3)③ Class 走类路径 ④ ObjectStreamClass 走类描述符路径。都未命中才进入"按类型分派"主体。

之后的分派(`ObjectOutputStream.java:1161-1177`): 字符串 → `writeString`、数组 → `writeArray`、枚举 → `writeEnum`、Serializable 普通对象 → `writeOrdinaryObject`(`ObjectOutputStream.java:1168-1169`),都不是则抛 `NotSerializableException`。

### 2.2 普通对象的写入:writeOrdinaryObject

`writeOrdinaryObject`(`ObjectOutputStream.java:1404-1430`)是主路径:

```java
// ObjectOutputStream.java:1414-1424(截取核心,逐字;try/finally 省略)
try {
    desc.checkSerialize();

    bout.writeByte(TC_OBJECT);
    writeClassDesc(desc, false);
    handles.assign(unshared ? null : obj);
    if (desc.isExternalizable() && !desc.isProxy()) {
        writeExternalData((Externalizable) obj);
    } else {
        writeSerialData(obj, desc);
    }
}   // ... finally { ... }
```

顺序: ① 写 TC_OBJECT 标记 ② 写类描述符(TC_CLASSDESC + 类名 + UID + 字段)③ **`handles.assign` 先登记句柄**(§3 的关键)④ 写字段数据(或 Externalizable 自定义数据)。

### 2.3 读:按 TC_ 标记分派

读侧是对称的镜像,但路由键不同——**写按 Java 类型分派,读按协议标记分派**。`readObject`(`ObjectInputStream.java:445`)→ `readObject0`(`ObjectInputStream.java:1619`),`switch (tc)` 大分派(`ObjectInputStream.java:1646-1687`):

```java
// ObjectInputStream.java:1646-1687(截取核心,逐字;TC_EXCEPTION/TC_BLOCKDATA 等后续分支省略)
switch (tc) {
    case TC_NULL:
        return readNull();

    case TC_REFERENCE:
        // check the type of the existing object
        return type.cast(readHandle(unshared));

    case TC_CLASS:
        if (type == String.class) {
            throw new ClassCastException("Cannot cast a class to java.lang.String");
        }
        return readClass(unshared);

    case TC_CLASSDESC:
    case TC_PROXYCLASSDESC:
        if (type == String.class) {
            throw new ClassCastException("Cannot cast a class to java.lang.String");
        }
        return readClassDesc(unshared);

    case TC_STRING:
    case TC_LONGSTRING:
        return checkResolve(readString(unshared));

    case TC_ARRAY:
        if (type == String.class) {
            throw new ClassCastException("Cannot cast an array to java.lang.String");
        }
        return checkResolve(readArray(unshared));

    case TC_ENUM:
        if (type == String.class) {
            throw new ClassCastException("Cannot cast an enum to java.lang.String");
        }
        return checkResolve(readEnum(unshared));

    case TC_OBJECT:
        if (type == String.class) {
            throw new ClassCastException("Cannot cast an object to java.lang.String");
        }
        return checkResolve(readOrdinaryObject(unshared));
```

- `TC_OBJECT` → `readOrdinaryObject`(`ObjectInputStream.java:2194`)
- `TC_CLASSDESC`/`TC_PROXYCLASSDESC` → `readClassDesc`(`ObjectInputStream.java:1852`),再按代理/非代理分到 `readProxyDesc`(`:1891`)/`readNonProxyDesc`(`:1979`)
- 未识别的标记 → `StreamCorruptedException("invalid type code: %02X")`(`:1716-1718`)

**两套路由在 TC_ 标记上对齐**: 写方决定写什么标记,读方按标记决定怎么读——这就是协议自描述的落地。

关键设计(斜体):*"写按 Java 类型分派、读按协议标记分派"——写侧路由基于运行时类型(instanceof),读侧路由基于流里的字节(switch tc)。两套路由靠 TC_ 标记对齐,所以读写顺序天然对称。面试画"读写对称流程"是加分项: 写(标记→类描述→句柄→字段),读(标记→类描述→句柄→字段)。反序列化时目标类由**最近的用户定义加载器**按类名加载(域 07 双亲委派),流里没有字节码,只有名字——这也是反序列化安全问题的根源。*

## 3. "循环引用会死循环吗？" — HandleTable 引用跟踪

### 3.1 问题:A→B→A

A 持有 B,B 又持有 A。序列化 A: 写 A 的字段(包括 B)→ 写 B 的字段(包括 A)→ 写 A……如果"见一个写一个",递归永远不结束。**没有句柄机制,循环引用直接栈溢出**。

### 3.2 handles:已写对象的登记表

`ObjectOutputStream` 持有一个 `HandleTable handles`(`ObjectOutputStream.java:176`)。它的职责(`ObjectOutputStream.java:2266-2296`):

- **`assign(obj)`**(`ObjectOutputStream.java:2270`):给对象分配下一个句柄号(从 0 递增),登记到表里
- **`lookup(obj)`**(`ObjectOutputStream.java:2285`):查对象是否已写过,已写返回句柄号,没写返回 -1

实现是"数组哈希表"(`ObjectOutputStream.java:2239-2252`): `spine` 哈希脊柱 + `next` 冲突链 + `objs` 对象数组,**按对象身份(==)查找,O(1) 平均判定**。

### 3.3 关键顺序:先登记,再写字段

为什么能断循环?看 writeOrdinaryObject 的顺序(`ObjectOutputStream.java:1417-1419`): **TC_OBJECT → 类描述 → `handles.assign(obj)` 登记 → 才写字段数据**。写 A 时先登记 A;写到字段里的 B 时,B 的字段又引用 A——**writeObject0 一进来看 lookup(A) 命中,不再递归,只写 `TC_REFERENCE + 句柄号`**:

```java
// ObjectOutputStream.java:1194-1197(截取核心,逐字)
private void writeHandle(int handle) throws IOException {
    bout.writeByte(TC_REFERENCE);
    bout.writeInt(baseWireHandle + handle);
}
```

句柄号从 `baseWireHandle = 0x7e0000`(`ObjectStreamConstants.java:140`)开始编码,读侧用 `readInt() - baseWireHandle` 还原(`ObjectInputStream.java:1801`)。

### 3.4 还原:引用同一性保持

读侧对称: `readOrdinaryObject` 在**创建对象后立即** `handles.assign(obj)`(`ObjectInputStream.java:2219`),之后字段里的 TC_REFERENCE 直接查表取回已创建对象(`readHandle`,`ObjectInputStream.java:1797`)。效果:

- **循环引用不死循环**——每个对象只在第一次遇到时完整创建,之后都是句柄
- **共享引用保持同一性**——两个列表共享同一个对象,反序列化回来还是同一个对象(A 引用的 B 就是 C 引用的 B)

这就是"对象图"而非"对象流"的含义: 序列化保留的是**图结构**(含共享与环),不是线性快照。

跨层标注: [内部卷: 41-zip-jimage——句柄号(baseWireHandle 起步)与 jimage/class 文件的索引/表结构同思路: 用"编号"代替重复内容,是二进制格式压缩重复的标准手段]

关键设计(斜体):*"先登记后写字段"是引用跟踪的精髓——句柄必须分配在字段写入之前,循环才能在第二次遇到时短路成 TC_REFERENCE。面试"循环引用能序列化吗": 能,每对象只序列化一次,后续只写句柄;反序列化后引用同一性保持(共享对象还原后还是同一个)。再问"不写句柄会怎样": 无限递归栈溢出 + 共享对象被重复序列化。*

## 4. "默认序列化写什么？" — 字段与瞬态

### 4.1 非 static 非 transient 的字段

`implements Serializable` 后默认序列化哪些字段?答案在 `Serializable` 的类注释(`Serializable.java:91-92`):

```java
// Serializable.java:91-92(截取核心,逐字)
* the default mechanism for restoring the object's non-static and
* non-transient fields.  The defaultReadObject method uses information in
```

**非 static 且非 transient 的字段**才被默认序列化:

- **`transient`**:显式跳过——不写。设计给"不持久状态": 缓存、临时连接、密码明文、派生字段
- **`static`**:类级状态,不写——静态字段属于类不属于实例,同一类的所有实例共享同一份,序列化实例时写它没有意义(读方 JVM 已有自己的值)

字段清单本身由 `ObjectStreamClass` 维护(`ObjectStreamClass.java:369` 的 `getSerialFields`),每个字段带类型签名(原始类型直接写字节,对象类型递归序列化)。

### 4.2 反序列化怎么创建对象:第一个非序列化超类的无参构造器

"反序列化会调用构造器吗?"——**会,但不是你的构造器**。`ObjectStreamClass` 找的是**第一个非序列化超类的无参构造器**(`ObjectStreamClass.java:890-891` 的 Javadoc 原话):

```java
// ObjectStreamClass.java:890-891(截取核心,逐字)
* non-externalizable and its first non-serializable superclass defines an
* accessible no-arg constructor.  Otherwise, returns false.
```

实现是 `getSerializableConstructor`(`ObjectStreamClass.java:1401-1403`):

```java
// ObjectStreamClass.java:1396-1403(截取核心,逐字)
/**
 * Returns subclass-accessible no-arg constructor of first non-serializable
 * superclass, or null if none found.  Access checks are disabled on the
 * returned constructor (if any).
 */
private static Constructor<?> getSerializableConstructor(Class<?> cl) {
    return reflFactory.newConstructorForSerialization(cl);
}
```

`newConstructorForSerialization`(ReflectionFactory)要么复用该无参构造器,要么 `generateConstructor` 生成一个绕过访问控制的构造器(`ReflectionFactory.java:420-428`)——**对象被"造"出来但不执行 Serializable 类的任何构造逻辑**,字段值直接由流填充。这就是为什么:

- 序列化类的构造器里的初始化逻辑(计数器、缓存、校验)在反序列化时**不生效**
- 需要恢复约束时,靠自定义 `readObject` 方法、`readResolve`(枚举单例保护)等钩子——这两类钩子的完整解剖在域 18 后文

关键设计(斜体):*"默认序列化 = 实例状态快照"——只写非 static 非 transient 字段;transient 是"不持久状态"的开关(缓存/连接/密码)。面试"哪些字段不序列化": transient + static;再问"反序列化调用构造器吗": 调用第一个非序列化超类的无参构造器(通过 newConstructorForSerialization),你自己的构造器逻辑不执行——所以校验必须在 readObject 里做,这也正是反序列化攻击面的来源。*

## 核心悬念

协议和流程通了——但**类版本不匹配**怎么办?两端 serialVersionUID 不一致会抛什么异常?不显式声明 UID 时 JVM 怎么算?私有 writeObject 方法是怎么被框架"探测"到并调用的?`readResolve` 为什么能保护单例?——下一篇: serialVersionUID 与自定义序列化。

> → [18-serialization/02 — serialVersionUID 与自定义序列化](02-serialversion-custom.md)
