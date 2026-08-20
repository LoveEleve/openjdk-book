# 01. HashMap 的存储与哈希 — table、扰动、寻址、put/get 全流程

> 🔴 Deep | 域 09 Map 与哈希第 1 篇 | Layer 3
> 读者处境: 面试"HashMap 底层结构/put 过程/为什么 2 的幂"三连问——从 hash() 到 putVal 的逐行解读。

### 1. "hash() 为什么扰动？" — 高位异或

场景: `hash = key.hashCode() ^ (key.hashCode() >>> 16)` — 为什么折腾?

- `HashMap.java:338` `static final int hash(Object key)`: `(key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16)`
- 动机: 数组寻址只用低位(`(n-1) & hash`),**hashCode 的高位信息在低位没有体现时,低位相同的高冲突**——右移 16 异或把高位混入低位
- 适用: 对象 hashCode 分布差(String 的 31 倍乘已不错,但自定义 hashCode 可能低位相同)
- 关键设计 (斜体): *"扰动函数"是"低成本分布优化"——一次移位异或 O(1),显著改善低位碰撞;面试"hash 为什么要 >>>16"的标准答案: 让高位参与低位计算,减少低位相同导致的碰撞*
- [关联: 域 01 String.hashCode(31 倍乘的分布性);域 08 集合 hash 语义]

### 2. "寻址为什么用 & (n-1)？" — 2 的幂取模

场景: `(n - 1) & hash` 怎么保证下标不越界?

- 前提: **table.length 恒为 2 的幂**(tableSizeFor 保证,`HashMap.java:379`)
- `(n-1) & hash` = `hash % n`(n 为 2 的幂)——位运算比取模快(无除法)
- 容量保证: `tableSizeFor`(`HashMap.java:379`): `-1 >>> Integer.numberOfLeadingZeros(cap-1)` 后 +1——**基于前导零计数的 2 的幂取整**(任意初始容量 → 最近的 2 的幂)
- 关键设计 (斜体): *"2 的幂 + 位与"是哈希表工程惯例——JDK 刻意限制容量为 2 的幂换取快速取模;代价: 只用到低 n 位,所以扰动函数(§1)必须存在——两个设计互相成全*
- 面试: "new HashMap(100) 实际容量多少?"——128(tableSizeFor 取上一位 2 的幂)

### 3. "put 的完整流程" — putVal 逐行

场景: `map.put(key, value)` — 从 hash 到存桶的全过程

- `HashMap.java:607` `put(key, value)` → `putVal`(621):
  1. table 空 → `resize()`(首次 16 或指定容量)
  2. 桶空 → new Node 直接放入(最快路径)
  3. 桶首 key 相同 → 覆盖(比较 hash + equals)
  4. 桶是 TreeNode → `putTreeVal`(634,红黑树插入)
  5. 否则遍历链表 → 找到覆盖 / 尾部新增 → `treeifyBin` 判树化
  6. `++size > threshold` → resize
- `get`(`551`)→ `getNode`(563): 定位桶 → 首节点比较 → 树/链表查找
- 关键设计 (斜体): *put 的复杂度: 平均 O(1)(桶空路径),退化 O(logn)(树)/O(n)(链表);"首节点直接比较"是缓存友好设计(最近插入的最常访问);面试手写 put 流程要按 6 步答全*
- 面试: "hash 相同(碰撞)怎么处理?"——链地址法(同桶链表)+ 树化(§2)

### 4. "Node 与 equals 语义" — 键的比较

场景: 自定义对象做 key 的注意事项——HashMap 怎么判断"同一个 key"?

- 判断条件: **hash 相同 AND equals 相同**(`HashMap.java:563` getNode 内比较)
- 关键: equals 相等 ⇒ hashCode 必相等(域 01 契约)——**违反契约的 key 直接导致 HashMap 失效**
- key 为 null 允许(hash 返回 0,进 0 桶)
- 关键设计 (斜体): *HashMap 正确性完全依赖键的 hashCode/equals 契约(域 01)——可变 key 修改字段后 hash 变 → 对象"丢"(域 11 已讲过同类问题);生产规范: key 用不可变对象(String/Integer)*
- 面试: "HashMap 的 key 能用可变对象吗?"——能但不该(改了 equals 就找不到了)

---

### 核心悬念

哈希桶满了怎么办?——**扩容**。resize 一次扩多少?rehash 时元素怎么搬?(e.hash & oldCap)==0 判断了什么?为什么说 JDK8 的扩容解决了 JDK7 的"环链死循环"?——下一篇: 扩容与树化。

> → [02-resize-treeify.md](02-resize-treeify.md)
