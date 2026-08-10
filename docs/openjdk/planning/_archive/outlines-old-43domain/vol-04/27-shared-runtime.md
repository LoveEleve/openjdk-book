# SharedRuntime — 文章大纲

> vol-04 · 域 27 · 🟡 B | 基于 Pass 0+1 探索笔记
> Pass 1 产出：8 基本元素 / 9 标记问题
>
> **→ 从 JIT Framework**：CompileBroker 调好了 C1 还是 C2 编译器，但解释器的调用约定（Java 栈帧、局部变量表、操作数栈）和编译器的调用约定（寄存器分配、native 栈帧）完全不同。一个解释器帧怎么跳到编译后的机器码？编译怎么回退到解释器？SharedRuntime 篇见。

## 概念依赖

先修：Interpreter（解释器的栈帧结构，才知道 i2c adapter 需要从栈帧读什么）、StubRoutines（桩程序的生成方式——adapter 本质也是一种代码桩）、Assembler（adapter 由汇编代码构成）。

SharedRuntime 是 JVM 的"运行时桥接层"——它不编译、不解释、不执行字节码，它负责在这些执行模式之间传递控制权。核心产品是 adapter（i2c/c2i stub）+ RuntimeStub（resolve/miss handler）+ 隐式异常处理 + 调用约定。

## 叙事计划

**开篇场景**：解释器在某个方法调用点（invokevirtual `dog.speak()`）遇到了一个已经被 C2 编译的方法。解释器的下一个动作不是"继续解释"——而是跳进一个 adapter，把局部变量表里的参数搬到 C2 期望的寄存器中，把操作数栈指针映射到 native 栈帧偏移，然后 `jmp` 到编译后的 `nmethod` 入口。这个 adapter 是 SharedRuntime 生成的，只做一件事——桥接两种调用约定。

**第一层：AdapterHandlerLibrary — "我有这个方法的 adapter 吗？"**

`AdapterHandlerLibrary`（`sharedRuntime.hpp:704`）是一个 `AllStatic` 适配器工厂+缓存。核心调用链：`get_adapter(methodHandle)` → 计算 `AdapterFingerPrint` → 查 `_adapters` 哈希表 → 命中返回已有 `AdapterHandlerEntry` → 未命中调用 `get_adapter0()` 在 `_buffer` (BufferBlob) 中生成三段代码（i2c/c2i/c2i_unverified）→ `new_entry()` 插入哈希表。

为什么需要缓存？因为相同签名的方法（如所有 `void foo()` 方法）的 adapter 完全一样——参数类型列表相同意味着解释器→编译代码的参数映射相同。一个 JVM 运行中可能有几千个方法但有几百个独特性签名——缓存避免了大量重复生成。

**第二层：i2c adapter — 解释器到编译代码的桥梁**

`_i2c_entry` 的作用：在解释器调用已编译方法的那个调用点，把解释器栈帧的信息搬到 native 栈帧。具体操作：

1. 从解释器的局部变量表读取参数（每个参数可能是 int/long/float/double/object）
2. 按 Java 调用约定（`java_calling_convention()` at `sharedRuntime.hpp:378`）把参数放到对应的寄存器或栈槽
3. 构造 native 栈帧（保存返回地址、设置 frame pointer）
4. `jmp` 到 `nmethod->entry_point()`

适配器不需要关心被调用方法的实现——它只关心签名（参数类型+返回类型），因为只有签名决定了参数在寄存器/栈槽中的位置。

**第三层：c2i adapter — 编译代码回到解释器的桥梁**

`_c2i_entry` 和 `_c2i_unverified_entry` 用于"已编译方法调用未编译方法"的场景。有两个入口的原因：

- `_c2i_unverified_entry` 是首次调用——需要检查 receiver（如果方法被 C2 优化为直接调用，假设了 receiver 类型在 IC 中已验证），检查失败跳到 `_ic_miss_blob` 执行 IC miss→resolve→可能去虚拟化。
- `_c2i_entry` 是已验证的快速路径——跳过 receiver 类型检查，直接设置解释器状态并跳转。

这区分了"调一个还没处理过的方法"和"调之前已经验证过可以直调的方法"——前者需要重新检查调用假设。

**第四层：AdapterFingerPrint — 签名的哈希编码**

`AdapterFingerPrint`（`sharedRuntime.hpp:38`）将方法签名编码为一个哈希值：参数类型列表（`BasicType*`）+ 参数数量 + 返回类型 → hash。用于 `AdapterHandlerTable` 的 hashCode/equals——相同签名的两个方法生成相同的 FingerPrint，共享同一个 AdapterHandlerEntry。

设计权衡：FingerPrint 不是 collision-free。碰撞发生时如何处理？`AdapterHandlerTable` 用链地址法——FingerPrint 作为 bucket key，Equality 比较通过 `equals(AdapterFingerPrint* fp)` 做完整签名比较（不只是哈希值）。如果碰撞——生成一个新 entry 插入链表。

**第五层：RuntimeStub — 编译代码调回 C++ 的"安全陷阱"**

编译代码在运行时遇到六种需要"回调 C++"的场景：

| 场景 | Stub | 代码 |
|------|------|------|
| 方法不匹配（IC 中 Klass 不对） | `_wrong_method_blob` | sharedRuntime.hpp:57 |
| 调用抽象方法 | `_wrong_method_abstract_blob` | sharedRuntime.hpp:58 |
| IC miss（首次调用点） | `_ic_miss_blob` | sharedRuntime.hpp:59 |
| 优化虚调用首次 | `_resolve_opt_virtual_call_blob` | sharedRuntime.hpp:60 |
| 虚调用 resolve | `_resolve_virtual_call_blob` | sharedRuntime.hpp:61 |
| 静态调用 resolve | `_resolve_static_call_blob` | sharedRuntime.hpp:62 |

每个 RuntimeStub 是一个小段汇编代码：保存当前寄存器状态到栈 → 调 C++ resolve 函数（`resolve_helper()` / `handle_ic_miss_helper()`） → 恢复寄存器 → 如果 resolve 成功，patch 掉调用点（把 `call stub` 改为 `call resolved_target`） → 跳到已解析的目标。

设计洞察：编译代码中的 call 指令目标是固定的 stub 地址——第一次执行时 stub→C++→resolve→patch 调用点。第二次执行时，调用点已被 patch 为直接 call 目标——不再经过 stub。这是经典的"惰性链接（lazy linking）"模式。

除 resolve stubs 外，SharedRuntime 还生成两类重要的汇编 stub：**deopt blob**（`SharedRuntime::_deopt_blob` — 域 30 Deoptimization 的前置依赖，`generate_deopt_blob()` 在 SharedRuntime 初始化时生成）和 **uncommon trap blob**（C2 专用，`_uncommon_trap_blob` — C2 插入的假设检查点触发时跳入）。这两类 stub 的生成机制和 resolve stubs 相同——保存寄存器→调 C++→恢复——但语义不同：resolve stub 是"找目标"，deopt stub 是"回退解释器"。

**第六层：隐式异常 — 硬件信号驱动的性能优化**

编译代码不执行 `if (obj == null) throw NPE;`——而是直接 `load rax, [obj+0]`。如果 obj 是 null，CPU 产生 SIGSEGV，signal handler 检查 faulting PC 所在位置——如果是编译代码区域（CodeCache 内），调到 `SharedRuntime::continuation_for_implicit_exception()`（`sharedRuntime.hpp:201`）。

三种隐式异常对应的硬件信号：

| 异常 | 触发 | 信号 |
|------|------|------|
| NullPointerException | 解引用地址 0 | SIGSEGV |
| ArithmeticException | 除以 0 | SIGFPE |
| StackOverflowError | 栈边界外的写 | SIGSEGV |

设计权衡：省掉了每次访存前的一层 if 检查（≈2-3 条指令），代价是异常发生时需要通过 signal handler 回到 JVM 上下文——这比直接 throw 慢，但 null/dividedByZero 是罕见事件。"optimize for the common case, signal for the rare case"。

**第七层：monitor fast-path — 锁的汇编级快速通道**

`SharedRuntime::monitor_enter_helper()` / `monitor_exit_helper()`（`sharedRuntime.hpp:340-344`）暴露给编译代码直接调用的锁快速通道。编译代码可以用 inlined locking（在汇编中直接操作 mark word 的轻量锁位）——如果膨胀了（contention→ObjectMonitor），fallback 到 slow path（调 C++ ObjectSynchronizer）。

`use_inlined_fast_locking` 参数控制是否走 inlined 路径。inlined locking 是偏向锁之后的第二快路径（biased lock 已被 JDK15 废弃）。

## 设计权衡

一、**adapter 缓存 vs 即时生成**。用 AdapterFingerPrint+哈希表缓存 adapter 省去了每次调用都重新生成映射代码的开销——但哈希表本身占用 CodeCache 空间。权衡是"生成成本 vs 缓存占用"——adapter 的生成成本高（需要生成机器码映射），命中率高（几百个签名适配几千个方法），缓存值得。

二、**`_c2i_entry` vs `_c2i_unverified_entry` 双入口 vs 单入口+条件检查**。双入口省掉已验证路径中一个条件分支（2-3 个 CPU 周期）——但增加了 adapter 的 CodeCache 占用（多了约 10-20 条指令的 entry 代码）。权衡是"节省的 CPU 周期合起来值那块 CodeCache 吗？"——对于热方法，答案是 yes。

三、**隐式异常 vs 显式检查**。显式检查每次访问额外 2-3 条指令，null/除零/栈溢出的频率极低——sig handler 的开销远小于每次访问时的检查开销。代价是 signal handler 需要恢复 JVM 上下文（读 CodeCache 边界表确认 faulting PC 是否在 compiled code 中），这比 C++ throw 慢——但对罕见事件来说值得。

## 核心悬念

**解释器的 Java 栈帧里参数在局部变量表中，编译代码的参数在寄存器里——两者之间有谁来回搬运？SharedRuntime 生成 adpater 当"翻译官"。但翻译官不只做搬运——它还"藏"了惰性链接、IC miss 处理、隐式异常转换等等——为什么把这些都塞在 SharedRuntime 里？**

**→ 下一域**：SharedRuntime 提供了 i2c/c2i 桥接和 IC miss 解析，但 IC miss 解析后怎么把"这个调用点实际只有一种 receiver 类型"的信息转成编译器的优化输入？MethodData 中的 profiling 数据告诉编译器"这大概率是单态的"，但编译器怎么用它做激进的内联和去虚拟化？C1 编译器篇见。

## 预估

1 篇，7 层递进 + 3 个设计权衡，预估 1500-2000 行（🟡B 不做 Pass 3 完整写作，大纲 + 闭环笔记即终稿）。
