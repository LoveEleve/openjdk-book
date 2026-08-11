# 08. library_call.cpp — 6991 行的 intrinsic 世界

> 🔴 Deep | C2 最大源文件——所有 intrinsic inline (String/Math/Unsafe/System/Thread)
> 读者处境: `"hello".indexOf('e')`→C2→`LibraryCallKit::inline_string_indexOf()`→inline intrinsic(vmIntrinsics)→char[] scan with SSE 4.2 PCMPESTRI→完全跳过 JNI(Java→C→Java 来回 300ns→**5ns** inlined)。`Math.sin(x)`→`inline_math_native()`→x86 FSIN 指令。`Unsafe.allocateInstance()`→`inline_unsafe_allocate()`→直接分配对象(不调构造函数)。这是 C2 性能优势的核心——**Intrinsic = JIT 理解语义→发射专用机码**。

### 1. "String Intrinsics — indexOf/equals/compress/hashCode"

场景: `str.indexOf('e')` — JVM 调 `String.indexOf`→Java bytecode loop 逐 char 比较→慢(500 cycles)。C2 识别为 `vmIntrinsics::_indexOf`→inline→SSE 4.2 `pcmpestri` 指令(16 chars 并行比较)→5 cycles。

**inline_string_indexOf** (`library_call.cpp:1000-1300`):
```
LibraryCallKit::inline_string_indexOf():
  → 检查 intrinsic flag: UseSSE42Intrinsics
  → 生成 Node: StrIndexOfNode(char[] base, int offset, char[] target)
  → Matcher 匹配 StrIndexOfNode→x86 MachNode: movdqu + pcmpestri + jcc
  → SSE 4.2 pcmpestri: 一次指令比较 16 字节(char[])→返回首个匹配位置
[C++: library_call.cpp:6991行——50+ intrinsic methods, 每个 vmIntrinsics::ID→inline hook]
[x86: pcmpestri(packed compare explicit length strings return index)——xmm0=needle, xmm1=haystack]
```
- 源码: `library_call.cpp:1000-1300` (indexOf) + `library_call.cpp:800-1000` (equals/compareTo/compress/hasNegatives)

- 关键设计: **String intrinsic 的触发条件**——C2 必须在 IGVN 阶段检测到 `String.indexOf()` 的 call node→换为 `LibraryCallKit`→inline the intrinsic graph。如果 IGVN 优化后 call 被移除了→intrinsic 不会触发。`UseSSE42Intrinsics`(默认 true)—如果 CPU 无 SSE 4.2→退化为 scalar loop(慢 30x)。**StringLatin1** 和 **StringUTF16** 两套 compact string→每个 intrinsic 有两条路径(byte[] vs char[])。

### 2. "Math Intrinsics — sin/cos/tan/log/exp 直接机码"

场景: `Math.sin(angle)` — JVM 调 `StrictMath.sin`→native method→JNI→C runtime→FSIN x87→return→700 cycles。C2 intrinsic→`MathIntrinsicNode`→直接 FSIN 指令→40 cycles。

**inline_math_native** (`library_call.cpp:2000-2200`):
```
LibraryCallKit::inline_math_native(vmIntrinsics::ID id):
  → 匹配 ID: _dsin/_dcos/_dtan/_dlog/_dexp/_dpow
  → 生成 MathIntrinsicNode(type=Sin, input=arg_node)
  → Matcher 匹配→x86 MachNode:
      sin/cos/tan: call StubRoutines::dsin()/dcos()/dtan()
        (JDK 11: macroAssembler_x86_sin.cpp/cos.cpp/tan.cpp — 
         Payne-Hanek argument reduction + polynomial approximation, SIMD 优化)
      log/exp: fyl2x/f2xm1 (x87 FP stack)
  → 没有 JNI 开销——直接 call inline stub
[C++: library_call.cpp:2000-2300——Math intrinsic stub 内嵌在 CodeCache 中——快于 native call 但非完全 inlined]
[x86: StubRoutines 生成到 CodeBuffer→独立 stub——call 10-20 cycles vs JNI 300 cycles]
```
- 源码: `library_call.cpp:2000-2200` (inline_math_native) + `library_call.cpp:1800-2000` (Math.min/max/abs——简单的 cmov/and)

- 关键设计: **Math 精度折衷**——`Math.sin()`(默认)使用 `StubRoutines::dsin()`(Payne-Hanek 多项式逼近, ~40 cycles)→不严格符合 `StrictMath` 的 bit-exact 要求(后者调 C runtime `sin()` via JNI 300 cycles)。如果 `-XX:+StrictMath` → C2 跳过 intrinsic→走 native JNI。**StubRoutines 是一次性生成的**——JVM 启动时测量 CPU features→生成最优 SIMD/SSE 版本→后续所有编译共用同一个 stub。

### 3. "Unsafe + System + Thread Intrinsics"

场景: `Unsafe.allocateInstance(MyClass.class)`→C2→`inline_unsafe_allocate()`→直接分配对象**不调构造函数**(跳过 `<init>`→final 字段未初始化→不安全但快)。`System.arraycopy`→`inline_arraycopy()`→Internal ArrayCopyNode→MacroExpand(域 07)。

**Unsafe + Thread + System** (`library_call.cpp:2600-3200`):
```
inline_unsafe_allocateInstance(): → AllocateNode(type=klass, init=SKIP_INIT)
inline_unsafe_copyMemory(): → LoadNode+StoreNode pair→或 rep movsq memcpy
inline_unsafe_compareAndSwap(): → CompareAndSwapNode→x86 lock cmpxchg
inline_Thread_currentThread(): → ThreadLocalNode→thread register(r15 on Linux)
inline_System_arraycopy(): → ArrayCopyNode→域 07 MacroExpand
inline_System_nanoTime(): → RDTSC/rdtscp→counter node
[C++: library_call.cpp:2600-3500——Unsafe intrinsics = JIT 层绕过 Java 安全模型]
[x86: CAS→lock cmpxchg(原子比较交换)——r15=thread_register(ThreadLocalNode 直接读)]
```
- 源码: `library_call.cpp:254-260` (inline_unsafe_allocate 声明) + `library_call.cpp:773` (_allocateInstance dispatch) + `library_call.cpp:2600-2800` (CAS/arraycopy)

- 关键设计: **Unsafe intrinsics 的作用**——绕过 Java 安全检查(类型检查/null 检查/边界检查)→直接机码。`CompareAndSwapNode`→`lock cmpxchg`(x86 LOCK prefix 保证多核原子性)。**ThreadLocalNode**——`Thread.currentThread()`→直接读 r15 寄存器(Linux x64 calling convention, r15=JavaThread*→no memory access→1 cycle)。**RDTSC** for `System.nanoTime()`→CPU cycle counter→极快但可能跨核漂移。

---

### 核心悬念

**"library_call.cpp (6991行): 50+ intrinsic——String(SSE pcmpestri 16 chars/cycle)→Math(FSIN/FCOS/FLN x87, 700→40 cycles)→Unsafe(lock cmpxchg CAS+allocateInstance skip init)→Thread(r15 read 1 cycle)→System(RDTSC/arraycopy)。这是 C2 性能优势的核心——JIT 理解语义→发射专用机码绕过 Java→JNI 来回。域15 C2 结束。"** — 下一篇: 域16 Code Cache——nmethod 的生命周期。

> → [../16-code-cache/01-nmethod-codecache.md](../16-code-cache/01-nmethod-codecache.md)
