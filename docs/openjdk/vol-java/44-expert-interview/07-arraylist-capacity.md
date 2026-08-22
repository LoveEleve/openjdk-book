# ArrayList 为什么默认容量是 10、扩容为什么是 1.5 倍？

> 适用：Java 技术专家 / 高级工程师面试
> 关联正文：`08-collections/01-arraylist`
> 版本边界：下文引用的 `ArrayList.java` 行号均为 JDK 11 源码，不同版本可能不同。

## 题目

ArrayList 默认容量为什么是 10？扩容为什么是 1.5 倍而不是 2 倍？构造时到底有没有分配数组？

## 常见答法

> 默认容量是 10，扩容是 1.5 倍，构造时分配了长度为 10 的数组。

三个断言里，只有"扩容是 1.5 倍"在 JDK 11 是对的，另外两个要么过时要么不精确。这个问题的陷阱在于：**JDK 11 的 ArrayList 构造时根本不分配数组，`DEFAULTCAPACITY_EMPTY_ELEMENTDATA` 是一个空数组，第一次 add 时才真正扩容。** 只答"默认 10"，面试官如果追问"那构造时到底有没有数组"，就会卡住。

## 追问一：构造时到底有没有数组？

> 答：JDK 11 里，`new ArrayList<>()` 把 `elementData` 赋为一个空数组（`DEFAULTCAPACITY_EMPTY_ELEMENTDATA`，`ArrayList.java:128`），不是长度为 10 的数组。

对。JDK 7 及之前，构造时确实分配了 `new Object[10]`。JDK 8 起改成了"延迟分配"——第一次 add 时，`grow()` 方法发现 `elementData` 还是空数组，才按 `DEFAULT_CAPACITY`（10）扩容。所以"默认容量是 10"说的是"第一次 add 后的容量"，不是"构造时的容量"。

这个改动的原因很直接：**很多 ArrayList 创建后只放几个元素甚至不放元素，构造时先分配 10 个槽位完全浪费。** 延迟分配在这类场景下能省掉空 ArrayList 的数组开销。

## 追问二：扩容为什么是 1.5 倍，不是 2 倍、不是 1.25 倍？

> 答：1.5 倍在"空间浪费"和"扩容次数"之间取了一个平衡。

对。但 1.5 倍的具体计算是 `oldCapacity + (oldCapacity >> 1)`（`ArrayList.java:258`），用右移一位实现除以 2 再加旧值，相当于 1.5 倍。为什么不是 2 倍？因为 2 倍每次扩容后会有大量空闲空间浪费，内存利用率低。为什么不是 1.25 倍？因为 1.25 倍扩得太慢，插入元素多时扩容次数会急剧增加，频繁 `Arrays.copyOf` 的成本反而更高。

1.5 倍是工程上选出来的一个经验值：它让扩容次数在 O(log n) 级别，同时每次扩容后保留约 33% 的空闲空间，在大多数场景下空间和时间都相对均衡。

## 追问三：那 1.5 倍扩容会不会有溢出风险？

> 答：有，JDK 11 有溢出保护。

`newCapacity` 方法在计算 `oldCapacity + (oldCapacity >> 1)` 后，如果超过 `MAX_ARRAY_SIZE`（`Integer.MAX_VALUE - 8`），会退到 `hugeCapacity` 逻辑。如果 `minCapacity` 已经超过 `MAX_ARRAY_SIZE`，才允许直接取 `Integer.MAX_VALUE`。这是典型的"溢出感知"写法，用 `newCapacity - minCapacity <= 0` 来判断是否真的需要兜底，而不是直接用 `if` 比较数值。

## 源码证据

- `DEFAULT_CAPACITY = 10`（`ArrayList.java:116`）——默认容量，但不是构造时分配的
- `DEFAULTCAPACITY_EMPTY_ELEMENTDATA = {}`（`:128`）——空数组，首次 add 才扩容
- `elementData` 是 `transient Object[]`（`:136`）——底层数组，延迟分配
- `newCapacity` 公式（`ArrayList.java:255-263`）：`oldCapacity + (oldCapacity >> 1)` —— 1.5 倍
- 溢出保护逻辑：`newCapacity - minCapacity <= 0` 时退到 `hugeCapacity`

## 一句话顿悟

**ArrayList 的"默认容量 10"不是构造时分配的，而是第一次 add 时才真正分配的；1.5 倍不是"随便选的"，而是用右移一位实现的、在空间和时间之间取均衡的经验值。** 面试官真正想听的不是你会背"10 和 1.5"，而是你知道"10 是延迟分配"、知道"1.5 是右移一位"、知道"溢出保护"这三个边界。