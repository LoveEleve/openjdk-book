# 02. HashMap 的扩容与树化 — resize、阈值、红黑树、JDK8 并发改进

> 🔴 Deep | 域 09 Map 与哈希第 2 篇 | Layer 3
> 读者处境: 面试"HashMap 扩容过程/为什么 8 转树/为什么线程不安全"——resize 与 treeify 是 HashMap 的难点。

### 1. "resize 怎么扩容？" — 2 倍 + 高低位拆分

场景: `++size > threshold` 触发扩容——扩容时每个元素怎么搬?

- `HashMap.java` `final Node<K,V>[] resize()`(678 附近):
  1. 容量 2 倍(newCap = oldCap << 1);threshold 同步翻倍
  2. **逐桶 rehash**: 桶内链表按 `(e.hash & oldCap) == 0` **拆成两条链**(loHead/hiHead,`712-719`)
  3. lo 链留在原下标,hi 链搬到 `原下标 + oldCap`(新容量最高位为 1 的判定)
- 关键设计 (斜体): *JDK8 扩容的精妙: 元素的新位置只可能是"原下标"或"原下标+oldCap"(因为容量翻倍,多出一位)——**用位判断代替重算 hash**,且保持链表顺序(JDK7 头插会反转);一次遍历 O(n) 完成全表搬移*
- 面试: "(e.hash & oldCap)==0 什么意思?"——hash 的新增最高位是 0 → 留原位;是 1 → 搬高位区
- 扩容均摊: 每次扩容搬 n 个,均摊 O(1)(与域 08 ArrayList 同分析)

### 2. "为什么 loadFactor 是 0.75？" — 空间与时间的平衡

场景: 面试"负载因子为什么 0.75"——源码注释说了什么?

- `HashMap.java:249` — `DEFAULT_LOAD_FACTOR = 0.75f`
- 语义: size > capacity × 0.75 → 扩容;threshold = capacity × loadFactor(`HashMap.java:430` 附近)
- 源码注释(183-190 附近): 泊松分布推导——0.75 下桶内出现 8 个元素的概率约 0.00000006(树化阈值 8 的来源)
- 关键设计 (斜体): *0.75 是"空间占用率 vs 碰撞概率"的权衡——过大(如 1.0)桶密碰撞多,过小(0.5)浪费空间;泊松分布(源码注释)给出碰撞概率的数学依据;面试能引"泊松分布注释"是加分项*
- [算法: 泊松分布(源码注释 183-190 的桶内节点数概率推导);关联: 域 10 并发集合(扩容设计的并发演进)]
- 生产: `new HashMap<>(预估容量 / 0.75)` 避免扩容;`MAXIMUM_CAPACITY = 1<<30`(244)

### 3. "为什么 8 转树？" — 树化阈值

场景: 链表什么时候变红黑树?为什么是 8/6/64?

- `HashMap.java:259` — `TREEIFY_THRESHOLD = 8` — **桶内节点数 ≥8 → 转树**
- `HashMap.java:266` — `UNTREEIFY_THRESHOLD = 6` — 扩容拆分后节点 ≤6 → 退树(留缓冲,防反复)
- `HashMap.java:274` — `MIN_TREEIFY_CAPACITY = 64` — **表容量 <64 时先扩容不树化**(树化代价 vs 扩容)
- `treeifyBin`(`HashMap.java:751`): 容量 <64 → resize();否则转 TreeNode 红黑树
- 关键设计 (斜体): *阈值 8 的数学依据(源码注释): 理想 hash 下桶内节点数服从泊松分布,>8 概率亿分之六——树化是"防御哈希碰撞攻击"的兜底(恶意构造同 hash 的 key),不是常规路径;8→6 留 2 的缓冲避免"树↔链"抖动*
- 面试: "为什么不是 16?"——泊松分布推导;面试答"8 是安全阈值+6 防抖动"有区分度

### 4. "HashMap 线程安全吗？" — JDK7 环链与 JDK8 改进

场景: 面试"HashMap 为什么线程不安全"——JDK7 死循环是怎么回事

- JDK7: 多线程并发 resize → 头插法迁移 → **环形链表 → get 死循环**(经典事故)
- JDK8: 尾插法保持顺序 + 高低位拆分——**环链问题已修复**(但仍有数据丢失/覆盖)
- 仍不安全: put 并发覆盖(getNode/putVal 无同步)、size 竞态
- 关键设计 (斜体): *"JDK8 修了死循环"≠"线程安全"——并发写仍丢数据;面试完整答法: ① JDK7 环链机制(头插)② JDK8 尾插修复 ③ 并发仍不安全(覆盖)④ 正解 = ConcurrentHashMap(域 10)*
- 生产: 并发场景禁 HashMap;面试题"HashMap 怎么变安全"——ConcurrentHashMap/Collections.synchronizedMap

---

### 核心悬念

HashMap 无序——但业务要**有序**: 按插入顺序、按访问顺序、按键排序。"LinkedHashMap 的 LRU 怎么实现?""TreeMap 的红黑树保证什么?"——下一篇: LinkedHashMap 与 TreeMap。

> → [03-linkedhashmap-treemap.md](03-linkedhashmap-treemap.md)
