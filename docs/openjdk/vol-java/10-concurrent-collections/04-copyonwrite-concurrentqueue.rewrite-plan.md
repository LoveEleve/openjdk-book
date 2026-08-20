# 10-concurrent-collections/04 重写规划

> 状态：重写前计划
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 版本边界：JDK 11 `CopyOnWriteArrayList`、`CopyOnWriteArraySet` 与 `ConcurrentLinkedQueue`。本文聚焦 COW 的 `array`/`getArray`/`setArray`/`add`/迭代器快照，以及 CLQ 的 `Node`、`offer`、`poll`、`peek`、`updateHead` 和弱一致遍历。阻塞队列与背压语义不在本文展开。
> 目标：把“CopyOnWrite 与无锁队列”改写成一篇围绕“读多写少场景为什么愿意用整数组复制，而持续生产消费场景为什么更愿意用无锁链队列”的对照文章，并把两者的读友好策略、代价和一致性边界讲成一套清晰取舍。

## 1. 读者困惑

- 都是并发容器，为什么 `CopyOnWriteArrayList` 和 `ConcurrentLinkedQueue` 会走两条完全不同的路线？
- 为什么有人愿意为一次 `add` 复制整组数组，这不是很浪费吗？
- `CopyOnWriteArrayList` 的“读无锁”到底依赖什么，为什么迭代器能看到稳定快照？
- `ConcurrentLinkedQueue` 不加锁，怎么保证入队出队不把链表弄坏？
- 为什么 CLQ 的 `tail` 不是每次都必须立刻更新到最新节点？
- 两者的遍历为什么一个像快照，一个是弱一致实时视图？
- 什么时候该选 COW，什么时候该选 CLQ，什么时候两者都不合适？

## 2. 一句话顿悟

**CopyOnWriteArrayList 和 ConcurrentLinkedQueue 都在追求“让读者或消费者尽量少被写者阻塞”，但做法完全不同：COW 通过“写时整组复制、一次性发布新数组”把读者固定在旧快照上；CLQ 通过“节点局部 CAS 链接、惰性推进 head/tail”让生产者和消费者持续前进。前者用空间复制换稳定快照，后者用弱一致视图换持续吞吐。**

## 3. 旧稿优点与问题

### 保留

- 已覆盖 `CopyOnWriteArrayList` 的 volatile 数组、写时复制、读无锁与快照迭代器。
- 已覆盖 `ConcurrentLinkedQueue` 的 `Node`、`offer`、`poll`、`peek` 与弱一致遍历。
- 已指出 COW 适合读多写少，CLQ 适合持续并发入队/出队。

### 必须重写

- 旧稿像两段并列说明书，缺少“为什么会出现这两种完全不同并发策略”的总问题。
- COW 需要先用“监听器列表/配置快照”之类场景把‘为什么愿意复制整组数组’讲通，而不是直接列四步。
- CLQ 需要把“为什么不能用大锁队列”与“为什么 `tail` 惰性更新仍然正确”讲成主线，不要只说 CAS 尾插。
- 遍历一致性边界要做清晰对照：COW 是创建时快照，CLQ 是运行中弱一致视图。
- `CopyOnWriteArraySet` 只作为收束，不该占据主线篇幅。

## 4. 理解路径

### 第一节：先建立总问题——“读友好”不只一种做法

用两个典型场景开场：一个是监听器/白名单这类读多写少、还希望每次遍历拿到稳定名单的场景；另一个是生产者持续入队、消费者持续出队、任何全表复制都无法接受的场景。先说明同样是“尽量别让读者被写者挡住”，两类场景对一致性和写成本的容忍度完全不同。

### 第二节：为什么 COW 愿意整组复制——它服务的是稳定快照读

证据：
- `CopyOnWriteArrayList.java:105`：`array`
- `CopyOnWriteArrayList.java:111`：`getArray`
- `CopyOnWriteArrayList.java:118`：`setArray`
- `CopyOnWriteArrayList.java:397`：`get`
- `CopyOnWriteArrayList.java:428`：`add`
- `CopyOnWriteArrayList.java:1023`：`iterator`

主线：
- 读路径只认当前数组引用；只要旧数组不原地修改，读者就总能读到一份完整快照。
- 写线程修改时不去动旧数组，而是复制出新数组、改完后一次性发布。
- 这解释了为什么 `get` 和迭代器可以无锁稳定前进：它们站在某个已发布数组上，而不是跟写线程共享可变内部结构。

### 第三节：为什么 COW 不适合写多——复制成本和内存压力不是副作用，而是主代价

证据：
- `CopyOnWriteArrayList.java:428` 附近 `add` 的复制路径
- `CopyOnWriteArraySet.java:104`：类定义
- `CopyOnWriteArraySet.java:108`：包装列表字段
- `CopyOnWriteArraySet.java:113`：默认构造

主线：
- 每次写都要 `O(n)` 复制整组数组。
- 集合越大、写越频繁，复制和 GC 压力越明显。
- `CopyOnWriteArraySet` 只是把同一策略包装成去重集合，说明 COW 是一整个“快照读”家族。
- 所以 COW 不是“线程安全万能列表”，而是一种明确偏向读者、让写者付费的策略。

### 第四节：CLQ 为什么走另一条路——持续生产消费不能接受整组复制或大锁

证据：
- `ConcurrentLinkedQueue.java:184-186`：`Node`
- `ConcurrentLinkedQueue.java:205`：`casItem`
- `ConcurrentLinkedQueue.java:354`：`offer`
- `ConcurrentLinkedQueue.java:383`：`poll`
- `ConcurrentLinkedQueue.java:404`：`peek`
- `ConcurrentLinkedQueue.java:290`：`updateHead`

主线：
- 队列场景下，元素不断进入又被消费，复制整组数据毫无性价比；给整个队列上一把锁又会把生产者和消费者串行化。
- CLQ 选择链表节点 + 局部 CAS，把入队和出队都收缩成相邻节点关系上的推进。
- `item`/`next` 的 volatile 和 CAS 共同保证局部结构可被并发线程安全推进。

### 第五节：为什么 `tail` 惰性更新仍然正确

证据：
- `ConcurrentLinkedQueue.java:354+`：`offer`
- `ConcurrentLinkedQueue.java:290`：`updateHead`
- 如果需要更精确地定位 `tail` 语义，可在重写中再补读相邻实现区

主线：
- 真正的入队线性化点是把前驱 `next` CAS 到新节点，而不是把 `tail` 字段立刻改准。
- `tail` 更多是一个加速器，帮助后来线程更快接近尾部；它暂时落后不会破坏队列正确性。
- 这类“惰性推进指针”是无锁队列常见取舍：先保证结构真实前进，再尽量补齐辅助指针。

### 第六节：出队和空节点清理为什么也能无锁推进

证据：
- `ConcurrentLinkedQueue.java:383-395`：`poll`
- `ConcurrentLinkedQueue.java:404-432`：`peek`
- `ConcurrentLinkedQueue.java:205`：`casItem`
- `ConcurrentLinkedQueue.java:290`：`updateHead`

主线：
- 出队不是立刻拆整个节点，而是先 CAS 清空 `item`，再用 `updateHead` 把头部逐步前推。
- 这说明 CLQ 也在做“让后来线程看得懂的中间态”：空 item 节点可以被跳过，头指针可惰性收缩。
- 重点不是背 API，而是理解它如何用局部状态推进代替全局锁。

### 第七节：遍历一致性为什么一边是快照，一边是弱一致

证据：
- `CopyOnWriteArrayList.java:1023`：迭代器快照入口
- `ConcurrentLinkedQueue.java` 迭代相关实现可在正文中按需补读，但主线先基于已知容器语义展开

主线：
- COW 迭代器站在创建时拿到的数组快照上，因此稳定但可能过时。
- CLQ 遍历的是正在变化的链表，可能看到部分新元素、看不到刚删除元素，但不会以 fail-fast 方式炸掉。
- 这里形成鲜明对照：一个用复制换静态快照，一个用无锁链接换动态弱一致视图。

### 第八节：`CopyOnWriteArraySet` 只作收束，帮助选型闭环

证据：
- `CopyOnWriteArraySet.java:104`：类定义
- `CopyOnWriteArraySet.java:108`：包装字段
- `CopyOnWriteArraySet.java:113`：默认构造

主线：
- Set 只是把 COW 列表包装成去重集合。
- 它帮助读者形成“COW 家族 = 读多写少 + 快照视图”的统一认识，但不抢正文主线。

## 5. 失败方案清单

1. 把读多写少的监听器列表交给普通 `ArrayList`，然后边遍历边改。
2. 在写频繁的大列表上使用 `CopyOnWriteArrayList`，期待它依然高效。
3. 把持续生产消费队列放进“加一把大锁”的普通链表里，导致吞吐受限。
4. 认为 CLQ 的正确性依赖 `tail` 每次都精确指向最后一个节点。
5. 以为无锁队列遍历就应该给出强一致快照。
6. 把 COW 和 CLQ 都当成“线程安全容器”，却不区分它们偏袒的是哪一类读写模式。
7. 试图用 COW 承载高频写入日志流或任务流。

## 6. 误解清单

1. `CopyOnWriteArrayList` 的写时复制只是小优化，不影响核心语义。
2. COW 读到旧数据说明实现不安全；实际旧快照就是设计目标之一。
3. `ConcurrentLinkedQueue` 无锁就意味着完全没有中间态。
4. `tail` 指针一旦落后，队列就会损坏或丢元素。
5. CLQ 的出队一定物理移除整个节点才算成功。
6. 两者的遍历都属于同一种弱一致语义。
7. `CopyOnWriteArraySet` 是另一套完全独立的并发实现。

## 7. 证据清单

- `CopyOnWriteArrayList.java:105`：`array`
- `CopyOnWriteArrayList.java:111`：`getArray`
- `CopyOnWriteArrayList.java:118`：`setArray`
- `CopyOnWriteArrayList.java:397`：`get`
- `CopyOnWriteArrayList.java:428`：`add`
- `CopyOnWriteArrayList.java:1023`：`iterator`
- `CopyOnWriteArraySet.java:104`：类定义
- `CopyOnWriteArraySet.java:108`：包装字段
- `CopyOnWriteArraySet.java:113`：默认构造
- `ConcurrentLinkedQueue.java:184-186`：`Node`
- `ConcurrentLinkedQueue.java:205`：`casItem`
- `ConcurrentLinkedQueue.java:290`：`updateHead`
- `ConcurrentLinkedQueue.java:354`：`offer`
- `ConcurrentLinkedQueue.java:383`：`poll`
- `ConcurrentLinkedQueue.java:404`：`peek`

## 8. 版本与边界

- 基于 JDK 11。
- COW 部分强调的是列表/集合快照读，不讨论阻塞、背压和批量复制优化。
- CLQ 部分强调的是无锁链式队列，不讨论阻塞等待；需要阻塞语义应转到下一篇 `BlockingQueue`。
- 不把 COW 迭代器写成“总是最新”，也不把 CLQ 遍历写成“强一致实时视图”。
- 不把 `tail` 惰性更新简化成 bug 或实现瑕疵，它是无锁正确性与性能折中。

## 9. 删除代码测试与最终验收标准

- 删除代码块后，读者仍能复述“为什么读友好会分成 COW 和无锁队列两条路线 → COW 如何用复制发布新数组 → 为什么它适合快照读但不适合高频写 → CLQ 如何用局部 CAS 推进入队出队 → 为什么 `tail` 可以惰性更新 → 两者遍历为何一个是快照、一个是弱一致”。
- 必须把两种容器放在同一条‘读友好策略对照’主线上讲。
- 必须明确 COW 的主代价是写复制，不要只当成缺点列表。
- 必须把 CLQ 的正确性落点讲到 `next`/`item`/`updateHead` 这些局部推进动作上。
- 结尾要自然引到 `05-blocking-queues.md`：当生产消费不只是并发，还需要阻塞等待时，就进入阻塞队列家族。
