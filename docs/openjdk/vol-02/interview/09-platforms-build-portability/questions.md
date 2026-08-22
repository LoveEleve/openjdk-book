# 09 · 平台、构建与可移植性：深度题目

## 1. HotSpot 为什么要把“共享逻辑”和“平台细节”分开到 share / cpu / os / os_cpu 四层？

一份 HotSpot 源码要运行在 x86/AArch64/S390 等 CPU、Linux/Windows/macOS 等 OS 上。为什么它不写一份“通用 C++”，而强制把代码分成 `share/`、`cpu/<arch>/`、`os/<os>/`、`os_cpu/<os>_<arch>/` 四层？

回答必须覆盖：

- `share/` 是跨平台逻辑（GC、JIT 图、对象模型、类加载）；
- `cpu/<arch>/` 是 ISA 相关（汇编器、寄存器编码、frame 布局、调用约定）；
- `os/<os>/` 是 OS 抽象（虚拟内存、线程、信号、文件）；
- `os_cpu/<os>_<arch>/` 是双平台组合（如 Linux+x86 的栈遍历细节）；
- 为什么平台差异被目录强制隔离，而不是散落在 `#ifdef` 里。

追问：如果你看到一个函数只在 `share/` 中有实现、`cpu/` 中没有对应覆盖，说明什么？为什么 `OrderAccess`、`Atomic` 这类原子/内存序接口必须每个平台单独实现？

源码入口：`src/hotspot/share/`、`src/hotspot/cpu/x86/`、`src/hotspot/os/linux/`、`src/hotspot/os_cpu/linux_x86/`。

## 2. `globals_x86.hpp` 和 `share/runtime/globals.hpp` 之间是什么关系？

同一份 flag 为什么既要平台默认值，又要有跨平台默认值？`define_pd_global` 如何在编译期“选定”平台值？

回答必须覆盖：

- `globals.hpp` 定义跨平台默认值（product/manageable/diagnostic）；
- `globals_<arch>.hpp` 用 `define_pd_global` 覆盖 platform-dependent 默认值；
- `CodeCacheSegmentSize`、`CodeEntryAlignment` 为什么必须平台相关；
- `pd_` 前缀（platform-dependent）在 flag 体系里的语义；
- 为什么这些值在编译期被钉死，不能运行期动态改。

追问：如果同一个 flag 在 `globals.hpp` 和 `globals_x86.hpp` 都定义了默认值，最终生效的是哪一个？为什么 JVM 参数校验要在启动时对这类 flag 重新检查？

源码入口：`share/runtime/globals.hpp:1825`、`cpu/x86/globals_x86.hpp:40`、`cpu/x86/globals_x86.hpp:49`。

## 3. 汇编器层如何用一个 AbstractAssembler 抽象，消化掉 CPU 之间的指令差异？

JIT 和 StubRoutines 生成代码时，为什么写成 `__ movl(...)`、`__ jcc(...)` 就能跨平台？这个抽象的关键在哪？

回答必须覆盖：

- `AbstractAssembler` 作为跨平台基类；
- `Assembler`/`MacroAssembler` 子类按平台提供具体指令编码；
- `CodeBuffer` 如何先管理分区与位置、再由具体平台 assembler 填入机器码；
- `__` 宏如何把“当前 assembler 上生成一条指令”隐藏起来；
- 为什么平台特有的指令（如 x86 的 `lock`、ARM 的 `dmb`）会用条件编译或平台子类区分。

追问：如果 `MacroAssembler::fast_sin` 在 x86 和 AArch64 上差别很大，调用方怎么才能不关心平台？为什么这种“C++ 调用生成机器码”的模式让 portability 比手写汇编更可控？

源码入口：`share/asm/assembler.hpp:82`、`cpu/x86/assembler_x86.hpp:81`、`cpu/x86/macroAssembler_x86.hpp:37`、`share/asm/codeBuffer.hpp:340`。

## 4. 构建系统为什么能根据目标平台“挑出”对应的 cpu/os 文件，而不是把全部文件都编进去？

OpenJDK 的构建（configure + make）如何知道当前是哪种 CPU/OS，并只编译 `cpu/x86/`、`os/linux/` 这些对应文件？

回答必须覆盖：

- `configure` 阶段的 `--with-target-bits`/目标检测；
- make 中的 `platform_defines`/`HOTSPOT_TARGET_CPU_ARCH` 等变量如何选择源码目录；
- `share/native/`、`os/`、`os_cpu/` 下文件的收集规则；
- 为什么 `build/` 目录是独立于 `src/` 的生成区；
- 为什么目标平台不是当前 build 机时会用到交叉编译（cross-compile）概念。

追问：如果一个平台新增了 `cpu/<newarch>/` 目录，除了写源码还要改哪几处构建配置？为什么“只加文件不加构建规则”通常会失败？

源码入口：`make/hotspot/lib/CompileJvm.gmk`、`make/hotspot/lib/JvmFlags.gmk`、`make/autoconf/`。

## 5. 同一份 JIT 代码，为什么在 x86 和 ARM 上对“内存序/原子/调用约定”遵守的规则不同？

`OrderAccess`、`Atomic`、`frame` 在 x86 和 AArch64 上的实现为何必须分开？它们各自解决什么不同的硬件前提？

回答必须覆盖：

- x86 TSO：`loadload`/`storestore`/`loadstore` 是硬件保证，只需 `storeload` 屏障；
- AArch64 弱一致性：需要显式 `dmb`/`ldar`/`stlr` 来分别满足 acquire/release；
- 原子操作的 x86 `lock cmpxchg` 与 ARM `ldrex/strex`（LL/SC）差异；
- `frame` 的寄存器映射、栈帧布局、`sender` 规则随 CPU 变化；
- 调用约定（ABI）：参数在寄存器还是栈上、返回地址在哪，决定解释器/编译帧怎么搭。

追问：如果把 x86 的 `OrderAccess` 实现原样搬到 AArch64，会先在哪条路径上产生可见性错误？为什么 `interpreter` 的 x86 与 AArch64 模板没法通用？

源码入口：`os_cpu/linux_x86/orderAccess_linux_x86.hpp:40`、`cpu/x86/frame_x86.cpp:451`。（说明：AArch64 平台实现未包含在当前 11u 源码树中，这里仅作机制对比，不绑定具体行号。）

## 6. 跨平台移植一个 HotSpot GC 或 JIT 优化，最容易在哪类“隐藏平台假设”上踩坑？

移植者常常以为跨平台代码只要“能编译”就行。实际跨平台移植最容易忽略哪几类非显式的平台假设？

回答必须覆盖：

- 内存序假设：在 x86 上“碰巧成立”的读读/写写顺序在弱一致性平台不成立；
- 对齐与大小假设：`intptr_t` 大小、CacheLine、指针对齐；
- 原子性假设：复合 `read-modify-write` 在 x86 上看起来原子、在 ARM 上需要 LL/SC；
- 栈/帧布局假设：`frame`、`sender`、寄存器压栈遍历规则；
- 生成代码假设：StubRoutines 中手写汇编的寄存器约定只在对应平台成立。

追问：如果只做“编译过、测试过 x86”，为什么仍不能声称跨平台？你会在移植后优先做哪类测试（内存序、原子、GC 栈遍历、JIT 回归）来暴露这些假设？

源码入口：`os_cpu/linux_x86/orderAccess_linux_x86.hpp:40`、`cpu/x86/macroAssembler_x86.cpp:1069`、`share/runtime/atomic.hpp:129`。

## 7. 这些平台抽象合起来，是如何让“一份上层逻辑、多个平台实现”真正成立的？

从 `OrderAccess`、`Atomic`、汇编器、frame、globals 到构建系统，HotSpot 跨平台支持的主线约束是什么？哪些东西必须平台相关，哪些可以共享？

回答必须覆盖：

- 稳定接口（OrderAccess、Atomic、AbstractAssembler、frame、globals）作为平台差异的“合同”；
- 平台细节（指令编码、register map、栈布局、屏障实现、ABI）被目录隔离；
- 上层逻辑（GC、JIT 图、对象模型）只依赖稳定接口，不碰平台细节；
- 为什么“共享逻辑 + 平台实现”比“全 `#ifdef`”更容易维护和测试；
- 哪些“碰巧在 x86 上成立”的行为不能作为稳定契约（如内存序自动成立）。

追问：如果 HotSpot 改用一个“单一平台上没有的约定”（比如把 acquire 实现成 x86 的 `lock addl`），为什么这种实现不能进 `share/`？验证跨平台支持是否最可靠的手段是编译弱一致性平台 + 全量回归，还是其他？

源码入口：`share/runtime/orderAccess.hpp:258`、`share/asm/assembler.hpp:82`、`share/runtime/globals.hpp:1`、`make/hotspot/lib/CompileJvm.gmk`。