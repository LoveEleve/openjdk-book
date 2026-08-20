# 迭代器与 fail-fast：为什么一边遍历一边改，集合宁可当场翻脸

> 本文基于 JDK 11 `Iterable`、`AbstractList`、`ArrayList` 源码。重点讨论增强 for、迭代器状态机、`modCount` / `expectedModCount`、`iterator.remove()` 和 `subList` 的 fail-fast 语义；并发容器只作对照，不展开内部实现。本文讨论的是 JDK 11 列表迭代器与 fail-fast 机制，不把这里的 `modCount` 版本策略、视图联动检查和异常早失败模型外推成所有集合或并发容器都必须遵守的统一规范。
> **前置依赖**：[ArrayList 与动态数组](01-arraylist.md)、[ArrayDeque 与 PriorityQueue](03-deque-priorityqueue.md)
> **后续**：[Arrays 工具与排序](05-arrays-sort.md)

## 最常见的集合崩溃，并不发生在多线程里

很多人第一次遇到 `ConcurrentModificationException`，是在这样的代码里：

```java
for (String s : list) {
    list.remove(s);
}
```

最容易产生的误解有两个。

第一个误解是：异常名里有 `Concurrent`，所以这一定是多线程并发问题。其实完全可能只有一个线程，照样抛。

第二个误解是：我删的明明就是当前遍历到的元素，为什么集合不让我删？

这两个误解背后都指向同一个事实：**真正负责遍历状态的不是 for 语句，也不是列表本体，而是迭代器对象。**

fail-fast 的核心不是“禁止所有修改”，而是：当负责遍历的那个状态机发现底层结构已经不是它启动时认知的那一版，它宁可立刻报错，也不继续给你一个可能已经失真的遍历结果。

## 一、增强 for 为什么最后会落到 `Iterator`

### 能写增强 for，是因为对象实现了 `Iterable`

JDK 11 的 `Iterable` 接口直接把这层关系写在文档里：实现它，对象才能成为增强 for 的目标。

```java
// Iterable.java:34-48
 * Implementing this interface allows an object to be the target of the enhanced
 * {@code for} statement (sometimes called the "for-each loop" statement).
 */
public interface Iterable<T> {
    /**
     * Returns an iterator over elements of type {@code T}.
     */
    Iterator<T> iterator();
```

这段契约的含义很重要：增强 for 并不是“编译器直接替你按下标循环集合”，而是“编译器会去拿这个对象的迭代器，然后通过迭代器一步步往前走”。

所以，对集合来说，真正携带遍历进度的是：

```text
不是 for 语句本身
不是 list 变量本身
而是 iterator()
返回出来的那个迭代器对象
```

### `forEach` 的默认实现也站在同一条路径上

JDK 11 的 `Iterable.forEach` 默认实现也没有绕开这层机制。它明确写成了“表现得像 `for (T t : this)`”：

```java
// Iterable.java:57-77
 * The behavior of this method is unspecified if the action performs
 * side-effects that modify the underlying source of elements, unless an
 * overriding class has specified a concurrent modification policy.
 *
 * @implSpec
 * <p>The default implementation behaves as if:
 * <pre>{@code
 *     for (T t : this)
 *         action.accept(t);
 * }</pre>
 */
default void forEach(Consumer<? super T> action) {
    Objects.requireNonNull(action);
    for (T t : this) {
        action.accept(t);
    }
}
```

这说明两件事：

- 增强 for 和普通集合遍历，本质上都站在迭代器语义上；
- 在遍历动作里随手修改底层集合，本来就不被默认契约保证安全。

所以文章开头那段 `for (String s : list) list.remove(s)`，从一开始就不是“for 语句亲自删元素”，而是“一个迭代器正在走，外部代码又绕开它去改底层结构”。

## 二、`modCount` 记录的不是线程状态，而是结构版本

### fail-fast 先要有一个“结构版本号”

`AbstractList` 里有一个几乎所有人都见过名字、但未必讲得准确的字段：

```java
// AbstractList.java:620-628
 * {@code add(int, E)} or {@code remove(int)} must add no more than
 * one to this field, or the iterators (and list iterators) will throw
 * bogus {@code ConcurrentModificationExceptions}.  If an implementation
 * does not wish to provide fail-fast iterators, this field may be
 * ignored.
 */
protected transient int modCount = 0;
```

它不是锁，也不是并发工具里的版本戳。它更接近一种很朴素的结构版本号：**只要列表结构发生了迭代器关心的变化，这个数字就加一。**

### 结构性修改才会推进版本

在 `ArrayList` 里，追加元素会推进 `modCount`：

```java
// ArrayList.java:497-500
public boolean add(E e) {
    modCount++;
    add(e, elementData, size);
    return true;
}
```

删除元素也会推进 `modCount`：

```java
// ArrayList.java:669-674
private void fastRemove(Object[] es, int i) {
    modCount++;
    final int newSize;
    if ((newSize = size - 1) > i)
        System.arraycopy(es, i + 1, es, i, newSize - i);
    es[size = newSize] = null;
}
```

但 `set` 这种“只改当前位置的值、不改结构骨架”的操作，通常不会触发新的结构版本：

```java
// ArrayList.java:1081-1090
public void set(E e) {
    if (lastRet < 0)
        throw new IllegalStateException();
    checkForComodification();

    try {
        ArrayList.this.set(lastRet, e);
    } catch (IndexOutOfBoundsException ex) {
        throw new ConcurrentModificationException();
    }
}
```

这里要抓住一个关键区分：fail-fast 关心的是**遍历结构是否还可信**，不是“对象里任何值有没有变化”。

所以：

```text
add / remove / clear
   → 元素数量或结构骨架变化
   → modCount 递增

set
   → 只是改当前位置上的值
   → 通常不算结构性修改
```

这也是为什么常说“遍历中改值通常没事，遍历中增删最容易出事”。

## 三、迭代器为什么能发现你在外面偷偷改了集合

### 迭代器内部不只存游标，还存创建时的版本快照

在 `AbstractList` 的迭代器实现里，除了 `cursor` 和 `lastRet`，还有一个最关键的字段：`expectedModCount`。

```java
// AbstractList.java:354-361
int lastRet = -1;

/**
 * The modCount value that the iterator believes that the backing
 * List should have.  If this expectation is violated, the iterator
 * has detected concurrent modification.
 */
int expectedModCount = modCount;
```

这就是 fail-fast 的本体：**迭代器一创建，就把当时看到的 `modCount` 拷一份放在自己身上。** 以后它每走一步，都会拿“当前真实版本”和“自己记下来的版本”做比对。

### `next()` 每次前进前都要先核对快照

看 `next()` 的实现就很清楚：

```java
// AbstractList.java:367-379
public E next() {
    checkForComodification();
    try {
        int i = cursor;
        E next = get(i);
        lastRet = i;
        cursor = i + 1;
        return next;
    } catch (IndexOutOfBoundsException e) {
        checkForComodification();
        throw new NoSuchElementException();
    }
}
```

```java
// AbstractList.java:397-399
final void checkForComodification() {
    if (modCount != expectedModCount)
        throw new ConcurrentModificationException();
}
```

这个逻辑一点都不复杂：

```text
迭代器启动时
   → 记住 expectedModCount

每次 next 前
   → 看当前 modCount 还是否等于 expectedModCount

不等
   → 说明底层结构已被改动
   → 立即抛 ConcurrentModificationException
```

这就是 fail-fast 这个名字的含义：不是“默默容忍，然后尽量走完”，而是“只要发现遍历前提已经被破坏，就尽快失败”。

### 所以 `ConcurrentModificationException` 不要求真的并发

现在也就能解释为什么单线程照样会抛这个异常。

“concurrent modification” 在这里表达的并不是“两个线程同时跑”，而是“遍历状态机正在按一套结构前进，底层结构却在它不知情的情况下发生了并行于它的修改”。

哪怕是同一个线程，只要是：

```text
迭代器在走
   同时
外部代码绕过迭代器直接改底层结构
```

对迭代器来说，这仍然是“不被它追踪到的并行结构变化”。于是下次检查就会炸。

## 四、为什么 `iterator.remove()` 安全，而 `list.remove()` 经常不安全

### 关键不在“能不能删”，而在“谁负责维护遍历状态机”

很多人背答案会说：遍历删除要用 `iterator.remove()`。这句话本身对，但如果不讲原因，就很容易变成口诀。

真正原因是：**`iterator.remove()` 是知情修改，`list.remove()` 是绕开遍历状态机的外部修改。**

看 `remove()` 的实现：

```java
// AbstractList.java:381-395
public void remove() {
    if (lastRet < 0)
        throw new IllegalStateException();
    checkForComodification();

    try {
        AbstractList.this.remove(lastRet);
        if (lastRet < cursor)
            cursor--;
        lastRet = -1;
        expectedModCount = modCount;
    } catch (IndexOutOfBoundsException e) {
        throw new ConcurrentModificationException();
    }
}
```

这里有三步非常关键：

1. 先确认当前状态允许删；
2. 让底层列表真的删掉那个元素；
3. 把自己的 `cursor`、`lastRet`、`expectedModCount` 一起修正到新结构上。

尤其是最后一行：

```text
expectedModCount = modCount
```

这不是小细节，而是整个“安全删除”成立的核心。因为这次结构变化是迭代器自己发起的，所以它有责任也有能力把自己的快照同步到新版本。

### 外部直接删，迭代器就失去了对结构变化的知情权

如果你在增强 for 或显式迭代时调用的是 `list.remove()`，情况就完全不同了：

- 底层列表确实改了；
- `modCount` 也确实变了；
- 但那个正在走的迭代器并不知道这次变化是怎么发生的，也没机会修正自己的 `cursor` / `lastRet` / `expectedModCount`。

于是下次它再 `next()`，看到版本不匹配，只能认定遍历前提已失真，然后抛异常。

所以“删除的正确姿势”本质上不是某个 API 的偏好，而是：**负责遍历的人，必须同时负责通知并修正遍历状态机。**

## 五、`ListIterator` 和 `set/add`：迭代器并不是只会读

fail-fast 不是说“迭代器只能读，不能动”。相反，`ListIterator` 明确支持 `set`、`add` 这类更主动的修改，只不过它同样要求这些修改发生在迭代器的知情路径上。

```java
// AbstractList.java:433-457
public void set(E e) {
    if (lastRet < 0)
        throw new IllegalStateException();
    checkForComodification();

    try {
        AbstractList.this.set(lastRet, e);
        expectedModCount = modCount;
    } catch (IndexOutOfBoundsException ex) {
        throw new ConcurrentModificationException();
    }
}

public void add(E e) {
    checkForComodification();

    try {
        int i = cursor;
        AbstractList.this.add(i, e);
        lastRet = -1;
        cursor = i + 1;
        expectedModCount = modCount;
    } catch (IndexOutOfBoundsException ex) {
        throw new ConcurrentModificationException();
    }
}
```

这里 again 体现的是同一原则：修改不是禁止的，但必须由“正在维护遍历状态的对象”发起，并在修改后同步自己的快照和游标。

## 六、`subList` 为什么也要参与 fail-fast 检查

### 因为它不是副本，而是共享同一底层结构的视图

前面讲过 `subList()` 是视图，不是复制。JDK 11 自己的注释就提醒过：如果 backing list 在别处发生结构性修改，而不是通过返回的子视图修改，那么返回列表的语义会变得 undefined。

```java
// ArrayList.java:1128-1133
 * <p>The semantics of the list returned by this method become undefined if
 * the backing list (i.e., this list) is <i>structurally modified</i> in
 * any way other than via the returned list.  (Structural modifications are
 * those that change the size of this list, or otherwise perturb it in such
 * a fashion that iterations in progress may yield incorrect results.)
```

这段话其实已经把 fail-fast 的需求说出来了：子视图和原列表共享底层结构，只要原结构在别处被改，子视图里的边界、偏移量和迭代前提都可能一起失真。

### `SubList` 创建时也会带着版本快照走

`SubList` 构造器里会把根列表当前的 `modCount` 记下来：

```java
// ArrayList.java:1151-1157
public SubList(ArrayList<E> root, int fromIndex, int toIndex) {
    this.root = root;
    this.parent = null;
    this.offset = fromIndex;
    this.size = toIndex - fromIndex;
    this.modCount = root.modCount;
}
```

之后不管是 `get` 还是 `size`，都会先检查：

```java
// ArrayList.java:1178-1186
public E get(int index) {
    Objects.checkIndex(index, size);
    checkForComodification();
    return root.elementData(offset + index);
}

public int size() {
    checkForComodification();
    return size;
}
```

而 `AbstractList` 对 `subList` 的文档也强调了这一点：子视图的方法会先检查 backing list 的 `modCount` 是否仍符合预期。

```java
// AbstractList.java:487-489
 * <p>All methods first check to see if the actual {@code modCount} of
 * the backing list is equal to its expected value, and throw a
 * {@code ConcurrentModificationException} if it is not.
```

这说明 fail-fast 保护的不只是“一个 iterator 正不正常”，还保护“这段视图仍然建立在同一份结构假设上”。

## 七、fail-fast 不是并发安全，只是尽早报警

### 它能帮你尽早暴露错误，但不会替你做同步

到这里必须把边界说死：fail-fast 不是线程安全机制。

它做的事情是：

- 在常见错误用法下，尽早发现结构前提已经被破坏；
- 用异常把问题暴露出来，而不是继续给出可能失真的结果。

它做不到的事情是：

- 替非线程安全集合建立真正的并发协议；
- 保证多线程下一定能稳定、完整、无竞态地遍历。

这也是为什么 `Iterable.forEach` 文档会明确说，如果 action 带副作用去改底层源，而类本身又没有声明并发修改策略，那么行为就是 unspecified。

### fail-safe / 弱一致是另一条设计路线

并发容器里的迭代语义是另一套权衡：有的走快照，有的走弱一致，目标是“在并发下可用”，而不是“只要出错就尽快炸掉”。

所以不要把“不会抛 `ConcurrentModificationException`”误解成“更正确”。它通常只是换了一种一致性模型。

## 八、五个最容易混掉的边界：CME 不等于多线程，modCount 不是锁，iterator.remove 不是特殊豁免，set 不等于结构修改，subList 也不是独立副本

在收网之前，先把这一篇最容易记错的五条边界压实。

第一，`ConcurrentModificationException` 不等于多线程并发。哪怕只有一个线程，只要迭代器正在走，外部代码又绕过它去改底层结构，对迭代器来说这仍然是“与我并行发生、但我不知情”的结构变化。

第二，`modCount` 也不是锁，更不是线程安全版本号。它只是一个结构版本计数器，用来帮助迭代器判断“我起步时看到的那份结构，还在不在”。它本身不建立互斥，也不提供并发内存语义。

第三，`iterator.remove()` 之所以安全，也不是因为迭代器偷偷关掉了检查。恰恰相反，它安全是因为迭代器亲自参与了这次修改，并在修改后同步修正了自己的 `cursor/lastRet/expectedModCount`。

第四，`set` 往往不触发 fail-fast，也不等于“任何修改都没事”。它只是通常不改变遍历骨架，所以不被算作结构性变化；而一旦改动影响的是元素个数、索引边界或底层结构，版本号就会变化，fail-fast 也会重新介入。

第五，`subList()` 更不是拷出来的一份独立列表。它本质上仍然背靠原列表共享结构，所以原列表或视图的结构变化一样会让另一侧的遍历和边界判断失真，这也是它必须一并参与 `modCount` 检查的原因。

把这五条边界记稳，fail-fast 这一篇就不会重新塌回“遍历时别修改集合”的口诀印象。它真正想讲的是：集合遍历背后有一个显式状态机，而 fail-fast 只是这台状态机在结构失真时选择尽早翻脸。

## 收网：集合为什么宁可翻脸，也不愿替你猜遍历该怎么继续

现在回到开头那段最常见的报错代码。

为什么 `for (String s : list) list.remove(s)` 经常抛 `ConcurrentModificationException`？因为增强 for 背后站着一个迭代器，而这个迭代器在启动时已经记住了自己所相信的结构版本。你绕开它直接改底层列表时，它的快照和真实结构就分叉了。

为什么 `iterator.remove()` 却通常安全？因为修改是由维护遍历状态机的那个对象亲自发起的；删完之后，它也会同步游标和版本快照。

为什么 `subList()` 也会跟着受影响？因为它不是副本，而是共享同一底层结构的视图；一旦原结构在别处变化，视图的边界和索引前提也可能一起失真。

把整条链压成一张图，就是：

```text
enhanced for
   → iterator()
   → 迭代器持有 cursor / lastRet / expectedModCount
   → 每次 next 前比对 modCount
   → 外部结构修改导致快照失配
   → fail-fast 抛 ConcurrentModificationException
   → iterator.remove() 例外，因为它会同步自己的状态
```

实际写代码时，先记住四条：

1. **`ConcurrentModificationException` 不要求真的多线程**；单线程里绕开迭代器改结构也会触发。
2. **`modCount` 是结构版本号，不是并发控制工具**；别把它理解成锁或线程安全保证。
3. **遍历中删元素，关键不是“删不删”，而是谁在维护遍历状态机**；需要删就走 `iterator.remove()`、`removeIf()` 或倒序删。
4. **`subList` 也活在同一份结构版本上**；它的 fail-fast 是共享视图语义的一部分。

下一篇进入 `Arrays`：集合外壳讲完之后，回到底层数组工具本身，看看排序、查找和复制为什么会长成今天这样。

> → 下一篇：[Arrays 工具与排序](05-arrays-sort.md)
