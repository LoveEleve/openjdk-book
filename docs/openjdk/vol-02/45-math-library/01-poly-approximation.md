# 01. Math.sin 的 2443 行 — 为什么不用一条 FSIN 指令？

> **前置依赖**:[05-cpu-primitives/01 — 原子操作与内存序](openjdk/vol-02/05-cpu-primitives/01-atomic-and-memory-order.md):能读 x86 汇编、知道 SSE2 指令长什么样
> → **后续**:[02 — StubRoutines 生成管道与 JNI wrapper](02-stubroutine-native.md)
> 关联域: 16-codecache(生成的 stub 代码放在哪)、23-stub(StubRoutines 机制)、13-jit(C2 intrinsic 的选择)、42-core-native(JNI 与 native 方法)

## 一个 1e100 的角度,难住了 double

`Math.sin(1e100)` 怎么算?1e100 有 101 位十进制数,而 double 只有 53 位尾数(约 16 位十进制)。要求 sin,就得先知道 1e100 除以 2π 余多少。直接算 1e100/(2π) ≈ 1.6×10⁹⁹——100 位的数;直接乘 2/π 再取小数部分,小数点前 100 位就把尾数占满了,**小数部分一个 bit 都不剩**。x86 的 `FSIN` 指令一条就能算正弦——但 JDK 11 在 x86-64 上**根本不用它**。`macroAssembler_x86_sin.cpp` 用 2443 行 C++ 生成的汇编实现了一个完整的软件 sin:参数归约 + 查表 + 多项式逼近。这篇拆开看它到底干了什么。

先记住三条路(同一族算法,三个载体):

- `Math.sin`(Math.java:153)被 C2/C1 内联成对**生成的汇编 stub** 的直接调用(library_call.cpp:1878);
- `StrictMath.sin`(StrictMath.java:125,native)走 JNI → `StrictMath.c:37` 的 `jsin()`(C 版 fdlibm);
- 如果 intrinsic 被关掉,`Math.sin` 退化为对 `SharedRuntime::dsin`(sharedRuntimeTrig.cpp:760)的调用——fdlibm 的 C++ 移植。

三条路里,64 位 JVM 上最快、最常用的是第一条:stub 是**纯 SSE2 软件实现**,不用 x87,不用 FSIN。

## 1. 主路径:参数归约 + 查表 + 多项式

### 1.1 场景:绝大多数输入走的路径

文件头注释(第 39-50 行)把算法写得非常完整:

```cpp
// macroAssembler_x86_sin.cpp:39-50(注释逐字摘录)
//     1. RANGE REDUCTION
//
//          X =~= N * pi/32 + r
//
//     so that |r| <= pi/64 + epsilon. We restrict inputs to those
//     where |N| <= 932560. Beyond this, the range reduction is
//     insufficiently accurate. For extremely small inputs,
//     denormalization can occur internally, impacting performance.
//     This means that the main path is actually only taken for
//     2^-252 <= |X| < 90112.
```

思路一句话:**把 x 写成 "整数 × π/32 + 小余数 r"**,整数 N 决定查哪张表,r 交给多项式。|x| < 90112 时 |N| ≤ 932560,归约在 double 里还能做精确;超出就换 Payne-Hanek(第 2 节)。

### 1.2 归约:N = round(32/π·x),r = x − N·(P₁ + P₂ + P₃)

函数入口是 `MacroAssembler::fast_sin`(macroAssembler_x86_sin.cpp:381)。输入 xmm0 先存栈,取高 32 位做指数分级:

```cpp
// macroAssembler_x86_sin.cpp:409-425(截取核心,逐字)
  push(rbx);
  subq(rsp, 16);
  movsd(Address(rsp, 8), xmm0);
  movl(eax, Address(rsp, 12));
  movq(xmm1, ExternalAddress(PI32INV));    //0x6dc9c883UL, 0x40245f30UL
  movq(xmm2, ExternalAddress(SHIFTER));    //0x00000000UL, 0x43380000UL
  andl(eax, 2147418112);
  subl(eax, 808452096);
  cmpl(eax, 281346048);
  jcc(Assembler::above, L_2TAG_PACKET_0_0_1);
  mulsd(xmm1, xmm0);
  movdqu(xmm5, ExternalAddress(ONEHALF));    //0x00000000UL, 0x3fe00000UL, 0x00000000UL, 0x3fe00000UL
  movq(xmm4, ExternalAddress(SIGN_MASK));    //0x00000000UL, 0x80000000UL
  pand(xmm4, xmm0);
  por(xmm5, xmm4);
  addpd(xmm1, xmm5);
  cvttsd2sil(edx, xmm1);
```

前三行是魔术数分级:掩掉符号后的指数位,减去 0x30300000,再与 0x10C20000 比较——一次无符号比较把指数分成三档,落在 [771, 1039] 的走主路径,低于(极小)或高于(巨大)分别跳去第 3 节和第 2 节的分支。`PI32INV` 是 32/π(常量在 336-339 行),`ONEHALF` 是 0.5。接下来:y = x·32/π,`por` 把 x 的符号并进 0.5,加完再 `cvttsd2sil`(截断转 int)——**加 ±0.5 再截断 = 四舍五入**,这就是 N = round(32/π·x)。注意这里的 64 位常量 `_PI32INV = 0x40245F306DC9C883`,指数 0x402 = 2³,数值正好是 32/π ≈ 10.186。

拿到 N 后,核心是**把 π/32 拆成三段**再减——这是整个归约的精度所在:

```cpp
// macroAssembler_x86_sin.cpp:428-447(截取核心,逐字)
  mov64(r8, 0x3fb921fb54400000);
  movdq(xmm3, r8);
  movdqu(xmm5, ExternalAddress(SC_4));    //0xa556c734UL, 0x3ec71de3UL, 0x1a01a01aUL, 0x3efa01a0UL
  pshufd(xmm4, xmm0, 68);
  mulsd(xmm3, xmm1);
  ...
  mulsd(xmm1, ExternalAddress(P_3));    //0x2e037073UL, 0x3b63198aUL
  subsd(xmm4, xmm3);
  movq(xmm7, Address(rax, 8));
  subsd(xmm0, xmm3);
  ...
  subsd(xmm4, xmm6);
```

`mov64` 塞进 r8 的 `0x3FB921FB54400000` 就是 P₁(π/32,尾数只留 32 位)。常量区里三段 π/32(371-374、186-189、351-354 行):

| 常量 | 值 | 作用 |
|---|---|---|
| `_P_1` | `0x3FB921FB54400000` | π/32 前 32 位尾数 → 与 N 相乘**无舍入** |
| `_P_2` | `0x3D90B4611A600000` | 下一段 32 位 → 与 N 相乘**无舍入** |
| `_P_3` | `0x3B63198A2E037073` | 兜底的 53 位残差 |

**关键设计 (斜体)**: *为什么把 π/32 拆三段?double 乘法的舍入误差来自尾数——直接用 53 位的 π/32 乘 N,乘积低位的舍入会污染余数 r,而 r 的精度直接决定最终结果。P₁、P₂ 的尾数各只有 32 位,double 乘完恰好无舍入;P₃ 补上剩下的精度。头注释(55-60 行)明说了动机:"P_1 and P_2 are 32-bit numbers (so multiplication by N is exact)"。这就是数值库的 Cody-Waite 拆值技巧,中文叫"双倍双精度"。*

### 1.3 查表:M = N mod 64 → Ctable

余数 r 算好了,但 N 可能很大——正弦的周期性决定真正有用的是 N 的低位:

```cpp
// macroAssembler_x86_sin.cpp:439-442(逐字)
  andl(edx, 63);
  shll(edx, 5);
  lea(rax, ExternalAddress(Ctable));
  addq(rax, rdx);
```

`Ctable`(196-301 行)有 64 项 × 4 个 double = 2 KB。64 项 × π/32 = 2π——**一整张周期表**,每项存 B = M·π/32 处的 sin/cos 的加倍精度表示(头注释 81-86 行):

```cpp
// macroAssembler_x86_sin.cpp:81-86(注释逐字摘录)
//     The algorithm uses a table lookup based on B = M * pi / 32
//     where M = N mod 64. The stored values are:
//       sigma             closest power of 2 to cos(B)
//       C_hl              53-bit cos(B) - sigma
//       S_hi + S_lo       2 * 53-bit sin(B)
```

sin(B) 用一个 double-double(S_hi + S_lo 两个 53 位)表示,cos(B) 拆成"2 的幂 σ + 残差 C_hl"。σ 是 2 的幂,σ·r 的乘法只是指数加减,**零舍入**。

- [x86: 表是 `ATTRIBUTE_ALIGNED(16) juint[]`,编译期写死在二进制里,运行时通过 `ExternalAddress` 直接引用——没有加载过程,代码即数据]

**关键设计 (斜体)**: *为什么表步长选 π/32 而不是 π/4?步长减半,表体积翻倍、多项式需要的项数减半。π/32 让 |r| ≤ π/64 ≈ 0.049,4 项多项式(下一小节)就够把修正压进 double 末位(ULP 量级);表只要 2 KB,查表是一次 32 字节读取。对比纯多项式方案(fdlibm 的 `__kernel_sin` 要 6 项 13 次多项式),"查一次表 + 4 项多项式"在 x86 上更快——用 2 KB 数据换掉一半的浮点指令。*

### 1.4 多项式:SSE2 双通道,同时算 sin 和 cos 的修正

r ∈ [−π/64, π/64],sin(B + r) 用和角公式展开——sin(B)、cos(B) 从表里来,r 的部分用多项式。头注释(113-129 行)给出结构,关键设计是:**两个多项式塞在同一个 XMM 寄存器的两条 64 位通道里并行**:

```cpp
// macroAssembler_x86_sin.cpp:458-478(截取核心,逐字)
  mulpd(xmm5, xmm0);
  subpd(xmm0, xmm6);
  mulsd(xmm7, xmm4);
  subsd(xmm3, xmm4);
  mulpd(xmm5, xmm0);
  mulpd(xmm0, xmm0);
  ...
  movdqu(xmm6, ExternalAddress(SC_2));    //0x11111111UL, 0x3f811111UL, 0x55555555UL, 0x3fa55555UL
  ...
  addpd(xmm5, ExternalAddress(SC_3));    //0x1a01a01aUL, 0xbf2a01a0UL, 0x16c16c17UL, 0xbf56c16cUL
  mulsd(xmm4, Address(rax, 0));
  addpd(xmm6, ExternalAddress(SC_1));    //0x55555555UL, 0xbfc55555UL, 0x00000000UL, 0xbfe00000UL
  mulpd(xmm5, xmm0);
  ...
  addpd(xmm6, xmm5);
```

`SC_1`(313-316 行)是打包的两个 double:第一通道 `0xBFC5555555555555` = −1/6(正弦 x³ 项系数),第二通道 `0xBFE0000000000000` = −0.5(余弦 x² 项系数)。`mulpd`/`addpd` 一次算两条通道——sin 的修正和 cos 的修正**同时算好**,最后(495-497 行)用 `unpckhpd` 把第二条通道也收进结果。

- [C++: 这是 SIMD 数据并行在数值代码里的典型用法:不是并行算多个 x,而是把同一个 x 的两条独立计算链放进两条 64 位通道——指令数减半,延迟不变]

证据链:fdlibm 的 `k_sin.c:62` 里 `S1 = -1.66666666666666324348e-01, /* 0xBFC55555, 0x55555549 */`——**高 32 位正是 SC_1 第一通道的 `0xBFC55555`**。stub 和 fdlibm 是同一族算法,只是换了实现载体。

### 1.5 补偿求和:double 里装 106 位

头注释(131-164 行)的最后一段是 compensated summations:把表值(S_hi/S_lo)、σ·r、多项式、修正项 c 逐层相加时,每一步都记录**这次加法丢掉的残差**(k₀、k₁、k₂、k₃、corr),最后一起加回去。53 位不够,就把"舍掉的残差"也存成普通 double,等效精度到 ~106 位。

**关键设计 (斜体)**: *查表 + 多项式逼近最怕"灾难性消减"——两个接近的量相减,有效位全丢。σ 取 2 的幂、C_hl 存残差、S_hi/S_lo 分高低两半,全部围绕一件事:让每个中间量都是"主值 + 显式残差",消减发生时残差已经单独存下来了。主路径零分支,精度靠结构保证。*

## 2. 大参数 |x| ≥ 90112:Payne-Hanek 归约

### 2.1 场景:1e100 终于来了

|x| ≥ 90112 时,N = round(32/π·x) 已达 9.2×10⁵ 量级(2¹⁹ 以上)。double 的 53 位尾数里整数部分占掉约 20 位,留给余数的只有 30 多位——决定象限的那几位变得不可靠。头注释(46-47 行)说得很直白:"Beyond this, the range reduction is insufficiently accurate"。这时候要的是**高精度的 x·2/π 的小数部分**。

### 2.2 多字乘法:把 2/π 的二进制位搬出来乘

`PI_INV_TABLE`(318-329 行)是 2/π 的 **41 个 32 位字**(164 字节)。它和 fdlibm 同源——对比 fdlibm `e_rem_pio2.c:38` 的 `two_over_pi[]`(24 位一组):

```
fdlibm  two_over_pi[]: 0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, ...
stub    PI_INV_TABLE:   0xA2F9836E, 0x4E441529, 0xFC2757D1, ...
```

stub 表就是把 fdlibm 的 24 位字**重打包成 32 位**——`0xA2F9836E` = `0xA2F983` 后面拼上 `0x6E`。同一个 2/π 数字表,一个给 C 用,一个给汇编用。代码按指数选好表的偏移,然后做多字整数乘法:

```cpp
// macroAssembler_x86_sin.cpp:526-547(截取核心,逐字)
  lea(r11, ExternalAddress(PI_INV_TABLE));
  addq(rcx, r11);
  movdq(rax, xmm0);
  movl(r10, Address(rcx, 20));
  movl(r8, Address(rcx, 24));
  movl(edx, eax);
  shrq(rax, 21);
  orl(eax, INT_MIN);
  shrl(eax, 11);
  movl(r9, r10);
  imulq(r10, rdx);
  imulq(r9, rax);
  imulq(r8, rax);
  movl(rsi, Address(rcx, 16));
  movl(rdi, Address(rcx, 12));
```

连续 7 个表字(224 位)× 尾数,`imulq` 链带进位累加:乘积的高位是"x·2/π 的整数部分",低位决定小数和象限。余数再换算回以 π/2 为单位。这就是 Payne-Hanek(1983 年论文)的核心:**先用 2/π 的扩展精度数字做整数乘法,只关心小数部分,再反乘 π/2**——精度只受乘法链长度限制,1e100 也不怕。

```cpp
// macroAssembler_x86_sin.cpp:649-686(截取核心,逐字)
  bind(L_2TAG_PACKET_11_0_1);
  cvtsi2sdq(xmm0, r9);
  shrq(r10, 1);
  cvtsi2sdq(xmm3, r10);
  ...
  mulsd(xmm0, xmm4);
  ...
  mulsd(xmm0, xmm2);
  ...
  addsd(xmm0, xmm6);
  ...
  movq(xmm1, ExternalAddress(PI32INV));    //0x6dc9c883UL, 0x40245f30UL
  mulsd(xmm1, xmm0);
```

归约完的余数重新进入与主路径**完全相同**的 Ctable + 多项式尾部(684-706 行)——查表、多项式、补偿求和全部复用。所以 fast_sin 的结构是:一个分档的归约入口 + 一个共用的求值核心。

**关键设计 (斜体)**: *为什么不能用 x87 的 `fprem`(部分余数指令)?x87 内部是 80 位扩展精度,尾数只有 64 位——fprem 对 π 的表示精度被锁死在这 64 位里,超大角度下余数的低位位元(正是决定 sin 符号的象限位)是错的。Payne-Hanek 用软件把精度扩到 224 位,代价是几十条整数乘法,但结果对任意 double 输入都有受控误差。这是"数值正确性不能交给硬件微码"的典型例子:微码的归约精度是硬件的实现细节,不受软件控制。*

## 3. 小参数与特殊值:两条捷径

### 3.1 场景:次正规数和 ±0、Inf、NaN

sin 的规范特殊值(StrictMath.java:116-124):NaN/Inf → NaN,±0 → ±0。在汇编里,这些是免费的分支落点:

```cpp
// macroAssembler_x86_sin.cpp:506-514(截取核心,逐字)
  mulsd(xmm0, ExternalAddress(ALL_ONES));    //0xffffffffUL, 0x3fefffffUL
  jmp(B1_4);

  bind(L_2TAG_PACKET_2_0_1);
  movq(xmm3, ExternalAddress(TWO_POW_55));    //0x00000000UL, 0x43600000UL
  mulsd(xmm3, xmm0);
  subsd(xmm3, xmm0);
  mulsd(xmm3, ExternalAddress(TWO_POW_M55));    //0x00000000UL, 0x3c800000UL
  jmp(B1_4);
```

`ALL_ONES = 0x3FEFFFFFFFFFFFFF` = 1−2⁻⁵³;`2⁵⁵·x − x` 再乘 2⁻⁵⁵ = x·(1−2⁻⁵⁵)。头注释(166-171 行)解释了这两条捷径:|x| 小于最小正规数(次正规)返回 x·(1−2⁻⁵³),其余极小正规数返回 x·(1−2⁻⁵⁵)。数学上 sin(x) ≈ x,这两个乘法只是把"sin(x) 严格小于 x"这件事做进最低位。

```cpp
// macroAssembler_x86_sin.cpp:838-840(逐字)
  bind(L_2TAG_PACKET_3_0_1);
  movq(xmm0, Address(rsp, 8));
  mulsd(xmm0, ExternalAddress(NEG_ZERO));    //0x00000000UL, 0x80000000UL
```

Inf × −0 = NaN,NaN × −0 = NaN——**一次乘法同时处理两个特殊值**。±0 走 ALL_ONES 那条(指数为 0 的分支),−0 × 0.999… = −0,符号保留。全部符合 javadoc 的特殊值规范。

**关键设计 (斜体)**: *为什么要两条"小参数捷径"?头注释(47-49 行)说得很实在:极小的 x 走完整归约,内部会产生次正规数中间值,流水线惩罚严重("denormalization can occur internally, impacting performance")。代价是误差在一个 ULP 内的近似——用可证明的微小误差换掉最坏情况下的几十个周期停顿。*

## 4. 为什么不用 x87 FSIN?三个理由

### 4.1 设计决定:64 位代码刻意 SSE2-only

文件头第 179-180 行:

```cpp
// macroAssembler_x86_sin.cpp:179-180(注释逐字)
#ifdef _LP64
// The 64 bit code is at most SSE2 compliant
```

不是"碰巧没用 x87",是**故意的**。x87 有 80 位内部精度和独立的控制状态(fldcw 管舍入模式),在 64 位 ABI 里用起来要频繁切换状态、序列化流水线。SSE2 是 x86-64 指令集强制包含的部分,纯 SSE2 意味着在**任何** x86-64 机器上都是同一段代码、同一种行为。

- [x86: FSIN 是微码指令(几十到上百周期),且对 |x| ≥ 2⁶³ 的参数,Intel 手册明确不保证结果精度。软件实现没有这个上限——Payne-Hanek 对任意 double 输入都给出受控误差]

### 4.2 确定性:StrictMath 要的是位级一致,不是"差不多"

StrictMath.java 的类注释(39-46 行)写得非常硬:

```java
// StrictMath.java:39-46(注释逐字摘录)
 * To help ensure portability of Java programs, the definitions of
 * some of the numeric functions in this package require that they
 * produce the same results as certain published algorithms. These
 * algorithms are available from the well-known network library
 * {@code netlib} as the package "Freely Distributable Math
 * Library," <a
 * href="ftp://ftp.netlib.org/fdlibm.tar">{@code fdlibm}</a>. These
 * algorithms, which are written in the C programming language, are
 * then to be understood as executed with all floating-point
 * operations following the rules of Java floating-point arithmetic.
```

sin 属于"必须与 fdlibm 算法一致"的函数(注释 54-56 行列在名单里)。x87 FSIN 的结果取决于 CPU 微码——Intel 和 AMD 的低位可能不同、不同代也可能不同——**位级可移植性只能靠软件实现**。证据:兜底路径 `SharedRuntime::dsin`(sharedRuntimeTrig.cpp:760)就是 fdlibm 的 C++ 移植,连注释都标着"TRIG(x) returns trig(x) nearly rounded"(756-757 行),内部是 `__ieee754_rem_pio2` + `__kernel_sin` + `n & 3` 的象限 switch——与 e_rem_pio2.c 的 C 版同构。JNI 版 `jsin`(StrictMath.c:37-41)则是同一算法的 C 实现。**同一个算法,三个载体:汇编 stub(快)、C++ 移植(兜底)、C 原版(JNI)**。

- [C++: `SharedRuntime::dsin` 是 JRT_LEAF(sharedRuntimeTrig.cpp:760)——leaf 过程,可被 JIT 直接调用;而 JNI 的 jsin 走完整 native 调用边界。这也是为什么 intrinsic 路径能快一个数量级:省掉的不只是 JNI 的进出,还有参数校验与异常检查]

### 4.3 32 位残留的 x87,恰好证明"不用 FSIN"不是不能

文件的后半段(`#else`,849 行起)是 32 位实现,那里**确实用了 x87 指令**:`fld_x`(1259 行,加载 80 位扩展精度)、`fldcw`(1731 行)——32 位代码用 x87 寄存器做 80 位中间精度,配合 96 位拆分的 π/4 常量(`pi04_3d`,866-869 行)做归约。注意:即便如此,**也没有用 FSIN 指令**——是软件多项式 + x87 算术,不是一条 FSIN 了事。32 位路径的巨型参数归约 `libm_reduce_pi04l`(1225 行)和 `libm_sincos_huge`(1672 行)分别作为 `StubRoutines::dlibm_reduce_pi04l` / `dlibm_sin_cos_huge` 注册(stubGenerator_x86_32.cpp:3483、3499;stubRoutines.hpp:207-208),前者被 32 位 tan 调用(tan.cpp:1244),后者被 32 位 sin/cos 的巨大参数分支调用。

**关键设计 (斜体)**: *"不用 FSIN"的完整理由是三层:① 精度——微码归约只有 ~64 位 π,大参数不可靠;② 确定性——StrictMath 要求 fdlibm 位级语义,硬件实现逐代漂移;③ 性能——SSE2 纯软件版对常规参数只要几十个周期,无状态切换、无微码。x87 在 32 位路径里退化为"高精度中间寄存器"使用,而不是"一条指令解决问题"。*

## 5. 调用链速览:这段汇编从哪来、被谁调用

stub 由 JVM 启动时生成(stubGenerator_x86_64.cpp:5928-5968,条件 `VM_Version::supports_sse2() && UseLibmIntrinsic && InlineIntrinsics`;`UseLibmIntrinsic` 默认 true,globals_x86.hpp:217)。`generate_libmSin`(5644 行)在中间调用 `__ fast_sin(...)` 生成机器码,返回的地址存入 `StubRoutines::_dsin`(stubRoutines.cpp:161 初始为 NULL;stubRoutines.hpp:382 提供 `dsin()` 访问器)。同时 Ctable 等常量区地址被注册成 stub 内部的 `ExternalAddress` 引用(5932-5945 行)。

C2 侧(library_call.cpp:1877-1880)的选择逻辑:

```cpp
// library_call.cpp:1877-1880(逐字)
  case vmIntrinsics::_dsin:
    return StubRoutines::dsin() != NULL ?
      runtime_math(OptoRuntime::Math_D_D_Type(), StubRoutines::dsin(), "dsin") :
      runtime_math(OptoRuntime::Math_D_D_Type(), FN_PTR(SharedRuntime::dsin),   "SIN");
```

注意 `runtime_math`(1849-1870 行)用 `RC_LEAF` 生成调用——**leaf call,无 GC 点、无 safepoint 检查**,纯计算。C1 的 LIR 同样直接 `call_runtime_leaf(StubRoutines::dsin(), ...)`(c1_LIRGenerator_x86.cpp:881-887)。intrinsic 本身注册在 **java.lang.Math.sin** 上(vmSymbols.hpp:778),而 Math.sin(Math.java:152-155)标着 `@HotSpotIntrinsicCandidate` 并委托给 StrictMath.sin——所以 `Math.sin(1e100)` 的热路径是:C2 内联 intrinsic → 直接 call 生成的汇编 stub → 一段无分支的 SSE2 序列 → xmm0 返回。这就是"2443 行 vs 一条 FSIN"的完整故事。

## 核心悬念

"2443 行汇编,不是编译出来的,是 JVM 启动时用 C++ 的 MacroAssembler 代码**逐条生成**的——stub 生成的管道本身(StubRoutines 条目、generate_initial 的执行时机、代码生成器怎么把 `__ fast_sin()` 变成一段可执行代码放进 CodeCache)才是这个域的下一个主题。而 StrictMath 那条 JNI 路,还要解释清楚:JNI 的 native 方法到底是怎么被找到和调用的。"

> → [02-stubroutine-native.md](02-stubroutine-native.md):StubRoutines 生成管道、_dsin 函数指针的运行时使用、JNI wrapper
