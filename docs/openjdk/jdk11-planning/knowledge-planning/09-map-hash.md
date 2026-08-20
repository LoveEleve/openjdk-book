# 域 09: Map 与哈希 — 知识规划

> 源码路径: java.base/share/classes/java/util/{Map,SortedMap,NavigableMap,HashMap,LinkedHashMap,TreeMap,WeakHashMap,IdentityHashMap,EnumMap,EnumSet,Hashtable,Properties}.java
> 源码量: 12 文件 / ~15,000 行 | 非巨型域(邻接域 08 集合)
> 写作层: Layer 3(前置: 域 08 集合框架、01 字符串 hashCode)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| HashMap.java (2462) | **容量设计**: DEFAULT_INITIAL_CAPACITY=16(237)/MAXIMUM_CAPACITY=1<<30(244)/tableSizeFor(379,任意容量→2 的幂)/threshold(423)/loadFactor 0.75(249) | High |
| HashMap.java | **哈希与寻址**: hash(338,key.hashCode()^(h>>>16) 扰动)+ 数组寻址 (n-1)&hash(2 的幂取模) | High |
| HashMap.java | **存储结构**: Node(280,单链)/table(392)/size(403)/putVal(621)/getNode(563)/removeNode——链地址法 | High |
| HashMap.java | **树化**: TREEIFY_THRESHOLD=8(259)/UNTREEIFY_THRESHOLD=6(266)/MIN_TREEIFY_CAPACITY=64(274)/TreeNode(1872,红黑树)/treeifyBin | High |
| HashMap.java | **扩容**: resize()——2 倍扩容、rehash 优化(高位判定)、阈值计算 | High |
| LinkedHashMap.java (755) | **顺序保持**: head(204)/tail(209)双向链、accessOrder(217,插入序/访问序)、afterNodeAccess/afterNodeInsertion、removeEldestEntry(299,LRU 钩子) | High |
| TreeMap.java (3012) | **红黑树**: root(123)/comparator(121)、getEntry(340)/getEntryUsingComparator(367)、put(533)+fixAfterInsertion、firstKey(288)、NavigableMap API | High |
| WeakHashMap.java (1340) | **弱 key**: Entry extends WeakReference、queue(180)、expungeStaleEntries(317,被动清理) | High |
| IdentityHashMap.java (1604) | **引用相等**: == 比较而非 equals;线性探测数组(无 Node) | Medium |
| EnumMap.java (812) | **枚举键数组**: 内部 Object[] 直接下标访问 | Medium |
| Hashtable.java (1536) | **旧同步 Map**: synchronized 方法、不可 null | Low |
| Properties.java (1582) | **属性表**: extends Hashtable、load/store 文本格式 | Low |
| EnumSet.java (491) | 枚举集合位运算(Regular/None) | Low |

*13 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | HashMap 哈希与寻址 | 3 (HashMap/hash/Node) | 面试必考(hash 扰动/寻址/2 的幂) |
| P1 | 扩容与树化 | 2 (HashMap) | 面试必考(扩容过程/为什么 8 转树) |
| P1 | TreeMap 红黑树 | 1 | 面试高频(有序性/复杂度) |
| P1 | LinkedHashMap 顺序 | 1 | 面试高频(LRU) |
| P2 | WeakHashMap/IdentityHashMap/EnumMap | 3 | 面试偶尔(各自主语) |
| P3 | Hashtable/Properties/EnumSet | 3 | 历史/使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | HashMap 哈希与寻址 | 面试必考(hash 扰动原因/为什么 2 的幂/为什么 loadFactor 0.75) |
| 🔴 Deep | 扩容与树化 | 面试必考(resize 流程/树化阈值/为什么 8/红黑树) |
| 🔴 Deep | TreeMap 红黑树 | 面试高频(为什么用红黑树/复杂度保证) |
| 🔴 Deep | LinkedHashMap LRU | 面试高频(LRU 实现/accessOrder) |
| 🟡 Working | WeakHashMap 弱 key | 面试常问(泄漏/缓存) |
| 🟡 Working | 其他 Map | 使用层选型 |
| 🟢 Surface | Hashtable/Properties | 历史类 |

## 04 聚类

### 依赖图(域内)
```
Map(接口) ←── AbstractMap ←── HashMap ←── LinkedHashMap(顺序链)
                              ←── TreeMap(红黑树,独立实现)
                              ←── WeakHashMap(弱引用)
                              ←── IdentityHashMap(引用相等)
                              ←── EnumMap(数组)/Hashtable(同步,旧)
HashMap ──使用── 域 01 String.hashCode
```

### 教学顺序与文章拆分(4 篇)

1. **HashMap 的存储与哈希** — Node/table、hash 扰动、寻址、putVal/getNode 全流程、tableSizeFor
2. **HashMap 的扩容与树化** — resize 2 倍扩容、rehash 高位判定、0.75 阈值推导、8/6/64 树化规则、JDK7→8 并发改进
3. **LinkedHashMap 与 TreeMap** — 插入/访问序、LRU(removeEldestEntry)、红黑树结构、有序 API
4. **Map 家族与选型** — WeakHashMap(泄漏)/IdentityHashMap/EnumMap/Hashtable/Properties、选型矩阵

> 前置: 域 08 集合(Collection 契约)、01(String hashCode 语义)。跨层: 无 native(纯 Java);红黑树算法细节不展开源码级
