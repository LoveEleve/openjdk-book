# 01. Throwable 内部结构 — 堆栈快照、cause 链、suppressed 异常

> 🔴 Deep | 域 06 异常体系第 1 篇 | Layer 0
> 读者处境: 日志里"Suppressed:"和"Caused by:"大家都见过——但 Throwable 内部怎么存这些?为什么 JDK7 之后堆栈可能"丢失"?逐字段看懂。

### 1. "异常对象里到底存了什么？" — 三个核心字段

场景: `throw new RuntimeException("x")` 之后,这个对象里有什么?

- `Throwable.java:211` — `private StackTraceElement[] stackTrace = UNASSIGNED_STACK;` — 栈帧快照数组
- `Throwable.java:232` — `private List<Throwable> suppressedExceptions = SUPPRESSED_SENTINEL;` — 被抑制异常列表(默认共享空列表常量,`Throwable.java:220`)
- `Throwable.java:419` — `public synchronized Throwable getCause()` — 原因链(自引用)
- `Throwable.java:254` — 构造器调用 `fillInStackTrace()`(784,Java 入口)→ 内部调用私有 **native** `fillInStackTrace(0)`(`Throwable.java:793`)在抛出点抓取当前线程栈帧生成快照
- 关键设计 (斜体): *构造时就抓栈(不是 throw 时)——栈快照反映的是"创建异常"的位置;`fillInStackTrace` 是 native,遍历 JVM 栈帧(内部卷: 栈遍历),这就是"抛异常慢"的根源: 一次栈遍历 + 数组分配*
- 性能认知: `new Exception()` 比普通对象慢**一个数量级以上**(取决于栈深度)——生产上异常驱动的控制流(用异常做条件判断)是反模式

### 2. "Caused by 是怎么来的？" — cause 链

场景: 包装异常 `new BizException(e)` — e 怎么传到最外层?

- `Throwable.java:291` 构造 `Throwable(String message, Throwable cause)` → 内部 `initCause(cause)`
- `Throwable.java:314` 构造 `Throwable(Throwable cause)` — 常用简写
- 链的遍历: `getCause()` 沿引用走(每层包装一个 cause)——日志打印时 `printStackTrace` 递归输出 "Caused by"
- 关键设计 (斜体): *cause 只允许设置一次(第二次抛 IllegalStateException)——防止共享异常对象被多线程改写 cause 链;检查: `cause == this` 抛 IllegalArgumentException(防自引用循环)*
- 面试/生产: 日志分析"看 Caused by 从下往上读根因";框架包装异常时保留 cause 是规范

### 3. "Suppressed 是什么？" — try-with-resources 的关闭失败

场景: try-with-resources 里 close() 抛异常——原始异常去哪了?

- `Throwable.java:902` `addSuppressed` 把关闭异常附加到主异常的 suppressed 列表
- 懒初始化: 第一次 addSuppressed 才 new ArrayList(替换 `SUPPRESSED_SENTINEL`)——99% 的异常没有 suppressed,省内存
- `printStackTrace` 输出 "Suppressed: ..." 段(`Throwable.java:665` 遍历)
- 关键设计 (斜体): *try-with-resources 编译为 try/finally,finally 里 close() 的异常若直接抛出会覆盖 try 块的原始异常(JDK6 及之前)——suppressed 机制(JDK7)让两个异常都保留;JDK9 起 `addSuppressed` 增加自抑制检查(`exception == this` 抛 IAE,`Throwable.java:1052`)*
- 面试点: "try-with-resources 关闭失败时主异常和关闭异常的关系" — suppressed

### 4. "堆栈怎么没打出来？" — UNASSIGNED 与 fillInStackTrace 的禁用

场景: 生产日志异常堆栈为空/只有一行——为什么?

- `Throwable.java:784` `fillInStackTrace()` 返回 this(链式)
- 关闭堆栈: `new Exception() { fillInStackTrace() } ` 匿名类覆盖为空实现,或 `Throwable(String, cause, enableSuppression, writableStackTrace)` 四参构造传 false
- 效果: 堆栈不抓 → 异常创建极快(JIT 编译下的"轻量异常"模式,JDK9 起 JIT 对无栈异常的优化)
- 关键设计 (斜体): *有状态系统(如 JVM 内部)故意禁用堆栈避免开销;代价是问题不可定位——生产排查时"无栈异常"是反模式但要知道它存在*
- [JVM Spec: §6.5 athrow;内部卷: 栈帧遍历(StackTrace 生成路径)]

---

### 核心悬念

Throwable 是"错误通道",但它的**类型体系**决定了一个异常是必须处理的(checked)还是可以不管的(unchecked)——面试官的问题来了: 什么算受检异常?Spring 为什么把一切包成 RuntimeException?

> → [02-exception-hierarchy.md](02-exception-hierarchy.md)
