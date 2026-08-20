# 08-collections/06 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `Collections`。本文聚焦三大包装器 `unmodifiable` / `synchronized` / `checked` 与典型算法工具 `sort` / `binarySearch` / `reverse` / `shuffle`。不展开并发容器内部实现和 Map 系列细节。
> 目标：把“Collections 工具与包装器”改写成一篇围绕“`Collections` 不是杂项工具箱，而是一组对集合语义做适配、约束和策略分派的静态适配器”的机制文章。

## 1. 读者困惑

- `Collections.unmodifiableList(list)` 返回的东西到底是副本还是视图？为什么原列表一变它也变？
- `Collections.synchronizedList(list)` 明明加了同步，为什么生产上还常被认为“不够安全”？
- `checkedList` 这种几乎没人手写的 API 到底防什么，为什么跟泛型擦除有关？
- `Collections.reverse(list)` / `binarySearch(list, key)` 为什么不依赖具体实现，却还能照顾 ArrayList 和 LinkedList 的性能差异？
- `Collections.sort(list)` 为什么自己不实现排序，而是委托给 `List.sort`？
- `RandomAccess` 这种空接口为什么能对算法行为产生真实影响？

## 2. 一句话顿悟

**`Collections` 的核心价值不是“凑了一堆静态方法”，而是把集合操作拆成两类适配：一类是包装器，用视图方式给现有集合叠加只读、同步、类型检查等语义；另一类是多态算法，在不要求具体实现类型的前提下，根据 `RandomAccess` 和阈值等信号动态选择更合适的执行路径。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖三大包装器和 `reverse` / `shuffle` / `sort` / `swap` 等工具。
- 已指出 `unmodifiable` 是视图、`synchronizedList` 有复合操作和迭代器问题、`checked` 与擦除漏洞相关。
- 已提到 `RandomAccess` 标记接口驱动策略分派。

### 必须重写

- 旧稿把包装器与算法工具并列罗列，但缺少统一视角，需要先建立“视图适配器 + 多态算法”的总问题。
- `unmodifiable` 需要更明确地区分“只读视图”和“真正不可变对象”，并强调原引用泄漏会让包装失效。
- `synchronized` 不能只停留在“方法级同步是坑”，要把“迭代器仍需外部锁”的源码契约讲出来。
- `checked` 需要从泛型擦除漏洞引入，说明它是运行时补丁而不是多余装饰。
- 算法工具部分要突出 `RandomAccess` / 阈值 / 转数组写回 这些“通用而不粗暴”的实现技巧。

## 4. 理解路径

### 第一节：先建立总问题——Collections 到底是什么角色

从 `Collections` 类注释切入：它既提供 wrappers，也提供 polymorphic algorithms。读者先获得总图：这不是和 `Arrays` 平行的“又一堆工具”，而是专门围绕集合接口做适配。

证据：
- `Collections.java:46-50`：polymorphic algorithms + wrappers
- `Collections.java:62-69`：算法依赖可变操作时可能抛 `UnsupportedOperationException`

### 第二节：unmodifiable 为什么是“只读视图”，不是不可变副本

证据：
- `Collections.java:1273-1290`：`unmodifiableList`
- `Collections.java:1296-1333`：`UnmodifiableList` 的读透传、写抛异常
- 可加 `Collections.java:1366-1368`：`subList` 继续返回 unmodifiable 视图

主线：
- 包装器模式：读操作 read-through 到 backing list，写操作直接拦截。
- 这是视图，不复制元素；所以 backing list 变了，视图也会反映变化。
- 只有 backing reference 不再泄漏时，这种“不可修改”才真正对外成立。

### 第三节：synchronized 为什么只保证单方法互斥

证据：
- `Collections.java:2000-2044`：`SynchronizedCollection`
- `Collections.java:2035-2037`：`iterator()` 返回值要求用户手动同步
- `Collections.java:2096-2108`：文档明确要求遍历时在同步块里使用迭代器
- `Collections.java:2385-2455`：`synchronizedList` 与 `SynchronizedList`

主线：
- 每个方法包 `synchronized(mutex)`，能保证单次调用的互斥。
- 但复合操作是多次调用，不共享一个自动延续的原子区间。
- 迭代器本身也不是自动同步的，JDK 文档明确要求用户自己在遍历外围加锁。

### 第四节：checked 为什么是泛型擦除后的运行时补丁

证据：
- `Collections.java:3040-3050`：`CheckedCollection` / `typeCheck`
- `Collections.java:3097`：`add(E e)` 调用 `typeCheck`
- `Collections.java:3106-3126`：`checkedCopyOf` 对不可信 `toArray` 的防御

主线：
- 泛型擦除后，运行时集合本体不知道 `List<String>` 这个参数化信息。
- 裸类型、反射、老代码、跨模块边界都可能塞进错误类型。
- `checked` 的价值是把错误尽量前移到“写入那一刻”，而不是等它在别处以奇怪方式炸开。

### 第五节：Collections 算法为什么能“通用而不粗暴”

证据：
- `Collections.java:143-146`：`sort(List)` 直接委托 `list.sort(null)`
- `Collections.java:192-219`：`binarySearch` 根据 `RandomAccess` 或阈值分派
- `Collections.java:243-280`：`iteratorBinarySearch`
- `Collections.java:378-395`：`reverse`
- `Collections.java:425-479`：`shuffle`
- `Collections.java:105-112`：各类算法阈值常量

主线：
- `Collections` 不要求调用方必须给 ArrayList；它会看 `RandomAccess` 标记和集合大小决定用下标版还是迭代器版。
- `reverse` 对数组型 List 直接 swap，对链式 List 走双向迭代器。
- `shuffle` 对非 `RandomAccess` 且大的列表会先转数组，避免原地洗牌退化成平方复杂度。
- `sort` 则把工作委托给 `List.sort`，再由具体实现复用 `Arrays.sort` 或自定义路径。

### 第六节：RandomAccess 为什么这种空接口仍然重要

目标：解释“空接口”并不意味着无用。它在运行时提供的是结构性提示：这个 List 适合按索引走，还是适合按迭代器走。

与上一章 `ArrayList` / `LinkedList` 的差异闭环：
- ArrayList：随机访问友好
- LinkedList：顺序访问更自然

### 第七节：收束到防御式编程与下一域

把三大包装器和算法工具统一起来：
- 对外暴露集合：`unmodifiable`
- 遗留并发封装：`synchronized`，但要知道边界
- 不可信输入边界：`checked`
- 通用算法：由接口契约 + 标记接口 + 阈值驱动

自然引到域 09 Map 与哈希。

## 5. 失败方案清单

1. 把 `unmodifiableList` 当成深度不可变副本。
2. 返回 `unmodifiableList` 的同时继续暴露原列表引用。
3. 以为 `synchronizedList` 自动让复合操作也原子。
4. 在 `synchronizedList` 上遍历却不手动加锁。
5. 认为 `checkedList` 毫无意义，因为“泛型编译期已经检查过”。
6. 在 LinkedList 上按下标反复做 `Collections.binarySearch` 或 `reverse` 却不知道它会走另一套路径。
7. 觉得 `RandomAccess` 是空接口，所以不会影响任何性能决策。

## 6. 误解清单

1. `unmodifiable` 等于 immutable。
2. `synchronizedXxx` 等于现代线程安全集合。
3. `checkedXxx` 是多余的历史残留。
4. `Collections.sort` 自己实现了完整排序逻辑。
5. 所有 List 算法都应该统一用 `get(i)`，否则太绕。
6. 空接口不能承载任何实质信息。
7. `Collections` 只是杂项静态方法集合，没有结构性设计。

## 7. 证据清单

- `Collections.java:46-50`：wrappers + polymorphic algorithms
- `Collections.java:62-69`：算法对可变操作的要求与 UOE
- `Collections.java:105-112`：阈值常量
- `Collections.java:143-146`：`sort(List)`
- `Collections.java:184-219`：`binarySearch`
- `Collections.java:243-280`：`iteratorBinarySearch`
- `Collections.java:378-395`：`reverse`
- `Collections.java:425-479`：`shuffle`
- `Collections.java:1273-1290`：`unmodifiableList`
- `Collections.java:1296-1333`：`UnmodifiableList`
- `Collections.java:1366-1368`：`subList` 继续包装
- `Collections.java:2000-2044`：`SynchronizedCollection`
- `Collections.java:2035-2037`：迭代器需手动同步
- `Collections.java:2096-2108`：文档示例要求外部锁
- `Collections.java:2385-2455`：`synchronizedList` / `SynchronizedList`
- `Collections.java:3040-3050`：`CheckedCollection` / `typeCheck`
- `Collections.java:3097`：`add(typeCheck(e))`
- `Collections.java:3106-3126`：`checkedCopyOf`

## 8. 版本与边界

- 基于 JDK 11。
- 不展开 JDK 9+ `List.of()` / `Map.of()` 的完整不可变实现，只作为对照提一句。
- 不展开并发容器内部实现，`synchronizedXxx` 只与现代并发容器做选型边界对照。
- 不展开 Map 包装器的全部变体，重点用 `List` / `Collection` 建立模式，再类比到 `Set` / `Map`。

## 9. 删除代码测试与最终验收标准

- 删除源码块后，读者仍能复述“Collections = 包装器 + 多态算法 → unmodifiable 是只读视图 → synchronized 只保单方法互斥且迭代要手动锁 → checked 在运行时补泛型擦除漏洞 → reverse/binarySearch/shuffle 按 `RandomAccess` 和阈值分派”。
- 必须明确 `unmodifiable` 与真正不可变副本的差异。
- 必须明确 `synchronizedList` 的失败边界：复合操作与遍历。
- 必须把 `checked` 和类型擦除绑定起来讲。
- 结尾要自然引到域 09 Map 与哈希。
