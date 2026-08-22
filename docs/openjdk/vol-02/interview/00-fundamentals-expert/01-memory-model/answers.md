# 01 · JVM 内存模型与运行时区域：专家级答案

## 1. JVM 的内存区域分为几块？

**标准答案**

按照 JVM 规范，运行时内存区域可以分成五块：程序计数器、Java 虚拟机栈、本地方法栈、堆、方法区。

**进程 / OS 视角**

如果你从 Linux 进程的地址空间去看，这五块并不是五个排得整整齐齐的矩形区域，而是几种不同来源的内存：

- Java 堆通常是 HotSpot 启动时 reserve 出来的一大块连续虚拟地址空间，由 GC 再切成 Region/代际。
- Java 栈和本地方法栈在 HotSpot/x86 上通常是同一个 pthread 栈，只是帧类型不同：Java frame、native frame、VM frame 都叠在这根线程栈上。
- 方法区在 JDK 8 之后不再是堆的一部分，而是 native memory 里的 Metaspace，它体现在 `mmap` 或 reserve/commit 出来的虚拟空间链表上。
- 程序计数器不是一块可以在 `/proc/<pid>/maps` 里看见的独立映射区，它更像每个线程当前执行位置的一个寄存器/抽象字段，因此规范里把它列成一个“区域”，实现上却根本不是一片分配出来的内存。

所以专家级答案第一步就要拆穿一个幻觉：**JVM 规范的“五块区域”，并不等于进程地址空间里有五块同名内存。**

**HotSpot 实现视角**

在 HotSpot 里，最能体现这个差别的是：

- Java 堆由 `Universe::create_heap()` 选择具体 `CollectedHeap` 子类，然后由 `CollectedHeap::initialize()` 真正 reserve/commit 物理地基；
- Java 栈的运行时视图不是“这块区域”，而是一个个 `frame`，用 `_sp/_pc/_cb/_fp/_unextended_sp` 这些字段描述当前帧；
- 方法区对应的不是 PermGen 了，而是 `Metaspace::global_initialize()` 建起来的一整套 `ClassLoaderMetaspace → SpaceManager → ChunkManager → VirtualSpaceList` 链条。

你如果答“方法区就是存类元数据”，这话没错，但在 JDK 11 里不够。真正应该答成：**类元数据已经搬出堆，住在 native memory 里，并且按 `ClassLoaderData` 分仓管理。**

**演进边界**

- JDK 8 之前，“方法区 ≈ PermGen ≈ heap 的一部分”还成立；JDK 8 起就不成立了。
- HotSpot 在 x86/Linux 上不严格区分 Java 栈和本地方法栈，实现上通常就是同一根 pthread 栈；但规范层仍然把它们分开描述。
- 程序计数器是唯一不会抛 `OutOfMemoryError` 的区域，这个点经常被背出来，但如果你解释不出“它为什么不是真正需要分配的一片内存”，答案仍然像八股。

**收束句**

这题真正考的不是你会不会背“五块区域”，而是你能不能把**规范里的抽象区域**和**真实进程里的内存形态**对上号。

## 2. 堆和栈的区别？

**标准答案**

堆是线程共享的，用来放对象；栈是线程私有的，用来放局部变量、调用帧和方法执行状态。

**进程 / OS 视角**

从操作系统视角看，栈和堆最本质的区别不是“放什么”，而是**谁拥有它、谁决定它什么时候消失**。

- 栈跟线程绑定。pthread 一创建，栈就跟着它建立；线程退出，整根栈一起回收。
- 堆跟整个 JVM 进程绑定。进程活着，堆就活着；对象什么时候能死，不靠线程退出，而靠 GC 的可达性判断。

所以“堆放对象、栈放局部变量”只是表象。真正的机制差异是：**栈的生命周期天然由线程调用边界决定，堆的生命周期必须靠垃圾回收来判定。**

**HotSpot 实现视角**

HotSpot 里，Java 栈上的核心对象是 `frame`。编译帧的上一帧不是靠现场猜出来的，而是靠 `_cb->frame_size()` 一跳算出；解释器帧靠帧内保存的 caller sp。也就是说，栈在 HotSpot 里不是“抽象调用栈”那么简单，而是有精确物理帧协议的。

堆侧则不同。对象分配靠 TLAB 或堆慢路径，回收靠 GC。从 GC 的角度看，栈上真正重要的不是“有多少局部变量”，而是**哪些 slot 是 oop**。这就是 OopMap 存在的原因：编译帧通过 OopMap 精确告诉 GC 哪些寄存器/槽位是引用，解释器帧则现场算 `InterpreterOopMap`。

这也解释了一个常见误区：很多人说“局部对象在栈上”。其实绝大多数情况下，对象本体依然在堆上，栈上只是保存了引用。只有逃逸分析证明可消除时，分配才会被删掉，但那也不是“对象放栈上”，而是“对象根本没被真实分配”。

**演进边界**

- “堆放对象、栈放局部变量”在 Java 初学阶段够用，但在 JVM 面试里太粗。
- HotSpot/x86 上的 Java 栈和本地方法栈通常就是同一个 pthread 栈，不存在两块独立虚拟内存。
- 如果你答到“堆由 GC 管，栈靠返回自动回收”，再补一句“GC 扫栈靠 OopMap/InterpreterOopMap，不是靠猜”，面试官会明显感觉你不只是背概念。

**收束句**

这题真正要答出来的是：**堆和栈的差别不在‘放什么’，而在‘生命周期由谁决定’。**

## 3. 什么是 GC Roots？

**标准答案**

GC Roots 是垃圾回收时对象图遍历的起点。只要一个对象从 GC Roots 可达，它就被视为存活。

**进程 / OS 视角**

从进程角度看，GC Roots 不是“JVM 里有一堆特殊对象”，而是**当前这个进程里所有还握着对象引用的位置的总和**。这些位置可能在：

- 某个线程的栈帧 slot 里；
- 某个全局句柄表（JNI/global handles）里；
- 某个类的静态字段里；
- 编译代码的常量嵌入区里；
- 某个 Reference 对象的特殊链表里。

所以 GC Roots 不是一个“数据结构名词”，它本质上是 **遍历起点集合**。

**HotSpot 实现视角**

HotSpot 里，roots 不是一张表统一遍历完事，而是分来源处理：

- 线程栈 roots：编译帧靠 `ImmutableOopMapSet`，解释器帧现场算 `InterpreterOopMap`；
- 句柄 roots：`JNIHandles`、`HandleArea`、`OopStorage`；
- 类元数据 roots：`Klass::_java_mirror`、静态字段；
- 编译代码 roots：nmethod 里的 oop maps 和 embedded references；
- Reference roots：`Reference` 对象本身不是普通根，它们的 discovered/pending 队列由 `ReferenceProcessor` 管理，在特定 GC 阶段才具有特殊语义。

这也是为什么 GC Roots 这题不能只答“栈引用、静态字段、JNI 引用”。那只是背种类，没有说清“为什么同样都是引用，Reference 对象的 referent 却不能按普通字段扫过去”。

**演进边界**

- 在不同 GC 实现里，roots 的处理阶段和并发/暂停分工可能不同；
- 编译代码 roots 和解释器 roots 的来源完全不同，前者靠编译期元数据，后者靠运行期 bci/locals/stack 状态；
- 引用类型（Soft/Weak/Phantom/Final）相关的 root 语义不是稳定的“总起点”，而是在 `ReferenceProcessor` 的四阶段里动态改变。

**收束句**

这题真正该答的不是“GC Roots 有哪些”，而是：**GC Roots 是 JVM 里所有可能继续握住对象生命线的位置。**

## 4. 什么是 OopMap？为什么 GC 需要它？

**标准答案**

OopMap 是编译器生成的元数据，用来记录在某个 safepoint 上，栈槽和寄存器里哪些位置是 oop 引用。

**进程 / OS 视角**

从 CPU 和进程角度看，线程栈上只是一些 64 位槽位。操作系统不知道哪个槽里装的是对象引用，哪个槽里装的是整数、返回地址或临时寄存器值。GC 如果想扫描栈，就必须知道“哪些位置是引用”。OopMap 就是这张翻译表。

**HotSpot 实现视角**

编译代码在每个 safepoint 位置生成 `ImmutableOopMapSet`。GC 停下线程时，根据当前 pc 找到对应的 OopMap，然后遍历其中标记为 oop 的槽位或寄存器。解释器帧没有静态 OopMap，因为解释器运行时 locals/stack 状态由当前字节码位置决定，所以要现场按 `(method, bci)` 算 `InterpreterOopMap`。

这题要答到的关键点是：**没有 OopMap，GC 不能精确扫描编译栈。** 这不是“优化”，而是“正确性前提”。把整数当引用会错标对象，把引用当整数会漏标对象，二者都可能让整个 GC 失效。

**演进边界**

- 编译代码的 OopMap 是 C1/C2 输出的一部分，不是运行时临时拼出来的；
- 解释器帧没有同等形态的静态表，必须现场算 mask；
- OopMap 与 SafePoint 强绑定：离开 safepoint，编译器就不保证寄存器/栈槽满足可扫描状态。

**收束句**

这题本质上不是问“一张表干什么”，而是问：**GC 为什么必须先知道‘哪些 bit pattern 是引用’，才能碰线程栈。**

## 5. 什么是 SafePoint？和 OopMap 的关系？

**标准答案**

SafePoint 是 JVM 可以安全地暂停所有 Java 线程、执行 GC 或 VM 操作的位置。OopMap 记录的就是这些暂停点上的 oop 布局。

**进程 / OS 视角**

线程在任意一条机器指令上被停下来，GC 可能根本不知道栈和寄存器里的引用状态是否可解释。SafePoint 的作用，就是只允许线程在“已经为暂停和扫描准备好”的那些位置停下。

这跟操作系统的线程调度完全不是一回事：OS 只负责让线程停，JVM 还要保证“停下来的那一刻可扫描、可重启、可反优化”。

**HotSpot 实现视角**

编译代码在 safepoint 位置放 poll；解释器天然在字节码边界上有检查点。VM 线程发起 safepoint 时，所有 JavaThread 经过轮询、状态检查或线程转换进入安全状态。GC 然后利用当前 pc 对应的 OopMap 精确扫描。

所以 OopMap 和 SafePoint 的关系不是“一个是另一个的附属品”，而是：

- SafePoint 决定**什么时候可以停**；
- OopMap 决定**停下来之后怎么扫**。

缺任何一个都不行。只有 SafePoint 没 OopMap，GC 不知道哪些槽位是 oop；只有 OopMap 没 SafePoint，线程可能在不可解释的位置被停下。

**演进边界**

- x86 TSO 下某些屏障可退化，但 safepoint 协议本身不可退化；
- 解释器帧和编译帧在 safepoint 下的可扫描性来源不同；
- G1/ZGC/Shenandoah 这类收集器虽然减少停顿，但依然绕不过某些 safepoint 窗口。

**收束句**

SafePoint 回答的是“**能不能现在停**”，OopMap 回答的是“**停下来以后怎么看**”。

## 6. 对象头里的 mark word 到底是什么？

**标准答案**

mark word 是对象头的第一机器字，用来存锁状态、hash、年龄、偏向信息等。

**进程 / OS 视角**

把它想成一个“多用途状态槽”比把它想成“固定字段表”更准确。进程里每个对象都要尽可能小，所以 JVM 不可能给 hash、锁、GC forwarding 各配一个固定字段，只能让同一块 word 在不同阶段承担不同身份。

**HotSpot 实现视角**

初始 mark 不是一个固定常量，而是从 `Klass::prototype_for_object` 复制而来。也就是说，对象创建时就带上了该类当前采用的锁策略边界。之后：

- neutral 状态下存 hash、age 等；
- 栈锁状态下对象头改成指向栈上 `BasicLock` 的指针，原 mark 存到 displaced header；
- 膨胀后对象头指向 `ObjectMonitor`；
- GC forwarding 时 mark word 改写为 forwarding 编码。

这题要能讲出一句话：**mark word 不是“放了很多字段”，而是“同一块 word 被多种协议重解释”。**

**演进边界**

- 偏向锁在 JDK 15 默认禁用，JDK 18 移除实现，所以“mark word 一定会装偏向线程 ID”已经不是通用事实；
- forwarding 编码只在特定 GC 阶段成立，不能把“GC forwarding”当成对象平时的字段布局。

**收束句**

这题真正考的是：**你能不能把 mark word 看成一个按协议重解释的状态机，而不是一张固定字段表。**