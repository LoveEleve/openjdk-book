# 01. ConcurrentHashMap 存储与读写 — CAS 三操作、putVal、无锁读

> **前置依赖**: [09-map-hash/01 — HashMap 结构](../09-map-hash/01-hashmap-structure.md)(桶数组与链表/树)、[13-atomic/01 — 原子与 CAS](../13-atomic/01-atomicinteger-cas.md)(CAS 基础)
> → **后续**: [02-resize-count.md](02-resize-count.md)
> 关联: [12-lock-sync/01 — synchronized](../12-lock-sync/01-synchronized.md)(桶级锁)

## CHM 怎么并发

这一域进入并发集合。第一篇先看必考题: `ConcurrentHashMap` 为什么能做到**读基本无锁、写部分无锁、冲突时再锁桶**。

## 1. "CHM 的结构" — 与 HashMap 的差异

### 1.1 三个关键改动

- `ConcurrentHashMap.java:778` — `transient volatile Node<K,V>[] table` —— **volatile 桶数组**
- `TREEIFY_THRESHOLD = 8`(`:545`)——和 HashMap 一样,链表过长时转树
- 三种特殊节点: `MOVED = -1`(`:591`)/`TREEBIN = -2`(`:592`)/`RESERVED = -3`(`:593`)

### 1.2 Node 的并发字段

```java
// ConcurrentHashMap.java:625-629(截取,逐字)
    static class Node<K,V> implements Map.Entry<K,V> {
        final int hash;
        final K key;
        volatile V val;
        volatile Node<K,V> next;
```

这里和大纲容易看错的地方有两个:

- `key`/`hash` 是 `final`
- `val`/`next` 是 **volatile**,不是 `final`

这意味着 CHM 读路径的安全性不是"全部 final 发布",而是 **final + volatile 组合**。

关键设计(斜体):*"volatile table + 特殊节点"是 CHM 的骨架——volatile 让桶引用与链路可见;MOVED/TREEBIN/RESERVED 三个负 hash 标记驱动扩容/树/占位。面试"CHM 结构": Node[] + 三种特殊节点。*

## 2. "CAS 三操作" — 桶的原子访问

### 2.1 三个原子原语

| 方法 | 锚点 | 作用 |
|------|------|------|
| `tabAt(tab, i)` | `:759` | acquire 读桶 |
| `casTabAt(tab, i, c, v)` | `:763` | CAS 换桶 |
| `setTabAt(tab, i, v)` | `:768` | release 写桶 |

### 2.2 三级并发策略

- **读**: `tabAt` 直接 acquire 读
- **空桶写**: `casTabAt` 直接 CAS 插入
- **非空桶写**: 进入 `synchronized (f)` 桶级锁区

面试"CHM 无锁在哪": 读(volatile) + 空桶插入(CAS),非空桶才加锁。

关键设计(斜体):*"读用 acquire、空桶写用 CAS、非空桶写在锁内"——桶级并发的三级策略。面试"CHM 无锁在哪": 读(acquire)+ 空桶插入(CAS),非空桶才加锁。*

## 3. "putVal 的完整流程" — 空桶 CAS、满桶锁

### 3.1 初始化与三分支

`putVal` 在 `ConcurrentHashMap.java:1010` 起。核心流程:

1. table 为空 → `initTable()`(`:2283`)初始化
2. 空桶 → `casTabAt(tab, i, null, new Node(...))`(`:1019`)——**无锁插入**
3. `f.hash == MOVED` → `helpTransfer(tab, f)`(`:1023`)——协助扩容
4. 非空普通桶 → `synchronized (f)`(`:1031`)——桶级锁,链表遍历/尾插
5. 树桶 → `putTreeVal`(`:1055`)
6. 链长达到阈值 → `treeifyBin`(`:1068`)
7. 最后 `addCount`(`:1075`)

### 3.2 为什么锁首节点

锁对象不是整个 map,也不是 segment,而是**当前桶首节点 `f`**。这就是 JDK8 CHM 相比 JDK7 分段锁更细的粒度。

面试"JDK7 分段锁 vs JDK8 桶锁": 8 用 CAS + 桶锁,粒度更细、无锁路径更长。

关键设计(斜体):*"空桶 CAS、满桶锁"是 CHM 的并发精髓——锁粒度=桶,且只锁非空桶。面试"CHM 锁粒度": 桶级(JDK8,替代 JDK7 分段锁)。*

## 4. "get 为什么无锁?" — volatile 读链

### 4.1 get 路径

`get` 在 `ConcurrentHashMap.java:934`:

- `spread(key.hashCode())`(`:936`)扩散 hash
- `tabAt(tab, (n - 1) & h)`(`:938`)取桶
- 命中普通节点就遍历 `next`
- 命中负 hash 节点(`eh < 0`)则走 `find`(`:944`)——包括 `ForwardingNode` 转发到新表

整个 `get` **没有加锁**。

### 4.2 为什么安全

安全性来自三层:

- `table` 是 volatile(`:778`)——桶数组引用可见
- `tabAt`/`setTabAt`/`casTabAt` 通过 Unsafe 进行 acquire/release/CAS 访问(`getObjectAcquire`/`putObjectRelease`/`compareAndSetObject`——`:760/:769/:765`)
- `Node` 的 `key`/`hash` 是 final,`val`/`next` 是 volatile(`:627-629`)——已发布节点对读者可见

所以 CHM 的读不是"强一致",而是**弱一致但内存安全**: 可能读不到刚写入的最新值,但不会读到破坏结构的中间态。

面试"CHM get 要锁吗": 不要;面试"CHM 读一致性": 弱一致。

关键设计(斜体):*"final 发布 + volatile 链路"让读路径完全无锁——读者看到的是某个时刻合法的桶状态,而不是加锁后的全局一致快照。面试"CHM get 要锁吗": 不要(弱一致但安全)。*

## 核心悬念

put 时会遇到 `MOVED`——**扩容怎么并发**?`sizeCtl` 怎么当"指挥旗"?`transfer` 怎么让其他线程"搭把手"?`CounterCell` 怎么统计百万并发写入?——下一篇: 扩容与计数。

> → [02-resize-count.md](02-resize-count.md)