# 域 08: 集合框架 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "ArrayList 扩容机制(1.5x/默认 10/懒分配)" — 01 篇 §1-2(ArrayList.java:116/136/255-258)
- [x] "ArrayList vs LinkedList(增删/随机访问)" — 01 篇 §3 / 02 篇 §1-2(LinkedList.java:92/97/144)
- [x] "Vector 为什么被淘汰/Stack 为什么反模式" — 02 篇 §3-4(Vector.java:825, 接口污染)
- [x] "ArrayDeque 环形数组/栈用什么" — 03 篇 §1(ArrayDeque.java:111/141/285)
- [x] "PriorityQueue 堆结构/offer-poll 复杂度" — 03 篇 §2(PriorityQueue.java:101/338/586/650/691/740)
- [x] "fail-fast 原理(ConcurrentModificationException)" — 04 篇 §1-3(AbstractList.java:628, ArrayList.java:983/603)
- [x] "Arrays.sort 算法选择(DPQ vs TimSort/稳定性)" — 05 篇 §1-2(Arrays.java:146/1245/1249)
- [x] "Collections 三包装器/为什么不用 synchronizedList" — 06 篇 §1-3(Collections.java:1287/2385/3040)

## 身份 2: 生产工程师
- [x] 遍历删除抛 CME 的正确姿势(removeIf/迭代器 remove) — 04 篇 §2-3
- [x] 集合预分配避免扩容 — 01 篇 §2
- [x] 对外暴露集合包 unmodifiable — 06 篇 §1
- [x] 大数组排序 parallelSort — 05 篇 §4

## 身份 3: 框架工程师
- [x] 装饰器模式(unmodifiable/checked 视图)— 06 篇
- [x] 排序稳定性(TimSort)对业务排序的意义 — 05 篇 §2
- [x] 队列语义(offer/add 契约)与有界队列 — 03 篇 §3

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 ArrayList.java:116/136/143/228/237/242/255-258/458/497/535/557/564/603/669/983, AbstractList.java:628, LinkedList.java:87/92/97/144/175/194, Vector.java:103/122/825, ArrayDeque.java:111/119/126/141-158/285/377, PriorityQueue.java:101/112/338/586/650/691/740, Arrays.java:146-147/675/1245-1249/1866/3688/3949/4309/4888, DualPivotQuicksort.java, ComparableTimSort.java, Collections.java:144/378-388/425/496/1023/1287/2000/2385/3040/4448/4822/5503)/关键设计/跨层/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] ArrayDeque 扩容实测: grow jump 策略(141,<64 +2/否则 +50%),非 doubleCapacity——KP 已修正
- [x] 二次 review 修正: ArrayDeque 回绕为 dec/inc 条件回绕(addFirst 289/addLast 307),JDK8 的 & mask 已删(JDK9+ 非 2 的幂);Collections.sort 委托 List.sort default(504: toArray→Arrays.sort→listIterator.set);ListItr(1050);Node(974);node(int)(570)
- [x] DPQ 阈值实测: INSERTION_SORT_THRESHOLD=47(73)/QUICKSORT_THRESHOLD=286(67)/COUNTING_SORT 29 与 3200(79/85);DEFAULTCAPACITY_EMPTY_ELEMENTDATA(128);Vector 默认 2x(capacityIncrement=0,280)

## 身份 5: 完整性缺口检查
- [x] 巨型域 6 篇全拆(01 动态数组/02 链表历史类/03 队列堆/04 迭代器/05 Arrays/06 Collections),分段写作:1-4 批自查通过→5-6 批
- [x] Set 接口族语义已并入 01-06 篇(Collection 契约部分);具体 Set 实现(HashSet/TreeSet)归域 09(与 Map 关联)
- [x] RandomAccess 标记接口已覆盖(06 篇 §4)
- [x] 未覆盖确认: BitSet(面试低频)、EnumSet(域 09 关联)— 均🟢,不入篇
- [ ] 待办: 写作时验证 ArrayDeque 指针回绕的具体实现(head 递减的边界处理)、PriorityQueue 的 resize 逻辑(709 附近)、DualPivotQuicksort 的阈值常量(47 插入排序阈值)
