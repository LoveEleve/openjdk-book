# 04. 迭代器与 fail-fast — modCount、ConcurrentModificationException

> **前置依赖**: [08-collections/01 — ArrayList](01-arraylist.md)(add/remove 的 modCount++ 已见)、[08-collections/03 — ArrayDeque 与 PriorityQueue](03-deque-priorityqueue.md)(Queue 契约)
> → **后续**:[08-collections/05 — Arrays 工具与排序](05-arrays-sort.md)
> 关联: 域 10 并发集合(fail-safe 对照);JLS §17(并发修改的未定义行为)

## 遍历时修改,为什么抛异常

`for (String s : list) list.remove(s)` 抛 ConcurrentModificationException——生产代码最常见的集合坑。背后的机制是 **modCount 快照比对**: 迭代器创建时记下版本号,每次访问核对,版本变了就抛异常。这篇把 modCount、迭代器检测、安全删除、以及 fail-fast vs fail-safe 讲清楚。

## 1. "modCount 是什么" — 结构性修改计数器

### 1.1 一个计数器字段

`modCount` 定义在 `AbstractList`(`AbstractList.java:628`):

```java
// AbstractList.java:628
protected transient int modCount = 0;
```

**结构性修改**(add/remove/clear 改变元素个数)每次 +1——ArrayList 的 `add`(`ArrayList.java:499` 的 `modCount++`)与 `fastRemove`(`ArrayList.java:670` 的 `modCount++`)都在递增。

### 1.2 只统计结构性修改

**`set`/覆盖元素不算**——元素个数没变。所以迭代器允许遍历中改值,禁止增删。这个区分是语义核心: modCount 的目的是**检测**结构性变化,不是防并发(无同步,非线程安全工具)。

关键设计(斜体):*modCount 只统计"结构性修改"(数量变化),set 不算——迭代器遍历中改值安全、增删抛异常。面试"modCount 线程安全吗": 不,它是 fail-fast 的弱检测;并发修改的正确姿势是域 10 的并发容器。*

## 2. "迭代器怎么检测" — expectedModCount 快照

### 2.1 迭代器内部

`ArrayList.Itr`(`ArrayList.java:983-988`):

```java
// ArrayList.java:983-988(截取核心,逐字)
private class Itr implements Iterator<E> {
    int cursor;       // index of next element to return
    int lastRet = -1; // index of last element returned; -1 if no such
    int expectedModCount = modCount;
    ...
```

三个字段: **cursor**(下一个要返回的下标)、**lastRet**(上一个返回的下标)、**expectedModCount**(modCount 的**创建时快照**)。

### 2.2 next 的检查

`next()`(`ArrayList.java:996-1010`)第一步就是 `checkForComodification()`,定义在(`ArrayList.java:1041-1044`):

```java
// ArrayList.java:1041-1044(截取核心,逐字)
final void checkForComodification() {
    if (modCount != expectedModCount)
        throw new ConcurrentModificationException();
}
```

**快照比对**: 任何结构性修改(本线程或其他线程)都让 modCount 失配 → 抛 CME。

### 2.3 增强 for 的底层

`for (String s : list)` 被 javac 编译成 **Iterator + hasNext/next 循环**——所以增强 for 里增删也会触发同一检查。

关键设计(斜体):*快照比对 = "创建时锁定版本号"——任何结构性修改都使版本号失配。fail-fast 是"尽早失败"哲学: 宁可抛异常也不产生不可预期的遍历结果。面试"删除的正确姿势": `it.remove()`(迭代器同步更新快照)/`list.removeIf()`(JDK8+,内部用迭代器)/倒序删。*

## 3. "迭代器 remove 为什么安全" — 同步更新快照

### 3.1 remove 的知情同步

`Itr.remove`(`ArrayList.java:1008-1024`):

```java
// ArrayList.java:1008-1024(截取核心,逐字)
public void remove() {
    if (lastRet < 0)
        throw new IllegalStateException();
    checkForComodification();

    try {
        ArrayList.this.remove(lastRet);
        cursor = lastRet;
        lastRet = -1;
        expectedModCount = modCount;
    } catch (IndexOutOfBoundsException ex) {
        throw new ConcurrentModificationException();
    }
}
```

关键在最后一行: **`expectedModCount = modCount` 重新同步**(`ArrayList.java:1020`)——迭代器自己触发了修改,知道版本变了,把快照对齐。而 `list.remove(s)` 是外部修改,迭代器不知情 → CME。

### 3.2 ListItr

`ListItr`(`ArrayList.java:1050`)扩展 Itr 实现 ListIterator: 增加 `add`/`set`/`previous`——双向遍历的迭代器。

关键设计(斜体):*"安全删除"的本质: 迭代器是**知情者**——它自己触发修改并同步版本;外部修改迭代器不知情 → CME。"知情/不知情"的区分是 fail-fast 设计的核心。面试"List 迭代器 vs 集合 foreach": foreach 编译为迭代器;removeIf 是迭代器+谓词的封装。*

## 4. "fail-fast vs fail-safe" — 并发容器对照

### 4.1 两类迭代语义

| | fail-fast | fail-safe(弱一致) |
|---|---|---|
| 代表 | ArrayList/HashMap | ConcurrentHashMap/CopyOnWriteArrayList |
| 遍历时修改 | 抛 CME | 不抛,但可能读不到最新值 |
| 哲学 | 尽早失败 | 容忍滞后 |

### 4.2 CopyOnWriteArrayList 的快照

`CopyOnWriteArrayList` 的迭代器(`COWIterator`)持有**创建时的数组引用**(`CopyOnWriteArrayList.java:1079` 的 `snapshot` 字段)——之后的修改生成新数组,迭代器继续读旧快照,**修改不反映**。

关键设计(斜体):*"不抛异常"不等于"更正确"——fail-safe 牺牲一致性换取并发安全。面试正确表述: fail-fast=及时报错,弱一致=容忍滞后。生产选择: 并发写多读少用 ConcurrentHashMap(域 10 并发集合)。*

跨层标注: [JLS §17: 非线程安全集合的并发修改属未定义行为——fail-fast 只是"尽早暴露"的检测,不是正确性保证]

## 核心悬念

集合都讲完了,但**数组操作**——排序、查找、拷贝——`Arrays` 类 8906 行藏着什么?对象排序为什么用 TimSort 而基本类型用双轴快排?`binarySearch` 有什么前置条件?——下一篇: Arrays 工具与排序。

> → [08-collections/05 — Arrays 工具与排序](05-arrays-sort.md)
