# 域 23: StubRoutines — 知识规划

> 源码路径: hotspot/share/runtime/stubRoutines.* + stubCodeGenerator.* + cpu/x86/stubRoutines_x86* + stubGenerator_x86_64.cpp
> 源码量: 10 文件 / ~12,000 行 | 🔴 大域（重型平台层）

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| stubRoutines.hpp + stubRoutines.cpp | **StubRoutines — 全局桩入口表**: 平台独立 stub(exception throw/stub, atomic ops, arraycopy, fill, crypto intrinsics, math transcendental, safefetch), _code1(初始桩 code buffer: exception+call stub+atomic, 在 Universe::genesis 前生成), _code2(其余桩: arraycopy+crypto+math, genesis 后生成)。包含 `#include CPU_HEADER(stubRoutines)` 引入平台特定桩 | High |
| stubCodeGenerator.hpp + stubCodeGenerator.cpp | **StubCodeGenerator — 汇编桩生成器**: CodeBuffer 封装(提供汇编器 assembler), stub 寄存器保存/恢复宏, 生成 RuntimeStub/BufferBlob 放入 CodeCache, `_masm`(MacroAssembler 用于生成 x86 指令) | High |
| cpu/x86/stubGenerator_x86_64.cpp | **x86_64 StubGenerator — 手写汇编桩**: generate_all() 调用 40+ generate_* 函数生成完整桩集。arraycopy(generate_disjoint_copy/generate_conjoint_copy 含 SSE/AVX 向量化), crypto(AES CBC/ECB/CTR, SHA-1/256/512, GHASH, CRC32/CRC32C/Adler32), math intrinsic(dsin_exp/dcos_exp/dtan_log/dexp_dlog), BigInteger(multiplyToLen/squreToLen/montgomeryMultiply), 其他(safefetch/zero_aligned_words/fill) | High |
| cpu/x86/stubRoutines_x86.hpp | **x86 平台桩**: _arraycopy_supported/use_sse2/immediate_cmpxchg 等平台 capability flags, _code_begin/_code_end(method handles adapter 用), _float_sign_flip 等 FPU 常量 | Medium |
| cpu/x86/stubRoutines_x86.cpp + stubRoutines_x86_64.cpp + stubRoutines_x86_32.cpp | **平台初始化 + CRC table 预计算**: crc_table, crc32c_table 预计算 256-byte tables, 初始化 stubGenerator 并调用 generate_all() | Medium |

*5 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识
| KP | 出现文件 |
|----|---------|
| StubRoutines 全局桩入口 + StubGenerator 生成 | stubRoutines.*(声明), stubCodeGenerator.*(生成器), cpu/x86/stubGenerator_x86_64.cpp(实际生成), cpu/x86/stubRoutines_x86* |

### P2 — 局部重要
| KP | 出现文件 |
|----|---------|
| Arraycopy intrinsics (向量化 SSE/AVX) | stubGenerator_x86_64.cpp(generate_disjoint_copy/conjoint_copy), stubRoutines.hpp(arraycopy 入口地址声明) |
| Crypto intrinsics (AES/SHA/CRC32/GHASH) | stubGenerator_x86_64.cpp, stubRoutines.hpp |

### P3 — 孤立
| KP | 文件 |
|----|------|
| Safefetch stub (safe memory read) | stubRoutines.hpp, stubGenerator_x86_64.cpp |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| StubRoutines + StubGenerator 解耦架构 | 桩入口(StubRoutines: 全局静态地址表, 平台独立)和桩生成(StubGenerator: 手写x86汇编, 平台特定)完全分离。添加新桩: 1)在 stubRoutines.hpp 加 `static address _foo`+getter, 2)在 stubGenerator_x86_64.cpp 的 generate_all() 调 generate_foo()→把汇编入口地址赋值给 StubRoutines::_foo。VM 其余代码只访问 StubRoutines 的 getter——不知道桩是汇编生成的 |
| Arraycopy 向量化 intrinsic (SSE/AVX 分层) | 不是 JIT intrinsic(不是被编译方法的一部分)——是独立桩被解释器/JIT 通过 call 使用。generate_disjoint_copy: 根据 CPU feature 自动选择 best path(rep_movs→SSE movdqu→AVX vmovdqu)检测overlap, 分 conjoint(overlap allowed)/disjoint(no overlap)两路径。disjoint 用 movdqu 128-bit→vmovdqu 256-bit→每迭代 32 bytes→>3x 快于 rep_movsb |

### 🟡 Working — 有设计但非核心 (2 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| Crypto intrinsics (AES/SHA/CRC32) | AES ECB/CBC/CTR stub, SHA-1/256/512 软件实现或 HW acceleration(AES-NI/SHA-NI), CRC32 查表法 | 是 JIT intrinsic 的补充——JIT 可内联 call 这些 stub。重要性高但对理解 StubRoutines 的架构是非核心 |
| StubCodeGenerator 辅助设施 | CodeBuffer 管理, 寄存器保存/恢复 macro, RuntimeStub 创建 | 是生成器的工具类——理解 stub 生成管道需要的次要组件 |

### 🟢 Surface — 了解即可 (1 KP)
| KP | 说明 |
|----|------|
| Safefetch stub | 安全内存读——SIGSEGV 的 handler 替代路径——rare use |

## 04 聚类 — 文章拆分: 3篇

| 篇 | 标题 | 覆盖 KP | 核心问题 |
|:--:|------|:--:|------|
| 1 | StubRoutines 全局桩入口与初始桩 | StubRoutines API(_code1/_code2, exception stubs, atomic ops, call_stub), StubCodeGenerator, 两阶段初始化(initialize1/genesis前→initialize2/genesis后) | "JVM 启动时预生成哪些汇编例程？怎么被调用？" |
| 2 | Arraycopy — 汇编级 memcpy | generate_disjoint_copy/generate_conjoint_copy, SSE/AVX 向量化分级, rep_movs fallback, overlap 检测, fill/zero_aligned_words | "System.arraycopy() 在 JIT 还不够好时怎么用汇编做到 3x 加速？" |
| 3 | Crypto + Math intrinsics | AES CBC/ECB/CTR stub, SHA-1/256/512, CRC32/CRC32C/Adler32, BigInteger multiplyToLen/montgomeryMultiply, Math intrinsic(dsin/dexp/dlog), Ghash | "SHA-256 和 AES 加密——JVM 怎么用 AES-NI 指令做到硬件加速？" |
