# 02. ConcurrentHashMap 扩容与计数 — sizeCtl、协助转移、分片计数

> 🔴 Deep | 域 10 并发集合第 2 篇(巨型域 6 篇之二)| Layer 5
> 读者处境: 面试"CHM 扩容怎么并发""size() 准吗"——扩容协作与计数分片。

### 1. "sizeCtl 是什么？" — 扩容指挥旗

场景: 多线程怎么协调"谁初始化/谁扩容"?

- `ConcurrentHashMap.java:800` — `private transient volatile int sizeCtl` — **状态标志**(多用途):
  - 负数: 初始化中(-1)/扩容中(负数部分含扩容线程计数)
  - 正数: 下次扩容阈值(容量×0.75)
- `initTable`(2283): `casTabAt(sizeCtl, -1)` 抢初始化权——**CAS 抢旗**
- 关键设计 (斜体): *"sizeCtl = 无锁的协调旗"——CAS 抢旗(初始化/扩容),多值编码(负数=进行中);面试"CHM 怎么防并发初始化"——sizeCtl CAS*
- 面试: "sizeCtl 三个值区间"——-1 初始化/负数扩容/正数阈值

### 2. "transfer 协助扩容" — 多线程搬家

场景: 扩容时其他 put 线程干什么?

- 扩容入口: 触发(putVal 后 addCount 判断)→ `tryPresize`/`transfer`(1716 附近)
- `transfer`: 桶按 `transferIndex`(805)分块,每个参与线程认领一段(从尾往前)——**多线程分片搬桶**
- 搬桶: 原桶 → 高低位拆分(同 HashMap,域 09)→ 原位置放 **ForwardingNode**(hash=MOVED,2223)
- 其他线程遇到 MOVED → `helpTransfer`(1023/1118 等)— **主动加入扩容**(读线程也能帮忙: ForwardingNode.find 转发)
- 关键设计 (斜体): *"扩容 = 全员协作"——搬桶分片(transferIndex)+ 遇 MOVED 即协助;读线程遇 ForwardingNode 转发到新表(无阻塞);面试"CHM 扩容怎么并发"——分片+协助+转发*
- 面试: "扩容期间 get 会怎样"——转发到新表读(ForwardingNode.find),无阻塞
- [关联: 域 09 resize(高低位拆分同源)]

### 3. "计数: CounterCell 分片" — 并发 size

场景: 百万并发 put——size() 怎么不成为瓶颈?

- `ConcurrentHashMap.java:790` `baseCount` + `815` `counterCells[]` — **分片计数**(域 13 LongAdder 同思想)
- `addCount`(2316): 先 CAS baseCount;竞争激烈 → 扩容 CounterCell 数组,线程哈希到自己的 Cell 累加
- `size()`(909)→ `sumCount`: baseCount + 遍历 CounterCell 求和——**弱一致**(不加锁,可能偏差)
- `mappingCount`(2166): long 版本(>2^31 用)
- 关键设计 (斜体): *"分片计数"让写线程各打各的格(Cell),免全局竞争——size 弱一致是代价;面试"CHM size 准吗"——近似(弱一致);"为什么不用一个 AtomicLong"——争抢*
- 面试: "CHM 和 LongAdder 关系"——同款 CounterCell 方案(域 13)

### 4. "与 HashMap 的并发对照" — 安全边界

场景: 面试"为什么不用 HashMap 加锁"?

- HashMap 并发问题: 覆盖丢失(resize 竞态)/JDK7 环链(域 09)
- CHM 方案: 无锁读 + 桶锁写 + 协作扩容——**并发安全且无全局锁**
- 对照: Collections.synchronizedMap(HashMap 全锁)——**读也要锁**(性能差)
- 关键设计 (斜体): *"CHM 的安全=无锁读+细粒度写"——对比 synchronizedMap 的粗粒度;面试"CHM vs 加锁 HashMap"——吞吐与一致性权衡*
- 面试: "CHM 绝对安全吗?"——单操作安全,复合操作(先查后改)仍要锁或 compute

---

### 核心悬念

哈希并发讲完——**有序并发**呢?`ConcurrentSkipListMap` 的跳表怎么无锁维护多层索引?为什么选跳表不选红黑树(域 09)?——下一篇: 跳表与有序并发。

> → [03-skiplist.md](03-skiplist.md)
