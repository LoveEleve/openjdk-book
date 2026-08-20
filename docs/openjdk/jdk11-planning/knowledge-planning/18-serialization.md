# 域 18: 序列化 — 知识规划

> 源码路径: java.base/share/classes/java/io/{Serializable,ObjectInputStream(4,170),ObjectOutputStream(2,468),ObjectStreamClass(2,209),ObjectStreamConstants,Externalizable,ObjectStreamField,ObjectStreamException}.java
> 源码量: 8 文件 / ~10,000 行 | 接近巨型域阈值(按巨型域分段写作)
> 写作层: Layer 3(前置: 域 17 IO 流、04 反射)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| Serializable.java (180) | **标记接口**: 无方法;serialVersionUID 语义注释(138-144: 版本不匹配抛 InvalidClassException) | High |
| ObjectStreamConstants.java (245) | **线协议**: STREAM_MAGIC=0xaced/STREAM_VERSION=5(44)、TC_* 类型标记(57-130:TC_NULL 0x70/TC_OBJECT 0x73/TC_CLASSDESC 0x72/TC_STRING/TC_ARRAY/TC_ENUM)、baseWireHandle(140)、SC_* 标志(150-170:SC_SERIALIZABLE/SC_EXTERNALIZABLE/SC_WRITE_METHOD) | High |
| ObjectOutputStream.java (2468) | **写入流程**: writeObject(339)→writeObject0(1096,按类型分派: 普通对象/类描述/字符串/枚举/数组)、HandleTable handles(176,引用跟踪: 循环引用/共享对象只写一次) | High |
| ObjectOutputStream.java | **普通对象写入**: writeOrdinaryObject→serialize 流程(描述符+字段+writeObject 私有方法数据) | High |
| ObjectInputStream.java (4170) | **读取流程**: readObject(445)→readObject0(1619,按 TC_ 分派)、readClassDesc(1852)/readProxyDesc(1891)/readNonProxyDesc(1979) | High |
| ObjectInputStream.java | **对象还原**: readOrdinaryObject→字段填充+readObject 方法+readResolve | High |
| ObjectStreamClass.java (2209) | **类描述**: serialVersionUID(258 计算/251 注释)、fields(172)、私有 writeObject/readObject 方法探测(getPrivateMethod 381-384)、writeReplace/readResolve(392-394)、版本匹配(两端 UID 不符抛 InvalidClassException) | High |
| Externalizable.java (97) | **自定义协议**: writeExternal/readExternal(完全自控,无默认字段) | Medium |
| ObjectStreamField.java (354) | **字段描述**: 名称/类型/签名(原始 vs 对象) | Medium |
| ObjectInputFilter(域) | **反序列化过滤**: setObjectInputFilter(184-191 注释)——JDK9+ 的序列化攻击防线 | High |

*10 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | 线协议与 TC_ 分派 | 3 (Constants/OIS/OOS) | 面试偶尔(格式理解);生产(报文格式/兼容) |
| P1 | serialVersionUID 与版本 | 2 (ObjectStreamClass/Serializable) | 面试必考(UID 不匹配/默认计算) |
| P1 | 引用跟踪与循环 | 1 (OOS handles) | 面试常问(循环引用序列化) |
| P1 | 反序列化安全 | 2 (OIS/ObjectInputFilter) | 面试高频(反序列化漏洞);生产(安全红线) |
| P2 | writeObject/readObject/Externalizable | 2 (ObjectStreamClass/OOS) | 面试常问(自定义序列化) |
| P2 | transient/static 语义 | 1 (Serializable 注释) | 面试必考(哪些字段不序列化) |
| P3 | ObjectStreamField | 1 | 使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | serialVersionUID 与版本兼容 | 面试必考(为什么必须/不写会怎样/默认算法);生产(接口演进) |
| 🔴 Deep | 引用跟踪与循环引用 | 面试常问(两个对象互相引用会死循环吗) |
| 🔴 Deep | 反序列化安全 | 面试高频(RCE 攻击面/gadget);生产(安全规范) |
| 🟡 Working | 线协议 TC_ 标记 | 面试偶尔;理解格式 |
| 🟡 Working | 自定义序列化(writeObject/Externalizable) | 面试常问;生产(定制字段) |
| 🟢 Surface | ObjectStreamField 细节 | 使用层 |

## 04 聚类

### 依赖图(域内)
```
Serializable(标记) ←── ObjectStreamClass(类描述/UID/方法探测)
ObjectOutputStream(写) ←── HandleTable(引用跟踪) + 私有 writeObject
ObjectInputStream(读) ←── ObjectInputFilter(安全) + 私有 readObject/readResolve
ObjectStreamConstants(协议常量) ←── OIS/OOS 共用
Externalizable(自定义) ←── 替代默认机制
```

### 教学顺序与文章拆分(3 篇,接近巨型按分段写)

1. **序列化协议与流程** — STREAM_MAGIC/TC_ 标记、writeObject0/readObject0 分派、HandleTable 引用跟踪(循环/共享)、对象图写读
2. **serialVersionUID 与自定义序列化** — UID 计算与兼容规则、transient/static、私有 writeObject/readObject、writeReplace/readResolve、Externalizable
3. **反序列化安全** — 攻击面(gadget 链)、ObjectInputFilter、生产规范(白名单/过滤/禁用)

> 前置: 域 17(流)、04(反射构造)。跨层: 无 native(纯 Java 协议);反序列化与域 07 类加载(目标类加载)
