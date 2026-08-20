# 01. ConcurrentHashMap 存储与读写 — CAS 三操作、putVal、无锁读

> 🔴 Deep | 域 10 并发集合第 1 篇(巨型域 6 篇之一)| Layer 5
> 读者处境: 面试"ConcurrentHashMap 怎么并发"必考——CAS+锁的组合、无锁读的实现。

### 1. "CHM 的结构" — 与 HashMap 的差异

场景: CHM 和 HashMap 结构差在哪?——并发版本的三个关键改动

- `ConcurrentHashMap.java:778` — `transient volatile Node<K,V>[] table` — **volatile 数组**(读无锁的可见性基础)
- `TREEIFY_THRESHOLD = 8`(545,同 HashMap)+ **TreeBin**(hash=-2,树根包装,带读写锁)
- 特殊节点: ForwardingNode(hash=MOVED=-1,扩容转发)/ReservationNode(RESERVED=-3,compute 占位)
- 关键设计 (斜体): *"volatile table + 特殊节点"是 CHM 的骨架——volatile 让读免锁;MOVED/TREEBIN/RESERVED 三个负 hash 标记驱动扩容/树/占位;面试"CHM 结构"——Node[] + 三种特殊节点*
- 对照: 域 09 HashMap 是单线程版;CHM 把"桶数组访问"全部 CAS 化

### 2. "CAS 三操作" — 桶的原子访问

场景: 桶怎么被并发读写?——tabAt/casTabAt/setTabAt

- `ConcurrentHashMap.java:759` `tabAt(tab, i)` — **volatile 读桶**
- `ConcurrentHashMap.java:763` `casTabAt(tab, i, c, v)` — **CAS 换桶**(空桶插入/删除)
- `ConcurrentHashMap.java:768` `setTabAt(tab, i, v)` — 写(锁区内使用)
- 关键设计 (斜体): *"读用 volatile、空桶写用 CAS、非空桶写在锁内"——桶级并发的三级策略;面试"CHM 无锁在哪"——读(volatile)+ 空桶插入(CAS),非空桶才加锁*
- [关联: 域 32 CAS;域 09 桶结构]

### 3. "putVal 的完整流程" — 三分支

场景: `map.put(k, v)` — 并发下怎么安全?

- `ConcurrentHashMap.java:1010` `putVal`:
  1. table 空 → `initTable`(2283,sizeCtl CAS 初始化)
  2. **空桶**: `casTabAt(tab, i, null, new Node(...))`(1018-1019)——**无锁插入**(最热路径)
  3. **MOVED**: `helpTransfer`(1023)— 协助扩容(第 2 篇)
  4. **非空桶**: `synchronized (f)`(1031)— **桶级锁**(首节点加锁): 链表遍历/树插入(putTreeVal 1055)/树化(treeifyBin 1068)
  5. `addCount`(计数,第 2 篇)
- 关键设计 (斜体): *"空桶 CAS、满桶锁"是 CHM 的并发精髓——锁粒度=桶,且只锁非空桶;面试"CHM 锁粒度"——桶级(JDK8,替代 JDK7 分段锁)*
- 面试: "JDK7 分段锁 vs JDK8 桶锁"——8 用 CAS+桶锁,粒度更细、无锁路径更长

### 4. "get 为什么无锁？" — volatile 读链

场景: 并发 put 时 get——怎么保证安全?

- `ConcurrentHashMap.java:934` `get`: `tabAt(tab, (n-1)&h)` volatile 读桶 → 桶内遍历(链表/树)——**全程无锁**
- 安全性: ① volatile table 引用(扩容数组可见)② Node 的 key/value 是 final③ 桶内链表的 next final——**发布安全**(已发布节点不可变)
- MOVED 节点: get 会 `forwardingNode.find`(转发到新表)
- 关键设计 (斜体): *"不可变发布 + volatile 读"让读完全无锁——只要节点构造完成且 final 字段,读者看到的必然一致;面试"CHM get 要锁吗"——不要(弱一致但安全)*
- 面试: "CHM 读一致性"——弱一致(可能读不到刚 put 的);写读不同步等待

---

### 核心悬念

put 时会遇到 MOVED——**扩容怎么并发**?sizeCtl 怎么当"指挥旗"?transfer 怎么让其他线程"搭把手"?CounterCell 怎么统计百万并发写入?——下一篇: 扩容与计数。

> → [02-resize-count.md](02-resize-count.md)
