# 引用原子与 FieldUpdater：CAS 不只会改数字，还会改引用和已有字段

> 本文基于 JDK 11 `AtomicReference`、`AtomicStampedReference`、`AtomicMarkableReference`、`AtomicIntegerFieldUpdater` 源码。重点讨论引用 CAS、ABA、版本化/标记化以及字段原子更新的内存节约与约束；不展开无锁链表完整实现和并发框架完整应用。
> **前置依赖**：[AtomicInteger 与 CAS](01-atomicinteger-cas.md)、[Striped64 与 LongAdder](02-striped64-longadder.md)
> **后续**：域 18 序列化，关联域 12 锁与同步器

## 上两篇解决了“数字怎么原子改”，这一篇解决“对象和字段怎么原子改”

前两章讲的原子类，核心都是围绕一个数值做 CAS：

- `AtomicInteger` 把一个共享 int 封成“volatile 值 + CAS”；
- `LongAdder` 则进一步把热点数值拆成多个槽位。

但并发程序真正会原子替换的，远不止数字。常见场景里，更重要的往往是：

- 整体替换一个配置对象；
- 抢占一个链表头指针；
- 给已有对象里的某个字段做原子更新，而不想每个对象再额外包一层 Atomic 包装对象。

这时 CAS 仍然能派上用场，只是问题也跟着升级了：

```text
数值 CAS
   → 主要矛盾是丢失更新与竞争重试

引用 CAS
   → 还会遇到 ABA：值看起来回到了原样，但历史其实已经变了

字段 updater
   → 还要额外处理反射访问、字段偏移、volatile 约束
```

所以这一篇的主线可以先压成一句话：**CAS 从数字扩展到引用与字段时，能力更强了，但代价是你必须显式面对引用语义、ABA 和封装边界。**

## 一、AtomicReference：把 CAS 从“数值更新”扩展成“整体引用替换”

### 它和 AtomicInteger 同构，只是值类型从 int 换成了对象引用

JDK 11 的 `AtomicReference` 结构非常直白：

```java
// AtomicReference.java:43-63
/**
 * An object reference that may be updated atomically.
 */
public class AtomicReference<V> implements java.io.Serializable {
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

把它和上一章的 `AtomicInteger` 对照，你会发现骨架是同一套：

- 一个 `volatile` 字段承载当前状态；
- 一个底层原子访问门面（这里是 VarHandle，不再是 Unsafe 偏移）；
- 后续所有 `get/set/CAS` 都围绕这个单字段展开。

所以从实现层面讲，`AtomicReference` 并不神秘。它不是“专门给对象发明的新同步方式”，而是**把数值 CAS 的那条路直接推广到了引用值上。**

### 读写仍然只是 volatile 语义，真正的关键是 compareAndSet

```java
// AtomicReference.java:80-98
/**
 * Returns the current value,
 * with memory effects as specified by {@link VarHandle#getVolatile}.
 */
public final V get() {
    return value;
}

/**
 * Sets the value to {@code newValue},
 * with memory effects as specified by {@link VarHandle#setVolatile}.
 */
public final void set(V newValue) {
    value = newValue;
}
```

```java
// AtomicReference.java:111-123
/**
 * Atomically sets the value to {@code newValue}
 * if the current value {@code == expectedValue},
 * with memory effects as specified by {@link VarHandle#compareAndSet}.
 */
public final boolean compareAndSet(V expectedValue, V newValue) {
    return VALUE.compareAndSet(this, expectedValue, newValue);
}
```

这里必须抓住一个最容易被忽略的区别：

- `volatile` 引用只能保证“你读到的是某个线程已经写进去的完整引用值”；
- `AtomicReference.compareAndSet` 才能保证“只有当前引用仍是我预期的那个对象时，我才整体替换它”。

也就是说，普通 `volatile` 引用适合无条件发布；`AtomicReference` 适合**有条件地抢占或替换**。

### 它最自然的应用，是“不可变对象整体替换”

`AtomicReference` 最值得记住的，不是 API 名字，而是它特别适合的设计模式：

```text
把配置/状态打包成一个不可变对象
   → 读线程只 get() 这个引用
   → 写线程准备好完整新对象后，用 CAS 或 getAndSet 整体切换
```

这样做的好处非常直接：读线程永远只会看到完整旧对象或完整新对象，不会读到“对象一半字段是新值、一半字段还是旧值”的撕裂状态。

所以原子引用的关键词不是“对象也能 CAS”这么抽象，而是：**把并发写入收缩成对一个不可变引用的整体切换。**

### `getAndSet` 和函数式更新，其实还是同一套 CAS 心智

```java
// AtomicReference.java:160-170
/**
 * Atomically sets the value to {@code newValue} and returns the old value,
 * with memory effects as specified by {@link VarHandle#getAndSet}.
 *
 * @param newValue the new value
 * @return the previous value
 */
@SuppressWarnings("unchecked")
public final V getAndSet(V newValue) {
    return (V)VALUE.getAndSet(this, newValue);
}
```

```java
// AtomicReference.java:172-192
/**
 * Atomically updates (with memory effects as specified by {@link
 * VarHandle#compareAndSet}) the current value with the results of
 * applying the given function, returning the previous value. The
 * function should be side-effect-free, since it may be re-applied
 * when attempted updates fail due to contention among threads.
 *
 * @param updateFunction a side-effect-free function
 * @return the previous value
 * @since 1.8
 */
public final V getAndUpdate(UnaryOperator<V> updateFunction) {
    V prev = get(), next = null;
    for (boolean haveNext = false;;) {
        if (!haveNext)
            next = updateFunction.apply(prev);
        if (weakCompareAndSetVolatile(prev, next))
            return prev;
        haveNext = (prev == (prev = get()));
    }
}
```

这和 `AtomicInteger` 的函数式更新心智完全一致：失败就重试，函数可能重跑，所以必须无副作用。

## 二、为什么 ABA 在引用场景里才真正危险

### 对数值来说，“又变回原值”常常不影响最终语义

如果你只是做计数，A→B→A 这类变化通常不代表灾难。因为对纯数值而言，最后观察到 A，很多时候就等价于“当前状态就是 A”。

但对引用来说，情况完全不同。

### 对引用结构来说，“值看起来没变”不代表“历史没发生过事”

想象一个无锁链表头指针：

1. 线程 A 读到头指针指向节点 `N`；
2. 线程 B 把 `N` 弹出，又可能经过别的操作把 `N` 放回；
3. 线程 A 再用“期望还是 `N`”去做 CAS，表面上竟然还成功。

这时问题不是“当前引用不是 N”，而是：**线程 A 以为自己面对的是当初看到的那个结构状态，但实际上中间已经发生过一次完整的摘下、处理、再放回。**

所以 ABA 的危险不在“最终值变回来了”，而在“CAS 只看当前值是否相等，看不到中间历史”。

## 三、AtomicStampedReference：把“引用 + 版本戳”绑成一个原子单元

### 它不是给引用加一个额外字段，而是把两者一起打包成 Pair

JDK 11 的 `AtomicStampedReference` 一上来就把实现思路说得很清楚：内部维护的是一个 boxed `[reference, stamp]` 对。

```java
// AtomicStampedReference.java:41-67
/**
 * An {@code AtomicStampedReference} maintains an object reference
 * along with an integer "stamp", that can be updated atomically.
 *
 * <p>Implementation note: This implementation maintains stamped
 * references by creating internal objects representing "boxed"
 * [reference, integer] pairs.
 */
public class AtomicStampedReference<V> {

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

这点非常重要。它没有把 reference 和 stamp 分成两个彼此独立的 volatile 字段，而是把它们封成一个不可变 Pair，再对整个 Pair 做 CAS。

这样做的意义是：**不会出现“引用已经是新的，但 stamp 还是旧的”这种错配中间态。**

### 读取时也天然是一并拿到当前引用和当前戳

```java
// AtomicStampedReference.java:98-109
/**
 * Returns the current values of both the reference and the stamp.
 * Typical usage is {@code int[1] holder; ref = v.get(holder); }.
 */
public V get(int[] stampHolder) {
    Pair<V> pair = this.pair;
    stampHolder[0] = pair.stamp;
    return pair.reference;
}
```

这就是为什么 API 要让你传一个 `int[] holder` 进来：不是写法怪，而是因为它本来就把“当前引用 + 当前 stamp”看作一个整体快照。

### `compareAndSet` 的成功条件升级成“引用和版本都匹配”

```java
// AtomicStampedReference.java:136-159
/**
 * Atomically sets the value of both the reference and stamp
 * to the given update values if the
 * current reference is {@code ==} to the expected reference
 * and the current stamp is equal to the expected stamp.
 */
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

这就是版本戳真正解决 ABA 的地方：

```text
旧线程记住的是 A-1
别的线程中间做成 A-3
虽然引用又回到 A
但 stamp 已不再是 1
→ CAS 失败
```

也就是说，Stamped 的目标不是让值“不回到旧引用”，而是让“值回到旧引用也骗不过版本检查”。

### `attemptStamp` 说明 stamp 本身也可以作为独立语义载体

```java
// AtomicStampedReference.java:173-191
/**
 * Atomically sets the value of the stamp to the given update value
 * if the current reference is {@code ==} to the expected
 * reference.  Any given invocation of this operation may fail
 * (return {@code false}) spuriously, but repeated invocation
 * when the current value holds the expected value and no other
 * thread is also attempting to set the value will eventually
 * succeed.
 *
 * @param expectedReference the expected value of the reference
 * @param newStamp the new value for the stamp
 * @return {@code true} if successful
 */
public boolean attemptStamp(V expectedReference, int newStamp) {
    Pair<V> current = pair;
    return
        expectedReference == current.reference &&
        (newStamp == current.stamp ||
         casPair(current, Pair.of(expectedReference, newStamp)));
}
```

这也提醒读者：stamp 不一定只是“版本号加一”这么简单。它首先是一段与引用绑定的附加状态，只是最典型的用法恰好是版本计数。

## 四、AtomicMarkableReference：当你只关心“是否被标记过”时，不需要整数版本号

### 它和 Stamped 是同一套路，只是把 `int stamp` 换成了 `boolean mark`

```java
// AtomicMarkableReference.java:41-67
/**
 * An {@code AtomicMarkableReference} maintains an object reference
 * along with a mark bit, that can be updated atomically.
 */
public class AtomicMarkableReference<V> {

    private static class Pair<T> {
        final T reference;
        final boolean mark;
        private Pair(T reference, boolean mark) {
            this.reference = reference;
            this.mark = mark;
        }
        static <T> Pair<T> of(T reference, boolean mark) {
            return new Pair<T>(reference, mark);
        }
    }

    private volatile Pair<V> pair;
```

这里的思路和 Stamped 完全同构：还是“把引用和附加信息打包成 Pair，一起 CAS”。

差别只在于附加信息的粒度不同：

- `AtomicStampedReference`：附加的是一个整数版本；
- `AtomicMarkableReference`：附加的是一个布尔标记。

### 所以它更适合“逻辑删除”这类一位状态问题

读取接口也直接说明了它更像“拿到引用，同时知道是否被标记”：

```java
// AtomicMarkableReference.java:98-109
/**
 * Returns the current values of both the reference and the mark.
 */
public V get(boolean[] markHolder) {
    Pair<V> pair = this.pair;
    markHolder[0] = pair.mark;
    return pair.reference;
}
```

CAS 路径同样要求引用和 mark 同时匹配：

```java
// AtomicMarkableReference.java:136-159
public boolean compareAndSet(V       expectedReference,
                             V       newReference,
                             boolean expectedMark,
                             boolean newMark) {
    Pair<V> current = pair;
    return
        expectedReference == current.reference &&
        expectedMark == current.mark &&
        ((newReference == current.reference &&
          newMark == current.mark) ||
         casPair(current, Pair.of(newReference, newMark)));
}
```

因此它的使用语义通常是：你不关心“改过几次”，你只关心“这个引用是否已经进入某个逻辑状态”，比如是否已被逻辑删除。

## 五、FieldUpdater：当你不想每个对象都多背一个 Atomic 包装对象时

### 它解决的首先是内存问题，而不是功能缺失问题

设想你有 100 万个节点对象，每个节点只有一个 `count` 字段需要并发原子更新。

如果你给每个节点都塞一个 `AtomicInteger`，你当然能得到很直观的 API，但也会多出 100 万个额外对象、对象头、引用和分配压力。

FieldUpdater 的价值就在这里：**原子能力不再附着在每个对象实例上，而是提到类静态层，由一个共享 updater 去操作每个对象里某个已有字段。**

JDK 11 的类注释已经把这个使用定位说得很准：

```java
// AtomicIntegerFieldUpdater.java:51-63
/**
 * A reflection-based utility that enables atomic updates to
 * designated {@code volatile int} fields of designated classes.
 * This class is designed for use in atomic data structures in which
 * several fields of the same node are independently subject to atomic
 * updates.
 *
 * <p>Note that the guarantees of the {@code compareAndSet}
 * method in this class are weaker than in other atomic classes.
 */
```

这里有两个关键词：

- `designated volatile int fields`
- `guarantees ... are weaker`

前者说明它的目标是“现有字段原子化”，后者说明它不是无条件等价替代物。

### `newUpdater` 的本质是：先做反射校验，再拿字段偏移

Updater 的入口在这里：

```java
// AtomicIntegerFieldUpdater.java:74-95
/**
 * Creates and returns an updater for objects with the given field.
 */
@CallerSensitive
public static <U> AtomicIntegerFieldUpdater<U> newUpdater(Class<U> tclass,
                                                          String fieldName) {
    return new AtomicIntegerFieldUpdaterImpl<U>
        (tclass, fieldName, Reflection.getCallerClass());
}
```

真正的实现类会在构造阶段把使用边界检查完：

```java
// AtomicIntegerFieldUpdater.java:416-434
if (field.getType() != int.class)
    throw new IllegalArgumentException("Must be integer type");

if (!Modifier.isVolatile(modifiers))
    throw new IllegalArgumentException("Must be volatile type");

this.cclass = (Modifier.isProtected(modifiers) &&
               tclass.isAssignableFrom(caller) &&
               !isSamePackage(tclass, caller))
              ? caller : tclass;
this.tclass = tclass;
this.offset = U.objectFieldOffset(field);
```

这几行几乎已经把 FieldUpdater 的门槛说完了：

- 字段必须是 `int`；
- 字段必须是 `volatile`；
- 访问控制必须过得去；
- 最终还是要把字段名变成一个内存偏移 `offset`。

所以 FieldUpdater 并不是“更轻量所以更随意”的东西；它恰恰因为是反射 + 偏移直写，才更依赖你满足它的前置约束。

### 真正的 CAS 仍然是那套底层原语，只是作用载体换成了“某个对象的某个字段”

```java
// AtomicIntegerFieldUpdater.java:489-492
public final boolean compareAndSet(T obj, int expect, int update) {
    accessCheck(obj);
    return U.compareAndSetInt(obj, offset, expect, update);
}
```

这说明 FieldUpdater 从来没有发明新的原子机制。它只是把原子操作从“包装对象自己的 value 字段”改成了“任意目标对象的某个已知 volatile 字段”。

因此它节省的是什么？不是 CPU 指令，不是 CAS 次数，而是：

```text
不需要每个对象再带一个独立 AtomicInteger 包装对象
```

### 为什么它的保证比 AtomicInteger 更弱

这一点非常关键。AtomicInteger 的好处之一，是那个数值字段完全被封装在对象内部，你想更新它，必须通过原子类 API。

但 FieldUpdater 操作的是一个外部对象里的字段。JDK 11 自己就提醒：它只能保证通过同一个 updater 做的 `compareAndSet` / `set` 彼此之间的原子性，不保证别的代码不会直接绕过 updater 去普通写这个字段。

同时，实现里每次操作前还要做一次对象访问检查：

```java
// AtomicIntegerFieldUpdater.java:462-469
/**
 * Checks that target argument is instance of cclass.  On
 * failure, throws cause.
 */
private final void accessCheck(T obj) {
    if (!cclass.isInstance(obj))
        throwAccessCheckException(obj);
}
```

所以它的代价和边界都很明确：

- 更省内存；
- API 更绕；
- 约束更多；
- 封装性更弱；
- 使用者更容易犯“字段被别处普通写”的错误。

### JDK 自己也在用 updater，说明它不是冷门玩具

一个非常好的实例就是 `SelectionKey` 的 attachment 字段：

```java
// SelectionKey.java:431-436
private volatile Object attachment;

private static final AtomicReferenceFieldUpdater<SelectionKey,Object>
    attachmentUpdater = AtomicReferenceFieldUpdater.newUpdater(
        SelectionKey.class, Object.class, "attachment"
    );
```

这说明 FieldUpdater 的定位非常清晰：当对象数量多、字段粒度细、又不想为每个对象再包一层原子包装时，它确实是有现实工程价值的。

## 六、把原子引用和 FieldUpdater 放回统一选型图里

现在可以把它们和前两篇放在一起看了。

### 先问：你要原子更新的到底是什么载体

```text
单个数值
   → AtomicInteger / AtomicLong

高竞争统计数值
   → LongAdder

整段对象引用
   → AtomicReference

带版本戳的引用
   → AtomicStampedReference

带逻辑标记的引用
   → AtomicMarkableReference

已有对象里的某个字段
   → Atomic*FieldUpdater
```

### 再问：你需不需要区分“值相同但历史不同”

这一步其实就是 ABA 风险判断：

- 不关心历史，只关心当前数值：普通原子数值或普通引用 CAS 足够；
- 关心引用是否经历过中途替换：Stamped / Markable 才是正确工具。

### 最后问：你能不能接受每对象一个包装对象的内存成本

- 能接受，且 API 简洁优先：直接 Atomic 包装类；
- 不能接受，对象数量极大：考虑 FieldUpdater，把能力提升到共享 updater 层。

所以真正完整的原子家族选型，不是死背类名，而是沿着这三问分流：

```text
1. 更新的是数值、引用，还是已有字段？
2. ABA 是否会改变语义？
3. 内存开销能否接受每对象一个包装？
```

## 收网：CAS 能做的远不止改数字，但语义与代价也随之升级

上一章里，CAS 主要是在回答“怎么无锁地更新一个共享数值”。

这一章则把边界继续推开了：

- `AtomicReference` 让你可以无锁整体替换一个对象引用；
- `AtomicStampedReference` / `AtomicMarkableReference` 让你在引用 CAS 上额外携带历史信息，防止 ABA；
- `FieldUpdater` 则把 CAS 能力从“包装对象内部字段”推广到“任何满足约束的现有对象字段”，用更少的内存换更弱的封装边界。

把整篇压成一张图，就是：

```text
CAS 扩展路线
   ├── 数值 CAS
   │    → AtomicInteger / AtomicLong
   ├── 分片数值 CAS
   │    → LongAdder
   ├── 引用 CAS
   │    → AtomicReference
   ├── 引用 + 版本/标记
   │    → Stamped / Markable
   └── 已有字段 CAS
        → FieldUpdater
```

实际使用时，先记住四条：

1. **AtomicReference 适合“不可变对象整体替换”，不是为了把可变对象内部字段随便原子乱改。**
2. **ABA 在引用结构里危险，是因为“值回到原样”不代表“历史没发生过变化”。**
3. **Stamped 和 Markable 都是在引用外再绑一层历史信息，只是一个用整数版本，一个用布尔标记。**
4. **FieldUpdater 省掉的是“每对象一个包装对象”的内存，但它的封装边界和保证都比 Atomic 包装类更弱。**

到这里，原子家族已经从单值 CAS、分片计数一路延伸到引用替换和字段原子化。再往后，真正的大规模并发控制要么走锁与同步器，要么走并发集合；而这两条线的底层，很多仍然站在今天这套 CAS 心智上。

> → 后续：域 18 序列化；关联：域 12 锁与同步器、域 10 并发集合
