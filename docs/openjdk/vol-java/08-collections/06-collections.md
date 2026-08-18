# 06. Collections 工具与包装器 — 防御编程三件套、算法工具

> **前置依赖**: [08-collections/01 — ArrayList](01-arraylist.md)、[08-collections/02 — LinkedList/Vector/Stack](02-linkedlist-vector.md)(List 家族与 RandomAccess)
> → **后续**:域 09 Map 与哈希(09-map 系列,下一篇)
> 关联: JLS §4.6(类型擦除);域 10 并发集合

## 防御编程三件套

`Collections`(5670 行)的静态工厂分两类: **三大包装器**(unmodifiable/synchronized/checked)是"防御编程"标配,算法工具(reverse/shuffle/sort)不依赖具体 List 实现。这篇把包装器的设计哲学与陷阱、算法工具的通用性技巧讲清楚。

## 1. "unmodifiableXxx 是怎么做到的" — 视图包装器

### 1.1 装饰器:拦截写操作

`Collections.unmodifiableList(list)`(`Collections.java:1287`)返回 `UnmodifiableList`(`Collections.java:1296`),基类是 `UnmodifiableCollection`(`Collections.java:1023`)。核心机制(`Collections.java:1059-1060`):

```java
// Collections.java:1059-1060(截取核心,逐字)
public boolean add(E e) {
    throw new UnsupportedOperationException();
}
```

**装饰器模式**: 包装原列表,**读方法委托、写方法直接抛 UnsupportedOperationException**。

### 1.2 视图,不是拷贝

关键认知: unmodifiableXxx 是**视图**不是拷贝——**原 list 变了,包装视图也变**。只有原引用被安全封装(不再外泄),包装才真正不可变。陷阱: 返回 unmodifiableList 的同时把原引用也返回 = 包装失效。

关键设计(斜体):*装饰器比防御性复制便宜(零拷贝),但可失效——JDK9+ 的 `List.of()` 是另一条路(不可变副本,非视图)。生产: 对外暴露的集合必须包 unmodifiable(API 防御规范)。面试"不可变集合的两种实现": 包装视图(可失效)vs 不可变副本(安全)。*

## 2. "synchronizedXxx 为什么是坑" — 方法级锁包装

### 2.1 方法级同步

`Collections.synchronizedList(list)`(`Collections.java:2385`)返回 `SynchronizedList`(`Collections.java:2400`),基类 `SynchronizedCollection`(`Collections.java:2000`)。每个方法包 `synchronized (mutex)`(`Collections.java:2039`):

```java
// Collections.java:2039-2041(截取核心,逐字)
public boolean add(E e) {
    synchronized (mutex) {return c.add(e);}
}
```

### 2.2 两个坑

1. **复合操作不安全**: `list.get(i)` 与 `list.add(...)` 两步之间锁已释放,其他线程可插入——原子性只在单方法内
2. **迭代器不安全**: 遍历时需手动锁——文档明确要求 `synchronized(list) { for (...) }`

与 Vector 同类问题(域 08 第 2 篇)——"方法级同步 ≠ 线程安全集合"。

关键设计(斜体):*正确姿势: 并发场景用 CopyOnWriteArrayList/ConcurrentLinkedQueue(域 10),或外部锁包裹复合操作。面试"为什么不用 synchronizedList 的标准答法": 复合操作不安全 + 迭代器要手动锁。*

## 3. "checkedXxx 防什么" — 类型安全视图

### 3.1 泛型擦除的漏洞

泛型信息运行时不存在(JLS §4.6): `((List) stringList).add(123)`——编译期放行(裸类型),运行期成功。**擦除漏洞**: 跨模块/反序列化/遗留代码混入错误类型时,错误在"奇怪的位置"才炸。

### 3.2 写入时检查

`CheckedCollection`(`Collections.java:3040`)的 add(`Collections.java:3097`):

```java
// Collections.java:3097(截取核心,逐字)
public boolean add(E e)          { return c.add(typeCheck(e)); }
```

**写入时 typeCheck**(instanceof 校验)——错误类型提前抛 ClassCastException,而不是闪现在奇怪的位置。

关键设计(斜体):*checked 包装器是"防御性编程的最后防线": 擦除后的运行时类型检查补充。生产: 与不可信代码协作的接口边界用。面试能说出"擦除漏洞 + checked 补救"就是加分。*

## 4. "算法工具" — reverse/shuffle/sort/swap

### 4.1 reverse:RandomAccess 策略分派

`Collections.reverse(list)`(`Collections.java:378-397`):

```java
// Collections.java:378-388(截取核心,逐字)
public static void reverse(List<?> list) {
    int size = list.size();
    if (size < REVERSE_THRESHOLD || list instanceof RandomAccess) {
        for (int i=0, mid=size>>1, j=size-1; i<mid; i++, j--)
            swap(list, i, j);
    } else {
        ...
        ListIterator fwd = list.listIterator();
        ListIterator rev = list.listIterator(size);
        ...
```

**RandomAccess 标记接口做策略分派**: ArrayList 这类(随机访问 O(1))用双端指针交换 O(n);LinkedList 这类(随机访问 O(n))用 ListIterator 双向遍历——**不依赖具体实现**。

### 4.2 shuffle:Fisher-Yates

`shuffle(list)`(`Collections.java:425-430`): 静态 `Random r` 共享实例(无害竞争)+ 委托带 Random 版(`Collections.java:458`)——**Fisher-Yates 洗牌**(从后向前与随机位置交换)。

### 4.3 sort:委托 List 接口 default

`Collections.sort(list)`(`Collections.java:144-145`):

```java
// Collections.java:144-145(截取核心,逐字)
public static <T extends Comparable<? super T>> void sort(List<T> list) {
    list.sort(null);
}
```

JDK8+ 实现移到 `List.sort` 的 default 方法: **toArray() → Arrays.sort → listIterator().set 写回**——任何 List 都能排序的实现技巧。

### 4.4 其他

`swap`(`Collections.java:496`)/`addAll`(`Collections.java:5503`)。

关键设计(斜体):*Collections 算法的通用性技巧: ① RandomAccess 标记接口做策略分派(数组 vs 链表)② sort 通过"转数组排序再写回"复用 Arrays——接口驱动 + 临时数组,不侵入 List 实现。面试"RandomAccess 是空接口有什么用": 标记接口的运行时策略判断(`list instanceof RandomAccess`)。*

## 核心悬念

List/Queue/迭代器都通了——但面试真正的重头是 **Map**: `HashMap` 怎么存?哈希冲突怎么解决?扩容为什么必须 2 次幂?`HashMap` 的树化阈值为什么是 8?——下一站: 域 09 Map 与哈希。

> → 下一篇: 域 09 Map 与哈希(09-map 系列)| 域 10 并发集合(并发生态)
