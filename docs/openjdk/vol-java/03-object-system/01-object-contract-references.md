# 01. Object 的方法契约与对象生命周期 — 六方法 + 四种引用

> **前置依赖**: [02-number-math/01 — 包装类、缓存与装箱](../02-number-math/01-wrapper-cache-boxing.md)(包装类 hashCode 已见)、[01-string/01 — String 的不可变](../01-string/01-storage-immutable.md)(equals/hashCode 覆写实例)
> → **后续**:[03-object-system/02 — System 与 Runtime](02-system-runtime.md)
> 关联: 内部卷 06-oops(对象头 markOop/Klass)、25-gc-framework 03-reference-processing(引用处理与 pending 链);[JVM Spec: §2.2.1 对象引用]

## 六个方法,三个 native,一道弃用史

"Object 有哪些方法"是 Java 面试的开场题——大多数人的答案是背出来的: getClass、hashCode、equals、clone、toString、finalize。但追问三个细节就露馅: 为什么其中三个是 native?为什么重写 equals 必须重写 hashCode?finalize 为什么从 JDK9 开始被弃用,替代方案 Cleaner 又是怎么工作的?

这篇把六个方法逐个过一遍,然后讲透三件事: 方法背后的 JVM 契约、hashCode-equals 的一致性规则、以及从 Finalizer 到 Cleaner 的对象清理机制——最后落到四种引用和它们的状态机。

## 1. "Object 的六个方法为什么大多是 native" — JVM 契约

### 1.1 六方法总览

`Object.java`(共 559 行)的全部公开方法:

| 方法 | 行号 | 性质 | 为什么 |
|------|:--:|------|--------|
| `getClass()` | 72 | native | 需要对象头里的 Klass 指针——语言层面拿不到 |
| `hashCode()` | 109 | native | 需要对象头的 hash 位(或 JVM 生成策略) |
| `equals(Object)` | 157 | Java | 默认引用比较,留给子类覆写 |
| `clone()` | 222 | native | 需要位级复制对象字段 |
| `toString()` | 245 | Java | 拼字符串,子类覆写的主场 |
| `finalize()` | 558 | Java | 空实现 + `@Deprecated(since="9")` |

### 1.2 native 的三个:语言表达不了的事

三个 native 方法的共同点:**它们需要的状态或操作在 Java 语言层面不存在**:

- `getClass()`:对象在 JVM 里的类型信息(`Klass` 指针)存在对象头里,Java 字段表里没有——只有 JVM 能读
- `hashCode()`:默认实现需要对象头的 hash 位(或懒生成的随机数),与 Java 代码无关
- `clone()`:浅拷贝是"按位复制所有字段",Java 写不出来(没有反射到任意字段并整体复制的语言操作)

跨层标注: [内部卷: 06-oops 01-markoop-oopdesc——对象头的 hash 位与 Klass 指针布局;06-oops 02-klass-hierarchy——getClass 返回的 Class 对象的来源]

### 1.3 Java 侧的两个:契约留给子类

`equals`(`Object.java:157-159`)与 `toString`(`Object.java:245-248`)是纯 Java:

```java
// Object.java:157-159 + 245-248(截取核心,逐字)
public boolean equals(Object obj) {
    return (this == obj);
}

public String toString() {
    return getClass().getName() + "@" + Integer.toHexString(hashCode());
}
```

`equals` 默认就是引用比较——语义是"同一性";`toString` 输出 `类名@十六进制hash`——它调用了 `getClass()` 和 `hashCode()`,所以子类重写 toString 时通常也要重写这两个。把这两个方法留在 Java 侧的意义: **契约由 Java 层维护**——JVM 不关心你的 equals 是什么语义,Java 层用 javadoc 契约(第 2 节)约束子类。

关键设计(斜体):*native 与 Java 的分界线画在"语言能否表达"上: 对象头信息、位级操作、内部状态必须进 native;而 equals/hashCode/toString 是"语义"不是"机制",留 Java 侧让每个子类按业务定义。面试能说出"native 是因为语言表达不了,不是 JVM 偷懒",就比背方法列表高一档。*

## 2. "hashCode-equals 契约是什么" — 一致性三规则

### 2.1 契约的原文

`Object` 的 javadoc(`Object.java:87` 附近)用规范语言写死了契约——核心一条:

- **equals 相等 ⇒ hashCode 必相等**:*"If two objects are equal according to the equals(Object) method, then calling the hashCode method on each of the two objects must produce the same integer result"*(`Object.java:87-88` 区域)
- 反过来不成立:hashCode 相等不代表 equals 相等(哈希碰撞)
- 生命周期稳定:hashCode 在对象存活期间不得变化(除非 equals 语义变)

### 2.2 违反的后果:集合类失效

生产 bug 的标准剧本: 对象放进 HashSet 后改了某个参与 equals 的字段——它的 hashCode 变了,但它在哈希表里还挂在**旧的桶**上。`contains` 按新 hash 定位到新桶,找不到;旧桶里的它永远等不到被访问。**对象既删不掉也查不到**。

机制在 HashMap:`put`/`get` 都先 `hash(key)` 定位桶,再在桶内用 equals 确认(`HashSet` 底层就是 HashMap)。hash 定位错了桶,equals 再好也白搭。

### 2.3 默认 hashCode 与地址无关

顺带澄清一个流传很广的误解: 很多人说"默认 hashCode 是内存地址"。`Object` 的 javadoc(`Object.java:97-102`)明确否认:*"The hashCode may or may not be implemented as some function of an object's memory address at some point in time"*——**"可能或不可能"**,不是"就是"。真实原因: JVM 的默认实现通常基于对象头里保存的 hash 值(首次调用时生成),**与地址解耦**——因为 GC 会移动对象(复制/压缩),如果 hash 依赖地址,对象搬家后 hash 就变了,哈希表直接失效。

关键设计(斜体):*契约的本质是"哈希表正确性的前置条件"——HashMap/HashSet 的正确性建立在"hash 定位、equals 确认"两段式上,任何一环被违反就静默失效(不报错、不抛异常,只是找不到)。Java 用 javadoc 强制(编译器不检查),C++ 的 unordered_map 靠用户自觉——面试答"违反契约会让集合类静默失效"比背三条规则有区分度。*

## 3. "finalize 为什么被弃用" — Finalizer 与 Cleaner

### 3.1 现状:空实现 + 弃用标记

`Object.finalize`(`Object.java:553-558`)的完整内容:

```java
// Object.java:557-558(截取核心,逐字,省略 javadoc)
    @Deprecated(since="9")
    protected void finalize() throws Throwable { }
```

空实现,JDK9 起标注弃用。弃用的理由在 JEP 表面之下,是四个实打实的机制问题:

1. **时机不确定**:finalize 依赖 GC 触发——对象什么时候被回收、Finalizer 线程什么时候跑,都不保证,甚至可能永远不跑(对象一直可达)
2. **延迟回收**:对象进 Finalizer 队列后,还要等 Finalizer 线程逐个执行——清理慢的 finalize 会拖垮整条队列,堆积的对象延迟释放
3. **异常被吞**:finalize 里抛的异常被 Finalizer 线程静默忽略(线程 run 循环捕获后继续),错误无声无息
4. **可复活**:finalize 里把 `this` 重新赋给外部引用,对象"复活"——但复活对象再次变不可达时,finalize 不会再执行第二次(协议规定),清理逻辑可能执行一半

实现侧(`Finalizer.java:34` 的 `final class Finalizer extends FinalReference<Object>`)由专门的 `FinalizerThread`(`Finalizer.java:146`)消费队列——一个守护线程扛着所有对象的清理,一旦某个 finalize 卡住,全局陪葬。

### 3.2 替代:Cleaner

JDK9 引入 `Cleaner`(`java/lang/ref/Cleaner.java:131`)。工厂方法(`Cleaner.java:173-177`):

```java
// Cleaner.java:173-177(截取核心,逐字)
public static Cleaner create() {
    Cleaner cleaner = new Cleaner();
    cleaner.impl.start(cleaner, null);
    return cleaner;
}
```

机制与 finalize 的差别(`Cleaner.java:157-158` 的 javadoc 说得很清楚): **"The cleaner creates a daemon thread to process the phantom reachable objects and to invoke cleaning actions"**——基于**虚引用**(PhantomReference)跟踪对象死亡,清理动作在自己的守护线程里执行:

- **动作隔离**:清理动作抛异常会被捕获忽略(`jdk/internal/ref/CleanerImpl.java:152-153` 注释原文 "ignore exceptions from the cleanup action"),但队列中后续动作继续执行——finalize 的异常同样被吞(`Finalizer.java:93` 的 `catch (Throwable x) { }` 空捕获),两者真正的区别在: Cleaner 的动作是**用户显式注册的代码**,可以在动作内部自行 try-catch 处理错误,而不像 finalize 那样把整个清理责任交给框架
- **不复活**:PhantomReference 的 get() 恒返回 null,无法通过引用拿到对象并复活它——finalize 的"复活"问题在 Cleaner 里物理上不可能

典型应用是 DirectByteBuffer 的堆外内存释放(域 19/32 展开)——堆外内存不归 GC 管,必须靠引用机制在缓冲区对象死亡时释放 native 内存。

关键设计(斜体):*Cleaner 的哲学是"把清理从 GC 语义里拿出来,变成引用机制的副产品"——虚引用只负责通知"对象死了",清理动作由用户代码显式注册、独立执行。面试点: "JDK9 后不要用 finalize;资源清理用 try-with-resources(确定性)或 Cleaner(兜底性)"——try-with-resources 是主动管理,Cleaner 是防泄漏的最后防线,两者不是替代关系是互补关系。*

## 4. "四种引用是怎么工作的" — 引用强度状态机

### 4.1 强度梯度

四种引用按强度排列:

```
强引用 > 软引用(SoftReference) > 弱引用(WeakReference) > 虚引用(PhantomReference)
```

- **强引用**:普通赋值,GC 永不回收
- **软引用**:内存不足才回收(GC 的最后手段)——适合内存敏感缓存
- **弱引用**:GC 一轮即回收——WeakHashMap 的 key
- **虚引用**:get() 恒 null,只用于"对象死亡通知"——Cleaner 的机制

差异只在 **GC 触发的时机与存活策略**,Java 侧的处理路径完全一样(第 4.3 节)。

### 4.2 Reference 的字段布局

所有引用都继承 `Reference`(`java/lang/ref/Reference.java`),核心字段:

```java
// Reference.java:151 + 161 + 171 + 185(截取核心,逐字)
private T referent;         /* Treated specially by GC */

volatile ReferenceQueue<? super T> queue;

volatile Reference next;

private transient Reference<T> discovered;
```

- **referent**(`Reference.java:151`):被引用对象——注释 "Treated specially by GC" 是关键: 普通字段 GC 不管,这里 GC 在做可达性分析时**按引用类型分派**处理(强/软/弱/虚走不同的存活策略)
- **queue**(`Reference.java:161`):关联的引用队列,volatile——入队状态可见性
- **next**(`Reference.java:171`):入队链表的下一个——queue 里的链表结构
- **discovered**(`Reference.java:185`):**pending 链表的链接**——GC 把要通知的引用串成 pending 链表,discovered 就是这个链表的 next 指针(注释 173-184: 与 next 分离是为了 enqueue 可以在 pending 状态下并发操作)

### 4.3 状态机:active → pending → inactive

`Reference.java:47-149` 有一大段状态机注释,核心是三个阶段:

```
active  →  (GC 检测到可达性变化)  →  pending  →  (ReferenceHandler 处理)  →  inactive
```

- **active**:可达,referent 有效,由 GC 特殊对待
- **pending**:被 GC 挂上 pending 链表,等 ReferenceHandler 处理;referent 已被清除(注释 61 行:"referent = null")
- **inactive**:处理完(入队或清除),终态

消费 pending 链表的是 `ReferenceHandler` 线程(`Reference.java:190-216`)——注释自称 "High-priority thread to enqueue pending References"(`Reference.java:188`):

```java
// Reference.java:188 + 190 + 211-215(截取核心,逐字)
/* High-priority thread to enqueue pending References */
private static class ReferenceHandler extends Thread {
    ...
    public void run() {
        while (true) {
            processPendingReferences();
        }
    }
}
```

守护线程,`while (true)` 死循环——`waitForReferencePendingList()`(`Reference.java:231`)阻塞等待,`getAndClearReferencePendingList()`(`Reference.java:221`,native)取走整条链表,逐个 `discovered` 字段遍历处理(`Reference.java:247-250`)。处理时按引用类型分派(`Reference.java:252-253`): **识别为 `jdk.internal.ref.Cleaner` 类型的引用直接调用其 `clean()`**(公开的 `java.lang.ref.Cleaner` 内部委托这套 jdk.internal.ref 实现),其余引用入队(`ReferenceQueue`)。这个线程是四种引用机制的统一出口: 软/弱/虚引用在这里入队,Cleaner 的清理动作在这里被触发。

关键设计(斜体):*四种引用 = 可达性分析的四个等级(JVM Spec §2.2.1 定义对象引用的可达性等级),Java 侧只负责"入队与回调",判定逻辑全在 GC。生产上最经典的考点是 ThreadLocal 泄漏(域 11 展开): 弱引用 key + 强引用 value——key 被回收后 value 还挂在 Thread 上,键没了值还在,就是引用强度不对等的产物。*

跨层标注: [内部卷: 25-gc-framework 03-reference-processing——GC 侧 pending 链的构建与 ReferenceHandler 的 VM 支撑];[JVM Spec: §2.2.1 对象引用(强/软/弱/虚可达性定义)]

## 核心悬念

对象是"值 + 方法",但**进程级的全局状态**——时间、系统属性、GC 控制、关闭钩子、标准输入输出——都藏在 `System` 和 `Runtime` 两个门面类里。面试连招的下一问是: `System.currentTimeMillis()` 和 `System.nanoTime()` 都是 native,有什么区别?`System.gc()` 真的会立刻 GC 吗?`Runtime.addShutdownHook` 的钩子什么时候跑?下一篇把这两个门面类拆开。

> → [03-object-system/02 — System 与 Runtime](02-system-runtime.md)
