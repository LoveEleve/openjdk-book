# 域 02: Assembler — 全视角提问验证

> 15 KP / 🔴5 + 🟡5 + 🟢5 | ~38 文件/~28,200行 | 拆 4 篇文章

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | CodeBuffer 的三节 (code/stubs/consts) 怎么分配和扩展 — 每节的初始大小是怎么估的？满了怎么办？ | ✅ 01 §1 |
| D2 | AbstractAssembler 的 `delayed_nop()` 解决什么具体问题 — 哪个指令需要它？为什么不能直接 emit？ | ✅ 01 §2 |
| D3 | Label 的 patched state 链式列表 — link_to() 和 bind() 的完整机制？多次跳转到同一个未解析 Label 怎么处理？ | ✅ 01 §3 |
| D4 | x86 Assembler 的 `emit_operand()` — 给定一个 Operand, 怎么一步步生成 ModR/M→SIB→disp→REX？需要检查多少个条件分支？ | ✅ 02 §3 |
| D5 | VEX prefix 的 3 操作数 (dest, src1, src2) — ModR/M 只有 2 操作数, VEX 的额外寄存器字段怎么编码？ | ✅ 02 §4 |

## 维度 2: 性能工程师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| P1 | leaq vs mov+add — 3cycle vs 5cycle 的区别在实际 JIT 编译的场景中能省多少？ | ✅ 03 §2 |
| P2 | 对齐的 movdqa vs 未对齐的 movdqu — 现代 x86 (Haswell+) 的性能差异还显著吗？ | ✅ 03 §1 |
| P3 | safepoint_poll=4字节 — 1 cycle 正常执行 vs 全 CPU TLB shootdown 的 safepoint 开销，哪个更贵？ | ✅ 04 §2 |
| P4 | cmovcc 消除了 jmp → 消除了分支预测失败。什么情况下 cmov 反而不如 jmp？ | ✅ 03 §1 |
| P5 | 用 hardware AES-NI 生成加解密 vs C 库 AES — 消除 JNI 的时间差是多少？消除 timing side-channel 的价值多大？ | ✅ 04 §5 |

## 维度 3: SRE/运维

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| S1 | CodeBuffer 分配失败 (超过 64KB) 时发生什么 — JIT 编译被放弃？fallback 到解释器？ | ✅ 01 §1 — C2 bail out→fallback to interpreter |
| S2 | `-XX:+PrintAssembly` 输出的汇编 — 怎么从 hsdis 插件看到 JIT 生成的指令？ | ✅ 01 §1 — PrintAssembly+hsdis 验证 safepoint_poll/call_VM |
| S3 | AES/SHA intrinsic 的正确性怎么检测 — JIT vs Java 实现的对比？ | ✅ 04 §5 — PrintAssembly+aesenc vs Java byte-by-byte 对比 |

## 维度 4: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | 为什么 AbstractAssembler 这么薄 (~300行) 而 assembler_x86 这么厚 (~9500行)？— 跨平台共享 vs 平台特化的设计边界在哪？ | ✅ 01 §2 |
| A2 | REX→VEX→EVEX 的四级编码为什么不重构 x86 指令集统一用 VEX/EVEX？— 前向兼容 vs 彻底重构的取舍 | ✅ 02 §4 |
| A3 | MacroAssembler 的 call_VM 为什么不直接 call runtime function？— 需要 OOPMap(GC safepoint) 是核心原因 | ✅ 04 §1 |
| A4 | Intrinsic 的判断条件 — C2 什么时候替换 Math.sin() 为 x87 fsin 指令？— 平台检测+UseSinIntrinsic flag+精度要求 | ✅ 04 §4 |

## 维度 5: 研究者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| R1 | x87 的 80位精度 为什么在 IEEE 754 64位之上 — 内部精度是设计遗留下来的还是必要的？ | ✅ 04 §4 |
| R2 | ModR/M 的设计起源 — Intel 8086的寻址12种模式为什么是现在编码结构的根？ | ✅ 02 §3 — 8086 ModR/M 40年前编码格式, x86-64 通过前缀扩展而非修改 |
| R3 | constant-time AES — 无分支无表查，什么其他 crypto (ECC, RSA) 也可以这么实现？ | ✅ 04 §5 |

## 维度 6: 学生

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| L1 | 汇编语言和机器码的关系 — 400+ 条 Assembler::movl() 生成的机器码是什么形式？ | ✅ 03 §1 |
| L2 | 什么是 relocation — 为什么不能直接生成最终地址？ | ✅ 01 §3 |
| L3 | 为什么有 REX, VEX, EVEX 这些 prefix — x86 的向后兼容设计是什么意思？ | ✅ 02 §4 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 5 | 5 | ✅ |
| 性能工程师 | 5 | 5 | ✅ |
| SRE/运维 | 3 | 3 | ✅ |
| 架构师 | 4 | 4 | ✅ |
| 研究者 | 3 | 3 | ✅ |
| 学生 | 3 | 3 | ✅ |
| **合计** | **23** | **23** | ✅ |

> 4 处初审 ⚠️ 已全部修复（S1 CodeBuffer overflow/S2 PrintAssembly/S3 intrinsic 验证/R2 8086 origin）。**23/23 全覆盖。**
