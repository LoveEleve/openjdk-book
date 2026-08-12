# 01. Math.sin 多项式逼近 — Payne-Hanek + fast_sin

> 🔴 Deep | 2443行的软件实现——不是 x87 FSIN
> 读者处境: `Math.sin(1e100)` — JDK 11 不使用 x87 FSIN 指令(不精确, 80-bit→64-bit rounding 误差)——而是 `macroAssembler_x86_sin.cpp:2443行` 的软件实现: 三档参数归约(Cody-Waite π/32 双倍双精度 + 大参数 Payne-Hanek)+ Ctable 查表 + 双通道多项式 → double 精度(53-bit)→C2 intrinsic 调用 StubRoutines::_dsin。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/45-math-library/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - 主路径归约是 **π/32 的 Cody-Waite 三段拆分(P_1/P_2/P_3)**,不是 Payne-Hanek;Payne-Hanek 仅在 |x| ≥ 90112 时于 fast_sin 内部(64 位版 516-836 行)使用 PI_INV_TABLE 多字乘法
> - `libm_reduce_pi04l`(1225-1670)是 **32 位 x87 π/4 归约**(供 32 位 tan),不是 64 位 Payne-Hanek
> - 多项式是 **4 项 SC_1..SC_4 双通道(SSE2 packed)**,不是 9-13 项 Taylor;且无 Q0-Q3 象限翻转(Ctable 64 项覆盖整个 2π)
> - "~40 cycles"/"最大误差 < 1 ULP" 无源码依据,已删除
> - `_P_2` 是 π/32 归约拆分常量,不是多项式系数

### 1. "参数归约:三档分级"

场景: `sin(1e100)` — double 的指数位>~20→`1e100 / (2π)` 有 ~80 位的小数精度需求→无法用 double 直接计算 `x % (π/2)`→超大参数用 Payne-Hanek 做 `x * 2/π` → 提取小数部分。

**fast_sin 的三档分级**(`macroAssembler_x86_sin.cpp:381`):
```
MacroAssembler::fast_sin(xmm0...xmm7, eax, ebx, ecx, edx, tmp1...tmp4) (line 381):
  → andl 0x7FFF0000 取指数位, cmpl 0x10C50000 + 无符号 above(418) + 有符号 greater(502) 分三档
  → 主路径(771 ≤ 指数 ≤ 1039, 即 2^-252 ≤ |x| < 90112):
      N = round(32/π·x)(PI32INV = 0x40245F306DC9C883, line 336-339; ±0.5 舍入 + cvttsd2sil)
      r = x − N·(P_1 + P_2 + P_3)(Cody-Waite 三段拆分, 每段 32/32/53 位尾数)
      M = N mod 64 → Ctable(196-301, 64 项 × 4 double = 2KB, 覆盖 2π)
      表项: σ(2的幂) + C_hl + S_hi/S_lo(2×53 位)
      SC_1..SC_4 双通道多项式(313-316 等; 与 fdlibm k_sin.c S1 的 0xBFC55555 同源)
      补偿求和(k_0..k_3, corr)
  → 大参数(指数 > 1039): 内联 Payne-Hanek(516-836):
      PI_INV_TABLE(318-329, 41 个 32 位字, 与 fdlibm two_over_pi 24 位字重打包同源)
      尾数拆 21+32 位, 与 7 个连续表字 imulq 交叉乘(32×32→64 无截断), 2^32 错位累加
      余数换算为 π/4 单位 → 复用主路径 Ctable+多项式尾部(684-706)
  → 小参数(指数 < 771): 次正规 x·(1-2^-53)(ALL_ONES, line 506) / 2^55 技巧(line 509-514)
  → 特例: ±0 → ±0, Inf/NaN → NaN(line 838-840)
[C++: macroAssembler_x86_sin.cpp:381——文件头注释 39-177 是完整算法描述]
[x86: 64 位代码纯 SSE2(line 179-180 "at most SSE2 compliant"); 32 位路径用 x87 但也不用 FSIN]
```

- 关键设计: **为什么不用 fprem/FSIN** — x87 内部 80 位扩展精度(64 位尾数),fprem 对 π 的表示精度锁死;超大角度象限位错误;StrictMath 要求 fdlibm 位级语义(StrictMath.java javadoc)→ 软件实现,纯 SSE2。

### 2. "Ctable 查表 + 双通道多项式评估"

场景: 归约后→r 在 [-π/64, π/64] 范围内→sin(B+r) 展开: sin(B)/cos(B) 查表(64 项覆盖 2π, 无需象限翻转), r 的部分用 4 项 SC 多项式(SSE2 packed 双通道同时算 sin/cos 修正)。

```
多项式结构(头注释 113-129): sincospols = SC_1 + SC_2·r² + SC_3·r⁴ + SC_4·r⁶
  pols = sincospols · (S_hi·r² | (C_hl+σ)·r³)   ← 双通道
  补偿求和(131-164): hi + med + pols + corr, 残差 k_0..k_3
[C++: SC_1 第一通道 0xBFC5555555555555 = -1/6 = fdlibm k_sin.c:62 S1 高 32 位——同源证据]
[x86: mulpd/addpd 双通道并行, 495-497 unpckhpd 收第二条通道]
```

- 关键设计: **表 + 多项式混合**: 4 项多项式(非 9-13 项 Taylor)就把修正压进 double 末位(ULP 量级)——表 2KB 换掉一半浮点指令。σ 取 2 的幂、S_hi/S_lo 双精度表示、残差显式存储——全部围绕"灾难性消减"防御。

---

### 核心悬念

**"Math.sin(1e100): 三档归约(主路径 Cody-Waite π/32 + 大参数 Payne-Hanek)→Ctable 查表→双通道多项式→double 结果。2443行软件实现→不是 x87 FSIN。** — 下一篇: StubRoutines 生成管道 + JNI wrapper。

> → [02-stubroutine-native.md](02-stubroutine-native.md)
