# 02. StubRoutines 生成 + JNI wrapper — 从汇编到 Java

> 🟡 Working | stub generation pipeline + StrictMath.c JNI
> 读者处境: JVM 启动时→`StubGenerator_x86::generate_all()`→`generate_math_stubs()`→调用 `MacroAssembler::fast_sin()`→生成 x86 机码到 CodeBuffer→`StubRoutines::_dsin` = stub_entry。`Math.sin(x)`→C2 intrinsic→call `StubRoutines::_dsin`→执行生成的 machine code→return double。

### 1. "StubRoutines 生成管道"

场景: JVM 初始化→`StubGenerator_x86_64::generate_all()`→`StubGenerator::generate_math_stubs()`→每个 math function (sin/cos/tan/log/log10/exp/pow)→`MacroAssembler::fast_sin()`→`CodeBuffer`→`set_entry(stub)`→`StubRoutines::_dsin = stub.entry()`。

**StubGenerator** (`stubRoutines.cpp:200-400 + stubGenerator_x86_64.cpp`):
```
StubGenerator::generate_math_stubs():
  → 分配 CodeBuffer(每个 stub ~500-2000 bytes)
  → stub_sin:   MacroAssembler::fast_sin(...) → CodeBuffer → StubRoutines::_dsin = entry
  → stub_cos:   MacroAssembler::fast_cos(...) → CodeBuffer → StubRoutines::_dcos = entry
  → stub_tan:   MacroAssembler::fast_tan(...) → CodeBuffer → StubRoutines::_dtan = entry
  → stub_log:   MacroAssembler::fast_log(...) → CodeBuffer → StubRoutines::_dlog = entry
  → stub_log10: MacroAssembler::fast_log10(...) → StubRoutines::_dlog10 = entry
  → stub_exp:   MacroAssembler::fast_exp(...) → StubRoutines::_dexp = entry
  → stub_pow:   MacroAssembler::fast_pow(...) → StubRoutines::_dpow = entry
[C++: stubRoutines.cpp:583行——stub generation 在 JVM 启动的 init_globals 阶段(JP 在 safepoint 前)]
[x86: 每个 stub 是独立 CodeBuffer——在 CodeCache 中分配——编译后可被所有 Java 线程调用]
```
- 源码: `stubRoutines.cpp:200-300` (stubRoutines_init1→generate_initial) + `stubGenerator_x86_64.cpp` (generate_all→generate_math_stubs)

- 关键设计: **Stub = 预编译的机器码** — 不是动态 JIT 编译。Stub 在 JVM 启动时生成一次→后续所有 Java 线程直接调用→无 JIT overhead。**StubRoutines 函数指针** — `_dsin`/`_dcos`/`_dtan` 等是全局 `address`(void*) → C2 intrinsic 和 SharedRuntime 通过 `StubRoutines::dsin()` 访问——如果 stub 未生成(NULL)→fallback 到 `SharedRuntime::dsin()`(native JNI call)。

### 2. "StrictMath + Float/Double JNI"

场景: `StrictMath.sin(x)`→native JNI→`jsin(d)`(fdlibm C 数学库)→IEEE 754 bit-exact。`Float.floatToRawIntBits(f)`→C union trick→直接返回 int bits。

**StrictMath JNI** (`StrictMath.c:32-47 + Float.c/Double.c:40-60`):
```
Java_java_lang_StrictMath_sin(env, unused, d) (line 38):
  → return jsin((double)d)  // fdlibm C library →纯 C 实现 → IEEE 754 bit-exact

Float.c — Java_java_lang_Float_floatToRawIntBits:
  → union { jfloat f; jint i; } u; u.f = value; return u.i
  → bitwise reinterpret(不 check NaN/Infinity boxing)
[C++: StrictMath.c:127行——fdlibm = Freely Distributable LIBM——Sun 贡献的 BSD 数学库]
```
- 源码: `StrictMath.c:40-80` (sin/cos/tan→StubRoutines dispatch) + `Float.c:40-60` (floatToRawIntBits) + `Double.c:40-60` (isNaN/isInfinite)

- 关键设计: **StrictMath vs Math 的实现差异** — `Math.sin()` 走 JIT intrinsic→C2 直接 call `StubRoutines::dsin()`(fast_sin polynomial, ~38 cycles)。`StrictMath.sin()` 走 native JNI→`jsin()` from fdlibm(Sun 的 BSD 数学库, `StrictMath.c:38-41`)→纯 C 实现→IEEE 754 bit-exact→~300 cycles(JNI overhead + fdlibm)。**两者结果可能差 ~1 ULP** — Math 多项式逼近 vs StrictMath 的 fdlibm 可能有微小的最后一位差异。

---

### 核心悬念

**"StubRoutines: JVM 启动 generate_math_stubs→MacroAssembler::fast_sin→CodeBuffer→StubRoutines::_dsin=entry。Math.sin→C2 intrinsic→call _dsin→38 cycles。StrictMath.sin→StubRoutines dispatch→IEEE 754 bit-exact。Float.floatToRawIntBits→C union trick→raw int bits。"** — 下一篇: 域46 SA Postmortem。

> → 域46 SA Postmortem
