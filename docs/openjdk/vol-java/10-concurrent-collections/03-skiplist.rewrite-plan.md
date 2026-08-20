# 10-concurrent-collections/03 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `java.util.concurrent.ConcurrentSkipListMap`。本文聚焦底层有序链表、`Index`/`HeadIndex` 多层索引、`findPredecessor`/`doGet`/`doPut` 主路径、marker 删除协议，以及弱一致范围查询的实现边界。`ConcurrentSkipListSet` 只作为文末收束，不单独展开内部细节。
> 目标：把“ConcurrentSkipListMap 跳表”改写成一篇围绕“并发有序 Map 为什么不选红黑树，而要选多层索引链表”的机制文章，并把局部 CAS、marker 删除和弱一致范围查询讲成同一套设计。

## 1. 读者困惑

- 并发场景已经有 `ConcurrentHashMap` 了，为什么还需要 `ConcurrentSkipListMap`？
- 如果要做有序并发 Map，为什么 JDK 不做一棵并发红黑树，而选跳表？
- 跳表到底是不是“好多层链表叠在一起”，这和红黑树的 `O(log n)` 有什么关系？
- 不加全局锁时，插入和删除怎么维持有序结构不乱？
- marker 节点到底在解决什么问题，为什么删除不能一步 CAS 完成？
- `firstKey`、`ceilingEntry`、`subMap` 这些范围 API 在并发下为什么还能工作，又为什么只给弱一致？

## 2. 一句话顿悟

**ConcurrentSkipListMap 选跳表而不选红黑树，不是因为跳表“更高级”，而是因为它把有序结构拆成了底层有序链表加上层稀疏索引；查找仍有 `O(log n)` 期望复杂度，而并发修改只需要在局部相邻指针上做 CAS 和清理 marker，不必像平衡树那样在旋转和重着色中牵动整片结构。**

## 3. 旧稿优点与问题

### 保留

- 已指出跳表的两层角色：底层 `Node` 链表、上层 `Index` 索引。
- 已覆盖 `findPredecessor`、`doGet`、`doPut` 和 marker 删除三步法。
- 已提到有序 API 与弱一致遍历边界。

### 必须重写

- 旧稿仍像术语清单，缺少一个足够强的总问题：并发有序结构为什么不选红黑树。
- 跳表的“多层索引”需要先画角色图，再讲方法；否则读者只会记住 `right/down`，记不住为何并发友好。
- marker 删除必须讲成失败方案：为什么删除节点不能直接一把 CAS 把前驱越过去。
- `doGet`/`doPut` 要服务“并发有序怎么运转”的主线，而不是按源码方法名平铺。
- 范围查询的弱一致边界要讲成设计取舍，不是只给一句“弱一致”。

## 4. 理解路径

### 第一节：从“并发有序 Map 为什么不能给 TreeMap 外面套锁”开场

用排行榜/延迟任务/按时间窗口扫描这类场景开场：既要并发更新，又要有序查找和范围截取。指出两种朴素方案都不理想：给 `TreeMap` 套大锁会把读写都拖进串行；做并发红黑树又会把旋转和平衡维护做成很难局部化的同步难题。

### 第二节：跳表真正长什么样——底层全量链表 + 上层稀疏索引

证据：
- `ConcurrentSkipListMap.java:340`：`head`
- `ConcurrentSkipListMap.java:359-363`：`Node<K,V>`
- `ConcurrentSkipListMap.java:373-377`：`Index<K,V>`
- 类注释 `ConcurrentSkipListMap.java:125+`：head/index 文字图

主线：
- 底层是一条按 key 全量有序的链表，所有真实键值都在这里。
- 上层索引节点只负责加速查找，靠 `right/down/node` 把“跳着走”和“往下落”串起来。
- 因此跳表不是“树的另一种写法”，而是“链表本体 + 稀疏导航层”。

### 第三节：为什么并发有序结构更愿意选跳表，不愿意选红黑树

证据：
- 类注释 `ConcurrentSkipListMap.java:120-123`：说明 cheaper algorithms for the heavily-traversed index lists 等设计取向
- `ConcurrentSkipListMap.java:229-240`：索引层用 CAS 连接/移除、删除后可单独清理索引

主线：
- 红黑树的查找复杂度也很好，但插删时常要旋转、重着色、修复平衡，影响范围容易超出局部。
- 跳表的有序维护主要表现为相邻指针重连，修改局部性更强，更适合乐观 CAS + 失败重试。
- 这里不是说红黑树不能并发，而是说 JDK 11 选择了一条更容易把并发修改局部化的工程路线。

### 第四节：查找为什么能靠“向右走，走不动就向下落”完成

证据：
- `ConcurrentSkipListMap.java:464-476`：`findPredecessor`
- `ConcurrentSkipListMap.java:536-568`：`doGet`
- `ConcurrentSkipListMap.java:391`：`cpr`

主线：
- 从顶层 `head` 出发，先沿 `right` 尽量逼近目标 key，再通过 `down` 进入下一层。
- 到达底层前驱后，再在底层链表中命中真实节点。
- 查找本质不是“走一棵树”，而是“索引层导航 + 底层链表收口”。

### 第五节：插入为什么不需要全局锁——局部 CAS 链接即可

证据：
- `ConcurrentSkipListMap.java:595-680`：`doPut`
- `ConcurrentSkipListMap.java:653`：底层节点插入 CAS
- `ConcurrentSkipListMap.java:665-676`：新索引层与 head 升层
- `ConcurrentSkipListMap.java:701+`：`addIndices`

主线：
- 先找到底层前驱，再尝试把新节点用 CAS 链进底层有序链。
- 底层成功后，再按随机层高为它补上索引层。
- 这解释了为什么运行时主线应放在“如何链接局部指针”，而不是把随机层高当文章主角。

### 第六节：为什么删除不能一步完成——marker 是为可恢复删除协议服务的

证据：
- `ConcurrentSkipListMap.java:199-207`：删除三步法长注释
- `ConcurrentSkipListMap.java:413-423`：`unlinkNode`
- `ConcurrentSkipListMap.java:503-517`：`findNode` 途中清理已删除节点
- `ConcurrentSkipListMap.java:749+`：删除相关注释

主线：
- 朴素方案：前驱直接 CAS 越过目标节点；问题在于并发线程可能同时经过或修改目标节点，单步越过不易保证所有参与者都能识别这次删除正在发生。
- 真正实现把删除拆成三步：先逻辑删除 value，再把 `next` 指向 marker，再让前驱越过目标和 marker。
- marker 的价值不是“教科书标记位”，而是让其他线程一眼认出“这个节点正在退出”，并能顺手帮忙清理。

### 第七节：范围 API 为什么能工作，但只给弱一致视图

证据：
- `ConcurrentSkipListMap.java:829`：`findFirst`
- `ConcurrentSkipListMap.java:845`：`findFirstEntry`
- 类注释中关于 traversal 的说明，可在重写时按需补充精确锚点

主线：
- 底层链表始终保持 key 有序，所以 `firstKey`、`ceilingEntry`、`subMap` 都有天然落点。
- 但遍历期间别的线程仍可能插删节点，因此这些 API 提供的是弱一致视图：顺序不会乱，快照也不会冻结。
- 这正是跳表并发设计的代价：保留有序导航能力，但不承诺全局静态视图。

### 第八节：`ConcurrentSkipListSet` 只作为收束

证据：
- `ConcurrentSkipListSet.java:95`：类定义
- `ConcurrentSkipListSet.java:102`：value 用 `Boolean.TRUE`
- `ConcurrentSkipListSet.java:113`：默认构造 new map

主线：
- Set 只是把 value 固定成占位值，本体仍是并发跳表 map。
- 目的不是展开第二篇，而是帮助读者把“并发有序 Set”与“并发有序 Map”统一起来。

## 5. 失败方案清单

1. 直接给 `TreeMap` 外面套一把大锁，期待它在高并发有序读写下仍然轻量。
2. 试图把并发有序结构做成无锁红黑树，却低估旋转和平衡修复的同步范围。
3. 把跳表理解成“随机化的树”，忽略它的本体其实是底层有序链表。
4. 删除节点时让前驱一步 CAS 越过去，不给其他线程留下可识别的中间状态。
5. 以为索引层才是数据本体，忽略所有真实键值都在底层链表中。
6. 把范围查询结果当成强一致静态快照。
7. 误以为只要用了跳表，就不再需要失败重试和帮助清理逻辑。

## 6. 误解清单

1. `ConcurrentSkipListMap` 只是“线程安全版 TreeMap”。
2. 跳表查找快，是因为它偷偷做了树旋转。
3. marker 节点只是空间浪费，对并发删除没有实质作用。
4. `doGet` 无锁就意味着它读到的是事务级最新值。
5. 索引层节点保存了全部数据，底层链表只是备份。
6. 范围 API 既然有序，就应当自动返回全局一致快照。
7. `ConcurrentSkipListSet` 是一套完全不同的并发结构。

## 7. 证据清单

- `ConcurrentSkipListMap.java:120-123`：类注释里关于 cheaper algorithms 的设计取向
- `ConcurrentSkipListMap.java:125+`：类注释中的 head/index 结构图
- `ConcurrentSkipListMap.java:199-207`：删除三步法
- `ConcurrentSkipListMap.java:229-240`：索引层 CAS 与独立清理注释
- `ConcurrentSkipListMap.java:340`：`head`
- `ConcurrentSkipListMap.java:359-363`：`Node<K,V>`
- `ConcurrentSkipListMap.java:373-377`：`Index<K,V>`
- `ConcurrentSkipListMap.java:391`：`cpr`
- `ConcurrentSkipListMap.java:413-423`：`unlinkNode`
- `ConcurrentSkipListMap.java:464-476`：`findPredecessor`
- `ConcurrentSkipListMap.java:503-517`：`findNode`
- `ConcurrentSkipListMap.java:536-568`：`doGet`
- `ConcurrentSkipListMap.java:595-680`：`doPut`
- `ConcurrentSkipListMap.java:701+`：`addIndices`
- `ConcurrentSkipListMap.java:829`：`findFirst`
- `ConcurrentSkipListMap.java:845`：`findFirstEntry`
- `ConcurrentSkipListSet.java:95`：类定义
- `ConcurrentSkipListSet.java:102`：占位值注释
- `ConcurrentSkipListSet.java:113`：默认构造

## 8. 版本与边界

- 基于 JDK 11。
- 本文强调的是 Java 层并发有序结构设计，不展开底层 CPU 内存模型讨论。
- 跳表层高随机化只解释到“帮助保持期望查找复杂度”这一层，不展开概率推导。
- 不把弱一致范围视图写成线性一致快照语义。
- 不把 `ConcurrentSkipListSet` 单独扩写为一篇，它只作为 map 的包装收束。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么并发有序结构不选红黑树 → 跳表 = 底层有序链表 + 上层稀疏索引 → 查找如何 right/down 落到底层 → 插入为何只需局部 CAS → 删除为何必须 marker 三步法 → 范围查询为何有序但弱一致”。
- 必须把‘为什么不是并发红黑树’讲成主问题，而不是顺手对比。
- 必须把 marker 删除讲成失败方案修复，而不是术语解释。
- 必须把范围 API 的弱一致边界讲清楚。
- 结尾要自然引到 `04-copyonwrite-concurrentqueue.md`：有序并发讲完后，读多写少与无锁队列是另一种并发取舍。
