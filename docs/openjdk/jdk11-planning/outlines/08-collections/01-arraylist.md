# 01. ArrayList 与动态数组 — elementData、1.5x 扩容、默认容量

> 🔴 Deep | 域 08 集合框架第 1 篇(巨型域 6 篇之一)| Layer 2
> 读者处境: 面试"ArrayList 扩容机制"是必考题——从 elementData 到 grow,再到与域 01 StringBuilder 扩容的对照,一次讲透。

### 1. "ArrayList 内部是什么？" — Object[] 与懒分配

场景: `new ArrayList()` 和 `new ArrayList(100)` 的存储差异——默认构造真的分配 10 个格子吗?

- `ArrayList.java:136` — `transient Object[] elementData` — 存储本体
- `ArrayList.java:143` — `private int size` — 逻辑大小(≠数组长度)
- `ArrayList.java:116` — `DEFAULT_CAPACITY = 10` — **不是默认构造就分配 10**!`new ArrayList()` 用共享空数组 `DEFAULTCAPACITY_EMPTY_ELEMENTDATA`,**首次 add 才扩容到 10**(懒分配,省内存)
- `ArrayList.java:458` `get(int)` — O(1) 随机访问(数组下标);越界抛 IndexOutOfBoundsException
- 关键设计 (斜体): *懒分配: 默认构造不分配数组(空数组共享)——大量空 ArrayList 零堆开销;capacity(数组长度)与 size(元素数)分离是动态数组的语义核心*
- 面试: "new ArrayList(0) vs new ArrayList()"——前者直接用空数组(不懒扩),后者首次 add 扩到 10

### 2. "扩容一次扩多少？" — 1.5x 与溢出保护

场景: add 触发扩容时,新数组多大?为什么是 1.5 倍?

- `ArrayList.java:497` `add(E)` → `grow()`(`ArrayList.java:237/242`)→ `newCapacity`(`255`)
- `ArrayList.java:258` — `int newCapacity = oldCapacity + (oldCapacity >> 1);` — **1.5x**(右移一位取半,无乘法)
- 溢出保护: `MAX_ARRAY_SIZE = Integer.MAX_VALUE - 8`(`ArrayList.java:228`)→ `hugeCapacity` 抛 OOME;`minCapacity < 0` 也是溢出(255-270)
- 与域 01 对照: StringBuilder 是 `(old << 1) + 2`(2x),ArrayList 是 1.5x——**增长因子是取舍**: 2x 扩容次数少但峰值浪费大;1.5x 均摊 O(1) 且内存浪费小(经典"growth factor"研究结论)
- 关键设计 (斜体): *扩容均摊复杂度 O(1): 每次扩容复制 n 个元素,但只有 1/n 的 add 触发——几何级数求和;面试推导"均摊 O(1)"是加分项*
- `Arrays.copyOf` 复制(237-240,内部 System.arraycopy,域 03)
- [C++: System.arraycopy 的 JVM stub 实现(内部卷 23-stub-routines 02-arraycopy,已核实篇目存在)]
- 面试: "预分配"——`new ArrayList<>(预估大小)` 避免多次扩容(生产规范)

### 3. "remove 怎么删？" — fastRemove 与缩容

场景: 循环 remove 百万元素——为什么慢?为什么"倒着删"?

- `ArrayList.java:535` `remove(int)` → `fastRemove`(`669`): 把尾部元素整体前移 `System.arraycopy`(O(n))
- **remove 不缩容**——数组长度只增不减(避免频繁 resize;容量过剩是删除场景的内存代价)
- `trimToSize` 手动缩容(大数组一次性清空后)
- 关键设计 (斜体): *"删除 = 移动元素"决定了 ArrayList 的适用边界: 头部删除 O(n)、尾部删除 O(1);迭代器 remove 有 modCount 协同(第 4 篇)*
- 面试: "ArrayList vs LinkedList 增删谁快?"——尾部都 O(1)(摊还),**头部/中部 LinkedList 快但定位 O(n)**;现代结论: ArrayList 几乎总是更好(缓存友好)

### 4. "toArray 与子视图" — 常用操作内部

场景: `list.toArray()` 返回的是内部数组吗?

- `toArray()` — **复制新数组**(防外部改内部);`toArray(T[])` 复用传入数组(容量不够才新建)
- `subList(from, to)` — **视图**(AbstractList.SubList,共享内部数组,结构修改同步父列表)
- `indexOf`/`lastIndexOf` — 线性扫描 O(n);`contains` 用 equals(域 01 契约)
- 关键设计 (斜体): *toArray 的"防御性复制"与 subList 的"视图共享"是两个相反设计——前者防篡改,后者省复制;subList 的 ConcurrentModificationException 来自共享 modCount(第 4 篇)*
- 面试: "subList 能独立增删吗?"——会同步父列表并触发 modCount 检查

---

### 核心悬念

ArrayList 是"数组",LinkedList 是"链表"——**链表结构长什么样?**`Node<E>` 的 prev/next 怎么串?为什么 LinkedList 的"中间插入"其实没那么快?——下一篇: LinkedList/Vector/Stack。

> → [02-linkedlist-vector.md](02-linkedlist-vector.md)
