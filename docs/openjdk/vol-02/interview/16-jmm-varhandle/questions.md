# 16 · Java 内存模型、VarHandle 与并发原语：深度题目

## 1. Java `volatile` 在 HotSpot 里落地为什么不是“给字段加一个 volatile 就完事”？

Java 语言用 `volatile` 保证可见性和禁止重排。这个约束在 HotSpot 的字段访问、OopMap、GC 和 JIT 各层分别需要什么来兑现？

回答必须覆盖：

- volatile 读在 x86 上为什么不需要硬件屏障，但 volatile 写后读需要 `storeload`；
- `OrderAccess::loadload/storestore/loadstore/storeload` 四屏障与 x86 TSO 的对应关系；
- 为什么 `lock addl $0,0(%rsp)` 比 `mfence` 更常用；
- C2 编译期如何识别 volatile 访问并插入对应屏障；
- 解释器、C1 和 C2 对 volatile 的处理是否一致。

追问：如果 x86 已经保证 `loadload`/`storestore`/`loadstore`，为什么 volatile 写仍然需要 `storeload` 屏障？这个屏障保护的是 volatile 写之后哪条指令的什么重排问题？

源码入口：`share/runtime/orderAccess.hpp:258`、`os_cpu/linux_x86/orderAccess_linux_x86.hpp:40`、`share/oops/accessBackend.inline.hpp:135`、`share/opto/library_call.cpp:2420`。

## 2. JMM happens-before 为什么不是运行时的一条“检查指令”？

JSR-133 定义了一套 happens-before 规则。HotSpot 为什么不在运行时逐条对证，而是提前在字节码、JIT 和屏障级别让“happens-before 自然成立”？

回答必须覆盖：

- happens-before 是可见性证明，不是运行时可查询的计数器；
- volatile 写-读、锁释放-获取、线程启动-结束各自对应哪类屏障/协议；
- 为什么 happens-before 的“传递性”在实现上不需要显式传递代码；
- 为什么 JVM 更关心“在正确的位置插入屏障/状态转换”，而不是在运行时检查日志；
- 偏向锁/轻量锁/重量锁的 acquire/release 语义差别。

追问：如果两个线程之间没有 happens-before 边，在 x86 上最坏情况下的“延迟可见”可以到多久？如果 JVM 运行时真的在每条 volatile 读写后检查全局可见性计数器，会怎样破坏性能？

源码入口：`share/runtime/orderAccess.hpp:258`、`share/runtime/interfaceSupport.inline.hpp:558`、`share/oops/accessBackend.inline.hpp:135`、`share/opto/parse1.cpp:620`。

## 3. VarHandle 的 `getAcquire`/`setRelease` 与 Java 的 `volatile` 读/写到底是不是同一个东西？

VarHandle 提供了 `getAcquire`/`setRelease`/`getOpaque`/`setVolatile`/`compareAndSet` 等访问模式。它们与普通 `volatile` 字段访问在 HotSpot 屏障级别有什么不同？

回答必须覆盖：

- acquire/release 语义与 full volatile 的差异；
- opaque 访问在 JMM 中意味着什么，在 HotSpot 中如何实现；
- VarHandle 的 `compareAndSet` 与 `WeakCompareAndSet` 在 JMM 层次的差异；
- 为什么 `getAcquire` 在 x86 上可能不需要额外硬件屏障；
- VarHandle 与 `Unsafe` 的 get/put/putOrdered 方法在语义上的继承关系。

追问：如果 `getAcquire` 在 x86 上不需要屏障，那它和 plain load 有什么区别？什么场景下 `getOpaque` 比 `getAcquire` 更合适？

源码入口：`java.base/share/classes/java/lang/invoke/VarHandle.java:43`、`java.base/share/classes/jdk/internal/vm/annotation/ForceInline.java:29`、`share/oops/accessBackend.inline.hpp:135`。

## 4. `Unsafe.compareAndSet` 为什么能直接映射到 HotSpot 的 `Atomic::cmpxchg`？

Unsafe 的 CAS 在 Java 侧看起来像一个 API，HotSpot 侧为什么能直接降成一条 `lock cmpxchg`，而不需要中间翻译层？

回答必须覆盖：

- `Unsafe_CompareAndSetLong` 的 JVM 入口路径；
- `Atomic::cmpxchg` 在 x86 上的 `lock cmpxchg` 指令对应；
- 为什么 CAS 操作本身已经自带 acquire/release/volatile 语义；
- 弱 CAS 和强 CAS 在 JVM 层面如何区分；
- 为什么 CAS 在 x86 上总是全屏障，但在 ARM 上可能不是。

追问：如果 CAS 在 x86 上总是全屏障，那 `WeakCompareAndSetPlain` 在 x86 上是否也没有节省下来自屏障的代价？什么场景下弱 CAS 仍然有意义？

源码入口：`share/prims/unsafe.cpp:215`、`share/runtime/atomic.hpp:129`、`os_cpu/linux_x86/atomic_linux_x86.hpp:72`、`java.base/share/classes/jdk/internal/misc/Unsafe.java:111`。

## 5. `final` 字段在 JMM 中为什么需要特殊规则，而不是普通 volatile？

`final` 字段在构造函数中赋值后，不需要 volatile 却能在另一个线程安全读取。HotSpot 如何保证 `final` 字段的“初始化安全”？

回答必须覆盖：

- JMM 中 `final` 的特殊规则：构造函数结束与 `freeze`/`storestore` 屏障；
- 为什么 `final` 字段不需要 volatile 写对应的 `storeload` 屏障；
- 为什么 `final` 字段在构造函数中逃逸后可能会失效；
- C2 如何识别 `final` 字段并插入 `storestore` 屏障；
- 反射/Unsafe 修改 `final` 字段后为什么可能看到旧值。

追问：如果一个对象通过 `this` 逃逸了，它的 `final` 字段为什么可能被另一个线程看到默认值？构造函数结束后是否一定保证所有 `final` 字段已对其他线程可见？

源码入口：`share/opto/parse1.cpp:999`、`share/opto/macro.cpp:1518`、`java.base/share/classes/java/lang/ref/FinalReference.java:33`。

## 6. 为什么“Java 内存模型”在 HotSpot 里不是以内存模型库的形式存在，而是分布在屏障、状态转换、GC 协议和锁中？

JMM 的 happens-before、volatile、final 和锁语义在 HotSpot 中并没有集中在一个“JMM 引擎”里。它们为什么分散在 OrderAccess、synchronized、JIT、GC 和线程状态转换中？

回答必须覆盖：

- volatile 读写的屏障在哪里插入；
- 锁的 acquire/release 语义如何通过 ObjectMonitor 实现；
- 线程启动的 happens-before 如何保证；
- 线程中断、Thread.join 和 Future.get 的语义如何落到 JVM 的线程状态转换协议中；
- 为什么 GC 的 safe point 需要和 JMM 的可见性交错处理。

追问：如果把 JMM 集中实现成“访问时检查 happen-before 图”的运行时引擎，会破坏哪些设计约束？为什么“分散实现”是 HotSpot 的必然选择？

源码入口：`java.base/share/classes/java/lang/Thread.java:748`、`share/runtime/orderAccess.hpp:258`、`share/runtime/interfaceSupport.inline.hpp:558`、`share/oops/accessBackend.inline.hpp:135`、`share/runtime/objectMonitor.cpp:369`。

## 7. 跨平台 JMM 的“最小公分母”为什么不是 x86 的 TSO，而是更弱的模型？

JMM 定义了一套比 x86 TSO 更弱的规则，而 x86 上很多屏障实际上退化为 `compiler_barrier`。为什么 JMM 不直接规定 x86 模型？

回答必须覆盖：

- TSO 保证 loadload/storestore/loadstore，不保证 storeload；
- ARM/Power 的弱一致性模型要求更多显式屏障；
- “最小公分母”不是 x86，而是让所有平台都满足 JMM 规则的最少约束；
- 为什么 JMM 不定义“x86 上 volatile 写不需要屏障”这种平台优化；
- barrier 在 HotSpot 中如何通过 `OrderAccess` 被抽象成平台无关接口。

追问：如果 JMM 直接采用 x86 TSO 模型，ARM 实现会多付出多少屏障成本？如果 JMM 采用 ARM 的最弱模型，x86 上又会多出多少不必要的屏障？

源码入口：`share/runtime/orderAccess.hpp:258`、`os_cpu/linux_x86/orderAccess_linux_x86.hpp:40`。