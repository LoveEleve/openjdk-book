# 02. ConcurrentHashMap 扩容与计数 — sizeCtl、协助转移、分片计数

> **前置依赖**: [10-concurrent-collections/01 — CHM 存储与读写](01-chm-storage-rw.md)(MOVED/桶级锁)、[13-atomic/02 — LongAdder](../13-atomic/02-striped64-longadder.md)(CounterCell 思想)
> → **后续**: [03-skiplist.md](03-skiplist.md)
> 关联: [09-map-hash/02 — HashMap resize](../09-map-hash/02-resize.md)(高低位拆分)

## 扩容和 size 怎么并发

CHM 的难点不在 put/get 本身,而在**扩容协作**和**高并发计数**。这一篇把 `sizeCtl`、`transfer`、`CounterCell` 一次讲清。

## 1. "sizeCtl 是什么?" — 扩容指挥旗

### 1.1 一个字段管三件事

`ConcurrentHashMap.java:800` 的 `private transient volatile int sizeCtl` 是多用途状态位:

- `0/正数` —— 下一次初始化容量或扩容阈值
- `-1` —— 初始化中
- `< -1` —— 扩容中(还编码了扩容戳与参与线程数)

### 1.2 初始化抢旗

`initTable()`(`ConcurrentHashMap.java:2283`)里先看 `sizeCtl`:

- `sizeCtl < 0` → `Thread.yield()` 等别人初始化
- 否则 CAS 抢成 `-1`
- 成功线程分配数组,最后把 `sizeCtl` 设为 `n - (n >>> 2)`——也就是 **0.75 阈值**

面试"CHM 怎么防并发初始化": `sizeCtl` CAS 抢旗。

关键设计(斜体):*"sizeCtl = 无锁的协调旗"——初始化/扩容都先抢这面旗,负数表示进行中,正数表示阈值。面试"sizeCtl 三个值区间": -1 初始化/负数扩容/正数阈值。*

## 2. "transfer 协助扩容" — 多线程搬家

### 2.1 扩容入口

写入后 `addCount`(`:2316`)会检查是否需要扩容;真正搬桶的是 `transfer`(`:2416`)。

`transferIndex`(`:805`)记录**还没搬完的下标区间**。参与线程不是各扫各的,而是从 `transferIndex` 里认领一段任务——**分片搬桶**。

### 2.2 搬桶与转发

- 原桶节点按 **高低位拆分** 搬到新表(与 HashMap resize 同源)
- 旧桶位置放 `ForwardingNode`(`:2223`)
- 其他线程遇到 `MOVED` 就调用 `helpTransfer`(`:2355`;调用点如 `:1023`)加入扩容

所以扩容不是一个线程独占完成,而是**写线程全员协作**。

### 2.3 读线程怎么办

`get` 遇到负 hash 节点会走 `find`;如果是 `ForwardingNode`,就**转发到新表查**。所以扩容期间读线程不阻塞。

面试"CHM 扩容怎么并发": 分片 + 协助 + 转发。

关键设计(斜体):*"扩容 = 全员协作"——搬桶分片(`transferIndex`)+ 遇 MOVED 即协助(`helpTransfer`)+ 读遇转发节点直接去新表。面试"扩容期间 get 会怎样": 转发到新表读,不阻塞。*

## 3. "计数: CounterCell 分片" — 并发 size

### 3.1 两级计数

CHM 不用一个全局 `AtomicLong`,而是两级结构:

- `baseCount`(`:790`)——低竞争时直接 CAS 累加
- `counterCells`(`:815`)——高竞争时分片累加
- `cellsBusy`(`:810`)——创建/扩容 `counterCells` 时的 CAS 自旋锁

`addCount`(`:2316`)先尝试 CAS `baseCount`;失败或竞争激烈时转入 `fullAddCount`(`:2572`),把线程打散到不同 Cell 上。Cell 本身是 `CounterCell`(`:2555`,带 `@Contended`)。

这和 `LongAdder` 的思路是同一类: **单点冲突升级成分片累加**。

### 3.2 size 为什么弱一致

- `size()`(`:909`)本质上调用 `sumCount()`——汇总 `baseCount + ΣcounterCells`
- `mappingCount()`(`:2166`)是 long 版本

因为统计时**不加全局锁**,所以结果只保证近似,不保证线性一致。

面试"CHM size 准吗": 弱一致;面试"为什么不用一个 AtomicLong": 高并发下争抢太重。

关键设计(斜体):*"分片计数"让写线程各打各的格(Cell),免全局竞争——size 弱一致是代价。面试"CHM 和 LongAdder 关系": 同款 CounterCell 方案。*

## 4. "与 HashMap 的并发对照" — 安全边界

### 4.1 为什么不用 HashMap 加锁

- `HashMap` 并发 resize 有竞态风险(域 09)
- `Collections.synchronizedMap` 是**全表锁**,读也要锁
- CHM 是**无锁读 + 桶锁写 + 协作扩容 + 分片计数**

### 4.2 安全边界

CHM 保证的是**单操作并发安全**。像"先查再改"这种复合逻辑,仍然要用 `compute`/`merge`/外部同步封装原子性。

面试"CHM 绝对安全吗": 单操作安全,复合操作不自动原子。

关键设计(斜体):*"CHM 的安全 = 无锁读 + 细粒度写 + 分片扩容/计数"——对比 synchronizedMap 的粗粒度全表锁。面试"CHM vs 加锁 HashMap": 吞吐与一致性边界不同。*

## 核心悬念

哈希并发讲完了——**有序并发**呢?`ConcurrentSkipListMap` 的跳表怎么无锁维护多层索引?为什么选跳表不选红黑树?——下一篇: 跳表与有序并发。

> → [03-skiplist.md](03-skiplist.md)