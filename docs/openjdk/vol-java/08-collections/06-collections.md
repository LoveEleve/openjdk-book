# Collections：它不是杂项工具箱，而是集合语义的适配器工厂

> 本文基于 JDK 11 `Collections` 源码。重点讨论三大包装器 `unmodifiable` / `synchronized` / `checked` 与 `sort` / `binarySearch` / `reverse` / `shuffle` 等通用算法的策略分派；不展开并发容器内部实现和后续 Map 体系细节。本文讨论的是 JDK 11 `Collections` 作为集合语义适配器工厂的设计，不把这里的视图包装、运行时类型补丁和 `RandomAccess` 分派策略外推成所有集合工具库都必须遵守的统一规范。
> **前置依赖**：[ArrayList 与动态数组](01-arraylist.md)、[LinkedList / Vector / Stack](02-linkedlist-vector.md)、[Arrays 与排序](05-arrays-sort.md)
> **后续**：域 09 Map 与哈希

## 真正该先看懂的，不是某个工具方法，而是 `Collections` 这个类扮演什么角色

很多人看到 `Collections`，第一反应是“一个装满静态方法的大工具类”。这句话表面没错，但不够准确。

JDK 11 自己的类注释其实已经把它的定位说得很清楚：

```java
// Collections.java:46-50
 * This class consists exclusively of static methods that operate on or return
 * collections.  It contains polymorphic algorithms that operate on
 * collections, "wrappers", which return a new collection backed by a
 * specified collection, and a few other odds and ends.
```

这几行里最重要的不是“静态方法”，而是两个关键词：

- `wrappers`
- `polymorphic algorithms`

也就是说，`Collections` 主要在做两类事情：

```text
第一类：包装器
   → 给现有集合叠加新的对外语义
   → 例如只读、同步、运行时类型检查

第二类：多态算法
   → 面向 List / Collection 接口工作
   → 再根据具体特征决定怎么走得更快
```

如果用这个视角去看，`Collections` 就不再是“零散工具箱”，而更像一组集合适配器：有的适配行为边界，有的适配算法路径。

## 一、`unmodifiableXxx` 为什么是只读视图，而不是真正不可变对象

### 它返回的是包装视图，不是新副本

JDK 11 的 `unmodifiableList` 入口很短：

```java
// Collections.java:1273-1290
 * Returns an <a href="Collection.html#unmodview">unmodifiable view</a> of the
 * specified list. Query operations on the returned list "read through" to the
 * specified list, and attempts to modify the returned list, whether
 * direct or via its iterator, result in an
 * {@code UnsupportedOperationException}.
 */
public static <T> List<T> unmodifiableList(List<? extends T> list) {
    return (list instanceof RandomAccess ?
            new UnmodifiableRandomAccessList<>(list) :
            new UnmodifiableList<>(list));
}
```

关键词已经写在文档里了：`unmodifiable view`。

它不是复制一份元素重新造出一个全新列表，而是返回一个**背靠原列表的包装视图**。读操作“读穿透”到原列表，写操作则被拦住。

### 真正的机制是：读透传，写抛异常

`UnmodifiableList` 里的实现非常直白：

```java
// Collections.java:1296-1333
static class UnmodifiableList<E> extends UnmodifiableCollection<E>
                              implements List<E> {
    final List<? extends E> list;

    UnmodifiableList(List<? extends E> list) {
        super(list);
        this.list = list;
    }

    public E get(int index) {return list.get(index);}
    public E set(int index, E element) {
        throw new UnsupportedOperationException();
    }
    public void add(int index, E element) {
        throw new UnsupportedOperationException();
    }
    public E remove(int index) {
        throw new UnsupportedOperationException();
    }
    @Override
    public void sort(Comparator<? super E> c) {
        throw new UnsupportedOperationException();
    }
```

这就是最典型的装饰器模式：

- 允许读，就委托给 backing list；
- 不允许写，就直接抛 `UnsupportedOperationException`。

所以 `unmodifiable` 真正表达的不是“这个集合在宇宙中永远不会变”，而是：**通过这个返回视图，你不能改它。**

### 为什么原列表一变，包装视图也会跟着变

因为它本来就是视图，不是拷贝。

这意味着：

```text
包装对象不持有独立元素副本
   → 只是把读请求转发给原集合
   → 原集合变了，视图读出来的内容自然也会变
```

这就是很多人第一次踩坑的地方：

```java
List<String> raw = new ArrayList<>();
List<String> ro = Collections.unmodifiableList(raw);
raw.add("x");
```

这里 `ro` 依然会看到 `x`。因此，`unmodifiable` 真正可靠的前提不是“我包了一层”，而是“原引用不再继续外泄”。

如果原列表还在别处被自由持有和修改，那这个包装器只能防止“通过当前视图写入”，不能保证“底层数据永远不变”。

### 为什么它仍然非常有用

因为很多 API 的目标不是做深度不可变对象，而是：**对外暴露只读能力，对内保留维护能力。**

这类场景里，`unmodifiable` 比复制一份全量元素更便宜，也更符合“只读视图”这个语义。只有当你需要彻底不可变语义时，才会更倾向于不可变副本路线，例如 JDK 9+ 的 `List.of()` 那种风格。

## 二、`synchronizedXxx` 为什么只保证单方法互斥，不保证整段业务安全

### 它做的事情其实很朴素：每个方法外面包一层锁

`SynchronizedCollection` 的基本形态就是“持有 backing collection + 持有 mutex”：

```java
// Collections.java:2000-2044
static class SynchronizedCollection<E> implements Collection<E>, Serializable {
    final Collection<E> c;
    final Object mutex;

    public int size() {
        synchronized (mutex) {return c.size();}
    }
    public boolean contains(Object o) {
        synchronized (mutex) {return c.contains(o);}
    }
    public boolean add(E e) {
        synchronized (mutex) {return c.add(e);}
    }
    public boolean remove(Object o) {
        synchronized (mutex) {return c.remove(o);}
    }
```

这说明它的设计非常直接：不重造集合结构，而是在每次方法调用时进入同一个互斥区。

`synchronizedList` 本身也只是再往 `List` 语义上包装一层：

```java
// Collections.java:2385-2433
public static <T> List<T> synchronizedList(List<T> list) {
    return (list instanceof RandomAccess ?
            new SynchronizedRandomAccessList<>(list) :
            new SynchronizedList<>(list));
}

static class SynchronizedList<E>
    extends SynchronizedCollection<E>
    implements List<E> {
    private static final long serialVersionUID = -7754090372962971524L;

    final List<E> list;

    SynchronizedList(List<E> list) {
        super(list);
        this.list = list;
    }
    SynchronizedList(List<E> list, Object mutex) {
        super(list, mutex);
        this.list = list;
    }

    public boolean equals(Object o) {
        if (this == o)
            return true;
        synchronized (mutex) {return list.equals(o);}
    }
    public int hashCode() {
        synchronized (mutex) {return list.hashCode();}
    }

    public E get(int index) {
        synchronized (mutex) {return list.get(index);}
    }
    public E set(int index, E element) {
        synchronized (mutex) {return list.set(index, element);}
    }
    public void add(int index, E element) {
        synchronized (mutex) {list.add(index, element);}
    }
```

所以它保证的是：**每个单独的方法调用，在包装器看来是互斥的。**

### 真正的问题：业务原子性往往跨越多个方法

这也是为什么 `synchronizedList` 很容易被误用。

如果你的业务逻辑是：

```java
if (!list.contains(x)) {
    list.add(x);
}
```

那这里真正需要的是“整段 if 逻辑要么整体观察、整体写入”，但 `synchronizedList` 只会分别给 `contains` 和 `add` 两次调用上锁。它不会自动把这两步拼成一个更大的原子区间。

也就是说：

```text
方法级同步
   ≠
复合操作原子性
```

这和上一章讲 `Vector` 的问题本质是一类：API 方法本身线程安全，不等于基于多个 API 拼出来的业务操作天然线程安全。

### 迭代器更是明确要求你自己加锁

JDK 11 源码里几乎把这件事用红字写出来了。`iterator()` 本身就直接提醒：

```java
// Collections.java:2035-2037
public Iterator<E> iterator() {
    return c.iterator(); // Must be manually synched by user!
}
```

文档部分也给了明确用法：遍历时必须由用户自己在外层同步。

```java
// Collections.java:2096-2108
 * It is imperative that the user manually synchronize on the returned
 * collection when traversing it via {@link Iterator}, {@link Spliterator}
 * or {@link Stream}:
 * <pre>
 *  Set s = Collections.synchronizedSet(new HashSet());
 *      ...
 *  synchronized (s) {
 *      Iterator i = s.iterator(); // Must be in the synchronized block
 *      while (i.hasNext())
 *          foo(i.next());
 *  }
 * </pre>
```

这再次说明一个边界：`synchronizedXxx` 不是“我包上它，从此整个集合世界都自动线程安全了”。它只是给每个方法包了一层默认锁语义；一旦你要跨方法协作、遍历、流式处理，就必须自己理解并接管更大的同步范围。

## 三、`checkedXxx` 为什么不是多余遗产，而是泛型擦除后的运行时补丁

### 编译期泛型检查并不能覆盖所有入口

很多人一看到 `checkedList` 就会想：有了泛型，谁还需要运行时类型检查？

问题在于，Java 泛型是擦除实现。运行时集合本体不知道自己最初写的是 `List<String>` 还是 `List<Integer>`。只要经过裸类型、老代码、反射、跨模块边界，错误类型仍有可能被塞进去。

### `CheckedCollection` 就是在写入点补上这层检查

JDK 11 的 `CheckedCollection` 持有两个东西：底层集合和目标元素类型。

```java
// Collections.java:3040-3050
static class CheckedCollection<E> implements Collection<E>, Serializable {
    final Collection<E> c;
    final Class<E> type;

    @SuppressWarnings("unchecked")
    E typeCheck(Object o) {
        if (o != null && !type.isInstance(o))
            throw new ClassCastException(badElementMsg(o));
        return (E) o;
    }
```

写入时，它会先做 `typeCheck`：

```java
// Collections.java:3097
public boolean add(E e)          { return c.add(typeCheck(e)); }
```

这就是 `checked` 包装器的全部意义：**把本来会在更晚、更奇怪位置爆炸的类型错误，尽量前移到写入时刻。**

### 它防的是“系统边界混入脏类型”

这个 API 在全新泛型代码里确实不常手写，但一旦碰到这些场景，它就很有价值：

- 遗留代码还在用 raw type；
- 外部模块或反射绕开了编译期泛型检查；
- 反序列化或不可信集合输入需要额外防线；
- 你希望在“污染进入集合”那一刻就失败，而不是等很久之后在读取或强转处才炸。

`checkedCopyOf` 里甚至连 `toArray` 契约不可信的情况都防了：

```java
// Collections.java:3106-3126
Collection<E> checkedCopyOf(Collection<? extends E> coll) {
    Object[] a;
    try {
        E[] z = zeroLengthElementArray();
        a = coll.toArray(z);
        if (a.getClass() != z.getClass())
            a = Arrays.copyOf(a, a.length, z.getClass());
    } catch (ArrayStoreException ignore) {
        a = coll.toArray().clone();
        for (Object o : a)
            typeCheck(o);
    }
    return (Collection<E>) Arrays.asList(a);
}
```

这说明 `checked` 不是形式主义，而是真把“运行时类型安全补丁”做到了边界细节上。

## 四、`Collections` 算法为什么能通用，却不粗暴

### `sort(List)` 自己不实现排序，而是把能力交回给 `List`

JDK 11 的 `Collections.sort` 短得有点出人意料：

```java
// Collections.java:143-146
public static <T extends Comparable<? super T>> void sort(List<T> list) {
    list.sort(null);
}
```

这看起来像“偷懒”，其实恰恰是一种很好的抽象设计：`Collections` 不去强行规定所有 List 必须怎么排序，而是把排序语义交给 `List.sort`，再由具体实现去决定内部如何借助 `Arrays.sort` 或别的路径完成。

这和上一章的 `Arrays.sort` 完成了很自然的分工：

```text
Collections.sort
   → 站在 List 抽象层

List.sort / 具体实现
   → 决定怎么把 List 内容搬运到适合排序的形态

Arrays.sort
   → 真正完成数组层的排序
```

### `binarySearch` 会根据 `RandomAccess` 和规模切换策略

这一点最能体现“通用而不粗暴”的味道。`Collections.binarySearch` 并没有简单假设所有 List 都适合 `get(mid)`，而是先看：

- 这个列表是不是 `RandomAccess`；
- 它的规模是不是小到顺序结构也还能接受。

```java
// Collections.java:192-219
 * <p>This method runs in log(n) time for a "random access" list (which
 * provides near-constant-time positional access).  If the specified list
 * does not implement the {@link RandomAccess} interface and is large,
 * this method will do an iterator-based binary search that performs
 * O(n) link traversals and O(log n) element comparisons.
 *
 * @param  <T> the class of the objects in the list
 * @param  list the list to be searched.
 * @param  key the key to be searched for.
 * @return the index of the search key, if it is contained in the list;
 *         otherwise, <code>(-(<i>insertion point</i>) - 1)</code>.  The
 *         <i>insertion point</i> is defined as the point at which the
 *         key would be inserted into the list: the index of the first
 *         element greater than the key, or {@code list.size()} if all
 *         elements in the list are less than the specified key.  Note
 *         that this guarantees that the return value will be &gt;= 0 if
 *         and only if the key is found.
 * @throws ClassCastException if the list contains elements that are not
 *         <i>mutually comparable</i> (for example, strings and
 *         integers), or the search key is not mutually comparable
 *         with the elements of the list.
 */
public static <T>
int binarySearch(List<? extends Comparable<? super T>> list, T key) {
    if (list instanceof RandomAccess || list.size()<BINARYSEARCH_THRESHOLD)
        return Collections.indexedBinarySearch(list, key);
    else
        return Collections.iteratorBinarySearch(list, key);
}
```

对链式结构，大列表会改走迭代器版本：

```java
// Collections.java:242-280
private static <T>
int iteratorBinarySearch(List<? extends Comparable<? super T>> list, T key)
{
    int low = 0;
    int high = list.size()-1;
    ListIterator<? extends Comparable<? super T>> i = list.listIterator();

    while (low <= high) {
        int mid = (low + high) >>> 1;
        Comparable<? super T> midVal = get(i, mid);
        int cmp = midVal.compareTo(key);

        if (cmp < 0)
            low = mid + 1;
        else if (cmp > 0)
            high = mid - 1;
        else
            return mid; // key found
    }
    return -(low + 1);  // key not found
}

/**
 * Gets the ith element from the given list by repositioning the specified
 * list listIterator.
 */
private static <T> T get(ListIterator<? extends T> i, int index) {
    T obj = null;
    int pos = i.nextIndex();
    if (pos <= index) {
        do {
            obj = i.next();
        } while (pos++ < index);
    } else {
        do {
            obj = i.previous();
        } while (--pos > index);
    }
    return obj;
}
```

这里不是为了把链表二分查找变成真正的 O(log n)` 随机访问，而是为了避免反复用 `get(mid)` 导致更糟的访问模式。JDK 会尽量沿着当前迭代器位置前后调整，而不是每次都从头暴力定位。

### `reverse` 和 `shuffle` 也会做结构感知分派

`reverse` 的策略同样很经典：

```java
// Collections.java:378-395
public static void reverse(List<?> list) {
    int size = list.size();
    if (size < REVERSE_THRESHOLD || list instanceof RandomAccess) {
        for (int i=0, mid=size>>1, j=size-1; i<mid; i++, j--)
            swap(list, i, j);
    } else {
        ListIterator fwd = list.listIterator();
        ListIterator rev = list.listIterator(size);
        for (int i=0, mid=list.size()>>1; i<mid; i++) {
            Object tmp = fwd.next();
            fwd.set(rev.previous());
            rev.set(tmp);
        }
    }
}
```

如果是 ArrayList 这类随机访问友好的结构，直接双指针下标交换；如果是 LinkedList 这类顺序结构，就用双向迭代器。

`shuffle` 也类似。对大而非 `RandomAccess` 的列表，它甚至会先转成数组再洗牌，避免原地随机访问导致平方复杂度：

```java
// Collections.java:425-429
public static void shuffle(List<?> list) {
    Random rnd = r;
    if (rnd == null)
        r = rnd = new Random();
    shuffle(list, rnd);
}
```

```java
// Collections.java:434-479
/**
 * Randomly permute the specified list using the specified source of
 * randomness.  All permutations occur with equal likelihood
 * assuming that the source of randomness is fair.<p>
 *
 * This implementation traverses the list backwards, from the last element
 * up to the second, repeatedly swapping a randomly selected element into
 * the "current position".
 */
@SuppressWarnings({"rawtypes", "unchecked"})
public static void shuffle(List<?> list, Random rnd) {
    int size = list.size();
    if (size < SHUFFLE_THRESHOLD || list instanceof RandomAccess) {
        for (int i=size; i>1; i--)
            swap(list, i-1, rnd.nextInt(i));
    } else {
        Object[] arr = list.toArray();

        for (int i=size; i>1; i--)
            swap(arr, i-1, rnd.nextInt(i));

        ListIterator it = list.listIterator();
        for (Object e : arr) {
            it.next();
            it.set(e);
        }
    }
}
```

这就是 `Collections` 算法真正有意思的地方：它不是“接口抽象一层，性能全丢掉”，而是在接口层尽可能收集结构信号，再做适配性分派。

## 五、为什么 `RandomAccess` 这种空接口仍然重要

很多人第一次看到 `RandomAccess` 会觉得：没有方法的接口能有什么意义？

意义就在于，它给算法层提供了一个非常轻量、却足够有用的结构提示：

```text
实现了 RandomAccess
   → 说明按索引访问通常便宜
   → 算法可以放心多用 get(i)、swap(i, j)

没实现 RandomAccess
   → 说明更可能是顺序访问结构
   → 算法应更谨慎，优先考虑迭代器或转数组
```

它不需要承诺复杂度证明，也不需要暴露实现细节，只需要给上层一个方向性的“适合这样走”的信号。对于 `Collections` 这种多态算法工厂来说，这已经足够宝贵。

## 六、五个最容易混掉的边界：`unmodifiable` 不是 immutable，`synchronized` 不是并发语义全包，`checked` 不是多余历史包袱，`Collections.sort` 不是自己重写排序，`RandomAccess` 也不是空壳摆设

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`unmodifiable` 不是 immutable。它只保证“通过这个视图你不能写”，不保证底层集合不会在别处被改。只要原引用继续泄漏，包装视图看到的内容照样会跟着变化。

第二，`synchronizedXxx` 也不是把并发语义整包解决了。它保证的是单次方法调用的互斥，不会自动把多个方法拼起来的业务步骤变成原子动作；遍历时甚至还明确要求你自己在外层手动加锁。

第三，`checkedXxx` 更不是泛型时代的多余残留。它真正修补的是运行时世界：当原始类型、反射、老代码或边界输入把脏对象塞进集合时，编译期泛型早就不在场了，运行时补丁才有价值。

第四，`Collections.sort` 也不是自己又重写了一遍排序算法。它真正站在更高层做的是接口调度：把“如何排序”交还给 `List.sort` 和具体实现，让数组层优化继续由 `Arrays.sort` 去完成。

第五，`RandomAccess` 也不是一个没有方法就没意义的空壳接口。对 `Collections` 这类多态算法来说，它正好提供了最轻量但足够有用的结构信号：该走下标，还是该收手改走迭代器/转数组。

把这五条边界记稳，`Collections` 这一篇就不会重新塌回“杂项工具类大全”这种表面印象。它真正想讲的是：JDK 怎样在不重造底层结构的前提下，一边包出新语义，一边按结构特征切换算法策略。

## 七、五个最容易混掉的边界：`unmodifiable` 不是 immutable，`synchronized` 不是并发语义全包，`checked` 不是多余历史包袱，`Collections.sort` 不是自己重写排序，`RandomAccess` 也不是空壳摆设

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`unmodifiable` 不是 immutable。它只保证“通过这个视图你不能写”，不保证底层集合不会在别处被改。只要原引用继续泄漏，包装视图看到的内容照样会跟着变化。

第二，`synchronizedXxx` 也不是把并发语义整包解决了。它保证的是单次方法调用的互斥，不会自动把多个方法拼起来的业务步骤变成原子动作；遍历时甚至还明确要求你自己在外层手动加锁。

第三，`checkedXxx` 更不是泛型时代的多余残留。它真正修补的是运行时世界：当原始类型、反射、老代码或边界输入把脏对象塞进集合时，编译期泛型早就不在场了，运行时补丁才有价值。

第四，`Collections.sort` 也不是自己又重写了一遍排序算法。它真正站在更高层做的是接口调度：把“如何排序”交还给 `List.sort` 和具体实现，让数组层优化继续由 `Arrays.sort` 去完成。

第五，`RandomAccess` 也不是一个没有方法就没意义的空壳接口。对 `Collections` 这类多态算法来说，它正好提供了最轻量但足够有用的结构信号：该走下标，还是该收手改走迭代器/转数组。

把这五条边界记稳，`Collections` 这一篇就不会重新塌回“杂项工具类大全”这种表面印象。它真正想讲的是：JDK 怎样在不重造底层结构的前提下，一边包出新语义，一边按结构特征切换算法策略。

## 收网：`Collections` 真正统一的，不是数据结构，而是适配思路

现在再回头看 `Collections`，它就不再是“又一堆静态方法”。

`unmodifiable`、`synchronized`、`checked` 三大包装器，统一的是“在不重造底层结构的前提下，给现有集合叠加新的对外语义”。

`sort`、`binarySearch`、`reverse`、`shuffle` 这些算法工具，统一的是“站在集合接口层工作，再根据 `RandomAccess`、规模阈值和可变性能力选择更合适的路径”。

把整篇压成一张图，就是：

```text
Collections
   ├── 包装器
   │    ├── unmodifiable：只读视图
   │    ├── synchronized：单方法互斥包装
   │    └── checked：运行时类型检查
   └── 多态算法
        ├── sort：委托 List.sort
        ├── binarySearch：按 RandomAccess 分派
        ├── reverse：下标交换或双向迭代器
        └── shuffle：原地洗牌或转数组后写回
```

实际使用时，先记住四条：

1. **`unmodifiable` 是视图，不是深不可变副本**；想真正对外不可变，关键是别再泄漏原引用。
2. **`synchronizedXxx` 只保证单方法互斥**；复合操作和遍历仍要你自己理解并补上更大的同步边界。
3. **`checkedXxx` 的价值来自泛型擦除后的运行时补丁**；它防的是边界脏类型混入。
4. **`Collections` 算法的精髓是接口抽象下的策略分派**；`RandomAccess` 这种空接口也能真实影响算法路径。

到这里，集合域的顺序容器、队列、迭代器、数组工具和包装器都已经串起来了。下一站进入真正的大头：域 09 Map 与哈希，看看 `HashMap` 为什么会成为 Java 面试里最密集的一块源码地带。

> → 下一篇：域 09 Map 与哈希
