# 01. Object 的方法契约与对象生命周期 — 六方法 + 四种引用

> 🔴 Deep | 域 03 对象与系统第 1 篇 | Layer 1
> 读者处境: 面试官从 "Object 有哪些方法" 开始连环追问——每个方法背后的契约与 native 实现,以及 finalize 为什么被弃用、Cleaner 怎么替代它。

### 1. "Object 的六个方法为什么大多是 native？" — JVM 契约

场景: 面试"Object 有哪些方法"——答出六个,还要能说出哪些是 native、为什么

- `Object.java:72` `public final native Class<?> getClass()` — 从对象头拿 Klass 指针(内部卷 06-oops)
- `Object.java:109` `public native int hashCode()` — 默认实现: 对象头中的随机数/Marsaglia 位移(内部卷 markOop hash 位)
- `Object.java:157` `public boolean equals(Object obj)` — 默认 = 引用比较(`return this == obj`)
- `Object.java:222` `protected native Object clone()` — **浅拷贝**: 位级复制字段,数组有特殊路径;不实现 Cloneable 抛 CloneNotSupportedException
- `Object.java:245` `public String toString()` — `getClass().getName() + "@" + Integer.toHexString(hashCode())`
- `Object.java:558` `protected void finalize()` — **空实现**,JDK9 起 `@Deprecated(since="9")`
- 关键设计 (斜体): *native 方法的共性: 语言层面无法表达(getClass 需要对象头信息;hashCode 需要 JVM 内部状态;clone 需要位级操作)。equals/hashCode 留在 Java 侧让子类覆写——契约由 Java 层维护*
- 面试点: "为什么重写 equals 必须重写 hashCode"——HashMap 先算 hash 定位桶再 equals 确认

### 2. "hashCode-equals 契约是什么？" — 一致性三规则

场景: 生产 bug——对象放进 HashSet 后改了字段,为什么再也删不掉?

- 契约: ① equals 相等 ⇒ hashCode 必相等(反之不成立)② hashCode 在对象生命周期内稳定 ③ 与 equals 对称/传递/自反
- `hashCode()` 违反的后果: HashMap/HashSet 中对象进桶后 hash 变化 → 永远找不到
- 关键设计 (斜体): *契约的本质是"哈希表正确性的前置条件"——Java 用文档强制(Javadoc 契约),C++ 的 unordered_map 靠用户自觉;面试答"违反契约会导致集合类失效"比背规则有区分度*
- [Object Javadoc: hashCode 的规范说明"不要求与对象内存地址相关"— JVM 默认实现与地址无关,避免 GC 移动对象后 hash 变化(实现细节见内部卷 markOop)]

### 3. "finalize 为什么被弃用？" — Finalizer 与 Cleaner

场景: 生产代码还有 finalize 做资源清理——JDK 官方态度是什么?

- `finalize` 的问题: ① 清理时机不确定(依赖 GC 触发 Finalizer 线程)② Finalizer 队列延迟对象回收(对象进 F 队列后还要等 Finalizer 线程跑)③ 异常被吞 ④ 可复活对象(重新赋值 this)
- `Finalizer.java` — Finalizer 线程消费队列,调 finalize
- 替代: `Cleaner`(`java/lang/ref/Cleaner.java:131`)— 基于 PhantomReference 的显式清理回调(`create()` 工厂,`Cleaner.java:173`)
- 关键设计 (斜体): *Cleaner 的设计: 用虚引用跟踪对象死亡(PhantomReference.get 恒 null),清理动作放独立线程——时机可控、异常不吞、不复活;典型应用: DirectByteBuffer 堆外内存释放(域 19/32 展开)*
- 面试点: "JDK9 后不要用 finalize;资源清理用 try-with-resources 或 Cleaner"

### 4. "四种引用是怎么工作的？" — 引用强度状态机

场景: 面试"软引用和弱引用的区别";生产: 缓存为何用 WeakHashMap/软引用做内存敏感缓存

- 强度梯度: 强引用 > 软引用(SoftReference,内存不足才回收)> 弱引用(WeakReference,GC 即回收)> 虚引用(PhantomReference,仅跟踪,get 恒 null)
- `Reference.java:151` — `private T referent;`(GC 特殊处理: 可达性分析时按引用类型分派)
- `Reference.java:161` — `volatile ReferenceQueue<? super T> queue` / `Reference.java:171` — `volatile Reference next` — 入队链表
- `Reference.java:190` — **ReferenceHandler 线程**: 守护线程,处理 pending 链表 → 入队/分派 Cleaner 动作
- 状态机(Reference.java 注释,47-130): active(可达,referent 有效)→ pending(GC 标记,等 ReferenceHandler)→ inactive(入队后,referent=null)
- 关键设计 (斜体): *四种引用 = 可达性分析的四个等级(内部卷 GC reachability);软/弱/虚的差异只在 GC 触发的时机与存活策略——JVM 侧实现(JVM Spec: 可达性定义),Java 侧负责队列与回调*
- 生产: ThreadLocal 的内存泄漏(弱引用 key + 强引用 value)是四种引用的经典面试题(域 11 展开)
- [内部卷: 25-gc-framework 03-reference-processing(引用处理与 pending 链);JVM Spec §2.2.1 对象引用]

---

### 核心悬念

对象是"值+方法",但**进程级的全局状态**——时间、属性、GC 控制、关闭钩子——都藏在 System 和 Runtime 两个门面类里。下一篇: 这些门面方法哪些是 native?nanoTime 和 currentTimeMillis 有什么坑?

> → [02-system-runtime.md](02-system-runtime.md)
