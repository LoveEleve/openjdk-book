# 域 10: 并发集合 — 知识规划

> 源码路径: java.base/share/classes/java/util/concurrent/{ConcurrentHashMap(6,380),ConcurrentSkipListMap(3,416),CopyOnWriteArrayList(1,610),ConcurrentLinkedQueue(1,075),LinkedBlockingQueue(1,159),ArrayBlockingQueue(1,635),SynchronousQueue(1,202),PriorityBlockingQueue(1,118),DelayQueue(537),LinkedTransferQueue(1,749),BlockingQueue,TransferQueue,ConcurrentLinkedDeque,ConcurrentSkipListSet,CopyOnWriteArraySet,BlockingDeque}.java
> 源码量: ~20 文件 / ~30,000 行 | 🔴 巨型域(拆 6 篇)
> 写作层: Layer 5(前置: 域 09 Map、12 锁、13 原子;并发收官)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| ConcurrentHashMap.java (6380) | **存储结构**: table(778,volatile Node[])/Node(含 hash 位)/TreeBin(-2,树根)/ForwardingNode(2223,扩容转发)/ReservationNode(2260)、CAS 三操作 tabAt(759)/casTabAt(763)/setTabAt(768) | High |
| CHM | **putVal 流程**(1010): 空桶 CAS(1018-1019)/非空桶 synchronized(f)(1031)/树插入/计数;无锁读 get(934) | High |
| CHM | **扩容**: initTable(2283,sizeCtl 控制)/resizeStamp/transfer(ForwardingNode 协助,多线程扩容)/transferIndex(805) | High |
| CHM | **计数**: baseCount(790)+CounterCell[] counterCells(815)/addCount(2316)/size(909)/mappingCount(2166)——分片计数(域 13 LongAdder 同思想) | High |
| ConcurrentSkipListMap.java (3416) | **跳表**: Node(359)+Index(373)多层索引、doGet(536)/doPut(595)——无锁有序 Map | High |
| CopyOnWriteArrayList.java (1610) | **写时复制**: volatile Object[] array(105)+写时 Arrays.copyOf(157)/get 无锁(397) | High |
| ConcurrentLinkedQueue.java (1075) | **无锁队列**: CAS 链接(head/tail,惰性更新) | Medium |
| BlockingQueue.java | **阻塞契约**: put/take(231/261 阻塞)/offer/poll(timeout)(251/275)/remainingCapacity(291) | High |
| ArrayBlockingQueue.java (1635) | **有界队列**: 单 ReentrantLock(120)+双 Condition notEmpty/notFull(123/126)/items(103)/enqueue(176)/dequeue(191) | High |
| LinkedBlockingQueue.java (1159) | **无界/有界链表队列**: 双锁(head/tail 锁)+Condition | High |
| SynchronousQueue.java (1202) | **交接队列**: 无容量,put 与 take 直接配对(transfer) | Medium |
| DelayQueue.java (537)/PriorityBlockingQueue.java (1118) | **延迟/优先阻塞**: DelayQueue=PriorityBlockingQueue+到期判断 | Medium |
| LinkedTransferQueue.java (1749) | **传递队列**: transfer(阻塞直到接收者)——TransferQueue 接口 | Low |

*13 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | CHM 存储与 put/get | 1 (CHM) | 面试必考(并发读写的实现) |
| P1 | CHM 扩容与计数 | 1 (CHM) | 面试高频(协助扩容/分片计数) |
| P1 | 阻塞队列族 | 6 | 面试高频(各队列语义/线程池依赖) |
| P1 | CopyOnWrite | 2 | 面试常问(读写分离语义) |
| P2 | 跳表 | 2 | 面试偶尔(有序并发) |
| P2 | 无锁队列 | 2 | 面试偶尔(CAS 链接) |
| P3 | TransferQueue | 1 | 面试低频 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | CHM put/get/扩容 | 面试必考(无锁读+细粒度锁/CAS+同步组合) |
| 🔴 Deep | CHM 计数 | 面试常问(分片计数) |
| 🔴 Deep | 阻塞队列语义 | 面试高频(put/take 阻塞/线程池核心) |
| 🔴 Deep | CopyOnWrite | 面试常问(读多写少) |
| 🟡 Working | 跳表 | 面试偶尔 |
| 🟢 Surface | TransferQueue 细节 | 面试低频 |

## 04 聚类

### 依赖图(域内)
```
ConcurrentHashMap(CAS+锁) ←── 域 13 CAS/域 12 synchronized
ConcurrentSkipListMap(跳表) ←── 有序并发
CopyOnWriteArrayList(volatile+复制) ←── 读多写少
BlockingQueue 族 ←── 域 12 ReentrantLock+Condition
ConcurrentLinkedQueue(CAS) ←── 无锁
线程池(域 14) ←── 使用 BlockingQueue
```

### 教学顺序与文章拆分(6 篇,巨型域)

1. **ConcurrentHashMap 存储与读写** — table/CAS 三操作、putVal(空桶 CAS+非空桶锁)、无锁读、Node/TreeBin
2. **ConcurrentHashMap 扩容与计数** — sizeCtl/transfer/ForwardingNode 协助扩容、CounterCell 分片计数、size/mappingCount
3. **ConcurrentSkipListMap 跳表** — Node/Index 结构、doPut/doGet、与 TreeMap 对比、SkipListSet
4. **CopyOnWrite 与无锁队列** — CopyOnWriteArrayList(volatile array+复制)、ConcurrentLinkedQueue(CAS 链接)、语义对比
5. **阻塞队列家族** — BlockingQueue 契约、ArrayBlockingQueue(单锁双条件)、LinkedBlockingQueue(双锁)、SynchronousQueue、Priority/Delay
6. **TransferQueue 与选型全景** — LinkedTransferQueue 语义、并发集合选型矩阵、与线程池衔接

> 前置: 域 09(哈希)、12(锁)、13(CAS)。跨层: 无 native;CHM 与域 09 HashMap 结构对照
