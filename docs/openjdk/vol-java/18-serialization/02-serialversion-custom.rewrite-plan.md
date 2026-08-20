# 18-serialization/02 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Serializable`、`ObjectStreamClass`、`ObjectOutputStream`、`ObjectInputStream`。本文聚焦 `serialVersionUID`、默认 UID 计算、字段兼容规则、`writeObject/readObject/defaultWriteObject/defaultReadObject`、`writeReplace/readResolve` 与 `Externalizable` 对照；安全问题放下一篇。
> 目标：把“serialVersionUID 与自定义序列化”改写成一篇围绕“序列化兼容性不是靠运气，而是靠 UID、字段匹配规则和私有钩子显式管理”的机制文章。

## 1. 读者困惑

- 为什么对象明明没坏，老数据却会在几个月后反序列化时报 `InvalidClassException`？
- `serialVersionUID` 到底在保护什么，为什么不写就会踩坑？
- 默认 UID 是怎么计算出来的，为什么加个 public 方法都可能让它变？
- 新版本加字段、删字段、改字段类型，哪些属于协议兼容，哪些一定会炸？
- `writeObject/readObject/defaultWriteObject/defaultReadObject` 这四个名字到底在分什么工？
- `writeReplace/readResolve` 为什么能改变真正被写出去或最后返回给调用方的对象？
- `Externalizable` 和 `Serializable + 私有钩子` 到底谁控制得更多、代价又在哪？

## 2. 一句话顿悟

**序列化兼容性不是“类稍微改改通常也能读”的运气问题，而是一套明确规则：`serialVersionUID` 先决定读写双方是否被允许继续谈；字段匹配再决定默认数据怎样按名字对齐、哪些取默认值、哪些会直接不兼容；私有 `writeObject/readObject` 与 `writeReplace/readResolve` 则是你在默认协议之上插手格式和恢复逻辑的扩展钩子。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 UID 不匹配导致 `InvalidClassException`、默认 UID 的 SHA 摘要计算、字段按名匹配规则、私有钩子探测和 `writeReplace/readResolve` / `Externalizable` 对照。
- 已抓到“只加不删”是业务兼容建议而非纯协议限制，这个区分很重要。
- 已把安全问题留到下一篇，边界合理。

### 必须重写

- 旧稿偏协议百科，需要先建立总问题：为什么序列化兼容性必须被显式管理，而不能靠类结构自然演进。
- UID 计算要强调“默认值把类结构变化和数据兼容性硬绑定”，而不是只列 SHA 输入项。
- 字段兼容应围绕“加字段/删字段/改名/改类型”这几种最关心的演进动作来组织。
- `writeObject/readObject`、`writeReplace/readResolve`、`Externalizable` 三组机制要讲成不同层次的“协议插手点”，而不是平铺工具清单。

## 4. 理解路径

### 第一节：从“老数据突然读不出来了”开场

用线上最典型事故开场：对象存进数据库/缓存后，几个月后类改了一个字段或方法，再读就报 `InvalidClassException`。先立住主问题：兼容性不是天然存在的，而是协议级检查故意拒绝不兼容类结构。

### 第二节：serialVersionUID 为什么是版本闸门，而不是装饰字段

证据：
- `Serializable.java:137-166`：serialVersionUID 注释与显式声明建议
- `ObjectStreamClass.java:251-264`：`getSerialVersionUID`
- `ObjectStreamClass.java:553-562`：不匹配抛 `InvalidClassException`

主线：
- 流里的类描述会带 UID，本地类也有 UID；两者先比，过不了就直接拒绝后续恢复。
- 这说明 UID 的角色不是“记录版本号”那么宽泛，而是协议兼容的第一道硬闸门。

### 第三节：为什么不显式写 UID 会让结构变化和兼容性被硬绑定

证据：
- `ObjectStreamClass.java:1631-1644`：`getDeclaredSUID`
- `ObjectStreamClass.java:1647`：`computeDefaultSUID`
- `ObjectStreamClass.java:1774-1782`：SHA 摘要收尾
- `Serializable.java:152-169`：默认 UID 警告与显式声明建议

主线：
- 默认 UID 来自类结构指纹：类名、接口、字段、构造器、方法等变化都可能改动它。
- 这会把“类结构改动”与“老数据还能不能读”死死绑在一起。
- 显式声明 UID 的真正价值，是把这两件事解耦，让你自己决定兼容策略。

### 第四节：字段兼容规则为什么是“按名字对齐，而不是按位置抄内存”

证据：
- `ObjectStreamClass.java:2161-2200`：`matchFields`
- `Serializable.java:91-92`：默认恢复非 static / 非 transient 字段

主线：
- 新类多出的字段 → 取默认值；流里多出的字段 → 忽略；同名原始类型不兼容 → 直接异常。
- 这说明默认协议是“按字段名匹配的实例状态恢复”，不是按内存布局恢复。
- 同时强调：协议层“可读”不等于业务层“没问题”，所以才有只加不删等实践建议。

### 第五节：`writeObject/readObject` 为什么是默认协议的扩展插口

证据：
- `ObjectStreamClass.java:1447-1463`：`getPrivateMethod`
- `ObjectStreamClass.java:380-386`：探测 writeObject/readObject
- `ObjectOutputStream.java:430`：`defaultWriteObject`
- `ObjectInputStream.java:615`：`defaultReadObject`
- `ObjectOutputStream.java:1485-1489`：调用自定义 writeObject 与 `TC_ENDBLOCKDATA`

主线：
- 私有钩子是按协议约定反射探测出来的，不靠接口继承。
- 调 `defaultWriteObject/defaultReadObject` = 保留默认字段机制；不调 = 完全自己决定写什么、读什么。
- 这使它成为“在默认协议之上加自定义数据块/迁移逻辑”的中间层扩展点。

### 第六节：`writeReplace/readResolve` 为什么在改“对象本身”，而不只是改字段

证据：
- `Serializable.java:117-135`：方法约定说明
- `ObjectStreamClass.java:392-395`：探测替换钩子
- `ObjectStreamClass.java:1104-1106`：`writeReplace` 调用
- `ObjectStreamClass.java:1134-1136`：`readResolve` 调用
- `ObjectInputStream.java:549-552` / `2233-2251`：读后替换说明与时机

主线：
- writeObject/readObject 改的是“对象怎么写字段”；replace/resolve 改的是“最终写出的到底是不是这个对象、读回后最终交给调用方的是不是这个实例”。
- 单例保护、脱敏 DTO、格式迁移都属于这一层对象替换语义。

### 第七节：Externalizable 为什么是“完全自己写协议”

证据：
- `Externalizable.java:66/82/96`：接口与 writeExternal/readExternal
- `ObjectOutputStream.java:1420-1421`：externalizable 分支
- `ObjectStreamClass.java:378`：externalizable 构造器路线

主线：
- Serializable 默认协议 + 私有钩子，仍然有框架骨架兜着；Externalizable 则是自己全权负责编码顺序和恢复顺序。
- 更自由，也更脆弱，特别适合和默认机制做对照收束。

## 5. 失败方案清单

1. 不显式声明 serialVersionUID，却希望类结构可以自由演进而不影响老数据。
2. 把字段改名/改类型，当成“只是代码重构”而忽略协议兼容性。
3. 在自定义 writeObject 里忘记决定是否调用 defaultWriteObject，结果默认字段语义被悄悄改变。
4. 把 readResolve 当成“又一个字段恢复钩子”，忽略它真正替换的是最终对象身份。
5. 需要完全自定义二进制协议时仍勉强套默认 Serializable 机制。
6. 把“协议兼容可读”和“业务逻辑无问题”混成一件事。

## 6. 误解清单

1. serialVersionUID 只是给开发者看的注释式版本号。
2. 只要类名不变，默认 UID 基本也不会变。
3. Java 序列化兼容是按字段位置自动匹配的。
4. writeObject/readObject 是接口方法，不写就不能自定义。
5. readResolve 只是在反序列化后再修补几个字段。
6. Externalizable 只是 Serializable 的“高级版”而没有额外风险。

## 7. 证据清单

- `Serializable.java:117-166`：writeReplace/readResolve 约定与 UID 说明
- `Serializable.java:91-92`：默认字段范围
- `ObjectStreamClass.java:251-264`：`getSerialVersionUID`
- `ObjectStreamClass.java:367`：显式 SUID 探测入口
- `ObjectStreamClass.java:380-386`：writeObject/readObject 探测
- `ObjectStreamClass.java:392-395`：replace/resolve 探测
- `ObjectStreamClass.java:553-562`：UID 不匹配异常
- `ObjectStreamClass.java:1104-1106`：`writeReplace`
- `ObjectStreamClass.java:1134-1136`：`readResolve`
- `ObjectStreamClass.java:1396-1403`：`getSerializableConstructor`
- `ObjectStreamClass.java:1447-1463`：`getPrivateMethod`
- `ObjectStreamClass.java:1631-1644`：`getDeclaredSUID`
- `ObjectStreamClass.java:1647`：`computeDefaultSUID`
- `ObjectStreamClass.java:1774-1782`：默认 UID 摘要收尾
- `ObjectStreamClass.java:2161-2200`：`matchFields`
- `ObjectOutputStream.java:430`：`defaultWriteObject`
- `ObjectOutputStream.java:1485-1489`：自定义 writeObject 调用时机
- `ObjectInputStream.java:615`：`defaultReadObject`
- `ObjectInputStream.java:549-552`：readResolve 说明
- `ObjectInputStream.java:2233-2251`：readResolve 生效时机
- `Externalizable.java:66/82/96`：接口与方法
- `ObjectOutputStream.java:1420-1421`：externalizable 写分支

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦兼容与自定义协议扩展，不展开反序列化 gadget 链和 ObjectInputFilter 安全机制，那些放下一篇。
- 不把默认 UID 算法展开成字节级实现教程，重点是它为何把结构变化和兼容性绑死。
- 不把 Externalizable 推荐成默认方案，重点是说明它的控制力与风险都更高。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“UID 为什么是第一道兼容闸门 → 默认 UID 为什么会被结构变化打爆 → 字段如何按名字兼容匹配 → writeObject/readObject 怎样改写默认字段协议 → writeReplace/readResolve 怎样改对象身份 → Externalizable 为什么是全权自定义协议”。
- 必须把 toMap 的冲突语义和这里的版本/字段兼容语义区分开，不把“冲突即异常”讲成同一类问题。
- 必须自然引到 `03-security-filter.md`。
