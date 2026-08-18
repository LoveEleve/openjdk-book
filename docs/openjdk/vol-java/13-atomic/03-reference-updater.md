# 03. 引用原子与 FieldUpdater — AtomicReference、ABA 解、内存优化

> **前置依赖**: [13-atomic/01 — AtomicInteger 与 CAS 封装](01-atomicinteger-cas.md)(CAS 循环、ABA 定义)、[13-atomic/02 — Striped64 与 LongAdder](02-striped64-longadder.md)(分片计数)、[04-reflection-annotation/02 — MethodAccessor](../04-reflection-annotation/02-methodaccessor.md)(Unsafe 字段偏移)
> → **后续**: 域 18 序列化(按写作顺序)
> 关联: 域 32 Unsafe(字段偏移与 CAS 原语);内部卷 05-cpu-primitives(原子指令)

## 数计数器会了,引用怎么办

前两篇把"数值"的原子操作讲透了——volatile + CAS 封装(AtomicInteger)、分片计数(LongAdder)。但并发场景里要原子更新的不只是数字: 配置对象、游标、链表头节点……**引用**怎么原子替换?ABA 问题怎么根治?还有——一个对象只有一两个字段要原子化,值得为它包一层 AtomicInteger 吗?这一篇把引用原子类、版本戳、FieldUpdater 一次讲完,最后给原子家族选型。

## 1. "AtomicReference 是什么？" — 引用 CAS

### 1.1 与 AtomicInteger 同构,值类型是引用

`AtomicReference`(`AtomicReference.java:51`)的骨架和 AtomicInteger 完全一样(`AtomicReference.java:53-63`):

```java
// AtomicReference.java:53-63(截取核心,逐字)
private static final VarHandle VALUE;
static {
    try {
        MethodHandles.Lookup l = MethodHandles.lookup();
        VALUE = l.findVarHandle(AtomicReference.class, "value", Object.class);
    } catch (ReflectiveOperationException e) {
        throw new ExceptionInInitializerError(e);
    }
}

private volatile V value;
```

- **`volatile V value`**(`AtomicReference.java:63`):唯一的实例字段——volatile 保证可见性
- **`VALUE` 是 VarHandle**(`AtomicReference.java:53-57`):注意这里**没有** AtomicInteger 那种 "cyclic startup dependencies" 注释——它在类初始化期安全地 `findVarHandle`,直接用 JDK9+ 的 VarHandle 门面

`get()`/`set()`(`AtomicReference.java:86`/`:96`)就是裸 volatile 读写,`compareAndSet`(`AtomicReference.java:121-123`)委托 VarHandle 的 CAS:

```java
// AtomicReference.java:121-123(截取核心,逐字)
public final boolean compareAndSet(V expectedValue, V newValue) {
    return VALUE.compareAndSet(this, expectedValue, newValue);
}
```

### 1.2 引用 CAS 的三个典型应用

| 场景 | 做法 | 为什么行 |
|------|------|---------|
| 配置热更新 | 配置打包成不可变对象,`compareAndSet` 整体替换 | 读方永远拿到完整旧/新配置,不会读到半新半旧 |
| 游标/指针 | 批量任务游标、日志偏移量,`getAndSet` 取旧置新 | 一个线程"拿走"游标,其他线程不会重复处理 |
| 单例初始化 | `get()` 为 null 时 CAS 放入实例 | 并发下只有一个线程能放入成功 |

`getAndSet`(`AtomicReference.java:168-170`)与 `getAndUpdate`(`AtomicReference.java:183-194`,函数式 CAS 循环,和 AtomicInteger 的 haveNext 优化一模一样)都是同款模板。

关键设计(斜体):*"原子替换引用" = 不可变对象 + 引用 CAS——读方 get() 拿到的是完整对象引用,永不撕裂;写方整体替换。这是"无锁读替换"的标准形态: 读无锁、写用 CAS,生产配置热更新就是这么做的。面试"AtomicReference vs volatile 引用": volatile 只保证可见性(读到的总是最新),AtomicReference 多了"替换"的原子比较——compareAndSet 是"条件替换",volatile 赋值是"无条件写"。*

跨层标注: [内部卷: 05-cpu-primitives 01——引用 CAS 底层同样是 `lock cmpxchg`;压缩指针(UseCompressedOops)打开时比较交换的是 4 字节引用,关闭时为 8 字节(内部卷 06-oops 01)]

## 2. "ABA 怎么解？" — AtomicStampedReference 的版本戳

### 2.1 回顾:ABA 是什么

第 1 篇讲过: 线程 A 读引用到 A,准备 CAS;期间 B 把它换成 B 又换回 A;A 的 CAS 用期望值 A 去比——命中,成功。**值确实等于 A,但中间发生过一次完整的替换循环**。计数器无碍(值相同=结果相同),但引用场景致命: 无锁链表里,旧节点可能已被复用。

### 2.2 Pair:引用 + 戳,打包成不可变对

`AtomicStampedReference`(`AtomicStampedReference.java:53`)的解法是把"引用"和"版本戳"打包(`AtomicStampedReference.java:55-67`):

```java
// AtomicStampedReference.java:55-67(截取核心,逐字)
private static class Pair<T> {
    final T reference;
    final int stamp;
    private Pair(T reference, int stamp) {
        this.reference = reference;
        this.stamp = stamp;
    }
    static <T> Pair<T> of(T reference, int stamp) {
        return new Pair<T>(reference, stamp);
    }
}

private volatile Pair<V> pair;
```

**`Pair` 是不可变对**(两个 final 字段),整个状态就是 `volatile Pair<V> pair`(`AtomicStampedReference.java:67`)——**引用和戳永远一起变,不会出现"引用是新、戳是旧"的中间态**。这比"两个独立 volatile 字段"强: 独立字段时,一个线程改了引用还没来得及改戳,另一个线程就看到了错配状态。

### 2.3 compareAndSet:引用和戳同时比

```java
// AtomicStampedReference.java:148-159(截取核心,逐字)
public boolean compareAndSet(V   expectedReference,
                             V   newReference,
                             int expectedStamp,
                             int newStamp) {
    Pair<V> current = pair;
    return
        expectedReference == current.reference &&
        expectedStamp == current.stamp &&
        ((newReference == current.reference &&
          newStamp == current.stamp) ||
         casPair(current, Pair.of(newReference, newStamp)));
}
```

四参数 CAS: **期望引用和期望戳都匹配才更新**。注意两个细节:

1. **短路优化**: 新引用和新戳与当前完全相同时(`newReference == current.reference && newStamp == current.stamp`),直接返回 true,连 CAS 都不做——"要设置的值本来就是当前值"就没必要写
2. **原子边界**: 前两段 `expectedReference == ...` 只是预检查;真正把"引用+戳"一起原子换掉的是最后的 `casPair`(`AtomicStampedReference.java:206-208`)——一次 `PAIR.compareAndSet` 替换整个 Pair 对象

所谓"stamp"就是操作计数: 每次修改戳 +1,ABA 变成 A-1 → B-2 → A-3,**期望的 A-1 对不上 A-3,拒绝**。

`set`(`AtomicStampedReference.java:167-171`)有条件地换——**引用和戳都没变就不写**(避免无谓的 volatile 写):

```java
// AtomicStampedReference.java:167-171(截取核心,逐字)
public void set(V newReference, int newStamp) {
    Pair<V> current = pair;
    if (newReference != current.reference || newStamp != current.stamp)
        this.pair = Pair.of(newReference, newStamp);
}
```

`attemptStamp`(`AtomicStampedReference.java:186-192`)只改戳不改引用——"这引用我要标记一下"。

### 2.4 Markable:只要布尔标记

`AtomicMarkableReference`(`AtomicMarkableReference.java:53`)同构,只是戳换成了布尔 `mark`(`AtomicMarkableReference.java:55-67`)——不关心"被改了几次",只关心"是否被标记过"(比如无锁链表的逻辑删除标记)。典型用法是 `boolean[] holder` 数组一次取回引用+标记(`AtomicMarkableReference.java:106-110`)。

关键设计(斜体):*"戳"是操作计数——把"值相同"升级为"版本相同"。面试答 ABA 解决: "给引用加版本戳,每次修改戳 +1,CAS 时引用和戳一起比,ABA 变成 A-1→B-2→A-3,期望的 A-1 对不上就拒绝"就抓住了;再补一句"Markable 只关心是否被标记过,适合逻辑删除"就是完整答案。无锁栈/队列的 CAS 头部指针正是 Stamped 的典型战场。*

## 3. "FieldUpdater 省什么内存？" — 免包装的字段原子化

### 3.1 问题:一个字段,值得包一层 AtomicInteger 吗

假设有 100 万条订单记录,每条有个 `count` 要并发累加。方案一: 每条记录里放一个 `AtomicInteger count`——**每个对象多出对象头 + 包装对象的开销**;方案二: 字段还是普通 `volatile int count`,用一个静态的 updater 去原子操作它:

```java
// 用法示意(API 形式,非源码片段)
private static final AtomicIntegerFieldUpdater<Order> COUNTER =
    AtomicIntegerFieldUpdater.newUpdater(Order.class, "count");
```

**所有对象共享这一个 updater**,对象本身零额外内存。这是 FieldUpdater 的价值(`AtomicIntegerFieldUpdater.java:51-56` 的类注释): 原子数据结构里**同一节点的多个字段各自独立做原子更新**——节点对象的每个字段都不需要包装对象。

### 3.2 newUpdater:反射校验 + 字段偏移

`newUpdater`(`AtomicIntegerFieldUpdater.java:91-95`)构造 `AtomicIntegerFieldUpdaterImpl`(`AtomicIntegerFieldUpdater.java:377`)。内部实现(`AtomicIntegerFieldUpdater.java:416-434`):

```java
// AtomicIntegerFieldUpdater.java:416-434(截取核心,逐字)
if (field.getType() != int.class)
    throw new IllegalArgumentException("Must be integer type");

if (!Modifier.isVolatile(modifiers))
    throw new IllegalArgumentException("Must be volatile type");

// Access to protected field members is restricted to receivers only
// of the accessing class, or one of its subclasses, and the
// accessing class must in turn be a subclass (or package sibling)
// of the protected member's defining class.
// If the updater refers to a protected field of a declaring class
// outside the current package, the receiver argument will be
// narrowed to the type of the accessing class.
this.cclass = (Modifier.isProtected(modifiers) &&
               tclass.isAssignableFrom(caller) &&
               !isSamePackage(tclass, caller))
              ? caller : tclass;
this.tclass = tclass;
this.offset = U.objectFieldOffset(field);
```

三道检查 + 一个偏移:

1. **类型必须是 int**(`AtomicIntegerFieldUpdater.java:416-417`):不是 int 抛 `IllegalArgumentException("Must be integer type")`
2. **字段必须 volatile**(`AtomicIntegerFieldUpdater.java:419-420`):这是硬前提——Updater 的 CAS 靠 volatile 语义做可见性,字段不是 volatile 直接拒绝("Must be volatile type")
3. **访问控制**(`AtomicIntegerFieldUpdater.java:402-409`):`ReflectUtil.ensureMemberAccess` + 包访问检查,反射权限不足抛 RuntimeException
4. **`U.objectFieldOffset(field)`**(`AtomicIntegerFieldUpdater.java:434`):拿到字段偏移,之后所有操作都是 Unsafe 按偏移直写——与 AtomicInteger 内部同一套机制

### 3.3 操作:同偏移 CAS,弱于 AtomicInteger 的保证

实现方法(`AtomicIntegerFieldUpdater.java:489-492`)与 AtomicInteger 如出一辙:

```java
// AtomicIntegerFieldUpdater.java:489-492(截取核心,逐字)
public final boolean compareAndSet(T obj, int expect, int update) {
    accessCheck(obj);
    return U.compareAndSetInt(obj, offset, expect, update);
}
```

注意两点:

- **每次调用都有 `accessCheck`**(`AtomicIntegerFieldUpdater.java:466-469`):`cclass.isInstance(obj)` 校验传入对象类型——比 AtomicInteger 多一层运行时检查
- **保证更弱**(类注释原话,`AtomicIntegerFieldUpdater.java:58-63`): "cannot ensure that all uses of the field are appropriate for purposes of atomic access, it can guarantee atomicity only with respect to other invocations of compareAndSet and set on the same updater"——**Updater 只能保证"走这个 Updater 的操作"之间原子;代码里直接 `obj.count++` 的普通写不保证**。字段虽然是 volatile,volatile 只保证可见性,不保证"读-改-写"原子性——绕过 Updater 的普通自增照样丢更新

### 3.4 JDK 自己的生产用法

FieldUpdater 不是玩具——JDK 内部就在用。`SelectionKey` 的 attachment 字段(`SelectionKey.java:431-436`):

```java
// SelectionKey.java:431-436(截取核心,逐字)
private volatile Object attachment;

private static final AtomicReferenceFieldUpdater<SelectionKey,Object>
    attachmentUpdater = AtomicReferenceFieldUpdater.newUpdater(
        SelectionKey.class, Object.class, "attachment"
    );
```

也有反例: `ClassLoader` 的 `trySetObjectField` 注释明说 "Avoids the use of AtomicReferenceFieldUpdater in this class"(`ClassLoader.java:3019`);`BufferedInputStream` 的注释(`BufferedInputStream.java:64-68`)解释了原因——它是启动早期类,要"reduce dependencies and improve startup time"。这和第 1 篇 AtomicInteger 的循环依赖注释是同一主题: **越核心的类越要少依赖**,Updater 也背着反射和 VarHandle 的初始化成本。

关键设计(斜体):*FieldUpdater 三价值: ① 省内存——百万对象不必各带一个 AtomicInteger 包装对象;② 复用——静态单例,所有对象共享;③ 约束——字段必须 volatile,否则 Updater 的 CAS 没有可见性根基。代价: 每次调用多一次 accessCheck、保证范围只限"走 Updater 的操作"。面试"FieldUpdater vs AtomicInteger 字段": 大对象数组/批量实体(如千万级订单)用 FieldUpdater 省内存;API 简单、数量少的场景直接 AtomicInteger 更清晰。*

跨层标注: [域 04: 02-methodaccessor——`UnsafeFieldAccessorImpl` 的 `fieldOffset = unsafe.objectFieldOffset(field)` 与 Updater 是同一偏移机制;域 32 Unsafe——objectFieldOffset 与 CAS 原语]

## 4. 选型:原子家族决策

面试最后一道: "让你设计一个并发计数器/状态/引用,选什么?"按三问走(`java/util/concurrent/atomic/package-info.java:87-89` 的官方分类,数组/字段/值/分片):

| 需求 | 选择 | 依据 |
|------|------|------|
| 单值计数,竞争低 | `AtomicLong` / `AtomicInteger` | volatile + CAS 循环,最简单 |
| 单值计数,竞争高 | `LongAdder` | 分片计数,吞吐显著更高(域 13 第 2 篇) |
| 原子替换引用 | `AtomicReference` | 不可变对象 + 引用 CAS |
| 引用 + 版本戳(ABA 敏感) | `AtomicStampedReference` | 戳同时 CAS,拒绝 A-1 对 A-3 |
| 只标记不改计数 | `AtomicMarkableReference` | 布尔 mark,逻辑删除 |
| 数组元素级原子 | `Atomic*Array` | JDK9+ VarHandle 的 `arrayElementVarHandle`(域 13 第 1 篇 §5.3) |
| 已有对象字段原子化 | `Atomic*FieldUpdater` | 免包装、省内存、静态单例 |
| 自定义聚合(求和/最大) | `LongAccumulator` / `DoubleAccumulator` | 可结合且可交换的运算(域 13 第 2 篇) |

关键设计(斜体):*选型三问: ① 竞争高不高——决定 Atomic vs Adder(高竞争用分片);② 值还是引用——决定类型族(数值/引用/数组);③ 能不能接受包装对象——决定要不要 FieldUpdater。面试选型题按这三问答,再加一句"ABA 敏感用 StampedReference",全家族就覆盖了。*

## 核心悬念

原子类收官——单点无锁(AtomicInteger)、分片计数(LongAdder)、引用替换(AtomicReference)、字段原子化(FieldUpdater),都是"单变量的无锁"。但并发的另一半是**协调**: 公平锁怎么排队?读写锁怎么区分读者写者?AQS 用一个 state + 等待队列实现了所有同步器——那是面试必考大魔王(域 12 锁与同步器)。按写作顺序,下一站先到域 18 序列化: 对象怎么变成字节流、`serialVersionUID` 为什么不能乱改。

> → 域 18 序列化(18-serialization 系列)| 关联: 域 12 锁与同步器(AQS)、域 14 线程池
