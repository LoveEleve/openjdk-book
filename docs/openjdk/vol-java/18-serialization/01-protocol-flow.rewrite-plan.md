# 18-serialization/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `ObjectOutputStream`、`ObjectInputStream`、`ObjectStreamConstants`、`ObjectStreamClass`。本文聚焦流头、TC_/SC_ 标记、`writeObject0/readObject0` 分派、HandleTable 引用跟踪，以及默认字段序列化边界；`serialVersionUID` 与自定义序列化、反序列化安全放到后续篇章。
> 目标：把“序列化协议与流程”改写成一篇围绕“为什么 `writeObject` 写出去的不是‘对象本身’，而是一套自描述、可保留共享引用与循环结构的对象图协议”的机制文章。

## 1. 读者困惑

- `ObjectOutputStream.writeObject(obj)` 到底把什么写进了字节流，为什么这套东西能在另一端恢复出对象？
- 为什么 Java 序列化流一开头要写 `STREAM_MAGIC` 和版本号？
- `TC_OBJECT`、`TC_CLASSDESC`、`TC_REFERENCE` 这些标记字节在解决什么问题？
- 写侧为什么按 Java 类型分派，读侧为什么按流里的 type code 分派？
- 循环引用和共享引用为什么不会让 `writeObject` 无限递归？
- 默认序列化为什么只写非 static、非 transient 字段？
- 反序列化到底会不会调用构造器，它是怎么把对象壳先造出来的？

## 2. 一句话顿悟

**Java 默认序列化写出去的不是“内存里的对象快照”，而是一套自描述的对象图协议：流头先声明‘我是 Java 序列化流’，后面每个条目都带 TC_ 类型标记和类描述；对象第一次出现时先登记句柄再写字段，后续再次遇到只写 `TC_REFERENCE`。这让它既能保存类型信息，也能保住共享引用与循环结构，而不是把对象简单展开成一串扁平字段。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 STREAM_MAGIC / STREAM_VERSION、TC_/SC_ 标记、`writeObject0/readObject0` 路由、HandleTable、`TC_REFERENCE`、默认字段规则和非序列化父类构造器边界。
- 已抓住“先登记句柄再写字段”这个循环引用关键点。
- 已把 `serialVersionUID`、自定义序列化、安全问题拆到后续篇章，边界合理。

### 必须重写

- 旧稿偏协议条目密集，需先立一个总问题：为什么写出去的必须是“对象图协议”，而不是简单字节转储。
- 流头与 TC_ 标记要服务“自描述协议”这条主线，而不是各自独立介绍。
- 读写分派要强调“写按运行时类型、读按协议码”这种镜像关系。
- 默认字段与构造器边界要放到“协议恢复对象壳体”主线里，而不是附录式补充。

## 4. 理解路径

### 第一节：从“为什么循环引用不会把 writeObject 写死”开场

用 A→B→A 的循环引用场景开场。先指出失败方案：如果见一个对象就把它完整递归展开，序列化根本走不出去。借此立住总问题：Java 序列化必须写的是“对象图协议”，不是树形递归快照。

### 第二节：流头为什么先写 magic + version ——协议身份必须先声明

证据：
- `ObjectOutputStream.java:634-637`：`writeStreamHeader`
- `ObjectStreamConstants.java:39`：`STREAM_MAGIC`
- `ObjectStreamConstants.java:44`：`STREAM_VERSION`
- `ObjectInputStream.java` 头校验锚点（若正文需要，可在现文已有信息基础上谨慎表述）

主线：
- 反序列化方第一步不是猜类型，而是先确认“这是 Java 序列化流、而且版本兼容”。
- 这和 class/jar/zip 等二进制协议的 magic/version 设计一脉相承。

### 第三节：TC_/SC_ 标记为什么让这条流成为“自描述协议”

证据：
- `ObjectStreamConstants.java:57-130`：TC_ 常量
- `ObjectStreamConstants.java:150-176`：SC_ 常量

主线：
- TC_ 告诉读侧接下来读到的是 null、引用、对象、数组、字符串还是类描述符。
- SC_ 告诉读侧一个类描述后面有哪些能力与附加块（Serializable / Externalizable / 自定义 writeObject 等）。
- 这让读侧不需要提前知道“下一个东西是什么”，而是顺着流边读边分派。

### 第四节：为什么写按 Java 类型分派，而读按协议码分派

证据：
- `ObjectOutputStream.java:1102-1116`：`writeObject0` 前半路由
- `ObjectOutputStream.java:1161-1177`：类型路由主体
- `ObjectOutputStream.java:1404-1430`：`writeOrdinaryObject`
- `ObjectInputStream.java:1646-1687`：`readObject0` 的 TC_ 分派
- `ObjectInputStream.java:2194`：`readOrdinaryObject`

主线：
- 写侧已经有运行时对象，所以按 `instanceof` / Java 类型决定写什么标记与数据体。
- 读侧先看到的是字节流，所以必须先看 TC_ 再决定接下来该如何解释字节。
- 这两套路由是镜像关系，靠 type code 对齐。

### 第五节：HandleTable 为什么让对象图能保住共享引用和环

证据：
- `ObjectOutputStream.java:176`：`handles`
- `ObjectOutputStream.java:2239-2296`：`HandleTable`
- `ObjectOutputStream.java:1414-1424`：普通对象写入顺序
- `ObjectOutputStream.java:1194-1197`：`writeHandle`
- `ObjectStreamConstants.java:140`：`baseWireHandle`
- `ObjectInputStream.java:1797`：`readHandle`
- `ObjectInputStream.java:2219`：读侧先登记句柄

主线：
- 写侧必须先给对象分配句柄，再写字段；否则循环引用会在第二次遇到时来不及短路。
- 再次遇到同一对象时写 `TC_REFERENCE + handle`，而不是再次展开对象内容。
- 这不仅避免死循环，也保住了共享引用同一性。

### 第六节：默认序列化为什么只写非 static、非 transient 字段

证据：
- `Serializable.java:91-92`：默认读写非 static 非 transient 字段
- `ObjectStreamClass.java:369`：序列化字段收集（现有旧稿已有定位）

主线：
- static 属于类级共享状态，不属于实例快照。
- transient 明示“不要把这部分持久化”——缓存、句柄、敏感信息等都应避开默认协议。
- 这要回到“协议到底要表达什么实例状态”上，而不是语法记忆题。

### 第七节：反序列化对象壳体为什么依赖第一个非序列化父类的无参构造器

证据：
- `ObjectStreamClass.java:890-891`：Javadoc 说明
- `ObjectStreamClass.java:1396-1403`：`getSerializableConstructor`

主线：
- 反序列化不会按普通 new 流程完整重走你的序列化类构造器链。
- 它要先造出一个可承载字段恢复的对象壳体，因此去找第一个非序列化父类的可访问无参构造器作为起点。
- 这帮助读者把“对象图恢复”与“业务构造逻辑”边界分开理解。

## 5. 失败方案清单

1. 把 Java 序列化理解成对象内存布局的直接字节拷贝。
2. 对循环引用或共享引用结构不做句柄登记，直接递归展开对象字段。
3. 以为读侧天生知道下一个条目的 Java 类型，而不需要协议标记。
4. 把 `createNewFile` 那类原子语义经验错误套到序列化，误以为“先看再写”也能保协议正确。
5. 以为 static / transient 字段也会自动进入默认序列化内容。
6. 误以为反序列化一定按普通构造器链重走业务初始化逻辑。

## 6. 误解清单

1. STREAM_MAGIC 只是老格式遗留，对正确性无关紧要。
2. TC_OBJECT 后面直接就是字段值，不需要类描述符。
3. `TC_REFERENCE` 只是压缩优化，不影响对象语义。
4. 循环引用之所以能工作，是 JVM 偷偷做了特殊递归检测，而不是显式句柄表。
5. 反序列化构造对象和普通 `new` 本质一样。
6. 默认序列化等于“对象里有什么就写什么”。

## 7. 证据清单

- `ObjectOutputStream.java:634-637`：流头写入
- `ObjectStreamConstants.java:39`：`STREAM_MAGIC`
- `ObjectStreamConstants.java:44`：`STREAM_VERSION`
- `ObjectStreamConstants.java:57-130`：TC_ 常量
- `ObjectStreamConstants.java:140`：`baseWireHandle`
- `ObjectStreamConstants.java:150-176`：SC_ 常量
- `ObjectOutputStream.java:176`：`handles`
- `ObjectOutputStream.java:1102-1116`：`writeObject0` 前半路由
- `ObjectOutputStream.java:1161-1177`：写侧类型路由
- `ObjectOutputStream.java:1194-1197`：`writeHandle`
- `ObjectOutputStream.java:1404-1430`：`writeOrdinaryObject`
- `ObjectOutputStream.java:2239-2296`：`HandleTable`
- `ObjectInputStream.java:1646-1687`：读侧 type code 分派
- `ObjectInputStream.java:1797`：`readHandle`
- `ObjectInputStream.java:2194`：`readOrdinaryObject`
- `ObjectInputStream.java:2219`：读侧先登记句柄
- `Serializable.java:91-92`：默认字段范围
- `ObjectStreamClass.java:369`：字段收集
- `ObjectStreamClass.java:890-891`：非序列化父类构造器说明
- `ObjectStreamClass.java:1396-1403`：`getSerializableConstructor`

## 8. 版本与边界

- 基于 JDK 11。
- 本篇聚焦协议与流程，不展开 `serialVersionUID` 冲突、自定义 `writeObject/readObject` 与过滤安全策略，这些放到后续篇章。
- 不把类加载与反序列化安全问题完全展开，只在需要时点到“读侧只有类名没有字节码”。
- 不把协议细节扩成完整字节布局手册，重点是建立对象图和句柄心智。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么 Java 默认序列化写的是对象图协议 → 为什么先有 magic/version 和 type code → 写按 Java 类型分派、读按协议码分派 → 先登记句柄后写字段如何解决循环引用并保住共享同一性 → 默认字段范围和对象壳体构造边界是什么”。
- 必须把 HandleTable 讲成本文主心骨之一。
- 必须把 `toMap` 风格的‘重复即错误’直觉和这里的‘重复对象用句柄复用’作明确区分。
- 必须自然引到 `02-serialversion-custom.md`。
