# 04. Map 家族与选型 — WeakHashMap/IdentityHashMap/EnumMap/Hashtable

> **前置依赖**: [09-map-hash/01 — HashMap 存储](01-hashmap-storage-hash.md)、[09-map-hash/02 — 扩容与树化](02-resize-treeify.md)、[11-thread-threadlocal/02 — ThreadLocal](../11-thread-threadlocal/02-threadlocal.md)(弱引用语义对照)
> → **后续**:域 13 原子类(13-atomic 系列,CAS 封装,下一篇)
> 关联: 域 10 并发集合(ConcurrentHashMap)

## 四种特种 Map

HashMap/LinkedHashMap/TreeMap 是主流,但 Map 家族还有"特种兵": **WeakHashMap**(弱 key 自动消失)、**IdentityHashMap**(== 比较)、**EnumMap**(数组直存)、**Hashtable**(历史遗留)。这篇讲清各自的语义、实现与陷阱,最后给完整选型矩阵。

## 1. "WeakHashMap 的 key 会消失" — 弱引用语义

### 1.1 弱 key + 引用队列

`WeakHashMap`(`java/util/WeakHashMap.java`,1340 行)的核心(`WeakHashMap.java:703`/`180`):

```java
// WeakHashMap.java:703(截取核心,逐字)
private static class Entry<K,V> extends WeakReference<Object> implements Map.Entry<K,V> {
    V value;
    final int hash;
    ...
```

- **key 是弱引用**(Entry extends WeakReference)——key 无强引用时被 GC 回收
- **value 仍是强引用**(Entry 的 V value 字段)
- `ReferenceQueue`(`WeakHashMap.java:180`):GC 回收 key 后入队
- `expungeStaleEntries`(`WeakHashMap.java:317`):处理队列,删除失效 Entry——**put/get 时被动触发**

### 1.2 与 ThreadLocalMap 同构

"key 无强引用时自动删除"——语义与域 11 ThreadLocalMap 完全同构: 弱 key + 被动清理 + **value 泄漏风险**。

**经典陷阱: value 若强引用 key,key 永不回收**——比如 `WeakHashMap<Key, Value>` 的 Value 里存着 Key 引用,Key 永远"可达",弱引用形同虚设。

关键设计(斜体):*WeakHashMap 语义与 ThreadLocalMap 同构(弱 key + 被动清理 + 值泄漏风险)。面试"WeakHashMap vs HashMap": 弱 key 自动清除;陷阱答"value 强引用 key 则永不回收"。生产: 简单缓存/监听器注册用。*

## 2. "IdentityHashMap 用 == 比较" — 引用相等语义

### 2.1 引用相等

`IdentityHashMap`(`java/util/IdentityHashMap.java`,1604 行)用 **== 比较**(System.identityHashCode)——**不调用 equals**。两个"内容相同但不同对象"的 key 是不同键。null key 用 `maskNull`(`IdentityHashMap.java:197`)/`unmaskNull`(`IdentityHashMap.java:204`)占位处理;`get`(`IdentityHashMap.java:327`)按对象身份查找。

### 2.2 实现差异:线性探测

`IdentityHashMap` 是**线性探测数组存储**(`DEFAULT_CAPACITY = 32`(`IdentityHashMap.java:151`),无 Node 链)——**表长恒为 2 的幂**(源码注释原文: "Length MUST always be a power of two",`IdentityHashMap.java:173`),哈希用 `System.identityHashCode` 的变体与 `& (length - 1)` 寻址(`IdentityHashMap.java:296-299`),探测用 `i + 2` 步进(`IdentityHashMap.java:305-307`)——与 HashMap 的链地址完全不同。

应用: 序列化框架(对象引用图去重)、代理管理(按对象身份)。

关键设计(斜体):*IdentityHashMap 回答"对象身份 vs 内容相等"——需要"同一实例"区分时用;实现差异(线性探测)说明它是"为特定语义特化",不是通用容器。面试"IdentityHashMap vs HashMap": == vs equals。*

## 3. "EnumMap 用数组" — 枚举键特化

### 3.1 数组直存

`EnumMap`(`java/util/EnumMap.java`,812 行)的核心(`EnumMap.java:98`/`86`/`91`):

```java
// EnumMap.java:98 + 86 + 91(截取核心,逐字)
private transient Object[] vals;

private final Class<K> keyType;

private transient K[] keyUniverse;
```

- `keyType`:枚举类型;`keyUniverse`:枚举常量数组
- `vals`:**值按枚举 ordinal 存数组**

### 3.2 get:零哈希

`get`(`EnumMap.java:242-245`):

```java
// EnumMap.java:242-245(截取核心,逐字)
public V get(Object key) {
    return (isValidKey(key) ?
            unmaskNull(vals[((Enum<?>)key).ordinal()]) : null);
}
```

**`vals[key.ordinal()]` 直接下标——无哈希无碰撞**,性能最优、内存紧凑。`EnumSet` 同理(位向量)。

关键设计(斜体):*枚举键天然有序且可枚举——数组下标代替哈希,零哈希零冲突。生产: 枚举状态机/配置表用 EnumMap。面试"EnumMap 为什么快": ordinal 数组下标,零哈希零冲突。*

## 4. "Hashtable/Properties 与选型矩阵" — 历史与决策

### 4.1 Hashtable:历史遗留

`Hashtable`(`java/util/Hashtable.java`,1536 行)的两个问题:

- **全方法 synchronized**(`Hashtable.java:378` 的 get/`472` 的 put)——与域 08 Vector 同款问题: 复合操作不安全
- **键值不允许 null**(put 显式检查 value(`Hashtable.java:474`),key 经 `key.hashCode()` 间接拒绝)

### 4.2 Properties

`Properties extends Hashtable<Object,Object>`(`Properties.java:143`)——配置加载(load/store)基于 Hashtable。

### 4.3 选型矩阵

| 需求 | 选型 |
|------|------|
| 无序通用 | HashMap(单线程)/ConcurrentHashMap(域 10 并发) |
| 插入序 / 键排序 | LinkedHashMap / TreeMap |
| 弱 key / 身份 / 枚举键 | WeakHashMap / IdentityHashMap / EnumMap |
| 历史遗留 | Hashtable/Properties(不用于新代码) |

关键设计(斜体):*"一个 Map 解决所有"是错误观念——每种 Map 是"哈希 + 一个特化语义"。面试选型题: 说场景、选结构、讲复杂度——完整答案三要素。面试"Hashtable 为什么不用": 粗粒度同步 + 不支持 null + 复合操作不安全;并发正解 ConcurrentHashMap(域 10)。*

## 核心悬念

Map 的并发版本在哪?——`ConcurrentHashMap` 是面试重头: 它怎么做到"读无锁"?JDK8 改成了什么结构?size 怎么统计?——但理解它需要先掌握 CAS 原语。下一篇按写作顺序是域 13 原子类(先学 CAS),再是域 10 并发集合。

> → 下一篇: 域 13 原子类(13-atomic 系列,CAS 封装)| 域 10 并发集合(ConcurrentHashMap)
