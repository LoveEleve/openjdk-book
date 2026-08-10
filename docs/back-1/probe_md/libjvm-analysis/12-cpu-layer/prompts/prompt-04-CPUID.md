# PROMPT: 请撰写 04-CPUID.md

## §〇 背景与生产场景

### 你在生产中经历的 SIGILL 崩溃

同一份 OpenJDK 11 二进制在旧服务器上运行正常，迁移到一批新采购的服务器后，部分节点在启动时直接崩溃：

```
#
# A fatal error has been detected by the Java Runtime Environment:
#
#  SIGILL (0x4) at pc=0x00007f8b1400a520, pid=9823, tid=9825
#
# Problematic frame:
# j  [unknown] 0x00007f8b1400a520  ; 解释器或 JIT 生成的代码段
```

你一头雾水——相同 JDK 版本为什么会 SIGILL？

反汇编 0x00007f8b1400a520 周围：

```asm
; 0x00007f8b1400a520 前后的指令
0x00007f8b1400a518: vmovdqu ymm0, [rdi]      ; AVX 256-bit 加载——可能是数组拷或 String 操作
0x00007f8b1400a51d: vpaddd  ymm1, ymm0, ymm2  ; AVX2 操作
0x00007f8b1400a522: vmovdqu [rsi], ymm1       ; ← 这条指令在执行时 CPU 说 "不认识" → SIGILL
```

根因：新服务器的 CPU 型号虽然较新，但 BIOS/固件只启用了部分 AVX 扩展——CPU 的 CPUID 报告"支持 AVX2"，但 OS 层面（XCR0/XSAVE 区域）没有启用 YMM 状态保存。JVM 根据 CPUID 报告生成了 AVX2 指令 → 执行时触发 SIGILL → JVM 直接崩溃。

在另一台服务器上——同一份 JDK 正常工作。为什么？因为那台服务器的 BIOS + kernel 版本完整支持了 AVX2 的全套环境（CPUID + XGETBV + XSAVE 都正确），JVM 的 CPUID 探测准确识别了这一点。

### 你在 `hd /proc/cpuinfo` 中看到的

```bash
$ cat /proc/cpuinfo  | grep flags | head -1 | tr ' ' '\n' | grep -E 'sse|avx|bmi|fma|popcnt'
fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush
dts acpi mmx fxsr sse sse2 ss ht tm pbe syscall nx pdpe1gb rdtscp lm constant_tsc
arch_perfmon pebs bts rep_good nopl xtopology nonstop_tsc cpuid aperfmperf pni
pclmulqdq dtes64 monitor ds_cpl vmx smx est tm2 ssse3 sdbg fma cx16 xtpr pdcm
pcid dca sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c
rdrand lahf_lm abm 3dnowprefetch cpuid_fault epb cat_l3 cdp_l3 invpcid_single
pti intel_ppin ssbd mba ibrs ibpb stibp tpr_shadow vnmi flexpriority ept vpid
eptept_ad fsgsbase tsc_adjust bmi1 avx2 smep bmi2 erms invpcid cqm mpx rdt_a
avx512f avx512dq rdseed adx smap clflushopt clwb intel_pt avx512cd avx512bw
avx512vl xsaveopt xsavec xgetbv1 xsaves cqm_llc cqm_occup_llc cqm_mbm_total
cqm_mbm_local dtherm ida arat pln pts pku ospke avx512_vnni md_clear flush_l1d arch_capabilities
```

你看到 flags 中列着 `sse sse2 ssse3 sse4_1 sse4_2 avx fma avx2 avx512f avx512dq avx512cd avx512bw avx512vl avx512_vnni...`。但 `/proc/cpuinfo` 的信息是 OS 读 CPUID 后格式化的文本——JVM 不走这个路径。JVM 自己调 `cpuid` 指令直接读硬件寄存器——更快、更精确、没有 OS 内核的过滤/缓存/误报。

### 你在 GDB 中单步跟踪 CPUID 看到的

在探测 stub 中，第一个 cpuid 调用是 leaf 1（获取基本特性）。用 GDB 在 `generate_get_cpu_info` 的 cpuid 指令处设断点单步跟踪：

```
(gdb) p/x $eax
$1 = 0x1                   # leaf 1 = "告诉我你的基本特性"

(gdb) x/3i $pc
=> 0x7ffff7e1a123: cpuid   # 即将执行 CPUID 指令（opcode 0x0FA2）
   0x7ffff7e1a125: lea    rsi,[rbp+0x70]
   0x7ffff7e1a129: mov    DWORD PTR [rsi+0x8],ecx

(gdb) si                    # 单步执行 cpuid
(gdb) p/x $eax
$2 = 0x506e3               # EAX = 标准信息: Family/Model/Stepping

(gdb) p/x $ecx
$3 = 0x1c9f8fbf            # ECX = 所有基本特性 bit:
                            # bit 0  = SSE3 ✓
                            # bit 9  = SSSE3 ✓
                            # bit 19 = SSE4.1 ✓
                            # bit 20 = SSE4.2 ✓
                            # bit 25 = AVX ✓ (1 << 25 = 0x02000000)
                            # bit 27 = OSXSAVE ✓ (1 << 27 = 0x08000000)
                            # bit 28 = AVX2 ✓ (1 << 28 = 0x10000000)

(gdb) p/x $edx
$4 = 0xbfebfbff            # EDX = 基础特性 (bit 25=SSE, bit 26=SSE2)
```

`$ecx = 0x1c9f8fbf` 的 bit 25 = 1，说明 CPU 硬件支持 AVX。但 JVM 不能仅凭这一个 bit 就启用 AVX——它还必须在下一个 step 中检查 bit 27（OSXSAVE）：如果 OSXSAVE = 0，说明 OS 没有开启 XSAVE/XGETBV 机制 → 即使 CPU 有 AVX 硬件也不安全 → UseAVX 必须 = 0。这就是 JVM 不读 `/proc/cpuinfo` 而直接调 cpuid 的核心原因——`/proc/cpuinfo` 只有 CPU 的"声明"，没有 OS 层面的验证信息（XCR0 状态）。

### 当 SIGILL 发生时——"为什么连 hs_err 都没有"

SIGILL 发生在 JVM 的代码段（解释器或 JIT 输出），这意味着 JVM 的 V 表 handler 应该捕获它。但 SIGILL 的特殊性在于：

- 如果 SIGILL 发生在解释器的初始生成阶段（JVM 启动时用 CPUID 探测后的第一时间生成），这时 JVM 的错误报告设施还没完全就位
- 如果 SIGILL 发生在 JIT 编译线程——这个线程本身需要 hs_err 生成 → 而 hs_err 生成本身需要执行代码（包括可能的 SSE 指令来格式化/输出）→ 再次 SIGILL
- 如果 SIGILL 发生在信号处理器内部——`VMError::report_and_die` 作为信号处理器调用栈的一部分使用了 AVX 被触发的同一套指令 → 递归 SIGILL

这就是"在 JVM 里 SIGILL 是最可怕的"——因为它可能在 hs_err 还没写完之前又触发一次。而这几乎总是因为 CPUID 探测和实际硬件能力不匹配。

## §一 任务 + 核心叙事

读者已学完 [12-01-Frames]（帧布局）、[12-02-Interpreter]（解释器代码生成依赖 UseSSE/UseAVX）、[12-03-Stubs]（stub 代码生成也依赖 CPU 特性 flag）。这三个文档在代码生成时反复出现 `if (UseSSE >= 2)` 和 `if (UseAVX >= 2)` 等条件——但 flag 的值从哪来？

现在该看 JVM 的"安全底线"——**`VM_Version::initialize()` + CPUID 指令探测 CPU 特性的完整过程**。如果这个探测失败或误判，JVM 可能生成 CPU 不支持的指令 → SIGILL → JVM 直接崩溃（连 hs_err 都来不及写）。此外，探测结果决定了 JIT 编译器可以生成多高效的代码——AVX2 的 256-bit SIMD 比 SSE2 的 128-bit 快 2-3 倍。

### ★ 这不是 CPUID 指令参考手册

**本文不是 Intel CPUID 指令集参考**——不讲 CPUID leaf 0x80000001 的 EDX bit 29 是"Long Mode"、不讲 leaf 0x07 sub-leaf 0 的 EBX 的每一 bit 映射表、不讲 leaf 0x04 的 EAX cache 拓扑编码格式（cache type/level/ways/sets）。本文只关心 **JVM 怎么调 CPUID 以及为什么调**——`VM_Version::initialize()` 中 20+ 次 CPUID 调用各探测什么特性、结果如何影响 `UseSSE`/`UseAVX`/`UseBMI` 等 flag。

**本文不是虚拟化技术教程**——不讲 Intel VT-x 的 VMCS 结构、不讲 AMD-V 的 VMCB、不讲 CPUID 在 guest 环境中的 trap/emulation 机制。本文只关心 **"某些虚拟化环境让 CPUID 说谎"**这一事实——以及 JVM 如何用"双验证"（CPUID + XGETBV）来防范这种说谎。

**本文不是 Signal 处理教程**——不讲 SIGILL 的信号屏蔽字处理、不讲 `si_code` 的 SI_KERNEL vs SI_USER 区分、不讲信号栈（`sigaltstack`）的分配策略。本文只关心 **SIGILL 的原因（CPUID 谎报）** 和 **探测 stub 内部的故障恢复机制**（`_cpuinfo_segv_addr` / `_cpuinfo_cont_addr` 哨兵）。

### ★ 你需要知道的（零 x86 知识的 Java 工程师在进入源码前必须理解的 4 个概念）

#### 概念 1：CPUID 指令

CPUID 是 x86 CPU 内建的一个特殊指令——你可以把它理解为 CPU 的"自我介绍函数"：

```
// 伪代码：
mov eax, <question_number>     // 选择问什么 (leaf)
mov ecx, <sub_question_number> // 子问题编号 (sub-leaf)
cpuid                          // CPU 回答 → 结果在 eax/ebx/ecx/edx 中
```

每个 "leaf"（EAX 值）代表一个"问题类别"——比如 leaf 1 = "你支持哪些基本特性？"，leaf 7 = "你支持哪些扩展特性？"。ECX 是子问题编号（sub-leaf）。CPUID 执行后，EAX/EBX/ECX/EDX 四个 32-bit 寄存器中存储了"回答"——每个 bit 代表一个具体特性（如 ECX bit 25 = SSE4.1 支持）。JVM 通过读取这些 bit 来确定 CPU 支持哪些特性。

#### 概念 2：SSE/AVX 是什么

SIMD (Single Instruction Multiple Data) 指令集。一条指令同时操作 128-bit (SSE) / 256-bit (AVX2) / 512-bit (AVX-512) 的数据。对于 Java，这在数组拷贝（`System.arraycopy` 的 intrinsic, `rep movsq` 或 `vmovdqu`）、String 操作（拉丁编码的 compress/expand）、Math 函数（sin/cos/exp 的向量化）、GC 的卡表扫描中有显著加速。一条 AVX2 指令可以在 1 cycle 内完成 8 个 int 的加法（vs SSE 的 4 个 int or 标量循环的 1 个 int/cycle）。

#### 概念 3：SIGILL

`SIGnal ILLegal instruction`——当 CPU 遇到它不认识的机器码时发出信号。常见原因：
(1) CPU 太旧不支持该指令——CPU 解码器遇到非法的 opcode 前缀（如 VEX prefix 在老 CPU 上未定义）
(2) 虚拟化环境暴露的 CPU 特性有误——hypervisor 报告 guest CPU 支持 AVX2 但宿主机实际禁用
(3) OS 没有正确配置扩展寄存器状态保存（XSAVE 区域未包括 YMM/ZMM 寄存器）
(4) 代码生成器生成了错误指令——bug

#### 概念 4：XSAVE/XSAVEC 和 XGETBV

XSAVE 是一组保存/恢复扩展寄存器状态的指令。AVX 使用 256-bit YMM 寄存器——这些寄存器在 context switch 时必须被 OS 保存/恢复。`xgetbv`（读 XCR0 控制寄存器）告诉软件"OS 承诺保存哪些寄存器状态"。如果 CPUID 报告支持 AVX 但 XCR0 中的 YMM state bit 未设置 ——说明 OS 不打算保存 YMM → 使用 AVX 会导致 context switch 后寄存器内容被破坏 → JVM 必须禁用 AVX。

JVM 的探测不是只调 CPUID——在 AVX 探测中，必须同时验证 XGETBV 的结果（XCR0 中 bit 1 = XMM 支持，bit 2 = YMM 支持，bit 5/6/7 = Opmask/ZMM_hi256/Hi16_ZMM 支持）。如果 CPUID 说有但 XCR0 说没有 → 信 XCR0（OS 不承诺保存 → 不安全）。

### 核心叙事线 — "JVM 的 CPU 自检——从无到有确定所有可用指令集"

[12-02] 和 [12-03] 的代码生成中，到处可见 `if (UseSSE >= 2)` 等条件——这些 flag 的值来自本文的 CPUID 探测。流程图：CPUID 指令 → 原始 bit 位 → `VM_Version::initialize()` 解析 → 设置 `UseSSE/UseAVX/UseBMI` 等 flag → [12-02] 和 [12-03] 代码生成时读取 flag → 决定生成 SSE 版本还是 x87 版本、AVX2 版本还是 SSE2 版本。04 是 02/03 的"开关控制层"。

和 [11-os-layer] 的独立宣言——CPUID 直接访问 CPU 硬件，无需系统调用，无需 `/proc/cpuinfo`。`/proc/cpuinfo` 是 OS 读了 CPUID 后格式化的文本，JVM 不走这个路径——直接调 CPUID 更快、更精确（没有 OS 内核的过滤/缓存/误报）。这是 CPU 层和 OS 层之间的"独立宣言"——CPU 真实能力的唯一真理来源在芯片上。

### 验证报告
- `sverklo_search "VM_Version::initialize VM_Version_StubGenerator generate_get_cpu_info get_processor_features"` → vm_version_x86.cpp
- `codegraph query "VM_Version::initialize"` → vm_version_x86.cpp
- `rg -n "UseSSE\|UseAVX\|UseBMI\|UseFMA" globals.hpp` → CPU 特性 flag 声明
- `rg -n "CpuidInfo.*std_cpuid1\|ext_cpuid7\|std_cpuid1_ecx\|ext_cpuid7_ebx" vm_version_x86.hpp` → CPUID bitfield 定义
- `rg -n "EFLAGS\|cpuid\|eax.*0x[0-9a-fA-F]" vm_version_x86.cpp` → CPUID leaf 调用
- `rg -n "_cpuinfo_segv_addr\|_cpuinfo_cont_addr" vm_version_x86.cpp` → SIGILL 恢复哨兵

## §二 标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintAssembly`
- 64 位 Linux x86_64
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ 两种测试 CPU：(a) 支持 AVX2 的 Haswell+，(b) 仅支持 SSE4.2 的 Nehalem/Penryn（或用 QEMU 模拟）
- ★ `-XX:UseAVX=0` 用于对比测试——验证 flag 手动降级

## §三 聚焦源文件

| # | 文件 | 路径 | 模块 | 核心函数/类 | 本文角色 |
|---|------|------|------|-----------|---------|
| 1 | `vm_version_x86.cpp` | `src/hotspot/cpu/x86/vm_version_x86.cpp` | cpu/x86 | `VM_Version::initialize()`(:~100), `VM_Version_StubGenerator::generate_get_cpu_info`(:65), `get_processor_features` | ★★★ CPU 探测核心——完整探测 + Stub 生成 |
| 2 | `vm_version_x86.hpp` | `src/hotspot/cpu/x86/vm_version_x86.hpp` | cpu/x86 | `CpuidInfo` 结构体, `std_cpuid1_ecx` bitfield, `ext_cpuid7_ebx` bitfield, `avx512_info` | ★★ CPUID 返回值的 bit 位定义和解析 |
| 3 | `vm_version_ext_x86.cpp` | `src/hotspot/cpu/x86/vm_version_ext_x86.cpp` | cpu/x86 | 品牌字符串提取、缓存拓扑提取 | ★ 扩展 CPU 信息——品牌 + cache info |
| 4 | `assembler_x86.cpp` | `src/hotspot/cpu/x86/assembler_x86.cpp` | cpu/x86 | `Assembler::cpuid` 助手——封装 cpuid 指令的 emit | ★ CPUID 指令封装 |
| 5 | `vm_version.cpp` | `src/hotspot/share/runtime/vm_version.cpp` | runtime | `VM_Version` 基类、跨平台接口 | 抽象基类 |
| 6 | `globals.hpp` | `src/hotspot/share/runtime/globals.hpp` | runtime | `UseSSE`, `UseAVX`, `UseBMI`, `UseFMA`, `UseSHA`, `UseCLMUL` 等 flag 声明 + 默认值 | ★★★ 所有 CPU 特性 flag——探测后修改 |
| 7 | `macroAssembler_x86.cpp` | `src/hotspot/cpu/x86/macroAssembler_x86.cpp` | cpu/x86 | 各种 SSE/AVX 指令——由 UseSSE/UseAVX 条件编译选择 | ★ 探测结果的消费端——决定生成的指令版本 |

**跨模块说明**：CPUID 探测在 `cpu/x86/` 中完成——这是纯 CPU 层操作，不依赖 OS、不依赖 runtime。探测结果（UseSSE/UseAVX/BMI/FMA flag）存储在 `runtime/globals.hpp` 的全局 flag 变量中——这样所有模块都能读取。`macroAssembler_x86.cpp` 是 flag 的主要消费端——根据 flag 决定生成什么版本的指令。

## §四 必须深度走读的核心概念（≥6 组，source-code-driven，"why X not Y" 风格）

> 每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ VM_Version::initialize() 的启动时序 — 为什么在极早期探测

```
问题：
  ① CPU 探测在 JVM 启动的哪个阶段执行？为什么必须在堆初始化之前？
      线索: Threads::create_vm() 中的调用顺序
      答案方向: 调用链：`Threads::create_vm()` → 在 VM 初始化阶段 → `VM_Version::initialize()`。
      这是在堆初始化（`Universe::initialize_heap()`）之前，甚至在 GC 策略选择之前。原因是：
      (a) 代码生成在 JVM 启动后立即开始（解释器需要生成第一个方法的入口）——而此时
      `UseSSE`/`UseAVX`/`UseCompressedOops` 必须已经有了正确值
      (b) 如果探测被推迟，任何在探测前尝试生成代码的线程可能生成错误的指令 → SIGILL
      (c) 代码生成器（TemplateInterpreterGenerator, StubGenerator, C1/C2）在初始化时即读取
      UseSSE/UseAVX flag → 它们必须在代码生成器初始化前就位

  ② 为什么 EFLAGS 翻转测试在 CPUID 调用之前？
      线索: vm_version_x86.cpp generate_get_cpu_info 的开头
      答案方向: 如果不先测试 CPUID 是否支持，直接执行 `cpuid` 指令 → 在真正的 386/486 上
      触发 SIGILL——此时 JVM 还没完全启动，信号处理器不可用 → 直接进程崩溃。
      EFLAGS 翻转测试不需要 CPUID 就能安全地检测是否支持 CPUID——通过尝试修改 EFLAGS 的 ID bit
      （bit 21）来判断 CPU 对 `pushfd`/`popfd` 的响应。如果 bit 21 可翻转 = 支持 CPUID。
      这是一个"不依赖 CPUID 检测 CPUID"的安全策略——处理 egg-and-chicken 问题。
      代码引证:
        pushfd                ; 步骤1: 保存当前 EFLAGS 到栈
        pop eax               ; 步骤2: 读出原始值到 eax
        mov ecx, eax          ; 步骤3: 保存副本到 ecx
        xor eax, 0x200000     ; 步骤4: 翻转 ID bit (bit 21)
        push eax              ; 步骤5: 把修改后的值压栈
        popfd                 ; 步骤6: 尝试写入 EFLAGS
        pushfd                ; 步骤7: 重新读回 EFLAGS
        pop eax               ; 步骤8: 读出"写入后的实际值"
        xor eax, ecx          ; 步骤9: 对比是否真的变了
        ; 如果 eax & 0x200000 != 0 → ID bit 被成功翻转 → CPU 支持 CPUID

  ③ CPUID 探测结果存到哪里？
      线索: vm_version_x86.hpp CpuidInfo 结构体
      答案方向: 结果存储在 `VM_Version::_cpuid_info`——一个 `CpuidInfo` 类型结构体，包含所有
      CPUID leaf 的原始返回值（EAX/EBX/ECX/EDX 寄存器值）。initialize() 解析这些 bit：
      例如 `_cpuid_info.std_cpuid1_ecx.bits.avx` → bool = AVX 是否支持 → `UseAVX = 1`。
      这个结构体被所有 JVM 代码共享——代码生成器、GC barrier Assembler、StubGenerator 都读它。
```

### 4.2 ★★★ CPUID 核心 leaf —— JVM 问了什么问题，为什么这些问题

```
问题：
  ① CPUID leaf 1（`eax=1`）返回了什么？为什么是最重要的 leaf？
      线索: vm_version_x86.cpp 中的 CPUID leaf 1 调用和解析
      答案方向: 这是最重要的 leaf——返回所有基本 SSE/SSE4/AVX/HTT 特性：
      - ECX bit 0: SSE3
      - ECX bit 9: SSSE3
      - ECX bit 19: SSE4.1
      - ECX bit 20: SSE4.2
      - ECX bit 25: AVX
      - ECX bit 28: AVX2 
      - ECX bit 27: OSXSAVE (OS 是否在 XSETBV 中启用 XSAVE——关键！)
      - EDX bit 25: SSE, EDX bit 26: SSE2
      JVM 根据这些 bit 设置 `UseSSE` / `UseAVX` 的初始值。leaf 1 是"基础套餐"——所有
      常用指令集的根都在这里。追问: 为什么 AVX2 在 leaf 7 而不在 leaf 1？→ leaf 1 是基本特性，
      AVX2/AVX-512 等扩展特性在 leaf 7（structured extended features）。

  ② CPUID leaf 7 sub-leaf 0（`eax=7, ecx=0`）返回了什么扩展特性？
      线索: vm_version_x86.hpp ext_cpuid7_ebx bitfield
      答案方向: leaf 7 返回：
      - EBX bit 3: BMI1 (Bit Manipulation Instructions 1)
      - EBX bit 5: AVX2
      - EBX bit 8: BMI2
      - EBX bit 29: SHA (SHA-1/SHA-256 加速)
      - ECX bit 0: AVX512_Prefetch
      - ECX bit 1: AVX512_F
      - ECX bit 6: AVX512_VBMI
      ...
      leaf 7 的子 leaf 非常多（通过在每次 cpuid 前设置 ECX 来选择）。JVM 系统地遍历这些
      sub-leaf 来确定 AVX-512 的完整可用性——不是只检查一个 bit 就启用。

  ③ 为什么需要区分 Intel 和 AMD（通过 leaf 0 的厂商字符串）？
      线索: vm_version_x86.cpp 中的 vendor 检测
      答案方向: 某些功能在两个厂商之间有不同行为。例如 LZCNT (leading zero count)——
      AMD 上输入 0 → 返回 32/64（真正的 LZCNT）；Intel 老 CPU 上 `lzcnt` 会 fallback 到 `bsr`
      （bit scan reverse）→ 输入 0 返回 undefined → 导致不同结果。JVM 需要知道厂商身份
      来选择正确的指令序列。厂商字符串从 leaf 0 返回的 EBX/ECX/EDX 中读取——"GenuineIntel"
      vs "AuthenticAMD"。这在探测初期完成——后续所有厂商依赖的 flag 设置都基于此。
```

### 4.3 ★★ 关键 flag 的设置逻辑 — UseSSE → UseAVX → UseAVX512 的级联

```
问题：
   ① UseSSE 和 UseAVX 的级联关系是什么？如果 CPU 支持 AVX2 但用户用 -XX:UseAVX=0 怎么办？
       线索: vm_version_x86.cpp get_processor_features() 中的 flag 提升逻辑
       答案方向: 级联分两层：(a) 探测 CPUID 确定上限，(b) 根据 flag 值清除 _features 中越级的 bit。
       CPUID 探测确定 `use_avx_limit`（vm_version_x86.cpp:690-701）：
       ```
       // line 690-701: get_processor_features()
       int use_avx_limit = 0;
       if (UseAVX > 0) {
         if (UseAVX > 2 && supports_evex()) {           // CPUID leaf 7 EBX bit 16=AVX512F
           use_avx_limit = 3;
         } else if (UseAVX > 1 && supports_avx2()) {    // CPUID leaf 7 EBX bit 5=AVX2
           use_avx_limit = 2;
         } else if (UseAVX > 0 && supports_avx()) {     // CPUID leaf 1 ECX bit 25=AVX
           use_avx_limit = 1;
         } else {
           use_avx_limit = 0;
         }
       }
       ```
       级联清除——UseAVX 决定哪些扩展特性 bit 保留（vm_version_x86.cpp:718-735）：
       ```
       // line 718-735: get_processor_features()
       if (UseAVX < 3) {
         _features &= ~CPU_AVX512F;     // UseAVX<3 → 清除所有 AVX-512 特性
         ...
       }
       if (UseAVX < 2)
         _features &= ~CPU_AVX2;        // UseAVX<2 → 清除 AVX2（即使 CPU 硬件支持）
       if (UseAVX < 1) {
         _features &= ~CPU_AVX;         // UseAVX<1 → 清除 AVX
         _features &= ~CPU_VZEROUPPER;
       }
       ```
       UseSSE 也有同样的级联（vm_version_x86.cpp:667-682）：
       ```
       // line 667-682: get_processor_features()
       if (UseSSE < 4) { _features &= ~CPU_SSE4_1; _features &= ~CPU_SSE4_2; }
       if (UseSSE < 3) { _features &= ~CPU_SSE3; _features &= ~CPU_SSSE3; ... }
       if (UseSSE < 2)   _features &= ~CPU_SSE2;
       if (UseSSE < 1)   _features &= ~CPU_SSE;
       ```
       UseSSE 和 UseAVX 之间没有直接的赋值 gate（如 `if (!UseSSE) UseAVX=0`）——它们的级联
       通过 `_features` 位掩码实现：UseSSE 将禁用级别的 SSE bit 从 _features 中清除；虽然
       `supports_avx()` 检查的是 `_cpuid_info` 原始 bit 而非 `_features`，但后续代码生成器
       在 `is_sse_supported()` / `is_avx_supported()` 检查中读取 `_features`，因此清除 _features
       中 SSE bit 的代码路径也会间接阻止依赖 SSE 的 AVX 代码路径被启用。
       
       如果用户在命令行中设置了 `-XX:UseAVX=0`，`FLAG_IS_DEFAULT(UseAVX)` 返回 false（
       vm_version_x86.cpp:702）：
       ```
       // line 702-709: get_processor_features()
       if (FLAG_IS_DEFAULT(UseAVX)) {
         if (use_avx_limit > 2 && is_intel_skylake() && _stepping < 5) {
           FLAG_SET_DEFAULT(UseAVX, 2);   // 老 Skylake 降级 AVX-512
         } else {
           FLAG_SET_DEFAULT(UseAVX, use_avx_limit);
         }
       }
       ```
       `FLAG_IS_DEFAULT` 检测 flag 是否被用户显式设置过——如果用户设了 `-XX:UseAVX=0`，
       整个自动提升块被跳过。但 JVM 仍会在 line 710-712 检查用户值是否超过硬件上限，
       超过则 warning + 降级。追问: 为什么要允许用户降级？→ 某些 CPU 微码 bug（AVX
        降频问题、AVX-512 的功耗墙）→ 生产降级策略："CPU 支持但我不信任"。

   ★ XGETBV 双验证——CPUID 说支持，但 OS 承诺保存 YMM 吗？
       仅靠 CPUID bit 25 (AVX) = 1 不足以安全启用 AVX。必须同时验证 XGETBV 返回的
       XCR0 控制寄存器——它告诉 JVM 每次 context switch 时 OS 是否保存/恢复 256-bit YMM
       寄存器。探测 stub 中在 leaf 1 cpuid 之后立即执行 xgetbv（vm_version_x86.cpp:234-248）：
       ```
       // line 237-239: 检查 CPUID leaf 1 ECX 的 OSXSAVE + AVX bit 是否都=1
       __ andl(rcx, 0x18000000);  // cpuid1 bits osxsave | avx
       __ cmpl(rcx, 0x18000000);
       __ jccb(Assembler::notEqual, sef_cpuid);  // 任意缺一 → 跳过 AVX 探测
       
       // line 244-248: XGETBV 读取 XCR0（ECX=0 选 XCR0 寄存器）
       __ xorl(rcx, rcx);       // zero for XCR0 register
       __ xgetbv();              // EDX:EAX = XCR0
       __ lea(rsi, Address(rbp, in_bytes(VM_Version::xem_xcr0_offset())));
       __ movl(Address(rsi, 0), rax);
       __ movl(Address(rsi, 4), rdx);
       ```
       这段 stub 代码的汇编语义：
       ```
       ; XGETBV with ECX=0 → 返回 XCR0 到 EDX:EAX
       xor ecx, ecx              ; 选择 XCR0 控制寄存器 (ECX=0)
       xgetbv                    ; EDX:EAX = XCR0 的 64-bit 值
       ; XCR0 bit 0 = x87 state（总是 1，所有 OS 都保存）
       ; XCR0 bit 1 = SSE/XMM state（State Component 1: 128-bit XMM 寄存器）
       ; XCR0 bit 2 = AVX/YMM state（State Component 2: 256-bit YMM 寄存器）
       ```
       JVM 在 `get_processor_features()` 的后半段（vm_version_x86.cpp:353-356）再次
       检查 XCR0，确认 OS 是否真的保存 SSE + YMM state：
       ```
       // line 353-356: 后置双验证——xcr0 必须包含 bit 1 + bit 2
       __ movl(rax, 0x6);        // mask = 0b0110 = bit 1 (SSE) + bit 2 (YMM)
       __ andl(rax, Address(rbp, in_bytes(VM_Version::xem_xcr0_offset())));
       __ cmpl(rax, 0x6);        // (XCR0 & 6) == 6 ?
       __ jccb(Assembler::equal, start_simd_check);  // 是 → 继续 AVX 探测
       ```
       这个检查的含义：(a) XCR0 bit 1 = 1 → OS 在 context switch 时保存 XMM (128-bit)；
       (b) XCR0 bit 2 = 1 → OS 保存 YMM upper 128 bits (256-bit 的上半部分)。两个 bit
       都必须为 1 → JVM 才会启用 AVX。如果 (XCR0 & 6) != 6 → 即使 CPUID leaf 1 ECX bit
       25=1（硬件支持 AVX），JVM 也会强制 UseAVX=0——因为 OS 不承诺保存 YMM 寄存器，启用
       AVX 会在 context switch 后产生静默数据损坏（callee 保存进 YMM 后 OS 切换进程，恢复
       时 YMM 上半部分丢失 → Java 计算结果错误但无 SIGILL）。这就是 JVM 的"双验证"策略——
        相信 CPUID（硬件能力）但不完全信，必须由 XGETBV（OS 承诺）交叉确认。

   ② UseSSE=4 意味着什么？为什么 UseSSE>=2 时浮点从 x87 切换到 SSE？
       答案方向: UseSSE 的值反映最高支持的 SSE 级别：0=无 SSE, 1=SSE, 2=SSE2, 3=SSE3, 4=SSE4.1+SSE4.2。
       UseSSE>=2 是一个分水岭——此时浮点运算切换到 SSE 标量指令（addsd/subsu/mulsd 等），彻底放弃
       x87 栈式浮点（fadd/fsub/fmul）。原因：(a) SSE2 是 x86_64 ABI 的基础要求——所有 64-bit
       CPU 都必须有；(b) SSE 浮点比 x87 快 3-5×（x87 有栈管理开销、精度控制复杂）；(c) x87
       没有 64-bit 整型支持。
```

### 4.4 ★★ 探测 stub 的生成和调用 — 为什么首先生成 stub 再调用它

```
问题：
  ① VM_Version_StubGenerator::generate_get_cpu_info() 不在 VM_Version::initialize() 中直接用
     内联汇编而选择生成一个 stub——为什么？
      线索: vm_version_x86.cpp VM_Version_StubGenerator + generate_get_cpu_info
      答案方向: 原因有三：
      1. 精确的寄存器保存/恢复——CPUID 执行时会破坏 EAX/EBX/ECX/EDX 全部值。
         如果直接在 C++ 函数中嵌入内联汇编，需要确保 GCC/Clang 的寄存器分配器
         不会在这些敏感寄存器的原始值上产生错误假设。通过生成一个独立的 stub 并调
         用它，JVM 可以手动管理寄存器——push/pop 精确控制。
      2. AVX/AVX-512 的探测需要 xsave/xrstor 上下文——测试 XSAVE 区域能否包含
         YMM/ZMM 寄存器。这个操作需要特定的 XSETBV/XRSTOR 序列且不能被打断。
         使用独立的 stub 意味着所有上下文在一个短小的、原子的代码块中完成。
      3. 信号安全——如果 CPUID 调用因为特殊原因触发了某种保护（某些虚拟化环境），stub
         内部可以做信号安全处理——`_cpuinfo_segv_addr`/`_cpuinfo_cont_addr` 哨兵。
         如果探测在 C++ 上下文中执行，信号恢复路径不明确。
      ★ 所以 JVM 在 CodeBuffer 中生成一段 ~2000 字节的探测 stub，然后强转为函数指针调用它：
      `get_cpu_info_stub(&_cpuid_info)`。

  ② stub 内部的具体执行流程——从第一个 CPUID 调用到返回 CpuidInfo 结构体
      线索: vm_version_x86.cpp generate_get_cpu_info
      答案方向: stub 内部按顺序执行：
      1. EFLAGS 翻转测试（验证 CPUID 支持）→ 如果失败跳转到不支持 flag
      2. 执行 leaf 0 → 获取厂商字符串 + max basic leaf
      3. 执行 leaf 1 → 获取基本 SSE/AVX 特性
      4. 如果 leaf 7 在 max basic leaf 范围内 → 执行 leaf 7 (AVX2/BMI/SHA)
      5. 如果有 AVX 支持 → 用 XSETBV/XGETBV 验证 XSAVE 区域
      6. 如果有 AVX-512 支持 → 验证 XSAVE 区域能否包含 ZMM
      7. 执行 extended leafs (0x80000000+) 获取 AMD 特性 + cache info
      8. 执行 leaf 4 → 获取 cache 拓扑
      9. 其他 leaf 用于品牌字符串、物理/虚拟地址宽度等
      10. 执行 `ret` → 结果在提供的 CpuidInfo* 中（通过参数指针写回）
```

### 4.5 ★★ SIGILL 的保护机制 — _cpuinfo_segv_addr 和 _cpuinfo_cont_addr

```
问题：
  ① 如果 CPU 报告支持 AVX，但 JVM 执行 AVX 指令时 SIGILL——怎么处理？
      线索: vm_version_x86.cpp generate_get_cpu_info 中的哨兵变量
      答案方向: VM_Version_StubGenerator 在 stub 内设置了"哨兵"——`_cpuinfo_segv_addr` 
      记录可能出错的指令地址，`_cpuinfo_cont_addr` 记录错误后的恢复地址。工作原理：
      1. 探测 stub 在调用 AVX/AVX-512 相关指令前，把 `_cpuinfo_segv_addr` 设为当前 PC
      2. 把 `_cpuinfo_cont_addr` 设为"跳过该特性、继续探测下一个"的地址
      3. 如果发生 SIGILL → 信号处理器检查 PC 是否在 `_cpuinfo_segv_addr` 范围内
      4. 如果在 → 计为"此特性不支持"→ 设置恢复继续的标签 → 跳转到 `_cpuinfo_cont_addr`
      这样整个探测不会因为一次 SIGILL 而 panic——把 SIGILL 当成了一个"此特性不可用"的信号。
      追问: 如果 SIGILL 发生在 `_cpuinfo_cont_addr` 恢复路径 → "双层 SIGILL"——这是 README §八
      的问题——文档需要在写作时确认是否有对应的防护机制。

  ② AVX-512 的频率调节问题——探测到了但不一定好用
      线索: UseAVX flag + 降频讨论
      答案方向: 某些 Skylake-X 的 AVX-512 执行时 CPU 降频严重（AVX-512 功耗高 → 温度限制触发
      → 核心频率下降 20-40%）。如果其他核心也在执行非 AVX 代码 → 它们的频率也被连带降低 →
      整体吞吐量下降。实际吞吐量可能低于 AVX2。所以 JVM 提供 `-XX:UseAVX=2` 强制降级到 AVX2。
      CPUID 只能告诉你"CPU 有这个功能"，不能告诉你"用了之后会不会更好"。这是一个"功能存在但不一定想要"
      的经典案例。JVM 的默认策略是：由 CPUS 检测到 → 自动启用 → 但用户可以通过 flag 覆盖。

  ③ 虚拟化环境中的 CPUID 谎报——哪些虚拟化技术会让 EFLAGS 检测和 CPUID 结果不一致？
      答案方向: 这是 README §八 的问题——某些云计算提供商在 guest 中暴露的 CPUID leaf
      可能与宿主机真实能力不完全一致。场景：(a) hypervisor 的 CPUID 过滤策略——对不同
      instance type 提供不同的 CPUID bitmask；(b) 部分 hypervisor 允许 guest 读到
      "host 有 AVX2"但宿主机 kernel 没有启用 XSAVE → guest 的 XGETBV 返回不支持 YMM
      → JVM 的"双验证"能防止误检；(c) 有些非常早期的 KVM 版本存在 CPUID bit 泄露——
      guest 意外读到 host 的某些 bits（由 QEMU 模拟不足导致）。JVM 对所有这些情况的防护是：
      (a) 不只信 CPUID——XGETBV 是硬件级的，hypervisor 无法伪造；
      (b) SIGILL 哨兵机制提供最后一道防线——如果指令确实不能被 CPU 理解，哨兵会捕获并降级。
```

### 4.6 ★★ 和 [12-02] + [12-03] + [11-os-layer] 的连接

```
问题：
  ① 探测结果如何影响 [12-02] 解释器的代码生成？
      答案方向: [12-02] 的 TemplateTable 在生成浮点字节码时检查 UseSSE flag：
      UseSSE >= 2 → 生成 `addsd`/`subsd`/`mulsd`（SSE2 标量双精度）；UseSSE = 0 → 
      生成 `fadd`/`fsub`/`fmul`（x87 栈式浮点）。UseAVX >= 2 → 某些字节码（性能关键的）
      生成 AVX3 指令（如 `vpaddd` 做批量 int 加法）。探测结果在 UseSSE/UseAVX 中——本文的
      CPUID 是这些 flag 的"权威设置者"。流程图：CPUID → flag → TemplateTable 生成判断 →
      C1/C2 intrinsic 生成判断。

  ② 探测结果如何影响 [12-03] stub 的代码生成？
      答案方向: [12-03] 的 StubGenerator 在生成 arraycopy（`rep movsq` vs `vmovdqu`）、
      generate_atomic_* 等 stub 时也检查 UseAVX flag。如果 UseAVX >= 2 → 对于大数组拷贝，
      生成 AVX2 的 256-bit 向量指令（一次搬 32 字节）；如果只有 SSE4.2 → 生成 `rep movsq`
      （16 字节 + 快速循环）。同样的模式：CPUID → flag → StubGenerator 条件生成。

  ③ 和 [11-os-layer] 的独立宣言——CPUID 为什么不需要 OS 参与
      答案方向: [11] 的 OS 层提供信号/线程/内存的 OS 接口。CPUID 完全绕过这些——直接
      执行 `cpuid` 指令，不需要系统调用，不需要 `/proc/cpuinfo`。CPU 内部的 microcode 处理
      `cpuid` 并把结果放在寄存器中——整个过程在 ring 3 完成（不需要切换到内核态）。
      OS 可能过滤 `/proc/cpuinfo` 的内容（hypervisor 可能修改 guest 看到的 flags），但
      CPUID 指令返回的 bit 位是 CPU 硬件真实水平——没有中间层可以篡改（除非硬件虚拟化
      的 VMM intercept，但 JVM 对这种情况有双验证保护）。
```

### 4.7 ★★ 和 [11-os-layer] + [12-02] + [12-03] + [12-01] 与 README §V 的阶段对比

```
问题：
  ① 12-cpu-layer 和 11-os-layer 为什么形成"硬/软对称"？
      答案方向: 引用 README §V 的对比：
      - 11: signalHandler（软件概念——内核投递信号）
      - 12: MacroAssembler（硬件概念——JVM 生成 CPU 指令）
      - 11: pthread_t（LWP ID）
      - 12: r15_thread（寄存器中的 Thread*）
      - 11: ucontext_t（信号帧——内核写）
      - 12: frame（Java 帧——JVM 自己布局）
      - 11: mmap + mprotect（OS 内存保护）
      - 12: VM_Version::initialize + CompressedOops（CPU 特性探测 + 窄化指针解压）
      11 讲"OS 怎么把资源交给 JVM"（系统调用面），12 讲"JVM 怎么在 CPU 上生成指令"
      （寄存器/栈帧/指令序列的物理执行面）。两者是对称的两层——一层向 OS 借资源，一层直接操作硬件。

  ② [04-CPUID] 是 [02-Interpreter] 和 [03-Stubs] 的"开关控制层"——这一关系在 README §五 中
     已经为什么定位了？
      答案方向: README §五 最后列出"和 12-02 + 12-03 的连接"——探测结果决定生成什么指令。
      UseSSE/UseAVX 是 02/03 的条件编译开关。04 输出 flag，02/03 消费 flag。这就是为什么
      04 需要较先读（与 02 并行）——不理解 flag 来源，Read 02/03 时看到 `if (UseSSE >= 2)` 
      只会问"这个值什么时候设置的"。READ §五 的交叉矩阵中，04 独立于 02/03 但消费关系反向。
```

## §五 文章结构（ASCII 图）

```
§〇 源文件清单（跨 cpu/x86 + runtime，标注每个文件在 CPU 探测链中的位置）

§一 ★ 全景：VM_Version::initialize() 的启动时序和 EFLAGS 翻转测试
  ❓ CPU 探测在 JVM 启动的哪个阶段？为什么在堆初始化之前？
  ❓ 为什么 EFLAGS 翻转测试在 CPUID 调用之前——用"不依赖 CPUID 的方法"检测 CPUID 是否可用
  1.1 启动时序图——Threads::create_vm() → VM_Version::initialize() → 生成各 stub
  1.2 EFLAGS 翻转测试的 9 步汇编（伪代码 + bit 位解析）
  1.3 探测 stub 的生成——为什么不是内联汇编而是独立 stub

§二 ★★★ CPUID 核心 leaf — JVM 问了什么，返回了什么
  ★ CPUID Leaf 表（5+ leaf，leaf/EAX/ECX/返回内容/探测特性）
  ❓ leaf 1 为什么最重要？→ 包含所有基础 SSE/AVX flag
  ❓ leaf 7 为什么细分？→ AVX2/BMI/SHA 在扩展 leaf 中
  2.1 leaf 0 — 厂商字符串 + max basic leaf
  2.2 leaf 1 — SSE/SSE2/SSE3/SSE4/AVX + OSXSAVE key
  2.3 leaf 7 sub-leaf 0 — AVX2/BMI1/BMI2/SHA
  2.4 leaf 0x80000001 (extended) — 64-bit/XD/NX
  2.5 leaf 4 — cache 拓扑（类型 + level + ways + sets）

§三 ★★ Flag 设置逻辑 — UseSSE → UseAVX → UseAVX512 的级联
  ❓ 如果 CPU 支持 AVX2 但用户用 -XX:UseAVX=0 ——自动提升被如何阻止？
  ❓ UseSSE>=2 时为什么浮点从 x87 切换到 SSE？——x86_64 ABI 保证 SSE2 在所有 CPU 上可用
  3.1 UseSSE 的 5 级级联（0→SSE→SSE2→SSE3→SSE4）
  3.2 UseAVX 的 3 级级联（AVX→AVX2→AVX-512）+ 用户覆盖机制
  3.3 UseBMI/UseFMA/UseSHA——独立 flag 的设置逻辑
  3.4 当 CPU 支持但 OS 不支持（XGETBV 返回无用）——JVM 的"双验证"策略

§四 ★★ 探测 stub — VM_Version_StubGenerator 的完整工作流程
  ★ 探测 stub 的 10 步执行顺序——从 EFLAGS 检测到返回 CpuidInfo
  ❓ 为什么首先生成 stub 再调用——寄存器管理 + AVX xsave 上下文 + 信号安全
  ❓ stub 如何把结果写回 — 传入 CpuidInfo* 参数指针，stub 直接写内存
  4.1 StubGenerator::generate_get_cpu_info() 的代码结构
  4.2 CpuidInfo 结构体的字段——每个 field 对应一个 CPUID leaf 的返回值
  4.3 stub 的 CodeBuffer 大小——~2000 字节

§五 ★★ SIGILL 保护 — _cpuinfo_segv_addr 和 _cpuinfo_cont_addr 哨兵机制
  ❓ 如果 CPU 报告支持 AVX 但实际不支持——哨兵如何防止整个探测 panic？
  ❓ 虚拟化环境的 CPUID 谎报——JVM 的"双验证"（CPUID + XGETBV + 哨兵）
  5.1 哨兵的工作原理——segv→跳过该特性→继续探测下个
  5.2 "双层 SIGILL" 风险——如果恢复路径本身也触发 SIGILL → 需要什么额外的防护
  5.3 虚拟化环境的典型问题——CPU 模式 vs 宿主机能力

§六 ★ 和 [12-02] Interpreter + [12-03] Stubs + [11-os-layer] 的阶段连接
  ❓ CPUID → UseSSE/UseAVX flag → [12-02] TemplateTable 的浮点指令版本选择
  ❓ CPUID → UseAVX flag → [12-03] StubGenerator 的 arraycopy 向量宽度
  ❓ CPUID 直接访问硬件——和 [11-os-layer] 的 OS 信号/线程/内存的独立宣言
  6.1 [12-02] §三 UseSSE 依赖——解释器的浮点字节码指令选择
  6.2 [12-03] §一 arraycopy_stub — UseAVX flag 决定是用 rep movsq 还是 vmovdqu
  6.3 [11-os-layer] — CPU 层 vs OS 层的"独立宣言"
  6.4 ★ README §V 阶段对比表——11 vs 12 的 7 个对比维度

§七 GDB 验证 + 可证伪断言
```

## §六 写作要求

1. **★ CPUID leaf 表是全文的第一核心交付物**——5+ leaf 的完整表：Leaf 编号 / EAX 输入 / ECX 输入（如果有）/ 返回寄存器和含义 / 探测什么特性 / JVM flag。表必须是准确的值（如 leaf 0 = EAX=0, returns vendor string in EBX/ECX/EDX）。
2. **★ EFLAGS 翻转测试的 9 步汇编必须有逐行注释**——每一行对应真实的 x86 指令 + 注释（如 "pushfd → 把 EFLAGS 压入栈准备读取"）。标注关键 bit（第 21 位 = ID bit, 掩码 0x200000）。
3. **★ SIGILL 哨兵机制必须有明确的"双层防护"分析**——解释哨兵的正常工作流程 + 讨论"如果恢复路径自己也 SIGILL 会发生什么"。引用 README §八 问题 4。
4. **★ 和 [12-02] + [12-03] 的消费关系必须显式标注**——不是"CPUID 探测完成后就好了"，而是标注"CPUID → flag → [12-02] 的 TemplateTable::fadd 生成 addsd vs fadd" 和 "CPUID → flag → [12-03] 的 StubGenerator::generate_arraycopy 生成 vmovdqu vs rep movsq"。这是 04 和 02/03 的唯一桥梁。
5. **★ 和 [11-os-layer] 的独立宣言必须清晰**——CPUID 直接访问硬件（ring 3 指令，无系统调用），OS 只读它的结果（`/proc/cpuinfo` 的内容），但 JVM 不通过 OS 间接获取——直接调 CPUID 更可靠。
6. **★ 虚拟化环境的 CPUID 谎报不能蜻蜓点水**——这是一个生产中的真实问题。必须讨论 (a) 哪些虚拟化技术会让 CPUID 返回不准确，(b) JVM 的 3 层防护如何对应，(c) 用户如何手动覆盖 flag 规避。
7. **★ UseSSE 和 UseAVX 的级联关系必须有状态机图**——展示从初始值（from globals.hpp 默认）→ CPUID 返回 → flag 提升 → 最终值的完整路径。

## §七 输出格式

- Markdown 文件，命名为 `04-CPUID.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/12-cpu-layer/`
- 元信息头：
  ```
  > **阶段**：[12-cpu-layer]
  > **前置**：[12-02] Interpreter, [12-03] Stubs（CPUID 探测结果作为这两者的输入——UseSSE/UseAVX 等 flag 来源于本文）, [11-os-layer]（CPUID 独立于 OS——直接访问 CPU 硬件）
  > **依赖本文**：无（本文是本阶段的"开关层"——输出 flag，02/03 消费 flag）
  > **阅读收益**：理解 JVM 如何使用 CPUID 指令从 CPU 硬件直接获取所有可用指令集——从 386 兼容性判断的 EFLAGS 翻转测试到 AVX-512 的 XSAVE 双验证、从 UseSSE/UseAVX 的级联提升到虚拟化环境的"SIGILL 哨兵"防护机制、从 CPU 特性 flag 到解释器和 stub 代码生成的指令版本选择
  ```

## 禁止行为（≥8，必须具体到"❌ X 因为 Y"）

- ❌ 深入 CPUID leaf 的每一个 bit 位完整定义——因为这是 Intel/AMD 厂商手册的内容，和本文的"JVM 怎么调用和为什么调用"的主线无关。只需列出 JVM 实际使用的 bit 位和对应的 flag
- ❌ 解释 x86 指令编码格式（CPUID 的 opcode = 0x0FA2、ModRM encoding）——因为这是汇编器手册的内容，和 JVM 的探测逻辑无关
- ❌ 深入虚拟化技术（Intel VMX、AMD SVM、nested virtualization）的时钟/状态保护机制——因为虚拟化只是 SIGILL 的一个可能来源，不是本文主线
- ❌ 展开 XSAVE/XRSTOR/XSETBV 的完整语义（XSAVE area 的 bitmask 编码、compaction mode）——只需解释"XGETBV 验证 OS 是否承诺保存 YMM/ZMM" 即可，不需要到保存区域的布局
- ❌ 忽略 EFLAGS 翻转测试的"为什么必须在 CPUID 之前"——必须解释"不依赖 CPUID 来检测 CPUID 是否可用"的 egg-and-chicken 悖论
- ❌ 把 UseSSE/UseAVX 的级联当成"简单的自动设置"——必须展示用户显式设置 flag 时覆盖机制的精确逻辑
- ❌ 忘记 [12-02] 和 [12-03] 对 UseSSE/UseAVX 的消费——本文的输出（flag）是 02/03 的输入，这一关系必须显式标注
- ❌ 不做"为什么探测 stub 而不是内联汇编"的完整解释——3 个原因必须全部覆盖（寄存器管理、AVX xsave 上下文、信号安全）
- ❌ 忽略虚拟化环境的 CPUID 谎报——这是生产中最常见的 SIGILL 来源，必须在 §五 中结合哨兵机制分析
- ❌ 不做和 [11-os-layer] 的独立宣言——CPUID 无需 OS 辅助这一事实是"CPU 层"和"OS 层"之间的分水岭

## 要求行为（≥8，必须是可验证的交付物）

- ✅ **★ CPUID Leaf 表**——5+ leaf 完整表：Leaf / EAX 输入 / ECX 输入 / 关键返回 bit 含义 / JVM flag / 注释。标注 leaf 1 的 ECX bit 25 = AVX, bit 27 = OSXSAVE（关键的！）
- ✅ **★ EFLAGS 翻转测试的 9 步汇编逐行注释**——每条真实 x86 指令 + 注释（如"pop eax → 现在 eax 保存了原始 EFLAGS"），标注 ID bit 的位置
- ✅ **★ UseSSE → UseAVX → UseAVX512 的级联图**——展示 flag 从默认值到最终值的路径，标注自动提升和用户覆盖的机制（FLAG_IS_DEFAULT 检查）
- ✅ **★ 探测 stub 的 10 步执行顺序表**——从 EFLAGS 检测到最后一个 CPUID leaf 的完整序列，标注每步的作用和输出的 bit
- ✅ **★ SIGILL 哨兵机制的完整流程**——正常路径 vs SIGILL 发生时的故障恢复路径，标注 _cpuinfo_segv_addr / _cpuinfo_cont_addr 的角色
- ✅ **★ CPU → Flag → [12-02]/[12-03] 消费链图**——从 CPUID 返回值到 flag 到 [12-02] TemplateTable + [12-03] StubGenerator 的 2-3 个具体指令选择实例
- ✅ **★ 虚拟化环境的"3 层防护"图**——(1) EFLAGS 测试 → (2) CPUID + XGETBV 双验证 → (3) SIGILL 哨兵，标注每层防止的问题
- ✅ **★ 和 [12-02] §三、[12-03] §一、[11-os-layer] §一、README §V 的精确交叉引用表**——每个引用标注到 phase.doc 节号
- ✅ **★ CpuidInfo 结构体的关键 bitfield 字段表**——`std_cpuid1_ecx`、`std_cpuid1_edx`、`ext_cpuid7_ebx`、`ext_cpuid7_ecx` 的核心 bit 位和语义映射
- ✅ **★ GDB 验证 CPUID stub 的执行——单步进入探测过程，确认每个 CPUID leaf 返回的寄存器值正确**

## GDB 可证伪断言（≥10，精确到断点行号）

1. **断言：VM_Version::initialize() 在 Threads::create_vm() 中早于 Universe::initialize_heap() 调用**
   验证：设断点在 `vm_version_x86.cpp:VM_Version::initialize` → `bt` → 调用栈中 VM_Version::initialize 的调用者早于 `Universe::initialize_heap`
   预期：堆初始化在探测完成后

2. **断言：探测 stub 中 EFLAGS 翻转测试先于第一个 CPUID 调用**
   验证：在探测 stub 入口设断点 → `ni` 单步执行 → 记录每条指令 → pushfd/popfd/xor eax,0x200000 出现在 cpuid 指令（opcode 0x0FA2）之前
   预期：EFLAGS 操作的序列在 CPUID 指令之前

3. **断言：leaf 1 CPUID 返回的 ECX bit 25 = 1 当 CPU 支持 AVX**
   验证：执行完 CPUID leaf 1 → `p/x $ecx` → `and $ecx, (1<<25)` → 测试结果 ≠ 0 在 AVX 支持的 CPU 上
   预期：支持 AVX 的 CPU 上 ECX bit 25 = 1

4. **断言：如果 XGETBV 的 XCR0 bit 2 (YMM) = 0，UseAVX 不会被设置**
   验证：在不完整虚拟化环境中 → 执行 `xgetbv`（ecx=0）→ `p/x $eax & 0x00000006`（bit 1+2 = XMM+YMM）→ 如果 =2 → UseAVX >= 1；如果 =0 → UseAVX 不提升
   预期：XCR0 bit 2 = 1 时 UseAVX >= 1，bit 2 = 0 时 UseAVX = 0

5. **断言：UseSSE >= 2 后 TemplateTable 的浮点字节码生成使用 SSE 指令（用 addsd 不用 fadd）**
   验证：设断点在 `templateTable_x86.cpp` 中浮点字节码的生成 → 检查 UseSSE >= 2 → 在生成的代码流中看到 `addsd`/`subsd` 而不看到 `fadd`/`fsub`
   预期：UseSSE >= 2 → 生成 SSE2 标量指令

6. **断言：CpuidInfo 结构体在探测后包含正确的厂商字符串**
   验证：探测完成后 → `x/s VM_Version::_cpuid_info.std_vendor` → 输出 "GenuineIntel" 或 "AuthenticAMD"
   预期：厂商字符串和实际 CPU 匹配

7. **断言：UseAVX=0 手动设置后，尽管 CPU 支持 AVX2，flag 未被自动提升**
   验证：使用 `-XX:UseAVX=0` 启动 → 在 VM_Version::initialize() 中设断点在 flag 提升逻辑 → `p UseAVX` = 0 → FLAG_IS_DEFAULT 检查返回 false → 跳过 if 块
   预期：UseAVX 保持为 0

8. **断言：探测 stub 中的 XSETBV/XGETBV 操作在有 AVX 支持的 CPU 上返回 YMM save bit = 1**
   验证：在探测 stub 中执行 `xgetbv`（ecx=0）之后 → `p/x $eax` → bit 2 = 1 → YMM state 支持
   预期：在支持 AVX 的 Linux kernel 上，XCR0 bit 2 = 1

9. **断言：如果虚拟化环境让 CPUID 报告不准确的 leaf 7 → 哨兵在 SIGILL 时修改 _cpuFeatures 跳过相关 flag**
   验证：在虚拟化环境（或 QEMU 模拟 AVX2 但不支持）执行 → SIGILL 发生 → 信号处理器检测到 pc 在哨兵地址范围 → 跳转到 _cpuinfo_cont_addr → UseAVX 保持为原始值（不提升）
   预期：即使 CPUID 说支持 AVX2，哨兵捕获 SIGILL → flag 不提升

10. **断言：CPUID leaf 4 返回的 cache 信息（EAX 的 cache type/level/ways/sets）被解析并存储**
    验证：在探测 stub 的最后阶段 → `p VM_Version::_cpuid_info.dcache_size` → 非零值匹配 CPU 实际 L1-D cache 大小
    预期：dcache_size 在 32KB 左右（常见 L1-D cache 大小）

11. **断言：globals.hpp 中的 UseSSE 默认值为 4（SSE4.2——现代 CPU 的最低要求）**
    验证：`p UseSSE` 在初始化前 → 值为 default → 初始化后 → 根据 CPUID 可能调整（但一般不会超过，因为默认值 4 对现代 CPU 是正确的）
    预期：初始值为 4，如果 CPU 不支持 SSE4 → 降级（罕见，因所有 x86_64 CPU 都有 SSE2+）

12. **断言：CPUID 指令的 opcode 是 0x0FA2——在探测 stub 的指令流中可以看到这条 2 字节指令**
    验证：在探测 stub 中搜索 opcode pattern → `x/2bx $pc` → 第一个 cpuid 调用位置显示 0x0F 0xA2
    预期：cpuid 是 2 字节指令，opcode = 0x0FA2
