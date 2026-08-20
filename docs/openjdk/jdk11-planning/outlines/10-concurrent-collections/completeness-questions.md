# 域 10: 并发集合 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "CHM 怎么并发(无锁读+桶锁写)" — 01 篇 §1-3(ConcurrentHashMap.java:759/763/1010-1068)
- [x] "CHM 扩容怎么并发(协助)" — 02 篇 §1-2(sizeCtl 800/transferIndex 805/helpTransfer 1023)
- [x] "CHM size 准吗(分片计数)" — 02 篇 §3(baseCount 790/counterCells 815/sumCount)
- [x] "JDK7 分段锁 vs JDK8 桶锁" — 01 篇 §3
- [x] "跳表 vs 红黑树" — 03 篇 §1(ConcurrentSkipListMap.java:359/373)
- [x] "COW 原理/适用" — 04 篇 §1-2(CopyOnWriteArrayList.java:105/428/397)
- [x] "无锁队列(CLQ)" — 04 篇 §3(ConcurrentLinkedQueue.java:239/354)
- [x] "阻塞队列四组方法/原理" — 05 篇 §1-3(BlockingQueue.java:231/261, ABQ:120/123/126/176/191, LBQ:156-165)
- [x] "SynchronousQueue 容量/交接" — 05 篇 §4(871)
- [x] "transfer vs put" — 06 篇 §1(LTQ:662)
- [x] "并发集合选型" — 06 篇 §2

## 身份 2: 生产工程师
- [x] 并发缓存/白名单(COW)— 04 篇 §2
- [x] 线程池队列选型 — 06 篇 §4
- [x] 延迟任务(DelayQueue)— 05 篇 §4

## 身份 3: 框架工程师
- [x] 监听器表(域 34 同源 COW)— 04 篇 §2
- [x] 线程池 workQueue 机制 — 06 篇 §4

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 ConcurrentHashMap.java:508/514/526/545/591-593/594/696/759/763/768/778/790/800/805/815/909/934/1010-1068/1115-1140/2166/2223/2260/2283/2316, ConcurrentSkipListMap.java:337/359/373/536/595/829/845, CopyOnWriteArrayList.java:105/111/144/157/372/397/428-433, ConcurrentLinkedQueue.java:184/239/354, BlockingQueue.java:231/251/261/275/291, ArrayBlockingQueue.java:103/120/123/126/176/180/191/195/361, LinkedBlockingQueue.java:156-165, SynchronousQueue.java:174/215/525/871/919, DelayQueue.java:81/143/195/210-219, LinkedTransferQueue.java:662/1268-1293)/关键设计/跨层([关联])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] 巨型域 6 篇分段写作:1-3 批自查通过→4-6 批

## 身份 5: 完整性缺口检查
- [x] CHM 读写(01)/扩容计数(02)/跳表(03)/COW 无锁(04)/阻塞队列(05)/选型(06)六篇覆盖域全部面试主战场
- [x] BlockingDeque/PriorityBlockingQueue 并入 05 篇提及
- [x] 未覆盖确认: CHM 的 compute/merge 原子复合操作(面试偶尔,写作时并入 02 篇提及)、ConcurrentLinkedDeque 双端 CAS 细节
- [x] 二次 review 修正: CSLM/CLQ 的 CAS 链接实为 **VarHandle NEXT.compareAndSet**(CSLM 421/427+3399,CLQ 316/1058),非"casNext 方法名"(JDK9+ 用 VarHandle 替代 Unsafe 偏移);CHM transfer stride 分块实测(NCPU>1 ? (n>>>3)/NCPU : n,2418-2419 + transferIndex 从尾认领 2430-2440)
- [x] 验证通过: CSLM 删除用 marker 节点+unlinkNode(注释 175/181)、CLQ HEAD/ITEM/NEXT 三个 VarHandle、SQ TransferStack/TransferQueue 双实现
- [ ] 待办: 写作时验证 CHM transfer 的 stride 分块细节、CLQ 的哨兵节点初始化、SynchronousQueue 的公平栈/队选择
