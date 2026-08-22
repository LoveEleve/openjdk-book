# 08. 为什么有些方法根本不按普通调用编？— `LibraryCallKit + intrinsics`

> **版本边界**：本文基于 `OpenJDK 11u / HotSpot / Linux / x86_64`。这里讨论的是 C2 在 Parse 期如何识别并接管一批特殊方法语义：`Compile::find_intrinsic`、`LibraryCallKit::try_to_inline` 以及 String / Math / Unsafe / Thread / System 等几族典型 intrinsic。各类 runtime stub、平台指令与 matcher 细节只在必要处点到。
>
> **前置依赖**：[15-c2-compiler/02 — Ideal Graph 是怎么长出来的？— `Parse + GraphKit`](02-c2-parse-graphkit.md)、[15-c2-compiler/07 — 为什么这些高层节点要留到最后？— `PhaseMacroExpand`](07-c2-macro-intrinsics.md)、[23-stub/02 — `System.arraycopy` 为什么能比手写循环快 3 倍？](../23-stub/02-arraycopy.md)、[39-runtime-monitoring/02 — `Timer + Monitoring Services`](../39-runtime-monitoring/02-timer-stats.md)
> → **后续**：[16-code-cache/01 — 机器码的家：`CodeBlob + CodeHeap`](../16-code-cache/01-codeblob-heap.md)

前面几篇我们一直在默认一个前提：Java 方法会先经过 `do_call()`、`Parse`、Ideal Graph，再进入优化、匹配、寄存器分配和发码。哪怕有宏节点和 Runtime1，方法本身至少还是按“正常调用语义”在走。

但 C2 里有一批方法，从一开始就不打算按这条路走到底：

- `Math.sin(x)` 明明是个 native 方法，普通编译意味着一次运行时调用；
- `System.arraycopy(...)` 表面上是一个静态方法，普通编译会看到一次调用和一堆边界检查；
- `Unsafe.allocateInstance(cls)` 的真正语义不是“普通 Java new + 调构造器”；
- `System.nanoTime()` 从 Java 视角看是普通 native 方法，但 JIT 真正关心的是当前平台上最合适的时间源表示。

本篇要回答的核心问题是：**为什么有些 Java 方法根本不会按“字节码 → 普通调用 → 后续优化”的路径走，而是在 Parse 期就被编译器直接接管语义？Intrinsic 到底替换掉了什么？**

答案会反复落到一句话:**intrinsic 不是给普通调用提速，而是 C2 在 Parse 期决定“这次不按原方法体或原生调用去理解这个方法了”，改为直接生成一个更适合优化和匹配的 Ideal Graph 子结构。**

---

## 1. 先试两个最自然的理解，看看为什么都不对

### 误解一：intrinsic 只是“更快的普通调用”

如果 intrinsic 只是“更快的调用”，那它最多是在原有调用边界上做局部加速；而 C2 真正做的，是在 Parse 期就决定：**这里不再是一个普通调用点，而是一段专用图语义。**

一旦发生这种替换，后续优化器看到的就不再是“一个未知方法调用”，而可能是：

- 一个 `StrIndexOfNode`；
- 一个直接的数学运算节点或 runtime_math 调用节点；
- 一个直接分配对象的图模式；
- 一个当前线程对象读取节点；
- 一个时间源 runtime call 的返回值节点。

所以 intrinsic 改的不是“调用有多快”，而是**优化器面对的问题长什么样**。

### 误解二：intrinsic 是优化后期才识别出来的特殊节点

源码恰恰说明它发生得更早。

`Compile::find_intrinsic()` 在调用生成器阶段查 method 的 `intrinsic_id()`，如果它属于编译器支持的范围且平台和 flag 允许，就创建一个 `LibraryIntrinsic` call generator。随后 `LibraryIntrinsic::generate()` 创建 `LibraryCallKit`，并尝试 `try_to_inline(...)`。也就是说，intrinsic 决策和普通内联决策同属 Parse 期的调用语义选择，而不是后期打补丁。`compile.cpp:150-165`、`library_call.cpp:349-408`

这正是 intrinsic 的力量来源：它足够早，所以后面所有优化都能看到替换后的专用图，而不是晚来的补丁结果。

---

## 2. 从 `intrinsic_id` 到 `LibraryCallKit`：编译器怎么决定“这次我来接管”

整个机制的第一步，是方法对象身上已经带着 `intrinsic_id()`。`Compile::find_intrinsic()` 做的事情很简单却很关键：

- 如果当前方法已经在 `_intrinsics` 缓存表里，直接复用；
- 否则只要 `intrinsic_id() != _none` 且属于编译器支持范围，就尝试 `make_vm_intrinsic()`。

`make_vm_intrinsic()` 进一步做平台和 flag 边界检查：方法必须已加载，C2Compiler 也必须声明支持这项 intrinsic，而且不能被 directive 或 flags 禁掉。只有这些条件都满足，才创建 `LibraryIntrinsic`。`compile.cpp:150-165`、`library_call.cpp:349-377`

一旦 `LibraryIntrinsic::generate()` 被选中，它就创建 `LibraryCallKit`，并尝试 `try_to_inline(_last_predicate)`。这里的 “inline” 不是把 callee 字节码铺进 caller，而是**用已知语义替换这个调用点**。`library_call.cpp:392-408`

---

## 3. `try_to_inline`：不是大 switch 清单，而是语义分发器

`try_to_inline()` 最醒目的当然是那个巨大的 switch。String、Math、Unsafe、Thread、System、Class、Monitor 等 intrinsic 都在这里分派到各自的 `inline_xxx` 实现。`library_call.cpp:519-592`

但如果只把它看成一个“方法名分发器”，还是低估了它。

它真正干的是把“一个普通方法调用”改写成“某种更具体的图语义构造”：

- 有些 case 直接生成专用理想节点;
- 有些生成 runtime_math 调用;
- 有些走 Runtime/Stub 路径;
- 有些在图里直接建当前线程或类镜像相关结构。

所以 switch 分发的不是“选哪个 helper 函数”，而是**选这个调用点应当被理解成哪种更底层、更具体的语义。**

---

## 4. String intrinsics：把字符串扫描压成专用语义

普通 Java 实现里的 `indexOf`、`compareTo`、`equals` 往往表现成一串循环、边界判断和字符比较；但 JIT 对这类逻辑真正关心的是“这是一个字符串扫描/比较问题”。

`inline_string_indexOf()` 会先问 `Matcher::match_rule_supported(Op_StrIndexOf)`，平台不支持就直接放弃；支持的话，再做 null check、拿出底层 `byte[]` 起始地址和长度，并按 `StrIntrinsicNode::ArgEnc` 区分 Latin1/UTF16 编码组合。最后调用 `make_indexOf_node(...)`，把整个调用点变成专用字符串查找节点家族。`library_call.cpp:1294-1325`

C2 没有在 Parse 期直接发出某条 SSE 指令。它先把“字符串查找”压成更专用的理想图节点，后面再交给 Matcher 和平台后端决定是不是映射到 `pcmpestri` 等机器模式。

所以 String intrinsic 的力量，不是“直接插 SIMD 指令”，而是**把原本会表现成普通循环的 Java 语义，提前压成后端更容易识别和匹配的图对象。**

---

## 5. Math intrinsics：为什么有些变成节点,有些仍是 runtime_math

Math 家族特别适合打破“intrinsic = 单条机器指令”这个误解。

`inline_math_native()` 明确分成几类。

`sin/cos/tan/log/exp/pow` 这类操作不一定能稳定映射成单条硬件指令，或者需要更复杂实现保障语义。它们会优先调用 `StubRoutines::dsin()` 等专用桩；桩不可用时，再退回 `SharedRuntime::dsin` 一类 runtime 实现。intrinsic 在这里消除的是“普通 native/JNI 调用路径”，但产物仍可能是 runtime_math 图调用，而不是内联机器指令。`library_call.cpp:1873-1921`

另一类是 `sqrt/abs/ceil/floor`，如果 `Matcher::match_rule_supported(...)` 说明目标平台有合适规则，就能更直接地映射成机器节点。`library_call.cpp:1899-1905`

还有一个更有意思的特例：`pow(x, 2.0)`。这里编译器根本不调用通用 `pow`，而是直接识别成 `x*x`，在 Parse 期把调用语义变成普通算术节点。`library_call.cpp:1912-1918`

这说明 intrinsic 不承诺统一的“更低层次”。它承诺的是：**编译器会用比普通方法调用更贴近真实语义成本的方式表达这个操作。**

---

## 6. Unsafe / Thread / System：语义接管不止发生在数学函数

`Unsafe.allocateInstance` 是最直白的例子。`inline_unsafe_allocate()` 不把它当成普通 Java new：它先 null-check 接收者，再取 `Class<?>` mirror 里的 `Klass*`，必要时检查初始化，再调用 `new_instance(kls, test)` 分配对象，而且明确不走普通构造器语义。`library_call.cpp:2868-2896`

这不是“把一个普通调用做快一点”，而是编译器明确知道:这个 API 的语义本来就不是 `<init>` 那套语义，它应该生成的是“按类镜像直接分配对象”的图。

`generate_current_thread()` 也是同样。它不去假装 `Thread.currentThread()` 是一段普通 Java 方法体，而是直接通过 `ThreadLocalNode` 和 `JavaThread::threadObj_offset()` 构造“当前线程对象”的图表示。`library_call.cpp:1092-1098`

`inline_native_time_funcs()` 也很说明问题。`System.nanoTime()` 不是“某个神秘 CPU 指令”的别名，而是明确变成对 `os::javaTimeNanos` 或相关 runtime time source 的 runtime call 图。`library_call.cpp:771-772`、`:2900-2912`

这些方法的共同点是:它们都让编译器在 Parse 期直接承认“我知道你真正想干什么”，而不是继续假装它们只是普通 Java/native 调用。

---

## 7. intrinsic 不是后门：它仍然回到同一套优化和发码管线

讲到这里最容易出现另一个误解：既然 intrinsic 这么特殊，那它是不是绕开普通 Ideal Graph、IGVN、EA、Matcher、RA 这些后续阶段，自成一条后门通道？

恰恰不是。

无论是 `inline_string_indexOf()` 建出来的字符串专用节点，`inline_math_native()` 生成的 runtime_math 图，还是 `inline_unsafe_allocate()` 产生的分配图，**它们最后仍然是普通 Ideal Graph 节点**。后面的 IGVN、CCP、EA、LoopOpts、Matcher、RA、Output 仍然会像对待普通图一样对待它们。

这也是 intrinsic 真正强大的地方：它不用另造一套后端，只是在最前面的 Parse 期把问题重写成更有利于优化的图表示，之后仍然回到统一管线。

---

## 8. 误解澄清与收网

1. **intrinsic 是更快的普通调用吗?** 不是。它在 Parse 期改变的是调用点的图语义，不只是减少一次 call。
2. **intrinsic 是后期优化 pass 吗?** 不是。`find_intrinsic` / `LibraryIntrinsic::generate` 在调用生成阶段就决定是否接管。
3. **String intrinsic 会直接生成 SSE 指令吗?** 不会。它先生成专用 Ideal 节点，平台化交给后续 Matcher/Output。
4. **Math intrinsic 都会变成单条机器指令吗?** 不会。有些是算术节点，有些是 runtime_math/stub 调用。
5. **intrinsic 会绕开后续统一管线吗?** 不会。生成的节点仍进入 IGVN/CCP/EA/LoopOpts/Matcher/RA/Output。

把这一篇压成三句话:

- **intrinsic 是 Parse 期的语义接管**，不是普通调用的局部加速。
- **`LibraryCallKit` 按已知语义生成专用图**：String、Math、Unsafe、Thread、System 各有不同落点。
- **接管发生得早,但后端仍统一**：intrinsic 节点之后继续走 C2 的优化、匹配、寄存器分配和发码管线。

下一篇回到机器码的家：无论普通调用、宏展开还是 intrinsic，最后都要变成 `CodeBlob`，住进 `CodeHeap`。

> → [16-code-cache/01 — 机器码的家：`CodeBlob + CodeHeap`](../16-code-cache/01-codeblob-heap.md)