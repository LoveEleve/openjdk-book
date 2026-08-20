# 04. Map 家族与选型 — WeakHashMap/IdentityHashMap/EnumMap/Hashtable

> 🟡 Working | 域 09 Map 与哈希第 4 篇 | Layer 3
> 读者处境: 面试"WeakHashMap 和 HashMap 区别""IdentityHashMap 干什么用"——特种 Map 的语义与陷阱,以及完整选型矩阵。

### 1. "WeakHashMap 的 key 会消失？" — 弱引用语义

场景: `WeakHashMap` 做缓存——key 为什么"自己没了"?

- `WeakHashMap.java:703` — `private static class Entry extends WeakReference<Object>` — **key 是弱引用**(值仍强引用!)
- `WeakHashMap.java:180` — `ReferenceQueue` — GC 回收 key 后入队
- `WeakHashMap.java:317` — `expungeStaleEntries` — 处理队列,删除失效 Entry(put/get 时被动触发)
- 关键设计 (斜体): *"key 无强引用时自动删除"——语义与域 11 ThreadLocalMap 完全同构(弱 key + 被动清理 + 值泄漏风险);陷阱: **value 若强引用 key,key 永不回收**(经典缓存坑);生产: 简单缓存/监听器注册用*
- 面试: "WeakHashMap vs HashMap"——弱 key 自动清除;值泄漏与 ThreadLocal 同款问题(域 11 对照)

### 2. "IdentityHashMap 用 == 比较？" — 引用相等语义

场景: `IdentityHashMap` 什么时候用?——同一个对象的不同出现

- `IdentityHashMap.java:197` `maskNull`(key null 用 NULL_KEY 占位)+ `327` `get`
- **== 比较**(System.identityHashCode)——不调用 equals;两个"内容相同但不同对象"的 key 是不同键
- `IdentityHashMap.java:151` — `DEFAULT_CAPACITY = 32` — **线性探测数组存储**(无 Node 链,容量非 2 的幂,专用哈希)
- 应用: 序列化框架(对象引用图去重)/代理管理(按对象身份)
- 关键设计 (斜体): *IdentityHashMap 回答"对象身份 vs 内容相等"——面试场景: 需要"同一实例"区分时用;实现差异(线性探测)说明它是"为特定语义特化",不是通用容器*
- 面试: "IdentityHashMap vs HashMap"——== vs equals;典型用途(对象图/身份映射)

### 3. "EnumMap 用数组？" — 枚举键特化

场景: 枚举做 key 的最快 Map——为什么能 O(1) 且无哈希?

- `EnumMap.java:98` — `private transient Object[] vals` — **数组直存**(值按枚举 ordinal 存)
- `EnumMap.java:86/91` — keyType(枚举类型)+ keyUniverse(枚举常量数组)
- `get`(242): `vals[key.ordinal()]` 直接下标——**无哈希无碰撞**
- 关键设计 (斜体): *枚举键天然有序且可枚举——数组下标代替哈希;性能最优、内存紧凑;生产: 枚举状态机/配置表用 EnumMap;`EnumSet`(491 行)同理(位向量)*
- 面试: "EnumMap 为什么快?"——ordinal 数组下标,零哈希零冲突
- [关联: 域 08 EnumSet(位运算实现)]

### 4. "Hashtable/Properties 与选型矩阵" — 历史与决策

场景: 面试"Hashtable vs HashMap"—以及"Map 到底怎么选"

- `Hashtable.java:378/472` — **全方法 synchronized**(与域 08 Vector 同款问题: 复合操作不安全)+ 键值**不允许 null**
- `Properties.java:143` — extends Hashtable(配置加载 load/store,379/874)
- 选型矩阵:
  - 无序通用 → HashMap(单线程)/ConcurrentHashMap(域 10 并发)
  - 有序:插入序 → LinkedHashMap;键排序 → TreeMap
  - 弱 key → WeakHashMap;身份 → IdentityHashMap;枚举键 → EnumMap
  - 历史遗留 → Hashtable/Properties(不用于新代码)
- 关键设计 (斜体): *"一个 Map 解决所有"是错误观念——每种 Map 是"哈希 + 一个特化语义";面试选型题: 说场景,选结构,讲复杂度——完整答案三要素*
- 面试: "Hashtable 为什么不用?"——粗粒度同步 + 不支持 null + 复合操作不安全;并发正解 ConcurrentHashMap(域 10)

---

### 核心悬念

Map 的并发版本在哪?——`ConcurrentHashMap` 是面试重头: 它怎么做到"读无锁写分段"?JDK8 改成了什么结构?size 怎么统计?——下一篇按写作顺序是域 13 原子类(先学 CAS 原语),再是域 10 并发集合。

> → 下一篇: 域 13 原子类(13-atomic 系列,CAS 封装) | 域 10 并发集合(ConcurrentHashMap)
