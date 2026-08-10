# Deoptimization — 文章大纲

> vol-04 · 域 30 · 🟡 B | 基于 Pass 0+1 探索笔记
> Pass 1 产出：8 基本元素 / 6 标记问题
>
> **→ 从 C2**：C2 编译了最激进的代码，但它做的假设（"这个虚调只有一种 receiver"、"这个循环的边界是 N"）可能会在未来被破坏。当 C2 的假设被打破时，编译后的代码必须从当前执行点"退回"解释器——去优化（Deoptimization）篇见。

## 概念依赖

先修：C2（理解 C2 做了什么假设，才知道 deopt 要还原什么）、SharedRuntime（deopt blob 是 SharedRuntime 生成的汇编 stub，汇编 stub 和 C++ 之间的桥接在 SharedRuntime）、Interpreter（deopt 的目标是回到解释器——需要能模拟解释器帧的结构）。

Deoptimization 是 JIT 系统的"安全网"——编译代码可以激进地做任何优化，因为当假设被打破时，deoptimization 可以把编译帧退回解释器帧，从安全点重新开始。没有 deoptimization，JIT 只能做保守优化。

## 叙事计划

**开篇场景**：C2 编译了一个方法，假设 `Animal.speak()` 只有 `Dog` 一个实现——把虚调用去虚拟化为直接调用。但运行时，一个新类 `Cat extends Animal` 被加载了。JVM 检测到 `Dog` 不再是唯一的实现——之前编译的假设被打破了。怎么办？把正在执行 `speak()` 的编译帧"撤回"解释器——这就是 deoptimization。

**第一层：DeoptReason — 30 多种"出了什么事？"**

`DeoptReason`（`deoptimization.hpp:42-104`）枚举了 JIT 编译器所有可能被打破的假设。不是笼统的"优化失败"——每种优化的失败需要不同的恢复策略：

| 类别 | 示例 reason | 对应的优化假设 |
|------|------|------|
| 类型检查 | `Reason_class_check` | "这个 receiver 一定是 `Dog`" → 但来了 `Cat` |
| 空值检查 | `Reason_null_check` | "这个引用不会是 null" → 但它是 |
| 范围检查 | `Reason_range_check` | "数组索引在 bound 内" → 但它超出了 |
| 类加载 | `Reason_unloaded` | "这个类已经加载了" → 但它被卸载了 |
| 循环 | `Reason_loop_limit_check` | "循环边界是 N" → 但实际跑得更多 |
| 谓词 | `Reason_predicate` | "在循环外检查的谓词保证成立" → 但它不成立 |
| 类型预测 | `Reason_speculate_class_check` | "MDO 说这个 receiver 是 `Dog`" → 但不是 |

关键设计：不是每种 reason 都需要"废掉"当前编译。`Reason_null_check`（少见）可以先尝试重新编译（`Action_maybe_recompile`）；`Reason_unloaded`（类被卸载了，方法根本不能用了）必须标记 `Action_make_not_compilable`。

**第二层：DeoptAction — 去优化后怎么处理 nmethod？**

`DeoptAction`（`deoptimization.hpp:108-115`）定义了 4 种后续处理：

| Action | 含义 | 适用于 |
|------|------|------|
| `Action_none` | 不回退不失效——只在解释器重走一遍 | transient 失败，nmethod 可保留 |
| `Action_maybe_recompile` | 可能重编译——nmethod 可继续用 | 偶发 deopt，无需失效 |
| `Action_reinterpret` | 失效 nmethod + 重置 IC + 允许重编译 | 类被加载→IC 变成多态→需要重编 |
| `Action_make_not_compilable` | 永久标记此方法不可编 + 失效 nmethod | 根本性失败（类卸载/不可解决的 issue） |

关键设计：reason 和 action 不是静态映射表——由编译器在生成 uncommon trap 时编码到 `trap_request` 中（`deoptimization.hpp:334-348`：`make_trap_request(reason, action, index)` 编码为 32-bit 整数——action 占 3 bits，reason 占 5 bits）。编译器根据上下文为同一 reason 选不同 action——deoptimization 引擎只解码执行。例如 `Reason_null_check` 常用 `Action_maybe_recompile`（重编加 null guard），但如果 tenured method 中 null check 反复触发，编译器可升级到 `Action_make_not_compilable`。

**第三层：三阶段去优化管道**

去优化不是"jmp 到解释器入口"那么简单——需要：

1. **收集信息**（C++：`fetch_unroll_info()`）：遍历当前编译帧中的所有内联层。对于每个内联层，从 nmethod 的 `ScopeDesc`（描述内联结构）+ `PCDesc`（给定 PC 找到对应的 scope）+ `DebugInfoReadStream`（读取 saved 的寄存器/栈值）中提取"在这一层，当前 BCI、局部变量值、操作数栈、monitor 状态是什么"。

2. **生成蓝图**（`create_vframeArray()` → `UnrollBlock`）：按内联层→解释器帧的映射，计算每帧需要多少字节的栈空间、每个局部变量/操作数栈 slot 的值来源、需要重新锁住的 monitor。产出 `UnrollBlock`——汇编 stub 可以直接按蓝图在栈上重建解释器帧。

3. **执行重建**（汇编 stub + C++：`unpack_frames()`）：汇编 stub 按 UnrollBlock 在栈上分配帧空间，调 `unpack_frames()` 把每个 slot 的值写进去——局部变量、操作数栈、monitor、return address。然后"跳"到解释器的 dispatch loop，从目标 BCI 继续执行。

三步合在一起的本质是：**编译帧是"变量在寄存器里 + native 栈帧"——解释器帧是"变量在局部变量表 + Java 栈"——deoptimization 就是把前者翻译成后者。**

**第四层：vframeArray — 从编译帧翻译出解释器帧**

`vframeArray`（`vframeArray.hpp`）是去优化的核心数据结构。它是一组 `vframeStream` 的数组——每个表示一个去优化栈层（对应一个内联层）。`create_vframeArray()` 的工作：

1. 从当前的 `frame(thread)` 开始，逐层 `sender_for_compiled_frame` 向上遍历
2. 每层用 nmethod 的 `ScopeDesc` 确定"这一层是哪个方法 + 哪个 BCI"
3. 用 `DebugInfoReadStream` 从编译帧的寄存器/栈值中读回局部变量和操作数栈值
4. 如果 C2 在这一层做了标量替换（逃逸分析→对象变成字段），标记 `ObjectValue`——后面 `realloc_objects` 会处理

vframeArray 本身不是解释器帧——它是"描述解释器帧应该长什么样"的中间表示。实际的帧重建由 `unpack_frames()` 按照 vframeArray 的描述在栈上执行。

**第五层：realloc_objects — 把标量替换"转回去"**

C2 逃逸分析的一个关键优化是标量替换——把 `Point p = new Point(x,y)` 变成两个局部变量 `p_x` 和 `p_y`（分配消除）。但 deopt 时，调用它的代码期望收到一个真实的 `Point` 对象——不能给两个 int。

`realloc_objects()`（`deoptimization.cpp:809`）的工作：
1. 为每个 `ObjectValue` 在堆上分配真实对象（`InstanceKlass::allocate_instance(THREAD)` ——正常的 Java 堆分配，不是跳过构造器的 direct allocation）
2. 从编译帧的寄存器/栈值中恢复每个字段的值（`reassign_fields`）
3. 把恢复后的真实对象存入解释器帧的对应 slot

这个过程是 deopt 最昂贵的部分——可能触发 GC（堆分配），可能 OOM。如果 realloc 失败（OOM），`pop_frames_failed_reallocs()` 会放弃重建的帧，抛 OOME。

**第六层：uncommon_trap vs deoptimize — 两种触发方式**

有两种触发去优化的路径：

| 路径 | 函数 | 触发条件 | 语义 |
|------|------|------|------|
| uncommon trap | `uncommon_trap()` | C2 主动在代码中插入的"假设检查点" | "我不确定这个假设，但不常见——跑的话就退回去" |
| deoptimize | `deoptimize()` | 运行时检测到不可挽回的违反 | "类被卸载了/常量池变了——正在跑的帧必须退回去" |

`uncommon_trap` 是 C2 特有的——C2 在优化代码中插入 `UncommonTrap` 指令（条件跳转+call uncommon_trap），当条件成立时（如 receiver 不是期望类型），跳进 uncommon_trap blob → C++ → deopt。`deoptimize` 是通用的——当 JVMTI/class redefinition/code eviction 导致 nmethod 失效，所有活跃的线程调用该 nmethod 都需要退回去。

**惰性去优化**：`deoptimize()` 不是立刻翻转当前线程的栈帧——它先 `patch` nmethod 的入口点为 `make_not_entrant`，阻止新线程进入。当前正在执行编译代码的线程不被中断——它们继续执行直到下一个 safepoint 或方法返回点，在到达时检查"这个 nmethod 被标记失效了没有？"如果是→触发实际的帧翻译。这避免了在任意代码点强制中断的风险（类似于 safepoint 的"协作式"哲学）。

C1 也使用同一套 deopt 基础设施，但语义略有不同：C1 用 `Unpack_reexecute`（重执行当前字节码，`UnpackType=3`），而 C2 用 `Unpack_uncommon_trap`（重做最后一条字节码，`UnpackType=2`）。两种 unpack 模式的区别在于 BCI 的偏移——reexecute 回退到当前 BCI 的开头，uncommon_trap 回到上一个 BCI。

**去优化的 profiling 反馈环路**：deopt 触发后，`update_method_data_from_interpreter()` 在 MDO 中记录 `trap_state`——trap reason + 是否触发重编译。下次 C2 重新编译这个方法时，读取 MDO 中的 trap history → 如果同一个 BCI 的 class_check 发生了 3 次以上 → C2 不再做去虚拟化假设（保守编译）——避免 deopt→重编→deopt 的 ping-pong。

**设计权衡**

一、**deopt频率 vs 编译保守性**。Deopt 给了 C2 做任何激进假设的自由——但如果 deopt 太频繁（profiling 数据不稳定），deopt→重编译→再 deopt 形成 ping-pong。`Reason_tenured` 是最后一道防线：nmethod 老到一定程度后不再 deopt 它，而是让 C2 重编稳定的版本。

二、**realloc_objects 的代价**。标量替换在正常路径上省了分配+GC，但在 deopt 路径上需要执行堆分配——`InstanceKlass::allocate_instance()` 是完整 Java 分配（包括 GC 触发可能）。C2 必须权衡：这个对象被标量替换后 deopt 的概率多大？如果 profiling 数据显示 receiver 类型高度稳定（MDO 中 99% 是同一类型），deopt 概率 <1%——标量替换稳赢。如果类型不稳定（50/50 bimorphic），标量替换可能亏损。

## 核心悬念

**JIT 编译器做了激进假设——"这个调用点只有一种 receiver"、"这个循环最多跑 N 次"——但当假设被打破时，正在执行编译代码的线程怎么从半掉的优化中安全退回到解释器？Deoptimization 的答案是：把编译帧的所有状态"翻译"回解释器帧，从被打破假设的那个 BCI 重新开始解释执行。**

**→ 下一域**：解释器执行 invokevirtual 用 vtable，JIT 用 inline cache——但 JDK7 引入的 invokedynamic 指令呢？它不调用固定方法——它调用 bootstrap 方法动态产生的 MethodHandle。Lambda 表达式、method reference、字符串拼接——这些现代 Java 特性都靠 MethodHandles 实现。MethodHandles 篇见。

## 预估

1 篇，5 层递进 + "两种触发/DeoptReason+Action" + 2 设计权衡，预估 1800-2500 行（🟡B 不做 Pass 3 完整写作）。
