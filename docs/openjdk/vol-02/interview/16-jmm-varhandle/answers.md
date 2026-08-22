# 16 · Java 内存模型、VarHandle 与并发原语：专家答案锚点

## 1. volatile 在 HotSpot 中落地 = 语义标注 + 屏障插入 + 编译器约束

Java `volatile` 不是 JVM 内部的一个“标志位”。它通过多层共同兑现：

- C2 编译期在 volatile 写后插入 `storeload` 屏障，在 volatile 读前可能插入 `loadload`/`loadstore` 屏障。
- `OrderAccess` 四屏障在 x86 上的具体实现是三个 `compiler_barrier` + 一个 `lock addl`（`os_cpu/linux_x86/orderAccess_linux_x86.hpp:40`）。
- 解释器、C1、C2 对 volatile 的处理路径不同，但结果一致：volatile 写后必须有 `storeload` 屏障，防止 volatile 写与后续 volatile 读或普通 load 重排。
- x86 TSO 保证 `loadload`/`storestore`/`loadstore`，但 volatile 写后读仍然可能被 store buffer 延迟，所以 `storeload` 在 x86 上仍然需要，用 `lock addl $0,0(%rsp)` 或 `mfence` 实现。

## 2. JMM happens-before 是证明规则，不是运行时检查

Happens-before 是 JMM 定义的一种“可见性证明”规则，不是 JVM 运行时逐条验证的检查。JVM 不需要在运行时问“这条读是否 happens-before 那条写”，只需要保证在正确的位置插入屏障/状态转换，使得任何符合程序顺序的访问都能满足 JMM 的可见性要求。

因此 volatile 写-读、锁释放-获取、线程启动-结束，各自对应不同的屏障协议或状态转换路径，而不是一个统一的“happens-before 引擎”。如果 JVM 在每条 volatile 访问后都检查全局可见性计数器，代价会完全不可接受。

## 3. VarHandle 的访问模式是 JMM 访问分类的 Java API 映射

VarHandle 提供的 `getAcquire`/`setRelease`/`getOpaque`/`setVolatile` 不是新发明的语义，而是 JMM 中定义的访问模式的 Java API 映射：

- `setVolatile`/`getVolatile` 对应 volatile 变量的完整语义：可见性 + 禁止重排；
- `setRelease`/`getAcquire` 对应 release/acquire 语义：保证释放之前的所有写入在 acquire 后可见，但并不禁止 release 之前的操作与 release 之后的操作重排；
- `getOpaque` 只保证“在同一个线程内，对这个变量的访问不会被针对这个变量的重排所影响”；
- `compareAndSet` 是一个完整的 volatile read + volatile write 操作。

在 x86 上，acquire 读可能不需要额外硬件屏障（因为 TSO 已经保证 `loadload`），但编译器屏障和语义标注仍然存在。`getOpaque` 在 x86 上通常只需要编译器屏障，阻止针对性的编译重排。

## 4. Unsafe CAS 到 HotSpot Atomic 的映射是直接的

`Unsafe_CompareAndSetLong` 在 HotSpot 侧直接调用 `Atomic::cmpxchg`，后者在 x86 上降为 `lock cmpxchg`。CAS 本身就是全屏障（x86 上 `lock` 前缀保证全屏障语义），因此 CAS 返回后，调用者隐式获得了 volatile 读和 volatile 写的语义。

弱 CAS 与强 CAS 的区别在于：弱 CAS 允许在竞争条件下 spurious fail，不需要保证“如果值匹配则一定成功交换”。在 x86 上，由于 `lock cmpxchg` 总是保证强 CAS 语义，弱 CAS 在 x86 上几乎没有节省硬件开销。弱 CAS 的真正价值在于 ARM/LLSC 等弱一致性平台，可以减少重试循环和总线锁定。

## 5. final 的 JMM 规则通过 `storestore` 屏障实现

`final` 字段的 JMM 规则是：构造函数结束前，所有 `final` 字段的写入必须对其他线程可见。HotSpot 通过 C2 在构造函数末尾插入 `MemBarRelease` 屏障实现这一保证（`share/opto/parse1.cpp:999` 检查 `alloc_with_final()` 插入屏障；`share/opto/macro.cpp:1518` 处理分配消除时的屏障优化）。

- 为什么不需要 `storeload`？因为其他线程在构造函数执行期间不可能已经持有该对象的引用——发布引用本身发生在构造函数返回之后；
- 如果 `this` 逃逸（构造函数中把 this 发布给其他线程），`final` 语义可能被破坏，因为逃逸发生在 `storestore` 屏障之前；
- 构造函数结束后，`final` 字段的可见性保证是“发布对象的线程不需要额外操作，其他线程读取该对象时自动看到正确的 `final` 字段”。这不是 volatile，不需要每次读都走屏障。

## 6. JMM 在 HotSpot 中必须分散实现，因为 JMM 不是一条“边界”

JMM 的 happens-before 规则覆盖了程序执行的所有方面：volatile 读写、锁、线程启动、线程中断、`Thread.join`、`Future.get` 以及 `final` 字段。这些规则不可能在 HotSpot 中集中到一个“JMM 引擎”中，因为它们涉及 JIT 编译、解释器、锁实现、线程状态转换、GC 和类加载等多个层面。

因此 volatile 读写在 JIT 中插入屏障，锁的 acquire/release 通过 ObjectMonitor 的 CAS 和 park/unpark 实现，`Thread.join` 的 happens-before 通过 `Object.wait` 实现，`final` 字段通过 `storestore` 屏障和 JIT 编译器约束保证。这些都是 JMM 的落地，但它们不共享同一个运行时引擎。

## 7. JMM 选择弱一致性模型，不是为了为难 x86，而是为了包容 ARM/Power

JMM 定义的是所有 Java 平台必须遵守的“最小公分母”规则。如果 JMM 直接采用 x86 TSO，那么 ARM/Power/riscv 等弱一致性平台就需要在每次 volatile 访问时插入大量额外屏障，有时甚至需要把 plain load 都变成 barrier-protected load。

反过来，如果 JMM 采用弱一致性模型，x86 上的 `loadload`/`storestore`/`loadstore` 屏障可以退化为 `compiler_barrier`（零硬件指令），只有 `storeload` 需要真正的 `lock addl` 或 `mfence`。因此 JMM 的“最小公分母”策略实际上的收益大于代价。

`OrderAccess` 是 HotSpot 的这一策略的体现：上层代码只调用 `OrderAccess::loadload()` 等接口，具体实现由平台决定（`os_cpu/linux_x86/orderAccess_linux_x86.hpp:40` 对 x86， 对 ARM）。

## 评分锚点

- **合格**：能说清 volatile、synchronized、Unsafe CAS、`final` 的基本语义。
- **良好**：能分清 x86 上哪些屏障退化为 `compiler_barrier`，哪些需要 `lock` 指令；能解释 VarHandle 的 acquire/release/opaque 与 volatile 的差异。
- **专家级**：能用“JMM 是证明规则，不是运行时检查”这一主线，把 volatile、锁、final、CAS、屏障和线程语义串起来，并解释为什么 JMM 在 HotSpot 中必须分散实现。