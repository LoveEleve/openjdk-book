# 06. Collections 工具与包装器 — 防御编程三件套、算法工具

> 🟢 Surface | 域 08 集合框架第 6 篇(巨型域 6 篇之六)| Layer 2
> 读者处境: 生产"不可变集合怎么搞""为什么不用 Collections.synchronizedList"——包装器的设计哲学与陷阱。

### 1. "unmodifiableXxx 是怎么做到的？" — 视图包装器

场景: `Collections.unmodifiableList(list)` 返回的对象真的不可变吗?

- `Collections.java:1287` `unmodifiableList` → 返回 `UnmodifiableList`(`Collections.java:1023` UnmodifiableCollection 基类)— **装饰器**: 包装原列表,读方法委托,**写方法直接抛 UnsupportedOperationException**
- 注意: 是"视图"不是"拷贝"——**原 list 变了,包装视图也变**;只有原引用被安全封装才真正不可变
- 关键设计 (斜体): *装饰器模式的教科书应用: 拦截写操作(抛异常)+ 透传读操作;比防御性复制便宜(零拷贝);陷阱: 原引用泄漏=包装失效(面试点: 返回 unmodifiableList 前别把原引用也返回)*
- 生产: 对外暴露的集合必须包 unmodifiable(API 防御规范);JDK9+ 有 `List.of()`(不可变,非视图)
- 面试: "不可变集合的两种实现"——包装视图(可失效)vs 不可变副本(安全,JDK9+)

### 2. "synchronizedXxx 为什么是坑？" — 方法级锁包装

场景: 面试"线程安全集合用什么"——synchronizedList 的问题

- `Collections.java:2385` `synchronizedList` → `SynchronizedList`(`Collections.java:2000` 基类)— 所有方法 synchronized(this)
- 问题: **复合操作不安全**——`synchronizedList.get(i); list.add(...)` 两步之间可能被并发插入(需要外部锁;文档建议锁包装对象)
- 迭代器也不安全(遍历时需手动同步)——与 Vector 同类问题(第 2 篇)
- 关键设计 (斜体): *"方法级同步"≠"线程安全集合"——原子性只在单方法内;正确姿势: 并发场景用 CopyOnWriteArrayList/ConcurrentLinkedQueue(域 10),或外部锁包裹复合操作;面试"为什么不用 synchronizedList"的标准答法*
- 面试: "迭代器也要锁?"——是的,文档明确要求遍历时 synchronized(list) { for (...) }

### 3. "checkedXxx 防什么？" — 类型安全视图

场景: 泛型擦除后,`List<String>` 怎么混入 Integer?

- 擦除: 运行时 List 不检查元素类型——`((List) stringList).add(123)` 编译期放行,运行期成功(泛型漏洞)
- `Collections.java:3040` `CheckedCollection`(checkedList/checkedSet/...)— **写入时检查类型**(add/put 时 instanceof 校验)
- 关键设计 (斜体): *checked 包装器是"防御性编程的最后防线": 跨模块/反序列化/遗留代码混入错误类型时提前抛 ClassCastException(而不是运行时 ClassCastException 闪现在奇怪的位置);生产: 与不可变代码协作的接口边界用*
- [JLS §4.6: 类型擦除——泛型信息运行时不存在,checked 包装器是擦除后的运行时类型检查补充]
- 面试: "泛型擦除与 checked 集合"——能说出擦除漏洞+checked 补救=加分

### 4. "算法工具" — reverse/shuffle/sort/swap

场景: `Collections.reverse(list)` 对所有 List 生效——怎么做到不依赖实现?

- `Collections.java:378` `reverse(List)` — **RandomAccess 判断**: 实现 RandomAccess(ArrayList)用双端指针交换 O(n);否则用 ListIterator 双向遍历(`Collections.java:378-388`)
- `Collections.java:425` `shuffle(List)` — Fisher-Yates 洗牌(从后向前与随机位置交换,`Collections.java:458` 带 Random 版本)
- `Collections.java:144` `sort(List)` — **委托 `list.sort(null)`**(JDK8+ 实现移到 List 接口 default 方法: `toArray()` → `Arrays.sort` → `listIterator().set` 写回)——**任何 List 都能排序**的实现技巧
- `Collections.java:496` `swap` / `5503` `addAll`
- 关键设计 (斜体): *Collections 算法的通用性技巧: ① RandomAccess 标记接口做策略分派(数组 vs 链表)② sort 通过"转数组排序再写回"复用 Arrays——接口驱动+临时数组,不侵入 List 实现*
- 面试: "RandomAccess 是空接口,有什么用?"——标记接口的运行时策略判断(`list instanceof RandomAccess`)
- [关联: 域 09 TreeMap 的 Collections 有序性支持(sort/比较器)]

---

### 核心悬念

List/Queue/迭代器都通了——但面试真正的重头是 **Map**: `HashMap` 怎么存?哈希冲突怎么解决?扩容为什么必须 2 次幂?`ConcurrentHashMap` 凭什么并发安全?——下一站: 域 09 Map 与哈希。

> → 下一篇: 域 09 Map 与哈希(09-map 系列) | 域 10 并发集合(并发生态)
