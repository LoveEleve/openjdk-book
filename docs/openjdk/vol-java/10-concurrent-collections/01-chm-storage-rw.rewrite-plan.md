# 10-concurrent-collections/01 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.util.concurrent.ConcurrentHashMap`。本文聚焦 `Node`/`table` 结构、`tabAt`/`casTabAt`/`setTabAt` 三个原子入口、`putVal` 主流程、`get` 无锁读路径，以及 `MOVED`/`TreeBin`/`ReservationNode` 在第一篇中的角色定位；扩容协作与计数细节留给下一篇。
> 目标：把“ConcurrentHashMap 存储与读写”改写成一篇围绕“为什么它不能靠一个全局锁保护 HashMap，而必须把读、空桶写、冲突写拆成三种并发路径”的机制文章。

## 1. 读者困惑

- 为什么 `ConcurrentHashMap` 不能像 `Collections.synchronizedMap(new HashMap<>())` 那样直接靠一把大锁解决并发？
- 为什么大家总说 CHM “读基本无锁”，它到底无锁到什么程度？
- 为什么空桶写入可以 CAS，桶里一旦有节点又要 `synchronized`？
- `Node.val`、`Node.next` 为什么是 `volatile`，而 `key`、`hash` 却是 `final`？
- `get()` 不加锁，怎么避免读到链表断裂、半初始化节点或扩容中的脏状态？
- `MOVED`、`TreeBin`、`ReservationNode` 这些负 hash 特殊节点是干什么的，为什么第一篇要先认识它们？
- JDK 8+ CHM 和 JDK 7 Segment 分段锁到底差别在哪？

## 2. 一句话顿悟

**ConcurrentHashMap 的核心不是“无锁”两个字，而是把并发写路径拆成三档：读路径靠 `volatile` + acquire/release 读到合法快照，空桶写靠 CAS 抢占桶位，只有真正发生桶内冲突时才锁住桶首节点。它不是给整个 map 上一把大锁，而是把同步成本压到碰撞发生的那个局部桶上。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `table`、`Node`、三种特殊节点、`tabAt/casTabAt/setTabAt`、`putVal`、`get` 主路径。
- 已指出 CHM 读路径不加锁、空桶写走 CAS、非空桶写进入 `synchronized (f)`。
- 已把 `MOVED` 留给扩容篇，篇间承接方向是对的。

### 必须重写

- 旧稿太像面试提纲：直接按“结构 / CAS 三操作 / putVal / get”平铺，没有先建立“为什么不能用一把锁”的总问题。
- `Node` 字段语义没有被讲成一套发布协议；`final + volatile` 组合需要回到“读者为何敢无锁遍历”的主问题里。
- 三种并发路径应讲成一张决策图，而不是三条孤立知识点。
- `putVal` 要讲成“线程写入一个 key 时会经历哪些分支选择”，而不是静态背步骤。
- 特殊节点不能只当枚举值背诵，必须让读者先知道它们分别代表“扩容中 / 树桶 / 保留占位”三类桶状态。

## 4. 理解路径

### 第一节：从“全局锁 HashMap”为什么不够开始

用缓存热点场景开场：高并发读多写少，如果整张表只有一把锁，那么读线程也会排队；如果完全不加锁，结构又会被并发写坏。先把问题立住：CHM 需要同时满足“常见读路径别阻塞”和“冲突写时结构别损坏”。

### 第二节：先建立角色图——桶数组、普通节点和三种特殊节点

证据：
- `ConcurrentHashMap.java:545`：`TREEIFY_THRESHOLD`
- `ConcurrentHashMap.java:591-593`：`MOVED` / `TREEBIN` / `RESERVED`
- `ConcurrentHashMap.java:625-629`：`Node<K,V>`
- `ConcurrentHashMap.java:778`：`transient volatile Node<K,V>[] table`

主线：
- 第一层是 `volatile` 的 `table` 桶数组。
- 桶里平时是普通 `Node` 链；也可能出现表示扩容转发的 `ForwardingNode(MOVED)`、表示树桶容器的 `TreeBin(TREEBIN)`、表示占位计算的 `ReservationNode(RESERVED)`。
- 因此 CHM 不是“数组 + 链表”这么简单，而是“桶数组 + 多状态桶入口”。

### 第三节：为什么读敢不加锁——`final + volatile` 的发布协议

证据：
- `ConcurrentHashMap.java:625-629`：`hash/key/val/next`
- `ConcurrentHashMap.java:759-768`：`tabAt/casTabAt/setTabAt`
- `ConcurrentHashMap.java:778`：`table`

主线：
- `key`/`hash` 一旦构造完成就不改，因此用 `final` 固定身份。
- `val`/`next` 可能在并发读写中被观察，因此用 `volatile` 维持可见性。
- 读桶不是普通数组读，而是 `tabAt` 的 acquire 语义；写桶用 CAS 或 release 写。
- 这一套不是“绝对一致快照”，而是“读到某个合法时刻的结构状态，不读到半发布节点”。

### 第四节：三条并发路径为什么要分开

证据：
- `ConcurrentHashMap.java:759`：`tabAt`
- `ConcurrentHashMap.java:763`：`casTabAt`
- `ConcurrentHashMap.java:768`：`setTabAt`

主线：
- 读路径：先看桶，不抢锁。
- 空桶写：没人占坑时直接 CAS 抢桶位。
- 冲突写：一旦桶里已有节点，真正需要同步的是“桶内结构修改”，于是锁桶首节点。
- 这三档路径不是随手优化，而是为了让同步成本只出现在碰撞发生处。

### 第五节：`putVal` 到底怎么决策

证据：
- `ConcurrentHashMap.java:1010-1077`：`putVal`
- `ConcurrentHashMap.java:1019`：空桶 CAS
- `ConcurrentHashMap.java:1023`：`helpTransfer`
- `ConcurrentHashMap.java:1031`：`synchronized (f)`
- `ConcurrentHashMap.java:1055`：`putTreeVal`
- `ConcurrentHashMap.java:1068`：`treeifyBin`

主线：
- table 未初始化则先 `initTable()`。
- 桶空：CAS 直接放入新节点。
- 桶是 `MOVED`：说明正在扩容，本线程先帮忙迁移。
- 桶是普通节点：锁住首节点，在链表里找已有 key 或尾插。
- 桶是树桶：走 `TreeBin` 插入。
- 链长达到阈值才尝试树化；最终再 `addCount`。
- 把“写一个 key”讲成条件分支图，而不是面试背条目。

### 第六节：`get` 为什么无锁却还能追上扩容

证据：
- `ConcurrentHashMap.java:934-952`：`get`
- `ConcurrentHashMap.java:944`：`find`
- `ConcurrentHashMap.java:664`：普通 `Node.find`
- `ConcurrentHashMap.java:2230+` / `2265+`：特殊节点 `find`

主线：
- `get` 先 spread hash、定位桶、优先比较首节点。
- 命中普通链表就沿 `next` 走；命中负 hash 特殊节点则调用多态 `find`。
- 这就是为什么扩容和树桶状态不需要让所有读者先停下来：读者可以根据桶入口类型自己决定后续路径。

### 第七节：第一篇里怎样给下一篇留路标

证据：
- `ConcurrentHashMap.java:1023`：`helpTransfer`
- `ConcurrentHashMap.java:2355`：`helpTransfer` 定义
- `ConcurrentHashMap.java:1068` / `2655+`：`treeifyBin`

主线：
- 这一篇只回答“为什么会看见 MOVED、为什么会进入 helpTransfer、为什么链长会触发树化检查”。
- 真正的扩容协作、`sizeCtl`、`transferIndex`、计数与 `CounterCell` 放到 `02-resize-count.md`。
- 让读者先明白 CHM 读写路径中为什么会突然出现“扩容中”状态，而不是当场讲完全部迁移细节。

## 5. 失败方案清单

1. 用一把全局锁包住整张哈希表，期待它同时满足高并发读和高并发写。
2. 让所有写都只走 CAS，忽略桶内链表/树结构修改需要复合原子性。
3. 让所有读都无条件加锁，结果把读路径也拖进争用。
4. 把 `Node` 全部字段都做成普通字段，还期待无锁读能看到一致结构。
5. 以为 `get()` 无锁就等于线性一致读。
6. 把 `MOVED` 当普通 hash 值，忽略它代表“此桶正在迁移”。
7. 把 JDK 8 CHM 仍然理解成 JDK 7 的 Segment 分段锁实现。

## 6. 误解清单

1. CHM “无锁”意味着写路径也从不加锁。
2. `volatile table` 就足以保证所有节点字段都自动安全发布。
3. 空桶 CAS 和冲突桶加锁只是性能调优，不影响正确性。
4. `get()` 不加锁就可能轻易读到链表中间断裂状态。
5. `MOVED` / `TREEBIN` / `RESERVED` 只是内部魔法常量，对理解主线没意义。
6. CHM 读到旧值就说明实现有 bug；实际它本来就不是全局强一致快照容器。
7. 树化阈值出现了，就说明本文必须把红黑树实现全部讲完。

## 7. 证据清单

- `ConcurrentHashMap.java:545`：`TREEIFY_THRESHOLD`
- `ConcurrentHashMap.java:591-593`：`MOVED` / `TREEBIN` / `RESERVED`
- `ConcurrentHashMap.java:625-629`：`Node<K,V>` 关键字段
- `ConcurrentHashMap.java:664`：普通节点 `find`
- `ConcurrentHashMap.java:759-768`：`tabAt` / `casTabAt` / `setTabAt`
- `ConcurrentHashMap.java:778`：`table`
- `ConcurrentHashMap.java:934-952`：`get`
- `ConcurrentHashMap.java:944`：特殊节点 `find` 分派
- `ConcurrentHashMap.java:1010-1077`：`putVal`
- `ConcurrentHashMap.java:1019`：空桶 CAS
- `ConcurrentHashMap.java:1023`：`helpTransfer`
- `ConcurrentHashMap.java:1031`：桶首节点加锁
- `ConcurrentHashMap.java:1055`：树桶插入
- `ConcurrentHashMap.java:1068`：`treeifyBin`
- `ConcurrentHashMap.java:2355`：`helpTransfer` 定义（下一篇展开）
- `ConcurrentHashMap.java:2655`：`treeifyBin` 定义（下一篇只按需回钩）

## 8. 版本与边界

- 基于 JDK 11。
- 本文讨论的是 JDK 8+ 之后无 Segment 的 CHM 实现，不适用于 JDK 7 分段锁内部结构。
- “读基本无锁”描述的是 Java 层不会在 `get()` 路径上显式进入 `synchronized`；不等于跨线程全局线性一致。
- 树化、扩容协作、计数器分片只在本文立路标，不在第一篇展开完。
- 不把 HotSpot/CPU 内存模型细节扩展成硬件教程，只在 `volatile` 与 acquire/release 语义层面解释到够用为止。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么不能用一把锁 → CHM 的桶数组和多状态桶入口 → `final + volatile` 如何支撑无锁读 → 读 / 空桶写 / 冲突写三档路径 → `putVal` 分支决策 → `get` 如何跟随特殊节点找到数据”。
- 必须把三种并发路径讲成同一套设计，而不是分散知识点。
- 必须解释 `Node` 字段修饰符与无锁读安全性的关系。
- 必须把 `MOVED` / `TREEBIN` / `RESERVED` 讲成桶状态，而不是死记常量。
- 结尾要自然引到 `02-resize-count.md`：为什么扩容能协作、计数为什么不能只靠一个 `size` 字段。
