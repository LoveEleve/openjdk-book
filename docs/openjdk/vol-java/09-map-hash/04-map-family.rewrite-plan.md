# 09-map-hash/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `WeakHashMap`、`IdentityHashMap`、`EnumMap`、`Hashtable`。本文聚焦它们的键语义、生命周期语义和存储特化，不展开并发容器实现与 `Properties` 以外的老 API 细节。
> 目标：把“Map 家族与选型”改写成一篇围绕“Map 的差别首先不是性能排行，而是键比较语义、键生命周期以及键空间结构是否可特化” 的机制文章，并在结尾收束出完整选型矩阵。

## 1. 读者困惑

- `WeakHashMap` 为什么会“自己掉数据”，这到底是 bug 还是语义？
- `WeakHashMap` 里的 value 为什么可能反过来把 key 留住？
- `IdentityHashMap` 为什么故意违反 `Map` 的一般契约，用 `==` 比较 key？
- 它为什么还要改成线性探测数组，而不是直接重用 HashMap？
- `EnumMap` 为什么能比 `HashMap` 更快，它到底省掉了什么？
- `Hashtable` 为什么被认为是历史遗留，而 `Properties` 却还在广泛存在？
- 面试真正问“Map 怎么选”时，应该先看什么维度？

## 2. 一句话顿悟

**Map 家族的分化，首先不是“大 O 谁更快”，而是“key 的语义到底是什么”：是会被 GC 清除的弱键、按对象身份比较的实例键、可枚举且稠密的枚举键，还是传统 equals/hashCode 键。JDK 为这些不同语义分别特化了存储结构：弱引用 + 引用队列、线性探测数组、按 ordinal 直下标数组，以及保留历史同步语义的旧哈希表。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖四个“特种 Map”的主用途与陷阱。
- 已指出 WeakHashMap 与 ThreadLocalMap 的弱键同构关系。
- 已提到 IdentityHashMap 是 `==` 比较且底层线性探测，EnumMap 是 ordinal 数组直存，Hashtable 是旧式同步哈希表。

### 必须重写

- 旧稿像百科条目，需要先建立总问题：Map 选型先看键语义，而不是先看性能数字。
- `WeakHashMap` 应更明确地区分“自动移除是正常语义”与“value 反引 key 会让弱键失效”。
- `IdentityHashMap` 需要强调它不是通用 Map 替代品，而是为了对象身份语义专门违反一般契约。
- `EnumMap` 需要把“枚举空间已知且稠密”讲成为何能数组直存的前提。
- `Hashtable` 不应只被简单打成“老旧”，要说明它保留的是 `synchronized` + 非 null 契约 + 老式 rehash 路径。

## 4. 理解路径

### 第一节：先建立总问题——Map 家族首先是键语义的分流

从四个问题开场：
- key 会不会被 GC 回收？
- key 是按对象身份还是按内容相等比较？
- key 的全集是否固定且可枚举？
- 你是否在和历史同步/配置 API 打交道？

目标：让读者知道“Map 怎么选”先看语义，再看复杂度。

### 第二节：WeakHashMap 为什么允许 key 自己消失

证据：
- `WeakHashMap.java:37-45`：weak keys 语义
- `WeakHashMap.java:86-103`：value 强引用导致 key 不回收的实现说明
- `WeakHashMap.java:178-180`：`ReferenceQueue`
- `WeakHashMap.java:315-344`：`expungeStaleEntries`
- `WeakHashMap.java:395-406`：`get()` 先 `getTable()` / 触发清理

主线：
- Entry 持有的是 weak key，不是强 key。
- key 被 GC 清掉后，真正从表里摘除通常发生在后续访问触发的清理流程中。
- 这与 ThreadLocalMap 的弱 key + 被动清理心智一致。
- 若 value 强引用自己的 key，弱引用语义会被绕穿。

### 第三节：IdentityHashMap 为什么故意用 `==`

证据：
- `IdentityHashMap.java:37-50`：reference-equality 与“不是通用 Map”警告
- `IdentityHashMap.java:120-125`：linear probing 注释
- `IdentityHashMap.java:192-205`：`NULL_KEY` / `maskNull` / `unmaskNull`
- `IdentityHashMap.java:296-307`：`hash` / `nextKeyIndex`
- `IdentityHashMap.java:327-339`：`get`
- `IdentityHashMap.java:422-439`：`put`

主线：
- 这里的“相等”定义不是内容相等，而是同一对象实例。
- 因为目标语义完全不同，它不该复用 HashMap 的 equals 路线。
- 线性探测数组与交错 key/value 存储，是为对象身份映射这个场景做的结构选择。

### 第四节：EnumMap 为什么能做到“零哈希”

证据：
- `EnumMap.java:31-38`：specialized map + internal arrays
- `EnumMap.java:86-98`：`keyType` / `keyUniverse` / `vals`
- `EnumMap.java:133-137`：构造时按 keyUniverse 分配数组
- `EnumMap.java:242-245`：`get`
- `EnumMap.java:263-271`：`put`

主线：
- 前提不是“枚举很特殊”，而是“所有可能 key 已知且天然有稳定 ordinal”。
- 所以不用哈希分桶，直接 `vals[ordinal]` 就能定位。
- 这同时解释了它为什么快、为什么紧凑、为什么要求所有 key 来自同一枚举类型。

### 第五节：Hashtable 为什么仍存在，但不再是新代码答案

证据：
- `Hashtable.java:112-118`：推荐用 HashMap / ConcurrentHashMap 替代
- `Hashtable.java:378-388`：`get` synchronized
- `Hashtable.java:406-433`：`rehash`
- `Hashtable.java:472-489`：`put` synchronized + value null 检查

主线：
- 它保留的是 Java 早期同步哈希表语义：方法级同步、开放链、非 null key/value。
- `rehash` 走的是老式取模扩容，不是 HashMap 的 2 的幂位掩码体系。
- 它今天继续重要，更多是因为 `Properties` 这类历史 API 仍建立在它之上，而不是因为它是推荐容器。

### 第六节：把四者放进一个统一选型坐标系

按语义分类：
- 一般内容相等键：HashMap / LinkedHashMap / TreeMap / ConcurrentHashMap
- 会被 GC 淘汰的键：WeakHashMap
- 按对象实例区分：IdentityHashMap
- 枚举全集已知：EnumMap
- 历史同步/配置兼容：Hashtable / Properties

强调：先看键语义与生命周期，再看是否需要顺序、并发、范围查询。

## 5. 失败方案清单

1. 用 WeakHashMap 做“强缓存”，却不了解 key 会被 GC 清除。
2. 让 WeakHashMap 的 value 强引用 key，导致弱键根本回收不掉。
3. 把 IdentityHashMap 当成普通 HashMap 替代，期待内容相等对象合并为一个键。
4. 在枚举键场景仍使用 HashMap，错过 EnumMap 的零哈希路径。
5. 新代码继续选择 Hashtable，只因为“它线程安全”。
6. 把 Properties 当成一般类型安全 Map 使用，忽略其 Hashtable/Object,Object 历史包袱。

## 6. 误解清单

1. WeakHashMap 丢数据说明 GC 把 Map 搞坏了；其实这就是它的设计语义。
2. IdentityHashMap 只是更快的 HashMap；它连相等语义都变了。
3. EnumMap 快是因为枚举数量少；真正原因是已知键空间可数组直存。
4. Hashtable 线程安全就意味着适合现代并发场景。
5. 一个通用 Map 足以覆盖所有键语义场景。

## 7. 证据清单

- `WeakHashMap.java:37-45`：weak keys 语义
- `WeakHashMap.java:86-103`：value 反引 key 风险
- `WeakHashMap.java:178-180`：`ReferenceQueue`
- `WeakHashMap.java:315-344`：`expungeStaleEntries`
- `WeakHashMap.java:395-406`：`get`
- `IdentityHashMap.java:37-50`：reference equality / 非通用 Map
- `IdentityHashMap.java:120-125`：linear probe 注释
- `IdentityHashMap.java:192-205`：null key 占位
- `IdentityHashMap.java:296-307`：`hash` / `nextKeyIndex`
- `IdentityHashMap.java:327-339`：`get`
- `IdentityHashMap.java:422-439`：`put`
- `EnumMap.java:31-38`：specialized map + arrays
- `EnumMap.java:86-98`：`keyType` / `keyUniverse` / `vals`
- `EnumMap.java:133-137`：按 keyUniverse 分配数组
- `EnumMap.java:242-245`：`get`
- `EnumMap.java:263-271`：`put`
- `Hashtable.java:112-118`：推荐替代方案
- `Hashtable.java:378-388`：`get`
- `Hashtable.java:406-433`：`rehash`
- `Hashtable.java:472-489`：`put` + null 限制

## 8. 版本与边界

- 基于 JDK 11。
- 不展开 `Properties` 的完整 load/store 协议，只把它作为 Hashtable 仍存在的重要历史原因。
- 不展开 `ConcurrentHashMap` / `ConcurrentSkipListMap`，只作为后续并发生态路标。
- 不在本篇做内存模型与 GC 深入分析，WeakHashMap 只讲足以指导选型的弱引用语义。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“WeakHashMap 解决弱键生命周期、IdentityHashMap 解决对象身份相等、EnumMap 利用枚举稠密键空间做数组直存、Hashtable 保留早期同步哈希表语义；Map 选型先看键语义和生命周期，再看顺序与并发”。
- 必须明确 WeakHashMap 的 value 反引 key 风险。
- 必须明确 IdentityHashMap 不是通用 Map 替代品。
- 必须把 EnumMap 的优势建立在 ordinal 直下标上，而不是泛泛说‘更快’。
- 结尾要自然引到域 13 / 域 10 的并发相关内容。
