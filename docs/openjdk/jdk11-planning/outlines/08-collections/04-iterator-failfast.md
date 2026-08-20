# 04. 迭代器与 fail-fast — modCount、ConcurrentModificationException

> 🔴 Deep | 域 08 集合框架第 4 篇(巨型域 6 篇之四)| Layer 2
> 读者处境: 生产"遍历时删除抛 ConcurrentModificationException"——modCount 机制是面试高频,也是理解并发容器(域 10)的前置。

### 1. "modCount 是什么？" — 结构性修改计数器

场景: `for (String s : list) list.remove(s)` 为什么抛 CME?

- `AbstractList.java:628` — `protected transient int modCount` — 结构性修改(add/remove/clear 改变元素个数)每次 +1
- ArrayList 的 add(497)→`modCount++`;remove(535)同样递增
- 关键设计 (斜体): *modCount 只统计"结构性修改"(数量变化),**set/覆盖不算**——迭代器允许遍历中改值,禁止增删;它的目的是"检测"而非"防并发"(无同步,非线程安全工具)*
- 面试: "modCount 线程安全吗?"——不,它是 fail-fast 的弱检测;并发修改的正确姿势是域 10 的并发容器

### 2. "迭代器怎么检测？" — expectedModCount 快照

场景: 迭代器每次 next 都检查什么?

- `ArrayList.java:983` `private class Itr implements Iterator<E>` — 内部迭代器(持有游标 cursor + lastRet)
- `ArrayList.java:557`(ListItr 里)`final int expectedModCount = modCount;` — 迭代器**创建时快照**
- `ArrayList.java:564` `checkForComodification`(603 定义)— 每次 next/hasNext 时 `if (modCount != expectedModCount) throw new ConcurrentModificationException()`
- 增强 for 的底层: javac 编译成 `Iterator` + hasNext/next 循环(`Iterable.forEach` 是另一个路径)
- 关键设计 (斜体): *快照比对 = "创建时锁定版本号"——任何结构性修改(本线程/他线程)都使版本号失配;fail-fast 是"尽早失败"哲学: 宁可抛异常也不产生不可预期的遍历结果*
- 面试: "删除的正确姿势"——`it.remove()`(迭代器同步更新 expectedModCount)/ `list.removeIf()`(JDK8+,内部用迭代器)/ 倒序删

### 3. "迭代器 remove 为什么安全？" — 同步更新快照

场景: `it.remove()` 不抛 CME——和 `list.remove` 差在哪?

- 迭代器 remove: 调用 `ArrayList.this.remove(lastRet)` 后 **`expectedModCount = modCount` 重新同步**(Itr.remove 内部)
- `ListIterator`(`ArrayList.java:1050` ListItr)增加 add/set/previous——双向遍历
- 关键设计 (斜体): *"安全删除"的本质: 迭代器是**知情者**——它自己触发修改并同步版本;外部修改迭代器不知情 → CME;这个"知情/不知情"区分是 fail-fast 设计的核心*
- 面试: "List 迭代器 vs 集合 foreach"——foreach 编译为迭代器;`removeIf` 是迭代器+谓词的封装

### 4. "fail-fast vs fail-safe" — 并发容器对照

场景: 面试"ConcurrentHashMap 遍历会抛 CME 吗?"

- fail-fast: ArrayList/HashMap 等(遍历时修改 → CME)
- fail-safe(弱一致): ConcurrentHashMap/CopyOnWriteArrayList——**遍历基于快照或弱一致视图**,不抛 CME,但可能读不到最新值
- CopyOnWriteArrayList 迭代器: 持有创建时的数组引用——修改不反映(快照语义)
- 关键设计 (斜体): *"不抛异常"不等于"更正确"——fail-safe 牺牲一致性换取并发安全;面试正确表述: fail-fast=及时报错,弱一致=容忍滞后;生产选择: 并发写多读少用 ConcurrentHashMap(域 10 详解)*
- [JLS §17: 非线程安全集合的并发修改属未定义行为(fail-fast 只是"尽早暴露"的检测,不是正确性保证)]
- [关联: 域 10 并发集合(WeakHashMap/ConcurrentHashMap 迭代语义)]

---

### 核心悬念

集合都讲完了,但**数组操作**——排序、查找、拷贝——`Arrays` 类 8906 行藏着什么?对象排序为什么用 TimSort 而基本类型用双轴快排?——下一篇: Arrays 工具与排序。

> → [05-arrays-sort.md](05-arrays-sort.md)
