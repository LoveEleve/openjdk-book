# 04. C1 机器码怎么安全“逃生”？— `Runtime1 + FrameMap + OopMap`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论 C1 机器码遇到复杂或罕见路径时，如何通过 Runtime1 进入 VM 代码，以及 FrameMap、OopMap、CodeEmitInfo 如何让这次跳转仍然保留 Java 帧、活跃 oop、异常和去优化语义。Runtime1 各个 stub 的平台汇编细节不逐个展开，完整帧恢复细节也不在本文展开。
>
> **前置依赖**：[14-c1-compiler/03 — 虚拟值怎么落到机器？— `LinearScan + LIR → x86` 码](03-c1-register-codegen.md)、[08-interpreter/03 — 解释器怎么安全地调 C++？— `InterpreterRuntime`](../08-interpreter/03-interpreter-runtime.md)、[09-memory-core/01 — `Universe + CollectedHeap`](../09-memory-core/01-universe-heap.md)
> → **后续**：[15-c2-compiler/01 — C2 `IdealGraph`：`Node + Type + IGVN`](../15-c2-compiler/01-c2-ideal-graph.md)

上一篇我们把 C1 后端走完了：HIR 降成 LIR，LinearScan 把虚拟值安置到寄存器或栈槽，`LIR_Assembler` 再把这些低层操作发成机器码。

但机器码真正运行起来以后，很快就会撞上另一类问题：

- TLAB 满了，普通的内联分配走不通；
- 类还没初始化，`new` 不能只做几次指针加法；
- `monitorenter` 遇到竞争，不能继续走无竞争快路径；
- 数组越界、除零、空指针、类型检查失败，需要构造 Java 异常；
- 首次调用或字段访问还没有解析，机器码需要被 patch；
- 当前代码需要去优化，必须把机器帧还原成解释器能理解的 Java 状态。

如果 C1 试图把这些情况全部内联成机器码，编译器会变慢，生成代码会变大，异常和状态恢复也会变得难以统一。于是 C1 采用了一个更现实的分工：**机器码负责高频快路径，复杂和罕见路径跳进 Runtime1，再由 C++ 代码完成真正的 VM 操作。**

这又产生了更深的问题：机器码跳进 C++ 之后，C++ 怎么知道当前方法是谁？哪些寄存器和栈槽里放着 oop？异常该回到哪个 bytecode？去优化时该如何重建 Java 局部变量和操作数栈？

这就是本篇要打穿的主线：

**Runtime1 解决“复杂动作交给谁”，FrameMap 解决“值在当前帧哪里”，LinearScan 构建 OopMap 解决“哪些位置是活跃 oop”，CodeEmitInfo 解决“如何回到 Java bytecode 语义”。**

## 先试两个最自然的办法，看看为什么都不行

### 朴素方案一：所有复杂操作都直接内联在 C1 机器码里

可以想象一条完全自给自足的 C1 机器码：对象分配失败时自己处理 GC 和类初始化，锁竞争时自己排队，异常时自己构造异常对象，首次解析时自己改写常量池和调用目标，去优化时自己把机器帧翻译回解释器帧。

这条路的问题不是“理论上不能写”，而是每个普通方法都得背上大量低频分支和运行时协议。C1 的目标是毫秒级给出够用的代码，不是把所有 VM 机制复制进每个 nmethod。复杂路径越多，机器码越大，编译时间越长，调试信息和异常边也越复杂。

更合理的做法是把公共的复杂逻辑集中起来：高频成功路径留在编译代码里，失败或罕见路径跳到一组共享的 Runtime1 stubs。

### 朴素方案二：C1 直接 call 任意 C++ 函数，不需要统一入口和状态描述

第二个方案看起来更简单：机器码遇到慢路径就直接 call 一个 C++ 函数。问题是，C++ 函数调用只解决了“跳过去”，没有解决“跳过去之后 VM 如何安全理解当前编译帧”。

进入 VM 代码之前，必须明确：

- 哪些寄存器由调用者保存，哪些由被调用者保存；
- 栈帧大小和参数区域在哪里；
- 当前调用点的活跃 oop 在寄存器还是栈槽；
- 如果发生 GC，哪些位置需要更新；
- 如果抛异常或去优化，当前 bytecode 的局部变量和操作数栈是什么。

所以 Runtime1 不是一组随手暴露的 C++ 函数，而是一组按场景区分的运行时入口：普通 JRT 慢路径、异常转发、解析 patch 和 deopt 入口各有自己的控制流与返回约定。它们共享 stub/帧/OopMap 这套基础设施，但不能假定每条路径都执行同一种 VM transition。

例如，异常 handler 路径从编译代码进入时仍处在 Java mode，先由 `exception_handler_for_pc_helper()` 查找 handler；如果发现调用者已经被 deopt，才转到 deopt blob。`share/c1/c1_Runtime1.cpp:616`、`share/c1/c1_Runtime1.cpp:621`、`share/c1/c1_Runtime1.cpp:624`、`share/c1/c1_Runtime1.cpp:629`、`share/c1/c1_Runtime1.cpp:635`、`share/c1/c1_Runtime1.cpp:637`

## Runtime1 是什么：一张预生成的 C1 运行时 stub 表

Runtime1 的类注释已经把职责说清楚：它保存的是 Compiler1 生成代码所需要的 assembly stubs 和 VM runtime routines。入口由 `RUNTIME1_STUBS` 宏集中声明，包含分配、异常、锁、类型检查、deopt、解析 patch、计数器溢出等类别。`share/c1/c1_Runtime1.hpp:36`、`share/c1/c1_Runtime1.hpp:40`、`share/c1/c1_Runtime1.hpp:44`、`share/c1/c1_Runtime1.hpp:49`、`share/c1/c1_Runtime1.hpp:62`、`share/c1/c1_Runtime1.hpp:66`、`share/c1/c1_Runtime1.hpp:67`、`share/c1/c1_Runtime1.hpp:72`

这些不是每个 nmethod 都重新生成一份的普通函数，而是初始化阶段批量生成的 runtime blobs。`Runtime1::generate_blob()` 为某个 stub 准备 `CodeBuffer` 和 `StubAssembler`，生成代码与 OopMap，取得 frame size，再创建 `RuntimeStub`。`Runtime1::initialize()` 随后遍历所有 stub id，逐个生成并保存在 `_blobs` 表里，运行时通过 `blob_for()` 取对应入口。`share/c1/c1_Runtime1.cpp:194`、`share/c1/c1_Runtime1.cpp:196`、`share/c1/c1_Runtime1.cpp:203`、`share/c1/c1_Runtime1.cpp:206`、`share/c1/c1_Runtime1.cpp:208`、`share/c1/c1_Runtime1.cpp:221`、`share/c1/c1_Runtime1.cpp:225`、`share/c1/c1_Runtime1.cpp:231`、`share/c1/c1_Runtime1.cpp:252`、`share/c1/c1_Runtime1.cpp:258`、`share/c1/c1_Runtime1.cpp:262`、`share/c1/c1_Runtime1.cpp:279`

这套设计带来两个好处：

- C1 nmethod 只需要调用已经准备好的 stub，不需要把全部慢路径实现复制进自身；
- 每个 stub 可以提前规定自己的 frame size、寄存器和异常约定；需要 GC 扫描的 stub 再配套 OopMap。

这一区分不是形式上的：`generate_blob_for()` 明确列出了一批不需要 OopMap 的 stub，例如 `dtrace_object_alloc`、`slow_subtype_check`、`unwind_exception` 和 `counter_overflow`；其他 stub 才按默认路径要求 OopMap。`share/c1/c1_Runtime1.cpp:231`、`share/c1/c1_Runtime1.cpp:233`、`share/c1/c1_Runtime1.cpp:235`、`share/c1/c1_Runtime1.cpp:237`、`share/c1/c1_Runtime1.cpp:246`

因此，Runtime1 更像 C1 机器码与 VM 运行时之间的“标准接头”，而不是“编译失败后的补救函数”。

## 以对象分配为例：快路径内联，慢路径进入 `JRT_ENTRY`

对象分配最能解释这套分工。C1 会在编译代码中保留快速分配路径；只有 TLAB 不够、类初始化状态不满足、对象布局需要 VM 介入等情况，才跳到 Runtime1 慢路径。

`Runtime1::new_instance()` 的参数是运行时的 `Klass*`，不是编译期的 `ciKlass`。进入 C++ 后，它先保持 class holder 存活，再检查当前类是否允许实例化，确保类已经初始化，最后调用 `InstanceKlass::allocate_instance()`。`share/c1/c1_Runtime1.cpp:346`、`share/c1/c1_Runtime1.cpp:349`、`share/c1/c1_Runtime1.cpp:350`、`share/c1/c1_Runtime1.cpp:351`、`share/c1/c1_Runtime1.cpp:352`、`share/c1/c1_Runtime1.cpp:354`、`share/c1/c1_Runtime1.cpp:356`

结果也不是通过普通 C++ 返回值传回。源码把新对象放入 `JavaThread` 的 `vm_result`：`thread->set_vm_result(obj)`。这是 Runtime1 运行时入口的一部分约定，C1 的分配 stub 在返回路径上读取线程结果；同一通道也被异常转发路径用于暂存异常对象。`share/c1/c1_Runtime1.cpp:355`、`share/c1/c1_Runtime1.cpp:357`、`share/c1/c1_Runtime1.cpp:602`

数组分配遵循同一模式：基础类型数组调用 `oopFactory::new_typeArray()`，对象数组调用 `oopFactory::new_objArray()`，多维数组调用 `ArrayKlass::multi_allocate()`，最后都把对象放进 `vm_result`。`share/c1/c1_Runtime1.cpp:361`、`share/c1/c1_Runtime1.cpp:368`、`share/c1/c1_Runtime1.cpp:369`、`share/c1/c1_Runtime1.cpp:379`、`share/c1/c1_Runtime1.cpp:388`、`share/c1/c1_Runtime1.cpp:389`、`share/c1/c1_Runtime1.cpp:398`、`share/c1/c1_Runtime1.cpp:405`

这里的重点不在于记住每个分配函数，而在于理解“快路径/慢路径”的边界：**C1 机器码负责常见且简单的成功情况，Runtime1 负责需要类、堆、线程状态或异常协作的复杂情况。**

## Runtime1 接管的远不止分配：锁、异常、解析和去优化都需要同一条逃生通道

Runtime1 stub 表里同时列出了 monitorenter/monitorexit、各种异常抛出入口、slow subtype check、handle exception、deoptimize，以及字段、klass、mirror、appendix patching。`share/c1/c1_Runtime1.hpp:55`、`share/c1/c1_Runtime1.hpp:58`、`share/c1/c1_Runtime1.hpp:61`、`share/c1/c1_Runtime1.hpp:62`、`share/c1/c1_Runtime1.hpp:64`、`share/c1/c1_Runtime1.hpp:66`、`share/c1/c1_Runtime1.hpp:67`、`share/c1/c1_Runtime1.hpp:69`

它们表面上是不同功能，背后却共享一个约束：**机器码已经无法或不值得继续独立完成当前动作，需要把控制权交给 VM，同时不能丢掉当前 Java 执行状态。**

例如：

- 锁的无竞争快路径失败后，需要调用运行时锁助手处理竞争与对象头；
- 数组越界、除零、空指针和类型错误需要构造 Java 异常并找到正确 handler；
- 首次调用或字段访问未解析时，需要解析目标并 patch 原机器码；
- 去优化时，需要按照 trap 与 debug info 把当前编译帧还原成解释器可继续执行的状态。

Runtime1 的职责不是替这些动作做所有高频优化，而是为这些复杂动作提供稳定的桥。

## FrameMap：机器帧不是一组随便排列的栈槽

Runtime1 能否正确工作，首先取决于 C1 是否把当前方法的机器帧安排清楚。`FrameMap` 的职责就是把 locals、monitor、spill slots、registers 和参数区域映射到具体 frame location。它的类注释还给出了抽象帧布局：参数区、ABI/返回地址区域、monitor 区、spill 区、保留参数区。`share/c1/c1_FrameMap.hpp:42`、`share/c1/c1_FrameMap.hpp:45`、`share/c1/c1_FrameMap.hpp:48`、`share/c1/c1_FrameMap.hpp:50`、`share/c1/c1_FrameMap.hpp:56`、`share/c1/c1_FrameMap.hpp:58`

FrameMap 还维护平台寄存器编号与寄存器对象之间的映射、caller-save 寄存器数组、frame size、参数数量、monitor 数量、spill 数量和保留参数区大小。`share/c1/c1_FrameMap.hpp:69`、`share/c1/c1_FrameMap.hpp:71`、`share/c1/c1_FrameMap.hpp:75`、`share/c1/c1_FrameMap.hpp:78`、`share/c1/c1_FrameMap.hpp:93`、`share/c1/c1_FrameMap.hpp:96`、`share/c1/c1_FrameMap.hpp:99`、`share/c1/c1_FrameMap.hpp:101`

这套映射解决的是“位置问题”：某个 LIR operand 在机器运行时对应哪个寄存器或哪个相对栈指针的偏移。它本身并不负责判断“这个位置是不是 oop”，也不负责完整描述某个 bytecode 的局部变量状态。

这是理解后面 OopMap 和 CodeEmitInfo 的前提：FrameMap 提供位置坐标，其他结构再给这些坐标附加 GC 和 Java 语义。

## OopMap 到底在哪里构建：不是 FrameMap，而是 LinearScan

一个常见误解是：FrameMap 既然知道栈槽和寄存器位置，就应该负责构建 OopMap。实际实现不是这样。

LinearScan 在分配完成后，会通过 `init_compute_oop_maps()` 建立 oop/non-oop interval 的遍历器；在具体 LIR 操作和调用点，`compute_oop_map()` 根据当前活跃的 oop intervals 创建 `OopMap`，并用 FrameMap 提供的 frame size 与参数数量初始化它。`share/c1/c1_LinearScan.cpp:2415`、`share/c1/c1_LinearScan.cpp:2417`、`share/c1/c1_LinearScan.cpp:2420`、`share/c1/c1_LinearScan.cpp:2432`、`share/c1/c1_LinearScan.cpp:2440`、`share/c1/c1_LinearScan.cpp:2442`、`share/c1/c1_LinearScan.cpp:2444`

这条分工很合理：

- FrameMap 知道“位置在哪里”；
- LinearScan 知道“此时哪些 interval 还活着”；
- OopMap 把两者合成“GC 在这个 safepoint 应该扫描哪些寄存器和栈槽”。

因此 OopMap 不是一个静态的“某个栈槽永远是 oop”的表。它是和具体操作位置、当前活跃区间、当前寄存器分配结果绑定的 safepoint 描述。

这也解释了为什么寄存器分配和 GC 安全不能分开理解：LinearScan 不是只为了让算术指令少几条 move，它还必须让每个调用点都有一份可以被 GC 使用的 oop 位置地图。

但 LinearScan 创建 OopMap 还不是最后一步。`CodeEmitInfo::record_debug_info()` 会在具体 PC 偏移处把 OopMap 深拷贝给 `DebugInformationRecorder::add_safepoint()`，再记录 scope/debug info，最后结束这个 safepoint。完整链路是：活跃 interval → OopMap → CodeEmitInfo → safepoint/debug recorder。`share/c1/c1_IR.cpp:216`、`share/c1/c1_IR.cpp:218`、`share/c1/c1_IR.cpp:219`、`share/c1/c1_IR.cpp:220`、`share/c1/c1_IR.cpp:221`

## CodeEmitInfo：异常和去优化还需要 bytecode 状态

OopMap 解决的是 GC 如何找到 oop，但异常和去优化需要更多信息：当前 Java 方法是哪一个、当前 bci 是多少、局部变量和操作数栈是什么、异常处理器有哪些、当前异常是否需要去优化后重新执行。

C1 用 `CodeEmitInfo` 持有和传递这类代码生成信息。它记录 scope、`ValueStack`、异常 handler 列表、OopMap 和 `deoptimize_on_exception` 等字段；真正把这些内容编码进某个 PC 的 safepoint/debug 记录，则由 `record_debug_info()` 完成。`share/c1/c1_IR.cpp:186`、`share/c1/c1_IR.cpp:187`、`share/c1/c1_IR.cpp:189`、`share/c1/c1_IR.cpp:190`、`share/c1/c1_IR.cpp:191`、`share/c1/c1_IR.cpp:193`、`share/c1/c1_IR.cpp:216`、`share/c1/c1_IR.hpp:251`、`share/c1/c1_IR.hpp:257`、`share/c1/c1_IR.hpp:260`、`share/c1/c1_IR.hpp:275`

这套信息会在 LIR 操作上跟着调用点、patch 点、异常点走。比如 LIR assembler 的 patching epilog 会通过 `CodeEmitInfo` 取得 bytecode 和状态，并设置 `force_reexecute`，让 patch 完成后可以按 JVM 语义重新执行相关 bytecode。`share/c1/c1_LIRAssembler.cpp:37`、`share/c1/c1_LIRAssembler.cpp:44`、`share/c1/c1_LIRAssembler.cpp:45`、`share/c1/c1_LIRAssembler.cpp:49`、`share/c1/c1_LIRAssembler.cpp:90`、`share/c1/c1_LIRAssembler.cpp:92`

所以这里有三层信息不能混在一起：

- FrameMap：物理位置坐标；
- OopMap：某个 safepoint 上哪些位置是活跃 oop；
- CodeEmitInfo：如何把当前机器执行状态解释成 Java bytecode 状态。

Runtime1、异常处理和 deopt 正是通过这三类信息，才能把 C1 机器码安全地接回 VM。

## 与 InterpreterRuntime 的分工：入口不同，底层语义可以相遇

解释器遇到运行时复杂动作时，通常走 `InterpreterRuntime`；C1 编译代码则通过 Runtime1 stubs 进入 VM。两者不是同一个入口体系，但底层可能共享 `InstanceKlass::allocate_instance`、`oopFactory`、`SharedRuntime` 锁助手等基础实现。

差异在于调用载体：解释器有自己的解释器帧和 IRT 入口约定；C1 有经过寄存器分配的机器帧、Runtime1 stub、OopMap 和 CodeEmitInfo。不能因为底层都调用了同一个 helper，就把两套入口说成同一件事。

这也是 Runtime1 存在的理由：它把“C1 机器帧如何进入 VM”这条路径固定下来，而不是让每个 LIR 操作自己发明一套 C++ 调用协议。

## 收网：Runtime1 让机器码能逃生，FrameMap/OopMap/CodeEmitInfo 让逃生仍是合法 JVM 执行

现在可以把 C1 runtime 与 frame 收成一张总图了。

C1 机器码在高频简单路径上尽量内联完成工作；遇到分配失败、锁竞争、异常、首次解析、patch 或 deopt 等复杂场景，就跳到预先生成的 Runtime1 stub。stub 负责把机器执行接入 C++ VM 运行时；FrameMap 为寄存器、locals、monitor、spill 和参数区域提供物理位置；LinearScan 根据活跃 interval 构建 safepoint OopMap；CodeEmitInfo 保存 bytecode、ValueStack、异常 handler 和去优化所需的状态。于是 Runtime1 接管控制流时，VM 仍然能理解当前 nmethod 里的 Java 帧。`share/c1/c1_Runtime1.hpp:36`、`share/c1/c1_Runtime1.cpp:194`、`share/c1/c1_FrameMap.hpp:45`、`share/c1/c1_LinearScan.cpp:2432`、`share/c1/c1_IR.hpp:251`、`share/c1/c1_LIRAssembler.cpp:44`

所以，本篇最核心的一句话不是“Runtime1 是 C1 的 runtime stub 集合”，而是：

**Runtime1 解决机器码如何把复杂语义交给 C++，FrameMap/OopMap/CodeEmitInfo 则保证这次交接不会丢掉物理位置、活跃 oop 和 Java bytecode 状态。**

到这里，C1 这一域的主线就闭合了：前端建图，轻量优化，LinearScan 分配，LIR 发码，Runtime1 接管慢路径，FrameMap 与 OopMap 保证机器帧可被 JVM 继续理解。下一域进入 C2，关注的是另一种完全不同的编译器组织方式：`IdealGraph`、`Node`、`Type` 和更深的全局优化。

> → [15-c2-compiler/01 — C2 `IdealGraph`：`Node + Type + IGVN`](../15-c2-compiler/01-c2-ideal-graph.md)
