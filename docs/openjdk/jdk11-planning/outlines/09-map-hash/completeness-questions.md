# 域 09: Map 与哈希 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "HashMap 底层结构/put 流程" — 01 篇 §3(putVal 621/getNode 563)
- [x] "hash 为什么要 >>>16 扰动" — 01 篇 §1(hash 338)
- [x] "为什么 2 的幂/&(n-1)" — 01 篇 §2(tableSizeFor 379)
- [x] "new HashMap(100) 实际容量" — 01 篇 §2(128)
- [x] "resize 过程/(e.hash & oldCap)==0" — 02 篇 §1(712-719)
- [x] "loadFactor 为什么 0.75(泊松)" — 02 篇 §2(249, 注释 183-190)
- [x] "为什么 8 转树/6/64" — 02 篇 §3(259/266/274)
- [x] "JDK7 死循环/JDK8 修复/仍不安全" — 02 篇 §4
- [x] "LinkedHashMap 顺序/LRU" — 03 篇 §1-2(204/209/217/299)
- [x] "TreeMap 红黑树/复杂度/AVL 对比" — 03 篇 §3(123/2254/2218)
- [x] "WeakHashMap 弱 key/值泄漏" — 04 篇 §1(703/180/317)
- [x] "IdentityHashMap == 语义" — 04 篇 §2(197/327)
- [x] "EnumMap 为什么快" — 04 篇 §3(98/242)
- [x] "Hashtable 为什么不用/选型" — 04 篇 §4(378/472)

## 身份 2: 生产工程师
- [x] 预分配避免扩容(容量/0.75)— 02 篇 §2
- [x] LRU 缓存实现 — 03 篇 §2
- [x] 有序范围查询(TreeMap)— 03 篇 §4
- [x] 缓存弱引用语义(WeakHashMap)— 04 篇 §1

## 身份 3: 框架工程师
- [x] 序列化对象图(IdentityHashMap)— 04 篇 §2
- [x] 状态机/枚举配置(EnumMap)— 04 篇 §3
- [x] 配置加载(Properties)— 04 篇 §4

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 HashMap.java:237/244/249/259/266/274/280/338/379/392/403/423/430/453/551/563/607/621/634/712-719/772/1872, LinkedHashMap.java:204/209/217/299/310, TreeMap.java:121/123/288/340/367/533/2218/2237/2254, WeakHashMap.java:180/317/703, IdentityHashMap.java:151/197/327, EnumMap.java:86/91/98/242, Hashtable.java:142/378/472, Properties.java:143/379/874)/关键设计/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 跨层标注说明: 本域纯 Java 算法域,跨层以[关联]为主(域 01/08/10/11/13),写作时按四要素"跨层合理"原则处理

## 身份 5: 完整性缺口检查
- [x] 存储哈希(01)/扩容树化(02)/有序双雄(03)/家族选型(04)四篇覆盖域全部面试主战场
- [x] SortedMap/NavigableMap 接口并入 03 篇 §4
- [x] EnumSet 已在域 08 提及,04 篇 §3 关联
- [x] 未覆盖确认: HashMap 的 keySet/values 视图细节(面试低频)、迭代器语义(域 08 fail-fast 已覆盖)——写作时提及即可
- [x] 二次 review 修正: tableSizeFor 实际为 `-1 >>> Integer.numberOfLeadingZeros(cap-1)` +1(379-382,非"连续移位或运算");泊松分布注释核实(182-198,"8: 0.00000006");IdentityHashMap 线性探测实测(get 的 while true 循环 327-335)+table(175);EnumMap.get 数组下标实测(vals[ordinal],242)
- [x] 验证通过: putVal 六步结构(625/629/631/634/645/661-662)、resize 高低位拆分(712-719)、afterNodeInsertion 淘汰(299)、TreeMap 旋转/修复(2218/2237/2254)
- [ ] 待办: 写作时验证 treeifyBin 精确行号(772 附近)、putVal 的 treeifyBin 调用行、resize 里 threshold 计算细节
