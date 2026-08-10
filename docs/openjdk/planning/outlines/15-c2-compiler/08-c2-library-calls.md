# 08. library_call.cpp — 6991 行的 intrinsic 世界

> 🔴 Deep | C2 最大源文件——所有 intrinsic (String/Math/Unsafe/Thread/System)

场景: `"hello".indexOf('e')`→C2→`library_call.cpp:inline_string_indexOf()`→inline intrinsic→char[] loop→SSE/AVX—跳过 JNI。

### 1. String + Math Intrinsics

`inline_string_indexOf/equals/compareTo/compress/hasNegatives`: char[]→int[]→SSE/AVX。Math: `inline_math_native(sin/cos/tan/log/exp/pow)`→`MathIntrinsicNode`→x86 MacroAssembler (域2)。

### 2. Unsafe + Thread + System

`inline_unsafe_allocateInstance()`: direct allocate。`inline_unsafe_copyMemory/arraycopy`: memmove。`inline_Thread_currentThread`: one Node。`inline_System_arraycopy`: Macro Expand。

---

### 核心悬念

**"library_call.cpp (6991行)——所有 intrinsic。"** — 连接域2 (MacroAssembler)+域12(ci)。域15结束。

> → domain 16: [Code Cache — nmethod 的生命周期](../16-code-cache/01-nmethod-codecache.md)
