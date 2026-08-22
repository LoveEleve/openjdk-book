# 09 · 平台、构建与可移植性：专家答案锚点

## 1. 四层目录强制隔离平台差异，避免 `#ifdef` 散落

`share/` 放跨平台逻辑（GC、JIT 图、对象模型、类加载、解释器核心），`cpu/<arch>/` 放 ISA 相关（汇编器、frame、c1 平台实现），`os/<os>/` 放 OS 抽象（虚拟内存、线程、信号、文件），`os_cpu/<os>_<arch>/` 放双平台组合（如 Linux+x86 的栈遍历、信号处理）。

这种隔离不是风格选择，而是工程约束：平台差异必须被关进对应的目录里，而不是散落在 `#ifdef` 中。如果一个函数只在 `share/` 中有实现，说明它是跨平台通用的；如果 `cpu/` 中没有覆盖，那么 `OrderAccess::storeload` 这类必须平台特定的接口就会链接失败。

## 2. `define_pd_global` 在编译期根据目标平台“选出”默认值

`globals.hpp` 定义所有 flag 的跨平台默认值。`globals_<arch>.hpp` 用 `define_pd_global` 宏覆盖 platform-dependent 的默认值（如 `CodeCacheSegmentSize`、`CodeEntryAlignment`）。这些值在编译期被钉死，因为它们是平台 ABI 或硬件参数决定的，不能在运行期动态改。

如果同一个 flag 在 `globals.hpp` 和 `globals_x86.hpp` 都定义了默认值，`define_pd_global` 的覆盖生效。JVM 参数校验在启动时对这类 flag 重新检查，确认运行环境与编译期假设一致。

## 3. 汇编器通过 C++ 继承层次消化 ISA 差异

`AbstractAssembler` 是跨平台基类，`Assembler` 子类按平台提供具体指令编码，`MacroAssembler` 再封装更复杂的指令序列。`__` 宏（`#define __ _masm->`）让调用方用 `__ movl(rax, rbx)` 生成机器码，不关心底下是 x86 还是 AArch64。

平台特有指令（如 x86 的 `lock`、ARM 的 `dmb`）通过条件编译或平台子类区分。CodeBuffer 先管理分区与位置，再交由具体平台 assembler 填入机器码。这种方式让 portability 比手写汇编更可控，因为调用方只依赖稳定接口，平台细节被隔在子类中。

## 4. 构建系统通过 `HOTSPOT_TARGET_CPU_ARCH` 等变量选择源码目录

`configure` 检测目标平台，设置 `HOTSPOT_TARGET_CPU_ARCH`、`HOTSPOT_TARGET_OS` 等变量。make 系统据此选择 `cpu/<arch>/`、`os/<os>/`、`os_cpu/<os>_<arch>/` 下的文件加入编译列表。`share/` 下的文件则总是被编译。

`build/` 目录是独立于 `src/` 的生成区，`adlc` 生成的代码、`jvmti` 生成的文件等都在这里产出。新增 `cpu/<newarch>/` 目录需要同时修改构建配置（如 `CompileJvm.gmk` 中的文件收集规则），否则文件不会被编译。

## 5. x86 与 ARM 在内存序、原子和帧布局上的差异是硬件决定的

x86 TSO 让 `loadload`/`storestore`/`loadstore` 是硬件保证的，只需 `storeload` 屏障。AArch64 弱一致性需要显式 `dmb`/`ldar`/`stlr` 来满足 acquire/release（当前 11u 源码树未包含 AArch64 完整实现，此处仅作机制对比）。

原子操作：x86 用 `lock cmpxchg`（总线锁），ARM 用 `ldrex/strex`（LL/SC，无总线锁但可能重试）。frame 的寄存器映射（如 x86 的 `rbp` 作为帧指针）、栈帧布局、返回地址栈的大小、调用约定的寄存器分配都随 CPU 变化。因此解释器模板、frame 实现、`OrderAccess` 必须每个平台独立实现。

## 6. 跨平台移植的隐藏假设集中在内存序、对齐和栈布局

最容易被忽略的假设包括：

- 内存序假设：x86 上“碰巧成立”的读读/写写顺序在弱一致性平台不成立；
- 对齐与大小假设：`intptr_t` 大小、CacheLine、指针对齐可能不同；
- 原子性假设：复合 `read-modify-write` 在 x86 上看起来原子，在 ARM 上需要 LL/SC 循环；
- 栈/帧布局假设：`frame`、`sender`、寄存器压栈遍历规则不可移植；
- 生成代码假设：StubRoutines 中手写汇编的寄存器约定只对对应平台成立。

移植后应优先做内存序（volatile/fence）、原子（CAS/LL/SC）、GC 栈遍历、JIT 回归测试来暴露这些平台差异。

## 7. 跨平台支持的主线是“稳定接口 + 目录隔离”

`OrderAccess`、`Atomic`、`AbstractAssembler`、`frame`、`globals` 作为稳定接口，定义平台差异的“合同”。平台细节（指令编码、register map、栈布局、屏障实现、ABI）被 `cpu/`/`os/`/`os_cpu/` 目录隔离，不向上泄露。

上层逻辑（GC、JIT 图、对象模型）只依赖稳定接口，不碰平台细节。这意味着“共享逻辑 + 平台实现”比“全 `#ifdef`”更容易维护和测试。那些“碰巧在 x86 上成立”的行为（如 `loadload` 自动成立）不能作为稳定契约，这就是为什么 `OrderAccess` 的接口在 `share/` 中定义，但实现必须每个平台独立。

验证跨平台支持最可靠的手段是编译弱一致性平台（如 AArch64）并运行全量回归测试，因为很多内存序假设只在弱一致性平台上暴露。

## 评分锚点

- **合格**：能说清 `share/`/`cpu/`/`os/`/`os_cpu/` 四层目录、`define_pd_global`、`AbstractAssembler` 的基本概念。
- **良好**：能解释 x86 与 ARM 在内存序、原子、frame 上的关键差异，以及构建系统如何选择平台文件。
- **专家级**：能用“稳定接口 + 目录隔离”的主线，说明 HotSpot 如何从任何平台抽象出跨平台契约，并指出移植时最容易忽略的隐藏假设。