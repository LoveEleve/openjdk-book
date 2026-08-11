# 01. Math.sin 多项式逼近 — Payne-Hanek + fast_sin

> 🔴 Deep | 2443行的软件实现——不是 x87 FSIN
> 读者处境: `Math.sin(1e100)` — JDK 11 不使用 x87 FSIN 指令(不精确, 80-bit→64-bit rounding 误差)——而是 `macroAssembler_x86_sin.cpp:2443行` 的软件实现: Payne-Hanek argument reduction + 多项式逼近→double 精度(53-bit)→C2 intrinsic 调用 StubRoutines::_dsin→~40 cycles。

### 1. "Payne-Hanek argument reduction"

场景: `sin(1e100)` — double 的指数位>~20→`1e100 / (2π)` 有 ~80 位的小数精度需求→无法用 double 直接计算 `x % (π/2)`→Payne-Hanek 用 extended-precision(160-bit) 做 `x * 2/π` → 提取小数部分→精确到 ~1e-16。

**libm_reduce_pi04l** (`macroAssembler_x86_sin.cpp:1225-1670`):
```
MacroAssembler::libm_reduce_pi04l(eax, ecx, edx, ebx, esi, edi, ebp, esp) (line 1225):
  输入: xmm0 = double x (超大角度)
  → 提取 x 的 exponent + mantissa
  → 乘法 x * (2/π) 用 extended precision(160-bit, 5个32-bit word)
  → 小数部分: 最低4 bits 决定象限(quadrant 0-3)
  → 剩余: 约减后的 [-π/2, π/2] 范围的参数 x_reduced
[C++: macroAssembler_x86_sin.cpp:1225-1670——Payne-Hanek 是 1983 年论文——避免 catastrophic cancellation 对于大输入]
[x86: 160-bit 乘法用 32-bit imul 在 5 个 GPR 中——edx:eax=lo, ecx=mid, ebx=mid2, esi=hi, edi=carry]
```
- 源码: `macroAssembler_x86_sin.cpp:1225-1450` (pi04l reduction main) + `macroAssembler_x86_sin.cpp:1450-1670` (fractional part extraction → quadrant)

- 关键设计: **为什么不用 fprem** — x87 的 `fprem`(partial remainder) 指令只能用 64-bit mantissa→对于超大角度(1e100)精度不够→last few bits of quadrant calculation wrong→sin 符号错误。Payne-Hanek 用 software 160-bit→永远正确。

### 2. "fast_sin — 多项式评估"

场景: argument reduction 后→x_reduced 在 [-π/4, π/4] 范围内→用 9-13 项多项式逼近 sin(x_reduced)→`sin(x) = P(x) = c₁x + c₃x³ + c₅x⁵ + ...`(odd powers only for sin)。

**fast_sin** (`macroAssembler_x86_sin.cpp:381-600`):
```
MacroAssembler::fast_sin(xmm0...xmm7, eax, ebx, ecx, edx, tmp1...tmp4) (line 381):
  → quotient = argument_reduction(xmm0) → quadrant(0/1/2/3)
  → x_reduced = xmm0(now [-π/4, π/4])
  → x² = x_reduced * x_reduced
  → 多项式评估(Horner's method):
      P(x) = a1*x + a3*x³ + a5*x⁵ + a7*x⁷ + a9*x⁹
           = x * (a1 + x² * (a3 + x² * (a5 + x² * (a7 + x² * a9))))
  → 根据 quadrant 符号处理:
      Q0: sin(x) = +P(x)
      Q1: sin(x) = +cos(P(x)) → sin(π/2-x)=cos(x)
      Q2: sin(x) = -P(x)
      Q3: sin(x) = -cos(P(x))
[C++: macroAssembler_x86_sin.cpp:381——多项式系数精确到 double(53-bit)——最大误差 < 1 ULP]
[x86: Horner's method 用 vfmadd213sd(FMA) 或 vmovsd+vmulsd——8个 XMM registers in parallel]
```
- 源码: `macroAssembler_x86_sin.cpp:381-500` (fast_sin → quadrant + polynomial) + `macroAssembler_x86_sin.cpp:500-600` (quadrant sign handling)

- 关键设计: **Horner's method** 最小化乘法次数——`x*(a1 + x²*(a3 + ...))`——只需 O(n) 次乘法(非 O(n²))。**多项式系数在 StubRoutines 数据区** — `movdqu(xmm6, ExternalAddress(P_2))` (`macroAssembler_x86_sin.cpp:427`) 从 CodeCache 数据段加载预计算常量(P_1/P_2/P_3/SC_1-4/Ctable 等)——编译期固定、运行时不可变。**象限处理** — sin 在 Q0/Q2→符号从 sin(x) 得到, Q1/Q3→符号从 cos(x) 得到。

---

### 核心悬念

**"Math.sin(1e100): Payne-Hanek argument reduction(160-bit extended precision→[-π/4,π/4])→fast_sin 多项式评估(Horner's method, 9-13 terms, max error <1 ULP)→quadrant sign→double result。2443行软件实现→不是 x87 FSIN(不精确)。"** — 下一篇: StubRoutines 生成管道 + JNI wrapper。

> → [02-stubroutine-native.md](02-stubroutine-native.md)
