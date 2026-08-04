# 15 init_globals 衔接——门面初始化：GC 屏障桩、JIT 阈值、标志位与寄存器名

> **本文定位**：`init_globals()` 第 10-13、15-16 步——五项基础设施的预配。在 `universe_init`（ch14 三表就绪）与 `interpreter_init`（ch16 解释器模板上架）之间。五步中四项是死数据配置，只有一条（JIT 阈值）涉及运行时逻辑——但它们合在一起回答了同一个问题：**解释器和 JIT 在出手之前，需要哪些全局数据已经就位？**
>
> **前置依赖**：ch14（三表就绪）、ch11（G1 BarrierSet 初始化）、ch10（universe_init 序列总览）

### 前置概念速查

本章涉及若干概念已在之前章节详细讲过，这里只做初始化配置的讲解。读者如需回顾完整机制：

| 概念 | 简述 | 详细在哪 |
|------|------|---------|
| SATB 屏障 | G1 并发标记期间的 pre-write barrier——引用赋值之前，将字段旧值推入线程 SATB 队列，保证并发标记不丢失存活对象 | ch11 §10 |
| 写屏障（card marking） | 引用赋值之后，将 card table 对应字节标记为 dirty——并发重扫时只检查脏卡覆盖的区域 | ch11 §10 |
| Card Table | 堆上的字节数组，每 512B 堆区域对应一个 jbyte 标记——决定重扫范围 | ch11 §10 |
| BarrierSet | GC 屏障的多态基类——G1BarrierSet / CardTableBarrierSet 等实现了具体的 enqueue / card mark 逻辑 | ch11 §3 |
| InvocationCounter | 每个方法的 32-bit 计数器——编码状态位 + 纯计数值。解释器每次方法入口递增，到达阈值后触发编译 | 本节 §2 |
| OSR（On-Stack Replacement） | 编译循环热代码——不等方法重新调用，直接在栈帧中替换解释执行点为编译后代码 | 后续 ch16/ch17 展开 |
| MethodData | JIT Profiling 的统计数据对象——记录每个方法的分支频率、类型反馈等，供 C2 做激进优化 | 后续 ch16 展开 |
| VMReg | HotSpot 的虚拟寄存器抽象——以 32-bit 粒度编码 CPU 寄存器，64 位寄存器占两个连续的 VMReg 槽位 | 本节 §3.3 |

---

## 0. 全景

```
init_globals()（runtime/init.cpp:101）:
   9:  universe_init()            ← ch10+ch11+ch14 覆盖完毕
  10:  gc_barrier_stubs_init()    ← §1
  11:  interpreter_init()         → ch16
  12:  invocationCounter_init()   ← §2
  13:  accessFlags_init()         ← §3
  14:  templateTable_init()       → ch16
  15:  InterfaceSupport_init()    ← §3
  16:  VMRegImpl::set_regName()   ← §3
  17:  SharedRuntime::generate_stubs() → ch17
```

| 步 | 函数 | 为谁服务 | 错了会怎样 |
|---|------|---------|----------|
| 10 | gc_barrier_stubs_init | GC 扩展——CMS 等需要预生成屏障桩，G1 为空（屏障由 JIT 内联） | 对 G1 无影响；CMS/Serial 等屏障桩缺失 |
| 12 | invocationCounter_init | 解释器——每个方法调用递增计数器 | JIT 永远不会被触发，或在启动期过早触发 |
| 13 | accessFlags_init | 所有模块——修饰符位解释 | 一条 assert 因结构体大小错误而崩溃 |
| 15 | InterfaceSupport_init | GC 调试——仅 ASSERT 构建 | 无影响 |
| 16 | VMRegImpl::set_regName | 诊断打印——OopMap/栈帧/JIT 调试 | 寄存器号变成裸数而非 "RAX"/"XMM0" |

---

## 1. gc_barrier_stubs_init——GC 屏障的汇编桩

`barrierSet.cpp:44`，一行委托：

```cpp
BarrierSet::barrier_set()->barrier_set_assembler()->barrier_stubs_init();
```

但 `barrier_stubs_init()` 在基类 `BarrierSetAssembler` 中定义为**空函数**（barrierSetAssembler_x86.hpp:81）——G1 没有覆写它。对 G1 而言这一步是 no-op。它存在于 `init_globals` 中是 CMS 时代的遗留代码：CMS 的写屏障曾依赖预生成的汇编桩，G1 的 SATB 和写屏障改为**JIT 内联**——编译 `putfield` / `aastore` 时直接嵌入对应的汇编指令序列，不再是独立的桩代码。调用链未被删除，对 G1 无任何影响。

---

## 2. invocationCounter_init——JIT 何时出手

`invocationCounter.cpp:169`，一行委托 `InvocationCounter::reinitialize(DelayCompilationDuringStartup)`，但 `reinitialize` 内部做了两件独立的事：

### 2.1 方法计数器的状态机

`InvocationCounter` 是每个方法的元数据字段——一个 32-bit `_counter` 变量，位布局为：高 30 位存纯计数值，最低 2 位存状态（`wait_for_nothing`=0 或 `wait_for_compile`=1）和 carry 溢出标记（invocationCounter.hpp:47-71）。

`reinitialize` 不初始化单个方法的计数器——它设置的是**全局参数**：每个状态对应的初始计数值和溢出回调。当新方法创建时，其 `InvocationCounter` 调用 `set_state(wait_for_compile)`，内部从全局 `_init[wait_for_compile]` 取出初始计数值（=0）写入自己的 `_counter` 字段——此后每次方法入口 +1，到达阈值后从全局 `_action[wait_for_compile]` 取溢出回调执行。本节讲的是这层全局参数的设定。

| 状态 | `_init[state]` 初值 | 溢出 action |
|------|---------------------|-----------|
| `wait_for_nothing` | 0 | `do_nothing`——计数器回落至 `CompileThreshold/2`，此后该方法的计数器锁定为解释模式 |
| `wait_for_compile` | 0 | `do_decay`（`DelayCompilationDuringStartup==true`）或 `dummy_invocation_counter_overflow`（false） |

两个状态代表方法的"编译资格"：`wait_for_compile` 是默认态——计数器在增长，到达阈值后触发 action。`wait_for_nothing` 是锁定态——该方法此前已溢出过，当前计数器仍在增长，但**溢出后不触发编译**。

两个 action 决定溢出后的行为：

- **`do_decay`**（invocationCounter.cpp:117）：将计数器当前值按衰减率缩小——启动期大量类加载会产生"假溢出"，`decay` 让计数值随时间回落，避免过早触发编译。衰减后计数器仍在 `wait_for_compile` 状态，后续可以再次触发
- **`do_nothing`**（invocationCounter.cpp:107）：**设置 carry 位**（`set_carry` 内部把计数回落至 `CompileThreshold/2`，并翻转 carry 锁标记），然后将状态切回 `wait_for_nothing`。此后该方法的计数器被锁死——carry 位标记了"已溢出"，解释器入口不再递增它，该方法**永久处于解释模式**

方法计数器在创建时从 `_init[state]` 取值作为初始计数值，解释器每次方法入口递增，到达 `InterpreterInvocationLimit` 后调用对应的 `_action[state]`。

### 2.2 三个触发阈值

`reinitialize` 的第二步——计算三个全局静态变量（invocationCounter.cpp:148-158）：

```cpp
InterpreterInvocationLimit = CompileThreshold << number_of_noncount_bits;
InterpreterProfileLimit = ((CompileThreshold * InterpreterProfilePercentage) / 100) << number_of_noncount_bits;

if (ProfileInterpreter) {
  InterpreterBackwardBranchLimit =
    (CompileThreshold * (OnStackReplacePercentage - InterpreterProfilePercentage)) / 100;
} else {
  InterpreterBackwardBranchLimit =
    ((CompileThreshold * OnStackReplacePercentage) / 100) << number_of_noncount_bits;
}
```

| 阈值 | 触发什么 | 日常路径 |
|------|---------|--------|
| `InterpreterInvocationLimit` | 方法被调太多次 → 触发 C1/C2 编译 | 计数器跟这个值比较 |
| `InterpreterBackwardBranchLimit` | 循环回边太多 → 触发栈上替换（OSR） | `OnStackReplacePercentage=140`（C2），公式乘 CompileThreshold |
| `InterpreterProfileLimit` | Profiling 数据收集触发点 | `InterpreterProfilePercentage=33`，约三分之一的调用后开始记录 MethodData |

`number_of_noncount_bits` = 2（1 个状态位 + 1 个 carry 位，invocationCounter.hpp:50）。所有阈值左移 2 位——保证只有纯计数字段增长时才会触发比较，状态位和 carry 位不计入。

`ProfileInterpreter` 默认 false（x86 平台，globals_x86.hpp:76），日常走 else 分支——阈值被 `<< shift` 处理。若开启 Profiling，`InterpreterBackwardBranchLimit` 不左移——该阈值由 `MethodData` 计数器接管，走的是另一套比较逻辑，不走 `InvocationCounter` 的位段编码。

#### 为什么是三个阈值——Profiling 与分层编译

三个阈值不是因为"有三种不同的触发"，而是因为 **C1/C2 分层编译需要 Profiling 数据**：

1. 方法首次执行 → 解释器运行，每入口 `InvocationCounter +1`
2. 到达 `InterpreterInvocationLimit` → 触发 **C1 编译**（快速、无激进优化）
3. 到达 `InterpreterBackwardBranchLimit`（循环回边） → 触发 **OSR 编译**（不等方法结束，直接在栈帧中替换循环体）
4. 过程中每 `InterpreterProfileLimit` 次调用 → 解释器往 `MethodData` 里记录一次运行时信息——哪个分支被走了、虚方法调用了哪个具体类型等

`MethodData` 是每个方法的附属对象，存 Profiling 数据。C1 产生的编译代码也继续记录 Profiling——因 C1 不做激进优化。当 `MethodData` 中的调用次数再次超过一个新阈值时，**C2 接手**——用收集到的类型反馈做内联、去虚化等重优化。三个阈值中 `InvocationLimit` 和 `BackwardBranchLimit` 是"触发编译"的开关，`ProfileLimit` 则是"开始收集数据的频率"——前者决定何时出手，后者决定 C2 最终出手时手里有多少决策依据。

### 2.3 delay_overflow——启动期缓编译

`DelayCompilationDuringStartup` 默认 true（globals.hpp:1378）。在 `def(wait_for_compile, 0, do_decay)` 中将溢出 action 设为 `do_decay`——启动期大量类加载和方法解析会产生"假溢出"（每个新方法被解析时执行一次 `invoke` 就 +1，但不是真正的热方法）。`do_decay` 让计数器按一定比率回落，延迟 JIT 启动到核心启动之后。

### 2.4 为什么调了两次——解释器与计数器的解耦

`AbstractInterpreter::initialize()`（abstractInterpreter.cpp:55）在第 63 行也调了一次 `reinitialize(DelayCompilationDuringStartup)`——而 `init_globals` 中 `interpreter_init`（第 11 步）先于 `invocationCounter_init`（第 12 步）。不是 bug：解释器和计数器是两个独立模块——解释器初始化时需要确保 JIT 阈值已就位（所以 `AbstractInterpreter::initialize` 里调了一次）；计数器作为独立模块也在 `init_globals` 中做了自己的初始化调用。两次调用参数完全一致，各自不依赖对方的存在——这是两个模块对同一份全局配置的**各自的初始化声明**，不是冗余。

---

## 3. 其余三步——死数据与编译时检查

### 3.1 accessFlags_init——修饰符位域大小的编译时守卫

```cpp
// utilities/accessFlags.cpp:74
void accessFlags_init() {
  assert(sizeof(AccessFlags) == sizeof(jint), "just checking size of flags");
}
```

`AccessFlags` 是类、方法、字段的修饰符位域——public/static/final 等约 20 个 JVM_ACC_* 常量压缩进一个 4 字节 `jint`。它在 Klass 和 Method 对象中作为紧凑位域直接存取。这行 assert 的作用不是"初始化"，而是在 init_globals 序列中声明一个依赖：**如果前面某个模块动了结构体布局把 AccessFlags 变成了 8 字节，在这里立刻崩溃，不让错误延迟到后续的方法调用**。

### 3.2 InterfaceSupport_init——调试 GC 压测（仅 ASSERT）

```cpp
// runtime/interfaceSupport.cpp:264
void InterfaceSupport_init() {
#ifdef ASSERT
  if (ScavengeAlot || FullGCAlot) {
    srand(ScavengeAlotInterval * FullGCAlotInterval);
  }
#endif
}
```

生产构建中整个函数被编译为空。`ScavengeAlot` 和 `FullGCAlot` 是调试 JVM 标志——在每个 safepoint 或分配间隙自动触发一次 Young GC / Full GC，用于压力测试 GC 和 safepoint 协调。`srand` 只设随机种子使 GC 间隔可重现。

### 3.3 VMRegImpl::set_regName——寄存器名称表

`cpu/x86/vmreg_x86.cpp:31`——填充全局 `regName[]` 静态 `const char*` 数组。

**VMReg 是什么**。JIT 编译器在生成机器码时需要管理寄存器的分配——哪些 CPU 寄存器存局部变量、哪些存操作数栈。同时 JIT 的输出（汇编指令）和 GC 的 OopMap（"当前哪些寄存器/栈槽存着 oop 引用"）都需要引用寄存器。HotSpot 不直接用 CPU 寄存器号（RAX=0, RCX=1...），而是用统一的 **VMReg 编号系统**——所有存储位置（CPU 寄存器、浮点寄存器、XMM 寄存器）按 32-bit 粒度编号为一个连续的整数范围。64 位寄存器占用两个连续的 VMReg 编号。

**这个表是干什么的**。`regName[i]` 是一一对应的翻译表：VMReg 编号 `i` → 可读名称。它在以下场景被使用：

- **JIT 调试输出**：打印编译后汇编代码时，把 `mov [rsp+8], v43` 中的 `v43` 解析为 `RAX`
- **OopMap 编码**：描述"在栈帧的某个位置，RAX 存放着一个 oop 引用"——GC 用这个信息在 safepoint 时追溯活对象
- **栈帧解析**：crash 时的 native 栈回溯——把寄存器和栈槽的内容按名称解析出来

举一个具体的 OopMap 场景：JIT 编译某个方法时，把局部变量 `obj` 分配到了 RAX 寄存器。在 safepoint 处，OopMap 记录的不是 "RAX 存着 oop"，而是 "VMReg 编号 0 存着 oop"（因为 RAX 的低 32 位在 VMReg 系统中是编号 0）。GC 遍历 OopMap 遇到编号 0 → 查 `regName[0] = "RAX"` → 打印日志 "RAX = oop at 0x..." → 从 RAX 读值，追溯活对象的引用链。如果没有这张表，日志里只会显示 "编号 0 = oop"——排查 GC 问题时无法对应到具体寄存器。

三类寄存器按索引范围顺序填充：

| 范围 | 类型 | 示例 |
|------|------|------|
| 0..max_gpr | 通用寄存器（GPR） | RAX, RBX, RCX, RDX, RSI, RDI, RSP, RBP |
| max_gpr..max_fpr | x87 浮点寄存器 | ST0..ST7 |
| max_fpr..max_xmm | XMM 寄存器（SSE/AVX） | XMM0..XMM15 |

64 位寄存器在 VMReg 中以 32-bit 粒度编码——一个寄存器占两个连续的 VMReg 槽位。所以数组是双重复写：`regName[i++] = name; regName[i++] = name;`——每个 64 位寄存器占两个 VMReg 编号，但两个编号在代码中指向同一个物理寄存器，所以同个名字重复出现两次。

---

## 4. 小结

这五步做的事可以按"为谁服务"分组：

```
JIT 编译需要:  invocationCounter_init（三个阈值决定何时编译；屏障桩对 G1 是 no-op）

解释器需要:    invocationCounter_init（每次方法入口递增计数器）

诊断需要:      VMRegImpl::set_regName（寄存器号 → 可读名称）

纯守卫:       accessFlags_init（编译时大小断言）
              InterfaceSupport_init（仅 ASSERT 构建）
```

它们不是"算法"——没有分支、没有循环、没有状态变化（除了 invocationCounter_init 的阈值计算）。它们是 init_globals 中的**门面配置层**：在堆上的 Java 对象诞生之前，先把所有全局参数、汇编桩和诊断表调到正确的初始值。
