# 02. StubRoutines 生成 + JNI wrapper — 从汇编到 Java

> 🟡 Working | stub generation pipeline + StrictMath.c JNI
> 读者处境: JVM 启动时→`init_globals` 的 `stubRoutines_init1()`→`StubGenerator_generate(&buffer, false)`→`generate_initial()`(内含数学 stub 生成区)→`generate_libmSin()` 调用 `MacroAssembler::fast_sin()`→生成 x86 机码到 CodeBuffer(BufferBlob)→`StubRoutines::_dsin` = stub 入口地址。`Math.sin(x)`→C2 intrinsic→call `StubRoutines::_dsin`→执行生成的 machine code→return double。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/45-math-library/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **`generate_math_stubs()` 函数不存在**——数学 stub 直接在 `generate_initial`(stubGenerator_x86_64.cpp:5869)内 5928-5968 行生成,且属于 **phase 1**(stubRoutines_init1,universe_init 之前)
> - **StrictMath.c 不 dispatch 到 StubRoutines**——`Java_java_lang_StrictMath_sin`(StrictMath.c:37-41)直接 `jsin()`(fdlibm C);StubRoutines 只被 Math 的 C2/C1 intrinsic 使用
> - "~38 cycles"/"~300 cycles"/"每个 stub ~500-2000 bytes" 无源码依据,已删除
> - Float.c:48-57(floatToRawIntBits union)、Double.c:51-61(doubleToRawLongBits);floatToIntBits 是 Java 代码(Float.java:767-773,canonical NaN 0x7fc00000);floatToRawIntBits 另有 C2 intrinsic(vmSymbols.hpp:816)

### 1. "两阶段生成管道"

场景: JVM 初始化→`init_globals`(init.cpp:100)→`codeCache_init`(106)→`VM_Version_init`(107)→`stubRoutines_init1`(109)→`universe_init`(110,注释 dependent on stubRoutines_init1)→`stubRoutines_init2`(init.cpp:144)。

**两阶段**(`stubRoutines.cpp:182-184` 注释 + `initialize1`/`initialize2`):
```
StubRoutines::initialize1() (stubRoutines.cpp:188-202):
  → _code1 = BufferBlob::create("StubRoutines (1)", code_size1)   // 30000B (x86-64)
  → CodeBuffer buffer(_code1)
  → StubGenerator_generate(&buffer, false)   // → generate_initial(含数学 stub!)
  → assert(buffer.insts_remaining() > 200)   // 空间哨兵
StubRoutines::initialize2() (275-288): 同构, "StubRoutines (2)", code_size2 = 46300B, all=true
  → generate_all() (stubGenerator_x86_64.cpp:5971)
[C++: stubRoutines.cpp:583行——stub generation 在 init_globals 阶段; 数学 stub 在 phase 1(universe 之前), 它们只依赖静态常量]
[x86: code_size1/2 在 stubRoutines_x86.hpp:35-36("simply increase if too small")]
```
- 源码: `stubRoutines.cpp:188-202` (initialize1→generate_initial) + `stubGenerator_x86_64.cpp:5869` (generate_initial→5928-5968 数学 stub)

- 关键设计: **Stub = 预编译的机器码** — 不是动态 JIT 编译。Stub 在 JVM 启动时生成一次→后续所有 Java 线程直接调用→无 JIT overhead。生成器是"运行时汇编器":`__ fast_sin()` 之类的 C++ 调用被解释成机器码写进 CodeBuffer。**StubRoutines 函数指针** — `_dsin` 等是全局 `address`(stubRoutines.hpp:205,初值 NULL,stubRoutines.cpp:161)→ C2/C1 和 SharedRuntime 通过 `StubRoutines::dsin()`(stubRoutines.hpp:382)访问——NULL → fallback 到 `SharedRuntime::dsin()`(sharedRuntimeTrig.cpp:760, fdlibm C++)。

### 2. "StrictMath 与 Math 的分家 + Float/Double JNI"

场景: `Math.sin` 允许快(JIT→stub),`StrictMath.sin` 必须位级一致(JNI→jsin)。Math.java:38-50 的 javadoc 明说 "not defined to return the bit-for-bit same results" 并鼓励平台实现;StrictMath 要求 fdlibm 语义(第一篇 §4.2)。

**StrictMath JNI** (`StrictMath.c:37-41`):
```
Java_java_lang_StrictMath_sin(env, unused, d) (line 37-41):
  → return jsin((double)d)  // fdlibm C library→纯 C 实现→IEEE 754 bit-exact
[JNI: Java_java_lang_StrictMath_sin 命名约定→libjava 链接→域 42 展开]
```
**Float/Double bitwise**:
```
Float.java:767-773  floatToIntBits = Java 代码(isNaN → 0x7fc00000 canonical NaN)
Float.java:810      floatToRawIntBits = native("NOT collapsing NaNs", Float.c:46)
Float.c:48-57       union { int i; float f; } → 位重解释零转换
Double.c:51-61      doubleToRawLongBits 同构(+ jdouble_to_jlong_bits)
vmSymbols.hpp:816/822  _floatToRawIntBits/_doubleToRawLongBits 有 C2 intrinsic
```
- 关键设计: **StrictMath vs Math 的实现差异** — `Math.sin`(JIT)走 intrinsic→stub(Intel libm, 1 ULP 级);`StrictMath.sin` 永远 JNI→jsin(fdlibm)→位级定义;解释器下 Math.sin 走方法体→StrictMath.sin→JNI(无数学 intrinsic)。**规范层区分语义,实现层跟进**——"语义与实现分离"。

---

### 核心悬念

**"StubRoutines: 启动 stubRoutines_init1→generate_initial→generate_libmSin→fast_sin→CodeBuffer→_dsin=entry。Math.sin→C2 intrinsic→call _dsin。StrictMath.sin→JNI jsin(fdlibm)。Float.floatToRawIntBits→JNI union 或 C2 位搬运。"** — 下一篇: 域 48-utilities 的 vmError(hs_err_pid.log 引擎;stub 名字通过 StubCodeDesc 链出现在 crash 栈里)。

> → 48-utilities 域 01-vmerror.md
