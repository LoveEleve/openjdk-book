# 域 45: Math Library — 知识规划

> 源码: hotspot/cpu/x86/macroAssembler_x86_*.cpp + StrictMath.c/Float.c/Double.c + stubRoutines.cpp | ~59文件/~6400行 | 🟡 普通域(2篇)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| macroAssembler_x86_sin.cpp (2443行) | **sin 多项式逼近**: 三档分级归约(主路径 π/32 的 Cody-Waite 三段拆分 P_1/P_2/P_3 + |x|≥90112 时内联 Payne-Hanek 多字乘法)+ Ctable 查表(64 项覆盖 2π)+ SC_1..SC_4 双通道多项式 + 补偿求和, SSE2 优化 ⚠️写作期修正(2026-08-12): 原"9-13项 Taylor"实为 4 项 SC 系数; 原"Payne-Hanek 在 libm_reduce_pi04l"实为 32 位 x87 π/4 归约; 无 Q0-Q3 象限翻转 | High |
| macroAssembler_x86_cos.cpp (884行) | **cos 多项式逼近**: 同 sin 的 Payne-Hanek reduction + cos-specific 多项式 | High |
| macroAssembler_x86_tan.cpp (2139行) | **tan 多项式逼近**: Payne-Hanek reduction + 分离 sin/cos 评估→sin/cos→优化 `tan = sin/cos` | High |
| macroAssembler_x86_log.cpp/log10.cpp/exp.cpp/pow.cpp | **log/log10/exp/pow 多项式**: 类似逼近——自然对数/指数/幂函数 | High |
| stubRoutines.cpp (583行) | **StubRoutines 生成**: JVM 启动时→generate_initial→StubGenerator_x86→generate_math_stubs→macroAssembler sin/cos/tan→stub_entry point→StubRoutines::_dsin 等函数指针 | High |
| StrictMath.c (127行) | **StrictMath JNI**: sin/cos/tan→call StubRoutines::dsin() via SharedRuntime::dsin→return double, IEEE 754 bit-exact | High |
| Float.c/Double.c (57+61行) | **Float/Double JNI**: floatToRawIntBits→union {float f; int bits;}, isNaN/isInfinite→bitwise check | Low |

*7 知识点*

## 02 聚合

### P1 (≥5文件)
| KP | 出现文件 |
|----|---------|
| 无 — 域内文件分散于不同功能区域 |

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| sin/cos/tan 多项式逼近 | macroAssembler_x86_sin/cos/tan.cpp(3文件) || log/exp 多项式逼近 | macroAssembler_x86_log/log10/exp/pow.cpp(4文件) |
| StubRoutines 生成 + JNI wrapper | stubRoutines.cpp, StrictMath.c |

### P3 (=1文件)
| KP | 出现文件 |
|----|---------|
| Float/Double bitwise ops | Float.c, Double.c |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| sin/cos 多项式逼近(Payne-Hanek) | macroAssembler_x86_sin.cpp:2443行——JDK 11 不使用 x87 FSIN 指令(不精确)→而是软件实现 Payne-Hanek argument reduction + 多项式逼近→精度达到 double(53-bit)。这是 JIT intrinsic `Math.sin()` 的底层实现——通过 StubRoutines::_dsin 函数指针调用 |

### 🟡 Working (2 KP)
| KP | 为什么 🟡 |
|----|---------|
| log/exp/tan/pow 多项式 | 类似的逼近方法——tan 比 sin 复杂(tan=sin/cos+特殊处理) |
| StubRoutines 生成管道 | JVM 启动时 generate_initial→generate_math_stubs→生成 sin/cos/tan/log/exp/pow stubs→StubRoutines::_dsin 等 |

### 🟢 Surface (2 KP)
| KP | 为什么 🟢 |
|----|---------|
| StrictMath.c JNI wrapper | 简单的 JNI→StubRoutines 转发 |
| Float/Double IEEE 754 bitwise | isNaN/isInfinite/floatToRawIntBits→bitwise union trick |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | Math intrinsic 多项式逼近 | "Math.sin(x) 为什么不是 x87 FSIN 而是 2443 行的 Payne-Hanek+多项式？精度和速度的 trade-off 是什么？" |
| 2 | StubRoutines 管道 + JNI wrapper | "StubRoutines::_dsin 怎么在 JVM 启动时生成？StrictMath.c 怎么调用它？" |
