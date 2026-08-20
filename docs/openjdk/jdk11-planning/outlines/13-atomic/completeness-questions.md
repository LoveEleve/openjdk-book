# 域 13: 原子类 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "AtomicInteger 怎么实现(volatile+CAS)" — 01 篇 §1(AtomicInteger.java:64/62)
- [x] "volatile 能替代吗(i++ 非原子)" — 01 篇 §1
- [x] "compareAndSet vs weakCompareAndSet" — 01 篇 §2(133/154)
- [x] "getAndIncrement 实现(CAS 循环)" — 01 篇 §3(180, Unsafe.getAndAddInt)
- [x] "高并发计数为什么用 LongAdder" — 02 篇 §1-2(Striped64.java:158/164, LongAdder.java:85)
- [x] "伪共享是什么/@Contended" — 02 篇 §3(Striped64.java:124)
- [x] "ABA 怎么解(StampedReference)" — 03 篇 §2(AtomicStampedReference.java:55/148)
- [x] "FieldUpdater 省什么" — 03 篇 §3(AtomicIntegerFieldUpdater.java:115/434)
- [x] "原子家族选型" — 03 篇 §4

## 身份 2: 生产工程师
- [x] 高并发计数器选型(Adder vs Atomic)— 02 篇 §4
- [x] 配置热更新(AtomicReference)— 03 篇 §1
- [x] 统计指标(Adder+Accumulator)— 02 篇 §4
- [x] 大对象数组内存优化(FieldUpdater)— 03 篇 §3

## 身份 3: 框架工程师
- [x] 无锁数据结构(CAS 循环)— 01 篇 §3
- [x] AQS/CHM 的原子依赖 — 01-03 篇 OUTBOUND
- [x] 监控指标库(Accumulator)— 02 篇 §4

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 AtomicInteger.java:62/64/87/97/108/119/133/154/168/180/215/253/275/410/432, Striped64.java:124/125/158/164/169/180/191/228/241-253, LongAdder.java:85/99/119, AtomicStampedReference.java:55/148, AtomicMarkableReference.java:55, AtomicIntegerFieldUpdater.java:115/379/434, AtomicReference.java:168/183, AtomicIntegerArray.java:55/94/220)/关键设计/跨层([x86]/[内部卷])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] JDK11 实测: AtomicIntegerArray 用 VarHandle(MethodHandles.arrayElementVarHandle:55),非 JDK8 的 Unsafe 偏移——KP 已修正

## 身份 5: 完整性缺口检查
- [x] CAS 封装(01)/分片计数(02)/引用家族(03)三篇覆盖域全部面试主战场
- [x] AtomicBoolean/Long/Reference 同构并入 01/03 篇
- [x] DoubleAdder/Accumulator(🟢)并入 02 篇 §4
- [x] 未覆盖确认: AtomicIntegerFieldUpdater 的 AtomicXXXFieldUpdaterImpl 子类细节(写作时提),数组原子 VarHandle 细节归域外(方法句柄)
- [x] 二次 review 修正: LongAdder 扩容细节精确化(初始化 new Cell[2]:282-283,双倍 Arrays.copyOf(cs, n<<1):272-273,NCPU 停扩:266);DoubleAdder 位模式实测(long 存位但运算转 double,DoubleAdder.java:93-100);FieldUpdater volatile 检查实测(419-420 "Must be volatile type")
- [x] 验证通过: weakCompareAndSet→U.weakCompareAndSetIntPlain(154)、getAndAddInt 委托(180)、StampedReference Pair 比较(148-157)
- [ ] 待办: 写作时验证 longAccumulate 的扩容细节(241-253 区域精确行)、sum 的 Cell 遍历顺序
