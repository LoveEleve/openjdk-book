# 03. 引用原子类与 FieldUpdater — AtomicReference、ABA 解、内存优化

> 🟡 Working | 域 13 原子类第 3 篇 | Layer 3
> 读者处境: 面试"AtomicReference 干什么用""ABA 怎么解""FieldUpdater 省什么内存"——引用类原子操作全家族。

### 1. "AtomicReference 是什么？" — 引用 CAS

场景: 并发环境下安全替换"配置对象/游标"——AtomicReference 的用法

- `AtomicReference.java:440` — volatile V value + CAS(与 AtomicInteger 同构,值类型是引用)
- `AtomicReference.java:168` `getAndSet` / `183` `getAndUpdate`(函数式)
- 应用: 无锁栈/队列(域 12 对照)、配置热更新(整体替换不可变对象)、单例初始化
- 关键设计 (斜体): *"原子替换引用" = 用不可变对象 + 引用 CAS 实现"无锁读替换"——读方永远拿到完整旧/新对象(不撕裂);生产"配置热更新"的标准实现*
- 面试: "AtomicReference vs volatile 引用"——volatile 只保证可见性;CAS 保证"替换"的原子比较

### 2. "AtomicStampedReference 怎么解 ABA？" — 版本戳

场景: 面试"ABA 的解决方案"——stamp 是什么

- `AtomicStampedReference.java:55` — `private static class Pair<T>` — **reference + stamp 打包成不可变对**(原子更新二者)
- `AtomicStampedReference.java:148` `compareAndSet(expectedRef, newRef, expectedStamp, newStamp)` — 引用和戳**同时** CAS(单次 Pair CAS)
- 用法: 每次修改戳 +1;ABA(A→B→A)时戳从 n→n+1→n+2,expectedStamp 不匹配 → 拒绝
- `AtomicMarkableReference.java:55` — mark(bool)版本(只关心"是否被改过",不计数)
- 关键设计 (斜体): *"戳"是操作计数——把"值相同"升级为"版本相同";面试答"用版本号区分 A→B→A"就抓住了;Markable 适合"只标记一次"场景*
- 面试: "Stamped vs Markable"——计数戳 vs 布尔标记;无锁栈/队列用 Stamped(域 12 扩展)

### 3. "FieldUpdater 是什么？" — 免包装的字段原子化

场景: 面试"为什么有 FieldUpdater"——AtomicInteger 包装对象的开销

- `AtomicIntegerFieldUpdater.newUpdater(T.class, "count")` — **对已有对象的 volatile int 字段做原子操作**,不创建包装对象
- `AtomicIntegerFieldUpdater.java:115` `compareAndSet(T, expect, update)` — 内部 Unsafe 按字段偏移操作(434: `U.objectFieldOffset(field)`)
- 前提: 目标字段必须 volatile + 非 static(否则 IllegalArgumentException)
- 关键设计 (斜体): *FieldUpdater 的价值: ① 省内存(百万对象不必各带一个 AtomicInteger)② 复用同一 updater(静态单例)③ 约束: 字段需 volatile;性能与 AtomicInteger 相当(同偏移 CAS)*
- 面试: "FieldUpdater vs AtomicInteger 字段"——内存 vs 对象化;生产: 大对象数组/批量实体用 FieldUpdater
- [关联: 域 04 反射(字段访问);域 32 Unsafe 偏移]

### 4. "选型" — 原子家族决策

场景: 并发计数/状态/引用的完整选型

- 单值计数: AtomicLong(低竞争)/LongAdder(高竞争)
- 引用替换: AtomicReference;ABA 敏感: StampedReference
- 数组元素: Atomic*Array(JDK9+ VarHandle 实现)
- 已有对象字段: FieldUpdater(省内存)
- 自定义聚合: LongAccumulator/DoubleAccumulator
- 关键设计 (斜体): *选型三问: 竞争高不高(决定 Atomic vs Adder)/值还是引用(决定类型)/能不能接受包装对象(决定 FieldUpdater)——面试选型题按这三问答*
- 面试: "原子家族全览"——值/引用/数组/字段/分片五族,每族一个代表

---

### 核心悬念

原子操作只是"单点无锁"——**更复杂的并发控制**呢?公平锁怎么排队?读写锁怎么区分?AQS 用一个 state + 等待队列实现所有同步器——面试必考大魔王: 下一篇(按写作顺序)先到域 12 锁与同步器。

> → 下一篇: 域 12 锁与同步器(12-lock-sync 系列,AQS) | 关联: 域 14 线程池
